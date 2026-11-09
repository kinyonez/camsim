import { BoxGeometry, Color, ConeGeometry, CylinderGeometry, Group, Mesh, type MeshLambertMaterial, PlaneGeometry, PointLight, Vector3 } from 'three';
import { Batch, box, mulberry32 } from './geometry';
import { exteriorMaterial } from './materials';
import type { Photometry } from './photometry';
import type { OutdoorConditions, Situation } from './situation';

// 手続き生成のローポリ都市。1 unit = 1 m。
// 道路は 50m 間隔の格子、街区は 38m 角。描画コールを減らすため、同じマテリアルの部品は頂点カラー付きで結合する。

export const CITY_HALF = 150;
const ROAD_SPACING = 50;
const ROAD_WIDTH = 12;
const BLOCK = ROAD_SPACING - ROAD_WIDTH;
const LAMP_HEIGHT = 8;
/** 実光源 (PointLight) を置く街灯の範囲。forward レンダリングなので数を絞る */
const LIT_LAMP_RANGE = 50;

export interface CityMaterials {
  /** 昼夜共通の拡散反射面 */
  surface: MeshLambertMaterial;
  windowWarm: MeshLambertMaterial;
  windowCool: MeshLambertMaterial;
  windowDark: MeshLambertMaterial;
  lampHead: MeshLambertMaterial;
  neonPink: MeshLambertMaterial;
  neonCyan: MeshLambertMaterial;
  headlight: MeshLambertMaterial;
  taillight: MeshLambertMaterial;
}

interface Car {
  group: Group;
  axis: 'x' | 'z';
  lane: number;
  dir: 1 | -1;
  speed: number;
  phase: number;
}

// 夜の発光体・街灯の物理値: 街灯 ~1,500 cd (直下 8m で ~20 lx), 点灯した窓 ~50 cd/m², ネオン ~800 cd/m²
const NIGHT = {
  windowWarm: 60,
  windowCool: 40,
  lampHead: 40_000,
  lampCandela: 1_500,
  neon: 800,
  headlight: 80_000,
  taillight: 1_500,
};

const PALETTE = ['#b9a48c', '#9c8f84', '#c8bfae', '#8a9196', '#a7765f', '#d6cdb8', '#7f8a7a', '#b5876b', '#9aa3ab'].map(
  (c) => new Color(c),
);
const CAR_COLORS = ['#c0392b', '#2c3e50', '#ecf0f1', '#f1c40f', '#2980b9', '#7f8c8d', '#16a085'].map((c) => new Color(c));

export function createCity(seed = 7): Situation {
  const rand = mulberry32(seed);
  const root = new Group();

  const materials: CityMaterials = {
    surface: exteriorMaterial({ vertexColors: true }),
    windowWarm: exteriorMaterial({ color: 0x1a1f26, emissive: 0xffc98a }),
    windowCool: exteriorMaterial({ color: 0x1a1f26, emissive: 0xdde8ff }),
    windowDark: exteriorMaterial({ color: 0x1a1f26 }),
    lampHead: exteriorMaterial({ color: 0xdddddd, emissive: 0xffd9a0 }),
    neonPink: exteriorMaterial({ color: 0x553344, emissive: 0xff3399 }),
    neonCyan: exteriorMaterial({ color: 0x335555, emissive: 0x33e0ff }),
    headlight: exteriorMaterial({ color: 0xdddddd, emissive: 0xfff4e0 }),
    taillight: exteriorMaterial({ color: 0x661111, emissive: 0xff1a0a }),
  };

  const surface = new Batch();
  const windows = { warm: new Batch(), cool: new Batch(), dark: new Batch() };
  const lampHeads = new Batch();
  const neon = { pink: new Batch(), cyan: new Batch() };

  // 地面（範囲外まで広げて地平線を作る）と道路
  surface.add(new PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), 0x6f7a55);
  const roadCount = (2 * CITY_HALF) / ROAD_SPACING + 1;
  const roadLen = 2 * CITY_HALF + 40;
  for (let i = 0; i < roadCount; i++) {
    const c = -CITY_HALF + i * ROAD_SPACING;
    surface.add(box(ROAD_WIDTH, 0.04, roadLen, c, 0.02, 0), 0x56595d);
    surface.add(box(roadLen, 0.045, ROAD_WIDTH, 0, 0.0225, c), 0x56595d);
    // 中央線
    surface.add(box(0.15, 0.05, roadLen, c, 0.03, 0), 0xd8d0b0);
    surface.add(box(roadLen, 0.055, 0.15, 0, 0.03, c), 0xd8d0b0);
  }

  const blockCenters: number[] = [];
  for (let i = 0; i < roadCount - 1; i++) blockCenters.push(-CITY_HALF + ROAD_SPACING / 2 + i * ROAD_SPACING);

  for (const bx of blockCenters) {
    for (const bz of blockCenters) {
      // 歩道（縁石の段差付き）
      surface.add(box(BLOCK, 0.15, BLOCK, bx, 0.075, bz), 0xa9a49a);
      const isPark = (bx === -25 && bz === -25) || (bx === 75 && bz === 25);
      if (isPark) {
        surface.add(box(BLOCK - 4, 0.2, BLOCK - 4, bx, 0.1, bz), 0x5f8a45);
        for (let t = 0; t < 14; t++) addTree(surface, bx + (rand() - 0.5) * (BLOCK - 8), bz + (rand() - 0.5) * (BLOCK - 8), rand);
        continue;
      }
      // 都心ほど高い建物
      const downtown = 1 - Math.min(1, Math.hypot(bx, bz) / 180);
      const lots = rand() < 0.35 ? [[0, 0, 1, 1]] : [[-0.5, -0.5, 0.5, 0.5], [0.5, -0.5, 0.5, 0.5], [-0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
      for (const [ox, oz, sx, sz] of lots) {
        if (lots.length > 1 && rand() < 0.15) continue; // 空き地
        const usable = BLOCK - 5;
        const w = usable * sx - 2 - rand() * 3;
        const d = usable * sz - 2 - rand() * 3;
        const h = 6 + rand() * (12 + 55 * downtown * downtown);
        const x = bx + (ox * usable) / 2;
        const z = bz + (oz * usable) / 2;
        addBuilding(x, z, w, d, h);
      }
    }
  }

  function addBuilding(x: number, z: number, w: number, d: number, h: number): void {
    const color = PALETTE[Math.floor(rand() * PALETTE.length)].clone().multiplyScalar(0.85 + rand() * 0.3);
    surface.add(box(w, h, d, x, 0.15 + h / 2, z), color);
    // 屋上設備
    surface.add(box(w * 0.3, 1.5 + rand() * 2, d * 0.3, x + (rand() - 0.5) * w * 0.4, 0.15 + h + 1, z + (rand() - 0.5) * d * 0.4), 0x8d8d8d);

    // 窓: 階高 3.2m, 水平 3m 間隔
    const litRatio = 0.25 + rand() * 0.35;
    const floors = Math.floor((h - 1.5) / 3.2);
    const faces: { nx: number; nz: number; len: number }[] = [
      { nx: 1, nz: 0, len: d },
      { nx: -1, nz: 0, len: d },
      { nx: 0, nz: 1, len: w },
      { nx: 0, nz: -1, len: w },
    ];
    for (const f of faces) {
      const cols = Math.floor((f.len - 2) / 3);
      for (let fl = 0; fl < floors; fl++) {
        const y = 0.15 + 2 + fl * 3.2;
        for (let c = 0; c < cols; c++) {
          const t = (c - (cols - 1) / 2) * 3;
          const geo = new PlaneGeometry(1.5, 1.7);
          const px = x + f.nx * (w / 2 + 0.03) + (f.nz !== 0 ? t : 0);
          const pz = z + f.nz * (d / 2 + 0.03) + (f.nx !== 0 ? t : 0);
          geo.rotateY(Math.atan2(f.nx, f.nz)).translate(px, y, pz);
          const r = rand();
          if (r < litRatio * 0.7) windows.warm.add(geo, 0xffffff);
          else if (r < litRatio) windows.cool.add(geo, 0xffffff);
          else windows.dark.add(geo, 0xffffff);
        }
      }
      // ネオン看板
      if (h > 12 && rand() < 0.12) {
        const geo = new BoxGeometry(f.nx !== 0 ? 0.3 : 4, 1.2, f.nx !== 0 ? 4 : 0.3);
        geo.translate(x + f.nx * (w / 2 + 0.2), 6 + rand() * 4, z + f.nz * (d / 2 + 0.2));
        (rand() < 0.5 ? neon.pink : neon.cyan).add(geo, 0xffffff);
      }
    }
  }

  // 街灯: 道路沿いに 25m 間隔、片側交互
  const lampLights: PointLight[] = [];
  for (let i = 0; i < roadCount; i++) {
    const c = -CITY_HALF + i * ROAD_SPACING;
    for (let s = -CITY_HALF + 12.5; s < CITY_HALF; s += 25) {
      const side = Math.round((s + CITY_HALF) / 25) % 2 === 0 ? 1 : -1;
      for (const axis of ['x', 'z'] as const) {
        const off = side * (ROAD_WIDTH / 2 + 0.8);
        const px = axis === 'z' ? c + off : s;
        const pz = axis === 'z' ? s : c + off;
        const armDx = axis === 'z' ? -side * 1.2 : 0;
        const armDz = axis === 'x' ? -side * 1.2 : 0;
        surface.add(new CylinderGeometry(0.09, 0.12, LAMP_HEIGHT, 6).translate(px, LAMP_HEIGHT / 2, pz), 0x44484c);
        surface.add(box(Math.abs(armDx) + 0.1, 0.1, Math.abs(armDz) + 0.1, px + armDx / 2, LAMP_HEIGHT, pz + armDz / 2), 0x44484c);
        lampHeads.add(box(0.6, 0.15, 0.35, px + armDx, LAMP_HEIGHT - 0.1, pz + armDz), 0xffffff);
        if (Math.abs(px) < LIT_LAMP_RANGE && Math.abs(pz) < LIT_LAMP_RANGE && Math.abs(c) <= 50) {
          const light = new PointLight(0xffc27a, 1, 70, 2);
          light.position.set(px + armDx, LAMP_HEIGHT - 0.4, pz + armDz);
          lampLights.push(light);
          root.add(light);
        }
      }
    }
  }

  // 街路樹
  for (let i = 0; i < 60; i++) {
    const road = -CITY_HALF + Math.floor(rand() * roadCount) * ROAD_SPACING;
    const along = (rand() - 0.5) * 2 * CITY_HALF;
    const side = rand() < 0.5 ? 1 : -1;
    const off = side * (ROAD_WIDTH / 2 + 2.5);
    if (rand() < 0.5) addTree(surface, road + off, along, rand);
    else addTree(surface, along, road + off, rand);
  }

  for (const mesh of [
    surface.build(materials.surface),
    windows.warm.build(materials.windowWarm, false),
    windows.cool.build(materials.windowCool, false),
    windows.dark.build(materials.windowDark, false),
    lampHeads.build(materials.lampHead, false),
    neon.pink.build(materials.neonPink, false),
    neon.cyan.build(materials.neonCyan, false),
  ]) {
    if (mesh) root.add(mesh);
  }

  // 車
  const cars: Car[] = [];
  const carRoads = [-50, 0, 50];
  for (let i = 0; i < 18; i++) {
    const axis = i % 2 === 0 ? 'x' : 'z';
    const dir = rand() < 0.5 ? 1 : -1;
    const road = carRoads[Math.floor(rand() * carRoads.length)];
    const car: Car = { group: createCar(materials, CAR_COLORS[i % CAR_COLORS.length]), axis, lane: road - dir * 3, dir, speed: 8 + rand() * 6, phase: rand() * 400 };
    // 車体は +x 向きでモデリングしている
    car.group.rotation.y = axis === 'x' ? (dir === 1 ? 0 : Math.PI) : dir === 1 ? -Math.PI / 2 : Math.PI / 2;
    cars.push(car);
    root.add(car.group);
  }

  const span = 2 * CITY_HALF + 40;
  function update(timeSec: number): void {
    for (const car of cars) {
      const s = ((((car.phase + car.speed * timeSec) % span) + span) % span) - span / 2;
      const p = s * car.dir;
      if (car.axis === 'x') car.group.position.set(p, 0, car.lane);
      else car.group.position.set(car.lane, 0, p);
    }
  }
  update(0);

  function setWeather(c: OutdoorConditions, p: Photometry): void {
    const night = c.weather === 'night';
    const m = materials;
    p.setEmissive(m.windowWarm, night ? NIGHT.windowWarm : 0);
    p.setEmissive(m.windowCool, night ? NIGHT.windowCool : 0);
    p.setEmissive(m.lampHead, night ? NIGHT.lampHead : 0);
    // ネオンは曇りの昼も点灯
    const neon = c.weather === 'sunny' ? 0 : night ? NIGHT.neon : NIGHT.neon * 0.4;
    p.setEmissive(m.neonPink, neon);
    p.setEmissive(m.neonCyan, neon);
    p.setEmissive(m.headlight, night ? NIGHT.headlight : 0);
    p.setEmissive(m.taillight, night ? NIGHT.taillight : 0);
    for (const l of lampLights) {
      l.visible = night;
      p.setLight(l, night ? NIGHT.lampCandela : 0);
    }
  }

  return {
    root,
    bounds: { min: new Vector3(-CITY_HALF, 0.3, -CITY_HALF), max: new Vector3(CITY_HALF, 150, CITY_HALF) },
    start: { position: new Vector3(3, 1.6, 40), yaw: 0, pitch: 0, focus: 12, focal: 35 },
    shadow: { center: new Vector3(0, 0, 0), extent: 170 },
    nightSky: 'urban',
    setWeather,
    update,
  };
}

function addTree(batch: Batch, x: number, z: number, rand: () => number): void {
  const h = 4 + rand() * 4;
  batch.add(new CylinderGeometry(0.15, 0.22, h * 0.4, 5).translate(x, h * 0.2, z), 0x6b4f35);
  batch.add(new ConeGeometry(h * 0.28, h * 0.75, 6).translate(x, h * 0.4 + h * 0.36, z), new Color(0x3f6b34).multiplyScalar(0.8 + rand() * 0.4));
}

function createCar(m: CityMaterials, color: Color): Group {
  const g = new Group();
  const body = new Mesh(new BoxGeometry(4.3, 0.8, 1.8).translate(0, 0.65, 0), exteriorMaterial({ color }));
  const cabin = new Mesh(new BoxGeometry(2.2, 0.6, 1.6).translate(-0.3, 1.35, 0), exteriorMaterial({ color: 0x2a3138 }));
  for (const mesh of [body, cabin]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  for (const z of [-0.6, 0.6]) {
    g.add(new Mesh(new BoxGeometry(0.05, 0.18, 0.35).translate(2.16, 0.8, z), m.headlight));
    g.add(new Mesh(new BoxGeometry(0.05, 0.15, 0.3).translate(-2.16, 0.85, z), m.taillight));
  }
  return g;
}
