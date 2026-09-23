"""W2 city: download raw public data for buildings and vegetation (cached, re-runnable).

  .venv/bin/python tools/geo/city_fetch.py [datasf] [trees] [osm]      (no args = everything)

Sources
  DataSF "Building Footprints" (ynuv-fyni): 177k footprints with 2010 LiDAR height statistics
  DataSF "Street Tree List" (tkzw-k3nq): ~144k street trees with species
  OpenStreetMap (Geofabrik NorCal extract, parsed by city_osm.py): buildings/building parts, landuse / natural / leisure
  polygons (parks, forests, scrub), natural=tree nodes, highways (street-front detection, palm avenues).
Cache: data/sf/raw/datasf/*.json, data/sf/raw/osm/norcal-*.osm.pbf
"""
import json, os, sys, time
import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RAW = os.path.join(ROOT, 'data', 'sf', 'raw')
UA = {'User-Agent': 'GokyuzuSF-city-pipeline/1.0 (offline flight-sim asset build)'}
BBOX = (-122.56, 37.55, -122.14, 37.87)   # region.json bboxLonLat (W, S, E, N)


def get_with_retry(url, params=None, data=None, tries=8, timeout=600):
    delay = 10
    for i in range(tries):
        try:
            r = requests.post(url, data=data, headers=UA, timeout=timeout) if data is not None else \
                requests.get(url, params=params, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            print(f'  HTTP {r.status_code} {r.text[:200]!r}', flush=True)
        except requests.RequestException as e:
            print(f'  error {e}', flush=True)
        time.sleep(delay)
        delay = min(delay * 2, 240)
    raise RuntimeError(f'failed: {url}')


def fetch_datasf_buildings():
    out_dir = os.path.join(RAW, 'datasf')
    os.makedirs(out_dir, exist_ok=True)
    fields = ('sf16_bldgid,gnd_min_m,gnd_meancm,gnd_rangecm,hgt_median_m,hgt_meancm,hgt_maxcm,hgt_mincm,hgt_stdcm,'
              'hgt_majoritycm,hgt_rangecm,peak_1st_m,median_1st_m,shape')
    page, size = 0, 50000
    while True:
        path = os.path.join(out_dir, f'buildings_{page:02d}.json')
        if not os.path.exists(path):
            print(f'DataSF buildings page {page}', flush=True)
            r = get_with_retry('https://data.sf.gov/resource/ynuv-fyni.json',
                               params={'$select': fields, '$order': ':id', '$limit': size, '$offset': page * size})
            rows = r.json()
            json.dump(rows, open(path, 'w'))
        else:
            rows = json.load(open(path))
        print(f'  page {page}: {len(rows)} rows', flush=True)
        if len(rows) < size:
            break
        page += 1


def fetch_datasf_trees():
    path = os.path.join(RAW, 'datasf', 'street_trees.json')
    if os.path.exists(path):
        print('street trees cached')
        return
    rows, page, size = [], 0, 50000
    while True:
        r = get_with_retry('https://data.sf.gov/resource/tkzw-k3nq.json',
                           params={'$select': 'treeid,species,planttype,latitude,longitude,dbhrange,mapdbh,siteinfo',
                                   '$order': ':id', '$limit': size, '$offset': page * size})
        part = r.json()
        rows += part
        print(f'  trees page {page}: {len(part)}', flush=True)
        if len(part) < size:
            break
        page += 1
    json.dump(rows, open(path, 'w'))


def fetch_osm():
    """Geofabrik NorCal extract (Overpass was overloaded; the pbf is parsed offline by city_osm.py)."""
    out_dir = os.path.join(RAW, 'osm')
    os.makedirs(out_dir, exist_ok=True)
    have = [f for f in os.listdir(out_dir) if f.startswith('norcal-') and f.endswith('.osm.pbf')]
    if have:
        print('OSM extract cached:', have[-1])
        return
    url = 'https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf'
    r = requests.get(url, headers=UA, stream=True, timeout=600, allow_redirects=True)
    r.raise_for_status()
    name = os.path.basename(r.url)
    tmp = os.path.join(out_dir, name + '.part')
    with open(tmp, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    os.rename(tmp, os.path.join(out_dir, name))
    print('downloaded', name)


if __name__ == '__main__':
    what = set(sys.argv[1:]) or {'datasf', 'trees', 'osm'}
    if 'datasf' in what:
        fetch_datasf_buildings()
    if 'trees' in what:
        fetch_datasf_trees()
    if 'osm' in what:
        fetch_osm()
    print('done')
