"""Fetch OSM aeroway + building data for the airports (W4). One Overpass query at a time, cached.

Usage: .venv/bin/python tools/geo/airports_fetch.py [ksfo|koak|kngz|all] [--force]
Output: data/sf/raw/osm/airports_<icao>.json (raw Overpass JSON, `out geom`).
"""
import json, os, sys, time
import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'data', 'sf', 'raw', 'osm')
ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
             'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
UA = 'GokyuzuSF-flightsim-offline-pipeline/1.0 (personal hobby project)'

# south, west, north, east
BBOX = {
    'ksfo': (37.596, -122.407, 37.642, -122.352),
    'koak': (37.698, -122.255, 37.742, -122.195),
    'kngz': (37.770, -122.335, 37.795, -122.270),
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


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    force = '--force' in sys.argv
    names = list(BBOX) if which == 'all' else [which]
    for i, n in enumerate(names):
        fetch(n, force)
        if i < len(names) - 1:
            time.sleep(3)  # polite: sequential queries
