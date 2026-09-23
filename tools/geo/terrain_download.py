"""Download USGS 3DEP elevation (bare earth, incl. topobathy in SF Bay) for the terrain pipeline.

  core: 2 m grid over CORE (tiles of 4096 m = 2048 px)
  far : 16 m grid over the whole quadtree root (tiles of 32768 m = 2048 px)
Sample centers are placed exactly on the mesh vertex grid (bbox shifted by half a pixel).
Cached as float32 GeoTIFF in data/sf/raw/3dep/<set>/<i>_<j>.tif. Re-runnable (skips existing files).
Usage: .venv/bin/python tools/geo/terrain_download.py [core|far|all]
"""
import os, sys
from concurrent.futures import ThreadPoolExecutor
import requests
from terrain_common import RAW, CORE, FAR, local_to_utm_box, fetch

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
            params = dict(bbox=','.join(f'{v:.3f}' for v in bbox), bboxSR=32610, imageSR=32610, size=f'{px},{px}',
                          format='tiff', pixelType='F32', noData=-9999, noDataInterpretation='esriNoDataMatchAny',
                          interpolation='RSP_BilinearInterpolation', f='image')
            out.append((params, os.path.join(RAW, '3dep', name, f'{i}_{j}.tif')))
    return out


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
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


if __name__ == '__main__':
    main()
