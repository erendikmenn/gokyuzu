# Error audit: live game (fs.erenailab.com), 23 Sep 2026

Scope: every error players hit, from the game's own beacons (`/_e`) and the CloudFront access logs of both
distributions. This is an audit, so nothing in the game was changed. Each finding gives severity, impact, evidence, root
cause, a proposed fix with effort, and its status on the live build `5d6612f`.

**Data window.** Production logs 13:30–18:31 UTC (16:30–21:31 local). Beacons exist from `3833a08` (19:34 local) onward;
v1.0 sent none. Real player sessions with beacons: 242 (134 on `3833a08`, 72 on `94a7a5a`, 36 on `5d6612f`), from 167
anonymous visitors. The owner's own and headless sessions are excluded unless stated. `5d6612f` had only about 20
minutes of traffic when this was written, so its numbers are early. Visitors are salted hashes; no IPs appear here.

**Build ↔ time (UTC):** v1.0 < 16:34 ≤ `3833a08` < 17:24 ≤ `94a7a5a` < 18:10 ≤ `5d6612f`.

**Line numbers** refer to the committed `5d6612f`. The working tree is being changed by the touch-controls work
(uncommitted edits to `main.js`, `telemetry.js`, `src/ui/*`); that work adds `iab` (in-app browser id) and `in`
(input kind) to `open`/`fly`, which will help measure #1 and #2. It does not touch #3 or #5.

## Summary (ordered by impact)

| # | Finding | Severity | Impact | Status on 5d6612f | Fix effort |
|---|---|---|---|---|---|
| 1 | iOS pages die the moment the flight starts (memory) | Critical | 47 of 48 iOS flights on 3833a08/94a7a5a; iOS = 40 % of sessions | Much better (phone → `low`), not proven yet | S (telemetry) + M |
| 2 | X/Twitter in-app browser (iPhone) loses the WebGL context within seconds | High | 79 of 98 iOS sessions are this browser | Still happens; guard reloads once, then gives up | S–M |
| 3 | Tutorial beacons lose their session id (`s` collision): "0 of 17 finished" is wrong | High (data) | 488 beacons, every tutorial session | Still broken | XS |
| 4 | `null is not an object (evaluating 'array.byteLength')`, three.module.js:70 | High | 4 sessions (1 player, 3 owner iPad) | **Fixed** (reproduced before/after) | done |
| 5 | Load failures and early errors never reach telemetry | Medium | 9 stalled loads without a cause; 18/104 page loads without `open` | Still open | S |
| 6 | A second tab "crash-resumes" the first tab's flight and lowers quality permanently | Medium | 1 production session (Mac Safari) | New in 559df15+, still open | S |
| 7 | `shaderSource must be an instance of WebGLShader`, three.module.js:6162 | Medium | 1 session (iPhone, X in-app) | **Handled** (guard); one silent-loss gap remains | XS |
| 8 | Cloudflare pulls whole 172/381 MB height files on range misses | Low–Medium | 49.6 GB CloudFront egress; +2–6 s for the first player per colo | Still happens | S / M |
| 9 | Cloudflare managed challenge on the HTML page | Unknown | Not visible in CloudFront logs | Active | XS (check) |
| 10 | 403s for missing files | Low | favicon.ico 2,664 (v1.0 only, fixed); ~45 probes since | Mostly fixed | XS |
| 11 | `Cannot read properties of undefined (reading 'M_ID')` | Low | 1 session, harmless | Not our code | XS (filter) |
| 12 | `Script error.` | Low | 1 session (iPhone Safari) | New on 5d6612f, not our code | XS (filter) |
| 13 | Crashes that look like bugs | Info | none found; 109 crashes reviewed | — | XS (add position) |
| 14 | GPU budget monitor steps twice in 40 s on iPad | Low | 1 session (owner) | Open | S |

Distinct `t=err` messages in all logs: **4** (29 beacons; the client caps them at 5 per page, so counts understate
frequency). All four are listed (#4, #7, #11, #12).

---

## 1. iOS pages die the moment the flight starts (Critical)

**Impact.** 98 of 242 sessions are iOS (66 visitors), 79 of them in the X/Twitter in-app browser. On `3833a08` and
`94a7a5a`, 48 iOS sessions reached `fly`, and **in 47 of them nothing happened afterwards**. There was no heartbeat, no
tutorial event, no `end` beacon, and the median number of asset requests after `fly` was 0. 27 of the 48 were followed
within about 1 to 60 s by a new `open` from the same visitor, which is typical of iOS reloading a killed page.
For comparison, desktop pages stay alive a median of 207–238 s after `fly` and make 274–649 requests; Android pages stay
24–92 s. Only 2 of 98 iOS sessions ever sent a one-minute heartbeat.

| platform · build | flights | page alive after `fly` (median) | < 30 s | ≥ 60 s |
|---|---|---|---|---|
| iOS · 3833a08 | 30 | 0 s | 29 | 1 |
| iOS · 94a7a5a | 18 | 0 s | 18 | 0 |
| iOS · 5d6612f | 9 | 21 s | 6 | 1 |
| desktop · 3833a08 / 94a7a5a / 5d6612f | 58 / 22 / 17 | 238 / 237 / 207 s | 3 / 1 / 3 | 53 / 19 / 14 |
| Android · 3833a08 / 94a7a5a | 8 / 4 | 24 / 92 s | 5 / 0 | 2 / 3 |

**Root cause (strong evidence, not proven on a device).** The web process is killed for memory (iOS jetsam) when the
world becomes visible. Before `5d6612f` phones had no device class, so they started at `high` (every old iOS `open`
beacon says `q=high`). A memory probe with iPhone 15 emulation in Chromium, metering every WebGL allocation with
`src/core/gpu-meter.js`, gives these figures (`docs/errors/repro/mem-phone.mjs`):

| build · preset | GPU at `fly` | GPU 5 s later | JS heap 5 s later | decoded audio |
|---|---|---|---|---|
| 94a7a5a · high (what iPhones ran) | 939 MB | **1,300 MB** | 360 MB | 24 MB |
| 5d6612f · low (phone default now) | 348 MB | 515 MB | 233 MB | 24 MB |

Old builds add about 360 MB of GPU memory and 240 MB of JS heap in the 5 s after `fly`. Everything deferred until "ready"
lands at once: the rest of the city tiles, trees, the eagerly loaded cockpit GLB, audio decoding and first-frame
texture uploads. On a phone that means about 1.6 GB, more than an iOS WebView (especially inside another app) is
allowed to keep. The last requests before a death are terrain imagery, city tiles, airport textures and the audio
profile/m4a files, which is exactly this burst. Chromium emulation is not iOS; GPU byte counts are exact, timings are not.

**5d6612f.** Phones now get `low`, a 900 MB budget, a lazy cockpit and texture release. The first 9 iOS flights look
different: pages survive, players tap "skip tutorial" 14–62 s in, and `end` beacons arrive (4 of 8, against 6 of 57
before). Sessions are still short, but **no live build has touch controls**, which confounds this (an agent is adding
them right now: uncommitted `src/ui/touch-*.js`). A page that dies within 5 s of `fly` also leaves no resume snapshot,
so even the new `crash` resume cannot count these deaths.

**Fix.**
- (S) Make page deaths measurable. At `fly`, write a tiny `sessionStorage` marker `{sid, phase:'flying', t}`, clear it on
  `pagehide`, and on the next load of the tab send `t=dead&prev=<sid>&after=<s since fly>` if the marker is still there.
  This works even without a flight snapshot.
- (M) Stagger the post-ready burst on phones and tablets: trees after 10 s, audio decoded per aircraft on demand (only
  the engine loop first), city L0 at most 1 upload per 2 frames for the first 10 s. Then re-measure the peak with
  `mem-phone.mjs`.
- Keep the phone and tablet defaults (already in `5d6612f`).

## 2. X/Twitter in-app browser (iPhone) loses the WebGL context within seconds (High)

**Impact.** 79 of the 98 iOS sessions come from the X/Twitter in-app browser (`… Twitter for iPhone/12.28.1`, viewport
390×539 @3). The report script labels this browser "diğer" (other). Every context-loss symptom seen on iOS comes from
this browser: #4 on `3833a08`, #7 on `94a7a5a`, and on `5d6612f`:

```
open(q=low) → +7 s gfx lost (GPU peak 51 MB) → restored → reload (low, pr 0.75)
open        → +3 s gfx lost (GPU peak 19 MB) → guard gives up ("Grafik belleği tekrar doldu…") → fly(!) → end +11 s
```

**Root cause.** The losses happen at a GPU peak of **19–51 MB**, so they are not caused by the game's GPU budget. The page
has one WebGL context; the device probe in `src/core/gpu-device.js:23` releases its own with `loseContext()`. The
trigger is inside the X in-app WebView: its GPU/web process limits or lifecycle. Its exact mechanism **could not be
determined** from here. Secondary bug: after the guard gives up, `start()` keeps loading and sends `fly`
(`src/app/main.js:131`) although `state.halted` is set.

**Fix.**
- (S) Before loading the 3D world in an in-app browser, show "Safari'de aç" (copy link / open) as the default action.
  The uncommitted `src/ui/touch-gate.js` already has an in-app banner, so make it the gate for X and Instagram rather
  than a hint. After the first context loss in an in-app browser, offer "open in Safari" instead of a reload that will
  fail again.
- (XS) In `start()`, return early (no `trackFlight`, no further loads) once `state.halted` is set.

## 3. Tutorial beacons lose their session id, so "0 of 17 finished" is a telemetry bug (High, data)

**Evidence.** `src/ui/tutorial.js:333`, `:342` and `:355` send `trackEvent('tut', { …, s: seconds })`.
`src/core/telemetry.js:21-22` builds the beacon with `s: sid` and then `q.set(k, …)` for every data key, so the step
time **overwrites the session id**. 488 beacons are logged under fake sessions named `6.7`, `0.0`, `20` and so on. Only
`x=crash` and `restart` keep the real id, which is why `report.py` sees 19 tutorial sessions and 0 finished.
Re-attributing each orphan by visitor and time (all 488 matched; `docs/errors/repro/tut.py`) gives the real funnel:

| | report.py today | real |
|---|---|---|
| sessions that started the tutorial | 19 | **85** |
| finished (`st=done`) | 0 | **70 (82 %)** |
| skipped | – | 6 (mostly phones, no touch controls) |
| crashed during a step | – | 14 |

Step detection works: medians are fighter `mil` 9.9 s, `ab` 4.1 s, `rotate` 6.9 s, `gear` 3.0 s; airliner `thr` 6.6 s,
`rotate` 28.1 s, `flaps` 19.1 s. One oddity: `heli-ground/forward` completes in 0.0 s both times it was reached, so its
condition is already true when the step starts (2 sessions; worth a look).

A second collision: `gpu-guard.js` `fail()` → `report(reason, { n, … })` overwrites the beacon sequence number `n`
with the failure count, so `gfx lost` beacons all show `n=1`.

**Fix (XS).** Rename the field to `sec` in tutorial.js and `n` → `fails` in gpu-guard.js. Make `send()` ignore data
keys `t, s, n, m, v`. In `report.py`, read `sec`, and for old logs re-attribute numeric-`s` `tut` beacons to the
visitor's running session (the logic in `docs/errors/repro/sessions.py`).

## 4. `TypeError: null is not an object (evaluating 'array.byteLength')` (three.module.js:70), High, fixed

**Occurrences.** 20 beacons in 4 sessions:

| where | build | device | when |
|---|---|---|---|
| production | 3833a08 | iPhone, X in-app, `high`, F-16 AIR-GGB | 12 s after `fly`; page never sent `end` |
| staging (owner) | 343ecf8 ×2, e620b2d | iPad Pro 13" (reports as Safari/macOS 1376×946 @2), `high` | 0.8–2.8 min into flight; heartbeats continued |

**Root cause.** `three.module.js:70` is `WebGLAttributes.createBuffer`, at `const size = array.byteLength`. City tiles free
their CPU arrays after upload (`src/world-sf/city.js:13` `freeArray`, attached at `:164-165`). When iOS kills the GPU
context and restores it, three.js (`onContextRestore` → `initGLContext`, three.module.js:17160) re-creates every buffer
from its CPU copy, and the freed tiles throw **on every frame**: 540 exceptions in 9 s in the repro, 0 draw calls. The
canvas stays empty while the HUD, audio and physics keep running. The unload path (`city.js:202-213`, remove before
dispose) cannot cause it.

**Reproduced** (`docs/errors/repro/repro-ctx.mjs … restore`): Chromium on 3833a08 and WebKit iPhone-15 emulation on
94a7a5a give the same message and line, and exactly 5 `err` beacons (the cap).

**5d6612f: fixed.** `gpu-guard.js` handles `webglcontextlost` → halts the loop before `render` → reloads one step lower
with `?resume=1` → the flight continues. The repro gives 0 page errors and this beacon sequence:
`gfx lost → restored → reload → open → fly → gfx resume (quality high→… / low pr 0.75 on the phone)`.

## 5. Load failures and early errors never reach telemetry (Medium, observability)

- `startFailed()` (`src/app/main.js:418`) shows "Oyun yüklenemedi" or a connection error, but sends **no beacon**. 9
  production sessions started loading the world and never flew (7 on X in-app iOS, 1 Opera/Windows, 1 Chrome/macOS on
  5d6612f), and there is no record of why. None of them had an HTTP error in the logs.
- The `error` and `unhandledrejection` listeners are added in `startTelemetry()`, which runs only after
  `fetch('build.json')` settles (`main.js:409`). Anything that breaks earlier, including a module that fails to link,
  sends nothing. 18 of 104 `main.js` loads since 16:36 UTC have no `open` beacon; 12 of those still fetched world assets
  (probably Do Not Track / GPC / blockers), 6 did nothing more (undetermined).
- Render exceptions are now caught (`main.js:330`) and reported only after 30 consecutive failures (`gfx ev=render`).
  An exception that happens now and then never shows up in telemetry.
- `unhandledrejection` beacons carry no file (`telemetry.js:58`), which is why #11 could not be located.

**Fix (S).** Add a `fail` beacon in `startFailed` (`net` flag, message, phase). Register the two listeners at module
import and queue beacons until `startTelemetry`. For rejections, send the first stack frame (`reason.stack`) as `f`.
Report the first caught render exception per page as `err`. Also send the resolved preset (`quality.id`) in
`open`/`fly`, since `settings.quality` can differ after device caps.

## 6. A second tab "crash-resumes" the first tab's flight and lowers quality permanently (Medium)

**Evidence.** Production session on 5d6612f, Safari 26 / macOS, `medium`. The previous page of the same visitor was
still alive (its `end` beacon arrived one second *after* the new page's `open`). The new page sent
`gfx ev=resume why=crash` and left 7 s later.

**Root cause.** `src/core/gpu-resume.js` `readResume()` treats a snapshot that is `alive` and under 3 minutes old as a
crashed tab. The snapshot lives in `sessionStorage`, which browsers **copy** into a tab opened from the page
(`window.open`, `target=_blank`) and into Duplicate Tab. The live first tab keeps writing `alive` snapshots every 5 s.

**Reproduced** in both engines (`docs/errors/repro/dup-tab.mjs`). A tab opened on `/` from a running flight skips the
menu, flies the other tab's flight, drops one quality step, and stores `localStorage gokyuzu.gpuCap` (Chromium
`high`, WebKit `medium`), which caps every later visit on that device.

**Fix (S).** Treat the snapshot as a crash only when `performance.getEntriesByType('navigation')[0].type === 'reload'`
(iOS restarts a killed tab as a reload). Better still, give each page an id held in a Web Lock
(`navigator.locks.request('gokyuzu-page-'+id, …)`); if the snapshot's lock is still held, its tab is alive. Never
write `gpuCap` from a `crash` resume on desktop classes.

## 7. `TypeError: Argument 1 ('shader') to WebGL2RenderingContext.shaderSource must be an instance of WebGLShader` (three.module.js:6162), Medium, handled

**Occurrence.** 2 beacons, 1 session, 94a7a5a, iPhone (X in-app), F-16 KNGZ-24, `high`: 1 s and 8 s after `fly`, then
`end`.

**Root cause.** three.module.js:6160-6162 `WebGLShader()` calls `gl.shaderSource(gl.createShader(type), …)`. WebKit
returns `null` from `createShader` when its GPU process is gone. Calling `loseContext()` does *not* do that: both
engines then return a dead but valid `WebGLShader` (`probe-shader.mjs`). If the `webglcontextlost` event has not been
delivered yet, three.js still thinks the context is alive and compiles the next new material (cockpit, a tile variant,
HUD glass). Old builds had no guard, so rendering carried on.

**Reproduced** in WebKit with iPhone emulation (`repro-ctx.mjs … gpukill`: `create*` → null, loss event withheld): the
exact message at three.module.js:6162:17.

**5d6612f: handled.** The render `try/catch` counts failures; 30 in a row trigger `fail('render')` → reload `low` pr
0.75 → resume (0.5 s in the repro, 0 uncaught errors). **Remaining gap:** if the context is lost and neither the event
nor an exception arrives (`repro-ctx.mjs … nodispatch`), the game keeps drawing into a dead context forever
(`isContextLost()=true`, guard not failing). **Fix (XS):** in `gpu.tick`, every 2 s,
`if (renderer.getContext().isContextLost()) fail('lost', 'polled')`.

## 8. Cloudflare pulls whole height files from CloudFront (Low–Medium: cost, first-load latency)

**Evidence.** The terrain reads `assets/sf/terrain/h/<L>.bin` with HTTP range requests (`terrain.js:228`, `:302`).
Most CloudFront responses are `206`, but **433 are full `200`s: 49.6 GB**, about 70 each for 5–10.bin (`10.bin`
381 MB, `9.bin` 172 MB). They arrive at a median 67 MB/s (26–137), which is datacenter speed, and no visitor that got a
full 200 ever sent a range for the same file. These are Cloudflare cache fills. A live check shows players get `206`
with `cf-cache-status: HIT` and `x-cache: Miss from cloudfront`, so **players never receive the whole file** (the
`terrain.js:232/303` slice fallback is not what happens). The first player per colo waits for the fill, though: a 64 KB
range near the end of `9.bin` on a cold key took 2.7 s against 0.18 s warm. `10.bin` should cost about 6 s. 228 of the
fills are unversioned v1.0 URLs, which doubled the cache keys.

**Fix.** (S) A Cloudflare cache rule to bypass cache for `/assets/sf/terrain/h/*`, so CloudFront serves the ranges
itself; it already caches them (52 % hit). Or (M) split levels 6–10 into ≤ 16 MB chunk files in the build, so every
request is a small whole file that caches well everywhere.

## 9. Cloudflare managed challenge on the HTML page (Unknown)

`/` and `/index.html` answer `403` with `cf-mitigated: challenge` to automated clients, including a Chrome user agent
from this machine. JS and assets are served normally. Challenged requests never reach CloudFront, so the logs cannot
show how many real players see the "checking your browser" page, or how many link-preview fetchers (iMessage,
WhatsApp, X) fail. **Action (XS):** check Cloudflare → Security → Events for challenges on `fs.erenailab.com/`, and add a
skip rule for the page if players are affected.

## 10. 403 for missing files (Low)

S3 answers `403` (not 404) for unknown keys.

| path | count | visitors | builds | who |
|---|---|---|---|---|
| /favicon.ico | 2,664 | 545 | v1.0 only | browsers; **fixed** since the favicon ships (now 200) |
| /apple-touch-icon.png, -precomposed.png | 16 + 14 | 9 | all | iOS/macOS link-preview fetchers (`NetworkingExtension`, `CFNetwork`, `com.apple.WebKit.Networking`); they ignore `<link rel=apple-touch-icon href=favicon-180.png>` |
| /manifest.json | 6 | 1 | 94a7a5a | one Chrome/Windows visitor (PWA/extension probe) |
| /favicon.png | 4 | 4 | 3833a08, 94a7a5a | an Android app (`okhttp`) |
| /robots.txt | 4 | 1 | v1.0 only | fixed |
| /assets/sider-hand-banner-*.svg, /meta.json | 6 | 1 | v1.0 | the "Sider" browser extension resolving its own assets against the page |

**Fix (XS).** Ship `/apple-touch-icon.png` and `/apple-touch-icon-precomposed.png` (copies of `favicon-180.png`).
Optionally add a CloudFront custom error response 403 → 404 so missing files read as missing.

**Other HTTP findings (Info).**
- There were no 5xx responses and no `OriginCommError`.
- All 24 `000`/`ClientCommError` rows are headless test runs aborting on page close. One player aborted `b737.glb` after
  48 s at 4.9 of 5.5 MB (a slow connection).
- 4 CloudFront misses had about 10 s to first byte (S3 stalls, 4 of about 250k).
- p95 `time-taken` per class stays at or under 0.41 s, except the height fills above.
- CloudFront hit ratio behind Cloudflare: city tiles 71 %, landmarks 82 %, audio 79 %, aircraft 81 %, terrain imagery
  35 %, city obstacles 25 %; JS is 19 % hit plus 60 % RefreshHit (max-age 300).
- Versioning works: after 94a7a5a the only unversioned asset URLs are `assets/versions.json` and
  `assets/audio/manifest.json` (revalidated by design), plus tabs still open from v1.0, which decay to 3 requests by
  5d6612f. `three.module.js` is unversioned with `max-age=604800`, harmless while three stays at r186.

## 11. `Cannot read properties of undefined (reading 'M_ID')` (Low, not our code)

**Occurrence.** 5 beacons (the cap), 1 session, 3833a08, Chrome 153 / Windows, GTX 1650 Ti, `medium`. It fired in the
same second as `open`, while the page was still on the menu. The player then flew the A320 for 25 minutes without
trouble. Their other page load had no error.

**Root cause.** `M_ID` appears nowhere in the repository, three.js, the Draco/Basis libraries or `dist/`. The beacon has
no `TypeError:` prefix and no file, which is the shape of `unhandledrejection` (`telemetry.js:58` sends
`reason.message`); window `error` events carry `Uncaught TypeError: …`. Isolated-world content scripts cannot fire the
page's `unhandledrejection`, so the source is a script running in the page's main world, most likely a browser
extension. **Not reproducible, no player impact. Fix:** as in #5, send the rejection's first stack frame and tag
errors with no frame from our origin as `ext`.

## 12. `Script error.` (Low, not our code)

**Occurrence.** 2 beacons, 57 s apart, 1 session on 5d6612f, iPhone Safari (440×736), `low`, never flew. `Script error.`
is the browser's sanitized message for an error inside a *cross-origin* script, and the page loads none (all modules
are same-origin). A Safari web extension or similar injected code is the likely source; **could not be determined**.
Same fix as #11.

## 13. Crashes that look like bugs (Info)

109 crash events in 53 sessions: obstacle 29, water 23, dive 23, wing 16, hard 12, stall 3, tail 2, nose 1.

- **No crash within seconds of a spawn.** The shortest gap from spawn or reset to a crash is 20 s: a hard landing after
  a takeoff.
- **No "obstacle at the airport".** Every building strike happens at least 26 s after takeoff. One player (Edge/macOS,
  F-16 KOAK-30) hit a building 26–31 s after takeoff three times, with overspeed/pull-up warnings active, which fits
  flying fast and low over Alameda/Bay Farm.
- **Wing strikes on the runway (3 of 109).** F-22 KSFO-28R, F-16 KNGZ-24 and F-22 KNGZ-24 each touched a wingtip during
  the tutorial "rotate" step, 10–18 s after afterburner and before the `takeoff` event (which needs 0.5 s airborne,
  `fixedwing.js:1079-1081`). Most likely roll input during rotation; this needs the bank angle to confirm.
- Crashes on `AIR-*` spawns naturally have no `takeoff` event.

**Fix (XS).** Add rounded `x/z` (100 m), AGL, IAS, pitch and roll to the `crash` beacon, so obstacle and runway cases can
be located.

## 14. GPU budget monitor steps twice in 40 s on iPad (Low)

Owner's iPad Pro, staging 92cea3b: `high → medium` at 3.9 min (1,387 MB, 44 MB over), `medium → low` 40 s later
(1,317 MB, 28 MB over). Stepping down releases loaded content slowly, so the second step came before the first had
taken effect. **Fix (S):** after a step, wait until the meter stops falling (or 60 s) before judging again.
`gfx` events otherwise: production had no `gfx` telemetry before 5d6612f. On 5d6612f the only `lost` events are the two
X in-app sessions in #2; the only `resume` is the false positive in #6.

---

## What 5d6612f already fixed

- **#4 array.byteLength** (context loss → restore → re-upload of freed arrays): the guard now halts and reloads into the
  same flight. Reproduced before and after.
- **#7 shaderSource** as an uncaught error: caught, and it triggers the same recovery after 30 frames.
- Phone and tablet defaults (`low` / `medium` + budgets + lazy cockpit): iOS pages now survive past `fly` (#1, early
  data).
- The favicon and robots.txt 403s ended with the files shipped (343ecf8); asset versioning is in place since 3833a08.

## Could not determine

- Why the X/Twitter in-app WebView drops the WebGL context at 19–51 MB (#2). This needs a device with Web Inspector
  attached.
- Whether iOS page deaths (#1) are fully gone on 5d6612f: only 9 iOS flights so far, no touch controls live, and no
  death telemetry yet.
- The exact sources of `M_ID` (#11) and `Script error.` (#12), both almost certainly foreign scripts.
- Why 9 loads stalled with no HTTP error (#5), and what happened to the 6 page loads with no beacon at all.
- Whether real players are challenged by Cloudflare (#9).

## Reproducing

Scripts are in `docs/errors/repro/`. The dev server must run on :5173. Old builds are served from `git show <rev>:…`
via Playwright routing; assets come from the working tree.

- `node repro-ctx.mjs <chromium|webkit> <rev|current> <restore|nodispatch|gpukill|delayed> [ac] [spawn] [iphone]`: #4 and #7.
- `node mem-phone.mjs <rev|current> [quality]`: #1 memory at flight start (iPhone 15 emulation, exact WebGL bytes).
- `node dup-tab.mjs`: #6. `node probe-shader.mjs`: what `createShader` returns after `loseContext()`.
- `../../../.venv/bin/python errors.py | tut.py | death.py | crashes.py | stalls.py | httpfail.py | perf.py`: log
  analyses. They use the logs `report.py` downloads to `data/analytics/`, cache parsed rows in
  `data/analytics/audit-rows.pkl` (gitignored), and delete that file to re-parse.

The optimization agent may have been benchmarking on the same GPU during these runs. No conclusion here rests on
timings except the Cloudflare cold/warm range test, which is network-bound.
