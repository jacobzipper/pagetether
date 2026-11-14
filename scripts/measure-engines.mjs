#!/usr/bin/env node
// Drive scripts/bake.js with Playwright: bake a pool across engines, or check a
// pool against a wide matrix of engines and settings. This is how the numbers
// in docs/DESIGN.md ("Scenes: measurements") were produced. Not needed to use
// pagetether, and Playwright is not a dependency: install it yourself.
//
//   node scripts/measure-engines.mjs bake  pool.json [count] [candidates]
//   node scripts/measure-engines.mjs check pool.json
//
//   ENGINES=chromium,firefox   limit the engines (default: all three)
//   PLAYWRIGHT_FROM=/dir       resolve `playwright` from another directory
//                              (an older release, for older browsers)
//   TAG=old-                   prefix for run labels
//   MATRIX=small               only a handful of settings per engine
//   REPORT=file.json           where the report goes (default: <pool>.report.json)
//   ATTACH=1                   use a `bake.js --serve --port 8799` that is already
//                              running and leave it running, so that several
//                              Playwright releases can feed one bake

import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(process.env.PLAYWRIGHT_FROM ? `${process.env.PLAYWRIGHT_FROM}/x.js` : import.meta.url);
const pw = require('playwright');
const [mode, file, count = '150', candidates = '1500'] = process.argv.slice(2);
if (!['bake', 'check'].includes(mode) || !file) throw new Error('usage: measure-engines.mjs bake|check pool.json');
const engines = (process.env.ENGINES ?? 'chromium,firefox,webkit').split(',');
const tag = process.env.TAG ?? '';
const port = 8799;
const base = `http://127.0.0.1:${port}/`;

// One configuration = one browser launch. `context` is Playwright context
// options, `query` the flags of the bake page, `prefs`/`args` engine settings.
const configs = [];
const add = (engine, name, cfg = {}) => engines.includes(engine) && configs.push({ engine, label: `${tag}${engine}:${name}`, ...cfg });

if (mode === 'bake' && process.env.MATRIX === 'small') {
  // An older release in the bake: its default settings and one real zoom.
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    add(engine, 'default');
    add(engine, 'root-zoom-0.9', { query: '&zoom=0.9' });
  }
} else if (mode === 'bake') {
  // The recipe an operator would follow: three engines, each at several zoom
  // levels. Zoom is what exposes layouts that only just fit. Emulated scale
  // factors are not enough on their own: CSS zoom on the root and a real
  // device scale factor round differently, so both are in the recipe.
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    for (const dpr of [1, 0.9, 1.1, 1.25, 1.5, 1.75, 2]) add(engine, `dpr${dpr}`, { context: { deviceScaleFactor: dpr } });
    for (const zoom of [0.9, 1.1]) add(engine, `root-zoom-${zoom}`, { query: `&zoom=${zoom}` });
  }
  for (const scale of [0.9, 1.1]) add('chromium', `force-scale-${scale}`, { launch: { args: [`--force-device-scale-factor=${scale}`] } });
} else if (process.env.MATRIX === 'small') {
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    add(engine, 'default');
    for (const dpr of [1.33, 3]) add(engine, `dpr${dpr}`, { context: { deviceScaleFactor: dpr } });
    add(engine, 'root-zoom-0.8', { query: '&zoom=0.8' });
  }
} else {
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    add(engine, 'default');
    // Scale factors the pool was not baked at.
    for (const dpr of [0.5, 0.67, 0.75, 0.8, 1.2, 1.33, 2.25, 2.5, 2.625, 3, 3.5, 4]) add(engine, `dpr${dpr}`, { context: { deviceScaleFactor: dpr } });
    add(engine, 'phone-viewport', { context: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 3 } });
    add(engine, 'huge-viewport', { context: { viewport: { width: 3840, height: 2160 } } });
    add(engine, 'dark', { context: { colorScheme: 'dark' } });
    add(engine, 'forced-colors', { context: { forcedColors: 'active' } });
    add(engine, 'reduced-motion', { context: { reducedMotion: 'reduce' } });
    add(engine, 'rtl-page', { query: '&rtl=1' });
    add(engine, 'hostile-page-css', { query: '&hostile=1' });
    // Real zoom the pool was not baked at.
    for (const zoom of [0.67, 0.8, 1.25, 1.5]) add(engine, `root-zoom-${zoom}`, { query: `&zoom=${zoom}` });
    add(engine, 'root-scale-0.8', { query: '&scale=0.8' });
  }
  add('chromium', 'mobile-emulation', { context: { ...pw.devices['Pixel 7'] } });
  add('webkit', 'iphone-emulation', { context: { ...pw.devices['iPhone 14'] } });
  add('chromium', 'new-headless', { launch: { channel: 'chromium' } });
  add('chromium', 'google-chrome', { launch: { channel: 'chrome' } });
  for (const scale of [0.8, 1.25, 1.5]) add('chromium', `force-scale-${scale}`, { launch: { args: [`--force-device-scale-factor=${scale}`] } });
  add('chromium', 'min-font-24', { launch: { args: ['--blink-settings=minimumFontSize=24,minimumLogicalFontSize=24'] } });
  add('firefox', 'zoom-pref-1.1', { launch: { firefoxUserPrefs: { 'layout.css.devPixelsPerPx': '1.1' } } });
  add('firefox', 'zoom-pref-1.33', { launch: { firefoxUserPrefs: { 'layout.css.devPixelsPerPx': '1.33' } } });
  add('firefox', 'min-font-24', { launch: { firefoxUserPrefs: { 'font.minimum-size.x-western': 24 } } });
  add('firefox', 'resist-fingerprinting', { launch: { firefoxUserPrefs: { 'privacy.resistFingerprinting': true } } });
  add('firefox', 'no-page-fonts', { launch: { firefoxUserPrefs: { 'browser.display.use_document_fonts': 0 } } });
}

const bakeJs = fileURLToPath(new URL('./bake.js', import.meta.url));
const args = mode === 'bake' ? ['--out', file, '--count', count, '--candidates', candidates] : ['--check', file];
const attach = Boolean(process.env.ATTACH);
const baker = attach ? null : spawn(process.execPath, [bakeJs, ...args, '--serve', '--port', String(port), '--report', process.env.REPORT ?? `${file}.report.json`], { stdio: 'inherit' });
const exited = baker ? new Promise((resolve) => baker.once('exit', resolve)) : null;
// node:http rather than fetch, so that a proxy in the environment is not used
// for a server on this machine.
const call = (method, path) =>
  new Promise((resolve, reject) => {
    http.request(`${base}${path}`, { method }, (res) => res.resume().once('end', resolve)).once('error', reject).end();
  });
for (let i = 0; ; i++) {
  try {
    await call('GET', '');
    break;
  } catch {
    if (i > 300) throw new Error('bake.js did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const failed = [];
process.once('exit', () => baker?.kill());
for (const cfg of configs) {
  let browser;
  try {
    browser = await pw[cfg.engine].launch(cfg.launch ?? {});
    const version = browser.version();
    const page = await (await browser.newContext(cfg.context ?? {})).newPage();
    await page.goto(`${base}?label=${encodeURIComponent(`${cfg.label}@${version}`)}${cfg.query ?? ''}`);
    await page.waitForFunction(() => document.getElementById('s').textContent.startsWith('done'), null, { timeout: 180_000 });
  } catch (err) {
    failed.push(cfg.label);
    console.error(`  ${cfg.label}: DID NOT RUN (${String(err.message).split('\n')[0]})`);
  } finally {
    await browser?.close().catch(() => {});
  }
}
if (!attach) {
  await call('POST', 'finish');
  await exited;
}
if (failed.length > 0) console.error(`did not run: ${failed.join(', ')}`);
