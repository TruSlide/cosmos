// Cosmos arms: which project (spiral arm) a session belongs to (DATA_SPEC §8).
// Split out of model.mjs. The factory reads the model's live settings and
// sessions through getters, so settings changes apply straight away.

import fs from 'node:fs';
import path from 'node:path';
import { stripWorktree, longestPrefix } from './model-helpers.mjs';

const ARM_MIN_WEIGHT = 3;

/** createArms({ getSettings, sessions }) -> { armOf, setProjectKeys } */
export function createArms({ getSettings, sessions }) {
  let projectKeys = [];
  const rootCache = new Map();      // dir -> bool (has .git or CLAUDE.md)

  function setProjectKeys(keys) { projectKeys = keys.map(stripWorktree); }

  function isProjectRoot(dir) {
    if (!dir) return false;
    let v = rootCache.get(dir);
    if (v === undefined) {
      v = fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'CLAUDE.md'));
      rootCache.set(dir, v);
    }
    return v;
  }
  /** Arm = the project the work actually happened in (DATA_SPEC §8, owner
   *  feedback): sessions are often started in a container folder (no .git, no
   *  CLAUDE.md, e.g. "Side Projects") but work inside one of its subfolders.
   *  1. candidates: known project dirs + getSettings().arms keys (owner overrides,
   *     which may name a subfolder) + project roots seen as a cwd;
   *  2. when the best candidate for the cwd is a container, its first-level
   *     subfolders are candidates too;
   *  3. the candidate holding most of the session's file work (edits weigh 3,
   *     reads 1; at least ARM_MIN_WEIGHT and over half) wins, else the cwd's. */
  function armCandidates() {
    const cands = new Set(projectKeys);
    for (const k of Object.keys(getSettings().arms || {})) cands.add(k);
    for (const o of sessions()) {
      const d = o.cwd ? stripWorktree(o.cwd) : null;
      if (d && isProjectRoot(d)) cands.add(d);
    }
    return cands;
  }
  const dirCache = new Map();        // path -> is an existing directory (arm detection only)
  function isDir(p) {
    let v = dirCache.get(p);
    if (v === undefined) { try { v = fs.statSync(p).isDirectory(); } catch { v = false; } dirCache.set(p, v); }
    return v;
  }
  function subProject(container, abs) {
    if (!abs.startsWith(container + '/')) return null;
    const rest = abs.slice(container.length + 1);
    const i = rest.indexOf('/');
    if (i <= 0) return null;                       // a file directly in the container
    const seg = rest.slice(0, i);
    if (seg.startsWith('.')) return null;          // .claude, .git, ...
    const sub = container + '/' + seg;
    return isDir(sub) ? sub : null;                // only real folders on disk
  }
  function armOf(s) {
    const cwd = s.cwd;
    if (!cwd) return { key: null, name: null };
    const dir = stripWorktree(cwd);
    const cands = armCandidates();
    const memoSig = `${s.filesSig}|${cands.size}|${projectKeys.length}|${dir}`;
    let key;
    if (s.armMemo && s.armMemo.sig === memoSig && s.armMemo.settings === getSettings()) key = s.armMemo.key;
    else {
      const base = longestPrefix(dir, cands);
      // A container is a known project folder that exists, is not itself a repo
      // (no .git / CLAUDE.md). A folder that is gone cannot be judged: no split.
      const container = cands.has(base) && isDir(base) && !isProjectRoot(base) ? base : null;
      const pick = (abs) => {
        const k = longestPrefix(abs, cands);
        if (container && k === container) return subProject(container, abs) || k;
        return k;
      };
      const own = container ? pick(dir) : base;
      const w = new Map();
      let total = 0;
      const home = process.env.HOME || '';
      for (const f of s.files.values()) {
        let abs = f.path;
        if (abs.startsWith('~/')) abs = home + abs.slice(1);
        else if (!abs.startsWith('/')) abs = path.join(cwd, abs);
        if (home && abs.startsWith(home + '/.claude/')) continue;   // plans, memory: not project work
        abs = abs.replace(/\/\.claude\/worktrees\/[^/]+(?=\/)/, '');
        const k = pick(abs);
        if (!k || k === abs) continue;                          // outside every candidate
        const wt = f.edits * 3 + f.reads;
        w.set(k, (w.get(k) || 0) + wt);
        total += wt;
      }
      key = own;
      let best = null, bestW = 0;
      for (const [k, v] of w) if (v > bestW) { best = k; bestW = v; }
      if (best && bestW >= ARM_MIN_WEIGHT && bestW > total / 2) key = best;
      s.armMemo = { sig: memoSig, settings: getSettings(), key };
    }
    const name = getSettings().arms?.[key]?.name || path.basename(key) || key;
    return { key, name };
  }

  return { armOf, setProjectKeys };
}
