// Pieces shared by the mission UI (src/ui/missions-hud.js) and the free-flight challenges panel
// (src/ui/challenges-panel.js), CONTRACTS-SF.md §12: the glass / button / star / score-row / leaderboard styles, the
// screen-space target pointer (diamond on screen, edge arrow off screen) and the top-10 + nickname block of the online
// leaderboard (src/net/leaderboard.js). Both users are lazily loaded chunks; esbuild puts this module in a chunk they share.
//
//   injectPartsCSS()
//   const p = createPointer(root, { touch })       p.update(camera, target, label) every frame (allocation-free when still), p.hide()
//   showLeaderboard(lb, { board, day, ok, score, stars, sec, ac, title, showAc })   → Promise (the block stays hidden without the service)
import { injectCSS, BASE_CSS } from './styles.js';
import { el } from './util.js';
import { fmtInt } from '../missions/util.js';
import { AIRCRAFT_SHORT } from '../missions/catalog.js';
import { trackEvent } from '../core/telemetry.js';

export const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.3l-5.8 3.1 1.2-6.5L2.6 9.4l6.5-.8z"/></svg>';
export const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6.5 16L12 15.2 5.5 19z"/></svg>';

export const PARTS_CSS = `
.gkq-glass { background: linear-gradient(180deg, rgba(16, 26, 42, .8), rgba(6, 11, 20, .76)); border: 1px solid rgba(255, 255, 255, .13);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .06); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.gkq-sm svg { width: 12px; height: 12px; fill: #ffc94a; }

/* pointer to the target */
.gkq-ptr { position: absolute; left: 0; top: 0; width: 0; height: 0; display: none; will-change: transform; }
.gkq-ptr.on { display: block; }
.gkq-ptr i { position: absolute; left: -9px; top: -9px; width: 14px; height: 14px; border: 2.5px solid #ffa24a; transform: rotate(45deg); border-radius: 3px;
  box-shadow: 0 0 10px rgba(255, 162, 74, .6); }
.gkq-ptr b { position: absolute; left: 50%; top: 13px; transform: translateX(-50%); font: 700 12px var(--gk-mono); white-space: nowrap; color: #ffe2c8;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .9), 0 0 6px rgba(0, 0, 0, .6); }
.gkq-ptr svg { display: none; position: absolute; left: -13px; top: -13px; width: 26px; height: 26px; fill: #ffa24a; filter: drop-shadow(0 0 6px rgba(0, 0, 0, .7)); }
.gkq-ptr.edge i { display: none; } .gkq-ptr.edge svg { display: block; }

/* buttons */
.gkq-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 10px 18px; border-radius: 12px; cursor: pointer;
  font: 700 15px var(--gk-sans); color: var(--gk-fg); background: rgba(255, 255, 255, .07); border: 1px solid rgba(255, 255, 255, .16); transition: background .15s, transform .15s; }
.gkq-btn:hover { background: rgba(255, 255, 255, .13); }
.gkq-btn:active { transform: scale(.98); }
.gkq-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gkq-btn:disabled { opacity: .45; cursor: default; transform: none; }
.gkq-btn.primary { background: linear-gradient(135deg, #ff5d33, #ff8a45 60%, #ffb257); color: #1c0e06; border-color: transparent; }
.gkq-btn.primary:hover { filter: brightness(1.06); }
.gkq-btn.teal { color: var(--gk-teal); border-color: rgba(92, 242, 200, .45); background: rgba(92, 242, 200, .08); }
.gkq-btn kbd { font: 700 10.5px var(--gk-sans); padding: 2px 6px; border-radius: 5px; background: rgba(40, 14, 0, .16); border: 1px solid rgba(40, 14, 0, .25); }

/* result: stars, score, breakdown */
.gkq-big { display: flex; gap: 4px; }
.gkq-big svg { width: 38px; height: 38px; fill: rgba(255, 255, 255, .14); }
.gkq-big svg.on { fill: #ffc94a; filter: drop-shadow(0 0 10px rgba(255, 201, 74, .55)); animation: gkq-pop .45s cubic-bezier(.2, .9, .3, 1.5) both; }
.gkq-big svg.on:nth-child(2) { animation-delay: .15s; } .gkq-big svg.on:nth-child(3) { animation-delay: .3s; }
@keyframes gkq-pop { from { transform: scale(.3); opacity: 0; } to { transform: none; opacity: 1; } }
.gkq-score { font: 800 30px var(--gk-mono); letter-spacing: -.03em; line-height: 1; }
.gkq-score small { display: block; margin-top: 4px; font: 650 12px var(--gk-sans); letter-spacing: .04em; color: var(--gk-dim); }
.gkq-ok { color: var(--gk-teal) !important; } .gkq-bad { color: var(--gk-warn) !important; }
.gkq-row { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; border-bottom: 1px solid rgba(255, 255, 255, .06); font-size: 13.5px; }
.gkq-row span { color: rgba(226, 236, 250, .86); white-space: nowrap; } .gkq-row em { font-style: normal; color: var(--gk-dim); font-size: 12.5px; flex: 1 1 auto; text-align: right; }
.gkq-row b { font: 700 13px var(--gk-mono); min-width: 52px; text-align: right; color: var(--gk-teal); }
.gkq-new { display: inline-block; margin-left: 8px; font-size: 10px; font-weight: 800; letter-spacing: .12em; padding: 2px 6px; border-radius: 5px; background: #ffc94a; color: #2a1a00; vertical-align: 3px; }

/* leaderboard */
.gkq-lb { margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, .08); display: none; }
.gkq-lb.on { display: block; }
.gkq-lb h3 { margin: 0 0 6px; font-size: 11px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-dim); }
.gkq-lb ol { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 20px; }
.gkq-lb li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-size: 12.5px; break-inside: avoid; }
.gkq-lb li i { font-style: normal; font: 700 11px var(--gk-mono); color: var(--gk-faint); min-width: 18px; }
.gkq-lb li span { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkq-lb li u { text-decoration: none; font: 650 10px var(--gk-sans); color: var(--gk-faint); white-space: nowrap; }
.gkq-lb li b { font: 700 12px var(--gk-mono); }
.gkq-lb li.me span, .gkq-lb li.me b { color: var(--gk-teal); }
.gkq-lb form { display: flex; gap: 8px; margin-top: 8px; }
.gkq-lb input { flex: 1 1 auto; min-width: 0; height: 36px; padding: 0 10px; border-radius: 9px; border: 1px solid rgba(255, 255, 255, .2); background: rgba(0, 0, 0, .25);
  color: var(--gk-fg); font: 600 14px var(--gk-sans); user-select: text; -webkit-user-select: text; }
.gkq-lb .gkq-btn { min-height: 36px; padding: 6px 14px; font-size: 13.5px; }
.gkq-lb small { display: block; margin-top: 5px; font-size: 11.5px; color: var(--gk-dim); }
.gkq-lb small.bad { color: #ffb4b4; }
`;

export function injectPartsCSS() {
  injectCSS('base', BASE_CSS);
  injectCSS('mission-parts', PARTS_CSS);
}

export const starRow = (n, cls = 'gkq-sm') => { const s = el('span', cls); s.innerHTML = STAR.repeat(n); return s; };

/**
 * Screen-space pointer to a world target: a diamond where the target is on screen, an arrow at the screen edge when it
 * is off screen or behind. update() runs every frame: no allocation and no style write while nothing moved.
 */
export function createPointer(root, { touch = false } = {}) {
  const ptr = el('div', 'gkq-ptr', root);
  el('i', null, ptr);
  ptr.insertAdjacentHTML('beforeend', ARROW);
  const arrow = ptr.lastChild;
  const lbl = el('b', null, ptr, '');
  let W = innerWidth, H = innerHeight, lastX = -1, lastY = -1, lastRot = 999, edge = null, on = false;
  addEventListener('resize', () => { W = root.clientWidth || innerWidth; H = root.clientHeight || innerHeight; lastX = -1; });
  const hide = () => { if (on) { on = false; ptr.classList.remove('on'); } };
  return {
    hide,
    update(camera, tg, label) {
      if (!camera || !tg) { hide(); return; }
      const e = camera.matrixWorldInverse.elements;
      const x = tg.x, y = tg.y, z = tg.z;
      const vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13], vz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const ty = Math.tan((camera.fov * Math.PI) / 360), tx = ty * camera.aspect;
      let nx, ny, off = false;
      if (vz < -1) { nx = vx / -vz / tx; ny = vy / -vz / ty; }
      else { nx = vx; ny = vy; off = true; }             // behind: only the direction counts
      const mx = touch ? 0.62 : 0.86, my = touch ? 0.5 : 0.78;
      if (off || Math.abs(nx) > mx || Math.abs(ny) > my) {
        off = true;
        const k = Math.min(mx / Math.max(Math.abs(nx), 1e-6), my / Math.max(Math.abs(ny), 1e-6));
        nx *= k; ny *= k;
      }
      const sx = (nx * 0.5 + 0.5) * W, sy = (-ny * 0.5 + 0.5) * H;
      if (Math.abs(sx - lastX) >= 0.5 || Math.abs(sy - lastY) >= 0.5) {   // (no style write, no string, when it did not move)
        lastX = sx; lastY = sy;
        ptr.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      }
      if (off) {
        const rot = Math.round(Math.atan2(nx, ny) * 180 / Math.PI);
        if (rot !== lastRot) { lastRot = rot; arrow.style.transform = `rotate(${rot}deg)`; }
      }
      if (off !== edge) { edge = off; ptr.classList.toggle('edge', off); }
      if (label != null && lbl.textContent !== label) lbl.textContent = label;
      if (!on) { on = true; ptr.classList.add('on'); }
    },
    get visible() { return on; },
    get state() { return on ? (edge ? 'edge' : 'on') : null; },
  };
}

/**
 * Top 10 of a board and, for a finished run, the optional nickname + "Skoru gönder" (src/net/leaderboard.js). The block
 * stays hidden when the service is unavailable; the local dev server (tools/serve.mjs) has no /api/, so no request is
 * made there (each 404 would be a console error) unless ?lb=1.
 * Telemetry `lb` (CONTRACTS-SF.md §11; never the nickname): show (b = board, d = 1 daily, c = entries), submit (b, r =
 * rank, im = 1 improved, nm = 1 a nickname was given), fail (b: the submission did not go through).
 *   o = { board, day, ok, score, stars, sec, ac, title, showAc (aircraft next to each name: boards open to every aircraft) }
 */
export async function showLeaderboard(lb, o) {
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname) && new URLSearchParams(location.search).get('lb') !== '1') return;
  let mod;
  try { mod = await import('../net/leaderboard.js'); } catch { return; }
  const day = o.day || '';
  const render = (top, meRank) => {
    if (!top || !top.entries || !top.entries.length) { lb.classList.toggle('on', !!o.ok); return; }
    lb.classList.add('on');
    list.textContent = '';
    for (const x of top.entries.slice(0, 10)) {
      const li = el('li', x.rank === meRank ? 'me' : '', list);
      el('i', null, li, String(x.rank));
      el('span', null, li, x.name || 'İsimsiz pilot');
      if (o.showAc && x.ac) el('u', null, li, AIRCRAFT_SHORT[x.ac] || x.ac);
      el('b', null, li, fmtInt(x.score));
    }
  };
  lb.textContent = '';
  el('h3', null, lb, o.title || 'Sıralama');
  const list = el('ol', null, lb);
  if (o.ok) {
    const form = el('form', null, lb);
    const input = el('input', null, form);
    input.type = 'text'; input.maxLength = mod.NAME_MAX || 16; input.placeholder = 'Takma ad (isteğe bağlı)'; input.autocomplete = 'off'; input.enterKeyHint = 'send';
    input.value = mod.savedName ? mod.savedName() : '';
    input.addEventListener('keydown', (e) => e.stopPropagation());   // typing never flies the aircraft
    input.addEventListener('keyup', (e) => e.stopPropagation());
    const send = el('button', 'gkq-btn teal', form, 'Skoru gönder');
    send.type = 'submit';
    const note = el('small', null, lb, 'İsim yazmazsan "İsimsiz pilot" görünür. Başka bir bilgi gönderilmez.');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      input.blur();
      const name = input.value.trim();
      const chk = mod.cleanName ? mod.cleanName(name) : { ok: true };
      if (!chk.ok) { note.textContent = 'Bu takma ad kullanılamıyor: harf, rakam, boşluk, _ ve - (en çok 16).'; note.className = 'bad'; return; }
      send.disabled = true; send.textContent = 'Gönderiliyor…';
      const sec = typeof o.sec === 'number' && Number.isFinite(o.sec) ? Math.round(o.sec * 10) / 10 : undefined;
      const res = await mod.submitScore({ mission: o.board, day, score: o.score, stars: o.stars, ac: o.ac, name: chk.name || undefined, sec });
      if (!res) {
        trackEvent('lb', { st: 'fail', b: o.board, d: day ? 1 : undefined });
        send.disabled = false; send.textContent = 'Tekrar dene'; note.textContent = 'Sıralama şu an ulaşılamıyor.'; note.className = 'bad'; return;
      }
      trackEvent('lb', { st: 'submit', b: o.board, d: day ? 1 : undefined, r: res.rank ?? undefined, im: res.improved ? 1 : 0, nm: chk.name ? 1 : 0 });
      form.remove();
      note.className = res.nameRejected ? 'bad' : '';
      note.textContent = res.nameRejected ? 'Takma ad kabul edilmedi: skor isimsiz kaydedildi.' : res.rank ? `Sıran: ${res.rank}${res.improved ? '' : ' (en iyi skorun duruyor)'}` : 'Skor kaydedildi.';
      if (o.onSubmitted) o.onSubmitted(res);
      render(res.top ? { entries: res.top } : null, res.rank);
    });
  }
  const top = await mod.topScores({ mission: o.board, day, n: 10 });
  if (top === null) { lb.classList.remove('on'); return; }   // service unavailable: hide the table
  render(top, null);
  if (!top.entries || !top.entries.length) { el('small', null, list, 'Henüz skor yok: ilk sen ol!'); lb.classList.toggle('on', !!o.ok); }
  if (lb.classList.contains('on')) trackEvent('lb', { st: 'show', b: o.board, d: day ? 1 : undefined, c: top.entries ? top.entries.length : 0 });
}
