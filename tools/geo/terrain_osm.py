"""Fetch OpenStreetMap coastline, inland water and piers (Overpass API, one query at a time, cached).

Output: data/sf/raw/osm_w1/{coastline,water}.json (raw Overpass JSON with geometry).
Usage: .venv/bin/python tools/geo/terrain_osm.py
"""
import os, json, time
import requests
from terrain_common import RAW, CORE, MID, FAR
from geo import local_to_lonlat

ENDPOINTS = ['https://overpass-api.de/api/interpreter']
HEADERS = {'User-Agent': 'GokyuzuSF-terrain-pipeline/1.0 (offline flight sim data prep)', 'Accept': 'application/json'}


def bbox_str(area):
    lon0, lat1 = local_to_lonlat(area['x0'], area['z0'])  # north-west
    lon1, lat0 = local_to_lonlat(area['x1'], area['z1'])  # south-east
    # pad a little: UTM box is slightly rotated vs lon/lat
    return f'{lat0 - 0.02:.4f},{lon0 - 0.02:.4f},{lat1 + 0.02:.4f},{lon1 + 0.02:.4f}'


def query(q, out):
    if os.path.exists(out) and os.path.getsize(out) > 100:
        print('cached', out)
        return
    os.makedirs(os.path.dirname(out), exist_ok=True)
    delay = 10
    for k in range(8):
        url = ENDPOINTS[k % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={'data': q}, headers=HEADERS, timeout=600)
            if r.status_code == 200 and r.text.startswith('{'):
                d = r.json()
                if 'elements' in d:
                    json.dump(d, open(out, 'w'))
                    print('saved', out, len(d['elements']), 'elements')
                    return
            print('overpass', r.status_code, r.text[:200])
        except Exception as e:
            print('overpass error', e)
        time.sleep(delay)
        delay = min(delay * 2, 120)
    raise RuntimeError('overpass failed')


def main():
    far, mid, core = bbox_str(FAR), bbox_str(MID), bbox_str(CORE)
    query(f'[out:json][timeout:600];way["natural"="coastline"]({far});out geom;',
          os.path.join(RAW, 'osm_w1', 'coastline.json'))
    time.sleep(5)
    query(f'''[out:json][timeout:600];
(
  way["natural"="water"]({mid});
  relation["natural"="water"]({mid});
  way["waterway"="riverbank"]({mid});
  way["landuse"="reservoir"]({mid});
  relation["landuse"="reservoir"]({mid});
  way["man_made"~"^(pier|breakwater|groyne)$"]({core});
  relation["man_made"="pier"]({core});
  way["aeroway"="aerodrome"]({core});
  relation["aeroway"="aerodrome"]({core});
);
out geom;''', os.path.join(RAW, 'osm_w1', 'water.json'))


if __name__ == '__main__':
    main()
