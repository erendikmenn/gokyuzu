// Main menu "Görevler" (CONTRACTS-SF.md §12): an entry in the menu (a "Görevler" button and the "Günün görevi" card
// with the countdown to the next one) and the missions panel over the menu scene — mission cards (stars, best score,
// locked state), the selected mission's briefing and "Başla". Loaded lazily by src/ui/menu.js once the menu is on
// screen (the catalog is small; the mission runtime itself only loads when a mission starts).
//
//   await loadMenuMissions(map)                                     // the map's catalog (src/missions/catalog.js), null: none
//   mountMissions({ root, brand, foot, container, touch, start, catalog, runways })   // start({ id, daily, map? }) closes the menu into the mission
//                                                    (runways: the map's runways.json, for the day's landing runway)
// Telemetry `mmenu` (CONTRACTS-SF.md §11): open (via = tab | daily | weekly: the panel opened from "Görevler" / the daily /
// the weekly card), daily (the daily mission's details viewed), weekly (id), dland, detail (id: a mission's details
// viewed by the player; once per mission and page, so browsing never uses up the event cap).
// Retention (src/retention/**): "Haftanın görevi" (a third entry button and a card: this ISO week's mission or free-flight
// challenge for everyone, src/retention/weekly.js; its top 10 and last week's champion from the leaderboard's weekly
// boards; maybe on the other map) and "Günün inişi" (the day's runway, src/missions/landing-challenges.js: free flight from
// its final approach). A free-flight start calls start({ free: true, map, spawn | airport + ident, track, final }).
// Telemetry `wk`: show (id = the pick, c = entries: the weekly top 10 seen, as = 1 its "Destekli" list), play (id).
// Every leaderboard list here has the "Elle / Destekli" switch (src/retention/boards.js).
import { injectCSS } from './styles.js';
import { el } from './util.js';
import { shared } from './shared.js';
import { SF_CATALOG, loadMissionCatalog, AIRCRAFT_SHORT, LEVEL_LABEL } from '../missions/catalog.js';

export { loadMissionCatalog as loadMenuMissions };
import { istanbulDay, secondsToNextDay, fmtClock, fmtInt, fmtTime, dayLabel } from '../missions/util.js';
import { trackEvent } from '../core/telemetry.js';
import { currentWeek, weeklyPick, addWeeks, weekLabel, secondsToNextWeek, fmtLeft } from '../retention/weekly.js';
import { boardTop } from '../retention/lb.js';
import { boardFor, lastList } from '../retention/boards.js';
import { landingChallenges, landingEndNames, dailyLandingEnd, endLabel } from '../missions/landing-challenges.js';

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.3l-5.8 3.1 1.2-6.5L2.6 9.4l6.5-.8z"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const TARGET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>';
const CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
const CUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>';
const RWY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3 6 21M15 3l3 18M12 5v2M12 11v2M12 17v2"/></svg>';
const MAP_NAME = { sf: 'San Francisco', ist: 'İstanbul' };

const CSS = `
.gkmm-entry { display: flex; flex-wrap: wrap; gap: calc(10 * var(--u1)); margin-top: calc(18 * var(--u1)); }
.gkmm-eb { display: flex; align-items: center; gap: calc(10 * var(--u1)); padding: calc(9 * var(--u1)) calc(14 * var(--u1)); border-radius: calc(13 * var(--u1)); cursor: pointer;
  border: 1px solid rgba(255, 255, 255, .16); background: rgba(8, 14, 26, .5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); text-align: left;
  color: var(--gk-fg) !important; transition: background .15s, border-color .15s, transform .15s; outline: none; font: inherit; }
.gkmm-eb:hover { background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .3); transform: translateY(-1px); }
.gkmm-eb:focus-visible { box-shadow: 0 0 0 2px #fff; }
.gkmm-eb svg { width: calc(22 * var(--u1)); height: calc(22 * var(--u1)); flex: 0 0 auto; color: var(--gk-orange-2); }
.gkmm-eb b { display: block; font-size: calc(15 * var(--u1)); font-weight: 780; letter-spacing: -.01em; white-space: nowrap; }
.gkmm-eb small { display: block; margin-top: 1px; font-size: calc(11.5 * var(--u1)); font-weight: 600; color: var(--gk-dim); white-space: nowrap; }
.gkmm-eb.main { border-color: rgba(255, 140, 90, .6); background: linear-gradient(135deg, rgba(255, 93, 51, .28), rgba(255, 162, 74, .14)); }
.gkmm-eb.daily svg { color: var(--gk-teal); }
.gkmm-eb.daily small b { display: inline; font: 700 calc(11.5 * var(--u1)) var(--gk-mono); color: var(--gk-teal); }
.gkmm-stars { display: inline-flex; gap: 1px; vertical-align: -1px; }
.gkmm-stars svg { width: calc(12 * var(--u1)); height: calc(12 * var(--u1)); fill: rgba(255, 255, 255, .2); color: inherit; }
.gkmm-stars svg.on { fill: #ffc94a; }

/* panel */
.gkmm { position: absolute; inset: 0; z-index: 8; display: grid; grid-template-columns: minmax(0, 1fr) calc(400 * var(--u1)); grid-template-rows: auto minmax(0, 1fr);
  column-gap: calc(24 * var(--u1)); padding: calc(30 * var(--u1)) calc(40 * var(--u1)) calc(24 * var(--u1)); box-sizing: border-box;
  background: linear-gradient(90deg, rgba(4, 8, 16, .9), rgba(4, 8, 16, .72)); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  animation: gkmm-in .3s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes gkmm-in { from { opacity: 0; } to { opacity: 1; } }
.gkmm-head { grid-column: 1 / span 2; display: flex; align-items: center; gap: calc(14 * var(--u1)); margin-bottom: calc(16 * var(--u1)); }
.gkmm-back { display: inline-flex; align-items: center; gap: 6px; padding: calc(7 * var(--u1)) calc(13 * var(--u1)); border-radius: calc(10 * var(--u1)); cursor: pointer;
  border: 1px solid rgba(255, 255, 255, .18); background: rgba(255, 255, 255, .06); color: var(--gk-fg) !important; font: 650 calc(13 * var(--u1)) var(--gk-sans) !important; }
.gkmm-back:hover { background: rgba(255, 255, 255, .12); }
.gkmm-head h2 { margin: 0; font-family: var(--gk-display); font-size: calc(34 * var(--u1)); font-weight: 800; letter-spacing: -.02em; }
.gkmm-total { margin-left: auto; display: flex; align-items: center; gap: 6px; font: 700 calc(14 * var(--u1)) var(--gk-mono); color: #ffc94a; }
.gkmm-total svg { width: calc(16 * var(--u1)); height: calc(16 * var(--u1)); fill: #ffc94a; }
.gkmm-list { grid-column: 1; grid-row: 2; min-height: 0; overflow-y: auto; padding: 4px 6px 12px 2px; scrollbar-width: thin; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.gkmm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(220 * var(--u1)), 1fr)); gap: calc(10 * var(--u1)); }
.gkmm-day { position: relative; display: flex; align-items: center; gap: calc(16 * var(--u1)); width: 100%; margin-bottom: calc(14 * var(--u1)); padding: calc(14 * var(--u1)) calc(18 * var(--u1));
  border-radius: calc(16 * var(--u1)); border: 1px solid rgba(92, 242, 200, .45); background: linear-gradient(120deg, rgba(92, 242, 200, .16), rgba(20, 40, 60, .5));
  cursor: pointer; text-align: left; color: var(--gk-fg) !important; font: inherit; outline: none; }
.gkmm-day[aria-selected="true"] { box-shadow: 0 0 0 2px var(--gk-teal); }
.gkmm-day > svg { width: calc(34 * var(--u1)); height: calc(34 * var(--u1)); color: var(--gk-teal); flex: 0 0 auto; }
.gkmm-day i { font-style: normal; font-size: calc(10.5 * var(--u1)); font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-teal); }
.gkmm-day b { display: block; margin-top: 2px; font-size: calc(19 * var(--u1)); font-weight: 780; letter-spacing: -.01em; }
.gkmm-day small { display: block; margin-top: 2px; font-size: calc(12.5 * var(--u1)); color: var(--gk-dim); }
.gkmm-day .gkmm-cd { margin-left: auto; text-align: right; font: 700 calc(18 * var(--u1)) var(--gk-mono); color: var(--gk-fg); white-space: nowrap; }
.gkmm-day .gkmm-cd small { font: 650 calc(10.5 * var(--u1)) var(--gk-sans); letter-spacing: .08em; color: var(--gk-dim); }
.gkmm-card { position: relative; display: flex; flex-direction: column; gap: 4px; min-height: calc(112 * var(--u1)); padding: calc(12 * var(--u1)) calc(14 * var(--u1));
  border-radius: calc(14 * var(--u1)); border: 1px solid rgba(255, 255, 255, .11); background: linear-gradient(180deg, rgba(20, 30, 48, .75), rgba(8, 13, 24, .8));
  cursor: pointer; text-align: left; color: var(--gk-fg) !important; font: inherit; outline: none; transition: border-color .15s, transform .15s; }
.gkmm-card:hover { border-color: rgba(255, 255, 255, .26); transform: translateY(-2px); }
.gkmm-card[aria-selected="true"] { border-color: rgba(255, 140, 90, .9); box-shadow: 0 0 0 1px rgba(255, 120, 70, .5), 0 0 26px rgba(255, 107, 61, .2); }
.gkmm-card:focus-visible { box-shadow: 0 0 0 2px #fff; }
.gkmm-card .n { font: 700 calc(11 * var(--u1)) var(--gk-mono); color: var(--gk-faint); }
.gkmm-card .t { font-size: calc(15.5 * var(--u1)); font-weight: 750; line-height: 1.2; letter-spacing: -.01em; }
.gkmm-card .m { font-size: calc(11.5 * var(--u1)); color: var(--gk-dim); }
.gkmm-card .f { margin-top: auto; display: flex; align-items: center; gap: 8px; font: 650 calc(11.5 * var(--u1)) var(--gk-mono); color: var(--gk-dim); }
.gkmm-card .f .gkmm-stars { margin-left: auto; }
.gkmm-card.locked { opacity: .55; }
.gkmm-card.locked .t::after { content: ""; }
.gkmm-lock { position: absolute; top: calc(10 * var(--u1)); right: calc(10 * var(--u1)); display: flex; align-items: center; gap: 4px; font-size: calc(10.5 * var(--u1)); font-weight: 700; color: var(--gk-dim); }
.gkmm-lock svg { width: calc(14 * var(--u1)); height: calc(14 * var(--u1)); }
.gkmm-lvl { display: inline-block; padding: 1px 6px; border-radius: 5px; font-size: calc(9.5 * var(--u1)); font-weight: 800; letter-spacing: .1em; text-transform: uppercase; background: rgba(255, 255, 255, .08); }
.gkmm-lvl.l3 { color: #ffb4b4; background: rgba(255, 77, 79, .14); } .gkmm-lvl.l2 { color: #ffd08a; background: rgba(255, 176, 32, .12); } .gkmm-lvl.l1 { color: #aef5df; background: rgba(92, 242, 200, .12); }
.gkmm-side { grid-column: 2; grid-row: 2; min-height: 0; display: flex; flex-direction: column; border-radius: calc(18 * var(--u1)); overflow: hidden;
  background: linear-gradient(180deg, rgba(14, 22, 38, .8), rgba(6, 10, 20, .85)); border: 1px solid rgba(255, 255, 255, .1); }
.gkmm-det { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: calc(18 * var(--u1)) calc(20 * var(--u1)) calc(8 * var(--u1)); }
.gkmm-det .k { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: calc(11 * var(--u1)); font-weight: 750; letter-spacing: .12em; text-transform: uppercase; color: var(--gk-dim); }
.gkmm-det .k b { color: var(--gk-orange-2); }
.gkmm-det h3 { margin: calc(8 * var(--u1)) 0; font-size: calc(24 * var(--u1)); font-weight: 800; letter-spacing: -.02em; line-height: 1.12; }
.gkmm-det p { margin: 0; font-size: calc(14 * var(--u1)); line-height: 1.5; color: rgba(226, 236, 250, .86); }
.gkmm-goal { margin-top: calc(12 * var(--u1)); padding: calc(9 * var(--u1)) calc(12 * var(--u1)); border-radius: 11px; background: rgba(255, 162, 74, .1); border: 1px solid rgba(255, 162, 74, .3);
  font-size: calc(13.5 * var(--u1)); font-weight: 650; }
.gkmm-goal span { display: block; font-size: calc(10 * var(--u1)); font-weight: 800; letter-spacing: .16em; color: var(--gk-orange-2); }
.gkmm-crit { margin-top: calc(10 * var(--u1)); display: flex; flex-direction: column; gap: 4px; font-size: calc(12.5 * var(--u1)); color: var(--gk-dim); }
.gkmm-crit .gkmm-stars svg { fill: rgba(255, 255, 255, .18); } .gkmm-crit .gkmm-stars svg.on { fill: #ffc94a; }
.gkmm-best { margin-top: calc(10 * var(--u1)); font-size: calc(12.5 * var(--u1)); color: var(--gk-fg); }
.gkmm-note { margin-top: 8px; font-size: calc(12.5 * var(--u1)); color: var(--gk-teal); font-weight: 650; }
.gkmm-lockmsg { margin-top: calc(12 * var(--u1)); font-size: calc(13 * var(--u1)); color: #ffd08a; }
.gkmm-go { margin: calc(8 * var(--u1)) calc(16 * var(--u1)) calc(16 * var(--u1)); display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: calc(14 * var(--u1)) calc(18 * var(--u1)); border: 0; border-radius: calc(15 * var(--u1)); cursor: pointer; color: #1c0e06 !important;
  background: linear-gradient(135deg, #ff5d33 0%, #ff8a45 60%, #ffb257 100%); box-shadow: 0 14px 36px rgba(255, 96, 50, .38); font: inherit; outline: none; }
.gkmm-go:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 6px rgba(255, 107, 61, .55); }
.gkmm-go b { font-family: var(--gk-display); font-size: calc(26 * var(--u1)); font-weight: 850; }
.gkmm-go small { font-size: calc(11.5 * var(--u1)); font-weight: 650; opacity: .8; }
.gkmm-go kbd { font: 700 calc(11 * var(--u1)) var(--gk-sans); padding: 3px 8px; border-radius: 6px; background: rgba(40, 14, 0, .16); border: 1px solid rgba(40, 14, 0, .25); }
.gkmm-go.alt { background: rgba(255, 255, 255, .1); color: var(--gk-fg) !important; box-shadow: none; }

/* phones (landscape and portrait): one column, the list or the detail */
.gkmm.gkmm-narrow { grid-template-columns: minmax(0, 1fr); padding: max(10px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
.gkmm.gkmm-narrow .gkmm-head { grid-column: 1; margin-bottom: 8px; }
.gkmm.gkmm-narrow .gkmm-head h2 { font-size: 22px; }
.gkmm.gkmm-narrow .gkmm-side { grid-column: 1; display: none; }
.gkmm.gkmm-narrow.detail .gkmm-side { display: flex; }
.gkmm.gkmm-narrow.detail .gkmm-list { display: none; }
.gkmm.gkmm-narrow .gkmm-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.gkmm.gkmm-narrow .gkmm-card { min-height: 92px; padding: 9px 11px; }
.gkmm.gkmm-narrow .gkmm-day { padding: 10px 12px; margin-bottom: 8px; }
.gkmm.gkmm-narrow .gkmm-day b { font-size: 16px; }
.gkmm.gkmm-narrow .gkmm-det { padding: 12px 14px 6px; }
.gkmm.gkmm-narrow .gkmm-det h3 { font-size: 20px; margin: 4px 0 6px; }
.gkmm.gkmm-narrow .gkmm-det p { font-size: 13px; line-height: 1.4; }
.gkmm.gkmm-narrow .gkmm-go { margin: 6px 10px 10px; padding: 10px 14px; }
.gkmm.gkmm-narrow .gkmm-go b { font-size: 22px; }
.gkm.gkm-touch .gkmm-entry.in-foot { margin: 0; gap: 8px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb { padding: 6px 12px; min-height: 36px; border-radius: 11px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb b { font-size: 13.5px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb small { font-size: 10.5px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb svg { width: 18px; height: 18px; }
@media (max-height: 380px) { .gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb small { display: none; } }

/* retention: weekly challenge, daily landing */
.gkmm-eb.weekly svg { color: #ffc94a; }
.gkmm-eb.weekly small b { display: inline; font: 700 calc(11.5 * var(--u1)) var(--gk-mono); color: #ffc94a; }
.gkmm-eb { max-width: 100%; min-width: 0; }
.gkmm-eb > span { min-width: 0; }
.gkmm-eb small { overflow: hidden; text-overflow: ellipsis; }
.gkm.gkm-touch .gkmm-entry.in-foot { max-width: 100%; min-width: 0; }
@media (max-height: 520px) {   /* landscape phones: the three buttons in one row, titles and details in the panel */
  .gkm.gkm-touch .gkmm-entry.in-foot { gap: 6px; }
  .gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb b .t, .gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb small,
  .gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb.daily svg, .gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb.weekly svg { display: none; }
}
.gkmm-sp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: calc(10 * var(--u1)); margin-bottom: calc(14 * var(--u1)); }
.gkmm-spc { position: relative; display: flex; align-items: center; gap: calc(12 * var(--u1)); min-width: 0; padding: calc(12 * var(--u1)) calc(14 * var(--u1)); border-radius: calc(16 * var(--u1));
  cursor: pointer; text-align: left; color: var(--gk-fg) !important; font: inherit; outline: none; --c: #ffc94a; border: 1px solid rgba(255, 201, 74, .5);
  background: linear-gradient(120deg, rgba(255, 201, 74, .15), rgba(20, 40, 60, .5)); }
.gkmm-spc.dl { --c: #6cc8ff; border-color: rgba(108, 200, 255, .5); background: linear-gradient(120deg, rgba(108, 200, 255, .15), rgba(20, 40, 60, .5)); }
.gkmm-spc[aria-selected="true"] { box-shadow: 0 0 0 2px var(--c); }
.gkmm-spc:focus-visible { box-shadow: 0 0 0 2px #fff; }
.gkmm-spc > svg { width: calc(30 * var(--u1)); height: calc(30 * var(--u1)); color: var(--c); flex: 0 0 auto; }
.gkmm-spc > span { min-width: 0; }
.gkmm-spc i { font-style: normal; font-size: calc(10.5 * var(--u1)); font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--c); }
.gkmm-spc b { display: block; margin-top: 2px; font-size: calc(16 * var(--u1)); font-weight: 780; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkmm-spc small { display: block; margin-top: 2px; font-size: calc(12 * var(--u1)); color: var(--gk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkmm-lb { margin-top: calc(12 * var(--u1)); padding-top: calc(10 * var(--u1)); border-top: 1px solid rgba(255, 255, 255, .08); }
.gkmm-lb h4 { margin: 0 0 6px; font-size: calc(10.5 * var(--u1)); font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-dim); }
.gkmm-lbh { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.gkmm-lbh h4 { margin: 0; flex: 1 1 auto; min-width: 0; }
.gkmm-seg { display: inline-flex; flex: 0 0 auto; gap: 2px; padding: 2px; border-radius: 8px; background: rgba(255, 255, 255, .07); }
.gkmm-seg button { border: 0; background: none; padding: 3px 9px; min-height: 26px; border-radius: 6px; cursor: pointer; font: 700 11.5px var(--gk-sans) !important; color: var(--gk-dim) !important; }
.gkmm-seg button[aria-pressed="true"] { background: rgba(255, 255, 255, .16); color: var(--gk-fg) !important; }
.gkm.gkm-touch .gkmm-seg button { min-height: 32px; padding: 4px 11px; }
.gkmm-lb small.gkmm-asn { margin-bottom: 4px; color: #bfe9ff; }
.gkmm-champ div { margin-top: 2px; }
.gkmm-lb ol { margin: 0; padding: 0; list-style: none; }
.gkmm-lb li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-size: calc(12.5 * var(--u1)); }
.gkmm-lb li i { font-style: normal; font: 700 calc(11 * var(--u1)) var(--gk-mono); color: var(--gk-faint); min-width: 18px; }
.gkmm-lb li:first-child i { color: #ffc94a; }
.gkmm-lb li span { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkmm-lb li u { text-decoration: none; font: 650 calc(10 * var(--u1)) var(--gk-sans); color: var(--gk-faint); white-space: nowrap; }
.gkmm-lb li b { font: 700 calc(12 * var(--u1)) var(--gk-mono); }
.gkmm-lb small { display: block; font-size: calc(12 * var(--u1)); color: var(--gk-dim); }
.gkmm-champ { margin-top: calc(10 * var(--u1)); padding: calc(8 * var(--u1)) calc(10 * var(--u1)); border-radius: 10px; font-size: calc(12.5 * var(--u1)); line-height: 1.4;
  background: rgba(255, 201, 74, .08); border: 1px solid rgba(255, 201, 74, .3); }
.gkmm-champ span { display: block; font-size: calc(10 * var(--u1)); font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: #ffc94a; }
.gkmm-champ b { font-weight: 750; }
.gkmm.gkmm-narrow .gkmm-sp { gap: 8px; margin-bottom: 8px; }
.gkmm.gkmm-narrow .gkmm-spc { padding: 9px 10px; gap: 8px; }
.gkmm.gkmm-narrow .gkmm-spc b { font-size: 14px; }
.gkmm.gkmm-narrow .gkmm-spc > svg { width: 24px; height: 24px; }
@media (max-width: 420px) { .gkmm.gkmm-narrow .gkmm-sp { grid-template-columns: minmax(0, 1fr); } }
`;

const stars = (n, total = 3) => { const s = document.createElement('span'); s.className = 'gkmm-stars'; s.innerHTML = STAR.repeat(total); for (let i = 0; i < n; i++) s.children[i].classList.add('on'); return s; };

export function mountMissions({ root, brand, foot, container, touch = false, start, catalog = SF_CATALOG, runways = null }) {
  const { MISSIONS, buildMission, dailyMissionId, loadProgress, totalStars, isUnlocked } = catalog;
  const map = catalog.map || 'sf';
  injectCSS('missions-menu', CSS);
  const narrowQ = matchMedia('(max-height: 520px), (max-width: 560px)');
  const narrow = () => narrowQ.matches;
  let progress = loadProgress();
  let day = istanbulDay();
  let daily = buildMission(dailyMissionId(day), day);
  let panel = null, timer = 0, sel = null;
  const seen = new Set();
  /** A player's look at a mission (click / arrow key; the automatic first selection is not one). */
  function viewed(id) {
    if (seen.has(id)) return;
    seen.add(id);
    trackEvent('mmenu', id === 'daily' ? { st: 'daily', id: daily.id } : id === 'weekly' ? { st: 'weekly', id: wk.key } : id === 'dland' ? { st: 'dland' } : { st: 'detail', id });
  }

  // ---------- retention: the weekly challenge and the day's landing ----------
  // two lists per board ("Elle" / "Destekli", src/retention/boards.js): tops[side] = { entries } | null (unavailable) |
  // undefined (loading); a list opens on the side of the player's latest result on that board, else "Elle"
  let week = currentWeek(), wk = weeklyPick(week), wkInfo = null, wkTops = {}, wkSide = lastList(wk.board) || 'm', wkChamp, wkShown = new Set();
  const dl = landingChallenges(map).find((c) => c.kind === 'daily-land');
  const dlNames = landingEndNames(runways);
  let dlEnd = dlNames.length ? dailyLandingEnd(dlNames, day, map) : null, dlTops = {}, dlSide = (dl && lastList(dl.board)) || 'm', dlTopDay = null;
  /** The pick's texts: its mission (this or the other map's catalog) or its free-flight challenge. */
  async function resolveInfo(p) {
    if (p.kind === 'mission') {
      const cat = p.map === map ? catalog : await loadMissionCatalog(p.map);
      const m = cat && cat.buildMission(p.mission);
      return m ? { title: m.title, aircraft: m.aircraft, brief: m.brief, goal: m.goal } : null;
    }
    let def = landingChallenges(p.map).find((c) => c.id === p.ff);
    if (!def) {
      const mod = await import('../missions/challenges.js');
      const set = await mod.loadChallengeSet(p.map);
      def = set && set.challenges.find((c) => c.id === p.ff);
    }
    return def ? { title: def.title, brief: def.hint, free: true } : null;
  }
  function loadWeekly() {
    const w = week, p = wk;
    resolveInfo(p).then((info) => { if (w !== week || destroyed) return; wkInfo = info; refreshEntry(); if (panel) rerender(); }).catch(() => {});
    loadWkSide('m');   // (the entry button shows the manual list's leader)
    if (wkSide !== 'm') loadWkSide(wkSide);
  }
  function loadWkSide(sd) {
    if (sd in wkTops) return;   // (loaded or loading)
    const w = week;
    wkTops[sd] = undefined;
    boardTop(boardFor(wk.board, sd === 'as'), { n: 10 }).then((t) => { if (w !== week || destroyed) return; wkTops[sd] = t; if (sd === 'm') refreshEntry(); if (panel && sel === 'weekly') rerender(); });
  }
  function loadChampion() {
    if (wkChamp !== undefined) return;
    wkChamp = 'loading';
    const w = week, pp = weeklyPick(addWeeks(week, -1));
    Promise.all([boardTop(pp.board, { n: 10 }), boardTop(boardFor(pp.board, true), { n: 10 }), resolveInfo(pp).catch(() => null)]).then(([t, ta, info]) => {
      if (w !== week) return;
      const top1 = (x) => (x && x.entries && x.entries[0] ? x.entries[0] : null);
      wkChamp = top1(t) || top1(ta) ? { m: top1(t), as: top1(ta), title: info ? info.title : '' } : null;
      if (panel && sel === 'weekly') rerender();
    });
  }
  function loadDland(sd = dlSide) {
    if (!dlEnd) return;
    if (dlTopDay !== day) { dlTopDay = day; dlTops = {}; }
    if (sd in dlTops) return;
    dlTops[sd] = undefined;
    const d = day;
    boardTop(boardFor(dl.board, sd === 'as'), { day: d, n: 10 }).then((t) => { if (d !== day) return; dlTops[sd] = t; if (panel && sel === 'dland') rerender(); });
  }
  const rerender = () => { if (panel) select(sel, panel.classList.contains('detail')); };
  loadWeekly();

  // ---------- entry: "Görevler" + "Günün görevi" ----------
  const entry = el('div', 'gkmm-entry');
  const eMain = el('button', 'gkmm-eb main', entry);
  eMain.type = 'button';
  eMain.innerHTML = TARGET;
  const eMainT = el('span', null, eMain);
  el('b', null, eMainT, 'Görevler');
  const eMainS = el('small', null, eMainT, '');
  const eDay = el('button', 'gkmm-eb daily', entry);
  eDay.type = 'button';
  eDay.innerHTML = CAL;
  const eDayT = el('span', null, eDay);
  const eDayB = el('b', null, eDayT, '');
  const eDayS = el('small', null, eDayT, '');
  const eWeek = el('button', 'gkmm-eb weekly', entry);
  eWeek.type = 'button';
  eWeek.innerHTML = CUP;
  const eWeekT = el('span', null, eWeek);
  const eWeekB = el('b', null, eWeekT, '');
  const eWeekS = el('small', null, eWeekT, '');
  function place() {
    const inFoot = touch && narrow();
    entry.classList.toggle('in-foot', inFoot);
    if (inFoot) foot.insertBefore(entry, foot.firstChild); else brand.appendChild(entry);
  }
  place();
  let destroyed = false;
  if (narrowQ.addEventListener) narrowQ.addEventListener('change', () => { if (destroyed) return; place(); if (panel) panel.classList.toggle('gkmm-narrow', narrow()); });
  function refreshEntry() {
    progress = loadProgress();
    const ts = totalStars(progress), done = MISSIONS.filter((m) => progress.missions[m.id] && progress.missions[m.id].done).length;
    eMainS.textContent = `${MISSIONS.length} görev · ${done} tamam · `;
    eMainS.append(stars(1, 1), ` ${ts}/${MISSIONS.length * 3}`);
    eDayB.textContent = 'Günün görevi';
    el('span', 't', eDayB, `: ${daily.title}`);
    eDayS.textContent = '';
    const dp = progress.daily[day];
    eDayS.append(`${AIRCRAFT_SHORT[daily.aircraft]} · ${dp ? `${fmtInt(dp.best)} puan · ` : ''}yenisi `);
    el('b', null, eDayS, fmtClock(secondsToNextDay()));
    eWeekB.textContent = 'Haftanın görevi';
    if (wkInfo) el('span', 't', eWeekB, `: ${wkInfo.title}`);
    eWeekS.textContent = `${wk.map !== map ? `${MAP_NAME[wk.map] || wk.map} · ` : ''}${wkInfo && wkInfo.free ? 'serbest uçuş · ' : wkInfo && wkInfo.aircraft ? `${AIRCRAFT_SHORT[wkInfo.aircraft]} · ` : ''}`;
    const lead = wkTops.m && wkTops.m.entries && wkTops.m.entries[0];
    if (lead) { eWeekS.append('lider '); el('b', null, eWeekS, fmtInt(lead.score)); }
    else { eWeekS.append('yeni hafta '); el('b', null, eWeekS, fmtLeft(secondsToNextWeek())); }
  }
  refreshEntry();
  eWeek.addEventListener('click', () => openPanel('weekly'));
  eMain.addEventListener('click', () => openPanel(null));
  eDay.addEventListener('click', () => { if (touch && narrow()) openPanel('daily'); else openPanel('daily'); });
  timer = setInterval(tick, 1000);
  function tick() {
    if (!root.isConnected) { clearInterval(timer); return; }
    const d = istanbulDay();
    if (d !== day) {
      day = d; daily = buildMission(dailyMissionId(day), day);
      dlEnd = dlNames.length ? dailyLandingEnd(dlNames, day, map) : null;
      const w = currentWeek();
      if (w !== week) { week = w; wk = weeklyPick(w); wkInfo = null; wkTops = {}; wkSide = lastList(wk.board) || 'm'; wkChamp = undefined; wkShown = new Set(); loadWeekly(); }
      refreshEntry();
      if (panel) renderPanel();
    }
    const cd = fmtClock(secondsToNextDay());
    const b = eDayS.querySelector('b');
    if (b) b.textContent = cd;
    if (panel) { const x = panel.querySelector('.gkmm-cd b'); if (x) x.textContent = cd; }
  }

  // ---------- panel ----------
  let cards = [], dayBtn = null, wkBtn = null, dlBtn = null, side = null, list = null;
  function openPanel(which) {
    if (panel) return;
    trackEvent('mmenu', { st: 'open', via: which === 'daily' || which === 'weekly' ? which : 'tab' });
    if (which === 'daily' || which === 'weekly') viewed(which);
    shared.modalOpen = (shared.modalOpen || 0) + 1;
    panel = el('div', 'gkmm', root);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Görevler');
    panel.classList.toggle('gkmm-narrow', narrow());
    renderPanel();
    const first = which === 'daily' || which === 'weekly' ? which : MISSIONS.find((m) => isUnlocked(m, progress) && !(progress.missions[m.id] && progress.missions[m.id].stars === 3)) || MISSIONS[0];
    select(typeof first === 'string' ? first : first.id, (which === 'daily' || which === 'weekly') && narrow());
    window.addEventListener('keydown', onKey, true);
  }
  function closePanel() {
    if (!panel) return;
    panel.remove(); panel = null;
    shared.modalOpen = Math.max(0, (shared.modalOpen || 1) - 1);
    window.removeEventListener('keydown', onKey, true);
    refreshEntry();
  }
  function renderPanel() {
    panel.textContent = '';
    progress = loadProgress();
    const head = el('div', 'gkmm-head', panel);
    const back = el('button', 'gkmm-back', head, '← Serbest uçuş');
    back.type = 'button';
    back.addEventListener('click', () => { if (panel.classList.contains('detail')) { panel.classList.remove('detail'); return; } closePanel(); });
    el('h2', null, head, 'Görevler');
    const tot = el('div', 'gkmm-total', head);
    tot.innerHTML = STAR;
    tot.append(`${totalStars(progress)} / ${MISSIONS.length * 3}`);
    list = el('div', 'gkmm-list', panel);
    // daily
    dayBtn = el('button', 'gkmm-day', list);
    dayBtn.type = 'button';
    dayBtn.innerHTML = CAL;
    const dt = el('span', null, dayBtn);
    el('i', null, dt, `Günün görevi · ${dayLabel(day)}`);
    el('b', null, dt, daily.title);
    const dp = progress.daily[day];
    el('small', null, dt, `${AIRCRAFT_SHORT[daily.aircraft]} · ${daily.note}${dp ? ` · en iyin ${fmtInt(dp.best)}` : ''}`);
    const cd = el('span', 'gkmm-cd', dayBtn);
    el('small', null, cd, 'Yeni görev');
    el('b', null, cd, fmtClock(secondsToNextDay()));
    dayBtn.addEventListener('click', () => { viewed('daily'); select('daily', true); });
    dayBtn.addEventListener('dblclick', () => go());
    // weekly challenge + the day's landing
    const sp = el('div', 'gkmm-sp', list);
    wkBtn = el('button', 'gkmm-spc wk', sp);
    wkBtn.type = 'button';
    wkBtn.innerHTML = CUP;
    const wt = el('span', null, wkBtn);
    el('i', null, wt, `Haftanın görevi · ${+week.slice(4)}. hafta`);
    el('b', null, wt, wkInfo ? wkInfo.title : '…');
    el('small', null, wt, `${wk.map !== map ? `${MAP_NAME[wk.map] || wk.map} · ` : ''}${wkInfo && wkInfo.free ? 'serbest uçuş' : wkInfo && wkInfo.aircraft ? AIRCRAFT_SHORT[wkInfo.aircraft] : ''} · yeni hafta ${fmtLeft(secondsToNextWeek())}`);
    wkBtn.addEventListener('click', () => { viewed('weekly'); select('weekly', true); });
    wkBtn.addEventListener('dblclick', () => go());
    dlBtn = null;
    if (dl && dlEnd) {
      dlBtn = el('button', 'gkmm-spc dl', sp);
      dlBtn.type = 'button';
      dlBtn.innerHTML = RWY;
      const dt2 = el('span', null, dlBtn);
      el('i', null, dt2, `Günün inişi · ${dayLabel(day)}`);
      el('b', null, dt2, endLabel(dlEnd));
      const best = dlBest();
      el('small', null, dt2, `Serbest uçuş · her uçak${best ? ` · en iyin ${fmtInt(best.best)}` : ''}`);
      dlBtn.addEventListener('click', () => { viewed('dland'); select('dland', true); });
      dlBtn.addEventListener('dblclick', () => go());
    }
    // cards
    const grid = el('div', 'gkmm-grid', list);
    cards = MISSIONS.map((m, i) => {
      const p = progress.missions[m.id];
      const locked = !isUnlocked(m, progress);
      const b = el('button', `gkmm-card${locked ? ' locked' : ''}`, grid);
      b.type = 'button';
      b.dataset.id = m.id;
      el('span', 'n', b, String(i + 1).padStart(2, '0'));
      el('span', 't', b, m.title);
      const meta = el('span', 'm', b, `${AIRCRAFT_SHORT[m.aircraft]} · ~${m.minutes} dk · `);
      el('span', `gkmm-lvl l${m.level}`, meta, LEVEL_LABEL[m.level]);
      const f = el('span', 'f', b, p && p.done ? `${fmtInt(p.best)} puan` : locked ? '' : 'yeni');
      f.append(stars(p ? p.stars || 0 : 0));
      if (locked) { const l = el('span', 'gkmm-lock', b); l.innerHTML = LOCK; l.append(`${m.unlock} yıldız`); }
      b.addEventListener('click', () => { viewed(m.id); select(m.id, true); });
      b.addEventListener('dblclick', () => { if (!locked) go(); });
      return b;
    });
    side = el('div', 'gkmm-side', panel);
    if (sel) select(sel, panel.classList.contains('detail'));
  }
  /** Today's best in the day's landing (free-flight progress, src/missions/challenges.js: <id>@YYYYMMDD). */
  function dlBest() {
    try { const st = JSON.parse(localStorage.getItem(map === 'sf' ? 'gokyuzu.ffc' : `gokyuzu.ffc.${map}`) || 'null'); const p = st && st.e && st.e[`${dl.id}@${day}`]; return p && p.done ? p : null; } catch { return null; }
  }
  /** A top 10 with the "Elle / Destekli" switch; onSide(side) switches (the caller loads and re-renders). */
  function boardList(det, top, title, { showAc = false, side = 'm', onSide = null } = {}) {
    const lb = el('div', 'gkmm-lb', det);
    if (top === null && side === 'm') { lb.remove(); return null; }   // the service is unavailable (and the local dev server): no table
    const h = el('div', 'gkmm-lbh', lb);
    el('h4', null, h, title);
    if (onSide) {
      const seg = el('span', 'gkmm-seg', h);
      for (const [sd, label] of [['m', 'Elle'], ['as', 'Destekli']]) {
        const b = el('button', null, seg, label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(sd === side));
        b.addEventListener('click', (e) => { e.stopPropagation(); if (sd !== side) onSide(sd); });
      }
    }
    if (side === 'as') el('small', 'gkmm-asn', lb, 'Destekli uçuş listesi · elle uçarak ana listeye girebilirsin');
    if (top === undefined) { el('small', null, lb, 'Sıralama yükleniyor…'); return lb; }
    if (!top || !top.entries || !top.entries.length) { el('small', null, lb, 'Henüz skor yok: ilk sen ol!'); return lb; }
    const ol = el('ol', null, lb);
    for (const x of top.entries.slice(0, 10)) {
      const li = el('li', null, ol);
      el('i', null, li, String(x.rank));
      el('span', null, li, x.name || 'İsimsiz pilot');
      if (showAc && x.ac) el('u', null, li, AIRCRAFT_SHORT[x.ac] || x.ac);
      el('b', null, li, fmtInt(x.score));
    }
    return lb;
  }
  function goButton(label, sub) {
    const btn = el('button', 'gkmm-go', side);
    btn.type = 'button';
    const bl = el('span', null, btn);
    el('b', null, bl, label);
    el('small', null, bl, ` ${sub}`);
    if (!touch) el('kbd', null, btn, 'Enter');
    btn.addEventListener('click', () => go());
    return btn;
  }
  function detailWeekly() {
    const det = el('div', 'gkmm-det', side);
    const k = el('div', 'k', det);
    el('b', null, k, `Haftanın görevi · ${weekLabel(week)}`);
    if (wk.map !== map) el('span', null, k, MAP_NAME[wk.map] || wk.map);
    if (wkInfo && wkInfo.aircraft) el('span', null, k, AIRCRAFT_SHORT[wkInfo.aircraft]);
    if (wkInfo && wkInfo.free) el('span', null, k, 'Serbest uçuş · her uçak');
    el('h3', null, det, wkInfo ? wkInfo.title : 'Yükleniyor…');
    if (wkInfo) el('p', null, det, wkInfo.brief);
    if (wkInfo && wkInfo.goal) { const g = el('div', 'gkmm-goal', det); el('span', null, g, 'Hedef'); g.append(wkInfo.goal); }
    el('div', 'gkmm-note', det, `Bir hafta boyunca herkes aynı görevde: en iyi skorun haftalık sıralamaya girer. Yeni hafta ${fmtLeft(secondsToNextWeek())} sonra.`);
    loadWkSide(wkSide);
    const top = wkTops[wkSide];
    const lb = boardList(det, top, 'Bu haftanın ilk 10\'u', { showAc: !!(wkInfo && wkInfo.free), side: wkSide,
      onSide: (sd) => { wkSide = sd; loadWkSide(sd); rerender(); } });
    if (lb && top && top.entries && !wkShown.has(wkSide)) { wkShown.add(wkSide); trackEvent('wk', { st: 'show', id: wk.key, c: top.entries.length, as: wkSide === 'as' ? 1 : undefined }); }
    loadChampion();
    if (wkChamp && wkChamp !== 'loading') {
      const c = el('div', 'gkmm-champ', det);
      el('span', null, c, `Geçen haftanın şampiyonu${wkChamp.title ? ` · ${wkChamp.title}` : ''}`);
      const line = (x, label) => { const d = el('div', null, c); el('b', null, d, x.name || 'İsimsiz pilot'); d.append(` · ${fmtInt(x.score)} puan${label}`); };
      if (wkChamp.m) line(wkChamp.m, '');
      if (wkChamp.as) line(wkChamp.as, ' · Destekli');
    }
    goButton(wkInfo && wkInfo.free ? 'Uç' : 'Başla', wkInfo && wkInfo.free ? `seçili uçakla · ${MAP_NAME[wk.map] || ''}` : `${wkInfo && wkInfo.aircraft ? AIRCRAFT_SHORT[wkInfo.aircraft] : ''} · haftanın görevi`);
  }
  function detailDland() {
    loadDland();
    const det = el('div', 'gkmm-det', side);
    const k = el('div', 'k', det);
    el('b', null, k, `Günün inişi · ${dayLabel(day)}`);
    el('span', null, k, 'Serbest uçuş');
    el('span', null, k, 'her uçak');
    el('h3', null, det, `Günün inişi: ${endLabel(dlEnd)}`);
    el('p', null, det, dl.hint);
    el('div', 'gkmm-note', det, 'Uç: seçili uçakla bu pistin son yaklaşmasından başlarsın. İniş puanın × 20 günün sıralamasına girer; yarın başka pist.');
    const best = dlBest();
    if (best) { const b = el('div', 'gkmm-best', det, `Bugünkü en iyin: ${fmtInt(best.best)} puan  `); b.append(stars(best.stars || 0)); }
    boardList(det, dlTops[dlSide], 'Günün sıralaması', { showAc: true, side: dlSide, onSide: (sd) => { dlSide = sd; loadDland(sd); rerender(); } });
    goButton('Uç', `seçili uçakla · ${endLabel(dlEnd)}`);
  }
  function select(id, userDetail = false) {
    sel = id;
    if (!panel) return;
    for (const c of cards) c.setAttribute('aria-selected', String(c.dataset.id === id));
    dayBtn.setAttribute('aria-selected', String(id === 'daily'));
    if (wkBtn) wkBtn.setAttribute('aria-selected', String(id === 'weekly'));
    if (dlBtn) dlBtn.setAttribute('aria-selected', String(id === 'dland'));
    if (id === 'weekly' || (id === 'dland' && dlEnd)) {
      side.textContent = '';
      if (id === 'weekly') detailWeekly(); else detailDland();
      if (narrow() && userDetail) panel.classList.add('detail');
      const card = id === 'weekly' ? wkBtn : dlBtn;
      if (card && !narrow()) card.scrollIntoView({ block: 'nearest' });
      return;
    }
    const m = id === 'daily' ? daily : buildMission(id);
    const def = MISSIONS.find((x) => x.id === m.id);
    const locked = id !== 'daily' && !isUnlocked(def, progress);
    side.textContent = '';
    const det = el('div', 'gkmm-det', side);
    const k = el('div', 'k', det);
    el('b', null, k, id === 'daily' ? `Günün görevi · ${dayLabel(day)}` : `Görev ${MISSIONS.indexOf(def) + 1}`);
    el('span', null, k, AIRCRAFT_SHORT[m.aircraft]);
    el('span', null, k, `~${m.minutes} dk`);
    el('span', null, k, LEVEL_LABEL[m.level]);
    el('h3', null, det, m.title);
    el('p', null, det, m.brief);
    const g = el('div', 'gkmm-goal', det);
    el('span', null, g, 'Hedef');
    g.append(m.goal);
    if (m.note) el('div', 'gkmm-note', det, `Bugünün farkı: ${m.note}`);
    const crit = el('div', 'gkmm-crit', det);
    if (m.stars === 'landing') { const r = el('div', null, crit); r.append(stars(3), ' İniş puanın kadar yıldız'); }
    else if (m.stars === 'ditch') { const r = el('div', null, crit); r.append(stars(3), ' Suya iniş kalitesine göre'); }
    else {
      const lab = ['Görevi tamamla', `${fmtInt(m.stars[1])} puan`, `${fmtInt(m.stars[2])} puan`];
      for (let i = 0; i < 3; i++) { const r = el('div', null, crit); r.append(stars(i + 1), ` ${lab[i]}`); }
    }
    if (m.limit) el('div', null, crit, `Süre sınırı: ${fmtTime(m.limit)}`);
    const p = id === 'daily' ? progress.daily[day] : progress.missions[m.id];
    if (p && (p.best || p.done)) { const b = el('div', 'gkmm-best', det, `En iyin: ${fmtInt(p.best || 0)} puan  `); b.append(stars(p.stars || 0)); }
    if (locked) el('div', 'gkmm-lockmsg', det, `Toplam ${def.unlock} yıldızla açılır (şu an ${totalStars(progress)}). Önceki görevlerden yıldız topla.`);
    const btn = el('button', `gkmm-go${locked ? ' alt' : ''}`, side);
    btn.type = 'button';
    const bl = el('span', null, btn);
    el('b', null, bl, locked ? 'Kilitli' : 'Başla');
    el('small', null, bl, ` ${AIRCRAFT_SHORT[m.aircraft]}${m.day ? ' · günün görevi' : ''}`);
    if (!touch && !locked) el('kbd', null, btn, 'Enter');
    btn.disabled = locked;
    btn.addEventListener('click', () => go());
    if (narrow() && userDetail) panel.classList.add('detail');
    const card = id === 'daily' ? dayBtn : cards.find((c) => c.dataset.id === id);
    if (card && !narrow()) card.scrollIntoView({ block: 'nearest' });
  }
  function go() {
    if (!sel) return;
    if (sel === 'daily') { closePanel(); clearInterval(timer); start({ id: daily.id, daily: day }); return; }
    if (sel === 'weekly') {
      if (!wkInfo) return;
      trackEvent('wk', { st: 'play', id: wk.key });
      closePanel(); clearInterval(timer);
      if (wk.kind === 'mission') start({ id: wk.mission, daily: null, map: wk.map });
      else start({ free: true, map: wk.map, spawn: wk.spawn, track: wk.ff });
      return;
    }
    if (sel === 'dland') {
      if (!dlEnd) return;
      const [airport, ident] = dlEnd.split(' ');
      closePanel(); clearInterval(timer);
      start({ free: true, map, airport, ident, track: dl.id, final: true });
      return;
    }
    const def = MISSIONS.find((x) => x.id === sel);
    if (!def || !isUnlocked(def, progress)) return;
    closePanel(); clearInterval(timer);
    start({ id: sel, daily: null });
  }
  function onKey(e) {
    if (!panel) return;
    e.stopPropagation();
    if (e.type !== 'keydown' || e.metaKey || e.ctrlKey || e.altKey) return;
    const ids = ['daily', 'weekly', ...(dlBtn ? ['dland'] : []), ...MISSIONS.map((m) => m.id)];
    const i = ids.indexOf(sel);
    if (e.code === 'Escape') { e.preventDefault(); if (panel.classList.contains('detail')) panel.classList.remove('detail'); else closePanel(); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); go(); }
    else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') { e.preventDefault(); const n = ids[(i + 1) % ids.length]; viewed(n); select(n); }
    else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') { e.preventDefault(); const n = ids[(i - 1 + ids.length) % ids.length]; viewed(n); select(n); }
  }

  return {
    open: openPanel, close: closePanel, get isOpen() { return !!panel; }, daily: () => ({ id: daily.id, day, title: daily.title }), select, go,
    weekly: () => ({ ...wk, info: wkInfo, tops: wkTops, side: wkSide, champion: wkChamp }), dailyLanding: () => ({ end: dlEnd, id: dl && dl.id, board: dl && dl.board }),
    /** The menu switched maps: remove the entry (a new mount shows the other map's missions). */
    destroy() { destroyed = true; closePanel(); clearInterval(timer); entry.remove(); },
  };
}
