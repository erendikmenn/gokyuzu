// "Yenilikler" card in the main menu: on a return visit, what changed since the player's last visit (src/data/changelog.json,
// Turkish; the lead adds an entry per release: { "id": "YYYY-MM-DD", "title": "…", "items": ["…", …] }, newest anywhere
// in the list). Small, dismissible (Tamam / ✕ / Esc), over the aircraft description (desktop; phones: a card at the top),
// never over the "Uç" button or the missions buttons; shown once per new entry (the newest id
// is stored in localStorage `gokyuzu.seen` when it shows). Logic: src/retention/news.js. Lazily imported by src/ui/menu.js.
//
//   showWhatsNew(root, { touch }) → boolean (shown)
// Telemetry `news`: show (id = the newest entry, c = entries shown), close.
import CHANGELOG from '../data/changelog.json' with { type: 'json' };
import { injectCSS } from '../ui/styles.js';
import { el } from '../ui/util.js';
import { trackEvent } from '../core/telemetry.js';
import { pendingNews, SEEN_KEY, RETURNING_KEYS } from './news.js';

const CSS = `
.gkr-news { position: absolute; z-index: 6; left: calc(40 * var(--u1)); top: calc(330 * var(--u1)); width: calc(480 * var(--u1)); box-sizing: border-box;
  padding: calc(14 * var(--u1)) calc(16 * var(--u1)) calc(12 * var(--u1)); border-radius: calc(16 * var(--u1)); font-family: var(--gk-sans); color: var(--gk-fg);
  background: linear-gradient(180deg, rgb(18, 30, 50), rgb(7, 12, 22)); border: 1px solid rgba(92, 242, 200, .35);
  box-shadow: 0 20px 50px rgba(0, 0, 0, .45); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); animation: gkr-news-in .45s .3s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes gkr-news-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
.gkr-news-h { display: flex; align-items: center; gap: 8px; }
.gkr-news-h i { font-style: normal; font-size: calc(10.5 * var(--u1)); font-weight: 800; letter-spacing: .18em; text-transform: uppercase; color: var(--gk-teal); }
.gkr-news-h button { margin-left: auto; width: 30px; height: 30px; border-radius: 8px; border: 0; cursor: pointer; background: rgba(255, 255, 255, .08); color: var(--gk-dim) !important; font: 700 13px var(--gk-sans) !important; }
.gkr-news h3 { margin: 4px 0 6px; font-size: calc(16.5 * var(--u1)); font-weight: 800; letter-spacing: -.01em; }
.gkr-news ul { margin: 0 0 4px; padding-left: 18px; }
.gkr-news li { margin: 3px 0; font-size: calc(13 * var(--u1)); line-height: 1.42; color: rgba(226, 236, 250, .88); }
.gkr-news .ok { display: block; margin: 10px 0 0 auto; padding: 7px 16px; border-radius: 10px; border: 0; cursor: pointer; font: 750 13px var(--gk-sans) !important;
  color: #04140f !important; background: var(--gk-teal); }
.gkm.gkm-touch .gkr-news { left: 50%; top: max(8px, env(safe-area-inset-top)); width: min(420px, calc(100vw - 20px)); max-height: calc(100% - 16px); overflow-y: auto;
  transform: translateX(-50%); animation: none; padding: 12px 14px 10px; }
.gkm.gkm-touch .gkr-news h3 { font-size: 15px; } .gkm.gkm-touch .gkr-news li { font-size: 12.5px; } .gkm.gkm-touch .gkr-news-h i { font-size: 10px; }
`;

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

/** The card on a return visit with news; else just remembers the newest entry. */
export function showWhatsNew(root, { touch = false } = {}) {
  const seen = read(SEEN_KEY);
  const returning = RETURNING_KEYS.some((k) => read(k) !== null);
  const { show, latest } = pendingNews(CHANGELOG && CHANGELOG.entries, seen, returning);
  if (latest && latest !== seen) { try { localStorage.setItem(SEEN_KEY, latest); } catch { /* private mode */ } }
  if (!show.length || !root.isConnected) return false;
  injectCSS('retention-news', CSS);
  const card = el('div', 'gkr-news', root);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Yenilikler');
  const h = el('div', 'gkr-news-h', card);
  el('i', null, h, 'Yenilikler');
  const x = el('button', null, h, '✕');
  x.type = 'button'; x.title = 'Kapat';
  let items = 0;
  for (const e of show) {
    el('h3', null, card, e.title || 'Yeni sürüm');
    const ul = el('ul', null, card);
    for (const it of e.items.slice(0, 6)) { el('li', null, ul, String(it)); items++; }
    if (items >= 8) break;
  }
  const ok = el('button', 'ok', card, 'Tamam');
  ok.type = 'button';
  if (!touch) {   // over the aircraft description (the start of the hero row): clear of the title, the streak, the missions buttons and the map
    const hero = root.querySelector('.gkm-hero'), hr = hero && hero.getBoundingClientRect(), rr = root.getBoundingClientRect();
    if (hr && hr.height > 0) { card.style.left = `${Math.round(hr.left - rr.left)}px`; card.style.top = `${Math.round(hr.top - rr.top)}px`; }
  }
  const close = () => {
    if (!card.isConnected) return;
    card.remove();
    removeEventListener('keydown', onKey, true);
    trackEvent('news', { st: 'close' });
  };
  function onKey(e) {
    if (!card.isConnected) { removeEventListener('keydown', onKey, true); return; }   // (the menu closed)
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  x.addEventListener('click', close);
  ok.addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  trackEvent('news', { st: 'show', id: latest, c: show.length });
  return true;
}
