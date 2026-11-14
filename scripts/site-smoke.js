// Checks the static site in a real browser: builds it, serves it under a
// sub-path the way GitHub Pages does, opens it in headless Chrome over the
// DevTools protocol and exercises the live generator and every lab attack.
//
//   CHROME=/path/to/chrome node scripts/site-smoke.js [screenshotDir]
//
// Needs Node 22+ (built-in WebSocket) and a Chrome or Chromium binary.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? 'google-chrome';
const shots = process.argv[2] ?? null;
const BASE = '/pagetether/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const work = await mkdtemp(join(tmpdir(), 'pagetether-site-'));
const siteDir = join(work, 'site');
const children = [];
let server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const build = spawnSync(process.execPath, [fileURLToPath(new URL('./build-site.js', import.meta.url)), siteDir], { stdio: 'inherit' });
  assert.equal(build.status, 0, 'site build failed');

  const requested = [];
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    requested.push(path);
    if (!path.startsWith(BASE)) return res.writeHead(404).end();
    const rel = normalize(path.slice(BASE.length) || 'index.html');
    if (rel.startsWith('..')) return res.writeHead(400).end();
    try {
      const data = await readFile(join(siteDir, rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const chrome = spawn(
    CHROME,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${join(work, 'profile')}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  children.push(chrome);
  const browserWs = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for chrome')), 30_000);
    chrome.stderr.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    chrome.on('exit', (code) => reject(new Error(`chrome exited early (${code})`)));
  });
  const devtools = `http://${new URL(browserWs).host}`;
  const target = await (await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const screenshot = async (name, { width, height, dark = false, selector = null }) => {
    if (!shots) return;
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await sleep(400);
    let clip;
    if (selector) {
      clip = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'start', behavior: 'instant' });
        const b = el.getBoundingClientRect(); return { x: 0, y: b.top + scrollY, width: innerWidth, height: Math.min(b.height, 4000), scale: 1 }; })()`);
      await sleep(300);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) });
    await writeFile(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + BASE });
  for (let i = 0; i < 100 && (await evaluate('typeof window.pagetetherSite')) !== 'object'; i++) await sleep(100);
  if (shots) await mkdir(shots, { recursive: true });

  const check = async (name, fn) => {
    await fn();
    console.log(`ok  ${name}`);
  };
  const waitFor = async (expression, label, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      if (await evaluate(expression)) return;
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  await check('the page loads under a sub-path and asks for nothing outside it', async () => {
    assert.equal(await evaluate('typeof window.pagetetherSite'), 'object');
    const outside = requested.filter((p) => !p.startsWith(BASE));
    assert.deepEqual(outside, []);
  });

  await check('this browser answers the layout probes the way the oracle expects', async () => {
    assert.equal(await evaluate('pagetetherSite.realProbes'), true);
  });

  await check('live: the real client mints and its requests are accepted', async () => {
    await waitFor('pagetetherSite.live.last?.result.ok === true', 'a first accepted request');
    assert.equal(await evaluate(`document.getElementById('live-status').textContent.trim()`), 'page open');
    assert.match(await evaluate(`document.getElementById('live-verdict').textContent`), /accepted/);
  });

  await check('live: a copied token is refused as a replay, and on another URL as a bad proof', async () => {
    await evaluate(`document.getElementById('live-replay').click()`);
    assert.match(await evaluate(`document.getElementById('live-script').textContent`), /rejected: replay/);
    await evaluate(`document.getElementById('live-retarget').click()`);
    assert.match(await evaluate(`document.getElementById('live-script').textContent`), /rejected: bad_mac/);
  });
  await screenshot('hero-light', { width: 1280, height: 900 });

  await check('live: the page beats and moves to the next epoch on its own', async () => {
    await waitFor('pagetetherSite.live.state?.epoch >= 1', 'epoch 1', 14_000);
    assert.equal(await evaluate('pagetetherSite.live.last.result.ok'), true);
  });

  await check('live: closing the page gets the generator deleted within one epoch', async () => {
    await evaluate(`document.getElementById('live-close').click()`);
    assert.equal(await evaluate(`document.getElementById('live-status').textContent.trim()`), 'page closed');
    await waitFor(`document.getElementById('live-status').textContent.trim() === 'generator deleted'`, 'the generator to die', 16_000);
    await evaluate(`document.getElementById('live-replay').click()`);
    assert.match(await evaluate(`document.getElementById('live-script').textContent`), /rejected: expired/);
  });

  await check('live: opening the page again mints a fresh generator', async () => {
    await evaluate(`document.getElementById('live-close').click()`);
    await waitFor('pagetetherSite.live.open && pagetetherSite.live.last?.result.ok === true && pagetetherSite.live.state?.epoch === 0', 'a new generator');
  });

  const expected = {
    cold: ['ok', 'missing', 'unknown_generator', 'bad_mac', 'ok'],
    replay: ['ok', 'replay', 'ok', 'stale_epoch'],
    retarget: ['bad_mac', 'bad_mac', 'bad_mac', 'bad_mac', 'ok', 'replay'],
    stale: [],
    flood: ['too_early', 'replay', 'ok', 'ok', 'ok', 'ok', 'ok'],
    clone: ['ok', 'ok', 'fork', 'unknown_generator', 'unknown_generator'],
    'no-browser': ['bad_mac', 'bad_mac', 'ok'],
    'full-port': ['ok', 'ok', 'ok', 'ok', 'ok'],
  };
  const charts = {
    stale: [30, 6, 0, 0, 0],
    flood: [60, 60, 60, 60, 60],
    clone: 60,
    'full-port': [60, 60, 60, 60, 60],
  };
  assert.deepEqual(await evaluate('pagetetherSite.lab.scenarios'), Object.keys(expected));

  for (const [id, codes] of Object.entries(expected)) {
    await check(`lab: ${id}`, async () => {
      const out = await evaluate(`pagetetherSite.lab.play(${JSON.stringify(id)})`);
      assert.deepEqual(out.lines.filter((l) => l.code).map((l) => l.code), codes);
      const shown = await evaluate(`document.querySelectorAll('#lab-console .ln').length`);
      assert.equal(shown, out.lines.length);
      assert.equal(await evaluate(`document.getElementById('lab-outcome').hidden`), false);
      const bars = await evaluate(`document.getElementById('lab-chart').hidden ? null : document.querySelectorAll('#lab-chart svg .bar').length`);
      if (id in charts) {
        const want = charts[id];
        if (Array.isArray(want)) assert.deepEqual(out.chart.accepted, want);
        else assert.equal(out.chart.accepted.reduce((a, b) => a + b, 0), want);
        const nonZero = [...out.chart.sent, ...out.chart.accepted].filter((v) => v > 0).length;
        assert.equal(bars, nonZero);
      } else {
        assert.equal(bars, null);
      }
      if (shots && ['cold', 'stale', 'flood', 'clone', 'full-port'].includes(id)) {
        await screenshot(`lab-${id}-light`, { width: 1280, height: 900, selector: '#lab' });
      }
    });
  }

  await check('lab: the chart has a hover tooltip and a table view', async () => {
    await evaluate(`pagetetherSite.lab.play('flood')`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('#lab-chart .hit').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(300);
    const point = await evaluate(`(() => { const b = document.querySelector('#lab-chart .hit').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await sleep(150);
    assert.equal(await evaluate(`document.getElementById('tooltip').hidden`), false);
    assert.match(await evaluate(`document.getElementById('tooltip').textContent`), /epoch 0.*Sent.*400.*Accepted.*60/s);
    if (shots) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(shots, 'lab-tooltip-light.png'), Buffer.from(data, 'base64'));
    }
    await evaluate(`document.querySelector('#lab-chart button.link').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#lab-chart table tr').length`), 6);
    assert.equal(await evaluate(`document.querySelector('#lab-chart table').hidden`), false);
    await evaluate(`document.querySelector('#lab-chart button.link').click()`);
  });

  await check('nothing overflows sideways at phone, tablet or desktop width', async () => {
    for (const width of [360, 768, 1280]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
      await sleep(300);
      const wide = await evaluate(`[...document.querySelectorAll('main *, header *, footer *')].filter((el) => {
        const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) && !el.closest('.ratchet, pre, .plot');
      }).map((el) => el.tagName + '.' + el.className).slice(0, 8)`);
      assert.deepEqual(wide, [], `at ${width}px`);
    }
  });

  await check('no errors or warnings were logged', async () => {
    assert.deepEqual(problems, []);
  });

  if (shots) {
    await evaluate(`pagetetherSite.lab.play('flood')`);
    await screenshot('full-light', { width: 1280, height: 900, selector: 'body' });
    await screenshot('full-dark', { width: 1280, height: 900, dark: true, selector: 'body' });
    await screenshot('lab-flood-dark', { width: 1280, height: 900, dark: true, selector: '#lab' });
    await screenshot('hero-dark', { width: 1280, height: 900, dark: true, selector: '.hero' });
    await screenshot('mobile-hero', { width: 390, height: 844, selector: '.hero' });
    await screenshot('mobile-lab', { width: 390, height: 844, selector: '#lab' });
    await screenshot('mobile-how', { width: 390, height: 844, selector: '#how' });
    await screenshot('rest-light', { width: 1280, height: 900, selector: '#limits' });
    await screenshot('use-dark', { width: 1280, height: 900, dark: true, selector: '#use' });
    console.log(`screenshots in ${shots}`);
  }

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
  server?.close();
  await sleep(500);
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
