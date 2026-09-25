# Map data: Open Database License (ODbL) 1.0

The files in this directory are small map databases the game and the asset pipeline read: runways, landmark positions,
bridges, airport outlines and the map frames. Most of them are extracts of [OpenStreetMap](https://www.openstreetmap.org)
or Derivative Databases of it.

**Licence.** The Gökyüzü map data in `data/`, together with `blender/landmarks/layout.json` and
`blender/landmarks_ist/layout.json`, is made available under the Open Database License:
<https://opendatacommons.org/licenses/odbl/1-0/>. Any rights in individual contents of the database are licensed
under the Database Contents License: <https://opendatacommons.org/licenses/dbcl/1-0/>.

**Attribution.** Map data © OpenStreetMap contributors, available under the ODbL
(<https://www.openstreetmap.org/copyright>). Other sources are listed per file below and in [NOTICE](../NOTICE).

The code in this repository is under the Apache License 2.0 (see [LICENSE](../LICENSE)). That licence does **not**
apply to these data files. The ODbL does not apply to the code.

## What the ODbL asks of you

If you use this data publicly, or a database you made from it:

- **Attribute:** credit "© OpenStreetMap contributors" and this project wherever you use the data (the credits screen of
  a game is fine), and keep this notice with the files.
- **Share alike:** if you publicly use an adapted version of the database, offer that adapted database under the ODbL
  too.
- **Keep it open:** do not restrict access with technical measures unless you also offer an unrestricted version.

A picture, map or game world made from the data (a "Produced Work") may be under any licence, as long as it carries the
attribution. This is a summary, not the licence: the [full text](https://opendatacommons.org/licenses/odbl/1-0/)
decides.

## Files

| File | What it holds | Sources |
|---|---|---|
| `sf/region.json`, `ist/region.json` | Map frame: projection, origin, bounds | Project-defined |
| `sf/osm_aeroways_raw.json` | Raw Overpass extract: runways and aerodromes around the bay | OpenStreetMap |
| `sf/osm_alameda_raw.json` | Raw Overpass extract: Alameda coastline | OpenStreetMap |
| `sf/alameda_land_local.json` | Alameda land outline in local metres | OpenStreetMap |
| `sf/runways.json` | Runway ends, headings, elevations (San Francisco) | OpenStreetMap, OurAirports (public domain) |
| `sf/landmarks.json` | Landmark positions (San Francisco) | OpenStreetMap, project measurements |
| `ist/runways.json` | Runway ends, displaced thresholds, departure-only ends (İstanbul) | OpenStreetMap, DHMİ AIP Türkiye AD 2, OurAirports (public domain) |
| `ist/terrain_airports.json` | Terrain heights at each runway end (İstanbul) | The above, and the Copernicus DEM (see NOTICE) |
| `ist/bridges.json` | Bosphorus bridge axes, spans and deck heights | OpenStreetMap |
| `ist/landmarks.json` | Landmark positions (İstanbul) | OpenStreetMap |
| `ist/landmarks-exclude.json` | OSM ids and zones the generic city leaves to landmark models | OpenStreetMap |
| `../blender/landmarks/layout.json`, `../blender/landmarks_ist/layout.json` | Landmark layout for the Blender scripts | OpenStreetMap |

The scripts that make these files from the sources are in [`tools/geo/`](../tools/geo) and [`blender/`](../blender):
see [CONTRACTS-SF.md](../CONTRACTS-SF.md) and [CONTRACTS-IST.md](../CONTRACTS-IST.md). Downloaded raw data and caches
(`data/sf/raw/`, `data/sf/cache/`, `data/ist/_cache/`) are not committed.

**Not for navigation.** Runways, elevations and positions are simplified for a game. Do not use them for real-world
navigation.
