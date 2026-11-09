import {
  type BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  PlaneGeometry,
  PointLight,
  RectAreaLight,
  SphereGeometry,
  SpotLight,
  Vector3,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Batch, box, mulberry32 } from './geometry';
import { ambientUniforms, exteriorMaterial, interiorMaterial } from './materials';
import type { Photometry } from './photometry';
import type { OutdoorConditions, Situation } from './situation';

// 6m × 5m × 天井 2.6m のリビング。窓は -z 面 (大) と -x 面 (小)。外は庭。
//
// 室内の光:
//   窓     : 窓の開口を RectAreaLight (輝度 = 窓から見える屋外の平均輝度) にする
//   直射光 : 太陽 / 月の DirectionalLight。壁・床・天井が影を落とすので窓からだけ差し込む
//   照明   : 天井灯 (PointLight)・デスクライト (SpotLight)・電飾 (発光体のみ)
//   相互反射: 部屋に入る全光束 Φ から、積分球の式 E = Φ·ρ / (A·(1−ρ)) で一様な間接照度を求め、
//            室内マテリアルの環境光にする (GI の代わりの近似)
const W = 6;
const D = 5;
const H = 2.6;
const WALL = 0.15;
const ALBEDO = 0.4;
const SURFACE_AREA = 2 * (W * D + W * H + D * H);

interface WindowSpec {
  /** 開口の中心と大きさ */
  center: Vector3;
  width: number;
  height: number;
  /** 室内側を向く法線 */
  inward: Vector3;
}

const WINDOWS: WindowSpec[] = [
  { center: new Vector3(-0.3, 1.5, -D / 2), width: 2.6, height: 1.5, inward: new Vector3(0, 0, 1) },
  { center: new Vector3(-W / 2, 1.5, -0.4), width: 1.4, height: 1.2, inward: new Vector3(1, 0, 0) },
];

// 夜の照明: 天井灯 ~1,900 lm (等方換算 150 cd)、デスクライト ~300 cd (下向き)、電飾 1 粒 ~0.5 lm
const LIGHTS = { ceilingCandela: 150, ceilingDiffuser: 3_000, deskCandela: 300, deskBulb: 30_000, fairy: 20_000, monitor: 150 };

export function createRoom(seed = 5): Situation {
  RectAreaLightUniformsLib.init();
  const rand = mulberry32(seed);
  const root = new Group();
  const surfaceMat = interiorMaterial({ vertexColors: true });
  const inside = new Batch();

  // ---- 壁・床・天井 (窓の開口を残して箱を並べる) ----
  inside.add(box(W + 2 * WALL, WALL, D + 2 * WALL, 0, -WALL / 2, 0), 0x9a7650); // 床 (木)
  inside.add(box(W + 2 * WALL, WALL, D + 2 * WALL, 0, H + WALL / 2, 0), 0xe8e4dc); // 天井
  const wallColor = 0xd9d2c5;
  const [wz, wx] = WINDOWS;
  // -z 面 (大窓)
  addWallWithOpening(inside, 'z', -D / 2 - WALL / 2, W, wz, wallColor);
  // -x 面 (小窓)
  addWallWithOpening(inside, 'x', -W / 2 - WALL / 2, D, wx, wallColor);
  // +z, +x 面
  inside.add(box(W + 2 * WALL, H + 2 * WALL, WALL, 0, H / 2, D / 2 + WALL / 2), wallColor);
  inside.add(box(WALL, H + 2 * WALL, D + 2 * WALL, W / 2 + WALL / 2, H / 2, 0), 0xc9d3cf);
  // 巾木
  inside.add(box(W, 0.08, 0.02, 0, 0.04, D / 2 - 0.01), 0xf0ece4);
  inside.add(box(0.02, 0.08, D, W / 2 - 0.01, 0.04, 0), 0xf0ece4);
  // 窓枠と桟 (床に桟の影が落ちる)
  for (const w of WINDOWS) addWindowFrame(inside, w);

  // ---- 家具 ----
  // ラグ
  inside.add(box(2.6, 0.012, 1.8, 0.4, 0.006, 0.6), 0x8c3f3a);
  // ソファ (+z の壁際)
  const sofa = 0x4f6378;
  inside.add(box(2.3, 0.42, 0.9, 0.4, 0.21, D / 2 - 0.5), sofa);
  inside.add(box(2.3, 0.5, 0.22, 0.4, 0.62, D / 2 - 0.11), sofa);
  inside.add(box(0.2, 0.25, 0.9, -0.65, 0.54, D / 2 - 0.5), sofa);
  inside.add(box(0.2, 0.25, 0.9, 1.45, 0.54, D / 2 - 0.5), sofa);
  inside.add(box(0.45, 0.35, 0.12, -0.2, 0.6, D / 2 - 0.3).rotateY(0.1), 0xd9a441);
  // ローテーブルとマグ・本
  inside.add(box(1.1, 0.05, 0.6, 0.4, 0.4, 0.5), 0x6b4a32);
  for (const [x, z] of [[-0.1, 0.25], [0.9, 0.25], [-0.1, 0.75], [0.9, 0.75]]) inside.add(box(0.05, 0.38, 0.05, x, 0.19, z), 0x6b4a32);
  inside.add(new CylinderGeometry(0.045, 0.04, 0.1, 10).translate(0.15, 0.475, 0.45), 0xf2f2f2);
  inside.add(box(0.22, 0.04, 0.3, 0.6, 0.445, 0.55).rotateY(0.3), 0x2d5d7b);
  // ダイニングテーブルと椅子 (窓際)
  inside.add(box(1.4, 0.05, 0.8, -1.2, 0.74, -1.3), 0xb48a5e);
  for (const [x, z] of [[-1.8, -1.6], [-0.6, -1.6], [-1.8, -1.0], [-0.6, -1.0]]) inside.add(box(0.06, 0.72, 0.06, x, 0.36, z), 0xb48a5e);
  for (const z of [-0.6, -2.0]) {
    const back = z > -1.3 ? 0.2 : -0.2;
    inside.add(box(0.45, 0.04, 0.45, -1.2, 0.46, z), 0x3d3d3d);
    inside.add(box(0.45, 0.45, 0.04, -1.2, 0.7, z + back), 0x3d3d3d);
    for (const [dx, dz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) inside.add(box(0.03, 0.44, 0.03, -1.2 + dx, 0.22, z + dz), 0x3d3d3d);
  }
  // 果物の器
  inside.add(new CylinderGeometry(0.16, 0.09, 0.07, 10).translate(-1.2, 0.8, -1.3), 0xe6e1d6);
  for (let k = 0; k < 4; k++) inside.add(new IcosahedronGeometry(0.045, 0).translate(-1.25 + (k % 2) * 0.09, 0.85, -1.33 + Math.floor(k / 2) * 0.07), k % 2 ? 0xd84a2f : 0xe0b23a);
  // 本棚 (+x の壁際)
  const shelfX = W / 2 - 0.2;
  inside.add(box(0.36, 2.0, 0.04, shelfX, 1.0, -0.6), 0x7a5a3c);
  inside.add(box(0.36, 2.0, 0.04, shelfX, 1.0, 0.6), 0x7a5a3c);
  for (let k = 0; k <= 5; k++) inside.add(box(0.36, 0.03, 1.2, shelfX, 0.05 + k * 0.38, 0), 0x7a5a3c);
  const bookColors = [0xa63d40, 0x2e5266, 0xe9b44c, 0x6e8b3d, 0xd8d4c8, 0x403d58, 0x8c5e3c];
  for (let k = 0; k < 5; k++) {
    let z = -0.56;
    while (z < 0.5) {
      const t = 0.03 + rand() * 0.04;
      const h = 0.22 + rand() * 0.1;
      if (rand() > 0.12) inside.add(box(0.24, h, t, shelfX + 0.03, 0.065 + k * 0.38 + h / 2, z + t / 2), bookColors[Math.floor(rand() * bookColors.length)]);
      z += t + 0.004;
    }
  }
  // デスク・モニター・デスクライト (+x の窓寄り)
  const deskX = 1.9;
  const deskZ = -D / 2 + 0.4;
  inside.add(box(1.4, 0.04, 0.7, deskX, 0.73, deskZ), 0xe0dcd2);
  for (const dx of [-0.65, 0.65]) inside.add(box(0.04, 0.72, 0.66, deskX + dx, 0.36, deskZ), 0x9b9b9b);
  inside.add(box(0.6, 0.36, 0.03, deskX + 0.15, 1.06, deskZ - 0.22), 0x1d1f22);
  inside.add(box(0.04, 0.18, 0.04, deskX + 0.15, 0.84, deskZ - 0.24), 0x1d1f22);
  inside.add(box(0.45, 0.02, 0.15, deskX + 0.1, 0.76, deskZ + 0.05), 0x2a2a2a);
  const lampBase = new Vector3(deskX - 0.5, 0.75, deskZ - 0.1);
  inside.add(new CylinderGeometry(0.08, 0.09, 0.03, 10).translate(lampBase.x, lampBase.y + 0.015, lampBase.z), 0x2b2b2b);
  inside.add(new CylinderGeometry(0.012, 0.012, 0.45, 6).translate(lampBase.x, lampBase.y + 0.24, lampBase.z), 0x2b2b2b);
  inside.add(new ConeGeometry(0.11, 0.14, 12, 1, true).translate(lampBase.x + 0.05, lampBase.y + 0.46, lampBase.z), 0x2b2b2b);
  // 観葉植物
  inside.add(new CylinderGeometry(0.18, 0.14, 0.35, 8).translate(-W / 2 + 0.4, 0.175, D / 2 - 0.4), 0xb5653f);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    inside.add(new ConeGeometry(0.12, 0.7, 4).rotateZ(0.5).rotateY(a).translate(-W / 2 + 0.4 + Math.cos(a) * 0.12, 0.7, D / 2 - 0.4 + Math.sin(a) * 0.12), new Color(0x3f7a3a).multiplyScalar(0.8 + rand() * 0.4));
  }
  // 壁の絵
  inside.add(box(0.9, 0.6, 0.03, 0.4, 1.6, D / 2 - 0.02), 0x3a3a3a);
  inside.add(box(0.8, 0.5, 0.01, 0.4, 1.6, D / 2 - 0.04), 0x5b8fb9);
  inside.add(box(0.03, 0.5, 0.4, W / 2 - 0.02, 1.7, 1.6), 0x3a3a3a);
  inside.add(box(0.01, 0.42, 0.32, W / 2 - 0.04, 1.7, 1.6), 0xc77d4b);
  // 天井灯の台座
  inside.add(new CylinderGeometry(0.25, 0.25, 0.04, 16).translate(0.2, H - 0.02, 0.3), 0xf5f5f5);

  const insideMesh = inside.build(surfaceMat);
  if (insideMesh) root.add(insideMesh);

  // ---- 発光体 ----
  const diffuser = interiorMaterial({ color: 0xf5f5f5, emissive: 0xfff1dc });
  const bulb = interiorMaterial({ color: 0xffffff, emissive: 0xffd8a0 });
  const fairyMat = interiorMaterial({ color: 0x777777, emissive: 0xffb45a });
  const monitorMat = interiorMaterial({ color: 0x0b0d10, emissive: 0xbfd4ff });
  root.add(new Mesh(new CylinderGeometry(0.22, 0.22, 0.02, 16).translate(0.2, H - 0.05, 0.3), diffuser));
  root.add(new Mesh(new SphereGeometry(0.035, 8, 6).translate(lampBase.x + 0.05, lampBase.y + 0.42, lampBase.z), bulb));
  root.add(new Mesh(new PlaneGeometry(0.56, 0.32).translate(deskX + 0.15, 1.06, deskZ - 0.2), monitorMat));
  // 電飾: 本棚の上から +z の壁沿いに垂れ下がる
  const fairyGeos: BufferGeometry[] = [];
  for (let k = 0; k < 28; k++) {
    const t = k / 27;
    const z = -0.6 + t * 2.9;
    const y = 2.25 - Math.sin(t * Math.PI * 3) ** 2 * 0.25;
    fairyGeos.push(new SphereGeometry(0.012, 6, 4).translate(W / 2 - 0.05, y, z));
  }
  root.add(new Mesh(mergeGeometries(fairyGeos), fairyMat));

  const ceiling = new PointLight(0xfff1dc, 1, 0, 2);
  ceiling.position.set(0.2, H - 0.15, 0.3);
  ceiling.castShadow = true;
  ceiling.shadow.mapSize.set(1024, 1024);
  ceiling.shadow.bias = -0.002;
  const desk = new SpotLight(0xffd8a0, 1, 0, Math.PI / 3.2, 0.5, 2);
  desk.position.set(lampBase.x + 0.05, lampBase.y + 0.4, lampBase.z);
  desk.target.position.set(lampBase.x + 0.15, 0.7, lampBase.z);
  desk.castShadow = true;
  desk.shadow.mapSize.set(1024, 1024);
  desk.shadow.bias = -0.002;
  root.add(ceiling, desk, desk.target);

  // 窓 = 面光源
  const windowLights = WINDOWS.map((w) => {
    const light = new RectAreaLight(0xe8eeff, 1, w.width, w.height);
    light.position.copy(w.center).addScaledVector(w.inward, 0.01);
    light.lookAt(w.center.clone().add(w.inward));
    root.add(light);
    return light;
  });

  // ---- 外 (庭・塀・木・隣家) ----
  const outside = new Batch();
  outside.add(new PlaneGeometry(200, 200).rotateX(-Math.PI / 2).translate(0, -0.02, 0), 0x6b8f45);
  outside.add(box(8, 0.05, 6, -1, 0.0, -D / 2 - 3.2), 0xa39a8a); // テラス
  for (let x = -14; x <= 12; x += 2) outside.add(box(1.8, 1.4, 0.08, x, 0.7, -14), 0xb39b7d); // 塀
  for (let z = -14; z <= 10; z += 2) outside.add(box(0.08, 1.4, 1.8, -16, 0.7, z), 0xb39b7d);
  outside.add(box(9, 6, 7, -6, 3, -24), 0xc9bba6); // 隣家
  outside.add(new CylinderGeometry(4.8, 4.8, 9, 3).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.4, 1).translate(-6, 7.2, -24), 0x6e4a3e);
  for (let i = 0; i < 14; i++) {
    const x = -14 + rand() * 26;
    const z = -8 - rand() * 18;
    const h = 3 + rand() * 4;
    outside.add(new CylinderGeometry(0.12, 0.18, h * 0.45, 5).translate(x, h * 0.22, z), 0x6b4f35);
    outside.add(new IcosahedronGeometry(h * 0.3, 0).translate(x, h * 0.62, z), new Color(0x4f7d36).multiplyScalar(0.8 + rand() * 0.4));
  }
  const outsideMesh = outside.build(exteriorMaterial({ vertexColors: true }));
  if (outsideMesh) root.add(outsideMesh);

  function setWeather(c: OutdoorConditions, p: Photometry): void {
    const night = c.weather === 'night';
    // 窓から見える屋外の輝度 = 窓の面光源の輝度
    let flux = 0;
    for (const [i, w] of WINDOWS.entries()) {
      p.setLight(windowLights[i], c.horizontalLuminance);
      const area = w.width * w.height;
      flux += Math.PI * c.horizontalLuminance * area;
      // 窓を通る直射光の光束 (窓面への入射角で減る)
      flux += c.directLux * Math.max(0, -c.directDir.dot(w.inward)) * area;
    }
    ceiling.visible = desk.visible = night;
    p.setLight(ceiling, night ? LIGHTS.ceilingCandela : 0);
    p.setLight(desk, night ? LIGHTS.deskCandela : 0);
    p.setEmissive(diffuser, night ? LIGHTS.ceilingDiffuser : 0);
    p.setEmissive(bulb, night ? LIGHTS.deskBulb : 0);
    p.setEmissive(fairyMat, night ? LIGHTS.fairy : 0);
    p.setEmissive(monitorMat, LIGHTS.monitor);
    if (night) {
      flux += 4 * Math.PI * LIGHTS.ceilingCandela;
      // スポットは円錐内だけに出る (立体角 2π(1−cosθ))
      flux += 2 * Math.PI * (1 - Math.cos(desk.angle)) * LIGHTS.deskCandela;
    }
    const indirect = (flux * ALBEDO) / (SURFACE_AREA * (1 - ALBEDO));
    p.setVector(ambientUniforms.interior.up, [indirect * 0.95, indirect * 0.95, indirect]);
    p.setVector(ambientUniforms.interior.down, [indirect, indirect * 0.95, indirect * 0.9]);
  }

  return {
    root,
    bounds: { min: new Vector3(-W / 2 + 0.2, 0.2, -D / 2 + 0.2), max: new Vector3(W / 2 - 0.2, H - 0.15, D / 2 - 0.2) },
    // 部屋の奥から窓側を見る
    start: { position: new Vector3(2.4, 1.4, 2.0), yaw: -0.75, pitch: 0.1, focus: 3, focal: 24 },
    shadow: { center: new Vector3(0, 1, -2), extent: 12 },
    nightSky: 'rural',
    setWeather,
    update: () => {},
  };
}

/** 開口部を残した壁。axis = 壁の法線方向 */
function addWallWithOpening(batch: Batch, axis: 'x' | 'z', pos: number, length: number, w: WindowSpec, color: number): void {
  const along = axis === 'z' ? w.center.x : w.center.z;
  const left = -length / 2 - WALL;
  const right = length / 2 + WALL;
  const o0 = along - w.width / 2;
  const o1 = along + w.width / 2;
  const y0 = w.center.y - w.height / 2;
  const y1 = w.center.y + w.height / 2;
  const total = H + 2 * WALL;
  const seg = (a0: number, a1: number, b0: number, b1: number) => {
    const len = a1 - a0;
    const hh = b1 - b0;
    const mid = (a0 + a1) / 2;
    const midY = (b0 + b1) / 2;
    batch.add(axis === 'z' ? box(len, hh, WALL, mid, midY, pos) : box(WALL, hh, len, pos, midY, mid), color);
  };
  seg(left, o0, -WALL, total - WALL); // 開口の左
  seg(o1, right, -WALL, total - WALL); // 開口の右
  seg(o0, o1, -WALL, y0); // 腰壁
  seg(o0, o1, y1, total - WALL); // 垂れ壁
}

function addWindowFrame(batch: Batch, w: WindowSpec): void {
  const frame = 0xf4f1ea;
  const t = 0.05;
  const isZ = w.inward.z !== 0;
  const plane = isZ ? w.center.z - WALL / 2 : w.center.x - WALL / 2;
  const add = (along: number, y: number, len: number, hh: number) =>
    batch.add(isZ ? box(len, hh, 0.06, along, y, plane) : box(0.06, hh, len, plane, y, along), frame);
  const along = isZ ? w.center.x : w.center.z;
  add(along, w.center.y - w.height / 2 + t / 2, w.width, t);
  add(along, w.center.y + w.height / 2 - t / 2, w.width, t);
  add(along - w.width / 2 + t / 2, w.center.y, t, w.height);
  add(along + w.width / 2 - t / 2, w.center.y, t, w.height);
  // 桟: 縦 1 本・横 1 本
  add(along, w.center.y, t * 0.8, w.height);
  add(along, w.center.y + w.height * 0.1, w.width, t * 0.8);
}
