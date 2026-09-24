"""OSM helpers for the airport pipeline: raw Overpass JSON (out geom) -> shapely geometry in local coordinates."""
import json, os
import numpy as np
from shapely.geometry import Polygon, LineString, Point, MultiPolygon
from shapely.ops import unary_union, linemerge, polygonize
from geo import lonlat_to_local, _fwd, E0, N0
from airports_lib import ROOT, RAW_OSM


def local_pts(geom):
    lon = np.array([g['lon'] for g in geom if g])
    lat = np.array([g['lat'] for g in geom if g])
    e, n = _fwd.transform(lon, lat)
    return list(zip((e - E0).tolist(), (-(n - N0)).tolist()))


def load(name):
    return json.load(open(os.path.join(RAW_OSM, f'airports_{name}.json')))['elements']


def ways(elements, pred):
    for e in elements:
        if e['type'] == 'way' and 'geometry' in e and pred(e.get('tags', {})):
            yield e


def way_polygon(e):
    p = local_pts(e['geometry'])
    if len(p) < 4 or p[0] != p[-1]:
        if len(p) >= 3:
            p = p + [p[0]]
        else:
            return None
    poly = Polygon(p)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly if not poly.is_empty else None


def relation_polygon(e):
    outers, inners = [], []
    for m in e.get('members', []):
        if m.get('type') != 'way' or not m.get('geometry'):
            continue
        ls = LineString(local_pts(m['geometry'])) if len([g for g in m['geometry'] if g]) >= 2 else None
        if ls is None:
            continue
        (outers if m.get('role') != 'inner' else inners).append(ls)
    def assemble(lines):
        if not lines:
            return None
        merged = linemerge(lines)
        polys = list(polygonize(merged))
        return unary_union(polys) if polys else None
    o = assemble(outers)
    if o is None or o.is_empty:
        return None
    i = assemble(inners)
    if i is not None and not i.is_empty:
        o = o.difference(i)
    return o.buffer(0)


def polygons(elements, pred):
    """Yield (geometry, tags, id, type) for closed ways and multipolygon relations matching pred(tags)."""
    for e in elements:
        t = e.get('tags', {})
        if not pred(t):
            continue
        if e['type'] == 'way' and 'geometry' in e:
            g = way_polygon(e)
        elif e['type'] == 'relation':
            g = relation_polygon(e)
        else:
            continue
        if g is not None and not g.is_empty and g.area > 1:
            yield g, t, e['id'], e['type']


def lines(elements, pred):
    for e in ways(elements, pred):
        p = local_pts(e['geometry'])
        if len(p) >= 2:
            yield LineString(p), e.get('tags', {}), e['id']


def nodes(elements, pred):
    for e in elements:
        if e['type'] == 'node' and pred(e.get('tags', {})):
            x, z = lonlat_to_local(e['lon'], e['lat'])
            yield (x, z), e.get('tags', {}), e['id']
