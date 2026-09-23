"""W2 city: extract buildings, landcover, trees and roads for the map bbox from the Geofabrik NorCal extract.

  .venv/bin/python tools/geo/city_osm.py            (needs data/sf/raw/osm/norcal-*.osm.pbf, see city_fetch.py)

Writes data/sf/cache/city/osm_{buildings,landcover,trees,roads}.json with lon/lat geometry (rings / lines) and a tag subset.
(pip: osmium — installed into the shared .venv)
"""
import glob, json, os, sys, time
import osmium

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'data', 'sf', 'cache', 'city')
W, S, E, N = -122.565, 37.545, -122.135, 37.875   # region bbox + a small margin

BUILDING_KEYS = ('building', 'building:part', 'height', 'min_height', 'building:levels', 'building:min_level', 'roof:shape',
                 'roof:height', 'roof:levels', 'roof:colour', 'roof:material', 'building:colour', 'building:material',
                 'name', 'amenity', 'shop', 'man_made', 'leisure', 'tourism', 'office', 'industrial', 'layer', 'location',
                 'aeroway', 'religion', 'historic', 'addr:city')
LANDCOVER = {
    'landuse': None,  # all values
    'natural': {'wood', 'scrub', 'heath', 'grassland', 'wetland', 'beach', 'sand', 'bare_rock', 'cliff'},
    'leisure': {'park', 'golf_course', 'garden', 'nature_reserve', 'pitch', 'playground', 'recreation_ground', 'dog_park'},
    'boundary': {'national_park', 'protected_area'},
}
ROAD_TYPES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
              'service', 'pedestrian', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}


def in_bbox(lon, lat):
    return W <= lon <= E and S <= lat <= N


def rings_of(area):
    out = []
    for outer in area.outer_rings():
        ring = [(round(n.lon, 7), round(n.lat, 7)) for n in outer]
        inners = [[(round(n.lon, 7), round(n.lat, 7)) for n in inner] for inner in area.inner_rings(outer)]
        out.append({'outer': ring, 'inner': inners})
    return out


def main():
    pbf = sorted(glob.glob(os.path.join(ROOT, 'data', 'sf', 'raw', 'osm', 'norcal-*.osm.pbf')))
    if not pbf:
        sys.exit('missing NorCal pbf: run tools/geo/city_fetch.py osm')
    os.makedirs(OUT, exist_ok=True)
    buildings, landcover, trees, roads = [], [], [], []
    t0 = time.time()
    fp = osmium.FileProcessor(pbf[-1]).with_areas().with_locations()
    n = 0
    for obj in fp:
        n += 1
        if n % 2000000 == 0:
            print(f'  {n / 1e6:.0f} M objects, {time.time() - t0:.0f} s, {len(buildings)} buildings', flush=True)
        tags = obj.tags
        if obj.is_node():
            if tags.get('natural') == 'tree':
                loc = obj.location
                if loc.valid() and in_bbox(loc.lon, loc.lat):
                    trees.append({'lon': round(loc.lon, 7), 'lat': round(loc.lat, 7),
                                  **{k: tags[k] for k in ('species', 'genus', 'leaf_type', 'height', 'species:en', 'taxon') if k in tags}})
            continue
        if obj.is_way():
            hw = tags.get('highway')
            if (hw in ROAD_TYPES or tags.get('natural') == 'tree_row') and len(obj.nodes) >= 2:
                try:
                    pts = [(round(nd.lon, 7), round(nd.lat, 7)) for nd in obj.nodes]
                except osmium.InvalidLocationError:
                    continue
                if any(in_bbox(*p) for p in pts[:: max(1, len(pts) // 8)] + [pts[-1]]):
                    roads.append({'id': obj.id, 'highway': hw, 'name': tags.get('name'), 'natural': tags.get('natural'),
                                  'lanes': tags.get('lanes'), 'oneway': tags.get('oneway'), 'pts': pts})
            continue
        if not obj.is_area():
            continue
        is_bld = ('building' in tags and tags['building'] != 'no') or 'building:part' in tags
        lc_key = None
        for k, vals in LANDCOVER.items():
            if k in tags and (vals is None or tags[k] in vals):
                lc_key = k
                break
        if not is_bld and not lc_key:
            continue
        try:
            rings = rings_of(obj)
        except osmium.InvalidLocationError:
            continue
        if not rings:
            continue
        lon, lat = rings[0]['outer'][0]
        if not in_bbox(lon, lat):
            # large landcover polygons may start outside: test the ring bbox
            xs = [p[0] for r in rings for p in r['outer']]
            ys = [p[1] for r in rings for p in r['outer']]
            if max(xs) < W or min(xs) > E or max(ys) < S or min(ys) > N:
                continue
            if is_bld:
                continue
        src = ('w' if obj.from_way() else 'r') + str(obj.orig_id())
        if is_bld:
            buildings.append({'id': src, 'tags': {k: tags[k] for k in BUILDING_KEYS if k in tags}, 'rings': rings})
        else:
            landcover.append({'id': src, 'tags': {k: tags[k] for k in ('landuse', 'natural', 'leisure', 'boundary', 'name', 'leaf_type',
                                                                           'wood', 'golf', 'protect_class') if k in tags},
                              'rings': rings})
    for name, data in (('buildings', buildings), ('landcover', landcover), ('trees', trees), ('roads', roads)):
        json.dump(data, open(os.path.join(OUT, f'osm_{name}.json'), 'w'), separators=(',', ':'))
        print(f'{name}: {len(data)}')
    print(f'done in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
