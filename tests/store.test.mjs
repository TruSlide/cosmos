// node --test tests/store.test.mjs   (temp folders only; never touches ~/.claude or cosmos/cache)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, localDay, liteRecord } from '../server/store.mjs';
import { SETTINGS_DEFAULTS, validateSettings, validateLimits } from '../web/src/shared/settings.mjs';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cosmos-store-')); }
const T0 = new Date(2026, 9, 20, 12, 0, 0).getTime() / 1000;   // local noon, 20 Oct 2026

function ev(type, sid, key, t, data = {}, extra = {}) {
  return { id: `${type}:${sid}:${key}`, type, t, sid, ship: null, live: false, data, ...extra };
}

test('event log: append, dedupe by id+payload, local-day files, no seq', async () => {
  const dir = tmpDir();
  const s = createStore({ cacheDir: dir, claudeHome: dir });
  const e1 = ev('tool-call', 'S1', 'tu1', T0, { tool: 'Bash', ok: null }, { seq: 5, src: { f: 'a/b.jsonl', off: 10, len: 20, epoch: 0 } });
  assert.equal(s.appendEvent(e1), true);
  assert.equal(s.appendEvent({ ...e1, live: true, seq: 9 }), false, 'same payload is a duplicate even if live/seq differ');
  assert.equal(s.appendEvent({ ...e1, data: { tool: 'Bash', ok: true } }), true, 'a re-emit with a resolved field is appended');
  await s.flushEvents();
  const file = path.join(dir, 'events', `${localDay(T0)}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].seq, undefined, 'seq is per run and never logged');
  assert.deepEqual(lines[0].src, e1.src, 'src is kept in the log for diagnostics');

  assert.equal(s.appendEvent(ev('dead', 'S1', '0', 86400)), false, 'epoch-zero times are never logged');
  // A fresh store (restart) still dedupes against the file.
  const s2 = createStore({ cacheDir: dir, claudeHome: dir });
  assert.equal(s2.appendEvent({ ...e1, data: { tool: 'Bash', ok: true } }), false);
  await s2.flush(); await s.flush();
});

test('readEvents collapses re-emits (last wins), sorts by t, filters range; findEvent', async () => {
  const dir = tmpDir();
  const s = createStore({ cacheDir: dir, claudeHome: dir });
  s.appendEvent(ev('error', 'S1', 'tu2', T0 + 5, { kind: 'tool', recovered: null }));
  s.appendEvent(ev('born', 'S1', 'born', T0, {}));
  s.appendEvent(ev('error', 'S1', 'tu2', T0 + 5, { kind: 'tool', recovered: true }));
  s.appendEvent(ev('born', 'S2', 'born', T0 + 86400 * 2, {}));
  const got = [];
  for await (const e of s.readEvents(T0 - 1, T0 + 10)) got.push(e);
  assert.deepEqual(got.map((e) => e.type), ['born', 'error']);
  assert.equal(got[1].data.recovered, true);
  const f = await s.findEvent('born:S2:born');
  assert.equal(f.sid, 'S2');
  assert.equal(await s.findEvent('born:nope:born'), null);
  await s.flush();
});

test('snapshots: debounced write, flush, remnant marking on load', async () => {
  const dir = tmpDir();
  const s = createStore({ cacheDir: dir, claudeHome: dir, snapshotDebounceMs: 60000 });
  const rec = { id: 'S1', times: { bornAt: T0, lastActivity: T0 + 10 }, state: { mode: 'idle', sub: null, remnant: null }, live: false, arm: { key: '/p', name: 'p' } };
  s.saveSnapshot(rec);
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'S1.json')), false, 'debounced');
  rec.title = 'later title';
  await s.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'S1.json'), 'utf8'));
  assert.equal(saved.title, 'later title', 'the latest state is written');

  const gone = s.loadSnapshots({ transcriptExists: () => false }).get('S1');
  assert.equal(gone.cacheOnly, true);
  assert.equal(gone.state.remnant, 'aged-out');
  assert.equal(gone.state.mode, 'dead');
  const here = s.loadSnapshots({ transcriptExists: () => true }).get('S1');
  assert.equal(here.state.mode, 'idle');
  assert.equal(s.isCacheOnly('S1', Date.now() / 1000 - 61 * 86400), true);
  assert.equal(s.isCacheOnly('S1', Date.now() / 1000 - 59 * 86400), false);
});

test('layout: provisional places, commit in birth order, stable across restarts', async () => {
  const dir = tmpDir();
  const s = createStore({ cacheDir: dir, claudeHome: dir });
  const arm = { key: '/Users/x/Projects/a', name: 'a' };
  const late = { id: 'L', arm, times: { bornAt: T0 + 100 } };
  const early = { id: 'E', arm, times: { bornAt: T0 } };
  const wt1 = { id: 'W1', arm, worktree: { name: 'feat' }, times: { bornAt: T0 + 50 } };
  s.place(late); s.place(wt1);
  const pe = s.place(early);
  assert.equal(pe.idx, 0, 'provisional rank follows bornAt');
  s.commitLayout();
  assert.deepEqual([s.place(early).idx, s.place(wt1).idx, s.place(late).idx], [0, 1, 2]);
  assert.equal(s.place(wt1).cluster, 'feat');
  assert.equal(s.place(wt1).clusterIdx, 0);
  const newer = { id: 'N', arm, times: { bornAt: T0 - 999 } };
  assert.equal(s.place(newer).idx, 3, 'after commit, a new session takes the next idx even if older');
  const slot = s.place(early).slot;
  assert.ok(slot >= 0 && slot < 12);
  await s.flush();
  const s2 = createStore({ cacheDir: dir, claudeHome: dir });
  s2.commitLayout();
  assert.deepEqual(s2.place(early), s.place(early), 'same place after restart');
  assert.equal(s2.place({ id: 'Z', arm, times: { bornAt: T0 } }).idx, 4);
  // Twelve arms take twelve different slots.
  const slots = new Set();
  for (let i = 0; i < 12; i++) slots.add(s2.place({ id: `A${i}`, arm: { key: `/arm/${i}`, name: `${i}` }, times: { bornAt: T0 } }).slot);
  assert.ok(slots.size >= 11, 'arms spread over the slots (the existing arm holds one)');
  // Owner override wins.
  s2.setSettings(validateSettings({ arms: { [arm.key]: { slot: 7 } } }).value);
  assert.equal(s2.place(early).slot, 7);
  await s2.flush();
});

test('explain usage running total and launch-config', async () => {
  const dir = tmpDir();
  const s = createStore({ cacheDir: dir, claudeHome: dir });
  s.addExplainUsage({ t: T0, eventId: 'error:S:x', model: 'claude-haiku', usage: { input: 10, output: 20, cacheRead: 100, cacheCreate: 5, total: 35 } });
  const u = s.addExplainUsage({ t: T0 + 1, eventId: 'error:S:y', model: 'claude-haiku', usage: { input: 1, output: 2, cacheRead: 0, cacheCreate: 0, total: 3 } });
  assert.equal(u.calls, 2);
  assert.equal(u.tokens.total, 38);
  assert.equal(u.log.length, 2);
  await s.flush();
  const s2 = createStore({ cacheDir: dir, claudeHome: dir });
  assert.equal(s2.explainUsage().tokens.cacheRead, 100);
  await s.writeLaunchConfig({ enabled: false, entrypoints: ['cli'] });
  assert.equal(fs.readFileSync(path.join(dir, 'launch-config'), 'utf8'), 'enabled=0\nentrypoints=cli\n');
});

test('history folds the log into base and returns the range', async () => {
  const dir = tmpDir();
  const fold = {
    recordFromBorn: (e) => ({ id: e.sid, arm: { key: '/p', name: 'p' }, times: { bornAt: e.t, lastActivity: e.t }, state: { mode: 'working' }, n: 0, files: [], folders: [] }),
    applyEvent: (r, e) => { r.n++; r.times.lastActivity = e.t; if (e.type === 'my-move') r.state.mode = 'my-move'; return r; },
    advance: (r, now) => { r.advancedTo = now; return r; },
  };
  const s = createStore({ cacheDir: dir, claudeHome: dir, fold });
  s.appendEvent(ev('born', 'S1', 'born', T0 - 3 * 86400));
  s.appendEvent(ev('tool-call', 'S1', 'a', T0 - 2 * 86400, { tool: 'Read' }));
  s.appendEvent(ev('my-move', 'S1', 'b', T0 - 100));
  s.appendEvent(ev('tool-call', 'S1', 'c', T0 + 10, { tool: 'Bash' }, { src: { f: 'x', off: 1, len: 2, epoch: 0 } }));
  s.appendEvent(ev('born', 'S2', 'born', T0 + 20));
  const h = await s.history(T0, T0 + 3600, SETTINGS_DEFAULTS);
  assert.deepEqual(h.base.map((r) => r.id), ['S1']);
  assert.equal(h.base[0].n, 2);
  assert.equal(h.base[0].state.mode, 'my-move');
  assert.equal(h.base[0].advancedTo, T0);
  assert.ok(h.base[0].place, 'base records carry their place');
  assert.deepEqual(h.events.map((e) => e.id), ['tool-call:S1:c', 'born:S2:born']);
  assert.equal(h.events[0].src, undefined, 'src never leaves the server');
  // Second call reuses a keyframe and agrees.
  const h2 = await s.history(T0, T0 + 3600, SETTINGS_DEFAULTS);
  assert.deepEqual(h2.base, h.base);
  await s.flush();
});

test('liteRecord cuts files and folders to 24 and drops hourly', () => {
  const rec = { id: 'S', files: Array.from({ length: 30 }, (_, i) => ({ id: `f${i}` })), folders: [{ id: 'd' }], hourly: [[1, 2]] };
  const l = liteRecord(rec);
  assert.equal(l.files.length, 24);
  assert.equal(l.filesTotal, 30);
  assert.equal(l.foldersTotal, 1);
  assert.equal(l.hourly, undefined);
  assert.equal(rec.files.length, 30, 'the original is untouched');
});

test('settings validation: unknown keys, ranges, arms, limits', () => {
  const { value, errors } = validateSettings({ storm: { count: 5, windowS: 'x' }, bogus: 1, render: { quality: 'ultra' } });
  assert.equal(value.storm.count, 5);
  assert.equal(value.storm.windowS, 20);
  assert.equal(value.render.quality, 'high');
  assert.equal(errors.length, 3);
  const a = validateSettings({ arms: { '/a': { slot: 3, name: 'A' }, '/b': { slot: 3 } } });
  assert.ok(a.errors.some((e) => e.includes('slot 3')));
  assert.equal(validateSettings({ idle: { kMin: 2, kMax: 1 } }).errors.length, 1);
  assert.equal(validateLimits({ default: 200000, rules: [{ match: 'claude-*', limit: 1000000 }] }).errors.length, 0);
  assert.ok(validateLimits({ default: 5, rules: [] }).errors.length > 0);
  assert.equal(Object.isFrozen(SETTINGS_DEFAULTS.storm), true);
});
