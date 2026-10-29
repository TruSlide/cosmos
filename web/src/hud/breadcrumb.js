// breadcrumb.js: the top bar (GALAXY_CONTRACT §6, §9 #topbar).
//
//   [COSMOS]  Galaxy › arm › session › file|folder|ship|black hole|event    [/ Search]
//             [needs-me pill]  [HISTORY · DEMO slot]  [Map] [Labels]  [● live]  [sound]  [?]  [panels]  [gear]
//
// Every breadcrumb step is clickable (store.select(step, { fly: true })) and the
// trail is driven by store.selection only. The needs-me pill is the one piece of
// orange here (reserved color), it is always visible even when every panel is
// hidden, and clicking it jumps to the longest-waiting session.
//
// createBreadcrumb() is the bare trail; createTopbar() lays out the whole bar
// and uses it. The scrubber puts its badge into the [data-slot="mode"] element.

import { h, setText, setClass, glyphEl, baseName, clip, fmtDur, SUB_WORD } from './panels.js';

/** Steps for a selection, root first: [{ label, sel, glyph }]. */
export function crumbsFor(store, s) {
  const out = [{ label: 'Galaxy', sel: { kind: 'galaxy' }, glyph: 'galaxy' }];
  if (!s || s.kind === 'galaxy') return out;
  const rec = s.sid ? store.get(s.sid) : null;
  const armKey = s.armKey || rec?.arm?.key;
  if (armKey) {
    const arm = store.arms?.get(armKey);
    out.push({ label: arm?.name || rec?.arm?.name || baseName(armKey), sel: { kind: 'arm', armKey }, glyph: 'arm' });
  }
  if (s.kind === 'arm') return out;
  if (rec && rec.worktree) out.push({ label: `⑂ ${rec.worktree.name}`, sel: { kind: 'session', sid: rec.id }, glyph: 'cluster', passive: true });
  if (s.sid) out.push({ label: clip(rec?.title || s.sid.slice(0, 8), 42), sel: { kind: 'session', sid: s.sid }, glyph: rec?.state?.mode === 'needs-me' ? 'needs-me' : 'working' });
  switch (s.kind) {
    case 'folder': {
      const f = rec?.folders?.find((x) => x.id === s.id);
      out.push({ label: f?.path || String(s.id || '').replace(/^d:/, ''), sel: s, glyph: 'folder' });
      break;
    }
    case 'file': {
      const f = rec?.files?.find((x) => x.id === s.id);
      const path = f?.path || String(s.id || '').replace(/^f:/, '');
      const folder = f?.folder || (path.includes('/') ? `d:${path.slice(0, path.lastIndexOf('/'))}` : null);
      if (folder) out.push({ label: folder.replace(/^d:/, ''), sel: { kind: 'folder', sid: s.sid, id: folder }, glyph: 'folder' });
      out.push({ label: baseName(path), sel: s, glyph: 'file' });
      break;
    }
    case 'ship': {
      const sh = rec?.ships?.find((x) => x.id === s.id);
      out.push({ label: sh?.label || sh?.type || 'subagent', sel: s, glyph: 'ship' });
      break;
    }
    case 'compaction': out.push({ label: 'black hole', sel: s, glyph: 'blackhole' }); break;
    case 'event': out.push({ label: String(s.id || '').split(':')[0] || 'event', sel: s, glyph: 'error' }); break;
    default: break;
  }
  return out;
}

/**
 * Bare breadcrumb trail.
 * @param {HTMLElement} el  container (an <nav> is created inside)
 */
export function createBreadcrumb(el, { store }) {
  const nav = h('nav.hud-crumbs', { 'aria-label': 'Where you are' });
  const ol = h('ol');
  nav.append(ol);
  el.append(nav);
  let lastSig = '';
  function render() {
    const steps = crumbsFor(store, store.selection);
    const sig = steps.map((x) => `${x.glyph}|${x.label}`).join('>');
    if (sig === lastSig) return;
    lastSig = sig;
    ol.replaceChildren();
    steps.forEach((st, i) => {
      const last = i === steps.length - 1;
      const b = h('button.hud-crumb', { type: 'button', title: last ? 'Frame it again (F)' : `Go to ${st.label}`, 'aria-current': last ? 'location' : null },
        glyphEl(st.glyph), h('span', { text: st.label }));
      b.addEventListener('click', () => store.select(st.sel, { fly: true }));
      ol.append(h('li', null, b));
    });
    // keep the tail visible when it overflows
    nav.scrollLeft = nav.scrollWidth;
  }
  const offs = [
    store.on('selection', render),
    store.on('session', render),
    store.on('sessions', render),
  ];
  render();
  return { el: nav, render, dispose() { for (const o of offs) o?.(); nav.remove(); } };
}

/**
 * The whole top bar.
 * @param {HTMLElement} topbarEl  #topbar
 * @param {{ store, galaxy?, labels?, panels?, actions?: {
 *   openSearch?, openLegend?, openSettings?, toggleMute?, isMuted?, toggleScrubber?, nextNeedsMe? } }} deps
 */
export function createTopbar(topbarEl, { store, galaxy = null, labels = null, panels = null, actions = {} }) {
  const doc = topbarEl.ownerDocument;
  topbarEl.classList.add('hud-topbar');
  topbarEl.textContent = '';

  const brand = h('button.hud-brand', { type: 'button', title: 'Whole galaxy (R)', 'aria-label': 'Cosmos: reset to the whole galaxy' },
    glyphEl('galaxy'), h('span', { text: 'COSMOS' }));
  brand.addEventListener('click', () => store.select({ kind: 'galaxy' }, { fly: true }));

  const left = h('div.hud-topbar__left', null, brand);
  const crumbs = createBreadcrumb(left, { store });

  const searchBtn = h('button.hud-search-pill', { type: 'button', title: 'Search sessions, projects and files (/)' },
    h('span.hud-glyph', { html: '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9 9l3.5 3.5" stroke="currentColor" stroke-width="1.4"/></svg>' }),
    h('span', { text: 'Search' }), h('kbd', { text: '/' }));
  searchBtn.addEventListener('click', () => actions.openSearch?.());

  // NEEDS ME pill: reserved orange; hourglass shape + word + count, so it reads without color.
  const needsN = h('span.hud-num');
  const needsWait = h('span.hud-needs-pill__wait');
  const needsPill = h('button.hud-needs-pill', { type: 'button', hidden: true, title: 'Jump to the next session that needs you (N)' },
    glyphEl('needs-me'), needsN, h('span.hud-needs-pill__w', { text: 'NEEDS ME' }), needsWait);
  needsPill.addEventListener('click', () => {
    if (actions.nextNeedsMe) actions.nextNeedsMe();
    else { const ids = store.needsMe?.() || []; if (ids[0]) store.select({ kind: 'session', sid: ids[0] }, { fly: true }); }
  });

  const modeSlot = h('div.hud-topbar__mode', { dataset: { slot: 'mode' } });

  const iconBtn = (label, svg, title, fn) => {
    const b = h('button.hud-icon-btn.hud-topbar__btn', { type: 'button', title, 'aria-label': label, html: svg });
    b.addEventListener('click', fn);
    return b;
  };
  const mapBtn = iconBtn('Map links', '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12.5" cy="4" r="1.8" fill="currentColor"/><circle cx="12" cy="12.5" r="1.4" fill="currentColor"/><path d="M4.8 10.8l6.4-5.6M5.2 12.1h5.4" stroke="currentColor" stroke-width="1.1"/></svg>',
    'Map mode: labeled links between sessions, subagents, forks and arms (M)', () => {
      if (!galaxy?.setMapMode) return;
      galaxy.setMapMode(!galaxy.mapMode); render();
    });
  const labelsBtn = iconBtn('Labels', '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4.5h7.5l3 3.5-3 3.5H2z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="8" r="1.1" fill="currentColor"/></svg>',
    'Labels on / off (L)', () => {
      if (!labels?.setHidden) return;
      labels.setHidden(!labels.hidden); render();
    });

  const connDot = h('span.hud-conn__dot');
  const connText = h('span.hud-conn__text');
  const conn = h('div.hud-conn', { role: 'status', 'aria-live': 'polite' }, connDot, connText);

  const muteBtn = iconBtn('Sound', '', 'Sound mute (U). Turn sound on in Settings.', () => { actions.toggleMute?.(); render(); });
  muteBtn.hidden = true;   // no sounds exist yet (sound build); the button returns with them
  const legendBtn = iconBtn('Legend', '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.1 6.3c0-1.1.9-1.9 1.9-1.9s1.9.8 1.9 1.8c0 1.5-1.9 1.5-1.9 3.1" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="11.6" r=".85" fill="currentColor"/></svg>',
    'What everything means (?)', () => actions.openLegend?.());

  // Panels menu: show/hide each panel, reset the layout.
  const panelsBtn = iconBtn('Panels', '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.8" y="2.5" width="4.6" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.6" y="2.5" width="4.6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.6" y="10.3" width="4.6" height="3.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    'Panels (P hides all, 1–6 toggle one)', () => toggleMenu());
  panelsBtn.setAttribute('aria-haspopup', 'true');
  panelsBtn.setAttribute('aria-expanded', 'false');
  const menu = h('div.hud-menu', { role: 'menu', hidden: true });
  const panelsWrap = h('div.hud-menu-wrap', null, panelsBtn, menu);
  function buildMenu() {
    menu.replaceChildren();
    if (!panels) return;
    panels.names.forEach((n, i) => {
      const on = panels.isShown(n);
      const b = h('button.hud-menu__item', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on) },
        h('span.hud-menu__check', { text: on ? '✓' : '' }), h('span', { text: panels.title(n) }), h('kbd', { text: String(i + 1) }));
      b.addEventListener('click', () => { panels.show(n, !panels.isShown(n)); buildMenu(); });
      menu.append(b);
    });
    const all = h('button.hud-menu__item', { type: 'button', role: 'menuitem' }, h('span.hud-menu__check'), h('span', { text: panels.allHidden ? 'Show all panels' : 'Hide all panels' }), h('kbd', { text: 'P' }));
    all.addEventListener('click', () => { panels.hideAll(); buildMenu(); });
    const reset = h('button.hud-menu__item', { type: 'button', role: 'menuitem' }, h('span.hud-menu__check'), h('span', { text: 'Reset layout' }));
    reset.addEventListener('click', () => { panels.resetLayout(); buildMenu(); });
    menu.append(h('hr'), all, reset);
  }
  function toggleMenu(force) {
    const open = force === undefined ? menu.hidden : force;
    if (open) buildMenu();
    menu.hidden = !open;
    panelsBtn.setAttribute('aria-expanded', String(open));
  }
  const onDocDown = (e) => { if (!menu.hidden && !panelsWrap.contains(e.target)) toggleMenu(false); };
  doc.addEventListener('pointerdown', onDocDown);

  const gearBtn = iconBtn('Settings', '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.8l1.2 1.6 2-.3.6 1.9 1.8.9-.5 2 .9 1.8-1.6 1.2.1 2-2 .4-1 1.7L8 14.2l-1.9.8-1-1.7-2-.4.1-2L1.6 9.7l.9-1.8-.5-2 1.8-.9.6-1.9 2 .3z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    'Settings (,)', () => actions.openSettings?.());

  const right = h('div.hud-topbar__right', null, needsPill, modeSlot, mapBtn, labelsBtn, conn, muteBtn, legendBtn, panelsWrap, gearBtn);
  topbarEl.append(left, h('div.hud-topbar__center', null, searchBtn), right);

  const SVG_SOUND_ON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 6h2.4L8 3.3v9.4L4.9 10H2.5z" fill="currentColor"/><path d="M10.4 5.4a3.6 3.6 0 010 5.2M12.2 3.8a6 6 0 010 8.4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  const SVG_SOUND_OFF = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 6h2.4L8 3.3v9.4L4.9 10H2.5z" fill="currentColor"/><path d="M10.5 6l3.6 4M14.1 6l-3.6 4" stroke="currentColor" stroke-width="1.2"/></svg>';

  const CONN_WORD = { live: 'live', connecting: 'connecting', offline: 'offline' };
  let soundSig = '';
  function render() {
    // needs-me pill
    const ids = store.needsMe?.() || [];
    needsPill.hidden = ids.length === 0;
    if (ids.length) {
      setText(needsN, String(ids.length));
      const r = store.get(ids[0]);
      const now = store.now ? store.now() : Date.now() / 1000;
      setText(needsWait, r ? `${SUB_WORD[r.state.sub] || ''} · ${fmtDur(now - r.state.since)}` : '');
    }
    // toggles
    const mapOn = !!galaxy?.mapMode;
    setClass(mapBtn, 'is-on', mapOn); mapBtn.setAttribute('aria-pressed', String(mapOn));
    mapBtn.disabled = !galaxy?.setMapMode;
    const lblOn = labels ? !labels.hidden : true;
    setClass(labelsBtn, 'is-on', lblOn); labelsBtn.setAttribute('aria-pressed', String(lblOn));
    labelsBtn.disabled = !labels?.setHidden;
    // connection + backfill progress
    const c = store.connection || 'connecting';
    conn.dataset.state = c;
    const ld = store.loading;
    const loading = ld && ld.done === false;
    setText(connText, loading ? `reading ${ld.filesDone ?? 0}/${ld.files ?? '?'}` : CONN_WORD[c] || c);
    conn.title = loading ? 'Reading session files for the first time' : c === 'live' ? 'Connected: live updates' : c === 'offline' ? 'Server not reachable; retrying' : 'Connecting to the local server';
    // sound
    const enabled = !!store.settings?.sound?.enabled;
    const muted = actions.isMuted ? actions.isMuted() : false;
    const sig = `${enabled}|${muted}`;
    if (sig !== soundSig) {
      soundSig = sig;
      muteBtn.innerHTML = enabled && !muted ? SVG_SOUND_ON : SVG_SOUND_OFF;
      muteBtn.title = !enabled ? 'Sound is off (turn it on in Settings). U mutes.' : muted ? 'Muted (U)' : 'Sound on (U mutes)';
      setClass(muteBtn, 'is-on', enabled && !muted);
    }
    if (!menu.hidden) buildMenu();
  }

  const offs = [
    store.on('needs-me', render), store.on('session', render), store.on('sessions', render),
    store.on('connection', render), store.on('settings', render), store.on('ready', render),
  ];
  const offPanels = panels?.onChange?.(() => { if (!menu.hidden) buildMenu(); });
  const tick = setInterval(() => { if (!doc.hidden && !needsPill.hidden) render(); else if (store.loading && store.loading.done === false) render(); }, 1000);
  render();

  return {
    el: topbarEl,
    modeSlot,
    breadcrumb: crumbs,
    render,
    closeMenu() { if (menu.hidden) return false; toggleMenu(false); return true; },
    dispose() {
      for (const o of offs) o?.();
      offPanels?.();
      clearInterval(tick);
      doc.removeEventListener('pointerdown', onDocDown);
      crumbs.dispose();
      topbarEl.textContent = '';
    },
  };
}

