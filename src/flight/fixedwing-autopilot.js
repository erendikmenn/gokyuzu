// Autopilot + autothrust for the fixed-wing model.
//
// Engaged in flight with the `autopilot` action: holds the heading, altitude (rounded to 100 ft) and indicated
// airspeed present at engagement (autothrust). While engaged the pilot's keys move the targets instead of the
// surfaces: pitch = altitude target, roll = heading target, throttle lever movements = speed target.
// Approach mode (APP) arms itself when the gear is down (or flaps in landing range) and a runway end from
// world.runways lies ahead: LOC (localizer, extended centerline) and G/S (3° glide path to a point 300 m past the
// threshold) capture, LAND below 400 ft, FLARE at 50 ft with thrust RETARD, ROLLOUT on the centerline after touchdown
// (autobrake + ground spoilers do the rest), then the autopilot disconnects below 10 m/s.
// In the approach modes a firm stick input disconnects the autopilot (pilot takes over).
//
// LNAV (NAV lateral mode, src/nav/lnav.js): with a route set on the model (m.route, guidance in m.nav) the autopilot
// engages in NAV and follows the legs (bank-limited turns with anticipation); each sequenced waypoint sets the altitude
// target; a roll input reverts to HDG (heading select). A route approach ("Bu piste yaklaş") decelerates on the approach
// legs, lets the pilot-monitoring assist extend flaps / gear when the pilot has not (airliners; fighters: gear), and
// arms the ILS logic for **that** runway on the final legs. A.approachRunway ('KSFO 28R') restricts the gear-down
// approach arming to the selected runway end.
import { DEG, G0, FT, KT, clamp, wrap360, wrap180, moveToward } from './fixedwing-util.js';
import { clampFixedWing } from '../nav/speed.js';   // route speeds: VLS / VMO / MMO / VFE / VLE limits

const GS_ANGLE = 3 * DEG;
const AIM_DIST = 300;           // m past the threshold (glide path origin, TCH ~ 50 ft)
const NM = 1852;
const NAV_KHDG_FIGHTER = 3.5;

/** Runway ends of world.runways (airports → runways → ends) as approach candidates (cached per data object). */
const _cache = new WeakMap();
export function runwayEnds(runways) {
  if (!runways || typeof runways !== 'object') return [];
  if (_cache.has(runways)) return _cache.get(runways);
  const list = [];
  for (const apt of runways.airports || []) {
    for (const r of apt.runways || []) {
      const [a, b] = r.ends || [];
      if (!a || !b) continue;
      for (const [e, o] of [[a, b], [b, a]]) {
        const crs = (e.headingTrue ?? 0) * DEG;
        const dx = Math.sin(crs), dz = -Math.cos(crs);
        list.push({
          airport: apt.icao, ident: e.ident, name: `${apt.icao} ${e.ident}`,
          x: e.x, z: e.z, course: crs, dx, dz, elevation: e.elevation ?? r.elevation ?? apt.elevation ?? 0,   // (sloped runways: the threshold's own)
          length: Math.hypot(o.x - e.x, o.z - e.z), width: r.width ?? 45,
          aimX: e.x + dx * AIM_DIST, aimZ: e.z + dz * AIM_DIST,
        });
      }
    }
  }
  _cache.set(runways, list);
  return list;
}

/** Geometry of the aircraft relative to a runway end's approach (along = m before the aim point, lateral = m right). */
export function approachGeometry(rw, x, z, out = {}) {
  const vx = x - rw.aimX, vz = z - rw.aimZ;
  out.along = -(vx * rw.dx + vz * rw.dz);
  // right of the course direction (dx, dz) is (-dz, dx)
  out.lateral = vx * -rw.dz + vz * rw.dx;
  out.distThreshold = out.along - AIM_DIST;
  out.gsAlt = rw.elevation + Math.max(out.along, 0) * Math.tan(GS_ANGLE);
  return out;
}

/** Best runway end whose final approach the aircraft is on (or can intercept), or null. only: runway end name. */
export function findApproach(runways, x, z, headingRad, maxDist = 35000, only = null) {
  let best = null, bestScore = Infinity;
  const g = {};
  for (const rw of runwayEnds(runways)) {
    if (only && rw.name !== only) continue;
    approachGeometry(rw, x, z, g);
    if (g.along < 1500 || g.along > maxDist) continue;
    const ang = Math.atan2(Math.abs(g.lateral), g.along);
    if (ang > 35 * DEG) continue;
    const dh = Math.abs(wrap180((headingRad - rw.course) / DEG)) * DEG;
    if (dh > 75 * DEG) continue;
    const score = ang * 2 + dh + g.along / 60000;
    if (score < bestScore) { bestScore = score; best = rw; }
  }
  return best;
}

export function createAutopilot(m) {
  const spec = m.spec;
  const P = spec.autopilot || {};
  const fighter = spec.category === 'fighter';
  const A = m.autopilot;            // public { on, altitude, heading, speed, mode, athr, lnav, approachRunway }
  const out = m.apOut;              // demands for the FCS / engines
  A.lnav = false;                   // lateral NAV (route) engaged
  if (A.approachRunway === undefined) A.approachRunway = null;
  const st = {
    athrI: 0, iasPrev: 0, iasRate: 0, lastLever: null,
    app: null, phase: '', geo: {}, searchT: 0, vsCmd: 0, retard: false, rolloutT: 0,
    routeApp: false, navSeq: -1, navVer: -1, navSpeed: NaN, cfgT: 0, cfgGeo: {},
  };

  function lateralModeName() { return st.phase || (st.app && st.routeApp) ? 'LOC' : A.lnav ? 'NAV' : 'HDG'; }

  function setMode() {
    if (!A.on) { A.mode = ''; return; }
    if (st.phase === 'ROLLOUT' || st.phase === 'FLARE' || st.phase === 'LAND') { A.mode = st.phase; return; }
    let vert;
    if (st.phase === 'GS') vert = 'G/S';
    else {
      const err = A.altitude - m.altitude;
      vert = Math.abs(err) < 60 ? 'ALT' : err > 0 ? 'CLB' : 'DES';
    }
    A.mode = `${lateralModeName()} ${vert}${st.app && !st.phase ? ' APP' : ''}`;
  }

  function resetNav() { st.routeApp = false; st.navSeq = -1; st.navVer = -1; st.navSpeed = NaN; st.cfgT = 0; }

  function engage() {
    if (m.crashed || m.wow || m.agl < 30) return false;
    A.on = true; A.athr = true;
    A.altitude = Math.round(m.altitude / (100 * FT)) * 100 * FT;
    A.heading = wrap360(m.heading);
    A.speed = Math.max(m.ias, m.vSpeeds.vls || 0);     // engaged while slow (e.g. to silence a disconnect alert): at least VLS
    st.athrI = m._leverPower();
    st.iasPrev = m.ias; st.iasRate = 0;
    st.lastLever = null;
    st.app = null; st.phase = ''; st.retard = false; st.searchT = 0;
    resetNav();
    // a route with a leg to fly: NAV, the first leg from the present position
    A.lnav = !!(m.route && m.route.hasActive);
    if (A.lnav) m.route.restartLeg();
    m.fcs.st.holding = false;
    setMode();
    m._emit('autopilot', { on: true, mode: A.mode });
    return true;
  }

  /** Map "Rotayı uç": engage in NAV, or switch an engaged autopilot from HDG to NAV. */
  function engageNav() {
    if (!(m.route && m.route.hasActive)) return false;
    if (!A.on) return engage();
    if (st.phase) return false;       // LOC / G/S captured: the approach stays
    A.lnav = true;
    if (!A.athr) { A.athr = true; st.athrI = m._leverPower(); st.lastLever = null; }   // re-arms a fighter's route A/THR
    resetNav();
    if (st.app) st.app = null;
    m.route.restartLeg();
    setMode();
    return true;
  }

  function disengage(reason = '') {
    if (!A.on) return;
    A.on = false; A.athr = false; A.lnav = false;
    out.active = false;
    st.phase = ''; st.app = null; st.routeApp = false;
    // hand the thrust back without a jump: the input lever is synced to the current autothrust setting
    m.pendingThrottle = m._effectiveLever();
    m._leverTarget = m.pendingThrottle;
    m._leverLatched = true; m._leverRef = null;     // keep that thrust until the input lever is synced / moved
    m._lever = m._leverTarget;
    m.fcs.st.holding = false;
    A.mode = '';
    m._emit('autopilot', { on: false, reason });
  }

  function toggle() { if (A.on) disengage('pilot'); else engage(); }

  /** Autothrottle off, autopilot on (fighter route + throttle input): the lever takes the present thrust. */
  function athrOff() {
    A.athr = false;
    m.pendingThrottle = m._effectiveLever();
    m._leverTarget = m.pendingThrottle;
    m._leverLatched = true; m._leverRef = null;
    m._lever = m._leverTarget;
    m._emit('nav', { type: 'athr', on: false });
  }

  function update(h, inp, world) {
    out.active = A.on;
    out.nCmd = null; out.pCmd = null; out.power = null; out.pedal = null; out.groundPitch = null;
    if (!A.on) return;
    const ad = m.ad;
    // ---- automatic disconnects
    if (m.crashed || (!m.wow && (Math.abs(ad.phi) > 50 * DEG || ad.theta > 30 * DEG || ad.theta < -25 * DEG || m.stalled))) { disengage('limit'); return; }
    if (m.wow && st.phase !== 'ROLLOUT' && st.phase !== 'FLARE') { disengage('ground'); return; }
    const captured = st.phase === 'GS' || st.phase === 'LAND' || st.phase === 'FLARE' || st.phase === 'ROLLOUT';
    const stick = Math.max(Math.abs(inp.pitch ?? 0), Math.abs(inp.roll ?? 0));
    if (captured && stick > 0.3) { disengage('stick'); return; }

    // ---- pilot adjusts the targets
    if (!captured) {
      A.altitude = clamp(A.altitude + (inp.pitch ?? 0) * (fighter ? 40 : 10) * h, 0, spec.serviceCeiling ?? 12500);
      A.heading = wrap360(A.heading + (inp.roll ?? 0) * (fighter ? 15 : 6) * h);
    }
    const lever = inp.throttle ?? 0;
    if (st.lastLever != null && !st.retard) {
      const d = lever - st.lastLever;
      // route: a fighter's throttle movement takes the thrust back (A/THR off, AP stays); otherwise it moves the target
      if (d !== 0 && fighter && A.lnav && A.athr) athrOff();
      else if (d !== 0) A.speed = clamp(A.speed + d * (fighter ? 120 : 60), m.vSpeeds.vls || 50, (spec.limits.vmo ?? 180) - 3);
    }
    st.lastLever = lever;

    // ---- LNAV (route): altitude / speed targets per leg, approach arming for the selected runway
    const nav = m.nav;
    let navOk = A.lnav && !!nav && nav.valid;
    if (A.lnav && !navOk && !st.phase && !st.routeApp) {
      // route flown to its end (or cleared): hold the present heading
      A.lnav = false; A.heading = wrap360(ad.psi / DEG); A.speed = clampFixedWing(m, A.speed);   // keep a safe speed
      m._emit('nav', { type: 'end' });
    }
    if (A.lnav && !captured && Math.abs(inp.roll ?? 0) > 0.3) {
      // the pilot turns: heading select (HDG); the route stays for later ("Rotayı uç" on the map)
      A.lnav = false; navOk = false; A.heading = wrap360(ad.psi / DEG); A.speed = clampFixedWing(m, A.speed);
      if (st.routeApp && !st.phase) { st.routeApp = false; st.app = null; }
      m._emit('nav', { type: 'hdg' });
    }
    if (navOk) {
      if (nav.seq !== st.navSeq || m.route.version !== st.navVer) {
        st.navSeq = nav.seq; st.navVer = m.route.version;
        if (Number.isFinite(nav.alt) && !st.phase) A.altitude = clamp(nav.alt, 0, spec.serviceCeiling ?? 12500);
      }
      if (Number.isFinite(nav.speed) && nav.speed !== st.navSpeed) {
        st.navSpeed = nav.speed;
        if (!st.phase) A.speed = clampFixedWing(m, nav.speed);   // the leg's speed (the final keeps its own)
      }
      if (nav.appArm && nav.rw && !st.phase && st.app !== nav.rw) { st.app = nav.rw; st.routeApp = true; }
    }

    // ---- approach arming / guidance
    const wantApp = st.routeApp || m.sys.gearHandleDown || m.flapIndexTarget >= (P.appFlap ?? 99);
    if (wantApp && !st.app && world && world.runways) {
      st.searchT -= h;
      if (st.searchT <= 0) { st.searchT = 0.5; st.app = findApproach(world.runways, m._pos.x, m._pos.z, ad.psi, 35000, A.approachRunway); }
    }
    if (!wantApp && st.app && !st.phase) st.app = null;
    let hdgCmd = A.heading * DEG;
    if (navOk && !st.app) {
      // commanded track → heading (drift correction: heading − track)
      const vx = m.velocity.x, vz = m.velocity.z;
      const drift = Math.hypot(vx, vz) > 20 ? wrap180((ad.psi - Math.atan2(vx, -vz)) / DEG) * DEG : 0;
      hdgCmd = nav.trackCmd + clamp(drift, -0.3, 0.3);
      A.heading = wrap360(hdgCmd / DEG);
    }
    let vsCmd;
    const V = Math.max(ad.V, 30);
    if (st.app) {
      const g = approachGeometry(st.app, m._pos.x, m._pos.z, st.geo);
      const gsSpeed = Math.hypot(m.velocity.x, m.velocity.z);
      // localizer: steer the cross-track velocity toward the centerline (intercept angle <= 30°)
      const vLatDes = clamp(-g.lateral / 18, -gsSpeed * 0.5, gsSpeed * 0.5);
      const trackCmd = st.app.course + Math.asin(clamp(vLatDes / Math.max(gsSpeed, 30), -0.5, 0.5));
      hdgCmd = trackCmd;
      A.heading = wrap360(hdgCmd / DEG);
      if (!st.phase) {
        // glide slope capture when established laterally and at / above the beam
        if (Math.abs(g.lateral) < 250 && m.altitude > g.gsAlt - 40 && g.along > 800) st.phase = 'GS';
      }
      if (st.phase === 'GS' && m.agl < 120) st.phase = 'LAND';
      if ((st.phase === 'LAND' || st.phase === 'GS') && m.agl < (P.flareHeight ?? 15)) st.phase = 'FLARE';
      if (st.phase === 'FLARE' && m.wow) {
        // fighters have no autoland / autobrake: the autopilot hands over at touchdown
        if (fighter) { disengage('touchdown'); return; }
        st.phase = 'ROLLOUT'; st.rolloutT = 0;
      }
      if (st.phase) {
        A.altitude = st.app.elevation;
        // approach speed once configured
        const vapp = m.vSpeeds.vapp;
        if (vapp && m.flapIndexTarget >= (P.appFlap ?? 0)) A.speed = moveToward(A.speed, vapp, 1.0 * h);
      }
      if (st.phase === 'GS' || st.phase === 'LAND') {
        vsCmd = -gsSpeed * Math.tan(GS_ANGLE) + clamp((g.gsAlt - m.altitude) * 0.15, -3, 3);
      } else if (st.phase === 'FLARE') {
        const hw = Math.max(m.agl, 0);
        vsCmd = -((P.flareSink ?? 0.45) + hw / (P.flareTau ?? 3.2));
        if (hw < (P.retardHeight ?? 6)) st.retard = true;
      }
    }
    if (vsCmd == null) {
      const err = A.altitude - m.altitude;
      const vsMax = P.vsMax ?? (fighter ? 60 : 12);
      vsCmd = clamp(err * 0.12, -vsMax, vsMax);
      // speed protection of the vertical modes: never trade the target speed for climb / descent
      const sErr = A.speed - m.ias;
      if (vsCmd > 0 && sErr > 3) vsCmd = Math.max(0, vsCmd - (sErr - 3) * 1.2);
      if (vsCmd < 0 && sErr < -3) vsCmd = Math.min(0, vsCmd - (sErr + 3) * 1.2);
    }
    st.vsCmd = vsCmd;

    // ---- lateral: heading → bank → roll rate
    const bankMax = (P.bankMax ?? (fighter ? 45 : 25)) * DEG;
    const hdgErr = wrap180((hdgCmd - ad.psi) / DEG) * DEG;
    // NAV: fighters (30°/s roll rate) tighten the heading law so turns roll out on the new leg
    const Khdg = fighter && ((navOk && !st.app) || (st.routeApp && !st.phase)) ? NAV_KHDG_FIGHTER : (P.Khdg ?? 2.0);
    let bankCmd = clamp(hdgErr * Khdg, -bankMax, bankMax);
    if (st.phase === 'FLARE' || st.phase === 'LAND') bankCmd = clamp(bankCmd, -8 * DEG, 8 * DEG);
    const pMax = (P.rollRate ?? (fighter ? 30 : 5)) * DEG;
    out.pCmd = clamp((bankCmd - ad.phi) * 0.8, -pMax, pMax);

    // ---- vertical: V/S → flight path → load factor
    const gCmd = Math.asin(clamp(vsCmd / V, -0.6, 0.6));
    const Kg = P.Kgamma ?? (fighter ? 1.2 : 0.8);
    out.nCmd = m.fcs.nLevel(ad.gamma, ad.phi, true) + (V * Kg * (gCmd - ad.gamma)) / G0;
    out.nCmd = clamp(out.nCmd, fighter ? -1 : 0.5, fighter ? 4 : 1.6);

    // ---- rollout: nose down, centerline via the rudder / nose wheel, idle
    if (st.phase === 'ROLLOUT') {
      out.nCmd = null; out.pCmd = null;
      st.rolloutT += h;
      out.groundPitch = -0.25;
      const g = st.geo;
      const hdgE = wrap180((ad.psi - st.app.course) / DEG);
      out.pedal = clamp(-(g.lateral * 0.04 + hdgE * 0.12), -1, 1);
      st.retard = true;
      if (m.groundSpeed < 10) { disengage('rollout'); return; }
    }

    // ---- autothrust (on a route never below VLS of the present configuration)
    const ias = m.ias;
    const rate = (ias - st.iasPrev) / Math.max(h, 1e-4);
    st.iasPrev = ias;
    st.iasRate += (rate - st.iasRate) * Math.min(1, h / 0.6);
    const pMaxT = P.athrMax ?? 1;
    if (st.retard) { out.power = 0; st.athrI = 0; }
    else if (!A.athr) { out.power = null; st.athrI = m._leverPower(); }   // manual thrust (fighter route, lever moved)
    else {
      const spd = A.lnav ? clampFixedWing(m, A.speed) : A.speed;
      const e = spd - ias;
      st.athrI = clamp(st.athrI + (P.athrKi ?? 0.012) * e * h, 0, pMaxT);
      out.power = clamp(st.athrI + (P.athrKp ?? 0.05) * e - (P.athrKd ?? 0.25) * st.iasRate, 0, pMaxT);
    }
    setMode();
  }

  /**
   * Once per frame (FixedWingModel.step): on a route approach flown by the autopilot the pilot-monitoring assist
   * configures the aircraft when the pilot has not: gear down at the glide-slope capture (or inside 7.5 NM on the final
   * legs); airliners also extend the flaps one detent at a time while the target speed is below what the present
   * configuration flies comfortably, slowing to the next detent's VFE on the glide slope.
   */
  function frame(dt) {
    if (!A.on || !A.lnav || m.wow || !m.route || !m.route.approach) return;
    if (!(m.route.onApproach || st.phase)) return;
    const sys = m.sys, V = m.vSpeeds, ias = m.ias;
    const onGs = st.phase === 'GS' || st.phase === 'LAND';
    const dThr = st.app ? approachGeometry(st.app, m._pos.x, m._pos.z, st.cfgGeo).distThreshold : Infinity;
    if (!sys.gearHandleDown && (onGs || (st.routeApp && dThr < 7.5 * NM)) && ias < (V.vle || Infinity) - 5 * KT) m.command('gear');
    st.cfgT -= dt;
    if (fighter || st.cfgT > 0 || st.phase === 'FLARE') return;
    const det = spec.flapDetents, k = sys.flapIndex, kL = spec.landingFlapIndex ?? det.length - 1;
    if (k >= kL) return;
    const vfeNext = det[k + 1].vfe || Infinity;
    let want;
    if (onGs) {
      want = true;
      if (A.speed > vfeNext - 8 * KT) A.speed = Math.max(vfeNext - 8 * KT, (V.vls || 0) + 5 * KT);
    } else want = A.speed < (V.vls || 0) + 12 * KT;
    if (want && ias < vfeNext - 4 * KT) { m.command('flapsDown'); st.cfgT = 4; }
  }

  function reset() {
    A.on = false; A.athr = false; A.mode = ''; A.lnav = false; out.active = false;
    st.phase = ''; st.app = null; st.retard = false; resetNav();
  }

  return { st, engage, engageNav, disengage, toggle, update, frame, reset };
}
