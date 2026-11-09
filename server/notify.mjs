// Background notifications (owner, 2026-11-08): Cosmos only helps if you look
// at it, so the server (which runs whether or not a Cosmos window is open)
// posts a macOS notification when
//
//   a session crashes                    right away (crashes outrank needs-me)
//   a session has needed you for a while after notify.needsAfterS seconds, so a
//                                        prompt you are already answering stays quiet
//
// One notification per crash and one per wait (a session that waits again
// later notifies again). Uses `osascript -e 'display notification …'`: it
// shows a banner and writes nothing. Settings > Notifications turns each off.

import { execFile } from 'node:child_process';

const TICK_MS = 5000;
const CRASH_FRESH_S = 600;        // only crashes this recent notify (not old wrecks on start-up)

/** Text safe inside an AppleScript string literal. */
function asText(s, max = 120) {
  return String(s ?? '').replace(/["\\]/g, '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

export function createNotifier({ model, settings, clock = () => Date.now() / 1000, post = null }) {
  const sent = new Set();         // `${kind}:${sid}:${since}`
  let timer = null;

  const show = post || ((title, subtitle, body) => {
    if (process.platform !== 'darwin') return;
    const script = `display notification "${asText(body, 200)}" with title "${asText(title, 60)}" subtitle "${asText(subtitle, 80)}"`;
    execFile('osascript', ['-e', script], { timeout: 4000 }, () => { /* best effort */ });
  });

  function check() {
    if (!model) return;
    const cfg = settings()?.notify || {};
    const now = clock();
    const after = Number.isFinite(cfg.needsAfterS) ? cfg.needsAfterS : 60;
    for (const r of model.sessions().values()) {
      const st = r.state || {};
      const since = st.since ?? null;
      if (since == null) continue;
      const name = r.title || r.id.slice(0, 8);
      const where = r.arm?.name ? ` · ${r.arm.name}` : '';
      if (st.mode === 'crashed' && cfg.crash !== false && now - since < CRASH_FRESH_S) {
        const key = `crash:${r.id}:${Math.round(since)}`;
        if (!sent.has(key)) { sent.add(key); show('Cosmos · crashed', `${name}${where}`, 'A session crashed. Open Cosmos to see where.'); }
      } else if (st.mode === 'needs-me' && cfg.needs !== false && now - since >= after) {
        const key = `needs:${r.id}:${Math.round(since)}`;
        if (!sent.has(key)) {
          sent.add(key);
          const what = st.sub === 'question' ? 'has a question for you' : st.sub === 'plan' ? 'has a plan waiting for your OK' : 'is waiting for your approval';
          const mins = Math.max(1, Math.round((now - since) / 60));
          show('Cosmos · needs you', `${name}${where}`, `${what[0].toUpperCase()}${what.slice(1)} (${mins} min).`);
        }
      }
    }
    if (sent.size > 2000) sent.clear();
  }

  return {
    start() {
      if (timer) return;
      // Old crashes are not news after a restart.
      try {
        const now = clock();
        for (const r of model?.sessions().values() || []) {
          const st = r.state || {};
          if (st.since == null) continue;
          // Waits that are already long DO notify (a forgotten scheduled run is the point).
          if (st.mode === 'crashed' && now - st.since > CRASH_FRESH_S) sent.add(`crash:${r.id}:${Math.round(st.since)}`);
        }
      } catch { /* model not ready: first tick handles it */ }
      timer = setInterval(check, TICK_MS);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    check,
  };
}
