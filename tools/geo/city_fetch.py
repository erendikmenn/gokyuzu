"""W2 city: download raw public data for buildings and vegetation (cached, re-runnable).

  .venv/bin/python tools/geo/city_fetch.py [datasf] [trees] [osm]      (no args = everything)
  GEO_REGION=ist .venv/bin/python tools/geo/city_fetch.py [osm] [overture]

Sources
  DataSF "Building Footprints" (ynuv-fyni): 177k footprints with 2010 LiDAR height statistics
  DataSF "Street Tree List" (tkzw-k3nq): ~144k street trees with species
  OpenStreetMap (Geofabrik NorCal extract, parsed by city_osm.py): buildings/building parts, landuse / natural / leisure
  polygons (parks, forests, scrub), natural=tree nodes, highways (street-front detection, palm avenues).
Cache: data/sf/raw/datasf/*.json, data/sf/raw/osm/norcal-*.osm.pbf

İstanbul (GEO_REGION=ist, CONTRACTS-IST.md): OpenStreetMap = Geofabrik Turkey extract (downloaded once, parsed by
city_osm.py); Overture Maps buildings (AWS Open Data, anonymous S3, no account / profile): only the parquet row groups
whose bbox statistics intersect the region are read, filtered to the bbox and cached per source file.
Cache: assets/ist/city/_cache/raw/{osm/turkey-*.osm.pbf, overture/*.parquet} (gitignored, never published).
"""
import json, os, sys, time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from city_paths import ROOT, RAW, REGION_ID, REGION  # noqa: E402

UA = {'User-Agent': 'GokyuzuSF-city-pipeline/1.0 (offline flight-sim asset build)'} if REGION_ID == 'sf' else \
    {'User-Agent': 'gokyuzu-sf-pipeline/1.0'}
BBOX = (-122.56, 37.55, -122.14, 37.87)   # region.json bboxLonLat (W, S, E, N)
if REGION_ID != 'sf':
    BBOX = tuple(REGION['bboxLonLat'])
GEOFABRIK = {'sf': 'north-america/us/california/norcal', 'ist': 'europe/turkey'}
OVERTURE_RELEASE = '2026-09-23.0'


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
    """Geofabrik extract (NorCal / Turkey; Overpass was overloaded; the pbf is parsed offline by city_osm.py)."""
    out_dir = os.path.join(RAW, 'osm')
    os.makedirs(out_dir, exist_ok=True)
    stem = GEOFABRIK[REGION_ID].rsplit('/', 1)[1]
    have = [f for f in os.listdir(out_dir) if f.startswith(stem + '-') and f.endswith('.osm.pbf')]
    if have:
        print('OSM extract cached:', have[-1])
        return
    url = f'https://download.geofabrik.de/{GEOFABRIK[REGION_ID]}-latest.osm.pbf'
    r = requests.get(url, headers=UA, stream=True, timeout=600, allow_redirects=True)
    r.raise_for_status()
    name = os.path.basename(r.url)
    tmp = os.path.join(out_dir, name + '.part')
    with open(tmp, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    os.rename(tmp, os.path.join(out_dir, name))
    print('downloaded', name)


OVERTURE_COLS = ['id', 'sources', 'height', 'min_height', 'num_floors', 'min_floor', 'subtype', 'class', 'roof_shape',
                  'roof_height', 'roof_color', 'facade_color', 'is_underground', 'has_parts', 'geometry', 'bbox']


def fetch_overture(jobs=24):
    """Overture Maps buildings inside the region bbox (anonymous S3; pyarrow reads only the matching row groups)."""
    import concurrent.futures as cf
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq
    import pyarrow.compute as pc
    out_dir = os.path.join(RAW, 'overture')
    os.makedirs(out_dir, exist_ok=True)
    for k in ('AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'):
        os.environ.pop(k, None)       # public open data: never the shell's profile / credentials
    s3 = pafs.S3FileSystem(anonymous=True, region='us-west-2')
    prefix = f'overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=buildings/type=building/'
    files = sorted(f.path for f in s3.get_file_info(pafs.FileSelector(prefix)) if f.path.endswith('.parquet'))
    W, S, E, N = BBOX
    print(f'Overture {OVERTURE_RELEASE}: {len(files)} files', flush=True)

    def one(path):
        name = os.path.basename(path).split('-')[1]
        dst = os.path.join(out_dir, f'buildings_{name}.parquet')
        done = dst + '.none'
        if os.path.exists(dst) or os.path.exists(done):
            return name, -1
        for attempt in range(6):
            try:
                f = pq.ParquetFile(path, filesystem=s3)
                md = f.metadata
                names = [md.row_group(0).column(i).path_in_schema for i in range(md.num_columns)]
                ix = {k: names.index(f'bbox.{k}') for k in ('xmin', 'xmax', 'ymin', 'ymax')}
                rgs = []
                for r in range(md.num_row_groups):
                    rg = md.row_group(r)
                    st = {k: rg.column(i).statistics for k, i in ix.items()}
                    if any(v is None for v in st.values()):
                        rgs.append(r)
                        continue
                    if st['xmin'].min <= E and st['xmax'].max >= W and st['ymin'].min <= N and st['ymax'].max >= S:
                        rgs.append(r)
                if not rgs:
                    open(done, 'w').close()
                    return name, 0
                t = f.read_row_groups(rgs, columns=OVERTURE_COLS)
                b = t.column('bbox')
                m = pc.and_(pc.and_(pc.less_equal(pc.struct_field(b, 'xmin'), E), pc.greater_equal(pc.struct_field(b, 'xmax'), W)),
                            pc.and_(pc.less_equal(pc.struct_field(b, 'ymin'), N), pc.greater_equal(pc.struct_field(b, 'ymax'), S)))
                t = t.filter(m)
                if t.num_rows == 0:
                    open(done, 'w').close()
                    return name, 0
                pq.write_table(t, dst + '.part', compression='zstd')
                os.rename(dst + '.part', dst)
                return name, t.num_rows
            except Exception as e:  # network hiccup
                print(f'  {name}: {e} (retry)', flush=True)
                time.sleep(5 * (attempt + 1))
        raise RuntimeError(f'overture {path} failed')

    t0 = time.time()
    total = 0
    with cf.ThreadPoolExecutor(jobs) as ex:
        for name, n in ex.map(one, files):
            if n > 0:
                total += n
                print(f'  part {name}: {n} buildings ({time.time() - t0:.0f} s)', flush=True)
    print(f'Overture: {total} new buildings in bbox ({time.time() - t0:.0f} s)')


if __name__ == '__main__':
    if REGION_ID != 'sf':
        what = set(sys.argv[1:]) or {'osm', 'overture'}
        if 'osm' in what:
            fetch_osm()
        if 'overture' in what:
            fetch_overture()
        print('done')
        sys.exit(0)
    what = set(sys.argv[1:]) or {'datasf', 'trees', 'osm'}
    if 'datasf' in what:
        fetch_datasf_buildings()
    if 'trees' in what:
        fetch_datasf_trees()
    if 'osm' in what:
        fetch_osm()
    print('done')
