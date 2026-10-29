// node --test tests/server-model.test.mjs
// Model tests. Synthetic sessions run in temp dirs (registry, needs-me, forks,
// storms, crashes, exclusion). The real-data tests only READ ~/.claude: they
// recount tokens and compactions independently and check state invariants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModel, contextLimit, longestPrefix, stripWorktree, DEFAULT_LIMITS } from '../server/model.mjs';
import { MODE, SUB, BADGE, REMNANT, ORIGIN, EV } from '../web/src/shared/schema.mjs';

const iso = (s) => new Date(s * 1000).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const sidN = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------- synthetic env
function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmos-model-'));
  const claudeHome = path.join(root, '.claude');
  const proj = path.join(claudeHome, 'projects', '-tmp-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  return {
    root, claudeHome, proj, appSupport: path.join(root, 'app'), claudeJson: path.join(root, 'claude.json'),
    write(sid, entries) { fs.writeFileSync(path.join(proj, `${sid}.jsonl`), entries.map(line).join('')); },
    append(sid, entries) { fs.appendFileSync(path.join(proj, `${sid}.jsonl`), entries.map(line).join('')); },
    registry(pid, rec) { fs.writeFileSync(path.join(claudeHome, 'sessions', `${pid}.json`), JSON.stringify(rec)); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}
function model(e, extra = {}) {
  const events = [];
  const m = createModel({
    claudeHome: e.claudeHome, appSupport: e.appSupport, claudeJson: e.claudeJson,
    limitsPath: null, tick: false, pollMs: 60000, onEvent: (ev) => events.push(ev), ...extra,
  });
  return { m, events };
}
const base = (sid, cwd = '/tmp/proj') => ({ sessionId: sid, cwd, entrypoint: 'cli', version: '2.1.309', isSidechain: false, userType: 'external' });
const U = (sid, uuid, t, content, more = {}) => ({ ...base(sid), parentUuid: null, type: 'user', uuid, timestamp: iso(t), message: { role: 'user', content }, ...more });
const A = (sid, uuid, t, msgId, { model = 'claude-opus-5-5', stop = 'end_turn', usage = {}, content = [{ type: 'text', text: 'ok' }] } = {}) => ({
  ...base(sid), parentUuid: null, type: 'assistant', uuid, timestamp: iso(t),
  message: { id: msgId, model, role: 'assistant', stop_reason: stop, content,
    usage: { input_tokens: usage.input ?? 10, output_tokens: usage.output ?? 20, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheCreate ?? 0 } },
});
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, isError = false) => [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }];
function procStartUtcOf(pid) {
  const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)]).toString().trim().replace(/\s+/g, ' ');
  const d = new Date(Date.parse(out));
  const wd = d.toUTCString().slice(0, 3);
  const mon = d.toUTCString().slice(8, 11);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${wd} ${mon} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return fn();
}

// ---------------------------------------------------------------- pure helpers
test('context limit: rules, default, observed-peak raise', () => {
  assert.equal(contextLimit('claude-opus-5-5', DEFAULT_LIMITS), 1000000);
  assert.equal(contextLimit('claude-haiku-5-5', DEFAULT_LIMITS), 1000000);
  assert.equal(contextLimit('claude-sonnet-4[1m]', DEFAULT_LIMITS), 1000000);
  assert.equal(contextLimit('claude-unknown', DEFAULT_LIMITS), 200000);
  assert.equal(contextLimit('claude-unknown', DEFAULT_LIMITS, 300000), Math.ceil(300000 / 0.97));
  assert.equal(contextLimit(null, DEFAULT_LIMITS), 200000);
});
test('arm prefix: longest root wins, worktrees fold into their repo', () => {
  const roots = ['/u/P/atlas', '/u/P/Side Projects', '/u/P/Side Projects/side-project'];
  assert.equal(longestPrefix('/u/P/atlas/art/showcase', roots), '/u/P/atlas');
  assert.equal(longestPrefix('/u/P/Side Projects/side-project', roots), '/u/P/Side Projects/side-project');
  assert.equal(longestPrefix('/u/P/Side Projects/cosmos', roots), '/u/P/Side Projects');
  assert.equal(longestPrefix('/u/P/atlasly', roots), '/u/P/atlasly');
  assert.equal(stripWorktree('/u/P/atlas/.claude/worktrees/zen-1/web'), '/u/P/atlas');
});

// ---------------------------------------------------------------- synthetic sessions
test('needs-me from a synthetic S5 file: enter and leave synchronously, < 1 s end to end', async () => {
  const e = env();
  try {
    const sid = sidN(1);
    const now = Date.now() / 1000;
    e.write(sid, [U(sid, 'u1', now - 20, 'do it'), A(sid, 'a1', now - 19, 'm1', { stop: 'tool_use', content: [toolUse('tu1', 'Bash', { command: 'ls' })] })]);
    const reg = { pid: process.pid, sessionId: sid, cwd: '/tmp/proj', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now() - 30000, procStart: procStartUtcOf(process.pid), kind: 'interactive', entrypoint: 'cli', version: '2.1.309' };
    e.registry(process.pid, reg);
    const { m, events } = model(e);
    await m.start();
    let r = m.get(sid);
    assert.equal(r.live, true);
    assert.equal(r.state.mode, MODE.NEEDS_ME);
    assert.equal(r.state.sub, SUB.APPROVE);
    assert.ok(r.state.badges.includes(BADGE.UNVERIFIED));
    assert.ok(events.some((ev) => ev.type === EV.NEEDS_ME_START && ev.data.source === 'registry' && ev.data.tool === 'Bash'));
    // The owner approves: registry flips to busy.
    const t0 = performance.now();
    e.registry(process.pid, { ...reg, status: 'busy', waitingFor: undefined, statusUpdatedAt: Date.now(), updatedAt: Date.now() });
    assert.ok(await until(() => events.some((ev) => ev.type === EV.NEEDS_ME_END)), 'needs-me-end within 2 s');
    const ms = performance.now() - t0;
    console.log(`# registry busy -> needs-me-end event: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 1000);
    const end = events.find((ev) => ev.type === EV.NEEDS_ME_END);
    assert.equal(end.data.how, 'answered');
    assert.equal(end.live, true);
    r = m.get(sid);
    assert.equal(r.state.mode, MODE.WORKING);
    assert.equal(r.state.sub, SUB.TOOL);
    assert.equal(r.state.tool, 'Bash');
    // Back to waiting again -> needs-me again, this time "input needed" = question.
    e.registry(process.pid, { ...reg, status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: Date.now() + 5, updatedAt: Date.now() + 5 });
    assert.ok(await until(() => m.get(sid).state.mode === MODE.NEEDS_ME));
    assert.equal(m.get(sid).state.sub, SUB.QUESTION);
    // "dialog open" is MY MOVE with a dialog badge, never NEEDS ME.
    e.registry(process.pid, { ...reg, status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: Date.now() + 10, updatedAt: Date.now() + 10 });
    assert.ok(await until(() => m.get(sid).state.mode === MODE.MY_MOVE));
    assert.ok(m.get(sid).state.badges.includes(BADGE.DIALOG));
    m.stop();
  } finally { e.cleanup(); }
});

test('AskUserQuestion pending without a registry file -> needs-me (question, no-registry); answered -> working', async () => {
  const e = env();
  try {
    const sid = sidN(2);
    const now = Date.now() / 1000;
    e.write(sid, [U(sid, 'u1', now - 30, 'help'), A(sid, 'a1', now - 29, 'm1', { stop: 'tool_use', content: [toolUse('tq', 'AskUserQuestion', { questions: [] })] })]);
    const { m, events } = model(e);
    await m.start();
    const r = m.get(sid);
    assert.equal(r.live, false);
    assert.equal(r.state.mode, MODE.NEEDS_ME);
    assert.equal(r.state.sub, SUB.QUESTION);
    assert.ok(r.state.badges.includes(BADGE.NO_REGISTRY));
    assert.ok(events.some((ev) => ev.type === EV.NEEDS_ME_START && ev.data.source === 'transcript'));
    m.stop();
  } finally { e.cleanup(); }
});

test('remnants: crash tails, clean end, late notification; helper sessions are excluded', async () => {
  const e = env();
  try {
    const old = Date.now() / 1000 - 3 * 86400;
    const s1 = sidN(11), s2 = sidN(12), s3 = sidN(13), s4 = sidN(14), s5 = sidN(15), sx = sidN(19);
    e.write(s1, [U(s1, 'a', old, 'hi'), A(s1, 'b', old + 1, 'm11'), U(s1, 'c', old + 60, 'are you there?')]);                  // no reply
    e.write(s2, [U(s2, 'a2', old, 'hi'), A(s2, 'b2', old + 1, 'm21', { stop: 'tool_use', content: [toolUse('t21', 'Bash')] })]); // pending tool
    e.write(s3, [U(s3, 'a3', old, 'hi'), A(s3, 'b3', old + 1, 'm31')]);                                                          // clean end
    e.write(s4, [U(s4, 'a4', old, 'hi'), A(s4, 'b4', old + 1, 'm41'),
      U(s4, 'c4', old + 50, 'done', { origin: { kind: 'task-notification' }, turnOrigin: 'task_notification' })]);                 // benign late notification
    e.write(s5, [U(s5, 'a5', old, 'hi'), { ...A(s5, 'b5', old + 1, 'm51', { model: '<synthetic>' }), isApiErrorMessage: true, apiErrorStatus: 429 }]);
    const helperCwd = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'cache', 'explain-cwd');
    e.write(sx, [{ ...U(sx, 'ax', old, 'explain'), cwd: helperCwd }, { ...A(sx, 'bx', old + 1, 'mx'), cwd: helperCwd }]);
    const { m, events } = model(e);
    await m.start();
    assert.equal(m.get(s1).state.mode, MODE.CRASHED);
    assert.equal(m.get(s1).state.remnant, REMNANT.CRASHED);
    assert.equal(events.find((ev) => ev.sid === s1 && ev.type === EV.CRASHED).data.reason, 'no-reply');
    assert.equal(events.find((ev) => ev.sid === s2 && ev.type === EV.CRASHED).data.reason, 'pending-tool');
    assert.equal(m.get(s3).state.mode, MODE.DEAD);
    assert.equal(m.get(s3).state.remnant, REMNANT.ENDED);
    assert.equal(m.get(s4).state.mode, MODE.DEAD);
    assert.equal(m.get(s4).state.remnant, REMNANT.ENDED);
    assert.equal(m.get(s5).state.remnant, REMNANT.CRASHED_API);
    assert.equal(m.get(sx), null, 'helper session must not exist');
    assert.ok(!events.some((ev) => ev.sid === sx), 'helper session must emit nothing');
    // Event order for a clean end: my-move -> idle -> dead, all before "now".
    const seq = events.filter((ev) => ev.sid === s3 && [EV.WORKING, EV.MY_MOVE, EV.IDLE, EV.DEAD].includes(ev.type)).map((ev) => ev.type);
    assert.deepEqual(seq, [EV.WORKING, EV.MY_MOVE, EV.IDLE, EV.DEAD]);
    assert.ok(events.every((ev) => ev.t <= Date.now() / 1000 + 1));
    m.stop();
  } finally { e.cleanup(); }
});

test('fork dedupe: copies credit the parent; the fork keeps only its own messages', async () => {
  const e = env();
  try {
    const p = sidN(21), f = sidN(22);
    const t = Date.now() / 1000 - 7200;
    const parent = [U(p, 'pu1', t, 'start'), A(p, 'pa1', t + 1, 'mp1', { usage: { input: 100, output: 50, cacheRead: 1000, cacheCreate: 10 } }),
      U(p, 'pu2', t + 10, 'more'), A(p, 'pa2', t + 11, 'mp2', { usage: { input: 200, output: 70, cacheRead: 2000, cacheCreate: 20 } })];
    e.write(p, parent);
    // The fork copies the parent's entries (same uuids and message ids, its own sessionId), then continues.
    const copied = parent.map((x) => ({ ...x, sessionId: f }));
    e.write(f, [...copied, U(f, 'fu1', t + 100, 'fork q'), A(f, 'fa1', t + 101, 'mf1', { usage: { input: 5, output: 7, cacheRead: 300, cacheCreate: 1 } })]);
    // Make the fork file newer by birth so read order is parent first even on equal first timestamps.
    const { m } = model(e);
    await m.start();
    const rp = m.get(p), rf = m.get(f);
    assert.deepEqual([rp.tokens.input, rp.tokens.output, rp.tokens.cacheRead, rp.tokens.cacheCreate], [300, 120, 3000, 30]);
    assert.equal(rp.tokens.total, 300 + 120 + 30);
    assert.deepEqual([rf.tokens.input, rf.tokens.output, rf.tokens.cacheRead, rf.tokens.cacheCreate], [5, 7, 300, 1]);
    assert.equal(rf.origin, ORIGIN.FORK);
    assert.equal(rf.forkOf, p);
    assert.equal(rf.counts.turns, 1);
    assert.equal(rp.counts.turns, 2);
    // Largest output per message id wins (partial blocks grow).
    m.stop();
  } finally { e.cleanup(); }
});

test('fork lineage: S6 marks the child when birth time lies; a copy-only fork still shows its context', async () => {
  const e = env();
  try {
    const p = sidN(31), f = sidN(32), g = sidN(33);
    const t = Date.now() / 1000 - 7200;
    const parent = [U(p, 'qu1', t, 'start'), A(p, 'qa1', t + 1, 'mq1', { usage: { input: 100, output: 50, cacheRead: 1000, cacheCreate: 10 } })];
    const copied = (sid) => parent.map((x) => ({ ...x, sessionId: sid }));
    // The fork's file is created FIRST (older birth time), the parent's re-created later.
    e.write(f, [...copied(f), U(f, 'fu1', t + 100, 'fork q'), A(f, 'fa1', t + 101, 'mf9', { usage: { input: 5, output: 7, cacheRead: 300, cacheCreate: 1 } })]);
    await new Promise((r) => setTimeout(r, 20));
    e.write(p, parent);
    const odir = path.join(e.appSupport, 'acct', 'org');
    fs.mkdirSync(odir, { recursive: true });
    fs.writeFileSync(path.join(odir, 'local_child.json'), JSON.stringify({ sessionId: 'local_child', cliSessionId: f, forkedFromSessionId: 'local_gone', spawnedFrom: { sessionId: 'local_gone', userFork: true } }));
    // g: a fork with no reply of its own yet.
    await new Promise((r) => setTimeout(r, 20));
    e.write(g, [...copied(g), U(g, 'gu1', t + 200, 'new fork, no reply yet')]);
    const { m } = model(e);
    await m.start();
    const rp = m.get(p), rf = m.get(f), rg = m.get(g);
    assert.equal(rp.tokens.output, 50, 'the parent is credited for the shared entries');
    assert.equal(rf.tokens.output, 7);
    assert.notEqual(rp.origin, ORIGIN.FORK);
    assert.equal(rf.origin, ORIGIN.FORK);
    assert.equal(rf.forkOf, p);
    assert.equal(rg.tokens.output, 0);
    assert.equal(rg.context.used, 100 + 1000 + 10, 'copied prefix is the fork\'s real context window');
    assert.equal(rg.model, 'claude-opus-5-5');
    m.stop();
  } finally { e.cleanup(); }
});

test('crash after an API error with a queued notification is the API-error variant; endedAt only when ended', async () => {
  const e = env();
  try {
    const old = Date.now() / 1000 - 3 * 86400;
    const s1 = sidN(41), s2 = sidN(42);
    e.write(s1, [U(s1, 'a', old, 'hi'), { ...A(s1, 'b', old + 1, 'm41x', { model: '<synthetic>' }), isApiErrorMessage: true, error: 'rate_limit' },
      U(s1, 'c', old + 1.01, 'done', { origin: { kind: 'task-notification' }, turnOrigin: 'task_notification' })]);
    const now = Date.now() / 1000;
    e.write(s2, [U(s2, 'a2', now - 20, 'go'), A(s2, 'b2', now - 19, 'm42x', { stop: 'tool_use', content: [toolUse('t42', 'Bash')] })]);
    const { m } = model(e);
    await m.start();
    assert.equal(m.get(s1).state.mode, MODE.CRASHED);
    assert.equal(m.get(s1).state.remnant, REMNANT.CRASHED_API);
    assert.ok(m.get(s1).times.endedAt != null);
    assert.equal(m.get(s2).state.mode, MODE.WORKING, 'transcript-only liveness');
    assert.equal(m.get(s2).times.endedAt, null, 'a WORKING session has not ended');
    m.stop();
  } finally { e.cleanup(); }
});

test('arm: work inside a container folder\'s subfolder goes to that subfolder\'s arm', async () => {
  const e = env();
  try {
    const container = path.join(e.root, 'Misc');
    fs.mkdirSync(path.join(container, 'studio', 'src'), { recursive: true });
    fs.mkdirSync(path.join(container, 'other'), { recursive: true });
    fs.writeFileSync(e.claudeJson, JSON.stringify({ projects: { [container]: {} } }));
    const s1 = sidN(51), s2 = sidN(52);
    const t = Date.now() / 1000 - 4000;
    const edits = [1, 2, 3].map((i) => A(s1, `e${i}`, t + i, `m51${i}`, { stop: 'tool_use', content: [toolUse(`te${i}`, 'Edit', { file_path: path.join(container, 'studio', 'src', `f${i}.js`) })] }));
    e.write(s1, [{ ...U(s1, 'u', t, 'go'), cwd: container }, ...edits.map((x) => ({ ...x, cwd: container }))]);
    e.write(s2, [{ ...U(s2, 'u2', t, 'chat'), cwd: container }, { ...A(s2, 'a2', t + 1, 'm52'), cwd: container }]);
    const { m } = model(e);
    await m.start();
    assert.equal(m.get(s1).arm.key, path.join(container, 'studio'));
    assert.equal(m.get(s1).arm.name, 'studio');
    assert.equal(m.get(s2).arm.key, container, 'no file work: the cwd\'s project');
    m.stop();
  } finally { e.cleanup(); }
});

test('tokens: largest output per message id; context fill per model; storm; files; ships', async () => {
  const e = env();
  try {
    const sid = sidN(31);
    const t = Date.now() / 1000 - 4000;
    const blocks = [
      A(sid, 'b1', t + 1, 'm1', { stop: null, usage: { input: 10, output: 1, cacheRead: 499990, cacheCreate: 0 }, content: [{ type: 'thinking', thinking: '' }] }),
      A(sid, 'b2', t + 2, 'm1', { stop: 'tool_use', usage: { input: 10, output: 300, cacheRead: 499990, cacheCreate: 0 },
        content: [toolUse('e1', 'Edit', { file_path: '/tmp/proj/web/a.js' }), toolUse('e2', 'Read', { file_path: '/tmp/proj/web/b.js' })] }),
    ];
    const errs = [];
    for (let i = 0; i < 4; i++) {
      errs.push(A(sid, `eb${i}`, t + 10 + i * 3, `me${i}`, { stop: 'tool_use', usage: { input: 1, output: 2 }, content: [toolUse(`x${i}`, 'Bash')] }));
      errs.push(U(sid, `er${i}`, t + 11 + i * 3, toolResult(`x${i}`, true)));
    }
    e.write(sid, [U(sid, 'u1', t, 'go'), ...blocks, U(sid, 'r1', t + 3, [...toolResult('e1'), ...toolResult('e2')]),
      ...errs, A(sid, 'fin', t + 40, 'mfin', { usage: { input: 3, output: 4 } })]);
    // A subagent of this session (linked by meta.toolUseId).
    const sub = path.join(e.proj, sid, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-aaa111.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look around', toolUseId: 'e1', spawnDepth: 1, finished: true }));
    fs.writeFileSync(path.join(sub, 'agent-aaa111.jsonl'), [A(sid, 's1', t + 5, 'ms1', { model: 'claude-haiku-5-5', usage: { input: 1000, output: 100 } })].map((x) => line({ ...x, agentId: 'aaa111', isSidechain: true })).join(''));
    const unknown = sidN(32);
    e.write(unknown, [U(unknown, 'q1', t, 'x'), A(unknown, 'q2', t + 1, 'mq', { model: 'claude-mystery', usage: { input: 100000, output: 1 } })]);
    const { m, events } = model(e);
    await m.start();
    const r = m.get(sid);
    // m1 counted once with its largest output (300), plus 4 error turns, the final reply, and the ship.
    assert.equal(r.tokens.output, 300 + 4 * 2 + 4 + 100);
    assert.equal(r.tokens.input, 10 + 4 * 1 + 3 + 1000);
    assert.equal(r.tokens.total, r.tokens.input + r.tokens.output + r.tokens.cacheCreate);
    // Context: last main assistant message = 'mfin' (3 + 0 + 0); peak from m1.
    assert.equal(r.context.used, 3);
    assert.equal(r.context.peak, 500000);
    assert.equal(r.context.limit, 1000000);
    assert.equal(m.get(unknown).context.limit, 200000);
    assert.equal(m.get(unknown).context.fill, 100000 / 200000);
    // Storm: 4 errors, 3 s apart -> one storm of 4.
    assert.equal(r.counts.errors, 4);
    assert.equal(r.counts.storms, 1);
    const ss = events.filter((ev) => ev.sid === sid && ev.type === EV.STORM_START);
    const se = events.filter((ev) => ev.sid === sid && ev.type === EV.STORM_END);
    assert.equal(ss.length, 1); assert.equal(se.length, 1);
    assert.equal(se[0].data.count, 4);
    assert.ok(events.filter((ev) => ev.type === EV.ERROR && ev.sid === sid).every((ev) => ev.src && Number.isInteger(ev.src.off)));
    // Files relative to the first cwd.
    assert.deepEqual(r.files.map((f) => [f.path, f.edits, f.reads]).sort(), [['web/a.js', 1, 0], ['web/b.js', 0, 1]]);
    assert.equal(r.folders[0].id, 'd:web');
    // Ship.
    assert.equal(r.ships.length, 1);
    assert.equal(r.ships[0].label, 'Explore');
    assert.equal(r.ships[0].tokens, 1100);
    assert.equal(r.ships[0].active, false);
    assert.ok(events.some((ev) => ev.type === EV.SUBAGENT_BACK && ev.data.how === 'finished'));
    // A diag line round trip: readLine returns exactly the error's tool_result line (structure only checked).
    const errEv = events.find((ev) => ev.type === EV.ERROR && ev.sid === sid);
    const ln = await m.readLine(errEv.src);
    assert.equal(JSON.parse(ln).uuid, 'er0');
    m.stop();
  } finally { e.cleanup(); }
});

// ---------------------------------------------------------------- real data (read-only)
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const REAL = fs.existsSync(PROJECTS);
let realPromise = null;
function real() {
  if (!realPromise) {
    realPromise = (async () => {
      const events = [];
      const t0 = performance.now();
      const m = createModel({ limitsPath: null, tick: false, watch: false, pollMs: 600000, onEvent: (ev) => events.push(ev) });
      await m.start();
      const ms = performance.now() - t0;
      m.stop();
      return { m, events, ms, recs: m.sessions() };
    })();
  }
  return realPromise;
}
function* jsonl(file) {
  const txt = fs.readFileSync(file, 'utf8');
  for (const l of txt.split('\n')) { if (!l) continue; try { yield JSON.parse(l); } catch { /* skip */ } }
}
function folderOf(sid) {
  for (const d of fs.readdirSync(PROJECTS)) if (fs.existsSync(path.join(PROJECTS, d, `${sid}.jsonl`))) return path.join(PROJECTS, d);
  return null;
}
function agentFiles(dir) {
  const out = [];
  const walk = (p) => { if (!fs.existsSync(p)) return; for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else if (/^agent-.*\.jsonl$/.test(e.name)) out.push(q); } };
  walk(dir);
  return out;
}

test('real: first full scan time and record invariants', { skip: !REAL }, async () => {
  const { m, recs, ms, events } = await real();
  console.log(`# model backfill: ${recs.size} sessions, ${events.length} events, ${ms.toFixed(0)} ms`, JSON.stringify(m.stats().reader));
  assert.ok(ms < 60000);
  assert.ok(recs.size >= 10);
  const modes = new Set(Object.values(MODE));
  const ids = new Set();
  for (const ev of events) { assert.ok(!ids.has(ev.id), `duplicate backfill event ${ev.id}`); ids.add(ev.id); }
  for (let i = 1; i < events.length; i++) if (!events[i].live && !events[i - 1].live) assert.ok(events[i].t >= events[i - 1].t, 'backfill is time ordered');
  for (const r of recs.values()) {
    assert.equal(r.v, 1);
    assert.ok(modes.has(r.state.mode), r.state.mode);
    assert.equal(r.tokens.total, r.tokens.input + r.tokens.output + r.tokens.cacheCreate);
    assert.ok(Math.abs(r.context.fill - r.context.used / r.context.limit) < 1e-9);
    assert.ok(r.context.limit >= 200000);
    assert.ok(Number.isFinite(r.state.since));
    assert.ok(r.state.idleFor >= 0 && r.state.idleFor <= 1);
    if (r.live) assert.equal(r.state.remnant, null);
    else assert.ok(r.state.remnant !== null || r.state.mode === MODE.WORKING || r.state.mode === MODE.NEEDS_ME, `${r.id} non-live without remnant`);
    if (r.state.mode === MODE.CRASHED) assert.ok([REMNANT.CRASHED, REMNANT.CRASHED_API].includes(r.state.remnant));
    if (r.state.mode === MODE.WORKING) assert.ok([SUB.GENERATING, SUB.TOOL, SUB.RETRYING].includes(r.state.sub));
    assert.ok(r.title && r.arm.key);
  }
  // Fork dedupe credits the earliest file: a fork is never born before its parent,
  // and a file-prefix fork never re-counts its parent's turns.
  for (const r of recs.values()) {
    const p = r.forkOf ? recs.get(r.forkOf) : null;
    if (p) assert.ok(p.times.bornAt <= r.times.bornAt + 1, `fork ${r.id} born before parent ${p.id}`);
  }
  // Privacy: no event carries free text.
  for (const ev of events) {
    const s = JSON.stringify(ev.data);
    assert.ok(!/"(text|content|prompt|message|stdout|stderr)"/.test(s), `event ${ev.type} carries a text field`);
  }
  // Arms per DATA_SPEC §2 / DECISIONS (side-project is its own arm; nested non-roots fold into their repo).
  const arms = new Map();
  for (const r of recs.values()) arms.set(r.arm.name, (arms.get(r.arm.name) || 0) + 1);
  console.log('# arms', JSON.stringify([...arms]));
});

test('real: state of currently running sessions is working, my-move or needs-me (dead only after a full idle day)', { skip: !REAL }, async () => {
  const { recs } = await real();
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let checked = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    let alive = false;
    try { process.kill(j.pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
    if (!alive) continue;
    const r = recs.get(j.sessionId);
    if (!r) continue;
    checked++;
    assert.equal(r.live, true, `${j.sessionId} should be live`);
    const idleS = Date.now() / 1000 - r.times.lastActivity;
    if (j.status === 'busy') assert.ok([MODE.WORKING, MODE.MY_MOVE].includes(r.state.mode), `${j.sessionId} busy -> ${r.state.mode}`);
    else if (j.status === 'idle') assert.ok(r.state.mode === MODE.MY_MOVE || (r.state.mode === MODE.DEAD && idleS >= 86400), `${j.sessionId} idle -> ${r.state.mode}`);
    else if (j.status === 'waiting') assert.ok([MODE.NEEDS_ME, MODE.MY_MOVE].includes(r.state.mode));
  }
  console.log(`# live sessions checked: ${checked}`);
  assert.ok(checked > 0);
});

test('real: tokens deduped by message.id equal a direct recount (3 sessions)', { skip: !REAL }, async () => {
  const { recs } = await real();
  const forkTargets = new Set([...recs.values()].map((r) => r.forkOf).filter(Boolean));
  const cands = [...recs.values()].filter((r) => !r.live && !r.forkOf && r.origin !== ORIGIN.FORK && !forkTargets.has(r.id) && !r.cacheOnly)
    .sort((a, b) => b.tokens.total - a.tokens.total);
  let done = 0;
  for (const r of cands) {
    if (done >= 3) break;
    const folder = folderOf(r.id);
    const agents = agentFiles(path.join(folder, r.id));
    const agentIds = new Set(agents.map((f) => /agent-(.+)\.jsonl$/.exec(f)[1]));
    const recShips = new Set(r.ships.map((s) => s.id));
    if (agentIds.size !== recShips.size || [...agentIds].some((a) => !recShips.has(a))) continue; // ships launched elsewhere
    const best = new Map();
    for (const f of [path.join(folder, `${r.id}.jsonl`), ...agents]) {
      for (const o of jsonl(f)) {
        if (o.type !== 'assistant' || !o.message?.id || o.message.model === '<synthetic>') continue;
        const u = o.message.usage || {};
        const cur = best.get(o.message.id);
        if (!cur || (u.output_tokens || 0) > cur.output) {
          best.set(o.message.id, { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0 });
        }
      }
    }
    const sum = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    for (const v of best.values()) for (const k of Object.keys(sum)) sum[k] += v[k];
    console.log(`# ${r.id.slice(0, 8)} recount ${JSON.stringify(sum)} model ${JSON.stringify({ input: r.tokens.input, output: r.tokens.output, cacheRead: r.tokens.cacheRead, cacheCreate: r.tokens.cacheCreate })}`);
    assert.deepEqual({ input: r.tokens.input, output: r.tokens.output, cacheRead: r.tokens.cacheRead, cacheCreate: r.tokens.cacheCreate }, sum);
    done++;
  }
  assert.equal(done, 3);
});

test('real: compactions found equal unique compact_boundary entries', { skip: !REAL }, async () => {
  const { recs, events } = await real();
  const main = new Set(), all = new Set();
  const excludedOrHelper = new Set();
  for (const d of fs.readdirSync(PROJECTS)) {
    const dp = path.join(PROJECTS, d);
    if (!fs.statSync(dp).isDirectory()) continue;
    const files = [];
    for (const e of fs.readdirSync(dp)) {
      if (e.endsWith('.jsonl')) files.push([path.join(dp, e), true]);
      else if (fs.statSync(path.join(dp, e)).isDirectory()) for (const a of agentFiles(path.join(dp, e))) files.push([a, false]);
    }
    for (const [f, isMain] of files) {
      const txt = fs.readFileSync(f, 'utf8');
      if (!txt.includes('"compact_boundary"')) continue;
      for (const l of txt.split('\n')) {
        if (!l.includes('"subtype":"compact_boundary"')) continue;
        const o = JSON.parse(l);
        if (o.type !== 'system' || o.subtype !== 'compact_boundary') continue;
        if (!recs.has(o.sessionId) && isMain) { excludedOrHelper.add(o.uuid); continue; }
        all.add(o.uuid);
        if (isMain) main.add(o.uuid);
      }
    }
  }
  const counted = [...recs.values()].reduce((n, r) => n + r.counts.compactions, 0);
  const evs = new Set(events.filter((ev) => ev.type === EV.COMPACTION).map((ev) => ev.id.split(':').pop()));
  console.log(`# compactions: main ${main.size} (records ${counted}), all ${all.size} (events ${evs.size})`);
  assert.equal(counted, main.size);
  assert.equal(evs.size, all.size);
  assert.deepEqual([...all].sort(), [...evs].sort());
});

test('real: tool errors equal unique is_error tool_results', { skip: !REAL }, async () => {
  const { recs } = await real();
  const ids = new Set();
  for (const d of fs.readdirSync(PROJECTS)) {
    const dp = path.join(PROJECTS, d);
    if (!fs.statSync(dp).isDirectory()) continue;
    const files = [];
    for (const e of fs.readdirSync(dp)) {
      if (e.endsWith('.jsonl')) files.push(path.join(dp, e));
      else if (fs.statSync(path.join(dp, e)).isDirectory()) files.push(...agentFiles(path.join(dp, e)));
    }
    for (const f of files) {
      const txt = fs.readFileSync(f, 'utf8');
      for (const l of txt.split('\n')) {
        if (!l.includes('"is_error":true')) continue;
        const o = JSON.parse(l);
        if (o.type !== 'user' || !Array.isArray(o.message?.content)) continue;
        for (const b of o.message.content) if (b.type === 'tool_result' && b.is_error === true) ids.add(b.tool_use_id);
      }
    }
  }
  const counted = [...recs.values()].reduce((n, r) => n + r.counts.errors, 0);
  console.log(`# tool errors: unique is_error results ${ids.size}, records ${counted}`);
  // Records may be lower only by errors whose session is excluded (helper runs) or whose tool_use has no owner.
  assert.ok(counted <= ids.size && counted >= ids.size * 0.98, `${counted} vs ${ids.size}`);
});
