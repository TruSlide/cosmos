// Cosmos LENS: Analysis & Diagnostic panel.
//
// GALAXY_CONTRACT §7:
//   createDiagnostics(rootEl /* #diagnostics */, { store, galaxy }) -> {
//     open(eventId), close(), get openId, dispose() }
//
// Opens on selection.kind === 'event' (DIAG_TYPES), and on black hole
// (compaction) and crashed-remnant picks, resolving the matching event id from
// the store. Shows the zero-token DiagReport (summary, facts, lead-up / after
// timeline, outcome), "Replay this moment", and the two learning buttons:
//   - Show the error: store.errorText(id); held in memory only while open.
//   - Explain with Claude: estimate + disclosure first, confirm on a second
//     click, then the answer with REAL usage and the running total.
// Nothing here stores error or answer text anywhere (no localStorage, no
// console). All DOM text goes through textContent.

import { DIAG_TYPES, eventId as mkEventId } from '../shared/schema.mjs';
import { GLOSSARY, fmt, el, findEvent, eventLine } from './hover.js';

const OUTCOME = {
  recovered: { word: 'Recovered', cls: 'ok', means: 'The agent got past it on its own.' },
  'not-recovered': { word: 'Did not recover', cls: 'bad', means: 'The session did not get past this before it stopped or moved on.' },
  pending: { word: 'Still open', cls: 'dim', means: 'Too early to tell: nothing has happened after it yet.' },
};

const FACT_LABELS = {
  tool: 'Tool', target: 'File', kind: 'Kind', durationMs: 'Ran for', retries: 'Retries',
  inStorm: 'Part of a flare storm', stormCount: 'Errors in the storm', recovered: 'Recovered',
  recoveredBy: 'Recovered by', nextOkAfterS: 'Next success after', apiStatus: 'API status',
  denialKind: 'Denied by', retryAttempt: 'Retry attempt', maxRetries: 'Max retries',
  preTokens: 'Tokens before', postTokens: 'Tokens after', droppedTokens: 'Tokens swallowed',
  trigger: 'Trigger', waitedS: 'Waited', how: 'How it ended', reason: 'Reason', count: 'Errors',
  windowS: 'Window', durationS: 'Lasted', tokens: 'Tokens', model: 'Model', type: 'Type', label: 'Label',
  sub: 'Waiting for', okTool: 'Recovered with', source: 'Seen in', toolUseId: 'Tool call id',
};
// Facts that only repeat another row (or are internal ids) are not shown.
const FACT_HIDDEN = new Set(['toolUseId', 'fileId', 'folder', 'ok']);

function factValue(k, v, report) {
  if (v == null) return null;
  switch (k) {
    case 'durationMs': return fmt.ms(v);
    case 'nextOkAfterS': case 'waitedS': case 'durationS': return fmt.dur(v);
    case 'windowS': return fmt.int(v) + ' s';
    case 'kind': return (GLOSSARY.errorKinds[v] || {}).name || String(v);
    case 'reason': return GLOSSARY.crashReasons[v] || String(v);
    case 'sub': return (GLOSSARY.subs[v] || {}).word || String(v);
    case 'target': return String(v).replace(/^f:/, '');
    case 'tool': case 'okTool': return fmt.tool(v);
    case 'recoveredBy': {
      const ev = report && [...(report.after || [])].find((e) => e.id === v);
      return ev ? eventLine(ev) : 'a later step';
    }
    case 'trigger': return v === 'auto' ? 'automatic (memory was full)' : v === 'manual' ? 'manual (/compact)' : String(v);
    default:
      if (typeof v === 'boolean') return v ? 'yes' : 'no';
      if (typeof v === 'number') return /Tokens|tokens|count|Count|retries|Retries|Attempt/.test(k) ? fmt.int(v) : String(v);
      if (typeof v === 'string') return v;
      return null;
  }
}

/** Tiny safe renderer for the Explain answer: paragraphs, "- " bullets, `code`, **bold**. */
function renderAnswer(text) {
  const frag = document.createDocumentFragment();
  const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
      const ul = el(/^\s*\d/.test(lines[0]) ? 'ol' : 'ul', 'lens-diag__list');
      for (const l of lines) { const li = el('li'); inline(li, l.replace(/^\s*([-*•]|\d+[.)])\s+/, '')); ul.append(li); }
      frag.append(ul);
    } else if (/^#{1,4}\s/.test(lines[0]) && lines.length === 1) {
      const h = el('h5', 'lens-diag__ah'); inline(h, lines[0].replace(/^#+\s*/, '')); frag.append(h);
    } else {
      const p = el('p'); inline(p, lines.join(' ')); frag.append(p);
    }
  }
  return frag;
}
function inline(parent, s) {
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) parent.append(document.createTextNode(s.slice(last, m.index)));
    const tok = m[0];
    if (tok[0] === '`') parent.append(el('code', '', tok.slice(1, -1)));
    else parent.append(el('b', '', tok.slice(2, -2)));
    last = m.index + tok.length;
  }
  if (last < s.length) parent.append(document.createTextNode(s.slice(last)));
}

function errMessage(err) {
  const status = err && (err.status || (err.response && err.response.status));
  if (status === 409) return 'Another explanation is already running. Try again in a moment.';
  if (status === 404) return 'Cosmos has no record of this event any more.';
  if (status === 403) return 'The server refused the request (security check). Reload the page and try again.';
  return (err && err.message) ? String(err.message).slice(0, 200) : 'Something went wrong.';
}

export function createDiagnostics(rootEl, { store, galaxy }) {
  rootEl.classList.add('lens-diag-root');

  const panel = el('aside', 'lens-diag');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Analysis & Diagnostic');
  panel.hidden = true;
  rootEl.append(panel);

  let openId = null;
  let gen = 0;               // invalidates in-flight requests on close / reopen
  let report = null;
  let ev = null;             // the event (local copy from the store, if any)
  // Learning state, memory only while open:
  let errText = null;        // ErrorText
  let explainState = 'idle'; // 'idle' | 'confirm' | 'running' | 'done' | 'error'
  let explainRes = null;     // ExplainResult
  let explainErr = '';
  let errState = 'idle';     // 'idle' | 'loading' | 'shown' | 'error'
  let errErr = '';
  let runT0 = 0, runTimer = 0;

  // Section containers (rebuilt per render).
  const head = el('header', 'lens-diag__head');
  const body = el('div', 'lens-diag__body');
  panel.append(head, body);

  function close() {
    gen++;
    openId = null; report = null; ev = null;
    errText = null; errState = 'idle'; errErr = '';
    explainRes = null; explainState = 'idle'; explainErr = '';
    clearInterval(runTimer); runTimer = 0;
    head.replaceChildren(); body.replaceChildren();
    panel.hidden = true;
    panel.classList.remove('is-on');
  }

  function open(id) {
    if (!id) return;
    if (id === openId && !panel.hidden) return;
    close();
    openId = id;
    const my = ++gen;
    ev = findEvent(store, id);
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('is-on'));
    renderLoading();
    Promise.resolve()
      .then(() => store.diag(id))
      .then((r) => { if (my !== gen) return; report = r; if (!r) return renderMissing(); if (r.event) ev = r.event; render(); },
        (err) => { if (my !== gen) return; renderMissing(errMessage(err)); });
  }

  // --- header -------------------------------------------------------------------
  function renderHead() {
    head.replaceChildren();
    const e = (report && report.event) || ev;
    const type = e ? e.type : '';
    const g = GLOSSARY.events[type] || { title: 'Event', glyph: '\u2022' };
    let title = g.title;
    if (type === 'error' && e.data && GLOSSARY.errorKinds[e.data.kind]) title = GLOSSARY.errorKinds[e.data.kind].name;
    const top = el('div', 'lens-diag__top');
    top.append(el('span', 'lens-diag__eyebrow', 'Analysis & Diagnostic'));
    const x = el('button', 'lens-btn lens-btn--icon', '\u2715');
    x.type = 'button'; x.title = 'Close (Esc)'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    top.append(x);
    const h = el('h3', 'lens-diag__title');
    h.append(el('span', 'lens-diag__glyph t-' + type, g.glyph || ''), document.createTextNode(title));
    head.append(top, h);
    const s = report && report.session;
    const rec = e && store.get(e.sid);
    const sessTitle = (s && s.title) || (rec && rec.title) || (e ? String(e.sid).slice(0, 8) : '');
    const armName = s && s.arm ? (typeof s.arm === 'string' ? s.arm : s.arm.name) : rec && rec.arm ? rec.arm.name : '';
    const meta = el('div', 'lens-diag__meta');
    const link = el('button', 'lens-link', sessTitle);
    link.type = 'button'; link.title = 'Fly to this session';
    link.addEventListener('click', () => e && store.select({ kind: 'session', sid: e.sid }, { fly: true }));
    meta.append(link);
    if (armName) meta.append(el('span', 'lens-dim', ' \u00B7 ' + armName));
    if (s && s.model) meta.append(el('span', 'lens-dim mono', ' \u00B7 ' + fmt.model(s.model)));
    head.append(meta);
    if (e) {
      const now = store.now();
      head.append(el('div', 'lens-diag__when', fmt.date(e.t) + ' \u00B7 ' + fmt.ago(e.t, now)));
    }
  }

  function renderLoading() {
    renderHead();
    body.replaceChildren(el('p', 'lens-diag__loading', 'Reading what happened\u2026'));
  }
  function renderMissing(msg) {
    renderHead();
    body.replaceChildren(el('p', 'lens-diag__empty', msg || 'There is no analysis for this event.'));
  }

  // --- body -----------------------------------------------------------------------
  function render() {
    renderHead();
    body.replaceChildren();
    const r = report;
    const e = r.event || ev;
    const type = e ? e.type : '';
    const d = (e && e.data) || {};

    // What happened (zero tokens).
    const sec = el('section', 'lens-diag__sec');
    sec.append(el('h4', '', 'What happened'));
    sec.append(el('p', 'lens-diag__summary', r.summary || (e ? eventLine(e) : '')));
    const oc = OUTCOME[r.outcome];
    if (oc) {
      const chip = el('div', 'lens-outcome is-' + oc.cls);
      chip.append(el('span', 'lens-outcome__dot', oc.cls === 'ok' ? '\u2713' : oc.cls === 'bad' ? '\u2715' : '\u2026'), el('b', '', oc.word), document.createTextNode(' \u2014 ' + oc.means));
      sec.append(chip);
    }
    body.append(sec);

    // Facts.
    const facts = r.facts || {};
    const dl = el('dl', 'lens-facts');
    for (const k of Object.keys(facts)) {
      if (k === 'recovered' && facts.recoveredBy) continue;
      if (k === 'stormCount' && !facts.inStorm) continue;
      if (FACT_HIDDEN.has(k)) continue;
      if (k === 'okTool' && facts.recoveredBy) continue;   // the "Recovered by" row already names it
      const v = factValue(k, facts[k], r);
      if (v == null || v === '') continue;
      dl.append(el('dt', '', FACT_LABELS[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())), el('dd', k === 'target' || k === 'tool' ? 'mono' : 'num', v));
    }
    if (dl.childElementCount) { const fs = el('section', 'lens-diag__sec'); fs.append(el('h4', '', 'The facts'), dl); body.append(fs); }

    // What it means (glossary) + tip.
    const g = GLOSSARY.events[type] || {};
    let means = g.means, spot = g.spot;
    if (type === 'error' && GLOSSARY.errorKinds[d.kind]) { means = GLOSSARY.errorKinds[d.kind].means; spot = GLOSSARY.errorKinds[d.kind].spot; }
    if (means || spot) {
      const ms = el('section', 'lens-diag__sec lens-diag__learn-note');
      ms.append(el('h4', '', 'What it means'));
      if (means) ms.append(el('p', '', means));
      if (spot) { const p = el('p', 'lens-tip'); p.append(el('b', '', 'Spot it yourself: '), document.createTextNode(spot)); ms.append(p); }
      body.append(ms);
    }

    // Timeline.
    if ((r.leadUp && r.leadUp.length) || (r.after && r.after.length)) {
      const ts = el('section', 'lens-diag__sec');
      ts.append(el('h4', '', 'Before and after'));
      const ol = el('ol', 'lens-timeline');
      const t0 = e ? e.t : 0;
      for (const x of r.leadUp || []) ol.append(timelineRow(x, t0, false));
      if (e) ol.append(timelineRow(e, t0, true));
      for (const x of r.after || []) ol.append(timelineRow(x, t0, false));
      ts.append(ol);
      body.append(ts);
    }

    // Replay.
    if (r.replay && typeof store.enterHistory === 'function') {
      const rs = el('section', 'lens-diag__sec lens-diag__actions');
      const b = el('button', 'lens-btn lens-btn--primary', '\u21BA  Replay this moment');
      b.type = 'button';
      b.title = 'Scrub the galaxy to ' + fmt.time(r.replay.at) + ' and play it at normal speed';
      b.addEventListener('click', () => replay(b));
      rs.append(b);
      rs.append(el('span', 'lens-dim', 'Plays ' + fmt.dur((r.replay.to - r.replay.from)) + ' around it, from ' + fmt.dur(Math.max(0, t0Of(e) - r.replay.at)) + ' before.'));
      body.append(rs);
    }

    // Learn: the two buttons.
    const learn = el('section', 'lens-diag__sec lens-learn');
    learn.append(el('h4', '', 'Learn from it'));
    learn.append(renderErrorBlock());
    learn.append(renderExplainBlock());
    body.append(learn);
  }

  function t0Of(e) { return e ? e.t : 0; }

  function timelineRow(x, t0, isThis) {
    const li = el('li', 'lens-tl' + (isThis ? ' is-this' : '') + ' t-' + x.type);
    const dt = x.t - t0;
    li.append(el('span', 'lens-tl__t num', isThis ? 'now' : (dt < 0 ? '\u2212' : '+') + fmt.short(Math.abs(dt)).replace(/^0s$/, '<1s')));
    li.append(el('span', 'lens-tl__g', (GLOSSARY.events[x.type] || {}).glyph || '\u2022'));
    li.append(el('span', 'lens-tl__x', eventLine(x)));
    if (!isThis && DIAG_TYPES.has(x.type)) {
      li.classList.add('is-link');
      li.tabIndex = 0;
      li.title = 'Open the analysis for this event';
      const go = () => open(x.id);
      li.addEventListener('click', go);
      li.addEventListener('keydown', (k) => { if (k.key === 'Enter') go(); });
    }
    return li;
  }

  function replay(btn) {
    const r = report && report.replay;
    if (!r) return;
    btn.disabled = true;
    Promise.resolve(store.enterHistory(r.from, r.to)).then(() => {
      store.setCursor(r.at);
      store.play(1);
      if (r.sid) store.select({ kind: 'session', sid: r.sid }, { fly: true });
    }).catch((err) => { btn.after(el('p', 'lens-err', 'Could not start the replay: ' + errMessage(err))); })
      .finally(() => { btn.disabled = false; });
  }

  // --- Show the error ---------------------------------------------------------------
  function renderErrorBlock() {
    const box = el('div', 'lens-learn__item');
    if (!report.canShowError) {
      box.append(el('p', 'lens-dim', 'Show the error: not available for this event (only tool errors and denials have error text).'));
      return box;
    }
    if (errState === 'idle' || errState === 'error') {
      const b = el('button', 'lens-btn', '\u2263  Show the error');
      b.type = 'button';
      b.title = 'Free. Reads only this error\u2019s text from the transcript, now. Nothing is saved.';
      b.addEventListener('click', loadErrorText);
      box.append(b, el('span', 'lens-dim', ' Free \u00B7 reads only this error\u2019s few lines, now \u00B7 never saved'));
      if (errState === 'error') box.append(el('p', 'lens-err', errErr));
      return box;
    }
    if (errState === 'loading') { box.append(el('p', 'lens-diag__loading', 'Reading the error text\u2026')); return box; }

    // shown
    const et = errText || { lines: [] };
    const pre = el('pre', 'lens-errtext');
    pre.setAttribute('aria-label', 'Error text');
    for (const ln of et.lines || []) pre.append(renderLine(ln), document.createTextNode('\n'));
    const hideBtn = el('button', 'lens-btn lens-btn--ghost', 'Hide');
    hideBtn.type = 'button';
    hideBtn.addEventListener('click', () => { errText = null; errState = 'idle'; rerenderLearn(); });
    const bar = el('div', 'lens-learn__bar');
    bar.append(el('b', '', 'The error'), hideBtn);
    box.append(bar, pre);
    if (et.truncated) box.append(el('p', 'lens-dim', 'Showing the first ' + fmt.int((et.lines || []).length) + ' of ' + fmt.int(et.totalLines) + ' lines.'));
    // How to read it: the gloss from the server + the glossary "how".
    const seen = new Set();
    const gl = el('ul', 'lens-gloss');
    for (const x of et.gloss || []) {
      seen.add(x.kind);
      const li = el('li');
      li.append(el('span', 'lens-mark m-' + x.kind, (GLOSSARY.marks[x.kind] || {}).name || x.kind), document.createTextNode(' ' + x.plain));
      gl.append(li);
    }
    for (const ln of et.lines || []) for (const m of ln.marks || []) {
      if (seen.has(m.kind) || !GLOSSARY.marks[m.kind]) continue;
      seen.add(m.kind);
      const li = el('li');
      li.append(el('span', 'lens-mark m-' + m.kind, GLOSSARY.marks[m.kind].name), document.createTextNode(' ' + GLOSSARY.marks[m.kind].how));
      gl.append(li);
    }
    if (gl.childElementCount) { box.append(el('h5', 'lens-diag__ah', 'How to read it')); box.append(gl); }
    const tip = el('p', 'lens-tip');
    tip.append(el('b', '', 'Spot it yourself: '), document.createTextNode('read an error from the bottom up. The last lines usually say what went wrong; the lines above say where (file and line) and what was running.'));
    box.append(tip);
    return box;
  }

  function renderLine(ln) {
    const span = el('span', 'lens-errtext__ln');
    const text = String(ln.text || '');
    const marks = (ln.marks || []).filter((m) => m && m.end > m.start).slice().sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const m of marks) {
      const s = Math.max(pos, Math.min(text.length, m.start)), e = Math.min(text.length, m.end);
      if (e <= s) continue;
      if (s > pos) span.append(document.createTextNode(text.slice(pos, s)));
      const mk = el('mark', 'lens-mark m-' + m.kind, text.slice(s, e));
      mk.title = (GLOSSARY.marks[m.kind] || {}).name || m.kind;
      span.append(mk);
      pos = e;
    }
    if (pos < text.length) span.append(document.createTextNode(text.slice(pos)));
    return span;
  }

  function loadErrorText() {
    const id = openId, my = gen;
    errState = 'loading'; rerenderLearn();
    Promise.resolve().then(() => store.errorText(id)).then((r) => {
      if (my !== gen) return;
      if (!r) { errState = 'error'; errErr = 'The error text is no longer in the transcript.'; }
      else { errText = r; errState = 'shown'; }
      rerenderLearn();
    }, (err) => { if (my !== gen) return; errState = 'error'; errErr = errMessage(err); rerenderLearn(); });
  }

  // --- Explain with Claude -------------------------------------------------------------
  function runningTotalText(rt) {
    const t = rt || (store.totals && store.totals.explain);
    if (!t) return '';
    const calls = t.calls != null ? t.calls : t.count;
    const tokens = t.tokens != null ? t.tokens : t.total;
    let s = 'Spent on explanations so far: ' + fmt.int(tokens) + ' tokens in ' + fmt.int(calls) + (calls === 1 ? ' explanation' : ' explanations');
    if (t.costUsd != null) s += ' (' + fmt.usd(t.costUsd) + ')';
    return s + '.';
  }

  function renderExplainBlock() {
    const box = el('div', 'lens-learn__item lens-explain');
    const est = report.explainEstimate || null;
    const model = (est && est.model) || (store.settings && store.settings.explain && store.settings.explain.model) || 'haiku';
    const estTotal = est ? (est.inputTokens || 0) + (est.outputTokens || 0) : null;
    const can = typeof store.explain === 'function';

    if (explainState === 'idle' || explainState === 'error') {
      const b = el('button', 'lens-btn', '\u2726  Explain with Claude');
      b.type = 'button'; b.disabled = !can;
      b.addEventListener('click', () => { explainState = 'confirm'; rerenderLearn(); });
      box.append(b, el('span', 'lens-dim', est ? ' Costs about ' + fmt.int(estTotal) + ' tokens \u00B7 asks you first' : ' Costs tokens \u00B7 asks you first'));
      if (explainState === 'error') box.append(el('p', 'lens-err', explainErr));
      const rt = runningTotalText(null);
      if (rt) box.append(el('p', 'lens-dim lens-explain__total', rt));
      return box;
    }

    if (explainState === 'confirm') {
      const card = el('div', 'lens-confirm');
      card.append(el('b', '', 'Before you send it'));
      const dl = el('dl', 'lens-facts');
      dl.append(el('dt', '', 'Model'), el('dd', 'mono', model));
      if (est) {
        dl.append(el('dt', '', 'Input (estimate)'), el('dd', 'num', '\u2248 ' + fmt.int(est.inputTokens) + ' tokens'));
        dl.append(el('dt', '', 'Output (estimate)'), el('dd', 'num', '\u2248 ' + fmt.int(est.outputTokens) + ' tokens'));
        dl.append(el('dt', '', 'Total (estimate)'), el('dd', 'num', '\u2248 ' + fmt.int(estTotal) + ' tokens'));
      }
      card.append(dl);
      card.append(el('p', 'lens-disclosure', 'This runs your own claude command line once. It sends this event\u2019s facts' + (report.canShowError ? ' and the few lines of error text' : '') + ' to Claude, and uses tokens from your account. It runs as a helper session with saving turned off; Cosmos hides it if one is ever written. The answer is shown here once and never saved.'));
      const rt = runningTotalText(null);
      if (rt) card.append(el('p', 'lens-dim', rt));
      const row = el('div', 'lens-confirm__row');
      const yes = el('button', 'lens-btn lens-btn--primary', est ? 'Explain (\u2248 ' + fmt.int(estTotal) + ' tokens)' : 'Explain');
      yes.type = 'button';
      yes.addEventListener('click', runExplain);
      const no = el('button', 'lens-btn lens-btn--ghost', 'Cancel');
      no.type = 'button';
      no.addEventListener('click', () => { explainState = 'idle'; rerenderLearn(); });
      row.append(yes, no);
      card.append(row);
      box.append(card);
      requestAnimationFrame(() => yes.focus());
      return box;
    }

    if (explainState === 'running') {
      const p = el('p', 'lens-diag__loading lens-explain__run', 'Claude is writing the explanation\u2026 ');
      const s = el('span', 'num', fmt.dur((performance.now() - runT0) / 1000));
      p.append(s);
      box.append(p);
      return box;
    }

    // done
    const res = explainRes || {};
    const ans = el('div', 'lens-answer');
    ans.append(renderAnswer(res.text));
    const bar = el('div', 'lens-learn__bar');
    bar.append(el('b', '', 'Claude\u2019s explanation'));
    const hideBtn = el('button', 'lens-btn lens-btn--ghost', 'Hide');
    hideBtn.type = 'button';
    hideBtn.addEventListener('click', () => { explainRes = null; explainState = 'idle'; rerenderLearn(); });
    bar.append(hideBtn);
    box.append(bar, ans);
    // Real cost.
    const u = res.usage || {};
    const cost = el('dl', 'lens-facts lens-cost');
    cost.append(el('dt', '', 'Model'), el('dd', 'mono', res.model || model));
    cost.append(el('dt', '', 'Input'), el('dd', 'num', fmt.int(u.input) + ' tokens'));
    cost.append(el('dt', '', 'Output'), el('dd', 'num', fmt.int(u.output) + ' tokens'));
    if (u.cacheCreate) cost.append(el('dt', '', 'Cache write'), el('dd', 'num', fmt.int(u.cacheCreate) + ' tokens'));
    if (u.cacheRead) cost.append(el('dt', '', 'Cache read'), el('dd', 'num', fmt.int(u.cacheRead) + ' tokens'));
    cost.append(el('dt', '', 'Total used'), el('dd', 'num', fmt.int(u.total) + ' tokens'));
    if (res.estimate) cost.append(el('dt', '', 'Estimated'), el('dd', 'num lens-dim', '\u2248 ' + fmt.int((res.estimate.inputTokens || 0) + (res.estimate.outputTokens || 0)) + ' tokens'));
    if (res.costUsd != null) cost.append(el('dt', '', 'Cost'), el('dd', 'num', fmt.usd(res.costUsd)));
    box.append(el('h5', 'lens-diag__ah', 'What it cost'), cost);
    const rt = runningTotalText(res.runningTotal);
    if (rt) box.append(el('p', 'lens-explain__total', rt));
    if (res.disclosure) box.append(el('p', 'lens-disclosure', res.disclosure));
    return box;
  }

  function runExplain() {
    const id = openId, my = gen;
    explainState = 'running'; runT0 = performance.now();
    rerenderLearn();
    clearInterval(runTimer);
    runTimer = setInterval(() => { if (explainState === 'running') rerenderLearn(); }, 1000);
    Promise.resolve().then(() => store.explain(id)).then((r) => {
      if (my !== gen) return;
      clearInterval(runTimer); runTimer = 0;
      explainRes = r; explainState = r && r.text ? 'done' : 'error';
      if (explainState === 'error') explainErr = 'Claude returned no text.';
      rerenderLearn();
    }, (err) => {
      if (my !== gen) return;
      clearInterval(runTimer); runTimer = 0;
      explainState = 'error'; explainErr = errMessage(err);
      rerenderLearn();
    });
  }

  function rerenderLearn() {
    const learn = body.querySelector('.lens-learn');
    if (!learn || !report) return;
    const h = learn.firstChild;
    learn.replaceChildren(h, renderErrorBlock(), renderExplainBlock());
  }

  // --- resolving picks to events ------------------------------------------------------
  function compactionEventId(sid, cid) {
    const evs = store.events || [];
    const rec = store.get(sid);
    const c = rec && rec.compactions ? rec.compactions.find((x) => x.id === cid) : null;
    const bare = String(cid).replace(/^c-/, '');
    for (let i = evs.length - 1; i >= 0; i--) {
      const x = evs[i];
      if (x.type !== 'compaction' || x.sid !== sid) continue;
      if (x.id.endsWith(':' + cid) || x.id.endsWith(':' + bare) || (c && Math.abs(x.t - c.t) < 2)) return x.id;
    }
    return mkEventId('compaction', sid, bare);
  }
  function crashedEventId(sid) {
    const evs = store.events || [];
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].type === 'crashed' && evs[i].sid === sid) return evs[i].id;
    return null;
  }

  const offSel = store.on('selection', (sel) => {
    if (!sel) return;
    if (sel.kind === 'event' && sel.id) {
      const x = findEvent(store, sel.id);
      if (x && !DIAG_TYPES.has(x.type)) return;   // e.g. a plain tool call from the feed
      open(sel.id);
    } else if (sel.kind === 'compaction' && sel.sid && sel.id) {
      open(compactionEventId(sel.sid, sel.id));
    } else if (sel.kind === 'session' && sel.sid) {
      const rec = store.get(sel.sid);
      const curSid = (report && report.event && report.event.sid) || (ev && ev.sid);
      if (rec && rec.state && rec.state.mode === 'crashed' && curSid !== sel.sid) {
        const id = crashedEventId(sel.sid);
        if (id) open(id);
      }
    }
  });
  const offTotals = store.on('totals', () => {
    if (openId && report && (explainState === 'idle' || explainState === 'error')) rerenderLearn();
  });

  // Esc closes the panel before anything else (it acts like a modal for Esc only).
  const onKey = (k) => {
    if (k.key !== 'Escape' || panel.hidden) return;
    const t = k.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && !panel.contains(t)) return;
    k.preventDefault(); k.stopImmediatePropagation();
    close();
  };
  window.addEventListener('keydown', onKey, true);
  // Keep keystrokes typed inside the panel (buttons) from reaching the camera keys.
  panel.addEventListener('keydown', (k) => { if (k.key !== 'Escape') k.stopPropagation(); });

  return {
    open, close,
    get openId() { return openId; },
    dispose() {
      close();
      offSel && offSel(); offTotals && offTotals();
      window.removeEventListener('keydown', onKey, true);
      panel.remove();
      rootEl.classList.remove('lens-diag-root');
    },
  };
}
