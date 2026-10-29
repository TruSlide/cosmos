// Galaxy layout: where every arm and every star system lives (GALAXY_CONTRACT §5.2).
//
// Positions are pure functions of a record's `place` (assigned once by the
// server and persisted in cache/layout.json) and its id, so a system never
// moves: not when it idles, not across restarts. Idle is shown by cooling,
// never by motion (ART_DIRECTION §3.1).
//
// Arms are logarithmic spirals r = A·e^(b·φ) (b = tan 13°), one per slot,
// slot angle offset slot·2π/12. Sessions sit at arc length s along the arm,
// measured from its start. For a log spiral the arc length from φ = 0 is
//   s(φ) = A·√(1+b²)/b · (e^(bφ) − 1)
// so the inverse is closed-form: e^(bφ) = 1 + s·b / (A·√(1+b²)).

import * as THREE from 'three';
import { hash01 } from '../lib/math.js';

export const ARM_SLOTS = 12;
export const ARM_A = 150;                       // r at the arm's start
export const ARM_B = Math.tan((13 * Math.PI) / 180);
export const ARM_TURNS = 1.25;                  // drawn length cap (sessions past it keep going)
export const CORE_RADIUS = 90;
export const SESSION_S0 = 120;                  // arc length of idx 0
export const SESSION_DS = 46;                   // arc length between births
export const CLUSTER_PUSH = 70;                 // worktree cluster anchor distance from the arm
export const FORK_PULL = 14;                    // forks lean this far toward their parent
const K = Math.sqrt(1 + ARM_B * ARM_B);
const PHI_MAX = ARM_TURNS * 2 * Math.PI;
const S_MAX = (ARM_A * K / ARM_B) * (Math.exp(ARM_B * PHI_MAX) - 1);

/** Arm slot angle offset. */
export function slotAngle(slot) {
  return ((((slot | 0) % ARM_SLOTS) + ARM_SLOTS) % ARM_SLOTS) * (2 * Math.PI / ARM_SLOTS);
}

/** φ (radians along the spiral from its start) for arc length s. */
export function phiAt(s) {
  return Math.log(1 + Math.max(0, s) * ARM_B / (ARM_A * K)) / ARM_B;
}

/** Fallback slot when a record has no place yet (server assigns the real one). */
export function fallbackSlot(armKey) {
  return Math.floor(hash01(armKey ?? '') * ARM_SLOTS);
}

/**
 * @param {{ getRecord?: (sid: string) => object | null }} [opts]
 *   getRecord resolves a fork's parent (and a cluster's first member).
 */
export function createLayout(opts = {}) {
  const getRecord = opts.getRecord ?? (() => null);
  // sid -> { key, pos } memo; key covers everything the position depends on.
  const memo = new Map();
  // `${armKey}|${cluster}` -> smallest member idx seen (the cluster's first member).
  const clusterFirst = new Map();
  const _t = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _p = new THREE.Vector3();

  function armPoint(slot, s, out = new THREE.Vector3()) {
    const phi = phiAt(s);
    const r = ARM_A * Math.exp(ARM_B * phi);
    const th = slotAngle(slot) + phi;
    return out.set(r * Math.cos(th), 0, r * Math.sin(th));
  }

  /** Unit tangent (direction of growing s) at arc length s, in XZ. */
  function armTangent(slot, s, out = new THREE.Vector3()) {
    const th = slotAngle(slot) + phiAt(s);
    // d/dθ of r(cosθ, sinθ) with r' = b·r  →  (b cosθ − sinθ, b sinθ + cosθ)
    const c = Math.cos(th), sn = Math.sin(th);
    return out.set(ARM_B * c - sn, 0, ARM_B * sn + c).normalize();
  }

  /** Unit in-plane normal pointing away from the core. */
  function armOutward(slot, s, out = new THREE.Vector3()) {
    armTangent(slot, s, out);
    // Rotate the tangent −90° about +Y: (x, z) → (z, −x) points outward for a CCW spiral.
    return out.set(out.z, 0, -out.x);
  }

  /** Drawn arm length in arc-length units (1.25 turns). */
  function armLength() {
    return S_MAX;
  }

  /** `samples` points along the arm from s0 to s1 (defaults: whole drawn arm). */
  function armCurve(slot, samples = 64, s0 = 0, s1 = S_MAX) {
    const pts = [];
    for (let i = 0; i < samples; i++) pts.push(armPoint(slot, s0 + (s1 - s0) * (i / (samples - 1))));
    return pts;
  }

  function slotOf(rec) {
    const s = rec?.place?.slot;
    return Number.isInteger(s) ? s : fallbackSlot(rec?.arm?.key);
  }
  function idxOf(rec) {
    const i = rec?.place?.idx;
    return Number.isFinite(i) ? i : Math.floor(hash01(`${rec?.id}:idx`) * 24);
  }
  /** Arc length of a session's birth slot on its arm. */
  function sessionS(rec) {
    return SESSION_S0 + idxOf(rec) * SESSION_DS;
  }

  /** Tell the layout about a record so clusters know their first member. */
  function note(rec) {
    const c = rec?.place?.cluster;
    if (c == null) return;
    const k = `${rec.arm?.key}|${c}`;
    const idx = idxOf(rec);
    const cur = clusterFirst.get(k);
    if (cur === undefined || idx < cur) {
      clusterFirst.set(k, idx);
      // Every member of this cluster moves with the anchor: drop their memos.
      for (const [sid, m] of memo) if (m.cluster === k) memo.delete(sid);
    }
  }

  /** Worktree cluster anchor: pushed outward from the arm at the first member's s. */
  function clusterAnchor(rec, out = new THREE.Vector3()) {
    const c = rec?.place?.cluster;
    if (c == null) return null;
    note(rec);
    const first = clusterFirst.get(`${rec.arm?.key}|${c}`) ?? idxOf(rec);
    const slot = slotOf(rec);
    const s = SESSION_S0 + first * SESSION_DS;
    armPoint(slot, s, out);
    armOutward(slot, s, _n);
    out.addScaledVector(_n, CLUSTER_PUSH);
    out.y = (hash01(`${rec.arm?.key}|${c}|y`) - 0.5) * 10;
    return out;
  }

  function computePosition(rec, out, depth) {
    const slot = slotOf(rec);
    const cluster = rec?.place?.cluster;
    if (cluster != null) {
      clusterAnchor(rec, out);
      const ci = Math.max(0, rec.place.clusterIdx | 0);
      // Rings of 6 members. Radii are wider than the contract's 22 + 8·ring so
      // two full StarSystems (bounding radius ~20) in one cluster don't overlap.
      const ring = Math.floor(ci / 6);
      const j = ci % 6;
      const R = 34 + 26 * ring;
      const a = hash01(`${rec.arm?.key}|${cluster}`) * 2 * Math.PI + j * (Math.PI / 3) + ring * 0.52;
      out.x += R * Math.cos(a);
      out.z += R * Math.sin(a);
      out.y += (hash01(`${rec.id}y`) - 0.5) * 8;
      return out;
    }
    const s = sessionS(rec);
    armPoint(slot, s, out);
    armOutward(slot, s, _n);
    const side = hash01(rec.id) < 0.5 ? -1 : 1;
    const lat = 14 + 20 * hash01(`${rec.id}:lat`);
    out.addScaledVector(_n, side * lat);
    out.y = (hash01(`${rec.id}y`) - 0.5) * 16;
    // Forks lean toward their parent so the lineage reads without Map mode.
    if (rec.forkOf && depth < 3) {
      const parent = getRecord(rec.forkOf);
      if (parent && parent.id !== rec.id) {
        computePosition(parent, _p, depth + 1);
        _t.subVectors(_p, out);
        const d = _t.length();
        if (d > 1e-3) out.addScaledVector(_t, Math.min(FORK_PULL, d * 0.3) / d);
      }
    }
    return out;
  }

  function keyOf(rec) {
    const p = rec?.place;
    const parent = rec?.forkOf ? getRecord(rec.forkOf) : null;
    return `${p?.slot}|${p?.idx}|${p?.cluster}|${p?.clusterIdx}|${rec?.arm?.key}|${parent ? parent.place?.idx ?? 'x' : '-'}`;
  }

  /** Stable world position of a session's system. Memoized; no allocation on a hit. */
  function systemPosition(rec, out = new THREE.Vector3()) {
    const key = keyOf(rec);
    let m = memo.get(rec.id);
    if (!m || m.key !== key) {
      if (rec?.place?.cluster != null) note(rec);
      m = { key, pos: new THREE.Vector3(), cluster: rec?.place?.cluster != null ? `${rec.arm?.key}|${rec.place.cluster}` : null };
      computePosition(rec, m.pos, 0);
      memo.set(rec.id, m);
    }
    return out.copy(m.pos);
  }

  /** Nearest arm point to a session (its birth point on the arm). */
  function sessionArmPoint(rec, out = new THREE.Vector3()) {
    return armPoint(slotOf(rec), sessionS(rec), out);
  }

  function forget(sid) {
    memo.delete(sid);
  }

  return {
    coreRadius: CORE_RADIUS,
    armPoint, armTangent, armOutward, armCurve, armLength,
    systemPosition, clusterAnchor, sessionArmPoint, sessionS, slotOf, note, forget,
  };
}
