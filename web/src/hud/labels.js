// Cosmos LENS: network-map labels over the galaxy.
//
// GALAXY_CONTRACT §7:
//   createLabels(rootEl /* #labels */, { galaxy, store }) -> {
//     setHidden(on), get hidden, setDensity('sparse'|'normal'|'dense'),
//     stats(): { shown, culled, candidates, ms }, dispose() }
//
// - Updates in galaxy.onAfterFrame, at most 30 Hz, after positions are final.
// - A fixed pool of ≤ 60 DOM nodes, moved with translate3d. Text and classes are
//   written only when they change; no per-frame object allocation in the hot
//   path (strings for transforms excepted).
// - Level of detail from galaxy.view().level; priority declutter with a greedy
//   screen-space rectangle test. NEEDS ME labels are placed first and never
//   culled. Text is real names / record numbers only.
// - `L` (HUD keys.js) calls setHidden; the choice persists in localStorage
//   ('cosmos.labels.v1', W13) and starts from settings.labels.enabled.

import { MODE } from '../shared/schema.mjs';
import { GLOSSARY, fmt, anchorKeyOf } from './hover.js';
import { createOccluders } from './occluders.js';

const POOL = 60;
const MIN_DT = 1 / 30;
const LS_KEY = 'cosmos.labels.v1';
const MAX_BY_DENSITY = { sparse: 24, normal: 42, dense: 60 };
const TITLE_MAX = 28;          // label text is capped; the full title is in the hover popup
const RESERVED_MAX = 48;       // HUD panels + quasar glyphs held as occupied space
const QUASAR_HALF_W = 14, QUASAR_HALF_H = 20;   // the hourglass glyph's screen box (36 px tall)

/** Cap a label line at n characters with an ellipsis. */
function cap(s, n = TITLE_MAX) {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Priorities (contract §7).
const P = { NEEDS: 100, SELECTED: 90, HOVERED: 85, ARM: 70, MYMOVE: 60, CLUSTER: 55, WORKING: 50, SHIP: 45, COMPACTION: 42, FILE: 40, CORE: 35, IDLE: 30, DEAD: 10, LINK: 5 };

// Candidate offsets (relative to the object): right, left, above, below.
const SIDES = 4;

function readPrefs() {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
function writePrefs(v) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* private window / blocked storage: ignore */ }
}

export function createLabels(rootEl, { galaxy, store, occluders = null }) {
  const occ = occluders || createOccluders();
  const ownOcc = !occluders;
  rootEl.classList.add('lens-labels');
  rootEl.setAttribute('aria-hidden', 'true');

  // --- settings / prefs -----------------------------------------------------
  const s0 = (store.settings && store.settings.labels) || {};
  const prefs = readPrefs();
  let hidden = prefs && typeof prefs.hidden === 'boolean' ? prefs.hidden : s0.enabled === false;
  let density = (prefs && MAX_BY_DENSITY[prefs.density] && prefs.density) || (MAX_BY_DENSITY[s0.density] ? s0.density : 'normal');
  let numbers = s0.numbers !== false;

  // --- pool -------------------------------------------------------------------
  const nodes = new Array(POOL);
  for (let i = 0; i < POOL; i++) {
    const n = document.createElement('div');
    n.className = 'lbl';
    const g = document.createElement('span'); g.className = 'lbl__g';
    const t = document.createElement('span'); t.className = 'lbl__t';
    const s = document.createElement('span'); s.className = 'lbl__s';
    n.append(g, t, s);
    n.style.visibility = 'hidden';
    rootEl.appendChild(n);
    nodes[i] = { n, g, t, s, key: '', cls: '', gT: '', tT: '', sT: '', x: -1e4, y: -1e4, op: -1, on: false };
  }

  // --- text measurement (canvas, no layout reflow) ----------------------------
  const mctx = document.createElement('canvas').getContext('2d');
  let fontFamily = 'system-ui, sans-serif';
  let monoFamily = 'ui-monospace, Menlo, monospace';
  function refreshFont() {
    try {
      fontFamily = getComputedStyle(rootEl).fontFamily || fontFamily;
      monoFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || monoFamily;
    } catch { /* ignore */ }
  }
  refreshFont();
  function measure(text, px, weight, mono) {
    if (!text) return 0;
    mctx.font = weight + ' ' + px + 'px ' + (mono ? monoFamily : fontFamily);
    return mctx.measureText(text).width;
  }

  // --- per-anchor cache: text / priority / size, rebuilt only when inputs change
  const cache = new Map();   // key -> Entry
  function entryFor(key) {
    let e = cache.get(key);
    if (!e) {
      e = { key, a: null, prio: 0, cls: '', g: '', t: '', s: '', w: 0, h: 0, stamp: '', k: [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined], seen: 0, show: false, x: 0, y: 0, op: 1, side: 0 };
      cache.set(key, e);
    }
    return e;
  }

  // Selection / hover keys, recomputed on events (not per frame).
  let selKey = anchorKeyOf(store.selection);
  let hovKey = anchorKeyOf(store.hovered);
  const offs = [];
  offs.push(store.on('selection', (sel) => { selKey = anchorKeyOf(sel); }));
  offs.push(store.on('hover', (sel) => { hovKey = anchorKeyOf(sel); }));
  offs.push(store.on('settings', () => {
    const l = (store.settings && store.settings.labels) || {};
    numbers = l.numbers !== false;
    if (!readPrefs()) { if (MAX_BY_DENSITY[l.density]) density = l.density; setHiddenInner(l.enabled === false, false); }
    cache.clear();
  }));

  /** Field-wise change check (no string building): returns true and stores when any input differs. */
  function diff(e, kind, a, b, c, d, f, g, h, i, j) {
    const k = e.k;
    if (k[0] === kind && k[1] === a && k[2] === b && k[3] === c && k[4] === d && k[5] === f && k[6] === g && k[7] === h && k[8] === i && k[9] === j) return false;
    k[0] = kind; k[1] = a; k[2] = b; k[3] = c; k[4] = d; k[5] = f; k[6] = g; k[7] = h; k[8] = i; k[9] = j;
    return true;
  }

  // --- text builders ---------------------------------------------------------
  function stateLine(rec, now) {
    const st = rec.state || {};
    const m = st.mode;
    if (m === MODE.NEEDS_ME) {
      const sub = GLOSSARY.subs[st.sub];
      return 'NEEDS ME' + (sub ? ' · ' + sub.word : '') + ' · ' + fmt.short(now - st.since) + (st.badges && st.badges.includes('unverified') ? ' ?' : '');
    }
    if (m === MODE.WORKING) {
      let s = 'WORKING';
      if (st.sub === 'tool' && st.tool) s += ' · ' + fmt.tool(st.tool) + (st.target ? ' → ' + fmt.base(st.target) : '');
      else if (st.sub === 'retrying') s += ' · retrying';
      else if (st.sub === 'generating') s += ' · writing';
      if (st.badges && st.badges.includes('stalled')) s += ' · stalled';
      return s;
    }
    if (m === MODE.MY_MOVE) return 'MY MOVE' + (st.badges && st.badges.includes('ships-out') ? ' · ships out' : '');
    const quiet = rec.times && rec.times.lastActivity ? now - rec.times.lastActivity : null;
    if (m === MODE.IDLE) return 'IDLE ' + fmt.short(quiet);
    if (m === MODE.CRASHED) return st.remnant === 'crashed-api' ? 'CRASHED · API' : 'CRASHED';
    if (m === MODE.DEAD) {
      const r = st.remnant && GLOSSARY.remnants[st.remnant];
      return (r && st.remnant !== 'ended' ? r.word : 'DEAD') + (quiet != null ? ' · ' + fmt.short(quiet) : '');
    }
    return String(m || '').toUpperCase();
  }

  function numbersLine(rec) {
    const tk = rec.tokens, cx = rec.context;
    return (tk ? fmt.compact(tk.total) + ' tok' : '') + (cx && cx.fill != null ? ' · ctx ' + fmt.pct(cx.fill) : '');
  }

  const MODE_CLASS = { 'needs-me': 'is-needs', 'my-move': 'is-mymove', working: 'is-working', idle: 'is-idle', dead: 'is-dead', crashed: 'is-crashed' };

  function findById(arr, id) { if (arr) for (let i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }

  /**
   * Fill entry text/priority for an anchor at this LOD. Returns false when the
   * anchor gets no label at this level (or has nothing real to say).
   */
  function build(e, a, level, now) {
    const sys = level === 'system' || level === 'close';
    let rec = null;
    switch (a.kind) {
      case 'arm': {
        const arm = store.arms && store.arms.get(a.armKey);
        if (!arm) return false;
        if (level === 'close') return false;
        const n = arm.sessionIds ? arm.sessionIds.length : 0;
        if (diff(e, 1, arm.name, n)) { e.g = ''; e.t = arm.name; e.s = n + (n === 1 ? ' session' : ' sessions'); e.cls = 'lbl--arm'; e.w = 0; }
        e.prio = P.ARM;
        return true;
      }
      case 'core': {
        if (level !== 'galaxy') return false;
        if (diff(e, 2)) { e.g = ''; e.t = 'Core'; e.s = ''; e.cls = 'lbl--core'; e.w = 0; }
        e.prio = P.CORE;
        return true;
      }
      case 'cluster': {
        rec = store.get(a.sid);
        // Worktree names are noise in the overview: arm level or closer only.
        if (!rec || !rec.worktree || (level === 'galaxy' && e.key !== selKey && e.key !== hovKey)) return false;
        if (diff(e, 3, rec.worktree.name)) { e.g = '⎇'; e.t = cap(rec.worktree.name); e.s = 'worktree'; e.cls = 'lbl--cluster'; e.w = 0; }
        e.prio = P.CLUSTER;
        return true;
      }
      case 'system': {
        rec = store.get(a.sid);
        if (!rec) return false;
        const st = rec.state || {};
        const m = st.mode;
        const isSel = e.key === selKey, isHov = e.key === hovKey;
        let prio;
        if (m === MODE.NEEDS_ME) prio = P.NEEDS;
        else if (m === MODE.MY_MOVE) prio = P.MYMOVE;
        else if (m === MODE.WORKING) prio = P.WORKING;
        else if (m === MODE.IDLE) prio = P.IDLE;
        else prio = P.DEAD;
        // LOD gate (selected / hovered / needs-me always pass).
        if (prio !== P.NEEDS && !isSel && !isHov) {
          if (level === 'galaxy') {
            if (m === MODE.MY_MOVE) { if (density === 'sparse') return false; }
            else if (m === MODE.WORKING) { if (density !== 'dense') return false; }
            else return false;
          } else if (level === 'arm') {
            if ((m === MODE.DEAD || m === MODE.CRASHED) && density === 'sparse') return false;
          }
        }
        if (isSel) prio = Math.max(prio, P.SELECTED);
        else if (isHov) prio = Math.max(prio, P.HOVERED);
        // Seconds-resolution stamp so the wait / idle clock ticks without rebuilding every frame.
        const showNum = numbers && (sys || isSel);
        const clock = m === MODE.NEEDS_ME || m === MODE.IDLE || m === MODE.DEAD ? Math.floor(now) : 0;
        const nb = st.badges ? st.badges.length : 0;
        if (diff(e, 4, rec.title, m, st.sub, st.tool, st.target, st.remnant, nb ? st.badges[0] + (nb > 1 ? st.badges[1] : '') : '', clock,
          showNum ? ((rec.tokens && rec.tokens.total) || 0) + ((rec.context && rec.context.fill) || 0) * 1e-3 : -1)) {
          const mg = GLOSSARY.modes[m];
          e.g = mg ? mg.glyph : '';
          e.t = cap(rec.title || rec.id.slice(0, 8));
          // Galaxy level: needs-me / my-move show the title + state word only.
          e.s = stateLine(rec, now) + (showNum ? '  ' + numbersLine(rec) : '');
          e.cls = 'lbl--sys ' + (MODE_CLASS[m] || '') + (rec.worktree ? ' is-wt' : '');
          e.w = 0;
        }
        e.prio = prio;
        return true;
      }
      case 'file': case 'folder': {
        if (!sys && e.key !== selKey && e.key !== hovKey) return false;
        rec = store.get(a.sid);
        if (!rec) return false;
        const it = findById(a.kind === 'file' ? rec.files : rec.folders, a.id);
        if (!it) return false;
        const close = level === 'close';
        if (diff(e, 5, it.path, it.edits, it.reads, close, it.plan)) {
          e.g = '';
          e.t = a.kind === 'file' ? fmt.base(it.path) : fmt.base(it.path) + '/';
          e.s = close || a.kind === 'folder' ? (it.edits ? '×' + it.edits + ' edit' + (it.edits === 1 ? '' : 's') : 'read') + (it.plan ? ' · plan' : '') : '';
          e.cls = 'lbl--file' + (it.edits ? '' : ' is-read');
          e.w = 0;
        }
        e.prio = P.FILE + Math.min(4, (it.edits || 0) * 0.25);
        return true;
      }
      case 'ship': {
        if (!sys && e.key !== selKey && e.key !== hovKey) return false;
        rec = store.get(a.sid);
        if (!rec) return false;
        const sh = findById(rec.ships, a.id);
        if (!sh) return false;
        if (diff(e, 6, sh.label, sh.model, sh.active, numbers ? sh.tokens : -1)) {
          e.g = '↗';
          e.t = cap(sh.label || sh.type || 'subagent');
          e.s = fmt.model(sh.model) + (numbers && sh.tokens ? ' · ' + fmt.compact(sh.tokens) + ' tok' : '') + (sh.active ? '' : ' · back');
          e.cls = 'lbl--ship';
          e.w = 0;
        }
        e.prio = P.SHIP;
        return true;
      }
      case 'compaction': {
        if (!sys && e.key !== selKey && e.key !== hovKey) return false;
        rec = store.get(a.sid);
        if (!rec) return false;
        const c = findById(rec.compactions, a.id);
        if (!c) return false;
        if (diff(e, 7, c.preTokens, c.postTokens)) {
          e.g = '◉'; e.t = 'compacted';
          e.s = fmt.compact(c.preTokens) + ' → ' + fmt.compact(c.postTokens);
          e.cls = 'lbl--bh'; e.w = 0;
        }
        e.prio = P.COMPACTION;
        return true;
      }
      case 'link': {
        if (!galaxy.mapMode) return false;
        // key: 'link:<a>><b>'. Only label links we can name from the data.
        const body = a.key.slice(5);
        const gt = body.indexOf('>');
        if (gt < 0) return false;
        const A = body.slice(0, gt), B = body.slice(gt + 1);
        const rb = store.get(B), ra = store.get(A);
        // At galaxy level only links that touch what matters get a label:
        // NEEDS ME, YOUR MOVE, or the selection.
        if (level === 'galaxy') {
          const hot = (r) => r && (r.state?.mode === MODE.NEEDS_ME || r.state?.mode === MODE.MY_MOVE);
          const selSid = store.selection?.sid;
          if (a.id === 'arm' || a.id === 'cluster') return false;
          if (!hot(ra) && !hot(rb) && !(selSid && (selSid === A || selSid === B))) return false;
        }
        let text = '';
        if (a.id === 'arm') {
          // Session → its arm: a short arm-name tag (arm level and closer).
          if (level === 'close') return false;
          const arm = store.arms && store.arms.get(B.startsWith('arm:') ? B.slice(4) : B);
          if (arm) text = '→ ' + arm.name;
        } else if (rb && rb.forkOf === A) text = 'fork of ' + cap(ra ? ra.title : A.slice(0, 8), 22);
        else if (ra && ra.forkOf === B) text = 'fork of ' + cap(rb ? rb.title : B.slice(0, 8), 22);
        else if (rb && rb.spawnedFrom === A) text = 'started by ' + cap(ra ? ra.title : A.slice(0, 8), 22);
        else if (ra) { const sh = findById(ra.ships, B); if (sh) text = 'subagent · ' + cap(sh.label || sh.type || '', 22); }
        if (!text) return false;
        if (diff(e, 8, text)) { e.g = ''; e.t = text; e.s = ''; e.cls = 'lbl--link'; e.w = 0; }
        e.prio = P.LINK;
        return true;
      }
      default: return false;
    }
  }

  // --- layout constants (px) --------------------------------------------------
  const FS_T = 12, FS_S = 11, FS_ARM = 13, PADX = 6, LINE_T = 15, LINE_S = 13;
  function sizeOf(e) {
    if (e.w) return;
    const arm = e.cls === 'lbl--arm';
    const file = e.cls.startsWith('lbl--file');
    const wt = file ? measure(e.t, FS_S, 500, true) * 1.02 : measure(e.t, arm ? FS_ARM : FS_T, 600) * (arm ? 1.13 : 1.01);  // arm labels are letter-spaced; files are mono
    const ws = measure(e.s, FS_S, 500) * 1.05;
    const wg = e.g ? FS_T + 4 : 0;
    e.w = Math.ceil(Math.max(wt + wg, ws) + PADX * 2);
    e.h = (e.s ? LINE_T + LINE_S : LINE_T) + 4;
  }

  // --- placement state (reused) -----------------------------------------------
  const cands = [];         // Entry[] (reused)
  const rects = new Float32Array((POOL + RESERVED_MAX) * 4);
  let nRects = 0;
  let nHud = 0;             // the first nHud rects are HUD panels (labels never go under them)
  let shown = 0, culled = 0, lastMs = 0, lastCount = 0;
  let acc = 1;              // seconds since last update
  let frame = 0;

  function overlaps(x, y, w, h) {
    for (let i = 0; i < nRects; i++) {
      const o = i * 4;
      if (x < rects[o + 2] && x + w > rects[o] && y < rects[o + 3] && y + h > rects[o + 1]) return true;
    }
    return false;
  }
  function overlapsHud(x, y, w, h) {
    for (let i = 0; i < nHud; i++) {
      const o = i * 4;
      if (x < rects[o + 2] && x + w > rects[o] && y < rects[o + 3] && y + h > rects[o + 1]) return true;
    }
    return false;
  }
  function push(x, y, w, h) {
    if (nRects >= POOL + RESERVED_MAX) return;
    const o = nRects * 4; rects[o] = x - 2; rects[o + 1] = y - 1; rects[o + 2] = x + w + 2; rects[o + 3] = y + h + 1; nRects++;
  }
  function reserve(l, t, r, b) {
    if (nRects >= RESERVED_MAX) return;
    const o = nRects * 4; rects[o] = l; rects[o + 1] = t; rects[o + 2] = r; rects[o + 3] = b; nRects++;
  }

  function slot(e, a, side) {
    let r = Math.max(4, Math.min(a.size || 0, 120));
    // A NEEDS ME label sits beside its quasar glyph, never on it.
    if (e.prio === P.NEEDS) r = Math.max(r, QUASAR_HALF_W + 2);
    if (e.cls === 'lbl--arm' || e.cls === 'lbl--core' || e.cls === 'lbl--link') {
      e.x = a.x - e.w / 2; e.y = a.y - e.h / 2;          // centered on the anchor
      if (e.cls === 'lbl--core') e.y = a.y + r + 6;
      return;
    }
    switch (side) {
      case 0: e.x = a.x + r + 8; e.y = a.y - LINE_T / 2 - 2; break;         // right
      case 1: e.x = a.x - r - 8 - e.w; e.y = a.y - LINE_T / 2 - 2; break;   // left
      case 2: e.x = a.x - e.w / 2; e.y = a.y - r - 6 - e.h; break;          // above
      default: e.x = a.x - e.w / 2; e.y = a.y + r + 6; break;               // below
    }
  }

  const byPrio = (p, q) => (q.prio - p.prio) || (p.a.depth - q.a.depth);

  function update(dt) {
    acc += dt;
    if (hidden || acc < MIN_DT) return;
    acc = 0;
    const t0 = performance.now();
    frame++;
    const view = galaxy.view();
    const level = view.level || 'galaxy';
    const now = typeof store.now === 'function' ? store.now() : Date.now() / 1000;
    const anchors = galaxy.anchors();
    const W = rootEl.clientWidth || window.innerWidth, H = rootEl.clientHeight || window.innerHeight;

    cands.length = 0;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (!a.onScreen || a.behind) continue;
      const e = entryFor(a.key);
      e.seen = frame;
      e.a = a;
      if (!build(e, a, level, now)) continue;
      if (e.prio < P.SELECTED && e.key === selKey) e.prio = P.SELECTED;
      else if (e.prio < P.HOVERED && e.key === hovKey) e.prio = P.HOVERED;
      cands.push(e);
    }
    lastCount = cands.length;
    cands.sort(byPrio);

    nRects = 0; shown = 0; culled = 0;
    // Occupied before any label: the HUD panels / top bar / scrubber, then
    // every quasar glyph on screen (no label may cover a NEEDS ME beacon).
    const hud = occ.rects();
    for (let i = 0; i < hud.length; i++) reserve(hud[i].l, hud[i].t, hud[i].r, hud[i].b);
    nHud = nRects;
    const qs = typeof galaxy.quasars === 'function' ? galaxy.quasars() : null;
    if (qs) for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (q.onScreen && !q.behind) reserve(q.x - QUASAR_HALF_W, q.y - QUASAR_HALF_H, q.x + QUASAR_HALF_W, q.y + QUASAR_HALF_H);
    }
    const max = MAX_BY_DENSITY[density] || 42;
    for (let i = 0; i < cands.length; i++) {
      const e = cands[i];
      const a = e.a;
      e.show = false;
      if (shown >= POOL || (shown >= max && e.prio < P.NEEDS)) { culled++; continue; }
      sizeOf(e);
      const needs = e.prio === P.NEEDS || (e.cls.indexOf('is-needs') >= 0);
      let placed = false;
      // Try the remembered side first, then the others (stable labels don't jump).
      for (let k = 0; k < SIDES; k++) {
        const side = (e.side + k) % SIDES;
        slot(e, a, side);
        if (e.x < 2 || e.y < 2 || e.x + e.w > W - 2 || e.y + e.h > H - 2) { if (k === SIDES - 1 || e.cls === 'lbl--arm') break; continue; }
        if (!overlaps(e.x, e.y, e.w, e.h)) { e.side = side; placed = true; break; }
        if (e.cls === 'lbl--arm' || e.cls === 'lbl--core' || e.cls === 'lbl--link') break;
      }
      if (!placed && needs) {
        // NEEDS ME is never culled by other labels: stack it below (then above)
        // whatever is in the way, but never under a HUD panel. If its star is
        // itself under a panel, the edge marker takes over (beacons.js).
        for (let dir = 1; dir >= -1 && !placed; dir -= 2) {
          slot(e, a, e.side);
          let guard = 0;
          while (overlaps(e.x, e.y, e.w, e.h) && !overlapsHud(e.x, e.y, e.w, e.h) && guard++ < 6) e.y += dir * (e.h + 2);
          if (!overlapsHud(e.x, e.y, e.w, e.h) && e.y >= 2 && e.y + e.h <= H - 2) placed = true;
        }
        if (!placed) {
          for (let k = 0; k < SIDES && !placed; k++) { slot(e, a, k); if (!overlapsHud(e.x, e.y, e.w, e.h)) placed = true; }
        }
      }
      if (!placed) { culled++; continue; }
      e.x = Math.max(2, Math.min(W - e.w - 2, e.x));
      e.y = Math.max(2, Math.min(H - e.h - 2, e.y));
      if (!needs && overlapsHud(e.x, e.y, e.w, e.h)) { culled++; continue; }   // clamping pushed it under a panel
      push(e.x, e.y, e.w, e.h);
      // Atmospheric depth (contract layer 0/1/2) dims far labels; needs-me never dims.
      e.op = needs || e.key === selKey ? 1 : a.layer === 2 ? 0.55 : a.layer === 1 ? 0.78 : 1;
      if (e.cls.indexOf('is-dead') >= 0 || e.cls.indexOf('is-crashed') >= 0) e.op *= 0.8;
      e.show = true;
      shown++;
    }

    // Write to the pool: reuse the node that showed the same key last time.
    let used = 0;
    for (let i = 0; i < POOL; i++) nodes[i].on = false;
    for (let i = 0; i < cands.length && used < POOL; i++) {
      const e = cands[i];
      if (!e.show) continue;
      let nd = null;
      for (let j = 0; j < POOL; j++) if (!nodes[j].on && nodes[j].key === e.key) { nd = nodes[j]; break; }
      if (!nd) for (let j = 0; j < POOL; j++) if (!nodes[j].on && !isWanted(nodes[j].key)) { nd = nodes[j]; break; }
      if (!nd) for (let j = 0; j < POOL; j++) if (!nodes[j].on) { nd = nodes[j]; break; }
      if (!nd) break;
      nd.on = true; used++;
      writeNode(nd, e);
    }
    for (let i = 0; i < POOL; i++) {
      const nd = nodes[i];
      if (!nd.on && nd.key) { nd.key = ''; nd.n.style.visibility = 'hidden'; }
    }

    // Prune cache entries not seen for ~10 s of updates.
    if ((frame & 255) === 0) for (const [k, e] of cache) if (frame - e.seen > 300) cache.delete(k);
    lastMs = performance.now() - t0;
  }

  function isWanted(key) {
    if (!key) return false;
    const e = cache.get(key);
    return !!(e && e.show && e.seen === frame);
  }

  function writeNode(nd, e) {
    const sel = e.key === selKey, hov = e.key === hovKey;
    const cls = 'lbl ' + e.cls + (sel ? ' is-sel' : '') + (hov ? ' is-hov' : '') + (e.s ? '' : ' no-sub');
    if (nd.key !== e.key) { nd.key = e.key; nd.n.dataset.key = e.key; }
    if (nd.cls !== cls) { nd.cls = cls; nd.n.className = cls; }
    if (nd.gT !== e.g) { nd.gT = e.g; nd.g.textContent = e.g; }
    if (nd.tT !== e.t) { nd.tT = e.t; nd.t.textContent = e.t; }
    if (nd.sT !== e.s) { nd.sT = e.s; nd.s.textContent = e.s; }
    const x = Math.round(e.x * 2) / 2, y = Math.round(e.y * 2) / 2;
    if (x !== nd.x || y !== nd.y) { nd.x = x; nd.y = y; nd.n.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'; }
    if (e.op !== nd.op) { nd.op = e.op; nd.n.style.opacity = String(e.op); }
    if (nd.n.style.visibility !== 'visible') nd.n.style.visibility = 'visible';
  }

  const offFrame = galaxy.onAfterFrame(update);

  function setHiddenInner(on, persist) {
    hidden = !!on;
    rootEl.classList.toggle('is-hidden', hidden);
    if (hidden) for (let i = 0; i < POOL; i++) { nodes[i].key = ''; nodes[i].n.style.visibility = 'hidden'; }
    else acc = 1;
    if (persist) writePrefs({ hidden, density });
  }
  setHiddenInner(hidden, false);

  return {
    setHidden(on) { setHiddenInner(on, true); },
    toggle() { setHiddenInner(!hidden, true); return hidden; },
    get hidden() { return hidden; },
    setDensity(d) { if (!MAX_BY_DENSITY[d]) return; density = d; for (const e of cache.values()) e.k[0] = undefined; acc = 1; writePrefs({ hidden, density }); },
    get density() { return density; },
    stats() { return { shown, culled, candidates: lastCount, ms: Math.round(lastMs * 100) / 100, hidden, density }; },
    dispose() {
      offFrame && offFrame();
      for (const off of offs) off && off();
      if (ownOcc) occ.dispose();
      for (let i = 0; i < POOL; i++) nodes[i].n.remove();
      cache.clear();
      rootEl.classList.remove('lens-labels', 'is-hidden');
    },
  };
}
