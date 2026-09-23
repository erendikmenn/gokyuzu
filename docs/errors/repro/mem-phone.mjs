// Error audit: GPU + JS memory at flight start on a phone profile (Chromium, iPhone 15 emulation), old build vs current.
// node mem-phone.mjs <rev|current> [quality] [aircraft] [spawn]
import { chromium, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const [rev = 'current', quality = '', ac = 'f16', spawn = 'KNGZ-24'] = process.argv.slice(2);
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const TYPES = { js: 'text/javascript', html: 'text/html', json: 'application/json' };
const meterSrc = fs.readFileSync(`${REPO}/src/core/gpu-meter.js`, 'utf8').replace(/^export /m, '');

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ ...devices['iPhone 15'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
if (rev !== 'current') {
  await page.route(/localhost:5173\/(index\.html|src\/.*|$)(\?.*)?$/, async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    try { await route.fulfill({ status: 200, body: execFileSync('git', ['-C', REPO, 'show', `${rev}:${p}`], { maxBuffer: 64 << 20 }), headers: { 'content-type': TYPES[p.split('.').pop()] || 'application/octet-stream', 'cache-control': 'no-store' } }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
}
await page.addInitScript(`${meterSrc}
  window.__meters = [];
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const gl = orig.call(this, type, attrs);
    if (gl && /webgl/.test(type) && !gl.__gpuMeter) { try { window.__meters.push(attachGpuMeter(gl)); } catch (e) {} }
    return gl;
  };
  // decoded Web Audio buffers (float32 PCM) held by the page
  window.__audioBytes = 0;
  const dec = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (...a) {
    const p = dec.apply(this, a);
    return p.then((b) => { window.__audioBytes += b.length * b.numberOfChannels * 4; return b; });
  };`);
const t0 = Date.now();
await page.goto(`http://localhost:5173/index.html?aircraft=${ac}&spawn=${spawn}${quality ? '&quality=' + quality : ''}&telemetry=0`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.readyAt, null, { timeout: 180000, polling: 200 });
const snap = () => page.evaluate(() => {
  const g = window.__game, MB = (b) => Math.round(b / 1048576);
  const gpu = Math.max(0, ...window.__meters.map((m) => m.bytes)), peak = Math.max(0, ...window.__meters.map((m) => m.peak));
  return { q: (g.quality && g.quality.id) || '?', pr: g.renderer.getPixelRatio().toFixed(2), gpuMB: MB(gpu), peakMB: MB(peak), jsHeapMB: performance.memory ? MB(performance.memory.usedJSHeapSize) : null, audioPcmMB: MB(window.__audioBytes), geos: g.renderer.info.memory.geometries, tex: g.renderer.info.memory.textures };
});
const out = [];
for (const at of [0, 5, 10, 20, 30]) {
  const wait = at * 1000 - (Date.now() - t0 - 0);
  if (at) await page.waitForTimeout(5000 * (at === 5 ? 1 : at === 10 ? 1 : 2));
  const s = await snap();
  out.push({ t: at, ...s });
}
console.log(JSON.stringify({ rev, quality: quality || 'default', ac, errors: errors.length }));
for (const o of out) console.log('  ', JSON.stringify(o));
await browser.close();
