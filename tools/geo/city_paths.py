"""Paths of the city pipeline per map (GEO_REGION, see tools/geo/geo.py).

  sf  : raw downloads data/sf/raw, intermediates data/sf/cache/city, output assets/sf/city        (as before)
  ist : raw downloads + intermediates under assets/ist/city/_cache/ (gitignored through /assets/, never published:
        tools/deploy/build_dist.mjs skips directories starting with "_"), output assets/ist/city
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import ROOT, REGION_ID, DATA_DIR, ASSETS_DIR, REGION, CRS  # noqa: E402,F401

OUT = os.path.join(ASSETS_DIR, 'city')
if REGION_ID == 'sf':
    RAW = os.path.join(DATA_DIR, 'raw')
    CACHE = os.path.join(DATA_DIR, 'cache', 'city')
else:
    RAW = os.path.join(OUT, '_cache', 'raw')
    CACHE = os.path.join(OUT, '_cache', 'city')
