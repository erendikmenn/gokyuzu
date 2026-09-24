"""Runway data for a map without a lead-written runways.json: data/<map>/runways.json from OpenStreetMap + AIP values.

  GEO_REGION=ist .venv/bin/python tools/geo/airports_runways.py

Same format as data/sf/runways.json (CONTRACTS-SF §1): per airport icao, name, elevation (m MSL), military, center; per
runway id "16R/34L", width, length, surface, elevation, center, ends = the two physical pavement ends (x, z local) with
the ident whose landing / take-off direction starts there and headingTrue = direction of flight from that end.

Geometry: OSM aeroway=runway ways (pieces of one runway joined; runway=displaced_threshold pieces extend the pavement,
their length becomes the end's displaced threshold, see airports_build.py). Runways tagged construction / disused are
left out (LTFM's future 6th runway "09"). headingTrue is the direction between the ends in the local frame, i.e. the
game's north (UTM grid north), as for San Francisco; the geodetic true bearing (grid + meridian convergence, about
+1.1° at İstanbul) is kept in `headingGeo` for reference. Widths from OSM `width` (AIP values where missing).
Elevations: AIP aerodrome elevations; each runway gets the Copernicus GLO-30 median along its centreline when that
profile is smooth (std < 4 m). The DEM (TanDEM-X 2011-2015) predates LTFM and LTFJ's 06R/24L: their profiles swing by
50-130 m (open-pit mines, hills), so those runways get the AIP aerodrome elevation and the terrain has to be flattened
over the whole aerodrome, not only the runway strips.
"""
import glob, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import lonlat_to_local, local_to_lonlat, DATA_DIR, REGION_ID, CRS  # noqa: E402
from airports_lib import RAW_OSM  # noqa: E402
from pyproj import Geod  # noqa: E402

FT = 0.3048
AIRPORTS = {
    'ist': [
        # AIP Türkiye AD 2.2 aerodrome elevations: LTFM 325 ft, LTFJ 312 ft, LTBA 163 ft
        {'icao': 'LTFM', 'name': 'İstanbul Havalimanı', 'elevation': round(325 * FT, 1), 'military': False},
        {'icao': 'LTFJ', 'name': 'Sabiha Gökçen Havalimanı', 'elevation': round(312 * FT, 1), 'military': False},
        {'icao': 'LTBA', 'name': 'Atatürk Havalimanı', 'elevation': round(163 * FT, 1), 'military': False},
    ],
}
DECLINATION = {'ist': 6.3}        # WMM, 2026, İstanbul: +6.3° (east)
WIDTH = {'LTFM': {'16R/34L': 60, '17L/35R': 60, '16L/34R': 45, '17R/35L': 45, '18/36': 45},
         'LTFJ': {'06L/24R': 45, '06R/24L': 60}, 'LTBA': {'05/23': 60}}


def ident_nums(ref):
    a, b = ref.split('/')
    num = lambda s: int(''.join(c for c in s if c.isdigit()))
    return (a, num(a)), (b, num(b))


def heading(ax, az, bx, bz):
    return math.degrees(math.atan2(bx - ax, -(bz - az))) % 360


def join_pieces(pieces):
    """Chain line pieces (lists of (x, z)) sharing endpoints into one polyline."""
    pieces = [list(p) for p in pieces]
    line = pieces.pop(0)
    while pieces:
        for k, p in enumerate(pieces):
            if np.hypot(*np.subtract(p[0], line[-1])) < 1.0:
                line += p[1:]
            elif np.hypot(*np.subtract(p[-1], line[-1])) < 1.0:
                line += p[::-1][1:]
            elif np.hypot(*np.subtract(p[-1], line[0])) < 1.0:
                line = p + line[1:]
            elif np.hypot(*np.subtract(p[0], line[0])) < 1.0:
                line = p[::-1] + line[1:]
            else:
                continue
            pieces.pop(k)
            break
        else:
            break
    return line


def dem_sampler():
    """Copernicus GLO-30 heights (tiles cached by the terrain pipeline or here), or None."""
    try:
        import rasterio
    except ImportError:
        return None
    tiles = sorted(set(glob.glob(os.path.join(DATA_DIR, 'raw', '**', 'Copernicus_DSM_COG_10_*_DEM.tif'), recursive=True) +
                       glob.glob(os.path.join(os.path.dirname(RAW_OSM), 'dem', '*.tif'))))
    if not tiles:
        return None
    ds = [rasterio.open(t) for t in tiles]

    def h(lon, lat):
        for d in ds:
            b = d.bounds
            if b.left <= lon <= b.right and b.bottom <= lat <= b.top:
                return float(next(d.sample([(lon, lat)]))[0])
        return None
    return h


def fetch_dem(lons, lats):
    """Download the Copernicus GLO-30 1° tiles covering the airports (AWS Open Data, anonymous HTTPS)."""
    import requests
    out = os.path.join(os.path.dirname(RAW_OSM), 'dem')
    os.makedirs(out, exist_ok=True)
    for lat in sorted({math.floor(v) for v in lats}):
        for lon in sorted({math.floor(v) for v in lons}):
            name = f'Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM'
            path = os.path.join(out, name + '.tif')
            if os.path.exists(path):
                continue
            url = f'https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif'
            r = requests.get(url, headers={'User-Agent': 'gokyuzu-sf-pipeline/1.0'}, timeout=300)
            r.raise_for_status()
            open(path, 'wb').write(r.content)
            print('DEM', name, len(r.content) // 1024, 'KB')


def main():
    out_airports = []
    all_ll = []
    runs = {}
    for apt in AIRPORTS[REGION_ID]:
        els = json.load(open(os.path.join(RAW_OSM, f'airports_{apt["icao"].lower()}.json')))['elements']
        by_ref, disp_pieces = {}, []
        for e in els:
            t = e.get('tags', {})
            if e['type'] != 'way' or t.get('aeroway') != 'runway':
                continue
            if t.get('runway') == 'displaced_threshold' and 'ref' not in t:
                disp_pieces.append([lonlat_to_local(g['lon'], g['lat']) for g in e['geometry']])
                continue
            if t.get('construction') == 'yes' or 'disused' in t or 'abandoned' in t or 'ref' not in t:
                continue
            pts = [lonlat_to_local(g['lon'], g['lat']) for g in e['geometry']]
            by_ref.setdefault(t['ref'], []).append((pts, t))
            all_ll += [(g['lon'], g['lat']) for g in e['geometry']]
        runs[apt['icao']] = (by_ref, disp_pieces)
    try:
        lons, lats = zip(*all_ll)
        fetch_dem(lons, lats)
    except Exception as ex:  # offline: aerodrome elevations only
        print('DEM download skipped:', ex)
    dem = dem_sampler()
    for apt in AIRPORTS[REGION_ID]:
        by_ref, disp_pieces = runs[apt['icao']]
        rws = []
        for ref, pieces in sorted(by_ref.items()):
            line = join_pieces([p for p, _ in pieces])
            tags = pieces[0][1]
            a, b = np.array(line[0]), np.array(line[-1])
            disp = {}
            for dp in disp_pieces:      # displaced-threshold pavement continuing the runway beyond an end
                for which in (0, 1):
                    end = a if which == 0 else b
                    for q0, q1 in ((dp[0], dp[-1]), (dp[-1], dp[0])):
                        if np.hypot(*np.subtract(q0, end)) < 2.0:
                            ext = np.array(q1)
                            if which == 0:
                                a = ext
                            else:
                                b = ext
                            disp[which] = disp.get(which, 0.0) + float(np.hypot(*np.subtract(q1, q0)))
            L = float(np.hypot(*(b - a)))
            h_ab = heading(a[0], a[1], b[0], b[1])
            (i1, n1), (i2, n2) = ident_nums(ref)
            d = lambda x, y: abs((x - y + 180) % 360 - 180)
            # ident i1 belongs to the end whose departure heading is closest to its number x 10
            if d(h_ab, n1 * 10) <= d((h_ab + 180) % 360, n1 * 10):
                ea, eb = i1, i2
            else:
                ea, eb = i2, i1
            elev = apt['elevation']
            if dem:
                hs = []
                for s in np.linspace(0.05, 0.95, 19):
                    lon, lat = local_to_lonlat(*(a + (b - a) * s))
                    v = dem(lon, lat)
                    if v is not None and v > -50:
                        hs.append(v)
                # the DEM (TanDEM-X 2011-2015) predates LTFM and LTFJ's second runway: a rough profile along a runway
                # means the pavement is newer than the DEM -> the AIP aerodrome elevation (one plateau per airport)
                if len(hs) >= 10 and float(np.std(hs)) < 4.0:
                    elev = round(float(np.median(hs)), 1)
            w = float(tags.get('width') or WIDTH.get(apt['icao'], {}).get(ref, 45))
            geo_a = local_to_lonlat(*a)
            geo_b = local_to_lonlat(*b)
            az_ab = Geod(ellps='WGS84').inv(geo_a[0], geo_a[1], geo_b[0], geo_b[1])[0] % 360
            ends = [{'ident': ea, 'x': round(float(a[0]), 2), 'z': round(float(a[1]), 2), 'headingTrue': round(h_ab, 2),
                     'headingGeo': round(az_ab, 2)},
                    {'ident': eb, 'x': round(float(b[0]), 2), 'z': round(float(b[1]), 2), 'headingTrue': round((h_ab + 180) % 360, 2),
                     'headingGeo': round((az_ab + 180) % 360, 2)}]
            for which in (0, 1):
                if which in disp:
                    ends[which]['displaced'] = round(disp[which], 1)
            surf = 'concrete' if 'beton' in (tags.get('surface') or '') and 'asf' not in (tags.get('surface') or '') else 'asphalt'
            rws.append({'id': ref, 'width': w, 'length': round(L, 1), 'surface': surf, 'elevation': elev,
                        'center': {'x': round(float((a[0] + b[0]) / 2), 2), 'z': round(float((a[1] + b[1]) / 2), 2)}, 'ends': ends})
            print(f"{apt['icao']} {ref:8s} {L:7.1f} m x {w:.0f}  hdg {h_ab:6.2f} (geo {az_ab:6.2f})  elev {elev} m  disp {disp}")
        cx = float(np.mean([r['center']['x'] for r in rws]))
        cz = float(np.mean([r['center']['z'] for r in rws]))
        out_airports.append({**apt, 'center': {'x': round(cx, 1), 'z': round(cz, 1)}, 'runways': rws})
    res = {'note': 'Generated by tools/geo/airports_runways.py from OpenStreetMap (© OpenStreetMap contributors, ODbL) + AIP '
                   'aerodrome elevations. Local coords per data/' + REGION_ID + '/region.json. ends[i] = physical runway end '
                   '(displaced threshold distance in `displaced`); headingTrue = direction of flight when departing from that '
                   'end in the local frame (grid north, as the game flies); headingGeo = geodetic true bearing. Terrain must be '
                   'flattened to `elevation` over each runway rectangle (+ shoulders).',
           'magneticDeclination': DECLINATION[REGION_ID], 'airports': out_airports}
    path = os.path.join(DATA_DIR, 'runways.json')
    json.dump(res, open(path, 'w'), indent=1, ensure_ascii=False)
    print('wrote', path)


if __name__ == '__main__':
    main()
