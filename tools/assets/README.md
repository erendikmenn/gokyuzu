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
