#!/usr/bin/env node
// Headless screenshot + console check.
// Usage: node tools/shot.mjs <url-path> <out.png> [--wait ms] [--hold KeyW:2000,ShiftLeft:1500] [--eval "js expr"] [--click] [--size 1920x1080] [--swiftshader] [--webkit]
//   Renders on the real Apple GPU (ANGLE/Metal) by default, so fps readings are meaningful. --swiftshader forces software GL.
//   url-path is relative to http://localhost:5173/ (e.g. "index.html" or "dev/models.html").
//   --click   clicks the page center first (dismisses the start overlay in index.html).
//   --hold    presses keys in sequence, each held for the given ms (KeyboardEvent.code names).
//   --eval    evaluates an expression in the page at the end and prints the JSON result.
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node tools/shot.mjs <url-path> <out.png> [--wait ms] [--hold Code:ms,...] [--eval expr] [--click]');
  process.exit(2);
}
const [urlPath, out] = args;
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const wait = Number(opt('--wait') ?? 2500);
const hold = opt('--hold');
const evalExpr = opt('--eval');
const click = args.includes('--click');

const [vw, vh] = (opt('--size') || '1440x900').split('x').map(Number);
const gpuArgs = args.includes('--swiftshader')
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
// --webkit runs Safari's engine (WebKit) instead of Chromium, to check Safari compatibility
const browser = args.includes('--webkit') ? await webkit.launch() : await chromium.launch({ args: gpuArgs });
const dpr = Number(opt('--dpr') ?? 1);   // --dpr 2 emulates a Retina display (devicePixelRatio 2)
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
const problems = [];
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/GL Driver Message|GPU stall/.test(m.text())) problems.push(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

const url = new URL(urlPath.replace(/^\//, ''), 'http://localhost:5173/').href;
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(800);
if (click) { await page.mouse.click(720, 450); await page.waitForTimeout(300); }
if (hold) {
  for (const part of hold.split(',')) {
    const [code, ms] = part.split(':');
    await page.keyboard.down(code);
    await page.waitForTimeout(Number(ms || 500));
    await page.keyboard.up(code);
  }
}
await page.waitForTimeout(wait);
if (evalExpr) {
  try { console.log('eval:', JSON.stringify(await page.evaluate(evalExpr), null, 0)); }
  catch (e) { console.log('eval error:', e.message); }
}
await page.screenshot({ path: out });
const fps = await page.evaluate(() => window.__fps).catch(() => undefined);
if (fps) console.log('fps:', fps.toFixed(1));
await browser.close();
console.log(problems.length ? problems.join('\n') : 'no console errors');
console.log('saved', out);
