// Cosmos model helpers: pure functions with no session state (settings merge,
// context limits, path and date tools). Split out of model.mjs; model.mjs
// re-exports the ones the tests use.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_DEFAULTS } from '../web/src/shared/settings.mjs';

export const COSMOS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_LIMITS = Object.freeze({
  v: 1, default: 200000,
  rules: [{ match: 'claude-*-5-5', limit: 1000000 }, { match: '*[1m]', limit: 1000000 }],
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Glob with `*` only, everything else literal. */
export function globToRegExp(glob) {
  const esc = String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}
/** Context limit for a model: first matching rule, else default; raised to observedPeak / 0.97. */
export function contextLimit(model, limits, observedPeak = 0) {
  const L = limits && Array.isArray(limits.rules) ? limits : DEFAULT_LIMITS;
  let base = Number.isFinite(L.default) ? L.default : DEFAULT_LIMITS.default;
  if (model) {
    for (const r of L.rules) {
      if (r && typeof r.match === 'string' && Number.isFinite(r.limit) && globToRegExp(r.match).test(model)) { base = r.limit; break; }
    }
  }
  return Math.max(base, Math.ceil((observedPeak || 0) / 0.97));
}
/** Strip `/.claude/worktrees/<name>` and everything after it. */
export function stripWorktree(cwd) {
  return typeof cwd === 'string' ? cwd.replace(/\/\.claude\/worktrees\/.*$/, '') : cwd;
}
export function worktreeName(cwd) {
  const m = typeof cwd === 'string' ? /\/\.claude\/worktrees\/([^/]+)/.exec(cwd) : null;
  return m ? m[1] : null;
}
/** Longest candidate that equals or prefixes `dir` (on a path boundary); else `dir`. */
export function longestPrefix(dir, candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c) continue;
    if ((dir === c || dir.startsWith(c.endsWith('/') ? c : c + '/')) && (!best || c.length > best.length)) best = c;
  }
  return best || dir;
}

export function mergeSettings(s) {
  const out = {};
  for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) {
    const o = s && s[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v, ...(o && typeof o === 'object' ? o : {}) } : (o ?? v);
  }
  return out;
}

export function loadLimits(limitsPath) {
  if (!limitsPath) return DEFAULT_LIMITS;
  try {
    const j = JSON.parse(fs.readFileSync(limitsPath, 'utf8'));
    if (j && Array.isArray(j.rules)) return j;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // DATA-CORE writes the default file once, if missing (GALAXY_CONTRACT §3.2). Cosmos folder only.
      if (path.resolve(limitsPath).startsWith(COSMOS_ROOT + path.sep)) {
        try {
          const tmp = `${limitsPath}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(DEFAULT_LIMITS, null, 2) + '\n', { flag: 'wx' });
          fs.renameSync(tmp, limitsPath);
        } catch { /* another writer won, or read-only: defaults still apply */ }
      }
    }
  }
  return DEFAULT_LIMITS;
}

const dayCache = new Map();
/** Local midnight (epoch s) of t, memoised per hour. */
export function dayStart(t) {
  const h = Math.floor(t / 3600);
  let d = dayCache.get(h);
  if (d === undefined) {
    const x = new Date(t * 1000); x.setHours(0, 0, 0, 0);
    d = x.getTime() / 1000;
    if (dayCache.size > 20000) dayCache.clear();
    dayCache.set(h, d);
  }
  return d;
}
export function localDayString(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const ms = (t) => Math.round(t * 1000);
export function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
export function insertSorted(arr, x) { if (!arr.length || arr[arr.length - 1] <= x) arr.push(x); else arr.splice(lowerBound(arr, x), 0, x); }
