// belt.js: the asteroid belt is the session's token spend.
//
//   count     = clamp(round(420 · log2(1 + tokens/10k)), 0, maxRocks)
//   width     = 1.2 + 1.4 · log10(1 + tokens/50k)   (cap 4.5), inner edge 9.5
//   thickness = grows with width (0.15 → 0.6)
//   compaction: a black hole swallows a wedge of rocks; afterwards the belt is
//               permanently thinner, narrower and flatter (a cleaner orbit).
//
// One InstancedMesh, one draw. Every rock's shape, orbit and tumble live in
// static per-instance attributes and are animated in the vertex shader from the
// render clock. Growth changes only uniforms (width, thickness, a fractional
// instance count that fades rocks in by index). The only uploads happen on a
// swallow (flag a wedge) and after it (compact the survivors to the front).

import * as THREE from 'three';
import { color, starColor } from '../lib/palette.js';
import { hash01, mulberry32, damp, clamp } from '../lib/math.js';

const INNER = 9.5;
const REF_WIDTH = 3.0;          // angular speed uses a fixed reference width, so
                                // width changes never spin rocks to a new phase
const OMEGA_INNER = (Math.PI * 2) / 220;   // 220 s period at the inner edge (matches planet Kepler law)
const SECTOR = (35 * Math.PI) / 180;       // ±35° = the 70° swallow sector
const SWALLOW_START = 1.5;      // BlackHole phase timing (ART_DIRECTION §3.9)
const SWALLOW_LEN = 4.0;
const SETTLE_START = 7.0;
const COLLAPSE_LEN = 1.5;      // black hole collapses before the belt settles
const SETTLE_LEN = 2.0;
const BELT_FILL_CAP = 0.5;      // starColor(0.5) = STAR_FILL_50, neutral warm white
const MAX_BY_QUALITY = { high: 6000, medium: 3000, low: 1500 };
const ACTIVE_MODES = new Set(['working', 'thinking', 'needs-me', 'my-move']);
// A my-move system that has idled past 60% is visually settled: 10 fps is enough.
const settledMyMove = (state) => state.mode === 'my-move' && (state.idleFor ?? 0) >= 0.6;

const rockCountFor = (tokens, max) =>
  clamp(Math.round(420 * Math.log2(1 + Math.max(0, tokens) / 10000)), 0, max);
const widthFor = (tokens) => Math.min(4.5, 1.2 + 1.4 * Math.log10(1 + Math.max(0, tokens) / 50000));
const thicknessFor = (w) => 0.15 + (0.6 - 0.15) * clamp((w - 1.2) / (4.5 - 1.2), 0, 1);

/** Same fraction rule the BlackHole uses (CONTRACT §5). */
function compactionFraction(c) {
  if (c && c.tokensBefore > 0 && c.tokensAfter >= 0) {
    return clamp(1 - c.tokensAfter / c.tokensBefore, 0.25, 0.75);
  }
  return 0.5;
}
// What a compaction of `fraction` does to the belt for good.
const keepShare = (f) => 1 - 0.26 * f;      // rocks kept (0.5 → 87%, a ~63° wedge swallowed)
const widthShare = (f) => 1 - 0.3 * f;      // narrower
const thickShare = (f) => 1 - 0.45 * f;     // flatter: the "cleaner orbit"

const VERT = /* glsl */ `
  attribute vec4 aA;    // u (radial 0..1), phase0, v (vertical -1..1), size
  attribute vec4 aB;    // seed, tumble rate, elongation, albedo variation
  attribute vec2 aSw;   // x: swallow start (render clock, <0 = not swallowed)
                        // y: swallowed → departure delay; survivor → re-equilibrate phase shift

  uniform float uTime;
  uniform float uInner;
  uniform float uWidth;
  uniform float uThick;
  uniform float uCount;     // fractional: rocks fade in/out by instance index
  uniform float uOmega0;
  uniform float uRefWidth;
  uniform vec3 uHole;       // black hole position, system-local
  uniform float uSwDur;
  uniform float uRebuildT;  // re-equilibrate start (render clock)
  uniform float uRebuildDur;

  varying vec3 vPosW;
  varying float vAlbedo;
  varying float vHeat;

  vec3 bt_hash3(float n) {
    return fract(sin(vec3(n, n + 1.7, n + 3.1) * vec3(43758.5453, 22578.1459, 19642.3490)));
  }
  vec3 bt_rotate(vec3 v, vec3 k, float a) {
    float c = cos(a), s = sin(a);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }
  // Orbital position of this rock at render time T.
  vec3 bt_orbit(float T, float shift) {
    float r = uInner + aA.x * uWidth;
    float rk = uInner + aA.x * uRefWidth;
    float th = aA.y + shift + uOmega0 * pow(rk / uInner, -1.5) * T;
    float taper = 1.0 - 0.55 * abs(aA.x - 0.5) * 2.0;   // thicker mid-belt
    return vec3(r * cos(th), aA.z * uThick * 0.5 * taper, r * sin(th));
  }

  void main() {
    float idx = float(gl_InstanceID);
    float scale = aA.w * clamp(uCount - idx, 0.0, 1.0);
    float seed = aB.x;

    // Irregular rock: unit icosphere pushed out/in by 3 hashed bumps, then squashed.
    vec3 p = position;
    vec3 n0 = normalize(p);
    float disp = 1.0;
    for (int i = 0; i < 3; i++) {
      vec3 h = bt_hash3(seed * 13.1 + float(i) * 7.7);
      vec3 dir = normalize(h * 2.0 - 1.0 + 1e-3);
      float amp = mix(-0.32, 0.45, fract(h.x * 9.7 + h.z));
      disp += amp * pow(max(dot(n0, dir), 0.0), 3.0);
    }
    p = n0 * disp * vec3(1.0 + aB.z, 1.0 - aB.z * 0.35, 1.0 - aB.z * 0.2);

    // Tumble about a per-rock axis.
    vec3 axis = normalize(bt_hash3(seed * 3.3 + 0.5) * 2.0 - 1.0 + 1e-3);
    p = bt_rotate(p, axis, aB.y * uTime + seed * 6.2831);

    vec3 center;
    vHeat = 0.0;
    if (aSw.x >= 0.0) {
      // Swallowed: leave the orbit when the delay ends and fall along a
      // log-spiral into the hole, stretching into a streak near the photon ring.
      float depart = aSw.x + aSw.y;
      vec3 p0 = bt_orbit(min(uTime, depart), 0.0);
      float k = clamp((uTime - depart) / max(uSwDur - aSw.y, 0.05), 0.0, 1.0);
      float e = k * k;                                   // falls faster as it nears
      vec2 d = p0.xz - uHole.xz;
      float rho0 = max(length(d), 1e-3);
      float rho = rho0 * (1.0 - e);
      float phi = atan(d.y, d.x) + 2.4 * log(rho0 / max(rho, 0.02 * rho0));
      center = vec3(uHole.x + rho * cos(phi), mix(p0.y, uHole.y, e), uHole.z + rho * sin(phi));
      vec3 tng = normalize(vec3(-sin(phi), 0.0, cos(phi)));
      float streak = 1.3 * (1.0 - smoothstep(0.3, 1.4, rho)) * step(0.001, k);
      p += tng * dot(p, tng) * streak;
      // In flight the rock swells a little and warms, so the swallowed share
      // reads as a bright stream threading down into the hole.
      float fly = step(0.001, k);
      scale *= mix(1.0, 1.25, fly * smoothstep(0.0, 0.15, k));
      scale *= smoothstep(0.35, 1.1, rho) * step(k, 0.999);
      vHeat = fly * (0.25 + 0.75 * (1.0 - smoothstep(0.8, 2.8, rho)));
    } else {
      // Survivors of a compaction slide along their orbit to close the gap
      // (the belt re-equilibrates into a uniform, thinner ring).
      float e = clamp((uTime - uRebuildT) / uRebuildDur, 0.0, 1.0);
      e = e * e * (3.0 - 2.0 * e);
      center = bt_orbit(uTime, aSw.y * e);
    }

    vec4 world = modelMatrix * vec4(center + p * scale, 1.0);
    vPosW = world.xyz;
    vAlbedo = aB.w;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uStarW;
  uniform vec3 uLight;
  uniform vec3 uRock;
  uniform vec3 uSpec;
  uniform float uDesat;
  varying vec3 vPosW;
  varying float vAlbedo;
  varying float vHeat;
  void main() {
    // Faceted normal from screen-space derivatives: crisp low-poly rocks.
    vec3 N = normalize(cross(dFdx(vPosW), dFdy(vPosW)));
    vec3 V = normalize(cameraPosition - vPosW);
    if (dot(N, V) < 0.0) N = -N;
    vec3 L = normalize(uStarW - vPosW);
    float ndl = max(dot(N, L), 0.0);
    vec3 albedo = uRock * vAlbedo;
    vec3 col = albedo * uLight * (0.06 + 0.94 * ndl) * 0.85;
    col += albedo * 0.012;
    // Sparse glint off fresh faces.
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 48.0) * ndl;
    col += uSpec * uLight * spec * 0.55;
    // Infalling rocks warm up: lit faces glow, shadowed faces keep the shape.
    col += uSpec * vHeat * (0.05 + 0.5 * ndl + 0.25 * spec);
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float lmax = 0.95 + 0.25 * vHeat * vHeat;         // only the last plunge may touch bloom
    if (l > lmax) col *= lmax / l;
    col = mix(col, vec3(l), uDesat);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class AsteroidBelt {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx
   * @param {{maxRocks?: number, seed?: string}} opts
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    const q = ctx?.quality ?? 'high';
    this.maxRocks = Math.max(0, Math.floor(opts.maxRocks ?? MAX_BY_QUALITY[q] ?? 6000));
    this.seed = String(opts.seed ?? 'belt');
    this.root = new THREE.Group();
    this.root.name = 'belt';
    parent.add(this.root);
    this._disposed = false;

    const geo = new THREE.IcosahedronGeometry(1, q === 'low' ? 0 : 1);
    geo.deleteAttribute('normal');   // faceted normals are derived in the fragment shader
    geo.deleteAttribute('uv');
    const n = Math.max(1, this.maxRocks);
    this._aA = new Float32Array(n * 4);
    this._aB = new Float32Array(n * 4);
    this._aSw = new Float32Array(n * 2);
    this._attrA = new THREE.InstancedBufferAttribute(this._aA, 4);
    this._attrB = new THREE.InstancedBufferAttribute(this._aB, 4);
    this._attrSw = new THREE.InstancedBufferAttribute(this._aSw, 2);
    geo.setAttribute('aA', this._attrA);
    geo.setAttribute('aB', this._attrB);
    geo.setAttribute('aSw', this._attrSw);
    this._geo = geo;
    this._fillRocks();

    const light = new THREE.Color();
    starColor(0, light);
    this._uniforms = {
      uTime: { value: 0 },
      uInner: { value: INNER },
      uWidth: { value: 1.2 },
      uThick: { value: 0.15 },
      uCount: { value: 0 },
      uOmega0: { value: OMEGA_INNER },
      uRefWidth: { value: REF_WIDTH },
      uHole: { value: new THREE.Vector3() },
      uSwDur: { value: SWALLOW_LEN },
      uRebuildT: { value: -1e4 },
      uRebuildDur: { value: SETTLE_LEN },
      uStarW: { value: new THREE.Vector3() },
      uLight: { value: light },
      uRock: { value: color('ROCK') },
      uSpec: { value: color('ROCK_SPEC') },
      uDesat: { value: 0 },
    };
    this._mat = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this._mesh = new THREE.InstancedMesh(geo, this._mat, n);
    this._mesh.frustumCulled = false;   // orbit lives in the shader
    this._mesh.count = 0;
    this._mesh.visible = false;
    this.root.add(this._mesh);

    this._countF = 0;
    this._width = 1.2;
    this._thick = 0.15;
    this._lightI = 1;
    this._desat = 0;
    this._t = 0;
    this._lastNow = -Infinity;
    this._swallowEnd = -1;   // render-clock time the active swallow completes
    this._swallowN = 0;
    this._holeAngle = 0;
    this._gapHalf = SECTOR;
    this._bakeAt = -1;       // when the re-equilibrate shift is folded into phases
    this._initialised = false;
    this._c = new THREE.Color();
  }

  /** Mid-radius of the belt (BlackHole forms here). */
  get midRadius() {
    return INNER + this._width * 0.5;
  }

  update(state, dt, t) {
    if (this._disposed || !state) return 0;
    if (state.now < this._lastNow - 1e-3) this.reset();
    this._lastNow = state.now;
    this._t = t;
    const u = this._uniforms;
    u.uTime.value = t;
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(u.uStarW.value);

    // Permanent effect of compactions the data has already recorded.
    let keep = 1, wMul = 1, hMul = 1;
    const comps = state.compactions || [];
    for (let i = 0; i < comps.length; i++) {
      const age = state.now - comps[i].t;
      const f = compactionFraction(comps[i]);
      if (age >= SWALLOW_START + SWALLOW_LEN) keep *= keepShare(f);
      if (age >= SETTLE_START) { wMul *= widthShare(f); hMul *= thickShare(f); }
    }
    const tokens = state.tokens?.total ?? 0;
    const targetCount = Math.min(this.maxRocks, Math.round(rockCountFor(tokens, this.maxRocks) * keep));
    const targetW = widthFor(tokens) * wMul;
    const targetH = thicknessFor(widthFor(tokens)) * hMul;

    if (!this._initialised) {
      // First frame: appear at the recorded size, don't grow from nothing.
      this._countF = targetCount; this._width = targetW; this._thick = targetH;
      this._initialised = true;
    }
    // While a swallow runs, hold the count: the swallowed rocks are leaving.
    if (this._swallowEnd < 0) this._countF = damp(this._countF, targetCount, 0.8, dt);
    this._width = damp(this._width, targetW, 0.6, dt);   // ~2 s settle
    this._thick = damp(this._thick, targetH, 0.6, dt);

    if (this._swallowEnd >= 0 && t >= this._swallowEnd) this._compactSurvivors();
    if (this._bakeAt >= 0 && t >= this._bakeAt) this._bakeShift();

    // Starlight: idle / crash dimming, context tint capped (see below).
    const mode = state.mode;
    let targetI = 1, targetDesat = 0;
    if (mode === 'idle' || mode === 'my-move') {
      const s = clamp(state.idleFor ?? 0, 0, 1);
      const sm = s * s * (3 - 2 * s);
      targetI = 1 + (0.06 - 1) * Math.pow(sm, 0.7);
      targetDesat = 0.45 * s;
    } else if (mode === 'crashed') {
      targetI = 0.12; targetDesat = 0.6;
    }
    this._lightI = damp(this._lightI, targetI, 1.5, dt);
    this._desat = damp(this._desat, targetDesat, 1.5, dt);
    // Gate 1 review: the belt keeps its normal colour. Only the cool half of the
    // star's ramp tints it (blue-white → white); a full context (red star, and
    // every compaction happens near full) must never read as red rocks = errors.
    starColor(Math.min(BELT_FILL_CAP, Math.max(0, state.contextFill ?? 0)), this._c);
    const lum = Math.max(1e-3, 0.2126 * this._c.r + 0.7152 * this._c.g + 0.0722 * this._c.b);
    u.uLight.value.setRGB(this._c.r / lum, this._c.g / lum, this._c.b / lum).multiplyScalar(this._lightI);
    u.uDesat.value = this._desat;

    u.uCount.value = this._countF;
    u.uWidth.value = this._width;
    u.uThick.value = this._thick;
    const drawn = Math.min(this.maxRocks, Math.ceil(this._countF));
    this._mesh.count = drawn;
    this._mesh.visible = drawn > 0;

    const easing = Math.abs(this._countF - targetCount) > 0.5
      || Math.abs(this._width - targetW) > 1e-3
      || Math.abs(this._thick - targetH) > 1e-3;
    if (this._swallowEnd >= 0 || this._bakeAt >= 0 || easing) return 2;
    return drawn > 0 && ACTIVE_MODES.has(mode) && !settledMyMove(state) ? 1 : 0;
  }

  /**
   * Spiral the rocks nearest `angle` (system-local XZ, x = cos, z = sin) into
   * the black hole at the belt's mid-radius, over `duration` seconds.
   */
  swallow({ angle = 0, fraction = 0.5, duration = SWALLOW_LEN } = {}) {
    if (this._disposed) return;
    if (this._swallowEnd >= 0) this._compactSurvivors();   // finish a previous one first
    if (this._bakeAt >= 0) this._bakeShift();
    const t = this._t;
    const N = Math.min(this.maxRocks, Math.round(this._countF));
    if (N <= 0) return;
    const f = clamp(fraction, 0.25, 0.75);
    const S = Math.round(N * (1 - keepShare(f)));
    const mid = this.midRadius;
    this._uniforms.uHole.value.set(Math.cos(angle) * mid, 0, Math.sin(angle) * mid);
    this._uniforms.uSwDur.value = duration;

    // Current angle of each candidate rock (same law as the shader).
    const cand = [];
    for (let i = 0; i < N; i++) {
      const a = this._aA[i * 4], ph = this._aA[i * 4 + 1];
      const rk = INNER + a * REF_WIDTH;
      const th = ph + OMEGA_INNER * Math.pow(rk / INNER, -1.5) * t;
      let d = (th - angle) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const ad = Math.abs(d);
      if (ad <= SECTOR) cand.push(i, ad);
    }
    // Nearest-first, within the 70° sector.
    const order = [];
    for (let k = 0; k < cand.length; k += 2) order.push(k);
    order.sort((x, y) => cand[x + 1] - cand[y + 1]);
    const take = Math.min(S, order.length);
    this._holeAngle = angle;
    this._gapHalf = take > 0 ? Math.max(1e-3, cand[order[take - 1] + 1]) : 0;
    // Departures spread over most of the swallow: a continuous stream, not a lump.
    const delayMax = duration * 0.6;
    for (let k = 0; k < take; k++) {
      const i = cand[order[k]];
      const ad = cand[order[k] + 1];
      this._aSw[i * 2] = t;
      // Rocks closest to the hole go first, so the wedge peels in from its centre.
      this._aSw[i * 2 + 1] = (ad / SECTOR) * delayMax * (0.75 + 0.25 * Math.random());
    }
    this._attrSw.needsUpdate = true;
    this._swallowN = take;
    this._swallowEnd = t + duration;
  }

  reset() {
    this._fillRocks();
    this._swallowEnd = -1;
    this._swallowN = 0;
    this._bakeAt = -1;
    this._uniforms.uRebuildT.value = -1e4;
    this._initialised = false;
    this._lastNow = -Infinity;
    this._countF = 0;
    this._mesh.count = 0;
    this._mesh.visible = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.root.parent?.remove(this.root);
    this._geo.dispose();
    this._mat.dispose();
    this._mesh.dispose?.();
  }

  // -------------------------------------------------------------------------

  /**
   * Deterministic rock catalogue (seeded by the system id). Index order is the
   * order rocks appear as tokens grow, so early rocks are spread evenly.
   */
  _fillRocks() {
    const rnd = mulberry32(Math.floor(hash01(this.seed + '#belt') * 4294967296));
    const n = Math.max(1, this.maxRocks);
    for (let i = 0; i < n; i++) {
      // Radial: Irwin–Hall(3) → soft-edged band, densest in the middle.
      const u = (rnd() + rnd() + rnd()) / 3;
      const v = (rnd() + rnd() - 1);
      // Size: power law, many pebbles and a few boulders.
      const size = 0.022 + 0.15 * Math.pow(rnd(), 3.6);
      this._aA[i * 4] = u;
      this._aA[i * 4 + 1] = rnd() * Math.PI * 2;
      this._aA[i * 4 + 2] = v;
      this._aA[i * 4 + 3] = size;
      this._aB[i * 4] = rnd() * 100;
      // Small rocks tumble faster; none fast enough to read as "spinning".
      this._aB[i * 4 + 1] = (0.05 + 0.35 * rnd()) * (0.06 / (size + 0.03)) * (rnd() < 0.5 ? -1 : 1);
      this._aB[i * 4 + 2] = 0.1 + 0.55 * rnd();
      // Albedo: mostly grey regolith, a darker carbonaceous minority.
      this._aB[i * 4 + 3] = rnd() < 0.22 ? 0.45 + 0.2 * rnd() : 0.8 + 0.35 * rnd();
      this._aSw[i * 2] = -1;
      this._aSw[i * 2 + 1] = 0;
    }
    this._attrA.needsUpdate = true;
    this._attrB.needsUpdate = true;
    this._attrSw.needsUpdate = true;
  }

  /**
   * After a swallow: move the surviving rocks to the front of the instance
   * buffer (swapping swallowed ones to the back, re-armed as fresh rocks), and
   * drop the count by exactly the number swallowed, so nothing pops.
   */
  _compactSurvivors() {
    const N = Math.min(this.maxRocks, Math.ceil(this._countF));
    let tail = N - 1;
    for (let i = 0; i < N && i < tail; i++) {
      if (this._aSw[i * 2] < 0) continue;
      while (tail > i && this._aSw[tail * 2] >= 0) tail--;
      if (tail <= i) break;
      this._swap(i, tail);
      tail--;
    }
    for (let i = 0; i < this.maxRocks; i++) { this._aSw[i * 2] = -1; this._aSw[i * 2 + 1] = 0; }
    this._countF = Math.max(0, this._countF - this._swallowN);
    // Re-equilibrate: stretch the survivors' angles (relative to the hole) from
    // [g, 2π−g] onto [0, 2π], so the wedge closes and density is uniform again.
    // Each rock gets a phase shift that the shader eases in over SETTLE_LEN.
    const g = this._gapHalf;
    const survivors = Math.ceil(this._countF);
    if (g > 1e-3 && g < Math.PI) {
      const t = this._t;
      for (let i = 0; i < survivors; i++) {
        const a = this._aA[i * 4], ph = this._aA[i * 4 + 1];
        const rk = INNER + a * REF_WIDTH;
        const th = ph + OMEGA_INNER * Math.pow(rk / INNER, -1.5) * t;
        let rel = (th - this._holeAngle) % (Math.PI * 2);
        if (rel < 0) rel += Math.PI * 2;
        const rc = Math.min(Math.max(rel, g), Math.PI * 2 - g);
        const mapped = ((rc - g) * Math.PI * 2) / (Math.PI * 2 - 2 * g);
        this._aSw[i * 2 + 1] = mapped - rel;
      }
      this._uniforms.uRebuildT.value = this._t + COLLAPSE_LEN;
      this._bakeAt = this._t + COLLAPSE_LEN + SETTLE_LEN;
    }
    this._swallowN = 0;
    this._swallowEnd = -1;
    this._attrA.needsUpdate = true;
    this._attrB.needsUpdate = true;
    this._attrSw.needsUpdate = true;
  }

  /** Fold the finished re-equilibrate shift into each rock's base phase. */
  _bakeShift() {
    for (let i = 0; i < this.maxRocks; i++) {
      this._aA[i * 4 + 1] += this._aSw[i * 2 + 1];
      this._aSw[i * 2 + 1] = 0;
    }
    this._uniforms.uRebuildT.value = -1e4;
    this._bakeAt = -1;
    this._attrA.needsUpdate = true;
    this._attrSw.needsUpdate = true;
  }

  _swap(i, j) {
    for (let k = 0; k < 4; k++) {
      let a = this._aA[i * 4 + k]; this._aA[i * 4 + k] = this._aA[j * 4 + k]; this._aA[j * 4 + k] = a;
      a = this._aB[i * 4 + k]; this._aB[i * 4 + k] = this._aB[j * 4 + k]; this._aB[j * 4 + k] = a;
    }
    for (let k = 0; k < 2; k++) {
      const a = this._aSw[i * 2 + k]; this._aSw[i * 2 + k] = this._aSw[j * 2 + k]; this._aSw[j * 2 + k] = a;
    }
  }
}
