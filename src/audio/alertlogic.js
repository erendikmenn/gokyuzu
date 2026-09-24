// Real-system aural alert logic (wave 7). Each factory returns one warning *system* of the real aircraft with its
// own voice / tones, thresholds, priorities, repetition and inhibits. Sources: tools/audio/research/alerts.md
// (Airbus A320 FCOM 2023 + FlyByWire FWC/FAC code, Boeing 737NG FCOM, Honeywell MK V/VII EGPWS pilot guide +
// FlightGear mk_viii.cxx, USAF T.O. 1F-16A-1 + DTIC AD-A145469, TM 1-1520-237-10 / TC 3-04.33 for the UH-60).
//
// A system is { name, files: string[], loops: { id: { file, db } }, reset(), update(s, io, f) }.
//   s  derived state (src/audio/index.js deriveState): ft (radio altitude), kt, fpm, altFt, roll, pitch, aoa, gear,
//      gearHandle, flapsIndex, landIdx, thr, rev, onGround, apOn, apMode, apAlt, fcuValid, athr, fuelKg, eng[], ...
//   io { now, say(tag, rel, prio, {gainDb, maxAge, system}), speaking(tag|null), speakingSystem(name), endedAt(tag),
//        stop(tag), loop(id, on, why?), tone(rel, {gainDb, tag}) }
//   f  the flight model (read-only)
// Priorities share one voice channel (higher interrupts lower): EGPWS 50-100, FWC 55-110, VMS 40-100.

const KT = 0.514444;
// flight-model flags (flight.warnings.<name>) consumed when present; adding a new name is a one-line change here
export const FLAGS = {
  lowEnergy: ['lowEnergy'],                         // A320 FAC low-energy warning → "SPEED SPEED SPEED"
  alphaFloor: ['alphaFloor', 'aFloor', 'togaLock'], // A.FLOOR / TOGA LK: inhibit SPEED SPEED SPEED (no aural of its own)
  fighterLowSpeed: ['lowSpeed'],                    // fighter AoA > 15° with the gear down → F-16 low-speed warning tone
  lowRotor: ['lowRotor'],                           // UH-60 NR < 96 % → LOW ROTOR (the audio adds the WOW inhibit)
  fire: ['fire', 'engineFire', 'apuFire'],          // fire detection → 737 fire bell, A320 CRC, F-16 WARNING (ENG FIRE)
  // failures (src/flight/failures.js): engine failed / shut down, hydraulic pressure low, gear not down and locked
  engineFail: ['engineFail'],                       // A320 ENG FAIL (single chime) / ENG DUAL FAILURE (CRC); F-16 / F-22 / UH-60 by N1
  hydraulic: ['hydraulic'],                         // A320 HYD LO PR (dual: CRC), F-16 HYD/OIL PRESS light → WARNING, F-22 caution
  gearUnsafe: ['gearUnsafe'],                       // A320 L/G GEAR NOT DOWNLOCKED (CRC); 737 gear horn / F-16 TO/LDG CONFIG already by position
};
/** true when any of the flight-model flags listed under FLAGS[key] is set */
const flag = (s, key) => FLAGS[key].some((k) => s.w[k]);

// ------------------------------------------------------------------------------------------------ helpers
/** Repeating voice while a condition holds: first call on the rising edge, then `gap` s after each end. */
function repeater(tag, rel, prio, gap, opts = {}) {
  let on = false;
  return {
    update(io, cond) {
      if (!cond) { on = false; return; }
      if (!on) { on = true; io.say(tag, rel, prio, opts); return; }
      if (!io.speaking(tag) && io.now - io.endedAt(tag) >= gap) io.say(tag, rel, prio, opts);
    },
    reset() { on = false; },
  };
}

/** Condition that must hold continuously for `sec` seconds. */
function confirm(sec) {
  let t0 = null;
  return {
    test(now, cond) { if (!cond) { t0 = null; return false; } if (t0 === null) t0 = now; return now - t0 >= sec; },
    reset() { t0 = null; },
  };
}

// ================================================================================================ Honeywell EGPWS
/**
 * Honeywell MK V EGPWS modes 1-5 (+ mode 6 callouts / minimums / bank angle when `mode6`). Envelopes from the
 * MK V/VII pilot guide as coded in FlightGear mk_viii.cxx (types 254/255 air transport curves).
 * A320: modes 1-5 only (heights come from the FWC; no BANK ANGLE), look-ahead warning "TERRAIN AHEAD, PULL UP".
 * 737:  modes 1-6, look-ahead "TERRAIN TERRAIN PULL UP", plain "PULL UP" (no whoop-whoop on Boeing).
 */
export function egpws(dir, { mode6 = false, tad = 'v_terrain_pullup', callouts = [], dh = 200, apprMin = true } = {}) {
  const v = (n) => `${dir}/${n}`;
  const files = ['v_sinkrate', 'v_pullup', 'v_terrain2', 'v_terrain', 'v_toolow_terrain', 'v_toolow_gear', 'v_toolow_flaps',
    'v_dontsink', 'v_glideslope', 'v_glideslope2', tad].map(v);
  if (mode6) files.push(...callouts.map((c) => v(c[1])), v('v_bankangle'), v('v_minimums'), ...(apprMin ? [v('v_apprmin')] : []));
  const P = { pullup: 100, terrain: 95, minimums: 90, toolowTerrain: 85, callout: 80, toolowGear: 75, toolowFlaps: 74,
    sink: 70, dontsink: 65, glideslope: 60, apprMin: 55, bank: 50 };
  const say = (io, tag, file, prio, o = {}) => io.say('gpws:' + tag, v(file), prio, { system: 'egpws', ...o });
  let S;
  const pullRep = repeater('gpws:pullup', v('v_pullup'), P.pullup, 0.15, { system: 'egpws' });
  const tadRep = repeater('gpws:tad', v(tad), P.terrain, 0.15, { system: 'egpws' });
  const m2Rep = repeater('gpws:m2', v('v_terrain2'), P.terrain, 0.75, { system: 'egpws' });
  // single "TERRAIN" repeated: Mode 2B in landing configuration (PULL UP suppressed) and, after leaving the Mode 2 PULL UP
  // envelope, while the terrain clearance keeps decreasing (MK V pilot guide pp. 8-11)
  const t1Rep = repeater('gpws:t1', v('v_terrain'), P.terrain, 0.75, { system: 'egpws' });
  function reset() {
    S = { tom: true, m3Armed: null, prevFt: null, closure: 0, sinkT: 0, pullT: 0, sinkTTI: 0, m2T: 0, m2Mode: '', m3Max: null, m3Ref: 0,
      m4Ref: { gear: 0, flaps: 0, terrain: 0 }, m5T: 0, m5HardNext: 0, m5SoftDev: 0, coArmed: false, coPrevFt: null,
      coDone: new Set(), bank: { 35: false, 40: false, 45: false }, pullMode: '' };
    pullRep.reset(); tadRep.reset(); m2Rep.reset(); t1Rep.reset();
  }
  reset();
  const m4upper = (kt) => Math.min(1000, Math.max(500, -1083 + 8.333 * kt));
  return {
    name: 'egpws', files, loops: {}, reset, debug: () => ({ tom: S.tom, m3Armed: S.m3Armed, closure: Math.round(S.closure) }),
    update(s, io) {
      const now = io.now, dt = s.dt, ft = s.ft, kt = s.kt, fpm = s.fpm;
      if (s.onGround) { S.tom = true; S.m3Armed = true; S.prevFt = ft; S.m3Max = null; S.coArmed = false; S.coDone.clear(); S.m2Was = false; pullRep.update(io, false); tadRep.update(io, false); m2Rep.update(io, false); t1Rep.update(io, false); return; }
      // takeoff mode: from the ground until the terrain clearance exceeds the Mode 4A upper limit (500-1000 ft);
      // Mode 3 stays armed from lift-off (or a go-around) up to 1500 ft. An airborne (re)spawn that is climbing below
      // 1500 ft counts as just after take-off.
      if (S.m3Armed === null) { S.m3Armed = ft < 1500 && fpm > 100; S.tom = S.m3Armed; }
      if (S.tom && ft > m4upper(kt)) S.tom = false;
      if (ft > 1500) S.m3Armed = false;
      if (!S.m3Armed && ft < 245 && s.gear >= 0.98 && fpm > 300) { S.m3Armed = true; S.m3Max = null; }   // go-around
      // terrain closure rate (fpm) from the radio altitude, smoothed
      if (S.prevFt !== null && dt > 0) {
        const c = -(ft - S.prevFt) / dt * 60;
        if (Math.abs(ft - S.prevFt) < 400) S.closure += (c - S.closure) * Math.min(1, dt / 0.6);
      }
      S.prevFt = ft;
      const gearDown = s.gear >= 0.98;
      const landFlaps = s.flapsIndex >= s.gpwsLandIdx;
      // ---- Mode 1: excessive descent rate
      const m1on = ft > 10 && ft < 2450;
      const outer = m1on && ft < -572 - 0.6035 * fpm;
      const inner = m1on && (ft < 284 ? ft < -1620 - 1.1133 * fpm : ft < -400 - 0.4 * fpm);
      S.sinkT = outer ? S.sinkT + dt : 0;
      S.pullT = inner ? S.pullT + dt : 0;
      const m1pull = S.pullT >= 0.2 && S.sinkT >= 0.8;
      // flight-model terrain / obstacle look-ahead (the TAD warning of the real EGPWS)
      const tadWarn = !!s.w.pullUp && !m1pull;
      // ---- Mode 2: excessive terrain closure
      let m2 = false;
      if (ft > 30 && S.closure > 0) {
        const line = ft < 1220 ? ft < -1579 + 0.7895 * S.closure : ft < 522 + 0.1968 * S.closure;
        const upper = landFlaps ? 789 : Math.min(2450, Math.max(1650, 1650 + 8.9 * (kt - 220)));
        let lower = 30;
        if (landFlaps) lower = fpm > -400 ? 200 : fpm < -1000 ? 600 : 200 + (-fpm - 400) / 600 * 400;
        m2 = line && ft < upper && ft > lower;
      }
      S.m2T = m2 ? S.m2T + dt : 0;
      const m2on = S.m2T > 0.6;
      const m2terrainOnly = m2on && gearDown && landFlaps;
      // PULL UP: Mode 1 inner, or Mode 2 after "TERRAIN TERRAIN" (not in landing configuration)
      if (m2on && !S.m2Started) { S.m2Started = true; S.m2Say = now; }
      if (!m2on) S.m2Started = false;
      const m2pull = m2on && !m2terrainOnly && S.m2Started && io.endedAt('gpws:m2') > S.m2Say && !io.speaking('gpws:m2');
      if (m2pull) { S.m2Was = true; S.m2WasT = now; }
      if (S.m2Was && (m2on || S.closure <= 0 || now - S.m2WasT > 45)) S.m2Was = m2on && S.m2Was;
      const terrainOne = (m2on && m2terrainOnly) || (!m2on && S.m2Was && S.closure > 0);
      pullRep.update(io, m1pull || m2pull);
      tadRep.update(io, tadWarn && !m1pull && !m2pull);
      m2Rep.update(io, m2on && !m2terrainOnly && !m2pull && !tadWarn && !m1pull);
      t1Rep.update(io, terrainOne && !tadWarn && !m1pull && !m2pull);
      const warning = m1pull || m2pull || tadWarn || m2on || terrainOne;
      // SINK RATE (outer boundary), repeated for each 20 % worsening of the time to impact
      if (S.sinkT >= 0.8 && !m1pull && !warning) {
        const tti = ft / Math.max(1, -fpm / 60);
        if (!S.sinkTTI || tti <= 0.8 * S.sinkTTI) { S.sinkTTI = tti; say(io, 'sink', 'v_sinkrate', P.sink); }
      } else if (!outer) S.sinkTTI = 0;
      // ---- Mode 3: altitude loss after takeoff / go-around (takeoff mode, not in landing configuration)
      if (S.m3Armed && ft > 30 && ft < 1500 && !(gearDown && landFlaps)) {
        if (S.m3Max === null || s.altFt > S.m3Max) { S.m3Max = s.altFt; S.m3Ref = 0; }
        const loss = S.m3Max - s.altFt;
        const lim = 5.4 + 0.092 * ft;
        // "DON'T SINK, DON'T SINK" once per further 20 % altitude loss; a higher-priority warning outranks it
        if (fpm < 0 && !warning && loss > lim * (1 + S.m3Ref)) { S.m3Ref = S.m3Ref ? S.m3Ref + 0.2 : 0.2; say(io, 'dontsink', 'v_dontsink', P.dontsink); }
      } else if (!S.m3Armed) S.m3Max = null;
      // ---- Mode 4: unsafe terrain clearance (4A gear up, 4B gear down + flaps not in landing position)
      if (!S.tom && ft > 30 && !warning) {
        let kind = null, lim = 0;
        if (!gearDown) {
          if (kt < 190) { if (ft < 500) { kind = 'gear'; lim = 500; } } else if (ft < m4upper(kt)) { kind = 'terrain'; lim = m4upper(kt); }
        } else if (!landFlaps) {
          const up = Math.min(1000, 245 + 8.297 * Math.max(0, kt - 159));
          if (kt < 159) { if (ft < 245) { kind = 'flaps'; lim = 245; } } else if (ft < up) { kind = 'terrain'; lim = up; }
        }
        for (const k of ['gear', 'flaps', 'terrain']) if (k !== kind) S.m4Ref[k] = 0;
        if (kind && (!S.m4Ref[kind] || ft <= 0.8 * S.m4Ref[kind])) {
          S.m4Ref[kind] = ft || lim;
          if (kind === 'gear') say(io, 'toolowgear', 'v_toolow_gear', P.toolowGear);
          else if (kind === 'flaps') say(io, 'toolowflaps', 'v_toolow_flaps', P.toolowFlaps);
          else say(io, 'toolowterrain', 'v_toolow_terrain', P.toolowTerrain);
        }
      } else { S.m4Ref.gear = S.m4Ref.flaps = S.m4Ref.terrain = 0; }
      // ---- Mode 5: below the glide slope (ILS of the runway ahead, gear down, localizer within 2 dots)
      const d = s.gsDots;
      if (d != null && gearDown && Math.abs(s.locDots) < 2 && ft > 30 && !warning) {
        const dev = -d;                                              // dots below the beam
        const upper = fpm < -500 ? 1000 : fpm >= 0 ? 500 : 500 - fpm;
        const soft = ft < upper && dev >= 1.3 && (ft >= 150 || ft > 243 - 71.43 * dev);
        const hard = ft < 300 && dev >= 2 && (ft >= 150 || ft > 293 - 71.43 * dev);
        S.m5T = soft || hard ? S.m5T + dt : 0;
        if (S.m5T >= 0.8) {
          if (hard) {
            if (now >= S.m5HardNext && !io.speaking('gpws:gs')) { say(io, 'gs', 'v_glideslope2', P.glideslope); S.m5HardNext = now + 3; }
          } else if (!S.m5SoftDev || dev >= S.m5SoftDev * 1.2) {
            S.m5SoftDev = dev; say(io, 'gs', 'v_glideslope', P.glideslope, { gainDb: -6 });   // soft: half volume
          }
        } else if (!soft) S.m5SoftDev = 0;
      } else { S.m5T = 0; S.m5SoftDev = 0; }
      if (!mode6) return;
      // ---- Mode 6: callouts once per approach (re-armed above 1000 ft outside takeoff mode), MINIMUMS, BANK ANGLE
      if (!S.tom && ft > 1000) { S.coArmed = true; S.coDone.clear(); }
      if (S.coArmed && S.coPrevFt !== null && fpm < 0 && !warning) {          // warnings outrank the callouts
        const cands = callouts.map(([h, file]) => ({ h, file, prio: P.callout }));
        if (gearDown) {
          if (apprMin) cands.push({ h: dh + 80, file: 'v_apprmin', prio: P.apprMin, dh: true });
          cands.push({ h: dh, file: 'v_minimums', prio: P.minimums, dh: true });
        }
        let hit = null;
        for (const c of cands) {
          if (S.coDone.has(c.h + c.file)) continue;
          if (!c.dh && Math.abs(c.h - dh) <= 30) continue;          // near-DH suppression: MINIMUMS wins
          const tol = c.h > 150 ? 20 : 10;
          if (S.coPrevFt > c.h && ft <= c.h && ft >= c.h - tol && (!hit || c.h < hit.h)) hit = c;
        }
        if (hit) {
          for (const c of cands) if (c.h >= hit.h) S.coDone.add(c.h + c.file);    // lock out everything at/above it
          say(io, `co#${hit.h}`, hit.file, hit.prio, { maxAge: 0.8 });
        }
      }
      S.coPrevFt = ft;
      const bank = Math.abs(s.roll);
      if (ft > 5) {
        for (const a of [45, 40, 35]) {
          if (bank > a && !S.bank[a]) {
            S.bank[35] = true; if (a >= 40) S.bank[40] = true; if (a >= 45) S.bank[45] = true;
            say(io, 'bank', 'v_bankangle', P.bank);
            break;
          }
        }
      }
      if (bank <= 30) S.bank[35] = S.bank[40] = S.bank[45] = false;
    },
  };
}

// ================================================================================================ Airbus A320 FWC
/**
 * A320 flight warning computer: auto callouts (FWC voice), RETARD, HUNDRED ABOVE / MINIMUM, intermediate callouts,
 * cricket + STALL, SPEED SPEED SPEED (FAC), C-chord altitude alert, CRC (overspeed, L/G GEAR NOT DOWN, T.O CONFIG),
 * single chime (A/THR OFF, FUEL WING TK LO LVL). The cavalry charge is played by the A/P-disconnect logic in index.js.
 */
export function fwcA320(dir, { dh = 200, heights = [2500, 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10, 5] } = {}) {
  const v = (n) => `${dir}/${n}`;
  const INTER = [];
  for (let h = 60; h < 400; h += 10) if (h % 100) INTER.push(h);
  const files = [...heights.map((h) => v(`v_${h}`)), v('v_hundredabove'), v('v_minimum'), v('v_retard'), v('v_20_retard'),
    v('v_10_retard'), v('v_stall'), v('v_speed'), v('single_chime'), v('c_chord'), ...INTER.map((h) => v(`v_i${h}`))];
  const loops = { crc: { file: v('crc'), db: -2 }, cchord: { file: v('c_chord_loop'), db: -3 } };
  // detection windows [h, h + w) and lockouts (FBW FwsAutoCallouts, FCOM DSC-34-NAV-40-10)
  const BAND = (h) => (h >= 2500 ? 30 : h >= 1000 ? 20 : h === 500 ? 13 : h >= 100 ? 10 : h === 50 ? 3 : h === 5 ? 1 : 2);
  const LOCK = (h) => (h >= 1000 ? 0 : h === 500 ? 11 : h >= 100 ? 5 : 2);      // 2500/1000: re-arm by height instead
  const REARM = { 2500: 3000, 1000: 1100 };
  const PRIO = { stall: 105, retard: 82, callout: 80, inter: 79, speed: 60 };
  const sayF = (io, tag, file, prio, o = {}) => io.say('fwc:' + tag, v(file), prio, { system: 'fwc', ...o });
  const stallRep = repeater('fwc:stall', v('v_stall'), PRIO.stall, 0.05, { system: 'fwc' });
  const spdConf = confirm(0.5), fuelConf = confirm(30);
  let S;
  function reset() {
    S = { prevFt: null, last: {}, armed: { 2500: false, 1000: false }, lastCallout: -99, lastInter: -99, ha: false, min: false,
      haT: -99, phase5: null, retard: false, retardNext: 0, gpwsT: -99, spdNext: 0, spdHeld: 0, athrPrev: null, fuelDone: false, fcuPrev: null,
      fcuChangeT: -99, captured: false, apprArmed: false, prevRaDec: 0, decT: 0, iasPrev: null, decel: 0 };
    stallRep.reset(); spdConf.reset(); fuelConf.reset();
    S.l3 = { dual: false, hyd: false, gear: false, until: -99 }; S.l2 = { eng: false, hyd: false };
  }
  reset();
  return {
    name: 'fwc', files, loops, reset, debug: () => ({ phase5: S.phase5, retard: S.retard, captured: S.captured }),
    update(s, io, f) {
      const now = io.now, ft = s.ft, dt = s.dt, kt = s.kt;
      const air = !s.onGround;
      const toga = s.thr >= 0.95;
      // FWC flight phase 5 (lift-off to 1500 ft): take-off inhibits (L/G GEAR NOT DOWN). An airborne (re)spawn that is
      // climbing below 1500 ft counts as just after lift-off.
      if (!air) S.phase5 = true;
      else if (S.phase5 === null) S.phase5 = ft < 1500 && s.fpm > 100;
      if (air && ft > 1500) S.phase5 = false;
      const idle = s.thr <= 0.03 || s.rev > 0.1;
      if (io.speakingSystem('egpws')) S.gpwsT = now;
      const gpws = now - S.gpwsT < 2;
      // RA trend (callouts only while descending); 10/5 need 0.3 s of decreasing RA
      const dec = S.prevFt !== null && ft < S.prevFt - 1e-3;
      S.decT = dec ? S.decT + dt : 0;
      // ---- STALL (cricket + "STALL"): the game's A320 warns only when actually stalled (normal law protects;
      //      the real aircraft warns in alternate/direct law only)
      const stall = air && !!s.w.stall;
      stallRep.update(io, stall);
      // ---- SPEED SPEED SPEED (FAC low-energy): CONF >= 2, 100 < RA < 2000 ft, not TOGA, no GPWS alert
      if (S.iasPrev !== null && dt > 0) S.decel += ((kt - S.iasPrev) / dt - S.decel) * Math.min(1, dt / 1.0);
      S.iasPrev = kt;
      // the flight model's own FAC flags win when it publishes them (FLAGS below); otherwise the FAC rule is computed here
      const aFloor = FLAGS.alphaFloor.some((k) => s.w[k]);
      const vls = s.vlsKt;
      const lowEnergyModel = FLAGS.lowEnergy.find((k) => s.wHas[k]);
      const lowEnergy = air && !toga && !gpws && !stall && !aFloor && (lowEnergyModel ? !!s.w[lowEnergyModel]
        : vls > 0 && s.flapsIndex >= 3 && ft > 100 && ft < 2000 && (kt < vls - 10 || (kt < vls && S.decel < -1.0)));
      const spd = spdConf.test(now, lowEnergy);
      if (spd) S.spdHeld = now;
      const spdActive = spd || now - S.spdHeld < 3;
      if (spd && now >= S.spdNext && !io.speaking('fwc:speed')) { sayF(io, 'speed', 'v_speed', PRIO.speed); S.spdNext = now + 5; }
      // ---- auto callouts
      if (!air) { S.armed[2500] = S.armed[1000] = false; S.ha = S.min = false; }
      if (air) {
        for (const h of [2500, 1000]) if (ft > REARM[h]) S.armed[h] = true;
        if (ft > 1000) { S.ha = false; S.min = false; }
      }
      const autoland = s.apOn && s.athr && /LAND|FLARE|ROLLOUT/.test(s.apMode || '');
      const retardH = autoland ? 10 : 20;
      const inhibitAll = !air || stall || spdActive;
      if (air && S.prevFt !== null && !inhibitAll) {
        // HUNDRED ABOVE / MINIMUM (DH 200 ft, radio altimeter), once
        const approach = s.gear >= 0.98 && !gpws;           // DH set for the approach (no MCDU in the game): gear down
        if (!S.ha && approach && dec && ft <= dh + 115 && ft > dh + 15) { S.ha = true; S.haT = now; sayF(io, 'co#ha', 'v_hundredabove', PRIO.callout + 1, { maxAge: 0.8 }); S.lastCallout = now; }
        if (!S.min && approach && dec && ft < dh + 15 && ft > dh - 40) { S.min = true; S.haT = now; sayF(io, 'co#min', 'v_minimum', PRIO.callout + 1, { maxAge: 0.8 }); S.lastCallout = now; }
        let hit = null;
        for (const h of heights) {
          const w = BAND(h);
          const entering = S.prevFt >= h + w && ft < h + w && ft >= h - 3 * w;
          if (!entering || !dec) continue;
          if (REARM[h] && !S.armed[h]) continue;
          if (now - (S.last[h] ?? -99) < LOCK(h)) continue;
          if ((h === dh + 100 || h === dh) && (now - S.haT < 3 || (s.gear >= 0.98 && (h === dh ? S.min : S.ha)))) continue;   // DH calls win
          if (h <= 1000 && h >= 50 && gpws) continue;                                            // GPWS alert (+2 s)
          if ((h === 10 || h === 5) && (S.retard || S.decT < 0.3)) continue;
          if (!hit || h < hit) hit = h;                                                          // a lower one pre-empts
        }
        if (hit !== null) {
          S.last[hit] = now; S.lastCallout = now;
          if (REARM[hit]) S.armed[hit] = false;
          if (hit === retardH && !toga) {
            // FWC sheet: "TWENTY, RETARD" (manual) / "TEN, RETARD" (autoland) once, then RETARD while above idle
            sayF(io, 'retard', autoland ? 'v_10_retard' : 'v_20_retard', PRIO.retard, { maxAge: 0.8 });
            S.retard = true;
          } else sayF(io, `co#${hit}`, `v_${hit}`, PRIO.callout, { maxAge: 0.8 });
        }
      }
      // RETARD repetition (~1.1 s cycle: 0.72 s word + 0.4 s pause) until all levers at IDLE / REV, TOGA, or 80 kt on ground
      if (S.retard) {
        const low = air ? ft < retardH + 2 : s.gs > 80 * KT;
        if (!low || idle || toga) S.retard = false;
        else if (!io.speaking('fwc:retard') && now - io.endedAt('fwc:retard') >= 0.4) sayF(io, 'retard', 'v_retard', PRIO.retard);
      }
      // intermediate callouts: below 410 ft, no callout for 11 s (4 s below 50 ft) → present height every 4 s
      if (air && !inhibitAll && !S.retard && ft < 410 && ft > 25 && s.fpm < 30 && !gpws) {
        const thr = ft > 50 ? 11 : 4;
        if (now - S.lastCallout >= thr && now - S.lastInter >= 4 && !io.speaking(null)) {
          const h = Math.round(ft / 10) * 10;
          const file = h % 100 === 0 || h <= 50 ? (heights.includes(h) ? `v_${h}` : null) : `v_i${h}`;
          if (file) { sayF(io, 'inter', file, PRIO.inter, { maxAge: 0.6 }); S.lastInter = now; }
        }
      }
      S.prevFt = ft;
      // ---- CRC: OVERSPEED, L/G GEAR NOT DOWN, T.O CONFIG (red warnings)
      const gearNotDown = air && !S.phase5 && s.gear < 0.98 && ft < 750 && !toga && s.thr < 0.8 && (s.flapsIndex >= 4 || s.n1max < 0.75);
      const toConfig = !air && s.thr >= 0.75 && s.rev < 0.1 &&
        (s.flapsIndex === 0 || s.flapsIndex >= s.landIdx || s.speedbrake > 0.05 || s.parkBrake);
      const fire = flag(s, 'fire');                     // ENG / APU FIRE (level 3) when the flight model reports it
      // failures: ENG DUAL FAILURE, HYD G+Y / B+G / B+Y LO PR, L/G GEAR NOT DOWNLOCKED = level 3 (CRC until the crew
      // acknowledges it: 5 s here); ENG 1(2) FAIL and a single HYD LO PR = level 2 (single chime)
      const engF = flag(s, 'engineFail'), hydLow = flag(s, 'hydraulic');
      const hy = f && f.hydraulics;
      const hydLost = hy ? (hy.G === false) + (hy.Y === false) + (hy.B === false) : hydLow ? 1 : 0;
      const l3d = air && engF && s.n1max < 0.18, l3h = air && hydLost >= 2, l3g = air && flag(s, 'gearUnsafe');
      if ((l3d && !S.l3.dual) || (l3h && !S.l3.hyd) || (l3g && !S.l3.gear)) S.l3.until = now + 5;
      S.l3.dual = l3d; S.l3.hyd = l3h; S.l3.gear = l3g;
      const l2eng = air && engF && !l3d, l2hyd = air && hydLow && hydLost < 2;
      if ((l2eng && !S.l2.eng) || (l2hyd && !S.l2.hyd)) io.tone(v('single_chime'), { tag: 'fwc:master_caution' });
      S.l2.eng = l2eng; S.l2.hyd = l2hyd;
      const lvl3 = now < S.l3.until && (l3d || l3h || l3g);
      io.loop('crc', fire || lvl3 || (air ? !!s.w.overspeed || gearNotDown : toConfig),
        fire ? 'fire' : lvl3 ? 'failure' : air ? (s.w.overspeed ? 'overspeed' : 'gearNotDown') : 'toConfig');
      // ---- single chime: A/THR OFF (not below 50 ft with idle levers), FUEL WING TK LO LVL (< 750 kg per wing, 30 s).
      //      A/THR engaged = autopilot A/THR or the alpha-floor modes (flight.athrMode A.FLOOR / TOGA LK): moving the levers
      //      out of TOGA LK disconnects the A/THR → single chime + AUTO FLT A/THR OFF
      const athr = s.athr || !!s.athrMode;
      if (S.athrPrev === true && !athr && air && ft > 50) io.tone(v('single_chime'), { tag: 'fwc:athr_off' });
      S.athrPrev = athr;
      if (!S.fuelDone && fuelConf.test(now, air && s.fuelKg > 0 && s.fuelKg < 1500)) { S.fuelDone = true; io.tone(v('single_chime'), { tag: 'fwc:fuel_lo_lvl' }); }
      // ---- C-chord altitude alert (FCU altitude = autopilot altitude target)
      const fcu = s.fcuValid ? s.apAlt * 3.28084 : null;
      if (fcu === null) { io.loop('cchord', false); return; }
      if (S.fcuPrev === null || Math.abs(fcu - S.fcuPrev) > 1) { S.fcuChangeT = now; S.captured = false; S.apprArmed = Math.abs(s.altFt - fcu) > 750; }
      S.fcuPrev = fcu;
      const ad = Math.abs(s.altFt - fcu);
      const inhibit = !air || s.gear >= 0.98 || (s.gearHandle && s.flapsIndex >= 1) || /G\/S|LAND|FLARE|ROLLOUT/.test(s.apMode || '') ||
        now - S.fcuChangeT < 1;
      if (ad < 250) { S.captured = true; S.apprArmed = false; }
      if (ad > 750) { if (S.captured) S.captured = false; S.apprArmed = true; }
      if (!inhibit && S.apprArmed && ad < 750 && ad >= 250) {
        S.apprArmed = false;
        if (!s.apOn) io.tone(v('c_chord'), { tag: 'fwc:cchord' });                 // 1.5 s, only without autopilot
      }
      io.loop('cchord', !inhibit && S.captured && ad >= 250 && ad < 750);         // deviation: continuous
    },
  };
}

// ================================================================================================ Boeing 737 aurals
/** Boeing aural warning module: gear horn (steady), takeoff-config horn (intermittent), clacker (VMO/MMO), stick
 *  shaker, altitude alert. No master-caution aural on the 737. A/P wailer in index.js. */
export function boeing737(dir) {
  const v = (n) => `${dir}/${n}`;
  const loops = { horn: { file: v('horn'), db: 0 }, hornInt: { file: v('horn_int'), db: 0 }, clacker: { file: v('clacker'), db: 0 },
    shaker: { file: v('shaker'), db: 0 }, fireBell: { file: v('fire_bell'), db: 0 } };
  let S;
  const reset = () => { S = { mcpPrev: null, captured: false, apprArmed: false, devDone: false }; };
  reset();
  return {
    name: 'boeing', files: [v('alt_alert')], loops, reset,
    update(s, io) {
      const air = !s.onGround;
      const leverIdle = s.thr < 0.25;                    // "between idle and about 20 degrees TLA"
      const gearUp = s.gear < 0.98;
      const f = s.flapsIndex;                            // 0 UP, 1, 2, 5, 10 (4), 15 (5), 25 (6), 30 (7), 40 (8)
      io.loop('horn', air && gearUp && ((f <= 4 && s.ft < 800 && leverIdle) || ((f === 5 || f === 6) && leverIdle) || f >= 7), 'gear');
      io.loop('hornInt', !air && s.thr >= 0.6 && s.rev < 0.1 && (f === 0 || f >= 7 || s.speedbrake > 0.05 || s.parkBrake), 'takeoffConfig');
      io.loop('clacker', air && (s.kt > s.vmoKt + 0.5 || s.mach > s.mmo + 0.002));
      io.loop('shaker', air && !!s.w.stall);
      io.loop('fireBell', flag(s, 'fire'));              // engine / APU / wheel-well fire (no BELL CUTOUT in the game)
      // altitude alert: momentary tone 900 ft before the MCP altitude and on a 300 ft deviation; inhibited with flaps
      // 25 or more or the glide slope captured
      if (!s.fcuValid) return;
      const mcp = s.apAlt * 3.28084;
      if (S.mcpPrev === null || Math.abs(mcp - S.mcpPrev) > 1) { S.captured = false; S.apprArmed = Math.abs(s.altFt - mcp) > 900; S.devDone = false; }
      S.mcpPrev = mcp;
      const ad = Math.abs(s.altFt - mcp);
      const inhibit = !air || f >= 6 || /G\/S|LAND|FLARE|ROLLOUT/.test(s.apMode || '');
      if (ad < 300) { S.captured = true; S.apprArmed = false; S.devDone = false; }
      if (ad > 900) { S.captured = false; S.apprArmed = true; }
      if (inhibit) return;
      if (S.apprArmed && ad <= 900) { S.apprArmed = false; io.tone(v('alt_alert'), { tag: 'boeing:alt_alert' }); }
      if (S.captured && ad > 300 && !S.devDone) { S.devDone = true; io.tone(v('alt_alert'), { tag: 'boeing:alt_dev' }); }
    },
  };
}

// ================================================================================================ F-16 VMS
/** F-16 voice message system + LG warning horn + low-speed warning tone. VMS inoperative with weight on wheels. */
export function f16Vms(dir, { alowFt = 500, bingoKg = 680, fuelLowKg = 295 } = {}) {
  const v = (n) => `${dir}/${n}`;
  const files = ['v_warning', 'v_caution', 'v_altitude', 'v_bingo', 'v_pullup'].map(v);
  const loops = { lgHorn: { file: v('lg_horn'), db: 0 }, lowSpeed: { file: v('low_speed'), db: 0 } };
  const P = { pullup: 100, altitude: 90, warning: 80, caution: 50, bingo: 40 };
  const sayV = (io, tag, file, prio) => io.say('vms:' + tag, v(file), prio, { system: 'vms' });
  const pullRep = repeater('vms:pullup', v('v_pullup'), P.pullup, 0.1, { system: 'vms' });
  let S;
  const reset = () => { S = { lights: {}, cautions: {}, altArmed: false, bingo: false, hornT: null }; pullRep.reset(); };
  reset();
  return {
    name: 'vms', files, loops, reset,
    update(s, io) {
      const now = io.now, air = !s.onGround;
      const gearNotDown = s.gear < 0.98;
      // glareshield warning lights → "WARNING WARNING" 1.5 s after a light comes on
      const lights = {
        toldg: air && s.altFt < 10000 && s.kt < 190 && s.fpm < -250 && gearNotDown,
        engine: air && s.n1min < 0.55,
        canopy: air && s.canopy > 0.02,
        fire: air && flag(s, 'fire'),                    // ENG FIRE
        hyd: air && flag(s, 'hydraulic'),                // HYD/OIL PRESS (system A or B low)
      };
      for (const [k, on] of Object.entries(lights)) {
        const L = S.lights[k] || (S.lights[k] = { t: null, said: false });
        if (!on) { L.t = null; L.said = false; continue; }
        if (L.t === null) L.t = now;
        if (!L.said && now - L.t >= 1.5 && air) { L.said = true; sayV(io, 'warning', 'v_warning', P.warning); }
      }
      // caution lights → "CAUTION CAUTION" 7 s after (FWD/AFT FUEL LOW: reservoirs < 400 / 250 lb)
      const cautions = { fuelLow: s.fuelKg > 0 && s.fuelKg < fuelLowKg };
      for (const [k, on] of Object.entries(cautions)) {
        const C = S.cautions[k] || (S.cautions[k] = { t: null, said: false });
        if (!on) { C.t = null; C.said = false; continue; }
        if (C.t === null) C.t = now;
        if (!C.said && now - C.t >= 7 && air) { C.said = true; sayV(io, 'caution', 'v_caution', P.caution); }
      }
      // ALTITUDE: radar altitude below the CARA ALOW with the gear up; armed once above ALOW
      if (!s.gearHandle && s.gear <= 0.02) {
        if (s.ft > alowFt + 50) S.altArmed = true;
        if (S.altArmed && air && s.ft < alowFt) { S.altArmed = false; sayV(io, 'altitude', 'v_altitude', P.altitude); }
      } else S.altArmed = false;
      // BINGO once
      if (!S.bingo && air && s.fuelKg > 0 && s.fuelKg < bingoKg) { S.bingo = true; sayV(io, 'bingo', 'v_bingo', P.bingo); }
      // PULLUP (ground-avoidance advisory / fly-up), repeated while the condition lasts
      pullRep.update(io, air && !!s.w.pullUp);
      // tones: voice messages have priority over the low-speed tone, which has priority over the LG horn
      const vms = io.speakingSystem('vms');
      // gear handle down: AOA >= 15° (the flight model's warnings.lowSpeed when published); gear handle up: only the
      // nose-high schedule of T.O. 1F-16A-1 / AD-A145469 (pitch 45-90° and KIAS < 2.22 x pitch) — the model's gear-up
      // lowSpeed flag (FLCS limiter, out of energy) is HUD/hint only: the real jet has no tone for it
      const lsFlag = FLAGS.fighterLowSpeed.find((k) => s.wHas[k]);
      const gearDownLs = s.gearHandle || s.flapsIndex >= 1;
      const lowSpeed = air && (gearDownLs ? (lsFlag ? !!s.w[lsFlag] : s.aoa >= 15)
        : s.pitch >= 45 && s.pitch <= 90 && s.kt < 2.22 * s.pitch);
      const hornCond = air && gearNotDown && s.kt < 190 && s.altFt < 10000 && s.fpm < -250;
      if (hornCond) { if (S.hornT === null) S.hornT = now; } else S.hornT = null;
      io.loop('lowSpeed', lowSpeed && !vms);
      io.loop('lgHorn', hornCond && now - S.hornT >= 0.5 && !lowSpeed && !vms);
    },
  };
}

// ================================================================================================ F-22 ICAWS
/** F-22 integrated caution/advisory/warning: cautions = aural tone (sourced), warnings = tone + synthesized voice in the
 *  headset (existence sourced, words assumed), PULL UP (assumed). No F-16 VMS vocabulary. */
export function f22Icaws(dir, { fuelLowFrac = 0.12 } = {}) {
  const v = (n) => `${dir}/${n}`;
  const files = ['v_pullup', 'v_gear', 'v_engfail_l', 'v_engfail_r', 'caution'].map(v);
  const pullRep = repeater('icaw:pullup', v('v_pullup'), 100, 0.1, { system: 'icaws' });
  const gearRep = repeater('icaw:gear', v('v_gear'), 80, 4, { system: 'icaws' });
  let S;
  const reset = () => { S = { fuelLow: false, eng: [false, false], fire: false, hyd: false }; pullRep.reset(); gearRep.reset(); };
  reset();
  return {
    name: 'icaws', files, loops: {}, reset,
    update(s, io) {
      const air = !s.onGround;
      pullRep.update(io, air && !!s.w.pullUp);
      gearRep.update(io, air && s.gear < 0.98 && s.altFt < 10000 && s.kt < 200 && s.fpm < -250);
      s.eng.forEach((e, i) => {
        const fail = air && e.n1 < 0.55;
        if (fail && !S.eng[i]) io.say('icaw:eng' + i, v(i ? 'v_engfail_r' : 'v_engfail_l'), 85, { system: 'icaws' });
        S.eng[i] = fail;
      });
      const low = s.fuelKg > 0 && s.fuelFrac < fuelLowFrac;
      if (low && !S.fuelLow && air) io.tone(v('caution'), { tag: 'icaw:fuel_low' });
      S.fuelLow = low;
      // failures: engine fire / hydraulic low → ICAWS tone (the warning tone is not recorded: the caution tone stands in)
      const fire = air && flag(s, 'fire'), hyd = air && flag(s, 'hydraulic');
      if ((fire && !S.fire) || (hyd && !S.hyd)) io.tone(v('caution'), { tag: 'icaw:failure' });
      S.fire = fire; S.hyd = hyd;
    },
  };
}

// ================================================================================================ UH-60M
/**
 * UH-60M voice warnings. The UH-60M operator's manual (TM 1-1520-280-10) is not public; its training manual (TC 3-04.33)
 * names "low rotor RPM audio", "engine out audio" and the UH-60M has radar-altimeter low-bug audio (ARL 2006). The
 * closest documented Army H-60 voice warning system is the MH-60K VWS (TM 1-1520-250-10, para 2-227, table 2-6), used
 * here: ENGINE 1 OUT / ENGINE 2 OUT (Ng <= 55 %, not inhibited on the ground) and LOW ROTOR (NR < 96 %, inhibited with
 * weight on wheels) = priority 2: 2 s continuous 250 Hz tone (the UH-60A/L "low steady tone"), 0.5 s, message, 1 s,
 * message; ALTITUDE LOW (radar altitude below the low bug) = priority 4: message, 0.5 s, message, 1 s, message. A cycle
 * repeats after 1 s while its condition holds and is cut when the condition clears. The game has no VOICE ACK button, so
 * simultaneous messages take turns (priority order) instead of the highest one repeating alone.
 * No tone or voice for rotor overspeed (flight.warnings.highRotor): no H-60 manual has a high-rotor-RPM aural, so NR 124 %
 * with the collective down is silent here by design.
 */
export function uh60Vws(dir, { lowBugFt = 50, lowBugSinkFpm = 300 } = {}) {
  const v = (n) => `${dir}/${n}`;
  const MSG = [
    { id: 'eng1', file: 'v_eng1out', prio: 92 }, { id: 'eng2', file: 'v_eng2out', prio: 91 },
    { id: 'lowrotor', file: 'v_lowrotor', prio: 90 }, { id: 'altlow', file: 'v_altlow', prio: 70, once: true },
  ];
  const tag = (m) => 'vws:' + m.id;
  let S;
  const reset = () => { S = { low: false, bugArmed: false, cond: {}, pending: new Set(), last: null }; };
  reset();
  return {
    name: 'vws', files: MSG.map((m) => v(m.file)), loops: {}, reset,
    debug: () => ({ active: MSG.filter((m) => S.cond[m.id]).map((m) => m.id) }),
    update(s, io) {
      const now = io.now, air = !s.onGround;
      const lrFlag = FLAGS.lowRotor.find((k) => s.wHas[k]);
      S.low = air && s.rotor > 0.3 && (lrFlag ? !!s.w[lrFlag] : s.rotor < (S.low ? 0.97 : 0.96));   // WOW-inhibited
      const cond = {
        eng1: s.rotor > 0.05 && (s.eng[0]?.n1 ?? 1) <= 0.55,
        eng2: s.rotor > 0.05 && (s.eng[1]?.n1 ?? 1) <= 0.55,
        lowrotor: S.low,
        altlow: false,
      };
      // ALTITUDE LOW: descending through the radar-altimeter low bug (game setting 50 ft); a slow controlled descent to
      // a hover / landing (< 300 fpm) does not sound (the crew would have acknowledged / reset the bug)
      if (s.ft > lowBugFt + 25) S.bugArmed = true;
      if (S.bugArmed && air && s.ft < lowBugFt) { S.bugArmed = false; if (s.fpm < -lowBugSinkFpm) S.pending.add('altlow'); }
      if (!air) S.pending.delete('altlow');
      for (const m of MSG) {
        const on = m.once ? S.pending.has(m.id) : !!cond[m.id];
        if (on && !S.cond[m.id] && !m.once) S.pending.add(m.id);        // a new message gets the next turn
        if (!on && S.cond[m.id] && !m.once) { S.pending.delete(m.id); io.stop(tag(m)); }
        S.cond[m.id] = on;
      }
      if (io.speakingSystem('vws')) return;
      const active = MSG.filter((m) => S.cond[m.id]);
      if (!active.length) return;
      if (S.last && now - io.endedAt(tag(S.last)) < 1.0) return;         // 1 s gap between cycles
      let pick = active.find((m) => S.pending.has(m.id));
      if (!pick) {                                                        // round robin in priority order
        const i = S.last ? active.findIndex((m) => m.prio < S.last.prio) : 0;
        pick = active[i >= 0 ? i : 0];
      }
      S.pending.delete(pick.id);
      if (pick.once) S.cond[pick.id] = false;
      S.last = pick;
      io.say(tag(pick), v(pick.file), pick.prio, { system: 'vws', maxAge: 2 });
    },
  };
}
