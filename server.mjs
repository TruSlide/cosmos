// Cosmos local server.
//
// Loopback-only server for the Cosmos web app. It uses nothing but Node
// built-ins, binds 127.0.0.1 (never any other host), never lists directories,
// and refuses any path that resolves outside the project root, including
// through symlinks. Requests whose Host is not 127.0.0.1/localhost are refused
// (DNS-rebinding guard).
//
// Files: only /web/ and /vendor/. /web/galaxy.html is served with the per-run
// token injected (Cache-Control: no-store). GET /api/replay[?session=<sid>] is
// the Gate 1 replay (replay.mjs). Everything else under /api/ is server/api.mjs
// (GALAXY_CONTRACT §3.6); POST is allowed only there, and only from our own
// page (Origin + token, server/security.mjs).
//
//   node server.mjs            -> http://127.0.0.1:4747
//   PORT=5000 node server.mjs  -> port override (the host never changes)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReplay } from './replay.mjs';
import { createSecurity } from './server/security.mjs';
import { createStore } from './server/store.mjs';
import { createApi, loadSettings, loadLimits } from './server/api.mjs';
import { createDiag } from './server/diag.mjs';
import { createClaudeSettings } from './server/claude-settings.mjs';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 4747;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// The root itself may live behind a symlink; compare against both spellings.
const ROOT_REAL = fs.realpathSync(ROOT);
const CACHE_DIR = path.join(ROOT, 'cache');
const SETTINGS_PATH = path.join(ROOT, 'settings.json');
const LIMITS_PATH = path.join(ROOT, 'limits.json');
const GALAXY_PAGE = path.join(ROOT_REAL, 'web', 'galaxy.html');
const GATE1_PAGE = path.join(ROOT_REAL, 'web', 'gate1.html');
// The only two trees the browser may read. Checked AFTER decoding and realpath,
// so an encoded slash ('/web/..%2Fcache') cannot step outside them.
const SERVE_ROOTS = ['web', 'vendor'].map((d) => {
  try { return fs.realpathSync(path.join(ROOT_REAL, d)); } catch { return path.join(ROOT_REAL, d); }
});
const inServeRoot = (p) => SERVE_ROOTS.some((r) => isInside(p, r));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const BASE_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',                         // no clickjacking of Apply / Explain
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

/** True when `p` is strictly inside `base` (not equal to it, no prefix tricks). */
function isInside(p, base) {
  return p.startsWith(base + path.sep);
}

function send(res, status, body, extra = {}) {
  const text = body ?? '';
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(res.req.method === 'HEAD' ? undefined : text);
}

/**
 * Resolve a URL pathname to a real file inside ROOT, or return an HTTP status.
 * @returns {Promise<{file: string, size: number} | {status: number}>}
 */
async function resolveFile(pathname) {
  // Encoded separators are never legitimate in a static path.
  if (/%2f|%5c|\\/i.test(pathname)) return { status: 400 };
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes('\0')) return { status: 400 };

  // '.' + pathname keeps the request relative to ROOT even when it starts with '/'.
  const candidate = path.resolve(ROOT, '.' + decoded);
  if (!isInside(candidate, ROOT)) return { status: 403 };
  if (!isInside(candidate, path.join(ROOT, 'web')) && !isInside(candidate, path.join(ROOT, 'vendor'))) return { status: 403 };

  let real;
  try {
    real = await fs.promises.realpath(candidate);
  } catch {
    return { status: 404 };
  }
  // Symlink escape check: the real target must also live under the real root.
  if (!isInside(real, ROOT_REAL) || !inServeRoot(real)) return { status: 403 };

  let stat;
  try {
    stat = await fs.promises.stat(real);
  } catch {
    return { status: 404 };
  }

  if (stat.isDirectory()) {
    // Directories never list; they only serve their own index.html.
    const index = path.join(real, 'index.html');
    try {
      const realIndex = await fs.promises.realpath(index);
      if (!isInside(realIndex, ROOT_REAL) || !inServeRoot(realIndex)) return { status: 403 };
      const s = await fs.promises.stat(realIndex);
      if (!s.isFile()) return { status: 404 };
      return { file: realIndex, size: s.size };
    } catch {
      return { status: 404 };
    }
  }

  if (!stat.isFile()) return { status: 404 };
  return { file: real, size: stat.size };
}

const STATUS_TEXT = { 400: 'Bad request', 403: 'Forbidden', 404: 'Not found' };

// ---------------------------------------------------------------- data service
const settings = loadSettings(SETTINGS_PATH);
const security = createSecurity({ port: PORT });
const store = createStore({ cacheDir: CACHE_DIR, settings });
store.writeLaunchConfig(settings.launch).catch((err) => console.error('cosmos: launch-config:', err.code || err.message));
const claudeSettings = createClaudeSettings({ cosmosRoot: ROOT, backupDir: path.join(CACHE_DIR, 'backups') });

// The data layer (server/model.mjs, DATA-CORE). If it cannot load, the page,
// Gate 1 and /api/viewers still work and data endpoints answer 503.
let model = null;
let api = null;
try {
  const { createModel } = await import('./server/model.mjs');
  model = createModel({
    limitsPath: LIMITS_PATH,
    settings,
    store,
    excludeCwdPrefix: CACHE_DIR + path.sep,
    onEvent: (ev) => { store.appendEvent(ev); api?.onEvent(ev); },
    onChange: (sid) => {
      const rec = model?.get(sid);
      if (rec) store.saveSnapshot(rec);
      api?.onChange(sid);
    },
  });
} catch (err) {
  console.error(`cosmos: data layer unavailable (${err.code || err.message}); serving pages only`);
  model = null;
}
const diag = model ? createDiag({ model, store, settings: () => api.settings(), cacheDir: CACHE_DIR, cosmosRoot: ROOT }) : null;
api = createApi({
  model, store, security, diag, claudeSettings,
  settingsPath: SETTINGS_PATH, limitsPath: LIMITS_PATH, root: ROOT, port: PORT,
  settings, limits: loadLimits(LIMITS_PATH),
});

/** The galaxy page, with this run's token in its meta tag. Never cached. */
async function sendGalaxyPage(req, res, file = GALAXY_PAGE) {
  let html;
  try { html = await fs.promises.readFile(file, 'utf8'); } catch {
    send(res, 404, 'Not found');
    return;
  }
  const body = security.injectToken(html);
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  try {
    const isApi = (req.url ?? '').startsWith('/api/');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && isApi)) {
      send(res, 405, 'Method not allowed', { Allow: isApi ? 'GET, HEAD, POST' : 'GET, HEAD' });
      return;
    }

    // DNS-rebinding guard: a hostile page whose domain re-resolves to
    // 127.0.0.1 still sends its own name in Host, so only our two names pass.
    if (!security.hostOk(req)) {
      send(res, 403, 'Forbidden');
      return;
    }

    // Only the path matters beyond that check.
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname === '/') {
      send(res, 302, 'Found', { Location: '/web/galaxy.html' });
      return;
    }

    if (await api.handle(req, res, url)) return;

    if (url.pathname === '/api/replay') {
      const sid = url.searchParams.get('session');
      const replay = await buildReplay(sid || null);
      if (!replay) {
        send(res, 404, 'No transcript to replay');
        return;
      }
      send(res, 200, JSON.stringify(replay), { 'Content-Type': 'application/json; charset=utf-8' });
      return;
    }

    // Only the app and its vendored libraries are files the browser may fetch.
    if (!url.pathname.startsWith('/web/') && !url.pathname.startsWith('/vendor/')) {
      send(res, 404, 'Not found');
      return;
    }

    const found = await resolveFile(url.pathname);
    if ('status' in found) {
      send(res, found.status, STATUS_TEXT[found.status] ?? 'Error');
      return;
    }
    if (found.file === GALAXY_PAGE || found.file === GATE1_PAGE) {
      await sendGalaxyPage(req, res, found.file);
      return;
    }

    const type = MIME[path.extname(found.file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': found.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(found.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    if (!res.headersSent) send(res, 500, 'Internal error');
    else res.destroy();
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `cosmos: port ${PORT} is in use (try PORT=xxxx node server.mjs)`
    : err);
  process.exit(1);
});

// Listen first, so the page and /api/viewers answer during the backfill.
server.listen(PORT, HOST, () => {
  console.log(`cosmos on http://${HOST}:${PORT}`);
  if (!model) return;
  const t0 = Date.now();
  model.start().then(async () => {
    store.commitLayout();
    await api.setLoaded();
    store.saveState(model.readerState());
    console.log(`cosmos: ${model.sessions().size} sessions loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }).catch((err) => {
    console.error('cosmos: data layer failed to start:', err?.stack || err);
  });
});

// Reader offsets: the store debounces writes to one per 60 s.
const stateTimer = setInterval(() => { if (model && api.loaded) store.saveState(model.readerState()); }, 30000);
stateTimer.unref();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`cosmos: ${signal}, saving cache`);
  const hard = setTimeout(() => process.exit(1), 8000);
  hard.unref();
  try {
    api.close();
    if (model) {
      if (api.loaded) {
        store.saveState(model.readerState());
        for (const rec of model.sessions().values()) store.saveSnapshot(rec);
      }
      model.stop();
    }
    await store.flush();
  } catch (err) {
    console.error('cosmos: shutdown:', err?.message || err);
  }
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
