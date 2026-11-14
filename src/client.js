// pagetether client: holds the generator inside a page, keeps it alive, and
// signs requests. Runs in browsers and in any runtime with WebCrypto + fetch.

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
} from './core.js';
import { domScenes, digestToHex } from './scenes.js';

const subtle = globalThis.crypto.subtle;
const HMAC = { name: 'HMAC', hash: 'SHA-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

// Keys are non-extractable: script running in the page can use the generator
// while it is there, but cannot copy the key out through the crypto API.
const importKey = (raw) => subtle.importKey('raw', raw, HMAC, false, ['sign']);
const sign = async (key, data) => new Uint8Array(await subtle.sign('HMAC', key, data));
const sha256 = async (data) => new Uint8Array(await subtle.digest('SHA-256', data));

// Server answers that mean this generator is finished.
const DEAD = new Set(['unknown_generator', 'expired', 'fork', 'stale_epoch', 'bad_mac']);

export class TetherError extends Error {
  constructor(code, detail) {
    super(`pagetether: ${code}`);
    this.name = 'TetherError';
    this.code = code;
    this.detail = detail;
  }
}

export class TetherClient {
  #base;
  #fetch;
  #probes;
  #scenes;
  #now;
  #sleep;
  #autoBeat;
  #gateProof;
  #gen = null;
  #minting = null;
  #beating = null;
  #timer = null;
  #stopped = false;

  /**
   * @param {object} [opts]
   * @param {string} [opts.base]       where the mint and beat endpoints live
   * @param {typeof fetch} [opts.fetch]
   * @param {Record<string, (arg: number) => number>} [opts.probes]
   * @param {(scene: { t: any[], c: string }) => [number, number]} [opts.scenes]
   *        answers layout scenes; defaults to rendering them in this document
   * @param {boolean} [opts.autoBeat]  keep the generator alive on a timer (default true)
   * @param {() => any} [opts.gateProof]  extra proof sent with a mint (captcha token, ...)
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   */
  constructor(opts = {}) {
    this.#base = (opts.base ?? '/__tether').replace(/\/$/, '');
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#probes = opts.probes ?? {};
    this.#scenes = opts.scenes ?? (typeof document === 'undefined' ? null : domScenes());
    this.#autoBeat = opts.autoBeat ?? true;
    this.#gateProof = opts.gateProof ?? null;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A snapshot for display and debugging. */
  get state() {
    const g = this.#gen;
    if (!g) return null;
    return {
      gid: g.gid,
      epoch: g.epoch,
      used: g.ctr,
      budget: g.budget,
      ageMs: this.#now() - g.start,
      epochMs: g.epochMs,
    };
  }

  /** fetch(), with a token attached. Re-mints and retries once if the server says the generator is gone. */
  async fetch(input, init) {
    const req = new Request(input, init);
    const body = new Uint8Array(await req.clone().arrayBuffer());
    const url = new URL(req.url);
    const target = url.pathname + url.search;
    for (let attempt = 0; ; attempt++) {
      const { token, gid } = await this.#sign(req.method, target, body);
      const out = req.clone();
      out.headers.set(TOKEN_HEADER, token);
      const res = await this.#fetch(out);
      const err = res.status === 401 ? res.headers.get(ERROR_HEADER) : null;
      if (!err || attempt > 0) return res;
      if (err !== 'replay') this.#drop(gid);
    }
  }

  /** The token for one request, for callers that do their own transport. */
  async token(method, target, body) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return (await this.#sign(method, target, bytes ?? new Uint8Array(0))).token;
  }

  /** Trade the current epoch key for the next one. Waits if it is too early. */
  beat() {
    this.#beating ??= this.#doBeat().finally(() => {
      this.#beating = null;
    });
    return this.#beating;
  }

  stop() {
    this.#stopped = true;
    this.#gen = null;
    clearTimeout(this.#timer);
  }

  async #sign(method, target, body) {
    const g = await this.#ready();
    const ctr = g.ctr++; // no await between #ready() and here
    const digest = await sha256(digestInput(method, target, hex(await sha256(body))));
    const mac = await sign(g.key, reqInput(g.epoch, ctr, digest));
    return { token: formatToken({ gid: g.gid, epoch: g.epoch, ctr, mac }), gid: g.gid };
  }

  /** Resolves to a generator that is alive and has budget left. */
  async #ready() {
    for (;;) {
      if (this.#stopped) throw new TetherError('stopped');
      const g = this.#gen;
      const age = g ? this.#now() - g.start : Infinity;
      if (!g || age >= g.epochMs + g.graceMs) {
        this.#gen = null;
        await this.#mint();
      } else if (age >= g.epochMs || g.ctr >= g.budget) {
        await this.beat();
      } else {
        return g;
      }
    }
  }

  #mint() {
    this.#minting ??= this.#doMint().finally(() => {
      this.#minting = null;
    });
    return this.#minting;
  }

  async #doMint() {
    const proof = this.#gateProof ? await this.#gateProof() : undefined;
    // The seed is an ECDH shared secret derived straight into a non-extractable
    // key: it is never on the wire and never visible to script as bytes.
    const pair = await subtle.generateKey(ECDH, false, ['deriveKey']);
    const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const m = await this.#post('/mint', { pub: b64u(pub), proof });
    const serverPub = await subtle.importKey('raw', unb64u(m.pub), ECDH, false, []);
    const seed = await subtle.deriveKey(
      { name: 'ECDH', public: serverPub },
      pair.privateKey,
      { ...HMAC, length: 256 },
      false,
      ['sign'],
    );
    const key = await this.#derive(seed, 0, m);
    this.#gen = {
      gid: m.gid,
      key,
      shadow: this.#shadow(m),
      epoch: 0,
      ctr: 0,
      start: this.#now(),
      epochMs: m.epochMs,
      beatAfterMs: m.beatAfterMs,
      graceMs: m.graceMs,
      budget: m.budget,
    };
    this.#schedule();
  }

  async #doBeat() {
    const g = this.#gen;
    if (!g) return;
    const wait = g.start + g.beatAfterMs - this.#now();
    if (wait > 0) await this.#sleep(wait);
    if (this.#gen !== g) return;

    const mac = await sign(g.key, beatInput(g.epoch));
    let r;
    try {
      r = await this.#post('/beat', { gid: g.gid, epoch: g.epoch, mac: b64u(mac), shadow: g.shadow });
    } catch (err) {
      if (err instanceof TetherError && DEAD.has(err.code)) {
        this.#drop(g.gid);
        return;
      }
      throw err;
    }
    const key = await this.#derive(g.key, r.epoch, r);
    if (this.#gen !== g) return;
    this.#gen = { ...g, key, shadow: this.#shadow(r), epoch: r.epoch, ctr: 0, start: this.#now() };
    this.#schedule();
  }

  /** k_e = HMAC(k_{e-1}, epoch || challenge || program(challenge)) */
  async #derive(prevKey, epoch, { challenge, program }) {
    const c = unb64u(challenge);
    let out;
    try {
      out = runProgram(program, c, this.#probes, this.#scenes);
    } catch (err) {
      throw new TetherError('program_failed', String(err?.message ?? err));
    }
    const raw = await sign(prevKey, epochInput(epoch, c, out));
    const key = await importKey(raw);
    raw.fill(0);
    return key;
  }

  /** A server in report mode sends scenes that do not affect the key. Answer them for its statistics. */
  #shadow({ shadow }) {
    if (!Array.isArray(shadow)) return undefined;
    return shadow.map((scene) => {
      try {
        return digestToHex(this.#scenes(scene));
      } catch {
        return null;
      }
    });
  }

  async #post(path, body) {
    const res = await this.#fetch(this.#base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // handled below
    }
    if (!res.ok || !json || json.ok !== true) {
      throw new TetherError(json?.error ?? `http_${res.status}`, json);
    }
    return json;
  }

  #drop(gid) {
    if (this.#gen?.gid === gid) {
      this.#gen = null;
      clearTimeout(this.#timer);
    }
  }

  #schedule() {
    clearTimeout(this.#timer);
    const g = this.#gen;
    if (!this.#autoBeat || this.#stopped || !g) return;
    // Somewhere in the first half of the window between "may beat" and "must beat".
    const delay = g.beatAfterMs + Math.random() * (g.epochMs - g.beatAfterMs) * 0.5;
    this.#arm(delay);
  }

  #arm(delay) {
    this.#timer = setTimeout(() => {
      this.beat().catch(() => {
        if (this.#gen && !this.#stopped) this.#arm(2000);
      });
    }, delay);
    this.#timer.unref?.();
  }
}
