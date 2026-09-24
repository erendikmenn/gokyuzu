"""Global water info texture for the water shader: assets/sf/terrain/water_depth.png (RGB, 4096², 32 m/texel over the
quadtree root, texel k centre at rootMin + 32k):
  R = sqrt(depth / 60 m)                       (3DEP topobathy in the bay/nearshore; distance-based estimate offshore)
  G = sqrt(min(distance to shore, 2000 m) / 2000)   (smooth, global -> surf bands, turbidity, foam)
Inputs: NOAA NCEI DEM mosaic (topobathy; downloaded + cached in data/sf/raw/noaa/), cached 3DEP mosaics (data/sf/raw/3dep)
and data/sf/cache/terrain/water_final.pkl (terrain_build.py). 3DEP water is often hydro-flattened (~0 m) in land-lidar
tiles, so NOAA is used wherever it has data and 3DEP elsewhere.
ist (GEO_REGION=ist): depth from EMODnet Bathymetry (DTM mean, ~115 m, free WCS, cached in data/ist/_cache/raw/emodnet/;
Copernicus DEM has the sea at 0 m), same R / G encoding, plus
  B = open-sea weight (0 = sheltered: Boğaz, Haliç, bays, lakes; 1 = open Marmara / Karadeniz), from the distance to
      shore over a large neighbourhood (smooth); the current shader does not read B (its "ocean" factor is a San
      Francisco x/z rule), an engine that wants İstanbul surf / open-water colour can use it instead.
Usage: .venv/bin/python tools/geo/terrain_waterinfo.py
"""
import os, pickle
import numpy as np
import rasterio
from rasterio import features
from affine import Affine
from scipy import ndimage
from PIL import Image
from terrain_common import RAW, CACHE, OUT, ROOT_MIN_X, ROOT_MIN_Z, CORE, EPSG, DEM_SOURCE, USER_AGENT, local_to_utm_box, fetch

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
            fetch(NOAA_URL, dict(bbox=','.join(f'{v:.3f}' for v in bbox), bboxSR=EPSG, imageSR=EPSG, size=f'{px},{px}',
                                 format='tiff', pixelType='F32', noData=-9999, interpolation='RSP_BilinearInterpolation',
                                 f='image'), path)
            with rasterio.open(path) as src:
                a = src.read(1)
            a = np.where(a < -9000, 0.0, a)
            out[j * px:(j + 1) * px, i * px:(i + 1) * px] = np.maximum(-a, 0.0)
    return out


EMODNET_URL = 'https://ows.emodnet-bathymetry.eu/wcs'


def emodnet_depth():
    """EMODnet Bathymetry DTM (mean) on the texture grid (texel centres at rootMin + 32k); positive = below sea level."""
    from rasterio.warp import reproject, Resampling
    from geo import local_to_lonlat, CRS, E0, N0
    path = os.path.join(RAW, 'emodnet', 'mean.tif')
    if not os.path.exists(path):
        lons, lats = zip(*[local_to_lonlat(x, z) for x in (ROOT_MIN_X, ROOT_MIN_X + N * RES) for z in (ROOT_MIN_Z, ROOT_MIN_Z + N * RES)])
        import requests
        s = requests.Session()
        s.headers['User-Agent'] = USER_AGENT
        fetch(EMODNET_URL + f'?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=emodnet__mean&FORMAT=image/tiff'
              f'&SUBSET=Lat({min(lats) - 0.1:.2f},{max(lats) + 0.1:.2f})&SUBSET=Long({min(lons) - 0.1:.2f},{max(lons) + 0.1:.2f})',
              None, path, session=s)
    with rasterio.open(path) as src:
        a = src.read(1).astype(np.float32)
        T, crs = src.transform, src.crs
    a = np.where(np.isfinite(a) & (a > -9000), a, np.nan)
    out = np.full((N, N), np.nan, np.float32)
    D = Affine(RES, 0, E0 + ROOT_MIN_X - RES / 2, 0, -RES, N0 - ROOT_MIN_Z + RES / 2)
    reproject(a, out, src_transform=T, src_crs=crs, dst_transform=D, dst_crs=CRS, resampling=Resampling.bilinear,
              src_nodata=np.nan, dst_nodata=np.nan)
    return np.maximum(-np.nan_to_num(out, nan=0.0), 0.0)


def main_emodnet():
    water = pickle.load(open(os.path.join(CACHE, 'water_final.pkl'), 'rb'))
    T = Affine(RES, 0, ROOT_MIN_X - RES / 2, 0, RES, ROOT_MIN_Z - RES / 2)
    sea = features.rasterize([(water['sea'], 1)], out_shape=(N, N), transform=T, dtype=np.uint8, fill=0).astype(bool)
    lakes = features.rasterize([(g, 1) for g in water['lakes']], out_shape=(N, N), transform=T, dtype=np.uint8,
                               fill=0).astype(bool) if water['lakes'] else np.zeros((N, N), bool)
    dist = ndimage.distance_transform_edt(sea) * RES           # distance to the nearest land texel (m)
    em = emodnet_depth()
    depth = np.where(sea, em, 0.0)
    # EMODnet is ~115 m: along the shore and in narrow water (Haliç, harbours) it may say land / 0 m -> fill from the
    # nearest real value, then shoal toward every shore like sf
    valid = sea & (depth >= 1.0)
    missing = sea & ~valid
    if missing.any() and valid.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
        depth = np.where(missing, ndimage.gaussian_filter(depth[iy, ix], 3.0), depth)
    depth = np.where(sea, np.minimum(depth, 0.3 + dist * 0.12), 0.0)
    # lakes: shallow toward the shore, a few metres in the middle (no bathymetry)
    ldist = ndimage.distance_transform_edt(lakes) * RES
    depth = np.where(lakes, np.minimum(0.3 + ldist * 0.05, 8.0), depth)
    dist = np.where(lakes, ldist, dist)
    # open-sea weight: large distance to shore, smoothed (Boğaz ~0.5 km wide -> 0, open Marmara -> 1)
    ocean = np.clip((ndimage.gaussian_filter(np.where(sea, np.minimum(dist, 6000.0), 0.0), 40.0) - 700.0) / 2300.0, 0, 1)
    ocean = np.where(sea, ocean, 0.0)
    print('depth max', float(depth.max()), 'sea texels', int(sea.sum()), 'lake texels', int(lakes.sum()),
          'open sea', float(ocean[sea].mean()) if sea.any() else 0)
    R = np.sqrt(np.clip(depth, 0, 60) / 60.0)
    G = np.sqrt(np.clip(dist, 0, 2000) / 2000.0)
    img = np.stack([R, G, ocean], -1)
    img = np.clip(img * 255 + 0.5, 0, 255).astype(np.uint8)
    tmp = os.path.join(OUT, 'water_depth.tmp.png')
    Image.fromarray(img).save(tmp, optimize=True)
    os.replace(tmp, os.path.join(OUT, 'water_depth.png'))
    print('water_depth.png', img.shape)


def main():
    if DEM_SOURCE != '3dep':
        return main_emodnet()
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
