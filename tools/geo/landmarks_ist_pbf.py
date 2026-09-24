"""İstanbul landmarks: cut the OSM geometry around each landmark out of the Geofabrik Turkey extract (offline).

Overpass was overloaded (504s), and the city pipeline already downloads the Turkey extract, so this reads that file
(read-only, never downloads it again) in one pass and writes the same per-landmark JSON the Overpass fetcher
(landmarks_ist_osm.py) writes: data/ist/_cache/raw/osm_landmarks/<name>.json = {"elements": [...]} with
  way:      {type:'way', id, tags, geometry:[{lat, lon}, ...]}
  node:     {type:'node', id, tags, lat, lon}
  relation: {type:'relation', id, tags, rings:[{outer:[{lat,lon}...], inner:[[...]]}]}   (multipolygons, as areas)
Usage:  GEO_REGION=ist .venv/bin/python tools/geo/landmarks_ist_pbf.py [pbf] [--only name,name]
Source: © OpenStreetMap contributors (ODbL).
"""
import glob
import json
import os
import sys
import time

import osmium

sys.path.insert(0, os.path.dirname(__file__))
from geo import DATA_DIR, ROOT, REGION_ID  # noqa: E402

OUT = os.path.join(DATA_DIR, '_cache', 'raw', 'osm_landmarks')
PBF_GLOB = [os.path.join(ROOT, 'assets', 'ist', 'city', '_cache', 'raw', 'osm', 'turkey-*.osm.pbf'),
            os.path.join(DATA_DIR, '_cache', 'raw', 'osm', 'turkey-*.osm.pbf')]

# (south, west, north, east) per landmark group; 'kind' selects which features are kept
BOXES = {
    'bogazici': ((41.0350, 29.0150, 41.0560, 29.0560), 'bridge'),
    'fsm': ((41.0800, 29.0400, 41.1020, 29.0800), 'bridge'),
    'yss': ((41.1850, 29.0750, 41.2200, 29.1500), 'bridge'),
    'halic_inner': ((41.0150, 28.9570, 41.0310, 28.9800), 'bridge'),
    'halic_o1': ((41.0330, 28.9330, 41.0500, 28.9560), 'bridge'),
    'kizkulesi': ((41.0198, 29.0025, 41.0224, 29.0058), 'site'),
    'galata': ((41.0249, 28.9732, 41.0264, 28.9752), 'site'),
    'camlica': ((41.0315, 29.0650, 41.0375, 29.0760), 'site'),
    'camlica_tower': ((41.0150, 29.0550, 41.0420, 29.0850), 'tower'),
    'sultanahmet': ((41.0035, 28.9730, 41.0110, 28.9820), 'site'),
    'topkapi': ((41.0080, 28.9760, 41.0190, 28.9900), 'site'),   # palace + Sur-ı Sultani to Sarayburnu
    'suleymaniye': ((41.0145, 28.9615, 41.0180, 28.9670), 'site'),
    'yenicami': ((41.0160, 28.9700, 41.0182, 28.9728), 'site'),
    'dolmabahce': ((41.0360, 28.9950, 41.0425, 29.0060), 'site'),
    'rumelihisari': ((41.0825, 29.0535, 41.0875, 29.0595), 'site'),
    'haydarpasa': ((40.9945, 29.0165, 40.9990, 29.0220), 'site'),
    'tall': ((40.82, 28.62, 41.37, 29.40), 'tall'),
    # business districts (skyline models): Şişli–Levent–Maslak–Zincirlikuyu–Gümüşsuyu and Ataşehir, down to 50 m / 14
    # storeys, plus every named building / part (towers whose height / levels tags are missing)
    'cbd_eu': ((41.030, 28.975, 41.125, 29.040), 'cbd'),
    'cbd_as': ((40.975, 29.080, 41.010, 29.150), 'cbd'),
}
SITE_KEYS = ('building', 'building:part', 'man_made', 'historic', 'amenity', 'natural', 'bridge', 'bridge:support',
             'barrier', 'wall', 'tourism', 'leisure', 'place')
BRIDGE_KEYS = ('bridge', 'man_made', 'bridge:support', 'building:part', 'natural')


def num(v):
    try:
        return float(str(v).split()[0].replace(',', '.'))
    except (ValueError, IndexError):
        return None


def wanted(kind, tags):
    if kind == 'site':
        return any(k in tags for k in SITE_KEYS)
    if kind == 'bridge':
        if 'bridge' in tags or 'bridge:support' in tags or 'building:part' in tags:
            return True
        if tags.get('man_made') in ('bridge', 'tower', 'mast', 'pier'):
            return True
        if 'building' in tags and 'name' in tags:
            return True
        return tags.get('natural') == 'coastline'
    if kind == 'tower':
        return tags.get('man_made') in ('tower', 'mast') or ('building' in tags and 'name' in tags) or 'building:part' in tags
    if kind == 'cbd':
        if 'building' in tags or 'building:part' in tags:
            h, lv = num(tags.get('height')), num(tags.get('building:levels'))
            if (h is not None and h >= 50) or (lv is not None and lv >= 14):
                return True
            return 'name' in tags      # named office / residential blocks (MetroCity A, Varyap: no usable levels tag)
        return tags.get('man_made') in ('tower', 'mast') and (num(tags.get('height')) or 0) >= 50
    if kind == 'tall':
        if 'building' in tags or 'building:part' in tags:
            h, lv = num(tags.get('height')), num(tags.get('building:levels'))
            return (h is not None and h >= 120) or (lv is not None and lv >= 35)
        if tags.get('man_made') in ('tower', 'mast'):
            h = num(tags.get('height'))
            return h is not None and h >= 80
    return False


def inside(bb, lon, lat):
    return bb[0] <= lat <= bb[2] and bb[1] <= lon <= bb[3]


def main():
    assert REGION_ID == 'ist', 'run with GEO_REGION=ist'
    args = sys.argv[1:]
    only = None
    if '--only' in args:
        i = args.index('--only')
        only = set(args[i + 1].split(','))
        args = args[:i] + args[i + 2:]
        for k in list(BOXES):
            if k not in only:
                del BOXES[k]
    pbf = args[0] if args else None
    if not pbf:
        cands = sorted(p for g in PBF_GLOB for p in glob.glob(g))
        if not cands:
            sys.exit('no turkey-*.osm.pbf found (the city pipeline downloads it: tools/geo/city_fetch.py osm)')
        pbf = cands[-1]
    print('reading', pbf, flush=True)
    out = {k: [] for k in BOXES}
    seen = {k: set() for k in BOXES}
    t0 = time.time()
    fp = (osmium.FileProcessor(pbf).with_locations().with_areas()
          .with_filter(osmium.filter.EmptyTagFilter()))
    n = 0
    for obj in fp:
        n += 1
        if n % 1000000 == 0:
            print(f'  {n / 1e6:.0f} M tagged objects, {time.time() - t0:.0f} s', flush=True)
        tags = dict(obj.tags)
        if obj.is_node():
            loc = obj.location
            if not loc.valid():
                continue
            for k, (bb, kind) in BOXES.items():
                if inside(bb, loc.lon, loc.lat) and wanted(kind, tags):
                    out[k].append({'type': 'node', 'id': obj.id, 'tags': tags, 'lat': loc.lat, 'lon': loc.lon})
        elif obj.is_way():
            try:
                g = [{'lat': round(nd.lat, 7), 'lon': round(nd.lon, 7)} for nd in obj.nodes]
            except osmium.InvalidLocationError:
                continue
            if not g:
                continue
            for k, (bb, kind) in BOXES.items():
                if not wanted(kind, tags):
                    continue
                if any(inside(bb, p['lon'], p['lat']) for p in g):
                    out[k].append({'type': 'way', 'id': obj.id, 'tags': tags, 'geometry': g})
                    seen[k].add(('w', obj.id))
        elif obj.is_area() and not obj.from_way():
            rings = []
            try:
                for o in obj.outer_rings():
                    outer = [{'lat': round(p.lat, 7), 'lon': round(p.lon, 7)} for p in o]
                    inner = [[{'lat': round(p.lat, 7), 'lon': round(p.lon, 7)} for p in i] for i in obj.inner_rings(o)]
                    rings.append({'outer': outer, 'inner': inner})
            except osmium.InvalidLocationError:
                continue
            if not rings:
                continue
            for k, (bb, kind) in BOXES.items():
                if not wanted(kind, tags):
                    continue
                if any(inside(bb, p['lon'], p['lat']) for r in rings for p in r['outer']):
                    out[k].append({'type': 'relation', 'id': obj.orig_id(), 'tags': tags, 'rings': rings})
    os.makedirs(OUT, exist_ok=True)
    for k, els in out.items():
        json.dump({'source': os.path.basename(pbf), 'elements': els}, open(os.path.join(OUT, f'{k}.json'), 'w'))
        print(f'{k}: {len(els)} elements')
    print(f'done in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
