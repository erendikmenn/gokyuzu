"""Download USGS NAIP orthoimagery (public domain) directly in EPSG:32610.

  core: 1 m/px over CORE  (2048 m boxes = 2048 px)
  mid : 4 m/px over MID   (8192 m boxes)
  far : 16 m/px over the whole quadtree root (32768 m boxes)
Pixel-is-area: box edges = tile edges, so texel centers sit at (i + 0.5) * res like a GPU texture.
Cached as JPEG (q95) in data/sf/raw/naip/<set>/<i>_<j>.jpg. Re-runnable.
Usage: .venv/bin/python tools/geo/imagery_download.py [core|mid|far|all]
"""
import os, sys
from concurrent.futures import ThreadPoolExecutor
import requests
from terrain_common import RAW, CORE, MID, FAR, local_to_utm_box, fetch

URL = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage'


def jobs(area, res, px, name):
    span = res * px
    out = []
    nx = int(-(-(area['x1'] - area['x0']) // span))
    nz = int(-(-(area['z1'] - area['z0']) // span))
    for j in range(nz):
        for i in range(nx):
            x0 = area['x0'] + i * span
            z0 = area['z0'] + j * span
            bbox = local_to_utm_box(x0, z0, x0 + span, z0 + span)
            params = dict(bbox=','.join(f'{v:.3f}' for v in bbox), bboxSR=32610, imageSR=32610, size=f'{px},{px}',
                          format='jpg', bandIds='0,1,2', compressionQuality=95,
                          interpolation='RSP_BilinearInterpolation', f='image')
            out.append((params, os.path.join(RAW, 'naip', name, f'{i}_{j}.jpg')))
    return out


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    todo = []
    if which in ('far', 'all'):
        todo += jobs(FAR, 16.0, 2048, 'far16')
    if which in ('mid', 'all'):
        todo += jobs(MID, 4.0, 2048, 'mid4')
    if which in ('core', 'all'):
        todo += jobs(CORE, 1.0, 2048, 'core1')
    sess = requests.Session()
    done = [0]

    def run(job):
        params, out = job
        fetch(URL, params, out, session=sess, min_bytes=5000)
        done[0] += 1
        if done[0] % 10 == 0:
            print(f'naip {done[0]}/{len(todo)}', flush=True)

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(run, todo))
    print('naip done', len(todo), flush=True)


if __name__ == '__main__':
    main()
