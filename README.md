# pagetether

Tether private API requests to a live page.

Once someone reverse engineers a site's private API, they mint whatever cookies and headers it needs once and then hammer it from a script. pagetether makes that credential perishable: every request carries a token made from a key that changes every 30 seconds, and the only way to get the next key is to still be there, running code the server just sent.

It is a second factor for an API, where the factor is "the page is open and still running".

**[Site with a live generator and an attack lab →](https://jacobzipper.github.io/pagetether/)** Eight adversary strategies run against the real verifier in your browser, including the one that works.

> **Status: experimental draft (v0).** The protocol will change, it has not been audited, and server state is in-memory only. Read [what it does not do](#what-it-does-not-do) before relying on it.

## How it works

1. **Mint.** The page asks for a *generator*. The server decides who gets one (a login, a captcha, a Private Access Token: your call). The seed is agreed by key exchange, so it never crosses the wire, and the page holds it as a non-extractable WebCrypto key.
2. **Sign.** Each request gets a `Tether-Token` header: an HMAC over the method, path, query and body, under the current epoch key, with a counter. A token is good for that one request, once.
3. **Beat.** Before the epoch ends, the page proves it holds the current key and receives a fresh random challenge plus a small random program (the *noise program*). The next key is derived from the old key, the challenge, and the program's output. The program can include *probes*: questions only a real page environment answers correctly. A wrong answer is never reported. The key is simply wrong from then on.
4. **Budget.** Each epoch accepts a fixed number of requests per generator. Counters above the budget do not exist.

Miss a beat and the generator is dead. Copy it to a second machine and the two copies share one budget and trip over each other.

## What an attacker gets

Every row is a test in [`test/attacks.test.js`](test/attacks.test.js), run against an attacker who has fully reverse engineered the client.

| They try | They get |
| --- | --- |
| Call the API with no token or a forged one | `401 missing` / `bad_mac` |
| Replay a captured request | `401 replay` |
| Reuse a token on another path, query, method or body | `401 bad_mac` |
| Mint once in a browser, then script against it | `401 expired` within one epoch |
| Send faster than a page would | `401 over_budget` |
| Beat early to refill the budget | `too_early` |
| Clone one generator across many workers | one shared budget, `replay` on collisions, `fork` kills it |
| Port the client to Node without a page environment | wrong key, `401 bad_mac`, no hint why |
| Port the client *and* fake every probe correctly | **works**, at one budget per live generator |

The last row is the limit, and it is deliberate. pagetether does not make a client unforgeable; nothing that runs on the attacker's machine can. It changes what a working scraper costs: from "one stolen cookie, unlimited requests" to "one gated, continuously executing, rate-capped generator per stream of requests". How expensive that is depends on your gate and your probes.

## Use it

Server (Node 20+, no dependencies):

```js
import http from 'node:http';
import { Tether } from 'pagetether/server';
import { controlRoutes, guard, readBody } from 'pagetether/node';
import { domOracles } from 'pagetether/probes';

const tether = new Tether({
  epochMs: 30_000,        // a key lives this long
  budget: 60,             // requests per epoch per generator
  probes: domOracles,     // expected probe answers
  gate: ({ req, proof }) => isLoggedIn(req), // who may mint
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

`Tether` is transport-agnostic: `mint()`, `beat()` and `verify()` take and return plain objects, so it fits any framework.

It is also runtime-agnostic. `pagetether/server` binds the verifier to `node:crypto`; `pagetether/web` binds the same code to WebCrypto for edge runtimes, workers and browsers; `pagetether/tether` exports the core (`TetherCore`) if you want to supply your own hashing, randomness and key exchange.

## Try it

```sh
npm test          # protocol tests and the attack suite
npm run demo      # http://127.0.0.1:8787, a page and a private API
node scripts/browser-smoke.js   # the same flow in headless Chrome (Node 22+)
npm run site      # build the static site into _site/
node scripts/site-smoke.js      # the site's live generator and attack lab in headless Chrome
```

The demo page shows the generator ticking and prints its last request as a `curl` command, so you can watch the server refuse it.

The [site](https://jacobzipper.github.io/pagetether/) is `site/` plus the library, with no build step beyond copying files. Its attack lab is ordinary code (`site/lab.js`) that `npm test` also runs, so every verdict the page shows is pinned by a test.

## What it does not do

- **It does not stop a real browser under automation.** Playwright driving the real page passes every check. pagetether forces a scraper back into a browser and caps what each browser can pull; spotting automated browsers is a separate job (probes are a place to put those checks).
- **The bundled probes are examples.** Their answers are in this repository. They stop a naive port and show the mechanism. Bring your own and calibrate them on real traffic before enforcing.
- **It only covers requests made through `tether.fetch`.** Data already in the HTML, images, navigations and WebSocket handshakes are not protected.
- **State is in one process.** A multi-node deployment needs a shared store with atomic check-and-set. Not built yet.
- **It needs the exact request target.** A proxy that rewrites paths between the browser and the verifier breaks the binding.
- **A hidden tab lapses.** Browsers throttle background timers, so a long-hidden page misses beats and re-mints when it next makes a request, paying your gate again.

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) has the threat model, the wire format, the argument for each property, how this relates to existing work (BotGuard and PO tokens, TikTok's signing VM, DPoP, Device Bound Session Credentials, Privacy Pass), and the open questions.

## License

MIT
