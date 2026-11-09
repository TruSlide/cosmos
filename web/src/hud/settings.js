// settings.js: the settings drawer (GALAXY_CONTRACT §6; key "," and the gear).
//
// Two kinds of settings, kept visibly apart:
//
//   1. Cosmos's own settings: every settings.json field (§1b) and the model
//      context-limit table (limits.json). Edited as a draft; nothing is written
//      until Save, which calls store.saveSettings() → POST /api/settings
//      (writes cosmos/settings.json and cosmos/limits.json: WRITES LIST W6/W7).
//
//   2. One Claude Code setting in ~/.claude/settings.json: transcript retention
//      (cleanupPeriodDays). Each change goes
//      Preview → exact line diff (red/green, monospace) → "Back up and apply".
//      Never applied without that click; applied with the preview's expectHash,
//      so a file that changed since the preview is refused (409) and must be
//      previewed again. The backup path is shown before and after (W9/W10).
//
// The drawer sits on the right edge, so the galaxy stays visible while tuning.

import { h, setText, setClass, baseName } from './panels.js';
import { SETTINGS_DEFAULTS } from '../shared/settings.mjs';
import { idleFraction, idleK } from '../shared/schema.mjs';

const EXPLAIN_MODELS = [['haiku', 'Haiku (cheapest)'], ['sonnet', 'Sonnet'], ['opus', 'Opus (deepest)']];

/** Field table: [path, label, kind, opts, help]. */
const SECTIONS = [
  { id: 'idle', title: 'Idle fade', note: 'How a session cools after it stops. Busy sessions fade more slowly.', fields: [
    ['idle.hours', 'Fade length', 'num', { min: 1, max: 168, step: 1, unit: 'hours' }, 'From last activity to the stable dead state.'],
    ['idle.kMin', 'Slowest curve (k min)', 'num', { min: 0.1, max: 3, step: 0.05 }, 'Exponent for the busiest sessions: lower = stays bright longer.'],
    ['idle.kMax', 'Fastest curve (k max)', 'num', { min: 0.1, max: 4, step: 0.05 }, 'Exponent for quiet sessions.'],
    ['idle.kSlope', 'Activity weight', 'num', { min: 0, max: 2, step: 0.05 }, 'How much the last active hour slows the fade.'],
  ], extra: 'idleCurve' },
  { id: 'storm', title: 'Flare storm', note: 'When several tool errors in a row become a storm.', fields: [
    ['storm.count', 'Errors', 'num', { min: 2, max: 20, step: 1 }, 'How many errors…'],
    ['storm.windowS', 'Within', 'num', { min: 5, max: 600, step: 1, unit: 's' }, '…within this many seconds.'],
    ['storm.holdS', 'Hold after last error', 'num', { min: 0, max: 120, step: 1, unit: 's' }],
    ['storm.decayS', 'Decay', 'num', { min: 0, max: 20, step: 0.5, unit: 's' }],
  ] },
  { id: 'timeouts', title: 'Timeouts', note: 'When the data layer marks a state as uncertain.', fields: [
    ['timeouts.stalledS', 'Stalled after', 'num', { min: 30, max: 7200, step: 10, unit: 's' }, 'Working, but nothing new for this long: "stalled" badge.'],
    ['timeouts.ambiguousS', 'Ambiguous tool after', 'num', { min: 5, max: 600, step: 1, unit: 's' }, 'A tool pending this long without a registry file: "unclear" badge.'],
    ['timeouts.shipActiveS', 'Ship active window', 'num', { min: 10, max: 900, step: 5, unit: 's' }],
    ['timeouts.shipDoneS', 'Ship done after silence', 'num', { min: 30, max: 3600, step: 10, unit: 's' }, 'A subagent with no new lines for this long is treated as home.'],
    ['timeouts.noRegistryWorkingS', 'Working without registry', 'num', { min: 30, max: 7200, step: 10, unit: 's' }],
  ] },
  { id: 'render', title: 'Render', note: 'Quality and frame-rate caps. Frame rates apply at once.', fields: [
    ['render.quality', 'Quality', 'select', { options: [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']] }],
    ['render.fpsCap', 'Frame-rate cap', 'select', { options: [[30, '30 fps'], [60, '60 fps'], [120, '120 fps']], number: true }],
    ['render.idleFps', 'Frame rate when calm', 'num', { min: 2, max: 30, step: 1, unit: 'fps' }],
    ['render.maxFullSystems', 'Full-detail systems', 'num', { min: 1, max: 12, step: 1 }, 'Others draw as light points until you come close.'],
    ['render.dof', 'Soft screen edges when focused', 'bool', {}, 'Blurs only the edges of the screen when you fly into a system; the middle stays sharp.'],
    ['render.constellations', 'Shared-file lines', 'bool', {}, 'Faint lines between sessions that edited the same files; pulsing amber when two live sessions edit the same file within 30 minutes (they may overwrite each other).'],
    ['render.spend', 'Spend lens', 'bool', {}, 'Color every star system by tokens spent today: cool and small for little, hot rose and large for a lot. Key $ toggles it.'],
    ['render.pip', 'Picture-in-picture', 'bool', {}, 'A small window that plays each dying system\'s death as a time-lapse, or shows flourishing systems when nothing is dying.'],
    ['render.deepSky', 'Deep-sky background', 'bool', {}, 'Distant galaxies, star clusters and nebulae with real depth; more fill in as your lifetime tokens grow. Decorative only.'],
  ] },
  { id: 'labels', title: 'Labels', fields: [
    ['labels.enabled', 'Labels on', 'bool', null, 'L toggles them any time.'],
    ['labels.density', 'Density', 'select', { options: [['sparse', 'Sparse'], ['normal', 'Normal'], ['dense', 'Dense']] }],
    ['labels.numbers', 'Show numbers on labels', 'bool'],
    ['labels.sessions', 'Session labels', 'select', { options: [['hover', 'Only on hover'], ['always', 'Always']] }, 'Name boxes on star systems: only for the one under your mouse (or selected), or always.'],
  ] },
  { id: 'notify', title: 'Notifications', note: 'Mac notifications from the Cosmos server, so you hear about it even when Cosmos is closed (the server must be running).', fields: [
    ['notify.crash', 'When a session crashes', 'bool'],
    ['notify.needs', 'When a session has needed you for a while', 'bool'],
    ['notify.needsAfterS', 'Wait before notifying', 'num', { min: 10, max: 600, step: 10, unit: 's' }, 'Prompts you answer within this time stay quiet.'],
  ] },
  { id: 'sound', title: 'Sound', note: 'Real NASA recordings: Saturn radio emissions and Earth chorus waves as the ambient bed, Sputnik\'s beep as the needs-me chime. U mutes.', fields: [
    ['sound.enabled', 'Sound on', 'bool'],
    ['sound.volume', 'Volume', 'range', { min: 0, max: 1, step: 0.05 }],
    ['sound.ambient', 'Ambient bed', 'bool'],
    ['sound.chime', 'Chime when a session needs me', 'bool'],
  ] },
  { id: 'explain', title: 'Explain with Claude', fields: [
    ['explain.model', 'Model', 'select', { options: EXPLAIN_MODELS }, 'Used only when you click "Explain with Claude" in a diagnosis.'],
  ] },
];

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let a = o;
  for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = {}; a = a[ks[i]]; }
  a[ks[ks.length - 1]] = v;
}
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {HTMLElement} modalRoot  #modal-root
 * @param {{ store, toasts? }} deps
 */
export function createSettings(modalRoot, { store, toasts = null }) {
  const NAME = 'settings';
  const doc = modalRoot.ownerDocument;
  const say = (t, kind) => toasts?.show?.(t, { kind });

  let open = false;
  let draft = null, draftLimits = null;     // edits not yet saved
  let base = null, baseLimits = null;       // what the server has
  let saving = false;
  const bound = [];                         // { path, read(), write(v) } for every field control
  let errorsEl = null;

  // ---------------------------------------------------------------- shell
  const closeBtn = h('button.hud-icon-btn.hud-modal__close', { type: 'button', 'aria-label': 'Close settings', title: 'Close (Esc)', html: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' });
  const tabs = h('div.hud-tabs', { role: 'tablist' });
  const tabCosmos = h('button.hud-tab', { type: 'button', role: 'tab', 'aria-selected': 'true', text: 'Cosmos' });
  const tabClaude = h('button.hud-tab', { type: 'button', role: 'tab', 'aria-selected': 'false', text: 'Claude Code' });
  tabs.append(tabCosmos, tabClaude);
  const paneCosmos = h('div.hud-set__pane', { role: 'tabpanel' });
  const paneClaude = h('div.hud-set__pane', { role: 'tabpanel', hidden: true });
  const dirtyNote = h('span.hud-set__dirty');
  const saveBtn = h('button.hud-btn.hud-btn--primary', { type: 'button', text: 'Save' });
  const discardBtn = h('button.hud-btn', { type: 'button', text: 'Discard changes' });
  const footer = h('footer.hud-set__foot', null,
    h('span.hud-set__where', { text: 'Saves to cosmos/settings.json and cosmos/limits.json.' }), dirtyNote, discardBtn, saveBtn);
  const box = h('aside.hud-modal.hud-drawer.hud-settings', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'hud-set-title', hidden: true, tabindex: '-1' },
    h('header.hud-modal__head', null, h('h2', { id: 'hud-set-title', text: 'Settings' }), tabs, closeBtn),
    h('div.hud-set__scroll', null, paneCosmos, paneClaude),
    footer);
  modalRoot.append(box);

  function showTab(which) {
    tabCosmos.setAttribute('aria-selected', String(which === 'cosmos'));
    tabClaude.setAttribute('aria-selected', String(which === 'claude'));
    paneCosmos.hidden = which !== 'cosmos';
    paneClaude.hidden = which !== 'claude';
    footer.hidden = which !== 'cosmos';
    if (which === 'claude') loadClaude();
  }
  tabCosmos.addEventListener('click', () => showTab('cosmos'));
  tabClaude.addEventListener('click', () => showTab('claude'));

  // ---------------------------------------------------------------- Cosmos pane
  function control(path, label, kind, opts, help) {
    const id = `set-${path.replace(/\./g, '-')}`;
    let input, read, write;
    if (kind === 'bool') {
      input = h('input.hud-switch', { type: 'checkbox', id, role: 'switch' });
      read = () => input.checked; write = (v) => { input.checked = !!v; };
    } else if (kind === 'select') {
      input = h('select.hud-input', { id }, opts.options.map(([v, t]) => h('option', { value: String(v), text: t })));
      read = () => (opts.number ? Number(input.value) : input.value);
      write = (v) => { input.value = String(v); };
    } else if (kind === 'range') {
      const out = h('output.hud-num', { for: id });
      input = h('input.hud-range', { type: 'range', id, min: opts.min, max: opts.max, step: opts.step });
      read = () => Number(input.value);
      write = (v) => { input.value = String(v); setText(out, `${Math.round(Number(v) * 100)}%`); };
      input.addEventListener('input', () => setText(out, `${Math.round(Number(input.value) * 100)}%`));
      const row = h('div.hud-field', null, h('label', { for: id, text: label }), h('div.hud-field__ctl', null, input, out), help ? h('p.hud-field__help', { text: help }) : null);
      bound.push({ path, read, write, input });
      input.addEventListener('input', () => onEdit(path, read()));
      return row;
    } else if (kind === 'multi') {
      const boxes = opts.options.map(([v, t]) => {
        const cb = h('input', { type: 'checkbox', value: v });
        return { v, cb, el: h('label.hud-check', null, cb, h('span', { text: t })) };
      });
      input = h('div.hud-field__multi', { id, role: 'group' }, boxes.map((b) => b.el));
      read = () => boxes.filter((b) => b.cb.checked).map((b) => b.v);
      write = (v) => { const s = new Set(v || []); for (const b of boxes) b.cb.checked = s.has(b.v); };
      for (const b of boxes) b.cb.addEventListener('change', () => onEdit(path, read()));
      bound.push({ path, read, write, input });
      return h('div.hud-field', null, h('span.hud-field__label', { text: label }), input, help ? h('p.hud-field__help', { text: help }) : null);
    } else {
      input = h('input.hud-input.hud-input--num', { type: 'number', id, min: opts?.min, max: opts?.max, step: opts?.step ?? 1, inputmode: 'decimal' });
      read = () => { const n = Number(input.value); return Number.isFinite(n) && input.value !== '' ? n : getPath(base, path); };
      write = (v) => { input.value = v == null ? '' : String(v); };
    }
    const evt = kind === 'bool' || kind === 'select' ? 'change' : 'input';
    input.addEventListener(evt, () => {
      const v = read();
      if (kind === 'num' && opts) {
        const bad = !(v >= opts.min && v <= opts.max);
        setClass(input, 'is-invalid', bad);
        input.title = bad ? `Between ${opts.min} and ${opts.max}` : '';
      }
      onEdit(path, v);
    });
    bound.push({ path, read, write, input });
    return h('div.hud-field', null,
      h('label', { for: id, text: label }),
      h('div.hud-field__ctl', null, input, opts?.unit ? h('span.hud-field__unit', { text: opts.unit }) : null),
      help ? h('p.hud-field__help', { text: help }) : null);
  }

  // Idle curve preview: brightness over the fade for a quiet vs a busy session.
  const curve = h('canvas.hud-set__curve', { role: 'img', 'aria-label': 'Idle fade preview: brightness over the fade for a quiet and a busy session' });
  const curveNote = h('p.hud-field__help');
  function drawCurve() {
    if (!draft) return;
    const c = curve.getContext('2d');
    const W = Math.max(200, curve.clientWidth || 480), H = 92;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (curve.width !== Math.round(W * dpr) || curve.height !== Math.round(H * dpr)) { curve.width = Math.round(W * dpr); curve.height = Math.round(H * dpr); }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(doc.documentElement);
    const col = (n) => cs.getPropertyValue(n).trim() || 'white';
    c.clearRect(0, 0, W, H);
    const X0 = 8, X1 = W - 8, Y0 = 16, Y1 = H - 16;
    c.strokeStyle = col('--text-faint'); c.lineWidth = 1;
    c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X0, Y1); c.lineTo(X1, Y1); c.stroke();
    c.fillStyle = col('--text-faint'); c.font = `10px ${cs.getPropertyValue('--font-ui')}`;
    c.textBaseline = 'alphabetic';
    c.fillText('bright', X0 + 4, Y0 - 4);
    c.fillText('0 h', X0, H - 3);
    const endLbl = `${draft.idle?.hours ?? 24} h · dead`;
    c.fillText(endLbl, X1 - c.measureText(endLbl).width, H - 3);
    const T = (draft.idle?.hours || 24) * 3600;
    const cfg = draft.idle || SETTINGS_DEFAULTS.idle;
    const plot = (A, color, dash) => {
      const k = idleK(A, cfg);
      c.strokeStyle = color; c.lineWidth = 1.6; c.setLineDash(dash);
      c.beginPath();
      for (let i = 0; i <= 100; i++) {
        const t = (i / 100) * T;
        const b = 1 - idleFraction(t, k, T);
        const x = X0 + (i / 100) * (X1 - X0), y = Y0 + (1 - b) * (Y1 - Y0);
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.stroke(); c.setLineDash([]);
      return k;
    };
    const kq = plot(0, col('--idle'), [5, 4]);
    const kb = plot(200, col('--working'), []);
    setText(curveNote, `Quiet session (dashed): k ${kq.toFixed(2)}. Busy session, 200 replies in its last hour (solid): k ${kb.toFixed(2)}.`);
  }

  // Arms: rename and pin a slot (0..11) per project.
  const armsWrap = h('div.hud-set__arms');
  function buildArms() {
    armsWrap.replaceChildren();
    const arms = [...(store.arms?.values() || [])].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
    if (!arms.length) { armsWrap.append(h('p.hud-field__help', { text: 'No projects seen yet.' })); return; }
    const table = h('table.hud-table', null, h('thead', null, h('tr', null, h('th', { text: 'Project' }), h('th', { text: 'Display name' }), h('th', { text: 'Arm' }))));
    const tb = h('tbody');
    for (const arm of arms) {
      const ov = draft.arms?.[arm.key] || {};
      const name = h('input.hud-input', { type: 'text', placeholder: baseName(arm.key), value: ov.name || '', 'aria-label': `Display name for ${arm.key}`, maxlength: 60 });
      const slot = h('select.hud-input', { 'aria-label': `Arm slot for ${arm.key}` },
        h('option', { value: '', text: `auto (${arm.slot ?? '?'})` }),
        Array.from({ length: 12 }, (_, i) => h('option', { value: String(i), text: `arm ${i}` })));
      slot.value = Number.isInteger(ov.slot) ? String(ov.slot) : '';
      const upd = () => {
        const next = clone(draft.arms || {});
        const o = {};
        if (name.value.trim()) o.name = name.value.trim();
        if (slot.value !== '') o.slot = Number(slot.value);
        if (Object.keys(o).length) next[arm.key] = o; else delete next[arm.key];
        onEdit('arms', next);
      };
      name.addEventListener('input', upd);
      slot.addEventListener('change', upd);
      tb.append(h('tr', null, h('td.is-mono', { title: arm.key, text: baseName(arm.key) }), h('td', null, name), h('td', null, slot)));
    }
    table.append(tb);
    armsWrap.append(table, h('p.hud-field__help', { text: 'Pinning a slot moves that whole arm; sessions keep their order on it. Two projects on one slot share an arm.' }));
  }

  // Context limits table (limits.json).
  const limitsWrap = h('div.hud-set__limits');
  function buildLimits() {
    limitsWrap.replaceChildren();
    if (!draftLimits) { limitsWrap.append(h('p.hud-field__help', { text: 'Limits not loaded yet.' })); return; }
    const def = h('input.hud-input.hud-input--num', { type: 'number', min: 1000, step: 1000, value: draftLimits.default ?? 200000, 'aria-label': 'Default context limit' });
    def.addEventListener('input', () => { const n = Number(def.value); if (n > 0) { draftLimits.default = n; onEdit(); } });
    const table = h('table.hud-table', null, h('thead', null, h('tr', null, h('th', { text: 'Model name pattern' }), h('th', { text: 'Context limit (tokens)' }), h('th'))));
    const tb = h('tbody');
    (draftLimits.rules || []).forEach((r, i) => {
      const m = h('input.hud-input.is-mono', { type: 'text', value: r.match || '', 'aria-label': 'Pattern', placeholder: 'claude-*-5-5' });
      const l = h('input.hud-input.hud-input--num', { type: 'number', min: 1000, step: 1000, value: r.limit ?? '', 'aria-label': 'Limit' });
      const del = h('button.hud-icon-btn', { type: 'button', title: 'Remove rule', 'aria-label': 'Remove rule', html: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' });
      m.addEventListener('input', () => { draftLimits.rules[i].match = m.value.trim(); onEdit(); });
      l.addEventListener('input', () => { const n = Number(l.value); if (n > 0) { draftLimits.rules[i].limit = n; onEdit(); } });
      del.addEventListener('click', () => { draftLimits.rules.splice(i, 1); buildLimits(); onEdit(); });
      tb.append(h('tr', null, h('td', null, m), h('td', null, l), h('td', null, del)));
    });
    table.append(tb);
    const add = h('button.hud-btn', { type: 'button', text: 'Add rule' });
    add.addEventListener('click', () => { (draftLimits.rules ||= []).push({ match: '', limit: 200000 }); buildLimits(); onEdit(); });
    limitsWrap.append(
      h('div.hud-field', null, h('label', { text: 'Default limit' }), h('div.hud-field__ctl', null, def, h('span.hud-field__unit', { text: 'tokens' }))),
      table, add,
      h('p.hud-field__help', { text: '“*” matches anything. The first matching rule wins; Cosmos also raises a limit when a session is seen using more (peak ÷ 0.97). Star color = context used ÷ this limit.' }));
  }

  function buildCosmos() {
    bound.length = 0;
    paneCosmos.replaceChildren();
    errorsEl = h('div.hud-set__errors', { role: 'alert', hidden: true });
    paneCosmos.append(errorsEl);
    for (const sec of SECTIONS) {
      const reset = h('button.hud-link', { type: 'button', text: 'defaults', title: `Reset ${sec.title} to defaults` });
      reset.addEventListener('click', () => {
        draft[sec.id] = clone(SETTINGS_DEFAULTS[sec.id]);
        fill(); onEdit();
      });
      const fs = h('fieldset.hud-set__sec', null, h('legend', null, h('span', { text: sec.title }), sec.disabled ? null : reset));
      if (sec.disabled) { fs.disabled = true; fs.classList.add('is-disabled'); }
      if (sec.note) fs.append(h('p.hud-set__note', { text: sec.note }));
      for (const f of sec.fields) {
        const c = control(...f);
        if (f[3]?.disabled) for (const inp of c.querySelectorAll?.('input, select, textarea') || []) inp.disabled = true;
        fs.append(c);
      }
      if (sec.extra === 'idleCurve') fs.append(curve, curveNote);
      paneCosmos.append(fs);
    }
    const armsFs = h('fieldset.hud-set__sec', null, h('legend', null, h('span', { text: 'Projects and arms' })));
    armsFs.append(armsWrap);
    const limFs = h('fieldset.hud-set__sec', null, h('legend', null, h('span', { text: 'Model context limits' })));
    limFs.append(limitsWrap);
    paneCosmos.append(armsFs, limFs);
  }
  function fill() {
    for (const b of bound) b.write(getPath(draft, b.path));
    buildArms();
    buildLimits();
    drawCurve();
  }
  function onEdit(path, v) {
    if (path) setPath(draft, path, v);
    if (path?.startsWith('idle')) drawCurve();
    refreshDirty();
  }
  function isDirty() { return !!draft && (!same(draft, base) || !same(draftLimits, baseLimits)); }
  function refreshDirty() {
    const d = isDirty();
    setText(dirtyNote, d ? 'Unsaved changes' : 'Saved');
    setClass(dirtyNote, 'is-dirty', d);
    saveBtn.disabled = !d || saving;
    discardBtn.disabled = !d || saving;
  }
  function loadFromStore(force) {
    if (!force && isDirty()) return;   // keep the owner's draft
    base = clone(store.settings || SETTINGS_DEFAULTS);
    baseLimits = clone(store.limits || null);
    draft = clone(base);
    draftLimits = clone(baseLimits);
  }
  async function save() {
    if (!isDirty() || saving) return;
    saving = true; refreshDirty();
    setText(saveBtn, 'Saving…');
    try {
      const payload = {};
      if (!same(draft, base)) payload.settings = draft;
      if (!same(draftLimits, baseLimits)) payload.limits = draftLimits;
      const res = await store.saveSettings(payload);
      const errs = res?.errors || [];
      if (res?.settings) { base = clone(res.settings); draft = clone(res.settings); }
      if (res?.limits) { baseLimits = clone(res.limits); draftLimits = clone(res.limits); }
      fill();
      if (errs.length) {
        errorsEl.hidden = false;
        errorsEl.replaceChildren(h('strong', { text: 'Some values were not accepted and kept their old value:' }), h('ul', null, errs.map((e) => h('li', { text: typeof e === 'string' ? e : `${e.path || ''} ${e.message || JSON.stringify(e)}` }))));
        say('Saved, with some values refused', 'warn');
      } else {
        errorsEl.hidden = true;
        say('Saved to cosmos/settings.json');
      }
    } catch (err) {
      errorsEl.hidden = false;
      errorsEl.replaceChildren(h('strong', { text: 'Not saved. ' }), err?.message || 'The server refused the change.');
      say('Settings not saved', 'error');
    } finally {
      saving = false;
      setText(saveBtn, 'Save');
      refreshDirty();
    }
  }
  saveBtn.addEventListener('click', save);
  discardBtn.addEventListener('click', () => { loadFromStore(true); fill(); refreshDirty(); errorsEl.hidden = true; });

  // ---------------------------------------------------------------- Claude Code pane
  const cc = { current: null, preview: null, busy: false };
  const ccStatus = h('div.hud-cc__status');
  const daysIn = h('input.hud-input.hud-input--num', { type: 'number', min: 1, max: 3650, step: 1, 'aria-label': 'Days to keep transcripts' });
  const daysBtn = h('button.hud-btn', { type: 'button', text: 'Preview change' });
  const previewEl = h('div.hud-cc__preview', { hidden: true, 'aria-live': 'polite' });
  const resultEl = h('div.hud-cc__result', { hidden: true, role: 'status' });
  paneClaude.append(
    h('p.hud-set__note', null, 'These change ', h('code', { text: '~/.claude/settings.json' }), '. Each one shows the exact before/after lines first, backs the file up into ', h('code', { text: 'cosmos/cache/backups/' }), ', and writes only when you click “Back up and apply”. Nothing else in that file is touched.'),
    ccStatus,
    h('fieldset.hud-set__sec', null, h('legend', null, h('span', { text: 'Transcript retention' })),
      h('p.hud-set__note', { text: 'How many days Claude Code keeps session transcripts before cleaning them up (cleanupPeriodDays). Cosmos history only reaches back as far as transcripts survive (plus its own cache).' }),
      h('div.hud-field', null, h('label', { text: 'Keep transcripts for' }), h('div.hud-field__ctl', null, daysIn, h('span.hud-field__unit', { text: 'days' }), daysBtn))),
    previewEl, resultEl);

  async function loadClaude() {
    setText(ccStatus, 'Reading ~/.claude/settings.json…');
    try {
      const cur = await store.claudeSettings();
      cc.current = cur;
      setText(ccStatus, `File: ${cur.path || '~/.claude/settings.json'}`);
      daysIn.value = cur.cleanupPeriodDays ?? '';
      daysIn.placeholder = cur.cleanupPeriodDays == null ? '30 (default)' : '';
    } catch (err) {
      setText(ccStatus, `Could not read it: ${err?.message || 'server error'}`);
    }
  }
  async function preview(change, value) {
    if (cc.busy) return;
    cc.busy = true;
    resultEl.hidden = true;
    previewEl.hidden = false;
    previewEl.replaceChildren(h('p', { text: 'Building the preview…' }));
    try {
      const pv = await store.previewClaudeSetting(change, value);
      cc.preview = pv;
      renderPreview(pv);
    } catch (err) {
      cc.preview = null;
      previewEl.replaceChildren(h('p.hud-set__errors', { text: `No preview: ${err?.message || 'the server refused this change'}` }));
    } finally { cc.busy = false; }
  }
  function renderPreview(pv) {
    const label = `Keep transcripts for ${pv.value} days`;
    if (pv.noop) {
      previewEl.replaceChildren(h('h3', { text: label }), h('p', { text: 'Nothing to change: the file already says this.' }));
      return;
    }
    const diff = h('pre.hud-diff', { 'aria-label': 'Exact change to settings.json' });
    for (const d of pv.diff || []) {
      const cls = d.op === '+' ? 'is-add' : d.op === '-' ? 'is-del' : 'is-ctx';
      diff.append(h(`span.hud-diff__line.${cls}`, null, h('span.hud-diff__op', { text: d.op === ' ' ? ' ' : d.op, 'aria-label': d.op === '+' ? 'added' : d.op === '-' ? 'removed' : 'unchanged' }), d.line), '\n');
    }
    const applyBtn = h('button.hud-btn.hud-btn--primary', { type: 'button', text: 'Back up and apply' });
    const cancelBtn = h('button.hud-btn', { type: 'button', text: 'Cancel' });
    cancelBtn.addEventListener('click', () => { cc.preview = null; previewEl.hidden = true; });
    applyBtn.addEventListener('click', () => apply(pv, applyBtn));
    previewEl.replaceChildren(
      h('h3', { text: label }),
      pv.explain ? h('p.hud-set__note', { text: pv.explain }) : null,
      h('p.hud-cc__file', null, h('span', { text: 'File: ' }), h('code', { text: pv.path })),
      diff,
      h('p.hud-cc__backup', null, h('span', { text: 'Backup first: ' }), h('code', { text: pv.backupPath })),
      h('div.hud-cc__actions', null, cancelBtn, applyBtn));
  }
  async function apply(pv, btn) {
    if (cc.busy || !pv || pv !== cc.preview) return;
    cc.busy = true;
    btn.disabled = true; setText(btn, 'Applying…');
    try {
      const res = await store.applyClaudeSetting(pv.change, pv.value, pv.hash);
      cc.preview = null;
      previewEl.hidden = true;
      resultEl.hidden = false;
      const a = res?.after || {};
      resultEl.replaceChildren(
        h('strong', { text: res?.ok === false ? 'Not applied.' : 'Applied.' }),
        h('p', null, 'Backup: ', h('code', { text: res?.backupPath || pv.backupPath })),
        h('p', { text: `Now: transcripts kept ${a.cleanupPeriodDays ?? 'default (30)'} days.` }));
      say('Claude Code settings updated (backup saved)');
      await loadClaude();
    } catch (err) {
      const stale = err?.status === 409 || /409|changed/i.test(err?.message || '');
      btn.disabled = false; setText(btn, 'Back up and apply');
      resultEl.hidden = false;
      resultEl.replaceChildren(h('strong', { text: 'Not applied. ' }), stale
        ? 'settings.json changed since this preview (maybe Claude Code wrote to it). Preview again to see the current file.'
        : (err?.message || 'The server refused the change.'));
      if (stale) { cc.preview = null; previewEl.hidden = true; }
    } finally { cc.busy = false; }
  }
  daysBtn.addEventListener('click', () => {
    const n = Math.round(Number(daysIn.value));
    if (!(n >= 1 && n <= 3650)) { setClass(daysIn, 'is-invalid', true); daysIn.title = 'Between 1 and 3650 days'; return; }
    setClass(daysIn, 'is-invalid', false);
    preview('cleanupPeriodDays', n);
  });

  // ---------------------------------------------------------------- open / close
  closeBtn.addEventListener('click', () => close());
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  const onModal = (e) => { if (e.detail !== NAME) close(); };
  modalRoot.addEventListener('cosmos-modal', onModal);
  const offs = [store.on('settings', () => { if (!open) return; const d = isDirty(); loadFromStore(false); if (!d) fill(); refreshDirty(); })];

  function openBox(tab = 'cosmos') {
    modalRoot.dispatchEvent(new CustomEvent('cosmos-modal', { detail: NAME }));
    if (!draft || !isDirty()) loadFromStore(true);
    buildCosmos();
    fill();
    refreshDirty();
    open = true;
    box.hidden = false;
    showTab(tab);
    requestAnimationFrame(() => { drawCurve(); box.focus(); });
  }
  function close() {
    if (!open) return false;
    open = false;
    box.hidden = true;
    cc.preview = null;
    previewEl.hidden = true;
    resultEl.hidden = true;
    return true;
  }
  return {
    open: openBox, close,
    toggle() { if (open) close(); else openBox(); },
    get isOpen() { return open; },
    get dirty() { return isDirty(); },
    dispose() {
      for (const o of offs) o?.();
      modalRoot.removeEventListener('cosmos-modal', onModal);
      box.remove();
    },
  };
}

