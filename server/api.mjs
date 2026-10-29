// Cosmos HTTP API and live stream (GALAXY_CONTRACT §3.6).
//
// Read endpoints are GET. Every state-changing or text-revealing endpoint is a
// POST that must pass security.postOk (our Host, our Origin, the per-run token,
// a JSON body <= 64 KB). No CORS headers are ever sent. Responses never carry
// an event's `src` (transcript byte position); only diag.mjs uses it.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { FEED_TYPES, DIAG_TYPES, EV } from '../web/src/shared/schema.mjs';
import { SETTINGS_DEFAULTS, validateSettings, validateLimits } from '../web/src/shared/settings.mjs';
import { liteRecord } from './store.mjs';
import { httpError } from './security.mjs';

const BODY_MAX = 64 * 1024;
const FEED_MAX = 300;          // routine events (tool-call, file-touch)
const SIGNAL_MAX = 600;        // every other feed/diag type, capped separately
const ROUTINE_TYPES = new Set([EV.TOOL_CALL, EV.FILE_TOUCH]);

/** decodeURIComponent for a path id; a malformed escape or odd id is a 400, not a 500. */
function decodeId(raw) {
  let v;
  try { v = decodeURIComponent(raw); } catch { throw httpError(400, 'bad-id', 'That id is not valid.'); }
  if (!v || v.length > 512 || v.includes('\0')) throw httpError(400, 'bad-id', 'That id is not valid.');
  return v;
}
const RING_MAX = 5000;
const SESSION_EVENTS_MAX = 500;
const SESSION_EVENTS_LOOKBACK_S = 14 * 86400;
const COALESCE_MS = 500;
const TOTALS_MS = 1000;
const PING_MS = 15000;
const HISTORY_MAX_S = 8 * 86400;
const SSE_BUFFER_MAX = 8 * 1024 * 1024;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const DEFAULT_LIMITS = { v: 1, default: 200000, rules: [{ match: 'claude-*-5-5', limit: 1000000 }, { match: '*[1m]', limit: 1000000 }] };

// ------------------------------------------------------------------ file helpers

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** cosmos/settings.json, validated over the defaults. A bad field falls back to its default. */
export function loadSettings(settingsPath) {
  const raw = readJson(settingsPath);
  const { value, errors } = validateSettings(raw ?? {}, SETTINGS_DEFAULTS);
  if (raw && errors.length) console.error(`cosmos: settings.json: ${errors.length} field(s) ignored (${errors[0]})`);
  return value;
}

/** cosmos/limits.json (DATA-CORE writes the default file). */
export function loadLimits(limitsPath) {
  const raw = readJson(limitsPath);
  if (!raw) return structuredClone(DEFAULT_LIMITS);
  const { value } = validateLimits(raw);
  return value ?? structuredClone(DEFAULT_LIMITS);
}

function wire(ev) {
  if (!ev) return ev;
  const { src, ...rest } = ev;
  return rest;
}

function emptyTotals(day) {
  return {
    day,
    byMode: { 'needs-me': 0, 'my-move': 0, working: 0, idle: 0, dead: 0, crashed: 0 },
    live: 0, sessions: 0, remnants: 0,
    tokensToday: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
    errorsToday: 0, denialsToday: 0, stormsToday: 0, compactionsToday: 0, shipsToday: 0,
    explain: { calls: 0, tokens: 0 },
  };
}

function localDayStr(tS) {
  const d = new Date(tS * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------------------------------------------------------ factory

export function createApi({
  model, store, security, settingsPath, limitsPath, root, port,
  diag = null, claudeSettings = null,
  settings = null, limits = null,
  clock = () => Date.now() / 1000,
}) {
  let current = settings ?? loadSettings(settingsPath);
  let currentLimits = limits ?? loadLimits(limitsPath);
  let loaded = false;
  let loadingInfo = { done: false, files: null, filesDone: null };
  let seq = 0;
  // A random id per server run (NOT the POST token). The page compares it on
  // every reconnect: a new id means a restart, so it refetches the snapshot
  // and knows its old POST token is void.
  const runId = crypto.randomBytes(6).toString('hex');
  let clientSeq = 0;

  const routine = [];              // tool-call/file-touch, sorted by t, <= FEED_MAX
  const signals = [];              // every other FEED/DIAG type, sorted by t, <= SIGNAL_MAX
  const ring = [];                 // live wire events with seq, <= RING_MAX
  const clients = new Set();       // { res, cid, visible }
  const modes = new Map();         // sid -> last mode sent
  const lastSent = new Map();      // sid -> ms of last 'session' push
  const sessionTimers = new Map(); // sid -> timer
  let totalsTimer = null;
  let lastTotalsAt = 0;
  let lastTotalsJson = '';

  const ping = setInterval(() => broadcast('ping', { serverTime: clock() }), PING_MS);
  ping.unref?.();

  // ---------------------------------------------------------------- responses

  function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
    res.end(res.req?.method === 'HEAD' ? undefined : body);
  }
  function fail(res, status, code, message, extra) {
    json(res, status, { error: code, message, ...(extra || {}) });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > BODY_MAX) {
        reject(httpError(413, 'too-large', 'The request body is larger than 64 KB.'));
        req.resume();
        return;
      }
      const chunks = []; let size = 0; let over = false;
      req.on('data', (c) => {
        if (over) return;
        size += c.length;
        if (size > BODY_MAX) { over = true; reject(httpError(413, 'too-large', 'The request body is larger than 64 KB.')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (over) return;
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') { resolve({}); return; }
        try {
          const v = JSON.parse(text);
          if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
          resolve(v);
        } catch {
          reject(httpError(400, 'bad-json', 'The request body must be a JSON object.'));
        }
      });
      req.on('error', reject);
    });
  }

  // ---------------------------------------------------------------- data views

  function lite(rec) {
    const l = liteRecord(rec);
    const pl = store.place(rec);
    if (pl) l.place = pl;
    return l;
  }

  function totals() {
    if (!model || !loaded) {
      const t = emptyTotals(localDayStr(clock()));
      const u = store.explainUsage();
      t.explain = { calls: u.calls, tokens: u.tokens.total };
      return t;
    }
    const t = { ...model.totals() };
    const u = store.explainUsage();
    t.explain = { calls: u.calls, tokens: u.tokens.total };
    return t;
  }

  function snapshot() {
    const base = { v: 1, serverTime: clock(), seq, runId, settings: current, limits: currentLimits };
    if (!model) return null;
    if (!loaded) {
      const prog = (() => { try { return model.progress?.() ?? null; } catch { return null; } })();
      return { ...base, totals: totals(), sessions: [], recent: {}, events: [],
        loading: { done: false, files: prog?.files ?? loadingInfo.files, filesDone: prog?.filesDone ?? loadingInfo.filesDone } };
    }
    const sessions = [];
    const recent = {};
    for (const rec of model.sessions().values()) {
      sessions.push(lite(rec));
      try { recent[rec.id] = model.recent(rec.id); } catch { recent[rec.id] = { errors: [], toolCalls: [], subagents: [] }; }
    }
    return { ...base, totals: totals(), sessions, recent, events: feedList().map(wire), loading: { done: true } };
  }

  // ---------------------------------------------------------------- SSE

  function sseWrite(c, event, data, id) {
    if (c.res.writableLength > SSE_BUFFER_MAX) { c.res.destroy(); clients.delete(c); return; }
    c.res.write(`event: ${event}\n${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(event, data, id) {
    for (const c of clients) sseWrite(c, event, data, id);
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setKeepAlive?.(true);
    req.socket.setNoDelay?.(true);
    clientSeq += 1;
    const c = { res, cid: `${runId}-${clientSeq}`, visible: true };
    clients.add(c);
    sseWrite(c, 'hello', { serverTime: clock(), seq, runId, cid: c.cid, viewers: clients.size });
    const lastId = req.headers['last-event-id'];
    if (lastId !== undefined && loaded) {
      // ids are `${runId}:${seq}`; an id from another run is always a resync.
      const [rid, sn] = String(lastId).split(':');
      const n = Number.parseInt(sn ?? '', 10);
      const oldest = ring.length ? ring[0].seq : seq + 1;
      if (rid !== runId || !Number.isFinite(n) || n > seq || n < oldest - 1) {
        sseWrite(c, 'resync', { runId });
      } else {
        for (const ev of ring) if (ev.seq > n) sseWrite(c, 'ev', ev, `${runId}:${ev.seq}`);
      }
    }
    const drop = () => { clients.delete(c); };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  // ---------------------------------------------------------------- model callbacks

  // Routine and signal events are capped separately, so a flood of tool calls
  // can never push today's storms, compactions, needs-me or errors out.
  function upsertFeed(ev) {
    if (!FEED_TYPES.has(ev.type) && !DIAG_TYPES.has(ev.type)) return;
    const list = ROUTINE_TYPES.has(ev.type) ? routine : signals;
    const max = list === routine ? FEED_MAX : SIGNAL_MAX;
    const i = list.findIndex((e) => e.id === ev.id);
    if (i !== -1) { list[i] = ev; return; }
    if (list.length >= max && ev.t < list[0].t) return;
    // Insert by time (backfill arrives out of order).
    let lo = 0; let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t <= ev.t) lo = mid + 1; else hi = mid; }
    list.splice(lo, 0, ev);
    if (list.length > max) list.splice(0, list.length - max);
  }
  /** Both lists merged by time, newest last. */
  function feedList() {
    const out = []; let a = 0; let b = 0;
    while (a < routine.length || b < signals.length) {
      if (b >= signals.length || (a < routine.length && routine[a].t <= signals[b].t)) out.push(routine[a++]);
      else out.push(signals[b++]);
    }
    return out;
  }

  /** Every model event (backfill and live). Server wires store.appendEvent alongside. */
  function onEvent(ev) {
    if (!ev || !ev.id) return;
    if (ev.type !== EV.METRICS) upsertFeed(ev);
    if (!loaded || !ev.live) return;
    seq += 1;
    const w = { ...wire(ev), seq };
    ring.push(w);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    broadcast('ev', w, `${runId}:${seq}`);
  }

  function pushSession(sid) {
    sessionTimers.delete(sid);
    const rec = model?.get(sid);
    if (!rec) return;
    lastSent.set(sid, Date.now());
    modes.set(sid, rec.state?.mode);
    broadcast('session', lite(rec));
  }

  /** A record changed. NEEDS ME enter/leave goes out now; the rest at most every 500 ms per session. */
  function onChange(sid) {
    if (!loaded || !model) return;
    const rec = model.get(sid);
    if (!rec) return;
    const was = modes.get(sid);
    const now = rec.state?.mode;
    const flip = (was === 'needs-me') !== (now === 'needs-me');
    if (flip) {
      const t = sessionTimers.get(sid);
      if (t) { clearTimeout(t); sessionTimers.delete(sid); }
      pushSession(sid);
    } else if (!sessionTimers.has(sid)) {
      const wait = Math.max(0, (lastSent.get(sid) ?? 0) + COALESCE_MS - Date.now());
      const t = setTimeout(() => pushSession(sid), wait);
      t.unref?.();
      sessionTimers.set(sid, t);
    }
    scheduleTotals();
  }

  function scheduleTotals() {
    if (totalsTimer) return;
    const wait = Math.max(0, lastTotalsAt + TOTALS_MS - Date.now());
    totalsTimer = setTimeout(() => {
      totalsTimer = null;
      lastTotalsAt = Date.now();
      const t = totals();
      const j = JSON.stringify(t);
      if (j !== lastTotalsJson) { lastTotalsJson = j; broadcast('totals', t); }
    }, wait);
    totalsTimer.unref?.();
  }

  /** Backfill finished: from now on events and sessions stream live. Clients refetch the snapshot. */
  async function setLoaded() {
    loaded = true;
    loadingInfo = { done: true, files: loadingInfo.files, filesDone: loadingInfo.files };
    if (model) for (const rec of model.sessions().values()) modes.set(rec.id, rec.state?.mode);
    // After a restart the reader resumes from saved offsets and re-emits nothing,
    // so the feed is refilled from the event log (last 2 days).
    if (routine.length < FEED_MAX || signals.length < SIGNAL_MAX) {
      try {
        const now = clock();
        for await (const ev of store.readEvents(now - 2 * 86400, now + 60)) if (ev.type !== EV.METRICS) upsertFeed(ev);
      } catch (err) {
        console.error('cosmos: could not refill the activity feed:', err.code || err.message);
      }
    }
    broadcast('resync', {});
    scheduleTotals();
  }
  function setLoading(info) { loadingInfo = { ...loadingInfo, ...info, done: false }; }

  // ---------------------------------------------------------------- handlers

  async function sessionEvents(rec) {
    const now = clock();
    const last = rec.times?.lastActivity ?? now;
    const from = Math.max(rec.times?.bornAt ?? last - SESSION_EVENTS_LOOKBACK_S, last - SESSION_EVENTS_LOOKBACK_S);
    const out = [];
    for await (const ev of store.readEvents(from - 1, Math.max(now, last) + 1)) {
      if (ev.sid !== rec.id || ev.type === EV.METRICS) continue;
      out.push(wire(ev));
      if (out.length > SESSION_EVENTS_MAX * 2) out.splice(0, out.length - SESSION_EVENTS_MAX);
    }
    return out.slice(-SESSION_EVENTS_MAX);
  }

  function saveSettings(body) {
    const errors = [];
    let nextSettings = current;
    let nextLimits = currentLimits;
    if (body.settings !== undefined) {
      const r = validateSettings(body.settings, current);
      errors.push(...r.errors);
      nextSettings = r.value;
    }
    if (body.limits !== undefined) {
      const r = validateLimits(body.limits);
      errors.push(...r.errors);
      if (r.value) nextLimits = r.value;
    }
    if (errors.length) {
      return { status: 400, body: { error: 'invalid', message: 'Nothing was saved: some values are not allowed.', settings: current, limits: currentLimits, errors } };
    }
    if (body.settings !== undefined) writeJsonAtomic(settingsPath, nextSettings);
    if (body.limits !== undefined) writeJsonAtomic(limitsPath, nextLimits);
    current = nextSettings;
    currentLimits = nextLimits;
    try { model?.setSettings?.(current); } catch (err) { console.error('cosmos: model.setSettings failed:', err.message); }
    if (body.limits !== undefined) { try { model?.setLimits?.(currentLimits); } catch (err) { console.error('cosmos: model.setLimits failed:', err.message); } }
    store.setSettings(current);
    store.writeLaunchConfig(current.launch).catch((err) => console.error('cosmos: launch-config:', err.code || err.message));
    broadcast('settings', { settings: current, limits: currentLimits });
    return { status: 200, body: { settings: current, limits: currentLimits, errors: [] } };
  }

  function needModel(res) {
    if (model) return true;
    fail(res, 503, 'data-unavailable', 'The data layer is not running, so there is no session data yet.');
    return false;
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' || m === 'HEAD') {
      if (p === '/api/viewers') {
        // Only pages the owner can actually see count (a hidden tab reports visible:false).
        let n = 0; for (const c of clients) if (c.visible) n += 1;
        const body = `{"viewers":${n}}`;
        res.writeHead(200, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
        res.end(m === 'HEAD' ? undefined : body);
        return;
      }
      if (p === '/api/events') { if (m === 'HEAD') { fail(res, 405, 'method', 'Use GET.'); return; } openStream(req, res); return; }
      if (p === '/api/snapshot') { if (!needModel(res)) return; json(res, 200, snapshot()); return; }
      if (p === '/api/settings') { json(res, 200, { settings: current, limits: currentLimits, defaults: SETTINGS_DEFAULTS }); return; }
      if (p === '/api/history') {
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw httpError(400, 'bad-range', 'from and to must be epoch seconds with from < to.');
        if (to - from > HISTORY_MAX_S) throw httpError(400, 'range-too-long', 'A history range can be at most 8 days.');
        json(res, 200, await store.history(from, to, current));
        return;
      }
      let mm = p.match(/^\/api\/session\/([^/]+)$/);
      if (mm) {
        if (!needModel(res)) return;
        const sid = decodeId(mm[1]);
        const rec = model.get(sid);
        if (!rec) throw httpError(404, 'not-found', 'No session with that id.');
        const out = { ...rec };
        const pl = store.place(rec);
        if (pl) out.place = pl;
        try { out.recent = model.recent(sid); } catch { out.recent = { errors: [], toolCalls: [], subagents: [] }; }
        out.events = await sessionEvents(rec);
        json(res, 200, out);
        return;
      }
      mm = p.match(/^\/api\/diag\/([^/]+)$/);
      if (mm) {
        if (!diag) throw httpError(503, 'data-unavailable', 'Diagnostics need the data layer.');
        const rep = await diag.report(decodeId(mm[1]));
        if (!rep) throw httpError(404, 'not-found', 'That event is not in Cosmos\'s data.');
        json(res, 200, rep);
        return;
      }
      if (p === '/api/claude-settings') {
        if (!claudeSettings) throw httpError(503, 'unavailable', 'Claude Code settings are not available.');
        const r = claudeSettings.read();
        json(res, 200, { cleanupPeriodDays: r.cleanupPeriodDays, launchHook: r.launchHook, path: r.path });
        return;
      }
      if (p === '/api/claude-settings/preview') {
        if (!claudeSettings) throw httpError(503, 'unavailable', 'Claude Code settings are not available.');
        json(res, 200, claudeSettings.preview(url.searchParams.get('change'), url.searchParams.get('value')));
        return;
      }
      fail(res, 404, 'not-found', 'No such API endpoint.');
      return;
    }

    if (m === 'POST') {
      if (!security.postOk(req)) { req.resume(); fail(res, 403, 'forbidden', 'This request did not come from the Cosmos page.'); return; }
      const body = await readBody(req);
      if (p === '/api/visibility') {
        const cid = typeof body.cid === 'string' ? body.cid : '';
        for (const c of clients) if (c.cid === cid) c.visible = body.visible === true;
        json(res, 200, { ok: true });
        return;
      }
      if (p === '/api/settings') {
        const r = saveSettings(body);
        json(res, r.status, r.body);
        return;
      }
      if (p === '/api/claude-settings/apply') {
        if (!claudeSettings) throw httpError(503, 'unavailable', 'Claude Code settings are not available.');
        const r = claudeSettings.apply(body.change, body.value, body.expectHash);
        console.log(`cosmos: ${claudeSettings.path} ${r.noop ? 'already had' : 'updated:'} ${body.change}=${body.value}${r.backupPath ? ` (backup ${r.backupPath})` : ''}`);
        json(res, 200, r);
        return;
      }
      let mm = p.match(/^\/api\/diag\/([^/]+)\/error-text$/);
      if (mm) {
        if (!diag) throw httpError(503, 'data-unavailable', 'Diagnostics need the data layer.');
        const r = await diag.errorText(decodeId(mm[1]));
        if (!r) throw httpError(404, 'no-error-text', 'There is no error text to show for this event (it is not a tool error, or its transcript line is gone).');
        json(res, 200, r);
        return;
      }
      mm = p.match(/^\/api\/diag\/([^/]+)\/explain$/);
      if (mm) {
        if (!diag) throw httpError(503, 'data-unavailable', 'Diagnostics need the data layer.');
        if (body.confirm !== true) throw httpError(400, 'confirm', 'Explain costs tokens; send { "confirm": true } after showing the estimate.');
        json(res, 200, await diag.explain(decodeId(mm[1])));
        return;
      }
      fail(res, 404, 'not-found', 'No such API endpoint.');
      return;
    }

    if (m === 'OPTIONS') { fail(res, 405, 'method', 'Not allowed.'); return; }
    res.setHeader('Allow', 'GET, HEAD, POST');
    fail(res, 405, 'method', 'Not allowed.');
  }

  /** Answers /api/* (except the Gate 1 /api/replay). Returns true if it answered. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/') || url.pathname === '/api/replay') return false;
    if (!security.hostOk(req)) { fail(res, 403, 'forbidden', 'Forbidden.'); return true; }
    try {
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return true; }
      if (err && err.status) fail(res, err.status, err.code || 'error', err.message, err.extra);
      else {
        console.error('cosmos api:', err?.stack || err);
        fail(res, 500, 'internal', 'Something went wrong inside Cosmos.');
      }
    }
    return true;
  }

  function close() {
    clearInterval(ping);
    for (const t of sessionTimers.values()) clearTimeout(t);
    sessionTimers.clear();
    if (totalsTimer) clearTimeout(totalsTimer);
    for (const c of clients) { try { c.res.end(); } catch { /* gone */ } }
    clients.clear();
  }

  return {
    handle, viewers: () => clients.size, close, runId,
    onEvent, onChange, setLoaded, setLoading,
    settings: () => current, limits: () => currentLimits,
    get loaded() { return loaded; },
    // root/port kept for parity with the contract signature (static serving stays in server.mjs).
    root, port,
  };
}
