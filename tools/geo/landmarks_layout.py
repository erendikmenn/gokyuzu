"""W3 landmarks: derive exact positions / orientations of the landmarks from cached OSM geometry.

Reads data/sf/raw/osm_landmarks/*.json (see landmarks_osm.py) and writes blender/landmarks/layout.json (checked in,
so the Blender builds are reproducible offline). Every landmark gets a frame:
    origin {x, z} in local game meters, heading (radians, 0 = north/-Z, clockwise), plus landmark-specific numbers.
Model convention in Blender: +Y = the landmark's "forward" (heading direction), +X = right, +Z = up (meters MSL for
bridges, meters above the local ground for buildings).
"""
import json, math, os, sys

sys.path.insert(0, os.path.dirname(__file__))
from geo import lonlat_to_local  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RAW = os.path.join(ROOT, 'data', 'sf', 'raw', 'osm_landmarks')
OUT = os.path.join(ROOT, 'blender', 'landmarks', 'layout.json')


def load(name):
    p = os.path.join(RAW, f'{name}.json')
    return json.load(open(p))['elements'] if os.path.exists(p) else None


def way_pts(e):
    return [lonlat_to_local(g['lon'], g['lat']) for g in e['geometry']]


def centroid(pts):
    """Area centroid of a closed polygon (x,z)."""
    a = cx = cz = 0.0
    n = len(pts)
    for i in range(n - 1 if pts[0] == pts[-1] else n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        c = x0 * z1 - x1 * z0
        a += c
        cx += (x0 + x1) * c
        cz += (z0 + z1) * c
    if abs(a) < 1e-9:
        return sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n
    return cx / (3 * a), cz / (3 * a)


def frame_local(origin, heading):
    """Functions converting world (x,z) <-> frame (right, forward)."""
    ux, uz = math.sin(heading), -math.cos(heading)      # forward
    vx, vz = math.cos(heading), math.sin(heading)       # right
    ox, oz = origin

    def to_frame(p):
        dx, dz = p[0] - ox, p[1] - oz
        return dx * vx + dz * vz, dx * ux + dz * uz       # (right, forward)
    return to_frame


def ggb(layout):
    els = load('ggb')
    legs = {}
    for e in els:
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('man_made') == 'tower' and t.get('height') == '123':
            c = centroid(way_pts(e))
            legs.setdefault('S' if c[1] > -22200 else 'N', []).append(c)
    S = [sum(p[i] for p in legs['S']) / 2 for i in (0, 1)]
    N = [sum(p[i] for p in legs['N']) / 2 for i in (0, 1)]
    dx, dz = N[0] - S[0], N[1] - S[1]
    span = math.hypot(dx, dz)
    heading = math.atan2(dx, -dz) % (2 * math.pi)
    origin = ((S[0] + N[0]) / 2, (S[1] + N[1]) / 2)
    to_f = frame_local(origin, heading)
    # key along-positions (forward coordinate s) of named supports
    named = {}
    for e in els:
        t = e.get('tags', {})
        if e['type'] != 'way':
            continue
        nm = t.get('name')
        if nm in ('Pylon S1', 'Pylon S2', 'Pylon N1', 'Pylon N2', 'South Anchorage', 'North Anchor', 'Fort Point Arch',
                  'San Fransisco Approach'):
            pts = [to_f(p) for p in way_pts(e)]
            s = [p[1] for p in pts]
            r = [p[0] for p in pts]
            named.setdefault(nm, []).append({'s': [min(s), max(s)], 'r': [min(r), max(r)]})
    # roadway centerline (average of the two carriageways) sampled for the approach curves
    lines = []
    for e in els:
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('highway') == 'motorway' and 'Golden Gate' in t.get('name', ''):
            lines.append([to_f(p) for p in way_pts(e)])
    layout['golden_gate'] = {
        'origin': {'x': round(origin[0], 2), 'z': round(origin[1], 2)},
        'heading': heading, 'headingDeg': math.degrees(heading),
        'mainSpan': span, 'towers': {'S': S, 'N': N},
        'supports': named,
        'roadLines': [[[round(a, 1), round(b, 1)] for a, b in l] for l in lines],
    }
    print(f'GGB origin {origin} heading {math.degrees(heading):.3f} deg, main span {span:.1f} m')


def baybridge(layout):
    els = load('baybridge')
    ways = {e['id']: e for e in els if e['type'] == 'way'}
    refs = {}
    for e in ways.values():
        t = e.get('tags', {})
        if t.get('ref') in ('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'):
            pts = way_pts(e)
            refs[t['ref']] = pts
    cen = {k: centroid(v) for k, v in refs.items()}
    W2, W6 = cen['W2'], cen['W6']
    dx, dz = W6[0] - W2[0], W6[1] - W2[1]
    heading = math.atan2(dx, -dz) % (2 * math.pi)
    to_f = frame_local(W2, heading)
    west = {'origin': {'x': round(W2[0], 2), 'z': round(W2[1], 2)}, 'heading': heading, 'headingDeg': math.degrees(heading)}
    ext = {}
    for k, v in refs.items():
        f = [to_f(p) for p in v]
        ext[k] = {'s': [min(q[1] for q in f), max(q[1] for q in f)], 'r': [min(q[0] for q in f), max(q[0] for q in f)],
                  'c': to_f(cen[k])[::-1]}
    # side-span end pier near the Embarcadero (unnamed bridge:support=pier way)
    for e in ways.values():
        t = e.get('tags', {})
        if t.get('bridge:support') == 'pier' and not t.get('ref') and not t.get('name'):
            c = centroid(way_pts(e))
            sr = to_f(c)
            if -500 < sr[1] < -200 and abs(sr[0]) < 40:
                ext['P0'] = {'c': [sr[1], sr[0]]}
    # tunnel through Yerba Buena Island (both decks)
    tun = [way_pts(ways[i]) for i in (11415208, 50691047)]
    west['supports'] = ext
    west['tunnel'] = [[list(map(lambda v: round(v, 1), to_f(p)))[::-1] for p in t] for t in tun]
    # east span: the two carriageways (west -> east), the upper-deck link into the tunnel, SAS tower
    A = way_pts(ways[237731428])
    B = way_pts(ways[236348361])[::-1]
    Bup = way_pts(ways[497579295])[::-1] + way_pts(ways[929579737])[::-1][1:] + way_pts(ways[236348360])[::-1][1:]
    tower = centroid(way_pts(ways[237735191]))
    east = {'A': [[round(x, 2), round(z, 2)] for x, z in A], 'B': [[round(x, 2), round(z, 2)] for x, z in B],
            'Bup': [[round(x, 2), round(z, 2)] for x, z in Bup], 'tower': [round(tower[0], 2), round(tower[1], 2)],
            'portalE': [round(v, 2) for v in way_pts(ways[11415208])[0]]}
    layout['bay_bridge'] = {'west': west, 'east': east}
    print(f'Bay Bridge west origin {W2} heading {math.degrees(heading):.3f}; supports', {k: round(v['c'][0], 1) for k, v in ext.items()})


def main():
    layout = json.load(open(OUT)) if os.path.exists(OUT) else {}
    names = sys.argv[1:] or ['ggb']
    for n in names:
        globals()[n](layout)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(layout, open(OUT, 'w'), indent=1)
    print('wrote', OUT)



def _ring(pts):
    """Closed OSM ring -> open CCW list in (x_east, y_north) ... returned in world (x, z)."""
    p = list(pts)
    if len(p) > 2 and p[0] == p[-1]:
        p = p[:-1]
    a = sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))
    # in (x, z) with z = south, CCW-when-seen-from-above in (x, north) means a > 0 here
    if a < 0:
        p = p[::-1]
    return [[round(x, 2), round(z, 2)] for x, z in p]


def _ground(poly):
    from landmarks_context import dem_at
    hs = [dem_at(x, z) for x, z in poly]
    cx = sum(p[0] for p in poly) / len(poly)
    cz = sum(p[1] for p in poly) / len(poly)
    hs.append(dem_at(cx, cz))
    hc = hs[-1]
    hs = [h for h in hs if h == h]
    return (round(min(hs), 2), round(max(hs), 2), round(hc if hc == hc else min(hs), 2)) if hs else (0.0, 0.0, 0.0)


def sites(layout):
    import numpy as np
    from landmarks_context import dem_at
    out = {}
    # --- Alcatraz: every mapped building with its DEM ground
    bl = []
    for e in load('alcatraz'):
        t = e.get('tags', {})
        if e['type'] != 'way':
            continue
        if not ('building' in t or t.get('man_made') in ('water_tower', 'lighthouse', 'reservoir_covered')):
            continue
        poly = _ring(way_pts(e))
        g0, g1, gc = _ground(poly)
        bl.append({'id': e['id'], 'name': t.get('name', ''), 'building': t.get('building', ''), 'man_made': t.get('man_made', ''),
                   'poly': poly, 'g': g0, 'gmax': g1, 'gc': gc})
    yard_c = (-4469.0, -23074.0)
    out['alcatraz'] = {'origin': [-4400.0, -23030.0], 'buildings': bl,
                       'yard': {'c': yard_c, 'w': 46.0, 'd': 40.0, 'angle': 45.5, 'gc': round(dem_at(*yard_c), 2)}}
    # --- Fort Point (multipolygon outer + courtyard)
    fp = load('rel_fortpoint')[0]
    rings = {m['role']: _ring([lonlat_to_local(g['lon'], g['lat']) for g in m['geometry']]) for m in fp['members'] if 'geometry' in m}
    g0, g1, gc = _ground(rings['outer'])
    out['fort_point'] = {'outer': rings['outer'], 'inner': rings.get('inner'), 'g': g0, 'gmax': g1, 'gc': gc}
    # --- City Hall
    ch = load('rel_cityhall')[0]
    outer = [m for m in ch['members'] if m['role'] == 'outer' and 'geometry' in m][0]
    inners = [_ring([lonlat_to_local(g['lon'], g['lat']) for g in m['geometry']]) for m in ch['members'] if m['role'] == 'inner' and 'geometry' in m and len(m['geometry']) > 4]
    op = _ring([lonlat_to_local(g['lon'], g['lat']) for g in outer['geometry']])
    g0, g1, gc = _ground(op)
    out['city_hall'] = {'outer': op, 'courts': inners, 'g': g0, 'gmax': g1, 'gc': gc}
    # --- Palace of Fine Arts
    pal = {}
    for e in load('palace'):
        if e['type'] != 'way':
            continue
        if e['id'] in (288371295, 288371302, 288371306, 288371310):
            poly = _ring(way_pts(e))
            g0, g1, gc = _ground(poly)
            pal[str(e['id'])] = {'poly': poly, 'g': g0, 'gc': gc, 'height': e['tags'].get('height')}
        if e.get('tags', {}).get('natural') == 'water':
            pal['lagoon'] = {'poly': _ring(way_pts(e))}
    out['palace'] = pal
    # --- Chase Center
    for e in load('chase'):
        if e['type'] == 'way' and e['id'] == 579646390:
            poly = _ring(way_pts(e))
            g0, g1, gc = _ground(poly)
            out['chase_center'] = {'poly': poly, 'g': g0, 'gmax': g1, 'gc': gc, 'height': 38.1}
    # --- Oracle Park: field polygon
    for e in load('oracle'):
        if e['type'] == 'way' and e['id'] == 500283910:
            poly = _ring(way_pts(e))
            g0, g1, gc = _ground(poly)
            out['oracle_park'] = {'field': poly, 'g': g0, 'gc': gc, 'home': [-1441.0, -17676.5], 'cf_heading': 80.0,
                                  'g_home': round(dem_at(-1441.0, -17676.5), 2)}
    # --- Painted Ladies 710-722 Steiner
    houses = []
    for e in load('painted'):
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('addr:street') == 'Steiner Street' and t.get('addr:housenumber') in ('710', '712', '714', '716', '718', '720', '722'):
            poly = _ring(way_pts(e))
            g0, g1, gc = _ground(poly)
            houses.append({'no': t['addr:housenumber'], 'poly': poly, 'g': g0, 'gmax': g1, 'gc': gc, 'height': float(t.get('height', 12))})
    out['painted_ladies'] = sorted(houses, key=lambda h: h['no'])
    # --- Pier 39: pier deck + buildings
    pier = {'buildings': []}
    for e in load('pier39'):
        t = e.get('tags', {})
        if e['type'] != 'way':
            continue
        if e['id'] == 199829618:
            pier['deck'] = _ring(way_pts(e))
        elif t.get('building') and (t.get('name', '').startswith('Building') or e['id'] in (128240118, 128240149, 288396169, 288396171, 466623895)):
            poly = _ring(way_pts(e))
            g0, g1, gc = _ground(poly)
            pier['buildings'].append({'name': t.get('name', ''), 'poly': poly, 'g': g0, 'gc': gc, 'levels': t.get('building:levels'),
                                      'height': t.get('height')})
    out['pier_39'] = pier
    # --- Port of Oakland STS cranes: orientation from neighbours along the rail + water side from the DEM
    cr = [lonlat_to_local(e['lon'], e['lat']) for e in load('cranes') if e['type'] == 'node' and e.get('tags', {}).get('man_made') == 'crane']
    P = np.array(cr)
    cranes = []
    for i, p in enumerate(P):
        d = np.linalg.norm(P - p, axis=1)
        d[i] = 1e9
        nb = np.argsort(d)[:2]
        v = P[nb[0]] - p if d[nb[0]] < 400 else np.array([1.0, 0.0])
        if d[nb[1]] < 400:
            v2 = P[nb[1]] - p
            if np.dot(v, v2) < 0:
                v2 = -v2
            v = v + v2
        v = v / np.linalg.norm(v)
        nrm = np.array([-v[1], v[0]])
        # boom side = lower ground (water)
        hs = [dem_at(*(p + nrm * 45)), dem_at(*(p - nrm * 45))]
        if hs[1] < hs[0]:
            nrm = -nrm
        g = dem_at(*p)
        heading = math.atan2(nrm[0], -nrm[1])        # boom direction (towards the water)
        cranes.append([round(float(p[0]), 1), round(float(p[1]), 1), round(float(heading), 4), round(float(g), 2)])
    out['cranes'] = cranes
    layout['sites'] = out
    print('sites:', {k: (len(v) if isinstance(v, list) else len(v.get('buildings', v))) for k, v in out.items()})


if __name__ == '__main__':
    main()
