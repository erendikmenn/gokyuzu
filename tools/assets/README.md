# tools/assets: KTX2 textures for the exported GLBs

Post-processing step for the GLBs the Blender scripts export (aircraft exterior / cockpit / LOD, landmarks, airport
buildings). It replaces their embedded JPEG / PNG / WebP textures with KTX2 (Basis Universal, `KHR_texture_basisu`):
block-compressed on the GPU (0.5–1 byte per texel instead of 4, uploads in about a millisecond instead of 100–400 ms)
and about as small to download as the JPEGs. Geometry (Draco / meshopt) is copied byte for byte.

## Setup (once, no Homebrew, no admin rights)

```sh
node tools/assets/setup.mjs
```

Installs the npm packages of `tools/assets/package.json` (sharp, ktx-parse, ktx2-encoder for its WebAssembly Basis
transcoder, gltf-validator) and the Khronos **KTX-Software 4.4.2** `ktx` tool (the Basis Universal encoder: native,
multithreaded, no source size limit) from its pinned GitHub release, SHA-256 checked, into `tools/assets/.bin/`
(macOS `.pkg` expanded with `pkgutil`, Linux `.tar.bz2`; nothing is installed system-wide). The WebAssembly encoder of
npm `ktx2-encoder` was tried first: it refuses sources above 12 Mpix, and the 4096² textures have to stay 4096² (below).

## Run

```sh
node tools/assets/textures.mjs              # after any Blender export: converts what changed (encodes are cached)
node tools/assets/textures.mjs --check      # exit 1 if a GLB is unconverted / out of date (publish build)
node tools/assets/textures.mjs --dry        # print the plan
node tools/assets/textures.mjs --report r.json   # per-texture codec, sizes, PSNR / SSIM against the source
node tools/assets/textures.mjs --restore    # put the exported originals back (see "Blender" below)
node tools/assets/check.mjs --base http://localhost:5173/   # every converted GLB in Chromium, WebKit and an iPhone
                                                              # profile, transcoder forced to ASTC / BC7 / ETC2 / ETC1 /
                                                              # BC1-3 / RGBA: 0 GL errors, 0 console errors
```

In place and idempotent: the exported file is kept as `<dir>/_orig/<name>.glb` (never published: `build_dist` skips
`_` directories), the converted GLB records the policy it was made with, and a policy change re-encodes from `_orig`.
Outputs besides the GLBs:

- `assets/sf/airports/shared/*.ktx2`: facade / roof textures used by several airports, referenced by URI, loaded
  once per page by `src/core/assets.js` (one download, one GPU copy instead of up to three).
- `<name>.phone.glb` + `assets/phone-variants.json`: GLBs with textures larger than 1024² get a copy with those
  textures cut to 1024² (top mip levels dropped, no re-encoding). Phones cap textures at 1024² anyway, so they load
  the variant (`src/core/assets.js`), e.g. the F-16 exterior 5.1 → 1.7 MB.

## Policy (`lib/policy.mjs`), measured in the game

- **No build-time downscale.** A 2048² cap was visible in the game's own wing camera (F-16 panel lines) and on a
  cockpit panel seen from the pilot's eye (labels softer); a 4096² KTX2 texture takes the memory a 2048² RGBA one took.
- **ETC1S first** for colour and data maps, accepted when the decoded texture passes a gate (PSNR / SSIM / worst tile).
  ETC1S at full size kept cockpit labels sharper than UASTC at half size, and is about JPEG-sized; UASTC at 4096² would
  make aircraft files 3–4× larger. Data maps need a clean worst tile (an ETC1S metal/roughness map at 33 dB changed a
  wing's sheen).
- **UASTC** (+ zstd 19, mild RDO only while it stays above a quality floor) for normal maps and whatever fails the gate.
- Box-filtered mips (what the GPU's `generateMipmap` did for the originals), sRGB transfer for colour, linear for data.
- World textures whose KTX2 would be > 4× the source and > 256 KB larger stay as they are (noisy landmark normal maps).

## Runtime (`src/core/`)

- `gpu-textures.js`: KTX2 textures are capped by dropping top mip levels; phones and tablets get 2 × `textureMaxSize`
  (same memory, twice the side: phone 1024 instead of 512), desktop classes keep `textureMaxSize` (same look); the
  transcoded CPU copy is released after upload like decoded images.
- `assets.js`: shared KTX2 files load once; phones load `.phone.glb` variants.
- `gpu-meter.js`: counts block-compressed formats at their real size (they were counted as 4 bytes per texel).

## Blender re-imports

`blender/airports/render_scene.py` and `blender/landmarks/render.py` import the GLBs for renders; Blender cannot read
KTX2 textures. Run `--restore` before such a render session (or point it at `_orig/<name>.glb`) and the converter again
afterwards. A fresh export simply overwrites the converted GLB; the next run converts it again.

# Runtime packs (streaming): `packs.mjs`, `city_meshopt.mjs`

Lighter or merged copies of published map files, written next to the originals (never replacing them) and listed in
`assets/<map>/packs.json`, which the game reads at start (`src/world-sf/index.js` → `ctx.packs`). A layer uses a pack
entry when it is there and falls back to the original files otherwise; paths are relative to `assets/<map>/`, and a map
whose sources are byte-identical to another map's (İstanbul copies San Francisco's atlas, tree models and airport
ground textures) points at that map's pack files (one download, one cache entry for players of both maps).

```sh
node tools/assets/packs.mjs              # water depth, atlas, tree models, thinned tree tiles, airport ground (both maps)
node tools/assets/city_meshopt.mjs --map sf --verify   # San Francisco city tiles Draco → meshopt (3513 tiles, ~1.5 min)
node tools/assets/packs.mjs --check      # exit 1 when a pack's sources changed since it was written
node tests/packs.test.mjs                # structure, sizes, tree subsets, meshopt tile coverage
```

Re-run after a terrain rebuild (`water_depth.png`), a city rebuild (atlas, tree models, tree tiles, San Francisco
tiles) or new airport ground textures.

| entry | files | who loads it | why |
|---|---|---|---|
| `terrain.waterDepthSmall` / `waterDepthTiny` | `terrain/packs/water_depth_2048.png`, `_1024.png` | tablets / phones | the bathymetry's mip 1 / mip 2 (box filter): 85 → 21 / 5 MB of GPU memory, 1.4 → 0.3 / 0.1 MB download |
| `city.atlasSmall` / `atlasTiny` | `city/packs/atlas_256/`, `atlas_128/` | tablets / phones | facade atlas cells 256² / 128² (2×2 / 4×4 box filter inside each cell = the cells' mip 1 / 2): 3 × 49 → 3 × 12 / 3 × 3 MB of GPU memory; WebP q95 (material map near-lossless: its channels are independent data) |
| `city.trees` | `city/packs/trees/species_lod1.glb`, `species_lod0.glb` | every class | the 9 species' far LODs in one file with each texture once (6.6 MB in 9 files → 0.9 MB), near LODs in a second file loaded when a tree comes within the near range (phones / tablets) or 3 s later (others); textures the far file has are bound at runtime (material extras `packShared`). Geometry: Draco, SEQUENTIAL, finer quantization than the sources (positions, normals, colours exact, uv within 1e-4); PNG textures as lossless WebP with `exact` (identical texels) |
| `city.treesLow` | `city/packs/trees_d30/`, `trees_d50/` | tree density ≤ 0.3 / ≤ 0.5 (phones, low preset / tablets) | tiles holding only the trees that density draws: per 250 m bin the first `max(1, round(n × d))` by the rotation byte, the subset `city_trees.js` keeps from a full tile (tests/packs.test.mjs checks it): −70 / −50 % of the tree bytes |
| `airports.groundMobile` | `packs/airport-ground-1024/` | phones / tablets | the 2048² runway / taxiway / apron JPEGs at 1024² (lanczos, q92 4:4:4), the size those classes upload anyway: 2.9 → 0.9 MB at their start |
| `terrain.pins` | `terrain/packs/pins/index.json` + `<cell>.bin` | every class | `pins.bin` split per 2 km cell (each cell file carries its ancestor tiles): the start loads the spawn's cells (SFO 1.4 instead of 4.1 MB, LTFM 0.6 instead of 2.8 MB), the rest near the camera (phones / tablets within 8 km, others all in the background); city tiles wait for their cell |
| `prewarm` | `packs/prewarm.glb` | every class | one hidden 1-triangle stand-in per shader variant of the materials that only appear after the start (near tree LODs, airport buildings, parked-aircraft LODs, landmark LODs; placeholder 4×4 textures, 20–35 KB): the loading screen's pre-warm links their programs, so none links in flight (WebKit links synchronously: iPad freezes) |
| `city.tiles` | `city/packs/meshopt/l0…l3/` | every class (San Francisco) | `city_meshopt.mjs`: the Draco tiles in İstanbul's tile format (EXT_meshopt_compression + KHR_mesh_quantization, exponential filter, vertex cache / fetch order): decode 10–30× cheaper (Draco was 70 ms per tile on an M4 Max, 0.5 s with the CPU at 4×), −8–15 % on the wire under the edge's Brotli / gzip; every tile verified against its Draco source (`--verify`: positions ≤ 0.8 / 3 / 12.5 cm at L0 / L1 / L2+, same triangles) |
