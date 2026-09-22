# Gökyüzü SF: contracts for the San Francisco Bay flight simulator

This is the **source of truth** for every agent. Read it fully before writing code. The old island game lives in
`src/ada/` + `ada.html` (read-only reference; do not edit it). The new game is `index.html` → `src/app/main.js`.

Stack: browser, Three.js r186 (`import * as THREE from 'three'`, addons via `three/addons/...`), plain ES modules, no build
step, import map in the HTML. Assets are produced offline by **Blender 5.2** scripts (headless) and Python pipelines and
loaded as glTF (GLB), images and binary tiles. Target: 60 fps in Safari on an Apple M4 Max at 1440p–5K.
Player-facing text is **Turkish**; code, identifiers and comments are English.

## 1. Coordinates and units (everyone)

- Meters, seconds, radians (unless a name ends in `Deg`). World axes: **+X east, -Z north, +Y up**, y = meters above MSL.
- Local frame = UTM zone 10N (EPSG:32610) minus the origin (SFO airport reference point). Constants in `data/sf/region.json`;
  Python: `tools/geo/geo.py` (`lonlat_to_local`, `local_to_lonlat`); JS: `src/geo.js`. Never invent another projection.
- Map extent (local): x ∈ [-16467, 20799], z ∈ [-28016, 7745] (≈37 × 36 km). Downtown SF ≈ (-2500, -19500), Golden Gate
  Bridge ≈ (-9250, -22240), SFO at the origin, Oakland airport ≈ (13600, -11860), Alameda air base ≈ (5070, -18610).
- Heading: radians, 0 = north (-Z), clockwise positive (90° = east = +X). Rotating an object to heading h: `rotation.y = -h`.
- Aircraft local axes in Three.js: **nose → -Z, up → +Y, right wing → +X**, origin at the center of gravity.
  In **Blender** this means: nose → **+Y**, up → +Z, right wing → +X (the glTF exporter's +Y-up conversion maps Blender +Y to Three -Z).
- Shared data (lead-owned, read-only for agents): `data/sf/region.json`, `data/sf/runways.json` (all runways with threshold
  ends, headings, widths, elevations — KSFO, KOAK and the fictional military **KNGZ "Alameda Hava Üssü"** runway 06/24),
  `data/sf/landmarks.json` (landmark reference points + `excludeRadius` for generic buildings), `data/sf/alameda_land_local.json`.

## 2. Rendering rules (everyone who renders)

- The renderer is created by the lead with `logarithmicDepthBuffer: true` (near 0.05 m to far 80 km). Built-in materials
  handle it automatically; **custom `ShaderMaterial`s must include the logdepthbuf chunks** (or use `onBeforeCompile` on a
  built-in material). Tone mapping ACES, sRGB output, shadows enabled (the environment agent configures the sun shadow).
- Prefer `MeshStandardMaterial`/`MeshPhysicalMaterial`. Use `InstancedMesh`, merged geometry, texture atlases, LOD and
  frustum-aware streaming. No per-frame allocations in hot paths.
- Budgets (whole game at downtown SF, 1440p): ≤ 1000 draw calls, ≤ 8 M triangles on screen, ≤ 2.5 GB GPU+JS memory,
  first playable frame ≤ 25 s from a local server (stream the rest progressively).
- No external network at runtime: everything is served from this repo. Downloading **public data** in offline pipelines is
  fine (USGS 3DEP elevation, USGS NAIP imagery, DataSF, OpenStreetMap via Overpass/Geofabrik, NOAA). Be polite: one Overpass
  query at a time, retries with backoff, cache raw downloads under `data/sf/raw/<source>/` (gitignored).

## 3. Ownership (only edit your own files; everything else is read-only for you)

| Owner | Files |
|---|---|
| Lead | `index.html`, `src/app/**`, `src/core/**`, `src/geo.js`, `src/world-sf/index.js`, `src/aircraft/registry.js`, `data/sf/*.json`, `tools/shot.mjs`, `tools/serve.mjs`, `tools/geo/geo.py`, `blender/common/**`, `dev/aircraft.html`, this file |
| W1 Terrain & environment | `src/world-sf/terrain*.js`, `src/world-sf/environment*.js`, `tools/geo/terrain_*.py`, `tools/geo/imagery_*.py`, `assets/sf/terrain/**`, `dev/terrain.html` |
| W2 City (buildings, vegetation) | `src/world-sf/city*.js`, `tools/geo/city_*.py`, `blender/city/**`, `assets/sf/city/**`, `renders/city/**`, `dev/city.html` |
| W3 Landmarks | `src/world-sf/landmarks*.js`, `blender/landmarks/**`, `tools/geo/landmarks_*.py`, `assets/sf/landmarks/**`, `renders/landmarks/**`, `dev/landmarks.html` |
| W4 Airports | `src/world-sf/airports*.js`, `blender/airports/**`, `tools/geo/airports_*.py`, `assets/sf/airports/**`, `renders/airports/**`, `dev/airports.html` |
| Aircraft agent `<id>` (f16, f22, a320neo, b737, uh60) | `blender/aircraft/<id>/**`, `src/aircraft/<id>/**` **except** `spec.js`, `assets/aircraft/<id>/**`, `renders/aircraft/<id>/**` |
| P1 Fixed-wing physics + input | `src/flight/fixedwing*.js`, `src/flight/input.js`, `src/aircraft/{f16,f22,a320neo,b737}/spec.js`, `tests/fixedwing.test.mjs` |
| P2 Helicopter physics | `src/flight/helicopter*.js`, `src/aircraft/uh60/spec.js`, `tests/helicopter.test.mjs` |
| AV Avionics | `src/avionics/**`, `dev/avionics.html` |
| AU Audio | `src/audio/**`, `tools/audio/**`, `assets/audio/**`, `dev/audio.html` |
| UI Game shell | `src/ui/**`, `dev/ui.html` |

If the contract is insufficient, do the best thing inside your files and **describe the gap in your final report**; the lead
integrates. Do not `git commit` (the lead commits). Do not start servers (one runs at http://localhost:5173/ serving the repo
root). Do not `brew install`. `.venv/bin/pip install <pkg>` into the shared venv is allowed (mention it in your report).

## 4. Tools

- Python: `~/flight-sim/.venv/bin/python` (numpy, pillow, requests, pyproj, shapely, rasterio, scipy, mapbox_earcut).
- Blender: `/Applications/Blender.app/Contents/MacOS/Blender -b -P <script.py> -- <args>` (headless). Helpers in
  `blender/common/util.py` (`reset_scene`, `setup_cycles`, `export_glb`, `studio_lighting`, `render_still`). Cycles on the
  Metal GPU is fast (first render compiles kernels, ~1 min, then seconds).
- Screenshots: `node tools/shot.mjs <page> <out.png> [--click] [--wait ms] [--hold Code:ms,...] [--eval "expr"] [--size WxH]`
  renders in headless Chromium **on the real GPU** (ANGLE/Metal), prints console errors and `window.__fps`. Always look at
  your screenshots (image reading) and iterate on what you see. Put screenshots in the scratchpad
  `<scratch>/51ed110b-e91a-4455-a1ac-30e1072065cb/scratchpad/<your-agent-name>/`, never in the repo.
- Preview pages live in `dev/`. `dev/aircraft.html?id=<id>` (lead) shows any registered aircraft with its rig animating.

## 5. Blender asset conventions (all Blender users)

- Scripts are deterministic and re-runnable: `reset_scene()` first, build everything from code, export, exit. Keep the
  `.blend` next to the output only if useful (`assets/.../*.blend`, gitignored).
- glTF-compatible materials only: Principled BSDF with constant values and/or **image textures** (bake procedural node
  setups to images before export). Alpha: use `alpha_blend`/`alpha_clip` sparingly. Emissive surfaces for lights/screens.
- Object names become glTF node names and are looked up by code: use exactly the names below, no `.001` suffixes.
- Apply transforms before export except for pivoting parts (their object origin must sit on the hinge/pivot with the local
  axis aligned to the rotation axis, rotation = 0 at the neutral pose).
- Export with `blender/common/util.py:export_glb()` (GLB, +Y up, Draco mesh compression on, JPEG/PNG textures ≤ 4096²).
- Renders ("gerçek renderlar"): Cycles, 1920×1080 (hero 2560×1440), ≥ 128 samples + denoise, filmic/AgX view transform,
  realistic lighting (HDRI-like sky via Nishita sky texture, sun), ground plane or scene context. Save PNGs to your
  `renders/...` folder.

### 5.1 Aircraft GLB node names (aircraft agents; physics, rig, avionics and audio rely on them)

| Node | Meaning |
|---|---|
| `eye_pilot`, `eye_copilot` (empties) | cockpit camera eye points (copilot optional) |
| `contact_nose`, `contact_main_L`, `contact_main_R` (empties) | bottom of each tire at static load, gear down (`contact_tail` for tail-wheel types) |
| `ctl_aileron_L/R`, `ctl_flaperon_L/R`, `ctl_elevator_L/R`, `ctl_stabilator_L/R`, `ctl_rudder` or `ctl_rudder_L/R`, `ctl_flap_L/R` (+ `_1`, `_2` for multiple panels), `ctl_slat_L/R_*`, `ctl_lef_L/R` (leading-edge flaps), `ctl_spoiler_L/R_<n>`, `ctl_speedbrake` or `ctl_speedbrake_L/R` | control surfaces, pivot on the hinge |
| `gear_nose`, `gear_main_L/R` | retracting gear legs (pivot at the trunnion); `gear_door_*` doors; `wheel_*` wheels (spin about local X) |
| `engine_1`, `engine_2` (empties) | engine positions (sound, heat) ; `nozzle_1`, `nozzle_2` (empties at the exhaust exit, aft = +Z in Three) |
| `canopy` | fighter canopy (pivot at hinge) ; `door_*` for doors |
| `rotor_main` (spins about local +Y), `rotor_tail` (spins about its local X), `rotor_main_blur`, `rotor_tail_blur` | helicopter rotors |
| `screen_<name>` (meshes) | display surfaces with UVs 0..1 covering the visible face; the avionics textures are mapped on them |
| `light_nav_L` (red), `light_nav_R` (green), `light_tail`, `light_strobe_*`, `light_beacon_*`, `light_landing_*`, `light_taxi` | light positions (empties; landing/taxi point along local -Z) |
| `interior` (parent of all cockpit/cabin interior meshes) | shown in cockpit view; may be hidden or LOD-reduced outside |

## 6. Runtime interfaces

### 6.1 World (lead composes `src/world-sf/index.js` from W1–W4)

```js
// src/world-sf/environment.js (W1)
export async function createEnvironment(ctx): Environment   // sky, sun + shadows, fog/haze, env map, water, exposure
interface Environment { sunDirection: THREE.Vector3; update(dt, camera): void; }
// src/world-sf/terrain.js (W1)
export async function createTerrain(ctx): Terrain
interface Terrain {
  object: THREE.Object3D;
  getHeight(x, z): number;      // ground height incl. flattened runways/aprons; over water returns 0 (sea level)
  isWater(x, z): boolean;
  update(dt, camera): void;     // streaming / LOD
  ready: Promise<void>;         // resolves when tiles around ctx.focus (spawn point) are loaded at full detail
}
// src/world-sf/city.js (W2), src/world-sf/landmarks.js (W3), src/world-sf/airports.js (W4)
export async function createCity(ctx): Layer        // likewise createLandmarks(ctx), createAirports(ctx)
interface Layer {
  object: THREE.Object3D;
  update(dt, camera): void;
  heightAt(x, z): number;       // top of the tallest obstacle covering (x,z) (roof, tower, bridge deck), or -Infinity
  hitTest(x, y, z, r): string | null;   // collision of a sphere with the layer's solids → Turkish name ("bina", "Golden Gate Köprüsü") or null
  ready: Promise<void>;
}
// ctx passed to every factory:
// { scene, renderer, camera, loader /* src/core/assets.js */, terrain /* after W1 is created */, runways, landmarks, region, focus: {x,z} }
```
The lead's World exposes: `getGroundHeight(x,z)`, `isWater`, `isOnRunway(x,z)`, `runways`, `getObstacleHeight(x,z)`,
`hitTest(x,y,z,r)`, `sunDirection`, `update(dt,camera)`, `ready`.
Runways: terrain flattens each runway rectangle (+ 60 m shoulders, smooth blend) to the runway's `elevation`; W4 draws the
runway/taxiway surfaces, markings and lights on top (0.05 m above terrain + polygonOffset) and all airport buildings.

### 6.2 Aircraft (aircraft agents: `src/aircraft/<id>/model.js`; physics agents: `src/aircraft/<id>/spec.js`)

```js
// model.js
export const model = {
  url: 'assets/aircraft/<id>/<id>.glb',
  lodUrl: 'assets/aircraft/<id>/<id>_lod.glb',     // optional, ≤ 40k triangles, used for parked/static copies
  displays: { screen_pfd_capt: 'a320.pfd', ... },   // screen mesh name → avionics display type (section 6.4)
  thumbnail: 'renders/aircraft/<id>/thumb.jpg',     // 800×450 menu card image
};
export function createRig(gltfScene): Rig;
interface Rig {
  object: THREE.Object3D;                 // root (origin = CG, nose -Z). The lead sets position/quaternion every frame.
  eye: { pilot: THREE.Vector3, copilot?: THREE.Vector3 };
  contacts: { name: string, position: THREE.Vector3, kind: 'nose'|'main'|'tail' }[];   // local, gear down
  screens: Record<string, THREE.Mesh>;
  bounds: { length, span, height, radius };
  update(dt: number, v: VisualState): void;   // animate surfaces, gear sequence + doors, wheels, prop/rotor, lights, afterburner
  setView(view: 'exterior' | 'cockpit'): void;
}
interface VisualState {           // produced by FlightModel.getVisualState()
  time; airspeed; mach; onGround; aoa;
  aileron; elevator; rudder;      // -1..1 (+ = roll right / nose up / yaw right)
  flaps; slats; spoilers; speedbrake;   // 0..1
  gear;                           // 0 = up & locked … 1 = down & locked (rig plays a door/leg sequence along it)
  gearCompression: number[];      // per contact, 0..1
  wheelSpeed;                     // m/s ground speed for wheel spin
  engines: { n1, throttle, afterburner, nozzle, reverser }[];   // 0..1 each
  tvc: { pitch, yaw };            // thrust-vector nozzle deflection -1..1 (F-22)
  rotor: { rpm, collective, cyclicX, cyclicY, pedal } | null;   // helicopter
  canopy;                         // 0 closed … 1 open
  lights: { nav, strobe, beacon, landing, taxi };                // booleans
}
```
The rig creates runtime effects in code: afterburner flame (layered additive cones/shock diamonds, length from
`afterburner`), heat shimmer optional, rotor/prop blur discs, strobe/beacon flashes, landing light spot (one `SpotLight`
max), wingtip vortex/condensation optional.

### 6.3 Flight models (P1: `src/flight/fixedwing.js`, P2: `src/flight/helicopter.js`) and input (P1: `src/flight/input.js`)

```js
export function createFixedWingModel(spec, { contacts }): FlightModel
export function createHelicopterModel(spec, { contacts }): FlightModel
interface FlightModel {
  spec;
  reset(start: { x, z, heading, altitude?, speed? }, world): void;   // altitude given → airborne trimmed at speed, gear up
  step(dt, input: InputState, world): void;     // fixed sub-steps, robust to dt ≤ 0.1; uses world.getGroundHeight,
                                                // world.getObstacleHeight / hitTest (buildings, bridges → crash), world.isWater
  getVisualState(): VisualState;
  on(event, cb): void;   // 'touchdown' {verticalSpeed, onRunway, pitch, roll}, 'takeoff', 'crash' {reason},
                         // 'gear' {down}, 'flaps' {index, label}, 'stall' {on}, 'afterburner' {on}, 'reverser' {on}, 'warning' {type, on}
  // readable state, updated every step:
  position; quaternion; velocity; angularVelocity;
  airspeed /* TAS m/s */; ias; mach; altitude; agl; heading /* deg */; pitch; roll; verticalSpeed; gForce; aoa; sideslip;
  throttle; onGround; stalled; crashed; crashReason /* Turkish */;
  aileron; elevator; rudder;
  engines: { n1, thrust, afterburner, fuelFlow }[];
  gear; gearHandleDown; flaps; flapsIndex; flapsLabel; slats; spoilers; speedbrake; reverser; brakes; fuel;
  warnings: { stall, overspeed, gear, bank, sinkRate, pullUp };   // booleans (pullUp uses terrain+obstacle look-ahead)
  autopilot: { on, altitude, heading, speed } ;                    // simple AP (airliners at least)
  rotorRPM; collective; torque;                                     // helicopter (0..1), null/0 otherwise
}
// input.js
export function createInput(target = window): Input
interface Input { state: InputState; update(dt): void; on(action, cb): void; bindings: { keys, label }[]; setAircraft(spec): void; }
interface InputState { pitch; roll; yaw; throttle /* 0..1 lever; helicopter: collective */; brake /* 0..1 */; }
type Action = 'gear' | 'flapsDown' | 'flapsUp' | 'speedbrake' | 'reverser' | 'canopy' | 'lights' | 'autopilot'
  | 'camera' | 'cameraPrev' | 'view' | 'lookBack' | 'reset' | 'pause' | 'hud' | 'mute' | 'help' | 'menu';
```
The lead routes actions: aircraft-system actions (`gear` … `autopilot`) go to `flight.command(action)` (implement this
method too), UI actions go to the UI. Fighters: afterburner = throttle above `spec.abDetent` (e.g. 0.9).

Specs (`spec.js`, default export) carry everything the physics needs — real published data where available (masses,
wing area, span, thrust incl. AB, max speeds, stall speeds per flap setting, gear geometry defaults used when the rig
provides no contacts) plus `id`, `category: 'fighter'|'airliner'|'helicopter'`, `name`, `engines` count, `abDetent`,
`flapDetents: [{ label, value }]`, `vRotate`, `vRef`, `cruiseSpeed`, `serviceCeiling`, `spawnSpeed` (airborne spawns).

### 6.4 Avionics (AV: `src/avionics/index.js`)
```js
export function createDisplay(type: string, opts?: { size?: number }): Display
interface Display { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; update(dt, flight, world): void; }
// types: 'a320.pfd','a320.nd','a320.ewd','a320.sd','a320.isis', 'b737.pfd','b737.nd','b737.eicas','b737.cdu',
//        'f16.hud','f16.mfd.left','f16.mfd.right','f16.ded','f16.rwr', 'f22.hud','f22.ufd','f22.pmfd','f22.smfd',
//        'uh60.mfd.pfd','uh60.mfd.nd','uh60.mfd.eng'
```
Displays redraw at ~30 Hz, only when visible. HUD types draw green/amber symbology on a transparent canvas (the rig uses
additive blending on the combiner glass). Unknown types draw a neutral "NO DATA" page (never throw).

### 6.5 Audio (AU: `src/audio/index.js`)
```js
export function createAudioSystem({ camera }): AudioSystem
interface AudioSystem {
  start(): void;                       // on the first user click
  muted: boolean; setMuted(m): void; setPaused(p): void;
  loadAircraft(id: string): Promise<void>;   // assets/audio/<id>/*.wav + profile src/audio/profiles/<id>.js
  update(dt, flight, { view: 'cockpit'|'exterior', aircraftObject, camera }): void;  // detects gear/flap/canopy/AB transitions itself
  play(name): void;                     // one-shots: 'touchdown','crash','click','chime', GPWS callouts
}
```
All sounds are generated offline by scripts in `tools/audio/` (numpy synthesis → WAV; voice callouts with macOS `say` →
`afconvert` to WAV). Interior vs exterior mixes, distance attenuation and doppler for exterior views.

### 6.6 UI (UI: `src/ui/*`; `src/ui/index.js` must export all four factories — split into more files as you like)
```js
export function createMenu(container, { aircraft /* registry entries */, spawns /* src/app/spawns.js list */ }): Promise<{ aircraftId, spawnId }>
export function createLoadingScreen(container): { setProgress(p /*0..1*/, text), hide() }
export function createHUD(container): { setAircraft(def), update(flight, info /* { world, spawn, view } */), showMessage(text, ms), setVisible(v), showHelp(bindings, v), setPaused(p) }
// (the HUD is created before the world exists: take the world from info.world on update; build the minimap lazily)
export function createCameraRig(camera, dom, world /* proxy with getGroundHeight until the world is loaded */): {
  setAircraft(rig, def): void; mode; view /* 'cockpit'|'exterior' */; next(): string; prev(): string; toggleView(): string;
  lookBack(on): void; update(dt, flight): void;
}   // modes: 'cockpit' (mouse look), 'chase', 'orbit', 'flyby', 'tower' (nearest airport tower), 'wing'
```

## 7. Main loop (lead, `src/app/main.js`)
menu → loading screen → `createSFWorld` (once) → load aircraft GLB → `createRig` → flight model from spec (+ rig
contacts) → bind displays to `rig.screens` → `audio.loadAircraft` → loop: `input.update → flight.step → rig transform ←
flight → rig.update(flight.getVisualState()) → world.update → cameraRig.update → rig.setView(cameraRig.view) → displays
(30 Hz) → hud.update → audio.update → render`. `window.__game` exposes `{ flight, world, rig, camera, cameraRig, input }`
for tests; `window.__fps` is updated every second.
