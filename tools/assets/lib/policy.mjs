// Which GLBs get KTX2 textures, and how each texture is encoded. Changing anything that changes the output bytes
// must bump PIPELINE_VERSION (converted GLBs record it and are re-encoded from their _orig/ copy on the next run).
export const PIPELINE_VERSION = 6;

/**
 * Largest texture side kept (sources are ≤ 4096 by the Blender contract, so nothing is downscaled at build time).
 * A 2048 build cap was measured visible in the game's own wing camera (F-16 panel lines, SSIM tile 0.70): the memory
 * a 2048 cap was meant to save comes from block compression instead (a 4096² KTX2 texture takes what a 2048² RGBA
 * one took), and memory-limited devices drop the top mip levels at load (src/core/gpu-textures.js).
 */
export const MAX_SIZE = 4096;

/**
 * Phone variants: every converted GLB with a texture larger than this also gets <name>.phone.glb, the same file with
 * those textures cut to this size by dropping their top mip levels (no re-encoding), listed in
 * assets/phone-variants.json; phones load it instead (src/core/assets.js). 1024 = 2 × the phone class texture cap
 * (DEVICE_CAPS.phone.textureMaxSize 512 in src/core/quality.js; block compression fits 2× the side in the same memory).
 */
export const PHONE_SIZE = 1024;
export const PHONE_MANIFEST = 'assets/phone-variants.json';

/** Images smaller than this (texels) stay as they are: no memory to win, and the KTX2 container costs more bytes. */
export const MIN_TEXELS = 128 * 128;

/**
 * Encoding profiles. Both keep every texture at its own size and try ETC1S first (≈ JPEG-sized files, 0.5–1 byte per
 * texel on the GPU): measured in the game's closest views (wing camera, a cockpit panel from the pilot's eye), ETC1S
 * at full size keeps labels and panel lines sharper than UASTC at half size, and UASTC at full size would make the
 * files 3–4× larger than today's JPEGs. A texture whose decoded ETC1S version fails ETC1S_GATE goes to UASTC with RDO
 * (kept only when it stays above the profile's floor, else plain UASTC). Normal maps are always UASTC.
 *   hero   the flown aircraft (exterior + cockpit): RDO λ 0.5, floor PSNR 48 dB; normals λ 0.5, angle error p99 ≤ 4.5°
 *   world  aircraft LODs (parked copies), airport buildings, landmarks: RDO λ 1, floor PSNR 44 dB; normals λ 0.75,
 *          mean angle error ≤ 1.2°
 */
export const PROFILES = {
  hero: { colour: 'auto', data: 'auto', rdo: 0.5, floor: { psnr: 48, tileMin: 0.985 }, normalRdo: 0.5, normalFloor: { angMean: 0.5, angP99: 4.5 } },
  world: { colour: 'auto', data: 'auto', rdo: 1, floor: { psnr: 44, tileMin: 0.97 }, normalRdo: 0.75, normalFloor: { angMean: 1.2, angP99: 6 } },
};

/**
 * Asset families. `dir` is scanned for *.glb (depth 2 for aircraft: assets/aircraft/<id>/*.glb); build inputs
 * (`_*`, `tex`, `src`, `render`, `dev` …) are never touched.
 *   profile  (file name) → 'hero' | 'world'
 *   share    textures used by several GLBs of the family are written once to <dir>/shared/<name>.ktx2 and referenced
 *            by URI (one download, one GPU copy through the loader's KTX2 cache, src/core/assets.js)
 */
export const FAMILIES = [
  { id: 'aircraft', dir: 'assets/aircraft', depth: 2, profile: (f) => (/_lod\.glb$/.test(f) ? 'world' : 'hero') },
  { id: 'airports', dir: 'assets/sf/airports', depth: 1, profile: () => 'world', share: true },
  { id: 'landmarks', dir: 'assets/sf/landmarks', depth: 1, profile: () => 'world' },
];

/**
 * Encoder settings (KTX-Software `ktx create`): UASTC effort 2 of 4 + zstd 19; ETC1S (BasisLZ) quality 255, effort 3.
 * Mip levels use a box filter, like the GPU's generateMipmap did for the JPEG / PNG / WebP originals (a sharper
 * lanczos chain changed distant views slightly).
 */
export const UASTC = { mode: 'uastc', uastcLevel: 2, mipFilter: 'box' };
export const ETC1S = { mode: 'etc1s', etc1sQuality: 255, etc1sEffort: 3, mipFilter: 'box' };

/**
 * ETC1S is accepted for a colour / data map when its decoded level 0 stays this close to the source (RGB PSNR, luma
 * SSIM, worst 64×64 tile SSIM). Calibrated with in-game captures, not texture statistics alone: SSIM punishes any
 * change of film grain / noise that the eye does not see, so the colour gates mostly guard against broken results.
 *   hero colour   F-16 skin (40 dB) and cockpit panel atlas (41 dB) matched the originals in the wing camera and a
 *                 panel close-up from the pilot's eye (labels as sharp as the 4096² JPEG)
 *   world colour  airport facades down to 32 dB (gravel roof) looked identical from the SFO tower / terminal poses
 *   data          a metal/roughness map at 33 dB / worst tile 0.86 visibly changed a parked B737's wing sheen
 */
export const ETC1S_GATE = {
  hero: { color: { psnr: 37, ssim: 0.98, tileMin: 0.88 }, data: { psnr: 38, ssim: 0.985, tileMin: 0.95 } },
  world: { color: { psnr: 30, ssim: 0, tileMin: 0 }, data: { psnr: 38, ssim: 0.985, tileMin: 0.95 } },
};

/**
 * Download guard (world profile): a texture whose KTX2 would be > 4× its source and > 256 KB larger stays in its
 * source format (e.g. noisy landmark normal maps: 120 KB WebP → 770 KB UASTC for 4 MB of GPU memory).
 */
export const GROWTH_GUARD = { world: { ratio: 4, bytes: 256 * 1024 } };
export function tooBig(profile, srcBytes, outBytes) {
  const g = GROWTH_GUARD[profile];
  return !!g && outBytes > g.ratio * srcBytes && outBytes - srcBytes > g.bytes;
}

export function etc1sAcceptable(profile, kind, q) {
  const g = ETC1S_GATE[profile][kind];
  return !!g && q.psnr >= g.psnr && q.ssim >= g.ssim && q.tileMin >= g.tileMin;
}
export function uastcAcceptable(profile, kind, q) {
  const p = PROFILES[profile];
  if (kind === 'normal') return q.angMean <= p.normalFloor.angMean && q.angP99 <= p.normalFloor.angP99;
  return q.psnr >= p.floor.psnr && q.tileMin >= p.floor.tileMin;
}
