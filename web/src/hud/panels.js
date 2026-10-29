// panels.js: the HUD status panels (GALAXY_CONTRACT §6) and the small DOM
// helpers the other HUD modules share.
//
//   needs     Needs me: every session waiting on the owner, wait clock ticking, Jump.
//   live      Sessions: every session in urgency order; click = select + fly.
//   feed      Activity: FEED_TYPES events, newest on top, max 200; click = diagnose.
//   selected  Selected object: the real fields of whatever is selected.
//   totals    Totals: sessions by state, tokens today, errors today, ...
//   minimap   (chrome only; minimap.js draws inside the body)
//
// Every panel can collapse, be dragged (it docks into the left/right column when
// dropped near a side, otherwise it floats and snaps to the 4 edges), and hide.
// Floating panels are pushed out of the central 50% x 60% of the screen.
// Layout and flags persist in localStorage['cosmos.hud.v1'] (try/catch).
//
// Numbers shown here are the record fields themselves (store records), so the
// scene and the panels show the same values. Nothing here fetches except
// store.fetchSession() for a selected file/ship not in the lite record.
//
// No module-level mutable state: everything lives in the factory closures.

import { FEED_TYPES, DIAG_TYPES } from '../shared/schema.mjs';
import { humanTool } from './hover.js';

// ------------------------------------------------------------------ DOM helpers

/** Tiny element builder: h('div.cls.cls2', { attr }, ...children). */
export function h(sel, attrs, ...kids) {
  const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) el.className = m[2].slice(1).split('.').join(' ');
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;            // only ever used with our own static SVG strings
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Set textContent only when it changed (avoids layout churn). */
export function setText(el, s) {
  const v = s === null || s === undefined ? '' : String(s);
  if (el.textContent !== v) el.textContent = v;
}

export function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

/** localStorage wrapped: page must work when storage is blocked. */
export function loadPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
export function savePref(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}

// ------------------------------------------------------------------ formatters

export function fmtTokens(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}
export function fmtInt(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString();
}
export function fmtPct(f) {
  return f === null || f === undefined || !Number.isFinite(f) ? '—' : `${Math.round(f * 100)}%`;
}
/** Seconds → "42s", "3m 12s", "2h 05m", "3d 4h". */
export function fmtDur(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  s = Math.max(0, s);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
/** Short age: "now", "42s", "3m", "2h", "3d". */
export function fmtAge(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  if (s < 5) return 'now';
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
/** Epoch seconds → local "14:32:07". */
export function fmtClock(t) {
  if (!Number.isFinite(t)) return '—';
  return new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
/** Epoch seconds → local "Wed 29 Oct, 14:32:07". */
export function fmtStamp(t) {
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t * 1000);
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtClock(t)}`;
}
/** "claude-opus-5-5" → "opus 5.5"; "claude-haiku-4-5-20251001" → "haiku 4.5". */
export function fmtModel(m) {
  if (!m) return '—';
  let r = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  if (r) return `${r[1]} ${r[2]}.${r[3]}${m.includes('[1m]') ? ' 1M' : ''}`;
  r = /^claude-([a-z]+)-(\d+)(?:-\d{6,})?$/.exec(m);
  if (r) return `${r[1]} ${r[2]}`;
  r = /^claude-(\d+)-(\d+)-([a-z]+)/.exec(m);
  if (r) return `${r[3]} ${r[1]}.${r[2]}`;
  return m.replace(/^claude-/, '');
}
/** "mcp__Claude_Browser__browser_batch" → "browser_batch (Claude_Browser)"; plain tools unchanged. */
export function fmtTool(t) {
  return humanTool(t);
}
export function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}
export function clip(s, n) {
  s = s === null || s === undefined ? '' : String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ------------------------------------------------------------------ glyphs
// Static inline SVG (our own strings only). Every state has a shape, so the HUD
// reads without color (§9 rule).

const SVG = (body, vb = '0 0 14 14') =>
  `<svg viewBox="${vb}" width="14" height="14" aria-hidden="true" focusable="false">${body}</svg>`;

export const GLYPH = Object.freeze({
  // hourglass twin jets + core: the quasar
  'needs-me': SVG('<path d="M2.5 1.5h9L7 6.2z M2.5 12.5h9L7 7.8z" fill="currentColor"/><circle cx="7" cy="7" r="1.3" fill="currentColor"/>'),
  // calm ring around a steady core: your move
  'my-move': SVG('<circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="2" fill="currentColor"/>'),
  // hot core + tilted accretion disk: working
  working: SVG('<ellipse cx="7" cy="7" rx="6.2" ry="2.3" fill="none" stroke="currentColor" stroke-width="1.1" transform="rotate(-18 7 7)"/><circle cx="7" cy="7" r="2.6" fill="currentColor"/>'),
  // dim core inside a dotted haze: idle
  idle: SVG('<circle cx="7" cy="7" r="5.3" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="1.2 1.8"/><circle cx="7" cy="7" r="2.4" fill="currentColor" opacity=".55"/>'),
  // small cold ember: dead
  dead: SVG('<circle cx="7" cy="7" r="2.2" fill="currentColor"/>'),
  // shattered shell around a dim core: crashed
  crashed: SVG('<circle cx="7" cy="7" r="1.8" fill="currentColor"/><path d="M7 1.3l1.2 2.6-2.4 0z M12.4 8.6l-2.8.6.9-2.3z M2.4 10.6l1.6-2.3.9 2.3z" fill="currentColor"/>'),
  // hollow ghost outline: deleted / aged out
  husk: SVG('<circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 1.6"/>'),
  // sub-labels for needs-me
  approve: SVG('<path d="M7 1.2l4.8 1.8v3.6c0 3-2.2 5.2-4.8 6.2C4.4 11.8 2.2 9.6 2.2 6.6V3z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.6 7l1.7 1.7L9.5 5.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  question: SVG('<circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.2 5.4c0-1 .8-1.7 1.8-1.7s1.8.7 1.8 1.6c0 1.4-1.8 1.4-1.8 2.9" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="10.2" r=".8" fill="currentColor"/>'),
  plan: SVG('<path d="M2 3.5h1.5M5 3.5h7M2 7h1.5M5 7h7M2 10.5h1.5M5 10.5h5" stroke="currentColor" stroke-width="1.3" fill="none"/>'),
  // events
  tool: SVG('<path d="M2 7h7M7 4l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.6" cy="7" r="1.2" fill="currentColor"/>'),
  file: SVG('<circle cx="7" cy="7" r="3.6" fill="currentColor" opacity=".8"/><ellipse cx="7" cy="7" rx="6" ry="1.6" fill="none" stroke="currentColor" stroke-width=".9"/>'),
  ship: SVG('<path d="M2 11.5L7 2l5 9.5-5-2.4z" fill="currentColor"/>'),
  shipBack: SVG('<path d="M2 2.5L7 12l5-9.5-5 2.4z" fill="currentColor"/>'),
  error: SVG('<path d="M7 12.5C3 12.5 2 9 4 6.5c.4 1.2 1.2 1.8 1.8 1.8C5.2 5.5 6.4 3 8.6 1.5 8.4 4 11.8 5.5 11.4 9c-.3 2.2-2 3.5-4.4 3.5z" fill="currentColor"/>'),
  storm: SVG('<path d="M4.5 12C2 12 1.4 9.6 2.7 8c.3.8.8 1.2 1.2 1.2-.4-1.9.4-3.6 1.9-4.6-.1 1.7 2.1 2.7 1.9 5-.2 1.4-1.3 2.4-3.2 2.4z M10 12c-1.6 0-2-1.4-1.3-2.5.2.5.5.7.8.7-.2-1.2.3-2.3 1.2-2.9 0 1.1 1.4 1.7 1.2 3.2-.1.9-.8 1.5-1.9 1.5z M9 5.5C7.8 5.5 7.5 4.4 8 3.6c.1.4.4.5.6.5-.2-.9.2-1.7.9-2.1 0 .8 1 1.2.9 2.3-.1.7-.6 1.2-1.4 1.2z" fill="currentColor"/>'),
  blackhole: SVG('<ellipse cx="7" cy="7" rx="6.3" ry="2.6" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="7" cy="7" r="3" style="fill:var(--void)" stroke="currentColor" stroke-width="1.3"/>'),
  whitehole: SVG('<circle cx="7" cy="7" r="2.4" fill="currentColor"/><path d="M7 .8v2.4M7 10.8v2.4M.8 7h2.4M10.8 7h2.4M2.6 2.6l1.7 1.7M9.7 9.7l1.7 1.7M2.6 11.4l1.7-1.7M9.7 4.3l1.7-1.7" stroke="currentColor" stroke-width="1"/>'),
  answered: SVG('<path d="M3 7.4l2.6 2.6L11 4.4" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
  arm: SVG('<path d="M7 7c0-1.5 1.6-2.2 2.8-1.2 1.6 1.4.8 4.3-1.6 4.9C5 11.5 2.4 8.8 3 5.6 3.7 2.2 7.7.8 10.8 2.4" fill="none" stroke="currentColor" stroke-width="1.2"/>'),
  galaxy: SVG('<ellipse cx="7" cy="7" rx="6.2" ry="2.6" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="7" cy="7" r="1.8" fill="currentColor"/>'),
  folder: SVG('<circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.8" fill="currentColor"/>'),
  cluster: SVG('<circle cx="4" cy="5" r="1.8" fill="currentColor"/><circle cx="10" cy="4.5" r="1.5" fill="currentColor"/><circle cx="7.5" cy="10" r="1.7" fill="currentColor"/>'),
});

/** Glyph key for a record's state (husk for deleted/aged-out remnants). */
export function stateGlyphKey(rec) {
  const r = rec?.state?.remnant;
  if (r === 'deleted' || r === 'aged-out') return 'husk';
  return GLYPH[rec?.state?.mode] ? rec.state.mode : 'idle';
}

export const MODE_WORD = Object.freeze({
  'needs-me': 'NEEDS ME', 'my-move': 'YOUR MOVE', working: 'WORKING',
  idle: 'IDLE', dead: 'DEAD', crashed: 'CRASHED',
});
export const SUB_WORD = Object.freeze({
  approve: 'APPROVE', question: 'QUESTION', plan: 'PLAN',
  generating: 'writing', tool: 'tool', retrying: 'retrying',
});
const BADGE_WORD = Object.freeze({
  stalled: 'stalled', ambiguous: 'unclear', unverified: 'unverified', dialog: 'dialog open',
  'asked-in-text': 'asked in text', 'ships-out': 'ships out', 'no-registry': 'no registry',
});
const REMNANT_WORD = Object.freeze({
  ended: 'ended', archived: 'archived', crashed: 'crashed', 'crashed-api': 'crashed (API)',
  deleted: 'deleted', 'aged-out': 'aged out',
});
const CRASH_WORD = Object.freeze({
  'unanswered-api-request': 'API request never answered', 'no-reply': 'no reply',
  'pending-tool': 'tool never finished', shutdown: 'shut down mid-turn', 'api-error': 'API error',
  'dead-pid': 'process died',
});

export function glyphEl(key, cls = '') {
  return h(`span.hud-glyph${cls ? `.${cls}` : ''}`, { html: GLYPH[key] || GLYPH.idle, dataset: { g: key } });
}
function setGlyph(el, key) {
  if (el.dataset.g !== key) { el.dataset.g = key; el.innerHTML = GLYPH[key] || GLYPH.idle; }
}

/** One line: what the session is doing right now, from structured fields only. */
export function currentAction(rec, nowS) {
  const s = rec.state || {};
  switch (s.mode) {
    case 'needs-me': return `${SUB_WORD[s.sub] || 'NEEDS ME'}${s.tool ? ` · ${fmtTool(s.tool)}` : ''}`;
    case 'working':
      if (s.sub === 'tool') return s.tool ? `${fmtTool(s.tool)}${s.target ? ` → ${baseName(s.target)}` : ''}` : 'running a tool';
      if (s.sub === 'retrying') return 'retrying the API';
      return 'writing';
    case 'my-move': return `your move · ${fmtAge(nowS - (s.since ?? rec.times?.lastActivity))}`;
    case 'idle': return `idle ${fmtAge(nowS - rec.times?.lastActivity)}`;
    case 'crashed': return `crashed · ${fmtAge(nowS - rec.times?.lastActivity)} ago`;
    default: {
      const r = s.remnant ? REMNANT_WORD[s.remnant] || s.remnant : 'dead';
      return `${r} · ${fmtAge(nowS - rec.times?.lastActivity)} ago`;
    }
  }
}

/** Plain one-line text for a feed event (structured fields only, never message text). */
export function eventText(ev, rec) {
  const d = ev.data || {};
  const tgt = (p) => (p ? baseName(String(p).replace(/^[fd]:/, '')) : '');
  switch (ev.type) {
    case 'born': return `New session${d.origin && d.origin !== 'owner' ? ` (${d.origin})` : ''}${d.worktree ? ` · worktree ${d.worktree.name || ''}` : ''}`;
    case 'needs-me-start': return `Needs you: ${SUB_WORD[d.sub] || 'input'}${d.tool ? ` · ${fmtTool(d.tool)}` : ''}`;
    case 'needs-me-end': return `${d.how === 'denied' ? 'Denied' : d.how === 'interrupted' ? 'Interrupted' : d.how === 'session-ended' ? 'Session ended' : 'Answered'} after ${fmtDur(d.waitedS)}`;
    case 'tool-call': return `${fmtTool(d.tool) || 'tool'}${d.target ? ` → ${tgt(d.target)}` : ''}${d.ok === false ? ' · failed' : ''}${Number.isFinite(d.durationMs) ? ` · ${fmtDur(d.durationMs / 1000)}` : ''}`;
    case 'file-touch': return `${d.op || 'touch'} ${tgt(d.path || d.fileId)}${d.plan ? ' (plan)' : ''}`;
    case 'subagent-out': return `Subagent out: ${d.label || d.type || 'agent'}${d.model ? ` · ${fmtModel(d.model)}` : ''}`;
    case 'subagent-back': return `Subagent back after ${fmtDur(d.durationS)}${Number.isFinite(d.tokens) ? ` · ${fmtTokens(d.tokens)} tokens` : ''}`;
    case 'error':
      if (d.kind === 'denial') return `Denied: ${fmtTool(d.tool) || 'tool'}`;
      if (d.kind === 'api') return `API error${d.apiStatus ? ` ${d.apiStatus}` : ''}${Number.isFinite(d.retryAttempt) ? ` · retry ${d.retryAttempt}/${d.maxRetries ?? '?'}` : ''}`;
      return `Error in ${fmtTool(d.tool) || 'tool'}${d.target ? ` · ${tgt(d.target)}` : ''}${d.recovered === true ? ' · recovered' : ''}`;
    case 'storm-start': return `Flare storm: ${d.count ?? '?'} errors in ${d.windowS ?? '?'} s`;
    case 'storm-end': return `Storm over: ${d.count ?? '?'} errors in ${fmtDur(d.durationS)}`;
    case 'compaction': return `Compaction ${fmtTokens(d.preTokens)} → ${fmtTokens(d.postTokens)}${d.trigger ? ` (${d.trigger})` : ''}`;
    case 'crashed': return `Crashed: ${CRASH_WORD[d.reason] || d.reason || 'abnormal end'}`;
    case 'idle': return 'Went idle';
    case 'dead': return 'Faded out (dead)';
    case 'archived': return 'Archived';
    case 'deleted': return 'Deleted';
    case 'my-move': return 'Your move';
    case 'working': return 'Working';
    default: return ev.type;
  }
  // `rec` is accepted for future per-session phrasing; unused today.
}

export const EVENT_GLYPH = Object.freeze({
  born: 'whitehole', 'needs-me-start': 'needs-me', 'needs-me-end': 'answered', 'tool-call': 'tool',
  'file-touch': 'file', 'subagent-out': 'ship', 'subagent-back': 'shipBack', error: 'error',
  'storm-start': 'storm', 'storm-end': 'storm', compaction: 'blackhole', crashed: 'crashed',
  idle: 'idle', dead: 'dead', archived: 'dead', deleted: 'husk', 'my-move': 'my-move', working: 'working',
});

// ------------------------------------------------------------------ keyed list

/** Reuse row nodes by key; only reorder what moved. */
function createKeyedList(container, create, update) {
  const rows = new Map();
  return {
    rows,
    sync(items, keyOf) {
      const seen = new Set();
      let prev = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const k = keyOf(it);
        seen.add(k);
        let node = rows.get(k);
        if (!node) { node = create(it, k); rows.set(k, node); }
        update(node, it, i);
        const want = prev ? prev.nextSibling : container.firstChild;
        if (want !== node) container.insertBefore(node, want);
        prev = node;
      }
      for (const [k, node] of rows) if (!seen.has(k)) { node.remove(); rows.delete(k); }
    },
    clear() { for (const n of rows.values()) n.remove(); rows.clear(); },
  };
}

// ------------------------------------------------------------------ toasts

/** Small transient messages in #toasts (z 70). */
export function createToasts(el) {
  const timers = new Set();
  return {
    show(text, { kind = 'info', ms = 2600 } = {}) {
      if (!el) return;
      const t = h('div.hud-toast', { role: 'status', dataset: { kind } }, text);
      el.append(t);
      while (el.childElementCount > 4) el.firstElementChild.remove();
      requestAnimationFrame(() => t.classList.add('is-in'));
      const id = setTimeout(() => {
        timers.delete(id);
        t.classList.remove('is-in');
        setTimeout(() => t.remove(), 260);
      }, ms);
      timers.add(id);
    },
    dispose() { for (const id of timers) clearTimeout(id); timers.clear(); if (el) el.textContent = ''; },
  };
}

// ------------------------------------------------------------------ panel chrome

export const PANEL_NAMES = Object.freeze(['needs', 'live', 'feed', 'selected', 'totals', 'minimap']);

const PANEL_DEFS = Object.freeze({
  needs:    { id: 'panel-needs',    title: 'Needs me',   key: '1', dock: 'left',  order: 0 },
  live:     { id: 'panel-live',     title: 'Sessions',   key: '2', dock: 'left',  order: 1 },
  feed:     { id: 'panel-feed',     title: 'Activity',   key: '3', dock: 'right', order: 1 },
  selected: { id: 'panel-selected', title: 'Selected',   key: '4', dock: 'right', order: 0 },
  totals:   { id: 'panel-totals',   title: 'Totals',     key: '5', dock: 'left',  order: 2 },
  minimap:  { id: 'minimap',        title: 'Galaxy map', key: '6', dock: 'right', order: 2 },
});

const PREF_KEY = 'cosmos.hud.v1';
const EDGE_SNAP = 28;      // px: floating panels closer than this to an edge snap flush
const DOCK_ZONE = 80;      // px: drop within this of a side to dock into its column
const MARGIN = 12;

const FEED_MAX = 200;
const LIVE_MAX = 300;
const GROUP_GAP_S = 4;     // consecutive tool calls from one session/ship this close merge into one row
const CRASH_ACTIVE_S = 86400; // a crash stays in the 'Active' filter for a day

/** Process alive AND not asleep: the honest meaning of "open". */
export const isOpenSession = (rec) => !!rec?.live && rec.state?.mode !== 'dead';
/** Subagents (ships) out right now. */
export const shipsOut = (rec) => { let n = 0; for (const x of rec?.ships || []) if (x.active) n++; return n; };
/** Counts the Totals and Selected panels share, from the same records the scene draws. */
export function sessionCounts(sessions) {
  let open = 0, asleep = 0, closed = 0, viaShips = 0, ghosts = 0;
  for (const r of sessions?.values?.() || []) {
    if (isOpenSession(r)) open++; else if (r.live) asleep++; else closed++;
    if (r.state?.mode !== 'working' && r.state?.mode !== 'needs-me' && shipsOut(r) > 0) viaShips++;
    const rm = r.state?.remnant;
    if (rm === 'deleted' || rm === 'aged-out' || r.cacheOnly) ghosts++;
  }
  return { open, asleep, closed, viaShips, ghosts };
}      // rows rendered (scrolls); the header shows the true count

/**
 * @param {HTMLElement} rootEl  #hud
 * @param {{ store, galaxy?, engine?, diagnostics?, toasts? }} deps
 */
export function createPanels(rootEl, { store, galaxy = null, engine = null, diagnostics = null, toasts = null }) {
  const doc = rootEl.ownerDocument;
  const win = doc.defaultView;
  const prefs = loadPref(PREF_KEY, {}) || {};
  prefs.panels = prefs.panels || {};
  const listeners = new Set();
  const offs = [];
  let disposed = false;
  let allHidden = !!prefs.allHidden;

  rootEl.classList.add('hud-root');
  const cols = {
    left: h('div.hud-col.hud-col--left', { 'aria-label': 'Left panels' }),
    right: h('div.hud-col.hud-col--right', { 'aria-label': 'Right panels' }),
  };
  rootEl.prepend(cols.left, cols.right);
  const dropHint = h('div.hud-drop-hint');
  rootEl.append(dropHint);

  // ---- chrome for each region
  const P = {};
  for (const name of PANEL_NAMES) {
    const def = PANEL_DEFS[name];
    let el = doc.getElementById(def.id);
    if (!el) { el = h(name === 'minimap' ? 'div' : 'section', { id: def.id }); rootEl.append(el); }
    const existing = [...el.childNodes];
    const countEl = h('span.hud-panel__count');
    const collapseBtn = h('button.hud-icon-btn.hud-panel__collapse', { type: 'button', title: 'Collapse', 'aria-label': `Collapse ${def.title}`, 'aria-expanded': 'true', html: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' });
    const hideBtn = h('button.hud-icon-btn.hud-panel__hide', { type: 'button', title: `Hide (key ${def.key})`, 'aria-label': `Hide ${def.title}`, html: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' });
    const titleEl = h('span.hud-panel__title', { text: def.title });
    const header = h('header.hud-panel__head', { title: 'Drag to move' },
      h('span.hud-panel__grip', { 'aria-hidden': 'true' }), titleEl, countEl, h('span.hud-panel__spacer'), collapseBtn, hideBtn);
    const body = h('div.hud-panel__body');
    for (const n of existing) body.append(n);
    el.textContent = '';
    el.append(header, body);
    el.classList.add('hud-panel', `hud-panel--${name}`);
    el.setAttribute('aria-label', def.title);
    const pp = Object.assign({ dock: def.dock, order: def.order, collapsed: false, hidden: false }, prefs.panels[name] || {});
    prefs.panels[name] = pp;
    P[name] = { name, def, el, header, body, countEl, titleEl, collapseBtn, hideBtn, pref: pp };

    collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); setCollapsed(name, !pp.collapsed); });
    hideBtn.addEventListener('click', (e) => { e.stopPropagation(); show(name, false); });
    header.addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; setCollapsed(name, !pp.collapsed); });
    header.addEventListener('pointerdown', (e) => beginDrag(name, e));
  }

  // ---- layout

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePref(PREF_KEY, { ...prefs, allHidden }), 200);
  }
  function emit() { for (const fn of listeners) fn(); }

  function viewport() { return { W: win.innerWidth, H: win.innerHeight }; }

  /** Place every panel: docked ones into their column in order, floating ones absolutely. */
  function layout() {
    const docked = { left: [], right: [] };
    for (const name of PANEL_NAMES) {
      const p = P[name];
      const pp = p.pref;
      p.el.hidden = !!pp.hidden;
      setClass(p.el, 'is-collapsed', pp.collapsed);
      p.collapseBtn.setAttribute('aria-expanded', String(!pp.collapsed));
      if (pp.dock === 'left' || pp.dock === 'right') {
        docked[pp.dock].push(p);
        p.el.classList.remove('is-free');
        p.el.style.left = p.el.style.top = p.el.style.right = p.el.style.bottom = '';
      } else {
        if (p.el.parentNode !== rootEl) rootEl.append(p.el);
        p.el.classList.add('is-free');
        placeFree(p);
      }
    }
    for (const side of ['left', 'right']) {
      docked[side].sort((a, b) => a.pref.order - b.pref.order);
      docked[side].forEach((p, i) => {
        p.pref.order = i;
        if (cols[side].children[i] !== p.el) cols[side].insertBefore(p.el, cols[side].children[i] || null);
      });
    }
    setClass(rootEl, 'hud--panels-hidden', allHidden);
  }

  /** Floating panel position from its stored edge anchors, pushed out of the center. */
  function placeFree(p) {
    const pp = p.pref;
    const { W, H } = viewport();
    const w = p.el.offsetWidth || 300;
    const hgt = p.el.offsetHeight || 120;
    let x = pp.ax === 'r' ? W - (pp.dx ?? MARGIN) - w : (pp.dx ?? MARGIN);
    let y = pp.ay === 'b' ? H - (pp.dy ?? MARGIN) - hgt : (pp.dy ?? 60);
    ({ x, y } = avoidCenter(x, y, w, hgt, W, H));
    p.el.style.left = `${Math.round(x)}px`;
    p.el.style.top = `${Math.round(y)}px`;
    p.el.style.right = p.el.style.bottom = '';
  }

  /** Never cover the central 50% x 60% of the screen. */
  function avoidCenter(x, y, w, hgt, W, H) {
    x = Math.min(Math.max(MARGIN, x), Math.max(MARGIN, W - w - MARGIN));
    y = Math.min(Math.max(48, y), Math.max(48, H - hgt - MARGIN));
    const cx0 = W * 0.25, cx1 = W * 0.75, cy0 = H * 0.2, cy1 = H * 0.8;
    const hits = x < cx1 && x + w > cx0 && y < cy1 && y + hgt > cy0;
    if (!hits) return { x, y };
    // Prefer the horizontal push toward the panel's own side, then vertical.
    const leftX = cx0 - 8 - w, rightX = cx1 + 8;
    const cands = [];
    if (leftX >= MARGIN) cands.push({ x: leftX, y, d: Math.abs(x - leftX) });
    if (rightX + w <= W - MARGIN) cands.push({ x: rightX, y, d: Math.abs(x - rightX) });
    const upY = cy0 - 8 - hgt, downY = cy1 + 8;
    if (upY >= 48) cands.push({ x, y: upY, d: Math.abs(y - upY) });
    if (downY + hgt <= H - MARGIN) cands.push({ x, y: downY, d: Math.abs(y - downY) });
    if (!cands.length) return { x: x + w / 2 < W / 2 ? MARGIN : W - w - MARGIN, y };
    cands.sort((a, b) => a.d - b.d);
    return { x: cands[0].x, y: cands[0].y };
  }

  // ---- drag: lift → move → dock into a column or float with edge snap
  function beginDrag(name, e) {
    if (e.button !== 0 || e.target.closest('button, input, select, a')) return;
    const p = P[name];
    const r = p.el.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const sx = e.clientX, sy = e.clientY;
    let lifted = false;
    const pid = e.pointerId;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (!lifted) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        lifted = true;
        p.el.style.width = `${r.width}px`;
        rootEl.append(p.el);
        p.el.classList.add('is-free', 'is-dragging');
      }
      const { W, H } = viewport();
      const x = Math.min(Math.max(0, ev.clientX - ox), W - 40);
      const y = Math.min(Math.max(0, ev.clientY - oy), H - 30);
      p.el.style.left = `${x}px`; p.el.style.top = `${y}px`;
      const side = ev.clientX < DOCK_ZONE ? 'left' : ev.clientX > W - DOCK_ZONE ? 'right' : null;
      dropHint.dataset.side = side || '';
      setClass(dropHint, 'is-on', !!side);
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      win.removeEventListener('pointermove', move, true);
      win.removeEventListener('pointerup', up, true);
      win.removeEventListener('pointercancel', up, true);
      setClass(dropHint, 'is-on', false);
      if (!lifted) return;
      p.el.classList.remove('is-dragging');
      p.el.style.width = '';
      const { W, H } = viewport();
      const pp = p.pref;
      const side = ev.clientX < DOCK_ZONE ? 'left' : ev.clientX > W - DOCK_ZONE ? 'right' : null;
      if (side) {
        // order among that column's docked panels by pointer y
        const others = PANEL_NAMES.map((n) => P[n]).filter((q) => q !== p && q.pref.dock === side && !q.pref.hidden)
          .sort((a, b) => a.pref.order - b.pref.order);
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
          const rr = others[i].el.getBoundingClientRect();
          if (ev.clientY < rr.top + rr.height / 2) { idx = i; break; }
        }
        others.splice(idx, 0, p);
        others.forEach((q, i) => { q.pref.order = i; });
        pp.dock = side;
      } else {
        const rr = p.el.getBoundingClientRect();
        pp.dock = null;
        pp.ax = rr.left + rr.width / 2 < W / 2 ? 'l' : 'r';
        pp.ay = rr.top + rr.height / 2 < H / 2 ? 't' : 'b';
        pp.dx = pp.ax === 'l' ? rr.left : W - rr.right;
        pp.dy = pp.ay === 't' ? rr.top : H - rr.bottom;
        if (pp.dx < EDGE_SNAP) pp.dx = MARGIN;
        if (pp.dy < EDGE_SNAP + (pp.ay === 't' ? 40 : 0)) pp.dy = pp.ay === 't' ? 52 : MARGIN;
      }
      layout();
      persist();
      emit();
    };
    // listen on the window: the panel is re-parented when it lifts, which drops pointer capture
    win.addEventListener('pointermove', move, true);
    win.addEventListener('pointerup', up, true);
    win.addEventListener('pointercancel', up, true);
    e.preventDefault();
  }

  function setCollapsed(name, on) {
    P[name].pref.collapsed = !!on;
    layout(); persist(); emit();
    if (!on) schedule();
  }
  function show(name, on) {
    const p = P[name];
    if (!p) return;
    p.pref.hidden = !on;
    if (on && allHidden) allHidden = false;
    layout(); persist(); emit();
    if (on) schedule();
  }
  function toggle(name) { const p = P[name]; if (p) show(name, p.pref.hidden || allHidden); }
  function hideAll(on) { allHidden = on === undefined ? !allHidden : !!on; layout(); persist(); emit(); if (!allHidden) schedule(); }
  function resetLayout() {
    for (const name of PANEL_NAMES) {
      const d = PANEL_DEFS[name];
      Object.assign(P[name].pref, { dock: d.dock, order: d.order, collapsed: false, hidden: false, ax: undefined, ay: undefined, dx: undefined, dy: undefined });
    }
    allHidden = false;
    layout(); persist(); emit(); schedule();
  }

  const onResize = () => { layout(); };
  win.addEventListener('resize', onResize);

  // ------------------------------------------------------------ panel contents
  const nowS = () => (typeof store.now === 'function' ? store.now() : Date.now() / 1000);
  const sel = () => store.selection || null;
  const flyTo = (s) => store.select(s, { fly: true });
  const isOpen = (name) => !P[name].pref.hidden && !P[name].pref.collapsed && !allHidden;

  // ---- Needs me
  const needs = (() => {
    const p = P.needs;
    const list = h('ol.hud-list.hud-needs', { 'aria-live': 'polite' });
    const empty = h('div.hud-empty', null, glyphEl('my-move'), h('span', { text: 'Nothing is waiting on you.' }));
    p.body.append(list, empty);
    const keyed = createKeyedList(list, (rec, sid) => {
      const glyph = glyphEl('needs-me', 'is-needs');
      const sub = h('span.hud-needs__sub');
      const subGlyph = h('span.hud-glyph');
      const title = h('span.hud-row__title');
      const proj = h('span.hud-row__meta');
      const wait = h('span.hud-needs__wait', { title: 'How long it has waited' });
      const flag = h('span.hud-tag');
      const jump = h('button.hud-btn.hud-btn--needs', { type: 'button', text: 'Jump', 'aria-label': 'Fly to this session' });
      const row = h('li.hud-row.hud-row--needs', { tabindex: '0', dataset: { sid } },
        glyph,
        h('div.hud-row__main', null, h('div.hud-row__line', null, title), h('div.hud-row__line', null, h('span.hud-needs__kind', null, subGlyph, sub), proj, flag)),
        h('div.hud-row__side', null, wait, jump));
      const go = () => flyTo({ kind: 'session', sid });
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      row.addEventListener('mouseenter', () => store.hover?.({ kind: 'session', sid }));
      row.addEventListener('mouseleave', () => store.hover?.(null));
      row._r = { title, proj, sub, subGlyph, wait, flag };
      return row;
    }, (row, rec) => {
      const r = row._r;
      setText(r.title, rec.title || rec.id.slice(0, 8));
      setText(r.proj, rec.arm?.name || '');
      const sub = rec.state.sub;
      setText(r.sub, SUB_WORD[sub] || 'INPUT');
      setGlyph(r.subGlyph, GLYPH[sub] ? sub : 'question');
      setText(r.wait, fmtDur(nowS() - rec.state.since));
      const unv = rec.state.badges?.includes('unverified');
      setText(r.flag, unv ? 'unverified' : '');
      r.flag.title = unv ? 'Seen in the session registry; this signal is not yet confirmed (DATA_SPEC §9.1)' : '';
      setClass(row, 'is-selected', sel()?.sid === rec.id);
    });
    return {
      render() {
        const ids = store.needsMe?.() || [];
        const recs = ids.map((id) => store.get(id)).filter(Boolean);
        keyed.sync(recs, (r) => r.id);
        empty.hidden = recs.length > 0;
        setText(p.countEl, recs.length ? String(recs.length) : '');
        setClass(p.el, 'has-needs', recs.length > 0);
      },
      tick() { if (keyed.rows.size) this.render(); },
    };
  })();

  // ---- Live sessions
  const live = (() => {
    const p = P.live;
    const filt = prefs.liveFilter || 'active';
    const chips = h('div.hud-chips', { role: 'group', 'aria-label': 'Which sessions' });
    const mk = (val, label, tip) => {
      const b = h('button.hud-chip', { type: 'button', text: label, title: tip, 'aria-pressed': String(filt === val), dataset: { v: val } });
      b.addEventListener('click', () => { prefs.liveFilter = val; for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.v === val)); persist(); this_.render(); });
      return b;
    };
    chips.append(mk('active', 'Active', 'Needs me, working, your move, idle, and crashes from the last day'), mk('live', 'Open', 'Only sessions whose Claude Code window is open and awake'), mk('all', 'All', 'Including dead, closed and deleted sessions'));
    const list = h('ol.hud-list.hud-live');
    const more = h('div.hud-more');
    p.body.append(chips, list, more);
    const keyed = createKeyedList(list, (rec, sid) => {
      const glyph = glyphEl('working');
      const title = h('span.hud-row__title');
      const mode = h('span.hud-row__mode');
      const meta = h('span.hud-row__meta');
      const act = h('span.hud-row__act');
      const tok = h('span.hud-num', { title: 'Tokens spent (input + output + cache writes)' });
      const ctxBar = h('span.hud-ctx__bar');
      const ctxPct = h('span.hud-num.hud-ctx__pct');
      const ctx = h('span.hud-ctx', { title: 'Context window fill' }, h('span.hud-ctx__track', null, ctxBar), ctxPct);
      const tags = h('span.hud-tags');
      const row = h('li.hud-row.hud-row--live', { tabindex: '0', dataset: { sid } },
        glyph,
        h('div.hud-row__main', null,
          h('div.hud-row__line', null, title, tags),
          h('div.hud-row__line.hud-row__line--dim', null, mode, meta),
          h('div.hud-row__line.hud-row__line--dim', null, act)),
        h('div.hud-row__side', null, tok, ctx));
      const go = () => flyTo({ kind: 'session', sid });
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      row.addEventListener('mouseenter', () => store.hover?.({ kind: 'session', sid }));
      row.addEventListener('mouseleave', () => store.hover?.(null));
      row._r = { glyph, title, mode, meta, act, tok, ctxBar, ctxPct, tags };
      return row;
    }, (row, rec) => {
      const r = row._r;
      const s = rec.state;
      const gk = stateGlyphKey(rec);
      setGlyph(r.glyph, gk);
      row.dataset.mode = s.mode;
      setText(r.title, rec.title || rec.id.slice(0, 8));
      const out = s.mode !== 'working' ? shipsOut(rec) : 0;
      setText(r.mode, `${MODE_WORD[s.mode] || s.mode}${out ? ` · ${out} subagent${out > 1 ? 's' : ''} working` : ''}`);
      setText(r.meta, `${rec.arm?.name || '—'} · ${fmtModel(rec.model)}${rec.worktree ? ` · ⑂ ${rec.worktree.name}` : ''}`);
      setText(r.act, currentAction(rec, nowS()));
      setText(r.tok, fmtTokens(rec.tokens?.total));
      const fill = rec.context?.fill;
      r.ctxBar.style.width = `${Math.round(Math.min(1, Math.max(0, fill || 0)) * 100)}%`;
      r.ctxBar.dataset.band = fill >= 0.8 ? 'hot' : fill >= 0.5 ? 'warm' : 'cool';
      setText(r.ctxPct, fmtPct(fill));
      const tags = [];
      for (const b of s.badges || []) if (b === 'stalled' || b === 'ambiguous' || b === 'unverified') tags.push(BADGE_WORD[b]);
      if (rec.storm) tags.push('storm');
      setText(r.tags, tags.join(' · '));
      setClass(row, 'is-selected', sel()?.sid === rec.id);
    });
    const this_ = {
      render() {
        const ids = store.byUrgency?.() || [];
        const f = prefs.liveFilter || 'active';
        const recs = [];
        let total = 0;
        for (const id of ids) {
          const rec = store.get(id);
          if (!rec) continue;
          const m = rec.state.mode;
          if (f === 'active' && m === 'dead') continue;
          if (f === 'active' && m === 'crashed' && nowS() - (rec.times?.lastActivity ?? 0) > CRASH_ACTIVE_S) continue;
          if (f === 'live' && !isOpenSession(rec)) continue;
          total++;
          if (recs.length < LIVE_MAX) recs.push(rec);
        }
        keyed.sync(recs, (r) => r.id);
        setText(p.countEl, String(total));
        setText(more, total > recs.length ? `+${total - recs.length} more (use search: /)` : total === 0 ? (store.loading?.done === false ? 'Reading your sessions…' : 'No sessions in this view.') : '');
      },
    };
    return this_;
  })();

  // ---- Activity feed
  const feed = (() => {
    const p = P.feed;
    const filt = prefs.feedFilter || 'all';
    const chips = h('div.hud-chips', { role: 'group', 'aria-label': 'Which events' });
    const mk = (val, label, tip) => {
      const b = h('button.hud-chip', { type: 'button', text: label, title: tip, 'aria-pressed': String(filt === val), dataset: { v: val } });
      b.addEventListener('click', () => { prefs.feedFilter = val; for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.v === val)); persist(); this_.render(); });
      return b;
    };
    chips.append(mk('all', 'All', 'Every event'), mk('signals', 'Signals', 'Hide routine tool calls and file touches'), mk('selected', 'This session', 'Only the selected session'));
    const list = h('ol.hud-list.hud-feed');
    const empty = h('div.hud-empty', { text: 'No events yet.' });
    p.body.append(chips, list, empty);
    const byId = new Map();     // id → event (re-emits replace)
    let order = [];             // ids newest first
    let dirtyOrder = true;
    const keyed = createKeyedList(list, (ev, id) => {
      const glyph = glyphEl('tool');
      const time = h('time.hud-feed__t');
      const text = h('span.hud-feed__text');
      const who = h('span.hud-feed__who');
      const diag = h('span.hud-feed__diag', { title: 'Click to diagnose', text: 'diagnose' });
      const row = h('li.hud-row.hud-row--feed', { tabindex: '0', dataset: { id } }, glyph, time, h('div.hud-feed__main', null, text, who), diag);
      const go = () => {
        const e = byId.get(id);
        if (e) store.select({ kind: 'event', id: e.id, sid: e.sid }, { fly: true });
      };
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      row.addEventListener('mouseenter', () => { const e = byId.get(id); if (e) store.hover?.({ kind: 'event', id: e.id, sid: e.sid }); });
      row.addEventListener('mouseleave', () => store.hover?.(null));
      row._r = { glyph, time, text, who, diag };
      return row;
    }, (row, ev) => {
      const r = row._r;
      setGlyph(r.glyph, EVENT_GLYPH[ev.type] || 'tool');
      row.dataset.type = ev.type;
      if (ev.type === 'error') row.dataset.kind = ev.data?.kind || 'tool';
      r.time.dateTime = new Date(ev.t * 1000).toISOString();
      setText(r.time, fmtClock(ev.t));
      const rec = store.get(ev.sid);
      if (ev._group) {
        const tally = new Map();
        for (const x of ev._group) { const k = fmtTool(x.data?.tool) || 'tool'; tally.set(k, (tally.get(k) || 0) + 1); }
        const parts = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ×${n}`);
        setText(r.text, `${ev._group.length} tool calls · ${parts.join(', ')}${tally.size > 3 ? ', …' : ''}`);
        row.title = `${fmtClock(ev._oldestT)} – ${fmtClock(ev.t)}`;
      } else { setText(r.text, eventText(ev, rec)); row.title = ''; }
      setText(r.who, `${clip(rec?.title || ev.sid?.slice(0, 8) || '', 34)}${ev.ship ? ' · subagent' : ''}`);
      r.diag.hidden = !DIAG_TYPES.has(ev.type);
      setClass(row, 'is-selected', sel()?.kind === 'event' && sel()?.id === ev.id);
    });
    function reset() {
      byId.clear();
      for (const e of store.events || []) if (FEED_TYPES.has(e.type)) byId.set(e.id, e);
      dirtyOrder = true;
    }
    function add(ev) {
      if (!ev || !FEED_TYPES.has(ev.type)) return;
      if (!byId.has(ev.id)) dirtyOrder = true;
      byId.set(ev.id, ev);
      if (byId.size > FEED_MAX * 6) {   // trim the oldest ROUTINE rows only; signals are capped by the store
        const arr = [...byId.values()].filter((e) => e.type === 'tool-call' || e.type === 'file-touch').sort((a, b) => a.t - b.t);
        for (let i = 0; i < arr.length - FEED_MAX * 3; i++) byId.delete(arr[i].id);
        dirtyOrder = true;
      }
    }
    const this_ = {
      reset, add, get: (id) => byId.get(id) || null,
      render() {
        if (dirtyOrder) {
          order = [...byId.values()].sort((a, b) => b.t - a.t || (b.seq ?? 0) - (a.seq ?? 0)).map((e) => e.id);
          dirtyOrder = false;
        }
        const f = prefs.feedFilter || 'all';
        const s = sel();
        const out = [];
        for (const id of order) {
          const e = byId.get(id);
          if (!e) continue;
          if (f === 'signals' && (e.type === 'tool-call' || e.type === 'file-touch')) continue;
          if (f === 'selected' && (!s?.sid || e.sid !== s.sid)) continue;
          // in history, only what has happened by the cursor
          if (store.time?.mode === 'history' && e.t > nowS()) continue;
          // Merge a burst of tool calls from one session/ship (the scene's convoy) into one row.
          const last = out[out.length - 1];
          if (e.type === 'tool-call' && last && last.type === 'tool-call' && last.sid === e.sid && (last.ship || null) === (e.ship || null)
            && (last._oldestT ?? last.t) - e.t <= GROUP_GAP_S) {
            if (!last._group) out[out.length - 1] = { ...last, _group: [last], _key: last.id };
            const g = out[out.length - 1];
            g._group.push(e); g._key = e.id; g._oldestT = e.t;
            continue;
          }
          if (out.length >= FEED_MAX) break;
          out.push(e);
        }
        keyed.sync(out, (e) => e._key || e.id);
        empty.hidden = out.length > 0;
        setText(empty, f === 'selected' && !s?.sid ? 'Select a session to see only its events.' : store.loading?.done === false ? 'Reading your sessions…' : 'No events yet.');
      },
    };
    reset();
    return this_;
  })();

  // ---- Selected object
  const feedLookup = (id) => feed.get(id);
  const selected = (() => {
    const p = P.selected;
    const head = h('div.hud-sel__head');
    const headGlyph = glyphEl('galaxy');
    const headTitle = h('div.hud-sel__title');
    const headSub = h('div.hud-sel__sub');
    head.append(headGlyph, h('div', null, headTitle, headSub));
    const grid = h('dl.hud-kv');
    const actions = h('div.hud-sel__actions');
    p.body.append(head, grid, actions);
    let fullCache = null;     // { sid, rec } last fetched full record (for files/ships beyond the lite top 24)
    let pending = null;

    function kv(rows) {
      // rows: [label, value, opts?]; rebuilt (selection panel is small)
      const frag = doc.createDocumentFragment();
      for (const [k, v, o] of rows) {
        if (v === undefined) continue;
        const dd = h('dd', { title: o?.title }, v === null ? '—' : v);
        if (o?.cls) dd.className = o.cls;
        frag.append(h('dt', { text: k }), dd);
      }
      grid.replaceChildren(frag);
    }
    function btn(label, fn, cls = '') {
      return h(`button.hud-btn${cls}`, { type: 'button', text: label, onclick: fn });
    }
    function feedEvent(id) { return feedLookup ? feedLookup(id) : null; }
    function findIn(rec, list, id) { return rec?.[list]?.find((x) => x.id === id) || null; }

    async function ensureFull(sid) {
      if (fullCache?.sid === sid || pending === sid || !store.fetchSession) return;
      pending = sid;
      try {
        const rec = await store.fetchSession(sid);
        fullCache = { sid, rec };
      } catch { /* the lite record is still shown */ }
      pending = null;
      if (!disposed) schedule();
    }

    function sessionRows(rec, now) {
      const s = rec.state;
      const t = rec.tokens || {};
      const c = rec.context || {};
      const n = rec.counts || {};
      return [
        ['State', `${MODE_WORD[s.mode] || s.mode}${s.sub ? ` · ${SUB_WORD[s.sub] || s.sub}` : ''}${(s.badges || []).length ? ` (${s.badges.map((b) => BADGE_WORD[b] || b).join(', ')})` : ''}`],
        s.mode === 'needs-me' ? ['Waiting', fmtDur(now - s.since), { cls: 'is-needs-text' }] : ['Doing', currentAction(rec, now)],
        s.remnant ? ['Closed', REMNANT_WORD[s.remnant] || s.remnant] : ['Open', rec.live ? (s.mode === 'dead' ? 'yes, but asleep (nothing for a day)' : 'yes (window open)') : 'no'],
        ['Project', rec.arm?.name || '—', { title: rec.arm?.key }],
        rec.worktree ? ['Worktree', `${rec.worktree.name}${rec.worktree.branch ? ` (${rec.worktree.branch})` : ''}`] : ['Worktree', undefined],
        ['Model', fmtModel(rec.model), { title: rec.model || '' }],
        ['Origin', `${rec.origin || '—'}${rec.entrypoint ? ` · ${rec.entrypoint}` : ''}`],
        rec.forkOf ? ['Fork of', rec.forkOf.slice(0, 8)] : ['Fork of', undefined],
        ['Tokens', `${fmtTokens(t.total)} total · ${fmtTokens(t.today)} today`, { title: `input ${fmtInt(t.input)} · output ${fmtInt(t.output)} · cache writes ${fmtInt(t.cacheCreate)} (cache reads ${fmtInt(t.cacheRead)} are reuse, not spend)` }],
        ['  by kind', `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache w ${fmtTokens(t.cacheCreate)}`],
        ['  cache reads', `${fmtTokens(t.cacheRead)} (reused context)`],
        ['Context', `${fmtPct(c.fill)} · ${fmtTokens(c.used)} / ${fmtTokens(c.limit)}`, { title: `peak ${fmtInt(c.peak)}` }],
        ['Turns · tools', `${fmtInt(n.turns)} · ${fmtInt(n.toolCalls)}`],
        ['Errors', `${fmtInt(n.errors)} (${fmtInt(n.errorsToday)} today) · denials ${fmtInt(n.denials)} · API ${fmtInt(n.apiErrors)}`],
        ['Storms · compactions', `${fmtInt(n.storms)} · ${fmtInt(n.compactions)}`],
        ['Subagents', `${fmtInt(n.ships)}${rec.ships?.some((x) => x.active) ? ` (${rec.ships.filter((x) => x.active).length} out now)` : ''}`],
        ['Files', `${fmtInt(rec.filesTotal ?? rec.files?.length)} in ${fmtInt(rec.foldersTotal ?? rec.folders?.length)} folders`],
        ['Born', fmtStamp(rec.times?.bornAt)],
        ['Last activity', `${fmtStamp(rec.times?.lastActivity)} (${fmtAge(now - rec.times?.lastActivity)} ago)`],
        rec.times?.endedAt ? ['Ended', fmtStamp(rec.times.endedAt)] : ['Ended', undefined],
        ['Session id', rec.id, { cls: 'is-mono' }],
      ];
    }

    function render() {
      const s = sel();
      const now = nowS();
      actions.replaceChildren();
      if (!s || s.kind === 'galaxy') {
        const T = store.totals || {};
        setGlyph(headGlyph, 'galaxy');
        setText(headTitle, 'Galaxy');
        const C = sessionCounts(store.sessions);
        setText(headSub, `${fmtInt(T.sessions)} sessions · ${fmtInt(C.open)} open`);
        kv([
          ['Arms (projects)', fmtInt(store.arms?.size)],
          ['Needs me', fmtInt(T.byMode?.['needs-me'])],
          ['Tokens today', fmtTokens(T.tokensToday?.total)],
          ['Hint', 'Click any star, or press / to search.'],
        ]);
        setText(p.countEl, '');
        return;
      }
      if (s.kind === 'arm') {
        const arm = store.arms?.get(s.armKey);
        const ids = arm?.sessionIds || [];
        const by = {};
        for (const id of ids) { const r = store.get(id); if (r) by[r.state.mode] = (by[r.state.mode] || 0) + 1; }
        let tok = 0;
        for (const id of ids) tok += store.get(id)?.tokens?.today || 0;
        setGlyph(headGlyph, 'arm');
        setText(headTitle, arm?.name || s.armKey || 'Arm');
        setText(headSub, 'Spiral arm (one project)');
        kv([
          ['Sessions', fmtInt(ids.length)],
          ['By state', Object.entries(by).map(([m, c]) => `${MODE_WORD[m] || m} ${c}`).join(' · ') || '—'],
          ['Tokens today', fmtTokens(tok)],
          ['Folder', s.armKey || '—', { cls: 'is-mono' }],
        ]);
        actions.append(btn('Fly here', () => flyTo(s)));
        setText(p.countEl, 'arm');
        return;
      }
      const lite = s.sid ? store.get(s.sid) : null;
      if (!lite) {
        setGlyph(headGlyph, 'husk');
        setText(headTitle, 'Not found');
        setText(headSub, s.sid ? `${s.sid.slice(0, 8)} is not in the current view` : '');
        kv([]);
        return;
      }
      const full = fullCache?.sid === s.sid ? fullCache.rec : null;
      const rec = full || lite;
      if (s.kind === 'session') {
        setGlyph(headGlyph, stateGlyphKey(lite));
        headGlyph.dataset.mode = lite.state.mode;
        setText(headTitle, lite.title || lite.id.slice(0, 8));
        setText(headSub, `Star system · ${MODE_WORD[lite.state.mode] || lite.state.mode}`);
        kv(sessionRows(lite, now));
        actions.append(btn('Fly here', () => flyTo(s)));
        setText(p.countEl, '');
        return;
      }
      if (s.kind === 'file' || s.kind === 'folder') {
        const list = s.kind === 'file' ? 'files' : 'folders';
        const it = findIn(lite, list, s.id) || findIn(full, list, s.id);
        if (!it) ensureFull(s.sid);
        setGlyph(headGlyph, s.kind === 'file' ? 'file' : 'folder');
        setText(headTitle, it ? baseName(it.path) || it.path : (s.id || '').replace(/^[fd]:/, ''));
        setText(headSub, `${s.kind === 'file' ? 'Planet (file)' : 'Planet (folder)'} · ${lite.title || lite.id.slice(0, 8)}`);
        kv(it ? [
          ['Path', it.path, { cls: 'is-mono' }],
          ['Edits', fmtInt(it.edits)],
          ['Reads', fmtInt(it.reads)],
          s.kind === 'folder' ? ['Files', fmtInt(it.files)] : ['Plan file', it.plan ? 'yes' : undefined],
          ['Last touched', `${fmtStamp(it.lastT)} (${fmtAge(now - it.lastT)} ago)`],
        ] : [['Status', pending ? 'Loading…' : 'Not in this session’s top files']]);
        actions.append(btn('Fly here', () => flyTo(s)), btn('Session', () => flyTo({ kind: 'session', sid: s.sid })));
        return;
      }
      if (s.kind === 'ship') {
        const it = (rec.ships || []).find((x) => x.id === s.id || x.id === `agent-${s.id}` || `agent-${x.id}` === s.id);
        if (!it && !full) ensureFull(s.sid);
        setGlyph(headGlyph, 'ship');
        setText(headTitle, it ? it.label || it.type || 'Subagent' : 'Subagent');
        setText(headSub, `Big ship (subagent) · ${lite.title || lite.id.slice(0, 8)}`);
        kv(it ? [
          ['Status', it.active ? 'out working' : 'back home'],
          ['Type', it.type || '—'],
          ['Model', fmtModel(it.model), { title: it.model || '' }],
          ['Tokens', fmtTokens(it.tokens)],
          ['Left', fmtStamp(it.t)],
          ['Back', it.endT ? `${fmtStamp(it.endT)} (${fmtDur(it.endT - it.t)})` : '—'],
          ['Depth', fmtInt(it.depth)],
          ['Agent id', it.id, { cls: 'is-mono' }],
        ] : [['Status', pending ? 'Loading…' : 'Not found in the record']]);
        actions.append(btn('Fly here', () => flyTo(s)), btn('Session', () => flyTo({ kind: 'session', sid: s.sid })));
        return;
      }
      if (s.kind === 'compaction') {
        const it = findIn(rec, 'compactions', s.id);
        setGlyph(headGlyph, 'blackhole');
        setText(headTitle, 'Black hole (compaction)');
        setText(headSub, lite.title || lite.id.slice(0, 8));
        kv(it ? [
          ['When', fmtStamp(it.t)],
          ['Trigger', it.trigger || '—'],
          ['Before', fmtTokens(it.preTokens)],
          ['After', fmtTokens(it.postTokens)],
          ['Swallowed', fmtTokens((it.preTokens ?? NaN) - (it.postTokens ?? NaN))],
          ['Took', Number.isFinite(it.durationMs) ? fmtDur(it.durationMs / 1000) : '—'],
        ] : [['Status', 'Not found in the record']]);
        actions.append(btn('Fly here', () => flyTo(s)), btn('Diagnose', () => {
          const ev = (store.events || []).find((e) => e.type === 'compaction' && e.sid === s.sid && Math.abs(e.t - (it?.t ?? -1)) < 2);
          if (ev) store.select({ kind: 'event', id: ev.id, sid: ev.sid }, { fly: false });
        }));
        return;
      }
      if (s.kind === 'event') {
        const ev = (store.events || []).find((e) => e.id === s.id) || feedEvent(s.id);
        setGlyph(headGlyph, EVENT_GLYPH[ev?.type] || 'tool');
        setText(headTitle, ev ? eventText(ev, lite) : 'Event');
        setText(headSub, `${lite.title || lite.id.slice(0, 8)}${ev ? ` · ${fmtStamp(ev.t)}` : ''}`);
        const rows = [['Type', ev?.type || (s.id || '').split(':')[0]]];
        if (ev) {
          for (const [k, v] of Object.entries(ev.data || {})) {
            if (v === null || v === undefined || typeof v === 'object') continue;
            rows.push([k, typeof v === 'number' && /tokens/i.test(k) ? fmtTokens(v) : String(v), { cls: 'is-mono' }]);
          }
          if (ev.ship) rows.push(['In subagent', ev.ship, { cls: 'is-mono' }]);
        }
        kv(rows);
        actions.append(btn('Session', () => flyTo({ kind: 'session', sid: s.sid })));
        if (diagnostics?.open && DIAG_TYPES.has(ev?.type || (s.id || '').split(':')[0])) actions.append(btn('Diagnose', () => diagnostics.open(s.id)));
        return;
      }
      setGlyph(headGlyph, 'galaxy');
      setText(headTitle, s.kind);
      kv([]);
    }
    return { render, invalidate(sid) { if (fullCache?.sid === sid) fullCache = null; } };
  })();

  // ---- Totals
  const totals = (() => {
    const p = P.totals;
    const modes = ['needs-me', 'working', 'my-move', 'idle', 'crashed', 'dead'];
    const states = h('div.hud-totals__states');
    const cells = {};
    for (const m of modes) {
      const n = h('span.hud-num.hud-totals__n');
      const cell = h('div.hud-totals__state', { dataset: { mode: m }, title: MODE_WORD[m] }, glyphEl(stateGlyphKey({ state: { mode: m } })), n, h('span.hud-totals__w', { text: MODE_WORD[m] }));
      cells[m] = n;
      states.append(cell);
    }
    const big = h('div.hud-totals__big');
    const tokN = h('span.hud-num.hud-totals__tok');
    const tokSub = h('span.hud-totals__toksub');
    big.append(h('span.hud-totals__label', { text: 'Tokens today' }), tokN, tokSub);
    const grid = h('dl.hud-kv.hud-kv--compact');
    p.body.append(states, big, grid);
    return {
      render() {
        const T = store.totals || {};
        const C = sessionCounts(store.sessions);
        for (const m of modes) {
          const n = T.byMode?.[m] ?? 0;
          // A session whose subagents are busy is working, even when its own turn is over.
          const via = m === 'working' ? C.viaShips : 0;
          setText(cells[m], via ? `${fmtInt(n)} +${fmtInt(via)}` : fmtInt(n));
          cells[m].parentNode.title = via ? `${MODE_WORD[m]}: ${n}, plus ${via} working through subagents` : MODE_WORD[m];
          setClass(cells[m].parentNode, 'is-zero', !(n > 0) && !via);
        }
        const tt = T.tokensToday || {};
        setText(tokN, fmtTokens(tt.total));
        setText(tokSub, `in ${fmtTokens(tt.input)} · out ${fmtTokens(tt.output)} · cache w ${fmtTokens(tt.cacheCreate)} · reused ${fmtTokens(tt.cacheRead)}`);
        const ex = T.explain || {};
        const exTok = typeof ex.tokens === 'object' ? ex.tokens?.total : ex.tokens;
        const rows = [
          ['Sessions', `${fmtInt(T.sessions)} (${fmtInt(C.open)} open${C.asleep ? `, ${fmtInt(C.asleep)} asleep` : ''}, ${fmtInt(C.closed)} closed)`],
          ...(C.viaShips ? [['Working via subagents', fmtInt(C.viaShips)]] : []),
          ['Errors today', `${fmtInt(T.errorsToday)} · denials ${fmtInt(T.denialsToday)}`],
          ['Storms · compactions', `${fmtInt(T.stormsToday)} · ${fmtInt(T.compactionsToday)}`],
          ['Subagents today', fmtInt(T.shipsToday)],
          ['Explain with Claude', `${fmtInt(ex.calls)} calls · ${fmtTokens(exTok)} tokens`],
        ];
        const frag = doc.createDocumentFragment();
        for (const [k, v] of rows) frag.append(h('dt', { text: k }), h('dd', { text: v }));
        grid.replaceChildren(frag);
        setText(p.countEl, T.day || '');
      },
    };
  })();

  // ------------------------------------------------------------ scheduling
  // Store messages mark parts dirty; one rAF-coalesced render, capped at ~5 Hz
  // per part, skipped while the page is hidden.
  const dirty = new Set(['needs', 'live', 'feed', 'selected', 'totals']);
  let raf = 0;
  let lastRender = 0;
  let timer = 0;
  function mark(...parts) { for (const x of parts) dirty.add(x); schedule(); }
  function schedule() {
    if (raf || timer || disposed) return;
    const wait = Math.max(0, 200 - (performance.now() - lastRender));
    const run = () => { timer = 0; raf = requestAnimationFrame(flush); };
    if (wait > 0) timer = setTimeout(run, wait); else run();
  }
  function flush() {
    raf = 0;
    if (disposed) return;
    if (doc.hidden) { return; }   // visibilitychange re-schedules
    lastRender = performance.now();
    const parts = [...dirty];
    dirty.clear();
    for (const part of parts) {
      if (!isOpen(part)) { if (part === 'needs') needs.render(); else dirty.add(part); continue; }
      ({ needs, live, feed, selected, totals })[part]?.render();
    }
    // keep deferred parts (hidden/collapsed) dirty without spinning
  }
  // Collapsed/hidden panels re-render when opened (dirty kept); count badges for
  // needs always update so the collapsed header still shows the count.

  offs.push(store.on('session', (rec) => { selected.invalidate?.(rec?.id); mark('needs', 'live', 'selected', 'feed', 'totals'); }));
  offs.push(store.on('sessions', () => { feed.reset(); mark('needs', 'live', 'selected', 'feed', 'totals'); }));
  offs.push(store.on('event', (ev) => { feed.add(ev); mark('feed'); }));
  offs.push(store.on('totals', () => mark('totals', 'selected')));
  offs.push(store.on('selection', () => mark('selected', 'live', 'needs', 'feed')));
  offs.push(store.on('needs-me', () => mark('needs', 'live')));
  offs.push(store.on('ready', () => { feed.reset(); mark('needs', 'live', 'feed', 'selected', 'totals'); }));
  offs.push(store.on('time', (t) => { if (t?.mode === 'history') mark('feed', 'needs', 'live'); }));

  // 1 Hz: wait clocks and ages tick (needs always; live rows only when open)
  const tickId = setInterval(() => {
    if (doc.hidden || disposed) return;
    mark('needs');
    if (isOpen('live')) mark('live');
    if (sel()?.kind === 'session' && isOpen('selected')) mark('selected');
  }, 1000);
  const onVis = () => { if (!doc.hidden) mark('needs', 'live', 'feed', 'selected', 'totals'); };
  doc.addEventListener('visibilitychange', onVis);

  // Opening a collapsed/hidden panel flushes what it missed.
  listeners.add(() => mark('needs', 'live', 'feed', 'selected', 'totals'));

  layout();
  schedule();

  return {
    names: PANEL_NAMES,
    toggle, show, hideAll, resetLayout,
    get allHidden() { return allHidden; },
    isShown(name) { return !!P[name] && !P[name].pref.hidden && !allHidden; },
    isCollapsed(name) { return !!P[name]?.pref.collapsed; },
    body(name) { return P[name]?.body || null; },
    title(name) { return PANEL_DEFS[name]?.title || name; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh() { mark('needs', 'live', 'feed', 'selected', 'totals'); },
    dispose() {
      disposed = true;
      for (const off of offs) { try { off?.(); } catch { /* ignore */ } }
      clearInterval(tickId); clearTimeout(timer); clearTimeout(saveTimer); cancelAnimationFrame(raf);
      win.removeEventListener('resize', onResize);
      doc.removeEventListener('visibilitychange', onVis);
      listeners.clear();
      cols.left.remove(); cols.right.remove(); dropHint.remove();
    },
  };
}
