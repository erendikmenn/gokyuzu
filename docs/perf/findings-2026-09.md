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
