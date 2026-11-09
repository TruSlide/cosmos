// Galactic center (owner decisions 2026-11-02 and 2026-11-08):
//
//   Tree     the Tree of Knowledge (tree.js): canopy = live sessions, roots =
//            dormant or dead sessions, leaves = saved knowledge. No labels.
//   Me       a pearl-white star with four soft spikes: the owner. It orbits the
//            tree. Threads run from it to every session that needs the owner.
//   Moons    the owner's Parking Lot (same list as /pending) as small moons
//            around "me": pearl for waiting on you, teal for ready when you
//            are, dim grey for parked.
//   Beams    a gold beam flies from a session that saved knowledge into the
//            canopy, and a new leaf grows where it lands.
//
// Draws: tree (3), me (1), threads (1), beams (1 instanced), moons (1 points).
// All emission stays well under the quasar so needs-me remains the brightest
// thing in the galaxy.

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { clamp } from '../lib/math.js';
import { KnowledgeTree } from './tree.js';

const ORBIT_PERIOD = 150;           // s per revolution of "me" around the tree
const ME_ORBIT = 36;                // me distance from the trunk
const ME_HEIGHT = 16;
const THREADS_MAX = 32;
const BEAMS_MAX = 12;
const BEAM_S = 2.6;                 // flight time of a knowledge beam
const MIN_PX_ME = 9;
const MOONS_MAX = 40;

// ------------------------------------------------------------------- shaders

const BILLBOARD_VERT = /* glsl */ `
uniform float uSize;     // world radius
uniform float uMinPx;    // never smaller than this on screen
uniform float uPxK;      // CSS px per world unit at distance 1
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float d = max(-mv.z, 1e-3);
  float size = max(uSize, uMinPx * d / max(uPxK, 1e-3));
  mv.xy += position.xy * size * 2.0;
  gl_Position = projectionMatrix * mv;
}`;

const ME_FRAG = /* glsl */ `
uniform vec3 uPearl;
uniform vec3 uHalo;
uniform float uCall;     // 0..1: sessions waiting on me
uniform float uTime;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float breathe = 0.5 + 0.5 * sin(uTime * 0.9);
  float core = exp(-r * r / 0.004) * (1.6 + 0.6 * breathe + 1.2 * uCall);
  float halo = exp(-r / 0.16) * (0.22 + 0.25 * uCall);
  // Four soft spikes, slowly turning: it reads as "a person", not a session star.
  float a = atan(vUv.y, abs(vUv.x) < 1e-5 ? 1e-5 : vUv.x) + uTime * 0.05;
  float spikes = pow(abs(cos(2.0 * a)), 60.0) * exp(-r / 0.35) * (0.35 + 0.4 * uCall);
  vec3 c = uPearl * core + uHalo * (halo + spikes);
  vec3 outC = c * (1.0 - smoothstep(0.8, 1.0, r));
  if (any(isnan(outC)) || any(isinf(outC))) outC = vec3(0.0);
  gl_FragColor = vec4(outC, 0.0);
}`;

const THREAD_VERT = /* glsl */ `
attribute float aT;      // 0 at me .. 1 at the waiting session
attribute float aSeed;
varying float vT;
varying float vSeed;
void main() {
  vT = aT;
  vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const THREAD_FRAG = /* glsl */ `
uniform vec3 uPearl;
uniform float uTime;
varying float vT;
varying float vSeed;
void main() {
  // Light flows from the waiting session toward me.
  float flow = fract(vT * 6.0 + uTime * 0.6 + vSeed);
  float dash = smoothstep(0.0, 0.15, flow) * (1.0 - smoothstep(0.35, 0.5, flow));
  float fade = smoothstep(0.0, 0.05, vT) * (1.0 - smoothstep(0.92, 1.0, vT));
  vec3 c = uPearl * (0.05 + 0.35 * dash) * fade;
  gl_FragColor = vec4(c, 0.0);
}`;

const BEAM_VERT = /* glsl */ `
uniform float uPxK;
attribute float aLife;   // 0..1 along the flight, <0 = unused
varying vec2 vUv;
varying float vLife;
void main() {
  vUv = position.xy * 2.0;
  vLife = aLife;
  vec4 mv = viewMatrix * (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0));
  float d = max(-mv.z, 1e-3);
  float size = max(3.0, 6.0 * d / max(uPxK, 1e-3));
  mv.xy += position.xy * size * 2.0;
  gl_Position = aLife < 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uGold;
uniform vec3 uLight;
varying vec2 vUv;
varying float vLife;
void main() {
  float r = length(vUv);
  if (r > 1.0 || vLife < 0.0) discard;
  float k = exp(-r * r / 0.02) * 1.4 + exp(-r / 0.25) * 0.25;
  float fadeIn = smoothstep(0.0, 0.1, vLife);
  vec3 c = mix(uGold, uLight, exp(-r * r / 0.01)) * k * fadeIn;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  gl_FragColor = vec4(c, 0.0);
}`;

const MOON_VERT = /* glsl */ `
attribute vec3 aCol;
uniform float uPx;
varying vec3 vCol;
void main() {
  vCol = aCol;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(1.6 * uPx / max(-mv.z, 1.0), 2.0, 10.0);
}`;

const MOON_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0) discard;
  // A small lit sphere: bright limb toward "me" (up-left of the sprite).
  float z = sqrt(max(0.0, 1.0 - r));
  float lit = clamp(dot(normalize(vec3(q.x, -q.y, z)), normalize(vec3(-0.5, 0.5, 0.7))), 0.0, 1.0);
  vec3 c = vCol * (0.15 + 0.75 * lit) * (1.0 - smoothstep(0.8, 1.0, r));
  gl_FragColor = vec4(c, 0.0);
}`;

const ADD = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  transparent: true, depthWrite: false };

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

// ------------------------------------------------------------------- class

export class GalacticCenter {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx engine ObjectContext
   */
  constructor(parent, ctx) {
    this.root = new THREE.Group();
    this.root.name = 'GalacticCenter';
    parent.add(this.root);
    this._ctx = ctx;
    this._t = 0;
    this.codexPos = new THREE.Vector3(0, 14, 0);   // the tree's heart (pick / fly target)
    this.mePos = new THREE.Vector3();
    this._landing = new THREE.Vector3();

    this.tree = new KnowledgeTree(this.root);

    const quad = new THREE.PlaneGeometry(1, 1);
    this._quad = quad;

    // --- me
    this._meMat = new THREE.ShaderMaterial({
      name: 'MeStar',
      uniforms: { uSize: { value: 9 }, uMinPx: { value: MIN_PX_ME }, uPxK: { value: 1 }, uPearl: { value: color('ME_PEARL') },
        uHalo: { value: color('ME_HALO') }, uCall: { value: 0 }, uTime: { value: 0 } },
      vertexShader: BILLBOARD_VERT, fragmentShader: ME_FRAG, ...ADD,
    });
    this._me = new THREE.Mesh(quad, this._meMat);
    this._me.frustumCulled = false;
    this._me.renderOrder = -4;
    this.root.add(this._me);

    // --- threads (me -> waiting sessions), 24 segments each so the dashes can flow
    const SEG = 24;
    this._seg = SEG;
    const tg = new THREE.BufferGeometry();
    this._tPos = new THREE.BufferAttribute(new Float32Array(THREADS_MAX * SEG * 2 * 3), 3);
    this._tPos.setUsage(THREE.DynamicDrawUsage);
    const aT = new Float32Array(THREADS_MAX * SEG * 2);
    const aSeed = new Float32Array(THREADS_MAX * SEG * 2);
    for (let i = 0; i < THREADS_MAX; i++) {
      for (let s = 0; s < SEG; s++) {
        const k = (i * SEG + s) * 2;
        aT[k] = s / SEG; aT[k + 1] = (s + 1) / SEG;
        aSeed[k] = aSeed[k + 1] = (i * 0.618) % 1;
      }
    }
    tg.setAttribute('position', this._tPos);
    tg.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    tg.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    tg.setDrawRange(0, 0);
    this._threadMat = new THREE.ShaderMaterial({
      name: 'MeThreads',
      uniforms: { uPearl: { value: color('ME_PEARL') }, uTime: { value: 0 } },
      vertexShader: THREAD_VERT, fragmentShader: THREAD_FRAG, ...ADD,
    });
    this._threads = new THREE.LineSegments(tg, this._threadMat);
    this._threads.frustumCulled = false;
    this.root.add(this._threads);

    // --- knowledge beams
    this._beamMat = new THREE.ShaderMaterial({
      name: 'KnowledgeBeams',
      uniforms: { uPxK: { value: 1 }, uGold: { value: color('TREE_AMBER') }, uLight: { value: color('CODEX_LIGHT') } },
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, ...ADD,
    });
    const bg = quad.clone();
    this._beamLife = new THREE.InstancedBufferAttribute(new Float32Array(BEAMS_MAX).fill(-1), 1);
    bg.setAttribute('aLife', this._beamLife);
    this._beams = new THREE.InstancedMesh(bg, this._beamMat, BEAMS_MAX);
    this._beams.frustumCulled = false;
    this._beamList = Array.from({ length: BEAMS_MAX }, () => ({ live: false, t0: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), ctrl: new THREE.Vector3() }));
    this.root.add(this._beams);

    // --- Parking Lot moons around me
    this._moonGeo = new THREE.BufferGeometry();
    this._moonGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOONS_MAX * 3), 3));
    this._moonGeo.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(MOONS_MAX * 3), 3));
    this._moonGeo.setDrawRange(0, 0);
    this._moonMat = new THREE.ShaderMaterial({ name: 'ParkingMoons', uniforms: { uPx: { value: 400 } }, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG, ...ADD });
    this._moons = new THREE.Points(this._moonGeo, this._moonMat);
    this._moons.frustumCulled = false;
    this.root.add(this._moons);
    this._moonOrbits = [];
  }

  /** Number of knowledge leaves on the tree. */
  get count() { return this.tree.leafCount || 0; }

  /** Knowledge list (GET /api/knowledge items); new items grow as new leaves unless quiet. */
  setKnowledge(items, opts) { this.tree.setKnowledge(items, opts); }

  /** Living and dormant session counts (regrows the tree when they change); liveness per living tip. */
  setSessions(alive, dormant, liveness) {
    this.tree.setSessions(alive, dormant);
    if (liveness) this.tree.setLiveness(liveness);
  }

  /** Parking Lot groups (GET /api/pending): one moon per item, colored by group. */
  setParking(groups) {
    const COL = { 'Waiting on you': [0.95, 0.94, 1.0], 'Ready when you are': [0.35, 0.85, 0.75] };
    const orbits = [];
    let i = 0;
    for (const g of groups || []) {
      const c = COL[g.name] || [0.42, 0.45, 0.55];
      for (const it of g.items || []) {
        if (i >= MOONS_MAX) break;
        const h = [...String(it.id || i)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
        orbits.push({ r: 4.5 + (h % 70) / 10, inc: ((h >>> 3) % 100) / 100 * 1.2 - 0.6, ph: ((h >>> 7) % 628) / 100, w: 0.25 + ((h >>> 11) % 50) / 100, col: c });
        i++;
      }
    }
    this._moonOrbits = orbits;
    const col = this._moonGeo.getAttribute('aCol');
    orbits.forEach((o, k) => col.setXYZ(k, o.col[0], o.col[1], o.col[2]));
    col.needsUpdate = true;
    this._moonGeo.setDrawRange(0, orbits.length);
  }

  /** A gold beam from a world point (the session that saved knowledge) into the canopy. */
  beam(from) {
    const b = this._beamList.find((x) => !x.live) ?? this._beamList[0];
    b.live = true;
    b.t0 = this._t;
    b.from.copy(from);
    this.tree.root.updateMatrixWorld(true);
    this.tree.landingPoint(b.to);
    b.ctrl.copy(from).add(b.to).multiplyScalar(0.5).add(new THREE.Vector3(0, from.length() * 0.18 + 20, 0));
  }

  /**
   * @param {number} dt
   * @param {number} t seconds (render clock)
   * @param {{ pxK: number, nowS: number, waiting: THREE.Vector3[], alive?: number }} f
   * @returns {number} redraw hint (0 idle, 1 animating)
   */
  update(dt, t, f) {
    this._t = t;
    this.tree.update(dt, t, f);

    // "Me" orbits the tree.
    const ph = (t / ORBIT_PERIOD) * Math.PI * 2;
    this.mePos.set(Math.cos(ph) * ME_ORBIT, ME_HEIGHT, Math.sin(ph) * ME_ORBIT);
    this._me.position.copy(this.mePos);
    this._meMat.uniforms.uPxK.value = f.pxK;
    this._meMat.uniforms.uTime.value = t;

    // Parking Lot moons around me.
    const mp = this._moonGeo.getAttribute('position');
    for (let k = 0; k < this._moonOrbits.length; k++) {
      const o = this._moonOrbits[k];
      const a = o.ph + t * o.w * 0.3;
      const x = Math.cos(a) * o.r, z = Math.sin(a) * o.r;
      mp.setXYZ(k, this.mePos.x + x, this.mePos.y + z * Math.sin(o.inc), this.mePos.z + z * Math.cos(o.inc));
    }
    mp.needsUpdate = true;
    this._moonMat.uniforms.uPx.value = f.pxK;

    // Threads from me to every session that needs me.
    const waiting = f.waiting || [];
    const n = Math.min(waiting.length, THREADS_MAX);
    const SEG = this._seg;
    const arr = this._tPos.array;
    for (let i = 0; i < n; i++) {
      const to = waiting[i];
      const lift = this.mePos.distanceTo(to) * 0.12;
      for (let sgm = 0; sgm < SEG; sgm++) {
        for (let e = 0; e < 2; e++) {
          const u = (sgm + e) / SEG;
          const k = ((i * SEG + sgm) * 2 + e) * 3;
          arr[k] = this.mePos.x + (to.x - this.mePos.x) * u;
          arr[k + 1] = this.mePos.y + (to.y - this.mePos.y) * u + Math.sin(Math.PI * u) * lift;
          arr[k + 2] = this.mePos.z + (to.z - this.mePos.z) * u;
        }
      }
    }
    this._tPos.needsUpdate = true;
    this._threads.geometry.setDrawRange(0, n * SEG * 2);
    this._threadMat.uniforms.uTime.value = t;
    const call = clamp(n / 3, 0, 1);
    const mu = this._meMat.uniforms.uCall;
    mu.value += (call - mu.value) * Math.min(1, dt * 2);

    // Beams: quadratic arc from the session into the canopy.
    let flying = false;
    for (let i = 0; i < BEAMS_MAX; i++) {
      const b = this._beamList[i];
      let life = -1;
      if (b.live) {
        const u = (t - b.t0) / BEAM_S;
        if (u >= 1) b.live = false;
        else {
          life = u;
          flying = true;
          const e = u * u * (3 - 2 * u);
          const a = (1 - e) * (1 - e), bb = 2 * (1 - e) * e, cc = e * e;
          _p.set(
            a * b.from.x + bb * b.ctrl.x + cc * b.to.x,
            a * b.from.y + bb * b.ctrl.y + cc * b.to.y,
            a * b.from.z + bb * b.ctrl.z + cc * b.to.z,
          );
          _m.makeTranslation(_p.x, _p.y, _p.z);
          this._beams.setMatrixAt(i, _m);
        }
      }
      this._beamLife.array[i] = life;
    }
    this._beams.instanceMatrix.needsUpdate = true;
    this._beamLife.needsUpdate = true;
    this._beamMat.uniforms.uPxK.value = f.pxK;

    return flying || n > 0 ? 1 : 0;
  }

  /** Pick radius (world units) around the tree's heart. */
  get radius() { return 26; }

  dispose() {
    this.root.parent?.remove(this.root);
    this.tree.dispose();
    this._quad.dispose(); this._meMat.dispose();
    this._threads.geometry.dispose(); this._threadMat.dispose();
    this._beams.geometry.dispose(); this._beamMat.dispose();
    this._moonGeo.dispose(); this._moonMat.dispose();
  }
}
