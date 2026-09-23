"""W3 landmarks: terrain/imagery context patches for the Cycles hero renders and for calibrating landmark heights.

Reads (read-only) the USGS 3DEP DEM and NAIP imagery tiles cached by W1 under data/sf/raw/3dep and data/sf/raw/naip,
and writes stitched patches to data/sf/cache/landmarks/<name>_dem.npy (float32, row 0 = north / min z) and
<name>_img.jpg, plus <name>.json with the local bounds.

Usage:
  .venv/bin/python tools/geo/landmarks_context.py patch <name> x0 z0 x1 z1 dem_res img_res
  .venv/bin/python tools/geo/landmarks_context.py sample x,z x,z ...        (prints ground heights)
"""
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from geo import ROOT  # noqa: E402

RAW = os.path.join(ROOT, 'data', 'sf', 'raw')
CACHE = os.path.join(ROOT, 'data', 'sf', 'cache', 'landmarks')
CORE = dict(x0=-17408.0, x1=21504.0, z0=-29696.0, z1=8192.0)
MID = dict(x0=-30720.0, x1=34816.0, z0=-43008.0, z1=22528.0)
FAR_MIN = (-63488.0, -75776.0)

_dem_cache = {}


def _dem_tile(kind, i, j):
    key = (kind, i, j)
    if key not in _dem_cache:
        import rasterio
        p = os.path.join(RAW, '3dep', kind, f'{i}_{j}.tif')
        if not os.path.exists(p):
            _dem_cache[key] = None
        else:
            with rasterio.open(p) as ds:
                a = ds.read(1).astype(np.float32)
            a[a < -1000] = np.nan
            _dem_cache[key] = a
    return _dem_cache[key]


def dem_at(x, z):
    """Bilinear ground height from the 2 m core DEM (falls back to the 16 m far DEM)."""
    for kind, res, px, (ox, oz) in (('core2', 2.0, 2048, (CORE['x0'], CORE['z0'])), ('far16', 16.0, 2048, FAR_MIN)):
        span = res * px
        # sample centers at ox + k*res (tile bbox shifted by half a pixel)
        fx = (x - ox) / res
        fz = (z - oz) / res
        i, j = int(fx // px), int(fz // px)
        a = _dem_tile(kind, i, j)
        if a is None:
            continue
        cx, cz = fx - i * px, fz - j * px
        c0, r0 = int(np.floor(cx)), int(np.floor(cz))
        c0 = min(max(c0, 0), px - 2)
        r0 = min(max(r0, 0), px - 2)
        tx, tz = cx - c0, cz - r0
        # row 0 of the tif = north = min z
        v = (a[r0, c0] * (1 - tx) * (1 - tz) + a[r0, c0 + 1] * tx * (1 - tz) + a[r0 + 1, c0] * (1 - tx) * tz + a[r0 + 1, c0 + 1] * tx * tz)
        if np.isfinite(v):
            return float(v)
    return float('nan')


def dem_grid(x0, z0, x1, z1, res):
    xs = np.arange(x0, x1 + 1e-6, res)
    zs = np.arange(z0, z1 + 1e-6, res)
    out = np.zeros((len(zs), len(xs)), np.float32)
    for r, z in enumerate(zs):
        for c, x in enumerate(xs):
            out[r, c] = dem_at(x, z)
    return out


def dem_grid_fast(x0, z0, x1, z1, res):
    """Resample the core DEM by stitching the needed tiles and using scipy map_coordinates."""
    from scipy.ndimage import map_coordinates
    xs = np.arange(x0, x1 + 1e-6, res)
    zs = np.arange(z0, z1 + 1e-6, res)
    X, Z = np.meshgrid(xs, zs)
    out = np.full(X.shape, np.nan, np.float32)
    for kind, tres, px, (ox, oz) in (('far16', 16.0, 2048, FAR_MIN), ('core2', 2.0, 2048, (CORE['x0'], CORE['z0']))):
        fx = (X - ox) / tres
        fz = (Z - oz) / tres
        i0, i1 = int(np.floor(fx.min() / px)), int(np.floor(fx.max() / px))
        j0, j1 = int(np.floor(fz.min() / px)), int(np.floor(fz.max() / px))
        big = np.full(((j1 - j0 + 1) * px, (i1 - i0 + 1) * px), np.nan, np.float32)
        have = False
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                a = _dem_tile(kind, i, j)
                if a is not None:
                    big[(j - j0) * px:(j - j0 + 1) * px, (i - i0) * px:(i - i0 + 1) * px] = a
                    have = True
        if not have:
            continue
        cz = fz - j0 * px
        cx = fx - i0 * px
        filled = np.where(np.isnan(big), -9999.0, big)
        v = map_coordinates(filled, [cz.ravel(), cx.ravel()], order=1, mode='nearest').reshape(X.shape)
        v[v < -1000] = np.nan
        out = np.where(np.isnan(v), out, v)
    return out


def img_patch(x0, z0, x1, z1, res):
    """Stitch NAIP imagery (core 1 m, else mid 4 m) into an RGB array covering the bounds at `res` m/px."""
    from PIL import Image
    from scipy.ndimage import map_coordinates
    xs = np.arange(x0 + res / 2, x1, res)
    zs = np.arange(z0 + res / 2, z1, res)
    X, Z = np.meshgrid(xs, zs)
    out = np.zeros(X.shape + (3,), np.float32)
    got = np.zeros(X.shape, bool)
    for kind, tres, px, (ox, oz) in (('mid4', 4.0, 2048, (MID['x0'], MID['z0'])), ('core1', 1.0, 2048, (CORE['x0'], CORE['z0']))):
        if kind == 'core1' and res > 3:
            continue
        fx = (X - ox) / tres - 0.5
        fz = (Z - oz) / tres - 0.5
        i0, i1 = int(np.floor(fx.min() / px)), int(np.floor(fx.max() / px))
        j0, j1 = int(np.floor(fz.min() / px)), int(np.floor(fz.max() / px))
        big = np.zeros(((j1 - j0 + 1) * px, (i1 - i0 + 1) * px, 3), np.float32)
        mask = np.zeros(big.shape[:2], np.float32)
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                p = os.path.join(RAW, 'naip', kind, f'{i}_{j}.jpg')
                if not os.path.exists(p):
                    continue
                im = np.asarray(Image.open(p).convert('RGB'), np.float32) / 255.0
                h, w = im.shape[:2]
                big[(j - j0) * px:(j - j0) * px + h, (i - i0) * px:(i - i0) * px + w] = im
                mask[(j - j0) * px:(j - j0) * px + h, (i - i0) * px:(i - i0) * px + w] = 1
        cz = (fz - j0 * px).ravel()
        cx = (fx - i0 * px).ravel()
        m = map_coordinates(mask, [cz, cx], order=0, mode='constant').reshape(X.shape) > 0.5
        for c in range(3):
            v = map_coordinates(big[:, :, c], [cz, cx], order=1, mode='nearest').reshape(X.shape)
            out[:, :, c] = np.where(m, v, out[:, :, c])
        got |= m
    return out, got


def main():
    cmd = sys.argv[1]
    if cmd == 'sample':
        for a in sys.argv[2:]:
            x, z = map(float, a.split(','))
            print(f'{x:.1f},{z:.1f}: {dem_at(x, z):.2f}')
    elif cmd == 'patch':
        name = sys.argv[2]
        x0, z0, x1, z1, dres, ires = map(float, sys.argv[3:9])
        os.makedirs(CACHE, exist_ok=True)
        dem = dem_grid_fast(x0, z0, x1, z1, dres)
        dem = np.where(np.isnan(dem), -5.0, dem)
        np.save(os.path.join(CACHE, f'{name}_dem.npy'), dem.astype(np.float32))
        img, got = img_patch(x0, z0, x1, z1, ires)
        from PIL import Image
        Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(os.path.join(CACHE, f'{name}_img.jpg'), quality=92)
        json.dump({'x0': x0, 'z0': z0, 'x1': x1, 'z1': z1, 'dem_res': dres, 'img_res': ires, 'dem_shape': list(dem.shape),
                   'img_shape': list(img.shape[:2])}, open(os.path.join(CACHE, f'{name}.json'), 'w'))
        print(name, 'dem', dem.shape, f'{np.nanmin(dem):.1f}..{np.nanmax(dem):.1f}', 'img', img.shape, f'coverage {got.mean():.2f}')


def devctx(x0=-16400.0, z0=-28000.0, x1=8200.0, z1=-13600.0, res=20.0, img_res=8.0):
    """Heightfield (uint16 decimeters + 100 m offset) + aerial JPEG for dev/landmarks.html (not used by the game)."""
    from PIL import Image
    out = os.path.join(ROOT, 'assets', 'sf', 'landmarks', 'dev')
    os.makedirs(out, exist_ok=True)
    dem = dem_grid_fast(x0, z0, x1, z1, res)
    dem = np.where(np.isnan(dem), -2.0, dem)
    q = np.clip((dem + 100.0) * 10.0, 0, 65535).astype('<u2')
    q.tofile(os.path.join(out, 'height_u16.bin'))
    img, got = img_patch(x0, z0, x1, z1, img_res)
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(os.path.join(out, 'aerial.jpg'), quality=85)
    meta = {'x0': x0, 'z0': z0, 'x1': x1, 'z1': z1, 'res': res, 'w': int(dem.shape[1]), 'h': int(dem.shape[0]),
            'encoding': 'uint16 LE, h = v/10 - 100, row 0 = z0 (north)', 'img': 'aerial.jpg'}
    json.dump(meta, open(os.path.join(out, 'context.json'), 'w'))
    print('devctx', dem.shape, img.shape, f'{dem.min():.1f}..{dem.max():.1f}')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'devctx':
        devctx()
    else:
        main()
