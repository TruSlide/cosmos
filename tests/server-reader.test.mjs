// node --test tests/server-reader.test.mjs
// Reader tests. Synthetic cases run in a temp dir; the real-data case only READS
// ~/.claude (never writes) and checks privacy invariants on every slim entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReader, parseLine, slimEntry, parseProcStartUtc, parsePsLocal } from '../server/reader.mjs';

const SID = '11111111-2222-4333-8444-555555555555';
const iso = (s) => new Date(s * 1000).toISOString();

function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmos-reader-'));
  const claudeHome = path.join(root, '.claude');
  fs.mkdirSync(path.join(claudeHome, 'projects', '-tmp-proj'), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  return { root, claudeHome, appSupport: path.join(root, 'app'), claudeJson: path.join(root, 'claude.json'),
    file: path.join(claudeHome, 'projects', '-tmp-proj', `${SID}.jsonl`), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const line = (o) => JSON.stringify(o) + '\n';
const user = (uuid, t, text) => ({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: iso(t), cwd: '/tmp/proj', sessionId: SID, entrypoint: 'cli' });

test('slimEntry keeps structure, drops every piece of text', () => {
  const u = slimEntry({
    type: 'user', uuid: 'u1', timestamp: iso(1000), cwd: '/x', isMeta: false,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'SECRET OUTPUT' }] },
    toolUseResult: { stdout: 'SECRET', agentId: 'a1', status: 'completed', prompt: 'SECRET PROMPT' }, toolDenialKind: 'user-rejected',
  });
  assert.deepEqual(u.results, [{ id: 'tu1', isError: true }]);
  assert.deepEqual(u.agentResult, { agentId: 'a1', status: 'completed' });
  assert.equal(u.toolDenialKind, 'user-rejected');
  assert.ok(!JSON.stringify(u).includes('SECRET'));
  const p = slimEntry({ type: 'user', uuid: 'u2', timestamp: iso(1), message: { content: '[Request interrupted by user for tool use]' } });
  assert.equal(p.interrupted, 'tool');
  assert.equal(p.prompt, true);
  assert.ok(!JSON.stringify(p).includes('Request'));
  const a = slimEntry({
    type: 'assistant', uuid: 'a1', timestamp: iso(2),
    message: { id: 'msg1', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 },
      content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'SECRET' }, { type: 'tool_use', id: 'tu9', name: 'Edit', input: { file_path: '/x/a.js', old_string: 'SECRET', new_string: 'SECRET' } }] },
  });
  assert.deepEqual(a.usage, { input: 3, output: 5, cacheRead: 7, cacheCreate: 11, thinking: 0 });
  assert.deepEqual(a.tools, [{ id: 'tu9', name: 'Edit', path: '/x/a.js', agentType: null }]);
  assert.ok(!JSON.stringify(a).includes('SECRET'));
});

test('parseLine skips bulky and text-carrying types without parsing them', () => {
  // Deliberately broken JSON after the head: a full parse would fail.
  for (const ty of ['api-request-blob', 'last-prompt', 'queue-operation', 'file-history-snapshot']) {
    const b = Buffer.from(`{"type":"${ty}","timestamp":"2026-10-29T10:00:00.000Z","x":"SECRET {{{ not json`);
    const e = parseLine(b, 0, b.length);
    assert.equal(e.type, ty);
    assert.ok(!e.bad);
    assert.ok(!JSON.stringify(e).includes('SECRET'));
  }
  const att = Buffer.from(line({ parentUuid: 'p1', isSidechain: false, attachment: { type: 'skill_listing', content: 'SECRET' }, type: 'attachment', uuid: 'att1', timestamp: '2026-10-29T10:00:01.000Z', cwd: '/w', sessionId: SID }).trim());
  const e = parseLine(att, 0, att.length);
  assert.equal(e.type, 'attachment');
  assert.equal(e.attachmentType, 'skill_listing');
  assert.equal(e.uuid, 'att1');
  assert.equal(e.cwd, '/w');
  assert.ok(!JSON.stringify(e).includes('SECRET'));
  const bad = Buffer.from('{"type":"user", nope');
  assert.equal(parseLine(bad, 0, bad.length).bad, true);
});

test('procStart is UTC, ps lstart is local', () => {
  const t = 1793291838;
  assert.equal(parseProcStartUtc('Thu Oct 29 16:37:18 2026'), t);
  const local = new Date(t * 1000).toString().slice(0, 24); // "Thu Oct 29 2026 09:37:18"
  const [wd, mon, d, y, hms] = local.split(' ');
  assert.equal(parsePsLocal(`${wd} ${mon} ${d} ${hms} ${y}`), t);
});

test('partial lines are held back, rewrites bump the epoch, readLine is exact', async () => {
  const h = tempHome();
  try {
    const l1 = line(user('u1', 1000, 'one'));
    const l2 = line(user('u2', 1001, 'two'));
    const l3 = line(user('u3', 1002, 'three'));
    fs.writeFileSync(h.file, l1 + l2 + l3.slice(0, 20));
    const batches = [];
    const r = createReader({ claudeHome: h.claudeHome, appSupport: h.appSupport, claudeJson: h.claudeJson, watch: false, pollMs: 60000,
      onEntries: (info, es) => batches.push({ info: { ...info }, es }) });
    await r.start();
    let all = batches.flatMap((b) => b.es);
    assert.deepEqual(all.map((e) => e.uuid), ['u1', 'u2']);
    assert.equal(r.state().files[`-tmp-proj/${SID}.jsonl`].offset, Buffer.byteLength(l1 + l2));
    // Finish the partial line.
    fs.appendFileSync(h.file, l3.slice(20));
    await r.poll();
    all = batches.flatMap((b) => b.es);
    assert.deepEqual(all.map((e) => e.uuid), ['u1', 'u2', 'u3']);
    const e3 = all[2];
    assert.equal(e3.__off, Buffer.byteLength(l1 + l2));
    assert.equal(e3.__len, Buffer.byteLength(l3) - 1);
    assert.equal(e3.__epoch, 0);
    assert.equal(await r.readLine(`-tmp-proj/${SID}.jsonl`, e3.__off, e3.__len), l3.trim());
    assert.equal(await r.readLine('../../etc/passwd.jsonl', 0, 10), null);
    // Rewrite with different content of the same length: last64 mismatch -> epoch 1, re-read from 0.
    const n1 = line(user('n1', 2000, 'ONE'));
    const n2 = line(user('n2', 2001, 'TWO'));
    const n3 = line(user('n3', 2002, 'THREE'));
    fs.writeFileSync(h.file, n1 + n2 + n3);
    batches.length = 0;
    await r.poll();
    assert.equal(batches[0].info.reset, true);
    assert.equal(batches[0].info.epoch, 1);
    assert.deepEqual(batches.flatMap((b) => b.es).map((e) => e.uuid), ['n1', 'n2', 'n3']);
    // Shrink: epoch 2.
    fs.writeFileSync(h.file, n1);
    batches.length = 0;
    await r.poll();
    assert.equal(batches[0].info.epoch, 2);
    assert.deepEqual(batches.flatMap((b) => b.es).map((e) => e.uuid), ['n1']);
    r.stop();
  } finally { h.cleanup(); }
});

test('a line longer than one 16 MB chunk survives intact', async () => {
  const h = tempHome();
  try {
    const big = { type: 'user', uuid: 'big', timestamp: iso(1001), message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'x'.repeat(40e6) }] } };
    fs.writeFileSync(h.file, line(user('a', 1000, 'hi')) + line(big) + line(user('c', 1002, 'yo')));
    const got = [];
    const r = createReader({ claudeHome: h.claudeHome, appSupport: h.appSupport, claudeJson: h.claudeJson, watch: false, pollMs: 60000,
      onEntries: (_i, es) => got.push(...es.map((e) => [e.uuid, e.results?.[0]?.isError ?? null])) });
    await r.start();
    r.stop();
    assert.deepEqual(got, [['a', null], ['big', true], ['c', null]]);
    assert.equal(r.stats().bad, 0);
  } finally { h.cleanup(); }
});

test('registry: never opens *.key, reports liveness, fs.watch latency', async () => {
  const h = tempHome();
  try {
    fs.writeFileSync(path.join(h.claudeHome, 'sessions', `${process.pid}.deadbeef.key`), 'not json, must never be read');
    const reg = { pid: process.pid, sessionId: SID, cwd: '/tmp/proj', status: 'busy', statusUpdatedAt: Date.now(), updatedAt: Date.now(), kind: 'interactive', entrypoint: 'cli', version: '2.1.309' };
    fs.writeFileSync(path.join(h.claudeHome, 'sessions', `${process.pid}.json`), JSON.stringify(reg));
    let last = null; let lastAt = 0;
    const r = createReader({ claudeHome: h.claudeHome, appSupport: h.appSupport, claudeJson: h.claudeJson, pollMs: 60000,
      onRegistry: (recs) => { last = recs; lastAt = performance.now(); } });
    await r.start();
    assert.equal(last.length, 1);
    assert.equal(last[0].alive, true);
    assert.equal(last[0].status, 'busy');
    const t0 = performance.now();
    fs.writeFileSync(path.join(h.claudeHome, 'sessions', `${process.pid}.json`), JSON.stringify({ ...reg, status: 'waiting', waitingFor: 'permission prompt' }));
    const deadline = Date.now() + 2000;
    while (last[0].status !== 'waiting' && Date.now() < deadline) await new Promise((res) => setTimeout(res, 5));
    const latency = lastAt - t0;
    console.log(`# registry change -> onRegistry: ${latency.toFixed(0)} ms (budget 100 ms)`);
    assert.equal(last[0].status, 'waiting');
    assert.equal(last[0].waitingFor, 'permission prompt');
    assert.ok(latency < 250, `registry latency ${latency} ms`);
    r.stop();
  } finally { h.cleanup(); }
});

test('real data (read-only): full scan, zero bad lines, privacy whitelist', async () => {
  const home = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(home)) return;
  const ALLOWED = new Set(['type', 't', 'uuid', 'parentUuid', 'sessionId', 'cwd', 'entrypoint', 'version', 'agentId', 'gitBranch',
    'isMeta', 'isCompactSummary', 'prompt', 'interrupted', 'turnOrigin', 'originKind', 'toolDenialKind', 'shutdown', 'results', 'agentResult',
    'msgId', 'model', 'stop', 'usage', 'apiError', 'apiStatus', 'thinkingMs', 'tools', 'subtype', 'compact', 'retryAttempt', 'maxRetries',
    'retryInMs', 'attachmentType', 'id', 'querySource', 'title', 'mode', '__off', '__len', '__epoch']);
  let n = 0, keysBad = new Set(), longStrings = 0, files = 0;
  const t0 = performance.now();
  const r = createReader({ watch: false, pollMs: 600000,
    onEntries: (info, es) => {
      for (const e of es) {
        n++;
        for (const k of Object.keys(e)) if (!ALLOWED.has(k)) keysBad.add(k);
        // No free text: the only long strings allowed are paths and titles.
        for (const [k, v] of Object.entries(e)) if (typeof v === 'string' && v.length > 300 && k !== 'cwd' && k !== 'title') longStrings++;
      }
    } });
  await r.start();
  const ms = performance.now() - t0;
  r.stop();
  const st = r.stats();
  files = st.files;
  console.log(`# full scan: ${files} files, ${(st.bytes / 1e9).toFixed(2)} GB, ${st.lines} lines, ${ms.toFixed(0)} ms, bad ${st.bad}`);
  assert.ok(n > 0);
  assert.equal(st.bad, 0);
  assert.deepEqual([...keysBad], []);
  assert.equal(longStrings, 0);
  assert.ok(ms < 60000, `first scan took ${ms} ms`);
});
