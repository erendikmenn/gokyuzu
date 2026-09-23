"""W2 city: tree instances for the whole map (street trees, OSM trees, forests, parks, back yards, scrub).

  .venv/bin/python tools/geo/city_trees.py

Sources: DataSF Street Tree List (144k, species + trunk diameter), OSM natural=tree nodes / tree_row ways, OSM
natural=wood / landuse=forest (dense stands: Presidio, Golden Gate Park, Sutro, Oakland hills), leisure=park /
golf_course / cemetery (sparse), landuse=residential back yards (sparse, away from buildings and streets),
natural=scrub / heath (low shrubs, Marin headlands). Buildings and road corridors are kept clear.

Output: assets/sf/city/trees/<i>_<j>.bin per 2 km tile: 'TRE1', i, j, n, then n x {x f32, z f32, species u8,
height u8 (0.25 m), rot u8, shade u8} ; assets/sf/city/trees/trees.json (species list, tiles, counts).
"""
import json, math, os, struct, sys, time
from collections import defaultdict, Counter

import numpy as np
import shapely
from shapely.geometry import Polygon, LineString, Point
from shapely import STRtree
from shapely.prepared import prep

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import ROOT  # noqa: E402
from city_prep import proj, rnd01, load_exclusions, load_airport_exclusions  # noqa: E402

CACHE = os.path.join(ROOT, 'data', 'sf', 'cache', 'city')
OUT = os.path.join(ROOT, 'assets', 'sf', 'city', 'trees')
T2 = 2000.0
SPECIES = ['broadleaf', 'small', 'eucalyptus', 'cypress', 'pine', 'conifer', 'palm_date', 'palm_fan', 'shrub']
SP = {s: i for i, s in enumerate(SPECIES)}

GENUS = {
    'Platanus': 'broadleaf', 'Ficus': 'broadleaf', 'Magnolia': 'broadleaf', 'Ulmus': 'broadleaf', 'Quercus': 'broadleaf',
    'Acer': 'broadleaf', 'Liquidambar': 'broadleaf', 'Fraxinus': 'broadleaf', 'Ginkgo': 'broadleaf', 'Jacaranda': 'broadleaf',
    'Tilia': 'broadleaf', 'Gleditsia': 'broadleaf', 'Zelkova': 'broadleaf', 'Populus': 'broadleaf', 'Betula': 'broadleaf',
    'Umbellularia': 'broadleaf', 'Aesculus': 'broadleaf', 'Juglans': 'broadleaf', 'Celtis': 'broadleaf', 'Salix': 'broadleaf',
    'Tipuana': 'broadleaf', 'Koelreuteria': 'broadleaf', 'Pistacia': 'broadleaf', 'Robinia': 'broadleaf', 'Alnus': 'broadleaf',
    'Eucalyptus': 'eucalyptus', 'Corymbia': 'eucalyptus', 'Acacia': 'eucalyptus', 'Casuarina': 'eucalyptus',
    'Cupressus': 'cypress', 'Hesperocyparis': 'cypress', 'Juniperus': 'cypress', 'Callitropsis': 'cypress',
    'Pinus': 'pine', 'Araucaria': 'conifer', 'Sequoia': 'conifer', 'Sequoiadendron': 'conifer', 'Cedrus': 'conifer',
    'Podocarpus': 'conifer', 'Afrocarpus': 'conifer', 'Cryptomeria': 'conifer', 'Picea': 'conifer', 'Abies': 'conifer',
    'Phoenix': 'palm_date', 'Jubaea': 'palm_date', 'Butia': 'palm_date', 'Washingtonia': 'palm_fan', 'Syagrus': 'palm_fan',
    'Archontophoenix': 'palm_fan', 'Trachycarpus': 'palm_fan', 'Cordyline': 'palm_fan', 'Chamaerops': 'palm_date',
}
REF_H = {'broadleaf': 12, 'small': 7, 'eucalyptus': 28, 'cypress': 14, 'pine': 18, 'conifer': 22, 'palm_date': 11,
         'palm_fan': 16, 'shrub': 2}


def species_of_genus(g, key):
    if g in GENUS:
        return GENUS[g]
    return 'small' if rnd01(key, 'sg') < 0.6 else 'broadleaf'


def forest_mix(x, z):
    """Species mix for dense stands by area."""
    if -8200 < x < -5600 and -22200 < z < -19900:      # Presidio
        return [('eucalyptus', 4), ('cypress', 3), ('pine', 3)]
    if -10700 < x < -5300 and -17800 < z < -16500:     # Golden Gate Park
        return [('cypress', 3), ('pine', 3), ('eucalyptus', 3), ('conifer', 1)]
    if -8000 < x < -6000 and -16200 < z < -14500:      # Sutro forest / Twin Peaks
        return [('eucalyptus', 9), ('pine', 1)]
    if x > 12500:                                       # Oakland / Berkeley hills
        return [('broadleaf', 4), ('eucalyptus', 3), ('conifer', 2), ('pine', 1)]
    if z < -22600:                                      # Marin
        return [('broadleaf', 4), ('eucalyptus', 2), ('cypress', 2), ('pine', 2)]
    return [('broadleaf', 4), ('pine', 2), ('eucalyptus', 2), ('cypress', 2)]


def pick(mix, key):
    tot = sum(w for _, w in mix)
    r = rnd01(key, 'mix') * tot
    for s, w in mix:
        r -= w
        if r <= 0:
            return s
    return mix[-1][0]


def scatter(poly, spacing, rng):
    """Jittered grid points inside poly (spacing meters)."""
    minx, miny, maxx, maxy = poly.bounds
    nx, ny = int((maxx - minx) / spacing) + 1, int((maxy - miny) / spacing) + 1
    if nx * ny > 4_000_000:
        return np.zeros((0, 2))
    gx, gy = np.meshgrid(np.arange(nx), np.arange(ny))
    pts = np.stack([minx + (gx.ravel() + rng.uniform(0.1, 0.9, gx.size)) * spacing,
                    miny + (gy.ravel() + rng.uniform(0.1, 0.9, gy.size)) * spacing], 1)
    inside = shapely.contains_xy(poly, pts[:, 0], pts[:, 1])
    return pts[inside]


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(7)
    trees = []   # (x, z, species, height)
    # ---- DataSF street trees
    st = json.load(open(os.path.join(ROOT, 'data', 'sf', 'raw', 'datasf', 'street_trees.json')))
    ok = [r for r in st if r.get('latitude') and r.get('longitude') and r.get('species')]
    ll = np.array([[float(r['longitude']), float(r['latitude'])] for r in ok])
    xy = proj(ll)
    for r, (x, z) in zip(ok, xy):
        sp = r['species'].split('::')[0].strip()
        genus = sp.split(' ')[0]
        if genus in ('Planting', 'Tree(s)', '', 'Potential') or 'Site' in sp:
            continue
        s = species_of_genus(genus, r.get('treeid'))
        try:
            dbh = float(r.get('mapdbh') or r.get('dbhrange') or 6)
        except ValueError:
            dbh = 6.0
        dbh = min(max(dbh, 2.0), 60.0)
        if s.startswith('palm'):
            h = (6 + dbh * 0.35) if s == 'palm_date' else (8 + dbh * 0.6)
        elif s in ('eucalyptus', 'conifer', 'pine'):
            h = 5 + dbh * 0.55
        else:
            h = 3.5 + dbh * 0.38
        trees.append((x, z, s, min(h, REF_H[s] * 2.2), f"st{r.get('treeid')}"))
    n_street = len(trees)
    print(f'street trees: {n_street}', flush=True)
    # ---- OSM tree nodes (outside SF mostly) + tree rows
    ot = json.load(open(os.path.join(CACHE, 'osm_trees.json')))
    xy = proj(np.array([[t['lon'], t['lat']] for t in ot]))
    for t, (x, z) in zip(ot, xy):
        g = (t.get('genus') or t.get('species') or t.get('taxon') or '').split(' ')[0]
        if g in GENUS:
            s = GENUS[g]
        elif t.get('leaf_type') == 'needleleaved':
            s = 'pine'
        elif (t.get('species:en') or '').lower().find('palm') >= 0 or g.lower() == 'palm':
            s = 'palm_fan'
        else:
            s = 'broadleaf' if rnd01((x, z), 'o') < 0.6 else 'small'
        h = None
        try:
            h = float(str(t.get('height', '')).split()[0])
        except (ValueError, IndexError):
            pass
        trees.append((x, z, s, h or REF_H[s] * (0.7 + 0.6 * rnd01((x, z), 'h')), f'ot{x:.0f}_{z:.0f}'))
    roads_raw = json.load(open(os.path.join(CACHE, 'osm_roads.json')))
    for r in roads_raw:
        if r.get('natural') == 'tree_row':
            line = LineString(proj(r['pts']))
            n = max(1, int(line.length / 9))
            for k in range(n + 1):
                p = line.interpolate(k / max(n, 1), normalized=True)
                trees.append((p.x, p.y, 'broadleaf', 9 + 5 * rnd01((p.x, p.y), 'tr'), f'tr{p.x:.0f}_{p.y:.0f}'))
    print(f'+ OSM trees: {len(trees) - n_street}', flush=True)
    # ---- obstacles for scatter: buildings + roads
    blds = json.load(open(os.path.join(CACHE, 'osm_buildings.json')))
    bpolys = []
    for b in blds:
        for r in b['rings']:
            try:
                bpolys.append(Polygon(proj(r['outer'])))
            except Exception:
                pass
    rows = []
    for f in sorted(os.listdir(os.path.join(ROOT, 'data', 'sf', 'raw', 'datasf'))):
        if f.startswith('buildings_'):
            rows += json.load(open(os.path.join(ROOT, 'data', 'sf', 'raw', 'datasf', f)))
    for r in rows:
        for poly in r['shape']['coordinates']:
            try:
                bpolys.append(Polygon(proj(poly[0])))
            except Exception:
                pass
    btree = STRtree(bpolys)
    lines, widths = [], []
    for r in roads_raw:
        hw = r.get('highway')
        if hw:
            lines.append(LineString(proj(r['pts'])))
            widths.append({'motorway': 16, 'trunk': 14, 'primary': 11, 'secondary': 10, 'tertiary': 9}.get(hw.split('_')[0], 6))
    rtree = STRtree(lines)
    print(f'obstacles loaded ({time.time() - t0:.0f} s)', flush=True)

    def clear(pts, bclear=2.5, road_scale=1.0):
        if len(pts) == 0:
            return pts
        g = shapely.points(pts)
        hit_b = btree.query(g, predicate='dwithin', distance=bclear)
        bad = np.zeros(len(pts), bool)
        bad[hit_b[0]] = True
        idx, d = rtree.query_nearest(g, max_distance=20, return_distance=True, all_matches=False)
        w = np.array(widths)[idx[1]] * road_scale
        bad[idx[0][d < w]] = True
        return pts[~bad]

    # ---- landcover polygons (forest / scrub / parks) for species + fallback scatter
    lc = json.load(open(os.path.join(CACHE, 'osm_landcover.json')))
    excl = load_exclusions()
    _, apt_zones = load_airport_exclusions()
    ex_tree = STRtree(excl + apt_zones)
    lc_polys, lc_kind = [], []
    for b in lc:
        t = b['tags']
        kind = None
        if t.get('natural') == 'wood' or t.get('landuse') == 'forest':
            kind = 'forest'
        elif t.get('natural') in ('scrub', 'heath'):
            kind = 'scrub'
        elif t.get('leisure') in ('park', 'garden', 'golf_course') or t.get('landuse') == 'cemetery':
            kind = 'park'
        if not kind:
            continue
        for r in b['rings']:
            try:
                poly = Polygon(proj(r['outer']), [proj(x) for x in r['inner'] if len(x) >= 4]).buffer(0)
            except Exception:
                continue
            if poly.area >= 200:
                lc_polys.append(poly)
                lc_kind.append(kind)
    lc_tree = STRtree(lc_polys)

    def kind_at(pts):
        """forest / scrub / park / None per point (forest > scrub > park)."""
        out = np.array([None] * len(pts), dtype=object)
        if not len(pts):
            return out
        hit = lc_tree.query(shapely.points(pts), predicate='intersects')
        rank = {'park': 1, 'scrub': 2, 'forest': 3}
        best = np.zeros(len(pts), int)
        for pi, li in zip(*hit):
            k = lc_kind[li]
            if rank[k] > best[pi]:
                best[pi] = rank[k]
                out[pi] = k
        return out

    def drop_excluded(pts):
        if not len(pts):
            return pts
        hit = ex_tree.query(shapely.points(pts), predicate='intersects')
        keep = np.ones(len(pts), bool)
        keep[hit[0]] = False
        return pts[keep]

    # ---- trees where the aerial photo shows canopy (W1 NAIP mosaic, 1 m/px): dark, green, textured pixels.
    # Flat fills (no photo) and water (teal) are rejected; a tree per 7 m cell with >= 40 % canopy.
    from PIL import Image
    tidx = json.load(open(os.path.join(ROOT, 'assets', 'sf', 'terrain', 'index.json')))
    RX, RZ, root = tidx['rootMinX'], tidx['rootMinZ'], tidx['rootSize']
    L8 = 8
    tsize = root / (1 << L8)
    px = int(tidx.get('imgPx', 512))
    mpp = tsize / px
    cellpx = 9
    street_pts = np.array([(t[0], t[1]) for t in trees])
    st_tree = STRtree(shapely.points(street_pts)) if len(street_pts) else None
    region = json.load(open(os.path.join(ROOT, 'data', 'sf', 'region.json')))['local']
    flat_tiles = set()
    photo = []
    img_dir = os.path.join(ROOT, 'assets', 'sf', 'terrain', 'img', str(L8))
    from scipy.ndimage import uniform_filter
    for f in os.listdir(img_dir):
        if not f.endswith('.webp'):
            continue
        i, j = (int(v) for v in f[:-5].split('_'))
        x0, z0 = RX + i * tsize, RZ + j * tsize
        if x0 > region['maxX'] + 500 or x0 + tsize < region['minX'] - 500 or z0 > region['maxZ'] + 500 or z0 + tsize < region['minZ'] - 500:
            continue
        im = np.asarray(Image.open(os.path.join(img_dir, f)).convert('RGB'), np.float32)
        r, g, b = im[..., 0], im[..., 1], im[..., 2]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        var = uniform_filter(lum * lum, 5) - uniform_filter(lum, 5) ** 2
        if float((var > 25).mean()) < 0.05:
            flat_tiles.add((i, j))
            continue
        canopy = ((2 * g - r - b) > 6) & (lum < 105) & (g >= r) & (g > b + 4) & (var > 25)
        n = px // cellpx
        c = canopy[:n * cellpx, :n * cellpx].reshape(n, cellpx, n, cellpx)
        frac = c.mean((1, 3))
        rr, cc = np.nonzero(frac >= 0.45)
        if not len(rr):
            continue
        # canopy centroid inside each accepted cell
        ys, xs = np.mgrid[0:cellpx, 0:cellpx]
        cells = c[rr, :, cc, :]                                   # (k, cellpx, cellpx)
        w = cells.sum((1, 2))
        cy = (cells * ys).sum((1, 2)) / w
        cx = (cells * xs).sum((1, 2)) / w
        X = x0 + (cc * cellpx + cx + 0.5) * mpp
        Z = z0 + (rr * cellpx + cy + 0.5) * mpp
        photo.append(np.stack([X, Z, frac[rr, cc]], 1))
    photo = np.concatenate(photo) if photo else np.zeros((0, 3))
    print(f'photo canopy candidates: {len(photo)} ({len(flat_tiles)} flat/no-photo tiles) ({time.time() - t0:.0f} s)', flush=True)
    pts = photo[:, :2]
    fr = photo[:, 2]
    keep = np.ones(len(pts), bool)
    g = shapely.points(pts)
    keep[btree.query(g, predicate='dwithin', distance=1.0)[0]] = False
    idx, d = rtree.query_nearest(g, max_distance=20, return_distance=True, all_matches=False)
    wv = np.array(widths)[idx[1]] * 0.55
    keep[idx[0][d < wv]] = False
    if st_tree is not None:
        keep[st_tree.query(g, predicate='dwithin', distance=4.5)[0]] = False
    pts, fr = pts[keep], fr[keep]
    ex = drop_excluded(np.concatenate([pts, fr[:, None]], 1)) if len(pts) else np.zeros((0, 3))
    pts, fr = ex[:, :2], ex[:, 2]
    kinds_at = kind_at(pts)
    kinds = Counter()
    for (x, z), f_, k in zip(pts, fr, kinds_at):
        key = f'ph{x:.1f}_{z:.1f}'
        u = rnd01(key, 'hh')
        if k == 'scrub':
            if rnd01(key, 'sk') < 0.45:
                continue
            s, h = 'shrub', 1.6 + 2.4 * u
        elif k == 'forest':
            s = pick(forest_mix(x, z), key)
            h = REF_H[s] * (0.7 + 0.6 * u)
        elif k == 'park':
            s = pick(forest_mix(x, z), key) if rnd01(key, 'p') < 0.6 else pick([('broadleaf', 3), ('small', 2), ('pine', 1)], key)
            h = REF_H[s] * (0.6 + 0.6 * u)
        else:   # yards, streets, slopes
            s = pick([('broadleaf', 5), ('small', 4), ('pine', 1), ('cypress', 0.6), ('eucalyptus', 0.6), ('palm_fan', 0.15)], key)
            h = REF_H[s] * (0.55 + 0.6 * u) * (0.8 + 0.4 * f_)
        trees.append((x, z, s, h, key))
        kinds[k or 'yard'] += 1
    print(f'photo trees: {dict(kinds)} ({time.time() - t0:.0f} s)', flush=True)

    # ---- fallback: OSM forest / scrub polygons where there is no photo (flat fill tiles)
    fb = Counter()
    for poly, k in zip(lc_polys, lc_kind):
        if k == 'park':
            continue
        spacing = 9.0 if k == 'forest' else 14.0
        cand = scatter(poly, spacing, rng)
        if not len(cand):
            continue
        ti = np.floor((cand[:, 0] - RX) / tsize).astype(int)
        tj = np.floor((cand[:, 1] - RZ) / tsize).astype(int)
        m = np.array([(a, b) in flat_tiles for a, b in zip(ti, tj)])
        cand = cand[m]
        cand = drop_excluded(clear(cand, bclear=1.5, road_scale=0.7))
        for (x, z) in cand:
            key = f'{k}{x:.1f}_{z:.1f}'
            u = rnd01(key, 'hh')
            if k == 'scrub':
                s, h = 'shrub', 1.2 + 2.3 * u
            else:
                s = pick(forest_mix(x, z), key)
                h = REF_H[s] * (0.65 + 0.7 * u)
            trees.append((x, z, s, h, key))
        fb[k] += len(cand)
    print(f'fallback scatter (no photo): {dict(fb)} ({time.time() - t0:.0f} s)', flush=True)

    # ---- final exclusion for every tree (street/OSM trees too): landmarks, airports (aerodromes, W4 zones incl. the
    # KNGZ air base fence line), Alameda Point, plus a clear strip along every runway
    rw = json.load(open(os.path.join(ROOT, 'data', 'sf', 'runways.json')))
    strips = []
    for apt in rw['airports']:
        for r in apt['runways']:
            a, b = r['ends']
            strips.append(LineString([(a['x'], a['z']), (b['x'], b['z'])]).buffer(r['width'] / 2 + 150, cap_style=2))
    ex_all = STRtree(excl + apt_zones + strips)
    xy = np.array([(t[0], t[1]) for t in trees])
    hit = ex_all.query(shapely.points(xy), predicate='intersects')
    bad = set(hit[0].tolist())
    trees = [t for k, t in enumerate(trees) if k not in bad]
    print(f'excluded {len(bad)} trees (airports / landmarks / runway strips)', flush=True)

    # ---- tiles
    tiles = defaultdict(list)
    for (x, z, s, h, key) in trees:
        tiles[(int(math.floor(x / T2)), int(math.floor(z / T2)))].append((x, z, s, h, key))
    for f in os.listdir(OUT):
        if f.endswith('.bin'):
            os.remove(os.path.join(OUT, f))
    meta = []
    for (i, j), lst in sorted(tiles.items()):
        buf = bytearray(struct.pack('<4siiI', b'TRE1', i, j, len(lst)))
        arr = np.zeros(len(lst), dtype=[('x', '<f4'), ('z', '<f4'), ('s', 'u1'), ('h', 'u1'), ('r', 'u1'), ('c', 'u1')])
        for k, (x, z, s, h, key) in enumerate(lst):
            arr[k] = (x, z, SP[s], min(255, max(1, int(round(h * 4)))), int(rnd01(key, 'rot') * 255), int(rnd01(key, 'col') * 255))
        buf += arr.tobytes()
        open(os.path.join(OUT, f'{i}_{j}.bin'), 'wb').write(buf)
        meta.append({'i': i, 'j': j, 'n': len(lst)})
    counts = Counter(s for (_, _, s, _, _) in trees)
    json.dump({'version': 1, 'size': T2, 'species': SPECIES, 'refHeight': REF_H, 'tiles': meta, 'counts': counts},
              open(os.path.join(OUT, 'trees.json'), 'w'))
    print(f'{len(trees)} trees in {len(meta)} tiles: {dict(counts)} ({time.time() - t0:.0f} s)')


if __name__ == '__main__':
    main()
