"""Small terrain height map for the fog-bank shader (soft fog edges where it meets hills).
Output: <assets>/terrain/bank_height.bin (uint16 LE, decimetres + 100 m offset, rows +z) and bank_height.json.
Input: <cache>/h16.npy (16 m global grid written by terrain_build.py).
sf: the box of the San Francisco fog bank's footprint. Other maps (ist, no fog bank of their own yet): the region
rectangle (+2 km), so an engine that enables a fog layer there finds the same file.
Usage: .venv/bin/python tools/geo/terrain_fogmap.py
"""
import os, json
import numpy as np
from terrain_common import CACHE, OUT, ROOT_MIN_X, ROOT_MIN_Z, REGION_ID, ROOT_SIZE
from geo import REGION

h16 = np.load(os.path.join(CACHE, 'h16.npy'), mmap_mode='r')
RES = 64.0
X0, X1, Z0, Z1 = ROOT_MIN_X, 2048.0, -56000.0, 20480.0     # covers the fog bank's footprint box
if REGION_ID != 'sf':
    b = REGION['local']
    snap = lambda v, r: np.floor((v - r) / RES) * RES + r
    X0, Z0 = float(max(snap(b["minX"] - 2000, ROOT_MIN_X), ROOT_MIN_X)), float(max(snap(b["minZ"] - 2000, ROOT_MIN_Z), ROOT_MIN_Z))
    X1 = float(min(snap(b["maxX"] + 2000 + RES, ROOT_MIN_X), ROOT_MIN_X + ROOT_SIZE))
    Z1 = float(min(snap(b["maxZ"] + 2000 + RES, ROOT_MIN_Z), ROOT_MIN_Z + ROOT_SIZE))
i0, i1 = int((X0 - ROOT_MIN_X) / 16), int((X1 - ROOT_MIN_X) / 16)
j0, j1 = int((Z0 - ROOT_MIN_Z) / 16), int((Z1 - ROOT_MIN_Z) / 16)
a = np.array(h16[j0:j1, i0:i1], np.float32)
f = int(RES / 16)
H, W = a.shape[0] // f, a.shape[1] // f
m = a[:H * f, :W * f].reshape(H, f, W, f).max(axis=(1, 3))     # max: fog must clear the highest ground in a cell
v = np.clip(np.round((m + 100.0) * 10.0), 0, 65535).astype('<u2')
v.tofile(os.path.join(OUT, 'bank_height.bin'))
json.dump({'x0': X0, 'z0': Z0, 'res': RES, 'width': int(W), 'height': int(H), 'encoding': 'uint16 LE, h = v/10 - 100 (m), texel (i,j) covers [x0+i*res, +res]'},
          open(os.path.join(OUT, 'bank_height.json'), 'w'))
print('bank_height', W, H, float(m.min()), float(m.max()))
