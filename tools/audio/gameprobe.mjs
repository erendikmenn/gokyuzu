#!/usr/bin/env node
// Drive the real game headless, press keys on a timeline, record the audio output and log audio/flight state.
// Usage: node tools/audio/gameprobe.mjs --ac f16 [--spawn KNGZ-24] --out rec.wav --secs 40
//        --keys "0:Digit9:300,12:KeyG:100,20:KeyT:100"   (at t seconds after ready: key code : hold ms)
//        [--log 1] (seconds between state logs) [--view cockpit] (press KeyT once at start)
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ac = opt('ac', 'f16'), out = opt('out', 'game.wav'), secs = Number(opt('secs', 30));
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
const spawn = opt('spawn');
await page.goto(`http://localhost:5173/index.html?aircraft=${ac}${spawn ? '&spawn=' + spawn : ''}`, { waitUntil: 'load' });
await page.waitForTimeout(500);
await page.mouse.click(640, 360);
for (let i = 0; i < 300; i++) {
  const ok = await page.evaluate(() => { const a = window.__audioSys; const g = window.__game; return !!(a && g && g.flight && a.debug().layers.length && a.debug().layers.every((l) => l.loaded)); });
  if (ok) break;
  await page.waitForTimeout(200);
}
await page.evaluate(() => {
  const a = window.__audioSys, ctx = a.context;
  window.__chunks = []; window.__n = 0;
  const node = ctx.createScriptProcessor(4096, 2, 2);
  node.onaudioprocess = (ev) => { const b = ev.inputBuffer; window.__chunks.push([b.getChannelData(0).slice(), b.getChannelData(1).slice()]); window.__n += b.length; };
  a.output.connect(node); node.connect(ctx.destination); window.__recNode = node;
});
const t0 = Date.now();
const keys = (opt('keys', '') || '').split(',').filter(Boolean).map((k) => { const [t, code, ms] = k.split(':'); return { t: Number(t), code, ms: Number(ms || 100), done: false }; });
const logEvery = Number(opt('log', 1));
let lastLog = -99, lastVoice = null;
while ((Date.now() - t0) / 1000 < secs) {
  const t = (Date.now() - t0) / 1000;
  for (const k of keys) if (!k.done && t >= k.t) { k.done = true; await page.keyboard.down(k.code); setTimeout(() => page.keyboard.up(k.code), k.ms); console.log(`t=${t.toFixed(1)} key ${k.code}`); }
  const st = await page.evaluate(() => {
    const d = window.__audioSys.debug(), f = window.__game.flight, v = f.getVisualState();
    return { rms: d.rmsDb, voice: d.voice, view: window.__game.cameraRig?.view, n1: f.engines.map((e) => +e.n1.toFixed(2)).join('/'), ab: +(f.engines[0].afterburner || 0).toFixed(2), gs: +(f.airspeed || 0).toFixed(0), agl: +(f.agl || 0).toFixed(0), vs: +(f.verticalSpeed || 0).toFixed(1), gear: +(f.gear ?? 0).toFixed(2), flaps: +(f.flaps ?? 0).toFixed(2), onG: f.onGround, canopy: +(v.canopy || 0).toFixed(2), rot: +(f.rotorRPM || 0).toFixed(2), tq: +(f.torque || 0).toFixed(2), col: +(f.collective || 0).toFixed(2), w: Object.entries(f.warnings || {}).filter(([, b]) => b).map(([k]) => k).join('+'), cr: f.crashed ? f.crashReason : '', ap: f.autopilot && f.autopilot.mode, act: d.layers.filter((l) => l.g > 0.01).map((l) => l.id.replace(/#\d/, '')).filter((x, i, a) => a.indexOf(x) === i).join(' ') };
  });
  if (st.voice !== lastVoice) { console.log(`t=${t.toFixed(1)} VOICE ${st.voice}`); lastVoice = st.voice; }
  if (t - lastLog >= logEvery) { lastLog = t; console.log(`t=${t.toFixed(1)} ${JSON.stringify(st)}`); }
  await page.waitForTimeout(100);
}
const b64 = await page.evaluate(() => {
  const a = window.__audioSys; a.output.disconnect(window.__recNode); window.__recNode.disconnect();
  const n = window.__n, sr = a.context.sampleRate, buf = new ArrayBuffer(44 + n * 4), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 4, true);
  let o = 44;
  for (const [l, r] of window.__chunks) for (let i = 0; i < l.length; i++) { dv.setInt16(o, Math.max(-1, Math.min(1, l[i])) * 32767, true); dv.setInt16(o + 2, Math.max(-1, Math.min(1, r[i])) * 32767, true); o += 4; }
  let bin = ''; const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
});
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
const mine = problems.filter((p) => !/requestfailed|Failed to load resource|ScriptProcessorNode/.test(p));
console.log(mine.length ? mine.join('\n') : 'no (audio-relevant) console errors');
console.log('saved', out);
await browser.close();
