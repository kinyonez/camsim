import { BackSide, DirectionalLight, HemisphereLight, Mesh, type Scene, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import type { City } from './city';
import { Photometry } from './photometry';

export type Weather = 'sunny' | 'overcast' | 'night';

export const WEATHER_LABELS: Record<Weather, string> = {
  sunny: '晴れた昼',
  overcast: '曇りの昼',
  night: '夜',
};

type RGB = [number, number, number];

// 物理値の目安
//   晴天: 太陽 直射 ~90,000 lx, 天空 ~15,000 lx, 青空の輝度 ~3,000〜8,000 cd/m², 太陽面 ~1.6e9 cd/m²
//   曇天: 天空 ~6,000 lx (CIE 曇天空: 天頂は地平の約 3 倍の輝度)
//   夜  : 街灯 ~1,500 cd (直下 8m で ~20 lx), 点灯した窓 ~50 cd/m², 夜空 ~0.003〜0.03 cd/m²
interface WeatherSpec {
  sunLux: number;
  /** 半球光 [lx] (上向き面 / 下向き面が受ける照度) */
  skyLux: RGB;
  groundLux: RGB;
  zenith: RGB;
  horizon: RGB;
  sunDisk: number;
  windowWarm: number;
  windowCool: number;
  lampHead: number;
  lampCandela: number;
  neon: number;
  headlight: number;
  taillight: number;
}

const SPECS: Record<Weather, WeatherSpec> = {
  sunny: {
    sunLux: 90_000,
    skyLux: [11_000, 14_000, 19_000],
    groundLux: [9_000, 8_500, 7_500],
    zenith: [1_800, 3_200, 6_500],
    horizon: [6_500, 7_500, 9_000],
    sunDisk: 1.6e9,
    windowWarm: 0,
    windowCool: 0,
    lampHead: 0,
    lampCandela: 0,
    neon: 0,
    headlight: 0,
    taillight: 0,
  },
  overcast: {
    sunLux: 0,
    skyLux: [6_000, 6_300, 6_700],
    groundLux: [1_300, 1_250, 1_150],
    zenith: [3_000, 3_100, 3_300],
    horizon: [1_000, 1_050, 1_100],
    sunDisk: 0,
    windowWarm: 0,
    windowCool: 0,
    lampHead: 0,
    lampCandela: 0,
    neon: 300,
    headlight: 0,
    taillight: 0,
  },
  night: {
    sunLux: 0,
    skyLux: [0.03, 0.035, 0.05],
    groundLux: [0.25, 0.18, 0.12],
    zenith: [0.002, 0.003, 0.006],
    horizon: [0.04, 0.025, 0.015],
    sunDisk: 0,
    windowWarm: 60,
    windowCool: 40,
    lampHead: 40_000,
    lampCandela: 1_500,
    neon: 800,
    headlight: 80_000,
    taillight: 1_500,
  },
};

const SUN_DIRECTION = new Vector3(-0.55, 0.62, -0.56).normalize();

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
uniform float uPreExposure;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 L = mix(uHorizon, uZenith, pow(h, 0.5));
  // 地平線より下は地面の照り返し程度
  if (d.y < 0.0) L = uHorizon * 0.3;
  float cosSun = dot(d, uSunDir);
  // 太陽周辺のグロー (晴天のみ)
  L += uSunDisk * 4e-6 * pow(max(cosSun, 0.0), 200.0) * vec3(1.0, 0.95, 0.85);
  // 太陽面 (視直径 0.53°)
  if (cosSun > 0.99996) L += uSunDisk * vec3(1.0, 0.97, 0.92);
  // half float の上限に収める (どの露出でも白飛びする値)
  gl_FragColor = vec4(min(L * uPreExposure, vec3(60000.0)), 1.0);
}`;

export class Environment {
  readonly photometry = new Photometry();
  private sun: DirectionalLight;
  private hemi: HemisphereLight;
  private sky: ShaderMaterial;

  constructor(
    scene: Scene,
    private city: City,
  ) {
    this.sun = new DirectionalLight(0xfff4e8, 1);
    this.sun.position.copy(SUN_DIRECTION).multiplyScalar(300);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -170;
    cam.right = cam.top = 170;
    cam.near = 10;
    cam.far = 700;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);

    // 色に照度 [lx] を直接入れ、intensity には pre-exposure だけを掛ける
    this.hemi = new HemisphereLight(0xffffff, 0xffffff, 1);
    scene.add(this.hemi);

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
        uPreExposure: { value: 1 },
      },
    });
    const skyMesh = new Mesh(new SphereGeometry(2500, 32, 16), this.sky);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = -1;
    scene.add(skyMesh);

    const m = city.materials;
    const p = this.photometry;
    p.addLight(this.sun, 0);
    p.addLight(this.hemi, 1);
    p.addSky(this.sky);
    for (const mat of [m.windowWarm, m.windowCool, m.lampHead, m.neonPink, m.neonCyan, m.headlight, m.taillight]) p.addEmissive(mat, 0);
    for (const l of city.lampLights) p.addLight(l, 0);
  }

  setWeather(w: Weather): void {
    const s = SPECS[w];
    const p = this.photometry;
    const m = this.city.materials;
    this.sun.visible = s.sunLux > 0;
    p.setBase(this.sun, s.sunLux);
    this.hemi.color.setRGB(...s.skyLux);
    this.hemi.groundColor.setRGB(...s.groundLux);
    this.sky.uniforms.uZenith.value.set(...s.zenith);
    this.sky.uniforms.uHorizon.value.set(...s.horizon);
    this.sky.uniforms.uSunDisk.value = s.sunDisk;
    p.setBase(m.windowWarm, s.windowWarm);
    p.setBase(m.windowCool, s.windowCool);
    p.setBase(m.lampHead, s.lampHead);
    p.setBase(m.neonPink, s.neon);
    p.setBase(m.neonCyan, s.neon);
    p.setBase(m.headlight, s.headlight);
    p.setBase(m.taillight, s.taillight);
    for (const l of this.city.lampLights) {
      l.visible = s.lampCandela > 0;
      p.setBase(l, s.lampCandela);
    }
  }
}
