// Galaxy layout (GALAXY_CONTRACT §5.2): positions are stable pure functions of
// place + id, sessions keep their spacing, clusters and forks behave.
//
//   node --test tests/galaxy-layout.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./three-resolve.mjs', import.meta.url);
const THREE = await import('three');
const L = await import('../web/src/galaxy/layout.js');

const rec = (id, slot, idx, extra = {}) => ({
  id, arm: { key: `/arm/${slot}`, name: `arm${slot}` }, place: { slot, idx, cluster: null, clusterIdx: 0 }, ...extra,
});

test('arc length inverse matches the spiral', () => {
  const lay = L.createLayout();
  // Numerically integrate the arm and compare with the closed form.
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  let acc = 0;
  lay.armPoint(3, 0, p);
  const N = 4000, S = 2000;
  for (let i = 1; i <= N; i++) {
    lay.armPoint(3, (S * i) / N, q);
    acc += q.distanceTo(p);
    p.copy(q);
  }
  assert.ok(Math.abs(acc - S) < 1, `integrated ${acc} vs ${S}`);
  lay.armPoint(0, 0, p);
  assert.ok(Math.abs(p.length() - L.ARM_A) < 1e-9);
});

test('positions are stable and independent of call order', () => {
  const a = L.createLayout(), b = L.createLayout();
  const recs = Array.from({ length: 30 }, (_, i) => rec(`sid-${i}`, i % 4, Math.floor(i / 4)));
  const pa = recs.map((r) => a.systemPosition(r, new THREE.Vector3()));
  const pb = [...recs].reverse().map((r) => b.systemPosition(r, new THREE.Vector3())).reverse();
  for (let i = 0; i < recs.length; i++) assert.ok(pa[i].distanceTo(pb[i]) < 1e-9);
  // Calling again returns the memo, same values.
  const again = a.systemPosition(recs[7], new THREE.Vector3());
  assert.ok(again.distanceTo(pa[7]) < 1e-12);
});

test('consecutive births on one arm keep at least ~40 units apart', () => {
  const lay = L.createLayout();
  let min = Infinity;
  const prev = new THREE.Vector3(), cur = new THREE.Vector3();
  for (let i = 0; i < 60; i++) {
    lay.systemPosition(rec(`s${i}`, 5, i), cur);
    if (i) min = Math.min(min, cur.distanceTo(prev));
    prev.copy(cur);
  }
  assert.ok(min > 30, `min spacing ${min}`);
  // Everything stays well outside the core landmark.
  lay.systemPosition(rec('first', 5, 0), cur);
  assert.ok(Math.hypot(cur.x, cur.z) > L.CORE_RADIUS + 40);
});

test('worktree clusters ring their anchor; forks lean toward the parent', () => {
  const byId = new Map();
  const lay = L.createLayout({ getRecord: (id) => byId.get(id) ?? null });
  const m0 = rec('w0', 2, 4, { place: { slot: 2, idx: 4, cluster: 'feat', clusterIdx: 0 } });
  const m1 = rec('w1', 2, 9, { place: { slot: 2, idx: 9, cluster: 'feat', clusterIdx: 1 } });
  for (const r of [m0, m1]) { byId.set(r.id, r); lay.note(r); }
  const anchor = lay.clusterAnchor(m1, new THREE.Vector3());
  const p0 = lay.systemPosition(m0, new THREE.Vector3());
  const p1 = lay.systemPosition(m1, new THREE.Vector3());
  const d0 = Math.hypot(p0.x - anchor.x, p0.z - anchor.z);
  assert.ok(Math.abs(d0 - 34) < 1e-6, `ring radius ${d0}`);
  assert.ok(p0.distanceTo(p1) > 30);

  const parent = rec('parent', 1, 3);
  const fork = rec('fork', 1, 8, { forkOf: 'parent' });
  byId.set('parent', parent); byId.set('fork', fork);
  const solo = L.createLayout().systemPosition(rec('fork', 1, 8), new THREE.Vector3());
  const pp = lay.systemPosition(parent, new THREE.Vector3());
  const pf = lay.systemPosition(fork, new THREE.Vector3());
  assert.ok(pf.distanceTo(pp) < solo.distanceTo(pp), 'fork moved toward parent');
});
