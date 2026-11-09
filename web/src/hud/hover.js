// Cosmos LENS: hover popups + the plain-English glossary they share with
// diagnostics (and the HUD legend, if it wants it).
//
// GALAXY_CONTRACT §7 names this module `popups.js` and the glossary
// `glossary.js`; the LENS assignment puts both here (`hover.js`). Exports:
//   GLOSSARY                 plain-English strings (objects, modes, subs, badges,
//                            remnants, errorKinds, marks, events, crashReasons)
//   fmt                      shared number / time formatters (pure)
//   describe(sel, store)     -> { kind, title, glyph, what, means, rows, spot, state, more } | null
//   createPopups(rootEl, { galaxy, store }) -> { dispose(), refresh(), get visible }
//   createHover              alias of createPopups
//
// Every number shown comes straight from a record / event / totals field and
// is named after it. Nothing here reads transcript text. No three import.

import { MODE } from '../shared/schema.mjs';

// ---------------------------------------------------------------------------
// Glossary. Written for someone learning to read code and errors: what it is,
// what it means, and how to spot the same thing yourself in Claude Code.

export const GLOSSARY = Object.freeze({
  objects: Object.freeze({
    galaxy: {
      name: 'The galaxy',
      what: 'Every Claude Code session on this Mac, in one place.',
      means: 'Each star system is one session. Each spiral arm is one project folder. Indigo hourglasses need you; flashing orange bursts are fresh crashes.',
      spot: 'Press N to jump to the next session that is waiting on you.',
    },
    core: {
      name: 'Galactic core',
      what: 'A fixed landmark at the center.',
      means: 'It is not a session. It is there so you always know where the middle is.',
      spot: 'Press R to fly back to the whole-galaxy view.',
    },
    codex: {
      name: 'The Tree of Knowledge',
      what: 'The tree at the center of the galaxy. As above, so below.',
      means: 'Its branches above are your living sessions; its roots below are the dormant and finished ones. Its glimmering leaves are everything your sessions have learned and saved: memories, skills, project rules, decision logs and your kit.',
      spot: 'When a session saves something new, a gold beam flies from it into the canopy and a new leaf grows where it lands. Light rises through the bark toward the living branches.',
    },
    me: {
      name: 'You',
      what: 'The pearl star orbiting the Codex: you, the owner of this galaxy.',
      means: 'A thread of light runs from you to every session that needs you right now. You shine brighter the more sessions are waiting.',
      spot: 'Click to see who is waiting and jump to them.',
    },
    arm: {
      name: 'Spiral arm',
      what: 'One project: all sessions started inside the same project folder.',
      means: 'Sessions are born in their project\'s arm and stay there, so a place in the galaxy always means the same project.',
      spot: 'The arm name is the project folder you ran `claude` in (the first working directory of the session).',
    },
    cluster: {
      name: 'Worktree cluster',
      what: 'Sessions running in a git worktree of this project.',
      means: 'A worktree is a second checkout of the same repository on a different branch, so two sessions can edit without colliding.',
      spot: 'In a terminal, `git worktree list` shows every worktree of a repository.',
    },
    session: {
      name: 'Star system',
      what: 'One Claude Code session (one conversation).',
      means: 'The star\'s state shows what the session is doing; its color shows how full its memory (context window) is; the belt shows how many tokens it has used.',
      spot: 'Each session is one .jsonl file under ~/.claude/projects/. `claude --resume` lists them.',
    },
    file: {
      name: 'Planet (file)',
      what: 'A file this session read or changed.',
      means: 'The planet grows each time the file is edited. Files that were only read stay small.',
      spot: 'In Claude Code, look for Edit / Write / Read lines with a file path under them: each one touches a planet.',
    },
    folder: {
      name: 'Planet (folder)',
      what: 'A folder whose files this session touched, shown as one planet when you are zoomed out.',
      means: 'Zoom in to split it into one planet per file.',
      spot: 'Paths in tool calls tell you the folder: everything before the last slash.',
    },
    ship: {
      name: 'Subagent ship',
      what: 'A helper agent this session sent out to do part of the job.',
      means: 'It leaves the star, works in its own orbit while active, and flies home when it reports back. Its tokens count toward this session.',
      spot: 'In Claude Code a subagent shows as a Task / Agent tool call with its own nested progress.',
    },
    compaction: {
      name: 'Black hole (compaction)',
      what: 'The moment this session\'s memory was compacted.',
      means: 'When the context window gets full, Claude Code summarizes the conversation so far and starts again from the summary. The black hole swallows that part of the belt.',
      spot: 'The terminal prints a "compacting conversation" message, and /compact does it by hand.',
    },
    event: {
      name: 'Event',
      what: 'Something that happened in a session, with a timestamp.',
      means: 'Click it for the Analysis & Diagnostic panel: what happened, what led to it, and whether it recovered.',
      spot: 'Every event comes from a line in the session\'s transcript file or from Claude Code\'s live session registry.',
    },
    link: {
      name: 'Link',
      what: 'A line between two related things (subagent to its session, fork to its parent).',
      means: 'Shown in Map mode (M) so you can see who started what.',
      spot: 'A fork is a session started from another one with `claude --resume … --fork-session`.',
    },
  }),

  modes: Object.freeze({
    'needs-me': {
      word: 'NEEDS ME', glyph: '\u29D7',
      means: 'The session has stopped and cannot go on until you answer: approve a tool, answer a question, or approve a plan.',
      spot: 'In the terminal it is the box asking "Do you want to …?" or a question with numbered options.',
    },
    'my-move': {
      word: 'MY MOVE', glyph: '\u25CE',
      means: 'It finished its turn. Nothing is broken; it is waiting for your next message.',
      spot: 'The prompt box is empty and the spinner has stopped.',
    },
    working: {
      word: 'WORKING', glyph: '\u2726',
      means: 'It is busy: writing an answer or running a tool.',
      spot: 'The terminal shows a spinner with a verb and a running timer, and "esc to interrupt".',
    },
    idle: {
      word: 'IDLE', glyph: '\u25CC',
      means: 'Nothing has happened for a while. The star cools over one day; sessions that were busy fade more slowly.',
      spot: 'The last message time in `claude --resume` tells you how long a session has been quiet.',
    },
    dead: {
      word: 'DEAD', glyph: '\u00B7',
      means: 'Quiet for a full day or more. It is history now, but you can still resume it.',
      spot: '`claude --resume` still lists it; resuming brings the star back to life.',
    },
    crashed: {
      word: 'CRASHED', glyph: '\u2715',
      means: 'It ended in the middle of something (a request or a tool that never answered) instead of finishing cleanly.',
      spot: 'A crashed session\'s last transcript line is a request or tool call with no reply after it.',
    },
  }),

  subs: Object.freeze({
    approve: { word: 'APPROVE', means: 'A tool needs your permission before it runs.', spot: 'Look for "Do you want to proceed?" with Yes / No options.' },
    question: { word: 'QUESTION', means: 'Claude asked you a question and is waiting for the answer.', spot: 'The terminal shows the question with numbered choices.' },
    plan: { word: 'PLAN', means: 'Claude wrote a plan and is waiting for you to approve it before changing anything.', spot: 'Plan mode ends with "Would you like to proceed?" under the plan.' },
    generating: { word: 'writing', means: 'Claude is writing its answer.', spot: 'The spinner is running and no tool line is open.' },
    tool: { word: 'tool', means: 'A tool is running (a command, a file edit, a search).', spot: 'The open tool line (for example Bash(…)) has no result under it yet.' },
    retrying: { word: 'retrying', means: 'The request to Claude failed and Claude Code is trying again on its own.', spot: 'The terminal shows "Retrying in …s" with an attempt number.' },
  }),

  badges: Object.freeze({
    stalled: { word: 'stalled', means: 'Busy, but nothing new has arrived for a long time. It may be stuck on a slow command.' },
    ambiguous: { word: 'unsure', means: 'A tool started a while ago with no result, and Claude Code\'s live status is not available to confirm what it is doing.' },
    unverified: { word: 'unverified', means: 'Detected from Claude Code\'s live status in a way not yet confirmed on this Mac.' },
    dialog: { word: 'dialog', means: 'A dialog is open in the app; shown as your move.' },
    'asked-in-text': { word: 'asked you', means: 'The turn ended with a question to you written in the answer text.' },
    'ships-out': { word: 'ships out', means: 'Your move, but a subagent is still working in the background.' },
    'no-registry': { word: 'inferred', means: 'Live status worked out from the transcript only.' },
  }),

  remnants: Object.freeze({
    ended: { word: 'ENDED', means: 'It exited cleanly and fades like any idle session.' },
    archived: { word: 'ARCHIVED', means: 'You archived it.' },
    crashed: { word: 'CRASHED', means: 'It stopped in the middle of something.' },
    'crashed-api': { word: 'CRASHED (API)', means: 'It stopped after an error from the Claude API.' },
    deleted: { word: 'DELETED', means: 'The session was deleted or released; only a husk remains.' },
    'aged-out': { word: 'AGED OUT', means: 'Its transcript file is gone; Cosmos remembers it from its own cache.' },
  }),

  errorKinds: Object.freeze({
    tool: {
      name: 'Tool error',
      means: 'A tool ran and reported failure: a command exited with an error, a file was not found, an edit did not match.',
      spot: 'Under the tool line the result starts with "Error" or shows an exit code. Read the LAST lines first: that is where the cause usually is.',
    },
    denial: {
      name: 'Denied',
      means: 'A tool was blocked: you said no, or a permission rule stopped it. Nothing ran.',
      spot: 'The tool line shows that the user rejected it, or a permission rule message.',
    },
    api: {
      name: 'API error',
      means: 'The request to Claude itself failed (overloaded, rate limited, network). Your code is not the problem.',
      spot: 'Look for "API Error" with a status code: 429 means rate limited, 529 overloaded, 5xx a server problem.',
    },
  }),

  // Highlight kinds in "Show the error" (diag ErrorText marks).
  marks: Object.freeze({
    'exit-code': { name: 'Exit code', how: 'A number a command returns when it ends. 0 means success; anything else means it failed. The number hints at why (1 = general failure, 2 = misuse, 127 = command not found).' },
    'file-line': { name: 'File and line', how: 'Where the problem is: path:line(:column). Open that file at that line first.' },
    'error-type': { name: 'Error type', how: 'The kind of error, such as TypeError or ENOENT. Search for this exact word to learn what it means.' },
    command: { name: 'Command', how: 'The command that ran. Running it yourself in a terminal shows the same error.' },
    message: { name: 'Message', how: 'The human-readable reason. Usually the most useful line.' },
  }),

  events: Object.freeze({
    born: { title: 'Session started', glyph: '\u2727', means: 'A new session was created.', spot: 'Starting `claude` in a folder creates one.' },
    'needs-me-start': { title: 'Waiting on you', glyph: '\u29D7', means: 'The session stopped to ask you something.', spot: 'The terminal is showing a question or a permission box.' },
    'needs-me-end': { title: 'You answered', glyph: '\u2713', means: 'The wait ended: you answered, denied, or interrupted.', spot: 'The box closed and the spinner started again.' },
    'my-move': { title: 'Turn finished', glyph: '\u25CE', means: 'Claude finished and handed the turn back to you.', spot: 'The spinner stopped and the prompt is empty.' },
    working: { title: 'Working', glyph: '\u2726', means: 'The session started working.', spot: 'The spinner is running.' },
    'tool-call': { title: 'Tool call', glyph: '\u2192', means: 'Claude used a tool: ran a command, read or edited a file, searched.', spot: 'Each tool call is a line like Bash(…) or Edit(path).' },
    'file-touch': { title: 'File touched', glyph: '\u25CF', means: 'A file was read or changed.', spot: 'Read / Edit / Write lines name the file.' },
    'subagent-out': { title: 'Subagent sent out', glyph: '\u2197', means: 'A helper agent was started to work on part of the task.', spot: 'A Task / Agent tool call starts it.' },
    'subagent-back': { title: 'Subagent returned', glyph: '\u2199', means: 'The helper agent finished and reported back.', spot: 'The Task / Agent line shows its result.' },
    error: { title: 'Error', glyph: '\u2738', means: 'Something failed. See the kind below.', spot: 'Look for the word Error under a tool line.' },
    'storm-start': { title: 'Flare storm', glyph: '\u2739', means: 'Several errors happened close together. One error is normal; a burst usually means the agent is stuck trying the same thing.', spot: 'Several red error results in a row, often for the same command or file.' },
    'storm-end': { title: 'Storm over', glyph: '\u2739', means: 'The burst of errors stopped.', spot: 'A tool call finally succeeded.' },
    compaction: { title: 'Compaction', glyph: '\u25C9', means: 'The conversation got too long for Claude\'s memory, so it was summarized and restarted from the summary.', spot: 'Claude Code prints that it is compacting the conversation; /compact does it on demand.' },
    crashed: { title: 'Crashed', glyph: '\u2715', means: 'The session ended in the middle of something.', spot: 'The transcript ends with a request or tool call that never got an answer.' },
    idle: { title: 'Went idle', glyph: '\u25CC', means: 'Nothing has happened for a while.', spot: 'No new lines in the transcript.' },
    dead: { title: 'Went dead', glyph: '\u00B7', means: 'Quiet for a full day.', spot: 'Last activity is more than a day old.' },
    archived: { title: 'Archived', glyph: '\u25A1', means: 'The session was archived.', spot: '' },
    deleted: { title: 'Deleted', glyph: '\u25A1', means: 'The session was deleted or released.', spot: '' },
  }),

  crashReasons: Object.freeze({
    'unanswered-api-request': 'A request to Claude was sent and never answered.',
    'no-reply': 'Your message never got a reply.',
    'pending-tool': 'A tool started and never finished.',
    shutdown: 'Claude Code was shut down mid-turn.',
    'api-error': 'An API error ended the session.',
    'dead-pid': 'The Claude Code process disappeared while it was busy.',
  }),
});

// ---------------------------------------------------------------------------
// Formatters (pure, shared with labels and diagnostics).

const NF = new Intl.NumberFormat('en-US');
const TF = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const DF = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Plain name for a tool id: 'mcp__Claude_Browser__tabs_create' -> 'Browser › tabs create'. */
export function humanTool(t) {
  if (!t) return '';
  const m = /^mcp__(.+?)__(.+)$/.exec(String(t));
  if (!m) return String(t);
  let server = m[1];
  if (/^[0-9a-f-]{20,}$/i.test(server)) server = 'MCP';
  server = server.replace(/^(claude[_-]in[_-]|claude[_-]|plugin[_-][^_]+[_-])/i, '').replace(/[_-]+/g, ' ').trim() || 'MCP';
  const tool = m[2].replace(/[_-]+/g, ' ').trim();
  return server + ' \u203A ' + tool;
}

export const fmt = Object.freeze({
  tool: humanTool,
  /** Exact integer with grouping, or an em dash for null. */
  int(n) { return n == null || !Number.isFinite(n) ? '\u2014' : NF.format(Math.round(n)); },
  /** Compact token count for labels: 950, 12.4k, 1.2M. */
  compact(n) {
    if (n == null || !Number.isFinite(n)) return '\u2014';
    const a = Math.abs(n);
    if (a < 1000) return String(Math.round(n));
    if (a < 1e6) return (n / 1e3).toFixed(a < 1e4 ? 1 : 0) + 'k';
    if (a < 1e9) return (n / 1e6).toFixed(a < 1e7 ? 2 : 1) + 'M';
    return (n / 1e9).toFixed(2) + 'B';
  },
  pct(f) { return f == null || !Number.isFinite(f) ? '\u2014' : Math.round(f * 100) + '%'; },
  /** Duration from seconds: 42s, 3m 12s, 5h 04m, 2d 3h. */
  dur(s) {
    if (s == null || !Number.isFinite(s)) return '\u2014';
    s = Math.max(0, s);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + String(Math.floor(s % 60)).padStart(2, '0') + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  },
  /** Short duration for labels: 42s, 3m, 5h, 2d. */
  short(s) {
    if (s == null || !Number.isFinite(s)) return '';
    s = Math.max(0, s);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  },
  ms(ms) { return ms == null || !Number.isFinite(ms) ? '\u2014' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'; },
  time(t) { return t == null || !Number.isFinite(t) ? '\u2014' : TF.format(new Date(t * 1000)); },
  date(t) { return t == null || !Number.isFinite(t) ? '\u2014' : DF.format(new Date(t * 1000)); },
  ago(t, now) { return t == null || !Number.isFinite(t) ? '\u2014' : fmtAgo(now - t); },
  base(p) { if (!p) return ''; const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); },
  model(m) {
    if (!m) return '\u2014';
    const s = String(m).replace(/^claude-/, '');
    const hit = /^(opus|sonnet|haiku|fable)[-_]?(\d+)?[-_.]?(\d+)?/i.exec(s);
    if (!hit) return s.slice(0, 18);
    return hit[1].toLowerCase() + (hit[2] ? ' ' + hit[2] + (hit[3] && hit[3].length <= 2 ? '.' + hit[3] : '') : '');
  },
  usd(x) { return x == null || !Number.isFinite(x) ? '\u2014' : '$' + (x < 0.01 ? x.toFixed(4) : x.toFixed(2)); },
});
function fmtAgo(s) { return s < 5 ? 'just now' : fmt.dur(s) + ' ago'; }

// ---------------------------------------------------------------------------
// describe(sel): the content model for a popup (and the diag header).

function nowOf(store) { return typeof store.now === 'function' ? store.now() : Date.now() / 1000; }

function modeWord(rec) {
  const st = rec.state || {};
  if (st.remnant && st.mode !== MODE.NEEDS_ME && st.mode !== MODE.WORKING && GLOSSARY.remnants[st.remnant]) {
    if (st.mode === MODE.DEAD || st.mode === MODE.CRASHED) return GLOSSARY.remnants[st.remnant].word;
  }
  return (GLOSSARY.modes[st.mode] || { word: String(st.mode || '').toUpperCase() }).word;
}

function sessionRows(rec, store, now) {
  const st = rec.state || {};
  const tk = rec.tokens || {};
  const cx = rec.context || {};
  const ct = rec.counts || {};
  const rows = [];
  let stateText = modeWord(rec);
  if (st.sub && GLOSSARY.subs[st.sub]) stateText += ' \u00B7 ' + GLOSSARY.subs[st.sub].word;
  rows.push(['State', stateText, st.mode === MODE.NEEDS_ME ? 'needs' : '']);
  if (st.mode === MODE.NEEDS_ME) rows.push(['Waiting', fmt.dur(now - st.since), 'needs']);
  if (st.mode === MODE.WORKING && st.tool) rows.push(['Running', humanTool(st.tool) + (st.target ? ' \u2192 ' + st.target : ''), '']);
  if (st.mode === MODE.MY_MOVE || st.mode === MODE.IDLE || st.mode === MODE.DEAD || st.mode === MODE.CRASHED) {
    rows.push(['Quiet for', fmt.dur(now - (rec.times && rec.times.lastActivity)), '']);
  }
  rows.push(['Project', rec.arm ? rec.arm.name : '\u2014', '']);
  if (rec.worktree) rows.push(['Worktree', rec.worktree.name + (rec.worktree.branch && rec.worktree.branch !== rec.worktree.name ? ' (' + rec.worktree.branch + ')' : ''), '']);
  rows.push(['Model', rec.model || '\u2014', 'mono']);
  rows.push(['Context', fmt.int(cx.used) + ' / ' + fmt.int(cx.limit) + '  (' + fmt.pct(cx.fill) + ')', 'num']);
  rows.push(['Tokens total', fmt.int(tk.total), 'num']);
  rows.push(['  input / output', fmt.int(tk.input) + ' / ' + fmt.int(tk.output), 'num sub']);
  rows.push(['  cache write', fmt.int(tk.cacheCreate), 'num sub']);
  rows.push(['  cache read (not spend)', fmt.int(tk.cacheRead), 'num sub']);
  rows.push(['Tokens today', fmt.int(tk.today), 'num']);
  rows.push(['Tool calls', fmt.int(ct.toolCalls) + (ct.errors ? '  \u00B7  ' + fmt.int(ct.errors) + ' errors' : ''), 'num']);
  if (ct.compactions) rows.push(['Compactions', fmt.int(ct.compactions), 'num']);
  if (ct.ships) rows.push(['Subagents', fmt.int(ct.ships), 'num']);
  const nFiles = rec.filesTotal != null ? rec.filesTotal : (rec.files ? rec.files.length : null);
  if (nFiles != null) rows.push(['Files touched', fmt.int(nFiles), 'num']);
  rows.push(['Started', fmt.date(rec.times && rec.times.bornAt), '']);
  return rows;
}

function sessionMeans(rec) {
  const st = rec.state || {};
  const parts = [];
  const m = GLOSSARY.modes[st.mode];
  if (m) parts.push(m.means);
  if (st.sub && GLOSSARY.subs[st.sub]) parts.push(GLOSSARY.subs[st.sub].means);
  if (st.badges) for (const b of st.badges) if (GLOSSARY.badges[b]) parts.push(GLOSSARY.badges[b].means);
  if (st.remnant && GLOSSARY.remnants[st.remnant] && st.mode !== MODE.NEEDS_ME && st.mode !== MODE.WORKING) parts.push(GLOSSARY.remnants[st.remnant].means);
  if (rec.context && rec.context.fill >= 0.8) parts.push('Its memory is ' + fmt.pct(rec.context.fill) + ' full, so a compaction (black hole) may come soon.');
  return parts.join(' ');
}

function findById(arr, id) {
  if (!arr) return null;
  for (let i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
  return null;
}

export function findEvent(store, id) {
  const evs = store.events;
  if (!evs || !id) return null;
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].id === id) return evs[i];
  return null;
}

/** One-line plain description of an event's data (structured fields only). */
export function eventLine(ev) {
  const d = ev.data || {};
  const g = GLOSSARY.events[ev.type];
  const title = g ? g.title : ev.type;
  switch (ev.type) {
    case 'tool-call': return (humanTool(d.tool) || 'Tool') + (d.target ? ' \u2192 ' + fmt.base(String(d.target).replace(/^f:/, '')) : '') + (d.ok === false ? '  failed' : d.ok ? '  ok' : '') + (d.durationMs != null ? '  ' + fmt.ms(d.durationMs) : '');
    case 'file-touch': return (d.op || 'touch') + ' ' + (d.path || '');
    case 'error': return ((GLOSSARY.errorKinds[d.kind] || {}).name || 'Error') + (d.tool ? ': ' + humanTool(d.tool) : '') + (d.target ? ' \u2192 ' + fmt.base(String(d.target).replace(/^f:/, '')) : '') + (d.apiStatus ? '  (status ' + d.apiStatus + ')' : '') + (d.recovered === true ? '  recovered' : d.recovered === false ? '  not recovered' : '');
    case 'storm-start': return 'Flare storm: ' + fmt.int(d.count) + ' errors in ' + fmt.int(d.windowS) + 's';
    case 'storm-end': return 'Storm over: ' + fmt.int(d.count) + ' errors over ' + fmt.dur(d.durationS);
    case 'compaction': return 'Compaction: ' + fmt.compact(d.preTokens) + ' \u2192 ' + fmt.compact(d.postTokens) + ' tokens';
    case 'subagent-out': return 'Subagent out: ' + (d.label || d.type || '') + (d.model ? ' (' + fmt.model(d.model) + ')' : '');
    case 'subagent-back': return 'Subagent back after ' + fmt.dur(d.durationS) + (d.tokens != null ? ', ' + fmt.compact(d.tokens) + ' tokens' : '');
    case 'needs-me-start': return 'Waiting on you: ' + ((GLOSSARY.subs[d.sub] || {}).word || d.sub || '') + (d.tool ? ' (' + humanTool(d.tool) + ')' : '');
    case 'needs-me-end': return 'Answered after ' + fmt.dur(d.waitedS) + (d.how ? ' (' + d.how + ')' : '');
    case 'crashed': return 'Crashed: ' + (GLOSSARY.crashReasons[d.reason] || d.reason || '');
    default: return title;
  }
}

/**
 * Content for a hover popup. Returns null when the thing is unknown
 * (never invents numbers). `rows` are [label, value, cls].
 */
export function describe(sel, store, extra) {
  if (!sel) return null;
  const now = nowOf(store);
  const O = GLOSSARY.objects;
  const rec = sel.sid ? (store.get ? store.get(sel.sid) : store.sessions && store.sessions.get(sel.sid)) : null;
  const full = extra && extra.full && extra.full.id === sel.sid ? extra.full : null;
  switch (sel.kind) {
    case 'galaxy': {
      const T = store.totals || {};
      const bm = T.byMode || {};
      const tt = T.tokensToday || {};
      return {
        kind: 'galaxy', title: O.galaxy.name, glyph: '\u2735', what: O.galaxy.what, means: O.galaxy.means, spot: O.galaxy.spot,
        rows: [
          ['Sessions', fmt.int(T.sessions) + '  (' + fmt.int(T.live) + ' live)', 'num'],
          ['Needs me', fmt.int(bm['needs-me']), bm['needs-me'] ? 'needs num' : 'num'],
          ['My move', fmt.int(bm['my-move']), 'num'],
          ['Working', fmt.int(bm.working), 'num'],
          ['Idle / dead', fmt.int(bm.idle) + ' / ' + fmt.int(bm.dead), 'num'],
          ['Tokens today', fmt.int(tt.total), 'num'],
          ['Errors today', fmt.int(T.errorsToday), 'num'],
        ],
      };
    }
    case 'core': return { kind: 'core', title: O.core.name, glyph: '\u2735', what: O.core.what, means: O.core.means, spot: O.core.spot, rows: [] };
    case 'codex': {
      const K = store.knowledge?.data;
      const c = K?.counts || {};
      return { kind: 'codex', title: O.codex.name, glyph: '\u2698', what: O.codex.what, means: O.codex.means, spot: O.codex.spot,
        rows: [['Leaves', fmt.int(K?.items?.length)], ['Memories', fmt.int(c.memory)], ['Skills', fmt.int(c.skill)], ['Rules · decisions', fmt.int(c.rules) + ' · ' + fmt.int(c.decisions)]] };
    }
    case 'me': {
      const bm = (store.totals || {}).byMode || {};
      return { kind: 'me', title: O.me.name, glyph: '\u2726', what: O.me.what, means: O.me.means, spot: O.me.spot,
        rows: [['Need you now', fmt.int(bm['needs-me']), bm['needs-me'] ? 'needs num' : 'num'], ['Your move', fmt.int(bm['my-move']), 'num']] };
    }
    case 'arm': {
      const arm = store.arms && store.arms.get(sel.armKey);
      if (!arm) return null;
      let live = 0, needs = 0, mine = 0, work = 0, tok = 0, n = 0;
      for (const sid of arm.sessionIds || []) {
        const r = store.get(sid); if (!r) continue;
        n++; if (r.live) live++;
        const m = r.state && r.state.mode;
        if (m === MODE.NEEDS_ME) needs++; else if (m === MODE.MY_MOVE) mine++; else if (m === MODE.WORKING) work++;
        tok += (r.tokens && r.tokens.total) || 0;
      }
      return {
        kind: 'arm', title: arm.name, glyph: '\u224B', what: O.arm.what, means: O.arm.means, spot: O.arm.spot,
        rows: [
          ['Folder', arm.key, 'mono'],
          ['Sessions', fmt.int(n) + '  (' + fmt.int(live) + ' live)', 'num'],
          ['Needs me', fmt.int(needs), needs ? 'needs num' : 'num'],
          ['My move / working', fmt.int(mine) + ' / ' + fmt.int(work), 'num'],
          ['Tokens (all sessions)', fmt.int(tok), 'num'],
        ],
      };
    }
    case 'session': {
      if (!rec) return null;
      const st = rec.state || {};
      const m = GLOSSARY.modes[st.mode] || {};
      return {
        kind: 'session', title: rec.title || rec.id.slice(0, 8), glyph: m.glyph || '\u2726', state: st.mode,
        what: O.session.what + (rec.origin && rec.origin !== 'owner' ? ' Started by: ' + rec.origin + '.' : ''),
        means: sessionMeans(rec), spot: m.spot || O.session.spot,
        rows: sessionRows(rec, store, now),
      };
    }
    case 'file': case 'folder': {
      if (!rec) return null;
      const isFile = sel.kind === 'file';
      const src = full || rec;
      const it = findById(isFile ? src.files : src.folders, sel.id);
      const o = isFile ? O.file : O.folder;
      if (!it) return { kind: sel.kind, title: String(sel.id || '').replace(/^[fd]:/, ''), glyph: '\u25CF', what: o.what, means: o.means, spot: o.spot, rows: [['Session', rec.title || rec.id.slice(0, 8), '']], more: !full };
      const rows = [
        ['Path', it.path, 'mono'],
        ['Edits', fmt.int(it.edits), 'num'],
        ['Reads', fmt.int(it.reads), 'num'],
      ];
      if (!isFile && it.files != null) rows.push(['Files', fmt.int(it.files), 'num']);
      rows.push(['Last touched', fmt.ago(it.lastT, now), '']);
      if (it.plan) rows.push(['Plan file', 'yes', '']);
      rows.push(['Session', rec.title || rec.id.slice(0, 8), '']);
      return { kind: sel.kind, title: isFile ? fmt.base(it.path) : (it.path || '') + '/', glyph: '\u25CF', what: o.what, means: o.means + (it.edits === 0 ? ' This one was only read.' : ''), spot: o.spot, rows };
    }
    case 'ship': {
      if (!rec) return null;
      const s = findById((full || rec).ships, sel.id);
      if (!s) return { kind: 'ship', title: 'Subagent', glyph: '\u2197', what: O.ship.what, means: O.ship.means, spot: O.ship.spot, rows: [], more: !full };
      const rows = [
        ['Type', s.type || '\u2014', ''],
        ['Model', s.model || '\u2014', 'mono'],
        ['Tokens', fmt.int(s.tokens), 'num'],
        ['Status', s.active ? 'working (out ' + fmt.dur(now - s.t) + ')' : 'back' + (s.endT ? ' after ' + fmt.dur(s.endT - s.t) : ''), ''],
        ['Sent out', fmt.time(s.t), ''],
      ];
      if (s.depth > 1) rows.push(['Depth', fmt.int(s.depth) + ' (sent by another subagent)', '']);
      if (s.workflowPhase) rows.push(['Workflow phase', String(s.workflowPhase), '']);
      rows.push(['Session', rec.title || rec.id.slice(0, 8), '']);
      return { kind: 'ship', title: s.label || s.type || 'Subagent', glyph: '\u2197', what: O.ship.what, means: O.ship.means, spot: O.ship.spot, rows };
    }
    case 'compaction': {
      if (!rec) return null;
      const c = findById((full || rec).compactions, sel.id);
      if (!c) return null;
      const dropped = c.preTokens != null && c.postTokens != null ? c.preTokens - c.postTokens : null;
      return {
        kind: 'compaction', title: 'Compaction', glyph: '\u25C9', what: O.compaction.what, means: O.compaction.means, spot: O.compaction.spot,
        rows: [
          ['Before', fmt.int(c.preTokens) + ' tokens', 'num'],
          ['After', fmt.int(c.postTokens) + ' tokens', 'num'],
          ['Swallowed', fmt.int(dropped) + ' tokens', 'num'],
          ['Trigger', c.trigger === 'auto' ? 'automatic (memory was full)' : c.trigger === 'manual' ? 'manual (/compact)' : (c.trigger || '\u2014'), ''],
          ['Took', fmt.ms(c.durationMs), 'num'],
          ['When', fmt.time(c.t) + '  (' + fmt.ago(c.t, now) + ')', ''],
        ],
        clickHint: 'Click for Analysis & Diagnostic.',
      };
    }
    case 'event': {
      const ev = findEvent(store, sel.id);
      if (!ev) return null;
      const g = GLOSSARY.events[ev.type] || { title: ev.type, means: '', spot: '' };
      const r2 = store.get(ev.sid);
      let means = g.means, spot = g.spot;
      if (ev.type === 'error' && ev.data && GLOSSARY.errorKinds[ev.data.kind]) { means = GLOSSARY.errorKinds[ev.data.kind].means; spot = GLOSSARY.errorKinds[ev.data.kind].spot; }
      return {
        kind: 'event', title: g.title, glyph: g.glyph || '\u2022', what: eventLine(ev), means, spot,
        rows: [['When', fmt.time(ev.t) + '  (' + fmt.ago(ev.t, now) + ')', ''], ['Session', r2 ? (r2.title || r2.id.slice(0, 8)) : String(ev.sid).slice(0, 8), '']],
        clickHint: 'Click for Analysis & Diagnostic.',
      };
    }
    default: return null;
  }
}

/** Anchor key for a selection (matches GALAXY LabelAnchor.key). */
export function anchorKeyOf(sel) {
  if (!sel) return '';
  switch (sel.kind) {
    case 'session': return 'sys:' + sel.sid;
    case 'arm': return 'arm:' + sel.armKey;
    case 'file': return 'file:' + sel.sid + ':' + sel.id;
    case 'folder': return 'folder:' + sel.sid + ':' + sel.id;
    case 'ship': return 'ship:' + sel.sid + ':' + sel.id;
    case 'compaction': return 'bh:' + sel.sid + ':' + sel.id;
    case 'core': return 'core';
    case 'codex': return 'codex';
    case 'me': return 'me';
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// DOM helper (textContent only; never innerHTML with data).

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function sameSel(a, b) {
  return !!a && !!b && a.kind === b.kind && a.sid === b.sid && a.id === b.id && a.armKey === b.armKey;
}

// ---------------------------------------------------------------------------
// Popups.

const SHOW_DELAY_MS = 250;
const GAP = 14;

export function createPopups(rootEl, { galaxy, store }) {
  const box = el('div', 'lens-pop');
  box.setAttribute('role', 'tooltip');
  box.hidden = true;
  rootEl.appendChild(box);

  let cur = null;          // selection being shown / pending
  let timer = 0;
  let tick = 0;
  let mx = -1, my = -1;    // last cursor position (CSS px)
  let full = null;         // full record fetched for file/ship lookups
  let fetching = '';
  let visible = false;

  const onMove = (e) => { mx = e.clientX; my = e.clientY; if (visible) place(); };
  const onDown = () => hide();
  const onKey = (e) => { if (e.key === 'Escape') hide(); };
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('keydown', onKey);
  window.addEventListener('blur', onDown);

  function hide() {
    clearTimeout(timer); timer = 0;
    clearInterval(tick); tick = 0;
    visible = false; box.hidden = true; box.classList.remove('is-on');
  }

  function place() {
    const W = window.innerWidth, H = window.innerHeight;
    const bw = box.offsetWidth, bh = box.offsetHeight;
    // Pinned to the cursor (an orbiting object is hard to follow with your eyes).
    const ox = mx, oy = my, r = 6;
    // Prefer the side of the object facing the cursor, else right; never overlap the object's disc.
    let dx = mx - ox, dy = my - oy;
    const d = Math.hypot(dx, dy);
    if (d < 1) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
    const out = r + GAP;
    let x, y;
    if (Math.abs(dx) >= Math.abs(dy) * 0.6) {
      x = dx >= 0 ? ox + out : ox - out - bw;
      y = Math.max(oy, my) - bh * 0.35;
    } else {
      x = mx - bw * 0.3;
      y = dy >= 0 ? oy + out : oy - out - bh;
    }
    // Flip horizontally if it would leave the screen, then clamp.
    if (x + bw > W - 8) x = ox - out - bw;
    if (x < 8) x = Math.min(W - bw - 8, ox + out);
    x = Math.max(8, Math.min(W - bw - 8, x));
    y = Math.max(8, Math.min(H - bh - 8, y));
    box.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  }

  function render() {
    if (!cur) return hide();
    const d = describe(cur, store, { full });
    if (!d) return hide();
    if (d.more && cur.sid && fetching !== cur.sid && typeof store.fetchSession === 'function') {
      const want = cur; fetching = cur.sid;
      store.fetchSession(cur.sid).then((rec) => {
        fetching = '';
        if (rec && sameSel(want, cur)) { full = rec; render(); }
      }, () => { fetching = ''; });
    }
    box.replaceChildren();
    box.dataset.kind = d.kind;
    box.classList.toggle('is-needs', d.state === MODE.NEEDS_ME);
    const head = el('div', 'lens-pop__head');
    head.append(el('span', 'lens-pop__glyph', d.glyph || ''), el('span', 'lens-pop__title', d.title));
    const kindName = (GLOSSARY.objects[d.kind] || {}).name;
    if (kindName && d.kind !== 'galaxy' && d.kind !== 'core' && d.kind !== 'codex' && d.kind !== 'me') head.append(el('span', 'lens-pop__kind', kindName));
    // Name only (owner, 2026-11-02): the full explanation lives in the Selected panel. Click to open it.
    box.append(head);
    box.hidden = false;
    visible = true;
    place();
    box.classList.add('is-on');
  }

  const offHover = store.on('hover', (sel) => {
    if (sameSel(sel, cur) && (visible || timer)) return;
    hide();
    cur = sel || null;
    if (!cur || cur.kind === 'galaxy') { cur = null; return; }  // empty space: no popup
    if (!full || full.id !== cur.sid) full = null;
    timer = setTimeout(() => {
      timer = 0; render();
    }, SHOW_DELAY_MS);
  });
  const offSel = store.on('selection', () => hide());

  return {
    get visible() { return visible; },
    refresh() { if (visible) render(); },
    /** Show a popup for `sel` now (used by HUD rows if they want it). */
    showFor(sel, clientX, clientY) { cur = sel; mx = clientX; my = clientY; clearTimeout(timer); render(); },
    hide,
    dispose() {
      hide();
      offHover && offHover(); offSel && offSel();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onDown);
      box.remove();
    },
  };
}

export const createHover = createPopups;
