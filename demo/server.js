// Demo: a page, a private API behind pagetether, and a log of what the server
// decides. Run with `npm run demo`, open the page, then try to call the API
// from anywhere else.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Tether } from '../src/server.js';
import { controlRoutes, guard, readBody } from '../src/node.js';
import { domOracles } from '../src/probes.js';

// Layout scenes whose answers were measured in real browsers. This pool ships
// in the repository, so its answers are public: bake your own with
// `npm run bake -- --out pool.json --chrome --firefox` before relying on it.
const pool = JSON.parse(await readFile(new URL('../pools/example.json', import.meta.url), 'utf8'));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const QUIET = process.env.QUIET === '1';

// The mint gate is where a deployment charges for presence: a login, a
// captcha, a Private Access Token. This stand-in only limits mints per address.
const MINTS_PER_MINUTE = 6;
const mints = new Map();
function gate({ req }) {
  const ip = req.socket.remoteAddress;
  const now = Date.now();
  const recent = (mints.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= MINTS_PER_MINUTE) return false;
  recent.push(now);
  mints.set(ip, recent);
  return true;
}

const tether = new Tether({
  epochMs: Number(process.env.EPOCH_MS ?? 30_000),
  budget: Number(process.env.BUDGET ?? 20),
  probes: domOracles,
  scenes: pool,
  gate,
  onEvent: (type, detail) => {
    if (!QUIET) console.log(new Date().toISOString().slice(11, 19), type, JSON.stringify(detail));
  },
});
const control = controlRoutes(tether);

const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const STATIC = {
  '/': [file('./public/index.html'), 'text/html; charset=utf-8'],
  '/pagetether/client.js': [file('../src/client.js'), 'text/javascript; charset=utf-8'],
  '/pagetether/core.js': [file('../src/core.js'), 'text/javascript; charset=utf-8'],
  '/pagetether/probes.js': [file('../src/probes.js'), 'text/javascript; charset=utf-8'],
  '/pagetether/scenes.js': [file('../src/scenes.js'), 'text/javascript; charset=utf-8'],
};

const PRODUCTS = ['lantern', 'compass', 'canteen', 'hatchet', 'bivouac', 'carabiner', 'tarp', 'flint'];
function prices(page) {
  return PRODUCTS.map((name, i) => ({
    sku: `${name}-${page}`,
    price: Number((((page * 7919 + i * 104729) % 9000) / 100 + 10).toFixed(2)),
  }));
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [path, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(await readFile(path));
      return;
    }
    if (await control(req, res)) return;

    if (url.pathname.startsWith('/api/')) {
      const body = await readBody(req, 64 * 1024);
      const pass = guard(tether, req, res, body);
      if (!pass) return;
      if (req.method === 'GET' && url.pathname === '/api/prices') {
        const page = Number(url.searchParams.get('page') ?? 1) | 0;
        json(res, 200, { page, items: prices(page), tether: pass });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/search') {
        const { q = '' } = JSON.parse(body.toString('utf8') || '{}');
        const items = prices(1).filter((p) => p.sku.includes(String(q)));
        json(res, 200, { q, items, tether: pass });
        return;
      }
    }
    json(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { ok: false, error: 'server_error' });
    else res.destroy();
    console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pagetether demo on http://${HOST}:${server.address().port}`);
  console.log(`epoch ${tether.epochMs} ms, budget ${tether.budget} requests per epoch, ${pool.scenes.length} layout scenes in the pool`);
});
