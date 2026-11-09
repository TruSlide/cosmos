// minimap.js: a top-down 2D map of the galaxy (GALAXY_CONTRACT §6), bottom-right.
//
// Draws from galaxy.minimap(): arms (cached to an offscreen canvas), every
// system as a dot shaped by its state, the camera's view, the selection, and
// every NEEDS ME session as a pulsing hourglass in the reserved indigo (the
// hourglass shape and the pulse carry it without color). Click a dot to fly
// there; click near an arm to frame that arm.
//
// Cost: a 2D canvas, redrawn at ~12 fps while a quasar pulses or the view is
// moving, ~3 fps otherwise, and not at all while the panel or page is hidden.
// Colors come from the CSS tokens in hud.css (never hex here).

import { h, setText, glyphEl, MODE_WORD, clip } from './panels.js';

const MAX_PX = 216;
const PAD = 10;

/**
 * @param {HTMLElement} el  #minimap (or its panel body)
 * @param {{ store, galaxy, panels? }} deps
 */
export function createMinimap(el, { store, galaxy, panels = null }) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const host = el.querySelector?.('.hud-panel__body') || el;
  const canvas = h('canvas.hud-minimap__canvas', { role: 'img', 'aria-label': 'Galaxy minimap. Click a star to fly there.' });
  const tip = h('div.hud-minimap__tip', { hidden: true });
  const legend = h('div.hud-minimap__legend', null,
    h('span.hud-minimap__key.is-needs', null, glyphEl('needs-me'), 'needs me'),
    h('span.hud-minimap__key', null, h('span.hud-minimap__view'), 'your view'));
  const wrap = h('div.hud-minimap', null, canvas, tip, legend);
  host.append(wrap);
  const ctx = canvas.getContext('2d');

  // colors from CSS tokens (read once, and again if the theme ever changes)
  let C = null;
  function readColors() {
    const cs = win.getComputedStyle(doc.documentElement);
    const v = (n, f) => (cs.getPropertyValue(n).trim() || f);
    C = {
      needs: v('--needs-me', 'orange'), needsCore: v('--needs-me-core', 'white'),
      myMove: v('--my-move', 'cyan'), working: v('--working', 'white'), disk: v('--working-disk', 'blue'),
      idle: v('--idle', 'grey'), dead: v('--dead', 'grey'), crashed: v('--crashed', 'grey'),
      accent: v('--accent', 'white'), text: v('--text-dim', 'grey'), faint: v('--text-faint', 'grey'),
      error: v('--error', 'magenta'), dust: v('--mm-dust', 'rgba(140,150,220,.35)'),
    };
  }
  readColors();

  let size = 0, dpr = 1, scale = 1, radius = 1600;
  let armsCanvas = null, armsSig = '';
  let data = null;
  let lastViewSig = '', viewMovingUntil = 0;
  let raf = 0, last = 0, disposed = false;
  let hoverSid = null;
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const w = Math.min(MAX_PX, Math.max(140, Math.floor(host.clientWidth || 220)));
    dpr = Math.min(2, win.devicePixelRatio || 1);
    if (w === size && canvas.width === Math.round(w * dpr)) return;
    size = w;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${w}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * dpr);
    armsSig = '';
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); kick(); }) : null;
  ro?.observe(host);

  // world (x, z) → canvas px (CSS units); +X right, +Z down (top-down view)
  const sx = (x) => size / 2 + x * scale;
  const sz = (z) => size / 2 + z * scale;

  function buildArms() {
    const sig = `${size}|${dpr}|${radius}|${data.arms.length}|${data.arms.map((a) => a.points.length).join(',')}`;
    if (sig === armsSig && armsCanvas) return;
    armsSig = sig;
    armsCanvas = armsCanvas || doc.createElement('canvas');
    armsCanvas.width = canvas.width; armsCanvas.height = canvas.height;
    const a = armsCanvas.getContext('2d');
    a.setTransform(dpr, 0, 0, dpr, 0, 0);
    a.clearRect(0, 0, size, size);
    // rim + core
    a.strokeStyle = C.faint; a.globalAlpha = 0.35; a.lineWidth = 1;
    a.beginPath(); a.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2); a.stroke();
    a.globalAlpha = 0.5; a.fillStyle = C.accent;
    a.beginPath(); a.arc(size / 2, size / 2, Math.max(2, 90 * scale), 0, Math.PI * 2); a.globalAlpha = 0.12; a.fill();
    // arms
    a.lineCap = 'round'; a.lineJoin = 'round';
    for (const arm of data.arms) {
      if (!arm.points?.length) continue;
      a.beginPath();
      arm.points.forEach(([x, z], i) => (i ? a.lineTo(sx(x), sz(z)) : a.moveTo(sx(x), sz(z))));
      a.strokeStyle = C.dust; a.globalAlpha = 0.9; a.lineWidth = 5; a.stroke();
      a.strokeStyle = C.faint; a.globalAlpha = 0.55; a.lineWidth = 1; a.stroke();
    }
    a.globalAlpha = 1;
  }

  function hourglass(x, y, s, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = C.needs;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 1.25); ctx.lineTo(x + s, y - s * 1.25); ctx.lineTo(x, y); ctx.closePath();
    ctx.moveTo(x - s, y + s * 1.25); ctx.lineTo(x + s, y + s * 1.25); ctx.lineTo(x, y); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = C.needsCore;
    ctx.beginPath(); ctx.arc(x, y, Math.max(1, s * 0.35), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function draw(tMs) {
    data = galaxy?.minimap?.();
    if (!data || !size) return;
    radius = data.radius || 1600;
    scale = (size / 2 - PAD) / radius;
    buildArms();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(armsCanvas, 0, 0, size, size);

    const selSid = store.selection?.sid || null;
    const quasars = [];
    // systems, dimmest first so live ones sit on top
    for (const s of data.systems) {
      if (s.mode === 'needs-me') { quasars.push(s); continue; }
      const x = sx(s.x), y = sz(s.z);
      switch (s.mode) {
        case 'working':
          ctx.fillStyle = C.working; ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = C.disk; ctx.globalAlpha = 0.9; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.ellipse(x, y, 4.2, 1.6, -0.3, 0, Math.PI * 2); ctx.stroke();
          break;
        case 'my-move':
          ctx.strokeStyle = C.myMove; ctx.globalAlpha = 1; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = C.myMove; ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
          break;
        case 'idle':
          ctx.fillStyle = C.idle; ctx.globalAlpha = 0.75;
          ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
          break;
        case 'crashed':
          ctx.strokeStyle = C.crashed; ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x - 2, y - 2); ctx.lineTo(x + 2, y + 2); ctx.moveTo(x + 2, y - 2); ctx.lineTo(x - 2, y + 2); ctx.stroke();
          break;
        default: // dead / remnant
          ctx.fillStyle = C.dead; ctx.globalAlpha = 0.6;
          ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
      }
    }
    ctx.globalAlpha = 1;

    // view: dashed circle of the visible span around the target + heading tick
    const v = data.view;
    if (v) {
      const vx = sx(v.x), vy = sz(v.z);
      const r = Math.max(5, Math.min(size / 2, (v.span || 400) * scale * 0.5));
      ctx.strokeStyle = C.accent; ctx.globalAlpha = 0.75; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(vx, vy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // camera forward in XZ for yaw (three.js: yaw 0 looks toward -Z)
      const fx = -Math.sin(v.yaw || 0), fz = -Math.cos(v.yaw || 0);
      const bx = vx - fx * (r + 8), by = vy - fz * (r + 8);
      ctx.fillStyle = C.accent; ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(bx + fx * 6, by + fz * 6);
      ctx.lineTo(bx - fz * 3.5, by + fx * 3.5);
      ctx.lineTo(bx + fz * 3.5, by - fx * 3.5);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      const sig = `${Math.round(v.x)}|${Math.round(v.z)}|${(v.yaw || 0).toFixed(2)}|${Math.round(v.span || 0)}`;
      if (sig !== lastViewSig) { lastViewSig = sig; viewMovingUntil = tMs + 800; }
    }

    // selection ring
    if (selSid) {
      const s = data.systems.find((q) => q.sid === selSid);
      if (s) {
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.95;
        ctx.beginPath(); ctx.arc(sx(s.x), sz(s.z), 6.5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // quasars last, always on top; 2.4 s pulse (steady when reduced motion)
    const pulse = reduced ? 1 : 0.5 + 0.5 * Math.sin((tMs / 2400) * Math.PI * 2);
    for (const q of quasars) {
      const x = sx(q.x), y = sz(q.z);
      if (!reduced) {
        ctx.strokeStyle = C.needs; ctx.lineWidth = 1; ctx.globalAlpha = 0.5 * (1 - pulse);
        ctx.beginPath(); ctx.arc(x, y, 5 + 7 * pulse, 0, Math.PI * 2); ctx.stroke();
      }
      hourglass(x, y, 3.4, 0.75 + 0.25 * pulse);
    }
    ctx.globalAlpha = 1;
    return quasars.length;
  }

  function visible() {
    if (doc.hidden || disposed) return false;
    if (panels && (!panels.isShown('minimap') || panels.isCollapsed('minimap'))) return false;
    return true;
  }
  // Fast (rAF, ~12 fps) only while a quasar pulses or the view moves; otherwise a
  // 3 fps timer, so a calm galaxy costs almost nothing. Stops when hidden.
  let slowT = 0;
  function loop(t) {
    raf = 0;
    if (!visible()) return;                     // re-kicked by visibility / panel change
    const hasQ = (store.needsMe?.() || []).length > 0;
    const fast = hasQ || t < viewMovingUntil;
    if (t - last >= (fast ? 1000 / 12 : 1000 / 3)) { last = t; draw(t); }
    if (fast) raf = requestAnimationFrame(loop);
    else slowT = setTimeout(() => { slowT = 0; raf = requestAnimationFrame(loop); }, 330);
  }
  function kick() {
    if (!visible()) return;
    if (slowT) { clearTimeout(slowT); slowT = 0; }
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // ---- picking
  function pickAt(px, py) {
    if (!data) return null;
    let best = null, bd = 10 * 10;
    for (const s of data.systems) {
      const dx = sx(s.x) - px, dy = sz(s.z) - py;
      const d = dx * dx + dy * dy - (s.mode === 'needs-me' ? 30 : 0);   // quasars are easier to hit
      if (d < bd) { bd = d; best = { kind: 'session', sid: s.sid }; }
    }
    if (best) return best;
    let armBest = null, ad = 12 * 12;
    for (const a of data.arms) {
      for (const [x, z] of a.points || []) {
        const dx = sx(x) - px, dy = sz(z) - py;
        const d = dx * dx + dy * dy;
        if (d < ad) { ad = d; armBest = { kind: 'arm', armKey: a.key }; }
      }
    }
    return armBest;
  }
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('click', (e) => {
    const p = pickAt(...local(e));
    if (p) store.select(p, { fly: true });
  });
  canvas.addEventListener('mousemove', (e) => {
    const [px, py] = local(e);
    const p = pickAt(px, py);
    canvas.style.cursor = p ? 'pointer' : 'default';
    if (p?.kind === 'session') {
      if (hoverSid !== p.sid) {
        hoverSid = p.sid;
        const rec = store.get(p.sid);
        setText(tip, rec ? `${clip(rec.title || rec.id.slice(0, 8), 36)} · ${MODE_WORD[rec.state.mode] || rec.state.mode}` : p.sid.slice(0, 8));
        store.hover?.(p);
      }
      tip.hidden = false;
      tip.style.left = `${Math.min(size - 10, px + 10)}px`;
      tip.style.top = `${py + 10}px`;
    } else if (p?.kind === 'arm') {
      hoverSid = null;
      const arm = store.arms?.get(p.armKey);
      setText(tip, `${arm?.name || p.armKey} · project arm`);
      tip.hidden = false;
      tip.style.left = `${Math.min(size - 10, px + 10)}px`;
      tip.style.top = `${py + 10}px`;
    } else {
      if (hoverSid) store.hover?.(null);
      hoverSid = null;
      tip.hidden = true;
    }
  });
  canvas.addEventListener('mouseleave', () => { tip.hidden = true; if (hoverSid) store.hover?.(null); hoverSid = null; });

  const onVis = () => kick();
  doc.addEventListener('visibilitychange', onVis);
  const offs = [
    store.on('session', () => { viewMovingUntil = performance.now() + 300; kick(); }),
    store.on('sessions', () => { armsSig = ''; kick(); }),
    store.on('needs-me', kick),
    store.on('selection', () => { viewMovingUntil = performance.now() + 2000; kick(); }),
  ];
  const offPanels = panels?.onChange?.(() => { resize(); kick(); });

  resize();
  kick();

  return {
    el: wrap,
    redraw() { armsSig = ''; readColors(); kick(); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf); clearTimeout(slowT);
      ro?.disconnect();
      doc.removeEventListener('visibilitychange', onVis);
      for (const o of offs) o?.();
      offPanels?.();
      wrap.remove();
    },
  };
}
