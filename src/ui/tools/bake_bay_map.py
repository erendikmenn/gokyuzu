#!/usr/bin/env python3
"""Bake the stylised Bay Area map used by the menu (spawn map) and the HUD minimap base layer.

Reads W1's terrain build (assets/sf/terrain: index.json, h/<level>.bin height+water tiles, img/<level>/<i>_<j>.webp
NAIP imagery) and writes src/ui/assets/bay-map.jpg covering data/sf/region.json's local bounds, north up
(+x → right, +z → down), plus bay-map.json with the bounds / meters-per-pixel.

Look: desaturated, darkened aerial imagery with hillshade, deep navy water with a lighter shelf near the shore and a
thin coastline — so it sits well inside the dark glass UI. Re-run whenever the terrain assets change:
    .venv/bin/python src/ui/tools/bake_bay_map.py
"""
import json
import os
import struct

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
TER = os.path.join(ROOT, 'assets', 'sf', 'terrain')
OUT_DIR = os.path.join(ROOT, 'src', 'ui', 'assets')
MPP = 24.0          # output meters per pixel
WORK = 8.0          # working resolution for the imagery mosaic (m/px)
IMG_LEVEL = 6       # 2048 m nodes, 512 px → 4 m/px
H_LEVEL = 7         # 1024 m nodes, 64 quads → 16 m height/water samples


def load_index():
    with open(os.path.join(TER, 'index.json')) as f:
        return json.load(f)


def level_tiles(idx, level):
    """(i, j) → tile ordinal within h/<level>.bin, plus node flags."""
    out = {}
    k = 0
    for n in idx['nodes']:
        if n[0] != level:
            continue
        out[(n[1], n[2])] = (k, n)
        k += 1
    return out


def read_tile(fh, ordinal, tile_bytes):
    fh.seek(ordinal * tile_bytes)
    buf = fh.read(tile_bytes)
    hmin, scale = struct.unpack('<ff', buf[:8])
    n = 67 * 67
    v = np.frombuffer(buf[8:8 + n * 2], dtype='<u2').astype(np.float32).reshape(67, 67)
    h = hmin + v * scale
    wbits = np.frombuffer(buf[8 + n * 2:], dtype=np.uint8)
    w = np.unpackbits(wbits)[:n].reshape(67, 67).astype(bool)
    return h, w


def main():
    idx = load_index()
    with open(os.path.join(ROOT, 'data', 'sf', 'region.json')) as f:
        region = json.load(f)['local']
    minX, maxX, minZ, maxZ = region['minX'], region['maxX'], region['minZ'], region['maxZ']
    rootSize, rx0, rz0 = idx['rootSize'], idx['rootMinX'], idx['rootMinZ']
    tile_bytes = idx['tileBytes']

    # ---------- heights + water on a 16 m grid ----------
    size = rootSize / (1 << H_LEVEL)
    d = size / 64
    W = int(np.ceil((maxX - minX) / d)) + 1
    D = int(np.ceil((maxZ - minZ) / d)) + 1
    H = np.zeros((D, W), np.float32)
    WAT = np.ones((D, W), bool)
    tiles = level_tiles(idx, H_LEVEL)
    i0, i1 = int((minX - rx0) // size), int((maxX - rx0) // size)
    j0, j1 = int((minZ - rz0) // size), int((maxZ - rz0) // size)
    with open(os.path.join(TER, 'h', f'{H_LEVEL}.bin'), 'rb') as fh:
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                t = tiles.get((i, j))
                if not t:
                    continue
                h, w = read_tile(fh, t[0], tile_bytes)
                x0, z0 = rx0 + i * size, rz0 + j * size
                # interior samples 1..65 cover x0..x0+size
                gx0 = int(round((x0 - minX) / d)); gz0 = int(round((z0 - minZ) / d))
                for (src, dst) in ((h[1:66, 1:66], H), (w[1:66, 1:66], WAT)):
                    sx0, sz0 = max(0, -gx0), max(0, -gz0)
                    ex, ez = min(65, W - gx0), min(65, D - gz0)
                    if ex <= sx0 or ez <= sz0:
                        continue
                    dst[gz0 + sz0:gz0 + ez, gx0 + sx0:gx0 + ex] = src[sz0:ez, sx0:ex]
    print('height grid', H.shape, 'range', float(H.min()), float(H.max()), 'water', float(WAT.mean()))

    # ---------- imagery mosaic at WORK m/px ----------
    isize = rootSize / (1 << IMG_LEVEL)
    tpx = int(round(isize / WORK))
    MW = int(np.ceil((maxX - minX) / WORK))
    MD = int(np.ceil((maxZ - minZ) / WORK))
    mosaic = Image.new('RGB', (MW, MD), (20, 30, 40))
    ii0, ii1 = int((minX - rx0) // isize), int((maxX - rx0) // isize)
    jj0, jj1 = int((minZ - rz0) // isize), int((maxZ - rz0) // isize)
    have = 0
    for j in range(jj0, jj1 + 1):
        for i in range(ii0, ii1 + 1):
            p = os.path.join(TER, 'img', str(IMG_LEVEL), f'{i}_{j}.webp')
            if not os.path.exists(p):
                continue
            im = Image.open(p).convert('RGB').resize((tpx, tpx), Image.LANCZOS)
            x0, z0 = rx0 + i * isize, rz0 + j * isize
            mosaic.paste(im, (int(round((x0 - minX) / WORK)), int(round((z0 - minZ) / WORK))))
            have += 1
    print('imagery tiles', have)

    # ---------- compose at MPP ----------
    OW = int(round((maxX - minX) / MPP))
    OD = int(round((maxZ - minZ) / MPP))
    img = np.asarray(mosaic.resize((OW, OD), Image.LANCZOS)).astype(np.float32) / 255.0
    hs = np.asarray(Image.fromarray(H).resize((OW, OD), Image.BILINEAR), np.float32)
    wat = np.asarray(Image.fromarray((WAT * 255).astype(np.uint8)).resize((OW, OD), Image.BILINEAR), np.float32) / 255.0
    # slightly soften the water mask edge
    wat = np.asarray(Image.fromarray((wat * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255.0

    # hillshade (light from the north-west)
    gy, gx = np.gradient(hs, MPP)
    nx, nz = -gx * 2.2, -gy * 2.2
    inv = 1 / np.sqrt(nx * nx + 1 + nz * nz)
    L = np.array([-0.55, 0.62, -0.55]); L = L / np.linalg.norm(L)
    shade = (nx * L[0] + L[1] + nz * L[2]) * inv / L[1]
    shade = np.clip(0.42 + 0.58 * shade, 0.55, 1.35)

    # land: desaturate + darken + cool tint, then hillshade
    lum = img @ np.array([0.299, 0.587, 0.114], np.float32)
    land = img * 0.42 + lum[..., None] * 0.58
    land = land * np.array([0.78, 0.84, 0.92], np.float32) * 0.62
    land = land * shade[..., None]
    # elevation lift for ridges (reads as relief even where imagery is flat)
    land += np.clip(hs / 900.0, 0, 1)[..., None] * 0.07

    # water: distance to shore (px) for a lighter shelf
    from scipy import ndimage
    dist = ndimage.distance_transform_edt(wat > 0.5)
    shelf = np.clip(1 - dist / 14.0, 0, 1) ** 1.6
    deep = np.array([10, 24, 42], np.float32) / 255
    shallow = np.array([24, 58, 86], np.float32) / 255
    water = deep + (shallow - deep) * shelf[..., None]

    out = land * (1 - wat[..., None]) + water * wat[..., None]
    # coastline
    edge = np.asarray(Image.fromarray((wat * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES), np.float32) / 255.0
    edge = np.clip(edge * 1.6, 0, 1)
    coast = np.array([130, 176, 206], np.float32) / 255
    out = out * (1 - edge[..., None] * 0.55) + coast * edge[..., None] * 0.55
    out = np.clip(out, 0, 1)

    os.makedirs(OUT_DIR, exist_ok=True)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT_DIR, 'bay-map.jpg'), quality=86, optimize=True, progressive=True)
    meta = {'minX': minX, 'maxX': maxX, 'minZ': minZ, 'maxZ': maxZ, 'width': OW, 'height': OD, 'metersPerPixel': MPP,
            'source': 'assets/sf/terrain (USGS 3DEP + NAIP via W1), baked by src/ui/tools/bake_bay_map.py'}
    with open(os.path.join(OUT_DIR, 'bay-map.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print('wrote', OW, 'x', OD)


if __name__ == '__main__':
    main()
