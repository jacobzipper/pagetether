// The attack lab: nine adversary strategies, each played for real against a
// fresh verifier on a simulated clock. No DOM in here, so the same scenarios run
// under `node --test` (test/lab.test.js) and in the page (site/app.js).
//
// Every scenario takes an environment and returns { lines, outcome, chart? }.
// Nothing in `lines` is scripted: each verdict is what the verifier answered.
//
//   env.probes    the page's answers to the formula probes
//   env.scenes    a rendering engine: scene -> digest. The page's own, and what
//                 an adversary has when they keep a real browser around.
//   env.pool      the scene pool the server starts with
//   env.nextPool  the pool it rotates to

import { Tether } from './lib/web.js';
import { domOracles } from './lib/probes.js';
import { b64u, formatToken } from './lib/core.js';
import { mintGenerator, token, beatMessage, advance } from './lab-client.js';
import { sceneDigest } from './lib/scenes.js';

const T0 = 1_800_000_000_000;
const PRICES = '/api/prices?page=1';
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** A verifier with default settings, a clock we control, and a log. */
function world(env) {
  const clock = { t: 0 };
  const lines = [];
  const server = new Tether({ now: () => T0 + clock.t, probes: domOracles, scenes: env.pool });
  const code = (result) => (result.ok ? 'ok' : result.error);

  return {
    clock,
    lines,
    server,
    note(text) {
      lines.push({ at: clock.t, who: 'note', text });
    },
    /** One request, logged. */
    send(who, text, tok, method = 'GET', target = PRICES, body) {
      const result = server.verify({ token: tok, method, target, body });
      lines.push({ at: clock.t, who, text, code: code(result) });
      return result;
    },
    /** One request, not logged: for the bulk runs. Returns the verdict code. */
    quiet(tok, method, target) {
      return code(server.verify({ token: tok, method, target }));
    },
    beat(who, text, gen) {
      const result = server.beat(beatMessage(gen));
      const line = { at: clock.t, who, text, code: code(result) };
      if (result.retryAfterMs) line.detail = `retry in ${Math.round(result.retryAfterMs / 1000)} s`;
      lines.push(line);
      return result;
    },
    tally(who, text, counts) {
      lines.push({ at: clock.t, who, text, tally: counts });
    },
  };
}

const bump = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

// --- 1 ----------------------------------------------------------------------

async function cold(env) {
  const w = world(env);
  const page = await mintGenerator(w.server, env.probes, env.scenes);
  w.note('A real page is open and has minted a generator.');
  w.send('page', `GET ${PRICES}`, token(page, 0, 'GET', PRICES));

  w.clock.t = 1000;
  w.send('adversary', `GET ${PRICES} with no token`, null);
  w.send(
    'adversary',
    'a well-formed token made of random bytes',
    formatToken({ gid: b64u(random(16)), epoch: 0, ctr: 0, mac: random(32) }),
  );
  w.send(
    'adversary',
    "the page's generator id (it is visible on the wire) with a guessed proof",
    formatToken({ gid: page.gid, epoch: 0, ctr: 1, mac: random(32) }),
  );

  w.clock.t = 2000;
  const target = '/api/prices?page=2';
  w.send('page', `GET ${target}`, token(page, 1, 'GET', target), 'GET', target);

  return {
    lines: w.lines,
    outcome: {
      kind: 'stopped',
      title: 'Stopped',
      text: 'Without the key there is nothing to send: the proof is 256 bits. The guesses also cost the real page nothing. A failed proof is thrown out before the server touches any state, so counter 1 was still there for the page to use.',
    },
  };
}

// --- 2 ----------------------------------------------------------------------

async function replay(env) {
  const w = world(env);
  let page = await mintGenerator(w.server, env.probes, env.scenes);
  const captured = token(page, 0, 'GET', PRICES);
  w.send('page', `GET ${PRICES}`, captured);
  w.note('The adversary copies that request out of DevTools, headers and all.');

  w.clock.t = 2000;
  w.send('adversary', 'the same request, sent again', captured);

  w.clock.t = 20_000;
  const next = w.beat('page', 'beat: trade the epoch 0 key for epoch 1', page);
  page = advance(page, next, env.probes, env.scenes);

  w.clock.t = 26_000;
  w.send('adversary', 'the same request, 26 seconds after it was captured', captured);

  return {
    lines: w.lines,
    outcome: {
      kind: 'stopped',
      title: 'Stopped',
      text: 'Each counter is accepted once. A few seconds after the page beats, the key that signed the captured request no longer exists on the server at all.',
    },
  };
}

// --- 3 ----------------------------------------------------------------------

async function retarget(env) {
  const w = world(env);
  const page = await mintGenerator(w.server, env.probes, env.scenes);
  const held = token(page, 0, 'GET', PRICES);
  w.note(`The adversary holds one token the page made for GET ${PRICES}. It has not been spent yet.`);

  w.clock.t = 1000;
  w.send('adversary', 'that token on /api/prices?page=2', held, 'GET', '/api/prices?page=2');
  w.send('adversary', 'that token on /api/export?all=1', held, 'GET', '/api/export?all=1');
  w.send('adversary', 'that token on POST /api/search with a body', held, 'POST', '/api/search', '{"q":"everything"}');
  const [v, gid, epoch, , mac] = held.split('.');
  w.send('adversary', 'the counter edited from 0 to 1, hoping for a second use', [v, gid, epoch, 1, mac].join('.'));
  w.send('adversary', 'the exact request it was made for', held);
  w.send('adversary', 'and that request once more', held);

  return {
    lines: w.lines,
    outcome: {
      kind: 'stopped',
      title: 'Stopped',
      text: 'A token is a receipt for one specific request: this method, this path and query, this body, this counter. The adversary got the single response the page was about to fetch anyway.',
    },
  };
}

// --- 4 ----------------------------------------------------------------------

async function stale(env) {
  const w = world(env);
  const gen = await mintGenerator(w.server, env.probes, env.scenes);
  w.note(
    'The adversary opens the real page, lets it mint, and gets the key bytes out (we grant them that). They close the browser and a script takes over at one request a second. It signs correctly but treats the key like a cookie: it never beats.',
  );

  const windows = 5;
  const sent = [];
  const accepted = [];
  for (let win = 0; win < windows; win++) {
    const counts = {};
    for (let s = win * 30; s < (win + 1) * 30; s++) {
      w.clock.t = s * 1000;
      const target = `/api/prices?page=${s + 1}`;
      bump(counts, w.quiet(token(gen, s, 'GET', target), 'GET', target));
    }
    w.tally('adversary', `${win * 30} to ${(win + 1) * 30} s: 30 requests`, counts);
    sent.push(30);
    accepted.push(counts.ok ?? 0);
  }

  const total = accepted.reduce((a, b) => a + b, 0);
  return {
    lines: w.lines,
    chart: {
      title: 'Requests per 30 seconds after the browser is closed',
      axis: 'Window',
      labels: Array.from({ length: windows }, (_, i) => `${i * 30}–${(i + 1) * 30} s`),
      sent,
      accepted,
    },
    outcome: {
      kind: 'stopped',
      title: 'Stopped after 35 seconds',
      text: `The stolen key bought ${total} requests: one epoch plus the grace period. Then the server deleted the generator because nobody beat. A session cookie lifted the same way keeps working for hours or days.`,
    },
  };
}

// --- 5 ----------------------------------------------------------------------

async function flood(env) {
  const w = world(env);
  let gen = await mintGenerator(w.server, domOracles, env.scenes);
  w.note('A complete port of the client: right probe answers, beats on time. It wants 20 requests a second.');

  const epochs = 5;
  const perEpoch = 400;
  const sent = [];
  const accepted = [];
  for (let e = 0; e < epochs; e++) {
    const base = e * 20_000;
    const counts = {};
    for (let i = 0; i < perEpoch; i++) {
      w.clock.t = base + i * 50;
      if (e === 0 && i === 100) w.beat('adversary', 'beat early to get a fresh budget', gen);
      const target = `/api/prices?page=${e * perEpoch + i + 1}`;
      bump(counts, w.quiet(token(gen, i, 'GET', target), 'GET', target));
    }
    w.tally('adversary', `epoch ${e}: ${perEpoch} requests in 20 s`, counts);
    if (e === 0) {
      const target = '/api/prices?page=9001';
      w.send('adversary', 'a new request signed with counter 0 again', token(gen, 0, 'GET', target), 'GET', target);
    }
    sent.push(perEpoch);
    accepted.push(counts.ok ?? 0);

    w.clock.t = base + 20_000;
    const next = w.beat('adversary', `beat at the earliest allowed moment, for epoch ${e + 1}`, gen);
    gen = advance(gen, next, domOracles, env.scenes);
  }

  return {
    lines: w.lines,
    chart: {
      title: 'Requests per epoch: asked for 20 a second',
      axis: 'Epoch',
      labels: Array.from({ length: epochs }, (_, i) => `epoch ${i}`),
      sent,
      accepted,
      cap: w.server.budget,
    },
    outcome: {
      kind: 'stopped',
      title: 'Capped at 3 a second',
      text: 'Counters are the budget. There are 60 valid ones per epoch, each works once, and a beat is refused until 20 seconds in. The script sent 2,000 requests and 300 were answered, which is exactly what one open page could have fetched.',
    },
  };
}

// --- 6 ----------------------------------------------------------------------

async function clone(env) {
  const w = world(env);
  const workers = 8;
  const gen = await mintGenerator(w.server, domOracles, env.scenes);
  w.note('One generator, minted once, then copied to 8 workers. Each runs on its own like a page would: its own counter, 3 requests a second.');

  const sent = new Array(workers).fill(0);
  const accepted = new Array(workers).fill(0);
  const counts = {};
  for (let i = 0; i < 60; i++) {
    for (let k = 0; k < workers; k++) {
      const wk = (i + k) % workers;
      w.clock.t = i * 333 + k * 10;
      const target = `/api/prices?page=${wk * 1000 + i + 1}`;
      const verdict = w.quiet(token(gen, i, 'GET', target), 'GET', target);
      bump(counts, verdict);
      sent[wk]++;
      if (verdict === 'ok') accepted[wk]++;
    }
  }
  w.tally('adversary', 'epoch 0: 8 workers × 60 requests', counts);

  w.clock.t = 20_000;
  const first = w.beat('adversary', 'worker 1 beats', gen);
  w.clock.t = 21_500;
  w.beat('adversary', 'worker 2 beats 1.5 s later and gets the same answer (treated as a retry)', gen);
  w.clock.t = 26_000;
  w.beat('adversary', 'worker 5 beats 6 s later, with the epoch 0 key', gen);
  w.clock.t = 27_000;
  w.beat('adversary', 'worker 6 beats', gen);
  const ahead = advance(gen, first, domOracles, env.scenes);
  const target = '/api/prices?page=2';
  w.send('adversary', 'worker 1, now on the epoch 1 key, sends a request', token(ahead, 0, 'GET', target), 'GET', target);

  return {
    lines: w.lines,
    chart: {
      title: 'Requests in epoch 0, by worker',
      axis: 'Worker',
      labels: Array.from({ length: workers }, (_, i) => `W${i + 1}`),
      sent,
      accepted,
    },
    outcome: {
      kind: 'stopped',
      title: 'Stopped: one budget, then a fork',
      text: 'Eight workers shared one allowance: 60 answers between them, 420 collisions. When their heartbeats drifted apart the server saw two holders of the same key and deleted the generator for all of them. Coordinating perfectly would keep it alive, and they would still be sharing 60 per epoch, so copying buys nothing.',
    },
  };
}

// --- 7 ----------------------------------------------------------------------

const boxes = (node) => node.slice(1).reduce((n, child) => n + boxes(child), 1);
// What a DOM without a layout engine reports: every box at 0, 0 and 0 by 0.
const zeros = (scene) => sceneDigest(new Array(4 * boxes(scene.t)).fill(0));
// A rough guess: every box as wide as the root, stacked 16 px apart.
const stacked = (scene) => {
  const width = Number(/width:(\d+)px/.exec(scene.c)?.[1] ?? 0);
  return sceneDigest(Array.from({ length: boxes(scene.t) }, (_, i) => [0, 16 * i, width, 16]).flat());
};

async function noBrowser(env) {
  const w = world(env);
  w.note(
    'The client an agent writes after reading all of your JavaScript: the protocol reimplemented exactly, the formula probes answered correctly, and no browser. Each epoch the server also sends two layout scenes, and there is no formula for those.',
  );

  const first = await mintGenerator(w.server, domOracles, zeros);
  w.note('Mint succeeds. The scenes are "rendered" in a DOM library with no layout engine, which reports every box as 0 by 0.');
  w.send('adversary', `GET ${PRICES}`, token(first, 0, 'GET', PRICES));

  w.clock.t = 2000;
  const second = await mintGenerator(w.server, domOracles, stacked);
  w.note('A new generator and a rough guess at the layout: every box full width, stacked.');
  w.send('adversary', `GET ${PRICES}`, token(second, 0, 'GET', PRICES));
  w.note('Both rejections are the error a forged token gets. The server never says a scene was wrong, which one, or by how much.');

  w.clock.t = 4000;
  const page = await mintGenerator(w.server, env.probes, env.scenes);
  w.send('page', `GET ${PRICES} from a real page, same server`, token(page, 0, 'GET', PRICES));

  return {
    lines: w.lines,
    outcome: {
      kind: 'stopped',
      title: 'Stopped',
      text: 'The expected answers were measured in real browsers when the pool was baked, and only the server has them. Nothing in the client says how to compute them, so reading the code does not help. Getting them right takes an engine that resolves the cascade and lays out blocks, floats, flex and grid the way browsers do. The next two attacks bring one.',
    },
  };
}

// --- 8 ----------------------------------------------------------------------

async function table(env) {
  const w = world(env);
  const answers = new Map(env.pool.map((scene) => [scene.c, env.scenes(scene)]));
  let hits = 0;
  let misses = 0;
  const lookup = (scene) => {
    const known = answers.get(scene.c);
    if (known) hits++;
    else misses++;
    return known ?? zeros(scene);
  };
  w.note(
    `The adversary rendered all ${env.pool.length} scenes in the server's pool in a real browser and kept the answers. That is generous: a client only ever sees the two scenes each epoch sends it. The browser is now closed and a script answers from the table.`,
  );

  let gen = await mintGenerator(w.server, domOracles, lookup);
  const epochs = 5;
  const sent = [];
  const accepted = [];
  for (let e = 0; e < epochs; e++) {
    const base = e * 20_000;
    const counts = {};
    for (let i = 0; i < 60; i++) {
      w.clock.t = base + i * 333;
      const target = `/api/prices?page=${e * 60 + i + 1}`;
      bump(counts, w.quiet(token(gen, i, 'GET', target), 'GET', target));
    }
    w.tally('adversary', `epoch ${e}: 60 requests in 20 s`, counts);
    sent.push(60);
    accepted.push(counts.ok ?? 0);

    w.clock.t = base + 20_000;
    if (e === 1) {
      w.server.setScenes(env.nextPool);
      w.note('The operator bakes a fresh pool and swaps it in. Pages that are open do not notice: they render whatever they are sent.');
    }
    const next = w.beat('adversary', `beat for epoch ${e + 1}`, gen);
    if (next.ok) gen = advance(gen, next, domOracles, lookup);
  }

  return {
    lines: w.lines,
    chart: {
      title: 'Requests per epoch: answering scenes from a table',
      axis: 'Epoch',
      labels: Array.from({ length: epochs }, (_, i) => `epoch ${i}`),
      sent,
      accepted,
      cap: w.server.budget,
    },
    outcome: {
      kind: 'stopped',
      title: 'Stopped at the next rotation',
      text: `The table answered ${hits} scenes, then met ${misses} it had never seen, and the key it derived was wrong from then on. A table is a cache in front of a real browser. It lasts until the pool changes, and baking a pool costs the operator a few minutes of browser time. An adversary who wants to keep up has to keep a browser running, which is the last attack.`,
    },
  };
}

// --- 9 ----------------------------------------------------------------------

async function fullPort(env) {
  const w = world(env);
  let gen = await mintGenerator(w.server, domOracles, env.scenes);
  w.note(
    'The best the adversary can do: the whole client reimplemented, a real browser kept running to render every scene the server sends, the pace kept under the budget, every beat on time.',
  );

  const epochs = 5;
  const sent = [];
  const accepted = [];
  for (let e = 0; e < epochs; e++) {
    const base = e * 20_000;
    const counts = {};
    for (let i = 0; i < 60; i++) {
      w.clock.t = base + i * 333;
      const target = `/api/prices?page=${e * 60 + i + 1}`;
      bump(counts, w.quiet(token(gen, i, 'GET', target), 'GET', target));
    }
    w.tally('adversary', `epoch ${e}: 60 requests in 20 s`, counts);
    sent.push(60);
    accepted.push(counts.ok ?? 0);
    w.clock.t = base + 20_000;
    const next = w.beat('adversary', `beat for epoch ${e + 1}`, gen);
    gen = advance(gen, next, domOracles, env.scenes);
  }

  return {
    lines: w.lines,
    chart: {
      title: 'Requests per epoch: a browser in the loop, at page speed',
      axis: 'Epoch',
      labels: Array.from({ length: epochs }, (_, i) => `epoch ${i}`),
      sent,
      accepted,
      cap: w.server.budget,
    },
    outcome: {
      kind: 'works',
      title: 'This one works, at page speed',
      text: 'No protocol can stop code that does everything the page does, and pagetether does not claim to. What changed is the shape of the scraper. It is no longer an HTTP client: it carries a browser engine, it gets 3 requests a second per generator, and it has to keep answering a program the server rerolls every epoch. One browser can render scenes for many generators, so scenes do not limit scale by themselves. The budget and your mint gate do: going faster means more generators, and each one has to get through the gate.',
    },
  };
}

export const scenarios = [
  {
    id: 'cold',
    title: 'Call the API without a page',
    blurb: 'The starting point for any scraper: hit the endpoint directly, with no token, a made-up one, or a guess built around a real generator id.',
    run: cold,
  },
  {
    id: 'replay',
    title: 'Replay a captured request',
    blurb: 'Copy a working request out of the network tab and send it again, the way a session cookie would be reused.',
    run: replay,
  },
  {
    id: 'retarget',
    title: 'Move a token to another request',
    blurb: 'Take a valid token and attach it to a different URL, a different body, or a different counter.',
    run: retarget,
  },
  {
    id: 'stale',
    title: 'Lift the key, close the browser',
    blurb: 'Mint in a real browser, extract the key, then run headless with it. This is "mint once, hammer forever", the attack the protocol exists for.',
    run: stale,
  },
  {
    id: 'flood',
    title: 'Go faster than a page',
    blurb: 'With a complete port of the client in hand, ask for 20 requests a second instead of 3.',
    run: flood,
  },
  {
    id: 'clone',
    title: 'Copy one generator to 8 workers',
    blurb: 'Pay for one generator and fan it out across a worker pool.',
    run: clone,
  },
  {
    id: 'no-browser',
    title: 'Port the client, skip the browser',
    blurb: 'Hand an agent the JavaScript and a network capture and let it write a client that needs no browser. This is the "turn any website into an API" attack.',
    run: noBrowser,
  },
  {
    id: 'table',
    title: 'Learn the answers, then go headless',
    blurb: 'Use a real browser once to collect the answer to every layout scene, then answer from a lookup table.',
    run: table,
  },
  {
    id: 'full-port',
    title: 'Keep a real browser in the loop',
    blurb: 'Reimplement the client completely, keep a browser running to render whatever the server asks for, and behave exactly like a page.',
    run: fullPort,
  },
];
