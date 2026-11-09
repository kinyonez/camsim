import { BoxGeometry, type BufferGeometry, Color, Float32BufferAttribute, type Material, Mesh } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 手続き生成シーン共通のジオメトリ補助

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 同じマテリアルで描く部品を頂点カラー付きでまとめる（描画コール削減） */
export class Batch {
  private parts: BufferGeometry[] = [];

  add(geo: BufferGeometry, color: Color | number): void {
    const c = color instanceof Color ? color : new Color(color);
    const g = geo.index ? geo.toNonIndexed() : geo;
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new Float32BufferAttribute(colors, 3));
    if (g.attributes.uv) g.deleteAttribute('uv');
    this.parts.push(g);
  }

  build(material: Material, shadows = true): Mesh | null {
    if (this.parts.length === 0) return null;
    const mesh = new Mesh(mergeGeometries(this.parts), material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    return mesh;
  }
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(w, h, d).translate(x, y, z);
}
