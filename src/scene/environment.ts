import { BackSide, DirectionalLight, Mesh, type Scene, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { ambientUniforms } from './materials';
import { Photometry } from './photometry';
import type { NightSky, OutdoorConditions, Weather } from './situation';

type RGB = [number, number, number];

// 屋外の光 (直射光・天空・空の見た目) の物理値
//   晴天: 太陽 直射 ~90,000 lx, 天空 ~15,000 lx, 青空の輝度 ~3,000〜8,000 cd/m², 太陽面 ~1.6e9 cd/m²
//   曇天: 天空 ~6,000 lx (CIE 曇天空: 天頂は地平の約 3 倍の輝度)
//   夜  : 都市は光害で空がやや明るく月なし。郊外は月明かり ~0.2 lx (月面 ~2,500 cd/m²) と星
interface OutdoorSpec {
  directLux: number;
  directDir: Vector3;
  directColor: RGB;
  /** 半球光 [lx] (上向き面 / 下向き面が受ける照度) */
  skyLux: RGB;
  groundLux: RGB;
  zenith: RGB;
  horizon: RGB;
  sunDisk: number;
  moonDisk: number;
  stars: number;
}

const SUN_DIRECTION = new Vector3(-0.55, 0.62, -0.56).normalize();
const MOON_DIRECTION = new Vector3(0.5, 0.45, -0.75).normalize();

function outdoorSpec(w: Weather, night: NightSky): OutdoorSpec {
  const none = { directLux: 0, directDir: SUN_DIRECTION, directColor: [1, 1, 1] as RGB, sunDisk: 0, moonDisk: 0, stars: 0 };
  if (w === 'sunny') {
    return {
      ...none,
      directLux: 90_000,
      directColor: [1, 0.96, 0.91],
      skyLux: [11_000, 14_000, 19_000],
      groundLux: [9_000, 8_500, 7_500],
      zenith: [1_800, 3_200, 6_500],
      horizon: [6_500, 7_500, 9_000],
      sunDisk: 1.6e9,
    };
  }
  if (w === 'overcast') {
    return {
      ...none,
      skyLux: [6_000, 6_300, 6_700],
      groundLux: [1_300, 1_250, 1_150],
      zenith: [3_000, 3_100, 3_300],
      horizon: [1_000, 1_050, 1_100],
    };
  }
  if (night === 'urban') {
    return {
      ...none,
      skyLux: [0.03, 0.035, 0.05],
      groundLux: [0.25, 0.18, 0.12],
      zenith: [0.002, 0.003, 0.006],
      horizon: [0.04, 0.025, 0.015],
    };
  }
  return {
    ...none,
    directLux: 0.2,
    directDir: MOON_DIRECTION,
    directColor: [0.9, 0.95, 1.0],
    skyLux: [0.006, 0.008, 0.014],
    groundLux: [0.004, 0.004, 0.004],
    zenith: [0.0008, 0.0012, 0.0025],
    horizon: [0.002, 0.0025, 0.004],
    moonDisk: 2_500,
    stars: 1,
  };
}

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // 常に遠平面
}`;

const skyFragment = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform float uSunDisk;
uniform vec3 uMoonDir;
uniform float uMoonDisk;
uniform float uStars;
uniform float uPreExposure;
varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 L = mix(uHorizon, uZenith, pow(h, 0.5));
  // 地平線より下は地面の照り返し程度
  if (d.y < 0.0) L = uHorizon * 0.3;
  float cosSun = dot(d, uSunDir);
  // 太陽周辺のグロー
  L += uSunDisk * 4e-6 * pow(max(cosSun, 0.0), 200.0) * vec3(1.0, 0.95, 0.85);
  // 太陽面・月面 (視直径 0.53°)
  if (cosSun > 0.99996) L += uSunDisk * vec3(1.0, 0.97, 0.92);
  if (dot(d, uMoonDir) > 0.99996) L += uMoonDisk * vec3(0.95, 0.95, 1.0);
  // 星: 方向をセルに分け、まれなセルの中心付近だけ光らせる (視直径 ~0.03°)
  if (uStars > 0.0 && d.y > 0.02) {
    vec3 cell = floor(d * 400.0);
    float r = hash13(cell);
    if (r > 0.985) {
      vec3 center = (cell + 0.5 + (vec3(hash13(cell + 1.0), hash13(cell + 2.0), hash13(cell + 3.0)) - 0.5) * 0.6) / 400.0;
      if (length(d - center) < 0.00025) L += uStars * pow(10.0, (r - 0.985) / 0.015 * 3.0) * vec3(0.9, 0.95, 1.0);
    }
  }
  // half float の上限に収める (どの露出でも白飛びする値)
  gl_FragColor = vec4(min(L * uPreExposure, vec3(60000.0)), 1.0);
}`;

/** 屋外の光 (太陽 or 月・天空光・空) を管理する。シチュエーション固有の光源は各 Situation が持つ */
export class Environment {
  readonly photometry = new Photometry();
  private direct: DirectionalLight;
  private sky: ShaderMaterial;
  private directDir = SUN_DIRECTION;
  private shadowCenter = new Vector3();
  private shadowExtent = 170;

  constructor(scene: Scene) {
    this.direct = new DirectionalLight(0xffffff, 1);
    this.direct.castShadow = true;
    this.direct.shadow.mapSize.set(4096, 4096);
    this.direct.shadow.bias = -0.0004;
    this.direct.shadow.normalBias = 0.05;
    scene.add(this.direct, this.direct.target);

    this.sky = new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new Vector3() },
        uHorizon: { value: new Vector3() },
        uSunDir: { value: SUN_DIRECTION.clone() },
        uSunDisk: { value: 0 },
        uMoonDir: { value: MOON_DIRECTION.clone() },
        uMoonDisk: { value: 0 },
        uStars: { value: 0 },
        uPreExposure: { value: 1 },
      },
    });
    const skyMesh = new Mesh(new SphereGeometry(4000, 32, 16), this.sky);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = -1;
    scene.add(skyMesh);
    this.photometry.addSky(this.sky);
  }

  /** 影を計算する範囲 (平行投影の影カメラ) を設定 */
  setShadowArea(center: Vector3, extent: number): void {
    const cam = this.direct.shadow.camera;
    cam.left = cam.bottom = -extent;
    cam.right = cam.top = extent;
    cam.near = 1;
    cam.far = extent * 4;
    cam.updateProjectionMatrix();
    this.shadowCenter.copy(center);
    this.shadowExtent = extent;
    this.aimDirect();
  }

  setWeather(w: Weather, night: NightSky): OutdoorConditions {
    const s = outdoorSpec(w, night);
    const p = this.photometry;
    this.direct.visible = s.directLux > 0;
    this.direct.color.setRGB(...s.directColor);
    this.directDir = s.directDir;
    this.aimDirect();
    p.setLight(this.direct, s.directLux);
    p.setVector(ambientUniforms.exterior.up, s.skyLux);
    p.setVector(ambientUniforms.exterior.down, s.groundLux);
    const u = this.sky.uniforms;
    u.uZenith.value.set(...s.zenith);
    u.uHorizon.value.set(...s.horizon);
    u.uSunDisk.value = s.sunDisk;
    u.uMoonDisk.value = s.moonDisk;
    u.uStars.value = s.stars;

    const mean = (c: RGB) => (c[0] + c[1] + c[2]) / 3;
    return {
      weather: w,
      directLux: s.directLux,
      directDir: s.directDir.clone(),
      // 水平に見える景色 ≈ 地平付近の空と、照らされた地面 (輝度 = 照度 / π) の半々
      horizontalLuminance: 0.5 * mean(s.horizon) + (0.5 * mean(s.groundLux)) / Math.PI,
    };
  }

  /** 直射光を影の範囲の中心に向ける */
  private aimDirect(): void {
    this.direct.position.copy(this.shadowCenter).addScaledVector(this.directDir, this.shadowExtent * 2);
    this.direct.target.position.copy(this.shadowCenter);
    this.direct.target.updateMatrixWorld();
  }
}
