// node:http glue for a Tether instance.

import { TOKEN_HEADER, ERROR_HEADER } from './core.js';

export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * Serves POST {base}/mint and POST {base}/beat.
 * @returns {(req, res) => Promise<boolean>} resolves true if it handled the request
 */
export function controlRoutes(tether, { base = '/__tether' } = {}) {
  return async (req, res) => {
    const path = req.url.split('?')[0];
    const isMint = path === `${base}/mint`;
    if (req.method !== 'POST' || (!isMint && path !== `${base}/beat`)) return false;

    let msg;
    try {
      msg = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { ok: false, error: 'malformed' });
      return true;
    }
    const out = isMint ? await tether.mint(msg, { req }) : tether.beat(msg);
    const status = out.ok
      ? 200
      : { gate: 403, capacity: 503, malformed: 400 }[out.error] ?? 401;
    sendJson(res, status, out);
    return true;
  };
}

/**
 * Verify the token on a request whose body has already been read.
 * On failure writes a 401 carrying the reason and returns null.
 */
export function guard(tether, req, res, body) {
  const result = tether.verify({
    token: req.headers[TOKEN_HEADER.toLowerCase()],
    method: req.method,
    target: req.url,
    body,
  });
  if (result.ok) return result;
  sendJson(res, 401, result, { [ERROR_HEADER]: result.error });
  return null;
}
