"""Global water info texture for the water shader: assets/sf/terrain/water_depth.png (RGB, 4096², 32 m/texel over the
quadtree root, texel k centre at rootMin + 32k):
  R = sqrt(depth / 60 m)                       (3DEP topobathy in the bay/nearshore; distance-based estimate offshore)
  G = sqrt(min(distance to shore, 2000 m) / 2000)   (smooth, global -> surf bands, turbidity, foam)
Inputs: NOAA NCEI DEM mosaic (topobathy; downloaded + cached in data/sf/raw/noaa/), cached 3DEP mosaics (data/sf/raw/3dep)
and data/sf/cache/terrain/water_final.pkl (terrain_build.py). 3DEP water is often hydro-flattened (~0 m) in land-lidar
tiles, so NOAA is used wherever it has data and 3DEP elsewhere.
Usage: .venv/bin/python tools/geo/terrain_waterinfo.py
"""
import os, pickle
import numpy as np
import rasterio
from rasterio import features
from affine import Affine
from scipy import ndimage
from PIL import Image
from terrain_common import RAW, CACHE, OUT, ROOT_MIN_X, ROOT_MIN_Z, CORE, local_to_utm_box, fetch

N, RES = 4096, 32.0


def mosaic(name, n, px):
    a = np.empty((n * px, n * px), np.float32)
    for j in range(n):
        for i in range(n):
            with rasterio.open(os.path.join(RAW, '3dep', name, f'{i}_{j}.tif')) as src:
                a[j * px:(j + 1) * px, i * px:(i + 1) * px] = src.read(1)
    return a


NOAA_URL = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_all/ImageServer/exportImage'


def noaa_depth():
    """NOAA topobathy at 32 m on the texture grid (texel centres at rootMin + 32k); positive = below sea level."""
    out = np.zeros((N, N), np.float32)
    px = 2048
    for j in range(2):
        for i in range(2):
            x0 = ROOT_MIN_X + i * px * RES - RES / 2
            z0 = ROOT_MIN_Z + j * px * RES - RES / 2
            bbox = local_to_utm_box(x0, z0, x0 + px * RES, z0 + px * RES)
            path = os.path.join(RAW, 'noaa', f'dem32_{i}_{j}.tif')
            fetch(NOAA_URL, dict(bbox=','.join(f'{v:.3f}' for v in bbox), bboxSR=32610, imageSR=32610, size=f'{px},{px}',
                                 format='tiff', pixelType='F32', noData=-9999, interpolation='RSP_BilinearInterpolation',
                                 f='image'), path)
            with rasterio.open(path) as src:
                a = src.read(1)
            a = np.where(a < -9000, 0.0, a)
            out[j * px:(j + 1) * px, i * px:(i + 1) * px] = np.maximum(-a, 0.0)
    return out


def main():
    # far 16 m (samples at rootMin + 16k) -> 32 m samples at rootMin + 32k (point + 3x3 box)
    far = mosaic('far16', 4, 2048)
    far = ndimage.uniform_filter(far, 3, mode='nearest')[::2, ::2][:N, :N]
    # core 2 m (samples at core.x0 + 2k) -> 32 m, averaged over 16x16
    core = mosaic('core2', 10, 2048)
    ci, cj = int((CORE['x0'] - ROOT_MIN_X) / RES), int((CORE['z0'] - ROOT_MIN_Z) / RES)
    nx, nz = int((CORE['x1'] - CORE['x0']) / RES), int((CORE['z1'] - CORE['z0']) / RES)
    c = ndimage.uniform_filter(core[:nz * 16 + 16, :nx * 16 + 16], 16, mode='nearest')[::16, ::16][:nz, :nx]
    h = far.copy()
    h[cj:cj + nz, ci:ci + nx] = c
    water = pickle.load(open(os.path.join(CACHE, 'water_final.pkl'), 'rb'))
    T = Affine(RES, 0, ROOT_MIN_X - RES / 2, 0, RES, ROOT_MIN_Z - RES / 2)
    sea = features.rasterize([(water['sea'], 1)], out_shape=(N, N), transform=T, dtype=np.uint8, fill=0).astype(bool)
    dist = ndimage.distance_transform_edt(sea) * RES           # distance to the nearest land texel (m)
    nd = noaa_depth()
    depth = np.where(sea, np.where(nd > 0.3, nd, np.maximum(-h, 0.0)), 0.0)   # NOAA first, 3DEP where NOAA is empty
    # 3DEP mixes topobathy with land-lidar tiles whose water is hydro-flattened to ~0 m: those appear as rectangular
    # "0.3 m deep" patches around islands and shores. Treat flat near-zero sea texels away from the shore as missing and
    # fill them from the surrounding real bathymetry (nearest valid value, smoothed), shallowing toward the shore.
    valid = sea & (depth >= 1.0)            # real bathymetry
    missing = sea & ~valid
    if missing.any() and valid.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
        filled = depth[iy, ix]
        smooth = ndimage.gaussian_filter(filled, 5.0)
        depth = np.where(missing, smooth, depth)
    est = np.clip(dist * 0.012, 0.0, 60.0)                      # offshore where there is no bathymetry at all
    depth = np.where(sea & (depth < 0.05), est, depth)
    depth = np.where(sea, np.minimum(depth, 0.3 + dist * 0.12), 0.0)   # shoal toward every shore
    print('filled hydro-flattened texels:', int(missing.sum()))
    R = np.sqrt(np.clip(depth, 0, 60) / 60.0)
    G = np.sqrt(np.clip(dist, 0, 2000) / 2000.0)
    img = np.stack([R, G, np.zeros_like(R)], -1)
    img = np.clip(img * 255 + 0.5, 0, 255).astype(np.uint8)
    tmp = os.path.join(OUT, 'water_depth.tmp.png')
    Image.fromarray(img).save(tmp, optimize=True)
    os.replace(tmp, os.path.join(OUT, 'water_depth.png'))
    print('water_depth.png', img.shape, 'max depth', float(depth.max()))


if __name__ == '__main__':
    main()
