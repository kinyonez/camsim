import {
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { NoiseParams } from '../camera/sensor';
import { accumulateFragment, dofFragment, fullscreenVertex, meterFragment, sensorFragment } from './shaders';

const DOF_MAX_RADIUS_PX = 48;
const DOF_MAX_SAMPLES = 320;
export const METER_WIDTH = 96;
export const METER_HEIGHT = 64;

export interface DofParams {
  /** 錯乱円半径 [px] = cocScale · (1/S − 1/d) */
  cocScale: number;
  focusM: number;
}

export interface DevelopParams {
  noise: NoiseParams;
  enableNoise: boolean;
  averaging: number;
  pushEV: number;
  zebra: boolean;
  seed: number;
}

function material(fragmentShader: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({ vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

/**
 * シーン (物理輝度 × pre-exposure) → [DoF or 累積] → センサー/現像 → 画面
 */
export class CameraPipeline {
  private sceneTarget: WebGLRenderTarget;
  private dofTarget: WebGLRenderTarget;
  private accum: [WebGLRenderTarget, WebGLRenderTarget];
  private meterTarget: WebGLRenderTarget;
  private quad = new FullScreenQuad();
  private dofMat: ShaderMaterial;
  private accumMat: ShaderMaterial;
  private sensorMat: ShaderMaterial;
  private meterMat: ShaderMaterial;
  private accumCount = 0;
  readonly meterPixels = new Float32Array(METER_WIDTH * METER_HEIGHT * 4);

  constructor(private renderer: WebGLRenderer) {
    this.sceneTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthTexture: new DepthTexture(1, 1) });
    this.dofTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    // 累積は精度が要るので float32 (ブレンド不要の ping-pong なので EXT_float_blend は不要)
    const accumOpts = { type: FloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter } as const;
    this.accum = [new WebGLRenderTarget(1, 1, accumOpts), new WebGLRenderTarget(1, 1, accumOpts)];
    this.meterTarget = new WebGLRenderTarget(METER_WIDTH, METER_HEIGHT, { type: FloatType, depthBuffer: false, minFilter: LinearFilter });

    this.dofMat = material(dofFragment, {
      tColor: { value: this.sceneTarget.texture },
      tDepth: { value: this.sceneTarget.depthTexture },
      uTexel: { value: new Vector2() },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uCocScale: { value: 0 },
      uInvFocus: { value: 0.1 },
      uMaxRadius: { value: 0 },
      uRadScale: { value: 0.5 },
    });
    this.accumMat = material(accumulateFragment, { tPrev: { value: null }, tNew: { value: this.sceneTarget.texture }, uWeight: { value: 1 } });
    this.sensorMat = material(sensorFragment, {
      tRaw: { value: null },
      uElectronsAtWhite: { value: 1 },
      uFullWell: { value: 1 },
      uReadNoise: { value: 0 },
      uElectronsPerDN: { value: 1 },
      uAveraging: { value: 1 },
      uNoise: { value: true },
      uSeed: { value: 0 },
      uPushEV: { value: 0 },
      uZebra: { value: false },
    });
    this.meterMat = material(meterFragment, { tRaw: { value: null } });
  }

  setSize(width: number, height: number): void {
    this.sceneTarget.setSize(width, height);
    this.dofTarget.setSize(width, height);
    for (const t of this.accum) t.setSize(width, height);
    this.dofMat.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.accumCount = 0;
  }

  /** プレビュー: 1 回描画 + gather DoF。結果は RAW 期待値のバッファ */
  renderPreview(scene: Scene, camera: PerspectiveCamera, dof: DofParams): WebGLRenderTarget {
    this.renderScene(scene, camera);
    const u = this.dofMat.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uCocScale.value = dof.cocScale;
    u.uInvFocus.value = 1 / dof.focusM;
    // 最大錯乱円 (無限遠と近接 0.5m のうち大きい方) に合わせてサンプル間隔を決め、反復回数を抑える
    const maxCoc = Math.max(Math.abs(dof.cocScale / dof.focusM), Math.abs(dof.cocScale * (1 / dof.focusM - 1 / 0.5)));
    const maxRadius = Math.min(maxCoc, DOF_MAX_RADIUS_PX);
    u.uMaxRadius.value = maxRadius;
    u.uRadScale.value = Math.max(0.5, (maxRadius * maxRadius) / (2 * DOF_MAX_SAMPLES));
    this.pass(this.dofMat, this.dofTarget);
    return this.dofTarget;
  }

  resetAccumulation(): void {
    this.accumCount = 0;
  }

  get accumulatedSamples(): number {
    return this.accumCount;
  }

  /** 撮影: レンズ位置・時刻をずらしたカメラで 1 サンプル描画し平均に加える */
  accumulate(scene: Scene, camera: PerspectiveCamera): WebGLRenderTarget {
    this.renderScene(scene, camera);
    const [prev, next] = this.accum;
    this.accumMat.uniforms.tPrev.value = prev.texture;
    this.accumMat.uniforms.uWeight.value = 1 / (this.accumCount + 1);
    this.pass(this.accumMat, next);
    this.accum = [next, prev];
    this.accumCount++;
    return next;
  }

  get accumulated(): WebGLRenderTarget {
    return this.accum[0];
  }

  /** センサーノイズ・飽和・現像を適用して画面へ */
  present(raw: WebGLRenderTarget, p: DevelopParams): void {
    const u = this.sensorMat.uniforms;
    u.tRaw.value = raw.texture;
    u.uElectronsAtWhite.value = p.noise.electronsAtWhite;
    u.uFullWell.value = p.noise.fullWell;
    u.uReadNoise.value = p.noise.readNoise;
    u.uElectronsPerDN.value = p.noise.electronsPerDN;
    u.uAveraging.value = Math.max(1, p.averaging);
    u.uNoise.value = p.enableNoise;
    u.uSeed.value = p.seed >>> 0;
    u.uPushEV.value = p.pushEV;
    u.uZebra.value = p.zebra;
    this.pass(this.sensorMat, null);
  }

  /** 縮小した RAW 期待値を CPU に読み戻す (露出計・ヒストグラム用) */
  readMeter(raw: WebGLRenderTarget): Float32Array {
    this.meterMat.uniforms.tRaw.value = raw.texture;
    this.pass(this.meterMat, this.meterTarget);
    this.renderer.readRenderTargetPixels(this.meterTarget, 0, 0, METER_WIDTH, METER_HEIGHT, this.meterPixels);
    return this.meterPixels;
  }

  private renderScene(scene: Scene, camera: PerspectiveCamera): void {
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(scene, camera);
  }

  private pass(mat: ShaderMaterial, target: WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }
}
