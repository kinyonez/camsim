import type { Light, MeshLambertMaterial, MeshStandardMaterial, ShaderMaterial, Vector3 } from 'three';

type EmissiveMaterial = MeshLambertMaterial | MeshStandardMaterial;
type RGB = [number, number, number];

// 光源・発光体・空・環境光を「物理値 × pre-exposure」で描くための登録簿。
// HDR バッファ (half float, 最大 65504) に太陽〜夜景までの輝度差を収めるため、
// 露出設定から求めた係数をあらかじめ全光源に掛けておく（UE/Frostbite の pre-exposure と同じ考え方）。
// three.js の物理単位: DirectionalLight = lx, PointLight / SpotLight = cd, RectAreaLight = cd/m², emissive = cd/m²
export class Photometry {
  private lights = new Map<Light, number>();
  private emissives = new Map<EmissiveMaterial, number>();
  private vectors = new Map<{ value: Vector3 }, RGB>();
  private skies: ShaderMaterial[] = [];

  /** 光源の物理強度を設定 (初回は登録も兼ねる) */
  setLight(light: Light, physicalIntensity: number): void {
    this.lights.set(light, physicalIntensity);
  }

  /** luminance [cd/m²] で発光するマテリアル */
  setEmissive(material: EmissiveMaterial, luminance: number): void {
    this.emissives.set(material, luminance);
  }

  /** 照度 [lx] を RGB で持つ uniform (環境光) */
  setVector(uniform: { value: Vector3 }, rgb: RGB): void {
    this.vectors.set(uniform, rgb);
  }

  /** uniform `uPreExposure` を持つ空シェーダー */
  addSky(material: ShaderMaterial): void {
    this.skies.push(material);
  }

  apply(preExposure: number): void {
    for (const [light, base] of this.lights) light.intensity = base * preExposure;
    for (const [material, base] of this.emissives) material.emissiveIntensity = base * preExposure;
    for (const [uniform, [r, g, b]] of this.vectors) uniform.value.set(r * preExposure, g * preExposure, b * preExposure);
    for (const sky of this.skies) sky.uniforms.uPreExposure.value = preExposure;
  }
}
