// node --test tests/api.test.mjs
// A real HTTP server on 127.0.0.1 (random port) with the real security, store
// (temp folder), api and diag, and a small in-memory model double. Never
// touches ~/.claude or cosmos/cache.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecurity } from '../server/security.mjs';
import { createStore } from '../server/store.mjs';
import { createApi } from '../server/api.mjs';
import { createDiag, buildErrorText, markLine } from '../server/diag.mjs';
import { createClaudeSettings } from '../server/claude-settings.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmos-api-'));
const T = Date.now() / 1000 - 30;
let server; let port; let security; let store; let api; let model; let claudeHome;

function rec(id, mode, extra = {}) {
  return {
    v: 1, id, title: `t-${id}`, arm: { key: '/p/a', name: 'a' }, times: { bornAt: T - 100, lastActivity: T, endedAt: null },
    live: true, state: { mode, sub: mode === 'needs-me' ? 'approve' : null, badges: [], remnant: null, since: T, tool: null, target: null, idleFor: 0, k: 1 },
    files: Array.from({ length: 30 }, (_, i) => ({ id: `f:${i}`, path: `${i}`, folder: 'd:', edits: 1, reads: 0, lastT: T, plan: false })),
    folders: [], hourly: [[0, 1]], tokens: { total: 5 }, ...extra,
  };
}

function makeModel() {
  const recs = new Map([['S1', rec('S1', 'working')]]);
  const evs = new Map();
  return {
    recs, evs,
    sessions: () => recs, get: (sid) => recs.get(sid) ?? null,
    recent: () => ({ errors: [], toolCalls: [], subagents: [] }),
    totals: () => ({ day: 'today', byMode: { 'needs-me': 0, 'my-move': 0, working: 1, idle: 0, dead: 0, crashed: 0 }, live: 1, sessions: 1, remnants: 0,
      tokensToday: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }, errorsToday: 0, denialsToday: 0, stormsToday: 0, compactionsToday: 0, shipsToday: 0 }),
    event: (id) => evs.get(id) ?? null,
    setSettings() {}, setLimits() {},
    readLine: async (src) => src?.line ?? null,
  };
}

function req(method, p, { headers = {}, body, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const all = { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: all }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: raw ? null : json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const good = () => ({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Cosmos-Token': security.token });

/** Open an SSE stream; returns { events: [{event,data,id}], close(), waitFor(pred) }. */
function sse(headers = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const r = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const e = {};
          for (const line of block.split('\n')) {
            const k = line.slice(0, line.indexOf(':')); const v = line.slice(line.indexOf(':') + 2);
            if (k === 'data') e.data = JSON.parse(v); else e[k] = v;
          }
          events.push(e);
          for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
        }
      });
      resolve({
        events, status: res.statusCode, headers: res.headers,
        close: () => r.destroy(),
        waitFor: (pred, ms = 2000) => new Promise((res2, rej2) => {
          const hit = events.find(pred); if (hit) { res2(hit); return; }
          const w = { pred, resolve: res2 }; waiters.push(w);
          setTimeout(() => rej2(new Error('timeout waiting for SSE event')), ms).unref();
        }),
      });
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  claudeHome = path.join(tmp, '.claude');
  fs.mkdirSync(claudeHome);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
  server = http.createServer(async (rq, rs) => {
    const url = new URL(rq.url, 'http://127.0.0.1');
    if (!security.hostOk(rq)) { rs.writeHead(403); rs.end(); return; }
    if (!(await api.handle(rq, rs, url))) { rs.writeHead(404); rs.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  security = createSecurity({ port });
  store = createStore({ cacheDir: path.join(tmp, 'cache'), claudeHome });
  model = makeModel();
  let apiRef = null;
  const diag = createDiag({ model, store, settings: () => apiRef.settings(), cacheDir: path.join(tmp, 'cache'), cosmosRoot: tmp, claudeBin: '/nonexistent/claude' });
  api = createApi({ model, store, security, diag,
    claudeSettings: createClaudeSettings({ claudeHome, cosmosRoot: tmp, backupDir: path.join(tmp, 'cache', 'backups') }),
    settingsPath: path.join(tmp, 'settings.json'), limitsPath: path.join(tmp, 'limits.json'), root: tmp, port });
  apiRef = api;
});

after(async () => {
  api.close();
  await store.flush();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('POST guards: token, Origin, Host, content type', async () => {
  const body = { settings: { labels: { density: 'dense' } } };
  assert.equal((await req('POST', '/api/settings', { body, headers: { ...good(), 'X-Cosmos-Token': undefined } })).status, 403, 'no token');
  assert.equal((await req('POST', '/api/settings', { body, headers: { ...good(), 'X-Cosmos-Token': 'x'.repeat(43) } })).status, 403, 'wrong token');
  assert.equal((await req('POST', '/api/settings', { body, headers: { ...good(), Origin: 'http://evil.example' } })).status, 403, 'wrong Origin');
  assert.equal((await req('POST', '/api/settings', { body, headers: { ...good(), Origin: undefined } })).status, 403, 'no Origin');
  assert.equal((await req('POST', '/api/settings', { body, headers: { ...good(), Host: 'evil.example' } })).status, 403, 'wrong Host');
  assert.equal((await req('POST', '/api/settings', { body: 'a=1', headers: { ...good(), 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403, 'form');
  assert.equal((await req('POST', '/api/settings', { body: 'a=1', headers: { ...good(), 'Content-Type': 'text/plain' } })).status, 403, 'text/plain');
  const ok = await req('POST', '/api/settings', { body, headers: good() });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.labels.density, 'dense');
  assert.equal(ok.headers['access-control-allow-origin'], undefined, 'never CORS');
  assert.equal((await req('OPTIONS', '/api/settings', { headers: { Origin: 'http://evil.example' } })).status, 405);
  const big = { settings: { arms: { ['/'.repeat(10)]: { name: 'x'.repeat(70000) } } } };
  assert.equal((await req('POST', '/api/settings', { body: big, headers: good() })).status, 413);
});

test('settings: invalid saves nothing; valid writes settings.json', async () => {
  const bad = await req('POST', '/api/settings', { body: { settings: { storm: { count: 'many' } } }, headers: good() });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.length >= 1);
  const ok = await req('POST', '/api/settings', { body: { settings: { notify: { needs: false } } }, headers: good() });
  assert.equal(ok.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  assert.equal(saved.notify.needs, false);
  const g = await req('GET', '/api/settings');
  assert.equal(g.json.settings.notify.needs, false);
  assert.ok(g.json.defaults);
});

test('viewers: digits-only body, counts SSE connections', async () => {
  const r0 = await req('GET', '/api/viewers');
  assert.equal(r0.text, '{"viewers":0}');
  const s = await sse();
  assert.equal(s.status, 200);
  assert.match(s.headers['content-type'], /text\/event-stream/);
  await s.waitFor((e) => e.event === 'hello');
  assert.equal((await req('GET', '/api/viewers')).text, '{"viewers":1}');
  // A hidden page reports visible:false and stops counting as a viewer.
  const hello = s.events.find((e) => e.event === 'hello');
  const v = await req('POST', '/api/visibility', { headers: good(), body: { cid: hello.data.cid, visible: false } });
  assert.equal(v.status, 200);
  assert.equal((await req('GET', '/api/viewers')).text, '{"viewers":0}');
  await req('POST', '/api/visibility', { headers: good(), body: { cid: hello.data.cid, visible: true } });
  assert.equal((await req('GET', '/api/viewers')).text, '{"viewers":1}');
  s.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await req('GET', '/api/viewers')).text, '{"viewers":0}');
});

test('snapshot while loading, then live SSE: ev with seq, needs-me now, src stripped, resync', async () => {
  const loading = await req('GET', '/api/snapshot');
  assert.equal(loading.json.loading.done, false);
  assert.deepEqual(loading.json.sessions, []);

  // Backfill events (live:false) feed the feed ring but are not pushed.
  api.onEvent({ id: 'born:S1:born', type: 'born', t: T - 100, sid: 'S1', ship: null, live: false, data: {}, src: { f: 'x', off: 0, len: 1, epoch: 0 } });
  const s = await sse();
  await s.waitFor((e) => e.event === 'hello');
  await api.setLoaded();
  await s.waitFor((e) => e.event === 'resync');

  const snap = await req('GET', '/api/snapshot');
  assert.equal(snap.json.loading.done, true);
  assert.equal(snap.json.sessions.length, 1);
  assert.equal(snap.json.sessions[0].files.length, 24);
  assert.equal(snap.json.sessions[0].filesTotal, 30);
  assert.equal(snap.json.sessions[0].hourly, undefined);
  assert.ok(snap.json.sessions[0].place);
  assert.equal(snap.json.events[0].src, undefined);
  assert.equal(snap.json.totals.explain.calls, 0);
  assert.equal(snap.headers['cache-control'], 'no-store');

  const errEv = { id: 'error:S1:tu1', type: 'error', t: T, sid: 'S1', ship: null, live: true,
    data: { kind: 'tool', tool: 'Bash', toolUseId: 'tu1', target: null, recovered: null },
    src: { f: 'p/S1.jsonl', off: 5, len: 10, epoch: 0, line: JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1\nTraceback (most recent call last):\n  File "a.py", line 3, in <module>\nNameError: name x is not defined' }] } }) } };
  model.evs.set(errEv.id, errEv);
  store.appendEvent(errEv);
  api.onEvent(errEv);
  const got = await s.waitFor((e) => e.event === 'ev' && e.data.id === 'error:S1:tu1');
  assert.equal(got.data.src, undefined, 'src never goes on the wire');
  assert.equal(got.id, `${api.runId}:${got.data.seq}`);

  // NEEDS ME: pushed immediately (no 500 ms coalesce).
  const t0 = Date.now();
  model.recs.get('S1').state.mode = 'needs-me';
  api.onChange('S1');
  const ses = await s.waitFor((e) => e.event === 'session' && e.data.state.mode === 'needs-me');
  assert.ok(Date.now() - t0 < 100, 'needs-me went out within 100 ms');
  assert.equal(ses.data.hourly, undefined);
  s.close();

  // Resume: an id inside the ring replays; an id from a previous run resyncs.
  const s2 = await sse({ 'Last-Event-ID': `${api.runId}:${got.data.seq - 1}` });
  await s2.waitFor((e) => e.event === 'ev' && e.data.id === 'error:S1:tu1');
  s2.close();
  const s3 = await sse({ 'Last-Event-ID': '999999' });
  await s3.waitFor((e) => e.event === 'resync');
  s3.close();
  // A previous run's id with a small seq (new seq >= old) must still resync.
  const s4 = await sse({ 'Last-Event-ID': `deadbeef0000:${got.data.seq - 1}` });
  const hello = await s4.waitFor((e) => e.event === 'hello');
  assert.equal(hello.data.runId, api.runId);
  await s4.waitFor((e) => e.event === 'resync');
  s4.close();
  model.recs.get('S1').state.mode = 'working';
});

test('feed: a flood of tool calls never pushes signal events out', async () => {
  const storm = { id: 'storm-start:S1:x', type: 'storm-start', t: T - 50, sid: 'S1', ship: null, live: false, data: {} };
  api.onEvent(storm);
  for (let i = 0; i < 1200; i++) api.onEvent({ id: `tool-call:S1:f${i}`, type: 'tool-call', t: T - 40 + i / 100, sid: 'S1', ship: null, live: false, data: { tool: 'Bash' } });
  const snap = await req('GET', '/api/snapshot');
  const evs = snap.json.events;
  assert.ok(evs.some((e) => e.id === 'storm-start:S1:x'), 'storm kept');
  assert.ok(evs.filter((e) => e.type === 'tool-call').length <= 300, 'routine capped');
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].t >= evs[i - 1].t, 'merged in time order');
});

test('session, history range, diag report and error text', async () => {
  const one = await req('GET', '/api/session/S1');
  assert.equal(one.status, 200);
  assert.equal(one.json.files.length, 30, 'full record');
  assert.ok(Array.isArray(one.json.events));
  assert.ok(one.json.events.every((e) => e.src === undefined));
  assert.equal((await req('GET', '/api/session/nope')).status, 404);
  assert.equal((await req('GET', '/api/session/%E0%A4%A')).status, 400, 'malformed escape is a 400');
  assert.equal((await req('GET', '/api/diag/%ZZ')).status, 400);
  assert.equal((await req('GET', `/api/history?from=${T - 9 * 86400}&to=${T}`)).status, 400);
  assert.equal((await req('GET', '/api/history?from=x&to=1')).status, 400);

  const rep = await req('GET', `/api/diag/${encodeURIComponent('error:S1:tu1')}`);
  assert.equal(rep.status, 200);
  assert.equal(rep.json.canShowError, true);
  assert.match(rep.json.summary, /^Bash failed\./);
  assert.equal(rep.json.event.src, undefined);
  assert.ok(rep.json.explainEstimate.inputTokens > 0);
  assert.equal(rep.json.replay.at, T - 8);

  assert.equal((await req('POST', `/api/diag/${encodeURIComponent('error:S1:tu1')}/error-text`, { body: {} })).status, 403, 'error text needs the token');
  const et = await req('POST', `/api/diag/${encodeURIComponent('error:S1:tu1')}/error-text`, { body: {}, headers: good() });
  assert.equal(et.status, 200);
  assert.equal(et.json.totalLines, 4);
  const kinds = et.json.lines.flatMap((l) => l.marks.map((m) => m.kind));
  assert.ok(kinds.includes('exit-code') && kinds.includes('file-line') && kinds.includes('error-type'));
  assert.ok(et.json.gloss.some((g) => g.kind === 'exit-code'));

  const noConfirm = await req('POST', `/api/diag/${encodeURIComponent('error:S1:tu1')}/explain`, { body: {}, headers: good() });
  assert.equal(noConfirm.status, 400);
  const noCli = await req('POST', `/api/diag/${encodeURIComponent('error:S1:tu1')}/explain`, { body: { confirm: true }, headers: good() });
  assert.equal(noCli.status, 503, 'a missing claude CLI is a clean 503');
  assert.equal((await req('GET', '/api/diag/nope:x:y')).status, 404);
});

test('claude settings endpoints against a temp file', async () => {
  const g = await req('GET', '/api/claude-settings');
  assert.deepEqual(g.json, { cleanupPeriodDays: null, path: path.join(claudeHome, 'settings.json') });
  const p = await req('GET', '/api/claude-settings/preview?change=cleanupPeriodDays&value=90');
  assert.equal(p.status, 200);
  assert.ok(p.json.diff.some((d) => d.op === '+' && d.line.includes('"cleanupPeriodDays": 90')));
  assert.equal((await req('GET', '/api/claude-settings/preview?change=theme&value=x')).status, 400);
  const noTok = await req('POST', '/api/claude-settings/apply', { body: { change: 'cleanupPeriodDays', value: 90, expectHash: p.json.hash } });
  assert.equal(noTok.status, 403);
  const a = await req('POST', '/api/claude-settings/apply', { body: { change: 'cleanupPeriodDays', value: 90, expectHash: p.json.hash }, headers: good() });
  assert.equal(a.status, 200);
  assert.equal(a.json.after.cleanupPeriodDays, 90);
  assert.ok(a.json.backupPath.startsWith(path.join(tmp, 'cache', 'backups')));
  const again = await req('POST', '/api/claude-settings/apply', { body: { change: 'cleanupPeriodDays', value: 91, expectHash: p.json.hash }, headers: good() });
  assert.equal(again.status, 409, 'stale hash');
});

test('token injection', () => {
  const html = security.injectToken('<meta name="cosmos-token" content="__COSMOS_TOKEN__">');
  assert.ok(html.includes(security.token));
  assert.ok(!html.includes('__COSMOS_TOKEN__'));
  assert.match(security.token, /^[A-Za-z0-9_-]{43}$/);
});

test('error text helpers', () => {
  const e = buildErrorText(Array.from({ length: 40 }, (_, i) => (i === 7 ? 'TypeError: x is not a function' : `line ${i}`)).join('\n'));
  assert.equal(e.lines.length, 12);
  assert.equal(e.truncated, true);
  assert.equal(e.totalLines, 40);
  assert.ok(e.lines.some((l) => l.text.startsWith('TypeError')), 'error-type lines are kept even outside the tail');
  assert.deepEqual(markLine('src/a.js:12:3 failed').map((m) => m.kind), ['file-line', 'message']);
  const long = buildErrorText('x'.repeat(5000));
  assert.equal(long.lines[0].text.length, 2000);
});
