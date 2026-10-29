// Cosmos — flares: tool errors (ART_DIRECTION §3.11, Gate 1b "make errors stand out").
//
// Meaning:
//   one new errors[] entry  → one magnetic-loop prominence (1.2 s: rise 0.25 s,
//                             hang, then the loop snaps open at the apex with a
//                             white crack) and throws a small CME: a thin shock
//                             ring that runs out across the orbit plane, brighter
//                             on the side the loop faced, through the planets
//                             and the belt (≈ 3.2 s).
//   STORM rule (lib/config.js; default ≥ 3 errors within 20 s) → FLARE STORM: the
//                             star is caged in 6–12 crossing loops that keep
//                             re-erupting, with lightning-like crackle along
//                             them, a flickering red-violet limb glow, and a
//                             shock ring rippling out every ~1–2 s. stormLevel
//                             feeds Star.setStormLevel (surface mottling, corona
//                             jitter). Holds until 10 s after the last error,
//                             then decays 2 s.
//
// Colour story: ERROR magenta, red-violet, white. Never the reserved orange,
// never along the poles (nothing reads as a jet), and every brightness change
// is noise-driven (aperiodic): rule 2 reserves the slow periodic pulse for the
// quasar.
//
// Rendering, 4 draws while active, 0 when idle (meshes hidden):
//   loops : one InstancedMesh, MAX_LOOPS tubes
//   rings : one InstancedMesh, MAX_RINGS flat quads in the orbit plane
//   glow  : one camera-facing quad (limb glow; it carries the effect from afar)
//   tint  : one camera-facing quad, multiplied over the disk (white -> ERROR)
// Per-instance birth/life live in instanced attributes written only on spawn;
// nothing is uploaded per frame except a handful of uniforms.
// Lifecycles run on the DATA clock (state.now − event.t), so a paused or held
// replay frame freezes everything and scrubbing is exact. float32 can't hold
// epoch seconds, so data times are relative to an anchor (re-based every ~14 h).
// Plasma flow, crackle and flicker run on the render clock t.
//
// Optional hooks for other modules (StarSystem wires them; all backward compatible):
//   flares.onShock = (info) => {}   fired once per shock ring at spawn:
//       info = { birth, life, reach, inner, strength, kind, angle }
//       birth: data-clock epoch seconds when the front leaves the star;
//       front radius at data time T: Flares.shockRadius(T − birth, life, inner, reach)
//   flares.shockAt(r) -> 0..1       strength of any shock front passing the
//                                   system-local orbit radius r right now
//                                   (planets: aurora rim flash; belt: jostle).
//   flares.shockFronts -> Float32Array [radius, strength] × MAX_RINGS, refreshed
//                                   every update (strength 0 = no ring); sized
//                                   for a vec2[6] shader uniform (belt jostle).

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { hash01, mulberry32 } from '../lib/math.js';
import { STORM } from '../lib/config.js';

const MAX_LOOPS = 14;     // up to 12 storm cage loops + 2 singles
const MAX_RINGS = 6;
const SINGLE_LIFE = 2.8;   // long enough to be noticed: rises, hangs, snaps
const SNAP_AT = 0.62;     // fraction of a loop's life when it tears open
const RING_LIFE = 3.2;
const STORM_COUNT = STORM.count;
const STORM_WINDOW = STORM.windowS;
const STORM_HOLD = STORM.holdS;
const STORM_DECAY = STORM.decayS;
const SPAN = THREE.MathUtils.degToRad(32);   // footpoint separation on the surface
const RISE = 0.6;                            // base loop apex height in star radii (× aShape.x)
const SINGLE_HEIGHT = 2.6;                   // single loops stand well off the limb, against dark space
const TINT_SIZE = 2.0;                       // disk-tint quad half-size in star radii
const MAX_LAT = THREE.MathUtils.degToRad(50);
const CAGE_LAT = Math.sin(THREE.MathUtils.degToRad(55));
const DEFAULT_REACH = 15;                    // system units: just past the belt's outer edge

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Canonical loop in the star's local frame: centred on +Y, spanning along X.
class LoopCurve extends THREE.Curve {
  getPoint(s, target = new THREE.Vector3()) {
    const psi = Math.PI * s;
    const phi = -Math.cos(psi) * SPAN * 0.5;
    const h = 0.97 + (RISE + 0.03) * Math.sin(psi);   // feet sink just under the photosphere
    const z = 0.07 * Math.sin(2 * psi);
    return target.set(Math.sin(phi) * h, Math.cos(phi) * h, z);
  }
}

const NOISE = /* glsl */ `
float fl_hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float fl_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fl_hash(i), fl_hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(fl_hash(i + vec3(0.0, 1.0, 0.0)), fl_hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(fl_hash(i + vec3(0.0, 0.0, 1.0)), fl_hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(fl_hash(i + vec3(0.0, 1.0, 1.0)), fl_hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
const vec3 FL_VIOLET = vec3(0.62, 0.16, 1.0);
`;

// ───────────────────────────── loops ─────────────────────────────

const LOOP_VERT = /* glsl */ `
attribute vec4 aInfo;     // birth (data clock − anchor), life, seed, kind (0 single, 1 storm)
attribute vec2 aShape;    // height multiplier, thickness multiplier
uniform float uDataT;
uniform float uStarR;
varying float vS;
varying float vAge;
varying float vLife;
varying float vSeed;
varying float vKind;
varying vec3 vN;
varying vec3 vV;
void main() {
  float age = uDataT - aInfo.x;
  float life = aInfo.y;
  vS = uv.x; vAge = age; vLife = life; vSeed = aInfo.z; vKind = aInfo.w;
  if (age < 0.0 || age > life || life <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // dead slot: outside the clip volume
    return;
  }
  float p = age / life;
  float apex = sin(3.14159265 * uv.x);
  vec3 pos = position + normal * 0.03 * aShape.y * (0.9 * apex - 0.4);
  float rise = 1.0 - pow(1.0 - clamp(age / 0.25, 0.0, 1.0), 3.0);
  float snap = smoothstep(${SNAP_AT.toFixed(2)}, 1.0, p);
  float L = length(pos);
  vec3 dir = pos / L;
  float h = (L - 1.0) * rise * aShape.x * (1.0 + 0.6 * snap * apex);
  pos = dir * (1.0 + h) * uStarR;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const LOOP_FRAG = /* glsl */ `
uniform float uTime;
uniform float uStorm;
uniform vec3 uErr;
varying float vS;
varying float vAge;
varying float vLife;
varying float vSeed;
varying float vKind;
varying vec3 vN;
varying vec3 vV;
${NOISE}
void main() {
  float p = vAge / vLife;
  float snap = smoothstep(${SNAP_AT.toFixed(2)}, 1.0, p);
  if (abs(vS - 0.5) < snap * 0.32) discard;

  float nv = abs(dot(normalize(vN), normalize(vV)));
  float core = pow(nv, 1.5);
  float leg = abs(vS - 0.5);
  float flow = fl_noise(vec3(leg * 14.0 + uTime * 3.0, vSeed * 37.0, uTime * 0.4))
             * 0.6 + 0.4 * fl_noise(vec3(vS * 31.0, vSeed * 11.0, uTime * 1.3));
  float fz = min(vS, 1.0 - vS) / 0.07;
  float feet = exp(-fz * fz);
  // Storm loops lean red-violet in patches; singles stay hot magenta.
  float vio = vKind * 0.55 * fl_noise(vec3(vS * 6.0, vSeed * 29.0, uTime * 0.7));
  vec3 base = mix(uErr, FL_VIOLET, vio);
  vec3 col = mix(base, vec3(1.0), clamp(feet * 0.85 + core * core * 0.2, 0.0, 1.0));

  float env = smoothstep(0.0, 0.06, vAge) * (1.0 - smoothstep(0.7, 1.0, p));
  float flick = fl_noise(vec3(uTime * 2.0, vSeed * 53.0, vKind * 7.0));
  float storm = mix(1.0, uStorm * (0.45 + 0.9 * flick), vKind);
  float lum = 6.2 * mix(1.7, 1.0, vKind) * env * storm * (0.45 + 0.75 * flow) * (0.35 + 0.65 * core) * (0.85 + 0.15 * flick);

  // Crackle: white sparks that jump along the spine on a stepped (aperiodic)
  // clock, like lightning walking the field line. Storm loops crackle all
  // the time; a single loop cracks once, at the moment it snaps.
  float stepT = floor(uTime * 13.0 + vSeed * 7.0);
  float z1 = fl_noise(vec3(vS * 26.0, stepT * 1.7, vSeed * 91.0));
  float z2 = fl_noise(vec3(vS * 7.0 + 3.0, stepT * 0.9, vSeed * 17.0));
  float spark = smoothstep(0.6, 0.82, z1) * step(0.42, z2) * core * core;
  float snapCrack = exp(-pow((p - ${SNAP_AT.toFixed(2)}) / 0.07, 2.0));
  float zap = spark * env * mix(snapCrack * 1.4, uStorm, vKind);
  col = col * lum + vec3(1.0, 0.9, 1.0) * zap * 6.5;
  gl_FragColor = vec4(min(col, vec3(7.0)), 1.0);
}
`;

// ───────────────────────────── shock rings ─────────────────────────────

const RING_VERT = /* glsl */ `
attribute vec4 aRing;     // birth (data clock − anchor), life, reach, seed
attribute vec4 aRing2;    // strength, kind, CME direction (angle in XZ), inner radius
uniform float uDataT;
varying vec2 vP;
varying float vP01;
varying vec4 vR;
varying vec4 vR2;
void main() {
  float age = uDataT - aRing.x;
  if (age < 0.0 || age > aRing.y || aRing.y <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vP01 = age / aRing.y;
  vR = aRing; vR2 = aRing2;
  vP = position.xy * aRing.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vP.x, 0.0, vP.y, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uErr;
varying vec2 vP;
varying float vP01;
varying vec4 vR;
varying vec4 vR2;
${NOISE}
void main() {
  float p = vP01;
  float reach = vR.z;
  float inner = vR2.w;
  float r = length(vP);
  if (r < inner * 0.9) discard;
  // Front: fast off the star, slowing as it spreads (matches Flares.shockRadius).
  float e = 1.0 - (1.0 - p) * (1.0 - p);
  float R = inner + (reach - inner) * e;
  // First ~1 s (p < 0.34 of 3.2 s): a thick, hot magenta band that visibly
  // sweeps across the disk and the belt; then it thins to the old fine front.
  float early = 1.0 - smoothstep(0.16, 0.42, p);
  float w = (0.10 + 0.32 * p) * (1.0 + 3.0 * early);
  float d = r - R;
  if (d > w * 3.0) discard;
  float front = exp(-d * d / (w * w));
  float wake = d < 0.0 ? exp(d / (0.8 + 2.4 * p)) * 0.22 : 0.0;
  float ang = atan(vP.y, vP.x);
  // A CME is lopsided: brightest on the side the loop faced (singles only).
  float lobe = mix(0.35 + 0.65 * pow(0.5 + 0.5 * cos(ang - vR2.z), 2.0), 1.0, vR2.y * 0.6);
  float brk = 0.45 + 0.75 * fl_noise(vec3(cos(ang) * 4.0 + vR.w * 40.0, sin(ang) * 4.0, r * 0.5 - uTime * 0.6));
  float fade = smoothstep(0.0, 0.04, p) * pow(1.0 - p, 1.4);
  float edge = clamp(-d / w, 0.0, 1.0);
  vec3 col = mix(vec3(1.0, 0.94, 1.0), uErr, edge);
  col = mix(col, FL_VIOLET, clamp(-d / (w * 4.0), 0.0, 1.0) * 0.8);
  col = mix(col, uErr, early * 0.95);
  float lum = vR2.x * fade * lobe * brk * (front * 2.6 + wake) * (1.0 + 1.2 * early);
  gl_FragColor = vec4(col * lum, 1.0);
}
`;

// ───────────────────────────── limb glow ─────────────────────────────

const GLOW_VERT = /* glsl */ `
uniform float uStarR;
uniform float uSize;
varying vec2 vQ;
void main() {
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  c.z += uStarR * 1.15;          // sit just in front of the star so it isn't depth-hidden
  c.xy += position.xy * uSize;
  vQ = position.xy * uSize / max(uStarR, 1e-3);
  gl_Position = projectionMatrix * c;
}
`;

const GLOW_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGlow;
uniform float uStorm;
uniform float uSeed;
uniform vec3 uErr;
varying vec2 vQ;
${NOISE}
void main() {
  float d = length(vQ);
  float a = atan(vQ.y, vQ.x);
  float out1 = max(d - 1.0, 0.0);
  // Hollow: a thin wash over the disk, a hot rim at the limb, a long falloff outside.
  float limb = d < 1.0 ? 0.10 * d * d * d : exp(-out1 * 3.2);
  float haze = exp(-out1 * 1.8) * 0.07;
  // Ragged streamers (storm): angular noise, re-rolled aperiodically.
  float n = fl_noise(vec3(cos(a) * 5.0 + uSeed, sin(a) * 5.0, uTime * 1.1));
  float rays = pow(n, 4.0) * exp(-out1 * 1.7) * uStorm * 1.4 * step(1.0, d);
  float flick = 0.7 + 0.6 * fl_noise(vec3(uTime * 3.1, uSeed, 0.0));
  vec3 col = mix(uErr, FL_VIOLET, clamp(out1 * 0.5, 0.0, 0.75));
  col = mix(col, vec3(1.0), exp(-out1 * 6.0) * 0.5 * step(1.0, d));
  float lum = uGlow * flick * (limb * 1.5 + haze + rays);
  if (lum < 0.002) discard;
  gl_FragColor = vec4(col * lum, 1.0);
}
`;

// ───────────────────────────── disk tint ─────────────────────────────
// Multiplied over the star's disk and inner corona (DstColor × src), so an
// error or storm pulls the white photosphere toward ERROR magenta and lowers
// its brightness instead of adding more white for bloom to blow out.

const TINT_FRAG = /* glsl */ `
uniform float uTint;
uniform vec3 uErr;
varying vec2 vQ;
void main() {
  float d = length(vQ);
  // full strength over the disk, easing out through the inner corona
  // The disk is HDR (several × white), so a linear mix barely dents it:
  // ease the strength in hard so even a brief flash reads magenta.
  float t = 1.0 - pow(1.0 - clamp(uTint, 0.0, 1.0), 3.0);
  float k = t * (1.0 - smoothstep(0.95, ${TINT_SIZE.toFixed(1)}, d) * 0.85);
  vec3 target = uErr * 0.55;                // dimmer than white, hue = ERROR
  gl_FragColor = vec4(mix(vec3(1.0), target, k), 1.0);
}
`;

export class Flares {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx
   * @param {{ starRadius?: () => number, reach?: () => number, seed?: string }} opts
   *   reach: optional system-local radius the shock rings travel out to (default 15,
   *   just past the belt). StarSystem can pass the belt's outer edge.
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this._starRadius = typeof opts.starRadius === 'function' ? opts.starRadius : () => 1;
    this._reach = typeof opts.reach === 'function' ? opts.reach : () => DEFAULT_REACH;
    this._seed = opts.seed != null ? String(opts.seed) : null;
    /** Optional: (info) => void, fired once per shock ring (see header). */
    this.onShock = null;

    this.root = new THREE.Group();
    this.root.name = 'Flares';
    parent.add(this.root);

    const low = ctx.quality === 'low';
    const errCol = color('ERROR');

    // ── loops ──
    this._geo = new THREE.TubeGeometry(new LoopCurve(), low ? 40 : 64, 0.03, low ? 6 : 8, false);
    this._info = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LOOPS * 4), 4);
    this._shape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LOOPS * 2), 2);
    this._geo.setAttribute('aInfo', this._info);
    this._geo.setAttribute('aShape', this._shape);
    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDataT: { value: 0 },
        uStarR: { value: 1 },
        uStorm: { value: 0 },
        uErr: { value: errCol },
      },
      vertexShader: LOOP_VERT,
      fragmentShader: LOOP_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._mesh = new THREE.InstancedMesh(this._geo, this._mat, MAX_LOOPS);
    this._mesh.frustumCulled = false;
    this.root.add(this._mesh);

    // ── shock rings ──
    this._ringGeo = new THREE.PlaneGeometry(2, 2);
    this._ringA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 4), 4);
    this._ringB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 4), 4);
    this._ringGeo.setAttribute('aRing', this._ringA);
    this._ringGeo.setAttribute('aRing2', this._ringB);
    this._ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._mat.uniforms.uTime,
        uDataT: this._mat.uniforms.uDataT,
        uErr: { value: errCol },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this._rings = new THREE.InstancedMesh(this._ringGeo, this._ringMat, MAX_RINGS);
    this._rings.frustumCulled = false;
    this.root.add(this._rings);

    // ── limb glow ──
    this._glowGeo = new THREE.PlaneGeometry(2, 2);
    this._glowMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._mat.uniforms.uTime,
        uStarR: this._mat.uniforms.uStarR,
        uStorm: this._mat.uniforms.uStorm,
        uSize: { value: 1 },
        uGlow: { value: 0 },
        uSeed: { value: 0 },
        uErr: { value: errCol },
      },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._glow = new THREE.Mesh(this._glowGeo, this._glowMat);
    this._glow.frustumCulled = false;
    // After the star's own glow (renderOrder 2), before the quasar jets (3).
    this._glow.renderOrder = 2.6;
    this.root.add(this._glow);

    // ── disk tint (multiply) ──
    this._tintMat = new THREE.ShaderMaterial({
      uniforms: {
        uStarR: this._mat.uniforms.uStarR,
        uSize: { value: 1 },
        uTint: { value: 0 },
        uErr: { value: errCol },
      },
      vertexShader: GLOW_VERT,
      fragmentShader: TINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
    });
    this._tint = new THREE.Mesh(this._glowGeo, this._tintMat);
    this._tint.frustumCulled = false;
    this._tint.renderOrder = 2.5;
    this._tint.visible = false;
    this.root.add(this._tint);

    // CPU mirrors (data clock − anchor).
    this._birth = new Float32Array(MAX_LOOPS).fill(-1e9);
    this._life = new Float32Array(MAX_LOOPS);
    this._kind = new Uint8Array(MAX_LOOPS);
    this._rBirth = new Float32Array(MAX_RINGS).fill(-1e9);
    this._rLife = new Float32Array(MAX_RINGS);
    /** [radius, strength] × MAX_RINGS, system-local; refreshed every update. */
    this.shockFronts = new Float32Array(MAX_RINGS * 2);

    // scratch
    this._m4 = new THREE.Matrix4();
    this._x = new THREE.Vector3();
    this._y = new THREE.Vector3();
    this._z = new THREE.Vector3();

    this._seen = new Set();
    this._rand = mulberry32(1);
    this._lastNow = null;
    this._stormLevel = 0;
    this._stormUntil = -Infinity;
    this._stormLastErr = -Infinity;
    this._stormLoops = 0;
    this._stormKey = '';
    this._stormSlot = 0;
    this._nextStormRing = Infinity; // data clock − anchor
    this._anchor = null;
    this._disposed = false;
    this._mesh.visible = false;
    this._rings.visible = false;
    this._glow.visible = false;
  }

  /** 0..1: rises when ≥ 3 errors land within 20 s, holds to last error + 10 s, decays over 2 s. */
  get stormLevel() { return this._stormLevel; }

  /**
   * Shock-front radius `age` seconds after it leaves the star (system-local units).
   * Same easing as the ring shader.
   */
  static shockRadius(age, life, inner, reach) {
    const p = clamp01(age / life);
    const e = 1 - (1 - p) * (1 - p);
    return inner + (reach - inner) * e;
  }

  /** 0..1: how hard a shock front is hitting orbit radius r right now. */
  shockAt(r) {
    let best = 0;
    const f = this.shockFronts;
    for (let i = 0; i < MAX_RINGS; i++) {
      const s = f[i * 2 + 1];
      if (s <= 0) continue;
      const d = (r - f[i * 2]) / 0.7;
      const v = s * Math.exp(-d * d);
      if (v > best) best = v;
    }
    return best;
  }

  update(state, dt, t) {
    if (this._disposed) return 0;
    const now = state.now;
    if (this._lastNow !== null && now < this._lastNow - 1e-6) this.reset();
    this._lastNow = now;
    if (this._seed === null) {
      this._seed = String(state.id ?? 'session');
      this._rand = mulberry32(Math.floor(hash01('flares:' + this._seed) * 4294967296));
    }
    if (this._glowSeedFor !== this._seed) {
      this._glowSeedFor = this._seed;
      this._glowMat.uniforms.uSeed.value = hash01('glow:' + this._seed) * 50;
    }

    if (this._anchor === null) this._anchor = now;
    if (now - this._anchor > 50000) this._rebase(now);
    const dn = now - this._anchor;
    const errs = state.errors || [];
    const starR = Math.max(0, Number(this._starRadius()) || 0);

    // ── single flares: one per new error, only while it is still young ──
    let latest = -Infinity;
    for (let i = 0; i < errs.length; i++) {
      const e = errs[i];
      if (!(e.t <= now)) continue;
      if (e.t > latest) latest = e.t;
      const key = e.id != null ? String(e.id) : String(e.t);
      if (this._seen.has(key)) continue;
      this._seen.add(key);
      const age = now - e.t;
      // The loop lives 1.2 s, but its CME ring runs longer: spawn while either is visible.
      if (age < SINGLE_LIFE * SNAP_AT + RING_LIFE * 1.25) this._spawnSingle(key, e.t - this._anchor, dn, starR, age < SINGLE_LIFE);
    }
    if (this._seen.size > 1024) this._pruneSeen(errs);

    // ── storm: ≥ STORM_COUNT errors in the STORM_WINDOW s ending at the latest one ──
    if (latest > -Infinity) {
      let count = 0;
      for (let i = 0; i < errs.length; i++) {
        const et = errs[i].t;
        if (et <= latest && et >= latest - STORM_WINDOW) count++;
      }
      const storming = now <= this._stormUntil;
      if (count >= STORM_COUNT || (storming && latest > this._stormLastErr)) {
        if (!storming) {
          this._stormKey = String(latest);
          this._stormSlot = 0;
          this._nextStormRing = dn;     // first ripple right away
        }
        this._stormUntil = Math.max(this._stormUntil, latest + STORM_HOLD);
        this._stormLastErr = latest;
        this._stormLoops = Math.min(12, 6 + 2 * Math.max(0, count - STORM_COUNT));
      }
    }
    let target = 0;
    if (now <= this._stormUntil) target = 1;
    else if (this._stormUntil > -Infinity) target = Math.max(0, 1 - (now - this._stormUntil) / STORM_DECAY);
    if (target > this._stormLevel) this._stormLevel += (target - this._stormLevel) * (1 - Math.exp(-dt / 0.25));
    else this._stormLevel = target;
    if (this._stormLevel < 1e-3 && target === 0) this._stormLevel = 0;

    // ── storm cage: keep many loops erupting while the storm holds ──
    if (target >= 1) {
      let live = 0;
      for (let i = 0; i < MAX_LOOPS; i++) {
        const a = dn - this._birth[i];
        if (this._kind[i] === 1 && a >= 0 && a < this._life[i]) live++;
      }
      const spread = live === 0 ? 0.9 : 0.2;
      for (let n = 0; live < this._stormLoops && n < 12; n++, live++) {
        this._spawnStorm(dn - 0.02 - this._rand() * spread, dn);
      }
      // Ripples through the belt: one shock ring every 1.0–1.9 s (data clock).
      if (this._nextStormRing < dn - 3) this._nextStormRing = dn;   // after a held frame / jump
      while (this._nextStormRing <= dn) {
        this._spawnRing(this._nextStormRing, RING_LIFE * 0.9, 0.75, 1, this._rand() * Math.PI * 2, starR);
        this._nextStormRing += 1.0 + this._rand() * 0.9;
      }
    } else {
      this._nextStormRing = Infinity;
    }

    // ── per-frame state: visibility, glow, shock fronts ──
    let loopsAlive = false;
    let flash = 0;
    for (let i = 0; i < MAX_LOOPS; i++) {
      const a = dn - this._birth[i];
      if (!(a >= 0 && a < this._life[i])) continue;
      loopsAlive = true;
      if (this._kind[i] === 0) {
        const p = a / this._life[i];
        const k = (p - SNAP_AT) / 0.12;
        flash = Math.max(flash, 0.35 * clamp01(a / 0.25) + 0.9 * Math.exp(-k * k));
      }
    }
    let ringsAlive = false;
    let ringEarly = 0;
    const fr = this.shockFronts;
    const rb = this._ringB.array;
    for (let i = 0; i < MAX_RINGS; i++) {
      const a = dn - this._rBirth[i];
      const life = this._rLife[i];
      if (a >= 0 && a < life) {
        ringsAlive = true;
        const p = a / life;
        fr[i * 2] = Flares.shockRadius(a, life, rb[i * 4 + 3], this._ringA.array[i * 4 + 2]);
        fr[i * 2 + 1] = rb[i * 4] * Math.pow(1 - p, 1.4);
        if (rb[i * 4 + 1] === 0) ringEarly = Math.max(ringEarly, 1 - clamp01((a - 0.3) / 0.8));
      } else {
        fr[i * 2] = 0;
        fr[i * 2 + 1] = 0;
      }
    }

    const u = this._mat.uniforms;
    u.uTime.value = t;
    u.uDataT.value = dn;
    u.uStorm.value = this._stormLevel;
    u.uStarR.value = starR;
    const glow = Math.max(Math.min(flash * 1.4, 1.25), this._stormLevel * 0.7);
    const g = this._glowMat.uniforms;
    g.uGlow.value = glow;
    g.uSize.value = starR * (3.2 + 1.3 * this._stormLevel);
    // Disk tint: storm holds it; a single error tints through its loop and the
    // first second of its CME, so even one error reads magenta, not white.
    const tint = Math.max(this._stormLevel * 0.85, Math.min(flash, 1) * 0.7, ringEarly * 0.6);
    this._tintMat.uniforms.uTint.value = tint;
    this._tintMat.uniforms.uSize.value = starR * TINT_SIZE;
    const hasStar = starR > 0.01;
    this._mesh.visible = loopsAlive && hasStar;
    this._rings.visible = ringsAlive;
    this._glow.visible = glow > 0.01 && hasStar;
    this._tint.visible = tint > 0.01 && hasStar;
    return loopsAlive || ringsAlive || this._stormLevel > 0 ? 2 : 0;
  }

  // Deterministic placement from the error id, outside the polar caps.
  _spawnSingle(key, birth, dn, starR, withLoop) {
    const lat = (hash01('lat:' + key) * 2 - 1) * MAX_LAT;
    const lon = hash01('lon:' + key) * Math.PI * 2;
    const roll = hash01('roll:' + key) * Math.PI * 2;
    this._y.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    if (withLoop) {
      const slot = this._pickSlot(dn, false);
      this._write(slot, birth, SINGLE_LIFE, hash01('seed:' + key), 0, SINGLE_HEIGHT, 2.1, roll);
    }
    // The CME leaves when the loop snaps, toward the side the loop faced.
    this._spawnRing(birth + SINGLE_LIFE * SNAP_AT, RING_LIFE * 1.25, 1.7, 0, lon, starR);
  }

  // Storm loops cage the star: a golden-angle scatter over ±55° latitude with
  // random roll, so the arcs cross each other instead of forming one band.
  _spawnStorm(birth, dn) {
    const k = this._stormSlot++;
    const off = hash01('cage:' + this._stormKey);
    const f = ((k * 0.6180339887 + off) % 1) * 2 - 1;
    const lat = Math.asin(f * CAGE_LAT);
    const lon = k * 2.399963 + off * 6.283 + (this._rand() - 0.5) * 0.5;
    this._y.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    const slot = this._pickSlot(dn, true);
    const life = 1.0 + this._rand() * 0.9;
    const height = 1.4 + this._rand() * 1.0;   // most of each arc stands off the limb
    const thick = 1.0 + this._rand() * 0.6;
    this._write(slot, birth, life, this._rand(), 1, height, thick, this._rand() * Math.PI * 2);
  }

  _spawnRing(birth, life, strength, kind, angle, starR) {
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < MAX_RINGS; i++) {
      const a = birth - this._rBirth[i];
      if (a >= this._rLife[i] || this._rBirth[i] < -1e8) { slot = i; oldest = -Infinity; break; }
      if (this._rBirth[i] < oldest) { oldest = this._rBirth[i]; slot = i; }
    }
    const reach = Math.max(starR * 2, Number(this._reach()) || DEFAULT_REACH);
    const inner = Math.max(0.05, starR * 1.3);
    const seed = this._rand();
    this._rBirth[slot] = birth;
    this._rLife[slot] = life;
    const a = this._ringA.array;
    a[slot * 4] = birth;
    a[slot * 4 + 1] = life;
    a[slot * 4 + 2] = reach;
    a[slot * 4 + 3] = seed;
    this._ringA.needsUpdate = true;
    const b = this._ringB.array;
    b[slot * 4] = strength;
    b[slot * 4 + 1] = kind;
    b[slot * 4 + 2] = angle;
    b[slot * 4 + 3] = inner;
    this._ringB.needsUpdate = true;
    if (typeof this.onShock === 'function') {
      try {
        this.onShock({ birth: birth + this._anchor, life, reach, inner, strength, kind, angle });
      } catch (err) {
        console.warn('flares.onShock', err);
      }
    }
  }

  // Free slot first; otherwise steal the oldest (storm loops before single flares).
  _pickSlot(dn, forStorm) {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < MAX_LOOPS; i++) {
      const dead = dn - this._birth[i] >= this._life[i];
      if (dead) return i;
      const score = this._birth[i] + (this._kind[i] === 0 && forStorm ? 1e6 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  _write(slot, birth, life, seed, kind, height, thick, roll) {
    const y = this._y.normalize();
    this._x.set(Math.abs(y.y) < 0.9 ? 0 : 1, Math.abs(y.y) < 0.9 ? 1 : 0, 0).cross(y).normalize();
    this._x.applyAxisAngle(y, roll);
    this._x.addScaledVector(y, -this._x.dot(y)).normalize();
    this._z.crossVectors(this._x, y);
    this._m4.makeBasis(this._x, y, this._z);
    this._mesh.setMatrixAt(slot, this._m4);
    this._mesh.instanceMatrix.needsUpdate = true;

    this._birth[slot] = birth;
    this._life[slot] = life;
    this._kind[slot] = kind;
    const a = this._info.array;
    a[slot * 4] = birth;
    a[slot * 4 + 1] = life;
    a[slot * 4 + 2] = seed;
    a[slot * 4 + 3] = kind;
    this._info.needsUpdate = true;
    const b = this._shape.array;
    b[slot * 2] = height;
    b[slot * 2 + 1] = thick;
    this._shape.needsUpdate = true;
  }

  // Shift every stored birth so data times stay small (float32-safe).
  _rebase(now) {
    const d = now - this._anchor;
    this._anchor = now;
    const a = this._info.array;
    for (let i = 0; i < MAX_LOOPS; i++) {
      this._birth[i] -= d;
      a[i * 4] -= d;
    }
    this._info.needsUpdate = true;
    const r = this._ringA.array;
    for (let i = 0; i < MAX_RINGS; i++) {
      this._rBirth[i] -= d;
      r[i * 4] -= d;
    }
    this._ringA.needsUpdate = true;
    if (this._nextStormRing !== Infinity) this._nextStormRing -= d;
  }

  _pruneSeen(errs) {
    this._seen.clear();
    for (let i = 0; i < errs.length; i++) {
      const e = errs[i];
      this._seen.add(e.id != null ? String(e.id) : String(e.t));
    }
  }

  reset() {
    this._seen.clear();
    this._lastNow = null;
    this._birth.fill(-1e9);
    this._life.fill(0);
    this._kind.fill(0);
    this._info.array.fill(0);
    this._info.needsUpdate = true;
    this._rBirth.fill(-1e9);
    this._rLife.fill(0);
    this._ringA.array.fill(0);
    this._ringA.needsUpdate = true;
    this.shockFronts.fill(0);
    this._stormLevel = 0;
    this._stormUntil = -Infinity;
    this._stormLastErr = -Infinity;
    this._stormLoops = 0;
    this._nextStormRing = Infinity;
    this._anchor = null;
    this._mesh.visible = false;
    this._rings.visible = false;
    this._glow.visible = false;
    this._tint.visible = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    this._geo.dispose();
    this._mat.dispose();
    this._mesh.dispose();
    this._ringGeo.dispose();
    this._ringMat.dispose();
    this._rings.dispose();
    this._glowGeo.dispose();
    this._glowMat.dispose();
    this._tintMat.dispose();
  }
}
