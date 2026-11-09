// "While you were away" (owner, 2026-11-08): when Cosmos opens after a break,
// a small card sums up what changed since you last looked, with a short camera
// tour (about 20 s) through it: what needs you or crashed, what died, what was
// born, and new leaves on the Tree of Knowledge.
//
// "Last looked" is kept on this device (localStorage), updated while the page
// is visible. Any click or key stops the tour.

const KEY = 'cosmos.lastSeen';
const MIN_AWAY_S = 30 * 60;
const STEP_S = 3.2;
const MAX_STEPS = 6;

function fmtAway(s) {
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function createAway(store) {
  const doc = document;
  const read = () => { try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; } };
  const write = () => { try { localStorage.setItem(KEY, String(Math.floor(Date.now() / 1000))); } catch { /* ignore */ } };
  const last = read();
  // Keep "last looked" fresh while the page is visible.
  const beat = setInterval(() => { if (!doc.hidden) write(); }, 60000);
  const onVis = () => { if (doc.hidden) write(); };
  doc.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', write);

  const box = doc.createElement('div');
  box.className = 'cosmos-away';
  box.setAttribute('role', 'status');
  box.hidden = true;
  doc.body.appendChild(box);
  const style = doc.createElement('style');
  style.textContent = `
.cosmos-away{position:fixed;left:50%;transform:translateX(-50%);top:calc(var(--topbar-h,44px) + 10px);z-index:58;max-width:min(560px,calc(100vw - 32px));
  display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;border-radius:12px;background:rgba(2,3,10,.82);border:1px solid rgba(160,180,230,.24);
  box-shadow:0 8px 28px rgba(0,0,0,.45);color:#dfe6f5;font:12px/1.35 system-ui,-apple-system,sans-serif}
.cosmos-away[hidden]{display:none}
.cosmos-away__text{flex:1;min-width:0}
.cosmos-away__text b{font-weight:600}
.cosmos-away__cap{display:block;color:rgba(223,230,245,.6);font-size:11px;margin-top:2px}
.cosmos-away button{all:unset;cursor:pointer;padding:4px 10px;border-radius:7px;border:1px solid rgba(160,180,230,.3);font-size:11px;color:#dfe6f5}
.cosmos-away button:hover{border-color:rgba(200,215,255,.6)}
.cosmos-away button:focus-visible{outline:2px solid #9fc1ff}`;
  doc.head.appendChild(style);

  let steps = [];
  let timer = 0;
  let touring = false;

  function summary(awayS) {
    const now = store.now();
    const recs = [...(store.sessions?.values?.() || [])];
    const crashed = store.crashAlarms ? store.crashAlarms() : [];
    const needs = recs.filter((r) => r.state?.mode === 'needs-me');
    const died = recs.filter((r) => {
      if (store.fateOf?.(r, now)?.fate !== 'dying') return false;
      const at = (r.times?.lastActivity ?? 0) + 86400;
      return at > last && at <= now;
    });
    const born = recs.filter((r) => (r.times?.bornAt ?? 0) > last);
    const leaves = (store.knowledge?.data?.items || []).filter((it) => (it.mtime ?? 0) > last);
    const parts = [];
    if (crashed.length) parts.push(`${crashed.length} crashed`);
    if (needs.length) parts.push(`${needs.length} need${needs.length === 1 ? 's' : ''} you`);
    if (died.length) parts.push(`${died.length} died`);
    if (born.length) parts.push(`${born.length} new session${born.length === 1 ? '' : 's'}`);
    if (leaves.length) parts.push(`${leaves.length} new ${leaves.length === 1 ? 'leaf' : 'leaves'}`);
    steps = [
      ...crashed.slice(0, 2).map((r) => ({ sel: { kind: 'session', sid: r.id }, cap: `Crashed: ${r.title || r.id.slice(0, 8)}` })),
      ...needs.slice(0, 2).map((r) => ({ sel: { kind: 'session', sid: r.id }, cap: `Needs you: ${r.title || r.id.slice(0, 8)}` })),
      ...died.slice(0, 1).map((r) => ({ sel: { kind: 'session', sid: r.id }, cap: `Died: ${r.title || r.id.slice(0, 8)}` })),
      ...born.slice(0, 1).map((r) => ({ sel: { kind: 'session', sid: r.id }, cap: `New: ${r.title || r.id.slice(0, 8)}` })),
      ...(leaves.length ? [{ sel: { kind: 'codex' }, cap: `${leaves.length} new ${leaves.length === 1 ? 'leaf' : 'leaves'} on the Tree of Knowledge` }] : []),
    ].slice(0, MAX_STEPS);
    steps.push({ sel: { kind: 'galaxy' }, cap: 'Back to the whole galaxy' });
    return parts.length ? `While you were away (${fmtAway(awayS)}): <b>${parts.join(' · ')}</b>` : '';
  }

  function render(html, cap = '') {
    box.innerHTML = `<span class="cosmos-away__text">${html}<span class="cosmos-away__cap"></span></span>`
      + (touring ? '<button type="button" data-a="stop">Stop</button>' : '<button type="button" data-a="tour">▶ Tour</button><button type="button" data-a="close" aria-label="Close">✕</button>');
    box.querySelector('.cosmos-away__cap').textContent = cap;
  }

  function stop() {
    touring = false;
    clearTimeout(timer);
    box.hidden = true;
    window.removeEventListener('pointerdown', stopOnInput, true);
    window.removeEventListener('keydown', stopOnInput, true);
  }
  function stopOnInput(e) { if (!box.contains(e.target)) stop(); }

  function tour(i = 0) {
    if (!touring) return;
    if (i >= steps.length) { stop(); return; }
    const s = steps[i];
    store.select(s.sel, { fly: true, seconds: 1.6 });
    render(`Tour ${i + 1} / ${steps.length}`, s.cap);
    timer = setTimeout(() => tour(i + 1), STEP_S * 1000);
  }

  box.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'close' || a === 'stop') stop();
    if (a === 'tour') {
      touring = true;
      window.addEventListener('pointerdown', stopOnInput, true);
      window.addEventListener('keydown', stopOnInput, true);
      tour(0);
    }
  });

  /** Call once the store and knowledge are loaded. */
  function maybeShow() {
    const nowS = Math.floor(Date.now() / 1000);
    const awayS = last ? nowS - last : 0;
    write();
    if (!last || awayS < MIN_AWAY_S) return;
    const html = summary(awayS);
    if (!html) return;
    render(html);
    box.hidden = false;
  }

  return {
    maybeShow,
    dispose() { stop(); clearInterval(beat); doc.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', write); box.remove(); style.remove(); },
  };
}
