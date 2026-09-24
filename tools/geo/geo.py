"""Shared geo helpers for all Python pipelines (terrain, imagery, buildings, landmarks, airports).

Maps: GEO_REGION=<id> (default "sf") selects data/<id>/region.json; every pipeline writes to DATA_DIR / ASSETS_DIR.
  sf:  UTM zone 10N (EPSG:32610), origin SFO airport reference point
  ist: UTM zone 35N (EPSG:32635), origin Galata Kulesi
Local game coordinates: meters in the region's UTM zone (region.json "crs") relative to its origin.
  x = easting - E0          (east is +X)
  z = -(northing - N0)      (north is -Z)
  y = elevation in meters above mean sea level (NAVD88 ~ MSL)
The JS side (src/geo.js) uses the same constants. Never invent another projection.
"""
import json, os
from pyproj import Transformer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
REGION_ID = os.environ.get('GEO_REGION', 'sf')
DATA_DIR = os.path.join(ROOT, 'data', REGION_ID)        # small tracked data (region.json, runways.json, …)
ASSETS_DIR = os.path.join(ROOT, 'assets', REGION_ID)    # generated assets (not in git)
REGION = json.load(open(os.path.join(DATA_DIR, 'region.json')))
CRS = REGION.get('crs', 'EPSG:32610')
E0, N0 = REGION['originUTM']
_fwd = Transformer.from_crs('EPSG:4326', CRS, always_xy=True)
_inv = Transformer.from_crs(CRS, 'EPSG:4326', always_xy=True)

def lonlat_to_local(lon, lat):
    e, n = _fwd.transform(lon, lat)
    return e - E0, -(n - N0)

def local_to_lonlat(x, z):
    return _inv.transform(x + E0, N0 - z)

def lonlat_to_utm(lon, lat):
    return _fwd.transform(lon, lat)
