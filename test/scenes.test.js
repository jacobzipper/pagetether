import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { OP } from '../src/core.js';
import { generateScene, validScene, loadPool, sceneDigest, digestToHex, digestFromHex } from '../src/scenes.js';
import { harness, fakeEngine, fakePool, rawMint, rawToken, rawBeatMessage, rawAdvance, ORIGIN } from './helpers.js';

const pool = fakePool(12);
const noEngine = () => [0, 0]; // what a DOM without layout amounts to: the same answer for everything
const sceneOps = (program) => program.ops.filter((ins) => ins[0] === OP.SCENE);

test('the generator only emits scenes the renderer accepts', () => {
  const rand32 = () => randomBytes(4).readUInt32BE(0);
  for (let i = 0; i < 500; i++) assert.ok(validScene(generateScene(rand32)));
});

test('a scene cannot carry strings, escapes or anything that fetches', () => {
  const t = ['div.r', ['div.a']];
  assert.ok(validScene({ t, c: '.r{width:10px}' }));
  for (const c of ['.r{background:url(//x/y)}', '@import url(x);', '.r::after{content:"x"}', ".r{font-family:'x'}", '.r{width:1\\70x}', '@font-face{}', 'x'.repeat(9000)]) {
    assert.equal(validScene({ t, c }), false, c.slice(0, 30));
  }
  for (const bad of [['script'], ['div.r', ['img']], ['div.r', 'text'], ['div.TOOLONG'], null]) {
    assert.equal(validScene({ t: bad, c: '' }), false);
  }
  let deep = ['div'];
  for (let i = 0; i < 8; i++) deep = ['div', deep];
  assert.equal(validScene({ t: deep, c: '' }), false);
  assert.equal(validScene({ t: ['div.r', ...Array.from({ length: 64 }, () => ['div'])], c: '' }), false);
});

test('pools are checked on load', () => {
  assert.equal(loadPool(pool).length, 12);
  assert.equal(loadPool({ scenes: pool }).length, 12);
  assert.throws(() => loadPool([{ ...pool[0], d: 'nothex' }]), TypeError);
  assert.throws(() => loadPool([{ ...pool[0], c: 'a{b:url(x)}' }]), TypeError);
  assert.throws(() => loadPool('nope'), TypeError);
  const d = sceneDigest([1, 2, 3]);
  assert.deepEqual(digestFromHex(digestToHex(d)), d);
  assert.notDeepEqual(sceneDigest([1, 2, 3]), sceneDigest([1, 3, 2]));
  assert.notDeepEqual(sceneDigest([0]), sceneDigest([0, 0]));
});

test('a page with an engine keeps working across epochs', async () => {
  const h = harness({ scenes: pool });
  const client = h.client({ scenes: fakeEngine });
  for (let epoch = 0; epoch < 4; epoch++) {
    assert.equal((await client.fetch(`${ORIGIN}/api/items?e=${epoch}`)).status, 200);
    await client.beat();
  }
  assert.equal(client.state.epoch, 4);
});

test('every program carries sceneCount scenes from the pool, without answers', async () => {
  const h = harness({ scenes: pool, sceneCount: 3 });
  const { mint } = await rawMint((m) => h.tether.mint(m), undefined, fakeEngine);
  assert.equal(mint.program.scenes.length, 3);
  assert.equal(sceneOps(mint.program).length, 3);
  assert.equal(new Set(mint.program.scenes.map((s) => s.c)).size, 3);
  for (const scene of mint.program.scenes) assert.deepEqual(Object.keys(scene), ['t', 'c']);
  assert.ok(!JSON.stringify(mint).includes(pool[0].d));
});

test('without scenes configured nothing about the wire changes', async () => {
  const h = harness();
  const { mint } = await rawMint((m) => h.tether.mint(m));
  assert.equal('scenes' in mint.program, false);
  assert.equal(sceneOps(mint.program).length, 0);
});

test('a client with no engine cannot derive a key', async () => {
  const h = harness({ scenes: pool });
  await assert.rejects(h.client().fetch(`${ORIGIN}/api/items`), (err) => err.code === 'program_failed');
});

test('a full port without a rendering engine gets a dead key', async () => {
  const h = harness({ scenes: pool });
  const { gen } = await rawMint((m) => h.tether.mint(m), undefined, noEngine);
  const verdict = h.tether.verify({ token: rawToken(gen, 0, 'GET', '/api/items'), method: 'GET', target: '/api/items' });
  assert.deepEqual(verdict, { ok: false, error: 'bad_mac' });
});

test('a port with an engine in the loop works, and is still capped by the budget', async () => {
  const h = harness({ scenes: pool, budget: 3 });
  const { gen } = await rawMint((m) => h.tether.mint(m), undefined, fakeEngine);
  const results = [0, 1, 2, 3].map((ctr) => h.tether.verify({ token: rawToken(gen, ctr, 'GET', '/a'), method: 'GET', target: '/a' }));
  assert.deepEqual(results.map((r) => r.ok || r.error), [true, true, true, 'over_budget']);
});

test('answers harvested from one pool stop working when the pool is rotated', async () => {
  const h = harness({ scenes: pool });
  // The adversary used a real engine once, and kept the answers.
  const table = new Map(pool.map((entry) => [entry.c, digestFromHex(entry.d)]));
  const fromTable = (scene) => table.get(scene.c) ?? [0, 0];
  const verify = (g) => h.tether.verify({ token: rawToken(g, 0, 'GET', '/a'), method: 'GET', target: '/a' });

  let { gen } = await rawMint((m) => h.tether.mint(m), undefined, fromTable);
  assert.equal(verify(gen).ok, true);
  h.clock.t += 21_000;
  gen = rawAdvance(gen, h.tether.beat(rawBeatMessage(gen)), undefined, fromTable);
  assert.equal(verify(gen).ok, true);

  h.tether.setScenes(fakePool(12, 99));
  h.clock.t += 21_000;
  gen = rawAdvance(gen, h.tether.beat(rawBeatMessage(gen)), undefined, fromTable);
  assert.deepEqual(verify(gen), { ok: false, error: 'bad_mac' });
});

test('rotation does not disturb a page that is already running', async () => {
  const h = harness({ scenes: pool });
  const client = h.client({ scenes: fakeEngine });
  assert.equal((await client.fetch(`${ORIGIN}/api/items`)).status, 200);
  h.tether.setScenes(fakePool(12, 7));
  assert.equal((await client.fetch(`${ORIGIN}/api/items?2`)).status, 200);
  await client.beat();
  assert.equal((await client.fetch(`${ORIGIN}/api/items?3`)).status, 200);
});

test('report mode measures answers without acting on them', async () => {
  const h = harness({ scenes: pool, sceneMode: 'report' });
  const scenesOf = (type) => h.events.filter((e) => e.type === type);

  // A page whose engine disagrees with the pool on everything still works.
  const odd = h.client({ scenes: () => [1, 2] });
  assert.equal((await odd.fetch(`${ORIGIN}/api/items`)).status, 200);
  await odd.beat();
  assert.equal((await odd.fetch(`${ORIGIN}/api/items?2`)).status, 200);
  assert.deepEqual(scenesOf('scene').map((e) => e.ok), [false, false]);
  assert.equal(scenesOf('scene')[0].got, '0000000100000002');

  h.events.length = 0;
  const good = h.client({ scenes: fakeEngine });
  await good.fetch(`${ORIGIN}/api/items`);
  await good.beat();
  assert.deepEqual(scenesOf('scene').map((e) => e.ok), [true, true]);

  // Scenes are sent beside the program, not in it.
  const { mint } = await rawMint((m) => h.tether.mint(m));
  assert.equal(mint.shadow.length, 2);
  assert.equal('scenes' in mint.program, false);
});

test('a page that cannot render reports null in report mode and carries on', async () => {
  const h = harness({ scenes: pool, sceneMode: 'report' });
  const client = h.client();
  assert.equal((await client.fetch(`${ORIGIN}/api/items`)).status, 200);
  await client.beat();
  assert.deepEqual(h.events.filter((e) => e.type === 'scene').map((e) => [e.ok, e.got]), [[false, null], [false, null]]);
});
