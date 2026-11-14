// The site's interactive pieces: the live generator in the hero (the real
// client against the real verifier, both in this tab, in real time), the scene
// viewer (this browser laying out scenes from the example pool) and the attack
// lab (site/lab.js scenarios on a simulated clock).

import { Tether } from '../src/web.js';
import { TetherClient } from '../src/client.js';
import { domProbes, domOracles } from '../src/probes.js';
import { TOKEN_HEADER, ERROR_HEADER } from '../src/core.js';
import { domScenes, measureScene, sceneDigest, digestToHex, digestFromHex } from '../src/scenes.js';
import { scenarios } from './lab.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REASONS = {
  missing: 'no token on the request',
  malformed: 'not a token',
  unknown_generator: 'the server has no such generator',
  expired: 'nobody beat in time, so the generator was deleted',
  stale_epoch: 'signed with a key the server has already replaced',
  bad_mac: 'the proof does not match this request',
  over_budget: 'past the last counter this epoch allows',
  replay: 'that counter has already been spent',
  too_early: 'a beat is refused this early in the epoch',
  fork: 'two holders of one key, so the generator was deleted',
};

/** A status mark: an icon in the status colour, with the label in text ink beside it. */
function status(ok, label) {
  const wrap = el('span', `status ${ok ? 'good' : 'bad'}`);
  wrap.append(el('i', 'ic', ok ? '✓' : '✕'), el('span', null, label));
  wrap.firstChild.setAttribute('aria-hidden', 'true');
  return wrap;
}

// The bundled probes ask the layout engine to size a box. If this browser
// answers differently from the oracle, say so and fall back to the formula.
function layoutProbesAgree() {
  try {
    for (let i = 1; i <= 48; i++) {
      const arg = Math.imul(i, 0x9e3779b1) >>> 0;
      if (domProbes.box(arg) !== domOracles.box(arg)) return false;
      if (domProbes.calc(arg) !== domOracles.calc(arg)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
const realProbes = layoutProbesAgree();
const pageProbes = realProbes ? domProbes : domOracles;

// Layout scenes. The example pool was baked in Chromium, Firefox and WebKit
// (pools/example.json). Lay every scene out here and compare: this is the
// calibration a deployment would run in report mode, done in the open.
const example = (await fetch('pool.json').then((r) => r.json())).scenes;
const engine = domScenes();
const agreement = { of: example.length, right: 0, ms: 0, wrong: new Map() };
for (const [i, entry] of example.entries()) {
  const started = performance.now();
  let got = null;
  try {
    got = digestToHex(engine(entry));
  } catch {
    // counted as a disagreement below
  }
  agreement.ms += performance.now() - started;
  if (got === entry.d) agreement.right++;
  else agreement.wrong.set(entry.c, digestFromHex(entry.d));
  if (i % 12 === 11) await sleep(0); // keep the page responsive while checking
}
// Where this browser disagreed, the demos use the baked answer and say so.
const pageScenes = (scene) => agreement.wrong.get(scene.c) ?? engine(scene);
const half = example.length >> 1;
const env = { probes: pageProbes, scenes: pageScenes, pool: example.slice(0, half), nextPool: example.slice(half) };

// --- Live generator ---------------------------------------------------------

function startLive() {
  const cfg = { epochMs: 12_000, beatAfterMs: 8_000, graceMs: 2_000, budget: 8 };
  const server = new Tether({ ...cfg, probes: domOracles, scenes: example });
  const decoder = new TextDecoder();
  const json = (code, obj, headers) =>
    new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json', ...headers } });

  let last = null; // the most recent API request the page sent
  let client = null;
  let open = false;
  let frozen = null; // what the generator looked like when the page was closed
  let page = 1;
  let timer = null;
  let shownEpoch = null;

  // The "network": requests from the client land on the verifier in this tab.
  async function network(input, init) {
    const req = input instanceof Request ? input : new Request(new URL(input, location.href), init);
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    if (url.pathname.endsWith('/__tether/mint')) {
      const out = await server.mint(JSON.parse(decoder.decode(body)));
      return json(out.ok ? 200 : 403, out);
    }
    if (url.pathname.endsWith('/__tether/beat')) {
      const out = server.beat(JSON.parse(decoder.decode(body)));
      return json(out.ok ? 200 : 401, out);
    }
    const target = url.pathname + url.search;
    const tok = req.headers.get(TOKEN_HEADER);
    const result = server.verify({ token: tok, method: req.method, target, body });
    last = { token: tok, method: req.method, target, result };
    if (!result.ok) return json(401, result, { [ERROR_HEADER]: result.error });
    return json(200, { ok: true, page: Number(url.searchParams.get('page')) });
  }

  const pips = $('live-pips');
  for (let i = 0; i < cfg.budget; i++) pips.append(el('i'));

  function showToken() {
    if (!last?.token) return;
    const [v, gid, epoch, ctr, mac] = last.token.split('.');
    const parts = [
      [v, 'v'],
      [`${gid.slice(0, 6)}…`, 'generator'],
      [epoch, 'epoch'],
      [ctr, 'counter'],
      [`${mac.slice(0, 12)}…`, 'proof'],
    ];
    const box = $('live-token');
    box.textContent = '';
    for (const [value, label] of parts) {
      const part = el('span', `part part-${label}`);
      part.append(el('code', null, value), el('small', null, label));
      box.append(part);
    }
    const verdict = $('live-verdict');
    verdict.textContent = '';
    verdict.append(
      status(last.result.ok, last.result.ok ? 'accepted' : `rejected: ${last.result.error}`),
      el('span', 'muted', `${last.method} ${last.target}`),
    );
    $('live-replay').disabled = false;
    $('live-retarget').disabled = false;
  }

  function pulse() {
    if (reducedMotion) return;
    const line = $('line');
    line.classList.remove('sending');
    void line.offsetWidth;
    line.classList.add('sending');
  }

  async function tick() {
    const mine = client;
    try {
      await mine.fetch(`/api/prices?page=${page++}`);
      if (mine !== client) return;
      showToken();
      pulse();
    } catch (err) {
      if (mine !== client) return;
      $('live-verdict').textContent = `client error: ${err.code ?? err.message}`;
    }
    if (open && mine === client) timer = setTimeout(tick, 1600 + Math.random() * 700);
  }

  function openPage() {
    frozen = null;
    shownEpoch = null;
    client = new TetherClient({ fetch: network, probes: pageProbes, scenes: pageScenes });
    open = true;
    $('live-script').textContent = '';
    $('live-close').textContent = 'Close the page';
    render();
    tick();
  }

  function closePage() {
    const s = client.state;
    frozen = s ? { ...s, deadline: Date.now() - s.ageMs + cfg.epochMs + cfg.graceMs } : null;
    client.stop();
    client = null;
    open = false;
    clearTimeout(timer);
    $('live-close').textContent = 'Open the page again';
    render();
  }

  function render() {
    const s = open ? client?.state : frozen;
    const pill = $('live-status');
    let leftMs = null;
    if (s) leftMs = open ? cfg.epochMs + cfg.graceMs - s.ageMs : s.deadline - Date.now();
    const dead = !open && (leftMs === null || leftMs <= 0);

    pill.dataset.state = open ? 'open' : dead ? 'dead' : 'closed';
    pill.lastElementChild.textContent = open ? 'page open' : dead ? 'generator deleted' : 'page closed';
    $('live').dataset.state = pill.dataset.state;

    $('live-epoch').textContent = s ? String(s.epoch) : '–';
    $('live-left').textContent = leftMs === null ? '–' : `${(Math.max(0, leftMs) / 1000).toFixed(1)} s`;
    const frac = leftMs === null ? 0 : Math.max(0, Math.min(1, leftMs / (cfg.epochMs + cfg.graceMs)));
    $('live-meter').style.width = `${(frac * 100).toFixed(1)}%`;
    const used = s && !dead ? s.used : 0;
    [...pips.children].forEach((pip, i) => pip.classList.toggle('on', i < used));
    pips.setAttribute('aria-label', `${used} of ${cfg.budget} requests used this epoch`);

    if (open && s && shownEpoch !== null && s.epoch !== shownEpoch && !reducedMotion) {
      const value = $('live-epoch');
      value.classList.remove('bumped');
      void value.offsetWidth;
      value.classList.add('bumped');
    }
    if (s) shownEpoch = s.epoch;
  }

  function script(label, target) {
    if (!last) return;
    const result = server.verify({ token: last.token, method: last.method, target });
    const out = $('live-script');
    out.textContent = '';
    const head = el('div', 'script-line');
    head.append(el('span', 'who who-adversary', 'script'), el('span', null, label));
    const verdict = el('div', 'script-line');
    verdict.append(
      status(result.ok, result.ok ? 'accepted' : `rejected: ${result.error}`),
      el('span', 'muted', result.ok ? '' : REASONS[result.error] ?? ''),
    );
    out.append(head, verdict);
    return result;
  }

  $('live-close').addEventListener('click', () => (open ? closePage() : openPage()));
  $('live-replay').addEventListener('click', () => script(`${last.method} ${last.target}, same token again`, last.target));
  $('live-retarget').addEventListener('click', () => script('GET /api/export?all=1, same token', '/api/export?all=1'));

  if (!realProbes) {
    document.querySelector('#live .fine').append(
      ' Your browser sized a probe box differently from the bundled oracle, so this demo is using computed probe answers. That is the calibration problem listed under Limits.',
    );
  }

  openPage();
  setInterval(render, 100);
  render();

  return {
    server,
    cfg,
    get last() {
      return last;
    },
    get state() {
      return open ? client?.state ?? null : frozen;
    },
    get open() {
      return open;
    },
  };
}

// --- Scene viewer -----------------------------------------------------------

function startScenes() {
  const plot = $('scene-plot');
  const facts = $('scene-facts');
  let index = 0;

  const boxes = (node) => node.slice(1).reduce((n, child) => n + boxes(child), 1);
  const short = (digest) => `${digestToHex(digest).slice(0, 8)}…`;
  const fact = (ok, label, value, note) => {
    const row = el('div', 'scene-fact');
    const head = el('div', 'scene-fact-head');
    head.append(el('span', 'label', label), el('code', null, value));
    row.append(head, status(ok, note));
    return row;
  };

  function show() {
    const entry = example[index];
    const rects = measureScene(entry);
    const count = rects.length / 4;
    // Boxes can overflow the root on any side, so frame all of them.
    let [x0, y0, x1, y1] = [0, 0, rects[2], rects[3]];
    for (let i = 0; i < rects.length; i += 4) {
      const [x, y, w, h] = rects.slice(i, i + 4);
      if (w === 0 && h === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
    }

    const root = svg('svg', { viewBox: `${x0 - 2} ${y0 - 2} ${x1 - x0 + 4} ${Math.max(y1 - y0, 40) + 4}`, role: 'img' });
    root.setAttribute('aria-label', `Scene ${index + 1}: ${count} boxes as this browser laid them out`);
    for (let i = 0; i < rects.length; i += 4) {
      const [x, y, w, h] = rects.slice(i, i + 4);
      if (w === 0 && h === 0) continue;
      root.append(svg('rect', { x, y, width: Math.max(w, 0.5), height: Math.max(h, 0.5), rx: 1.5, class: i === 0 ? 'scene-root' : 'scene-box' }));
    }
    plot.textContent = '';
    plot.append(root);

    const mine = sceneDigest(rects);
    const agrees = digestToHex(mine) === entry.d;
    facts.textContent = '';
    facts.append(
      fact(agrees, 'This browser', short(mine), agrees ? 'matches the answer measured in Chromium, Firefox and WebKit' : `differs from the baked answer ${entry.d.slice(0, 8)}…`),
      fact(false, 'A DOM library with no layout engine', short(sceneDigest(new Array(rects.length).fill(0))), `reports all ${count} boxes as 0 by 0, so it derives the wrong key`),
    );
    $('scene-caption').textContent = `Scene ${index + 1} of ${example.length}: ${count} boxes, ${entry.c.length.toLocaleString('en-US')} characters of CSS, no text and no images.`;
  }

  const all = agreement.right === agreement.of;
  const summary = $('scene-agree');
  summary.append(
    status(all, `This browser gave the baked answer for ${agreement.right} of ${agreement.of} scenes`),
    el('span', 'muted', `${Math.round(agreement.ms)} ms in total, ${(agreement.ms / agreement.of).toFixed(1)} ms a scene.`),
  );
  if (!all) {
    summary.append(
      el('p', 'fine', 'That is a false positive, and exactly what the bake is meant to rule out. The demos on this page use the baked answers for those scenes. If you can, open an issue with your browser and version.'),
    );
  }

  $('scene-next').addEventListener('click', () => {
    index = (index + 1) % example.length;
    show();
  });
  show();
  return { agreement, show };
}

// --- Chart ------------------------------------------------------------------

const SERIES = [
  { key: 'sent', label: 'Sent by the adversary' },
  { key: 'accepted', label: 'Accepted by the server' },
];
const tooltip = $('tooltip');

function niceTop(max) {
  const raw = Math.max(max, 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  return { step, top: step * Math.ceil(max / step) };
}

function renderChart(root, c) {
  root.hidden = false;
  root.textContent = '';
  const fig = el('figure', 'chart');
  const head = el('div', 'chart-head');
  const toggle = el('button', 'link', 'Show as table');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  head.append(el('strong', null, c.title), toggle);

  const legend = el('div', 'legend');
  for (const s of SERIES) {
    const item = el('span');
    item.append(el('i', `sw sw-${s.key}`), document.createTextNode(s.label));
    legend.append(item);
  }
  if (c.cap) {
    const item = el('span');
    item.append(el('i', 'sw-cap'), document.createTextNode(`Budget: ${c.cap} per epoch`));
    legend.append(item);
  }

  const plot = el('div', 'plot');
  const table = el('table', 'chart-table');
  table.hidden = true;
  const thead = el('tr');
  thead.append(el('th', null, c.axis), el('th', 'num', 'Sent'), el('th', 'num', 'Accepted'));
  table.append(thead);
  c.labels.forEach((label, i) => {
    const row = el('tr');
    row.append(el('td', null, label), el('td', 'num', String(c.sent[i])), el('td', 'num', String(c.accepted[i])));
    table.append(row);
  });
  toggle.addEventListener('click', () => {
    table.hidden = !table.hidden;
    plot.hidden = !table.hidden;
    legend.hidden = plot.hidden;
    toggle.textContent = table.hidden ? 'Show as table' : 'Show as chart';
    toggle.setAttribute('aria-expanded', String(!table.hidden));
  });

  fig.append(head, legend, plot, table);
  root.append(fig);

  function hideTip() {
    tooltip.hidden = true;
  }
  function showTip(i, x, y) {
    tooltip.textContent = '';
    tooltip.append(el('strong', null, c.labels[i]));
    for (const s of SERIES) {
      const row = el('div', 'tip-row');
      row.append(el('i', `sw sw-${s.key}`), el('span', null, s.key === 'sent' ? 'Sent' : 'Accepted'), el('b', null, c[s.key][i].toLocaleString('en-US')));
      tooltip.append(row);
    }
    tooltip.hidden = false;
    const w = tooltip.offsetWidth;
    const left = Math.min(Math.max(8, x + 14), document.documentElement.clientWidth - w - 8);
    tooltip.style.left = `${left + window.scrollX}px`;
    tooltip.style.top = `${y + window.scrollY - tooltip.offsetHeight - 12}px`;
  }

  function draw() {
    const W = plot.clientWidth;
    if (!W) return;
    const H = 230;
    const m = { l: 40, r: 10, t: 24, b: 28 };
    const innerW = W - m.l - m.r;
    const innerH = H - m.t - m.b;
    const n = c.labels.length;
    const { step, top } = niceTop(Math.max(...c.sent, ...c.accepted, c.cap ?? 0));
    const y = (v) => m.t + innerH - (v / top) * innerH;
    const band = innerW / n;
    const gap = 2;
    const bw = Math.max(5, Math.min(24, (band - 12 - gap) / 2));

    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
    root.setAttribute('aria-label', `${c.title}. Use "Show as table" for the values.`);

    for (let v = 0; v <= top + 1e-9; v += step) {
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
      const tick = svg('text', { x: m.l - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' });
      tick.textContent = v.toLocaleString('en-US');
      root.append(tick);
    }

    const groups = [];
    c.labels.forEach((label, i) => {
      const gx = m.l + band * i;
      const x0 = gx + (band - (2 * bw + gap)) / 2;
      const hover = svg('rect', { x: gx + 1, y: m.t - 6, width: band - 2, height: innerH + 6, rx: 4, class: 'hover-band' });
      root.append(hover);

      SERIES.forEach((s, k) => {
        const value = c[s.key][i];
        const x = x0 + k * (bw + gap);
        const h = (value / top) * innerH;
        if (h > 0) {
          const r = Math.min(4, h, bw / 2);
          const yt = y(value);
          const yb = y(0);
          root.append(
            svg('path', {
              d: `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${yb}Z`,
              class: `bar bar-${s.key}`,
            }),
          );
        }
        // Direct labels on the accepted bars only: that is the number the chart is about.
        if (s.key === 'accepted' && value !== c.cap && bw >= 12) {
          const text = svg('text', { x: x + bw / 2, y: y(value) - 5, class: 'value', 'text-anchor': 'middle' });
          text.textContent = String(value);
          root.append(text);
        }
      });

      const name = svg('text', { x: gx + band / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' });
      name.textContent = band < 64 ? label.replace(/^epoch /, 'e').replace(/ s$/, '') : label;
      root.append(name);
      groups.push({ hover, gx });
    });

    if (c.cap) {
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(c.cap), y2: y(c.cap), class: 'cap' }));
    }

    // Hit targets sit on top and span the whole column, not just the bars.
    groups.forEach(({ hover, gx }, i) => {
      const hit = svg('rect', { x: gx, y: 0, width: band, height: H, class: 'hit', tabindex: 0 });
      hit.setAttribute('aria-label', `${c.labels[i]}: sent ${c.sent[i]}, accepted ${c.accepted[i]}`);
      const on = (x, yy) => {
        hover.classList.add('on');
        showTip(i, x, yy);
      };
      const off = () => {
        hover.classList.remove('on');
        hideTip();
      };
      hit.addEventListener('pointermove', (ev) => on(ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('focus', () => {
        const box = hit.getBoundingClientRect();
        on(box.left + box.width / 2, box.top + m.t + 30);
      });
      hit.addEventListener('blur', off);
      root.append(hit);
    });

    plot.textContent = '';
    plot.append(root);
  }

  draw();
  let width = plot.clientWidth;
  const observer = new ResizeObserver(() => {
    if (!plot.isConnected) return observer.disconnect();
    if (plot.clientWidth && plot.clientWidth !== width) {
      width = plot.clientWidth;
      draw();
    }
  });
  observer.observe(plot);
}

// --- Attack lab -------------------------------------------------------------

function startLab() {
  const list = $('lab-list');
  const consoleEl = $('lab-console');
  const chartEl = $('lab-chart');
  const outcomeEl = $('lab-outcome');
  const runButton = $('lab-run');
  let current = 0;
  let runId = 0;

  const tabs = scenarios.map((s, i) => {
    const tab = el('button', 'lab-tab');
    tab.type = 'button';
    tab.id = `lab-tab-${s.id}`;
    tab.setAttribute('role', 'tab');
    tab.append(el('span', 'n', String(i + 1)), el('span', 'tt', s.title), el('span', 'mark'));
    tab.addEventListener('click', () => {
      select(i);
      run();
    });
    list.append(tab);
    return tab;
  });
  $('lab-panel').setAttribute('aria-labelledby', tabs[0].id);

  function select(i) {
    current = i;
    runId++;
    tabs.forEach((tab, k) => {
      tab.setAttribute('aria-selected', String(k === i));
      tab.tabIndex = k === i ? 0 : -1;
    });
    $('lab-panel').setAttribute('aria-labelledby', tabs[i].id);
    $('lab-title').textContent = `${i + 1}. ${scenarios[i].title}`;
    $('lab-blurb').textContent = scenarios[i].blurb;
    consoleEl.textContent = '';
    consoleEl.append(el('div', 'ln hint', 'Press “Run attack” to play this against a fresh verifier.'));
    chartEl.hidden = true;
    outcomeEl.hidden = true;
    runButton.disabled = false;
    runButton.textContent = 'Run attack';
    hideTooltip();
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function lineNode(line) {
    if (line.who === 'note') {
      const node = el('div', 'ln note');
      node.append(el('span', 't', stamp(line.at)), el('span', 'msg', line.text));
      return node;
    }
    const node = el('div', `ln ${line.code === 'ok' || (line.tally && !Object.keys(line.tally).some((k) => k !== 'ok')) ? 'is-ok' : 'is-no'}`);
    const msg = el('span', 'msg', line.text);
    const res = el('span', 'res');
    if (line.tally) {
      for (const [code, count] of Object.entries(line.tally)) {
        res.append(status(code === 'ok', `${count} ${code === 'ok' ? 'accepted' : code}`));
      }
    } else if (line.code === 'ok') {
      res.append(status(true, 'accepted'));
    } else {
      res.append(status(false, line.code));
      const why = [REASONS[line.code], line.detail].filter(Boolean).join(', ');
      if (why) msg.append(el('small', 'reason', why));
    }
    node.append(el('span', 't', stamp(line.at)), el('span', `who who-${line.who}`, line.who), msg, res);
    return node;
  }

  const stamp = (ms) => `${(ms / 1000).toFixed(1)} s`;

  async function run({ instant = false } = {}) {
    const mine = ++runId;
    const index = current;
    const scenario = scenarios[index];
    runButton.disabled = true;
    runButton.textContent = 'Running…';
    chartEl.hidden = true;
    outcomeEl.hidden = true;
    consoleEl.textContent = '';

    const out = await scenario.run(env);
    if (mine !== runId) return out;
    for (const line of out.lines) {
      consoleEl.append(lineNode(line));
      if (!instant && !reducedMotion) {
        await sleep(line.who === 'note' ? 260 : 150);
        if (mine !== runId) return out;
      }
    }

    if (out.chart) renderChart(chartEl, out.chart);
    outcomeEl.hidden = false;
    outcomeEl.textContent = '';
    outcomeEl.dataset.kind = out.outcome.kind;
    const badge = el('span', `badge ${out.outcome.kind}`);
    badge.append(el('i', 'ic', out.outcome.kind === 'stopped' ? '✓' : '!'), el('span', null, out.outcome.title));
    badge.firstChild.setAttribute('aria-hidden', 'true');
    outcomeEl.append(badge, el('p', null, out.outcome.text));

    const mark = tabs[index].querySelector('.mark');
    mark.textContent = out.outcome.kind === 'stopped' ? '✓' : '!';
    mark.dataset.kind = out.outcome.kind;
    mark.title = out.outcome.title;
    runButton.disabled = false;
    runButton.textContent = 'Run again';
    return out;
  }

  runButton.addEventListener('click', () => run());
  list.addEventListener('keydown', (ev) => {
    const delta = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
    if (!delta) return;
    ev.preventDefault();
    const next = (current + delta + scenarios.length) % scenarios.length;
    select(next);
    tabs[next].focus();
  });

  select(0);

  // Play the first attack the first time the lab scrolls into view.
  let played = false;
  const observer = new IntersectionObserver(
    (entries) => {
      if (played || !entries.some((e) => e.isIntersecting)) return;
      played = true;
      observer.disconnect();
      if (runId === 1) run();
    },
    { threshold: 0.35 },
  );
  observer.observe($('lab-panel'));

  return {
    scenarios: scenarios.map((s) => s.id),
    async play(id, opts = { instant: true }) {
      played = true;
      select(scenarios.findIndex((s) => s.id === id));
      return run(opts);
    },
  };
}

window.addEventListener('scroll', () => (tooltip.hidden = true), { passive: true });

const live = startLive();
const scenes = startScenes();
const lab = startLab();
window.pagetetherSite = { live, lab, scenes, realProbes };
