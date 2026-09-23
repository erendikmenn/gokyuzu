// Hazards + UI keys: dive into the bay, fly into a downtown tower, into a Golden Gate tower; crash reason + auto reset.
// Then P (pause), R (reset), M (mute), F1 / ? (help), Tab (menu).
// usage: node tools/qa/hazards.mjs [aircraft] [--webkit] [--only water|city|ggb|ui]
import { launch, openGame, startSampling, tap, hold, shot, fly, sleep } from './lib.mjs';

const id = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'f16';
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const { browser, page, log } = await launch({ engine });
const note = (s) => console.log(s);
const results = {};
const st = () => page.evaluate(() => { const f = window.__game.flight; return { x: +f.position.x.toFixed(0), y: +f.position.y.toFixed(0), z: +f.position.z.toFixed(0), agl: +f.agl.toFixed(0), ias: +(f.ias / 0.514444).toFixed(0), hdg: +f.heading.toFixed(0), crashed: f.crashed, reason: f.crashReason, paused: window.__game.paused, crashTimer: +window.__game.crashTimer.toFixed(2) }; });
const hudText = () => page.evaluate(() => document.getElementById('hud').innerText.replace(/\s+/g, ' ').slice(0, 400));
const bearing = (s, tx, tz) => ((Math.atan2(tx - s.x, -(tz - s.z)) * 180 / Math.PI) + 360) % 360;

async function watchCrash(tag, maxMs) {
  const t0 = Date.now();
  let s = await st();
  while (!s.crashed && Date.now() - t0 < maxMs) { await sleep(100); s = await st(); }
  if (!s.crashed) { note(`${tag}: NO CRASH within ${maxMs} ms ${JSON.stringify(s)}`); await shot(page, `haz-${tag}-nocrash`); return { crashed: false }; }
  await sleep(400);
  const msg = await hudText();
  await shot(page, `haz-${tag}-crash`);
  note(`${tag}: crash ${JSON.stringify(s)} | HUD: ${msg.slice(0, 200)}`);
  // auto reset after ~4 s
  const t1 = Date.now();
  let r = await st();
  while (r.crashed && Date.now() - t1 < 8000) { await sleep(100); r = await st(); }
  note(`${tag}: reset after ${((Date.now() - t1) / 1000 + 0.4).toFixed(1)} s -> ${JSON.stringify(r)}`);
  await sleep(600);
  await shot(page, `haz-${tag}-after-reset`);
  return { crashed: true, reason: s.reason, reset: !r.crashed, at: s };
}

let minDist = Infinity;
async function steerTo(tx, tz, alt, maxMs, untilFn) {
  const t0 = Date.now(); minDist = Infinity;
  const alt0 = (await st()).y;
  while (Date.now() - t0 < maxMs) {
    const s = await st();
    const d = Math.hypot(tx - s.x, tz - s.z); minDist = Math.min(minDist, d);
    if (s.crashed || (untilFn && untilFn(s))) return s;
    if (minDist < 300 && d > minDist + 400) { note(`passed the target: min distance ${minDist.toFixed(0)} m`); return s; }
    // stay high while turning in, descend to the target altitude in the last 3 km
    await fly(page, { heading: bearing(s, tx, tz), alt: d < 3000 ? alt : alt0, maxBank: 45, pitchLimits: [-20, 20], maxMs: 400 });
  }
  return st();
}

try {
  if (!only || only === 'water') {
    note(`load ${(await openGame(page, id, 'AIR-SFO-FINAL')).toFixed(1)} s`);
    await startSampling(page);
    await sleep(1000);
    const w0 = await page.evaluate(() => { const f = window.__game.flight; return window.__game.world.isWater(f.position.x, f.position.z); });
    note(`over water at spawn: ${w0}`);
    await page.keyboard.down('KeyW');
    results.water = await watchCrash('water', 30000);
    await page.keyboard.up('KeyW');
  }
  if (!only || only === 'city') {
    await openGame(page, id, 'AIR-CITY');
    await startSampling(page);
    await sleep(800);
    // Salesforce Tower (326 m): fly at it at 200 m
    await steerTo(-2102, -18941, 200, 60000);
    note(`city min distance to Salesforce Tower ${minDist.toFixed(0)} m`);
    results.city = await watchCrash('city', 3000);
  }
  if (!only || only === 'ggb') {
    await openGame(page, id, 'AIR-GGB');
    await startSampling(page);
    // find the two bridge towers from the world obstacle heights
    const towers = await page.evaluate(() => {
      const w = window.__game.world; const pts = [];
      for (let dx = -1200; dx <= 1200; dx += 8) for (let dz = -1200; dz <= 1200; dz += 8) {
        const x = -9249 + dx, z = -22236 + dz; const h = w.getObstacleHeight(x, z);
        if (h > 150) pts.push({ x, z, h });
      }
      pts.sort((a, b) => b.h - a.h);
      const out = [];
      for (const p of pts) if (out.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > 300)) out.push(p);
      return out.slice(0, 3);
    });
    note(`GGB towers (obstacle height > 150 m): ${JSON.stringify(towers)}`);
    const t = towers.sort((a, b) => a.x - b.x)[0] || { x: -9249, z: -22236 };
    await steerTo(t.x, t.z, 150, 90000);
    note(`GGB min distance to tower ${minDist.toFixed(0)} m`);
    results.ggb = await watchCrash('ggb', 3000);
  }
  if (!only || only === 'ui') {
    await openGame(page, id, 'AIR-CITY');
    await startSampling(page);
    await sleep(1500);
    const a = await st(); await tap(page, 'KeyP'); await sleep(2000); const b = await st();
    const pausedUI = await hudText();
    await shot(page, 'haz-ui-paused');
    await tap(page, 'KeyP'); await sleep(1000); const c = await st();
    results.pause = { pausedFlag: b.paused, movedWhilePaused: Math.hypot(b.x - a.x, b.z - a.z) > 30 ? 'MOVED' : 'held', resumed: Math.hypot(c.x - b.x, c.z - b.z) > 30 && !c.paused };
    note(`pause: ${JSON.stringify(results.pause)} | HUD: ${pausedUI.slice(0, 160)}`);
    // Escape also pauses
    await tap(page, 'Escape'); await sleep(500); const e1 = await page.evaluate(() => window.__game.paused); await tap(page, 'Escape'); await sleep(300);
    results.escape = e1;
    // reset
    await sleep(3000);
    const before = await st(); await tap(page, 'KeyR'); await sleep(500); const after = await st();
    const spawn = await page.evaluate(() => window.__game.spawn);
    results.reset = { movedBack: Math.hypot(after.x - spawn.x, after.z - spawn.z) < 150, from: [before.x, before.z], to: [after.x, after.z] };
    note(`reset: ${JSON.stringify(results.reset)}`);
    // mute
    const m0 = await page.evaluate(() => ({ user: window.__game.userMuted, audio: window.__game.audio && window.__game.audio.muted }));
    await tap(page, 'KeyM'); await sleep(400);
    const m1 = await page.evaluate(() => ({ user: window.__game.userMuted, audio: window.__game.audio && window.__game.audio.muted, ctx: window.__game.audio && window.__game.audio.ctx ? window.__game.audio.ctx.state : undefined }));
    await tap(page, 'KeyM'); await sleep(400);
    const m2 = await page.evaluate(() => ({ user: window.__game.userMuted, audio: window.__game.audio && window.__game.audio.muted }));
    results.mute = { m0, m1, m2 };
    note(`mute: ${JSON.stringify(results.mute)}`);
    // help F1, then ?
    await tap(page, 'F1'); await sleep(600);
    const helpVis = await page.evaluate(() => window.__game.helpVisible);
    const helpText = await hudText();
    await shot(page, 'haz-ui-help');
    await tap(page, 'F1'); await sleep(300);
    await page.keyboard.press('Shift+Slash'); await sleep(600);
    const helpQ = await page.evaluate(() => window.__game.helpVisible);
    await page.keyboard.press('Shift+Slash'); await sleep(300);
    const helpQ2 = await page.evaluate(() => window.__game.helpVisible);
    results.help = { F1: helpVis, question: helpQ, questionOff: !helpQ2, text: helpText.slice(0, 120) };
    note(`help: ${JSON.stringify(results.help)}`);
    // H hides the HUD
    await tap(page, 'KeyH'); await sleep(400); await shot(page, 'haz-ui-hudhidden'); await tap(page, 'KeyH');
    // Tab -> menu
    await tap(page, 'Tab'); await sleep(2500);
    results.menu = await page.evaluate(() => ({ url: location.href, menu: !!document.querySelector('.gkm-fly') }));
    note(`menu: ${JSON.stringify(results.menu)}`);
    await shot(page, 'haz-ui-menu');
  }
} catch (e) { console.error('TEST ERROR', e); await shot(page, 'haz-error'); }
console.log('RESULTS', JSON.stringify(results));
console.log('errors', JSON.stringify(log.errors.slice(0, 20)));
await browser.close();
