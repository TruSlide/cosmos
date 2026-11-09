// Cosmos galaxy page boot (GALAXY_CONTRACT §8, INTEGRATOR).
//
// token → engine → client store (await ready) → galaxy → labels, popups,
// diagnostics → HUD → URL hash → wake hooks → window.__cosmos debug hook.
// The token is read once from the meta tag and handed to the store; it is
// never stored anywhere else.

import { createSound } from '../hud/sound.js';
import { createRecorder } from '../hud/recorder.js';
import { createPip } from '../hud/pip.js';
import { createAway } from '../hud/away.js';
import { createEngine } from '../engine.js';
import { createClientStore } from './store.js';
import { createGalaxy } from './galaxy.js';
import { createLabels } from '../hud/labels.js';
import { createPopups } from '../hud/hover.js';
import { createDiagnostics } from '../hud/diagnostics.js';
import { createHud } from '../hud/hud.js';
import { createOccluders } from '../hud/occluders.js';

const LATENCY_MAX = 20;

const NOTICE_CSS = 'position:absolute;left:50%;top:52px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;'
  + 'padding:8px 14px;border-radius:999px;background:rgba(10,14,28,.88);border:1px solid rgba(160,180,255,.25);'
  + 'color:rgba(236,242,255,.92);font:12px/1.3 system-ui,-apple-system,sans-serif;pointer-events:auto;white-space:nowrap';

/** One persistent notice line under the top bar (loading progress, restart). */
function notice(doc, id) {
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement('div');
    el.id = id;
    el.setAttribute('role', 'status');
    el.style.cssText = NOTICE_CSS;
    el.hidden = true;
    (doc.getElementById('toasts') || doc.body).append(el);
  }
  return el;
}

function boot() {
  const doc = document;
  const $ = (id) => doc.getElementById(id);

  // 1. Token (the server injects it into the meta tag on every page load).
  const meta = doc.querySelector('meta[name="cosmos-token"]');
  const raw = meta?.getAttribute('content') || '';
  const token = raw && !raw.startsWith('__') ? raw : '';
  meta?.setAttribute('content', '');   // keep it out of the DOM after reading

  // 2. Engine (Gate 1, unchanged).
  const canvas = $('cosmos');
  const engine = createEngine(canvas, { quality: 'high' });

  // 3. Store.
  const store = createClientStore({ token });

  // Cold start: say what is happening while the server reads the transcripts.
  const loadEl = notice(doc, 'cz-loading');
  const showLoading = () => {
    const L = store.loading || {};
    if (L.done !== false) { loadEl.hidden = true; return; }
    loadEl.hidden = false;
    loadEl.textContent = Number.isFinite(L.files) && L.files > 0
      ? `Reading your sessions… ${L.filesDone ?? 0} / ${L.files} files`
      : 'Reading your sessions…';
  };
  store.on('loading', showLoading);
  store.on('ready', showLoading);
  store.on('sessions', showLoading);
  showLoading();

  // Server restarted: the page's POST token is void. Say so, persistently.
  store.on('restarted', () => {
    const el = notice(doc, 'cz-restarted');
    el.style.top = '86px';
    el.replaceChildren(doc.createTextNode('Cosmos restarted. Reload to re-enable saving.'));
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = 'Reload';
    b.style.cssText = 'font:inherit;color:inherit;background:rgba(160,180,255,.18);border:1px solid rgba(160,180,255,.35);border-radius:999px;padding:2px 10px;cursor:pointer';
    b.addEventListener('click', () => location.reload());
    el.append(b);
    el.hidden = false;
  });

  // Screen space the HUD covers: labels and needs-me edge markers avoid it.
  const occluders = createOccluders(doc);

  const dbg = {
    version: 'galaxy-1', engine, store, galaxy: null, hud: null, labels: null, popups: null, diagnostics: null,
    latency: [],
    perf() {
      const g = dbg.galaxy?.stats?.() || {};
      return {
        fps: engine.stats?.fps ?? 0, rate: engine.stats?.rate ?? 0,
        drawCalls: engine.renderer.info.render.calls,
        ...g,
        labels: dbg.labels?.stats?.() ?? null,
      };
    },
    select: (sel) => store.select(sel, { fly: true }),
    focus: (sel) => dbg.galaxy?.focus(sel),
    needsMe: () => store.needsMe(),
  };
  window.__cosmos = dbg;

  return store.ready.then(() => {
    // 4. Quality and frame rates from settings.
    const q = store.settings?.render?.quality;
    if (q && q !== engine.quality) engine.setQuality(q);
    const applyRates = () => engine.setFrameRates?.({ cap: store.settings?.render?.fpsCap, idle: store.settings?.render?.idleFps });
    applyRates();

    // 5. Galaxy.
    const galaxy = createGalaxy(engine, store, { edgeRoot: $('edge-markers'), occluders });
    dbg.galaxy = galaxy;

    // Depth of field: only when flown into one system ('system' or 'close' view),
    // and only if the setting is on. The focused system stays sharp.
    let dofK = 0;
    engine.onFrame((dt) => {
      const want = store.settings?.render?.dof !== false && galaxy.view().level !== 'galaxy' && galaxy.view().level !== 'arm';
      dofK += ((want ? 1 : 0) - dofK) * Math.min(1, dt * 3);
      engine.setDepthOfField({ enabled: dofK > 0.01, focusDist: engine.camera.position.distanceTo(engine.controls.target), strength: dofK });
      return want && dofK < 0.99 ? 1 : 0;
    });

    // 6. LENS.
    const labels = createLabels($('labels'), { galaxy, store, occluders });
    const popups = createPopups($('popup'), { galaxy, store });
    const diagnostics = createDiagnostics($('diagnostics'), { store, galaxy });
    Object.assign(dbg, { labels, popups, diagnostics });

    // 7. HUD.
    const hud = createHud($('hud'), { store, galaxy, engine, labels, diagnostics });
    dbg.hud = hud;
    dbg.occluders = occluders;
    showLoading();

    // 8. URL hash: #session=<sid> selects and flies there (launch hook).
    const fromHash = () => {
      const m = /(?:^#|&)session=([^&]+)/.exec(location.hash || '');
      if (!m) return;
      let sid;
      try { sid = decodeURIComponent(m[1]); } catch { return; }
      if (!/^[A-Za-z0-9-]{8,64}$/.test(sid)) return;
      const go = () => { if (store.get(sid)) store.select({ kind: 'session', sid }, { fly: true }); return !!store.get(sid); };
      if (!go()) { const off = store.on('sessions', () => { if (go()) off(); }); }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);

    // Sound (off until Settings > Sound is on).
    dbg.sound = createSound(store);
    dbg.recorder = createRecorder(engine.renderer.domElement, { token });
    // Picture-in-picture: dying systems as time-lapses (else flourishing ones).
    try { dbg.away = createAway(store); } catch (err) { console.warn('[cosmos] away card unavailable', err); }
    try { dbg.pip = createPip(store); } catch (err) { console.warn('[cosmos] picture-in-picture unavailable', err); }

    // Codex: the read-only knowledge list (GET /api/knowledge). Refreshed every
    // minute, and right after a live session saves knowledge (which also sends
    // a gold beam from that session to the crystal).
    const knowledge = { data: null, listeners: new Set(), on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); } };
    store.knowledge = knowledge;
    let knowledgeLoads = 0;
    async function loadKnowledge(fresh = false) {
      try {
        const r = await fetch(`/api/knowledge${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
        if (!r.ok) return;
        knowledge.data = await r.json();
        galaxy.setKnowledge(knowledge.data.items, { quiet: knowledgeLoads++ === 0 });
        for (const fn of knowledge.listeners) fn(knowledge.data);
        hud.panels?.refresh?.();
        if (knowledgeLoads === 1) dbg.away?.maybeShow();   // "while you were away": once, after the first load
        if (knowledgeLoads < 4 && !(knowledge.data.counts?.rules > 0)) setTimeout(() => loadKnowledge(true), 5000);
      } catch { /* the Codex keeps its last list */ }
    }
    loadKnowledge();
    // Parking Lot moons around "me" (same list as /pending).
    async function loadParking() {
      try {
        const r = await fetch('/api/pending', { cache: 'no-store' });
        if (r.ok) galaxy.center.setParking((await r.json()).groups || []);
      } catch { /* moons keep their last list */ }
    }
    loadParking();
    setInterval(loadParking, 60000);
    setInterval(() => loadKnowledge(), 60000);
    const KNOWLEDGE_FILE = /(\.claude\/kit\.md|\.claude\/projects\/[^/]+\/memory\/(?!MEMORY\.md$)[^/]+\.md|\.claude\/skills\/[^/]+\/SKILL\.md|(^|\/)CLAUDE\.md|(^|\/)DECISIONS\.md|playbook[^/]*\.md)$/i;
    store.on('event', (ev) => {
      if (ev?.type !== 'file-touch' || store.time.mode !== 'live') return;
      const d = ev.data || {};
      if (d.op === 'read' || !KNOWLEDGE_FILE.test(String(d.path || ''))) return;
      galaxy.beamFrom(ev.sid);
      setTimeout(() => loadKnowledge(true), 2800);   // the new shard grows in as the beam lands
    });

    // 9. Wake hooks + the needs-me latency proof.
    store.on('needs-me', (e) => {
      engine.wake(1.5);
      if (!e?.entered || store.time.mode !== 'live') return;
      const entry = { sid: e.sid, serverT: e.since ?? null, clientT: performance.now(), clientWallT: Date.now() / 1000, beaconFrameT: null };
      dbg.latency.push(entry);
      if (dbg.latency.length > LATENCY_MAX) dbg.latency.shift();
      const offF = galaxy.onAfterFrame(() => {
        const at = galaxy.beaconShownAt(e.sid);
        if (at != null && at >= entry.clientT - 1) { entry.beaconFrameT = at; offF(); }
        else if (performance.now() - entry.clientT > 5000) offF();
      });
    });
    store.on('session', () => engine.wake(0.5));
    // Rebirth: a dying or dead session came back; its system re-forms in a white-hole burst.
    store.on('reborn', (e) => {
      engine.wake(5);
      hud.toasts?.show?.(`${e.title || 'A session'} came back to life`, { kind: 'info', ms: 4000 });
    });
    store.on('event', () => engine.wake(0.5));
    store.on('settings', () => {
      const q2 = store.settings?.render?.quality;
      if (q2 && q2 !== engine.quality) engine.setQuality(q2);
      applyRates();
    });

    doc.documentElement.dataset.cosmos = 'ready';
    return dbg;
  });
}

boot().catch((err) => {
  console.error('[cosmos] boot failed:', err);
  const el = document.getElementById('toasts') || document.body;
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);padding:14px 18px;border-radius:10px;background:rgba(10,14,28,.9);color:rgba(236,242,255,.92);font:13px system-ui;pointer-events:auto';
  box.textContent = `Cosmos could not start: ${err?.message || err}. Is the local server running (node server.mjs)?`;
  el.append(box);
});
