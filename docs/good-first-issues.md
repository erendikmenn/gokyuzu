# Starter tasks

Concrete tasks for new contributors, drawn from the performance study
([docs/perf/findings-2026-09.md](perf/findings-2026-09.md), [docs/perf/plan.md](perf/plan.md)) and the code. Each one
names the files involved and says how to check the result. They are written so that each can become one GitHub issue.

Before you start: read [CONTRIBUTING.md](../CONTRIBUTING.md) (setup, DCO sign-off, tests, performance and privacy
rules), and comment on the issue so two people do not do the same work.

Labels: **good first issue** needs little knowledge of the code; **help wanted** needs a device or a setup the
maintainer does not have; **good second issue** is bigger, or needs a visual review by the maintainer.

---

## 1. Profile the game on a Windows laptop with integrated graphics

**Labels:** performance, help wanted, good first issue

About 29 % of play sessions come from Windows, and many of those laptops have integrated GPUs (Intel Iris Xe / UHD,
AMD Radeon Vega). The game picks **Düşük** (low) for them, but that choice rests on an estimate: plan.md §4.8 says
"≥ 40 fps on low is plausible but unverified … measure on one real Windows iGPU before changing defaults". All
measurements so far were made on Macs.

- Play both maps in Chrome or Edge at **Düşük** and **Orta**: San Francisco downtown (`?aircraft=f16&spawn=AIR-CITY`),
  the SFO ground (`?aircraft=a320neo&spawn=KSFO-28R`), İstanbul's historic peninsula (`?map=ist&aircraft=uh60`).
- Note the frame rate (the browser's performance panel, or an FPS meter), stutters, load time and the GPU model
  (`chrome://gpu`).
- If you can, run `node tools/perf/matrix.mjs --profiles laptop-igpu,desktop-high --maps sf,ist` (see task 2 first).

**Done when:** a *Performance report* issue holds the numbers for both presets and maps, and says whether Orta would be
a better default on that GPU.

## 2. Make the perf and QA tools run on Windows and Linux

**Labels:** tools, good first issue

`tools/perf/lib.mjs` and `tools/qa/lib.mjs` launch Chromium with `--use-angle=metal`, which only exists on macOS, and
`tools/perf/lib.mjs` reads the GPU load with macOS's `ioreg` (`gpuBusy()`, returns null elsewhere).

- Choose the ANGLE backend by platform (`process.platform`): `metal` on macOS, `d3d11` on Windows, the default (or
  `vulkan`) on Linux, with an environment override.
- Make sure every caller of the GPU-busy value copes with `null`.
- Update the "Tools" section of `docs/perf/plan.md` (§9).

**Done when:** `node tools/perf/scenes.mjs --presets low --poses downtown-300` and `node tools/qa/menu.mjs` run on
Linux or Windows with the real GPU (check `chrome://gpu` in the launched browser).

## 3. Firefox: add it to the QA scripts and do a test pass

**Labels:** browser support, good first issue

The Playwright scripts only drive Chromium and WebKit (`tools/qa/lib.mjs`, `tools/perf/lib.mjs` import
`{ chromium, webkit }`), so Firefox has never been tested systematically.

- Add `engine === 'firefox'` to `launch()` in `tools/qa/lib.mjs` (Playwright's `firefox`; `npx playwright install
  firefox`).
- Run the menu, take-off and approach scripts on both maps, and play by hand on Firefox desktop and Firefox for
  Android: textures (KTX2 transcoding), sound, dragging to look around in the cockpit, the big map, touch controls.
- Open an issue for each problem found, with the console errors.

**Done when:** the QA scripts accept a Firefox engine option, and the test pass is written up (issues or "works").

## 4. WebKit: cheaper cockpit display uploads on iPhone and iPad

**Labels:** performance, good second issue

Cockpit displays are Canvas2D textures (`src/avionics/index.js`, `createCore()`). On phones and tablets they are already
capped at 512 px and 15 Hz, but the comment at the top of the file measures WebKit's upload at "~0.5 ms fixed +
~0.5 ms per 512² with mipmaps", and the textures still generate mipmaps (findings T2).

- On the phone and tablet classes (`isMobileClass()`), try `texture.generateMipmaps = false` with
  `minFilter = THREE.LinearFilter`, and check how the displays look at a distance in the cockpit view.
- Measure the cockpit pose in WebKit before and after: `node tools/perf/matrix.mjs --profiles tablet-webkit --maps sf`
  (CPU ms per frame, frames over 50 ms).
- Run the quality gate for the cockpit pose: `node tools/perf/refshots.mjs gate --classes tablet,phone --poses cockpit`.

**Done when:** the pull request shows the WebKit numbers before and after, and the gate passes or its heat maps are
attached for review.

## 5. Menu accessibility: keyboard, focus and contrast

**Labels:** accessibility, good first issue

The menu (`src/ui/menu.js`) and the panels (`src/ui/panels.js`: Ayarlar, Künye) already use buttons, `role="radiogroup"`
and `aria-checked`, but have not been audited.

- Run [axe-core](https://github.com/dequelabs/axe-core) on the menu, Ayarlar, Künye and the missions tab through a
  Playwright script (a dev tool installed outside the game; not a runtime dependency).
- Fix what it finds, and at least: arrow-key navigation inside each radio group (map choice, start points, the
  segmented controls) with a roving `tabindex`; focus kept inside an open modal (`modal()` in `panels.js`); a
  `prefers-reduced-motion` rule for the panel animations (`menu.js` and `loading.js` have one); the contrast of the dim
  credit line (`.gkm-credit`, 38 % opacity).
- Do a keyboard-only walkthrough: choose a map, an aircraft and a start, change a setting, open the Künye, start a
  flight.

**Done when:** axe reports no serious or critical issues on those screens and the walkthrough works without a mouse.

## 6. English user interface: a string table, starting with the menu and panels

**Labels:** translation, good first issue

Every player-facing text is Turkish and written inline. An English version needs a string table first.

- Add a small `src/ui/i18n.js`: `t(key)`, Turkish as the default, the English table loaded lazily with `import()` only
  when needed; the language from `?lang=en`, then a setting, then `navigator.language`. No new dependency.
- Convert `src/ui/panels.js` (Ayarlar, Künye) and the static labels of `src/ui/menu.js` first. Keep the
  `lang` attribute of each root element (`root.setAttribute('lang', 'tr')`) in step with the language shown.
- Add a Node test that every key exists in both tables.

**Done when:** `?lang=en` shows an English menu, Ayarlar and Künye; the Turkish UI is unchanged; the test passes.
Later issues can convert the HUD, tutorials, hints and missions.

## 7. A new San Francisco mission

**Labels:** missions, good first issue

Missions are data plus small objective functions (CONTRACTS-SF.md §12). Ideas that only need the existing objective
types (reach a point, gates, hover over a pad, go around, land on a runway with ≥ N stars) and do not repeat the ten
existing ones: a 737 landing on Oakland 30 from a downwind start; a UH-60 low-level tour along the Embarcadero ending
on a pad; an A320 go-around at SFO followed by a second approach and landing.

- Add the entry to `src/missions/catalog.js` (Turkish briefing and result texts, with correct diacritics).
- Extend `tests/missions.test.mjs` so the real flight model flies it (the autopilot or a scripted pilot).
- Regenerate the leaderboard's plausibility rules with `node infra/leaderboard/build_rules.mjs` (it writes
  `infra/leaderboard/lambda/rules.json` from the catalog; see its header).

**Done when:** `?mission=<id>` is playable on a desktop and a phone, and the test flies it to success.

## 8. A new İstanbul mission

**Labels:** missions, good first issue

The same for İstanbul (`src/missions/ist/catalog.js`, CONTRACTS-IST.md §6.M; ids start with `ist-`). Ideas that the
19 existing missions do not cover: a UH-60 tour of the Princes' Islands (Adalar) with a landing on a pad; an F-16
landing on Atatürk's runway 05 from over the Sea of Marmara; an A320 circuit at İstanbul Havalimanı (take-off,
downwind, landing). Mind the runway rules the catalog encodes: LTFM 09/27 are departure-only, and the backup runways
are never landing targets.

**Done when:** `?mission=ist-<name>` is playable and `tests/missions-ist.test.mjs` flies it to success.

## 9. Gamepads: respect the mapping and support flight sticks

**Labels:** input, good first issue

`src/flight/input.js` takes the first connected pad and reads it with the indices of the W3C "standard" mapping,
whatever `pad.mapping` says. On a flight stick or a pad that the browser reports as non-standard (common in Firefox on
Linux), the axes and buttons land in the wrong places.

- Prefer a pad with `mapping === 'standard'`; for others, add a small table of known devices keyed by `pad.id`
  (for example a Thrustmaster T.16000M or a Logitech Extreme 3D Pro: twist axis → rudder, throttle axis → lever), and a
  safe fallback (pitch and roll only).
- Show the gamepad buttons in the F1 help when a pad is connected (the help card is in `src/ui/hud.js`; the tutorial's
  gamepad phrases are in `src/ui/tutorial-keys.js`).
- Add `tests/input.test.mjs` with fake `navigator.getGamepads()` objects.

**Done when:** a standard pad behaves as before, a listed stick flies with twist rudder and its throttle axis, and the
test passes.

## 10. Key labels for AZERTY, QWERTZ and Turkish F keyboards

**Labels:** input, accessibility, good first issue

Keys are read by position (`KeyboardEvent.code`), so the controls work on any layout, but the help, the tutorial and
the hints print the QWERTY letters (W, A, S, D, Q, E, Z, X …). On a Turkish F or a French AZERTY keyboard those letters
are elsewhere.

- Where the browser offers it (`navigator.keyboard.getLayoutMap()`, Chromium), show the letter of the player's layout;
  fall back to the QWERTY letter elsewhere.
- Places that print keys: `src/ui/tutorial-keys.js`, the help card in `src/ui/hud.js`, `src/ui/hints.js`;
  platform-specific keys live in `src/core/platform.js`.

**Done when:** with a Turkish F or AZERTY layout in Chrome, the help and the tutorial show the keys the player has to
press.

## 11. Check the quick start on Windows and Linux

**Labels:** docs, good first issue

The README's quick start (`npm install`, the asset pack or `--assets-from`, `node tools/serve.mjs`) was written on a
Mac.

- Follow it on Windows (PowerShell) and on a Linux distribution, from a fresh clone.
- Look out for path handling in `tools/serve.mjs` (Windows back-slashes), line endings, and commands that assume a Unix
  shell (the test loop in CONTRIBUTING.md).
- Fix what breaks, or document the alternative (for example a PowerShell version of the test loop).

**Done when:** a new contributor on each system gets from `git clone` to a flight with the steps in the README.

## 12. Open fonts in the Blender texture scripts

**Labels:** asset pipeline, good second issue

About fifteen scripts under `blender/` and `tools/` draw texture lettering (cockpit placards, stencils, airport
signs) with macOS system fonts (Futura, Avenir Next, Helvetica Neue, DIN, SF Mono, Menlo, Arial), so the assets cannot
be rebuilt on Linux or Windows.

- Find them: `grep -rlE "Futura|Avenir|Helvetica Neue|/System/Library/Fonts|/Library/Fonts" blender tools`.
- Route them through one font helper that uses fonts under the SIL Open Font License (B612 is already in
  `src/avionics/fonts/`; others such as Barlow or DejaVu could be vendored with their licence), keeping the look close.
- Record new fonts in NOTICE.

**Done when:** those textures build on Linux, and before / after renders of a few textures look alike.

## 13. Shorter draw distance on phones

**Labels:** performance, good second issue

The camera's far plane is 80 km on every device (`src/app/main.js`, the `PerspectiveCamera`). On phones the terrain is
drawn to 63–68 km, İstanbul's landmarks to 30 km, airports to 15–18 km, although the screen is small (findings P7).

- Give the device classes their own far distance and layer ranges in `src/core/quality.js` (about 25–30 km on phones),
  and let the haze hide the edge.
- Measure the phone profile before and after: `node tools/perf/matrix.mjs --profiles phone-cpu4,phone-cpu6
  --maps sf,ist` (draw calls, CPU ms per frame, GPU memory).
- Run `node tools/perf/refshots.mjs gate --classes phone` and attach the heat maps: this change is meant to alter
  distant pixels, so the maintainer reviews it visually.

**Done when:** the phone numbers improve and the maintainer accepts the look.

## 14. Merge the static parts of each aircraft

**Labels:** performance, good second issue

The F-16 is drawn as 85 meshes, each in 3 passes (colour and two shadow cascades), which keeps integrated GPUs
CPU-bound in `renderer.render` (findings L1).

- At load time, merge the meshes that never move and share a material (`mergeGeometries` from
  `three/addons/utils/BufferGeometryUtils.js`). Keep every animated or referenced node
  separate: gear, control surfaces, canopy and the node names that physics, rig and avionics rely on
  (CONTRACTS-SF.md §5.1).
- Measure the draw calls and CPU time with `node tools/perf/scenes.mjs --presets low,high --poses cockpit,downtown-300`.
- This is an exact change: the quality gate must pass at the noise floor.

**Done when:** each aircraft uses clearly fewer draw calls, the gate passes and all tests pass.
