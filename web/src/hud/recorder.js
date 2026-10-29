// Record button: captures the 3D view (the canvas only) to a video file.
//
// What it records: only the rendered universe. Panels, labels and popups are
// page elements, not part of the canvas, so session names and numbers never
// end up in a clip; that makes recordings safe to share.
// Where it saves: POST to /api/recordings, which writes cosmos/recordings/
// (the only place it writes). Shown in the corner while recording, with a timer.

const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function createRecorder(canvas, { fps = 60, bitsPerSecond = 16_000_000, onSaved = null, token: given = null } = {}) {
  // The galaxy page clears its meta tag after reading the token, so it passes it in.
  const token = given ?? document.querySelector('meta[name="cosmos-token"]')?.content ?? '';
  const mime = MIME_CANDIDATES.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cosmos-rec';
  btn.setAttribute('aria-pressed', 'false');
  btn.title = 'Record the 3D view to a video (panels and labels are not recorded)';
  btn.innerHTML = '<span class="cosmos-rec-dot" aria-hidden="true"></span><span class="cosmos-rec-label">Record</span>';
  const style = document.createElement('style');
  style.textContent = `
.cosmos-rec{position:fixed;right:max(16px,env(safe-area-inset-right,0px));bottom:max(16px,env(safe-area-inset-bottom,0px));z-index:60;
  display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 14px;border-radius:18px;cursor:pointer;
  font:500 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;
  color:#dfe6f5;background:rgba(10,14,28,.78);border:1px solid rgba(160,180,230,.28);backdrop-filter:blur(6px)}
.cosmos-rec:hover{border-color:rgba(200,215,255,.6)}
.cosmos-rec:focus-visible{outline:2px solid #9fc1ff;outline-offset:2px}
.cosmos-rec-dot{width:10px;height:10px;border-radius:50%;background:#e8455e}
.cosmos-rec[aria-pressed="true"] .cosmos-rec-dot{animation:cosmosRecBlink 1s steps(1) infinite}
@keyframes cosmosRecBlink{50%{opacity:.25}}
@media (prefers-reduced-motion: reduce){.cosmos-rec[aria-pressed="true"] .cosmos-rec-dot{animation:none}}`;
  document.head.appendChild(style);
  document.body.appendChild(btn);

  let rec = null;
  let chunks = [];
  let started = 0;
  let timer = null;
  const label = btn.querySelector('.cosmos-rec-label');
  const setLabel = (t) => { label.textContent = t; };

  if (!mime || !canvas.captureStream) {
    btn.disabled = true;
    setLabel('Record unavailable');
    btn.title = 'This browser cannot record the canvas.';
  }

  function start() {
    if (rec || btn.disabled) return;
    const stream = canvas.captureStream(fps);
    chunks = [];
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = save;
    rec.start(1000);
    started = performance.now();
    btn.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => {
      const s = Math.floor((performance.now() - started) / 1000);
      setLabel(`Stop · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }, 250);
    setLabel('Stop · 0:00');
  }

  function stop() {
    if (!rec) return;
    clearInterval(timer);
    rec.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
  }

  let lastResult = null;
  async function save() {
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    rec = null;
    btn.setAttribute('aria-pressed', 'false');
    setLabel('Saving…');
    try {
      const r = await fetch('/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': blob.type, 'X-Cosmos-Token': token },
        body: blob,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message || `HTTP ${r.status}`);
      lastResult = j;
      setLabel('Saved');
      onSaved?.(j);
    } catch (err) {
      lastResult = { ok: false, error: String(err.message || err) };
      setLabel('Save failed');
      btn.title = `Could not save the recording: ${lastResult.error}`;
    }
    setTimeout(() => setLabel('Record'), 3000);
  }

  btn.addEventListener('click', () => (rec ? stop() : start()));

  return {
    start,
    stop,
    get recording() { return !!rec; },
    get lastResult() { return lastResult; },
    dispose() { stop(); btn.remove(); style.remove(); },
  };
}
