// Cosmos palette (ART_DIRECTION §2). The ONLY place colors are written as hex.
//
// Hex values are sRGB. `color(name)` returns a THREE.Color in the linear
// working space (three's ColorManagement converts on setHex), which is what
// shaders and the HDR composer expect.
//
// NEEDS_ME / NEEDS_ME_CORE are reserved for the quasar (star.js only).

import * as THREE from 'three';

export const PALETTE = Object.freeze({
  NEEDS_ME: 0xFF5F1F,
  NEEDS_ME_CORE: 0xFFF1E6,
  VOID: 0x02030A,
  DUST_VIOLET: 0x1B1238,
  DUST_TEAL: 0x0B2A33,
  STAR_FILL_0: 0xCFE0FF,
  STAR_FILL_50: 0xFFF8F0,
  STAR_FILL_80: 0xFFB8C0,
  STAR_FILL_100: 0xE3263F,
  DISK_INNER: 0xE8F1FF,
  DISK_OUTER: 0x6A7CFF,
  DISK_DOPPLER: 0xBFE6FF,
  MY_MOVE: 0x3EE6C8,
  THINK_DEEP: 0x2C1A7A,
  THINK_VIOLET: 0x6B4BFF,
  THINK_FILAMENT: 0x9AE6FF,
  SHIP_TOOL: 0xA8ECFF,
  SHIP_AGENT: 0x8CFFC1,
  ERROR: 0xFF3D9A,
  PHOTON_RING: 0xFFF5E8,
  WHITE_HOLE: 0xFFFFFF,
  WHITE_HOLE_EDGE: 0xB8F3FF,
  REMNANT_CORE: 0x8C8FB3,
  REMNANT_SHARD: 0x3A3F5C,
  CINDER: 0x3A3E4A,
  CINDER_RIM: 0x5B6378,
  ROCK: 0x6E7486,
  ROCK_SPEC: 0xC9D2E6,
});

/** Planet base colors, picked by hash of the file id. */
export const PLANET_COLORS = Object.freeze([0x8FA3C8, 0xA9C7B8, 0xB9A7E0, 0xD6E4F0, 0x7F93A8, 0x9BB8D3]);

/** New linear THREE.Color for a palette token. Call at construction time only. */
export function color(name) {
  const hex = PALETTE[name];
  if (hex === undefined) throw new TypeError(`palette: unknown color token "${name}"`);
  return new THREE.Color(hex);
}

// ---------------------------------------------------------------- OKLab ramp

// sRGB-linear <-> OKLab (Björn Ottosson). Operates on linear RGB.
function linearToOklab(r, g, b, out) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return out;
}

function oklabToLinear(L, A, B, out) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  out.r = Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  out.g = Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  out.b = Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  return out;
}

// Context-fill stops (fill position, token), converted once to OKLab.
const FILL_STOPS = [
  [0.0, 'STAR_FILL_0'],
  [0.5, 'STAR_FILL_50'],
  [0.8, 'STAR_FILL_80'],
  [1.0, 'STAR_FILL_100'],
].map(([at, name]) => {
  const c = color(name);
  return { at, lab: linearToOklab(c.r, c.g, c.b, [0, 0, 0]) };
});

/**
 * Star color for a context fill in [0, 1] (values above 1 clamp to crimson).
 * Interpolates in OKLab so the ramp goes white → pale rose → crimson and never
 * passes through the reserved orange band. Writes into `out` (no allocation).
 */
export function starColor(fill, out = new THREE.Color()) {
  const f = Number.isFinite(fill) ? Math.min(1, Math.max(0, fill)) : 0;
  let i = 0;
  while (i < FILL_STOPS.length - 2 && f > FILL_STOPS[i + 1].at) i++;
  const a = FILL_STOPS[i];
  const b = FILL_STOPS[i + 1];
  const t = (f - a.at) / (b.at - a.at);
  return oklabToLinear(
    a.lab[0] + (b.lab[0] - a.lab[0]) * t,
    a.lab[1] + (b.lab[1] - a.lab[1]) * t,
    a.lab[2] + (b.lab[2] - a.lab[2]) * t,
    out,
  );
}

/**
 * Boost a linear color's chroma by `k` in OKLab, keeping its hue and OKLab
 * lightness, and stopping at the sRGB gamut edge. Shaders pre-saturate colors
 * because ACES greys dim ones; doing it in linear RGB (mix(luma, c, k)) clips
 * channels and drags crimson to pure red, which sits at OKLCH 29° next to the
 * reserved NEEDS ME band. Writes into `out` (no allocation besides a scratch).
 */
const _lab = [0, 0, 0];
export function saturateOklab(c, k, out) {
  linearToOklab(Math.max(0, c.r), Math.max(0, c.g), Math.max(0, c.b), _lab);
  const [L, A, B] = _lab;
  const inGamut = (s) => {
    const l = (L + 0.3963377774 * A * s + 0.2158037573 * B * s) ** 3;
    const m = (L - 0.1055613458 * A * s - 0.0638541728 * B * s) ** 3;
    const q = (L - 0.0894841775 * A * s - 1.2914855480 * B * s) ** 3;
    return 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q >= -1e-5
      && -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q >= -1e-5
      && -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * q >= -1e-5;
  };
  let s = Math.max(1, k);
  if (!inGamut(s)) {
    let lo = 1, hi = s;
    for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (inGamut(mid)) lo = mid; else hi = mid; }
    s = lo;
  }
  return oklabToLinear(L, A * s, B * s, out);
}

/** sRGB-encoded channel (0..1) to linear. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * OKLCH of a LINEAR rgb triple: [L, C, hue in degrees 0..360).
 * Exported for QA tools and tests.
 */
export function linearToOklch(r, g, b) {
  const lab = linearToOklab(Math.max(0, r), Math.max(0, g), Math.max(0, b), [0, 0, 0]);
  const C = Math.hypot(lab[1], lab[2]);
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [lab[0], C, h];
}

/** Reserved NEEDS ME band in OKLCH: hue 28°–55° with chroma above 0.09. */
export const RESERVED_HUE = Object.freeze({ min: 28, max: 55, minChroma: 0.09 });

/**
 * QA: true when a color sits in the reserved NEEDS ME orange band.
 * Judged in OKLCH (perceptual), so near-whites such as STAR_FILL_50 have low
 * chroma and pass, while a saturated orange is caught whatever its lightness.
 * Accepts an sRGB hex number, or a linear {r, g, b} (e.g. a THREE.Color).
 */
export function isReservedHue(c) {
  let r, g, b;
  if (typeof c === 'number') {
    r = srgbToLinear(((c >> 16) & 255) / 255);
    g = srgbToLinear(((c >> 8) & 255) / 255);
    b = srgbToLinear((c & 255) / 255);
  } else {
    ({ r, g, b } = c);
  }
  const [, C, h] = linearToOklch(r, g, b);
  return C > RESERVED_HUE.minChroma && h >= RESERVED_HUE.min && h <= RESERVED_HUE.max;
}
