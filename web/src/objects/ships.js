// ships.js: traffic between the star and its files.
//
//   tool-call ship  : one per tool call. Launches from the star surface, arcs
//                     along a quadratic Bézier to the planet (file) it touches,
//                     and is absorbed into it (Planets.ping). No file target:
//                     a short teardrop loop out past the disk and back.
//   convoy          : ≥ 4 calls at one planet within 1 s, or > 16 ships in
//                     flight: new calls merge into one lead ship + up to 4 V
//                     followers with a wider trail. Busy reads as calm, dense.
//   subagent ship   : larger, mint, twin engines. Departs to its own tilted
//                     orbit (r 16–20, hashed from its id), circles while the
//                     subagent works, flies home when it ends, docks with a ripple.
//
// Draws: 2 for any amount of traffic.
//   - hulls  : one InstancedMesh (≤ 64), lit by the star, emissive engine block
//   - light  : one dynamic BufferGeometry, additive: ribbon trails, engine glow
//              billboards and dock ripples, distinguished per vertex by `kind`
// Only these two buffers are uploaded per frame, and only while traffic exists.

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { hash01, clamp } from '../lib/math.js';

const MAX_HULLS = 64;
const MAX_FLIGHTS = 48;          // tool flights (leads); followers share their trail
const MAX_AGENTS = 8;
const MAX_RIPPLES = 8;
const TOOL_LEN = 0.18;
const AGENT_LEN = 0.35;
const TOOL_TRAIL = 1.5, TOOL_SEGS = 12;
const AGENT_TRAIL = 2.5, AGENT_SEGS = 16;
const MAX_POINTS = AGENT_SEGS + 2;
const CONVOY_WINDOW = 1.0;
const CONVOY_COUNT = 4;
const CONVOY_INFLIGHT = 16;
const RECENT = 32;
const LOOP_TIME = 1.2;
const LOOP_OUT = 3.7;            // just past the accretion disk edge (3.2)
const RETRACT_TIME = 0.35;       // trail drains into the planet after arrival
const AGENT_OUT = 2.0, AGENT_HOME = 2.5, AGENT_PERIOD = 20;
const RIPPLE_TIME = 0.8;
const TAU = Math.PI * 2;

const VERT_CAP = (MAX_FLIGHTS + MAX_AGENTS) * MAX_POINTS * 2 + (MAX_HULLS + MAX_AGENTS) * 4 + MAX_RIPPLES * 4;
const IDX_CAP = (MAX_FLIGHTS + MAX_AGENTS) * (MAX_POINTS - 1) * 6 + (MAX_HULLS + MAX_AGENTS + MAX_RIPPLES) * 6;

/** Monotone ease that leaves at full speed and arrives at rest: s'(0)=1, s'(1)=0. */
const easeDock = (x) => x * (1 + x - x * x);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };

// ---------------------------------------------------------------------------
// Shaders

const HULL_VERT = /* glsl */ `
  attribute vec4 aTint;     // rgb ship color (linear), w = engine/emissive gain
  varying vec3 vN;
  varying vec3 vPosW;
  varying vec4 vTint;
  varying float vRear;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 w = m * vec4(position, 1.0);
    vPosW = w.xyz;
    vN = normalize(mat3(m) * normal);
    vTint = aTint;
    vRear = smoothstep(-0.12, -0.36, position.z);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const HULL_FRAG = /* glsl */ `
  uniform vec3 uStarW;
  varying vec3 vN;
  varying vec3 vPosW;
  varying vec4 vTint;
  varying float vRear;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uStarW - vPosW);
    float ndl = max(dot(N, L), 0.0);
    // Dark ceramic hull tinted by role; star-lit facets plus a role-colored rim.
    vec3 base = vTint.rgb * 0.16 + 0.03;
    vec3 col = base * (0.12 + 0.88 * ndl);
    vec3 H = normalize(L + V);
    col += vec3(0.6) * pow(max(dot(N, H), 0.0), 40.0) * ndl;
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += vTint.rgb * rim * 0.55 * vTint.w;
    col += vTint.rgb * vRear * 1.25 * vTint.w;    // engine block
    gl_FragColor = vec4(col, 1.0);
  }
`;

const LIGHT_VERT = /* glsl */ `
  attribute vec3 aColor;    // premultiplied HDR color
  attribute vec4 aData;     // u (0 head → 1 tail), v (−1..1 across), kind, billboard size
  attribute vec2 aCorner;   // billboard corner (−1..1), zero for ribbons
  varying vec3 vColor;
  varying vec4 vData;
  varying vec2 vCorner;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.xy += aCorner * aData.w;   // camera-facing quads expand in view space
    vColor = aColor;
    vData = aData;
    vCorner = aCorner;
    gl_Position = projectionMatrix * mv;
  }
`;
const LIGHT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying vec4 vData;
  varying vec2 vCorner;
  void main() {
    float kind = vData.z;
    float a;
    vec3 col = vColor;
    if (kind < 0.5) {
      // Ribbon: soft gaussian cross-section, hot white core near the head.
      float v = vData.y;
      float u = clamp(vData.x, 0.0, 1.0);
      float prof = exp(-v * v * 3.2);
      float fade = pow(1.0 - u, 1.7);
      float core = exp(-v * v * 26.0) * pow(1.0 - u, 4.0);
      col = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), core * 0.5);
      a = prof * fade + core * 0.6;
    } else if (kind < 1.5) {
      // Engine glow: tight core + wide soft skirt, zero at the quad edge.
      float d2 = dot(vCorner, vCorner);
      a = (exp(-d2 * 9.0) + 0.12 * exp(-d2 * 3.0)) * (1.0 - smoothstep(0.55, 1.0, sqrt(d2)));
    } else {
      // Dock ripple: a thin ring (intensity already carries the fade).
      float d = length(vCorner);
      float x = (d - 0.82) / 0.055;
      a = exp(-x * x);
    }
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

/** 8-triangle dart: nose +Z, engines −Z, flat-ish in Y. Unit length. */
function makeHullGeometry() {
  const N = [0, 0, 0.62], T = [0, 0, -0.38];
  const L = [-0.21, 0, -0.2], R = [0.21, 0, -0.2], U = [0, 0.075, -0.12], D = [0, -0.05, -0.2];
  const tris = [[N, L, U], [N, U, R], [N, R, D], [N, D, L], [T, U, L], [T, R, U], [T, D, R], [T, L, D]];
  const pos = [];
  const c = [0, 0, -0.1];
  for (const [a, b, d] of tris) {
    // Orient every face outward (normal points away from the body center).
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const m = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]];
    const flip = n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0;
    pos.push(...a, ...(flip ? d : b), ...(flip ? b : d));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();   // non-indexed → flat facets
  return g;
}

function makeTrail(segs) {
  return { pts: new Float32Array(segs * 3), n: 0, segs };
}

export class Ships {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx
   * @param {{resolveTarget?: Function, onArrive?: Function, starRadius?: Function}} opts
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this.resolveTarget = opts.resolveTarget || (() => false);
    this.onArrive = opts.onArrive || null;
    this.starRadius = opts.starRadius || (() => 1);
    this.root = new THREE.Group();
    this.root.name = 'ships';
    parent.add(this.root);
    this._disposed = false;

    // Colors (linear) and HDR gains normalized by luminance so the engine glow
    // peaks at 3 and trails stay well under it (ART_DIRECTION brightness ladder).
    this._cTool = color('SHIP_TOOL');
    this._cAgent = color('SHIP_AGENT');
    const lum = (c) => Math.max(1e-3, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    this._gTool = 1 / lum(this._cTool);
    this._gAgent = 1 / lum(this._cAgent);

    // --- hulls
    this._hullGeo = makeHullGeometry();
    this._tint = new Float32Array(MAX_HULLS * 4);
    this._tintAttr = new THREE.InstancedBufferAttribute(this._tint, 4);
    this._tintAttr.setUsage(THREE.DynamicDrawUsage);
    this._hullGeo.setAttribute('aTint', this._tintAttr);
    this._hullUniforms = { uStarW: { value: new THREE.Vector3() } };
    this._hullMat = new THREE.ShaderMaterial({
      uniforms: this._hullUniforms,
      vertexShader: HULL_VERT,
      fragmentShader: HULL_FRAG,
    });
    this._hulls = new THREE.InstancedMesh(this._hullGeo, this._hullMat, MAX_HULLS);
    this._hulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._hulls.frustumCulled = false;
    this._hulls.count = 0;
    this._hulls.visible = false;
    this.root.add(this._hulls);

    // --- additive light buffer (trails + glows + ripples)
    this._pos = new Float32Array(VERT_CAP * 3);
    this._col = new Float32Array(VERT_CAP * 3);
    this._dat = new Float32Array(VERT_CAP * 4);
    this._cor = new Float32Array(VERT_CAP * 2);
    this._idx = new Uint16Array(IDX_CAP);
    const lg = new THREE.BufferGeometry();
    const dyn = (arr, size) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    this._posAttr = dyn(this._pos, 3);
    this._colAttr = dyn(this._col, 3);
    this._datAttr = dyn(this._dat, 4);
    this._corAttr = dyn(this._cor, 2);
    this._idxAttr = dyn(this._idx, 1);
    lg.setAttribute('position', this._posAttr);
    lg.setAttribute('aColor', this._colAttr);
    lg.setAttribute('aData', this._datAttr);
    lg.setAttribute('aCorner', this._corAttr);
    lg.setIndex(this._idxAttr);
    lg.setDrawRange(0, 0);
    this._lightGeo = lg;
    this._lightMat = new THREE.ShaderMaterial({
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._light = new THREE.Mesh(lg, this._lightMat);
    this._light.frustumCulled = false;
    this._light.visible = false;
    this._light.renderOrder = 2;
    this.root.add(this._light);

    // --- pools (allocated once; update() never allocates)
    const v3 = () => new THREE.Vector3();
    this._flights = [];
    for (let i = 0; i < MAX_FLIGHTS; i++) {
      this._flights.push({
        active: false, target: null, loop: false, t0: 0, dur: 1, merged: 1,
        follow: new Float32Array(4).fill(-1), arrived: false, arriveT: 0,
        dir: v3(), side: v3(), end: v3(), arc: 1, lat: 0,
        head: v3(), fwd: v3(), prevFwd: v3(), bank: 0, scale: 0,
        trail: makeTrail(TOOL_SEGS),
      });
    }
    this._agents = [];
    for (let i = 0; i < MAX_AGENTS; i++) {
      this._agents.push({
        active: false, id: null, stamp: 0, R: 18, incl: 0, node: 0, phiIns: 0,
        age: 0, homeAt: -1, phase: 0,
        b0: v3(), b1: v3(), b2: v3(), b3: v3(), dirIn: v3(),
        head: v3(), fwd: v3(), prevFwd: v3(), bank: 0, scale: 0,
        trail: makeTrail(AGENT_SEGS),
      });
    }
    this._ripples = [];
    for (let i = 0; i < MAX_RIPPLES; i++) this._ripples.push({ active: false, t0: 0 });

    this._seenCalls = new Map();     // tool call id -> data time (pruned)
    this._seenAgentsDone = new Map(); // finished subagent id -> data time
    this._recentKey = new Array(RECENT).fill(null);
    this._recentT = new Float64Array(RECENT).fill(-Infinity);
    this._recentI = 0;
    this._frame = 0;
    this._lastNow = -Infinity;
    this._lastPrune = 0;
    this._t = 0;
    this._hullN = 0;
    this._vN = 0;
    this._iN = 0;

    // scratch
    this._a = v3(); this._b = v3(); this._c = v3(); this._d = v3(); this._e = v3();
    this._cam = v3();
    this._m = new THREE.Matrix4();
    this._sc = v3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /**
   * World-space position of a subagent ship (GALAXY_CONTRACT §5.9). Read-only:
   * copies the head computed in the last update; false if that agent has no
   * ship in flight. No allocation, no effect on visuals or update order.
   */
  getAgentPosition(agentId, out) {
    if (this._disposed || agentId == null) return false;
    for (let i = 0; i < MAX_AGENTS; i++) {
      const a = this._agents[i];
      if (a.active && a.id === agentId) {
        out.copy(a.head);
        this.root.localToWorld(out);
        return true;
      }
    }
    return false;
  }

  get inFlight() {
    let n = 0;
    for (let i = 0; i < MAX_FLIGHTS; i++) if (this._flights[i].active && !this._flights[i].arrived) n++;
    for (let i = 0; i < MAX_AGENTS; i++) if (this._agents[i].active) n++;
    return n;
  }

  // -------------------------------------------------------------------------

  update(state, dt, t) {
    if (this._disposed || !state) return 0;
    if (state.now < this._lastNow - 1e-3) this.reset();
    this._lastNow = state.now;
    this._t = t;
    this._frame++;
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(this._hullUniforms.uStarW.value);
    const cam = this.ctx?.camera;
    if (cam) {
      this._cam.setFromMatrixPosition(cam.matrixWorld);
      this.root.worldToLocal(this._cam);
    }

    this._ingestToolCalls(state, t);
    this._ingestSubagents(state, t);
    if (state.now - this._lastPrune > 5) this._prune(state.now);

    // --- simulate + build geometry
    this._hullN = 0;
    this._vN = 0;
    this._iN = 0;
    let busy = false;
    for (let i = 0; i < MAX_FLIGHTS; i++) {
      const f = this._flights[i];
      if (f.active) { this._stepFlight(f, dt, t); busy = true; }
    }
    for (let i = 0; i < MAX_AGENTS; i++) {
      const a = this._agents[i];
      if (a.active) { this._stepAgent(a, dt, t); busy = true; }
    }
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = this._ripples[i];
      if (!r.active) continue;
      const k = (t - r.t0) / RIPPLE_TIME;
      if (k >= 1) { r.active = false; continue; }
      busy = true;
      const rs = this.starRadius();
      const g = this._gAgent * 1.4 * (1 - k) * (1 - k);
      this._emitQuad(0, 0, 0, rs * (1.05 + 0.9 * easeInOut(k)) / 0.82, this._cAgent, g, 2);
    }

    this._hulls.count = this._hullN;
    this._hulls.visible = this._hullN > 0;
    if (this._hullN > 0) {
      this._hulls.instanceMatrix.needsUpdate = true;
      this._tintAttr.needsUpdate = true;
    }
    this._light.visible = this._iN > 0;
    this._lightGeo.setDrawRange(0, this._iN);
    if (this._iN > 0) {
      this._posAttr.needsUpdate = true;
      this._colAttr.needsUpdate = true;
      this._datAttr.needsUpdate = true;
      this._corAttr.needsUpdate = true;
      this._idxAttr.needsUpdate = true;
    }
    return busy ? 2 : 0;
  }

  reset() {
    for (const f of this._flights) { f.active = false; f.trail.n = 0; }
    for (const a of this._agents) { a.active = false; a.id = null; a.trail.n = 0; }
    for (const r of this._ripples) r.active = false;
    this._seenCalls.clear();
    this._seenAgentsDone.clear();
    this._recentKey.fill(null);
    this._recentT.fill(-Infinity);
    this._lastNow = -Infinity;
    this._lastPrune = 0;
    this._hulls.count = 0;
    this._hulls.visible = false;
    this._light.visible = false;
    this._lightGeo.setDrawRange(0, 0);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.root.parent?.remove(this.root);
    this._hullGeo.dispose();
    this._hullMat.dispose();
    this._lightGeo.dispose();
    this._lightMat.dispose();
    this._hulls.dispose?.();
  }

  // -------------------------------------------------------------------------
  // Event ingestion

  _ingestToolCalls(state, t) {
    const calls = state.toolCalls;
    if (!calls || !calls.length) return;
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const key = c.id ?? c.t;
      if (this._seenCalls.has(key)) continue;
      this._seenCalls.set(key, c.t);
      const age = state.now - c.t;
      if (age < -0.5) { this._seenCalls.delete(key); continue; }   // future frame: wait
      const target = c.target ?? null;
      const has = target != null && this._resolveLocal(target, this._a);
      const dist = has ? this._a.length() : 0;
      const dur = has ? 1.2 + 0.08 * dist : LOOP_TIME;
      if (age > dur + 0.5) continue;   // too old to show honestly

      // Convoy rule: count recent calls at the same target (data time).
      const k = has ? target : '';
      let same = 0;
      for (let j = 0; j < RECENT; j++) {
        if (this._recentKey[j] === k && Math.abs(this._recentT[j] - c.t) <= CONVOY_WINDOW) same++;
      }
      this._recentKey[this._recentI] = k;
      this._recentT[this._recentI] = c.t;
      this._recentI = (this._recentI + 1) % RECENT;
      const merge = same + 1 >= CONVOY_COUNT || this.inFlight > CONVOY_INFLIGHT;
      if (merge && this._mergeInto(k, has, t, 0.4)) continue;
      const f = this._freeFlight();
      if (!f) { this._mergeInto(k, has, t, 0.95); continue; }   // budget full: join anything going there
      this._launch(f, c, has ? target : null, dur, t);
    }
  }

  _mergeInto(key, has, t, maxProgress) {
    let best = null;
    for (let i = 0; i < MAX_FLIGHTS; i++) {
      const f = this._flights[i];
      if (!f.active || f.arrived) continue;
      if ((has ? f.target : '') !== key || f.loop === has) continue;
      const p = (t - f.t0) / f.dur;
      if (p > maxProgress) continue;
      if (!best || f.t0 > best.t0) best = f;
    }
    if (!best) return false;
    best.merged++;
    // Fill the next empty V slot; the trail widens with every merged call.
    for (let s = 0; s < 4; s++) if (best.follow[s] < 0) { best.follow[s] = t; break; }
    return true;
  }

  _freeFlight() {
    for (let i = 0; i < MAX_FLIGHTS; i++) if (!this._flights[i].active) return this._flights[i];
    return null;
  }

  _launch(f, call, target, dur, t) {
    f.active = true;
    f.target = target;
    f.loop = target == null;
    f.t0 = t;
    f.dur = dur;
    f.merged = 1;
    f.follow.fill(-1);
    f.arrived = false;
    f.bank = 0;
    f.scale = 0;
    f.trail.n = 0;
    // Per-ship jitter carries no meaning, so Math.random is allowed here.
    f.arc = Math.random() < 0.5 ? -1 : 1;
    f.lat = (Math.random() * 2 - 1) * 0.12;
    if (f.loop) {
      // Loop plane: direction hashed from the call id, kept near the orbital plane.
      const h = hash01(String(call.id ?? call.t));
      const ang = h * TAU;
      f.dir.set(Math.cos(ang), (hash01(String(call.id ?? call.t) + '#y') - 0.5) * 0.5, Math.sin(ang)).normalize();
      f.side.crossVectors(this._up, f.dir).normalize();
      f.end.copy(f.dir).multiplyScalar(LOOP_OUT);
    } else {
      this._resolveLocal(target, f.end);
      f.dir.copy(f.end).normalize();
      // Small launch-point scatter so a stream of ships doesn't share one pixel.
      f.dir.x += (Math.random() - 0.5) * 0.25;
      f.dir.y += (Math.random() - 0.5) * 0.25;
      f.dir.z += (Math.random() - 0.5) * 0.25;
      f.dir.normalize();
    }
    this._evalFlight(f, 0, f.head);
    f.prevFwd.copy(f.dir);
  }

  _ingestSubagents(state, t) {
    const list = state.subagents;
    const frame = this._frame;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.id == null || this._seenAgentsDone.has(s.id)) continue;
        let a = null;
        for (let j = 0; j < MAX_AGENTS; j++) {
          if (this._agents[j].active && this._agents[j].id === s.id) { a = this._agents[j]; break; }
        }
        if (a) {
          a.stamp = frame;
          if (s.endT != null && a.homeAt < 0) this._sendHome(a, a.age);
          continue;
        }
        const age = state.now - s.t;
        if (age < 0) continue;
        if (s.endT != null) {
          const since = state.now - s.endT;
          if (since > AGENT_HOME) { this._seenAgentsDone.set(s.id, state.now); continue; }
          // Joined late: it is already on its way home.
          a = this._spawnAgent(s, age, frame);
          if (a) this._sendHome(a, Math.max(0, s.endT - s.t));
          continue;
        }
        this._spawnAgent(s, age, frame);
      }
    }
    // Ships whose subagent vanished from the data go home too.
    for (let i = 0; i < MAX_AGENTS; i++) {
      const a = this._agents[i];
      if (a.active && a.stamp !== frame && a.homeAt < 0) this._sendHome(a, a.age);
    }
  }

  _spawnAgent(s, age, frame) {
    let a = null;
    for (let j = 0; j < MAX_AGENTS; j++) if (!this._agents[j].active) { a = this._agents[j]; break; }
    if (!a) return null;   // > 8 concurrent subagents: extras are not drawn
    const id = String(s.id);
    a.active = true;
    a.id = s.id;
    a.stamp = frame;
    a.R = 16 + 4 * hash01(id + '#R');
    a.incl = ((8 + 18 * hash01(id + '#i')) * Math.PI / 180) * (hash01(id + '#s') < 0.5 ? -1 : 1);
    a.node = TAU * hash01(id + '#n');
    a.phiIns = TAU * hash01(id + '#p');
    a.age = age;
    a.homeAt = -1;
    a.bank = 0;
    a.scale = age > AGENT_OUT ? 1 : 0;
    a.trail.n = 0;
    // Departure cubic: leave the star, meet the orbit tangentially at orbital speed.
    const rs = this.starRadius();
    this._orbitPoint(a, a.phiIns, a.b3);
    this._orbitTangent(a, a.phiIns, this._d);
    const h = (a.R * TAU / AGENT_PERIOD) * AGENT_OUT / 3;   // matches end speed
    a.b2.copy(a.b3).addScaledVector(this._d, -h);
    a.dirIn.copy(a.b2).normalize();
    a.b0.copy(a.dirIn).multiplyScalar(rs * 1.02);
    a.b1.copy(a.dirIn).multiplyScalar(rs + 4);
    this._agentPos(a, a.head, this._e);
    a.prevFwd.copy(this._e);
    return a;
  }

  /**
   * Begin the 2.5 s flight home. `ageAtHome` is the ship's local age when the
   * subagent ended (equal to a.age live; earlier when joining a replay late).
   */
  _sendHome(a, ageAtHome) {
    const rs = this.starRadius();
    if (ageAtHome >= AGENT_OUT) {
      const phi = a.phiIns + (TAU / AGENT_PERIOD) * (ageAtHome - AGENT_OUT);
      this._orbitPoint(a, phi, a.b0);
      this._orbitTangent(a, phi, this._d);
    } else {
      // Recalled mid-departure: turn around from where it was on the way out.
      const saved = a.age;
      a.age = ageAtHome;
      this._agentPos(a, this._b, this._d);
      a.age = saved;
      a.b0.copy(this._b);
    }
    a.homeAt = ageAtHome;
    const h = (a.R * TAU / AGENT_PERIOD) * AGENT_HOME / 3;
    a.b1.copy(a.b0).addScaledVector(this._d, h);
    a.dirIn.copy(a.b0).normalize();
    a.b2.copy(a.dirIn).multiplyScalar(rs + 3);
    a.b3.copy(a.dirIn).multiplyScalar(rs * 1.02);
  }

  _prune(now) {
    this._lastPrune = now;
    for (const [k, v] of this._seenCalls) if (now - v > 120) this._seenCalls.delete(k);
    for (const [k, v] of this._seenAgentsDone) if (now - v > 600) this._seenAgentsDone.delete(k);
  }

  // -------------------------------------------------------------------------
  // Paths

  _resolveLocal(target, out) {
    if (!this.resolveTarget(target, out)) return false;
    this.root.worldToLocal(out);
    return true;
  }

  /** Flight position at normalized time x (eased inside). */
  _evalFlight(f, x, out) {
    const rs = this.starRadius();
    if (f.loop) {
      // Teardrop: out past the disk and back, swinging ±0.7 rad around the star.
      const p = x;
      const r = rs * 1.02 + (LOOP_OUT - rs) * Math.sin(Math.PI * p);
      const ang = (p - 0.5) * 1.4;
      out.copy(f.dir).multiplyScalar(Math.cos(ang)).addScaledVector(f.side, Math.sin(ang)).multiplyScalar(r);
      return out;
    }
    const s = easeInOut(x);
    const p0 = this._b.copy(f.dir).multiplyScalar(rs * 1.02);
    const p2 = f.end;
    // Control point: midpoint lifted 15 % of the distance out of plane.
    const dist = p0.distanceTo(p2);
    const p1 = this._c.addVectors(p0, p2).multiplyScalar(0.5);
    p1.y += f.arc * 0.15 * dist;
    this._d.crossVectors(this._up, this._e.subVectors(p2, p0)).normalize();
    p1.addScaledVector(this._d, f.lat * dist);
    const u = 1 - s;
    out.set(
      u * u * p0.x + 2 * u * s * p1.x + s * s * p2.x,
      u * u * p0.y + 2 * u * s * p1.y + s * s * p2.y,
      u * u * p0.z + 2 * u * s * p1.z + s * s * p2.z,
    );
    return out;
  }

  _orbitPoint(a, phi, out) {
    const vx = a.R * Math.cos(phi), vz = a.R * Math.sin(phi);
    return this._tilt(a, vx, vz, out);
  }
  _orbitTangent(a, phi, out) {
    return this._tilt(a, -Math.sin(phi), Math.cos(phi), out).normalize();
  }
  /** Rotate an XZ-plane vector by the orbit's inclination about its node axis. */
  _tilt(a, vx, vz, out) {
    const nx = Math.cos(a.node), nz = Math.sin(a.node);
    const ci = Math.cos(a.incl), si = Math.sin(a.incl);
    const nd = nx * vx + nz * vz;
    out.set(vx * ci + nx * nd * (1 - ci), (nz * vx - nx * vz) * si, vz * ci + nz * nd * (1 - ci));
    return out;
  }

  /** Subagent position + forward at its current local age. */
  _agentPos(a, out, fwd) {
    const omega = TAU / AGENT_PERIOD;
    if (a.homeAt >= 0) {
      const x = clamp((a.age - a.homeAt) / AGENT_HOME, 0, 1);
      return this._cubic(a, easeDock(x), out, fwd);
    }
    if (a.age < AGENT_OUT) return this._cubic(a, clamp(a.age / AGENT_OUT, 0, 1), out, fwd);
    const phi = a.phiIns + omega * (a.age - AGENT_OUT);
    this._orbitPoint(a, phi, out);
    this._orbitTangent(a, phi, fwd);
    return out;
  }

  _cubic(a, s, out, fwd) {
    const u = 1 - s;
    const w0 = u * u * u, w1 = 3 * u * u * s, w2 = 3 * u * s * s, w3 = s * s * s;
    out.set(0, 0, 0)
      .addScaledVector(a.b0, w0).addScaledVector(a.b1, w1)
      .addScaledVector(a.b2, w2).addScaledVector(a.b3, w3);
    // Derivative for heading.
    const d0 = 3 * u * u, d1 = 6 * u * s, d2 = 3 * s * s;
    fwd.set(0, 0, 0)
      .addScaledVector(this._sc.subVectors(a.b1, a.b0), d0)
      .addScaledVector(this._sc.subVectors(a.b2, a.b1), d1)
      .addScaledVector(this._sc.subVectors(a.b3, a.b2), d2);
    if (fwd.lengthSq() < 1e-8) fwd.copy(a.dirIn).negate();
    fwd.normalize();
    return out;
  }

  // -------------------------------------------------------------------------
  // Per-frame stepping

  _stepFlight(f, dt, t) {
    const x = (t - f.t0) / f.dur;
    if (!f.arrived) {
      // Track the planet as it orbits (it moves during the flight).
      if (!f.loop) this._resolveLocal(f.target, f.end);
      if (x >= 1) {
        f.arrived = true;
        f.arriveT = t;
        if (!f.loop && this.onArrive) this.onArrive(f.target);
      }
    }
    if (f.arrived) {
      const k = (t - f.arriveT) / RETRACT_TIME;
      if (k >= 1) { f.active = false; f.trail.n = 0; return; }
      if (!f.loop) this._resolveLocal(f.target, f.end);
      this._evalFlight(f, 1, f.head);
      this._emitTrail(f.head, f.trail, TOOL_TRAIL * (1 - k), this._trailWidth(f), this._cTool, this._gTool * 0.95, true);
      return;
    }
    const xc = clamp(x, 0, 1);
    this._evalFlight(f, xc, f.head);
    this._evalFlight(f, Math.min(1, xc + 0.012), this._a);
    if (this._a.distanceToSquared(f.head) > 1e-10) f.fwd.subVectors(this._a, f.head).normalize();
    else f.fwd.copy(f.dir);
    // Grow out of the star, shrink into the planet (absorbed into the ping).
    f.scale = smooth(0, 0.08, xc) * (f.loop ? smooth(1, 0.88, xc) : smooth(1, 0.85, xc));
    this._bank(f, dt);
    this._pushTrail(f.trail, f.head, TOOL_TRAIL / TOOL_SEGS);
    this._emitTrail(f.head, f.trail, TOOL_TRAIL, this._trailWidth(f), this._cTool, this._gTool * 0.95, false);

    const len = TOOL_LEN * f.scale;
    this._emitHull(f.head, f.fwd, f.bank, len, 1, this._cTool, 1);
    this._emitGlow(f.head, f.fwd, -0.42 * len, 0, 0.075 * Math.max(f.scale, 0.2) * (1 + 0.12 * (f.merged - 1)), this._cTool, this._gTool * 2.4 * f.scale);
    // V formation: followers trail the lead in ranks of two.
    for (let s = 0; s < 4; s++) {
      const jt = f.follow[s];
      if (jt < 0) continue;
      const fade = smooth(0, 0.3, t - jt) * f.scale;
      if (fade <= 0.001) continue;
      const rank = (s >> 1) + 1;
      const sideSign = (s & 1) ? 1 : -1;
      this._d.crossVectors(this._up, f.fwd);
      if (this._d.lengthSq() < 1e-6) this._d.set(1, 0, 0);
      this._d.normalize();
      this._b.copy(f.head)
        .addScaledVector(f.fwd, -0.24 * rank)
        .addScaledVector(this._d, sideSign * 0.17 * rank);
      this._emitHull(this._b, f.fwd, f.bank, TOOL_LEN * 0.85 * fade, 1, this._cTool, 0.9);
      this._emitGlow(this._b, f.fwd, -0.36 * TOOL_LEN, 0, 0.06 * fade, this._cTool, this._gTool * 2.0 * fade);
    }
  }

  _stepAgent(a, dt, t) {
    a.age += dt;
    if (a.homeAt >= 0 && a.age - a.homeAt >= AGENT_HOME) {
      // Docked: a small mint ripple at the star, then gone.
      for (let j = 0; j < MAX_RIPPLES; j++) {
        const r = this._ripples[j];
        if (!r.active) { r.active = true; r.t0 = t; break; }
      }
      a.active = false;
      a.trail.n = 0;
      this._seenAgentsDone.set(a.id, this._lastNow);
      a.id = null;
      return;
    }
    this._agentPos(a, a.head, a.fwd);
    let sc = 1;
    if (a.homeAt < 0) sc = smooth(0, 0.25, a.age);
    else sc = smooth(1, 0.9, (a.age - a.homeAt) / AGENT_HOME);
    a.scale = sc;
    this._bank(a, dt);
    this._pushTrail(a.trail, a.head, AGENT_TRAIL / AGENT_SEGS);
    this._emitTrail(a.head, a.trail, AGENT_TRAIL, 0.1, this._cAgent, this._gAgent * 1.0, false);
    const len = AGENT_LEN * sc;
    this._emitHull(a.head, a.fwd, a.bank, len, 1.25, this._cAgent, 1);
    // Twin engines.
    this._emitGlow(a.head, a.fwd, -0.4 * len, 0.08 * sc, 0.1 * sc, this._cAgent, this._gAgent * 2.8 * sc);
    this._emitGlow(a.head, a.fwd, -0.4 * len, -0.08 * sc, 0.1 * sc, this._cAgent, this._gAgent * 2.8 * sc);
  }

  /** Roll into turns: bank follows yaw rate (damped), purely kinematic. */
  _bank(o, dt) {
    if (dt > 0) {
      const cy = o.prevFwd.x * o.fwd.z - o.prevFwd.z * o.fwd.x;   // signed yaw
      const target = clamp((-cy / dt) * 0.35, -0.7, 0.7);
      o.bank += (target - o.bank) * (1 - Math.exp(-dt / 0.15));
    }
    o.prevFwd.copy(o.fwd);
  }

  _trailWidth(f) {
    return 0.065 * Math.min(3, 1 + 0.25 * (f.merged - 1));
  }

  // -------------------------------------------------------------------------
  // Geometry emitters (write into preallocated buffers)

  _pushTrail(tr, head, segLen) {
    const p = tr.pts;
    if (tr.n > 0) {
      const dx = head.x - p[0], dy = head.y - p[1], dz = head.z - p[2];
      if (dx * dx + dy * dy + dz * dz < segLen * segLen) return;
    }
    // Newest sample at index 0; shift the rest down (≤ 16 points, trivial).
    const n = Math.min(tr.n, tr.segs - 1);
    p.copyWithin(3, 0, n * 3);
    p[0] = head.x; p[1] = head.y; p[2] = head.z;
    tr.n = n + 1;
  }

  /**
   * Camera-facing ribbon from the head back through the samples, clipped to
   * `maxLen`, tapering in width and fading along its length.
   */
  _emitTrail(head, tr, maxLen, width, col, gain, draining) {
    if (maxLen <= 1e-3) return;
    const v0 = this._vN;
    if (v0 + MAX_POINTS * 2 > VERT_CAP) return;
    const pts = tr.pts;
    let px = head.x, py = head.y, pz = head.z;
    let acc = 0;
    let count = 0;
    const total = tr.n + 1;
    for (let i = 0; i < total && count < MAX_POINTS; i++) {
      let x, y, z;
      if (i === 0) { x = head.x; y = head.y; z = head.z; }
      else { x = pts[(i - 1) * 3]; y = pts[(i - 1) * 3 + 1]; z = pts[(i - 1) * 3 + 2]; }
      const seg = i === 0 ? 0 : Math.hypot(x - px, y - py, z - pz);
      let clipped = false;
      if (acc + seg > maxLen && seg > 1e-6) {
        const k = (maxLen - acc) / seg;
        x = px + (x - px) * k; y = py + (y - py) * k; z = pz + (z - pz) * k;
        acc = maxLen;
        clipped = true;
      } else acc += seg;
      // Tangent from the neighbour toward the head.
      let tx, ty, tz;
      if (i === 0) {
        if (tr.n > 0) { tx = head.x - pts[0]; ty = head.y - pts[1]; tz = head.z - pts[2]; }
        else { tx = 0; ty = 0; tz = 1; }
      } else { tx = px - x; ty = py - y; tz = pz - z; }
      // side = normalize(tangent × toCamera)
      const cx = this._cam.x - x, cy = this._cam.y - y, cz = this._cam.z - z;
      let sx = ty * cz - tz * cy, sy = tz * cx - tx * cz, sz = tx * cy - ty * cx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const u = acc / maxLen;
      // When draining into a planet the whole ribbon thins as it shortens.
      const w = width * 0.5 * Math.pow(1 - Math.min(u, 1), 0.5) * (draining ? 0.8 : 1);
      sx = (sx / sl) * w; sy = (sy / sl) * w; sz = (sz / sl) * w;
      this._vert(x + sx, y + sy, z + sz, col, gain, u, 1, 0, 0, 0, 0);
      this._vert(x - sx, y - sy, z - sz, col, gain, u, -1, 0, 0, 0, 0);
      if (count > 0) {
        const a0 = v0 + (count - 1) * 2, b0 = v0 + count * 2;
        this._tri(a0, a0 + 1, b0);
        this._tri(a0 + 1, b0 + 1, b0);
      }
      count++;
      px = x; py = y; pz = z;
      if (clipped) break;
    }
  }

  _emitGlow(pos, fwd, back, lateral, size, col, gain) {
    if (gain <= 1e-3) return;
    this._e.copy(pos).addScaledVector(fwd, back);
    if (lateral !== 0) {
      this._d.crossVectors(this._up, fwd);
      if (this._d.lengthSq() < 1e-6) this._d.set(1, 0, 0);
      this._e.addScaledVector(this._d.normalize(), lateral);
    }
    this._emitQuad(this._e.x, this._e.y, this._e.z, size, col, gain, 1);
  }

  _emitQuad(x, y, z, size, col, gain, kind) {
    const v0 = this._vN;
    if (v0 + 4 > VERT_CAP || this._iN + 6 > IDX_CAP) return;
    this._vert(x, y, z, col, gain, 0, 0, kind, size, -1, -1);
    this._vert(x, y, z, col, gain, 0, 0, kind, size, 1, -1);
    this._vert(x, y, z, col, gain, 0, 0, kind, size, 1, 1);
    this._vert(x, y, z, col, gain, 0, 0, kind, size, -1, 1);
    this._tri(v0, v0 + 1, v0 + 2);
    this._tri(v0, v0 + 2, v0 + 3);
  }

  _vert(x, y, z, col, gain, u, v, kind, size, cx, cy) {
    const i = this._vN++;
    this._pos[i * 3] = x; this._pos[i * 3 + 1] = y; this._pos[i * 3 + 2] = z;
    this._col[i * 3] = col.r * gain; this._col[i * 3 + 1] = col.g * gain; this._col[i * 3 + 2] = col.b * gain;
    this._dat[i * 4] = u; this._dat[i * 4 + 1] = v; this._dat[i * 4 + 2] = kind; this._dat[i * 4 + 3] = size;
    this._cor[i * 2] = cx; this._cor[i * 2 + 1] = cy;
  }

  _tri(a, b, c) {
    if (this._iN + 3 > IDX_CAP) return;
    this._idx[this._iN++] = a;
    this._idx[this._iN++] = b;
    this._idx[this._iN++] = c;
  }

  _emitHull(pos, fwd, bank, len, widen, col, gain) {
    if (this._hullN >= MAX_HULLS || len <= 1e-4) return;
    const i = this._hullN++;
    // Basis: forward = +Z of the hull, rolled by `bank` around forward.
    const z = fwd;
    const x = this._d.crossVectors(this._up, z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = this._sc.crossVectors(z, x);
    const cb = Math.cos(bank), sb = Math.sin(bank);
    // Roll: x' = x cos + y sin, y' = y cos − x sin
    const x2 = this._a.copy(x).multiplyScalar(cb).addScaledVector(y, sb);
    const y2 = this._c.copy(y).multiplyScalar(cb).addScaledVector(x, -sb);
    const m = this._m.makeBasis(x2, y2, z);
    const e = m.elements;
    // Scale columns: width × widen, height, length.
    for (let k = 0; k < 3; k++) { e[k] *= len * widen; e[4 + k] *= len; e[8 + k] *= len; }
    e[12] = pos.x; e[13] = pos.y; e[14] = pos.z;
    this._hulls.setMatrixAt(i, m);
    this._tint[i * 4] = col.r; this._tint[i * 4 + 1] = col.g; this._tint[i * 4 + 2] = col.b; this._tint[i * 4 + 3] = gain;
  }
}
