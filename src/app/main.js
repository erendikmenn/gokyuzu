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

const params = new URLSearchParams(location.search);
const app = document.getElementById('app');
const uiRoot = document.getElementById('ui');
const hudRoot = document.getElementById('hud');

// ---- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
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
window.__game = state;

async function start() {
  const runways = await loader.loadJSON('data/sf/runways.json');
  const spawns = buildSpawns(runways);
  let choice;
  if (params.get('aircraft')) choice = { aircraftId: params.get('aircraft'), spawnId: params.get('spawn') || AIRCRAFT.find((a) => a.id === params.get('aircraft')).defaultSpawn };
  else choice = await createMenu(uiRoot, { aircraft: AIRCRAFT, spawns });
  audio.start();
  const spawn = spawns.find((s) => s.id === choice.spawnId) || spawns[0];
  state.spawn = spawn;

  const loading = createLoadingScreen(uiRoot);
  const t0 = performance.now();
  if (!state.world) {
    state.world = await createSFWorld({ scene, renderer, camera, loader, focus: { x: spawn.x, z: spawn.z }, onProgress: (p, t) => loading.setProgress(p * 0.8, t) });
  }
  loading.setProgress(0.85, 'Uçak yükleniyor');
  await loadAircraft(choice.aircraftId);
  resetFlight();
  loading.setProgress(1, 'Hazır');
  loading.hide();
  console.log(`[app] ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  hud.showMessage(spawn.altitude ? 'İyi uçuşlar!' : 'Gaz ver (Shift / X), kalkış hızında burnu kaldır (S)', 4000);
}

async function loadAircraft(id) {
  const def = await loadAircraftDefinition(id);
  const gltf = def.model.url ? await loader.loadGLTF(def.model.url) : null;
  const rig = def.createRig(gltf ? gltf.scene : null);
  rig.object.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  if (state.rig) scene.remove(state.rig.object);
  scene.add(rig.object);
  const factory = def.spec.category === 'helicopter' ? createHelicopterModel : createFixedWingModel;
  const flight = factory(def.spec, { contacts: rig.contacts });
  bindFlightEvents(flight);
  state.displays = Object.entries(def.model.displays || {}).flatMap(([meshName, type]) => {
    const mesh = rig.screens[meshName];
    if (!mesh) { console.warn(`[app] screen mesh ${meshName} missing`); return []; }
    const display = createDisplay(type);
    const mat = mesh.material.clone();
    mat.map = display.texture; mat.emissive = new THREE.Color(0xffffff); mat.emissiveMap = display.texture; mat.emissiveIntensity = 1;
    if (type.endsWith('.hud')) { mat.transparent = true; mat.blending = THREE.AdditiveBlending; mat.depthWrite = false; }
    mesh.material = mat;
    return [{ display, mesh }];
  });
  input.setAircraft(def.spec);
  hud.setAircraft(def);
  cameraRig.setAircraft(rig, def);
  await audio.loadAircraft(id).catch((e) => console.warn('[audio]', e));
  Object.assign(state, { def, rig, flight });
}

function bindFlightEvents(flight) {
  flight.on('crash', () => { audio.play('crash'); hud.showMessage(`Kaza! ${flight.crashReason || ''}`.trim(), 3500); state.crashTimer = 4; });
  flight.on('touchdown', (i) => {
    const vs = Math.abs(i.verticalSpeed);
    if (!flight.crashed) hud.showMessage((vs < 1 ? 'Tereyağı gibi iniş!' : vs < 2.5 ? 'Güzel iniş.' : 'Sert iniş.') + (i.onRunway ? '' : ' (pist dışı)'), 2500);
  });
  flight.on('takeoff', () => hud.showMessage('Kalkış!', 1500));
}

function resetFlight() {
  const s = state.spawn;
  state.flight.reset({ x: s.x, z: s.z, heading: s.heading, altitude: s.altitude, speed: s.altitude ? state.def.spec.spawnSpeed : undefined }, state.world);
  state.crashTimer = 0;
  syncRig(1);
}

let prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
function syncRig() {
  state.rig.object.position.copy(state.flight.position);
  state.rig.object.quaternion.copy(state.flight.quaternion);
}

// ---- actions ----
const cameraRig = createCameraRig(camera, renderer.domElement, { getGroundHeight: (x, z) => (state.world ? state.world.getGroundHeight(x, z) : 0) });
const SYSTEM_ACTIONS = ['gear', 'flapsDown', 'flapsUp', 'speedbrake', 'reverser', 'canopy', 'lights', 'autopilot'];
for (const a of SYSTEM_ACTIONS) input.on(a, () => { if (state.flight && state.flight.command) state.flight.command(a); });
input.on('camera', () => hud.showMessage(`Kamera: ${cameraRig.next()}`, 1000));
input.on('cameraPrev', () => hud.showMessage(`Kamera: ${cameraRig.prev()}`, 1000));
input.on('view', () => hud.showMessage(cameraRig.toggleView(), 1000));
input.on('lookBack', () => cameraRig.lookBack(true));
input.on('reset', () => { if (state.flight) { resetFlight(); hud.showMessage('Yeniden başlatıldı', 1000); } });
input.on('pause', () => { state.paused = !state.paused; hud.setPaused(state.paused); audio.setPaused(state.paused); });
input.on('hud', () => { state.hudVisible = !state.hudVisible; hud.setVisible(state.hudVisible); });
input.on('mute', () => { state.userMuted = !state.userMuted; audio.setMuted(state.userMuted); hud.showMessage(state.userMuted ? 'Ses kapalı' : 'Ses açık', 900); });
input.on('help', () => { state.helpVisible = !state.helpVisible; hud.showHelp(input.bindings, state.helpVisible); });
input.on('menu', () => { location.href = location.pathname; });

// ---- loop ----
const timer = new THREE.Timer();
timer.connect(document);
let fpsAcc = 0, fpsFrames = 0, displayAcc = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  input.update(dt);
  const { flight, rig, world } = state;
  if (flight && rig && world) {
    if (!state.paused) {
      if (!flight.crashed) flight.step(dt, input.state, world);
      if (state.crashTimer > 0 && (state.crashTimer -= dt) <= 0) resetFlight();
    }
    syncRig();
    rig.update(dt, flight.getVisualState());
    cameraRig.update(dt, flight);
    rig.setView(cameraRig.view);
    world.update(dt, camera);
    displayAcc += dt;
    if (displayAcc > 1 / 30) { for (const d of state.displays) d.display.update(displayAcc, flight, world); displayAcc = 0; }
    hud.update(flight, { world, spawn: state.spawn, view: cameraRig.view });
    audio.update(dt, flight, { view: cameraRig.view, aircraftObject: rig.object, camera });
  }
  renderer.render(scene, camera);
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 1) { window.__fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
}
requestAnimationFrame(frame);
start().catch((e) => { console.error(e); hud.showMessage(`Hata: ${e.message}`, 10000); });
