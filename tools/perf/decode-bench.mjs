#!/usr/bin/env node
// Decode / upload benchmark per asset variant (tools/perf/bench/decode-bench.html): parse time (Draco / meshopt / KTX2
// transcode / image decode incl. workers), texture upload time (initTexture + finish), first program compile and the
// GPU texture bytes (GL-level, tools/perf/probe.js). Files are paths under the served root (e.g. exp-assets/*.glb written
// by tools/perf/exp/convert.mjs into a scratch worktree).
// usage: node tools/perf/decode-bench.mjs [--base http://localhost:5195/] [--reps 5] [--cpu 4] file.glb ...
import { chromium } from 'playwright';
import fs from 'node:fs';
import { GPU_ARGS, arg, save, BASE } from './lib.mjs';
const files = process.argv.slice(2).filter((a) => a.endsWith('.glb'));
const base = arg('--base', BASE);
const reps = Number(arg('--reps', 5));
const cpu = Number(arg('--cpu', 1));
const probe = fs.readFileSync(new URL('./probe.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ args: GPU_ARGS });
const page = await browser.newPage();
await page.addInitScript(({ probe }) => { window.__PERF_CFG = { gl: 'mem' }; (0, eval)(probe); }, { probe });
if (cpu > 1) { const c = await page.context().newCDPSession(page); await c.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`${base}tools/perf/bench/decode-bench.html?reps=${reps}&files=${encodeURIComponent(files.join(','))}`);
await page.waitForFunction(() => window.__bench, null, { timeout: 600000 });
const res = await page.evaluate(() => window.__bench);
for (const [f, r] of Object.entries(res)) console.log(f.padEnd(44), JSON.stringify(r));
save(`decode-bench${cpu > 1 ? `-cpu${cpu}` : ''}.json`, res);
await browser.close();
