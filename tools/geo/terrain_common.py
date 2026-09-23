"""Shared constants/helpers for the W1 terrain + imagery pipelines (terrain_*.py, imagery_*.py).

Quadtree layout (local game frame, see tools/geo/geo.py):
  root tile (level 0) = ROOT_SIZE meters square, min corner (ROOT_MIN_X, ROOT_MIN_Z); level L tile size = ROOT_SIZE / 2**L.
  Tile (L, i, j): x in [ROOT_MIN_X + i*s, +s], z in [ROOT_MIN_Z + j*s, +s]   (j grows toward +Z = south).
Source rasters are fetched directly in EPSG:32610 so no reprojection happens anywhere.
"""
import os, sys, time, json
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from geo import ROOT, REGION, E0, N0  # noqa: E402

RAW = os.path.join(ROOT, 'data', 'sf', 'raw')
CACHE = os.path.join(ROOT, 'data', 'sf', 'cache', 'terrain')
OUT = os.path.join(ROOT, 'assets', 'sf', 'terrain')

ROOT_SIZE = 131072.0
ROOT_MIN_X = -63488.0
ROOT_MIN_Z = -75776.0

# core area: 2 m DEM + 1 m imagery (aligned to the 1024 m grid of level 7)
CORE = dict(x0=-17408.0, x1=21504.0, z0=-29696.0, z1=8192.0)
# mid area: 4 m imagery
MID = dict(x0=-30720.0, x1=34816.0, z0=-43008.0, z1=22528.0)
# far area = whole root: 16 m DEM + 16 m imagery
FAR = dict(x0=ROOT_MIN_X, x1=ROOT_MIN_X + ROOT_SIZE, z0=ROOT_MIN_Z, z1=ROOT_MIN_Z + ROOT_SIZE)

GRID = 64            # quads per tile edge (65 x 65 vertices)
SUN_EL, SUN_AZ = 20.0, 255.0   # baked terrain sun-shadow direction (deg); must match src/world-sf/environment.js defaults
MAX_LEVEL_CORE = 10  # 128 m tiles -> 2 m vertex spacing
IMG_LEVEL = 8        # 512 m tiles with 512 px -> 1 m/px (deepest imagery level)
IMG_PX = 512


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
