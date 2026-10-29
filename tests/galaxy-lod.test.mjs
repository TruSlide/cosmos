// Galaxy LOD (GALAXY_CONTRACT §5.5): cap, one construction per frame,
// required systems always get a slot, 48/32 px hysteresis, 2 s demotion delay.
// Real Gate 1 StarSystems are built (three runs headless; nothing is rendered).
//
//   node --test tests/galaxy-lod.test.mjs
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./three-resolve.mjs', import.meta.url);
const THREE = await import('three');
const { Lod } = await import('../web/src/galaxy/lod.js');

function fixture(n) {
  const ctx = { camera: new THREE.PerspectiveCamera(), quality: 'low', resolution: new THREE.Vector2(800, 600),
    starfieldCube: null, noiseTex: null, renderer: null };
  const sids = Array.from({ length: n }, (_, i) => `s${i}`);
  const store = {
    get: (sid) => (sids.includes(sid) ? { id: sid } : null),
    systemState: (sid, opts, out) => Object.assign(out, {
      v: 1, id: sid, now: 1000, mode: 'working', idleFor: 0, activity: 0.5, contextFill: 0.3, tokens: { total: 1e5 },
    }),
  };
  const cands = sids.map((sid) => ({ sid, score: 0, px: 0, required: false, eligible: false, pos: new THREE.Vector3(), camDist: 500 }));
  const set = (i, px, required = false) => {
    const c = cands[i];
    c.px = px; c.required = required; c.eligible = px >= 48; c.score = required ? 1e9 : px;
  };
  return { ctx, store, cands, set, root: new THREE.Group() };
}

test('cap and one construction per frame', () => {
  const f = fixture(10);
  const lod = new Lod(f.root, f.ctx, { store: f.store, maxFull: () => 3 });
  for (let i = 0; i < 10; i++) f.set(i, 100 + i);
  lod.update(f.cands, 10, 0.016, 0);
  assert.equal(lod.count, 1, 'one per frame');
  for (let k = 1; k < 6; k++) lod.update(f.cands, 10, 0.016, k * 0.016);
  assert.equal(lod.count, 3, 'capped');
  // Highest scores win.
  assert.ok(lod.get('s9') && lod.get('s8') && lod.get('s7'));
  lod.dispose();
});

test('hysteresis and demotion delay', () => {
  const f = fixture(2);
  const lod = new Lod(f.root, f.ctx, { store: f.store, maxFull: () => 4 });
  f.set(0, 40);                         // below promote: stays an impostor
  lod.update(f.cands, 1, 0.016, 0);
  assert.equal(lod.count, 0);
  f.set(0, 60);
  lod.update(f.cands, 1, 0.016, 0.1);
  assert.equal(lod.count, 1);
  f.set(0, 40);                         // between 32 and 48: kept
  lod.update(f.cands, 1, 0.016, 0.2);
  assert.equal(lod.count, 1);
  f.set(0, 20);                         // below demote: waits 2 s
  lod.update(f.cands, 1, 0.016, 0.3);
  lod.update(f.cands, 1, 0.016, 2.0);
  assert.equal(lod.count, 1, 'still full before 2 s');
  lod.update(f.cands, 1, 0.016, 2.4);
  assert.equal(lod.count, 0, 'demoted after 2 s');
  lod.dispose();
});

test('a required system always gets a slot', () => {
  const f = fixture(4);
  const lod = new Lod(f.root, f.ctx, { store: f.store, maxFull: () => 2 });
  f.set(0, 200); f.set(1, 190);
  for (let k = 0; k < 3; k++) lod.update(f.cands, 4, 0.016, k * 0.016);
  assert.equal(lod.count, 2);
  f.set(3, 0, true);                    // selected, far away
  for (let k = 3; k < 6; k++) lod.update(f.cands, 4, 0.016, k * 0.016);
  assert.ok(lod.get('s3'), 'selected promoted');
  assert.ok(lod.count <= 2, `cap held (${lod.count})`);
  assert.ok(lod.fade('s3') > 0 && lod.fade('s3') <= 1);
  lod.dispose();
});
