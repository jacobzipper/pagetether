// The attack lab: eight adversary strategies, each played for real against a
// fresh verifier on a simulated clock. No DOM in here, so the same scenarios run
// under `node --test` (test/lab.test.js) and in the page (site/app.js).
//
// Every scenario returns { lines, outcome, chart? }. Nothing in `lines` is
// scripted: each verdict is what the verifier answered.

import { Tether } from '../src/web.js';
import { domOracles } from '../src/probes.js';
import { b64u, formatToken } from '../src/core.js';
import { mintGenerator, token, beatMessage, advance } from './lab-client.js';

const T0 = 1_800_000_000_000;
const PRICES = '/api/prices?page=1';
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** A verifier with default settings, a clock we control, and a log. */
function world() {
  const clock = { t: 0 };
  const lines = [];
  const server = new Tether({ now: () => T0 + clock.t, probes: domOracles });
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

async function cold(pageProbes) {
  const w = world();
  const page = await mintGenerator(w.server, pageProbes);
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

async function replay(pageProbes) {
  const w = world();
  let page = await mintGenerator(w.server, pageProbes);
  const captured = token(page, 0, 'GET', PRICES);
  w.send('page', `GET ${PRICES}`, captured);
  w.note('The adversary copies that request out of DevTools, headers and all.');

  w.clock.t = 2000;
  w.send('adversary', 'the same request, sent again', captured);

  w.clock.t = 20_000;
  const next = w.beat('page', 'beat: trade the epoch 0 key for epoch 1', page);
  page = advance(page, next, pageProbes);

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

async function retarget(pageProbes) {
  const w = world();
  const page = await mintGenerator(w.server, pageProbes);
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

async function stale(pageProbes) {
  const w = world();
  const gen = await mintGenerator(w.server, pageProbes);
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

async function flood() {
  const w = world();
  let gen = await mintGenerator(w.server, domOracles);
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
    gen = advance(gen, next, domOracles);
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

async function clone() {
  const w = world();
  const workers = 8;
  const gen = await mintGenerator(w.server, domOracles);
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
  const ahead = advance(gen, first, domOracles);
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

async function noBrowser(pageProbes) {
  const w = world();
  w.note('A script with no browser behind it. It speaks the protocol correctly but has no layout engine to answer the probes.');

  const zero = { box: () => 0, calc: () => 0 };
  const first = await mintGenerator(w.server, zero);
  w.note('Mint succeeds. The noise program runs with every probe stubbed to return 0.');
  w.send('adversary', `GET ${PRICES}`, token(first, 0, 'GET', PRICES));

  w.clock.t = 2000;
  const echo = { box: (arg) => arg & 0xff, calc: (arg) => arg & 0xff };
  const second = await mintGenerator(w.server, echo);
  w.note('A new generator, and a different guess: return the low byte of the argument.');
  w.send('adversary', `GET ${PRICES}`, token(second, 0, 'GET', PRICES));
  w.note('Both rejections are the error a forged token gets. The server never says a probe was wrong, or which one.');

  w.clock.t = 4000;
  const page = await mintGenerator(w.server, pageProbes);
  w.send('page', `GET ${PRICES} from a real page, same server`, token(page, 0, 'GET', PRICES));

  return {
    lines: w.lines,
    outcome: {
      kind: 'stopped',
      title: 'Stopped, for a naive port',
      text: 'The probe answers are folded into the key and never sent, so a wrong environment produces a wrong key and an ordinary-looking failure. The bundled probes are examples with public answers, though. Someone who reads them can compute the right values, which is the next attack.',
    },
  };
}

// --- 8 ----------------------------------------------------------------------

async function fullPort() {
  const w = world();
  let gen = await mintGenerator(w.server, domOracles);
  w.note('The best the adversary can do without a browser: the whole client reimplemented, the probe answers computed by formula, the pace kept under the budget, every beat on time.');

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
    gen = advance(gen, next, domOracles);
  }

  return {
    lines: w.lines,
    chart: {
      title: 'Requests per epoch: a full port at page speed',
      axis: 'Epoch',
      labels: Array.from({ length: epochs }, (_, i) => `epoch ${i}`),
      sent,
      accepted,
      cap: w.server.budget,
    },
    outcome: {
      kind: 'works',
      title: 'This one works, at page speed',
      text: 'No protocol can stop code that does everything the page does, and pagetether does not claim to. What changed is the price. The scraper gets 3 requests a second per generator and has to keep executing a program the server rerolls every epoch. Going faster means more generators, and each one has to get through your mint gate. Probes that are harder to compute than these examples push the adversary back into a real browser.',
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
    blurb: 'Reimplement the protocol in a script and stub out the parts that need a real page.',
    run: noBrowser,
  },
  {
    id: 'full-port',
    title: 'Port everything, fake the probes',
    blurb: 'Reimplement the client completely, including the right probe answers, and behave exactly like a page.',
    run: fullPort,
  },
];
