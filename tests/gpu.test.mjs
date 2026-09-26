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

const { classifyDevice, gpuLabel, softwareRenderAdvice, integratedGpuAdvice } = await import('../src/core/gpu-device.js');
const { resolveQuality, lowerQuality, setQualityCap, capQuality, clearQualityCap, QUALITY, detectQuality, qualitySource } = await import('../src/core/quality.js');
const { flightSnapshot, saveSnapshot, readResume, markSnapshotClosed, applyResume, resumeStart } = await import('../src/core/gpu-resume.js');
const { createFixedWingModel } = await import('../src/flight/fixedwing.js');
const { createRoute } = await import('../src/nav/route.js');

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

// ---- device classes -----------------------------------------------------------------------------------------------
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const WIN_FF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
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
  // Windows (live telemetry, 23–26 Sep 2026): software rasterizers, old / entry-level dedicated GPUs, strong iGPUs
  ['Chrome on WARP (no GPU driver)', { ua: WIN, gpu: 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/software'],
  ['Chrome on SwiftShader', { ua: WIN, gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' }, 'desktop/software'],
  ['GT 730', { ua: WIN, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce GT 730 (0x00001287) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/entry'],
  ['Quadro K2200', { ua: WIN, gpu: 'ANGLE (NVIDIA, NVIDIA Quadro K2200 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/entry'],
  ['GTX 480', { ua: WIN, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 480 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/entry'],
  ['RX 550', { ua: WIN, gpu: 'ANGLE (AMD, Radeon RX550/550 Series Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/entry'],
  ['GeForce MX150', { ua: WIN, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce MX150 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/entry'],
  ['GTX 1050 Ti (Firefox name)', { ua: WIN_FF, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0), or similar' }, 'desktop/midrange'],
  ['Radeon R9 200', { ua: WIN, gpu: 'ANGLE (AMD, Radeon R9 200 Series Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/midrange'],
  ['Arc A380', { ua: WIN, gpu: 'ANGLE (Intel, Intel(R) Arc(TM) A380 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/midrange'],
  ['GTX 980 stays high-class', { ua: WIN, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/discrete'],
  ['GTX 1650 stays high-class', { ua: WIN, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/discrete'],
  ['RTX 4060 Laptop', { ua: WIN, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/discrete'],
  ['Arc A770', { ua: WIN, gpu: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/discrete'],
  ['Radeon 780M (fast iGPU)', { ua: WIN, gpu: 'ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/integrated-fast'],
  ['Intel Arc iGPU (Core Ultra)', { ua: WIN, gpu: 'ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/integrated-fast'],
  ['Intel UHD 620', { ua: WIN, gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/integrated'],
  ['Radeon 610M', { ua: WIN, gpu: 'ANGLE (AMD, AMD Radeon 610M (0x000015E7) Direct3D11 vs_5_0 ps_5_0, D3D11)' }, 'desktop/integrated'],
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
// WebKit footprint (render agent, docs/perf/findings-2026-09.md T5): meter budgets for iOS / iPadOS, not for Chromium
const engines = [['iPadOS Safari', ipad, 'webkit'], ['macOS Safari', mac, 'webkit'], ['iPhone', phone, 'webkit'],
  ['Chrome on a Mac', classifyDevice(cases[2][1]), 'blink'], ['Android Chrome', classifyDevice(cases[4][1]), 'blink'],
  ['Firefox', classifyDevice(cases[9][1]), 'gecko'], ['Chrome on iOS', classifyDevice({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) CriOS/140', maxTouchPoints: 5 }), 'webkit']];
check('browser engine: Safari / every iOS browser = webkit, Chrome / Android = blink, Firefox = gecko', engines.every(([, d, e]) => d.engine === e), engines.map(([n, d]) => `${n}: ${d.engine}`).join(', '));
const tabWK = resolveQuality('medium', ipad), tabBlink = resolveQuality('medium', { ...ipad, engine: 'blink' });
check('WebKit tablet: meter budget for a ~3 GB footprint (below the Chromium tablet budget)', tabWK.gpuBudgetMB < tabBlink.gpuBudgetMB && tabWK.gpuBudgetMB > 1000 && tabWK.gpuBudgetMB < 1200, `${tabWK.gpuBudgetMB} vs ${tabBlink.gpuBudgetMB}`);
check('WebKit phone: meter budget for a ~2.1 GB footprint; desktop Safari unchanged', qp.gpuBudgetMB < 800 && qp.gpuBudgetMB > 650 && resolveQuality('high', mac).gpuBudgetMB === QUALITY.high.gpuBudgetMB, `${qp.gpuBudgetMB}`);
// ---- Windows classes → presets (live telemetry: software rasterizers, weak dedicated GPUs) ----------------------------
const dev = (name) => classifyDevice(cases.find((c) => c[0] === name)[1]);
const presets = [['Chrome on WARP (no GPU driver)', 'low'], ['GT 730', 'low'], ['GTX 480', 'low'], ['GTX 1050 Ti (Firefox name)', 'medium'],
  ['Radeon R9 200', 'medium'], ['Radeon 780M (fast iGPU)', 'medium'], ['Intel UHD 620', 'low'], ['GTX 980 stays high-class', 'high'], ['RTX 4060 Laptop', 'high']];
check('default preset per Windows class (software / entry → low, midrange / fast iGPU → medium, discrete → high)', presets.every(([n, q]) => detectQuality(dev(n)) === q),
  presets.map(([n]) => `${n}: ${detectQuality(dev(n))}`).join(', '));
const sw = resolveQuality('high', dev('Chrome on WARP (no GPU driver)'));
check('software renderer: fewer pixels (0.6, floor 0.5), no MSAA / shadows, coarser terrain, even on a chosen "high"',
  sw.pixelRatioMax === 0.6 && sw.pixelRatioMin === 0.5 && sw.antialias === false && sw.shadows === false && sw.terrainError >= 3.5 && sw.clouds === 'low' && sw.water === 'simple' && sw.deviceClass === 'software',
  `pr ${sw.pixelRatioMax}/${sw.pixelRatioMin} aa ${sw.antialias} shadows ${sw.shadows} terrain ${sw.terrainError} budget ${sw.gpuBudgetMB}`);
check('software renderer budget above what "low" uses there (the monitor fired at 805–921 MB with nothing to lower)', resolveQuality('low', dev('Chrome on SwiftShader')).gpuBudgetMB >= 1100);
const entry = resolveQuality('high', dev('GT 730')), fast = resolveQuality('medium', dev('Radeon 780M (fast iGPU)'));
check('entry-level dedicated GPU: integrated-style memory caps on any preset; fast iGPU: integrated caps', entry.gpuBudgetMB <= 1500 && entry.textureMaxSize <= 2048 && entry.pixelRatioMax <= 1 && fast.deviceClass === 'integrated' && fast.gpuBudgetMB <= 1700,
  `entry ${entry.deviceClass} ${entry.gpuBudgetMB} MB · fast ${fast.deviceClass} ${fast.gpuBudgetMB} MB`);
check('discrete Windows GPU keeps the full "high" preset', resolveQuality('high', dev('RTX 4060 Laptop')).gpuBudgetMB === QUALITY.high.gpuBudgetMB && resolveQuality('high', dev('RTX 4060 Laptop')).deviceClass === 'desktop');
check('preset source: auto / user / cap / resume / url', qualitySource({ running: 'low', auto: 'low' }) === 'auto' && qualitySource({ running: 'high', stored: 'high', auto: 'low' }) === 'user'
  && qualitySource({ running: 'medium', stored: 'ultra', auto: 'high', cap: 'medium' }) === 'cap' && qualitySource({ running: 'medium', auto: 'high', cap: 'high' }) === 'resume'
  && qualitySource({ running: 'low', auto: 'high', url: 'low' }) === 'url');
const labels = [
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Intel UHD Graphics 620'],
  ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'AMD Radeon Graphics'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)', 'Apple M4 Max'],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'SwiftShader'],
  ['ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Microsoft Basic Render Driver'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar', 'NVIDIA GeForce GTX 980'],
  ['Apple M1, or similar', 'Apple M1'], ['Adreno (TM) 650', 'Adreno 650'], ['llvmpipe (LLVM 15.0.7, 256 bits)', 'llvmpipe'],
  ['ANGLE (AMD, AMD Radeon RX 580 Series (radeonsi, polaris10, LLVM 15.0.7, DRM 3.49, 6.1.0), OpenGL 4.6)', 'AMD Radeon RX 580 Series'],
  ['ANGLE (Samsung Xclipse 920) on Vulkan 1.1.179', 'Samsung Xclipse 920'], ['Apple GPU', 'Apple GPU'],
];
check('telemetry GPU names keep the model ("Intel UHD Graphics 620", not "Intel")', labels.every(([raw, want]) => gpuLabel(raw) === want), labels.filter(([raw, want]) => gpuLabel(raw) !== want).map(([raw]) => gpuLabel(raw)).join(' | '));
const advWarp = softwareRenderAdvice(dev('Chrome on WARP (no GPU driver)'), WIN), advFf = softwareRenderAdvice(classifyDevice(cases[9][1]), cases[9][1].ua);
check('software notice: driver + Chrome setting on WARP, Firefox setting in Firefox, none for a real GPU',
  advWarp && advWarp.steps.some((t) => /sürücü/.test(t)) && advWarp.steps.some((t) => /Chrome: Ayarlar → Sistem/.test(t)) && advFf && advFf.steps.some((t) => /Firefox/.test(t))
  && softwareRenderAdvice(dev('Intel UHD 620'), WIN) === null && softwareRenderAdvice(classifyDevice(cases[3][1])) === null);
check('hybrid-graphics hint only for Windows integrated GPUs', !!integratedGpuAdvice(dev('Intel UHD 620')) && integratedGpuAdvice(dev('RTX 4060 Laptop')) === null && integratedGpuAdvice(classifyDevice(cases[1][1])) === null);
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
check('restart without pagehide (tab died) resumes as a crash', readResume(new URLSearchParams(''), 'reload') && readResume(new URLSearchParams(''), 'reload').crash === true);
check('a new tab with a copied sessionStorage (navigate, not reload) does not take over the flight', readResume(new URLSearchParams(''), 'navigate') === null);
markSnapshotClosed();
check('no resume after a normal unload (pagehide)', readResume(new URLSearchParams(''), 'reload') === null);
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
