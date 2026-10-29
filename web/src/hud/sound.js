// Sound: real NASA recordings only (no sounds made in code). See web/sounds/CREDITS.md.
//
// - Ambient bed: Cassini's Saturn radio emissions and the Van Allen Probes'
//   "chorus" radio waves, slowly crossfading in a random order, quiet and
//   softened with a gentle low-pass so it sits in the background.
// - Chime: the opening of Sputnik's beep, once, when a session starts needing
//   you (live only, never during history replay; at most one per 8 seconds).
//
// Everything is off until Settings > Sound is on. U mutes (hud/keys.js).
// Browsers only allow audio after a click or key press, so the audio context
// starts on the first interaction after sound is turned on.

import { isMuted } from './keys.js';

const BASE = '/web/sounds/';
const AMBIENT = ['saturn-radio-1.mp3', 'saturn-radio-2.mp3', 'earth-chorus-waves.mp3'];
const CHIME = 'sputnik-beep.mp3';
const AMBIENT_LEVEL = 0.22;     // relative to the master volume
const CHIME_LEVEL = 0.7;
const CHIME_SECONDS = 1.8;      // the first beeps of the recording
const XFADE = 5;                // seconds of overlap between ambient clips
const CHIME_GAP_MS = 8000;

export function createSound(store) {
  let ctx = null;
  let master = null;
  let ambientBus = null;
  const buffers = new Map();
  let ambientOn = false;
  let ambientTimer = null;
  let lastClip = -1;
  let lastChime = 0;
  let disposed = false;

  const cfg = () => store.settings?.sound ?? {};
  const wantsSound = () => !!cfg().enabled && !isMuted();

  async function load(name) {
    if (buffers.has(name)) return buffers.get(name);
    const p = fetch(BASE + name).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
    buffers.set(name, p);
    return p;
  }

  function ensureContext() {
    if (ctx || disposed) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    ambientBus = ctx.createGain();
    ambientBus.gain.value = 0;
    ambientBus.connect(lp).connect(master);
    return ctx;
  }

  function applyLevels() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const vol = wantsSound() ? Math.max(0, Math.min(1, Number(cfg().volume ?? 0.5))) : 0;
    master.gain.setTargetAtTime(vol, t, 0.3);
    const amb = wantsSound() && cfg().ambient !== false ? AMBIENT_LEVEL : 0;
    ambientBus.gain.setTargetAtTime(amb, t, 1.2);
    if (amb > 0 && !ambientOn) startAmbient();
    if (amb === 0 && ambientOn) stopAmbient();
  }

  async function playNextClip() {
    if (!ambientOn || !ctx) return;
    let i = Math.floor(Math.random() * AMBIENT.length);
    if (i === lastClip) i = (i + 1) % AMBIENT.length;
    lastClip = i;
    let buf;
    try { buf = await load(AMBIENT[i]); } catch { return; }
    if (!ambientOn) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const end = t + buf.duration;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + XFADE);
    g.gain.setValueAtTime(1, Math.max(t + XFADE, end - XFADE));
    g.gain.linearRampToValueAtTime(0, end);
    src.connect(g).connect(ambientBus);
    src.start(t);
    // Start the next clip so the two overlap for XFADE seconds.
    ambientTimer = setTimeout(playNextClip, Math.max(1, buf.duration - XFADE) * 1000);
  }

  function startAmbient() {
    ambientOn = true;
    playNextClip();
  }

  function stopAmbient() {
    ambientOn = false;
    clearTimeout(ambientTimer);
  }

  async function chime() {
    if (!wantsSound() || cfg().chime === false || !ctx) return;
    const now = Date.now();
    if (now - lastChime < CHIME_GAP_MS) return;
    lastChime = now;
    let buf;
    try { buf = await load(CHIME); } catch { return; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(CHIME_LEVEL, t);
    g.gain.setValueAtTime(CHIME_LEVEL, t + CHIME_SECONDS - 0.4);
    g.gain.linearRampToValueAtTime(0, t + CHIME_SECONDS);
    src.connect(g).connect(master);
    src.start(t, 0, CHIME_SECONDS);
  }

  // Audio may only start after a user gesture.
  const unlock = () => {
    if (!wantsSound()) return;
    ensureContext();
    if (ctx?.state === 'suspended') ctx.resume();
    applyLevels();
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  const onMute = () => { if (wantsSound()) unlock(); else applyLevels(); };
  window.addEventListener('cosmos:mute', onMute);
  const offs = [
    store.on('settings', () => { if (wantsSound()) unlock(); else applyLevels(); }),
    store.on('needs-me', (e) => { if (e?.entered && store.time?.mode === 'live') chime(); }),
  ];

  return {
    /** For QA: the current audio state. */
    state: () => ({ context: ctx?.state ?? 'none', ambient: ambientOn, wants: wantsSound() }),
    dispose() {
      disposed = true;
      stopAmbient();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('cosmos:mute', onMute);
      offs.forEach((off) => off?.());
      ctx?.close();
    },
  };
}
