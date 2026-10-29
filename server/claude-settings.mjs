// The ONLY code in Cosmos that writes under ~/.claude, and only to
// ~/.claude/settings.json (GALAXY_CONTRACT §3.8, write W10).
//
// Two changes are allowed, nothing else:
//   - cleanupPeriodDays: an integer 1..3650 (how long Claude Code keeps transcripts)
//   - launchHook on|off: the Cosmos SessionStart hook (DATA_SPEC §6)
// Every apply re-reads the file, refuses if it changed since the preview
// (hash), copies the exact current bytes to cosmos/cache/backups/ first, then
// writes through settings.json.cosmos-tmp + rename. Other keys keep their order.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpError } from './security.mjs';

const HOOK_MARK = 'cosmos/hooks/cosmos-offer.sh';
const CONTEXT = 3;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Line diff (LCS) of two texts, with `context` unchanged lines around each change.
 *  Each row: { op: ' '|'-'|'+', line, a?: line number before, b?: line number after }.
 *  A jump in a/b between consecutive rows marks skipped unchanged lines. */
export function lineDiff(beforeText, afterText, context = CONTEXT) {
  const A = beforeText.split('\n');
  const B = afterText.split('\n');
  if (A.length && A[A.length - 1] === '') A.pop();
  if (B.length && B[B.length - 1] === '') B.pop();
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  const rows = [];
  for (let i = 0; i < pre; i++) rows.push({ op: ' ', line: A[i], a: i + 1, b: i + 1 });
  // LCS over the changed middle (small for settings files).
  const n = a.length; const m = b.length;
  if (n * m > 4_000_000) {
    a.forEach((l, i) => rows.push({ op: '-', line: l, a: pre + i + 1 }));
    b.forEach((l, j) => rows.push({ op: '+', line: l, b: pre + j + 1 }));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    let i = 0; let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { rows.push({ op: ' ', line: a[i], a: pre + i + 1, b: pre + j + 1 }); i++; j++; }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { rows.push({ op: '-', line: a[i], a: pre + i + 1 }); i++; }
      else { rows.push({ op: '+', line: b[j], b: pre + j + 1 }); j++; }
    }
  }
  for (let k = 0; k < suf; k++) {
    rows.push({ op: ' ', line: A[A.length - suf + k], a: A.length - suf + k + 1, b: B.length - suf + k + 1 });
  }
  // Keep only changed rows and `context` rows around them.
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (r.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep[k] = true;
  });
  return rows.filter((_, idx) => keep[idx]);
}

export function createClaudeSettings({
  claudeHome = path.join(os.homedir(), '.claude'),
  cosmosRoot,
  backupDir,
  homeDir = os.homedir(),
} = {}) {
  if (!cosmosRoot) throw new Error('createClaudeSettings needs cosmosRoot');
  const file = path.join(claudeHome, 'settings.json');
  const tmpFile = path.join(claudeHome, 'settings.json.cosmos-tmp');
  const backups = backupDir || path.join(cosmosRoot, 'cache', 'backups');
  const hookScript = path.join(cosmosRoot, 'hooks', 'cosmos-offer.sh');
  // Same spelling as the entry already installed: "$HOME/…" when under home.
  const hookCommand = hookScript.startsWith(homeDir + path.sep)
    ? `"$HOME${hookScript.slice(homeDir.length)}"`
    : `"${hookScript}"`;
  const hookEntry = () => ({
    matcher: 'startup',
    hooks: [{ type: 'command', command: hookCommand, async: true, timeout: 10 }],
  });

  function readRaw() {
    let buf;
    try { buf = fs.readFileSync(file); } catch (err) {
      if (err.code === 'ENOENT') return { buf: null, text: '', obj: {}, exists: false };
      throw httpError(500, 'read-failed', `Could not read ${file}: ${err.code || err.message}.`);
    }
    const text = buf.toString('utf8');
    let obj;
    try { obj = text.trim() === '' ? {} : JSON.parse(text); } catch {
      throw httpError(409, 'not-json', `${file} is not valid JSON right now, so Cosmos will not touch it. Fix it by hand first.`);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw httpError(409, 'not-object', `${file} does not hold a JSON object, so Cosmos will not touch it.`);
    }
    return { buf, text, obj, exists: true };
  }

  function isCosmosHook(h) {
    return h && typeof h.command === 'string' && h.command.includes(HOOK_MARK);
  }

  function hasLaunchHook(obj) {
    const groups = obj?.hooks?.SessionStart;
    if (!Array.isArray(groups)) return false;
    return groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isCosmosHook));
  }

  function summary(obj) {
    const c = obj.cleanupPeriodDays;
    return { cleanupPeriodDays: Number.isInteger(c) ? c : (typeof c === 'number' ? c : null), launchHook: hasLaunchHook(obj) };
  }

  function read() {
    const r = readRaw();
    return { ...summary(r.obj), path: file, hash: r.buf ? sha256(r.buf) : sha256(Buffer.alloc(0)) };
  }

  function parseChange(change, value) {
    if (change === 'cleanupPeriodDays') {
      const s = String(value ?? '').trim();
      if (!/^\d{1,4}$/.test(s)) throw httpError(400, 'bad-value', 'cleanupPeriodDays must be a whole number of days from 1 to 3650.');
      const n = Number(s);
      if (n < 1 || n > 3650) throw httpError(400, 'bad-value', 'cleanupPeriodDays must be a whole number of days from 1 to 3650.');
      return { change, value: n };
    }
    if (change === 'launchHook') {
      const v = value === true ? 'on' : value === false ? 'off' : String(value ?? '');
      if (v !== 'on' && v !== 'off') throw httpError(400, 'bad-value', 'launchHook must be "on" or "off".');
      return { change, value: v };
    }
    throw httpError(400, 'bad-change', 'Cosmos can only change cleanupPeriodDays or the launch-prompt hook.');
  }

  /** New object with the change applied; key order of everything else kept. */
  function transform(obj, { change, value }) {
    const next = structuredClone(obj);
    if (change === 'cleanupPeriodDays') {
      next.cleanupPeriodDays = value;       // existing key keeps its place; a new key goes last
      return next;
    }
    if (value === 'on') {
      if (hasLaunchHook(next)) return next;
      if (next.hooks === undefined) next.hooks = {};
      if (next.hooks === null || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
        throw httpError(409, 'hooks-shape', '"hooks" in settings.json is not an object, so Cosmos will not touch it.');
      }
      if (next.hooks.SessionStart === undefined) next.hooks.SessionStart = [];
      if (!Array.isArray(next.hooks.SessionStart)) {
        throw httpError(409, 'hooks-shape', '"hooks.SessionStart" in settings.json is not a list, so Cosmos will not touch it.');
      }
      next.hooks.SessionStart.push(hookEntry());
      return next;
    }
    // off: remove only Cosmos's own hook commands; drop what that empties.
    const groups = next.hooks?.SessionStart;
    if (!Array.isArray(groups)) return next;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const hooks = g.hooks.filter((h) => !isCosmosHook(h));
      if (hooks.length === g.hooks.length) { kept.push(g); continue; }
      if (hooks.length > 0) kept.push({ ...g, hooks });
    }
    if (kept.length > 0) next.hooks.SessionStart = kept;
    else delete next.hooks.SessionStart;
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
    return next;
  }

  function render(obj, likeText) {
    const out = JSON.stringify(obj, null, 2);
    return likeText === '' || likeText.endsWith('\n') ? out + '\n' : out;
  }

  function explainFor({ change, value }, before, noop, reformatted) {
    const parts = [];
    if (change === 'cleanupPeriodDays') {
      const was = before.cleanupPeriodDays === null ? 'not set (Claude Code uses its default, about 30 days)' : `${before.cleanupPeriodDays} days`;
      parts.push(noop
        ? `cleanupPeriodDays is already ${value} days; nothing would change.`
        : `Claude Code would keep session transcripts for ${value} days (now: ${was}). Older transcripts are deleted by Claude Code itself; Cosmos only keeps its own summaries in cosmos/cache.`);
      if (!noop && value < 30) parts.push('Warning: a short period means Cosmos can replay less history from transcripts.');
    } else if (value === 'on') {
      parts.push(noop
        ? 'The Cosmos launch-prompt hook is already installed; nothing would change.'
        : 'Adds one SessionStart hook that runs cosmos/hooks/cosmos-offer.sh when you start a session. It prints nothing and costs zero tokens; it only shows the "Open Cosmos?" dialog when no Cosmos window is open.');
    } else {
      parts.push(noop
        ? 'No Cosmos launch-prompt hook is installed; nothing would change.'
        : 'Removes only the Cosmos launch-prompt hook. Any other hooks stay exactly as they are.');
    }
    parts.push('It does not change anything else in the file.');
    if (reformatted) parts.push('Note: your file is not in standard 2-space JSON layout, so its spacing will be normalized; values and key order stay the same.');
    if (!noop) parts.push('A copy of the current file is saved first, in cosmos/cache/backups.');
    return parts.join(' ');
  }

  function plan(change, value) {
    const c = parseChange(change, value);
    const r = readRaw();
    const before = summary(r.obj);
    const next = transform(r.obj, c);
    const canonicalBefore = render(r.obj, r.text);
    const afterText = render(next, r.text);
    const reformatted = r.exists && canonicalBefore !== r.text;
    const noop = JSON.stringify(next) === JSON.stringify(r.obj);
    return { c, r, before, next, afterText, reformatted, noop };
  }

  function backupPathFor(d = new Date()) {
    return path.join(backups, `claude-settings-${stamp(d)}.json`);
  }

  function preview(change, value) {
    const p = plan(change, value);
    return {
      change: p.c.change, value: p.c.value, path: file,
      hash: p.r.buf ? sha256(p.r.buf) : sha256(Buffer.alloc(0)),
      noop: p.noop,
      reformatted: p.reformatted,
      diff: p.noop ? [] : lineDiff(p.r.text, p.afterText),
      backupPath: backupPathFor(),
      explain: explainFor(p.c, p.before, p.noop, p.reformatted),
    };
  }

  function apply(change, value, expectHash) {
    if (typeof expectHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectHash)) {
      throw httpError(400, 'no-hash', 'Open the preview first; the apply step needs the preview\'s file hash.');
    }
    const p = plan(change, value);
    const hash = p.r.buf ? sha256(p.r.buf) : sha256(Buffer.alloc(0));
    if (hash !== expectHash) {
      throw httpError(409, 'changed', 'settings.json changed since the preview. Nothing was written; open the preview again.');
    }
    if (p.noop) return { ok: true, noop: true, backupPath: null, after: summary(p.r.obj) };

    // 0. Only a plain file is ever replaced: renaming over a symlink (dotfile
    //    managers) would silently detach the owner's managed config.
    let lst = null;
    try { lst = fs.lstatSync(file); } catch { /* new file */ }
    if (lst && !lst.isFile()) {
      throw httpError(409, 'not-a-file', `${file} is a link or not a regular file; Cosmos will not replace it. Change it yourself, or point Cosmos at the real file.`);
    }

    // 1. Backup the exact current bytes (never under ~/.claude).
    let backupPath = null;
    if (p.r.exists) {
      fs.mkdirSync(backups, { recursive: true });
      const d = new Date();
      backupPath = backupPathFor(d);
      for (let i = 1; fs.existsSync(backupPath); i++) backupPath = backupPathFor(d).replace(/\.json$/, `-${i}.json`);
      const tmp = `${backupPath}.tmp`;
      fs.writeFileSync(tmp, p.r.buf, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, backupPath);
      if (!fs.readFileSync(backupPath).equals(p.r.buf)) {
        throw httpError(500, 'backup-failed', 'The backup did not match the original, so nothing was written.');
      }
    }

    // 2. Write through a temp file next to the real one, then rename.
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
    try {
      fs.rmSync(tmpFile, { force: true });                       // a stale Cosmos temp file (never followed)
      fs.writeFileSync(tmpFile, p.afterText, { flag: 'wx', mode }); // fails on anything placed there meanwhile
      fs.renameSync(tmpFile, file);
    } catch (err) {
      try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
      throw httpError(500, 'write-failed', `Could not write ${file}: ${err.code || err.message}. Your backup is at ${backupPath}.`);
    }
    const after = summary(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { ok: true, backupPath, after };
  }

  return { read, preview, apply, path: file };
}
