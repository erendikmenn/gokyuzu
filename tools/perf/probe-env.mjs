// WebGL extensions, GPU name, scene graph (top-level children), renderer.info and failed requests of a running flight.
// usage: node tools/perf/probe-env.mjs   (PERF_BASE selects the server, default http://localhost:5195/)
import { chromium } from 'playwright';
import { BASE } from './lib.mjs';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
const t0 = Date.now();
await page.goto(`${BASE}index.html?aircraft=a320neo&spawn=KSFO-28R&quality=high&pr=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.flight && window.__game.readyAt, null, { timeout: 120000 });
console.log('ready', (Date.now() - t0) / 1000);
await page.waitForTimeout(3000);
const r = await page.evaluate(() => {
  const g = window.__game, gl = g.renderer.getContext();
  const exts = gl.getSupportedExtensions();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const kids = g.scene.children.map((c) => { let n = 0; c.traverse(() => n++); return `${c.type}:${c.name}:${n}`; });
  return { exts: exts.filter((e) => /timer|compress|parallel|astc|etc|s3tc|bptc|rgtc/i.test(e)), gpu: dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), kids, info: { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles, prog: g.renderer.info.programs.length, tex: g.renderer.info.memory.textures, geo: g.renderer.info.memory.geometries }, keys: Object.keys(g), layers: g.world.layers.map((l) => l.object && l.object.name), dpr: devicePixelRatio, pr: g.renderer.getPixelRatio(), fps: window.__fps };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
