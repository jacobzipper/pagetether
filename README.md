# pagetether

A private API that needs a real browser to call.

"Reverse engineer any website into a typed API client" is now a product category. An agent records a session, reads your JavaScript, and writes an HTTP client that calls your private API with no browser at all. Hiding how the frontend authenticates no longer buys much: reading obfuscated code is the thing language models are getting good at.

pagetether starts from the other end. **Assume the agent has read all of your JavaScript.** Two things still stand:

- **The credential is perishable.** Every request carries a token made from a key that changes every 30 seconds, and the only way to get the next key is to still be there, running what the server just sent.
- **Renewing it takes a browser engine.** Part of what the server sends is a *scene*: a small random page layout. Where its boxes end up goes into the next key. There is no formula for that in this repository or on your server. The answers were measured in real browsers ahead of time, so the only thing that produces them is a real layout engine.

A headless client built from your JavaScript gets a wrong key, a `401`, and no hint why.

**[Site with a live generator and an attack lab →](https://jacobzipper.github.io/pagetether/)** Nine adversary strategies run against the real verifier in your browser, including the one that works.

> **Status: experimental draft (v0).** The protocol will change, it has not been audited, and server state is in-memory only. Read [what it does not do](#what-it-does-not-do) before relying on it.

## How it works

1. **Mint.** The page asks for a *generator*. The server decides who gets one (a login, a captcha, a Private Access Token: your call). The seed is agreed by key exchange, so it never crosses the wire, and the page holds it as a non-extractable WebCrypto key.
2. **Sign.** Each request gets a `Tether-Token` header: an HMAC over the method, path, query and body, under the current epoch key, with a counter. A token is good for that one request, once.
3. **Beat.** Before the epoch ends, the page proves it holds the current key and receives a fresh random challenge, a small random program, and two scenes. The next key is derived from the old key, the challenge, the program's output and the scenes' layouts. A wrong answer is never reported. The key is simply wrong from then on.
4. **Budget.** Each epoch accepts a fixed number of requests per generator. Counters above the budget do not exist.

Miss a beat and the generator is dead. Copy it to a second machine and the two copies share one budget and trip over each other.

## Scenes

A check that reads from the rendering engine is only as strong as the amount of engine behind it. One well-known site signs its API requests with a value derived from a CSS animation. It was ported to plain arithmetic in three languages, because underneath it was one easing curve.

A scene is a tree of up to 64 empty boxes and a few kilobytes of generated CSS: block flow, floats, flexbox, grid, absolute positioning and transforms, sized with `calc`, `min`, `max` and `clamp`, under class rules that collide so the cascade has to decide. The page lays it out in a closed shadow root and hashes the position and size of every box.

The server holds a **pool** of scenes and their answers. `npm run bake` makes one: it generates random scenes, has real browsers lay them out, and keeps only the ones on which every browser agreed with room to spare. About one candidate in sixteen survives. What survives is the part of CSS layout where Chromium, Firefox and WebKit agree to the pixel, and nothing short of a layout engine reproduces it.

Measured on a pool of 400 scenes (method and full tables in [`docs/DESIGN.md`](docs/DESIGN.md#3-scenes-measurements)):

| Client | Scenes right |
| --- | --- |
| Chromium 158, Firefox 159 and WebKit 27.2, at 88 settings the bake never saw (zoom, pixel ratio, viewport, dark mode, right-to-left, a hostile page stylesheet, …) | 35,196 / 35,200 |
| Eight older releases the bake never saw, back to Chromium 108 (2022) | 400 / 400 on six, 399 on Chromium 128, 393 on WebKit 26.0 |
| jsdom, happy-dom, linkedom | 0 / 400 each |

The bake itself used 37 runs: the three current engines at nine zoom settings each, and four older releases. Real phones and Safari itself have not been measured.

## What an attacker gets

Every row is a test in [`test/attacks.test.js`](test/attacks.test.js) or [`test/scenes.test.js`](test/scenes.test.js), run against an attacker who has fully reverse engineered the client.

| They try | They get |
| --- | --- |
| Call the API with no token or a forged one | `401 missing` / `bad_mac` |
| Replay a captured request | `401 replay` |
| Reuse a token on another path, query, method or body | `401 bad_mac` |
| Mint once in a browser, then script against it | `401 expired` within one epoch |
| Send faster than a page would | `401 over_budget` |
| Beat early to refill the budget | `too_early` |
| Clone one generator across many workers | one shared budget, `replay` on collisions, `fork` kills it |
| Port the whole client to a script with no layout engine | wrong key, `401 bad_mac`, no hint why |
| Record scene answers in a browser, then go headless with the table | works until the pool is rotated, then `401 bad_mac` |
| Port the client *and* keep a real browser engine in the loop | **works**, at one budget per live generator |

The last row is the limit, and it is deliberate. pagetether does not make a client unforgeable; nothing that runs on the attacker's machine can. It changes what a working scraper is: from "an HTTP client and one stolen cookie, unlimited requests" to "a browser engine kept running, one gated and rate-capped generator per stream of requests".

## Use it

Bake a pool with the browsers on your machine (any mix; `--wait 1` also takes a run from a phone that opens the printed URL):

```sh
npm run bake -- --out pool.json --chrome --firefox
```

Server (Node 20+, no dependencies):

```js
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Tether } from 'pagetether/server';
import { controlRoutes, guard, readBody } from 'pagetether/node';
import { domOracles } from 'pagetether/probes';

const tether = new Tether({
  epochMs: 30_000,        // a key lives this long
  budget: 60,             // requests per epoch per generator
  scenes: JSON.parse(readFileSync('pool.json', 'utf8')),
  sceneMode: 'report',    // measure real traffic first; switch to 'enforce' when it is clean
  probes: domOracles,     // optional extra checks with known answers
  gate: ({ req, proof }) => isLoggedIn(req), // who may mint
  onEvent: (name, info) => name === 'scene' && !info.ok && console.warn('scene mismatch', info),
});
const control = controlRoutes(tether); // POST /__tether/mint, /__tether/beat

http.createServer(async (req, res) => {
  if (await control(req, res)) return;
  const body = await readBody(req);
  if (!guard(tether, req, res, body)) return; // 401 + Tether-Error header
  // ... your API
}).listen(8080);
```

Page:

```js
import { TetherClient } from 'pagetether/client';
import { domProbes } from 'pagetether/probes';

const tether = new TetherClient({ probes: domProbes });
const res = await tether.fetch('/api/prices?page=2'); // a drop-in for fetch()
```

The pool file holds the answers, so it is a server-side secret. Rotate it whenever you like with `tether.setScenes(newPool)`; pages that are already open carry on. [`pools/example.json`](pools/example.json) is for the demo and the tests only: its answers are public.

`Tether` is transport-agnostic: `mint()`, `beat()` and `verify()` take and return plain objects, so it fits any framework. It is also runtime-agnostic. `pagetether/server` binds the verifier to `node:crypto`; `pagetether/web` binds the same code to WebCrypto for edge runtimes, workers and browsers; `pagetether/tether` exports the core (`TetherCore`) if you want to supply your own hashing, randomness and key exchange.

## Try it

```sh
npm test          # protocol tests, the attack suite, scenes and the lab
npm run demo      # http://127.0.0.1:8787, a page and a private API
node scripts/browser-smoke.js   # the same flow in headless Chrome (Node 22+)
npm run site      # build the static site into _site/
node scripts/site-smoke.js      # the site's live generator and attack lab in headless Chrome
npm run bake -- --check pools/example.json --chrome   # how many scenes your browser gets right
```

The demo page shows the generator ticking and prints its last request as a `curl` command, so you can watch the server refuse it. Point any "website to API client" tool at it and see what the client it writes does after thirty seconds.

The [site](https://jacobzipper.github.io/pagetether/) is `site/` plus the library, with no build step beyond copying files. Its attack lab is ordinary code (`site/lab.js`) that `npm test` also runs, so every verdict the page shows is pinned by a test.

## What it does not do

- **It does not stop a real browser.** Playwright driving the real page passes every check, and so does an AI agent that operates a browser. pagetether forces a scraper back into a browser and caps what each one can pull; telling automated browsers from people is a separate job.
- **It does not stop a browser engine used as an oracle.** One headless browser can lay out scenes for many scripted workers. The attacker still has to build and run that, and each generator is still held to its budget, but scenes alone do not make it one browser per worker.
- **Scenes are measured, not proven.** Agreement was measured on desktop builds of three engines on one Linux machine. Safari itself, phones, and browsers older than the ones in a bake are where a real user could get a wrong key (the table under [Scenes](#scenes) shows how often for old versions). A wrong answer is silent, so run `sceneMode: 'report'` on real traffic before enforcing.
- **It only covers requests made through `tether.fetch`.** Data already in the HTML, images, navigations and WebSocket handshakes are not protected.
- **State is in one process.** A multi-node deployment needs a shared store with atomic check-and-set. Not built yet.
- **It needs the exact request target.** A proxy that rewrites paths between the browser and the verifier breaks the binding.
- **A hidden tab lapses.** Browsers throttle background timers, so a long-hidden page misses beats and re-mints when it next makes a request, paying your gate again.

## Is any of this new?

Mostly not, piece by piece, and [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) says where each piece comes from: per-request MACs (DPoP, One-Time Cookies), refresh by proof of possession (Device Bound Session Credentials), clone detection on a rotating secret (OAuth refresh-token rotation, WebAuthn counters), answers that come from real clients instead of a formula (Google's Picasso, 2016), and environment checks that poison a key instead of returning a verdict (Riordan and Schneier, 1998). The nearest whole systems are SHPF (2013) and signprint (2026).

What we could not find anywhere: layout scenes kept only where independent engines agree, so that one operator can bake a pool alone, and the whole set as one open, self-hostable protocol with its false-positive rate measured. Commercial anti-bot products may do some of this privately; they do not document it.

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) has the threat model, the wire format, the argument for each property, scenes and their measurements, and the open questions.

## License

MIT
