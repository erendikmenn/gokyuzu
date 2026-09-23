#!/usr/bin/env node
// Live smoke test of the published site: time-to-playable, MB downloaded before playable, and any HTTP >= 400.
// Usage: node tools/deploy/live_check.mjs [https://fs.erenailab.com] [--map host=ip]   (--map bypasses a stale local DNS cache)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith('http')) || 'https://fs.erenailab.com').replace(/\/$/, '') + '/';
const map = args.includes('--map') ? args[args.indexOf('--map') + 1] : null;
const launchArgs = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
if (map) { const [h, ip] = map.split('='); launchArgs.push(`--host-resolver-rules=MAP ${h} ${ip}`); }
const cases = [['a320neo', 'KSFO-28R', 'high'], ['f16', 'AIR-GGB', 'high'], ['uh60', 'KNGZ-24', 'low'], ['b737', 'AIR-SFO-FINAL', 'medium'], ['f22', 'AIR-CITY', 'ultra']];
const browser = await chromium.launch({ args: launchArgs });
let bad = 0;
for (const [ac, sp, q] of cases) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });   // fresh context = empty cache (first visit)
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page); await cdp.send('Network.enable');
  let bytes = 0; cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
  const errors = new Set();
  page.on('response', (r) => { if (r.status() >= 400) errors.add(`${r.status()} ${r.url().replace(base, '/')}`); });
  page.on('pageerror', (e) => errors.add(`pageerror ${e.message}`));
  const t0 = Date.now();
  await page.goto(`${base}index.html?aircraft=${ac}&spawn=${sp}&quality=${q}`);
  let ready = true;
  try { await page.waitForFunction(() => window.__game && window.__game.readyAt, null, { timeout: 90000, polling: 100 }); } catch { ready = false; }
  const t = (Date.now() - t0) / 1000, mb = bytes / 1e6;
  await page.waitForTimeout(6000);
  const fps = await page.evaluate(() => window.__fps).catch(() => 0);
  console.log(`${ac}@${sp} (${q}): ready=${ready} in ${t.toFixed(1)} s, ${mb.toFixed(1)} MB before playable, fps ${Math.round(fps)}, problems=${errors.size}`);
  for (const e of errors) console.log('   ', e);
  bad += errors.size + (ready ? 0 : 1);
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
