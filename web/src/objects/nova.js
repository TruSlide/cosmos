// Nova: the moment a dying star collapses (death cycle, owner 2026-11-08).
//
// One camera-facing quad at the system center: a white-blue flash, then a
// torn, expanding shock shell that fades as it grows. Driven only by
// state.deathPhase; visible between NOVA_START and NOVA_END, so a dead system
// whose cycle restarts each day sets it off once a day. Never orange, never
// error pink. One draw call, hidden the rest of the time.

import * as THREE from 'three';
import { color } from '../lib/palette.js';

export const NOVA_START = 0.8;
export const NOVA_END = 0.97;
const MAX_R = 16;            // system units at the end of the blast

const VERT = /* glsl */ `
uniform float uR;
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uR * 2.0;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uK;        // 0..1 through the blast
uniform float uSeed;
varying vec2 vUv;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = atan(vUv.y, abs(vUv.x) < 1e-5 ? 1e-5 : vUv.x);
  // Flash: bright at the start, gone by a fifth of the way.
  float flash = exp(-r * r / 0.01) * 6.0 * (1.0 - smoothstep(0.0, 0.2, uK));
  // Shell: a ring at the blast front, torn by angular noise, thinning as it fades.
  float front = 0.15 + 0.8 * sqrt(uK);
  float torn = 0.55 + 0.45 * vn(vec2(a * 4.0 + uSeed, uK * 3.0));
  float d = (r - front) / (0.035 + 0.05 * uK);
  float shell = exp(-d * d) * torn * (1.0 - uK) * 1.6;
  vec3 c = uCore * flash + mix(uCore, uEdge, 0.6) * shell;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  gl_FragColor = vec4(c * (1.0 - smoothstep(0.9, 1.0, r)), 0.0);
}`;

export class Nova {
  constructor(parent, ctx, opts = {}) {
    this._uniforms = {
      uR: { value: 1 }, uK: { value: 0 }, uSeed: { value: (opts.seedNum ?? 0) % 100 },
      uCore: { value: color('WHITE_HOLE') }, uEdge: { value: color('WHITE_HOLE_EDGE') },
    };
    this._mat = new THREE.ShaderMaterial({
      name: 'Nova', uniforms: this._uniforms, vertexShader: VERT, fragmentShader: FRAG,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true, depthWrite: false,
    });
    this._geo = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(this._geo, this._mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** @returns {0|1} rate hint */
  update(state) {
    const ph = state.fate === 'dying' ? state.deathPhase || 0 : 0;
    const on = ph > NOVA_START && ph < NOVA_END;
    this.mesh.visible = on;
    if (!on) return 0;
    const k = (ph - NOVA_START) / (NOVA_END - NOVA_START);
    this._uniforms.uK.value = k;
    this._uniforms.uR.value = 1.5 + MAX_R * Math.sqrt(k);
    return 1;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this._geo.dispose();
    this._mat.dispose();
  }
}
