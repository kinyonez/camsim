// ポストプロセス用 GLSL。three.js の ShaderMaterial (WebGL2 / GLSL ES 3.00) として使う。

export const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * プレビュー用の被写界深度 (gather 方式、Dennis Gustafsson "Bokeh depth of field in a single pass" ベース)
 * 錯乱円半径 [px] = uCocScale · (1/S − 1/d)。正 = 後ボケ、負 = 前ボケ。
 */
export const dofFragment = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uCocScale;
uniform float uInvFocus;
uniform float uMaxRadius;
uniform float uRadScale;
varying vec2 vUv;

const float GOLDEN_ANGLE = 2.39996323;
const int MAX_ITER = 512;

float distanceAt(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
}

void main() {
  vec3 center = texture2D(tColor, vUv).rgb;
  float d0 = distanceAt(vUv);
  float size0 = min(abs(uCocScale * (uInvFocus - 1.0 / d0)), uMaxRadius);
  if (uMaxRadius < 0.5) { gl_FragColor = vec4(center, 1.0); return; }

  vec3 sum = center;
  float tot = 1.0;
  // 画素ごとに螺旋の開始角・半径をずらし、疎なサンプルによる縞をノイズに変える (interleaved gradient noise)
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float radius = uRadScale * (0.5 + ign);
  float ang = ign * 6.28318530718;
  for (int i = 0; i < MAX_ITER; i++) {
    if (radius >= uMaxRadius) break;
    vec2 tc = vUv + vec2(cos(ang), sin(ang)) * uTexel * radius;
    vec3 c = texture2D(tColor, tc).rgb;
    float d = distanceAt(tc);
    float size = min(abs(uCocScale * (uInvFocus - 1.0 / d)), uMaxRadius);
    // 中心より奥にあるサンプルは、手前のシャープな物体に滲み出さない
    if (d > d0) size = min(size, size0 * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, size);
    sum += mix(sum / tot, c, m);
    tot += 1.0;
    ang += GOLDEN_ANGLE;
    radius += uRadScale / radius;
  }
  gl_FragColor = vec4(sum / tot, 1.0);
}`;

/** 撮影モード: 薄レンズ・時間サンプルの逐次平均 */
export const accumulateFragment = /* glsl */ `
uniform sampler2D tPrev;
uniform sampler2D tNew;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec3 prev = texture2D(tPrev, vUv).rgb;
  vec3 next = min(texture2D(tNew, vUv).rgb, vec3(65000.0));
  gl_FragColor = vec4(mix(prev, next, uWeight), 1.0);
}`;

/**
 * センサー → 現像。入力は RAW 期待値 (pre-exposure 済みの HDR バッファ)。
 *   光電子数 e = raw · eWhite
 *   ノイズ σ² = e (ショット) + σ_read² + LSB²/12 (量子化)
 *   飽和: 画素はフルウェル、ADC は RAW 1.0
 *   現像: ノイズフロア以下は黒つぶれ、飽和は白飛び
 * uAveraging: 1 表示画素に含まれるセンサー画素数。縮小表示ではノイズが 1/√k に平均化される。
 */
export const sensorFragment = /* glsl */ `
uniform sampler2D tRaw;
uniform float uElectronsAtWhite;
uniform float uFullWell;
uniform float uReadNoise;
uniform float uElectronsPerDN;
uniform float uAveraging;
uniform bool uNoise;
uniform uint uSeed;
uniform float uPushEV;
uniform bool uZebra;
uniform float uBlackPoint;
varying vec2 vUv;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

vec3 gaussian3(uvec2 pixel) {
  uvec3 a = pcg3d(uvec3(pixel, uSeed));
  uvec3 b = pcg3d(a ^ uvec3(0x9e3779b9u));
  vec3 u1 = (vec3(a >> 8u) + 0.5) / 16777216.0;
  vec3 u2 = vec3(b >> 8u) / 16777216.0;
  return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}

vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 raw = max(texture2D(tRaw, vUv).rgb, 0.0);
  vec3 e = min(raw * uElectronsAtWhite, vec3(uFullWell));
  if (uNoise) {
    vec3 variance = e + uReadNoise * uReadNoise + uElectronsPerDN * uElectronsPerDN / 12.0;
    e += sqrt(variance / uAveraging) * gaussian3(uvec2(gl_FragCoord.xy));
    e = min(e, vec3(uFullWell));
  }
  vec3 r = min(e / uElectronsAtWhite, 1.0);
  // 黒つぶれ: ノイズフロア (= DR の下限) を黒点にし、輝度がそれ以下なら黒に落とす
  // (チャンネル別に引くと境界が赤や緑に色づくので、輝度で判定して色相は保つ)
  float y = dot(r, vec3(0.2126, 0.7152, 0.0722));
  float yCrushed = max(y - uBlackPoint, 0.0) / (1.0 - uBlackPoint);
  vec3 developed = r * (yCrushed / max(y, 1e-6)) * exp2(uPushEV);
  // 白飛び: どれかのチャンネルが飽和したら白へ寄せる (チャンネル別の飽和による色かぶりを防ぐ)
  float peak = max(max(developed.r, developed.g), developed.b);
  developed = mix(min(developed, 1.0), vec3(1.0), smoothstep(0.9, 1.0, peak));
  vec3 color = linearToSRGB(developed);
  if (uZebra) {
    // 白飛び (いずれかのチャンネルが RAW 上限) と黒つぶれ (輝度が黒点以下) をゼブラで警告
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0));
    if (max(max(r.r, r.g), r.b) >= 0.999) color = mix(color, vec3(1.0, 0.0, 0.4), stripe * 0.8);
    else if (y <= uBlackPoint) color = mix(color, vec3(0.1, 0.4, 1.0), stripe * 0.8);
  }
  gl_FragColor = vec4(color, 1.0);
}`;

/** 露出計・ヒストグラム用の縮小コピー (RAW 期待値) */
export const meterFragment = /* glsl */ `
uniform sampler2D tRaw;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tRaw, vUv).rgb, 1.0);
}`;
