// Client store (GALAXY_CONTRACT §4, §11 INTEGRATOR): the adapter output passes
// Gate 1's normalizeState for every mode, idleFor follows the shared curve,
// urgency order, needs-me transitions, POST token header, history fold/seek.
// Fake fetch and EventSource; no server, no network.
//
//   node --test tests/client-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientStore } from '../web/src/galaxy/store.js';
import { normalizeState } from '../web/src/lib/state.js';
import { idleFraction } from '../web/src/shared/schema.mjs';
import { SETTINGS_DEFAULTS } from '../web/src/shared/settings.mjs';

const NOW = 1_800_000_000;
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function rec(n, mode, extra = {}) {
  return {
    v: 1, id: sid(n), title: `s${n}`, titleSource: 's6-user', origin: 'owner', forkOf: null, spawnedFrom: null, entrypoint: 'cli',
    arm: { key: '/p/proj', name: 'proj' }, worktree: null, cwd: '/p/proj', place: { slot: 2, idx: n, cluster: null, clusterIdx: 0 },
    model: 'claude-opus-5-5', models: ['claude-opus-5-5'], live: true, cacheOnly: false,
    times: { bornAt: NOW - 3600, lastActivity: NOW - 600, endedAt: null },
    state: { mode, sub: mode === 'needs-me' ? 'question' : null, badges: [], remnant: null, since: NOW - 60 * n, tool: null, target: null, idleFor: 0, k: 1 },
    asOf: NOW, activity: 0.3,
    tokens: { input: 1, output: 2, cacheCreate: 3, cacheRead: 4, total: 6, today: 6 },
    context: { fill: 0.4, used: 400, limit: 1000, peak: 400, model: 'claude-opus-5-5' },
    counts: { turns: 1, toolCalls: 2, errors: 1, denials: 0, apiErrors: 0, storms: 0, compactions: 1, ships: 1, errorsToday: 1 },
    storm: null,
    compactions: [{ id: 'c1', t: NOW - 900, trigger: 'auto', preTokens: 900, postTokens: 100, durationMs: 1 }],
    ships: [{ id: 'a1', t: NOW - 30, endT: null, type: 'Explore', label: 'explore', model: null, tokens: 5, active: true, toolUseId: 'tu', depth: 1, workflowPhase: null }],
    files: [{ id: 'f:web/a.js', path: 'web/a.js', folder: 'd:web', edits: 2, reads: 1, lastT: NOW - 700, plan: false }],
    folders: [{ id: 'd:web', path: 'web', edits: 2, reads: 1, files: 1, lastT: NOW - 700 }],
    ...extra,
  };
}

class FakeES {
  constructor(url) { this.url = url; this.readyState = 1; this.l = new Map(); FakeES.last = this; queueMicrotask(() => this.fire('hello', { serverTime: NOW, seq: 1, viewers: 1 })); }
  addEventListener(t, fn) { (this.l.get(t) || this.l.set(t, []).get(t)).push(fn); }
  fire(t, data) { for (const fn of this.l.get(t) || []) fn({ data: JSON.stringify(data) }); }
  close() { this.readyState = 2; }
}

function setup({ sessions, history } = {}) {
  const calls = [];
  const snap = {
    v: 1, serverTime: NOW, seq: 1, settings: SETTINGS_DEFAULTS, limits: {}, loading: { done: true },
    totals: { byMode: {}, live: 0, sessions: 0, tokensToday: { total: 0 } },
    sessions: sessions || [rec(1, 'needs-me'), rec(2, 'working'), rec(3, 'my-move'), rec(4, 'idle'), rec(5, 'dead'), rec(6, 'crashed'),
      rec(7, 'dead', { cacheOnly: true, live: false, state: { mode: 'dead', sub: null, badges: [], remnant: 'aged-out', since: 0, tool: null, target: null, idleFor: 1, k: 1 } })],
    recent: { [sid(2)]: { errors: [{ id: 'e1', t: NOW - 5, tool: 'Bash' }], toolCalls: [{ id: 'tu9', t: NOW - 2, tool: 'Edit', target: 'f:web/a.js', ok: true }], subagents: [] } },
    events: [],
  };
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    let body = snap;
    if (url.startsWith('/api/history')) body = history;
    else if (opts.method === 'POST') body = { ok: true };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  let wall = NOW;
  const store = createClientStore({ token: 'TOKEN123', fetchImpl, EventSourceImpl: FakeES, wallClock: () => wall });
  return { store, calls, setWall: (w) => { wall = w; } };
}

test('adapter output passes normalizeState for every mode; dead and husks map to idle 1', async () => {
  const { store } = setup();
  await store.ready;
  const out = {};
  for (const [id] of store.sessions) {
    for (const grain of ['file', 'folder']) {
      const st = store.systemState(id, { fileGrain: grain }, out);
      const n = normalizeState(st);
      assert.equal(n.id, id);
    }
  }
  assert.equal(store.systemState(sid(5), null, {}).mode, 'idle');
  assert.equal(store.systemState(sid(5), null, {}).idleFor, 1);
  assert.equal(store.systemState(sid(7), null, {}).idleFor, 1);
  assert.equal(store.systemState(sid(1), null, {}).needsKind, 'question');
  assert.equal(store.systemState(sid(2), null, {}).idleFor, 0);
  const w = store.systemState(sid(2), { fileGrain: 'folder' }, {});
  assert.equal(w.errors.length, 1);
  assert.equal(w.toolCalls[0].target, 'd:web');            // folder grain retargets tool calls
  assert.equal(w.files[0].id, 'd:web');
  assert.equal(w.compactions[0].tokensBefore, 900);
  assert.equal(w.subagents[0].id, 'a1');
  assert.equal(w.bornAt, null);                             // older than 4 s: no white hole
  // Reuses arrays on `out` (no per-call allocation of the lists).
  const o = {};
  store.systemState(sid(2), { fileGrain: 'file' }, o);
  const arr = o.errors;
  store.systemState(sid(2), { fileGrain: 'file' }, o);
  assert.equal(o.errors, arr);
});

test('idleFor follows the shared curve; urgency puts needs-me first', async () => {
  const { store } = setup();
  await store.ready;
  const r = store.get(sid(3));
  assert.ok(Math.abs(store.idleFor(r) - idleFraction(600, 1, 86400)) < 1e-3);
  assert.equal(store.idleFor(store.get(sid(2))), 0);
  assert.equal(store.idleFor(store.get(sid(5))), 1);
  const order = store.byUrgency();
  assert.equal(order[0], sid(1));
  assert.equal(order[1], sid(2));
  assert.deepEqual(store.needsMe(), [sid(1)]);
  assert.equal(store.arms.get('/p/proj').slot, 2);
  assert.equal(store.arms.get('/p/proj').sessionIds.length, 7);
});

test('SSE: session update fires needs-me enter/leave; events update recent; POST carries the token', async () => {
  const { store, calls } = setup();
  await store.ready;
  assert.equal(store.connection, 'live');
  const seen = [];
  store.on('needs-me', (e) => seen.push(e));
  FakeES.last.fire('session', rec(2, 'needs-me'));
  FakeES.last.fire('session', rec(1, 'working'));
  assert.deepEqual(seen.map((e) => [e.sid, e.entered]), [[sid(2), true], [sid(1), false]]);
  FakeES.last.fire('ev', { id: `error:${sid(3)}:tuX`, type: 'error', t: NOW - 1, sid: sid(3), ship: null, live: true, data: { kind: 'tool', tool: 'Read' } });
  assert.equal(store.recent(sid(3)).errors[0].id, 'tuX');
  assert.equal(store.events.at(-1).type, 'error');
  await store.errorText(`error:${sid(3)}:tuX`);
  const post = calls.find((c) => c.opts.method === 'POST');
  assert.equal(post.opts.headers['X-Cosmos-Token'], 'TOKEN123');
  assert.equal(post.opts.headers['Content-Type'], 'application/json');
  store.dispose();
});

test('history: fold at the cursor, seek forward and back, exit restores live', async () => {
  const born = { id: `born:${sid(9)}:born`, type: 'born', t: NOW - 500, sid: sid(9), ship: null, data: { origin: 'owner', arm: '/p/proj', entrypoint: 'cli' } };
  const metrics = (t, total, mode) => ({ id: `metrics:${sid(9)}:${t}`, type: 'metrics', t, sid: sid(9), ship: null, data: { tokens: { input: 0, output: total, cacheCreate: 0, cacheRead: 0, total }, contextFill: 0.1, contextUsed: 1, contextLimit: 10, activity: 0, mode, sub: null, badges: [], idleFor: 0, k: 1 } });
  const history = {
    from: NOW - 1000, to: NOW, truncated: false, base: [rec(1, 'my-move')],
    events: [born, metrics(NOW - 400, 10, 'working'),
      { id: `needs-me-start:${sid(9)}:1`, type: 'needs-me-start', t: NOW - 300, sid: sid(9), ship: null, data: { sub: 'approve' } },
      metrics(NOW - 200, 50, 'my-move')],
  };
  const { store } = setup({ history });
  await store.ready;
  const needs = [];
  store.on('needs-me', (e) => needs.push(e));
  await store.enterHistory(NOW - 1000, NOW);
  assert.equal(store.time.mode, 'history');
  assert.equal(store.get(sid(9)), null);                       // not born yet
  assert.equal(store.get(sid(1)).title, 's1');                 // identity overlay from the live record
  store.setCursor(NOW - 250);
  assert.equal(store.get(sid(9)).state.mode, 'needs-me');
  assert.equal(store.get(sid(9)).tokens.total, 10);
  assert.ok(needs.some((e) => e.sid === sid(9) && e.entered));
  store.setCursor(NOW);
  assert.equal(store.get(sid(9)).tokens.total, 50);
  store.setCursor(NOW - 450);                                  // backwards: refold from base
  assert.equal(store.get(sid(9)).tokens.total, 0);
  assert.equal(store.get(sid(9)).state.mode, 'working');
  assert.equal(store.historyEvents().length, 4);
  assert.ok(!('_fold' in store.get(sid(9))));
  store.exitHistory();
  assert.equal(store.time.mode, 'live');
  assert.equal(store.get(sid(9)), null);
  assert.equal(store.sessions.size, 7);
  store.dispose();
});

test('live feed: tool-call floods never push signal events out; a new server run is detected', async () => {
  const { store, calls } = setup();
  await store.ready;
  const es = FakeES.last;
  es.fire('ev', { id: 'storm-start:x:1', type: 'storm-start', t: NOW - 100, sid: sid(2), ship: null, live: true, data: {} });
  for (let i = 0; i < 2000; i++) es.fire('ev', { id: `tool-call:x:${i}`, type: 'tool-call', t: NOW - 90 + i / 100, sid: sid(2), ship: null, live: true, data: { tool: 'Bash' } });
  assert.ok(store.events.some((e) => e.id === 'storm-start:x:1'), 'storm kept');
  assert.ok(store.events.filter((e) => e.type === 'tool-call').length <= 500);

  // Reconnect to the same run: snapshot refetched, no restart notice.
  const snaps0 = calls.filter((c) => c.url === '/api/snapshot').length;
  let restarted = 0;
  store.on('restarted', () => { restarted++; });
  es.fire('hello', { serverTime: NOW, seq: 1, runId: 'run-a', cid: 'run-a-1' });
  es.fire('hello', { serverTime: NOW, seq: 1, runId: 'run-a', cid: 'run-a-2' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.filter((c) => c.url === '/api/snapshot').length > snaps0, 'reconnect refetches the snapshot');
  assert.equal(restarted, 0);
  // A different run id: the server restarted, saving needs a reload.
  es.fire('hello', { serverTime: NOW, seq: 1, runId: 'run-b', cid: 'run-b-1' });
  assert.equal(restarted, 1);
  assert.equal(store.restarted, true);
});
