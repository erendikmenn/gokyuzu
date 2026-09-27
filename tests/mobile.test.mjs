// Phones, tablets and social-app webviews: touch-only detection (Android phones whose pointer media queries report a
// fine pointer), the pointer tag of the telemetry, in-app browser user agents, the webview → browser hand-off address and
// the browser intent link. The screens themselves are covered by the Playwright checks.
// Run: node tests/mobile.test.mjs   (no framework, no network: PASS/FAIL table, exit 1 on failure)
import { isTouchOnly, pointerTag, inAppBrowser, mobileOS } from '../src/ui/touch-env.js';
import { handoffUrl, browserIntentUrl } from '../src/ui/touch-gate.js';

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

// user agents as live telemetry saw them (device models generic)
const UA = {
  xAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 TwitterAndroid-prod.01',
  xIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidTab: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  instaAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.178 Mobile Safari/537.36 Instagram 317.0.0.34.109 Android (34/14; 420dpi; 1080x2205; Google/google; Pixel 7; panther; panther; en_US; 562739837)',
  fbIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;FBBV/620000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/tr_TR;FBOP/5]',
  tiktok: 'Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 musical_ly_2023207030 BytedanceWebview/d8a21c6',
  wv: 'Mozilla/5.0 (Linux; Android 13; M2101K6G Build/TKQ1.221013.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.146 Mobile Safari/537.36',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};
/** Media queries answering like a device: primary pointer, any fine pointer, any hover. */
const media = ({ pointer = 'coarse', anyFine = false, anyHover = false } = {}) => (q) => ({
  '(pointer: coarse)': pointer === 'coarse', '(pointer: fine)': pointer === 'fine', '(any-pointer: fine)': anyFine, '(any-hover: hover)': anyHover,
})[q] || false;
const env = (ua, touchPoints, m) => ({ ua, touchPoints, touchEvents: touchPoints > 0, mm: media(m) });
const SAMSUNG_MQ = { pointer: 'fine', anyFine: true, anyHover: true };   // what Chromium reports once any fine-pointer device is listed

// ---- touch-only detection ----
check('touch: Samsung phone in the X webview reporting a fine pointer → touch', isTouchOnly(env(UA.xAndroid, 5, SAMSUNG_MQ)));
check('touch: Samsung Internet / Chrome on Android reporting a fine pointer → touch', isTouchOnly(env(UA.samsung, 5, SAMSUNG_MQ)) && isTouchOnly(env(UA.chromeAndroid, 5, SAMSUNG_MQ)));
check('touch: Android phone with honest media queries → touch', isTouchOnly(env(UA.chromeAndroid, 5, {})));
check('touch: Android tablet (no "Mobile") reporting a fine pointer → touch', isTouchOnly(env(UA.androidTab, 10, SAMSUNG_MQ)));
check('touch: iPhone → touch (even with odd media queries)', isTouchOnly(env(UA.safari, 5, {})) && isTouchOnly(env(UA.xIOS, 5, SAMSUNG_MQ)));
check('touch: iPad without keyboard (coarse, no fine) → touch', isTouchOnly(env(UA.ipad, 5, {})));
check('touch: iPad with a trackpad (any fine pointer) → hybrid (not touch-only)', !isTouchOnly(env(UA.ipad, 5, { pointer: 'fine', anyFine: true, anyHover: true })));
check('touch: Windows touch laptop (fine pointer) → not touch-only (PC unchanged)', !isTouchOnly(env(UA.windows, 10, { pointer: 'fine', anyFine: true, anyHover: true })));
check('touch: Windows tablet mode, coarse and no fine pointer → touch-only (unchanged rule)', isTouchOnly(env(UA.windows, 10, {})));
check('touch: desktop without touch → not touch-only', !isTouchOnly(env(UA.mac, 0, { pointer: 'fine', anyFine: true, anyHover: true })) && !isTouchOnly(env(UA.windows, 0, {})));
check('touch: Android without any touch input → not touch-only', !isTouchOnly({ ua: UA.androidTab, touchPoints: 0, touchEvents: false, mm: media(SAMSUNG_MQ) }));
check('touch: a throwing matchMedia never throws out', isTouchOnly({ ua: UA.windows, touchPoints: 1, touchEvents: true, mm: () => { throw new Error('x'); } }) === false);

// ---- pointer tag (telemetry ptr) ----
check('ptr: honest phone "c", Samsung-style "fFh", trackpad iPad "fFh", no pointer "n"',
  pointerTag(media({})) === 'c' && pointerTag(media(SAMSUNG_MQ)) === 'fFh' && pointerTag(media({ pointer: 'none' })) === 'n' && pointerTag(media({ pointer: 'coarse', anyFine: true })) === 'cF');

// ---- in-app browsers ----
const iab = (ua) => { const r = inAppBrowser(ua); return r ? `${r.id}/${r.os}` : null; };
check('iab: X on Android (TwitterAndroid, a WebView) → x/android', iab(UA.xAndroid) === 'x/android', iab(UA.xAndroid));
check('iab: X on iPhone → x/ios', iab(UA.xIOS) === 'x/ios');
check('iab: Instagram Android, Facebook iOS, TikTok → their ids', iab(UA.instaAndroid) === 'instagram/android' && iab(UA.fbIOS) === 'facebook/ios' && iab(UA.tiktok) === 'tiktok/android');
check('iab: another app\'s WebView ("; wv)") → webview', iab(UA.wv) === 'webview/android');
check('iab: Chrome, Samsung Internet, Safari, desktop → none', [UA.chromeAndroid, UA.samsung, UA.safari, UA.windows, UA.mac].every((u) => inAppBrowser(u) === null));
check('os: Android / iOS / other', mobileOS(UA.xAndroid) === 'android' && mobileOS(UA.xIOS) === 'ios' && mobileOS(UA.windows) === 'other');

// ---- hand-off address ----
{
  const base = 'https://fs.example/?mission=climb&challenge=2500#x';
  const inApp = handoffUrl(base, 'x');
  check('handoff: inside the X webview the address gets from=x, other parameters and the hash kept',
    inApp.url === 'https://fs.example/?mission=climb&challenge=2500&from=x#x' && inApp.from === '', inApp.url);
  check('handoff: already marked → unchanged (no replaceState)', handoffUrl(inApp.url, 'x').url === null);
  const out = handoffUrl(inApp.url, '');
  check('handoff: in the browser from=x is read and removed', out.from === 'x' && out.url === base, out.url);
  check('handoff: an unknown value is removed but not counted', (() => { const r = handoffUrl('https://fs.example/?from=evil', ''); return r.from === '' && r.url === 'https://fs.example/'; })());
  check('handoff: no parameter in the browser → nothing to do', handoffUrl('https://fs.example/?aircraft=f16', '').url === null);
  check('handoff: another app re-marks the address', handoffUrl('https://fs.example/?from=x', 'instagram').url === 'https://fs.example/?from=instagram');
  const intent = browserIntentUrl(inApp.url);
  check('intent: the browser intent link carries the marked address and the https fallback, no browser package (default browser)',
    intent.startsWith('intent://fs.example/?mission=climb&challenge=2500&from=x#Intent;scheme=https;') && intent.endsWith(';end')
    && intent.includes('S.browser_fallback_url=https%3A%2F%2Ffs.example%2F') && !intent.includes('package='), intent);
}

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
