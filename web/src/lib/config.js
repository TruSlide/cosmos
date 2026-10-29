// Cosmos tunables shared by the renderer and (later) the data layer.
//
// One source of truth: anything that both draws a thing and counts it (HUD
// totals, the data layer) reads it from here. The settings panel will later
// overlay cosmos/settings.json on these defaults; until then they are fixed.

/**
 * Flare storm rule (DECISIONS.md, 2026-10-29): a storm starts when
 * `count` tool errors land within `windowS` seconds of each other, holds until
 * `holdS` after the last error, then decays over `decayS`. At real tool-call
 * cadence (a few seconds per call) 3 errors in 20 s is effectively "3 failures
 * in a row", so the rule needs nothing beyond errors[] timestamps.
 */
export const STORM = Object.freeze({
  count: 3,
  windowS: 20,
  holdS: 10,
  decayS: 2,
});
