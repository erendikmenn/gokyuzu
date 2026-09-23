"""Build water polygons (local coords) from OSM: sea/bay (coastline polygonized) + lakes/reservoirs − piers.

Output: data/sf/cache/terrain/water.pkl = {'sea': MultiPolygon, 'lakes': [Polygon...], 'aerodromes': [Polygon...]}
Land/water of coastline faces is decided by the OSM convention (land on the left of the way direction).
Usage: .venv/bin/python tools/geo/terrain_water.py
"""
import os, json, pickle
import numpy as np
from shapely.geometry import LineString, Polygon, MultiPolygon, box, Point
from shapely.ops import linemerge, unary_union, polygonize
from shapely import prepared
from pyproj import Transformer
from terrain_common import RAW, CACHE, FAR, E0, N0

_fwd = Transformer.from_crs('EPSG:4326', 'EPSG:32610', always_xy=True)


def to_local(geom):
    lon = np.array([p['lon'] for p in geom])
    lat = np.array([p['lat'] for p in geom])
    e, n = _fwd.transform(lon, lat)
    return np.stack([e - E0, -(n - N0)], 1)


def ring_polys(members):
    """Assemble outer/inner rings of a multipolygon relation."""
    outers, inners = [], []
    for m in members:
        if m.get('type') != 'way' or 'geometry' not in m:
            continue
        ls = LineString(to_local(m['geometry']))
        (inners if m.get('role') == 'inner' else outers).append(ls)
    polys = []
    for group, sign in ((outers, 1), (inners, -1)):
        merged = linemerge(group) if group else None
        rings = []
        if merged is not None and not merged.is_empty:
            for g in getattr(merged, 'geoms', [merged]):
                if g.is_ring and len(g.coords) >= 4:
                    rings.append(Polygon(g.coords))
        polys.append(unary_union(rings) if rings else Polygon())
    out = polys[0].buffer(0)
    if not polys[1].is_empty:
        out = out.difference(polys[1].buffer(0))
    return out


def main():
    os.makedirs(CACHE, exist_ok=True)
    coast = json.load(open(os.path.join(RAW, 'osm_w1', 'coastline.json')))['elements']
    lines = [LineString(to_local(w['geometry'])) for w in coast if w['type'] == 'way' and len(w.get('geometry', [])) >= 2]
    print('coastline ways', len(lines))
    pad = 3000
    frame = box(FAR['x0'] - pad, FAR['z0'] - pad, FAR['x1'] + pad, FAR['z1'] + pad)
    merged = linemerge(lines)
    merged = list(getattr(merged, 'geoms', [merged]))
    print('merged lines', len(merged))
    # land-side / water-side probe points (land is left of the way direction in lon/lat; local z = -north flips it)
    land_pts, water_pts = [], []
    for ln in merged:
        c = np.asarray(ln.coords)
        d = c[1:] - c[:-1]
        L = np.hypot(d[:, 0], d[:, 1])
        ok = L > 2.0
        mid = (c[1:] + c[:-1]) / 2
        # left normal in (east, north) = (-dn, de); in local (x, z=-n): (dz, -dx)
        nrm = np.stack([d[:, 1], -d[:, 0]], 1) / np.maximum(L, 1e-9)[:, None]
        eps = np.minimum(0.4, L * 0.1)[:, None]
        land_pts.append((mid + nrm * eps)[ok][::3])
        water_pts.append((mid - nrm * eps)[ok][::3])
    land_pts = np.concatenate(land_pts)
    water_pts = np.concatenate(water_pts)
    clipped = [g.intersection(frame) for g in merged]
    noded = unary_union([g for g in clipped if not g.is_empty] + [frame.boundary])
    faces = list(polygonize(noded))
    print('faces', len(faces))
    import shapely
    water_faces = []
    for f in faces:
        pf = prepared.prep(f)
        minx, minz, maxx, maxz = f.bounds
        def count(pts):
            sel = pts[(pts[:, 0] >= minx) & (pts[:, 0] <= maxx) & (pts[:, 1] >= minz) & (pts[:, 1] <= maxz)]
            if len(sel) == 0:
                return 0
            return int(shapely.contains_xy(f, sel[:, 0], sel[:, 1]).sum())
        nl, nw = count(land_pts), count(water_pts)
        if nw > nl:
            water_faces.append(f)
        elif nw == nl == 0:
            # no coastline edge inside: decide by touching the outer frame on the ocean side (west) and size
            c = f.representative_point()
            if c.x < -20000 and f.area > 1e8:
                water_faces.append(f)
    sea = unary_union(water_faces)
    print('sea area km2', sea.area / 1e6)

    wat = json.load(open(os.path.join(RAW, 'osm_w1', 'water.json')))['elements']
    lakes, piers, aerodromes = [], [], []
    skip_water = {'salt_pool', 'salt_pond', 'wastewater', 'basin', 'reflecting_pool', 'fountain', 'pool', 'swimming_pool'}
    for e in wat:
        t = e.get('tags', {})
        if e['type'] == 'way':
            g = e.get('geometry')
            if not g or len(g) < 4 or (g[0]['lat'], g[0]['lon']) != (g[-1]['lat'], g[-1]['lon']):
                continue
            poly = Polygon(to_local(g)).buffer(0)
        elif e['type'] == 'relation':
            poly = ring_polys(e.get('members', []))
        else:
            continue
        if poly.is_empty:
            continue
        if t.get('man_made') in ('pier', 'breakwater', 'groyne'):
            piers.append(poly)
        elif t.get('aeroway') == 'aerodrome':
            aerodromes.append(poly)
        else:
            if t.get('water') in skip_water or t.get('landuse') == 'salt_pond' or t.get('intermittent') == 'yes':
                continue
            if poly.area < 1500:
                continue
            lakes.append(poly)
    pier_u = unary_union(piers) if piers else Polygon()
    sea = sea.difference(pier_u)
    # lakes that are just parts of the sea (tidal lagoons mapped as water) stay lakes; remove overlap with sea
    lakes_u = unary_union(lakes).difference(sea).difference(pier_u) if lakes else Polygon()
    lake_list = [g for g in getattr(lakes_u, 'geoms', [lakes_u]) if not g.is_empty and g.area > 1500]
    print('lakes', len(lake_list), 'piers', len(piers), 'aerodromes', len(aerodromes))
    pickle.dump({'sea': sea, 'lakes': lake_list, 'piers': pier_u, 'aerodromes': aerodromes},
                open(os.path.join(CACHE, 'water.pkl'), 'wb'))
    print('saved water.pkl')


if __name__ == '__main__':
    main()
