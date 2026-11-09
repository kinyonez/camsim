// 薄レンズモデルの光学計算（純粋関数）。距離はすべて mm 単位で受け取り mm で返す。

/** 撮像面上の錯乱円の直径 [mm]。subjectMm = Infinity も可 */
export function circleOfConfusionMm(focalMm: number, fNumber: number, focusMm: number, subjectMm: number): number {
  const k = (focalMm * focalMm) / (fNumber * (focusMm - focalMm));
  if (!Number.isFinite(subjectMm)) return k;
  return (k * Math.abs(subjectMm - focusMm)) / subjectMm;
}

/** 許容錯乱円: 対角長 / 1500（35mm 判で約 0.029mm） */
export function acceptableCoCMm(sensorWidthMm: number, sensorHeightMm: number): number {
  return Math.hypot(sensorWidthMm, sensorHeightMm) / 1500;
}

export function hyperfocalMm(focalMm: number, fNumber: number, cocMm: number): number {
  return (focalMm * focalMm) / (fNumber * cocMm) + focalMm;
}

/** 被写界深度の [前端, 後端] [mm]。後端は Infinity になり得る */
export function depthOfFieldMm(focalMm: number, fNumber: number, focusMm: number, cocMm: number): [number, number] {
  const h = hyperfocalMm(focalMm, fNumber, cocMm);
  const near = (focusMm * (h - focalMm)) / (h + focusMm - 2 * focalMm);
  const far = focusMm >= h ? Infinity : (focusMm * (h - focalMm)) / (h - focusMm);
  return [near, far];
}

/** 水平画角 [deg] */
export function horizontalFovDeg(focalMm: number, sensorWidthMm: number): number {
  return (2 * Math.atan(sensorWidthMm / (2 * focalMm)) * 180) / Math.PI;
}

/** 入射瞳（絞り）の半径 [mm] */
export function apertureRadiusMm(focalMm: number, fNumber: number): number {
  return focalMm / fNumber / 2;
}

/** 回折によるエアリーディスク直径 [µm]（λ = 550nm） */
export function airyDiskUm(fNumber: number): number {
  return 2.44 * 0.55 * fNumber;
}
