// StarSystem: one Claude Code session rendered as a star system (CONTRACT §7).
//
// It owns every object module and wires their cross-effects. Its only input
// is a SystemState (CONTRACT §2), once per frame. Nothing here knows whether
// the state came from a scripted demo, a replayed transcript or a live hook:
// that seam is the whole point of this class.
//
// Update order matters (each step reads what the previous one produced):
//   whiteHole → star.setBirth → belt → planets → blackHole → ships → flares
//   → star.setStormLevel → star → nebula

import * as THREE from 'three';
import { normalizeState } from './lib/state.js';
import { Star } from './objects/star.js';
import { Nebula } from './objects/nebula.js';
import { BlackHole, WhiteHole } from './objects/singularities.js';
import { Flares } from './objects/flares.js';
import { Planets } from './objects/planets.js';
import { Ships } from './objects/ships.js';
import { AsteroidBelt } from './objects/belt.js';
import { IdleHaze } from './objects/haze.js';
import { Nova, NOVA_START } from './objects/nova.js';
import { damp } from './lib/math.js';

// Death cycle (state.fate 'dying', deathPhase 0..1, owner 2026-11-08): planets
// age then break apart (planets.js); the star swells, then collapses in a nova
// (SWELL_* / NOVA_START), leaving a small cinder; the belt scatters outward.
const SWELL_START = 0.45;
const SWELL_PEAK = NOVA_START;
const SWELL_MAX = 1.75;
const CINDER = 0.32;

export class StarSystem {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx  ObjectContext from the engine
   * @param {object} initialState  a SystemState (validated here)
   */
  constructor(parent, ctx, initialState) {
    // Scratch state: normalizeState writes into it every frame (no allocation).
    this._state = normalizeState(initialState, {});
    const seed = this._state.id;
    this._disposed = false;
    // Motion clock: advances at star.motionRate (1 alive → 0 dead or crashed),
    // so orbits and tumbles slow with idle decay and stop dead (DATA_SPEC §3.5).
    this._mt = 0;

    this.root = new THREE.Group();
    this.root.name = `StarSystem:${seed}`;
    parent.add(this.root);

    // Construction order only breaks ties in three's transparent sort; each
    // module sets renderOrder where its own layering matters.
    this.belt = new AsteroidBelt(this.root, ctx, { seed });
    this.planets = new Planets(this.root, ctx, { max: 24 });
    this.star = new Star(this.root, ctx, { seed });
    this.nebula = new Nebula(this.root, ctx, { seed });
    this.flares = new Flares(this.root, ctx, { seed, starRadius: () => this.star.radius });
    this.ships = new Ships(this.root, ctx, {
      resolveTarget: (id, out) => this.planets.getPosition(id, out),
      onArrive: (id) => this.planets.ping(id),
      starRadius: () => this.star.radius,
    });
    this.blackHole = new BlackHole(this.root, ctx, { seed, beltRadius: () => this.belt.midRadius });
    this.whiteHole = new WhiteHole(this.root, ctx, { seed });
    // Galaxy-distance sign of idle age (planets show it up close).
    this.haze = new IdleHaze(this.root, ctx, { radius: () => this.belt.midRadius * 1.3 });
    this.nova = new Nova(this.root, ctx, { seedNum: [...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0) });
    this._fate = { star: 1, belt: 1 };

    // A compaction's black hole pulls a sector of the belt in.
    this.blackHole.onSwallow = (info) => this.belt.swallow(info);
  }

  /** Normalized copy of the last state passed to update (read-only for callers). */
  get state() {
    return this._state;
  }

  /**
   * @param {object} state  SystemState for this frame
   * @param {number} dt     seconds since last frame (≤ 0.1)
   * @param {number} t      render clock (belt and planets get the motion clock instead)
   * @returns {0|1|2} max rate hint of the children
   */
  update(state, dt, t) {
    if (this._disposed) return 0;
    const s = normalizeState(state, this._state);
    let hint = this.whiteHole.update(s, dt, t) || 0;
    this.star.setBirth(this.whiteHole.birthProgress);
    // Rate from the star's previous frame (it updates later); one frame of lag is invisible.
    this._mt += dt * this.star.motionRate;
    const mt = this._mt;
    hint = Math.max(hint, this.belt.update(s, dt, mt) || 0);
    hint = Math.max(hint, this.planets.update(s, dt, mt) || 0);
    hint = Math.max(hint, this.blackHole.update(s, dt, t) || 0);
    hint = Math.max(hint, this.ships.update(s, dt, t) || 0);
    hint = Math.max(hint, this.flares.update(s, dt, t) || 0);
    this.star.setStormLevel(this.flares.stormLevel);
    this._applyFate(s, dt);
    hint = Math.max(hint, this.star.update(s, dt, t) || 0);
    hint = Math.max(hint, this.nebula.update(s, dt, t) || 0);
    this.haze.update(s, dt, t);
    hint = Math.max(hint, this.nova.update(s) || 0);
    return hint;
  }

  /** Star swell / collapse and belt scatter for the death cycle (damped, so a daily restart re-forms smoothly). */
  _applyFate(s, dt) {
    let star = 1, belt = 1;
    if (s.fate === 'dying') {
      const p = s.deathPhase;
      if (p >= SWELL_PEAK) star = CINDER;
      else if (p > SWELL_START) {
        const k = (p - SWELL_START) / (SWELL_PEAK - SWELL_START);
        star = 1 + (SWELL_MAX - 1) * k * k * (3 - 2 * k);
      }
      belt = 1 + 0.6 * Math.min(1, Math.max(0, (p - 0.55) / 0.35));
    }
    // Collapse is fast (it is a collapse); everything else eases.
    const f = this._fate;
    f.star = star < f.star - 0.3 ? damp(f.star, star, 0.15, dt) : damp(f.star, star, 1.2, dt);
    f.belt = damp(f.belt, belt, 1.5, dt);
    this.star.fateScale = f.star;
    this.belt.root.scale.setScalar(f.belt);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.blackHole.onSwallow = null;
    for (const o of [this.nova, this.haze, this.whiteHole, this.blackHole, this.ships, this.flares,
      this.nebula, this.star, this.planets, this.belt]) o.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
