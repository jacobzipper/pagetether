// A from-scratch port of the pagetether client with the key held in the clear,
// the way someone who had taken the real client apart would write it. The lab
// uses it for both sides: as the honest page (with correct probe answers) and
// as the adversary.

import { hmac, sha256 } from './lib/web.js';
import {
  b64u,
  unb64u,
  hex,
  digestInput,
  epochInput,
  reqInput,
  beatInput,
  formatToken,
  runProgram,
} from './lib/core.js';

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const encoder = new TextEncoder();

export async function mintGenerator(server, probes, scenes) {
  const { subtle } = crypto;
  const pair = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const mint = await server.mint({ pub: b64u(pub) });
  if (!mint.ok) throw new Error(`mint refused: ${mint.error}`);
  const theirs = await subtle.importKey('raw', unb64u(mint.pub), ECDH, false, []);
  const seed = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256));
  const challenge = unb64u(mint.challenge);
  const out = runProgram(mint.program, challenge, probes, scenes);
  return { gid: mint.gid, epoch: 0, key: hmac(seed, epochInput(0, challenge, out)) };
}

export function token(gen, ctr, method, target, body = '') {
  const digest = sha256(digestInput(method, target, hex(sha256(encoder.encode(body)))));
  return formatToken({ gid: gen.gid, epoch: gen.epoch, ctr, mac: hmac(gen.key, reqInput(gen.epoch, ctr, digest)) });
}

export function beatMessage(gen) {
  return { gid: gen.gid, epoch: gen.epoch, mac: b64u(hmac(gen.key, beatInput(gen.epoch))) };
}

export function advance(gen, response, probes, scenes) {
  const challenge = unb64u(response.challenge);
  const out = runProgram(response.program, challenge, probes, scenes);
  return { gid: gen.gid, epoch: response.epoch, key: hmac(gen.key, epochInput(response.epoch, challenge, out)) };
}
