// Lead-owned entry point of the San Francisco game.
import * as THREE from 'three';
import { createAssetLoader, loadAssetVersions, isNetworkError } from '../core/assets.js';
import { createSFWorld } from '../world-sf/index.js';
import { AIRCRAFT, loadAircraftDefinition } from '../aircraft/registry.js';
import { createFixedWingModel } from '../flight/fixedwing.js';
import { createHelicopterModel } from '../flight/helicopter.js';
import { createInput } from '../flight/input.js';
import { createDisplay } from '../avionics/index.js';
import { createAudioSystem } from '../audio/index.js';
import { createMenu, createLoadingScreen, createHUD, createCameraRig, createOnboarding } from '../ui/index.js';
import { createTimeWeatherControl } from '../ui/menu.js';   // time & weather hook: picker on the pause screen
import { buildSpawns } from './spawns.js';
import { loadSettings } from '../core/settings.js';
import { QUALITY, resolveQuality, lowerQuality, setQualityCap } from '../core/quality.js';
import { createGpuGuard, noteGpuFailure } from '../core/gpu-guard.js';          // robustness: context loss, GPU budget
import { readResume, applyResume, clearResume } from '../core/gpu-resume.js';
import { IS_MAC } from '../core/platform.js';
import { goToMenu, guardUnload } from '../core/leave.js';
import { startTelemetry, trackFlight } from '../core/telemetry.js';
import { createRoute } from '../nav/route.js';     // navigation hook: route planning + LNAV (src/nav)
import { createNavMap } from '../ui/map.js';       // navigation hook: big map (J / minimap click)

const params = new URLSearchParams(location.search);
const app = document.getElementById('app');
const uiRoot = document.getElementById('ui');
const hudRoot = document.getElementById('hud');

// ---- settings / quality ----
let settings = loadSettings();
if (params.has('quality') && QUALITY[params.get('quality')]) settings.quality = params.get('quality');   // ?quality=low|medium|high|ultra
// robustness hook: a flight saved before a graphics failure (?resume=1 reload, or this tab died mid-flight)
let resume = readResume(params);
if (resume && resume.crash) {   // the previous page of this tab died without unloading: treat it as a GPU failure too
  if (noteGpuFailure() >= 3) resume = null;   // it keeps dying: start normally (menu / direct link) instead
  else { const lower = lowerQuality(settings.quality) || 'low'; settings.quality = lower; setQualityCap(lower); }
}
let quality = resolveQuality(QUALITY[settings.quality] ? settings.quality : 'high');   // preset + device caps (src/core/quality.js)

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
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!(w > 1 && h > 1)) return;   // robustness: transient 0-size viewports (iOS rotation, hidden tabs) keep the last size
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
// iOS / iPadOS report the new size late after a rotation: measure again once the viewport has settled
window.addEventListener('orientationchange', () => { setTimeout(onResize, 250); setTimeout(onResize, 800); });
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

const loader = createAssetLoader(renderer);
// robustness hook (src/core/gpu-guard.js): context loss → save + reload one step lower into the same flight; GPU budget
// monitor; GLB texture downscale / release policy; `gfx` telemetry
let gpu = null;
loader.gltf.register(() => gpu.plugin());
if (quality.deviceClass === 'phone' || quality.deviceClass === 'tablet') loader.draco.setWorkerLimit(2);   // fewer Draco WASM heaps on mobile
const input = createInput(window);
const audio = createAudioSystem({ camera });
const hud = createHUD(hudRoot, null);
// onboarding hook (src/ui/tutorial.js): first-flight tutorial / key card / hints; "Eğitimi yeniden başlat" resets the flight
const onboarding = createOnboarding(hudRoot, { input, hud, restart: () => { if (state.flight) resetFlight(); } });

const state = { world: null, def: null, rig: null, flight: null, displays: [], paused: false, hudVisible: true, helpVisible: false, crashTimer: 0, spawn: null, userMuted: false };
state.input = input;
state.onboarding = onboarding;   // test hook
window.__game = state;
// navigation hook: one route for the session (kept across resets and aircraft changes; the flight model flies it with
// its autopilot), the big map over the running game (J or a click on the minimap), the route on the minimap
const navRoute = createRoute();
const navMap = createNavMap({ hud, route: navRoute });
hud.setNavMap({ open: (src) => navMap.open(src), overlay: navMap.drawMinimapOverlay });
Object.assign(state, { navRoute, navMap });   // test hooks

let loading = null;   // loading screen (also used by startFailed)
async function start() {
  await loadAssetVersions();   // CONTRACTS-SF.md §9: version map before any asset request (menu thumbnails too)
  const runways = await loader.loadJSON('data/sf/runways.json');
  const spawns = buildSpawns(runways);
  let choice;
  const direct = AIRCRAFT.find((a) => a.id === params.get('aircraft'));   // ?aircraft=<id>&spawn=<id> skips the menu
  const resumed = resume && AIRCRAFT.some((a) => a.id === resume.aircraft) ? resume : null;   // robustness hook: same flight
  if (resumed) choice = { aircraftId: resumed.aircraft, spawnId: spawns.some((s) => s.id === resumed.spawn) ? resumed.spawn : spawns[0].id, time: resumed.time ?? undefined, weather: resumed.weather || undefined };
  else if (direct) choice = { aircraftId: direct.id, spawnId: spawns.some((s) => s.id === params.get('spawn')) ? params.get('spawn') : direct.defaultSpawn };
  else choice = await createMenu(uiRoot, { aircraft: AIRCRAFT, spawns });
  audio.start();
  state.choice = choice;
  const spawn = spawns.find((s) => s.id === choice.spawnId) || spawns[0];
  state.spawn = spawn;

  loading = createLoadingScreen(uiRoot);
  const t0 = performance.now();
  // fetch the aircraft model in parallel with the world (loadGLTF caches the promise, loadAircraft reuses it)
  loadAircraftDefinition(choice.aircraftId).then((d) => d.model.url && loader.loadGLTF(d.model.url)).catch(() => {});
  if (!state.world) {
    const focus = resumed ? { x: resumed.x, z: resumed.z } : { x: spawn.x, z: spawn.z };   // robustness hook: load around the resumed aircraft
    state.world = await createSFWorld({ scene, renderer, camera, loader, quality, focus, onProgress: (p, t) => loading.setProgress(p * 0.8, t),
      time: choice.time, weather: choice.weather });   // time & weather hook (menu choice; ?time= / ?weather= otherwise)
    mountTimeWeather();
  }
  loading.setProgress(0.85, 'Uçak yükleniyor');
  await loadAircraft(choice.aircraftId);
  resetFlight();
  let resumeNote = null;
  if (resumed) { try { resumeNote = applyResume(state, resumed, { input }); } catch (e) { console.warn('[resume]', e); } }   // robustness hook
  loading.setProgress(1, 'Hazır');
  loading.hide();
  state.readyAt = performance.now();   // dynamic resolution ignores the first seconds (shader compiles, tile bursts)
  console.log(`[app] ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  state.aircraftId = choice.aircraftId;
  trackFlight(choice.aircraftId, spawn.id, (performance.now() - t0) / 1000, settings.quality);
  if (resumed) {   // robustness hook: back in the same flight after a graphics failure (no tutorial / key card)
    gpu.report('resume', { why: resumed.crash ? 'crash' : resumed.reason || 'gpu', ac: choice.aircraftId });
    hud.showMessage(`Uçuşa kaldığın yerden devam ediliyor · Grafik: ${quality.label}${resumeNote ? ' · ' + resumeNote : ''}`, 4500);
    return;
  }
  clearResume();
  // onboarding hook: tutorial on the first flight of the category, otherwise the key card + start message
  onboarding.begin({ flight: state.flight, def: state.def, spawn });
}

async function loadAircraft(id) {
  const def = await loadAircraftDefinition(id);
  const gltf = def.model.url ? await loader.loadGLTF(def.model.url) : null;
  const rig = def.createRig(gltf ? gltf.scene : null);
  setupShadows(rig.object);
  if (state.rig) scene.remove(state.rig.object);
  scene.add(rig.object);
  // dim flight-deck flood light (always present so the light count never changes; only lit in cockpit view)
  state.cockpitFill = new THREE.PointLight(0xfff0dc, 0, 3.5, 2);
  state.cockpitFill.position.copy(rig.eye.pilot).add(new THREE.Vector3(0, 0.35, 0.25));
  rig.object.add(state.cockpitFill);
  const factory = def.spec.category === 'helicopter' ? createHelicopterModel : createFixedWingModel;
  const flight = factory(def.spec, { contacts: rig.contacts });
  bindFlightEvents(flight);
  flight.setRoute(navRoute);         // navigation hook: LNAV guidance (flight.nav) + autopilot NAV mode
  navMap.setFlight(flight, def);
  state.displays = [];
  const lazyCockpit = !!(def.model.cockpitUrl && rig.attachCockpit);
  if (!lazyCockpit) bindDisplays(def, rig);
  input.setAircraft(def.spec);
  hud.setAircraft(def);
  cameraRig.setAircraft(rig, def);
  // audio streams in the background: the game starts without waiting and sounds fade in when their buffers arrive
  audio.loadAircraft(id).catch((e) => console.warn('[audio]', e));
  Object.assign(state, { def, rig, flight });
  if (lazyCockpit) {
    // detailed cockpit (CONTRACTS-SF.md §6.2.1): streamed after the exterior; the game only waits for it when it starts in the cockpit
    const loadCockpit = () => loader.loadGLTF(def.model.cockpitUrl).then((g) => {
      if (state.rig !== rig) return;   // another aircraft was loaded meanwhile
      rig.attachCockpit(g.scene);
      setupShadows(g.scene);
      bindDisplays(def, rig);
    }).catch((e) => console.warn('[app] cockpit', e));
    // robustness hook: memory-limited devices (quality.lazyCockpit) fetch it only when the cockpit view is first entered
    if (quality.lazyCockpit && cameraRig.view !== 'cockpit') state.loadCockpit = loadCockpit;
    else {
      const ready = loadCockpit();
      if (cameraRig.view === 'cockpit') await ready;
    }
  }
}

function setupShadows(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    // glass, plumes and other see-through materials neither cast shadows nor darken the cockpit
    const seeThrough = [].concat(o.material).some((m) => m && (m.transparent || m.transmission > 0 || m.blending === THREE.AdditiveBlending));
    o.castShadow = !seeThrough || !!o.customDepthMaterial;   // rigs may give see-through parts (rotor disc) a custom shadow
    o.receiveShadow = true;
  });
}

function bindDisplays(def, rig) {
  for (const [meshName, type] of Object.entries(def.model.displays || {})) {
    const mesh = rig.screens[meshName];
    if (!mesh) { console.warn(`[app] screen mesh ${meshName} missing`); continue; }
    if (state.displays.some((d) => d.mesh === mesh)) continue;
    // mesh/eye/root let the avionics align HUD symbology with the real glass and skip redraws of off-screen displays
    const display = createDisplay(type, { mesh, eye: rig.eye.pilot, root: rig.object });
    mesh.material = bindScreenMaterial(display, type);
    state.displays.push({ display, mesh });
  }
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
    if (w.type === 'reverserInhibit') hud.showMessage(`Ters itki yalnızca yerde ve gaz rölantideyken (${IS_MAC ? 'Ctrl / Z' : 'Z'})`, 2000);
    else if (w.type === 'gearLocked') hud.showMessage('Yerdeyken iniş takımı toplanamaz', 1500);
  });
}

function resetFlight() {
  const s = state.spawn;
  state.flight.reset({ x: s.x, z: s.z, heading: s.heading, altitude: s.altitude, speed: s.altitude ? state.def.spec.spawnSpeed : undefined }, state.world);
  state.crashTimer = 0;
  if (input.setThrottle) input.setThrottle(state.flight.throttle ?? 0);   // lever follows the reset engine state
  syncRig(1);
  onboarding.reset();   // onboarding hook: a running tutorial starts over from its first step
}

let prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
function syncRig() {
  const p = state.flight.position, q = state.flight.quaternion;
  if (!Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w)) return;   // robustness: keep the last valid pose (the models crash themselves on NaN)
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
// robustness hook: context loss / GPU budget guard (src/core/gpu-guard.js); state.gpu is a test hook
gpu = createGpuGuard({
  renderer, state, getQuality: () => quality,
  onHalt: () => { state.halted = true; audio.setPaused(true); },
  onStepDown: (id) => { setQualityLive(resolveQuality(id), `Grafik belleği sınırda: kalite ${QUALITY[id].label} yapıldı`); return true; },
});
state.gpu = gpu;
const SYSTEM_ACTIONS = ['gear', 'flapsDown', 'flapsUp', 'speedbrake', 'reverser', 'canopy', 'lights', 'autopilot'];
for (const a of SYSTEM_ACTIONS) input.on(a, () => { if (state.flight && state.flight.command) state.flight.command(a); });
input.on('autopilot', () => { if (audio.acknowledge) audio.acknowledge(); });   // silences an AP-disconnect alert (the causing press is ignored by audio)
input.on('camera', () => hud.showMessage(`Kamera: ${cameraRig.next()}`, 1000));
input.on('cameraPrev', () => hud.showMessage(`Kamera: ${cameraRig.prev()}`, 1000));
input.on('view', () => hud.showMessage(cameraRig.toggleView(), 1000));
// camera hook: direct cameras (Alt / Option + 1 … 7 and the HUD camera selector); again on bird's-eye flips north/track-up
input.on('cameraSelect', (id) => hud.showMessage(cameraRig.select(id), 1200));
// the detailed cockpit may still be streaming when the player first switches to it
for (const a of ['camera', 'cameraPrev', 'view', 'cameraSelect']) input.on(a, () => {
  if (cameraRig.view === 'cockpit' && state.rig && state.rig.cockpitReady === false) hud.showMessage('Kokpit yükleniyor…', 1500);
});
input.on('lookBack', () => cameraRig.lookBack(true));
input.on('reset', () => { if (state.flight) { resetFlight(); hud.showMessage('Yeniden başlatıldı', 1000); } });
input.on('pause', () => { state.paused = !state.paused; hud.setPaused(state.paused); audio.setPaused(state.paused); });
input.on('pause', () => { if (state.twControl && state.world) state.twControl.set(state.world.time, state.world.weather.preset); });   // time & weather hook
// time & weather hook: live time of day + weather from the pause screen (src/ui/menu.js control, world.setTime / setWeather)
function mountTimeWeather() {
  if (state.twControl || !hud.mountPauseControl || !state.world.setTime) return;
  state.twControl = createTimeWeatherControl(null, {
    time: state.world.time, weather: state.world.weather.preset, className: 'gkm-tw-pause',
    onChange: (v) => { state.world.setTime(v.time); if (v.weather !== state.world.weather.preset) state.world.setWeather(v.weather); if (state.choice) Object.assign(state.choice, v); },
  });
  hud.mountPauseControl(state.twControl.el);
}
input.on('hud', () => { if (hud.cycleMode) hud.cycleMode(); else { state.hudVisible = !state.hudVisible; hud.setVisible(state.hudVisible); } });   // full → compact → off
input.on('mute', () => { state.userMuted = !state.userMuted; audio.setMuted(state.userMuted); hud.showMessage(state.userMuted ? 'Ses kapalı' : 'Ses açık', 900); });
input.on('help', () => { state.helpVisible = !state.helpVisible; hud.showHelp(input.bindings, state.helpVisible); });
input.on('menu', goToMenu);
input.on('map', () => navMap.toggle('key'));   // navigation hook: J opens / closes the map (Esc closes it too)
// an accidental tab close / reload mid-flight (Ctrl+W on Windows, Cmd+W, F5) asks first instead of losing the flight
guardUnload(() => !!state.flight && !state.halted);   // (robustness: the graphics-failure reload is not asked about)

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
  if (state.halted) return;   // robustness: graphics failure being handled (notice shown, page reloading)
  const { flight, rig, world } = state;
  if (flight && rig && world) {
    if (!state.paused && !state.halted) {
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
    guardCamera();   // robustness hook
    rig.setView(cameraRig.view);
    if (state.loadCockpit && cameraRig.view === 'cockpit') { const load = state.loadCockpit; state.loadCockpit = null; hud.showMessage('Kokpit yükleniyor…', 1500); load(); }   // lazy cockpit
    if (state.cockpitFill) state.cockpitFill.intensity = cameraRig.view === 'cockpit' ? 2.5 : 0;
    world.update(dt, camera);
    displayAcc += dt;
    if (displayAcc > 1 / 30) { for (const d of state.displays) d.display.update(displayAcc, flight, world); displayAcc = 0; }
    hud.update(flight, { world, spawn: state.spawn, view: cameraRig.view });
    navMap.update(dt, flight, world);   // navigation hook: track trail, map redraw while open
    onboarding.update(dt, flight, { view: cameraRig.view, paused: state.paused });   // onboarding hook
    audio.update(dt, flight, { view: cameraRig.view, aircraftObject: rig.object, camera });
  }
  // robustness hook: a render that throws every frame draws nothing (the canvas shows the page background) → the guard
  // recovers like after a context loss; texture releases, GPU budget and the flight snapshot run in gpu.tick
  try { renderer.render(scene, camera); gpu.renderOk(); } catch (e) { gpu.renderFailed(e); }
  gpu.tick(dt);
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 1) {
    const fps = fpsFrames / fpsAcc;
    window.__fps = fps;
    adaptResolution(fps, fpsAcc);
    fpsAcc = 0; fpsFrames = 0;
  }
}
// Camera sanity (robustness): a non-finite camera pose / lens draws nothing, and the rig's smoothing would keep it that
// way. Restore the last valid pose and restart the mode (its smoothing state re-initialises).
const lastCamPos = new THREE.Vector3(0, 100, 0), lastCamQuat = new THREE.Quaternion();
let camFaults = 0;
function guardCamera() {
  const p = camera.position, q = camera.quaternion;
  if (Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w + camera.fov + camera.near)) { lastCamPos.copy(p); lastCamQuat.copy(q); return; }
  p.copy(lastCamPos); q.copy(lastCamQuat);
  if (!Number.isFinite(camera.fov) || !Number.isFinite(camera.near)) { camera.fov = 60; camera.near = 0.5; camera.updateProjectionMatrix(); }
  const m = cameraRig.mode;
  try { cameraRig.select(m === 'orbit' ? 'chase' : 'orbit'); cameraRig.select(m); } catch { /* ignore */ }
  if (camFaults++ < 3) { console.warn('[app] camera pose was not finite; restored', m); gpu.report('nan', { cam: m }); }
}

// Quality change (settings or the GPU budget monitor), applied live.
function setQualityLive(q, message) {
  if (!q || q === quality) return;
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
  hud.showMessage(message || `Grafik kalitesi: ${q.label}`, message ? 3000 : 1500);
  state.quality = quality;
}
// Settings edited in the menu / pause screen (src/core/settings.js saveSettings) apply live.
let appliedQualityId = settings.quality;
function applySettings(next) {
  settings = next;
  // only a changed choice moves the quality (a budget step-down stays until the player picks a preset)
  if (settings.quality !== appliedQualityId && QUALITY[settings.quality]) { appliedQualityId = settings.quality; setQualityLive(resolveQuality(settings.quality)); }
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
}).catch(() => {}).finally(() => startTelemetry({
  build: state.build, renderer, quality: settings.quality,
  state: () => ({ flying: !!(state.flight && state.readyAt), paused: state.paused, aircraft: state.aircraftId, fps: window.__fps, pixelRatio: renderer.getPixelRatio(), view: cameraRig.view }),
}));

requestAnimationFrame(frame);
start().catch(startFailed);

/** Loading failed: connection error screen (other errors: their text) with "Tekrar dene", which reloads straight into the chosen flight. */
function startFailed(e) {
  const net = isNetworkError(e);
  (net ? console.warn : console.error)('[app] start failed', e);
  if (!loading) loading = createLoadingScreen(uiRoot);   // failed before the loading screen (version map, runways)
  const q = new URLSearchParams(location.search);
  if (state.choice) { q.set('aircraft', state.choice.aircraftId); q.set('spawn', state.choice.spawnId); }
  if (state.choice && state.choice.time != null) { q.set('time', String(state.choice.time)); if (state.choice.weather) q.set('weather', state.choice.weather); }   // time & weather hook
  const url = q.toString() ? `${location.pathname}?${q}` : location.pathname;
  loading.showError(net ? undefined : `Oyun yüklenemedi: ${e.message}`, () => location.replace(url));
}
