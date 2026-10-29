export const SCHEMA_VERSION = 1;

// Session state (rec.state.mode). 'dead' and 'crashed' are terminal-looking but
// any new activity revives the session.
export const MODE = Object.freeze({
  NEEDS_ME: 'needs-me', MY_MOVE: 'my-move', WORKING: 'working',
  IDLE: 'idle', DEAD: 'dead', CRASHED: 'crashed',
});
// rec.state.sub, by mode:
//   needs-me: 'approve' | 'question' | 'plan'
//   working:  'generating' | 'tool' | 'retrying'
//   others:   null
export const SUB = Object.freeze({
  APPROVE: 'approve', QUESTION: 'question', PLAN: 'plan',
  GENERATING: 'generating', TOOL: 'tool', RETRYING: 'retrying',
});
// rec.state.badges (any subset)
export const BADGE = Object.freeze({
  STALLED: 'stalled',            // busy, nothing new for timeouts.stalledS
  AMBIGUOUS: 'ambiguous',        // tool_use pending > ambiguousS, no registry file
  UNVERIFIED: 'unverified',      // needs-me from S5 'waiting' (DATA_SPEC §9.1 not yet confirmed)
  DIALOG: 'dialog',              // S5 waitingFor 'dialog open' (shown as my-move)
  ASKED_IN_TEXT: 'asked-in-text',// S6 postTurnSummary blocked/needs_action (my-move only)
  SHIPS_OUT: 'ships-out',        // my-move while a ship is still active
  NO_REGISTRY: 'no-registry',    // live-ness inferred from transcript only
});
// rec.state.remnant: why a non-live session looks the way it does
export const REMNANT = Object.freeze({
  ENDED: 'ended',                // clean exit (decays normally)
  ARCHIVED: 'archived',
  CRASHED: 'crashed', CRASHED_API: 'crashed-api',
  DELETED: 'deleted',            // S6 deleted marker / desktop-released (husk)
  AGED_OUT: 'aged-out',          // cache only, transcript gone (husk)
});
export const ORIGIN = Object.freeze({
  OWNER: 'owner', PEER: 'peer', SDK: 'sdk', SCHEDULED: 'scheduled', FORK: 'fork',
});
// Event types (§2.2). The string values are the wire and log format.
export const EV = Object.freeze({
  BORN: 'born',
  NEEDS_ME_START: 'needs-me-start', NEEDS_ME_END: 'needs-me-end',
  MY_MOVE: 'my-move', WORKING: 'working',
  TOOL_CALL: 'tool-call', FILE_TOUCH: 'file-touch',
  SUBAGENT_OUT: 'subagent-out', SUBAGENT_BACK: 'subagent-back',
  ERROR: 'error', STORM_START: 'storm-start', STORM_END: 'storm-end',
  COMPACTION: 'compaction',
  CRASHED: 'crashed', IDLE: 'idle', DEAD: 'dead',
  ARCHIVED: 'archived', DELETED: 'deleted',
  METRICS: 'metrics',            // periodic numbers sample for history (not shown in the feed)
});
// Events that open Analysis & Diagnostic when clicked.
export const DIAG_TYPES = Object.freeze(new Set([
  'error', 'storm-start', 'compaction', 'crashed', 'needs-me-start', 'subagent-back',
]));
// Events listed in the Activity feed (METRICS, WORKING, MY_MOVE excluded by default).
export const FEED_TYPES = Object.freeze(new Set([
  'born', 'needs-me-start', 'needs-me-end', 'tool-call', 'file-touch', 'subagent-out',
  'subagent-back', 'error', 'storm-start', 'storm-end', 'compaction', 'crashed',
  'idle', 'dead', 'archived', 'deleted',
]));

export const DAY_S = 86400;

/** Stable event id: survives restarts so diag links and the log dedupe work. */
export function eventId(type, sid, key) { return `${type}:${sid}:${key}`; }

/** Brightness fraction lost to idle: 0 fresh … 1 dead. DATA_SPEC §3.5.
 *  t = seconds since lastActivity, k = rec.idle.k, T = settings idle.hours*3600. */
export function idleFraction(t, k, T = DAY_S) {
  if (!(t > 0)) return 0;
  const x = Math.min(1, t / T);
  return 1 - Math.pow(1 - x, k);
}
/** Decay exponent from A = assistant messages in the final active hour. */
export function idleK(A, cfg = { kMin: 0.5, kMax: 1.6, kSlope: 0.35 }) {
  const k = cfg.kMax - cfg.kSlope * Math.log10(1 + Math.max(0, A));
  return Math.min(cfg.kMax, Math.max(cfg.kMin, k));
}
/** Sort key for "Live sessions" and cycling: lower = more urgent. */
export function urgencyRank(rec, nowS) {
  const m = rec.state.mode;
  if (m === 'needs-me') return 0 - Math.min(0.999, (nowS - rec.state.since) / 1e6); // longest wait first
  if (m === 'working')  return 1 + (rec.state.badges.includes('stalled') ? 0 : 0.5);
  if (m === 'my-move')  return 2 + Math.min(0.999, (nowS - rec.state.since) / 1e6);   // most recent first
  if (m === 'idle')     return 3 + rec.state.idleFor * 0.999;
  if (m === 'crashed')  return 4;
  return 5;                                                                          // dead
}
/** Map rec.state.sub (needs-me) to SystemState.needsKind. */
export const NEEDS_KIND = Object.freeze({ approve: 'permission', question: 'question', plan: 'plan' });
