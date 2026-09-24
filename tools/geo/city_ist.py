"""İstanbul city (GEO_REGION=ist): buildings, mosques, obstacles and far LOD blocks -> tile records for city_mesh.py.

  GEO_REGION=ist .venv/bin/python tools/geo/city_prep.py [--only i,j]      (city_prep.py dispatches here)

Sources (CONTRACTS-IST §2): OpenStreetMap buildings (Geofabrik Turkey extract, city_osm.py) + Overture Maps buildings
(AWS Open Data, city_fetch.py). Overture's OpenStreetMap-sourced rows are the same features as our (newer) extract and
are dropped; its Microsoft ML footprints fill the gaps where OSM has no building (conf >= 0.8, no OSM overlap).

Heights: OSM `height`, else `building:levels` x 3.2 m (+0.8 m roof slab / parapet); otherwise estimated: per
neighbourhood (admin_level 8) from the empirical distribution of tagged buildings of the same footprint class when a
neighbourhood has enough of them, else per district (admin_level 6) priors (historic peninsula low, Levent / Maslak /
Ataşehir / Esenyurt / Başakşehir high), footprint area and land use / building type.

Mosques (building=mosque, place_of_worship + religion=muslim, point mosques inside a footprint): prayer hall walls, a
lead-grey dome on a drum and 1 / 2 / 4 minarets (OSM minaret positions where mapped, else the corners away from the
qibla) - low-poly template geometry merged into the tile meshes (no extra draw calls).
Landmarks built by the landmarks agent (data/ist/landmarks.json ids / radii / polygons, assets/ist/landmarks/index.json
bounds, plus the fixed list below) and the airports (assets/ist/airports/exclusions.json, runway strips) are left out.

Outputs (same formats as San Francisco):
  <cache>/tiles/L1_<i>_<j>.json   1 km tile building records (L0 500 m sub-tiles + L1 are built from them)
  <cache>/tiles/L2_<i>_<j>.json   2 km merged blocks (3.6-8 km), L3_<i>_<j>.json (beyond 8 km, tall blocks only)
  assets/ist/city/obst/<i>_<j>.bin.gz   4 m obstacle rasters (tallest roof / minaret per cell)
  <cache>/stats.json               counts and height distribution
"""
import gzip, hashlib, json, math, os, struct, sys, time
from collections import defaultdict, Counter

import numpy as np
import shapely
import shapely.affinity
from shapely.geometry import Polygon, MultiPolygon, Point, LineString, box as sbox
from shapely.ops import unary_union
from shapely import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import E0, N0, CRS, DATA_DIR  # noqa: E402
from city_paths import ROOT, RAW, CACHE, OUT  # noqa: E402
from pyproj import Transformer  # noqa: E402

TILES = os.path.join(CACHE, 'tiles')
OBST = os.path.join(OUT, 'obst')
ATLAS = json.load(open(os.path.join(OUT, 'atlas', 'atlas.json')))
LAYER = {l['name']: l['index'] for l in ATLAS['layers']}
T1 = 1000.0
OBST_CELL = 4.0
FLOOR = 3.2
_fwd = Transformer.from_crs('EPSG:4326', CRS, always_xy=True)
QIBLA = 151.6          # bearing of the qibla from İstanbul (deg true)


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


def parse_levels(v):
    x = parse_len(v)
    if x is None or not (0 < x < 120):
        return None
    return x


def as_polys(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if hasattr(g, 'geoms'):
        out = []
        for x in g.geoms:
            out += as_polys(x)
        return out
    return []


# ------------------------------------------------------------------------------------------------------------ inputs
SKIP_BT = {'construction', 'ruins', 'no', 'bridge', 'collapsed', 'destroyed', 'demolished', 'proposed', 'tent'}


def load_osm():
    raw = json.load(open(os.path.join(CACHE, 'osm_buildings.json')))
    out = []
    for b in raw:
        t = b['tags']
        bt = t.get('building')
        if bt in SKIP_BT or t.get('building:part') in ('minaret', 'column', 'pillar', 'beam', 'bridge') \
                or t.get('location') == 'underground':
            continue
        # minarets are drawn by the mosque generator; lattice / TV towers and bridge pylons are not buildings
        if t.get('man_made') in ('minaret', 'mast', 'bridge') or t.get('tower:type') in ('minaret', 'communication') \
                or bt in ('minaret', 'tower', 'transmitter') or (t.get('man_made') == 'tower' and bt in (None, 'yes', 'commercial')
                                                                    and 'tower:type' in t):
            continue
        if t.get('disused') == 'yes' and bt is None:
            continue
        for k, r in enumerate(b['rings']):
            try:
                p = Polygon(proj(r['outer']), [proj(x) for x in r['inner'] if len(x) >= 4])
            except Exception:
                continue
            if not p.is_valid:
                p = p.buffer(0)
            for q in as_polys(p):
                if q.area >= 8:
                    out.append(dict(src='osm', id=f"{b['id']}_{k}", oid=b['id'], poly=q, tags=t,
                                    part='building:part' in t and 'building' not in t))
    return out


def load_overture_ml():
    import pyarrow.parquet as pq
    import glob
    out = []
    for f in sorted(glob.glob(os.path.join(RAW, 'overture', 'buildings_*.parquet'))):
        t = pq.read_table(f, columns=['id', 'sources', 'geometry', 'is_underground', 'height', 'num_floors'])
        src = t.column('sources').to_pylist()
        ids = t.column('id').to_pylist()
        geo = t.column('geometry').to_pylist()
        und = t.column('is_underground').to_pylist()
        hh = t.column('height').to_pylist()
        nf = t.column('num_floors').to_pylist()
        for s, i, g, u, h, n in zip(src, ids, geo, und, hh, nf):
            if not s or s[0]['dataset'] == 'OpenStreetMap' or u:
                continue
            conf = s[0].get('confidence') or 1.0
            if conf < 0.8:
                continue
            try:
                geom = shapely.from_wkb(g)
            except Exception:
                continue
            for q in as_polys(geom):
                try:
                    c = np.asarray(q.exterior.coords)
                    p = Polygon(proj(c), [proj(np.asarray(r.coords)) for r in q.interiors if len(r.coords) >= 4])
                except Exception:
                    continue
                if not p.is_valid:
                    p = p.buffer(0)
                for pp in as_polys(p):
                    if pp.area >= 12:
                        tags = {}
                        if h:
                            tags['height'] = str(h)
                        if n:
                            tags['building:levels'] = str(n)
                        out.append(dict(src='ml', id=f'ov{i[:12]}', oid=None, poly=pp, tags=tags, part=False, conf=conf))
    return out


def load_admin():
    raw = json.load(open(os.path.join(CACHE, 'osm_admin.json')))
    out = {6: ([], []), 8: ([], [])}
    for a in raw:
        polys = []
        for r in a['rings']:
            try:
                polys.append(Polygon(proj(r['outer']), [proj(x) for x in r['inner'] if len(x) >= 4]).buffer(0))
            except Exception:
                pass
        if polys:
            out[a['level']][0].append(unary_union(polys))
            out[a['level']][1].append(a.get('name') or a['id'])
    return out


def load_landuse():
    raw = json.load(open(os.path.join(CACHE, 'osm_landcover.json')))
    polys, kinds = [], []
    for b in raw:
        t = b['tags']
        k = t.get('landuse')
        if k not in ('industrial', 'commercial', 'retail', 'residential', 'railway', 'port', 'military', 'construction',
                     'education', 'religious', 'institutional', 'farmyard', 'allotments', 'garages'):
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


MAIN_ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link',
              'secondary_link', 'tertiary_link'}


def load_roads():
    raw = json.load(open(os.path.join(CACHE, 'osm_roads.json')))
    lines, kinds = [], []
    for r in raw:
        hw = r.get('highway')
        if not hw or hw in ('service', 'motorway', 'motorway_link'):
            continue
        pts = proj(r['pts'])
        if len(pts) >= 2:
            lines.append(LineString(pts))
            kinds.append(hw)
    return lines, kinds


# ------------------------------------------------------------------------------------------------------ exclusions
# Fallback when the landmarks agent has not published its data yet (CONTRACTS-IST §4): the landmarks named in the
# brief, by OSM id (buildings) or area (palace grounds / fortress / mosque complexes: every generic footprint whose
# centroid is inside is dropped).
LANDMARK_IDS = {
    'w23236783',     # Galata Kulesi
    'w109862851',    # Ayasofya
    'r18055570',     # Sultanahmet Camii
    'r1564032',      # Süleymaniye Camii
    'r7534888',      # Büyük Çamlıca Camii
    'r7318154',      # Rumeli Hisarı
    'w673790538',    # İstanbul Sapphire
    'w263949137', 'w263949162', 'w175516451', 'w263956600', 'w914394417', 'w263949143', 'w1423624915',
    'w1271934199',   # Dolmabahçe Sarayı (Harem, Muayede, Selamlık, Hazine, Saat Kulesi, gates)
}
LANDMARK_AREAS = [   # (name, lon, lat, radius m)
    ('Topkapı Sarayı', 28.98340, 41.01160, 260.0),
    ('Sultanahmet Camii', 28.97680, 41.00540, 110.0),
    ('Ayasofya', 28.98010, 41.00850, 70.0),
    ('Süleymaniye Camii', 28.96400, 41.01610, 90.0),
    ('Dolmabahçe Sarayı', 29.00030, 41.03910, 200.0),
    ('Rumeli Hisarı', 29.05630, 41.08460, 150.0),
    ('Büyük Çamlıca Camii', 29.06920, 41.02720, 120.0),
    ('Kız Kulesi', 29.00410, 41.02110, 40.0),
    ('Galata Kulesi', 28.97410, 41.02560, 12.0),
]


def load_landmark_exclusions():
    """(ids, polygons, from_agent): the landmarks agent's data/ist/landmarks-exclude.json (CONTRACTS-IST §6.L: OSM ids of
    buildings / building:parts / minarets + zones whose footprints must not be generic buildings) and the bounds of its
    published models (assets/ist/landmarks/index.json); the fixed list above only when that file does not exist yet."""
    ids, polys = set(), []
    path = os.path.join(DATA_DIR, 'landmarks-exclude.json')
    have = os.path.exists(path)
    if have:
        js = json.load(open(path))
        ids.update(str(k) for k in js.get('osmIds', []))
        for l in js.get('landmarks', {}).values():
            ids.update(str(k) for k in l.get('osmIds', []))
            for ring in l.get('zones', []):
                if len(ring) >= 3:
                    polys.append(Polygon(ring).buffer(0))
    lm_path = os.path.join(DATA_DIR, 'landmarks.json')
    if os.path.exists(lm_path):
        for l in json.load(open(lm_path)).get('landmarks', []):
            if l.get('excludeRadius', 0) > 0 and 'x' in l:
                polys.append(Point(l['x'], l['z']).buffer(l['excludeRadius'], 24))
    idx = os.path.join(ROOT, 'assets', 'ist', 'landmarks', 'index.json')
    if os.path.exists(idx):
        for l in json.load(open(idx)).get('landmarks', []):
            if 'bounds' not in l or l.get('kind') in ('bridge',) or 'origin' not in l:
                continue
            (x0, _, z0), (x1, _, z1) = l['bounds']['min'], l['bounds']['max']
            h = l.get('heading', 0.0)
            ch, sh = math.cos(h), math.sin(h)
            ox, oz = l['origin']['x'], l['origin']['z']
            pts = [(ox + lx * ch - lz * sh, oz + lx * sh + lz * ch) for lx, lz in ((x0, z0), (x1, z0), (x1, z1), (x0, z1))]
            if Polygon(pts).area < 250000:           # model bounds (bridges / big sites are listed by zones instead)
                polys.append(Polygon(pts).buffer(3.0))
    if not have:
        ids |= LANDMARK_IDS
        for name, lon, lat, r in LANDMARK_AREAS:
            x, z = proj([[lon, lat]])[0]
            polys.append(Point(x, z).buffer(r, 24))
    return ids, polys, have


def load_airport_exclusions():
    """assets/ist/airports/exclusions.json (airports_build.py): OSM ids it models itself + airside zones; runway strips."""
    path = os.path.join(ROOT, 'assets', 'ist', 'airports', 'exclusions.json')
    ids, zones = set(), []
    if os.path.exists(path):
        for apt in json.load(open(path)).get('airports', {}).values():
            ids.update(apt.get('osmIds', []))
            for z in apt.get('zones', []):
                if len(z) >= 3:
                    zones.append(Polygon(z).buffer(0))
    rw = os.path.join(DATA_DIR, 'runways.json')
    if os.path.exists(rw):
        for apt in json.load(open(rw))['airports']:
            for r in apt['runways']:
                a, b = r['ends']
                zones.append(LineString([(a['x'], a['z']), (b['x'], b['z'])]).buffer(r['width'] / 2 + 120, cap_style=2))
    return ids, zones


# ------------------------------------------------------------------------------------------------------------ heights
# District priors: median storeys of an ordinary 80-400 m2 building and the spread (storeys), from the OSM-tagged
# share (Güngören 96 %, Bahçelievler 70 %, Zeytinburnu 74 %, Kartal 38 % ...) and the known urban form elsewhere.
DISTRICT = {
    'Adalar': (2, 0.8), 'Arnavutköy': (2, 1.0), 'Ataşehir': (6, 2.5), 'Avcılar': (5, 1.4), 'Bahçelievler': (6, 1.0),
    'Bakırköy': (6, 1.8), 'Bayrampaşa': (4, 1.3), 'Bağcılar': (5, 1.2), 'Başakşehir': (6, 3.0), 'Beykoz': (3, 1.2),
    'Beylikdüzü': (7, 3.0), 'Beyoğlu': (5, 1.4), 'Beşiktaş': (5, 1.8), 'Büyükçekmece': (4, 2.0), 'Esenler': (5, 1.2),
    'Esenyurt': (6, 3.0), 'Eyüpsultan': (4, 1.3), 'Fatih': (5, 1.2), 'Gaziosmanpaşa': (4, 1.3), 'Gebze': (4, 1.5),
    'Güngören': (6, 1.0), 'Kadıköy': (7, 2.3), 'Kartal': (6, 2.2), 'Kâğıthane': (5, 1.5), 'Küçükçekmece': (5, 1.5),
    'Maltepe': (6, 2.0), 'Pendik': (5, 2.0), 'Sancaktepe': (4, 1.5), 'Sarıyer': (4, 1.8), 'Sultanbeyli': (4, 1.3),
    'Sultangazi': (4, 1.3), 'Tuzla': (4, 1.5), 'Zeytinburnu': (5, 1.2), 'Çayırova': (5, 2.0), 'Çekmeköy': (4, 1.5),
    'Ümraniye': (5, 1.8), 'Üsküdar': (4, 1.5), 'Şile': (2, 0.8), 'Şişli': (6, 1.8),
}
# local overrides (lon, lat, radius m, (median, spread)): historic cores and business districts
# historic peninsula (walled city, conservation areas: mostly 2-5 storeys): priors that also cap every estimate, and
# around the landmark mosques a cap on tagged heights too, so the generic city never hides them from low angles
HISTORIC = [   # (name, lon, lat, radius m, (median, spread), cap storeys for estimates)
    ('Sultanahmet / Cankurtaran / Kumkapı', 28.9755, 41.0050, 900, (3, 0.9), 5),
    ('Eminönü / Tahtakale', 28.9700, 41.0160, 520, (4, 0.9), 5),
    ('Süleymaniye / Vefa / Zeyrek', 28.9600, 41.0185, 750, (3, 0.9), 5),
    ('Beyazıt / Kapalıçarşı / Laleli', 28.9630, 41.0100, 650, (4, 1.0), 5),
    ('Fener / Balat / Ayvansaray', 28.9460, 41.0320, 900, (3, 0.9), 4),
    ('Fatih / Çarşamba / Karagümrük', 28.9420, 41.0230, 900, (4, 1.0), 5),
]
MOSQUE_CAPS = [   # landmark mosques: every generic building within the radius is capped (storeys, tags included)
    ('Sultanahmet Camii', 28.9769, 41.0053, 320, 4), ('Ayasofya', 28.9800, 41.0085, 280, 4),
    ('Süleymaniye Camii', 28.9640, 41.0160, 350, 3), ('Yeni Cami', 28.9722, 41.0169, 250, 5),
]
ZONES = [
    ('Fener / Balat', 28.9480, 41.0310, 700, (3, 1.0)),
    ('Galata / Karaköy', 28.9750, 41.0250, 450, (5, 1.2)),
    ('Cihangir / Taksim', 28.9830, 41.0330, 700, (6, 1.3)),
    ('Levent / Maslak CBD', 29.0130, 41.0850, 1300, (9, 5.0)),
    ('Ataşehir finans merkezi', 29.1150, 40.9900, 1300, (10, 5.0)),
    ('Mecidiyeköy / Esentepe', 29.0000, 41.0680, 1000, (8, 3.0)),
    ('Moda / Bağdat', 29.0600, 40.9700, 3000, (7, 2.0)),
    ('Boğaz köyleri (Bebek, Yeniköy, Tarabya)', 29.0550, 41.1100, 3500, (3, 1.0)),
    ('Adalar', 29.1100, 40.8700, 5000, (2, 0.8)),
]
AREA_CLASS = [0, 60, 150, 400, 1200, 1e12]
EST_CAP = [3, 8, 14, 20, 24]      # storeys an estimate may reach per footprint class (tall ones come from tags)


def area_class(a):
    for k in range(len(AREA_CLASS) - 1):
        if a < AREA_CLASS[k + 1]:
            return k
    return len(AREA_CLASS) - 2


def sample_normal(key, mu, sd):
    # deterministic Box-Muller from two hashes
    u1 = max(1e-6, rnd01(key, 'n1'))
    u2 = rnd01(key, 'n2')
    return mu + sd * math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def tagged_height(t):
    """(height to the roof / eave, min_height, known) from OSM / Overture tags."""
    h = parse_len(t.get('height'))
    mh = parse_len(t.get('min_height')) or 0.0
    lv = parse_levels(t.get('building:levels'))
    if h is not None and h > 1.5:
        if lv and h < lv * 2.2:            # inconsistent (e.g. height = storey height): trust the levels
            h = lv * FLOOR + 0.8
        return h, mh, True
    if lv is not None:
        mlv = parse_levels(t.get('building:min_level')) or 0.0
        return lv * FLOOR + (0.8 if lv > 1 else 0.4), max(mh, mlv * FLOOR), True
    return None, mh, False


SMALL_BT = {'garage', 'garages', 'carport', 'shed', 'roof', 'hut', 'kiosk', 'container', 'toilets', 'cabin', 'service',
            'greenhouse', 'barn', 'stable', 'transformer_tower', 'bunker', 'guardhouse', 'gatehouse', 'shelter', 'boathouse'}
IND_BT = {'industrial', 'warehouse', 'hangar', 'manufacture', 'factory', 'storage_tank', 'silo', 'depot'}
COM_BT = {'commercial', 'retail', 'supermarket', 'office', 'hotel', 'mixed_use', 'mall', 'shop'}
CIVIC_BT = {'school', 'university', 'college', 'hospital', 'public', 'civic', 'government', 'kindergarten', 'train_station',
            'transportation', 'stadium', 'sports_hall', 'sports_centre', 'fire_station', 'police', 'courthouse', 'museum',
            'dormitory', 'library', 'clinic'}
WORSHIP_BT = {'church', 'chapel', 'synagogue', 'cathedral', 'temple', 'monastery', 'religious'}


def estimate_levels(b, emp):
    """Storeys of an untagged building: neighbourhood empirical distribution, else district / zone priors."""
    key = b['id']
    A = b['area']
    ac = area_class(A)
    bt = b['tags'].get('building', 'yes')
    lu = b.get('lu')
    if bt in SMALL_BT or A < 30:
        return 1
    if bt in IND_BT or lu in ('industrial', 'port', 'railway', 'depot'):
        return None      # single tall storey, handled by the caller
    hist = None
    for (name, x, z, r, prior, cap) in HISTORIC_LOCAL:
        if (b['cx'] - x) ** 2 + (b['cz'] - z) ** 2 < r * r:
            hist = (prior, cap)
            break
    if hist is None:
        samples = emp.get((b.get('mh'), ac))
        if samples is not None and len(samples) >= 40 and ac >= 1:
            v = samples[h32(f'{key}|emp') % len(samples)]
            return int(min(EST_CAP[ac], max(1, round(v))))
    mu, sd = DISTRICT.get(b.get('district'), (4, 1.5))
    if hist is not None:
        (mu, sd), cap = hist
        lv = sample_normal(key, mu - (0.6 if ac <= 1 else 0.0), sd)
        return int(min(cap, EST_CAP[ac], max(1, round(lv))))
    for (name, x, z, r, prior) in ZONES_LOCAL:
        if (b['cx'] - x) ** 2 + (b['cz'] - z) ** 2 < r * r:
            mu, sd = prior
            break
    if ac == 0:           # < 60 m2: small houses / annexes
        mu, sd = min(mu, 2), 0.7
    elif ac == 1:         # 60-150: older apartments / houses, a little lower than the district median
        mu = max(1.5, mu - 0.8)
    elif ac == 3:         # 400-1200: larger apartment blocks
        mu = mu + 1.5
        sd = sd * 1.3
    elif ac == 4:         # >= 1200: residential blocks (TOKİ) or big commercial / civic
        mu, sd = (mu + 3, sd * 1.3) if lu == 'residential' or bt in ('apartments', 'residential') else (3, 1.2)
    if bt in ('house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'villa'):
        mu, sd = 2, 0.6
    elif bt in COM_BT:
        mu = max(2, mu - 1)
    elif bt in CIVIC_BT:
        mu, sd = 4, 1.2
    elif bt in WORSHIP_BT:
        return 3
    lv = sample_normal(key, mu, sd)
    return int(min(EST_CAP[ac], max(1, round(lv))))


ZONES_LOCAL = []
HISTORIC_LOCAL = []
MOSQUE_CAPS_LOCAL = []


def mosque_cap(b):
    for (name, x, z, r, cap) in MOSQUE_CAPS_LOCAL:
        if (b['cx'] - x) ** 2 + (b['cz'] - z) ** 2 < r * r:
            return cap
    return None


def building_height(b, emp):
    """Sets b['H'] (eave / roof top), b['base'], b['known'], b['levels']."""
    t = b['tags']
    h, mh, known = tagged_height(t)
    b['base'] = mh if mh and mh < (h or 0) - 2 else 0.0
    cap = mosque_cap(b)
    if known:
        if cap is not None and h > cap * FLOOR + 0.8:
            h = cap * FLOOR + 0.8
        b['H'], b['known'] = h, True
        b['levels'] = max(1, int(round((h - 0.8) / FLOOR)))
        return
    b['known'] = False
    lv = estimate_levels(b, emp)
    if lv is None:     # industrial: one high storey (6-14 m by size)
        A = b['area']
        r = rnd01(b['id'], 'ih')
        h = (4.5 + 2 * r) if A < 300 else (7 + 4 * r) if A < 3000 else (10 + 5 * r)
        b['H'], b['levels'] = h, 1
        return
    if cap is not None:
        lv = min(lv, cap)
    b['levels'] = lv
    b['H'] = lv * FLOOR + (0.8 if lv > 1 else 0.3) + 0.3 * rnd01(b['id'], 'hj')


# ------------------------------------------------------------------------------------------------------------ styles
def pal(*cols):
    return [tuple(c) for c in cols]


# tint multipliers on the atlas facade / roof cells (the San Francisco atlas, re-coloured for İstanbul)
PAL = {
    # plastered apartment blocks: cream, beige, off-white, pale yellow, salmon, peach, pale pink, light grey, pale green
    'apt': pal((1, 0.95, 0.84), (0.97, 0.9, 0.78), (1, 1, 1), (1, 0.94, 0.72), (1, 0.83, 0.72), (1, 0.88, 0.7),
               (1, 0.86, 0.84), (0.9, 0.9, 0.9), (0.88, 0.95, 0.84), (0.96, 0.8, 0.66), (0.86, 0.9, 0.96), (0.95, 0.92, 0.88),
               (0.92, 0.78, 0.7), (1, 0.97, 0.9)),
    # newer blocks: white, greys, anthracite accents, beige
    'new': pal((1, 1, 1), (0.92, 0.92, 0.92), (0.82, 0.82, 0.84), (0.7, 0.7, 0.72), (0.96, 0.93, 0.86), (0.9, 0.86, 0.8)),
    # historic peninsula / Beyoğlu: stone, ochre, faded pastels, oxblood wooden houses
    'hist': pal((0.98, 0.9, 0.76), (0.95, 0.86, 0.72), (0.9, 0.8, 0.7), (0.86, 0.76, 0.66), (1, 0.95, 0.86), (0.86, 0.62, 0.52),
                (0.78, 0.82, 0.86), (0.94, 0.84, 0.66), (0.8, 0.72, 0.62)),
    'house': pal((1, 1, 1), (1, 0.95, 0.84), (0.97, 0.9, 0.78), (1, 0.9, 0.75), (0.92, 0.86, 0.8), (0.88, 0.9, 0.86)),
    'industrial': pal((0.95, 0.95, 0.94), (0.9, 0.87, 0.8), (0.72, 0.78, 0.84), (0.84, 0.84, 0.84), (0.93, 0.88, 0.76),
                      (0.7, 0.72, 0.7), (0.66, 0.74, 0.82)),
    'neutral': pal((1, 1, 1), (0.95, 0.95, 0.94), (0.92, 0.93, 0.95), (0.97, 0.95, 0.92), (0.9, 0.9, 0.9)),
    'mosque': pal((0.98, 0.96, 0.9), (1, 1, 1), (0.95, 0.92, 0.85), (0.92, 0.9, 0.86)),
    'roof_tile': pal((1, 1, 1), (0.95, 0.86, 0.8), (1, 0.92, 0.8), (0.88, 0.74, 0.66), (0.92, 0.8, 0.72), (0.8, 0.66, 0.6)),
    'roof_flat': pal((1, 1, 1), (0.9, 0.9, 0.9), (0.8, 0.8, 0.8), (1.0, 0.96, 0.9), (0.85, 0.87, 0.9), (0.72, 0.72, 0.72),
                     (0.95, 0.9, 0.82)),
    'roof_metal': pal((1, 1, 1), (0.85, 0.85, 0.85), (0.75, 0.82, 0.88), (0.9, 0.85, 0.78), (0.7, 0.7, 0.72), (0.62, 0.7, 0.8)),
    'lead': pal((0.52, 0.54, 0.56), (0.48, 0.5, 0.53), (0.56, 0.57, 0.58)),
}
HIST_DISTRICTS = {'Fatih', 'Beyoğlu'}
CENTRAL = {'Fatih', 'Beyoğlu', 'Şişli', 'Beşiktaş', 'Kadıköy', 'Üsküdar', 'Bakırköy'}


def choose(key, options):
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
    key = b['id']
    H, A, t = b['H'], b['area'], b['tags']
    bt = t.get('building', 'yes')
    lu, d = b.get('lu'), b.get('district')
    industrial = lu in ('industrial', 'port', 'railway') or bt in IND_BT
    commercial = lu in ('commercial', 'retail') or bt in COM_BT
    hist = d in HIST_DISTRICTS
    ground, side = -1, 'blank_stucco'
    if b.get('mosque'):
        style = 'civic_stone' if (A > 500 or rnd01(key, 'ms') < 0.4) else 'blank_stucco'
        pal_, side = 'mosque', style
    elif bt in SMALL_BT or (A < 30 and H < 4.5):
        style, pal_ = 'blank_stucco', 'neutral'
    elif bt in ('parking',) or t.get('amenity') == 'parking':
        style, pal_ = 'parking', 'neutral'
    elif H >= 45:
        if bt in ('apartments', 'residential') or (lu == 'residential' and not commercial):
            style = choose(key, [('highrise_res', 5), ('modern_midrise', 2), ('glass_blue', 1), ('apartment_stucco', 1)])
            pal_ = 'new'
        else:
            style = choose(key, [('glass_blue', 4), ('glass_dark', 1), ('glass_green', 2), ('office_concrete', 3),
                                 ('office_granite', 2), ('office_stone', 1)])
            pal_ = 'neutral'
        ground = LAYER['gf_lobby']
    elif industrial:
        style = choose(key, [('industrial_metal', 5), ('industrial_concrete', 4), ('brick_warehouse', 0.5)])
        pal_ = 'industrial'
        ground = LAYER['gf_warehouse'] if H > 6 and rnd01(key, 'gw') < 0.5 else -1
        side = style
    elif bt in WORSHIP_BT:
        style, pal_ = 'civic_stone', 'hist'
    elif bt in CIVIC_BT:
        style = choose(key, [('civic_stone', 2), ('office_concrete', 3), ('modern_midrise', 2), ('apartment_stucco', 1)])
        pal_ = 'neutral'
    elif H >= 22:
        if commercial:
            style = choose(key, [('office_concrete', 3), ('glass_blue', 1), ('modern_midrise', 3), ('office_granite', 1)])
            pal_ = 'neutral'
            ground = LAYER['gf_storefront'] if rnd01(key, 'g') < 0.6 else LAYER['gf_lobby']
        else:
            style = choose(key, [('highrise_res', 3), ('modern_midrise', 4), ('apartment_stucco', 4)])
            pal_ = 'new' if style != 'apartment_stucco' else 'apt'
    elif H >= 7.5:          # 2-6 storey apartments: İstanbul's fabric
        if hist:
            style = choose(key, [('apartment_stucco', 5), ('apartment_brick', 1.5), ('civic_stone', 1), ('office_stone', 1)])
            pal_ = 'hist'
        elif commercial:
            style = choose(key, [('modern_midrise', 3), ('apartment_stucco', 3), ('office_concrete', 2), ('blank_stucco', 1)])
            pal_ = 'apt'
        else:
            style = choose(key, [('apartment_stucco', 8), ('modern_midrise', 2), ('apartment_brick', 0.6), ('highrise_res', 0.6)])
            pal_ = 'apt' if style != 'modern_midrise' else 'new'
    else:                   # 1-2 storey houses, shops, annexes
        if commercial:
            style, pal_ = 'blank_stucco', 'apt'
            ground = LAYER['gf_storefront']
        else:
            style = choose(key, [('sunset_house', 3), ('apartment_stucco', 3), ('blank_stucco', 1)])
            pal_ = 'house'
    b['style'] = LAYER[style]
    b['ground'] = ground
    b['side'] = LAYER[side if style not in ('brick_warehouse', 'apartment_brick', 'civic_stone') else 'blank_brick']
    b['rear'] = b['style'] if style not in ('sunset_house',) else LAYER['rear_stucco']
    b['tint'] = tint_of(key, pal_)
    # roofs
    rt = b['roof']['t']
    if rt != 'flat':
        if industrial:
            b['roofstyle'], rp = LAYER['roof_metal'], 'roof_metal'
        else:
            b['roofstyle'], rp = LAYER['roof_tile'], 'roof_tile'
    else:
        if industrial:
            b['roofstyle'] = choose(key + 'r', [(LAYER['roof_metal'], 4), (LAYER['roof_membrane'], 2), (LAYER['roof_gravel'], 2)])
        elif H >= 30 or commercial:
            b['roofstyle'] = choose(key + 'r', [(LAYER['roof_membrane'], 2), (LAYER['roof_gravel'], 3), (LAYER['roof_concrete'], 3)])
        else:
            b['roofstyle'] = choose(key + 'r', [(LAYER['roof_concrete'], 4), (LAYER['roof_gravel'], 3), (LAYER['roof_tar'], 2),
                                                (LAYER['roof_membrane'], 1)])
        rp = 'roof_metal' if b['roofstyle'] == LAYER['roof_metal'] else 'roof_flat'
    b['rtint'] = tint_of(key + 'roof', rp, 0.06)


# -------------------------------------------------------------------------------------------------------- roof shape
def roof_shape(b, rect_info):
    """Hipped tile roofs (İstanbul's apartment blocks and houses), gabled for small annexes; flat otherwise."""
    rect, c, l0, l1, fill = rect_info
    b['roof'] = {'t': 'flat'}
    t = b['tags']
    shape = t.get('roof:shape')
    H, A = b['H'], b['area']
    bt = t.get('building', 'yes')
    if b.get('mosque') or b.get('base', 0) > 0.5:
        return
    if shape in ('flat',):
        return
    if A < 25 or A > 900 or H > 30 or fill < 0.8:
        return
    short = min(l0, l1)
    if shape in ('gabled', 'hipped', 'pyramidal', 'half-hipped', 'gambrel', 'mansard', 'skillion', 'round'):
        kind = 'gable' if shape in ('gabled', 'gambrel', 'skillion') else 'hip'
    else:
        if bt in IND_BT or bt in COM_BT or bt in CIVIC_BT or bt in ('parking', 'roof', 'garages', 'greenhouse') \
                or b.get('lu') in ('industrial', 'commercial', 'retail', 'port'):
            return
        lv = b.get('levels', 3)
        # share of pitched roofs: houses most, 2-6 storey apartments often (kırma çatı), newer / taller blocks rarely
        p = 0.75 if lv <= 2 else 0.6 if lv <= 5 else 0.4 if lv <= 7 else 0.15
        if b.get('district') in ('Esenyurt', 'Başakşehir', 'Beylikdüzü', 'Ataşehir') and lv >= 6:
            p *= 0.5
        if rnd01(b['id'], 'rf') >= p:
            return
        kind = 'hip' if (A > 90 or rnd01(b['id'], 'hip') < 0.7) else 'gable'
    rise = parse_len(t.get('roof:height')) or min(0.32 * short, 3.4)
    if rise < 0.8:
        return
    b['roof'] = {'t': kind, 'rise': round(float(rise), 2), 'rect': [[round(float(x), 3), round(float(y), 3)] for x, y in c]}
    b['poly'] = Polygon(c)
    b['area'] = b['poly'].area


# ------------------------------------------------------------------------------------------------------------ mosques
def is_mosque_tags(t):
    return t.get('building') == 'mosque' or (t.get('amenity') == 'place_of_worship' and t.get('religion') == 'muslim') \
        or (t.get('religion') == 'muslim' and t.get('building') in ('religious', 'yes', 'church'))


def mosque_parts(b, rect_info, minaret_pts):
    """Dome on a drum + minarets for a generic mosque. Returns the record {'d': [...], 'm': [[x, z, r, h], ...]}."""
    rect, c, l0, l1, fill = rect_info
    A = b['area']
    short, long_ = min(l0, l1), max(l0, l1)
    cx, cz = rect.centroid.x, rect.centroid.y
    if not b['p0'].contains(Point(cx, cz)):
        pc = b['p0'].representative_point()
        cx, cz = pc.x, pc.y
    r = float(np.clip(0.36 * short, 2.2, 16.0))
    drum = round(0.22 * r, 2)
    rise = round(0.85 * r, 2)
    t = b['tags']
    hall = float(np.clip(3.2 + 0.26 * short, 4.5, 15.0))
    known_h = parse_len(t.get('height'))
    if known_h and known_h > hall + 2:
        hall = max(4.5, known_h - drum - rise)
    b['H'] = round(hall, 2)
    b['levels'] = 1
    n_min = 1 if A < 500 else 2 if A < 2000 else 4
    mh = 22.0 if A < 200 else 30.0 if A < 500 else 42.0 if A < 2000 else 56.0
    mh *= 0.9 + 0.2 * rnd01(b['id'], 'mh')
    mr = 1.1 if A < 200 else 1.4 if A < 500 else 1.8 if A < 2000 else 2.2
    mins = []
    # mapped minarets near this mosque first
    near = [p for p in minaret_pts if (p[0] - cx) ** 2 + (p[1] - cz) ** 2 < (long_ / 2 + 25) ** 2]
    for p in near[:6]:
        h = p[2] or mh
        mins.append([round(p[0], 2), round(p[1], 2), round(mr, 2), round(float(h), 1)])
    if not mins:
        q = math.radians(QIBLA - 1.2)          # grid bearing
        qd = np.array([math.sin(q), -math.cos(q)])
        corners = np.asarray(c)
        order = np.argsort(corners @ qd)       # smallest = farthest from the qibla wall (entrance side)
        cen = np.array([cx, cz])
        pick = list(order[:2]) if n_min >= 2 else [order[0] if rnd01(b['id'], 'mc') < 0.5 else order[1]]
        if n_min >= 4:
            pick = list(order)
        for k in pick:
            v = corners[k] - cen
            n = np.linalg.norm(v) or 1.0
            p = corners[k] + v / n * mr * 0.6
            mins.append([round(float(p[0]), 2), round(float(p[1]), 2), round(mr, 2), round(float(mh), 1)])
    return {'d': [round(cx, 2), round(cz, 2), round(r, 2), round(hall, 2), drum, rise], 'm': mins}


# --------------------------------------------------------------------------------------------------------- helpers
def clean_poly(p, tol):
    q = p.simplify(tol, preserve_topology=True)
    if q.is_empty or not q.is_valid or q.area < 4:
        q = p
    if isinstance(q, MultiPolygon):
        q = max(q.geoms, key=lambda g: g.area)
    return shapely.geometry.polygon.orient(q, 1.0)


def ring_list(r):
    c = np.asarray(r.coords)[:-1]
    return [[round(float(x), 2), round(float(y), 2)] for x, y in c]


def min_rect_info(polys):
    """Vectorised minimum rotated rectangles: list of (rect, corners(4,2), l0, l1, fill)."""
    rects = shapely.minimum_rotated_rectangle(np.array(polys, dtype=object))
    out = []
    for p, r in zip(polys, rects):
        if r is None or r.is_empty or not isinstance(r, Polygon):
            out.append((p, np.asarray(p.exterior.coords)[:4], 1.0, 1.0, 0.0))
            continue
        c = np.asarray(r.exterior.coords)[:4]
        l0 = float(np.hypot(*(c[1] - c[0])))
        l1 = float(np.hypot(*(c[2] - c[1])))
        out.append((r, c, l0, l1, p.area / r.area if r.area > 0 else 0.0))
    return out


# ------------------------------------------------------------------------------------------------------------- main
def main():
    t0 = time.time()
    only = None
    if '--only' in sys.argv:
        only = tuple(int(v) for v in sys.argv[sys.argv.index('--only') + 1].split(','))
    os.makedirs(TILES, exist_ok=True)
    os.makedirs(OBST, exist_ok=True)
    say = lambda *a: print(*a, f'({time.time() - t0:.0f} s)', flush=True)
    osm = load_osm()
    say(f'  {len(osm)} OSM polygons')
    ml = load_overture_ml()
    say(f'  {len(ml)} Overture ML footprints (conf >= 0.8)')
    osm_b = [o for o in osm if not o['part']]
    parts = [o for o in osm if o['part']]
    tree = STRtree([o['poly'] for o in osm_b])
    mlp = np.array([m['poly'] for m in ml], dtype=object)
    inside = np.zeros(len(ml), bool)
    inside[tree.query(shapely.point_on_surface(mlp), predicate='intersects')[0]] = True
    ov = np.zeros(len(ml))
    for mi, oi in zip(*tree.query(mlp, predicate='intersects')):
        if not inside[mi]:
            ov[mi] += ml[mi]['poly'].intersection(osm_b[oi]['poly']).area
    ml = [m for k, m in enumerate(ml) if not inside[k] and ov[k] < 0.2 * m['poly'].area]
    say(f'  {len(ml)} ML footprints kept (no OSM overlap)')
    buildings = osm_b + ml

    # ---- tall towers: OSM building:part setbacks replace the outline where they cover it (like San Francisco)
    part_tree = STRtree([p['poly'] for p in parts]) if parts else None
    replaced, extra = set(), []
    if part_tree is not None:
        for bi, b in enumerate(buildings):
            if b['src'] != 'osm':
                continue
            h, _, known = tagged_height(b['tags'])
            if not known or h < 35 or is_mosque_tags(b['tags']):
                continue
            idx = part_tree.query(b['poly'].buffer(2.0), predicate='contains')
            ps = [parts[i] for i in idx if parse_len(parts[i]['tags'].get('height')) or parse_levels(parts[i]['tags'].get('building:levels'))]
            if not ps:
                continue
            if unary_union([p['poly'] for p in ps]).area < 0.6 * b['poly'].area:
                continue
            replaced.add(bi)
            for p in ps:
                q = dict(b)
                # the part's own height / levels only (the outline's 'height' is the tallest part's)
                base_tags = {k: v for k, v in b['tags'].items() if k not in ('height', 'min_height', 'building:levels',
                                                                             'building:min_level', 'roof:height')}
                q.update(poly=p['poly'], id=f"{b['id']}_p{p['id']}", tags=dict(base_tags, **p['tags']),
                         anchor=b['poly'].centroid)
                extra.append(q)
    buildings = [b for i, b in enumerate(buildings) if i not in replaced] + extra
    say(f'  {len(replaced)} towers from {len(extra)} OSM building parts -> {len(buildings)} buildings')

    # ---- exclusions: landmarks (landmarks agent / fixed list), airports (airports_build.py) + runway strips
    lm_ids, lm_polys, have_lm = load_landmark_exclusions()
    apt_ids, apt_zones = load_airport_exclusions()
    drop = set()
    for i, b in enumerate(buildings):
        if b['oid'] and (b['oid'] in lm_ids or b['oid'] in apt_ids):
            drop.add(i)
    cents = shapely.centroid(np.array([b['poly'] for b in buildings], dtype=object))
    zones = lm_polys + apt_zones
    if zones:
        drop.update(STRtree(zones).query(cents, predicate='intersects')[0].tolist())
    n_lm = len(drop)
    buildings = [b for i, b in enumerate(buildings) if i not in drop]
    cents = np.array([c for i, c in enumerate(cents) if i not in drop], dtype=object)
    say(f'  excluded {n_lm} (landmarks{"" if have_lm else " (fixed list only)"} / airports) -> {len(buildings)}')

    # ---- attributes
    adm = load_admin()
    d_tree, m_tree = STRtree(adm[6][0]), STRtree(adm[8][0])
    dist = np.full(len(buildings), -1)
    q = d_tree.query(cents, predicate='intersects')
    dist[q[0]] = q[1]
    mahalle = np.full(len(buildings), -1)
    q = m_tree.query(cents, predicate='intersects')
    mahalle[q[0]] = q[1]
    lu_polys, lu_kinds = load_landuse()
    lu_of = {}
    for pi, li in zip(*STRtree(lu_polys).query(cents, predicate='intersects')):
        k = lu_kinds[li]
        if pi not in lu_of or k in ('industrial', 'port', 'commercial', 'retail'):
            lu_of[pi] = k
    global ZONES_LOCAL
    ZONES_LOCAL = [(n, *proj([[lon, lat]])[0], r, prior) for (n, lon, lat, r, prior) in ZONES]
    HISTORIC_LOCAL[:] = [(n, *proj([[lon, lat]])[0], r, prior, cap) for (n, lon, lat, r, prior, cap) in HISTORIC]
    MOSQUE_CAPS_LOCAL[:] = [(n, *proj([[lon, lat]])[0], r, cap) for (n, lon, lat, r, cap) in MOSQUE_CAPS]
    xy = shapely.get_coordinates(cents)
    areas = shapely.area(np.array([b['poly'] for b in buildings], dtype=object))
    for i, b in enumerate(buildings):
        b['cx'], b['cz'] = float(xy[i, 0]), float(xy[i, 1])
        b['area'] = float(areas[i])
        b['district'] = adm[6][1][dist[i]] if dist[i] >= 0 else None
        b['mh'] = int(mahalle[i])
        b['lu'] = lu_of.get(i)
    # mosques: tags, or a place_of_worship (muslim) point inside the footprint
    wp = [w for w in json.load(open(os.path.join(CACHE, 'osm_worship.json'))) if w.get('religion') == 'muslim']
    if wp:
        pts = shapely.points(proj([[w['lon'], w['lat']] for w in wp]))
        btree = STRtree([b['poly'] for b in buildings])
        for pi, bi in zip(*btree.query(pts, predicate='intersects')):
            if buildings[bi]['area'] > 40:
                buildings[bi]['mosque'] = True
    for b in buildings:
        if b['src'] == 'osm' and is_mosque_tags(b['tags']) and b['area'] >= 25:
            b['mosque'] = True
    minaret_pts = []
    for m in json.load(open(os.path.join(CACHE, 'osm_minarets.json'))):
        if m['id'] in lm_ids:
            continue
        x, z = proj([[m['lon'], m['lat']]])[0]
        minaret_pts.append((float(x), float(z), parse_len(m.get('height'))))
    say(f'  {sum(1 for b in buildings if b.get("mosque"))} mosques, {len(minaret_pts)} mapped minarets')

    # ---- heights: tagged first, then the per-neighbourhood empirical distribution of the tagged ones
    for b in buildings:
        h, mh, known = tagged_height(b['tags'])
        b['known'] = known
    emp = defaultdict(list)
    for b in buildings:
        if b['known'] and b['mh'] >= 0 and not b.get('mosque'):
            lv = parse_levels(b['tags'].get('building:levels'))
            if lv is None:
                lv = (tagged_height(b['tags'])[0] - 0.8) / FLOOR
            if 0.5 <= lv <= 60:
                emp[(b['mh'], area_class(b['area']))].append(lv)
    emp = {k: sorted(v) for k, v in emp.items()}
    for b in buildings:
        building_height(b, emp)
    say(f'  heights: {sum(b["known"] for b in buildings)} tagged, {len(buildings) - sum(b["known"] for b in buildings)} estimated')

    # ---- footprints, roofs, mosques, styles
    polys = [b['poly'] for b in buildings]
    simp = shapely.simplify(np.array(polys, dtype=object), 0.4, preserve_topology=True)
    for b, s in zip(buildings, simp):
        if s is None or s.is_empty or not s.is_valid or s.area < 4:
            s = b['poly']
        if isinstance(s, MultiPolygon):
            s = max(s.geoms, key=lambda g: g.area)
        b['p0'] = shapely.geometry.polygon.orient(s, 1.0)
    rinfo = min_rect_info([b['p0'] for b in buildings])
    n_pitched = 0
    for b, ri in zip(buildings, rinfo):
        if b.get('mosque'):
            b['roof'] = {'t': 'flat'}
            b['mq'] = mosque_parts(b, ri, minaret_pts)
        else:
            roof_shape(b, ri)
            if b['roof']['t'] != 'flat':
                n_pitched += 1
                b['p0'] = shapely.geometry.polygon.orient(b['poly'], 1.0)
                b['H'] = round(max(2.4, b['H'] - 0.5), 2)      # eave below the storey count's flat-roof top
        classify(b)
    say(f'  roofs: {n_pitched} pitched; styles {Counter(ATLAS["layers"][b["style"]]["name"] for b in buildings).most_common(8)}')

    # ---- party walls / street-facing edges (probes 0.9 m outside every <= 5 m wall segment)
    compute_edges(buildings, say)

    # ---- tiles
    by_tile = defaultdict(list)
    for bi, b in enumerate(buildings):
        ax, az = (b['anchor'].x, b['anchor'].y) if 'anchor' in b else (b['cx'], b['cz'])
        b['ax'], b['az'] = ax, az
        by_tile[(int(math.floor(ax / T1)), int(math.floor(az / T1)))].append(bi)
    index = []
    for (i, j), ids in sorted(by_tile.items()):
        if only and (i, j) != only:
            continue
        recs = [record(buildings[bi], i, j) for bi in ids]
        json.dump({'tile': [i, j], 'size': T1, 'origin': [i * T1, j * T1], 'buildings': recs},
                  open(os.path.join(TILES, f'L1_{i}_{j}.json'), 'w'), separators=(',', ':'))
        index.append({'i': i, 'j': j, 'n': len(recs)})
        write_obstacles(i, j, [buildings[bi] for bi in ids])
    json.dump(index, open(os.path.join(TILES, 'index_L1.json'), 'w'))
    say(f'  wrote {len(index)} L1 tiles')
    if only is None:
        for f in os.listdir(TILES):       # stale tiles of an earlier run
            if f.startswith('L1_') and tuple(int(v) for v in f[3:-5].split('_')) not in by_tile:
                os.remove(os.path.join(TILES, f))
        write_stats(buildings)
        write_far(None, say)
    say('done')


def compute_edges(buildings, say):
    SEG = 5.0
    polys = [b['p0'] for b in buildings]
    tree = STRtree(polys)
    eaves = np.array([b['H'] + (b['roof'].get('rise', 0) * 0.5 if b['roof']['t'] != 'flat' else 0) for b in buildings])
    base = np.array([b.get('base', 0.0) for b in buildings])
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
                nrm = np.array([e[1], -e[0]]) / L
                ns = max(1, int(math.ceil(L / SEG)))
                for s in range(ns):
                    mid = a + e * (s + 0.5) / ns
                    probe_pts.append(mid + nrm * 0.9)
                    probe_ref.append((bi, ri, k, s))
                ring_segs.append((k, ns))
            b['segs'].append(ring_segs)
    probe_pts = np.array(probe_pts)
    say(f'  {len(probe_pts)} edge probes')
    pp = shapely.points(probe_pts)
    pi_, bj_ = tree.query(pp, predicate='intersects')
    ref_b = np.array([r[0] for r in probe_ref])
    nbr_h = np.full(len(probe_pts), -1.0)
    m = (bj_ != ref_b[pi_]) & (base[bj_] <= 0.5)
    np.maximum.at(nbr_h, pi_[m], eaves[bj_[m]])
    roads, kinds = load_roads()
    main = np.array([k in MAIN_ROADS for k in kinds])
    rtree = STRtree(roads)
    idx, d = rtree.query_nearest(pp, max_distance=25.0, return_distance=True, all_matches=False)
    street = np.zeros(len(probe_pts), np.int8)
    near = d < 16.0
    street[idx[0][near]] = 1
    street[idx[0][near & main[idx[1]]]] = 2          # 2 = main road (shopfronts)
    for p, (bi, ri, k, s) in enumerate(probe_ref):
        buildings[bi].setdefault('edge', {})[(ri, k, s)] = (round(float(nbr_h[p]), 1), int(street[p]))
    say(f'  party walls on {(nbr_h > 0).sum()} of {len(nbr_h)} probe segments; street-facing {(street > 0).sum()} (main {(street == 2).sum()})')


def record(b, i, j):
    p0 = b['p0']
    flat = b['roof']['t'] == 'flat'
    p1 = clean_poly(b['poly'], 1.5) if flat else p0
    edges = []
    for ri, ring_segs in enumerate(b['segs']):
        edges.append([[k, [list(b['edge'].get((ri, k, s), (-1, 0))) for s in range(ns)]] for (k, ns) in ring_segs])
    sub = (1 if b['ax'] - i * T1 >= T1 / 2 else 0) + (2 if b['az'] - j * T1 >= T1 / 2 else 0)
    rec = {
        'id': b['id'], 'sub': sub,
        'p': ring_list(p0.exterior), 'holes': [ring_list(r) for r in p0.interiors],
        'p1': ring_list(p1.exterior) if p1 is not p0 and len(p1.exterior.coords) != len(p0.exterior.coords) else None,
        'h': round(float(b['H']), 2), 'base': round(float(b.get('base', 0.0)), 2), 'lv': b.get('levels', 1),
        'roof': b['roof'], 's': b['style'], 'g': b['ground'], 'rear': b['rear'], 'side': b['side'], 'rs': b['roofstyle'],
        'c': [round(x, 3) for x in b['tint']], 'rc': [round(x, 3) for x in b['rtint']],
        'e': edges, 'a': [round(b['ax'], 2), round(b['az'], 2)], 'seed': round(rnd01(b['id'], 'seed'), 4),
    }
    if b.get('mq'):
        rec['mq'] = b['mq']
    return rec


def solid_top(b):
    top = b['H'] + (b['roof'].get('rise', 0.0) if b['roof']['t'] != 'flat' else 0.0)
    return top


def write_obstacles(i, j, blds):
    """4 m raster of the tallest solid per cell (uint16 index+1) + solids table (anchor x, z, top above anchor ground).
    Mosque domes and minarets are extra solids anchored at their own positions."""
    from rasterio import features
    from rasterio.transform import from_origin
    n = int(T1 / OBST_CELL)
    x0, z0 = i * T1, j * T1
    tr = from_origin(x0, z0, OBST_CELL, -OBST_CELL)
    items = []
    for b in blds:
        items.append((solid_top(b), b['ax'], b['az'], b['p0'].buffer(1.0)))
        mq = b.get('mq')
        if mq:
            cx, cz, r, y0, drum, rise = mq['d']
            items.append((y0 + drum + rise, cx, cz, Point(cx, cz).buffer(r * 0.8, 8)))
            for (x, z, mr, h) in mq['m']:
                items.append((h, x, z, Point(x, z).buffer(mr + 1.0, 8)))
    if not items:
        return
    items.sort(key=lambda t: t[0])
    solids, shapes = [], []
    for top, ax, az, g in items:
        solids.append((ax, az, top))
        shapes.append((g, len(solids)))
    ras = features.rasterize(shapes, out_shape=(n, n), transform=tr, fill=0, all_touched=True, dtype='uint16')
    head = struct.pack('<4siiIfHH', b'OBS1', i, j, len(solids), OBST_CELL, n, n)
    body = np.asarray(solids, np.float32).tobytes() + ras.astype('<u2').tobytes()
    with gzip.open(os.path.join(OBST, f'{i}_{j}.bin.gz'), 'wb', compresslevel=9) as f:
        f.write(head + body)


# --------------------------------------------------------------------------------------------------------- far LOD
def merge_blocks(blds, bins, buf, simp, min_area):
    """Footprints of similar height merged into blocks (attached rows of İstanbul apartments become one block)."""
    recs = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        sel = [b for b in blds if lo <= b['Htop'] < hi]
        if not sel:
            continue
        u = unary_union([b['p0'].buffer(buf, join_style=2) for b in sel]).buffer(-buf, join_style=2)
        tree = STRtree([b['p0'] for b in sel])
        for g in as_polys(u):
            if g.area < min_area:
                continue
            g = g.simplify(simp, preserve_topology=True)
            if g.is_empty or not isinstance(g, Polygon) or len(g.exterior.coords) < 4:
                continue
            g = shapely.geometry.polygon.orient(Polygon(g.exterior), 1.0)
            members = [sel[k] for k in tree.query(g, predicate='intersects')]
            if not members:
                continue
            w = np.array([m['area'] for m in members])
            h = float((np.array([m['Htop'] for m in members]) * w).sum() / w.sum())
            dom = max(members, key=lambda m: m['area'])
            col = (np.array([m['tint'] for m in members]) * w[:, None]).sum(0) / w.sum()
            rcol = (np.array([m['rtint'] for m in members]) * w[:, None]).sum(0) / w.sum()
            recs.append({'p': ring_list(g.exterior), 'h': round(h, 1), 's': dom['style'], 'rs': dom['roofstyle'],
                         'c': [round(float(x), 3) for x in col], 'rc': [round(float(x), 3) for x in rcol], 'base': 0.0})
    return recs


L2_BINS = [0, 12, 21, 30, 40]           # 3.6-8 km: ~3-storey classes, blocks fused across streets (buffer 6 m)
L2_BUF, L2_SIMP, L2_MIN = 6.0, 8.0, 600.0
TOWER = 40.0                             # towers stay single buildings at LOD2
L3_TOWER = 90.0                          # beyond 8 km only the skyline: towers >= 90 m (cells without any: no LOD3 tile)


def far_records():
    """Building records of every L1 tile, reduced to what the far LODs need (lets write_far run without a full prep)."""
    out = []
    for f in sorted(os.listdir(TILES)):
        if not f.startswith('L1_'):
            continue
        for r in json.load(open(os.path.join(TILES, f)))['buildings']:
            try:
                p = Polygon(r['p'])
            except Exception:
                continue
            if not p.is_valid:
                p = p.buffer(0)
            if p.is_empty:
                continue
            rise = r['roof'].get('rise', 0) if r['roof']['t'] != 'flat' else 0
            out.append({'p0': p, 'Htop': r['h'] + 0.5 * rise, 'area': p.area, 'style': r['s'], 'roofstyle': r['rs'],
                        'tint': r['c'], 'rtint': r['rc'], 'base': r.get('base', 0.0), 'ax': r['a'][0], 'az': r['a'][1],
                        'mq': r.get('mq'), 'mosque': bool(r.get('mq'))})
    return out


def write_far(buildings=None, say=print):
    """LOD2 (3.6-8 km): per 2 km tile, blocks fused across streets per ~3-storey class + towers + big mosque domes.
    LOD3 (> 8 km): the skyline only (towers >= L3_TOWER); cells without towers get no LOD3 tile (no draw call)."""
    recs = far_records()
    T2 = 2 * T1
    groups = defaultdict(list)
    for b in recs:
        groups[(int(math.floor(b['ax'] / T2)), int(math.floor(b['az'] / T2)))].append(b)
    for f in os.listdir(TILES):
        if f.startswith('L2_') or f.startswith('L3_'):
            os.remove(os.path.join(TILES, f))
    n2 = n3 = t3 = 0
    for (i, j), blds in groups.items():
        towers = []
        for b in blds:
            if b['Htop'] >= TOWER and not b['mosque']:
                p = clean_poly(b['p0'], 3.0)
                towers.append((b['Htop'], {'p': ring_list(p.exterior), 'h': round(b['Htop'], 1), 's': b['style'], 'rs': b['roofstyle'],
                                           'c': [round(x, 3) for x in b['tint']], 'rc': [round(x, 3) for x in b['rtint']],
                                           'base': round(b.get('base', 0.0), 1)}))
        rest = [b for b in blds if b['Htop'] < TOWER and not b['mosque'] and b['Htop'] >= 4.0]
        domes = [{'d': b['mq']['d'], 'm': [m for m in b['mq']['m'] if m[3] >= 35]} for b in blds
                 if b['mq'] and b['mq']['d'][2] >= 5.0]
        halls = [b for b in blds if b['mosque'] and b['area'] >= 300]
        l2 = [t for _, t in towers] + merge_blocks(rest + halls, L2_BINS, L2_BUF, L2_SIMP, L2_MIN)
        l3 = [t for h, t in towers if h >= L3_TOWER]
        json.dump({'tile': [i, j], 'size': T2, 'origin': [i * T2, j * T2], 'blocks': l2, 'mosques': domes},
                  open(os.path.join(TILES, f'L2_{i}_{j}.json'), 'w'), separators=(',', ':'))
        n2 += 1
        if l3:
            json.dump({'tile': [i, j], 'size': T2, 'origin': [i * T2, j * T2], 'blocks': l3,
                       'mosques': [d for d in domes if d['d'][2] >= 9.0]},
                      open(os.path.join(TILES, f'L3_{i}_{j}.json'), 'w'), separators=(',', ':'))
            n3 += 1
            t3 += len(l3)
    say(f'  wrote {n2} L2 / {n3} L3 far tiles ({t3} skyline towers)')


def write_stats(buildings):
    H = np.array([b['H'] for b in buildings])
    known = np.array([b['known'] for b in buildings])
    src = Counter(b['src'] for b in buildings)
    st = {
        'buildings': len(buildings), 'sources': dict(src), 'heightTagged': int(known.sum()),
        'mosques': sum(1 for b in buildings if b.get('mosque')),
        'minarets': sum(len(b['mq']['m']) for b in buildings if b.get('mq')),
        'pitched': sum(1 for b in buildings if b['roof']['t'] != 'flat'),
        'heightPercentiles': {str(p): round(float(np.percentile(H, p)), 1) for p in (10, 25, 50, 75, 90, 99, 99.9)},
        'heightHistogram': {f'{lo}-{hi}': int(((H >= lo) & (H < hi)).sum()) for lo, hi in
                            ((0, 4), (4, 8), (8, 12), (12, 16), (16, 20), (20, 30), (30, 50), (50, 100), (100, 400))},
        'byDistrict': {},
    }
    by = defaultdict(list)
    for b in buildings:
        by[b.get('district') or '-'].append(b['H'])
    for d, hs in sorted(by.items()):
        st['byDistrict'][d] = {'n': len(hs), 'medianH': round(float(np.median(hs)), 1), 'p90H': round(float(np.percentile(hs, 90)), 1)}
    json.dump(st, open(os.path.join(CACHE, 'stats.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps({k: v for k, v in st.items() if k != 'byDistrict'}, ensure_ascii=False))


if __name__ == '__main__':
    if '--far-only' in sys.argv:
        write_far()
    else:
        main()
