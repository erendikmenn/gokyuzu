# Uçuş Simülatörü: module contracts

Browser game, Three.js r186, plain ES modules, **no build step**. `index.html` has an import map:
`three` → `./node_modules/three/build/three.module.js`, `three/addons/` → `./node_modules/three/examples/jsm/`.
Import like `import * as THREE from 'three'` and `import { Sky } from 'three/addons/objects/Sky.js'`.

All UI text shown to the player is **Turkish**. Code, identifiers and comments are English.

## Conventions (everyone)

- Units: meters, seconds, radians. `+Y` is up. Shared constants live in `src/config.js` (`WORLD`, `RUNWAY`, `SPAWN`, `GRAVITY`, `AIR_DENSITY`). Import them, do not duplicate.
- Aircraft local axes: **nose points to -Z**, up is +Y, right wing is +X (same as a Three.js camera).
- Heading: radians, 0 = facing -Z ("north"), increasing clockwise when seen from above (turning right). Rotation about +Y by `-heading`.
- No external assets (no image/model/audio files, no CDNs). Build geometry, textures (CanvasTexture / DataTexture) and sound procedurally.
- Performance budget: must hold 60 fps on an Apple M4 Max in Safari at 1440p. Use `InstancedMesh` for anything repeated, merge static geometry, keep draw calls < ~300.
- Every module must be safe to call `dispose()`-free; the game never tears down.
- Only edit the files you own (see table). If you need something from another module, code against the contract below; do not edit their files. If the contract is truly insufficient, write the problem in your final report instead of changing it.

## Ownership

| Owner | Files |
|---|---|
| Integrator (lead) | `index.html`, `src/main.js`, `src/config.js`, `CONTRACTS.md`, `tools/*` |
| Agent A: models | `src/models/aircraft.js`, `src/models/airport.js`, `dev/models.html` |
| Agent B: world | `src/world/world.js` (+ any `src/world/*.js` helpers), `dev/world.html` |
| Agent C: flight | `src/flight/physics.js`, `src/flight/input.js` (+ `src/flight/*.js` helpers), `tests/physics.test.mjs` |
| Agent D: game | `src/game/hud.js`, `src/game/camera.js`, `src/game/missions.js`, `src/game/audio.js`, `src/game/ui.css`, `dev/hud.html` |

## Agent A: `src/models/aircraft.js`

```js
export function createAircraft(): Aircraft
interface Aircraft {
  object: THREE.Group;          // root. Origin = center of gravity. Nose → -Z. Scale: real meters (Cessna-172-like: span ~11 m, length ~8.3 m).
  gearHeight: number;           // distance from origin straight down to the bottom of the wheels (m) when resting on the ground
  cockpitOffset: THREE.Vector3; // local position of the pilot's eyes (for the cockpit camera)
  update(dt: number, v: AircraftVisualState): void;
}
interface AircraftVisualState {
  throttle: number;   // 0..1  → propeller spin speed (blur disc at high rpm is nice)
  aileron: number;    // -1..1 (+ = roll right: right aileron up, left aileron down)
  elevator: number;   // -1..1 (+ = nose up: elevator trailing edge up)
  rudder: number;     // -1..1 (+ = yaw right: rudder trailing edge to the right)
  flaps: number;      // 0..1
  airspeed: number;   // m/s
}
```
Shadows: meshes `castShadow = true`. Navigation lights (red left tip, green right tip, blinking white strobe) are welcome.

## Agent A: `src/models/airport.js`

```js
export function createAirport(world: World): THREE.Group
```
Airport buildings placed next to the runway described by `RUNWAY` in config (the runway surface itself is drawn by the world, not here): hangar(s), control tower, windsock (the returned group may have `userData.update(dt)` for windsock/beacon animation), a few parked static aircraft (reuse aircraft geometry), fuel tanks, apron. Use `world.getGroundHeight(x, z)` for placement. Keep everything **outside** `|x| < RUNWAY.width/2 + 25` so the runway stays clear.

## Agent B: `src/world/world.js`

```js
export function createWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): World
interface World {
  getGroundHeight(x: number, z: number): number; // terrain height; over water returns WORLD.seaLevel (the water surface)
  isWater(x: number, z: number): boolean;
  isOnRunway(x: number, z: number): boolean;
  sunDirection: THREE.Vector3;                  // normalized, pointing from the ground toward the sun
  update(dt: number, camera: THREE.Camera): void; // cloud drift, water animation, shadow camera follow, etc.
}
```
The world adds everything it needs to `scene`: sky, fog, lights (hemisphere + a directional sun with shadows that follows the camera), terrain, water, runway (asphalt, center line, threshold stripes, numbers "36"/"18", edge lights), trees, a small town and roads, clouds. Terrain: procedural (deterministic seed), flattened to `RUNWAY.elevation` around the runway and blended smoothly, mountains toward the edges, a lake or coast, `WORLD.size` square with a visual edge (ocean or mountain wall). `getGroundHeight` must match the rendered mesh closely (sample the same function; error < 1 m) and be fast (called several times per frame).

## Agent C: `src/flight/input.js`

```js
export function createInput(target = window): Input
interface Input {
  state: InputState;                 // read every frame
  update(dt: number): void;          // smooths analog axes, reads gamepad
  on(action: Action, cb: () => void): void; // one-shot key actions
  bindings: { keys: string, label: string }[]; // for the help screen, Turkish labels
}
interface InputState {
  pitch: number;    // -1..1, + = nose up
  roll: number;     // -1..1, + = roll right
  yaw: number;      // -1..1, + = yaw right
  throttle: number; // 0..1 (persistent lever, increased/decreased by keys)
  flaps: number;    // 0, 0.5, 1 (steps)
  brake: boolean;
}
type Action = 'camera' | 'reset' | 'pause' | 'hud' | 'mute' | 'help';
```
Keyboard (Mac friendly): W/S or ↓/↑ pitch (S/↓ = nose up), A/D or ←/→ roll, Q/E yaw, Shift / Ctrl or +/- throttle, F flaps step, B or Space brake, C camera, R reset, P or Esc pause, H hud, M mute, F1 or ? help. Standard gamepad support. Keys must not scroll the page.

## Agent C: `src/flight/physics.js`

```js
export class FlightModel {
  constructor(opts: { gearHeight: number });
  reset(x: number, z: number, heading: number, world: World): void; // parked on the ground, engine idle
  step(dt: number, input: InputState, world: World): void;           // fixed internal sub-steps; robust to dt up to 0.1
  // readable state (update every step):
  position: THREE.Vector3; quaternion: THREE.Quaternion; velocity: THREE.Vector3;
  airspeed: number;      // m/s
  altitude: number;      // m above sea level
  agl: number;           // m above ground
  heading: number;       // degrees 0..360
  pitch: number; roll: number; // degrees
  verticalSpeed: number; // m/s
  gForce: number;
  throttle: number; flaps: number;
  aileron: number; elevator: number; rudder: number; // -1..1, current (smoothed) control surface deflections for the visuals
  onGround: boolean; stalled: boolean; crashed: boolean; crashReason: string; // Turkish reason text
  on(event: 'touchdown' | 'crash' | 'takeoff', cb: (info) => void): void;
  // touchdown info: { verticalSpeed, onRunway, pitch, roll }
}
```
Arcade-but-plausible light aircraft: lift from angle of attack with stall (~16°) and gentle stall behavior, induced + parasitic drag, propeller thrust falling with airspeed, flaps add lift and drag, gravity, damping on rotation rates, coordinated-ish turns (roll causes turn, slight adverse yaw optional). Stall speed ~23 m/s clean, rotates ~28 m/s, cruise ~55 m/s, top ~70 m/s. Ground: wheels on terrain via `world.getGroundHeight`, rolling friction, brakes, nose-wheel steering with yaw input on the ground. Crash if: ground contact with vertical speed > 5 m/s, or |roll| > 30° / |pitch| > 25° at contact, or any contact with water, or hitting terrain with the fuselage. Must be fully testable in Node (no DOM).

## Agent D: `src/game/*`

```js
// hud.js
export function createHUD(container: HTMLElement, world: World): HUD   // world is for the minimap (sample getGroundHeight/isWater once at startup)
interface HUD {
  update(flight: FlightModel, mission: MissionState): void;
  showMessage(text: string, ms?: number): void;  // big centered toast
  setVisible(v: boolean): void;
  showHelp(bindings, visible: boolean): void;
  setPaused(p: boolean): void;
}
// camera.js
export function createCameraRig(camera: THREE.PerspectiveCamera, aircraft: Aircraft, dom: HTMLElement, world: World): CameraRig // keep the camera above world.getGroundHeight + 1.5
interface CameraRig {
  mode: 'chase' | 'cockpit' | 'orbit' | 'flyby';
  next(): string;                      // cycle mode, returns Turkish mode name
  update(dt: number, flight: FlightModel): void; // smooth follow; orbit = mouse drag + wheel zoom
}
// missions.js
export function createMissions(scene: THREE.Scene, world: World): Missions
interface Missions {
  update(dt: number, flight: FlightModel): MissionState;
  reset(): void;
  onEvent(cb: (e: { type: 'ring' | 'complete' | 'info', text: string }) => void): void;
}
interface MissionState { title: string; objective: string; score: number; ringsDone: number; ringsTotal: number; time: number; bestTime: number | null; nextTarget: THREE.Vector3 | null; }
// audio.js
export function createAudio(): Audio
interface Audio { start(): void; update(flight: FlightModel): void; setMuted(m: boolean): void; muted: boolean; crash(): void; touchdown(): void; stallWarning(on: boolean): void; }
```
HUD: glass-cockpit style overlay (speed tape in knots, altitude tape in feet, heading tape, artificial horizon / attitude indicator, vertical speed, throttle and flaps bars, stall warning, AGL when low, a minimap with the runway and next ring, mission panel, FPS counter hidden by default). Missions: a ring course (glowing torus rings through valleys and around the town), with timer and best time kept in localStorage, and a "land back on the runway" final objective. Audio: WebAudio-synthesized engine (pitch/volume by throttle and airspeed), wind noise by airspeed, stall horn, touchdown squeak, crash sound. Start only after `start()` (called on the first click).

## Integration (lead, `src/main.js`)

main.js creates the renderer/scene/camera, calls the factories above, runs `input.update → flight.step → aircraft.object.position/quaternion ← flight → aircraft.update → world.update → missions.update → camera.update → hud.update → audio.update → render`, handles actions (camera/reset/pause/hud/mute/help), crash → message + auto reset, and the click-to-start overlay.

## Testing tools

- A static server is already running for the whole session at **http://localhost:5173/** (serving the repo root). Do not start another server.
- `node tools/shot.mjs <url-path> <out.png> [--wait ms] [--hold KeyW:2000,ShiftLeft:1500] [--eval "js expr"]` loads the page in headless Chromium (WebGL via SwiftShader: slow, so expect low fps), prints console errors/warnings and page errors, optionally holds keys, and saves a 1440x900 screenshot. Look at the screenshot with your image-reading tool to check your work visually.
- Put isolated preview pages in `dev/` (e.g. `dev/models.html` shows the aircraft on a turntable). They can import `../src/...` modules.
- Do not `git commit`; the lead commits.
