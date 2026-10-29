// Nebula: THINKING (conditional, ART_DIRECTION §3.5).
//
// 24 camera-facing sprites (12 on low) in ONE instanced draw, scattered in a
// flattened shell around the star (r 2.5–6). Each fragment samples a
// world-space 3D fbm field, so the cards slice a shared volume instead of
// reading as flat decals. The field rotates about Y at 0.25/r rad/s
// (differential, like a slow galaxy: "the mind turning"), plus a slow drift.
// Differential rotation winds up forever, so two time-offset layers crossfade
// on a fixed cycle to keep the shear bounded (flow-map technique).
//
// Visible only while state.mode === 'thinking': 2 s in, 3 s out.
// Peak luminance stays ≤ 0.6 with typical overlap (ladder).

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { hash01, mulberry32, clamp } from '../lib/math.js';

const FADE_IN = 2;
const FADE_OUT = 3;
const SHELL_MIN = 2.5;
const SHELL_MAX = 6;

function unitColor(name) {
  const c = color(name);
  const l = Math.max(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 1e-4);
  return new THREE.Vector3(c.r / l, c.g / l, c.b / l);
}

// Self-contained noise (same family as star.js; modules may not import each other).
const NOISE_GLSL = /* glsl */ `
vec3 czHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float czNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  #define CZ_G(o) dot(czHash33(i + o) * 2.0 - 1.0, f - o)
  float x00 = mix(CZ_G(vec3(0.0, 0.0, 0.0)), CZ_G(vec3(1.0, 0.0, 0.0)), u.x);
  float x10 = mix(CZ_G(vec3(0.0, 1.0, 0.0)), CZ_G(vec3(1.0, 1.0, 0.0)), u.x);
  float x01 = mix(CZ_G(vec3(0.0, 0.0, 1.0)), CZ_G(vec3(1.0, 0.0, 1.0)), u.x);
  float x11 = mix(CZ_G(vec3(0.0, 1.0, 1.0)), CZ_G(vec3(1.0, 1.0, 1.0)), u.x);
  #undef CZ_G
  return 1.6 * mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
float czFbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int k = 0; k < NEB_OCT; k++) {
    s += a * czNoise(p);
    p = p * 2.07 + vec3(4.1, 1.3, 7.7);
    a *= 0.5;
  }
  return s;
}
`;

const VERT = /* glsl */ `
attribute vec3 aCenter;
attribute float aSize;
attribute float aSeed;
varying vec2 vUv;
varying vec3 vP;      // system-local position of this fragment (star radii)
varying float vSeed;
void main() {
  vec3 c = (modelMatrix * vec4(aCenter, 1.0)).xyz;
  float s = length(modelMatrix[0].xyz);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float a = aSeed * 6.2831853;
  vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
  vec3 offs = (right * q.x + up * q.y) * aSize;
  vec3 w = c + offs * s;
  vUv = position.xy * 2.0;   // PlaneGeometry(1,1) → [-1, 1]
  vP = aCenter + offs;       // assumes the system root is unrotated (true for every system)
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uSwirl;   // accumulated seconds while visible
uniform float uDrift;   // slow curl-ish offset
uniform float uAmt;     // fade 0..1
uniform vec3 uDeep;     // THINK_DEEP, unit luminance
uniform vec3 uViolet;   // THINK_VIOLET, unit luminance
uniform vec3 uFil;      // THINK_FILAMENT, unit luminance
varying vec2 vUv;
varying vec3 vP;
varying float vSeed;

const float CYCLE = 40.0;

void main() {
  float m = 1.0 - dot(vUv, vUv);
  if (m <= 0.0) discard;
  m = m * m;

  float rr = length(vP);
  // Soft fade against the star and at the shell's outer edge.
  float shell = smoothstep(1.25, 2.6, rr) * (1.0 - smoothstep(6.2, 8.0, rr));
  if (shell * m < 0.003) discard;

  float rxz = max(length(vP.xz), 1.2);
  float dens = 0.0;
  float fil = 0.0;
  for (int i = 0; i < 2; i++) {
    float ph = uSwirl / CYCLE + float(i) * 0.5;
    float fr = fract(ph);
    float w = 1.0 - abs(2.0 * fr - 1.0);
    // Differential rotation about Y: ω = 0.25 / r.
    float ang = -0.25 / rxz * fr * CYCLE;
    float ca = cos(ang), sa = sin(ang);
    vec3 Q = vec3(ca * vP.x - sa * vP.z, vP.y * 1.6, sa * vP.x + ca * vP.z);
    Q += vec3(mod(floor(ph), 64.0) * 7.31 + float(i) * 13.7);
    Q += uDrift * vec3(0.13, 0.05, -0.09);
    float d = czFbm(Q * 0.32);
    // Ridged term along the warped field: thin bright filaments.
    float r = 1.0 - abs(czNoise(Q * 0.8 + vec3(d * 1.5)));
    dens += w * d;
    fil += w * pow(max(r, 0.0), 10.0);
  }

  float body = smoothstep(-0.45, 0.6, dens);
  float a = body * m * shell;
  vec3 col = mix(uDeep * 0.045, uViolet * 0.09, smoothstep(0.3, 1.0, body));
  col += uFil * 0.16 * fil * smoothstep(0.2, 0.8, body);
  gl_FragColor = vec4(col * a * uAmt, 1.0);
}
`;

export class Nebula {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx ObjectContext
   * @param {{seed?: string}} opts
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this.quality = ctx?.quality ?? 'high';
    this.seed = opts.seed ?? 'nebula';
    this._disposed = false;

    this.root = new THREE.Group();
    this.root.name = 'Nebula';
    parent.add(this.root);

    const low = this.quality === 'low';
    const count = low ? 12 : 24;
    const rng = mulberry32(Math.floor(hash01(`${this.seed}:nebula`) * 4294967296));
    const center = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Flattened shell: radius 2.5–6, height ±25% of radius.
      const r = SHELL_MIN + (SHELL_MAX - SHELL_MIN) * Math.sqrt(rng());
      const a = rng() * Math.PI * 2;
      const y = (rng() * 2 - 1) * r * 0.25;
      center.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
      // Fewer sprites on low: make each one larger so coverage stays similar.
      size[i] = (3.2 + rng() * 1.8) * (low ? 1.3 : 1);
      seed[i] = rng();
    }

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry().copy(base);
    base.dispose();
    geo.instanceCount = count;
    geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(center, 3));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));

    this.material = new THREE.ShaderMaterial({
      defines: { NEB_OCT: low ? 3 : 4 },
      uniforms: {
        uSwirl: { value: 0 },
        uDrift: { value: 0 },
        uAmt: { value: 0 },
        uDeep: { value: unitColor('THINK_DEEP') },
        uViolet: { value: unitColor('THINK_VIOLET') },
        uFil: { value: unitColor('THINK_FILAMENT') },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'ThinkingNebula';
    this.mesh.frustumCulled = false; // billboards are placed in the vertex shader
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    this.root.add(this.mesh);

    this.reset();
  }

  reset() {
    this._init = false;
    this._lastNow = null;
    this._amt = 0;
    this._swirl = 0;
    this._drift = 0;
    if (this.mesh) this.mesh.visible = false;
  }

  /** @returns {0|1|2} rate hint */
  update(state, dt, t) {
    if (this._disposed || !state) return 0;
    const now = state.now;
    if (this._lastNow !== null && now < this._lastNow - 1e-3) this.reset();
    this._lastNow = now;

    const want = state.mode === 'thinking';
    if (!this._init) {
      this._init = true;
      this._amt = want ? 1 : 0;
    } else {
      this._amt = clamp(this._amt + (want ? dt / FADE_IN : -dt / FADE_OUT), 0, 1);
    }

    const a = this._amt;
    this.mesh.visible = a > 0.002;
    if (!this.mesh.visible) return 0;

    // Ease so the fade has no hard start/stop.
    const e = a * a * (3 - 2 * a);
    this._swirl = (this._swirl + dt) % (40 * 4096); // whole cycles: seamless wrap
    this._drift = (this._drift + dt * 0.15) % 4096;
    const u = this.material.uniforms;
    u.uSwirl.value = this._swirl;
    u.uDrift.value = this._drift;
    u.uAmt.value = e;
    return 1;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
