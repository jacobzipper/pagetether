// End-to-end check in a real browser: starts the demo with short epochs, opens
// the page in headless Chrome over the DevTools protocol, and checks that the
// DOM probes, the WebCrypto path and the heartbeat all work for real.
//
//   CHROME=/path/to/chrome node scripts/browser-smoke.js
//
// Needs Node 22+ (built-in WebSocket) and a Chrome or Chromium binary.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? 'google-chrome';
const BUDGET = 5;

const children = [];
const profile = await mkdtemp(join(tmpdir(), 'pagetether-smoke-'));

function waitForLine(child, stream, pattern, label) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 30_000);
    child[stream].on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(pattern);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    });
    child.on('exit', (code) => reject(new Error(`${label} exited early (${code})`)));
  });
}

async function main() {
  const server = spawn(process.execPath, [fileURLToPath(new URL('../demo/server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', EPOCH_MS: '3000', BUDGET: String(BUDGET), QUIET: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(server);
  const [, ORIGIN] = await waitForLine(server, 'stdout', /pagetether demo on (http:\/\/\S+)/, 'demo server');

  const chrome = spawn(
    CHROME,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  children.push(chrome);
  const [, browserWs] = await waitForLine(chrome, 'stderr', /DevTools listening on (ws:\/\/\S+)/, 'chrome');
  const devtools = `http://${new URL(browserWs).host}`;

  const target = await (await fetch(`${devtools}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const evaluate = async (expression) => {
    const id = nextId++;
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    const r = reply.result;
    if (reply.error || r.exceptionDetails) {
      throw new Error(`page threw: ${JSON.stringify(reply.error ?? r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`);
    }
    return r.result.value;
  };

  // Wait for the module script to run.
  for (let i = 0; i < 50 && !(await evaluate('typeof window.demoReady')).startsWith('object'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const check = async (name, fn) => {
    await fn();
    console.log(`ok  ${name}`);
  };

  await check('a real page mints, answers the layout probes and gets data', async () => {
    assert.equal(await evaluate('window.demoReady'), true);
    assert.equal(await evaluate('tether.state.epoch'), 0);
  });

  await check('12 requests on a budget of 5 all land, spread over three epochs', async () => {
    const epochs = await evaluate(`(async () => {
      const out = [];
      for (let i = 0; i < 12; i++) {
        const res = await tether.fetch('/api/prices?page=' + (100 + i));
        out.push(res.ok ? (await res.json()).tether.epoch : -1);
      }
      return out;
    })()`);
    assert.ok(!epochs.includes(-1), `rejected: ${epochs}`);
    assert.ok(Math.max(...epochs) >= 2, `epochs: ${epochs}`);
  });

  await check('the background heartbeat keeps an idle page alive', async () => {
    const before = await evaluate('tether.state');
    await new Promise((r) => setTimeout(r, 7000)); // more than two epochs, no requests
    const after = await evaluate('tether.state');
    assert.equal(after.gid, before.gid);
    assert.ok(after.epoch >= before.epoch + 2, `${before.epoch} -> ${after.epoch}`);
  });

  await check('a token lifted out of the page works once, for that request only', async () => {
    const token = await evaluate(`tether.token('GET', '/api/prices?page=7')`);
    const get = (path) => fetch(ORIGIN + path, { headers: { 'Tether-Token': token } });
    const other = await get('/api/prices?page=8');
    assert.deepEqual([other.status, other.headers.get('tether-error')], [401, 'bad_mac']);
    assert.equal((await get('/api/prices?page=7')).status, 200);
    const again = await get('/api/prices?page=7');
    assert.deepEqual([again.status, again.headers.get('tether-error')], [401, 'replay']);
  });

  await check('the same client code with no layout engine behind the probes gets nothing', async () => {
    const outcome = await evaluate(`(async () => {
      const { TetherClient } = await import('/pagetether/client.js');
      const fake = new TetherClient({ probes: { box: () => 0, calc: () => 0 }, autoBeat: false });
      const res = await fake.fetch('/api/prices?page=1');
      return [res.status, res.headers.get('tether-error')];
    })()`);
    assert.deepEqual(outcome, [401, 'bad_mac']);
  });

  await check('with the page gone the generator expires', async () => {
    const token = await evaluate(`tether.token('GET', '/api/prices?page=9')`);
    await evaluate('tether.stop()');
    await new Promise((r) => setTimeout(r, 8500)); // epoch + grace
    const res = await fetch(`${ORIGIN}/api/prices?page=9`, { headers: { 'Tether-Token': token } });
    assert.deepEqual([res.status, res.headers.get('tether-error')], [401, 'expired']);
  });

  ws.close();
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`FAILED: ${err.message}`);
} finally {
  for (const child of children) child.kill();
  await new Promise((r) => setTimeout(r, 500));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
