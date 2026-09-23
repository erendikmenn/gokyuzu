// Error audit repro: WebGL context loss on an old build vs the current one.
// node repro-ctx.mjs <chromium|webkit> <rev|current> <restore|nodispatch|gpukill|delayed> [aircraft] [spawn] [device]
//   gpukill  : like nodispatch, and every gl.create* returns null (WebKit after its GPU process died) → shaderSource error
//   rev      : a git revision; index.html + src/** are served from `git show <rev>:<path>` (assets from the working tree)
//   restore  : WEBGL_lose_context.loseContext(), restoreContext() 1 s later (what iOS does after a memory kill)
//   nodispatch: the webglcontextlost event never reaches the page; then a material needing a new program is added
//   delayed  : like nodispatch, but a (synthetic) webglcontextlost reaches the page 2 s later
//   device   : 'iphone' → iPhone 15 emulation (WebKit), otherwise desktop 1440x900
import { chromium, webkit, devices } from 'playwright';
import { execFileSync } from 'node:child_process';

const [engine = 'chromium', rev = 'current', mode = 'restore', ac = 'f16', spawn = 'KNGZ-24', device = 'desktop'] = process.argv.slice(2);
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const BASE = 'http://localhost:5173/';
const TYPES = { js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', json: 'application/json', css: 'text/css', svg: 'image/svg+xml', png: 'image/png' };

const browser = engine === 'webkit' ? await webkit.launch()
  : await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctxOpts = device === 'iphone' ? { ...devices['iPhone 15'] } : { viewport: { width: 1440, height: 900 } };
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); if (errors.length <= 3 || errors.length % 50 === 0) console.log(ts(), '[pageerror #' + errors.length + ']', e.message.slice(0, 160), '|', (e.stack || '').split('\n').slice(0, 2).join(' / ').slice(0, 200)); });
page.on('console', (m) => { const t = m.text(); if (/gpu|Context|WebGL|resume|\[app\]/i.test(t) && !/GL Driver/.test(t)) console.log(ts(), `[${m.type()}]`, t.slice(0, 200)); });
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(ts(), '[nav]', f.url().replace(BASE, '/')); });
page.on('request', (r) => { if (r.url().includes('/_e?')) console.log(ts(), '[beacon]', decodeURIComponent(r.url().split('?')[1]).slice(0, 220)); });

if (rev !== 'current') {
  await page.route(/localhost:5173\/(index\.html|src\/.*|$)(\?.*)?$/, async (route) => {
    const u = new URL(route.request().url());
    let p = u.pathname.replace(/^\//, '') || 'index.html';
    try {
      const body = execFileSync('git', ['-C', REPO, 'show', `${rev}:${p}`], { maxBuffer: 64 << 20 });
      await route.fulfill({ status: 200, body, headers: { 'content-type': TYPES[p.split('.').pop()] || 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch { await route.fulfill({ status: 404, body: 'not in ' + rev }); }
  });
}
// telemetry=1 so beacons (err/gfx) are visible as requests (the dev server answers /_e with 204)
const url = `${BASE}index.html?aircraft=${ac}&spawn=${spawn}&telemetry=1`;
if (mode !== 'restore') {
  await page.addInitScript((mode) => {
    // swallow the real loss event before three.js / the guard see it (capture phase on window runs first)
    window.__lossEvents = 0;
    window.addEventListener('webglcontextlost', (e) => { if (e.isTrusted && window.__blockLoss) { window.__lossEvents++; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }, mode);
}
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.readyAt, null, { timeout: 180000, polling: 250 });
console.log(ts(), 'ready; letting city tiles stream + free their arrays for 12 s');
await page.mouse.click(700, 300).catch(() => {});
await page.waitForTimeout(12000);
const before = await page.evaluate(() => {
  const g = window.__game, r = g.renderer;
  let freed = 0; g.scene.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.array === null) freed++; });
  return { geos: r.info.memory.geometries, tex: r.info.memory.textures, progs: r.info.programs.length, freedMeshes: freed, q: g.quality && g.quality.id };
});
console.log(ts(), 'before loss', JSON.stringify(before));
const errBefore = errors.length;

if (mode === 'restore') {
  await page.evaluate(() => { const gl = window.__game.renderer.getContext(); window.__lc = gl.getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
  console.log(ts(), 'loseContext() called');
  await page.waitForTimeout(1000);
  await page.evaluate(() => { try { window.__lc.restoreContext(); } catch (e) { console.log('restore failed ' + e.message); } }).catch((e) => console.log(ts(), 'restore eval failed (page reloading?)', e.message.slice(0, 80)));
  console.log(ts(), 'restoreContext() called');
} else {
  await page.evaluate((mode) => {
    window.__blockLoss = true; const gl = window.__game.renderer.getContext(); window.__lc = gl.getExtension('WEBGL_lose_context'); window.__lc.loseContext();
    // gpukill: the GPU process is gone, so object creation returns null (what WebKit does when its GraphicsContextGL died)
    if (mode === 'gpukill') for (const f of ['createShader', 'createProgram', 'createBuffer', 'createTexture', 'createFramebuffer', 'createRenderbuffer', 'createVertexArray']) gl[f] = () => null;
  }, mode);
  console.log(ts(), 'loseContext() called, event blocked' + (mode === 'gpukill' ? ', create* → null' : ''));
  await page.waitForTimeout(500);
  // a new program is needed (as when the cockpit, a new tile material variant or the HUD glass first shows up)
  await page.evaluate(() => {
    const g = window.__game; let src = null;
    g.rig.object.traverse((o) => { if (!src && o.isMesh && o.material && !Array.isArray(o.material)) src = o; });
    const m = src.material.clone(); m.defines = { ...(m.defines || {}), AUDIT_NEW_PROGRAM: 1 }; m.needsUpdate = true;
    const mesh = new src.constructor(src.geometry, m); mesh.position.copy(g.camera.position); mesh.frustumCulled = false; g.scene.add(mesh);
    console.log('[audit] new-program mesh added; lossEvents=' + window.__lossEvents + ' isContextLost=' + g.renderer.getContext().isContextLost());
  });
  if (mode === 'delayed') {
    await page.waitForTimeout(2000);
    await page.evaluate(() => { window.__blockLoss = false; window.__game.renderer.domElement.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); console.log('[audit] synthetic webglcontextlost dispatched'); });
  }
}
await page.waitForTimeout(9000);
const after = await page.evaluate(() => {
  const g = window.__game; if (!g) return { noGame: true };
  const r = g.renderer, gl = r.getContext();
  return { url: location.search, ready: !!g.readyAt, lost: gl.isContextLost(), halted: !!g.halted, q: g.quality && g.quality.id, progs: r.info.programs && r.info.programs.length, calls: r.info.render.calls, gpuFailing: g.gpu ? g.gpu.failing : 'n/a', notice: [...document.querySelectorAll('[role=alertdialog]')].map((e) => e.textContent.slice(0, 80)).join('|') };
}).catch((e) => ({ evalError: e.message.slice(0, 100) }));
console.log(ts(), 'after', JSON.stringify(after));
console.log(ts(), `page errors: before=${errBefore} after=${errors.length - errBefore}`, [...new Set(errors.slice(errBefore))].map((e) => e.slice(0, 120)));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();
