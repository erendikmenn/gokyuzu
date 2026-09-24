"""Fetch OSM aeroway + building data for the airports (W4). One Overpass query at a time, cached.

Usage: .venv/bin/python tools/geo/airports_fetch.py [ksfo|koak|kngz|all] [--force]
Output: data/sf/raw/osm/airports_<icao>.json (raw Overpass JSON, `out geom`).

İstanbul (GEO_REGION=ist): no Overpass. The same selection is read from the Geofabrik Turkey extract that
tools/geo/city_fetch.py downloads (two pyosmium passes: multipolygon relations, then nodes + ways with locations)
and written in the Overpass `out geom` layout to assets/ist/airports/_cache/raw/airports_<icao>.json.
  GEO_REGION=ist .venv/bin/python tools/geo/airports_fetch.py [ltfm|ltfj|ltba|all] [--force]
"""
import glob, json, os, sys, time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from airports_lib import ROOT, RAW_OSM, REGION_ID  # noqa: E402

OUT = RAW_OSM
ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
             'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
UA = 'GokyuzuSF-flightsim-offline-pipeline/1.0 (personal hobby project)'

# south, west, north, east
BBOX = {
    'ksfo': (37.596, -122.407, 37.642, -122.352),
    'koak': (37.698, -122.255, 37.742, -122.195),
    'kngz': (37.770, -122.335, 37.795, -122.270),
}
if REGION_ID == 'ist':
    BBOX = {   # south, west, north, east (aerodrome polygons + a margin for the terminal / cargo / support areas)
        'ltfm': (41.215, 28.655, 41.315, 28.800),
        'ltfj': (40.870, 29.275, 40.920, 29.335),
        'ltba': (40.952, 28.780, 41.000, 28.850),
    }


def query(bbox):
    s, w, n, e = bbox
    b = f'{s},{w},{n},{e}'
    return f"""[out:json][timeout:180];
(
  way["aeroway"]({b});
  relation["aeroway"]({b});
  node["aeroway"]({b});
  way["building"]({b});
  relation["building"]({b});
  way["man_made"~"tower|mast|storage_tank|water_tower"]({b});
  node["man_made"~"tower|mast|water_tower"]({b});
  way["amenity"="parking"]["parking"~"multi-storey|multistorey"]({b});
  way["railway"~"light_rail|monorail|rail"]({b});
);
out geom;"""


def fetch(name, force=False):
    path = os.path.join(OUT, f'airports_{name}.json')
    if os.path.exists(path) and not force:
        print('cached', path)
        return path
    q = query(BBOX[name])
    delay = 5
    for attempt in range(8):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            print(f'[{name}] POST {url} (attempt {attempt + 1})')
            r = requests.post(url, data={'data': q}, headers={'User-Agent': UA, 'Accept': 'application/json'}, timeout=240)
            if r.status_code == 200:
                d = r.json()
                os.makedirs(OUT, exist_ok=True)
                json.dump(d, open(path, 'w'))
                print(f'[{name}] {len(d.get("elements", []))} elements -> {path}')
                return path
            print(f'[{name}] HTTP {r.status_code}: {r.text[:200]}')
        except Exception as ex:  # network hiccup
            print(f'[{name}] error {ex}')
        time.sleep(delay)
        delay = min(delay * 2, 120)
    raise SystemExit(f'failed to fetch {name}')


def _way_tag_match(t):
    return ('aeroway' in t or 'building' in t or t.get('man_made') in ('tower', 'mast', 'storage_tank', 'water_tower')
            or (t.get('amenity') == 'parking' and t.get('parking') in ('multi-storey', 'multistorey'))
            or t.get('railway') in ('light_rail', 'monorail', 'rail', 'subway'))


def _node_tag_match(t):
    return 'aeroway' in t or t.get('man_made') in ('tower', 'mast', 'water_tower')


def fetch_pbf(names, force=False):
    """Overpass-equivalent selection from the Geofabrik extract (same elements as query(), `out geom` layout)."""
    import osmium
    todo = [n for n in names if force or not os.path.exists(os.path.join(OUT, f'airports_{n}.json'))]
    if not todo:
        print('cached', ', '.join(names))
        return
    from city_paths import RAW
    pbf = sorted(glob.glob(os.path.join(RAW, 'osm', '*.osm.pbf')))
    if not pbf:
        sys.exit('missing Geofabrik extract: run GEO_REGION=ist tools/geo/city_fetch.py osm')
    pbf = pbf[-1]
    boxes = {n: BBOX[n] for n in todo}

    def inside(lat, lon):
        return [n for n, (s_, w_, n_, e_) in boxes.items() if s_ <= lat <= n_ and w_ <= lon <= e_]

    t0 = time.time()
    rels = {}
    for r in osmium.FileProcessor(pbf, osmium.osm.RELATION):
        t = dict(r.tags)
        if t.get('type') in ('multipolygon', 'building') and _way_tag_match(t):
            rels[r.id] = {'type': 'relation', 'id': r.id, 'tags': t,
                          'members': [{'type': {'w': 'way', 'n': 'node', 'r': 'relation'}[m.type], 'ref': m.ref, 'role': m.role}
                                      for m in r.members]}
    need = {m['ref'] for rel in rels.values() for m in rel['members'] if m['type'] == 'way'}
    print(f'pass 1: {len(rels)} candidate relations ({time.time() - t0:.0f} s)', flush=True)
    out = {n: [] for n in todo}
    geom_of = {}
    for o in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if o.is_node():
            if not o.tags or not _node_tag_match(o.tags):
                continue
            loc = o.location
            if not loc.valid():
                continue
            for n in inside(loc.lat, loc.lon):
                out[n].append({'type': 'node', 'id': o.id, 'lat': round(loc.lat, 7), 'lon': round(loc.lon, 7), 'tags': dict(o.tags)})
            continue
        m = _way_tag_match(o.tags)
        if not m and o.id not in need:
            continue
        try:
            g = [{'lat': round(nd.lat, 7), 'lon': round(nd.lon, 7)} for nd in o.nodes]
        except osmium.InvalidLocationError:
            continue
        if o.id in need:
            geom_of[o.id] = g
        if m:
            hit = set()
            for p in g[:: max(1, len(g) // 6)] + g[-1:]:
                hit.update(inside(p['lat'], p['lon']))
            for n in hit:
                out[n].append({'type': 'way', 'id': o.id, 'tags': dict(o.tags), 'geometry': g})
    print(f'pass 2: nodes + ways ({time.time() - t0:.0f} s)', flush=True)
    for rel in rels.values():
        pts = []
        for m in rel['members']:
            if m['type'] == 'way' and m['ref'] in geom_of:
                m['geometry'] = geom_of[m['ref']]
                pts += m['geometry'][:: max(1, len(m['geometry']) // 4)]
        hit = set()
        for p in pts:
            hit.update(inside(p['lat'], p['lon']))
        for n in hit:
            out[n].append(rel)
    os.makedirs(OUT, exist_ok=True)
    for n, els in out.items():
        path = os.path.join(OUT, f'airports_{n}.json')
        json.dump({'version': 0.6, 'generator': 'gokyuzu airports_fetch.py (Geofabrik extract)', 'elements': els}, open(path, 'w'))
        print(f'[{n}] {len(els)} elements -> {path}')


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'all'
    force = '--force' in sys.argv
    names = list(BBOX) if which == 'all' else [which]
    if REGION_ID != 'sf':
        fetch_pbf(names, force)
        sys.exit(0)
    for i, n in enumerate(names):
        fetch(n, force)
        if i < len(names) - 1:
            time.sleep(3)  # polite: sequential queries
