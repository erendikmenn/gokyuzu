# Gökyüzü SF: performance plan (research, measured)

Research only: no game code was changed. Every number below was produced by the scripts in `tools/perf/` (section 9);
raw JSON, screenshots and image pairs of this study are in the session scratchpad (`…/scratchpad/perf/out`; the tools
write to `$PERF_OUT`, default `<tmpdir>/gokyuzu-perf`).

**What was measured.** Baseline = commit **`5d6612f`** (live, "Remove time of day…", robustness kept), as a clean
`git worktree` with the current assets, and its publish build (`dist/`) served over HTTP/2 + Brotli with the
`deploy.sh` cache policy (`tools/perf/serve-prod.mjs`). Earlier runs on `3833a08` / `94a7a5a` are used where the
rendering code is identical; an interleaved A/B (section 8) showed `5d6612f` = `94a7a5a` on load time, frame time,
GPU memory and pixels. The shared working tree was never measured (at the start of the study `dev` was `3833a08`
with 60 uncommitted files from other agents; at the end `0c34068`, with touch controls in progress).
Machine: Apple M4 Max, 128 GB, Chromium (Playwright headless shell, ANGLE on Metal) and Playwright WebKit;
2560×1440 at pixel ratio 1 unless stated.

**Shared-GPU caveat.** Other agents ran 3–5 headless game instances most of the day (GPU 50–100 % busy from other
processes). GPU timer queries measure wall time on the GPU, so the plan uses: runs gated on an idle GPU
(`scenes.mjs --quiet 30`), paired/interleaved A/B windows (`ab.mjs`, `layerGpuAblation`), the p10 of per-frame GPU
time, and metrics contention cannot change (bytes, draw calls, triangles, shaded fragments, GPU/process memory).

---

## 1. Headline: loading is the problem, not frame rate on a Mac

| | cold cache | warm cache |
|---|---|---|
| Local server, no throttling ("Uç" click → first playable frame) | 2.2–2.6 s | 2.1–2.5 s |
| **4G (9 Mbit/s, 60 ms)** | **25.1 s** (menu after 1.7–1.8 s) | 4.8 s |
| Fast 3G (1.6 Mbit/s, 150 ms) | **125 s** (menu after 8 s) | 24 s |
| Slow 3G (0.4 Mbit/s, 400 ms) | **444 s** (menu after 30 s) | – |
| 4G, returning player whose cached copies expired (every file revalidated) | – | 5.7 s |

(Times are from the "Uç" click to the first playable frame; the menu itself appears after 0.15 s locally, 1.7 s on
4G, 8 s on fast 3G, 30 s on slow 3G. `load.mjs` against the `5d6612f` publish build on `serve-prod.mjs`; 3 cold 4G runs 25.0–25.6 s.)

- The cold 4G time is pure transfer: **27.4 MB are downloaded before the first playable frame**, 27.4 MB × 8 /
  9 Mbit/s = 24.4 s. CPU/GPU work during loading is ~2.2 s and overlaps with the download.
- **A warm cache does not make the start fast on a slow network**: the terrain heights are fetched as 160–290 HTTP
  range requests into large files, and Chrome's cache does not serve them (5 of 289 came from cache on 4G, 1 of 157 on
  fast 3G). Every start downloads 1.6–1.7 MB of heights again: 4.8 s instead of ~2.5 s on 4G, 24 s instead of ~3 s on
  fast 3G. The same layout costs 22.5 GB/day of CDN egress (cost #9).
- Where the 27.4 MB go (4G cold, bytes before the first playable frame):

  | what | MB | notes |
  |---|---|---|
  | terrain start-up files | 6.9 | `pins.bin` 4.0 MB (airport/landmark heights, already deflated), `water_depth.png` 1.45 MB and `detail.png` 0.57 MB (both meant as "late" textures but they finish before the world is ready), `waves.png` 0.5, `index.bin` 0.3 |
  | F-16 exterior GLB | 6.5 | 4096² JPEG/PNG textures inside; the cockpit (2 MB) comes after the start |
  | terrain imagery (115 WebP tiles around the spawn) | 5.6 | already WebP |
  | airports | 3.6 | mostly ground textures (2048² JPEG runway/taxiway/concrete 0.56–0.79 MB each), `kngz.bin` 0.3 MB; `ksfo.bin` / `koak.bin` / building GLBs arrive after the start |
  | terrain heights (129 range requests of 9.5 KB) | 1.7 | uncompressed; each 9.5 KB tile is 41–45 % smaller deflated |
  | city atlas + index | 1.3 | |
  | landmarks | 0.9 | |
  | JavaScript (103 modules, depth 10) | 0.8 | Brotli; 1.3 s of the 1.8 s to the menu on 4G |
  | menu art + thumbnails + fonts | 0.7 | |
- **What real players see.** CloudFront logs (1 day, 557 sessions): only **36 % of sessions start a flight**, 45 % on
  desktop but 23 % on mobile, and **40 % of sessions are mobile** (in-app iOS browsers 19 %, Android 16 %). Players
  on mobile networks are on the 4G / 3G rows above. No fps/GPU telemetry exists yet (the beacons shipped with
  today's release), so the drop-off between the menu and the flight cannot be split into "too slow" and "not
  interested" yet; `tools/analytics/report.py` will show it within days.
- Reachable (estimates from the measured bytes; each change is in section 3 or 5): defer `water_depth.png` +
  `detail.png` until after the first frame (−2.0 MB), KTX2 + 2048 cap on the aircraft (−1.9 MB), heights as small
  deflated files (−0.8 MB, and cacheable), Brotli at the edge (measured −0.8 MB / −1.1 s), bundled JS (−0.4 MB):
  **4G cold 25 s → ~18 s**; starting with the aircraft's `_lod.glb` (0.4 MB) and swapping in the full model after the
  first frame takes another ~5 s (**~13 s**). Warm starts: **4G 4.8 s → ~2.5 s, fast 3G 24 s → ~3 s** once the
  heights are cacheable; a service worker also removes the 5.7 s expired-cache case.

## 2. The ten biggest measured costs

| # | cost | measured |
|---|---|---|
| 1 | Bytes before the first playable frame | 27.4 MB → 25.1 s on 4G, 125 s on fast 3G (cold); F-16 GLB 6.5 MB, terrain start files 6.9 MB (of which 2 MB are "late" textures), imagery 5.6 MB, airport textures 3.2 MB; warm starts still re-download 1.6–1.7 MB of terrain heights (4G 4.8 s, fast 3G 24 s) |
| 2 | Start-up stutter right after the loading screen | worst frame 0.4–0.8 s (35 shader programs linked + 156 MB of textures uploaded in one frame), then 5–10 frames > 50 ms; 52–64 program links (0.4–1.1 s of compile stalls) in the first 5 s; M4 Max, far worse on integrated GPUs |
| 3 | Texture memory of uncompressed RGBA textures | WebGL allocations 1.46–2.19 GB at high (peak 2.75 GB in a 10-minute flight), 0.81–1.05 GB even at low, plus 0.25–0.55 GB JS heap; aircraft 303 MB (4096² RGBA: 85 MB each), airport textures 386–422 MB resident on every preset and everywhere, trees 121–154 MB, terrain imagery up to 520 × 1.4 MB |
| 4 | Texture upload stalls (main thread) | F-16 exterior 124 ms, F-16 cockpit 112 ms, KSFO buildings 90 ms per load; ×10 on a 4× slower CPU (F-16 1.3 s). KTX2: 0.2–3 ms |
| 5 | Terrain + water shader | 45–55 % of the GPU frame at high (3.4 of 7.5 ms downtown, 4.4 at SFO, idle GPU); 133–170 draw calls; the water path (6–8 texture fetches) runs for pure-land pixels too: an exact branch saves 10 % of the whole GPU frame |
| 6 | Cockpit displays (2D canvas → texture at 30 Hz) | half of the cockpit GPU frame on the M4 Max: GPU mean 10.9–11.4 ms with the displays, 5.7–6.0 ms without (A/B, A320 and F-16); 130–230 MB/s of canvas uploads; 10 Hz saves 2.2 ms, mipmaps and round-robin nothing |
| 7 | Shadow pass | 215–241 extra draw calls per frame (≈ 35 % of all), CPU 0.75–1.1 ms, GPU 0.7–1.2 ms at high (idle GPU); medium pays both cascades too ("1 cascade" only shortens the range) |
| 8 | Draco decoding of streamed city tiles | 70 ms per tile (0.5–0.6 s on a 4× slower CPU); ~190 tiles in the first minute; meshopt decodes the same tile in 2–5 ms and is 51 % smaller after Brotli |
| 9 | Terrain height packs read with range requests | not cacheable by the browser (1.6–1.7 MB and 160–290 requests again on every start), and 22.5 GB/day of CloudFront egress because Cloudflare fills its cache with the whole 0.01–381 MB `h/<L>.bin` files (32 fills per level per day); city tiles add 9.6 GB/day uncompressed |
| 10 | CPU submission (`renderer.render`) + scene-graph walk | 1.8–3.5 ms/frame on the M4 Max at 350–725 draw calls (high); 5.5 ms of a 5.7–10.6 ms frame at low with 4× CPU throttling; the F-16 alone is 257 draw calls (85 meshes × main + 2 shadow cascades); `updateMatrixWorld` + traversal ~13 % of the main thread at 4× |

Not in the top ten (measured small on the M4 Max): overdraw (9–13 Mpx shaded per frame for a 3.7 Mpx screen, ×5.2–5.9
in the cockpit, 45–98 % of the sky/terrain/building/fog-bank fragments hidden because the log depth buffer writes
`gl_FragDepth`, but turning early-Z back on gave ×1.00 on Apple's tile renderer; unmeasured on Windows GPUs), HUD
0.2–0.5 ms/frame, audio < 0.1 ms/frame, world updates 0.2–0.7 ms, JS parse/compile ~0.1–0.2 s at load, sky dome /
fog bank / clouds 0.1–0.3 ms each on an idle M4 Max GPU, GC 0.7–1 ms per second of flight.

## 3. Top 8 changes, in order

Gains are measured where a prototype existed (runtime patch, shim, converted asset) and estimated from the measured
costs otherwise (marked "est."). Every change must pass the quality gate of section 7 on the poses listed.

| # | change | expected gain | effort / risk | quality impact and how it is verified | owner |
|---|---|---|---|---|---|
| 1 | **Terrain heights as small, deflated, cacheable files** instead of range requests into 0.01–381 MB packs (e.g. one file per 4×4 tiles of a level, each tile deflated like `pins.bin`) | warm starts **4G 4.8 → ~2.5 s, fast 3G 24 → ~3 s** (1.6–1.7 MB and 160–290 requests no longer re-downloaded); cold −0.8 MB (heights are 41–45 % compressible); CDN egress −22 GB/day and no more 381 MB Cloudflare cache fills | M / low (`tools/geo/terrain_build.py` + `terrain_pinpack.py`, `terrain.js` fetch/decode) | none (same data); `load.mjs` warm runs: terrain-h requests served from cache; captures at the noise floor | W1 |
| 2 | **Trim what loads before the first frame**: `water_depth.png` + `detail.png` after the first frame (placeholders exist), and the aircraft as its `_lod.glb` (0.4 MB) first with the full GLB swapped in after the start (chase/cockpit start: wait as today) | 4G cold −2.0 MB (−1.8 s) for the textures, −6 MB (≈ −5 s) for the aircraft: **25 s → ~18 s**, with the other items ~13 s; fast 3G −40 s (est.) | textures S / low; aircraft M / medium (visible swap in chase view; the physics/rig contacts come from `spec.js`, not the mesh) | first seconds differ by design (flat water tint, LOD aircraft); captures after the swap at the noise floor; a `load.mjs` screenshot at the first frame for review | W1 (terrain), lead + aircraft agents (`main.js`, `_lod`) |
| 3 | **KTX2 (Basis) textures + 2048 cap for aircraft, cockpits, airports, landmarks, trees** (UASTC for normal/ORM, ETC1S or UASTC for colour; `KTX2Loader` is already wired) | GPU memory −600–900 MB at high (F-16 203 → 15 MB, cockpit 85 → 2.7, KSFO 91 → 11, Golden Gate 35 → 6.4); upload stalls 90–124 ms → < 1 ms (×10 on slow CPUs); F-16 download 6.5 → 4.6 MB; brings high/ultra under the contract's 2.5 GB and lets phones use 1024² at today's 512² memory (4.7) | M / medium (asset pipeline per owner; WebP landmark/tree files get bigger, so UASTC+zstd there or keep WebP) | approximate: `capture.mjs` `aircraft-close`, `cockpit`, `sfo-ground`, `golden-gate` vs baseline, heat maps reviewed by the owners; `decode-bench.mjs` for bytes/upload | aircraft agents, W2, W3, W4 |
| 4 | **Pre-warm before hiding the loading screen**: `await renderer.compileAsync(scene, camera)` (KHR_parallel_shader_compile is available) + `renderer.initTexture()` for every texture in the scene; compile the materials of layers that appear later (trees, cockpit, city L0) on a hidden dummy mesh | removes the 0.4–0.8 s frame and most of the 52–64 later program links (0.4–1.1 s of stalls) from the first seconds of play; loading +0.2–0.5 s (est.) | S / low | none (same shaders); `load.mjs` hitch: worst frame < 50 ms in the first 5 s | lead (`main.js`) |
| 5 | **Brotli at the edge for `.bin` / `.glb`** (precompressed objects with `Content-Encoding: br` in `deploy.sh`, or a Cloudflare compression rule for `application/octet-stream` / `model/gltf-binary`) | measured 4G cold −0.8 MB / −1.1 s; after the start: `ksfo.bin` 4 MB → ~1.4 MB, landmark GLBs −26–29 %, airport GLBs −17–19 %, tree tiles −23–34 %; with meshopt city tiles (5) −51 % | S / low (deploy only) | none (lossless); `load.mjs --base` against `serve-prod.mjs --br-binary`, 0 console errors | lead |
| 6 | **JavaScript bundle** (esbuild, minified, code-split; hashed file names) | 774 → 421 KB Brotli; menu on fast 3G 8 s → ~5.5 s, 4G 1.7 → ~1.3 s (est. from bytes); `modulepreload` alone measured only −0.1 s on 4G and nothing on fast 3G (bandwidth-bound), so bundle | M / medium: ~15 modules resolve files with `new URL('…', import.meta.url)` and `menu.js` imports `model.js` through a runtime URL; both need one asset-root helper first | none; `load.mjs` + 0 console errors + a capture smoke run | lead |
| 7 | **Terrain shader: skip the water path for pure-land fragments** (`if (sfLandA < 1.0) { … }` around the water block of `FRAG_MAP`) | GPU −10 % of the whole frame at downtown / Golden Gate / cockpit (interleaved A/B on idle and busy GPU alike) | S / low | exact: SSIM 0.99997 vs unpatched at the same frozen pose; gate: all poses at the noise floor | W1 |
| 8 | **Cockpit displays: fewer and cheaper canvas uploads** (10–15 Hz for slow pages/gauges, 512² where the display is small, static layers drawn once, several small displays in one canvas) | cockpit GPU frame 11 → ~8.7 ms at 10 Hz (measured, ×0.78), → ~6 ms if the displays cost what they cost when off (upper bound); matters most on integrated GPUs | S–M / low | displays refresh slower (10 Hz is still smooth for needles; the PFD attitude may want 20–30 Hz): `cockpit` pose per aircraft, owner review of motion | AV |

Next in line (section 5 has them all): a service worker (cache-first for the content-addressed `?v=` URLs: the 4G expired-cache start 5.7 s → ~2.5 s), meshopt city tiles, a single-cascade shadow path on medium and cheaper shadow casters, a GPU-time-driven
dynamic resolution with a lower floor on weak GPUs, aircraft draw-call merging, and the early-Z question on Windows GPUs (no gain measured on Apple).

---

## 4. Findings in detail

### 4.1 Load and delivery

All on the `5d6612f` publish build over HTTP/2 + Brotli (`serve-prod.mjs`, cache policy of `deploy.sh`), Chromium with
a persistent profile (Playwright's default in-memory cache is too small for a flight and made every "warm" run cold),
menu → "Uç" → first playable frame (`__game.readyAt`).

- **Timeline of a cold 4G start** (`load-n-net.json`): the menu is up at 1.7 s (98 start-up JS modules = 0.8 MB,
  import depth 10, 1.3 s of the 1.7 s; plus the 320 KB `bay-map.jpg` and 5 thumbnails). After the click the F-16
  GLB (6.5 MB) starts at 2.6 s and finishes at 27.0 s, sharing the link with `pins.bin` (4.0 MB, done at 18.6 s),
  the imagery and heights around the spawn, then `water_depth.png` / `detail.png` / the airport JPEGs / the city
  atlas (18.7–27.1 s). The first frame follows at 27.1 s. Bandwidth, not latency or CPU, sets the time.
- **After the first frame** another 1.4–5.4 MB arrive in the first 5–8 s (airport building GLBs, city tiles, trees,
  cockpit GLB 2 MB, audio 0.6 MB): harmless while it streams.
- **JavaScript**: 98 static modules (103 requests incl. the five `model.js` the menu imports for thumbnails),
  3.7 MB raw / 774 KB Brotli; esbuild bundle: 1.63 MB raw / 421 KB Brotli for start-up, 63 ms build. Parse/compile
  is small (V8 compile ~50 ms, module evaluation ~40 ms, background parse ~50 ms in the trace).
  `<link rel="modulepreload">` for all 98 modules was measured: menu 1.59 s vs 1.68–1.78 s on 4G, no change on
  fast 3G. Bytes decide, so bundle (change #6).
- **Render loop during loading**: the loop renders the half-built world behind the loading screen from the start:
  92 frames / 567 ms of main-thread time during a 2.7 s local load (21 %), with 100–250 ms long tasks from tile
  building. Rendering at ~4 Hz (or not at all) while the loading screen covers the canvas returns that time to
  decoding/building (~0.5 s locally, ~2 s on a 4× slower CPU, est.).
- **Brotli at the edge** (`serve-prod.mjs --br-binary bin,glb`): 4G cold 25.1 → 24.0 s (−0.8 MB before the start).
  Live check: Cloudflare Brotli-compresses JS, JSON and `font/ttf` but not `.bin` / `.glb` (`content-encoding` absent,
  `cf-cache-status: HIT`); `src/` files have `max-age=300`, so a returning player revalidates all 98 modules after
  5 minutes (the 5.7 s expired-cache row; menu 0.88 s instead of 0.25 s).
- **Compression potential per asset family** (`assets-audit.mjs`, sampled files, Brotli 11 / gzip 6): terrain height
  tiles 45 / 41 %, airport `.bin` 70 / 58 %, landmark GLB 29 / 26 %, tree tiles 34 / 23 %, aircraft GLB 18 / 14 %,
  airport GLB 19 / 17 %, city tiles (Draco) 10 / 8 %, city tiles as meshopt 57 / 54 %, WebP imagery 0 %,
  landmark JSON 89 / 81 % (already compressed live).
- **Decode cost per asset** (`decode-bench.mjs`, M4 Max / 4× CPU throttle): city tile Draco 70 / 530–640 ms vs
  meshopt 2–5 / 18–33 ms; F-16 exterior parse 84–89 / 510–1650 ms and texture upload 124 / 1307 ms vs KTX2 upload
  1 / 3 ms; F-16 cockpit upload 112 / 239 ms vs 0.2 / 0.3 ms; KSFO buildings upload 90 / 203 ms vs 0.6 / 5 ms.
- **CDN** (`field.py` on the downloaded CloudFront logs, 1 day): CloudFront egress by type: terrain heights 22.5 GB
  (the whole `h/<L>.bin` packs, 32 fills per level; L10 alone 381 MB × 32 = 12.2 GB), city tiles 9.6 GB, aircraft
  2.0 GB, airports 1.9 GB, imagery 1.8 GB, trees 1.2 GB. Cloudflare serves the 9.5 KB ranges from its copy once it has
  the pack (checked live: `206`, 58 ms); a player whose request triggers a fill in a colo waits for the colo's fetch.

### 4.2 Start-up stutter (first seconds after the loading screen)

- About 0.4–0.8 s after `loading.hide()` one frame takes 420–800 ms (on `5d6612f`: 420–560 ms in 7 loads; on
  `3833a08` the very first frame also took 270–490 ms): in that frame 35 shader programs are linked (250–450 ms of
  `getProgramParameter` stalls) and 156 MB of textures are uploaded (aircraft/airport textures seen for the first
  time); 40–64 programs are linked in the first 5 s in total, another 19–31 before the start, and 3–7 more frames
  exceed 50 ms. Measured on the M4 Max with a fast CPU (`load.mjs` hitch section); on an integrated GPU and a slower
  CPU the same work takes several times longer.
- `renderer.info.programs` settles at 55–106 programs per preset/pose; program sets differ only by streaming order.
- Fix = change #4 (pre-warm) + #3 (KTX2 makes the uploads ~free).

### 4.3 GPU

Idle-GPU numbers on `5d6612f` (`scenes.mjs --quiet 30`, `scenes-n-quiet.json`), 2560×1440, pixel ratio 1, F-16 chase unless "cockpit", 5 s per row:

| preset | scene | GPU ms p10 / mean | of which shadow pass | CPU ms (p50) | of which render() | draw calls | triangles | shaded Mpx (× screen) |
|---|---|---|---|---|---|---|---|---|
| low | sfo-ground | 3.4 / 4.2 | 0.00 | 2.2 | 1.6 | 245 | 1.25 M | 12.5 (×3.39) |
| low | downtown-300 | 3.5 / 4.1 | 0.00 | 2.1 | 1.6 | 277 | 1.07 M | 12.5 (×3.38) |
| low | golden-gate | 3.1 / 3.9 | 0.00 | 2.3 | 1.8 | 304 | 1.07 M | 10.4 (×2.83) |
| low | bay-3000 | 2.5 / 3.7 | 0.00 | 2.1 | 1.7 | 256 | 0.55 M | 9.2 (×2.51) |
| low | birdseye | 2.2 / 3.3 | 0.00 | 1.7 | 1.2 | 141 | 0.49 M | 12.3 (×3.33) |
| low | cockpit-f16 ¹ | 3.0 / 7.5 | 0.00 | 1.8 | 1.5 | 204 | 1.17 M | 19.4 (×5.25) |
| low | cockpit-a320neo | 3.1 / 8.7 | 0.00 | 2.0 | 1.6 | 196 | 1.23 M | 19.1 (×5.18) |
| medium | sfo-ground ¹ | 5.9 / 7.0 | 0.30 | 2.8 | 2.3 | 486 | 2.04 M | 12.5 (×3.4) |
| medium | downtown-300 | 7.2 / 7.9 | 0.26 | 3.0 | 2.4 | 493 | 1.86 M | 12.6 (×3.43) |
| medium | golden-gate | 6.2 / 6.7 | 0.25 | 3.3 | 2.7 | 543 | 1.64 M | 10.5 (×2.85) |
| medium | bay-3000 | 3.8 / 4.4 | 0.28 | 2.8 | 2.3 | 448 | 0.97 M | 9.3 (×2.52) |
| medium | birdseye ¹ | 2.8 / 3.6 | 0.28 | 2.0 | 1.5 | 306 | 0.67 M | 12.3 (×3.33) |
| medium | cockpit-f16 | 4.8 / 10.3 | 0.33 | 2.9 | 2.4 | 441 | 1.97 M | 19.4 (×5.25) |
| medium | cockpit-a320neo | 4.4 / 8.1 | 0.35 | 3.0 | 2.6 | 553 | 2.16 M | 19.1 (×5.19) |
| high | sfo-ground | 6.7 / 7.9 | 0.61 | 4.0 | 3.4 | 569 | 3.12 M | 12.6 (×3.42) |
| high | downtown-300 | 7.5 / 9.1 | 0.83 | 3.8 | 3.2 | 660 | 3.63 M | 12.8 (×3.46) |
| high | golden-gate ¹ | 9.1 / 10.6 | 0.83 | 4.1 | 3.5 | 725 | 3.46 M | 10.7 (×2.89) |
| high | bay-3000 ¹ | 5.6 / 7.6 | 0.51 | 3.4 | 2.9 | 501 | 1.53 M | 9.4 (×2.55) |
| high | birdseye ¹ | 2.8 / 3.5 | 0.68 | 2.3 | 1.8 | 354 | 1.06 M | 12.3 (×3.33) |
| high | cockpit-f16 | 5.9 / 13.6 | 0.69 | 3.8 | 3.2 | 520 | 3.10 M | 19.4 (×5.27) |
| high | cockpit-a320neo | 5.4 / 12.1 | 0.68 | 3.7 | 3.1 | 637 | 3.31 M | 19.1 (×5.19) |
| ultra | sfo-ground | 6.5 / 7.9 | 0.72 | 4.9 | 4.2 | 658 | 3.87 M | 12.6 (×3.43) |
| ultra | downtown-300 | 8.3 / 9.3 | 0.92 | 4.6 | 3.9 | 746 | 4.35 M | 12.8 (×3.49) |
| ultra | golden-gate | 7.8 / 8.9 | 1.05 | 5.1 | 4.4 | 851 | 5.06 M | 10.8 (×2.92) |
| ultra | bay-3000 ¹ | 5.9 / 6.5 | 0.75 | 4.2 | 3.6 | 532 | 1.91 M | 9.5 (×2.58) |
| ultra | birdseye | 3.8 / 4.4 | 0.76 | 2.4 | 1.9 | 363 | 1.27 M | 12.3 (×3.33) |
| ultra | cockpit-f16 | 6.2 / 13.6 | 0.66 | 4.0 | 3.5 | 571 | 3.49 M | 19.4 (×5.27) |
| ultra | cockpit-a320neo | 6.0 / 14.3 | 0.77 | 4.4 | 3.9 | 687 | 3.69 M | 19.2 (×5.21) |

¹ the GPU did not get below 30 % busy from other processes within 30 s; the p10 is still close to the idle value.
All rows 60 fps (vsync). Cockpit views have a mean ≈ 2× the p10: the frames that upload the avionics canvases cost ~5 ms more (section 4.4, A/B).

- **Headroom on the reference Mac is large at 1440p**: 3–10 ms GPU and 2–5 ms CPU per frame on every preset. The
  cost moves with pixels: at 5120×2880 (a 5K display, `scenes-n-dpr2.json`, pixel ratio pinned to 2; the high preset itself stops at 1.5 = 3840×2160) high downtown costs 16.5 ms p10
  on an idle GPU (43 fps; 4× the pixels of 1440p for 2.2× the GPU time), and ultra at Golden Gate / downtown 40–53 ms
  (15–19 fps, busy GPU). On a 5K or Retina display ultra therefore depends on dynamic resolution (floor 0.6× → pixel
  ratio 1.2); the contract's "60 fps in Safari on an M4 Max at 1440p–5K" holds at 1440p on every preset, not at 5K
  on ultra without it. Fragment-side savings (#7 terrain, the avionics fix in the cockpit) count double there.
- **Where the GPU time goes** (high, paired ablation on an idle GPU, `3833a08` and `5d6612f` runs; frame 7.4–7.6 ms
  p10): terrain + water 3.4 ms at downtown and 3.0–4.4 ms at SFO (≈ 45–55 %), city buildings 1.3–1.5, airports
  1.7–2.4 at SFO, F-16 0.8–1.6, shadow pass 0.6–1.2 GPU (+0.75–0.9 ms CPU, 215–241 calls), fog bank 0.15–0.8 at
  downtown, clouds 0.3, sky 0.1–0.6, trees ≈ 0–0.5. Low preset: terrain 1.4–1.6 of 4.0–4.6 ms.
- **Overdraw** (`overdraw.mjs`, contention-free): at downtown 12.75 Mpx are shaded for 3.69 Mpx of screen:
  sky 3.69 (50 % hidden), buildings 2.81 (63 %), terrain 2.44 (72 %), fog bank 1.85 (98 % hidden: the camera-centred
  81 km grid is shaded everywhere and discarded), clouds 1.59. In the cockpit 19.4 Mpx: the F-16 7.2, and the whole
  world behind the panel (terrain 94 % hidden).
- **Experiments that did not pay on Apple (keep for Windows GPUs):** the log depth buffer disables early-Z, but
  turning it off (`?exp=nolog`) or rendering reversed float depth (`?exp=revz`, three's `reversedDepthBuffer` + a
  float depth target) gave ×0.99–1.00 GPU at downtown / Golden Gate / cockpit (Apple's tile renderer hides most of
  it); drawing the sky last at the far plane: ×0.98–0.99. On NVIDIA/AMD/Intel (immediate-mode GPUs, 29 % of
  sessions are Windows) `gl_FragDepth` disables early-Z/Hi-Z entirely, so the 45–94 % hidden fragments may matter
  there: measure on one Windows iGPU before deciding (`ab.mjs` with the shim).
- **Terrain land branch** (`patches.mjs terrainbranch`): ×0.90, ×0.92, ×0.90 of the whole GPU frame at
  downtown / cockpit / Golden Gate; exact output.

### 4.4 CPU

- **Per frame on the M4 Max** (idle GPU table above, high): 2.3–4.1 ms of main-thread time in the render loop, of
  which `renderer.render` 1.8–3.5 ms (three.js: scene traversal, sorting, per-object uniforms/state, 350–725 draw
  calls incl. the two shadow cascades), world updates 0.2–0.5 ms (city 0.1–0.3, landmarks 0.1–0.4 incl. bridge
  traffic, terrain < 0.1), HUD 0.2 ms, avionics 0.07–0.15 ms (cockpit), audio < 0.1 ms, flight model 0.05 ms.
  During a 10-minute high-preset flight at 1080p the main thread is **68 % idle** (CPU profile, `n-soak-high.json`).
- **Low preset with the CPU throttled 4×** (the low-end proxy, `n-soak-low-cpu4.json`, 1080p): 5.7–10.6 ms/frame,
  main thread 29 % idle; `render` 5.5 ms, world 1.1 ms (landmarks 0.58, city 0.32), **HUD 0.83 ms**, audio 0.16 ms.
  Self time is spread over three.js: `updateMatrixWorld` 7.4 %, `projectObject` 4.7 %, `renderBufferDirect` 3.8 %,
  `traverse` 2.9 %, `multiplyMatrices` 2.6 %: the scene graph is walked every frame including ~900 hidden terrain
  meshes and every loaded city/airport object. Removing hidden terrain tiles from the scene (instead of
  `visible = false`) and `matrixWorldAutoUpdate = false` on static groups saves an estimated 0.5–1 ms/frame there.
- **Where draw calls come from** (high, downtown, 660 calls): terrain 170, F-16 257 (85 meshes × main + 2 cascades),
  landmarks 111, city buildings 103, trees 16, airports 0–84; the shadow pass alone is 215–241 calls (ablation). Both
  the aircraft (merge static meshes) and the shadow casters are cheap targets for the CPU on weak machines.
- **Allocations and GC**: steady cruise allocates 12–25 MB/s (per-frame heap deltas incl. streamed buffers),
  30–100 MB/s while streaming new areas; GC costs 0.7–1.0 ms per second of flight (33 minor GCs ≤ 0.8 ms and one
  11 ms major GC in 40 s at high; ≤ 2.1 ms minor / 8 ms major at 4× CPU). No GC-caused hitch was seen. The per-tile
  terrain materials (`createTerrainMaterial` per tile → three clones ~60 uniforms per new tile) are the largest
  engine-side allocation site in the sampled window.
- **Long tasks**: none in steady flight on the M4 Max (0 over 50 ms in 10 min except 3 frames of 55–91 ms when new
  shader programs appeared); at 4× CPU 12 frames > 50 ms and 6 > 100 ms in 5 min (max 293 ms), all at the start or
  when entering a new area together with program links (7–8 links, 57–270 ms of compile stalls): pre-warm (#4) helps
  there too.
- **Avionics** (cockpit): 0.07–0.9 ms/frame of canvas drawing (UH-60 highest), but the 1024² canvases are re-uploaded
  with mipmap generation at 30 Hz: 130–230 MB/s of texture uploads and ~70 mipmap generations per second.
  **Measured with interleaved A/B in the cockpit (high, A320 and F-16, `ab-avionics*.json`): the displays cost about
  half of the cockpit GPU frame.** GPU mean 10.9–11.4 ms with the displays updating, 5.7–6.0 ms with
  `display.enabled = false` (×0.51–0.53), while the p10 is unchanged (5.4–5.8 ms): the cost sits in the frames that
  upload display canvases (2D-canvas raster on the GPU + canvas→texture copy; both land inside the WebGL frame).
  Uploading without mipmaps changes nothing (×0.99–1.00); updating half of the displays per 30 Hz tick changes
  nothing (×0.97); updating all displays at 10 Hz saves 2.2 ms (×0.78). So part of the cost scales with the update
  rate and part is fixed per upload frame. Candidate fixes, each to be A/B'd with `patches.mjs`: 512² canvases where
  the physical display is small, static layers drawn once (the `Layer` helper exists), 10–15 Hz for slow pages and
  gauges, fewer canvases (atlas several small displays into one texture). This is invisible on the M4 Max at 60 Hz
  (the p95 stays at 17 ms) but is the largest single GPU item in cockpit views and will show on integrated GPUs.
- **HUD / DOM**: 0.2 ms/frame (0.8 ms at 4× CPU); layout 0.4 ms/s, style 0.2 ms/s, paint 0.2 ms/s, compositor
  commit 12 ms/s (30 ms/s at 4×). The HUD only touches changed DOM nodes; no layout thrash was seen.
- **Audio**: < 0.1 ms/frame main thread (0.16 at 4× CPU).

### 4.5 Memory, streaming and a 10-minute flight

WebGL allocations counted at the GL level by the probe (textures incl. mip chains + buffers; the canvas back buffer,
~70–120 MB with MSAA, is not included), after settling at each pose, `5d6612f`, desktop class, 2560×1440
(`scenes-n-mem.json`), plus the JS heap:

| preset | SFO ground | downtown 300 m | Golden Gate | cockpit (SFO) | JS heap |
|---|---|---|---|---|---|
| low | 0.81 GB | 0.97 GB | 1.05 GB | 0.82 GB | 0.24–0.37 GB |
| medium | 1.11 GB | 1.46 GB | 1.59 GB | 1.15 GB | 0.26–0.59 GB |
| high | 1.46 GB | 2.01 GB | 2.19 GB | 1.51 GB | 0.33–0.54 GB |
| ultra | 1.62 GB | 2.27 GB | 2.42 GB | 1.61 GB | 0.39–0.55 GB |

- Against the contract (§2: ≤ 2.5 GB GPU+JS at downtown, 1440p; §8: low ≈ 1 GB): high downtown sits at the limit
  (2.0 + 0.5 GB), high at the Golden Gate (2.7 GB) and ultra (2.7–2.9 GB) are over, low is 1.05–1.4 GB.
- **What is resident everywhere** (scene traversal + GL bytes): airports 422 MB on every preset and at every place
  (KSFO/KOAK/KNGZ textures and buildings, even over Marin), the F-16 303 MB (4096² textures; 111 MB when the 2048 cap
  applies), trees 121–154 MB (97 MB of textures + up to 56 MB of instance buffers sized for 40 000 instances per
  species), landmarks 65–162 MB. Grows with the place and preset: city building geometry 28–394 MB, terrain meshes
  13–120 MB, terrain imagery up to `maxImageryTiles` × 1.4 MB (200 / 320 / 520 tiles).
- **Process memory** (high, after a forced GC, `heapcheck-high.json`): renderer process 1.54–1.60 GB (was 2.15–2.23
  GB before the image release of `5d6612f`), GPU process 1.09–1.24 GB, retained JS heap 278–282 MB.
- **10-minute flight** (high, 1080p, autopilot tour of the bay, `n-soak-high.json`): GPU allocations rise from 1.9 GB
  to a peak of 2.75 GB while new areas stream in, then hover at 2.2–2.7 GB once the terrain caps are reached (945 of
  950 tiles, ~520 imagery textures); the texture count is flat (700–730) for the last 5 minutes: caches filling up
  to their caps, no leak signature (+489 MB GPU, +88 MB heap over 9.7 min). Streaming bursts upload 30–84 MB/s of
  textures/buffers when a new area appears; frame p99 stayed at 17.5–17.9 ms, 3 frames > 50 ms, none > 100 ms.
  Low preset + 4× CPU (5 min, `n-soak-low-cpu4.json`): 0.93–1.39 GB GPU, heap 0.29–0.45 GB, 12 frames > 50 ms and
  6 > 100 ms (max 293 ms), all at the start or when entering a new area together with shader compiles.

### 4.6 Low-end proxy, WebKit, Retina/5K

- **Low-end proxy** (Chromium, CPU throttled 4× with `Emulation.setCPUThrottlingRate`, 1920×1080, the M4 Max GPU;
  `scenes-n-lowend-cpu4.json`): low 7.7–8.8 ms of main thread per frame (render 5.6–6.6, world 0.8–1.2, HUD 0.8–0.9),
  medium 10.8–13.8 ms (render 8.5–11.6). Both hold 60 fps here because the GPU is fast; a real low-end laptop is
  also GPU-limited, so medium is CPU-marginal and low has ~8 ms of headroom. Loading at 4× CPU: texture uploads and
  Draco decodes take ~10× longer (4.1), the start-up stutter and the first-area hitches reach 150–300 ms (4.5).
- **Safari engine** (Playwright WebKit, `scenes-n-webkit.json`, 1920×1080): no errors; 60 fps; CPU 2.6–4.1 ms outside
  (render 1.6–3.0, HUD 0.3–0.8 ms, about twice Chromium's HUD cost), **cockpit 6.2 ms (render 5.3 ms, vs 3.2 ms in
  Chromium)** with p95 25–30 ms frames; WebKit exposes no GPU timer query (dynamic resolution must stay fps-driven
  there) and no `performance.memory`. Safari/macOS + iOS are 27 % of sessions: the cockpit CPU cost is worth a look in
  Safari's profiler (canvas-to-texture uploads are the prime suspect, as in 4.4).
- **Retina / 5K**: section 4.3 (high 16.5 ms GPU at 5120×2880; ultra depends on dynamic resolution).

### 4.7 Device-class look check (robustness caps, `?device=`)

Captures of the committed `5d6612f` at 1920×1080 (`capture.mjs --extra '&device=…'`, the class forced with the game's
own `?device=` switch) at `sfo-ground`, `downtown-300`, `golden-gate`, `cockpit`, `aircraft-close` (new pose: 3/4 front
view of the F-16) and `free-sfo`, next to desktop high. Two sets: each class at **high** (only the caps differ) and at
its own default (`--preset auto`: integrated → low, tablet → medium, phone → low). Effective settings read back from
`__game.quality` in every capture (`capture.json`). Image grids in `$PERF_OUT/cap/`: `grid-caps-aircraft-zoom.png`,
`grid-caps-cockpit-zoom.png` (caps only), `grid-devices-world.png`, `grid-devices-ground-zoom.png`,
`grid-devices-aircraft-zoom.png`, `grid-devices-cockpit-zoom.png` (defaults).

| class | caps (on top of the preset) | SSIM vs desktop high, 6 poses | look |
|---|---|---|---|
| integrated @ high | 2048 textures, 200 imagery tiles, 2048² shadows, lazy cockpit | 0.990–1.000 | same as desktop; stays on high (1.12–1.51 GB GL-level at 4 poses, budget 1700 MB) |
| tablet @ high | 2048 textures, 130 tiles, 1 cascade 2048², city LOD ×0.5, trees ×0.5 | 0.92–0.999 (downtown 0.92) | good; downtown has fewer/lower-LOD buildings in the distance |
| phone @ medium | **512 textures**, 90 tiles, 1024² shadows, city LOD ×0.4 | 0.86–0.995 | cockpit blurry (below) |
| integrated default (low) | as above + low preset | 0.80–0.97 | the low look: no shadows, smeared clouds, flat water, fewer trees; nothing broken, terrain not washed out |
| tablet default (medium) | | 0.92–0.997 | good |
| phone default (low) | | 0.76–0.97 | low look + blurry cockpit |

Flagged:
1. **Phone: the 512² texture cap makes the cockpit blurry.** Keypad and switch labels become unreadable and the round
   gauge faces smear; the canvas-drawn MFD/HUD pages stay sharp. The aircraft skin at close range loses the livery
   detail and its panel lines turn blotchy (`grid-caps-cockpit-zoom.png`, `grid-caps-aircraft-zoom.png`, right
   column). A phone screen is smaller than these captures, but the cockpit panel fills it. With KTX2 (change #3) a
   1024² ASTC/ETC2 texture costs the same 1.4 MB as a 512² RGBA one today, so the phone cap can move to 1024 (at least
   for the cockpit atlas) at no memory cost.
2. **2048 on integrated GPUs / tablets is invisible at these distances** (aircraft and cockpit SSIM ≥ 0.997 against
   4096): the cap could apply to every class once measured on a 5K display, saving ~200 MB of GPU memory on desktops.
3. The low preset's clouds (`clouds: 'low'`) look smeared next to medium, which costs 0.1–0.3 ms on the M4 Max:
   worth checking on a real iGPU whether medium clouds fit the low preset.
4. **Harness pitfall found on the way (minor game behaviour):** hiding or cycling the HUD (`hud.setVisible`, the H key)
   saves the HUD mode through `saveSettings()`, and the broadcast settings carry the stored/detected quality, which
   replaces a preset given with `?quality=` (here: every `?quality=high` page became ultra, an `?device=integrated`
   page low). Players normally have no `?quality=`, but test scripts and shared links do. `capture.mjs` now hides
   the HUD with CSS only; other agents' test scripts that pass `?quality=` and toggle the HUD measure the stored
   preset, not the requested one.

### 4.8 Quality presets per device class and real players

- **Device detection** (`src/core/gpu-device.js`, new in `5d6612f`) now classes iPhones/iPads/Android as phone/tablet
  and caps them (section 4.7); before it, every iPad and iPhone reporting "Apple GPU" got **high**. With 40 % mobile
  sessions this was the biggest preset problem and it is fixed.
- **Desktop defaults vs measured cost** (M4 Max idle GPU, 2560×1440): low 2.9–4.9 ms GPU, medium 3.0–8.0, high
  3.9–11, ultra 3.6–13.6 (cockpit views highest). Apple M-series Pro/Max → ultra is right on 1440p; on a 5K/Retina
  display ultra's pixel ratio 2 multiplies the pixels by 4 (high downtown at 5K: 16.5 ms GPU vs 7.5 ms at 1440p; ultra relies on dynamic resolution there, 4.3).
- **Integrated GPUs → low**: memory would allow high (1.1–1.5 GB with the integrated caps, budget 1700 MB, see 4.7); the open question is GPU speed.
  An Iris Xe has ~1/7 of the M4 Max's ALU and 1/8 of its bandwidth; low at 1080p (0.56× the pixels of these runs)
  scales to roughly 3–4 ms × 0.56 × 7–8 ≈ 12–22 ms GPU (est.), i.e. the contract's "≥ 40 fps on low" is plausible
  but unverified; medium would not be. Measure on one real Windows iGPU before changing defaults.
- **Medium** renders both shadow cascades (three's `SunLight` has 2 fixed; "1 cascade" only shortens the range):
  486–553 draw calls vs 245–304 on low, for a short-range shadow. A real one-cascade path (change #7) makes medium the
  natural default for mid-range laptops.
- **Dynamic resolution** (`main.js` `adaptResolution`) reacts to fps < 50 with 1 s granularity, floor 0.6× of the
  preset maximum. It cannot tell GPU-bound from CPU-bound frames (lowering the resolution does nothing for a slow
  CPU) and its first 6 s are blind (the start-up stutter). Use the GPU timer query (available in Chrome/Edge,
  `EXT_disjoint_timer_query_webgl2`) when present and keep fps as the fallback (Safari).
- **Real players**: Windows 29 % of sessions, macOS 27 %, iOS 24 %, Android 16 % (1 day, 557 sessions). GPU names and
  fps arrive with the telemetry from today's release (`report.py` "Ekran kartları", "Performans"); re-check the
  defaults against them after a week.

---

## 5. All opportunities

Ordered by area. "Cost" = measured today; gains without a prototype are estimates ("est."). Effort S < 1 day,
M 1–3 days, L > 3 days. Verification = the quality gate of section 7 on the named poses, plus the tool that proves
the gain.

**Delivery and loading**

| change | cost today | gain | effort / risk | quality / verify | owner |
|---|---|---|---|---|---|
| Heights as small deflated cacheable files (top #1) | warm 4G 4.8 s, fast 3G 24 s; 22.5 GB/day egress | warm ~2.5 / ~3 s; −0.8 MB cold | M / low | lossless; `load.mjs` warm | W1 |
| Late textures after the first frame (top #2) | 2.0 MB before the start | −1.8 s 4G, −10 s fast 3G | S / low | first seconds only; capture after 10 s | W1 |
| Aircraft `_lod.glb` first, full GLB after the start (top #2) | 6.5 MB before the start | ≈ −5 s 4G (est.) | M / medium | visible swap; review at `sfo-ground`, `aircraft-close` | lead, aircraft agents |
| Split `pins.bin` per airport/landmark area, spawn area first | 4.0 MB before the start | ≈ −2.5 MB / −2.2 s 4G (est.) | M / low | lossless | W1 |
| Airport ground textures: 1024² or KTX2 for the first view, 2048² after | 3.2 MB of 2048² JPEG before the start | ≈ −1.5 MB (est.) | S–M / low | runway close-ups at `sfo-ground`, `free-sfo` | W4 |
| Brotli for `.bin`/`.glb` at the edge (top #5) | served raw | −0.8 MB / −1.1 s 4G measured; −30–70 % on streamed binaries | S / low | lossless | lead |
| JS bundle, hashed names, `max-age=1y immutable` (top #6) | 98 modules, 774 KB br, revalidated every 5 min | −353 KB; fast 3G menu −2.5 s (est.); no revalidation | M / medium | smoke | lead |
| `bay-map.jpg` (320 KB) only when the big map opens | loaded with the menu | 4G menu −0.3 s (est.) | S / low | none | UI |
| Render the loading-screen frames at ~4 Hz or not at all | 567 ms of main thread in a 2.7 s load | ~0.5 s local, ~2 s on slow CPUs (est.) | S / low | none | lead |
| Service worker, cache-first for `?v=` (next in line) | expired cache 5.7 s on 4G | ~2.5 s | M / medium | none | lead |

**Start-up and textures**

| change | cost today | gain | effort / risk | quality / verify | owner |
|---|---|---|---|---|---|
| Pre-warm programs + textures before `loading.hide()` (top #4) | 0.4–0.8 s frame, 52–64 links in 5 s | smooth first seconds | S / low | `load.mjs` hitch | lead |
| KTX2 + 2048 cap (top #3) | 90–124 ms uploads, GPU 0.3–0.4 GB for aircraft+airports | −600–900 MB GPU, uploads < 1 ms | M / medium | captures + owner review | owners |
| Cockpit displays (top #8): 10–15 Hz for slow pages, 512² where small, static layers once, fewer canvases | ~5.2 ms of an 11 ms cockpit GPU frame (A/B); mipmaps measured irrelevant, round-robin ×0.97 | 10 Hz measured −2.2 ms; up to −5 ms | S–M / low | `cockpit` per aircraft, motion review | AV |

**GPU**

| change | cost today | gain | effort / risk | quality / verify | owner |
|---|---|---|---|---|---|
| Terrain land branch (top #7) | water maths for every land pixel | −10 % GPU frame | S / low | exact | W1 |
| Terrain: water detail by distance (skip the 7.9 m / 23 m octaves and foam beyond ~3 km) | terrain = 45–55 % of the GPU frame | −3–8 % (est.) | S / low | `bay-3000`, `golden-gate`, `free-ggb` | W1 |
| Shadows: one real cascade on medium; the far cascade every 2nd frame on high/ultra; aircraft as one merged caster; city L0 only in the near cascade | 215–241 calls, CPU 0.75–1.1 ms, GPU 0.6–1.2 ms at high | −100–240 calls, CPU −0.4–1 ms (est.) | M / medium | `sfo-ground`, `downtown-300`, `cockpit` + a moving capture for lag | W1 (+ lead for the rig) |
| Dynamic resolution from the GPU timer query (fps fallback), floor 0.5 on integrated GPUs | fps-only, blind for 6 s, cannot tell CPU- from GPU-bound | stable 60 on fill-bound GPUs; no pointless drops on CPU-bound ones | S / low | none at 60 fps | lead |
| Fog bank: collapse fog-free vertices (conservative footprint test with the ring spacing as margin) or a mesh bounded to the fog footprint | 1.85–2.0 Mpx shaded for 0–0.03 Mpx visible; 0.1–0.15 ms on the M4 Max | fill-rate on weak GPUs (est.) | S / low | `golden-gate`, `free-ggb` (fog visible) at the noise floor | W1 |
| Sky dome last, at the far plane, without `gl_FragDepth` | 3.69 Mpx shaded, 50 % hidden | 1–2 % on Apple (measured) | S / low | exact | W1 |
| Early-Z on immediate-mode GPUs: reversed float depth instead of the log depth buffer, front-to-back opaque sort | 45–94 % of shaded fragments hidden; no gain on Apple (measured ×1.00) | unknown on Windows GPUs (29 % of sessions) | M / medium | all poses (depth precision far away) | lead |

**CPU**

| change | cost today | gain | effort / risk | quality / verify | owner |
|---|---|---|---|---|---|
| Merge the aircraft's static meshes per material (F-16: 85 visible meshes × 3 passes = 257 calls) | 0.44–0.52 ms CPU, 0.8–1.1 ms GPU (ablation) | ≈ −170 calls, −0.3 ms CPU (est.) | M / low (keep animated parts separate, §5.1 names) | `aircraft-close`, `cockpit` | aircraft agents |
| Keep only selected terrain tiles in the scene (not `visible = false`), `matrixWorldAutoUpdate = false` on static groups | `updateMatrixWorld` + traversal ≈ 13 % of the main thread at 4× CPU (≈ 1 ms/frame) | −0.5–1 ms/frame on slow CPUs (est.) | S / low | exact | W1, W2, W4 |
| Render the world at ~4 Hz while the loading screen is up | 567 ms of main thread in a 2.7 s load | faster loads on slow CPUs | S / low | none | lead |

**Streaming and memory**

| change | cost today | gain | effort / risk | quality / verify | owner |
|---|---|---|---|---|---|
| Meshopt city tiles + Brotli | Draco 70 ms/tile (0.5 s on slow CPUs), 727 KB/tile after Brotli | 2–5 ms/tile, 358 KB/tile | M / low–medium | `downtown-300`, `free-downtown`, `birdseye` | W2 |
| Unload airport textures/buildings beyond ~15 km (KSFO while over Oakland, and vice versa) | 386–422 MB resident on every preset, everywhere | −250–350 MB GPU away from airports (est.) | M / low | airport poses after a round trip | W4 |
| Tree instance buffers sized to what the preset draws | 56 MB of instance buffers at high (40 000/species capacity) | −30–40 MB (est.) | S / low | `downtown-300` tree count | W2 |
| Keep WebP for terrain imagery (KTX2 would double the download); rely on `maxImageryTiles` | 1.4 MB GPU per tile, 200–520 tiles | – | – | – | – |


## 6. Memory findings for the robustness agent

For the robustness agent (context loss, budgets, eviction in `src/core/quality.js`, `gpu*.js`, streaming). Numbers from
section 4.5 unless stated.

1. **Budgets vs what the presets use** (GL-level, without the canvas): low 0.81–1.05 GB vs `gpuBudgetMB` 1700,
   medium 1.11–1.59 vs 2000, high 1.46–2.19 (peak 2.75 in the 10-minute flight) vs 3000, ultra 1.62–2.42 vs 3800,
   integrated @ high 1.12–1.51 vs 1700 (no step-down seen). The budgets leave headroom on desktop; the contract's
   own targets (2.5 GB GPU+JS, ~1 GB on low) are exceeded (4.5).
2. **Largest levers for the budgets**: KTX2 (change #3; aircraft 303 → ~20 MB, airport textures ~220 → ~30 MB,
   trees 97 → ~20 MB); unloading airports beyond ~15 km (386–422 MB everywhere today); tree instance buffers sized
   by preset (56 MB at high).
3. **The image release works**: renderer process −555 to −690 MB at high with identical pixels and frame times
   (section 8).
4. **`cityUnloadAfter` 12 s on high/ultra**: GPU 170–190 MB lower 12 s after leaving an area (measured at SFO); the
   tiles come back from the HTTP cache (GLBs are cacheable), so the churn costs decode time (Draco 70 ms/tile), not
   bandwidth; meshopt (section 5) would make that churn cheap.
5. **Terrain height range requests are not cached by the browser** (section 1): every start and every revisited area
   re-downloads heights; on mobile data plans this is also a data-usage issue.
6. **`?quality=` vs saved settings** (4.7 item 4): any `saveSettings()` broadcast (HUD toggle, settings panel)
   replaces a URL preset with the stored one. The context-loss reload URL carries `?quality=<lower>` and also stores
   the ceiling, so it stays consistent today; keep it that way if the reload path changes.
7. **Mobile**: the phone class's 512² cap costs visible cockpit quality (4.7 item 1); with KTX2 1024² fits the same
   memory. Telemetry `gfx` events will show real budgets and step-downs per device class within days.

## 7. Quality gate

Every change in sections 3 and 5 names the poses that must pass. The harness freezes time so water, clouds, the fog bank and
animations are identical between captures, hides the DOM HUD, waits for streaming to settle, and compares against a
second baseline capture (the run-to-run noise floor: streaming order, LOD timing).

```sh
# once per baseline (clean worktree of the commit before the change, served on :5195)
node tools/perf/capture.mjs --out base  --preset high
node tools/perf/capture.mjs --out noise --preset high
# the candidate (other server/worktree, a shim experiment or a runtime patch)
PERF_BASE=http://localhost:5196/ node tools/perf/capture.mjs --out cand --preset high
.venv/bin/python tools/perf/ssim.py --dirs $PERF_OUT/cap/base $PERF_OUT/cap/cand --noise $PERF_OUT/cap/noise \
    --heatmaps $PERF_OUT/cap/heat --json $PERF_OUT/cap/cand.json      # exit code 1 if any pose fails
```

- Poses (`tools/perf/lib.mjs` `POSES`): `sfo-ground`, `downtown-300`, `golden-gate`, `bay-3000`, `birdseye`, `cockpit`
  (chase / cockpit cameras around the F-16) and three free cameras independent of the aircraft (`free-downtown`,
  `free-ggb`, `free-sfo`). Add `--aircraft a320neo` etc. for aircraft-specific changes, `--preset low|medium|ultra` for
  preset changes, `--extra '&device=tablet'` for a device class (the preset each capture really ran is written to
  `capture.json`: the HUD is hidden with CSS only, see 4.7 item 4).
- Pass rule (`ssim.py`): SSIM ≥ min(0.995, noise SSIM − 0.002) and the worst 64 px tile ≥ noise tile-min − 0.02; the
  heat map (red = structural difference) is attached to the review. "Exact" changes (e.g. the terrain land branch)
  must stay at the noise floor; "approximate" changes (texture compression, resolution, LOD, shadow caching) need the
  owner's visual sign-off on the heat maps in addition to the numbers.
- Asset changes (KTX2, meshopt, texture caps) are also checked in isolation: `tools/perf/decode-bench.mjs` (decode,
  upload, GPU bytes) and a capture pair of a root with only the converted files swapped (as done for the F-16, KSFO and
  Golden Gate files in this study, `wt2` on :5196).
- Performance is verified with the same numbers as this study: `scenes.mjs` (per preset, per pose),
  `ab.mjs` (interleaved A/B for GPU changes on a shared GPU), `load.mjs` (network profiles), `soak.mjs` (10-minute
  flight). A change is only "done" when its measured gain is in the PR description with the command that produced it.


## 8. Release check 5d6612f vs production 94a7a5a

Owner asked before staging; answered first, summarised here. Clean worktrees of both commits with the same assets,
interleaved A/B (`ab.mjs`, variants on two servers), captures with a second production capture as the noise floor.

- **Frame time** (medians of 5 interleaved rounds, downtown / SFO / Golden Gate / cockpit): high GPU ×0.96–0.99,
  CPU ×0.99–1.02; ultra GPU ×0.93–1.03; medium GPU ×0.91–1.02. Same draw calls and triangles.
- **GPU memory** (GL-level): identical right after settling (high 1.80–2.17 GB along the pose sequence, ultra
  2.10–2.35 GB); 12 s later the new build is 170–190 MB lower at SFO (city tiles unloaded after 12 s instead of 20 s
  on high/ultra, as designed). No budget step-down on desktop.
- **Process memory**: renderer RSS 2.15–2.23 GB → 1.54–1.60 GB (−555 to −690 MB, the image release); GPU process and
  retained JS heap (278–282 MB after a forced GC) unchanged.
- **Load**: local cold 2.19–2.24 s both; 4G cold 25.09 s → 25.05 s; time to menu on 4G +0.1 s (5 new `gpu-*.js`
  modules, +17 KB).
- **Pixels** (medium, high, ultra × 9 poses, presets checked in every capture): at the noise floor. The remaining
  failing tiles are content that moves with the clock (the F-16 anti-collision strobe phase, avionics symbology and
  the DED clock), tree tiles that finished streaming in one run and not the other, and a 1-px building-edge shift in
  bird's-eye that also flips between two runs of the same commit (buildings are placed on terrain heights that depend
  on streaming order). The first high/medium captures had silently run ultra (the HUD pitfall in 4.7, item 4); they
  were redone with the presets verified.
- Verdict sent: **no regression, OK for staging** (it is live).

## 9. Tools

| file | what it does |
|---|---|
| `probe.js` | in-page probe injected before any game code: rAF CPU time per frame, WebGL2 hooks (texture/buffer upload time and bytes, compile/link stalls, draw calls, mipmap generations, live GPU bytes per texture/buffer/renderbuffer incl. block-compressed formats), long tasks, per-frame heap deltas, `hold()` to park the game loop, virtual clock + `freeze()`; after start `attach()` wraps world layers, `renderer.render`, HUD, avionics, audio, camera, rig, flight and adds EXT_disjoint_timer_query_webgl2 GPU timing (shadow pass separately) |
| `lib.mjs` | launch (GPU flags, CPU throttling, network emulation), start a flight, fixed poses, streaming settle, measurement summaries, per-layer draw calls / memory, paired GPU ablation, fragment (overdraw) report, GPU-busy / quiet wait |
| `scenes.mjs` | scene × preset matrix (+ cockpit per aircraft), optional ablation, fragments, screenshots |
| `ab.mjs` + `patches.mjs` | interleaved, randomised A/B of variants in one browser (URL/shim experiments and runtime patches) |
| `overdraw.mjs` | shaded vs visible fragments per layer (contention-free GPU work metric) |
| `soak.mjs` | 10-minute autopilot flight: series of frame/CPU/GPU/upload/alloc/heap/GPU-memory/streaming samples + a trace window (GC, layout), a CPU profile window (top functions, long-task attribution) and a heap-allocation sampling window |
| `load.mjs` + `serve-prod.mjs` | cold/warm loads through the menu under network profiles against an HTTP/2 + Brotli server with the deploy cache policy (`--revalidate` = expired cache, `--br-binary` = Brotli for .bin/.glb); Chrome trace summary per thread |
| `decode-bench.mjs` + `bench/decode-bench.html` | parse / decode / upload / compile time and GPU bytes per GLB variant |
| `exp/convert.mjs` | research converter: Draco → meshopt, textures → KTX2 (UASTC/ETC1S), for the benches |
| `exp/three-shim.js` + `exp/setup.mjs` | "three" re-export for renderer-level experiments (`?exp=nolog|revz|nomsaa`) in a scratch worktree, via `perf-exp.html` |
| `capture.mjs` + `ssim.py` + `montage.py` + `grid.py` | quality gate (section 7): frozen-time captures, SSIM / tile-min / PSNR / changed-pixel share against a noise floor, heat maps, side-by-side and multi-column review images |
| `heapcheck.mjs` | retained JS heap after a forced GC, GL-level GPU bytes and resident memory per browser process type, for comparing two builds |
| `bundle-audit.mjs` | JS module graph vs esbuild bundle; writes the modulepreload list |
| `assets-audit.mjs` | bytes, glTF encodings, texture sizes → GPU MB, Brotli/gzip savings per asset family |
| `field.py` | aggregated field data from the downloaded CloudFront logs (platform mix, flight-start share, CDN egress by type, terrain pack fills); prints no IPs or ids |
| `report.mjs` | markdown tables from the JSON results |
| `probe-env.mjs` | WebGL extensions / scene graph / 404s of the running game |

Typical session: `node tools/serve.mjs 5195` in a clean worktree of the commit to measure (see the header of `lib.mjs`),
then e.g. `node tools/perf/scenes.mjs --presets high --poses downtown-300 --quiet 30`. Tools that need esbuild,
glTF-Transform, meshoptimizer, ktx2-encoder or sharp load them from `PERF_NODE_MODULES` (not repo dependencies:
`npm i --prefix <dir> esbuild @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer
draco3dgltf ktx2-encoder sharp`, then `PERF_NODE_MODULES=<dir>/node_modules`). Worktrees for clean baselines:
`git worktree add --detach <scratch>/wt <commit>` + `cp -c -R assets renders node_modules <scratch>/wt/` +
`node tools/serve.mjs 5195` there; for load tests `node tools/deploy/build_dist.mjs` in the worktree and
`node tools/perf/serve-prod.mjs --root <scratch>/wt/dist`.

