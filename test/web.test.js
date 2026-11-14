import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Tether as WebTether, sha256, hmac } from '../src/web.js';
import { TetherClient } from '../src/client.js';
import { TOKEN_HEADER, hex } from '../src/core.js';
import { probes, rawMint, rawToken, rawBeatMessage, rawAdvance } from './helpers.js';

test('the plain-JS SHA-256 and HMAC agree with node:crypto', () => {
  assert.equal(hex(sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70000]) {
    const data = randomBytes(len);
    assert.equal(hex(sha256(data)), createHash('sha256').update(data).digest('hex'), `sha256 len ${len}`);
    for (const keyLen of [0, 1, 32, 64, 65, 200]) {
      const key = randomBytes(keyLen);
      assert.equal(
        hex(hmac(key, data)),
        createHmac('sha256', key).update(data).digest('hex'),
        `hmac key ${keyLen} len ${len}`,
      );
    }
  }
});

test('the WebCrypto build of the verifier speaks the same protocol', async () => {
  const clock = { t: 1_700_000_000_000 };
  const tether = new WebTether({ now: () => clock.t, probes, budget: 3 });

  // Against the independent node:crypto port of the client...
  let { gen } = await rawMint((msg) => tether.mint(msg));
  const get = (g, ctr, target = '/api/x') =>
    tether.verify({ token: rawToken(g, ctr, 'GET', target), method: 'GET', target });
  assert.equal(get(gen, 0).ok, true);
  assert.equal(get(gen, 0).error, 'replay');
  assert.equal(get(gen, 3).error, 'over_budget');
  assert.equal(tether.verify({ token: rawToken(gen, 1, 'GET', '/api/x'), method: 'GET', target: '/api/y' }).error, 'bad_mac');
  clock.t += tether.beatAfterMs;
  gen = rawAdvance(gen, tether.beat(rawBeatMessage(gen)));
  assert.equal(get(gen, 0).ok, true);
  clock.t += tether.epochMs + tether.graceMs + 1;
  assert.equal(get(gen, 1).error, 'expired');
  assert.equal((await tether.mint({ pub: 'BAAA' })).error, 'malformed');

  // ...and against the real client, wired to it in-process.
  const fetchImpl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    const text = new TextDecoder().decode(body);
    if (url.pathname === '/__tether/mint') return Response.json(await tether.mint(JSON.parse(text)));
    if (url.pathname === '/__tether/beat') return Response.json(tether.beat(JSON.parse(text)));
    const r = tether.verify({ token: req.headers.get(TOKEN_HEADER), method: req.method, target: url.pathname + url.search, body });
    return Response.json(r, { status: r.ok ? 200 : 401 });
  };
  const client = new TetherClient({
    base: 'http://app.test/__tether',
    fetch: fetchImpl,
    probes,
    now: () => clock.t,
    autoBeat: false,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  const epochs = [];
  for (let i = 0; i < 7; i++) {
    const res = await client.fetch(`http://app.test/api/x?i=${i}`, { method: 'POST', body: `n=${i}` });
    assert.equal(res.status, 200);
    epochs.push((await res.json()).epoch);
  }
  assert.deepEqual(epochs, [0, 0, 0, 1, 1, 1, 2]);
});
