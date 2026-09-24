"""İstanbul landmarks: positions, axes, footprints and ground profiles from OSM + the Copernicus DEM.

Reads the cached OSM cut-outs (data/ist/_cache/raw/osm_landmarks/*.json, see landmarks_ist_pbf.py / landmarks_ist_osm.py)
and the Copernicus GLO-30 tiles the terrain pipeline caches (data/ist/_cache/raw/copdem/*.tif, read-only), and writes
  blender/landmarks_ist/layout.json   (tracked: the Blender builds are reproducible offline)
      bridges:  origin {x, z} (main-span centre), heading (rad, 0 = north, clockwise; +Y of the model), s0/s1 (deck ends
                along the axis), towers (s), path (model-frame polyline for curved decks), ground [[s, g], ...]
      sites:    origin, heading, footprints (model frame) with OSM tags, minarets, ground (min over the footprint)
  data/ist/landmarks-exclude.json     OSM ids + zone polygons (local m) the landmark models replace (city pipeline)
  data/ist/landmarks.json             id, name, lon/lat, x/z, kind, excludeRadius (same schema as data/sf/landmarks.json)
Usage:  GEO_REGION=ist .venv/bin/python tools/geo/landmarks_ist_layout.py
Model frame (Blender): +X = right, +Y = forward (heading), +Z = up.  world = origin + X·(cos h, sin h) + Y·(sin h, −cos h).
"""
import glob
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from geo import DATA_DIR, ROOT, REGION_ID, lonlat_to_local, local_to_lonlat  # noqa: E402

RAW = os.path.join(DATA_DIR, '_cache', 'raw', 'osm_landmarks')
DEM_DIR = os.path.join(DATA_DIR, '_cache', 'raw', 'copdem')
LAYOUT = os.path.join(ROOT, 'blender', 'landmarks_ist', 'layout.json')
EXCLUDE = os.path.join(DATA_DIR, 'landmarks-exclude.json')
LMJSON = os.path.join(DATA_DIR, 'landmarks.json')


# ------------------------------------------------------------------------------------------------ DEM (Copernicus GLO-30)
class Dem:
    """Bilinear sampler over the 1°×1° Copernicus tiles (heights ≈ MSL, EGM2008). DSM: includes buildings/trees."""

    def __init__(self):
        import rasterio
        self.tiles = []
        for p in sorted(glob.glob(os.path.join(DEM_DIR, 'Copernicus_DSM_COG_10_*_DEM.tif'))):
            src = rasterio.open(p)
            self.tiles.append((src.bounds, src.transform, src.read(1).astype(np.float32)))
        if not self.tiles:
            sys.exit(f'no Copernicus tiles in {DEM_DIR} (terrain pipeline: tools/geo/terrain_download.py)')

    def lonlat(self, lon, lat):
        for b, T, A in self.tiles:
            if b.left <= lon < b.right and b.bottom <= lat < b.top:
                c = (lon - T.c) / T.a - 0.5
                r = (lat - T.f) / T.e - 0.5
                c0, r0 = int(math.floor(c)), int(math.floor(r))
                fc, fr = c - c0, r - r0
                c0 = min(max(c0, 0), A.shape[1] - 2)
                r0 = min(max(r0, 0), A.shape[0] - 2)
                a = A[r0:r0 + 2, c0:c0 + 2]
                return float(a[0, 0] * (1 - fc) * (1 - fr) + a[0, 1] * fc * (1 - fr) + a[1, 0] * (1 - fc) * fr + a[1, 1] * fc * fr)
        return 0.0

    def local(self, x, z):
        return self.lonlat(*local_to_lonlat(x, z))


# ------------------------------------------------------------------------------------------------ OSM helpers
def load(name):
    p = os.path.join(RAW, f'{name}.json')
    if not os.path.exists(p):
        sys.exit(f'missing {p}: run tools/geo/landmarks_ist_pbf.py (or landmarks_ist_osm.py)')
    return json.load(open(p))['elements']


def pts_of(e):
    """Local (x, z) outline of a way / the first outer ring of a relation / a node."""
    if e['type'] == 'node':
        return [lonlat_to_local(e['lon'], e['lat'])]
    if 'geometry' in e:
        return [lonlat_to_local(g['lon'], g['lat']) for g in e['geometry']]
    if 'rings' in e and e['rings']:
        return [lonlat_to_local(g['lon'], g['lat']) for g in e['rings'][0]['outer']]
    if 'members' in e:     # Overpass relation with member geometry
        out = []
        for m in e['members']:
            if m.get('role') == 'outer' and 'geometry' in m:
                out += [lonlat_to_local(g['lon'], g['lat']) for g in m['geometry']]
        return out
    return []


def osm_id(e):
    return {'node': 'n', 'way': 'w', 'relation': 'r'}[e['type']] + str(e['id'])


def centroid(pts):
    pts = list(pts)
    if len(pts) > 2 and pts[0] == pts[-1]:
        pts = pts[:-1]
    n = len(pts)
    if n < 3:
        return sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n
    a = cx = cz = 0.0
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        c = x0 * z1 - x1 * z0
        a += c
        cx += (x0 + x1) * c
        cz += (z0 + z1) * c
    if abs(a) < 1e-9:
        return sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n
    return cx / (3 * a), cz / (3 * a)


def area(pts):
    n = len(pts)
    return abs(sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))) / 2


def heading_of(dx, dz):
    return math.atan2(dx, -dz) % (2 * math.pi)


def to_model(origin, h, x, z):
    dx, dz = x - origin[0], z - origin[1]
    return (dx * math.cos(h) + dz * math.sin(h), dx * math.sin(h) - dz * math.cos(h))


def to_world(origin, h, X, Y):
    return (origin[0] + X * math.cos(h) + Y * math.sin(h), origin[1] + X * math.sin(h) - Y * math.cos(h))


def num(v):
    try:
        return float(str(v).split()[0].replace(',', '.'))
    except (ValueError, IndexError, TypeError):
        return None


# ------------------------------------------------------------------------------------------------ bridges
def ways(els, pred):
    return [e for e in els if e['type'] == 'way' and pred(e.get('tags', {}))]


def ends_of(ws):
    """Two extreme endpoints of a set of (roughly collinear) ways."""
    P = np.array([p for w in ws for p in pts_of(w)])
    d = ((P[:, None, :] - P[None, :, :]) ** 2).sum(-1)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    return P[i], P[j]


def ground_profile(dem, origin, h, s0, s1, step=10.0, pad=150.0):
    out = []
    for s in np.arange(s0 - pad, s1 + pad + 1e-6, step):
        x, z = to_world(origin, h, 0.0, s)
        out.append([round(float(s), 1), round(dem.local(x, z), 1)])
    return out


def straight_bridge(dem, els, name_re, towers_world=None, span=None, center_shift=0.0, east=True):
    """Frame of a straight bridge from its OSM carriageways (tagged name ~ name_re). towers_world: two (x, z) tower
    centres (OSM legs) -> origin = their midpoint, axis through them; else the axis through the deck ends.
    span: official main span (towers at ±span/2 along the axis)."""
    import re
    ws = ways(els, lambda t: 'bridge' in t and re.search(name_re, t.get('name', '') + t.get('bridge:name', '')) and
              ('highway' in t or 'railway' in t))
    a, b = ends_of(ws)
    if east and b[0] < a[0]:          # model +Y toward the eastern (Asian) end
        a, b = b, a
    if towers_world:
        t0, t1 = np.array(towers_world[0], float), np.array(towers_world[1], float)
        if np.dot(t1 - t0, b - a) < 0:
            t0, t1 = t1, t0
        o = (t0 + t1) / 2
        u = (t1 - t0) / np.linalg.norm(t1 - t0)
    else:
        u = (b - a) / np.linalg.norm(b - a)
        o = (a + b) / 2 + u * center_shift
    h = heading_of(u[0], u[1])
    s0 = float(np.dot(a - o, u))
    s1 = float(np.dot(b - o, u))
    half = span / 2 if span else None
    d = {'origin': {'x': round(float(o[0]), 2), 'z': round(float(o[1]), 2)}, 'heading': round(h, 6),
         'headingDeg': round(math.degrees(h), 3), 's0': round(s0, 1), 's1': round(s1, 1),
         'osm': sorted({osm_id(w) for w in ws})}
    if half:
        d['towers'] = [-half, half]
    d['ground'] = ground_profile(dem, (o[0], o[1]), h, s0, s1)
    return d


def leg_center(els, ids):
    P = [centroid(pts_of(e)) for e in els if e['type'] == 'way' and e['id'] in ids]
    return tuple(np.mean(np.array(P), axis=0))


def path_bridge(dem, els, name_re, pred=None, step=10.0):
    """Curved / kinked bridge: centreline = mean of its carriageways, resampled; frame = chord through the ends."""
    import re
    ws = ways(els, pred or (lambda t: 'bridge' in t and re.search(name_re, t.get('name', '')) and ('highway' in t or 'railway' in t)))
    a, b = ends_of(ws)
    u = (b - a) / np.linalg.norm(b - a)
    o = (a + b) / 2
    h = heading_of(u[0], u[1])
    # sample every way along the chord, average the lateral offset per station
    L = float(np.linalg.norm(b - a))
    st = np.arange(-L / 2, L / 2 + 1e-6, step)
    lat = [[] for _ in st]
    for w in ws:
        P = np.array(pts_of(w))
        S = (P - o) @ u
        X = (P - o) @ np.array([u[1], -u[0]]) * -1   # model X = right of the direction of travel
        order = np.argsort(S)
        S, X = S[order], X[order]
        for i, s in enumerate(st):
            if S[0] - 1 <= s <= S[-1] + 1:
                lat[i].append(float(np.interp(s, S, X)))
    path = [[round(float(X), 2), round(float(s), 2)] for s, X in ((s, np.mean(v)) for s, v in zip(st, lat) if v)]
    ground = []
    for X, Y in path:
        x, z = to_world((o[0], o[1]), h, X, Y)
        ground.append([Y, round(dem.local(x, z), 1)])
    return {'origin': {'x': round(float(o[0]), 2), 'z': round(float(o[1]), 2)}, 'heading': round(h, 6),
            'headingDeg': round(math.degrees(h), 3), 's0': round(-L / 2, 1), 's1': round(L / 2, 1), 'path': path,
            'ground': ground, 'osm': sorted({osm_id(w) for w in ws})}


def bridges(dem):
    out = {}
    els = load('bogazici')
    tw = [leg_center(els, {403142701, 403142702}), leg_center(els, {403255153, 403255154})]
    out['bogazici'] = straight_bridge(dem, els, '15 Temmuz', towers_world=tw, span=1074.0)
    els = load('fsm')
    tw = [leg_center(els, {403376602, 403376606}), leg_center(els, {403379442, 403379446})]
    out['fsm'] = straight_bridge(dem, els, 'Fatih Sultan Mehmet', towers_world=tw, span=1090.0)
    els = load('yss')
    d = straight_bridge(dem, els, 'Yavuz Sultan Selim', span=1408.0)
    # main span centred on the strait (the water between the two shores along the axis), not on the OSM deck ends
    g = np.array(d['ground'])
    wet = g[(g[:, 1] < 1.0), 0]
    shift = float((wet.min() + wet.max()) / 2) if len(wet) else 0.0
    out['yss'] = straight_bridge(dem, els, 'Yavuz Sultan Selim', span=1408.0, center_shift=shift)
    out['yss']['waterCentreShift'] = round(shift, 1)
    els = load('halic_inner')
    out['galata_bridge'] = straight_bridge(dem, els, '^Galata Köprüsü$')
    out['ataturk_bridge'] = straight_bridge(dem, els, '^Atatürk Köprüsü$')
    out['halic_metro'] = path_bridge(dem, els, 'M2', pred=lambda t: 'bridge' in t and t.get('railway') == 'subway'
                                     and 'M2' in t.get('name', ''))
    els = load('halic_o1')
    out['halic_bridge'] = path_bridge(dem, els, '^Haliç Köprüsü$')
    return out


# ------------------------------------------------------------------------------------------------ sites (monuments)
def find(els, oid):
    for e in els:
        if osm_id(e) == oid:
            return e
    raise KeyError(oid)


def poly_model(origin, h, pts):
    P = [to_model(origin, h, x, z) for x, z in pts]
    if len(P) > 2 and P[0] == P[-1]:
        P = P[:-1]
    return [[round(x, 2), round(y, 2)] for x, y in P]


def ground_min(dem, pts, pad=0.0):
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    c = centroid(pts)
    samples = list(pts) + [c]
    return round(min(dem.local(x, z) for x, z in samples), 1)


def mosque_frame(els, dome_id, tall, short):
    """Origin = dome centre; heading = from the mid-point of the far (short / courtyard) minarets toward the mosque."""
    d = centroid(pts_of(find(els, dome_id)))
    T = np.array([centroid(pts_of(find(els, i))) for i in tall])
    S = np.array([centroid(pts_of(find(els, i))) for i in short])
    v = T.mean(axis=0) - S.mean(axis=0)
    return (d[0], d[1]), heading_of(v[0], v[1])


def minarets_model(els, origin, h, specs):
    out = []
    for oid, H, sh in specs:
        c = centroid(pts_of(find(els, oid)))
        X, Y = to_model(origin, h, *c)
        out.append([round(X, 2), round(Y, 2), H, sh])
    return out


def zone_of(pts, buf=3.0):
    from shapely.geometry import Polygon
    g = Polygon(pts).buffer(buf, join_style=2).simplify(0.5)
    return [[round(x, 1), round(z, 1)] for x, z in list(g.exterior.coords)[:-1]]


def site_buildings(dem, els, origin, h, inside_poly, pred, default_h=9.0):
    """OSM buildings whose centroid lies inside `inside_poly` (world): model-frame outline, tags, design ground."""
    from shapely.geometry import Polygon, Point
    Z = Polygon(inside_poly).buffer(1.0)
    out = []
    for e in els:
        t = e.get('tags', {})
        if 'building' not in t or e['type'] == 'node' or not pred(e, t):
            continue
        P = pts_of(e)
        if len(P) < 4:
            continue
        c = centroid(P)
        if not Z.contains(Point(c)):
            continue
        out.append({'id': osm_id(e), 'name': t.get('name', ''), 'poly': poly_model(origin, h, P),
                    'height': num(t.get('height')), 'levels': num(t.get('building:levels')),
                    'kind': t.get('building'), 'historic': t.get('historic'), 'man_made': t.get('man_made'),
                    'roof': t.get('roof:shape'), 'g': ground_min(dem, P), 'area': round(area(P), 1),
                    'zone': zone_of(P, 1.5)})
    return out


def sliver_centreline(P, step=4.0):
    """Centreline of a thin closed polygon (a wall mapped as an area, e.g. the Sur-ı Sultani): split the ring at its two
    farthest vertices, resample both chains by arc length and average them."""
    P = np.array(P, float)
    if np.allclose(P[0], P[-1]):
        P = P[:-1]
    d = ((P[:, None, :] - P[None, :, :]) ** 2).sum(-1)
    i, j = sorted(np.unravel_index(np.argmax(d), d.shape))
    a = P[i:j + 1]
    b = np.concatenate([P[j:], P[:i + 1]])[::-1]

    def res(c, n):
        L = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(c, axis=0).T))])
        t = np.linspace(0, L[-1], n)
        return np.stack([np.interp(t, L, c[:, 0]), np.interp(t, L, c[:, 1])], axis=1)
    n = max(2, int(max(np.hypot(*np.diff(a, axis=0).T).sum(), np.hypot(*np.diff(b, axis=0).T).sum()) / step))
    return (res(a, n) + res(b, n)) / 2


def topkapi_precinct(dem, els, o, W):
    """Topkapı beyond the palace buildings: the Sur-ı Sultani land wall and the sea wall down to Sarayburnu (centrelines
    with design ground), their towers and Bâb-ı Hümâyûn (OSM buildings the model replaces), the courtyards / gardens
    (leisure polygons) and the mapped trees."""
    from shapely.geometry import LineString, Point, Polygon
    out = {'sur': [], 'courts': [], 'trees': [], 'wall_towers': [], 'gate': None}
    lines = []
    for e in els:
        t = e.get('tags', {})
        if e['type'] != 'way' or t.get('barrier') != 'city_wall':
            continue
        P = pts_of(e)
        if len(P) < 3:
            continue
        closed = np.allclose(P[0], P[-1])
        C = sliver_centreline(P) if closed and area(P[:-1]) < 0.02 * LineString(P).length ** 2 else np.array(P, float)
        C = np.array(LineString(C).simplify(1.2).coords)
        h = num(str(t.get('height', '')).split('-')[-1]) or 12.0
        lines.append(LineString(C))
        out['sur'].append({'id': osm_id(e), 'name': t.get('name', ''), 'height': h,
                           'pts': [[round(float(x - o[0]), 2), round(float(-(z - o[1])), 2), round(dem.local(x, z), 1)]
                                   for x, z in C]})
    for e in els:
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('man_made') == 'tower' and 'building' in t and \
                t.get('tower:type') in ('defensive', 'watchtower'):
            P = pts_of(e)
            c = centroid(P)
            if lines and min(ln.distance(Point(c)) for ln in lines) < 25:
                out['wall_towers'].append({'id': osm_id(e), 'poly': poly_model(o, 0.0, P), 'height': num(t.get('height')) or 16.0,
                                           'g': ground_min(dem, P), 'zone': zone_of(P, 1.5)})
        if e['type'] == 'way' and e['id'] == 335364925:           # Bâb-ı Hümâyûn (imperial gate of the 1st courtyard)
            P = pts_of(e)
            out['gate'] = {'id': osm_id(e), 'poly': poly_model(o, 0.0, P), 'g': ground_min(dem, P), 'zone': zone_of(P, 1.5)}
        if e['type'] == 'way' and t.get('leisure') in ('park', 'garden') and t.get('name') in (
                'Divan Meydanı', 'Enderûn Avlusu', 'Sofa-ı Hümâyûn', 'Zülüflü Baltacılar Avlusu', 'Fig Garden',
                'Elephant Garden', 'Şimşirlik Bahçesi', 'Alay Meydanı', 'Sarayburnu Parkı'):
            P = pts_of(e)
            out['courts'].append({'id': osm_id(e), 'name': t['name'], 'poly': poly_model(o, 0.0, P),
                                  'g': round(float(np.median([dem.local(x, z) for x, z in P])), 1)})
    inner = Polygon(W).buffer(20)
    for e in els:
        t = e.get('tags', {})
        if e['type'] == 'node' and t.get('natural') == 'tree':
            x, z = lonlat_to_local(e['lon'], e['lat'])
            if inner.contains(Point(x, z)):
                kind = 'c' if t.get('leaf_type') == 'needleleaved' or 'Cupressus' in t.get('genus', '') else 'p'
                out['trees'].append([round(x - o[0], 2), round(-(z - o[1]), 2), round(dem.local(x, z), 1), kind])
    return out


def sites(dem):
    S = {}
    # ---- mosques: frames from the OSM minarets (Simple 3D Buildings parts) and dome parts
    els = load('camlica')
    o, h = mosque_frame(els, 'w437761715', ['w437761713', 'w437761714', 'w437761716', 'w437761719'], ['w437761717', 'w437761718'])
    rel = find(els, 'r7534888')
    S['camlica_camii'] = {'name': 'Çamlıca Camii', 'origin': {'x': round(o[0], 2), 'z': round(o[1], 2)}, 'heading': round(h, 6),
                          'minarets': minarets_model(els, o, h, [('w437761713', 107.1, 3), ('w437761714', 107.1, 3), ('w437761716', 107.1, 3),
                                                                 ('w437761719', 107.1, 3), ('w437761717', 90.0, 2), ('w437761718', 90.0, 2)]),
                          'outline': poly_model(o, h, pts_of(rel)),
                          'osm': ['r7534888', 'w437761713', 'w437761714', 'w437761715', 'w437761716', 'w437761717', 'w437761718',
                                  'w437761719', 'w725800952'],
                          'zones': [zone_of(pts_of(rel), 3.0)]}
    els = load('sultanahmet')
    o, h = mosque_frame(els, 'w400562088', ['w398738731', 'w398738734', 'w398738736', 'w398738738'], ['w398738740', 'w398738742'])
    parts = [osm_id(e) for e in els if e['type'] != 'node' and 'building:part' in e.get('tags', {})
             and math.hypot(*(np.array(centroid(pts_of(e))) - np.array(o))) < 90]
    main = find(els, 'w399900887')
    court = [centroid(pts_of(find(els, i))) for i in ('w398738740', 'w398738742')]
    rel_ids = [osm_id(e) for e in els if e['type'] == 'relation' and e.get('tags', {}).get('name') == 'Sultanahmet Camii']
    zp = [p for e in els if osm_id(e) in parts for p in pts_of(e)]
    from shapely.geometry import MultiPoint
    hull = list(MultiPoint(zp).convex_hull.exterior.coords)
    S['sultanahmet'] = {'name': 'Sultanahmet Camii', 'origin': {'x': round(o[0], 2), 'z': round(o[1], 2)}, 'heading': round(h, 6),
                        'minarets': minarets_model(els, o, h, [('w398738731', 64.0, 3), ('w398738734', 64.0, 3), ('w398738736', 64.0, 3),
                                                               ('w398738738', 64.0, 3), ('w398738740', 54.0, 2), ('w398738742', 54.0, 2)]),
                        'hall': poly_model(o, h, pts_of(main)),
                        'osm': sorted(set(parts + rel_ids)), 'zones': [zone_of(hull, 3.0)]}
    # Ayasofya: building outline + the four minaret balconies (building:part 50–52 m)
    ay = find(els, 'w109862851')
    mins = ['w227758675', 'w335371711', 'w335371713', 'w335371715']
    M = {i: centroid(pts_of(find(els, i))) for i in mins}
    west = np.mean([M['w227758675'], M['w335371711']], axis=0)
    east = np.mean([M['w335371713'], M['w335371715']], axis=0)
    dome = centroid(pts_of(find(els, 'w305585921')))
    v = east - west
    h = heading_of(v[0], v[1])
    o = dome
    ay_parts = [osm_id(e) for e in els if e['type'] != 'node' and 'building:part' in e.get('tags', {})
                and math.hypot(*(np.array(centroid(pts_of(e))) - np.array(o))) < 70]
    S['ayasofya'] = {'name': 'Ayasofya-i Kebir Camii', 'origin': {'x': round(o[0], 2), 'z': round(o[1], 2)}, 'heading': round(h, 6),
                     'minarets': minarets_model(els, o, h, [('w227758675', 60.0, 1), ('w335371711', 60.0, 1), ('w335371713', 55.0, 1),
                                                            ('w335371715', 58.0, 1)]),
                     'outline': poly_model(o, h, pts_of(ay)), 'osm': sorted(set(['w109862851'] + ay_parts + mins)),
                     'zones': [zone_of(pts_of(ay), 2.0)]}
    els = load('suleymaniye')
    o, h = mosque_frame(els, 'w121471149', ['w642004198', 'w642004950'], ['w642004946', 'w642004948'])
    rel = find(els, 'r1564032')
    S['suleymaniye'] = {'name': 'Süleymaniye Camii', 'origin': {'x': round(o[0], 2), 'z': round(o[1], 2)}, 'heading': round(h, 6),
                        'minarets': minarets_model(els, o, h, [('w642004198', 76.0, 3), ('w642004950', 76.0, 3), ('w642004946', 56.0, 2),
                                                               ('w642004948', 56.0, 2)]),
                        'outline': poly_model(o, h, pts_of(rel)),
                        'osm': ['r1564032', 'w121471149', 'w642004197', 'w642004198', 'w642004946', 'w642004947', 'w642004948',
                                'w642004949', 'w642004950', 'w642004951'],
                        'zones': [zone_of(pts_of(rel), 3.0)]}
    els = load('yenicami')
    rel = find(els, 'r7574356')
    P = np.array(pts_of(rel))
    # oriented box of the mosque + courtyard; the qibla end is the one whose direction is closest to 151°
    from shapely.geometry import Polygon
    mrr = list(Polygon(P).minimum_rotated_rectangle.exterior.coords)[:4]
    e0 = np.array(mrr[1]) - np.array(mrr[0])
    e1 = np.array(mrr[2]) - np.array(mrr[1])
    long_v = e0 if np.linalg.norm(e0) >= np.linalg.norm(e1) else e1
    c = np.mean(np.array(mrr), axis=0)
    cands = [long_v, -long_v]
    q = min(cands, key=lambda v: abs(((math.degrees(heading_of(v[0], v[1])) - 151 + 180) % 360) - 180))
    h = heading_of(q[0], q[1])
    L = float(np.linalg.norm(long_v))
    u = q / np.linalg.norm(q)
    o = c + u * (L / 2 - 26.0)           # dome centre ≈ 26 m inside the qibla end (41 m square prayer hall)
    S['yeni_cami'] = {'name': 'Yeni Cami', 'origin': {'x': round(float(o[0]), 2), 'z': round(float(o[1]), 2)}, 'heading': round(h, 6),
                      'outline': poly_model(o, h, pts_of(rel)), 'length': round(L, 1),
                      'width': round(float(min(np.linalg.norm(e0), np.linalg.norm(e1))), 1),
                      'osm': ['r7574356'], 'zones': [zone_of(pts_of(rel), 3.0)]}
    # ---- towers
    els = load('galata')
    g = find(els, 'w23236783')
    c = centroid(pts_of(g))
    S['galata_kulesi'] = {'name': 'Galata Kulesi', 'origin': {'x': round(c[0], 2), 'z': round(c[1], 2)}, 'heading': 0.0,
                          'radius': round(math.sqrt(area(pts_of(g)) / math.pi), 2), 'osm': ['w23236783'],
                          'zones': [zone_of(pts_of(g), 1.5)]}
    els = load('kizkulesi')
    t = find(els, 'w398219280')
    c = centroid(pts_of(t))
    isl = [e for e in els if e['type'] == 'way' and e.get('tags', {}).get('natural') == 'coastline']
    ring = max((pts_of(e) for e in isl), key=lambda P: area(P) if len(P) > 2 else 0) if isl else []
    blds = [e for e in els if e['type'] == 'way' and 'building' in e.get('tags', {})]
    S['kiz_kulesi'] = {'name': 'Kız Kulesi', 'origin': {'x': round(c[0], 2), 'z': round(c[1], 2)}, 'heading': 0.0,
                       'islet': poly_model(c, 0.0, ring),
                       'buildings': [{'id': osm_id(e), 'poly': poly_model(c, 0.0, pts_of(e)), 'height': num(e['tags'].get('height')),
                                      'min_height': num(e['tags'].get('min_height')), 'roof': e['tags'].get('roof:shape')} for e in blds],
                       'osm': sorted(osm_id(e) for e in blds), 'zones': [zone_of(ring, 1.0)] if ring else []}
    els = load('camlica_tower')
    t = find(els, 'w722961117')
    c = centroid(pts_of(t))
    S['camlica_kulesi'] = {'name': 'Çamlıca Kulesi', 'origin': {'x': round(c[0], 2), 'z': round(c[1], 2)}, 'heading': 0.0,
                           'footprint': poly_model(c, 0.0, pts_of(t)), 'osm': ['w722961117'], 'zones': [zone_of(pts_of(t), 3.0)]}
    # ---- Haydarpaşa station
    els = load('haydarpasa')
    t = find(els, 'w473151877')
    P = pts_of(t)
    from shapely.geometry import Polygon
    mrr = list(Polygon(P).minimum_rotated_rectangle.exterior.coords)[:4]
    e0 = np.array(mrr[1]) - np.array(mrr[0])
    e1 = np.array(mrr[2]) - np.array(mrr[1])
    long_v = e0 if np.linalg.norm(e0) >= np.linalg.norm(e1) else e1
    c = np.mean(np.array(mrr), axis=0)
    h = heading_of(long_v[0], long_v[1])
    S['haydarpasa'] = {'name': 'Haydarpaşa Garı', 'origin': {'x': round(float(c[0]), 2), 'z': round(float(c[1]), 2)},
                       'heading': round(h, 6), 'outline': poly_model(c, h, P), 'osm': ['w473151877', 'w473335068'],
                       'zones': [zone_of(P, 2.0), zone_of(pts_of(find(els, 'w473335068')), 1.5)]}
    # ---- Rumeli Hisarı: the fortress outline; towers at the three bulges (model frame = world axes)
    els = load('rumelihisari')
    r = find(els, 'r7318154')
    c = centroid(pts_of(r))
    outer = [lonlat_to_local(g['lon'], g['lat']) for g in r['rings'][0]['outer']]
    wall = [[round(x - c[0], 2), round(-(z - c[1]), 2), round(dem.local(x, z), 1)] for x, z in outer]
    towers = [(6700.0, -6860.0, 'Sarıca Paşa', 11.65, 28.0, 'round'), (6785.0, -6725.0, 'Halil Paşa', 11.65, 22.0, 'poly12'),
              (6690.0, -6632.0, 'Zağanos Paşa', 13.35, 21.0, 'round')]
    S['rumeli_hisari'] = {'name': 'Rumeli Hisarı', 'origin': {'x': round(c[0], 2), 'z': round(c[1], 2)}, 'heading': 0.0,
                          'wall': wall,
                          'towers': [{'name': n, 'x': round(x - c[0], 2), 'y': round(-(z - c[1]), 2), 'r': rr, 'h': hh, 'shape': sh,
                                      'g': round(dem.local(x, z), 1)} for x, z, n, rr, hh, sh in towers],
                          'osm': ['r7318154'], 'zones': [zone_of(outer, 2.0)]}
    # ---- Topkapı Sarayı: every building inside the palace walls (historic=castle outline)
    els = load('topkapi')
    wall = find(els, 'w335415778')
    W = pts_of(wall)
    c = centroid(W)
    o = (c[0], c[1])
    blds = site_buildings(dem, els, o, 0.0, W, lambda e, t: t.get('building') not in ('construction', 'roof'))
    S['topkapi'] = {'name': 'Topkapı Sarayı', 'origin': {'x': round(o[0], 2), 'z': round(o[1], 2)}, 'heading': 0.0,
                    'walls': poly_model(o, 0.0, W), 'wall_g': [round(dem.local(x, z), 1) for x, z in W[:-1] if True],
                    'buildings': blds, 'adalet': 'w335402653', 'babusselam': 'w335402649', 'kitchens': 'w32396096',
                    'osm': sorted(b['id'] for b in blds), 'zones': [b['zone'] for b in blds]}
    S['topkapi'].update(topkapi_precinct(dem, els, o, W))
    S['topkapi']['osm'] = sorted(set(S['topkapi']['osm']) | {t['id'] for t in S['topkapi']['wall_towers']} |
                                 ({S['topkapi']['gate']['id']} if S['topkapi'].get('gate') else set()))
    S['topkapi']['zones'] += [t['zone'] for t in S['topkapi']['wall_towers']] + (
        [S['topkapi']['gate']['zone']] if S['topkapi'].get('gate') else [])
    # ---- Dolmabahçe Sarayı: the palace buildings (historic / palace / named parts of the palace)
    els = load('dolmabahce')
    keep_names = ('Dolmabahçe', 'Domabahçe', 'Daire', 'Köşk', 'Hareket', 'Hereke', 'Kapı', 'Uzun Yol', 'Kuşluk', 'Musahiban',
                  'Agavat', 'Resim Müzesi', 'Saat Kulesi')
    pal = [e for e in els if e['type'] != 'node' and 'building' in e.get('tags', {}) and (
        e['tags'].get('building') == 'palace' or e['tags'].get('historic') == 'building' or
        any(k in e['tags'].get('name', '') for k in keep_names)) and 'Deniz Müzesi' not in e['tags'].get('name', '')]
    allp = [p for e in pal for p in pts_of(e)]
    from shapely.geometry import MultiPoint
    hull = list(MultiPoint(allp).convex_hull.exterior.coords)
    o = centroid([centroid(pts_of(find(els, 'w263949162')))] * 1)
    blds = site_buildings(dem, pal, o, 0.0, hull, lambda e, t: True)
    S['dolmabahce'] = {'name': 'Dolmabahçe Sarayı', 'origin': {'x': round(o[0], 2), 'z': round(o[1], 2)}, 'heading': 0.0,
                       'buildings': blds, 'muayede': 'w263949162', 'clock': 'w263949143',
                       'osm': sorted(b['id'] for b in blds), 'zones': [b['zone'] for b in blds]}
    return S


def tall_buildings(dem, min_h=150.0):
    """Skyscrapers >= min_h m (OSM height or levels × 3.6) as obstacle landmarks, grouped by district (≤ 3 km)."""
    els = load('tall')
    skip = {'w722961117'}                                    # Çamlıca Kulesi: its own landmark
    cand = []
    for e in els:
        t = e.get('tags', {})
        if e['type'] == 'node' or osm_id(e) in skip or 'bridge' in t or t.get('building:part') == 'column':
            continue
        if t.get('man_made') in ('tower', 'mast') and 'building' not in t and 'building:part' not in t:
            continue
        h = num(t.get('height'))
        lv = num(t.get('building:levels'))
        H = h if h else (lv * 3.6 if lv else None)
        if h and lv and h / lv > 6.5:        # a height tag that is an elevation (ÖzdilekPark: 262–275 over 35 storeys)
            H = lv * 3.9
        if not H or H < min_h:
            continue
        P = pts_of(e)
        if len(P) < 4:
            continue
        cand.append({'id': osm_id(e), 'name': t.get('name', ''), 'pts': P, 'c': centroid(P), 'h': H, 'area': area(P),
                     'part': 'building:part' in t, 'man_made': t.get('man_made')})
    # drop a building outline that contains taller parts (podium + tower parts): keep the parts
    from shapely.geometry import Polygon, Point
    out = []
    for a in cand:
        pa = Polygon(a['pts']).buffer(0)
        inner = [b for b in cand if b is not a and b['area'] < a['area'] * 0.7 and pa.contains(Point(b['c']))]
        if inner and not a['part'] and a['area'] > 3000:
            continue
        out.append(a)
    # overlapping duplicates (same footprint twice): keep the taller
    res = []
    for a in sorted(out, key=lambda b: -b['h']):
        if any(math.hypot(a['c'][0] - b['c'][0], a['c'][1] - b['c'][1]) < 6 and abs(a['area'] - b['area']) < 0.3 * a['area'] for b in res):
            continue
        res.append(a)
    return res


# Named towers modelled with their own form (blender/landmarks_ist/skyline.py SPECS, keyed): OSM ways whose footprints
# are used (first = main outline, the rest = setback parts / second volumes). Positions / plans from OSM; heights and
# forms from CTBUH Skyscraper Center, Wikipedia and the architects (CONTRACTS-IST.md §6.L).
CURATED = {
    # Levent – Maslak – Şişli – Zincirlikuyu – Gümüşsuyu
    'sapphire': ['w673790538'],
    'isbank1': ['w829881961', 'w829881962', 'w829881963', 'w829881964', 'w829881965', 'w829881966', 'w829881967'],
    'isbank2': ['w829881972', 'w829881968'],
    'isbank3': ['w829881977', 'w829881974'],
    'kanyon': ['w905812925'],
    'metrocity_a': ['w587036060'],
    'metrocity_b': ['w587036063'],
    'metrocity_c': ['w905762567'],
    'akbank': ['w906490071', 'w906490072', 'w906490073'],
    'sabanci2': ['w906490074', 'w906490075', 'w906490076'],
    'suzer': ['w166702635'],
    'zorlu_a': ['w1251363333'], 'zorlu_b': ['w1251363335'], 'zorlu_c': ['w1251363336'], 'zorlu_h': ['w1251363337'],
    'trump_res': ['w1222286465'], 'trump_off': ['w1455454989'],
    'spine': ['w991113248'],
    'skyland_off': ['w559699014'], 'skyland_res': ['w559699016'],
    'ozdilek_e': ['w1382836093'], 'ozdilek_w': ['w1467663791'], 'ozdilek_mall': ['w1467663783'],
    # Ataşehir (İstanbul Finans Merkezi, Metropol, Varyap)
    'tcmb': ['w1238012472'], 'metropol_a': ['w492519336'], 'vakif1': ['w922036224'], 'ziraat1': ['w1132948418'],
    'ziraat2': ['w1132948419'], 'halk1': ['w883278828'], 'varyap_a': ['w363137498'],
}
# OSM parts / duplicates the curated forms replace (excluded from the city, not modelled on their own)
CURATED_DROP = ['w1251733113', 'w1467663786', 'w1467663794', 'w1467663782', 'w1467663788', 'w1467663789', 'w1467663790',
                'w829881969', 'w829881970', 'w829881971', 'w829881973', 'w829881975', 'w829881976']


def curated_towers(dem):
    """The CURATED towers from the OSM caches (tall / cbd_eu / cbd_as): main outline + parts, model-frame later."""
    els = {}
    for f in ('tall', 'cbd_eu', 'cbd_as'):
        if os.path.exists(os.path.join(RAW, f'{f}.json')):
            for e in load(f):
                if e['type'] != 'node':
                    els[osm_id(e)] = e
    out = []
    for key, ids in CURATED.items():
        es = [els[i] for i in ids if i in els]
        if not es or osm_id(es[0]) != ids[0]:
            print(f'  curated {key}: OSM {ids[0]} missing (run landmarks_ist_pbf.py --only cbd_eu,cbd_as)')
            continue
        P = pts_of(es[0])
        t = es[0].get('tags', {})
        out.append({'id': ids[0], 'key': key, 'name': t.get('name', ''), 'pts': P, 'c': centroid(P),
                    'h': num(t.get('height')) or (num(t.get('building:levels')) or 30) * 3.6, 'area': area(P),
                    'parts': [{'id': osm_id(e), 'pts': pts_of(e), 'levels': num(e.get('tags', {}).get('building:levels')),
                               'height': num(e.get('tags', {}).get('height'))} for e in es[1:]]})
    return out


def main():
    assert REGION_ID == 'ist', 'run with GEO_REGION=ist'
    dem = Dem()
    layout = json.load(open(LAYOUT)) if os.path.exists(LAYOUT) else {}
    layout['bridges'] = bridges(dem)
    for k, v in layout['bridges'].items():
        print(f"{k:16s} origin ({v['origin']['x']:.0f}, {v['origin']['z']:.0f}) heading {v['headingDeg']:.1f}° "
              f"s {v['s0']:.0f}..{v['s1']:.0f} towers {v.get('towers')}")
    layout['sites'] = sites(dem)
    for k, v in layout['sites'].items():
        print(f"{k:16s} origin ({v['origin']['x']:.0f}, {v['origin']['z']:.0f}) heading {math.degrees(v['heading']):.1f}° "
              f"osm {len(v['osm'])} zones {len(v['zones'])}")
    # skyscraper groups by district (nearest centre): European CBD (Levent / Maslak / Şişli / Skyland), Ataşehir, west
    districts = {'skyline_levent': (2200, -6500), 'skyline_atasehir': (11000, 3500), 'skyline_west': (-26500, -1500)}
    sky = {}
    cur = curated_towers(dem)
    taken = {b['id'] for b in cur} | {p['id'] for b in cur for p in b['parts']} | set(CURATED_DROP)
    generic = [b for b in tall_buildings(dem) if b['id'] not in taken]
    for b in generic:
        b['key'], b['parts'] = None, []
    for bld in cur + generic:
        key = min(districts, key=lambda k: math.hypot(districts[k][0] - bld['c'][0], districts[k][1] - bld['c'][1]))
        sky.setdefault(key, []).append(bld)
    for key, g in list(sky.items()):
        o = (round(float(np.mean([b['c'][0] for b in g])), 2), round(float(np.mean([b['c'][1] for b in g])), 2))
        sky[key] = {'name': {'skyline_levent': 'Levent – Maslak gökdelenleri', 'skyline_atasehir': 'Ataşehir gökdelenleri',
                             'skyline_west': 'Esenyurt – Beylikdüzü kuleleri'}[key],
                    'origin': {'x': o[0], 'z': o[1]}, 'heading': 0.0,
                    'buildings': [{'id': b['id'], 'key': b['key'], 'name': b['name'], 'height': round(b['h'], 1),
                                   'poly': poly_model(o, 0.0, b['pts']), 'g': ground_min(dem, b['pts']),
                                   'parts': [{'id': p['id'], 'poly': poly_model(o, 0.0, p['pts']), 'levels': p['levels'],
                                              'height': p['height']} for p in b['parts']],
                                   'tv': 'TV' in b['name'] or 'Televizyon' in b['name']} for b in g],
                    'osm': sorted({b['id'] for b in g} | {p['id'] for b in g for p in b['parts']} |
                                  (set(CURATED_DROP) if key == 'skyline_levent' else set())),
                    'zones': [zone_of(b['pts'], 1.5) for b in g]}
        print(f"{key:18s} {len(g)} buildings, tallest {max(b['h'] for b in g):.0f} m ({max(g, key=lambda b: b['h'])['name']})")
    layout['skyline'] = sky
    os.makedirs(os.path.dirname(LAYOUT), exist_ok=True)
    json.dump(layout, open(LAYOUT, 'w'), indent=1)
    print('wrote', LAYOUT)
    write_exclusions(layout)


def write_exclusions(layout):
    """data/ist/landmarks-exclude.json (city pipeline) + data/ist/landmarks.json (markers / approximate positions)."""
    ex = {'version': 1, 'note': 'Landmarks agent (tools/geo/landmarks_ist_layout.py). Generic city buildings must not '
          'duplicate these landmark models: drop OSM buildings / building:parts / minarets whose id is listed (w<way>, '
          'r<relation>, n<node>, the city pipeline\'s id format), and any footprint whose centroid falls inside a zone '
          '(local metres [x, z], Overture buildings have no OSM id). Bridge entries: the towers (OSM maps the tower legs / '
          'portal beams of 15 Temmuz and FSM as building:part "column" 165 m).',
          'landmarks': {}}
    lm = []
    for group in ('sites', 'skyline'):
        for k, v in layout.get(group, {}).items():
            ex['landmarks'][k] = {'name': v.get('name', k), 'osmIds': v['osm'], 'zones': v['zones']}
            lon, lat = local_to_lonlat(v['origin']['x'], v['origin']['z'])
            lm.append({'id': k, 'name': v.get('name', k), 'lon': round(lon, 6), 'lat': round(lat, 6),
                       'x': v['origin']['x'], 'z': v['origin']['z'], 'excludeRadius': 0,
                       'kind': 'tower' if group == 'skyline' or k in ('galata_kulesi', 'kiz_kulesi', 'camlica_kulesi') else 'building'})
    for k, v in layout.get('bridges', {}).items():
        lon, lat = local_to_lonlat(v['origin']['x'], v['origin']['z'])
        lm.append({'id': k, 'name': BRIDGE_NAMES.get(k, k), 'lon': round(lon, 6), 'lat': round(lat, 6), 'x': v['origin']['x'],
                   'z': v['origin']['z'], 'excludeRadius': 0, 'kind': 'bridge'})
    # bridges: OSM tower legs / portal beams are mapped as building:part (e.g. 15 Temmuz, FSM: 'column' 165 m) and would
    # become generic towers in the city layer: every building / building:part / bridge:support inside the deck corridor
    # (zones only around the towers: real buildings stand under the approach viaducts, e.g. FSMVÜ under Haliç Köprüsü)
    for k, v in layout.get('bridges', {}).items():
        if not v.get('towers'):
            continue
        zones = [tower_zone(v, st) for st in v['towers']]
        els = load(BRIDGE_SRC[k])
        from shapely.geometry import Polygon, Point
        Zs = [Polygon(z) for z in zones]
        ids = sorted({osm_id(e) for e in els if e['type'] != 'node' and ('building:part' in e.get('tags', {}) or
                      'bridge:support' in e.get('tags', {})) and any(Z.contains(Point(centroid(pts_of(e)))) for Z in Zs)})
        ex['landmarks'][k] = {'name': BRIDGE_NAMES.get(k, k), 'osmIds': ids, 'zones': zones}
    ids = sorted({i for v in ex['landmarks'].values() for i in v['osmIds']})
    ex['osmIds'] = ids
    json.dump(ex, open(EXCLUDE, 'w'), indent=1)
    json.dump({'note': 'Landmarks agent (tools/geo/landmarks_ist_layout.py): landmark positions (local m, lon/lat); the '
               'models are assets/ist/landmarks/index.json, the city exclusions data/ist/landmarks-exclude.json.',
               'landmarks': lm}, open(LMJSON, 'w'), indent=1)
    print('wrote', EXCLUDE, f'({len(ids)} OSM ids, {sum(len(v["zones"]) for v in ex["landmarks"].values())} zones)')
    print('wrote', LMJSON)


BRIDGE_SRC = {'bogazici': 'bogazici', 'fsm': 'fsm', 'yss': 'yss', 'galata_bridge': 'halic_inner', 'ataturk_bridge': 'halic_inner',
              'halic_metro': 'halic_inner', 'halic_bridge': 'halic_o1'}


def tower_zone(v, st, half_w=60.0, half_l=25.0):
    """World rectangle around a bridge tower (model frame s = st ± half_l, x = ±half_w)."""
    o, h = (v['origin']['x'], v['origin']['z']), v['heading']
    ring_ = [to_world(o, h, -half_w, st - half_l), to_world(o, h, half_w, st - half_l), to_world(o, h, half_w, st + half_l),
             to_world(o, h, -half_w, st + half_l)]
    return [[round(x, 1), round(z, 1)] for x, z in ring_]


def bridge_corridor(v, half_w=None):
    """World polygon around a bridge deck (model frame strip s0-20 … s1+20, ±half_w; along the path for curved decks)."""
    o, h = (v['origin']['x'], v['origin']['z']), v['heading']
    hw = half_w or (60.0 if v.get('towers') else 30.0)
    if 'path' in v:
        P = v['path']
        left = [to_world(o, h, X - hw, Y) for X, Y in P]
        right = [to_world(o, h, X + hw, Y) for X, Y in P]
        ring_ = left + right[::-1]
    else:
        s0, s1 = v['s0'] - 20, v['s1'] + 20
        ring_ = [to_world(o, h, -hw, s0), to_world(o, h, hw, s0), to_world(o, h, hw, s1), to_world(o, h, -hw, s1)]
    return [[round(x, 1), round(z, 1)] for x, z in ring_]


BRIDGE_NAMES = {'bogazici': '15 Temmuz Şehitler Köprüsü', 'fsm': 'Fatih Sultan Mehmet Köprüsü',
                'yss': 'Yavuz Sultan Selim Köprüsü', 'galata_bridge': 'Galata Köprüsü', 'ataturk_bridge': 'Atatürk Köprüsü',
                'halic_metro': 'Haliç Metro Köprüsü', 'halic_bridge': 'Haliç Köprüsü'}


if __name__ == '__main__':
    main()
