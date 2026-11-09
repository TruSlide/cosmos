// Needs-me beacons: the quasar, readable from anywhere (GALAXY_CONTRACT §5.6).
//
// For every NEEDS ME session that is not already a big, fully drawn system,
// a screen-space quasar glyph sits on the system: a white-hot core and two
// separate, crisp jets in an hourglass (narrow at the star, widening outward),
// aligned with the system's real jet axis (world +Y, projected), pulsing on the
// quasar's own 2.4 s curve with knots firing down the jets at each crest. It is
// drawn last, with no depth test and no atmospheric fade: nothing outranks it.
// Without colour it still reads: no other glyph has jets or pulses.
//
// Off-screen or behind the camera, a DOM edge marker in #edge-markers points
// to it (chevron + hourglass + wait time); click to fly there. Markers sit on
// the edge of the visible scene: the screen border, pulled in past any HUD
// panel that covers it (never into the inner 30%). A quasar that is on screen
// but hidden under a panel gets a marker too.
//
// This file and star.js are the only scene modules allowed to use NEEDS_ME.
//
// kind 'crash' (owner, 2026-11-08): the same machinery draws a CRASHED distress
// beacon, louder than the quasar: bigger, orange, a fast double-flash strobe
// with a burst of sparks, and its own edge markers.

import * as THREE from 'three';
import { color, PALETTE } from '../lib/palette.js';

const PULSE_PERIOD = 2.4;          // ART_DIRECTION §3.3, same curve as the quasar core
const EDGE_INSET = 34;             // px from the viewport border
const EDGE_MIN_GAP = 30;           // px between two markers on the border
const OCC_MX = 30, OCC_MY = 16;    // px kept between a marker's centre and a HUD panel (marker is 52 x 24)
const HALO = 2.6;                  // quad size / glyph size: room for the wide halo

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iData;       // x size px (CSS), y alpha
uniform vec2 uRes;          // drawing-buffer size
uniform float uDpr;
varying vec2 vUv;
varying float vAlpha;
varying float vPx;
#define HALO ${HALO.toFixed(2)}
void main() {
  vUv = position.xy * 2.0 * HALO;      // glyph space: |p| <= 1 is the glyph, out to HALO the halo
  vAlpha = iData.y;
  mat4 pmv = projectionMatrix * modelViewMatrix;
  vec4 c0 = pmv * vec4(iPos, 1.0);
  vec4 c1 = pmv * vec4(iPos + vec3(0.0, 4.0, 0.0), 1.0);
  if (c0.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // behind: the edge marker takes over
  vec2 d = (c1.xy / max(c1.w, 1e-4) - c0.xy / c0.w) * uRes;
  vec2 up = dot(d, d) > 1e-4 && c1.w > 0.0 ? normalize(d) : vec2(0.0, 1.0);
  vec2 right = vec2(up.y, -up.x);
  float px = iData.x * uDpr;
  vPx = px;
  // Square quad HALO times the glyph: the hourglass in the middle, halo around.
  vec2 off = (position.x * right + position.y * up) * px * HALO;
  gl_Position = vec4(c0.xy + off * 2.0 / uRes * c0.w, 0.0, c0.w);
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying float vPx;
uniform vec3 uJet;
uniform vec3 uCore;
uniform float uPulse;       // 0..1, pow(0.5 + 0.5 sin, 4)
uniform float uKnot;        // 0..1 position of the knot along the jets
void main() {
  float aa = 2.2 / max(vPx, 1.0);
  vec2 p = vUv;                            // px-isotropic glyph space
  float ay = abs(p.y);
  float ax = abs(p.x);
  // Hourglass jets: narrow at the star, widening outward, clean edges.
  float y0 = 0.17;
  float w = 0.03 + 0.25 * clamp((ay - y0) / (1.0 - y0), 0.0, 1.0);
  float jetMask = (1.0 - smoothstep(w - aa, w + aa, ax))
                * smoothstep(y0 - aa, y0 + aa, ay)
                * (1.0 - smoothstep(0.96 - aa, 0.96 + aa, ay));
  float axial = 1.0 - 0.55 * smoothstep(y0, 0.96, ay);
  float spine = exp(-ax * ax / (w * w * 0.12));        // brighter on the axis
  float knot = exp(-pow((ay - mix(y0, 0.96, uKnot)) / 0.07, 2.0)) * (1.0 - uKnot);
  // Glyph-scale ladder: a few px of HDR bloom far wider than the jets, so the
  // values are lower than the full quasar's while staying the brightest thing
  // on screen (working impostors peak at ~3.4).
  float jet = jetMask * (2.6 + 1.6 * spine + 5.0 * knot) * axial;
  float r = length(p);
  float core = exp(-r * r / 0.006) * (6.0 + 9.0 * uPulse);
  float halo = exp(-r / 0.12) * (0.10 + 0.18 * uPulse) * (1.0 - smoothstep(0.5, 0.9, r));
  // Wide halo, several glyph sizes across: at galaxy scale this is what makes
  // the quasar out-shine the core. Fades to zero before the quad edge.
  float wide = exp(-r / 0.6) * (0.30 + 0.30 * uPulse) * (1.0 - smoothstep(${(HALO * 0.6).toFixed(2)}, ${(HALO * 0.98).toFixed(2)}, r));
  vec3 c = uJet * (jet + halo + wide) + uCore * core;
#ifdef CRASH
  // Distress: no jets. A hot core, a ring that flashes twice per beat and
  // eight short sparks, all in CRASHED orange.
  float rr = length(p);
  float ang = atan(p.y, abs(p.x) < 1e-5 ? 1e-5 : p.x);
  float ring = exp(-pow((rr - 0.55) / 0.06, 2.0)) * (1.5 + 5.0 * uPulse);
  float spark = pow(abs(cos(ang * 4.0)), 24.0) * smoothstep(0.25, 0.4, rr) * (1.0 - smoothstep(0.75, 0.95, rr)) * (1.0 + 4.0 * uPulse);
  float hot = exp(-rr * rr / 0.01) * (5.0 + 10.0 * uPulse);
  float glow = exp(-rr / 0.5) * (0.35 + 0.5 * uPulse) * (1.0 - smoothstep(${(HALO * 0.6).toFixed(2)}, ${(HALO * 0.98).toFixed(2)}, rr));
  c = uJet * (ring + spark + glow) + uCore * hot;
#endif
  gl_FragColor = vec4(c * vAlpha, 0.0);
}`;

/** "#rrggbb" for a palette token, for DOM styling. */
function cssHex(n) {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** True when (x, y) is inside any rect {l, t, r, b} grown by m px. */
function insideAny(rects, x, y, m) {
  for (const r of rects) if (x > r.l - m && x < r.r + m && y > r.t - m && y < r.b + m) return true;
  return false;
}
/** Ray (cx,cy)+t(dx,dy): the t where it enters the box, or Infinity. */
function rayEntry(cx, cy, dx, dy, l, t, r, b) {
  let t0 = -Infinity, t1 = Infinity;
  if (Math.abs(dx) < 1e-9) { if (cx < l || cx > r) return Infinity; } else {
    const a = (l - cx) / dx, c = (r - cx) / dx; t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
  }
  if (Math.abs(dy) < 1e-9) { if (cy < t || cy > b) return Infinity; } else {
    const a = (t - cy) / dy, c = (b - cy) / dy; t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
  }
  return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : Infinity;
}

export class Beacons {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx engine ObjectContext
   * @param {{ edgeRoot?: HTMLElement | null, onSelect?: (sid: string) => void }} opts
   */
  constructor(parent, ctx, opts = {}) {
    this._ctx = ctx;
    this._crash = opts.kind === 'crash';
    this.root = new THREE.Group();
    this.root.name = 'NeedsMeBeacons';
    parent.add(this.root);
    this._quad = new THREE.PlaneGeometry(1, 1);
    this._uRes = { value: new THREE.Vector2(1, 1) };
    this._uDpr = { value: 1 };
    this._uPulse = { value: 0 };
    this._uKnot = { value: 1 };
    this.material = new THREE.ShaderMaterial({
      name: this._crash ? 'CrashBeacon' : 'NeedsMeBeacon',
      defines: this._crash ? { CRASH: 1 } : {},
      uniforms: {
        uRes: this._uRes, uDpr: this._uDpr, uPulse: this._uPulse, uKnot: this._uKnot,
        uJet: { value: color(this._crash ? 'CRASHED' : 'NEEDS_ME') }, uCore: { value: color(this._crash ? 'CRASHED_CORE' : 'NEEDS_ME_CORE') },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true, depthWrite: false, depthTest: false,
    });
    this._cap = 0;
    this._n = 0;
    this._geo = null;
    this._mesh = null;
    this._grow(16);

    this._reduced = false;
    try {
      this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reduced = this._mq.matches;
      this._onMq = () => { this._reduced = this._mq.matches; };
      this._mq.addEventListener('change', this._onMq);
    } catch { this._mq = null; }

    // ---- edge markers (DOM, pooled)
    this._edgeRoot = opts.edgeRoot ?? null;
    this._onSelect = opts.onSelect ?? null;
    this._markers = [];
    this._markerN = 0;
    this._placed = [];       // scratch [{x, y}] for spacing
    if (this._edgeRoot) {
      // Colour comes from the palette here, so no page CSS needs the reserved hex.
      this._edgeRoot.style.setProperty('--cz-needs', cssHex(PALETTE.NEEDS_ME));
      this._edgeRoot.style.setProperty('--cz-needs-core', cssHex(PALETTE.NEEDS_ME_CORE));
      this._edgeRoot.style.setProperty('--cz-crash', cssHex(PALETTE.CRASHED));
      this._edgeRoot.style.setProperty('--cz-crash-core', cssHex(PALETTE.CRASHED_CORE));
      this._onClick = (e) => {
        const el = e.target.closest?.('[data-sid]');
        if (el && this._onSelect) { e.stopPropagation(); this._onSelect(el.dataset.sid); }
      };
      this._onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest?.('[data-sid]');
        if (el && this._onSelect) { e.preventDefault(); this._onSelect(el.dataset.sid); }
      };
      this._edgeRoot.addEventListener('click', this._onClick);
      this._edgeRoot.addEventListener('keydown', this._onKey);
    }
    this._disposed = false;
  }

  _grow(cap) {
    const old = this._geo;
    this._cap = cap;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this._quad.index;
    geo.setAttribute('position', this._quad.getAttribute('position'));
    this._pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this._data = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this._pos);
    geo.setAttribute('iData', this._data);
    geo.instanceCount = 0;
    if (this._mesh) this._mesh.geometry = geo;
    else {
      this._mesh = new THREE.Mesh(geo, this.material);
      this._mesh.frustumCulled = false;
      this._mesh.renderOrder = this._crash ? 1e6 + 1 : 1e6;     // drawn last (crash on top)
      this._mesh.name = 'NeedsMeBeacons';
      this.root.add(this._mesh);
    }
    this._geo = geo;
    if (old) { old.index = null; old.deleteAttribute('position'); old.dispose(); }
  }

  /** Quasar pulse (0..1) at render time t: the quasar's own curve. */
  pulse(t) {
    if (this._reduced) return 0.35;
    if (this._crash) {
      // Distress: two quick flashes every 1.2 s.
      const ph = (t / 1.2) % 1;
      return Math.max(Math.exp(-(((ph - 0.05) / 0.045) ** 2)), Math.exp(-(((ph - 0.24) / 0.045) ** 2)));
    }
    const s = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / PULSE_PERIOD);
    return s * s * s * s;
  }

  begin() { this._n = 0; }

  /** One glyph at a world position. sizePx in CSS px (14..36), alpha 0..1. */
  push(pos, sizePx, alpha) {
    if (this._n >= this._cap) this._grow(this._cap * 2);
    const i = this._n++;
    const p = this._pos.array, d = this._data.array;
    p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
    d[i * 2] = sizePx; d[i * 2 + 1] = alpha;
  }

  end(t) {
    this._geo.instanceCount = this._n;
    this._mesh.visible = this._n > 0;
    for (const at of [this._pos, this._data]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, this._n * at.itemSize);
      at.needsUpdate = true;
    }
    const res = this._ctx.resolution;
    this._uRes.value.copy(res);
    const cssH = this._ctx.renderer.domElement.clientHeight || res.y;
    this._uDpr.value = res.y / Math.max(1, cssH);
    this._uPulse.value = this.pulse(t);
    // Knot leaves the core at each pulse crest (sin peak at phase 0.25).
    const ph = ((t / PULSE_PERIOD - 0.25) % 1 + 1) % 1;
    this._uKnot.value = this._reduced ? 1 : Math.min(1, ph / 0.7);
  }

  get count() { return this._n; }

  // ------------------------------------------------------------ edge markers

  /**
   * Place DOM edge markers for off-screen / behind quasars.
   * @param {Array<{ sid, x, y, onScreen, behind, wait, title }>} list  (reused objects)
   * @param {number} n  entries used in list
   * @param {number} W  viewport CSS width
   * @param {number} H  viewport CSS height
   */
  placeMarkers(list, n, W, H, occ = null) {
    if (!this._edgeRoot) return;
    let k = 0;
    const cx = W / 2, cy = H / 2;
    const hw = W / 2 - EDGE_INSET, hh = H / 2 - EDGE_INSET;
    for (let i = 0; i < n; i++) {
      const q = list[i];
      // On screen but covered by a HUD panel: the glyph is hidden, so a marker shows instead.
      const covered = q.onScreen && !q.behind && occ && insideAny(occ, q.x, q.y, 0);
      if (q.onScreen && !q.behind && !covered) continue;
      let dx = q.x - cx, dy = q.y - cy;
      // Behind the camera the projection is mirrored: point the other way.
      if (q.behind) { dx = -dx; dy = -dy; }
      if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) dy = 1;
      let s = Math.min(hw / Math.max(Math.abs(dx), 1e-6), hh / Math.max(Math.abs(dy), 1e-6));
      if (covered) s = Math.min(s, 1);
      // Pull the marker in along its ray until it leaves every HUD panel, so it
      // sits on the edge of the VISIBLE scene, never on panel content. Only if
      // that would put it near the centre (inner 30%) does it stay on the
      // screen border instead (#edge-markers sits above #hud, so it still shows).
      if (occ && occ.length) {
        const s0 = s;
        for (let pass = 0; pass < 4; pass++) {
          let hit = false;
          for (const r of occ) {
            const x = cx + dx * s, y = cy + dy * s;
            if (!(x > r.l - OCC_MX && x < r.r + OCC_MX && y > r.t - OCC_MY && y < r.b + OCC_MY)) continue;
            const te = rayEntry(cx, cy, dx, dy, r.l - OCC_MX, r.t - OCC_MY, r.r + OCC_MX, r.b + OCC_MY);
            if (te < s) { s = Math.max(0, te - 1e-3); hit = true; }
          }
          if (!hit) break;
        }
        const x = cx + dx * s, y = cy + dy * s;
        if (Math.abs(x - cx) < W * 0.15 && Math.abs(y - cy) < H * 0.15) s = s0;
      }
      let x = cx + dx * s, y = cy + dy * s;
      // Keep markers apart: slide along the border away from earlier ones.
      for (let j = 0; j < k; j++) {
        const o = this._placed[j];
        if (Math.abs(o.x - x) < EDGE_MIN_GAP && Math.abs(o.y - y) < EDGE_MIN_GAP) {
          if (Math.abs(Math.abs(x - cx) - hw) < 1) y = Math.min(cy + hh, Math.max(cy - hh, y + EDGE_MIN_GAP));
          else x = Math.min(cx + hw, Math.max(cx - hw, x + EDGE_MIN_GAP));
        }
      }
      if (!this._placed[k]) this._placed[k] = { x: 0, y: 0 };
      this._placed[k].x = x; this._placed[k].y = y;
      const m = this._marker(k);
      const ang = Math.atan2(dy, dx);
      const tx = Math.round(x * 2) / 2, ty = Math.round(y * 2) / 2;
      if (m.x !== tx || m.y !== ty) {
        m.el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        m.x = tx; m.y = ty;
      }
      const deg = Math.round((ang * 180) / Math.PI);
      if (m.deg !== deg) { m.chev.style.transform = `rotate(${deg}deg) translateX(25px)`; m.deg = deg; }
      if (m.sid !== q.sid) { m.el.dataset.sid = q.sid; m.sid = q.sid; }
      if (m.wait !== q.wait) { m.waitEl.textContent = q.wait; m.wait = q.wait; }
      const label = this._crash
        ? `Crashed: ${q.title || q.sid.slice(0, 8)}, ${q.wait} ago. Fly there.`
        : `Needs you: ${q.title || q.sid.slice(0, 8)}, waiting ${q.wait}. Fly there.`;
      if (m.label !== label) { m.el.setAttribute('aria-label', label); m.el.title = label; m.label = label; }
      if (m.hidden) { m.el.style.display = ''; m.hidden = false; }
      k++;
    }
    for (let i = k; i < this._markerN; i++) {
      const m = this._markers[i];
      if (!m.hidden) { m.el.style.display = 'none'; m.hidden = true; }
    }
    this._markerN = Math.max(this._markerN, k);
    this._shown = k;
  }

  get markers() { return this._shown ?? 0; }

  _marker(i) {
    let m = this._markers[i];
    if (m) return m;
    const el = document.createElement('div');
    el.className = this._crash ? 'cz-edge cz-edge--crash' : 'cz-edge';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    const chev = document.createElement('span');
    chev.className = 'cz-edge-chev';
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('viewBox', '0 0 12 16');
    glyph.setAttribute('class', 'cz-edge-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // Hourglass: two jets meeting at the core. Crash: a burst.
    path.setAttribute('d', this._crash
      ? 'M6 0.5l1.1 4.6 3.9-2.5-2.5 3.9 4.1 1.5-4.1 1.5 2.5 3.9-3.9-2.5L6 15.5l-1.1-4.6-3.9 2.5 2.5-3.9L-0.6 8l4.1-1.5L1 2.6l3.9 2.5z'
      : 'M1.5 1h9L6.9 6.6h-1.8zM1.5 15h9L6.9 9.4h-1.8z');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', '6'); dot.setAttribute('cy', '8'); dot.setAttribute('r', '1.6');
    dot.setAttribute('class', 'cz-edge-core');
    glyph.append(path, dot);
    const waitEl = document.createElement('span');
    waitEl.className = 'cz-edge-wait';
    el.append(chev, glyph, waitEl);
    this._edgeRoot.appendChild(el);
    m = { el, chev, waitEl, x: NaN, y: NaN, deg: NaN, sid: null, wait: null, label: null, hidden: false };
    this._markers[i] = m;
    return m;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._mq && this._onMq) this._mq.removeEventListener('change', this._onMq);
    if (this._edgeRoot) {
      this._edgeRoot.removeEventListener('click', this._onClick);
      this._edgeRoot.removeEventListener('keydown', this._onKey);
      for (const m of this._markers) m.el.remove();
    }
    this.root.remove(this._mesh);
    this._geo.index = null;
    this._geo.deleteAttribute('position');
    this._geo.dispose();
    this._quad.dispose();
    this.material.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
