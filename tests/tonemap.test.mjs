// NEEDS ME tone map: a JS mirror of engine.js cosmosToneMap(), checked against
// the Gate 1 acceptance rule (tone-mapped NEEDS ME: OKLCH hue 35–45°, chroma
// ≥ 0.15) and against plain ACES for colors outside the band.
//
//   node --test tests/*.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./three-resolve.mjs', import.meta.url);
const THREE = await import('three');
const { color, starColor, linearToOklch, isReservedHue } = await import('../web/src/lib/palette.js');

const EXPOSURE = 0.95;
const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
function aces([r, g, b]) {
  const k = EXPOSURE / 0.6;
  r *= k; g *= k; b *= k;
  const i = [0.59719 * r + 0.35458 * g + 0.04823 * b, 0.07600 * r + 0.90834 * g + 0.01566 * b, 0.02840 * r + 0.13383 * g + 0.83777 * b].map(fit);
  return [
    1.60475 * i[0] - 0.53108 * i[1] - 0.07367 * i[2],
    -0.10208 * i[0] + 1.10813 * i[1] - 0.00605 * i[2],
    -0.00327 * i[0] - 0.07276 * i[1] + 1.07602 * i[2],
  ].map((v) => Math.min(1, Math.max(0, v)));
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const n = color('NEEDS_ME');
const hN = (linearToOklch(n.r, n.g, n.b)[2] * Math.PI) / 180;
const rad = (d) => (d * Math.PI) / 180;
function cosmosToneMap(c) {
  const a = aces(c);
  const [L, C, hDeg] = linearToOklch(...c);
  if (L <= 1e-5 || C <= 1e-6) return a;
  const cosd = Math.cos(rad(hDeg) - hN);
  const w = sstep(Math.cos(rad(22)), Math.cos(rad(15)), cosd) * sstep(0.08, 0.16, C / L);
  if (w <= 0) return a;
  const m = Math.max(...c);
  const tm = aces([m, m, m])[1];
  const hp = c.map((v) => (v * tm) / m);
  return a.map((v, i) => v + (hp[i] - v) * w);
}
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const at = (c, L) => [c.r, c.g, c.b].map((v) => (v * L) / luma(c));

test('NEEDS_ME stays electric orange after tone mapping, at any brightness', () => {
  for (const L of [0.1, 0.3, 0.6, 1, 2, 4, 8, 16]) {
    const [, C, h] = linearToOklch(...cosmosToneMap(at(n, L)));
    assert.ok(h >= 35 && h <= 45, `luminance ${L}: hue ${h.toFixed(1)}°`);
    assert.ok(C >= 0.15, `luminance ${L}: chroma ${C.toFixed(3)}`);
  }
});

test('plain ACES alone would have failed (documents the blocker)', () => {
  const [, , h] = linearToOklch(...aces(at(n, 1)));
  assert.ok(h > 45, `ACES hue at luminance 1 is ${h.toFixed(1)}°`);
});

test('colors outside the band keep plain ACES', () => {
  for (const name of ['MY_MOVE', 'ERROR', 'DISK_OUTER', 'STAR_FILL_0', 'NEEDS_ME_CORE']) {
    const c = at(color(name), 2);
    assert.deepEqual(cosmosToneMap(c), aces(c), name);
  }
});

test('the context ramp never tone-maps into the reserved band', () => {
  // The crimson end (hue ~24°) is close enough to get hue preservation too:
  // it then keeps its own hue instead of ACES dragging it toward orange.
  for (let i = 0; i <= 20; i++) {
    for (const L of [0.5, 1, 2]) {
      const [r, g, b] = cosmosToneMap(at(starColor(i / 20, new THREE.Color()), L));
      assert.equal(isReservedHue({ r, g, b }), false, `starColor(${i / 20}) @${L}`);
    }
  }
});
