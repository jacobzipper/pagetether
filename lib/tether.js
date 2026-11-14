// pagetether verifier: mints generators, runs the epoch ratchet, checks tokens.
// Runtime-agnostic: the caller supplies hashing, randomness and key exchange.
// Use src/server.js on Node and src/web.js on WebCrypto runtimes. The protocol
// is described in docs/DESIGN.md.

import {
  VERSION,
  b64u,
  unb64u,
  hex,
  digestInput,
  epochInput,
  reqInput,
  beatInput,
  parseToken,
  runProgram,
  generateProgram,
} from './core.js';

/**
 * @typedef {object} Primitives
 * @property {(key: Uint8Array, data: Uint8Array) => Uint8Array} hmac    HMAC-SHA-256
 * @property {(data: Uint8Array) => Uint8Array} sha256
 * @property {(n: number) => Uint8Array} random   n bytes from a CSPRNG, in a fresh buffer
 * @property {(a: Uint8Array, b: Uint8Array) => boolean} equal   constant-time, equal lengths
 * @property {(clientPub: Uint8Array) => {pub: Uint8Array, secret: Uint8Array}
 *            | Promise<{pub: Uint8Array, secret: Uint8Array}>} ecdh
 *           one ephemeral P-256 exchange; throws if clientPub is not a valid point
 */

const encoder = new TextEncoder();
const bytes = (body) => (typeof body === 'string' ? encoder.encode(body) : (body ?? new Uint8Array(0)));
const fail = (error, extra) => ({ ok: false, error, ...extra });

export class TetherCore {
  #p;
  #gens = new Map();
  #lastSweep = 0;

  /**
   * @param {Primitives} primitives  hashing, randomness and key exchange for this runtime
   * @param {object} [opts]
   * @param {number} [opts.epochMs]      an epoch key dies this long after it was issued
   * @param {number} [opts.beatAfterMs]  earliest moment a page may trade it for the next one
   * @param {number} [opts.graceMs]      overlap in which the previous key is still accepted
   * @param {number} [opts.budget]       requests accepted per epoch per generator
   * @param {number} [opts.maxAgeMs]     hard lifetime of a generator
   * @param {number} [opts.maxGenerators] cap on live generators held in memory
   * @param {Record<string, (arg: number) => number>} [opts.probes]
   *        expected probe answers (what a genuine page computes)
   * @param {number} [opts.programLength]
   * @param {number} [opts.probeCount]   probe instructions per program
   * @param {(ctx: any) => boolean | Promise<boolean>} [opts.gate]
   *        decides who may mint; this is where presence is paid for
   * @param {(type: string, detail: object) => void} [opts.onEvent]
   * @param {() => number} [opts.now]
   */
  constructor(primitives, opts = {}) {
    this.#p = primitives;
    this.epochMs = opts.epochMs ?? 30_000;
    this.beatAfterMs = opts.beatAfterMs ?? Math.round((this.epochMs * 2) / 3);
    this.graceMs = opts.graceMs ?? 5_000;
    this.budget = opts.budget ?? 60;
    this.maxAgeMs = opts.maxAgeMs ?? 12 * 60 * 60 * 1000;
    this.maxGenerators = opts.maxGenerators ?? 100_000;
    this.probes = opts.probes ?? {};
    this.programLength = opts.programLength ?? 48;
    this.probeCount = opts.probeCount ?? 4;
    this.gate = opts.gate ?? null;
    this.onEvent = opts.onEvent ?? null;
    this.now = opts.now ?? Date.now;

    if (!(this.beatAfterMs > 0 && this.beatAfterMs <= this.epochMs)) {
      throw new RangeError('beatAfterMs must be in (0, epochMs]');
    }
    if (!Number.isInteger(this.budget) || this.budget < 1) {
      throw new RangeError('budget must be a positive integer');
    }
  }

  get size() {
    return this.#gens.size;
  }

  /**
   * Issue a new generator.
   * @param {{ pub: string, proof?: any }} msg  `pub` is the page's ephemeral
   *        P-256 public key (uncompressed point, base64url). The seed is the
   *        ECDH shared secret, so it never travels and never has to exist as
   *        bytes inside the page.
   * @param {object} [context]  passed to the gate along with `proof`
   */
  async mint(msg, context = {}) {
    let clientPub;
    try {
      clientPub = unb64u(msg?.pub);
    } catch {
      return fail('malformed');
    }
    if (clientPub.length !== 65 || clientPub[0] !== 4) return fail('malformed');
    if (this.gate && !(await this.gate({ ...context, proof: msg.proof }))) {
      this.#emit('reject', { error: 'gate' });
      return fail('gate');
    }
    const now = this.now();
    this.#sweep(now);
    if (this.#gens.size >= this.maxGenerators) return fail('capacity');

    let exchange;
    try {
      exchange = await this.#p.ecdh(clientPub);
    } catch {
      return fail('malformed');
    }
    const seed = exchange.secret;
    const gid = b64u(this.#p.random(16));
    const roll = this.#roll(seed, 0);
    this.#gens.set(gid, {
      gid,
      epoch: 0,
      epochStart: now,
      createdAt: now,
      cur: { key: roll.key, used: new Uint8Array(this.budget) },
      prev: null,
      lastBeat: null,
    });
    this.#emit('mint', { gid });
    return {
      ok: true,
      v: VERSION,
      gid,
      pub: b64u(exchange.pub),
      epoch: 0,
      epochMs: this.epochMs,
      beatAfterMs: this.beatAfterMs,
      graceMs: this.graceMs,
      budget: this.budget,
      challenge: b64u(roll.challenge),
      program: roll.program,
    };
  }

  /**
   * Trade the current epoch key for the next one.
   * @param {{ gid: string, epoch: number, mac: string }} msg
   */
  beat(msg) {
    let mac;
    try {
      mac = unb64u(msg?.mac);
    } catch {
      return fail('malformed');
    }
    if (typeof msg.gid !== 'string' || !Number.isInteger(msg.epoch) || mac.length !== 32) {
      return fail('malformed');
    }
    const now = this.now();
    const st = this.#live(msg.gid, now);
    if (typeof st === 'string') return this.#reject(st, msg.gid);

    if (msg.epoch === st.epoch) {
      if (!this.#p.equal(mac, this.#p.hmac(st.cur.key, beatInput(st.epoch)))) {
        return this.#reject('bad_mac', st.gid);
      }
      const wait = st.epochStart + this.beatAfterMs - now;
      if (wait > 0) return fail('too_early', { retryAfterMs: wait });

      const next = st.epoch + 1;
      const roll = this.#roll(st.cur.key, next);
      const response = {
        ok: true,
        epoch: next,
        challenge: b64u(roll.challenge),
        program: roll.program,
      };
      st.lastBeat = { epoch: st.epoch, key: st.cur.key, at: now, response };
      st.prev = { key: st.cur.key, used: st.cur.used, until: now + this.graceMs };
      st.cur = { key: roll.key, used: new Uint8Array(this.budget) };
      st.epoch = next;
      st.epochStart = now;
      this.#emit('beat', { gid: st.gid, epoch: next });
      return response;
    }

    // A beat for the epoch we just left: either the page never saw our answer
    // and is retrying, or two holders of the same state are both alive.
    const last = st.lastBeat;
    if (last && msg.epoch === last.epoch) {
      if (!this.#p.equal(mac, this.#p.hmac(last.key, beatInput(last.epoch)))) {
        return this.#reject('bad_mac', st.gid);
      }
      if (now - last.at <= this.graceMs) return last.response;
      this.#gens.delete(st.gid);
      this.#emit('fork', { gid: st.gid, epoch: msg.epoch });
      return fail('fork');
    }
    return this.#reject('stale_epoch', st.gid);
  }

  /**
   * Check one request.
   * @param {{ token: string | null | undefined, method: string, target: string,
   *           body?: Uint8Array | string | null }} req
   *        `target` is the path plus query exactly as the client sent it.
   */
  verify({ token, method, target, body }) {
    if (!token) return this.#reject('missing');
    const t = parseToken(token);
    if (!t) return this.#reject('malformed');
    const now = this.now();
    const st = this.#live(t.gid, now);
    if (typeof st === 'string') return this.#reject(st, t.gid);

    let slot = null;
    if (t.epoch === st.epoch) slot = st.cur;
    else if (t.epoch === st.epoch - 1 && st.prev && now <= st.prev.until) slot = st.prev;
    if (!slot) return this.#reject('stale_epoch', st.gid);

    const { sha256 } = this.#p;
    const digest = sha256(digestInput(method, target, hex(sha256(bytes(body)))));
    const expected = this.#p.hmac(slot.key, reqInput(t.epoch, t.ctr, digest));
    if (!this.#p.equal(t.mac, expected)) return this.#reject('bad_mac', st.gid);

    // Counters double as the budget: each value below `budget` is good once.
    if (t.ctr >= slot.used.length) return this.#reject('over_budget', st.gid);
    if (slot.used[t.ctr]) return this.#reject('replay', st.gid);
    slot.used[t.ctr] = 1;
    return { ok: true, gid: st.gid, epoch: t.epoch, ctr: t.ctr };
  }

  revoke(gid) {
    if (this.#gens.delete(gid)) this.#emit('revoke', { gid });
  }

  #roll(prevKey, epoch) {
    const challenge = this.#p.random(32);
    const rand32 = () => new DataView(this.#p.random(4).buffer).getUint32(0);
    const program = generateProgram(rand32, {
      length: this.programLength,
      probes: Object.keys(this.probes),
      probeCount: this.probeCount,
    });
    const out = runProgram(program, challenge, this.probes);
    return { challenge, program, key: this.#p.hmac(prevKey, epochInput(epoch, challenge, out)) };
  }

  /** The generator's state, or the reason it is gone. */
  #live(gid, now) {
    const st = this.#gens.get(gid);
    if (!st) return 'unknown_generator';
    if (this.#dead(st, now)) {
      this.#gens.delete(gid);
      return 'expired';
    }
    return st;
  }

  #dead(st, now) {
    return (
      now - st.createdAt > this.maxAgeMs || now - st.epochStart > this.epochMs + this.graceMs
    );
  }

  #sweep(now) {
    if (now - this.#lastSweep < this.epochMs) return;
    this.#lastSweep = now;
    for (const [gid, st] of this.#gens) if (this.#dead(st, now)) this.#gens.delete(gid);
  }

  #reject(error, gid) {
    this.#emit('reject', { error, gid });
    return fail(error);
  }

  #emit(type, detail) {
    if (this.onEvent) this.onEvent(type, detail);
  }
}
