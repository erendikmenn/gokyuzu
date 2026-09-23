// Lead-owned entry point of the San Francisco game.
import * as THREE from 'three';
import { createAssetLoader } from '../core/assets.js';
import { createSFWorld } from '../world-sf/index.js';
import { AIRCRAFT, loadAircraftDefinition } from '../aircraft/registry.js';
import { createFixedWingModel } from '../flight/fixedwing.js';
import { createHelicopterModel } from '../flight/helicopter.js';
import { createInput } from '../flight/input.js';
import { createDisplay } from '../avionics/index.js';
import { createAudioSystem } from '../audio/index.js';
import { createMenu, createLoadingScreen, createHUD, createCameraRig } from '../ui/index.js';
import { buildSpawns } from './spawns.js';
import { loadSettings } from '../core/settings.js';
import { QUALITY } from '../core/quality.js';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app');
const uiRoot = document.getElementById('ui');
const hudRoot = document.getElementById('hud');

// ---- settings / quality ----
let settings = loadSettings();
if (params.has('quality') && QUALITY[params.get('quality')]) settings.quality = params.get('quality');   // ?quality=low|medium|high|ultra
let quality = QUALITY[settings.quality] || QUALITY.high;

// ---- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
// Dynamic resolution: start at min(display pixel ratio, preset cap) and step down when the frame rate drops
// (weak GPUs, Retina over downtown), stepping back up after a sustained smooth period. ?pr=<n> pins it.
let maxPixelRatio, minPixelRatio;
function pixelRatioLimits() {
  maxPixelRatio = params.has('pr') ? Number(params.get('pr')) : Math.min(window.devicePixelRatio, quality.pixelRatioMax);
  minPixelRatio = params.has('pr') ? maxPixelRatio : Math.max(0.6, maxPixelRatio * 0.6);
}
pixelRatioLimits();
let pixelRatio = maxPixelRatio;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = quality.shadows;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.3, 80000);
scene.add(camera);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const loader = createAssetLoader(renderer);
const input = createInput(window);
const audio = createAudioSystem({ camera });
const hud = createHUD(hudRoot, null);

const state = { world: null, def: null, rig: null, flight: null, displays: [], paused: false, hudVisible: true, helpVisible: false, crashTimer: 0, spawn: null, userMuted: false };
state.input = input;
window.__game = state;

async function start() {
  const runways = await loader.loadJSON('data/sf/runways.json');
  const spawns = buildSpawns(runways);
  let choice;
  const direct = AIRCRAFT.find((a) => a.id === params.get('aircraft'));   // ?aircraft=<id>&spawn=<id> skips the menu
  if (direct) choice = { aircraftId: direct.id, spawnId: spawns.some((s) => s.id === params.get('spawn')) ? params.get('spawn') : direct.defaultSpawn };
  else choice = await createMenu(uiRoot, { aircraft: AIRCRAFT, spawns });
  audio.start();
  const spawn = spawns.find((s) => s.id === choice.spawnId) || spawns[0];
  state.spawn = spawn;

  const loading = createLoadingScreen(uiRoot);
  const t0 = performance.now();
  // fetch the aircraft model in parallel with the world (loadGLTF caches the promise, loadAircraft reuses it)
  loadAircraftDefinition(choice.aircraftId).then((d) => d.model.url && loader.loadGLTF(d.model.url)).catch(() => {});
  if (!state.world) {
    state.world = await createSFWorld({ scene, renderer, camera, loader, quality, focus: { x: spawn.x, z: spawn.z }, onProgress: (p, t) => loading.setProgress(p * 0.8, t) });
  }
  loading.setProgress(0.85, 'Uçak yükleniyor');
  await loadAircraft(choice.aircraftId);
  resetFlight();
  loading.setProgress(1, 'Hazır');
  loading.hide();
  state.readyAt = performance.now();   // dynamic resolution ignores the first seconds (shader compiles, tile bursts)
  console.log(`[app] ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const heli = state.def.spec.category === 'helicopter';
  // airborne on final with gear + flaps already out: pressing G (as for a normal approach) would retract the gear
  const onFinal = spawn.altitude && state.def.spec.category === 'airliner' && state.flight.gearHandleDown;
  hud.showMessage(onFinal ? 'Takım ve flaplar iniş konumunda · O: otomatik ILS inişi' : spawn.altitude ? 'İyi uçuşlar!' : heli ? 'Kolektifi artır (Shift / X), havalanınca O ile askıda kal' : 'Gaz ver (Shift / X), kalkış hızında burnu kaldır (S)', 4000);
}

async function loadAircraft(id) {
  const def = await loadAircraftDefinition(id);
  const gltf = def.model.url ? await loader.loadGLTF(def.model.url) : null;
  const rig = def.createRig(gltf ? gltf.scene : null);
  rig.object.traverse((o) => {
    if (!o.isMesh) return;
    // glass, plumes and other see-through materials neither cast shadows nor darken the cockpit
    const seeThrough = [].concat(o.material).some((m) => m && (m.transparent || m.transmission > 0 || m.blending === THREE.AdditiveBlending));
    o.castShadow = !seeThrough || !!o.customDepthMaterial;   // rigs may give see-through parts (rotor disc) a custom shadow
    o.receiveShadow = true;
  });
  if (state.rig) scene.remove(state.rig.object);
  scene.add(rig.object);
  // dim flight-deck flood light (always present so the light count never changes; only lit in cockpit view)
  state.cockpitFill = new THREE.PointLight(0xfff0dc, 0, 3.5, 2);
  state.cockpitFill.position.copy(rig.eye.pilot).add(new THREE.Vector3(0, 0.35, 0.25));
  rig.object.add(state.cockpitFill);
  const factory = def.spec.category === 'helicopter' ? createHelicopterModel : createFixedWingModel;
  const flight = factory(def.spec, { contacts: rig.contacts });
  bindFlightEvents(flight);
  state.displays = Object.entries(def.model.displays || {}).flatMap(([meshName, type]) => {
    const mesh = rig.screens[meshName];
    if (!mesh) { console.warn(`[app] screen mesh ${meshName} missing`); return []; }
    // mesh/eye/root let the avionics align HUD symbology with the real glass and skip redraws of off-screen displays
    const display = createDisplay(type, { mesh, eye: rig.eye.pilot, root: rig.object });
    mesh.material = bindScreenMaterial(display, type);
    return [{ display, mesh }];
  });
  input.setAircraft(def.spec);
  hud.setAircraft(def);
  cameraRig.setAircraft(rig, def);
  // audio streams in the background: the game starts without waiting and sounds fade in when their buffers arrive
  audio.loadAircraft(id).catch((e) => console.warn('[audio]', e));
  Object.assign(state, { def, rig, flight });
}

/** Self-lit screen material: LCDs keep their exact colors (no tone mapping); HUD symbology is added onto the combiner glass. */
function bindScreenMaterial(display, type) {
  const hud = type.endsWith('.hud');
  return new THREE.MeshBasicMaterial({
    map: display.texture, toneMapped: false,
    transparent: hud, blending: hud ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: !hud,
    polygonOffset: true, polygonOffsetFactor: -1,
  });
}

function bindFlightEvents(flight) {
  flight.on('crash', () => { audio.play('crash'); hud.showMessage(`Kaza! ${flight.crashReason || ''}`.trim(), 3500); state.crashTimer = 4; });
  flight.on('touchdown', (i) => {
    const vs = Math.abs(i.verticalSpeed);
    if (!flight.crashed) hud.showMessage((vs < 1 ? 'Tereyağı gibi iniş!' : vs < 2.5 ? 'Güzel iniş.' : 'Sert iniş.') + (i.onRunway ? '' : ' (pist dışı)'), 2500);
  });
  flight.on('takeoff', () => hud.showMessage('Kalkış!', 1500));
  // refused commands used to be silent (N with the lever above idle, e.g. after an autoland; G on the ground)
  flight.on('warning', (w) => {
    if (!w || !w.on) return;
    if (w.type === 'reverserInhibit') hud.showMessage('Ters itki yalnızca yerde ve gaz rölantideyken (Ctrl / Z)', 2000);
    else if (w.type === 'gearLocked') hud.showMessage('Yerdeyken iniş takımı toplanamaz', 1500);
  });
}

function resetFlight() {
  const s = state.spawn;
  state.flight.reset({ x: s.x, z: s.z, heading: s.heading, altitude: s.altitude, speed: s.altitude ? state.def.spec.spawnSpeed : undefined }, state.world);
  state.crashTimer = 0;
  if (input.setThrottle) input.setThrottle(state.flight.throttle ?? 0);   // lever follows the reset engine state
  syncRig(1);
}

let prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
function syncRig() {
  state.rig.object.position.copy(state.flight.position);
  state.rig.object.quaternion.copy(state.flight.quaternion);
}

// ---- actions ----
// The camera rig is created before the world exists: hand it a proxy that forwards to the real world once loaded.
const worldProxy = new Proxy({}, {
  get(_, key) {
    const w = state.world;
    if (!w) return key === 'getGroundHeight' || key === 'getObstacleHeight' ? () => 0 : key === 'hitTest' ? () => null : undefined;
    const v = w[key];
    return typeof v === 'function' ? v.bind(w) : v;
  },
});
const cameraRig = createCameraRig(camera, renderer.domElement, worldProxy);
Object.assign(state, { camera, cameraRig, renderer, scene, hud, audio });   // test hooks (CONTRACTS-SF.md §7)
const SYSTEM_ACTIONS = ['gear', 'flapsDown', 'flapsUp', 'speedbrake', 'reverser', 'canopy', 'lights', 'autopilot'];
for (const a of SYSTEM_ACTIONS) input.on(a, () => { if (state.flight && state.flight.command) state.flight.command(a); });
input.on('autopilot', () => { if (audio.acknowledge) audio.acknowledge(); });   // silences an AP-disconnect alert (the causing press is ignored by audio)
input.on('camera', () => hud.showMessage(`Kamera: ${cameraRig.next()}`, 1000));
input.on('cameraPrev', () => hud.showMessage(`Kamera: ${cameraRig.prev()}`, 1000));
input.on('view', () => hud.showMessage(cameraRig.toggleView(), 1000));
input.on('lookBack', () => cameraRig.lookBack(true));
input.on('reset', () => { if (state.flight) { resetFlight(); hud.showMessage('Yeniden başlatıldı', 1000); } });
input.on('pause', () => { state.paused = !state.paused; hud.setPaused(state.paused); audio.setPaused(state.paused); });
input.on('hud', () => { if (hud.cycleMode) hud.cycleMode(); else { state.hudVisible = !state.hudVisible; hud.setVisible(state.hudVisible); } });   // full → compact → off
input.on('mute', () => { state.userMuted = !state.userMuted; audio.setMuted(state.userMuted); hud.showMessage(state.userMuted ? 'Ses kapalı' : 'Ses açık', 900); });
input.on('help', () => { state.helpVisible = !state.helpVisible; hud.showHelp(input.bindings, state.helpVisible); });
input.on('menu', () => { location.href = location.pathname; });

// ---- loop ----
const timer = new THREE.Timer();
timer.connect(document);
let fpsAcc = 0, fpsFrames = 0, displayAcc = 0;
const invertedInput = {};
function frame(ts) {
  requestAnimationFrame(frame);
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  input.update(dt);
  const { flight, rig, world } = state;
  if (flight && rig && world) {
    if (!state.paused) {
      if (!flight.crashed) {
        // invert pitch (settings) on a copy so the input module's own smoothing state is untouched
        let inp = input.state;
        if (settings.invertPitch) { inp = Object.assign(invertedInput, input.state); inp.pitch = -inp.pitch; }
        flight.step(dt, inp, world);
        if (inp !== input.state) input.state.throttle = inp.throttle;   // models may back-drive the lever (helicopter hold)
      }
      if (state.crashTimer > 0 && (state.crashTimer -= dt) <= 0) resetFlight();
    }
    syncRig();
    rig.update(dt, flight.getVisualState());
    cameraRig.update(dt, flight);
    rig.setView(cameraRig.view);
    if (state.cockpitFill) state.cockpitFill.intensity = cameraRig.view === 'cockpit' ? 2.5 : 0;
    world.update(dt, camera);
    displayAcc += dt;
    if (displayAcc > 1 / 30) { for (const d of state.displays) d.display.update(displayAcc, flight, world); displayAcc = 0; }
    hud.update(flight, { world, spawn: state.spawn, view: cameraRig.view });
    audio.update(dt, flight, { view: cameraRig.view, aircraftObject: rig.object, camera });
  }
  renderer.render(scene, camera);
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 1) {
    const fps = fpsFrames / fpsAcc;
    window.__fps = fps;
    adaptResolution(fps, fpsAcc);
    fpsAcc = 0; fpsFrames = 0;
  }
}
// Settings edited in the menu / pause screen (src/core/settings.js saveSettings) apply live.
function applySettings(next) {
  settings = next;
  const q = QUALITY[settings.quality] || quality;
  if (q !== quality) {
    const shadowsChanged = q.shadows !== quality.shadows;
    quality = q;
    pixelRatioLimits();
    pixelRatio = Math.min(Math.max(pixelRatio, minPixelRatio), maxPixelRatio);
    renderer.setPixelRatio(pixelRatio);
    if (shadowsChanged) {
      renderer.shadowMap.enabled = q.shadows;
      scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    }
    if (state.world && state.world.setQuality) state.world.setQuality(q);
    hud.showMessage(`Grafik kalitesi: ${q.label}`, 1500);
  }
  if (audio.setVolumes) audio.setVolumes(settings.volumes);
  state.settings = settings; state.quality = quality;
}
window.addEventListener('gokyuzu:settings', (e) => applySettings(e.detail));
Object.assign(state, { settings, quality });
if (audio.setVolumes) audio.setVolumes(settings.volumes);

let smoothFor = 0, sinceDrop = 99;
function adaptResolution(fps, span) {
  if (!state.flight || maxPixelRatio === minPixelRatio) return;
  if (!state.readyAt || performance.now() - state.readyAt < 6000) return;
  sinceDrop += span;
  if (fps < 50 && pixelRatio > minPixelRatio) {
    pixelRatio = Math.max(minPixelRatio, pixelRatio - 0.15);
    renderer.setPixelRatio(pixelRatio);
    smoothFor = 0; sinceDrop = 0;
  } else if (fps > 58.5 && pixelRatio < maxPixelRatio) {
    smoothFor += span;
    if (smoothFor > 8 && sinceDrop > 20) { pixelRatio = Math.min(maxPixelRatio, pixelRatio + 0.1); renderer.setPixelRatio(pixelRatio); smoothFor = 0; }
  } else smoothFor = 0;
  state.pixelRatio = pixelRatio;
}

// Build stamp (dist/build.json, written by the publish build): a clear ribbon on staging so it is never mistaken for live.
fetch('build.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((b) => {
  if (!b) return;
  state.build = b;
  if (b.target === 'staging') {
    const tag = document.createElement('div');
    tag.textContent = `STAGING · ${b.version}`;
    tag.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:50;padding:4px 10px;border-radius:6px;background:#f2801a;color:#111;font:600 12px -apple-system,sans-serif;pointer-events:none;opacity:.9';
    document.body.append(tag);
  }
}).catch(() => {});

requestAnimationFrame(frame);
start().catch((e) => { console.error(e); hud.showMessage(`Hata: ${e.message}`, 10000); });
