import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, ORIGIN, rawMint, rawToken, rawBeatMessage } from './helpers.js';
import { TetherError } from '../src/client.js';
import { OP, runProgram, generateProgram, parseToken, b64u, unb64u, hex } from '../src/core.js';

const ok = async (res) => {
  assert.equal(res.status, 200);
  return res.json();
};

test('a page can call the API, with and without a body', async () => {
  const h = harness();
  const c = h.client();
  const a = await ok(await c.fetch(`${ORIGIN}/api/items?page=2`));
  const b = await ok(
    await c.fetch(`${ORIGIN}/api/search`, { method: 'POST', body: JSON.stringify({ q: 'x' }) }),
  );
  assert.equal(a.gid, b.gid);
  assert.deepEqual([a.ctr, b.ctr], [0, 1]);
  assert.equal(h.tether.size, 1);
});

test('concurrent first requests share one mint', async () => {
  const h = harness();
  const c = h.client();
  const all = await Promise.all(
    Array.from({ length: 10 }, (_, i) => c.fetch(`${ORIGIN}/api/items?i=${i}`).then(ok)),
  );
  assert.equal(new Set(all.map((r) => r.gid)).size, 1);
  assert.deepEqual(all.map((r) => r.ctr).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(h.events.filter((e) => e.type === 'mint').length, 1);
});

test('the key ratchets across epochs', async () => {
  const h = harness();
  const c = h.client();
  await ok(await c.fetch(`${ORIGIN}/api/items`));
  for (let epoch = 1; epoch <= 3; epoch++) {
    await c.beat(); // sleeps (on the fake clock) until the beat window opens
    const r = await ok(await c.fetch(`${ORIGIN}/api/items`));
    assert.equal(r.epoch, epoch);
    assert.equal(r.ctr, 0);
  }
  assert.equal(h.tether.size, 1);
});

test('a page that runs out of budget waits for the next epoch', async () => {
  const h = harness({ budget: 3 });
  const c = h.client();
  const start = h.clock.t;
  const seen = [];
  for (let i = 0; i < 7; i++) seen.push(await ok(await c.fetch(`${ORIGIN}/api/items?i=${i}`)));
  assert.deepEqual(seen.map((r) => r.epoch), [0, 0, 0, 1, 1, 1, 2]);
  // Two refills, each no sooner than beatAfterMs after the last.
  assert.ok(h.clock.t - start >= 2 * h.tether.beatAfterMs);
});

test('a page that slept through its epoch re-mints transparently', async () => {
  const h = harness();
  const c = h.client();
  const first = await ok(await c.fetch(`${ORIGIN}/api/items`));
  h.clock.t += 10 * 60 * 1000;
  const second = await ok(await c.fetch(`${ORIGIN}/api/items`));
  assert.notEqual(first.gid, second.gid);
});

test('the client recovers when the server has forgotten its generator', async () => {
  const h = harness();
  const c = h.client();
  const first = await ok(await c.fetch(`${ORIGIN}/api/items`));
  h.tether.revoke(first.gid);
  const second = await ok(await c.fetch(`${ORIGIN}/api/items`));
  assert.notEqual(first.gid, second.gid);
});

test('a previous-epoch token is honoured only inside the grace window', async () => {
  const h = harness();
  const { gen } = await rawMint((msg) => h.tether.mint(msg));
  h.clock.t += h.tether.beatAfterMs;
  assert.equal(h.tether.beat(rawBeatMessage(gen)).ok, true);

  const verify = (ctr) =>
    h.tether.verify({ token: rawToken(gen, ctr, 'GET', '/api/items'), method: 'GET', target: '/api/items' });
  h.clock.t += h.tether.graceMs;
  assert.equal(verify(0).ok, true);
  h.clock.t += 1;
  assert.equal(verify(1).error, 'stale_epoch');
});

test('the gate decides who may mint', async () => {
  const h = harness({ gate: (ctx) => ctx.allowed === true });
  const send = (context) => (msg) => h.tether.mint(msg, context);
  assert.deepEqual((await rawMint(send({ allowed: false }))).mint, { ok: false, error: 'gate' });
  assert.equal((await rawMint(send({ allowed: true }))).mint.ok, true);
  assert.equal((await h.tether.mint({ pub: 'AAAA' }, { allowed: true })).error, 'malformed');
  await assert.rejects(h.client().fetch(`${ORIGIN}/api/items`), (err) => {
    assert.ok(err instanceof TetherError);
    assert.equal(err.code, 'gate');
    return true;
  });
});

test('token parsing rejects anything off-format', () => {
  const mac = b64u(new Uint8Array(32));
  const gid = b64u(new Uint8Array(16));
  assert.deepEqual(parseToken(`0.${gid}.3.7.${mac}`), { gid, epoch: 3, ctr: 7, mac: new Uint8Array(32) });
  for (const bad of [
    '',
    'nope',
    `1.${gid}.0.0.${mac}`,
    `0.${gid}.0.0`,
    `0.${gid}.-1.0.${mac}`,
    `0.${gid}.01.0.${mac}`,
    `0.${gid}.0.1e3.${mac}`,
    `0.${gid}.0.99999999999.${mac}`,
    `0.short.0.0.${mac}`,
    `0.${gid}.0.0.${b64u(new Uint8Array(31))}`,
    `0.${gid}.0.0.${mac}.extra`,
  ]) {
    assert.equal(parseToken(bad), null, bad);
  }
});

test('the noise program matches its pinned test vector', () => {
  const program = {
    ops: [
      [OP.ADD, 0, 1, 0xdeadbeef],
      [OP.XOR, 2, 3, 0x01234567],
      [OP.ROL, 4, 0, 13],
      [OP.MUL, 5, 0, 0x9e3779b0],
      [OP.MIX, 6, 7, 9],
      [OP.PROBE, 7, 0, 0xcafef00d],
      [OP.ADD, 1, 7, 1],
    ],
    probes: ['double'],
  };
  const challenge = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
  const out = runProgram(program, challenge, { double: (x) => x * 2 });
  assert.equal(hex(out), 'fcd9f9374f3f11816d3f6143555c636a0ff0ce2f8d1d2d02a981c48a321ae64e');
});

test('the noise program is deterministic and sensitive to every input', () => {
  let s = 12345;
  const rand32 = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
  const program = generateProgram(rand32, { probes: ['p'], probeCount: 3 });
  assert.equal(program.ops.filter((i) => i[0] === OP.PROBE).length, 3);
  assert.ok(program.ops.every(([op, a, b]) => op === OP.PROBE || a !== b));

  const challenge = unb64u(b64u(Uint8Array.from({ length: 32 }, (_, i) => i)));
  const honest = { p: (x) => x + 1 };
  const base = hex(runProgram(program, challenge, honest));
  assert.equal(hex(runProgram(program, challenge, honest)), base);

  const flipped = Uint8Array.from(challenge);
  flipped[31] ^= 1;
  assert.notEqual(hex(runProgram(program, flipped, honest)), base);
  assert.notEqual(hex(runProgram(program, challenge, { p: (x) => x + 2 })), base);
  assert.throws(() => runProgram(program, challenge, {}), /unknown probe/);
  assert.throws(() => runProgram({ ops: [[99, 0, 1, 0]] }, challenge), /bad opcode/);
});
