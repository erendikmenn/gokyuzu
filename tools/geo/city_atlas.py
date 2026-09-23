"""W2 city: pack the Cycles-rendered facade/roof cells (blender/city/facade_atlas.py) into the 4K atlas images.

  .venv/bin/python tools/geo/city_atlas.py [--cell 512]

Inputs : assets/sf/city/atlas/cells/<name>_{albedo,data,win,normal}.png + cells.json
Outputs: assets/sf/city/atlas/atlas_albedo.jpg   RGB albedo (sRGB, sky occlusion baked)
         assets/sf/city/atlas/atlas_mat.png      R = tint mask, G = roughness, B = window light mask   (linear)
         assets/sf/city/atlas/atlas_nrm.png      R,G = tangent normal xy, B = metalness                  (linear)
         assets/sf/city/atlas/atlas.json         grid, cell size and per-layer metadata (name, kind, W, H, floors)
The runtime splits the 8x8 grid into texture-array layers (one layer per cell) so each cell can tile with REPEAT.
"""
import json, os, sys
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ADIR = os.path.join(ROOT, 'assets', 'sf', 'city', 'atlas')
CDIR = os.path.join(ADIR, 'cells')


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
    to8(alb).save(os.path.join(ADIR, 'atlas_albedo.jpg'), quality=92, subsampling=0)
    to8(mat).save(os.path.join(ADIR, 'atlas_mat.png'), optimize=True)
    to8(nrm).save(os.path.join(ADIR, 'atlas_nrm.png'), optimize=True)
    meta = {'grid': grid, 'cell': cell, 'size': size, 'layers': layers,
            'images': {'albedo': 'atlas_albedo.jpg', 'mat': 'atlas_mat.png', 'nrm': 'atlas_nrm.png'},
            'channels': {'albedo': 'rgb albedo (sRGB)', 'mat': 'r tint mask, g roughness, b window light mask',
                         'nrm': 'rg tangent normal (x right, y up), b metalness'}}
    json.dump(meta, open(os.path.join(ADIR, 'atlas.json'), 'w'), indent=1)
    for f in ('atlas_albedo.jpg', 'atlas_mat.png', 'atlas_nrm.png'):
        print(f, os.path.getsize(os.path.join(ADIR, f)) // 1024, 'KB')


if __name__ == '__main__':
    main()
