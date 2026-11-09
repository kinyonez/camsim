import {
  MeshLambertMaterial,
  type MeshLambertMaterialParameters,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  Vector3,
} from 'three';

// 環境光 (天空・地面の照り返し・室内の相互反射) をマテリアルごとに切り替える。
// three.js の HemisphereLight / AmbientLight は全物体に効くため、室内に屋外の天空光 (1万lx超) が
// 入ってしまう。そこで「屋外」「室内」の 2 系統の uniform を用意し、シェーダーに半球光と同じ式で足す。
//   照度 E = mix(下向き, 上向き, 0.5 + 0.5·n·up)  [lx, pre-exposure 済み]
//   輝度 L = E · albedo / π

export type AmbientZone = 'exterior' | 'interior';

export const ambientUniforms: Record<AmbientZone, { up: { value: Vector3 }; down: { value: Vector3 } }> = {
  exterior: { up: { value: new Vector3() }, down: { value: new Vector3() } },
  interior: { up: { value: new Vector3() }, down: { value: new Vector3() } },
};

function withAmbient<T extends MeshLambertMaterial | MeshStandardMaterial>(material: T, zone: AmbientZone): T {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAmbientUp = ambientUniforms[zone].up;
    shader.uniforms.uAmbientDown = ambientUniforms[zone].down;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAmbientUp;\nuniform vec3 uAmbientDown;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float hemi = 0.5 + 0.5 * dot(normal, upView);
          reflectedLight.indirectDiffuse += mix(uAmbientDown, uAmbientUp, hemi) * BRDF_Lambert(diffuseColor.rgb);
        }`,
      );
  };
  return material;
}

/** 屋外向け (天空光を受ける) の拡散面 */
export function exteriorMaterial(params: MeshLambertMaterialParameters = {}): MeshLambertMaterial {
  return withAmbient(new MeshLambertMaterial({ flatShading: true, ...params }), 'exterior');
}

/** 室内向けの拡散面。窓の面光源 (RectAreaLight) を受けるため Standard を使う */
export function interiorMaterial(params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
  return withAmbient(new MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0, ...params }), 'interior');
}
