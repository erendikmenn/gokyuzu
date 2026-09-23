// Menu flow: open index.html, click an aircraft card and a spawn, press "Uç", wait for the game; checks that the chosen
// aircraft / spawn are the ones that load, loading time and console errors.
// usage: node tools/qa/menu.mjs [--webkit]
import { launch, shot, sleep, OUT } from './lib.mjs';

const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const plan = [
  ['f16', 'Golden Gate', 'AIR-GGB'],
  ['f22', '06', 'KNGZ-06'],
  ['a320neo', '28L', 'KSFO-28L'],
  ['b737', '30', 'KOAK-30'],
  ['uh60', 'Şehir merkezi', 'AIR-CITY'],
];
const { browser, page, log } = await launch({ engine });
const rows = [];
for (const [id, spawnText, spawnId] of plan) {
  const e0 = log.errors.length;
  await page.goto('http://localhost:5173/index.html', { waitUntil: 'load' });
  await page.waitForSelector('.gkm-card', { timeout: 20000 });
  await sleep(600);
  if (id === 'f16') await shot(page, `menu-${engine}-0`);
  await page.click(`.gkm-card[data-id="${id}"]`);
  await sleep(300);
  const btn = spawnId.startsWith('AIR')
    ? page.locator('.gkm-spawn', { hasText: spawnText }).first()
    : page.locator('.gkm-group', { hasText: spawnId.startsWith('KSFO') ? 'SFO' : spawnId.startsWith('KNGZ') ? 'NGZ' : 'OAK' }).locator('.gkm-spawn', { has: page.locator('.gkm-sp-id', { hasText: new RegExp(`^${spawnText}$`) }) }).first();
  await btn.click();
  await sleep(300);
  const sel = await page.evaluate(() => document.querySelector('.gkm-sel')?.innerText);
  await shot(page, `menu-${engine}-${id}-selected`);
  const t0 = Date.now();
  await page.click('.gkm-fly');
  let ok = true;
  try { await page.waitForFunction(() => window.__game && window.__game.flight && window.__game.rig && window.__game.world, null, { timeout: 90000, polling: 200 }); }
  catch { ok = false; }
  const tReady = (Date.now() - t0) / 1000;
  await sleep(2500);
  const g = ok ? await page.evaluate(() => ({ ac: window.__game.def.id, spawn: window.__game.spawn.id, cam: window.__game.cameraRig.mode, fps: window.__fps, ui: document.getElementById('ui').innerText.slice(0, 80) })) : {};
  await shot(page, `menu-${engine}-${id}-flying`);
  rows.push({ id, want: spawnId, got: g.spawn, acOk: g.ac === id, spawnOk: g.spawn === spawnId, sel, tReady: +tReady.toFixed(1), appReady: log.ready, fps: g.fps && +g.fps.toFixed(0), leftoverUI: g.ui, errors: log.errors.slice(e0) });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
// keyboard path: arrows + Enter
await page.goto('http://localhost:5173/index.html', { waitUntil: 'load' });
await page.waitForSelector('.gkm-card');
await sleep(500);
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
try { await page.waitForFunction(() => window.__game && window.__game.flight && window.__game.def, null, { timeout: 90000 }); console.log('keyboard menu ->', JSON.stringify(await page.evaluate(() => ({ ac: window.__game.def.id, spawn: window.__game.spawn.id })))); }
catch (e) { console.log('keyboard menu failed', e.message); }
console.log('errors', JSON.stringify(log.errors.slice(0, 20)), 'aborted', log.aborted);
await browser.close();
