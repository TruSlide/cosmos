// Star tuning constants, shared by star.js and star-shaders.js.
// See star.js's header for the brightness ladder these values follow.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants (units: star radii, seconds, linear luminance)
// ---------------------------------------------------------------------------

export const DISK_IN = 1.4;
export const DISK_OUT = 3.2;
export const DISK_TILT = THREE.MathUtils.degToRad(12);
export const DISK_GHOST = 0.08;             // alpha the disk keeps once the session stops working

export const JET_LEN = 14;
export const JET_Y0 = 1.04;                 // jets leave the photosphere at the poles (hourglass waist)
export const JET_PROFILE = 1.15;            // r ∝ s^1.15: a near-straight cone, pinched at the pole, flaring slightly at the tip
export const PULSE_PERIOD = 2.4;            // s, the only periodic brightness in the universe
export const PULSE_CREST = PULSE_PERIOD / 4; // sin(2πt/P) peaks at t = P/4
export const KNOT_SPEED = 6;                // u/s, one knot fired per crest
export const Q_FLASH = 0.35;                // ignition: halo flash-in
export const Q_EXTEND = 0.6;                // ignition: jets 0 → 14 (ease-out-expo)
export const Q_RETRACT = 1.2;               // release: jets retract
export const Q_HALO_OUT = 1.0;              // release: halo fade

export const BEACON_RADIUS = 1.9;
export const BEACON_TUBE = 0.025;
export const BEACON_SWEEP = 12;             // s per revolution of the 30° radar arc
export const BEACON_IN = 1.5;
export const BEACON_OUT = 0.8;

export const L_SURFACE = 2.0;               // working surface peak. Ladder cap is 6; above ~3 ACES flattens granulation to white, so we sit lower
export const L_CORONA = 1.1;               // ladder cap 3
export const L_QCORE_TROUGH = 14;
export const L_QCORE_SWING = 16;            // 14 + 16 = 30 at the crest
export const L_JET = 0.95;                  // spine; at the bloom threshold so the hourglass stays crisp (a knot lifts it to ~2.3 and blooms)
export const L_JET_SHEATH = 0.5;            // cone walls; below the bloom threshold so the lobes keep their edges
export const L_BEACON = 2.5;
export const L_REMNANT = 0.35;
export const L_FLASH = 4;

export const CRASH_IMPLODE = 1.6;           // radius 1 → 0.22, ease-in-cubic
export const CRASH_FLASH = 0.2;
export const CRASH_TOTAL = 2.5;             // shell 0 → 4 runs from implode end to here
export const REMNANT_RADIUS = 0.22;
export const SHELL_RADIUS = 4;
export const SHARD_COUNT = 40;
