// Reserved-hue QA: only NEEDS_ME / NEEDS_ME_CORE may land in the NEEDS ME
// orange band, before or after tone mapping.
//
//   node --test tests/*.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./three-resolve.mjs', import.meta.url);
const THREE = await import('three');
const { PALETTE, color, starColor, saturateOklab, isReservedHue, linearToOklch } = await import('../web/src/lib/palette.js');

const EXPOSURE = 0.95; // engine.js

// three's ACESFilmicToneMapping (tonemapping_pars_fragment), in JS.
function aces(c) {
  const k = EXPOSURE / 0.6;
  let r = c.r * k, g = c.g * k, b = c.b * k;
  const i = [
    0.59719 * r + 0.35458 * g + 0.04823 * b,
    0.07600 * r + 0.90834 * g + 0.01566 * b,
    0.02840 * r + 0.13383 * g + 0.83777 * b,
  ];
  const f = i.map((v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081));
  const o = [
    1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2],
    -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2],
    -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2],
  ].map((v) => Math.min(1, Math.max(0, v)));
  return new THREE.Color(o[0], o[1], o[2]);
}
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const atLuma = (c, L) => c.clone().multiplyScalar(L / Math.max(1e-6, luma(c)));
const describe = (c) => linearToOklch(c.r, c.g, c.b).map((v) => v.toFixed(3)).join(' / ');

const RESERVED = new Set(['NEEDS_ME', 'NEEDS_ME_CORE']);
const LUMAS = [0.5, 1, 2];

test('NEEDS_ME itself is in the reserved band', () => {
  assert.equal(isReservedHue(PALETTE.NEEDS_ME), true);
});

test('no other palette entry is in the reserved band, raw or after ACES', () => {
  for (const [name, hex] of Object.entries(PALETTE)) {
    if (RESERVED.has(name)) continue;
    assert.equal(isReservedHue(hex), false, `${name} raw (${describe(color(name))})`);
    for (const L of LUMAS) {
      const out = aces(atLuma(color(name), L));
      assert.equal(isReservedHue(out), false, `${name} ACES @${L} (${describe(out)})`);
    }
  }
});

test('the context-fill ramp never enters the reserved band', () => {
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    const c = starColor(f);
    assert.equal(isReservedHue(c), false, `starColor(${f}) raw (${describe(c)})`);
    for (const L of LUMAS) {
      const out = aces(atLuma(c, L));
      assert.equal(isReservedHue(out), false, `starColor(${f}) ACES @${L} (${describe(out)})`);
    }
  }
});

test('pre-saturated star colors (as star.js feeds its shaders) stay out of the band', () => {
  for (let i = 0; i <= 20; i++) {
    const base = starColor(i / 20);
    for (const k of [1.4, 1.7, 2.2]) {
      const c = saturateOklab(base, k, new THREE.Color());
      assert.ok(c.r >= 0 && c.g >= 0 && c.b >= 0, 'in gamut');
      assert.equal(isReservedHue(c), false, `starColor(${i / 20}) ×${k} (${describe(c)})`);
      const hIn = linearToOklch(base.r, base.g, base.b)[2];
      const hOut = linearToOklch(c.r, c.g, c.b)[2];
      if (linearToOklch(base.r, base.g, base.b)[1] > 0.02) {
        assert.ok(Math.abs(hIn - hOut) < 1.5, `hue kept: ${hIn.toFixed(1)} → ${hOut.toFixed(1)}`);
      }
    }
  }
});
