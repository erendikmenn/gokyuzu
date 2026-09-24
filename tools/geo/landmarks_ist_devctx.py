"""İstanbul landmarks: dev-only preview context (not published): Copernicus heights around the landmarks.

Writes assets/ist/landmarks/_dev/{context.json, height_u16.bin} (uint16 decimetres + 100 m offset, row = z, like the
SF dev context) for assets/ist/landmarks/_dev/preview.html, which renders the landmark layer on a plain DEM ground
before the terrain pipeline's tiles exist.  Usage: GEO_REGION=ist .venv/bin/python tools/geo/landmarks_ist_devctx.py
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from geo import ASSETS_DIR, REGION_ID  # noqa: E402
from landmarks_ist_layout import Dem  # noqa: E402

OUT = os.path.join(ASSETS_DIR, 'landmarks', '_dev')
X0, X1, Z0, Z1, RES = -8000.0, 16000.0, -23000.0, 6000.0, 30.0


def main():
    assert REGION_ID == 'ist'
    dem = Dem()
    xs = np.arange(X0, X1 + 1, RES)
    zs = np.arange(Z0, Z1 + 1, RES)
    H = np.zeros((len(zs), len(xs)), np.float32)
    for j, z in enumerate(zs):
        for i, x in enumerate(xs):
            H[j, i] = dem.local(x, z)
    os.makedirs(OUT, exist_ok=True)
    np.clip((H + 100) * 10, 0, 65535).astype('<u2').tofile(os.path.join(OUT, 'height_u16.bin'))
    json.dump({'x0': X0, 'x1': float(xs[-1]), 'z0': Z0, 'z1': float(zs[-1]), 'res': RES, 'w': len(xs), 'h': len(zs)},
              open(os.path.join(OUT, 'context.json'), 'w'))
    print('wrote', OUT, H.shape)


if __name__ == '__main__':
    main()
