# Device matrix baseline and findings (2026-09-24)

Measured by the perf lead on dev `1d480f7` (frozen worktree served on :5195), M4 Max, Playwright Chromium (ANGLE/Metal) and WebKit.
Tools: `tools/perf/{matrix,overkill,allocs,webkit-memory,soak,refshots}.mjs`. Raw data: kept outside the repository (the tools write to `$PERF_OUT`).

**Contention caveat.** Other agents kept the GPU 56–99 % busy during these runs, so fps, frame times and the CPU time
of `renderer.render` are upper bounds (WebGL calls block on a saturated GPU). The ranking rests on numbers contention
can't move: bytes, draw calls, triangles, programs, GPU memory (game meter + GL texture census), allocation rate, DOM /
2D-canvas work per frame, CPU shares under throttling.

## 1. Profiles (the game's own overrides)
| profile | setup | preset | pixel ratio | shadows | GPU budget |
|---|---|---|---|---|---|
| desktop-high / -ultra | 1920×1080 @1 | high / ultra | 1 | 2 cascades × 4096² | 3000 / 3800 MB |
| laptop-igpu | 1366×768, `?device=integrated`, CPU 2× | medium + integrated caps | 1 | "1 cascade" 2048² | 1700 MB |
| tablet-chromium / -webkit | 1024×768 @2, `?device=tablet&touch=1` | medium + tablet caps | 1.25 | "1 cascade" 2048² | 1400 MB |
| phone-cpu4 / -cpu6 | 844×390 @3 landscape, `?device=phone&touch=1`, CPU 4× / 6× | low + phone caps | 1 | off | 900 MB |

## 2. Baseline (F-16 and A320 loads; flying and pose columns F-16)
| profile | map | load s | MB before first frame | worst frame 30 s (ms) | frames >50 ms | programs after start | fly fps | main busy % | MB/min flying | GPU meter MB | CPU ms/frame | HUD ms | draw calls |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| desktop-high | sf | 1.8–3.4 | 32 | 49–132 | 0–6 | 3–12 | 38* | 34 | 22.4 | 1831–1981 | 7.7–10.1 | 0.5 | 503–715 |
| desktop-ultra | sf | 7.3–17.4 | 29–37 | 95–340 | 5–6 | 3–14 | 38* | 49 | 32.2 | 1873–2082 | 7.9–10.6 | 0.5 | 548–813 |
| laptop-igpu | sf | 6.6–10.1 | 34–42 | 290 | 10–11 | 5–6 | 60 | 53 | 21.0 | 1059–1224 | 7.5–12.6 | 0.6–0.8 | 424–529 |
| tablet-chromium | sf | 5.6–8.5 | 21–34 | 252–292 | 2–3 | 3–8 | 59 | 32 | 8.8 | 924–978 | 4.6–6.4 | 0.4–0.5 | 356–466 |
| tablet-webkit | sf | 5.7–14.7 | 45–47† | 303–4220 | 18–23 | 5–6 | 54 | 33 | 18.1 | 923–984 | 3.7–9.2 | 0.5–0.8 | 356–466 |
| phone-cpu4 | sf | 4.4–5.2 | 28–30 | 176–333 | 12–16 | 5–7 | 59 | 64 | 11.9 | 651–690 | 8.4–9.8 | 0.9–1.0 | 170–252 |
| phone-cpu6 | sf | 7.2–7.3 | 24–25 | 230–236 | 38–39 | 7–9 | 48 | **97** | 11.9 | 650–690 | 19–29 | 1.9–2.6 | 170–252 |
| desktop-high | ist | 1.7–10.2 | 24–30 | 131–648 | 2–10 | 15–17 | 45* | 33 | 11.3 | 1344–1547 | 6.5–9.2 | 0.5–0.6 | 411–557 |
| desktop-ultra | ist | 3.5–10.2 | 21–23 | 329–385 | 6–11 | 13–17 | 44* | 38 | 14.9 | 1449–1660 | 6.2–8.8 | 0.4–0.6 | 430–598 |
| laptop-igpu | ist | 2.2–3.5 | 22–27 | 149–168 | 9–10 | 9–13 | 60 | 44 | 9.4 | 782–912 | 7.1–12.1 | 0.7–0.9 | 330–437 |
| tablet-chromium | ist | 4.2–8.0 | 24–29 | 165–243 | 3–5 | 3–4 | 60 | 28 | 5.7 | 792–881 | 3.4–5.7 | 0.4–0.5 | 290–413 |
| tablet-webkit | ist | 10.3–10.6 | 43–47† | 552–1700 | 7–8 | 3 | 56 | 29 | 8.0 | 792–881 | 2.5–4.4 | 0.4–0.8 | 290–413 |
| phone-cpu4 | ist | 3.4–3.6 | 24 | 135 | 13–15 | 5–6 | 59 | 64 | 6.2 | 506–556 | 8.3–9.6 | 1.1–1.3 | 82–228 |
| phone-cpu6 | ist | 6.9–10.7 | 24–25 | 295–720 | 30–82 | 4–5 | 36 | **97** | 6.2 | 506–556 | 23–29 | 2.7–3.2 | 82–228 |

\* desktop fps limited by other processes' GPU use. † includes ~9 MB of GLTFLoader `blob:` URLs WebKit reports as requests.
CPU share while flying: `renderer.render` + loop 55–69 %, browser style/layout/paint/submit 7–10 %, HUD 2–8 %,
airports 4–7 %, city + trees 2.5–7.6 %, landmarks / terrain / flight model / audio 1–3 % each, GC ≤ 3 %.

## 3. Ranked findings (owner → expected gain)

### Phones
- **P1 No frame cap** (RENDER): main thread 64 % busy at 4×, 97 % at 6× (36–48 fps). → 30 fps flight cap with frame skipping: −50 % CPU/GPU per second.
- **P2 Full-rate rendering behind opaque screens** (RENDER): paused 47–60 fps with 222–235 draws; big map 210–224 draws; the portrait "rotate" prompt draws the world underneath. → 0 fps under opaque overlays, ~5 fps paused/map: −90 % in those states.
- **P3 GPU memory ignores the device class** (STREAMING): phone textures 481–538 MB, 98 % uncompressed. City facade atlas **187 MB** (3 × DataArrayTexture 512² × 59 layers RGBA8 + mips, every class); `water_depth.png` **85 MB** (4096² RGBA); airport ground textures **76–81 MB** (2048² RGBA; the 512 cap only covers GLBs); trees **41 MB**. → atlas cells 256² (tablet) / 128² (phone), water depth 1024² phone / 2048² tablet, airport ground 1024² or KTX2, tree textures 512² phone: ~500 → ~200–250 MB.
- **P4 Start-up hitches** (STREAMING uploads, RENDER pre-warm): 4×: 12–16 frames >50 ms (worst 135–333); 6×: 30–82 (worst 230–720). Worst frames: atlas upload (111 MB `texImage3D`, 160 ms), water depth upload (86 MB, 84–160 ms), the 3 tree programs linking ~10 s in. → smaller atlas uploaded per layer before `readyAt`, pre-warm tree + `fac_glass` materials: < 5 frames >50 ms, worst < 100 ms.
- **P5 HUD redraws every frame** (CPU): 5 canvases, 163–171 2D calls per frame, also paused; 0.9–1.3 ms/frame at 4×, 1.6–3.2 at 6×. → redraw on change, cap 15–20 Hz: −2/3 of HUD cost.
- **P6 Per-frame garbage at airports** (STREAMING): 18–22 MB/s at airport ground vs 7.7–10 airborne (desktop 25–44 vs 11–14); world update 3.5–5.9 ms at 6× vs 1.3–1.6. Sources: `airports_drape.js` `Draper.step` re-drapes forever and allocates `[x, z]` per sample (10–18 MB/s); `airports_props.js` `BatchedMesh` keeps `sortObjects` on (11–15 MB/s). → stop draping when a pass changes nothing (re-drape on terrain LOD change, no per-sample arrays), `sortObjects = false`: −10 MB/s phone, −25–30 MB/s desktop, −2–4 ms world update at 6×.
- **P7 Draw distance doesn't shrink on phones** (RENDER far plane / haze, STREAMING layer ranges): far plane 80 km everywhere; on phones terrain drawn to 63–68 km, İstanbul landmarks 30 km, SF landmarks 17.7 km, airports 15–18 km, buildings 11–12 km. → ~25–30 km on phones with haze and the horizon ring hiding the edge.
- **P8 Two always-zero lights in every lit shader** (RENDER): a SpotLight at 0 (landing light; night mode removed) and a PointLight at 0 outside the cockpit (cockpit fill). → remove the spot; cockpit fill only in cockpit view or baked: ~−5–15 % fragment cost on phones (estimate).
- **P9 Tree tiles downloaded in full although phones draw 30 % of the trees** (STREAMING): İstanbul trees 3.0 MB of 6.2 MB per minute on a phone. → density-ordered records + range fetch, or low-density tiles: ~−2 MB/min.
- **P10 Audio always running** (CPU): 21 looping sources, 99 gains, 13 biquads, 4 delays, 2 compressors; `audio.update` 0.2–0.34 ms at 4×, 0.4–0.8 at 6× plus the audio thread. → stop/disconnect sources at gain 0.
- **P11 Double-sided transparent glass re-checks its program twice per frame** (CPU/aircraft): `hud_glass`, `canopy_glass_rt`, `gauge_glass`. → `forceSinglePass = true`.

### Tablets (iPad)
- **T1 A freeze ~10 s into every flight** (RENDER pre-warm, STREAMING): the 3 tree programs link while the 86 MB water depth uploads. Chromium 165–292 ms, WebKit 303–4220 ms loaded (145 ms quiet); WebKit has no `KHR_parallel_shader_compile`. → pre-warm tree materials behind the loading screen; 2048² water depth.
- **T2 Cockpit display uploads cost 20–60× more in WebKit** (CPU/avionics): 2.8–3.8 ms/frame vs 0.05–0.23 in Chromium; 5 canvases (925×1024, 3 × 512², 512×190) at 30 Hz with mipmaps; WebKit cockpit 52.5 fps, p95 37 ms. → 10–15 Hz, dirty-rect `texSubImage2D`, no mipmaps, one atlas canvas, smaller main display on mobile: −2–3 ms/frame.
- **T3 Shadows** (RENDER): "1 cascade" still renders 2; the shadow render target carries an unused RGBA8 colour attachment the size of the depth texture (32 MB tablet/laptop, **128 MB** desktop high/ultra at 8192×4096). → no colour texture, a real single cascade on medium, far cascade every second frame.
- **T4 GPU memory close to the iPad budget** (STREAMING, RENDER): textures 602–769 MB, meter 0.79–0.98 GB of 1400; tree textures **97 MB**, untouched by the tablet caps. → P3 + T3 + tree textures 1024² on tablets: ~−350 MB.
- **T5 Real WebKit footprint is 2.5–4× the meter** (RENDER budgets): WebContent + GPU process 1.9–2.9 GB on tablet (meter 0.5–0.97), 1.5–2.2 GB on phone (meter 0.4–0.65), one start-up transient 5.2 GB; a trivial WebGL page costs 269 MB. → calibrate WebKit budgets (footprint ≈ 2.5 × meter), shrink the start-up burst. Context-loss recovery passes (resume in 2.7–7.3 s).

### Integrated laptops
- **L1 CPU-bound in `renderer.render`**: 330–610 draws including 2 shadow cascades; the F-16 is 85 meshes × 3 passes. → single cascade, merge the aircraft's static meshes, city L0 only in the near cascade, hidden terrain tiles out of the scene graph (plan.md #10): −1.5–3 ms/frame (estimate).
- **L2** start-up worst 149–291 ms, 9–11 frames >50 ms (as P4/T1). **L3** meter 0.78–1.22 GB of 1700 (as T3/T4, ~−300 MB).

### Desktop
- **D1** shadow targets 256 MB, half unused colour (T3). **D2** textures 1.0–1.2 GB, 96 % uncompressed. **D3** 12–17 programs link after start, worst frame 130–650 ms (A320 İstanbul 648 ms) → pre-warm.

### Both maps
İstanbul is cheaper than San Francisco at every class (draw calls 60–85 %, meter −10–25 %, 20–30 MB before first frame,
6–15 MB/min streaming vs 12–32). 10-min İstanbul soak: desktop flat; phone memory flat (meter 540–562 MB of 900), but
the **geometry count creeps +37/min** (203 → 834) at flat bytes → STREAMING: check that unloaded city/tree tiles dispose geometries.

## 4. Quality gate
33 reference shots (kept locally, not in git; see tools/perf/refshots.mjs) (desktop high, tablet, phone × SF aircraft-close / cockpit / sfo-ground /
free-sfo / free-ggb / free-downtown and İstanbul ltfm-ground / free-ltfm / free-15temmuz / free-sultanahmet / bogaz),
captured before any change with time frozen, HUD hidden, streaming settled. `noise.json` = noise floor.
`PERF_BASE=http://localhost:5173/ node tools/perf/refshots.mjs gate` (references in `$PERF_REF` or `.cache/perf-ref`) (exit 1 on FAIL, heat maps); `--classes phone --maps ist` for a subset.
Pass: SSIM ≥ min(0.995, noise − 0.002) and worst tile ≥ noise tile − 0.02. Exact changes (frame pacing, pre-warm, drape
stop, sort flag, shadow colour buffer) must pass; approximate ones (texture sizes, atlas, draw distance, lights) need a maintainer's review of the heat maps.

## 5. Long flights on WebKit (2026-09-27)
10-25 min soaks, phone / tablet class, `tools/perf/soak.mjs --profile phone-webkit --map sf|ist --route tour|line|orbit`
(per sample: WebContent / GPU process footprint by category, JavaScriptCore full / eden collections, scene census, CPU
arrays the game holds, decoder worker heaps; a forced full GC at the end). No resource leak: geometry / texture counts,
the GPU meter and the arrays the game references level off within ~10 min (terrain tile cache, landmark LODs, the three
airports' background loads). The sporadic growth was garbage: JavaScriptCore sometimes stops running full collections
2-7 min into a flight (only young-generation ones keep running), and every ArrayBuffer that outlived a young collection
(tile downloads, GLB binary chunks, decoded tiles) stayed in the footprint; San Francisco phone, 8 of 14 runs: +300-730 MB
in 10 min, freed by one forced full GC; İstanbul kept its full collections in every run. Since 64d736e the streaming
layers release those buffers themselves (core/assets.js `releaseArrayBuffer`): phone, 25 min without full collections,
464 → 1115 MB before, 474 → 614 MB after; tablet (medium preset, more streaming), 10 min without full collections,
599 → 3146 MB before, 600 → 846 MB after. In WebContent "WebAssembly Memory" is the Gigacage (ArrayBuffer contents) and
"WebKit Malloc" includes the decoder workers' wasm heaps (~130 MB on a phone for the page's lifetime: 4 KTX2, 2 Draco,
1 meshopt worker).

## 6. Load time, caching and shader warm-up (2026-09-27)
Publish builds (`build_dist.mjs`) served by `tools/perf/serve-prod.mjs`: HTTP/2, Brotli for text and `.glb` / `.bin` (as
production's Cloudflare zone does), deploy.sh's Cache-Control, 120 ms of origin wait on `no-cache` pages and on
revalidations (a CDN edge asking S3; staging from Türkiye: 40–220 ms). The network is shaped in the server, so Chromium,
Firefox and WebKit share one model (`load.mjs --shaper server`): Fast 4G 9 Mbit/s / 60 ms, Slow 4G 1.6 Mbit/s / 150 ms,
3G 780 kbit/s / 300 ms. Flow: menu → "Uç" (the menu's default F-16 at Alameda) → first playable frame (`readyAt`); "loading
screen" = loading screen up → first playable frame (the click → playable time also holds the menu's exit, which varied
0.4–1.1 s between identical runs). Cold = empty profile; warm = the same profile again once the first visit's
downloads had finished; expired = a returning player whose cached copies are past their max-age (the day-later case).
Before = `78775fe` (release-20260927-1125), after = dev with this round's commits. M4 Max, other agents' browsers running.

| profile · network · run | menu s | click → playable s | loading screen s | MB before the first frame | revalidations (304) before it |
|---|---|---|---|---|---|
| desktop high, Chromium · fast 4G · cold | 1.40 → 1.30 | 14.07 → **12.56** | – → 12.08 | 15.3 → 13.7 | 0 |
| desktop · fast 4G · warm | 1.02 → **0.32** | 2.12 → 2.04 | – → 1.09 | 0 | 4 → 2 |
| desktop · fast 4G · expired | 1.04 → **0.53** | 5.06 → **2.13** | – → 1.20 | 0 | 264 → 229 (in the background) |
| desktop · slow 4G · cold (2 runs) | 6.2 → 6.2 | 58.0 / 60.7 → **44.7 / 54.4** | – → 44.6 / 54.2 | 12.0 / 12.5 → 9.5 / 11.3 | 0 |
| desktop · slow 4G · warm | 1.14 → 0.41 | 5.30 → 6.95 ¹ | – → 6.00 | 0.55 → 0.96 ¹ | 4 → 2 |
| desktop · slow 4G · expired | 1.66 → **1.12** | 9.75 → **4.43** | – → 4.03 | 0.96 → 0.55 | 250 → 217 (background) |
| desktop · 3G · cold / warm | 13.0 → 12.7 / 1.77 → 1.26 | 113.9 → **104.4** / 14.8 → 16.3 ¹ | – → 104.2 / 15.3 | 11.5 → 10.6 / 1.1 → 1.3 ¹ | 16 → 12 (warm) |
| laptop iGPU profile (CPU 2×, integrated caps) · none · cold / warm | 0.40 → 0.36 / 0.60 → 0.36 | 2.66 → 2.36 / 2.54 → 2.33 | 1.59 → **1.32** / 1.59 → **1.38** | 20.9 → 17.5 | |
| laptop iGPU profile · fast 4G · cold / warm | 1.42 → 1.40 / 1.10 → 0.43 | 10.35 → **8.93** / 2.43 → 2.34 | 9.84 → 8.44 / 1.49 → 1.39 | 11.3 → 9.9 | |
| laptop iGPU profile · slow 4G · cold | 6.23 → 6.32 | 57.3 → **47.3** | 57.1 → 47.1 | 11.9 → 10.0 | |
| Firefox desktop high · none · cold / warm | 0.37 → 0.38 / 0.95 → 0.28 | 2.96 → 2.90 / 2.53 → 3.13 ² | 1.84 → 1.67 / 1.80 → 1.78 | 25.4 → 26.2 | |
| Firefox · fast 4G · cold / warm | 1.45 → 1.33 / 1.16 → 0.40 | 15.01 → **13.64** / 3.08 → 3.21 ² | 13.89 → 12.57 / 1.87 → 1.74 | 15.7 → 14.2 | |
| phone, WebKit ³ · fast 4G · cold / warm | 1.41 → 1.32 / 1.05 → 0.35 | 7.82 → 6.33 / 1.92 → 1.54 | – → 5.92 / 0.56 | 8.7 → 7.2 | |
| phone, WebKit ³ · fast 4G · expired | 1.04 → **0.55** | 4.42 → **1.68** | 3.48 → 0.72 | 0 | 145 → 100 (background) |
| phone, WebKit ³ · slow 4G · cold | 6.19 → 6.19 | 41.2 → 30.4 | 41.1 → 30.4 | 8.7 → 6.7 | |

¹ A warm run downloads the terrain tiles its cold run did not (the start set depends on timing): +0.4 MB here.
² Click → playable also holds the menu's exit (0.4–1.1 s between identical runs); the loading screen column does not.
³ The "after" build includes 20379c8 (WebKit's meshopt decoder workers never started before it, so WebKit loaded no city
tiles); the expired row is a caching effect either way.
Programs linked after the first frame: 18 → 6–7 (desktop, Firefox), 12 → 2 (3G warm). Staging over the real network from
this Mac, Chromium, before → after this round's staging deploy: cold 1.10 → 0.78 s to the menu and 2.37 → 2.31 s to the
first frame (19–20 MB: CloudFront does not compress `.glb` / `.bin`), warm 0.44 → 0.34 / 2.28 → 2.09 s; DevTools fast 4G
cold 14.0 → 14.4 s (single runs), warm 0.45 → 0.34 / 2.18 → 2.07 s.

Checks of the after build: quality gate (`refshots.mjs`, references and noise floor captured from the before build into
a local `$PERF_REF`) 30 / 33 at the noise floor once the STAGING ribbon of the reference build is masked; the three others
differ in wall-clock content (the F-16 DED clock and radar picture in the cockpit) and streaming order (phone downtown
trees, 0.09 % of pixels), not in rendering. Device matrix, phone (Chromium CPU 4×, WebKit) and tablet, both maps, before →
after: the same bytes, draw calls, programs after the start and GPU meter; first playable frame 2.2 → 1.9–2.0 s (phone),
1.0–1.1 → 0.9 s (tablet), 1.1 → 0.8–0.9 s (WebKit phone); WebKit phone flight CPU 123 → 117 ms/s (sequential runs).
`check_dist.mjs --ist` clean; `live_check.mjs` against staging clean.

### 6.1 Two origin round trips before the menu (fixed: e2ac5af)
The game fetched `build.json`, then `versions.json`, before its first menu request; both are revalidated at the origin
on every start (`no-cache` / 5 min), i.e. two sequential CDN → S3 round trips after the page's own. The publish build now
writes the stamp and the version map into the page (`<script type="application/json" id="gk-build">`, 5.6 KB before
compression) and `src/core/assets.js` reads them from there: warm menu 1.02 → 0.32 s on fast 4G, 1.14 → 0.42 s on slow 4G,
1.05 → 0.35 s on a phone.

### 6.2 Returning players after a day (deploy.sh; staging verified, production pending)
Game files are `?v=`-versioned but kept 1 day (deploy.sh explains why not a year + immutable). After that day every file of
the start was revalidated before its first use: 264 conditional requests on the desktop start, 145 on a phone, each an
origin round trip (fast 4G: 5.06 s from the click instead of 2.1). `stale-while-revalidate=2592000` on the versioned
files (JSON: 5 min + the same window) keeps the day of freshness and every reason for it, but lets the browser start from
its copy while it revalidates in the background (Chrome 75, Firefox 68, Safari 14): expired starts 5.06 → 2.13 s (fast 4G),
9.75 → 4.43 s (slow 4G), phone 4.42 → 1.68 s; menus 1.04 → 0.53 s. A copy that did change is replaced for the next start,
so each case the one-day rule covers lasts at most one page load longer. deploy.sh rewrites the header of the objects the
sync skips once per policy change (per file type, keeping each type's Content-Type; the policy text is kept in
`assets/.cache-policy`), about 50,000 objects on the first deploy (staging: 12.4 min for the whole deploy; headers and
content types checked per file type afterwards, live_check.mjs clean). A rollback to before that deploy copies them all
back (rollback.py restores every key whose version changed).

### 6.3 The LOD start picked the full model on a revalidating start (fixed: 0888b3d)
`measuredMbps()` counted 304 responses as downloads (a 304 reports the cached body in `encodedBodySize` but moves only
its headers, in a few ms): a returning player whose copies had expired, and whose first visit had ended before the full
model arrived, measured hundreds of Mbit/s and started with the full F-16 (+4.9 MB before the first frame, 6.1 s instead
of ~2 s on fast 4G). tests/aircraft-lod.test.mjs.

### 6.4 Programs compiled after the first playable frame (fixed: 37b2cc6)
The 4 shadow-depth programs that appeared right after the first frame (canopy, airport structures, signs, props) came
from main.js compiling the aircraft rig and its cockpit in place: `compileAsync(object, camera, scene)` counts the lights
of the scene and of the object, so the rig's landing and cockpit lights counted twice; the programs built there were
never used, the display screens linked again at their first draw, and the renderer's light state stayed doubled until the
next frame's light setup, which three.js runs after that frame's shadow pass. `compileInScene()` detaches the subtree for
the synchronous part of the call. Programs linked after the first frame (desktop, fast 4G): 18 → 7, the rest being content
that streams in later and is compiled before its first draw (Golden Gate LOD net ×2 from `ctx.precompile`, the cockpit's
glass and screens, the full-model swap); no program is created by a draw after the start any more (renderBufferDirect
census). The wasted links ran on the driver's compile threads during the loading: without them the pre-warm and the
loading screen got shorter on CPU-bound profiles (laptop iGPU profile, unthrottled: pre-warm 447 → 271 ms, loading screen
1.59 → 1.32 s; desktop slow 4G pre-warm 280 → 196 ms).

### 6.5 The spawn airport on slow lines (fixed: d6e09bb)
The airport was built after the terrain of the start had arrived, so its json → bin → props.glb chain came last, and
props.glb (50 KB, which the start waits for) shared the line with the 3.1 MB of 2048² ground textures requested with it:
on slow 4G kngz.json was requested at 38 s and took 7 s, props.glb finished at 66 s, the first frame came at 67 s. Now the
spawn airport's json + bin and props.glb are requested when the layer is created (in parallel with the terrain; the
airport is still built and draped once the terrain is there): props.glb done at 4.8 s instead of 15.3 s on fast 4G, 27–31 s
instead of 63–66 s on slow 4G. Desktop classes also start with the 1024² ground textures phones and tablets use
(0.9 instead of 2.9 MB for the four large ones) and load the 2048² originals once the game is playable, one every 0.4 s
(the pavement is at 8 instead of 4 mm per texel for the first seconds, then as before; a texture that grows is disposed
first, three.js would otherwise sub-upload into the old storage). Desktop high, menu click → first playable frame: fast 4G
14.07–14.13 → 12.51–12.56 s (15.3 → 13.7 MB before the first frame), slow 4G 58.0–60.7 → 44.7–54.4 s (9.5–11.3 MB; the
terrain's start set varies between runs), 3G 113.9 → 104.4 s. The ground textures alone (1024² first, A/B with
`?groundfull=1`, two pairs): slow 4G 60.2 / 56.8 → 53.1 / 52.0 s, fast 4G unchanged.

### 6.6 Firefox
Playwright's Firefox 155 (macOS; the field data says the same of Firefox on Windows) has no `KHR_parallel_shader_compile`,
no `WEBGL_multi_draw`, no timer queries and only S3TC among the compressed formats. Its driver links a program at the
first draw that uses it, not at `compile()`: six fresh programs took ~345 ms at their first draw whether it came right
after `compile()` or 400 ms later, so the pre-warm's render frame pays for every link of the start and a streamed-in
material pays at its first draw. Building the world's programs early, while the start area downloads, cut Firefox's
pre-warm 764–796 → 430–448 ms but not its loading screen (+0.1 s unthrottled, −0.2 s on fast 4G; Chromium ±0.1 s):
dropped. On this Mac Firefox loads as fast as Chromium on fast 4G (13.9 vs 13.5 s behind the loading screen); the
field's 14.4 s p50 (Chrome/Windows 7.0 s) points at ANGLE's D3D11 compile of ~60 programs without a parallel compiler
or a persistent program cache: the `fly` beacon's new `pw` field (pre-warm seconds) will show it per platform
(`report.py --field pw`). After the first frame Firefox draws 8–11 frames over 50 ms in the first seconds, most with
little main-thread time and 5–16 MB of texture uploads in the frame (remote WebGL copies), a few with the cockpit's
programs (linked at its first draw).

### 6.7 Caching and delivery notes
- CloudFront's cache key leaves the query string out: a never-seen `?v=` URL on staging was a hit (age 1 s) served from
  the copy cached for another `v`. During a deploy (sync → invalidation) an edge can answer a new-version URL with the
  old object; the browser then keeps it under the new URL for the whole max-age. A cache policy with `v` in the key
  (query string allow-list `v`) makes a new version always come from S3 and lets pages opened before the deploy keep
  their old copies; it is also the precondition for ever going to a year + immutable (with a rewrite of Cache-Control for
  unversioned requests). Production and staging distribution change, not made.
- Staging (CloudFront only) sends `.glb` / `.bin` uncompressed (not on CloudFront's list): 20.3 MB before the first frame
  against ~15 MB compressed. Production's Cloudflare zone compresses them; on the Free plan Cloudflare compresses with
  zstd for browsers that accept it (Chrome 123, Firefox 126, Safari 26.3) and Brotli otherwise, and only 200 responses
  (a Range request's 206 goes out uncompressed, which the LOD start's GLB header read relies on). JSON / wasm / JS: Brotli
  on both.
- `index.html` is `no-cache` (one origin round trip per start), JS chunks a year + immutable, the Draco / Basis decoders
  7 days without a version in their URL (left alone: a stale wrapper next to a new wasm would break decoding for a load).

### 6.8 Later
- Reversed depth instead of `logarithmicDepthBuffer` (early-Z on immediate-mode GPUs: Mali at 64 % of target, Intel
  iGPUs): `EXT_clip_control` exists in Chromium and WebKit here but not in Firefox, the canvas depth buffer is 24-bit
  fixed point (reversed Z needs a float depth target, i.e. rendering into a render target and a blit, MSAA included), and
  the airport ground's layered `gl_FragDepth` bias is written for log depth. Worth a prototype behind a switch, measured
  on a Mali phone and an Intel laptop (telemetry A/B on `hb` fps), with the SSIM gate at 20+ km (bridges, city, runways).
- Water depth at 2048² on desktops too (tablets already): −1.2 MB before the first frame, −64 MB of GPU memory; changes
  shore shading slightly (32 → 64 m per texel), needs a maintainer's review of the heat maps.
- A menu-first JavaScript split: the start bundle is 1.83 MB / 496 KB Brotli; the world layers (177 KB), flight models
  (170 KB), three's loaders and decoders' glue (~135 KB) are needed only after "Uç": ~140 KB Brotli less before the menu
  (slow 4G −0.7 s, 3G −1.4 s), fetched while the player chooses.
- Early Hints (Cloudflare turns `Link: rel=preload` headers of an HTML response into a 103): the page's chunk names change
  every deploy, so the header would have to come from the deploy (a CloudFront response header per build).
- The Intel iGPU frame rate after the dynamic-resolution revert: the new release had ~3 hours of traffic at the time of
  writing (last 24 h, mostly the previous release: Windows · Intel 86 % of target, 24 % of pages below 80 %).
