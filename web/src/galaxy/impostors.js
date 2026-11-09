// Impostors: every star system that is not a full Gate 1 StarSystem, drawn as
// one instanced, camera-facing quad each, in ONE draw call (GALAXY_CONTRACT §5.5).
//
// The look is a distilled StarSystem, palette only, so the hand-off to the
// full system reads as "more detail", not "a different object":
//   working / needs-me : hot core in starColor(contextFill) + a faint accretion
//                        ring, squashed by the real viewing angle of the disk plane
//   my-move            : thin constant MY_MOVE ring (never pulses)
//   idle               : brightness 1 − idleFor, cool grey haze ring that grows with idleFor
//   dead               : fixed CINDER ember with a CINDER_RIM limb
//   crashed            : REMNANT_CORE point inside a speckle of REMNANT_SHARD
//   husk (aged-out / deleted) : hollow CINDER_RIM outline, no core
//   storm              : ERROR flicker on the halo (aperiodic noise, not a pulse)
// Needs-me systems are drawn as working here; their quasar glyph is beacons.js.
//
// Systems far away keep a minimum on-screen radius so a session is never lost
// to sub-pixel size, and lose contrast with distance (atmospheric layers).

import * as THREE from 'three';
import { color } from '../lib/palette.js';
import { ATMOS_GLSL } from './core.js';

export const IMP_MODE = Object.freeze({ WORKING: 0, NEEDS: 1, MY_MOVE: 2, IDLE: 3, DEAD: 4, CRASHED: 5, HUSK: 6, FLOURISH: 7 });

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iCol;
attribute vec4 iA;          // x size (world), y brightness, z idleFor, w mode
attribute vec4 iB;          // x storm, y fade, z seed, w activity
uniform float uPx;
uniform float uMinPx;
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vA;
varying vec4 vB;
varying float vSquash;
varying float vK;
varying float vPxR;
${ATMOS_GLSL}
void main() {
  vUv = position.xy * 2.0;
  vCol = iCol; vA = iA; vB = iB;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float d = max(-mv.z, 1e-3);
  // The quad spans 3x the body so halo and rings fit; keep a minimum px radius.
  float R = iA.x * 3.0;
  float pxR = R * uPx / d;
  float grow = max(1.0, uMinPx / max(pxR, 1e-3));
  R *= grow;
  vPxR = pxR * grow;
  // Disk plane foreshortening: |cos| between the view ray and the galactic up.
  vec3 n = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
  vSquash = max(abs(dot(n, normalize(-mv.xyz))), 0.12);
  vK = atmContrast(length(mv.xyz));
  mv.xy += position.xy * R * 2.0;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vA;
varying vec4 vB;
varying float vSquash;
varying float vK;
varying float vPxR;
uniform float uT;
uniform vec3 uDiskIn, uDiskOut, uMyMove, uHaze, uCinder, uCinderRim, uRemCore, uRemShard, uError;
${ATMOS_GLSL}
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float vnoise(float x) { float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }
// Thin ring of radius r0 with a width that never drops below ~1.2 px.
float ring(float r, float r0, float w) {
  float aa = 1.0 / max(vPxR, 1.0);
  float hw = max(w, 1.2 * aa);
  return 1.0 - smoothstep(hw, hw + aa * 1.5, abs(r - r0));
}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float mode = vA.w;
  float bright = vA.y;
  float idle = vA.z;
  float storm = vB.x;
  float fade = vB.y;
  float act = vB.w;
  vec3 c = vec3(0.0);
  if (mode < 1.5) {
    // Working (and needs-me body): hot core, soft halo, faint accretion ring.
    c += vCol * (exp(-r * r / 0.006) * 3.4 + exp(-r / 0.11) * 0.45) * bright;
    float re = length(vec2(vUv.x, vUv.y / vSquash));
    float disk = ring(re, 0.27, 0.035) * (0.35 + 0.5 * act);
    c += mix(uDiskIn, uDiskOut, smoothstep(0.2, 0.34, re)) * disk * 0.9;
  } else if (mode < 2.5) {
    // My move: calm body, constant teal ring (always a circle, like the beacon).
    c += vCol * (exp(-r * r / 0.006) * 2.0 + exp(-r / 0.1) * 0.3) * bright;
    c += uMyMove * ring(r, 0.5, 0.02) * 1.6;
  } else if (mode < 3.5) {
    // Idle: dimming body, cool haze thickening with the idle day.
    c += vCol * (exp(-r * r / 0.005) * 2.2 + exp(-r / 0.09) * 0.25) * bright;
    float haze = smoothstep(0.18, 0.45, r) * (1.0 - smoothstep(0.55, 0.95, r));
    c += uHaze * haze * idle * 0.16;
  } else if (mode < 4.5) {
    // Dead: a fixed ember. No motion, no pulse.
    c += uCinder * exp(-r * r / 0.004) * 0.9 + uCinderRim * ring(r, 0.11, 0.015) * 0.35;
  } else if (mode > 6.5) {
    // Flourishing (archived or closed cleanly): a calm, healthy body in a soft green-teal glow.
    c += vCol * (exp(-r * r / 0.005) * 2.0 + exp(-r / 0.1) * 0.25) * bright;
    c += vec3(0.22, 0.7, 0.5) * exp(-r / 0.2) * 0.14 * (1.0 - smoothstep(0.6, 1.0, r));
  } else if (mode < 5.5) {
    // Crashed: dim remnant point in a frozen shell of shards.
    c += uRemCore * exp(-r * r / 0.0025) * 1.4;
    float a = atan(vUv.y, vUv.x);
    float bin = floor((a + 3.1416) / 6.2832 * 23.0);
    float rr = 0.24 + 0.2 * hash11(bin + vB.z * 91.0);
    float dot_ = 1.0 - smoothstep(0.018, 0.04, length(vec2(r - rr, (fract((a + 3.1416) / 6.2832 * 23.0) - 0.5) * 0.12)));
    c += uRemShard * dot_ * 0.9;
  } else {
    // Husk: what is left of a session whose transcript is gone.
    c += uCinderRim * ring(r, 0.3, 0.012) * 0.6;
  }
  // Death cycle (idle / dead, phase passed in the activity slot): the collapse
  // shows from afar as one expanding white-blue shock ring.
  if (mode > 2.5 && mode < 4.5 && act > 0.8 && act < 0.97) {
    float k = (act - 0.8) / 0.17;
    c += mix(vec3(1.0), uDiskOut, 0.4) * ring(r, 0.12 + 0.75 * sqrt(k), 0.03) * (1.0 - k) * 1.4;
    c += vec3(1.0) * exp(-r * r / 0.004) * 3.0 * (1.0 - smoothstep(0.0, 0.2, k));
  }
  if (storm > 0.001) {
    // Storm: magenta flicker on the halo, aperiodic (two incommensurate noises).
    float f = vnoise(uT * 9.0 + vB.z * 50.0) * vnoise(uT * 5.3 + vB.z * 17.0);
    c += uError * exp(-r / 0.16) * storm * (0.4 + 2.2 * f);
  }
  gl_FragColor = vec4(atmApply(c, vK) * fade, 0.0);
}`;

export class Impostors {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx engine ObjectContext
   * @param {{ atm: object, capacity?: number }} opts
   */
  constructor(parent, ctx, opts) {
    this._ctx = ctx;
    this._atm = opts.atm;
    this.root = new THREE.Group();
    this.root.name = 'Impostors';
    parent.add(this.root);
    this._quad = new THREE.PlaneGeometry(1, 1);
    this._uPx = { value: 1 };
    this._uT = { value: 0 };
    this.material = new THREE.ShaderMaterial({
      name: 'GalaxyImpostors',
      uniforms: {
        uPx: this._uPx, uT: this._uT, uMinPx: { value: 3.2 },
        uDiskIn: { value: color('DISK_INNER') }, uDiskOut: { value: color('DISK_OUTER') },
        uMyMove: { value: color('MY_MOVE') }, uHaze: { value: color('ROCK_SPEC') },
        uCinder: { value: color('CINDER') }, uCinderRim: { value: color('CINDER_RIM') },
        uRemCore: { value: color('REMNANT_CORE') }, uRemShard: { value: color('REMNANT_SHARD') },
        uError: { value: color('ERROR') },
        ...this._atm,
      },
      vertexShader: VERT, fragmentShader: FRAG,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true, depthWrite: false,
    });
    this._cap = 0;
    this._n = 0;
    this._mesh = null;
    this._geo = null;
    this._disposed = false;
    this._grow(opts.capacity ?? 128);
  }

  _grow(cap) {
    const old = this._geo;
    this._cap = cap;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this._quad.index;
    geo.setAttribute('position', this._quad.getAttribute('position'));
    const mk = (k) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * k), k);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this._pos = mk(3); this._col = mk(3); this._a = mk(4); this._b = mk(4);
    geo.setAttribute('iPos', this._pos);
    geo.setAttribute('iCol', this._col);
    geo.setAttribute('iA', this._a);
    geo.setAttribute('iB', this._b);
    geo.instanceCount = 0;
    if (this._mesh) {
      this._mesh.geometry = geo;
    } else {
      this._mesh = new THREE.Mesh(geo, this.material);
      this._mesh.frustumCulled = false;
      this._mesh.renderOrder = 5;
      this._mesh.name = 'GalaxyImpostors';
      this.root.add(this._mesh);
    }
    this._geo = geo;
    // Only the instance buffers are ours; the quad is shared and lives on.
    if (old) { old.index = null; old.deleteAttribute('position'); old.dispose(); }
  }

  /** Start a frame's instance list. */
  begin() { this._n = 0; }

  /**
   * Append one system. Colors are linear THREE.Color.
   * @returns {number} instance index
   */
  push(pos, col, size, bright, idle, mode, storm, fade, seed, activity) {
    if (this._n >= this._cap) this._grow(this._cap * 2);
    const i = this._n++;
    const p = this._pos.array, c = this._col.array, a = this._a.array, b = this._b.array;
    p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
    c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
    a[i * 4] = size; a[i * 4 + 1] = bright; a[i * 4 + 2] = idle; a[i * 4 + 3] = mode;
    b[i * 4] = storm; b[i * 4 + 1] = fade; b[i * 4 + 2] = seed; b[i * 4 + 3] = activity;
    return i;
  }

  /** Commit the frame's list (one upload of ≤ a few KB). */
  end(t) {
    this._geo.instanceCount = this._n;
    this._mesh.visible = this._n > 0;
    for (const at of [this._pos, this._col, this._a, this._b]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, this._n * at.itemSize);
      at.needsUpdate = true;
    }
    this._uT.value = t;
    const cam = this._ctx.camera;
    this._uPx.value = this._ctx.resolution.y * 0.5 * cam.projectionMatrix.elements[5];
  }

  get count() { return this._n; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.root.remove(this._mesh);
    this._geo.index = null;
    this._geo.deleteAttribute('position');
    this._geo.dispose();
    this._quad.dispose();
    this.material.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
