// Gate 1 gallery: one star system, every state. Scripted scenes (DEMO) show
// each state on demand; the Replay scene (replay.js) plays ONE real transcript.
//
// The seam: this file only BUILDS SystemState objects (CONTRACT §2) and hands
// them to StarSystem.update(). Scripted and replayed scenes both write the same
// Tape; StarSystem and the object modules can't tell them apart.
//
// How the script works
//  - A Scene is a timeline in scene-local seconds τ. Each frame the driver
//    advances τ and asks the scene to (a) set the continuous fields (mode,
//    activity, contextFill, idleFor, tokens) and (b) emit the discrete events
//    (tool calls, errors, subagents, compactions) whose time falls in (prevτ, τ].
//  - Events land on a Tape that owns one mutable SystemState. Event times are
//    absolute data-clock seconds: epoch + τ.
//  - Restarting a scene moves the epoch backwards, so `now` jumps back. Every
//    object treats that as a replay scrub and resets itself (CONTRACT §1). No
//    reset() call crosses the seam.
//  - Pause freezes the data clock; the render clock keeps running, so held
//    frames still breathe exactly as a paused replay would.

import * as THREE from 'three';
import { createEngine } from './engine.js';
import { StarSystem } from './system.js';
import { hash01, smoothstep } from './lib/math.js';
import { loadReplay, createReplayScene } from './replay.js';

// ------------------------------------------------------------------ constants

const SESSION_ID = 'demo-gate1-7f3c';
const EPOCH0 = 1761730000;            // arbitrary fixed data-clock origin (epoch s)
const KEEP_CALLS = 30;                // CONTRACT §2 retention windows (s)
const KEEP_ERRORS = 120;
const KEEP_AGENT_AFTER_END = 6;
const USER_IDLE_FOR_CAMERA = 8;       // s without input before scripted camera moves

// Files the demo session "touches". Folder ids follow CONTRACT ("d:<path>").
const FILES = [
  ['web/src/objects/star.js', 'web/src/objects'],
  ['web/src/system.js', 'web/src'],
  ['web/src/objects/belt.js', 'web/src/objects'],
  ['web/src/objects/ships.js', 'web/src/objects'],
  ['web/src/engine.js', 'web/src'],
  ['web/src/objects/planets.js', 'web/src/objects'],
  ['web/gate1.html', 'web'],
  ['docs/ART_DIRECTION.md', 'docs'],
  ['server.mjs', '.'],
].map(([path, folder]) => ({ id: `f:${path}`, path, folder: `d:${folder}` }));

// Camera presets (system at the origin). `keepAzimuth` keeps the current orbit
// angle and only changes distance / elevation, so cuts never swing around.
const CAMERAS = {
  system: { pos: [0, 8.6, 31], target: [0, 0.4, 0], keepAzimuth: true },
  // Errors live on the star's surface (loops 0.6 radii tall): come in close.
  flare: { pos: [0, 3.2, 12.5], target: [0, 0.2, 0], keepAzimuth: true },
  quasar: { pos: [0, 11, 57], target: [0, 1.0, 0], keepAzimuth: true },
  // ART_DIRECTION §7: the hole forms on the near side of the belt, with the
  // star and dense belt behind it, so the lensing has something to bend.
  compaction: { pos: [9, 10, 36], target: [0, 0.4, 0], keepAzimuth: false },
};

// The compaction's angle comes from hash01(id) (CONTRACT §5). For the demo we
// pick the first id whose hole lands just left of the compaction camera's line
// of sight, so the star sits behind the lens. Deterministic: same id every load.
const COMPACTION_ID = (() => {
  const camAz = Math.atan2(CAMERAS.compaction.pos[2], CAMERAS.compaction.pos[0]);
  for (let n = 0; n < 5000; n++) {
    const id = `cmp-${n}`;
    const a = hash01(id) * Math.PI * 2;
    const d = Math.atan2(Math.sin(a - camAz), Math.cos(a - camAz));
    if (d > -0.62 && d < -0.42) return id;
  }
  return 'cmp-0';
})();

// ------------------------------------------------------------------ helpers

/** Piecewise interpolation over flat [t0, v0, t1, v1, …] keys, eased per span. */
function kf(tau, keys) {
  if (tau <= keys[0]) return keys[1];
  for (let i = 2; i < keys.length; i += 2) {
    if (tau <= keys[i]) {
      const a = keys[i - 2];
      const k = smoothstep(a, keys[i], tau);
      return keys[i - 1] + (keys[i + 1] - keys[i - 1]) * k;
    }
  }
  return keys[keys.length - 1];
}

/**
 * Calls fn(k, tk) for every periodic event k whose (jittered) time tk falls in
 * (prev, cur] and in [from, to). Jitter is a pure function of (salt, k), so a
 * contiguous run of windows emits each event exactly once.
 */
function periodic(prev, cur, from, to, period, salt, fn) {
  const lo = Math.max(from, prev) - period;
  const hi = Math.min(to, cur) + period;
  const k0 = Math.max(0, Math.floor((lo - from) / period));
  const k1 = Math.floor((hi - from) / period);
  for (let k = k0; k <= k1; k++) {
    const tk = from + (k + 0.15 + 0.7 * hash01(`${salt}:j${k}`)) * period;
    if (tk > prev && tk <= cur && tk >= from && tk < to) fn(k, tk);
  }
}

// ------------------------------------------------------------------ Tape

/** Owns one mutable SystemState and the scripted event lists behind it. */
class Tape {
  constructor() {
    this.state = {
      v: 1, id: SESSION_ID, now: EPOCH0, mode: 'working', needsKind: null,
      idleFor: 0, activity: 0, contextFill: 0, contextLimit: 200000,
      tokens: { total: 0 }, bornAt: null, endedAt: null,
      title: 'gate 1 demo', project: 'cosmos', model: 'claude-opus-5-5',
      compactions: [], errors: [], toolCalls: [], subagents: [], files: [],
    };
    this.epoch = EPOCH0;
    this._files = new Map();
    this._n = 0;
  }

  /** Clear everything and start a fresh timeline at `epoch`. */
  begin(epoch) {
    const s = this.state;
    this.epoch = epoch;
    s.now = epoch;
    s.mode = 'working'; s.needsKind = null;
    s.idleFor = 0; s.activity = 0; s.contextFill = 0;
    s.tokens.total = 0;
    s.bornAt = null; s.endedAt = null;
    s.compactions.length = 0; s.errors.length = 0; s.toolCalls.length = 0;
    s.subagents.length = 0; s.files.length = 0;
    this._files.clear();
    this._n = 0;
  }

  at(tau) { return this.epoch + tau; }

  touch(file, tau, edited) {
    let f = this._files.get(file.id);
    if (!f) {
      f = { id: file.id, path: file.path, folder: file.folder, edits: 0, lastT: this.at(tau) };
      this._files.set(file.id, f);
      this.state.files.push(f);
    }
    if (edited) f.edits++;
    f.lastT = this.at(tau);
    return f;
  }

  /** Preload files already worked on before the scene starts (hold scenes). */
  preload(edits) {
    FILES.forEach((file, i) => {
      if (edits[i] == null) return;
      const f = this.touch(file, -40 + i, false);
      f.edits = edits[i];
    });
  }

  call(tau, tool, file, ok = true) {
    const target = file ? file.id : null;
    const c = { id: `tu_${++this._n}`, t: this.at(tau), tool, target, ok };
    this.state.toolCalls.push(c);
    if (file) this.touch(file, tau, tool === 'Edit' || tool === 'Write');
    return c;
  }

  error(tau, tool) {
    this.state.errors.push({ id: `e_${++this._n}`, t: this.at(tau), tool });
  }

  subagent(id, tau, label) {
    const s = { id, t: this.at(tau), endT: null, label };
    this.state.subagents.push(s);
    return s;
  }

  endSubagent(id, tau) {
    for (const s of this.state.subagents) if (s.id === id && s.endT == null) s.endT = this.at(tau);
  }

  compaction(id, tau, tokensBefore, tokensAfter) {
    this.state.compactions.push({ id, t: this.at(tau), tokensBefore, tokensAfter });
  }

  /** Drop events older than the data layer's retention windows (in place). */
  prune() {
    const s = this.state;
    const now = s.now;
    pruneIf(s.toolCalls, (c) => now - c.t > KEEP_CALLS);
    pruneIf(s.errors, (e) => now - e.t > KEEP_ERRORS);
    pruneIf(s.subagents, (a) => a.endT != null && now - a.endT > KEEP_AGENT_AFTER_END);
  }
}

function pruneIf(arr, drop) {
  let w = 0;
  for (let r = 0; r < arr.length; r++) if (!drop(arr[r])) arr[w++] = arr[r];
  arr.length = w;
}

// ------------------------------------------------------------------ work stream

const TOOL_TABLE = [
  // cumulative weight, tool, has file target
  [0.40, 'Edit', true],
  [0.68, 'Read', true],
  [0.78, 'Grep', true],
  [1.00, 'Bash', false],
];

/** A steady stream of tool calls: mostly edits to a few hot files. */
function workStream(tape, prev, cur, from, to, period, salt) {
  periodic(prev, cur, from, to, period, salt, (k, tk) => {
    const r = hash01(`${salt}:tool${k}`);
    let row = TOOL_TABLE[TOOL_TABLE.length - 1];
    for (const e of TOOL_TABLE) if (r < e[0]) { row = e; break; }
    const tool = row[1];
    // Hot files get most of the traffic, so a few planets visibly grow.
    const fi = Math.floor(Math.pow(hash01(`${salt}:file${k}`), 1.7) * FILES.length);
    tape.call(tk, tool, row[2] ? FILES[fi] : null);
  });
}

/** A burst of calls to one file inside a second: the ships merge into a convoy. */
function convoy(tape, prev, cur, at, file, n = 6, spacing = 0.09) {
  for (let i = 0; i < n; i++) {
    const tk = at + i * spacing;
    if (tk > prev && tk <= cur) tape.call(tk, 'Edit', file);
  }
}

const once = (prev, cur, at) => at > prev && at <= cur;

// ------------------------------------------------------------------ scenes

// Baseline for hold scenes: a session that has been working for a while.
const HOLD_EDITS = [9, 6, 5, 4, 2, 3, 2, 1, 0];
function holdBaseline(tape, { tokens = 1.2e6, fill = 0.42 } = {}) {
  tape.preload(HOLD_EDITS);
  tape.state.tokens.total = tokens;
  tape.state.contextFill = fill;
}

// --- the main life of one session (sequence part A) --------------------------
// τ:  0 birth · 4 working (no thinking phase: merged, DATA_SPEC §3.3) · 12 error · 14 storm · 16 needs me
//     · 20.5 my move · 23 compaction · 32 idle → 40
const LIFE = {
  activity: [0, 0, 2.4, 0.15, 4, 0.75, 9, 0.8, 9.6, 0.5, 12, 0.55, 15.8, 0.6, 16.2, 0,
    23, 0, 23.4, 0.55, 24.3, 0.3, 31.6, 0.25, 32.2, 0],
  fill: [0, 0.02, 4, 0.08, 9, 0.38, 12, 0.45, 16, 0.58, 20.5, 0.62, 23, 0.64, 24.2, 0.97,
    27.4, 0.97, 29.2, 0.2, 40, 0.2],
  tokens: [0, 0, 2.6, 0, 4, 60e3, 9, 1.1e6, 12, 1.35e6, 16, 1.9e6, 23, 1.95e6, 24.2, 2.4e6, 40, 2.45e6],
  idle: [32.6, 0, 39, 1],
};

const SCENES = [
  {
    key: 'life', label: 'Full sequence', hidden: true, dur: 40, loop: false,
    labelAt(tau) {
      if (tau < 4) return ['NEW SESSION', 'white hole'];
      if (tau < 12) return ['WORKING', ''];
      if (tau < 14) return ['ERROR', 'flare'];
      if (tau < 16) return ['ERRORS', 'flare storm'];
      if (tau < 20.5) return ['NEEDS ME', 'quasar'];
      if (tau < 23) return ['MY MOVE', 'beacon'];
      if (tau < 32) return ['COMPACTION', 'black hole'];
      return ['IDLE', 'cooling over a day'];
    },
    camAt(tau) {
      if (tau >= 12 && tau < 16) return 'flare';
      if (tau >= 16 && tau < 20.5) return 'quasar';
      if (tau >= 23 && tau < 31) return 'compaction';
      return 'system';
    },
    init(tape) { tape.state.bornAt = tape.at(0); },
    run(tape, prev, tau) {
      const s = tape.state;
      // Thinking can't be seen live (DATA_SPEC §3.3): τ 9–12 is plain working.
      s.mode = tau < 16 ? 'working'
        : tau < 20.5 ? 'needs-me'
          : tau < 23 ? 'my-move'
            : tau < 32 ? 'working' : 'idle';
      s.needsKind = s.mode === 'needs-me' ? 'permission' : null;
      s.activity = kf(tau, LIFE.activity);
      s.contextFill = kf(tau, LIFE.fill);
      s.tokens.total = Math.round(kf(tau, LIFE.tokens));
      s.idleFor = s.mode === 'idle' ? kf(tau, LIFE.idle) : 0;
      s.endedAt = tau >= 32 ? tape.at(32) : null;

      // Working: tool calls, a convoy burst, two subagents out and home.
      workStream(tape, prev, tau, 2.6, 9, 0.42, 'life-a');
      convoy(tape, prev, tau, 6.6, FILES[1]);
      if (once(prev, tau, 4.6)) tape.subagent('sa_explore', 4.6, 'explore');
      if (once(prev, tau, 5.8)) tape.subagent('sa_review', 5.8, 'review');
      if (once(prev, tau, 9.4)) tape.endSubagent('sa_explore', 9.4);
      if (once(prev, tau, 11.2)) tape.endSubagent('sa_review', 11.2);

      // Errors: one failing call, later three more inside 20 s → storm.
      workStream(tape, prev, tau, 12, 16, 0.5, 'life-b');
      for (const et of [12.5, 14.2, 14.6, 15.1]) {
        if (once(prev, tau, et)) { tape.call(et, 'Bash', null, false); tape.error(et, 'Bash'); }
      }

      // Compaction: a burst of work fills the context, then the record lands.
      workStream(tape, prev, tau, 23.1, 24.2, 0.22, 'life-c');
      if (once(prev, tau, 24.3)) tape.compaction(COMPACTION_ID, 24.3, 190000, 61000);
      workStream(tape, prev, tau, 30.2, 31.8, 0.5, 'life-d');
    },
  },
  {
    key: 'birth', label: 'Birth', dur: 7.5, loop: true,
    labelAt: () => ['NEW SESSION', 'white hole'],
    camAt: () => 'system',
    init(tape) { tape.state.bornAt = tape.at(0.2); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = 'working';
      s.activity = kf(tau, [0, 0, 2.6, 0.2, 4.2, 0.7]);
      s.contextFill = kf(tau, [0, 0.02, 7.5, 0.1]);
      s.tokens.total = Math.round(kf(tau, [0, 0, 2.8, 0, 7.5, 220e3]));   // no tokens before the first turn
      workStream(tape, prev, tau, 2.8, 99, 0.42, 'birth');
    },
  },
  {
    key: 'working', label: 'Working', dur: Infinity, loop: false,
    labelAt: () => ['WORKING', ''],
    camAt: () => 'system',
    init(tape) { holdBaseline(tape, { tokens: 0.9e6, fill: 0.34 }); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = 'working';
      s.activity = 0.8;
      s.contextFill = 0.34 + 0.25 * (1 - Math.exp(-tau / 90));
      s.tokens.total = Math.round(0.9e6 + 22e3 * tau);
      workStream(tape, prev, tau, 0.3, Infinity, 0.42, 'hold-w');
      // A convoy every 11 s, a subagent out every 14 s (home after 9 s).
      for (let k = Math.max(0, Math.floor((prev - 3) / 11)); 3 + 11 * k <= tau; k++) {
        convoy(tape, prev, tau, 3 + 11 * k, FILES[k % 3]);
      }
      // Same salt → same jitter, so each subagent ends exactly 9 s after it starts.
      periodic(prev, tau, 1.5, Infinity, 14, 'hold-sa', (k, tk) => tape.subagent(`sa_h${k}`, tk, 'task'));
      periodic(prev, tau, 1.5 + 9, Infinity, 14, 'hold-sa', (k, tk) => tape.endSubagent(`sa_h${k}`, tk));
    },
  },
  {
    key: 'thinking', label: 'Thinking', dur: Infinity, loop: false,
    labelAt: () => ['THINKING', "NOT USED · data can't see thinking live (merged into working)"],
    camAt: () => 'system',
    init(tape) { holdBaseline(tape); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = tau < 1.2 ? 'working' : 'thinking';
      s.activity = tau < 1.2 ? 0.7 : 0.5;
      workStream(tape, prev, tau, 0, 1.2, 0.4, 'hold-t');
    },
  },
  {
    key: 'flare', label: 'Error', dur: Infinity, loop: false,
    labelAt: () => ['ERROR', 'flare'],
    camAt: () => 'flare',
    init(tape) { holdBaseline(tape); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = 'working';
      s.activity = 0.55;
      workStream(tape, prev, tau, 0, Infinity, 0.5, 'hold-f');
      // One error every 10.5 s never reaches the storm rule (≥ 3 in 20 s).
      for (let k = Math.max(0, Math.floor((prev - 0.6) / 10.5)); 0.6 + 10.5 * k <= tau; k++) {
        const tk = 0.6 + 10.5 * k;
        if (once(prev, tau, tk)) { tape.call(tk, 'Bash', null, false); tape.error(tk, 'Bash'); }
      }
    },
  },
  {
    key: 'storm', label: 'Storm', dur: Infinity, loop: false,
    labelAt: (tau) => (tau < 1.6 ? ['ERROR', 'flare'] : ['ERRORS', 'flare storm']),
    camAt: () => 'flare',
    init(tape) { holdBaseline(tape); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = 'working';
      s.activity = 0.55;
      workStream(tape, prev, tau, 0, Infinity, 0.5, 'hold-s');
      for (const et of [0.6, 1.6, 2.1]) {
        if (once(prev, tau, et)) { tape.call(et, 'Bash', null, false); tape.error(et, 'Bash'); }
      }
      // Keep failing every ~4 s so the storm holds.
      periodic(prev, tau, 4, Infinity, 4, 'hold-se', (k, tk) => {
        tape.call(tk, 'Edit', FILES[k % 4], false);
        tape.error(tk, 'Edit');
      });
    },
  },
  {
    key: 'needs-me', label: 'Needs me', dur: Infinity, loop: false,
    labelAt: (tau) => (tau < 1 ? ['WORKING', ''] : ['NEEDS ME', 'quasar · permission']),
    camAt: () => 'quasar',
    init(tape) { holdBaseline(tape); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = tau < 1 ? 'working' : 'needs-me';
      s.needsKind = s.mode === 'needs-me' ? 'permission' : null;
      s.activity = tau < 1 ? 0.6 : 0;
      workStream(tape, prev, tau, 0, 0.9, 0.3, 'hold-n');
    },
  },
  {
    key: 'my-move', label: 'My move', dur: Infinity, loop: false,
    labelAt: (tau) => (tau < 1 ? ['WORKING', ''] : ['MY MOVE', 'beacon']),
    camAt: () => 'system',
    init(tape) { holdBaseline(tape); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = tau < 1 ? 'working' : 'my-move';
      s.activity = tau < 1 ? 0.6 : 0;
      s.idleFor = 0;
      workStream(tape, prev, tau, 0, 0.9, 0.3, 'hold-m');
    },
  },
  {
    key: 'compaction', label: 'Compaction', dur: 12.5, loop: true,
    labelAt: () => ['COMPACTION', 'black hole'],
    camAt: () => 'compaction',
    init(tape) { holdBaseline(tape, { tokens: 2.2e6, fill: 0.95 }); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = 'working';
      s.activity = tau < 1.2 ? 0.55 : 0.3;
      s.contextFill = kf(tau, [0, 0.95, 1.2, 0.98, 4.4, 0.98, 6.2, 0.2]);
      s.tokens.total = Math.round(kf(tau, [0, 2.2e6, 1.2, 2.3e6]));
      workStream(tape, prev, tau, 0, 1.1, 0.25, 'hold-c');
      if (once(prev, tau, 1.2)) tape.compaction(COMPACTION_ID, 1.2, 190000, 61000);
    },
  },
  {
    key: 'idle', label: 'Idle', dur: 13, loop: true,
    labelAt: (tau) => (tau < 0.6 ? ['MY MOVE', 'beacon'] : ['IDLE', `idle ${Math.round(kf(tau, [1, 0, 10, 1]) * 24)}h · planets age, the system hazes over`]),
    camAt: () => 'system',
    init(tape) { holdBaseline(tape); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = tau < 0.6 ? 'my-move' : 'idle';
      s.activity = 0;
      s.idleFor = s.mode === 'idle' ? kf(tau, [1, 0, 10, 1]) : 0;
      s.endedAt = tau >= 0.6 ? tape.at(0.6) : null;
    },
  },
  {
    key: 'crashed', label: 'Crashed', dur: Infinity, loop: false,
    labelAt: (tau) => (tau < 1.5 ? ['WORKING', ''] : ['CRASHED', 'remnant']),
    camAt: () => 'system',
    init(tape) { holdBaseline(tape, { tokens: 1.5e6, fill: 0.55 }); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = tau < 1.5 ? 'working' : 'crashed';
      s.activity = tau < 1.5 ? 0.7 : 0;
      s.endedAt = tau >= 1.5 ? tape.at(1.5) : null;
      workStream(tape, prev, tau, 0, 1.4, 0.35, 'hold-x');
    },
  },
  {
    key: 'tokens', label: 'Tokens', dur: 16, loop: true,
    labelAt: () => ['TOKENS', 'belt = tokens spent · color = context fill'],
    camAt: () => 'system',
    init(tape) { tape.preload(HOLD_EDITS); },
    run(tape, prev, tau) {
      const s = tape.state;
      s.mode = 'working';
      s.activity = 0.5;
      const k = Math.min(1, tau / 14);
      s.tokens.total = Math.round(10e3 * Math.pow(800, k));   // 10 k → 8 M
      s.contextFill = 1.02 * smoothstep(0, 1, k);
      workStream(tape, prev, tau, 0, Infinity, 0.6, 'hold-k');
    },
  },
];

// Replay: a placeholder until /api/replay answers, then the real scene.
// The placeholder draws a dead ember: no scripted data ever wears the REPLAY name.
let replayStatus = 'loading real transcript…';
SCENES.push({
  key: 'replay', label: 'Replay', dur: Infinity, loop: false, real: true,
  labelAt: () => ['REPLAY', replayStatus],
  camAt: () => 'system',
  init() {},
  run(tape) {
    const s = tape.state;
    s.mode = 'idle'; s.idleFor = 1; s.activity = 0; s.contextFill = 0; s.tokens.total = 0;
  },
});

const SCENE_BY_KEY = new Map(SCENES.map((s) => [s.key, s]));
const HOLD_KEYS = SCENES.filter((s) => !s.hidden).map((s) => s.key);
// The looping reel: the session's whole life, then (separately) a crash.
const PLAYLIST = [{ key: 'life', dur: 40 }, { key: 'crashed', dur: 7.5 }];
const PLAYLIST_DUR = PLAYLIST.reduce((a, p) => a + p.dur, 0);

// ------------------------------------------------------------------ driver

class Director {
  constructor() {
    this.tape = new Tape();
    this.playing = true;          // data clock advancing
    this.sequence = true;         // true: looping reel; false: holding one scene
    this.item = 0;                // playlist index (sequence mode)
    this.scene = null;
    this.tau = 0;
    this.lastNow = EPOCH0 + 1;
    this.cameraKey = null;
    this.cameraForce = true;
  }

  /** Start a scene from τ = 0 with `now` strictly behind the last frame (→ reset). */
  _start(key) {
    this.scene = SCENE_BY_KEY.get(key);
    this.tau = 0;
    const epoch = Math.min(EPOCH0, this.lastNow - 10);
    this.tape.begin(epoch);
    this.scene.init(this.tape);
    this._run(-1e-6, 0);
  }

  _run(prev, cur) {
    const tape = this.tape;
    tape.state.now = tape.at(cur);
    this.scene.run(tape, prev, cur);
    tape.prune();
    this.lastNow = tape.state.now;
  }

  playSequence() {
    this.sequence = true;
    this.item = 0;
    this.playing = true;
    this.cameraForce = true;
    this._start(PLAYLIST[0].key);
  }

  hold(key) {
    if (!SCENE_BY_KEY.has(key)) return;
    this.sequence = false;
    this.playing = true;
    this.cameraForce = true;
    this._start(key);
  }

  step(dt) {
    if (!this.playing) return;
    const prev = this.tau;
    let cur = prev + dt;
    if (this.sequence) {
      if (cur >= PLAYLIST[this.item].dur) {
        this.item = (this.item + 1) % PLAYLIST.length;
        this._start(PLAYLIST[this.item].key);
        return;
      }
    } else if (this.scene.loop && cur >= this.scene.dur) {
      this._start(this.scene.key);
      return;
    }
    this.tau = cur;
    this._run(prev, cur);
  }

  /** Progress through the reel, 0..1 (sequence mode only). */
  get progress() {
    let t = this.tau;
    for (let i = 0; i < this.item; i++) t += PLAYLIST[i].dur;
    return t / PLAYLIST_DUR;
  }

  get label() { return this.scene.labelAt(this.tau); }
  get camera() { return this.scene.camAt(this.tau); }
  get state() { return this.tape.state; }
}

// ------------------------------------------------------------------ boot

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('cosmos');
const quality = ['high', 'medium', 'low'].includes(params.get('quality')) ? params.get('quality') : 'high';
const engine = createEngine(canvas, { quality });

const director = new Director();
const startKey = params.get('scene');
if (startKey && SCENE_BY_KEY.has(startKey) && startKey !== 'life') director.hold(startKey);
else director.playSequence();

let system = new StarSystem(engine.scene, engine.ctx, director.state);

// Real transcript for the Replay scene (?replay=<session id> picks one).
const fileFor = (() => {
  const files = new Map();
  return (path) => {
    let f = files.get(path);
    if (!f) {
      const cut = path.lastIndexOf('/');
      f = { id: `f:${path}`, path, folder: `d:${cut > 0 ? path.slice(0, cut) : '.'}` };
      files.set(path, f);
    }
    return f;
  };
})();
loadReplay(params.get('replay'))
  .then((data) => {
    if (!data) { replayStatus = 'no transcript available'; return; }
    SCENE_BY_KEY.set('replay', createReplayScene(data, fileFor));
    if (!director.sequence && director.scene.key === 'replay') director.hold('replay');
  })
  .catch(() => { replayStatus = 'replay unavailable (server offline?)'; });
engine.onQuality(() => {
  // Objects read quality at construction (CONTRACT §1): rebuild the system.
  system.dispose();
  system = new StarSystem(engine.scene, engine.ctx, director.state);
});

let mono = params.get('mono') === '1';
engine.setDebugView(mono ? 'mono' : null);

// --- camera direction: scripted moves only when the owner isn't steering
let lastInputMs = -Infinity;
engine.controls.onInput(() => { lastInputMs = performance.now(); });
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const camOffset = new THREE.Vector3();
const sph = new THREE.Spherical();
const sphNow = new THREE.Spherical();

function applyCamera(key, seconds) {
  const p = CAMERAS[key];
  camTarget.fromArray(p.target);
  camPos.fromArray(p.pos);
  if (p.keepAzimuth) {
    // Same distance and elevation as the preset, around the current azimuth.
    sph.setFromVector3(camOffset.subVectors(camPos, camTarget));
    sphNow.setFromVector3(camOffset.subVectors(engine.camera.position, engine.controls.target));
    sph.theta = sphNow.theta;
    camPos.setFromSpherical(sph).add(camTarget);
  }
  engine.controls.flyTo(camPos, camTarget, seconds);
}

function directCamera() {
  const key = director.camera;
  if (key === director.cameraKey && !director.cameraForce) return;
  const userIdle = (performance.now() - lastInputMs) / 1000 > USER_IDLE_FOR_CAMERA;
  if (director.cameraForce || userIdle) {
    applyCamera(key, director.cameraKey === null ? 0 : 2.4);
  }
  director.cameraKey = key;
  director.cameraForce = false;
}

// --- frame: script → SystemState → StarSystem (the only coupling)
// tSkew lets the debug `advance()` fast-forward the render clock while keeping
// it monotonic (objects assume t never goes back).
let tSkew = 0;
function frame(dt, t) {
  director.step(dt);
  directCamera();
  const hint = system.update(director.state, dt, t);
  ui.sync();
  return hint;
}
engine.onFrame((dt, t) => frame(dt, t + tSkew));

// ------------------------------------------------------------------ UI

const ui = (() => {
  const elState = document.getElementById('state');
  const elNote = document.getElementById('note');
  const elBar = document.getElementById('scenes');
  const elPlay = document.getElementById('play');
  const elReel = document.getElementById('reel');
  const elMono = document.getElementById('mono');
  const elProgress = document.getElementById('progress');
  const elDemo = document.getElementById('demo');

  const buttons = new Map();
  HOLD_KEYS.forEach((key, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = SCENE_BY_KEY.get(key).label;
    b.title = i < 10 ? `${b.textContent} (key ${(i + 1) % 10})` : b.textContent;
    b.addEventListener('click', () => { director.hold(key); b.blur(); engine.wake(1); });
    elBar.appendChild(b);
    buttons.set(key, b);
  });

  elReel.addEventListener('click', () => { director.playSequence(); elReel.blur(); engine.wake(1); });
  elPlay.addEventListener('click', () => { togglePlay(); elPlay.blur(); });
  elMono.addEventListener('click', () => { toggleMono(); elMono.blur(); });

  let shownLabel = '';
  let shownNote = '';
  let shownKey = '';
  let shownPlaying = null;
  let shownMono = null;
  let shownProgress = -1;
  let shownReal = null;

  return {
    sync() {
      const [label, note] = director.label;
      if (label !== shownLabel) { elState.textContent = label; shownLabel = label; }
      if (note !== shownNote) { elNote.textContent = note; shownNote = note; }
      const key = director.sequence ? 'life' : director.scene.key;
      if (key !== shownKey) {
        for (const [k, b] of buttons) b.classList.toggle('on', k === key);
        elReel.classList.toggle('on', key === 'life');
        shownKey = key;
      }
      if (director.playing !== shownPlaying) {
        elPlay.textContent = director.playing ? 'Pause' : 'Play';
        elPlay.setAttribute('aria-pressed', String(!director.playing));
        shownPlaying = director.playing;
      }
      // DEMO tag only on scripted scenes; the replay is real data.
      const real = !director.sequence && director.scene.real === true;
      if (real !== shownReal) {
        elDemo.textContent = real ? 'REPLAY · real transcript' : 'DEMO · scripted states';
        elDemo.title = real ? 'Driven by one real session transcript (structure only)' : 'Driven by scripted SystemState values, not real session data';
        shownReal = real;
      }
      if (mono !== shownMono) { elMono.classList.toggle('on', mono); shownMono = mono; }
      const p = director.sequence ? Math.round(director.progress * 1000) / 1000 : 0;
      if (p !== shownProgress) {
        elProgress.style.transform = `scaleX(${p})`;
        elProgress.style.opacity = director.sequence ? '1' : '0';
        shownProgress = p;
      }
    },
  };
})();

function togglePlay() {
  director.playing = !director.playing;
  engine.wake(0.5);
}

function toggleMono() {
  mono = !mono;
  engine.setDebugView(mono ? 'mono' : null);
}

function stepScene(dir) {
  const cur = director.sequence ? -1 : HOLD_KEYS.indexOf(director.scene.key);
  const n = HOLD_KEYS.length;
  const next = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
  director.hold(HOLD_KEYS[next]);
  engine.wake(1);
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.code === 'ArrowRight') { e.preventDefault(); stepScene(1); return; }
  if (e.code === 'ArrowLeft') { e.preventDefault(); stepScene(-1); return; }
  if (e.code === 'KeyM') { toggleMono(); return; }
  if (e.code === 'KeyR') { director.playSequence(); engine.wake(1); return; }
  const m = /^Digit(\d)$/.exec(e.code);
  if (m) {
    const i = (Number(m[1]) + 9) % 10;   // 1 → first scene … 0 → tenth
    if (i < HOLD_KEYS.length) { director.hold(HOLD_KEYS[i]); engine.wake(1); }
  }
});

// Debugging handle (CONTRACT §0 allows this one global).
window.__cosmos = {
  engine,
  get system() { return system; },
  director,
  setScene(name) { if (name === 'life') director.playSequence(); else director.hold(name); },
  /** Fast-forward `seconds` of data and render time without drawing (stills / QA). */
  advance(seconds, step = 1 / 30) {
    for (let s = 0; s < seconds; s += step) {
      tSkew += step;
      engine.controls.update(step);
      frame(step, engine.time + tSkew);
    }
    engine.wake(0.5);
  },
};
