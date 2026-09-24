// Runtime state shared between the UI modules (camera rig ↔ HUD, menu → loading screen).
import { activeMap } from '../maps/index.js';

export const shared = {
  camera: null,          // THREE.PerspectiveCamera driven by the camera rig
  cameraMode: 'chase',   // current camera mode id
  cameraSub: null,       // 'spotter' when the tower camera is replaced by a ground spotter
  lookingBack: false,
  birdseyeBearing: 0,    // bird's-eye camera: bearing of screen-up (rad, 0 = north, clockwise)
  birdseyeTrackUp: false,   // bird's-eye camera: track-up (true) or north-up
  hudVisible: true,      // HUD not "Kapalı" (set by the HUD camera selector; the bird's-eye ring hides with it)
  choice: null,          // last menu choice { aircraftId, spawnId, aircraftName, spawnName }
  runways: null,         // runways.json (fetched lazily when the world proxy has none)
};

let runwaysPromise = null;
/** runways.json of the active map (src/maps/index.js), from the world if it has it, else fetched once from the repo. */
export function loadRunways() {
  if (shared.runways) return Promise.resolve(shared.runways);
  if (!runwaysPromise) {
    runwaysPromise = fetch(new URL(`../../${activeMap().data}runways.json`, import.meta.url))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && !shared.runways) shared.runways = j; return shared.runways; })
      .catch(() => null);
  }
  return runwaysPromise;
}
