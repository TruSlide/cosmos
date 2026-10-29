// Map-mode links (GALAXY_CONTRACT §5.7): thin labeled lines that make the
// galaxy read like a network map. ONE LineSegments draw for all of them, in
// calm cool tones (never orange):
//   session → each subagent ship  (SHIP_AGENT)
//   fork → parent                 (STAR_FILL_0)
//   session → its arm             (arm tint, faint)
//   worktree member → cluster     (DISK_OUTER)
// Each end carries its own colour so a link fades from source to target,
// which tells direction without arrowheads.

import * as THREE from 'three';
import { color } from '../lib/palette.js';

export const LINK_KIND = Object.freeze({ SHIP: 0, FORK: 1, ARM: 2, CLUSTER: 3 });

export class Links {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'MapLinks';
    parent.add(this.root);
    this._tints = [
      color('SHIP_AGENT').multiplyScalar(0.55),
      color('STAR_FILL_0').multiplyScalar(0.6),
      color('STAR_FILL_0').multiplyScalar(0.22),
      color('DISK_OUTER').multiplyScalar(0.6),
    ];
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._cap = 0;
    this._n = 0;
    this._geo = null;
    this._lines = null;
    this._grow(256);
    this._disposed = false;
  }

  _grow(cap) {
    const old = this._geo;
    this._cap = cap;
    const geo = new THREE.BufferGeometry();
    this._pos = new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this._col = new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._pos);
    geo.setAttribute('color', this._col);
    geo.setDrawRange(0, 0);
    if (this._lines) this._lines.geometry = geo;
    else {
      this._lines = new THREE.LineSegments(geo, this.material);
      this._lines.frustumCulled = false;
      this._lines.renderOrder = 8;
      this._lines.name = 'MapLinks';
      this.root.add(this._lines);
    }
    this._geo = geo;
    if (old) old.dispose();
  }

  begin() { this._n = 0; }

  /** One link from a to b; `kind` picks the tint; fadeB dims the far end (0..1). */
  push(a, b, kind, fadeA = 1, fadeB = 0.35) {
    if (this._n >= this._cap) this._grow(this._cap * 2);
    const i = this._n++;
    const p = this._pos.array, c = this._col.array, t = this._tints[kind] ?? this._tints[1];
    p[i * 6] = a.x; p[i * 6 + 1] = a.y; p[i * 6 + 2] = a.z;
    p[i * 6 + 3] = b.x; p[i * 6 + 4] = b.y; p[i * 6 + 5] = b.z;
    c[i * 6] = t.r * fadeA; c[i * 6 + 1] = t.g * fadeA; c[i * 6 + 2] = t.b * fadeA;
    c[i * 6 + 3] = t.r * fadeB; c[i * 6 + 4] = t.g * fadeB; c[i * 6 + 5] = t.b * fadeB;
  }

  end(visible) {
    this._geo.setDrawRange(0, this._n * 2);
    this._lines.visible = visible && this._n > 0;
    if (this._n) {
      for (const at of [this._pos, this._col]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, this._n * 6);
        at.needsUpdate = true;
      }
    }
  }

  get count() { return this._n; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._geo.dispose();
    this.material.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
