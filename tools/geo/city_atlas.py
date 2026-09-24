"""W2 city: pack the Cycles-rendered facade/roof cells (blender/city/facade_atlas.py) into the 4K atlas images.

  .venv/bin/python tools/geo/city_atlas.py [--cell 512]
  GEO_REGION=ist .venv/bin/python tools/geo/city_atlas.py    (other maps: San Francisco's atlas, copied - same cells,
                                                              same texture memory; the maps differ in tints / styles)

Inputs : data/sf/cache/city/atlas_cells/<name>_{albedo,data,win,normal}.png + cells.json
Outputs: assets/sf/city/atlas/atlas_albedo.webp  RGB albedo (sRGB, sky occlusion baked)
         assets/sf/city/atlas/atlas_mat.webp     R = tint mask, G = roughness, B = window light mask   (linear)
         assets/sf/city/atlas/atlas_nrm.webp     R,G = tangent normal xy, B = metalness                  (linear)
         assets/sf/city/atlas/atlas.json         grid, cell size and per-layer metadata (name, kind, W, H, floors)
The runtime splits the 8x8 grid into texture-array layers (one layer per cell) so each cell can tile with REPEAT.
"""
import json, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from city_paths import ROOT, OUT, CACHE, REGION_ID  # noqa: E402

ADIR = os.path.join(OUT, 'atlas')
CDIR = os.path.join(CACHE, 'atlas_cells')


def copy_sf_atlas():
    import shutil
    src = os.path.join(ROOT, 'assets', 'sf', 'city', 'atlas')
    os.makedirs(ADIR, exist_ok=True)
    for f in ('atlas.json', 'atlas_albedo.webp', 'atlas_mat.webp', 'atlas_nrm.webp'):
        shutil.copy2(os.path.join(src, f), os.path.join(ADIR, f))
        print('copied', f)


def load(path, size, mode='RGB', resample=Image.LANCZOS):
    im = Image.open(path).convert(mode)
    return np.asarray(im.resize((size, size), resample), dtype=np.float32) / 255.0


def main():
    cell = 512
    if '--cell' in sys.argv:
        cell = int(sys.argv[sys.argv.index('--cell') + 1])
    cells = json.load(open(os.path.join(CDIR, 'cells.json')))
    grid = 8
    size = grid * cell
    alb = np.zeros((size, size, 3), np.float32)
    mat = np.zeros((size, size, 3), np.float32)
    nrm = np.zeros((size, size, 3), np.float32)
    nrm[..., :2] = 0.5
    layers = []
    for i, c in enumerate(cells):
        gx, gy = i % grid, i // grid
        sl = (slice(gy * cell, (gy + 1) * cell), slice(gx * cell, (gx + 1) * cell))
        base = os.path.join(CDIR, c['name'])
        a = load(base + '_albedo.png', cell)
        d = load(base + '_data.png', cell, resample=Image.BILINEAR)
        w = load(base + '_win.png', cell, 'L', resample=Image.BILINEAR)
        n = load(base + '_normal.png', cell, resample=Image.BILINEAR)
        n = n * 2 - 1
        n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
        # the cells are rendered with a uniform white sky (albedo x occlusion); real facade albedos are lower than the
        # painted-white modules suggest, so facades/ground floors are scaled down to keep the city from looking washed out
        alb[sl] = a * (0.84 if c['kind'] != 'roof' else 1.0)
        mat[sl] = np.stack([d[..., 0], d[..., 1], w], -1)
        nrm[sl] = np.stack([n[..., 0] * 0.5 + 0.5, n[..., 1] * 0.5 + 0.5, d[..., 2]], -1)
        layers.append({'index': i, 'name': c['name'], 'kind': c['kind'], 'W': c['W'], 'H': c['H'], 'floors': c['floors']})
    to8 = lambda x: Image.fromarray(np.clip(x * 255 + 0.5, 0, 255).astype(np.uint8))
    # lossy WebP: ~1.6 MB for all three 4K maps (was 10 MB as JPEG + PNG); data maps at q95 (masks/normals tolerate
    # the 4:2:0 chroma of VP8 at 1.2 cm/px)
    to8(alb).save(os.path.join(ADIR, 'atlas_albedo.webp'), 'WEBP', quality=92, method=6)
    to8(mat).save(os.path.join(ADIR, 'atlas_mat.webp'), 'WEBP', quality=95, method=6)
    to8(nrm).save(os.path.join(ADIR, 'atlas_nrm.webp'), 'WEBP', quality=95, method=6)
    for old in ('atlas_albedo.jpg', 'atlas_mat.png', 'atlas_nrm.png'):
        if os.path.exists(os.path.join(ADIR, old)):
            os.remove(os.path.join(ADIR, old))
    meta = {'grid': grid, 'cell': cell, 'size': size, 'layers': layers,
            'images': {'albedo': 'atlas_albedo.webp', 'mat': 'atlas_mat.webp', 'nrm': 'atlas_nrm.webp'},
            'channels': {'albedo': 'rgb albedo (sRGB)', 'mat': 'r tint mask, g roughness, b window light mask',
                         'nrm': 'rg tangent normal (x right, y up), b metalness'}}
    json.dump(meta, open(os.path.join(ADIR, 'atlas.json'), 'w'), indent=1)
    for f in ('atlas_albedo.webp', 'atlas_mat.webp', 'atlas_nrm.webp'):
        print(f, os.path.getsize(os.path.join(ADIR, f)) // 1024, 'KB')


if __name__ == '__main__':
    if REGION_ID != 'sf':
        copy_sf_atlas()
    else:
        main()
