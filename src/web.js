// pagetether on WebCrypto runtimes (browsers, workers, edge functions).
//
// Token checks have to be synchronous so that "verify the MAC, then check and
// mark the counter" cannot interleave with another request, and WebCrypto is
// async only. So SHA-256 and HMAC are implemented here in plain JavaScript;
// the mint's key exchange, which is async anyway, uses WebCrypto.

import { TetherCore } from './tether.js';

const encoder = new TextEncoder();

function firstPrimes(n) {
  const primes = [];
  for (let c = 2; primes.length < n; c++) if (primes.every((p) => c % p)) primes.push(c);
  return primes;
}
// The SHA-256 constants: fractional parts of the cube and square roots of the
// first primes. Derived here instead of pasted; test/web.test.js checks the
// result against node:crypto.
const frac32 = (x) => Math.floor((x % 1) * 0x100000000);
const K = Uint32Array.from(firstPrimes(64), (p) => frac32(Math.cbrt(p)));
const H0 = Uint32Array.from(firstPrimes(8), (p) => frac32(Math.sqrt(p)));

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256(data) {
  const msg = typeof data === 'string' ? encoder.encode(data) : data;
  const len = msg.length;
  const padded = new Uint8Array(((len + 72) >>> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len << 3) >>> 0);

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

export function hmac(key, data) {
  const k = key.length > 64 ? sha256(key) : key;
  const inner = new Uint8Array(64 + data.length);
  const outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }
  inner.set(data, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

async function ecdh(clientPub) {
  const { subtle } = globalThis.crypto;
  const theirs = await subtle.importKey('raw', clientPub, ECDH, false, []);
  const pair = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256));
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { pub, secret };
}

export const primitives = {
  hmac,
  sha256,
  random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  equal,
  ecdh,
};

export class Tether extends TetherCore {
  /** @param {ConstructorParameters<typeof TetherCore>[1]} [opts] */
  constructor(opts) {
    super(primitives, opts);
  }
}
