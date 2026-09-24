# İstanbul map — contract (wave 7)

The second map of Gökyüzü SF. Same engine, same asset formats as the San Francisco map, a second region pack.
Map id `ist`, selected with `?map=ist` and from the menu. San Francisco (`sf`) stays exactly as it is.

## 1. Frame
- `data/ist/region.json` (written, do not change the bounds without the lead): UTM 35N (EPSG:32635), origin
  Galata Kulesi (28.974167 E, 41.025556 N), bbox 28.62–29.40 E / 40.82–41.37 N, local rectangle
  x −29354 … 34747, z −37627 … 21924 (64 × 60 km). Axes as in San Francisco: x = east, z = −north, y = m MSL.
- Python pipelines: `GEO_REGION=ist` → `tools/geo/geo.py` loads `data/ist/region.json`, projects with its `crs` and
  exposes `REGION_ID`, `DATA_DIR` (`data/ist`) and `ASSETS_DIR` (`assets/ist`). Every pipeline script writes there
  instead of hard-coded `data/sf` / `assets/sf`. With `GEO_REGION` unset everything is San Francisco as before.
- Reference points (local m): İstanbul Havalimanı (LTFM) ≈ (−19245, −27327), Atatürk (LTBA) ≈ (−13303, 5693),
  Sabiha Gökçen (LTFJ) ≈ (28541, 13403), Yavuz Sultan Selim Köprüsü ≈ (11337, −19988).

## 2. Data (free sources only)
| Layer | Source | Notes |
|---|---|---|
| Elevation | Copernicus DEM GLO-30 (AWS Open Data `copernicus-dem-30m`, no account) | 30 m; airports flattened from their OSM geometry |
| Imagery | Sentinel-2 L2A (AWS Open Data, Element84 Earth Search STAC, no account) | 10 m, a cloud-free summer composite; colour-matched to the SF look |
| Water / coast | OpenStreetMap coastline + water polygons | Boğaz, Haliç, Marmara, Karadeniz; flat water like San Francisco |
| Buildings | OpenStreetMap + Overture Maps buildings (AWS Open Data) | heights: `height` / `building:levels`, else estimated by district / land use |
| Airports | OpenStreetMap | LTFM (5 runways), LTFJ, LTBA in its **current** state (as mapped in OSM) |
| Landmarks | OpenStreetMap geometry (+ building:part 3D where mapped) + procedural generators | see §4 |

Attribution shown in the menu for this map: © OpenStreetMap contributors (ODbL), Overture Maps Foundation,
Copernicus Sentinel data / Copernicus DEM (ESA). No paid, key-gated or restrictive sources (Google / Esri / Bing / Mapbox).

## 3. Layout (mirror San Francisco; the engine swaps the base path)
- `assets/ist/{terrain,city,airports,landmarks}/…` — generated, not in git, same file formats and index files as
  `assets/sf/…`, KTX2 textures through `tools/assets`, quantized / meshopt geometry.
- `data/ist/…` — small tracked data in the same formats as `data/sf/…` (`runways.json`, landmark / bridge data, …).
- `data/ist/bridges.json` — for missions and collision: per bridge `{ id, name, x, z, axis (deg true), half (tower
  spacing / 2), deck: [{ s (m along the axis), bottom (m MSL) }], towerTop }`.

## 4. Ownership (parallel agents; edit only your own files, append only your own section below)
| Agent | Owns |
|---|---|
| Engine | `src/**` except `src/missions/ist/**` and `src/missions/objectives.js`; `src/geo.js`; map registry + menu map choice; `tools/build`, `tools/deploy` (assets/ist in the build and sync); engine tests |
| Terrain | `tools/geo/terrain_*.py`, `tools/geo/imagery_*.py`; `assets/ist/terrain/**`; terrain data in `data/ist` |
| Airports + city | `tools/geo/airports_*.py`, `tools/geo/city_*.py`; `assets/ist/{airports,city}/**`; `data/ist/runways.json` + airport data |
| Landmarks | `tools/geo/landmarks_*.py` + new generators; `assets/ist/landmarks/**`; `data/ist/bridges.json` + landmark data |
| Missions | `src/missions/ist/**`, `src/missions/objectives.js` (new objective types), `tests/missions-ist.test.mjs`, `infra/leaderboard/build_rules.mjs` (ist boards) |

Shared and fixed: `tools/geo/geo.py`, `data/ist/region.json`, this file's §1–§5.

## 5. Rules
- San Francisco must not change: SF pipelines are not re-run; every existing test passes; the SF live check is unchanged.
- Phones first: the same quality classes as San Francisco; at a given quality the İstanbul city/landmark draw calls,
  triangles and texture memory stay within San Francisco's; first playable download ≤ San Francisco's + 20 %.
- Mission ids `ist-<name>`, free-flight boards `ff-ist-<name>`; telemetry events carry `map: 'ist'`.
- Commit on `dev` with explicit pathspecs, never push or deploy; the lead integrates and ships to staging.

## 6. Sections by agent
(appended by each agent: what exists, formats, how to rebuild)
