import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Mesh,
  PlaneGeometry,
  PointLight,
  Vector3,
} from 'three';
import { Batch, box, mulberry32 } from './geometry';
import { exteriorMaterial } from './materials';
import type { Photometry } from './photometry';
import type { OutdoorConditions, Situation } from './situation';

// 手続き生成のローポリ野山。中央 600m 四方を歩ける。湖・針葉樹林・岩・小屋とたき火、遠景に山脈。
const HALF = 300;
const NEAR_CELL = 4;
const FAR_HALF = 5000;
const FAR_CELL = 50;
const LAKE = new Vector3(70, 0, -90);

// ---------- 地形 ----------
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (valueNoise(x * f, z * f) * 2 - 1);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 地形の高さ [m] */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let h = fbm(x * 0.004, z * 0.004) * 35 + fbm(x * 0.02 + 7, z * 0.02 + 3, 3) * 4;
  // 湖の窪地
  h -= 22 * Math.exp(-((x - LAKE.x) ** 2 + (z - LAKE.z) ** 2) / (2 * 55 ** 2));
  // 遠くほど高い山脈 (尾根状のノイズ)
  const ridge = 1 - Math.abs(fbm(x * 0.0012 + 11, z * 0.0012 - 5, 5));
  h += smoothstep(280, 1400, r) * (120 + 900 * ridge * ridge);
  return h;
}

const WATER_LEVEL = terrainHeight(LAKE.x, LAKE.z) + 9;

const COLORS = {
  grass: new Color(0x6d8f3f),
  meadow: new Color(0x8a9a4a),
  forest: new Color(0x4d6b33),
  rock: new Color(0x7a7268),
  snow: new Color(0xe9eef2),
  sand: new Color(0xb9ab84),
};

/** 1 面ごとに色を付けた非インデックスの地形メッシュ (フラットシェーディングのローポリ表現) */
function terrainGeometry(half: number, cell: number, sink: (x: number, z: number) => number): BufferGeometry {
  const n = Math.round((2 * half) / cell);
  const pos: number[] = [];
  const col: number[] = [];
  const h = (i: number, j: number) => {
    const x = -half + i * cell;
    const z = -half + j * cell;
    return [x, terrainHeight(x, z) - sink(x, z), z];
  };
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const nrm = new Vector3();
  const tri = (p: number[], q: number[], r: number[]) => {
    a.fromArray(p);
    b.fromArray(q);
    c.fromArray(r);
    nrm.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const y = (p[1] + q[1] + r[1]) / 3;
    const v = hash2(p[0] * 0.37, p[2] * 0.37);
    let color: Color;
    if (y < WATER_LEVEL + 1.2) color = COLORS.sand;
    else if (y > 650 + v * 120 && nrm.y > 0.55) color = COLORS.snow;
    else if (nrm.y < 0.78) color = COLORS.rock;
    else if (y > 260) color = COLORS.forest;
    else color = v < 0.3 ? COLORS.meadow : COLORS.grass;
    const shade = 0.92 + v * 0.16;
    for (const p2 of [p, q, r]) {
      pos.push(...p2);
      col.push(color.r * shade, color.g * shade, color.b * shade);
    }
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p00 = h(i, j);
      const p10 = h(i + 1, j);
      const p01 = h(i, j + 1);
      const p11 = h(i + 1, j + 1);
      tri(p00, p01, p10);
      tri(p10, p01, p11);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// 夜の光: たき火 (~1,000 lm → 80 cd、炎 ~10,000 cd/m²)、ランタン、小屋の窓 ~30 cd/m²
const NIGHT = { fireCandela: 80, flame: 10_000, lanternCandela: 15, lantern: 20_000, cabinWindow: 30 };

export function createLandscape(seed = 11): Situation {
  const rand = mulberry32(seed);
  const root = new Group();
  const surfaceMat = exteriorMaterial({ vertexColors: true });

  const near = new Mesh(terrainGeometry(HALF + 20, NEAR_CELL, () => 0), surfaceMat);
  near.receiveShadow = true;
  near.castShadow = true;
  // 遠景は中央付近を沈めて近景と重ならないようにする
  const far = new Mesh(
    terrainGeometry(FAR_HALF, FAR_CELL, (x, z) => (Math.max(Math.abs(x), Math.abs(z)) < HALF + 120 ? 40 : 0)),
    surfaceMat,
  );
  far.receiveShadow = true;
  root.add(near, far);

  // 湖面
  const water = new Mesh(new PlaneGeometry(260, 260).rotateX(-Math.PI / 2), exteriorMaterial({ color: 0x2c4a5a }));
  water.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
  water.receiveShadow = true;
  root.add(water);

  const props = new Batch();
  // 針葉樹: 斜面が緩く、水辺から離れた所に、ノイズで群生させる
  let placed = 0;
  for (let i = 0; i < 9000 && placed < 1600; i++) {
    const x = (rand() * 2 - 1) * (HALF + 60);
    const z = (rand() * 2 - 1) * (HALF + 60);
    const y = terrainHeight(x, z);
    if (y < WATER_LEVEL + 2.5) continue;
    if (Math.hypot(x - CABIN.x, z - CABIN.z) < 22) continue;
    const slope = Math.abs(terrainHeight(x + 2, z) - y) + Math.abs(terrainHeight(x, z + 2) - y);
    if (slope > 2.2) continue;
    if (fbm(x * 0.012 + 3, z * 0.012 - 8, 3) < 0.05) continue;
    addConifer(props, x, y, z, 6 + rand() * 12, rand);
    placed++;
  }
  // 広葉樹と岩
  for (let i = 0; i < 160; i++) {
    const x = (rand() * 2 - 1) * HALF;
    const z = (rand() * 2 - 1) * HALF;
    const y = terrainHeight(x, z);
    if (y < WATER_LEVEL + 1.5 || Math.hypot(x - CABIN.x, z - CABIN.z) < 15) continue;
    if (rand() < 0.5) addDeciduous(props, x, y, z, 5 + rand() * 5, rand);
    else props.add(new DodecahedronGeometry(0.5 + rand() * 1.8, 0).scale(1, 0.7, 1).translate(x, y + 0.3, z), new Color(0x8a8378).multiplyScalar(0.8 + rand() * 0.3));
  }

  // 小屋
  const cabinY = terrainHeight(CABIN.x, CABIN.z);
  const cx = CABIN.x;
  const cz = CABIN.z;
  props.add(box(8, 0.5, 6, cx, cabinY + 0.25, cz), 0x6b5a48);
  props.add(box(7, 3, 5, cx, cabinY + 2, cz), 0x8b6a4a);
  // 切妻屋根
  const roof = new CylinderGeometry(3.4, 3.4, 8, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.55, 1.1);
  props.add(roof.translate(cx, cabinY + 4.6, cz), 0x5b3a2e);
  props.add(box(1.0, 2.0, 0.1, cx + 1.8, cabinY + 1.5, cz + 2.52), 0x4a3426);
  // 薪とたき火の石 (たき火は小屋と別の高さの地面に置く)
  const fireY = terrainHeight(FIRE.x, FIRE.z);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    props.add(new DodecahedronGeometry(0.22, 0).translate(FIRE.x + Math.cos(a) * 0.7, fireY + 0.1, FIRE.z + Math.sin(a) * 0.7), 0x6f6a62);
  }
  props.add(new CylinderGeometry(0.08, 0.08, 1.2, 5).rotateZ(Math.PI / 2).rotateY(0.6).translate(FIRE.x, fireY + 0.12, FIRE.z), 0x4a3426);
  props.add(new CylinderGeometry(0.08, 0.08, 1.2, 5).rotateZ(Math.PI / 2).rotateY(-0.7).translate(FIRE.x, fireY + 0.16, FIRE.z), 0x4a3426);
  // 丸太のベンチ
  props.add(new CylinderGeometry(0.22, 0.22, 2, 6).rotateZ(Math.PI / 2).translate(FIRE.x, fireY + 0.22, FIRE.z + 2.2), 0x6b4f35);

  const mesh = props.build(surfaceMat);
  if (mesh) root.add(mesh);

  // 発光体
  const cabinWindow = exteriorMaterial({ color: 0x1d1a16, emissive: 0xffb877 });
  const flame = exteriorMaterial({ color: 0x331100, emissive: 0xff8a2a });
  const lanternGlass = exteriorMaterial({ color: 0x333333, emissive: 0xffc070 });
  for (const dx of [-1.6, 0.2]) {
    root.add(new Mesh(new PlaneGeometry(1.1, 0.9).translate(cx + dx, cabinY + 2.0, cz + 2.53), cabinWindow));
  }
  root.add(new Mesh(new PlaneGeometry(1.1, 0.9).rotateY(Math.PI / 2).translate(cx + 3.53, cabinY + 2.0, cz), cabinWindow));
  root.add(new Mesh(new ConeGeometry(0.35, 0.9, 5).translate(FIRE.x, fireY + 0.6, FIRE.z), flame));
  root.add(new Mesh(new IcosahedronGeometry(0.12, 0).translate(cx + 3, cabinY + 2.4, cz + 2.7), lanternGlass));

  const fire = new PointLight(0xff9a45, 1, 60, 2);
  fire.position.set(FIRE.x, fireY + 0.8, FIRE.z);
  fire.castShadow = false;
  const lantern = new PointLight(0xffc070, 1, 25, 2);
  lantern.position.set(cx + 3, cabinY + 2.3, cz + 2.9);
  root.add(fire, lantern);

  function setWeather(c: OutdoorConditions, p: Photometry): void {
    const night = c.weather === 'night';
    p.setEmissive(cabinWindow, night ? NIGHT.cabinWindow : 0);
    p.setEmissive(flame, night ? NIGHT.flame : 0);
    p.setEmissive(lanternGlass, night ? NIGHT.lantern : 0);
    fire.visible = lantern.visible = night;
    flame.visible = night;
    p.setLight(fire, night ? NIGHT.fireCandela : 0);
    p.setLight(lantern, night ? NIGHT.lanternCandela : 0);
  }

  const startX = FIRE.x - 4;
  const startZ = FIRE.z + 6;
  return {
    root,
    bounds: { min: new Vector3(-HALF, -50, -HALF), max: new Vector3(HALF, 600, HALF), ground: terrainHeight },
    // たき火越しに湖と山を望む
    start: { position: new Vector3(startX, terrainHeight(startX, startZ) + 1.6, startZ), yaw: 0.55, pitch: -0.05, focus: 7, focal: 24 },
    shadow: { center: new Vector3(CABIN.x + 40, 0, CABIN.z - 60), extent: 260 },
    nightSky: 'rural',
    setWeather,
    update: () => {},
  };
}

const CABIN = new Vector3(-30, 0, 60);
const FIRE = new Vector3(-24, 0, 66);

function addConifer(batch: Batch, x: number, y: number, z: number, h: number, rand: () => number): void {
  batch.add(new CylinderGeometry(0.12 * h * 0.08 + 0.1, 0.2 * h * 0.08 + 0.12, h * 0.25, 5).translate(x, y + h * 0.12, z), 0x5a4030);
  const green = new Color(0x2f5a2e).multiplyScalar(0.75 + rand() * 0.4);
  batch.add(new ConeGeometry(h * 0.24, h * 0.55, 6).translate(x, y + h * 0.45, z), green);
  batch.add(new ConeGeometry(h * 0.17, h * 0.45, 6).translate(x, y + h * 0.75, z), green);
}

function addDeciduous(batch: Batch, x: number, y: number, z: number, h: number, rand: () => number): void {
  batch.add(new CylinderGeometry(0.15, 0.22, h * 0.5, 5).translate(x, y + h * 0.25, z), 0x6b4f35);
  batch.add(new IcosahedronGeometry(h * 0.32, 0).translate(x, y + h * 0.65, z), new Color(0x5f8a3a).multiplyScalar(0.8 + rand() * 0.35));
}
