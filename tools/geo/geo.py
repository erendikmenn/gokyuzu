"""Shared geo helpers for all Python pipelines (terrain, imagery, buildings, landmarks, airports).

Local game coordinates: meters in UTM zone 10N (EPSG:32610) relative to ORIGIN (SFO airport reference point).
  x = easting - E0          (east is +X)
  z = -(northing - N0)      (north is -Z)
  y = elevation in meters above mean sea level (NAVD88 ~ MSL)
The JS side (src/geo.js) uses the same constants. Never invent another projection.
"""
import json, os
from pyproj import Transformer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
REGION = json.load(open(os.path.join(ROOT, 'data', 'sf', 'region.json')))
E0, N0 = REGION['originUTM']
_fwd = Transformer.from_crs('EPSG:4326', 'EPSG:32610', always_xy=True)
_inv = Transformer.from_crs('EPSG:32610', 'EPSG:4326', always_xy=True)

def lonlat_to_local(lon, lat):
    e, n = _fwd.transform(lon, lat)
    return e - E0, -(n - N0)

def local_to_lonlat(x, z):
    return _inv.transform(x + E0, N0 - z)

def lonlat_to_utm(lon, lat):
    return _fwd.transform(lon, lat)
