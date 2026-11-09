import { MathUtils, type PerspectiveCamera, Quaternion, Vector3 } from 'three';

// 撮影モードの 1 サンプル分のカメラを作る。
// 薄レンズ: 絞り上の点へカメラを平行移動し、ピント面上の像が動かないよう投影窓を逆方向にずらす
// (非対称フラスタム)。全サンプルの平均が「正しい」ボケになる。露光中の時刻・手ブレも同時にサンプルする。

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const R2_A1 = 0.7548776662466927;
const R2_A2 = 0.5698402909980532;

export interface LensSample {
  /** 絞り上の位置 [m] (カメラ座標) */
  dx: number;
  dy: number;
  /** 露光時間内の時刻 0..1 */
  time: number;
  /** サブピクセルジッター [px] */
  jx: number;
  jy: number;
}

/** i 番目 / n のサンプル。絞りは Vogel 螺旋で均等に埋め、羽根枚数 > 0 なら正多角形に変形する */
export function lensSample(i: number, n: number, apertureRadiusM: number, blades: number): LensSample {
  const r = Math.sqrt((i + 0.5) / n);
  const theta = i * GOLDEN_ANGLE;
  let scale = 1;
  if (blades >= 3) {
    const sector = (2 * Math.PI) / blades;
    const local = MathUtils.euclideanModulo(theta + Math.PI / 2, sector) - sector / 2;
    scale = Math.cos(Math.PI / blades) / Math.cos(local);
  }
  const rr = r * scale * apertureRadiusM;
  return {
    dx: rr * Math.cos(theta),
    dy: rr * Math.sin(theta),
    // 絞り位置と相関しない低食い違い列
    time: (i * 0.6180339887 + 0.5) % 1,
    jx: ((i * R2_A1 + 0.5) % 1) - 0.5,
    jy: ((i * R2_A2 + 0.5) % 1) - 0.5,
  };
}

export interface ViewWindow {
  fullWidth: number;
  fullHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

const _right = new Vector3();
const _up = new Vector3();
const _shake = new Quaternion();

/**
 * camera を base の位置・姿勢からずらしたサンプルカメラにする。
 * projectionMatrix は直接書き換えるので、プレビューに戻るときは updateProjectionMatrix() を呼ぶこと。
 */
export function applyLensSample(
  camera: PerspectiveCamera,
  basePosition: Vector3,
  baseQuaternion: Quaternion,
  focusM: number,
  view: ViewWindow,
  s: LensSample,
  shakeAxis: Vector3 | null,
  shakeAngle: number,
): void {
  const near = camera.near;
  let top = (near * Math.tan(MathUtils.DEG2RAD * 0.5 * camera.fov)) / camera.zoom;
  let height = 2 * top;
  let width = camera.aspect * height;
  let left = -0.5 * width;
  // setViewOffset と同じ部分窓 (等倍表示)
  left += (view.offsetX * width) / view.fullWidth;
  top -= (view.offsetY * height) / view.fullHeight;
  width *= view.width / view.fullWidth;
  height *= view.height / view.fullHeight;
  // アンチエイリアス用のジッター
  left += (s.jx * width) / view.width;
  top += (s.jy * height) / view.height;
  // レンズ移動分だけ投影窓を戻す (ピント面 focusM で像が一致する)
  left -= (s.dx * near) / focusM;
  top -= (s.dy * near) / focusM;
  camera.projectionMatrix.makePerspective(left, left + width, top, top - height, near, camera.far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  _right.set(1, 0, 0).applyQuaternion(baseQuaternion);
  _up.set(0, 1, 0).applyQuaternion(baseQuaternion);
  camera.position.copy(basePosition).addScaledVector(_right, s.dx).addScaledVector(_up, s.dy);
  camera.quaternion.copy(baseQuaternion);
  if (shakeAxis) camera.quaternion.multiply(_shake.setFromAxisAngle(shakeAxis, shakeAngle));
  camera.updateMatrixWorld(true);
}
