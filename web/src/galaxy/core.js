// Galactic structure: the core landmark and the project arms (GALAXY_CONTRACT §5.3, §5.4).
//
// Core (≤ 3 draws, here 2): a camera-facing bulge glow whose brightness is the
// summed `activity` of every live session (dim when nothing works), and a flat
// clock ring of radius 90 in the galactic plane with 24 hour ticks; the tick of
// the data clock's local hour is bright, and a small marker sits at the exact
// time of day (in history it follows the scrubber cursor).
//
// GalacticDisk: one star Points draw for the whole galaxy (bulge population,
// a faint smooth disk, and stars crowded along each project's arm), plus ONE
// instanced draw per arm holding both its glow and its dust lanes. Glow and
// dust share a premultiplied blend (ONE, ONE_MINUS_SRC_ALPHA): glow sprites
// write alpha 0 (pure emission, additive), dust sprites write dark colour with
// alpha (absorption), so dark lanes occlude the stars and glow drawn before
// them. Arms are drawn before systems, so dust never hides a session.
//
// Only arms that own sessions exist: spiral structure means "a project lives
// here". Arm brightness grows with the number of live sessions on it.
//
// Atmospheric perspective: every shader here takes the shared `atm` uniforms
// (near/far layer distances, set by galaxy.js from the focus distance) and
// fades contrast to 1 / 0.6 / 0.3 with soft edges, desaturating as it goes.

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { hash01, mulberry32, damp } from '../lib/math.js';

/** GLSL: atmospheric contrast for a camera distance (uniforms uAtmNear, uAtmFar). */
export const ATMOS_GLSL = /* glsl */ `
uniform float uAtmNear;
uniform float uAtmFar;
float atmContrast(float d) {
  float c = mix(1.0, 0.6, smoothstep(uAtmNear * 0.8, uAtmNear * 1.2, d));
  return mix(c, 0.3, smoothstep(uAtmFar * 0.8, uAtmFar * 1.2, d));
}
vec3 atmApply(vec3 c, float k) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Lose saturation faster than brightness: distance turns things grey-blue.
  return mix(vec3(l), c, k * k) * k;
}
`;

/** Shared uniform objects for atmospheric perspective (galaxy.js updates them). */
export function createAtmosphere() {
  return { uAtmNear: { value: 400 }, uAtmFar: { value: 1400 } };
}

// ----------------------------------------------------------------- core glow

const CORE_GLOW_R = 300;

const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
varying float vFade;
uniform float uSize;
void main() {
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float d = -mv.z;
  // Inside the bulge the billboard would paint the whole screen: fade it out.
  vFade = smoothstep(uSize * 0.35, uSize * 1.4, d);
  mv.xy += position.xy * uSize * 2.0;
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vFade;
uniform vec3 uHot;
uniform vec3 uCool;
uniform float uAct;
uniform float uDim;      // 0..1: a quasar is shown, the core steps back
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // Nucleus: compact, HDR (blooms) only when sessions are working.
  // Kept small and soft: the Tree of Knowledge stands in the middle (2026-11-08).
  float nucleus = exp(-r * r / 0.0009) * (0.45 + 1.6 * uAct) * 0.3;
  // Bulge: two exponentials, the broad one keeps the core a landmark when idle.
  float bulge = exp(-r / 0.07) * (0.11 + 0.16 * uAct) + exp(-r / 0.24) * 0.05;
  float edge = 1.0 - smoothstep(0.75, 1.0, r);
  vec3 c = uHot * nucleus + mix(uCool, uHot, exp(-r / 0.12)) * bulge;
  gl_FragColor = vec4(c * edge * vFade * (1.0 - 0.45 * uDim), 0.0);
}`;

// ----------------------------------------------------------------- clock ring

const RING_R = 90;

const RING_VERT = /* glsl */ `
varying vec3 vLocal;
varying float vD;
void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vD = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const RING_FRAG = /* glsl */ `
#define TAU 6.283185307
varying vec3 vLocal;
varying float vD;
uniform vec3 uCol;
uniform float uHour;     // local hour of the data clock, fractional (0..24)
uniform float uR;
${ATMOS_GLSL}
float line(float dist, float halfW, float aa) { return 1.0 - smoothstep(halfW, halfW + aa, dist); }
void main() {
  vec2 p = vLocal.xz;
  float r = length(p);
  // 0 h at -Z (far side from the default camera), clockwise seen from above.
  float a = atan(p.x, -p.y);
  if (a < 0.0) a += TAU;
  float h = a / TAU * 24.0;
  float aaR = fwidth(r) * 1.2;
  float circle = line(abs(r - uR), 0.35, aaR);
  // Hour ticks, measured as arc length so they stay crisp at any radius.
  float hn = floor(h + 0.5);
  float dArc = abs(h - hn) / 24.0 * TAU * uR;
  float aaA = fwidth(dArc) * 1.2 + 1e-4;
  bool major = mod(hn, 6.0) < 0.5;
  float len = major ? 8.0 : 4.5;
  float tickBand = step(uR, r) * (1.0 - smoothstep(uR + len - 0.6, uR + len, r));
  float tick = tickBand * line(dArc, major ? 0.55 : 0.35, aaA);
  // The current hour: its tick blazes and its hour of arc is filled faintly.
  float cur = mod(floor(uHour), 24.0);
  float isCur = 1.0 - step(0.5, abs(mod(hn, 24.0) - cur));
  float hourFill = step(cur, h) * step(h, uHour) * line(abs(r - uR - 1.6), 1.2, aaR);
  // Exact time of day: a short notch outside the ring.
  float dNow = abs(h - uHour);
  dNow = min(dNow, 24.0 - dNow) / 24.0 * TAU * uR;
  float now = line(dNow, 0.6, aaA) * step(uR + 9.0, r) * (1.0 - smoothstep(uR + 12.5, uR + 13.0, r));
  float I = circle * 0.32 + tick * (isCur > 0.5 ? 2.6 : (major ? 0.55 : 0.32)) + hourFill * 0.22 + now * 1.4;
  if (I < 0.002) discard;
  float k = atmContrast(vD);
  gl_FragColor = vec4(atmApply(uCol * I, k), 0.0);
}`;

export class Core {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx engine ObjectContext
   * @param {{ atm: object }} opts
   */
  constructor(parent, ctx, opts) {
    this.root = new THREE.Group();
    this.root.name = 'GalaxyCore';
    parent.add(this.root);
    this._act = 0;
    this._dim = 0;
    this._minuteKey = -1;
    this._disposed = false;

    const blend = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true, depthWrite: false };

    this._glowGeo = new THREE.PlaneGeometry(1, 1);
    this._glowMat = new THREE.ShaderMaterial({
      name: 'GalaxyCoreGlow',
      uniforms: {
        uSize: { value: CORE_GLOW_R },
        uHot: { value: color('STAR_FILL_50') },
        uCool: { value: color('STAR_FILL_0') },
        uAct: { value: 0 },
        uDim: { value: 0 },
      },
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, ...blend,
    });
    this._glow = new THREE.Mesh(this._glowGeo, this._glowMat);
    this._glow.frustumCulled = false;
    this._glow.renderOrder = -20;
    this.root.add(this._glow);

    this._ringGeo = new THREE.RingGeometry(RING_R - 2, RING_R + 14, 384, 1);
    this._ringGeo.rotateX(-Math.PI / 2);
    this._ringMat = new THREE.ShaderMaterial({
      name: 'GalaxyCoreRing',
      uniforms: { uCol: { value: color('STAR_FILL_0') }, uHour: { value: 0 }, uR: { value: RING_R }, ...opts.atm },
      vertexShader: RING_VERT, fragmentShader: RING_FRAG, ...blend, side: THREE.DoubleSide,
    });
    this._ring = new THREE.Mesh(this._ringGeo, this._ringMat);
    this._ring.renderOrder = -15;
    this.root.add(this._ring);
  }

  get radius() { return RING_R; }

  /**
   * @param {number} activitySum summed `activity` of live sessions
   * @param {number} nowS data clock (epoch s)
   */
  update(activitySum, nowS, dt, dim = 0) {
    if (this._disposed) return 0;
    // While any NEEDS ME quasar is shown, the core steps back so the quasar is
    // the brightest thing in the sky (brief: "the brightest object").
    this._dim = damp(this._dim, dim, 0.4, dt);
    this._glowMat.uniforms.uDim.value = this._dim;
    // 1 − e^(−x/2): one busy session lights it, five saturate it.
    const target = 1 - Math.exp(-Math.max(0, activitySum) / 2);
    this._act = damp(this._act, target, 1.5, dt);
    this._glowMat.uniforms.uAct.value = this._act;
    const minute = Math.floor(nowS / 60);
    if (minute !== this._minuteKey && Number.isFinite(nowS)) {
      this._minuteKey = minute;
      const d = new Date(nowS * 1000);   // once a minute, not per frame
      this._ringMat.uniforms.uHour.value = d.getHours() + d.getMinutes() / 60;
    }
    return Math.abs(this._act - target) > 0.01 || Math.abs(this._dim - dim) > 0.01 ? 1 : 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._glowGeo.dispose(); this._glowMat.dispose();
    this._ringGeo.dispose(); this._ringMat.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

// ----------------------------------------------------------------- disk stars

const STAR_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uPx;          // drawing-buffer px per world unit at distance 1
varying vec3 vCol;
${ATMOS_GLSL}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 1e-3);
  float px = aSize * uPx / d;
  // Sub-pixel stars keep their energy as alpha instead of shrinking below 1 px.
  float energy = min(1.0, px * px);
  px = clamp(px, 1.0, 5.0);
  // Stars right next to the camera fade instead of flashing past.
  float nearFade = smoothstep(6.0, 40.0, d);
  vCol = atmApply(aColor, atmContrast(d)) * energy * nearFade;
  gl_PointSize = px;
  gl_Position = projectionMatrix * mv;
}`;

const STAR_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(c, c) * 3.2);
  gl_FragColor = vec4(vCol * a, 0.0);
}`;

// ----------------------------------------------------------------- arm sprites

const ARM_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData;       // x size, y kind (0 glow, 1 dust), z seed, w strength
uniform float uPx;
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vStrength;
varying float vFade;
${ATMOS_GLSL}
void main() {
  vUv = position.xy * 2.0;
  vKind = iData.y;
  vSeed = iData.z;
  float size = iData.x;
  vec4 mv;
  float flatness = 1.0;
  if (iData.y < 0.5) {
    // Glow: a billboard (reads as volume from any angle).
    mv = modelViewMatrix * vec4(iPos, 1.0);
    mv.xy += position.xy * size;
  } else {
    // Dust: lies in the galactic plane, so edge-on it becomes a thin dark lane.
    vec3 w = iPos + vec3(position.x, 0.0, position.y) * size;
    mv = modelViewMatrix * vec4(w, 1.0);
    vec3 n = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
    vec3 v = normalize(-mv.xyz);
    flatness = smoothstep(0.04, 0.3, abs(dot(n, v)));
  }
  float d = max(length((modelViewMatrix * vec4(iPos, 1.0)).xyz), 1e-3);
  float px = size * uPx / d;
  // Close up, dust and glow dissolve: a focused system is never fogged over.
  vFade = (1.0 - smoothstep(160.0, 420.0, px)) * smoothstep(size * 0.8, size * 2.2, d) * flatness;
  vStrength = iData.w * atmContrast(d);
  gl_Position = projectionMatrix * mv;
}`;

const ARM_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vStrength;
varying float vFade;
uniform sampler2D uNoise;
uniform vec3 uGlow;
uniform vec3 uDust;
uniform float uBright;
void main() {
  float r = length(vUv);
  if (r > 1.0 || vFade < 0.003) discard;
  vec2 o = vec2(fract(vSeed * 7.13), fract(vSeed * 3.71));
  // The shared noise texture is per-texel white noise: sample it across only
  // a few texels so bilinear filtering turns it into smooth value noise.
  float n1 = texture2D(uNoise, vUv * (3.0 / 256.0) + o).r;
  float n2 = texture2D(uNoise, vUv * (8.0 / 256.0) + o.yx * 1.7).g;
  float n = n1 * 0.65 + n2 * 0.35;
  if (vKind < 0.5) {
    float g = exp(-r * r * 3.6) * (0.6 + 0.8 * n);
    gl_FragColor = vec4(uGlow * g * vStrength * uBright * vFade, 0.0);
  } else {
    // Filamentary absorption: noise carves lanes, the disc edge stays soft.
    float body = 1.0 - smoothstep(0.35, 1.0, r);
    float dens = body * smoothstep(0.32, 0.66, n);
    float a = clamp(dens * vStrength * vFade, 0.0, 0.92);
    gl_FragColor = vec4(uDust * a, a);
  }
}`;

/** Dense, deterministic star budget per quality. */
const STAR_BUDGET = { high: 42000, medium: 26000, low: 14000 };
const SPRITE_STEP = { high: 1, medium: 1.4, low: 2 };

export class GalacticDisk {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx engine ObjectContext
   * @param {{ atm: object, layout: object }} opts
   */
  constructor(parent, ctx, opts) {
    this.root = new THREE.Group();
    this.root.name = 'GalacticDisk';
    parent.add(this.root);
    this._ctx = ctx;
    this._atm = opts.atm;
    this._layout = opts.layout;
    this._quality = ctx.quality;
    this._arms = new Map();        // key -> { mesh, geo, mat, slot, len, bright, live }
    this._starsKey = '';
    this._disposed = false;
    this._uPx = { value: 1 };

    this._starMat = new THREE.ShaderMaterial({
      name: 'GalaxyDiskStars',
      uniforms: { uPx: this._uPx, ...this._atm },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true, depthWrite: false,
    });
    this._starGeo = null;
    this._stars = null;

    this._cWarm = color('STAR_FILL_50');
    this._cCool = color('STAR_FILL_0');
    this._cWhite = new THREE.Color(1, 1, 1);
    this._cViolet = liftedTint(color('DUST_VIOLET'));
    this._cTeal = liftedTint(color('DUST_TEAL'));
    this._cDust = color('VOID').lerp(color('DUST_VIOLET'), 0.35);
  }

  /**
   * Rebuild arms whose session set changed. Cheap no-op when nothing changed.
   * @param {Array<{ key, slot, sMax, live }>} arms
   */
  setArms(arms) {
    if (this._disposed) return;
    const seen = new Set();
    let starsKey = '';
    for (const a of arms) {
      seen.add(a.key);
      // Drawn length: past the outermost session, with a tapering tip.
      const len = Math.max(560, a.sMax + 300);
      starsKey += `${a.key}:${a.slot}:${Math.round(len / 46)};`;
      let arm = this._arms.get(a.key);
      if (arm && (arm.slot !== a.slot || Math.abs(arm.len - len) > 40)) {
        this._disposeArm(arm);
        this._arms.delete(a.key);
        arm = null;
      }
      if (!arm) {
        arm = this._buildArm(a.key, a.slot, len);
        this._arms.set(a.key, arm);
      }
      arm.live = a.live;
    }
    for (const [k, arm] of this._arms) {
      if (!seen.has(k)) { this._disposeArm(arm); this._arms.delete(k); }
    }
    if (starsKey !== this._starsKey) {
      this._starsKey = starsKey;
      this._buildStars(arms);
    }
  }

  update(dt, dim = 0) {
    if (this._disposed) return 0;
    const cam = this._ctx.camera;
    // px per world unit at distance 1, in drawing-buffer pixels.
    this._uPx.value = this._ctx.resolution.y * 0.5 * cam.projectionMatrix.elements[5];
    let moving = 0;
    for (const arm of this._arms.values()) {
      const target = (0.55 + 0.45 * Math.min(1, arm.live / 3)) * (1 - 0.35 * dim);
      arm.bright = damp(arm.bright, target, 1.2, dt);
      arm.mat.uniforms.uBright.value = arm.bright;
      if (Math.abs(arm.bright - target) > 0.005) moving = 1;
    }
    return moving;
  }

  /** Live-session count of an arm (drives its brightness). */
  setLive(key, live) {
    const arm = this._arms.get(key);
    if (arm) arm.live = live;
  }

  /** Arm tint (linear), for links and the minimap. */
  armTint(key, out) {
    return out.copy(this._cViolet).lerp(this._cTeal, hash01(key));
  }

  _buildArm(key, slot, len) {
    const L = this._layout;
    const rand = mulberry32(Math.floor(hash01(`arm:${key}`) * 0xffffffff));
    const gauss = () => {
      let u = 0; for (let i = 0; i < 4; i++) u += rand(); return (u - 2) * 0.866;
    };
    const step = SPRITE_STEP[this._quality] ?? 1;
    const pos = [], data = [];
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    const taper = (s) => Math.min(1, s / 140) * (1 - smoothstepJs(len * 0.62, len, s));
    // Glow first (drawn first inside the instance list), then dust on top.
    for (let s = 10; s < len; s += 20 * step) {
      L.armPoint(slot, s, p);
      L.armOutward(slot, s, n);
      const r = Math.hypot(p.x, p.z);
      const lat = gauss() * 16;
      pos.push(p.x + n.x * lat, (rand() - 0.5) * 10, p.z + n.z * lat);
      // Sprites are larger toward the core, where the arm is wider and brighter.
      const size = (60 + 70 * rand()) * (1.15 - 0.35 * Math.min(1, r / 900));
      data.push(size, 0, rand(), 0.09 * taper(s) * (0.7 + 0.6 * rand()));
    }
    for (let s = 30; s < len; s += 14 * step) {
      L.armPoint(slot, s, p);
      L.armOutward(slot, s, n);
      // Dust lanes ride the inner (core-facing) edge of the arm, as in real spirals.
      const lat = -(16 + 26 * rand()) + gauss() * 6;
      pos.push(p.x + n.x * lat, (rand() - 0.5) * 6, p.z + n.z * lat);
      const size = 34 + 50 * rand();
      data.push(size, 1, rand(), 1.25 * taper(s) * (0.6 + 0.4 * rand()));
    }
    // A few stray dust clouds on the outer edge break the regularity.
    for (let s = 60; s < len; s += 70 * step) {
      L.armPoint(slot, s, p);
      L.armOutward(slot, s, n);
      const lat = 40 + 30 * rand();
      pos.push(p.x + n.x * lat, (rand() - 0.5) * 6, p.z + n.z * lat);
      data.push(30 + 30 * rand(), 1, rand(), 0.5 * taper(s));
    }

    // Each arm owns its quad: disposing one arm must not free buffers another uses.
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
    geo.instanceCount = data.length / 4;
    const mat = new THREE.ShaderMaterial({
      name: 'GalaxyArm',
      uniforms: {
        uPx: this._uPx,
        uNoise: { value: this._ctx.noiseTex },
        uGlow: { value: this.armTint(key, new THREE.Color()).lerp(this._cCool, 0.25) },
        uDust: { value: this._cDust.clone() },
        uBright: { value: 0.55 },
        ...this._atm,
      },
      vertexShader: ARM_VERT, fragmentShader: ARM_FRAG,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    mesh.name = `GalaxyArm:${key}`;
    this.root.add(mesh);
    return { mesh, geo, mat, slot, len, bright: 0.55, live: 0 };
  }

  _disposeArm(arm) {
    this.root.remove(arm.mesh);
    arm.geo.dispose();
    arm.mat.dispose();
  }

  _buildStars(arms) {
    if (this._stars) {
      this.root.remove(this._stars);
      this._starGeo.dispose();
    }
    const total = STAR_BUDGET[this._quality] ?? STAR_BUDGET.high;
    const rand = mulberry32(0xC05A1A);
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const size = new Float32Array(total);
    const c = new THREE.Color();
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    const gauss = () => {
      let u = 0; for (let i = 0; i < 4; i++) u += rand(); return (u - 2) * 0.866;
    };
    const armLen = arms.map((a) => Math.max(560, a.sMax + 300));
    const sumLen = armLen.reduce((x, y) => x + y, 0);
    // Shares: bulge 0.3, smooth disk 0.2, arms the rest (or bulge + disk only).
    const nBulge = Math.floor(total * 0.22);
    const nDisk = Math.floor(total * (arms.length ? 0.2 : 0.7));
    let i = 0;
    const put = (x, y, z, s, cr, cg, cb) => {
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      col[i * 3] = cr; col[i * 3 + 1] = cg; col[i * 3 + 2] = cb;
      size[i] = s; i++;
    };
    for (let k = 0; k < nBulge; k++) {
      // Triaxial-ish bulge: radius from an exponential, flattened in Y.
      const r = -Math.log(1 - rand() * 0.995) * 55;
      const th = rand() * Math.PI * 2, u = rand() * 2 - 1;
      const sq = Math.sqrt(1 - u * u);
      c.copy(this._cWarm).lerp(this._cWhite, rand() * 0.5);
      const b = 0.03 + 0.24 * Math.pow(rand(), 3) + 0.05 * Math.exp(-r / 40);
      put(r * sq * Math.cos(th), r * u * 0.5, r * sq * Math.sin(th) * 0.85, 1.4 + rand() * 1.2,
        c.r * b, c.g * b, c.b * b);
    }
    for (let k = 0; k < nDisk; k++) {
      const r = 60 - Math.log(1 - rand() * 0.98) * 260;
      const th = rand() * Math.PI * 2;
      c.copy(this._cCool).lerp(this._cWarm, rand());
      const b = 0.03 + 0.12 * Math.pow(rand(), 3);
      put(r * Math.cos(th), gauss() * 7 * (1 + r / 900), r * Math.sin(th), 1.2 + rand(), c.r * b, c.g * b, c.b * b);
    }
    const nArm = total - i;
    for (let ai = 0; ai < arms.length; ai++) {
      const a = arms[ai];
      const count = ai === arms.length - 1 ? total - i : Math.floor(nArm * armLen[ai] / sumLen);
      for (let k = 0; k < count && i < total; k++) {
        const s = Math.pow(rand(), 0.85) * armLen[ai];
        this._layout.armPoint(a.slot, s, p);
        this._layout.armOutward(a.slot, s, n);
        const lat = gauss() * 26;
        const tip = 1 - smoothstepJs(armLen[ai] * 0.6, armLen[ai], s);
        // Young arm stars: mostly blue-white, a few bright ones.
        c.copy(this._cCool).lerp(this._cWhite, rand() * 0.6);
        const b = (0.05 + 0.3 * Math.pow(rand(), 5)) * (0.4 + 0.6 * tip);
        put(p.x + n.x * lat, gauss() * 5, p.z + n.z * lat, 1.3 + rand() * 1.4, c.r * b, c.g * b, c.b * b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, i * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col.subarray(0, i * 3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size.subarray(0, i), 1));
    this._starGeo = geo;
    this._stars = new THREE.Points(geo, this._starMat);
    this._stars.frustumCulled = false;
    this._stars.renderOrder = -30;
    this._stars.name = 'GalaxyDiskStars';
    this.root.add(this._stars);
  }

  get drawCalls() { return this._arms.size + (this._stars ? 1 : 0); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const arm of this._arms.values()) this._disposeArm(arm);
    this._arms.clear();
    if (this._starGeo) this._starGeo.dispose();
    this._starMat.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

/** Palette dust tints are near-black; lift them to unit max channel for glow. */
function liftedTint(c) {
  const m = Math.max(c.r, c.g, c.b, 1e-6);
  return c.multiplyScalar(1 / m);
}

function smoothstepJs(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
