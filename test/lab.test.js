// The site's attack lab makes claims about what the verifier does. These tests
// run the same scenarios and pin every verdict the page will show.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../site/lab.js';
import { readFile } from 'node:fs/promises';
import { domOracles } from '../src/probes.js';
import { digestFromHex } from '../src/scenes.js';

// The example pool was baked in real browsers (scripts/bake.js). Node has no
// layout engine, so here a lookup of those baked answers stands in for one.
const example = JSON.parse(await readFile(new URL('../pools/example.json', import.meta.url), 'utf8')).scenes;
const baked = new Map(example.map((entry) => [entry.c, digestFromHex(entry.d)]));
const half = example.length >> 1;
const env = {
  probes: domOracles,
  scenes: (scene) => baked.get(scene.c),
  pool: example.slice(0, half),
  nextPool: example.slice(half),
};

const run = async (id) => {
  const scenario = scenarios.find((s) => s.id === id);
  assert.ok(scenario, `no scenario ${id}`);
  return scenario.run(env);
};
const codes = (out, who) => out.lines.filter((l) => l.code && (!who || l.who === who)).map((l) => l.code);
const tallies = (out) => out.lines.filter((l) => l.tally).map((l) => l.tally);

test('lab: calling the API without a page', async () => {
  const out = await run('cold');
  assert.deepEqual(codes(out, 'adversary'), ['missing', 'unknown_generator', 'bad_mac']);
  assert.deepEqual(codes(out, 'page'), ['ok', 'ok']);
  assert.equal(out.outcome.kind, 'stopped');
});

test('lab: replaying a captured request', async () => {
  const out = await run('replay');
  assert.deepEqual(codes(out, 'adversary'), ['replay', 'stale_epoch']);
  assert.deepEqual(codes(out, 'page'), ['ok', 'ok']);
});

test('lab: moving a token to another request', async () => {
  const out = await run('retarget');
  assert.deepEqual(codes(out), ['bad_mac', 'bad_mac', 'bad_mac', 'bad_mac', 'ok', 'replay']);
});

test('lab: a lifted key dies one epoch plus grace after the page closes', async () => {
  const out = await run('stale');
  assert.deepEqual(tallies(out), [
    { ok: 30 },
    { ok: 6, expired: 1, unknown_generator: 23 },
    { unknown_generator: 30 },
    { unknown_generator: 30 },
    { unknown_generator: 30 },
  ]);
  assert.deepEqual(out.chart.accepted, [30, 6, 0, 0, 0]);
  assert.match(out.outcome.text, /bought 36 requests/);
});

test('lab: flooding is capped at the budget', async () => {
  const out = await run('flood');
  assert.deepEqual(tallies(out), new Array(5).fill({ ok: 60, over_budget: 340 }));
  assert.deepEqual(codes(out), ['too_early', 'replay', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(out.chart.accepted, [60, 60, 60, 60, 60]);
  assert.equal(out.chart.cap, 60);
});

test('lab: clones share one budget and fork', async () => {
  const out = await run('clone');
  assert.deepEqual(tallies(out), [{ ok: 60, replay: 420 }]);
  assert.deepEqual(codes(out), ['ok', 'ok', 'fork', 'unknown_generator', 'unknown_generator']);
  assert.equal(out.chart.accepted.reduce((a, b) => a + b, 0), 60);
  assert.deepEqual(out.chart.sent, new Array(8).fill(60));
});

test('lab: a port without a browser gets the wrong key', async () => {
  const out = await run('no-browser');
  assert.deepEqual(codes(out, 'adversary'), ['bad_mac', 'bad_mac']);
  assert.deepEqual(codes(out, 'page'), ['ok']);
});

test('lab: a table of harvested answers works until the pool is rotated', async () => {
  const out = await run('table');
  assert.deepEqual(tallies(out), [
    { ok: 60 },
    { ok: 60 },
    { bad_mac: 60 },
    { bad_mac: 46, expired: 1, unknown_generator: 13 },
    { unknown_generator: 60 },
  ]);
  // The beat that crosses the rotation is still accepted: it is signed with the
  // last good key. What it returns is a program the table cannot answer.
  assert.deepEqual(codes(out), ['ok', 'ok', 'bad_mac', 'unknown_generator', 'unknown_generator']);
  assert.deepEqual(out.chart.accepted, [60, 60, 0, 0, 0]);
  assert.match(out.outcome.text, /answered 4 scenes, then met 2 it had never seen/);
});

test('lab: there are nine scenarios and only the last one works', async () => {
  assert.equal(scenarios.length, 9);
  for (const scenario of scenarios) {
    const out = await scenario.run(env);
    assert.equal(out.outcome.kind, scenario.id === 'full-port' ? 'works' : 'stopped', scenario.id);
  }
  assert.equal(scenarios.at(-1).id, 'full-port');
});

test('lab: a browser in the loop works, and only at the capped rate', async () => {
  const out = await run('full-port');
  assert.deepEqual(tallies(out), new Array(5).fill({ ok: 60 }));
  assert.deepEqual(codes(out), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(out.outcome.kind, 'works');
});
