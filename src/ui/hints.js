// Contextual hints: one-line messages when the player does something that does not work (wheel brakes in the air,
// sitting at idle on the runway, gear up close to the ground, …). Each rule has a condition that must hold for a
// moment, a cooldown and a per-session cap; a rule stays quiet while the tutorial card shows the same topic, and at
// most one hint is on screen. Also: plain-Turkish crash explanations with one tip (used by the HUD crash card and
// the crash telemetry code).
//
//   createHints(parent, { busy(topic) }) → { begin(category), update(dt, ctx | null), reset(), setEnabled(on), current() }
//   explainCrash(reason, category, keys?) → { code, text, tip }
// ctx is the per-frame context of src/ui/tutorial.js (flight, input state, key labels, speeds in kt, view). Low-speed
// rules follow the flight models' flags (src/flight: warnings.lowEnergy / alphaFloor / togaLock (A320), lowSpeed
// (fighters), stall); the autopilot-disconnect rule polls the audio system (window.__audioSys.debug().apd).
import { injectCSS } from './styles.js';
import { el, richText, plainText, storageGet, storageSet } from './util.js';
import { keySet } from './tutorial-keys.js';
import { shared } from './shared.js';
import { IS_MAC } from '../core/platform.js';

const SEEN_KEY = 'gokyuzu.hintsSeen';        // hints shown once per browser (cockpit mouse look)
const SHOW_SECONDS = 6.5;
const GAP_SECONDS = 5;                        // quiet time between two different hints

const CSS = `
.gkt-hint { display: none; align-items: center; gap: calc(10px * var(--ts)); box-sizing: border-box; max-width: min(calc(100vw - 32px), calc(560px * var(--ts)));
  padding: calc(7px * var(--ts)) calc(18px * var(--ts)) calc(7px * var(--ts)) calc(8px * var(--ts)); border-radius: calc(22px * var(--ts));
  font-size: calc(14px * var(--ts)); font-weight: 600; line-height: 1.4; border-color: rgba(255, 176, 32, .5); }
.gkt-hint.on { display: flex; animation: gkt-hint-in .38s cubic-bezier(.2, .9, .3, 1.2) both; }
.gkt-hint.out { animation: gkt-hint-out .3s ease forwards; }
@keyframes gkt-hint-in { from { opacity: 0; transform: translateY(8px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes gkt-hint-out { to { opacity: 0; transform: translateY(6px) scale(.97); } }
.gkt-hint-i { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: calc(26px * var(--ts)); height: calc(26px * var(--ts));
  border-radius: 50%; color: var(--gk-caution); background: rgba(255, 176, 32, .15); }
.gkt-hint-i svg { width: 60%; height: 60%; }
.gkt-hint-t { text-wrap: balance; }
.gkt-hint-t kbd.gk-ikbd { font-size: calc(12px * var(--ts)); }
.gkt-hint.info { border-color: rgba(92, 242, 200, .42); }
.gkt-hint.info .gkt-hint-i { color: var(--gk-teal); background: rgba(92, 242, 200, .13); }
.gkt-hint.warn { border-color: rgba(255, 77, 79, .6); }
.gkt-hint.warn .gkt-hint-i { color: #ff6b6d; background: rgba(255, 77, 79, .16); }
`;
const ICON_CAUTION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="M12 19.5v.01"/></svg>';
const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/></svg>';

const fixedWing = (c) => c.cat !== 'helicopter';
const MS_KT = 1.943844;
const warn = (c) => (c.f && c.f.warnings) || {};
/** A low-speed state the flight model flags (A320 low energy / alpha floor, fighter low speed, stall warning / stall). */
const slowFlag = (c) => { const w = warn(c); return !!(w.lowEnergy || w.alphaFloor || w.lowSpeed || w.stall || c.f.stalled); };
/** Fixed wing: thrust lever at idle and the speed bleeding off, after a takeoff or already slow (not descending to land). */
function idleDecay(c, s) {
  const f = c.f;
  if (!fixedWing(c) || f.onGround || f.agl < 10 || c.ap || c.lever > 0.1 || f.athrMode || s.ktRate > -0.4) return false;
  const vs1g = f.vSpeeds && f.vSpeeds.vs1g > 0 ? f.vSpeeds.vs1g * MS_KT : 0;
  const slow = vs1g > 0 && c.kt < vs1g * 1.2;
  return slow || (s.sinceTakeoff < 300 && f.verticalSpeed > -2);
}
/** The audio system is sounding an autopilot-disconnect alert (A320 cavalry charge, 737 wailer). */
function apDisconnectAlert() {
  try {
    const a = typeof window !== 'undefined' ? window.__audioSys : null;
    const d = a && typeof a.debug === 'function' ? a.debug() : null;
    return !!(d && d.apd);
  } catch { return false; }
}
/** "{Shift} / {9}" (thrust up, and the 90 % / MIL preset on a keyboard). */
const thrUp9 = (k) => `${k.chip('thrUp')}${k.kb ? ' / {9}' : ''}`;

// id, topic, tone, after (s the condition must hold), cooldown (s), cap (per session), once (per browser), cond(c), text(k, c)
const RULES = [
  {
    // A320 FAC low-energy warning ("SPEED SPEED SPEED"): thrust is needed now
    id: 'lowEnergy', topic: 'stall', tone: 'warn', after: 0.3, cooldown: 20, cap: 4,
    cond: (c) => fixedWing(c) && !!warn(c).lowEnergy,
    text: (k) => `Enerji düşük (SPEED SPEED SPEED): gazı artır ${k.chip('thrUp')}${k.kb ? ', gerekirse tam gaz {0}' : ''}.`,
  },
  {
    // A320 alpha floor: the A/THR has set TOGA thrust by itself
    id: 'alphaFloor', topic: 'stall', tone: 'warn', after: 0.2, cooldown: 40, cap: 2,
    cond: (c) => fixedWing(c) && !!warn(c).alphaFloor,
    text: (k) => `A.FLOOR: hız çok düştü, motorlar kendiliğinden tam güce geçti. Burnu hafifçe indir ${k.chip('pitchDown')}, hız artsın.`,
  },
  {
    // fighters: at the AoA limiter out of energy (gear up) / above the approach AoA (gear down)
    id: 'lowSpeed', topic: 'stall', tone: 'warn', after: 0.3, cooldown: 20, cap: 4,
    cond: (c) => fixedWing(c) && !!warn(c).lowSpeed,
    text: (k) => `Hız çok düşük, hücum açısı sınırda: burnu indir ${k.chip('pitchDown')}, gaz ver ${thrUp9(k)}.`,
  },
  {
    // helicopter: collective at the bottom while airborne and sinking (autorotation without a plan)
    id: 'lowCollective', topic: 'throttle', tone: 'warn', after: 0.6, cooldown: 20, cap: 4,
    cond: (c) => c.cat === 'helicopter' && !c.f.onGround && c.f.agl > 4 && (c.f.collective ?? c.lever) < 0.12 && c.f.verticalSpeed < -4,
    text: (k) => `Kolektif çok düşük: ${k.chip('thrUp')} ile artır.`,
  },
  {
    // power cut after takeoff (or while slow): the speed bleeds off long before any warning
    id: 'idleDecay', topic: 'throttle', tone: 'caution', after: 2.5, cooldown: 45, cap: 3,
    cond: (c, s) => idleDecay(c, s) && !slowFlag(c),
    text: (k) => `Gaz kesildi, hız düşüyor: gazı aç ${thrUp9(k)} ve burnu hafifçe indir ${k.chip('pitchDown')}.`,
  },
  {
    // A320 TOGA LK after alpha floor: thrust stays at TOGA until the lever is moved into CL…TOGA (or pulled back)
    id: 'togaLock', topic: 'throttle', tone: 'caution', after: 4, cooldown: 60, cap: 2,
    cond: (c) => fixedWing(c) && !!warn(c).togaLock && c.lever < 0.85,
    text: (k) => (!k.kb
      ? `TOGA LK: motorlar tam güçte kilitli. Gazı geri almak için ${k.chip('thrUp')} ile kolu sonuna kadar ileri al, sonra ${k.chip('thrDown')} ile ayarla.`
      : `TOGA LK: motorlar tam güçte kilitli. Gazı geri almak için {9} tuşuna bas, sonra ${k.chip('thrDown')} ile ayarla.`),
  },
  {
    // the autopilot-disconnect alert keeps sounding (involuntary disconnect: until acknowledged)
    id: 'apAlert', topic: 'autopilot', tone: 'info', after: 3, cooldown: 45, cap: 3,
    cond: (c, s) => s.apd && !c.ap,
    text: (k) => `Otopilot kapandı — uyarıyı susturmak için ${k.chip('autopilot')}.`,
  },
  {
    id: 'brakeAir', topic: 'brake', tone: 'caution', after: 0.45, cooldown: 40, cap: 3,
    cond: (c) => c.inp.brake > 0.3 && !c.f.onGround && c.f.agl > 8,
    text: (k, c) => (fixedWing(c)
      ? `Tekerlek freni havada çalışmaz: hava freni ${k.chip('speedbrake')}, gazı azalt ${k.chip('thrDown')}.`
      : `Tekerlek freni havada çalışmaz: yavaşlamak için burnu kaldır ${k.chip('pitchUp')}.`),
  },
  {
    id: 'stall', topic: 'stall', tone: 'warn', after: 0.35, cooldown: 25, cap: 4,
    cond(c) {
      const f = c.f;
      if (!fixedWing(c) || f.onGround || f.agl < 15) return false;
      if ((f.warnings && f.warnings.stall) || f.stalled) return true;
      // airliners: well below the minimum selectable speed in clean configuration (the HUD's amber band)
      const vls = f.vSpeeds && f.vSpeeds.vls;
      return c.cat === 'airliner' && vls > 0 && !c.ap && !f.gearHandleDown && f.agl > 60 && f.ias < vls * 0.9;
    },
    text: (k) => `Hız kaybı! Burnu indir ${k.chip('pitchDown')}, gaz ver ${k.chip('thrUp')}.`,
  },
  {
    id: 'gearUp', topic: 'gear', tone: 'caution', after: 1, cooldown: 30, cap: 3,
    cond(c, s) {
      const f = c.f;
      if (!fixedWing(c) || f.onGround || f.gearHandleDown !== false) return false;
      if (slowFlag(c) || f.athrMode || idleDecay(c, s) || (s.sinceTakeoff < 300 && c.lever < 0.1)) return false;   // losing speed, not landing
      if (f.agl < 5 || f.agl > 300 || f.verticalSpeed > -2) return false;
      const vref = (f.vSpeeds && f.vSpeeds.vref) || (c.spec && c.spec.vRef) || 70;
      return (f.warnings && f.warnings.gear) || f.ias < vref * 1.5;
    },
    text: (k) => `İniş takımı yukarıda! İnmeden önce ${k.press('gear')}.`,
  },
  {
    id: 'idle', topic: 'idle', tone: 'info', after: 20, cooldown: 60, cap: 2,
    cond: (c) => c.f.onGround && c.gsKt < 1 && c.lever < 0.08,
    text: (k, c) => (fixedWing(c)
      ? `Kalkış için gaz ver: ${k.hold('thrUp')}${k.kb ? ' ya da {9} tuşuna bas' : ''}.`
      : `Havalanmak için kolektifi artır: ${k.hold('thrUp')}.`),
  },
  {
    id: 'rotate', topic: 'rotate', tone: 'caution', after: 1.5, cooldown: 30, cap: 3,
    cond: (c) => fixedWing(c) && c.f.onGround && c.kt > c.vr + 12 && c.lever > 0.5 && c.inp.pitch < 0.3 && !(c.f.reverser > 0.05),
    text: (k) => `Kalkış hızını geçtin: ${k.hold('pitchUp')}, burun kalksın.`,
  },
  {
    id: 'lowRotor', topic: 'lowRotor', tone: 'warn', after: 0.5, cooldown: 30, cap: 3,
    cond: (c) => c.cat === 'helicopter' && !!(c.f.warnings && c.f.warnings.lowRotor),
    text: (k) => `Rotor devri düşük! Kolektifi biraz azalt ${k.chip('thrDown')}.`,
  },
  {
    // Windows / Linux: Ctrl does nothing there (and Ctrl+W closes the tab)
    id: 'ctrl', topic: 'ctrl', tone: 'info', after: 0, cooldown: 60, cap: 2,
    cond: (c, s) => s.ctrl && c.k.kb,
    text: () => 'Gazı azaltmak için {Z} ya da {−} (Ctrl+W sekmeyi kapatır).',
  },
  {
    id: 'cockpit', topic: 'cockpit', tone: 'info', after: 1, cooldown: 0, cap: 1, once: true, show: 8,
    cond: (c) => c.view === 'cockpit',
    text: (k) => (k.touch ? 'Etrafa bakmak için ekranın ortasında parmağını sürükle; çift dokunuş bakışı ortalar.' : 'Etrafa bakmak için fareyle sürükle; çift tık bakışı ortalar.'),
  },
];

export function createHints(parent, { busy = () => false } = {}) {
  injectCSS('hints', CSS);
  const pill = el('div', 'gkt-hint gkt-glass');
  parent.insertBefore(pill, parent.firstChild);
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  const icon = el('span', 'gkt-hint-i', pill);
  const txt = el('span', 'gkt-hint-t', pill);
  const st = RULES.map((r) => ({ r, t: 0, last: -1e9, count: 0 }));
  const seen = storageGet(SEEN_KEY) || {};
  // per-frame state for the rules: Ctrl pressed (Windows), IAS trend (kt/s, 1 s filter), time since the takeoff event,
  // autopilot-disconnect alert sounding (polled twice a second)
  const flags = { ctrl: false, ktRate: 0, sinceTakeoff: Infinity, apd: false };
  let enabled = true, now = 0, showT = 0, gapT = 0, cur = null, outTimer = 0;
  let prevKt = null, takeoffAt = null, apdT = 0;

  if (!IS_MAC) {
    window.addEventListener('keydown', (e) => {
      if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && !e.repeat) flags.ctrl = true;
    });
  }
  // the cockpit hint goes away once the player looks around
  window.addEventListener('pointerdown', () => { if (cur && cur.r.id === 'cockpit' && showT > 1.5) showT = 1.5; });

  function show(s, c) {
    const r = s.r;
    clearTimeout(outTimer);
    richText(txt, String(r.text(c.k, c)).replace(/^(\s*)(\p{Ll})/u, (m, sp, ch) => sp + ch.toLocaleUpperCase('tr')));
    icon.innerHTML = r.tone === 'info' ? ICON_INFO : ICON_CAUTION;
    pill.className = `gkt-hint gkt-glass ${r.tone}`;
    void pill.offsetWidth;          // restart the entry animation when a hint replaces another
    pill.classList.add('on');
    cur = s; s.count++; s.last = now; s.t = 0;
    showT = r.show || SHOW_SECONDS;
    gapT = showT + GAP_SECONDS;
    if (r.once) { seen[r.id] = 1; storageSet(SEEN_KEY, seen); }
  }
  function hide(now_) {
    if (!cur) return;
    cur = null;
    if (now_) { pill.classList.remove('on', 'out'); return; }
    pill.classList.add('out');
    outTimer = setTimeout(() => pill.classList.remove('on', 'out'), 300);
  }

  return {
    begin() { for (const s of st) { s.t = 0; } },
    setEnabled(on) { enabled = !!on; if (!enabled) hide(true); },
    reset() {
      for (const s of st) s.t = 0;
      flags.ctrl = false; flags.ktRate = 0; flags.apd = false; prevKt = null; takeoffAt = null;
      hide(true); showT = 0;
    },
    /** dt = 0 / c = null while paused: timers hold. */
    update(dt, c) {
      if (!c || !c.f) return;
      now += dt;
      if (cur) {
        // a hint whose topic the tutorial now covers makes way for the card
        if ((showT -= dt) <= 0 || busy(cur.r.topic)) hide(false);
      }
      gapT -= dt;
      if (dt > 0) {
        if (prevKt != null) flags.ktRate += ((c.kt - prevKt) / dt - flags.ktRate) * Math.min(1, dt / 1.0);
        prevKt = c.kt;
        if ((apdT -= dt) <= 0) { apdT = 0.5; flags.apd = apDisconnectAlert(); }
      }
      if (c.ev && c.ev.takeoff) { if (takeoffAt == null) takeoffAt = now; } else takeoffAt = null;
      flags.sinceTakeoff = takeoffAt == null ? Infinity : now - takeoffAt;
      if (!enabled || c.f.crashed) { flags.ctrl = false; return; }
      for (let i = 0; i < st.length; i++) {
        const s = st[i], r = s.r;
        const on = r.cond(c, flags);
        s.t = on ? s.t + dt : 0;
        if (!on || s.t < r.after) continue;
        if (s.count >= r.cap || now - s.last < r.cooldown || (r.once && seen[r.id])) continue;
        if (busy(r.topic)) continue;
        // one hint at a time; a warning (stall, low rotor) may replace a milder hint and skips the quiet gap
        if (cur) { if (cur === s || r.tone !== 'warn' || cur.r.tone === 'warn') continue; }
        else if (gapT > 0 && r.tone !== 'warn') continue;
        show(s, c);
        break;
      }
      flags.ctrl = false;
    },
    current: () => (cur ? { id: cur.r.id, text: plainText(txt.textContent), chips: [...txt.querySelectorAll('kbd')].map((x) => x.textContent) } : null),
  };
}

// ---------- crash explanations ----------
// Reasons come from the flight models' crashReason (src/flight/fixedwing.js, helicopter.js). Order matters: specific
// ground-contact reasons first, obstacle collisions ("Binaya çarptı", "Ana rotor çarpması: …") last.
const CRASHES = [
  { code: 'num', re: /sayısal hata/i, text: () => 'Fizik hesabında bir hata oluştu.', tip: (k) => `Uçuş başlangıç noktasından sürüyor; ${k.chip('reset')} ile istediğin zaman yeniden başlayabilirsin.` },
  // causes the flight models put first (crashCause): lost speed (stall / low energy) and the helicopter collective
  { code: 'stall', re: /^hız çok düştü \(stall\)/i,
    text: (h, r) => `Hız çok düştü (stall): kanatlar uçağı taşıyamadı, uçak ${lostSpeedEnd(r, 'yere düştü')}.`,
    tip: (k) => `“STALL” uyarısında ya da titreşimde hemen gazı aç ${thrUp9(k)} ve burnu hafifçe indir ${k.chip('pitchDown')}.` },
  { code: 'lowspeed', re: /^hız çok düştü/i,
    text: (h, r) => `Hız çok düştü: uçak irtifa kaybedip ${lostSpeedEnd(r, 'yere çarptı')}.`,
    tip: (k) => `Gazı kesince hız düşer. Hız uyarısında (“SPEED SPEED SPEED”) hemen gazı aç ${thrUp9(k)} ve burnu hafifçe indir ${k.chip('pitchDown')}.` },
  { code: 'collective', re: /^kolektif/i,
    text: (h, r) => `Kolektif indirildi, helikopter ${/suya/i.test(r) ? 'suya' : /: /.test(r) ? 'bir engele' : 'yere'} çarptı.`,
    tip: (k) => `Havadayken kolektifi sonuna kadar indirme; helikopter düşmeye başlarsa ${k.hold('thrUp')}. ${k.chip('autopilot')} helikopteri askıda tutar.` },
  { code: 'gearup', re: /açılmadan|gövde üzerine/i, text: () => 'İniş takımı kapalıyken gövdenin üstüne indin.', tip: (k) => `İnmeden önce ${k.press('gear')}; ekranda “İniş takımı AŞAĞI” görünmeli.` },
  { code: 'water', re: /suya/i,
    text: (h, r) => (/rotor/i.test(r) ? 'Rotor palaları suya değdi.' : h ? 'Helikopter suya değdi.' : 'Uçak suya çarptı.'),
    tip: (k, h) => (h ? `Su üstünde alçalırken kolektifi yavaş azalt; ${k.chip('autopilot')} helikopteri askıda tutar.`
      : `Yüksekliğini izle; “PULL UP” uyarısında burnu kaldır ${k.chip('pitchUp')} ve gaz ver ${k.chip('thrUp')}.`) },
  { code: 'hard', re: /sert iniş|takımı kırıldı|takımı çöktü/i, text: () => 'Yere çok hızlı alçalarak değdin.',
    tip: (k, h) => (h ? `Yere yaklaşırken kolektifi biraz artır ${k.chip('thrUp')}, yavaşça otur.`
      : `Pist başında gazı azalt ve burnu hafifçe kaldır ${k.chip('pitchUp')}; alçalma 700 ft/dk’nın altında olsun.`) },
  { code: 'wing', re: /yatış açısı|kanat ucu|motor yere/i, text: () => 'Kanat yere değdi: yatış açısı fazlaydı.',
    tip: (k) => `İnişte ve kalkışta kanatları düz tut ${k.chip('roll')}.` },
  { code: 'rollover', re: /devrilme|devrildi/i, text: () => 'Helikopter yana devrildi.',
    tip: (k) => `Yerdeyken yana kaymadan, gövdeyi düz tutarak dikey kalk ve otur ${k.chip('roll')}.` },
  { code: 'inverted', re: /ters dön/i, text: (h) => (h ? 'Helikopter ters döndü.' : 'Uçak ters dönüp yere çarptı.'),
    tip: (k, h) => (h ? `Yatışı ve burun açısını küçük tut; ${k.chip('autopilot')} helikopteri askıda tutar.` : `Yere yakınken keskin manevra yapma; kanatları ${k.chip('roll')} ile düzelt.`) },
  { code: 'nose', re: /burun tekerleği|burun yere/i, text: (h) => (h ? 'Burun yere değdi.' : 'Burun tekerleği önce yere değdi.'),
    tip: (k, h) => (h ? 'Yere yakınken burnu aşağı eğme; hızını yüksekte kes, düz otur.' : `Önce ana tekerlekler değmeli: pist başında burnu hafifçe kaldır ${k.chip('pitchUp')}.`) },
  { code: 'obstacle', re: /çarpması:|binaya|köprü|kule|[’'](?:[ny]?[ae]) çarptı/i,
    // fixed wing: "<Dative> çarptı" (src/flight/fixedwing.js) → "Golden Gate Köprüsü'ne çarptın."; helicopter reasons name the part
    text: (h, r) => (h ? r : r.replace(/çarptı$/, 'çarptın')).replace(/^(.)/, (m) => m.toLocaleUpperCase('tr')) + (/[.!]$/.test(r) ? '' : '.'),
    tip: (k, h) => (h ? 'Rotor diski geniştir: binalara ve köprülere yaklaşırken bol mesafe bırak.'
      : `Binaların ve köprülerin üstünden geç; “PULL UP” uyarısında burnu hemen kaldır ${k.chip('pitchUp')}.`) },
  { code: 'belly', re: /gövde yere/i, text: () => 'Gövde yere çarptı.',
    tip: (k, h) => (h ? `Yere yaklaşırken kolektifi biraz artır ${k.chip('thrUp')} ve düz otur.` : `Önce iniş takımını indir ${k.chip('gear')}, pist başında burnu hafifçe kaldır ${k.chip('pitchUp')}.`) },
  { code: 'tail', re: /kuyruk|stabilatör/i, text: () => 'Kuyruk yere çarptı.',
    tip: (k, h) => (h ? 'Yere yakınken burnu fazla kaldırma; yavaşlamayı yüksekte bitir.' : 'Kalkışta ve inişte burnu çok kaldırma: yaklaşık 10° yeter.') },
  { code: 'terrain', re: /araziye|yamaca|rotor yere/i, text: (h, r) => (/rotor/i.test(r) ? 'Rotor palaları yere değdi.' : 'Tepelere çarptın.'),
    tip: (k, h) => (h ? 'Eğimli yerlerden ve yamaçlardan uzak dur, düz yere otur.' : `Tepelerin üstünden yüksek geç; “PULL UP” uyarısında burnu kaldır ${k.chip('pitchUp')}.`) },
  { code: 'dive', re: /çakıldı/i, text: () => 'Uçak dalışla yere çarptı.',
    tip: (k) => `Hız düşerse önce burnu indir ${k.chip('pitchDown')} ve gaz ver; yere yakınken dalışa geçme.` },
  { code: 'obstacle', re: /çarptı/i, text: (h, r) => `${r}.`, tip: (k) => `Engellerin üstünden geç; “PULL UP” uyarısında burnu kaldır ${k.chip('pitchUp')}.` },
];

/** End of a lost-speed crash sentence: "suya düştü", "binaya çarptı" / "Golden Gate Köprüsü'ne çarptı", or `ground`. */
function lostSpeedEnd(r, ground) {
  const rest = String(r).replace(/^hız çok düştü( \(stall\))?,\s*/i, '');
  if (/suya/i.test(rest)) return 'suya düştü';
  if (/^(binaya|\S.*[’'][ny]?[ae]) çarptı$/i.test(rest) && !/^(uçak|motor|gövde|kanat|kuyruk|burun)/i.test(rest)) return rest;
  return ground;
}

/** Crash reason → { code (telemetry), text (plain Turkish), tip ({Key} chips) }. */
export function explainCrash(reason, category, keys = keySet(shared.keyDevice, category)) {
  const r = String(reason || '').trim();
  const heli = category === 'helicopter';
  for (const x of CRASHES) if (x.re.test(r)) return { code: x.code, text: x.text(heli, r), tip: x.tip(keys, heli) };
  return { code: 'other', text: r ? `${r}.` : 'Uçak hasar gördü.', tip: `${keys.chip('reset')} ile istediğin zaman yeniden başlayabilirsin.` };
}
