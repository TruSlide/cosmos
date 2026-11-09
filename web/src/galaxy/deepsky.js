// Deep sky: the far universe behind the galaxy (owner, 2026-11-02, reworked
// 2026-11-08). Purely decorative: no picking, no labels.
//
// What is out there, all procedural and kept dim:
//   galaxies          distant spirals, ellipticals and edge-on disks
//   globular clusters dense balls of old stars
//   open clusters     a few young blue-white stars
//   nebulae           thin, wispy emission clouds (not big soft blobs)
//
// The earlier "wonders" (Dyson sphere, whale, wormhole...) and the transient
// flashes are gone: they read as fabricated. Depth comes from parallax: each
// object sits on one of several shells, and nearer shells shift slightly as
// the camera moves, so the background has real distance without ever
// colliding with the galaxy. More lifetime tokens fill in more of the sky
// (log scale). Nothing here uses the reserved needs-me indigo or crashed
// orange. Draws: one instanced mesh.

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { mulberry32, clamp } from '../lib/math.js';

const DOME_R = 4600;
const COUNT_MAX = 520;

/** How many far objects show at a lifetime token count. */
export function farCount(tokens) {
  const x = Math.log10(Math.max(1, tokens) / 1e5);   // 0 at 100k tokens
  return Math.round(clamp(60 + x * 80, 60, COUNT_MAX));
}

const VERT = /* glsl */ `
attribute vec3 aDir;      // unit direction on the sky
attribute vec4 aShape;    // size (world), rotation, aspect, kind
attribute vec4 aLook;     // seed, alpha, tint, depth (0 nearest shell .. 1 farthest)
uniform vec3 uCam;
uniform float uR;
varying vec2 vUv;
varying vec4 vShape;
varying vec4 vLook;
void main() {
  vUv = position.xy * 2.0;
  vShape = aShape;
  vLook = aLook;
  // Parallax: nearer shells follow the camera a little less, so they drift as you fly.
  float follow = mix(0.82, 1.0, aLook.w);
  float rad = uR * mix(0.72, 1.0, aLook.w);
  vec4 mv = viewMatrix * vec4(uCam * follow + aDir * rad, 1.0);
  float c = cos(aShape.y), s = sin(aShape.y);
  vec2 q = vec2(position.x * aShape.z, position.y);
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  mv.xy += q * aShape.x * 2.0;
  gl_Position = aLook.y <= 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uBlue, uWhite, uTeal, uRose, uGold;
varying vec2 vUv;
varying vec4 vShape;
varying vec4 vLook;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
float ang(vec2 p) { return atan(p.y, abs(p.x) < 1e-5 ? 1e-5 : p.x); }
// A field of point stars: cells with one star each, density by mask.
float stars(vec2 p, float scale, float seed, float mask) {
  vec2 g = p * scale;
  vec2 i = floor(g), f = fract(g);
  float h = h21(i + seed);
  vec2 c = vec2(h21(i + seed + 1.3), h21(i + seed + 2.7));
  float d = length(f - c);
  return step(1.0 - mask, h) * exp(-d * d / 0.012) * (0.5 + h);
}
void main() {
  vec2 p = vUv;
  float r = length(p);
  if (r > 1.0) discard;
  float kind = vShape.w, seed = vLook.x, a = vLook.y, tint = vLook.z;
  vec3 c = vec3(0.0);
  if (kind < 0.5) {
    // Spiral galaxy: bright bulge, two arms of stars and dust.
    float th = ang(p);
    float arms = 0.5 + 0.5 * cos(2.0 * th - 6.0 * log(r + 0.05) + seed * 6.28);
    float v = exp(-r * r / 0.01) * 1.1 + pow(arms, 3.0) * exp(-r / 0.32) * 0.5 * (0.6 + 0.7 * fbm(p * 6.0 + seed * 9.0));
    c = mix(uWhite, uBlue, 0.3 + 0.4 * tint) * v + uGold * exp(-r * r / 0.02) * 0.25;
  } else if (kind < 1.5) {
    // Elliptical: smooth, warm-white.
    c = mix(uWhite, uGold, 0.25) * exp(-pow(r / 0.42, 1.2)) * 0.55;
  } else if (kind < 2.5) {
    // Edge-on disk with a dark dust lane.
    float d = exp(-abs(p.y) / 0.05) * exp(-abs(p.x) / 0.45);
    float lane = 1.0 - 0.8 * exp(-abs(p.y) / 0.012);
    c = mix(uWhite, uBlue, 0.3) * (d * lane + exp(-r * r / 0.01) * 0.5) * 0.75;
  } else if (kind < 3.5) {
    // Globular cluster: a dense ball of old stars, crowded toward the centre.
    float dens = exp(-r * r / 0.12);
    float s1 = stars(p, 34.0, seed, 0.25 + 0.7 * dens);
    float s2 = stars(p, 61.0, seed + 5.0, 0.15 + 0.6 * dens);
    c = mix(uWhite, uGold, 0.35) * (s1 + 0.7 * s2) * 0.9 + uWhite * exp(-r * r / 0.03) * 0.25;
  } else if (kind < 4.5) {
    // Open cluster: a loose handful of young blue-white stars in faint nebulosity.
    float s1 = stars(p, 9.0, seed, 0.5 * (1.0 - smoothstep(0.4, 1.0, r)));
    c = mix(uWhite, uBlue, 0.5) * s1 * 1.4 + uBlue * fbm(p * 3.0 + seed) * exp(-r * r / 0.25) * 0.05;
  } else {
    // Emission nebula: thin wisps and filaments, not a blob.
    float n = fbm(p * 2.4 + seed * 3.0);
    float fil = 1.0 - abs(fbm(p * 4.5 + seed) * 2.0 - 1.0);
    fil = pow(fil, 6.0);
    float m = smoothstep(0.42, 0.75, n) * (1.0 - smoothstep(0.35, 1.0, r));
    vec3 hue = tint < 0.33 ? uTeal : tint < 0.66 ? uRose : uBlue;
    c = hue * (m * 0.25 + fil * m * 0.9) + uWhite * stars(p, 40.0, seed, 0.12) * 0.6;
  }
  c *= 1.0 - smoothstep(0.85, 1.0, r);
  vec3 outC = c * a * 0.6;
  if (any(isnan(outC)) || any(isinf(outC))) outC = vec3(0.0);
  gl_FragColor = vec4(outC, 0.0);
}`;

const ADD = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  transparent: true, depthWrite: false, depthTest: true };

function randomDir(rnd, out) {
  for (;;) {
    const z = 1 - 2 * rnd();
    const r = Math.sqrt(1 - z * z);
    const ph = 2 * Math.PI * rnd();
    out.set(r * Math.cos(ph), z, r * Math.sin(ph));
    if (Math.abs(out.y) > 0.15 || rnd() < 0.25) return out;   // keep most off the galactic plane
  }
}

export class DeepSky {
  /** @param {THREE.Object3D} parent  @param {object} ctx */
  constructor(parent, ctx, opts = {}) {
    this.root = new THREE.Group();
    this.root.name = 'DeepSky';
    parent.add(this.root);
    this.enabled = true;
    this._shown = 0;

    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    const mk = (name, size) => { const at = new THREE.InstancedBufferAttribute(new Float32Array(COUNT_MAX * size), size); g.setAttribute(name, at); return at; };
    const dir = mk('aDir', 3), shape = mk('aShape', 4), look = mk('aLook', 4);
    g.instanceCount = COUNT_MAX;
    this._geo = g;
    this._base = base;

    const rnd = mulberry32(opts.seed ?? 20261108);
    const v = new THREE.Vector3();
    for (let i = 0; i < COUNT_MAX; i++) {
      randomDir(rnd, v);
      dir.setXYZ(i, v.x, v.y, v.z);
      const k = rnd();
      // Mostly galaxies, some clusters, a few wisps of nebula.
      const kind = k < 0.36 ? 0 : k < 0.56 ? 1 : k < 0.7 ? 2 : k < 0.82 ? 3 : k < 0.92 ? 4 : 5;
      const size = kind === 5 ? 160 + 260 * rnd()
        : kind === 3 ? 26 + 40 * rnd()
        : kind === 4 ? 40 + 60 * rnd()
        : 24 + 130 * Math.pow(rnd(), 2.4);
      const aspect = kind === 0 ? 0.45 + 0.55 * rnd() : kind === 1 ? 0.6 + 0.4 * rnd() : 1;
      shape.setXYZW(i, size, rnd() * Math.PI * 2, aspect, kind);
      look.setXYZW(i, rnd() * 10, 0, rnd(), rnd());
    }
    this._mat = new THREE.ShaderMaterial({
      name: 'DeepSky',
      uniforms: {
        uCam: { value: new THREE.Vector3() }, uR: { value: DOME_R },
        uBlue: { value: color('SKY_BLUE') }, uWhite: { value: color('SKY_WHITE') }, uTeal: { value: color('SKY_TEAL') },
        uRose: { value: color('SKY_VIOLET') }, uGold: { value: color('TREE_AMBER') },
      },
      vertexShader: VERT, fragmentShader: FRAG, ...ADD,
    });
    this._mesh = new THREE.Mesh(g, this._mat);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = -60;
    this.root.add(this._mesh);
  }

  /**
   * @param {number} dt
   * @param {number} t
   * @param {{ camera: THREE.Camera, tokens: number, instant?: boolean }} f
   * @returns {number} redraw hint
   */
  update(dt, t, f) {
    this.root.visible = this.enabled;
    if (!this.enabled) return 0;
    this._mat.uniforms.uCam.value.copy(f.camera.position);
    const want = farCount(f.tokens || 0);
    if (want === this._shown && !f.instant) return 0;
    const step = f.instant ? COUNT_MAX : Math.max(1, Math.ceil(dt * 30));
    this._shown = want > this._shown ? Math.min(want, this._shown + step) : Math.max(want, this._shown - step);
    const look = this._geo.getAttribute('aLook');
    for (let i = 0; i < COUNT_MAX; i++) look.array[i * 4 + 1] = i < this._shown ? 1 : 0;
    look.needsUpdate = true;
    return this._shown === want ? 0 : 1;
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this._base.dispose();
    this._geo.dispose();
    this._mat.dispose();
  }
}
