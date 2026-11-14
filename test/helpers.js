import { createECDH, createHash, createHmac } from 'node:crypto';
import { Tether } from '../src/server.js';
import { TetherClient } from '../src/client.js';
import {
  TOKEN_HEADER,
  ERROR_HEADER,
  b64u,
  unb64u,
  hex,
  digestInput,
  epochInput,
  reqInput,
  beatInput,
  formatToken,
  runProgram,
} from '../src/core.js';

export const ORIGIN = 'http://app.test';

// Stand-ins for environment probes: the same pure function on both sides.
export const probes = {
  alpha: (arg) => Math.imul(arg, 0x9e3779b1) >>> 0,
  beta: (arg) => (arg ^ (arg >>> 7) ^ 0x5bd1e995) >>> 0,
};

/** A server, a fake clock, and an in-process fetch that routes to the server. */
export function harness(opts = {}) {
  const clock = { t: 1_700_000_000_000 };
  const now = () => clock.t;
  const events = [];
  const tether = new Tether({
    now,
    probes,
    onEvent: (type, detail) => events.push({ type, ...detail }),
    ...opts,
  });

  const json = (status, obj, headers) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const fetchImpl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(new URL(input, ORIGIN), init);
    const url = new URL(req.url);
    const body = Buffer.from(await req.arrayBuffer());
    if (url.pathname === '/__tether/mint') {
      const out = await tether.mint(JSON.parse(body.toString('utf8')), {});
      return json(out.ok ? 200 : 403, out);
    }
    if (url.pathname === '/__tether/beat') {
      const out = tether.beat(JSON.parse(body.toString('utf8')));
      return json(out.ok ? 200 : 401, out);
    }
    const result = tether.verify({
      token: req.headers.get(TOKEN_HEADER),
      method: req.method,
      target: url.pathname + url.search,
      body,
    });
    if (!result.ok) return json(401, result, { [ERROR_HEADER]: result.error });
    return json(200, { ok: true, gid: result.gid, epoch: result.epoch, ctr: result.ctr });
  };

  const client = (extra = {}) =>
    new TetherClient({
      base: `${ORIGIN}/__tether`,
      fetch: fetchImpl,
      probes,
      now,
      autoBeat: false,
      sleep: async (ms) => {
        clock.t += ms;
      },
      ...extra,
    });

  return { tether, clock, events, fetchImpl, client };
}

// --- A second, independent implementation of the client side ----------------
// Written from the spec with node:crypto, with the key in the clear. It plays
// the attacker who has fully reverse engineered the page, and doubles as an
// interop check on the wire format.

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const sha256 = (data) => createHash('sha256').update(data).digest();

/** Mint through `send` (a function from the mint message to the mint response). */
export async function rawMint(send, probeImpl = probes) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const mint = await send({ pub: b64u(ecdh.getPublicKey()) });
  if (!mint.ok) return { mint, gen: null };
  const seed = ecdh.computeSecret(unb64u(mint.pub));
  const challenge = unb64u(mint.challenge);
  const out = runProgram(mint.program, challenge, probeImpl);
  const key = hmac(seed, epochInput(0, challenge, out));
  return { mint, gen: { gid: mint.gid, epoch: 0, key } };
}

export function rawToken(gen, ctr, method, target, body = '') {
  const digest = sha256(digestInput(method, target, hex(sha256(body))));
  const mac = hmac(gen.key, reqInput(gen.epoch, ctr, digest));
  return formatToken({ gid: gen.gid, epoch: gen.epoch, ctr, mac });
}

export function rawBeatMessage(gen) {
  return { gid: gen.gid, epoch: gen.epoch, mac: b64u(hmac(gen.key, beatInput(gen.epoch))) };
}

/** Apply a beat response, returning the generator for the next epoch. */
export function rawAdvance(gen, response, probeImpl = probes) {
  const challenge = unb64u(response.challenge);
  const out = runProgram(response.program, challenge, probeImpl);
  const key = hmac(gen.key, epochInput(response.epoch, challenge, out));
  return { gid: gen.gid, epoch: response.epoch, key };
}
