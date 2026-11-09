// センサーモデル（純粋関数のみ。描画側はここで計算した値をシェーダーへ渡す）
//
// 単位系:
//   シーン輝度 L [cd/m²] → 撮像面露光量 H [lx·s] → 光電子数 e⁻ → 正規化 RAW (1.0 = 白)
//
// ISO は飽和基準 (ISO 12232 saturation-based) で定義する:
//   ISO S のとき、RAW が 1.0 になる露光量は H_sat = 78 / S [lx·s]
// そのため「RAW 期待値」はセンサー非依存に決まり、センサー差はノイズと飽和にだけ現れる。

export type SensorFormat = 'FF' | 'APS-C' | 'MFT' | '1inch';
export type SensorTech = 'legacy' | 'bsi' | 'stacked';

export const SENSOR_FORMATS: Record<SensorFormat, { label: string; width: number; height: number }> = {
  FF: { label: 'フルサイズ (36×24mm)', width: 36, height: 24 },
  'APS-C': { label: 'APS-C (23.5×15.6mm)', width: 23.5, height: 15.6 },
  MFT: { label: 'マイクロフォーサーズ (17.3×13mm)', width: 17.3, height: 13 },
  '1inch': { label: '1インチ (13.2×8.8mm)', width: 13.2, height: 8.8 },
};

export interface TechSpec {
  label: string;
  /** フルウェル容量の面積密度 [e⁻/µm²] */
  fullWellDensity: number;
  /** ゲイン前の読み出しノイズ [e⁻] (ISO に依らない) */
  readNoisePre: number;
  /** ゲイン後の読み出しノイズ [e⁻, ベース ISO 換算] (ISO を上げるほど入力換算で小さくなる) */
  readNoisePost: number;
  adcBits: number;
}

// 実機の Photons to Photos / DxOMark の傾向に合わせた「ざっくり」値
export const SENSOR_TECHS: Record<SensorTech, TechSpec> = {
  legacy: { label: '旧世代 (表面照射, 12bit)', fullWellDensity: 1800, readNoisePre: 3.0, readNoisePost: 25, adcBits: 12 },
  bsi: { label: '標準 (裏面照射, 14bit)', fullWellDensity: 2400, readNoisePre: 1.6, readNoisePost: 8, adcBits: 14 },
  stacked: { label: '高性能 (積層・低ノイズ, 14bit)', fullWellDensity: 2600, readNoisePre: 1.0, readNoisePost: 4, adcBits: 14 },
};

export const BASE_ISO = 100;
/** ISO 12232 の飽和基準定数 [lx·s] */
const SATURATION_CONSTANT = 78;
/** H = (π/4)·T·L·t/N² のうち π/4 · レンズ透過率 0.9 */
const LENS_EXPOSURE_FACTOR = (Math.PI / 4) * 0.9;

export interface SensorConfig {
  format: SensorFormat;
  megapixels: number;
  tech: SensorTech;
}

export interface SensorDerived {
  widthMm: number;
  heightMm: number;
  widthPx: number;
  heightPx: number;
  /** 画素ピッチ [µm] */
  pitchUm: number;
  fullWell: number;
  cropFactor: number;
}

export function deriveSensor(cfg: SensorConfig): SensorDerived {
  const f = SENSOR_FORMATS[cfg.format];
  const aspect = f.width / f.height;
  const pixels = cfg.megapixels * 1e6;
  const widthPx = Math.round(Math.sqrt(pixels * aspect));
  const heightPx = Math.round(widthPx / aspect);
  const pitchUm = (f.width * 1000) / widthPx;
  const fullWell = SENSOR_TECHS[cfg.tech].fullWellDensity * pitchUm * pitchUm;
  const cropFactor = Math.hypot(36, 24) / Math.hypot(f.width, f.height);
  return { widthMm: f.width, heightMm: f.height, widthPx, heightPx, pitchUm, fullWell, cropFactor };
}

/**
 * シーン輝度 1 cd/m² が RAW 期待値いくつになるか（= pre-exposure 係数）。
 * シーンはこの係数を掛けた値で HDR バッファに描かれるので、バッファ値 ≒ RAW 期待値になる。
 */
export function rawPerLuminance(shutterSec: number, fNumber: number, iso: number): number {
  const hPerL = (LENS_EXPOSURE_FACTOR * shutterSec) / (fNumber * fNumber);
  return (hPerL * iso) / SATURATION_CONSTANT;
}

export interface NoiseParams {
  /** RAW 1.0 に相当する電子数 */
  electronsAtWhite: number;
  /** 画素が飽和する電子数 */
  fullWell: number;
  /** 読み出しノイズ [e⁻ rms] */
  readNoise: number;
  /** ADC 1 LSB あたりの電子数 */
  electronsPerDN: number;
}

export function noiseParams(cfg: SensorConfig, iso: number): NoiseParams {
  const d = deriveSensor(cfg);
  const tech = SENSOR_TECHS[cfg.tech];
  // ISO を上げる = 少ない電子数で RAW 1.0 に達するようゲインを上げる
  const electronsAtWhite = d.fullWell * (BASE_ISO / iso);
  const gainRatio = iso / BASE_ISO;
  const readNoise = Math.hypot(tech.readNoisePre, tech.readNoisePost / gainRatio);
  const electronsPerDN = electronsAtWhite / (2 ** tech.adcBits - 1);
  return { electronsAtWhite, fullWell: d.fullWell, readNoise, electronsPerDN };
}

/** 工学的ダイナミックレンジ [stop] = log2(飽和電子数 / ノイズフロア) */
export function dynamicRangeStops(cfg: SensorConfig, iso: number): number {
  const p = noiseParams(cfg, iso);
  const quantNoise = p.electronsPerDN / Math.sqrt(12);
  const floor = Math.hypot(p.readNoise, quantNoise);
  return Math.log2(Math.min(p.fullWell, p.electronsAtWhite) / floor);
}

/** 拡散反射面 (反射率 albedo) の照度 E [lx] 下での輝度 [cd/m²] */
export function lambertLuminance(illuminanceLux: number, albedo: number): number {
  return (albedo * illuminanceLux) / Math.PI;
}
