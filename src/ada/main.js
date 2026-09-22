import * as THREE from 'three';
import { SPAWN } from './config.js';
import { createWorld } from './world/world.js';
import { createAircraft } from './models/aircraft.js';
import { createAirport } from './models/airport.js';
import { createInput } from './flight/input.js';
import { FlightModel } from './flight/physics.js';
import { createHUD } from './game/hud.js';
import { createCameraRig } from './game/camera.js';
import { createMissions } from './game/missions.js';
import { createAudio } from './game/audio.js';

const app = document.getElementById('app');
const hudEl = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const loading = document.getElementById('loading');

// ---- renderer / scene / camera ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.3, 30000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- modules ----
const world = createWorld(scene, renderer);
const aircraft = createAircraft();
scene.add(aircraft.object);
const airport = createAirport(world);
scene.add(airport);

const input = createInput(window);
const flight = new FlightModel({ gearHeight: aircraft.gearHeight });
const cameraRig = createCameraRig(camera, aircraft, renderer.domElement, world);
const missions = createMissions(scene, world);
const hud = createHUD(hudEl, world);
const audio = createAudio();

// ---- game state ----
let started = false;
let paused = false;
let hudVisible = true;
let helpVisible = false;
let crashTimer = 0;       // seconds until auto-reset after a crash
let userMuted = false;     // player's own mute choice; pausing also silences audio
const applyMute = () => audio.setMuted(userMuted || paused);
let missionState = missions.update(0, flight);

function resetFlight() {
  flight.reset(SPAWN.x, SPAWN.z, SPAWN.heading, world);
  missions.reset();
  crashTimer = 0;
  syncAircraft();
}

function syncAircraft() {
  aircraft.object.position.copy(flight.position);
  aircraft.object.quaternion.copy(flight.quaternion);
}

// ---- events ----
flight.on('crash', (info) => {
  audio.crash();
  hud.showMessage(`Kaza! ${flight.crashReason || ''}`.trim(), 3000);
  crashTimer = 3.2;
});
flight.on('touchdown', (info) => {
  audio.touchdown();
  const vs = Math.abs(info.verticalSpeed);
  const grade = vs < 1.2 ? 'Tereyağı gibi iniş!' : vs < 2.5 ? 'Güzel iniş.' : 'Sert iniş.';
  if (!flight.crashed) hud.showMessage(info.onRunway ? grade : `${grade} (pist dışı)`, 2200);
});
flight.on('takeoff', () => hud.showMessage('Kalkış!', 1500));
missions.onEvent((e) => {
  hud.showMessage(e.text, e.type === 'complete' ? 4000 : 1600);
  if (e.type === 'ring' || e.type === 'complete') audio.chime(e.type);
});

input.on('camera', () => hud.showMessage(`Kamera: ${cameraRig.next()}`, 1000));
input.on('reset', () => { resetFlight(); hud.showMessage('Yeniden başlatıldı', 1000); });
input.on('pause', () => { if (started) { paused = !paused; hud.setPaused(paused); applyMute(); } });
input.on('hud', () => { hudVisible = !hudVisible; hud.setVisible(hudVisible); });
input.on('mute', () => { userMuted = !userMuted; applyMute(); hud.showMessage(userMuted ? 'Ses kapalı' : 'Ses açık', 900); });
input.on('help', () => { helpVisible = !helpVisible; hud.showHelp(input.bindings, helpVisible); });

overlay.addEventListener('click', () => {
  overlay.classList.add('hidden');
  started = true;
  audio.start();
  hud.showMessage('Gazı aç (Shift), 50 knot civarında burnu kaldır (S)', 4500);
});

// ---- main loop ----
resetFlight();
const timer = new THREE.Timer();
timer.connect(document);
let fpsAcc = 0, fpsFrames = 0;
window.__game = { flight, world, aircraft, camera, cameraRig, missions, input, get state() { return missionState; } };

function frame(timestamp) {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);
  input.update(dt);

  if (started && !paused) {
    if (!flight.crashed) flight.step(dt, input.state, world);
    if (crashTimer > 0 && (crashTimer -= dt) <= 0) resetFlight();
    missionState = missions.update(dt, flight);
  }

  syncAircraft();
  aircraft.update(dt, {
    throttle: flight.throttle,
    aileron: flight.aileron,
    elevator: flight.elevator,
    rudder: flight.rudder,
    flaps: flight.flaps,
    airspeed: flight.airspeed,
  });
  if (airport.userData.update) airport.userData.update(dt);
  cameraRig.update(dt, flight);
  world.update(dt, camera);
  hud.update(flight, missionState);
  audio.update(flight);

  renderer.render(scene, camera);

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 1) { window.__fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
  requestAnimationFrame(frame);
}

loading.remove();
requestAnimationFrame(frame);
