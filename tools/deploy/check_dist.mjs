#!/usr/bin/env node
// Loads the game from a publish-build server and lists every HTTP >= 400 response per aircraft/spawn.
// Usage: node tools/deploy/check_dist.mjs [baseUrl] [--ist]   (default http://localhost:5190/; --ist adds İstanbul flights, whose
// map is chosen by its spawn ids: src/maps/index.js)
import { chromium } from 'playwright';
const base = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://localhost:5190/';
const cases = [['f16', 'KNGZ-24'], ['f22', 'AIR-GGB'], ['a320neo', 'KSFO-28R'], ['b737', 'AIR-SFO-FINAL'], ['uh60', 'AIR-CITY'], ['a320neo', 'KOAK-30']];
if (process.argv.includes('--ist')) cases.push(['f16', 'LTBA-05'], ['a320neo', 'LTFM-35L'], ['b737', 'IST-AIR-LTFJ-FINAL'], ['uh60', 'IST-HOVER-GALATA'], ['f22', 'IST-AIR-BOGAZ']);
const UNVERSIONED_OK = new Set(['/assets/versions.json', '/assets/audio/manifest.json']);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let bad = 0;
for (const [ac, sp] of cases) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = new Set();
  page.on('response', (r) => { if (r.status() >= 400) errors.add(`${r.status()} ${r.url().replace(base, '/')}`); });
  // CONTRACTS-SF.md §9: every game file under assets/ and renders/ is requested with ?v=<hash> (except the two maps
  // that are always revalidated: the version map itself and the audio manifest, whose entries carry per-file hashes)
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(base).origin || !/^\/(assets|renders)\//.test(u.pathname)) return;
    if (!u.searchParams.has('v') && !UNVERSIONED_OK.has(u.pathname)) errors.add(`unversioned ${u.pathname}`);
  });
  page.on('pageerror', (e) => errors.add(`pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_ABORTED/.test(m.text())) errors.add(`console ${m.text().slice(0, 160)}`); });
  await page.goto(`${base}index.html?aircraft=${ac}&spawn=${sp}`);
  await page.waitForTimeout(15000);
  const ok = await page.evaluate(() => !!(window.__game && window.__game.flight && window.__game.rig)).catch(() => false);
  console.log(`${ac}@${sp}: ready=${ok} problems=${errors.size}`);
  for (const e of errors) console.log('   ', e);
  bad += errors.size + (ok ? 0 : 1);
  await page.close();
}
for (const p of ['galeri.html', 'ada.html']) {
  const page = await browser.newPage(); const errors = [];
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(base + p); await page.waitForTimeout(3000);
  console.log(`${p}: problems=${errors.length}`); errors.slice(0, 5).forEach((e) => console.log('   ', e)); bad += errors.length; await page.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
