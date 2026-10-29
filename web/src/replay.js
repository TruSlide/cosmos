// Gate 1 replay: one REAL transcript, played through the same Tape → StarSystem
// seam as the scripted scenes.
//
// The server (replay.mjs, GET /api/replay) sends structural events from one
// real session (DATA_SPEC §3–4). This module turns them into a gallery Scene:
//  - Time warp: real gaps are capped at GAP_CAP seconds (a coffee break doesn't
//    become a minute of nothing), then the whole run is sped up so it fits in
//    about TARGET_DUR seconds. Order and relative rhythm of events are kept.
//  - Mode, per DATA_SPEC §3: a prompt or a tool call → working; an unanswered
//    AskUserQuestion / ExitPlanMode → needs-me; an end_turn → my-move. After
//    the last event the system idles (decay compressed into TAIL seconds).
//  - activity = tool calls in the last ACT_WINDOW replay seconds, normalized.
//  - tokens.total = deduped input + output + cache_creation (cache_read is not
//    spend, DATA_SPEC §4); contextFill = last turn's input + cache tokens / limit.
// No thinking mode: the data can't see it live (DATA_SPEC §3.3).

const GAP_CAP = 6;          // s of real time kept from any single gap
const TARGET_DUR = 100;     // s, the replayed session's length on screen
const TAIL = 12;            // s of compressed idle decay after the last event
const ACT_WINDOW = 6;       // s (replay time)
const ACT_FULL = 5;         // calls in the window that read as full activity

const MODE_LABEL = { working: 'WORKING', 'needs-me': 'NEEDS ME', 'my-move': 'MY MOVE', idle: 'IDLE' };

/** Fetch the replay. Resolves to null when the server has nothing to replay. */
export async function loadReplay(session) {
  const q = session ? `?session=${encodeURIComponent(session)}` : '';
  const res = await fetch(`/api/replay${q}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  return data && Array.isArray(data.events) && data.events.length ? data : null;
}

/** Last index i with arr[i].rt <= tau (arr sorted by rt), or −1. */
function lastAt(arr, tau) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].rt <= tau) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Build a gallery Scene from a replay payload.
 * @param {object} data  /api/replay response
 * @param {(path: string) => {id: string, path: string, folder: string}} fileFor
 */
export function createReplayScene(data, fileFor) {
  const ev = data.events;

  // ---- time warp: real epoch seconds → replay seconds
  let capped = 0;
  for (let i = 1; i < ev.length; i++) capped += Math.min(GAP_CAP, Math.max(0, ev[i].t - ev[i - 1].t));
  const speed = Math.max(1, capped / TARGET_DUR);
  const warp = [];   // [realT, rt] knots, one per event
  let rt = 0.6;      // a beat for the white hole before the first entry
  for (let i = 0; i < ev.length; i++) {
    if (i > 0) rt += Math.min(GAP_CAP, Math.max(0, ev[i].t - ev[i - 1].t)) / speed;
    ev[i].rt = rt;
    warp.push(ev[i].t, rt);
  }
  const endRt = rt;
  const toRt = (t) => {
    if (t <= warp[0]) return warp[1];
    for (let i = 2; i < warp.length; i += 2) {
      if (t <= warp[i]) {
        const span = warp[i] - warp[i - 2];
        const k = span > 0 ? (t - warp[i - 2]) / span : 1;
        return warp[i - 1] + (warp[i + 1] - warp[i - 1]) * k;
      }
    }
    return warp[warp.length - 1];
  };

  // ---- joins and step functions
  const resultById = new Map();
  for (const e of ev) if (e.k === 'result') resultById.set(e.id, e);

  const modes = [];        // { rt, mode, kind }
  const pendingNeeds = new Map();
  let mode = 'working';
  const pushMode = (at, m, kind = null) => {
    const last = modes[modes.length - 1];
    if (last && last.mode === m && last.kind === kind) return;
    modes.push({ rt: at, mode: m, kind });
  };
  pushMode(0, 'working');
  const usage = [];        // { rt, total, ctx }
  let total = 0;
  for (const e of ev) {
    if (e.k === 'prompt') mode = 'working';
    else if (e.k === 'end') mode = 'my-move';
    else if (e.k === 'tool') {
      if (e.needs) pendingNeeds.set(e.id, e.needs);
      mode = 'working';
    } else if (e.k === 'result') pendingNeeds.delete(e.id);
    else if (e.k === 'usage') {
      total += e.in + e.out + e.cc;
      usage.push({ rt: e.rt, total, ctx: (e.in + e.cr + e.cc) / data.contextLimit });
    }
    if (pendingNeeds.size) {
      const kind = [...pendingNeeds.values()].pop();
      pushMode(e.rt, 'needs-me', kind);
    } else pushMode(e.rt, mode);
  }
  const calls = ev.filter((e) => e.k === 'tool');
  const dur = endRt + TAIL;
  const sid = String(data.id).slice(0, 8);

  const modeAt = (tau) => {
    if (tau > endRt) return { mode: 'idle', kind: null };
    const i = lastAt(modes, tau);
    return i < 0 ? modes[0] : modes[i];
  };

  return {
    key: 'replay',
    label: 'Replay',
    dur,
    loop: true,
    real: true,
    labelAt(tau) {
      const m = modeAt(tau);
      return [MODE_LABEL[m.mode] ?? m.mode.toUpperCase(), `session ${sid} · ${speed.toFixed(0)}×`];
    },
    camAt(tau) {
      return modeAt(tau).mode === 'needs-me' ? 'quasar' : 'system';
    },
    init(tape) {
      tape.state.bornAt = tape.at(0);
      tape.state.contextLimit = data.contextLimit;
      tape.state.model = data.model ?? null;
    },
    run(tape, prev, tau) {
      const s = tape.state;
      const m = modeAt(tau);
      s.mode = m.mode;
      s.needsKind = m.mode === 'needs-me' ? m.kind ?? 'question' : null;
      s.idleFor = m.mode === 'idle' ? Math.min(1, (tau - endRt) / (TAIL - 2)) : 0;
      s.endedAt = tau > endRt ? tape.at(endRt) : null;

      // Activity: recent tool calls (replay time), only while working.
      let n = 0;
      for (let i = lastAt(calls, tau); i >= 0 && calls[i].rt > tau - ACT_WINDOW; i--) n++;
      s.activity = m.mode === 'working' ? Math.min(1, 0.15 + n / ACT_FULL) : 0;

      const u = lastAt(usage, tau);
      s.tokens.total = u >= 0 ? usage[u].total : 0;
      s.contextFill = u >= 0 ? usage[u].ctx : 0;

      // Discrete events in (prev, tau].
      for (let i = lastAt(ev, prev) + 1; i < ev.length && ev[i].rt <= tau; i++) {
        const e = ev[i];
        if (e.rt <= prev) continue;
        if (e.k === 'tool') {
          const r = resultById.get(e.id);
          tape.call(e.rt, e.tool, e.path ? fileFor(e.path) : null, !(r && r.err));
        } else if (e.k === 'result' && e.err) {
          tape.error(e.rt, e.tool);
        } else if (e.k === 'compact') {
          tape.compaction(e.id, e.rt, e.pre, e.post);
        } else if (e.k === 'agent') {
          tape.subagent(e.id, e.rt, e.label);
        }
      }
      // Subagents end at their last entry (warped).
      for (const a of s.subagents) {
        if (a.endT != null) continue;
        const src = ev.find((e) => e.k === 'agent' && e.id === a.id);
        const end = src ? toRt(src.endT) : tau;
        if (end <= tau) tape.endSubagent(a.id, end);
      }
    },
  };
}
