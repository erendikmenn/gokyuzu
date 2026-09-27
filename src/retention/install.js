// "Ana ekrana ekle": after a good moment on a phone or tablet (a mission finished, a landing with 2+ stars) the game
// suggests adding itself to the home screen, at most once every 14 days and never again once installed.
//   Android / Chrome: the browser's own install dialog (the `beforeinstallprompt` event, kept here from page load; the
//   site is installable from manifest.json alone: no service worker, so nothing is cached and the asset versioning of
//   CONTRACTS-SF.md §9 is untouched).
//   iOS (Safari, and Chrome since iOS 16.4): there is no install API, so a two-step how-to (Paylaş → Ana Ekrana Ekle).
// Never in social-app webviews (they cannot install), never when the game already runs from the home screen.
// This module is imported by the menu (src/ui/menu.js) so the listener exists before Chrome fires the event; the UI is
// built only when suggestInstall() is called.
//
//   suggestInstall({ via, inline, mount, delay }) → boolean (shown)
//     inline: an element to append a compact row to (the mission result card); else a floating card through
//     mount(node) (the HUD layer) at the top centre, hidden after 15 s
// Telemetry `inst`: show (p = android | ios, via = mission | land), accept / dismiss (the browser dialog's answer), later
// (Şimdi değil / Tamam), installed (the browser's appinstalled event).
import { injectCSS } from '../ui/styles.js';
import { el } from '../ui/util.js';
import { inAppBrowser } from '../ui/touch-env.js';
import { trackEvent } from '../core/telemetry.js';

const KEY = 'gokyuzu.install';
export const INSTALL_EVERY = 14 * 86400e3;
let deferred = null;

function read() { try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && typeof s === 'object' ? s : {}; } catch { return {}; } }
function write(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

if (typeof window !== 'undefined') {
  // keep Chrome's install prompt for a good moment instead of its automatic mini-infobar
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
  addEventListener('appinstalled', () => { deferred = null; write({ ...read(), installed: Date.now() }); trackEvent('inst', { st: 'installed' }); });
}

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Running from the home screen (an installed web app), not a fullscreen tab (the game enters fullscreen on phones). */
function standalone() {
  try {
    if (navigator.standalone === true || matchMedia('(display-mode: standalone)').matches) return true;
    return matchMedia('(display-mode: fullscreen)').matches && !document.fullscreenElement && !document.webkitFullscreenElement;
  } catch { return false; }
}
/** 'android' (the browser offered its install dialog) | 'ios' (the how-to) | null (no way to install here). */
export function installPlatform() {
  if (typeof window === 'undefined' || standalone()) return null;
  try { if (inAppBrowser()) return null; } catch { /* unknown: go on */ }
  if (deferred) return 'android';
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  return touch && isIOS() ? 'ios' : null;
}
/** May the suggestion show now (platform, not installed, the 14-day pause)? */
export function installEligible(now = Date.now()) {
  const s = read();
  if (s.installed || s.accepted) return null;
  if (s.shown && now - s.shown < INSTALL_EVERY) return null;
  return installPlatform();
}

const CSS = `
.gkr-inst { display: flex; align-items: center; gap: 10px; box-sizing: border-box; padding: 9px 10px 9px 12px; border-radius: 13px; font-family: var(--gk-sans);
  color: var(--gk-fg); border: 1px solid rgba(92, 242, 200, .4); background: linear-gradient(120deg, rgba(92, 242, 200, .14), rgba(16, 26, 42, .9)); text-align: left; }
.gkr-inst > svg { width: 26px; height: 26px; flex: 0 0 auto; color: var(--gk-teal); }
.gkr-inst-t { min-width: 0; flex: 1 1 auto; }
.gkr-inst-t b { display: block; font-size: 13.5px; font-weight: 750; line-height: 1.2; }
.gkr-inst-t small { display: block; margin-top: 2px; font-size: 11.5px; line-height: 1.35; color: var(--gk-dim); }
.gkr-inst-t small em { font-style: normal; color: var(--gk-fg); font-weight: 650; }
.gkr-inst-b { display: flex; gap: 6px; flex: 0 0 auto; }
.gkr-inst button { min-height: 34px; padding: 5px 11px; border-radius: 9px; cursor: pointer; font: 700 12.5px var(--gk-sans); color: var(--gk-fg);
  border: 1px solid rgba(255, 255, 255, .18); background: rgba(255, 255, 255, .07); }
.gkr-inst button.go { color: #04140f; background: var(--gk-teal); border-color: transparent; }
.gkr-inst-float { position: absolute; left: 50%; top: calc(var(--gkx-top, 60px) + var(--gkm-strip-h, 0px)); transform: translate(-50%, -6px); z-index: 4;
  width: min(340px, calc(100vw - 24px)); pointer-events: auto; opacity: 0; transition: opacity .25s ease, transform .3s ease;
  box-shadow: 0 12px 32px rgba(0, 0, 0, .35); background: linear-gradient(120deg, rgba(20, 60, 56, .96), rgba(10, 16, 28, .96)); }
.gkr-inst-float.on { opacity: 1; transform: translate(-50%, 0); }
`;
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M12 7v7M9 11l3 3 3-3M10 18h4"/></svg>';

/** Show the suggestion if allowed now. */
export function suggestInstall({ via = 'mission', inline = null, mount = null } = {}) {
  const p = installEligible();
  if (!p) return false;
  injectCSS('retention-install', CSS);
  const box = el('div', `gkr-inst${inline ? '' : ' gkr-inst-float'}`);
  box.setAttribute('role', 'status');
  box.insertAdjacentHTML('afterbegin', ICON);
  const t = el('div', 'gkr-inst-t', box);
  const btns = el('div', 'gkr-inst-b', box);
  const btn = (label, cls, fn) => { const b = el('button', cls, btns, label); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
  let hideT = 0;
  const close = () => { clearTimeout(hideT); box.classList.remove('on'); setTimeout(() => box.remove(), inline ? 0 : 300); };
  if (p === 'android') {
    el('b', null, t, 'Ana ekrana ekle');
    el('small', null, t, 'Gökyüzü tek dokunuşla, tam ekran açılsın.');
    btn('Ekle', 'go', () => {
      const d = deferred;
      deferred = null;
      close();
      if (!d) return;
      try {
        d.prompt();
        Promise.resolve(d.userChoice).then((c) => {
          const ok = c && c.outcome === 'accepted';
          if (ok) write({ ...read(), accepted: Date.now() });
          trackEvent('inst', { st: ok ? 'accept' : 'dismiss' });
        }).catch(() => {});
      } catch { /* the event expired */ }
    });
    btn('Şimdi değil', '', () => { trackEvent('inst', { st: 'later' }); close(); });
  } else {
    el('b', null, t, 'Ana ekrana ekle');
    const sm = el('small', null, t, 'Tarayıcının ');
    el('em', null, sm, 'Paylaş');
    sm.append(' menüsünden ');
    el('em', null, sm, 'Ana Ekrana Ekle');
    sm.append('’yi seç: Gökyüzü tek dokunuşla açılır.');
    btn('Tamam', '', () => { trackEvent('inst', { st: 'later' }); close(); });
  }
  if (inline) inline.appendChild(box);
  else if (mount) mount(box);
  else document.body.appendChild(box);
  if (!inline) { requestAnimationFrame(() => box.classList.add('on')); hideT = setTimeout(close, 15000); }
  write({ ...read(), shown: Date.now() });
  trackEvent('inst', { st: 'show', p, via });
  return true;
}
