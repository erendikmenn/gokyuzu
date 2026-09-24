"""Land-cover classes from the OSM landuse / natural / leisure polygons (terrain_osm.py landcover.json), GEO_REGION=ist.

Used for (1) the DSM clean-up (terrain_dsm.py: where buildings / tree canopy sit on the Copernicus surface model) and
(2) the ground class map for a close-range detail branch in the terrain shader (not used by the current engine; see
landclass.json next to it). Polygons are painted largest first, so smaller, more specific ones (a park inside a
residential area, a pitch inside a school) win.

Classes (u8):  0 unmapped, 1 residential, 2 commercial / civic, 3 industrial / transport, 4 farmland, 5 orchard / vineyard,
               6 grass / meadow, 7 forest, 8 scrub / heath, 9 park / cemetery / golf, 10 sports / paved open,
               11 sand / beach, 12 bare rock / quarry / landfill, 13 wetland
Outputs: <cache>/landcover.pkl (class -> polygons), <assets>/terrain/landclass.png + landclass.json (16 m over the core,
         paletted PNG; written by terrain_build.py via write_class_map()).
"""
import os, json, pickle
import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.ops import linemerge, unary_union
from terrain_common import RAW, CACHE, OUT, CORE
from geo import lonlat_to_local

NAMES = ['unmapped', 'residential', 'commercial', 'industrial', 'farmland', 'orchard', 'grass', 'forest', 'scrub', 'park',
         'sports', 'sand', 'bare', 'wetland']
LANDUSE = {'residential': 1, 'commercial': 2, 'retail': 2, 'institutional': 2, 'education': 2, 'religious': 2,
           'industrial': 3, 'port': 3, 'railway': 3, 'garages': 3, 'brownfield': 3, 'construction': 3, 'military': 3,
           'farmland': 4, 'farmyard': 4, 'greenhouse_horticulture': 4, 'plant_nursery': 4, 'allotments': 4,
           'orchard': 5, 'vineyard': 5,
           'meadow': 6, 'grass': 6, 'greenfield': 6, 'village_green': 6, 'recreation_ground': 6,
           'forest': 7, 'cemetery': 9, 'quarry': 12, 'landfill': 12}
NATURAL = {'wood': 7, 'scrub': 8, 'heath': 8, 'grassland': 6, 'beach': 11, 'sand': 11, 'shingle': 11, 'bare_rock': 12,
           'scree': 12, 'wetland': 13}
LEISURE = {'park': 9, 'garden': 9, 'golf_course': 9, 'nature_reserve': 0, 'pitch': 10, 'stadium': 10, 'track': 10}
AMENITY = {'university': 2, 'school': 2, 'hospital': 2, 'parking': 10, 'grave_yard': 9}
PALETTE = [(0, 0, 0), (200, 120, 100), (210, 90, 160), (150, 150, 170), (230, 210, 120), (190, 200, 90), (150, 210, 110),
           (40, 110, 50), (110, 150, 80), (90, 190, 140), (240, 240, 240), (250, 235, 180), (170, 160, 150), (80, 160, 200)]


def _poly(e):
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
        return unary_union([Polygon(g.coords).buffer(0) for g in getattr(mg, 'geoms', [mg]) if g.is_ring and len(g.coords) >= 4])
    p = rings(outers)
    if inners and not p.is_empty:
        p = p.difference(rings(inners))
    return p if not p.is_empty else None


def classify(t):
    for key, table in (('leisure', LEISURE), ('natural', NATURAL), ('landuse', LANDUSE), ('amenity', AMENITY)):
        v = t.get(key)
        if v in table and table[v]:
            return table[v]
    return None


def load():
    """[(area, class, polygon)] sorted largest first (cached)."""
    pkl = os.path.join(CACHE, 'landcover.pkl')
    if os.path.exists(pkl):
        return pickle.load(open(pkl, 'rb'))
    els = json.load(open(os.path.join(RAW, 'osm_w1', 'landcover.json')))['elements']
    out = []
    for e in els:
        c = classify(e.get('tags', {}))
        if c is None:
            continue
        p = _poly(e)
        if p is None or p.area < 200:
            continue
        out.append((p.area, c, p))
    out.sort(key=lambda r: -r[0])
    os.makedirs(CACHE, exist_ok=True)
    pickle.dump(out, open(pkl, 'wb'))
    print('landcover polygons', len(out))
    return out


def rasterize(x0, z0, d, shape, polys=None):
    """Class raster, sample centres at (x0 + i*d, z0 + j*d)."""
    from rasterio import features
    from affine import Affine
    polys = load() if polys is None else polys
    T = Affine(d, 0, x0 - d / 2, 0, d, z0 - d / 2)
    W, H = shape[1], shape[0]
    bb = (x0 - d, z0 - d, x0 + W * d, z0 + H * d)
    shapes = [(p, c) for _, c, p in polys if p.bounds[2] > bb[0] and p.bounds[0] < bb[2] and p.bounds[3] > bb[1] and p.bounds[1] < bb[3]]
    if not shapes:
        return np.zeros(shape, np.uint8)
    # rasterio paints in order: later shapes overwrite earlier ones (largest first -> the specific ones win)
    return features.rasterize(shapes, out_shape=shape, transform=T, dtype=np.uint8, fill=0)


def write_class_map(water_mask_fn=None, res=16.0):
    """landclass.png (paletted, 16 m over the core, texel (i, j) covers [x0 + i*res, +res], row 0 = north) + .json."""
    from PIL import Image
    W, H = int((CORE['x1'] - CORE['x0']) / res), int((CORE['z1'] - CORE['z0']) / res)
    cls = rasterize(CORE['x0'] + res / 2, CORE['z0'] + res / 2, res, (H, W))
    if water_mask_fn is not None:
        cls[water_mask_fn(CORE['x0'], CORE['z0'], res, (H, W))] = 255
    img = Image.fromarray(cls, 'P')
    pal = [v for c in PALETTE for v in c] + [0] * (3 * (255 - len(PALETTE))) + [20, 60, 120]
    img.putpalette(pal)
    img.save(os.path.join(OUT, 'landclass.png'), optimize=True)
    json.dump({'x0': CORE['x0'], 'z0': CORE['z0'], 'res': res, 'width': W, 'height': H,
               'encoding': 'paletted PNG, value = class id (255 = water), texel (i, j) covers [x0 + i*res, +res] x [z0 + j*res, +res], row 0 = north',
               'classes': {str(k): n for k, n in enumerate(NAMES)}, 'source': 'OpenStreetMap landuse / natural / leisure'},
              open(os.path.join(OUT, 'landclass.json'), 'w'), indent=1)
    counts = np.bincount(cls.ravel(), minlength=256)
    print('landclass.png', W, H, {NAMES[k] if k < len(NAMES) else k: round(counts[k] / cls.size, 3) for k in np.nonzero(counts)[0]})


if __name__ == '__main__':
    import pickle
    from rasterio import features
    from affine import Affine
    w = pickle.load(open(os.path.join(CACHE, 'water_final.pkl'), 'rb'))

    def water(x0, z0, d, shape):
        T = Affine(d, 0, x0, 0, d, z0)
        return features.rasterize([(w['sea'], 1)] + [(g, 1) for g in w['lakes']], out_shape=shape, transform=T,
                                  dtype=np.uint8, fill=0).astype(bool)
    write_class_map(water)
