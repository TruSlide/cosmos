// Cosmos client store (GALAXY_CONTRACT §4). One per page; nothing else fetches.
//
// Live: GET /api/snapshot, then the SSE stream /api/events keeps sessions,
// events and totals current. History: GET /api/history, then the shared
// reducer (web/src/shared/fold.mjs) rebuilds every record at the cursor and
// the store emits the same 'session' / 'sessions' / 'event' / 'totals' /
// 'needs-me' messages as live, so the galaxy, HUD and labels need nothing
// history-specific beyond reading `store.time`. Live SSE keeps arriving while
// in history; it updates the live view silently and `exitHistory` restores it.
//
// No module-level mutable state; the token is held in this closure only.

import { MODE, EV, FEED_TYPES, DIAG_TYPES, NEEDS_KIND, idleFraction, urgencyRank, DAY_S } from '../shared/schema.mjs';
import { SETTINGS_DEFAULTS } from '../shared/settings.mjs';
import { recordFromBorn, applyEvent, advance } from '../shared/fold.mjs';

/** Death cycle: aging (storms, volcanoes, cracks) runs to this phase, then the system breaks apart. */
const AGING_END = 0.55;

const EVENTS_MAX = 500;          // history feed (rows up to the cursor)
const ROUTINE_MAX = 500;         // live tool-call / file-touch rows
const SIGNAL_MAX = 600;          // every other live feed row, capped separately
const ROUTINE = new Set([EV.TOOL_CALL, EV.FILE_TOUCH]);
const ERRORS_KEEP_S = 120;
const CALLS_KEEP_S = 30;
const SHIP_DONE_KEEP_S = 5;
const SESSION_CACHE_MS = 5000;
const KEYFRAME_S = 600;           // history keyframe every 10 min of data time
const PLAY_TICK_MS = 100;
const RETRY_MS = 3000;
const LOADING_POLL_MS = 1200;
const IDENTITY = ['title', 'titleSource', 'arm', 'place', 'cwd', 'model', 'models', 'worktree', 'spawnedFrom', 'entrypoint', 'origin', 'forkOf'];

const isFeed = (ev) => FEED_TYPES.has(ev.type) || DIAG_TYPES.has(ev.type);

/** Drop the oldest routine rows past ROUTINE_MAX and the oldest signal rows past
 *  SIGNAL_MAX, so a flood of tool calls never pushes storms, compactions,
 *  needs-me or errors out of the feed. `list` is sorted by t, oldest first. */
function trimFeed(list) {
  let r = 0, g = 0;
  for (const e of list) { if (ROUTINE.has(e.type)) r++; else g++; }
  if (r <= ROUTINE_MAX && g <= SIGNAL_MAX) return list;
  let dropR = Math.max(0, r - ROUTINE_MAX), dropG = Math.max(0, g - SIGNAL_MAX);
  return list.filter((e) => {
    if (ROUTINE.has(e.type)) { if (dropR > 0) { dropR--; return false; } return true; }
    if (dropG > 0) { dropG--; return false; }
    return true;
  });
}

/** Key part of a stable event id `${type}:${sid}:${key}`. */
function keyOf(ev) {
  const pre = `${ev.type}:${ev.sid}:`;
  return typeof ev.id === 'string' && ev.id.startsWith(pre) ? ev.id.slice(pre.length) : ev.id;
}
function folderOfTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('f:')) return target ?? null;
  const p = target.slice(2);
  const i = p.lastIndexOf('/');
  return `d:${i > 0 ? p.slice(0, i) : '.'}`;
}
/** First index with arr[i].t > t (arr sorted by t). */
function upperBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) lo = m + 1; else hi = m; }
  return lo;
}
function stripFold(rec) {
  if (!rec || !('_fold' in rec)) return rec;
  const { _fold, ...rest } = rec;
  return rest;
}
function httpError(res, body) {
  const e = new Error(body?.message || `${res.status} ${res.statusText || 'request failed'}`);
  e.status = res.status;
  e.code = body?.error || null;
  e.body = body;
  return e;
}

export function createClientStore({
  token,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  EventSourceImpl = globalThis.EventSource,
  wallClock = () => Date.now() / 1000,
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) },
} = {}) {
  // ------------------------------------------------------------ state
  const listeners = new Map();
  const live = {
    sessions: new Map(),
    events: [],
    totals: null,
    recent: new Map(),            // sid -> { errors: [], toolCalls: [] }
  };
  const hist = {
    sessions: new Map(),          // exposed (no _fold)
    fold: new Map(),              // internal folded records
    events: [],                   // all bundle events (sorted)
    feed: [],                     // FEED/DIAG events up to the cursor (last 500)
    keyframes: [],                // [{ t, idx, recs: Map }]
    idx: 0,                       // next event index to apply
    cursorApplied: -Infinity,
    totals: null,
  };
  const arms = new Map();
  const sessionCache = new Map();  // sid -> { at, promise }
  const adapterCache = new WeakMap();
  const callTwins = new WeakMap(); // toolCall -> folder-grain twin
  let serverOffset = 0;
  let settings = SETTINGS_DEFAULTS;
  let limits = null;
  let connection = 'connecting';
  let loading = { done: false, files: null, filesDone: null };
  let selection = null;
  let hovered = null;
  const time = { mode: 'live', cursor: null, speed: 1, playing: false, from: null, to: null };
  let es = null;
  let retryTimer = null;
  let loadingTimer = null;
  let playTimer = null;
  let playLast = 0;
  let disposed = false;
  let readyFired = false;
  let histSeq = 0;
  let runId = null;                // server run id; a change means the server restarted
  let cid = null;                  // this page's SSE client id (for /api/visibility)
  let restarted = false;           // the server restarted: our POST token is void
  let helloCount = 0;

  const inHistory = () => time.mode === 'history';

  function on(type, fn) {
    let set = listeners.get(type);
    if (!set) { set = new Set(); listeners.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }
  function emit(type, a, b) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(a, b); } catch (err) { console.error(`[cosmos store] '${type}' listener threw:`, err); }
    }
  }

  // ------------------------------------------------------------ http
  async function getJson(path) {
    const res = await fetchImpl(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw httpError(res, body);
    return body;
  }
  async function postJson(path, payload) {
    const res = await fetchImpl(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cosmos-Token': token || '', Accept: 'application/json' },
      body: JSON.stringify(payload ?? {}),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      // A 403 'forbidden' from our own page means the token is from an older
      // server run: say so (persistently) instead of a confusing error.
      if (res.status === 403 && body?.error === 'forbidden') markRestarted();
      const err = httpError(res, body);
      if (restarted) err.message = 'Cosmos restarted. Reload the page to re-enable saving.';
      throw err;
    }
    return body;
  }
  const enc = encodeURIComponent;

  function markRestarted() {
    if (restarted) return;
    restarted = true;
    emit('restarted', { runId });
  }
  function reportVisibility() {
    if (!cid || restarted || typeof document === 'undefined') return;
    postJson('/api/visibility', { cid, visible: document.visibilityState === 'visible' }).catch(() => {});
  }
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', reportVisibility);

  // ------------------------------------------------------------ clock
  function now() {
    if (inHistory()) return time.cursor;
    return wallClock() + serverOffset;
  }

  // ------------------------------------------------------------ arms
  function rebuildArms() {
    const sessions = inHistory() ? hist.sessions : live.sessions;
    const seen = new Set();
    for (const rec of sessions.values()) {
      const key = rec.arm?.key;
      if (!key) continue;
      let a = arms.get(key);
      if (!seen.has(key)) {
        if (!a) { a = { key, name: null, slot: null, sessionIds: [] }; arms.set(key, a); }
        a.sessionIds.length = 0;
        a.name = settings?.arms?.[key]?.name || rec.arm.name || key.split('/').filter(Boolean).pop() || key;
        a.slot = null;
        seen.add(key);
      }
      a.sessionIds.push(rec.id);
      const slot = settings?.arms?.[key]?.slot ?? rec.place?.slot;
      if (a.slot == null && typeof slot === 'number') a.slot = slot;
    }
    for (const key of [...arms.keys()]) if (!seen.has(key)) arms.delete(key);
  }

  // ------------------------------------------------------------ live: recent lists
  function recentOf(sid) {
    let r = live.recent.get(sid);
    if (!r) { r = { errors: [], toolCalls: [] }; live.recent.set(sid, r); }
    return r;
  }
  function prune(list, minT) {
    let i = 0;
    while (i < list.length && list[i].t < minT) i++;
    if (i) list.splice(0, i);
  }
  function upsertById(list, item) {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item; else { list.push(item); if (list.length > 1 && list[list.length - 2].t > item.t) list.sort((a, b) => a.t - b.t); }
  }
  function noteRecent(ev, target) {
    if (ev.ship) return;               // subagent work shows on the ship, not the star (Gate 1)
    if (ev.type === EV.ERROR) {
      const d = ev.data || {};
      upsertById(recentOf(ev.sid).errors, { id: keyOf(ev), t: ev.t, tool: d.tool ?? (d.kind === 'api' ? 'api' : null) });
      prune(target.get(ev.sid)?.errors || [], ev.t - ERRORS_KEEP_S);
    } else if (ev.type === EV.TOOL_CALL) {
      const d = ev.data || {};
      upsertById(recentOf(ev.sid).toolCalls, { id: d.toolUseId || keyOf(ev), t: ev.t, tool: d.tool ?? null, target: d.target ?? null, ok: d.ok ?? null });
      prune(target.get(ev.sid)?.toolCalls || [], ev.t - CALLS_KEEP_S);
    }
  }

  // ------------------------------------------------------------ live: records
  function needsTransition(prev, rec) {
    const was = prev?.state?.mode === MODE.NEEDS_ME;
    const is = rec?.state?.mode === MODE.NEEDS_ME;
    if (was !== is) emit('needs-me', { sid: rec?.id ?? prev?.id, entered: is, since: rec?.state?.since ?? null });
  }
  // Rebirth (owner, 2026-11-08): a dying or dead session that comes back to life
  // re-forms in a white-hole burst. sid -> data-clock time it came back.
  const rebornAt = new Map();
  const ALIVE = new Set([MODE.WORKING, MODE.NEEDS_ME, MODE.MY_MOVE]);
  function rebirthCheck(prev, rec) {
    if (!prev || !rec || !ALIVE.has(rec.state?.mode)) return;
    const was = prev.state?.mode;
    if (was !== MODE.IDLE && was !== MODE.DEAD) return;
    if (fateOf(prev, now()).fate !== 'dying') return;
    rebornAt.set(rec.id, now());
    emit('reborn', { sid: rec.id, title: rec.title ?? null });
  }
  function putLiveSession(rec) {
    const prev = live.sessions.get(rec.id);
    live.sessions.set(rec.id, rec);
    if (!inHistory()) rebirthCheck(prev, rec);
    sessionCache.delete(rec.id);
    if (inHistory()) return;
    if (!prev || prev.arm?.key !== rec.arm?.key || prev.place?.slot !== rec.place?.slot) rebuildArms();
    else { const a = arms.get(rec.arm?.key); if (a) a.name = settings?.arms?.[a.key]?.name || rec.arm.name || a.name; }
    emit('session', rec);
    needsTransition(prev, rec);
  }
  function addLiveEvent(ev) {
    const t = ev.t;
    if (!(typeof t === 'number' && Number.isFinite(t))) return;
    noteRecent(ev, live.recent);
    if (ev.type === EV.METRICS) return;
    if (isFeed(ev)) {
      const i = live.events.findIndex((x) => x.id === ev.id);
      if (i >= 0) live.events[i] = ev;
      else {
        live.events.push(ev);
        if (live.events.length > 1 && live.events[live.events.length - 2].t > t) live.events.sort((a, b) => a.t - b.t);
        if (live.events.length > ROUTINE_MAX) live.events = trimFeed(live.events);
      }
    }
    if (!inHistory()) emit('event', ev);
  }

  function applySnapshot(snap) {
    if (!snap) return;
    if (typeof snap.serverTime === 'number') serverOffset = snap.serverTime - wallClock();
    if (snap.settings) settings = snap.settings;
    if (snap.limits) limits = snap.limits;
    if (snap.totals) live.totals = snap.totals;
    const wasLoading = loading;
    loading = snap.loading || { done: true };
    if (wasLoading.done !== loading.done || wasLoading.filesDone !== loading.filesDone) emit('loading', loading);
    const prevSessions = live.sessions;
    const next = new Map();
    for (const rec of snap.sessions || []) next.set(rec.id, rec);
    live.sessions = next;
    live.recent.clear();
    for (const [sid, r] of Object.entries(snap.recent || {})) {
      live.recent.set(sid, { errors: (r.errors || []).slice(), toolCalls: (r.toolCalls || []).slice() });
    }
    live.events = trimFeed((snap.events || []).filter(isFeed).sort((a, b) => a.t - b.t));
    if (typeof snap.runId === 'string') {
      if (runId && snap.runId !== runId) markRestarted();
      runId = snap.runId;
    }
    sessionCache.clear();
    if (inHistory()) return;
    rebuildArms();
    emit('settings', { settings, limits });
    emit('sessions', live.sessions);
    emit('totals', live.totals);
    for (const rec of next.values()) needsTransition(prevSessions.get(rec.id), rec);
    for (const prev of prevSessions.values()) if (!next.has(prev.id)) needsTransition(prev, null);
    if (loading.done !== false && !readyFired) { readyFired = true; emit('ready'); }
  }

  async function loadSnapshot() {
    const snap = await getJson('/api/snapshot');
    applySnapshot(snap);
    if (snap?.loading && snap.loading.done === false) scheduleLoadingPoll();
    return snap;
  }
  function scheduleLoadingPoll() {
    if (loadingTimer || disposed) return;
    loadingTimer = timers.setTimeout(async () => {
      loadingTimer = null;
      try { await loadSnapshot(); } catch { scheduleLoadingPoll(); }
      emit('connection', connection);
    }, LOADING_POLL_MS);
  }

  // ------------------------------------------------------------ SSE
  function setConnection(c) {
    if (c === connection) return;
    connection = c;
    emit('connection', c);
  }
  function connect() {
    if (disposed || !EventSourceImpl) return;
    try { es?.close(); } catch { /* ignore */ }
    es = new EventSourceImpl('/api/events');
    const parse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
    es.addEventListener('hello', (e) => {
      const d = parse(e);
      if (d && typeof d.serverTime === 'number') serverOffset = d.serverTime - wallClock();
      helloCount += 1;
      if (d && typeof d.runId === 'string') {
        if (runId && d.runId !== runId) markRestarted();
        runId = d.runId;
      }
      if (d && typeof d.cid === 'string') { cid = d.cid; if (typeof document !== 'undefined' && document.visibilityState === 'hidden') reportVisibility(); }
      setConnection('live');
      // Every REconnect refetches the snapshot: anything that changed while the
      // stream was down (a NEEDS ME during a restart) shows at once.
      if (helloCount > 1) loadSnapshot().catch((err) => console.warn('[cosmos store] reconnect snapshot failed:', err.message));
      helloResolve?.();
    });
    es.addEventListener('ping', (e) => {
      const d = parse(e);
      if (d && typeof d.serverTime === 'number') serverOffset = d.serverTime - wallClock();
      if (connection !== 'live') setConnection('live');
    });
    es.addEventListener('ev', (e) => { const ev = parse(e); if (ev) addLiveEvent(ev); });
    es.addEventListener('session', (e) => { const rec = parse(e); if (rec?.id) putLiveSession(rec); });
    es.addEventListener('totals', (e) => {
      const t = parse(e);
      if (!t) return;
      live.totals = t;
      if (!inHistory()) emit('totals', t);
    });
    es.addEventListener('settings', (e) => {
      const d = parse(e);
      if (!d) return;
      if (d.settings) settings = d.settings;
      if (d.limits) limits = d.limits;
      rebuildArms();
      emit('settings', { settings, limits });
    });
    es.addEventListener('resync', () => { loadSnapshot().catch((err) => console.warn('[cosmos store] resync failed:', err.message)); });
    es.onerror = () => {
      if (disposed) return;
      // EventSource reconnects by itself (with Last-Event-ID) while CONNECTING.
      if (es.readyState === 2 /* CLOSED */) {
        setConnection('offline');
        if (!retryTimer) retryTimer = timers.setTimeout(() => { retryTimer = null; connect(); loadSnapshot().catch(() => {}); }, RETRY_MS);
      } else {
        setConnection('connecting');
      }
    };
  }

  // ------------------------------------------------------------ derived reads
  function curSessions() { return inHistory() ? hist.sessions : live.sessions; }
  function get(sid) { return (sid && curSessions().get(sid)) || null; }

  function idleFor(rec) {
    if (!rec?.state) return 0;
    const m = rec.state.mode;
    if (m === MODE.DEAD) return 1;
    const rem = rec.state.remnant;
    if (rem === 'aged-out' || rem === 'deleted') return 1;
    if (m !== MODE.MY_MOVE && m !== MODE.IDLE) return 0;
    const T = (settings?.idle?.hours > 0 ? settings.idle.hours : 24) * 3600 || DAY_S;
    const la = rec.times?.lastActivity;
    if (typeof la !== 'number') return rec.state.idleFor ?? 0;
    return idleFraction(now() - la, rec.state.k ?? 1, T);
  }

  function needsMe() {
    const out = [];
    for (const rec of curSessions().values()) if (rec.state?.mode === MODE.NEEDS_ME) out.push(rec);
    out.sort((a, b) => (a.state.since ?? 0) - (b.state.since ?? 0));
    return out.map((r) => r.id);
  }
  function byUrgency() {
    const n = now();
    const recs = [...curSessions().values()];
    const rank = new Map();
    for (const r of recs) {
      let k;
      try { k = urgencyRank(r.state.mode === MODE.IDLE ? { ...r, state: { ...r.state, idleFor: idleFor(r) } } : r, n); } catch { k = 9; }
      rank.set(r.id, k);
    }
    recs.sort((a, b) => rank.get(a.id) - rank.get(b.id) || (b.times?.lastActivity ?? 0) - (a.times?.lastActivity ?? 0));
    return recs.map((r) => r.id);
  }

  const EMPTY = Object.freeze([]);
  function recent(sid) {
    const n = now();
    if (inHistory()) return historyRecent(sid, n);
    const rec = live.sessions.get(sid);
    const r = live.recent.get(sid);
    const errors = r ? r.errors.filter((e) => e.t >= n - ERRORS_KEEP_S && e.t <= n + 5) : [];
    const toolCalls = r ? r.toolCalls.filter((c) => c.t >= n - CALLS_KEEP_S && c.t <= n + 5) : [];
    const subagents = [];
    for (const sh of rec?.ships || EMPTY) {
      if (sh.active || (sh.endT != null && n - sh.endT < SHIP_DONE_KEEP_S)) subagents.push({ id: sh.id, t: sh.t, endT: sh.active ? null : sh.endT, label: sh.label });
    }
    return { errors, toolCalls, subagents };
  }
  function historyRecent(sid, n) {
    const errors = [], toolCalls = [], subagents = [];
    const evs = hist.events;
    const hi = upperBound(evs, n);
    for (let i = hi - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev.t < n - ERRORS_KEEP_S) break;
      if (ev.sid !== sid || ev.ship) continue;
      if (ev.type === EV.ERROR) errors.push({ id: keyOf(ev), t: ev.t, tool: ev.data?.tool ?? null });
      else if (ev.type === EV.TOOL_CALL && ev.t >= n - CALLS_KEEP_S) {
        const d = ev.data || {};
        toolCalls.push({ id: d.toolUseId || keyOf(ev), t: ev.t, tool: d.tool ?? null, target: d.target ?? null, ok: d.ok ?? null });
      }
    }
    errors.reverse(); toolCalls.reverse();
    const rec = hist.sessions.get(sid);
    for (const sh of rec?.ships || EMPTY) {
      if (sh.t > n) continue;
      const ended = sh.endT != null && sh.endT <= n;
      if (!ended || n - sh.endT < SHIP_DONE_KEEP_S) subagents.push({ id: sh.id, t: sh.t, endT: ended ? sh.endT : null, label: sh.label });
    }
    return { errors, toolCalls, subagents };
  }

  // ------------------------------------------------------------ adapter (§4.1)
  function derived(rec) {
    let d = adapterCache.get(rec);
    if (d) return d;
    d = {
      compactions: (rec.compactions || EMPTY).map((c) => ({ id: c.id, t: c.t, tokensBefore: c.preTokens ?? 0, tokensAfter: c.postTokens ?? 0 })),
      folders: (rec.folders || EMPTY).map((f) => ({ id: f.id, path: f.path, folder: f.id, edits: f.edits || 0, reads: f.reads || 0, lastT: f.lastT || 0 })),
    };
    adapterCache.set(rec, d);
    return d;
  }
  function folderTwin(c) {
    let tw = callTwins.get(c);
    if (!tw) { tw = { id: c.id, t: c.t, tool: c.tool, target: folderOfTarget(c.target), ok: c.ok }; callTwins.set(c, tw); }
    return tw;
  }
  function fillArr(out, name) {
    let a = out[name];
    if (!Array.isArray(a) || Object.isFrozen(a)) { a = []; out[name] = a; }
    a.length = 0;
    return a;
  }

  // Crash alarm (owner, 2026-11-08): crashed sessions draw more attention than
  // needs-me, for a day after the crash or until dismissed (kept on this device).
  const CRASH_ALARM_S = 86400;
  const DISMISS_KEY = 'cosmos.crash.dismissed';
  let dismissed = new Set();
  try { dismissed = new Set(JSON.parse(globalThis.localStorage?.getItem(DISMISS_KEY) || '[]')); } catch { dismissed = new Set(); }
  function crashAlarm(rec, n = now()) {
    const st = rec?.state;
    if (!st || st.mode !== MODE.CRASHED || dismissed.has(rec.id)) return false;
    const at = st.since ?? rec.times?.lastActivity ?? 0;
    return n - at < CRASH_ALARM_S;
  }
  function crashAlarms() {
    const out = [];
    const n = now();
    for (const r of curSessions().values()) if (crashAlarm(r, n)) out.push(r);
    out.sort((a, b) => (b.state.since ?? 0) - (a.state.since ?? 0));
    return out;
  }
  function dismissCrash(sid) {
    dismissed.add(sid);
    try { globalThis.localStorage?.setItem(DISMISS_KEY, JSON.stringify([...dismissed].slice(-200))); } catch { /* ignore */ }
    emit('crash-dismissed', { sid });
  }

  /** Fate of a record at data-clock time n: { fate: 'dying'|'flourish'|null, phase 0..1 }. */
  function fateOf(rec, n) {
    const st = rec.state || {};
    const rem = st.remnant;
    if (rem === 'archived' || rem === 'ended') return { fate: 'flourish', phase: 0 };
    if (st.mode === MODE.IDLE && !rem) return { fate: 'dying', phase: Math.min(1, idleFor(rec)) };
    if (st.mode === MODE.DEAD || (st.mode === MODE.IDLE && rem)) {
      const since = Math.max(0, n - ((rec.times?.lastActivity ?? n) + DAY_S));
      return { fate: 'dying', phase: (since % DAY_S) / DAY_S };
    }
    return { fate: null, phase: 0 };
  }

  function systemState(sid, opts, out = {}) {
    const rec = get(sid);
    if (!rec) return null;
    const n = now();
    const st = rec.state || {};
    const rem = st.remnant;
    let mode = st.mode;
    let idle = 0;
    if (mode === MODE.NEEDS_ME || mode === MODE.WORKING) idle = 0;
    else if (mode === MODE.MY_MOVE) idle = idleFor(rec);
    else if (mode === MODE.IDLE) idle = idleFor(rec);
    else if (mode === MODE.DEAD) { mode = 'idle'; idle = 1; }
    else if (mode === MODE.CRASHED) idle = 0;
    else { mode = 'idle'; idle = 1; }
    if (rem === 'aged-out' || rem === 'deleted') { mode = 'idle'; idle = 1; }
    // Fate: archived or cleanly closed sessions flourish; inactive ones die. The
    // death cycle runs over the idle day, then (once dead) restarts every day so
    // dead systems keep visibly falling apart. Crashed keeps its own remnant.
    const fl = fateOf(rec, n);
    if (fl.fate === 'flourish') { mode = 'idle'; idle = 0; }
    else if (fl.fate === 'dying') { mode = 'idle'; idle = Math.min(1, fl.phase / AGING_END); }
    out.fate = fl.fate;
    out.deathPhase = fl.phase;

    out.v = 1;
    out.id = rec.id;
    out.now = n;
    out.mode = mode;
    out.needsKind = mode === MODE.NEEDS_ME ? (NEEDS_KIND[st.sub] ?? 'permission') : null;
    out.idleFor = idle;
    out.activity = typeof rec.activity === 'number' ? rec.activity : 0;
    out.contextFill = typeof rec.context?.fill === 'number' && Number.isFinite(rec.context.fill) ? rec.context.fill : 0;
    out.contextLimit = rec.context?.limit ?? null;
    out.tokens = rec.tokens || { total: 0 };
    if (typeof out.tokens.total !== 'number') out.tokens = { ...out.tokens, total: 0 };
    const born = rec.times?.bornAt;
    const rb = rebornAt.get(sid);
    out.bornAt = typeof born === 'number' && n - born < 4 && n - born >= 0 ? born
      : typeof rb === 'number' && n - rb < 4 && n - rb >= 0 ? rb : null;
    out.endedAt = rec.times?.endedAt ?? null;
    out.title = rec.title ?? null;
    out.project = rec.arm?.name ?? null;
    out.model = rec.model ?? null;

    const d = derived(rec);
    out.compactions = d.compactions;

    const r = recent(sid);
    const errs = fillArr(out, 'errors');
    for (const e of r.errors) errs.push(e);
    const calls = fillArr(out, 'toolCalls');
    const folderGrain = opts?.fileGrain === 'folder';
    for (const c of r.toolCalls) calls.push(folderGrain ? folderTwin(c) : c);
    const subs = fillArr(out, 'subagents');
    for (const s of r.subagents) subs.push(s);
    out.files = folderGrain ? d.folders : (rec.files || EMPTY);
    return out;
  }

  // ------------------------------------------------------------ selection
  function sameSel(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.kind === b.kind && a.sid === b.sid && a.armKey === b.armKey && a.id === b.id;
  }
  function select(sel, opts = { fly: true }) {
    let s = sel ? { ...sel } : null;
    if (s) delete s.point;
    if (s?.kind === 'event' && !s.sid && s.id) {
      const ev = live.events.find((x) => x.id === s.id) || hist.events.find((x) => x.id === s.id);
      if (ev) s.sid = ev.sid;
    }
    if ((s?.kind === 'session' || s?.kind === 'file' || s?.kind === 'folder') && s.sid && !s.armKey) {
      const k = get(s.sid)?.arm?.key;
      if (k) s.armKey = k;
    }
    selection = s;
    emit('selection', s, { fly: true, ...(opts || {}) });
  }
  function hover(sel) {
    const s = sel ? { kind: sel.kind, sid: sel.sid, armKey: sel.armKey, id: sel.id } : null;
    if (sameSel(s, hovered)) return;
    hovered = s;
    emit('hover', s);
  }

  // ------------------------------------------------------------ history
  function overlayIdentity(rec) {
    const lr = live.sessions.get(rec.id);
    if (!lr) return rec;
    for (const k of IDENTITY) {
      if (lr[k] == null) continue;
      if (k === 'title' && rec.titleSource && rec.titleSource !== 'sid' && rec.title) continue;
      if (k === 'arm' && rec.arm?.key && rec.arm.key !== lr.arm?.key) continue;
      rec[k] = typeof lr[k] === 'object' ? structuredClone(lr[k]) : lr[k];
    }
    return rec;
  }
  function exposeHist(sid) {
    const rec = hist.fold.get(sid);
    if (!rec) { hist.sessions.delete(sid); return null; }
    const view = structuredClone(stripFold(rec));
    hist.sessions.set(sid, view);
    return view;
  }
  function cloneFoldMap(m) {
    const out = new Map();
    for (const [k, v] of m) out.set(k, structuredClone(v));
    return out;
  }
  function applyHistEvent(ev, changed) {
    if (ev.type === EV.BORN) {
      if (!hist.fold.has(ev.sid)) hist.fold.set(ev.sid, overlayIdentity(recordFromBorn(ev)));
      else applyEvent(hist.fold.get(ev.sid), ev, settings);
      changed.add(ev.sid);
      return;
    }
    const rec = hist.fold.get(ev.sid);
    if (!rec) return;
    applyEvent(rec, ev, settings);
    changed.add(ev.sid);
  }
  function computeHistTotals() {
    const n = time.cursor;
    const byMode = { 'needs-me': 0, 'my-move': 0, working: 0, idle: 0, dead: 0, crashed: 0 };
    let liveN = 0, remnants = 0;
    for (const r of hist.sessions.values()) {
      const m = r.state?.mode;
      if (m in byMode) byMode[m]++;
      // History cannot see process liveness (S5); "running" here means any
      // session not yet faded to dead or crashed at the cursor.
      if (m === MODE.NEEDS_ME || m === MODE.WORKING || m === MODE.MY_MOVE || m === MODE.IDLE) liveN++;
      else remnants++;
    }
    const day = new Date(n * 1000); day.setHours(0, 0, 0, 0);
    const dayStart = day.getTime() / 1000;
    let errorsToday = 0, denialsToday = 0, stormsToday = 0, compactionsToday = 0, shipsToday = 0;
    const tok = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };
    // Tokens today = tokens at the cursor − tokens at local midnight. The
    // midnight baseline is exact when the range starts at or before midnight
    // (base records, then the last metrics sample before midnight); when the
    // range starts later in the day, the first sample in range stands in.
    const baseline = new Map();
    const exactBase = time.from <= dayStart;
    if (exactBase) for (const [sid, r] of hist.keyframes[0]?.recs || []) baseline.set(sid, r.tokens);
    const hi = upperBound(hist.events, n);
    for (let i = 0; i < hi; i++) {
      const ev = hist.events[i];
      const d = ev.data || {};
      if (ev.t < dayStart) {
        if (ev.type === EV.METRICS && d.tokens) baseline.set(ev.sid, d.tokens);
        continue;
      }
      if (ev.type === EV.ERROR) { if (d.kind !== 'api') errorsToday++; if (d.kind === 'denial') denialsToday++; }
      else if (ev.type === EV.STORM_START) stormsToday++;
      else if (ev.type === EV.COMPACTION) compactionsToday++;
      else if (ev.type === EV.SUBAGENT_OUT) shipsToday++;
      else if (ev.type === EV.METRICS && d.tokens && !exactBase && !baseline.has(ev.sid)) baseline.set(ev.sid, d.tokens);
    }
    for (const [sid, r] of hist.fold) {
      const base = baseline.get(sid) || null;
      if (!base && !exactBase && !(r.times?.bornAt >= dayStart)) continue;
      for (const k of Object.keys(tok)) tok[k] += Math.max(0, (r.tokens?.[k] || 0) - (base?.[k] || 0));
    }
    hist.totals = {
      day: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
      byMode, live: liveN, sessions: hist.sessions.size, remnants,
      tokensToday: tok, errorsToday, denialsToday, stormsToday, compactionsToday, shipsToday,
      explain: live.totals?.explain || { calls: 0, tokens: 0 },
      history: true,
    };
    return hist.totals;
  }
  function refreshHistFeed() {
    const hi = upperBound(hist.events, time.cursor);
    const out = [];
    for (let i = hi - 1; i >= 0 && out.length < EVENTS_MAX; i--) if (isFeed(hist.events[i])) out.push(hist.events[i]);
    hist.feed = out.reverse();
  }

  async function enterHistory(from, to) {
    const f = Math.min(from, to), t = Math.max(from, to);
    const seq = ++histSeq;
    const bundle = await getJson(`/api/history?from=${enc(f)}&to=${enc(t)}`);
    if (seq !== histSeq || disposed) return;
    pauseTimer();
    const wasLive = !inHistory();
    const prevView = wasLive ? live.sessions : hist.sessions;
    hist.events = (bundle.events || []).filter((e) => typeof e.t === 'number').sort((a, b) => a.t - b.t);
    hist.fold = new Map();
    for (const rec of bundle.base || []) hist.fold.set(rec.id, overlayIdentity(structuredClone(rec)));
    hist.keyframes = [{ t: bundle.from ?? f, idx: 0, recs: cloneFoldMap(hist.fold) }];
    hist.idx = 0;
    hist.cursorApplied = bundle.from ?? f;
    hist.truncated = !!bundle.truncated;
    hist.sessions = new Map();
    for (const sid of hist.fold.keys()) exposeHist(sid);
    time.mode = 'history';
    time.from = bundle.from ?? f;
    time.to = bundle.to ?? t;
    time.cursor = time.from;
    time.playing = false;
    seekTo(time.from, { full: true, prevView });
    emit('time', time);
  }

  function seekTo(t, { full = false, prevView = null } = {}) {
    const target = Math.max(time.from, Math.min(time.to, t));
    const changed = new Set();
    let bulk = full;
    const before = prevView || new Map(hist.sessions);
    if (target < hist.cursorApplied) {
      // Backwards: restore the newest keyframe at or before the target.
      let kf = hist.keyframes[0];
      for (const k of hist.keyframes) if (k.t <= target) kf = k; else break;
      hist.fold = cloneFoldMap(kf.recs);
      hist.idx = kf.idx;
      hist.cursorApplied = kf.t;
      bulk = true;
    }
    const evs = hist.events;
    let lastKfT = hist.keyframes[hist.keyframes.length - 1].t;
    const fwd = [];
    while (hist.idx < evs.length && evs[hist.idx].t <= target) {
      const ev = evs[hist.idx];
      applyHistEvent(ev, changed);
      hist.idx++;
      if (!bulk && ev.type !== EV.METRICS) fwd.push(ev);
      if (ev.t - lastKfT >= KEYFRAME_S && hist.idx > hist.keyframes[hist.keyframes.length - 1].idx) {
        // Keyframes only grow forward (events are sorted), so the list stays ordered.
        hist.keyframes.push({ t: ev.t, idx: hist.idx, recs: cloneFoldMap(hist.fold) });
        lastKfT = ev.t;
      }
    }
    hist.cursorApplied = target;
    time.cursor = target;
    // Time-dependent fields for every record (idle fade, dead transition).
    for (const [sid, rec] of hist.fold) {
      const m = rec.state.mode, i = rec.state.idleFor;
      advance(rec, target, settings);
      if (rec.state.mode !== m || Math.abs(rec.state.idleFor - i) > 0.002) changed.add(sid);
    }
    if (bulk) {
      hist.sessions = new Map();
      for (const sid of hist.fold.keys()) exposeHist(sid);
    } else {
      for (const sid of changed) exposeHist(sid);
    }
    refreshHistFeed();
    computeHistTotals();
    rebuildArms();
    if (bulk) emit('sessions', hist.sessions);
    else {
      for (const sid of changed) { const r = hist.sessions.get(sid); if (r) emit('session', r); }
      for (const ev of fwd) emit('event', ev);
    }
    for (const rec of hist.sessions.values()) needsTransition(before.get(rec.id), rec);
    for (const prev of before.values()) if (!hist.sessions.has(prev.id)) needsTransition(prev, null);
    emit('totals', hist.totals);
  }

  function setCursor(t) {
    if (!inHistory() || !(typeof t === 'number' && Number.isFinite(t))) return;
    seekTo(t);
    emit('time', time);
  }
  function pauseTimer() { if (playTimer) { timers.clearInterval(playTimer); playTimer = null; } }
  function play(speed = time.speed) {
    if (!inHistory()) return;
    time.speed = speed > 0 ? speed : 1;
    time.playing = true;
    pauseTimer();
    playLast = wallClock();
    playTimer = timers.setInterval(() => {
      const w = wallClock();
      const dt = Math.min(1, Math.max(0, w - playLast));
      playLast = w;
      const next = Math.min(time.to, time.cursor + dt * time.speed);
      if (next >= time.to) { time.playing = false; pauseTimer(); }
      seekTo(next);
      emit('time', time);
    }, PLAY_TICK_MS);
    emit('time', time);
  }
  function pause() {
    pauseTimer();
    if (time.playing) { time.playing = false; emit('time', time); }
  }
  function exitHistory() {
    if (!inHistory()) return;
    histSeq++;
    pauseTimer();
    const before = hist.sessions;
    time.mode = 'live';
    time.playing = false;
    time.cursor = null;
    hist.fold = new Map(); hist.sessions = new Map(); hist.events = []; hist.feed = []; hist.keyframes = [];
    rebuildArms();
    emit('sessions', live.sessions);
    emit('totals', live.totals);
    for (const rec of live.sessions.values()) needsTransition(before.get(rec.id), rec);
    for (const prev of before.values()) if (!live.sessions.has(prev.id)) needsTransition(prev, null);
    emit('time', time);
  }
  function historyEvents() { return inHistory() ? hist.events : EMPTY; }

  // ------------------------------------------------------------ server calls
  function fetchSession(sid) {
    const c = sessionCache.get(sid);
    const t = Date.now();
    if (c && t - c.at < SESSION_CACHE_MS) return c.promise;
    const promise = getJson(`/api/session/${enc(sid)}`);
    sessionCache.set(sid, { at: t, promise });
    promise.catch(() => sessionCache.delete(sid));
    return promise;
  }
  const diag = (id) => getJson(`/api/diag/${enc(id)}`);
  const errorText = (id) => postJson(`/api/diag/${enc(id)}/error-text`, {});
  const explain = (id) => postJson(`/api/diag/${enc(id)}/explain`, { confirm: true });
  async function saveSettings(payload) {
    const res = await postJson('/api/settings', payload || {});
    if (res?.settings) settings = res.settings;
    if (res?.limits) limits = res.limits;
    rebuildArms();
    emit('settings', { settings, limits });
    return res;
  }
  const claudeSettings = () => getJson('/api/claude-settings');
  const previewClaudeSetting = (change, value) => getJson(`/api/claude-settings/preview?change=${enc(change)}&value=${enc(value)}`);
  const applyClaudeSetting = (change, value, expectHash) => postJson('/api/claude-settings/apply', { change, value, expectHash });

  // ------------------------------------------------------------ boot
  let helloResolve = null;
  const hello = new Promise((res) => { helloResolve = res; });
  const ready = (async () => {
    connect();
    await loadSnapshot();
    // Wait briefly for the stream so 'live' shows at once; never block the page on it.
    await Promise.race([hello, new Promise((res) => timers.setTimeout(res, 2500))]);
  })();

  function dispose() {
    disposed = true;
    pauseTimer();
    if (retryTimer) timers.clearTimeout(retryTimer);
    if (loadingTimer) timers.clearTimeout(loadingTimer);
    try { es?.close(); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', reportVisibility);
    listeners.clear();
  }

  const store = {
    ready,
    get sessions() { return curSessions(); },
    get arms() { return arms; },
    get events() { return inHistory() ? hist.feed : live.events; },
    get totals() { return inHistory() ? hist.totals : live.totals; },
    get settings() { return settings; },
    get limits() { return limits; },
    get connection() { return connection; },
    get restarted() { return restarted; },
    get loading() { return loading; },
    get selection() { return selection; },
    get hovered() { return hovered; },
    get time() { return time; },
    get history() { return inHistory() ? { events: hist.events, truncated: !!hist.truncated } : null; },
    now, on, get, fetchSession, recent, idleFor, needsMe, byUrgency, systemState, fateOf, crashAlarm, crashAlarms, dismissCrash,
    select, hover, enterHistory, setCursor, play, pause, exitHistory, historyEvents,
    diag, errorText, explain, saveSettings, claudeSettings, previewClaudeSetting, applyClaudeSetting,
    dispose,
  };
  return store;
}
