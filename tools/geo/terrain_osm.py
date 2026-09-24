"""Fetch OpenStreetMap coastline, inland water and piers (cached).

sf : Overpass API, one query at a time -> data/sf/raw/osm_w1/{coastline,water}.json (raw Overpass JSON with geometry).
ist: the Geofabrik Turkey extract (turkey-*.osm.pbf; the city pipeline's copy in assets/ist/city/_cache/raw/osm/ is
     reused, else downloaded into data/ist/_cache/raw/osm/), read offline with pyosmium (Overpass was overloaded), the
     same selections as Overpass queries written in the Overpass `out geom` layout ->
     data/ist/_cache/raw/osm_w1/{water,aeroways,landcover}.json. The sea itself comes from the OSM land polygons
     (terrain_water.py). aeroways = runways / taxiways / aprons / aerodromes (airport surfaces), landcover = landuse /
     natural / leisure polygons (DSM building + canopy removal, class map).
Usage: .venv/bin/python tools/geo/terrain_osm.py
"""
import os, json, time
import requests
from terrain_common import RAW, CORE, MID, FAR, REGION_ID, USER_AGENT
from geo import local_to_lonlat

ENDPOINTS = ['https://overpass-api.de/api/interpreter']
TIMEOUT = 600
if REGION_ID == 'sf':
    HEADERS = {'User-Agent': 'GokyuzuSF-terrain-pipeline/1.0 (offline flight sim data prep)', 'Accept': 'application/json'}
else:
    HEADERS = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
    ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
    TIMEOUT = 420


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
            r = requests.post(url, data={'data': q}, headers=HEADERS, timeout=TIMEOUT)
            if r.status_code == 200 and r.text.startswith('{'):
                d = r.json()
                if 'elements' in d and not (d.get('remark') or '').lower().startswith('runtime error'):
                    json.dump(d, open(out, 'w'))
                    print('saved', out, len(d['elements']), 'elements')
                    return
                print('overpass remark', d.get('remark'))
            else:
                print('overpass', r.status_code, r.text[:200])
        except Exception as e:
            print('overpass error', e)
        time.sleep(delay)
        delay = min(delay * 2, 120)
    raise RuntimeError('overpass failed')


def main_sf():
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


LU = {'residential', 'commercial', 'industrial', 'retail', 'construction', 'farmland', 'farmyard', 'orchard', 'vineyard',
      'meadow', 'grass', 'forest', 'cemetery', 'military', 'brownfield', 'greenfield', 'quarry', 'landfill', 'railway',
      'religious', 'education', 'allotments', 'recreation_ground', 'village_green', 'plant_nursery',
      'greenhouse_horticulture', 'garages', 'port', 'institutional'}
NAT = {'wood', 'scrub', 'heath', 'grassland', 'beach', 'sand', 'bare_rock', 'scree', 'wetland', 'shingle'}
LEI = {'park', 'garden', 'golf_course', 'pitch', 'stadium', 'nature_reserve', 'track'}
AME = {'university', 'school', 'hospital', 'parking', 'grave_yard'}
AERO_W = {'runway', 'taxiway', 'apron', 'aerodrome', 'helipad', 'stopway', 'blast_pad'}
AERO_R = {'apron', 'aerodrome', 'runway', 'taxiway'}
# landside airport areas graded with the airfield (terrain_airports.py EXTRA_ZONES), written into aeroways.json
EXTRA_IDS = {('way', 687768729), ('way', 1116947583), ('relation', 19575600), ('relation', 19575601)}


def _sets(t, is_rel):
    """Which output files an element with tags t belongs to (the Overpass selections of the sf-style queries)."""
    out = set()
    nat, lu, mm, ae = t.get('natural'), t.get('landuse'), t.get('man_made'), t.get('aeroway')
    if nat == 'water' or lu == 'reservoir' or (not is_rel and t.get('waterway') == 'riverbank'):
        out.add(('water', 'far'))
    if mm in (('pier', 'breakwater') if is_rel else ('pier', 'breakwater', 'groyne')):
        out.add(('water', 'mid'))
    if ae == 'aerodrome':
        out.add(('water', 'mid'))
    if ae in (AERO_R if is_rel else AERO_W):
        out.add(('aeroways', 'mid'))
    if lu in LU or nat in NAT or t.get('leisure') in LEI:
        out.add(('landcover', 'mid'))
    if not is_rel and t.get('amenity') in AME:
        out.add(('landcover', 'core'))
    return out


def geofabrik_pbf():
    import glob
    from terrain_common import ASSETS_DIR
    for d in (os.path.join(RAW, 'osm'), os.path.join(ASSETS_DIR, 'city', '_cache', 'raw', 'osm')):
        have = sorted(glob.glob(os.path.join(d, 'turkey-*.osm.pbf')))
        if have:
            return have[-1]
    d = os.path.join(RAW, 'osm')
    os.makedirs(d, exist_ok=True)
    out = os.path.join(d, 'turkey-latest.osm.pbf')
    with requests.get('https://download.geofabrik.de/europe/turkey-latest.osm.pbf', stream=True,
                      headers={'User-Agent': USER_AGENT}, timeout=600) as r:
        r.raise_for_status()
        with open(out + '.part', 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    os.replace(out + '.part', out)
    return out


def main_ist():
    import osmium
    d = os.path.join(RAW, 'osm_w1')
    names = ('water', 'aeroways', 'landcover')
    def have_extra():
        p = os.path.join(d, 'aeroways.json')
        if not os.path.exists(p):
            return False
        got = {(e['type'], e['id']) for e in json.load(open(p))['elements']}
        return EXTRA_IDS <= got
    if all(os.path.exists(os.path.join(d, f'{n}.json')) for n in names) and have_extra():
        print('cached', d)
        return
    pbf = geofabrik_pbf()
    print('reading', pbf, flush=True)
    boxes = {}
    for k, area in (('far', FAR), ('mid', MID), ('core', CORE)):
        la0, lo0, la1, lo1 = (float(v) for v in bbox_str(area).split(','))
        boxes[k] = (la0, lo0, la1, lo1)

    def inside(k, lat, lon):
        la0, lo0, la1, lo1 = boxes[k]
        return la0 <= lat <= la1 and lo0 <= lon <= lo1
    t0 = time.time()
    rels, need = {}, {}
    for r in osmium.FileProcessor(pbf, osmium.osm.RELATION):
        t = dict(r.tags)
        if t.get('type') != 'multipolygon':
            continue
        sets = _sets(t, True) | ({('aeroways', 'mid')} if ('relation', r.id) in EXTRA_IDS else set())
        if sets:
            ways = [(m.ref, m.role) for m in r.members if m.type == 'w']
            rels[r.id] = (t, ways, sets)
            for ref, _ in ways:
                need[ref] = True
    print(f'pass 1: {len(rels)} relations ({time.time() - t0:.0f} s)', flush=True)
    out = {n: [] for n in names}
    geoms = {}
    for w in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if not w.is_way():
            continue
        t = dict(w.tags)
        sets = _sets(t, False) | ({('aeroways', 'mid')} if ('way', w.id) in EXTRA_IDS else set())
        if not sets and w.id not in need:
            continue
        try:
            g = [{'lat': round(n.location.lat, 7), 'lon': round(n.location.lon, 7)} for n in w.nodes]
        except osmium.InvalidLocationError:
            continue
        if w.id in need:
            geoms[w.id] = g
        for name, box in sets:
            if any(inside(box, p['lat'], p['lon']) for p in g):
                out[name].append({'type': 'way', 'id': w.id, 'tags': t, 'geometry': g})
    print(f'pass 2: ways done ({time.time() - t0:.0f} s)', flush=True)
    for rid, (t, ways, sets) in rels.items():
        members = [{'type': 'way', 'ref': ref, 'role': role, 'geometry': geoms[ref]} for ref, role in ways if ref in geoms]
        if not members:
            continue
        for name, box in sets:
            if any(inside(box, p['lat'], p['lon']) for m in members for p in m['geometry'][::5]):
                out[name].append({'type': 'relation', 'id': rid, 'tags': t, 'members': members})
    os.makedirs(d, exist_ok=True)
    for n in names:
        json.dump({'version': 0.6, 'generator': 'terrain_osm.py (pyosmium, ' + os.path.basename(pbf) + ')',
                   'elements': out[n]}, open(os.path.join(d, f'{n}.json'), 'w'))
        print('saved', n, len(out[n]), 'elements', flush=True)


def main():
    if REGION_ID == 'sf':
        main_sf()
    else:
        main_ist()


if __name__ == '__main__':
    main()
