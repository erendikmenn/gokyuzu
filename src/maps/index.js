// Map registry (CONTRACTS-IST.md §6 Engine): the maps the engine flies. A map = region frame (data/<id>/region.json),
// asset base (assets/<id>/), data base (data/<id>/: runways.json, landmarks.json, …), start points, world features and
// its UI / mission data. San Francisco stays on its original code paths (spawns: src/app/spawns.js, UI data:
// src/ui/data.js); every other map is its own lazily loaded module (src/maps/<id>.js: start points, place names, tips,
// minimap, avionics data), so the San Francisco entry chunk only carries this table.
//
//   pickMap(params)                  → map id for this page (?map, the mission / spawn of a deep link, a resumed flight,
//                                      else the menu's remembered choice)
//   await loadMap(id, loader)        → { map, runways, spawns } (cached; missing optional files → empty lists)
//   useMap(id)                       → the map the world is built for (geo frame, the map module's UI data)
//   activeMap()                      → its registry entry
import { setGeoRegion } from '../geo.js';
import { buildSpawns } from '../app/spawns.js';

const STORE = 'gokyuzu.map';
export const MAPS = {
  sf: { id: 'sf', name: 'San Francisco', title: 'San Francisco Körfezi', assets: 'assets/sf/', data: 'data/sf/', fogBank: true },
  // (module: src/maps/ist.js; its MAP fields are merged in by loadMap: attribution, default spawns, …)
  ist: { id: 'ist', name: 'İstanbul', title: 'İstanbul', assets: 'assets/ist/', data: 'data/ist/', load: () => import('./ist.js') },
};
let active = MAPS.sf;
export const activeMap = () => active;
/** The engine's shared tables a map module may extend or replace (filled by src/app/main.js: BRIDGES, AIRPORTS, TIPS, …). */
export const mapHooks = {};

/** A missing optional file (404; S3 answers 403 for a key that does not exist). */
export const isMissing = (e) => !!e && (e.status === 404 || e.status === 403);

/** Map of a spawn or mission id: İstanbul ids start with LT (ICAO runway starts), IST- or ist-. */
export const mapOfId = (id) => (/^(LT[A-Z]{2}-|IST-|ist-)/.test(id || '') ? 'ist' : 'sf');

export function pickMap(params, resume = null) {
  const q = params.get('map');
  if (MAPS[q]) return q;
  if (params.get('mission')) return mapOfId(params.get('mission'));
  if (resume && resume.aircraft) return MAPS[resume.map] ? resume.map : 'sf';
  if (params.get('aircraft')) return mapOfId(params.get('spawn'));
  return storedMap();
}
export function storedMap() { try { const v = localStorage.getItem(STORE); return MAPS[v] ? v : 'sf'; } catch { return 'sf'; } }
export function rememberMap(id) { try { localStorage.setItem(STORE, id); } catch { /* private mode */ } }

const loaded = {};
/** Runways, spawns and the map module (other maps); every file but region.json may be missing while a map is built. */
export function loadMap(id, loader) {
  if (!loaded[id]) {
    const map = MAPS[id];
    loaded[id] = (async () => {
      if (!map.load) return { map, runways: await loader.loadJSON('data/sf/runways.json'), spawns: null };
      const [mod, region, runways] = await Promise.all([map.load(), loader.loadJSON(map.data + 'region.json'),
        loader.loadJSON(map.data + 'runways.json').catch((e) => { if (isMissing(e)) return { airports: [] }; throw e; })]);
      if (runways.magneticDeclination == null) runways.magneticDeclination = mod.MAP.declination;
      mod.register(mapHooks);
      Object.assign(map, mod.MAP, { region, module: mod, spawns: mod.buildSpawns(runways) });
      return { map, runways, spawns: map.spawns };
    })();
    loaded[id].catch(() => { loaded[id] = null; });
  }
  return loaded[id].then((d) => ({ ...d, spawns: d.spawns || buildSpawns(d.runways) }));
}

/** The map the flight happens on (after loadMap): geo frame, the map module's UI data. Once per page. */
export function useMap(id) {
  active = MAPS[id];
  if (active.module) { setGeoRegion(active.region, active.module.utm); active.module.activate(mapHooks); }
  return active;
}
