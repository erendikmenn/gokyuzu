"""Download the elevation data for the terrain pipeline (per map, see terrain_common.py).

sf  (GEO_REGION unset): USGS 3DEP (bare earth, incl. topobathy in SF Bay)
  core: 2 m grid over CORE (tiles of 4096 m = 2048 px)
  far : 16 m grid over the whole quadtree root (tiles of 32768 m = 2048 px)
  Sample centers are placed exactly on the mesh vertex grid (bbox shifted by half a pixel).
  Cached as float32 GeoTIFF in data/sf/raw/3dep/<set>/<i>_<j>.tif. Re-runnable (skips existing files).
ist (GEO_REGION=ist): Copernicus DEM GLO-30 (AWS Open Data bucket copernicus-dem-30m, anonymous HTTPS, 1" tiles in
  EPSG:4326, heights above the EGM2008 geoid ~ MSL). A DSM: buildings / tree canopy are removed later (terrain_build.py).
  Tiles -> data/ist/_cache/raw/copdem/, then resampled (cubic) into the region's UTM zone with sample centres on the
  vertex grid: copdem/core.tif (CORE_RES over CORE, +1 sample) and copdem/far16.tif (16 m over the root, 8193²).
Usage: .venv/bin/python tools/geo/terrain_download.py [core|far|all]
"""
import os, sys
from concurrent.futures import ThreadPoolExecutor
import requests
from terrain_common import (RAW, CORE, FAR, CORE_RES, EPSG, DEM_SOURCE, USER_AGENT, local_to_utm_box, fetch)

URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'


def jobs(area, res, px, name):
    span = res * px
    out = []
    nx = int(-(-(area['x1'] - area['x0']) // span))
    nz = int(-(-(area['z1'] - area['z0']) // span))
    for j in range(nz):
        for i in range(nx):
            x0 = area['x0'] + i * span - res / 2
            z0 = area['z0'] + j * span - res / 2
            bbox = local_to_utm_box(x0, z0, x0 + span, z0 + span)
            params = dict(bbox=','.join(f'{v:.3f}' for v in bbox), bboxSR=EPSG, imageSR=EPSG, size=f'{px},{px}',
                          format='tiff', pixelType='F32', noData=-9999, noDataInterpretation='esriNoDataMatchAny',
                          interpolation='RSP_BilinearInterpolation', f='image')
            out.append((params, os.path.join(RAW, '3dep', name, f'{i}_{j}.tif')))
    return out


def main_3dep(which):
    todo = []
    if which in ('far', 'all'):
        todo += jobs(FAR, 16.0, 2048, 'far16')
    if which in ('core', 'all'):
        todo += jobs(CORE, 2.0, 2048, 'core2')
    sess = requests.Session()
    done = [0]

    def run(job):
        params, out = job
        fetch(URL, params, out, session=sess)
        done[0] += 1
        if done[0] % 5 == 0:
            print(f'dem {done[0]}/{len(todo)}', flush=True)

    with ThreadPoolExecutor(3) as ex:
        list(ex.map(run, todo))
    print('dem done', len(todo), flush=True)


# ---------------------------------------------------------------- Copernicus DEM GLO-30 (ist)
COP_URL = 'https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif'


def cop_tiles():
    """1° tile names covering the quadtree root (+ a small margin for the resampling kernel)."""
    from geo import local_to_lonlat
    import math
    lons, lats = [], []
    for x in (FAR['x0'], FAR['x1']):
        for z in (FAR['z0'], FAR['z1']):
            lo, la = local_to_lonlat(x, z)
            lons.append(lo)
            lats.append(la)
    out = []
    for la in range(math.floor(min(lats) - 0.01), math.floor(max(lats) + 0.01) + 1):
        for lo in range(math.floor(min(lons) - 0.01), math.floor(max(lons) + 0.01) + 1):
            ns, ew = ('N' if la >= 0 else 'S'), ('E' if lo >= 0 else 'W')
            out.append(f'Copernicus_DSM_COG_10_{ns}{abs(la):02d}_00_{ew}{abs(lo):03d}_00_DEM')
    return out


def resample_grid(srcs, x0, z0, res, nx, nz, out):
    """Cubic resample of the EPSG:4326 tiles onto a grid whose sample centres are x0 + i*res, z0 + j*res (local)."""
    import numpy as np
    import rasterio
    from rasterio.merge import merge
    from rasterio.warp import reproject, Resampling
    from affine import Affine
    from geo import CRS, E0, N0
    if os.path.exists(out):
        print('cached', out)
        return
    ds = [rasterio.open(p) for p in srcs]
    mos, mt = merge(ds)
    src_crs = ds[0].crs
    for d in ds:
        d.close()
    # rows go +z = south: row 0 is the northern edge (UTM y = N0 - z0), pixel centres on the vertex grid
    T = Affine(res, 0, E0 + x0 - res / 2, 0, -res, N0 - z0 + res / 2)
    dst = np.full((nz, nx), np.nan, np.float32)
    reproject(mos[0], dst, src_transform=mt, src_crs=src_crs, dst_transform=T, dst_crs=CRS,
              resampling=Resampling.cubic, src_nodata=None, dst_nodata=np.nan, num_threads=8)
    bad = ~np.isfinite(dst)
    print(f'{os.path.basename(out)}: {nx}x{nz} at {res} m, {int(bad.sum())} empty samples, '
          f'h {np.nanmin(dst):.1f}..{np.nanmax(dst):.1f}', flush=True)
    dst[bad] = 0.0
    tmp = out + '.part.tif'
    with rasterio.open(tmp, 'w', driver='GTiff', width=nx, height=nz, count=1, dtype='float32', crs=CRS, transform=T,
                       compress='deflate', predictor=3, tiled=True, blockxsize=512, blockysize=512) as o:
        o.write(dst, 1)
    os.replace(tmp, out)


def main_copernicus(which):
    d = os.path.join(RAW, 'copdem')
    os.makedirs(d, exist_ok=True)
    sess = requests.Session()
    sess.headers['User-Agent'] = USER_AGENT
    srcs = []
    for n in cop_tiles():
        p = os.path.join(d, n + '.tif')
        fetch(COP_URL.format(n=n), None, p, session=sess, min_bytes=100000)
        srcs.append(p)
    print('copernicus tiles', len(srcs), flush=True)
    if which in ('far', 'all'):
        n16 = int((FAR['x1'] - FAR['x0']) / 16.0) + 1
        resample_grid(srcs, FAR['x0'], FAR['z0'], 16.0, n16, n16, os.path.join(d, 'far16.tif'))
    if which in ('core', 'all'):
        nx = int((CORE['x1'] - CORE['x0']) / CORE_RES) + 1
        nz = int((CORE['z1'] - CORE['z0']) / CORE_RES) + 1
        resample_grid(srcs, CORE['x0'], CORE['z0'], CORE_RES, nx, nz, os.path.join(d, 'core.tif'))


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if DEM_SOURCE == '3dep':
        main_3dep(which)
    else:
        main_copernicus(which)


if __name__ == '__main__':
    main()
