#!/usr/bin/env node
// Content-Security-Policy check of a published build in real browsers (docs/security/infra-audit-2026-09.md, H-2).
// Loads the game in Chromium (desktop), WebKit (iPhone) and Firefox (desktop) and counts, per case:
//   * securitypolicyviolation events of the page (enforced AND report-only policies both fire them),
//   * browser console messages about CSP (they also cover the decoder workers, whose violations stay in the worker),
//   * other console errors (page and workers: a texture the decoder could not transcode shows up here),
//   * HTTP responses >= 400 and uncaught page errors,
// and whether the game reached its first playable frame (window.__game.readyAt).
//
//   node infra/security/csp_check.mjs https://staging.fs.erenailab.com                    # all engines, all cases
//   node infra/security/csp_check.mjs https://staging.fs.erenailab.com --engines webkit,firefox --cases sf,ist
//   node infra/security/csp_check.mjs <url> --inject-csp "<policy>"   # try a candidate policy locally: the browser gets it
//        as an enforced Content-Security-Policy header on every page (Playwright routing), the site is not changed
//   node infra/security/csp_check.mjs https://fs.erenailab.com --engines chromium --map fs.erenailab.com=<CloudFront edge IP>
//        (Chromium only) talks to CloudFront directly, past the Cloudflare proxy and its managed challenge: shows the
//        headers the production distribution itself sends (docs/security/infra-audit-2026-09.md, change plan H)
//
// Exit code 1 when any case has a violation, a problem or does not become playable. Staging answers only allow-listed
// addresses (tools/deploy/staging_access.sh). The production home page sits behind a Cloudflare managed challenge,
// which a headless browser does not pass: check production through an asset page or after the challenge is changed.
import { chromium, webkit, firefox, devices } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const base = (args.find((a) => a.startsWith('http')) || 'https://staging.fs.erenailab.com').replace(/\/$/, '') + '/';
const engines = opt('--engines', 'chromium,webkit,firefox').split(',');
const CASES = {
  sf: 'index.html?aircraft=a320neo&spawn=KSFO-28R&quality=medium',
  f16: 'index.html?aircraft=f16&spawn=AIR-GGB&quality=high',
  ist: 'index.html?map=ist&aircraft=b737&quality=medium',
  mission: 'index.html?mission=low-pass',
  ada: 'ada.html',
  gallery: 'galeri.html',
};
// first playable frame: index.html sets window.__game.readyAt; ada.html only runs its frame counter (window.__fps)
const READY = { ada: () => window.__fps > 0 };
const readyDefault = () => window.__game && window.__game.readyAt;
const cases = opt('--cases', Object.keys(CASES).join(',')).split(',');
const inject = opt('--inject-csp', '');
const map = opt('--map', '');
const LAUNCH = {
  chromium: () => chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    ...(map ? [`--host-resolver-rules=MAP ${map.split('=')[0]} ${map.split('=')[1]}`] : [])] }),
  webkit: () => webkit.launch(),
  firefox: () => firefox.launch({ firefoxUserPrefs: { 'webgl.force-enabled': true } }),
};
const CONTEXT = {
  chromium: { viewport: { width: 1600, height: 900 } },
  webkit: { ...devices['iPhone 15'] },
  firefox: { viewport: { width: 1440, height: 900 } },
};
const CSP_TEXT = /content.security.policy|Refused to|CSP|wasm-unsafe-eval|violates the following/i;
// WebKit ignores a report-only policy without report-uri (and says so once per page): informational, not a violation
const BENIGN = /delivered in report-only mode, but does not specify a 'report-uri'/i;

let bad = 0;
for (const engine of engines) {
  const browser = await LAUNCH[engine]();
  for (const name of cases) {
    const ctx = await browser.newContext({ ...CONTEXT[engine], serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__csp.push({ d: e.effectiveDirective || e.violatedDirective, b: String(e.blockedURI || '').slice(0, 80),
          s: String(e.sourceFile || '').split('/').pop().slice(0, 60), ro: e.disposition === 'report' });
      });
    });
    if (inject) {
      await ctx.route((u) => u.pathname.endsWith('.html') || u.pathname.endsWith('/'), async (route) => {
        if (route.request().resourceType() !== 'document') return route.continue();
        const r = await route.fetch();
        const headers = { ...r.headers(), 'content-security-policy': inject };
        delete headers['content-security-policy-report-only'];
        return route.fulfill({ response: r, headers });
      });
    }
    const page = await ctx.newPage();
    const problems = new Set(), consoleCsp = new Set(), consoleErrors = new Set();
    const notes = new Set();
    const onConsole = (m) => {
      if (BENIGN.test(m.text())) notes.add('WebKit ignores report-only CSP without report-uri: only an enforced run tests WebKit');
      else if (CSP_TEXT.test(m.text())) consoleCsp.add(m.text().slice(0, 220));
      else if (m.type() === 'error') consoleErrors.add(m.text().slice(0, 220));
    };
    page.on('console', onConsole);
    page.on('worker', (w) => w.on('console', onConsole));
    page.on('pageerror', (e) => problems.add(`pageerror ${String(e.message).slice(0, 160)}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.add(`${r.status()} ${r.url().replace(base, '/').slice(0, 120)}`); });
    const t0 = Date.now();
    const res = await page.goto(base + CASES[name], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => { problems.add(`goto ${e.message}`); return null; });
    const h = res ? res.headers() : {};
    const policy = inject ? 'injected' : h['content-security-policy'] ? 'enforced' : h['content-security-policy-report-only'] ? 'report-only' : 'none';
    let ready = true;
    if (name !== 'gallery') {
      try { await page.waitForFunction(READY[name] || readyDefault, null, { timeout: 150000, polling: 250 }); } catch { ready = false; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    await page.waitForTimeout(10000);   // lazy chunks: the full aircraft model, sounds, the missions / challenges code
    const v = await page.evaluate(() => window.__csp || []).catch(() => []);
    const uniq = [...new Set(v.map((x) => `${x.ro ? '[report-only] ' : ''}${x.d} blocked=${x.b} src=${x.s}`))];
    const n = uniq.length + consoleCsp.size + problems.size + consoleErrors.size + (ready ? 0 : 1);
    bad += n;
    console.log(`${engine.padEnd(8)} ${name.padEnd(8)} CSP ${policy.padEnd(11)} ready=${ready} (${secs} s)  violations=${v.length} csp-console=${consoleCsp.size} console-errors=${consoleErrors.size} problems=${problems.size}`);
    for (const x of uniq) console.log('    violation', x);
    for (const x of consoleCsp) console.log('    console  ', x);
    for (const x of consoleErrors) console.log('    error    ', x);
    for (const x of problems) console.log('    problem  ', x);
    for (const x of notes) console.log('    note     ', x);
    await ctx.close();
  }
  await browser.close();
}
process.exit(bad ? 1 : 0);
