// Star shaders: the GLSL for every layer of the star (surface, glow, disk,
// jets, beacon, shards). Pure strings; star.js builds the materials.

import { DISK_IN, DISK_OUT, JET_LEN, JET_Y0, JET_PROFILE, L_BEACON, L_REMNANT } from './star-constants.js';

// ---------------------------------------------------------------------------
// GLSL: self-contained noise (prefixed cz* so it never collides with shared chunks)
// ---------------------------------------------------------------------------

export const NOISE_GLSL = /* glsl */ `
#ifndef CZ_MAX_OCT
#define CZ_MAX_OCT 5
#endif
const vec3 CZ_LUMA = vec3(0.2126, 0.7152, 0.0722);

// Integer-lattice hash (float-only, stable on all GPUs for |p| < 1e5).
vec3 czHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// 3D gradient noise with quintic fade. Roughly [-1, 1].
float czNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  #define CZ_G(o) dot(czHash33(i + o) * 2.0 - 1.0, f - o)
  float n000 = CZ_G(vec3(0.0, 0.0, 0.0));
  float n100 = CZ_G(vec3(1.0, 0.0, 0.0));
  float n010 = CZ_G(vec3(0.0, 1.0, 0.0));
  float n110 = CZ_G(vec3(1.0, 1.0, 0.0));
  float n001 = CZ_G(vec3(0.0, 0.0, 1.0));
  float n101 = CZ_G(vec3(1.0, 0.0, 1.0));
  float n011 = CZ_G(vec3(0.0, 1.0, 1.0));
  float n111 = CZ_G(vec3(1.0, 1.0, 1.0));
  #undef CZ_G
  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  return 1.6 * mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// Fractal sum; octave count is dynamic but bounded by CZ_MAX_OCT.
float czFbm(vec3 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  for (int k = 0; k < CZ_MAX_OCT; k++) {
    if (k >= oct) break;
    s += a * czNoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

// Worley F1/F2 (27-cell search). F2 − F1 is ~0 on cell borders: intergranular lanes.
vec2 czWorley(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 9.0;
  float d2 = 9.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 c = vec3(float(x), float(y), float(z));
    vec3 r = c + czHash33(i + c) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; }
    else if (d < d2) { d2 = d; }
  }
  return sqrt(vec2(d1, d2));
}
`;

// Camera basis from the view matrix (rows of the rotation part), used by billboards.
export const BILLBOARD_BASIS_GLSL = /* glsl */ `
vec3 czRight() { return vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); }
vec3 czUp()    { return vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]); }
`;

// ---------------------------------------------------------------------------
// Surface: granulating photosphere
// ---------------------------------------------------------------------------

export const SURFACE_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
void main() {
  vObj = normalize(position);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const SURFACE_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uColor;       // starColor(contextFill), linear
uniform vec3 uSat;         // uColor, chroma ×1.7 in OKLab (hue kept), unit luminance
uniform vec3 uSatDeep;     // uColor, chroma ×2.2 in OKLab, unit luminance (lanes)
uniform float uGain;       // luminance scale so the hottest cell hits the ladder peak
uniform float uFlow;       // accumulated boil phase (speed set by activity, ~0 when dead)
uniform float uRot;        // slow domain rotation, rad
uniform float uDesat;      // idle: saturation loss
uniform float uDead;       // idle: 0 alive … 1 cinder
uniform float uStorm;      // flare storm 0..1
uniform vec3 uStormCol;    // ERROR, unit luminance
uniform vec3 uCinder;
uniform vec3 uCinderRim;
uniform float uRemnant;    // crash remnant blend 0..1
uniform vec3 uRemnantCol;  // REMNANT_CORE, unit luminance
uniform float uFlash;      // collapse flash, luminance
uniform float uFade;       // birth fade-in
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float mu = clamp(dot(N, V), 0.0, 1.0);
  float om = 1.0 - mu;
  // Quadratic limb-darkening law (ART_DIRECTION §3.1).
  float limb = 1.0 - 0.6 * om - 0.15 * om * om;

  // Object-space sample point, slowly rotated about Y.
  float cr = cos(uRot), sr = sin(uRot);
  vec3 p = vec3(cr * vObj.x + sr * vObj.z, vObj.y, -sr * vObj.x + cr * vObj.z);
  float fl = uFlow;

  // Domain warp: low-frequency flow field that drags cells around (aperiodic boil).
  vec3 warp = vec3(
    czNoise(p * 1.7 + vec3(0.0, 0.0, fl * 0.11)),
    czNoise(p * 1.7 + vec3(5.2, 1.3, -fl * 0.09)),
    czNoise(p * 1.7 + vec3(2.8, 7.1, fl * 0.13)));
  vec3 q = p + warp * 0.12;

  // Supergranulation: large, slow brightness patches.
  float sup = czFbm(q * 2.4 + vec3(fl * 0.04, 0.0, -fl * 0.03), CZ_OCT);

#ifdef CZ_WORLEY
  // Granulation: bright convective cell tops (F1 small), dark lanes where F2 ≈ F1.
  vec3 gp = q * 12.0 + vec3(0.0, fl * 0.22, fl * 0.10) + warp * 0.35;
  vec2 F = czWorley(gp);
  float lane = 1.0 - smoothstep(0.0, 0.12, F.y - F.x);
  float top = pow(1.0 - smoothstep(0.0, 0.85, F.x), 0.7);
  float gran = top * (1.0 - lane);
  // Fade cells toward their mean once they shrink below ~2 px (no shimmer at distance).
  float aa = clamp(1.6 - length(fwidth(gp)) * 1.4, 0.0, 1.0);
  gran = mix(0.55, gran, aa);
#else
  float rn = 1.0 - abs(czNoise(q * 9.0 + vec3(0.0, fl * 0.25, 0.0)));
  float gran = smoothstep(0.2, 0.9, rn);
#endif
  float fine = czNoise(q * 31.0 + vec3(fl * 0.3));

  // Cells run hotter than lanes. The ladder's nominal 15% is invisible after ACES at
  // these luminances, so lanes drop ~30% (still a temperature cue, not a pattern).
  float T = (0.62 + 0.38 * gran) * (1.0 + 0.14 * sup) * (1.0 + 0.04 * fine);
  // ACES desaturates bright HDR, so chroma is pre-boosted (×1.7, in OKLab on
  // the CPU so crimson never clips to pure red, which sits next to orange).
  float bl = dot(uColor, CZ_LUMA);
  vec3 base = uSat * bl;
  vec3 lanesCol = uSatDeep * bl * 0.9;                                    // deeper, more saturated
  vec3 cellsCol = mix(base, vec3(bl * 1.1), 0.18);                       // whiter tops
  vec3 col = mix(lanesCol, cellsCol, gran) * T * limb * uGain;

  // Context fill lives where luminance is low enough to survive ACES: the
  // limb band takes the full, pre-saturated star color (luminance unchanged).
  vec3 hue = uSat;
  float limbBand = 1.0 - smoothstep(0.15, 0.5, mu);
  col = mix(col, hue * dot(col, CZ_LUMA), limbBand);

  // Flare storm: magenta magnetic mottling.
  if (uStorm > 0.001) {
    float m = smoothstep(0.1, 0.6, czNoise(p * 3.1 + vec3(fl * 0.21, -fl * 0.17, 0.0)));
    float l = dot(col, CZ_LUMA);
    col = mix(col, uStormCol * l * 1.3, m * uStorm * 0.7);
  }

  // Idle (Gate 1 review): the planets carry the idle story now, so the star
  // never goes dark. It only cools: a little saturation loss and a shift of
  // hue toward the cool cinder-rim grey at the same luminance, plus a faint
  // cool limb. A day-idle star is a calm, cooled sun, not a coal.
  float lumC = dot(col, CZ_LUMA);
  col = mix(col, vec3(lumC), uDesat);
  vec3 cool = uCinderRim / max(dot(uCinderRim, CZ_LUMA), 1e-4);
  col = mix(col, cool * lumC, 0.45 * uDead);
  col += cool * lumC * 0.25 * pow(om, 3.0) * uDead;

  // Crash remnant: small dim core.
  col = mix(col, uRemnantCol * ${L_REMNANT.toFixed(2)} * (0.55 + 0.45 * limb), uRemnant);

  col += vec3(uFlash);
  gl_FragColor = vec4(col * uFade, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Glow billboard: corona, quasar halo + core, collapse flash, remnant haze
// ---------------------------------------------------------------------------

export const GLOW_VERT = /* glsl */ `
${BILLBOARD_BASIS_GLSL}
uniform float uExtent;   // quad half-size, body-local units
uniform float uPush;     // how far toward the camera the quad sits (keeps it in front of the photosphere)
varying vec2 vQ;
varying vec3 vDir;
varying vec2 vAxis;
void main() {
  vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float s = length(modelMatrix[0].xyz);
  vec3 right = czRight();
  vec3 up = czUp();
  vec3 toCam = cameraPosition - c;
  float d = max(length(toCam), 1e-4);
  toCam /= d;
  float push = min(uPush * s, d * 0.5);
  // Shrink so the quad, though pushed forward, projects as if it sat at the star's center.
  float shrink = (d - push) / d;
  vec3 w = c + toCam * push + (right * position.x + up * position.y) * uExtent * s * shrink;
  vQ = position.xy * uExtent;
  vDir = right * position.x + up * position.y;
  // Star's local +Y (jet axis) projected on screen, for the halo's axial stretch.
  vec3 ax = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  vAxis = vec2(dot(ax, right), dot(ax, up));
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

export const GLOW_FRAG = /* glsl */ `
#define CZ_MAX_OCT 3
${NOISE_GLSL}
uniform float uRadius;      // current photosphere radius (body-local)
uniform float uExtent;      // quad half-size (for edge fade)
uniform float uFlow;
uniform vec3 uJitter;       // storm jitter of the streamer field
uniform float uStorm;
// corona
uniform float uCoronaL;
uniform float uCoronaK;
uniform vec3 uCoronaCol;    // unit luminance
// quasar
uniform float uQ;           // 0..1 presence
uniform float uQHaloL;
uniform float uQCoreL;
uniform vec3 uNeeds;        // NEEDS_ME, unit luminance
uniform vec3 uNeedsCore;    // NEEDS_ME_CORE, unit luminance
// crash
uniform float uFlashL;
uniform float uRem;
uniform vec3 uRemCol;       // REMNANT_CORE, unit luminance
uniform float uShellR;
uniform float uShellL;
uniform float uFade;
varying vec2 vQ;
varying vec3 vDir;
varying vec2 vAxis;

void main() {
  float l = length(vQ);
  vec3 col = vec3(0.0);
  vec3 d = normalize(vDir + vec3(1e-5));

  // Corona: exp falloff from the limb, broken into streamers that drift outward.
  if (uCoronaL > 0.0005) {
    float r = l / max(uRadius, 1e-3);
    float env = r < 1.0 ? smoothstep(0.985, 1.0, r) : exp(-uCoronaK * (r - 1.0));
    if (env > 0.002) {
      // Sampling slides along d as r grows; the phase term pushes features outward.
      vec3 sp = d * 2.6 + d * (r * 1.25 - uFlow * 0.22) + uJitter;
      float n = czFbm(sp, 3) * 0.5 + 0.5;
      float rays = 0.12 + 2.2 * n * n * n * (1.0 + 0.6 * uStorm);
      col += uCoronaCol * uCoronaL * env * mix(1.0, rays, smoothstep(1.0, 1.35, r));
    }
  }

  // Quasar: huge orange halo, slightly stretched along the jet axis, white-hot core.
  if (uQ > 0.0005) {
    float axLen = length(vAxis);
    vec2 a = axLen > 1e-3 ? vAxis / axLen : vec2(0.0, 1.0);
    float along = dot(vQ, a);
    float perp = dot(vQ, vec2(-a.y, a.x));
    // Compact halo hugging the star (σ = 1.05), squashed slightly along the jet
    // axis so it never bridges the two lobes into one flame, plus a faint
    // equatorial skirt that reaches exactly zero at the quad edge. The jets,
    // not the halo, own the frame now: the hourglass waist stays dark.
    float ra = length(vec2(along * mix(1.0, 1.35, axLen), perp));
    float eq = 1.0 - axLen * smoothstep(0.0, 1.0, abs(along) / max(abs(perp) + 0.6, 1e-3)) * 0.85;
    float halo = exp(-ra * ra / (2.0 * 1.05 * 1.05)) + 0.18 * eq * exp(-ra / 1.6) * (1.0 - smoothstep(0.5, 0.98, l / uExtent));
    // Core: the 14–30 peak. Only its centre (~0.1 u) is white-hot; the rest of
    // its energy is NEEDS_ME, so the bloom it throws stays orange, not cream.
    float core = exp(-l * l / 0.07);
    vec3 coreCol = mix(uNeeds, uNeedsCore, exp(-l * l / 0.012));
    // Halo pre-compensated +2° toward yellow (green ×1.16, luminance kept): the
    // star, disk ghost and dust it sits over pull the mix ~3° toward pink, so
    // on screen it lands on NEEDS_ME's own hue (measured 35–39° OKLCH).
    vec3 haloCol = uNeeds * vec3(1.0, 1.16, 1.0);
    haloCol /= dot(haloCol, CZ_LUMA);
    col += haloCol * halo * uQHaloL + coreCol * core * uQCoreL;
  }

  // Collapse flash and remnant: dim core point plus a faint, broken shell.
  if (uFlashL > 0.0005) {
    col += uCoronaCol * uFlashL * exp(-l * l / 0.9);
  }
  if (uRem > 0.0005) {
    float core = exp(-l * l / 0.05);
    float rz = (l - uShellR) / 0.22;
    float ring = exp(-rz * rz);
    float gaps = smoothstep(0.05, 0.45, czFbm(d * 6.0 + vec3(4.1), 3));
    col += uRemCol * (core * ${L_REMNANT.toFixed(2)} * uRem + ring * gaps * uShellL);
  }

  gl_FragColor = vec4(col * uFade, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Accretion disk
// ---------------------------------------------------------------------------

export const DISK_VERT = /* glsl */ `
varying vec2 vP;
varying vec3 vW;
varying vec3 vAx;   // ring-plane basis in world space (for Doppler velocity)
varying vec3 vAy;
void main() {
  vP = position.xy;               // RingGeometry lives in its own XY plane
  vAx = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0));
  vAy = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const DISK_FRAG = /* glsl */ `
#define CZ_MAX_OCT 4
${NOISE_GLSL}
uniform float uPhase;     // accumulated spin "seconds" (activity-scaled)
uniform float uAlpha;
uniform float uGain;
uniform float uDesat;
uniform float uFade;
uniform vec3 uInner;      // DISK_INNER, unit luminance
uniform vec3 uOuter;      // DISK_OUTER, unit luminance
uniform vec3 uDoppler;    // DISK_DOPPLER, unit luminance
varying vec2 vP;
varying vec3 vW;
varying vec3 vAx;
varying vec3 vAy;

const float R_IN = ${DISK_IN.toFixed(2)};
const float R_OUT = ${DISK_OUT.toFixed(2)};
const float CYCLE = 6.0;   // phase-seconds per shear cycle (two layers crossfade so shear stays bounded)

void main() {
  float r = length(vP);
  float th = atan(vP.y, vP.x);
  float u = clamp((r - R_IN) / (R_OUT - R_IN), 0.0, 1.0);

  // Keplerian angular speed ω ∝ r^-1.5: inner gas laps outer gas.
  float omega = 1.25 * pow(r / R_IN, -1.5);
  float lr = log(r);

  float gas = 0.0;
  for (int i = 0; i < 2; i++) {
    float ph = uPhase / CYCLE + float(i) * 0.5;
    float fr = fract(ph);
    float w = 1.0 - abs(2.0 * fr - 1.0);          // triangle weights sum to 1
    float a = th - omega * fr * CYCLE;            // co-rotating angle
    vec3 jump = vec3(mod(floor(ph), 64.0) * 3.17 + float(i) * 11.3); // mod 64: phase wrap stays seamless
    // Noise on (cos a, sin a, log r): seamless in θ, stretched ~8:1 along θ.
    vec3 sp = vec3(cos(a) * 1.9, sin(a) * 1.9, lr * 20.0) + jump;
    float n = czFbm(sp, CZ_MAX_OCT) * 0.5 + 0.5;
    n = n * n * 1.7;   // sharpen into filaments with dark gaps
    // Two-armed logarithmic spiral density wave, sheared by the same rotation.
    float arm = 0.5 + 0.5 * cos(2.0 * a + 7.0 * lr + jump.x);
    gas += w * n * (0.7 + 0.55 * arm);
  }
  gas = pow(clamp(gas, 0.0, 2.0), 1.4);

  // Temperature: hot thin inner rim, r^-2.2 falloff, feathered edges.
  float I = pow(R_IN / r, 2.2);
  float rimZ = (r - R_IN - 0.06) / 0.07;
  I += 0.9 * exp(-rimZ * rimZ);
  I *= smoothstep(R_IN, R_IN + 0.12, r) * (1.0 - smoothstep(R_OUT - 0.55, R_OUT, r));

  // Doppler beaming: (1 + β cos φ)^3 with β = 0.35.
  vec3 vel = normalize(-sin(th) * vAx + cos(th) * vAy);
  vec3 V = normalize(cameraPosition - vW);
  float c = dot(vel, V);
  float boost = pow(1.0 + 0.35 * c, 3.0);

  vec3 col = mix(uInner, uOuter, pow(u, 0.7));
  col = mix(col, uDoppler, clamp(c, 0.0, 1.0) * 0.55);
  col = mix(col, uOuter * 0.8, clamp(-c, 0.0, 1.0) * 0.35);
  col *= gas * I * boost * uGain;
  col = mix(col, vec3(dot(col, CZ_LUMA)), uDesat);
  gl_FragColor = vec4(col * uAlpha * uFade, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Quasar jets (instanced: aSign = +1 / −1 mirrors the cone onto −Y)
// ---------------------------------------------------------------------------

export const JET_VERT = /* glsl */ `
attribute float aSign;
uniform float uRBase;    // radius at the pole (the hourglass waist)
uniform float uRTop;     // radius at the tip
varying vec3 vL;         // unit-cylinder xz direction, y along the jet
varying float vS;        // 0 at the pole → 1 at the tip
varying vec3 vN;
varying vec3 vW;
const float Y0 = ${JET_Y0.toFixed(2)};
const float LEN = ${JET_LEN.toFixed(1)};
const float PROF = ${JET_PROFILE.toFixed(2)};
void main() {
  // Unit cylinder → flared cone: r(s) = rBase + (rTop − rBase)·s^PROF. PROF < 1
  // opens quickly off the pole, so each lobe is a bowl of the hourglass.
  float s = clamp((position.y - Y0) / (LEN - Y0), 0.0, 1.0);
  float r = mix(uRBase, uRTop, pow(s, PROF));
  float drdy = (uRTop - uRBase) * PROF * pow(max(s, 0.01), PROF - 1.0) / (LEN - Y0);
  vL = position;
  vS = s;
  vec3 p = vec3(position.x * r, position.y * aSign, position.z * r);
  vec3 n = normalize(vec3(position.x, -drdy, position.z));
  n.y *= aSign;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const JET_FRAG = /* glsl */ `
#define CZ_MAX_OCT 3
${NOISE_GLSL}
uniform float uExt;      // current tip position along the axis (Y0 … LEN)
uniform float uTime;     // quasar clock
uniform float uKnotY;    // pulse knot position along the axis (−1 = none)
uniform float uGain;     // luminance
uniform float uRim;      // 0 = filled beam (spine), → 1 = limb-brightened cone wall (sheath)
uniform float uCore;     // how much of the hot-white core color to mix in (spine > sheath)
uniform vec3 uNeeds;
uniform vec3 uNeedsCore;
varying vec3 vL;
varying float vS;
varying vec3 vN;
varying vec3 vW;

void main() {
  float y = vL.y;
  float tip = clamp((uExt - y) / 1.4, 0.0, 1.0);
  if (tip <= 0.0) discard;
  float s = vS;

  vec3 V = normalize(cameraPosition - vW);
  float mu = abs(dot(normalize(vN), V));
  // Filled beam (bright where the surface faces us) plus a limb-brightened wall
  // whose last few percent roll off: soft, but the cone edge stays defined.
  float fill = mu * sqrt(mu);
  float wall = pow(1.0 - mu, 2.0) * smoothstep(0.0, 0.14, mu);
  float shape = mix(fill, 0.12 * fill + wall, uRim);

  // Pinched at the pole (the hourglass waist stays dark), long fall-off outward.
  float axial = smoothstep(0.0, 0.09, s) * pow(1.0 - s, 0.55);

  // Helical twist, then outward-streaming turbulence (domain slides along +y at 3 u/s).
  float ang = y * 0.4;
  float ca = cos(ang), sa = sin(ang);
  vec2 xz = vec2(ca * vL.x - sa * vL.z, sa * vL.x + ca * vL.z);
  float n = czFbm(vec3(xz * 1.2, y * 0.7 - uTime * 3.0), CZ_MAX_OCT) * 0.5 + 0.5;
  float flow = 0.45 + 1.1 * n * n;

  // Small knots streaming outward at ~4 u/s between pulse knots, broken up by
  // the turbulence so they flow rather than tick.
  float ph = y * 0.36 - uTime * 1.45 + n * 0.9;
  float blob = pow(0.5 + 0.5 * sin(6.2832 * ph), 6.0) * smoothstep(0.03, 0.2, s);

  // The pulse knot: one per crest, widening with the cone as it travels.
  float kz = (y - uKnotY) / (0.55 + 0.9 * s);
  float knot = uKnotY >= 0.0 ? exp(-kz * kz) : 0.0;

  float I = shape * axial * flow * tip * (1.0 + 0.55 * blob + 1.4 * knot) * uGain;
  vec3 col = mix(uNeeds, uNeedsCore, uCore * (1.0 - smoothstep(0.0, 0.45, s)) * fill);
  col = mix(col, uNeedsCore, knot * 0.25);
  gl_FragColor = vec4(col * I, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Beacon ring (my move)
// ---------------------------------------------------------------------------

export const BEACON_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;   // TorusGeometry: uv.x runs once around the ring
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const BEACON_FRAG = /* glsl */ `
uniform float uSweep;    // 0..1 head position
uniform float uAmt;      // fade 0..1
uniform vec3 uCol;       // MY_MOVE, unit luminance
varying vec2 vUv;
void main() {
  // The ring itself is constant; one 30° arc runs ahead of a soft tail.
  float d = fract(uSweep - vUv.x);
  float arc = d < 0.0833 ? pow(1.0 - d / 0.0833, 2.0) : 0.0;
  float L = mix(1.5, ${L_BEACON.toFixed(2)}, arc);
  gl_FragColor = vec4(uCol * L * uAmt, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Remnant shards
// ---------------------------------------------------------------------------

export const SHARD_VERT = /* glsl */ `
attribute vec3 aDir;
attribute vec4 aRot;     // axis.xyz, angle
attribute vec3 aScl;
attribute float aRad;
uniform float uShell;
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
vec3 rotAA(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
void main() {
  vec3 p = rotAA(position * aScl, aRot.xyz, aRot.w);
  vec3 n = normalize(rotAA(normal / aScl, aRot.xyz, aRot.w));
  vec4 w = modelMatrix * vec4(aDir * uShell * aRad + p, 1.0);
  vW = w.xyz;
  vC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const SHARD_FRAG = /* glsl */ `
uniform vec3 uCol;      // REMNANT_SHARD, unit luminance
uniform float uGlow;    // brighter while the shell is still expanding
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(vC - vW);
  vec3 V = normalize(cameraPosition - vW);
  float lam = abs(dot(N, L));                       // thin plates: lit from either face
  float rim = pow(1.0 - abs(dot(N, V)), 2.0);
  gl_FragColor = vec4(uCol * (0.03 + 0.14 * lam + 0.05 * rim) * uGlow, 1.0);
}
`;
