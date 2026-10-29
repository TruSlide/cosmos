// Cosmos: pure event reducer (GALAXY_CONTRACT §2.5).
//
// Shared by the server (HistoryBundle `base`, store.mjs) and the client
// (history scrubber, web/src/galaxy/store.js). No three, no DOM, no Node
// built-ins, no module-level mutable state.
//
// A folded record is a SessionRecordLite (§2.1) rebuilt from the event log
// alone. Fields the log does not carry stay null (title falls back to the sid
// prefix; the client overlays identity fields from the live record when it has
// one). Re-emits (same id, a field resolved later) are recognised through a
// small bounded id list in `rec._fold`, so counts are not doubled; liteRecord
// and the client strip `_fold` before anything is shown.

import { MODE, REMNANT, EV, DAY_S, idleFraction } from './schema.mjs';

const SEEN_MAX = 256;
const FILES_MAX = 24;
const SHIP_EVENTS = new Set([EV.SUBAGENT_OUT, EV.SUBAGENT_BACK]);
const ACTIVITY_EVENTS = new Set([
  EV.NEEDS_ME_START, EV.NEEDS_ME_END, EV.MY_MOVE, EV.WORKING, EV.TOOL_CALL, EV.FILE_TOUCH,
  EV.SUBAGENT_OUT, EV.SUBAGENT_BACK, EV.ERROR, EV.COMPACTION, EV.STORM_START,
]);

function armFrom(key) {
  if (!key || typeof key !== 'string') return { key: null, name: null };
  const parts = key.split('/').filter(Boolean);
  return { key, name: parts[parts.length - 1] || key };
}

/** New empty lite record for a 'born' event. */
export function recordFromBorn(ev) {
  const d = ev.data || {};
  const sid = ev.sid;
  return {
    v: 1, id: sid, title: String(sid).slice(0, 8), titleSource: 'sid',
    origin: d.origin ?? null, forkOf: d.forkOf ?? null, spawnedFrom: null,
    entrypoint: d.entrypoint ?? null,
    arm: typeof d.arm === 'object' && d.arm ? { key: d.arm.key ?? null, name: d.arm.name ?? null } : armFrom(d.arm),
    worktree: d.worktree ?? null, cwd: null, place: null,
    model: null, models: [], live: true, cacheOnly: false,
    times: { bornAt: ev.t, lastActivity: ev.t, endedAt: null },
    state: { mode: MODE.WORKING, sub: 'generating', badges: [], remnant: null, since: ev.t, tool: null, target: null, idleFor: 0, k: 1 },
    asOf: ev.t, activity: 0,
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, today: 0 },
    context: { fill: 0, used: 0, limit: null, peak: 0, model: null },
    counts: { turns: 0, toolCalls: 0, errors: 0, denials: 0, apiErrors: 0, storms: 0, compactions: 0, ships: 0, errorsToday: 0 },
    storm: null, compactions: [], ships: [], files: [], folders: [],
    filesTotal: 0, foldersTotal: 0,
    _fold: { seen: [] },
  };
}

function seenBefore(rec, id) {
  const f = rec._fold || (rec._fold = { seen: [] });
  if (f.seen.includes(id)) return true;
  f.seen.push(id);
  if (f.seen.length > SEEN_MAX) f.seen.splice(0, f.seen.length - SEEN_MAX);
  return false;
}

function setMode(rec, mode, sub, t, extra) {
  const st = rec.state;
  if (st.mode !== mode || st.sub !== (sub ?? null)) st.since = t;
  st.mode = mode;
  st.sub = sub ?? null;
  st.badges = extra?.badges ? extra.badges.slice() : [];
  st.tool = extra?.tool ?? null;
  st.target = extra?.target ?? null;
  if (mode === MODE.NEEDS_ME || mode === MODE.WORKING || mode === MODE.MY_MOVE) {
    st.remnant = null;
    rec.live = true;
    rec.times.endedAt = null;
  }
}

function folderRows(rec) {
  const m = new Map();
  for (const f of rec.files) {
    let d = m.get(f.folder);
    if (!d) { d = { id: f.folder, path: String(f.folder || '').replace(/^d:/, ''), edits: 0, reads: 0, files: 0, lastT: 0 }; m.set(f.folder, d); }
    d.edits += f.edits || 0; d.reads += f.reads || 0; d.files++; d.lastT = Math.max(d.lastT, f.lastT || 0);
  }
  return [...m.values()].sort((a, b) => (b.edits + b.reads) - (a.edits + a.reads) || b.lastT - a.lastT);
}

function sortFiles(rec) {
  rec.files.sort((a, b) => (b.edits + b.reads) - (a.edits + a.reads) || b.lastT - a.lastT);
  if (rec.files.length > FILES_MAX * 4) rec.files.length = FILES_MAX * 4;
  rec.filesTotal = rec.files.length;
  rec.folders = folderRows(rec);
  rec.foldersTotal = rec.folders.length;
}

/** Apply one event (in time order) to a record; mutates and returns `rec`. */
export function applyEvent(rec, ev, settings) {
  if (!rec || !ev) return rec;
  const d = ev.data || {};
  const t = ev.t;
  if (ACTIVITY_EVENTS.has(ev.type) && typeof t === 'number' && t > rec.times.lastActivity) rec.times.lastActivity = t;
  if (typeof t === 'number' && t > rec.asOf) rec.asOf = t;

  switch (ev.type) {
    case EV.BORN: {
      if (d.origin != null) rec.origin = d.origin;
      if (d.entrypoint != null) rec.entrypoint = d.entrypoint;
      if (d.forkOf != null) rec.forkOf = d.forkOf;
      if (d.worktree != null) rec.worktree = d.worktree;
      if (d.arm) rec.arm = typeof d.arm === 'object' ? { key: d.arm.key ?? null, name: d.arm.name ?? null } : armFrom(d.arm);
      if (typeof t === 'number') rec.times.bornAt = Math.min(rec.times.bornAt ?? t, t);
      break;
    }
    case EV.NEEDS_ME_START:
      setMode(rec, MODE.NEEDS_ME, d.sub ?? null, t, { tool: d.tool ?? null });
      rec.state.since = t;
      break;
    case EV.NEEDS_ME_END:
      if (rec.state.mode === MODE.NEEDS_ME) {
        if (d.how === 'answered') setMode(rec, MODE.WORKING, 'generating', t);
        else setMode(rec, MODE.MY_MOVE, null, t);
      }
      break;
    case EV.MY_MOVE:
      setMode(rec, MODE.MY_MOVE, null, t, { badges: d.badges || [] });
      break;
    case EV.WORKING:
      setMode(rec, MODE.WORKING, d.sub ?? 'generating', t, { tool: d.tool ?? null });
      break;
    case EV.TOOL_CALL: {
      if (!seenBefore(rec, ev.id)) rec.counts.toolCalls++;
      if (rec.state.mode === MODE.WORKING && !ev.ship) {
        rec.state.sub = 'tool';
        rec.state.tool = d.tool ?? null;
        rec.state.target = typeof d.target === 'string' ? d.target.replace(/^f:/, '') : null;
      }
      break;
    }
    case EV.FILE_TOUCH: {
      if (seenBefore(rec, ev.id)) break;
      const id = d.fileId;
      if (!id) break;
      let f = rec.files.find((x) => x.id === id);
      if (!f) { f = { id, path: d.path ?? id.replace(/^f:/, ''), folder: d.folder ?? null, edits: 0, reads: 0, lastT: 0, plan: !!d.plan }; rec.files.push(f); }
      if (d.op === 'read') f.reads++; else f.edits++;
      f.lastT = Math.max(f.lastT, t || 0);
      sortFiles(rec);
      break;
    }
    case EV.SUBAGENT_OUT: {
      const id = d.agentId || ev.ship;
      let sh = rec.ships.find((x) => x.id === id);
      if (!sh) {
        sh = { id, t, endT: null, type: d.type ?? null, label: d.label ?? 'subagent', model: d.model ?? null, tokens: 0, active: true, toolUseId: d.toolUseId ?? null, depth: d.depth ?? null, workflowPhase: null };
        rec.ships.push(sh);
        rec.counts.ships = rec.ships.length;
      } else {
        sh.type = d.type ?? sh.type; sh.label = d.label ?? sh.label; sh.model = d.model ?? sh.model;
      }
      break;
    }
    case EV.SUBAGENT_BACK: {
      const id = d.agentId || ev.ship;
      const sh = rec.ships.find((x) => x.id === id);
      if (sh) { sh.endT = t; sh.active = false; if (typeof d.tokens === 'number') sh.tokens = d.tokens; }
      break;
    }
    case EV.ERROR: {
      if (seenBefore(rec, ev.id)) break;
      if (d.kind === 'api') rec.counts.apiErrors++;
      else {
        rec.counts.errors++;
        if (d.kind === 'denial') rec.counts.denials++;
      }
      if (rec.storm && d.kind !== 'api') { rec.storm.lastErrorT = t; rec.storm.count++; }
      break;
    }
    case EV.STORM_START:
      if (!seenBefore(rec, ev.id)) rec.counts.storms++;
      rec.storm = { since: t, lastErrorT: t, count: d.count ?? 0 };
      break;
    case EV.STORM_END:
      rec.storm = null;
      break;
    case EV.COMPACTION: {
      if (ev.ship) break; // subagent compactions are events only (model rule)
      const id = String(ev.id).split(':').pop();
      if (!rec.compactions.some((c) => c.id === id)) {
        rec.compactions.push({ id, t, trigger: d.trigger ?? null, preTokens: d.preTokens ?? 0, postTokens: d.postTokens ?? 0, durationMs: d.durationMs ?? 0 });
        rec.counts.compactions = rec.compactions.length;
      }
      break;
    }
    case EV.CRASHED:
      setMode(rec, MODE.CRASHED, null, t);
      rec.state.remnant = d.reason === 'api-error' ? REMNANT.CRASHED_API : REMNANT.CRASHED;
      rec.live = false;
      rec.times.endedAt = rec.times.lastActivity;
      break;
    case EV.IDLE:
      if (typeof d.lastActivity === 'number') rec.times.lastActivity = d.lastActivity;
      if (typeof d.k === 'number') rec.state.k = d.k;
      setMode(rec, MODE.IDLE, null, t);
      break;
    case EV.DEAD:
      if (typeof d.lastActivity === 'number') rec.times.lastActivity = d.lastActivity;
      setMode(rec, MODE.DEAD, null, t);
      rec.state.idleFor = 1;
      break;
    case EV.ARCHIVED:
      rec.state.remnant = REMNANT.ARCHIVED;
      rec.live = false;
      rec.times.endedAt = rec.times.lastActivity;
      break;
    case EV.DELETED:
      rec.state.remnant = REMNANT.DELETED;
      rec.live = false;
      rec.times.endedAt = rec.times.lastActivity;
      break;
    case EV.METRICS: {
      if (d.tokens) {
        rec.tokens.input = d.tokens.input ?? rec.tokens.input;
        rec.tokens.output = d.tokens.output ?? rec.tokens.output;
        rec.tokens.cacheCreate = d.tokens.cacheCreate ?? rec.tokens.cacheCreate;
        rec.tokens.cacheRead = d.tokens.cacheRead ?? rec.tokens.cacheRead;
        rec.tokens.total = d.tokens.total ?? (rec.tokens.input + rec.tokens.output + rec.tokens.cacheCreate);
      }
      if (typeof d.contextFill === 'number') rec.context.fill = d.contextFill;
      if (typeof d.contextUsed === 'number') { rec.context.used = d.contextUsed; rec.context.peak = Math.max(rec.context.peak || 0, d.contextUsed); }
      if (typeof d.contextLimit === 'number') rec.context.limit = d.contextLimit;
      if (typeof d.activity === 'number') rec.activity = d.activity;
      if (typeof d.k === 'number') rec.state.k = d.k;
      if (d.mode && d.mode !== rec.state.mode) {
        setMode(rec, d.mode, d.sub ?? null, t, { badges: d.badges || [] });
      } else if (d.mode && Array.isArray(d.badges)) {
        rec.state.badges = d.badges.slice();
      }
      if (Array.isArray(d.files)) {
        rec.files = d.files.map((f) => ({ ...f }));
        sortFiles(rec);
      }
      break;
    }
    default:
      break;
  }
  if (SHIP_EVENTS.has(ev.type)) {
    let active = 0;
    for (const s of rec.ships) if (s.active) active++;
    if (active && rec.state.mode === MODE.MY_MOVE && !rec.state.badges.includes('ships-out')) rec.state.badges.push('ships-out');
  }
  void settings;
  return rec;
}

/** Recompute time-dependent fields (state.idleFor, dead transition) at data-clock `nowS`. */
export function advance(rec, nowS, settings) {
  if (!rec || !rec.state) return rec;
  const idle = settings?.idle || {};
  const T = (idle.hours > 0 ? idle.hours : 24) * 3600 || DAY_S;
  const st = rec.state;
  const la = rec.times?.lastActivity ?? nowS;
  const quiet = Math.max(0, nowS - la);
  const k = typeof st.k === 'number' && st.k > 0 ? st.k : 1;
  if (st.mode === MODE.MY_MOVE || st.mode === MODE.IDLE) {
    st.idleFor = idleFraction(quiet, k, T);
    if (quiet >= T) { st.mode = MODE.DEAD; st.sub = null; st.since = la + T; st.idleFor = 1; }
  } else if (st.mode === MODE.DEAD) {
    st.idleFor = 1;
  } else {
    st.idleFor = 0;
  }
  // Ships quiet for long are done (timeouts.shipDoneS), so a replay doesn't keep them out forever.
  const doneS = settings?.timeouts?.shipDoneS ?? 240;
  for (const sh of rec.ships || []) if (sh.active && nowS - (sh.t || 0) > doneS * 30) { sh.active = false; sh.endT = sh.endT ?? sh.t; }
  rec.asOf = nowS;
  return rec;
}
