// Cosmos model: sessions, state machine, metrics and events (GALAXY_CONTRACT §3.2,
// DATA_SPEC §2-§4). Folds the reader's slim entries into one SessionRecord per
// main transcript and emits CosmosEvents.
//
// READ-ONLY toward Claude Code. The only file this module may write is the
// default `limits.json` (once, if missing, in the Cosmos folder).
//
// Design notes
// - Backfill (first scan): every historical event is collected in a Map by id
//   (re-emits replace), then sorted by time and emitted with live:false once the
//   scan ends. Storms and the metrics history are rebuilt in time order then.
// - Live: events are emitted as they happen (live:true). NEEDS ME enter/leave
//   happens synchronously inside the registry / entries callbacks.
// - Fork dedupe: the reader reads files oldest-first; the first file to carry a
//   message.id (tokens) or an entry uuid (events, counts) owns it. Copies still
//   feed the copying session's tail (state machine), never its numbers.
// - The reader is always started with state:null (full replay, ~2 s for 1.7 GB
//   warm). Resuming from saved offsets would also need the per-session internals
//   (dedupe sets, pending tools, tails), which the snapshot cache does not hold.

import path from 'node:path';
import { createReader } from './reader.mjs';
import {
  MODE, SUB, BADGE, REMNANT, ORIGIN, EV, DAY_S, eventId, idleFraction, idleK,
} from '../web/src/shared/schema.mjs';

import {
  COSMOS_ROOT, DEFAULT_LIMITS, globToRegExp, contextLimit, stripWorktree, worktreeName, longestPrefix,
  mergeSettings, loadLimits, dayStart, localDayString, ms, lowerBound, insertSorted,
} from './model-helpers.mjs';
import { createArms } from './model-arms.mjs';

export { DEFAULT_LIMITS, globToRegExp, contextLimit, stripWorktree, worktreeName, longestPrefix };

const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const ARCHIVE_TOOL = 'mcp__ccd_session_mgmt__archive_session';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const EDIT_OPS = { Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'notebook', Read: 'read' };
const SYNTH = '<synthetic>';
const RECENT_KEEP_S = 600;
const RESUME_GAP_S = 60;          // my-move whose start moved later by this much is logged again (session reopened)
const EVENT_INDEX_S = 7 * DAY_S;
const METRICS_EVERY_S = 60;
const HOURLY_SPAN_S = 48 * 3600;
const FILES_MAX = 200;
const FILES_LITE = 24;

// ---------------------------------------------------------------------------

export function createModel(opts = {}) {
  const clock = opts.clock || (() => Date.now() / 1000);
  const store = opts.store || null;
  const onEvent = opts.onEvent || (() => {});
  const onChange = opts.onChange || (() => {});
  const excludePrefix = opts.excludeCwdPrefix ?? path.join(COSMOS_ROOT, 'cache') + '/';
  const limitsPath = opts.limitsPath === undefined ? path.join(COSMOS_ROOT, 'limits.json') : opts.limitsPath;
  let settings = mergeSettings(opts.settings);
  const arms = createArms({ getSettings: () => settings, sessions: () => S.values() });
  const { armOf } = arms;
  let limits = loadLimits(limitsPath);

  // ----- global state
  const S = new Map();              // sid -> session internals
  const excluded = new Set();
  const snapRecs = new Map();       // sid -> cached SessionRecord (cache-only)
  const msgs = new Map();           // message.id -> { file, owner (session|ship), input, output, cacheRead, cacheCreate, t }
  const uuidOwner = new Map();      // entry uuid -> sid
  const calls = new Map();          // tool_use id -> call
  const ships = new Map();          // agentId -> ship
  const agentLink = new Map();      // agentId -> sid (from the parent's Agent tool_result)
  const peakByModel = new Map();
  const registryBySid = new Map();
  let registryList = [];
  let s6 = new Map();
  const titleFiles = new Map();     // sid -> { customTitle, released }
  const evIndex = new Map();        // id -> event (last 7 days)
  let backfilling = true;
  const bf = new Map();             // backfill events by id
  const changed = new Set();
  let reader = null;
  let tickTimer = null;
  let lastPrune = 0;
  let stopped = false;
  const stats = { backfillMs: 0, readerMs: 0, events: 0 };

  // =====================================================================
  // Events

  function emit(type, sess, key, t, data, extra) {
    const ev = { id: eventId(type, sess.id, key), type, t, sid: sess.id, ship: extra?.ship ?? null, live: !backfilling, data };
    if (extra?.src) ev.src = extra.src;
    if (backfilling) { bf.set(ev.id, ev); return ev; }
    indexEvent(ev);
    send(ev);
    return ev;
  }
  /** Consumers get a copy: internal events keep being updated for re-emits. */
  function send(ev) {
    stats.events++;
    const copy = { ...ev, data: { ...ev.data } };
    try { onEvent(copy); } catch (err) { console.error('[cosmos model] onEvent failed:', err); }
  }
  function reemit(ev) {
    if (!ev) return;
    if (backfilling) { bf.set(ev.id, ev); return; }
    ev.live = true;
    indexEvent(ev);
    send(ev);
  }
  function indexEvent(ev) {
    if (ev.t >= clock() - EVENT_INDEX_S) evIndex.set(ev.id, ev);
  }

  // =====================================================================
  // Sessions

  function newSession(sid) {
    return {
      id: sid, tfiles: new Set(), firstT: null, firstCopyT: null, lastT: null, lastCoreT: null,
      cwd: null, entrypoint: null, version: null, gitBranch: null,
      firstTurnOrigin: undefined, firstOriginKind: null, forkOfUuid: null, sawCore: false,
      titles: { custom: null, agentName: null, aiTitle: null },
      models: new Set(), model: null,
      own: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, daySpend: new Map(), tl: [],
      ctx: null, peak: 0, ctxTl: [], callTl: [], armMemo: null,
      compactions: new Map(), callCount: 0, turns: 0,
      errors: [], errIds: new Set(), errWindow: [], storm: null, stormTimes: [],
      files: new Map(), folders: new Map(), filesSig: 0, filesSigMetrics: -1,
      asst: [], recentOut: [], recentTools: [], recentErrors: [], recentCalls: [],
      tail: null, tailMsgId: null, tailEndTurn: false, prevEnded: true, pending: new Map(),
      lastToolName: null, archiveT: null, lastResult: null,
      lastMode: null, lastSub: null, lastModeT: null, modeTl: [], needs: null,
      state: null, stateSig: '', bornSig: '', bornEmitted: false, remnantEmitted: null,
      lastMetricsT: -Infinity, metricsSig: '', shipIds: new Set(), registryBorn: false,
      dirty: true, rec: null, activity: 0,
    };
  }
  function getSession(sid, create = true) {
    if (excluded.has(sid)) return null;
    let s = S.get(sid);
    if (!s && create) {
      s = newSession(sid); S.set(sid, s); snapRecs.delete(sid);
      for (const sh of ships.values()) if (sh.owner === sid) s.shipIds.add(sh.id);
    }
    return s || null;
  }
  function exclude(s) {
    excluded.add(s.id);
    S.delete(s.id);
    changed.delete(s.id);
    for (const [id, ev] of bf) if (ev.sid === s.id) bf.delete(id);
  }
  function touch(s) { s.dirty = true; changed.add(s.id); }

  function isExcludedCwd(cwd) { return typeof cwd === 'string' && excludePrefix && (cwd + '/').startsWith(excludePrefix); }

  // =====================================================================
  // Entries

  function onEntries(info, entries) {
    if (stopped) return;
    if (info.kind === 'main') mainEntries(info, entries);
    else shipEntries(info, entries);
    if (!backfilling) flushChanges();
  }

  function mainEntries(info, entries) {
    const s = getSession(info.sid);
    if (!s) return;
    s.tfiles.add(info.key);
    for (const e of entries) {
      if (e.cwd && !s.cwd) {
        s.cwd = e.cwd;
        if (isExcludedCwd(e.cwd)) { exclude(s); return; }
      }
      if (e.entrypoint && !s.entrypoint) s.entrypoint = e.entrypoint;
      if (e.version) s.version = e.version;
      if (e.gitBranch && !s.gitBranch) s.gitBranch = e.gitBranch;
      switch (e.type) {
        case 'custom-title': if (e.title) s.titles.custom = e.title; touch(s); continue;
        case 'agent-name': if (e.title) s.titles.agentName = e.title; touch(s); continue;
        case 'ai-title': if (e.title) s.titles.aiTitle = e.title; touch(s); continue;
        case 'user': case 'assistant': case 'attachment': case 'system': case 'api-request': break;
        default: continue;
      }
      let copy = false;
      if (e.uuid) {
        const o = uuidOwner.get(e.uuid);
        if (o && o !== s.id) { copy = true; if (!s.sawCore) s.forkOfUuid = o; }
        else if (!o) uuidOwner.set(e.uuid, s.id);
      }
      s.sawCore = true;
      if (e.t != null) {
        if (copy) { if (s.firstCopyT == null) s.firstCopyT = e.t; }
        else if (s.firstT == null || e.t < s.firstT) s.firstT = e.t;
        if (s.lastT == null || e.t > s.lastT) s.lastT = e.t;
        if (e.type !== 'api-request' && (s.lastCoreT == null || e.t > s.lastCoreT)) s.lastCoreT = e.t;
      }
      updateTail(s, e, info, copy);
      if (!copy) mainMetrics(s, e, info);
      else copyContext(s, e);
      touch(s);
    }
    if (!s.bornEmitted && s.sawCore) emitBorn(s);
  }

  /** A copied (forked) assistant entry is still this session's real context
   *  window (DATA_SPEC §4): it sets context and display model, never token
   *  credit, turns or peak-by-model. */
  function copyContext(s, e) {
    if (e.type !== 'assistant' || e.apiError || e.model === SYNTH || !e.usage) return;
    const used = e.usage.input + e.usage.cacheRead + e.usage.cacheCreate;
    if (!(used > 0)) return;
    const t = e.t ?? 0;
    if (!s.ctx || t >= s.ctx.t) s.ctx = { used, model: e.model, t };
    if (!s.model && e.model) s.model = e.model;
    if (used > s.peak) s.peak = used;
    s.ctxTl.push([t, used]);
  }

  // ----- tail (state machine input); copies included
  function updateTail(s, e, info, copy) {
    const t = e.t ?? s.lastT ?? 0;
    switch (e.type) {
      case 'api-request': s.tail = { kind: 'api', t }; return;
      case 'user': {
        if (e.results.length) {
          for (const r of e.results) {
            const p = s.pending.get(r.id);
            s.pending.delete(r.id);
            s.lastResult = { id: r.id, isError: r.isError, denial: !!e.toolDenialKind, t, name: p?.name ?? null };
            if (!copy && p && ASK_TOOLS.has(p.name)) trackerAskResolved(s, t, r.isError || !!e.toolDenialKind);
          }
          s.tail = e.interrupted ? { kind: 'interrupt', t } : { kind: 'result', t };
          if (e.interrupted && !copy) trackerMode(s, MODE.MY_MOVE, null, t);
          return;
        }
        if (e.isMeta || e.isCompactSummary) return;
        if (e.interrupted) { s.tail = { kind: 'interrupt', t }; s.pending.clear(); if (!copy) trackerMode(s, MODE.MY_MOVE, null, t); return; }
        if (e.prompt) {
          const ended = turnEnded(s.tail);
          s.prevEnded = ended || s.tail == null;
          s.pending.clear();
          s.tail = { kind: 'prompt', t, origin: e.originKind || e.turnOrigin || null, shutdown: e.shutdown, before: s.tail?.kind ?? null };
          if (!copy) trackerMode(s, MODE.WORKING, SUB.GENERATING, t);
        }
        return;
      }
      case 'assistant': {
        if (e.apiError || e.model === SYNTH) { s.tail = { kind: 'synthetic', t, apiError: e.apiError }; return; }
        if (e.msgId !== s.tailMsgId) { s.tailMsgId = e.msgId; s.tailEndTurn = false; }
        if (e.stop === 'end_turn' || e.stop === 'stop_sequence') s.tailEndTurn = true;
        for (const tu of e.tools) {
          if (!tu.id) continue;
          s.pending.set(tu.id, { name: tu.name, t, path: tu.path });
          s.lastToolName = tu.name;
          if (tu.name === ARCHIVE_TOOL) s.archiveT = t;
          if (!copy && ASK_TOOLS.has(tu.name)) trackerAsk(s, tu, t);
        }
        if (s.tailEndTurn) {
          s.pending.clear();
          if (!copy) trackerMode(s, MODE.MY_MOVE, null, t);
        }
        s.tail = { kind: 'assistant', t, endTurn: s.tailEndTurn };
        return;
      }
      case 'system': {
        if (e.subtype === 'stop_hook_summary') { s.tail = { kind: 'stop', t }; s.pending.clear(); if (!copy) trackerMode(s, MODE.MY_MOVE, null, t); }
        else if (e.subtype === 'api_error') s.tail = { kind: 'api_error', t, retryAttempt: e.retryAttempt, maxRetries: e.maxRetries };
        else if (e.subtype === 'compact_boundary') s.tail = { ...(s.tail || {}), kind: 'compact', t };
        return;
      }
      default: return; // attachments are transparent
    }
  }
  function turnEnded(tail) {
    if (!tail) return false;
    return tail.kind === 'stop' || tail.kind === 'interrupt' || (tail.kind === 'assistant' && tail.endTurn);
  }

  // ----- transcript tracker: per-turn history of working / my-move / needs-me
  function trackerMode(s, mode, sub, t) {
    if (s.needs && mode !== MODE.NEEDS_ME) needsEnd(s, t, mode === MODE.MY_MOVE ? 'interrupted' : 'answered');
    setMode(s, mode, sub, t, null);
  }
  function trackerAsk(s, tu, t) {
    if (s.needs) return;
    needsStart(s, tu.name === 'ExitPlanMode' ? SUB.PLAN : SUB.QUESTION, 'transcript', tu.name, t, tu.id);
  }
  function trackerAskResolved(s, t, denied) {
    if (s.needs && s.needs.source === 'transcript') needsEnd(s, t, denied ? 'denied' : 'answered');
    setMode(s, MODE.WORKING, SUB.GENERATING, t, null);
  }
  function needsStart(s, sub, source, tool, t, toolUseId) {
    const key = ms(t);
    s.needs = { key, t, sub, source, tool: tool ?? null, toolUseId: toolUseId ?? null };
    emit(EV.NEEDS_ME_START, s, key, t, { sub, source, tool: tool ?? null });
    s.lastMode = MODE.NEEDS_ME; s.lastSub = sub; s.lastModeT = t;
    s.modeTl.push([t, MODE.NEEDS_ME, sub]);
    if (!backfilling) emitMetrics(s, t, true);
  }
  function needsEnd(s, t, how) {
    const n = s.needs;
    if (!n) return;
    s.needs = null;
    const tt = Math.max(t, n.t);
    emit(EV.NEEDS_ME_END, s, n.key, tt, { sub: n.sub, waitedS: Math.max(0, tt - n.t), how });
  }
  /** Record a mode transition (working / my-move) as an event. Other modes use their own events. */
  function setMode(s, mode, sub, t, badges, tool) {
    // Still my move, but the registry moved last activity on (a session reopened in the app):
    // log it again so a replay of the events ages the session from the same moment the live model does.
    const resumed = mode === MODE.MY_MOVE && s.lastMode === mode && t - (s.lastModeT ?? t) >= RESUME_GAP_S;
    if (s.lastMode === mode && !resumed) { s.lastSub = sub; return; }
    s.lastMode = mode; s.lastSub = sub; s.lastModeT = t;
    s.modeTl.push([t, mode, sub]);
    if (mode === MODE.WORKING) emit(EV.WORKING, s, ms(t), t, { sub: sub ?? SUB.GENERATING, tool: tool ?? null });
    else if (mode === MODE.MY_MOVE) emit(EV.MY_MOVE, s, ms(t), t, { badges: badges || [] });
    if (!backfilling) emitMetrics(s, t, true);
  }

  // ----- numbers (non-copies only)
  function mainMetrics(s, e, info) {
    const t = e.t;
    if (e.type === 'user') {
      if (e.prompt && !e.isMeta && !e.isCompactSummary) {
        if (!e.interrupted) s.turns++;
        if (s.firstTurnOrigin === undefined) { s.firstTurnOrigin = e.turnOrigin; s.firstOriginKind = e.originKind; }
      }
      for (const r of e.results) toolResult(s, null, r, e, info);
      if (e.agentResult) {
        agentLink.set(e.agentResult.agentId, s.id);
        const sh = ships.get(e.agentResult.agentId);
        if (sh) {
          resolveShipOwner(sh);
          if (e.agentResult.status === 'completed') shipDone(sh, 'completed', t);
        }
      }
      return;
    }
    if (e.type === 'assistant') {
      if (e.apiError || e.model === SYNTH) {
        if (e.apiError) apiError(s, null, e, info, e.apiStatus, null, null);
        return;
      }
      const first = addUsage(s, null, e, info);
      if (e.model) { s.models.add(e.model); s.model = e.model; }
      const used = e.usage.input + e.usage.cacheRead + e.usage.cacheCreate;
      if (used > 0 && (!s.ctx || t >= s.ctx.t)) s.ctx = { used, model: e.model, t };
      if (used > 0) s.ctxTl.push([t ?? 0, used]);
      if (used > s.peak) s.peak = used;
      if (e.model && used > (peakByModel.get(e.model) || 0)) peakByModel.set(e.model, used);
      if (first && t != null) insertSorted(s.asst, t);
      for (const tu of e.tools) toolUse(s, null, tu, e, info);
      markApiRecovered(s, null, t);
      return;
    }
    if (e.type === 'system') {
      if (e.subtype === 'compact_boundary' && e.uuid) compaction(s, null, e);
      else if (e.subtype === 'api_error') apiError(s, null, e, info, e.apiStatus, e.retryAttempt, e.maxRetries);
    }
  }

  /** Dedupe by message.id: largest output wins, first file owns. Returns true for the first block of a message. */
  function addUsage(s, ship, e, info) {
    if (!e.msgId) return false;
    const u = e.usage;
    let m = msgs.get(e.msgId);
    const owner = ship || s;
    if (m) {
      if (m.file !== info.key) return false;
      if (u.output <= m.output) return false;
      applySpend(m.owner, m.t, -m.input, -m.output, -m.cacheRead, -m.cacheCreate, e.t);
    } else {
      m = { file: info.key, owner, t: e.t ?? 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      msgs.set(e.msgId, m);
    }
    const dOut = u.output - m.output;
    m.input = u.input; m.output = u.output; m.cacheRead = u.cacheRead; m.cacheCreate = u.cacheCreate;
    applySpend(m.owner, m.t, m.input, m.output, m.cacheRead, m.cacheCreate, e.t);
    const now = clock();
    if (e.t != null && e.t > now - 120 && dOut > 0) {
      const sess = ship ? (ship.owner ? S.get(ship.owner) : null) : s;
      if (sess) sess.recentOut.push([e.t, dOut]);
    }
    return dOut === u.output; // true when this was a new message
  }
  function applySpend(owner, t0, di, dout, dcr, dcc, tEntry) {
    owner.own.input += di; owner.own.output += dout; owner.own.cacheRead += dcr; owner.own.cacheCreate += dcc;
    const day = dayStart(t0);
    owner.daySpend.set(day, (owner.daySpend.get(day) || 0) + di + dout + dcc);
    owner.tl.push([tEntry ?? t0, di, dout, dcc, dcr]);
    if (!backfilling) {
      const sess = owner.isShip ? S.get(owner.owner) : owner;
      if (sess) { touch(sess); maybeMetrics(sess, tEntry ?? t0); }
    }
  }

  // ----- tool calls, files, errors
  function relPath(s, abs) {
    if (typeof abs !== 'string' || !abs) return null;
    const base = s.cwd;
    if (base && abs.startsWith(base + '/')) return abs.slice(base.length + 1);
    const home = process.env.HOME;
    if (home && abs.startsWith(home + '/')) return '~/' + abs.slice(home.length + 1);
    return abs;
  }
  function toolUse(s, ship, tu, e, info) {
    if (!tu.id || calls.has(tu.id)) return;
    const sess = ship ? S.get(ship.owner) : s;
    if (!sess) return;
    const t = e.t;
    let target = null, fileRec = null;
    const op = EDIT_OPS[tu.name];
    if (op && tu.path) {
      const rel = relPath(sess, tu.path);
      if (rel) {
        fileRec = fileTouch(sess, rel, op, t);
        target = fileRec.id;
      }
    }
    const call = { id: tu.id, sid: sess.id, ship: ship ? ship.id : null, scope: info.key, t, tool: tu.name, target, ok: null, durationMs: null, ev: null };
    calls.set(tu.id, call);
    sess.callCount++;
    if (t != null) sess.callTl.push(t);
    if (t != null && t > clock() - RECENT_KEEP_S) {
      sess.recentTools.push(t);
      sess.recentCalls.push(call);
    }
    call.ev = emit(EV.TOOL_CALL, sess, tu.id, t, { tool: tu.name, target, toolUseId: tu.id, ok: null, durationMs: null }, { ship: call.ship });
    if (fileRec) {
      emit(EV.FILE_TOUCH, sess, tu.id, t, { fileId: fileRec.id, path: fileRec.path, folder: fileRec.folder, op, plan: fileRec.plan }, { ship: call.ship });
    }
  }
  function fileTouch(s, rel, op, t) {
    let f = s.files.get(rel);
    if (!f) {
      const dir = path.posix.dirname(rel);
      f = { id: `f:${rel}`, path: rel, folder: `d:${dir}`, edits: 0, reads: 0, lastT: 0, plan: /(^|\/)\.claude\/plans\/[^/]+\.md$/.test(rel) && op !== 'read' };
      s.files.set(rel, f);
    }
    if (op === 'read') f.reads++; else { f.edits++; if (/(^|\/)\.claude\/plans\/[^/]+\.md$/.test(rel)) f.plan = true; }
    if (t > f.lastT) f.lastT = t;
    const dirPath = f.folder.slice(2);
    let d = s.folders.get(dirPath);
    if (!d) { d = { id: f.folder, path: dirPath, edits: 0, reads: 0, files: new Set(), lastT: 0 }; s.folders.set(dirPath, d); }
    if (op === 'read') d.reads++; else d.edits++;
    d.files.add(rel);
    if (t > d.lastT) d.lastT = t;
    s.filesSig++;
    return f;
  }
  function toolResult(s, ship, r, e, info) {
    const call = r.id ? calls.get(r.id) : null;
    const t = e.t;
    if (call && call.ok == null) {
      call.ok = !r.isError;
      call.durationMs = call.t != null && t != null ? Math.max(0, Math.round((t - call.t) * 1000)) : null;
      if (call.ev) { call.ev.data.ok = call.ok; call.ev.data.durationMs = call.durationMs; reemit(call.ev); }
      if (call.ok) markToolRecovered(call, t);
    }
    if (!r.isError) return;
    const sess = call ? S.get(call.sid) : (ship ? S.get(ship.owner) : s);
    if (!sess) return;
    const key = r.id || e.uuid;
    if (!key || sess.errIds.has(key)) return;
    sess.errIds.add(key);
    const kind = e.toolDenialKind ? 'denial' : 'tool';
    const err = { key, t, kind, tool: call?.tool ?? null, ship: ship ? ship.id : (call?.ship ?? null), scope: info.key, recovered: null, ev: null };
    sess.errors.push(err);
    if (t > clock() - RECENT_KEEP_S) sess.recentErrors.push(err);
    err.ev = emit(EV.ERROR, sess, key, t, {
      kind, tool: err.tool, toolUseId: r.id ?? null, target: call?.target ?? null,
      denialKind: e.toolDenialKind ?? null, apiStatus: null, retryAttempt: null, maxRetries: null, recovered: null,
    }, { ship: err.ship, src: { f: info.key, off: e.__off, len: e.__len, epoch: e.__epoch } });
    if (!backfilling) stormOnError(sess, err);
  }
  function markToolRecovered(call, t) {
    const sess = S.get(call.sid);
    if (!sess) return;
    for (let i = sess.errors.length - 1; i >= 0 && i >= sess.errors.length - 50; i--) {
      const er = sess.errors[i];
      if (er.recovered == null && er.kind !== 'api' && er.scope === call.scope && er.tool === call.tool && er.t <= t) {
        er.recovered = true;
        if (er.ev) { er.ev.data.recovered = true; reemit(er.ev); }
      }
    }
  }
  function apiError(s, ship, e, info, status, retryAttempt, maxRetries) {
    const sess = ship ? S.get(ship.owner) : s;
    if (!sess) return;
    const key = e.uuid;
    if (!key || sess.errIds.has(key)) return;
    sess.errIds.add(key);
    const err = { key, t: e.t, kind: 'api', tool: null, ship: ship ? ship.id : null, scope: info.key, recovered: null, ev: null };
    sess.errors.push(err);
    if (e.t > clock() - RECENT_KEEP_S) sess.recentErrors.push(err);
    err.ev = emit(EV.ERROR, sess, key, e.t, {
      kind: 'api', tool: null, toolUseId: null, target: null, denialKind: null,
      apiStatus: status ?? null, retryAttempt: retryAttempt ?? null, maxRetries: maxRetries ?? null, recovered: null,
    }, { ship: err.ship, src: { f: info.key, off: e.__off, len: e.__len, epoch: e.__epoch } });
  }
  function markApiRecovered(s, ship, t) {
    const sess = ship ? S.get(ship.owner) : s;
    if (!sess) return;
    const scopeShip = ship ? ship.id : null;
    for (let i = sess.errors.length - 1; i >= 0 && i >= sess.errors.length - 20; i--) {
      const er = sess.errors[i];
      if (er.kind === 'api' && er.recovered == null && er.ship === scopeShip && er.t <= t) {
        er.recovered = true;
        if (er.ev) { er.ev.data.recovered = true; reemit(er.ev); }
      }
    }
  }
  function compaction(s, ship, e) {
    const sess = ship ? S.get(ship.owner) : s;
    if (!sess) return;
    const c = e.compact || {};
    const rec = { id: e.uuid, t: e.t, trigger: c.trigger ?? null, preTokens: c.preTokens ?? 0, postTokens: c.postTokens ?? 0, durationMs: c.durationMs ?? 0 };
    if (ship) { if (ship.compactions.has(e.uuid)) return; ship.compactions.set(e.uuid, rec); }
    else {
      if (sess.compactions.has(e.uuid)) return;
      sess.compactions.set(e.uuid, rec);
      // The window drops at the boundary (to the summary's size when known).
      if (e.t != null) {
        sess.ctxTl.push([e.t, rec.postTokens || 0]);
        if (!sess.ctx || e.t >= sess.ctx.t) sess.ctx = { used: rec.postTokens || 0, model: sess.ctx?.model ?? sess.model, t: e.t };
      }
    }
    emit(EV.COMPACTION, sess, e.uuid, e.t, {
      trigger: rec.trigger, preTokens: rec.preTokens, postTokens: rec.postTokens,
      droppedTokens: Math.max(0, rec.preTokens - rec.postTokens), durationMs: rec.durationMs,
    }, { ship: ship ? ship.id : null });
    if (!backfilling && !ship) emitMetrics(sess, e.t, true);
  }

  // ----- storms (settings.storm; same rule as lib/config.js STORM)
  function stormOnError(s, err) {
    if (err.kind === 'api') return;
    const st = settings.storm;
    if (s.storm && err.t > s.storm.lastErrorT + st.holdS) endStorm(s);
    s.errWindow.push(err);
    while (s.errWindow.length && s.errWindow[0].t < err.t - st.windowS) s.errWindow.shift();
    if (s.storm) {
      s.storm.count++; s.storm.lastErrorT = Math.max(s.storm.lastErrorT, err.t); s.storm.errorIds.push(err.ev?.id ?? err.key);
      touch(s);
    } else if (s.errWindow.length >= st.count) {
      const first = s.errWindow[0];
      s.storm = { since: first.t, lastErrorT: err.t, count: s.errWindow.length, firstKey: first.key, errorIds: s.errWindow.map((x) => x.ev?.id ?? x.key) };
      s.stormTimes.push(err.t);
      emit(EV.STORM_START, s, first.key, err.t, { count: s.storm.count, windowS: st.windowS, firstErrorId: s.storm.errorIds[0] });
      touch(s);
    }
  }
  function endStorm(s) {
    const st = s.storm;
    if (!st) return;
    s.storm = null;
    const tEnd = st.lastErrorT + settings.storm.holdS;
    emit(EV.STORM_END, s, st.firstKey, tEnd, { count: st.count, durationS: tEnd - st.since, errorIds: st.errorIds });
    touch(s);
  }

  // =====================================================================
  // Ships

  function getShip(agentId) {
    let sh = ships.get(agentId);
    if (!sh) {
      sh = {
        id: agentId, isShip: true, owner: null, folderSid: null, file: null, wf: null, meta: {},
        firstT: null, lastT: null, model: null, own: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        daySpend: new Map(), tl: [], compactions: new Map(), done: null, outEv: null, backEv: null,
      };
      ships.set(agentId, sh);
    }
    return sh;
  }
  function shipEntries(info, entries) {
    if (excluded.has(info.sid)) return;
    const sh = getShip(info.agentId);
    if (sh.file && sh.file !== info.key) return; // the same agent copied into a fork's folder
    if (!sh.file) { sh.file = info.key; sh.folderSid = info.sid; sh.wf = info.wf || null; resolveShipOwner(sh); }
    const sess = sh.owner ? S.get(sh.owner) : null;
    for (const e of entries) {
      if (e.type !== 'user' && e.type !== 'assistant' && e.type !== 'system' && e.type !== 'attachment') continue;
      if (e.t != null) {
        if (sh.firstT == null || e.t < sh.firstT) sh.firstT = e.t;
        if (sh.lastT == null || e.t > sh.lastT) sh.lastT = e.t;
      }
      if (sh.done && !backfilling && e.t > sh.done.t + 1 && sh.done.how === 'silence') { sh.done = null; } // woke up
      if (e.type === 'assistant' && !sess && !e.apiError && e.model !== SYNTH) { addUsage(null, sh, e, info); if (e.model) sh.model = e.model; continue; }
      if (!sess) continue;
      if (e.type === 'assistant') {
        if (e.apiError || e.model === SYNTH) { if (e.apiError) apiError(sess, sh, e, info, e.apiStatus, null, null); continue; }
        addUsage(sess, sh, e, info);
        if (e.model) { sh.model = e.model; const used = e.usage.input + e.usage.cacheRead + e.usage.cacheCreate; if (used > (peakByModel.get(e.model) || 0)) peakByModel.set(e.model, used); }
        for (const tu of e.tools) toolUse(sess, sh, tu, e, info);
        markApiRecovered(sess, sh, e.t);
      } else if (e.type === 'user') {
        for (const r of e.results) toolResult(sess, sh, r, e, info);
      } else if (e.type === 'system') {
        if (e.subtype === 'compact_boundary' && e.uuid) compaction(sess, sh, e);
        else if (e.subtype === 'api_error') apiError(sess, sh, e, info, e.apiStatus, e.retryAttempt, e.maxRetries);
      }
    }
    if (sess) {
      if (!sh.outEv && sh.firstT != null) emitShipOut(sh);
      checkShipDone(sh);
      refreshShipBack(sh);
      touch(sess);
    }
  }
  function shipBackData(sh) {
    const endT = Math.max(sh.lastT ?? sh.done.t ?? 0, sh.done.t ?? 0);
    return [endT, { agentId: sh.id, durationS: sh.firstT != null ? Math.max(0, endT - sh.firstT) : null, tokens: shipTokens(sh), how: sh.done.how }];
  }
  function refreshShipBack(sh) {
    if (!sh.done || !sh.backEv) return;
    const [endT, data] = shipBackData(sh);
    if (endT === sh.backEv.t && JSON.stringify(data) === JSON.stringify(sh.backEv.data)) return;
    sh.backEv.t = endT; sh.backEv.data = data; reemit(sh.backEv);
  }
  function resolveShipOwner(sh) {
    let owner = null;
    const tu = sh.meta.toolUseId;
    if (tu && calls.has(tu)) owner = calls.get(tu).sid;
    if (!owner && agentLink.has(sh.id)) owner = agentLink.get(sh.id);
    if (!owner) owner = sh.folderSid || sh.meta.sid || null;
    if (owner && excluded.has(owner)) owner = null;
    if (owner === sh.owner) return;
    if (sh.owner) { const old = S.get(sh.owner); if (old) { old.shipIds.delete(sh.id); touch(old); } }
    sh.owner = owner;
    if (owner) { const s = getSession(owner, false); if (s) { s.shipIds.add(sh.id); touch(s); } }
  }
  function shipLabel(sh) {
    const m = sh.meta;
    if (m.agentType && m.agentType !== 'workflow-subagent') return m.agentType;
    return m.journalLabel || m.description || m.workflowPhase || m.agentType || 'subagent';
  }
  function shipTokens(sh) { return sh.own.input + sh.own.output + sh.own.cacheCreate; }
  function emitShipOut(sh) {
    const sess = S.get(sh.owner);
    if (!sess || sh.firstT == null) return;
    const data = { agentId: sh.id, type: sh.meta.agentType ?? null, label: shipLabel(sh), model: sh.model || sh.meta.model || null, depth: sh.meta.spawnDepth ?? null, toolUseId: sh.meta.toolUseId ?? null };
    if (sh.outEv && JSON.stringify(sh.outEv.data) === JSON.stringify(data)) return;
    if (sh.outEv) { sh.outEv.data = data; reemit(sh.outEv); }
    else sh.outEv = emit(EV.SUBAGENT_OUT, sess, sh.id, sh.firstT, data, { ship: sh.id });
  }
  function shipDone(sh, how, t) {
    if (sh.done && sh.done.how !== 'silence') return;
    if (sh.done && how === 'silence') return;
    sh.done = { how, t: t ?? sh.lastT };
    const sess = S.get(sh.owner);
    if (!sess) return;
    const [endT, data] = shipBackData(sh);
    if (sh.backEv) { sh.backEv.data = data; sh.backEv.t = endT; reemit(sh.backEv); }
    else sh.backEv = emit(EV.SUBAGENT_BACK, sess, sh.id, endT, data, { ship: sh.id });
    touch(sess);
  }
  function checkShipDone(sh, now = clock()) {
    if (sh.meta.finished || sh.meta.journalDone) shipDone(sh, 'finished', sh.lastT);
    else if (!sh.done && sh.lastT != null && now - sh.lastT >= settings.timeouts.shipDoneS) shipDone(sh, 'silence', sh.lastT);
  }
  function shipActive(sh, now) {
    if (sh.done && sh.done.how !== 'silence') return false;
    return sh.lastT != null && now - sh.lastT < settings.timeouts.shipActiveS;
  }

  function onSubMeta(agentId, meta) {
    const sh = getShip(agentId);
    for (const [k, v] of Object.entries(meta)) if (v != null) sh.meta[k] = v;
    if (!sh.folderSid && meta.sid) sh.folderSid = meta.sid;
    resolveShipOwner(sh);
    if (sh.firstT != null) { emitShipOut(sh); checkShipDone(sh); }
    if (!backfilling) flushChanges();
  }

  // =====================================================================
  // Registry, liveness, app metadata

  function onRegistry(records) {
    registryList = records;
    const before = new Set(registryBySid.keys());
    registryBySid.clear();
    for (const r of records) {
      const cur = registryBySid.get(r.sessionId);
      if (!cur || (r.updatedAt ?? 0) > (cur.updatedAt ?? 0)) registryBySid.set(r.sessionId, r);
    }
    for (const [sid, r] of registryBySid) {
      if (excluded.has(sid)) continue;
      if (!S.has(sid)) {
        if (isExcludedCwd(r.cwd)) { excluded.add(sid); continue; }
        const s = getSession(sid);
        s.registryBorn = true;
        if (!s.cwd) s.cwd = r.cwd;
        if (!s.entrypoint) s.entrypoint = r.entrypoint;
        if (r.startedAt != null && s.firstT == null) s.firstT = r.startedAt;
      }
    }
    const affected = new Set([...before, ...registryBySid.keys()]);
    if (!backfilling) {
      const now = clock();
      for (const sid of affected) { const s = S.get(sid); if (s) evaluate(s, now); }
      flushChanges();
    }
  }
  function onLiveness(pid, alive, ok) {
    const r = registryList.find((x) => x.pid === pid);
    if (!r) return;
    if (r.alive === alive && r.procStartOk === ok) return;
    r.alive = alive; r.procStartOk = ok;
    const s = S.get(r.sessionId);
    if (s && !backfilling) { evaluate(s, clock()); flushChanges(); }
  }
  function onAppMeta(map) {
    s6 = map;
    for (const s of S.values()) touch(s);
    if (!backfilling) { const now = clock(); for (const s of S.values()) evaluate(s, now); flushChanges(); }
  }
  function onTitleFile(sid, info) {
    const cur = titleFiles.get(sid) || {};
    titleFiles.set(sid, { ...cur, ...info });
    const s = S.get(sid);
    if (s) touch(s);
    if (!backfilling) flushChanges();
  }
  function onProjects(keys) {
    arms.setProjectKeys(keys);
    for (const s of S.values()) touch(s);
    if (!backfilling) flushChanges();
  }

  // =====================================================================
  // Identity: title, origin, arm

  function titleOf(s) {
    const a = s6.get(s.id);
    if (a && a.title) {
      const src = a.titleSource === 'user' || a.titleSource === 'tool' || a.titleSource === 'auto' ? a.titleSource : 'auto';
      return [a.title, `s6-${src}`];
    }
    const reg = registryBySid.get(s.id);
    if (reg && reg.name) return [reg.name, 'registry'];
    const tf = titleFiles.get(s.id);
    if (s.titles.custom) return [s.titles.custom, 'custom-title'];
    if (tf && tf.customTitle) return [tf.customTitle, 'custom-title'];
    if (s.titles.agentName) return [s.titles.agentName, 'agent-name'];
    if (s.titles.aiTitle) return [s.titles.aiTitle, 'ai-title'];
    return [s.id.slice(0, 8), 'sid'];
  }
  function originOf(s) {
    const a = s6.get(s.id);
    const ep = s.entrypoint || registryBySid.get(s.id)?.entrypoint || null;
    const fto = s.firstTurnOrigin;
    if (ep && ep.startsWith('sdk')) return ORIGIN.SDK;
    if (fto === 'scheduled' || a?.scheduledTaskId) return ORIGIN.SCHEDULED;
    if ((a?.spawnedFrom && !a.spawnedFrom.userFork) || fto === 'sdk' || fto === 'peer') return ORIGIN.PEER;
    if (a?.forkedFrom || s.forkOfUuid) return ORIGIN.FORK;
    return ORIGIN.OWNER;
  }
  function forkOfOf(s) {
    const a = s6.get(s.id);
    return a?.forkedFrom?.cliSessionId || s.forkOfUuid || null;
  }
  function worktreeOf(s) {
    const name = worktreeName(s.cwd);
    if (!name) return null;
    return { name, branch: s6.get(s.id)?.branch || s.gitBranch || null };
  }
  function bornAtOf(s, depth = 0) {
    const reg = registryBySid.get(s.id);
    let b = s.firstT ?? s.firstCopyT ?? null;
    if (reg && reg.startedAt != null && (b == null || reg.startedAt < b) && !s.forkOfUuid) b = reg.startedAt;
    // A fork is never born before its parent. Copied history can carry an entry the
    // fork claims for itself (forks of forks made within the same second), which
    // would otherwise date the fork before the session it was forked from.
    const parentId = depth < 8 ? forkOfOf(s) : null;
    const parent = parentId ? S.get(parentId) : null;
    if (parent && b != null) {
      const pb = bornAtOf(parent, depth + 1);
      if (pb != null && pb > b) b = pb;
    }
    return b;
  }
  function emitBorn(s) {
    const t = bornAtOf(s);
    if (t == null) return;
    const data = { origin: originOf(s), arm: armOf(s).key, worktree: worktreeOf(s), entrypoint: s.entrypoint ?? null, forkOf: forkOfOf(s) };
    const sig = JSON.stringify([t, data]);
    if (sig === s.bornSig) return;
    s.bornSig = sig;
    s.bornEmitted = true;
    emit(EV.BORN, s, 'born', t, data);
  }

  // =====================================================================
  // State machine (DATA_SPEC §3; priority order, first rule wins)

  function lastActivityOf(s, reg, live) {
    let la = s.lastT ?? bornAtOf(s) ?? 0;
    if (live && reg && reg.statusUpdatedAt != null && reg.statusUpdatedAt > la) la = reg.statusUpdatedAt;
    return la;
  }
  function kOf(s, la) {
    const A = s.asst.length - lowerBound(s.asst, la - 3600);
    return idleK(A, settings.idle);
  }
  function anyShipActive(s, now) {
    for (const id of s.shipIds) { const sh = ships.get(id); if (sh && shipActive(sh, now)) return true; }
    return false;
  }
  function lastAnyCore(s) {
    let t = s.lastCoreT ?? 0;
    for (const id of s.shipIds) { const sh = ships.get(id); if (sh && sh.lastT > t) t = sh.lastT; }
    return t;
  }
  function pendingOf(s) {
    let ask = null, other = null;
    for (const [id, p] of s.pending) {
      if (ASK_TOOLS.has(p.name)) { if (!ask || p.t >= ask.t) ask = { id, ...p }; }
      else if (!other || p.t >= other.t) other = { id, ...p };
    }
    return { ask, other };
  }

  /** Compute the state (pure w.r.t. events). */
  function computeState(s, now) {
    const reg = registryBySid.get(s.id) || null;
    const alive = reg ? reg.alive !== false : false;
    const procOk = reg ? reg.procStartOk !== false : false;
    const live = !!reg && alive && procOk;
    const la = lastActivityOf(s, reg, live);
    const k = kOf(s, la);
    const T = settings.idle.hours * 3600;
    const tail = s.tail;
    const ended = turnEnded(tail);
    const { ask, other } = pendingOf(s);
    const st = { mode: MODE.IDLE, sub: null, badges: [], remnant: null, since: la, tool: null, target: null, idleFor: 0, k, live, la, crashReason: null, needsSource: null, needsTool: null };
    const decay = () => idleFraction(now - la, k, T);
    const working = (badges) => {
      st.mode = MODE.WORKING;
      if (tail && tail.kind === 'api_error') st.sub = SUB.RETRYING;
      else if (other && tail && (tail.kind === 'assistant' || tail.kind === 'result' || tail.kind === 'compact')) {
        st.sub = SUB.TOOL; st.tool = other.name;
        const c = calls.get(other.id);
        st.target = c?.target ? c.target.replace(/^f:/, '') : null;
      } else st.sub = SUB.GENERATING;
      st.since = s.lastMode === MODE.WORKING && s.lastModeT != null ? s.lastModeT : (tail?.t ?? la);
      st.badges.push(...badges);
      if (now - lastAnyCore(s) >= settings.timeouts.stalledS) st.badges.push(BADGE.STALLED);
    };
    const myMove = (since, badges) => {
      st.mode = MODE.MY_MOVE; st.since = since; st.badges.push(...badges);
      if (anyShipActive(s, now)) st.badges.push(BADGE.SHIPS_OUT);
      const sc = s6.get(s.id)?.statusCategory;
      if (sc === 'blocked' || sc === 'needs_action') st.badges.push(BADGE.ASKED_IN_TEXT);
      st.idleFor = decay();
      const age = settings.timeouts.myMoveAgeS;
      if (now - la >= T) { st.mode = MODE.DEAD; st.idleFor = 1; st.since = la + T; st.badges.length = 0; }
      else if (Number.isFinite(age) && now - la >= age) { st.mode = MODE.IDLE; st.since = la + age; }
    };
    const needsMe = (sub, since, source, tool, badges) => {
      st.mode = MODE.NEEDS_ME; st.sub = sub; st.since = since; st.needsSource = source; st.needsTool = tool; st.badges.push(...badges);
    };

    if (live) {
      const status = reg.status;
      if (status === 'waiting' && reg.waitingFor !== 'dialog open') {
        const wf = reg.waitingFor;
        let sub = SUB.APPROVE;
        if (ask && ask.name === 'ExitPlanMode') sub = SUB.PLAN;
        else if (wf === 'input needed' || (ask && wf == null)) sub = SUB.QUESTION;
        // Registry 'waiting' needs-me is PROVEN on this machine (DATA_SPEC §9.1): registry-sourced
        // needs-me events logged with a full start→answered→end lifecycle, plus the live latency proof.
        // No longer flagged unverified, so the top "needs me" alert reads clean.
        needsMe(sub, reg.statusUpdatedAt ?? now, 'registry', ask?.name ?? other?.name ?? null, []);
      } else if (ask && status !== 'idle') {
        needsMe(ask.name === 'ExitPlanMode' ? SUB.PLAN : SUB.QUESTION, ask.t, 'transcript', ask.name, []);
      } else if (status === 'waiting') {
        myMove(reg.statusUpdatedAt ?? tail?.t ?? la, [BADGE.DIALOG]);
      } else if (status === 'busy') {
        if (ended) myMove(tail.t, []);
        else working([]);
      } else if (status === 'idle') {
        myMove(Math.max(tail && ended ? tail.t : 0, reg.statusUpdatedAt ?? 0) || la, []);
      } else if (ended) myMove(tail.t, []);
      else working([]);
      return st;
    }

    // No registry file: transcript-only liveness (DATA_SPEC §3.2), bounded by noRegistryWorkingS.
    if (!reg && s.lastT != null && now - s.lastT < settings.timeouts.noRegistryWorkingS && tail && !ended
        && tail.kind !== 'synthetic' && !(tail.kind === 'prompt' && tail.shutdown)) {
      if (ask) { needsMe(ask.name === 'ExitPlanMode' ? SUB.PLAN : SUB.QUESTION, ask.t, 'transcript', ask.name, [BADGE.NO_REGISTRY]); return st; }
      working([BADGE.NO_REGISTRY]);
      if (st.sub === SUB.TOOL && other && now - other.t > settings.timeouts.ambiguousS) st.badges.push(BADGE.AMBIGUOUS);
      return st;
    }

    // Not live: remnant checks, in order (DATA_SPEC §3.7).
    const a = s6.get(s.id);
    const tf = titleFiles.get(s.id);
    const endDecay = (remnant) => {
      st.remnant = remnant;
      if (now - la >= T) { st.mode = MODE.DEAD; st.idleFor = 1; st.since = la + T; }
      else { st.mode = MODE.IDLE; st.idleFor = decay(); st.since = la; }
    };
    if ((a && a.deleted) || (tf && tf.released)) {
      st.remnant = REMNANT.DELETED; st.mode = MODE.DEAD; st.idleFor = 1;
      st.since = Math.max(la, tf?.released?.at ?? la);
      st.deletedHow = tf?.released ? 'desktop-released' : 's6-marker';
      return st;
    }
    if (s.lastToolName === ARCHIVE_TOOL || (a && a.isArchived)) {
      endDecay(REMNANT.ARCHIVED);
      st.archivedHow = s.lastToolName === ARCHIVE_TOOL ? 'archive-tool' : 's6-flag';
      return st;
    }
    if (tail && tail.kind === 'prompt' && (tail.origin === 'task-notification' || tail.origin === 'task_notification' || tail.origin === 'peer') && s.prevEnded) {
      endDecay(REMNANT.ENDED); return st;
    }
    let reason = null;
    if (tail) {
      if (tail.kind === 'prompt' && tail.shutdown) reason = 'shutdown';
      else if (tail.kind === 'api') reason = 'unanswered-api-request';
      else if (tail.kind === 'synthetic') reason = 'api-error';
      else if (tail.kind === 'api_error') reason = 'api-error';
      else if (tail.kind === 'prompt' && (tail.before === 'synthetic' || tail.before === 'api_error')
        && (tail.origin === 'task-notification' || tail.origin === 'task_notification' || tail.origin === 'peer')) {
        // A queued notification arrived after an API error and was never answered:
        // the session really died on the API error (DATA_SPEC §3.7 rule 4).
        reason = 'api-error';
      } else if (tail.kind === 'prompt' || tail.kind === 'result') reason = 'no-reply';
      else if (tail.kind === 'assistant' && !tail.endTurn && s.pending.size) reason = 'pending-tool';
    }
    if (reason) {
      if (reg && (!alive || !procOk)) reason = reason === 'api-error' ? reason : 'dead-pid';
      st.mode = MODE.CRASHED;
      st.remnant = reason === 'api-error' ? REMNANT.CRASHED_API : REMNANT.CRASHED;
      st.crashReason = reason;
      st.since = tail.t;
      st.idleFor = decay();
      return st;
    }
    endDecay(REMNANT.ENDED);
    return st;
  }

  /** Evaluate a session and emit transition events. */
  function evaluate(s, now) {
    if (s.snapshot) return;
    const st = computeState(s, now);
    const prev = s.state;
    s.state = st;
    // NEEDS ME leave
    if (s.needs && st.mode !== MODE.NEEDS_ME) {
      let how = 'answered';
      if (!st.live && st.mode !== MODE.WORKING) how = 'session-ended';
      else if (s.tail?.kind === 'interrupt') how = 'interrupted';
      else if (s.lastResult && s.lastResult.t >= s.needs.t && (s.lastResult.denial || s.lastResult.isError) && ASK_TOOLS.has(s.lastResult.name || '')) how = 'denied';
      needsEnd(s, Math.max(st.since ?? 0, s.needs.t), how);
    }
    // NEEDS ME enter
    if (st.mode === MODE.NEEDS_ME && !s.needs) needsStart(s, st.sub, st.needsSource, st.needsTool, st.since, null);
    else if (st.mode === MODE.NEEDS_ME && s.needs && s.needs.sub !== st.sub) s.needs.sub = st.sub;
    // Other transitions
    if (st.mode === MODE.WORKING) setMode(s, MODE.WORKING, st.sub, st.since, null, st.tool);
    else if (st.mode === MODE.MY_MOVE) setMode(s, MODE.MY_MOVE, null, st.since, st.badges);
    else if (st.mode === MODE.IDLE || st.mode === MODE.DEAD) {
      if (st.remnant === REMNANT.ARCHIVED && s.remnantEmitted !== REMNANT.ARCHIVED) {
        s.remnantEmitted = REMNANT.ARCHIVED;
        emit(EV.ARCHIVED, s, ms(s.archiveT ?? st.la), s.archiveT ?? st.la, { how: st.archivedHow });
      }
      if (st.remnant === REMNANT.DELETED && s.remnantEmitted !== REMNANT.DELETED) {
        s.remnantEmitted = REMNANT.DELETED;
        emit(EV.DELETED, s, ms(st.since), st.since, { how: st.deletedHow });
      }
      if (s.lastMode !== MODE.IDLE && s.lastMode !== MODE.DEAD && st.remnant !== REMNANT.DELETED) {
        const t = st.mode === MODE.IDLE ? Math.max(st.since, s.lastModeT ?? 0) + 0.001 : st.la + 0.001;
        s.lastMode = MODE.IDLE; s.lastSub = null; s.lastModeT = t; s.modeTl.push([t, MODE.IDLE, null]);
        emit(EV.IDLE, s, ms(st.la), t, { k: st.k, lastActivity: st.la });
      }
      if (st.mode === MODE.DEAD && s.lastMode !== MODE.DEAD) {
        const t = st.remnant === REMNANT.DELETED ? st.since + 0.002 : Math.max(st.since, (s.lastModeT ?? 0) + 0.001);
        s.lastMode = MODE.DEAD; s.lastSub = null; s.lastModeT = t; s.modeTl.push([t, MODE.DEAD, null]);
        emit(EV.DEAD, s, ms(st.la), t, { lastActivity: st.la });
      }
    } else if (st.mode === MODE.CRASHED && s.lastMode !== MODE.CRASHED) {
      s.lastMode = MODE.CRASHED; s.lastSub = null; s.lastModeT = st.since; s.modeTl.push([st.since, MODE.CRASHED, null]);
      emit(EV.CRASHED, s, ms(st.since), st.since, { reason: st.crashReason, lastType: tailType(s.tail) });
    }
    // Storm hold, ship silence
    if (s.storm && now > s.storm.lastErrorT + settings.storm.holdS) endStorm(s);
    for (const id of s.shipIds) { const sh = ships.get(id); if (sh) checkShipDone(sh, now); }
    // Born re-emit when identity resolves later (S6, projects)
    if (!backfilling) emitBorn(s);
    const sig = `${st.mode}|${st.sub}|${st.badges.join(',')}|${st.remnant}|${st.tool}|${st.target}|${st.live}`;
    if (sig !== s.stateSig) {
      s.stateSig = sig;
      touch(s);
      if (!backfilling && prev) emitMetrics(s, Math.max(st.since ?? 0, s.lastT ?? 0), true);
    }
    const act = activityOf(s, now);
    if (Math.abs(act - s.activity) > 0.05 || (act === 0) !== (s.activity === 0)) { s.activity = act; touch(s); }
  }
  function tailType(tail) {
    if (!tail) return null;
    return { api: 'api-request', prompt: 'user', result: 'user', interrupt: 'user', assistant: 'assistant', synthetic: 'assistant', stop: 'system', api_error: 'system', compact: 'system' }[tail.kind] || tail.kind;
  }
  function activityOf(s, now) {
    while (s.recentTools.length && s.recentTools[0] < now - 120) s.recentTools.shift();
    while (s.recentOut.length && s.recentOut[0][0] < now - 120) s.recentOut.shift();
    let calls60 = 0, out60 = 0;
    for (const t of s.recentTools) if (t >= now - 60) calls60++;
    for (const [t, o] of s.recentOut) if (t >= now - 60) out60 += o;
    return Math.min(1, calls60 / 8 + out60 / 6000);
  }

  // =====================================================================
  // Metrics events

  function totalsOf(s) {
    const t = { ...s.own };
    for (const id of s.shipIds) {
      const sh = ships.get(id);
      if (!sh) continue;
      t.input += sh.own.input; t.output += sh.own.output; t.cacheRead += sh.own.cacheRead; t.cacheCreate += sh.own.cacheCreate;
    }
    t.total = t.input + t.output + t.cacheCreate;
    return t;
  }
  function contextOf(s) {
    const model = s.ctx?.model || s.model || null;
    const limit = contextLimit(model, limits, peakByModel.get(model) || 0);
    const used = s.ctx?.used ?? 0;
    return { fill: limit > 0 ? used / limit : 0, used, limit, peak: s.peak, model };
  }
  function maybeMetrics(s, t) {
    if (t == null || t - s.lastMetricsT < METRICS_EVERY_S) return;
    emitMetrics(s, t, false);
  }
  function emitMetrics(s, t, force) {
    if (backfilling || t == null) return;
    const tok = totalsOf(s);
    const ctx = contextOf(s);
    const st = s.state;
    const data = {
      tokens: { input: tok.input, output: tok.output, cacheCreate: tok.cacheCreate, cacheRead: tok.cacheRead, total: tok.total },
      contextFill: ctx.fill, contextUsed: ctx.used, contextLimit: ctx.limit, activity: s.activity,
      mode: st?.mode ?? s.lastMode ?? null, sub: st?.sub ?? null, badges: st?.badges ?? [], idleFor: st?.idleFor ?? 0, k: st?.k ?? null,
    };
    const sig = JSON.stringify(data);
    if (!force && sig === s.metricsSig) return;
    if (s.filesSig !== s.filesSigMetrics) { data.files = topFiles(s, FILES_LITE); s.filesSigMetrics = s.filesSig; }
    s.metricsSig = sig;
    s.lastMetricsT = t;
    emit(EV.METRICS, s, Math.floor(t), t, data);
  }

  /** Backfill: rebuild the metrics history in time order from token/context timelines.
   *  Every sample carries real numbers: tokens so far, the context window at that
   *  moment (last assistant usage, dropped at each compaction), and the same
   *  one-minute activity the live model computes (tool calls + output tokens). */
  function backfillMetrics(s, finalT) {
    const tl = s.tl.slice();
    for (const id of s.shipIds) { const sh = ships.get(id); if (sh) for (const x of sh.tl) tl.push(x); }
    tl.sort((a, b) => a[0] - b[0]);
    const modes = s.modeTl.slice().sort((a, b) => a[0] - b[0]);
    const ctxTl = s.ctxTl.slice().sort((a, b) => a[0] - b[0]);
    const callTl = s.callTl.slice().sort((a, b) => a - b);
    const tok = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    let mi = 0, mode = null, sub = null, lastT = -Infinity, lastTotal = -1;
    let ci = 0, ctxUsed = 0;
    let cLo = 0, cHi = 0;                 // callTl window [t-60, t]
    let oLo = 0, out60 = 0;               // tl window for output tokens
    const limit = contextOf(s).limit;
    const activityAt = (i, t) => {
      while (cHi < callTl.length && callTl[cHi] <= t) cHi++;
      while (cLo < cHi && callTl[cLo] < t - 60) cLo++;
      while (oLo <= i && tl[oLo][0] < t - 60) { out60 -= tl[oLo][2]; oLo++; }
      return Math.min(1, (cHi - cLo) / 8 + Math.max(0, out60) / 6000);
    };
    const sample = (t, activity) => {
      while (mi < modes.length && modes[mi][0] <= t) { mode = modes[mi][1]; sub = modes[mi][2]; mi++; }
      while (ci < ctxTl.length && ctxTl[ci][0] <= t) { ctxUsed = ctxTl[ci][1]; ci++; }
      const total = tok.input + tok.output + tok.cacheCreate;
      emit(EV.METRICS, s, Math.floor(t), t, {
        tokens: { ...tok, total }, contextFill: limit > 0 ? ctxUsed / limit : 0, contextUsed: ctxUsed, contextLimit: limit, activity,
        mode, sub, badges: [], idleFor: 0, k: null,
      });
      return total;
    };
    for (let i = 0; i < tl.length; i++) {
      const [t, di, dout, dcc, dcr] = tl[i];
      tok.input += di; tok.output += dout; tok.cacheCreate += dcc; tok.cacheRead += dcr;
      out60 += dout;
      const total = tok.input + tok.output + tok.cacheCreate;
      const nextT = i === tl.length - 1 ? Infinity : tl[i + 1][0];
      const lastOfRun = nextT - t >= METRICS_EVERY_S;
      if (t - lastT >= METRICS_EVERY_S || (lastOfRun && total !== lastTotal)) {
        if (total === lastTotal && t - lastT < METRICS_EVERY_S * 10) continue;
        const act = activityAt(i, t);
        lastT = t; lastTotal = sample(t, act);
        // A quiet gap follows: let the disk and the core glow cool down in replay.
        if (act > 0 && nextT - t > 75 && t + 61 < finalT) {
          const tc = t + 61;
          lastT = tc; lastTotal = sample(tc, activityAt(i, tc));
        }
      }
    }
    // Final sample: the current numbers, last in time so a fold ends on them.
    const ctx = contextOf(s);
    const ft = Math.max(finalT, lastT + 0.001);
    const final = totalsOf(s);
    const st = s.state;
    emit(EV.METRICS, s, Math.floor(ft), ft, {
      tokens: { input: final.input, output: final.output, cacheCreate: final.cacheCreate, cacheRead: final.cacheRead, total: final.total },
      contextFill: ctx.fill, contextUsed: ctx.used, contextLimit: ctx.limit, activity: s.activity,
      mode: st?.mode ?? null, sub: st?.sub ?? null, badges: st?.badges ?? [], idleFor: st?.idleFor ?? 0, k: st?.k ?? null,
      files: topFiles(s, FILES_LITE),
    });
    s.lastMetricsT = ft;
    s.filesSigMetrics = s.filesSig;
  }

  // =====================================================================
  // Records

  function topFiles(s, n) {
    const arr = [...s.files.values()];
    arr.sort((a, b) => (b.edits + b.reads) - (a.edits + a.reads) || b.lastT - a.lastT);
    return arr.slice(0, n).map((f) => ({ id: f.id, path: f.path, folder: f.folder, edits: f.edits, reads: f.reads, lastT: f.lastT, plan: f.plan }));
  }
  function buildRecord(s, now) {
    if (!s.state) evaluate(s, now);
    const st = s.state;
    const [title, titleSource] = titleOf(s);
    const tok = totalsOf(s);
    const midnight = dayStart(now);
    let today = s.daySpend.get(midnight) || 0;
    const shipList = [];
    for (const id of s.shipIds) {
      const sh = ships.get(id);
      if (!sh || sh.firstT == null) continue;
      today += sh.daySpend.get(midnight) || 0;
      const active = shipActive(sh, now);
      shipList.push({
        id: sh.id, t: sh.firstT, endT: sh.done && !active ? Math.max(sh.lastT ?? 0, sh.done.t ?? 0) : null,
        type: sh.meta.agentType ?? null, label: shipLabel(sh), model: sh.model || sh.meta.model || null,
        tokens: shipTokens(sh), active, toolUseId: sh.meta.toolUseId ?? null,
        depth: sh.meta.spawnDepth ?? null, workflowPhase: sh.meta.workflowPhase ?? sh.meta.journalPhase ?? null,
      });
    }
    shipList.sort((a, b) => a.t - b.t);
    const ctx = contextOf(s);
    let tool = 0, denials = 0, api = 0, errorsToday = 0;
    for (const e of s.errors) {
      if (e.kind === 'api') api++;
      else { tool++; if (e.kind === 'denial') denials++; if (e.t >= midnight) errorsToday++; }
    }
    const folders = [...s.folders.values()].sort((a, b) => (b.edits + b.reads) - (a.edits + a.reads) || b.lastT - a.lastT)
      .map((d) => ({ id: d.id, path: d.path, edits: d.edits, reads: d.reads, files: d.files.size, lastT: d.lastT }));
    const hourly = [];
    const la = st.la;
    const from = Math.floor((la - HOURLY_SPAN_S) / 3600) * 3600;
    const hm = new Map();
    for (let i = lowerBound(s.asst, from); i < s.asst.length; i++) {
      const h = Math.floor(s.asst[i] / 3600) * 3600;
      hm.set(h, (hm.get(h) || 0) + 1);
    }
    for (const [h, n] of [...hm.entries()].sort((a, b) => a[0] - b[0])) hourly.push([h, n]);
    const arm = armOf(s);
    const live = st.live;
    return {
      v: 1, id: s.id, title, titleSource, origin: originOf(s), forkOf: forkOfOf(s),
      spawnedFrom: s6.get(s.id)?.spawnedFrom?.cliSessionId ?? null,
      entrypoint: s.entrypoint || registryBySid.get(s.id)?.entrypoint || null,
      appSession: st.live ? registryBySid.get(s.id)?.appSession ?? null : null,
      arm, worktree: worktreeOf(s), cwd: s.cwd, place: null,
      model: s.model, models: [...s.models], live, cacheOnly: false,
      // Ended only when it really ended: transcript-only liveness (no registry)
      // can still be WORKING / YOUR MOVE / NEEDS ME without a process we can see.
      times: { bornAt: bornAtOf(s), lastActivity: la, endedAt: (!live && (st.mode === MODE.DEAD || st.mode === MODE.CRASHED || st.remnant)) ? la : null },
      state: { mode: st.mode, sub: st.sub, badges: st.badges.slice(), remnant: live ? null : st.remnant, since: st.since, tool: st.tool, target: st.target, idleFor: st.idleFor, k: st.k },
      asOf: now, activity: s.activity,
      tokens: { input: tok.input, output: tok.output, cacheCreate: tok.cacheCreate, cacheRead: tok.cacheRead, total: tok.total, today },
      context: { fill: ctx.fill, used: ctx.used, limit: ctx.limit, peak: ctx.peak, model: ctx.model },
      counts: {
        turns: s.turns, toolCalls: s.callCount, errors: tool, denials, apiErrors: api,
        storms: s.stormTimes.length, compactions: s.compactions.size, ships: shipList.length, errorsToday,
      },
      storm: s.storm ? { since: s.storm.since, lastErrorT: s.storm.lastErrorT, count: s.storm.count } : null,
      compactions: [...s.compactions.values()].sort((a, b) => a.t - b.t).map((c) => ({ ...c })),
      ships: shipList,
      files: topFiles(s, FILES_MAX),
      folders,
      hourly,
    };
  }
  function recordOf(s, now) {
    if (s.dirty || !s.rec || now - s.rec.asOf > 5) {
      s.rec = buildRecord(s, now);
      s.dirty = false;
    }
    return s.rec;
  }

  function flushChanges() {
    if (!changed.size) return;
    const ids = [...changed];
    changed.clear();
    for (const sid of ids) {
      if (!S.has(sid)) continue;
      try { onChange(sid); } catch (err) { console.error('[cosmos model] onChange failed:', err); }
    }
  }

  // =====================================================================
  // Lifecycle

  function finishBackfill() {
    const now = clock();
    // Storms in time order (main and ship errors interleave across files).
    for (const s of S.values()) {
      const errs = s.errors.filter((e) => e.kind !== 'api').sort((a, b) => a.t - b.t);
      s.errWindow = []; s.storm = null; s.stormTimes = [];
      for (const e of errs) stormOnError(s, e);
    }
    for (const sh of ships.values()) { resolveShipOwner(sh); if (sh.firstT != null) { emitShipOut(sh); checkShipDone(sh, now); refreshShipBack(sh); } }
    for (const s of S.values()) {
      evaluate(s, now);
      emitBorn(s);
    }
    // Metrics history + final sample, after everything else for the session.
    const lastBySid = new Map();
    for (const ev of bf.values()) if ((lastBySid.get(ev.sid) ?? -Infinity) < ev.t) lastBySid.set(ev.sid, ev.t);
    for (const s of S.values()) backfillMetrics(s, Math.max(lastBySid.get(s.id) ?? 0, s.lastT ?? 0));
    // Cache-only sessions (snapshots whose transcripts are gone or skipped).
    if (store && typeof store.loadSnapshots === 'function') {
      let snaps = null;
      try { snaps = store.loadSnapshots(); } catch { snaps = null; }
      if (snaps) {
        for (const [sid, rec] of snaps) {
          if (S.has(sid) || excluded.has(sid) || isExcludedCwd(rec?.cwd)) continue;
          snapRecs.set(sid, cacheOnlyRecord(rec));
        }
      }
    }
    const list = [...bf.values()].sort((a, b) => a.t - b.t);
    bf.clear();
    backfilling = false;
    for (const ev of list) {
      ev.live = false;
      indexEvent(ev);
      send(ev);
    }
    for (const s of S.values()) touch(s);
    flushChanges();
  }
  function cacheOnlyRecord(rec) {
    const r = JSON.parse(JSON.stringify(rec));
    const deleted = s6.get(r.id)?.deleted || titleFiles.get(r.id)?.released;
    r.cacheOnly = true; r.live = false;
    r.state = { ...(r.state || {}), mode: MODE.DEAD, sub: null, badges: [], remnant: deleted ? REMNANT.DELETED : (r.state?.remnant === REMNANT.DELETED ? REMNANT.DELETED : REMNANT.AGED_OUT), idleFor: 1 };
    return r;
  }

  async function start() {
    const t0 = Date.now();
    let snaps = null;
    if (store && typeof store.loadSnapshots === 'function' && typeof store.isCacheOnly === 'function') {
      try { snaps = store.loadSnapshots(); } catch { snaps = null; }
    }
    const skipFile = (abs) => {
      if (!snaps) return false;
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl$|\/subagents\/)/.exec(abs);
      const snap = m ? snaps.get(m[1]) : null;
      return !!(snap && snap.times && store.isCacheOnly(m[1], snap.times.lastActivity));
    };
    reader = createReader({
      claudeHome: opts.claudeHome, appSupport: opts.appSupport, claudeJson: opts.claudeJson,
      pollMs: opts.pollMs, watch: opts.watch, onProgress: opts.onProgress,
      state: null, skipFile,
      onEntries, onRegistry, onAppMeta, onSubMeta, onTitleFile, onProjects, onLiveness,
    });
    await reader.start();
    stats.readerMs = Date.now() - t0;
    if (stopped) return;
    finishBackfill();
    stats.backfillMs = Date.now() - t0;
    if (opts.tick !== false) {
      tickTimer = setInterval(tick, 1000);
      if (tickTimer.unref) tickTimer.unref();
    }
  }

  function tick() {
    if (stopped || backfilling) return;
    const now = clock();
    for (const s of S.values()) {
      evaluate(s, now);
      while (s.recentErrors.length && s.recentErrors[0].t < now - RECENT_KEEP_S) s.recentErrors.shift();
      while (s.recentCalls.length && s.recentCalls[0].t < now - RECENT_KEEP_S) s.recentCalls.shift();
    }
    if (now - lastPrune > 60) {
      lastPrune = now;
      for (const [id, ev] of evIndex) if (ev.t < now - EVENT_INDEX_S) evIndex.delete(id);
    }
    flushChanges();
  }

  function stop() {
    stopped = true;
    clearInterval(tickTimer);
    if (reader) reader.stop();
  }

  // =====================================================================
  // Public API

  function sessions() {
    const now = clock();
    const out = new Map();
    if (backfilling) return out; // records exist only once the first scan has folded everything
    for (const s of S.values()) out.set(s.id, recordOf(s, now));
    for (const [sid, r] of snapRecs) if (!out.has(sid)) out.set(sid, r);
    return out;
  }
  function get(sid) {
    if (backfilling) return null;
    const s = S.get(sid);
    if (s) return recordOf(s, clock());
    return snapRecs.get(sid) || null;
  }
  function recent(sid) {
    const s = backfilling ? null : S.get(sid);
    const out = { errors: [], toolCalls: [], subagents: [] };
    if (!s) return out;
    const now = clock();
    for (const e of s.recentErrors) if (e.t >= now - 120) out.errors.push({ id: e.key, t: e.t, tool: e.tool ?? (e.kind === 'api' ? 'api' : null) });
    for (const c of s.recentCalls) if (c.t >= now - 30) out.toolCalls.push({ id: c.id, t: c.t, tool: c.tool, target: c.target, ok: c.ok });
    out.toolCalls.sort((a, b) => a.t - b.t);
    out.errors.sort((a, b) => a.t - b.t);
    for (const id of s.shipIds) {
      const sh = ships.get(id);
      if (!sh || sh.firstT == null) continue;
      const active = shipActive(sh, now);
      const endT = sh.done && !active ? Math.max(sh.lastT ?? 0, sh.done.t ?? 0) : null;
      if (active || (endT != null && now - endT < 5)) out.subagents.push({ id: sh.id, t: sh.firstT, endT, label: shipLabel(sh) });
    }
    return out;
  }
  function totals() {
    const now = clock();
    const midnight = dayStart(now);
    const t = {
      day: localDayString(now),
      byMode: { 'needs-me': 0, 'my-move': 0, working: 0, idle: 0, dead: 0, crashed: 0 },
      live: 0, sessions: 0, remnants: 0,
      tokensToday: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
      errorsToday: 0, denialsToday: 0, stormsToday: 0, compactionsToday: 0, shipsToday: 0,
      explain: { calls: 0, tokens: 0 },
    };
    for (const rec of sessions().values()) {
      t.sessions++;
      if (rec.live) t.live++;
      if (rec.state.remnant) t.remnants++;
      if (rec.state.mode in t.byMode) t.byMode[rec.state.mode]++;
    }
    for (const s of S.values()) {
      for (const e of s.errors) if (e.t >= midnight) { if (e.kind !== 'api') t.errorsToday++; if (e.kind === 'denial') t.denialsToday++; }
      for (const x of s.stormTimes) if (x >= midnight) t.stormsToday++;
      for (const c of s.compactions.values()) if (c.t >= midnight) t.compactionsToday++;
      for (const id of s.shipIds) { const sh = ships.get(id); if (sh && sh.firstT >= midnight) t.shipsToday++; }
    }
    for (const m of msgs.values()) {
      if (m.t < midnight) continue;
      const owner = m.owner.isShip ? S.get(m.owner.owner) : m.owner;
      if (!owner || !S.has(owner.id)) continue;
      t.tokensToday.input += m.input; t.tokensToday.output += m.output;
      t.tokensToday.cacheCreate += m.cacheCreate; t.tokensToday.cacheRead += m.cacheRead;
    }
    t.tokensToday.total = t.tokensToday.input + t.tokensToday.output + t.tokensToday.cacheCreate;
    if (store && typeof store.explainUsage === 'function') {
      try { const u = store.explainUsage(); t.explain = { calls: u?.calls ?? 0, tokens: u?.tokens?.total ?? 0 }; } catch { /* keep zeros */ }
    }
    return t;
  }
  function event(id) { return evIndex.get(id) || null; }
  function setSettings(next) {
    settings = mergeSettings(next);
    for (const s of S.values()) touch(s);
  }
  function setLimits(l) {
    limits = l && Array.isArray(l.rules) ? l : DEFAULT_LIMITS;
    for (const s of S.values()) touch(s);
  }
  function readerState() { return reader ? reader.state() : { files: {} }; }
  async function readLine(src) {
    if (!reader || !src || typeof src.f !== 'string') return null;
    const cur = reader.state().files[src.f];
    if (cur && src.epoch != null && cur.epoch !== src.epoch) return null; // file was rewritten since
    return reader.readLine(src.f, src.off, src.len);
  }

  return {
    start, sessions, get, recent, totals, event, setSettings, setLimits, readerState, readLine, tick, stop,
    /** Extras for the server and tests (additive). */
    progress: () => (reader ? reader.progress() : { files: 0, filesDone: 0, bytes: 0, ms: 0, done: false }),
    stats: () => ({ ...stats, sessions: S.size, ships: ships.size, messages: msgs.size, excluded: excluded.size, reader: reader ? reader.stats() : null }),
    loading: () => backfilling,
  };
}
