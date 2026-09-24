#!/usr/bin/env python3
"""Bake the stylised İstanbul map used by the menu (spawn map), the HUD minimap and the navigation map: the İstanbul
counterpart of bake_bay_map.py, in the same look (dark slate land with hillshade, navy water with a lighter shelf, a
thin light-blue coastline), north up (+x → right, +z → down), covering data/ist/region.json's local rectangle.

Sources (free, cached under data/ist/_cache/raw/, never in git):
  - OpenStreetMap (© OpenStreetMap contributors, ODbL): coastline, inland water, land cover (forest, residential, …).
    Overpass-style JSON; the terrain pipeline's extract (data/ist/_cache/raw/osm_w1/*.json) is used when present,
    otherwise Overpass is queried (generic User-Agent, one query at a time, retries with backoff).
  - Copernicus DEM GLO-30 (ESA; AWS Open Data copernicus-dem-30m, no account) for the hillshade.
The sea is found by flood-filling from seed points in the Sea of Marmara, the Bosphorus and the Black Sea through
the rasterised coastline; lakes and reservoirs come from the water polygons.

Output: src/ui/assets/ist-map.jpg + ist-map.json (bounds, size, metres per pixel). Re-run whenever the data changes:
    .venv/bin/python src/ui/tools/bake_ist_map.py
"""
import json
import os
import sys
import time

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
os.environ['GEO_REGION'] = 'ist'
sys.path.insert(0, os.path.join(ROOT, 'tools', 'geo'))
from geo import REGION, CRS, E0, N0, lonlat_to_utm  # noqa: E402

RAW = os.path.join(ROOT, 'data', 'ist', '_cache', 'raw')
CACHE = os.path.join(RAW, 'ui_map')
OUT_DIR = os.path.join(ROOT, 'src', 'ui', 'assets')
MPP = 32.0            # output metres per pixel (San Francisco: 24 over a 37 km map; this one is 64 km wide)
WORK = 12.0           # working resolution for the land / water masks
UA = {'User-Agent': 'gokyuzu-sf-pipeline/1.0'}
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter']
SEA_SEEDS = [(6000, 14000), (-20000, 12000), (0, -33000)]   # local x, z: Sea of Marmara (2), Black Sea (the Bosphorus joins them)

L = REGION['local']
MIN_X, MAX_X, MIN_Z, MAX_Z = L['minX'], L['maxX'], L['minZ'], L['maxZ']
S, W_, N_, E_ = REGION['bboxLonLat'][1], REGION['bboxLonLat'][0], REGION['bboxLonLat'][3], REGION['bboxLonLat'][2]
BBOX = f'{S - 0.05},{W_ - 0.05},{N_ + 0.05},{E_ + 0.05}'
QUERIES = {
    'coastline': f'way["natural"="coastline"]({BBOX});',
    'water': f'(way["natural"="water"]({BBOX});relation["natural"="water"]({BBOX});way["landuse"="reservoir"]({BBOX});'
             f'relation["landuse"="reservoir"]({BBOX});way["waterway"="riverbank"]({BBOX}););',
    'landcover': f'(way["landuse"~"^(forest|residential|commercial|industrial|retail|construction|farmland|meadow|grass|cemetery)$"]({BBOX});'
                 f'relation["landuse"~"^(forest|residential|industrial)$"]({BBOX});way["natural"~"^(wood|scrub|heath|grassland)$"]({BBOX});'
                 f'relation["natural"="wood"]({BBOX});way["leisure"="park"]({BBOX}););',
}


def osm(name):
    """Overpass-style JSON of a layer: the terrain pipeline's extract when present, else our own cached query."""
    for p in (os.path.join(RAW, 'osm_w1', f'{name}.json'), os.path.join(CACHE, f'{name}.json')):
        if os.path.exists(p):
            print('osm', name, '←', os.path.relpath(p, ROOT))
            with open(p) as f:
                return json.load(f)
    os.makedirs(CACHE, exist_ok=True)
    q = f'[out:json][timeout:600];{QUERIES[name]}out geom;'
    for attempt in range(8):
        ep = OVERPASS[attempt % len(OVERPASS)]
        try:
            r = requests.post(ep, data={'data': q}, headers=UA, timeout=700)
            if r.status_code == 200:
                d = r.json()
                with open(os.path.join(CACHE, f'{name}.json'), 'w') as f:
                    json.dump(d, f)
                return d
            print('overpass', r.status_code, ep)
        except requests.RequestException as e:
            print('overpass', e)
        time.sleep(15 * (attempt + 1))
    raise SystemExit(f'overpass: {name} failed')


# ---------------------------------------------------------------- geometry → raster
def to_px(geom, mpp):
    """[(lat, lon)…] → [(px, py)…] in the raster of `mpp` metres per pixel."""
    out = []
    for g in geom:
        e, n = lonlat_to_utm(g['lon'], g['lat'])
        out.append(((e - E0 - MIN_X) / mpp, (-(n - N0) - MIN_Z) / mpp))
    return out


def rings(element):
    """Closed rings of a way or a multipolygon relation: (outer rings, inner rings) as lists of geometry lists."""
    if element['type'] == 'way':
        g = element.get('geometry') or []
        return ([g] if len(g) >= 3 else []), []
    parts = {'outer': [], 'inner': []}
    for m in element.get('members', []):
        if m.get('type') == 'way' and m.get('geometry'):
            parts['inner' if m.get('role') == 'inner' else 'outer'].append(list(m['geometry']))
    return join(parts['outer']), join(parts['inner'])


def join(segs):
    """Join open ways sharing end nodes into rings (unclosed leftovers are closed as they are)."""
    key = lambda p: (round(p['lat'], 7), round(p['lon'], 7))
    segs = [s for s in segs if len(s) >= 2]
    out = []
    while segs:
        cur = segs.pop()
        changed = True
        while key(cur[0]) != key(cur[-1]) and changed:
            changed = False
            for i, s in enumerate(segs):
                if key(s[0]) == key(cur[-1]):
                    cur = cur + s[1:]
                elif key(s[-1]) == key(cur[-1]):
                    cur = cur + s[::-1][1:]
                elif key(s[-1]) == key(cur[0]):
                    cur = s + cur[1:]
                elif key(s[0]) == key(cur[0]):
                    cur = s[::-1] + cur[1:]
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if len(cur) >= 3:
            out.append(cur)
    return out


def fill(elements, size, mpp, select=lambda t: True):
    """Rasterise the polygons of the selected elements into a uint8 mask (holes cut)."""
    im = Image.new('L', size, 0)
    dr = ImageDraw.Draw(im)
    for e in elements:
        if not select(e.get('tags', {})):
            continue
        outer, inner = rings(e)
        for r in outer:
            dr.polygon(to_px(r, mpp), fill=255)
        for r in inner:
            dr.polygon(to_px(r, mpp), fill=0)
    return np.asarray(im) > 127


# ---------------------------------------------------------------- DEM
COPDEM = 'https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif'


def dem(size, mpp):
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import Affine
    dst = np.full((size[1], size[0]), np.nan, np.float32)
    transform = Affine(mpp, 0, E0 + MIN_X, 0, -mpp, N0 - MIN_Z)
    for lat in range(int(np.floor(S)), int(np.floor(N_)) + 1):
        for lon in range(int(np.floor(W_)), int(np.floor(E_)) + 1):
            n = f'Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM'
            path = os.path.join(RAW, 'copdem', f'{n}.tif')
            if not os.path.exists(path):
                path = os.path.join(CACHE, f'{n}.tif')
                if not os.path.exists(path):
                    os.makedirs(CACHE, exist_ok=True)
                    print('download', n)
                    r = requests.get(COPDEM.format(n=n), headers=UA, timeout=600)
                    r.raise_for_status()
                    with open(path, 'wb') as f:
                        f.write(r.content)
            with rasterio.open(path) as src:
                part = np.full_like(dst, np.nan)
                reproject(rasterio.band(src, 1), part, dst_transform=transform, dst_crs=CRS, resampling=Resampling.bilinear,
                          dst_nodata=np.nan)
                dst = np.where(np.isnan(dst), part, dst)
    return np.nan_to_num(dst, nan=0.0)


def main():
    OW, OD = int(round((MAX_X - MIN_X) / MPP)), int(round((MAX_Z - MIN_Z) / MPP))
    WW, WD = int(round((MAX_X - MIN_X) / WORK)), int(round((MAX_Z - MIN_Z) / WORK))

    # ---------- sea: flood fill through the coastline ----------
    coast = Image.new('L', (WW, WD), 0)
    dr = ImageDraw.Draw(coast)
    for e in osm('coastline')['elements']:
        g = e.get('geometry') or []
        if len(g) >= 2:
            dr.line(to_px(g, WORK), fill=255, width=2)
    barrier = np.asarray(coast) > 127
    lab, n = ndimage.label(~barrier)
    sea_ids = set()
    for x, z in SEA_SEEDS:
        i, j = int((x - MIN_X) / WORK), int((z - MIN_Z) / WORK)
        if 0 <= i < WW and 0 <= j < WD and lab[j, i]:
            sea_ids.add(lab[j, i])
    sea = np.isin(lab, list(sea_ids))
    sea = ndimage.binary_dilation(sea, iterations=1) & (sea | barrier)   # the coastline pixels themselves are shore: half sea
    water_el = osm('water')['elements']
    lakes = fill(water_el, (WW, WD), WORK, lambda t: t.get('natural') == 'water' or t.get('landuse') in ('reservoir', 'basin') or t.get('waterway') == 'riverbank')
    water = sea | lakes
    print('components', n, 'sea', len(sea_ids), 'water share', round(float(water.mean()), 3))

    # ---------- land cover ----------
    lc = osm('landcover')['elements']
    tag = lambda t, *keys: any(t.get(k) in v for k, v in keys)
    forest = fill(lc, (WW, WD), WORK, lambda t: tag(t, ('landuse', {'forest'}), ('natural', {'wood', 'scrub', 'heath'})))
    urban = fill(lc, (WW, WD), WORK, lambda t: tag(t, ('landuse', {'residential', 'commercial', 'industrial', 'retail', 'construction'})))
    open_ = fill(lc, (WW, WD), WORK, lambda t: tag(t, ('landuse', {'farmland', 'meadow', 'grass', 'cemetery'}), ('natural', {'grassland'}), ('leisure', {'park'})))

    def down(mask):
        return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).resize((OW, OD), Image.BILINEAR), np.float32) / 255.0
    wat, fo, ur, op = down(water), down(forest), down(urban), down(open_)
    wat = np.asarray(Image.fromarray((wat * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255.0

    # ---------- relief ----------
    hs = dem((OW, OD), MPP)
    print('dem range', float(hs.min()), float(hs.max()))
    gy, gx = np.gradient(hs, MPP)
    nx, nz = -gx * 2.2, -gy * 2.2
    inv = 1 / np.sqrt(nx * nx + 1 + nz * nz)
    Lv = np.array([-0.55, 0.62, -0.55]); Lv = Lv / np.linalg.norm(Lv)
    shade = np.clip(0.42 + 0.58 * (nx * Lv[0] + Lv[1] + nz * Lv[2]) * inv / Lv[1], 0.55, 1.35)

    # ---------- compose (the San Francisco bake's palette: slate land, navy water, light-blue coast) ----------
    c = lambda *v: np.array(v, np.float32) / 255
    land = np.broadcast_to(c(58, 64, 70), (OD, OW, 3)).copy()
    for mask, col in ((op, c(60, 66, 66)), (fo, c(40, 50, 50)), (ur, c(72, 79, 87))):
        land = land * (1 - mask[..., None]) + col * mask[..., None]
    land = land * shade[..., None]
    land += np.clip(hs / 900.0, 0, 1)[..., None] * 0.07
    dist = ndimage.distance_transform_edt(wat > 0.5)
    shelf = np.clip(1 - dist / 14.0, 0, 1) ** 1.6
    deep, shallow = c(10, 24, 42), c(24, 58, 86)
    water_c = deep + (shallow - deep) * shelf[..., None]
    out = land * (1 - wat[..., None]) + water_c * wat[..., None]
    edge = np.asarray(Image.fromarray((wat * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES), np.float32) / 255.0
    edge = np.clip(edge * 1.6, 0, 1)
    out = out * (1 - edge[..., None] * 0.55) + c(130, 176, 206) * edge[..., None] * 0.55
    out = np.clip(out, 0, 1)

    os.makedirs(OUT_DIR, exist_ok=True)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT_DIR, 'ist-map.jpg'), quality=80, optimize=True, progressive=True)
    meta = {'minX': MIN_X, 'maxX': MAX_X, 'minZ': MIN_Z, 'maxZ': MAX_Z, 'width': OW, 'height': OD, 'metersPerPixel': MPP,
            'source': 'OpenStreetMap (© OpenStreetMap contributors, ODbL) + Copernicus DEM GLO-30 (ESA), baked by src/ui/tools/bake_ist_map.py'}
    with open(os.path.join(OUT_DIR, 'ist-map.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print('wrote', OW, 'x', OD, os.path.getsize(os.path.join(OUT_DIR, 'ist-map.jpg')) // 1024, 'KB')


if __name__ == '__main__':
    main()
