// Shared-file constellations (owner, 2026-11-08): faint lines between sessions
// that edited the same files, so you can see which sessions touch the same
// work. Sharing is fine (one job split over several sessions); the risk is two
// LIVE sessions editing the same file at about the same time, because one can
// overwrite the other. Those pairs draw as a pulsing amber "collision" line.
//
// Only sessions active in the last week take part; pairs are recomputed every
// few seconds (cheap: per-file buckets of each session's edited files). One
// draw call (line segments with per-vertex color).

import * as THREE from 'three';
import { color } from '../lib/palette.js';

const WEEK_S = 7 * 86400;
const COLLIDE_S = 30 * 60;        // both edited the shared file within this window
const RECOMPUTE_S = 4;
const MAX_LINKS = 400;

/** Key for a file across sessions: absolute-ish path (project folder + relative path). */
function fileKey(rec, f) {
  const p = String(f.path || '');
  if (!p) return null;
  if (p.startsWith('/') || p.startsWith('~/')) return p;
  return `${rec.arm?.key || ''}/${p}`;
}

export class Constellations {
  constructor(parent) {
    this._max = MAX_LINKS;
    this._pos = new Float32Array(MAX_LINKS * 2 * 3);
    this._col = new Float32Array(MAX_LINKS * 2 * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this._col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this._mat = new THREE.ShaderMaterial({
      name: 'Constellations',
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 aCol;   // rgb, w: 0 shared / 1 collision
        varying vec4 vCol;
        void main() { vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec4 vCol;
        void main() {
          float k = vCol.w > 0.5 ? 0.55 + 0.45 * sin(uTime * 4.0) : 1.0;
          gl_FragColor = vec4(vCol.rgb * k, 0.0);
        }`,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true, depthWrite: false,
    });
    this.lines = new THREE.LineSegments(g, this._mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -2;
    parent.add(this.lines);
    this._links = [];                 // { a, b, shared, collide, files: [] }
    this._at = -Infinity;
    this._shared = new Color3(color('ME_PEARL')).scale(0.16);
    this._warn = new Color3(color('TREE_AMBER')).scale(0.9);
    this.enabled = true;
  }

  /** Recompute which sessions share edited files (from the client store records). */
  recompute(recs, nowS) {
    const buckets = new Map();       // fileKey -> [{ sid, lastT, live }]
    for (const r of recs) {
      const la = r.times?.lastActivity ?? 0;
      if (nowS - la > WEEK_S || !Array.isArray(r.files)) continue;
      const live = r.state?.mode === 'working' || r.state?.mode === 'needs-me' || r.state?.mode === 'my-move';
      for (const f of r.files) {
        if (!(f.edits > 0)) continue;
        const k = fileKey(r, f);
        if (!k) continue;
        let b = buckets.get(k);
        if (!b) { b = []; buckets.set(k, b); }
        b.push({ sid: r.id, lastT: f.lastT ?? 0, live });
      }
    }
    const pairs = new Map();
    for (const [k, b] of buckets) {
      if (b.length < 2 || b.length > 12) continue;   // a file every session touches is noise
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
        const x = b[i], y = b[j];
        if (x.sid === y.sid) continue;
        const key = x.sid < y.sid ? `${x.sid}|${y.sid}` : `${y.sid}|${x.sid}`;
        let p = pairs.get(key);
        if (!p) { p = { a: x.sid < y.sid ? x.sid : y.sid, b: x.sid < y.sid ? y.sid : x.sid, shared: 0, collide: false, files: [] }; pairs.set(key, p); }
        p.shared++;
        if (p.files.length < 5) p.files.push(k.split('/').pop());
        if (x.live && y.live && nowS - x.lastT < COLLIDE_S && nowS - y.lastT < COLLIDE_S) p.collide = true;
      }
    }
    this._links = [...pairs.values()].sort((p, q) => (q.collide - p.collide) || (q.shared - p.shared)).slice(0, MAX_LINKS);
  }

  /** Links touching one session (Selected panel). */
  linksOf(sid) { return this._links.filter((l) => l.a === sid || l.b === sid); }
  get collisions() { return this._links.filter((l) => l.collide); }

  /**
   * @param {number} t render clock
   * @param {() => Iterable} recsFn records
   * @param {number} nowS data clock
   * @param {(sid: string) => THREE.Vector3 | null} posOf
   */
  update(t, recsFn, nowS, posOf) {
    this.lines.visible = this.enabled;
    if (!this.enabled) return 0;
    if (t - this._at > RECOMPUTE_S) { this._at = t; this.recompute([...recsFn()], nowS); }
    this._mat.uniforms.uTime.value = t;
    let n = 0;
    for (const l of this._links) {
      const pa = posOf(l.a), pb = posOf(l.b);
      if (!pa || !pb) continue;
      const c = l.collide ? this._warn : this._shared;
      const w = l.collide ? 1 : 0;
      const k = l.collide ? 1 : Math.min(1, 0.45 + 0.15 * l.shared);
      this._pos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], n * 6);
      this._col.set([c.r * k, c.g * k, c.b * k, w, c.r * k, c.g * k, c.b * k, w], n * 8);
      n++;
    }
    const g = this.lines.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('aCol').needsUpdate = true;
    g.setDrawRange(0, n * 2);
    return this.collisions.length ? 1 : 0;
  }

  dispose() {
    this.lines.parent?.remove(this.lines);
    this.lines.geometry.dispose();
    this._mat.dispose();
  }
}

/** Tiny color holder (avoids keeping THREE.Color objects scaled in place). */
class Color3 {
  constructor(c) { this.r = c.r; this.g = c.g; this.b = c.b; }
  scale(k) { this.r *= k; this.g *= k; this.b *= k; return this; }
}
