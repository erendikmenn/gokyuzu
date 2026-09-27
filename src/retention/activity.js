// Browser glue of the daily streak (src/retention/streak.js): what counts as a finished flight, the telemetry, the HUD
// accent of the picked badge. Used by the free-flight runtime (src/missions/ff-runtime.js), the mission hooks
// (src/retention/mission-hooks.js) and the menu (src/retention/menu-strip.js).
//
//   noteActivity(kind) → { newDay, current, unlocked } | null     kind: 'mission' | 'landing' | 'air' | 'ffc'
//   noteLanding(ok) → { cur, unlocked }                           free flight: runway landings in a row (badge)
//   applyAccent()                                                 the picked badge's colour on the gameplay UI
// Telemetry `streak` (never personal: counts in buckets): day (b = streak bucket, k = what finished the day), badge (id),
// pick (id | none: the badge chosen in the menu), open (the menu's streak card opened).
import { readStreak, writeStreak, recordDay, recordLanding, pickedBadge, bucket } from './streak.js';
import { istanbulDay } from '../missions/util.js';
import { trackEvent } from '../core/telemetry.js';

const KIND = { mission: 'm', landing: 'l', air: 'a', ffc: 'c' };

/** A finished flight or mission today: the day joins the streak (once per day). */
export function noteActivity(kind) {
  try {
    const s = readStreak();
    const r = recordDay(s, istanbulDay());
    if (!r.newDay) return r;
    writeStreak(s);
    trackEvent('streak', { st: 'day', b: bucket(r.current), k: KIND[kind] || kind });
    for (const b of r.unlocked) trackEvent('streak', { st: 'badge', id: b.id });
    return r;
  } catch { return null; }
}

/** A free-flight landing: ok = on a runway with at least one star. */
export function noteLanding(ok) {
  try {
    const s = readStreak();
    if (!ok && s.land.cur === 0) return { cur: 0, unlocked: [] };
    const r = recordLanding(s, ok, istanbulDay());
    writeStreak(s);
    for (const b of r.unlocked) trackEvent('streak', { st: 'badge', id: b.id });
    return r;
  } catch { return null; }
}

/** HUD accent: the picked badge's colour replaces the teal accent of the HUD, mission and challenge panels. */
export function applyAccent(s = null) {
  try {
    const b = pickedBadge(s || readStreak());
    const root = document.documentElement;
    if (!b) { root.removeAttribute('data-gk-accent'); root.style.removeProperty('--gkr-accent'); return; }
    root.setAttribute('data-gk-accent', b.id);
    root.style.setProperty('--gkr-accent', b.color);
    if (!document.querySelector('style[data-gk="retention-accent"]')) {
      const st = document.createElement('style');
      st.dataset.gk = 'retention-accent';
      // (custom properties inherit: the HUD and the layers mounted in it read --gk-teal from here instead of :root)
      st.textContent = 'html[data-gk-accent] .gkh { --gk-teal: var(--gkr-accent); }';   // the HUD root (its layers: missions, challenges, landing card)
      document.head.appendChild(st);
    }
  } catch { /* no DOM */ }
}

/** A short line for a toast / result card: '🔥 3 gün seri!' (+ a new badge). */
export function streakLine(r) {
  if (!r || !r.newDay) return '';
  const b = r.unlocked && r.unlocked[r.unlocked.length - 1];
  return `🔥 ${r.current} gün seri${r.current > 1 ? '!' : ': yarın da uç, 2 gün olsun'}${b ? ` · Yeni rozet: ${b.title}` : ''}`;
}
