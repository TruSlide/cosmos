// The Tree of Knowledge at the galactic center (owner, 2026-11-08; replaces
// the Codex crystal). As above, so below:
//
//   Canopy   one branch tip per live session (working, waiting, your move).
//   Roots    one root tip per dormant or dead session.
//   Leaves   one glimmering leaf per piece of saved knowledge (memories,
//            skills, project rules, decision logs, kit), from GET /api/knowledge.
//
// The shape is grown procedurally from those counts with a fixed seed, so the
// same galaxy grows the same tree; branch thickness follows the pipe model
// (sqrt of the tips a limb carries). It regrows only when a count changes.
//
// Substance: dark bark under a thin-film, pearlescent sheen that shifts with
// the view angle through green, blue, indigo and amber-gold, plus faint fibres
// along each limb and slow pulses of light: sap rising toward the living
// branches, sinking slowly into the roots. Luminous but subtle: almost all of
// it stays below the bloom threshold. No labels.
//
// Draws: limbs (1 mesh), leaves (1 points), tips (1 points).

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { mulberry32, hash01, clamp } from '../lib/math.js';

const TRUNK_TOP = 12;
const TRUNK_BOTTOM = -7;
const ROOTS_MAX = 160;           // more dormant sessions than this share root tips
const CANOPY_MIN = 5;            // a bare young tree still has a crown
const SIDES = 9;                 // radial segments per limb piece
const LEAVES_MAX = 3600;
const GLINTS = 6;                // sprites per knowledge item (a fuller crown)

// ------------------------------------------------------------------- GLSL

const FILM_GLSL = /* glsl */ `
uniform vec3 uGreen, uBlue, uIndigo, uAmber;
// Cyclic thin-film ramp: green -> blue -> indigo -> amber -> green.
vec3 film(float h) {
  h = fract(h) * 4.0;
  float f = smoothstep(0.0, 1.0, fract(h));
  if (h < 1.0) return mix(uGreen, uBlue, f);
  if (h < 2.0) return mix(uBlue, uIndigo, f);
  if (h < 3.0) return mix(uIndigo, uAmber, f);
  return mix(uAmber, uGreen, f);
}
float th31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float tnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(th31(i), th31(i + vec3(1,0,0)), f.x), mix(th31(i + vec3(0,1,0)), th31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(th31(i + vec3(0,0,1)), th31(i + vec3(1,0,1)), f.x), mix(th31(i + vec3(0,1,1)), th31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

const LIMB_VERT = /* glsl */ `
attribute float aT;      // 0 at the trunk .. 1 at a tip
attribute float aSide;   // +1 canopy, -1 roots
attribute vec3 aTan;     // limb direction (fibres run along it)
varying vec3 vPos;
varying vec3 vN;
varying vec3 vObj;
varying vec3 vTan;
varying float vT;
varying float vSide;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  vObj = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vTan = normalize(mat3(modelMatrix) * aTan);
  vT = aT;
  vSide = aSide;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const LIMB_FRAG = /* glsl */ `
uniform vec3 uBark;
uniform float uTime;
uniform float uLife;     // 0..1 how many sessions are alive (canopy sap strength)
varying vec3 vPos;
varying vec3 vN;
varying vec3 vObj;
varying vec3 vTan;
varying float vT;
varying float vSide;
${FILM_GLSL}
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vPos);
  float facing = abs(dot(N, V));
  float fres = pow(1.0 - facing, 2.2);
  // Fibres: noise stretched along the limb, so the bark reads as grain.
  vec3 T = normalize(vTan);
  float along = dot(vObj, T);
  vec3 across = vObj - T * along;
  float fib = tnoise(vec3(across * 3.2 + along * 0.18)) * 0.7 + tnoise(vObj * 1.3) * 0.3;
  // Thin film: hue shifts with angle, with the grain and very slowly with time.
  float below = step(vSide, 0.0);
  float h = 0.75 * fres + 0.55 * fib + 0.012 * vObj.y + 0.08 * sin(uTime * 0.05 + vObj.x * 0.07) + below * 0.33;
  vec3 sheen = film(h);
  // Sap: slow pulses of light along the limbs, rising in the canopy, sinking in the roots.
  float flowDir = vSide > 0.0 ? 1.0 : -0.5;
  float pulse = smoothstep(0.86, 1.0, fract(vT * 3.0 - uTime * 0.045 * flowDir + fib * 0.35));
  float sap = pulse * (vSide > 0.0 ? 0.4 + 0.7 * uLife : 0.22) * (0.35 + 0.65 * vT);
  vec3 c = uBark * (0.55 + 0.6 * fib) * (0.25 + 0.75 * facing);
  c += sheen * (0.22 + 0.7 * fres) * (vSide > 0.0 ? 1.0 : 0.6);
  // Inner light: the canopy glows a little from within, more toward the crown.
  c += sheen * (vSide > 0.0 ? 0.08 + 0.14 * vT : 0.03);
  c += sheen * sap;
  // Roots are quieter and lean indigo.
  c = mix(c, c * vec3(0.7, 0.75, 1.0), below * 0.5);
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  gl_FragColor = vec4(c, 1.0);
}`;

const LEAF_VERT = /* glsl */ `
attribute float aSeed;
attribute float aBorn;   // render-clock time the leaf appeared (-1e9 for old ones)
uniform float uTime;
uniform float uPx;       // px per world unit at distance 1
varying float vSeed;
varying float vNew;
void main() {
  vSeed = aSeed;
  vNew = 1.0 - clamp((uTime - aBorn) / 4.0, 0.0, 1.0);
  vec3 p = position + vec3(sin(uTime * 0.4 + aSeed * 30.0), cos(uTime * 0.33 + aSeed * 20.0), 0.0) * 0.25;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float grow = 1.0 - vNew * vNew;
  gl_PointSize = clamp((0.9 + 0.6 * fract(aSeed * 7.3)) * uPx / max(-mv.z, 1.0), 1.5, 9.0) * (0.4 + 0.6 * grow) * (1.0 + 1.2 * vNew);
}`;

const LEAF_FRAG = /* glsl */ `
uniform float uTime;
varying float vSeed;
varying float vNew;
${FILM_GLSL}
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0) discard;
  float tw = 0.55 + 0.45 * sin(uTime * (0.6 + vSeed) + vSeed * 40.0);
  vec3 c = film(vSeed * 0.9 + 0.1 * sin(uTime * 0.07 + vSeed * 9.0) + 0.75);
  float a = exp(-r * 2.6);
  vec3 outC = c * a * (0.55 + 0.45 * tw) + vec3(1.0) * a * vNew * 1.2;
  if (any(isnan(outC)) || any(isinf(outC))) outC = vec3(0.0);
  gl_FragColor = vec4(outC, 0.0);
}`;

const TIP_VERT = /* glsl */ `
attribute float aSide;
attribute float aLive;   // 0..1 how active the session on this tip is
uniform float uPx;
varying float vSide;
varying float vLive;
void main() {
  vSide = aSide;
  vLive = aLive;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((aSide > 0.0 ? 2.2 : 1.3) * uPx / max(-mv.z, 1.0), 1.5, 12.0);
}`;

const TIP_FRAG = /* glsl */ `
uniform float uTime;
varying float vSide;
varying float vLive;
${FILM_GLSL}
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0) discard;
  float a = exp(-r * 3.0);
  vec3 c;
  if (vSide > 0.0) {
    // Buds on living branches: a soft pearl glow that breathes faster when busy.
    float b = 0.6 + 0.4 * sin(uTime * (0.8 + 2.0 * vLive));
    c = mix(film(0.1 + vLive * 0.3), vec3(1.0), 0.35) * a * (0.35 + 0.45 * b * (0.4 + 0.6 * vLive));
  } else {
    // Seeds at the root ends: dim, indigo, still.
    c = uIndigo * a * 0.18;
  }
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  gl_FragColor = vec4(c, 0.0);
}`;

const AURA_VERT = /* glsl */ `
uniform float uR;
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uR * 2.0;
  gl_Position = projectionMatrix * mv;
}`;

const AURA_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
${FILM_GLSL}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // A soft luminous aura around the crown, its sheen drifting slowly through the film colors.
  float a = exp(-r * r / 0.22) * 0.12 + exp(-r / 0.35) * 0.05;
  vec3 c = film(0.75 + 0.1 * sin(uTime * 0.03) + r * 0.25) * a * (1.0 - smoothstep(0.85, 1.0, r));
  gl_FragColor = vec4(c, 0.0);
}`;

const ADD = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  transparent: true, depthWrite: false };

// ------------------------------------------------------------------- growth

/**
 * Grow a branching structure with exactly `tips` tips.
 * Returns { segs: [{a, b, ra, rb, t0, t1}], tips: [Vector3] }.
 */
function growSide(rnd, { tips, side, start, dir, length, radius, spread, fan = 1, fanTilt = 0.5, lift = 0 }) {
  const segs = [];
  const tipPts = [];
  const total = Math.max(1, tips);
  const up = new THREE.Vector3(0, side, 0);

  function grow(p0, d, len, n, depth, t0) {
    const r0 = radius * Math.sqrt(n / total);
    // A limb is 3 slightly bent pieces.
    let p = p0.clone();
    let dd = d.clone();
    const pieces = 3;
    const t1 = Math.min(1, t0 + 0.34 * (1 - t0) + 0.05);
    for (let k = 0; k < pieces; k++) {
      const bend = new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.4, rnd() - 0.5).multiplyScalar(0.35);
      // Canopy reaches up and out; roots spread out and then dive.
      // Crown: limbs reach out, then arc gently over (a dome). Roots: spread, then dive.
      const tropism = side > 0 ? up.clone().multiplyScalar(depth < 2 ? 0.05 : -0.05) : up.clone().multiplyScalar(0.06 + 0.1 * depth / 6);
      dd.add(bend).add(tropism).normalize();
      const q = p.clone().addScaledVector(dd, len / pieces);
      const ta = t0 + (t1 - t0) * (k / pieces), tb = t0 + (t1 - t0) * ((k + 1) / pieces);
      const ra = r0 * (1 - 0.18 * k / pieces), rb = r0 * (1 - 0.18 * (k + 1) / pieces);
      segs.push({ a: p.clone(), b: q.clone(), ra: Math.max(0.06, ra), rb: Math.max(0.05, rb), t0: ta, t1: tb });
      p = q;
    }
    if (n <= 1) {
      tipPts.push(p);
      // Crown: a spray of fine twigs at every living tip (fuller, still one tip per session).
      if (side > 0) {
        for (let k = 0; k < 4; k++) {
          const tw = dd.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() * 0.6 - 0.1, rnd() - 0.5).multiplyScalar(1.4)).normalize();
          const q = p.clone().addScaledVector(tw, len * (0.35 + 0.25 * rnd()));
          segs.push({ a: p.clone(), b: q, ra: 0.12, rb: 0.05, t0: 1, t1: 1, twig: true });
        }
      }
      return;
    }
    // Split the tips among 2 or 3 children (more children near the top of the canopy).
    const kids = n >= 3 && rnd() < (side > 0 ? 0.45 : 0.3) ? 3 : 2;
    const w = Array.from({ length: kids }, () => 0.6 + rnd());
    const sum = w.reduce((x, y) => x + y, 0);
    const parts = w.map((x) => Math.max(1, Math.floor((n * x) / sum)));
    let diff = n - parts.reduce((x, y) => x + y, 0);
    for (let i = 0; diff !== 0; i = (i + 1) % kids) {
      if (diff > 0) { parts[i]++; diff--; } else if (parts[i] > 1) { parts[i]--; diff++; }
    }
    const base = rnd() * Math.PI * 2;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] <= 0) continue;
      const az = base + (i / parts.length) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      const tilt = spread * (0.75 + 0.5 * rnd()) * (1 + depth * 0.08);
      // Child direction: tilt away from the parent direction around azimuth az.
      const ortho = new THREE.Vector3().crossVectors(dd, Math.abs(dd.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
      const ortho2 = new THREE.Vector3().crossVectors(dd, ortho).normalize();
      const swing = ortho.multiplyScalar(Math.cos(az)).add(ortho2.multiplyScalar(Math.sin(az)));
      const cd = dd.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(swing, Math.sin(tilt)).normalize();
      const clen = len * (0.72 + 0.12 * rnd()) * (parts[i] === 1 ? 0.8 : 1);
      grow(p, cd, clen, parts[i], depth + 1, t1);
    }
  }
  if (fan <= 1 || total < 2) {
    grow(start.clone(), dir.clone().normalize(), length, total, 0, 0);
  } else {
    // Several main limbs straight from the trunk, evenly around it (a broad crown / root plate).
    const k = Math.min(fan, total);
    const w = Array.from({ length: k }, () => 0.7 + rnd());
    const sum = w.reduce((x, y) => x + y, 0);
    const parts = w.map((x) => Math.max(1, Math.floor((total * x) / sum)));
    let diff = total - parts.reduce((x, y) => x + y, 0);
    for (let i = 0; diff !== 0; i = (i + 1) % k) {
      if (diff > 0) { parts[i]++; diff--; } else if (parts[i] > 1) { parts[i]--; diff++; }
    }
    const base = rnd() * Math.PI * 2;
    for (let i = 0; i < k; i++) {
      const az = base + (i / k) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const tilt = fanTilt * (0.85 + 0.3 * rnd());
      const d = new THREE.Vector3(Math.cos(az) * Math.sin(tilt), side * Math.cos(tilt), Math.sin(az) * Math.sin(tilt));
      const s0 = start.clone().add(new THREE.Vector3(Math.cos(az), 0, Math.sin(az)).multiplyScalar(radius * 0.6)).add(new THREE.Vector3(0, lift * rnd(), 0));
      grow(s0, d, length * (0.85 + 0.3 * rnd()), parts[i], 0, 0.08);
    }
  }
  return { segs, tips: tipPts };
}

/** Merge tapered tubes for every segment into one geometry. */
function buildLimbs(groups) {
  const pos = [], nor = [], tan = [], tt = [], side = [], idx = [];
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), axis = new THREE.Vector3();
  const u = new THREE.Vector3(), v = new THREE.Vector3();
  for (const g of groups) {
    for (const s of g.segs) {
      axis.subVectors(s.b, s.a);
      const L = axis.length();
      if (L < 1e-4) continue;
      axis.divideScalar(L);
      // Overlap neighbouring pieces a little so bends show no cracks.
      const ea = new THREE.Vector3().copy(s.a).addScaledVector(axis, -Math.min(s.ra * 0.5, L * 0.25));
      const eb = new THREE.Vector3().copy(s.b).addScaledVector(axis, Math.min(s.rb * 0.5, L * 0.25));
      u.crossVectors(axis, Math.abs(axis.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
      v.crossVectors(axis, u).normalize();
      const base = pos.length / 3;
      for (let ring = 0; ring < 2; ring++) {
        const c = ring ? eb : ea;
        const r = ring ? s.rb : s.ra;
        for (let k = 0; k < SIDES; k++) {
          const a = (k / SIDES) * Math.PI * 2;
          tmpA.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
          tmpB.copy(c).addScaledVector(tmpA, r);
          pos.push(tmpB.x, tmpB.y, tmpB.z);
          nor.push(tmpA.x, tmpA.y, tmpA.z);
          tan.push(axis.x, axis.y, axis.z);
          tt.push(ring ? s.t1 : s.t0);
          side.push(g.side);
        }
      }
      for (let k = 0; k < SIDES; k++) {
        const k2 = (k + 1) % SIDES;
        const a0 = base + k, a1 = base + k2, b0 = base + SIDES + k, b1 = base + SIDES + k2;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 3));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 1));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ------------------------------------------------------------------- class

export class KnowledgeTree {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'TreeOfKnowledge';
    parent.add(this.root);
    this._sig = '';
    this._canopyTips = [];
    this._rootTips = [];
    this._leafItems = new Map();     // knowledge id -> { born, idx }
    this._leafPos = [];              // candidate leaf spots (canopy)
    this._t = 0;

    const film = { uGreen: { value: color('TREE_GREEN') }, uBlue: { value: color('TREE_BLUE') },
      uIndigo: { value: color('TREE_INDIGO') }, uAmber: { value: color('TREE_AMBER') } };
    this._uni = { ...film, uTime: { value: 0 }, uLife: { value: 0 }, uBark: { value: color('TREE_BARK') }, uPx: { value: 400 } };

    this._limbMat = new THREE.ShaderMaterial({ name: 'TreeLimbs', uniforms: this._uni, vertexShader: LIMB_VERT, fragmentShader: LIMB_FRAG });
    this._limbs = new THREE.Mesh(new THREE.BufferGeometry(), this._limbMat);
    this._limbs.frustumCulled = false;
    this.root.add(this._limbs);

    this._leafGeo = new THREE.BufferGeometry();
    this._leafGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LEAVES_MAX * 3), 3));
    this._leafGeo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(LEAVES_MAX), 1));
    this._leafGeo.setAttribute('aBorn', new THREE.BufferAttribute(new Float32Array(LEAVES_MAX).fill(-1e9), 1));
    this._leafGeo.setDrawRange(0, 0);
    this._leafMat = new THREE.ShaderMaterial({ name: 'TreeLeaves', uniforms: this._uni, vertexShader: LEAF_VERT, fragmentShader: LEAF_FRAG, ...ADD });
    this._leaves = new THREE.Points(this._leafGeo, this._leafMat);
    this._leaves.frustumCulled = false;
    this.root.add(this._leaves);

    this._auraUni = { ...film, uTime: this._uni.uTime, uR: { value: 40 } };
    this._auraMat = new THREE.ShaderMaterial({ name: 'TreeAura', uniforms: this._auraUni, vertexShader: AURA_VERT, fragmentShader: AURA_FRAG, ...ADD });
    this._aura = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._auraMat);
    this._aura.frustumCulled = false;
    this._aura.renderOrder = -6;
    this.root.add(this._aura);

    this._tipGeo = new THREE.BufferGeometry();
    this._tipMat = new THREE.ShaderMaterial({ name: 'TreeTips', uniforms: this._uni, vertexShader: TIP_VERT, fragmentShader: TIP_FRAG, ...ADD });
    this._tips = new THREE.Points(this._tipGeo, this._tipMat);
    this._tips.frustumCulled = false;
    this.root.add(this._tips);
  }

  /** Height range, for picking and framing. */
  get top() { return this._top ?? 40; }
  get bottom() { return this._bottom ?? -30; }

  /**
   * Regrow if the number of living / dormant sessions changed.
   * @param {number} alive  live sessions (canopy tips)
   * @param {number} dormant dormant or dead sessions (root tips)
   */
  setSessions(alive, dormant) {
    const a = Math.max(CANOPY_MIN, alive);
    const d = Math.max(3, Math.min(ROOTS_MAX, dormant));
    const sig = `${a}|${d}`;
    if (sig === this._sig) return false;
    this._sig = sig;
    const rnd = mulberry32(20261108);
    // Erdtree-like: a broad dome crown fanning straight from the trunk, a wide root plate.
    const canopy = growSide(rnd, {
      tips: a, side: 1, start: new THREE.Vector3(0, TRUNK_TOP, 0), dir: new THREE.Vector3(0, 1, 0),
      length: 19 + 3 * Math.log2(1 + a), radius: 3.4, spread: 0.85, fan: Math.min(7, Math.max(4, Math.round(a / 2.5))), fanTilt: 1.2, lift: 4,
    });
    const roots = growSide(rnd, {
      tips: d, side: -1, start: new THREE.Vector3(0, TRUNK_BOTTOM, 0), dir: new THREE.Vector3(0, -1, 0),
      length: 8 + 1.8 * Math.log2(1 + d), radius: 3.2, spread: 0.7, fan: 7, fanTilt: 1.25, lift: -2,
    });
    // The trunk: five strands braided around each other, from the root plate to the crown.
    const trunk = { side: 1, segs: [] };
    const STRANDS = 5, PIECES = 10, TURNS = 0.55, BR = 2.2;
    for (let k = 0; k < STRANDS; k++) {
      const a0 = (k / STRANDS) * Math.PI * 2;
      let prev = null;
      for (let j = 0; j <= PIECES; j++) {
        const u = j / PIECES;
        const y = TRUNK_BOTTOM - 2 + (TRUNK_TOP + 2 - TRUNK_BOTTOM) * u;
        const flare = 1 + 0.9 * Math.pow(Math.abs(u - 0.5) * 2, 3);    // wider at both ends
        const ang = a0 + u * TURNS * Math.PI * 2;
        const pt = new THREE.Vector3(Math.cos(ang) * BR * flare, y, Math.sin(ang) * BR * flare);
        if (prev) trunk.segs.push({ a: prev, b: pt, ra: 1.25 * flare, rb: 1.25 * flare, t0: 0.04 * u, t1: 0.04 * u });
        prev = pt;
      }
    }
    const old = this._limbs.geometry;
    this._limbs.geometry = buildLimbs([trunk, { side: 1, segs: canopy.segs }, { side: -1, segs: roots.segs }]);
    old.dispose();
    this._canopyTips = canopy.tips.slice(0, alive);
    this._rootTips = roots.tips;
    let top = TRUNK_TOP, bottom = TRUNK_BOTTOM;
    for (const p of canopy.tips) top = Math.max(top, p.y);
    for (const p of roots.tips) bottom = Math.min(bottom, p.y);
    this._top = top; this._bottom = bottom;
    // Crown aura: centred in the canopy, as wide as the crown.
    let ext = 10;
    for (const p of canopy.tips) ext = Math.max(ext, Math.hypot(p.x, p.z));
    this._aura.position.set(0, (TRUNK_TOP + top) / 2 + 2, 0);
    this._auraUni.uR.value = Math.max(ext, (top - TRUNK_TOP) * 0.7) * 1.25;

    // Leaf spots: clustered around the canopy's outer limbs.
    this._leafPos = [];
    const lr = mulberry32(77);
    for (const sgm of canopy.segs) {
      if (sgm.t1 < 0.4) continue;
      for (let k = 0; k < (sgm.twig ? 3 : 4); k++) {
        const p = sgm.a.clone().lerp(sgm.b, lr()).add(new THREE.Vector3(lr() - 0.5, lr() - 0.3, lr() - 0.5).multiplyScalar(6.5));
        this._leafPos.push(p);
      }
    }
    this._placeLeaves();

    // Tips: buds on living branches, seeds at the roots.
    const n = canopy.tips.length + roots.tips.length;
    const tp = new Float32Array(n * 3), ts = new Float32Array(n), tl = new Float32Array(n);
    let i = 0;
    for (const p of canopy.tips) { tp.set([p.x, p.y, p.z], i * 3); ts[i] = 1; tl[i] = i < alive ? 0.5 : 0; i++; }
    for (const p of roots.tips) { tp.set([p.x, p.y, p.z], i * 3); ts[i] = -1; tl[i] = 0; i++; }
    this._tipGeo.dispose();
    this._tipGeo = new THREE.BufferGeometry();
    this._tipGeo.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    this._tipGeo.setAttribute('aSide', new THREE.BufferAttribute(ts, 1));
    this._tipGeo.setAttribute('aLive', new THREE.BufferAttribute(tl, 1));
    this._tips.geometry = this._tipGeo;
    return true;
  }

  /** Activity 0..1 per living session, in canopy-tip order (brighter, faster buds). */
  setLiveness(levels) {
    const a = this._tipGeo.getAttribute('aLive');
    if (!a) return;
    for (let i = 0; i < this._canopyTips.length && i < a.count; i++) a.array[i] = clamp(levels[i] ?? 0.5, 0, 1);
    a.needsUpdate = true;
  }

  /** Knowledge list (GET /api/knowledge items). New items grow in as bright new leaves unless quiet. */
  setKnowledge(items, { quiet = false } = {}) {
    const keep = new Set();
    for (const it of (items || []).slice(0, LEAVES_MAX)) {
      keep.add(it.id);
      if (!this._leafItems.has(it.id)) this._leafItems.set(it.id, { born: quiet ? -1e9 : this._t });
    }
    for (const id of [...this._leafItems.keys()]) if (!keep.has(id)) this._leafItems.delete(id);
    this._placeLeaves();
  }

  _placeLeaves() {
    const pos = this._leafGeo.getAttribute('position');
    const seed = this._leafGeo.getAttribute('aSeed');
    const born = this._leafGeo.getAttribute('aBorn');
    const spots = this._leafPos.length;
    const ids = [...this._leafItems.keys()].sort();
    let n = 0;
    for (const id of ids) {
      if (!spots) break;
      for (let g = 0; g < GLINTS && n < LEAVES_MAX; g++) {
        const key = g ? `${id}#${g}` : id;
        const h = hash01(key);
        const p = this._leafPos[Math.floor(h * spots) % spots];
        pos.setXYZ(n, p.x + (hash01(key + '#j') - 0.5) * 3, p.y + (hash01(key + '#k') - 0.5) * 3, p.z + (hash01(key + '#l') - 0.5) * 3);
        seed.setX(n, h);
        born.setX(n, this._leafItems.get(id).born);
        n++;
      }
    }
    pos.needsUpdate = true; seed.needsUpdate = true; born.needsUpdate = true;
    this._leafGeo.setDrawRange(0, n);
    this.leafCount = this._leafItems.size;
  }

  /** World position of a fresh leaf spot near the top of the canopy (beam landing). */
  landingPoint(out) {
    const spots = this._leafPos;
    if (!spots.length) return out.set(0, TRUNK_TOP + 8, 0);
    return out.copy(spots[Math.floor(Math.random() * spots.length)]).applyMatrix4(this.root.matrixWorld);
  }

  update(dt, t, f) {
    this._t = t;
    this._uni.uTime.value = t;
    this._uni.uPx.value = f.pxK;
    this._uni.uLife.value = clamp((f.alive ?? 0) / 6, 0, 1);
    // A slow, stately turn.
    this.root.rotation.y = t * 0.012;
    return 0;
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this._limbs.geometry.dispose(); this._limbMat.dispose();
    this._leafGeo.dispose(); this._leafMat.dispose();
    this._tipGeo.dispose(); this._tipMat.dispose();
    this._aura.geometry.dispose(); this._auraMat.dispose();
  }
}
