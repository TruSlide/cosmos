// node --test tests/static.test.mjs
// Spawns a COPY of server.mjs (temp folder, fake HOME, random port) and checks
// the static allowlist: only /web/ and /vendor/ are servable, even with
// encoded separators. Never touches ~/.claude or the real cosmos/cache.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmos-static-'));
const app = path.join(tmp, 'app');
const home = path.join(tmp, 'home');
const PORT = 20000 + Math.floor(Math.random() * 20000);
let child;

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['server.mjs', 'replay.mjs']) fs.copyFileSync(path.join(SRC, f), path.join(app, f));
  fs.cpSync(path.join(SRC, 'server'), path.join(app, 'server'), { recursive: true });
  fs.cpSync(path.join(SRC, 'web'), path.join(app, 'web'), { recursive: true });
  fs.mkdirSync(path.join(app, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(app, 'vendor', 'ok.js'), '//ok');
  fs.mkdirSync(path.join(app, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(app, 'cache', 'state.json'), '{"secret":1}');
  child = spawn(process.execPath, ['server.mjs'], { cwd: app, env: { ...process.env, HOME: home, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await get('/vendor/ok.js'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(async () => {
  // Wait for the server child to exit before removing its temp folder (it may still be writing).
  if (child && child.exitCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('allowlisted files are served', async () => {
  assert.equal(await get('/vendor/ok.js'), 200);
  assert.equal(await get('/web/src/lib/math.js'), 200);
});

test('encoded slash cannot escape /web or /vendor', async () => {
  for (const p of ['/web/..%2Fcache%2Fstate.json', '/vendor/..%2Fserver.mjs', '/web/..%2f..%2fapp%2fserver.mjs',
    '/web/..%5Cserver.mjs', '/web/%2e%2e/server.mjs', '/web/../cache/state.json']) {
    const code = await get(p);
    assert.ok([400, 403, 404].includes(code), `${p} -> ${code}`);
  }
});
