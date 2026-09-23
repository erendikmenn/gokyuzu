// Start gate for phones, tablets and old browsers (main.js awaits it before creating the renderer, so nothing of the
// 3D world is downloaded): when the device cannot run the game (src/ui/touch-env.js gateCheck: no WebGL 2, a phone below
// the minimum of the mobile caps, a very weak mobile GPU) a friendly "bilgisayardan gir" screen with the link to copy /
// share. Soft reasons offer "Yine de dene" (remembered for the tab session); no WebGL 2 cannot start at all.
// The X / Instagram / Facebook webviews on iOS (they drop the WebGL context within seconds, docs/errors/audit.md #2) get
// "Oyunu Safari'de aç" as the way in, and again instead of a reload after a context loss (showInAppFailure).
// Also the small "Tarayıcıda aç" banner for other social-app in-app browsers (menu) and the link helpers.
// Anonymous telemetry: 'gate' { r: reason, x: 'try' when the player continues anyway } (CONTRACTS-SF.md §11).
import { injectCSS, BASE_CSS } from './styles.js';
import { el } from './util.js';
import { gateCheck, inAppBrowser, mobileOS, inBadInAppBrowser } from './touch-env.js';
import { trackEvent } from '../core/telemetry.js';

const OK_KEY = 'gokyuzu.gateOk';
const BANNER_KEY = 'gokyuzu.iabHint';

const CSS = `
.gkg { position: fixed; inset: 0; z-index: 80; overflow: auto; display: flex; align-items: center; justify-content: center;
  padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
  font-family: var(--gk-sans); color: var(--gk-fg); -webkit-font-smoothing: antialiased; pointer-events: auto; box-sizing: border-box;
  background: radial-gradient(ellipse 90% 70% at 50% 30%, #1a2a48 0%, #0a1223 58%, #04070d 100%); -webkit-user-select: none; user-select: none; }
.gkg * { box-sizing: border-box; }
.gkg-card { width: min(100%, 520px); display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; margin: auto; }
.gkg-art { width: 132px; height: 88px; }
.gkg h1 { margin: 0; font-family: var(--gk-display); font-size: 34px; font-weight: 800; letter-spacing: -.03em;
  background: linear-gradient(180deg, #fff 30%, #ffd9bf); -webkit-background-clip: text; background-clip: text; color: transparent; }
.gkg h2 { margin: 0; font-size: 20px; font-weight: 750; letter-spacing: -.01em; text-wrap: balance; }
.gkg p { margin: 0; font-size: 15px; line-height: 1.5; color: rgba(226, 236, 250, .84); text-wrap: pretty; }
.gkg-link { display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 4px; padding: 12px 14px; border-radius: 14px;
  background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .14); }
.gkg-link svg { flex: 0 0 auto; width: 20px; height: 20px; color: var(--gk-teal); }
.gkg-link span { flex: 1 1 auto; min-width: 0; font: 650 16px var(--gk-mono); color: #fff; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  -webkit-user-select: all; user-select: all; }
.gkg-btns { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; width: 100%; }
.gkg-btn { flex: 1 1 180px; min-height: 50px; padding: 12px 18px; border-radius: 14px; border: 0; cursor: pointer; font: 750 16px var(--gk-sans);
  color: #1c0e06; background: linear-gradient(135deg, #ff5d33 0%, #ff8a45 60%, #ffb257 100%); box-shadow: 0 12px 30px rgba(255, 96, 50, .32);
  -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.gkg-btn.sec { color: var(--gk-fg); background: rgba(255, 255, 255, .08); border: 1px solid rgba(255, 255, 255, .18); box-shadow: none; }
.gkg-btn:active { transform: scale(.98); }
.gkg-how { font-size: 14px !important; padding: 10px 14px; border-radius: 12px; background: rgba(92, 242, 200, .07); border: 1px solid rgba(92, 242, 200, .25); }
.gkg-how b { color: var(--gk-teal); }
.gkg-ok { min-height: 18px; font-size: 13px; font-weight: 650; color: var(--gk-teal); }
.gkg-try { margin-top: 2px; padding: 10px 14px; border: 0; background: none; cursor: pointer; font: 600 14px var(--gk-sans); color: var(--gk-dim);
  text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(208, 222, 240, .3); touch-action: manipulation; }
.gkg small { font-size: 12px; line-height: 1.5; color: rgba(208, 222, 240, .5); }
@media (max-height: 460px) and (orientation: landscape) {
  .gkg-card { width: min(100%, 760px); display: grid; grid-template-columns: 150px 1fr; column-gap: 26px; row-gap: 10px; text-align: left; align-items: start; }
  .gkg-card > * { grid-column: 2; }
  .gkg-art { grid-column: 1; grid-row: 1 / span 6; width: 150px; height: 100px; align-self: center; }
  .gkg h1 { font-size: 26px; }
  .gkg-btns { justify-content: flex-start; }
}

/* in-app browser banner (menu) */
.gkg-iab { position: absolute; z-index: 6; left: 50%; top: max(10px, env(safe-area-inset-top)); transform: translateX(-50%); width: max-content; max-width: calc(100% - 24px);
  display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 14px; font: 600 13px/1.35 var(--gk-sans); color: var(--gk-fg);
  background: rgba(8, 14, 26, .88); border: 1px solid rgba(92, 242, 200, .35); box-shadow: 0 12px 34px rgba(0, 0, 0, .4);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); animation: gkg-in .35s cubic-bezier(.2, .9, .3, 1.1) both; }
@keyframes gkg-in { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translateX(-50%); } }
.gkg-iab b { color: var(--gk-teal); }
.gkg-iab button { flex: 0 0 auto; min-height: 34px; padding: 6px 12px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .08);
  color: var(--gk-fg); font: 700 12.5px var(--gk-sans); cursor: pointer; touch-action: manipulation; }
.gkg-iab button.x { padding: 6px 10px; border: 0; background: none; color: var(--gk-dim); font-size: 16px; }
`;

const ART = '<svg class="gkg-art" viewBox="0 0 132 88" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="18" y="8" width="96" height="60" rx="5" stroke="#9ec2ff" stroke-width="2.4"/><path d="M50 80h32M66 68v12" stroke="#9ec2ff" stroke-width="2.4"/>'
  + '<path d="M34 50c10-14 22-20 34-20s22 6 30 16" stroke="#ff9a6a" stroke-width="2"/><path d="M42 30v22M90 30v22M36 52h60" stroke="#ff9a6a" stroke-width="2"/>'
  + '<path d="M70 20l6-2 8 4-9 1-3 3h-2l1-4-5-1z" fill="#5cf2c8" stroke="none"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>';

const TEXT = {
  webgl2: ['Bu tarayıcı oyunu çalıştıramıyor', 'Tarayıcın WebGL 2 desteklemiyor; San Francisco Körfezi’nin 3B dünyası onsuz çizilemez. Güncel bir tarayıcıyla ya da bir bilgisayardan gir.'],
  memory: ['Bu telefon oyun için zayıf kalıyor', 'Telefonun belleği 3B körfez dünyası için yetersiz; oyun yüklenirken kapanabilir. En iyi deneyim için bilgisayardan gir.'],
  gpu: ['Bu cihazın ekran kartı yetersiz', 'Cihazın grafik işlemcisi 3B dünyayı akıcı çizmek için fazla zayıf görünüyor. En iyi deneyim için bilgisayardan gir.'],
  software: ['Grafik hızlandırma kapalı', 'Tarayıcı ekran kartını kullanamıyor, 3B dünya yazılımla çizilecek kadar yavaş olur. En iyi deneyim için bilgisayardan gir.'],
  iab: ['Oyunu Safari’de aç', '{app} uygulamasının içindeki tarayıcı 3B grafikleri birkaç saniye içinde kapatıyor. Safari’de oyun sorunsuz çalışır.'],
  'iab-lost': ['Grafikler kapandı', '{app} uygulamasının içindeki tarayıcı 3B grafikleri kapattı; yeniden denemek büyük ihtimalle aynı yere varır. Oyunu Safari’de aç.'],
};
// where the "open in browser" item sits in each app's in-app browser (iOS)
const IAB_MENU = { x: '••• menüsü → «Safari’de aç»', instagram: '••• menüsü → «Harici tarayıcıda aç»', facebook: '••• menüsü → «Harici tarayıcıda aç»' };

/** The game's link without query parameters (what to open on the computer). */
export function gameLink() { return `${location.origin}${location.pathname.replace(/index\.html$/, '')}`; }

/** Copy text to the clipboard (Clipboard API, then the execCommand fallback of older webviews). */
export async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

/** Android: open the page in Chrome from a webview (intent URL; ignored where the webview does not handle it). */
export function chromeIntentUrl(url = location.href) {
  const u = new URL(url);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

/**
 * Run the gate. Resolves right away when the device can play; otherwise shows the screen and resolves only when the
 * player chooses "Yine de dene" (soft reasons) — a hard failure never resolves, so the caller stops before the world.
 */
export function runDeviceGate(container = document.body) {
  let g;
  try { g = gateCheck(); } catch { g = { ok: true }; }
  if (g.ok) return Promise.resolve(g);
  let seen = null;
  try { seen = sessionStorage.getItem(OK_KEY); } catch { /* private mode */ }
  if (g.soft && seen) return Promise.resolve(g);
  const iab = inAppBrowser();
  trackEvent('gate', { r: g.reason, dev: g.kind || '', iab: iab ? iab.id : '', gpu: (g.gpu || '').slice(0, 40) });
  return new Promise((resolve) => {
    showGateScreen(container, g.reason, {
      tryLabel: g.soft ? (g.reason === 'iab' ? 'Yine de burada dene' : 'Yine de dene (düşük grafikle)') : null,
      onTry: () => { try { sessionStorage.setItem(OK_KEY, '1'); } catch { /* private mode */ } resolve(g); },
    });
  });
}

/**
 * After a WebGL context loss inside the X / Instagram / Facebook webview (src/core/gpu-guard.js): offer the real browser
 * instead of a reload that fails the same way; `retry` (reload into the saved flight) stays as the small option.
 * Returns false (nothing shown) outside those webviews.
 */
export function showInAppFailure(retry) {
  if (!inBadInAppBrowser()) return false;
  showGateScreen(document.body, 'iab-lost', { tryLabel: 'Yeniden dene', onTry: retry, keep: true });
  return true;
}

function showGateScreen(container, reason, { tryLabel = null, onTry = null, keep = false } = {}) {
  injectCSS('base', BASE_CSS);
  injectCSS('gate', CSS);
  const iab = inAppBrowser() || (reason.startsWith('iab') ? { id: 'x', name: 'X', os: 'ios' } : null);
  const inApp = reason === 'iab' || reason === 'iab-lost';
  const root = el('div', 'gkg', container);
  root.setAttribute('lang', 'tr');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Gökyüzü');
  const card = el('div', 'gkg-card', root);
  card.insertAdjacentHTML('beforeend', ART);
  el('h1', null, card, 'Gökyüzü');
  const [title, text] = TEXT[reason] || TEXT.gpu;
  el('h2', null, card, title);
  el('p', null, card, text.replace('{app}', iab ? iab.name : 'Bu'));
  if (iab && reason === 'webgl2') el('p', null, card, `${iab.name} içindeki tarayıcıdasın: menüden «Tarayıcıda aç» seçip ${iab.os === 'ios' ? 'Safari' : 'Chrome'} ile de deneyebilirsin.`);
  const url = gameLink();
  const okLine = el('div', 'gkg-ok', null, '');
  okLine.setAttribute('role', 'status');
  if (inApp) {
    const how = el('p', 'gkg-how', card, '');
    el('b', null, how, 'Nasıl: ');
    how.append(`${IAB_MENU[iab && iab.id] || '••• menüsü → «Tarayıcıda aç»'}, ya da bağlantıyı kopyalayıp Safari’ye yapıştır.`);
  } else {
    const link = el('div', 'gkg-link', card);
    link.insertAdjacentHTML('beforeend', LINK_ICON);
    el('span', null, link, url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  }
  const btns = el('div', 'gkg-btns', card);
  if (inApp) {
    // iOS 17+ hands x-safari-https:// links from in-app browsers to Safari; where it does nothing the steps above remain
    const open = el('button', 'gkg-btn', btns, 'Safari’de aç');
    open.type = 'button';
    open.addEventListener('click', () => {
      trackEvent('gate', { r: reason, x: 'safari' });
      location.href = `x-safari-${location.href.split('#')[0]}`;
      setTimeout(() => { if (!document.hidden) okLine.textContent = 'Açılmadıysa yukarıdaki adımları izle.'; }, 1500);
    });
  }
  const copyBtn = el('button', inApp ? 'gkg-btn sec' : 'gkg-btn', btns, 'Bağlantıyı kopyala');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(url);
    okLine.textContent = ok ? (inApp ? 'Kopyalandı! Safari’yi açıp adres çubuğuna yapıştır.' : 'Kopyalandı! Bilgisayarında tarayıcıya yapıştır.') : `Kopyalanamadı: adres ${url}`;
    trackEvent('gate', { r: reason, x: ok ? 'copy' : 'copyfail' });
  });
  if (navigator.share && !inApp) {
    const shareBtn = el('button', 'gkg-btn sec', btns, 'Kendine gönder');
    shareBtn.type = 'button';
    shareBtn.addEventListener('click', () => {
      navigator.share({ title: 'Gökyüzü · San Francisco uçuş simülatörü', text: 'Bilgisayarda açılacak uçuş simülatörü:', url })
        .then(() => trackEvent('gate', { r: reason, x: 'share' })).catch(() => {});
    });
  }
  card.appendChild(okLine);
  if (tryLabel && onTry) {
    const tryBtn = el('button', 'gkg-try', card, tryLabel);
    tryBtn.type = 'button';
    tryBtn.addEventListener('click', () => {
      trackEvent('gate', { r: reason, x: 'try' });
      if (!keep) root.remove();
      onTry();
    });
  }
  el('small', null, card, inApp ? 'Gökyüzü: San Francisco Körfezi uçuş simülatörü · telefonda dokunmatik kontrollerle, bilgisayarda klavye ya da oyun koluyla oynanır.'
    : 'Gökyüzü bilgisayarda klavye, fare ya da oyun koluyla; güçlü telefon ve tabletlerde dokunmatik kontrollerle oynanır.');
  return root;
}

/**
 * "Tarayıcıda aç" banner for social-app webviews (no fullscreen, no motion-sensor permission, a smaller screen under the
 * app's toolbars). Once per browser session; returns the element or null.
 */
export function showInAppHint(parent) {
  const iab = inAppBrowser();
  if (!iab) return null;
  try { if (sessionStorage.getItem(BANNER_KEY)) return null; } catch { /* ignore */ }
  injectCSS('base', BASE_CSS);
  injectCSS('gate', CSS);
  const box = el('div', 'gkg-iab', parent);
  box.setAttribute('role', 'note');
  box.setAttribute('lang', 'tr');
  const t = el('span', null, box);
  const browser = iab.os === 'ios' ? 'Safari' : 'Chrome';
  el('b', null, t, 'İpucu: ');
  t.append(`${iab.os === 'ios' ? '•••' : '⋮'} menüsünden «Tarayıcıda aç» ile ${browser}’de tam ekran ve eğimle kumanda.`);
  const close = () => { try { sessionStorage.setItem(BANNER_KEY, '1'); } catch { /* ignore */ } box.remove(); };
  if (mobileOS() === 'android') {
    const b = el('button', null, box, 'Chrome’da aç');
    b.type = 'button';
    b.addEventListener('click', () => { trackEvent('iab', { id: iab.id, x: 'chrome' }); location.href = chromeIntentUrl(); });
  } else {
    const b = el('button', null, box, 'Bağlantıyı kopyala');
    b.type = 'button';
    b.addEventListener('click', async () => { const ok = await copyText(gameLink()); b.textContent = ok ? 'Kopyalandı' : 'Kopyalanamadı'; trackEvent('iab', { id: iab.id, x: 'copy' }); });
  }
  const x = el('button', 'x', box, '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Kapat');
  x.addEventListener('click', close);
  return box;
}
