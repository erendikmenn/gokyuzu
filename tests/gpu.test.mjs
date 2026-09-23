// Graphics robustness tests (src/core/gpu-*.js, quality.js): device classes → presets + memory caps, the quality
// ceiling after a failure, and the resume snapshot (a flight saved before a WebGL context loss comes back at the same
// place with gear/flaps, autopilot, route and camera). Run: node tests/gpu.test.mjs
// No framework: prints a PASS/FAIL table, exits 1 on failure. Browser-level checks (forced context loss, reload,
// memory plateau) are measured with Playwright, see the robustness report.
import { readFileSync } from 'node:fs';

// minimal browser globals for the modules (storage, location)
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.localStorage = mem();
globalThis.sessionStorage = mem();
if (typeof globalThis.location === 'undefined') globalThis.location = { search: '', pathname: '/index.html' };

const { classifyDevice } = await import('../src/core/gpu-device.js');
const { resolveQuality, lowerQuality, setQualityCap, capQuality, clearQualityCap, QUALITY } = await import('../src/core/quality.js');
const { flightSnapshot, saveSnapshot, readResume, markSnapshotClosed, applyResume, resumeStart } = await import('../src/core/gpu-resume.js');
const { createFixedWingModel } = await import('../src/flight/fixedwing.js');
const { createRoute } = await import('../src/nav/route.js');

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

// ---- device classes -----------------------------------------------------------------------------------------------
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const cases = [
  ['iPadOS Safari (desktop UA + touch)', { ua: SAFARI_MAC, platform: 'MacIntel', maxTouchPoints: 5, gpu: 'Apple GPU' }, 'tablet'],
  ['macOS Safari', { ua: SAFARI_MAC, platform: 'MacIntel', maxTouchPoints: 0, gpu: 'Apple GPU' }, 'desktop/apple'],
  ['Chrome on M4 Max', { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140', gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)' }, 'desktop/apple-pro'],
  ['iPhone', { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)', maxTouchPoints: 5, gpu: 'Apple GPU' }, 'phone'],
  ['Android phone', { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', maxTouchPoints: 5, gpu: 'Mali-G715' }, 'phone'],
  ['Android tablet', { ua: 'Mozilla/5.0 (Linux; Android 14; SM-X710) Safari', maxTouchPoints: 10, gpu: 'Adreno (TM) 740' }, 'tablet'],
  ['Edge on Intel Iris Xe', { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140', gpu: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/integrated'],
  ['Chrome on AMD APU', { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', gpu: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/integrated'],
  ['Chrome on RTX 3060', { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/discrete'],
  ['Firefox on llvmpipe', { ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko Firefox/130.0', gpu: 'llvmpipe (LLVM 15.0.7, 256 bits)' }, 'desktop/software'],
];
for (const [name, input, want] of cases) {
  const d = classifyDevice(input);
  const got = d.kind === 'desktop' ? `desktop/${d.tier}` : d.kind;
  check(`device class: ${name}`, got === want, got);
}

// ---- presets with device caps -------------------------------------------------------------------------------------
const ipad = classifyDevice(cases[0][1]), mac = classifyDevice(cases[1][1]), phone = classifyDevice(cases[3][1]);
const qi = resolveQuality('high', ipad);
check('tablet caps apply even to a manually chosen "high"', qi.pixelRatioMax <= 1.25 && qi.shadowMapSize <= 2048 && qi.shadowCascades === 1 && qi.maxImageryTiles <= 130 && qi.textureMaxSize <= 2048 && qi.lazyCockpit === true,
  `pr ${qi.pixelRatioMax} shadow ${qi.shadowMapSize}×${qi.shadowCascades} tiles ${qi.maxImageryTiles} tex ${qi.textureMaxSize} budget ${qi.gpuBudgetMB}`);
const qm = resolveQuality('high', mac);
check('desktop Mac keeps the full "high" preset', qm.shadowMapSize === 4096 && qm.maxImageryTiles === QUALITY.high.maxImageryTiles && qm.pixelRatioMax === 1.5 && !qm.lazyCockpit);
const qp = resolveQuality('low', phone);
check('phone budget below tablet budget below desktop "low"', qp.gpuBudgetMB < resolveQuality('low', ipad).gpuBudgetMB && resolveQuality('low', ipad).gpuBudgetMB <= QUALITY.low.gpuBudgetMB, `${qp.gpuBudgetMB} / ${resolveQuality('low', ipad).gpuBudgetMB} / ${QUALITY.low.gpuBudgetMB}`);
check('resolveQuality is memoized (identity stable for main.js)', resolveQuality('medium', ipad) === resolveQuality('medium', ipad));
check('every preset has a budget and release policy', Object.values(QUALITY).every((q) => q.gpuBudgetMB > 0 && q.maxImageryTiles > 0 && q.releaseImages === true));
check('quality steps: ultra → high → medium → low → none', lowerQuality('ultra') === 'high' && lowerQuality('medium') === 'low' && lowerQuality('low') === null);

// ---- quality ceiling after a failure ----------------------------------------------------------------------------
clearQualityCap();
setQualityCap('medium');
check('ceiling after a context loss caps later sessions', capQuality('ultra') === 'medium' && capQuality('low') === 'low');
clearQualityCap();
check('ceiling cleared', capQuality('ultra') === 'ultra');

// ---- resume snapshot round trip ---------------------------------------------------------------------------------
const RUNWAYS = JSON.parse(readFileSync(new URL('../data/sf/runways.json', import.meta.url), 'utf8'));
const world = { runways: RUNWAYS, getGroundHeight: () => 4, isWater: () => false, isOnRunway: () => false, getObstacleHeight: () => -Infinity, hitTest: () => null, time: 18.25, weather: { preset: 'açık' } };
const spec = (await import('../src/aircraft/b737/spec.js')).default;
function makeState() {
  const flight = createFixedWingModel(spec, {});
  const navRoute = createRoute();
  flight.setRoute(navRoute);
  let mode = 'chase';
  const cameraRig = { get mode() { return mode; }, select(m) { mode = m; return m; } };
  return { flight, navRoute, cameraRig, world, choice: { aircraftId: 'b737', spawnId: 'AIR-CITY' }, readyAt: 1 };
}
const A = makeState();
A.flight.reset({ x: -3000, z: -9000, heading: 200 / 180 * Math.PI, altitude: 677, speed: 105 }, world);
A.navRoute.setDefaultAlt(677);
for (const [x, z] of [[-4000, -12000], [-5000, -4500], [-800, 300]]) A.navRoute.add(x, z);
A.flight.engageNav();
for (let i = 0; i < 600; i++) A.flight.step(1 / 60, { pitch: 0, roll: 0, yaw: 0, throttle: A.flight.throttle, brake: 0 }, world);
A.cameraRig.select('cockpit');
const snap = saveSnapshot(A);
check('snapshot taken in flight (remaining route legs only)', snap && snap.aircraft === 'b737' && snap.ap && snap.ap.lnav && snap.route && snap.route.user.length === A.navRoute.user.length - A.navRoute.active && snap.route.user.length > 0,
  snap ? `ap ${JSON.stringify(snap.ap)} route ${snap.route && snap.route.user.length}/${A.navRoute.user.length} (active ${A.navRoute.active})` : 'null');
check('resume after our reload (?resume=1)', !!readResume(new URLSearchParams('resume=1')));
check('restart without pagehide (tab died) resumes as a crash', readResume(new URLSearchParams('')) && readResume(new URLSearchParams('')).crash === true);
markSnapshotClosed();
check('no resume after a normal unload (pagehide)', readResume(new URLSearchParams('')) === null);
const B = makeState();
B.flight.reset({ x: 0, z: 0, heading: 0 }, world);
applyResume(B, readResume(new URLSearchParams('resume=1')), {});
const fb = B.flight;
const dPos = Math.hypot(fb.position.x - snap.x, fb.position.z - snap.z), dAlt = Math.abs(fb.position.y - snap.y);
const dHdg = Math.abs(((fb.heading - snap.heading + 540) % 360) - 180);
check('resumed at the same position / altitude / heading / speed', dPos < 1 && dAlt < 1 && dHdg < 1 && Math.abs(fb.airspeed - snap.speed) < 1.5,
  `Δpos ${dPos.toFixed(2)} m Δalt ${dAlt.toFixed(2)} m Δhdg ${dHdg.toFixed(2)}° V ${fb.airspeed.toFixed(1)} vs ${snap.speed}`);
check('resumed with autopilot in NAV, route and camera', fb.autopilot.on && fb.autopilot.lnav && B.navRoute.waypoints.length === snap.route.user.length && B.cameraRig.mode === 'cockpit',
  `ap ${fb.autopilot.on}/${fb.autopilot.lnav} wpts ${B.navRoute.waypoints.length} cam ${B.cameraRig.mode}`);
check('resumed gear / flaps as saved', fb.gearHandleDown === snap.gear && fb.flapsIndex === snap.flaps, `gear ${fb.gearHandleDown} flaps ${fb.flapsIndex}`);
for (let i = 0; i < 300; i++) fb.step(1 / 60, { pitch: 0, roll: 0, yaw: 0, throttle: fb.throttle, brake: 0 }, world);
check('resumed flight keeps flying (no crash, altitude held)', !fb.crashed && Math.abs(fb.position.y - snap.y) < 30, `alt ${fb.position.y.toFixed(0)} m after 5 s`);
check('ground start resumes on the ground', resumeStart({ ...snap, onGround: true }).altitude === undefined);
check('crashed flight is not snapshotted', (() => { const C = makeState(); C.flight.crashed = true; return flightSnapshot(C) === null; })());

// ======================================================================================================================
let failed = 0;
console.log('\n=== graphics robustness (device classes, memory caps, resume) ' + '='.repeat(40));
for (const r of rows) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(80)} ${r.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
