// Cosmos Gate 1 replay source: one real Claude Code transcript, read-only.
//
// buildReplay() reads ONE main transcript (~/.claude/projects/<folder>/<sid>.jsonl)
// plus its subagent files, and reduces it to a compact, structural event list
// following DATA_SPEC §3–4. The browser (web/src/replay.js) turns those events
// into SystemState frames through the same Tape → StarSystem seam the scripted
// scenes use.
//
// Privacy (DATA_SPEC header): only structural fields are kept: entry types,
// ids, timestamps, usage numbers, tool names and file paths. No message text,
// prompt, tool input other than the path, or tool output ever leaves here.
// Nothing is written anywhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Default pick: the most recent main transcript in this size range (big enough
// to show work, small enough to parse in well under a second).
const PICK_MIN_BYTES = 150 * 1024;
const PICK_MAX_BYTES = 24 * 1024 * 1024;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);
const NEEDS_TOOLS = new Map([['AskUserQuestion', 'question'], ['ExitPlanMode', 'plan']]);
// Bulky metadata lines: recognised from their head and never fully parsed.
const SKIP_HEAD = /"type"\s*:\s*"(api-request-blob|api-request-shape|file-history-[a-z-]*)"/;

const cache = new Map();   // file → { key, value }

/** All main transcripts: [{ sid, file, dir, size, mtimeMs }]. */
async function listMains() {
  const out = [];
  let folders;
  try {
    folders = await fs.promises.readdir(PROJECTS, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const f of folders) {
    if (!f.isDirectory()) continue;
    const dir = path.join(PROJECTS, f.name);
    let names;
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const sid = n.slice(0, -6);
      if (!SID_RE.test(sid)) continue;
      const file = path.join(dir, n);
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile()) out.push({ sid, file, dir, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return out;
}

/** Stream a JSONL file, calling fn(entry) for each parsable line. */
async function eachEntry(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (SKIP_HEAD.test(line.slice(0, 200))) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }   // one bad line is skipped, not fatal
    if (e && typeof e === 'object') fn(e);
  }
}

const tsOf = (e) => {
  const ms = Date.parse(e?.timestamp);
  return Number.isFinite(ms) ? ms / 1000 : null;
};
const isCore = (e) => e.type === 'user' || e.type === 'assistant' || e.type === 'system' || e.type === 'attachment';
const num = (x) => (Number.isFinite(x) ? x : 0);

/** Repo-relative path when it sits under the session's first cwd, else the last 2 segments. */
function relPath(p, cwd) {
  if (typeof p !== 'string' || !p) return null;
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p.split('/').filter(Boolean).slice(-2).join('/');
}

/** First and last core-entry timestamps of a subagent file, plus its agentType. */
async function readShip(file) {
  let t0 = null;
  let t1 = null;
  await eachEntry(file, (e) => {
    if (!isCore(e)) return;
    const t = tsOf(e);
    if (t == null) return;
    if (t0 == null || t < t0) t0 = t;
    if (t1 == null || t > t1) t1 = t;
  });
  let label = 'agent';
  try {
    const meta = JSON.parse(await fs.promises.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    if (typeof meta?.agentType === 'string' && meta.agentType.length < 40) label = meta.agentType;
  } catch { /* no meta: generic label */ }
  return t0 == null ? null : { t0, t1, label };
}

async function listShips(sessionDir) {
  const out = [];
  const walk = async (dir, depth) => {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (d.isFile() && /^agent-[\w-]+\.jsonl$/.test(d.name)) out.push(p);
    }
  };
  await walk(path.join(sessionDir, 'subagents'), 0);
  return out;
}

/**
 * Build the replay for one session.
 * @param {string|null} sid  a session id, or null for the default pick
 * @returns {Promise<object|null>} null when no transcript qualifies
 */
export async function buildReplay(sid) {
  const mains = await listMains();
  let pick;
  if (sid) {
    if (!SID_RE.test(sid)) return null;
    pick = mains.find((m) => m.sid === sid);
  } else {
    pick = mains
      .filter((m) => m.size >= PICK_MIN_BYTES && m.size <= PICK_MAX_BYTES)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  }
  if (!pick) return null;

  const key = `${pick.size}:${pick.mtimeMs}`;
  const hit = cache.get(pick.file);
  if (hit && hit.key === key) return hit.value;

  const events = [];
  const usageById = new Map();    // message.id → best usage (largest output_tokens)
  const toolNames = new Map();    // tool_use id → name
  const seenUuid = new Set();
  let cwd = null;
  let model = null;

  await eachEntry(pick.file, (e) => {
    const t = tsOf(e);
    if (t == null) return;
    if (e.uuid) {
      if (seenUuid.has(e.uuid)) return;
      seenUuid.add(e.uuid);
    }
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd.replace(/\/\.claude\/worktrees\/.*$/, '');

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const m = e.compactMetadata || {};
      events.push({ t, k: 'compact', id: String(e.uuid ?? t), pre: num(m.preTokens), post: num(m.postTokens) });
      return;
    }

    const msg = e.message;
    if (e.type === 'assistant' && msg && typeof msg === 'object') {
      if (msg.model === '<synthetic>' || e.isApiErrorMessage) return;
      if (typeof msg.model === 'string') model = msg.model;
      const u = msg.usage;
      if (u && msg.id) {
        const prev = usageById.get(msg.id);
        const out = num(u.output_tokens);
        if (!prev || out > prev.out) {
          usageById.set(msg.id, {
            t: prev ? prev.t : t,
            in: num(u.input_tokens),
            out,
            cr: num(u.cache_read_input_tokens),
            cc: num(u.cache_creation_input_tokens),
          });
        }
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== 'tool_use' || !b.id) continue;
        const name = typeof b.name === 'string' ? b.name.slice(0, 64) : 'tool';
        toolNames.set(b.id, name);
        const inp = b.input || {};
        const p = FILE_TOOLS.has(name) ? relPath(inp.file_path ?? inp.notebook_path, cwd) : null;
        const ev = { t, k: 'tool', id: b.id, tool: name };
        if (p) ev.path = p;
        if (NEEDS_TOOLS.has(name)) ev.needs = NEEDS_TOOLS.get(name);
        events.push(ev);
      }
      if (msg.stop_reason === 'end_turn') events.push({ t, k: 'end' });
      return;
    }

    if (e.type === 'user' && msg && typeof msg === 'object') {
      if (e.isMeta || e.isCompactSummary) return;
      const content = msg.content;
      let hadResult = false;
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
        hadResult = true;
        events.push({ t, k: 'result', id: b.tool_use_id, tool: toolNames.get(b.tool_use_id) ?? 'tool', err: b.is_error === true });
      }
      // A prompt (any origin) restarts work. Interrupt markers count as a turn end.
      if (!hadResult) {
        const head = typeof content === 'string' ? content.slice(0, 40)
          : Array.isArray(content) && typeof content[0]?.text === 'string' ? content[0].text.slice(0, 40) : '';
        events.push({ t, k: head.startsWith('[Request interrupted by user') ? 'end' : 'prompt' });
      }
    }
  });

  for (const [mid, u] of usageById) events.push({ t: u.t, k: 'usage', id: mid, in: u.in, out: u.out, cr: u.cr, cc: u.cc });

  const sessionDir = path.join(pick.dir, pick.sid);
  for (const f of await listShips(sessionDir)) {
    const s = await readShip(f);
    if (s) events.push({ t: s.t0, k: 'agent', id: path.basename(f, '.jsonl'), label: s.label, endT: s.t1 });
  }

  events.sort((a, b) => a.t - b.t);
  if (events.length === 0) return null;

  // Context limit (DATA_SPEC §4): table, raised to observedPeak / 0.97.
  let peak = 0;
  for (const u of usageById.values()) peak = Math.max(peak, u.in + u.cr + u.cc);
  const table = model && (/-5-5/.test(model) || /\[1m\]$/.test(model)) ? 1e6 : 200e3;
  const contextLimit = Math.round(Math.max(table, peak / 0.97));

  const value = {
    v: 1,
    id: pick.sid,
    model,
    contextLimit,
    t0: events[0].t,
    t1: events[events.length - 1].t,
    events,
  };
  cache.set(pick.file, { key, value });
  return value;
}
