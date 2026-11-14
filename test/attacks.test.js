// Each test is one thing an attacker tries after reverse engineering the API.
// The attacker here is as strong as the design allows: they complete a genuine
// mint (so they hold the seed, challenge and program) and have a correct implementation of
// the whole client protocol.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  harness,
  ORIGIN,
  probes,
  rawMint,
  rawToken,
  rawBeatMessage,
  rawAdvance,
} from './helpers.js';
import { TOKEN_HEADER, ERROR_HEADER, parseToken, formatToken } from '../src/core.js';
import { TetherError } from '../src/client.js';

const GET = (h, token, target = '/api/items') => h.tether.verify({ token, method: 'GET', target });

async function minted(opts, probeImpl) {
  const h = harness(opts);
  const { mint, gen } = await rawMint((msg) => h.tether.mint(msg), probeImpl);
  return { h, mint, gen };
}

test('calling the API with no token, or a made-up one, fails', async () => {
  const { h, gen } = await minted();
  assert.equal(GET(h, undefined).error, 'missing');
  assert.equal(GET(h, 'not-a-token').error, 'malformed');

  const real = parseToken(rawToken(gen, 0, 'GET', '/api/items'));
  const forged = formatToken({ ...real, mac: new Uint8Array(32).fill(7) });
  assert.equal(GET(h, forged).error, 'bad_mac');

  const stranger = formatToken({ ...real, gid: 'AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(GET(h, stranger).error, 'unknown_generator');
});

test('a captured token cannot be replayed', async () => {
  const { h, gen } = await minted();
  const token = rawToken(gen, 0, 'GET', '/api/items');
  assert.equal(GET(h, token).ok, true);
  assert.equal(GET(h, token).error, 'replay');
});

test('a token is good for one exact request and nothing else', async () => {
  const { h, gen } = await minted();
  const body = '{"q":"shoes","page":1}';
  const token = rawToken(gen, 0, 'POST', '/api/search?sort=new', body);
  const attempt = (over) =>
    h.tether.verify({ token, method: 'POST', target: '/api/search?sort=new', body, ...over });

  assert.equal(attempt({ target: '/api/search?sort=old' }).error, 'bad_mac');
  assert.equal(attempt({ target: '/api/export' }).error, 'bad_mac');
  assert.equal(attempt({ method: 'PUT' }).error, 'bad_mac');
  assert.equal(attempt({ body: '{"q":"shoes","page":2}' }).error, 'bad_mac');
  // None of that burned the counter: the genuine request still goes through.
  assert.equal(attempt({}).ok, true);
});

test('mint once, hammer forever: the generator dies when the page stops beating', async () => {
  const { h, gen } = await minted();
  assert.equal(GET(h, rawToken(gen, 0, 'GET', '/api/items')).ok, true);
  h.clock.t += h.tether.epochMs + h.tether.graceMs + 1;
  assert.equal(GET(h, rawToken(gen, 1, 'GET', '/api/items')).error, 'expired');
  assert.equal(h.tether.size, 0);
});

test('a generator is capped at its budget, however the requests are sent', async () => {
  const { h, gen } = await minted({ budget: 5 });
  let accepted = 0;
  for (let ctr = 0; ctr < 50; ctr++) {
    if (GET(h, rawToken(gen, ctr, 'GET', `/api/items?i=${ctr}`), `/api/items?i=${ctr}`).ok) accepted++;
  }
  assert.equal(accepted, 5);
  assert.equal(GET(h, rawToken(gen, 5, 'GET', '/api/items')).error, 'over_budget');
});

test('beating early does not refill the budget faster', async () => {
  const { h, gen } = await minted();
  const early = h.tether.beat(rawBeatMessage(gen));
  assert.equal(early.error, 'too_early');
  assert.equal(early.retryAfterMs, h.tether.beatAfterMs);
  h.clock.t += h.tether.beatAfterMs - 1;
  assert.equal(h.tether.beat(rawBeatMessage(gen)).error, 'too_early');
  h.clock.t += 1;
  assert.equal(h.tether.beat(rawBeatMessage(gen)).ok, true);
});

test('a beat needs the current key', async () => {
  const { h, gen } = await minted();
  h.clock.t += h.tether.beatAfterMs;
  const msg = rawBeatMessage({ ...gen, key: Buffer.alloc(32, 1) });
  assert.equal(h.tether.beat(msg).error, 'bad_mac');
  assert.equal(h.tether.beat({ gid: gen.gid, epoch: 0 }).error, 'malformed');
  assert.equal(h.tether.beat(null).error, 'malformed');
});

test('cloning a generator to many workers buys no extra throughput', async () => {
  const { h, gen } = await minted({ budget: 4 });
  const workerA = { ...gen };
  const workerB = { ...gen };
  // Uncoordinated clones collide on counters.
  assert.equal(GET(h, rawToken(workerA, 0, 'GET', '/api/items?a'), '/api/items?a').ok, true);
  assert.equal(GET(h, rawToken(workerB, 0, 'GET', '/api/items?b'), '/api/items?b').error, 'replay');
  // Coordinated clones are just one client sharing one budget.
  let accepted = 1;
  for (let ctr = 1; ctr < 20; ctr++) {
    const w = ctr % 2 ? workerA : workerB;
    if (GET(h, rawToken(w, ctr, 'GET', '/api/items')).ok) accepted++;
  }
  assert.equal(accepted, 4);
});

test('a stolen snapshot that surfaces after the page moved on kills the generator', async () => {
  const { h, gen } = await minted();
  const snapshot = { ...gen };

  h.clock.t += h.tether.beatAfterMs;
  const page = rawAdvance(gen, h.tether.beat(rawBeatMessage(gen)));
  assert.equal(GET(h, rawToken(page, 0, 'GET', '/api/items')).ok, true);

  h.clock.t += h.tether.graceMs + 1;
  assert.equal(h.tether.beat(rawBeatMessage(snapshot)).error, 'fork');
  assert.ok(h.events.some((e) => e.type === 'fork' && e.gid === gen.gid));
  // Both holders are now out; the honest page re-mints, the thief starts over.
  assert.equal(GET(h, rawToken(page, 1, 'GET', '/api/items')).error, 'unknown_generator');
});

test('a beat retried after a lost response gets the same answer, not a fork', async () => {
  const { h, gen } = await minted();
  h.clock.t += h.tether.beatAfterMs;
  const first = h.tether.beat(rawBeatMessage(gen));
  h.clock.t += 1000;
  const retry = h.tether.beat(rawBeatMessage(gen));
  assert.deepEqual(retry, first);
  const page = rawAdvance(gen, retry);
  assert.equal(GET(h, rawToken(page, 0, 'GET', '/api/items')).ok, true);
});

test('a port that cannot answer the probes derives the wrong key, silently', async () => {
  const { h, gen } = await minted({}, { alpha: () => 0, beta: () => 0 });
  // No error at derivation time, nothing to tell which probe was off.
  assert.equal(GET(h, rawToken(gen, 0, 'GET', '/api/items')).error, 'bad_mac');
});

test('a client with no probes at all cannot even start', async () => {
  const h = harness();
  const c = h.client({ probes: {} });
  await assert.rejects(c.fetch(`${ORIGIN}/api/items`), (err) => {
    assert.ok(err instanceof TetherError);
    assert.equal(err.code, 'program_failed');
    return true;
  });
});

test('a wrong probe answer in a later epoch ends the session there', async () => {
  const { h, gen } = await minted();
  h.clock.t += h.tether.beatAfterMs;
  const response = h.tether.beat(rawBeatMessage(gen));
  const drifted = rawAdvance(gen, response, { ...probes, beta: (x) => x });
  assert.equal(GET(h, rawToken(drifted, 0, 'GET', '/api/items')).error, 'bad_mac');
});

test('unauthenticated noise cannot burn counters or revoke a generator', async () => {
  const { h, gen } = await minted({ budget: 3 });
  const real = parseToken(rawToken(gen, 0, 'GET', '/api/items'));
  for (let ctr = 0; ctr < 3; ctr++) {
    const junk = formatToken({ ...real, ctr, mac: new Uint8Array(32).fill(ctr + 1) });
    assert.equal(GET(h, junk).error, 'bad_mac');
  }
  h.clock.t += h.tether.beatAfterMs + h.tether.graceMs + 1;
  assert.equal(h.tether.beat({ ...rawBeatMessage(gen), epoch: 7 }).error, 'stale_epoch');
  for (let ctr = 0; ctr < 3; ctr++) {
    assert.equal(GET(h, rawToken(gen, ctr, 'GET', '/api/items')).ok, true);
  }
});

test('THE LIMIT: a full port with correct probe answers works, at the budgeted rate', async () => {
  // This attack succeeds and is meant to. pagetether does not make a client
  // unforgeable; it makes every stream of requests cost a live, gated,
  // rate-capped generator that has to be run continuously.
  const h = harness({ budget: 10 });
  let { gen } = await rawMint(async (msg) => {
    const res = await h.fetchImpl(`${ORIGIN}/__tether/mint`, {
      method: 'POST',
      body: JSON.stringify(msg),
    });
    return res.json();
  });

  const start = h.clock.t;
  let accepted = 0;
  for (let epoch = 0; epoch < 5; epoch++) {
    for (let ctr = 0; ctr < 25; ctr++) {
      const target = `/api/items?e=${epoch}&i=${ctr}`;
      const r = await h.fetchImpl(`${ORIGIN}${target}`, {
        headers: { [TOKEN_HEADER]: rawToken(gen, ctr, 'GET', target) },
      });
      if (r.status === 200) accepted++;
      else assert.equal(r.headers.get(ERROR_HEADER), 'over_budget');
    }
    h.clock.t += h.tether.beatAfterMs;
    gen = rawAdvance(gen, h.tether.beat(rawBeatMessage(gen)));
  }
  assert.equal(accepted, 50); // 5 epochs x budget, out of 125 attempts
  const perSecond = accepted / ((h.clock.t - start) / 1000);
  assert.ok(perSecond <= h.tether.budget / (h.tether.beatAfterMs / 1000));
});
