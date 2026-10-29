// Shared GLSL snippets (CONTRACT §3.4). Gate 1 object modules carry private,
// prefixed copies of their noise (they were written before this file existed),
// so nothing imports this yet. It is kept for the galaxy phase.
//
// NOISE needs `#define FBM_OCTAVES n` (loop bound) before it is included.

export const NOISE = /* glsl */ `
#ifndef FBM_OCTAVES
#define FBM_OCTAVES 4
#endif
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash33(i).x, n100 = hash33(i + vec3(1,0,0)).x;
  float n010 = hash33(i + vec3(0,1,0)).x, n110 = hash33(i + vec3(1,1,0)).x;
  float n001 = hash33(i + vec3(0,0,1)).x, n101 = hash33(i + vec3(1,0,1)).x;
  float n011 = hash33(i + vec3(0,1,1)).x, n111 = hash33(i + vec3(1,1,1)).x;
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z) * 2.0 - 1.0;
}
// Simplex-style gradient noise (Gustavson layout, hash-based gradients).
float snoise3(vec3 p) {
  const float F3 = 1.0 / 3.0, G3 = 1.0 / 6.0;
  vec3 s = floor(p + dot(p, vec3(F3)));
  vec3 x = p - s + dot(s, vec3(G3));
  vec3 e = step(vec3(0.0), x - x.yzx);
  vec3 i1 = e * (1.0 - e.zxy), i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 x1 = x - i1 + G3, x2 = x - i2 + 2.0 * G3, x3 = x - 1.0 + 3.0 * G3;
  vec4 w = max(0.6 - vec4(dot(x, x), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 d = vec4(dot(hash33(s) - 0.5, x), dot(hash33(s + i1) - 0.5, x1),
                dot(hash33(s + i2) - 0.5, x2), dot(hash33(s + 1.0) - 0.5, x3));
  w *= w; w *= w;
  return dot(d, w) * 52.0;
}
float fbm3(vec3 p, int octaves) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < FBM_OCTAVES; i++) {
    if (i >= octaves) break;
    s += a * snoise3(p);
    p = p * 2.03 + vec3(17.1, 9.2, 3.7);
    a *= 0.5;
  }
  return s;
}
`;

export const COMMON = /* glsl */ `
float saturate(float x) { return clamp(x, 0.0, 1.0); }
float remap(float x, float a, float b, float c, float d) { return c + (x - a) * (d - c) / (b - a); }
float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 linearToOklab(vec3 c) {
  vec3 lms = vec3(
    dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
    dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
    dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
  return vec3(
    dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}
vec3 oklabToLinear(vec3 c) {
  vec3 lms = vec3(
    c.x + 0.3963377774 * c.y + 0.2158037573 * c.z,
    c.x - 0.1055613458 * c.y - 0.0638541728 * c.z,
    c.x - 0.0894841775 * c.y - 1.2914855480 * c.z);
  lms = lms * lms * lms;
  return vec3(
    dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}
float fresnel(vec3 n, vec3 v, float power) { return pow(1.0 - saturate(dot(n, v)), power); }
`;
