"""W2 city: merge DataSF LiDAR footprints + OSM buildings, classify, and write per-tile building records for Blender.

  .venv/bin/python tools/geo/city_prep.py [--only i,j]        (after city_fetch.py, city_osm.py, facade_atlas + city_atlas)

Pipeline
  1. DataSF footprints (SF, 177k) with LiDAR height stats; OSM buildings everywhere else (and OSM tags/heights inside SF:
     post-2010 towers, building types, building:part setbacks for downtown towers).
  2. Exclusions: landmarks.json excludeRadius circles, KSFO/KOAK aerodrome polygons, Alameda Point land polygon.
  3. Classification: facade style / ground-floor style / roof style + tints from neighborhood (DataSF analysis
     neighborhoods), OSM landuse, building type, height and footprint area; roof shape from LiDAR statistics.
  4. Party walls (edges shared with neighbours are only built above the neighbour's roof) and street-facing edges
     (OSM roads) for storefronts / garage fronts.
  5. Output (data/sf/cache/city/tiles/L1_<i>_<j>.json, 1 km tiles; the Blender builder makes LOD0 (500 m) + LOD1 from
     them) + far LOD merged blocks per 2 km tile (L2_<i>_<j>.json) + obstacle rasters (assets/sf/city/obst/*.bin.gz).
"""
import gzip, hashlib, json, math, os, struct, sys, time
from collections import defaultdict, Counter

import numpy as np
import shapely
import shapely.affinity
from shapely.geometry import Polygon, MultiPolygon, Point, LineString, box as sbox
from shapely.ops import unary_union
from shapely import STRtree
from pyproj import Transformer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import E0, N0, ROOT  # noqa: E402

CACHE = os.path.join(ROOT, 'data', 'sf', 'cache', 'city')
TILES = os.path.join(CACHE, 'tiles')
OBST = os.path.join(ROOT, 'assets', 'sf', 'city', 'obst')
ATLAS = json.load(open(os.path.join(ROOT, 'assets', 'sf', 'city', 'atlas', 'atlas.json')))
LAYER = {l['name']: l['index'] for l in ATLAS['layers']}
CELLS = {l['name']: l for l in ATLAS['layers']}
T1 = 1000.0       # LOD1 tile size (LOD0 = T1 / 2, LOD2 = 2 * T1)
OBST_CELL = 4.0
_fwd = Transformer.from_crs('EPSG:4326', 'EPSG:32610', always_xy=True)


def proj(coords):
    a = np.asarray(coords, dtype=np.float64)
    e, n = _fwd.transform(a[:, 0], a[:, 1])
    return np.stack([e - E0, -(n - N0)], 1)


def h32(s):
    return int(hashlib.md5(str(s).encode()).hexdigest()[:8], 16)


def rnd01(key, salt=''):
    return (h32(f'{key}|{salt}') % 100000) / 100000.0


def parse_len(v):
    if v is None:
        return None
    s = str(v).strip().lower().replace(',', '.')
    try:
        if s.endswith('ft') or s.endswith("'"):
            return float(s.rstrip("ft' ").strip()) * 0.3048
        return float(s.split()[0].rstrip('m'))
    except (ValueError, IndexError):
        return None


# ------------------------------------------------------------------------------------------------------------ inputs
def load_datasf():
    rows = []
    d = os.path.join(ROOT, 'data', 'sf', 'raw', 'datasf')
    for f in sorted(os.listdir(d)):
        if f.startswith('buildings_'):
            rows += json.load(open(os.path.join(d, f)))
    out = []
    for r in rows:
        f = lambda k, dflt=0.0: float(r[k]) if k in r and r[k] not in (None, '') else dflt
        attrs = dict(src='sf', id=r.get('sf16_bldgid'), H=f('hgt_median_m'), Hmax=f('hgt_maxcm') / 100.0,
                     Hmean=f('hgt_meancm') / 100.0, Hstd=f('hgt_stdcm') / 100.0, gnd=f('gnd_meancm') / 100.0,
                     Hmaj=f('hgt_majoritycm') / 100.0, tags={})
        for k, poly in enumerate(r['shape']['coordinates']):
            try:
                rings = [proj(ring) for ring in poly]
                p = Polygon(rings[0], [x for x in rings[1:] if len(x) >= 4])
            except Exception:
                continue
            if not p.is_valid:
                p = p.buffer(0)
            for q in (p.geoms if isinstance(p, MultiPolygon) else [p]):
                if q.area >= 6:
                    out.append(dict(attrs, poly=q, id=f"{attrs['id']}_{k}"))
    return out


def load_osm():
    raw = json.load(open(os.path.join(CACHE, 'osm_buildings.json')))
    out = []
    for b in raw:
        t = b['tags']
        for k, r in enumerate(b['rings']):
            try:
                outer = proj(r['outer'])
                p = Polygon(outer, [proj(x) for x in r['inner'] if len(x) >= 4])
            except Exception:
                continue
            if not p.is_valid:
                p = p.buffer(0)
            for q in (p.geoms if isinstance(p, MultiPolygon) else [p]):
                if q.area >= 6:
                    out.append(dict(src='osm', id=f"{b['id']}_{k}", poly=q, tags=t, part='building:part' in t and 'building' not in t))
    return out


def load_exclusions():
    ex = []
    lm = json.load(open(os.path.join(ROOT, 'data', 'sf', 'landmarks.json')))
    for l in lm['landmarks']:
        if l.get('excludeRadius', 0) > 0:
            ex.append(Point(l['x'], l['z']).buffer(l['excludeRadius'], 24))
    for e in json.load(open(os.path.join(ROOT, 'data', 'sf', 'osm_aeroways_raw.json'))):
        if e.get('tags', {}).get('aeroway') == 'aerodrome' and e.get('geometry'):
            ex.append(Polygon(proj([(g['lon'], g['lat']) for g in e['geometry']])).buffer(0))
    al = json.load(open(os.path.join(ROOT, 'data', 'sf', 'alameda_land_local.json')))
    ex.append(Polygon(al['coordsLocal']).buffer(0))
    return ex


W3_BUILDING_LANDMARKS = {'painted_ladies', 'pier_39', 'fort_point', 'city_hall', 'palace_of_fine_arts', 'oracle_park',
                         'chase_center', 'ferry_building', 'alcatraz', 'coit_tower', 'transamerica', 'salesforce'}


def load_landmark_bounds():
    """W3 publishes assets/sf/landmarks/index.json with origin, heading and model bounds. Generic buildings whose
    centroid falls inside a building-type landmark's (rotated) bounds would duplicate the landmark -> excluded too."""
    path = os.path.join(ROOT, 'assets', 'sf', 'landmarks', 'index.json')
    out = []
    if not os.path.exists(path):
        return out
    for l in json.load(open(path)).get('landmarks', []):
        if l.get('id') not in W3_BUILDING_LANDMARKS or 'bounds' not in l:
            continue
        (x0, _, z0), (x1, _, z1) = l['bounds']['min'], l['bounds']['max']
        h = l.get('heading', 0.0)
        ch, sh = math.cos(h), math.sin(h)
        ox, oz = l['origin']['x'], l['origin']['z']
        pts = [(ox + lx * ch - lz * sh, oz + lx * sh + lz * ch) for lx, lz in ((x0, z0), (x1, z0), (x1, z1), (x0, z1))]
        out.append(Polygon(pts).buffer(3.0))
    return out


def load_airport_exclusions():
    """W4 (airports) publishes assets/sf/airports/exclusions.json: OSM ids it models itself + zones (centroid test)."""
    path = os.path.join(ROOT, 'assets', 'sf', 'airports', 'exclusions.json')
    ids, zones = set(), []
    if os.path.exists(path):
        js = json.load(open(path))
        for apt in js.get('airports', {}).values():
            ids.update(apt.get('osmIds', []))
            for z in apt.get('zones', []):
                if len(z) >= 3:
                    zones.append(Polygon(z).buffer(0))
    return ids, zones


def load_neighborhoods():
    js = json.load(open(os.path.join(ROOT, 'data', 'sf', 'raw', 'datasf', 'neighborhoods.geojson')))
    polys, names = [], []
    for f in js['features']:
        g = f['geometry']
        parts = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        for part in parts:
            polys.append(Polygon(proj(part[0])).buffer(0))
            names.append(f['properties']['nhood'])
    return polys, names


def load_landuse():
    raw = json.load(open(os.path.join(CACHE, 'osm_landcover.json')))
    polys, kinds = [], []
    for b in raw:
        t = b['tags']
        k = t.get('landuse')
        if k not in ('industrial', 'commercial', 'retail', 'residential', 'railway', 'port', 'military', 'construction'):
            continue
        for r in b['rings']:
            try:
                p = Polygon(proj(r['outer']), [proj(x) for x in r['inner'] if len(x) >= 4]).buffer(0)
            except Exception:
                continue
            if p.area > 100:
                polys.append(p)
                kinds.append(k)
    return polys, kinds


def load_roads():
    raw = json.load(open(os.path.join(CACHE, 'osm_roads.json')))
    lines, kinds = [], []
    for r in raw:
        if not r.get('highway') or r['highway'] == 'service':
            continue
        pts = proj(r['pts'])
        if len(pts) >= 2:
            lines.append(LineString(pts))
            kinds.append(r['highway'])
    return lines, kinds


# ------------------------------------------------------------------------------------------------------------- zones
VICTORIAN_NH = {'Western Addition', 'Haight Ashbury', 'Mission', 'Noe Valley', 'Castro/Upper Market', 'Bernal Heights',
                'Hayes Valley', 'Pacific Heights', 'Lone Mountain/USF', 'Potrero Hill', 'Glen Park', 'Inner Sunset',
                'Japantown', 'Presidio Heights', 'Twin Peaks'}
AVENUES_NH = {'Sunset/Parkside', 'Outer Richmond', 'Inner Richmond', 'Lakeshore', 'West of Twin Peaks', 'Excelsior',
              'Outer Mission', 'Oceanview/Merced/Ingleside', 'Portola', 'Visitacion Valley', 'Bayview Hunters Point',
              'Seacliff', 'McLaren Park', 'Lincoln Park', 'Golden Gate Park'}
APARTMENT_NH = {'Marina', 'Russian Hill', 'Nob Hill', 'North Beach', 'Chinatown', 'Tenderloin'}
DOWNTOWN_NH = {'Financial District/South Beach'}
SOMA_NH = {'South of Market', 'Mission Bay'}


def region_of(x, z, nh):
    if nh:
        return 'sf'
    if x > 2500:
        return 'eastbay'
    if z < -22500:
        return 'marin'
    return 'peninsula'


OAKLAND_DT = (9250.0, -20500.0)


def pal(*cols):
    return [tuple(c) for c in cols]


PAL = {
    'victorian': pal((0.95, 0.88, 0.70), (0.66, 0.80, 0.86), (0.78, 0.86, 0.72), (0.97, 0.85, 0.58), (0.90, 0.66, 0.60),
                     (0.74, 0.70, 0.86), (1, 1, 1), (0.62, 0.72, 0.62), (0.50, 0.60, 0.76), (0.86, 0.52, 0.42),
                     (0.96, 0.90, 0.80), (0.42, 0.52, 0.46), (0.98, 0.95, 0.88), (0.82, 0.62, 0.72), (0.60, 0.70, 0.62)),
    'edwardian': pal((0.95, 0.92, 0.85), (0.80, 0.84, 0.86), (0.88, 0.84, 0.74), (0.75, 0.80, 0.74), (1, 1, 1),
                     (0.90, 0.80, 0.70), (0.70, 0.74, 0.78), (0.86, 0.78, 0.66)),
    'sunset': pal((1, 1, 1), (0.99, 0.95, 0.86), (0.98, 0.90, 0.90), (0.88, 0.94, 0.98), (0.90, 0.97, 0.90),
                  (1.0, 0.95, 0.78), (0.96, 0.92, 0.86), (0.90, 0.90, 0.90), (0.94, 0.88, 0.80), (0.86, 0.90, 0.95)),
    'stucco': pal((1, 1, 1), (0.98, 0.95, 0.88), (0.95, 0.92, 0.86), (0.92, 0.92, 0.92), (0.98, 0.94, 0.80),
                  (0.96, 0.90, 0.88), (0.88, 0.86, 0.82), (0.93, 0.90, 0.84)),
    'house': pal((1, 1, 1), (0.85, 0.86, 0.86), (0.93, 0.88, 0.78), (0.78, 0.85, 0.92), (0.98, 0.92, 0.70),
                 (0.76, 0.82, 0.72), (0.72, 0.66, 0.58), (0.60, 0.56, 0.52), (0.92, 0.90, 0.84), (0.70, 0.76, 0.80)),
    'industrial': pal((0.95, 0.95, 0.94), (0.90, 0.87, 0.80), (0.72, 0.78, 0.84), (0.84, 0.84, 0.84), (0.93, 0.88, 0.76),
                      (0.70, 0.72, 0.70), (0.78, 0.70, 0.62), (0.60, 0.66, 0.74)),
    'modern': pal((1, 1, 1), (0.88, 0.88, 0.88), (0.75, 0.76, 0.78), (0.94, 0.92, 0.86), (0.82, 0.80, 0.76), (0.68, 0.70, 0.72)),
    'neutral': pal((1, 1, 1), (0.95, 0.95, 0.94), (0.92, 0.93, 0.95), (0.97, 0.95, 0.92), (0.9, 0.9, 0.9)),
    'roof_shingle': pal((0.42, 0.42, 0.43), (0.33, 0.33, 0.35), (0.52, 0.46, 0.40), (0.60, 0.60, 0.60), (0.48, 0.38, 0.34),
                        (0.40, 0.44, 0.42), (0.28, 0.28, 0.30), (0.55, 0.50, 0.46)),
    'roof_tile': pal((1, 1, 1), (0.92, 0.85, 0.80), (1.0, 0.9, 0.78), (0.85, 0.72, 0.66)),
    'roof_flat': pal((1, 1, 1), (0.9, 0.9, 0.9), (0.8, 0.8, 0.8), (1.0, 0.96, 0.9), (0.85, 0.87, 0.9), (0.72, 0.72, 0.72),
                     (0.95, 0.9, 0.82)),
    'roof_metal': pal((1, 1, 1), (0.85, 0.85, 0.85), (0.75, 0.82, 0.88), (0.9, 0.85, 0.78), (0.7, 0.7, 0.72)),
}


def choose(key, options):
    """Deterministic weighted choice: options = [(value, weight), ...]."""
    tot = sum(w for _, w in options)
    r = rnd01(key, 'c') * tot
    for v, w in options:
        r -= w
        if r <= 0:
            return v
    return options[-1][0]


def tint_of(key, palette, jitter=0.04):
    p = PAL[palette]
    c = p[h32(f'{key}|t') % len(p)]
    j = (rnd01(key, 'j') - 0.5) * 2 * jitter
    return tuple(max(0.0, min(1.0, x * (1 + j))) for x in c)


def classify(b):
    """Sets b['style'], ['ground'], ['roofstyle'], ['tint'], ['rtint'], ['par'], ['rear'], ['side']."""
    key = b['id']
    H, A = b['H'], b['area']
    nh, reg, lu, t = b.get('nh'), b['region'], b.get('lu'), b['tags']
    bt = t.get('building', 'yes')
    x, z = b['cx'], b['cz']
    oak_dt = reg == 'eastbay' and math.hypot(x - OAKLAND_DT[0], z - OAKLAND_DT[1]) < 1300
    industrial = lu in ('industrial', 'port', 'railway') or bt in ('industrial', 'warehouse', 'hangar', 'manufacture', 'storage_tank', 'service')
    commercial = lu in ('commercial', 'retail') or bt in ('commercial', 'retail', 'office', 'supermarket', 'hotel', 'mixed_use')
    house_like = A < 380 and H < 13.5 and not industrial and bt not in ('commercial', 'retail', 'office', 'school', 'church')
    ground, rear, side = -1, None, 'blank_stucco'
    par = 0.0
    if bt in ('garage', 'garages', 'shed', 'carport', 'roof', 'hut') or (A < 30 and H < 4):
        style, pal_, par = 'blank_stucco', 'neutral', 0.0
    elif bt in ('parking',) or t.get('amenity') == 'parking':
        style, pal_, par = 'parking', 'neutral', 1.1
    elif H >= 38:
        if nh in APARTMENT_NH or (nh in SOMA_NH and rnd01(key, 's') < 0.45) or bt in ('apartments', 'residential'):
            style = choose(key, [('highrise_res', 5), ('glass_blue', 2), ('modern_midrise', 2), ('apartment_stucco', 1)])
        else:
            style = choose(key, [('glass_blue', 4), ('glass_dark', 3), ('glass_green', 2), ('office_stone', 3),
                                 ('office_concrete', 3), ('office_granite', 2)])
        pal_, par, ground = 'neutral', 1.2, LAYER['gf_lobby']
    elif industrial:
        if nh in SOMA_NH or (nh == 'Potrero Hill' or nh == 'Bayview Hunters Point') and H > 9 and A < 5000:
            style = choose(key, [('brick_warehouse', 4), ('industrial_concrete', 3), ('industrial_metal', 2)])
        else:
            style = choose(key, [('industrial_metal', 5), ('industrial_concrete', 4), ('brick_warehouse', 1 if reg == 'sf' else 0.3)])
        pal_ = 'industrial'
        ground = LAYER['gf_warehouse'] if style != 'brick_warehouse' else LAYER['gf_storefront']
        par = 0.6
        side = style
    elif H >= 14:
        if nh in DOWNTOWN_NH or oak_dt:
            style = choose(key, [('office_stone', 4), ('office_concrete', 3), ('civic_stone', 1), ('apartment_brick', 2), ('office_granite', 1), ('glass_green', 1)])
            ground = LAYER['gf_storefront'] if rnd01(key, 'g') < 0.6 else LAYER['gf_lobby']
        elif nh in SOMA_NH:
            style = choose(key, [('modern_midrise', 4), ('brick_warehouse', 3), ('office_concrete', 2), ('highrise_res', 1)])
            ground = LAYER['gf_storefront']
        elif nh in APARTMENT_NH or nh in VICTORIAN_NH:
            style = choose(key, [('apartment_stucco', 5), ('apartment_brick', 3), ('modern_midrise', 1)])
            ground = LAYER['gf_storefront'] if commercial or rnd01(key, 'g') < 0.35 else LAYER['gf_garage']
        elif bt in ('school', 'university', 'college', 'hospital', 'public', 'civic', 'government'):
            style = choose(key, [('civic_stone', 2), ('office_concrete', 3), ('modern_midrise', 2)])
        else:
            style = choose(key, [('modern_midrise', 3), ('apartment_stucco', 3), ('office_concrete', 2), ('apartment_brick', 1)])
            ground = LAYER['gf_storefront'] if commercial else -1
        pal_ = {'apartment_stucco': 'stucco', 'modern_midrise': 'modern'}.get(style, 'neutral')
        par = 0.9
    elif house_like and reg == 'sf':
        if nh in VICTORIAN_NH:
            style = choose(key, [('victorian', 5), ('edwardian', 4), ('apartment_stucco', 1)])
            ground = LAYER['gf_victorian'] if style != 'apartment_stucco' else LAYER['gf_garage']
            pal_ = 'victorian' if style == 'victorian' else ('edwardian' if style == 'edwardian' else 'stucco')
            rear = 'house_siding'
        elif nh in AVENUES_NH:
            style = choose(key, [('sunset_house', 8), ('edwardian', 1), ('apartment_stucco', 1)])
            ground = LAYER['gf_garage']
            pal_ = 'sunset' if style != 'edwardian' else 'edwardian'
            rear = 'rear_stucco'
        elif nh in APARTMENT_NH or nh in DOWNTOWN_NH:
            style = choose(key, [('apartment_stucco', 5), ('victorian', 2), ('edwardian', 2), ('apartment_brick', 1)])
            ground = LAYER['gf_garage'] if not commercial else LAYER['gf_storefront']
            pal_ = 'stucco' if style.startswith('apartment') else 'victorian'
            rear = 'rear_stucco'
        elif nh in SOMA_NH:
            style = choose(key, [('brick_warehouse', 2), ('edwardian', 2), ('modern_midrise', 2), ('apartment_stucco', 2)])
            ground = LAYER['gf_storefront'] if style in ('brick_warehouse', 'modern_midrise') else LAYER['gf_garage']
            pal_ = 'stucco' if style != 'edwardian' else 'edwardian'
        elif nh in ('Presidio', 'Treasure Island'):
            style = choose(key, [('house_siding', 5), ('apartment_brick', 2), ('civic_stone', 1)])
            pal_ = 'neutral'
        else:
            style, pal_ = 'sunset_house', 'sunset'
            ground = LAYER['gf_garage']
        if commercial and style not in ('brick_warehouse', 'modern_midrise'):
            ground = LAYER['gf_storefront']
        par = 0.5
    elif house_like:
        if commercial:
            style, pal_, ground, par = 'blank_stucco', 'stucco', LAYER['gf_storefront'], 0.5
        else:
            style = 'house_siding' if reg != 'peninsula' or rnd01(key, 'p') < 0.4 else 'sunset_house'
            pal_ = 'house' if style == 'house_siding' else 'sunset'
            ground = LAYER['gf_garage'] if style == 'sunset_house' else -1
            par = 0.3
            rear = style
    else:  # low-rise, larger footprint
        if commercial:
            style = choose(key, [('blank_stucco', 3), ('modern_midrise', 2), ('apartment_stucco', 2), ('brick_warehouse', 1)])
            ground = LAYER['gf_storefront']
            pal_ = 'stucco'
        elif bt in ('school', 'university', 'college', 'hospital', 'church', 'public', 'civic', 'government'):
            style = choose(key, [('civic_stone', 2), ('office_concrete', 2), ('modern_midrise', 1), ('apartment_brick', 1)])
            pal_ = 'neutral'
        elif nh in SOMA_NH:
            style = choose(key, [('brick_warehouse', 3), ('modern_midrise', 2), ('industrial_concrete', 2)])
            ground = LAYER['gf_storefront']
            pal_ = 'industrial'
        elif nh in VICTORIAN_NH or nh in APARTMENT_NH:
            style = choose(key, [('apartment_stucco', 4), ('edwardian', 2), ('apartment_brick', 2)])
            ground = LAYER['gf_garage'] if rnd01(key, 'g') < 0.6 else LAYER['gf_storefront']
            pal_ = 'stucco' if style != 'edwardian' else 'edwardian'
        elif reg == 'sf':
            style = choose(key, [('apartment_stucco', 3), ('sunset_house', 3), ('modern_midrise', 1)])
            ground = LAYER['gf_garage']
            pal_ = 'sunset' if style == 'sunset_house' else 'stucco'
        else:
            style = choose(key, [('apartment_stucco', 3), ('modern_midrise', 2), ('industrial_concrete', 2), ('house_siding', 1)])
            pal_ = 'stucco'
        par = 0.7
    if rear is None:
        rear = {'sunset_house': 'rear_stucco', 'apartment_stucco': 'rear_stucco', 'edwardian': 'rear_stucco',
                'victorian': 'house_siding'}.get(style, style)
    b['style'] = LAYER[style]
    b['ground'] = ground
    b['rear'] = LAYER[rear]
    b['side'] = LAYER[side if style not in ('brick_warehouse', 'apartment_brick', 'civic_stone') else 'blank_brick']
    b['tint'] = tint_of(key, pal_)
    b['par'] = par
    # roofs
    rt = b['roof']['t']
    if rt != 'flat':
        tile = (reg in ('marin',) or nh in ('Seacliff', 'West of Twin Peaks', 'Lakeshore') or style == 'sunset_house') and rnd01(key, 'r') < 0.55
        if industrial:
            b['roofstyle'], rp = LAYER['roof_metal'], 'roof_metal'
        elif tile:
            b['roofstyle'], rp = LAYER['roof_tile'], 'roof_tile'
        else:
            b['roofstyle'], rp = LAYER['roof_shingle'], 'roof_shingle'
    else:
        if industrial:
            b['roofstyle'] = choose(key + 'r', [(LAYER['roof_metal'], 3), (LAYER['roof_membrane'], 4), (LAYER['roof_gravel'], 2)])
        elif H >= 30 or commercial:
            b['roofstyle'] = choose(key + 'r', [(LAYER['roof_membrane'], 3), (LAYER['roof_gravel'], 4), (LAYER['roof_concrete'], 2)])
        elif style == LAYER['parking']:
            b['roofstyle'] = LAYER['roof_concrete']
        else:
            b['roofstyle'] = choose(key + 'r', [(LAYER['roof_gravel'], 4), (LAYER['roof_tar'], 3), (LAYER['roof_membrane'], 3)])
        rp = 'roof_metal' if b['roofstyle'] == LAYER['roof_metal'] else 'roof_flat'
    b['rtint'] = tint_of(key + 'roof', rp, 0.06)


# ---------------------------------------------------------------------------------------------- roof colour from photo
def srgb_to_lin(c):
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def atlas_cell_means():
    """Mean linear albedo of every atlas cell (for converting a target roof colour into a tint multiplier)."""
    from PIL import Image
    im = np.asarray(Image.open(os.path.join(ROOT, 'assets', 'sf', 'city', 'atlas', ATLAS['images']['albedo'])).convert('RGB'))
    g, c = ATLAS['grid'], ATLAS['cell']
    out = {}
    for l in ATLAS['layers']:
        gx, gy = l['index'] % g, l['index'] // g
        cell = im[gy * c:(gy + 1) * c, gx * c:(gx + 1) * c].reshape(-1, 3)
        out[l['index']] = srgb_to_lin(cell).mean(0)
    return out


def sample_roof_colors(buildings):
    """Roof colours from the W1 aerial imagery (1 m/px NAIP mosaic, level-8 tiles): per footprint (shrunk 0.8 m), mean of
    the brighter 70 % of pixels (drops shadows). Picks white membrane / gravel / tar / tile by the sampled colour and sets
    the roof tint so the rendered roof matches the photo seen between the buildings."""
    from PIL import Image
    from rasterio import features
    from rasterio.transform import from_origin
    tidx_path = os.path.join(ROOT, 'assets', 'sf', 'terrain', 'index.json')
    if not os.path.exists(tidx_path):
        print('  (no W1 imagery: palette roof colours)')
        return
    tidx = json.load(open(tidx_path))
    RX, RZ, root = tidx['rootMinX'], tidx['rootMinZ'], tidx['rootSize']
    L = 8
    size = root / (1 << L)
    px = int(tidx.get('imgPx', 512))
    means = atlas_cell_means()
    groups = defaultdict(list)
    for bi, b in enumerate(buildings):
        if b['H'] > 30 or b.get('base', 0) > 0.5:
            continue
        groups[(int(math.floor((b['cx'] - RX) / size)), int(math.floor((b['cz'] - RZ) / size)))].append(bi)
    n_ok = 0
    for (i, j), ids in groups.items():
        path = os.path.join(ROOT, 'assets', 'sf', 'terrain', 'img', str(L), f'{i}_{j}.webp')
        if not os.path.exists(path):
            continue
        img = np.asarray(Image.open(path).convert('RGB'), np.float32)
        x0, z0 = RX + i * size, RZ + j * size
        tr = from_origin(x0, z0, size / px, -size / px)
        shapes = []
        for k, bi in enumerate(ids):
            q = buildings[bi]['p0'].buffer(-0.8)
            if not q.is_empty:
                shapes.append((q, k + 1))
        if not shapes:
            continue
        lab = features.rasterize(shapes, out_shape=(px, px), transform=tr, fill=0, dtype='int32').ravel()
        sel = np.nonzero(lab)[0]
        if not len(sel):
            continue
        lv = lab[sel]
        order = np.argsort(lv, kind='stable')
        lv, sel = lv[order], sel[order]
        cols = img.reshape(-1, 3)[sel]
        cuts = np.nonzero(np.diff(lv))[0] + 1
        for grp_l, grp_c in zip(np.split(lv, cuts), np.split(cols, cuts)):
            if len(grp_c) < 6:
                continue
            lum = grp_c @ np.array([0.299, 0.587, 0.114])
            keep = grp_c[lum >= np.percentile(lum, 30)]
            c = keep.mean(0)
            b = buildings[ids[grp_l[0] - 1]]
            lumc = float(c @ np.array([0.299, 0.587, 0.114]))
            if b['roof']['t'] == 'flat':
                if b['roofstyle'] == LAYER['roof_metal']:
                    pass
                elif lumc > 168:
                    b['roofstyle'] = LAYER['roof_membrane']
                elif lumc < 80:
                    b['roofstyle'] = LAYER['roof_tar']
                elif b['roofstyle'] in (LAYER['roof_membrane'], LAYER['roof_tar']):
                    b['roofstyle'] = LAYER['roof_gravel']
            else:
                reddish = c[0] > c[1] * 1.12 and c[0] > c[2] * 1.25
                if b['roofstyle'] != LAYER['roof_metal']:
                    b['roofstyle'] = LAYER['roof_tile'] if reddish else LAYER['roof_shingle']
            target = srgb_to_lin(c) * 1.08          # the photo is slightly dark/hazy
            m = means[b['roofstyle']]
            tint = np.clip(target / np.maximum(m, 1e-3), 0.05, 1.0)
            b['rtint'] = tuple(float(v) for v in tint)
            n_ok += 1
    print(f'  roof colours sampled from imagery for {n_ok} buildings', flush=True)


# -------------------------------------------------------------------------------------------------------- roof shape
def min_rect(p):
    r = p.minimum_rotated_rectangle
    c = np.array(r.exterior.coords)[:4]
    e0, e1 = c[1] - c[0], c[2] - c[1]
    l0, l1 = np.hypot(*e0), np.hypot(*e1)
    return r, c, l0, l1


def roof_shape(b):
    """Pitched roofs only for near-rectangular small buildings: {'t': 'gable'|'hip', 'rect': 4 corners, 'rise': m}."""
    p, H, A = b['poly'], b['H'], b['area']
    b['roof'] = {'t': 'flat'}
    if A > 700 or A < 25 or H > 16 or H < 2.5:
        return
    t = b['tags']
    shape = t.get('roof:shape')
    rect, c, l0, l1 = min_rect(p)
    if rect.area <= 0 or p.area / rect.area < 0.82:
        return
    short = min(l0, l1)
    if b['src'] == 'sf':
        # LiDAR: a pitched roof spreads heights uniformly between eave and ridge (mean ~ median, mode away from the
        # median); flat roofs (the SF norm) have the mode at the median with a few high outliers (parapets, chimneys).
        std, mean, maj = b['Hstd'], b.get('Hmean', H), b.get('Hmaj', H)
        if std < 0.6 or std > 2.2 or abs(mean - H) > 0.3 * std or abs(maj - H) < 0.5 * std:
            return
        if b.get('nh') in AVENUES_NH and rnd01(b['id'], 'pz') < 0.5:
            return
        rise = std * 3.3
        if not (1.2 < rise < 7.0) or b['Hmax'] - H > rise * 1.2 + 2.5:
            return
        rise = min(rise, 0.55 * short)
        # median of a pitched roof sits about halfway up the slope: eave = H - rise/2
        eave = H - rise / 2
        if eave < 2.2:
            return
        kind = 'hip' if (max(l0, l1) / max(short, 0.1) < 1.35 or rnd01(b['id'], 'hip') < 0.3) else 'gable'
    else:
        if shape in ('flat',):
            return
        if shape in ('gabled', 'hipped', 'pyramidal', 'half-hipped', 'gambrel', 'mansard', 'skillion'):
            kind = 'hip' if shape in ('hipped', 'pyramidal', 'half-hipped', 'mansard') else 'gable'
        else:
            bt = t.get('building', 'yes')
            resid = bt in ('house', 'detached', 'residential', 'semidetached_house', 'terrace', 'bungalow', 'garage', 'yes', 'shed', 'hut', 'cabin')
            if not resid or A > 450 or b.get('lu') in ('industrial', 'commercial', 'retail', 'port'):
                return
            if b['region'] == 'sf':
                return
            kind = 'hip' if rnd01(b['id'], 'hip') < 0.5 else 'gable'
        rise = parse_len(t.get('roof:height')) or min(0.36 * short, 3.2)
        eave = H if 'height' not in t else max(2.4, H - rise)
    b['roof'] = {'t': kind, 'rise': round(float(rise), 2), 'rect': [[round(float(x), 3), round(float(y), 3)] for x, y in c]}
    b['H'] = round(float(eave), 2)
    b['poly'] = Polygon(c)
    b['area'] = b['poly'].area


# ---------------------------------------------------------------------------------------------------------- heights
def osm_height(t, area, region, lu, cx, cz, key):
    h = parse_len(t.get('height'))
    mh = parse_len(t.get('min_height')) or 0.0
    lv = parse_len(t.get('building:levels'))
    if h is None and lv is not None:
        h = lv * 3.2 + (1.5 if lv > 3 else 0.6)
    if h is not None:
        return max(2.5, h), mh, True
    bt = t.get('building', 'yes')
    r = rnd01(key, 'h')
    if bt in ('garage', 'garages', 'carport', 'shed', 'roof', 'hut', 'kiosk'):
        return 2.6 + r, 0.0, False
    oak = region == 'eastbay' and math.hypot(cx - OAKLAND_DT[0], cz - OAKLAND_DT[1]) < 1100
    if oak and area > 600:
        return 14 + 22 * r, 0.0, False
    if bt in ('industrial', 'warehouse', 'hangar', 'manufacture') or lu in ('industrial', 'port', 'railway'):
        return 6.5 + 5 * r if area > 300 else 4 + 2 * r, 0.0, False
    if bt in ('apartments', 'dormitory'):
        return 9 + 7 * r, 0.0, False
    if bt in ('commercial', 'retail', 'supermarket', 'office', 'hotel', 'mixed_use') or lu in ('commercial', 'retail'):
        return (5 + 4 * r) if area < 1500 else (7 + 5 * r), 0.0, False
    if bt in ('school', 'university', 'college', 'hospital', 'public', 'civic', 'church', 'government'):
        return 8 + 6 * r, 0.0, False
    if area < 45:
        return 2.8 + r, 0.0, False
    if area < 330:   # houses: 1 or 2 storeys
        return (3.4 + 0.6 * r) if r < 0.5 else (5.8 + 0.8 * r), 0.0, False
    if area < 1200:
        return 6 + 5 * r, 0.0, False
    return 7 + 5 * r, 0.0, False


# -------------------------------------------------------------------------------------------------------------- main
def clean_poly(p, tol):
    q = p.simplify(tol, preserve_topology=True)
    if q.is_empty or not q.is_valid or q.area < 4:
        q = p
    if isinstance(q, MultiPolygon):
        q = max(q.geoms, key=lambda g: g.area)
    q = shapely.geometry.polygon.orient(q, 1.0)
    return q


def ring_list(r):
    c = np.asarray(r.coords)[:-1]
    return [[round(float(x), 2), round(float(y), 2)] for x, y in c]


def main():
    t0 = time.time()
    only = None
    if '--only' in sys.argv:
        only = tuple(int(v) for v in sys.argv[sys.argv.index('--only') + 1].split(','))
    os.makedirs(TILES, exist_ok=True)
    os.makedirs(OBST, exist_ok=True)
    print('loading DataSF ...', flush=True)
    sf = load_datasf()
    print(f'  {len(sf)} SF footprints ({time.time() - t0:.0f} s)', flush=True)
    osm = load_osm()
    print(f'  {len(osm)} OSM polygons ({time.time() - t0:.0f} s)', flush=True)
    excl = load_exclusions()
    ex_tree = STRtree(excl)
    nh_polys, nh_names = load_neighborhoods()
    nh_tree = STRtree(nh_polys)
    lu_polys, lu_kinds = load_landuse()
    lu_tree = STRtree(lu_polys)
    roads, road_kinds = load_roads()
    road_tree = STRtree(roads)
    print(f'  aux loaded ({time.time() - t0:.0f} s)', flush=True)

    # ---- match OSM to DataSF
    sf_polys = [b['poly'] for b in sf]
    sf_tree = STRtree(sf_polys)
    osm_b = [o for o in osm if not o['part']]
    osm_parts = [o for o in osm if o['part']]
    reps = shapely.point_on_surface(np.array([o['poly'] for o in osm_b], dtype=object))
    pairs = sf_tree.query(reps, predicate='intersects')
    matched = defaultdict(list)
    osm_matched = np.zeros(len(osm_b), bool)
    for oi, si in zip(*pairs):
        matched[si].append(oi)
        osm_matched[oi] = True
    # also treat as matched when the OSM footprint overlaps SF footprints by > 25 %
    cand = sf_tree.query([o['poly'] for o in osm_b], predicate='intersects')
    ov = defaultdict(float)
    for oi, si in zip(*cand):
        if not osm_matched[oi]:
            ov[oi] += osm_b[oi]['poly'].intersection(sf_polys[si]).area
    for oi, a in ov.items():
        if a > 0.25 * osm_b[oi]['poly'].area:
            osm_matched[oi] = True
    buildings = []
    n_newh = n_lowfix = 0
    for si, b in enumerate(sf):
        tags = {}
        oh = None
        for oi in matched.get(si, []):
            tags.update({k: v for k, v in osm_b[oi]['tags'].items() if k not in tags})
            h = parse_len(osm_b[oi]['tags'].get('height'))
            if h:
                oh = max(oh or 0, h)
        b['tags'] = tags
        if oh and oh > b['H'] + 15 and oh > 30:     # post-2010 towers (LiDAR shows a construction site)
            b['H'] = oh
            b['Hstd'] = 0
            n_newh += 1
        if b['H'] < 2.0:
            if oh:
                b['H'] = oh
            elif b['poly'].area > 150:
                b['H'] = 9.0 + 6 * rnd01(b['id'], 'x')
            else:
                b['H'] = 3.0
            b['Hstd'] = 0
            n_lowfix += 1
        buildings.append(b)
    print(f'  SF: {n_newh} tower heights from OSM, {n_lowfix} low LiDAR fixed', flush=True)
    n_osm = 0
    for oi, o in enumerate(osm_b):
        if osm_matched[oi]:
            continue
        o.update(H=None, gnd=None, Hstd=0.0, Hmax=0.0)
        buildings.append(o)
        n_osm += 1
    print(f'  + {n_osm} OSM-only buildings', flush=True)

    # ---- tall towers: replace DataSF footprints by OSM building:part setbacks where available
    part_tree = STRtree([p['poly'] for p in osm_parts]) if osm_parts else None
    replaced = set()
    extra = []
    if part_tree is not None:
        for bi, b in enumerate(buildings):
            if b['src'] != 'sf' or b['H'] < 35:
                continue
            idx = part_tree.query(b['poly'].buffer(2.0), predicate='contains')
            parts = [osm_parts[i] for i in idx if parse_len(osm_parts[i]['tags'].get('height'))]
            if not parts:
                continue
            cover = unary_union([p['poly'] for p in parts]).area
            if cover < 0.6 * b['poly'].area:
                continue
            ptop = max(parse_len(p['tags'].get('height')) for p in parts)
            if ptop < 0.6 * b['Hmax'] - 10:
                continue
            replaced.add(bi)
            for p in parts:
                q = dict(b)
                q.update(poly=p['poly'], id=f"{b['id']}_p{p['id']}", H=parse_len(p['tags'].get('height')),
                         base=parse_len(p['tags'].get('min_height')) or 0.0, Hstd=0.0, tags=dict(b['tags'], **p['tags']),
                         anchor=b['poly'].centroid, group_area=b['poly'].area)
                extra.append(q)
    buildings = [b for i, b in enumerate(buildings) if i not in replaced] + extra
    print(f'  {len(replaced)} towers modelled from {len(extra)} OSM building parts', flush=True)

    # ---- exclusions (brief: landmarks, KSFO/KOAK aerodromes, Alameda Point; W4: exclusions.json ids + zones)
    polys = [b['poly'] for b in buildings]
    hit = ex_tree.query(polys, predicate='intersects')
    drop = set(hit[0].tolist())
    apt_ids, apt_zones = load_airport_exclusions()
    for i, b in enumerate(buildings):
        if b['src'] == 'osm' and b['id'].rsplit('_', 1)[0] in apt_ids:
            drop.add(i)
    lm_zones = load_landmark_bounds()
    if lm_zones:
        # W3 building-type landmarks: also drop footprints overlapping the model bounds by >= 25 % of their area
        lt = STRtree(lm_zones)
        for bi, li in zip(*lt.query(polys, predicate='intersects')):
            p = polys[bi]
            if p.intersection(lm_zones[li]).area >= 0.25 * p.area:
                drop.add(int(bi))
    apt_zones = apt_zones + lm_zones
    if apt_zones:
        zt = STRtree(apt_zones)
        cs = shapely.centroid(np.array([b['poly'] for b in buildings], dtype=object))
        drop.update(zt.query(cs, predicate='intersects')[0].tolist())
    buildings = [b for i, b in enumerate(buildings) if i not in drop]
    print(f'  excluded {len(drop)} (landmarks / airports / Alameda Point) -> {len(buildings)}', flush=True)

    # ---- attributes: centroid, neighbourhood, landuse, heights
    cents = shapely.centroid(np.array([b['poly'] for b in buildings], dtype=object))
    nh_of = {}
    for pi, ni in zip(*nh_tree.query(cents, predicate='intersects')):
        nh_of[pi] = nh_names[ni]
    lu_of = {}
    for pi, li in zip(*lu_tree.query(cents, predicate='intersects')):
        k = lu_kinds[li]
        if pi not in lu_of or k in ('industrial', 'port', 'commercial', 'retail'):
            lu_of[pi] = k
    for i, b in enumerate(buildings):
        c = b['poly'].centroid
        b['cx'], b['cz'] = c.x, c.y
        b['area'] = b['poly'].area
        b['nh'] = nh_of.get(i)
        b['region'] = region_of(c.x, c.y, b['nh'] if b['src'] == 'sf' else None)
        if b['src'] == 'sf':
            b['region'] = 'sf'
        b['lu'] = lu_of.get(i)
        b.setdefault('base', 0.0)
        if b['H'] is None:
            h, mh, known = osm_height(b['tags'], b['area'], b['region'], b['lu'], c.x, c.y, b['id'])
            b['H'], b['base'] = h, mh
    # ---- roofs, styles
    for b in buildings:
        roof_shape(b)
        classify(b)
    print(f'  classified ({time.time() - t0:.0f} s)', flush=True)
    print('  styles:', Counter(ATLAS['layers'][b['style']]['name'] for b in buildings).most_common())
    print('  roofs:', Counter(b['roof']['t'] for b in buildings))

    # ---- simplify footprints (LOD0) and compute edge attributes
    for b in buildings:
        b['p0'] = clean_poly(b['poly'], 0.3)
    polys = [b['p0'] for b in buildings]
    tree = STRtree(polys)
    ground = np.array([b['gnd'] if b.get('gnd') is not None else np.nan for b in buildings])
    eaves = np.array([b['H'] for b in buildings])
    # probe points: every edge split into <= 4 m segments; probe 0.35 m outside the segment midpoint
    probe_pts, probe_ref = [], []
    for bi, b in enumerate(buildings):
        rings = [b['p0'].exterior] + list(b['p0'].interiors)
        b['segs'] = []
        for ri, r in enumerate(rings):
            c = np.asarray(r.coords)[:-1]
            n = len(c)
            ring_segs = []
            for k in range(n):
                a, d = c[k], c[(k + 1) % n]
                e = d - a
                L = float(np.hypot(*e))
                if L < 1e-3:
                    continue
                nrm = np.array([e[1], -e[0]]) / L        # outward for CCW exterior (x, z)
                # (orient() makes holes CW, so the right-hand normal points away from the material for all rings)
                ns = max(1, int(math.ceil(L / 4.0)))
                for s in range(ns):
                    t0_, t1_ = s / ns, (s + 1) / ns
                    mid = a + e * (t0_ + t1_) / 2
                    probe_pts.append(mid + nrm * 0.9)
                    probe_ref.append((bi, ri, k, s))
                ring_segs.append((k, ns))
            b['segs'].append(ring_segs)
    probe_pts = np.array(probe_pts)
    print(f'  {len(probe_pts)} edge probes', flush=True)
    pp = shapely.points(probe_pts)
    pi_, bj_ = tree.query(pp, predicate='intersects')
    nbr_h = np.full(len(probe_pts), -1.0)
    for p, j in zip(pi_, bj_):
        bi = probe_ref[p][0]
        if j == bi:
            continue
        if buildings[j].get('base', 0) > 0.5:
            continue
        hj = eaves[j]
        if not np.isnan(ground[j]) and not np.isnan(ground[bi]):
            hj += ground[j] - ground[bi]
        nbr_h[p] = max(nbr_h[p], hj)
    # street-facing: distance from the probe (2 m out) to the nearest road centreline
    far_pts = []
    for p, (bi, ri, k, s) in enumerate(probe_ref):
        far_pts.append(probe_pts[p])
    far = shapely.points(np.asarray(far_pts))
    idx2, dist2 = road_tree.query_nearest(far, max_distance=30.0, return_distance=True, all_matches=False)
    dmap = np.full(len(probe_pts), 1e9)
    dmap[idx2[0]] = dist2
    # write back per edge: list of [partyH or -1, street 0/1] per segment
    for p, (bi, ri, k, s) in enumerate(probe_ref):
        b = buildings[bi]
        b.setdefault('edge', {})[(ri, k, s)] = (round(float(nbr_h[p]), 1), 1 if dmap[p] < 17.0 else 0)
    print(f'  party walls: {(nbr_h > 0).sum()} of {len(nbr_h)} probe segments; street-facing {(dmap < 17).sum()} ({time.time() - t0:.0f} s)', flush=True)

    sample_roof_colors(buildings)

    # ---- rooftop details (units / penthouse) for flat roofs
    for b in buildings:
        units = []
        if b['roof']['t'] == 'flat' and b['area'] > 250 and b['H'] > 8 and b['style'] not in (LAYER['parking'],):
            p = b['p0'].buffer(-1.5)
            if not p.is_empty and p.area > 60:
                minx, miny, maxx, maxy = p.bounds
                rect, c, l0, l1 = min_rect(b['p0'])
                ang = math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0])
                n = min(12, int(b['area'] / 350) + 1)
                tries = 0
                while len(units) < n and tries < n * 6:
                    tries += 1
                    u = rnd01(b['id'], f'u{tries}')
                    v = rnd01(b['id'], f'v{tries}')
                    x, y = minx + (maxx - minx) * u, miny + (maxy - miny) * v
                    w = 1.8 + 2.5 * rnd01(b['id'], f'w{tries}')
                    d = 1.5 + 2.0 * rnd01(b['id'], f'd{tries}')
                    fp = shapely.affinity.rotate(sbox(x - w / 2, y - d / 2, x + w / 2, y + d / 2), ang, use_radians=True)
                    if p.contains(fp) and not any(fp.intersects(shapely.affinity.rotate(sbox(q[0] - q[2] / 2, q[1] - q[3] / 2, q[0] + q[2] / 2, q[1] + q[3] / 2), q[5], use_radians=True)) for q in units):
                        units.append([round(x, 2), round(y, 2), round(w, 2), round(d, 2), round(1.2 + 1.3 * rnd01(b['id'], f'h{tries}'), 2), round(ang, 4)])
                if b['H'] >= 30:
                    q = shapely.affinity.scale(rect, 0.45, 0.45)
                    if b['p0'].buffer(-0.5).contains(q) and q.area > 40:
                        cc = np.asarray(q.exterior.coords)[:4]
                        b['pent'] = {'rect': [[round(float(x), 2), round(float(y), 2)] for x, y in cc],
                                     'h': round(3.5 + 3.0 * rnd01(b['id'], 'ph'), 2)}
                        units = [u for u in units if not q.buffer(1.0).contains(Point(u[0], u[1]))]
        b['units'] = units

    # ---- tiles
    by_tile = defaultdict(list)
    for bi, b in enumerate(buildings):
        ax, az = (b['anchor'].x, b['anchor'].y) if 'anchor' in b else (b['cx'], b['cz'])
        b['ax'], b['az'] = ax, az
        i, j = int(math.floor(ax / T1)), int(math.floor(az / T1))
        by_tile[(i, j)].append(bi)
    index = []
    for (i, j), ids in sorted(by_tile.items()):
        if only and (i, j) != only:
            continue
        recs = []
        for bi in ids:
            b = buildings[bi]
            p0 = b['p0']
            p1 = clean_poly(b['poly'], 1.2) if b['roof']['t'] == 'flat' else p0
            # per ring: list of edges -> list of segments [partyH, street]
            edges = []
            for ri, ring_segs in enumerate(b['segs']):
                re_ = []
                for (k, ns) in ring_segs:
                    re_.append([k, [list(b['edge'].get((ri, k, s), (-1, 0))) for s in range(ns)]])
                edges.append(re_)
            sub = (1 if b['ax'] - i * T1 >= T1 / 2 else 0) + (2 if b['az'] - j * T1 >= T1 / 2 else 0)
            rec = {
                'id': b['id'], 'sub': sub,
                'p': ring_list(p0.exterior), 'holes': [ring_list(r) for r in p0.interiors],
                'p1': ring_list(p1.exterior) if p1 is not p0 else None,
                'h': round(float(b['H']), 2), 'base': round(float(b.get('base', 0.0)), 2),
                'roof': b['roof'], 'par': b['par'], 'units': b['units'], 'pent': b.get('pent'),
                's': b['style'], 'g': b['ground'], 'rear': b['rear'], 'side': b['side'], 'rs': b['roofstyle'],
                'c': [round(x, 3) for x in b['tint']], 'rc': [round(x, 3) for x in b['rtint']],
                'e': edges, 'a': [round(b['ax'], 2), round(b['az'], 2)], 'seed': round(rnd01(b['id'], 'seed'), 4),
            }
            recs.append(rec)
        json.dump({'tile': [i, j], 'size': T1, 'origin': [i * T1, j * T1], 'buildings': recs},
                  open(os.path.join(TILES, f'L1_{i}_{j}.json'), 'w'), separators=(',', ':'))
        index.append({'i': i, 'j': j, 'n': len(recs)})
        write_obstacles(i, j, [buildings[bi] for bi in ids])
    json.dump(index, open(os.path.join(TILES, 'index_L1.json'), 'w'))
    print(f'  wrote {len(index)} L1 tiles ({time.time() - t0:.0f} s)', flush=True)
    if only is None:
        write_far(buildings)
    print(f'done in {time.time() - t0:.0f} s')


def write_obstacles(i, j, blds):
    """4 m raster of the tallest solid per cell (uint16 index+1) + solids table (anchor x, z, top above anchor ground)."""
    from rasterio import features
    from rasterio.transform import from_origin
    n = int(T1 / OBST_CELL)
    x0, z0 = i * T1, j * T1
    # rows follow +z; rasterio's transform maps (col,row) -> (x, y) with y decreasing; use z as "y" with positive dy
    tr = from_origin(x0, z0, OBST_CELL, -OBST_CELL)
    solids = []
    shapes = []
    order = sorted(range(len(blds)), key=lambda k: blds[k]['H'])
    for k in order:
        b = blds[k]
        top = b['H'] + (b['roof'].get('rise', 0.0) if b['roof']['t'] != 'flat' else b.get('par', 0.0))
        if b.get('pent'):
            top += b['pent']['h']
        solids.append((b['ax'], b['az'], top))
        shapes.append((b['p0'].buffer(1.0), len(solids)))
    if not shapes:
        return
    ras = features.rasterize(shapes, out_shape=(n, n), transform=tr, fill=0, all_touched=True, dtype='uint16')
    head = struct.pack('<4siiIfHH', b'OBS1', i, j, len(solids), OBST_CELL, n, n)
    body = np.asarray(solids, np.float32).tobytes() + ras.astype('<u2').tobytes()
    with gzip.open(os.path.join(OBST, f'{i}_{j}.bin.gz'), 'wb', compresslevel=9) as f:
        f.write(head + body)


def merge_blocks(blds, bins, buf, simp, min_area):
    recs = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        sel = [b for b in blds if lo <= b['H'] < hi]
        if not sel:
            continue
        u = unary_union([b['poly'].buffer(buf, join_style=2) for b in sel]).buffer(-buf, join_style=2)
        geoms = u.geoms if hasattr(u, 'geoms') else [u]
        tree = STRtree([b['poly'] for b in sel])
        for g in geoms:
            if g.area < min_area or not isinstance(g, Polygon):
                continue
            g = g.simplify(simp, preserve_topology=True)
            if g.is_empty or not isinstance(g, Polygon) or len(g.exterior.coords) < 4:
                continue
            g = shapely.geometry.polygon.orient(Polygon(g.exterior), 1.0)
            members = [sel[k] for k in tree.query(g, predicate='intersects')]
            if not members:
                continue
            w = np.array([m['area'] for m in members])
            h = float((np.array([m['H'] + 0.5 * m['roof'].get('rise', 0) for m in members]) * w).sum() / w.sum())
            dom = max(members, key=lambda m: m['area'])
            col = (np.array([m['tint'] for m in members]) * w[:, None]).sum(0) / w.sum()
            rcol = (np.array([m['rtint'] for m in members]) * w[:, None]).sum(0) / w.sum()
            recs.append({'p': ring_list(g.exterior), 'h': round(h, 1), 's': dom['style'], 'rs': dom['roofstyle'],
                         'c': [round(float(x), 3) for x in col], 'rc': [round(float(x), 3) for x in rcol], 'base': 0.0})
    return recs


def write_far(buildings):
    """LOD2 (3.6-8 km): per 2 km tile, footprints of similar height merged into blocks.
    LOD3 (> 8 km): only what still reads at that distance (>= 12 m), coarser."""
    t0 = time.time()
    T2 = 2 * T1
    groups = defaultdict(list)
    for b in buildings:
        i, j = int(math.floor(b['ax'] / T2)), int(math.floor(b['az'] / T2))
        groups[(i, j)].append(b)
    for (i, j), blds in groups.items():
        tall = [b for b in blds if b['H'] >= 35]
        tall_recs = []
        for b in tall:
            p = clean_poly(b['poly'], 2.0)
            tall_recs.append({'p': ring_list(p.exterior), 'h': round(b['H'], 1), 's': b['style'], 'rs': b['roofstyle'],
                              'c': [round(x, 3) for x in b['tint']], 'rc': [round(x, 3) for x in b['rtint']], 'base': b.get('base', 0.0)})
        rest = [b for b in blds if b['H'] < 35]
        l2 = tall_recs + merge_blocks(rest, [0, 7, 13, 22, 35], 3.0, 4.5, 150)
        l3 = tall_recs + merge_blocks([b for b in rest if b['H'] >= 12], [12, 22, 35], 4.0, 7.0, 400)
        for name, recs in (('L2', l2), ('L3', l3)):
            json.dump({'tile': [i, j], 'size': T2, 'origin': [i * T2, j * T2], 'blocks': recs},
                      open(os.path.join(TILES, f'{name}_{i}_{j}.json'), 'w'), separators=(',', ':'))
    print(f'  wrote {len(groups)} L2/L3 tiles ({time.time() - t0:.0f} s)', flush=True)


if __name__ == '__main__':
    main()
