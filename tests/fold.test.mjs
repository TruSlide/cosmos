// Fold contract (GALAXY_CONTRACT §2.5): the shared reducer rebuilds records
// from events. Synthetic cases always; the real-data case (read-only, this
// Mac's ~/.claude) folds every session's emitted events from `born` and
// compares mode, tokens.total (exact) and context.fill (±0.01) with the model.
//
//   node --test tests/fold.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordFromBorn, applyEvent, advance } from '../web/src/shared/fold.mjs';
import { SETTINGS_DEFAULTS } from '../web/src/shared/settings.mjs';
import { createModel } from '../server/model.mjs';

const S = SETTINGS_DEFAULTS;
const SID = '00000000-0000-4000-8000-000000000001';
const ev = (type, t, key, data = {}, extra = {}) => ({ id: `${type}:${SID}:${key}`, type, t, sid: SID, ship: null, live: false, data, ...extra });

test('born → working → needs-me → answered → my-move → idle → dead', () => {
  const r = recordFromBorn(ev('born', 1000, 'born', { origin: 'owner', arm: '/a/proj', worktree: null, entrypoint: 'cli', forkOf: null }));
  assert.equal(r.arm.key, '/a/proj');
  assert.equal(r.arm.name, 'proj');
  applyEvent(r, ev('working', 1001, '1001000', { sub: 'generating', tool: null }), S);
  applyEvent(r, ev('needs-me-start', 1010, '1010000', { sub: 'approve', source: 'registry', tool: 'Bash' }), S);
  assert.equal(r.state.mode, 'needs-me');
  assert.equal(r.state.since, 1010);
  applyEvent(r, ev('needs-me-end', 1020, '1010000', { sub: 'approve', waitedS: 10, how: 'answered' }), S);
  assert.equal(r.state.mode, 'working');
  applyEvent(r, ev('my-move', 1030, '1030000', { badges: [] }), S);
  advance(r, 1030 + 3600, S);
  assert.equal(r.state.mode, 'my-move');
  assert.ok(r.state.idleFor > 0 && r.state.idleFor < 1);
  advance(r, 1030 + 86400 + 1, S);
  assert.equal(r.state.mode, 'dead');
  assert.equal(r.state.idleFor, 1);
});

test('re-emits (same id) do not double count; metrics carry numbers', () => {
  const r = recordFromBorn(ev('born', 0, 'born', { arm: '/a/b' }));
  const call = ev('tool-call', 5, 'tu1', { tool: 'Edit', target: 'f:x/y.js', toolUseId: 'tu1', ok: null, durationMs: null });
  applyEvent(r, call, S);
  applyEvent(r, { ...call, data: { ...call.data, ok: true, durationMs: 4 } }, S);
  assert.equal(r.counts.toolCalls, 1);
  const err = ev('error', 6, 'tu2', { kind: 'tool', tool: 'Bash', recovered: null });
  applyEvent(r, err, S);
  applyEvent(r, { ...err, data: { ...err.data, recovered: true } }, S);
  assert.equal(r.counts.errors, 1);
  applyEvent(r, ev('file-touch', 7, 'tu1', { fileId: 'f:x/y.js', path: 'x/y.js', folder: 'd:x', op: 'edit', plan: false }), S);
  assert.equal(r.files[0].edits, 1);
  assert.equal(r.folders[0].id, 'd:x');
  applyEvent(r, ev('metrics', 8, '8', { tokens: { input: 1, output: 2, cacheCreate: 3, cacheRead: 9, total: 6 }, contextFill: 0.25, contextUsed: 250, contextLimit: 1000, activity: 0.5, mode: 'working', sub: 'tool', badges: [], idleFor: 0, k: 1.2 }), S);
  assert.equal(r.tokens.total, 6);
  assert.equal(r.context.fill, 0.25);
  assert.equal(r.state.k, 1.2);
  applyEvent(r, ev('compaction', 9, 'uuid-1', { trigger: 'auto', preTokens: 100, postTokens: 10 }), S);
  assert.equal(r.compactions.length, 1);
  assert.equal(r.compactions[0].id, 'uuid-1');
});

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const REAL = fs.existsSync(PROJECTS);

test('real: folding each session\'s events reproduces mode, tokens.total and context.fill', { skip: !REAL, timeout: 120000 }, async () => {
  const events = [];
  const m = createModel({ limitsPath: null, tick: false, watch: false, pollMs: 600000, onEvent: (e) => events.push(e) });
  await m.start();
  m.stop();
  const recs = m.sessions();
  // Collapse re-emits like the history bundle: last copy of each id wins, in time order.
  const byId = new Map();
  for (const e of events) byId.set(e.id, e);
  const list = [...byId.values()].sort((a, b) => a.t - b.t);
  const folded = new Map();
  for (const e of list) {
    if (e.type === 'born') { if (!folded.has(e.sid)) folded.set(e.sid, recordFromBorn(e)); continue; }
    const r = folded.get(e.sid);
    if (r) applyEvent(r, e, S);
  }
  let checked = 0;
  const bad = [];
  for (const [sid, rec] of recs) {
    if (rec.cacheOnly) continue;
    const f = folded.get(sid);
    if (!f) { bad.push(`${sid.slice(0, 8)}: no born event`); continue; }
    advance(f, rec.asOf, S);
    checked++;
    if (f.state.mode !== rec.state.mode) bad.push(`${sid.slice(0, 8)}: mode ${f.state.mode} vs ${rec.state.mode}`);
    if (f.tokens.total !== rec.tokens.total) bad.push(`${sid.slice(0, 8)}: tokens ${f.tokens.total} vs ${rec.tokens.total}`);
    if (Math.abs((f.context.fill ?? 0) - (rec.context.fill ?? 0)) > 0.01) bad.push(`${sid.slice(0, 8)}: fill ${f.context.fill} vs ${rec.context.fill}`);
  }
  assert.ok(checked >= 5, `only ${checked} sessions to check`);
  assert.deepEqual(bad, [], `${bad.length} of ${checked} sessions differ`);
});
