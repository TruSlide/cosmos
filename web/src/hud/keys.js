// keys.js: the keyboard map (GALAXY_CONTRACT §6.1). The camera keeps
// W A S D Q E and Shift; nothing here uses them.
//
//   /  search             N  next needs-me (longest wait first, cycles)
//   B  nearest quasar     ] [  next / previous session in urgency order
//   R  whole galaxy       Esc / Backspace  close a modal first, else step back
//   F  frame selection    L  labels off/on        M  Map mode
//   H  history scrubber   Space  play/pause while the scrubber is open
//   P  hide/show panels   1–6  toggle needs/live/feed/selected/totals/minimap
//   ?  legend             ,  settings             U  mute (sound build)
//
// Ignored while typing in an input, and for any Cmd/Ctrl/Alt combination.

const PANEL_KEYS = Object.freeze({ 1: 'needs', 2: 'live', 3: 'feed', 4: 'selected', 5: 'totals', 6: 'minimap' });
const MUTE_KEY = 'cosmos.sound.muted';

/** True when the event comes from a text field (keys must not fire there). */
export function isTyping(e) {
  const t = e.target;
  if (!t || t === t.ownerDocument?.body) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'reset'].includes(type);
  }
  return false;
}

/** Next id after `cur` in `ids` (wraps); dir = +1 / -1. First item when `cur` is absent. */
export function cycle(ids, cur, dir = 1) {
  if (!ids.length) return null;
  const i = cur ? ids.indexOf(cur) : -1;
  if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(i + dir + ids.length) % ids.length];
}

/** Mute flag (per viewer, localStorage). The sound build reads the same key. */
export function isMuted() {
  try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
export function setMuted(on) {
  try { window.localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent('cosmos:mute', { detail: { muted: !!on } }));
}

/**
 * @param {Window|HTMLElement} target  where to listen (window)
 * @param {{ store, galaxy, labels?, diagnostics?, panels?, toasts?, actions?: {
 *   openSearch?, toggleLegend?, toggleSettings?, toggleScrubber?, scrubberOpen?, playPause?,
 *   closeModal?: () => boolean, onMute? } }} deps
 */
export function createKeys(target, { store, galaxy, labels = null, diagnostics = null, panels = null, toasts = null, actions = {} }) {
  const say = (t) => toasts?.show?.(t);
  const curSid = () => store.selection?.sid || null;
  const fly = (sel) => store.select(sel, { fly: true });

  function nextNeedsMe() {
    const ids = store.needsMe?.() || [];
    if (!ids.length) { say('Nothing needs you right now.'); return; }
    fly({ kind: 'session', sid: cycle(ids, curSid(), 1) });
  }
  function nearestQuasar() {
    const q = galaxy?.quasars?.() || [];
    if (!q.length) { say('No quasars: nothing needs you right now.'); return; }
    let best = q[0];
    for (const x of q) if ((x.dist ?? Infinity) < (best.dist ?? Infinity)) best = x;
    fly({ kind: 'session', sid: best.sid });
  }
  function cycleSessions(dir) {
    const ids = (store.byUrgency?.() || []).filter((id) => store.get(id)?.state?.mode !== 'dead');
    const sid = cycle(ids, curSid(), dir);
    if (sid) fly({ kind: 'session', sid });
  }
  function stepBack() {
    if (actions.closeModal?.()) return;
    if (diagnostics?.openId) { diagnostics.close(); return; }
    if (galaxy?.back) galaxy.back();
  }

  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e)) return;
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    let handled = true;
    switch (lower) {
      case '/': actions.openSearch?.(); break;
      case 'n': nextNeedsMe(); break;
      case 'b': nearestQuasar(); break;
      case ']': cycleSessions(1); break;
      case '[': cycleSessions(-1); break;
      case 'r': fly({ kind: 'galaxy' }); break;
      case 'Escape': case 'Backspace': stepBack(); break;
      case 'f': {
        const s = store.selection;
        if (s && galaxy?.focus) galaxy.focus(s); else fly({ kind: 'galaxy' });
        break;
      }
      case 'l':
        if (labels?.setHidden) { labels.setHidden(!labels.hidden); say(labels.hidden ? 'Labels off (L)' : 'Labels on (L)'); }
        else handled = false;
        break;
      case 'm':
        if (galaxy?.setMapMode) { galaxy.setMapMode(!galaxy.mapMode); say(galaxy.mapMode ? 'Map mode on: links between sessions, subagents, forks and arms' : 'Map mode off'); }
        else handled = false;
        break;
      case 'h': actions.toggleScrubber?.(); break;
      case ' ':
        if (actions.scrubberOpen?.()) actions.playPause?.(); else handled = false;
        break;
      case 'p': panels?.hideAll?.(); break;
      case '?': actions.toggleLegend?.(); break;
      case ',': actions.toggleSettings?.(); break;
      case 'u': {
        const m = !isMuted();
        setMuted(m);
        const enabled = !!store.settings?.sound?.enabled;
        say(m ? 'Sound muted (U)' : enabled ? 'Sound unmuted (U)' : 'Unmuted, but sound is off: turn it on in Settings (,)');
        actions.onMute?.(m);
        break;
      }
      default:
        if (PANEL_KEYS[k] && panels?.toggle) panels.toggle(PANEL_KEYS[k]);
        else handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  // capture phase so canvas/camera handlers never see a key we used
  target.addEventListener('keydown', onKey, true);

  return {
    nextNeedsMe, nearestQuasar, cycleSessions, stepBack,
    dispose() { target.removeEventListener('keydown', onKey, true); },
  };
}
