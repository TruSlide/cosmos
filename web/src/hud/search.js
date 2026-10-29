// search.js: find any session, project (arm), folder or file and fly there
// (GALAXY_CONTRACT §6, key "/").
//
// The index is built from what the client store already holds (sessions, arms,
// the lite records' top files and folders) each time the box opens and when
// sessions change while it is open. Arrow keys move, Enter selects + flies,
// Esc closes. An empty query lists what needs you, then the most urgent sessions.
//
// Modals in #modal-root announce themselves with a 'cosmos-modal' event so only
// one is open at a time (search, legend, settings).

import { h, glyphEl, stateGlyphKey, MODE_WORD, fmtModel, baseName, clip } from './panels.js';

const MAX_RESULTS = 40;
const KIND_WEIGHT = { session: 1.0, arm: 0.95, folder: 0.8, file: 0.85 };
const KIND_WORD = { session: 'session', arm: 'project', folder: 'folder', file: 'file' };

/** Score a candidate string against a lower-cased query. 0 = no match. */
export function scoreText(text, q) {
  if (!text || !q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - Math.min(20, t.length / 10);
  const i = t.indexOf(q);
  if (i >= 0) {
    const prev = t[i - 1];
    const wordStart = /[\s/_\-.›>]/.test(prev);
    return (wordStart ? 60 : 40) - Math.min(20, i / 4);
  }
  // all query words present, any order
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 30;
  // subsequence (fuzzy), weak
  let j = 0;
  for (let k = 0; k < t.length && j < q.length; k++) if (t[k] === q[j]) j++;
  return j === q.length && q.length >= 3 ? 10 : 0;
}

/** Build the searchable items from the store. */
export function buildIndex(store) {
  const items = [];
  for (const [armKey, arm] of store.arms || []) {
    items.push({ kind: 'arm', sel: { kind: 'arm', armKey }, label: arm.name || baseName(armKey), sub: `${arm.sessionIds?.length ?? 0} sessions · ${armKey}`, keys: [arm.name || '', armKey] });
  }
  for (const [sid, rec] of store.sessions || []) {
    const title = rec.title || sid.slice(0, 8);
    items.push({
      kind: 'session', sel: { kind: 'session', sid }, rec, label: title,
      sub: `${rec.arm?.name || '—'} · ${MODE_WORD[rec.state?.mode] || rec.state?.mode} · ${fmtModel(rec.model)}${rec.worktree ? ` · ⑂ ${rec.worktree.name}` : ''}`,
      keys: [title, sid.slice(0, 8), sid, rec.worktree?.name || ''],
    });
    for (const f of rec.folders || []) {
      items.push({ kind: 'folder', sel: { kind: 'folder', sid, id: f.id }, label: f.path || f.id, sub: `${clip(title, 40)} · ${f.edits ?? 0} edits`, keys: [f.path || '', baseName(f.path)], rec });
    }
    for (const f of rec.files || []) {
      items.push({ kind: 'file', sel: { kind: 'file', sid, id: f.id }, label: baseName(f.path) || f.id, sub: `${f.path} · ${clip(title, 32)} · ${f.edits ?? 0} edits`, keys: [baseName(f.path), f.path || ''], rec });
    }
  }
  return items;
}

/** Ranked results for a query. */
export function searchIndex(items, query, max = MAX_RESULTS) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const it of items) {
    let best = 0;
    for (const k of it.keys) { const s = scoreText(k, q); if (s > best) best = s; }
    if (best <= 0) continue;
    // live / urgent sessions rank higher among equals
    const m = it.rec?.state?.mode;
    const urg = m === 'needs-me' ? 6 : m === 'working' ? 3 : m === 'my-move' ? 2 : m === 'dead' ? -2 : 0;
    out.push({ it, base: best, score: best * (KIND_WEIGHT[it.kind] || 1) + (it.kind === 'session' ? urg : urg * 0.3) });
  }
  // weak (subsequence-only) matches only when there are few real ones
  const strong = out.filter((x) => x.base > 10).length;
  if (strong >= 8) for (let i = out.length - 1; i >= 0; i--) if (out[i].base <= 10) out.splice(i, 1);
  out.sort((a, b) => b.score - a.score);
  // de-dupe identical file paths across sessions: keep the best few
  const seen = new Map();
  const res = [];
  for (const { it } of out) {
    const key = it.kind === 'file' || it.kind === 'folder' ? `${it.kind}:${it.label}:${it.sub.split(' · ')[0]}` : null;
    if (key) { const n = seen.get(key) || 0; if (n >= 3) continue; seen.set(key, n + 1); }
    res.push(it);
    if (res.length >= max) break;
  }
  return res;
}

/**
 * @param {HTMLElement} modalRoot  #modal-root
 * @param {{ store }} deps
 */
export function createSearch(modalRoot, { store }) {
  const doc = modalRoot.ownerDocument;
  const NAME = 'search';
  const input = h('input.hud-search__input', {
    type: 'search', placeholder: 'Find a session, project, folder or file…', 'aria-label': 'Search',
    autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'hud-search-list',
  });
  const list = h('ul.hud-search__list', { id: 'hud-search-list', role: 'listbox' });
  const foot = h('div.hud-search__foot', null,
    h('span', null, h('kbd', { text: '↑' }), h('kbd', { text: '↓' }), ' move'),
    h('span', null, h('kbd', { text: 'Enter' }), ' fly there'),
    h('span', null, h('kbd', { text: 'Esc' }), ' close'));
  const box = h('div.hud-modal.hud-search', { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Search', hidden: true },
    h('div.hud-search__bar', null, glyphEl('galaxy'), input), list, foot);
  modalRoot.append(box);

  let index = null;
  let results = [];
  let active = 0;
  let open = false;
  let rebuildT = 0;

  function headerRow(text) { return h('li.hud-search__group', { role: 'presentation', text }); }

  function defaultResults() {
    const out = [];
    for (const sid of store.needsMe?.() || []) {
      const rec = store.get(sid);
      if (rec) out.push({ kind: 'session', sel: { kind: 'session', sid }, rec, label: rec.title || sid.slice(0, 8), sub: `${rec.arm?.name || '—'} · needs you`, keys: [] });
    }
    for (const sid of (store.byUrgency?.() || []).slice(0, 12)) {
      if (out.some((x) => x.sel.sid === sid)) continue;
      const rec = store.get(sid);
      if (rec && rec.state.mode !== 'dead') out.push({ kind: 'session', sel: { kind: 'session', sid }, rec, label: rec.title || sid.slice(0, 8), sub: `${rec.arm?.name || '—'} · ${MODE_WORD[rec.state.mode] || rec.state.mode}`, keys: [] });
      if (out.length >= 10) break;
    }
    return out;
  }

  function render() {
    const q = input.value;
    results = q.trim() ? searchIndex(index || (index = buildIndex(store)), q) : defaultResults();
    if (active >= results.length) active = Math.max(0, results.length - 1);
    list.replaceChildren();
    if (!q.trim()) list.append(headerRow(results.length ? 'Needs you and most urgent' : 'Type to search'));
    if (q.trim() && !results.length) list.append(h('li.hud-search__none', { role: 'presentation', text: `Nothing matches “${q.trim()}”.` }));
    results.forEach((it, i) => {
      const gk = it.kind === 'session' ? stateGlyphKey(it.rec) : it.kind === 'arm' ? 'arm' : it.kind === 'folder' ? 'folder' : 'file';
      const g = glyphEl(gk);
      if (it.kind === 'session') g.dataset.mode = it.rec?.state?.mode || '';
      const li = h('li.hud-search__item', { role: 'option', id: `hud-search-${i}`, 'aria-selected': String(i === active), dataset: { i: String(i) } },
        g,
        h('div.hud-search__text', null, h('span.hud-search__label', null, highlight(it.label, q)), h('span.hud-search__sub', { text: it.sub })),
        h('span.hud-search__kind', { text: KIND_WORD[it.kind] }));
      li.addEventListener('mousemove', () => { if (active !== i) { active = i; mark(); } });
      li.addEventListener('click', () => choose(i));
      list.append(li);
    });
    input.setAttribute('aria-activedescendant', results.length ? `hud-search-${active}` : '');
  }
  function highlight(label, q) {
    const t = q.trim().toLowerCase();
    const i = t ? label.toLowerCase().indexOf(t) : -1;
    if (i < 0) return label;
    const frag = doc.createDocumentFragment();
    frag.append(label.slice(0, i), h('mark', { text: label.slice(i, i + t.length) }), label.slice(i + t.length));
    return frag;
  }
  function mark() {
    for (const li of list.querySelectorAll('.hud-search__item')) li.setAttribute('aria-selected', String(Number(li.dataset.i) === active));
    input.setAttribute('aria-activedescendant', results.length ? `hud-search-${active}` : '');
    list.querySelector(`#hud-search-${active}`)?.scrollIntoView({ block: 'nearest' });
  }
  function choose(i) {
    const it = results[i];
    if (!it) return;
    close();
    store.select(it.sel, { fly: true });
  }

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  const onOutside = (e) => { if (open && !box.contains(e.target) && !e.target.closest?.('.hud-search-pill')) close(); };
  doc.addEventListener('pointerdown', onOutside);
  const onModal = (e) => { if (e.detail !== NAME) close(); };
  modalRoot.addEventListener('cosmos-modal', onModal);

  const offs = [
    store.on('sessions', () => { index = null; if (open) render(); }),
    store.on('session', () => {
      if (!open) { index = null; return; }
      clearTimeout(rebuildT);
      rebuildT = setTimeout(() => { index = null; render(); }, 400);
    }),
  ];

  function openBox(prefill = '') {
    modalRoot.dispatchEvent(new CustomEvent('cosmos-modal', { detail: NAME }));
    index = buildIndex(store);
    open = true;
    box.hidden = false;
    input.value = prefill;
    active = 0;
    render();
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  function close() {
    if (!open) return false;
    open = false;
    box.hidden = true;
    input.blur();
    index = null;
    return true;
  }
  return {
    open: openBox, close,
    toggle() { if (open) close(); else openBox(); },
    get isOpen() { return open; },
    dispose() {
      for (const o of offs) o?.();
      clearTimeout(rebuildT);
      doc.removeEventListener('pointerdown', onOutside);
      modalRoot.removeEventListener('cosmos-modal', onModal);
      box.remove();
    },
  };
}

