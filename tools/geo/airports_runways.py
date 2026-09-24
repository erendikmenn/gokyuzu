"""Runway data for a map without a lead-written runways.json: data/<map>/runways.json from OpenStreetMap + AIP values.

  GEO_REGION=ist .venv/bin/python tools/geo/airports_runways.py

Same format as data/sf/runways.json (CONTRACTS-SF §1): per airport icao, name, elevation (m MSL), military, center; per
runway id "16R/34L", width, length, surface, elevation, center, ends = the two physical pavement ends (x, z local) with
the ident whose landing / take-off direction starts there and headingTrue = direction of flight from that end.

Geometry: OSM aeroway=runway ways (pieces of one runway joined; runway=displaced_threshold pieces extend the pavement,
their length becomes the end's displaced threshold, see airports_build.py). Runways tagged construction / disused are
left out. Runways with published thresholds (AIP_ENDS: all of them today) take the AIP geometry instead, LTFM's RWY
09 (opened 18 Sep 2026, still construction=yes in OSM) included. headingTrue is the direction between the ends in the local frame, i.e. the
game's north (UTM grid north), as for San Francisco; the geodetic true bearing (grid + meridian convergence, about
+1.1° at İstanbul) is kept in `headingGeo` for reference. Widths from OSM `width` (AIP values where missing).
Elevations: AIP aerodrome elevations. Per runway END (`ends[k].elevation`, m MSL): the published AIP THR elevations
(AIP_ENDS), for runways without them the published end elevations from OurAirports (public domain runways.csv,
cached; its LTFJ 06R value, 289 ft, is wrong: AIP 270 ft); the terrain turns them into sloped runways (LTFM falls ~0.9 %
from 99 m in the south to 62-67 m in the north). The runway `elevation` (San Francisco's single value, read by code that
does not know per-end values) is the HIGHER end, so such code errs above the ground, never below it. Without a published value an end gets the Copernicus
GLO-30 median along the centreline when that profile is smooth (std < 4 m), else the aerodrome elevation. The DEM (TanDEM-X 2011-2015) predates LTFM and LTFJ's 06R/24L: their profiles swing by
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
        # AIP Türkiye AD 2.2 aerodrome elevations: LTFM 325 ft, LTFJ 312 ft, LTBA 94 ft (163 ft until 17/35 closed)
        {'icao': 'LTFM', 'name': 'İstanbul Havalimanı', 'elevation': round(325 * FT, 1), 'military': False},
        {'icao': 'LTFJ', 'name': 'Sabiha Gökçen Havalimanı', 'elevation': round(312 * FT, 1), 'military': False},
        {'icao': 'LTBA', 'name': 'Atatürk Havalimanı', 'elevation': round(94 * FT, 1), 'military': False},
    ],
}
DECLINATION = {'ist': 6.3}        # WMM, 2026, İstanbul: +6.3° (east)
# Published runway thresholds (AIP Türkiye AD 2.12, DHMİ https://www.dhmi.gov.tr/AIPDocuments/LT_AD_2_<ICAO>_en.pdf:
# LTFM AMDT 08/26, LTFJ AMDT 11/24 + ADC AMDT 07/26, LTBA AMDT 04/26). They replace the OSM geometry of these runways:
# ident: (lat, lon, THR elevation ft, displaced threshold m). A displaced threshold's pavement end lies that far
# before the THR coordinate along the runway (LTBA 05: 130 m, LDA 2450 of 2580 m). LTFM's RWY 09 (opened 18 Sep 2026,
# 2820 x 45 m concrete, departures only: AIP AD 2.20; no "27" in the AIP, no approach / threshold lights, no PAPI):
# its far end is computed from the THR, 089.15 deg true and 2820 m (41.254066, 28.799915; OurAirports 41.254063,
# 28.800018), the far-end elevation is not published (slope 0.04 %: the THR value).
AIP_ENDS = {
    'LTFM': {
        '16L/34R': {'34R': (41.264875, 28.709925, 325, 0), '16L': (41.298631, 28.709258, 218, 0)},
        '16R/34L': {'34L': (41.264847, 28.707419, 325, 0), '16R': (41.298603, 28.706753, 219, 0)},
        '17L/35R': {'35R': (41.261922, 28.727761, 310, 0), '17L': (41.298831, 28.727044, 202, 0)},
        '17R/35L': {'35L': (41.261894, 28.725256, 310, 0), '17R': (41.298803, 28.724536, 202, 0)},
        '18/36': {'36': (41.262244, 28.756700, 309, 0), '18': (41.289792, 28.756178, 221, 0)},
        '09/27': {'09': (41.253694, 28.766272, 274, 0), '27': (41.254066, 28.799915, 274, 0)},
    },
    'LTFJ': {
        '06L/24R': {'06L': (40.892653, 29.293214, 292, 0), '24R': (40.904447, 29.325242, 304, 0)},
        '06R/24L': {'06R': (40.884847, 29.302592, 270, 0), '24L': (40.898761, 29.340383, 308, 0)},
    },
    'LTBA': {
        '05/23': {'05': (40.966264, 28.811319, 93, 130.0), '23': (40.977764, 28.836156, 90, 0)},
    },
}
AIP_RUNWAY = {   # surface (AIP AD 2.12), departure-only runways (AD 2.20)
    ('LTFM', '09/27'): {'surface': 'concrete', 'departureOnly': True},
    ('LTFJ', '06L/24R'): {'surface': 'concrete'}, ('LTFJ', '06R/24L'): {'surface': 'concrete'},
}
WIDTH = {'LTFM': {'16R/34L': 60, '17L/35R': 60, '16L/34R': 45, '17R/35L': 45, '18/36': 45, '09/27': 45},
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


def published_ends():
    """{(icao, ident): elevation m} from OurAirports runways.csv (public domain, AIP values), cached."""
    import csv
    import requests
    path = os.path.join(os.path.dirname(RAW_OSM), 'raw', 'ourairports_runways.csv')
    if not os.path.exists(path):
        try:
            r = requests.get('https://davidmegginson.github.io/ourairports-data/runways.csv',
                             headers={'User-Agent': 'gokyuzu-sf-pipeline/1.0'}, timeout=120)
            r.raise_for_status()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, 'wb').write(r.content)
        except Exception as ex:   # offline: DEM / aerodrome elevations only
            print('OurAirports download skipped:', ex)
            return {}
    out = {}
    for row in csv.DictReader(open(path, encoding='utf-8')):
        if row.get('closed') == '1':
            continue
        for k in ('le', 'he'):
            v = row.get(f'{k}_elevation_ft')
            if v:
                out[(row['airport_ident'], row[f'{k}_ident'])] = round(float(v) * FT, 2)
    return out


def aip_runway(icao, ref, tags):
    """runways.json entry from the published thresholds (AIP_ENDS): pavement ends, headings, end elevations."""
    (ia, (la_a, lo_a, fa, da)), (ib, (la_b, lo_b, fb, db)) = AIP_ENDS[icao][ref].items()
    ta, tb = np.array(lonlat_to_local(lo_a, la_a)), np.array(lonlat_to_local(lo_b, la_b))
    d = (tb - ta) / np.linalg.norm(tb - ta)
    a, b = ta - d * da, tb + d * db                  # pavement ends (displaced thresholds lie inside)
    h_ab = heading(a[0], a[1], b[0], b[1])
    geo_a, geo_b = local_to_lonlat(*a), local_to_lonlat(*b)
    az_ab = Geod(ellps='WGS84').inv(geo_a[0], geo_a[1], geo_b[0], geo_b[1])[0] % 360
    ends = [{'ident': ia, 'x': round(float(a[0]), 2), 'z': round(float(a[1]), 2), 'headingTrue': round(h_ab, 2),
             'headingGeo': round(az_ab, 2), 'elevation': round(fa * FT, 1)},
            {'ident': ib, 'x': round(float(b[0]), 2), 'z': round(float(b[1]), 2), 'headingTrue': round((h_ab + 180) % 360, 2),
             'headingGeo': round((az_ab + 180) % 360, 2), 'elevation': round(fb * FT, 1)}]
    if da:
        ends[0]['displaced'] = round(da, 1)
    if db:
        ends[1]['displaced'] = round(db, 1)
    extra = AIP_RUNWAY.get((icao, ref), {})
    w = float((tags or {}).get('width') or WIDTH.get(icao, {}).get(ref, 45))
    surf = extra.get('surface') or ('concrete' if 'beton' in ((tags or {}).get('surface') or '') and 'asf' not in ((tags or {}).get('surface') or '') else 'asphalt')
    rw = {'id': ref, 'width': w, 'length': round(float(np.linalg.norm(b - a)), 1), 'surface': surf,
          'elevation': round(max(fa, fb) * FT, 1), 'center': {'x': round(float((a[0] + b[0]) / 2), 2), 'z': round(float((a[1] + b[1]) / 2), 2)},
          'ends': ends}
    if extra.get('departureOnly'):
        rw['departureOnly'] = True
        for e in ends:
            e['landing'] = False
    print(f"{icao} {ref:8s} {rw['length']:7.1f} m x {w:.0f}  hdg {h_ab:6.2f} (geo {az_ab:6.2f})  AIP ends "
          f"{[(e['ident'], e['elevation'], e.get('displaced')) for e in ends]}{'  departures only' if extra.get('departureOnly') else ''}")
    return rw


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
    pub = published_ends()
    for apt in AIRPORTS[REGION_ID]:
        by_ref, disp_pieces = runs[apt['icao']]
        rws = []
        aip = AIP_ENDS.get(apt['icao'], {}) if REGION_ID == 'ist' else {}
        for ref in aip:                    # (end order as the OSM-built file had it: missions / spawns read ends[0])
            rws.append(aip_runway(apt['icao'], ref, by_ref[ref][0][1] if ref in by_ref else None))
        for ref, pieces in sorted(by_ref.items()):
            if ref in aip:
                continue
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
            pe = [pub.get((apt['icao'], e['ident'])) for e in ends]
            if all(v is not None for v in pe):
                for e, v in zip(ends, pe):
                    e['elevation'] = round(v, 1)
                elev = round(max(pe), 1)     # the higher end: one-value readers err on the safe side (above ground)
            surf = 'concrete' if 'beton' in (tags.get('surface') or '') and 'asf' not in (tags.get('surface') or '') else 'asphalt'
            rws.append({'id': ref, 'width': w, 'length': round(L, 1), 'surface': surf, 'elevation': elev,
                        'center': {'x': round(float((a[0] + b[0]) / 2), 2), 'z': round(float((a[1] + b[1]) / 2), 2)}, 'ends': ends})
            print(f"{apt['icao']} {ref:8s} {L:7.1f} m x {w:.0f}  hdg {h_ab:6.2f} (geo {az_ab:6.2f})  elev {elev} m  "
                  f"ends {[(e['ident'], e.get('elevation')) for e in ends]}  disp {disp}")
        cx = float(np.mean([r['center']['x'] for r in rws]))
        cz = float(np.mean([r['center']['z'] for r in rws]))
        out_airports.append({**apt, 'center': {'x': round(cx, 1), 'z': round(cz, 1)}, 'runways': rws})
    res = {'note': 'Generated by tools/geo/airports_runways.py from OpenStreetMap (© OpenStreetMap contributors, ODbL) + AIP '
                   'aerodrome elevations. Local coords per data/' + REGION_ID + '/region.json. ends[i] = physical runway end '
                   '(displaced threshold distance in `displaced`); headingTrue = direction of flight when departing from that '
                   'end in the local frame (grid north, as the game flies); headingGeo = geodetic true bearing. ends[i].elevation = '
                   'published (AIP / OurAirports) end elevation, m MSL: the terrain slopes each runway linearly between its ends; '
                   'runway elevation = the higher end (for code that reads one value; prefer ends[i].elevation).',
           'magneticDeclination': DECLINATION[REGION_ID], 'airports': out_airports}
    path = os.path.join(DATA_DIR, 'runways.json')
    json.dump(res, open(path, 'w'), indent=1, ensure_ascii=False)
    print('wrote', path)


if __name__ == '__main__':
    main()
