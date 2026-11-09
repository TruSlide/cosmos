// The galaxy: every Claude Code session as a star system, every project as a
// spiral arm, around one fixed core (GALAXY_CONTRACT §5).
//
// createGalaxy(engine, store) builds the scene once and then reads the client
// store every frame. Nothing here fetches data or keeps history: the store
// emits the same records live or while the scrubber replays, and the galaxy
// just draws what `store.now()` says exists.
//
// Frame order (one engine.onFrame callback):
//   rebuild layout/arms if records changed → camera + atmosphere uniforms →
//   project every system → LOD (full StarSystems) → impostors → beacons and
//   edge markers → Map links → core and arms → pending focus → after-frame
//   listeners (LENS labels read final positions there).
//
// Picking is screen-space (no raycasts): things inside a full system first
// (planets, ships, black hole: nearest within 16 px), then systems, then arms,
// then the core.

import * as THREE from 'three';
import { starColor } from '../lib/palette.js';
import { hash01, damp, smoothstep, clamp } from '../lib/math.js';
import { createLayout } from './layout.js';
import { Core, GalacticDisk, createAtmosphere } from './core.js';
import { Impostors, IMP_MODE } from './impostors.js';
import { Beacons } from './beacons.js';
import { Links, LINK_KIND } from './links.js';
import { Lod, PROMOTE_PX } from './lod.js';
import { GalacticCenter } from './center.js';
import { DeepSky } from './deepsky.js';
import { Constellations } from './constellations.js';

const SYSTEM_RADIUS = 20;            // Gate 1 bounding radius
const NEEDS_NEAR = 900;              // needs-me systems closer than this get promoted
const FAR_REMNANT = 2400;            // dead/husk systems beyond this are hidden
const RESET_ELEV = (38 * Math.PI) / 180;
const SESSION_DIST = 70;
const SESSION_ELEV = (25 * Math.PI) / 180;
const DETAIL_DIST = 18;
const PICK_DETAIL_PX = 16;
const HOVER_MS = 50;                 // 20 Hz
const QUALITY_CAP = { high: 6, medium: 4, low: 2 };
const LEVEL = { GALAXY: 1100, ARM: 260, SYSTEM: 45 };
const HUSK = new Set(['aged-out', 'deleted']);

/**
 * @param {object} engine  createEngine() result
 * @param {object} store   ClientStore (GALAXY_CONTRACT §4)
 * @param {{ edgeRoot?: HTMLElement }} [opts]
 */
export function createGalaxy(engine, store, opts = {}) {
  const { ctx, camera, controls, renderer } = engine;
  const canvas = renderer.domElement;
  const root = new THREE.Group();
  root.name = 'Galaxy';
  engine.scene.add(root);

  // Draw calls across the whole composer frame, not just its last pass.
  renderer.info.autoReset = false;

  const atm = createAtmosphere();
  const layout = createLayout({ getRecord: (sid) => store.get(sid) });
  const disk = new GalacticDisk(root, ctx, { atm, layout });
  const core = new Core(root, ctx, { atm });
  // Center: the gold Codex (saved knowledge) and the "me" star; deep sky behind everything.
  const center = new GalacticCenter(root, ctx);
  const sky = new DeepSky(root, ctx);
  const constellations = new Constellations(root);
  const waiting = [];
  const liveness = [];
  const impostors = new Impostors(root, ctx, { atm });
  const links = new Links(root);
  const lod = new Lod(root, ctx, {
    store,
    maxFull: () => {
      const s = store.settings?.render?.maxFullSystems;
      const q = QUALITY_CAP[ctx.quality] ?? 6;
      // Settings default (6) is the high-quality cap; lower qualities cap it further.
      if (!Number.isFinite(s)) return q;
      return ctx.quality === 'high' ? Math.max(1, s) : Math.max(1, Math.min(s, q));
    },
  });
  const edgeRoot = opts.edgeRoot ?? (typeof document !== 'undefined' ? document.getElementById('edge-markers') : null);
  const occluders = opts.occluders ?? null;   // HUD rects (panels, top bar, scrubber) markers must avoid
  const beacons = new Beacons(root, ctx, {
    edgeRoot,
    onSelect: (sid) => store.select({ kind: 'session', sid }, { fly: true }),
  });
  // Crashed (louder than needs-me): orange distress beacons with their own edge markers.
  const crashBeacons = new Beacons(root, ctx, {
    edgeRoot, kind: 'crash',
    onSelect: (sid) => store.select({ kind: 'session', sid }, { fly: true }),
  });
  const crashList = [];
  let crashN = 0;

  // ------------------------------------------------------------- per-session nodes

  /** sid -> node */
  const nodes = new Map();
  /** armKey -> { key, name, slot, sMax, live, len, tip: Vector3, curve: Vector3[], mini: [x,z][], center, radius } */
  const arms = new Map();
  /** `${armKey}|${cluster}` -> { key, firstSid, name, pos } */
  const clusters = new Map();
  let nodeList = [];
  let dirty = true;
  const armGeo = new Map();       // armKey -> reusable { tip, center, curve[65], mini[33] }
  let lastDiskSig = '';
  let extent = 600;

  function makeNode(sid) {
    return {
      sid, rec: null, pos: new THREE.Vector3(), col: new THREE.Color(), seed: hash01(sid),
      x: 0, y: 0, onScreen: false, behind: false, camDist: 1, pxPerUnit: 0, pxR: 0,
      visible: false, storm: 0, mode: IMP_MODE.WORKING, sysKey: `sys:${sid}`,
      armLinkKey: '', forkKey: '', clusterKey: '', shipKeys: new Map(), beaconAlpha: 0, beaconSince: -1,
      cand: { sid, score: 0, px: 0, required: false, eligible: false, pos: null, camDist: 0 },
    };
  }

  /** Everything rebuild() derives from a record. When a 'session' message leaves
   *  it unchanged (the usual 2 Hz state/metrics update), the node just takes the
   *  new record: no layout pass, no allocation. */
  function placeSig(rec) {
    const p = rec.place;
    return `${rec.arm?.key}|${rec.arm?.name}|${p?.slot}|${p?.idx}|${p?.cluster}|${p?.clusterIdx}|${rec.forkOf || ''}|${rec.live ? 1 : 0}`;
  }

  function rebuild() {
    dirty = false;
    const recs = [];
    for (const rec of store.sessions.values()) recs.push(rec);
    for (const rec of recs) layout.note(rec);
    const seen = new Set();
    arms.clear();
    clusters.clear();
    for (const rec of recs) {
      seen.add(rec.id);
      let n = nodes.get(rec.id);
      if (!n) { n = makeNode(rec.id); nodes.set(rec.id, n); }
      n.rec = rec;
      n.placeSig = placeSig(rec);
      layout.systemPosition(rec, n.pos);
      n.cand.pos = n.pos;
      const armKey = rec.arm?.key ?? '(none)';
      n.armKey = armKey;
      n.armLinkKey = `link:${rec.id}>arm:${armKey}`;
      n.forkKey = rec.forkOf ? `link:${rec.id}>${rec.forkOf}` : '';
      let arm = arms.get(armKey);
      if (!arm) {
        const meta = store.arms?.get?.(armKey);
        arm = { key: armKey, name: meta?.name ?? rec.arm?.name ?? armKey, slot: Number.isInteger(meta?.slot) ? meta.slot : layout.slotOf(rec),
          sMax: 0, live: 0, sessions: 0, labelKey: `arm:${armKey}` };
        arms.set(armKey, arm);
      }
      arm.sessions++;
      if (rec.live) arm.live++;
      arm.sMax = Math.max(arm.sMax, layout.sessionS(rec));
      const cl = rec.place?.cluster;
      if (cl != null) {
        const ck = `${armKey}|${cl}`;
        let c = clusters.get(ck);
        if (!c || (rec.place.idx ?? 0) < c.idx) {
          const pos = c?.pos ?? new THREE.Vector3();
          layout.clusterAnchor(rec, pos);
          c = { key: `wt:${c ? c.firstSid : rec.id}`, firstSid: c ? c.firstSid : rec.id, name: cl, idx: rec.place.idx ?? 0, pos, armKey, slot: arm.slot };
          clusters.set(ck, c);
        }
        if ((rec.place.idx ?? 0) <= c.idx) { c.firstSid = rec.id; c.key = `wt:${rec.id}`; c.idx = rec.place.idx ?? 0; }
        n.clusterKey = `link:${rec.id}>wt:${cl}`;
        n.cluster = c;
      } else {
        n.cluster = null;
      }
    }
    for (const sid of nodes.keys()) if (!seen.has(sid)) { nodes.delete(sid); layout.forget(sid); }
    pruneAnchors();
    nodeList = [...nodes.values()];
    // Clusters' anchor links go to the arm at the first member's birth point.
    for (const c of clusters.values()) {
      const first = store.get(c.firstSid);
      c.armPoint = first ? layout.sessionArmPoint(first, new THREE.Vector3()) : c.pos.clone();
    }
    // Arm geometry caches (curves for picking, minimap, label tips, framing).
    extent = 300;
    for (const arm of arms.values()) {
      arm.len = Math.max(560, arm.sMax + 300);
      // Reuse the previous build's geometry objects for this arm (no per-rebuild allocation).
      const g = armGeo.get(arm.key) || { tip: new THREE.Vector3(), center: new THREE.Vector3(), curve: Array.from({ length: 65 }, () => new THREE.Vector3()), mini: Array.from({ length: 33 }, () => [0, 0]) };
      armGeo.set(arm.key, g);
      arm.tip = layout.armPoint(arm.slot, arm.sMax + 140, g.tip);
      arm.curve = g.curve;
      arm.mini = g.mini;
      for (let i = 0; i <= 64; i++) {
        const p = layout.armPoint(arm.slot, (arm.len * i) / 64, g.curve[i]);
        if (i % 2 === 0) { g.mini[i >> 1][0] = p.x; g.mini[i >> 1][1] = p.z; }
      }
      extent = Math.max(extent, Math.hypot(arm.tip.x, arm.tip.z) + 80);
      arm.center = g.center.set(0, 0, 0);
      arm.radius = 0;
    }
    for (const n of nodeList) extent = Math.max(extent, Math.hypot(n.pos.x, n.pos.z) + 60);
    // Arm framing: centre on the arm itself (its middle birth point), not the
    // centroid, which for a curling spiral falls back toward the core.
    for (const a of arms.values()) {
      layout.armPoint(a.slot, Math.max(120, a.sMax * 0.55), a.center);
      for (const n of nodeList) if (n.armKey === a.key) a.radius = Math.max(a.radius, n.pos.distanceTo(a.center));
      a.radius = Math.min(a.radius, 650);
    }
    for (const k of armGeo.keys()) if (!arms.has(k)) armGeo.delete(k);
    // The disk only rebuilds when its inputs really changed.
    const diskSig = [...arms.values()].map((a) => `${a.key}|${a.slot}|${a.sMax}|${a.live}`).join(';');
    if (diskSig !== lastDiskSig) {
      lastDiskSig = diskSig;
      disk.setArms([...arms.values()].map((a) => ({ key: a.key, slot: a.slot, sMax: a.sMax, live: a.live })));
    }
    // Minimap arms list (stable objects).
    miniArms.length = 0;
    for (const a of arms.values()) miniArms.push({ key: a.key, points: a.mini });
    engine.wake(0.5);
  }

  // ------------------------------------------------------------- projection

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _proj = { x: 0, y: 0, onScreen: false, behind: false, depth: 0 };
  let cssW = 1, cssH = 1, pxK = 1;    // pxK: CSS px per world unit at distance 1

  function updateView() {
    camera.updateMatrixWorld();
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    pxK = cssH * 0.5 * camera.projectionMatrix.elements[5];
  }

  /** CSS px in the canvas for a world point. */
  function project(world, out) {
    _v.copy(world).applyMatrix4(camera.matrixWorldInverse);
    const vz = _v.z;
    out.depth = camera.position.distanceTo(world);
    out.behind = vz >= -1e-4;
    _v.applyMatrix4(camera.projectionMatrix);   // applyMatrix4 divides by w (sign kept)
    out.x = (_v.x * 0.5 + 0.5) * cssW;
    out.y = (0.5 - _v.y * 0.5) * cssH;
    out.onScreen = !out.behind && out.x >= 0 && out.x <= cssW && out.y >= 0 && out.y <= cssH;
    return out;
  }

  // ------------------------------------------------------------- state helpers

  function modeCode(rec) {
    const m = rec.state?.mode;
    const rem = rec.state?.remnant;
    if (store.fateOf?.(rec, store.now()).fate === 'flourish') return IMP_MODE.FLOURISH;
    if (HUSK.has(rem)) return IMP_MODE.HUSK;
    switch (m) {
      case 'needs-me': return IMP_MODE.NEEDS;
      case 'working': return IMP_MODE.WORKING;
      case 'my-move': return IMP_MODE.MY_MOVE;
      case 'idle': return IMP_MODE.IDLE;
      case 'crashed': return IMP_MODE.CRASHED;
      default: return IMP_MODE.DEAD;
    }
  }

  function idleOf(rec) {
    const m = rec.state?.mode;
    if (m === 'dead') return 1;
    if (m === 'idle' || m === 'my-move') {
      const f = typeof store.idleFor === 'function' ? store.idleFor(rec) : rec.state?.idleFor;
      return Number.isFinite(f) ? clamp(f, 0, 1) : 0;
    }
    return 0;
  }

  function impostorSize(rec) {
    const tot = rec.tokens?.total ?? 0;
    return clamp(2.2 + 1.4 * Math.log10(1 + tot / 1e5), 2, 9);
  }

  function selectedSid() {
    const s = store.selection;
    return s && s.sid ? s.sid : null;
  }

  // ------------------------------------------------------------- frame

  let mapMode = false;
  let spendLens = !!store.settings?.render?.spend;
  // Spend ramp: slate (nothing) -> sky blue -> white -> rose -> crimson (never indigo or orange).
  const SPEND_STOPS = [new THREE.Color(0x5b6378), new THREE.Color(0x3fb6ff), new THREE.Color(0xf4f6ff), new THREE.Color(0xffb8c0), new THREE.Color(0xe3263f)];
  function spendColor(k, out) {
    const x = k * (SPEND_STOPS.length - 1);
    const i = Math.min(SPEND_STOPS.length - 2, Math.floor(x));
    return out.copy(SPEND_STOPS[i]).lerp(SPEND_STOPS[i + 1], x - i);
  }
  let frameNo = 0;
  let lastT = 0;
  let pending = null;                 // { sel, until, seconds }
  const afterFrame = new Set();
  const cands = [];
  const quasarList = [];
  let quasarN = 0;
  const markerList = [];
  const linkAnchors = [];
  let linkAnchorN = 0;
  const miniArms = [];
  const miniSystems = [];
  const miniView = { x: 0, z: 0, yaw: 0, span: 1 };
  const minimapOut = { radius: 600, arms: miniArms, systems: miniSystems, view: miniView };
  const beaconShownAt = new Map();    // sid -> performance.now() of the first frame its beacon drew
  let rateHint = 0;
  let lastFps = 0;

  const offFrame = engine.onFrame((dt, t) => {
    lastT = t;
    frameNo++;
    renderer.info.reset();
    if (dirty) rebuild();
    else if (frameNo % ANCHOR_TTL === 0) pruneAnchors();
    updateView();

    const focusDist = camera.position.distanceTo(controls.target);
    atm.uAtmNear.value = Math.max(400, focusDist * 1.15);
    atm.uAtmFar.value = Math.max(1400, focusDist * 1.6);

    const now = store.now();
    const selSid = selectedSid();
    const pendSid = pending?.sel?.sid ?? null;
    let hint = 0;

    // --- project + LOD candidates
    let nc = 0;
    let activitySum = 0;
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      const rec = n.rec;
      const born = rec.times?.bornAt;
      n.mode = modeCode(rec);
      project(n.pos, _proj);
      n.x = _proj.x; n.y = _proj.y; n.onScreen = _proj.onScreen; n.behind = _proj.behind; n.camDist = _proj.depth;
      n.pxPerUnit = pxK / Math.max(n.camDist, 1e-3);
      n.pxR = SYSTEM_RADIUS * n.pxPerUnit;
      const notBorn = Number.isFinite(born) && born > now + 1;
      // Far remnants are culled, but never the far side of the galaxy in the overview.
      const farRemnant = (n.mode === IMP_MODE.DEAD || n.mode === IMP_MODE.HUSK)
        && n.camDist > Math.max(FAR_REMNANT, focusDist + extent) && rec.id !== selSid;
      n.visible = !notBorn && !farRemnant;
      if (!n.visible) continue;
      if (rec.live && rec.state?.mode === 'working') activitySum += rec.activity ?? 0;
      const c = n.cand;
      c.required = rec.id === selSid || rec.id === pendSid;
      const needsNear = n.mode === IMP_MODE.NEEDS && n.camDist < NEEDS_NEAR;
      // Off-screen systems never take a full slot (belts are the triangle budget).
      const inView = !n.behind && n.x > -n.pxR && n.x < cssW + n.pxR && n.y > -n.pxR && n.y < cssH + n.pxR;
      c.px = inView ? n.pxR : 0;
      c.eligible = inView && (needsNear || n.pxR >= PROMOTE_PX);
      c.score = c.required ? 1e9 : needsNear ? 1e6 + c.px : c.px;
      c.camDist = n.camDist;
      cands[nc++] = c;
    }
    hint = Math.max(hint, lod.update(cands, nc, dt, t));

    // --- impostors, beacons
    impostors.begin();
    beacons.begin();
    crashBeacons.begin();
    quasarN = 0;
    crashN = 0;
    const pulse = beacons.pulse(t);
    let storming = false;
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      if (!n.visible) { n.beaconAlpha = 0; continue; }
      const rec = n.rec;
      const fullFade = lod.fade(n.sid);
      const stormTarget = rec.storm ? 1 : 0;
      n.storm = damp(n.storm, stormTarget, stormTarget ? 0.15 : 0.7, dt);
      if (n.storm > 0.01) storming = true;
      if (fullFade < 1) {
        starColor(rec.context?.fill ?? 0, n.col);
        const idle = idleOf(rec);
        const bright = n.mode === IMP_MODE.IDLE ? Math.max(0.06, 1 - idle)
          : n.mode === IMP_MODE.MY_MOVE ? 0.85 * Math.max(0.25, 1 - idle) : 1;
        // Dying systems carry their death phase in the activity slot (they have no activity).
        const fate = (n.mode === IMP_MODE.IDLE || n.mode === IMP_MODE.DEAD) ? store.fateOf?.(rec, now) : null;
        const act = fate?.fate === 'dying' ? fate.phase : rec.activity ?? 0;
        if (spendLens) {
          // Spend lens: color and size by tokens spent today (log scale), state glyphs unchanged.
          const k = clamp(Math.log10(1 + (rec.tokens?.today || 0) / 2e4) / 2.5, 0, 1);
          spendColor(k, n.col);
          impostors.push(n.pos, n.col, impostorSize(rec) * (0.55 + 1.3 * k), k > 0.01 ? 0.5 + 0.7 * k : 0.12, 0, k > 0.01 ? IMP_MODE.WORKING : IMP_MODE.DEAD, n.storm, 1 - fullFade, n.seed, 0);
        } else impostors.push(n.pos, n.col, impostorSize(rec), bright, idle, n.mode, n.storm, 1 - fullFade, n.seed, act);
      }
      if (n.mode === IMP_MODE.NEEDS) {
        // Hand over to the real quasar once the full system is big on screen.
        const full = lod.get(n.sid);
        const target = full ? 1 - smoothstep(45, 90, n.pxR) * fullFade : 1;
        n.beaconAlpha = n.beaconAlpha <= 0 ? Math.max(target, 0.001) : damp(n.beaconAlpha, target, 0.25, dt);
        if (n.beaconAlpha > 0.01 && !n.behind) {
          // Readable from anywhere: near the 36 px top of the range at every
          // zoom (the shader adds a halo several times this size).
          const size = (36 - 6 * smoothstep(250, 3200, n.camDist)) * (1 + 0.08 * pulse);
          beacons.push(n.pos, size, n.beaconAlpha);
          if (!beaconShownAt.has(n.sid)) beaconShownAt.set(n.sid, performance.now());
        }
        let q = quasarList[quasarN];
        if (!q) { q = { sid: '', x: 0, y: 0, onScreen: false, behind: false, angle: 0, dist: 0, wait: '', waitS: NaN, title: '', drawn: false }; quasarList[quasarN] = q; }
        quasarN++;
        if (q.sid !== n.sid) q.waitS = NaN;
        q.sid = n.sid; q.x = n.x; q.y = n.y; q.onScreen = n.onScreen; q.behind = n.behind; q.dist = n.camDist;
        q.drawn = n.beaconAlpha > 0.01 && !n.behind && n.onScreen;
        let dx = n.x - cssW / 2, dy = n.y - cssH / 2;
        if (n.behind) { dx = -dx; dy = -dy; }
        q.angle = Math.atan2(dy, dx);
        const waitS = Math.floor(now - (rec.state?.since ?? now));
        if (q.waitS !== waitS || q.sid !== n.sid) { q.waitS = waitS; q.wait = fmtWait(waitS); }
        q.title = rec.title ?? '';
      } else {
        n.beaconAlpha = 0;
        beaconShownAt.delete(n.sid);
      }
      if (n.mode === IMP_MODE.CRASHED && store.crashAlarm?.(rec, now)) {
        if (!n.behind) crashBeacons.push(n.pos, 46 - 6 * smoothstep(250, 3200, n.camDist), 1);
        let q = crashList[crashN];
        if (!q) { q = { sid: '', x: 0, y: 0, onScreen: false, behind: false, wait: '', waitS: NaN, title: '' }; crashList[crashN] = q; }
        crashN++;
        q.sid = n.sid; q.x = n.x; q.y = n.y; q.onScreen = n.onScreen; q.behind = n.behind;
        const agoS = Math.floor(now - (rec.state?.since ?? now));
        if (q.waitS !== agoS) { q.waitS = agoS; q.wait = fmtWait(agoS); }
        q.title = rec.title ?? '';
      }
    }
    impostors.end(t);
    beacons.end(t);
    crashBeacons.end(t);
    const occRects = occluders ? occluders.rects() : null;
    crashBeacons.placeMarkers(crashList, crashN, cssW, cssH, occRects);
    beacons.placeMarkers(quasarList, quasarN, cssW, cssH, occRects);
    if (crashN > 0) hint = Math.max(hint, 1);
    if (quasarN > 0) hint = Math.max(hint, 1);
    if (storming) hint = Math.max(hint, 1);

    // --- Map links
    links.begin();
    linkAnchorN = 0;
    if (mapMode) buildLinks();
    links.end(mapMode);

    // --- core and arms
    for (const a of arms.values()) a.live = 0;
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      if (n.visible && n.rec.live) { const a = arms.get(n.armKey); if (a) a.live++; }
    }
    const qDim = quasarN > 0 ? 1 : 0;
    hint = Math.max(hint, core.update(activitySum, now, dt, qDim));
    // Center pair and deep sky: threads to every session that needs me; sky grows with lifetime tokens.
    waiting.length = 0;
    liveness.length = 0;
    let lifetime = 0, dormant = 0;
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      lifetime += n.rec.tokens?.total || 0;
      if (n.visible && n.mode === IMP_MODE.NEEDS) waiting.push(n.pos);
      // Tree: living sessions are branches above, everything else feeds the roots.
      if (!n.visible) continue;
      if (n.mode === IMP_MODE.WORKING || n.mode === IMP_MODE.NEEDS || n.mode === IMP_MODE.MY_MOVE) {
        liveness.push(n.mode === IMP_MODE.WORKING ? 0.6 + 0.4 * (n.rec.activity ?? 0) : n.mode === IMP_MODE.NEEDS ? 0.8 : 0.3);
      } else dormant++;
    }
    center.setSessions(liveness.length, dormant, liveness);
    hint = Math.max(hint, center.update(dt, t, { pxK, nowS: now, waiting, alive: liveness.length }));
    constellations.enabled = store.settings?.render?.constellations !== false;
    hint = Math.max(hint, constellations.update(t, () => store.sessions.values(), now, (sid) => { const n = nodes.get(sid); return n && n.visible ? n.pos : null; }));
    sky.enabled = store.settings?.render?.deepSky !== false;
    hint = Math.max(hint, sky.update(dt, t, { camera, tokens: lifetime, tokensToday: store.totals?.tokensToday?.total || 0 }));
    hint = Math.max(hint, disk.update(dt, qDim) || 0);
    syncArmLive();

    // --- focus waiting for a full system to exist
    if (pending) {
      if (t > pending.until) pending = null;
      else if (tryDetailFocus(pending.sel, pending.seconds)) pending = null;
      else hint = 2;
    }

    rateHint = hint;
    for (const fn of afterFrame) {
      try { fn(dt, t); } catch (err) { console.error('[cosmos] afterFrame listener threw:', err); }
    }
    return hint;
  });

  function syncArmLive() {
    for (const a of arms.values()) disk.setLive(a.key, a.live);
  }

  // ------------------------------------------------------------- links

  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();

  function pushLinkAnchor(key, kind, sid, id, a, b) {
    let la = linkAnchors[linkAnchorN];
    if (!la) { la = { key: '', kind: '', sid: '', id: '', mid: new THREE.Vector3() }; linkAnchors[linkAnchorN] = la; }
    linkAnchorN++;
    la.key = key; la.kind = kind; la.sid = sid; la.id = id;
    la.mid.addVectors(a, b).multiplyScalar(0.5);
  }

  function buildLinks() {
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      if (!n.visible) continue;
      const rec = n.rec;
      if (n.cluster) {
        links.push(n.pos, n.cluster.pos, LINK_KIND.CLUSTER, 0.9, 0.5);
        pushLinkAnchor(n.clusterKey, 'cluster', n.sid, n.cluster.name, n.pos, n.cluster.pos);
      } else {
        layout.sessionArmPoint(rec, _b);
        links.push(n.pos, _b, LINK_KIND.ARM, 1, 0.25);
        pushLinkAnchor(n.armLinkKey, 'arm', n.sid, n.armKey, n.pos, _b);
      }
      if (rec.forkOf) {
        const p = nodes.get(rec.forkOf);
        if (p && p.visible) {
          links.push(n.pos, p.pos, LINK_KIND.FORK, 0.9, 0.5);
          pushLinkAnchor(n.forkKey, 'fork', n.sid, rec.forkOf, n.pos, p.pos);
        }
      }
      const ships = rec.ships;
      if (ships && ships.length) {
        const full = lod.get(n.sid);
        for (let j = 0; j < ships.length; j++) {
          const sh = ships[j];
          if (!sh.active) continue;
          if (!(full && full.ships.getAgentPosition(sh.id, _a))) {
            // Not drawn as a ship here: a short spoke in a stable direction.
            const ang = hash01(sh.id) * Math.PI * 2;
            _a.set(n.pos.x + Math.cos(ang) * 26, n.pos.y + 6, n.pos.z + Math.sin(ang) * 26);
          }
          links.push(n.pos, _a, LINK_KIND.SHIP, 0.9, 0.6);
          let key = n.shipKeys.get(sh.id);
          if (!key) { key = `link:${n.sid}>${sh.id}`; n.shipKeys.set(sh.id, key); }
          pushLinkAnchor(key, 'ship', n.sid, sh.id, n.pos, _a);
        }
      }
    }
    for (const c of clusters.values()) {
      links.push(c.pos, c.armPoint, LINK_KIND.ARM, 0.6, 0.2);
    }
  }

  // ------------------------------------------------------------- anchors

  const anchorPool = new Map();
  const anchorList = [];
  let anchorsFrame = -1;
  const ANCHOR_TTL = 600;          // frames an unused anchor is kept (files, ships come and go)

  function anchor(key, kind) {
    let a = anchorPool.get(key);
    if (!a) {
      a = { key, kind, sid: undefined, id: undefined, armKey: undefined, x: 0, y: 0, onScreen: false, depth: 0, size: 0, layer: 0, used: 0 };
      anchorPool.set(key, a);
    }
    a.used = frameNo;
    anchorList.push(a);
    return a;
  }
  /** Drop anchors of removed sessions and ones unused for ANCHOR_TTL frames. */
  function pruneAnchors() {
    for (const [k, a] of anchorPool) {
      if ((a.sid !== undefined && !nodes.has(a.sid)) || frameNo - a.used > ANCHOR_TTL) anchorPool.delete(k);
    }
  }

  function place(a, world, sizeWorld) {
    project(world, _proj);
    a.x = _proj.x; a.y = _proj.y; a.onScreen = _proj.onScreen; a.depth = _proj.depth;
    a.size = sizeWorld * pxK / Math.max(_proj.depth, 1e-3);
    a.layer = _proj.depth < atm.uAtmNear.value ? 0 : _proj.depth < atm.uAtmFar.value ? 1 : 2;
  }

  function anchors() {
    if (anchorsFrame === frameNo) return anchorList;
    anchorsFrame = frameNo;
    anchorList.length = 0;
    updateView();
    _v2.set(0, 0, 0);
    place(anchor('core', 'core'), _v2, core.radius);
    place(anchor('codex', 'codex'), center.codexPos, center.radius);
    place(anchor('me', 'me'), center.mePos, 6);
    for (const arm of arms.values()) {
      const a = anchor(arm.labelKey, 'arm');
      a.armKey = arm.key;
      place(a, arm.tip, 60);
    }
    for (const c of clusters.values()) {
      const a = anchor(c.key, 'cluster');
      a.sid = c.firstSid; a.id = c.name; a.armKey = c.armKey;
      place(a, c.pos, 40);
    }
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      if (!n.visible) continue;
      const a = anchor(n.sysKey, 'system');
      a.sid = n.sid; a.armKey = n.armKey;
      const full = lod.get(n.sid);
      a.x = n.x; a.y = n.y; a.onScreen = n.onScreen; a.depth = n.camDist;
      // Full: the system's star body (≈ 2.2 units); impostor: its drawn body.
      a.size = Math.max(full ? 2.2 * n.pxPerUnit : impostorSize(n.rec) * n.pxPerUnit, 3.2);
      a.layer = n.camDist < atm.uAtmNear.value ? 0 : n.camDist < atm.uAtmFar.value ? 1 : 2;
      if (full) detailAnchors(n, full);
    }
    for (let i = 0; i < linkAnchorN; i++) {
      const la = linkAnchors[i];
      const a = anchor(la.key, 'link');
      a.sid = la.sid; a.id = la.kind;
      place(a, la.mid, 0);
    }
    return anchorList;
  }

  function detailAnchors(n, full) {
    const e = lod.entries.get(n.sid);
    const files = e?.state?.files;
    const grain = e?.grain ?? 'folder';
    if (files) {
      for (let j = 0; j < files.length; j++) {
        const f = files[j];
        if (!full.planets.getPosition(f.id, _a)) continue;
        const kind = grain === 'file' ? 'file' : 'folder';
        const a = anchor(`${kind}:${n.sid}:${f.id}`, kind);
        a.sid = n.sid; a.id = f.id; a.armKey = n.armKey;
        place(a, _a, 0.8);
      }
    }
    const ships = n.rec.ships;
    if (ships) {
      for (let j = 0; j < ships.length; j++) {
        const sh = ships[j];
        if (!full.ships.getAgentPosition(sh.id, _a)) continue;
        const a = anchor(`ship:${n.sid}:${sh.id}`, 'ship');
        a.sid = n.sid; a.id = sh.id; a.armKey = n.armKey;
        place(a, _a, 0.6);
      }
    }
    const bhId = activeCompactionId(n.rec, full);
    if (bhId && full.blackHole.getPosition(_a)) {
      full.root.localToWorld(_a);
      const a = anchor(`bh:${n.sid}:${bhId}`, 'compaction');
      a.sid = n.sid; a.id = bhId; a.armKey = n.armKey;
      place(a, _a, 2.5);
    }
  }

  function activeCompactionId(rec, full) {
    if (!full || !full.blackHole.active) return null;
    const list = rec.compactions;
    if (!list || !list.length) return null;
    let best = null;
    for (const c of list) if (!best || c.t > best.t) best = c;
    return best ? (best.id ?? String(best.t)) : null;
  }

  // ------------------------------------------------------------- picking

  function pick(clientX, clientY) {
    updateView();
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;

    // 1. Inside full systems: planets, ships, black hole.
    let best = null, bestD = PICK_DETAIL_PX;
    for (const [sid, e] of lod.entries) {
      const full = e.system;
      const n = nodes.get(sid);
      if (!full || !n || !n.visible || n.behind) continue;
      if (Math.hypot(n.x - x, n.y - y) > n.pxR * 1.4 + PICK_DETAIL_PX) continue;
      const files = e.state?.files;
      if (files) {
        for (let j = 0; j < files.length; j++) {
          const f = files[j];
          if (!full.planets.getPosition(f.id, _a)) continue;
          project(_a, _proj);
          const d = Math.hypot(_proj.x - x, _proj.y - y);
          if (!_proj.behind && d < bestD) {
            bestD = d;
            best = { kind: e.grain === 'file' ? 'file' : 'folder', sid, id: f.id, point: _a.clone() };
          }
        }
      }
      for (const sh of n.rec.ships ?? []) {
        if (!full.ships.getAgentPosition(sh.id, _a)) continue;
        project(_a, _proj);
        const d = Math.hypot(_proj.x - x, _proj.y - y);
        if (!_proj.behind && d < bestD) { bestD = d; best = { kind: 'ship', sid, id: sh.id, point: _a.clone() }; }
      }
      const bhId = activeCompactionId(n.rec, full);
      if (bhId && full.blackHole.getPosition(_a)) {
        full.root.localToWorld(_a);
        project(_a, _proj);
        const d = Math.hypot(_proj.x - x, _proj.y - y);
        if (!_proj.behind && d < bestD + 6) { bestD = d; best = { kind: 'compaction', sid, id: bhId, point: _a.clone() }; }
      }
    }
    if (best) return best;

    // 2. Systems (and their beacons): nearest on screen, then nearest in depth.
    let bestN = null, bestScore = Infinity;
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      if (!n.visible || n.behind) continue;
      const full = lod.get(n.sid);
      let r = full ? Math.max(10, n.pxR * 0.55) : Math.max(10, impostorSize(n.rec) * 1.6 * n.pxPerUnit);
      if (n.beaconAlpha > 0.2) r = Math.max(r, 18);
      const d = Math.hypot(n.x - x, n.y - y);
      if (d > r) continue;
      const score = d / r + n.camDist * 1e-5;
      if (score < bestScore) { bestScore = score; bestN = n; }
    }
    if (bestN) return { kind: 'session', sid: bestN.sid, armKey: bestN.armKey, point: bestN.pos.clone() };

    // 3. The center pair: the Codex crystal and the "me" star.
    for (const [kind, pos, minPx] of [['me', center.mePos, 12], ['codex', center.codexPos, 22]]) {
      project(pos, _proj);
      if (_proj.behind) continue;
      if (Math.hypot(_proj.x - x, _proj.y - y) < Math.max(minPx, center.radius * pxK / _proj.depth)) return { kind, point: pos.clone() };
    }

    // 3b. Arms: nearest curve sample within 14 px.
    let bestArm = null, bestArmD = 14;
    for (const arm of arms.values()) {
      for (let i = 0; i < arm.curve.length; i++) {
        project(arm.curve[i], _proj);
        if (_proj.behind) continue;
        const d = Math.hypot(_proj.x - x, _proj.y - y);
        if (d < bestArmD) { bestArmD = d; bestArm = { arm, i }; }
      }
    }
    if (bestArm) return { kind: 'arm', armKey: bestArm.arm.key, point: bestArm.arm.curve[bestArm.i].clone() };

    // 4. The core: a landmark, never a session. Clicking it means "the galaxy".
    _v2.set(0, 0, 0);
    project(_v2, _proj);
    if (!_proj.behind && Math.hypot(_proj.x - x, _proj.y - y) < Math.max(14, core.radius * pxK / _proj.depth)) {
      return { kind: 'galaxy', point: new THREE.Vector3() };
    }
    return null;
  }

  function cleanSel(hit) {
    if (!hit) return null;
    const s = { kind: hit.kind };
    if (hit.sid) s.sid = hit.sid;
    if (hit.armKey && hit.kind === 'arm') s.armKey = hit.armKey;
    if (hit.id != null) s.id = hit.id;
    return s;
  }

  // Pointer handling: click (< 4 px of travel) selects and flies; hover at 20 Hz.
  let downX = 0, downY = 0, downBtn = -1;
  let hoverKey = '';
  let hoverAt = 0;
  let hoverTimer = 0;
  let lastMove = null;

  const onDown = (e) => { downX = e.clientX; downY = e.clientY; downBtn = e.button; };
  const onUp = (e) => {
    if (e.button !== 0 || downBtn !== 0) return;
    downBtn = -1;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) >= 4) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit) store.select(cleanSel(hit), { fly: true });
  };
  const onDbl = (e) => {
    const hit = pick(e.clientX, e.clientY);
    if (!hit) store.select({ kind: 'galaxy' }, { fly: true });
  };
  const doHover = () => {
    hoverTimer = 0;
    if (!lastMove) return;
    hoverAt = performance.now();
    const hit = cleanSel(pick(lastMove.x, lastMove.y));
    const key = hit ? `${hit.kind}|${hit.sid ?? ''}|${hit.armKey ?? ''}|${hit.id ?? ''}` : '';
    if (key !== hoverKey) {
      hoverKey = key;
      store.hover(hit);
    }
  };
  const onMove = (e) => {
    if (e.buttons) return;           // dragging the camera: no hover churn
    lastMove = lastMove ?? { x: 0, y: 0 };
    lastMove.x = e.clientX; lastMove.y = e.clientY;
    const since = performance.now() - hoverAt;
    if (since >= HOVER_MS) doHover();
    else if (!hoverTimer) hoverTimer = setTimeout(doHover, HOVER_MS - since);
  };
  const onLeave = () => {
    lastMove = null;
    if (hoverKey) { hoverKey = ''; store.hover(null); }
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  // ------------------------------------------------------------- focus / fly

  function currentAzimuth(target) {
    return Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
  }

  function framePosition(target, dist, elev, out) {
    const az = currentAzimuth(target);
    return out.set(
      target.x + dist * Math.cos(elev) * Math.sin(az),
      target.y + dist * Math.sin(elev),
      target.z + dist * Math.cos(elev) * Math.cos(az),
    );
  }

  function fitDistance(radius) {
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = Math.max(0.3, camera.aspect || 1);
    return Math.max(radius * Math.sin(RESET_ELEV) / tanHalf, radius / (tanHalf * aspect)) * 1.12;
  }

  function reset(seconds = 1.6) {
    if (dirty) rebuild();
    const target = new THREE.Vector3(0, 0, 0);
    const dist = clamp(fitDistance(extent), 700, 2600);
    const pos = framePosition(target, dist, RESET_ELEV, new THREE.Vector3());
    controls.flyTo(pos, target, seconds);
    engine.wake(seconds + 0.5);
  }

  function positionOf(sel, out) {
    if (!sel) return false;
    if (dirty) rebuild();
    switch (sel.kind) {
      case 'galaxy': out.set(0, 0, 0); return true;
      case 'arm': {
        const a = arms.get(sel.armKey);
        if (!a) return false;
        out.copy(a.sessions ? a.center : a.tip);
        return true;
      }
      case 'session': case 'event': {
        const n = nodes.get(sel.sid);
        if (!n) return false;
        out.copy(n.pos);
        return true;
      }
      case 'file': case 'folder': case 'ship': case 'compaction': {
        const n = nodes.get(sel.sid);
        if (!n) return false;
        const full = lod.get(sel.sid);
        if (full) {
          if ((sel.kind === 'file' || sel.kind === 'folder') && full.planets.getPosition(sel.id, out)) return true;
          if (sel.kind === 'ship' && full.ships.getAgentPosition(sel.id, out)) return true;
          if (sel.kind === 'compaction' && full.blackHole.getPosition(out)) { full.root.localToWorld(out); return true; }
        }
        out.copy(n.pos);
        return true;
      }
      default: return false;
    }
  }

  function tryDetailFocus(sel, seconds) {
    const full = lod.get(sel.sid);
    if (!full) return false;
    const p = new THREE.Vector3();
    let ok = false;
    if (sel.kind === 'file' || sel.kind === 'folder') ok = full.planets.getPosition(sel.id, p);
    else if (sel.kind === 'ship') ok = full.ships.getAgentPosition(sel.id, p);
    else if (sel.kind === 'compaction') { ok = full.blackHole.getPosition(p); if (ok) full.root.localToWorld(p); }
    if (!ok) return false;
    controls.flyTo(framePosition(p, DETAIL_DIST, SESSION_ELEV, new THREE.Vector3()), p, seconds);
    engine.wake(seconds + 0.5);
    return true;
  }

  function focus(sel, o = {}) {
    const seconds = o.seconds ?? 1.6;
    if (!sel || sel.kind === 'galaxy') { pending = null; reset(seconds); return; }
    if (dirty) rebuild();
    if (sel.kind === 'codex' || sel.kind === 'me') {
      pending = null;
      const target = center.codexPos.clone().lerp(center.mePos, 0.5);
      controls.flyTo(framePosition(target, 95, (28 * Math.PI) / 180, new THREE.Vector3()), target, seconds);
      engine.wake(seconds + 0.5);
      return;
    }
    if (sel.kind === 'arm') {
      const a = arms.get(sel.armKey);
      if (!a) return;
      const target = (a.sessions ? a.center : a.tip).clone();
      const dist = clamp(fitDistance(Math.max(120, a.radius)) * 0.8, 250, 2600);
      controls.flyTo(framePosition(target, dist, (45 * Math.PI) / 180, new THREE.Vector3()), target, seconds);
      engine.wake(seconds + 0.5);
      pending = null;
      return;
    }
    const n = sel.sid ? nodes.get(sel.sid) : null;
    if (!n) return;
    if (sel.kind === 'session' || sel.kind === 'event' || sel.id == null) {
      pending = null;
      const target = n.pos.clone();
      controls.flyTo(framePosition(target, SESSION_DIST, SESSION_ELEV, new THREE.Vector3()), target, seconds);
      engine.wake(seconds + 0.5);
      return;
    }
    // Detail inside a system: the system must be full first (promoted next frame).
    if (!tryDetailFocus(sel, seconds)) {
      const target = n.pos.clone();
      controls.flyTo(framePosition(target, SESSION_DIST * 0.6, SESSION_ELEV, new THREE.Vector3()), target, seconds);
      pending = { sel: { kind: sel.kind, sid: sel.sid, id: sel.id }, until: lastT + 2.5, seconds: Math.max(0.8, seconds * 0.6) };
      engine.wake(seconds + 0.5);
    }
  }

  function parentOf(sel) {
    if (!sel) return null;
    switch (sel.kind) {
      case 'galaxy': return null;
      case 'arm': return { kind: 'galaxy' };
      case 'codex': case 'me': return { kind: 'galaxy' };
      case 'session': {
        const rec = store.get(sel.sid);
        return rec?.arm?.key ? { kind: 'arm', armKey: rec.arm.key } : { kind: 'galaxy' };
      }
      default:
        return sel.sid ? { kind: 'session', sid: sel.sid } : { kind: 'galaxy' };
    }
  }

  function back() {
    const parent = parentOf(store.selection);
    if (parent) store.select(parent, { fly: true });
    return parent;
  }

  // ------------------------------------------------------------- read-outs

  function view() {
    const d = camera.position.distanceTo(controls.target);
    const level = d > LEVEL.GALAXY ? 'galaxy' : d > LEVEL.ARM ? 'arm' : d > LEVEL.SYSTEM ? 'system' : 'close';
    // Arm under the camera's target: the arm of the nearest system to it.
    let armKey = null, bestD = Infinity;
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      const dd = n.pos.distanceToSquared(controls.target);
      if (dd < bestD) { bestD = dd; armKey = n.armKey; }
    }
    if (bestD > 400 * 400) armKey = null;
    return { level, focus: store.selection ?? null, distance: d, armKey };
  }

  function quasars() {
    const out = quasarsOut;
    out.length = quasarN;
    for (let i = 0; i < quasarN; i++) out[i] = quasarList[i];
    return out;
  }
  const quasarsOut = [];

  function minimap() {
    if (dirty) rebuild();
    minimapOut.radius = extent;
    miniSystems.length = 0;
    let k = 0;
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      if (!n.visible) continue;
      let m = miniPool[k];
      if (!m) { m = { sid: '', x: 0, z: 0, mode: '' }; miniPool[k] = m; }
      k++;
      m.sid = n.sid; m.x = n.pos.x; m.z = n.pos.z; m.mode = n.rec.state?.mode ?? 'dead';
      miniSystems.push(m);
    }
    miniView.x = controls.target.x;
    miniView.z = controls.target.z;
    miniView.yaw = currentAzimuth(controls.target);
    const d = camera.position.distanceTo(controls.target);
    miniView.span = 2 * d * Math.tan((camera.fov * Math.PI) / 360) * (camera.aspect || 1);
    return minimapOut;
  }
  const miniPool = [];

  function stats() {
    const fps = engine.stats?.fps ?? lastFps;
    lastFps = fps;
    return {
      full: lod.count,
      impostors: impostors.count,
      quasars: quasarN,
      links: links.count,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps,
      rate: engine.stats?.rate ?? 0,
      hint: rateHint,
      markers: beacons.markers,
    };
  }

  // ------------------------------------------------------------- store wiring

  const offs = [];
  const on = (type, fn) => { if (typeof store.on === 'function') offs.push(store.on(type, fn)); };
  on('session', (rec) => {
    const n = rec && nodes.get(rec.id);
    if (n && !dirty && n.placeSig === placeSig(rec)) n.rec = rec;   // in place: no rebuild
    else dirty = true;
    engine.wake(0.5);
  });
  on('sessions', () => { dirty = true; engine.wake(0.5); });
  on('ready', () => { dirty = true; });
  on('settings', () => { dirty = true; spendLens = !!store.settings?.render?.spend; });
  on('time', () => { engine.wake(0.5); });
  on('needs-me', (e) => { if (e?.entered) engine.wake(1.5); });
  on('selection', (sel, o) => { if (o?.fly) focus(sel, o?.seconds ? { seconds: o.seconds } : {}); engine.wake(0.5); });

  const offQuality = engine.onQuality?.(() => {
    // Objects don't hot-switch quality (CONTRACT §1): drop full systems; LOD rebuilds them.
    lod.clear();
    dirty = true;
  });

  // First framing: the whole galaxy, immediately.
  rebuild();
  reset(0.01);

  return {
    root,
    layout,
    focus,
    back,
    reset,
    pick,
    positionOf,
    project: (world, out) => { updateView(); return project(world, out); },
    anchors,
    quasars,
    view,
    minimap,
    setMapMode(on) { mapMode = !!on; engine.wake(0.5); },
    setSpendLens(on) { spendLens = !!on; engine.wake(0.5); },
    get spendLens() { return spendLens; },
    get mapMode() { return mapMode; },
    onAfterFrame(fn) { afterFrame.add(fn); return () => afterFrame.delete(fn); },
    stats,
    /** performance.now() of the first frame a session's quasar beacon was drawn (QA latency proof). */
    beaconShownAt: (sid) => beaconShownAt.get(sid) ?? null,
    /** Knowledge list for the Codex (GET /api/knowledge items); `quiet` skips the grow-in. */
    setKnowledge(items, opts) { center.setKnowledge(items, opts); engine.wake(1); },
    /** A gold beam from a session's system to the Codex (it just saved knowledge). */
    beamFrom(sid) {
      const n = nodes.get(sid);
      if (!n) return false;
      center.beam(n.pos);
      engine.wake(3);
      return true;
    },
    center,
    sky,
    constellations,
    /** Full StarSystem for a session, or null (read-only use: LENS/QA). */
    system: (sid) => lod.get(sid),
    dispose() {
      offFrame();
      for (const off of offs) { try { off?.(); } catch { /* ignore */ } }
      offQuality?.();
      if (hoverTimer) clearTimeout(hoverTimer);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      renderer.info.autoReset = true;
      lod.dispose(); beacons.dispose(); crashBeacons.dispose(); links.dispose(); impostors.dispose(); core.dispose(); disk.dispose(); center.dispose(); sky.dispose(); constellations.dispose();
      engine.scene.remove(root);
    },
  };
}

function fmtWait(s) {
  if (!(s > 0)) return '0s';
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
