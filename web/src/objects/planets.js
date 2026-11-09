// planets.js: one small world per file the session touched (or per folder when
// the system holds more files than the planet budget).
//
// Meaning carried by each planet:
//   - size   = edit count (log scale, eases 0.8 s with a small overshoot so an
//              edit visibly "lands")
//   - orbit  = hash(file id): radius, phase, inclination never change, so a
//              planet is always where you last saw it
//   - rim flash (SHIP_TOOL) = a tool call just arrived at this file
//
// Rendering: two draws for every planet in the system.
//   1. surface  (InstancedMesh, opaque): procedural banded or rocky world with
//      terminator lighting from the star and a thin Fresnel atmosphere.
//   2. halo     (same geometry, BackSide, additive): atmosphere shell outside the
//      silhouette, forward-scatters when the star is behind the planet, and
//      carries the arrival ping.
// Orbits are evaluated in the vertex shader from the render clock, so nothing is
// uploaded per frame. Instance attributes change only when a file changes or a
// ship arrives. getPosition() evaluates the exact same orbit on the CPU.

import * as THREE from 'three';
import { PLANET_COLORS, color, starColor } from '../lib/palette.js';

// Death cycle (state.deathPhase): the world breaks apart between these phases.
const DOOM_START = 0.55;
const DOOM_END = 0.86;
const PLANET_FILL_CAP = 0.5;   // starColor(0.5) = STAR_FILL_50, same cap as belt.js
import { hash01, damp, clamp } from '../lib/math.js';

const GROW_TIME = 0.8;
const PING_TIME = 0.4;
const ORBIT_MIN = 4.0;
const ORBIT_MAX = 8.5;
const MAX_INCLINATION = (6 * Math.PI) / 180;
const TAU = Math.PI * 2;
const ACTIVE_MODES = new Set(['working', 'thinking', 'needs-me', 'my-move']);
// A my-move system that has idled past 60% is visually settled: 10 fps is enough.
const settledMyMove = (state) => state.mode === 'my-move' && (state.idleFor ?? 0) >= 0.6;

/** Planet radius from edit count (ART_DIRECTION §3.7). */
const radiusForEdits = (edits) => Math.min(0.6, 0.12 + 0.09 * Math.log2(1 + Math.max(0, edits || 0)));

/** Keplerian period: 60 s at r = 4, about 186 s at r = 8.5 (inside the 60–200 s band). */
const omegaForRadius = (r) => TAU / (60 * Math.pow(r / ORBIT_MIN, 1.5));

/** ease-out-back, matching the GLSL copy below. Lets growth overshoot slightly. */
function easeOutBack(x) {
  const c1 = 1.2;
  const c3 = c1 + 1;
  const k = x - 1;
  return 1 + c3 * k * k * k + c1 * k * k;
}

/** Folder id for a file record: explicit `folder`, or "d:" + dirname(path). */
function folderOf(file) {
  if (file.folder) return file.folder;
  const p = file.path || (typeof file.id === 'string' ? file.id.replace(/^f:/, '') : '');
  const i = p.lastIndexOf('/');
  return 'd:' + (i > 0 ? p.slice(0, i) : '.');
}

// ---------------------------------------------------------------------------
// GLSL. Private noise is prefixed `pl_` so it can never collide with shared
// chunks if an integrator concatenates shaders later.
// ---------------------------------------------------------------------------

const ORBIT_GLSL = /* glsl */ `
  attribute vec4 aOrbit;   // radius, phase0, omega, inclination
  attribute vec4 aOrbit2;  // node angle, spin rate, style (0 banded / 1 rocky), seed
  attribute vec3 aGrow;    // size from, size to, start time (render clock)
  attribute vec3 aColor;   // linear base albedo
  attribute float aPing;   // render-clock time of the last arrival ping

  uniform float uTime;

  // Same math as Planets._orbitPoint on the CPU: circle in XZ, tilted by
  // inclination about the node axis (Rodrigues rotation).
  vec3 pl_orbit(vec4 o, float node) {
    float th = o.y + o.z * uTime;
    vec3 v = vec3(o.x * cos(th), 0.0, o.x * sin(th));
    vec3 n = vec3(cos(node), 0.0, sin(node));
    float ci = cos(o.w), si = sin(o.w);
    return v * ci + cross(n, v) * si + n * dot(n, v) * (1.0 - ci);
  }

  float pl_size() {
    float e = clamp((uTime - aGrow.z) / ${GROW_TIME.toFixed(2)}, 0.0, 1.0);
    float k = e - 1.0;
    float eob = 1.0 + 2.2 * k * k * k + 1.2 * k * k;
    return max(0.0, mix(aGrow.x, aGrow.y, eob));
  }
`;

const NOISE_GLSL = /* glsl */ `
  vec3 pl_hash3(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float pl_grad(vec3 i, vec3 f, vec3 o) {
    return dot(pl_hash3(i + o) * 2.0 - 1.0, f - o);
  }
  // Quintic-interpolated gradient noise, roughly [-0.8, 0.8].
  float pl_noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(
      mix(mix(pl_grad(i, f, vec3(0,0,0)), pl_grad(i, f, vec3(1,0,0)), u.x),
          mix(pl_grad(i, f, vec3(0,1,0)), pl_grad(i, f, vec3(1,1,0)), u.x), u.y),
      mix(mix(pl_grad(i, f, vec3(0,0,1)), pl_grad(i, f, vec3(1,0,1)), u.x),
          mix(pl_grad(i, f, vec3(0,1,1)), pl_grad(i, f, vec3(1,1,1)), u.x), u.y),
      u.z);
  }
  float pl_fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < PL_OCTAVES; i++) {
      s += a * pl_noise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return s;
  }
  float pl_lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const AGE_GLSL = /* glsl */ `
  // Idle aging (ART_DIRECTION §3.7, Gate 1 review #2). One uniform, uAge 0..1,
  // walks every world through four stages; each planet runs slightly ahead or
  // behind by its seed but all of them reach the same dead state at uAge = 1.
  //   0.04-0.78  hurricanes: cool white/teal spiral vortices (Coriolis-correct)
  //   0.28-0.94  volcanoes: a few tiny vents with brief ember plumes
  //   0.48-1.00  crust cracks: glowing fissures that spread, then go dark
  //   1.00       cold, dead, cracked: no glow, no motion
  // Colors: storm white/teal and a dull, dark ember. Never orange, never magenta.
  uniform float uAge;
  // Effects clock: wall time, NOT the motion clock. The motion clock slows to
  // ~0 as idle deepens, which froze eruptions and lightning; uAge already
  // stills everything at the dead state, so this one never needs to stop.
  uniform float uFxTime;
  const vec3 PL_STORM = vec3(0.74, 0.88, 0.92);
  // Deep, desaturated maroon at about half the old intensity: after bloom and
  // tone mapping the old red-brown read as rust-orange, too close to needs-me.
  const vec3 PL_EMBER = vec3(0.13, 0.034, 0.042);

  vec3 pl_spherePt(vec3 h, float latMin, float latSpan) {
    float lat = (latMin + latSpan * h.y) * (h.z < 0.5 ? -1.0 : 1.0);
    float lon = h.x * 6.2831853;
    float cl = sqrt(1.0 - lat * lat);
    return vec3(cos(lon) * cl, lat, sin(lon) * cl);
  }

  // Crust plates: F1/F2 of a jittered 3D cell field. Only runs once the crust
  // has started to crack (uniform branch), and idle renders at 10 fps.
  vec2 pl_vor(vec3 p, float seed) {
    vec3 c = floor(p);
    float f1 = 8.0, f2 = 8.0;
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec3 cell = c + vec3(float(x), float(y), float(z));
      float d = length(p - cell - 0.15 - 0.7 * pl_hash3(cell + seed * 1.91));
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
    return vec2(f1, f2);
  }

  // Modifies albedo in place; returns emission (added after lighting, so
  // vents and fissures still read on the night side).
  vec3 pl_age(vec3 p, float seed, inout vec3 alb) {
    vec3 emis = vec3(0.0);
    float a = clamp(uAge * (1.0 + 0.3 * fract(seed * 0.618)), 0.0, 1.0);
    if (a < 0.03) return emis;
    // Size of one pixel on the unit sphere: keeps vents and storm eyes at least
    // a pixel or two wide when the planet is only ~15 px across.
    float px = length(fwidth(p));

    float wHur  = smoothstep(0.04, 0.2, a) * (1.0 - smoothstep(0.55, 0.78, a));
    float wVol  = smoothstep(0.28, 0.4, a) * (1.0 - smoothstep(0.76, 0.94, a));
    float crack = smoothstep(0.48, 0.95, a);
    float glow  = smoothstep(0.5, 0.62, a) * (1.0 - smoothstep(0.8, 0.99, a));
    float dead  = smoothstep(0.7, 1.0, a);

    // --- Hurricanes ------------------------------------------------------
    if (wHur > 0.001) {
      for (int i = 0; i < PL_STORMS; i++) {
        vec3 h = pl_hash3(vec3(seed, float(i) * 7.13 + 1.0, 3.7));
        float w = wHur * smoothstep(0.04 + 0.07 * float(i), 0.16 + 0.07 * float(i), a);
        vec3 c = pl_spherePt(h, 0.22, 0.5);
        if (w < 0.001 || dot(p, c) < 0.5) continue;
        vec3 t1 = normalize(cross(c, vec3(0.0, 1.0, 0.0)));
        vec3 t2 = cross(c, t1);
        float R = max(0.3 + 0.16 * h.x, px * 7.0);
        vec2 q = vec2(dot(p, t1), dot(p, t2)) / R;
        float rr = length(q);
        if (rr > 1.1) continue;
        float dir = c.y > 0.0 ? 1.0 : -1.0;          // spin sense by hemisphere
        float ang = atan(q.y, q.x);
        float arms = sin(2.0 * ang + dir * 5.5 * log(rr + 0.04)
                         - dir * uFxTime * (0.35 + 0.25 * h.y)
                         + 1.6 * pl_noise(p * 11.0 + seed));
        float cloud = smoothstep(-0.1, 0.8, arms)
                    * (1.0 - smoothstep(0.45, 1.0, rr))
                    * smoothstep(0.07, 0.17, rr);       // clear eye
        float wall = exp(-pow((rr - 0.17) / 0.06, 2.0)); // bright eyewall
        float m = clamp(cloud * 0.85 + wall * 0.9, 0.0, 1.0) * w;
        float inside = (1.0 - smoothstep(0.5, 1.0, rr)) * w;
        alb *= 1.0 - 0.3 * inside * (1.0 - m);           // dark lanes between the arms
        alb = mix(alb, PL_STORM * max(0.62, pl_lum(alb) * 1.6), m * 0.9);
        // Sparse lightning in the eyewall: brief cool-white flickers that also
        // show on the night side. A few frames every several seconds per storm.
        float slot = floor(uFxTime * 4.0 + h.z * 97.0);
        float fl = step(0.965, fract(sin(slot * 12.9898 + seed * 78.233) * 43758.5453));
        emis += PL_STORM * fl * w * (wall * 0.35 + cloud * 0.08);
      }
    }

    // --- Volcanoes -------------------------------------------------------
    if (wVol > 0.001) {
      for (int i = 0; i < PL_VENTS; i++) {
        vec3 h = pl_hash3(vec3(seed * 1.3, float(i) * 3.31 + 5.0, 9.1));
        float w = wVol * smoothstep(0.28 + 0.05 * float(i), 0.36 + 0.05 * float(i), a);
        vec3 c = pl_spherePt(h.yzx, 0.0, 0.7);
        float d = length(p - c);
        if (w < 0.001 || d > max(0.32, px * 6.0)) continue;
        float period = 5.0 + 5.0 * h.z;
        float ph = fract(uFxTime / period + h.x);
        float pulse = smoothstep(0.0, 0.025, ph) * (1.0 - smoothstep(0.03, 0.3, ph));
        float rv = max(0.035, px * 1.3);
        float core = 1.0 - smoothstep(0.0, rv, d);
        // lava apron: broken, noise-gated glow around the vent
        float apron = (1.0 - smoothstep(rv, rv * 3.5, d))
                    * smoothstep(-0.1, 0.4, pl_noise(p * 38.0 + seed));
        // ash plume: grey cloud that billows out and settles each eruption
        float rp = 0.05 + 0.22 * ph;
        float ash = (1.0 - smoothstep(rp * 0.4, rp, d)) * (1.0 - smoothstep(0.08, 0.6, ph))
                  * (0.65 + 0.35 * pl_noise(p * 20.0 - uFxTime * 0.2));
        alb = mix(alb, vec3(0.16, 0.16, 0.17), clamp(ash, 0.0, 1.0) * 0.75 * w);
        alb *= 1.0 - 0.5 * apron * w;                   // scorched ground
        emis += PL_EMBER * w * (core * (1.6 + 3.0 * pulse) + apron * (0.25 + 0.6 * pulse)
                                + ash * 0.35 * pulse);
      }
    }

    // --- Crust cracks ----------------------------------------------------
    if (crack > 0.001) {
      // Plates split along cell edges, jagged by a little warp; the network
      // spreads out of seeded weak zones and the fissures widen with age.
      float zone = 0.5 + 0.6 * pl_noise(p * 1.4 + seed * 0.7);
      float reach = smoothstep(1.02 - crack, 1.17 - crack, zone);
      float jag = pl_noise(p * 9.0 + seed * 2.3);
      vec2 v = pl_vor(p * 2.6 + jag * 0.22, seed);
      float e = v.y - v.x;
      float w1 = max(mix(0.02, 0.07, crack), fwidth(e) * 1.1);
      float line = 1.0 - smoothstep(0.0, w1, e);
      float heat = 1.0 - smoothstep(0.0, w1 * 3.0, e);
  #if PL_CRACK2
      // fine branch cracks inside the plates, later and thinner
      float w2 = max(mix(0.004, 0.018, crack), fwidth(jag) * 0.8);
      float br = (1.0 - smoothstep(0.0, w2, abs(jag))) * smoothstep(0.45, 0.95, crack)
               * (1.0 - smoothstep(0.12, 0.4, e));       // spurs off the main faults
      line = max(line, br * 0.55);
  #endif
      line *= reach;
      heat *= reach;
      alb = mix(alb, alb * 0.06, line * (0.55 + 0.45 * dead));     // dark fissure
      emis += PL_EMBER * glow * (line * 1.05 + heat * 0.22);
    }

    // --- The dead world: cold, grey-blue, still --------------------------
    alb = mix(alb, vec3(pl_lum(alb)) * vec3(0.8, 0.88, 1.0) * 0.8, dead * 0.75);
    return emis;
  }
`;

const SURFACE_VERT = /* glsl */ `
  ${ORBIT_GLSL}
  ${NOISE_GLSL}
  // Death cycle (owner, 2026-11-08): uDoom 0..1 breaks the world into crust
  // plates (the same cells the fragment shader cuts along): each plate shrinks
  // toward its own center and drifts outward, so the planet comes apart.
  uniform float uDoom;
  varying vec3 vPlate;   // plate center this vertex belongs to (constant inside a plate)
  varying vec3 vObj;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vColor;
  varying vec2 vStyle;   // style, seed
  varying float vPing;

  void main() {
    float s = pl_size();
    vec3 center = pl_orbit(aOrbit, aOrbit2.x);
    // Spin the pattern (not the mesh) so the terminator stays where the star puts it.
    float a = aOrbit2.y * uTime;
    float ca = cos(a), sa = sin(a);
    vObj = vec3(ca * position.x - sa * position.z, position.y, sa * position.x + ca * position.z);
    vec3 local = position;
    vPlate = vec3(0.0);
    if (uDoom > 0.001) {
      // Nearest plate center in the spun frame (matches pl_vor in the fragment shader).
      float seed = aOrbit2.w * 31.0 + 7.0;
      vec3 q = normalize(vObj) * 2.2;
      vec3 cb = floor(q);
      vec3 best = q;
      float bd = 9.0;
      for (int z = -1; z <= 1; z++)
      for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 cell = cb + vec3(float(x), float(y), float(z));
        vec3 cc = cell + 0.15 + 0.7 * pl_hash3(cell + seed * 1.91);
        float d = length(q - cc);
        if (d < bd) { bd = d; best = cc; }
      }
      vPlate = best;
      vec3 dir = normalize(best);
      float h = fract(dot(best, vec3(0.37, 0.71, 0.13)) * 13.7);
      vec3 spun = normalize(vObj);
      spun = mix(spun, dir, 0.32 * uDoom) + dir * uDoom * (0.5 + 1.1 * h);
      // Back from the spun frame to mesh space.
      local = vec3(ca * spun.x + sa * spun.z, spun.y, -sa * spun.x + ca * spun.z);
    }
    vec4 world = modelMatrix * vec4(center + local * s, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vColor = aColor;
    vStyle = aOrbit2.zw;
    vPing = 1.0 - clamp((uTime - aPing) / ${PING_TIME.toFixed(2)}, 0.0, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SURFACE_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  ${AGE_GLSL}
  uniform vec3 uStarW;
  uniform vec3 uLight;      // star light, luminance-normalized * intensity
  uniform vec3 uPingColor;
  uniform float uDesat;
  uniform float uDoom;       // 0..1 the world breaks into drifting plates
  uniform float uFlourish;   // 0..1 archived / cleanly closed: oceans, land, clouds, aurora
  varying vec3 vPlate;
  varying vec3 vObj;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vColor;
  varying vec2 vStyle;
  varying float vPing;

  vec3 banded(vec3 p, vec3 base, float seed) {
    // Gas-giant bands: latitude bent by low-frequency turbulence, then
    // fine streaks stretched along longitude.
    float warp = pl_fbm(p * vec3(1.6, 3.5, 1.6) + seed);
    float lat = p.y + 0.11 * warp;
    float freq = 7.0 + floor(seed * 0.37) * 1.0 + mod(seed, 5.0);
    float band = 0.5 + 0.5 * sin(lat * freq + seed);
    float streak = pl_fbm(vec3(p.x * 2.0, lat * 22.0, p.z * 2.0) + seed * 1.3);
    vec3 c = base * mix(0.46, 1.1, band) * (0.8 + 0.45 * streak);
    // Alternate belts lean warmer-pale vs cooler-deep, still inside the planet's hue.
    c = mix(c, vec3(pl_lum(c)) * 1.08, 0.25 * smoothstep(0.55, 0.95, band));
    // One long-lived storm oval at a hashed latitude.
    vec3 stormC = normalize(vec3(cos(seed), 0.35 * sin(seed * 2.1), sin(seed)));
    float st = distance(p * vec3(1.0, 2.4, 1.0), stormC * vec3(1.0, 2.4, 1.0));
    c = mix(c, base * 1.15, (1.0 - smoothstep(0.12, 0.28, st)) * 0.6);
    return c;
  }

  // Cheap 3D crater field: nearest hashed point in a 3x3x3 cell neighbourhood.
  // Returns (bowl darkening, rim brightening).
  vec2 craters(vec3 p, float seed) {
    vec3 c = floor(p);
    vec2 acc = vec2(0.0);
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec3 cell = c + vec3(float(x), float(y), float(z));
      vec3 h = pl_hash3(cell + seed);
      if (h.z < 0.45) continue;                    // not every cell has a crater
      float r = 0.18 + 0.3 * h.x * h.x;
      float d = distance(p, cell + 0.2 + 0.6 * h) / r;
      acc.x = max(acc.x, (1.0 - smoothstep(0.55, 1.0, d)) * (0.5 + 0.5 * h.y));
      acc.y = max(acc.y, exp(-((d - 1.0) / 0.13) * ((d - 1.0) / 0.13)) * (0.5 + 0.5 * h.y));
    }
    return acc;
  }

  vec3 rocky(vec3 p, vec3 base, float seed) {
    float h = pl_fbm(p * 2.1 + seed);
    float ridge = 1.0 - abs(pl_noise(p * 5.5 + seed * 2.0));
    ridge = ridge * ridge;
    // Dark smooth lowlands (maria) against bright cratered highlands.
    float high = smoothstep(-0.12, 0.12, h);
    vec3 c = mix(base * 0.36, base * 1.02, high);
    c *= 0.84 + 0.26 * ridge;
    vec2 cr = craters(p * 4.0, seed) * (0.45 + 0.55 * high);
    c *= 1.0 - 0.38 * cr.x;
    c += base * 0.32 * cr.y;
    c *= 0.9 + 0.2 * pl_noise(p * 24.0 + seed);   // regolith grain
    // Pale polar caps on some worlds (seed decides).
    float capLat = 0.78 + 0.1 * pl_noise(p * 3.0 + seed);
    float cap = smoothstep(capLat, capLat + 0.06, abs(p.y)) * step(0.45, fract(seed * 0.173));
    c = mix(c, mix(base, vec3(pl_lum(base) * 1.25), 0.7), cap);
    return c;
  }

  void main() {
    vec3 p = normalize(vObj);
    float seed = vStyle.y * 31.0;
    vec3 base = vStyle.x < 0.5 ? banded(p, vColor, seed) : rocky(p, vColor, seed);
    vec3 emis = pl_age(p, seed, base);

    // Breaking apart: cut along the plate boundaries, widening with uDoom; the
    // broken edges smoulder in the same dull ember as the cracks.
    if (uDoom > 0.001) {
      // Which plate is this fragment on? A triangle that straddles two plates is
      // stretched across the gap by the vertex shader: its interpolated vPlate
      // matches neither plate, so it is cut away (no spikes between plates).
      vec3 q = p * 2.2;
      vec3 cb = floor(q);
      vec3 best = q;
      float f1 = 9.0, f2 = 9.0;
      for (int z = -1; z <= 1; z++)
      for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 cell = cb + vec3(float(x), float(y), float(z));
        vec3 cc = cell + 0.15 + 0.7 * pl_hash3(cell + (seed + 7.0) * 1.91);
        float d = length(q - cc);
        if (d < f1) { f2 = f1; f1 = d; best = cc; } else if (d < f2) { f2 = d; }
      }
      if (distance(best, vPlate) > 0.02) discard;
      float edge = f2 - f1;
      float gap = uDoom * 0.22;
      if (edge < gap) discard;
      float rim = 1.0 - smoothstep(0.0, 0.05, edge - gap);
      emis += PL_EMBER * 3.0 * rim * (1.0 - 0.8 * uDoom);
      emis += base * 0.1 * uDoom;   // plates stay legible after they tumble into shadow
      base *= 1.0 - 0.25 * uDoom;
    }
    // Flourishing: oceans, green land, drifting clouds and a faint polar aurora.
    if (uFlourish > 0.001) {
      float land = smoothstep(-0.04, 0.1, pl_fbm(p * 1.7 + seed * 0.7));
      vec3 ocean = vec3(0.03, 0.11, 0.24);
      vec3 green = vec3(0.09, 0.27, 0.12);
      vec3 lush = mix(ocean, mix(green, base, 0.3), land);
      float cloud = smoothstep(0.08, 0.5, pl_fbm(p * vec3(2.5, 5.0, 2.5) + vec3(uFxTime * 0.01, 0.0, 0.0) + seed));
      lush = mix(lush, vec3(0.82), cloud * 0.55);
      base = mix(base, lush, uFlourish * (vStyle.x < 0.5 ? 0.45 : 1.0));
      float aur = smoothstep(0.8, 0.95, abs(p.y)) * (0.5 + 0.5 * sin(uFxTime * 0.7 + p.x * 8.0 + p.z * 5.0));
      emis += vec3(0.08, 0.4, 0.28) * aur * 0.22 * uFlourish;
    }

    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uStarW - vPosW);
    float ndl = dot(N, L);
    // Soft terminator: a tiny wrap reads as atmosphere scattering at the edge.
    float diff = smoothstep(-0.06, 0.55, ndl) * (0.35 + 0.65 * clamp(ndl, 0.0, 1.0));
    vec3 col = base * uLight * diff;
    col += base * 0.010;                                   // faint night side
    col += emis * (1.0 - 0.45 * clamp(ndl, 0.0, 1.0));   // embers read dimmer in daylight
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
    vec3 atmo = mix(vColor, vec3(pl_lum(vColor) * 1.3), 0.45) * uLight;
    float thin = (1.0 - 0.85 * smoothstep(0.45, 0.95, uAge)) * (1.0 + 0.8 * uFlourish) * (1.0 - uDoom);   // atmosphere boils away; lush worlds keep a thick one
    col += atmo * fres * (0.03 + 0.97 * smoothstep(-0.25, 0.6, ndl)) * 0.55 * thin;
    col += uPingColor * fres * vPing * 1.4;

    // Planets stay crisp: lit peak never exceeds 0.9 (bloom threshold is 1).
    float l = pl_lum(col);
    if (vPing < 0.01 && l > 0.9) col *= 0.9 / l;
    col = mix(col, vec3(pl_lum(col)), uDesat);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const HALO_VERT = /* glsl */ `
  ${ORBIT_GLSL}
  uniform float uShell;
  uniform float uDoom;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vColor;
  varying float vPing;
  void main() {
    // The atmosphere shell is the first thing a breaking world loses.
    float s = pl_size() * uShell * (1.0 - smoothstep(0.0, 0.3, uDoom));
    vec3 center = pl_orbit(aOrbit, aOrbit2.x);
    vec4 world = modelMatrix * vec4(center + position * s, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vColor = aColor;
    vPing = 1.0 - clamp((uTime - aPing) / ${PING_TIME.toFixed(2)}, 0.0, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const HALO_FRAG = /* glsl */ `
  uniform vec3 uStarW;
  uniform vec3 uLight;
  uniform vec3 uPingColor;
  uniform float uDesat;
  uniform float uAge;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vColor;
  varying float vPing;
  void main() {
    vec3 N = normalize(vNormalW);          // outward normal of a back face
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uStarW - vPosW);
    // On the back shell, -dot(N,V) runs 0 at the shell silhouette to ~0.36 at
    // the planet limb (shell 1.07×); inside that the planet itself occludes the shell.
    float d = -dot(N, V);
    float halo = pow(smoothstep(0.0, 0.36, d), 3.0);
    float day = clamp(dot(N, L) * 0.7 + 0.35, 0.0, 1.0);
    float forward = pow(clamp(dot(-V, L), 0.0, 1.0), 6.0);   // backlit crescent
    vec3 atmo = mix(vColor, vec3(dot(vColor, vec3(0.2126, 0.7152, 0.0722)) * 1.3), 0.5);
    vec3 col = atmo * uLight * halo * (day * 0.3 + forward * 0.22)
             * (1.0 - 0.85 * smoothstep(0.45, 0.95, uAge));   // dead worlds lose their air
    col += uPingColor * halo * vPing * 2.2;   // brief arrival flash, allowed to bloom
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(l), uDesat);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Planets {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} ctx  ObjectContext (read-only)
   * @param {{max?: number}} opts
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    this.max = Math.max(1, Math.min(64, opts.max ?? 24));
    this.root = new THREE.Group();
    this.root.name = 'planets';
    parent.add(this.root);
    this._disposed = false;

    const q = ctx?.quality ?? 'high';
    const seg = q === 'low' ? [24, 16] : q === 'medium' ? [36, 24] : [48, 32];
    const geo = new THREE.SphereGeometry(1, seg[0], seg[1]);
    const n = this.max;
    this._aOrbit = new Float32Array(n * 4);
    this._aOrbit2 = new Float32Array(n * 4);
    this._aGrow = new Float32Array(n * 3);
    this._aColor = new Float32Array(n * 3);
    this._aPing = new Float32Array(n).fill(-1e4);
    const mk = (arr, size) => new THREE.InstancedBufferAttribute(arr, size);
    this._attr = {
      orbit: mk(this._aOrbit, 4),
      orbit2: mk(this._aOrbit2, 4),
      grow: mk(this._aGrow, 3),
      color: mk(this._aColor, 3),
      ping: mk(this._aPing, 1),
    };
    geo.setAttribute('aOrbit', this._attr.orbit);
    geo.setAttribute('aOrbit2', this._attr.orbit2);
    geo.setAttribute('aGrow', this._attr.grow);
    geo.setAttribute('aColor', this._attr.color);
    geo.setAttribute('aPing', this._attr.ping);
    this._geo = geo;

    // Uniforms shared by both materials (same objects, so one write updates both).
    const light = new THREE.Color();
    starColor(0, light);
    this._uniforms = {
      uTime: { value: 0 },
      uStarW: { value: new THREE.Vector3() },
      uLight: { value: light },
      uPingColor: { value: color('SHIP_TOOL') },
      uDesat: { value: 0 },
      uAge: { value: 0 },
      uDoom: { value: 0 },
      uFlourish: { value: 0 },
      uFxTime: { value: 0 },
    };
    const octaves = q === 'low' ? 3 : q === 'medium' ? 4 : 5;
    // Aging effect counts per quality tier (vortices, vents, branch cracks).
    const ageDefs = q === 'low'
      ? { PL_STORMS: 1, PL_VENTS: 2, PL_CRACK2: 0 }
      : q === 'medium'
        ? { PL_STORMS: 2, PL_VENTS: 3, PL_CRACK2: 1 }
        : { PL_STORMS: 3, PL_VENTS: 4, PL_CRACK2: 1 };

    this._surfaceMat = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      defines: { PL_OCTAVES: octaves, ...ageDefs },
    });
    this._haloMat = new THREE.ShaderMaterial({
      uniforms: { ...this._uniforms, uShell: { value: 1.07 } },
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this._surface = new THREE.InstancedMesh(geo, this._surfaceMat, n);
    this._halo = new THREE.InstancedMesh(geo, this._haloMat, n);
    for (const m of [this._surface, this._halo]) {
      m.frustumCulled = false;   // positions come from the shader, not instanceMatrix
      m.count = 0;
      m.visible = false;
      this.root.add(m);
    }
    this._halo.renderOrder = 1;

    // Book-keeping (CPU mirror of the shader state).
    this._slots = new Array(n).fill(null);   // slot -> planet record
    this._byId = new Map();                  // planet id -> record
    this._members = new Map();               // file id -> planet id (self or folder)
    this._folderRep = new Map();             // folder id -> a file planet id in it (fallback target)
    this._sigN = -1; this._sigEdits = -1; this._sigLast = -1;
    this._t = 0;
    this._lastNow = -Infinity;
    this._busyUntil = 0;
    this._lightI = 1;
    this._desat = 0;
    this._age = 0;
    this._doom = 0;
    this._flourish = 0;
    this._fxT = 0;
    this._scratchColor = new THREE.Color();
  }

  // -------------------------------------------------------------------------

  update(state, dt, t) {
    if (this._disposed || !state) return 0;
    if (state.now < this._lastNow - 1e-3) this.reset();
    this._lastNow = state.now;
    this._t = t;
    this._uniforms.uTime.value = t;
    // Wrapped hourly to keep float32 precision in the shader over a long day.
    this._fxT = (this._fxT + Math.max(0, dt || 0)) % 3600;
    this._uniforms.uFxTime.value = this._fxT;
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(this._uniforms.uStarW.value);

    // Starlight: context color (never orange), dimmed by idle decay / crash.
    const mode = state.mode;
    // Idle no longer fades the planets out: they age instead (uAge drives the
    // shader). Light dims only a little so the dead, cracked world stays legible.
    let targetI = 1;
    let targetDesat = 0;
    let targetAge = 0;
    if (mode === 'idle' || mode === 'my-move') {
      const s = clamp(state.idleFor ?? 0, 0, 1);
      const sm = s * s * (3 - 2 * s);
      targetI = 1 - 0.45 * sm;
      targetDesat = 0.2 * s;
      targetAge = s;
    } else if (mode === 'crashed') {
      targetI = 0.12;
      targetDesat = 0.6;
    }
    this._lightI = damp(this._lightI, targetI, 1.5, dt);
    this._desat = damp(this._desat, targetDesat, 1.5, dt);
    this._age = damp(this._age, targetAge, 1.5, dt);
    if (Math.abs(this._age - targetAge) < 1e-4) this._age = targetAge;
    this._uniforms.uAge.value = this._age;
    // Fate: dying worlds break apart after their aging stages; flourishing ones turn lush.
    const ph = state.fate === 'dying' ? state.deathPhase || 0 : 0;
    const doomT = state.fate === 'dying' ? clamp((ph - DOOM_START) / (DOOM_END - DOOM_START), 0, 1) : 0;
    const flourT = state.fate === 'flourish' ? 1 : 0;
    this._doom = damp(this._doom, doomT * doomT * (3 - 2 * doomT), 1.2, dt);
    this._flourish = damp(this._flourish, flourT, 1.5, dt);
    this._uniforms.uDoom.value = this._doom < 1e-3 ? 0 : this._doom;
    this._uniforms.uFlourish.value = this._flourish < 1e-3 ? 0 : this._flourish;
    const c = this._scratchColor;
    // Capped like the belt: high fill (compaction) would light every planet red
    // and read as an error. The red belongs to the star alone.
    starColor(Math.min(PLANET_FILL_CAP, Math.max(0, state.contextFill ?? 0)), c);
    const lum = Math.max(1e-3, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    this._uniforms.uLight.value.setRGB(c.r / lum, c.g / lum, c.b / lum).multiplyScalar(this._lightI);
    this._uniforms.uDesat.value = this._desat;

    // Re-layout only when the file list changed (cheap signature, no allocation).
    const files = state.files || [];
    let edits = 0, last = 0;
    for (let i = 0; i < files.length; i++) {
      edits += files[i].edits || 0;
      if ((files[i].lastT || 0) > last) last = files[i].lastT || 0;
    }
    if (files.length !== this._sigN || edits !== this._sigEdits || last !== this._sigLast) {
      this._sigN = files.length; this._sigEdits = edits; this._sigLast = last;
      this._layout(files, t);
    }

    // Free slots whose shrink-out finished.
    for (let i = 0; i < this._slots.length; i++) {
      const p = this._slots[i];
      if (p && p.dying && t >= p.dieAt) this._freeSlot(i);
    }

    const any = this._surface.count > 0;
    this._surface.visible = any;
    this._halo.visible = any;
    if (t < this._busyUntil) return 2;
    return any && ACTIVE_MODES.has(mode) && !settledMyMove(state) ? 1 : 0;
  }

  /** World-space position of a file or folder planet. False if it has none. */
  getPosition(targetId, out) {
    if (this._disposed || targetId == null) return false;
    let p = this._byId.get(targetId);
    if (!p || p.dying) {
      const via = this._members.get(targetId) ?? this._folderRep.get(targetId);
      p = via ? this._byId.get(via) : null;
    }
    if (!p || p.dying) return false;
    this._orbitPoint(p, this._t, out);
    this.root.localToWorld(out);
    return true;
  }

  /** 0.4 s rim flash when a ship arrives. */
  ping(targetId) {
    if (this._disposed || targetId == null) return;
    let p = this._byId.get(targetId);
    if (!p) {
      const via = this._members.get(targetId) ?? this._folderRep.get(targetId);
      p = via ? this._byId.get(via) : null;
    }
    if (!p || p.dying) return;
    this._aPing[p.slot] = this._t;
    this._attr.ping.needsUpdate = true;
    this._busyUntil = Math.max(this._busyUntil, this._t + PING_TIME);
  }

  reset() {
    for (let i = 0; i < this._slots.length; i++) if (this._slots[i]) this._freeSlot(i);
    this._byId.clear();
    this._members.clear();
    this._folderRep.clear();
    this._sigN = -1; this._sigEdits = -1; this._sigLast = -1;
    this._lastNow = -Infinity;
    this._busyUntil = 0;
    this._surface.count = 0;
    this._halo.count = 0;
    this._surface.visible = false;
    this._halo.visible = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.root.parent?.remove(this.root);
    this._geo.dispose();
    this._surfaceMat.dispose();
    this._haloMat.dispose();
    this._surface.dispose?.();
    this._halo.dispose?.();
  }

  // -------------------------------------------------------------------------
  // Internals

  /** CPU twin of pl_orbit() + the inclination rotation. Local space. */
  _orbitPoint(p, t, out) {
    const th = p.phase + p.omega * t;
    const vx = p.radius * Math.cos(th);
    const vz = p.radius * Math.sin(th);
    const nx = Math.cos(p.node), nz = Math.sin(p.node);
    const ci = Math.cos(p.incl), si = Math.sin(p.incl);
    // cross(n, v) with n=(nx,0,nz), v=(vx,0,vz) = (0, nz*vx - nx*vz, 0)
    const cy = nz * vx - nx * vz;
    const nd = nx * vx + nz * vz;
    out.set(vx * ci + nx * nd * (1 - ci), cy * si, vz * ci + nz * nd * (1 - ci));
    return out;
  }

  _currentSize(slot, t) {
    const g = this._aGrow;
    const e = clamp((t - g[slot * 3 + 2]) / GROW_TIME, 0, 1);
    return Math.max(0, g[slot * 3] + (g[slot * 3 + 1] - g[slot * 3]) * easeOutBack(e));
  }

  _setGrow(slot, to, t) {
    const from = this._currentSize(slot, t);
    this._aGrow[slot * 3] = from;
    this._aGrow[slot * 3 + 1] = to;
    this._aGrow[slot * 3 + 2] = t;
    this._attr.grow.needsUpdate = true;
    this._busyUntil = Math.max(this._busyUntil, t + GROW_TIME);
  }

  /**
   * Decide which planets should exist. Up to `max` individual files, most
   * recently touched first; the rest fold into their folder planet. Runs only
   * when the file list changes, so the allocations here are not per-frame.
   */
  _layout(files, t) {
    const max = this.max;
    const sorted = files.slice().sort((a, b) => (b.lastT || 0) - (a.lastT || 0));
    let K = sorted.length;
    if (sorted.length > max) {
      const folders = new Set();
      for (K = max - 1; K > 0; K--) {
        folders.clear();
        for (let i = K; i < sorted.length; i++) folders.add(folderOf(sorted[i]));
        if (K + folders.size <= max) break;
      }
    }
    const desired = new Map();   // planet id -> edits
    this._members.clear();
    this._folderRep.clear();
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i];
      if (!f || f.id == null) continue;
      const folder = folderOf(f);
      if (i < K) {
        desired.set(f.id, f.edits || 0);
        this._members.set(f.id, f.id);
        if (!this._folderRep.has(folder)) this._folderRep.set(folder, f.id);
      } else if (desired.has(folder) || desired.size < max) {
        desired.set(folder, (desired.get(folder) || 0) + (f.edits || 0));
        this._members.set(f.id, folder);
      }
      // else: beyond budget even as folders. Ships to it fly a short loop.
    }

    // Planets that should no longer exist shrink out over GROW_TIME.
    for (const [id, p] of this._byId) {
      if (!desired.has(id) && !p.dying) {
        p.dying = true;
        p.dieAt = t + GROW_TIME;
        this._setGrow(p.slot, 0, t);
        this._byId.delete(id);
      }
    }
    // Create or resize.
    for (const [id, edits] of desired) {
      const target = radiusForEdits(edits);
      let p = this._byId.get(id);
      if (p) {
        if (Math.abs(p.target - target) > 1e-4) { p.target = target; this._setGrow(p.slot, target, t); }
        continue;
      }
      const slot = this._allocSlot();
      if (slot < 0) continue;
      p = this._makePlanet(id, slot, target, t);
      this._byId.set(id, p);
    }
    this._syncCount();
  }

  _makePlanet(id, slot, target, t) {
    const sid = String(id);
    const radius = ORBIT_MIN + (ORBIT_MAX - ORBIT_MIN) * hash01(sid + '#r');
    const omega = omegaForRadius(radius);
    // Phase anchored to the data clock so a reload at the same moment shows
    // the same sky; motion afterwards runs on the smooth render clock.
    const phase0 = TAU * hash01(sid + '#p');
    const anchor = Number.isFinite(this._lastNow) ? this._lastNow : 0;
    const phase = (phase0 + omega * (anchor % 1e6) - omega * t) % TAU;
    const p = {
      id, slot, target, dying: false, dieAt: 0,
      radius, omega, phase,
      incl: MAX_INCLINATION * (hash01(sid + '#i') * 2 - 1),
      node: TAU * hash01(sid + '#n'),
    };
    const o = slot * 4;
    this._aOrbit[o] = p.radius;
    this._aOrbit[o + 1] = p.phase;
    this._aOrbit[o + 2] = p.omega;
    this._aOrbit[o + 3] = p.incl;
    this._aOrbit2[o] = p.node;
    this._aOrbit2[o + 1] = (0.05 + 0.12 * hash01(sid + '#s')) * (hash01(sid + '#d') < 0.85 ? 1 : -1);
    const isFolder = typeof id === 'string' && id.startsWith('d:');
    // Folder planets are always banded giants: an aggregate reads as a gas giant.
    this._aOrbit2[o + 2] = isFolder ? 0 : (hash01(sid + '#st') < 0.45 ? 0 : 1);
    this._aOrbit2[o + 3] = hash01(sid + '#seed');
    const ci = Math.floor(hash01(sid + '#c') * PLANET_COLORS.length) % PLANET_COLORS.length;
    this._scratchColor.set(PLANET_COLORS[ci]);   // sRGB hex -> linear working color
    this._aColor[slot * 3] = this._scratchColor.r;
    this._aColor[slot * 3 + 1] = this._scratchColor.g;
    this._aColor[slot * 3 + 2] = this._scratchColor.b;
    this._aPing[slot] = -1e4;
    this._aGrow[slot * 3] = 0;
    this._aGrow[slot * 3 + 1] = 0;
    this._aGrow[slot * 3 + 2] = t;
    this._setGrow(slot, target, t);   // forms from nothing
    this._slots[slot] = p;
    this._attr.orbit.needsUpdate = true;
    this._attr.orbit2.needsUpdate = true;
    this._attr.color.needsUpdate = true;
    this._attr.ping.needsUpdate = true;
    return p;
  }

  _allocSlot() {
    for (let i = 0; i < this._slots.length; i++) if (!this._slots[i]) return i;
    // Budget full: reclaim the dying planet that is closest to gone.
    let best = -1, bestT = Infinity;
    for (let i = 0; i < this._slots.length; i++) {
      const p = this._slots[i];
      if (p.dying && p.dieAt < bestT) { bestT = p.dieAt; best = i; }
    }
    if (best >= 0) this._freeSlot(best);
    return best;
  }

  _freeSlot(i) {
    const p = this._slots[i];
    if (!p) return;
    if (this._byId.get(p.id) === p) this._byId.delete(p.id);
    this._slots[i] = null;
    this._aGrow[i * 3] = 0;
    this._aGrow[i * 3 + 1] = 0;
    this._attr.grow.needsUpdate = true;
    this._syncCount();
  }

  _syncCount() {
    let hi = 0;
    for (let i = 0; i < this._slots.length; i++) if (this._slots[i]) hi = i + 1;
    this._surface.count = hi;
    this._halo.count = hi;
  }
}
