// Player preferences for the aural alerts (settings.alerts, src/core/settings.js): which spoken alerts may sound and
// whether the alert tones may. Pure functions (unit-tested in tests/settings.test.mjs); src/audio/index.js applies them
// where every voice is queued (enqueueVoice), every tone / alert loop starts (io.tone / io.loop) and the A/P-disconnect
// alert begins.
//
//   voice 'all'       every spoken alert (today's behaviour, the default)
//         'critical'  only the ones that warn of an imminent crash: EGPWS modes 1-4 (PULL UP, TERRAIN, SINK RATE, DON'T
//                     SINK, TOO LOW …), STALL, SPEED SPEED SPEED, F-16 PULLUP / WARNING / ALTITUDE, F-22 ICAWS, UH-60
//                     engine out / LOW ROTOR / ALTITUDE LOW. Silenced: height callouts (2500 … 5, HUNDRED ABOVE, MINIMUM(S),
//                     APPROACHING MINIMUMS, intermediate heights, RETARD), GLIDESLOPE, BANK ANGLE, F-16 CAUTION / BINGO.
//         'off'       no spoken alert (sounds the game plays on purpose through audio.play() still do)
//   chimes false      no alert tone or loop: master warning (CRC) / caution chimes, C-chord, altitude alert, gear and
//                     take-off-config horns, clacker, stick shaker, fire bell, F-16 tones, F-22 caution, A/P disconnect

// voice tags are '<system>:<id>' (src/audio/alertlogic.js); anything not listed here counts as critical, so a new alert
// is never lost silently by the 'critical' setting
const INFO_VOICE = /^(gpws:(co#|gs$|bank$)|fwc:(co#|inter$|retard$)|vms:(caution|bingo)$|co$|retard$)/;

export const DEFAULT_ALERT_PREFS = Object.freeze({ voice: 'all', chimes: true });

/** 'info' (callouts and advisories) | 'critical' | 'play' (a sound the game asked for by name: not an alert). */
export function voiceClass(tag) {
  const t = String(tag || '');
  if (t.startsWith('play:')) return 'play';
  return INFO_VOICE.test(t) ? 'info' : 'critical';
}

/** May the spoken alert with this tag sound under the voice mode? */
export function voiceAllowed(tag, mode = 'all') {
  if (mode !== 'critical' && mode !== 'off') return true;
  const c = voiceClass(tag);
  if (c === 'play') return true;
  return mode === 'critical' && c === 'critical';
}

/** Normalised { voice, chimes } from settings.alerts (missing / invalid values → defaults). */
export function alertPrefsFrom(alerts) {
  const a = alerts && typeof alerts === 'object' ? alerts : {};
  return {
    voice: a.voice === 'critical' || a.voice === 'off' ? a.voice : 'all',
    chimes: a.chimes !== false,
  };
}
