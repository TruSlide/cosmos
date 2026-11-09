// Parking Lot bridge (owner, 2026-11-08): Cosmos and /pending show the same list.
//
//   Cosmos ← /pending   list() runs the Parking Lot collector that /pending uses
//                       (~/.claude/skills/prompt-dictionary/scripts/pending.py --json)
//                       and caches the result briefly. Read-only: the script only reads.
//   /pending ← Cosmos   needs(model) is what GET /api/needs serves: the sessions that
//                       need the owner right now, which pending.py adds to its list.
//
// Nothing here writes a file.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Optional: any script that prints the Parking Lot JSON. COSMOS_PENDING_SCRIPT overrides the default path;
// without one, the Parking Lot section simply stays empty.
const SCRIPT = process.env.COSMOS_PENDING_SCRIPT || path.join(os.homedir(), '.claude', 'skills', 'prompt-dictionary', 'scripts', 'pending.py');
const CACHE_S = 20;

export function createPending({ script = SCRIPT, clock = () => Date.now() / 1000 } = {}) {
  let cache = null;
  let cacheAt = -Infinity;
  let running = null;

  function run() {
    if (running) return running;
    running = new Promise((resolve) => {
      if (!fs.existsSync(script)) { resolve({ available: false, groups: [], problems: ['The Parking Lot script was not found.'] }); return; }
      // -I: isolated mode, so nothing in the current folder is imported.
      execFile('python3', ['-I', script, '--json', '--no-cosmos'], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { resolve({ available: false, groups: [], problems: [`Parking Lot script failed: ${err.code || err.message}`] }); return; }
        try { resolve({ available: true, ...JSON.parse(String(stdout)) }); }
        catch { resolve({ available: false, groups: [], problems: ['Parking Lot script returned something unreadable.'] }); }
      });
    }).finally(() => { running = null; });
    return running;
  }

  return {
    async list({ fresh = false } = {}) {
      const now = clock();
      if (!cache || now - cacheAt > (fresh ? 2 : CACHE_S)) { cache = await run(); cacheAt = now; }
      return { asOf: cacheAt, ...cache };
    },
  };
}

/** Sessions that need the owner now, for /pending (titles, wait start and the app link only). */
export function needs(model) {
  if (!model) return { sessions: [] };
  const out = [];
  for (const r of model.sessions().values()) {
    if (r.state?.mode !== 'needs-me') continue;
    out.push({
      sid: r.id,
      title: r.title || r.id.slice(0, 8),
      project: r.arm?.name || null,
      kind: r.state.sub || null,
      since: r.state.since ?? null,
      appSession: r.appSession || null,
    });
  }
  out.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  return { sessions: out };
}
