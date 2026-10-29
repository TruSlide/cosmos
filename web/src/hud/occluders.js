// occluders.js: the screen rectangles the HUD covers (panels, top bar,
// scrubber), in CSS px. Labels treat them as occupied space in their declutter
// pass, and needs-me edge markers are pulled out from under them, so nothing
// important hides behind a panel.
//
// Reading layout is cheap for a handful of elements but forces a style flush,
// so rects are re-read at most every REFRESH_MS (and at once after a resize).

const SEL = '#hud .hud-panel, #hud .hud-topbar, #hud .hud-scrubber';
const REFRESH_MS = 250;

/**
 * @param {Document} [doc]
 * @returns {{ rects(): Array<{l:number,t:number,r:number,b:number}>, invalidate(): void, dispose(): void }}
 */
export function createOccluders(doc = globalThis.document) {
  let list = [];
  let at = -Infinity;
  const pool = [];
  const now = () => (globalThis.performance ? performance.now() : Date.now());
  const invalidate = () => { at = -Infinity; };
  globalThis.addEventListener?.('resize', invalidate);

  function read() {
    let n = 0;
    if (doc) {
      for (const el of doc.querySelectorAll(SEL)) {
        if (el.hidden) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 2 || b.height < 2) continue;
        // The top bar spans the width but is mostly empty glass: keep its band.
        const r = pool[n] || (pool[n] = { l: 0, t: 0, r: 0, b: 0 });
        r.l = b.left; r.t = b.top; r.r = b.right; r.b = b.bottom;
        n++;
      }
    }
    list = pool.slice(0, n);
  }

  return {
    rects() {
      const t = now();
      if (t - at >= REFRESH_MS) { at = t; read(); }
      return list;
    },
    invalidate,
    dispose() { globalThis.removeEventListener?.('resize', invalidate); },
  };
}
