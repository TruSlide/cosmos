// IdleHaze: the galaxy-distance sign that a session has gone quiet.
//
// Up close, idle shows as aging planets (planets.js: hurricanes, volcanoes,
// cracks). From far away those are a few pixels, so the whole system also
// gathers a thin cool-grey veil of drifting dust that thickens over the idle
// day (state.idleFor 0 → 1) and settles, still, at the dead state.
// One camera-facing quad, one cheap shader; hidden whenever idleFor is 0.

import * as THREE from 'three';
import { color } from '../lib/palette.js';

const MAX_ALPHA = 0.34;     // how thick the veil gets at the dead state

const VERT = /* glsl */ `
uniform float uSize;
varying vec2 vQ;
void main() {
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  c.xy += position.xy * uSize;
  vQ = position.xy;
  gl_Position = projectionMatrix * c;
}
`;

const FRAG = /* glsl */ `
uniform float uAge;
uniform float uTime;
uniform vec3 uTint;
varying vec2 vQ;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  // Drift slows to a stop as the session dies.
  float drift = uTime * 0.03 * (1.0 - uAge);
  float n = 0.55 * n2(vQ * 3.0 + drift) + 0.3 * n2(vQ * 7.0 - drift * 1.7) + 0.15 * n2(vQ * 15.0);
  float disc = smoothstep(1.0, 0.45, r);
  float a = ${MAX_ALPHA.toFixed(2)} * smoothstep(0.04, 1.0, uAge) * disc * (0.55 + 0.6 * n);
  gl_FragColor = vec4(uTint, a);
}
`;

export class IdleHaze {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx
   * @param {{ radius: () => number }} opts  radius of the system to veil (belt outer edge)
   */
  constructor(parent, ctx, opts = {}) {
    this._radius = opts.radius || (() => 14);
    this._disposed = false;
    this._mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSize: { value: 16 },
        uAge: { value: 0 },
        uTime: { value: 0 },
        uTint: { value: color('CINDER_RIM') },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    this._geo = new THREE.PlaneGeometry(2, 2);
    this.root = new THREE.Mesh(this._geo, this._mat);
    this.root.name = 'IdleHaze';
    this.root.frustumCulled = false;
    this.root.renderOrder = 50;      // over the system, under any HUD
    this.root.visible = false;
    parent.add(this.root);
  }

  update(state, dt, t) {
    if (this._disposed) return 0;
    const idle = state.mode === 'idle' ? Math.min(1, Math.max(0, state.idleFor || 0)) : 0;
    const u = this._mat.uniforms;
    u.uAge.value = idle;
    u.uTime.value = t;
    u.uSize.value = Math.max(4, Number(this._radius()) || 14) * 1.15;
    this.root.visible = idle > 0.02;
    return 0;            // never asks for frames by itself; the drift is slow enough for 10 fps
  }

  reset() {}

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    this._geo.dispose();
    this._mat.dispose();
  }
}
