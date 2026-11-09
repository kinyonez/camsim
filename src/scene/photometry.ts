import type { Light, MeshLambertMaterial, ShaderMaterial } from 'three';

// 光源・発光体・空を「物理値 × pre-exposure」で描くための登録簿。
// HDR バッファ (half float, 最大 65504) に太陽〜夜景までの輝度差を収めるため、
// 露出設定から求めた係数をあらかじめ全光源に掛けておく（UE/Frostbite の pre-exposure と同じ考え方）。
// three.js の物理単位: DirectionalLight / HemisphereLight = lx, PointLight = cd, emissive = cd/m²
export class Photometry {
  private lights: { light: Light; base: number }[] = [];
  private emissives: { material: MeshLambertMaterial; base: number }[] = [];
  private skies: ShaderMaterial[] = [];

  addLight(light: Light, physicalIntensity: number): void {
    this.lights.push({ light, base: physicalIntensity });
  }

  /** luminance [cd/m²] で発光するマテリアル */
  addEmissive(material: MeshLambertMaterial, luminance: number): void {
    this.emissives.push({ material, base: luminance });
  }

  /** uniform `uPreExposure` を持つ空シェーダー */
  addSky(material: ShaderMaterial): void {
    this.skies.push(material);
  }

  setBase(target: Light | MeshLambertMaterial, value: number): void {
    for (const e of this.lights) if (e.light === target) e.base = value;
    for (const e of this.emissives) if (e.material === target) e.base = value;
  }

  apply(preExposure: number): void {
    for (const { light, base } of this.lights) light.intensity = base * preExposure;
    for (const { material, base } of this.emissives) material.emissiveIntensity = base * preExposure;
    for (const sky of this.skies) sky.uniforms.uPreExposure.value = preExposure;
  }
}
