// Level of detail: which sessions are full Gate 1 StarSystems (GALAXY_CONTRACT §5.5).
//
// Every frame galaxy.js hands in candidates with a score:
//   required (the selection, or a focus target)  → always full, counts toward the cap
//   needs-me within 900 units of the camera     → next
//   otherwise the projected system radius in px
// Promote at ≥ 48 px, demote below 32 px (hysteresis), demotion waits 2 s,
// and at most ONE StarSystem is constructed per frame (shader programs are
// shared, but buffers and the belt are not free). A new full system fades in
// over 0.4 s while its impostor fades out (galaxy.js reads `fade`).
//
// The planets show one planet per file when the camera is within ~90 units of
// the system, one per folder beyond (with hysteresis so it doesn't flicker).

import { StarSystem } from '../system.js';

export const PROMOTE_PX = 48;
export const DEMOTE_PX = 32;
const DEMOTE_DELAY_S = 2;
const FADE_S = 0.4;
const RETRY_S = 5;
const GRAIN_IN = 85;
const GRAIN_OUT = 100;

export class Lod {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx engine ObjectContext
   * @param {{ store: object, maxFull: () => number }} opts
   */
  constructor(parent, ctx, opts) {
    this._parent = parent;
    this._ctx = ctx;
    this._store = opts.store;
    this._maxFull = opts.maxFull;
    /** sid -> entry */
    this.entries = new Map();
    this._failed = new Map();      // sid -> render time of the last failure
    this._wanted = [];             // scratch
    this._grainOpts = { file: { fileGrain: 'file' }, folder: { fileGrain: 'folder' } };
    this._disposed = false;
    this.constructedThisFrame = false;
  }

  /** Full StarSystem for a session, or null. */
  get(sid) {
    const e = this.entries.get(sid);
    return e && e.system ? e.system : null;
  }

  /** 0..1 fade-in of the full system (1 = impostor fully gone). */
  fade(sid) {
    const e = this.entries.get(sid);
    return e && e.system ? e.fade : 0;
  }

  get count() {
    let n = 0;
    for (const e of this.entries.values()) if (e.system) n++;
    return n;
  }

  /**
   * Decide the full set and step every full system.
   * @param {Array<{ sid, score, px, required, eligible, pos, camDist }>} cands  (reused, length n)
   * @param {number} n
   * @param {number} dt
   * @param {number} t render clock
   * @returns {0|1|2} max rate hint
   */
  update(cands, n, dt, t) {
    if (this._disposed) return 0;
    const cap = Math.max(1, this._maxFull() | 0);
    this.constructedThisFrame = false;

    // Rank candidates (n is small: tens, at most a few hundred).
    const w = this._wanted;
    w.length = 0;
    for (let i = 0; i < n; i++) {
      const c = cands[i];
      const e = this.entries.get(c.sid);
      const isFull = !!(e && e.system);
      const keep = isFull && c.px >= DEMOTE_PX;
      if (c.required || c.eligible || keep) w.push(c);
    }
    w.sort((a, b) => b.score - a.score);
    if (w.length > cap) w.length = cap;

    // Mark wanted / unwanted.
    for (const e of this.entries.values()) e.want = false;
    for (const c of w) {
      let e = this.entries.get(c.sid);
      if (!e) {
        e = { sid: c.sid, system: null, state: {}, fade: 0, want: false, belowAt: -1, grain: 'folder', required: false };
        this.entries.set(c.sid, e);
      }
      e.want = true;
      e.required = c.required;
      e.belowAt = -1;
      e.pos = c.pos;
      e.camDist = c.camDist;
    }
    // Positions/distances for full systems that are not wanted this frame.
    for (let i = 0; i < n; i++) {
      const c = cands[i];
      const e = this.entries.get(c.sid);
      if (e && !e.want) { e.pos = c.pos; e.camDist = c.camDist; }
    }

    // Demote (after the delay; immediately when a required system needs the slot).
    let full = 0;
    for (const e of this.entries.values()) if (e.system) full++;
    let needsSlot = false;
    for (let i = 0; i < w.length; i++) if (w[i].required && !this.get(w[i].sid)) needsSlot = true;
    for (const [sid, e] of this.entries) {
      if (e.want) continue;
      if (!e.system) { this.entries.delete(sid); continue; }
      if (e.belowAt < 0) e.belowAt = t;
      const present = this._store.get(sid);
      if (!present || t - e.belowAt >= DEMOTE_DELAY_S || (needsSlot && full >= cap)) {
        e.system.dispose();
        e.system = null;
        this.entries.delete(sid);
        full--;
      }
    }

    // Promote: at most one construction per frame, required first (w is sorted).
    for (const c of w) {
      const e = this.entries.get(c.sid);
      if (e.system) continue;
      if (full >= cap || this.constructedThisFrame) break;
      const failedAt = this._failed.get(c.sid);
      if (failedAt !== undefined && t - failedAt < RETRY_S) continue;
      try {
        e.grain = c.camDist < GRAIN_IN ? 'file' : 'folder';
        const st = this._store.systemState(c.sid, this._grainOpts[e.grain], e.state);
        e.system = new StarSystem(this._parent, this._ctx, st);
        e.system.root.position.copy(c.pos);
        e.fade = 0;
        full++;
        this.constructedThisFrame = true;
        this._failed.delete(c.sid);
      } catch (err) {
        this._failed.set(c.sid, t);
        console.warn('[cosmos] could not build system', c.sid, err);
        if (e.system) { try { e.system.dispose(); } catch { /* ignore */ } }
        e.system = null;
      }
    }

    // Step every full system.
    let hint = 0;
    for (const [sid, e] of this.entries) {
      if (!e.system) continue;
      if (e.grain === 'file' && e.camDist > GRAIN_OUT) e.grain = 'folder';
      else if (e.grain === 'folder' && e.camDist < GRAIN_IN) e.grain = 'file';
      let st;
      try {
        st = this._store.systemState(sid, this._grainOpts[e.grain], e.state);
      } catch (err) {
        continue;    // the record vanished between frames; demotion handles it
      }
      if (e.pos) e.system.root.position.copy(e.pos);
      if (e.fade < 1) { e.fade = Math.min(1, e.fade + dt / FADE_S); hint = 2; }
      const h = e.system.update(st, dt, t) || 0;
      if (h > hint) hint = h;
    }
    return hint;
  }

  /** Drop every full system (quality change); they are rebuilt on demand. */
  clear() {
    for (const e of this.entries.values()) if (e.system) e.system.dispose();
    this.entries.clear();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const e of this.entries.values()) if (e.system) e.system.dispose();
    this.entries.clear();
  }
}
