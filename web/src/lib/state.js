// SystemState validation (CONTRACT §2). Pure: no module state.
//
// normalizeState(raw, out?) checks the required fields, fills defaults for the
// optional ones and clamps ranges. With `out` it writes into that object
// (StarSystem passes a scratch object so the frame loop allocates nothing);
// without it a new object is returned. Arrays are passed through by reference.

export const MODES = Object.freeze(['needs-me', 'my-move', 'working', 'thinking', 'idle', 'crashed']);
const MODE_SET = new Set(MODES);
const NEEDS_KINDS = new Set(['permission', 'question', 'plan']);
const EMPTY = Object.freeze([]);

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function normalizeState(raw, out = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('SystemState: expected an object');
  if (raw.v !== 1) throw new TypeError(`SystemState: unsupported schema version ${raw.v} (expected 1)`);
  if (raw.id == null || raw.id === '') throw new TypeError('SystemState: missing required field "id"');
  if (!finite(raw.now)) throw new TypeError('SystemState: "now" must be a finite number (epoch seconds)');
  if (!MODE_SET.has(raw.mode)) throw new TypeError(`SystemState: invalid "mode" ${JSON.stringify(raw.mode)}`);
  if (!finite(raw.idleFor)) throw new TypeError('SystemState: "idleFor" must be a number 0..1');
  if (!finite(raw.activity)) throw new TypeError('SystemState: "activity" must be a number 0..1');
  if (!finite(raw.contextFill)) throw new TypeError('SystemState: "contextFill" must be a number ≥ 0');
  if (!raw.tokens || !finite(raw.tokens.total)) throw new TypeError('SystemState: "tokens.total" must be a number');

  out.v = 1;
  out.id = String(raw.id);
  out.now = raw.now;
  out.mode = raw.mode;
  out.needsKind = raw.mode === 'needs-me' && NEEDS_KINDS.has(raw.needsKind) ? raw.needsKind : null;
  out.idleFor = clamp01(raw.idleFor);
  out.activity = clamp01(raw.activity);
  out.contextFill = Math.min(2, Math.max(0, raw.contextFill));
  out.contextLimit = finite(raw.contextLimit) ? raw.contextLimit : null;
  out.tokens = raw.tokens;
  out.bornAt = finite(raw.bornAt) ? raw.bornAt : null;
  out.endedAt = finite(raw.endedAt) ? raw.endedAt : null;
  out.title = raw.title ?? null;
  out.project = raw.project ?? null;
  out.model = raw.model ?? null;
  out.compactions = Array.isArray(raw.compactions) ? raw.compactions : EMPTY;
  out.errors = Array.isArray(raw.errors) ? raw.errors : EMPTY;
  out.toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : EMPTY;
  out.subagents = Array.isArray(raw.subagents) ? raw.subagents : EMPTY;
  out.files = Array.isArray(raw.files) ? raw.files : EMPTY;
  // Fate (owner, 2026-11-08): 'dying' sessions break apart over their death
  // cycle (deathPhase 0..1, restarting daily once dead); 'flourish' sessions
  // (archived or closed cleanly) become lush, calm systems. null: neither.
  out.fate = raw.fate === 'dying' || raw.fate === 'flourish' ? raw.fate : null;
  out.deathPhase = out.fate === 'dying' && finite(raw.deathPhase) ? clamp01(raw.deathPhase) : 0;
  return out;
}
