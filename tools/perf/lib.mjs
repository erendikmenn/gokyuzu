// Shared helpers of the performance tools (tools/perf/*.mjs): browser launch on the real GPU, the in-page probe
// (tools/perf/probe.js), game start, fixed camera poses (the same poses feed the screenshot quality harness), streaming
// settle detection and result files.
//
// Environment: PERF_BASE (default http://localhost:5195/ = a clean worktree served by tools/serve.mjs; the shared dev
// server is http://localhost:5173/), PERF_OUT (results; default <tmpdir>/gokyuzu-perf).
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), 'gokyuzu-perf');
fs.mkdirSync(OUT, { recursive: true });
export const BASE = process.env.PERF_BASE || 'http://localhost:5195/';
const PROBE = fs.readFileSync(path.join(HERE, 'probe.js'), 'utf8');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
export const flag = (name) => process.argv.includes(name);
export function save(name, obj) { const p = path.join(OUT, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1)); return p; }

/** Chromium flags: ANGLE on Metal (the real Apple GPU), GPU blocklist off, precise heap numbers. */
export const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'];
/** Extra flags to lift the 60 Hz cap (throughput / headroom measurements). */
export const UNCAPPED_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

/**
 * Launch a browser + page with the probe installed.
 * opts: engine 'chromium'|'webkit', width, height, dpr, gl 'off'|'light'|'mem', clock 'real'|'virtual', uncapped,
 *       cpuThrottle (CDP Emulation.setCPUThrottlingRate), network { latency, down, up } (CDP, kbit/s), cache false →
 *       cache disabled, settings (localStorage gokyuzu.settings merge), extraArgs, heap (per-frame heap deltas → allocation rate / GC drops),
 *       audit (probe.js DOM-mutation / 2D-canvas / Web Audio counters), hasTouch / isMobile / userAgent (device profiles).
 */
export async function launch(opts = {}) {
  const { engine = 'chromium', width = 1920, height = 1080, dpr = 1, gl = 'light', clock = 'real', uncapped = false } = opts;
  const browser = engine === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ args: [...GPU_ARGS, ...(uncapped ? UNCAPPED_ARGS : []), ...(opts.extraArgs || [])] });
  // touch devices (tools/perf/matrix.mjs tablet / phone profiles): hasTouch → (pointer: coarse), maxTouchPoints > 0
  const ctxOpts = { viewport: { width, height }, deviceScaleFactor: dpr, ignoreHTTPSErrors: true };
  if (opts.hasTouch) ctxOpts.hasTouch = true;
  if (opts.isMobile && engine === 'chromium') ctxOpts.isMobile = true;
  if (opts.userAgent) ctxOpts.userAgent = opts.userAgent;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  const log = { errors: [], warnings: [], console: [], ready: null, http: [] };
  page.on('console', (m) => {
    const t = m.text();
    if (/GL Driver Message|GPU stall/.test(t)) return;
    if (m.type() === 'error') log.errors.push(t); else if (m.type() === 'warning') log.warnings.push(t);
    const r = /\[app\] ready in ([\d.]+) s/.exec(t);
    if (r) log.ready = Number(r[1]);
    if (log.console.length < 400) log.console.push(`[${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => log.errors.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) log.http.push(`${r.status()} ${r.url()}`); });
  const settings = { tutorial: false, ...(opts.settings || {}) };
  await page.addInitScript(({ cfg, settings, probe }) => {
    window.__PERF_CFG = cfg;
    try {
      const k = 'gokyuzu.settings';
      const cur = JSON.parse(localStorage.getItem(k) || '{}');
      localStorage.setItem(k, JSON.stringify({ ...cur, ...settings }));
    } catch { /* ignore */ }
    // eslint-disable-next-line no-eval
    (0, eval)(probe);
  }, { cfg: { gl, clock, heap: !!opts.heap, audit: !!opts.audit }, settings, probe: PROBE });
  let cdp = null;
  if (engine === 'chromium') {
    cdp = await context.newCDPSession(page);
    if (opts.cpuThrottle && opts.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpuThrottle });
    if (opts.network || opts.cache === false) {
      await cdp.send('Network.enable');
      if (opts.cache === false) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (opts.network) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: opts.network.latency, downloadThroughput: opts.network.down * 1000 / 8, uploadThroughput: (opts.network.up || opts.network.down) * 1000 / 8 });
    }
  }
  return { browser, context, page, cdp, log };
}

/** Network profiles (kbit/s, ms): the task's 4G, Chrome DevTools' Fast/Slow 3G. */
export const NETWORKS = {
  none: null,
  '4g': { latency: 60, down: 9000, up: 3000 },
  fast3g: { latency: 150, down: 1600, up: 750 },   // DevTools "Fast 3G" (1.6 Mbit/s / 562.5 ms incl. overhead)
  slow3g: { latency: 400, down: 400, up: 400 },    // DevTools "Slow 3G" (400 kbit/s / 2 s incl. overhead)
};

/** Start the game straight into a flight (menu skipped) and wait until it is playable. Returns seconds. */
export async function openGame(page, { aircraft = 'f16', spawn = 'KSFO-28R', quality = 'high', pr = 1, extra = '', base = BASE, pageName = 'index.html', timeout = 180000 } = {}) {
  const t0 = Date.now();
  const q = new URLSearchParams({ aircraft, spawn });
  if (quality && quality !== 'auto') q.set('quality', quality);   // 'auto' = the game's own default for this device (class)
  if (pr) q.set('pr', String(pr));
  await page.goto(`${base}${pageName}?${q}${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.flight && window.__game.world && window.__game.rig && window.__game.readyAt, null, { timeout, polling: 100 });
  return (Date.now() - t0) / 1000;
}

/** Attach the per-frame probes (CPU breakdown + GPU timer queries). */
export async function attach(page, opts = {}) { return page.evaluate((o) => window.__perf.attach(o), opts); }

/**
 * Fixed camera poses. `ac` places and freezes the aircraft (flight paused, the world keeps updating/streaming);
 * `cam` is a camera-rig mode, or `free` = { pos, look, fov } for a camera independent of the aircraft.
 * Heading in degrees. The same poses are used by capture.mjs for the quality (SSIM) harness.
 */
export const POSES = {
  'sfo-ground':   { ac: { spawn: 'KSFO-28R' }, cam: 'chase', label: 'SFO 28R on the ground, chase view' },
  'downtown-300': { ac: { x: -1800, z: -16500, alt: 300, hdg: 345 }, cam: 'chase', label: 'Downtown SF at 300 m, chase view' },
  'golden-gate':  { ac: { x: -12800, z: -23100, alt: 260, hdg: 95 }, cam: 'chase', label: 'Golden Gate from the west at 260 m' },
  'bay-3000':     { ac: { x: 3000, z: -10000, alt: 3000, hdg: 330 }, cam: 'chase', label: 'Bay cruise at 3000 m toward SF' },
  'cockpit':      { ac: { spawn: 'KSFO-28R' }, cam: 'cockpit', label: 'Cockpit view at SFO 28R' },
  'birdseye':     { ac: { x: -1500, z: -14500, alt: 600, hdg: 340 }, cam: 'birdseye', label: "Bird's-eye over the city" },
  // free cameras for the screenshot harness (independent of the aircraft model)
  'free-downtown': { ac: { x: 5000, z: 5000, alt: 2000, hdg: 0 }, free: { pos: [-900, 420, -15600], look: [-2500, 120, -19500], fov: 60 }, label: 'Free camera: downtown skyline' },
  'free-ggb':      { ac: { x: 5000, z: 5000, alt: 2000, hdg: 0 }, free: { pos: [-11600, 180, -23600], look: [-9250, 120, -22240], fov: 55 }, label: 'Free camera: Golden Gate Bridge' },
  'free-sfo':      { ac: { x: 5000, z: 5000, alt: 2000, hdg: 0 }, free: { pos: [1800, 90, 1500], look: [300, 5, -400], fov: 60 }, label: 'Free camera: SFO terminals' },
  // close-up of the aircraft skin (texture resolution / compression checks): camera 3/4 front-left at ~2.2 x length
  'aircraft-close': { ac: { spawn: 'KSFO-28R' }, free: { rel: [-0.9, 0.35, -1.6], fov: 40 }, label: 'Aircraft close-up (skin textures)' },
  // San Francisco poses of the device matrix (tools/perf/matrix.mjs; alt = m MSL unless agl)
  'ggb-low':      { ac: { x: -12600, z: -23000, alt: 120, hdg: 100 }, cam: 'chase', label: 'Golden Gate low (120 m, under the tower tops) from the west' },
  'bay-3000ft':   { ac: { x: 3000, z: -10000, alt: 914, hdg: 330 }, cam: 'chase', label: 'Bay cruise at 3000 ft toward SF' },
  // İstanbul (?map=ist; spawn poses need the page opened at LTFM-35L). Local frame of data/ist/region.json (origin Galata Kulesi)
  'ist-peninsula':   { map: 'ist', ac: { x: 700, z: 4000, alt: 300, hdg: 345 }, cam: 'chase', label: 'Historic peninsula (Sultanahmet, Ayasofya, Topkapı) at 300 m from the Marmara' },
  'ist-levent':      { map: 'ist', ac: { x: 2000, z: -3900, alt: 400, hdg: 24 }, cam: 'chase', label: 'Toward the Levent skyline at 400 m' },
  'ist-bogaz':       { map: 'ist', ac: { x: 4690, z: -2090, alt: 38, hdg: 50.5 }, cam: 'chase', label: 'Boğaz at 38 m, 400 m before passing under 15 Temmuz Şehitler Köprüsü' },
  'ist-ltfm-ground': { map: 'ist', ac: { spawn: 'LTFM-35L' }, cam: 'chase', label: 'LTFM 35L on the ground, chase view' },
  'ist-bagcilar':    { map: 'ist', ac: { x: -13300, z: -1911, alt: 150, agl: true, hdg: 90 }, cam: 'chase', label: 'Bağcılar at 150 m AGL (dense residential city + trees), heading east' },
  'ist-cockpit':     { map: 'ist', ac: { spawn: 'LTFM-35L' }, cam: 'cockpit', label: 'Cockpit view at LTFM 35L' },
  // İstanbul free cameras for the quality gate (aircraft parked out of view)
  'ist-free-15temmuz':   { map: 'ist', ac: { x: 5000, z: 5000, alt: 2000, hdg: 0 }, free: { pos: [4380, 95, -1880], look: [4999, 80, -2344], fov: 60 }, label: 'Free camera: 15 Temmuz Şehitler Köprüsü from the Boğaz' },
  'ist-free-sultanahmet': { map: 'ist', ac: { x: 5000, z: 5000, alt: 2000, hdg: 0 }, free: { pos: [720, 160, 2850], look: [400, 35, 2050], fov: 50 }, label: 'Free camera: Sultanahmet and Ayasofya from the Marmara' },
  'ist-free-ltfm':       { map: 'ist', ac: { x: 5000, z: 5000, alt: 2000, hdg: 0 }, free: { pos: [-21000, 170, -24600], look: [-19901, 105, -25905], fov: 55 }, label: 'Free camera: LTFM terminal and runways' },
};
/** Map of a pose ('sf' unless the pose says otherwise). */
export const poseMap = (name) => (POSES[name] && POSES[name].map) || 'sf';

/** Put the aircraft and camera into a pose (flight paused). */
export async function setPose(page, poseName) {
  const p = POSES[poseName];
  if (!p) throw new Error(`unknown pose ${poseName}`);
  await page.evaluate((p) => {
    const g = window.__game;
    const rad = (d) => d * Math.PI / 180;
    let start;
    if (p.ac.spawn) {
      const s = g.spawn && g.spawn.id === p.ac.spawn ? g.spawn : null;
      start = s ? { x: s.x, z: s.z, heading: s.heading, altitude: s.altitude, speed: s.altitude ? g.def.spec.spawnSpeed : undefined } : null;
      if (!start) throw new Error('spawn pose needs the page opened at that spawn');
    } else {
      let alt = p.ac.alt;
      if (p.ac.agl && g.world && g.world.getGroundHeight) alt += Math.max(0, g.world.getGroundHeight(p.ac.x, p.ac.z) || 0);   // (coarse until the heights stream in: ±10 m)
      start = { x: p.ac.x, z: p.ac.z, heading: rad(p.ac.hdg), altitude: alt, speed: g.def.spec.spawnSpeed };
    }
    g.flight.reset(start, g.world);
    g.paused = true;
    const cr = g.cameraRig;
    if (p.free) {
      if (!cr.__origUpdate) cr.__origUpdate = cr.update;
      cr.update = () => {};
      const c = g.camera;
      c.up.set(0, 1, 0);
      if (p.free.rel) {   // relative to the aircraft: offsets in aircraft lengths along its right / up / forward(-Z) axes
        const o = g.rig.object;
        o.position.copy(g.flight.position); o.quaternion.copy(g.flight.quaternion);   // what syncRig does next frame
        o.updateMatrixWorld(true);
        const L = (g.rig.bounds && g.rig.bounds.length) || 15;
        const e = o.matrixWorld.elements;
        const [rx, ry, rz] = p.free.rel;
        c.position.set(o.position.x + (e[0] * rx + e[4] * ry + e[8] * rz) * L, o.position.y + (e[1] * rx + e[5] * ry + e[9] * rz) * L, o.position.z + (e[2] * rx + e[6] * ry + e[10] * rz) * L);
        c.lookAt(o.position.x, o.position.y, o.position.z);
      } else {
        c.position.set(...p.free.pos);
        c.lookAt(...p.free.look);
      }
      c.fov = p.free.fov || 60;
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
    } else {
      if (cr.__origUpdate) { cr.update = cr.__origUpdate; delete cr.__origUpdate; }
      cr.setMode(p.cam);
      if (cr.reset) cr.reset();
    }
    // memory-limited device classes stream the detailed cockpit only when the cockpit view is entered (main.js input path)
    if (p.cam === 'cockpit' && g.loadCockpit) { const l = g.loadCockpit; g.loadCockpit = null; l(); }
    // the detailed cockpit (and its displays) streams in after the start: wrap the new display objects too
    if (window.__perf && window.__perf.wrapPerAircraft) window.__perf.wrapPerAircraft();
  }, p);
}

/**
 * Wait until streaming is idle around the current camera (terrain nothing in flight / pending, city queue empty, no
 * new textures or geometries for a while) or maxMs. Returns { ms, idle, stats }.
 */
export async function settle(page, { minMs = 3000, maxMs = 30000, quietMs = 1500 } = {}) {
  const t0 = Date.now();
  let lastSig = '', quietSince = Date.now(), st = null;
  while (Date.now() - t0 < maxMs) {
    st = await page.evaluate(() => {
      const g = window.__game, w = g.world, ts = w.terrain.stats || {};
      const city = (w.layers || []).find((l) => l.object && l.object.name === 'city');
      const cs = city && city.stats ? city.stats : {};
      const i = g.renderer.info.memory;
      return { tIn: ts.inflight || 0, tPend: ts.pending || 0, tLoaded: ts.loaded, tTex: ts.textures, cQ: cs.queued || 0, cA: cs.active || 0, cLoaded: cs.loaded, trees: JSON.stringify(cs.trees || null), tex: i.textures, geo: i.geometries };
    });
    const sig = `${st.tLoaded}|${st.tTex}|${st.cLoaded}|${st.trees}|${st.tex}|${st.geo}`;   // trees: instance counts per species/tile
    const busy = st.tIn + st.tPend + st.cQ + st.cA > 0;
    if (sig !== lastSig || busy) { lastSig = sig; quietSince = Date.now(); }
    if (Date.now() - t0 >= minMs && Date.now() - quietSince >= quietMs) return { ms: Date.now() - t0, idle: true, stats: st };
    await sleep(250);
  }
  return { ms: Date.now() - t0, idle: false, stats: st };
}

/** Measure for `ms`: frame/CPU/GPU statistics from the probe. */
export async function measure(page, ms = 8000) {
  await page.evaluate(() => { const P = window.__perf; if (P.wrapPerAircraft) P.wrapPerAircraft(); P.mark(); });
  await sleep(ms);
  return page.evaluate(() => ({ ...window.__perf.summary(), worst: window.__perf.worst(5) }));
}

/** World streaming state (terrain/city/trees counters) for reports. */
export async function worldStats(page) {
  return page.evaluate(() => {
    const w = window.__game.world;
    const city = (w.layers || []).find((l) => l.object && l.object.name === 'city');
    return { terrain: { ...(w.terrain.stats || {}) }, city: city && city.stats ? JSON.parse(JSON.stringify(city.stats)) : null };
  });
}

/**
 * Per-layer draw calls / triangles / GPU memory estimate by scene traversal. Textures use the probe's exact GL-level
 * byte counts when available (gl: 'mem'), otherwise width × height × 4 × 4/3. Geometry: attribute arrays (freed
 * arrays estimated as count × itemSize × 4).
 */
export async function layerReport(page) {
  return page.evaluate(() => {
    const g = window.__game, r = g.renderer, P = window.__perf;
    const texBytes = (t) => {
      const p = r.properties.get(t);
      const e = p && p.__webglTexture && P.live && P.live.tex.get(p.__webglTexture);
      if (e) return e.bytes;
      const img = t.image || (t.source && t.source.data);
      if (!img) return 0;
      const w = img.width || 0, h = img.height || 0;
      return t.isCompressedTexture ? (t.mipmaps || []).reduce((a, m) => a + (m.data ? m.data.byteLength : 0), 0) : w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1);
    };
    const attrBytes = (a) => { if (!a) return 0; const arr = a.isInterleavedBufferAttribute ? a.data.array : a.array; return arr ? arr.byteLength : a.count * a.itemSize * 4; };
    const layers = [];
    const groups = [];
    for (const c of g.scene.children) {
      if (c.name === 'sf-terrain' || c.name === 'city' || c.name === 'airports' || c.name === 'landmarks') {
        if (c.name === 'city') { for (const k of c.children) groups.push([`city/${k.name}`, k]); } else groups.push([c.name, c]);
      } else groups.push([c.name || c.type, c]);
    }
    for (const [name, root] of groups) {
      const geos = new Set(), texs = new Set(), mats = new Set();
      let meshes = 0, visible = 0, instances = 0;
      root.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine)) return;
        meshes++;
        let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
        if (vis) visible++;
        if (o.isInstancedMesh) instances += o.count;
        geos.add(o.geometry);
        for (const m of [].concat(o.material)) {
          if (!m) continue; mats.add(m);
          for (const v of Object.values(m)) if (v && v.isTexture) texs.add(v);
          if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) texs.add(u.value);
        }
      });
      let gb = 0; for (const geo of geos) { for (const a of Object.values(geo.attributes)) gb += attrBytes(a); gb += attrBytes(geo.index); }
      let im = 0; root.traverse((o) => { if (o.isInstancedMesh) { im += attrBytes(o.instanceMatrix) + attrBytes(o.instanceColor); } });
      let tb = 0; for (const t of texs) tb += texBytes(t);
      layers.push({ layer: name, meshes, visible, instances, geometries: geos.size, materials: mats.size, textures: texs.size, geoMB: +(gb / 1048576).toFixed(1), instMB: +(im / 1048576).toFixed(1), texMB: +(tb / 1048576).toFixed(1) });
    }
    const total = P.gpuBytes ? P.gpuBytes() : null;
    return { layers, glTotalMB: total && { tex: +(total.tex / 1048576).toFixed(1), buf: +(total.buf / 1048576).toFixed(1), rb: +(total.rb / 1048576).toFixed(1), texCount: total.texCount, bufCount: total.bufCount } };
  });
}

/** Per-layer draw calls + triangles: render once per layer with the others hidden (CPU-side counts from renderer.info). */
export async function layerCalls(page) {
  return page.evaluate(() => {
    const g = window.__game, r = g.renderer;
    const tops = g.scene.children.filter((c) => c.visible && !c.isCamera && !c.isLight);
    const out = [];
    const saved = tops.map((c) => c.visible);
    const run = () => { r.render(g.scene, g.camera); return { calls: r.info.render.calls, tris: r.info.render.triangles }; };
    const all = run();
    const cityRoot = tops.find((c) => c.name === 'city');
    const parts = [];
    for (const c of tops) {
      if (c === cityRoot) for (const k of c.children) parts.push([`city/${k.name}`, c, k]); else parts.push([c.name || c.type, c, null]);
    }
    for (const [name, top, sub] of parts) {
      tops.forEach((c) => { c.visible = c === top; });
      let savedSub = null;
      if (sub) { savedSub = top.children.map((k) => k.visible); top.children.forEach((k) => { k.visible = k === sub; }); }
      out.push({ layer: name, ...run() });
      if (sub) top.children.forEach((k, i) => { k.visible = savedSub[i]; });
    }
    tops.forEach((c, i) => { c.visible = saved[i]; });
    return { all, layers: out };
  });
}

/**
 * GPU time per layer by ablation (needs attach({gpu:true})): each top-level layer (and city buildings / trees) is hidden
 * in short windows paired with an adjacent "everything visible" window, in random order over `rounds`, so GPU
 * contention from other processes hits both halves of a pair alike. Reports per layer the median over rounds of the
 * paired difference of the mean and of the p10 GPU frame time (p10 = least disturbed frames), plus CPU saved.
 * '-shadowPass' keeps the last shadow maps but skips the caster pass.
 */
export async function layerGpuAblation(page, ms = 1200, rounds = 3) {
  const names = await page.evaluate(() => {
    const g = window.__game;
    const list = g.scene.children.filter((c) => c.visible && !c.isCamera && !c.isLight).map((c) => c.name || c.type);
    const city = g.scene.children.find((c) => c.name === 'city');
    if (city) for (const k of city.children) list.push(`city/${k.name}`);
    return list.concat(['shadowPass']);
  });
  const setHidden = (name, hidden) => page.evaluate(({ name, hidden }) => {
    const g = window.__game;
    if (name === 'shadowPass') { const r = g.renderer; if (hidden) { r.__perfSM = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false; } else if (r.__perfSM !== undefined) { r.shadowMap.autoUpdate = r.__perfSM; delete r.__perfSM; } return; }
    let o;
    if (name.startsWith('city/')) o = g.scene.getObjectByName('city').children.find((k) => k.name === name.slice(5));
    else o = g.scene.children.find((c) => (c.name || c.type) === name);
    if (o) { if (hidden) { o.__perfVis = o.visible; o.visible = false; } else if (o.__perfVis !== undefined) { o.visible = o.__perfVis; delete o.__perfVis; } }
  }, { name, hidden });
  const win = async () => { await sleep(150); const s = await measure(page, ms); return { gpu: s.gpuMs && s.gpuMs.mean, p10: s.gpuMs && s.gpuMs.p10, cpu: s.cpuMs.mean, calls: s.info.calls }; };
  const acc = Object.fromEntries(names.map((n) => [n, []]));
  const allWins = [];
  for (let r = 0; r < rounds; r++) {
    for (const n of names.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1])) {
      const a = await win();
      await setHidden(n, true);
      const b = await win();
      await setHidden(n, false);
      allWins.push(a);
      acc[n].push({ dMean: a.gpu != null && b.gpu != null ? a.gpu - b.gpu : null, dP10: a.p10 != null && b.p10 != null ? a.p10 - b.p10 : null, dCpu: a.cpu - b.cpu, calls: a.calls - b.calls });
    }
  }
  const med = (arr) => { const s = arr.filter((x) => x != null).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null; };
  const res = { all: { gpu: med(allWins.map((w) => w.gpu)), p10: med(allWins.map((w) => w.p10)), cpu: med(allWins.map((w) => w.cpu)), calls: allWins[0] && allWins[0].calls } };
  for (const n of names) res[`-${n}`] = { gpuSaved: med(acc[n].map((x) => x.dMean)), gpuSavedP10: med(acc[n].map((x) => x.dP10)), cpuSaved: med(acc[n].map((x) => x.dCpu)), callsSaved: med(acc[n].map((x) => x.calls)) };
  return res;
}

/**
 * Fragment (overdraw) analysis, independent of GPU timing and contention. With the logarithmic depth buffer every
 * material writes gl_FragDepth, which disables early-Z / hidden-surface removal: every rasterized fragment runs its full
 * fragment shader, even when it later fails the depth test. So per layer:
 *   shaded  = fragments rasterized (count pass: additive 1.0 per fragment into a float target, no depth test, the
 *             material's face culling kept)
 *   visible = fragments that pass the final depth test (after a depth pre-pass of the opaque scene)
 * Reported in megapixels and as a share of the screen; the sum of `shaded` over layers / screen = overdraw factor.
 */
export async function fragmentReport(page) {
  return page.evaluate(async () => {
    const THREE = await import('three');
    const g = window.__game, r = g.renderer, scene = g.scene, cam = g.camera;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = size.x, h = size.y;
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, depthBuffer: true, samples: 0 });
    const mk = (side, depthTest) => new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest, depthWrite: false, side, toneMapped: false, fog: false });
    const countMats = { false: [mk(THREE.FrontSide, false), mk(THREE.BackSide, false), mk(THREE.DoubleSide, false)], true: [mk(THREE.FrontSide, true), mk(THREE.BackSide, true), mk(THREE.DoubleSide, true)] };
    const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.FrontSide });
    // custom ShaderMaterials (sky dome, fog bank, clouds…) place their vertices in their own vertex shader: keep it,
    // replace only the fragment stage by a constant (log depth kept so the depth test matches the scene)
    const FRAG_ONE = '#include <common>\n#include <logdepthbuf_pars_fragment>\nvoid main() {\n#include <logdepthbuf_fragment>\ngl_FragColor = vec4(1.0);\n}';
    const shaderCount = new Map();
    const countFor = (o, depthTest) => {
      if (!o.isShaderMaterial) return countMats[depthTest][sideIdx(o)];
      const k = `${o.uuid}|${depthTest}`;
      if (!shaderCount.has(k)) {
        const c = o.clone();
        c.fragmentShader = FRAG_ONE; c.transparent = true; c.blending = THREE.CustomBlending; c.blendEquation = THREE.AddEquation; c.blendSrc = THREE.OneFactor; c.blendDst = THREE.OneFactor;
        c.depthTest = depthTest; c.depthFunc = THREE.LessEqualDepth; c.depthWrite = false; c.colorWrite = true;
        shaderCount.set(k, c);
      }
      return shaderCount.get(k);
    };
    const depthFor = (o) => {
      if (!o.isShaderMaterial) { const d = depthMat.clone(); d.side = o.side; return d; }
      const c = o.clone(); c.fragmentShader = FRAG_ONE; c.colorWrite = false; c.depthWrite = true; c.depthTest = true; c.transparent = false; c.blending = THREE.NoBlending; return c;
    };
    const layers = [];
    const cityRoot = scene.children.find((c) => c.name === 'city');
    for (const c of scene.children) {
      if (!c.visible || c.isCamera || c.isLight) continue;
      if (c === cityRoot) for (const k of c.children) layers.push([`city/${k.name}`, k]); else layers.push([c.name || c.type, c]);
    }
    const visibleMeshes = (root) => { const out = []; root.traverse((o) => { if ((o.isMesh) && o.visible) { let v = true; for (let p = o.parent; p; p = p.parent) if (!p.visible) { v = false; break; } if (v) out.push(o); } }); return out; };
    const saved = new Map();
    const all = layers.flatMap(([, root]) => visibleMeshes(root));
    const hideAll = () => { for (const m of all) m.visible = false; };
    const restore = () => { for (const m of all) m.visible = true; for (const [m, mat] of saved) m.material = mat; saved.clear(); };
    const setMat = (meshes, pick) => { for (const m of meshes) { if (!saved.has(m)) saved.set(m, m.material); const orig = [].concat(saved.get(m))[0] || {}; m.material = pick(orig); } };
    const prevTarget = r.getRenderTarget(), prevAuto = r.autoClear, prevSM = r.shadowMap.autoUpdate, prevBg = scene.background, prevFog = scene.fog;
    r.shadowMap.autoUpdate = false; scene.background = null;
    const buf = new Float32Array(w * h * 4);
    const sumRT = () => { r.readRenderTargetPixels(rt, 0, 0, w, h, buf); let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i]; return s; };
    const sideIdx = (m) => (m.side === THREE.BackSide ? 1 : m.side === THREE.DoubleSide ? 2 : 0);
    const out = [];
    try {
      r.setRenderTarget(rt);
      for (const [name, root] of layers) {
        const meshes = visibleMeshes(root);
        if (!meshes.length) continue;
        // shaded: this layer alone, no depth test
        hideAll(); for (const m of meshes) m.visible = true;
        setMat(meshes, (o) => countFor(o, false));
        r.setClearColor(0x000000, 0); r.clear(true, true, true);
        r.render(scene, cam);
        const shaded = sumRT();
        // visible: depth pre-pass of all opaque meshes, then this layer depth-tested (LEQUAL)
        for (const m of meshes) m.material = saved.get(m);
        restore(); hideAll();
        const opaque = all.filter((m) => { const mat = [].concat(m.material)[0]; return mat && !mat.transparent && mat.depthWrite !== false && mat.colorWrite !== false; });
        for (const m of opaque) m.visible = true;
        setMat(opaque, depthFor);
        r.setClearColor(0x000000, 0); r.clear(true, true, true);
        r.render(scene, cam);
        for (const m of opaque) { m.material.dispose(); m.material = saved.get(m); m.visible = false; }
        saved.clear();
        for (const m of meshes) m.visible = true;
        setMat(meshes, (o) => countFor(o, true));
        r.autoClear = false; r.clearColor();
        r.render(scene, cam);
        r.autoClear = prevAuto;
        const visible = sumRT();
        restore();
        out.push({ layer: name, meshes: meshes.length, shadedMpx: +(shaded / 1e6).toFixed(2), visibleMpx: +(visible / 1e6).toFixed(2), shadedScreens: +(shaded / (w * h)).toFixed(2), wastedPct: shaded ? Math.round(100 * (1 - visible / shaded)) : 0 });
      }
    } finally {
      restore();
      r.autoClear = prevAuto; r.setRenderTarget(prevTarget); r.shadowMap.autoUpdate = prevSM; scene.background = prevBg; scene.fog = prevFog;
      rt.dispose(); for (const k of [true, false]) for (const m of countMats[k]) m.dispose(); depthMat.dispose(); for (const m of shaderCount.values()) m.dispose();
    }
    const tot = out.reduce((a, l) => a + l.shadedMpx, 0);
    return { width: w, height: h, screenMpx: +(w * h / 1e6).toFixed(2), totalShadedMpx: +tot.toFixed(2), overdraw: +(tot / (w * h / 1e6)).toFixed(2), layers: out.sort((a, b) => b.shadedMpx - a.shadedMpx) };
  });
}

/** GPU busy % of the whole machine (ioreg IOAccelerator "Device Utilization %"), null if unavailable. */
export function gpuBusy() {
  try { const m = /"Device Utilization %"=(\d+)/.exec(execSync('ioreg -r -d 1 -w 0 -c IOAccelerator', { encoding: 'utf8' })); return m ? Number(m[1]) : null; } catch { return null; }
}
/**
 * Wait until other processes leave the GPU mostly idle (busy < threshold for 3 samples in a row; call it while the
 * game pages are parked with __perf.hold(true)) or maxMs. Returns { waitedMs, busy: last samples, quiet }.
 */
export async function waitQuiet({ threshold = 25, maxMs = 60000 } = {}) {
  const t0 = Date.now(); const seen = [];
  while (Date.now() - t0 < maxMs) {
    const b = gpuBusy(); seen.push(b);
    if (b == null) return { waitedMs: 0, busy: seen, quiet: null };
    if (seen.length >= 3 && seen.slice(-3).every((x) => x < threshold)) return { waitedMs: Date.now() - t0, busy: seen.slice(-3), quiet: true };
    await sleep(700);
  }
  return { waitedMs: Date.now() - t0, busy: seen.slice(-5), quiet: false };
}

export function fmtTable(rows, cols) {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}
