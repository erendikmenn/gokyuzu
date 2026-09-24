"""Airport surfaces for terrain built from a DSM (GEO_REGION=ist): every runway rectangle (+60 m shoulders / overruns)
follows its data/ist/runways.json per-end elevations (`ends[k].elevation`, linear between the two ends; the runway
`elevation` for an end without one), taxiways / aprons / the aerodrome on a smooth surface through them, blended into
the DEM.

Runway elevations: data/ist/runways.json (AIP end elevations: LTFM 94-99 m south ends to 62-67 m north ends, LTFJ
88-93 m, LTBA 27-28 m); airports missing there fall back to OSM runways + OurAirports end elevations (public domain,
AIP values, cached in raw/ourairports/), recorded in the output next to the terrain values.
Surface per airport (MODES):
  platform: thin-plate spline through anchors on every runway centreline and edge, over the whole zone. LTFM
            (Copernicus GLO-30 / TanDEM-X 2011-2015 predates the airport, built 2015-2018 on an open-pit mining site: the
            DEM there is the old ground) and LTFJ.
  fit     : a plane fitted to the DEM on the paved areas (robust, shrinking outlier threshold 10 -> 2.5 m: terminal /
            hangar roofs in the DSM are rejected; a quadratic overshot at the aerodrome corners), plus the runway
            residuals (spline, exact on the runway rectangles) faded out 800 m from the runways. LTBA (only 05/23 is still a runway; its old 17/35 area rises ~20 m to the north).
Zone = aerodrome polygon (-30 m) + runways (+60 m) + aprons + taxiways (+7.5 m); paved areas are exact, the zone edge
blends into the DEM over 150-600 m (wider where the DEM differs more: at most ~20 % slopes on the blend).
Approach grading (grade_approaches): the DEM predates LTFM and rises above its south thresholds, so for every runway end
the ground under the approach is cut (never filled) down to an earthwork surface: strip level at the threshold, rising
2 % from 60 m out (the ICAO approach surface), and never higher than 20 m below a 3° glide path aimed 300 m past the
threshold; over the ICAO approach-surface width (150 m each side, diverging 15 %) out to 5 km, faded out over 250 m to
the sides and 5-5.6 km out. Runway rectangles and pavement stay exact. The resulting minimum clearance under the path
(terrain only, +-60 m of the centreline, by distance band) per end goes into terrain_airports.json ("approach").
Output : <cache>/airports.pkl (geometry for terrain_build.py), data/ist/terrain_airports.json (tracked: per airport
         and runway end the elevation the terrain has there, for the airports / engine pipelines).
Usage  : imported by terrain_build.py; `GEO_REGION=ist .venv/bin/python tools/geo/terrain_airports.py` rebuilds the cache.
"""
import os, json, csv, pickle
import numpy as np
from shapely.geometry import LineString, Polygon, Point, box
from shapely.ops import unary_union, linemerge
from terrain_common import RAW, CACHE, DATA_DIR, RUNWAYS_JSON, USER_AGENT, fetch
from geo import lonlat_to_local

AIRPORTS = ('LTFM', 'LTFJ', 'LTBA')
MODES = {'LTFM': 'platform', 'LTFJ': 'platform', 'LTBA': 'fit'}
FT = 0.3048
OURAIRPORTS = 'https://davidmegginson.github.io/ourairports-data/{}.csv'
PKL = os.path.join(CACHE, 'airports.pkl')
OUT_JSON = os.path.join(DATA_DIR, 'terrain_airports.json')
TAXI_W = 23.0          # default taxiway width (m) when OSM has no width tag
SHOULDER_TAXI = 7.5


def _poly_of(e):
    """Overpass element (closed way or multipolygon relation with geometry) -> local Polygon (or None)."""
    def loc(g):
        return [lonlat_to_local(p['lon'], p['lat']) for p in g]
    if e['type'] == 'way':
        g = e.get('geometry') or []
        if len(g) >= 4 and (g[0]['lat'], g[0]['lon']) == (g[-1]['lat'], g[-1]['lon']):
            return Polygon(loc(g)).buffer(0)
        return None
    outers, inners = [], []
    for m in e.get('members', []):
        if m.get('type') == 'way' and m.get('geometry'):
            (inners if m.get('role') == 'inner' else outers).append(LineString(loc(m['geometry'])))
    def rings(ls):
        if not ls:
            return Polygon()
        mg = linemerge(ls)
        return unary_union([Polygon(g.coords) for g in getattr(mg, 'geoms', [mg]) if g.is_ring and len(g.coords) >= 4])
    p = rings(outers).buffer(0)
    if inners:
        p = p.difference(rings(inners).buffer(0))
    return p if not p.is_empty else None


def _line_of(e):
    g = e.get('geometry') or []
    return LineString([lonlat_to_local(p['lon'], p['lat']) for p in g]) if len(g) >= 2 else None


def _width(t, default):
    try:
        return float(str(t.get('width', '')).replace('m', '').strip())
    except ValueError:
        return default


def ourairports():
    d = os.path.join(RAW, 'ourairports')
    out = {}
    for name in ('airports', 'runways'):
        fetch(OURAIRPORTS.format(name), None, os.path.join(d, name + '.csv'), min_bytes=10000)
    names = {r['ident']: r['name'] for r in csv.DictReader(open(os.path.join(d, 'airports.csv'), encoding='utf-8'))
             if r['ident'] in AIRPORTS}
    for r in csv.DictReader(open(os.path.join(d, 'runways.csv'), encoding='utf-8')):
        if r['airport_ident'] not in AIRPORTS:
            continue
        ends = []
        for k in ('le', 'he'):
            if not r[f'{k}_latitude_deg'] or not r[f'{k}_elevation_ft']:
                break
            x, z = lonlat_to_local(float(r[f'{k}_longitude_deg']), float(r[f'{k}_latitude_deg']))
            ends.append({'ident': r[f'{k}_ident'], 'x': x, 'z': z, 'elevation': float(r[f'{k}_elevation_ft']) * FT})
        if len(ends) == 2:
            out.setdefault(r['airport_ident'], []).append({'ids': (ends[0]['ident'], ends[1]['ident']), 'ends': ends,
                                                           'width': float(r['width_ft'] or 148) * FT, 'closed': r['closed'] == '1'})
    return out, names


def agent_airports():
    """{icao: airport} from data/ist/runways.json (the airports pipeline), if it exists."""
    if not os.path.exists(RUNWAYS_JSON):
        return {}
    return {a['icao']: a for a in json.load(open(RUNWAYS_JSON)).get('airports', []) if a.get('runways')}


def agent_runway_ends():
    """Per-end elevations from data/ist/runways.json when the airports pipeline provides them ({ident: elevation})."""
    if not os.path.exists(RUNWAYS_JSON):
        return {}
    out = {}
    for a in json.load(open(RUNWAYS_JSON)).get('airports', []):
        for r in a.get('runways', []):
            for e in r.get('ends', []):
                if 'elevation' in e:
                    out[(a['icao'], e['ident'])] = float(e['elevation'])
    return out


def build():
    osm = json.load(open(os.path.join(RAW, 'osm_w1', 'aeroways.json')))['elements']
    oa, names = ourairports()
    agent = agent_runway_ends()
    icaos = set(AIRPORTS)
    if os.path.exists(RUNWAYS_JSON):
        icaos |= {a['icao'] for a in json.load(open(RUNWAYS_JSON)).get('airports', []) if a['icao'] in oa}
    aerodromes = {}
    for e in osm:
        t = e.get('tags', {})
        if t.get('aeroway') == 'aerodrome' and t.get('icao') in icaos:
            p = _poly_of(e)
            if p is not None:
                aerodromes[t['icao']] = p if t['icao'] not in aerodromes else aerodromes[t['icao']].union(p)
    apts = []
    for icao in sorted(icaos):
        ad = aerodromes.get(icao)
        if ad is None:
            print('airport', icao, 'has no OSM aerodrome polygon: skipped')
            continue
        near = ad.buffer(300)
        runways, taxi, aprons = [], [], []
        for e in osm:
            t = e.get('tags', {})
            kind = t.get('aeroway')
            if kind == 'runway':
                ln = _line_of(e)
                if ln is None or not near.intersects(ln):
                    continue
                if e['type'] == 'way' and e['geometry'][0] == e['geometry'][-1]:   # area-mapped runway: long axis
                    r = ln.minimum_rotated_rectangle
                    c = np.asarray(r.exterior.coords)[:4]
                    s = [np.hypot(*(c[(k + 1) % 4] - c[k])) for k in range(4)]
                    k = int(np.argmax(s))
                    m0, m1 = (c[(k + 3) % 4] + c[k]) / 2, (c[(k + 1) % 4] + c[(k + 2) % 4]) / 2
                    ln, w = LineString([m0, m1]), min(s)
                else:
                    w = _width(t, 45.0)
                runways.append({'ref': t.get('ref', ''), 'line': ln, 'width': w})
            elif kind == 'taxiway':
                ln = _line_of(e)
                if ln is not None and near.intersects(ln):
                    taxi.append(ln.buffer(_width(t, TAXI_W) / 2 + SHOULDER_TAXI, cap_style='flat'))
            elif kind in ('apron', 'helipad', 'stopway', 'blast_pad'):
                p = _poly_of(e) if (e['type'] == 'relation' or (e.get('geometry') and e['geometry'][0] == e['geometry'][-1])) else None
                if p is not None and near.intersects(p):
                    aprons.append(p)
        anchors = []
        rws = []
        agent_apt = agent_airports().get(icao)
        if agent_apt:   # the airports pipeline's runways (geometry + elevations): what the runway meshes use
            for r in agent_apt['runways']:
                (a0, a1) = r['ends']
                ea = a0.get('elevation', r['elevation'])
                eb = a1.get('elevation', r['elevation'])
                P0, P1 = np.array([a0['x'], a0['z']]), np.array([a1['x'], a1['z']])
                L = float(np.hypot(*(P1 - P0)))
                dvec = (P1 - P0) / L
                nvec = np.array([-dvec[1], dvec[0]])
                hw = r['width'] / 2
                for sd in np.linspace(-60.0, L + 60.0, max(3, int((L + 120) / 60) + 1)):   # rectangle + 60 m overruns
                    t = min(max(sd / L, 0.0), 1.0)
                    p = P0 + dvec * sd
                    for off in (-hw - 60.0, -hw, 0.0, hw, hw + 60.0):                          # + 60 m shoulders
                        q = p + nvec * off
                        anchors.append((q[0], q[1], ea + (eb - ea) * t))
                pub = {e['ident']: e['elevation'] for o in oa.get(icao, []) for e in o['ends']}
                rws.append({'ref': r['id'], 'ids': [a0['ident'], a1['ident']], 'a': [a0['x'], a0['z'], ea],
                            'b': [a1['x'], a1['z'], eb], 'width': r['width'], 'line': LineString([P0, P1]),
                            'disp': [float(a0.get('displaced') or 0.0), float(a1.get('displaced') or 0.0)],
                            'published': [[a0['ident'], round(pub[a0['ident']], 2) if a0['ident'] in pub else None],
                                          [a1['ident'], round(pub[a1['ident']], 2) if a1['ident'] in pub else None]]})
            runways = []
        # runway end elevations: OSM runway line projected on the published end-to-end segment
        for r in runways:
            ids = r['ref'].replace(' ', '').split('/')
            match = None
            for o in oa.get(icao, []):
                if set(ids) & set(o['ids']):
                    match = o
                    break
            c = np.asarray(r['line'].coords)
            a_, b_ = c[0], c[-1]
            if match is None:
                print(f'  {icao} runway {r["ref"]!r}: no published elevations (surface interpolated)')
                rws.append({'ref': r['ref'], 'a': [*a_, None], 'b': [*b_, None], 'width': r['width'], 'line': r['line']})
                continue
            e0, e1 = match['ends']
            el0 = agent.get((icao, e0['ident']), e0['elevation'])
            el1 = agent.get((icao, e1['ident']), e1['elevation'])
            P0, P1 = np.array([e0['x'], e0['z']]), np.array([e1['x'], e1['z']])
            u = P1 - P0
            Lu = float(u @ u)

            def elev(p):
                s = float((np.asarray(p) - P0) @ u) / Lu
                return el0 + (el1 - el0) * s
            # orient the OSM line like the published runway (le -> he)
            if (b_ - a_) @ u < 0:
                a_, b_ = b_, a_
            L = float(np.hypot(*(b_ - a_)))
            dvec = (b_ - a_) / L
            nvec = np.array([-dvec[1], dvec[0]])
            for sd in np.linspace(-60.0, L + 60.0, max(3, int((L + 120) / 60) + 1)):
                p = a_ + dvec * min(max(sd, 0.0), L)
                for off in (-r['width'] / 2 - 60.0, -r['width'] / 2, 0.0, r['width'] / 2, r['width'] / 2 + 60.0):
                    q = a_ + dvec * sd + nvec * off
                    anchors.append((q[0], q[1], elev(p)))
            rws.append({'ref': r['ref'], 'ids': [e0['ident'], e1['ident']], 'a': [float(a_[0]), float(a_[1]), elev(a_)],
                        'b': [float(b_[0]), float(b_[1]), elev(b_)], 'width': r['width'], 'line': LineString([a_, b_]),
                        'published': [[e0['ident'], round(el0, 2)], [e1['ident'], round(el1, 2)]],
                        'closedInOurAirports': match['closed']})
        rect = lambda rw, extra, wext=None: _rect(rw['line'], rw['width'] / 2 + (extra if wext is None else wext), extra)
        paved = unary_union([rect(rw, 10.0) for rw in rws] + taxi + aprons)
        zone = unary_union([ad.buffer(-30)] + [rect(rw, 60.0) for rw in rws] + taxi + aprons)
        apts.append({'icao': icao, 'name': (agent_apt or {}).get('name') or names.get(icao, icao), 'aerodrome': ad,
                     'zone': zone, 'paved': paved, 'runways': rws, 'anchors': np.array(anchors, np.float64),
                     'mode': MODES.get(icao, 'dem'), 'source': 'data/ist/runways.json' if agent_apt else 'OSM + OurAirports'})
        print(f'airport {icao}: {len(rws)} runways, {len(taxi)} taxiways, {len(aprons)} aprons, {len(anchors)} anchors, '
              f'zone {zone.area / 1e6:.1f} km2, profile {min(a[2] for a in anchors):.1f}..{max(a[2] for a in anchors):.1f} m')
    os.makedirs(CACHE, exist_ok=True)
    pickle.dump(apts, open(PKL, 'wb'))
    return apts


def _rect(line, hw, ext):
    c = np.asarray(line.coords)
    a, b = c[0], c[-1]
    L = float(np.hypot(*(b - a)))
    d = (b - a) / L
    n = np.array([-d[1], d[0]])
    a2, b2 = a - d * ext, b + d * ext
    return Polygon([a2 + n * hw, b2 + n * hw, b2 - n * hw, a2 - n * hw])


def runway_polys(apt, extra):
    """Runway rectangles widened by `extra` (shoulders) and extended by `extra` past both ends (sf: runway_polys)."""
    return [_rect(r['line'], r['width'] / 2 + extra, extra) for r in apt['runways']]


def load():
    apts = pickle.load(open(PKL, 'rb')) if os.path.exists(PKL) else build()
    for a in apts:
        a['runway_polys'] = (lambda aa: (lambda extra: runway_polys(aa, extra)))(a)
    return apts


def _spline_grid(pts, vals, xs, zs):
    """Thin-plate spline through (pts, vals), evaluated on the grid xs (cols) x zs (rows) (on a 32 m lattice, bilinear
    in between: the spline is smooth at that scale)."""
    from scipy.interpolate import RBFInterpolator, RegularGridInterpolator
    rbf = RBFInterpolator(pts, vals, kernel='thin_plate_spline', degree=1, smoothing=1e-3)
    gx = np.arange(xs[0], xs[-1] + 32.0, 32.0)
    gz = np.arange(zs[0], zs[-1] + 32.0, 32.0)
    GX, GZ = np.meshgrid(gx, gz)
    v = rbf(np.stack([GX.ravel(), GZ.ravel()], 1)).reshape(GX.shape)
    it = RegularGridInterpolator((gz, gx), v, bounds_error=False, fill_value=None)
    ZZ, XX = np.meshgrid(zs, xs, indexing='ij')
    return it(np.stack([ZZ.ravel(), XX.ravel()], 1)).reshape(ZZ.shape).astype(np.float32)


def target_surface(apt, xs, zs, dem=None, water=None, rw_mask=None, paved=None):
    """The airport surface on the grid xs x zs (see MODES in the module docstring)."""
    from scipy import ndimage
    an = apt['anchors']
    if apt.get('mode', 'platform') == 'platform' or dem is None:
        return _spline_grid(an[:, :2], an[:, 2], xs, zs)
    d = xs[1] - xs[0]
    cx, cz = float(np.mean(an[:, 0])), float(np.mean(an[:, 1]))
    def basis(x, z):
        u, v = (x - cx) / 1000.0, (z - cz) / 1000.0
        return np.stack([np.ones_like(u), u, v], -1)
    js, is_ = np.nonzero(paved & ~water)
    k = max(1, len(js) // 20000)
    js, is_ = js[::k], is_[::k]
    px, pz, ph = xs[is_], zs[js], dem[js, is_].astype(np.float64)
    A, y = basis(px, pz), ph
    wt = np.ones(len(ph))
    for thr in (10.0, 6.0, 4.0, 3.0, 2.5, 2.5):   # iteratively drop roofs / hangars (the DSM stands on the pavement there)
        coef = np.linalg.lstsq(A * wt[:, None], y * wt, rcond=None)[0]
        wt = (np.abs(y - A @ coef) < thr).astype(np.float64)
    X, Z = np.meshgrid(xs, zs)
    Q = (basis(X, Z) @ coef).astype(np.float32)
    fx = np.clip((an[:, 0] - xs[0]) / d, 0, len(xs) - 1.001)
    fz = np.clip((an[:, 1] - zs[0]) / d, 0, len(zs) - 1.001)
    res = an[:, 2] - ndimage.map_coordinates(Q, [fz, fx], order=1)
    C = _spline_grid(an[:, :2], res, xs, zs)
    drw = ndimage.distance_transform_edt(~rw_mask) * d
    t = np.clip(drw / 800.0, 0, 1)
    return (Q + C * (1 - t * t * (3 - 2 * t))).astype(np.float32)


def flatten(apts, h, water, x0, z0, d, log=print):
    """Blend every airport's surface into the grid h (sample centres x0 + i*d, z0 + j*d); water samples stay."""
    from scipy import ndimage
    from rasterio import features
    from affine import Affine

    def smoothstep(e0, e1, x):
        t = np.clip((x - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)
    report = []
    for apt in apts:
        m = 800.0
        bx0, bz0, bx1, bz1 = apt['zone'].bounds
        i0 = max(0, int((bx0 - m - x0) / d)); i1 = min(h.shape[1], int((bx1 + m - x0) / d) + 1)
        j0 = max(0, int((bz0 - m - z0) / d)); j1 = min(h.shape[0], int((bz1 + m - z0) / d) + 1)
        if i1 <= i0 or j1 <= j0:
            continue
        shape = (j1 - j0, i1 - i0)
        wx0, wz0 = x0 + i0 * d, z0 + j0 * d
        T = Affine(d, 0, wx0 - d / 2, 0, d, wz0 - d / 2)
        ras = lambda g: features.rasterize([(g, 1)], out_shape=shape, transform=T, dtype=np.uint8, fill=0).astype(bool)
        zone, paved = ras(apt['zone']), ras(apt['paved'])
        sub = h[j0:j1, i0:i1]
        rw_mask = ras(unary_union(runway_polys(apt, 60.0)))
        tgt = target_surface(apt, wx0 + np.arange(shape[1]) * d, wz0 + np.arange(shape[0]) * d, sub, water[j0:j1, i0:i1],
                             rw_mask, paved)
        tgt = np.where(rw_mask, _spline_grid(apt['anchors'][:, :2], apt['anchors'][:, 2], wx0 + np.arange(shape[1]) * d,
                                             wz0 + np.arange(shape[0]) * d), tgt) if apt.get('mode') == 'fit' else tgt
        # blend width: 150 m, wider where the DEM is far from the platform (slope on the blend <= ~20 %)
        B = ndimage.gaussian_filter(np.clip(np.abs(tgt - sub) / 0.2, 150.0, 600.0), 20.0 / d * 4)
        full = paved | rw_mask            # pavement and the runway rectangles + 60 m shoulders / overruns: exact
        din = ndimage.distance_transform_edt(zone) * d
        dout = ndimage.distance_transform_edt(~full) * d
        w = np.maximum(smoothstep(0, B, din), 1 - smoothstep(0, B, dout)).astype(np.float32)
        w[full] = 1.0
        land = ~water[j0:j1, i0:i1]
        dz = np.abs(tgt - sub)[zone & land]
        h[j0:j1, i0:i1] = np.where(land, sub + (tgt - sub) * w, sub)
        log(f'flattened {apt["icao"]} ({apt.get("mode")}): paved {float(tgt[paved].min()):.1f}..{float(tgt[paved].max()):.1f} m, '
            f'DEM change in the zone median {float(np.median(dz)):.1f} m, p95 {float(np.percentile(dz, 95)):.1f} m')
        report.append(apt)
    grade_approaches(apts, h, water, x0, z0, d, log)
    write_json(apts)
    return h


GLIDE = np.tan(np.radians(3.0))
AIM = 300.0          # glide path aim point past the threshold (m)
MARGIN = 20.0        # graded ground stays this far below the glide path (>= 15 m asked + a little)


def _ends(apt):
    """Approach ends: (runway, ident, threshold xy, unit direction toward the other end, threshold elev, aim elev)."""
    out = []
    for r in apt['runways']:
        if r['a'][2] is None:
            continue
        A, B = np.array(r['a'][:2], float), np.array(r['b'][:2], float)
        L = float(np.hypot(*(B - A)))
        disp = r.get('disp', [0.0, 0.0])
        ids = r.get('ids') or ['?', '?']
        for k, (P, Q, dsp) in enumerate(((A, B, disp[0]), (B, A, disp[1]))):
            u = (Q - P) / L
            ev = lambda s, k=k: (r['a'][2] + (r['b'][2] - r['a'][2]) * (s / L if k == 0 else 1 - s / L))
            out.append((r, ids[k], P + u * dsp, u, ev(dsp), ev(min(dsp + AIM, L))))
    return out


def approach_clearance(apt, sample, dmax=5000.0, step=8.0, half=60.0):
    """Minimum (glide path - ground) per approach end over distance bands before the threshold, on the centreline and
    +-half m; ground from sample(x, z) (arrays). 0-60 m is the runway strip / overrun (at strip level the path is only
    ~15 m up there by construction)."""
    res = {}
    for r, ident, T, u, eT, eA in _ends(apt):
        n = np.array([-u[1], u[0]])
        D = np.arange(0.0, dmax + step, step)
        path = eA + (D + AIM) * GLIDE
        c = np.full(D.shape, np.inf)
        for o in (-half, -half / 2, 0.0, half / 2, half):
            P = T[None] - D[:, None] * u[None] + o * n[None]
            c = np.minimum(c, path - sample(P[:, 0], P[:, 1]))
        band = lambda lo, hi: round(float(np.min(c[(D >= lo) & (D <= hi)])), 1)
        res[ident] = {'thresholdElevation': round(eT, 2), 'aimElevation': round(eA, 2),
                      'clearance_0_60m': band(0, 60), 'clearance_60_300m': band(60, 300), 'clearance_300m_5km': band(300, dmax)}
    return res


def grade_approaches(apts, h, water, x0, z0, d, log=print):
    """Cut the ground under every approach down to the earthwork surface (module docstring); h is modified in place."""
    from rasterio import features
    from affine import Affine

    def smoothstep(e0, e1, x):
        t = np.clip((x - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)

    def grid_sample(xs, zs):
        fx = np.clip((xs - x0) / d, 0, h.shape[1] - 1.001)
        fz = np.clip((zs - z0) / d, 0, h.shape[0] - 1.001)
        ix, iz = np.floor(fx).astype(int), np.floor(fz).astype(int)
        tx, tz = fx - ix, fz - iz
        return ((h[iz, ix] * (1 - tx) + h[iz, ix + 1] * tx) * (1 - tz) + (h[iz + 1, ix] * (1 - tx) + h[iz + 1, ix + 1] * tx) * tz)
    DMAX, DFADE, SIDE = 5000.0, 600.0, 250.0
    for apt in apts:
        before = approach_clearance(apt, grid_sample)
        keep_geom = unary_union(runway_polys(apt, 60.0) + [apt['paved']])
        for r, ident, T, u, eT, eA in _ends(apt):
            n = np.array([-u[1], u[0]])
            far = DMAX + DFADE
            wmax = 150.0 + 0.15 * far + SIDE
            corners = [T - u * Dd + n * s * ww for Dd, ww in ((-60.0, 150.0 + SIDE), (far, wmax)) for s in (-1, 1)]
            cx, cz = zip(*corners)
            i0 = max(0, int((min(cx) - x0) / d)); i1 = min(h.shape[1], int((max(cx) - x0) / d) + 2)
            j0 = max(0, int((min(cz) - z0) / d)); j1 = min(h.shape[0], int((max(cz) - z0) / d) + 2)
            if i1 <= i0 or j1 <= j0:
                continue
            X, Z = np.meshgrid(x0 + np.arange(i0, i1) * d, z0 + np.arange(j0, j1) * d)
            D = -((X - T[0]) * u[0] + (Z - T[1]) * u[1])            # distance before the threshold
            lat = np.abs((X - T[0]) * n[0] + (Z - T[1]) * n[1])
            W = 150.0 + 0.15 * np.maximum(D, 0.0)
            w = (1 - smoothstep(W, W + SIDE, lat)) * (1 - smoothstep(DMAX, DMAX + DFADE, D)) * (D >= 0)
            cap = np.maximum(eA + (D + AIM) * GLIDE - MARGIN, eT + 0.02 * np.maximum(D - 60.0, 0.0))
            T_ = Affine(d, 0, x0 + i0 * d - d / 2, 0, d, z0 + j0 * d - d / 2)
            keep = features.rasterize([(keep_geom, 1)], out_shape=X.shape, transform=T_, dtype=np.uint8, fill=0).astype(bool)
            sub = h[j0:j1, i0:i1]
            cut = np.where(water[j0:j1, i0:i1] | keep, 0.0, w * np.maximum(sub - cap, 0.0))
            h[j0:j1, i0:i1] = (sub - cut).astype(np.float32)
            if cut.max() > 0.05:
                log(f'  approach {apt["icao"]} {ident}: ground cut up to {cut.max():.1f} m '
                    f'({(cut > 0.5).sum() * d * d / 1e4:.1f} ha more than 0.5 m)')
        after = approach_clearance(apt, grid_sample)
        for ident, v in after.items():
            v['clearance_300m_5km_beforeGrading'] = before[ident]['clearance_300m_5km']
        apt['approach'] = after
        log(f'approach clearance {apt["icao"]} (3° aimed {AIM:.0f} m past the threshold, +-60 m, 0-60 / 60-300 m / 0.3-5 km): ' +
            ', '.join(f'{k} {v["clearance_0_60m"]:.1f} / {v["clearance_60_300m"]:.1f} / {v["clearance_300m_5km"]:.1f} m '
                      f'(ungraded {v["clearance_300m_5km_beforeGrading"]:.1f})' for k, v in after.items()))


def write_json(apts):
    out = {'note': 'Elevations (m MSL, EGM2008 ~ MSL) the İstanbul terrain has at each runway end (terrain_airports.py): the '
                   'runway rectangle (+60 m) is flat at these values (linear between the ends if they differ). "published" = '
                   'the AIP end elevations in OurAirports, for reference (LTFM\'s real runways slope ~0.9 %). "approach" per '
                   'landing threshold: minimum height (m) of a 3° glide path aimed 300 m past the threshold above the graded '
                   'terrain within +-60 m of the extended centreline, 0-60 m (runway strip / overrun), 60-300 m and 0.3-5 km '
                   'before the threshold, and 0.3-5 km before the approach grading.',
           'source': 'data/ist/runways.json (airports pipeline) or OSM aeroways + OurAirports runways.csv',
           'airports': []}
    for a in apts:
        rws = []
        for r in a['runways']:
            if r['a'][2] is None:
                continue
            rws.append({'ref': r['ref'], 'ids': r.get('ids'), 'width': round(r['width'], 1),
                        'ends': [{'x': round(r['a'][0], 1), 'z': round(r['a'][1], 1), 'elevation': round(r['a'][2], 2)},
                                 {'x': round(r['b'][0], 1), 'z': round(r['b'][1], 1), 'elevation': round(r['b'][2], 2)}],
                        'published': r.get('published'), 'closedInOurAirports': r.get('closedInOurAirports'),
                        'approach': {k: v for k, v in (a.get('approach') or {}).items() if k in (r.get('ids') or [])}})
        els = [e['elevation'] for r in rws for e in r['ends']]
        out['airports'].append({'icao': a['icao'], 'name': a['name'], 'surface': a.get('mode'), 'source': a.get('source'),
                                'elevationMax': round(max(els), 2), 'elevationMin': round(min(els), 2), 'runways': rws})
    json.dump(out, open(OUT_JSON, 'w'), indent=1, ensure_ascii=False)


if __name__ == '__main__':
    if os.path.exists(PKL):
        os.remove(PKL)
    build()
