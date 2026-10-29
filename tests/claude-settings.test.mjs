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
  const cs = createClaudeSettings({ claudeHome, cosmosRoot: ROOT, backupDir, homeDir: HOME });
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

test('read: launchHook and cleanupPeriodDays', () => {
  const { cs } = setup(BASE);
  const r = cs.read();
  assert.equal(r.launchHook, true);
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

test('launchHook off removes only the Cosmos entry; on adds it back exactly', () => {
  const { cs, file } = setup(BASE);
  let p = cs.preview('launchHook', 'off');
  let r = cs.apply('launchHook', 'off', p.hash);
  let j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(r.after.launchHook, false);
  assert.deepEqual(j.hooks.SessionStart, [BASE.hooks.SessionStart[1]]);
  assert.deepEqual(j.hooks.PreToolUse, BASE.hooks.PreToolUse);
  p = cs.preview('launchHook', 'on');
  r = cs.apply('launchHook', 'on', p.hash);
  j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(r.after.launchHook, true);
  assert.deepEqual(j.hooks.SessionStart[1], BASE.hooks.SessionStart[0], 'the exact DATA_SPEC §6 entry');
  // on again: noop, no write, no backup
  p = cs.preview('launchHook', 'on');
  assert.equal(p.noop, true);
  assert.deepEqual(p.diff, []);
  const r2 = cs.apply('launchHook', 'on', p.hash);
  assert.equal(r2.noop, true);
  assert.equal(r2.backupPath, null);
});

test('launchHook off drops an emptied SessionStart and hooks object', () => {
  const only = { theme: 'dark', hooks: { SessionStart: [BASE.hooks.SessionStart[0]] } };
  const { cs, file } = setup(only);
  const p = cs.preview('launchHook', 'off');
  cs.apply('launchHook', 'off', p.hash);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark' });
});

test('only the two allowed changes, with bounds', () => {
  const { cs } = setup(BASE);
  assert.throws(() => cs.preview('theme', 'light'), (e) => e.status === 400);
  assert.throws(() => cs.preview('cleanupPeriodDays', '0'), (e) => e.status === 400);
  assert.throws(() => cs.preview('cleanupPeriodDays', '3651'), (e) => e.status === 400);
  assert.throws(() => cs.preview('cleanupPeriodDays', '12.5'), (e) => e.status === 400);
  assert.throws(() => cs.preview('launchHook', 'maybe'), (e) => e.status === 400);
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

test('a temp COPY of the real settings file round-trips (on/off) to identical bytes', () => {
  if (!realHashBefore) return;
  const raw = fs.readFileSync(REAL, 'utf8');
  // A launch hook installed for a Cosmos in another folder can't round-trip against this test's folder.
  if (raw.includes('cosmos-offer.sh') && !raw.includes(JSON.stringify(COSMOS_CMD).slice(1, -1))) return;
  const { cs, file } = setup(undefined, { raw });
  const had = cs.read().launchHook;
  const flip = had ? 'off' : 'on';
  const back = had ? 'on' : 'off';
  let p = cs.preview('launchHook', flip);
  cs.apply('launchHook', flip, p.hash);
  p = cs.preview('launchHook', back);
  cs.apply('launchHook', back, p.hash);
  const reparsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(reparsed, JSON.parse(raw));
  if (JSON.stringify(JSON.parse(raw), null, 2) + '\n' === raw) assert.equal(fs.readFileSync(file, 'utf8'), raw);
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
