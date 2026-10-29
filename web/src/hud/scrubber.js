// scrubber.js: the history scrubber (GALAXY_CONTRACT §6; key H, Space plays/pauses).
//
// Bottom-center bar. Range presets (today, yesterday, last 7 days, custom),
// play/pause, speeds 1× 60× 600× 3 600× 21 600×, a density strip of the real
// events in the range (needs-me ticks in the reserved orange, errors in the
// error magenta, compactions in white), and a draggable cursor.
// While store.time.mode === 'history' a large HISTORY · DEMO badge sits in the
// top bar (click it to go back to live) and the HUD gets a thin demo frame.
//
// History data comes only from the client store (store.enterHistory fetches it).
// For the density strip the store is asked for the loaded range's events via
// store.historyEvents?.() (see the report: a small store addition); without it
// the strip falls back to the store's event ring.

import { h, setText, setClass, fmtStamp, fmtClock, glyphEl } from './panels.js';

const SPEEDS = [1, 60, 600, 3600, 21600];
const SPEED_WORD = { 1: '1×', 60: '60×', 600: '600×', 3600: '3 600×', 21600: '21 600×' };
const SPEED_TIP = { 1: 'real time', 60: '1 min per second', 600: '10 min per second', 3600: '1 hour per second', 21600: '6 hours per second' };
const MAX_RANGE_S = 8 * 86400;

function startOfDay(tS) { const d = new Date(tS * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
function fmtEnd(tS) {
  const d = new Date(tS * 1000);
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}
function toLocalInput(tS) {
  const d = new Date(tS * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** [from, to] epoch seconds for a preset, relative to now. */
export function presetRange(name, nowS) {
  const today = startOfDay(nowS);
  if (name === 'today') return [today, nowS];
  if (name === 'yesterday') return [startOfDay(today - 3600), today];
  if (name === 'week') return [startOfDay(nowS - 6 * 86400), nowS];
  return null;
}

/**
 * Bin events into `n` buckets over [from, to]: { all, err, needs, comp } Uint16 arrays.
 * Pure; exported for tests.
 */
export function binEvents(events, from, to, n) {
  const all = new Uint16Array(n), err = new Uint16Array(n), needs = new Uint16Array(n), comp = new Uint16Array(n);
  const span = to - from;
  if (!(span > 0) || !events) return { all, err, needs, comp, max: 0 };
  let max = 0;
  for (const e of events) {
    if (!(e.t >= from && e.t <= to) || e.type === 'metrics' || e.type === 'working' || e.type === 'my-move') continue;
    const i = Math.min(n - 1, Math.floor(((e.t - from) / span) * n));
    if (all[i] < 65535) all[i]++;
    if (all[i] > max) max = all[i];
    if (e.type === 'error' || e.type === 'storm-start') { if (err[i] < 65535) err[i]++; }
    else if (e.type === 'needs-me-start') { if (needs[i] < 65535) needs[i]++; }
    else if (e.type === 'compaction') { if (comp[i] < 65535) comp[i]++; }
  }
  return { all, err, needs, comp, max };
}

/**
 * @param {HTMLElement} el  #scrubber
 * @param {{ store, topbar?: { modeSlot?: HTMLElement } | HTMLElement, hudRoot?: HTMLElement, toasts? }} deps
 */
export function createScrubber(el, { store, topbar = null, hudRoot = null, toasts = null }) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const say = (t, kind) => toasts?.show?.(t, { kind });
  el.classList.add('hud-scrubber');
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'History scrubber');

  let open = false;
  let speed = 600;
  let busy = false;
  let bins = null, binsSig = '';
  let raf = 0;
  let dragging = false, wasPlaying = false;

  // ---- top row: presets + live + cursor readout
  const liveBtn = h('button.hud-chip.hud-scrub__live', { type: 'button', title: 'Back to the live galaxy' }, h('span.hud-conn__dot'), h('span', { text: 'Live' }));
  const presetBtns = {
    today: h('button.hud-chip', { type: 'button', text: 'Today', title: 'Replay today from midnight' }),
    yesterday: h('button.hud-chip', { type: 'button', text: 'Yesterday' }),
    week: h('button.hud-chip', { type: 'button', text: 'Last 7 days' }),
    custom: h('button.hud-chip', { type: 'button', text: 'Custom…', 'aria-expanded': 'false' }),
  };
  const fromIn = h('input.hud-input', { type: 'datetime-local', 'aria-label': 'From' });
  const toIn = h('input.hud-input', { type: 'datetime-local', 'aria-label': 'To' });
  const goBtn = h('button.hud-btn.hud-btn--primary', { type: 'button', text: 'Replay' });
  const custom = h('div.hud-scrub__custom', { hidden: true }, h('label', null, 'From ', fromIn), h('label', null, 'to ', toIn), goBtn, h('span.hud-field__help', { text: 'Up to 8 days.' }));
  const readout = h('div.hud-scrub__readout');
  const readTime = h('span.hud-scrub__time');
  const readState = h('span.hud-scrub__state');
  readout.append(readTime, readState);
  const closeBtn = h('button.hud-icon-btn', { type: 'button', title: 'Hide the scrubber (H)', 'aria-label': 'Hide the scrubber', html: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' });
  const rowTop = h('div.hud-scrub__row', null, liveBtn, presetBtns.today, presetBtns.yesterday, presetBtns.week, presetBtns.custom, h('span.hud-panel__spacer'), readout, closeBtn);

  // ---- bottom row: play/pause, speeds, track
  const playBtn = h('button.hud-icon-btn.hud-scrub__play', { type: 'button', 'aria-label': 'Play', title: 'Play / pause (Space)' });
  const speedWrap = h('div.hud-chips.hud-scrub__speeds', { role: 'group', 'aria-label': 'Replay speed' });
  for (const s of SPEEDS) {
    const b = h('button.hud-chip', { type: 'button', text: SPEED_WORD[s], title: SPEED_TIP[s], dataset: { s: String(s) } });
    b.addEventListener('click', () => setSpeed(s));
    speedWrap.append(b);
  }
  const canvas = h('canvas.hud-scrub__strip', { 'aria-hidden': 'true' });
  const cursor = h('div.hud-scrub__cursor', { role: 'slider', tabindex: '0', 'aria-label': 'Replay time', 'aria-valuemin': '0', 'aria-valuemax': '100' });
  const empty = h('div.hud-scrub__empty', { text: 'Pick a range to replay. Live is untouched until you do.' });
  const startLbl = h('span.hud-scrub__end');
  const endLbl = h('span.hud-scrub__end');
  const track = h('div.hud-scrub__track', null, canvas, cursor, empty);
  const legend = h('div.hud-scrub__legend', null,
    h('span.hud-scrub__key.is-needs', null, glyphEl('needs-me'), 'needs me'),
    h('span.hud-scrub__key.is-error', null, glyphEl('error'), 'errors'),
    h('span.hud-scrub__key.is-comp', null, glyphEl('blackhole'), 'compactions'),
    h('span.hud-scrub__key', null, h('span.hud-scrub__bar'), 'all events'));
  const rowBot = h('div.hud-scrub__row', null, playBtn, speedWrap, h('div.hud-scrub__trackwrap', null, track, h('div.hud-scrub__ends', null, startLbl, legend, endLbl)));
  el.replaceChildren(rowTop, custom, rowBot);

  // ---- top bar badge (HISTORY · DEMO)
  const badgeTime = h('span.hud-demo__time');
  const badge = h('button.hud-demo', { type: 'button', hidden: true, title: 'Replaying history. Click to go back to live.' },
    h('span.hud-demo__word', { text: 'HISTORY · DEMO' }), badgeTime, h('span.hud-demo__back', { text: 'back to live' }));
  badge.addEventListener('click', () => goLive());
  function mountBadge() {
    const slot = topbar?.modeSlot || (topbar instanceof HTMLElement ? topbar.querySelector('[data-slot="mode"]') || topbar : null)
      || doc.querySelector('#topbar [data-slot="mode"]') || doc.getElementById('topbar');
    if (slot && badge.parentNode !== slot) slot.append(badge);
  }

  // ---- actions
  const T = () => store.time || { mode: 'live' };
  async function enter(from, to) {
    if (busy) return;
    if (!(to > from)) { say('That range is empty.', 'warn'); return; }
    if (to - from > MAX_RANGE_S) { say('Pick 8 days or less.', 'warn'); return; }
    busy = true;
    setText(readState, 'loading history…');
    try {
      await store.enterHistory(from, to);
      store.setCursor(from);
      store.play(speed);
      binsSig = '';
    } catch (err) {
      say(`History not loaded: ${err?.message || 'server error'}`, 'error');
    } finally {
      busy = false;
      render();
    }
  }
  function goLive() { if (T().mode === 'history') store.exitHistory(); render(); }
  function playPause() {
    const t = T();
    if (t.mode !== 'history') { enter(...presetRange('today', store.now())); return; }
    if (t.playing) store.pause();
    else {
      if (t.cursor >= t.to - 0.5) store.setCursor(t.from);   // replay from the start when at the end
      store.play(speed);
    }
    render();
  }
  function setSpeed(s) {
    speed = s;
    if (T().mode === 'history' && T().playing) store.play(s);
    render();
  }
  liveBtn.addEventListener('click', goLive);
  presetBtns.today.addEventListener('click', () => enter(...presetRange('today', nowLive())));
  presetBtns.yesterday.addEventListener('click', () => enter(...presetRange('yesterday', nowLive())));
  presetBtns.week.addEventListener('click', () => enter(...presetRange('week', nowLive())));
  presetBtns.custom.addEventListener('click', () => {
    custom.hidden = !custom.hidden;
    presetBtns.custom.setAttribute('aria-expanded', String(!custom.hidden));
    if (!custom.hidden && !fromIn.value) {
      const n = nowLive();
      fromIn.value = toLocalInput(n - 86400 * 2);
      toIn.value = toLocalInput(n);
    }
  });
  goBtn.addEventListener('click', () => {
    const f = new Date(fromIn.value).getTime() / 1000, t = new Date(toIn.value).getTime() / 1000;
    if (!Number.isFinite(f) || !Number.isFinite(t)) { say('Pick both dates.', 'warn'); return; }
    enter(f, Math.min(t, nowLive()));
  });
  playBtn.addEventListener('click', playPause);
  closeBtn.addEventListener('click', () => close());
  // live data clock even while in history: use wall clock (the store's history clock is the cursor)
  function nowLive() { return Date.now() / 1000; }

  // ---- track: click / drag / keys
  function tAtX(clientX) {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const t = T();
    return t.from + f * (t.to - t.from);
  }
  let pendingT = null;
  function scrubTo(tS) {
    pendingT = tS;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pendingT != null) { store.setCursor(pendingT); pendingT = null; } render(); });
  }
  track.addEventListener('pointerdown', (e) => {
    if (T().mode !== 'history' || e.button !== 0) return;
    dragging = true;
    wasPlaying = !!T().playing;
    if (wasPlaying) store.pause();
    track.setPointerCapture?.(e.pointerId);
    scrubTo(tAtX(e.clientX));
  });
  track.addEventListener('pointermove', (e) => { if (dragging) scrubTo(tAtX(e.clientX)); else hoverTip(e); });
  const endDrag = () => { if (!dragging) return; dragging = false; if (wasPlaying) store.play(speed); render(); };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('pointerleave', () => { track.title = ''; });
  function hoverTip(e) { if (T().mode === 'history') track.title = fmtStamp(tAtX(e.clientX)); }
  cursor.addEventListener('keydown', (e) => {
    const t = T();
    if (t.mode !== 'history') return;
    const step = (t.to - t.from) / 100 * (e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); store.setCursor(Math.min(t.to, t.cursor + step)); render(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); store.setCursor(Math.max(t.from, t.cursor - step)); render(); }
    else if (e.key === 'Home') { e.preventDefault(); store.setCursor(t.from); render(); }
    else if (e.key === 'End') { e.preventDefault(); store.setCursor(t.to); render(); }
  });

  // ---- density strip
  function historyEvents() {
    if (typeof store.historyEvents === 'function') return store.historyEvents();
    if (Array.isArray(store.history?.events)) return store.history.events;
    return store.events || [];
  }
  function drawStrip() {
    const t = T();
    const W = Math.max(50, Math.floor(track.clientWidth));
    const H = Math.max(20, Math.floor(track.clientHeight));
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      binsSig = '';
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (t.mode !== 'history') { c.clearRect(0, 0, W, H); binsSig = ''; return; }
    const evs = historyEvents();
    const n = Math.max(20, Math.floor(W / 3));
    const sig = `${t.from}|${t.to}|${n}|${evs.length}|${evs[evs.length - 1]?.id || ''}`;
    if (sig === binsSig) return;
    binsSig = sig;
    bins = binEvents(evs, t.from, t.to, n);
    const cs = win.getComputedStyle(doc.documentElement);
    const col = (v, f) => cs.getPropertyValue(v).trim() || f;
    c.clearRect(0, 0, W, H);
    // day separators
    c.strokeStyle = col('--text-faint', 'grey'); c.globalAlpha = 0.5; c.lineWidth = 1;
    for (let d = startOfDay(t.from) + 86400; d < t.to; d += 86400) {
      const x = Math.round(((d - t.from) / (t.to - t.from)) * W) + 0.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    }
    c.globalAlpha = 1;
    const bw = W / n;
    const base = H - 3;
    const scale = bins.max ? (H - 12) / Math.sqrt(bins.max) : 0;
    c.fillStyle = col('--accent', 'white');
    for (let i = 0; i < n; i++) {
      if (!bins.all[i]) continue;
      const hgt = Math.max(1.5, Math.sqrt(bins.all[i]) * scale);
      c.globalAlpha = 0.28;
      c.fillRect(i * bw + 0.5, base - hgt, Math.max(1, bw - 1), hgt);
    }
    c.globalAlpha = 1;
    const tick = (arr, color, y0, y1, w) => {
      c.fillStyle = color;
      for (let i = 0; i < n; i++) if (arr[i]) c.fillRect(i * bw + bw / 2 - w / 2, y0, w, y1 - y0);
    };
    tick(bins.comp, col('--compaction', 'white'), base - 9, base, 1.5);
    tick(bins.err, col('--error', 'magenta'), base - 7, base, 2);
    tick(bins.needs, col('--needs-me', 'orange'), 0, 8, 2.5);      // reserved: needs-me ticks only
  }

  // ---- render
  function render() {
    const t = T();
    const hist = t.mode === 'history';
    mountBadge();
    badge.hidden = !hist;
    if (hudRoot) setClass(hudRoot, 'is-history', hist);
    setClass(doc.body, 'cosmos-history', hist);
    if (hist) setText(badgeTime, fmtStamp(t.cursor));
    if (!open) return;
    setClass(liveBtn, 'is-on', !hist);
    liveBtn.setAttribute('aria-pressed', String(!hist));
    playBtn.innerHTML = hist && t.playing
      ? '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 3l8 5-8 5z" fill="currentColor"/></svg>';
    playBtn.setAttribute('aria-label', hist && t.playing ? 'Pause' : 'Play');
    for (const b of speedWrap.children) b.setAttribute('aria-pressed', String(Number(b.dataset.s) === (hist && t.playing ? t.speed : speed)));
    empty.hidden = hist;
    cursor.hidden = !hist;
    if (hist) {
      const f = t.to > t.from ? (t.cursor - t.from) / (t.to - t.from) : 0;
      cursor.style.left = `${(Math.min(1, Math.max(0, f)) * 100).toFixed(3)}%`;
      cursor.setAttribute('aria-valuenow', String(Math.round(f * 100)));
      cursor.setAttribute('aria-valuetext', fmtStamp(t.cursor));
      setText(readTime, fmtStamp(t.cursor));
      setText(readState, busy ? 'loading history…' : t.playing ? `playing ${SPEED_WORD[t.speed] || `${t.speed}×`}` : 'paused');
      setText(startLbl, fmtEnd(t.from));
      setText(endLbl, fmtEnd(t.to));
    } else {
      setText(readTime, `Live · ${fmtClock(nowLive())}`);
      setText(readState, busy ? 'loading history…' : '');
      setText(startLbl, ''); setText(endLbl, '');
    }
    drawStrip();
  }

  let renderQueued = 0;
  const queue = () => { if (!renderQueued) renderQueued = requestAnimationFrame(() => { renderQueued = 0; render(); }); };
  const offs = [
    store.on('time', queue),
    store.on('event', () => { if (open && T().mode === 'history') { binsSig = ''; queue(); } }),
    store.on('sessions', queue),
  ];
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { binsSig = ''; if (open) queue(); }) : null;
  ro?.observe(track);
  // live clock readout ticks only while open and live
  const tickId = setInterval(() => { if (open && T().mode !== 'history' && !doc.hidden) render(); }, 1000);

  function openBar() { open = true; el.hidden = false; binsSig = ''; render(); }
  function close() { if (!open) return false; open = false; el.hidden = true; custom.hidden = true; return true; }
  render();

  return {
    open: openBar, close,
    toggle() { if (open) close(); else openBar(); },
    get isOpen() { return open; },
    playPause, goLive,
    enter,
    dispose() {
      for (const o of offs) o?.();
      ro?.disconnect();
      clearInterval(tickId);
      cancelAnimationFrame(raf); cancelAnimationFrame(renderQueued);
      badge.remove();
      el.replaceChildren();
      if (hudRoot) hudRoot.classList.remove('is-history');
      doc.body.classList.remove('cosmos-history');
    },
  };
}
