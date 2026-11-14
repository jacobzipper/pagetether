# pagetether design

Draft 0. Everything here may change.

## 1. The problem

A site's own frontend talks to a private API. An attacker opens DevTools, works out how the frontend authenticates (cookies, signed headers, opaque blobs, data split over several endpoints), reproduces it in a script, and then pulls data at machine speed without a browser. This is usually called protocol replication or headless replay.

The frontend runs on a machine the attacker controls, so no scheme can prevent this outright. Anything the page can compute, the attacker can compute. The useful question is economic: what does one working stream of scraped requests cost, and does that cost recur?

With a bearer cookie or a static signing routine the answer is "almost nothing, once". The attacker pays the reverse-engineering cost one time and every later request is free.

That one-time cost used to be days of a person's attention per site, which was itself a defence. It no longer is. A family of tools now gives the job to a language model: record a session, read the scripts, emit a typed HTTP client ([PRIOR-ART.md](PRIOR-ART.md) lists them). Obfuscation, the usual way of raising the one-time cost, is the thing language models are getting good at undoing. So this design starts from the assumption that **the attacker's agent has read and understood all of the client code**, and asks what is left. Two things are: a credential that expires unless it is continuously renewed, and a renewal that needs something the agent's HTTP client does not have, namely a browser engine.

### Threat model

The attacker:

- reads, deobfuscates and modifies all client code, by hand or with a language model, and runs it in any environment;
- observes all traffic of their own sessions;
- can run real browsers, at a cost per browser;
- can pass the mint gate at whatever that gate costs (an account, a captcha solve, a device).

The attacker cannot read server state or break HMAC-SHA-256 or P-256.

Goals, in order:

1. A credential obtained once stops working by itself, quickly.
2. Throughput is bounded per credential, and the bound cannot be dodged by copying the credential.
3. Each credential costs something to obtain and something to keep alive.
4. The parts that are provable are kept apart from the parts that are an arms race, so that the first do not depend on the second.

Non-goals: identifying humans, detecting automated real browsers, hiding the protocol. The protocol is public and its guarantees do not rest on secrecy of the design.

## 2. Design

A **generator** is a short-lived shared secret between one page and the server, with a counter and a clock. It has three layers.

### Layer 0: the mint gate

`mint` creates a generator. The `gate` callback decides who gets one. This is where presence is paid for, and it is deliberately pluggable, because the right price depends on the site:

- a logged-in session (one generator per session bounds a whole account);
- a captcha or Turnstile-style challenge;
- a Privacy Pass / Private Access Token redemption, which is real device attestation where available;
- proof of work (weak: attackers have cheaper compute than phones do);
- plain per-address rate limiting (what the demo uses).

Everything after the gate exists to make sure that what was paid for at the gate cannot be multiplied.

The seed is agreed with an ephemeral P-256 ECDH exchange. The page generates a non-extractable key pair, sends the public half, and derives the shared secret directly into a non-extractable HMAC key. The seed is never on the wire and never visible to page script as bytes.

### Layer 1: the ratchet

This layer is ordinary symmetric cryptography and its properties hold against the full attacker above.

Time is cut into **epochs**. Epoch `e` has a key `k_e`:

```
k_0     = HMAC(seed,    "pt0/epoch\n" || u32(0)   || c_0     || P_0(c_0))
k_{e+1} = HMAC(k_e,     "pt0/epoch\n" || u32(e+1) || c_{e+1} || P_{e+1}(c_{e+1}))
```

`c` is a fresh 32-byte challenge chosen by the server and `P` is that epoch's noise program (Layer 2). The page gets `c_{e+1}` and `P_{e+1}` by sending a **beat**: a MAC under `k_e`. So the next key needs three things at once: the previous key, a value the server only hands to a holder of the previous key, and the result of running the server's program.

A request carries

```
Tether-Token: 0.<gid>.<epoch>.<ctr>.<mac>
mac    = HMAC(k_epoch, "pt0/req\n" || u32(epoch) || u32(ctr) || digest)
digest = SHA-256(METHOD "\n" target "\n" hex(SHA-256(body)))
```

The server accepts it if the epoch is current (or the previous one, inside a short grace window), the MAC verifies, `ctr < budget`, and `ctr` has not been used in that epoch.

Properties:

| | Property | Why it holds |
| --- | --- | --- |
| P1 | **No generator, no token.** | The MAC key descends from a seed only the minting page and the server hold. |
| P2 | **One token, one request.** | The MAC covers method, target and body; the counter is single-use. |
| P3 | **Tokens go stale.** | A token names its epoch; an epoch key is accepted for at most `epochMs + graceMs`. |
| P4 | **Liveness.** | The server deletes a generator that has not beaten by `epochMs + graceMs`. Holding yesterday's state is worth nothing. |
| P5 | **Bounded rate.** | An epoch has exactly `budget` valid counters and a beat is refused before `beatAfterMs`. Sustained rate per generator is at most `budget / beatAfterMs` (3 requests per second with the defaults), with a burst of up to `2 × budget` across one epoch boundary. |
| P6 | **Copies do not multiply.** | All copies of a generator draw on the same counters. Uncoordinated copies collide (`replay`). A copy that beats after another copy already moved the epoch on is a `fork`, and the generator is deleted. Coordinated copies are one client with one budget. |

P5 and P6 together give the number that matters:

```
attacker throughput  ≤  (live generators) × budget / beatAfterMs
```

and each live generator costs one pass through the gate plus one program execution per epoch for as long as it lives.

MAC failures are checked before anything stateful, so a party without the key cannot burn counters or trigger a fork.

A beat is idempotent for `graceMs`: a page that lost the response can retry and gets the same answer. After that, a second beat for an old epoch is treated as a fork.

### Layer 2: the noise program

This layer is heuristic. It is the arms-race part, and it is isolated on purpose.

Each epoch the server rolls a random straight-line program over eight 32-bit registers (add, xor, rotate, multiply, shift-mix) and sends it with the challenge. Both sides run it on the challenge; the output feeds the key derivation. By itself this is not a secret: the interpreter is about fifty lines in `src/core.js` and an attacker can run it anywhere. What it provides is a slot. The program is server-chosen, fresh every epoch, and its result is folded into the key instead of being reported.

**Probes** fill the slot. A probe instruction calls a named function in the page with an argument that depends on the running register state, and adds the result to a register. The server holds an *oracle* for each probe: what a genuine environment returns. The bundled examples ask the layout engine to size a box (`width: calc(17px * 3 + 40px)` and read `offsetWidth`), which a browser answers and Node or jsdom does not.

Three consequences of folding answers into the key:

- **Silent failure.** A wrong answer produces a wrong key and the next request fails with `bad_mac`, the same error as a forged token. The attacker learns that something was wrong, not which probe or which epoch's program.
- **Continuous checking.** Probes run every epoch for the life of the generator, not once at login, and the set can change from one beat to the next.
- **No extra round trip, no verdict endpoint** to study.

What a probe with a formula does not give: the server checks the answer with an oracle, and whatever the oracle computes, a port can compute too. `calc(17px * 3 + 40px)` is arithmetic. Rotating such probes, keeping them private and obfuscating the page side all raise the price of porting them, and none of that changes what they are. An attacker who has read the client (or whose language model has) writes the same function the server has.

Good probes have answers that are identical across every genuine browser a site supports, cheap to compute, and awkward to compute without the real thing. Bad probes are ones with legitimate variance (fonts, GPU output, timing), because a false positive here locks out a real user with no explanation.

### Scenes: questions with no formula

A **scene** is a probe for which nobody holds a formula, the server included.

It is a small random document: a tree of up to 64 empty boxes and a stylesheet of a few kilobytes. The stylesheet mixes block flow with collapsing margins, floats, flexbox, grid, absolute positioning, transforms and `aspect-ratio`; lengths written with custom properties, `calc`, `min`, `max` and `clamp`; and a dozen class rules that collide with each other, so that specificity, source order, `!important`, `@layer`, `@supports` and `@media` decide which declaration wins. There is no text, no border, no image and no viewport unit, because those are where honest browsers differ.

The page builds the tree inside a closed shadow root on a hidden, fixed-position host (so the site's own styles cannot reach it and it cannot disturb the site), lets the browser lay it out, and reads `getBoundingClientRect()` for every box relative to the root. A second hidden box of a known width is read the same way, and its measured width divides out any magnification the site applies to its root element (`zoom`, or a transform). The numbers are rounded to whole pixels and hashed to 64 bits. A `SCENE` instruction in the noise program adds that digest, salted by the running register state, to a register. From there it flows into the next key like any other probe.

**Where the answers come from.** The server never computes one. It holds a **pool** of scenes whose answers were measured ahead of time in real browsers (`scripts/bake.js`), and at each beat it picks `sceneCount` of them (default 2). Baking generates random candidates, has each browser lay all of them out, and keeps a candidate only if:

1. every run produced the same whole-pixel numbers;
2. in every run, every raw number was within 0.15 px of a whole pixel, so that sub-pixel differences between engines and zoom levels cannot tip the rounding;
3. the layout is not degenerate (most boxes are visible and the numbers are varied).

Most candidates fail (1) or (2). That is the point of the filter: what survives is the part of CSS layout on which independent engines agree exactly. Section 3 has the yield and the agreement measured on browsers that were not in the bake.

**What it takes to answer one.** Something that resolves the cascade and runs block, float, flex, grid and positioned layout the way the browsers do. This repository contains a generator for scenes and no evaluator, and that is deliberate: if we could write the function, so could the attacker. A DOM without layout (jsdom, happy-dom, linkedom) reports every box as 0 by 0. A port that hard-codes the handful of scenes it has seen is right until the server picks a different one.

**What the attacker can still do**, in increasing cost:

- *Keep a table.* Run a real browser for a while, record the answer to each scene it is sent, then go headless with the table. This works until the server meets the table with a scene it has not seen. A generator sees `sceneCount` scenes per epoch, so collecting a pool of 400 takes on the order of 1,200 epochs per generator (the coupon-collector bound, `N ln N / sceneCount`), and `setScenes()` swaps the pool without restarting anything. A fresh pool is a few minutes of machine time. The site's lab runs this attack.
- *Keep an engine as an oracle.* One headless browser can lay out scenes for many scripted workers at about a millisecond each. Scenes do not prevent this and cannot. What they change is the kind of client the attacker has to build and run: no longer an HTTP client, but an HTTP client wired to a mainstream rendering engine, kept current as the pool rotates. Throughput is still bounded only by Layer 1: generators × budget.
- *Run the real page in a real browser.* Passes everything, at page speed. This is the floor for any scheme of this kind.

So scenes move the "full port" row of the README from "fake a few formulas" to "operate a browser engine", and the budget and the gate price everything above that.

**Cost to honest users.** About 2.5 KB of JSON per scene on the wire before compression, so roughly 5 KB per beat at the default of two scenes, and one to five milliseconds of layout each (section 3). The scene's stylesheet is restricted to a small alphabet with no strings, escapes, `url()` or `@import`, so a scene cannot make the page fetch anything, and it is applied through a constructable stylesheet, which works under a strict Content-Security-Policy.

**False positives are silent.** A browser that lays a scene out differently derives a wrong key and is refused with `bad_mac`; its client mints again and carries on, paying the gate again. The server cannot tell which scene was at fault. Two tools exist for that:

- `sceneMode: 'report'` sends scenes beside the program instead of inside it. They do not affect the key; the client returns its digests with the next beat and the server emits `onEvent('scene', { gid, epoch, ok, got })`. Run a new pool this way on real traffic before enforcing it.
- `scripts/bake.js --check pool.json` re-measures a pool against any browser you can point at a URL, including a phone.

## 3. Scenes: measurements

Everything below was measured on 2026-11-14, on one Linux machine, with the headless browser builds that Playwright ships. A *run* is one browser build at one setting laying out every scene in a pool. A scene counts as right when the digest the page computes equals the baked one. The driver is `scripts/measure-engines.mjs`; it feeds `scripts/bake.js`, which does the filtering and the checking.

### The bake

9,000 random candidates were laid out in 37 runs:

| Browser build | Settings | Runs |
| --- | --- | --- |
| Chromium 158, Firefox 159, WebKit 27.2 | device pixel ratio 1, 0.9, 1.1, 1.25, 1.5, 1.75 and 2; CSS `zoom` of 0.9 and 1.1 on the root element | 27 |
| Chromium 158 | `--force-device-scale-factor` 0.9 and 1.1 | 2 |
| Chromium 136, Firefox 137, WebKit 18.4 (from 2025) | default; root `zoom` 0.9 | 6 |
| Chromium 101 (from 2022) | default; root `zoom` 0.9 | 2 |

| Outcome | Candidates |
| --- | --- |
| Kept: all 37 runs agree, with margin | 548 (6.1%) |
| Dropped: runs disagree on a whole-pixel value | 5,585 |
| Dropped: runs agree, but a raw value is more than 0.15 px from a whole pixel | 2,825 |
| Dropped: degenerate layout | 42 |

About one candidate in sixteen survives. The pool measured below is the first 400 of the 548. Its scenes average 19 boxes and 2.4 KB of JSON on the wire (largest 3.5 KB).

### Current engines, at settings the bake never saw

| Browser build | Runs | Scenes right |
| --- | --- | --- |
| Chromium 158.0.8127.18 | 31 | 12,400 / 12,400 |
| Google Chrome 156.0.8078.73 (the stable channel build) | 1 | 400 / 400 |
| Firefox 159.0 | 30 | 12,000 / 12,000 |
| WebKit 27.2 | 26 | 10,396 / 10,400 |
| **Total** | **88** | **35,196 / 35,200** |

The settings, none of which were in the bake:

- device pixel ratios 0.5, 0.67, 0.75, 0.8, 1.2, 1.33, 2.25, 2.5, 2.625, 3, 3.5 and 4;
- a 320 × 568 viewport at 3× and a 3840 × 2160 viewport;
- dark colour scheme, forced colours, reduced motion;
- a right-to-left page, and a page whose own stylesheet sets `margin`, `padding`, `display`, `float`, `min-width`, `font-size` and `box-sizing` on `*` with `!important` and makes the document vertical;
- CSS `zoom` of 0.67, 0.8, 1.25 and 1.5 on the root element, and a root `transform: scale(0.8)`;
- Chromium: Pixel 7 emulation, the new headless mode, `--force-device-scale-factor` 0.8, 1.25 and 1.5, minimum font size 24;
- Firefox: `layout.css.devPixelsPerPx` 1.1 and 1.33, minimum font size 24, `privacy.resistFingerprinting`, page fonts disabled;
- WebKit: iPhone 14 emulation.

The four misses are all WebKit at a factor of 0.67: one scene at device pixel ratio 0.67 and three at root `zoom` 0.67. In each, one box lands between 0.5 and 0.7 px from where the other engines put it (48.62 against 48, for example), which rounds the other way.

### Releases the bake never saw

Each build ran the pool at four settings: default, device pixel ratio 1.33, device pixel ratio 3, and root `zoom` 0.8. The result was the same at all four.

| Browser build | From | Scenes right |
| --- | --- | --- |
| Chromium 145, Firefox 146 | 2025–26 | 400 / 400 each |
| WebKit 26.0 | 2025 | 393 / 400 |
| Chromium 128 | 2024 | 399 / 400 |
| Firefox 128, WebKit 18.0 | 2024 | 400 / 400 each |
| Chromium 120 | 2023 | 400 / 400 |
| Chromium 108 | 2022 | 400 / 400 |

All seven scenes that WebKit 26.0 gets wrong use `aspect-ratio` (146 of the 400 do). WebKit 18.0, 18.4 and 27.2 agree with the other engines on those seven, so this is something that one release line did differently.

**What a miss costs.** If a browser gets a fraction *p* of the pool wrong, a beat with two scenes fails with probability about 2*p*, silently: the page's key goes wrong, its next request is refused, and the client mints again. For WebKit 26.0 here that is 3.5% of beats, or one re-mint in about fourteen minutes of continuous use at 30 second epochs. For Chromium 128 it is one in about a hundred minutes. Whether that is acceptable depends on what your gate costs the visitor. A cookie check costs nothing; a captcha every fourteen minutes is not acceptable. This is what `sceneMode: 'report'` is for.

### Why old releases are in the bake

A first pool was baked from the three current engines only (21 runs, no real zoom). Current engines got 31,996 of 32,000 right at 80 held-out settings. Older releases did not do as well:

| Browser build | First pool (current engines only) | This pool |
| --- | --- | --- |
| Chromium 136 | 397 / 400 | in the bake |
| Firefox 137 | 397 / 400 (386 at root `zoom` 0.9) | in the bake |
| WebKit 18.4 | 390 / 400 | in the bake |
| Chromium 120 | 382 / 400 | 400 / 400 |
| Chromium 108 | 382 / 400 | 400 / 400 |
| Chromium 101 | 377 / 400 | in the bake |

In the scenes that old Chromium got wrong, a few constructs were over-represented (the four-value `inset` shorthand, percentage `translate`, `height: auto !important` among them), which points at behaviour that changed between releases. Adding a release from 2022 and a set from 2025 to the bake removed those scenes, including for the releases in between that stayed held out. Together with the real zoom settings, the extra runs halved the yield, from one candidate in eight to one in sixteen. That costs a few more minutes of baking.

The rule that follows: **bake across the range of browsers you intend to serve**, oldest included. A release that behaves unlike its neighbours (WebKit 26.0 above) is only caught by having it in the bake or by report mode on real traffic.

### Clients with no browser engine

| Client | Scenes right | What it reported |
| --- | --- | --- |
| jsdom 31.0.1 | 0 / 400 | every box 0, 0, 0, 0 |
| happy-dom 21.0.4 | 0 / 400 | every box 0, 0, 0, 0 |
| linkedom 0.18.15 | 0 / 400 | every box 0, 0, 0, 0 |
| Servo 0.8.0 (nightly `d86e120b1`) | 0 / 400 | every box empty |
| Lightpanda 1.1.0 nightly | no result | did not finish within 60 s |

The three DOM libraries have no layout at all, which is the expected result and the one that matters: they are what a ported client runs on. Servo is a real layout engine, and we did not find out why it reports empty boxes here; it may be the shadow root or the constructable stylesheet and not layout itself. Read that row as "does not pass today", not as "cannot".

### Cost in the page

Building, laying out, reading and hashing one scene took 0.6 to 2.0 ms in Chromium, 0.9 to 2.8 ms in Firefox and 1.8 to 5.1 ms in WebKit across all runs, on a machine that other jobs were sharing. At two scenes per 30 second epoch this is not measurable in a page.

### Not measured

- **Safari.** Playwright's WebKit on Linux is the same engine built for another platform. It is not Safari on macOS or iOS.
- **Any real phone**, and any browser on Windows or macOS.
- **Firefox and WebKit from before 2024.** The Playwright 1.20, 1.28 and 1.40 builds of both would not start on this machine. Chromium is covered back to version 101.
- **Chromium 101 beyond two settings**, both of which were in the bake.
- **Browser extensions** that inject styles, and **real traffic** in general.

So the numbers above are a lower bound on how often an honest visitor will be refused, not an estimate of it. `scripts/bake.js --wait 1` prints a URL that a phone can open to add a run to a bake, and `--check` does the same for an existing pool.

### Reproducing

```sh
npm i --no-save playwright && npx playwright install chromium firefox webkit
node scripts/measure-engines.mjs bake pool.json 400 9000   # current engines
node scripts/measure-engines.mjs check pool.json           # 88 held-out settings
node scripts/measure-no-browser.mjs pool.json              # after: npm i --no-save jsdom happy-dom linkedom
```

For older releases, install an older Playwright in another directory and point the driver at it (`PLAYWRIGHT_FROM=/dir TAG=old- MATRIX=small`). To put several releases into one bake, start `node scripts/bake.js --out pool.json --count 400 --candidates 9000 --serve --port 8799` yourself, run the driver once per release with `ATTACH=1`, then `POST /finish`.

## 4. Messages

All bodies are JSON. Binary values are unpadded base64url.

```
POST {base}/mint   { pub, proof? }
  200 { ok, v, gid, pub, epoch: 0, epochMs, beatAfterMs, graceMs, budget, challenge, program, shadow? }
  403 { ok: false, error: "gate" }

POST {base}/beat   { gid, epoch, mac, shadow? }   mac = HMAC(k_epoch, "pt0/beat\n" || u32(epoch))
  200 { ok, epoch, challenge, program, shadow? }
  401 { ok: false, error }                        too_early carries retryAfterMs

any protected request
  header  Tether-Token: 0.<gid>.<epoch>.<ctr>.<mac>
  401     Tether-Error: <error>
```

`pub` is an uncompressed P-256 point (65 bytes). `gid` is 16 random bytes. `program` is `{ ops: [[op, a, b, imm], ...], probes: [name, ...], scenes?: [{ t, c }, ...] }`; the instruction set is specified by `runProgram` in `src/core.js` and pinned by a test vector. A scene is `{ t: tree, c: css }`, where the tree is `["tag.class", ...children]`; its format and limits are in `src/scenes.js`. In report mode the server's `shadow` is a list of scenes outside the program, and the client's `shadow` in its next beat is the list of digests it measured, as 16 hex digits each. `target` is the request path and query exactly as sent.

Errors: `missing`, `malformed`, `unknown_generator`, `expired`, `stale_epoch`, `bad_mac`, `over_budget`, `replay`, `too_early`, `fork`, `gate`, `capacity`.

The client treats `replay` as "sign again" and every other 401 as "this generator is finished, mint a new one", and retries the request once.

## 5. About the original idea

The starting sketch was: a noise generator on the frontend, signed by a private key so it cannot be recreated, producing a 30-second TOTP that each request must carry. Most of that survives. Two parts changed and it is worth saying why.

**The signature.** A signature proves who made the generator. It does not stop anyone from *running* a genuine one somewhere else, and that is the actual attack: nobody needs to recreate the generator when the server hands them a real one. The property wanted from "cannot be recreated" comes from the seed instead: only the server can create a generator, because only the server knows what it stored. Since the party that issues tokens is the party that checks them, no public-key signature is needed. Public-key crypto does appear, in the mint key exchange, where it keeps the seed off the wire.

**The TOTP.** A plain TOTP is a pure function of a fixed secret and the clock. Lift the secret once and you can compute codes forever, from anywhere, in parallel. The 30-second code here differs in three ways: it is bound to one request, its key is re-derived every epoch from a value the server only gives to someone still present, and the server counts how many codes each generator has spent.

## 6. Where this sits

The underlying move (make the page compute something per request that a script cannot cheaply compute) is what large sites already do privately. What is missing in public is a specified, self-hostable version with an honest account of which parts are sound.

[PRIOR-ART.md](PRIOR-ART.md) is the full survey, with sources and what was and was not verified. In short: every mechanism here has a precedent; the nearest whole systems are SHPF (2013) and signprint (2026), which both compare answers and return a verdict; Picasso (2016) is the precedent for answers that come from real clients instead of a formula; and we found no precedent for layout scenes kept only where independent engines agree, or for the combination as one open protocol. The table below maps techniques to what is built.

| Technique | Used by | In pagetether |
| --- | --- | --- |
| Per-request signatures over URL and body from an in-page VM | TikTok (`X-Bogus`, `X-Argus`), X (`x-client-transaction-id`), Akamai, Kasada, Shape/F5 | Built. The signature is a plain HMAC; the VM is the noise program. Unlike a signing VM shipped with a release, the program and key change every epoch at runtime. |
| Attestation tokens minted by a VM in the page | YouTube/Google BotGuard and PO tokens | Same shape as mint + beat. Open tooling already runs BotGuard outside a browser to mint tokens, which is the "full port" row in the README: expect it, and bound it with the budget. |
| Environment integrity checks with silently poisoned output | Commercial bot-management VMs | Built as probes folded into the key. Which checks to run is left to the deployer. |
| Custom bytecode VMs, obfuscation, WASM signers | Kasada, Shape/F5, `javascript-obfuscator`, hand-rolled Rust-to-WASM | Compatible, not included. Obfuscate your probe implementations if you want; the protocol does not depend on it. A WASM signer rotated in CI rotates per release, pagetether rotates per epoch. |
| Non-extractable WebCrypto keys, proof of possession per request | DPoP (RFC 9449) | Built. Keys are non-extractable and derived from an ECDH exchange. DPoP's key is static; this one ratchets. |
| Short-lived credential, refreshed by proving possession of a key | Device Bound Session Credentials | Same shape as the beat. DBSC signs the refresh, not each request, and protects a user from cookie theft; pagetether applies the shape against the client itself. Binding to a TPM-backed key is future work. |
| Session secret from a key exchange, HMAC per request, recurring CSS challenges | SHPF (Unger et al., ARES 2013) | The nearest academic system. Its challenges ask whether CSS properties are supported and compare the answers; here the challenge is a layout, and the answer goes into the key. |
| Rendering challenge whose answer the server cannot compute, checked against answers from real clients | Picasso (Bursztein et al., 2016); signprint (2026) | Scenes. Picasso and signprint use canvas output, which varies by device, and return a verdict. Scenes use layout, keep only what every engine agrees on, and fail silently. |
| Rotation with reuse detection | OAuth refresh-token rotation (RFC 9700), WebAuthn signature counters, App Attest counters | Built: the beat, the counter and the fork rule (P6). |
| Platform attestation | Private Access Tokens / Privacy Pass (RFCs 9576 to 9578), Play Integrity and App Attest (native apps) | A gate. Not built in. Web Environment Integrity, sometimes listed here, was dropped by Google in 2023 and is not available. |
| Proof of work per request | Kasada and others | Not used. The budget bounds rate without spending honest users' battery. PoW is available as a gate if you want it. |
| Single-use nonces against replay | Everyone | Built (counters). |
| Polymorphic field names, paths and DOM | Kasada, Shape/F5 reverse proxies | Out of scope, complementary. See response sealing below for a related idea that falls out of the shared key. |
| Keeping data out of SSR and hydrating by signed fetch | General practice | A deployment rule, and a necessary one: pagetether protects only what is fetched through it. |
| Honeypot fields and canary endpoints | General practice; `diamondrubinny/Antirea` | Out of scope, complementary. `onEvent` reports `fork`, `replay` and `bad_mac` per generator, which are natural inputs to a shadow-ban policy. |
| Asymmetric request signing with nonces | `mwalkowski/api-request-security-poc` | Symmetric here, because issuer and verifier are the same party. |

Further reading on what attackers do with these systems: `armxe/tiktok-api` (TikTok's signing pipeline taken apart), `reacher-z/Awesome-REA` (index of web reverse-engineering tools and papers), and the yt-dlp project's PO token guide.

## 7. Deployment notes

- **Verify where the client's request target is still intact**, at the edge or before any path rewriting.
- **The verifier does not depend on Node.** `src/tether.js` takes its hashing, randomness and key exchange as arguments. `src/server.js` supplies `node:crypto`; `src/web.js` supplies WebCrypto for the key exchange and a small synchronous SHA-256 for the rest, because verification has to check the counter and mark it used with no `await` in between. That build runs in edge workers, and in a browser tab for the project site.
- **What to do on failure is policy.** `verify()` returns a verdict. Returning 401 is the default in `guard()`. Serving decoy data or tarpitting instead denies the attacker a clean signal, at the price of confusing an honest client on a false positive.
- **Roll out in report-only first.** Call `verify()`, log the result, serve the request anyway. Enforce once the failure rate from real users is understood, especially with custom probes. For scenes, start with `sceneMode: 'report'` and watch `onEvent('scene')`.
- **Bake your own pool, with the browsers your users have.** `npm run bake -- --out pool.json --chrome --firefox` uses the browsers installed on the machine; `--wait N` also takes runs from any device that opens the printed URL (a phone, Safari). Include the oldest browser version you intend to support: section 3 shows what happens to versions older than the bake. The pool file holds the answers. Treat it like a password file, and do not deploy the example pool in this repository, whose answers are public.
- **Rotate the pool.** `tether.setScenes(newPool)` takes effect at each generator's next beat. A table of answers collected from the old pool stops working then.
- **Move sensitive data out of the initial HTML.** Anything in `__NEXT_DATA__` or similar is free to a scraper.
- **The gate carries real weight.** With a free gate, an attacker's cost per generator is one HTTP request plus a little CPU per epoch. The budget still caps each generator, so the attack becomes "many generators", which is what the gate prices.

## 8. Open questions

1. **Scenes on real devices.** Section 3 measures desktop engine builds on one Linux machine. Safari itself, Chrome and Firefox on Android, Safari on iOS, and browsers with unusual font or accessibility settings are unmeasured. Report mode exists for exactly this, and nobody has run it on real traffic yet.
2. **How far the agreement extends.** Scenes avoid text, borders and viewport units. Each of those would enlarge the space an attacker has to implement, and each is a place where honest browsers differ. Whether a careful filter can admit some of them is open. So is the opposite question: whether a much smaller layout engine than a browser's can answer most of a pool. Servo, an independent engine, answered none of the pool as tested (section 3), but we do not know why, so that is not evidence either way.
3. **Shared state.** Verification needs an atomic "check MAC, check and set counter" against a store that every API node sees. A Redis script is the obvious shape. Edge verification with only eventually-consistent state weakens P5 and P6 by the replication lag.
4. **Token farms and scene oracles.** A real browser can sit as a signing oracle for headless workers, or as a layout oracle that only answers scenes. The budget caps each generator at one page's worth of requests, and request binding means every request is signed individually. Whether the oracle pattern leaves a detectable timing signature is unexplored.
5. **Response sealing.** Both sides share `k_e`, so responses could be encrypted under a key derived from it and the request counter. A captured response would then be useless without the live generator, and SSR data could be shipped sealed. This is a principled version of schema polymorphism. It costs cacheability.
6. **Hardware binding.** Where a platform offers device-bound keys, the mint exchange could be bound to one, making a generator non-portable across machines and not just across processes.
7. **Hidden tabs.** A beat from a service worker or a `visibilitychange`-driven catch-up could keep a generator alive without re-minting. Whether a lapsed generator *should* survive a hidden tab is a policy question.
8. **Formal treatment.** P1 to P6 are argued informally above. They are simple enough to model and prove.

## 9. References

The full list, with what was verified and how, is in [PRIOR-ART.md](PRIOR-ART.md).

- RFC 9449, OAuth 2.0 Demonstrating Proof of Possession (DPoP)
- RFC 9421, HTTP Message Signatures
- RFC 9700 (BCP 240), Best Current Practice for OAuth 2.0 Security
- RFC 9576, 9577, 9578: Privacy Pass architecture, HTTP authentication scheme, issuance protocols
- W3C Web Application Security WG, Device Bound Session Credentials
- Unger et al., "SHPF: Enhancing HTTP(S) Session Security with Browser Fingerprinting", ARES 2013
- Bursztein, Malyshev, Pietraszek, Thomas, "Picasso: Lightweight Device Class Fingerprinting for Web Clients", SPSM 2016
- Riordan and Schneier, "Environmental Key Generation towards Clueless Agents", 1998
- github.com/C00LVansh/signprint
- yt-dlp wiki, PO Token Guide
- github.com/armxe/tiktok-api
- github.com/reacher-z/Awesome-REA
- github.com/diamondrubinny/Antirea
- github.com/javascript-obfuscator/javascript-obfuscator
- github.com/mwalkowski/api-request-security-poc
