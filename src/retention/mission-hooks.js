// Retention on the mission runtime (src/missions/runtime.js calls these; everything here is best-effort and never throws
// into the mission):
//   challenge link   ?mission=<id>&challenge=<score>: "Arkadaşın 2.450 puan yaptı — geçebilir misin?" on the briefing;
//                    on the result: beaten or not, and a share-back of the player's own score (src/ui/share.js makes
//                    every shared mission link a challenge link)
//   weekly           a run of this week's mission ("Haftanın görevi", src/retention/weekly.js; the plain mission, not
//                    the daily variation) is also submitted to the weekly board; the result card shows the weekly rank
//   assisted         a run with assisted flight on (missions not flown by hand keep it) or a touchdown on the autopilot
//                    is marked result.assisted: its entries go to the "Destekli" lists (src/retention/boards.js; the
//                    mission's own board through src/ui/mission-parts.js). The assist setting is never changed here.
//   streak           a finished mission (success, or 30 s or more) joins today to the daily streak
//   install          phones / tablets: a finished mission may suggest "Ana ekrana ekle" in the result card
//   result signal    <html class="gk-result-open"> while the result card is open (src/retention/result-flag.js)
// The lines go into the mission card of src/ui/missions-hud.js (the open `.gkq-card`), before its buttons (phones: after).
//
//   const ret = createMissionRetention({ mission, touch, flight })   flight() → the flight model
//   ret.brief()                       after ui.showBrief (first briefing and every restart)
//   ret.finish(result)                when the run ends (result = { ok, score, stars, time, … })
//   ret.result(result, { share })     after ui.showResult; share({ anchor }) = the runtime's share
// Telemetry `chl` (challenge links): open (id, d = 1 daily), beat / lost (o = tie | short | fail), back (share-back tapped).
import { parseChallenge, briefLine, resultLine, challengeOutcome } from './challenge-link.js';
import { weeklyFor } from './weekly.js';
import { noteActivity, streakLine, applyAccent } from './activity.js';
import { submitQuiet } from './lb.js';
import { boardFor } from './boards.js';
import { suggestInstall } from './install.js';
import { setResultOpen } from './result-flag.js';
import { injectCSS } from '../ui/styles.js';
import { el } from '../ui/util.js';
import { fmtInt } from '../missions/util.js';
import { trackEvent } from '../core/telemetry.js';

const CSS = `
.gkr-chl { display: flex; align-items: center; gap: 10px; margin: 8px 0 10px; padding: 9px 12px; border-radius: 12px; border: 1px solid rgba(255, 162, 74, .6);
  background: linear-gradient(120deg, rgba(255, 93, 51, .22), rgba(255, 162, 74, .07)); font-size: 14.5px; font-weight: 750; line-height: 1.3; color: var(--gk-fg); }
.gkr-chl svg { width: 22px; height: 22px; flex: 0 0 auto; color: var(--gk-orange-2); }
.gkr-wk { display: inline-flex; align-items: center; gap: 6px; margin: 2px 0 8px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 750;
  color: #ffd98a; background: rgba(255, 201, 74, .12); border: 1px solid rgba(255, 201, 74, .4); }
.gkr-mres { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.gkr-mres:empty { display: none; }
.gkr-res { display: flex; align-items: center; gap: 10px; padding: 9px 10px 9px 12px; border-radius: 12px; border: 1px solid rgba(255, 162, 74, .5); background: rgba(255, 162, 74, .08); }
.gkr-res.beat { border-color: rgba(92, 242, 200, .55); background: linear-gradient(120deg, rgba(92, 242, 200, .16), rgba(92, 242, 200, .04)); }
.gkr-res > div { min-width: 0; flex: 1 1 auto; }
.gkr-res b { display: block; font-size: 14.5px; font-weight: 800; }
.gkr-res small { display: block; margin-top: 2px; font-size: 12.5px; line-height: 1.35; color: rgba(226, 236, 250, .8); }
.gkr-res button { flex: 0 0 auto; min-height: 36px; padding: 6px 12px; border-radius: 10px; cursor: pointer; font: 750 13px var(--gk-sans); color: #04140f;
  background: var(--gk-teal); border: 0; }
.gkr-line { font-size: 13px; font-weight: 650; color: rgba(226, 236, 250, .88); }
.gkr-line.wk { color: #ffd98a; }
.gkr-line.st { color: #ffc27a; }
@media (max-height: 520px), (max-width: 560px) { .gkr-chl { font-size: 13px; padding: 7px 10px; margin: 4px 0 6px; } .gkr-mres { margin-top: 8px; gap: 6px; } }
`;
const FLAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>';

const openCard = () => document.querySelector('.gkq-back.on .gkq-card');

export function createMissionRetention({ mission, touch = false, flight = null } = {}) {
  let ch = null;
  // assisted run: the assist layer on at any moment of the run (the runtime sets result.assisted: sticky, so turning the
  // assist off just before the end keeps the run on the "Destekli" lists), on at the finish, or a touchdown on the
  // autopilot (autoland); reset at every briefing (a restart)
  let apTouchdown = false, hooked = null;
  const f = () => { try { return flight ? flight() : null; } catch { return null; } };
  const assistOn = () => { const m = f(); return !!(m && m.assist && m.assist.on); };
  function hook() {
    const m = f();
    if (!m || !m.on || hooked === m) return;
    hooked = m;
    m.on('touchdown', () => { if (m.autopilot && m.autopilot.on) apTouchdown = true; });
  }
  try { const c = parseChallenge(location.search); ch = c && c.id === mission.id ? c : null; } catch { ch = null; }
  injectCSS('retention-mission', CSS);
  applyAccent();
  let opened = false, weekly = null, streak = null;
  const isWeekly = () => { try { return weeklyFor({ mission: mission.id, daily: mission.day }); } catch { return null; } };
  // the week's pick when the briefing showed: a run started on Sunday evening and finished after Monday 00:00 (Istanbul)
  // still goes to the week its briefing promised (the server takes the previous week for a day)
  let weekPick = null;

  return {
    challenge: ch,
    brief() {
      try {
        apTouchdown = false; hook();
        weekPick = isWeekly();
        if (ch && !opened) { opened = true; trackEvent('chl', { st: 'open', id: mission.id, d: mission.day ? 1 : undefined }); }
        const c = openCard();
        if (!c || c.querySelector('.gkr-chl, .gkr-wk')) return;
        const h2 = c.querySelector('h2');
        const after = (node) => { if (h2 && h2.nextSibling) c.insertBefore(node, h2.nextSibling); else c.appendChild(node); };
        if (weekPick) after(el('div', 'gkr-wk', null, 'Haftanın görevi: bu uçuş haftalık sıralamaya da girer'));
        if (ch) { const b = el('div', 'gkr-chl'); b.innerHTML = FLAG; b.append(briefLine(ch)); after(b); }
      } catch { /* decoration only */ }
    },
    finish(result) {
      try {
        if (assistOn() || apTouchdown) result.assisted = true;   // (read by the result card's leaderboard)
        streak = result.ok || result.time >= 30 ? noteActivity('mission') : null;
        const wk = result.ok ? weekPick : null;
        weekly = wk ? { pick: wk, assisted: !!result.assisted, p: submitQuiet({ board: boardFor(wk.board, result.assisted), score: result.score, stars: result.stars, sec: result.time, ac: mission.aircraft, weekly: wk.key, assisted: !!result.assisted }) } : null;
        if (ch) {
          const o = challengeOutcome(ch, result);
          trackEvent('chl', o === 'beat' ? { st: 'beat', id: mission.id } : { st: 'lost', id: mission.id, o });
        }
      } catch { /* never into the mission */ }
    },
    result(result, { share = null } = {}) {
      try {
        const c = openCard();
        if (!c) return;
        // the result signal (<html class="gk-result-open">) while this card is open ("Tekrar dene" / the menu remove it)
        setResultOpen('mission', true);
        const watch = setInterval(() => { if (!c.isConnected || !c.closest('.gkq-back.on')) { clearInterval(watch); setResultOpen('mission', false); } }, 400);
        // (before the buttons; phones: after them, so "Tekrar dene" stays in view without scrolling the card)
        const box = el('div', 'gkr-mres');
        const btns = c.querySelector('.gkq-btns');
        const narrow = matchMedia('(max-height: 520px), (max-width: 560px)').matches;
        if (btns) c.insertBefore(box, narrow ? btns.nextSibling : btns); else c.appendChild(box);
        if (ch) {
          const l = resultLine(ch, result);
          const r = el('div', `gkr-res${l.o === 'beat' ? ' beat' : ''}`, box);
          const t = el('div', null, r);
          el('b', null, t, l.title);
          el('small', null, t, l.text);
          if (l.o === 'beat' && share) {
            const b = el('button', null, r, 'Skorunu gönder');
            b.type = 'button';
            b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); trackEvent('chl', { st: 'back', id: mission.id }); share({ anchor: b }); });
          }
        }
        const sl = streakLine(streak);
        if (sl) el('div', 'gkr-line st', box, sl);
        if (weekly) {
          const w = el('div', 'gkr-line wk', box, 'Haftanın görevi: skorun haftalık sıralamaya gönderiliyor…');
          weekly.p.then((r) => {
            if (!w.isConnected) return;
            if (!r) { w.remove(); return; }
            const lead = r.rank === 1 ? ', lider sensin!' : r.top && r.top[0] ? ` · lider ${r.top[0].name || 'İsimsiz pilot'} ${fmtInt(r.top[0].score)}` : '';
            const list = weekly.assisted ? ' (Destekli)' : '';
            w.textContent = r.rank ? `Haftanın görevi${list}: bu hafta ${r.rank}. sıradasın${lead}` : `Haftanın görevi${list}: skorun kaydedildi${lead}`;
          }).catch(() => w.remove());
        }
        if (touch && result.ok) suggestInstall({ via: 'mission', inline: box });
      } catch { /* decoration only */ }
    },
  };
}
