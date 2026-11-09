// node --test tests/claude-settings.test.mjs
// Runs ONLY against temp copies. The real ~/.claude/settings.json is read once
// (to copy it) and its hash is checked unchanged at the end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClaudeSettings, lineDiff } from '../server/claude-settings.mjs';

const REAL = path.join(os.homedir(), '.claude', 'settings.json');
const realHashBefore = fs.existsSync(REAL) ? crypto.createHash('sha256').update(fs.readFileSync(REAL)).digest('hex') : null;
const HOME = '/Users/tester';
const ROOT = `${HOME}/Projects/Side Projects/cosmos`;
const COSMOS_CMD = '"$HOME/Projects/Side Projects/cosmos/hooks/cosmos-offer.sh"';

function setup(obj, { raw } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmos-cs-'));
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(claudeHome);
  const file = path.join(claudeHome, 'settings.json');
  if (raw !== undefined) fs.writeFileSync(file, raw);
  else if (obj !== undefined) fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  const backupDir = path.join(home, 'backups');
  const cs = createClaudeSettings({ claudeHome, cosmosRoot: ROOT, backupDir });
  return { cs, file, backupDir, home };
}

const BASE = {
  enabledPlugins: { 'a@b': true, 'c@d': false },
  theme: 'dark',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    SessionStart: [
      { matcher: 'startup', hooks: [{ type: 'command', command: COSMOS_CMD, async: true, timeout: 10 }] },
      { matcher: 'resume', hooks: [{ type: 'command', command: 'echo other' }] },
    ],
  },
  zLast: [1, 2, 3],
};

test('read: cleanupPeriodDays (the launch-prompt hook is no longer managed)', () => {
  const { cs } = setup(BASE);
  const r = cs.read();
  assert.equal('launchHook' in r, false);
  assert.equal(r.cleanupPeriodDays, null);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
});

test('preview cleanupPeriodDays: exact diff, 3 lines of context, nothing written', () => {
  const { cs, file } = setup(BASE);
  const before = fs.readFileSync(file);
  const p = cs.preview('cleanupPeriodDays', '90');
  assert.equal(p.noop, false);
  assert.equal(p.value, 90);
  const changed = p.diff.filter((d) => d.op !== ' ');
  assert.deepEqual(changed.map((d) => d.op + d.line), ['-  ]', '+  ],', '+  "cleanupPeriodDays": 90']);
  assert.equal(p.diff.filter((d) => d.op === ' ').length, 4, '3 before + closing brace after');
  assert.ok(fs.readFileSync(file).equals(before), 'preview writes nothing');
  assert.match(p.backupPath, /claude-settings-\d{8}-\d{6}\.json$/);
});

test('apply: backup first with exact bytes, untouched keys byte-identical, order kept', () => {
  const { cs, file } = setup(BASE);
  const origBytes = fs.readFileSync(file);
  const p = cs.preview('cleanupPeriodDays', 120);
  const r = cs.apply('cleanupPeriodDays', 120, p.hash);
  assert.equal(r.ok, true);
  assert.ok(fs.readFileSync(r.backupPath).equals(origBytes), 'backup holds the exact original bytes');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after), [...Object.keys(BASE), 'cleanupPeriodDays']);
  for (const k of Object.keys(BASE)) assert.equal(JSON.stringify(after[k], null, 2), JSON.stringify(BASE[k], null, 2), `key ${k} untouched`);
  assert.equal(r.after.cleanupPeriodDays, 120);
  assert.equal(fs.existsSync(file + '.cosmos-tmp'), false);
  // Existing key changes in place.
  const p2 = cs.preview('cleanupPeriodDays', 30);
  assert.deepEqual(p2.diff.filter((d) => d.op !== ' ').map((d) => d.op + d.line), ['-  "cleanupPeriodDays": 120', '+  "cleanupPeriodDays": 30']);
});

test('apply refuses when the file changed since preview (409), writes nothing', () => {
  const { cs, file, backupDir } = setup(BASE);
  const p = cs.preview('cleanupPeriodDays', 60);
  fs.writeFileSync(file, JSON.stringify({ ...BASE, theme: 'light' }, null, 2) + '\n');
  const now = fs.readFileSync(file);
  assert.throws(() => cs.apply('cleanupPeriodDays', 60, p.hash), (e) => e.status === 409);
  assert.ok(fs.readFileSync(file).equals(now));
  assert.equal(fs.existsSync(backupDir), false, 'no backup when nothing is applied');
});

test('only cleanupPeriodDays can change, with bounds', () => {
  const { cs } = setup(BASE);
  assert.throws(() => cs.preview('theme', 'light'), (e) => e.status === 400);
  assert.throws(() => cs.preview('cleanupPeriodDays', '0'), (e) => e.status === 400);
  assert.throws(() => cs.preview('cleanupPeriodDays', '3651'), (e) => e.status === 400);
  assert.throws(() => cs.preview('cleanupPeriodDays', '12.5'), (e) => e.status === 400);
  assert.throws(() => cs.preview('launchHook', 'on'), (e) => e.status === 400);
  assert.throws(() => cs.apply('cleanupPeriodDays', 5, 'nothash'), (e) => e.status === 400);
});

test('non-standard formatting is flagged; invalid JSON is refused', () => {
  const { cs } = setup(undefined, { raw: '{"theme":"dark"}' });
  const p = cs.preview('cleanupPeriodDays', 45);
  assert.equal(p.reformatted, true);
  assert.match(p.explain, /normalized/);
  const bad = setup(undefined, { raw: '{ not json' });
  assert.throws(() => bad.cs.preview('cleanupPeriodDays', 45), (e) => e.status === 409);
});

test('a temp COPY of the real settings file round-trips cleanupPeriodDays with every other value kept', () => {
  if (!realHashBefore) return;
  const raw = fs.readFileSync(REAL, 'utf8');
  const { cs, file } = setup(undefined, { raw });
  const was = JSON.parse(raw).cleanupPeriodDays;
  let p = cs.preview('cleanupPeriodDays', 77);
  cs.apply('cleanupPeriodDays', 77, p.hash);
  const mid = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(mid.cleanupPeriodDays, 77);
  const { cleanupPeriodDays: _a, ...restMid } = mid;
  const { cleanupPeriodDays: _b, ...restRaw } = JSON.parse(raw);
  assert.deepEqual(restMid, restRaw);
  if (Number.isInteger(was)) { p = cs.preview('cleanupPeriodDays', was); cs.apply('cleanupPeriodDays', was, p.hash); }
});

test('lineDiff basics', () => {
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nb\nc\n'), []);
  const d = lineDiff('1\n2\n3\n4\n5\n6\n7\n8\n9\n', '1\n2\n3\n4\nX\n6\n7\n8\n9\n', 1);
  assert.deepEqual(d.map((r) => r.op + r.line), [' 4', '-5', '+X', ' 6']);
});

after(() => {
  if (realHashBefore) {
    const now = crypto.createHash('sha256').update(fs.readFileSync(REAL)).digest('hex');
    assert.equal(now, realHashBefore, 'the real ~/.claude/settings.json was not touched');
  }
});

test('apply refuses to replace a symlinked settings.json; stale tmp is never followed', () => {
  const { cs, file, home } = setup(BASE);
  const real = path.join(home, 'dotfiles-settings.json');
  fs.renameSync(file, real);
  fs.symlinkSync(real, file);
  const p = cs.preview('cleanupPeriodDays', '90');
  assert.throws(() => cs.apply('cleanupPeriodDays', '90', p.hash), (e) => e.status === 409 && e.code === 'not-a-file');
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'the link is untouched');

  // A stale symlink at the temp path must not redirect the write.
  const t2 = setup(BASE);
  const victim = path.join(t2.home, 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, `${t2.file}.cosmos-tmp`);
  const p2 = t2.cs.preview('cleanupPeriodDays', '90');
  t2.cs.apply('cleanupPeriodDays', '90', p2.hash);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(JSON.parse(fs.readFileSync(t2.file, 'utf8')).cleanupPeriodDays, 90);
});
