// UI で選べる標準的な露出値（1/3 段刻み）

export const F_STOPS = [1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22];

export const ISO_STOPS = [
  100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000,
  12800, 16000, 20000, 25600, 32000, 40000, 51200,
];

/** シャッター速度 [s] と表示ラベル */
export const SHUTTER_STOPS: { label: string; seconds: number }[] = [
  30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 2.5, 2, 1.6, 1.3, 1, 0.8, 0.6, 0.5, 0.4, 0.3,
].map((s) => ({ label: `${s}"`, seconds: s }))
  .concat(
    [4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000].map(
      (d) => ({ label: `1/${d}`, seconds: 1 / d }),
    ),
  );

export function nearestShutter(seconds: number): { label: string; seconds: number } {
  let best = SHUTTER_STOPS[0];
  for (const s of SHUTTER_STOPS) {
    if (Math.abs(Math.log2(s.seconds / seconds)) < Math.abs(Math.log2(best.seconds / seconds))) best = s;
  }
  return best;
}

export function formatShutter(seconds: number): string {
  return seconds >= 0.3 ? `${+seconds.toFixed(1)}"` : `1/${Math.round(1 / seconds)}`;
}
