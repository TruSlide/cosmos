// Request guards for the Cosmos server (GALAXY_CONTRACT §3.5).
//
// - Every request must name us in Host (DNS-rebinding guard).
// - Every POST must also come from our own page: Origin equal to our origin,
//   the per-run token the server injected into that page, and a JSON body.
// - No CORS headers are ever sent, so other sites cannot read any response.

import crypto from 'node:crypto';

/** An Error carrying an HTTP status and a stable code, thrown by server modules. */
export function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export function createSecurity({ port }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenBuf = Buffer.from(token);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function hostOk(req) {
    const host = String(req.headers.host || '').toLowerCase();
    return hosts.has(host);
  }

  function tokenOk(req) {
    const got = req.headers['x-cosmos-token'];
    if (typeof got !== 'string' || got.length === 0) return false;
    const buf = Buffer.from(got);
    if (buf.length !== tokenBuf.length) return false;
    return crypto.timingSafeEqual(buf, tokenBuf);
  }

  function postOk(req) {
    if (!hostOk(req)) return false;
    const host = String(req.headers.host).toLowerCase();
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin.toLowerCase() !== `http://${host}`) return false;
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) return false;
    return tokenOk(req);
  }

  function injectToken(html) {
    return String(html).split('__COSMOS_TOKEN__').join(token);
  }

  return { token, hostOk, postOk, injectToken };
}
