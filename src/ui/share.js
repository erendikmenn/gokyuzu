// Share card (CONTRACTS-SF.md §12): after a mission or a good landing, "Paylaş" renders a small image of the result
// (canvas 1200×630: optional snapshot of the view, title, stars, score) and shares it — the Web Share API on phones
// (with the image file where supported), on desktops an X / Twitter intent URL with the text + link, "Bağlantıyı
// kopyala" and "Görseli indir". The link is a deep link (?mission=<id>, &daily=YYYYMMDD) so friends play the same
// mission. No third-party scripts; the only external address is the intent URL the player opens themself.
// Telemetry: `share` { id, via }. Lazily imported on the first "Paylaş".
//
//   const h = prepareMission({ id, day, title, aircraft, ok, score, stars, time, snapshot })   // when the result shows
//   h.run(anchorButton)                                                                      // on the tap
//   prepareLanding(card, { aircraft }).run(anchor)
import { injectCSS } from './styles.js';
import { el } from './util.js';
import { trackEvent } from '../core/telemetry.js';

const W = 1200, H = 630;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const CSS = `
.gks-pop { position: fixed; z-index: 60; display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 14px; min-width: 220px;
  background: linear-gradient(180deg, rgba(16, 26, 42, .96), rgba(6, 11, 20, .96)); border: 1px solid rgba(255, 255, 255, .16);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .5); font-family: var(--gk-sans, sans-serif); color: #eef4ff; animation: gks-in .18s ease both; }
@keyframes gks-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.gks-pop img { width: 100%; max-width: 300px; border-radius: 8px; margin-bottom: 4px; display: block; }
.gks-pop button, .gks-pop a { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 9px; border: 0; background: transparent; color: inherit;
  font: 650 14px var(--gk-sans, sans-serif); cursor: pointer; text-decoration: none; text-align: left; }
.gks-pop button:hover, .gks-pop a:hover { background: rgba(255, 255, 255, .09); }
.gks-pop svg { width: 16px; height: 16px; flex: 0 0 auto; }
.gks-pop small { padding: 2px 12px 4px; font-size: 11.5px; color: rgba(208, 222, 240, .64); }
`;
const ICON = {
  x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.9 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.3 4.7H5.5z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
};

/** Deep link to a mission (same origin and path as this page: staging links stay on staging); other maps: ?map=<id>. */
export function missionLink(id, day = null, map = null) {
  const u = new URL(location.pathname, location.origin);
  if (!id && map && map.id !== 'sf') u.searchParams.set('map', map.id);   // (a mission id names its map itself)
  if (id) u.searchParams.set('mission', id);
  if (id && day) u.searchParams.set('daily', day);
  return u.href;
}

function star(ctx, cx, cy, r, fill) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
function fit(ctx, text, max, size, weight = 800, family = FONT) {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${family}`; s -= 2; } while (ctx.measureText(text).width > max && s > 18);
}

/** Result card image → canvas. d = { kicker, title, stars, big, bigSub, lines: [[label, value]], link, snapshot() } */
export function renderCard(d) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  // background: the current view (optional) under a dark gradient, else the menu's dusk colours
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0b1830'); g.addColorStop(0.55, '#43406a'); g.addColorStop(0.8, '#e0845f'); g.addColorStop(1, '#1d2338');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  let snap = null;
  try { snap = d.snapshot ? d.snapshot() : null; } catch { snap = null; }
  if (snap && snap.width > 16 && snap.height > 16) {
    try {
      const k = Math.max(W / snap.width, H / snap.height), sw = W / k, sh = H / k;
      ctx.drawImage(snap, (snap.width - sw) / 2, (snap.height - sh) / 2, sw, sh, 0, 0, W, H);
    } catch { /* tainted / lost context: gradient only */ }
  }
  const shade = ctx.createLinearGradient(0, 0, W, 0);
  shade.addColorStop(0, 'rgba(4, 8, 16, .88)'); shade.addColorStop(0.62, 'rgba(4, 8, 16, .55)'); shade.addColorStop(1, 'rgba(4, 8, 16, .15)');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, W, H);
  // brand
  ctx.fillStyle = '#ffa24a'; ctx.font = `800 26px ${FONT}`; ctx.fillText('GÖKYÜZÜ', 64, 84);
  ctx.fillStyle = 'rgba(240, 246, 255, .7)'; ctx.font = `600 22px ${FONT}`; ctx.fillText(d.subtitle || 'San Francisco Körfezi uçuş simülatörü', 210, 84);
  // kicker + title
  ctx.fillStyle = '#5cf2c8'; ctx.font = `800 24px ${FONT}`; ctx.fillText(String(d.kicker || '').toLocaleUpperCase('tr'), 64, 170);
  ctx.fillStyle = '#ffffff'; fit(ctx, d.title || '', W - 128, 66); ctx.fillText(d.title || '', 64, 244);
  // stars + big number
  for (let i = 0; i < 3; i++) star(ctx, 100 + i * 84, 340, 36, i < (d.stars || 0) ? '#ffc94a' : 'rgba(255, 255, 255, .18)');
  ctx.fillStyle = '#ffffff'; ctx.font = `800 72px ${MONO}`; ctx.fillText(d.big || '', 360, 366);
  const bw = ctx.measureText(d.big || '').width;
  ctx.fillStyle = 'rgba(240, 246, 255, .72)'; ctx.font = `650 26px ${FONT}`; ctx.fillText(d.bigSub || '', 360 + bw + 16, 364);
  // detail lines
  let y = 452;
  for (const [label, value] of (d.lines || []).slice(0, 3)) {
    ctx.fillStyle = 'rgba(208, 222, 240, .7)'; ctx.font = `600 24px ${FONT}`; ctx.fillText(label, 64, y);
    ctx.fillStyle = '#ffffff'; ctx.font = `700 24px ${MONO}`; ctx.fillText(value, 330, y);
    y += 40;
  }
  // link
  ctx.fillStyle = 'rgba(255, 178, 87, .95)'; ctx.font = `700 24px ${FONT}`;
  ctx.fillText((d.link || '').replace(/^https?:\/\//, ''), 64, H - 40);
  return c;
}

const toBlob = (c) => new Promise((res) => { try { c.toBlob((b) => res(b), 'image/png'); } catch { res(null); } });

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = el('textarea', null, document.body);
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

let pop = null;
function closePop() { if (pop) { pop.remove(); pop = null; document.removeEventListener('pointerdown', outside, true); } }
function outside(e) { if (pop && !pop.contains(e.target)) closePop(); }

const mobileShare = () => typeof navigator.share === 'function' && (matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent));

/**
 * A share prepared ahead of the tap (the image is encoded in the background), so that on phones navigator.share runs
 * inside the tap's user activation (Safari refuses it after an await). { id (telemetry), text, url, canvas, fileName }
 * → { ready: Promise, run(anchor) → Promise<'file'|'web'|'cancel'|'menu'> }
 */
export function prepare({ id, text, url, canvas, fileName }) {
  const h = { file: null, blob: null };
  h.ready = toBlob(canvas).then((blob) => {
    h.blob = blob;
    try { h.file = blob && typeof File !== 'undefined' ? new File([blob], fileName, { type: 'image/png' }) : null; } catch { h.file = null; }
    return h;
  });
  h.run = (anchor) => {
    if (mobileShare()) {
      let files = null;
      try { files = h.file && navigator.canShare && navigator.canShare({ files: [h.file] }) ? [h.file] : null; } catch { files = null; }
      let p;
      try { p = navigator.share(files ? { files, text: `${text} ${url}`, title: 'Gökyüzü' } : { text, url, title: 'Gökyüzü' }); } catch (e) { p = Promise.reject(e); }
      return p.then(() => { trackEvent('share', { id, via: files ? 'file' : 'web' }); return files ? 'file' : 'web'; }, (e) => {
        if (e && e.name === 'AbortError') { trackEvent('share', { id, via: 'cancel' }); return 'cancel'; }
        return h.ready.then(() => popover(h, { id, text, url, fileName, anchor }));   // refused / unsupported
      });
    }
    return h.ready.then(() => popover(h, { id, text, url, fileName, anchor }));
  };
  return h;
}

/** Desktop: X intent, copy link, download image. */
function popover(h, { id, text, url, fileName, anchor }) {
  injectCSS('share', CSS);
  closePop();
  pop = el('div', 'gks-pop', document.body);
  pop.setAttribute('role', 'menu');
  const imgUrl = h.blob ? URL.createObjectURL(h.blob) : null;
  if (imgUrl) { const im = el('img', null, pop); im.alt = 'Paylaşım görseli'; im.src = imgUrl; }
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const xa = el('a', null, pop);
  xa.href = intent; xa.target = '_blank'; xa.rel = 'noopener noreferrer';
  xa.innerHTML = ICON.x; xa.append("X'te paylaş");
  xa.addEventListener('click', () => { trackEvent('share', { id, via: 'x' }); setTimeout(closePop, 100); });
  const cp = el('button', null, pop);
  cp.type = 'button'; cp.innerHTML = ICON.link; cp.append('Bağlantıyı kopyala');
  cp.addEventListener('click', async () => {
    const ok = await copyText(url);
    cp.lastChild.textContent = ok ? 'Kopyalandı' : 'Kopyalanamadı';
    trackEvent('share', { id, via: ok ? 'copy' : 'copyfail' });
  });
  if (imgUrl) {
    const dl = el('a', null, pop);
    dl.href = imgUrl; dl.download = fileName; dl.innerHTML = ICON.down; dl.append('Görseli indir');
    dl.addEventListener('click', () => trackEvent('share', { id, via: 'png' }));
  }
  el('small', null, pop, id === 'land' ? 'Bağlantı oyunu açar.' : 'Arkadaşın bağlantıyla aynı görevi uçar.');
  // placement: above the anchor button (or centred)
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  const pw = Math.min(320, innerWidth - 16);
  pop.style.width = `${pw}px`;
  const ph = pop.getBoundingClientRect().height || 300;
  const left = r ? Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), innerWidth - pw - 8) : (innerWidth - pw) / 2;
  const top = r ? (r.top - ph - 8 > 8 ? r.top - ph - 8 : Math.min(innerHeight - ph - 8, r.bottom + 8)) : (innerHeight - ph) / 2;
  pop.style.left = `${Math.round(left)}px`; pop.style.top = `${Math.round(Math.max(8, top))}px`;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  return 'menu';
}

const fmtInt = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function missionShareData({ id, day, title, aircraft, ok, score, stars, time }) {
  const url = missionLink(id, day);
  const kicker = day ? `Günün görevi · ${aircraft}` : `Görev · ${aircraft}`;
  const text = ok
    ? `Gökyüzü'nde "${title}" görevini ${stars} yıldızla bitirdim: ${fmtInt(score)} puan, ${fmtT(time)}. Sen yenebilir misin?`
    : `Gökyüzü'nde "${title}" görevini denedim. Sen yapabilir misin?`;
  return { url, kicker, text, big: ok ? fmtInt(score) : '—', bigSub: ok ? 'puan' : '', lines: ok ? [['Süre', fmtT(time)], ['Uçak', aircraft]] : [['Uçak', aircraft]] };
}

/** Prepared share of a mission result (see prepare). o = { id, day, title, aircraft, ok, score, stars, time, snapshot, map? } */
export function prepareMission(o) {
  const d = missionShareData(o);
  const canvas = renderCard({ kicker: d.kicker, title: o.title, stars: o.ok ? o.stars : 0, big: d.big, bigSub: d.bigSub, lines: d.lines, link: d.url, snapshot: o.snapshot, subtitle: o.map && o.map.shareTitle });
  return prepare({ id: o.id, text: d.text, url: d.url, canvas, fileName: `gokyuzu-${o.id}.png` });
}

/** Prepared share of a landing card (src/missions/landing-score.js), without a snapshot (cheap, done when the card shows). */
export function prepareLanding(card, { aircraft = '', map = null } = {}) {
  const url = missionLink(null, null, map);
  const rw = card.runway ? card.runway.replace(/^K/, '') : '';
  const text = `Gökyüzü'nde ${aircraft ? `${aircraft} ile ` : ''}${rw ? `${rw} pistine ` : ''}"${card.label}" iniş: ${card.fpm} ft/dk, ${card.stars} yıldız. Sen daha yumuşak koyabilir misin?`;
  const lines = [['Dikey hız', `${card.fpm} ft/dk`]];
  if (card.cl != null) lines.push(['Merkez çizgi', `${String(card.cl).replace('.', ',')} m`]);
  if (card.tdz != null) lines.push(['Eşikten', `${card.tdz} m`]);
  const canvas = renderCard({ kicker: `İniş · ${aircraft}${rw ? ` · ${rw}` : ''}`, title: card.label, stars: card.stars, big: `${card.points}`, bigSub: '/ 100', lines, link: url, subtitle: map && map.shareTitle });
  return prepare({ id: 'land', text, url, canvas, fileName: 'gokyuzu-inis.png' });
}
