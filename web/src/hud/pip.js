// Picture-in-picture: a small live window that shows one dying system at a
// time, playing its death as a short time-lapse (storms, volcanoes, cracking,
// breaking apart, the star swelling and collapsing in a nova, then the cinder),
// and cycles to the next. With nothing dying it shows flourishing systems.
// Owner, 2026-11-08.
//
// Its own small engine and canvas (keyboard fly keys stay with the main view).
// Click the caption to fly to that system; × hides it (remembered on this
// device); Settings > Render > "Picture-in-picture" turns it off.

import { createEngine } from '../engine.js';
import { StarSystem } from '../system.js';

const CYCLE_S = 14;                 // one death time-lapse
const FLOURISH_S = 10;              // time on each flourishing system
const PHASE_FROM = 0.3;             // time-lapse starts mid-aging (the dramatic part)
const AGING_END = 0.55;             // same split as the galaxy store
const HIDE_KEY = 'cosmos.pip.hidden';

const STAGES = [
  [0.2, 'storms'], [0.35, 'volcanoes'], [0.55, 'crust cracking'],
  [0.8, 'breaking apart'], [0.97, 'star collapsing'], [1.01, 'cinder'],
];
const stageOf = (p) => STAGES.find(([t]) => p < t)[1];

export function createPip(store, opts = {}) {
  const doc = document;
  const box = doc.createElement('div');
  box.className = 'cosmos-pip';
  box.setAttribute('role', 'complementary');
  box.setAttribute('aria-label', 'Dying systems, picture in picture');
  box.innerHTML = '<canvas class="cosmos-pip__view" aria-hidden="true"></canvas>'
    + '<button type="button" class="cosmos-pip__cap"><span class="cosmos-pip__kind"></span><span class="cosmos-pip__title"></span></button>'
    + '<button type="button" class="cosmos-pip__x" aria-label="Hide picture in picture" title="Hide (Settings > Render brings it back)">×</button>';
  const style = doc.createElement('style');
  style.textContent = `
.cosmos-pip{position:fixed;right:12px;top:calc(var(--topbar-h,44px) + 6px);z-index:55;width:var(--col-w,280px);
  border-radius:12px;overflow:hidden;background:rgba(2,3,10,.82);border:1px solid rgba(160,180,230,.22);box-shadow:0 8px 28px rgba(0,0,0,.45)}
.cosmos-pip[hidden]{display:none}
.cosmos-pip__view{display:block;width:100%;height:150px;pointer-events:none}
.cosmos-pip__cap{all:unset;box-sizing:border-box;display:flex;gap:8px;align-items:baseline;width:100%;padding:6px 10px 7px;cursor:pointer;
  font:500 11px/1.3 ui-monospace,Menlo,monospace;color:#dfe6f5;border-top:1px solid rgba(160,180,230,.14)}
.cosmos-pip__cap:hover .cosmos-pip__title{text-decoration:underline}
.cosmos-pip__cap:focus-visible{outline:2px solid #9fc1ff;outline-offset:-2px}
.cosmos-pip__kind{flex:none;letter-spacing:.08em;text-transform:uppercase;color:rgba(223,230,245,.6)}
.cosmos-pip__kind.is-flourish{color:#7fd8b0}
.cosmos-pip__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cosmos-pip__x{all:unset;position:absolute;top:4px;right:6px;width:22px;height:22px;text-align:center;line-height:22px;border-radius:11px;cursor:pointer;
  color:rgba(223,230,245,.7);font:14px/22px system-ui}
.cosmos-pip__x:hover{background:rgba(255,255,255,.08);color:#fff}
.cosmos-pip__x:focus-visible{outline:2px solid #9fc1ff}`;
  doc.head.appendChild(style);
  doc.body.appendChild(box);

  const canvas = box.querySelector('canvas');
  const kindEl = box.querySelector('.cosmos-pip__kind');
  const titleEl = box.querySelector('.cosmos-pip__title');
  let hiddenByOwner = false;
  try { hiddenByOwner = localStorage.getItem(HIDE_KEY) === '1'; } catch { /* private window */ }

  const engine = createEngine(canvas, { quality: 'low', pixelRatioCap: 1.5, keyboard: false });
  engine.controls.flyTo(...camFor(), 0.01);
  engine.setDepthOfField?.({ enabled: false });

  let system = null;
  let sid = null;
  let kind = 'dying';
  let t0 = 0;
  let idx = 0;
  const scratch = {};

  function camFor() {
    const P = engine.camera.position.constructor;
    return [new P(0, 6.5, 19), new P(0, 0.3, 0)];
  }

  function enabled() { return store.settings?.render?.pip !== false && !hiddenByOwner; }

  /** Dying first (still-open sessions before long-dead ones), else flourishing. */
  function candidates() {
    const now = store.now();
    const dying = [], live = [], flourish = [];
    for (const r of store.sessions?.values?.() || []) {
      const f = store.fateOf?.(r, now);
      if (!f) continue;
      if (f.fate === 'dying') (r.live ? live : dying).push(r);
      else if (f.fate === 'flourish') flourish.push(r);
    }
    const byTok = (a, b) => (b.tokens?.total || 0) - (a.tokens?.total || 0);
    live.sort(byTok); dying.sort(byTok); flourish.sort(byTok);
    const d = [...live, ...dying];
    return d.length ? { kind: 'dying', list: d } : { kind: 'flourish', list: flourish };
  }

  function next(t) {
    const c = candidates();
    if (!c.list.length) { show(null, c.kind, t); return; }
    idx = (idx + 1) % c.list.length;
    show(c.list[idx], c.kind, t);
  }

  function show(rec, k, t) {
    if (system) { system.dispose(); system = null; }
    sid = rec?.id ?? null;
    kind = k;
    t0 = t;
    box.hidden = !enabled() || !sid;
    if (!sid) return;
    try {
      const st = stateFor(t);
      if (!st) return;
      system = new StarSystem(engine.scene, engine.ctx, st);
      engine.controls.flyTo(...camFor(), 0.01);
    } catch (err) {
      console.warn('[cosmos] pip could not build', sid, err);
      system = null;
    }
    titleEl.textContent = rec.title || rec.id.slice(0, 8);
    titleEl.title = `${rec.title || ''}${rec.arm?.name ? ` · ${rec.arm.name}` : ''} (click to fly there)`;
  }

  function stateFor(t) {
    const st = store.systemState(sid, { fileGrain: 'folder' }, scratch);
    if (!st) return null;
    if (kind === 'dying') {
      // Time-lapse: the whole death in CYCLE_S seconds, from mid-aging to the cinder.
      const k = Math.min(1, (t - t0) / CYCLE_S);
      const ph = PHASE_FROM + (1 - PHASE_FROM) * k;
      st.mode = 'idle';
      st.fate = 'dying';
      st.deathPhase = ph;
      st.idleFor = Math.min(1, ph / AGING_END);
      kindEl.textContent = `Dying · ${stageOf(ph)}`;
      kindEl.classList.remove('is-flourish');
    } else {
      st.mode = 'idle'; st.fate = 'flourish'; st.deathPhase = 0; st.idleFor = 0;
      kindEl.textContent = 'Flourishing';
      kindEl.classList.add('is-flourish');
    }
    st.bornAt = null;
    return st;
  }

  // Dock: the right panel column starts below the window (--pip-space).
  let lastSpace = '';
  function syncSpace() {
    const v = box.hidden ? '0px' : `${box.offsetHeight + 8}px`;
    if (v !== lastSpace) { doc.documentElement.style.setProperty('--pip-space', v); lastSpace = v; }
  }
  const spaceTimer = setInterval(syncSpace, 500);

  const offFrame = engine.onFrame((dt, t) => {
    if (!enabled()) { box.hidden = true; syncSpace(); return 0; }
    const span = kind === 'dying' ? CYCLE_S + 1.5 : FLOURISH_S;
    if (!sid || t - t0 > span || !store.get(sid)) next(t);
    if (!system) return 0;
    let st;
    try { st = stateFor(t); } catch { st = null; }
    if (!st) { next(t); return 0; }
    box.hidden = false;
    return Math.max(1, system.update(st, dt, t) || 0);
  });

  box.querySelector('.cosmos-pip__cap').addEventListener('click', () => {
    if (sid) store.select({ kind: 'session', sid }, { fly: true });
  });
  box.querySelector('.cosmos-pip__x').addEventListener('click', () => {
    hiddenByOwner = true;
    try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* ignore */ }
    box.hidden = true;
    syncSpace();
  });
  let pipSetting = store.settings?.render?.pip !== false;
  const offSettings = store.on('settings', () => {
    // Switching it back on in Settings also clears the ×.
    const on = store.settings?.render?.pip !== false;
    const turnedOn = on && !pipSetting;
    pipSetting = on;
    if (turnedOn && hiddenByOwner) {
      hiddenByOwner = false;
      try { localStorage.removeItem(HIDE_KEY); } catch { /* ignore */ }
    }
    if (enabled()) engine.wake(1);
  });

  return {
    get sid() { return sid; },
    next: () => next(engine.time),
    dispose() {
      offFrame(); offSettings?.(); clearInterval(spaceTimer);
      doc.documentElement.style.setProperty('--pip-space', '0px');
      if (system) system.dispose();
      engine.dispose?.();
      box.remove(); style.remove();
    },
    engine,
  };
}
