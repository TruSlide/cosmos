// Cosmos cache: reader offsets, session snapshots, the event log, stable
// layout, the Explain running total and the launch-hook config
// (GALAXY_CONTRACT §3.3, §3.4, §3.9; writes W2–W5, W7).
//
// Everything lives under cosmos/cache/. Nothing here ever writes under
// ~/.claude; the only thing it looks at there is the list of transcript file
// NAMES (never contents), to tell an aged-out remnant from a live transcript.
//
// Writes are atomic (a *.tmp next to the file, then rename), except the event
// log, which is append-only: a day file only ever grows, one JSON line per
// event, structured fields only (never message text).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hash01 } from '../web/src/lib/math.js';
import { SETTINGS_DEFAULTS } from '../web/src/shared/settings.mjs';

const CACHE_ONLY_S = 60 * 86400;        // DATA_SPEC §5: > 60 days -> served from cache only
const ARM_SLOTS = 12;
const EXPLAIN_LOG_MAX = 500;
const HISTORY_MAX_EVENTS = 200000;
const KEYFRAMES_MAX = 16;
const MIN_EVENT_T = 946684800;          // 2000-01-01: anything earlier is a missing timestamp

/** Local calendar date of an epoch-seconds time, as YYYY-MM-DD. */
export function localDay(tS) {
  const d = new Date(tS * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Epoch seconds of local midnight that starts `day` (YYYY-MM-DD). */
function dayStartS(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000;
}

/** The day after `day`, local calendar (DST-safe). */
function nextDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + 1, 12).getTime() / 1000);
}

/** Payload hash for dedupe: what the event says, not when or how we saw it. */
function payloadHash(ev) {
  const s = JSON.stringify([ev.type, ev.t, ev.sid, ev.ship ?? null, ev.data ?? null]);
  return crypto.createHash('sha1').update(s).digest('base64').slice(0, 12);
}

/** The log line shape: CosmosEvent minus the per-run `seq`. */
function logLine(ev) {
  const o = { id: ev.id, type: ev.type, t: ev.t, sid: ev.sid, ship: ev.ship ?? null, live: !!ev.live, data: ev.data ?? {} };
  if (ev.src) o.src = ev.src;
  return JSON.stringify(o);
}

function parseLines(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    if (nl > start) {
      try { out.push(JSON.parse(text.slice(start, nl))); } catch { /* a torn last line from a crash: skip */ }
    }
    start = nl + 1;
  }
  return out;
}

/** Collapse re-emits (same id: the last copy wins, at the first copy's place) and sort by t. */
function collapseAndSort(events) {
  const byId = new Map();
  const order = [];
  for (const ev of events) {
    if (!byId.has(ev.id)) order.push(ev.id);
    byId.set(ev.id, ev);
  }
  const out = order.map((id) => byId.get(id));
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Lite view of a record: files/folders cut to 24 each, hourly omitted (§2.1). */
export function liteRecord(rec) {
  if (!rec) return rec;
  const { hourly, files, folders, _fold, ...rest } = rec;   // _fold: fold.mjs bookkeeping, never sent
  const lite = { ...rest };
  if (Array.isArray(files)) { lite.files = files.slice(0, 24); lite.filesTotal = rec.filesTotal ?? files.length; }
  if (Array.isArray(folders)) { lite.folders = folders.slice(0, 24); lite.foldersTotal = rec.foldersTotal ?? folders.length; }
  return lite;
}

export function createStore({
  cacheDir,
  claudeHome = path.join(os.homedir(), '.claude'),
  settings = SETTINGS_DEFAULTS,
  clock = () => Date.now() / 1000,
  snapshotDebounceMs = 60000,
  stateDebounceMs = 60000,
  layoutDebounceMs = 1000,
  eventFlushMs = 400,
  fold: foldImpl = null,              // tests may inject a reducer; default is web/src/shared/fold.mjs
} = {}) {
  if (!cacheDir) throw new Error('createStore needs cacheDir');
  const P = {
    state: path.join(cacheDir, 'state.json'),
    sessions: path.join(cacheDir, 'sessions'),
    events: path.join(cacheDir, 'events'),
    layout: path.join(cacheDir, 'layout.json'),
    explain: path.join(cacheDir, 'explain-usage.json'),
    launch: path.join(cacheDir, 'launch-config'),
  };
  let currentSettings = settings;
  const timers = new Set();
  const writeChains = new Map();      // path -> Promise (serialises writes to one file)

  function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

  function later(ms, fn) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    t.unref?.();
    timers.add(t);
    return t;
  }

  /** Atomic write: tmp in the same folder, then rename. Serialised per path. */
  function writeAtomic(file, data) {
    const prev = writeChains.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    });
    writeChains.set(file, next);
    next.finally(() => { if (writeChains.get(file) === next) writeChains.delete(file); }).catch(() => {});
    return next;
  }

  function readJsonSync(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  function logWriteError(what) {
    return (err) => console.error(`cosmos store: could not write ${what}: ${err.code || err.message}`);
  }

  // ---------------------------------------------------------------- state.json
  let pendingState = null;
  let stateTimer = null;

  function loadState() {
    const s = readJsonSync(P.state);
    return s && typeof s === 'object' && s.files ? s : null;
  }
  function writeState() {
    stateTimer = null;
    if (!pendingState) return Promise.resolve();
    const data = JSON.stringify(pendingState);
    pendingState = null;
    return writeAtomic(P.state, data).catch(logWriteError('state.json'));
  }
  function saveState(rs) {
    pendingState = rs;
    if (!stateTimer) stateTimer = later(stateDebounceMs, writeState);
  }

  // ------------------------------------------------------------ session snapshots
  const pendingSnaps = new Map();     // sid -> rec (latest reference)
  const snapTimers = new Map();       // sid -> timer
  const lastSnapHash = new Map();     // sid -> hash of last written JSON

  function snapFile(sid) {
    // sids are uuids; anything else is made filename-safe.
    return path.join(P.sessions, `${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  function writeSnap(sid) {
    snapTimers.delete(sid);
    const rec = pendingSnaps.get(sid);
    pendingSnaps.delete(sid);
    if (!rec) return Promise.resolve();
    const data = JSON.stringify(rec);
    const h = crypto.createHash('sha1').update(data).digest('base64');
    if (lastSnapHash.get(sid) === h) return Promise.resolve();
    lastSnapHash.set(sid, h);
    return writeAtomic(snapFile(sid), data).catch(logWriteError(`snapshot ${sid}`));
  }

  function saveSnapshot(rec) {
    if (!rec || !rec.id) return;
    pendingSnaps.set(rec.id, rec);
    if (!snapTimers.has(rec.id)) snapTimers.set(rec.id, later(snapshotDebounceMs, () => writeSnap(rec.id)));
  }

  function isCacheOnly(_sid, lastActivity) {
    // A missing or impossible time (0, before 2000) never makes a session cache-only:
    // the transcript is read instead (an in-development snapshot once carried 0).
    return typeof lastActivity === 'number' && lastActivity > 946684800 && lastActivity < clock() - CACHE_ONLY_S;
  }

  /** Session ids whose main transcript file still exists (names only, never contents). */
  function transcriptSids() {
    const out = new Set();
    const root = path.join(claudeHome, 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let names = [];
      try { names = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
      for (const n of names) if (n.endsWith('.jsonl')) out.add(n.slice(0, -6));
    }
    return out;
  }

  /**
   * Every cached snapshot. Sessions older than 60 days are marked cacheOnly;
   * a snapshot whose transcript is gone becomes a remnant (aged-out, or
   * deleted if the session already said so), mode 'dead'.
   * opts.transcriptExists(rec) overrides the file-name check.
   */
  function loadSnapshots(opts = {}) {
    const out = new Map();
    let names = [];
    try { names = fs.readdirSync(P.sessions).filter((n) => n.endsWith('.json')); } catch { return out; }
    const exists = typeof opts.transcriptExists === 'function'
      ? opts.transcriptExists
      : (() => { const set = transcriptSids(); return set ? (rec) => set.has(rec.id) : () => true; })();
    for (const n of names) {
      const rec = readJsonSync(path.join(P.sessions, n));
      if (!rec || typeof rec.id !== 'string') continue;
      const last = rec.times?.lastActivity;
      if (isCacheOnly(rec.id, last)) rec.cacheOnly = true;
      if (!exists(rec)) {
        rec.cacheOnly = true;
        rec.live = false;
        rec.state = rec.state || {};
        if (rec.state.remnant !== 'deleted') rec.state.remnant = 'aged-out';
        rec.state.mode = 'dead';
        rec.state.sub = null;
      }
      out.set(rec.id, rec);
    }
    return out;
  }

  // ---------------------------------------------------------------- event log
  const dayIndex = new Map();         // day -> Map(id -> payload hash)  (lazy, per day file)
  const pendingLines = new Map();     // day -> string[]
  let eventTimer = null;
  let pendingCount = 0;
  let warnedBadT = false;
  let eventFlushing = Promise.resolve();
  const keyframes = new Map();        // day -> { recs: Map sid->rec }  state after folding through `day`

  function dayFile(day) { return path.join(P.events, `${day}.jsonl`); }

  function indexFor(day) {
    let idx = dayIndex.get(day);
    if (idx) return idx;
    idx = new Map();
    let text = '';
    try { text = fs.readFileSync(dayFile(day), 'utf8'); } catch { /* new day */ }
    for (const ev of parseLines(text)) idx.set(ev.id, payloadHash(ev));
    dayIndex.set(day, idx);
    return idx;
  }

  /** Append one event unless the log already holds this id with this payload. Returns true if appended. */
  function appendEvent(ev) {
    if (!ev || typeof ev.id !== 'string' || typeof ev.t !== 'number' || !Number.isFinite(ev.t)) return false;
    if (ev.t < MIN_EVENT_T || ev.t > clock() + 86400) {
      // A time of 0 (or far future) is a data bug upstream, not history: never log it.
      if (!warnedBadT) { warnedBadT = true; console.error(`cosmos store: skipped an event with an impossible time (${ev.type} t=${ev.t}); further ones are skipped silently`); }
      return false;
    }
    const day = localDay(ev.t);
    const idx = indexFor(day);
    const h = payloadHash(ev);
    if (idx.get(ev.id) === h) return false;
    idx.set(ev.id, h);
    let arr = pendingLines.get(day);
    if (!arr) { arr = []; pendingLines.set(day, arr); }
    arr.push(logLine(ev));
    pendingCount += 1;
    if (pendingCount >= 5000) { flushEvents(); return true; }   // backfill: don't hold MBs in memory
    if (!eventTimer) eventTimer = later(eventFlushMs, () => { eventTimer = null; flushEvents(); });
    return true;
  }

  function invalidateKeyframesFrom(day) {
    for (const k of [...keyframes.keys()]) if (k >= day) keyframes.delete(k);
  }

  function flushEvents() {
    if (eventTimer) { clearTimeout(eventTimer); timers.delete(eventTimer); eventTimer = null; }
    if (pendingLines.size === 0) return eventFlushing;
    const batch = [...pendingLines.entries()];
    pendingLines.clear();
    pendingCount = 0;
    eventFlushing = eventFlushing.then(async () => {
      await fsp.mkdir(P.events, { recursive: true });
      for (const [day, lines] of batch) {
        try {
          await fsp.appendFile(dayFile(day), lines.join('\n') + '\n');
        } catch (err) {
          logWriteError(`event log ${day}`)(err);
        }
        invalidateKeyframesFrom(day);
      }
    });
    return eventFlushing;
  }

  function listDays() {
    let names = [];
    try { names = fs.readdirSync(P.events); } catch { return []; }
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort();
  }

  async function readDay(day) {
    let text = '';
    try { text = await fsp.readFile(dayFile(day), 'utf8'); } catch { return []; }
    return collapseAndSort(parseLines(text));
  }

  /** Events with from <= t <= to, re-emits collapsed (last wins), in time order. */
  async function* readEvents(from, to) {
    await flushEvents();
    const first = localDay(from);
    const last = localDay(to);
    for (const day of listDays()) {
      if (day < first || day > last) continue;
      for (const ev of await readDay(day)) if (ev.t >= from && ev.t <= to) yield ev;
    }
  }

  /** One event by id from the log (newest day first). Null if absent. */
  async function findEvent(id) {
    if (typeof id !== 'string' || !id) return null;
    await flushEvents();
    const needle = `"id":${JSON.stringify(id)}`;
    const days = listDays().reverse();
    for (const day of days) {
      let text = '';
      try { text = await fsp.readFile(dayFile(day), 'utf8'); } catch { continue; }
      if (!text.includes(needle)) continue;
      let found = null;
      for (const ev of parseLines(text)) if (ev.id === id) found = ev;   // last copy wins
      if (found) return found;
    }
    return null;
  }

  /**
   * HistoryBundle for [from, to] (§2.4). `base` is every session born by
   * `from`, folded from the log with fold.mjs (the client's scrubber runs the
   * same reducer), plus cache-only remnants older than the log.
   */
  async function history(from, to, settingsArg = currentSettings) {
    let fold = foldImpl;
    if (!fold) {
      try { fold = await import('../web/src/shared/fold.mjs'); } catch (err) {
        const e = new Error('History needs web/src/shared/fold.mjs, which could not be loaded.');
        e.status = 503; e.code = 'history-unavailable'; e.cause = err;
        throw e;
      }
    }
    await flushEvents();
    const days = listDays();
    const fromDay = localDay(from);
    const toDay = localDay(to);

    // Start from the newest keyframe that ends before `from`.
    let recs = new Map();
    let startIdx = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const kf = keyframes.get(days[i]);
      if (kf && days[i] < fromDay) { recs = structuredClone(kf.recs); startIdx = i + 1; break; }
    }

    const events = [];
    let truncated = false;
    const applyOne = (ev) => {
      if (ev.type === 'born') {
        if (!recs.has(ev.sid)) recs.set(ev.sid, fold.recordFromBorn(ev));
        return;
      }
      const rec = recs.get(ev.sid);
      if (rec) fold.applyEvent(rec, ev, settingsArg);
    };

    for (let i = startIdx; i < days.length; i++) {
      const day = days[i];
      if (day > toDay) break;
      const dayEvents = await readDay(day);
      for (const ev of dayEvents) {
        if (ev.t <= from) applyOne(ev);
        if (ev.t >= from && ev.t <= to) {
          if (events.length >= HISTORY_MAX_EVENTS) { truncated = true; continue; }
          const { src, seq, ...wire } = ev;
          events.push(wire);
        }
      }
      // A day entirely before `from` is a reusable keyframe.
      if (day < fromDay && dayStartS(nextDay(day)) <= from) {
        keyframes.set(day, { recs: structuredClone(recs) });
        while (keyframes.size > KEYFRAMES_MAX) keyframes.delete(keyframes.keys().next().value);
      }
    }

    const base = [];
    for (const rec of recs.values()) {
      const born = rec.times?.bornAt;
      if (typeof born === 'number' && born > from) continue;
      const r = structuredClone(rec);
      fold.advance(r, from, settingsArg);
      const pl = place(r);
      if (pl) r.place = pl;
      base.push(liteRecord(r));
    }
    // Remnants the log never saw (older than Cosmos's first run).
    for (const snap of loadSnapshots().values()) {
      if (recs.has(snap.id)) continue;
      const last = snap.times?.lastActivity;
      if (typeof last !== 'number' || last > from) continue;
      const r = liteRecord(snap);
      try { fold.advance(r, from, settingsArg); } catch { /* keep the cached state */ }
      const pl = place(r);
      if (pl) r.place = pl;
      base.push(r);
    }
    return { from, to, base, events, truncated };
  }

  // ---------------------------------------------------------------- layout (§3.4)
  const layout = (() => {
    const l = readJsonSync(P.layout);
    if (l && l.v === 1 && l.arms && l.sessions) return l;
    return { v: 1, arms: {}, sessions: {} };
  })();
  let layoutTimer = null;
  let committed = false;
  const provisional = new Map();      // sid -> { armKey, bornAt, wt }

  // Counters derived from what is already stored.
  const armNext = new Map();          // armKey -> next idx
  const clusterNext = new Map();      // armKey\nname -> next clusterIdx
  for (const s of Object.values(layout.sessions)) {
    if (!s || !s.arm) continue;
    armNext.set(s.arm, Math.max(armNext.get(s.arm) ?? 0, (s.idx ?? -1) + 1));
    if (s.cluster) {
      const ck = `${s.arm}\n${s.cluster}`;
      clusterNext.set(ck, Math.max(clusterNext.get(ck) ?? 0, (s.clusterIdx ?? -1) + 1));
    }
  }

  function saveLayoutSoon() {
    if (!layoutTimer) layoutTimer = later(layoutDebounceMs, writeLayout);
  }
  function writeLayout() {
    layoutTimer = null;
    return writeAtomic(P.layout, JSON.stringify(layout)).catch(logWriteError('layout.json'));
  }

  function pinnedSlots() {
    const pinned = new Map();     // slot -> armKey
    for (const [k, v] of Object.entries(currentSettings.arms || {})) {
      if (v && Number.isInteger(v.slot)) pinned.set(v.slot, k);
    }
    return pinned;
  }

  function armSlot(key) {
    const over = currentSettings.arms?.[key]?.slot;
    if (Number.isInteger(over)) return over;
    if (Number.isInteger(layout.arms[key])) return layout.arms[key];
    const used = new Set(Object.values(layout.arms));
    for (const s of pinnedSlots().keys()) used.add(s);
    const start = Math.floor(hash01(key) * ARM_SLOTS) % ARM_SLOTS;
    let slot = start;
    for (let i = 0; i < ARM_SLOTS; i++) {
      const s = (start + 5 * i) % ARM_SLOTS;     // 5 and 12 are coprime: visits every slot once
      if (!used.has(s)) { slot = s; break; }
    }
    // More than 12 arms: the hash slot is shared (documented gap).
    layout.arms[key] = slot;
    saveLayoutSoon();
    return slot;
  }

  function assign(sid, armKey, wt) {
    const idx = armNext.get(armKey) ?? 0;
    armNext.set(armKey, idx + 1);
    let cluster = null; let clusterIdx = 0;
    if (wt) {
      const ck = `${armKey}\n${wt}`;
      clusterIdx = clusterNext.get(ck) ?? 0;
      clusterNext.set(ck, clusterIdx + 1);
      cluster = wt;
    }
    layout.sessions[sid] = { slot: armSlot(armKey), idx, cluster, clusterIdx, arm: armKey };
    saveLayoutSoon();
    return layout.sessions[sid];
  }

  /**
   * Stable place of a session: { slot, idx, cluster, clusterIdx }. Cheap and
   * idempotent; call it whenever. Before commitLayout() (the first backfill),
   * new sessions get provisional numbers; commitLayout() fixes them in birth
   * order, and they never change after that.
   */
  function place(rec) {
    const sid = rec?.id;
    const armKey = rec?.arm?.key;
    if (!sid || !armKey) return null;
    const stored = layout.sessions[sid];
    if (stored) {
      return { slot: armSlot(stored.arm ?? armKey), idx: stored.idx, cluster: stored.cluster ?? null, clusterIdx: stored.clusterIdx ?? 0 };
    }
    const wt = rec.worktree?.name ?? null;
    if (committed) {
      const s = assign(sid, armKey, wt);
      return { slot: s.slot, idx: s.idx, cluster: s.cluster, clusterIdx: s.clusterIdx };
    }
    const bornAt = rec.times?.bornAt ?? Infinity;
    provisional.set(sid, { armKey, bornAt, wt });
    let rank = 0; let cRank = 0;
    for (const [osid, p] of provisional) {
      if (osid === sid || p.armKey !== armKey) continue;
      const before = p.bornAt < bornAt || (p.bornAt === bornAt && osid < sid);
      if (before) { rank++; if (wt && p.wt === wt) cRank++; }
    }
    return {
      slot: armSlot(armKey),
      idx: (armNext.get(armKey) ?? 0) + rank,
      cluster: wt,
      clusterIdx: wt ? (clusterNext.get(`${armKey}\n${wt}`) ?? 0) + cRank : 0,
    };
  }

  /** End of the first backfill: give provisional sessions their final places, by birth. */
  function commitLayout() {
    if (committed) return;
    committed = true;
    const list = [...provisional.entries()].filter(([sid]) => !layout.sessions[sid]);
    list.sort((a, b) => (a[1].bornAt - b[1].bornAt) || (a[0] < b[0] ? -1 : 1));
    for (const [sid, p] of list) assign(sid, p.armKey, p.wt);
    provisional.clear();
    saveLayoutSoon();
  }

  // ---------------------------------------------------------------- explain usage
  function emptyUsage() {
    return { calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 }, firstAt: null, lastAt: null, log: [] };
  }
  let explain = (() => {
    const e = readJsonSync(P.explain);
    return e && typeof e.calls === 'number' && e.tokens ? e : emptyUsage();
  })();

  function explainUsage() { return structuredClone(explain); }

  /** entry: { t, eventId, model, usage: { input, output, cacheRead, cacheCreate, total } } */
  function addExplainUsage(entry) {
    const u = entry.usage || {};
    const n = (x) => (Number.isFinite(x) ? x : 0);
    explain.calls += 1;
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreate', 'total']) explain.tokens[k] += n(u[k]);
    explain.firstAt = explain.firstAt ?? entry.t;
    explain.lastAt = entry.t;
    explain.log.push({ t: entry.t, eventId: entry.eventId ?? null, model: entry.model ?? null,
      usage: { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheCreate: n(u.cacheCreate), total: n(u.total) } });
    if (explain.log.length > EXPLAIN_LOG_MAX) explain.log.splice(0, explain.log.length - EXPLAIN_LOG_MAX);
    writeAtomic(P.explain, JSON.stringify(explain, null, 2)).catch(logWriteError('explain-usage.json'));
    return explainUsage();
  }

  // ---------------------------------------------------------------- settings + launch config (§3.9)
  function setSettings(s) { currentSettings = s || SETTINGS_DEFAULTS; }

  /** cache/launch-config, read by hooks/cosmos-offer.sh. Plain text, two lines. */
  function writeLaunchConfig(launch = currentSettings.launch) {
    const enabled = launch?.enabled === false ? 0 : 1;
    const eps = (Array.isArray(launch?.entrypoints) ? launch.entrypoints : [])
      .filter((e) => /^[a-z0-9-]+$/.test(e));
    return writeAtomic(P.launch, `enabled=${enabled}\nentrypoints=${eps.join(' ')}\n`);
  }

  // ---------------------------------------------------------------- flush
  async function flush() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    stateTimer = null; layoutTimer = null; eventTimer = null;
    snapTimers.clear();
    const jobs = [writeState(), writeLayout(), flushEvents()];
    for (const sid of [...pendingSnaps.keys()]) jobs.push(writeSnap(sid));
    await Promise.all(jobs);
    await Promise.all([...writeChains.values()].map((p) => p.catch(() => {})));
  }

  ensureDir(cacheDir);

  return {
    loadState, saveState,
    loadSnapshots, saveSnapshot,
    isCacheOnly,
    appendEvent, readEvents, findEvent, history,
    place, commitLayout,
    explainUsage, addExplainUsage,
    setSettings, writeLaunchConfig,
    flushEvents, flush,
    paths: P,
  };
}

