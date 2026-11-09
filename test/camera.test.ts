import { describe, expect, it } from 'vitest';
import { circleOfConfusionMm, depthOfFieldMm, horizontalFovDeg } from '../src/camera/optics';
import { deriveSensor, dynamicRangeStops, lambertLuminance, noiseParams, rawPerLuminance } from '../src/camera/sensor';

describe('露出の校正', () => {
  it('Sunny 16: 晴天 (10万lx) の 18% グレーが ISO100 f/16 1/100 で中間調 (RAW ≈ 0.13〜0.25) になる', () => {
    const grey = lambertLuminance(100_000, 0.18);
    const raw = grey * rawPerLuminance(1 / 100, 16, 100);
    expect(raw).toBeGreaterThan(0.13);
    expect(raw).toBeLessThan(0.25);
  });

  it('相反則: f/8 1/400 と f/16 1/100 は同じ RAW', () => {
    expect(rawPerLuminance(1 / 400, 8, 100)).toBeCloseTo(rawPerLuminance(1 / 100, 16, 100), 10);
  });
});

describe('センサー', () => {
  it('フルサイズ 20M は約 6.6µm ピッチ / 3:2', () => {
    const d = deriveSensor({ format: 'FF', megapixels: 20, tech: 'bsi' });
    expect(d.pitchUm).toBeGreaterThan(6.4);
    expect(d.pitchUm).toBeLessThan(6.7);
    expect(d.widthPx / d.heightPx).toBeCloseTo(1.5, 2);
  });

  it('ベース ISO の DR は実機の傾向 (11〜15 stop) に収まり、世代・画素サイズで順序が付く', () => {
    const ff = dynamicRangeStops({ format: 'FF', megapixels: 20, tech: 'bsi' }, 100);
    const mft = dynamicRangeStops({ format: 'MFT', megapixels: 20, tech: 'bsi' }, 100);
    const legacy = dynamicRangeStops({ format: 'FF', megapixels: 20, tech: 'legacy' }, 100);
    expect(ff).toBeGreaterThan(13);
    expect(ff).toBeLessThan(15.5);
    expect(legacy).toBeGreaterThan(10.5);
    expect(legacy).toBeLessThan(ff);
    expect(mft).toBeLessThan(ff);
  });

  it('ISO を 1 段上げると DR はおおむね 1 段弱減る', () => {
    const cfg = { format: 'FF', megapixels: 20, tech: 'bsi' } as const;
    const d = dynamicRangeStops(cfg, 1600) - dynamicRangeStops(cfg, 3200);
    expect(d).toBeGreaterThan(0.7);
    expect(d).toBeLessThan(1.05);
  });

  it('ISO を上げると読み出しノイズ (入力換算) は下がる', () => {
    const cfg = { format: 'APS-C', megapixels: 40, tech: 'bsi' } as const;
    expect(noiseParams(cfg, 3200).readNoise).toBeLessThan(noiseParams(cfg, 100).readNoise);
  });
});

describe('光学', () => {
  it('50mm を フルサイズで使うと水平画角 ≈ 39.6°', () => {
    expect(horizontalFovDeg(50, 36)).toBeCloseTo(39.6, 1);
  });

  it('ピント位置の錯乱円は 0、遠いほど大きく無限遠で収束', () => {
    expect(circleOfConfusionMm(50, 1.8, 3000, 3000)).toBe(0);
    const c10 = circleOfConfusionMm(50, 1.8, 3000, 10_000);
    const cInf = circleOfConfusionMm(50, 1.8, 3000, Infinity);
    expect(c10).toBeLessThan(cInf);
    expect(cInf).toBeCloseTo(0.469, 2);
  });

  it('被写界深度: 50mm f/8 3m は約 2.36m〜4.13m', () => {
    const [near, far] = depthOfFieldMm(50, 8, 3000, 0.029);
    expect(near / 1000).toBeCloseTo(2.36, 1);
    expect(far / 1000).toBeCloseTo(4.13, 1);
  });
});
