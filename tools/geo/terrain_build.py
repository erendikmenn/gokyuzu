"""Build the streaming terrain quadtree (heights + water flags) from the cached 3DEP/OSM downloads.

Inputs : data/sf/raw/3dep/{core2,far16}/*.tif (terrain_download.py), data/sf/cache/terrain/water.pkl (terrain_water.py),
         data/sf/runways.json
Outputs: assets/sf/terrain/h.next/<L>.bin + data/sf/cache/terrain/index_terrain.json (published by imagery_build.py),
         assets/sf/terrain/water_depth.png, data/sf/cache/terrain/*.npy (processed grids)
See assets/sf/terrain/README.md for the format.
Usage: .venv/bin/python tools/geo/terrain_build.py
"""
import os, json, pickle, time, shutil
import numpy as np
import rasterio
from rasterio import features
from affine import Affine
from scipy import ndimage
from shapely.geometry import box, Polygon, Point
from terrain_common import (RAW, CACHE, OUT, ROOT, ROOT_SIZE, ROOT_MIN_X, ROOT_MIN_Z, CORE, MID, GRID, SUN_EL, SUN_AZ)

T0 = time.time()
def log(*a):
    print(f'[{time.time() - T0:6.1f}s]', *a, flush=True)

D2, D16 = 2.0, 16.0
NX2 = int((CORE['x1'] - CORE['x0']) / D2) + 1
NZ2 = int((CORE['z1'] - CORE['z0']) / D2) + 1
N16 = int(ROOT_SIZE / D16) + 1
CORE_OFF16 = (int((CORE['x0'] - ROOT_MIN_X) / D16), int((CORE['z0'] - ROOT_MIN_Z) / D16))
MAX_CORE, MAX_MID, MAX_FAR = 10, 7, 6
IMG_CORE, IMG_MID, IMG_FAR = 8, 6, 4   # deepest imagery level per area (see imagery_build.py)
EPS = {9: 1.0}            # m: a node is refined only if its geometric error exceeds this (per level)
EPS_DEFAULT = 0.4
TILE_BYTES = 8 + 67 * 67 * 2 + (67 * 67 + 7) // 8 + 65 * 65
RUNWAY_SHOULDER = 60.0
BLEND = 150.0


def load_mosaic(name, n, px):
    a = np.empty((n * px, n * px), np.float32)
    for j in range(n):
        for i in range(n):
            with rasterio.open(os.path.join(RAW, '3dep', name, f'{i}_{j}.tif')) as src:
                a[j * px:(j + 1) * px, i * px:(i + 1) * px] = src.read(1)
    return a


def rasterize(shapes, x0, z0, d, shape, dtype=np.uint8):
    T = Affine(d, 0, x0 - d / 2, 0, d, z0 - d / 2)   # pixel centers on the vertex grid
    shapes = [(g, v) for g, v in shapes if not g.is_empty]
    if not shapes:
        return np.zeros(shape, dtype)
    return features.rasterize(shapes, out_shape=shape, transform=T, dtype=dtype, fill=0)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def runway_polys(runways, extra):
    out = []
    for apt in runways['airports']:
        for r in apt['runways']:
            a, b = r['ends']
            ax, az, bx, bz = a['x'], a['z'], b['x'], b['z']
            L = np.hypot(bx - ax, bz - az)
            ux, uz = (bx - ax) / L, (bz - az) / L
            px, pz = -uz, ux
            hw = r['width'] / 2 + extra
            e = extra
            pts = [(ax - ux * e + px * hw, az - uz * e + pz * hw), (bx + ux * e + px * hw, bz + uz * e + pz * hw),
                   (bx + ux * e - px * hw, bz + uz * e - pz * hw), (ax - ux * e - px * hw, az - uz * e - pz * hw)]
            out.append((apt, r, Polygon(pts)))
    return out


def filter_down(a):
    """Vertex-centered 2x decimation with a [1 2 1]/4 prefilter (edges replicated)."""
    k = np.array([0.25, 0.5, 0.25], np.float32)
    b = ndimage.convolve1d(a, k, axis=0, mode='nearest')
    b = ndimage.convolve1d(b, k, axis=1, mode='nearest')
    return np.ascontiguousarray(b[::2, ::2])


def upsample(a, f):
    """Vertex-aligned bilinear upsample by integer factor f: (n, m) -> ((n-1)f+1, (m-1)f+1)."""
    if f == 1:
        return a
    t = (np.arange(f, dtype=np.float32) / f)
    b = (a[:, :-1, None] * (1 - t) + a[:, 1:, None] * t).reshape(a.shape[0], -1)
    b = np.concatenate([b, a[:, -1:]], 1)
    c = (b[:-1, None, :] * (1 - t)[None, :, None] + b[1:, None, :] * t[None, :, None]).reshape(-1, b.shape[1])
    return np.concatenate([c, b[-1:]], 0)


def block_max(err, B):
    """Max over B x B sample blocks sharing edges: err shape ((n*B)+1, (m*B)+1) -> (n, m)."""
    n, m = (err.shape[0] - 1) // B, (err.shape[1] - 1) // B
    e = err[:n * B + 1, :m * B + 1]
    core = e[:n * B, :m * B].reshape(n, B, m, B).max(axis=(1, 3))
    # include the far edges (shared with the next block)
    right = e[:n * B, B::B][:, :m].reshape(n, B, m).max(axis=1)
    bottom = e[B::B, :m * B][:n].reshape(n, m, B).max(axis=2)
    return np.maximum(core, np.maximum(right, bottom))


def sun_excess(h, d, max_dist):
    """Max over the ray toward the sun of (terrain height - ray height); > 0 = in the shadow of a hill.
    Horizon sweep with nearest-sample steps along the sun azimuth (grid rows = +z, cols = +x)."""
    az, el = np.radians(SUN_AZ), np.radians(SUN_EL)
    dx, dz = np.sin(az), -np.cos(az)          # horizontal direction toward the sun
    tan_el = np.tan(el)
    H, W = h.shape
    ex = np.full(h.shape, -1e9, np.float32)
    steps = int(max_dist / d)
    for k in range(1, steps + 1):
        oi, oj = int(round(dx * k)), int(round(dz * k))   # sample offsets (cols, rows)
        dist = d * np.hypot(oi, oj)
        if oi == 0 and oj == 0:
            continue
        # shifted view: sh[j, i] = h[j + oj, i + oi] (outside -> -inf)
        sj0, sj1 = max(0, -oj), min(H, H - oj)
        si0, si1 = max(0, -oi), min(W, W - oi)
        if sj0 >= sj1 or si0 >= si1:
            break
        tgt = ex[sj0:sj1, si0:si1]
        np.maximum(tgt, h[sj0 + oj:sj1 + oj, si0 + oi:si1 + oi] - h[sj0:sj1, si0:si1] - dist * tan_el, out=tgt)
    return ex


def sun_vis(ex):
    return (1.0 - np.clip((ex + 2.0) / 14.0, 0.0, 1.0)).astype(np.float32)   # soft penumbra


def main():
    runways = json.load(open(os.path.join(ROOT, 'data', 'sf', 'runways.json')))
    water = pickle.load(open(os.path.join(CACHE, 'water.pkl'), 'rb'))
    rw_land = runway_polys(runways, RUNWAY_SHOULDER)
    land_force = [p for _, _, p in rw_land]
    sea = water['sea']
    for p in land_force:
        sea = sea.difference(p)
    lakes = [g for g in water['lakes']]
    # final water geometry, shared with the imagery build
    pickle.dump({'sea': sea, 'lakes': lakes}, open(os.path.join(CACHE, 'water_final.pkl'), 'wb'))

    # ---------------- core 2 m ----------------
    log('loading core mosaic')
    h2 = load_mosaic('core2', 10, 2048)[:NZ2, :NX2].copy()
    core_box = box(CORE['x0'] - 50, CORE['z0'] - 50, CORE['x1'] + 50, CORE['z1'] + 50)
    log('rasterize water (core)')
    sea2 = rasterize([(sea.intersection(core_box), 1)], CORE['x0'], CORE['z0'], D2, h2.shape).astype(bool)
    lake_shapes = [(g, i + 1) for i, g in enumerate(lakes) if g.intersects(core_box)]
    lake2 = rasterize(lake_shapes, CORE['x0'], CORE['z0'], D2, h2.shape, np.int32)
    lake2[sea2] = 0
    bathy2 = np.where(sea2, np.maximum(-h2, 0.0), 0).astype(np.float32)
    # water levels: sea = 0, lakes = DEM level (hydro-flattened surface; shore ring if the interior has bathymetry)
    wl2 = np.full(h2.shape, np.nan, np.float32)
    wl2[sea2] = 0.0
    ids = np.unique(lake2)
    ids = ids[ids > 0]
    if len(ids):
        med = np.array(ndimage.median(h2, lake2, ids))
        p10 = np.array(ndimage.labeled_comprehension(h2, lake2, ids, lambda v: np.percentile(v, 10), np.float64, 0))
        p90 = np.array(ndimage.labeled_comprehension(h2, lake2, ids, lambda v: np.percentile(v, 90), np.float64, 0))
        ring_lab = ndimage.grey_dilation(lake2, size=5)
        ring_lab[(lake2 > 0) | sea2] = 0
        ring = np.array(ndimage.median(h2, ring_lab, ids))
        level = np.where(p90 - p10 > 0.6, ring - 0.3, med)
        level = np.where(np.isnan(level), med, level)
        lut = np.zeros(lake2.max() + 1, np.float32)
        lut[ids] = level
        wl2 = np.where(lake2 > 0, lut[lake2], wl2)
        log('lakes in core', len(ids))
    water2 = ~np.isnan(wl2)
    h2 = np.where(water2, wl2, h2).astype(np.float32)

    # ---------------- airports: flatten aerodrome + runway rectangles to the airport elevation ----------------
    for apt in runways['airports']:
        elev = apt['elevation']
        cx, cz = apt['center']['x'], apt['center']['z']
        R = 5000
        x0, x1 = max(CORE['x0'], cx - R), min(CORE['x1'], cx + R)
        z0, z1 = max(CORE['z0'], cz - R), min(CORE['z1'], cz + R)
        i0, i1 = int((x0 - CORE['x0']) / D2), int((x1 - CORE['x0']) / D2) + 1
        j0, j1 = int((z0 - CORE['z0']) / D2), int((z1 - CORE['z0']) / D2) + 1
        wx0, wz0 = CORE['x0'] + i0 * D2, CORE['z0'] + j0 * D2
        shape = (j1 - j0, i1 - i0)
        zone_polys = [p for a, _, p in rw_land if a['icao'] == apt['icao']]
        for ad in water.get('aerodromes', []):
            if ad.contains(Point(cx, cz)) or any(ad.contains(p.centroid) for p in zone_polys):
                zone_polys.append(ad.buffer(-30))
        zone = rasterize([(p, 1) for p in zone_polys], wx0, wz0, D2, shape).astype(bool)
        din = ndimage.distance_transform_edt(zone) * D2
        w_zone = smoothstep(0, BLEND, din)
        rw = rasterize([(p, 1) for a, _, p in rw_land if a['icao'] == apt['icao']], wx0, wz0, D2, shape).astype(bool)
        dout = ndimage.distance_transform_edt(~rw) * D2
        w_rw = 1 - smoothstep(0, BLEND, dout)
        w = np.maximum(w_zone, w_rw).astype(np.float32)
        sub = h2[j0:j1, i0:i1]
        land = ~water2[j0:j1, i0:i1]
        h2[j0:j1, i0:i1] = np.where(land, sub + (elev - sub) * w, sub)
        log('flattened', apt['icao'], 'to', elev, 'zone polys', len(zone_polys))

    # soften sea shorelines (after the airport flattening; runway pavement excluded): the first ~3 land samples next to the sea become a ramp, so a rasterized coastline does not
    # render as a vertical staircase wall (the water surface stays flat at 0)
    log('shore ramp')
    dl = ndimage.distance_transform_edt(~sea2)
    band = (~water2) & (dl <= 3.5)
    hs = ndimage.gaussian_filter(h2, 1.3)
    wr = np.clip(1.0 - (dl - 1.0) / 3.0, 0.0, 1.0).astype(np.float32)
    rw_core = rasterize([(q, 1) for _, _, q in runway_polys(runways, 3.0)],
                        CORE['x0'], CORE['z0'], D2, h2.shape).astype(bool)   # runway pavement (+3 m) stays exact
    band &= ~rw_core
    h2 = np.where(band, h2 + (np.minimum(hs, h2) - h2) * wr, h2).astype(np.float32)
    del dl, band, hs, wr

    # ---------------- far 16 m ----------------
    log('loading far mosaic')
    h16 = np.pad(load_mosaic('far16', 4, 2048), ((0, 1), (0, 1)), mode='edge')
    sea16 = rasterize([(sea, 1)], ROOT_MIN_X, ROOT_MIN_Z, D16, h16.shape).astype(bool)
    lake16 = rasterize([(g, i + 1) for i, g in enumerate(lakes)], ROOT_MIN_X, ROOT_MIN_Z, D16, h16.shape, np.int32)
    lake16[sea16] = 0
    wl16 = np.full(h16.shape, np.nan, np.float32)
    wl16[sea16] = 0
    ids16 = np.unique(lake16)
    ids16 = ids16[ids16 > 0]
    if len(ids16):
        med = np.array(ndimage.median(h16, lake16, ids16))
        lut = np.zeros(lake16.max() + 1, np.float32)
        lut[ids16] = med
        wl16 = np.where(lake16 > 0, lut[lake16], wl16)
    bathy16 = np.where(sea16, np.maximum(-h16, 0.0), 0).astype(np.float32)
    h16 = np.where(~np.isnan(wl16), wl16, h16).astype(np.float32)

    # ---------------- core pyramid (P0 = 2 m ... P3 = 16 m) ----------------
    log('core pyramid')
    P, W = [h2], [wl2]
    for k in range(3):
        wk = W[-1][::2, ::2]
        pk = filter_down(P[-1])
        pk = np.where(~np.isnan(wk), wk, pk).astype(np.float32)
        P.append(pk)
        W.append(np.ascontiguousarray(wk))
    # splice the core into the far grid at 16 m
    ox, oz = CORE_OFF16
    G7 = h16.copy()
    WL7 = wl16.copy()
    G7[oz:oz + P[3].shape[0], ox:ox + P[3].shape[1]] = P[3]
    WL7[oz:oz + P[3].shape[0], ox:ox + P[3].shape[1]] = W[3]
    G, GW = {7: G7}, {7: WL7}
    for L in range(6, -1, -1):
        wk = GW[L + 1][::2, ::2]
        gk = filter_down(G[L + 1])
        G[L] = np.where(~np.isnan(wk), wk, gk).astype(np.float32)
        GW[L] = np.ascontiguousarray(wk)

    # ---------------- baked sun visibility (terrain cast shadows for the fixed late-afternoon sun) ----------------
    log('sun shadows (core 8 m)')
    vis_core = sun_vis(sun_excess(P[2], 8.0, 5000.0))        # core at 8 m (same grid as P[2])
    log('sun shadows (root 32 m)')
    vis_glob = sun_vis(sun_excess(G[6], 32.0, 24000.0))      # whole root at 32 m (G[6])
    np.save(os.path.join(CACHE, 'sunvis_core8.npy'), vis_core)

    def sample_vis(L, i, j):
        s = ROOT_SIZE / (1 << L)
        xs = ROOT_MIN_X + i * s + np.arange(65) * (s / 64)
        zs = ROOT_MIN_Z + j * s + np.arange(65) * (s / 64)
        inside = xs[0] >= CORE['x0'] and xs[-1] <= CORE['x1'] and zs[0] >= CORE['z0'] and zs[-1] <= CORE['z1']
        if inside:
            arr, x0, z0, d = vis_core, CORE['x0'], CORE['z0'], 8.0
        else:
            arr, x0, z0, d = vis_glob, ROOT_MIN_X, ROOT_MIN_Z, 32.0
        fx = np.clip((xs - x0) / d, 0, arr.shape[1] - 1.001)
        fz = np.clip((zs - z0) / d, 0, arr.shape[0] - 1.001)
        ix, iz = np.floor(fx).astype(int), np.floor(fz).astype(int)
        tx, tz = fx - ix, fz - iz
        a = arr[np.ix_(iz, ix)]; b = arr[np.ix_(iz, ix + 1)]; c = arr[np.ix_(iz + 1, ix)]; e = arr[np.ix_(iz + 1, ix + 1)]
        v = (a * (1 - tx)[None, :] + b * tx[None, :]) * (1 - tz)[:, None] + (c * (1 - tx)[None, :] + e * tx[None, :]) * tz[:, None]
        return np.clip(np.round(v * 255), 0, 255).astype(np.uint8)

    # ---------------- errors ----------------
    log('errors')
    err = {}
    # core levels vs 2 m
    for L, k in ((7, 3), (8, 2), (9, 1)):
        up = upsample(P[k], 1 << k)[:NZ2, :NX2]
        d = np.abs(up - P[0])
        err[('core', L)] = block_max(d, 64 << k)
        del up, d
    err[('core', 10)] = np.zeros(((NZ2 - 1) // 64, (NX2 - 1) // 64), np.float32)
    # global levels vs 16 m grid (G7)
    for L in range(0, 7):
        f = 1 << (7 - L)
        up = upsample(G[L], f)[:N16, :N16]
        d = np.abs(up - G7)
        err[('glob', L)] = block_max(d, 64 * f)
        del up, d
    err[('glob', 7)] = np.zeros((128, 128), np.float32)
    # add the 16 m -> 2 m error of the core to every global level covering it
    e7c = err[('core', 7)]  # L7 tiles in core (shape nz, nx), tile offset 45
    CO = int((CORE['x0'] - ROOT_MIN_X) / 1024)
    COZ = int((CORE['z0'] - ROOT_MIN_Z) / 1024)
    add7 = np.zeros((128, 128), np.float32)
    add7[COZ:COZ + e7c.shape[0], CO:CO + e7c.shape[1]] = e7c
    err[('glob', 7)] = add7
    for L in range(6, -1, -1):
        f = 1 << (7 - L)
        n = 1 << L
        err[('glob', L)] = err[('glob', L)] + add7.reshape(n, f, n, f).max(axis=(1, 3))

    def node_err(L, i, j):
        if L <= 7:
            return float(err[('glob', L)][j, i])
        s = 1 << (L - 7)
        return float(err[('core', L)][j - COZ * s, i - CO * s])

    def bounds(L, i, j):
        s = ROOT_SIZE / (1 << L)
        x0, z0 = ROOT_MIN_X + i * s, ROOT_MIN_Z + j * s
        return x0, z0, x0 + s, z0 + s

    def inside(b, a):
        return b[0] >= a['x0'] and b[2] <= a['x1'] and b[1] >= a['z0'] and b[3] <= a['z1']

    def overlaps(b, a):
        return b[2] > a['x0'] and b[0] < a['x1'] and b[3] > a['z0'] and b[1] < a['z1']

    def area_max_level(L, i, j):
        b = bounds(L, i, j)
        return MAX_CORE if inside(b, CORE) else (MAX_MID if overlaps(b, MID) else MAX_FAR)

    def img_level_overlap(L, i, j):
        """Deepest imagery level available anywhere inside the node (forces refinement for texture detail)."""
        b = bounds(L, i, j)
        return IMG_CORE if overlaps(b, CORE) else (IMG_MID if overlaps(b, MID) else IMG_FAR)

    def water_flag(L, i, j):
        if L <= 7:
            w = GW[L][j * 64:j * 64 + 65, i * 64:i * 64 + 65]
        else:
            k, s = 10 - L, 1 << (L - 7)
            w = W[k][(j - COZ * s) * 64:(j - COZ * s) * 64 + 65, (i - CO * s) * 64:(i - CO * s) * 64 + 65]
        wt = ~np.isnan(w)
        return 2 if wt.all() else (1 if wt.any() else 0)

    # ---------------- tree ----------------
    log('tree')
    nodes = {}
    def visit(L, i, j):
        e = node_err(L, i, j)
        wf = water_flag(L, i, j)
        ml = area_max_level(L, i, j)
        need_tex = L < img_level_overlap(L, i, j) and wf != 2
        kids = (L < ml and e > EPS.get(L, EPS_DEFAULT)) or need_tex
        nodes[(L, i, j)] = [e, kids, wf]
        if kids:
            for dj in (0, 1):
                for di in (0, 1):
                    visit(L + 1, 2 * i + di, 2 * j + dj)
    visit(0, 0, 0)
    # monotonic errors (parent >= children)
    for key in sorted(nodes, key=lambda k: -k[0]):
        L, i, j = key
        if nodes[key][1]:
            m = max(nodes[(L + 1, 2 * i + di, 2 * j + dj)][0] for di in (0, 1) for dj in (0, 1))
            nodes[key][0] = max(nodes[key][0], m * 1.02)
    counts = {}
    for (L, _, _) in nodes:
        counts[L] = counts.get(L, 0) + 1
    log('nodes', len(nodes), dict(sorted(counts.items())))

    # ---------------- write tiles ----------------
    # written next to the live data; imagery_build.py swaps h.next -> h and publishes index.json atomically
    hdir = os.path.join(OUT, 'h.next')
    if os.path.exists(hdir):
        shutil.rmtree(hdir)
    os.makedirs(hdir)
    recs = []
    files = {}
    for (L, i, j), (e, kids, wflag) in sorted(nodes.items()):
        if L <= 7:
            arr, warr, bi, bj = G[L], GW[L], i * 64, j * 64
        else:
            k = 10 - L
            s = 1 << (L - 7)
            arr, warr = P[k], W[k]
            bi, bj = (i - CO * s) * 64, (j - COZ * s) * 64
        ii = np.clip(np.arange(bi - 1, bi + 66), 0, arr.shape[1] - 1)
        jj = np.clip(np.arange(bj - 1, bj + 66), 0, arr.shape[0] - 1)
        t = arr[np.ix_(jj, ii)]
        wt = ~np.isnan(warr[np.ix_(jj, ii)])
        hmin, hmax = float(t.min()), float(t.max())
        scale = max((hmax - hmin) / 65535.0, 1e-6)
        q = np.round((t - hmin) / scale).astype('<u2')
        if L not in files:
            files[L] = open(os.path.join(hdir, f'{L}.bin'), 'wb')
        f = files[L]
        blob = (np.array([hmin, scale], '<f4').tobytes() + q.tobytes() + np.packbits(wt.astype(np.uint8).ravel()).tobytes()
                + sample_vis(L, i, j).tobytes())
        assert len(blob) == TILE_BYTES
        f.write(blob)
        recs.append([L, i, j, 1 if kids else 0, round(e, 2), round(hmin, 2), round(hmax, 2), wflag])
    for f in files.values():
        f.close()
    log('wrote', len(recs), 'height tiles')

    index = {
        'version': 1,
        'rootSize': ROOT_SIZE, 'rootMinX': ROOT_MIN_X, 'rootMinZ': ROOT_MIN_Z,
        'grid': GRID, 'border': 1,
        'heightFormat': 'h/<level>.bin: tiles of tileBytes in node order of that level; each = f32 hmin, f32 scale, u16[67*67] (h = hmin + v*scale, row-major, rows +z, 1-sample border), packbits(water[67*67]), u8 sunVis[65*65] (vertices)',
        'bakedSun': {'elevationDeg': SUN_EL, 'azimuthDeg': SUN_AZ},
        'tileBytes': TILE_BYTES,
        'core': CORE, 'mid': MID,
        'nodeFields': ['level', 'i', 'j', 'hasChildren', 'error', 'hmin', 'hmax', 'water(0 land,1 mixed,2 all)'],
        'imgLevels': {'core': IMG_CORE, 'mid': IMG_MID, 'far': IMG_FAR},
        'nodes': recs,
    }
    json.dump(index, open(os.path.join(CACHE, 'index_terrain.json'), 'w'), separators=(',', ':'))

    # ---------------- water info texture (depth + distance to shore) ----------------
    log('water info texture')
    import terrain_waterinfo
    terrain_waterinfo.main()

    # ---------------- caches for the imagery build ----------------
    np.save(os.path.join(CACHE, 'h2.npy'), h2)
    np.save(os.path.join(CACHE, 'h16.npy'), G7)
    log('done')


if __name__ == '__main__':
    main()
