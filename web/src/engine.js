// Cosmos engine: renderer, HDR post chain, backdrop, camera and the frame loop.
//
// Responsibilities
//  - One WebGLRenderer + EffectComposer rendering in linear HDR (HalfFloat),
//    bloom on genuinely bright pixels only (threshold 1.0 linear), then ACES +
//    sRGB in OutputPass (ART_DIRECTION §5).
//  - The backdrop (ART_DIRECTION §6): a faint galactic dust band baked ONCE
//    into a cubemap (scene.background), the same dust plus every star baked
//    into a second cubemap (ctx.starfieldCube, the lensing source), and a crisp
//    live starfield of 12k stars on three parallax shells in one Points draw.
//  - An adaptive frame loop: 60 / 30 / 10 fps from the max rate hint returned
//    by frame callbacks, 60 fps on input, paused while the tab is hidden.
//
// No module-level mutable state: everything lives inside createEngine().

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CameraController } from './camera.js';
import { color, linearToOklch } from './lib/palette.js';
import { mulberry32 } from './lib/math.js';

// ------------------------------------------------------------------ constants

const QUALITY = {
  //            bloom res scale, cubemap face, MSAA samples, pixel-ratio cap
  high:   { bloom: 1.0,  cube: 1024, msaa: 4, prCap: Infinity },
  medium: { bloom: 0.75, cube: 1024, msaa: 2, prCap: 1.5 },
  low:    { bloom: 0.5,  cube: 512,  msaa: 0, prCap: 1.25 },
};

const BLOOM = { strength: 0.9, radius: 0.55, threshold: 1.0 };
const EXPOSURE = 0.95;

const RATE_INTERVAL_MS = [1000 / 10, 1000 / 30, 1000 / 60]; // index = rate hint (defaults)
const DEFAULT_CAMERA = { position: [0, 7.5, 26], target: [0, 0.4, 0] };

const STAR_SEED = 0xC05305;          // fixed: the sky is identical on every load
const LIVE_STARS = 12000;            // every visible star: crisp, parallax, one draw
const LIVE_BRIGHT = 40;              // the handful of standout stars
const DUST_CUBE = 512;               // dust is smooth; 512² faces magnify cleanly
const SHELLS = [                     // radius, share of live stars, camera-follow
  { r: 900,  share: 0.25, follow: 0.92 },
  { r: 1400, share: 0.35, follow: 0.95 },
  { r: 2000, share: 0.40, follow: 0.975 },
];
const DUST_RADIUS = 2500;
const DUST_PEAK_LUMA = 0.05;         // ART_DIRECTION §6: dust stays ~0.05
// No twinkle: ART_DIRECTION §6, a static sky keeps the GPU quiet and means nothing.

// ------------------------------------------------------------ NEEDS ME tone map
//
// Per-channel ACES pushes a bright saturated orange toward amber and then
// cream (#FF5F1F at luminance 1 comes out #FFC975), so the quasar would lose
// its reserved color exactly where it is brightest. For pixels whose OKLab hue
// sits in the NEEDS ME band, the output pass instead tone-maps the max channel
// with the same ACES curve and scales rgb by it: hue and saturation survive,
// brightness still rolls off. Everything else keeps plain ACES. The blend is
// smooth in hue (full within ±15°, none beyond ±22°) and in relative chroma,
// so near-white pixels (the quasar's white-hot core) still roll to white.
const HUE_FULL_DEG = 15;
const HUE_NONE_DEG = 22;

/** Patch OutputPass's ACES call with the hue-preserving blend above. */
function installHuePreservingToneMap(outputPass) {
  const c = color('NEEDS_ME');
  const [, , hDeg] = linearToOklch(c.r, c.g, c.b);
  const h = (hDeg * Math.PI) / 180;
  const f = (x) => x.toFixed(6);
  const glsl = /* glsl */ `
    // OKLab of a linear sRGB color (Ottosson); only a and b are needed.
    vec3 czOklab(vec3 c) {
      c = max(c, 0.0);
      vec3 lms = vec3(
        dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
        dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
        dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
      lms = pow(lms, vec3(1.0 / 3.0));
      return vec3(
        dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
        dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
        dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
    }
    vec3 cosmosToneMap(vec3 c) {
      vec3 aces = ACESFilmicToneMapping(c);
      vec3 lab = czOklab(c);
      float C = length(lab.yz);
      if (lab.x <= 1e-5 || C <= 1e-6) return aces;
      float cosd = dot(lab.yz / C, vec2(${f(Math.cos(h))}, ${f(Math.sin(h))}));
      float w = smoothstep(${f(Math.cos((HUE_NONE_DEG * Math.PI) / 180))}, ${f(Math.cos((HUE_FULL_DEG * Math.PI) / 180))}, cosd)
              * smoothstep(0.08, 0.16, C / lab.x);   // C/L is exposure-invariant in OKLab
      if (w <= 0.0) return aces;
      float m = max(c.r, max(c.g, c.b));
      float tm = ACESFilmicToneMapping(vec3(m)).g;    // ACES curve on a neutral of the same peak
      vec3 hp = c * (tm / max(m, 1e-6));
      return mix(aces, hp, w);
    }
  `;
  const mat = outputPass.material;
  const call = 'gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );';
  if (!mat.fragmentShader.includes(call)) {
    console.warn('cosmos: OutputPass shader changed; NEEDS ME hue-preserving tone map not installed');
    return;
  }
  mat.fragmentShader = mat.fragmentShader
    .replace('varying vec2 vUv;', `varying vec2 vUv;\n${glsl}`)
    .replace(call, 'gl_FragColor.rgb = cosmosToneMap( gl_FragColor.rgb );');
  mat.needsUpdate = true;
}

const MONO_SHADER = {
  name: 'CosmosMonoShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Rec.709 luminance of the linear HDR buffer: proves states read without hue.
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor = vec4(vec3(l), c.a);
    }`,
};

// ------------------------------------------------------------------ engine

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ quality?: 'high'|'medium'|'low', pixelRatioCap?: number }} [opts]
 */
export function createEngine(canvas, opts = {}) {
  let quality = QUALITY[opts.quality] ? opts.quality : 'high';
  const pixelRatioCap = opts.pixelRatioCap ?? 2;

  // --- renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,   // the canvas only gets OutputPass's triangle; MSAA lives on the composer targets
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.setClearColor(color('VOID'), 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 6000);
  camera.position.fromArray(DEFAULT_CAMERA.position);
  camera.lookAt(...DEFAULT_CAMERA.target);

  const noiseTex = createNoiseTexture();

  /** @type {{renderer, camera, quality, starfieldCube, resolution, noiseTex}} */
  const ctx = {
    renderer,
    camera,
    quality,
    starfieldCube: null,
    resolution: new THREE.Vector2(1, 1),
    noiseTex,
  };

  // --- backdrop
  let backdrop = createBackdrop(renderer, scene, QUALITY[quality].cube);
  scene.background = backdrop.backgroundCube;
  ctx.starfieldCube = backdrop.starfieldCube;

  // --- post chain: RenderPass → Bloom → [mono] → Output (tone map + sRGB)
  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples: 0,
  });
  const composer = new EffectComposer(renderer, sceneTarget);
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256),
    BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  softenBloomKernels(bloomPass);
  const monoPass = new ShaderPass(MONO_SHADER);
  monoPass.enabled = false;
  const outputPass = new OutputPass();
  installHuePreservingToneMap(outputPass);
  // Depth of field: off unless setDepthOfField turns it on (only when focused on one system).
  const dofPass = new BokehPass(scene, camera, { focus: 100, aperture: 0.00012, maxblur: 0.006 });
  dofPass.enabled = false;
  composer.addPass(renderPass);
  composer.addPass(dofPass);
  composer.addPass(bloomPass);
  composer.addPass(monoPass);
  composer.addPass(outputPass);

  // --- camera controls
  const controls = new CameraController(camera, canvas, {
    target: new THREE.Vector3(...DEFAULT_CAMERA.target),
    minDist: 3,
    maxDist: 4000,
  });

  const clock = new THREE.Clock(false);

  // --- loop state (all per-engine, nothing global)
  const frameFns = new Set();
  const qualityFns = new Set();
  const failedFns = new WeakSet();
  let rafId = 0;
  let running = false;
  let disposed = false;
  let contextLost = false;
  let t = 0;
  let lastFrameMs = -1;      // timestamp of the last rendered frame
  let nextDueMs = 0;         // when the next frame is due (accumulating schedule)
  let wakeUntilMs = 0;
  let lastHint = 2;          // start at full rate until callbacks say otherwise
  let currentRate = 2;
  let needsResize = true;
  let fpsFrames = 0;
  let fpsStartMs = 0;
  const stats = { fps: 0, rate: 2, frames: 0 };

  // ------------------------------------------------------------ sizing

  function effectivePixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(0.5, Math.min(dpr, pixelRatioCap, QUALITY[quality].prCap));
  }

  // MSAA on the HDR scene target. Thin rings and ship trails alias badly
  // without it; at dpr ≥ 1.75 half the samples is enough and saves bandwidth.
  function applySamples(pr) {
    const want = pr >= 1.75 ? Math.min(QUALITY[quality].msaa, 2) : QUALITY[quality].msaa;
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      if (rt.samples !== want) {
        rt.dispose();          // re-allocated lazily with the new sample count
        rt.samples = want;
      }
    }
  }

  function resize() {
    needsResize = false;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const pr = effectivePixelRatio();
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    // Size every composer target from the integer drawing-buffer size; with a
    // fractional pixel ratio composer.setPixelRatio(pr) would hand three
    // unrounded sizes (e.g. 347.5 x 396.25) that drift from ctx.resolution.
    renderer.getDrawingBufferSize(ctx.resolution);
    applySamples(pr);
    composer.setPixelRatio(1);
    composer.setSize(ctx.resolution.x, ctx.resolution.y);
    // composer.setSize sized bloom at full res; scale it down per quality.
    const bs = QUALITY[quality].bloom;
    if (bs !== 1) bloomPass.setSize(Math.round(ctx.resolution.x * bs), Math.round(ctx.resolution.y * bs));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    backdrop.setPixelRatio(pr);
  }

  const resizeObserver = new ResizeObserver(() => {
    needsResize = true;
    wake(0.3);
  });
  resizeObserver.observe(canvas);
  const onWindowResize = () => { needsResize = true; wake(0.3); }; // dpr changes
  window.addEventListener('resize', onWindowResize);

  // ------------------------------------------------------------ loop

  // Owner frame-rate settings (render.fpsCap / render.idleFps): the busy tier
  // is the cap, the calm tier the idle rate, the middle tier between them.
  const rateMs = RATE_INTERVAL_MS.slice();
  function setFrameRates({ cap, idle } = {}) {
    const c = Number.isFinite(cap) ? Math.max(15, Math.min(240, cap)) : 60;
    const i = Number.isFinite(idle) ? Math.max(1, Math.min(c, idle)) : 10;
    rateMs[2] = 1000 / c;
    rateMs[1] = 1000 / Math.max(i, Math.min(30, c));
    rateMs[0] = 1000 / i;
  }

  function computeRate(nowMs) {
    if (nowMs < wakeUntilMs) return 2;
    return Math.max(0, Math.min(2, lastHint | 0));
  }

  function tick(nowMs) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    const rate = computeRate(nowMs);
    const interval = rateMs[rate];
    // If the rate just went up, don't wait out the old, longer interval.
    if (nextDueMs - nowMs > interval) nextDueMs = lastFrameMs + interval;
    // Skip rAF ticks until due. The 4 ms slack absorbs rAF jitter so a 60 fps
    // target on a 60 Hz display renders every tick, and 120 Hz renders every other.
    if (lastFrameMs >= 0 && nowMs < nextDueMs - 4) return;

    const dt = lastFrameMs < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000));
    lastFrameMs = nowMs;
    // Accumulating schedule keeps the average rate right on 90/144 Hz displays;
    // reset when we fall more than a frame behind.
    nextDueMs += interval;
    if (nowMs - nextDueMs > interval) nextDueMs = nowMs + interval;
    currentRate = rate;

    renderFrame(dt, nowMs);
  }

  function renderFrame(dt, nowMs) {
    if (needsResize) resize();

    t += dt;
    clock.getDelta();          // keep THREE.Clock in step for anyone reading it
    clock.elapsedTime = t;     // t is the render clock: monotonic, no hidden-time jumps

    controls.update(dt);
    let hint = controls.motionHint;

    for (const fn of frameFns) {
      let h;
      try {
        h = fn(dt, t);
      } catch (err) {
        if (!failedFns.has(fn)) {
          failedFns.add(fn);
          console.error('[cosmos] frame callback threw:', err);
        }
        continue;
      }
      if (typeof h === 'number' && h > hint) hint = h;
    }

    backdrop.update(t);
    composer.render(dt);
    lastHint = hint;

    // Lightweight FPS meter for QA (no allocation).
    stats.frames++;
    fpsFrames++;
    if (nowMs - fpsStartMs >= 1000) {
      stats.fps = Math.round((fpsFrames * 1000) / Math.max(1, nowMs - fpsStartMs));
      fpsFrames = 0;
      fpsStartMs = nowMs;
    }
    stats.rate = currentRate;
  }

  function start() {
    if (running || disposed || contextLost || document.hidden) return;
    running = true;
    clock.start();
    clock.getDelta();
    lastFrameMs = -1;          // first frame after (re)start gets a 1/60 dt, never a spike
    nextDueMs = 0;
    fpsStartMs = performance.now();
    fpsFrames = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  const onVisibility = () => {
    if (document.hidden) stop();
    else { wake(1.5); start(); }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onContextLost = (e) => {
    e.preventDefault();        // lets the browser restore the context later
    contextLost = true;
    stop();
  };
  const onContextRestored = () => {
    contextLost = false;
    backdrop.rebake();         // the baked cubemap lived in GPU memory only
    needsResize = true;
    wake(1.5);
    start();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  function wake(seconds = 1.5) {
    const until = performance.now() + seconds * 1000;
    if (until > wakeUntilMs) wakeUntilMs = until;
    nextDueMs = Math.min(nextDueMs, performance.now()); // render on the very next tick
  }

  const offInput = controls.onInput(() => wake(1.5));

  // ------------------------------------------------------------ public API

  function onFrame(fn) {
    frameFns.add(fn);
    wake(0.5);
    return () => frameFns.delete(fn);
  }

  function onQuality(fn) {
    qualityFns.add(fn);
    return () => qualityFns.delete(fn);
  }

  function setQuality(level) {
    if (!QUALITY[level] || level === quality || disposed) return;
    const oldCubeSize = QUALITY[quality].cube;
    quality = level;
    ctx.quality = level;
    resize();

    // Rebake only if the cube resolution changes. Swap first, let listeners
    // rebuild their objects against the new cube, then free the old one.
    let oldBackdrop = null;
    if (QUALITY[level].cube !== oldCubeSize) {
      oldBackdrop = backdrop;
      backdrop = createBackdrop(renderer, scene, QUALITY[level].cube);
      backdrop.setPixelRatio(effectivePixelRatio());
      scene.background = backdrop.backgroundCube;
      ctx.starfieldCube = backdrop.starfieldCube;
    }
    for (const fn of qualityFns) {
      try { fn(level); } catch (err) { console.error('[cosmos] quality listener threw:', err); }
    }
    if (oldBackdrop) oldBackdrop.dispose();
    wake(1.5);
  }

  function setDebugView(name) {
    monoPass.enabled = name === 'mono';
    wake(0.5);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onWindowResize);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    resizeObserver.disconnect();
    offInput();
    controls.dispose();
    frameFns.clear();
    qualityFns.clear();
    bloomPass.dispose();
    dofPass.dispose?.();
    monoPass.dispose?.();
    outputPass.dispose?.();
    renderPass.dispose?.();
    composer.dispose();
    scene.background = null;
    backdrop.dispose();
    noiseTex.dispose();
    renderer.dispose();
  }

  const engine = {
    renderer,
    scene,
    camera,
    composer,
    controls,
    clock,
    ctx,
    onFrame,
    wake,
    setQuality,
    onQuality,
    setFrameRates,
    setDebugView,
    /**
     * Depth of field. `focusDist` is the distance (world units) that stays sharp;
     * `strength` 0..1 eases the blur in and out. Off when strength is 0.
     */
    setDepthOfField({ enabled = false, focusDist = 100, strength = 1 } = {}) {
      const on = enabled && strength > 0.01;
      dofPass.enabled = on;
      if (!on) return;
      const u = dofPass.uniforms;
      u.focus.value = focusDist;
      u.aperture.value = 0.00012 * strength * (120 / Math.max(30, focusDist));
      u.maxblur.value = 0.006 * strength;
    },
    dispose,
    /** Current render-clock time t (seconds). */
    get time() { return t; },
    /** Current quality level. */
    get quality() { return quality; },
    /** QA readout: { fps, rate (0/1/2), frames }. Read-only by convention. */
    stats,
    /** The live starfield Points (for QA / galaxy-phase tweaks). */
    get backgroundPoints() { return backdrop.points; },
  };

  resize();
  start();
  return engine;
}

// ------------------------------------------------------------------ bloom kernels

/**
 * UnrealBloomPass (r170) truncates each mip's Gaussian at 1σ, so its weights are
 * nearly flat: a box filter. On a large, bright, saturated area (a context-full
 * crimson star) the coarsest mips then print hard-edged squares. Re-weight every
 * kernel as a Gaussian (σ = 0.6·K) times a Hann taper that reaches zero at the
 * kernel edge: same footprint, no step. The shader normalizes by the weight sum.
 */
function softenBloomKernels(bloomPass) {
  for (const mat of bloomPass.separableBlurMaterials || []) {
    const k = mat.defines?.KERNEL_RADIUS;
    const coeff = mat.uniforms?.gaussianCoefficients?.value;
    if (!k || !Array.isArray(coeff)) continue;
    const sigma = 0.6 * k;
    for (let i = 0; i < k; i++) {
      const g = Math.exp(-0.5 * (i * i) / (sigma * sigma));
      const hann = 0.5 * (1 + Math.cos(Math.PI * i / k));
      coeff[i] = g * hann;
    }
  }
}

// ------------------------------------------------------------------ noise texture

/**
 * 256² RGBA tileable value noise, deterministic.
 * Layout follows the classic "two lookups make 3D noise" trick:
 *   G(x, y) = R(x + 37, y + 17) and A(x, y) = B(x + 37, y + 17)   (mod 256)
 * so `mix(tex(uv).r, tex(uv).g, fract(z))` with uv = p.xy + vec2(37, 17)·floor(z)
 * is smooth 3D value noise from one fetch. Sample with RepeatWrapping + Linear.
 */
function createNoiseTexture() {
  const N = 256;
  const rand = mulberry32(0x5EED1E55);
  const r = new Uint8Array(N * N);
  const b = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    r[i] = (rand() * 256) | 0;
    b[i] = (rand() * 256) | 0;
  }
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const j = ((y + 17) & 255) * N + ((x + 37) & 255);
      data[i * 4 + 0] = r[i];
      data[i * 4 + 1] = r[j];
      data[i * 4 + 2] = b[i];
      data[i * 4 + 3] = b[j];
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ backdrop

/**
 * Galactic frame shared by the dust shader and star placement.
 * The band plane is tilted so that, from the Gate 1 camera, the Milky-Way-like
 * band crosses the frame on a diagonal behind the system; the bulge (where the
 * galactic core will sit in the galaxy phase) is just off the lower-left.
 */
function galacticFrame() {
  const A = new THREE.Vector3(0.35, -0.25, -0.9).normalize();   // a direction in the band
  const B0 = new THREE.Vector3(1, 0.55, 0.1);                    // band runs this way
  const Bp = B0.sub(A.clone().multiplyScalar(B0.dot(A))).normalize();
  const N = new THREE.Vector3().crossVectors(A, Bp).normalize();  // band normal
  const ang = -0.5;                                               // bulge offset along the band
  const C = A.clone().multiplyScalar(Math.cos(ang)).addScaledVector(Bp, Math.sin(ang)).normalize();
  return { A, Bp, N, C };
}

/** Linear star tint: blue-white → white → pale cream (saturation < 0.2, never orange). */
function makeStarTint(blueWhite, cream, white) {
  return (temp, out) => {
    if (temp < 0.5) out.copy(blueWhite).lerp(white, temp * 2);
    else out.copy(white).lerp(cream, (temp - 0.5) * 2);
    return out;
  };
}

/** Sample a sky direction: band-biased, bulge-biased or uniform. */
function sampleDirection(rand, frame, pBand, pBulge, out) {
  const u = rand();
  if (u < pBulge) {
    // Gaussian cap around the bulge.
    const s = 0.3;
    out.copy(frame.C)
      .addScaledVector(frame.Bp, gauss(rand) * s)
      .addScaledVector(frame.N, gauss(rand) * s * 0.6);
  } else if (u < pBulge + pBand) {
    const lon = rand() * Math.PI * 2;
    const lat = gauss(rand) * 0.16;
    out.copy(frame.A).multiplyScalar(Math.cos(lon) * Math.cos(lat))
      .addScaledVector(frame.Bp, Math.sin(lon) * Math.cos(lat))
      .addScaledVector(frame.N, Math.sin(lat));
  } else {
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const rr = Math.sqrt(1 - z * z);
    out.set(rr * Math.cos(phi), z, rr * Math.sin(phi));
  }
  return out.normalize();
}

function gauss(rand) {
  // Box–Muller; one value is enough here.
  const u = Math.max(1e-7, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const LIVE_STAR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;     // FWHM in CSS px at nominal distance
  attribute float aFollow;   // fraction of camera motion the shell follows (parallax depth)
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vFwhm;       // device px
  varying float vSprite;     // device px

  void main() {
    // Shells ride along with most of the camera's motion, so they never get
    // reached while flying; the remainder is the parallax that sells depth.
    vec3 p = position + cameraPosition * aFollow;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float nominal = length(position);
    float atten = clamp(nominal / max(1.0, -mv.z), 0.7, 1.35);
    float fwhm = aSize * uPixelRatio * atten;
    float floorPx = 1.5 * uPixelRatio;
    // Below the 1.5 px floor, keep the star's energy constant instead of its size.
    float energy = fwhm < floorPx ? (fwhm * fwhm) / (floorPx * floorPx) : 1.0;
    fwhm = max(fwhm, floorPx);

    vColor = aColor * energy;   // static: no twinkle (ART_DIRECTION §6)
    vFwhm = fwhm;
    vSprite = fwhm * 3.0;
    gl_PointSize = vSprite;
  }
`;

const LIVE_STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vFwhm;
  varying float vSprite;
  void main() {
    float rpx = length(gl_PointCoord - 0.5) * vSprite;           // distance in device px
    float x = rpx / vFwhm;
    // Gaussian PSF with the requested FWHM (4 ln2 = 2.7726) + a whisper of halo.
    float core = exp(-2.7726 * x * x);
    float halo = 0.035 * exp(-2.2 * x);
    float a = core + halo;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

const BAKE_STAR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;     // FWHM in cube-face px (bake only)
  varying vec3 vColor;
  varying float vFwhm;
  varying float vSprite;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    vFwhm = aSize;
    vSprite = aSize * 3.0;
    gl_PointSize = vSprite;
  }
`;

const DUST_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Baked once, so the shader can afford 5-octave fbm, domain warp and ridges.
const DUST_FRAG = /* glsl */ `
  uniform vec3 uN;          // band normal
  uniform vec3 uC;          // bulge direction
  uniform vec3 uViolet;
  uniform vec3 uTeal;
  uniform vec3 uHaze;       // unresolved starlight tint (blue-white)
  uniform vec3 uVoid;
  uniform float uPeak;      // target peak luminance
  varying vec3 vDir;

  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic: no grid creases
    float n000 = hash33(i).x,               n100 = hash33(i + vec3(1,0,0)).x;
    float n010 = hash33(i + vec3(0,1,0)).x, n110 = hash33(i + vec3(1,1,0)).x;
    float n001 = hash33(i + vec3(0,0,1)).x, n101 = hash33(i + vec3(1,0,1)).x;
    float n011 = hash33(i + vec3(0,1,1)).x, n111 = hash33(i + vec3(1,1,1)).x;
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s / 0.96875;
  }
  float ridged(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) {
      float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
      s += a * n * n; p = p * 2.11 + 9.7; a *= 0.5;
    }
    return s / 0.9375;
  }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  void main() {
    vec3 d = normalize(vDir);
    float lat = dot(d, uN);                         // sin(galactic latitude)

    // Domain warp gives the band its torn, billowing edge.
    vec3 w = vec3(fbm(d * 2.1), fbm(d * 2.1 + 5.2), fbm(d * 2.1 + 9.4)) - 0.5;
    float clouds = fbm(d * 3.6 + w * 1.8);
    float thick = 0.07 + 0.07 * fbm(d * 1.6 + 3.1);
    float latW = lat + 0.08 * (w.x + w.y);
    float z = latW / thick;
    float band = exp(-z * z);

    // Bulge: a soft swelling of the band toward the galactic core.
    float ang = acos(clamp(dot(d, uC), -1.0, 1.0));
    float bulge = exp(-ang * ang / (2.0 * 0.24 * 0.24)) * (0.55 + 0.45 * clouds);

    // Dark lanes: ridged noise carved through the band's spine only.
    float lanes = ridged(d * 5.2 + w * 2.4);
    float zs = latW / (thick * 0.6);
    float spine = exp(-zs * zs);
    float carve = 1.0 - 0.9 * smoothstep(0.4, 0.75, lanes) * spine;

    // Cloud contrast: squaring + a threshold keeps most of the band dark and
    // lets only the densest billows reach the peak, so space stays black.
    float billow = smoothstep(0.32, 0.85, clouds);
    float density = (band * (0.08 + 1.1 * billow * billow) + bulge) * carve;

    // Hue: violet ↔ teal by a slow field; the bulge leans toward unresolved starlight.
    float m = smoothstep(0.35, 0.68, fbm(d * 1.25 + 7.0));
    vec3 hue = mix(uViolet, uTeal, m);
    hue = mix(hue, uHaze, 0.3 * bulge);
    // Normalize hue to unit luminance so uPeak sets brightness, not the swatch,
    // then pre-saturate a little: ACES' toe greys out very dark colors.
    hue /= max(1e-5, luma(hue));
    hue = max(mix(vec3(1.0), hue, 1.35), 0.0);

    float L = uPeak * pow(clamp(density, 0.0, 1.2), 1.4);
    vec3 col = uVoid + hue * L;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * Build the whole backdrop.
 *
 * Two cubemaps, because they serve different eyes:
 *  - `dustCube` (scene.background): dust only. Dust is smooth, so a modest
 *    face size magnified on screen stays clean, and no star ever looks blurred.
 *  - `starfieldCube` (ctx.starfieldCube, lensing source): dust plus every star
 *    direction, so a black hole bends a real, recognizable sky.
 * Every star the viewer sees directly is a crisp live point.
 *
 * @returns {{ starfieldCube: THREE.CubeTexture, backgroundCube: THREE.CubeTexture,
 *             points: THREE.Points, update(t:number):void,
 *             setPixelRatio(pr:number):void, rebake():void, dispose():void }}
 */
function createBackdrop(renderer, scene, cubeSize) {
  const frame = galacticFrame();
  const rand = mulberry32(STAR_SEED);
  const tint = makeStarTint(color('STAR_FILL_0'), color('STAR_FILL_50'), new THREE.Color(1, 1, 1));
  const dir = new THREE.Vector3();
  const c = new THREE.Color();
  const faceScale = cubeSize / 1024;

  // ---------------- live resolved stars (one Points draw)
  const pos = new Float32Array(LIVE_STARS * 3);
  const col = new Float32Array(LIVE_STARS * 3);
  const size = new Float32Array(LIVE_STARS);
  const bakeSize = new Float32Array(LIVE_STARS);
  const follow = new Float32Array(LIVE_STARS);
  for (let i = 0; i < LIVE_STARS; i++) {
    const bright = i < LIVE_BRIGHT;
    // Faint stars crowd the band (Milky-Way grain); standouts are scattered.
    sampleDirection(rand, frame, bright ? 0.15 : 0.42, bright ? 0.03 : 0.06, dir);
    const su = rand();
    const shell = su < SHELLS[0].share ? SHELLS[0]
      : su < SHELLS[0].share + SHELLS[1].share ? SHELLS[1] : SHELLS[2];
    pos[i * 3] = dir.x * shell.r;
    pos[i * 3 + 1] = dir.y * shell.r;
    pos[i * 3 + 2] = dir.z * shell.r;
    follow[i] = shell.follow;

    // Power-law magnitudes: a few standouts, a long faint tail. Peak stays < 1.0
    // linear so no background star ever crosses the bloom threshold.
    let b, s;
    if (bright) {
      b = 0.45 + 0.45 * rand();
      s = 2.4 + 1.2 * rand();
    } else {
      const u = rand();
      b = 0.03 + 0.32 * Math.pow(u, 3.4);
      s = 1.0 + 0.9 * Math.pow(u, 1.6);
    }
    // Nearer shells read slightly larger and brighter: depth without extra draws.
    const near = shell === SHELLS[0] ? 1.12 : shell === SHELLS[1] ? 1.0 : 0.88;
    s *= near;
    b *= near;
    tint(Math.pow(rand(), 0.8), c).multiplyScalar(b);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    size[i] = s;
    bakeSize[i] = Math.max(1.0, s * 0.8 * faceScale);
    // The old twinkle weights drew from the seeded RNG here; keep consuming the
    // same draws so the star layout (later stars, dust bake) stays identical.
    if (rand() < 0.35) rand();
    rand();
  }
  const liveGeo = new THREE.BufferGeometry();
  liveGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  liveGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  liveGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  liveGeo.setAttribute('aFollow', new THREE.BufferAttribute(follow, 1));
  const liveMat = new THREE.ShaderMaterial({
    name: 'CosmosLiveStars',
    uniforms: {
      uPixelRatio: { value: 1 },
    },
    vertexShader: LIVE_STAR_VERT,
    fragmentShader: LIVE_STAR_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const points = new THREE.Points(liveGeo, liveMat);
  points.name = 'cosmos.starfield';
  points.frustumCulled = false;   // positions move with the camera in the shader
  points.renderOrder = -1000;     // drawn first; everything else composites over it
  scene.add(points);

  // ---------------- cubemaps
  const cubeOpts = {
    type: THREE.HalfFloatType,     // dark gradients need more than 8 bits
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  };
  const dustTarget = new THREE.WebGLCubeRenderTarget(DUST_CUBE, cubeOpts);
  dustTarget.texture.name = 'cosmos.dustCube';
  const lensTarget = new THREE.WebGLCubeRenderTarget(cubeSize, cubeOpts);
  lensTarget.texture.name = 'cosmos.starfieldCube';

  function bake() {
    const bakeScene = new THREE.Scene();
    const dustGeo = new THREE.SphereGeometry(DUST_RADIUS, 96, 48);
    const dustMat = new THREE.ShaderMaterial({
      name: 'CosmosDustBake',
      uniforms: {
        uN: { value: frame.N }, uC: { value: frame.C },
        uViolet: { value: color('DUST_VIOLET') },
        uTeal: { value: color('DUST_TEAL') },
        uHaze: { value: color('STAR_FILL_0') },
        uVoid: { value: color('VOID') },
        uPeak: { value: DUST_PEAK_LUMA },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const dust = new THREE.Mesh(dustGeo, dustMat);
    dust.renderOrder = 0;
    bakeScene.add(dust);

    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(bakeSize, 1));
    const starMat = new THREE.ShaderMaterial({
      name: 'CosmosStarsBake',
      vertexShader: BAKE_STAR_VERT,
      fragmentShader: LIVE_STAR_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const stars = new THREE.Points(starGeo, starMat);
    stars.frustumCulled = false;
    stars.renderOrder = 1;

    // Pass 1: dust alone → background. Pass 2: dust + stars → lensing source.
    const dustCam = new THREE.CubeCamera(1, DUST_RADIUS * 2, dustTarget);
    bakeScene.add(dustCam);
    dustCam.update(renderer, bakeScene);
    bakeScene.add(stars);
    const lensCam = new THREE.CubeCamera(1, DUST_RADIUS * 2, lensTarget);
    bakeScene.add(lensCam);
    lensCam.update(renderer, bakeScene);

    // The bake scene is single-use: free everything but the cubes.
    dustGeo.dispose(); dustMat.dispose();
    starGeo.dispose(); starMat.dispose();
  }

  bake();

  let disposed = false;
  return {
    starfieldCube: lensTarget.texture,
    backgroundCube: dustTarget.texture,
    points,
    update() {
      // Static sky: nothing animates. Kept as a hook for the frame loop.
    },
    setPixelRatio(pr) {
      liveMat.uniforms.uPixelRatio.value = pr;
    },
    rebake() {
      if (!disposed) bake();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(points);
      liveGeo.dispose();
      liveMat.dispose();
      dustTarget.dispose();
      lensTarget.dispose();
    },
  };
}
