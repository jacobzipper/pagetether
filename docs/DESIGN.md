# pagetether design

Draft 0. Everything here may change.

## 1. The problem

A site's own frontend talks to a private API. An attacker opens DevTools, works out how the frontend authenticates (cookies, signed headers, opaque blobs, data split over several endpoints), reproduces it in a script, and then pulls data at machine speed without a browser. This is usually called protocol replication or headless replay.

The frontend runs on a machine the attacker controls, so no scheme can prevent this outright. Anything the page can compute, the attacker can compute. The useful question is economic: what does one working stream of scraped requests cost, and does that cost recur?

With a bearer cookie or a static signing routine the answer is "almost nothing, once". The attacker pays the reverse-engineering cost one time and every later request is free.

### Threat model

The attacker:

- reads and modifies all client code, and runs it in any environment;
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

What it does not give: the bundled probe answers are public, so a determined port fakes them (the last row of the README table). A deployment that wants this layer to bite ships private probes, rotates them, and obfuscates the page-side implementations with whatever it likes (a JS obfuscator, a WASM module, a commercial VM). pagetether's contribution here is the plumbing that makes a probe set cheap to rotate and expensive to answer wrongly, not a claim that any particular probe is unbeatable.

Good probes have answers that are identical across every genuine browser a site supports, cheap to compute, and awkward to compute without the real thing. Bad probes are ones with legitimate variance (fonts, GPU output, timing), because a false positive here locks out a real user with no explanation.

## 3. Messages

All bodies are JSON. Binary values are unpadded base64url.

```
POST {base}/mint   { pub, proof? }
  200 { ok, v, gid, pub, epoch: 0, epochMs, beatAfterMs, graceMs, budget, challenge, program }
  403 { ok: false, error: "gate" }

POST {base}/beat   { gid, epoch, mac }        mac = HMAC(k_epoch, "pt0/beat\n" || u32(epoch))
  200 { ok, epoch, challenge, program }
  401 { ok: false, error }                    too_early carries retryAfterMs

any protected request
  header  Tether-Token: 0.<gid>.<epoch>.<ctr>.<mac>
  401     Tether-Error: <error>
```

`pub` is an uncompressed P-256 point (65 bytes). `gid` is 16 random bytes. `program` is `{ ops: [[op, a, b, imm], ...], probes: [name, ...] }`; the instruction set is specified by `runProgram` in `src/core.js` and pinned by a test vector. `target` is the request path and query exactly as sent.

Errors: `missing`, `malformed`, `unknown_generator`, `expired`, `stale_epoch`, `bad_mac`, `over_budget`, `replay`, `too_early`, `fork`, `gate`, `capacity`.

The client treats `replay` as "sign again" and every other 401 as "this generator is finished, mint a new one", and retries the request once.

## 4. About the original idea

The starting sketch was: a noise generator on the frontend, signed by a private key so it cannot be recreated, producing a 30-second TOTP that each request must carry. Most of that survives. Two parts changed and it is worth saying why.

**The signature.** A signature proves who made the generator. It does not stop anyone from *running* a genuine one somewhere else, and that is the actual attack: nobody needs to recreate the generator when the server hands them a real one. The property wanted from "cannot be recreated" comes from the seed instead: only the server can create a generator, because only the server knows what it stored. Since the party that issues tokens is the party that checks them, no public-key signature is needed. Public-key crypto does appear, in the mint key exchange, where it keeps the seed off the wire.

**The TOTP.** A plain TOTP is a pure function of a fixed secret and the clock. Lift the secret once and you can compute codes forever, from anywhere, in parallel. The 30-second code here differs in three ways: it is bound to one request, its key is re-derived every epoch from a value the server only gives to someone still present, and the server counts how many codes each generator has spent.

## 5. Where this sits

The underlying move (make the page compute something per request that a script cannot cheaply compute) is what large sites already do privately. What is missing in public is a specified, self-hostable version with an honest account of which parts are sound.

| Technique | Used by | In pagetether |
| --- | --- | --- |
| Per-request signatures over URL and body from an in-page VM | TikTok (`X-Bogus`, `X-Argus`), X (`x-client-transaction-id`), Akamai, Kasada, Shape/F5 | Built. The signature is a plain HMAC; the VM is the noise program. Unlike a signing VM shipped with a release, the program and key change every epoch at runtime. |
| Attestation tokens minted by a VM in the page | YouTube/Google BotGuard and PO tokens | Same shape as mint + beat. Open tooling already runs BotGuard outside a browser to mint tokens, which is the "full port" row in the README: expect it, and bound it with the budget. |
| Environment integrity checks with silently poisoned output | Commercial bot-management VMs | Built as probes folded into the key. Which checks to run is left to the deployer. |
| Custom bytecode VMs, obfuscation, WASM signers | Kasada, Shape/F5, `javascript-obfuscator`, hand-rolled Rust-to-WASM | Compatible, not included. Obfuscate your probe implementations if you want; the protocol does not depend on it. A WASM signer rotated in CI rotates per release, pagetether rotates per epoch. |
| Non-extractable WebCrypto keys, proof of possession per request | DPoP (RFC 9449), Device Bound Session Credentials | Partly built. Keys are non-extractable and derived from an ECDH exchange. DBSC's "short-lived credential, refreshed by proving possession" is the same shape as the beat; DBSC protects a user from cookie theft, pagetether applies the shape against the client itself. Binding to a TPM-backed key is future work. |
| Platform attestation | Private Access Tokens / Privacy Pass (RFCs 9576 to 9578), Play Integrity (Android apps) | A gate. Not built in. Web Environment Integrity, sometimes listed here, was withdrawn by Google in 2023 and is not available. |
| Proof of work per request | Kasada and others | Not used. The budget bounds rate without spending honest users' battery. PoW is available as a gate if you want it. |
| Single-use nonces against replay | Everyone | Built (counters). |
| Polymorphic field names, paths and DOM | Kasada, Shape/F5 reverse proxies | Out of scope, complementary. See response sealing below for a related idea that falls out of the shared key. |
| Keeping data out of SSR and hydrating by signed fetch | General practice | A deployment rule, and a necessary one: pagetether protects only what is fetched through it. |
| Honeypot fields and canary endpoints | General practice; `diamondrubinny/Antirea` | Out of scope, complementary. `onEvent` reports `fork`, `replay` and `bad_mac` per generator, which are natural inputs to a shadow-ban policy. |
| Asymmetric request signing with nonces | `mwalkowski/api-request-security-poc` | Symmetric here, because issuer and verifier are the same party. |

Further reading on what attackers do with these systems: `armxe/tiktok-api` (TikTok's signing pipeline taken apart), `reacher-z/Awesome-REA` (index of web reverse-engineering tools and papers), and the yt-dlp project's PO token guide.

## 6. Deployment notes

- **Verify where the client's request target is still intact**, at the edge or before any path rewriting.
- **What to do on failure is policy.** `verify()` returns a verdict. Returning 401 is the default in `guard()`. Serving decoy data or tarpitting instead denies the attacker a clean signal, at the price of confusing an honest client on a false positive.
- **Roll out in report-only first.** Call `verify()`, log the result, serve the request anyway. Enforce once the failure rate from real users is understood, especially with custom probes.
- **Move sensitive data out of the initial HTML.** Anything in `__NEXT_DATA__` or similar is free to a scraper.
- **The gate carries real weight.** With a free gate, an attacker's cost per generator is one HTTP request plus a little CPU per epoch. The budget still caps each generator, so the attack becomes "many generators", which is what the gate prices.

## 7. Open questions

1. **Probe calibration.** Because a wrong probe answer is silent by design, the server cannot tell *which* probe an honest browser got wrong. A report-only channel is needed (run candidate probes, send answers back in the clear, do not fold them into the key) so new probes can be validated on real traffic before they are enforced.
2. **Which probes are worth having.** Layout arithmetic is a toy. Candidates: engine-invariant behaviours that emulators get wrong, checks for tampered built-ins, consistency between what the page claims to be and how it behaves. Each needs a measured false-positive rate across real browsers.
3. **Shared state.** Verification needs an atomic "check MAC, check and set counter" against a store that every API node sees. A Redis script is the obvious shape. Edge verification with only eventually-consistent state weakens P5 and P6 by the replication lag.
4. **Token farms.** A real browser can sit as a signing oracle for headless workers. The budget caps it at one page's worth of requests, and request binding means the farm must sign each request individually. Whether the oracle pattern leaves a detectable timing signature is unexplored.
5. **Response sealing.** Both sides share `k_e`, so responses could be encrypted under a key derived from it and the request counter. A captured response would then be useless without the live generator, and SSR data could be shipped sealed. This is a principled version of schema polymorphism. It costs cacheability.
6. **Hardware binding.** Where a platform offers device-bound keys, the mint exchange could be bound to one, making a generator non-portable across machines and not just across processes.
7. **Hidden tabs.** A beat from a service worker or a `visibilitychange`-driven catch-up could keep a generator alive without re-minting. Whether a lapsed generator *should* survive a hidden tab is a policy question.
8. **Formal treatment.** P1 to P6 are argued informally above. They are simple enough to model and prove.

## 8. References

- RFC 9449, OAuth 2.0 Demonstrating Proof of Possession (DPoP)
- RFC 9421, HTTP Message Signatures
- RFC 9576, 9577, 9578: Privacy Pass architecture, HTTP authentication scheme, issuance protocols
- W3C Web Application Security WG, Device Bound Session Credentials
- yt-dlp wiki, PO Token Guide
- github.com/armxe/tiktok-api
- github.com/reacher-z/Awesome-REA
- github.com/diamondrubinny/Antirea
- github.com/javascript-obfuscator/javascript-obfuscator
- github.com/mwalkowski/api-request-security-poc
