// Cosmos — singularities: the compaction BLACK HOLE and the new-session WHITE HOLE.
//
// Meaning (ART_DIRECTION §3.9, §3.10):
//   BlackHole  one per recorded compaction. Forms on the asteroid belt, swallows a
//              sector of it (the tokens the compaction dropped), collapses with a
//              photon-ring flash and leaves a cleaner orbit. 9 s total.
//   WhiteHole  session birth (state.bornAt). An inverted black hole: light and
//              matter only ever move OUT, radially symmetric. 4 s total.
//
// Both are pure functions of the event's age on the DATA clock (state.now − event.t),
// so replay scrubbing, pausing and re-calling update() with the same state are
// all idempotent. The only one-shot side effect is BlackHole.onSwallow, guarded by
// a per-instance seen-set.
//
// ── Lensing approach (documented per the task brief) ──────────────────────────
// The black hole is a camera-aligned quad (12 units wide) drawn in the
// transparent pass. In its onBeforeRender hook it copies the colour buffer that
// is currently bound (the composer's linear-HDR target, i.e. everything already
// drawn behind it: background cubemap, star, disk, belt, planets) into a
// FramebufferTexture with renderer.copyFramebufferToTexture. The fragment
// shader then solves the point-lens equation  β = θ − θE²/θ  in the hole's view
// plane, projects the source point back to the screen and samples that copy.
// So the REAL scene behind the hole is lensed: the star, the belt and the back
// half of the hole's own accretion swirl wrap into an Einstein ring, and the
// swirl's far side arches over the horizon. The deflection tapers to zero at
// the quad's rim, where the sampled point equals the pixel itself, so the quad
// has no visible edge. Points that project off-screen fall back to the baked
// background cubemap (ctx.starfieldCube) along the deflected ray.
// If the bound target can't be copied (multisampled render target), the shader
// falls back to cubemap-only lensing with a soft alpha rim (the ART_DIRECTION
// §3.9 baseline: background lensed, foreground not).
// Cost: one framebuffer copy per frame, only during the ~7 s the hole is visible.
//
// Smoothness (Gate 1 review): the shadow edge IS the photon ring, an analytic
// Gaussian never thinner than ~1.2 px; the lensed sample is low-passed with
// three radial taps scaled by the lens' radial compression, so the Einstein
// ring and secondary image don't sparkle. The swirl is drawn once, AFTER the
// lens (never lensed into fragments); its far half is clipped by the shadow
// analytically, and the lensed far side of the disk is an analytic arc over
// the shadow in the lens shader. Both meshes share one world position, so
// three.js' transparent sort (renderOrder → z → id) keeps creation order.
//
// Draw calls: black hole 2 (lens, swirl), white hole 2 (instanced core + 3
// shock shells, particles).

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { hash01, mulberry32 } from '../lib/math.js';

// ── timings (ART_DIRECTION §4) ────────────────────────────────────────────────
const BH_FORM = 1.5;
const BH_SWALLOW = 4.0;
const BH_COLLAPSE = 1.5;
const BH_SETTLE = 2.0;
const BH_T_SWALLOW = BH_FORM;                          // 1.5
const BH_T_COLLAPSE = BH_FORM + BH_SWALLOW;            // 5.5
const BH_T_GONE = BH_T_COLLAPSE + BH_COLLAPSE;         // 7.0
const BH_LIFE = BH_T_GONE + BH_SETTLE;                 // 9.0

// ── black-hole geometry (world units = star radii, at mass M = 1) ─────────────
const BH_QUAD_HALF = 6.0;      // 12-unit lens quad
const BH_HORIZON = 0.8;        // event-horizon (shadow) radius
const BH_EINSTEIN = 1.8;       // θE in horizon radii: the background ring sits outside the photon ring
const BH_SWIRL_IN = 1.25;      // swirl inner edge (just outside the 1.5·rh photon ring)
const BH_SWIRL_OUT = 2.9;      // thin: a bright inner swirl, the rocks show the infall
const BH_RING_BASE = 1.9;      // photon-ring luminance; bloom floods the shadow if this runs hotter
const BH_RING_FLASH = 3.8;

// ── white-hole timings and sizes ──────────────────────────────────────────────
const WH_LIFE = 4.0;
const WH_SEED_END = 0.3;
const WH_ERUPT_END = 1.5;
const WH_CONDENSE_END = 3.0;
const WH_SHELL_START = [0.3, 0.42, 0.6];
const WH_SHELL_DUR = 2.4;
const WH_SHELL_MAX_R = 10.0;
const WH_SHELL_PEAK = [2.4, 1.8, 1.3];

// ── tiny pure helpers (module-level functions are allowed; no state) ──────────
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inCubic = (x) => Math.pow(clamp01(x), 3);
const inOutCubic = (x) => {
  const v = clamp01(x);
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
};
const outExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(x)));

// Private value noise. Prefixed so it can't collide with lib/glsl.js symbols if
// the integrator ever concatenates chunks. Octave count comes from a #define so
// quality 'low' compiles a cheaper loop.
const NOISE_GLSL = /* glsl */ `
float phz_hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float phz_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(phz_hash(i + vec3(0.0, 0.0, 0.0)), phz_hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(phz_hash(i + vec3(0.0, 1.0, 0.0)), phz_hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(phz_hash(i + vec3(0.0, 0.0, 1.0)), phz_hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(phz_hash(i + vec3(0.0, 1.0, 1.0)), phz_hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
// Normalised to ~0..1.
float phz_fbm(vec3 p) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < PHZ_OCT; i++) {
    s += a * phz_noise(p);
    n += a;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / n;
}
`;

const octavesFor = (quality) => (quality === 'low' ? 3 : 4);

// ═════════════════════════════════════════════════════════════════════════════
// Black hole
// ═════════════════════════════════════════════════════════════════════════════

const LENS_VERT = /* glsl */ `
uniform float uHalf;
varying vec2 vB;        // offset from the hole centre in the view plane (world units)
varying vec3 vC;        // hole centre in view space
varying float vSc;      // world scale of the system (1 in Gate 1)
void main() {
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vSc = length(modelViewMatrix[0].xyz);
  vC = c.xyz;
  vB = position.xy * uHalf * vSc;
  gl_Position = projectionMatrix * (c + vec4(vB, 0.0, 0.0));
}
`;

const LENS_FRAG = /* glsl */ `
uniform sampler2D uGrab;
uniform samplerCube uCube;
uniform mat4 uProj;
uniform float uMode;       // 1 = screen-space copy available, 0 = cubemap only
uniform float uHasCube;
uniform float uFlip;       // cubemap x flip (render-target cubes are not flipped)
uniform float uHalf;
uniform float uRh;         // horizon radius (world, mass-scaled)
uniform float uThetaE;     // Einstein radius (world, mass-scaled)
uniform float uRingLum;
uniform float uArc;        // lensed far-disk arc brightness (follows the feed)
uniform float uTime;
uniform vec2 uSpin;        // system +Y axis in view space (xy), for ring beaming
uniform vec3 uRingColor;
varying vec2 vB;
varying vec3 vC;
varying float vSc;

vec3 skyAt(vec3 p) {
  vec3 dirW = (vec4(normalize(p), 0.0) * viewMatrix).xyz;   // view → world (transpose of rotation)
  return uHasCube * textureCube(uCube, vec3(uFlip * dirW.x, dirW.yz)).rgb;
}
// Colour of whatever is behind the lens at view-space point p (on the lens plane).
// near = 1 inside the hole's own neighbourhood on the source plane: there the
// screen copy holds the infalling rocks and the swirl, which the lens would
// smear into jagged white arcs, so the baked sky stands in (the hole's own
// matter is drawn analytically: photon ring, far-disk arc, swirl).
vec3 sceneAt(vec3 p, float near) {
  vec4 clip = uProj * vec4(p, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  bool inside = clip.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
  vec3 sky = skyAt(p);
  if (uMode > 0.5 && inside) return mix(texture2D(uGrab, uv).rgb, sky, near);
  // Off-screen (or no copy): follow the deflected ray to the baked sky.
  return sky;
}

void main() {
  float hw = uHalf * vSc;
  float b = length(vB);
  if (b > hw) discard;
  float rh = uRh * vSc;
  float te = uThetaE * vSc;
  vec2 dir = vB / max(b, 1e-5);
  float px = max(fwidth(b), 1e-5);           // one pixel, in world units at the lens plane
  float rr = 1.5 * rh;                        // photon ring = apparent shadow edge

  // Point-lens equation β = θ − θE²/θ. Deflection tapers to 0 at the rim so the
  // sampled point converges on the pixel itself: no seam. β(θ) stays monotonic.
  float taper = 1.0 - smoothstep(0.3 * hw, 0.97 * hw, b);
  float bb = max(b, rr);
  float defl = te * te / bb * taper;
  vec2 beta = vB - dir * defl;
  // Radial compression dβ/dθ = 1 + θE²/θ²: one pixel here spans this much of
  // the source. Three taps across that span low-pass it, so the secondary
  // image and the Einstein ring stay smooth instead of sparkling.
  float spread = px * (1.0 + te * te / (bb * bb)) * taper * 0.36;
  float near = 1.0 - smoothstep(1.7 * rh, 3.2 * rh, length(beta));
  vec3 lensed = sceneAt(vC + vec3(beta, 0.0), near) * 0.5
              + sceneAt(vC + vec3(beta + dir * spread, 0.0), near) * 0.25
              + sceneAt(vC + vec3(beta - dir * spread, 0.0), near) * 0.25;

  // Shadow: captured rays carry no light. Its edge is the photon ring itself,
  // anti-aliased over ~1.5 px so the rim is a clean circle at any distance.
  float open = smoothstep(rr - max(0.06 * rh, 1.5 * px), rr + 0.5 * px, b);
  lensed *= open;

  // Analytic photon ring: a smooth Gaussian at 1.5 rh, never thinner than
  // ~1.2 px (no stair-stepping), plus a faint higher-order ring just inside.
  // Relativistic beaming: the approaching side is brighter; a slow, gentle
  // azimuthal swell keeps it alive without any noise.
  vec2 sp = uSpin / max(length(uSpin), 1e-4);
  float approach = dot(dir, vec2(-sp.y, sp.x));
  float beam = pow(1.0 + 0.3 * approach, 2.0) / 1.69;
  float th = atan(dir.y, dir.x);
  float swell = 0.9 + 0.1 * cos(2.0 * th - uTime * 0.8);
  float w = max(0.055 * rh, 1.2 * px);
  float x1 = (b - rr) / w;
  float g1 = exp(-x1 * x1);
  float w2 = max(0.03 * rh, 1.0 * px);
  float x2 = (b - rr * 0.94) / w2;
  float g2 = 0.25 * exp(-x2 * x2);
  float halo = 0.08 * exp(-max(b - rr, 0.0) / (0.4 * rh)) * step(rr, b);

  // Lensed image of the disk's far side: a soft band hugging the ring,
  // brightest over the top (the side the disk normal points to on screen),
  // fainter underneath, strongest when the disk is seen edge-on.
  float up = dot(dir, sp);
  float arcW = 0.16 * rh + px;
  float xa = (b - rr * 1.13) / arcW;
  float arcShape = exp(-xa * xa) * (0.25 + 0.75 * smoothstep(-0.1, 0.95, up) + 0.3 * smoothstep(0.2, 0.95, -up));
  float edgeOn = clamp(length(uSpin), 0.0, 1.0);
  float arc = uArc * arcShape * (0.35 + 0.65 * edgeOn);

  vec3 ring = uRingColor * (uRingLum * (beam * swell * (g1 + g2) + halo) + arc * beam);

  // Premultiplied output (blend: ONE, ONE_MINUS_SRC_ALPHA). With the copy the
  // quad fully replaces what is behind it; cubemap-only fades out to the rim.
  float a = uMode > 0.5 ? 1.0
          : max(1.0 - open, uHasCube * (1.0 - smoothstep(0.45 * hw, 0.95 * hw, b)));
  gl_FragColor = vec4(lensed * a + ring, a);
}
`;

const SWIRL_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vP;
varying vec3 vView;
varying vec3 vTan;
varying vec3 vC;
varying float vSc;
void main() {
  vP = position.xz;
  vec3 p = position * uSize;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vC = c.xyz;
  vSc = length(modelViewMatrix[0].xyz);
  vView = mv.xyz;
  vTan = (modelViewMatrix * vec4(p.z, 0.0, -p.x, 0.0)).xyz;   // orbital velocity (ω along +Y)
  gl_Position = projectionMatrix * mv;
}
`;

const SWIRL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLum;
uniform float uShadow;     // shadow (photon-ring) radius, world, mass-scaled
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uCool;
varying vec2 vP;
varying vec3 vView;
varying vec3 vTan;
varying vec3 vC;
varying float vSc;

${NOISE_GLSL}

void main() {
  // The half of the disk behind the hole is hidden by its shadow: project the
  // fragment onto the hole's depth plane and test against the shadow radius.
  // (Drawn after the lens, so the swirl is never lensed into fragments.)
  vec2 q = vView.xy * (vC.z / min(vView.z, -1e-3)) - vC.xy;
  float rs = uShadow * vSc;
  float pxq = max(fwidth(length(q)), 1e-5);
  float behind = smoothstep(-0.15, 0.15, vC.z - vView.z);
  float occl = 1.0 - behind * (1.0 - smoothstep(rs - pxq, rs + pxq, length(q)));

  float r = length(vP);
  float th = atan(vP.y, vP.x);
  // Keplerian shear ω ∝ r^-1.5 on a trailing log-spiral: three smooth arms,
  // lightly broken up by low-frequency noise. Smooth by construction.
  float om = 2.2 / pow(r, 1.5);
  float a = th + om * uTime + log(r) * 2.2;
  float arms = 0.5 + 0.5 * cos(3.0 * a);
  float n = phz_fbm(vec3(cos(a) * 0.9, sin(a) * 0.9, log(r) * 3.0 + uTime * 0.25));
  float streak = mix(arms, n, 0.35);
  streak = smoothstep(0.25, 0.9, streak);

  float edge = smoothstep(${BH_SWIRL_IN.toFixed(2)}, ${(BH_SWIRL_IN + 0.12).toFixed(2)}, r)
             * (1.0 - smoothstep(${(BH_SWIRL_IN + 0.5).toFixed(2)}, ${BH_SWIRL_OUT.toFixed(2)}, r));
  float prof = pow(${BH_SWIRL_IN.toFixed(2)} / r, 3.0);
  // Infalling rock heats as it falls: cool rock glint → disk white → photon warm-white.
  vec3 col = mix(uHot, uMid, smoothstep(1.3, 1.8, r));
  col = mix(col, uCool, smoothstep(1.8, 2.6, r));

  // Doppler beaming (1 + β cosφ)^3, β = 0.4.
  float cosphi = dot(normalize(vTan), normalize(-vView));
  float beam = pow(1.0 + 0.4 * cosphi, 3.0);
  float lum = uLum * prof * (0.35 + 1.1 * streak) * beam * edge * occl;
  gl_FragColor = vec4(col * lum, 1.0);
}
`;

export class BlackHole {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx  ObjectContext (CONTRACT §3.1)
   * @param {{ beltRadius?: () => number, seed?: string }} opts
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this._beltRadius = typeof opts.beltRadius === 'function' ? opts.beltRadius : () => 11.5;
    /** @type {((info: {angle:number, fraction:number, duration:number, radius:number, position:{x:number,y:number,z:number}, id:string}) => void) | null} */
    this.onSwallow = null;

    this.root = new THREE.Group();
    this.root.name = 'BlackHole';
    parent.add(this.root);

    // All meshes sit at the anchor's origin: identical sort depth, creation order wins.
    this._anchor = new THREE.Group();
    this.root.add(this._anchor);

    const oct = octavesFor(ctx.quality);
    const defines = { PHZ_OCT: oct };

    // Swirl ring in the system's XZ plane.
    const segs = ctx.quality === 'low' ? 96 : 160;
    this._swirlGeo = new THREE.RingGeometry(BH_SWIRL_IN, BH_SWIRL_OUT, segs, 6);
    this._swirlGeo.rotateX(-Math.PI / 2);

    this._lensGeo = new THREE.PlaneGeometry(2, 2);
    this._lensMat = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uGrab: { value: null },
        uCube: { value: null },
        uProj: { value: new THREE.Matrix4() },
        uMode: { value: 0 },
        uHasCube: { value: 0 },
        uFlip: { value: 1 },
        uHalf: { value: BH_QUAD_HALF },
        uRh: { value: BH_HORIZON },
        uThetaE: { value: BH_HORIZON * BH_EINSTEIN },
        uRingLum: { value: BH_RING_BASE },
        uArc: { value: 0 },
        uTime: { value: 0 },
        uSpin: { value: new THREE.Vector2(0, 1) },
        uRingColor: { value: color('PHOTON_RING') },
      },
      vertexShader: LENS_VERT,
      fragmentShader: LENS_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });
    this._lens = new THREE.Mesh(this._lensGeo, this._lensMat);
    this._lens.frustumCulled = false;
    this._lens.onBeforeRender = (renderer, _scene, camera) => this._beforeLens(renderer, camera);
    this._anchor.add(this._lens);

    // Swirl after the lens (creation order = draw order at equal depth): it is
    // never lensed, and its far half is clipped by the shadow in its shader.
    this._swirlMat = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uSize: { value: 1 },
        uTime: { value: 0 },
        uLum: { value: 0 },
        uShadow: { value: 1.5 * BH_HORIZON },
        uHot: { value: color('PHOTON_RING') },
        uMid: { value: color('DISK_INNER') },
        uCool: { value: color('ROCK_SPEC') },
      },
      vertexShader: SWIRL_VERT,
      fragmentShader: SWIRL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this._swirl = new THREE.Mesh(this._swirlGeo, this._swirlMat);
    this._swirl.frustumCulled = false;
    this._anchor.add(this._swirl);

    // Screen copy (created lazily at the bound target's size and type).
    this._grab = null;
    this._grabType = -1;

    // scratch
    this._v2 = new THREE.Vector2();
    this._v3 = new THREE.Vector3();
    this._m4 = new THREE.Matrix4();

    this._seen = new Set();      // compaction keys already handled for onSwallow
    this._activeKey = null;
    this._angle = 0;
    this._fraction = 0.5;
    this._age = -1;
    this._lastNow = null;
    this._disposed = false;
    this._setVisible(false);
  }

  /** True for the whole 9 s lifecycle (including the settle phase, while the belt re-equilibrates). */
  get active() {
    return this._activeKey !== null && this._age >= 0 && this._age < BH_LIFE;
  }

  /** System-local position of the current hole (extra; not in CONTRACT). */
  getPosition(out) {
    out.copy(this._anchor.position);
    return this.active;
  }

  update(state, dt, t) {
    if (this._disposed) return 0;
    const now = state.now;
    if (this._lastNow !== null && now < this._lastNow - 1e-6) this.reset();
    this._lastNow = now;

    // Pick the most recent compaction still inside its 9 s window.
    const list = state.compactions || [];
    let best = null;
    let bestAge = Infinity;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const age = now - c.t;
      if (age >= 0 && age < BH_LIFE && age < bestAge) { best = c; bestAge = age; }
    }

    if (!best) {
      if (this._activeKey !== null) { this._activeKey = null; this._age = -1; this._setVisible(false); }
      return 0;
    }

    const key = best.id != null ? String(best.id) : String(best.t);
    if (key !== this._activeKey) this._begin(key, best);
    this._age = bestAge;

    // One swallow per compaction. Late discovery (replay jump) gets the remaining time.
    if (!this._seen.has(key) && bestAge >= BH_T_SWALLOW) {
      this._seen.add(key);
      if (bestAge < BH_T_COLLAPSE && typeof this.onSwallow === 'function') {
        const p = this._anchor.position;
        this.onSwallow({
          angle: this._angle,
          fraction: this._fraction,
          duration: Math.max(0.25, BH_T_COLLAPSE - bestAge),
          radius: this._radius,
          position: { x: p.x, y: p.y, z: p.z },
          id: key,
        });
      }
    }

    this._applyPhase(bestAge, t);
    return 2;
  }

  _begin(key, c) {
    this._activeKey = key;
    // CONTRACT §5: angle from hash of id (or t), fraction from the token drop.
    this._angle = hash01(c.id != null ? String(c.id) : String(c.t)) * Math.PI * 2;
    const before = c.tokensBefore;
    const after = c.tokensAfter;
    this._fraction = (before > 0 && after >= 0)
      ? Math.min(0.75, Math.max(0.25, 1 - after / before))
      : 0.5;
    const r = Number(this._beltRadius()) || 11.5;
    this._radius = r;
    // Angle convention shared with the belt: x = r·cos(angle), z = r·sin(angle).
    this._anchor.position.set(Math.cos(this._angle) * r, 0, Math.sin(this._angle) * r);
  }

  _applyPhase(age, t) {
    // Mass: blooms in, grows while it feeds, then implodes.
    let m;
    if (age < BH_T_SWALLOW) m = outCubic(age / BH_FORM);
    else if (age < BH_T_COLLAPSE) m = 1 + 0.12 * ((age - BH_T_SWALLOW) / BH_SWALLOW);
    else if (age < BH_T_GONE) m = 1.12 * (1 - inCubic((age - BH_T_COLLAPSE) / BH_COLLAPSE));
    else m = 0;

    if (m < 0.004) { this._setVisible(false); return; }
    this._setVisible(true);

    // One bright photon-ring flash as the hole pinches off.
    const flash = Math.exp(-Math.pow((age - (BH_T_GONE - 0.1)) / 0.2, 2));
    // Feeding envelope: faint while forming, full during swallow (scaled by how
    // much the compaction removed), tied to mass on collapse.
    let feed;
    if (age < BH_T_SWALLOW) feed = 0.25 * outCubic(age / BH_FORM);
    else if (age < BH_T_COLLAPSE) feed = 0.25 + 0.75 * outCubic((age - BH_T_SWALLOW) / 1.0);
    else feed = m / 1.12;
    feed *= 0.6 + 0.4 * (this._fraction - 0.25) / 0.5;

    const lu = this._lensMat.uniforms;
    lu.uRh.value = BH_HORIZON * m;
    lu.uThetaE.value = BH_HORIZON * BH_EINSTEIN * m;
    // The last of the hole fades as it shrinks: no hot pinpoint is left behind.
    const fade = Math.min(1, m / 0.35);
    lu.uRingLum.value = (BH_RING_BASE + (BH_RING_FLASH - BH_RING_BASE) * flash) * fade;
    lu.uArc.value = 0.6 * feed * fade;
    lu.uTime.value = t;

    const u = this._swirlMat.uniforms;
    u.uSize.value = m;
    u.uTime.value = t;
    u.uLum.value = 1.3 * feed * fade;
    u.uShadow.value = 1.5 * BH_HORIZON * m;
  }

  // Runs inside renderer.render, right before the lens quad is drawn.
  _beforeLens(renderer, camera) {
    const u = this._lensMat.uniforms;
    u.uProj.value.copy(camera.projectionMatrix);

    // System +Y in view space → which side of the ring is approaching.
    this._m4.multiplyMatrices(camera.matrixWorldInverse, this._anchor.matrixWorld);
    this._v3.set(0, 1, 0).transformDirection(this._m4);
    u.uSpin.value.set(this._v3.x, this._v3.y);

    const cube = this.ctx.starfieldCube || null;
    u.uCube.value = cube;
    u.uHasCube.value = cube ? 1 : 0;
    u.uFlip.value = cube && !cube.isRenderTargetTexture ? -1 : 1;

    const rt = renderer.getRenderTarget();
    let w;
    let h;
    let type;
    if (rt) {
      const unsupported = rt.isWebGLCubeRenderTarget || rt.isWebGL3DRenderTarget
        || rt.isWebGLArrayRenderTarget || !rt.texture;
      if (unsupported) { u.uMode.value = 0; return; }
      if (rt.samples > 0) {
        // Multisampled target (the engine's MSAA scene buffer): copyTexSubImage
        // can't read it, so resolve the frame-so-far into the target's own
        // resolve texture with a blit and sample that. Drawing continues into
        // the multisampled renderbuffer, so there is no feedback loop, and
        // three's end-of-pass resolve overwrites the texture afterwards anyway.
        u.uMode.value = this._resolveMsaa(renderer, rt) ? 1 : 0;
        if (u.uMode.value) u.uGrab.value = rt.texture;
        return;
      }
      w = rt.width;
      h = rt.height;
      type = rt.texture.type;
    } else {
      renderer.getDrawingBufferSize(this._v2);
      w = this._v2.x;
      h = this._v2.y;
      type = THREE.UnsignedByteType;
    }
    if (!(w > 0 && h > 0)) { u.uMode.value = 0; return; }

    if (!this._grab || this._grab.image.width !== w || this._grab.image.height !== h || this._grabType !== type) {
      if (this._grab) this._grab.dispose();
      const tex = new THREE.FramebufferTexture(w, h);
      // copyTexSubImage needs matching component types (float FBO → float texture).
      tex.type = type;
      const filter = type === THREE.FloatType ? THREE.NearestFilter : THREE.LinearFilter;
      tex.minFilter = filter;
      tex.magFilter = filter;
      this._grab = tex;
      this._grabType = type;
    }
    renderer.copyFramebufferToTexture(this._grab);
    u.uGrab.value = this._grab;
    u.uMode.value = 1;
  }

  // Blit the bound multisampled framebuffer into rt's single-sample resolve FBO.
  // Restores the exact GL binding three set (FRAMEBUFFER = multisampled FBO).
  _resolveMsaa(renderer, rt) {
    const gl = renderer.getContext();
    const p = renderer.properties.get(rt);
    const msaa = p.__webglMultisampledFramebuffer;
    const resolve = p.__webglFramebuffer;
    if (!msaa || !resolve || typeof gl.blitFramebuffer !== 'function') return false;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolve);
    gl.blitFramebuffer(0, 0, rt.width, rt.height, 0, 0, rt.width, rt.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    return true;
  }

  _setVisible(v) {
    this._lens.visible = v;
    this._swirl.visible = v;
  }

  reset() {
    this._seen.clear();
    this._activeKey = null;
    this._age = -1;
    this._lastNow = null;
    this._setVisible(false);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.onSwallow = null;
    if (this.root.parent) this.root.parent.remove(this.root);
    this._swirlGeo.dispose();
    this._lensGeo.dispose();
    this._swirlMat.dispose();
    this._lensMat.dispose();
    if (this._grab) { this._grab.dispose(); this._grab = null; }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// White hole
// ═════════════════════════════════════════════════════════════════════════════

// Instance 0 is the erupting core, instances 1–3 are the shock shells.
const WH_SHELL_VERT = /* glsl */ `
attribute float aKind;
uniform float uCoreR;
uniform vec3 uShellR;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObjN;
varying float vKind;
void main() {
  float r = aKind < 0.5 ? uCoreR : (aKind < 1.5 ? uShellR.x : (aKind < 2.5 ? uShellR.y : uShellR.z));
  vec4 mv = modelViewMatrix * vec4(position * r, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vObjN = normal;
  vKind = aKind;
  gl_Position = projectionMatrix * mv;
}
`;

const WH_SHELL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uCoreLum;
uniform vec3 uShellI;
uniform vec3 uCore;
uniform vec3 uEdge;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObjN;
varying float vKind;

${NOISE_GLSL}

void main() {
  vec3 n = normalize(vN);
  float nv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
  if (vKind < 0.5) {
    // Core: white-hot centre with radial spokes streaming outward
    // (noise in (angle, radius − t): features only ever travel out).
    float ang = atan(n.y, n.x);
    float q = 1.0 - nv;
    float spokes = phz_fbm(vec3(cos(ang) * 5.0, sin(ang) * 5.0, q * 3.0 - uTime * 2.6));
    float body = pow(nv, 2.2);
    float rays = smoothstep(0.35, 0.85, spokes) * pow(nv, 0.5) * 0.45;
    vec3 col = mix(uEdge, uCore, smoothstep(0.2, 0.9, nv));
    gl_FragColor = vec4(col * uCoreLum * (body + rays), 1.0);
  } else {
    // Shock shell: Fresnel rim (reads as a sphere, not a ring) rippled by noise.
    float k = vKind < 1.5 ? uShellI.x : (vKind < 2.5 ? uShellI.y : uShellI.z);
    // Thin bright limb, nearly clear face: reads as an expanding shell, not a fog.
    float fres = pow(1.0 - nv, 6.0) + 0.04 * pow(1.0 - nv, 1.5);
    float rip = phz_fbm(vObjN * 3.0 + vec3(0.0, 0.0, uTime * 1.5 + vKind * 3.1));
    gl_FragColor = vec4(uEdge * k * fres * (0.55 + 0.9 * rip), 1.0);
  }
}
`;

const WH_PART_VERT = /* glsl */ `
attribute vec3 aDir;
attribute vec4 aParams;     // speed, delay, size, tint
uniform float uAge;
uniform float uScale;       // drawing-buffer px per unit at distance 1
varying float vA;
varying float vTint;
void main() {
  float tt = uAge - aParams.y;
  // Drag-decelerated outflow: distance only ever increases.
  const float k = 1.6;
  float dist = aParams.x * (1.0 - exp(-k * max(tt, 0.0))) / k;
  vec4 mv = modelViewMatrix * vec4(aDir * (0.12 + dist), 1.0);
  gl_Position = projectionMatrix * mv;
  vA = step(0.0, tt) * smoothstep(0.0, 0.08, tt) * (1.0 - smoothstep(1.2, 2.6, tt));
  vTint = aParams.w;
  gl_PointSize = max(aParams.z * uScale / max(-mv.z, 0.1), 1.5);
}
`;

const WH_PART_FRAG = /* glsl */ `
uniform float uLum;
uniform vec3 uCore;
uniform vec3 uEdge;
varying float vA;
varying float vTint;
void main() {
  if (vA <= 0.0) discard;
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 4.0);
  gl_FragColor = vec4(mix(uCore, uEdge, vTint) * uLum * vA * a, 1.0);
}
`;

export class WhiteHole {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx
   * @param {{ seed?: string }} opts  seed only shapes the particle spray (no meaning)
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'WhiteHole';
    parent.add(this.root);

    const defines = { PHZ_OCT: octavesFor(ctx.quality) };
    const core = color('WHITE_HOLE');
    const edge = color('WHITE_HOLE_EDGE');

    // Core + 3 shells: one instanced draw.
    const seg = ctx.quality === 'low' ? 32 : 48;
    this._shellGeo = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.66));
    this._shellGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 2, 3]), 1));
    this._shellMat = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uCoreR: { value: 0 },
        uShellR: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uCoreLum: { value: 0 },
        uShellI: { value: new THREE.Vector3() },
        uCore: { value: core },
        uEdge: { value: edge },
      },
      vertexShader: WH_SHELL_VERT,
      fragmentShader: WH_SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._shells = new THREE.InstancedMesh(this._shellGeo, this._shellMat, 4);
    this._shells.frustumCulled = false;
    this.root.add(this._shells);

    // Outflow particles.
    this._count = ctx.quality === 'low' ? 180 : 300;
    this._partGeo = new THREE.BufferGeometry();
    this._partGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this._count * 3), 3));
    this._aDir = new THREE.BufferAttribute(new Float32Array(this._count * 3), 3);
    this._aParams = new THREE.BufferAttribute(new Float32Array(this._count * 4), 4);
    this._partGeo.setAttribute('aDir', this._aDir);
    this._partGeo.setAttribute('aParams', this._aParams);
    this._partMat = new THREE.ShaderMaterial({
      uniforms: {
        uAge: { value: 0 },
        uScale: { value: 800 },
        uLum: { value: 0 },
        uCore: { value: core.clone() },
        uEdge: { value: edge.clone() },
      },
      vertexShader: WH_PART_VERT,
      fragmentShader: WH_PART_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._points = new THREE.Points(this._partGeo, this._partMat);
    this._points.frustumCulled = false;
    this._v2 = new THREE.Vector2();
    this._points.onBeforeRender = (renderer, _scene, camera) => {
      const rt = renderer.getRenderTarget();
      let hpx;
      if (rt) hpx = rt.height;
      else { renderer.getDrawingBufferSize(this._v2); hpx = this._v2.y; }
      const fov = camera.isPerspectiveCamera ? camera.fov : 32;
      this._partMat.uniforms.uScale.value = hpx / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    };
    this.root.add(this._points);

    this._seedKey = null;
    if (opts.seed) this._seedParticles(String(opts.seed));

    this._age = -1;
    this._progress = 1;
    this._disposed = false;
    this._setVisible(false);
  }

  /** 0 before the condense phase, 0→1 over 1.5–3.0 s, 1 afterwards (and 1 with no birth). */
  get birthProgress() { return this._progress; }

  get active() { return this._age >= 0 && this._age < WH_LIFE; }

  _seedParticles(seed) {
    if (seed === this._seedKey) return;
    this._seedKey = seed;
    const rnd = mulberry32(Math.floor(hash01('white-hole:' + seed) * 4294967296));
    const dir = this._aDir.array;
    const prm = this._aParams.array;
    for (let i = 0; i < this._count; i++) {
      // Uniform on the sphere, with a mild pull toward the orbital plane: the
      // matter that will become this system's disk and belt.
      let y = rnd() * 2 - 1;
      y *= 0.55 + 0.45 * Math.abs(y);
      const phi = rnd() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - y * y));
      const inv = 1 / Math.hypot(s, y);
      dir[i * 3] = Math.cos(phi) * s * inv;
      dir[i * 3 + 1] = y * inv;
      dir[i * 3 + 2] = Math.sin(phi) * s * inv;
      const sp = 3.5 + Math.pow(rnd(), 0.6) * 10.5;     // units/s at launch
      prm[i * 4] = sp;
      prm[i * 4 + 1] = WH_SEED_END + rnd() * rnd() * 0.85; // most leave in the first beat
      prm[i * 4 + 2] = 0.035 + rnd() * 0.07;             // world-space sprite size
      prm[i * 4 + 3] = Math.min(1, (sp - 3.5) / 10.5);   // faster → bluer shock edge
    }
    this._aDir.needsUpdate = true;
    this._aParams.needsUpdate = true;
  }

  update(state, dt, t) {
    if (this._disposed) return 0;
    if (state.bornAt == null || !Number.isFinite(state.bornAt)) {
      this._age = -1;
      this._progress = 1;
      this._setVisible(false);
      return 0;
    }
    const age = state.now - state.bornAt;
    this._age = age;
    if (age < 0) { this._progress = 0; this._setVisible(false); return 0; }
    if (age >= WH_LIFE) { this._progress = 1; this._setVisible(false); return 0; }

    if (this._seedKey === null) this._seedParticles(String(state.id ?? 'session'));
    this._progress = age < WH_ERUPT_END ? 0 : inOutCubic((age - WH_ERUPT_END) / (WH_CONDENSE_END - WH_ERUPT_END));

    // Core radius and luminance (peak 12 for ≤ 0.6 s, ART_DIRECTION ladder).
    let coreR;
    let coreLum;
    if (age < WH_SEED_END) {
      const k = age / WH_SEED_END;
      coreR = 0.04 + 0.26 * outCubic(k);
      coreLum = 2 + 4 * k;
    } else if (age < WH_ERUPT_END) {
      const k = age - WH_SEED_END;
      coreR = 0.3 + 0.85 * outExpo(k / 0.45);
      coreLum = k < 0.6 ? 6 + 6 * Math.sin(Math.min(1, k / 0.15) * Math.PI / 2) : 12 - 7 * outCubic((k - 0.6) / 0.6);
    } else if (age < WH_CONDENSE_END) {
      const k = (age - WH_ERUPT_END) / (WH_CONDENSE_END - WH_ERUPT_END);
      coreR = 1.15 - 0.07 * inOutCubic(k);  // tightens onto the newborn star
      coreLum = 5 - 3.8 * inOutCubic(k);
    } else {
      const k = (age - WH_CONDENSE_END) / (WH_LIFE - WH_CONDENSE_END);
      coreR = 1.08 + 0.05 * k;
      coreLum = 1.2 * (1 - outCubic(k));
    }

    const su = this._shellMat.uniforms;
    su.uCoreR.value = coreR;
    su.uCoreLum.value = coreLum;
    su.uTime.value = t;
    for (let i = 0; i < 3; i++) {
      const k = (age - WH_SHELL_START[i]) / WH_SHELL_DUR;
      const on = k >= 0 && k < 1;
      const r = on ? WH_SHELL_MAX_R * outCubic(k) : 0;
      const inten = on ? WH_SHELL_PEAK[i] * Math.pow(1 - k, 1.5) * Math.min(1, k * 12) : 0;
      su.uShellR.value.setComponent(i, r);
      su.uShellI.value.setComponent(i, inten);
    }

    const pu = this._partMat.uniforms;
    pu.uAge.value = age;
    pu.uLum.value = 6.0 * (1 - 0.6 * outCubic((age - 0.6) / 2.4));

    this._setVisible(true);
    return 2;
  }

  _setVisible(v) {
    this._shells.visible = v;
    this._points.visible = v;
  }

  reset() {
    this._age = -1;
    this._progress = 1;
    this._setVisible(false);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    this._shellGeo.dispose();
    this._shellMat.dispose();
    this._shells.dispose();
    this._partGeo.dispose();
    this._partMat.dispose();
  }
}
