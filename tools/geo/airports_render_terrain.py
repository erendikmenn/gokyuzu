"""Extract a terrain heightfield + aerial imagery mosaic + water mask from W1's terrain pack for the Cycles renders.

Usage: .venv/bin/python tools/geo/airports_render_terrain.py <name> <cx> <cz> <half_size_m> [height_level=8] [img_level=8] [max_px=8192]
Output (scratch, gitignored): assets/sf/airports/render/<name>_h.npy (float32 [rows=z, cols=x]),
  <name>_img.jpg, <name>_water.png, <name>.json {x0, z0, size, n, spacing}
Format of W1's pack: assets/sf/terrain/index.json (heights: f32 hmin, f32 scale, u16[67*67] rows +z, 1-sample border,
packbits water; tiles in node order per level; imagery img/<L>/<i>_<j>.webp).
"""
import sys, os, json
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
T = os.path.join(ROOT, 'assets', 'sf', 'terrain')
OUT = os.path.join(ROOT, 'assets', 'sf', 'airports', 'render')


def main():
    name, cx, cz, R = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    Lh = int(sys.argv[5]) if len(sys.argv) > 5 else 8
    Li = int(sys.argv[6]) if len(sys.argv) > 6 else 8
    max_px = int(sys.argv[7]) if len(sys.argv) > 7 else 8192
    idx = json.load(open(os.path.join(T, 'index.json')))
    RS, RX, RZ, TB = idx['rootSize'], idx['rootMinX'], idx['rootMinZ'], idx['tileBytes']
    NS = idx['grid'] + 3          # 67
    rank = {}
    cnt = {}
    info = {}
    for n in idx['nodes']:
        L, i, j = n[0], n[1], n[2]
        rank[(L, i, j)] = cnt.get(L, 0)
        cnt[L] = cnt.get(L, 0) + 1
        info[(L, i, j)] = n
    x0, x1, z0, z1 = cx - R, cx + R, cz - R, cz + R
    # ---------------- heights
    size = RS / (1 << Lh)
    sp = size / idx['grid']
    i0, i1 = int((x0 - RX) // size), int((x1 - RX) // size)
    j0, j1 = int((z0 - RZ) // size), int((z1 - RZ) // size)
    nx, nz = (i1 - i0 + 1) * 64 + 1, (j1 - j0 + 1) * 64 + 1
    H = np.zeros((nz, nx), np.float32)
    Wm = np.zeros((nz, nx), np.uint8)
    f = open(os.path.join(T, 'h', f'{Lh}.bin'), 'rb')
    missing = 0
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            key = (Lh, i, j)
            if key not in rank:
                missing += 1            # all-water tile (not stored)
                r0, c0 = (j - j0) * 64, (i - i0) * 64
                Wm[r0:r0 + 65, c0:c0 + 65] = 1
                continue
            f.seek(rank[key] * TB)
            b = f.read(TB)
            hmin, scale = np.frombuffer(b, np.float32, 2)
            u = np.frombuffer(b, np.uint16, NS * NS, 8).reshape(NS, NS)
            h = hmin + u.astype(np.float32) * scale
            wb = np.unpackbits(np.frombuffer(b, np.uint8, offset=8 + NS * NS * 2))[:NS * NS].reshape(NS, NS)
            r0, c0 = (j - j0) * 64, (i - i0) * 64
            H[r0:r0 + 65, c0:c0 + 65] = h[1:66, 1:66]
            Wm[r0:r0 + 65, c0:c0 + 65] = wb[1:66, 1:66]
    print('height tiles missing', missing)
    gx0, gz0 = RX + i0 * size, RZ + j0 * size
    # ---------------- imagery
    isz = RS / (1 << Li)
    ii0, ii1 = int((x0 - RX) // isz), int((x1 - RX) // isz)
    jj0, jj1 = int((z0 - RZ) // isz), int((z1 - RZ) // isz)
    tiles_x, tiles_z = ii1 - ii0 + 1, jj1 - jj0 + 1
    px = 512
    mosaic = Image.new('RGB', (tiles_x * px, tiles_z * px), (60, 70, 60))
    for i in range(ii0, ii1 + 1):
        for j in range(jj0, jj1 + 1):
            p = os.path.join(T, 'img', str(Li), f'{i}_{j}.webp')
            if os.path.exists(p):
                mosaic.paste(Image.open(p).convert('RGB'), ((i - ii0) * px, (j - jj0) * px))
    s = min(1.0, max_px / max(mosaic.size))
    if s < 1:
        mosaic = mosaic.resize((int(mosaic.size[0] * s), int(mosaic.size[1] * s)), Image.LANCZOS)
    os.makedirs(OUT, exist_ok=True)
    mosaic.save(os.path.join(OUT, f'{name}_img.jpg'), quality=92)
    np.save(os.path.join(OUT, f'{name}_h.npy'), H)
    Image.fromarray(Wm * 255).save(os.path.join(OUT, f'{name}_water.png'))
    meta = {'hx0': gx0, 'hz0': gz0, 'hsp': sp, 'hn': [nx, nz], 'ix0': RX + ii0 * isz, 'iz0': RZ + jj0 * isz,
            'isize': [tiles_x * isz, tiles_z * isz]}
    json.dump(meta, open(os.path.join(OUT, f'{name}.json'), 'w'))
    print(name, meta, 'mosaic', mosaic.size, 'H range', float(H.min()), float(H.max()))


if __name__ == '__main__':
    main()
