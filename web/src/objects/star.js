// Star: the hero object of a star system.
//
// Owns (CONTRACT §4): photosphere surface, corona, accretion disk, quasar
// (halo + twin jets + knots + pulse), my-move beacon, idle decay, and the crash
// collapse with its remnant (core + 40 shards).
//
// Draw calls (at most 7, most states 3–4):
//   surface (opaque)        icosphere, granulation shader, writes depth
//   glow    (additive)      one camera-facing quad: corona + quasar halo/core +
//                           collapse flash + remnant core/shell haze
//   disk    (additive)      Keplerian accretion annulus with Doppler beaming
//   jets    (additive) ×2   outer sheath + inner spine, each one instanced draw
//                           holding both the +Y and −Y jet
//   beacon  (additive)      thin camera-facing ring with a radar sweep
//   shards  (opaque)        40 remnant fragments, one instanced draw
//
// Brightness ladder (ART_DIRECTION §2) is enforced by working in luminance
// units: every palette color handed to a shader is pre-divided by its own
// luminance, so a uniform value of 6 means "peak linear luminance 6".
//
// Ladder note: the ladder values are caps. Measured with the spec bloom
// (0.9 / 0.55 / threshold 1) and ACES, a surface at 6 tone-maps to flat white
// (granulation invisible) and jets at 6–10 veil the whole frame orange. So the
// surface peaks at 2.0 (lower as context fills, so crimson survives ACES),
// corona 1.1. Jets (Gate 1 review: two crisp hourglass lobes) sit at the
// bloom threshold, sheath 0.5 and spine 0.95, because anything brighter on a
// 14 u line blooms into one wide flame; pulse knots lift the spine to ~2.3 so
// each one blooms as it travels. The halo is compact (σ 1.05 u, 0.6–0.95) so
// it never bridges the lobes and the waist stays dark. The quasar core
// keeps the full 14 → 30 pulse, so the order of the ladder (quasar ≫
// everything) is unchanged.
//
// NEEDS ME hue: per-channel ACES would wash #FF5F1F to amber/cream at these
// luminances. engine.js's output pass tone-maps pixels in the NEEDS ME hue
// band hue-preservingly, so the orange layers here stay pure NEEDS_ME and
// only the small white-hot core carries NEEDS_ME_CORE.
//
// This is the ONLY module allowed to use PALETTE NEEDS_ME / NEEDS_ME_CORE.

import * as THREE from 'three';
import { color, starColor, saturateOklab } from '../lib/palette.js';
import { hash01, mulberry32, damp, clamp, lerp, smoothstep, ease } from '../lib/math.js';

import {
  DISK_IN, DISK_OUT, DISK_TILT, DISK_GHOST, JET_LEN, JET_Y0, PULSE_PERIOD, PULSE_CREST, KNOT_SPEED, Q_FLASH, Q_EXTEND, Q_RETRACT, Q_HALO_OUT, BEACON_RADIUS, BEACON_TUBE, BEACON_SWEEP, BEACON_IN, BEACON_OUT, L_SURFACE, L_CORONA, L_QCORE_TROUGH, L_QCORE_SWING, L_JET, L_JET_SHEATH, L_REMNANT, L_FLASH, CRASH_IMPLODE, CRASH_FLASH, CRASH_TOTAL, REMNANT_RADIUS, SHELL_RADIUS, SHARD_COUNT,
} from './star-constants.js';
import {
  SURFACE_VERT, SURFACE_FRAG, GLOW_VERT, GLOW_FRAG, DISK_VERT, DISK_FRAG, JET_VERT, JET_FRAG, BEACON_VERT, BEACON_FRAG, SHARD_VERT, SHARD_FRAG,
} from './star-shaders.js';

const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);

/** Luminance of a linear THREE.Color. */
function lumOf(c) {
  return c.r * LUMA.x + c.g * LUMA.y + c.b * LUMA.z;
}

/** Palette color divided by its own luminance ("1 unit of light"), as a Vector3 uniform. */
function unitColor(name) {
  const c = color(name);
  const l = Math.max(lumOf(c), 1e-4);
  return new THREE.Vector3(c.r / l, c.g / l, c.b / l);
}

/** Write linear color `c` into Vector3 `v` scaled to unit luminance. */
function setUnit(v, c) {
  const l = Math.max(lumOf(c), 1e-4);
  return v.set(c.r / l, c.g / l, c.b / l);
}

/** Plain linear palette color as a Vector3 uniform. */
function rawColor(name) {
  const c = color(name);
  return new THREE.Vector3(c.r, c.g, c.b);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function additive(params) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    ...params,
  });
}

/** Clone a BufferGeometry into an InstancedBufferGeometry with extra per-instance attributes. */
function instanced(base, count, attrs) {
  const g = new THREE.InstancedBufferGeometry().copy(base);
  g.instanceCount = count;
  for (const [name, [array, size]] of Object.entries(attrs)) {
    g.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
  }
  base.dispose();
  return g;
}

// ---------------------------------------------------------------------------
// Star
// ---------------------------------------------------------------------------

export class Star {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx  ObjectContext (CONTRACT §3.1)
   * @param {{seed?: string}} opts
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this.quality = ctx?.quality ?? 'high';
    this.seed = opts.seed ?? 'star';
    this._disposed = false;

    this.root = new THREE.Group();
    this.root.name = 'Star';
    parent.add(this.root);

    // `body` carries the birth scale; everything visual hangs below it.
    this.body = new THREE.Group();
    this.root.add(this.body);

    // Scratch objects (no per-frame allocation).
    this._col = new THREE.Color();
    this._sat = new THREE.Color();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();

    this._buildSurface();
    this._buildGlow();
    this._buildDisk();
    this._buildJets();
    this._buildBeacon();
    this._buildShards();

    this._birth = 1;
    this._storm = 0;
    this.reset();
  }

  // --- construction -------------------------------------------------------

  _buildSurface() {
    const q = this.quality;
    const detail = q === 'high' ? 20 : q === 'medium' ? 14 : 9;
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const defines = { CZ_OCT: q === 'low' ? 3 : q === 'medium' ? 4 : 5 };
    if (q !== 'low') defines.CZ_WORLEY = 1;
    this.surfaceMat = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uSat: { value: new THREE.Vector3(1, 1, 1) },
        uSatDeep: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: L_SURFACE },
        uFlow: { value: 0 },
        uRot: { value: 0 },
        uDesat: { value: 0 },
        uDead: { value: 0 },
        uStorm: { value: 0 },
        uStormCol: { value: unitColor('ERROR') },
        uCinder: { value: rawColor('CINDER') },
        uCinderRim: { value: rawColor('CINDER_RIM') },
        uRemnant: { value: 0 },
        uRemnantCol: { value: unitColor('REMNANT_CORE') },
        uFlash: { value: 0 },
        uFade: { value: 1 },
      },
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
    });
    this.surface = new THREE.Mesh(geo, this.surfaceMat);
    this.surface.name = 'StarSurface';
    this.body.add(this.surface);
  }

  _buildGlow() {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.glowMat = additive({
      uniforms: {
        uExtent: { value: 4 },
        uPush: { value: 1.1 },
        uRadius: { value: 1 },
        uFlow: { value: 0 },
        uJitter: { value: new THREE.Vector3() },
        uStorm: { value: 0 },
        uCoronaL: { value: L_CORONA },
        uCoronaK: { value: 2.4 },
        uCoronaCol: { value: new THREE.Vector3(1, 1, 1) },
        uQ: { value: 0 },
        uQHaloL: { value: 0 },
        uQCoreL: { value: 0 },
        uNeeds: { value: unitColor('NEEDS_ME') },
        uNeedsCore: { value: unitColor('NEEDS_ME_CORE') },
        uFlashL: { value: 0 },
        uRem: { value: 0 },
        uRemCol: { value: unitColor('REMNANT_CORE') },
        uShellR: { value: SHELL_RADIUS },
        uShellL: { value: 0 },
        uFade: { value: 1 },
      },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
    });
    this.glow = new THREE.Mesh(geo, this.glowMat);
    this.glow.name = 'StarGlow';
    this.glow.frustumCulled = false; // vertex shader billboards; geometry bounds are meaningless
    this.glow.renderOrder = 2;
    this.body.add(this.glow);
  }

  _buildDisk() {
    const geo = new THREE.RingGeometry(DISK_IN, DISK_OUT, 128, 8);
    this.diskMat = additive({
      side: THREE.DoubleSide,
      uniforms: {
        uPhase: { value: 0 },
        uAlpha: { value: 1 },
        uGain: { value: 1.05 },
        uDesat: { value: 0 },
        uFade: { value: 1 },
        uInner: { value: unitColor('DISK_INNER') },
        uOuter: { value: unitColor('DISK_OUTER') },
        uDoppler: { value: unitColor('DISK_DOPPLER') },
      },
      vertexShader: DISK_VERT,
      fragmentShader: DISK_FRAG,
    });
    this.disk = new THREE.Mesh(geo, this.diskMat);
    this.disk.name = 'AccretionDisk';
    this.disk.rotation.x = -Math.PI / 2; // ring XY → orbital XZ
    // Tilt 12° off the orbital plane so it reads as a disk from the default camera.
    this.diskPivot = new THREE.Group();
    this.diskPivot.rotation.x = DISK_TILT;
    this.diskPivot.add(this.disk);
    this.body.add(this.diskPivot);
  }

  _buildJets() {
    const hi = this.quality !== 'low';
    const mk = (rBase, rTop, gain, rim, core, name) => {
      // Unit-radius tube; the vertex shader flares it into the hourglass lobe.
      const base = new THREE.CylinderGeometry(1, 1, JET_LEN - JET_Y0, hi ? 48 : 24, hi ? 64 : 32, true);
      base.translate(0, (JET_LEN + JET_Y0) / 2, 0); // y ∈ [Y0, 14], starting at the pole
      const geo = instanced(base, 2, { aSign: [new Float32Array([1, -1]), 1] });
      const mat = additive({
        side: THREE.DoubleSide,
        uniforms: {
          uExt: { value: 0 },
          uTime: { value: 0 },
          uKnotY: { value: -1 },
          uGain: { value: gain },
          uRBase: { value: rBase },
          uRTop: { value: rTop },
          uRim: { value: rim },
          uCore: { value: core },
          uNeeds: { value: unitColor('NEEDS_ME') },
          uNeedsCore: { value: unitColor('NEEDS_ME_CORE') },
        },
        vertexShader: JET_VERT,
        fragmentShader: JET_FRAG,
      });
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.frustumCulled = false;
      m.renderOrder = 3;
      m.visible = false;
      this.body.add(m);
      return m;
    };
    // Hourglass: each lobe is a cone pinched to a point at the pole and flared
    // outward. The sheath (0.03 → 2.3) is limb-brightened, so the cone walls
    // read as crisp edges; the spine (0.02 → 0.28) is the bright core on the
    // axis that blooms. Both stay mostly pure NEEDS_ME; only a touch of the
    // white-hot core color near the pole, so the jets keep their orange.
    this.jetSheath = mk(0.03, 1.9, L_JET_SHEATH, 0.9, 0.1, 'QuasarJetSheath');
    this.jetSpine = mk(0.02, 0.28, L_JET, 0.0, 0.35, 'QuasarJetSpine');
    this._jetBaseGain = [L_JET_SHEATH, L_JET];
  }

  _buildBeacon() {
    const geo = new THREE.TorusGeometry(BEACON_RADIUS, BEACON_TUBE, 8, 256);
    this.beaconMat = additive({
      uniforms: {
        uSweep: { value: 0 },
        uAmt: { value: 0 },
        uCol: { value: unitColor('MY_MOVE') },
      },
      vertexShader: BEACON_VERT,
      fragmentShader: BEACON_FRAG,
    });
    this.beacon = new THREE.Mesh(geo, this.beaconMat);
    this.beacon.name = 'Beacon';
    this.beacon.visible = false;
    this.body.add(this.beacon);
  }

  _buildShards() {
    const rng = mulberry32(Math.floor(hash01(`${this.seed}:shards`) * 4294967296));
    const dir = new Float32Array(SHARD_COUNT * 3);
    const rot = new Float32Array(SHARD_COUNT * 4);
    const scl = new Float32Array(SHARD_COUNT * 3);
    const rad = new Float32Array(SHARD_COUNT);
    const v = new THREE.Vector3();
    for (let i = 0; i < SHARD_COUNT; i++) {
      // Uniform direction on the sphere, slightly flattened toward the orbital plane.
      const z = rng() * 2 - 1;
      const a = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      v.set(s * Math.cos(a), z * 0.8, s * Math.sin(a)).normalize();
      dir.set([v.x, v.y, v.z], i * 3);
      v.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
      rot.set([v.x, v.y, v.z, rng() * Math.PI * 2], i * 4);
      const big = 0.06 + rng() * 0.14;
      scl.set([big, big * (0.25 + rng() * 0.5), big * (0.6 + rng() * 0.8)], i * 3);
      rad[i] = 0.82 + rng() * 0.3;
    }
    const geo = instanced(new THREE.TetrahedronGeometry(1, 0), SHARD_COUNT, {
      aDir: [dir, 3],
      aRot: [rot, 4],
      aScl: [scl, 3],
      aRad: [rad, 1],
    });
    this.shardMat = new THREE.ShaderMaterial({
      uniforms: {
        uShell: { value: 0 },
        uGlow: { value: 1 },
        uCol: { value: unitColor('REMNANT_SHARD') },
      },
      vertexShader: SHARD_VERT,
      fragmentShader: SHARD_FRAG,
    });
    this.shards = new THREE.Mesh(geo, this.shardMat);
    this.shards.name = 'RemnantShards';
    this.shards.frustumCulled = false;
    this.shards.visible = false;
    this.body.add(this.shards);
  }

  // --- public API -----------------------------------------------------------

  /** Current visual radius in system units (1 normally; 0.22 as a remnant; 0→1 during birth). */
  get radius() {
    return this._birthScale * this._crashScale;
  }

  /** Current HDR peak luminance of anything this star draws (QA ladder checks). */
  get surfaceLuminance() {
    return this._lum;
  }

  /** 0..1 from the white hole's settle phase: scale and fade-in. */
  setBirth(progress) {
    this._birth = clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
  }

  /** 0..1 from Flares: magenta mottling on the surface, jittered corona. */
  setStormLevel(level) {
    this._storm = clamp(Number.isFinite(level) ? level : 0, 0, 1);
  }

  reset() {
    this._init = false;
    this._lastNow = null;
    this._mode = null;

    // Smoothed state (snapped on the first update after reset).
    this._act = 0;
    this._fill = 0;
    this._idle = 0;
    this._spin = 0;
    this._diskA = DISK_GHOST;
    this._beacon = 0;

    // Accumulated phases.
    this._flow = 0;
    this._rot = 0;
    this._diskPhase = 0;
    this._sweep = 0;
    this._coronaFlow = 0;

    // Quasar state machine: 'off' | 'ign' | 'on' | 'rel'.
    this._qPhase = 'off';
    this._qT = 0;
    this._qClock = 0;
    this._jet = 0;
    this._halo = 0;
    this._jet0 = 0;
    this._halo0 = 0;

    // Crash.
    this._crashed = false;
    this._crashAge = 0;
    this._crashScale = 1;

    this._birthScale = 1;
    this._lum = 0;
    this._motionRate = 1;
  }

  /**
   * 0..1 speed of this system's motion clock: 1 alive, → 0 as idle decay
   * completes, 0 once a crash has collapsed. StarSystem integrates it and runs
   * belt and planet orbits on it, so a dead system is perfectly still.
   */
  get motionRate() {
    return this._motionRate;
  }

  /**
   * @param {object} state  normalized SystemState
   * @param {number} dt     seconds since last frame (≤ 0.1)
   * @param {number} t      render clock
   * @returns {0|1|2} rate hint
   */
  update(state, dt, t) {
    if (this._disposed || !state) return 0;
    const now = state.now;
    if (this._lastNow !== null && now < this._lastNow - 1e-3) this.reset(); // replay scrub
    this._lastNow = now;

    const first = !this._init;
    this._init = true;
    const mode = state.mode;
    if (mode !== this._mode) this._mode = mode;

    const working = mode === 'working';
    const thinking = mode === 'thinking';
    const needs = mode === 'needs-me';
    const myMove = mode === 'my-move';
    const crashedMode = mode === 'crashed';
    const idleish = mode === 'idle' || myMove;

    let hint = 0;

    // ---- smoothed scalar inputs ------------------------------------------
    const activity = clamp(state.activity ?? 0, 0, 1);
    const fill = Math.max(0, state.contextFill ?? 0);
    const idleTarget = idleish ? clamp(state.idleFor ?? 0, 0, 1) : 0;

    let spinTarget;
    let diskTarget;
    if (working) { spinTarget = 0.3 + 0.7 * activity; diskTarget = 0.35 + 0.65 * activity; }
    else if (thinking) { spinTarget = 0.4 * (0.3 + 0.7 * activity); diskTarget = 0.5; }
    // Waiting on the owner is not work: the disk drops to its ghost so the
    // orange halo reads pure (a blue disk under it would pull it toward pink).
    else if (needs) { spinTarget = 0.15 * 0.65; diskTarget = DISK_GHOST; }
    else if (crashedMode) { spinTarget = 0; diskTarget = 0; }
    else { spinTarget = 0; diskTarget = DISK_GHOST; }
    const beaconTarget = myMove ? 1 : 0;

    if (first) {
      this._act = activity;
      this._fill = fill;
      this._idle = idleTarget;
      this._spin = spinTarget;
      this._diskA = diskTarget;
      this._beacon = beaconTarget;
    } else {
      this._act = damp(this._act, activity, 0.6, dt);
      this._fill = damp(this._fill, fill, 0.8, dt);
      this._idle = damp(this._idle, idleTarget, 1.5, dt);
      // Spin-up ≈ 1 s; spin-down decays exponentially over ≈ 3 s.
      this._spin = damp(this._spin, spinTarget, spinTarget > this._spin ? 0.35 : 1.0, dt);
      this._diskA = damp(this._diskA, diskTarget, diskTarget > this._diskA ? 0.35 : 1.0, dt);
      const bRate = beaconTarget > this._beacon ? 1 / BEACON_IN : -1 / BEACON_OUT;
      this._beacon = clamp(this._beacon + bRate * dt, 0, 1);
      if (Math.abs(this._spin - spinTarget) > 0.01 || Math.abs(this._diskA - diskTarget) > 0.005) hint = 2;
      if (this._beacon > 0 && this._beacon < 1) hint = 2;
      if (Math.abs(this._idle - idleTarget) > 0.002) hint = Math.max(hint, 1);
    }

    const act = this._act;
    const idleS = Math.pow(smoothstep(0, 1, this._idle), 0.7); // ART_DIRECTION §3.1 idle curve
    const idleLum = lerp(1, 0.5, idleS);                          // cools, never fades to black (Gate 1 review)
    const alive = 1 - idleS;                                     // dead (DATA_SPEC §3.5): no animation at all

    // ---- crash collapse ----------------------------------------------------
    if (crashedMode) {
      if (!this._crashed) {
        this._crashed = true;
        // Loading straight into a crash shows the remnant, not the animation.
        this._crashAge = first ? CRASH_TOTAL + 1 : 0;
      } else {
        this._crashAge += dt;
      }
      if (Number.isFinite(state.endedAt)) this._crashAge = Math.max(this._crashAge, now - state.endedAt);
    } else if (this._crashed) {
      this._crashed = false;
      this._crashAge = 0;
    }
    const ca = this._crashed ? this._crashAge : -1;
    const implode = ca < 0 ? 0 : ease.inCubic(clamp(ca / CRASH_IMPLODE, 0, 1));
    this._crashScale = lerp(1, REMNANT_RADIUS, implode);
    const flashK = ca >= CRASH_IMPLODE && ca < CRASH_IMPLODE + CRASH_FLASH
      ? 1 - (ca - CRASH_IMPLODE) / CRASH_FLASH : 0;
    const shellP = ca < CRASH_IMPLODE ? 0 : ease.outCubic(clamp((ca - CRASH_IMPLODE) / (CRASH_TOTAL - CRASH_IMPLODE), 0, 1));
    const remnant = ca < 0 ? 0 : smoothstep(CRASH_IMPLODE - 0.3, CRASH_TOTAL, ca);
    if (ca >= 0 && ca < CRASH_TOTAL + 0.1) hint = 2;

    // ---- quasar state machine ---------------------------------------------
    const qWant = needs;
    if (qWant && (this._qPhase === 'off' || this._qPhase === 'rel')) {
      if (first) { this._qPhase = 'on'; this._jet = 1; this._halo = 1; }
      else { this._qPhase = 'ign'; this._qT = 0; this._jet0 = this._jet; this._halo0 = this._halo; }
      this._qClock = 0;
    } else if (!qWant && (this._qPhase === 'ign' || this._qPhase === 'on')) {
      this._qPhase = 'rel';
      this._qT = 0;
      this._jet0 = this._jet;
      this._halo0 = this._halo;
    }
    let haloFlash = 0;
    if (this._qPhase === 'ign') {
      this._qT += dt;
      const qt = this._qT;
      this._halo = Math.max(this._halo0, clamp(qt / Q_FLASH, 0, 1));
      // Flash overshoot during the 0.35 s ignition, settling over the next 0.5 s.
      haloFlash = qt < Q_FLASH ? qt / Q_FLASH : Math.max(0, 1 - (qt - Q_FLASH) / 0.5);
      const e = qt < Q_FLASH ? 0 : ease.outExpo(clamp((qt - Q_FLASH) / Q_EXTEND, 0, 1));
      this._jet = Math.max(this._jet0, e);
      if (qt >= Q_FLASH + Q_EXTEND + 0.5) this._qPhase = 'on';
      hint = 2;
    } else if (this._qPhase === 'on') {
      this._jet = 1;
      this._halo = 1;
      hint = Math.max(hint, 1);
    } else if (this._qPhase === 'rel') {
      this._qT += dt;
      const qt = this._qT;
      this._jet = this._jet0 * (1 - ease.inOutCubic(clamp(qt / Q_RETRACT, 0, 1)));
      this._halo = this._halo0 * (1 - clamp(qt / Q_HALO_OUT, 0, 1));
      if (qt >= Q_RETRACT) { this._qPhase = 'off'; this._jet = 0; this._halo = 0; }
      hint = 2;
    }
    if (this._qPhase !== 'off') this._qClock += dt;
    const pulse = Math.pow(0.5 + 0.5 * Math.sin((2 * Math.PI * this._qClock) / PULSE_PERIOD), 4);
    // A knot leaves the base at every pulse crest and travels 6 u/s; spacing 14.4 > 14, so one at a time.
    const sinceCrest = this._qClock - PULSE_CREST;
    const knotY = sinceCrest >= 0 ? JET_Y0 + KNOT_SPEED * (sinceCrest % PULSE_PERIOD) : -1;

    // ---- birth ------------------------------------------------------------
    const b = this._birth;
    this._birthScale = Math.max(1e-3, b * b * (3 - 2 * b));
    const fade = clamp(b * 1.6, 0, 1);
    this.body.scale.setScalar(this._birthScale);

    // ---- phases -----------------------------------------------------------
    const turb = lerp(0.2, 1.0, act) * alive * (1 - remnant);
    this._flow = (this._flow + dt * turb) % 4096;
    this._rot = (this._rot + dt * 0.04 * alive * (1 - remnant)) % (Math.PI * 2);
    this._motionRate = alive * (1 - remnant);
    this._coronaFlow = (this._coronaFlow + dt * lerp(0.4, 1.0, act) * this._motionRate) % 4096;
    this._diskPhase += dt * this._spin;
    if (this._diskPhase > 6 * 4096) this._diskPhase -= 6 * 4096; // whole number of shear cycles: seamless

    // ---- surface ----------------------------------------------------------
    const base = starColor(Math.min(this._fill, 1), this._col);
    const baseLum = Math.max(lumOf(base), 1e-4);
    // A filling context burns redder and lower: crimson at luminance 2 would tone-map to pale pink.
    const fillDim = lerp(1, 0.6, smoothstep(0.6, 1, this._fill));
    // A quasar outshines its host: the photosphere drops to half under the halo,
    // so its blue-white light doesn't pull the orange toward pink.
    const surfPeak = L_SURFACE * (0.7 + 0.3 * act) * idleLum * fillDim * (1 - 0.5 * this._halo);
    const su = this.surfaceMat.uniforms;
    su.uColor.value.set(base.r, base.g, base.b);
    setUnit(su.uSat.value, saturateOklab(base, 1.7, this._sat));
    setUnit(su.uSatDeep.value, saturateOklab(base, 2.2, this._sat));
    // ~1.15 headroom: whitened cell tops + supergranule crest sit above the mean.
    su.uGain.value = surfPeak / Math.max(baseLum, 0.3) / 1.15;
    su.uFlow.value = this._flow;
    su.uRot.value = this._rot;
    su.uDesat.value = 0.3 * idleS;
    su.uDead.value = idleS;
    su.uStorm.value = this._storm * (1 - remnant);
    su.uRemnant.value = remnant;
    su.uFlash.value = flashK * L_FLASH * 0.5;
    su.uFade.value = fade;
    this.surface.scale.setScalar(this._crashScale);
    this.surface.visible = fade > 0.002;

    // ---- glow: corona + quasar + crash ------------------------------------
    const overflow = clamp(this._fill - 1, 0, 1);
    const k = lerp(4.6, 2.4, act) * (1 + 0.8 * overflow) + 1.6 * idleS;
    // The quasar halo replaces most of the corona (its star-colored light would desaturate the orange).
    const coronaL = L_CORONA * (0.7 + 0.3 * act) * lerp(1, 0.55, idleS) * (1 - remnant) * (1 - 0.8 * this._halo);
    const gu = this.glowMat.uniforms;
    gu.uRadius.value = this._crashScale;
    gu.uFlow.value = this._coronaFlow;
    gu.uStorm.value = this._storm;
    if (this._storm > 0.001) {
      // Storm churn of the streamer field: smooth incommensurate sines on the
      // corona clock, so it churns rather than strobes (only the quasar pulses).
      const j = 0.35 * this._storm;
      const f = this._coronaFlow;
      gu.uJitter.value.set(j * Math.sin(f * 1.3), j * Math.sin(f * 1.7 + 2), j * Math.sin(f * 2.3 + 4));
    } else {
      gu.uJitter.value.set(0, 0, 0);
    }
    gu.uCoronaL.value = coronaL;
    gu.uCoronaK.value = k;
    // Corona: the full star color, pre-saturated ×1.4 in OKLab (ACES greys dim
    // colors), in unit luminance. At ≤ 1.1 it is low enough for the fill hue to survive.
    setUnit(gu.uCoronaCol.value, saturateOklab(base, 1.4, this._sat));

    const qCore = (L_QCORE_TROUGH + L_QCORE_SWING * pulse) * this._halo;
    const qHalo = (0.6 + 0.35 * pulse) * this._halo + 2.0 * haloFlash; // compact halo: the core and jets carry the pulse
    gu.uQ.value = this._halo;
    gu.uQCoreL.value = qCore;
    gu.uQHaloL.value = qHalo;
    gu.uFlashL.value = flashK * L_FLASH;
    gu.uRem.value = remnant;
    gu.uShellR.value = SHELL_RADIUS * shellP;
    gu.uShellL.value = ca < 0 ? 0 : lerp(0.7, 0.02, shellP);
    gu.uFade.value = fade;
    // Size the quad to what is actually lit, so fragments are not wasted.
    let ext = 1.3 * this._crashScale;
    if (coronaL > 0.001) ext = Math.max(ext, this._crashScale * (1 + 6.5 / k));
    if (this._halo > 0.001) ext = Math.max(ext, 6);
    if (ca >= 0) ext = Math.max(ext, SHELL_RADIUS * shellP + 1.2, 1.0);
    gu.uExtent.value = ext;
    gu.uPush.value = 1.1 * this._crashScale;
    this.glow.visible = fade > 0.002 && (coronaL > 0.001 || this._halo > 0.001 || ca >= 0);

    // ---- disk -------------------------------------------------------------
    const du = this.diskMat.uniforms;
    const diskA = this._diskA * (1 - 0.8 * idleS) * (1 - implode);
    du.uPhase.value = this._diskPhase;
    du.uAlpha.value = diskA;
    du.uDesat.value = 0.7 * idleS;
    du.uFade.value = fade;
    this.disk.visible = diskA * fade > 0.002;

    // ---- jets -------------------------------------------------------------
    const jetsOn = this._jet > 0.002;
    this.jetSheath.visible = jetsOn;
    this.jetSpine.visible = jetsOn;
    if (jetsOn) {
      const jetPulse = 0.8 + 0.3 * pulse;
      for (let i = 0; i < 2; i++) {
        const m = i === 0 ? this.jetSheath : this.jetSpine;
        const u = m.material.uniforms;
        const ext = JET_Y0 + this._jet * (JET_LEN - JET_Y0);
        u.uExt.value = ext;
        u.uTime.value = this._qClock;
        u.uKnotY.value = knotY >= 0 && knotY <= ext ? knotY : -1;
        u.uGain.value = this._jetBaseGain[i] * jetPulse;
      }
    }

    // ---- beacon -----------------------------------------------------------
    // Fades out with idle decay: a day-old my-move ends as the same still ember as idle.
    const bAmt = this._beacon * (1 - idleS) * fade;
    this.beacon.visible = bAmt > 0.002;
    if (this.beacon.visible) {
      this._sweep = (this._sweep + (dt / BEACON_SWEEP) * this._motionRate) % 1;
      this.beaconMat.uniforms.uSweep.value = this._sweep;
      this.beaconMat.uniforms.uAmt.value = bAmt;
      // Face the camera: local rotation = parentWorld⁻¹ · cameraWorld.
      const cam = this.ctx?.camera;
      if (cam) {
        this.body.getWorldQuaternion(this._qa).invert();
        cam.getWorldQuaternion(this._qb);
        this.beacon.quaternion.copy(this._qa.multiply(this._qb));
      }
      if (idleS < 0.6) hint = Math.max(hint, 1);
    }

    // ---- shards -----------------------------------------------------------
    this.shards.visible = ca >= CRASH_IMPLODE;
    if (this.shards.visible) {
      this.shardMat.uniforms.uShell.value = SHELL_RADIUS * shellP;
      this.shardMat.uniforms.uGlow.value = 1 + 4 * (1 - shellP);
    }

    // ---- ambient rate -----------------------------------------------------
    if (working && (act > 0.02 || this._spin > 0.02)) hint = 2;
    else if (thinking || needs) hint = Math.max(hint, 1);
    // Idle-ish stars only ask for 30 fps while their idle damping still moves
    // (checked above); once settled they drift slowly enough for 10 fps.
    else if (!crashedMode && !idleish && idleS < 0.6) hint = Math.max(hint, 1);
    if (this._storm > 0.001) hint = 2;

    // ---- QA luminance -----------------------------------------------------
    const remL = remnant > 0 ? L_REMNANT * remnant : 0;
    this._lum = Math.max(
      surfPeak * (1 - remnant) * fade,
      coronaL * fade,
      qCore * fade,
      flashK * L_FLASH,
      remL,
    );

    return hint;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const m of [this.surface, this.glow, this.disk, this.jetSheath, this.jetSpine, this.beacon, this.shards]) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
