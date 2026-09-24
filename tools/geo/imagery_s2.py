"""Sentinel-2 L2A true-colour imagery for maps without aerial photos (GEO_REGION=ist), in the NAIP cache layout.

Source: Copernicus Sentinel-2 L2A, Collection 1 (sentinel-2-c1-l2a) from the Element84 Earth Search STAC
(https://earth-search.aws.element84.com/v1, AWS Open Data, anonymous HTTPS). 10 m bands B04 / B03 / B02 + the 20 m
scene classification SCL, read as windows of the cloud-optimized GeoTIFFs (same UTM zone as the region, no reprojection).

Steps (each cached, re-runnable):
  items   : STAC lookup of the pinned datatakes (SCENES: date + relative orbit) -> raw/s2/items.json
  download: per item and band, the window inside the quadtree root on the 10 m S2 grid -> raw/s2/crops/<item>_<band>.tif
  mosaic  : per pixel, among the datatakes whose SCL says clear (vegetation, bare, water, unclassified, dark area,
            snow) the observation of median brightness (all three bands from the same date: no colour mixing);
            -> raw/s2/mosaic10.tif (uint16 reflectance x 10000 + 1000, 0 = no data)
  grade   : reflectance -> display colour matched to the San Francisco imagery look (land median luminance, contrast,
            saturation; measured on assets/sf/terrain/img), gentle unsharp mask
  canvases: resampled into the local frame like the NAIP cache (2048 px tiles, pixel-is-area, texel centres at
            (i + 0.5) * res): raw/s2/core4 (4 m over CORE, Lanczos from 10 m + sharpening), raw/s2/mid8 (8 m over MID),
            raw/s2/far16 (16 m over the root, area average) as <i>_<j>.png
Usage: GEO_REGION=ist .venv/bin/python tools/geo/imagery_s2.py [items|download|mosaic|canvases|all]
"""
import os, sys, json, re, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from terrain_common import RAW, CORE, MID, FAR, USER_AGENT, EPSG
from geo import E0, N0, CRS, local_to_lonlat

STAC = 'https://earth-search.aws.element84.com/v1'
COLLECTION = 'sentinel-2-c1-l2a'
# clear summer datatakes that each cover the whole core (relative orbits 107 = west swath, 007 = east swath; the union
# covers the root). Picked from the STAC listing: eo:cloud_cover <= 1 %, the most recent summer (buildings, airports and
# roads as they are now), two dates per orbit so every pixel has a clear median.
SCENES = [('2026-07-12', '107'), ('2026-07-27', '107'), ('2026-07-07', '007'), ('2026-08-04', '007')]
BANDS = {'red': 'B04', 'green': 'B03', 'blue': 'B02', 'scl': 'SCL'}
CLEAR_SCL = (2, 4, 5, 6, 7, 11)       # dark area, vegetation, not vegetated, water, unclassified, snow
S2DIR = os.path.join(RAW, 's2')
# 10 m mosaic grid = the S2 pixel grid (UTM multiples of 10 m) covering the root
GX0 = np.floor((E0 + FAR['x0']) / 10.0) * 10.0
GX1 = np.ceil((E0 + FAR['x1']) / 10.0) * 10.0
GY1 = np.ceil((N0 - FAR['z0']) / 10.0) * 10.0      # north edge
GY0 = np.floor((N0 - FAR['z1']) / 10.0) * 10.0      # south edge
GW, GH = int((GX1 - GX0) / 10), int((GY1 - GY0) / 10)
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:6.1f}s]', *a, flush=True)


def gdal_env():
    import rasterio
    return rasterio.Env(GDAL_HTTP_USERAGENT=USER_AGENT, GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_MAX_RETRY=6,
                        GDAL_HTTP_RETRY_DELAY=3, CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', VSI_CACHE=True,
                        GDAL_HTTP_MULTIRANGE='YES', GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES', AWS_NO_SIGN_REQUEST='YES')


# ---------------------------------------------------------------- items
def items():
    import requests
    path = os.path.join(S2DIR, 'items.json')
    if os.path.exists(path):
        return json.load(open(path))
    lons, lats = zip(*[local_to_lonlat(x, z) for x in (FAR['x0'], FAR['x1']) for z in (FAR['z0'], FAR['z1'])])
    bbox = [min(lons), min(lats), max(lons), max(lats)]
    out = []
    H = {'User-Agent': USER_AGENT}
    for date, orbit in SCENES:
        body = {'collections': [COLLECTION], 'bbox': bbox, 'datetime': f'{date}T00:00:00Z/{date}T23:59:59Z', 'limit': 100}
        feats = requests.post(STAC + '/search', json=body, headers=H, timeout=120).json()['features']
        for f in feats:
            p = f['properties']
            if f'_R{orbit}_' not in p['s2:product_uri'] or p.get('proj:epsg', p.get('proj:code')) not in (EPSG, f'EPSG:{EPSG}'):
                continue
            a = f['assets']
            out.append({'id': f['id'], 'date': date, 'orbit': orbit, 'tile': p['grid:code'], 'cloud': p['eo:cloud_cover'],
                        'product': p['s2:product_uri'],
                        'hrefs': {k: a[k]['href'] for k in BANDS},
                        'scale': a['red']['raster:bands'][0].get('scale', 1e-4),
                        'offset': a['red']['raster:bands'][0].get('offset', 0.0)})
    os.makedirs(S2DIR, exist_ok=True)
    json.dump(out, open(path, 'w'), indent=1)
    log('items', len(out))
    return out


# ---------------------------------------------------------------- download (windowed COG reads)
def crop_one(it, band):
    import rasterio
    from rasterio.windows import from_bounds
    out = os.path.join(S2DIR, 'crops', f"{it['id']}_{band}.tif")
    if os.path.exists(out):
        return out
    with gdal_env(), rasterio.open(it['hrefs'][band]) as src:
        b = src.bounds
        x0, x1 = max(b.left, GX0), min(b.right, GX1)
        y0, y1 = max(b.bottom, GY0), min(b.top, GY1)
        if x1 <= x0 or y1 <= y0:
            return None
        win = from_bounds(x0, y0, x1, y1, src.transform).round_offsets().round_lengths()
        a = src.read(1, window=win)
        T = src.window_transform(win)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + '.part.tif'
    with rasterio.open(tmp, 'w', driver='GTiff', width=a.shape[1], height=a.shape[0], count=1, dtype=a.dtype, crs=CRS,
                       transform=T, compress='deflate', predictor=2, tiled=True) as o:
        o.write(a, 1)
    os.replace(tmp, out)
    return out


def download():
    its = items()
    jobs = [(it, b) for it in its for b in BANDS]
    done = [0]

    def run(j):
        for k in range(4):
            try:
                crop_one(*j)
                break
            except Exception as e:  # network hiccup: GDAL retries ranges itself, retry the whole window a few times
                log('retry', j[0]['id'], j[1], repr(e)[:200])
                time.sleep(5 * (k + 1))
        else:
            raise RuntimeError(f'download failed {j[0]["id"]} {j[1]}')
        done[0] += 1
        if done[0] % 4 == 0:
            log(f's2 {done[0]}/{len(jobs)}')

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(run, jobs))
    log('download done', len(jobs))


# ---------------------------------------------------------------- mosaic
def place(path, dst, nearest_up=1):
    """Paste a crop (10 m, or 20 m SCL upsampled x2 nearest) into the 10 m root grid array dst."""
    import rasterio
    with rasterio.open(path) as s:
        a = s.read(1)
        T = s.transform
    if nearest_up > 1:
        a = a.repeat(nearest_up, 0).repeat(nearest_up, 1)
    c0 = int(round((T.c - GX0) / 10.0))
    r0 = int(round((GY1 - T.f) / 10.0))
    h, w = a.shape
    cs, rs = max(0, -c0), max(0, -r0)
    ce, re_ = min(w, GW - c0), min(h, GH - r0)
    dst[r0 + rs:r0 + re_, c0 + cs:c0 + ce] = np.where(a[rs:re_, cs:ce] > 0, a[rs:re_, cs:ce], dst[r0 + rs:r0 + re_, c0 + cs:c0 + ce])


def mosaic():
    import rasterio
    from affine import Affine
    out = os.path.join(S2DIR, 'mosaic10.tif')
    if os.path.exists(out):
        return out
    its = items()
    takes = sorted({(it['date'], it['orbit']) for it in its})
    K = len(takes)
    rgb = np.zeros((K, 3, GH, GW), np.uint16)
    ok = np.zeros((K, GH, GW), np.uint8)       # 0 no data, 1 data but not clear, 2 clear
    for k, t in enumerate(takes):
        scl = np.zeros((GH, GW), np.uint8)
        for it in its:
            if (it['date'], it['orbit']) != t:
                continue
            for c, band in enumerate(('red', 'green', 'blue')):
                place(os.path.join(S2DIR, 'crops', f"{it['id']}_{band}.tif"), rgb[k, c])
            place(os.path.join(S2DIR, 'crops', f"{it['id']}_scl.tif"), scl, 2)
        have = (rgb[k] > 0).all(0)
        ok[k] = np.where(have, np.where(np.isin(scl, CLEAR_SCL), 2, 1), 0)
        log('datatake', t, 'data', round(float(have.mean()), 3), 'clear', round(float((ok[k] == 2).mean()), 3))
    res = np.zeros((3, GH, GW), np.uint16)
    step = 512
    for r in range(0, GH, step):
        sl = slice(r, r + step)
        o = ok[:, sl].astype(np.int16)
        bright = rgb[:, :, sl].astype(np.float32).sum(1)            # (K, h, w)
        best = o.max(0)                                             # 2 if any clear, else 1 if any data
        use = (o == best[None]) & (best[None] > 0)
        key = np.where(use, bright, np.inf)
        order = np.argsort(key, axis=0)
        n = use.sum(0)
        pick = np.take_along_axis(order, np.maximum((n - 1) // 2, 0)[None], 0)[0]   # lower median brightness
        for c in range(3):
            v = np.take_along_axis(rgb[:, c, sl], pick[None], 0)[0]
            res[c, sl] = np.where(n > 0, v, 0)
    log('mosaic: no data', round(float((res[0] == 0).mean()), 4))
    T = Affine(10.0, 0, GX0, 0, -10.0, GY1)
    tmp = out + '.part.tif'
    with rasterio.open(tmp, 'w', driver='GTiff', width=GW, height=GH, count=3, dtype='uint16', crs=CRS, transform=T,
                       compress='deflate', predictor=2, tiled=True, BIGTIFF='YES') as o:
        o.write(res)
    os.replace(tmp, out)
    return out


# ---------------------------------------------------------------- grade
# Display transform matched to the San Francisco imagery (graded NAIP, assets/sf/terrain/img L6 land pixels: luminance
# p5/p25/p50/p75/95 = 62/88/116/146/181, mean saturation 0.17). Sentinel-2 L2A is atmospherically corrected (no haze
# offset). A plain sRGB encode of reflectance x GAIN gives İstanbul land luminance 77/85/106/134/171 (the dark end is
# mostly forest, compressed); the tone curve below moves those quantiles ~60-80 % of the way to San Francisco's with a
# local slope <= 1.9 (forest texture is not blown up into noise); colour ratios are kept, then saturation is scaled.
GAIN = 2.35          # reflectance multiplier before the sRGB transfer
TONE = [(0, 0), (60, 44), (77, 66), (85, 81), (106, 112), (134, 141), (171, 177), (215, 218), (255, 255)]
SAT = 0.85           # saturation relative to the plain encode (red roofs and summer greens are stronger than NAIP's)
SHARP = (1.2, 0.55)  # unsharp mask sigma (px of the output canvas), amount (core 4 m canvas)
_TONE_LUT = None


def srgb(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 0.0031308), 1 / 2.4) - 0.055)


def tone_lut():
    global _TONE_LUT
    if _TONE_LUT is None:
        from scipy.interpolate import PchipInterpolator
        xs, ys = zip(*TONE)
        _TONE_LUT = PchipInterpolator(np.array(xs) / 255.0, np.array(ys) / 255.0)(np.linspace(0, 1, 4096)).astype(np.float32)
    return _TONE_LUT


def grade(refl):
    """(3, h, w) float32 surface reflectance -> (h, w, 3) uint8 display colour (row chunks, bounded memory)."""
    out = np.empty(refl.shape[1:] + (3,), np.uint8)
    lut = tone_lut()
    for r in range(0, refl.shape[1], 1024):
        v = srgb(np.clip(refl[:, r:r + 1024] * GAIN, 0, 1)).astype(np.float32)
        lum = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
        new = lut[np.clip((lum * 4095).astype(np.int32), 0, 4095)]
        v = v * (new / np.maximum(lum, 1e-4))[None]
        v = new[None] + (v - new[None]) * SAT
        out[r:r + 1024] = np.clip(np.moveaxis(v, 0, -1) * 255 + 0.5, 0, 255).astype(np.uint8)
    return out


# ---------------------------------------------------------------- canvases
def unsharp(img, sigma, amount):
    from scipy import ndimage
    f = img.astype(np.float32)
    blur = np.stack([ndimage.gaussian_filter(f[..., c], sigma) for c in range(3)], -1)
    return np.clip(f + (f - blur) * amount + 0.5, 0, 255).astype(np.uint8)


def canvas(area, res, name, resampling, sharp=None):
    """Resample the graded 10 m mosaic into a local-frame canvas (pixel-is-area) and write 2048 px PNG tiles."""
    import rasterio
    from rasterio.warp import reproject, Resampling
    from affine import Affine
    from PIL import Image
    d = os.path.join(S2DIR, name)
    W, H = int((area['x1'] - area['x0']) / res), int((area['z1'] - area['z0']) / res)
    nx, nz = -(-W // 2048), -(-H // 2048)
    if os.path.exists(os.path.join(d, f'{nx - 1}_{nz - 1}.png')):
        log('cached', name)
        return
    with rasterio.open(os.path.join(S2DIR, 'mosaic10.tif')) as s:
        src = s.read()
        ST = s.transform
    nod = src[0] == 0
    refl = src.astype(np.float32) * 1e-4 - 0.1          # C1 L2A: scale 1e-4, offset -0.1 (asserted in items())
    refl[:, nod] = np.nan
    T = Affine(res, 0, E0 + area['x0'], 0, -res, N0 - area['z0'])
    dst = np.full((3, H, W), np.nan, np.float32)
    rs = getattr(Resampling, resampling)
    for c in range(3):
        reproject(refl[c], dst[c], src_transform=ST, src_crs=CRS, dst_transform=T, dst_crs=CRS, resampling=rs,
                  src_nodata=np.nan, dst_nodata=np.nan, num_threads=8)
    del refl, src
    miss = ~np.isfinite(dst[0])
    log(name, f'{W}x{H} at {res} m, empty {miss.mean():.4f}')
    if miss.any():   # outside every swath (root corners): nearest valid colour, sea there anyway
        from scipy import ndimage
        _, (iy, ix) = ndimage.distance_transform_edt(miss, return_indices=True)
        dst = dst[:, iy, ix]
    img = grade(np.nan_to_num(dst, nan=0.0))
    del dst
    if sharp:
        img = unsharp(img, *sharp)
    os.makedirs(d, exist_ok=True)
    for j in range(nz):
        for i in range(nx):
            t = np.zeros((2048, 2048, 3), np.uint8)
            blk = img[j * 2048:(j + 1) * 2048, i * 2048:(i + 1) * 2048]
            t[:blk.shape[0], :blk.shape[1]] = blk
            Image.fromarray(t).save(os.path.join(d, f'{i}_{j}.png'), compress_level=3)
    log('wrote', name, nx, 'x', nz, 'tiles')


def canvases():
    canvas(FAR, 16.0, 'far16', 'average')
    canvas(MID, 8.0, 'mid8', 'lanczos', (1.0, 0.35))
    canvas(CORE, 4.0, 'core4', 'lanczos', SHARP)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if which in ('items', 'all'):
        its = items()
        assert all(abs(it['scale'] - 1e-4) < 1e-9 and abs(it['offset'] + 0.1) < 1e-9 for it in its), 'unexpected scaling'
        for it in its:
            print(' ', it['id'], it['product'], 'cloud', round(it['cloud'], 3))
    if which in ('download', 'all'):
        download()
    if which in ('mosaic', 'all'):
        mosaic()
    if which in ('canvases', 'all'):
        canvases()


if __name__ == '__main__':
    main()
