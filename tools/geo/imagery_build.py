"""Build the aerial imagery tile pyramid (512 px WebP, alpha = land coverage) for the terrain quadtree (per map).

Inputs : sf : data/sf/raw/naip/{core1,mid4,far16}/*.jpg (imagery_download.py)
         ist: data/ist/_cache/raw/s2/{core4,mid8,far16}/*.png (imagery_download.py -> imagery_s2.py, already graded)
         <cache>/water_final.pkl and <assets>/terrain/index.json (terrain_build.py)
Outputs: <assets>/terrain/img/<L>/<i>_<j>.webp and the node image flags in index.json.
Pipeline: grade colors -> premultiply by land alpha (water pixels are rendered by the water shader) -> 2x2 box pyramid
(core at IMG_CORE, mid spliced with the core, far spliced with mid; sf: 1 m / 4 m / 16 m, ist: 4 m / 8 m / 16 m)
-> per tile un-premultiply + push-pull fill of water pixels (so mipmaps never bleed foreign colors into the coast) -> WebP.
Only missing tiles are encoded unless --force. Publishes h.next -> h and index.json atomically at the end.
Usage: .venv/bin/python tools/geo/imagery_build.py [--force]
"""
import os, json, pickle, time, shutil
import multiprocessing as mp
import numpy as np
from PIL import Image
from rasterio import features
from affine import Affine
from terrain_common import (RAW, CACHE, OUT, ROOT_SIZE, ROOT_MIN_X, ROOT_MIN_Z, CORE, MID, FAR, IMG_CORE, IMG_MID,
                            IMG_FAR, IMAGERY_SOURCE)

Image.MAX_IMAGE_PIXELS = None
T0 = time.time()
PX = 512
SRC_DIR, SRC_EXT = ('naip', 'jpg') if IMAGERY_SOURCE == 'naip' else ('s2', 'png')


def log(*a):
    print(f'[{time.time() - T0:6.1f}s]', *a, flush=True)


# ---------------- color grading ----------------
# NAIP is shot around noon through ~1 km of marine haze: lift is bluish and contrast is low. Remove part of the haze
# offset, add a gentle contrast S-curve and slightly calm the greens so the photo reads like surface albedo.
HAZE = np.array([0.035, 0.045, 0.075], np.float32)
LUT = None


def build_lut():
    """3 x 256 per-channel tone LUT (dehaze + contrast); saturation is applied separately."""
    x = np.arange(256, dtype=np.float32) / 255.0
    out = []
    for c in range(3):
        y = np.clip((x - HAZE[c]) / (1 - HAZE[c]), 0, 1)
        # mild S-curve around mid grey
        y = y + 0.10 * np.sin((y - 0.5) * np.pi) * 0.5 * (1 - np.abs(2 * y - 1))
        out.append(np.clip(y * 255 + 0.5, 0, 255).astype(np.uint8))
    return np.stack(out)


def grade(rgb):
    """In-place-ish grade of an (H, W, 3) uint8 array in row chunks (Sentinel-2 canvases are graded by imagery_s2.py)."""
    global LUT
    if IMAGERY_SOURCE != 'naip':
        return rgb
    if LUT is None:
        LUT = build_lut()
    H = rgb.shape[0]
    step = 1024
    for r in range(0, H, step):
        blk = rgb[r:r + step]
        for c in range(3):
            blk[..., c] = LUT[c][blk[..., c]]
        f = blk.astype(np.float32)
        lum = f @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        # calm over-saturated vegetation greens, keep other hues
        g_excess = np.clip((f[..., 1] - np.maximum(f[..., 0], f[..., 2])) / 60.0, 0, 1)
        sat = 1.02 - 0.18 * g_excess
        f = lum[..., None] + (f - lum[..., None]) * sat[..., None]
        blk[:] = np.clip(f + 0.5, 0, 255).astype(np.uint8)
    return rgb


# ---------------- canvases ----------------
def load_canvas(name, nx, nz, px, crop=None):
    H, W = nz * px, nx * px
    a = np.zeros((H, W, 3), np.uint8)
    for j in range(nz):
        for i in range(nx):
            p = os.path.join(RAW, SRC_DIR, name, f'{i}_{j}.{SRC_EXT}')
            a[j * px:(j + 1) * px, i * px:(i + 1) * px] = np.asarray(Image.open(p).convert('RGB'))
    if crop:
        a = a[:crop[0], :crop[1]]
    return np.ascontiguousarray(a)


def land_alpha(water, x0, z0, res, shape):
    T = Affine(res, 0, x0, 0, res, z0)   # pixel-is-area: edges on the tile grid
    shapes = [(g, 1) for g in [water['sea']] + list(water['lakes']) if not g.is_empty]
    m = features.rasterize(shapes, out_shape=shape, transform=T, dtype=np.uint8, fill=0)
    return np.where(m > 0, 0, 255).astype(np.uint8)


def premultiply(rgb, a):
    rgb[a == 0] = 0
    return rgb


def down2(rgbp, a):
    """2x2 box average of premultiplied rgb (uint8) and alpha (uint8)."""
    H, W = rgbp.shape[0] // 2 * 2, rgbp.shape[1] // 2 * 2
    out = np.empty((H // 2, W // 2, 3), np.uint8)
    step = 2048
    for r in range(0, H, step):
        b = rgbp[r:r + step, :W].astype(np.uint16)
        s = b[0::2, 0::2] + b[1::2, 0::2] + b[0::2, 1::2] + b[1::2, 1::2]
        out[r // 2:(r + step) // 2] = ((s + 2) // 4).astype(np.uint8)
    aa = a[:H, :W].astype(np.uint16)
    ao = ((aa[0::2, 0::2] + aa[1::2, 0::2] + aa[0::2, 1::2] + aa[1::2, 1::2] + 2) // 4).astype(np.uint8)
    return out, ao


# ---------------- per tile ----------------
G = {}   # level -> (rgbp, alpha, x0, z0, res); shared with forked workers


def push_pull(rgbp, a):
    """Un-premultiply and fill fully transparent pixels from coarser levels (float32)."""
    cols, alphas = [rgbp.astype(np.float32)], [a.astype(np.float32) / 255.0]
    while cols[-1].shape[0] > 1:
        c, w = cols[-1], alphas[-1]
        cols.append((c[0::2, 0::2] + c[1::2, 0::2] + c[0::2, 1::2] + c[1::2, 1::2]) / 4)
        alphas.append((w[0::2, 0::2] + w[1::2, 0::2] + w[0::2, 1::2] + w[1::2, 1::2]) / 4)
    color = None
    for c, w in zip(reversed(cols), reversed(alphas)):
        un = c / np.maximum(w, 1e-4)[..., None]
        if color is None:
            color = np.where(w[..., None] > 1e-4, un, 128.0)
        else:
            up = color.repeat(2, 0).repeat(2, 1)[:c.shape[0], :c.shape[1]]
            color = np.where(w[..., None] > 1e-4, un, up)
    return np.clip(color + 0.5, 0, 255).astype(np.uint8)


def write_tile(job):
    L, i, j = job
    rgbp, a, x0, z0, res = G[L]
    s = ROOT_SIZE / (1 << L)
    c0 = int(round((ROOT_MIN_X + i * s - x0) / res))
    r0 = int(round((ROOT_MIN_Z + j * s - z0) / res))
    tp = rgbp[r0:r0 + PX, c0:c0 + PX]
    ta = a[r0:r0 + PX, c0:c0 + PX]
    if tp.shape[:2] != (PX, PX):
        return (L, i, j, 0)
    if ta.max() == 0:
        return (L, i, j, 0)
    rgb = push_pull(tp, ta)
    d = os.path.join(OUT, 'img', str(L))
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f'{i}_{j}.webp')
    if ta.min() == 255:
        Image.fromarray(rgb).save(path, 'WEBP', quality=84, method=4)
    else:
        Image.fromarray(np.dstack([rgb, ta])).save(path, 'WEBP', quality=84, method=4, alpha_quality=100)
    return (L, i, j, 1)


def main():
    import sys
    force = '--force' in sys.argv
    index_path = os.path.join(OUT, 'index.json')
    src_index = os.path.join(CACHE, 'index_terrain.json')
    index = json.load(open(src_index if os.path.exists(src_index) else index_path))
    water = pickle.load(open(os.path.join(CACHE, 'water_final.pkl'), 'rb'))

    # which nodes carry their own image
    def img_max(L, i, j):
        s = ROOT_SIZE / (1 << L)
        x0, z0 = ROOT_MIN_X + i * s, ROOT_MIN_Z + j * s
        inside = lambda A: x0 >= A['x0'] and x0 + s <= A['x1'] and z0 >= A['z0'] and z0 + s <= A['z1']
        return IMG_CORE if inside(CORE) else (IMG_MID if inside(MID) else IMG_FAR)

    wanted = [(r[0], r[1], r[2]) for r in index['nodes'] if r[0] <= img_max(r[0], r[1], r[2]) and r[7] != 2]
    have = set()
    if force:
        jobs = wanted
    else:   # incremental: keep tiles that already exist (imagery of a tile never depends on the height tree)
        jobs = []
        for (L, i, j) in wanted:
            if os.path.exists(os.path.join(OUT, 'img', str(L), f'{i}_{j}.webp')):
                have.add((L, i, j))
            else:
                jobs.append((L, i, j))
    log('tiles to write', len(jobs), 'kept', len(have))
    if jobs:
        res_of = lambda L: ROOT_SIZE / (1 << L) / PX      # m per pixel of level L

        def canvas(kind, area, L):
            res = res_of(L)
            w, h = int(area['x1'] - area['x0']) // int(res), int(area['z1'] - area['z0']) // int(res)
            log(f'{kind} canvas {res:g} m')
            c = load_canvas(f'{kind}{int(res)}', -(-w // 2048), -(-h // 2048), 2048, crop=(h, w))
            grade(c)
            al = land_alpha(water, area['x0'], area['z0'], res, c.shape[:2])
            premultiply(c, al)
            return c, al

        def splice(dst, src, area_dst, area_src, res):
            ox, oz = int((area_src['x0'] - area_dst['x0']) / res), int((area_src['z0'] - area_dst['z0']) / res)
            dst[oz:oz + src.shape[0], ox:ox + src.shape[1]] = src

        # core at IMG_CORE, box pyramid down to IMG_MID (sf: L8 1 m, L7)
        c, a = canvas('core', CORE, IMG_CORE)
        G[IMG_CORE] = (c, a, CORE['x0'], CORE['z0'], res_of(IMG_CORE))
        log('core pyramid')
        for L in range(IMG_CORE - 1, IMG_MID, -1):
            c, a = down2(c, a)
            G[L] = (c, a, CORE['x0'], CORE['z0'], res_of(L))
        cc, ac = down2(c, a)
        # mid at IMG_MID with the core spliced in, pyramid down to IMG_FAR (sf: L6 4 m, L5)
        c, a = canvas('mid', MID, IMG_MID)
        splice(c, cc, MID, CORE, res_of(IMG_MID))
        splice(a, ac, MID, CORE, res_of(IMG_MID))
        G[IMG_MID] = (c, a, MID['x0'], MID['z0'], res_of(IMG_MID))
        for L in range(IMG_MID - 1, IMG_FAR, -1):
            c, a = down2(c, a)
            G[L] = (c, a, MID['x0'], MID['z0'], res_of(L))
        cm, am = down2(c, a)
        # far (whole root) at IMG_FAR with mid spliced in, then down to the root (sf: L4 16 m)
        c, a = canvas('far', FAR, IMG_FAR)
        splice(c, cm, FAR, MID, res_of(IMG_FAR))
        splice(a, am, FAR, MID, res_of(IMG_FAR))
        G[IMG_FAR] = (c, a, ROOT_MIN_X, ROOT_MIN_Z, res_of(IMG_FAR))
        for L in range(IMG_FAR - 1, -1, -1):
            c, a = down2(c, a)
            G[L] = (c, a, ROOT_MIN_X, ROOT_MIN_Z, ROOT_SIZE / (1 << L) / PX)
    res = []
    if jobs:
        ctx = mp.get_context('fork')
        with ctx.Pool(14) as pool:
            res = pool.map(write_tile, jobs, chunksize=16)
    have |= {(L, i, j) for (L, i, j, ok) in res if ok}
    log('written', len(have))
    for r in index['nodes']:
        flag = 1 if (r[0], r[1], r[2]) in have else 0
        if len(r) > 8:
            r[8] = flag
        else:
            r.append(flag)
    if 'img' not in index['nodeFields']:
        index['nodeFields'].append('img')
    index['imgPx'] = PX
    index['imgFormat'] = 'webp (RGB or RGBA; alpha = land coverage, 0 = water)'
    # publish atomically: swap the new height packs in, then replace index.json
    hnext, hlive, hold = (os.path.join(OUT, n) for n in ('h.next', 'h', 'h.old'))
    if os.path.exists(hnext):
        if os.path.exists(hold):
            shutil.rmtree(hold)
        if os.path.exists(hlive):
            os.rename(hlive, hold)
        os.rename(hnext, hlive)
    tmp = index_path + '.tmp'
    json.dump(index, open(tmp, 'w'), separators=(',', ':'))
    os.replace(tmp, index_path)
    if os.path.exists(hold):
        shutil.rmtree(hold)
    # small previews for inspection
    prev = os.path.join(CACHE, 'preview')
    os.makedirs(prev, exist_ok=True)
    if 2 in G:
        Image.fromarray(np.dstack([G[2][0], G[2][1]])).save(os.path.join(prev, 'L2.png'))
        Image.fromarray(np.dstack([G[4][0], G[4][1]])).resize((2048, 2048)).save(os.path.join(prev, 'L4.png'))
        if IMG_FAR < IMG_MID and IMAGERY_SOURCE != 'naip':
            Image.fromarray(np.dstack([G[IMG_MID][0], G[IMG_MID][1]])).save(os.path.join(prev, f'L{IMG_MID}.png'))
    log('done')


if __name__ == '__main__':
    main()
