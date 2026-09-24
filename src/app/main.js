// Lead-owned entry point of the San Francisco game.
import * as THREE from 'three';
import { createAssetLoader, loadAssetVersions, loadBuildInfo, isNetworkError, retryDelay } from '../core/assets.js';
import { modelSeen, noteModelLoaded, measuredMbps, loadGlbJson, parseSkeleton, graftLod, copyVisual } from './aircraft-lod.js';   // LOD-first start (plan #2)
import { createSFWorld } from '../world-sf/index.js';
import { AIRCRAFT, loadAircraftDefinition } from '../aircraft/registry.js';
import { createFixedWingModel } from '../flight/fixedwing.js';
import { createHelicopterModel } from '../flight/helicopter.js';
import { createInput } from '../flight/input.js';
import { createDisplay, loadAvionicsFonts } from '../avionics/index.js';
import { createAudioSystem } from '../audio/index.js';
import { createMenu, createLoadingScreen, createHUD, createCameraRig, createOnboarding } from '../ui/index.js';
import { MAPS, pickMap, loadMap, useMap, mapHooks } from '../maps/index.js';   // maps: San Francisco, İstanbul
import { BRIDGES } from '../ui/baymap.js';
import { AIRPORTS, AIRPORT_ORDER, TIPS, TOUCH_TIPS } from '../ui/data.js';
import { TOWERS } from '../ui/camera.js';
import { setNavData } from '../avionics/nav.js';
import { loadSettings } from '../core/settings.js';
import { QUALITY, resolveQuality, lowerQuality, setQualityCap } from '../core/quality.js';
import { detectDevice } from '../core/gpu-device.js';
import { createGpuGuard, noteGpuFailure } from '../core/gpu-guard.js';          // robustness: context loss, GPU budget
import { readResume, applyResume, clearResume } from '../core/gpu-resume.js';
import { IS_MAC } from '../core/platform.js';
import { goToMenu, guardUnload } from '../core/leave.js';
import { startTelemetry, trackFlight, trackFail, setTelemetryMap } from '../core/telemetry.js';
import { createRoute } from '../nav/route.js';     // navigation hook: route planning + LNAV (src/nav)
import { createNavMap } from '../ui/map.js';       // navigation hook: big map (J / minimap click)
import { runDeviceGate, showInAppFailure } from '../ui/touch-gate.js';   // mobile hook: weak / unsupported device gate
import { inAppBrowser } from '../ui/touch-env.js';
import { createTouchControls } from '../ui/touch.js';          // mobile hook: on-screen controls (phones / tablets)

const params = new URLSearchParams(location.search);
const app = document.getElementById('app');
const uiRoot = document.getElementById('ui');
const hudRoot = document.getElementById('hud');
// mobile hook (src/ui/touch-gate.js): a device that cannot run the game gets the "bilgisayardan gir" screen before the
// renderer and the world exist (no WebGL 2 never continues; weak phones may choose "Yine de dene")
await runDeviceGate(uiRoot);

// ---- settings / quality ----
let settings = loadSettings();
if (params.has('quality') && QUALITY[params.get('quality')]) settings.quality = params.get('quality');   // ?quality=low|medium|high|ultra
// robustness hook: a flight saved before a graphics failure (?resume=1 reload, or this tab died mid-flight)
let resume = readResume(params);
if (resume && resume.crash) {   // the previous page of this tab died without unloading: treat it as a GPU failure too
  if (noteGpuFailure() >= 3) resume = null;   // it keeps dying: start normally (menu / direct link) instead
  else {
    const lower = lowerQuality(settings.quality) || 'low'; settings.quality = lower;
    if (detectDevice().kind !== 'desktop') setQualityCap(lower);   // a lasting cap only where memory kills are real (phones/tablets)
  }
}
let quality = resolveQuality(QUALITY[settings.quality] ? settings.quality : 'high');   // preset + device caps (src/core/quality.js)
// maps hook (src/maps/index.js): ?map=, a deep link's mission / spawn, a resumed flight, else the menu's last choice
let mapId = pickMap(params, resume);
setTelemetryMap(mapId);
Object.assign(mapHooks, { BRIDGES, AIRPORTS, AIRPORT_ORDER, TIPS, TOUCH_TIPS, TOWERS, setNavData });   // tables a map module switches over

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

const state = { world: null, def: null, rig: null, flight: null, displays: [], paused: false, hudVisible: true, helpVisible: false, crashTimer: 0, spawn: null, userMuted: false,
  standIn: null, upgrade: null, warming: false, texQueue: [] };
state.input = input;
state.onboarding = onboarding;   // test hook
window.__game = state;
// navigation hook: one route for the session (kept across resets and aircraft changes; the flight model flies it with
// its autopilot), the big map over the running game (J or a click on the minimap), the route on the minimap
const navRoute = createRoute();
const navMap = createNavMap({ hud, route: navRoute });
hud.setNavMap({ open: (src) => navMap.open(src), overlay: navMap.drawMinimapOverlay });
Object.assign(state, { navRoute, navMap });   // test hooks
// mobile hook (src/ui/touch.js): stick, throttle slider and buttons on touch devices (nothing is built on desktops)
const touchUI = createTouchControls(hud.element, { input, hud, getState: () => ({ flying: !!(state.flight && state.readyAt), paused: state.paused, mapOpen: navMap.isOpen }) });
state.touch = touchUI;   // test hook

let loading = null;   // loading screen (also used by startFailed)
// missions hook (src/missions/**, CONTRACTS-SF.md §12): the mission runtime is its own lazily loaded chunk (nothing is
// loaded for free flight); the landing score card (src/ui/landing.js) is a small module loaded after the menu
let missionMod = null, landing = null, landingP = null;
// free-flight challenges hook (src/missions/ff-runtime.js, CONTRACTS-SF.md §12.1): the missions' objectives detected while
// flying freely, the "Görevler" panel (Enter / GÖREV); its own chunk, imported when the main thread is idle after the
// first playable frame; never in mission mode
let ffc = null, ffcLoading = false;
function loadChallenges() {
  if (ffc || ffcLoading || state.mission || state.halted || params.get('ffc') === '0') return;
  ffcLoading = true;
  const go = () => import('../missions/ff-runtime.js').then(async (m) => {
    await landingP;
    const set = await m.loadChallengeSet(mapId, state.world && state.world.runways);   // maps hook: the map's challenges (none yet: no panel)
    if (state.mission || ffc || !state.flight || !set) return;
    ffc = m.createFreeFlightChallenges({
      state, scene, camera, hud, landing, touch: touchUI.active, aircraft: state.aircraftId, set,
      leave: (url) => { state.leaving = true; clearResume(); location.href = url; },   // (no "leave the page?" prompt)
      compile: (obj) => renderer.compileAsync(obj, camera, scene),
      canToggle: () => !state.paused && !state.helpVisible && !navMap.isOpen,
    });
    state.ffc = ffc;   // test hook
    input.setExtraBindings([{ keys: 'Enter', touch: 'GÖREV', label: 'Serbest uçuş görevleri: listeyi aç / kapat (uçuş durmaz)' }]);
  }).catch((e) => { if (!isNetworkError(e)) console.warn('[challenges]', e); ffcLoading = false; });
  afterFrames(20, () => { if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 1000); });
}
async function planMissionFor(req, runways, map) {
  try { missionMod = await import('../missions/runtime.js'); return await missionMod.planMission(req, runways, map); } catch (e) {
    if (isNetworkError(e)) throw e;
    console.warn('[missions] cannot start', req && req.id, e);
    return null;
  }
}
const aircraftShort = () => (state.def ? String(state.def.name || state.def.id).replace(/^(Airbus|Boeing) /, '').replace(/ (Fighting Falcon|Raptor|Black Hawk)$/, '') : '');
function loadLandingCard() {
  landingP = import('../ui/landing.js').then((m) => {
    landing = m.createLandingCard({ hud, getWorld: () => state.world, airports: AIRPORTS, prepareShare: (card) => import('../ui/share.js').then((x) => x.prepareLanding(card, { aircraft: aircraftShort(), map: MAPS[mapId] })) });
    state.landing = landing;   // test hook
    if (state.flight) landing.attach(state.flight, state.def);
    return landing;
  }).catch((e) => { console.warn('[landing]', e); return null; });
  return landingP;
}
async function start() {
  await loadAssetVersions();   // CONTRACTS-SF.md §9: version map before any asset request (menu thumbnails too)
  let { runways, spawns, map } = await loadMap(mapId, loader);
  let choice, plan = null;
  const direct = AIRCRAFT.find((a) => a.id === params.get('aircraft'));   // ?aircraft=<id>&spawn=<id> skips the menu
  const resumed = resume && AIRCRAFT.some((a) => a.id === resume.aircraft) ? resume : null;   // robustness hook: same flight
  const missionReq = !resumed && params.get('mission') ? { id: params.get('mission'), daily: params.get('daily') } : null;   // missions hook: ?mission=<id>(&daily=YYYYMMDD)
  if (missionReq) plan = await planMissionFor(missionReq, runways, mapId);
  if (resumed) choice = { aircraftId: resumed.aircraft, spawnId: spawns.some((s) => s.id === resumed.spawn) ? resumed.spawn : spawns[0].id };
  else if (plan) choice = { aircraftId: plan.aircraft, spawnId: plan.spawn.id, mission: missionReq };
  else if (direct) choice = { aircraftId: direct.id, spawnId: spawns.some((s) => s.id === params.get('spawn')) ? params.get('spawn') : (map.defaultSpawns && map.defaultSpawns[direct.id]) || direct.defaultSpawn };
  else choice = await createMenu(uiRoot, { aircraft: AIRCRAFT, spawns, maps: { id: mapId, list: Object.values(MAPS), load: (id) => loadMap(id, loader) } });
  if (choice.map && choice.map !== mapId) ({ runways, spawns, map } = await loadMap(mapId = choice.map, loader));   // the menu's map choice
  useMap(mapId);
  setTelemetryMap(mapId);
  if (!plan && choice.mission) {   // missions hook: "Görevler" in the menu — the mission picks the aircraft and the start
    plan = await planMissionFor(choice.mission, runways, mapId);
    if (plan) choice = { ...choice, aircraftId: plan.aircraft, spawnId: plan.spawn.id }; else delete choice.mission;
  }
  audio.start();
  state.choice = { ...choice, map: mapId };
  loadLandingCard();   // missions hook: landing score card (free flight and missions)
  const spawn = plan ? plan.spawn : spawns.find((s) => s.id === choice.spawnId) || spawns[0];
  state.spawn = spawn;

  loading = createLoadingScreen(uiRoot);
  const t0 = performance.now();
  state.t0 = t0;
  // the aircraft is built while the world loads (its lights and materials are then part of the scene the loading frames
  // compile): the full model, or on a cold start on the ground its LOD stand-in with the full model after the first frame
  const aircraftP = prepareAircraft(choice.aircraftId, { lodOk: !resumed && !spawn.altitude });
  aircraftP.catch(() => {});   // (awaited below, after the world)
  if (!state.world) {
    const focus = resumed ? { x: resumed.x, z: resumed.z } : { x: spawn.x, z: spawn.z };   // robustness hook: load around the resumed aircraft
    state.world = await createSFWorld({ scene, renderer, camera, loader, quality, focus, onProgress: (p, t) => loading.setProgress(p * 0.8, t), map, runways: map.module ? runways : null });
  }
  loading.setProgress(0.85, 'Uçak yükleniyor');
  await loadAircraft(await aircraftP);
  if (plan) {   // missions hook: the runtime drives resetFlight (start state), holds the flight for the briefing / results
    await landingP;
    state.mission = missionMod.createMissionRuntime(plan, {
      state, scene, camera, hud, input, audio, navRoute, landing, touch: touchUI.active, resetFlight, goToMenu, map,
      // where the player came from (telemetry `mission` brief): the menu / its daily card, a link, or "Görev olarak oyna"
      via: missionReq ? ({ ff: 'ff', next: 'next' }[params.get('from')] || 'link') : choice.mission && choice.mission.daily ? 'daily' : 'menu',
      leave: (url) => { state.leaving = true; location.href = url; },
      snapshot: () => { renderer.render(scene, camera); return renderer.domElement; },   // share card image (same task as the render)
    });
  }
  resetFlight();
  let resumeNote = null;
  if (resumed) { try { resumeNote = applyResume(state, resumed, { input }); } catch (e) { console.warn('[resume]', e); } }   // robustness hook
  loading.setProgress(0.95, 'Görüntü hazırlanıyor');
  await prewarm();
  loading.setProgress(1, 'Hazır');
  loading.hide();
  state.readyAt = performance.now();   // dynamic resolution ignores the first seconds (shader compiles, tile bursts)
  console.log(`[app] ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  state.aircraftId = choice.aircraftId;
  if (state.halted) return;   // robustness: the graphics guard gave up while loading (notice shown): no flight to report
  if (state.standIn) upgradeAircraft();   // LOD start: the full model now, swapped in when it is ready
  trackFlight(choice.aircraftId, spawn.id, (performance.now() - t0) / 1000, settings.quality, { in: touchUI.active ? 'touch' : input.kind, tilt: touchUI.active && settings.tilt ? 1 : undefined, mi: state.mission ? state.mission.mission.id : undefined });
  if (resumed) {   // robustness hook: back in the same flight after a graphics failure (no tutorial / key card)
    gpu.report('resume', { why: resumed.crash ? 'crash' : resumed.reason || 'gpu', ac: choice.aircraftId });
    hud.showMessage(`Uçuşa kaldığın yerden devam ediliyor · Grafik: ${quality.label}${resumeNote ? ' · ' + resumeNote : ''}`, 4500);
    loadChallenges();
    return;
  }
  clearResume();
  if (state.mission) {   // missions hook: no first-flight tutorial over a mission (the briefing lists the essential controls)
    const cur = state.settings || settings;
    window.dispatchEvent(new CustomEvent('gokyuzu:settings', { detail: { ...cur, tutorial: false } }));   // (not saved)
    onboarding.begin({ flight: state.flight, def: state.def, spawn });
    window.dispatchEvent(new CustomEvent('gokyuzu:settings', { detail: cur }));   // hints stay on
    state.mission.begin();
    return;
  }
  // onboarding hook: tutorial on the first flight of the category, otherwise the key card + start message
  onboarding.begin({ flight: state.flight, def: state.def, spawn });
  loadChallenges();   // free-flight challenges hook
}

/**
 * Definition + rig of the chosen aircraft, built while the world loads, and added to the scene with its shadow flags and
 * the cockpit fill light right away (the light count is final before the world's materials are compiled).
 * LOD start (docs/perf/plan.md #2; src/app/aircraft-lod.js): on a cold start on the ground in the chase view the rig is a
 * stand-in (the full GLB's node skeleton from its first ~100 KB + the 0.4–0.6 MB LOD mesh) with the full model's exact
 * contacts, eye points, bounds, lights and effects; upgradeAircraft() swaps the full model in after the first frame.
 */
async function prepareAircraft(id, { lodOk }) {
  const def = await loadAircraftDefinition(id);
  let prepared = null;
  if (lodOk && lodStartWanted(def)) {
    try { prepared = await buildStandIn(def); } catch (e) { console.warn('[app] LOD start unavailable, loading the full model:', e && e.message); }
  }
  if (!prepared) {
    const gltf = def.model.url ? await loader.loadGLTF(def.model.url) : null;
    if (gltf) noteModelLoaded(def.model.url);
    prepared = { def, rig: def.createRig(gltf ? gltf.scene : null), standIn: null };
  }
  const { rig } = prepared;
  setupShadows(rig.object);
  if (state.rig) scene.remove(state.rig.object);
  scene.add(rig.object);
  // dim flight-deck flood light (always present so the light count never changes; only lit in cockpit view)
  state.cockpitFill = new THREE.PointLight(0xfff0dc, 0, 3.5, 2);
  state.cockpitFill.position.copy(rig.eye.pilot).add(new THREE.Vector3(0, 0.35, 0.25));
  rig.object.add(state.cockpitFill);
  state.texQueue.push(...texturesIn(rig.object));   // uploaded one per frame while the world is still loading
  return prepared;
}

/**
 * LOD start only where the full model would hold up the start: not downloaded by this browser before (a cached model
 * decodes as fast as the LOD would download) and no fast connection (≥ 50 Mbit/s: the full model costs < 1 s there).
 * ?lod=0 / ?lod=1 force it off / on (tests).
 */
function lodStartWanted(def) {
  const m = def.model, force = params.get('lod');
  if (!m.url || !m.lodUrl || force === '0' || cameraRig.view !== 'exterior') return false;
  if (force === '1') return true;
  if (modelSeen(m.url)) return false;
  const mbps = measuredMbps();
  state.startMbps = mbps == null ? null : Math.round(mbps);   // test hook
  return !(mbps >= 50);
}

async function buildStandIn(def) {
  // (the LOD load is cached: the airports' parked aircraft use the same file)
  const [json, lod] = await Promise.all([loadGlbJson(def.model.url), loader.loadGLTF(def.model.lodUrl)]);
  const skeleton = await parseSkeleton(json, loader.draco);
  const lodParts = graftLod(skeleton, lod.scene);
  const rig = def.createRig(skeleton);
  return { def, rig, standIn: { rig, lodParts, cockpit: null } };
}

async function loadAircraft({ def, rig, standIn }) {
  const factory = def.spec.category === 'helicopter' ? createHelicopterModel : createFixedWingModel;
  const flight = factory(def.spec, { contacts: rig.contacts });   // (a stand-in's contacts are the full model's)
  bindFlightEvents(flight);
  flight.setRoute(navRoute);         // navigation hook: LNAV guidance (flight.nav) + autopilot NAV mode
  navMap.setFlight(flight, def);
  state.displays = [];
  const lazyCockpit = !!(def.model.cockpitUrl && rig.attachCockpit);
  if (!lazyCockpit) bindDisplays(def, rig);
  input.setAircraft(def.spec);
  hud.setAircraft(def);
  Object.assign(state, { def, rig, flight, standIn });
  if (landing) landing.attach(flight, def);   // missions hook: landing score card
  cameraRig.setAircraft(rigView, def);   // (reads bounds + eye now; follows whichever rig is current, see rigView)
  // audio streams in the background: the game starts without waiting and sounds fade in when their buffers arrive
  audio.loadAircraft(def.id).catch((e) => console.warn('[audio]', e));
  if (standIn) return;   // cockpit and full model follow after the start (upgradeAircraft)
  if (lazyCockpit) {
    const ready = setupCockpit(def);
    if (ready && cameraRig.view === 'cockpit') await ready;
  }
}
// the camera rig keeps one rig object for the whole flight: this one always answers with the current rig
const rigView = {
  get object() { return state.rig ? state.rig.object : null; },
  get bounds() { return state.rig ? state.rig.bounds : null; },
  get eye() { return state.rig ? state.rig.eye : null; },
};

/**
 * Detailed cockpit (CONTRACTS-SF.md §6.2.1): streamed after the start and attached to whichever rig is current when it
 * arrives (a LOD stand-in hands it over to the full rig at the swap). Returns the load promise (null when deferred).
 */
function setupCockpit(def) {
  const loadCockpit = () => (loadAvionicsFonts(), loader.loadGLTF(def.model.cockpitUrl)).then((g) => {
    const rig = state.rig;
    if (!rig || state.def !== def || rig.cockpitReady || g.scene.parent) return;   // (attached already / other aircraft)
    if (state.standIn && rig === state.standIn.rig) state.standIn.cockpit = { scene: g.scene, snap: snapshotNodes(g.scene) };
    attachCockpit(def, rig, g.scene);
  }).catch((e) => console.warn('[app] cockpit', e));
  // robustness hook: memory-limited devices (quality.lazyCockpit) fetch it only when the cockpit view is first entered
  if (quality.lazyCockpit && cameraRig.view !== 'cockpit') { state.loadCockpit = loadCockpit; return null; }
  state.loadCockpit = null;
  return loadCockpit();
}
function attachCockpit(def, rig, cockpitScene) {
  rig.attachCockpit(cockpitScene);
  setupShadows(cockpitScene);
  bindDisplays(def, rig);
  // the first switch to the cockpit view without shader compiles (after the rig's next update, which may adjust shadow
  // flags); its textures still upload on the first cockpit frame (a background upload would stall a random frame)
  afterFrames(2, () => { if (state.rig === rig) renderer.compileAsync(cockpitScene, camera, scene).catch(() => {}); });
}
/** Local transforms, visibility and screen UVs of a freshly loaded cockpit, to give a second rig the same starting point. */
function snapshotNodes(root) {
  const nodes = [], uvs = [];
  root.traverse((o) => {
    nodes.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone(), o.visible]);
    const uv = o.isMesh && o.geometry && o.geometry.attributes.uv;
    if (uv && /^screen_/.test(o.name)) uvs.push([o, uv.array.slice(), o.userData.uvFlipped]);
  });
  return { nodes, uvs };
}
function restoreNodes(snap) {
  for (const [o, p, q, s, v] of snap.nodes) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); o.visible = v; }
  for (const [o, arr, flipped] of snap.uvs) {
    const uv = o.geometry.attributes.uv;
    uv.array.set(arr); uv.needsUpdate = true;
    if (flipped === undefined) delete o.userData.uvFlipped; else o.userData.uvFlipped = flipped;
  }
}

// ---- LOD start: the full model after the first frame (plan #2)
// The full rig is built hidden in the scene, replays every (dt, VisualState, view) the stand-in received since the start
// (its smoothing, strobe and wheel/rotor phases end up exactly where the stand-in's are), compiles its programs and
// uploads its textures one per frame, and replaces the stand-in between two frames at the same transform. The flight
// model keeps its contacts (identical by construction); the camera follows through rigView.
function upgradeAircraft() {
  const { def, rig: from } = state;
  const up = { def, from, log: [], replayed: 0, rig: null, textures: null, compiled: false, t: performance.now() };
  state.upgrade = up;
  (async () => {
    // the detailed cockpit first (the stand-in cannot show it; it moves to the full rig at the swap), then the exterior
    // (memory-limited devices: the cockpit when its view is first entered)
    const cockpit = def.model.cockpitUrl && from.attachCockpit ? setupCockpit(def) : null;
    if (cockpit) await cockpit;
    let gltf;
    for (let n = 1; ; n++) {   // a dropped connection: keep flying the stand-in and try again later
      try { gltf = await loader.loadGLTF(def.model.url); break; } catch (e) { if (!isNetworkError(e)) throw e; await sleep(retryDelay(n)); }
    }
    noteModelLoaded(def.model.url);
    up.tLoaded = performance.now();
    if (state.upgrade !== up) return;
    const rig = def.createRig(gltf.scene);
    setupShadows(rig.object);
    rig.object.visible = false;   // hidden: its lights do not count yet (the stand-in's do), nothing is drawn
    rig.object.position.copy(from.object.position); rig.object.quaternion.copy(from.object.quaternion);
    scene.add(rig.object);
    up.rig = rig;   // stepUpgrade replays into it; programs and textures follow its first update (rigs adjust shadow flags there)
    up.tRig = performance.now();
  })().catch((e) => { if (state.upgrade === up) state.upgrade = null; console.warn('[app] full aircraft model unavailable, keeping the LOD model:', e && e.message); });
}
const UPGRADE_LOG_MAX = 7200;   // 2 min at 60 fps of VisualState copies while the full model downloads
function recordUpgrade(up, dt, vis, view) {
  if (up.log.length >= UPGRADE_LOG_MAX) { up.log.splice(0, 1200); up.replayed = Math.max(0, up.replayed - 1200); }
  up.log.push([dt, copyVisual(vis), view]);
}
/** After the render: replay the recorded frames into the hidden full rig (≤ 3 ms per frame) and upload one texture. */
function stepUpgrade(up) {
  if (!up.rig) return;
  const t = performance.now();
  while (up.replayed < up.log.length && performance.now() - t < 3) {
    const [dt, v, view] = up.log[up.replayed++];
    up.rig.update(dt, v);
    up.rig.setView(view);
  }
  if (up.replayed === up.log.length) { up.log.length = 0; up.replayed = 0; }
  if (!up.textures) {
    up.textures = [...texturesIn(up.rig.object)];
    renderer.compileAsync(up.rig.object, camera, scene).catch(() => {}).then(() => { up.compiled = true; up.tCompiled = performance.now(); });
  } else if (up.textures.length) renderer.initTexture(up.textures.shift());
}
function swapAircraft(up) {
  const { from, rig, def } = up;
  state.upgrade = null;
  if (state.rig !== from) { scene.remove(rig.object); return; }
  rig.object.visible = true;
  scene.remove(from.object);
  if (state.cockpitFill) rig.object.add(state.cockpitFill);   // the same light moves over: the light count never changes
  state.rig = rig;
  if (rig.contacts.some((c, i) => !from.contacts[i] || c.position.distanceTo(from.contacts[i].position) > 1e-9)) console.warn('[app] stand-in contacts differ from the full model');
  const standIn = state.standIn, ck = standIn && standIn.cockpit;
  if (ck) { restoreNodes(ck.snap); attachCockpit(def, rig, ck.scene); }   // the stand-in's cockpit moves over, as loaded
  disposeStandIn(from, standIn, rig);
  state.standIn = null;
  state.swapAt = performance.now();
  state.swapInfo = { loaded: up.tLoaded, rig: up.tRig, compiled: up.tCompiled, swap: state.swapAt };   // test hook
  console.log(`[app] full aircraft model in ${((state.swapAt - (state.readyAt || state.swapAt)) / 1000).toFixed(1)} s after the start`);
  if (ck) return;
  if (def.model.cockpitUrl && rig.attachCockpit) setupCockpit(def);   // (not loaded yet: attaches to the full rig when it arrives)
  else { state.displays = []; bindDisplays(def, rig); }
}
/** The stand-in's own materials (rig-made and the LOD copies); LOD geometries and textures stay (shared with the airports). */
function disposeStandIn(from, standIn, keep) {
  const kept = new Set();
  keep.object.traverse((o) => { for (const m of [].concat(o.material || [])) kept.add(m); });
  const mats = new Set(standIn && standIn.lodParts ? standIn.lodParts.materials : []);
  from.object.traverse((o) => { for (const m of [].concat(o.material || [])) if (m && !kept.has(m)) mats.add(m); });
  for (const m of mats) m.dispose();
}
const TEX_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'lightMap', 'specularMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap',
  'specularIntensityMap', 'specularColorMap', 'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap', 'envMap'];
/** Image textures of a subtree that are not on the GPU yet. */
function texturesIn(root) {
  const out = new Set();
  const add = (t) => {
    if (!t || !t.isTexture || t.isRenderTargetTexture || t.isCubeTexture || t.isVideoTexture || t.isCanvasTexture) return;
    const p = renderer.properties.get(t);
    if (!p.__webglTexture || p.__version !== t.version) out.add(t);
  };
  root.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m) continue;
      for (const k of TEX_KEYS) add(m[k]);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) add(u.value);
    }
  });
  return out;
}

// ---- pre-warm (plan #4): the first playable frame without the start-up stutter
// Compile every material of the scene against the final lights (in parallel where KHR_parallel_shader_compile exists),
// then render the start view once behind the loading screen (it uploads the textures the view shows), then lift it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 250); });   // (hidden tab: no rAF)
const afterFrames = (n, fn) => (n <= 0 ? fn() : requestAnimationFrame(() => afterFrames(n - 1, fn)));
async function prewarm() {
  if (document.hidden || params.get('prewarm') === '0') return;
  const t = performance.now(), info = { programs0: renderer.info.programs.length };
  state.warming = true;   // the loop keeps streaming and places aircraft + camera, but neither steps the flight nor renders
  try {
    await nextFrame();
    info.frameMs = Math.round(performance.now() - t);
    // (again while the world keeps streaming during the wait: the second pass only finds what arrived meanwhile)
    for (let pass = 0, until = performance.now() + 5000; pass < 3 && performance.now() < until; pass++) {
      const n = renderer.info.programs.length;
      await Promise.race([renderer.compileAsync(scene, camera), sleep(until - performance.now())]);
      if (pass > 0 && renderer.info.programs.length === n) break;
    }
    info.compileMs = Math.round(performance.now() - t) - info.frameMs;
    info.programs1 = renderer.info.programs.length;
    while (state.texQueue.length) renderer.initTexture(state.texQueue.shift());   // the aircraft's textures not uploaded yet
    state.warming = 'render';   // one frame rendered behind the loading screen (uploads the textures of the start view)
    for (let n = renderCount, i = 0; renderCount === n && i < 8; i++) await nextFrame();
    await nextFrame();   // (presented before the loading screen starts to fade)
  } catch (e) { console.warn('[app] prewarm', e); } finally { state.warming = false; }
  state.prewarmMs = Math.round(performance.now() - t);
  state.prewarmInfo = Object.assign(info, { totalMs: state.prewarmMs, programs2: renderer.info.programs.length });
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
  flight.on('crash', () => {
    if (state.mission && state.mission.claimCrash(flight)) return;   // missions hook: a rated ditching is not a crash
    if (ffc && ffc.onCrash(flight)) return;   // free-flight challenges hook: running runs fail, the flight's results show
    audio.play('crash'); hud.showMessage(`Kaza! ${flight.crashReason || ''}`.trim(), 3500);
    state.crashTimer = state.mission ? 0 : 4;   // missions hook: the results screen instead of the automatic reset
  });
  flight.on('touchdown', (i) => {
    if (landingP) return;   // missions hook: the landing score card (src/ui/landing.js) replaces this message
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
  if (state.mission) state.mission.resetFlight();   // missions hook: the mission's start state, objectives and failures
  else state.flight.reset({ x: s.x, z: s.z, heading: s.heading, altitude: s.altitude, speed: s.altitude ? (s.hover && state.def.spec.category === 'helicopter' ? 0 : state.def.spec.spawnSpeed) : undefined }, state.world);
  if (landing) landing.reset();
  if (ffc) ffc.onReset();   // free-flight challenges hook: running runs end silently
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
  onInAppFailure: (retry) => showInAppFailure(retry),   // mobile hook: X / Instagram webview → "Safari'de aç" instead of a reload
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
input.on('hud', () => { if (hud.cycleMode) hud.cycleMode(); else { state.hudVisible = !state.hudVisible; hud.setVisible(state.hudVisible); } });   // full → compact → off
input.on('mute', () => { state.userMuted = !state.userMuted; audio.setMuted(state.userMuted); hud.showMessage(state.userMuted ? 'Ses kapalı' : 'Ses açık', 900); });
input.on('help', () => { state.helpVisible = !state.helpVisible; hud.showHelp(input.bindings, state.helpVisible); });
input.on('menu', goToMenu);
input.on('map', () => navMap.toggle('key'));   // navigation hook: J opens / closes the map (Esc closes it too)
// an accidental tab close / reload mid-flight (Ctrl+W on Windows, Cmd+W, F5) asks first instead of losing the flight
guardUnload(() => !!state.flight && !state.halted && !state.leaving);   // (robustness: the graphics-failure reload is not asked about; missions: "Sonraki görev")

// ---- loop ----
const timer = new THREE.Timer();
timer.connect(document);
let fpsAcc = 0, fpsFrames = 0, displayAcc = 0, renderCount = 0;
const invertedInput = {};
function frame(ts) {
  requestAnimationFrame(frame);
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  input.update(dt);
  if (state.halted) return;   // robustness: graphics failure being handled (notice shown, page reloading)
  const up = state.upgrade;   // LOD start: the full model replaces the stand-in between two frames once it is ready
  if (up && up.compiled && up.textures && !up.textures.length && up.replayed === up.log.length) swapAircraft(up);
  const { flight, rig, world } = state;
  if (flight && rig && world) {
    if (!state.paused && !state.halted && !state.warming && !(state.mission && state.mission.hold)) {   // missions hook: held for the briefing / results
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
    const vis = flight.getVisualState();
    const rdt = state.warming ? 0 : dt;   // pre-warm frames place aircraft and camera without advancing their animations
    rig.update(rdt, vis);
    cameraRig.update(rdt, flight);
    guardCamera();   // robustness hook
    rig.setView(cameraRig.view);
    if (state.upgrade) recordUpgrade(state.upgrade, rdt, vis, cameraRig.view);
    if (state.loadCockpit && cameraRig.view === 'cockpit') { const load = state.loadCockpit; state.loadCockpit = null; hud.showMessage('Kokpit yükleniyor…', 1500); load(); }   // lazy cockpit
    if (state.cockpitFill) state.cockpitFill.intensity = cameraRig.view === 'cockpit' ? 2.5 : 0;
    world.update(dt, camera);
    displayAcc += dt;
    if (displayAcc > 1 / 30) { for (const d of state.displays) d.display.update(displayAcc, flight, world); displayAcc = 0; }
    hud.update(flight, { world, spawn: state.spawn, view: cameraRig.view });
    navMap.update(dt, flight, world);   // navigation hook: track trail, map redraw while open
    onboarding.update(dt, flight, { view: cameraRig.view, paused: state.paused });   // onboarding hook
    if (landing) landing.update(dt, flight);   // missions hook: landing score card (idle without a touchdown)
    if (state.mission) state.mission.update(dt, { paused: state.paused || !!state.warming });   // missions hook
    else if (ffc) ffc.update(dt, { paused: state.paused || !!state.warming });   // free-flight challenges hook
    touchUI.update(dt, flight, { view: cameraRig.view });   // mobile hook
    audio.update(dt, flight, { view: cameraRig.view, aircraftObject: rig.object, camera });
  }
  // robustness hook: a render that throws every frame draws nothing (the canvas shows the page background) → the guard
  // recovers like after a context loss; texture releases, GPU budget and the flight snapshot run in gpu.tick
  if (state.warming !== true) { try { renderer.render(scene, camera); gpu.renderOk(); } catch (e) { gpu.renderFailed(e); } renderCount++; }
  if (state.upgrade) stepUpgrade(state.upgrade);
  else if (state.texQueue.length && !state.readyAt) renderer.initTexture(state.texQueue.shift());   // aircraft textures while the world loads
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
loadBuildInfo().then((b) => {   // (the same memoized request the asset version map uses)
  if (!b) return;
  state.build = b;
  if (b.target === 'staging') {
    const tag = document.createElement('div');
    tag.textContent = `STAGING · ${b.version}`;
    tag.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:50;padding:4px 10px;border-radius:6px;background:#f2801a;color:#111;font:600 12px -apple-system,sans-serif;pointer-events:none;opacity:.9';
    document.body.append(tag);
  }
}).catch(() => {}).finally(() => startTelemetry({
  extra: { in: touchUI.active ? 'touch' : input.kind, touch: touchUI.active ? 1 : undefined, iab: (inAppBrowser() || {}).id },   // mobile hook
  build: state.build, renderer, quality: settings.quality,
  state: () => ({ flying: !!(state.flight && state.readyAt), paused: state.paused, aircraft: state.aircraftId, fps: window.__fps, pixelRatio: renderer.getPixelRatio(), view: cameraRig.view }),
}));

requestAnimationFrame(frame);
start().catch(startFailed);

/** Loading failed: connection error screen (other errors: their text) with "Tekrar dene", which reloads straight into the chosen flight. */
function startFailed(e) {
  const net = isNetworkError(e);
  (net ? console.warn : console.error)('[app] start failed', e);
  trackFail(state.world ? 'aircraft' : state.choice ? 'world' : 'menu', e && e.message, net);   // load failures were invisible in the analytics
  if (!loading) loading = createLoadingScreen(uiRoot);   // failed before the loading screen (version map, runways)
  const q = new URLSearchParams(location.search);
  if (mapId !== 'sf') q.set('map', mapId);   // maps hook
  if (state.choice && state.choice.mission) { q.set('mission', state.choice.mission.id); if (state.choice.mission.daily) q.set('daily', state.choice.mission.daily); }   // missions hook
  else if (state.choice) { q.set('aircraft', state.choice.aircraftId); q.set('spawn', state.choice.spawnId); }
  const url = q.toString() ? `${location.pathname}?${q}` : location.pathname;
  loading.showError(net ? undefined : `Oyun yüklenemedi: ${e.message}`, () => location.replace(url));
}
