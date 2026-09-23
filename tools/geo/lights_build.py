"""Time & weather: night lights of the Bay Area from OpenStreetMap roads + buildings (data/sf/cache/city/osm_*.json,
written by tools/geo/city_osm.py) and the 2 m terrain (data/sf/cache/terrain/h2.npy).

Outputs (read by src/world-sf/lights.js):
  assets/sf/lights/lamps.bin + lamps.json   street lamps, 1 km tiles: int16 dx, dz (dm from the tile corner),
                                            int16 y (dm MSL, lamp head), uint8 kind (bits 0-1 colour, bit 2 near water,
                                            bit 3 freeway), uint8 intensity
  assets/sf/lights/night_4096.png / night_2048.png   ground light map over the core area (RGB: R = white/LED light,
                                            G = sodium light, B = 0), light pools under the lamps + road glow + diffuse
                                            building light; emissive in the terrain shader at night, blurred mips light
                                            the fog and clouds from below.
Usage: .venv/bin/python tools/geo/lights_build.py
"""
import json, math, os, sys, time
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, os.path.dirname(__file__))
from geo import lonlat_to_local  # noqa: E402
from terrain_common import CORE, CACHE  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CITY = os.path.join(ROOT, 'data', 'sf', 'cache', 'city')
OUT = os.path.join(ROOT, 'assets', 'sf', 'lights')
X0, Z0 = CORE['x0'], CORE['z0']
SIZE = CORE['x1'] - CORE['x0']            # 38912 m square (covers the core z range too)
TILE = 1000.0

# class → (spacing m, side offset m, pole height m, intensity 0..1, both sides?)
CLASS = {
    'motorway': (48, 9.0, 12.0, 1.0, True), 'trunk': (44, 8.0, 11.0, 0.95, True),
    'motorway_link': (40, 5.0, 10.0, 0.8, False), 'trunk_link': (40, 5.0, 10.0, 0.8, False),
    'primary': (30, 8.0, 9.0, 0.85, True), 'primary_link': (32, 5.0, 8.5, 0.7, False),
    'secondary': (32, 7.5, 9.0, 0.8, True), 'secondary_link': (34, 5.0, 8.5, 0.65, False),
    'tertiary': (34, 6.5, 8.0, 0.7, False), 'tertiary_link': (36, 5.0, 8.0, 0.6, False),
    'residential': (38, 6.0, 7.5, 0.55, False), 'unclassified': (42, 6.0, 7.5, 0.5, False),
    'living_street': (30, 4.0, 5.0, 0.45, False), 'pedestrian': (24, 3.0, 4.5, 0.5, False),
    'service': (55, 4.0, 6.5, 0.4, False),
}
# road glow (headlights, light spill between lamps): line width (m), intensity
GLOW = {'motorway': (10, 0.5), 'trunk': (9, 0.4), 'motorway_link': (6, 0.28), 'trunk_link': (6, 0.28),
        'primary': (7, 0.3), 'secondary': (7, 0.24), 'tertiary': (6, 0.16), 'primary_link': (5, 0.18),
        'secondary_link': (5, 0.14), 'residential': (5, 0.08), 'unclassified': (5, 0.07), 'pedestrian': (4, 0.1)}
# colours: 0 LED 4000 K, 1 LED 3000 K, 2 sodium (HPS), 3 metal halide / mercury
LED_W, LED_WW, HPS, MH = 0, 1, 2, 3


def in_sf(x, z):
    """City and County of San Francisco (mostly LED since 2020): north of the county line, west of the bay."""
    return (z < -9700) & (x < 1500)


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    roads = json.load(open(os.path.join(CITY, 'osm_roads.json')))
    h2 = np.load(os.path.join(CACHE, 'h2.npy'), mmap_mode='r')
    NZ2, NX2 = h2.shape

    def height(x, z):
        i = np.clip(((x - CORE['x0']) / 2.0).astype(np.int64), 0, NX2 - 1)
        j = np.clip(((z - CORE['z0']) / 2.0).astype(np.int64), 0, NZ2 - 1)
        return np.asarray(h2[j, i], np.float32)

    # water mask (16 m) + distance to water, for "near water" (reflections) and to drop lamps over water (bridges)
    w16 = np.abs(np.asarray(h2[::8, ::8], np.float32)) < 0.3
    w16 = ndimage.binary_opening(w16, iterations=1)
    dist16 = ndimage.distance_transform_edt(~w16) * 16.0

    def water_dist(x, z):
        i = np.clip(((x - CORE['x0']) / 16.0).astype(np.int64), 0, w16.shape[1] - 1)
        j = np.clip(((z - CORE['z0']) / 16.0).astype(np.int64), 0, w16.shape[0] - 1)
        return dist16[j, i]

    # diffuse building light (windows, porches, signs, parking lots): footprint coverage, blurred
    blds = json.load(open(os.path.join(CITY, 'osm_buildings.json')))
    N, SS = 4096, 2
    res = SIZE / N
    bimg = Image.new('F', (N * SS, N * SS), 0.0)
    bd = ImageDraw.Draw(bimg)
    WEIGHT = {'commercial': 1.0, 'retail': 1.0, 'office': 0.9, 'hotel': 1.0, 'industrial': 0.45, 'warehouse': 0.35,
              'apartments': 0.8, 'residential': 0.55, 'house': 0.45, 'detached': 0.45, 'terrace': 0.6, 'school': 0.4,
              'hospital': 0.9, 'university': 0.6, 'church': 0.3, 'garage': 0.2, 'garages': 0.2, 'shed': 0.05, 'roof': 0.3}
    for b in blds:
        t = b['tags']
        kind = t.get('building', 'yes')
        wv = WEIGHT.get(kind, 0.5 if kind == 'yes' else 0.4)
        if 'shop' in t or 'amenity' in t:
            wv = max(wv, 0.9)
        for ring in b['rings']:
            o = np.array(ring['outer'], np.float64)
            if len(o) < 3:
                continue
            x, z = lonlat_to_local(o[:, 0], o[:, 1])
            pts = list(zip(((np.asarray(x) - X0) / res * SS).tolist(), ((np.asarray(z) - Z0) / res * SS).tolist()))
            bd.polygon(pts, fill=float(wv))
    del blds
    bl = np.asarray(bimg, np.float32).reshape(N, SS, N, SS).mean(axis=(1, 3))
    del bimg
    # urban mask (~150 m blur of the footprints): parks, open space and the headlands have no street lights
    urban = ndimage.gaussian_filter(bl, 16.0)
    bl = ndimage.gaussian_filter(bl, 1.6) * 0.8 + ndimage.gaussian_filter(bl, 6.0) * 0.4
    print(f'buildings rasterized ({time.time() - t0:.0f} s)')

    def urban_at(x, z):
        i = np.clip(((x - X0) / res).astype(np.int64), 0, N - 1)
        j = np.clip(((z - Z0) / res).astype(np.int64), 0, N - 1)
        return urban[j, i]

    rng = np.random.default_rng(7)
    lamps = []            # (x, z, pole, intensity, colour, freeway)
    glow_lines = []       # (class, local polyline)
    for r in roads:
        hw = r.get('highway')
        if hw not in CLASS:
            continue
        p = np.array(r['pts'], np.float64)
        x, z = lonlat_to_local(p[:, 0], p[:, 1])
        x = np.asarray(x); z = np.asarray(z)
        if x.max() < X0 or x.min() > X0 + SIZE or z.max() < Z0 or z.min() > Z0 + SIZE:
            continue
        seg = np.hypot(np.diff(x), np.diff(z))
        L = seg.sum()
        if hw in GLOW:
            glow_lines.append((hw, x, z))
        spacing, off, pole, inten, both = CLASS[hw]
        if hw == 'service' and L < 60:
            continue                           # driveways, short parking aisles: unlit
        if hw in ('residential', 'unclassified', 'service') and L < 25:
            continue
        cum = np.concatenate([[0], np.cumsum(seg)])
        start = rng.uniform(0.2, 0.8) * spacing
        s = np.arange(start, L, spacing)
        if not len(s):
            continue
        k = np.clip(np.searchsorted(cum, s, side='right') - 1, 0, len(seg) - 1)
        t = (s - cum[k]) / np.maximum(seg[k], 1e-6)
        px = x[k] + (x[k + 1] - x[k]) * t
        pz = z[k] + (z[k + 1] - z[k]) * t
        dx = (x[k + 1] - x[k]) / np.maximum(seg[k], 1e-6)
        dz = (z[k + 1] - z[k]) / np.maximum(seg[k], 1e-6)
        side = np.where(np.arange(len(s)) % 2 == 0, 1.0, -1.0) if both else np.full(len(s), 1.0 if (r['id'] % 2) else -1.0)
        lanes = r.get('lanes')
        try:
            extra = max(0.0, (float(str(lanes).split(';')[0]) - 2) * 1.6) if lanes else 0.0
        except ValueError:
            extra = 0.0
        o = off + extra
        px = px + (-dz) * o * side
        pz = pz + dx * o * side
        free = hw in ('motorway', 'trunk', 'motorway_link', 'trunk_link')
        sf = in_sf(px, pz)
        u = rng.random(len(s))
        if free:
            col = np.where(u < (0.45 if sf.any() else 0.7), HPS, LED_W)
        else:
            col = np.where(sf, np.where(u < 0.08, HPS, np.where(u < 0.55, LED_W, LED_WW)),
                           np.where(u < 0.35, HPS, np.where(u < 0.7, LED_W, LED_WW)))
            col = np.where((u > 0.985), MH, col)
        for i in range(len(s)):
            lamps.append((px[i], pz[i], pole * rng.uniform(0.9, 1.1), inten * rng.uniform(0.8, 1.1), int(col[i]), free))
    lamps = np.array([l[:4] for l in lamps], np.float64), np.array([l[4] for l in lamps], np.int32), np.array([l[5] for l in lamps], bool)
    P, C, F = lamps
    inside = (P[:, 0] >= X0) & (P[:, 0] < X0 + SIZE) & (P[:, 1] >= Z0) & (P[:, 1] < Z0 + SIZE)
    P, C, F = P[inside], C[inside], F[inside]
    g = height(P[:, 0], P[:, 1])
    wd = water_dist(P[:, 0], P[:, 1])
    ub = urban_at(P[:, 0], P[:, 1])
    keep = (wd > 8.0) & ((ub > 0.035) | (F & (ub > 0.012)))   # not over water (bridges: landmarks layer), only in town
    print(f'dropped {(~(ub > 0.035) & ~(F & (ub > 0.012))).sum()} rural/park lamps')
    P, C, F, g, wd = P[keep], C[keep], F[keep], g[keep], wd[keep]
    print(f'{len(P)} lamps ({time.time() - t0:.0f} s)')

    # ---------------- lamps.bin (1 km tiles) ----------------
    nt = int(math.ceil(SIZE / TILE))
    ti = np.clip(((P[:, 0] - X0) // TILE).astype(np.int64), 0, nt - 1)
    tj = np.clip(((P[:, 1] - Z0) // TILE).astype(np.int64), 0, nt - 1)
    tid = tj * nt + ti
    order = np.argsort(tid, kind='stable')
    P, C, F, g, wd, ti, tj, tid = P[order], C[order], F[order], g[order], wd[order], ti[order], tj[order], tid[order]
    counts = np.bincount(tid, minlength=nt * nt)
    rec = np.zeros(len(P), dtype=[('dx', '<i2'), ('dz', '<i2'), ('y', '<i2'), ('kind', 'u1'), ('inten', 'u1')])
    rec['dx'] = np.round((P[:, 0] - (X0 + ti * TILE)) * 10).astype(np.int16)
    rec['dz'] = np.round((P[:, 1] - (Z0 + tj * TILE)) * 10).astype(np.int16)
    rec['y'] = np.round((g + P[:, 2]) * 10).astype(np.int16)
    rec['kind'] = (C & 3) | (np.where(wd < 260, 4, 0)) | (np.where(F, 8, 0))
    rec['inten'] = np.clip(np.round(P[:, 3] * 230), 1, 255).astype(np.uint8)
    rec.tofile(os.path.join(OUT, 'lamps.bin'))
    json.dump({'x0': X0, 'z0': Z0, 'tile': TILE, 'n': nt, 'count': int(len(P)), 'record': 'int16 dx,dz (dm), int16 y (dm MSL), u8 kind, u8 intensity',
               'kinds': 'bits0-1 colour (0 LED 4000K, 1 LED 3000K, 2 sodium, 3 metal halide), bit2 near water, bit3 freeway',
               'counts': counts.astype(int).tolist()}, open(os.path.join(OUT, 'lamps.json'), 'w'), separators=(',', ':'))
    print(f'lamps.bin {os.path.getsize(os.path.join(OUT, "lamps.bin")) / 1e6:.2f} MB, near water {(wd < 260).sum()}')

    # ---------------- ground light map ----------------
    white = np.zeros((N, N), np.float32)
    sodium = np.zeros((N, N), np.float32)
    # lamp pools: bilinear splats, then a small blur (pool radius ~ 8 m)
    fx = (P[:, 0] - X0) / res - 0.5
    fz = (P[:, 1] - Z0) / res - 0.5
    ix, iz = np.floor(fx).astype(np.int64), np.floor(fz).astype(np.int64)
    ax, az = fx - ix, fz - iz
    w = P[:, 3]
    is_na = C == HPS
    for ox, oz, ww in ((0, 0, (1 - ax) * (1 - az)), (1, 0, ax * (1 - az)), (0, 1, (1 - ax) * az), (1, 1, ax * az)):
        xx, zz = np.clip(ix + ox, 0, N - 1), np.clip(iz + oz, 0, N - 1)
        np.add.at(white, (zz[~is_na], xx[~is_na]), (w * ww)[~is_na])
        np.add.at(sodium, (zz[is_na], xx[is_na]), (w * ww)[is_na])
    white = ndimage.gaussian_filter(white, 0.75)
    sodium = ndimage.gaussian_filter(sodium, 0.75)
    # road glow (2x supersampled anti-aliased lines)
    img = Image.new('F', (N * SS, N * SS), 0.0)
    dr = ImageDraw.Draw(img)
    for hw, x, z in sorted(glow_lines, key=lambda t: GLOW[t[0]][1]):
        wm, inten = GLOW[hw]
        pts = list(zip(((x - X0) / res * SS).tolist(), ((z - Z0) / res * SS).tolist()))
        dr.line(pts, fill=float(inten), width=max(1, int(round(wm / res * SS))))
    road = np.asarray(img, np.float32).reshape(N, SS, N, SS).mean(axis=(1, 3))
    road = ndimage.gaussian_filter(road, 0.6) * np.clip((urban - 0.01) / 0.04, 0.15, 1.0)
    print(f'roads rasterized ({time.time() - t0:.0f} s)')
    # water stays dark (the reflections are drawn separately)
    wl = np.asarray(Image.fromarray(w16.astype(np.uint8) * 255).resize((N, N), Image.BILINEAR), np.float32) / 255.0
    land = np.clip(1.0 - wl, 0, 1)
    # compose: tone curve into 8 bits (sqrt keeps dim residential light and bright freeways in range)
    W = (white * 1.0 + road * 0.32 + bl * 0.035) * land
    S = (sodium * 1.0 + road * 0.14 + bl * 0.018) * land
    enc = lambda a: np.clip(np.sqrt(np.clip(a, 0, None) / 1.6) * 255.0, 0, 255).astype(np.uint8)
    rgb = np.stack([enc(W), enc(S), np.zeros((N, N), np.uint8)], axis=-1)
    Image.fromarray(rgb, 'RGB').save(os.path.join(OUT, 'night_4096.png'), optimize=True)
    small = np.stack([enc(W.reshape(2048, 2, 2048, 2).mean(axis=(1, 3))), enc(S.reshape(2048, 2, 2048, 2).mean(axis=(1, 3))), np.zeros((2048, 2048), np.uint8)], axis=-1)
    Image.fromarray(small, 'RGB').save(os.path.join(OUT, 'night_2048.png'), optimize=True)
    json.dump({'x0': X0, 'z0': Z0, 'size': SIZE, 'encoding': 'light = (v/255)^2 * 1.6; R white/LED, G sodium; row 0 = z0 (north), col 0 = x0'},
              open(os.path.join(OUT, 'night.json'), 'w'))
    for f in ('night_4096.png', 'night_2048.png'):
        print(f, f'{os.path.getsize(os.path.join(OUT, f)) / 1e6:.2f} MB')
    print(f'done in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
