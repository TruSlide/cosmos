// Star: the hero object of a star system.
//
// Owns (CONTRACT §4): photosphere surface, corona, accretion disk, quasar
// (halo + twin jets + knots + pulse), my-move beacon, idle decay, and the crash
// collapse with its remnant (core + 40 shards).
//
// Draw calls (at most 7, most states 3–4):
//   surface (opaque)        icosphere, granulation shader, writes depth
//   glow    (additive)      one camera-facing quad: corona + quasar halo/core +
//                           collapse flash + remnant core/shell haze
//   disk    (additive)      Keplerian accretion annulus with Doppler beaming
//   jets    (additive) ×2   outer sheath + inner spine, each one instanced draw
//                           holding both the +Y and −Y jet
//   beacon  (additive)      thin camera-facing ring with a radar sweep
//   shards  (opaque)        40 remnant fragments, one instanced draw
//
// Brightness ladder (ART_DIRECTION §2) is enforced by working in luminance
// units: every palette color handed to a shader is pre-divided by its own
// luminance, so a uniform value of 6 means "peak linear luminance 6".
//
// Ladder note: the ladder values are caps. Measured with the spec bloom
// (0.9 / 0.55 / threshold 1) and ACES, a surface at 6 tone-maps to flat white
// (granulation invisible) and jets at 6–10 veil the whole frame orange. So the
// surface peaks at 2.0 (lower as context fills, so crimson survives ACES),
// corona 1.1. Jets (Gate 1 review: two crisp hourglass lobes) sit at the
// bloom threshold, sheath 0.5 and spine 0.95, because anything brighter on a
// 14 u line blooms into one wide flame; pulse knots lift the spine to ~2.3 so
// each one blooms as it travels. The halo is compact (σ 1.05 u, 0.6–0.95) so
// it never bridges the lobes and the waist stays dark. The quasar core
// keeps the full 14 → 30 pulse, so the order of the ladder (quasar ≫
// everything) is unchanged.
//
// NEEDS ME hue: per-channel ACES would wash #FF5F1F to amber/cream at these
// luminances. engine.js's output pass tone-maps pixels in the NEEDS ME hue
// band hue-preservingly, so the orange layers here stay pure NEEDS_ME and
// only the small white-hot core carries NEEDS_ME_CORE.
//
// This is the ONLY module allowed to use PALETTE NEEDS_ME / NEEDS_ME_CORE.

import * as THREE from 'three';
import { color, starColor, saturateOklab } from '../lib/palette.js';
import { hash01, mulberry32, damp, clamp, lerp, smoothstep, ease } from '../lib/math.js';

// ---------------------------------------------------------------------------
// Constants (units: star radii, seconds, linear luminance)
// ---------------------------------------------------------------------------

const DISK_IN = 1.4;
const DISK_OUT = 3.2;
const DISK_TILT = THREE.MathUtils.degToRad(12);
const DISK_GHOST = 0.08;             // alpha the disk keeps once the session stops working

const JET_LEN = 14;
const JET_Y0 = 1.04;                 // jets leave the photosphere at the poles (hourglass waist)
const JET_PROFILE = 1.15;            // r ∝ s^1.15: a near-straight cone, pinched at the pole, flaring slightly at the tip
const PULSE_PERIOD = 2.4;            // s, the only periodic brightness in the universe
const PULSE_CREST = PULSE_PERIOD / 4; // sin(2πt/P) peaks at t = P/4
const KNOT_SPEED = 6;                // u/s, one knot fired per crest
const Q_FLASH = 0.35;                // ignition: halo flash-in
const Q_EXTEND = 0.6;                // ignition: jets 0 → 14 (ease-out-expo)
const Q_RETRACT = 1.2;               // release: jets retract
const Q_HALO_OUT = 1.0;              // release: halo fade

const BEACON_RADIUS = 1.9;
const BEACON_TUBE = 0.025;
const BEACON_SWEEP = 12;             // s per revolution of the 30° radar arc
const BEACON_IN = 1.5;
const BEACON_OUT = 0.8;

const L_SURFACE = 2.0;               // working surface peak. Ladder cap is 6; above ~3 ACES flattens granulation to white, so we sit lower
const L_CORONA = 1.1;               // ladder cap 3
const L_QCORE_TROUGH = 14;
const L_QCORE_SWING = 16;            // 14 + 16 = 30 at the crest
const L_JET = 0.95;                  // spine; at the bloom threshold so the hourglass stays crisp (a knot lifts it to ~2.3 and blooms)
const L_JET_SHEATH = 0.5;            // cone walls; below the bloom threshold so the lobes keep their edges
const L_BEACON = 2.5;
const L_REMNANT = 0.35;
const L_FLASH = 4;

const CRASH_IMPLODE = 1.6;           // radius 1 → 0.22, ease-in-cubic
const CRASH_FLASH = 0.2;
const CRASH_TOTAL = 2.5;             // shell 0 → 4 runs from implode end to here
const REMNANT_RADIUS = 0.22;
const SHELL_RADIUS = 4;
const SHARD_COUNT = 40;

const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);

/** Luminance of a linear THREE.Color. */
function lumOf(c) {
  return c.r * LUMA.x + c.g * LUMA.y + c.b * LUMA.z;
}

/** Palette color divided by its own luminance ("1 unit of light"), as a Vector3 uniform. */
function unitColor(name) {
  const c = color(name);
  const l = Math.max(lumOf(c), 1e-4);
  return new THREE.Vector3(c.r / l, c.g / l, c.b / l);
}

/** Write linear color `c` into Vector3 `v` scaled to unit luminance. */
function setUnit(v, c) {
  const l = Math.max(lumOf(c), 1e-4);
  return v.set(c.r / l, c.g / l, c.b / l);
}

/** Plain linear palette color as a Vector3 uniform. */
function rawColor(name) {
  const c = color(name);
  return new THREE.Vector3(c.r, c.g, c.b);
}

// ---------------------------------------------------------------------------
// GLSL: self-contained noise (prefixed cz* so it never collides with shared chunks)
// ---------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
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
const BILLBOARD_BASIS_GLSL = /* glsl */ `
vec3 czRight() { return vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); }
vec3 czUp()    { return vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]); }
`;

// ---------------------------------------------------------------------------
// Surface: granulating photosphere
// ---------------------------------------------------------------------------

const SURFACE_VERT = /* glsl */ `
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

const SURFACE_FRAG = /* glsl */ `
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

const GLOW_VERT = /* glsl */ `
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

const GLOW_FRAG = /* glsl */ `
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

const DISK_VERT = /* glsl */ `
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

const DISK_FRAG = /* glsl */ `
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

const JET_VERT = /* glsl */ `
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

const JET_FRAG = /* glsl */ `
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

const BEACON_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;   // TorusGeometry: uv.x runs once around the ring
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEACON_FRAG = /* glsl */ `
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

const SHARD_VERT = /* glsl */ `
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

const SHARD_FRAG = /* glsl */ `
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function additive(params) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    ...params,
  });
}

/** Clone a BufferGeometry into an InstancedBufferGeometry with extra per-instance attributes. */
function instanced(base, count, attrs) {
  const g = new THREE.InstancedBufferGeometry().copy(base);
  g.instanceCount = count;
  for (const [name, [array, size]] of Object.entries(attrs)) {
    g.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
  }
  base.dispose();
  return g;
}

// ---------------------------------------------------------------------------
// Star
// ---------------------------------------------------------------------------

export class Star {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx  ObjectContext (CONTRACT §3.1)
   * @param {{seed?: string}} opts
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this.quality = ctx?.quality ?? 'high';
    this.seed = opts.seed ?? 'star';
    this._disposed = false;

    this.root = new THREE.Group();
    this.root.name = 'Star';
    parent.add(this.root);

    // `body` carries the birth scale; everything visual hangs below it.
    this.body = new THREE.Group();
    this.root.add(this.body);

    // Scratch objects (no per-frame allocation).
    this._col = new THREE.Color();
    this._sat = new THREE.Color();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();

    this._buildSurface();
    this._buildGlow();
    this._buildDisk();
    this._buildJets();
    this._buildBeacon();
    this._buildShards();

    this._birth = 1;
    this._storm = 0;
    this.reset();
  }

  // --- construction -------------------------------------------------------

  _buildSurface() {
    const q = this.quality;
    const detail = q === 'high' ? 20 : q === 'medium' ? 14 : 9;
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const defines = { CZ_OCT: q === 'low' ? 3 : q === 'medium' ? 4 : 5 };
    if (q !== 'low') defines.CZ_WORLEY = 1;
    this.surfaceMat = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uSat: { value: new THREE.Vector3(1, 1, 1) },
        uSatDeep: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: L_SURFACE },
        uFlow: { value: 0 },
        uRot: { value: 0 },
        uDesat: { value: 0 },
        uDead: { value: 0 },
        uStorm: { value: 0 },
        uStormCol: { value: unitColor('ERROR') },
        uCinder: { value: rawColor('CINDER') },
        uCinderRim: { value: rawColor('CINDER_RIM') },
        uRemnant: { value: 0 },
        uRemnantCol: { value: unitColor('REMNANT_CORE') },
        uFlash: { value: 0 },
        uFade: { value: 1 },
      },
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
    });
    this.surface = new THREE.Mesh(geo, this.surfaceMat);
    this.surface.name = 'StarSurface';
    this.body.add(this.surface);
  }

  _buildGlow() {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.glowMat = additive({
      uniforms: {
        uExtent: { value: 4 },
        uPush: { value: 1.1 },
        uRadius: { value: 1 },
        uFlow: { value: 0 },
        uJitter: { value: new THREE.Vector3() },
        uStorm: { value: 0 },
        uCoronaL: { value: L_CORONA },
        uCoronaK: { value: 2.4 },
        uCoronaCol: { value: new THREE.Vector3(1, 1, 1) },
        uQ: { value: 0 },
        uQHaloL: { value: 0 },
        uQCoreL: { value: 0 },
        uNeeds: { value: unitColor('NEEDS_ME') },
        uNeedsCore: { value: unitColor('NEEDS_ME_CORE') },
        uFlashL: { value: 0 },
        uRem: { value: 0 },
        uRemCol: { value: unitColor('REMNANT_CORE') },
        uShellR: { value: SHELL_RADIUS },
        uShellL: { value: 0 },
        uFade: { value: 1 },
      },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
    });
    this.glow = new THREE.Mesh(geo, this.glowMat);
    this.glow.name = 'StarGlow';
    this.glow.frustumCulled = false; // vertex shader billboards; geometry bounds are meaningless
    this.glow.renderOrder = 2;
    this.body.add(this.glow);
  }

  _buildDisk() {
    const geo = new THREE.RingGeometry(DISK_IN, DISK_OUT, 128, 8);
    this.diskMat = additive({
      side: THREE.DoubleSide,
      uniforms: {
        uPhase: { value: 0 },
        uAlpha: { value: 1 },
        uGain: { value: 1.05 },
        uDesat: { value: 0 },
        uFade: { value: 1 },
        uInner: { value: unitColor('DISK_INNER') },
        uOuter: { value: unitColor('DISK_OUTER') },
        uDoppler: { value: unitColor('DISK_DOPPLER') },
      },
      vertexShader: DISK_VERT,
      fragmentShader: DISK_FRAG,
    });
    this.disk = new THREE.Mesh(geo, this.diskMat);
    this.disk.name = 'AccretionDisk';
    this.disk.rotation.x = -Math.PI / 2; // ring XY → orbital XZ
    // Tilt 12° off the orbital plane so it reads as a disk from the default camera.
    this.diskPivot = new THREE.Group();
    this.diskPivot.rotation.x = DISK_TILT;
    this.diskPivot.add(this.disk);
    this.body.add(this.diskPivot);
  }

  _buildJets() {
    const hi = this.quality !== 'low';
    const mk = (rBase, rTop, gain, rim, core, name) => {
      // Unit-radius tube; the vertex shader flares it into the hourglass lobe.
      const base = new THREE.CylinderGeometry(1, 1, JET_LEN - JET_Y0, hi ? 48 : 24, hi ? 64 : 32, true);
      base.translate(0, (JET_LEN + JET_Y0) / 2, 0); // y ∈ [Y0, 14], starting at the pole
      const geo = instanced(base, 2, { aSign: [new Float32Array([1, -1]), 1] });
      const mat = additive({
        side: THREE.DoubleSide,
        uniforms: {
          uExt: { value: 0 },
          uTime: { value: 0 },
          uKnotY: { value: -1 },
          uGain: { value: gain },
          uRBase: { value: rBase },
          uRTop: { value: rTop },
          uRim: { value: rim },
          uCore: { value: core },
          uNeeds: { value: unitColor('NEEDS_ME') },
          uNeedsCore: { value: unitColor('NEEDS_ME_CORE') },
        },
        vertexShader: JET_VERT,
        fragmentShader: JET_FRAG,
      });
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.frustumCulled = false;
      m.renderOrder = 3;
      m.visible = false;
      this.body.add(m);
      return m;
    };
    // Hourglass: each lobe is a cone pinched to a point at the pole and flared
    // outward. The sheath (0.03 → 2.3) is limb-brightened, so the cone walls
    // read as crisp edges; the spine (0.02 → 0.28) is the bright core on the
    // axis that blooms. Both stay mostly pure NEEDS_ME; only a touch of the
    // white-hot core color near the pole, so the jets keep their orange.
    this.jetSheath = mk(0.03, 1.9, L_JET_SHEATH, 0.9, 0.1, 'QuasarJetSheath');
    this.jetSpine = mk(0.02, 0.28, L_JET, 0.0, 0.35, 'QuasarJetSpine');
    this._jetBaseGain = [L_JET_SHEATH, L_JET];
  }

  _buildBeacon() {
    const geo = new THREE.TorusGeometry(BEACON_RADIUS, BEACON_TUBE, 8, 256);
    this.beaconMat = additive({
      uniforms: {
        uSweep: { value: 0 },
        uAmt: { value: 0 },
        uCol: { value: unitColor('MY_MOVE') },
      },
      vertexShader: BEACON_VERT,
      fragmentShader: BEACON_FRAG,
    });
    this.beacon = new THREE.Mesh(geo, this.beaconMat);
    this.beacon.name = 'Beacon';
    this.beacon.visible = false;
    this.body.add(this.beacon);
  }

  _buildShards() {
    const rng = mulberry32(Math.floor(hash01(`${this.seed}:shards`) * 4294967296));
    const dir = new Float32Array(SHARD_COUNT * 3);
    const rot = new Float32Array(SHARD_COUNT * 4);
    const scl = new Float32Array(SHARD_COUNT * 3);
    const rad = new Float32Array(SHARD_COUNT);
    const v = new THREE.Vector3();
    for (let i = 0; i < SHARD_COUNT; i++) {
      // Uniform direction on the sphere, slightly flattened toward the orbital plane.
      const z = rng() * 2 - 1;
      const a = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      v.set(s * Math.cos(a), z * 0.8, s * Math.sin(a)).normalize();
      dir.set([v.x, v.y, v.z], i * 3);
      v.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
      rot.set([v.x, v.y, v.z, rng() * Math.PI * 2], i * 4);
      const big = 0.06 + rng() * 0.14;
      scl.set([big, big * (0.25 + rng() * 0.5), big * (0.6 + rng() * 0.8)], i * 3);
      rad[i] = 0.82 + rng() * 0.3;
    }
    const geo = instanced(new THREE.TetrahedronGeometry(1, 0), SHARD_COUNT, {
      aDir: [dir, 3],
      aRot: [rot, 4],
      aScl: [scl, 3],
      aRad: [rad, 1],
    });
    this.shardMat = new THREE.ShaderMaterial({
      uniforms: {
        uShell: { value: 0 },
        uGlow: { value: 1 },
        uCol: { value: unitColor('REMNANT_SHARD') },
      },
      vertexShader: SHARD_VERT,
      fragmentShader: SHARD_FRAG,
    });
    this.shards = new THREE.Mesh(geo, this.shardMat);
    this.shards.name = 'RemnantShards';
    this.shards.frustumCulled = false;
    this.shards.visible = false;
    this.body.add(this.shards);
  }

  // --- public API -----------------------------------------------------------

  /** Current visual radius in system units (1 normally; 0.22 as a remnant; 0→1 during birth). */
  get radius() {
    return this._birthScale * this._crashScale;
  }

  /** Current HDR peak luminance of anything this star draws (QA ladder checks). */
  get surfaceLuminance() {
    return this._lum;
  }

  /** 0..1 from the white hole's settle phase: scale and fade-in. */
  setBirth(progress) {
    this._birth = clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
  }

  /** 0..1 from Flares: magenta mottling on the surface, jittered corona. */
  setStormLevel(level) {
    this._storm = clamp(Number.isFinite(level) ? level : 0, 0, 1);
  }

  reset() {
    this._init = false;
    this._lastNow = null;
    this._mode = null;

    // Smoothed state (snapped on the first update after reset).
    this._act = 0;
    this._fill = 0;
    this._idle = 0;
    this._spin = 0;
    this._diskA = DISK_GHOST;
    this._beacon = 0;

    // Accumulated phases.
    this._flow = 0;
    this._rot = 0;
    this._diskPhase = 0;
    this._sweep = 0;
    this._coronaFlow = 0;

    // Quasar state machine: 'off' | 'ign' | 'on' | 'rel'.
    this._qPhase = 'off';
    this._qT = 0;
    this._qClock = 0;
    this._jet = 0;
    this._halo = 0;
    this._jet0 = 0;
    this._halo0 = 0;

    // Crash.
    this._crashed = false;
    this._crashAge = 0;
    this._crashScale = 1;

    this._birthScale = 1;
    this._lum = 0;
    this._motionRate = 1;
  }

  /**
   * 0..1 speed of this system's motion clock: 1 alive, → 0 as idle decay
   * completes, 0 once a crash has collapsed. StarSystem integrates it and runs
   * belt and planet orbits on it, so a dead system is perfectly still.
   */
  get motionRate() {
    return this._motionRate;
  }

  /**
   * @param {object} state  normalized SystemState
   * @param {number} dt     seconds since last frame (≤ 0.1)
   * @param {number} t      render clock
   * @returns {0|1|2} rate hint
   */
  update(state, dt, t) {
    if (this._disposed || !state) return 0;
    const now = state.now;
    if (this._lastNow !== null && now < this._lastNow - 1e-3) this.reset(); // replay scrub
    this._lastNow = now;

    const first = !this._init;
    this._init = true;
    const mode = state.mode;
    if (mode !== this._mode) this._mode = mode;

    const working = mode === 'working';
    const thinking = mode === 'thinking';
    const needs = mode === 'needs-me';
    const myMove = mode === 'my-move';
    const crashedMode = mode === 'crashed';
    const idleish = mode === 'idle' || myMove;

    let hint = 0;

    // ---- smoothed scalar inputs ------------------------------------------
    const activity = clamp(state.activity ?? 0, 0, 1);
    const fill = Math.max(0, state.contextFill ?? 0);
    const idleTarget = idleish ? clamp(state.idleFor ?? 0, 0, 1) : 0;

    let spinTarget;
    let diskTarget;
    if (working) { spinTarget = 0.3 + 0.7 * activity; diskTarget = 0.35 + 0.65 * activity; }
    else if (thinking) { spinTarget = 0.4 * (0.3 + 0.7 * activity); diskTarget = 0.5; }
    // Waiting on the owner is not work: the disk drops to its ghost so the
    // orange halo reads pure (a blue disk under it would pull it toward pink).
    else if (needs) { spinTarget = 0.15 * 0.65; diskTarget = DISK_GHOST; }
    else if (crashedMode) { spinTarget = 0; diskTarget = 0; }
    else { spinTarget = 0; diskTarget = DISK_GHOST; }
    const beaconTarget = myMove ? 1 : 0;

    if (first) {
      this._act = activity;
      this._fill = fill;
      this._idle = idleTarget;
      this._spin = spinTarget;
      this._diskA = diskTarget;
      this._beacon = beaconTarget;
    } else {
      this._act = damp(this._act, activity, 0.6, dt);
      this._fill = damp(this._fill, fill, 0.8, dt);
      this._idle = damp(this._idle, idleTarget, 1.5, dt);
      // Spin-up ≈ 1 s; spin-down decays exponentially over ≈ 3 s.
      this._spin = damp(this._spin, spinTarget, spinTarget > this._spin ? 0.35 : 1.0, dt);
      this._diskA = damp(this._diskA, diskTarget, diskTarget > this._diskA ? 0.35 : 1.0, dt);
      const bRate = beaconTarget > this._beacon ? 1 / BEACON_IN : -1 / BEACON_OUT;
      this._beacon = clamp(this._beacon + bRate * dt, 0, 1);
      if (Math.abs(this._spin - spinTarget) > 0.01 || Math.abs(this._diskA - diskTarget) > 0.005) hint = 2;
      if (this._beacon > 0 && this._beacon < 1) hint = 2;
      if (Math.abs(this._idle - idleTarget) > 0.002) hint = Math.max(hint, 1);
    }

    const act = this._act;
    const idleS = Math.pow(smoothstep(0, 1, this._idle), 0.7); // ART_DIRECTION §3.1 idle curve
    const idleLum = lerp(1, 0.5, idleS);                          // cools, never fades to black (Gate 1 review)
    const alive = 1 - idleS;                                     // dead (DATA_SPEC §3.5): no animation at all

    // ---- crash collapse ----------------------------------------------------
    if (crashedMode) {
      if (!this._crashed) {
        this._crashed = true;
        // Loading straight into a crash shows the remnant, not the animation.
        this._crashAge = first ? CRASH_TOTAL + 1 : 0;
      } else {
        this._crashAge += dt;
      }
      if (Number.isFinite(state.endedAt)) this._crashAge = Math.max(this._crashAge, now - state.endedAt);
    } else if (this._crashed) {
      this._crashed = false;
      this._crashAge = 0;
    }
    const ca = this._crashed ? this._crashAge : -1;
    const implode = ca < 0 ? 0 : ease.inCubic(clamp(ca / CRASH_IMPLODE, 0, 1));
    this._crashScale = lerp(1, REMNANT_RADIUS, implode);
    const flashK = ca >= CRASH_IMPLODE && ca < CRASH_IMPLODE + CRASH_FLASH
      ? 1 - (ca - CRASH_IMPLODE) / CRASH_FLASH : 0;
    const shellP = ca < CRASH_IMPLODE ? 0 : ease.outCubic(clamp((ca - CRASH_IMPLODE) / (CRASH_TOTAL - CRASH_IMPLODE), 0, 1));
    const remnant = ca < 0 ? 0 : smoothstep(CRASH_IMPLODE - 0.3, CRASH_TOTAL, ca);
    if (ca >= 0 && ca < CRASH_TOTAL + 0.1) hint = 2;

    // ---- quasar state machine ---------------------------------------------
    const qWant = needs;
    if (qWant && (this._qPhase === 'off' || this._qPhase === 'rel')) {
      if (first) { this._qPhase = 'on'; this._jet = 1; this._halo = 1; }
      else { this._qPhase = 'ign'; this._qT = 0; this._jet0 = this._jet; this._halo0 = this._halo; }
      this._qClock = 0;
    } else if (!qWant && (this._qPhase === 'ign' || this._qPhase === 'on')) {
      this._qPhase = 'rel';
      this._qT = 0;
      this._jet0 = this._jet;
      this._halo0 = this._halo;
    }
    let haloFlash = 0;
    if (this._qPhase === 'ign') {
      this._qT += dt;
      const qt = this._qT;
      this._halo = Math.max(this._halo0, clamp(qt / Q_FLASH, 0, 1));
      // Flash overshoot during the 0.35 s ignition, settling over the next 0.5 s.
      haloFlash = qt < Q_FLASH ? qt / Q_FLASH : Math.max(0, 1 - (qt - Q_FLASH) / 0.5);
      const e = qt < Q_FLASH ? 0 : ease.outExpo(clamp((qt - Q_FLASH) / Q_EXTEND, 0, 1));
      this._jet = Math.max(this._jet0, e);
      if (qt >= Q_FLASH + Q_EXTEND + 0.5) this._qPhase = 'on';
      hint = 2;
    } else if (this._qPhase === 'on') {
      this._jet = 1;
      this._halo = 1;
      hint = Math.max(hint, 1);
    } else if (this._qPhase === 'rel') {
      this._qT += dt;
      const qt = this._qT;
      this._jet = this._jet0 * (1 - ease.inOutCubic(clamp(qt / Q_RETRACT, 0, 1)));
      this._halo = this._halo0 * (1 - clamp(qt / Q_HALO_OUT, 0, 1));
      if (qt >= Q_RETRACT) { this._qPhase = 'off'; this._jet = 0; this._halo = 0; }
      hint = 2;
    }
    if (this._qPhase !== 'off') this._qClock += dt;
    const pulse = Math.pow(0.5 + 0.5 * Math.sin((2 * Math.PI * this._qClock) / PULSE_PERIOD), 4);
    // A knot leaves the base at every pulse crest and travels 6 u/s; spacing 14.4 > 14, so one at a time.
    const sinceCrest = this._qClock - PULSE_CREST;
    const knotY = sinceCrest >= 0 ? JET_Y0 + KNOT_SPEED * (sinceCrest % PULSE_PERIOD) : -1;

    // ---- birth ------------------------------------------------------------
    const b = this._birth;
    this._birthScale = Math.max(1e-3, b * b * (3 - 2 * b));
    const fade = clamp(b * 1.6, 0, 1);
    this.body.scale.setScalar(this._birthScale);

    // ---- phases -----------------------------------------------------------
    const turb = lerp(0.2, 1.0, act) * alive * (1 - remnant);
    this._flow = (this._flow + dt * turb) % 4096;
    this._rot = (this._rot + dt * 0.04 * alive * (1 - remnant)) % (Math.PI * 2);
    this._motionRate = alive * (1 - remnant);
    this._coronaFlow = (this._coronaFlow + dt * lerp(0.4, 1.0, act) * this._motionRate) % 4096;
    this._diskPhase += dt * this._spin;
    if (this._diskPhase > 6 * 4096) this._diskPhase -= 6 * 4096; // whole number of shear cycles: seamless

    // ---- surface ----------------------------------------------------------
    const base = starColor(Math.min(this._fill, 1), this._col);
    const baseLum = Math.max(lumOf(base), 1e-4);
    // A filling context burns redder and lower: crimson at luminance 2 would tone-map to pale pink.
    const fillDim = lerp(1, 0.6, smoothstep(0.6, 1, this._fill));
    // A quasar outshines its host: the photosphere drops to half under the halo,
    // so its blue-white light doesn't pull the orange toward pink.
    const surfPeak = L_SURFACE * (0.7 + 0.3 * act) * idleLum * fillDim * (1 - 0.5 * this._halo);
    const su = this.surfaceMat.uniforms;
    su.uColor.value.set(base.r, base.g, base.b);
    setUnit(su.uSat.value, saturateOklab(base, 1.7, this._sat));
    setUnit(su.uSatDeep.value, saturateOklab(base, 2.2, this._sat));
    // ~1.15 headroom: whitened cell tops + supergranule crest sit above the mean.
    su.uGain.value = surfPeak / Math.max(baseLum, 0.3) / 1.15;
    su.uFlow.value = this._flow;
    su.uRot.value = this._rot;
    su.uDesat.value = 0.3 * idleS;
    su.uDead.value = idleS;
    su.uStorm.value = this._storm * (1 - remnant);
    su.uRemnant.value = remnant;
    su.uFlash.value = flashK * L_FLASH * 0.5;
    su.uFade.value = fade;
    this.surface.scale.setScalar(this._crashScale);
    this.surface.visible = fade > 0.002;

    // ---- glow: corona + quasar + crash ------------------------------------
    const overflow = clamp(this._fill - 1, 0, 1);
    const k = lerp(4.6, 2.4, act) * (1 + 0.8 * overflow) + 1.6 * idleS;
    // The quasar halo replaces most of the corona (its star-colored light would desaturate the orange).
    const coronaL = L_CORONA * (0.7 + 0.3 * act) * lerp(1, 0.55, idleS) * (1 - remnant) * (1 - 0.8 * this._halo);
    const gu = this.glowMat.uniforms;
    gu.uRadius.value = this._crashScale;
    gu.uFlow.value = this._coronaFlow;
    gu.uStorm.value = this._storm;
    if (this._storm > 0.001) {
      // Storm churn of the streamer field: smooth incommensurate sines on the
      // corona clock, so it churns rather than strobes (only the quasar pulses).
      const j = 0.35 * this._storm;
      const f = this._coronaFlow;
      gu.uJitter.value.set(j * Math.sin(f * 1.3), j * Math.sin(f * 1.7 + 2), j * Math.sin(f * 2.3 + 4));
    } else {
      gu.uJitter.value.set(0, 0, 0);
    }
    gu.uCoronaL.value = coronaL;
    gu.uCoronaK.value = k;
    // Corona: the full star color, pre-saturated ×1.4 in OKLab (ACES greys dim
    // colors), in unit luminance. At ≤ 1.1 it is low enough for the fill hue to survive.
    setUnit(gu.uCoronaCol.value, saturateOklab(base, 1.4, this._sat));

    const qCore = (L_QCORE_TROUGH + L_QCORE_SWING * pulse) * this._halo;
    const qHalo = (0.6 + 0.35 * pulse) * this._halo + 2.0 * haloFlash; // compact halo: the core and jets carry the pulse
    gu.uQ.value = this._halo;
    gu.uQCoreL.value = qCore;
    gu.uQHaloL.value = qHalo;
    gu.uFlashL.value = flashK * L_FLASH;
    gu.uRem.value = remnant;
    gu.uShellR.value = SHELL_RADIUS * shellP;
    gu.uShellL.value = ca < 0 ? 0 : lerp(0.7, 0.02, shellP);
    gu.uFade.value = fade;
    // Size the quad to what is actually lit, so fragments are not wasted.
    let ext = 1.3 * this._crashScale;
    if (coronaL > 0.001) ext = Math.max(ext, this._crashScale * (1 + 6.5 / k));
    if (this._halo > 0.001) ext = Math.max(ext, 6);
    if (ca >= 0) ext = Math.max(ext, SHELL_RADIUS * shellP + 1.2, 1.0);
    gu.uExtent.value = ext;
    gu.uPush.value = 1.1 * this._crashScale;
    this.glow.visible = fade > 0.002 && (coronaL > 0.001 || this._halo > 0.001 || ca >= 0);

    // ---- disk -------------------------------------------------------------
    const du = this.diskMat.uniforms;
    const diskA = this._diskA * (1 - 0.8 * idleS) * (1 - implode);
    du.uPhase.value = this._diskPhase;
    du.uAlpha.value = diskA;
    du.uDesat.value = 0.7 * idleS;
    du.uFade.value = fade;
    this.disk.visible = diskA * fade > 0.002;

    // ---- jets -------------------------------------------------------------
    const jetsOn = this._jet > 0.002;
    this.jetSheath.visible = jetsOn;
    this.jetSpine.visible = jetsOn;
    if (jetsOn) {
      const jetPulse = 0.8 + 0.3 * pulse;
      for (let i = 0; i < 2; i++) {
        const m = i === 0 ? this.jetSheath : this.jetSpine;
        const u = m.material.uniforms;
        const ext = JET_Y0 + this._jet * (JET_LEN - JET_Y0);
        u.uExt.value = ext;
        u.uTime.value = this._qClock;
        u.uKnotY.value = knotY >= 0 && knotY <= ext ? knotY : -1;
        u.uGain.value = this._jetBaseGain[i] * jetPulse;
      }
    }

    // ---- beacon -----------------------------------------------------------
    // Fades out with idle decay: a day-old my-move ends as the same still ember as idle.
    const bAmt = this._beacon * (1 - idleS) * fade;
    this.beacon.visible = bAmt > 0.002;
    if (this.beacon.visible) {
      this._sweep = (this._sweep + (dt / BEACON_SWEEP) * this._motionRate) % 1;
      this.beaconMat.uniforms.uSweep.value = this._sweep;
      this.beaconMat.uniforms.uAmt.value = bAmt;
      // Face the camera: local rotation = parentWorld⁻¹ · cameraWorld.
      const cam = this.ctx?.camera;
      if (cam) {
        this.body.getWorldQuaternion(this._qa).invert();
        cam.getWorldQuaternion(this._qb);
        this.beacon.quaternion.copy(this._qa.multiply(this._qb));
      }
      if (idleS < 0.6) hint = Math.max(hint, 1);
    }

    // ---- shards -----------------------------------------------------------
    this.shards.visible = ca >= CRASH_IMPLODE;
    if (this.shards.visible) {
      this.shardMat.uniforms.uShell.value = SHELL_RADIUS * shellP;
      this.shardMat.uniforms.uGlow.value = 1 + 4 * (1 - shellP);
    }

    // ---- ambient rate -----------------------------------------------------
    if (working && (act > 0.02 || this._spin > 0.02)) hint = 2;
    else if (thinking || needs) hint = Math.max(hint, 1);
    // Idle-ish stars only ask for 30 fps while their idle damping still moves
    // (checked above); once settled they drift slowly enough for 10 fps.
    else if (!crashedMode && !idleish && idleS < 0.6) hint = Math.max(hint, 1);
    if (this._storm > 0.001) hint = 2;

    // ---- QA luminance -----------------------------------------------------
    const remL = remnant > 0 ? L_REMNANT * remnant : 0;
    this._lum = Math.max(
      surfPeak * (1 - remnant) * fade,
      coronaL * fade,
      qCore * fade,
      flashK * L_FLASH,
      remL,
    );

    return hint;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const m of [this.surface, this.glow, this.disk, this.jetSheath, this.jetSpine, this.beacon, this.shards]) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
