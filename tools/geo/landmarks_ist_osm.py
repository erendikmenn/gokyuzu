"""İstanbul landmarks: fetch OpenStreetMap geometry around each landmark (small Overpass queries, cached).

Usage:  GEO_REGION=ist .venv/bin/python tools/geo/landmarks_ist_osm.py [name ...]      (no names = all)
Raw responses are cached in data/ist/_cache/raw/osm_landmarks/<name>.json (not in git); re-runs never re-download.
Source: © OpenStreetMap contributors (ODbL). Generic User-Agent, no personal data.
"""
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(__file__))
from geo import DATA_DIR, REGION_ID  # noqa: E402

CACHE = os.path.join(DATA_DIR, '_cache', 'raw', 'osm_landmarks')
ENDPOINTS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter',
             'https://overpass.kumi.systems/api/interpreter']
HEADERS = {'User-Agent': 'gokyuzu-sf-pipeline/1.0', 'Accept': 'application/json'}


def bridge_q(bb, extra=''):
    b = ','.join(f'{v:.4f}' for v in bb)
    return f"""[out:json][timeout:120];
(
  way["bridge"]({b});
  way["man_made"="bridge"]({b});
  relation["man_made"="bridge"]({b});
  way["bridge:support"]({b});
  node["bridge:support"]({b});
  way["building:part"]({b});
  way["man_made"~"tower|mast|pier"]({b});
  node["man_made"~"tower|mast"]({b});
  way["building"]["name"]({b});
  way["natural"="coastline"]({b});
{extra});
out geom tags;"""


def site_q(bb, extra=''):
    b = ','.join(f'{v:.4f}' for v in bb)
    return f"""[out:json][timeout:120];
(
  way["building"]({b});
  relation["building"]({b});
  way["building:part"]({b});
  relation["building:part"]({b});
  way["man_made"]({b});
  node["man_made"]({b});
  way["historic"]({b});
  way["amenity"="place_of_worship"]({b});
  relation["amenity"="place_of_worship"]({b});
  way["natural"="coastline"]({b});
{extra});
out geom tags;"""


# bbox = (south, west, north, east)
QUERIES = {
    'bogazici': bridge_q((41.0350, 29.0150, 41.0560, 29.0560)),
    'fsm': bridge_q((41.0800, 29.0400, 41.1020, 29.0800)),
    'yss': bridge_q((41.1850, 29.0750, 41.2200, 29.1500)),
    'halic_inner': bridge_q((41.0150, 28.9570, 41.0310, 28.9800)),
    'halic_o1': bridge_q((41.0330, 28.9330, 41.0500, 28.9560)),
    'kizkulesi': site_q((41.0198, 29.0025, 41.0224, 29.0058)),
    'galata': site_q((41.0249, 28.9732, 41.0264, 28.9752)),
    'camlica': site_q((41.0315, 29.0650, 41.0375, 29.0760)),
    'camlica_tower': """[out:json][timeout:120];
(
  way["man_made"~"tower|mast"](41.0150,29.0550,41.0420,29.0850);
  node["man_made"~"tower|mast"](41.0150,29.0550,41.0420,29.0850);
  way["building"]["name"](41.0150,29.0550,41.0420,29.0850);
  way["building:part"](41.0150,29.0550,41.0420,29.0850);
);
out geom tags;""",
    'sultanahmet': site_q((41.0035, 28.9730, 41.0110, 28.9820)),
    'topkapi': site_q((41.0080, 28.9780, 41.0160, 28.9880)),
    'suleymaniye': site_q((41.0145, 28.9615, 41.0180, 28.9670)),
    'yenicami': site_q((41.0160, 28.9700, 41.0182, 28.9728)),
    'dolmabahce': site_q((41.0360, 28.9950, 41.0425, 29.0060)),
    'rumelihisari': site_q((41.0825, 29.0535, 41.0875, 29.0595)),
    'haydarpasa': site_q((40.9945, 29.0165, 40.9990, 29.0220)),
    # tall buildings / towers anywhere in the map (obstacles): height >= 120 m or >= 35 levels, and tall masts
    'tall': """[out:json][timeout:180];
(
  way["building"]["height"](if: number(t["height"]) >= 120)(40.82,28.62,41.37,29.40);
  relation["building"]["height"](if: number(t["height"]) >= 120)(40.82,28.62,41.37,29.40);
  way["building:part"]["height"](if: number(t["height"]) >= 120)(40.82,28.62,41.37,29.40);
  way["building"]["building:levels"](if: number(t["building:levels"]) >= 35)(40.82,28.62,41.37,29.40);
  relation["building"]["building:levels"](if: number(t["building:levels"]) >= 35)(40.82,28.62,41.37,29.40);
  way["man_made"~"tower|mast"]["height"](if: number(t["height"]) >= 80)(40.82,28.62,41.37,29.40);
  node["man_made"~"tower|mast"]["height"](if: number(t["height"]) >= 80)(40.82,28.62,41.37,29.40);
);
out geom tags;""",
}


def fetch(name, retries=5):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'{name}.json')
    if os.path.exists(path):
        return json.load(open(path))
    q = QUERIES[name]
    delay = 10
    for attempt in range(retries):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={'data': q}, headers=HEADERS, timeout=240)
            if r.status_code == 200:
                data = r.json()
                json.dump(data, open(path, 'w'))
                print(f'{name}: {len(data.get("elements", []))} elements from {url}')
                return data
            print(f'{name}: HTTP {r.status_code} from {url}; retry in {delay}s', file=sys.stderr)
        except Exception as e:  # network hiccup
            print(f'{name}: {e}; retry in {delay}s', file=sys.stderr)
        time.sleep(delay)
        delay *= 2
    raise RuntimeError(f'overpass failed for {name}')


if __name__ == '__main__':
    assert REGION_ID == 'ist', 'run with GEO_REGION=ist'
    for n in sys.argv[1:] or list(QUERIES):
        fetch(n)
        time.sleep(3)  # be polite between queries
