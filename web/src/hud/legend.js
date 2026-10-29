// legend.js: the "?" screen (GALAXY_CONTRACT §6): every cosmic object, what it
// means in plain words, and the real data behind it. Built from DATA_SPEC §8
// (meaning table) and the owner's reading guide. Numbers on the cards ("now: 2")
// are live store totals, so the legend is also a quick census.
//
// The text says only what the scene really draws. Two items of the reading guide
// are not drawn as separate objects in this build and the cards say so:
// cached-context reuse (no outer ring; shown as a number) and moons (zooming in
// turns folder planets into file planets instead).

import { h, setText, GLYPH, MODE_WORD, sessionCounts } from './panels.js';

// Larger legend-only pictures (our own static SVG; colors via currentColor + CSS class).
const BIG = (body) => `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true" focusable="false">${body}</svg>`;
const ART = Object.freeze({
  quasar: BIG('<path d="M10 3h20L20 18z M10 37h20L20 22z" fill="currentColor" opacity=".9"/><circle cx="20" cy="20" r="4" fill="currentColor"/><circle cx="20" cy="20" r="9" fill="none" stroke="currentColor" stroke-width="1" opacity=".5"/>'),
  mymove: BIG('<circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="20" cy="20" r="5" fill="currentColor"/>'),
  working: BIG('<ellipse cx="20" cy="20" rx="17" ry="6" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(-15 20 20)" opacity=".85"/><ellipse cx="20" cy="20" rx="12" ry="3.6" fill="none" stroke="currentColor" stroke-width="1" transform="rotate(-15 20 20)" opacity=".5"/><circle cx="20" cy="20" r="6.5" fill="currentColor"/>'),
  idle: BIG('<circle cx="20" cy="20" r="15" fill="currentColor" opacity=".08"/><circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity=".7"/><circle cx="20" cy="20" r="5" fill="currentColor" opacity=".55"/><circle cx="31" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1"/><path d="M29.4 11l1.4 1.2 1-1.6M31 13.5l.8-1" stroke="currentColor" stroke-width=".8" fill="none"/>'),
  dead: BIG('<circle cx="20" cy="20" r="4" fill="currentColor"/><circle cx="20" cy="20" r="7" fill="none" stroke="currentColor" stroke-width=".6" opacity=".4"/>'),
  crashed: BIG('<circle cx="20" cy="20" r="4" fill="currentColor"/><path d="M20 5l2.6 5.4h-5.2z M34 23.4l-5.8 1.4 1.8-4.8z M8 30l3.2-4.8 2 4.8z M30.5 9.5l-1.6 4.4-2.7-2.9z M9.5 12l4.6.9-3 3.1z" fill="currentColor" opacity=".8"/>'),
  husk: BIG('<circle cx="20" cy="20" r="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 3"/>'),
  star: BIG('<circle cx="20" cy="20" r="9" fill="currentColor"/><circle cx="20" cy="20" r="14" fill="currentColor" opacity=".12"/>'),
  ramp: BIG('<defs><linearGradient id="lg-ramp" x1="0" x2="1"><stop offset="0" style="stop-color:var(--fill-0)"/><stop offset=".5" style="stop-color:var(--fill-50)"/><stop offset=".8" style="stop-color:var(--fill-80)"/><stop offset="1" style="stop-color:var(--fill-100)"/></linearGradient></defs><rect x="3" y="16" width="34" height="8" rx="4" fill="url(#lg-ramp)"/>'),
  whitehole: BIG('<circle cx="20" cy="20" r="6" fill="currentColor"/><path d="M20 3v8M20 29v8M3 20h8M29 20h8M8 8l5.6 5.6M26.4 26.4L32 32M8 32l5.6-5.6M26.4 13.6L32 8" stroke="currentColor" stroke-width="1.6"/>'),
  planets: BIG('<circle cx="20" cy="20" r="3.5" fill="currentColor" opacity=".7"/><ellipse cx="20" cy="20" rx="16" ry="6" fill="none" stroke="currentColor" stroke-width=".7" opacity=".4"/><circle cx="34" cy="22" r="3.6" fill="currentColor"/><circle cx="9" cy="16.5" r="2.4" fill="currentColor"/><circle cx="24" cy="25.5" r="1.6" fill="currentColor"/>'),
  ships: BIG('<circle cx="8" cy="20" r="4" fill="currentColor" opacity=".7"/><circle cx="33" cy="20" r="4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M14 20h12" stroke="currentColor" stroke-width="1" stroke-dasharray="1.5 2.5"/><path d="M22 17l5 3-5 3z" fill="currentColor"/>'),
  agents: BIG('<circle cx="20" cy="20" r="4" fill="currentColor" opacity=".6"/><circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" stroke-width=".8" stroke-dasharray="2 2.5" opacity=".6"/><path d="M29 6l4 9-4-2-4 2z" fill="currentColor"/>'),
  disk: BIG('<ellipse cx="20" cy="20" rx="17" ry="6.5" fill="none" stroke="currentColor" stroke-width="2.6" transform="rotate(-12 20 20)"/><circle cx="20" cy="20" r="4.5" fill="currentColor" opacity=".7"/><path d="M33 12a15 6 -12 0 1 3 4" stroke="currentColor" stroke-width="1.2" fill="none"/>'),
  belt: BIG('<circle cx="20" cy="20" r="4" fill="currentColor" opacity=".6"/>' + Array.from({ length: 22 }, (_, i) => { const a = (i / 22) * Math.PI * 2; const r = 13 + ((i * 7) % 5); return `<circle cx="${(20 + Math.cos(a) * r).toFixed(1)}" cy="${(20 + Math.sin(a) * r * 0.55).toFixed(1)}" r="${(0.8 + (i % 3) * 0.35).toFixed(2)}" fill="currentColor"/>`; }).join('')),
  flare: BIG('<circle cx="20" cy="26" r="7" fill="currentColor" opacity=".35"/><path d="M14 24c0-10 12-10 12 0" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M11 30c4-3 14-3 18 0" stroke="currentColor" stroke-width="1" fill="none" opacity=".6"/>'),
  storm: BIG('<circle cx="20" cy="22" r="6" fill="currentColor" opacity=".3"/><path d="M10 22c0-8 8-8 8 0M18 18c0-9 9-9 9 0M23 24c0-7 8-7 8 0" fill="none" stroke="currentColor" stroke-width="2"/>'),
  blackhole: BIG('<ellipse cx="20" cy="20" rx="17" ry="6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="20" cy="20" r="7.5" style="fill:var(--void)" stroke="currentColor" stroke-width="2"/><path d="M36 9c-4 2-8 6-10 9" stroke="currentColor" stroke-width="1" stroke-dasharray="1.5 2" fill="none"/>'),
  core: BIG('<circle cx="20" cy="20" r="6" fill="currentColor" opacity=".7"/><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width=".8"/>' + Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return `<path d="M${(20 + Math.cos(a) * 14).toFixed(1)} ${(20 + Math.sin(a) * 14).toFixed(1)}L${(20 + Math.cos(a) * (i === 3 ? 18.5 : 16)).toFixed(1)} ${(20 + Math.sin(a) * (i === 3 ? 18.5 : 16)).toFixed(1)}" stroke="currentColor" stroke-width="${i === 3 ? 1.6 : 0.7}"/>`; }).join('')),
  arm: BIG('<path d="M20 20c0-3 3-4.4 5.6-2.4 3.2 2.8 1.6 8.6-3.2 9.8C16 28.6 10.6 23 11.8 16.4 13.2 9.6 21.2 6.8 27.4 9.8c5.8 2.8 8.6 9.6 7.2 15.8" fill="none" stroke="currentColor" stroke-width="2.2" opacity=".85"/>'),
  cluster: BIG('<circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" stroke-width=".7" opacity=".5"/><circle cx="20" cy="9" r="3" fill="currentColor"/><circle cx="30" cy="24" r="2.6" fill="currentColor"/><circle cx="11" cy="25" r="2.8" fill="currentColor"/>'),
  links: BIG('<circle cx="8" cy="30" r="3.4" fill="currentColor"/><circle cx="31" cy="10" r="3.4" fill="currentColor"/><circle cx="31" cy="31" r="2.6" fill="currentColor"/><path d="M10.6 28L28.4 12M11.4 30.4h16.8" stroke="currentColor" stroke-width="1.1"/>'),
  edge: BIG('<path d="M34 20l-8-7v14z" fill="currentColor"/><path d="M10 11h10l-5 9z M10 29h10l-5-9z" fill="currentColor"/>'),
  depth: BIG('<circle cx="9" cy="20" r="5.5" fill="currentColor"/><circle cx="21" cy="20" r="4" fill="currentColor" opacity=".55"/><circle cx="31" cy="20" r="3" fill="currentColor" opacity=".25"/>'),
});

/** The cards. `count(T, S)` returns a live number (or null). */
function sections(storm) {
  return [
    { title: 'What needs you', cards: [
      { art: 'quasar', tone: 'needs', name: 'Neon orange hourglass quasar', means: 'Needs you NOW: a permission to approve, a question for you, or a plan waiting for your OK. Twin jets in an hourglass shape and a slow 2.4 s pulse, so it reads even without color. Brightest thing in the sky; nothing else is ever this orange.',
        data: 'Session registry says "waiting", or a pending AskUserQuestion / ExitPlanMode. Wait clock = time since it started waiting.', count: (T) => T.byMode?.['needs-me'] },
      { art: 'edge', tone: 'needs', name: 'Edge marker', means: 'A quasar that is off screen or behind you. The chevron points the way; the number is how long it has waited. Click it (or press N / B) to fly there.',
        data: 'Same signal as the quasar.' },
      { art: 'mymove', tone: 'mymove', name: 'Calm ring', means: 'Your move: it finished its turn and is waiting for your next message. Visible, but calmer than a quasar.',
        data: 'Registry idle, end of turn, stop-hook summary, or an interrupt.', count: (T) => T.byMode?.['my-move'] },
    ] },
    { title: 'A star system = one session', cards: [
      { art: 'star', tone: 'working', name: 'Star', means: 'The lead agent: one Claude Code session.', data: 'One main transcript file under ~/.claude/projects.', count: (T) => T.sessions },
      { art: 'ramp', tone: 'plain', name: 'Star color', means: 'How full its context window is: blue-white when nearly empty, white at half, rose, then crimson when full. Never orange.',
        data: 'Last turn\'s input + cache tokens ÷ the model\'s context limit (limits table in Settings).' },
      { art: 'whitehole', tone: 'working', name: 'White hole', means: 'A new session bursting into the galaxy, then settling into its place on its project\'s arm.',
        data: 'A new session process, or a transcript whose first entry is under 2 minutes old.' },
      { art: 'working', tone: 'working', name: 'Hot star + accretion disk', means: 'Working. The faster and brighter the disk spins, the harder it is working right now.',
        data: 'Writing, running a tool, or retrying the API. Disk = tool calls and output tokens in the last minute.', count: (T) => T.byMode?.working },
      { art: 'planets', tone: 'planet', name: 'Planets', means: 'Folders it touched when you are zoomed out. Zoom in and they split into its top files, one planet each. Bigger planet = more edits.',
        data: 'Targets of Edit / Write / Read / NotebookEdit tool calls (top 200 files).' },
      { art: 'ships', tone: 'ship', name: 'Ships', means: 'Tool calls: a small ship flies from the star to the planet (file) it works on. Bursts merge into one convoy.',
        data: 'Each tool call in the transcript; a flash on the planet when it lands.' },
      { art: 'agents', tone: 'agent', name: 'Big ships', means: 'Subagents: they leave the star, work in their own orbit, and fly home when done.',
        data: 'Subagent transcript files; label = agent type or task.' },
      { art: 'belt', tone: 'plain', name: 'Asteroid belt', means: 'Tokens spent: denser and wider as the session spends more.',
        data: 'Input + output + cache-write tokens, deduplicated. Reused cached context (cache reads) is reuse, not spend: it is not drawn as a ring; its number is in Sessions / Selected.' },
    ] },
    { title: 'Trouble', cards: [
      { art: 'flare', tone: 'error', name: 'Flare', means: 'A failed tool call: a magenta loop leaps off the star. Click it (or the event) to see what happened.',
        data: 'A tool result marked as an error. Denials and API errors also count.', count: (T) => T.errorsToday, countWord: 'today' },
      { art: 'storm', tone: 'error', name: 'Flare storm', means: `Several failures in a row: ${storm.count} or more errors within ${storm.windowS} s. Holds ${storm.holdS} s after the last one.`,
        data: 'Same errors, counted in a sliding window (threshold in Settings).', count: (T) => T.stormsToday, countWord: 'today' },
      { art: 'blackhole', tone: 'compaction', name: 'Black hole', means: 'A compaction: the context got squeezed. It swallows part of the belt as a visible stream and leaves a cleaner orbit.',
        data: 'A compact boundary in the transcript; size = tokens before − after.', count: (T) => T.compactionsToday, countWord: 'today' },
      { art: 'crashed', tone: 'idle', name: 'Shattered shell', means: 'Crashed or ended abnormally: a dim core inside a frozen shell of shards.',
        data: 'An unanswered API request, a tool that never finished, or a process that died mid-turn.', count: (T) => T.byMode?.crashed },
    ] },
    { title: 'Rest and history', cards: [
      { art: 'idle', tone: 'idle', name: 'Haze + aging planets', means: 'Idle. Over one day its planets age (storms swirl, then volcanoes, then cracks) and a cool grey haze thickens; the label shows "idle 3h". Busy sessions fade more slowly. Idle never moves a system.',
        data: 'Time since its last activity over a 24 h curve (length in Settings).', count: (T) => T.byMode?.idle },
      { art: 'dead', tone: 'idle', name: 'Cold ember', means: 'Dead: the idle day is over, or it exited cleanly. Stable, no animation. (Archived sessions keep fading over their idle day, then turn into embers.)',
        data: 'More than a day since its last activity.', count: (T) => T.byMode?.dead },
      { art: 'husk', tone: 'idle', name: 'Ghost outline', means: 'Deleted, or aged out: the transcript is gone and Cosmos remembers it from its cache.',
        data: 'Cosmos cache only.', count: (T, store) => sessionCounts(store.sessions).ghosts },
    ] },
    { title: 'Layout', cards: [
      { art: 'core', tone: 'plain', name: 'Galactic core', means: 'The fixed landmark at the center. Its glow is how hard everything is working; its ring has 24 hour ticks, the bright one is the current hour.',
        data: 'Summed activity of running sessions; the data clock\'s local hour.' },
      { art: 'arm', tone: 'plain', name: 'Spiral arm', means: 'One project. Its sessions are born on it and stay there; brighter with more open sessions.',
        data: 'The project folder where the session did most of its file work (else its first working directory). Settings → Projects can map a subfolder to its own arm.' },
      { art: 'cluster', tone: 'plain', name: 'Satellite cluster', means: 'Sessions in the same git worktree, grouped just off their arm.',
        data: 'Working directory under /.claude/worktrees/<name>.' },
      { art: 'links', tone: 'plain', name: 'Lines (Map mode, M)', means: 'Thin labeled links: session → its subagents, fork → its parent, session → its arm, worktree member → its cluster.',
        data: 'Subagent files, fork lineage and worktree paths.' },
      { art: 'depth', tone: 'plain', name: 'Fading with distance', means: 'Far systems lose contrast in three depth layers so what is near (and every quasar) stands out.',
        data: 'Camera distance only; not a data signal.' },
    ] },
  ];
}

const KEYS = [
  ['/', 'search'], ['N', 'next needs-me'], ['B', 'nearest quasar'], [']  [', 'next / previous session'],
  ['R', 'whole galaxy'], ['Esc', 'step back'], ['F', 'frame again'], ['L', 'labels'], ['M', 'map links'],
  ['H', 'history'], ['P', 'panels'], ['1–6', 'one panel'], [',', 'settings'], ['U', 'mute'],
  ['Drag', 'orbit'], ['Scroll', 'zoom'], ['W A S D Q E', 'fly'], ['Click', 'fly to it'],
];

/**
 * @param {HTMLElement} modalRoot  #modal-root
 * @param {{ store }} deps
 */
export function createLegend(modalRoot, { store }) {
  const NAME = 'legend';
  const closeBtn = h('button.hud-icon-btn.hud-modal__close', { type: 'button', 'aria-label': 'Close legend', title: 'Close (Esc)', html: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' });
  const body = h('div.hud-legend__body');
  const box = h('div.hud-modal.hud-legend', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hud-legend-title', hidden: true, tabindex: '-1' },
    h('header.hud-modal__head', null,
      h('h2', { id: 'hud-legend-title', text: 'How to read the galaxy' }),
      h('span.hud-modal__hint', { text: 'Every object is real data. Hover anything in the scene for its numbers.' }),
      closeBtn),
    body);
  modalRoot.append(box);
  let open = false;
  const counts = [];

  function build() {
    const S = store.settings?.storm || { count: 3, windowS: 20, holdS: 10 };
    body.replaceChildren();
    counts.length = 0;
    const grid = h('div.hud-legend__grid');
    for (const sec of sections(S)) {
      const col = h('section.hud-legend__sec', null, h('h3', { text: sec.title }));
      for (const c of sec.cards) {
        const n = h('span.hud-legend__count');
        const card = h('article.hud-legend__card', { dataset: { tone: c.tone } },
          h('div.hud-legend__art', { html: ART[c.art] || GLYPH.galaxy }),
          h('div.hud-legend__text', null,
            h('h4', null, h('span', { text: c.name }), n),
            h('p.hud-legend__means', { text: c.means }),
            h('p.hud-legend__data', null, h('span.hud-legend__dl', { text: 'Data: ' }), c.data)));
        if (c.count) counts.push({ el: n, fn: c.count, word: c.countWord || 'now' });
        col.append(card);
      }
      grid.append(col);
    }
    const keys = h('section.hud-legend__keys', null, h('h3', { text: 'Keys' }),
      h('ul', null, KEYS.map(([k, v]) => h('li', null, h('kbd', { text: k }), h('span', { text: v })))));
    const states = h('p.hud-legend__foot', { text: `States in the panels: ${Object.values(MODE_WORD).join(' · ')}. Every state has its own shape, so nothing depends on color alone.` });
    body.append(grid, keys, states);
    updateCounts();
  }
  function updateCounts() {
    const T = store.totals || {};
    for (const c of counts) {
      const v = c.fn(T, store);
      setText(c.el, Number.isFinite(v) ? `${v} ${c.word}` : '');
    }
  }
  const offs = [store.on('totals', () => { if (open) updateCounts(); }), store.on('settings', () => { if (open) build(); })];
  closeBtn.addEventListener('click', () => close());
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  const onBackdrop = (e) => { if (open && e.target === modalRoot) close(); };
  modalRoot.addEventListener('pointerdown', onBackdrop);
  const onModal = (e) => { if (e.detail !== NAME) close(); };
  modalRoot.addEventListener('cosmos-modal', onModal);

  function openBox() {
    modalRoot.dispatchEvent(new CustomEvent('cosmos-modal', { detail: NAME }));
    build();
    open = true;
    box.hidden = false;
    modalRoot.classList.add('has-backdrop');
    requestAnimationFrame(() => box.focus());
  }
  function close() {
    if (!open) return false;
    open = false;
    box.hidden = true;
    modalRoot.classList.remove('has-backdrop');
    return true;
  }
  return {
    open: openBox, close,
    toggle() { if (open) close(); else openBox(); },
    get isOpen() { return open; },
    dispose() {
      for (const o of offs) o?.();
      modalRoot.removeEventListener('pointerdown', onBackdrop);
      modalRoot.removeEventListener('cosmos-modal', onModal);
      box.remove();
    },
  };
}
