"""W3 landmarks: fetch OpenStreetMap geometry for the landmarks (Overpass, one query at a time, cached).

Usage:  .venv/bin/python tools/geo/landmarks_osm.py [name ...]      (no names = all)
Raw responses are cached in data/sf/raw/osm_landmarks/<name>.json (gitignored); re-runs never re-download.
"""
import json, os, sys, time
import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.path.join(ROOT, 'data', 'sf', 'raw', 'osm_landmarks')
ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
             'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
HEADERS = {'User-Agent': 'gokyuzu-sf-pipeline/1.0',
           'Accept': 'application/json'}

# bbox = (south, west, north, east)
QUERIES = {
    'ggb': """[out:json][timeout:90];
(
  way["bridge"](37.8000,-122.4860,37.8340,-122.4700);
  way["man_made"="bridge"](37.8000,-122.4860,37.8340,-122.4700);
  way["bridge:support"](37.8000,-122.4860,37.8340,-122.4700);
  node["bridge:support"](37.8000,-122.4860,37.8340,-122.4700);
  way["building"](37.8040,-122.4800,37.8120,-122.4720);
  node["man_made"="tower"](37.8000,-122.4860,37.8340,-122.4700);
);
out geom tags;""",
    'baybridge': """[out:json][timeout:120];
(
  way["bridge"]["highway"~"motorway|trunk|primary|cycleway|footway|path"](37.7800,-122.3950,37.8300,-122.2950);
  way["man_made"="bridge"](37.7800,-122.3950,37.8300,-122.2950);
  way["bridge:support"](37.7800,-122.3950,37.8300,-122.2950);
  node["bridge:support"](37.7800,-122.3950,37.8300,-122.2950);
  way["tunnel"]["highway"](37.8050,-122.3750,37.8150,-122.3550);
);
out geom tags;""",
    'downtown': """[out:json][timeout:90];
(
  way["building"]["name"](37.7860,-122.4060,37.7990,-122.3880);
  way["building"]["height"](37.7860,-122.4060,37.7990,-122.3880);
  way["building:part"]["name"](37.7860,-122.4060,37.7990,-122.3880);
  relation["building"](37.7860,-122.4060,37.7990,-122.3880);
);
out geom tags;""",
    'coit': """[out:json][timeout:60];
(
  way["building"](37.8015,-122.4072,37.8033,-122.4045);
  way["man_made"](37.8015,-122.4072,37.8033,-122.4045);
);
out geom tags;""",
    'sutro': """[out:json][timeout:60];
(
  node(37.7540,-122.4545,37.7565,-122.4510)["man_made"];
  way(37.7540,-122.4545,37.7565,-122.4510)["man_made"];
  way(37.7540,-122.4545,37.7565,-122.4510)["building"];
);
out geom tags;""",
    'alcatraz': """[out:json][timeout:60];
(
  way["building"](37.8240,-122.4270,37.8290,-122.4190);
  way["man_made"](37.8240,-122.4270,37.8290,-122.4190);
  node["man_made"](37.8240,-122.4270,37.8290,-122.4190);
  way["natural"="coastline"](37.8240,-122.4270,37.8290,-122.4190);
  way["place"="island"](37.8240,-122.4270,37.8290,-122.4190);
);
out geom tags;""",
    'palace': """[out:json][timeout:60];
(
  way["building"](37.8010,-122.4510,37.8045,-122.4455);
  way["natural"="water"](37.8010,-122.4510,37.8045,-122.4455);
  way["man_made"](37.8010,-122.4510,37.8045,-122.4455);
);
out geom tags;""",
    'cityhall': """[out:json][timeout:60];
(
  way["building"](37.7780,-122.4210,37.7805,-122.4175);
  relation["building"](37.7780,-122.4210,37.7805,-122.4175);
);
out geom tags;""",
    'oracle': """[out:json][timeout:60];
(
  way["leisure"~"stadium|pitch"](37.7760,-122.3930,37.7810,-122.3860);
  relation["leisure"="stadium"](37.7760,-122.3930,37.7810,-122.3860);
  way["building"](37.7760,-122.3930,37.7810,-122.3860);
);
out geom tags;""",
    'chase': """[out:json][timeout:60];
(
  way["building"](37.7665,-122.3895,37.7695,-122.3860);
  way["leisure"](37.7665,-122.3895,37.7695,-122.3860);
);
out geom tags;""",
    'painted': """[out:json][timeout:60];
(
  way["building"](37.7755,-122.4335,37.7770,-122.4320);
  way["leisure"="park"](37.7745,-122.4365,37.7775,-122.4325);
);
out geom tags;""",
    'fortpoint': """[out:json][timeout:60];
(
  way["building"](37.8095,-122.4785,37.8115,-122.4760);
  way["historic"](37.8095,-122.4785,37.8115,-122.4760);
);
out geom tags;""",
    'pier39': """[out:json][timeout:60];
(
  way["man_made"="pier"](37.8070,-122.4130,37.8110,-122.4070);
  way["building"](37.8070,-122.4130,37.8110,-122.4070);
);
out geom tags;""",
    'ferry': """[out:json][timeout:60];
(
  way["building"](37.7945,-122.3950,37.7970,-122.3915);
  way["man_made"="pier"](37.7940,-122.3950,37.7975,-122.3900);
);
out geom tags;""",
    'cranes': """[out:json][timeout:90];
(
  node["man_made"="crane"](37.7850,-122.3450,37.8200,-122.2650);
  way["man_made"="crane"](37.7850,-122.3450,37.8200,-122.2650);
  way["railway"="crane"](37.7850,-122.3450,37.8200,-122.2650);
  way["man_made"~"quay|pier"](37.7850,-122.3450,37.8200,-122.2650);
);
out geom tags;""",
}


def fetch(name, retries=5):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'{name}.json')
    if os.path.exists(path):
        return json.load(open(path))
    q = QUERIES[name]
    delay = 5
    for attempt in range(retries):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={'data': q}, headers=HEADERS, timeout=180)
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
    names = sys.argv[1:] or list(QUERIES)
    for n in names:
        fetch(n)
        time.sleep(2)  # be polite between queries
