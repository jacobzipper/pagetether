# Prior art

What already exists, how close each piece comes, and what pagetether adds. Written in November 2026 from a survey of standards, papers, vendor documentation and open-source projects.

How to read it: a claim marked **(doc)** comes from the vendor's or author's own text, **(3p)** from a third party's analysis, and **(abstract)** from an abstract or search result only. Closed anti-bot products document very little, so "we found no product that does X" means exactly that and no more.

## Summary

1. **Every mechanism in pagetether has a precedent.** Per-request MACs, key exchange for a session secret, rotating secrets with clone detection, environment checks, issuance budgets and "the server cannot compute the answer" all exist separately.
2. **We found nothing that combines them into one open protocol**: a page-held key that ratchets every epoch, whose next value depends on the layout engine's answer to a question the server just picked, with each request bound and counted, and with copies detected. The two nearest systems are [SHPF](#shpf) (2013, academic) and [signprint](#signprint) (2026, open source). Both stop at "compare the answer and return a verdict".
3. **The part closest to new is the scene**: a randomly generated layout whose answer is identical in Chromium, Firefox and WebKit, was measured in browsers ahead of time by the operator alone, and is folded into the key without being sent. [Picasso](#picasso) is the precedent for answers that come from real clients instead of a formula. It wants answers that *differ* by device class and needs a crowd to learn them. Scenes want answers that are the *same* in every real engine, which is what lets one operator bake a pool with three browsers.
4. **The problem is underserved in the literature.** We found no academic work on protecting a private web API against protocol replication, and none on ratcheting a web session key with clone detection. The surrounding work is about cookie theft (protecting the user from an attacker) or bot detection (a verdict about a visitor).

## The attack this is for

A site's frontend calls a private API. Someone records the traffic, reads the JavaScript, and writes a client that calls the API with no browser. Until recently that took a person some days per site. There is now a family of tools that hand the job to a language model:

| Tool | Its own description | What it says stops it |
| --- | --- | --- |
| [Integuru](https://github.com/Integuru-AI/Integuru) | "builds permissionless integrations through reverse engineering platforms' internal APIs", from a HAR file **(doc)** | |
| [Unbrowse](https://github.com/unbrowse-ai/unbrowse) | "calls websites' first-party APIs instead of running a browser" **(doc)** | Its [paper](https://arxiv.org/html/2604.00694v1) lists anti-bot measures and token expiry as limits, and says cached routes to sites that block non-browser traffic "would fail entirely" **(doc)** |
| [reverse-api-engineer](https://github.com/kalil0321/reverse-api-engineer) | "Reverse engineer any website into a typed API client" **(doc)** | "Sites with aggressive bot detection may block capture" **(doc)** |
| [agent-browser `derive-client`](https://skills.cat/skills/vercel-labs/agent-browser/derive-client) | Turns a recorded session into an HTTP client **(doc)** | Lists "Signed/expiring request params" as a breakage, fixed by falling back to a browser for that step **(doc)** |
| [web-hacker](https://github.com/VectorlyApp/web-hacker) | "Index the world's undocumented APIs" **(doc)** | |

Two things follow from those rows. The tools' goal is to *leave the browser behind*, because a browser per request is slow and expensive. And their own documentation names the defence: parameters that are signed and that expire. pagetether is that defence, specified, with the expiry tied to a question only a browser answers.

Obfuscation was the usual answer to "they will read the JavaScript". It is weaker than it was. Google reports an LLM-based JavaScript deobfuscator ([CASCADE](https://arxiv.org/abs/2507.17691)) "already deployed in Google's production environment" **(abstract)**. A benchmark of LLM deobfuscation ([JsDeObsBench](https://arxiv.org/abs/2506.20170)) finds models strong at simplification with remaining "challenges in maintaining syntax accuracy and execution reliability" **(abstract)**. That supports "weakening", not "dead", and this document claims no more. pagetether's design assumption is the conservative one: **the attacker has read all of the client code**.

### The lesson of one signed header

X (Twitter) signs its API requests with an `x-client-transaction-id` header. Part of the input comes from rendering: the page animates an element with an easing curve built from numbers in the document, then reads back computed `color` and `transform` **(3p: [analysis](https://fa0311.github.io/antibot_blog_archives/web/twitter-header-part-2.html))**. That sounds like it needs a browser. It did not: the rendering-derived part was one cubic Bézier and two interpolations, so it was rewritten as arithmetic, and standalone ports exist in Go, Python and JavaScript **(3p)**.

A check that reads from the rendering engine is only as strong as the amount of engine behind it. One easing curve is a formula. That is the reason scenes are generated from a large space (block, float, flex, grid and positioned layout, the cascade, `calc`/`min`/`max`/`clamp`, percentages, margins that collapse) and why the server never holds a formula either: if we could write the function that answers a scene, so could the attacker.

The other direction also matters. When the computation is a whole changing program, attackers stop porting and run it in a generic JavaScript runtime: yt-dlp dropped its own interpreter and now requires an external JS runtime for YouTube's challenges **(doc: [yt-dlp wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS))**. So "nothing small to port" only helps if the question needs a *rendering* engine, not just a JavaScript engine. jsdom, happy-dom and linkedom have a DOM and no layout; they answer 0 of 400 scenes (see [DESIGN.md](DESIGN.md#3-scenes-measurements)).

## Key-bound credentials

Binding a credential to a key the client holds, so that a stolen cookie is not enough.

| Work | What it does | Compared with pagetether |
| --- | --- | --- |
| DPoP, [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449) (2023) | Each request carries a signed proof under a client key | Same per-request binding. The key is static for the token's life; nothing checks the environment or counts requests. |
| HTTP Message Signatures, [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) (2024) | A signature or MAC over chosen request components | A format for the signing step. pagetether could adopt it; the token format is not the interesting part. |
| Token Binding, RFC 8471 (2018); Dietz et al., "Origin-Bound Certificates", USENIX Security 2012 | Binds cookies to a TLS-level client key | Protects a user from cookie theft. Does nothing against the key's own holder. Not deployed in browsers today. |
| Device Bound Session Credentials, [W3C FPWD, 21 Aug 2025](https://www.w3.org/TR/dbsc/) | Short-lived cookies; refreshing one needs a signature from a device key | The beat has the same shape. DBSC signs registration and refresh only, **not each request**, and is aimed at theft by malware, not at the device's owner. |
| Adida, "SessionLock", WWW 2008 | Session secret in the URL fragment; requests carry an HMAC and timestamp | Per-request MAC over a session secret. No rotation. |
| De Ryck et al., "SecSess", SAC 2015, doi:10.1145/2695664.2695764 | A shared secret protects each request's integrity **(abstract)** | Same. |
| Dacosta et al., "One-Time Cookies", ACM TOIT 12(1), 2012, doi:10.1145/2220352.2220353 | Per-request HMAC over the URL and an expiry, stateless at the server | Despite the name, the journal version is **not single-use**: an identical request can be replayed until its expiry (the paper suggests 30 seconds). pagetether's counter makes a token single-use, at the price of server state. |

All of these defend the user against a third party. pagetether points the same tools at the client itself: the party holding the key is the one being constrained.

## Rotation and clone detection

| Work | What it does | Compared with pagetether |
| --- | --- | --- |
| Lamport, CACM 1981; S/KEY and OTP (RFC 2289); HOTP (RFC 4226); TOTP (RFC 6238) | One-time values from a hash chain, a counter or the clock | The "30-second code" in the original sketch. A TOTP is a pure function of a fixed secret and the time: lift the secret once and compute codes forever. The ratchet takes a fresh server value and an environment answer every epoch. |
| OAuth refresh-token rotation, [RFC 9700 / BCP 240](https://www.rfc-editor.org/rfc/rfc9700) §4.14 (2025) | Reuse of an already-rotated refresh token reveals a breach; the active token is revoked | This is fork detection. pagetether applies it to a 30-second key instead of a long-lived token. |
| WebAuthn Level 2, [§6.1.1](https://www.w3.org/TR/webauthn-2/#sctn-sign-counter) | "The signature counter's purpose is to aid Relying Parties in detecting cloned authenticators." **(doc)** | The same idea with a counter. |
| Apple App Attest | Per-request assertions carry a counter that must strictly increase **(doc)** | The closest deployed analogue of pagetether's counter and fork rule, for native apps with a hardware key. |
| Cremers, Fairoze, Kiesl, Naska, CCS 2020, doi:10.1145/3372297.3423354 | A double ratchet that tolerates some desynchronisation and still detects clones | The careful version of what the beat's idempotency window does informally. |
| Milner, Cremers, Yu, Ryan, CSF 2017, doi:10.1109/CSF.2017.21 | Foundations for detecting misuse of secrets without false positives | The theory. pagetether's P6 has not been modelled against it. |

Fork detection on a rotating secret is established. Using it on a page-held key is an application, not a new principle.

## Proving the environment

### What the large anti-bot products do

The common shape, from the documentation that exists: JavaScript collects signals, the server issues a cookie or token that is good for minutes to hours, and the client reuses it.

| Product | What is documented |
| --- | --- |
| Cloudflare | Turnstile tokens last 300 seconds and are single-use **(doc)**. JavaScript detections run on HTML page loads and are stored in `cf_clearance` with a 15-minute life **(doc)**. `__cf_bm` expires after 30 minutes of inactivity **(doc)**. |
| AWS WAF | An encrypted `aws-waf-token` cookie holds challenge results; default and minimum immunity time is 300 seconds **(doc)**. |
| HUMAN (PerimeterX) | Session cookies in the `_px*` family expire in minutes; identifier cookies last a year **(doc)**. |
| Akamai | Sensor data is posted, then the `_abck` cookie is reused within the session **(3p)**. |
| Google BotGuard, YouTube PO tokens | A VM in the page runs a server-supplied program; the result is exchanged for an integrity token, which mints tokens bound to a video or session, with lifetimes of hours **(3p: [BgUtils](https://github.com/LuanRT/BgUtils), [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide))**. Open tooling runs the VM instead of porting it. |
| Kasada | "Each request has to prove it came from a running copy of Kasada's current code"; "a captured token can't be replayed at volume" **(doc: [kasada.io](https://www.kasada.io/platform/))**. A custom obfuscated VM with a proof-of-work header **(3p)**. |
| F5 (Shape) | Telemetry attached to protected requests as headers or in the body; "sophisticated code obfuscation" **(doc)**. |
| Vercel BotID | An encrypted header on protected fetches, Kasada-powered in its deep mode **(3p: [analysis](https://www.nullpt.rs/reversing-botid))**. |
| Talsec AppiCryptWeb | A WASM agent "generates a signed cryptogram per API request" with a nonce **(doc)**. |

Per-request proofs do exist commercially (Kasada, F5, BotID, Talsec). All are closed, none is self-hostable, and all lean on obfuscation, which is the assumption this project declines to make. None of the pages we read documents a key ratchet, fork detection or a design without a verdict. They may have them.

DataDome, Arkose and Imperva could not be checked: their technical documentation was unreachable or behind a login.

### Open-source defences from the AI-scraper era

What the attacker holds after passing each one:

| Project | Mechanism | Afterwards the client holds |
| --- | --- | --- |
| [Anubis](https://github.com/TecharoHQ/anubis) | SHA-256 proof of work | A signed cookie, valid for days, usable by any client |
| go-away | Rules plus cookie, refresh and proof-of-work challenges | A pass that is reused |
| mCaptcha, Friendly Captcha | Proof of work or a widget per form | One single-use token per submission |
| [Cap](https://capjs.js.org) | Proof of work plus server-generated JavaScript that checks the browser environment | A token checked at a verify endpoint |
| AI Labyrinth, Nepenthes, iocaine | Decoys and tarpits | Nothing (there is no gate) |
| Web Bot Auth, pay per crawl | Bots identify themselves with signed requests | A private key. Identification, not exclusion |

These gate a *site* against crawlers. Once through, a script holds a bearer credential. None binds individual API requests.

### The closest systems

<a id="shpf"></a>**SHPF.** Unger, Mulazzani, Frühwirt, Huber, Schrittwieser, Weippl, "SHPF: Enhancing HTTP(S) Session Security with Browser Fingerprinting", ARES 2013, doi:10.1109/ARES.2013.33 ([preprint](https://publications.sba-research.org/publications/shpf_extendedPreprint.pdf), [code](https://github.com/mmulazzani/SHPF)). A Diffie-Hellman session secret, an HMAC and timestamp on every request, and recurring challenges that ask the browser about a random subset of 23 CSS properties. Answers are compared with those recorded at the start of the session; a mismatch ends the session. **This is the nearest academic system.** Differences: its probes test whether a CSS property is *supported* (a table per browser version answers them), the answers are sent and compared, the key does not evolve, and there is no clone detection or budget. Its goal is session hijacking, not the session's owner.

<a id="signprint"></a>**signprint.** [github.com/C00LVansh/signprint](https://github.com/C00LVansh/signprint) (Apache-2.0, first published October 2026, early). A server canvas challenge and other probes, a non-extractable ECDH session key that expires in minutes, RFC 9421 signatures per request, and canvas answers compared against devices the operator calibrated **(doc)**. **This is the nearest open-source project**, built independently in the same month. Differences: it scores a session and emits an explicit verdict header; its README describes no ratchet, fork detection, per-epoch budget or silent failure; its probes are canvas and WebGL, which vary by GPU and driver, where scenes are layout, which does not.

<a id="picasso"></a>**Picasso.** Bursztein, Malyshev, Pietraszek, Thomas, "Picasso: Lightweight Device Class Fingerprinting for Web Clients", SPSM@CCS 2016 ([Google Research](https://research.google/pubs/pub45581/)). The server sends a seed; the client draws canvas primitives from it and returns a hash. The server cannot compute the answer: "like attackers, we cannot produce the correct answer without access to the client's system." Expected answers come from real clients: a bootstrap set from trusted devices, then growth by sending a known challenge next to unknown ones and accepting an answer once enough devices agree. **This is the precedent for "the answers come from real clients, not a formula", and pagetether does not claim that idea.** Differences: canvas rasterisation instead of layout; the goal is to tell device classes apart, so answers are meant to differ across them; learning the answers needs a very large user base; the hash is sent for a verdict; there is no session, ratchet or budget; no code was released.

### Environment in the key

Folding a measurement of the environment into key material, so that the wrong environment silently gets the wrong key, is also old:

- Riordan and Schneier, "Environmental Key Generation towards Clueless Agents", LNCS 1419, 1998: keys derived from environmental data, so that code cannot be run (or understood) elsewhere.
- TCG DICE and SAKE (Seshadri, Luk, Perrig, DCOSS 2008): a firmware measurement is mixed into derived keys, and a successful handshake attests implicitly **(abstract)**.
- Approov (commercial, mobile and web): on a failed attestation "a token is still issued, but it is not signed with the correct secret" **(doc)**. This is the closest deployed analogue of pagetether's silent wrong key.
- Collberg, Martin, Myers, Nagra, ACSAC 2012, doi:10.1145/2420950.2420997: the server continuously pushes diversified client code so that a tampered client cannot keep up **(abstract)**. The beat program is this idea at a 30-second period.

We found no web anti-bot work that folds a layout measurement into a session key. That is a narrow statement about what we found, in a field where the largest systems are undocumented.

### Browser behaviour as a signal

Papers that use rendering or CSS behaviour to identify a browser: Ho et al., "Tick Tock: Building Browser Red Pills from Timing Side Channels", WOOT 2014; Lin et al., "Fashion Faux Pas", IEEE S&P 2023; Kalantari et al., "Browser Polygraph", IMC 2024; Trampert et al., "Cascading Spy Sheets", NDSS 2025, which distinguishes 97.95% of 1,176 browser and OS combinations with CSS alone **(abstract)**. These are fingerprints: they look for behaviour that *differs*. A scene is the opposite selection from the same raw material: behaviour that is identical across engines yet absent without one. None of these is a keyed challenge-response protocol.

Measurement studies of deployed bot detection, for context: Jonker et al., ESORICS 2019; Azad et al., DIMVA 2020; Vastel et al., MADWeb 2020; Li et al., IEEE S&P 2021.

## Budgets and cost

| Work | What it does | Compared with pagetether |
| --- | --- | --- |
| Juels and Brainard, "Client Puzzles", NDSS 1999; Hashcash | Proof of work per request or session | A cost the attacker's hardware pays more cheaply than a phone does. pagetether offers it only as a gate. |
| Privacy Pass, RFC 9576 to 9578 (2024) | Unlinkable tokens, issued by an attester and redeemed at the origin | A way to pay at the mint gate. |
| Rate-limited Privacy Pass tokens (draft-ietf-privacypass-rate-limit-tokens, lapsed 2024); Anonymous Rate-Limited Credentials (draft-ietf-privacypass-arc-protocol) | A limit on issuance per client per origin, enforced at the attester; ARC turns one credential into a fixed number of presentations | The nearest standards work to a budget. It limits *issuance*, with privacy as the goal. pagetether's budget limits *use* of one live key, with no privacy property at all. |

## Platform attestation

Play Integrity (Android) and App Attest (iOS) bind requests to an attested app with hardware keys, and are the strong form of what pagetether approximates. They exist for native apps. The web equivalent, Web Environment Integrity, was an explainer that Google dropped in November 2023. Private Access Tokens cover some devices. Where real attestation is available, use it at the mint gate; pagetether is for the cases where it is not.

## What is and is not claimed

| Property | Earliest precedent we know | New here |
| --- | --- | --- |
| Per-request MAC over method, path and body, under a session key | SessionLock (2008), One-Time Cookies (2012), DPoP | No |
| Session key from a key exchange, non-extractable in the page | SHPF (2013), DPoP, DBSC | No |
| Key refreshed on a short period by proving possession | DBSC, OAuth rotation | No |
| Clone and fork detection on the rotating key | RFC 9700, WebAuthn counter, Cremers et al. | No. Applying it to a page-held key is an application. |
| A hard request budget per key per period | Rate-limit tokens (issuance, not use) | In this form, we found no precedent. It is a small idea. |
| Recurring environment challenges during a session | SHPF, BotGuard | No |
| Answers the server cannot compute, learned from real clients | Picasso (2016) | No |
| Environment answer folded into the key, never sent | Riordan and Schneier (1998), DICE, Approov | No, as a principle. We found no web anti-bot system documented as doing it. |
| Questions drawn from generated CSS *layout*, kept only where independent engines agree, baked by one operator | | **We found no precedent.** |
| All of the above as one open, self-hostable protocol with a measured false-positive rate | SHPF and signprint each cover part | **We found no precedent.** |

So the honest summary is a combination claim and one component claim, both qualified by "that we could find". It is not a claim that the commercial products lack these properties.

## Not verified

Listed so that nobody reads more into the tables than is there.

- Not opened at all: KeeLoq rolling codes (no primary source found), S/KEY (RFC 1760), the TLS Channel ID draft, Apple's Private Access Token sessions, the rotation text in RFC 6819.
- Read as abstract or search result only: SAKE's exact use of its checksum, the DICE specification text, Collberg et al., SecSess, Hashcash, the 2025-26 preprints on detecting or throttling LLM web agents (arXiv:2606.30119, arXiv:2607.18659, arXiv:2509.01619), and Shape Security patent US 10,225,255 (use-count thresholds on challenge-response pairs).
- Third-party only, and sources conflict: Kasada header lifetimes and reuse rules; Akamai `_abck` semantics; whether the ports of X's header still work today; TikTok's current signing parameters.
- Unreachable: DataDome, Arkose and Imperva technical documentation.

## Corrections to earlier versions of this repository

- The design document described One-Time Cookies loosely as one-time. The journal version allows replay of an identical request until expiry.
- It described DBSC as proof of possession per request. DBSC signs refreshes, not requests.
- It listed rate-limited Privacy Pass tokens without saying that the draft lapsed and that its limit is on issuance per client per origin.
- It named BotGuard, TikTok's signer, DPoP and DBSC as the nearest relatives. SHPF and signprint are nearer and are now named first.
- It did not cite Picasso. With scenes in the design, Picasso is the most important citation.
