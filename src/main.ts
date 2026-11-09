import GUI, { type Controller } from 'lil-gui';
import {
  LinearSRGBColorSpace,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { acceptableCoCMm, apertureRadiusMm, depthOfFieldMm, horizontalFovDeg } from './camera/optics';
import {
  SENSOR_FORMATS,
  SENSOR_TECHS,
  type SensorConfig,
  type SensorFormat,
  type SensorTech,
  deriveSensor,
  dynamicRangeStops,
  noiseParams,
  blackPointRaw,
  rawPerLuminance,
} from './camera/sensor';
import { F_STOPS, ISO_STOPS, SHUTTER_STOPS, formatShutter, nearestShutter } from './camera/stops';
import { WalkControls } from './controls';
import { applyLensSample, lensSample } from './render/lensSampler';
import { CameraPipeline, METER_HEIGHT, METER_WIDTH } from './render/pipeline';
import { CITY_HALF, createCity } from './scene/city';
import { Environment, WEATHER_LABELS, type Weather } from './scene/environment';

const params = {
  weather: 'sunny' as Weather,
  carsMoving: true,
  format: 'FF' as SensorFormat,
  megapixels: 40,
  tech: 'bsi' as SensorTech,
  focal: 35,
  fNumber: 5.6,
  shutter: '1/800',
  iso: 100,
  focus: 12,
  afMode: 'AF-S' as 'AF-S' | 'AF-C',
  blades: 0,
  samples: 128,
  handheld: false,
  pixelPeep: false,
  noise: true,
  pushEV: 0,
  zebra: false,
};

// ---------- three.js ----------
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// 色空間変換・トーンマッピングはセンサーシェーダーで自前で行う
renderer.outputColorSpace = LinearSRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

const scene = new Scene();
const city = createCity();
scene.add(city.root);
const env = new Environment(scene, city);
env.setWeather(params.weather);

const camera = new PerspectiveCamera(50, 1.5, 0.1, 3000);
camera.position.set(3, 1.6, 40);
const controls = new WalkControls(camera, canvas, { half: CITY_HALF, minY: 0.3, maxY: 150 });
controls.apply();
const pipeline = new CameraPipeline(renderer);

// ---------- 状態 ----------
type Mode = 'preview' | 'capturing' | 'captured';
let mode: Mode = 'preview';
let simTime = 0;
let frame = 0;
let meterEV = 0;
let clippedRatio = 0;
let crushedRatio = 0;
let aeIterations = 3;
const capture = { position: new Vector3(), quaternion: new Quaternion(), time: 0, seed: 1, shakeAxis: new Vector3() };

/** これ以上はピント位置 ∞ として扱う [m] (400mm F1.2 の過焦点距離より遠い) */
const FOCUS_INFINITY = 10_000;
const FOCUS_MIN = 0.3;

const sensorConfig = (): SensorConfig => ({ format: params.format, megapixels: params.megapixels, tech: params.tech });
const shutterSeconds = (): number => SHUTTER_STOPS.find((s) => s.label === params.shutter)!.seconds;

function invalidate(): void {
  if (mode !== 'preview') {
    mode = 'preview';
    pipeline.resetAccumulation();
  }
}

// ---------- レイアウト ----------
const viewport = document.querySelector<HTMLElement>('#viewport')!;
const frameEl = document.querySelector<HTMLElement>('#frame')!;

function layout(): void {
  const s = deriveSensor(sensorConfig());
  const aspect = s.widthMm / s.heightMm;
  const availW = viewport.clientWidth - 24;
  const availH = viewport.clientHeight - 24 - 70;
  let w = availW;
  let h = w / aspect;
  if (h > availH) {
    h = availH;
    w = h * aspect;
  }
  w = Math.max(160, Math.floor(w));
  h = Math.max(100, Math.floor(h));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  frameEl.style.width = `${w}px`;
  frameEl.style.height = `${h}px`;
  const buf = renderer.getDrawingBufferSize(new Vector2());
  pipeline.setSize(buf.x, buf.y);
  invalidate();
}

/** 焦点距離・センサー・等倍表示をカメラに反映し、DoF とノイズ平均化の係数を返す */
function updateCamera(): { cocScale: number; averaging: number } {
  const s = deriveSensor(sensorConfig());
  const buf = renderer.getDrawingBufferSize(new Vector2());
  camera.filmGauge = s.widthMm;
  camera.aspect = s.widthMm / s.heightMm;
  camera.near = 0.1;
  camera.setFocalLength(params.focal);
  let fullWidthPx = buf.x;
  let averaging = (s.widthPx * s.heightPx) / (buf.x * buf.y);
  if (params.pixelPeep) {
    // センサー画素 = 表示画素 になるよう中央を切り出す
    const w = Math.min(buf.x, s.widthPx);
    const h = Math.min(buf.y, s.heightPx);
    camera.setViewOffset(s.widthPx, s.heightPx, (s.widthPx - w) / 2, (s.heightPx - h) / 2, w, h);
    fullWidthPx = s.widthPx;
    averaging = 1;
  } else {
    camera.clearViewOffset();
  }
  // 錯乱円直径 c[mm] = f²·S / (N·(S−f)) · |1/S − 1/d|  →  半径 [px]
  const f = params.focal;
  const S = params.focus * 1000;
  const A = (f * f * S) / (params.fNumber * Math.max(S - f, 1e-3));
  const cocScale = ((A / 1000) * 0.5 * fullWidthPx) / s.widthMm;
  return { cocScale, averaging };
}

// ---------- 撮影 ----------
function startCapture(): void {
  mode = 'capturing';
  pipeline.resetAccumulation();
  capture.position.copy(camera.position);
  capture.quaternion.copy(camera.quaternion);
  capture.time = simTime;
  capture.seed = (Math.random() * 2 ** 31) | 0;
  // 手ブレ: ランダムな軸 (ピッチ/ヨー) 回りに一定角速度で回転すると近似
  const a = Math.random() * Math.PI * 2;
  capture.shakeAxis.set(Math.cos(a), Math.sin(a), 0);
}

const HANDHELD_RAD_PER_SEC = 0.02;

function captureSamples(budgetMs: number): void {
  const t0 = performance.now();
  const total = params.samples;
  const apertureM = apertureRadiusMm(params.focal, params.fNumber) / 1000;
  const shutter = shutterSeconds();
  const buf = renderer.getDrawingBufferSize(new Vector2());
  const view = camera.view?.enabled
    ? { ...camera.view }
    : { fullWidth: buf.x, fullHeight: buf.y, offsetX: 0, offsetY: 0, width: buf.x, height: buf.y };
  while (pipeline.accumulatedSamples < total && performance.now() - t0 < budgetMs) {
    const s = lensSample(pipeline.accumulatedSamples, total, apertureM, params.blades);
    city.update(capture.time + s.time * shutter);
    const shake = params.handheld ? HANDHELD_RAD_PER_SEC * shutter * (s.time - 0.5) : 0;
    applyLensSample(camera, capture.position, capture.quaternion, params.focus, view, s, params.handheld ? capture.shakeAxis : null, shake);
    pipeline.accumulate(scene, camera);
  }
  camera.position.copy(capture.position);
  camera.quaternion.copy(capture.quaternion);
  camera.updateProjectionMatrix();
  if (pipeline.accumulatedSamples >= total) mode = 'captured';
}

// ---------- 露出計・ヒストグラム ----------
const histCanvas = document.querySelector<HTMLCanvasElement>('#histogram')!;
const histCtx = histCanvas.getContext('2d')!;
const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function updateMeter(px: Float32Array): void {
  const bins = new Array(64).fill(0);
  let sum = 0;
  let wSum = 0;
  let clipped = 0;
  let crushed = 0;
  const blackPoint = blackPointRaw(sensorConfig(), params.iso);
  const push = 2 ** params.pushEV;
  for (let y = 0; y < METER_HEIGHT; y++) {
    for (let x = 0; x < METER_WIDTH; x++) {
      const i = (y * METER_WIDTH + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // 中央重点平均測光 (高輝度部は RAW 2.0 で頭打ち)
      const dx = x / METER_WIDTH - 0.5;
      const dy = y / METER_HEIGHT - 0.5;
      const w = Math.exp(-(dx * dx + dy * dy) / 0.08);
      sum += w * Math.min(lum, 2);
      wSum += w;
      if (Math.max(r, g, b) >= 1) clipped++;
      else if (lum <= blackPoint) crushed++;
      const v = srgb(Math.min(1, Math.max(0, lum * push)));
      bins[Math.min(63, Math.floor(v * 64))]++;
    }
  }
  // 18% グレーを基準にした露出計の値
  meterEV = Math.log2(Math.max(sum / wSum, 1e-6) / 0.18);
  clippedRatio = clipped / (METER_WIDTH * METER_HEIGHT);
  crushedRatio = crushed / (METER_WIDTH * METER_HEIGHT);

  const { width, height } = histCanvas;
  histCtx.clearRect(0, 0, width, height);
  const max = Math.max(...bins.slice(1, 63), 1);
  histCtx.fillStyle = 'rgba(230,230,230,0.85)';
  bins.forEach((n, i) => {
    const h = Math.min(1, n / max) * (height - 4);
    histCtx.fillRect((i * width) / 64, height - h, width / 64 - 0.5, h);
  });
  histCtx.fillStyle = 'rgba(255,255,255,0.5)';
  histCtx.font = '10px system-ui';
  histCtx.fillText(`露出計 ${meterEV >= 0 ? '+' : ''}${meterEV.toFixed(1)}EV`, 4, 11);
}

/** 露出計が 0 になるようシャッター速度を合わせる */
function autoExposure(): void {
  const target = shutterSeconds() * 2 ** -meterEV;
  params.shutter = nearestShutter(Math.min(30, target)).label;
  guiControllers.forEach((c) => c.updateDisplay());
  invalidate();
}

// ---------- 情報表示 ----------
const infoEl = document.querySelector<HTMLElement>('#info')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;

function updateInfo(): void {
  const cfg = sensorConfig();
  const s = deriveSensor(cfg);
  const n = noiseParams(cfg, params.iso);
  const t = shutterSeconds();
  const ev100 = Math.log2((params.fNumber * params.fNumber) / t) - Math.log2(params.iso / 100);
  const coc = acceptableCoCMm(s.widthMm, s.heightMm);
  const [near, far] = depthOfFieldMm(params.focal, params.fNumber, params.focus * 1000, coc);
  const fmt = (mm: number) => (Number.isFinite(mm) && mm < FOCUS_INFINITY * 1000 ? `${(mm / 1000).toFixed(2)}m` : '∞');
  const items = [
    `ピント ${fmt(params.focus * 1000)} (${params.afMode})`,
    `35mm換算 ${(params.focal * s.cropFactor).toFixed(0)}mm (水平 ${horizontalFovDeg(params.focal, s.widthMm).toFixed(1)}°)`,
    `${s.widthPx}×${s.heightPx}px / 画素ピッチ ${s.pitchUm.toFixed(2)}µm`,
    `飽和 ${Math.round(Math.min(n.fullWell, n.electronsAtWhite)).toLocaleString()}e⁻ / 読出しノイズ ${n.readNoise.toFixed(1)}e⁻ / DR ${dynamicRangeStops(cfg, params.iso).toFixed(1)}EV`,
    `EV100 ${ev100.toFixed(1)}`,
    `被写界深度 ${fmt(near)} 〜 ${fmt(far)}`,
    `位置 (${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}) m`,
  ];
  infoEl.innerHTML = items.map((i) => `<span>${i}</span>`).join('');

  const clip =
    (clippedRatio > 0.001 ? ` / 白飛び ${(clippedRatio * 100).toFixed(1)}%` : '') +
    (crushedRatio > 0.001 ? ` / 黒つぶれ ${(crushedRatio * 100).toFixed(1)}%` : '');
  if (mode === 'preview') statusEl.textContent = `ライブビュー (ボケは近似)${clip}`;
  else if (mode === 'capturing') statusEl.textContent = `撮影中 ${pipeline.accumulatedSamples}/${params.samples}`;
  else statusEl.textContent = `撮影結果 ${params.samples} サンプル / ${formatShutter(t)} F${params.fNumber} ISO${params.iso}${clip}`;
}

// ---------- GUI ----------
const gui = new GUI({ container: document.querySelector<HTMLElement>('#panel')!, title: 'CamSim' });
const guiControllers: Controller[] = [];
const add = <T extends Controller>(c: T, onChange: () => void = invalidate): T => {
  c.onChange(onChange);
  guiControllers.push(c);
  return c;
};
const options = <K extends string>(rec: Record<K, { label: string }>) =>
  Object.fromEntries(Object.entries<{ label: string }>(rec).map(([k, v]) => [v.label, k]));

const fScene = gui.addFolder('シーン');
add(fScene.add(params, 'weather', Object.fromEntries(Object.entries(WEATHER_LABELS).map(([k, v]) => [v, k]))).name('天気'), () => {
  env.setWeather(params.weather);
  aeIterations = 3;
  invalidate();
});
add(fScene.add(params, 'carsMoving').name('車を動かす'));

const fBody = gui.addFolder('カメラ');
add(fBody.add(params, 'format', options(SENSOR_FORMATS)).name('センサーサイズ'), layout);
add(fBody.add(params, 'megapixels', { '20M': 20, '40M': 40, '60M': 60 }).name('画素数'));
add(fBody.add(params, 'tech', options(SENSOR_TECHS)).name('センサー世代'));

const fLens = gui.addFolder('レンズ・露出');
add(fLens.add(params, 'focal', 8, 400, 1).name('焦点距離 [mm]'));
add(fLens.add(params, 'fNumber', F_STOPS).name('F値'));
add(fLens.add(params, 'shutter', SHUTTER_STOPS.map((s) => s.label)).name('シャッター'));
add(fLens.add(params, 'iso', ISO_STOPS).name('ISO'));
add(fLens.add(params, 'afMode', { 'AF-S (クリック時に合わせる)': 'AF-S', 'AF-C (AF枠の位置で合わせ続ける)': 'AF-C' }).name('AF モード'), () => {
  if (params.afMode === 'AF-C') autofocus(afPoint ?? new Vector2(0, 0));
  else afMarker.classList.remove('tracking');
});
// MF: 0.3m〜∞ を対数スライダーで
const manualFocus = {
  get t(): number {
    return Math.log(params.focus / FOCUS_MIN) / Math.log(FOCUS_INFINITY / FOCUS_MIN);
  },
  set t(v: number) {
    params.focus = +(FOCUS_MIN * (FOCUS_INFINITY / FOCUS_MIN) ** v).toPrecision(3);
    if (params.afMode === 'AF-C') params.afMode = 'AF-S';
  },
};
add(fLens.add(manualFocus, 't', 0, 1, 0.001).name('MF (近 ⇔ ∞)'), () => {
  afMarker.classList.remove('tracking');
  guiControllers.forEach((c) => c.updateDisplay());
  invalidate();
});
add(fLens.add(params, 'focus').min(FOCUS_MIN).max(FOCUS_INFINITY).step(0.01).name('ピント距離 [m]'));
add(fLens.add(params, 'blades', { 円形: 0, '5枚': 5, '6枚': 6, '7枚': 7, '9枚': 9 }).name('絞り羽根 (撮影時)'));
fLens.add({ ae: autoExposure }, 'ae').name('露出計に合わせてシャッター調整');

const fShot = gui.addFolder('撮影 (正確なボケ・ブレ)');
add(fShot.add(params, 'samples', [16, 64, 128, 256]).name('サンプル数'));
add(fShot.add(params, 'handheld').name('手持ち (手ブレ)'));
fShot.add({ shoot: startCapture }, 'shoot').name('📷 撮影 (Enter)');

const fView = gui.addFolder('表示・現像');
add(fView.add(params, 'pixelPeep').name('等倍表示 (中央)'));
add(fView.add(params, 'noise').name('センサーノイズ'), () => {});
add(fView.add(params, 'pushEV', -3, 6, 0.1).name('RAW 露出補正 [EV]'), () => {});
add(fView.add(params, 'zebra').name('白飛び・黒つぶれ警告 (ゼブラ)'), () => {});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && (e.target as HTMLElement).tagName !== 'INPUT') startCapture();
});

// ---------- AF ----------
const raycaster = new Raycaster();
const afMarker = document.querySelector<HTMLElement>('#afpoint')!;
let afPoint: Vector2 | null = null;
let afHideTimer = 0;

/** 画面上の点 (NDC) にある物体までの距離 (光軸方向) [m]。何もなければ ∞ */
function measureFocus(ndc: Vector2): number {
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(city.root, true)[0];
  if (!hit) return FOCUS_INFINITY;
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return Math.min(FOCUS_INFINITY, Math.max(FOCUS_MIN, +hit.point.clone().sub(camera.position).dot(forward).toFixed(2)));
}

function autofocus(ndc: Vector2): void {
  afPoint = ndc.clone();
  updateCamera();
  params.focus = measureFocus(ndc);
  guiControllers.forEach((c) => c.updateDisplay());
  invalidate();
  // AF 枠: AF-S は合焦表示を少し出して消す、AF-C は出し続ける
  afMarker.style.left = `${((ndc.x + 1) / 2) * 100}%`;
  afMarker.style.top = `${((1 - ndc.y) / 2) * 100}%`;
  afMarker.classList.remove('locked');
  void afMarker.offsetWidth; // アニメーションを再生し直す
  afMarker.classList.add('locked');
  afMarker.classList.toggle('tracking', params.afMode === 'AF-C');
  clearTimeout(afHideTimer);
  afHideTimer = window.setTimeout(() => afMarker.classList.remove('locked'), 1200);
}

controls.onChange = invalidate;
controls.onClick = autofocus;

// ---------- ループ ----------
window.addEventListener('resize', layout);
layout();

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame++;
  controls.update(dt);

  const { cocScale, averaging } = updateCamera();
  env.photometry.apply(rawPerLuminance(shutterSeconds(), params.fNumber, params.iso));

  let raw;
  if (mode === 'preview') {
    if (params.carsMoving) simTime += dt;
    city.update(simTime);
    if (params.afMode === 'AF-C' && afPoint && frame % 3 === 0) {
      const d = measureFocus(afPoint);
      if (Math.abs(Math.log(d / params.focus)) > 0.002) {
        params.focus = d;
        guiControllers.forEach((c) => c.updateDisplay());
      }
    }
    raw = pipeline.renderPreview(scene, camera, { cocScale, focusM: params.focus });
    if (frame % 8 === 0 || aeIterations > 0) {
      updateMeter(pipeline.readMeter(raw));
      if (aeIterations > 0 && frame > 2) {
        aeIterations--;
        autoExposure();
      }
    }
  } else {
    if (mode === 'capturing') captureSamples(30);
    raw = pipeline.accumulated;
  }

  pipeline.present(raw, {
    noise: noiseParams(sensorConfig(), params.iso),
    enableNoise: params.noise,
    averaging,
    pushEV: params.pushEV,
    zebra: params.zebra,
    blackPoint: blackPointRaw(sensorConfig(), params.iso),
    seed: mode === 'preview' ? frame : capture.seed,
  });
  if (frame % 6 === 0) updateInfo();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// デバッグ・自動テスト用
Object.assign(window, { camsim: { params, startCapture, autoExposure, get mode() { return mode; }, invalidate, env, camera, controls, city } });
