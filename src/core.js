// pagetether core: the parts of the protocol shared by the page and the server.
// Pure JavaScript, no dependencies, no crypto. Each side brings its own HMAC/SHA-256.

export const VERSION = 0;
export const TOKEN_HEADER = 'Tether-Token';
export const ERROR_HEADER = 'Tether-Error';

const LABEL_EPOCH = 'pt0/epoch\n';
const LABEL_REQ = 'pt0/req\n';
const LABEL_BEAT = 'pt0/beat\n';

const encoder = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) {
    throw new TypeError('bad base64url');
  }
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

export function concat(...parts) {
  const bufs = parts.map((p) => (typeof p === 'string' ? encoder.encode(p) : p));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bufs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

// --- MAC inputs (see docs/DESIGN.md, "Wire format") -------------------------

/** digest = SHA-256(this). `target` is the path plus query exactly as sent. */
export function digestInput(method, target, bodyHashHex) {
  return encoder.encode(`${method.toUpperCase()}\n${target}\n${bodyHashHex}`);
}

/** k_e = HMAC(k_{e-1}, this). For e = 0 the previous key is the seed. */
export function epochInput(epoch, challenge, programOutput) {
  return concat(LABEL_EPOCH, u32(epoch), challenge, programOutput);
}

/** request mac = HMAC(k_e, this) */
export function reqInput(epoch, ctr, digest) {
  return concat(LABEL_REQ, u32(epoch), u32(ctr), digest);
}

/** beat mac = HMAC(k_e, this) */
export function beatInput(epoch) {
  return concat(LABEL_BEAT, u32(epoch));
}

// --- Token ------------------------------------------------------------------

export function formatToken({ gid, epoch, ctr, mac }) {
  return `${VERSION}.${gid}.${epoch}.${ctr}.${b64u(mac)}`;
}

const UINT = /^(0|[1-9][0-9]{0,9})$/;
const GID = /^[A-Za-z0-9_-]{22}$/;

export function parseToken(str) {
  if (typeof str !== 'string' || str.length > 200) return null;
  const parts = str.split('.');
  if (parts.length !== 5 || parts[0] !== String(VERSION)) return null;
  const [, gid, e, c, m] = parts;
  if (!GID.test(gid) || !UINT.test(e) || !UINT.test(c)) return null;
  const epoch = Number(e);
  const ctr = Number(c);
  if (epoch > 0xffffffff || ctr > 0xffffffff) return null;
  let mac;
  try {
    mac = unb64u(m);
  } catch {
    return null;
  }
  if (mac.length !== 32) return null;
  return { gid, epoch, ctr, mac };
}

// --- The noise program ------------------------------------------------------
//
// A program is { ops: [[op, a, b, imm], ...], probes: [name, ...], scenes?: [scene, ...] }.
// It runs on eight uint32 registers loaded from a 32-byte challenge and returns
// the registers as 32 bytes. Both sides run it; the output is mixed into the
// next epoch key, so a wrong answer is never reported: the key is just wrong.

export const OP = { ADD: 0, XOR: 1, ROL: 2, MUL: 3, MIX: 4, PROBE: 5, SCENE: 6 };

const MAX_OPS = 4096;

/** The 32-bit finaliser from MurmurHash3. A mixer, not a cryptographic hash. */
export function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** What a scene instruction adds to its register: the scene's 64-bit digest, salted by the running state. */
export function sceneAnswer(digest, nonce) {
  return (fmix32(digest[0] ^ nonce) + fmix32((digest[1] + Math.imul(nonce, 0x9e3779b1)) >>> 0)) >>> 0;
}

const isDigest = (d) =>
  Array.isArray(d) && d.length === 2 && d.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff);

/**
 * @param {object} program
 * @param {Uint8Array} challenge  32 bytes
 * @param {Record<string, (arg: number) => number>} [probes]
 * @param {(scene: object, index: number) => [number, number]} [scene]
 *        answers a scene with its digest: the page renders it, the server looks it up
 */
export function runProgram(program, challenge, probes = {}, scene = null) {
  if (!program || !Array.isArray(program.ops) || program.ops.length > MAX_OPS) {
    throw new TypeError('bad program');
  }
  if (!(challenge instanceof Uint8Array) || challenge.length !== 32) {
    throw new TypeError('bad challenge');
  }
  const names = Array.isArray(program.probes) ? program.probes : [];
  const scenes = Array.isArray(program.scenes) ? program.scenes : [];
  const digests = new Array(scenes.length);
  const view = new DataView(challenge.buffer, challenge.byteOffset, 32);
  const r = new Uint32Array(8);
  for (let i = 0; i < 8; i++) r[i] = view.getUint32(i * 4);

  for (const ins of program.ops) {
    const op = ins[0];
    const a = ins[1] & 7;
    const b = ins[2] & 7;
    const imm = ins[3] >>> 0;
    switch (op) {
      case OP.ADD:
        r[a] = r[a] + r[b] + imm;
        break;
      case OP.XOR:
        r[a] = r[a] ^ r[b] ^ imm;
        break;
      case OP.ROL: {
        const n = (imm & 31) || 1;
        r[a] = (r[a] << n) | (r[a] >>> (32 - n));
        break;
      }
      case OP.MUL:
        r[a] = Math.imul(r[a], imm | 1);
        break;
      case OP.MIX:
        r[a] = r[a] ^ (r[b] >>> ((imm & 15) + 1));
        break;
      case OP.PROBE: {
        // The argument depends on the running state, so probe answers cannot
        // be worked out ahead of time from the program text alone.
        const name = names[ins[2]];
        const fn = typeof name === 'string' && Object.hasOwn(probes, name) ? probes[name] : null;
        if (typeof fn !== 'function') throw new Error(`unknown probe: ${name}`);
        const arg = (imm ^ r[(a + 1) & 7]) >>> 0;
        r[a] = r[a] + (fn(arg) >>> 0);
        break;
      }
      case OP.SCENE: {
        const index = ins[2];
        if (!Object.hasOwn(scenes, index)) throw new Error(`unknown scene: ${index}`);
        if (typeof scene !== 'function') throw new Error('no scene renderer');
        const digest = (digests[index] ??= scene(scenes[index], index));
        if (!isDigest(digest)) throw new Error('bad scene digest');
        r[a] = r[a] + sceneAnswer(digest, (imm ^ r[(a + 1) & 7]) >>> 0);
        break;
      }
      default:
        throw new TypeError(`bad opcode: ${op}`);
    }
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, r[i]);
  return out;
}

/**
 * Roll a fresh random program.
 * @param {() => number} rand32  source of uniform uint32 values
 * @param {{ length?: number, probes?: string[], probeCount?: number, scenes?: object[] }} [opts]
 *        each entry of `scenes` gets one instruction, at a random position
 */
export function generateProgram(rand32, { length = 48, probes = [], probeCount = 4, scenes = [] } = {}) {
  const ops = [];
  for (let i = 0; i < length; i++) {
    const a = rand32() & 7;
    const b = (a + 1 + (rand32() % 7)) & 7; // never equal to a
    ops.push([rand32() % 5, a, b, rand32()]);
  }
  if (probes.length > 0) {
    for (let i = 0; i < probeCount; i++) {
      const at = rand32() % (ops.length + 1);
      ops.splice(at, 0, [OP.PROBE, rand32() & 7, rand32() % probes.length, rand32()]);
    }
  }
  for (let i = 0; i < scenes.length; i++) {
    const at = rand32() % (ops.length + 1);
    ops.splice(at, 0, [OP.SCENE, rand32() & 7, i, rand32()]);
  }
  const program = { ops, probes: [...probes] };
  if (scenes.length > 0) program.scenes = [...scenes];
  return program;
}
