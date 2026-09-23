import { chromium, webkit } from 'playwright';
for (const [name, bt, args] of [['chromium', chromium, { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] }], ['webkit', webkit, {}]]) {
  const b = await bt.launch(args); const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto('http://localhost:5173/index.html?aircraft=f16&spawn=KNGZ-24&quality=high&telemetry=1');
  await p.waitForFunction(() => window.__game && window.__game.readyAt, null, { timeout: 120000 });
  await p.waitForTimeout(7000);   // > 5 s: at least one periodic snapshot saved
  const snap = await p.evaluate(() => sessionStorage.getItem('gokyuzu.resume'));
  // the player opens the game again in a second tab from the running one (same as Duplicate Tab / a target=_blank link)
  const [p2] = await Promise.all([ctx.waitForEvent('page'), p.evaluate(() => window.open('http://localhost:5173/', '_blank'))]);
  const beacons = []; p2.on('request', (r) => { if (r.url().includes('/_e?')) beacons.push(decodeURIComponent(r.url().split('?')[1])); });
  await p2.waitForFunction(() => window.__game && (window.__game.readyAt || document.querySelector('#ui *')), null, { timeout: 120000 }).catch(() => {});
  await p2.waitForTimeout(4000);
  const r = await p2.evaluate(() => ({ url: location.search, q: window.__game.quality && window.__game.quality.id, flying: !!window.__game.flight, cap: localStorage.getItem('gokyuzu.qualityCap') || Object.keys(localStorage).filter((k) => /cap/i.test(k)).map((k) => k + '=' + localStorage.getItem(k)).join(',') }));
  console.log(name, 'snapshot in tab 1:', snap ? JSON.parse(snap).alive : null, '| tab 2:', JSON.stringify(r));
  console.log('   tab-2 beacons:', beacons.filter((x) => /t=(open|fly|gfx)/.test(x)).map((x) => x.replace(/&(s|n|m|v|w|h|dpr|lang|gpu|ref|pr|dev|mem|tex|buf|fb|pk|nt|tt|cl|heap|rel|vw|up)=[^&]*/g, '')));
  await b.close();
}
