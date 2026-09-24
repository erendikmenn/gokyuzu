"""Build water polygons (local coords) from OSM: sea/bay + lakes/reservoirs − piers.

Output: <cache>/water.pkl = {'sea': MultiPolygon, 'lakes': [Polygon...], 'piers': Polygon, 'aerodromes': [Polygon...]}
sf : the sea is the coastline (Overpass, terrain_osm.py) polygonized; land/water of the faces is decided by the OSM
     convention (land on the left of the way direction).
ist: the sea is the quadtree root minus the OSM land polygons (osmdata.openstreetmap.de land-polygons-split-4326, the
     coastline already assembled into polygons; downloaded once into data/ist/_cache/raw/osm/): Marmara, Boğaz, Haliç,
     Karadeniz. Lakes / reservoirs (Küçükçekmece, Büyükçekmece, Terkos, Ömerli, Elmalı, Alibeyköy, Sazlıdere, …) from
     Overpass as for sf.
Usage: .venv/bin/python tools/geo/terrain_water.py
"""
import os, json, pickle
import numpy as np
from shapely.geometry import LineString, Polygon, MultiPolygon, box, Point
from shapely.ops import linemerge, unary_union, polygonize
from shapely import prepared
from pyproj import Transformer
from terrain_common import RAW, CACHE, FAR, E0, N0, CRS, REGION_ID, USER_AGENT

_fwd = Transformer.from_crs('EPSG:4326', CRS, always_xy=True)


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


def sea_from_coastline():
    """sf: coastline ways polygonized inside the root (+3 km), faces classified by the land-left convention."""
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
    return sea


def read_shp_polygons(shp, bbox):
    """Minimal ESRI shapefile reader (polygon records whose bbox intersects bbox = (xmin, ymin, xmax, ymax)).
    Returns a list of shapely Polygons in the file's coordinates; ring orientation decides outer (clockwise) / hole."""
    import struct
    from shapely.geometry import LinearRing
    shx = open(shp[:-4] + '.shx', 'rb').read()
    n = (len(shx) - 100) // 8
    idx = np.frombuffer(shx, '>i4', count=2 * n, offset=100).reshape(n, 2)
    out = []
    with open(shp, 'rb') as f:
        for off, ln in idx:
            f.seek(int(off) * 2 + 8)
            rec = f.read(int(ln) * 2)
            st, x0, y0, x1, y1 = struct.unpack_from('<i4d', rec, 0)
            if st != 5 or x1 < bbox[0] or x0 > bbox[2] or y1 < bbox[1] or y0 > bbox[3]:
                continue
            nparts, npts = struct.unpack_from('<2i', rec, 36)
            parts = list(np.frombuffer(rec, '<i4', count=nparts, offset=44)) + [npts]
            pts = np.frombuffer(rec, '<f8', count=2 * npts, offset=44 + 4 * nparts).reshape(npts, 2)
            shells, holes = [], []
            for k in range(nparts):
                ring = pts[parts[k]:parts[k + 1]]
                if len(ring) < 4:
                    continue
                (holes if LinearRing(ring).is_ccw else shells).append(ring)
            for s in shells:
                p = Polygon(s)
                inner = [h for h in holes if p.contains(Polygon(h).representative_point())]
                out.append(Polygon(s, inner) if inner else p)
    return out


def sea_from_land_polygons():
    """ist: the root (+3 km) minus the OSM land polygons (downloaded once, ~930 MB zip, extracted next to it)."""
    import zipfile
    from shapely.ops import transform
    from geo import local_to_lonlat
    d = os.path.join(RAW, 'osm')
    zpath = os.path.join(d, 'land-polygons-split-4326.zip')
    shp = os.path.join(d, 'land-polygons-split-4326', 'land_polygons.shp')
    if not os.path.exists(shp):
        if not os.path.exists(zpath):
            import requests
            os.makedirs(d, exist_ok=True)
            with requests.get('https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip', stream=True,
                              headers={'User-Agent': USER_AGENT}, timeout=600) as r:
                r.raise_for_status()
                with open(zpath + '.part', 'wb') as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            os.replace(zpath + '.part', zpath)
        zipfile.ZipFile(zpath).extractall(d)
    pad = 3000
    frame = box(FAR['x0'] - pad, FAR['z0'] - pad, FAR['x1'] + pad, FAR['z1'] + pad)
    corners = [local_to_lonlat(x, z) for x in (frame.bounds[0], frame.bounds[2]) for z in (frame.bounds[1], frame.bounds[3])]
    lons, lats = zip(*corners)
    ll = read_shp_polygons(shp, (min(lons) - 0.05, min(lats) - 0.05, max(lons) + 0.05, max(lats) + 0.05))
    print('land polygons', len(ll))

    def to_loc(x, y, z=None):
        e, n = _fwd.transform(np.asarray(x), np.asarray(y))
        return e - E0, -(n - N0)
    land = unary_union([transform(to_loc, p).buffer(0) for p in ll]).intersection(frame)
    sea = frame.difference(land)
    print('sea area km2', sea.area / 1e6, 'land area km2', land.area / 1e6)
    return sea


RIVERS = {'river', 'canal', 'stream', 'ditch', 'drain', 'rapids', 'lock', 'moat', 'fish_pass', 'stream_pool'}


def main():
    os.makedirs(CACHE, exist_ok=True)
    sea = sea_from_coastline() if REGION_ID == 'sf' else sea_from_land_polygons()

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
            if REGION_ID != 'sf' and (t.get('water') in RIVERS or t.get('waterway') == 'riverbank'):
                continue   # sloping river beds stay land (the photo shows them): one level per polygon would cut trenches
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
