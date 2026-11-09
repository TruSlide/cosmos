// Cosmos reader: every local source Claude Code writes (DATA_SPEC §1, S1-S9).
//
// READ-ONLY. This module never writes anywhere. It never opens
// ~/.claude/sessions/*.key, tool-results/, memory/, *.prefix.json or sockets.
//
// Transcripts (S1 main, S2 ships) are tailed incrementally: a 2 s stat poll plus
// a recursive fs.watch for low latency, reads of at most 16 MB per chunk,
// partial-line hold-back (the offset only ever advances past a '\n'), rewrite
// detection (size shrink or a change in the 64 bytes before the offset bumps
// the file's epoch and re-reads it from 0), and one try/JSON.parse per line.
//
// PRIVACY: entries are "slimmed" here, before anything else sees them. Only
// structural fields survive (types, ids, timestamps, usage, tool names, file
// paths, titles). Message text, prompts, tool output and `last-prompt` never
// leave this module. Bulky lines (api-request-blob/shape, file-history-*,
// queue-operation, last-prompt, ...) are recognised from their first bytes and
// never parsed. Attachments are recognised from their head and only their
// trailing top-level fields (uuid, timestamp, cwd, ...) are parsed.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const CHUNK = 16 * 1024 * 1024;
const HEAD = 400;
const POLL_MS = 2000;
const WATCH_DEBOUNCE_MS = 120;
const REGISTRY_DEBOUNCE_MS = 15;
const PS_RECHECK_MS = 30000;
const PROJECTS_MIN_MS = 10000;

// Lines whose type is the first key and which Cosmos keeps only as {type, t}.
// They are never JSON-parsed (DATA_SPEC §1 "bulky types", plus text carriers).
const LIGHT_TYPES = new Set([
  'api-request-blob', 'api-request-shape', 'file-history-snapshot', 'file-history-delta',
  'last-prompt', 'queue-operation', 'cost-state', 'frame-link', 'bridge-session',
  'dev-mods', 'atis-latch', 'artifact-comment-monitor', 'artifact-autoreact-ledger',
]);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

const RE_HEAD_TYPE = /^\{"type":"([^"]+)"/;
const RE_TS = /"timestamp":"([^"]+)"/;
const RE_ATTACH_HEAD = /^\{"parentUuid":(?:null|"([^"]*)"),"isSidechain":(?:true|false),(?:"agentId":"[^"]*",)?"attachment":\{"type":"([^"]+)"/;
const ATTACH_TAIL = Buffer.from('"type":"attachment","uuid":"');
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const toS = (iso) => {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
};
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

// ---------------------------------------------------------------------------
// Slimming (pure; exported for tests)

function common(o) {
  const e = { type: o.type, t: toS(o.timestamp) };
  if (o.uuid) e.uuid = o.uuid;
  if (o.parentUuid) e.parentUuid = o.parentUuid;
  if (o.sessionId) e.sessionId = o.sessionId;
  if (o.cwd) e.cwd = o.cwd;
  if (o.entrypoint) e.entrypoint = o.entrypoint;
  if (o.version) e.version = o.version;
  if (o.agentId) e.agentId = o.agentId;
  if (o.gitBranch) e.gitBranch = o.gitBranch;
  return e;
}

/**
 * Reduce one parsed transcript line to structural fields only.
 * Shapes (all also carry type, t (epoch s|null), uuid?, parentUuid?, sessionId?, cwd?, entrypoint?, version?, agentId?, gitBranch?):
 *  user:      { isMeta, isCompactSummary, prompt (bool: has human-visible text/image), interrupted: 'user'|'tool'|null,
 *               turnOrigin, originKind, toolDenialKind, shutdown, results: [{ id, isError }], agentResult: { agentId, status }|null }
 *  assistant: { msgId, model, stop, usage: { input, output, cacheRead, cacheCreate, thinking }, apiError, apiStatus,
 *               thinkingMs, tools: [{ id, name, path, agentType }] }
 *  system:    { subtype, compact: { trigger, preTokens, postTokens, dropped, durationMs }|null, retryAttempt, maxRetries, retryInMs, apiStatus, isMeta }
 *  attachment:{ attachmentType }
 *  api-request: { id, querySource }
 *  custom-title / agent-name / ai-title: { title }   mode: { mode }
 *  anything else: { type, t }
 */
export function slimEntry(o) {
  if (!o || typeof o !== 'object' || typeof o.type !== 'string') return null;
  const ty = o.type;
  if (ty === 'user') {
    const e = common(o);
    const c = o.message?.content;
    let prompt = false, interrupted = null;
    const results = [];
    const textCheck = (s) => {
      if (typeof s !== 'string') return;
      if (s.startsWith('[Request interrupted by user')) interrupted = s.includes('for tool use') ? 'tool' : 'user';
    };
    if (typeof c === 'string') { prompt = true; textCheck(c); }
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') results.push({ id: b.tool_use_id ?? null, isError: b.is_error === true });
        else if (b.type === 'text') { prompt = true; textCheck(b.text); }
        else if (b.type === 'image' || b.type === 'document') prompt = true;
      }
    }
    e.isMeta = o.isMeta === true;
    e.isCompactSummary = o.isCompactSummary === true;
    e.prompt = prompt && results.length === 0;
    e.interrupted = interrupted;
    e.turnOrigin = typeof o.turnOrigin === 'string' ? o.turnOrigin : null;
    e.originKind = typeof o.origin?.kind === 'string' ? o.origin.kind : null;
    e.toolDenialKind = typeof o.toolDenialKind === 'string' ? o.toolDenialKind : null;
    e.shutdown = o.interruptedByShutdown === true;
    e.results = results;
    const r = o.toolUseResult;
    e.agentResult = (r && typeof r === 'object' && !Array.isArray(r) && typeof r.agentId === 'string')
      ? { agentId: r.agentId, status: typeof r.status === 'string' ? r.status : null } : null;
    return e;
  }
  if (ty === 'assistant') {
    const e = common(o);
    const m = o.message || {};
    const u = m.usage || {};
    e.msgId = typeof m.id === 'string' ? m.id : null;
    e.model = typeof m.model === 'string' ? m.model : null;
    e.stop = typeof m.stop_reason === 'string' ? m.stop_reason : null;
    e.usage = {
      input: num(u.input_tokens), output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens), cacheCreate: num(u.cache_creation_input_tokens),
      thinking: num(u.output_tokens_details?.thinking_tokens),
    };
    e.apiError = o.isApiErrorMessage === true;
    e.apiStatus = typeof o.apiErrorStatus === 'number' ? o.apiErrorStatus : null;
    e.thinkingMs = typeof o.thinkingDurationMs === 'number' ? o.thinkingDurationMs : null;
    const tools = [];
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== 'tool_use') continue;
        const inp = b.input && typeof b.input === 'object' ? b.input : {};
        let p = null;
        if (FILE_TOOLS.has(b.name)) {
          p = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : null;
        }
        tools.push({
          id: b.id ?? null, name: typeof b.name === 'string' ? b.name : '?', path: p,
          agentType: typeof inp.subagent_type === 'string' ? inp.subagent_type : null,
        });
      }
    }
    e.tools = tools;
    return e;
  }
  if (ty === 'system') {
    const e = common(o);
    e.subtype = typeof o.subtype === 'string' ? o.subtype : null;
    const cm = o.compactMetadata;
    e.compact = cm && typeof cm === 'object' ? {
      trigger: typeof cm.trigger === 'string' ? cm.trigger : null,
      preTokens: num(cm.preTokens), postTokens: num(cm.postTokens),
      dropped: num(cm.cumulativeDroppedTokens), durationMs: num(cm.durationMs),
    } : null;
    e.retryAttempt = typeof o.retryAttempt === 'number' ? o.retryAttempt : null;
    e.maxRetries = typeof o.maxRetries === 'number' ? o.maxRetries : null;
    e.retryInMs = typeof o.retryInMs === 'number' ? o.retryInMs : null;
    e.apiStatus = typeof o.error?.status === 'number' ? o.error.status : null;
    e.isMeta = o.isMeta === true;
    return e;
  }
  if (ty === 'attachment') {
    const e = common(o);
    e.attachmentType = typeof o.attachment?.type === 'string' ? o.attachment.type : null;
    return e;
  }
  if (ty === 'api-request') {
    return { type: ty, t: toS(o.timestamp), id: typeof o.id === 'string' ? o.id : null,
      agentId: o.agentId || undefined, querySource: typeof o.querySource === 'string' ? o.querySource : null };
  }
  if (ty === 'custom-title') return { type: ty, t: null, title: typeof o.customTitle === 'string' ? o.customTitle : null };
  if (ty === 'agent-name') return { type: ty, t: null, title: typeof o.agentName === 'string' ? o.agentName : null };
  if (ty === 'ai-title') return { type: ty, t: null, title: typeof o.aiTitle === 'string' ? o.aiTitle : null };
  if (ty === 'mode') return { type: ty, t: null, mode: typeof o.mode === 'string' ? o.mode : null };
  return { type: ty, t: toS(o.timestamp) };
}

/**
 * Parse one transcript line (a Buffer slice [s, e) without the '\n') into a slim
 * entry, skipping bulky and text-carrying types without a full parse.
 * Returns null for blank lines; throws nothing (a bad line returns { bad: true }).
 */
export function parseLine(buf, s, e) {
  if (e <= s) return null;
  const head = buf.toString('utf8', s, Math.min(e, s + HEAD));
  const mt = RE_HEAD_TYPE.exec(head);
  if (mt && LIGHT_TYPES.has(mt[1])) {
    const ts = RE_TS.exec(head);
    return { type: mt[1], t: ts ? toS(ts[1]) : null };
  }
  if (!mt) {
    const ma = RE_ATTACH_HEAD.exec(head);
    if (ma) {
      const p = buf.lastIndexOf(ATTACH_TAIL, e - 1);
      if (p > s) {
        try {
          const o = JSON.parse('{' + buf.toString('utf8', p, e));
          o.parentUuid = ma[1] || null;
          o.attachment = { type: ma[2] };
          const r = slimEntry(o);
          if (r) return r;
        } catch { /* fall through to a full parse */ }
      }
    }
  }
  try {
    return slimEntry(JSON.parse(buf.toString('utf8', s, e))) || { bad: true };
  } catch {
    return { bad: true };
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }
function readdirSafe(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** Parse "Thu Oct 29 16:37:18 2026" as UTC (S5 procStart) -> epoch s. */
export function parseProcStartUtc(s) {
  if (typeof s !== 'string') return null;
  const ms = Date.parse(s.trim().replace(/\s+/g, ' ') + ' UTC');
  return Number.isFinite(ms) ? ms / 1000 : null;
}
/** Parse ps lstart output (local time) -> epoch s. */
export function parsePsLocal(s) {
  const ms = Date.parse(String(s).trim().replace(/\s+/g, ' '));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------

/**
 * createReader(opts) -> Reader   (GALAXY_CONTRACT §3.1)
 * Additive extras beyond the contract: opts.pollMs, opts.watch (default true),
 * opts.onProgress({ files, filesDone, bytes, ms }), reader.progress(), reader.stats(),
 * fileInfo.reset (true on the first batch after a rewrite) and fileInfo.wf (workflow id).
 */
export function createReader(opts = {}) {
  const home = os.homedir();
  const claudeHome = opts.claudeHome || path.join(home, '.claude');
  const appSupport = opts.appSupport || path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  const claudeJson = opts.claudeJson || path.join(home, '.claude.json');
  const projectsDir = path.join(claudeHome, 'projects');
  const sessionsDir = path.join(claudeHome, 'sessions');
  const pollMs = opts.pollMs ?? POLL_MS;
  const noop = () => {};
  const onEntries = opts.onEntries || noop;
  const onRegistry = opts.onRegistry || noop;
  const onAppMeta = opts.onAppMeta || noop;
  const onSubMeta = opts.onSubMeta || noop;
  const onTitleFile = opts.onTitleFile || noop;
  const onProjects = opts.onProjects || noop;
  const onLiveness = opts.onLiveness || noop;
  const onProgress = opts.onProgress || noop;
  const skipFile = opts.skipFile || (() => false);

  // key -> { offset, size, mtimeMs, last64, epoch }
  const fstate = new Map();
  if (opts.state && opts.state.files && typeof opts.state.files === 'object') {
    for (const [k, v] of Object.entries(opts.state.files)) {
      if (v && Number.isFinite(v.offset)) fstate.set(k, { offset: v.offset, size: v.size ?? 0, mtimeMs: v.mtimeMs ?? 0, last64: v.last64 ?? '', head256: v.head256 ?? null, epoch: v.epoch ?? 0 });
    }
  }
  const known = new Map();     // key -> fileInfo (transcripts)
  const skipped = new Set();   // keys skipFile() said never to read
  const metaMtimes = new Map(); // abs path -> mtimeMs for S3/S4 json files
  const s6Cache = new Map();    // abs path -> { mtimeMs, data }
  let s6Last = null;            // last S6 map (cliSessionId -> record), for fork ordering
  let s6Sig = '';
  let projectsMtime = -1, projectsCheckedAt = 0;
  let registrySig = '';
  let registry = [];
  const procCache = new Map();  // pid -> { ok, at, procStart }
  const progress = { files: 0, filesDone: 0, bytes: 0, ms: 0, done: false };
  const stats = { lines: 0, bad: 0, bytes: 0, reads: 0, rewrites: 0 };

  let stopped = false;
  let pollTimer = null, liveTimer = null, regTimer = null, watchTimer = null;
  let watchers = [];
  let busy = null;              // promise of the running read pass
  const dirty = new Set();      // keys flagged by fs.watch
  let started = false;
  let passing = false;
  let chunkBuf = null;

  // ---------------- discovery (S1, S2, S3, S4)
  function classify(rel) {
    // rel uses '/' separators, relative to projectsDir
    const parts = rel.split('/');
    if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
      const sid = parts[1].slice(0, -6);
      if (!RE_UUID.test(sid)) return null;
      return { key: rel, kind: 'main', sid, folder: parts[0] };
    }
    const si = parts.indexOf('subagents');
    if (si === 2 && parts.length >= 4) {
      const name = parts[parts.length - 1];
      const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
      if (!m) return null;
      const wfPart = parts.find((p) => p.startsWith('wf_'));
      return { key: rel, kind: 'ship', sid: parts[1], agentId: m[1], wf: wfPart || null, folder: parts[0] };
    }
    return null;
  }

  function discover() {
    const files = [];   // [{ info, abs }]
    const metas = [];   // [{ kind:'meta'|'journal'|'title'|'released', abs, sid, agentId?, wf? }]
    for (const d of readdirSafe(projectsDir)) {
      if (!d.isDirectory()) continue;
      const folder = d.name;
      const fdir = path.join(projectsDir, folder);
      for (const e of readdirSafe(fdir)) {
        if (e.isFile()) {
          if (e.name.endsWith('.jsonl')) {
            const info = classify(`${folder}/${e.name}`);
            if (info) files.push({ info, abs: path.join(fdir, e.name) });
          } else if (e.name.endsWith('.desktop-released.json')) {
            const sid = e.name.slice(0, -'.desktop-released.json'.length);
            if (RE_UUID.test(sid)) metas.push({ kind: 'released', abs: path.join(fdir, e.name), sid });
          }
        } else if (e.isDirectory() && RE_UUID.test(e.name)) {
          const sid = e.name;
          const sdir = path.join(fdir, sid);
          for (const s of readdirSafe(sdir)) {
            if (s.isFile() && s.name === 'custom-title.json') metas.push({ kind: 'title', abs: path.join(sdir, s.name), sid });
            else if (s.isDirectory() && s.name === 'subagents') walkSub(path.join(sdir, 'subagents'), `${folder}/${sid}/subagents`, sid, null, files, metas, 0);
            // tool-results/, memory/, workflows/ (session-level) are never opened.
          }
        }
      }
    }
    return { files, metas };
  }

  function walkSub(dir, rel, sid, wf, files, metas, depth) {
    if (depth > 4) return;
    for (const e of readdirSafe(dir)) {
      if (e.isDirectory()) {
        if (e.name === 'tool-results' || e.name === 'memory') continue;
        const nwf = e.name.startsWith('wf_') ? e.name : wf;
        walkSub(path.join(dir, e.name), `${rel}/${e.name}`, sid, nwf, files, metas, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const n = e.name;
      if (n.endsWith('.prefix.json')) continue;
      const abs = path.join(dir, n);
      let m;
      if ((m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(n))) {
        files.push({ info: { key: `${rel}/${n}`, kind: 'ship', sid, agentId: m[1], wf, folder: rel.split('/')[0] }, abs });
      } else if ((m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(n))) {
        metas.push({ kind: 'meta', abs, sid, agentId: m[1], wf });
      } else if (n === 'journal.jsonl' && wf) {
        metas.push({ kind: 'journal', abs, sid, wf });
      }
    }
  }

  function processMetas(metas) {
    for (const m of metas) {
      const st = statSafe(m.abs);
      if (!st) continue;
      if (metaMtimes.get(m.abs) === st.mtimeMs) continue;
      metaMtimes.set(m.abs, st.mtimeMs);
      if (m.kind === 'meta') {
        const j = readJsonSafe(m.abs);
        if (!j) continue;
        onSubMeta(m.agentId, {
          sid: m.sid, wf: m.wf,
          agentType: typeof j.agentType === 'string' ? j.agentType : null,
          // description is a short label the orchestrator wrote; cut to 40 chars here.
          description: typeof j.description === 'string' ? j.description.slice(0, 40) : null,
          workflowPhase: typeof j.workflowPhase === 'string' ? j.workflowPhase : null,
          spawnDepth: typeof j.spawnDepth === 'number' ? j.spawnDepth : null,
          toolUseId: typeof j.toolUseId === 'string' ? j.toolUseId : null,
          model: typeof j.model === 'string' ? j.model : null,
          finished: j.finished === true,
        });
      } else if (m.kind === 'journal') {
        let txt = '';
        try { txt = fs.readFileSync(m.abs, 'utf8'); } catch { continue; }
        const per = new Map();
        for (const line of txt.split('\n')) {
          if (!line) continue;
          // Only the head is inspected; `result` text is never parsed or kept.
          const h = line.slice(0, 600);
          const ty = /"type":"([^"]+)"/.exec(h)?.[1];
          const aid = /"agentId":"([^"]+)"/.exec(h)?.[1];
          if (!aid || (ty !== 'started' && ty !== 'result')) continue;
          const cur = per.get(aid) || { sid: m.sid, wf: m.wf, journalLabel: null, journalPhase: null, journalDone: false };
          if (ty === 'started') {
            cur.journalLabel = /"label":"([^"]{0,80})"/.exec(h)?.[1] ?? cur.journalLabel;
            cur.journalPhase = /"phase":"([^"]{0,60})"/.exec(h)?.[1] ?? cur.journalPhase;
          } else cur.journalDone = true;
          per.set(aid, cur);
        }
        for (const [aid, v] of per) onSubMeta(aid, v);
      } else if (m.kind === 'title') {
        const j = readJsonSafe(m.abs);
        onTitleFile(m.sid, { customTitle: typeof j?.customTitle === 'string' ? j.customTitle : null });
      } else if (m.kind === 'released') {
        const j = readJsonSafe(m.abs);
        onTitleFile(m.sid, { released: { at: toS(j?.releasedAt), reason: typeof j?.reason === 'string' ? j.reason : null } });
      }
    }
  }

  // ---------------- transcript tail (S1, S2)
  async function readNew(info, abs) {
    const st = statSafe(abs);
    if (!st) return;
    let fs0 = fstate.get(info.key);
    if (!fs0) { fs0 = { offset: 0, size: 0, mtimeMs: 0, last64: '', head256: null, epoch: 0 }; fstate.set(info.key, fs0); }
    if (st.size === fs0.size && st.mtimeMs === fs0.mtimeMs && fs0.offset <= st.size) return;
    let reset = false;
    let fh;
    try { fh = await fsp.open(abs, 'r'); } catch { return; }
    try {
      if (st.size < fs0.offset) reset = true;
      else if (fs0.offset > 0) {
        const n = Math.min(64, fs0.offset);
        const b = Buffer.alloc(n);
        await fh.read(b, 0, n, fs0.offset - n);
        if (b.toString('base64') !== fs0.last64) reset = true;
        // Also fingerprint the first 256 bytes: a same-size rewrite can end in the same 64 bytes.
        if (!reset && fs0.head256 != null) {
          const hn = Math.min(256, fs0.offset);
          const hb = Buffer.alloc(hn);
          await fh.read(hb, 0, hn, 0);
          if (hb.toString('base64') !== fs0.head256) reset = true;
        }
      }
      if (reset) { fs0.epoch += 1; fs0.offset = 0; stats.rewrites++; }
      const fileInfo = { key: info.key, kind: info.kind, sid: info.sid, epoch: fs0.epoch };
      if (info.agentId) fileInfo.agentId = info.agentId;
      if (info.wf) fileInfo.wf = info.wf;
      if (reset) fileInfo.reset = true;
      let pos = fs0.offset;
      let carry = null;
      const end = st.size;
      while (pos < end && !stopped) {
        const want = Math.min(CHUNK, end - pos);
        // One reusable chunk: lines are parsed synchronously before the next read and
        // only strings survive, so nothing references the buffer afterwards.
        if (!chunkBuf) chunkBuf = Buffer.allocUnsafe(CHUNK);
        const chunk = chunkBuf;
        const { bytesRead } = await fh.read(chunk, 0, want, pos);
        if (bytesRead <= 0) break;
        stats.reads++;
        const data = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const base = pos - (carry ? carry.length : 0);
        pos += bytesRead;
        const lastNl = data.lastIndexOf(10);
        if (lastNl < 0) { carry = carry ? data : Buffer.from(data); continue; } // never alias chunkBuf
        const entries = [];
        let s = 0;
        while (s <= lastNl) {
          const e = data.indexOf(10, s);
          const len = e - s;
          if (len > 0) {
            stats.lines++;
            const ent = parseLine(data, s, e);
            if (ent && ent.bad) stats.bad++;
            else if (ent) {
              ent.__off = base + s; ent.__len = len; ent.__epoch = fs0.epoch;
              entries.push(ent);
            }
          }
          s = e + 1;
        }
        carry = lastNl + 1 < data.length ? Buffer.from(data.subarray(lastNl + 1)) : null;
        fs0.offset = base + lastNl + 1;
        stats.bytes += lastNl + 1;
        progress.bytes += lastNl + 1;
        if (entries.length) {
          try { onEntries(fileInfo, entries); } catch (err) { console.error('[cosmos reader] onEntries failed:', err); }
          delete fileInfo.reset;
        }
        // Yield between chunks so the HTTP server stays responsive during the first scan.
        await new Promise((r) => setImmediate(r));
      }
      // last64 = the 64 bytes just before the offset (rewrite detection next time).
      if (fs0.offset > 0) {
        const n = Math.min(64, fs0.offset);
        const b = Buffer.alloc(n);
        await fh.read(b, 0, n, fs0.offset - n);
        fs0.last64 = b.toString('base64');
        const hn = Math.min(256, fs0.offset);
        const hb = Buffer.alloc(hn);
        await fh.read(hb, 0, hn, 0);
        fs0.head256 = hb.toString('base64');
      } else { fs0.last64 = ''; fs0.head256 = null; }
      // A trailing partial line stays on disk: offset never passes it.
      fs0.size = st.size;
      fs0.mtimeMs = st.mtimeMs;
      if (fs0.offset < st.size) fs0.size = fs0.offset; // force a re-check next poll
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async function firstTimestamp(abs) {
    let fh;
    try {
      fh = await fsp.open(abs, 'r');
      for (const n of [16384, 262144, 4194304]) {
        const b = Buffer.alloc(n);
        const { bytesRead } = await fh.read(b, 0, n, 0);
        const m = RE_TS.exec(b.toString('utf8', 0, bytesRead));
        if (m) return toS(m[1]) ?? Infinity;
        if (bytesRead < n) break;
      }
    } catch { /* unreadable */ } finally { if (fh) await fh.close().catch(() => {}); }
    return Infinity;
  }

  async function pass(first) {
    const { files, metas } = discover();
    // Metadata first so ship labels and links exist when ship entries arrive.
    processMetas(metas);
    let todo = [];
    for (const f of files) {
      if (skipped.has(f.info.key)) continue;
      if (!known.has(f.info.key)) {
        let skip = false;
        try { skip = !!skipFile(f.abs); } catch { skip = false; }
        if (skip) { skipped.add(f.info.key); continue; }
        known.set(f.info.key, f.info);
      }
      todo.push(f);
    }
    if (first) {
      // Fork dedupe credits the earliest file: read files in order of their first timestamp.
      // A fork copies its parent's entries, so both share a first timestamp: ties go to the
      // file created first (birth time), then mains before ships, then by key.
      const withT = await Promise.all(todo.map(async (f) => ({ f, t: await firstTimestamp(f.abs), b: statSafe(f.abs)?.birthtimeMs ?? 0 })));
      const kindRank = (x) => (x.f.info.kind === 'main' ? 0 : 1);
      // Birth time lies when a parent's file is re-created after the fork, so S6
      // lineage breaks a tie first: the session S6 records as a fork (forkedFrom,
      // or spawnedFrom.userFork) is the child even when its parent's local_ file
      // is gone, so the other file of the pair is read (and credited) first.
      const forkRank = (x) => {
        if (x.f.info.kind !== 'main') return 0;
        const r = s6Last?.get(x.f.info.sid);
        return r && !r.viaPrior && (r.forkedFrom || r.spawnedFrom?.userFork) ? 1 : 0;
      };
      withT.sort((a, b) => (a.t - b.t) || (forkRank(a) - forkRank(b)) || (a.b - b.b) || (kindRank(a) - kindRank(b)) || a.f.info.key.localeCompare(b.f.info.key));
      todo = withT.map((x) => x.f);
      progress.files = todo.length;
    } else {
      // New files: oldest first too (a just-created fork after its parent).
      todo.sort((a, b) => (statSafe(a.abs)?.birthtimeMs ?? 0) - (statSafe(b.abs)?.birthtimeMs ?? 0));
    }
    const t0 = Date.now();
    for (const f of todo) {
      if (stopped) return;
      await readNew(f.info, f.abs);
      if (first) { progress.filesDone++; progress.ms = Date.now() - t0; onProgress({ ...progress }); }
    }
    if (first) { progress.done = true; progress.ms = Date.now() - t0; }
  }

  async function readDirty() {
    const keys = [...dirty];
    dirty.clear();
    for (const key of keys) {
      const info = known.get(key) || classify(key);
      if (!info || skipped.has(key)) continue;
      if (!known.has(key)) {
        // A new transcript: let the full poll pass discover it (keeps ordering and skipFile).
        continue;
      }
      await readNew(info, path.join(projectsDir, ...key.split('/')));
    }
  }

  function runExclusive(fn) {
    const prev = busy || Promise.resolve();
    const next = prev.then(fn, fn).catch((err) => console.error('[cosmos reader]', err));
    busy = next;
    return next;
  }

  // ---------------- registry (S5) + liveness (S9)
  function readRegistry() {
    const recs = [];
    for (const e of readdirSafe(sessionsDir)) {
      if (!e.isFile() || !/^\d+\.json$/.test(e.name)) continue; // never *.key
      const j = readJsonSafe(path.join(sessionsDir, e.name));
      if (!j || typeof j.sessionId !== 'string') continue;
      const pid = Number.isInteger(j.pid) ? j.pid : parseInt(e.name, 10);
      const c = procCache.get(pid);
      recs.push({
        pid, sessionId: j.sessionId, cwd: typeof j.cwd === 'string' ? j.cwd : null,
        status: typeof j.status === 'string' ? j.status : null,
        waitingFor: typeof j.waitingFor === 'string' ? j.waitingFor : null,
        statusUpdatedAt: typeof j.statusUpdatedAt === 'number' ? j.statusUpdatedAt / 1000 : null,
        updatedAt: typeof j.updatedAt === 'number' ? j.updatedAt / 1000 : null,
        startedAt: typeof j.startedAt === 'number' ? j.startedAt / 1000 : null,
        procStart: typeof j.procStart === 'string' ? j.procStart : null,
        kind: typeof j.kind === 'string' ? j.kind : null,
        entrypoint: typeof j.entrypoint === 'string' ? j.entrypoint : null,
        // The desktop app's own id for the session (opens it in the app: claude://claude.ai/epitaxy/<id>).
        appSession: typeof j.hostSessionId === 'string' && /^local_[A-Za-z0-9-]{8,64}$/.test(j.hostSessionId) ? j.hostSessionId : null,
        name: typeof j.name === 'string' ? j.name : null,
        nameSource: typeof j.nameSource === 'string' ? j.nameSource : null,
        version: typeof j.version === 'string' ? j.version : null,
        alive: pidAlive(pid),
        procStartOk: c && c.procStart === j.procStart ? c.ok : null,
      });
    }
    recs.sort((a, b) => a.pid - b.pid);
    return recs;
  }

  function refreshRegistry(force) {
    if (stopped) return;
    const recs = readRegistry();
    const sig = JSON.stringify(recs);
    if (!force && sig === registrySig) return;
    registrySig = sig;
    registry = recs;
    try { onRegistry(recs); } catch (err) { console.error('[cosmos reader] onRegistry failed:', err); }
    const need = recs.filter((r) => r.alive && r.procStart && (!procCache.has(r.pid) || procCache.get(r.pid).procStart !== r.procStart));
    if (need.length) checkProcStarts(need.map((r) => r.pid));
  }

  function checkProcStarts(pids) {
    if (!pids.length || stopped) return;
    execFile('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { timeout: 3000 }, (err, stdout) => {
      if (stopped) return;
      const seen = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (m) seen.set(+m[1], parsePsLocal(m[2]));
      }
      const now = Date.now();
      let changed = false;
      for (const pid of pids) {
        const rec = registry.find((r) => r.pid === pid);
        if (!rec) continue;
        const want = parseProcStartUtc(rec.procStart);
        const got = seen.get(pid);
        const ok = got != null && want != null ? Math.abs(got - want) <= 2 : (got == null ? false : null);
        const prev = procCache.get(pid);
        procCache.set(pid, { ok, at: now, procStart: rec.procStart });
        if (!prev || prev.ok !== ok) { rec.procStartOk = ok; changed = true; try { onLiveness(pid, pidAlive(pid), ok); } catch (e) { console.error(e); } }
      }
      if (changed) { registrySig = ''; refreshRegistry(false); }
    });
  }

  function livenessTick() {
    if (stopped) return;
    const recheck = [];
    const now = Date.now();
    for (const r of registry) {
      const alive = pidAlive(r.pid);
      const c = procCache.get(r.pid);
      if (alive && r.procStart && (!c || now - c.at > PS_RECHECK_MS)) recheck.push(r.pid);
      try { onLiveness(r.pid, alive, c && c.procStart === r.procStart ? c.ok : null); } catch (err) { console.error(err); }
    }
    checkProcStarts(recheck);
  }

  // ---------------- app metadata (S6)
  function readAppMeta() {
    const out = new Map();
    const deleted = new Set();
    const archivedLocal = new Set();
    const locals = [];
    let sigParts = [];
    for (const acct of readdirSafe(appSupport)) {
      if (!acct.isDirectory()) continue;
      const adir = path.join(appSupport, acct.name);
      for (const org of readdirSafe(adir)) {
        if (!org.isDirectory()) continue;
        const odir = path.join(adir, org.name);
        for (const e of readdirSafe(odir)) {
          if (!e.isFile()) continue;
          const abs = path.join(odir, e.name);
          if (e.name.startsWith('deleted_')) { deleted.add(e.name.slice(8)); sigParts.push(e.name); continue; }
          if (e.name === 'archived-sessions.idx' || (e.name.startsWith('local_') && e.name.endsWith('.json'))) {
            const st = statSafe(abs);
            if (!st) continue;
            sigParts.push(`${e.name}:${st.mtimeMs}`);
            let c = s6Cache.get(abs);
            if (!c || c.mtimeMs !== st.mtimeMs) {
              const j = readJsonSafe(abs);
              c = { mtimeMs: st.mtimeMs, data: j ? slimS6(e.name, j) : null };
              s6Cache.set(abs, c);
            }
            if (!c.data) continue;
            if (e.name === 'archived-sessions.idx') for (const id of c.data.archived) archivedLocal.add(id);
            else locals.push(c.data);
          }
        }
      }
    }
    const sig = sigParts.sort().join('|');
    if (sig === s6Sig) return null;
    s6Sig = sig;
    const byLocal = new Map(locals.map((l) => [l.localId, l]));
    const cliOf = (localId) => byLocal.get(localId)?.cliSessionId ?? null;
    for (const l of locals) {
      const rec = {
        localId: l.localId, cliSessionId: l.cliSessionId, title: l.title, titleSource: l.titleSource,
        isArchived: l.isArchived || archivedLocal.has(l.localId), branch: l.branch,
        statusCategory: l.statusCategory, scheduledTaskId: l.scheduledTaskId,
        spawnedFrom: l.spawnedFrom ? { ...l.spawnedFrom, cliSessionId: cliOf(l.spawnedFrom.localId) } : null,
        forkedFrom: l.forkedFromLocal ? { localId: l.forkedFromLocal, cliSessionId: cliOf(l.forkedFromLocal) } : null,
        deleted: false, viaPrior: false,
      };
      if (l.cliSessionId) out.set(l.cliSessionId, rec);
      for (const p of l.priorCliSessionIds) if (!out.has(p)) out.set(p, { ...rec, viaPrior: true });
    }
    for (const sid of deleted) {
      const cur = out.get(sid);
      if (cur) cur.deleted = true;
      else out.set(sid, { cliSessionId: sid, deleted: true, title: null, titleSource: null, isArchived: false, viaPrior: false });
    }
    return out;
  }

  function slimS6(name, j) {
    if (name === 'archived-sessions.idx') return { archived: Array.isArray(j.archived) ? j.archived.filter((x) => typeof x === 'string') : [] };
    const sf = j.spawnedFrom && typeof j.spawnedFrom === 'object' ? j.spawnedFrom : null;
    return {
      localId: typeof j.sessionId === 'string' ? j.sessionId : name.slice(0, -5),
      cliSessionId: typeof j.cliSessionId === 'string' ? j.cliSessionId : null,
      priorCliSessionIds: Array.isArray(j.priorCliSessionIds) ? j.priorCliSessionIds.filter((x) => typeof x === 'string') : [],
      title: typeof j.title === 'string' ? j.title : null,
      titleSource: typeof j.titleSource === 'string' ? j.titleSource : null,
      isArchived: j.isArchived === true,
      branch: typeof j.branch === 'string' ? j.branch : null,
      statusCategory: typeof j.postTurnSummary?.status_category === 'string' ? j.postTurnSummary.status_category : null,
      scheduledTaskId: typeof j.scheduledTaskId === 'string' ? j.scheduledTaskId : null,
      spawnedFrom: sf ? { localId: typeof sf.sessionId === 'string' ? sf.sessionId : null, userFork: sf.userFork === true, sideSession: sf.sideSession === true } : null,
      forkedFromLocal: typeof j.forkedFromSessionId === 'string' ? j.forkedFromSessionId : null,
    };
  }

  function refreshAppMeta() {
    const m = readAppMeta();
    if (m) s6Last = m;
    if (m) { try { onAppMeta(m); } catch (err) { console.error('[cosmos reader] onAppMeta failed:', err); } }
  }

  // ---------------- projects (S8)
  function refreshProjects(force) {
    const now = Date.now();
    if (!force && now - projectsCheckedAt < PROJECTS_MIN_MS) return;
    projectsCheckedAt = now;
    const st = statSafe(claudeJson);
    if (!st || st.mtimeMs === projectsMtime) return;
    projectsMtime = st.mtimeMs;
    const j = readJsonSafe(claudeJson);
    const keys = j && j.projects && typeof j.projects === 'object' ? Object.keys(j.projects) : [];
    try { onProjects(keys); } catch (err) { console.error('[cosmos reader] onProjects failed:', err); }
  }

  // ---------------- lifecycle
  function startWatchers() {
    if (opts.watch === false) return;
    try {
      const w = fs.watch(sessionsDir, { persistent: false }, () => {
        clearTimeout(regTimer);
        regTimer = setTimeout(() => refreshRegistry(false), REGISTRY_DEBOUNCE_MS);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch { /* the 2 s poll still covers it */ }
    try {
      const w = fs.watch(projectsDir, { persistent: false, recursive: true }, (_ev, fname) => {
        if (!fname) return;
        const rel = String(fname).split(path.sep).join('/');
        if (!rel.endsWith('.jsonl') || rel.includes('/tool-results/')) return;
        if (!known.has(rel)) return;
        dirty.add(rel);
        if (!watchTimer) watchTimer = setTimeout(() => { watchTimer = null; runExclusive(readDirty); }, WATCH_DEBOUNCE_MS);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch { /* poll only */ }
  }

  async function start() {
    if (started) return busy;
    started = true;
    refreshProjects(true);
    refreshAppMeta();
    refreshRegistry(true);
    livenessTick();
    startWatchers();
    await runExclusive(() => pass(true));
    if (stopped) return;
    pollTimer = setInterval(() => {
      refreshRegistry(false);
      refreshAppMeta();
      refreshProjects(false);
      if (!passing) { passing = true; runExclusive(() => pass(false)).finally(() => { passing = false; }); }
    }, pollMs);
    liveTimer = setInterval(livenessTick, pollMs);
    if (pollTimer.unref) { pollTimer.unref(); liveTimer.unref(); }
  }

  function stop() {
    stopped = true;
    clearInterval(pollTimer); clearInterval(liveTimer);
    clearTimeout(regTimer); clearTimeout(watchTimer);
    for (const w of watchers) { try { w.close(); } catch { /* closed */ } }
    watchers = [];
  }

  function state() {
    const files = {};
    for (const [k, v] of fstate) files[k] = { offset: v.offset, size: v.size, mtimeMs: v.mtimeMs, last64: v.last64, head256: v.head256, epoch: v.epoch };
    return { files };
  }

  /** Random access for diagnostics: ONE line by byte position. Never cached. */
  async function readLine(fileKey, off, len) {
    if (typeof fileKey !== 'string' || !fileKey.endsWith('.jsonl')) return null;
    if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len <= 0 || len > 64 * 1024 * 1024) return null;
    const abs = path.resolve(projectsDir, ...fileKey.split('/'));
    if (!abs.startsWith(projectsDir + path.sep) || fileKey.includes('..')) return null;
    if (/\/(tool-results|memory)\//.test(fileKey)) return null;
    let fh;
    try {
      fh = await fsp.open(abs, 'r');
      const b = Buffer.alloc(len);
      const { bytesRead } = await fh.read(b, 0, len, off);
      if (bytesRead !== len) return null;
      return b.toString('utf8');
    } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
  }

  return {
    start, stop, state, readLine,
    progress: () => ({ ...progress }),
    stats: () => ({ ...stats, files: known.size, skipped: skipped.size }),
    /** Force one incremental pass now (tests, and the model after a reset). */
    poll: () => runExclusive(() => pass(false)),
    registry: () => registry.slice(),
  };
}
