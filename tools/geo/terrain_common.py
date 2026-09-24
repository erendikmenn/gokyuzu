"""Shared constants/helpers for the terrain + imagery pipelines (terrain_*.py, imagery_*.py), per map (GEO_REGION).

Quadtree layout (local game frame, see tools/geo/geo.py):
  root tile (level 0) = ROOT_SIZE meters square, min corner (ROOT_MIN_X, ROOT_MIN_Z); level L tile size = ROOT_SIZE / 2**L.
  Tile (L, i, j): x in [ROOT_MIN_X + i*s, +s], z in [ROOT_MIN_Z + j*s, +s]   (j grows toward +Z = south).
Source rasters are fetched / resampled directly in the region's UTM zone (geo.CRS) so no reprojection happens later.

Maps (GEO_REGION unset = sf, exactly the constants the San Francisco data was built with):
  sf : USGS 3DEP DEM (2 m core, 16 m far) + USGS NAIP imagery (1 m core, 4 m mid, 16 m far); data/sf/raw, data/sf/cache
  ist: Copernicus DEM GLO-30 (resampled to 8 m core, 16 m far) + Sentinel-2 L2A (10 m source: 4 m core, 8 m mid, 16 m far);
       downloads and caches under data/ist/_cache (gitignored)
"""
import os, sys, time, json
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from geo import ROOT, REGION, REGION_ID, DATA_DIR, ASSETS_DIR, CRS, E0, N0  # noqa: E402

EPSG = int(CRS.split(':')[1])       # 32610 (sf), 32635 (ist)
OUT = os.path.join(ASSETS_DIR, 'terrain')
ROOT_SIZE = 131072.0
GRID = 64            # quads per tile edge (65 x 65 vertices)
SUN_EL, SUN_AZ = 20.0, 255.0   # baked terrain sun-shadow direction (deg); must match src/world-sf/environment.js defaults
IMG_PX = 512

if REGION_ID == 'sf':
    RAW = os.path.join(ROOT, 'data', 'sf', 'raw')
    CACHE = os.path.join(ROOT, 'data', 'sf', 'cache', 'terrain')
    ROOT_MIN_X = -63488.0
    ROOT_MIN_Z = -75776.0
    # core area: 2 m DEM + 1 m imagery (aligned to the 1024 m grid of level 7)
    CORE = dict(x0=-17408.0, x1=21504.0, z0=-29696.0, z1=8192.0)
    # mid area: 4 m imagery
    MID = dict(x0=-30720.0, x1=34816.0, z0=-43008.0, z1=22528.0)
    MAX_CORE, MAX_MID, MAX_FAR = 10, 7, 6     # deepest height level per area (L10 = 128 m tiles, 2 m vertex spacing)
    IMG_CORE, IMG_MID, IMG_FAR = 8, 6, 4      # deepest imagery level per area (L8 = 512 m tiles with 512 px, 1 m/px)
    EPS = {9: 1.0}                            # m: a node is refined only if its geometric error exceeds this (per level)
    EPS_DEFAULT = 0.4
    DEM_SOURCE, IMAGERY_SOURCE = '3dep', 'naip'
elif REGION_ID == 'ist':
    RAW = os.path.join(DATA_DIR, '_cache', 'raw')
    CACHE = os.path.join(DATA_DIR, '_cache', 'terrain')
    # root centred on the region (x -29354..34747, z -37627..21924): Thrace coast to the Gulf of İzmit, Black Sea to the
    # Armutlu peninsula (40.51-41.69 N, 28.22-29.78 E)
    ROOT_MIN_X = -63488.0
    ROOT_MIN_Z = -73728.0
    # core = the region rectangle, aligned outward to the 2048 m grid of level 6: 8 m heights (L8), 4 m imagery (L6)
    CORE = dict(x0=-30720.0, x1=34816.0, z0=-38912.0, z1=22528.0)
    # mid = core + ~8 km (4096 m grid of level 5): 16 m heights (L7), 8 m imagery (L5)
    MID = dict(x0=-38912.0, x1=43008.0, z0=-49152.0, z1=32768.0)
    MAX_CORE, MAX_MID, MAX_FAR = 8, 7, 6      # 30 m source DEM: an 8 m mesh already carries all of it + the airport edges
    IMG_CORE, IMG_MID, IMG_FAR = 6, 5, 4      # 10 m source imagery: 4 m/px (sharpened resample) is the deepest level
    EPS = {}                                  # 0.4 m everywhere (the 8 m level is the deepest)
    EPS_DEFAULT = 0.4
    DEM_SOURCE, IMAGERY_SOURCE = 'copernicus', 'sentinel2'
else:
    raise SystemExit(f'terrain pipeline: no terrain configuration for GEO_REGION={REGION_ID!r} (terrain_common.py)')

# far area = whole root: 16 m DEM + 16 m imagery
FAR = dict(x0=ROOT_MIN_X, x1=ROOT_MIN_X + ROOT_SIZE, z0=ROOT_MIN_Z, z1=ROOT_MIN_Z + ROOT_SIZE)
CORE_RES = ROOT_SIZE / (1 << MAX_CORE) / GRID      # core height grid spacing (m): 2 (sf), 8 (ist)
MAX_LEVEL_CORE = MAX_CORE
IMG_LEVEL = IMG_CORE  # deepest imagery level
RUNWAYS_JSON = os.path.join(DATA_DIR, 'runways.json')
LANDMARKS_JSON = os.path.join(DATA_DIR, 'landmarks.json')
USER_AGENT = 'gokyuzu-sf-pipeline/1.0'


def config_summary():
    """Everything region-dependent (printed by `terrain_common.py` for a dry-run check of the paths and parameters)."""
    rel = lambda p: os.path.relpath(p, ROOT)
    return dict(region=REGION_ID, crs=CRS, epsg=EPSG, origin=[E0, N0], raw=rel(RAW), cache=rel(CACHE), out=rel(OUT),
                runways=rel(RUNWAYS_JSON), landmarks=rel(LANDMARKS_JSON), rootSize=ROOT_SIZE,
                rootMin=[ROOT_MIN_X, ROOT_MIN_Z], core=CORE, mid=MID, far=FAR, grid=GRID, coreRes=CORE_RES,
                maxLevels=[MAX_CORE, MAX_MID, MAX_FAR], imgLevels=[IMG_CORE, IMG_MID, IMG_FAR], imgPx=IMG_PX,
                eps=EPS, epsDefault=EPS_DEFAULT, sun=[SUN_EL, SUN_AZ], dem=DEM_SOURCE, imagery=IMAGERY_SOURCE)


def tile_bounds(L, i, j):
    s = ROOT_SIZE / (1 << L)
    x0 = ROOT_MIN_X + i * s
    z0 = ROOT_MIN_Z + j * s
    return x0, z0, s


def local_to_utm_box(x0, z0, x1, z1):
    """Local box -> UTM bbox (xmin, ymin, xmax, ymax). North = -z."""
    return (E0 + x0, N0 - z1, E0 + x1, N0 - z0)


def fetch(url, params, out, session=None, tries=6, timeout=300, min_bytes=1000):
    """GET with retries/backoff; writes to out atomically. Skips if out exists."""
    import requests
    if os.path.exists(out) and os.path.getsize(out) > min_bytes:
        return out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    s = session or requests
    delay = 3
    for k in range(tries):
        try:
            r = s.get(url, params=params, timeout=timeout)
            ct = r.headers.get('content-type', '')
            if r.status_code == 200 and len(r.content) > min_bytes and 'json' not in ct and 'html' not in ct:
                tmp = out + '.part'
                with open(tmp, 'wb') as f:
                    f.write(r.content)
                os.replace(tmp, out)
                return out
            msg = f'status {r.status_code} ct {ct} len {len(r.content)} {r.text[:200] if "json" in ct or "html" in ct else ""}'
        except Exception as e:  # network error
            msg = repr(e)
        print(f'  retry {k + 1}/{tries} {os.path.basename(out)}: {msg}', flush=True)
        time.sleep(delay)
        delay = min(delay * 2, 60)
    raise RuntimeError(f'failed {out}')


if __name__ == '__main__':
    print(json.dumps(config_summary(), indent=1))
