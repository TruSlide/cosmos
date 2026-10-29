// Analysis & Diagnostic (GALAXY_CONTRACT §3.7).
//
// report():    zero tokens. A plain-English summary built from structured
//              event fields only (sentence templates below; every number comes
//              from `facts`). Written for someone learning to read errors.
// errorText(): free. Reads exactly ONE transcript line (the tool_result of one
//              failed call) on click, keeps <= 12 lines / 2 000 chars, marks
//              the parts worth reading and glosses them. Returned once; never
//              logged, cached, stored or put in an event.
// explain():   costs tokens, on an explicit confirm. Runs the owner's `claude`
//              CLI once with a cheap model and returns its REAL usage numbers,
//              adding them to the running total in cache/explain-usage.json.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { EV, eventId as makeEventId } from '../web/src/shared/schema.mjs';
import { httpError } from './security.mjs';

const WINDOW_BEFORE_S = 120;
const WINDOW_AFTER_S = 120;
const RECOVERY_LOOK_S = 600;
const MAX_TIMELINE = 8;
const ERR_MAX_LINES = 12;
const ERR_MAX_CHARS = 2000;
const EXPLAIN_TIMEOUT_MS = 60000;
const EXPLAIN_OUTPUT_EST = 450;

// ------------------------------------------------------------------ formatting

/** 12 -> "12 s", 192 -> "3m 12s", 7500 -> "2h 5m". */
export function fmtDur(s) {
  if (!Number.isFinite(s) || s < 0) return null;
  if (s < 10) return `${Math.round(s * 10) / 10} s`;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) { const m = Math.floor(s / 60); const r = Math.round(s - m * 60); return r ? `${m}m ${r}s` : `${m}m`; }
  const h = Math.floor(s / 3600); const m = Math.round((s - h * 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** 45210 -> "45.2k", 1250000 -> "1.25M". */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}M`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']; const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function what(tool, target) {
  if (!tool) return 'A tool call';
  return target ? `${tool} on ${target}` : tool;
}

const ENTRY_WORDS = {
  cli: 'the terminal', 'claude-desktop': 'the desktop app', 'claude-vscode': 'VS Code',
  'sdk-ts': 'a script (SDK)', 'sdk-py': 'a script (SDK)', 'sdk-cli': 'a one-shot command (claude -p)',
};
const ORIGIN_WORDS = {
  owner: 'you started it', peer: 'another session started it', sdk: 'a script started it',
  scheduled: 'a schedule started it', fork: 'it is a fork of another session',
};
const SUB_WORDS = {
  approve: 'your permission to run', question: 'an answer to a question', plan: 'your approval of a plan',
};
const HOW_END_WORDS = {
  answered: 'You answered', denied: 'You said no', interrupted: 'You interrupted it',
  'session-ended': 'The session ended before an answer',
};
const SHIP_HOW_WORDS = {
  finished: 'It finished and reported back.',
  notified: 'Claude Code sent a "done" notice for it.',
  completed: 'Its task was marked complete.',
  silence: 'Cosmos stopped hearing from it, so it treats it as done (no reply for a while).',
};
const CRASH_WORDS = {
  'unanswered-api-request': 'the last thing in the transcript is a request to Claude that never got an answer',
  'no-reply': 'Claude never replied to the last message',
  'pending-tool': 'a tool was still running when the session stopped',
  shutdown: 'Claude Code shut down in the middle of a turn',
  'api-error': 'the session stopped right after an API error',
  'dead-pid': 'the Claude Code process for this session is gone, but the session never finished cleanly',
};
const API_STATUS_WORDS = {
  400: 'the request was rejected as malformed',
  401: 'the login or API key was not accepted',
  403: 'the account is not allowed to do that',
  404: 'the model or endpoint was not found',
  408: 'the request timed out',
  413: 'the request was too large',
  429: 'too many requests (a rate limit)',
  500: 'a server error on Anthropic\'s side',
  502: 'a gateway error between you and the API',
  503: 'the service was temporarily unavailable',
  504: 'the API took too long to answer',
  529: 'the API was overloaded',
};

// ------------------------------------------------------------------ error text marks + gloss

const EXIT_CODE_PLAIN = {
  0: 'Exit code 0 means success.',
  1: 'Exit code 1 means the command ran and reported failure (the most common, general "it did not work").',
  2: 'Exit code 2 usually means the command was used wrongly (bad option or argument), or a test/lint found problems.',
  126: 'Exit code 126 means the file exists but is not allowed to run (permissions).',
  127: 'Exit code 127 means "command not found": the program name is wrong or not installed.',
  130: 'Exit code 130 means it was stopped with Ctrl-C (interrupted).',
  137: 'Exit code 137 means it was killed (often out of memory, or a timeout).',
  143: 'Exit code 143 means it was asked to stop (terminated).',
};

const ERROR_TYPE_PLAIN = [
  [/^ENOENT\b|No such file or directory/i, 'ENOENT / "No such file or directory": the path does not exist. Check spelling and the current folder.'],
  [/^EACCES\b|Permission denied/i, 'Permission denied: the file or folder exists, but this user may not read, write or run it.'],
  [/^EADDRINUSE\b/, 'EADDRINUSE: another program is already using that network port.'],
  [/^ECONNREFUSED\b/, 'ECONNREFUSED: nothing was listening at that address, so the connection was refused.'],
  [/^EEXIST\b/, 'EEXIST: something with that name already exists.'],
  [/^ENOTDIR\b|^EISDIR\b/, 'A file was used where a folder was expected, or the other way round.'],
  [/^SyntaxError\b/, 'SyntaxError: the code could not even be read, usually a typo such as a missing bracket or comma.'],
  [/^TypeError\b/, 'TypeError: a value was the wrong kind for what was done with it (for example calling something that is not a function, or reading a field of undefined).'],
  [/^ReferenceError\b/, 'ReferenceError: the code used a name that does not exist (a typo or a missing import).'],
  [/^RangeError\b/, 'RangeError: a number or size was outside what is allowed.'],
  [/^NameError\b/, 'NameError (Python): a name was used before it was defined.'],
  [/^ModuleNotFoundError\b|^ImportError\b|Cannot find module|ERR_MODULE_NOT_FOUND/, 'A module/package could not be found: it is not installed, or the import path is wrong.'],
  [/^KeyError\b/, 'KeyError (Python): a dictionary was asked for a key it does not have.'],
  [/^IndexError\b/, 'IndexError: a list was asked for a position past its end.'],
  [/^AttributeError\b/, 'AttributeError (Python): the object has no field or method with that name.'],
  [/^ValueError\b/, 'ValueError: right kind of value, wrong content (for example int("abc")).'],
  [/^AssertionError\b|assert/i, 'An assertion failed: a check in the code or a test found something different from what it expected.'],
  [/^Traceback\b/, 'Traceback (Python): the list of calls that led to the error. Read it bottom-up: the last line says what went wrong, the lines above say where.'],
  [/command not found/i, '"command not found": the shell does not know that program name (typo, or not installed / not on PATH).'],
  [/String to replace not found/i, 'Claude Code\'s Edit tool could not find the exact text it meant to replace, often because the file changed or the snippet was not copied exactly.'],
  [/File has not been read yet/i, 'Claude Code requires reading a file before editing it; the agent tried to edit first.'],
  [/doesn't want to proceed|was rejected|denied/i, 'This is a denial: you (or a permission rule) said no to the action. Not a bug.'],
  [/timed out|timeout/i, 'A timeout: the step took longer than it was allowed to and was stopped.'],
  [/Error\b|Exception\b/, 'An error type name: the first word that names what kind of problem happened.'],
];

const MARK_RULES = [
  { kind: 'exit-code', re: /\b(?:[Ee]xit (?:code|status)|exited with (?:code|status))[: ]+(\d{1,3})\b/g },
  { kind: 'file-line', re: /File "[^"\n]+", line \d+/g },
  { kind: 'file-line', re: /(?:[A-Za-z]:)?[\w./~@+-]*[\w-]\.[A-Za-z]{1,6}:\d+(?::\d+)?/g },
  { kind: 'error-type', re: /\b(?:Traceback \(most recent call last\)|[A-Z][A-Za-z]*(?:Error|Exception)|E(?:NOENT|ACCES|ADDRINUSE|CONNREFUSED|EXIST|NOTDIR|ISDIR|PERM)|ERR_[A-Z_]+)\b/g },
  { kind: 'error-type', re: /command not found|No such file or directory|Permission denied|String to replace not found|File has not been read yet/g },
  { kind: 'command', re: /^\s*(?:\$|>|\+) .+$/g },
  { kind: 'message', re: /\b(?:error|fatal|failed|FAIL)\b:?[^\n]{0,120}/g },
];

/** Marks on one line: non-overlapping, earlier rules win, sorted by start. */
export function markLine(text) {
  const marks = [];
  const overlaps = (s, e) => marks.some((m) => s < m.end && e > m.start);
  for (const rule of MARK_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const start = m.index; const end = m.index + m[0].length;
      if (end > start && !overlaps(start, end)) marks.push({ start, end, kind: rule.kind });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  marks.sort((a, b) => a.start - b.start);
  return marks;
}

function glossFor(lines) {
  const out = [];
  const seen = new Set();
  const add = (kind, plain) => { if (!seen.has(plain)) { seen.add(plain); out.push({ kind, plain }); } };
  for (const ln of lines) {
    for (const mk of ln.marks) {
      const s = ln.text.slice(mk.start, mk.end);
      if (mk.kind === 'exit-code') {
        const code = Number((s.match(/(\d{1,3})\s*$/) || [])[1]);
        add('exit-code', EXIT_CODE_PLAIN[code]
          ?? (code > 128 ? `Exit code ${code} means it was stopped by signal ${code - 128}.`
            : `Exit code ${code}: anything other than 0 means failure; the number's meaning depends on the program.`));
      } else if (mk.kind === 'file-line') {
        add('file-line', 'file:line (and sometimes :column) tells you exactly where to look. Open that file at that line.');
      } else if (mk.kind === 'error-type') {
        const hit = ERROR_TYPE_PLAIN.find(([re]) => re.test(s));
        if (hit) add('error-type', hit[1]);
      } else if (mk.kind === 'command') {
        add('command', 'A line starting with $ or + shows the command that was run.');
      } else if (mk.kind === 'message') {
        const hit = ERROR_TYPE_PLAIN.slice(0, -1).find(([re]) => re.test(s));
        if (hit) add('message', hit[1]);
        else add('message', 'Lines with "error", "failed" or "fatal" are usually the program saying in its own words what went wrong.');
      }
    }
  }
  return out;
}

/** Text of the tool_result for `toolUseId` inside one transcript line (JSON). */
export function toolResultText(lineJson, toolUseId) {
  let entry;
  try { entry = JSON.parse(lineJson); } catch { return null; }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return null;
  const item = content.find((c) => c && c.type === 'tool_result' && (!toolUseId || c.tool_use_id === toolUseId));
  if (!item) return null;
  const c = item.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
  return null;
}

/** ErrorText from raw tool_result text: clean, pick <= 12 lines / 2 000 chars, mark, gloss. */
export function buildErrorText(raw) {
  const clean = String(raw)
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')          // ANSI colours
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/\r\n?/g, '\n');
  const all = clean.split('\n');
  while (all.length && all[all.length - 1].trim() === '') all.pop();
  while (all.length && all[0].trim() === '') all.shift();
  const totalLines = all.length;
  const scored = all.map((text, i) => ({ i, text, marks: markLine(text) }));
  let chosen;
  if (scored.length <= ERR_MAX_LINES) {
    chosen = scored;
  } else {
    // First line (often "Exit code N"), lines with an error type, then the tail.
    const pick = new Set([0]);
    for (const s of scored) if (pick.size < 5 && s.marks.some((m) => m.kind === 'error-type')) pick.add(s.i);
    for (let i = scored.length - 1; i >= 0 && pick.size < ERR_MAX_LINES; i--) pick.add(i);
    chosen = [...pick].sort((a, b) => a - b).map((i) => scored[i]);
  }
  const lines = [];
  let chars = 0;
  let truncated = chosen.length < totalLines;
  for (const s of chosen) {
    let text = s.text;
    if (chars + text.length > ERR_MAX_CHARS) {
      text = text.slice(0, Math.max(0, ERR_MAX_CHARS - chars));
      truncated = true;
    }
    if (!text.length && chars >= ERR_MAX_CHARS) break;
    const marks = s.marks.filter((m) => m.end <= text.length);
    lines.push({ text, marks, n: s.i + 1 });
    chars += text.length;
    if (chars >= ERR_MAX_CHARS) break;
  }
  return { lines, gloss: glossFor(lines), truncated, totalLines };
}

// ------------------------------------------------------------------ claude CLI helpers

function findClaude(explicit) {
  if (explicit) return explicit;
  const home = process.env.HOME || '';
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  dirs.push(`${home}/.local/bin`, `${home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin');
  for (const d of dirs) {
    const p = path.join(d, 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID') delete env[k];
  }
  return env;
}

const SYSTEM_PROMPT = [
  'You are a patient teacher helping someone who is learning to read code and error messages.',
  'You will get structured facts about one event from a Claude Code session (an AI coding agent), and sometimes a few lines of the real error text.',
  'Explain in plain English, at most 250 words, with these four short parts, each starting with a bold label:',
  '**What happened**, **Why**, **How the agent recovered** (or that it did not / is still pending), **Spot it yourself next time** (one concrete tip).',
  'Quote at most one short fragment of the error text. Do not invent facts that are not given. No code blocks longer than 3 lines.',
].join(' ');

// ------------------------------------------------------------------ factory

export function createDiag({
  model, store, settings, cacheDir, cosmosRoot,
  claudeBin = null, spawnImpl = nodeSpawn, clock = () => Date.now() / 1000,
}) {
  const getSettings = typeof settings === 'function' ? settings : () => settings;
  const explainCwd = path.join(cacheDir, 'explain-cwd');
  let busy = false;
  let flagsPromise = null;

  async function getEvent(id) {
    let ev = null;
    try { ev = model?.event?.(id) ?? null; } catch { ev = null; }
    if (!ev) ev = await store.findEvent(id);
    return ev;
  }

  function sessionOf(sid) {
    let rec = null;
    try { rec = model?.get?.(sid) ?? null; } catch { rec = null; }
    return rec;
  }

  async function windowEvents(ev, before = WINDOW_BEFORE_S, after = RECOVERY_LOOK_S) {
    const out = [];
    for await (const e of store.readEvents(ev.t - before, ev.t + after)) {
      if (e.sid === ev.sid && e.type !== EV.METRICS) out.push(e);
    }
    return out;
  }

  const wire = (e) => { const { src, seq, ...rest } = e; return rest; };

  /** Find an event by id, preferring the window already loaded. */
  async function related(win, id) {
    return win.find((e) => e.id === id) ?? await getEvent(id);
  }

  // ---------------------------------------------------------------- facts + templates per type

  async function factsFor(ev, win, rec) {
    const d = ev.data || {};
    const after = win.filter((e) => e.t >= ev.t && e.id !== ev.id);
    const live = !!rec?.live;
    const now = clock();
    const f = { type: ev.type };
    let summary = '';
    let outcome = 'n/a';

    switch (ev.type) {
      case EV.ERROR: {
        Object.assign(f, {
          kind: d.kind ?? null, tool: d.tool ?? null, target: d.target ?? null,
          denialKind: d.denialKind ?? null, apiStatus: d.apiStatus ?? null,
          retryAttempt: d.retryAttempt ?? null, maxRetries: d.maxRetries ?? null,
          durationMs: null, retries: 0, inStorm: false, stormCount: null, stormPosition: null,
          recovered: d.recovered ?? null, recoveredBy: null, nextOkAfterS: null,
        });
        if (d.toolUseId && ev.sid) {
          const call = await related(win, makeEventId(EV.TOOL_CALL, ev.sid, d.toolUseId));
          if (call && Number.isFinite(call.data?.durationMs)) f.durationMs = call.data.durationMs;
        }
        // Same tool failing just before this one counts as retries.
        const before = win.filter((e) => e.t < ev.t && e.t >= ev.t - WINDOW_BEFORE_S);
        for (let i = before.length - 1; i >= 0; i--) {
          const e = before[i];
          if (e.type === EV.ERROR && e.data?.tool === f.tool) f.retries++;
          else if (e.type === EV.TOOL_CALL && e.data?.tool === f.tool && e.data?.ok === true) break;
        }
        if (f.kind === 'api' && Number.isFinite(f.retryAttempt)) f.retries = f.retryAttempt;
        // Storm membership.
        const ends = win.filter((e) => e.type === EV.STORM_END && Array.isArray(e.data?.errorIds) && e.data.errorIds.includes(ev.id));
        if (ends.length) {
          const se = ends[0];
          f.inStorm = true; f.stormCount = se.data.count ?? se.data.errorIds.length;
          f.stormPosition = se.data.errorIds.indexOf(ev.id) + 1;
        } else {
          const start = win.find((e) => e.type === EV.STORM_START && (e.data?.firstErrorId === ev.id
            || (e.t <= ev.t && !win.some((x) => x.type === EV.STORM_END && x.t >= e.t && x.t < ev.t))));
          if (start) { f.inStorm = true; f.stormCount = start.data?.count ?? null; }
        }
        // Recovery: the next call that worked (same tool first, else any tool).
        const okCalls = after.filter((e) => e.type === EV.TOOL_CALL && e.data?.ok === true);
        const ok = okCalls.find((e) => e.data?.tool === f.tool) ?? okCalls[0];
        if (ok) { f.recoveredBy = ok.id; f.nextOkAfterS = Math.round((ok.t - ev.t) * 10) / 10; f.okTool = ok.data?.tool ?? null; }
        if (f.recovered === true || (f.recovered === null && ok)) outcome = 'recovered';
        else if (f.recovered === false) outcome = 'not-recovered';
        else if (live && now - ev.t < RECOVERY_LOOK_S) outcome = 'pending';
        else outcome = 'not-recovered';

        const parts = [];
        if (f.kind === 'denial') {
          parts.push(`${what(f.tool, f.target)} was declined${f.denialKind ? ` (${f.denialKind})` : ''}. A denial is not a bug: the agent asked to do something and the answer was no, so it has to try another way.`);
        } else if (f.kind === 'api') {
          const st = f.apiStatus ? ` ${f.apiStatus}` : '';
          const word = API_STATUS_WORDS[f.apiStatus];
          parts.push(`The Claude API answered with an error${st}${word ? `: ${word}` : ''}. This is not the agent's code failing; the request to the model did not go through.`);
          if (Number.isFinite(f.retryAttempt)) parts.push(`Claude Code retried automatically (attempt ${f.retryAttempt}${Number.isFinite(f.maxRetries) ? ` of ${f.maxRetries}` : ''}).`);
        } else {
          parts.push(`${f.tool ?? 'A tool'} failed${f.target ? ` while working on ${f.target}` : ''}.`);
          if (Number.isFinite(f.durationMs)) parts.push(`It ran for ${fmtDur(f.durationMs / 1000)} before it failed.`);
          if (f.retries > 0) parts.push(`${f.tool} had already failed ${f.retries === 1 ? 'once' : `${f.retries} times`} just before this.`);
        }
        if (f.inStorm) {
          const st = getSettings()?.storm;
          parts.push(f.stormPosition
            ? `It was the ${ordinal(f.stormPosition)} of ${f.stormCount} errors in a flare storm (${st?.count ?? 3} or more errors within ${st?.windowS ?? 20} seconds).`
            : `It happened during a flare storm (${st?.count ?? 3} or more errors within ${st?.windowS ?? 20} seconds).`);
        }
        if (outcome === 'recovered') {
          parts.push(f.nextOkAfterS !== null
            ? `The agent recovered ${fmtDur(f.nextOkAfterS)} later: its next ${f.okTool === f.tool ? `${f.tool} ` : ''}call${f.okTool && f.okTool !== f.tool ? ` (${f.okTool})` : ''} worked.`
            : 'The agent recovered.');
        } else if (outcome === 'pending') {
          parts.push('It is too early to tell whether the agent recovered.');
        } else {
          parts.push(`No successful tool call followed within ${fmtDur(RECOVERY_LOOK_S)}, so it did not recover here.`);
        }
        summary = parts.join(' ');
        break;
      }

      case EV.STORM_START: {
        const end = await related(win, makeEventId(EV.STORM_END, ev.sid, ev.id.split(':').slice(2).join(':')));
        const ids = end?.data?.errorIds ?? [];
        const tools = {};
        for (const id of ids) {
          const e = await related(win, id);
          const t = e?.data?.tool ?? 'unknown tool';
          tools[t] = (tools[t] || 0) + 1;
        }
        Object.assign(f, {
          count: end?.data?.count ?? d.count ?? null, windowS: d.windowS ?? null,
          durationS: end?.data?.durationS ?? null, ended: !!end, tools,
          firstErrorId: d.firstErrorId ?? null, recoveredBy: null, nextOkAfterS: null,
        });
        const endT = end ? end.t : null;
        const ok = endT !== null ? win.find((e) => e.t >= ev.t && e.type === EV.TOOL_CALL && e.data?.ok === true && e.t >= endT - (getSettings()?.storm?.holdS ?? 10)) : null;
        if (ok) { f.recoveredBy = ok.id; f.nextOkAfterS = Math.round((ok.t - ev.t) * 10) / 10; }
        outcome = end ? (ok ? 'recovered' : (rec?.state?.mode === 'crashed' ? 'not-recovered' : 'recovered')) : (live ? 'pending' : 'not-recovered');
        const toolList = Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`).join(', ');
        const parts = [`${f.count ?? 'Several'} tool errors landed within ${f.windowS ?? 'a few'} seconds, so this became a flare storm: the agent was stuck in a run of failures.`];
        if (toolList) parts.push(`The failing calls were ${toolList}.`);
        if (f.ended && Number.isFinite(f.durationS)) parts.push(`The storm lasted ${fmtDur(f.durationS)}.`);
        if (outcome === 'recovered') parts.push(f.nextOkAfterS !== null ? `It calmed down: a call worked ${fmtDur(f.nextOkAfterS)} after the storm began.` : 'It calmed down: no new errors came in for a while.');
        else if (outcome === 'pending') parts.push('The storm is still going.');
        else parts.push('The session did not get back to working calls after it.');
        summary = parts.join(' ');
        break;
      }

      case EV.COMPACTION: {
        Object.assign(f, {
          trigger: d.trigger ?? null, preTokens: d.preTokens ?? null, postTokens: d.postTokens ?? null,
          droppedTokens: d.droppedTokens ?? (Number.isFinite(d.preTokens) && Number.isFinite(d.postTokens) ? d.preTokens - d.postTokens : null),
          durationMs: d.durationMs ?? null,
        });
        const why = f.trigger === 'manual' ? 'You ran /compact' : f.trigger === 'auto' ? 'The conversation filled up the context window' : 'The conversation was compacted';
        const parts = [`${why}, so Claude Code replaced the older part of the conversation with a summary (a black hole swallowing part of the belt).`];
        if (Number.isFinite(f.preTokens) && Number.isFinite(f.postTokens)) parts.push(`The context went from ${fmtTokens(f.preTokens)} to ${fmtTokens(f.postTokens)} tokens (${fmtTokens(f.droppedTokens)} dropped).`);
        if (Number.isFinite(f.durationMs)) parts.push(`Summarizing took ${fmtDur(f.durationMs / 1000)}.`);
        parts.push('This is normal for long sessions; details from before it may be remembered less exactly.');
        summary = parts.join(' ');
        break;
      }

      case EV.CRASHED: {
        Object.assign(f, { reason: d.reason ?? null, lastType: d.lastType ?? null });
        const revived = after.find((e) => e.t > ev.t && e.type !== EV.CRASHED && e.type !== EV.IDLE && e.type !== EV.DEAD);
        f.revivedAfterS = revived ? Math.round((revived.t - ev.t) * 10) / 10 : null;
        outcome = revived ? 'recovered' : 'not-recovered';
        const parts = [`The session ended abnormally: ${CRASH_WORDS[f.reason] ?? 'it stopped without finishing its turn'}.`];
        if (f.lastType) parts.push(`The last thing recorded was a "${f.lastType}" entry.`);
        parts.push(revived ? `It came back to life ${fmtDur(f.revivedAfterS)} later (new activity in the same session).` : 'Nothing happened in it afterwards, so it stays a remnant.');
        summary = parts.join(' ');
        break;
      }

      case EV.NEEDS_ME_START: {
        Object.assign(f, { sub: d.sub ?? null, source: d.source ?? null, tool: d.tool ?? null, waitedS: null, how: null });
        const end = await related(win, makeEventId(EV.NEEDS_ME_END, ev.sid, ev.id.split(':').slice(2).join(':')));
        if (end) { f.waitedS = end.data?.waitedS ?? Math.round(end.t - ev.t); f.how = end.data?.how ?? null; }
        else f.waitingS = Math.max(0, Math.round(now - ev.t));
        outcome = end ? 'n/a' : (live ? 'pending' : 'n/a');
        const asked = f.sub === 'approve'
          ? `Claude stopped and waited for ${SUB_WORDS.approve} ${f.tool ?? 'a tool'}.`
          : f.sub ? `Claude stopped and waited for ${SUB_WORDS[f.sub]}.` : 'Claude stopped and waited for you.';
        const parts = [asked];
        if (end) parts.push(`${HOW_END_WORDS[f.how] ?? 'It ended'} after ${fmtDur(f.waitedS)}.`);
        else if (live) parts.push(`It is still waiting (${fmtDur(f.waitingS)} so far).`);
        if (f.source === 'registry') parts.push('Cosmos saw this from Claude Code\'s live session list, the fastest signal.');
        summary = parts.join(' ');
        break;
      }

      case EV.SUBAGENT_BACK: {
        const out = await related(win, makeEventId(EV.SUBAGENT_OUT, ev.sid, d.agentId ?? ''));
        Object.assign(f, {
          agentId: d.agentId ?? null, shipType: out?.data?.type ?? null, label: out?.data?.label ?? null,
          shipModel: out?.data?.model ?? null, durationS: d.durationS ?? null, tokens: d.tokens ?? null, how: d.how ?? null,
        });
        const name = f.label && f.label !== f.shipType ? `${f.shipType ?? 'A'} subagent ("${f.label}")` : `${f.shipType ?? 'A'} subagent`;
        const parts = [`${name} came home${Number.isFinite(f.durationS) ? ` after ${fmtDur(f.durationS)}` : ''}.`];
        if (Number.isFinite(f.tokens)) parts.push(`It used ${fmtTokens(f.tokens)} tokens${f.shipModel ? ` on ${f.shipModel}` : ''}.`);
        if (SHIP_HOW_WORDS[f.how]) parts.push(SHIP_HOW_WORDS[f.how]);
        parts.push('A subagent is a helper the main session sends off with its own task and its own context, so the main conversation stays small.');
        summary = parts.join(' ');
        break;
      }

      case EV.BORN: {
        Object.assign(f, { origin: d.origin ?? null, arm: d.arm?.name ?? d.arm ?? null, worktree: d.worktree?.name ?? null, entrypoint: d.entrypoint ?? null, forkOf: d.forkOf ?? null });
        const parts = [`A new session started${f.arm ? ` in the ${f.arm} arm` : ''}${f.entrypoint ? `, from ${ENTRY_WORDS[f.entrypoint] ?? f.entrypoint}` : ''}.`];
        if (ORIGIN_WORDS[f.origin]) parts.push(`Origin: ${ORIGIN_WORDS[f.origin]}.`);
        if (f.worktree) parts.push(`It works in its own git worktree "${f.worktree}" (a separate checkout, so it cannot disturb other sessions' files).`);
        summary = parts.join(' ');
        break;
      }

      case EV.NEEDS_ME_END: {
        Object.assign(f, { sub: d.sub ?? null, waitedS: d.waitedS ?? null, how: d.how ?? null });
        summary = `${HOW_END_WORDS[f.how] ?? 'The wait ended'}${Number.isFinite(f.waitedS) ? ` after ${fmtDur(f.waitedS)}` : ''}, so Claude could carry on.`;
        break;
      }
      case EV.MY_MOVE: {
        Object.assign(f, { badges: d.badges ?? [] });
        summary = 'Claude finished its turn and is waiting for your next message. Nothing is blocked; it is simply your move.';
        if (f.badges.includes('ships-out')) summary += ' A subagent is still out working.';
        break;
      }
      case EV.WORKING: {
        Object.assign(f, { sub: d.sub ?? null, tool: d.tool ?? null });
        summary = f.tool ? `Claude started working: running ${f.tool}.` : 'Claude started working (writing its answer).';
        break;
      }
      case EV.TOOL_CALL: {
        Object.assign(f, { tool: d.tool ?? null, target: d.target ?? null, ok: d.ok ?? null, durationMs: d.durationMs ?? null });
        summary = `Claude called ${what(f.tool, f.target)}.`
          + (f.ok === true ? ` It worked${Number.isFinite(f.durationMs) ? ` in ${fmtDur(f.durationMs / 1000)}` : ''}.`
            : f.ok === false ? ' It failed.' : ' The result is not in yet.');
        outcome = f.ok === null ? 'pending' : 'n/a';
        break;
      }
      case EV.FILE_TOUCH: {
        Object.assign(f, { path: d.path ?? null, folder: d.folder ?? null, op: d.op ?? null, plan: !!d.plan });
        const verb = { edit: 'edited', write: 'wrote', read: 'read', notebook: 'edited the notebook' }[f.op] ?? 'touched';
        summary = `Claude ${verb} ${f.path ?? 'a file'}${f.plan ? ' (its plan file)' : ''}. Each edit makes that planet grow.`;
        break;
      }
      case EV.SUBAGENT_OUT: {
        Object.assign(f, { agentId: d.agentId ?? null, shipType: d.type ?? null, label: d.label ?? null, shipModel: d.model ?? null, depth: d.depth ?? null });
        summary = `Claude sent out a ${f.shipType ?? ''} subagent${f.label ? ` ("${f.label}")` : ''}${f.shipModel ? ` running on ${f.shipModel}` : ''}. It works on its own task and reports back.`.replace('a  subagent', 'a subagent');
        break;
      }
      case EV.STORM_END: {
        Object.assign(f, { count: d.count ?? null, durationS: d.durationS ?? null });
        summary = `The flare storm ended after ${fmtDur(f.durationS) ?? 'a while'}, with ${f.count ?? 'several'} errors in total. No new error arrived within the hold time.`;
        break;
      }
      case EV.IDLE: {
        Object.assign(f, { k: d.k ?? null, lastActivity: d.lastActivity ?? null });
        summary = 'The session went quiet. Over the next day its planets age (storms, then volcanoes, then cracks) until it settles as a dead world. Busy sessions age more slowly.';
        break;
      }
      case EV.DEAD: {
        Object.assign(f, { lastActivity: d.lastActivity ?? null, quietS: Number.isFinite(d.lastActivity) ? Math.round(ev.t - d.lastActivity) : null });
        summary = `The session has been quiet for ${fmtDur(f.quietS) ?? 'a full day'} and is now a dead remnant. Any new message would bring it back.`;
        break;
      }
      case EV.ARCHIVED:
      case EV.DELETED: {
        Object.assign(f, { how: d.how ?? null });
        summary = ev.type === EV.ARCHIVED ? 'The session was archived. It stays in its arm as a remnant.' : 'The session was deleted or released by the app. Cosmos keeps its summary as a husk in its arm.';
        break;
      }
      default: {
        summary = 'A recorded event in this session.';
      }
    }
    return { facts: f, summary, outcome };
  }

  async function report(id) {
    const ev = await getEvent(id);
    if (!ev) return null;
    const rec = sessionOf(ev.sid);
    const win = await windowEvents(ev);
    const { facts, summary, outcome } = await factsFor(ev, win, rec);
    const before = win.filter((e) => e.t <= ev.t && e.id !== ev.id && e.t >= ev.t - WINDOW_BEFORE_S);
    const afterEv = win.filter((e) => e.t > ev.t && e.t <= ev.t + WINDOW_AFTER_S);
    const canShowError = ev.type === EV.ERROR && (ev.data?.kind === 'tool' || ev.data?.kind === 'denial')
      && !!ev.src && !!ev.data?.toolUseId;
    const s = getSettings();
    return {
      event: wire(ev),
      session: { id: ev.sid, title: rec?.title ?? null, arm: rec?.arm ?? null, model: rec?.model ?? null },
      facts,
      summary,
      leadUp: before.slice(-MAX_TIMELINE).map(wire),
      after: afterEv.slice(0, MAX_TIMELINE).map(wire),
      outcome,
      replay: { from: ev.t - 60, to: ev.t + 60, at: ev.t - 8, sid: ev.sid },
      canShowError,
      explainEstimate: estimate(facts, canShowError, s?.explain?.model ?? 'haiku'),
    };
  }

  /** Token estimate before the click: calibrated from past runs when there are any. */
  function estimate(facts, withErrorText, modelName) {
    const factsTokens = Math.ceil((JSON.stringify(facts).length + SYSTEM_PROMPT.length + 600) / 4)
      + (withErrorText ? Math.ceil(ERR_MAX_CHARS / 4) : 0);
    const log = store.explainUsage().log.filter((e) => !modelName || String(e.model || '').includes(modelName)).slice(-10);
    if (log.length) {
      const avgIn = log.reduce((a, e) => a + (e.usage.input + e.usage.cacheRead + e.usage.cacheCreate), 0) / log.length;
      const avgOut = log.reduce((a, e) => a + e.usage.output, 0) / log.length;
      return { model: modelName, inputTokens: Math.round(avgIn), outputTokens: Math.round(avgOut), note: `estimate: average of your last ${log.length} explain${log.length > 1 ? 's' : ''}` };
    }
    // First run: our prompt plus a margin for Claude Code's own setup context.
    return { model: modelName, inputTokens: factsTokens + 300, outputTokens: EXPLAIN_OUTPUT_EST, note: 'estimate: first run, rough (the real numbers appear after the click)' };
  }

  async function errorText(id) {
    const ev = await getEvent(id);
    if (!ev || ev.type !== EV.ERROR || !(ev.data?.kind === 'tool' || ev.data?.kind === 'denial') || !ev.src || !ev.data?.toolUseId) return null;
    let line = null;
    try { line = await model.readLine(ev.src); } catch { line = null; }
    if (!line) return null;
    const raw = toolResultText(line, ev.data.toolUseId);
    line = null;
    if (raw === null) return null;
    return buildErrorText(raw);
  }

  // ---------------------------------------------------------------- explain

  function supportedFlags(bin) {
    if (!flagsPromise) {
      flagsPromise = new Promise((resolve) => {
        execFile(bin, ['--help'], { timeout: 15000, env: cleanEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          const text = String(stdout || '');
          const has = (f) => new RegExp(`(^|\\s)${f.replace(/[-]/g, '\\-')}(\\s|,|$|<|=)`, 'm').test(text);
          resolve({
            ok: !err || text.length > 0,
            print: has('--print') || has('-p'),
            model: has('--model'), outputFormat: has('--output-format'),
            noPersist: has('--no-session-persistence'), tools: has('--tools'),
            systemPrompt: has('--system-prompt'), strictMcp: has('--strict-mcp-config') && has('--mcp-config'),
            noSlash: has('--disable-slash-commands'), settingSources: has('--setting-sources'),
          });
        });
      });
    }
    return flagsPromise;
  }

  function buildPrompt(rep, errText) {
    const lean = (e) => ({ type: e.type, dt: Math.round((e.t - rep.event.t) * 10) / 10, tool: e.data?.tool ?? null, ok: e.data?.ok ?? null, kind: e.data?.kind ?? null });
    const parts = [
      `Event type: ${rep.event.type}`,
      `Cosmos summary (from structured data): ${rep.summary}`,
      `Facts: ${JSON.stringify(rep.facts)}`,
      `Outcome so far: ${rep.outcome}`,
      `Events just before (dt = seconds relative to this event): ${JSON.stringify(rep.leadUp.map(lean))}`,
      `Events just after: ${JSON.stringify(rep.after.map(lean))}`,
    ];
    if (errText && errText.lines.length) {
      parts.push(`Error text (${errText.lines.length} of ${errText.totalLines} lines):\n${errText.lines.map((l) => l.text).join('\n')}`);
    }
    parts.push('Explain this for a learner, following your instructions.');
    return parts.join('\n\n');
  }

  async function explain(id) {
    if (busy) throw httpError(409, 'busy', 'An explanation is already running. Wait for it to finish.');
    busy = true;
    try {
      const rep = await report(id);
      if (!rep) throw httpError(404, 'not-found', 'That event is not in Cosmos\'s data.');
      const bin = findClaude(claudeBin);
      if (!bin) throw httpError(503, 'claude-missing', 'The claude command was not found on this Mac, so Explain cannot run.');
      const flags = await supportedFlags(bin);
      if (!flags.print || !flags.outputFormat) {
        throw httpError(503, 'claude-flags', 'This claude CLI does not support -p with --output-format, so Explain cannot read its token usage.');
      }
      // The prompt carries tool-error text, which can be attacker-influenced: the
      // helper must run with NO tools and write no transcript, or not at all.
      if (!flags.tools || !flags.noPersist) {
        throw httpError(503, 'claude-flags', 'This claude CLI cannot run with tools switched off (--tools) and without saving a session (--no-session-persistence), so Explain will not run. Update Claude Code to use Explain.');
      }
      const s = getSettings();
      const modelName = s?.explain?.model ?? 'haiku';
      const errText = rep.canShowError ? await errorText(id) : null;
      const prompt = buildPrompt(rep, errText);

      const dropped = [];
      const args = ['-p', '--output-format', 'json'];
      if (flags.model) args.push('--model', modelName); else dropped.push('--model');
      args.push('--no-session-persistence', '--tools', '');
      if (flags.systemPrompt) args.push('--system-prompt', SYSTEM_PROMPT); else dropped.push('--system-prompt');
      if (flags.strictMcp) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
      if (flags.noSlash) args.push('--disable-slash-commands');
      if (flags.settingSources) args.push('--setting-sources', 'project');
      const userPrompt = flags.systemPrompt ? prompt : `${SYSTEM_PROMPT}\n\n${prompt}`;

      fs.mkdirSync(explainCwd, { recursive: true });
      const out = await new Promise((resolve, reject) => {
        let stdout = ''; let stderrLen = 0; let done = false;
        const child = spawnImpl(bin, args, { cwd: explainCwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
          if (done) return; done = true;
          try { child.kill('SIGTERM'); } catch { /* gone */ }
          reject(httpError(504, 'timeout', 'Claude took longer than 60 seconds, so Cosmos stopped waiting. No answer was saved.'));
        }, EXPLAIN_TIMEOUT_MS);
        child.stdout.on('data', (b) => { stdout += b; if (stdout.length > 2_000_000) child.kill('SIGTERM'); });
        child.stderr.on('data', (b) => { stderrLen += b.length; });   // never kept or logged
        child.on('error', (err) => { if (done) return; done = true; clearTimeout(timer); reject(httpError(503, 'spawn-failed', `Could not start claude: ${err.code || err.message}.`)); });
        child.on('close', (code) => {
          if (done) return; done = true; clearTimeout(timer);
          resolve({ code, stdout, stderrLen });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(userPrompt);
      });

      let j = null;
      try { j = JSON.parse(out.stdout.trim()); } catch {
        const lastLine = out.stdout.trim().split('\n').pop();
        try { j = JSON.parse(lastLine); } catch { j = null; }
      }
      if (!j || typeof j !== 'object') {
        throw httpError(502, 'bad-output', `claude exited with code ${out.code} and no readable JSON, so there is no answer or usage to show.`);
      }
      const u = j.usage || {};
      const usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
      };
      usage.total = usage.input + usage.output + usage.cacheCreate;   // cacheRead is not spend (§2.1)
      const usedModel = Object.keys(j.modelUsage || {})[0] ?? modelName;
      const hadUsage = (usage.input + usage.output + usage.cacheRead + usage.cacheCreate) > 0;
      const runningTotal = hadUsage
        ? store.addExplainUsage({ t: clock(), eventId: id, model: usedModel, usage })
        : store.explainUsage();
      if (j.is_error || (j.subtype && j.subtype !== 'success')) {
        const e = httpError(502, 'claude-error', `Claude did not finish (${j.subtype || 'error'}).${hadUsage ? ' The tokens it used are still counted.' : ''}`);
        e.extra = { usage, runningTotal };
        throw e;
      }
      const disclosure = 'This sent the facts above'
        + (errText ? ' and the error text' : '')
        + ' to Claude. It ran as a helper session with persistence off; if one is ever written, Cosmos hides it (it lives under cosmos/cache/explain-cwd).'
        + (dropped.length ? ` This claude CLI lacks ${dropped.join(', ')}, so ${dropped.includes('--no-session-persistence') ? 'a helper transcript may be written (hidden by Cosmos)' : 'the run used the defaults for those'}.` : '');
      return {
        text: typeof j.result === 'string' ? j.result : '',
        usage,
        costUsd: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null,
        model: usedModel,
        estimate: { inputTokens: rep.explainEstimate.inputTokens, outputTokens: rep.explainEstimate.outputTokens },
        runningTotal,
        disclosure,
      };
    } finally {
      busy = false;
    }
  }

  return { report, errorText, explain };
}
