#!/usr/bin/env node
// What happens to a scene pool in JavaScript "DOMs" that have no layout engine.
// Install whichever of jsdom, happy-dom and linkedom you want measured.
//
//   node scripts/measure-no-browser.mjs pool.json

import { readFile } from 'node:fs/promises';
import { loadPool, measureScene, sceneDigest } from '../src/scenes.js';

const pool = loadPool(JSON.parse(await readFile(process.argv[2], 'utf8')));
const makers = {
  jsdom: async () => new (await import('jsdom')).JSDOM('<!doctype html><html><body></body></html>').window.document,
  'happy-dom': async () => new (await import('happy-dom')).Window().document,
  linkedom: async () => (await import('linkedom')).parseHTML('<!doctype html><html><body></body></html>').document,
};
const out = {};
for (const [name, make] of Object.entries(makers)) {
  let document;
  try {
    document = await make();
  } catch (err) {
    out[name] = { skipped: String(err.message).split('\n')[0] };
    continue;
  }
  let right = 0;
  const outcomes = {};
  for (const entry of pool) {
    let outcome;
    try {
      const values = measureScene(entry, { document });
      const d = sceneDigest(values);
      if (d[0] === entry.digest[0] && d[1] === entry.digest[1]) right++;
      outcome = values.every((v) => v === 0) ? 'every box measured as 0, 0, 0, 0' : values.some(Number.isNaN) ? 'NaN' : 'other numbers';
    } catch (err) {
      outcome = `threw: ${String(err.message).split('\n')[0].slice(0, 80)}`;
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  out[name] = { right, of: pool.length, outcomes };
}
console.log(JSON.stringify(out, null, 2));
