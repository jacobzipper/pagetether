// pagetether on Node: the verifier bound to node:crypto.

import { createECDH, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TetherCore } from './tether.js';

const primitives = {
  hmac: (key, data) => createHmac('sha256', key).update(data).digest(),
  sha256: (data) => createHash('sha256').update(data).digest(),
  // Copied out of Node's shared pool so each value owns its buffer.
  random: (n) => new Uint8Array(randomBytes(n)),
  equal: timingSafeEqual,
  ecdh(clientPub) {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return { pub: ecdh.getPublicKey(), secret: ecdh.computeSecret(clientPub) };
  },
};

export class Tether extends TetherCore {
  /** @param {ConstructorParameters<typeof TetherCore>[1]} [opts] */
  constructor(opts) {
    super(primitives, opts);
  }
}
