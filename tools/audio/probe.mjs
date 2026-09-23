#!/usr/bin/env node
// Record the live runtime mix from dev/audio.html in headless Chromium.
// Usage: node tools/audio/probe.mjs --ac f16 --out rec.wav [--cam chase|cockpit|static] [--scenario takeoff|approach|flyby|super|ab]
//        [--seq "n1=0.2,tas=0:3;n1=1:3;ab=1:4"] [--secs 20] [--dist 30] [--azim 180] [--warn stall,pullUp:5-9]
// --seq: ';'-separated steps "k=v,k=v:seconds" applied in order (k = dev page slider/checkbox id). Prints a JSON timeline
//        of audio.debug() snapshots (RMS/peak) per step.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ac = opt('ac', 'f16'), out = opt('out', 'rec.wav'), cam = opt('cam', 'chase');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173/dev/audio.html?ac=${ac}&cam=${cam}`, { waitUntil: 'load' });
await page.waitForTimeout(300);
await page.mouse.click(1300, 880);
for (let i = 0; i < 100 && !(await page.evaluate(() => window.__ready && window.__ready())); i++) await page.waitForTimeout(100);
await page.evaluate(({ d, a }) => { window.__set('dist', d); window.__set('azim', a); }, { d: Number(opt('dist', 30)), a: Number(opt('azim', 180)) });
const seq = opt('seq');
const setMany = async (kv) => page.evaluate((kv) => {
  for (const part of kv.split(',').filter(Boolean)) {
    const [k, v] = part.split('=');
    const el = document.getElementById(k);
    if (!el) { if (k in window.__fake.warnings) { window.__fake.warnings[k] = v === '1'; if (k === 'stall') window.__fake.stalled = v === '1'; } continue; }
    if (el.type === 'checkbox') { el.checked = v === '1'; el.dispatchEvent(new Event('change')); } else if (el.tagName === 'SELECT') { el.value = v; } else window.__set(k, Number(v));
  }
}, kv);
if (opt('init')) await setMany(opt('init'));
await page.waitForTimeout(Number(opt('settle', 1500)));
await page.evaluate(() => window.__rec.start());
const t0 = Date.now();
const timeline = [];
if (seq) {
  for (const step of seq.split(';')) {
    const [kv, secs] = step.split(':');
    await setMany(kv);
    const ms = Number(secs || 2) * 1000;
    await page.waitForTimeout(ms * 0.6);
    const d = await page.evaluate(() => window.__audio.debug());
    timeline.push({ t: (Date.now() - t0) / 1000, step: kv, rms: d.rmsDb, peak: d.peakDb, voice: d.voice, layers: d.layers.filter((l) => l.g > 0.001).map((l) => `${l.id}:${l.g}`).join(' ') });
    await page.waitForTimeout(ms * 0.4);
  }
} else {
  const sc = opt('scenario');
  if (sc) await page.evaluate((s) => window.__scenario(s), sc);
  // poll: log voice changes and a coarse level trace
  const end = Date.now() + Number(opt('secs', 20)) * 1000;
  let lastVoice = null, lastLog = 0;
  while (Date.now() < end) {
    const d = await page.evaluate(() => { const d = window.__audio.debug(); const f = window.__fake; return { v: d.voice, rms: d.rmsDb, agl: f.agl, g: f.onGround, tas: f.airspeed }; });
    const t = (Date.now() - t0) / 1000;
    if (d.v !== lastVoice) { console.log(`t=${t.toFixed(2)} voice=${d.v} agl=${(d.agl * 3.28).toFixed(0)}ft onGround=${d.g}`); lastVoice = d.v; }
    if (t - lastLog > 5) { console.log(`t=${t.toFixed(1)} rms=${d.rms} agl=${(d.agl * 3.28).toFixed(0)}ft tas=${d.tas.toFixed(0)}`); lastLog = t; }
    await page.waitForTimeout(100);
  }
}
const b64 = await page.evaluate(() => window.__rec.stop());
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
for (const r of timeline) console.log(JSON.stringify(r));
console.log(problems.length ? problems.join('\n') : 'no console errors');
console.log('saved', out, ((Date.now() - t0) / 1000).toFixed(1) + ' s');
await browser.close();
