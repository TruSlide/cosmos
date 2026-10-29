// HUD assembly (GALAXY_CONTRACT §6): creates every HUD module against the
// page's DOM regions (§9) and returns the createHud API. Wiring follows the
// HUD builder's report; the modules themselves are unchanged.
//
// No module-level mutable state.

import { createPanels, createToasts } from './panels.js';
import { createTopbar } from './breadcrumb.js';
import { createSearch } from './search.js';
import { createMinimap } from './minimap.js';
import { createLegend } from './legend.js';
import { createSettings } from './settings.js';
import { createScrubber } from './scrubber.js';
import { createKeys, isMuted, setMuted } from './keys.js';

/**
 * @param {HTMLElement} rootEl  #hud
 * @param {{ store, galaxy, engine, labels, diagnostics }} deps
 */
export function createHud(rootEl, { store, galaxy, engine = null, labels = null, diagnostics = null }) {
  const doc = rootEl.ownerDocument;
  const $ = (id) => doc.getElementById(id);
  const modalRoot = $('modal-root');

  const toasts = createToasts($('toasts'));
  const panels = createPanels(rootEl, { store, galaxy, engine, diagnostics, toasts });
  const minimap = createMinimap($('minimap'), { store, galaxy, panels });
  const search = createSearch(modalRoot, { store });
  const legend = createLegend(modalRoot, { store });
  const settings = createSettings(modalRoot, { store, toasts });
  let keys = null;
  const topbar = createTopbar($('topbar'), {
    store, galaxy, labels, panels,
    actions: {
      openSearch: () => search.open(),
      openLegend: () => legend.toggle(),
      openSettings: () => settings.toggle(),
      toggleMute: () => { setMuted(!isMuted()); topbar.render(); },
      isMuted,
      nextNeedsMe: () => keys?.nextNeedsMe(),
    },
  });
  const scrubber = createScrubber($('scrubber'), { store, topbar, hudRoot: rootEl, toasts });
  keys = createKeys(doc.defaultView, {
    store, galaxy, labels, diagnostics, panels, toasts,
    actions: {
      openSearch: () => search.open(),
      toggleLegend: () => legend.toggle(),
      toggleSettings: () => settings.toggle(),
      toggleScrubber: () => scrubber.toggle(),
      scrubberOpen: () => scrubber.isOpen,
      playPause: () => scrubber.playPause(),
      closeModal: () => search.close() || legend.close() || settings.close() || topbar.closeMenu(),
      onMute: () => topbar.render(),
    },
  });

  return {
    toasts, panels, minimap, search, legend, settings, topbar, scrubber, keys,
    togglePanel: (name) => panels.toggle(name),
    showPanel: (name, on) => panels.show(name, on),
    hideAll: (on) => panels.hideAll(on),
    openLegend: () => legend.open(),
    openSettings: () => settings.open(),
    openSearch: () => search.open(),
    dispose() {
      for (const m of [keys, scrubber, topbar, settings, legend, search, minimap, panels]) {
        try { m?.dispose?.(); } catch (err) { console.error('[cosmos hud] dispose failed:', err); }
      }
    },
  };
}
