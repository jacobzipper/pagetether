#!/usr/bin/env node
// Bake a scene pool: generate random scenes, have real browsers lay them out,
// keep the ones every browser answers identically, and write them with their
// answers. The output file is a server-side secret, like a password file.
//
//   node scripts/bake.js --out pool.json [--count 300] [browsers]
//   node scripts/bake.js --check pool.json [browsers]     how many each browser gets right
//
// Browsers (any mix; each one is a "run"):
//   --chrome [path]            headless Chrome or Chromium   (default path: $CHROME or google-chrome)
//   --firefox [path]           headless Firefox
//   --browser 'label=cmd'      any command; {url} and {profile} are filled in
//   --wait N                   also wait for N runs you start yourself by opening
//                              the printed URL (a phone, Safari, another machine)
//   --serve                    take runs until something POSTs /finish (for drivers
//                              such as scripts/measure-engines.mjs)
//
// Other options: --candidates N (default 4 × count), --port, --host,
// --timeout seconds (default 120), --report file.json, --margin (default 0.35).
//
// No dependencies. The browsers do the work: this script only serves them a
// page and compares what they send back.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScene, sceneDigest, digestToHex, loadPool } from '../src/scenes.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// --- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = { count: 300, timeout: 120, host: '127.0.0.1', port: 0, wait: 0, margin: 0.35, browsers: [] };
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const value = () => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[++i];
  };
  const optional = () => (i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : null);
  if (flag === '--out') opts.out = value();
  else if (flag === '--check') opts.check = value();
  else if (flag === '--report') opts.report = value();
  else if (flag === '--count') opts.count = Number(value());
  else if (flag === '--candidates') opts.candidates = Number(value());
  else if (flag === '--timeout') opts.timeout = Number(value());
  else if (flag === '--margin') opts.margin = Number(value());
  else if (flag === '--port') opts.port = Number(value());
  else if (flag === '--host') opts.host = value();
  else if (flag === '--wait') opts.wait = Number(value());
  else if (flag === '--serve') opts.serve = true;
  else if (flag === '--chrome') {
    const path = optional() ?? process.env.CHROME ?? 'google-chrome';
    opts.browsers.push({
      label: 'chrome',
      cmd: [path, '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--user-data-dir={profile}', '{url}'],
    });
  } else if (flag === '--firefox') {
    const path = optional() ?? 'firefox';
    opts.browsers.push({ label: 'firefox', cmd: [path, '--headless', '--no-remote', '--profile', '{profile}', '{url}'] });
  } else if (flag === '--browser') {
    const spec = value();
    const eq = spec.indexOf('=');
    if (eq < 1) throw new Error("--browser wants 'label=command {url}'");
    opts.browsers.push({ label: spec.slice(0, eq), cmd: spec.slice(eq + 1).split(/\s+/).filter(Boolean) });
  } else throw new Error(`unknown option ${flag}`);
}
if (!opts.out && !opts.check) throw new Error('give --out pool.json to bake, or --check pool.json to test a pool');
if (opts.browsers.length + opts.wait === 0 && !opts.serve) throw new Error('no browsers: use --chrome, --firefox, --browser, --wait or --serve');

// --- the work ---------------------------------------------------------------

const rand32 = () => randomBytes(4).readUInt32BE(0);
let scenes;
let pool = null;
if (opts.check) {
  pool = loadPool(JSON.parse(await readFile(opts.check, 'utf8')));
  scenes = pool.map(({ t, c }) => ({ t, c }));
} else {
  const n = opts.candidates ?? opts.count * 4;
  scenes = Array.from({ length: n }, () => generateScene(rand32));
}

// The page every browser loads. Query flags put it in conditions a real site
// might: ?rtl makes the document right-to-left, ?hostile adds a stylesheet
// that restyles every element, ?zoom and ?scale magnify the root element.
const PAGE = `<!doctype html><meta charset="utf-8"><title>pagetether bake</title>
<body><p id="s">measuring…</p>
<script type="module">
import { measureScene } from '/src/scenes.js';
const q = new URLSearchParams(location.search);
if (q.has('rtl')) document.documentElement.dir = 'rtl';
if (q.has('hostile')) {
  const style = document.createElement('style');
  style.textContent = '*{box-sizing:border-box!important;margin:3px!important;padding:1px!important;' +
    'display:inline-block!important;font-size:31px!important;min-width:7px!important;float:left!important;' +
    'transform:none}html{font-size:9px;writing-mode:vertical-rl}';
  document.head.append(style);
}
if (q.has('zoom')) document.documentElement.style.zoom = q.get('zoom');
if (q.has('scale')) document.documentElement.style.transform = 'scale(' + q.get('scale') + ')';
const { scenes } = await (await fetch('/work')).json();
const started = performance.now();
const vectors = scenes.map((scene) => {
  try {
    return measureScene(scene, { raw: true }).map((v) => Math.round(v * 1000) / 1000);
  } catch {
    return null;
  }
});
const ms = performance.now() - started;
await fetch('/done' + location.search, {
  method: 'POST',
  body: JSON.stringify({ ua: navigator.userAgent, dpr: devicePixelRatio, ms, vectors }),
});
document.getElementById('s').textContent = 'done: ' + scenes.length + ' scenes in ' + Math.round(ms) + ' ms';
</script>`;

const runs = [];
const waiters = new Map();
let anonymous = 0;
let finish;
const finished = new Promise((resolve) => (finish = resolve));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  } else if (req.method === 'GET' && /^\/src\/[a-z-]+\.js$/.test(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(join(root, url.pathname)));
  } else if (req.method === 'GET' && url.pathname === '/work') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ scenes }));
  } else if (req.method === 'POST' && url.pathname === '/done') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const label = url.searchParams.get('label') || `manual-${++anonymous}`;
    runs.push({ label, ua: body.ua, dpr: body.dpr, ms: body.ms, vectors: body.vectors });
    console.error(`  ${label}: ${body.vectors.length} scenes in ${Math.round(body.ms)} ms  (${body.ua})`);
    res.writeHead(204).end();
    waiters.get(label)?.();
    waiters.get('*')?.();
  } else if (req.method === 'POST' && url.pathname === '/finish' && opts.serve) {
    res.writeHead(204).end();
    finish();
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(opts.port, opts.host, resolve));
const base = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${server.address().port}/`;

const timeout = (label) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no result after ${opts.timeout} s`)), opts.timeout * 1000).unref());

for (const browser of opts.browsers) {
  const profile = await mkdtemp(join(tmpdir(), 'pagetether-bake-'));
  const url = `${base}?label=${encodeURIComponent(browser.label)}`;
  const [bin, ...args] = browser.cmd.map((part) => part.replaceAll('{url}', url).replaceAll('{profile}', profile));
  const child = spawn(bin, args, { stdio: 'ignore' });
  const failed = new Promise((_, reject) => child.once('error', (err) => reject(new Error(`${browser.label}: ${err.message}`))));
  try {
    await Promise.race([new Promise((resolve) => waiters.set(browser.label, resolve)), failed, timeout(browser.label)]);
  } finally {
    child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
if (opts.wait > 0) {
  console.error(`open ${base}?label=NAME in ${opts.wait} more browser(s)`);
  const target = runs.length + opts.wait;
  while (runs.length < target) {
    await Promise.race([new Promise((resolve) => waiters.set('*', resolve)), timeout('--wait')]);
  }
}
if (opts.serve) {
  console.error(`serving ${base}?label=NAME until POST ${base}finish`);
  await finished;
}
server.close();
server.closeAllConnections();
if (runs.length === 0) throw new Error('no browser reported back');

// --- compare ----------------------------------------------------------------

const rounded = (vector) => vector.map((v) => Math.round(v) | 0);
const report = { runs: runs.map(({ label, ua, dpr, ms }) => ({ label, ua, dpr, msPerScene: +(ms / scenes.length).toFixed(3) })) };

if (opts.check) {
  // How many of the pool's scenes does each run answer with the baked digest?
  report.scenes = pool.length;
  for (const [at, run] of runs.entries()) {
    let right = 0;
    const wrong = [];
    pool.forEach((entry, i) => {
      const v = run.vectors[i];
      const d = v ? sceneDigest(rounded(v)) : null;
      if (d && d[0] === entry.digest[0] && d[1] === entry.digest[1]) right++;
      else wrong.push(i);
    });
    Object.assign(report.runs[at], { right, wrong: wrong.map((i) => ({ i, v: run.vectors[i] })) });
    console.error(`  ${run.label}: ${right}/${pool.length} correct`);
  }
  // For each scene some run got wrong, what a run that got it right measured.
  report.reference = {};
  for (const run of report.runs) {
    for (const { i } of run.wrong) {
      const good = runs.find((r, at) => r.vectors[i] && !report.runs[at].wrong.some((w) => w.i === i));
      if (good) report.reference[i] = good.vectors[i];
    }
  }
} else {
  const reasons = { kept: 0, failed: 0, disagree: 0, fragile: 0, empty: 0 };
  const kept = [];
  scenes.forEach((scene, i) => {
    const vectors = runs.map((run) => run.vectors[i]);
    const first = vectors[0];
    let verdict = 'kept';
    if (vectors.some((v) => !v || v.length !== first.length)) verdict = 'failed';
    else {
      const want = rounded(first);
      if (vectors.some((v) => rounded(v).some((n, k) => n !== want[k]))) verdict = 'disagree';
      // Zoom and each engine's sub-pixel grid move fractional values around by a
      // fraction of a pixel. Keep only layouts whose every number sits close to
      // a whole pixel (by default within 0.15), so that rounding always agrees.
      else if (vectors.some((v) => v.some((n) => Math.abs(n - Math.floor(n) - 0.5) < opts.margin))) verdict = 'fragile';
      else {
        let visible = 0;
        for (let k = 0; k < want.length; k += 4) if (want[k + 2] > 0 && want[k + 3] > 0) visible++;
        if (visible < (want.length / 4) * 0.6 || new Set(want).size < 12) verdict = 'empty';
      }
      if (verdict === 'kept') kept.push({ t: scene.t, c: scene.c, d: digestToHex(sceneDigest(want)) });
    }
    reasons[verdict]++;
  });
  report.candidates = scenes.length;
  report.reasons = reasons;
  const scenesOut = kept.slice(0, opts.count);
  console.error(`  candidates ${scenes.length}: ${Object.entries(reasons).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (scenesOut.length < opts.count) console.error(`  only ${scenesOut.length} of the ${opts.count} asked for: raise --candidates`);
  await writeFile(
    opts.out,
    JSON.stringify({
      v: 0,
      baked: { at: new Date().toISOString().slice(0, 10), runs: report.runs.map(({ label, ua, dpr }) => ({ label, ua, dpr })), candidates: scenes.length, reasons },
      scenes: scenesOut,
    }),
  );
  console.error(`  wrote ${scenesOut.length} scenes to ${opts.out}`);
}
if (opts.report) await writeFile(opts.report, JSON.stringify(report, null, 2));
