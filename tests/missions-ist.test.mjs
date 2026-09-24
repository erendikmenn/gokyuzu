// İstanbul missions tests (CONTRACTS-IST.md §6 Missions): the catalog (src/missions/ist/catalog.js) with 90 daily
// variations, its geometry against data/ist (runways, bridges, water), the new objective types with scripted samples
// (orbit, go-around, corridor / speed-window gates, hover height, pad outFail), the free-flight challenges
// (src/missions/ist/challenges.js), and the key missions flown by the real flight models against a fake İstanbul
// world (water from the DEM coastline, runways, pads, bridge decks and towers; the autopilot, simple stick / collective
// controllers or a reposition stand in for the player).
// Run: node tests/missions-ist.test.mjs   (no framework: PASS/FAIL table, exit 1 on failure)
// Optional: IST_WORLD=<module> flies against another world (a module whose default export is a world with the real
// terrain, used while designing the missions).
import { readFileSync, existsSync } from 'node:fs';
import { createFixedWingModel } from '../src/flight/fixedwing.js';
import { createHelicopterModel } from '../src/flight/helicopter.js';
import { runwayEnds } from '../src/flight/fixedwing-autopilot.js';
import { createRoute } from '../src/nav/route.js';
import { MISSIONS, BRIDGES, PLACES, PADS, PATHS, RW_ENDS, RW_FALLBACK, runwayThresholds, useRunways, buildMission, dailyMissionId, dailyMission } from '../src/missions/ist/catalog.js';
import { MISSIONS as SF_MISSIONS } from '../src/missions/catalog.js';
import { CHALLENGES as SF_CHALLENGES, createChallengeTracker, loadChallengeSet } from '../src/missions/challenges.js';
import { CHALLENGES, challengesFor, maxChallengeScore } from '../src/missions/ist/challenges.js';
import { createObjective } from '../src/missions/objectives.js';
import { scoreLanding, sampleTouchdown } from '../src/missions/landing-score.js';
import { dirOf, bearing, clamp, wrap180, KT, FT, FPM, DEG } from '../src/missions/util.js';

const RUNWAYS = JSON.parse(readFileSync(new URL('../data/ist/runways.json', import.meta.url), 'utf8'));
const FALLBACK_BEFORE = JSON.stringify(RW_ENDS);
useRunways(RUNWAYS);   // as the engine does when the map loads: missions from the file's thresholds
const REGION = JSON.parse(readFileSync(new URL('../data/ist/region.json', import.meta.url), 'utf8'));
const BRIDGE_FILE = new URL('../data/ist/bridges.json', import.meta.url);
const BRIDGE_DATA = existsSync(BRIDGE_FILE) ? JSON.parse(readFileSync(BRIDGE_FILE, 'utf8')) : null;
const ENDS = runwayEnds(RUNWAYS);
const SPECS = {};
for (const id of ['a320neo', 'b737', 'f16', 'f22', 'uh60']) SPECS[id] = (await import(`../src/aircraft/${id}/spec.js`)).default;

const rows = [];
function check(name, ok, detail = '') { rows.push({ name, ok: !!ok, detail }); }
const input = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, ...o });

// ---- fake İstanbul world -------------------------------------------------------------------------------------------
// Water: the Copernicus DEM sea level (≤ 0.3 m) vectorised at 24 m, simplified 60 m, polyline-encoded in 10 m units
// (x −29 … 35 km, z −26 … 21.9 km: Marmara, Boğaz, Haliç, the Black Sea coast by the Boğaz; islands as holes).
const WATER_ENC = "~xBrSv@INWIi@Vd@HWPBHuAVLIa@i@`@?o@WM]RRP]ID\\IMWFa@xC\\D,yiDg}B`@WB[|@?n@cAfA_@WwAgA_@e@ESRWMDVM?OZNHIxASH\\x@OHGWSPZ\\,dKjaDuA[u@wBs@LcAW}@L_BIuAs@uDu@oHi@gEBqA\\StAe@?Wd@BbBe@GQLBa@W[[?IZe@?BZ[R]IDQcA??OmBDWa@Be@o@]o@bAD[y@F]WVi@Gk@a@t@]?e@fBi@aAF}@e@FCRe@??_B_Br@][DqASt@[BgAcALs@k@n@QMSPIe@e@??W[DPu@s@\\o@E?Wn@i@cA?y@WVu@G}@LCBr@Mx@`@??e@P?DWEOWDCa@tAcBWa@t@k@BaA_B{A`@CS]`@}@x@o@IWV[bAP^[Hu@\\?fAo@dCwFpBiBj@sE~AgAvBe@d@}@Ca@`@[nAOdBgBtA]x@o@]}@w@Ik@gA}CgAe@o@?e@g@a@?i@t@BBMwBy@o@sBcB}@e@gAV_BbBuAd@kAfAh@n@QaA]OqAzAeFMQBmAo@qACgDVo@d@WnCo@?oAa@oCfAa@RuAr@k@|@oFt@Mh@u@~@?`DmB|Ba@d@_@vBk@r@}@Da@r@o@?MVW?SLC?MV?|CoCdBB`AbAVnAQHWWEHj@r@n@Nn@n@~A?Zn@V?Hd@lAzBZ?`@n@PI\\`@Pt@QtAwBx@MZPrCRCh@`@w@gDrCy@n@{AIe@i@i@?_A][D[WP][e@E[oAo@g@P[a@M?a@o@WGe@cAIy@cBo@SCe@W?Ma@cABS_@s@?k@]gDLWw@?iB\\{A`CqB~AE|@VhBDLWo@Ed@Cx@PHQF`@t@E?W`@ROe@HSH`@x@BbBa@RVn@DBPbAw@`@eBv@o@lAwBbBD|@Wn@a@n@qArB}@jDd@WWx@C|@_A~@QfAy@OS\\_@?Ok@j@CMfAgAlBr@B`@f@R|FFZ[CWd@Sd@w@Mg@bBuDDe@|@RLOIQvAk@LDEVn@EMHLV`@??S`@HCe@g@HRWtAPn@MH\\j@I?Zh@?CIBM`@bApA`AtA\\hBvBxF`ClBtAn@HVn@Er@Hs@n@ELWlADhBWr@qAfA]r@gBn@FNQZ`@xC?`@SIe@tA?RHEZn@?RRHSa@IMMBIn@VLd@\\Nr@IdCZdBe@`ACR]h@MDa@d@C?aCHV`@WLtAL??WZRDk@L`@L??e@d@BCgA`@DBn@n@O?aAy@k@NWxARC|@tABo@HC\\vBPd@QSo@x@r@pNs@?owAqxI?cAnA\\vBPNNOtA?jAx@Vn@gAa@Ht@VZd@?d@\\Qr@a@?LZIn@M?HVa@\\R`@u@EHyAn@_Ao@Wa@{B}@Io@e@cBzBPvAG^g@GDVWPy@e@Cd@S?RHE`@fAvBIZVHj@[RVjAVbAI|@r@Ea@VHHW`@?Rs@tAVh@n@gAZe@j@n@Zt@bAn@MO`ARLjGnC`@Nx@OMs@`@[O]j@Rr@E~@j@n@fAxAZt@j@hC|@LV\\DLSx@HzB`AIWN?h@f@\\?h@k@zAHpAhBnGxDvBt@x@?I]R?fA`@pDrEbB~DlAjABj@jAlB\\BHVLMVH]h@t@t@|@vB|@d@LCQI?MPFbDdERIBRRWVBOSs@CHMh@Hj@Z?Zj@f@nAg@vAvA^Ij@P|@nBbAB`@S`AN?V|@Vj@`A|@Vx@DHu@d@a@Z?Nt@d@LP?\\s@Z?\\V?Vg@jADWa@?S[[^Ht@d@LLx@[u@u@VHt@n@S[R?Vx@x@LEIR?n@VmAr@_@pABd@e@f@`@BvBx@vB_B^B\\W??ZV\\lA?E^`@t@jAPR\\e@LHZ`ANRZBVy@RR`ASLCx@Lt@d@ZCZd@lAe@`AuAHo@tA_Bx@{GxFy@RsCbBH|C]x@RtAkA~A^pDgAL_@`@a@BSRLHM`AQHI~APj@HhC[R`@BPx@a@`CgBtAoCDO|@uApBiC~@W~AL~ApAbBVjAnAn@~AC`@j@CVvBr@IpAy@pAe@pBj@~Av@j@QbB]`@cBLuAbASx@V~BqBj@iBBWVuAQ]fAe@?a@WCn@W?Wh@e@?E~CW`Ad@d@C`@k@H_@`@u@H[Sk@VQR?r@V`@h@a@e@x@s@LBVMWW?gAjAgAH}@Mg@V_@n@Zx@o@LCViBWa@a@[dBFVQBSn@s@BgAG]y@}@PcBe@sBIqBDo@d@wBCoBv@}@_EiBw@yAwAVj@~AjA?Rd@ZC[L?`@`@^rCVR[n@r@tAuAZCs@y@?CV]HQ]y@WMRu@?HV[Ba@_@a@PSWi@Cy@|@HZmAH[d@y@?W`@W[DqAoCR?WSFMM?a@y@\\We@uAB}@a@We@kCs@uAIWPmAW_@HOWcBHW[}@?]g@?e@WVqBIWREWe@Ba@[DZSDy@e@_BFWQ_@BE[[Ia@CMPy@I[s@]?IVuAIy@\\gAIQZk@CMP}@e@y@j@cBZIVSo@}@WIlZ oh@_kAcA[[o@Es@Wa@Do@d@e@rCWI|@~@d@v@lB}@j@ wl@e~Aw@CI]oCGHy@Oa@s@a@ZD~@iB`ASLRdBBd@VVn@WRS|@_@VBn@`@R waAa_Bs@u@Bs@_@o@Es@MBLSIo@`@QH]d@[hBC|@]Wt@x@Zj@[IgAzBPL`@Wj@\\PWj@qAx@y@BkAx@Wh@ZN?Va@?_@d@ qsAkeBqAI}@}@Ie@dCaFlAy@Li@]sEj@k@?}@SWHo@bDCd@VBh@`@HIj@w@h@BpAfA~A[d@BbAS`@zAHBPcBL[\\Ed@Vn@MtA iLemB]e@bAe@`@fA a{AwrBEi@_@MIcA]MH}@n@FfAbAa@zB";
function decodeRing(s) {
  const out = []; let i = 0, x = 0, z = 0;
  const one = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); return (r & 1) ? ~(r >> 1) : (r >> 1); };
  while (i < s.length) { x += one(); z += one(); out.push([x * 10, z * 10]); }
  return out;
}
const WATER = WATER_ENC.split(',').map((p) => p.split(' ').map(decodeRing));
function inRing(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const seaAt = (x, z) => WATER.some((p) => inRing(p[0], x, z) && !p.slice(1).some((h) => inRing(h, x, z)));
// runways (+ 150 m of land around them), sloped between their ends' elevations (runways.json per-end values, like the
// terrain); pads and the Yenikapı field as small plateaus
const RECTS = [];
for (const apt of RUNWAYS.airports) for (const r of apt.runways) {
  const [a, b] = r.ends; const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  const ev = (e) => e.elevation ?? r.elevation ?? apt.elevation;
  RECTS.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2, ea: ev(a), eb: ev(b) });
}
const inRect = (r, x, z, m) => { const px = x - r.ax, pz = z - r.az, al = px * r.ux + pz * r.uz; return al >= -m && al <= r.len + m && Math.abs(px * -r.uz + pz * r.ux) <= r.half + m; };
const rectElev = (r, x, z) => r.ea + (r.eb - r.ea) * clamp(((x - r.ax) * r.ux + (z - r.az) * r.uz) / r.len, 0, 1);
const PLATEAUS = [{ ...PADS.yenikapi, r: 60 }, { ...PADS.kisikli, r: 60 }, { x: -2400, z: 2650, y: 5, r: 220 }];
const plateau = (x, z) => PLATEAUS.find((p) => Math.hypot(x - p.x, z - p.z) < p.r) || null;
// bridge decks (the landmark's deck profile when data/ist/bridges.json exists) and towers
const DECKS = Object.entries(BRIDGES).map(([id, b]) => {
  const f = BRIDGE_DATA && (BRIDGE_DATA.bridges || []).find((x) => x.id === id);
  const ax = dirOf(b.axis);
  return { id, b, ax, n: { dx: -ax.dz, dz: ax.dx }, deck: f ? f.deck : null, towerTop: f ? f.towerTop : 165 };
});
function deckAt(x, z, out) {
  out.bottom = -Infinity; out.top = -Infinity;
  for (const d of DECKS) {
    const vx = x - d.b.x, vz = z - d.b.z, s = vx * d.ax.dx + vz * d.ax.dz, c = vx * d.n.dx + vz * d.n.dz;
    if (Math.abs(c) > 16 || Math.abs(s) > d.b.half + 250) continue;
    let bottom = d.b.clear + 7 * (1 - (s / d.b.half) ** 2);
    if (d.deck) { let best = null; for (const p of d.deck) if (!best || Math.abs(p.s - s) < Math.abs(best.s - s)) best = p; bottom = best.bottom; out.top = best.top; } else out.top = bottom + 5;
    out.bottom = bottom;
    return out;
  }
  return out;
}
const towerHit = (x, y, z) => DECKS.find((d) => {
  for (const sg of [-1, 1]) {
    const tx = d.b.x + d.ax.dx * d.b.half * sg, tz = d.b.z + d.ax.dz * d.b.half * sg;
    if (Math.hypot(x - tx, z - tz) < 18 && y < d.towerTop) return true;
  }
  return false;
});
const span = { bottom: -Infinity, top: -Infinity };
const fakeWorld = {
  runways: RUNWAYS, region: REGION,
  getGroundHeight: (x, z) => { const p = plateau(x, z); if (p) return p.y; const r = RECTS.find((q) => inRect(q, x, z, 150)); return r ? rectElev(r, x, z) : 0; },
  isWater: (x, z) => !plateau(x, z) && !RECTS.some((r) => inRect(r, x, z, 150)) && seaAt(x, z),
  isOnRunway: (x, z) => RECTS.some((r) => inRect(r, x, z, 0)),
  getObstacleHeight: (x, z) => { deckAt(x, z, span); return span.top; },
  getObstacleSpan: (x, z, out = {}) => deckAt(x, z, out),
  hitTest: (x, y, z) => { deckAt(x, z, span); if (y > span.bottom - 1 && y < span.top + 1) return 'köprü'; const t = towerHit(x, y, z); return t ? t.b.name : null; },
};
const world = process.env.IST_WORLD ? (await import(process.env.IST_WORLD)).default : fakeWorld;
const env = (mission) => ({ ends: ENDS, bridges: BRIDGES, score: mission ? mission.score : {}, spanAt: (x, z, o) => world.getObstacleSpan(x, z, o) });

// sample like src/missions/runtime.js
function sampler() {
  const s = { t: 0, dt: 0, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, agl: 0, ias: 0, gs: 0, vs: 0, hdg: 0, pitch: 0, roll: 0, onGround: true, first: true };
  return {
    s,
    fill(f, dt) {
      s.px = s.x; s.py = s.y; s.pz = s.z;
      s.x = f.position.x; s.y = f.position.y; s.z = f.position.z;
      s.dt = dt; s.t += dt; s.agl = f.agl; s.ias = f.ias; s.gs = Math.hypot(f.velocity.x, f.velocity.z); s.vs = f.verticalSpeed;
      s.hdg = f.heading; s.pitch = f.pitch; s.roll = f.roll; s.onGround = f.onGround;
    },
  };
}
function start(m, f) {
  const st = m.start;
  if (st.runway || st.final) {
    const e = ENDS.find((r) => r.name === (st.runway || st.final));
    if (st.runway) f.reset({ x: e.x + e.dx * 45, z: e.z + e.dz * 45, heading: e.course }, world);
    else f.reset({ x: e.x - e.dx * st.dist, z: e.z - e.dz * st.dist, heading: e.course, altitude: e.elevation + (st.dist + 300) * Math.tan(3 * DEG) }, world);
  } else {
    const opts = {};
    if (st.gear != null) opts.gearDown = !!st.gear;
    if (st.flaps != null) opts.flapIndex = st.flaps;
    f.reset({ x: st.x, z: st.z, heading: st.hdg * DEG, altitude: st.alt, speed: st.kt * KT }, world, opts);
  }
}
/** Step at 60 Hz until each(t) returns false, the model crashes, or `secs` pass. */
function fly(f, inp, secs, each) {
  const dt = 1 / 60;
  f.step(0, inp, world);
  let t = 0;
  for (; t < secs; t += dt) {
    f.step(dt, inp, world);
    if (each && each(t, dt) === false) break;
    if (f.crashed) break;
  }
  return t;
}
/** Stick toward a pitch / bank target (simple P with rate damping), yaw 0. */
function stick(f, inp, pitchT, rollT) {
  inp.pitch = clamp((pitchT - f.pitch) * 0.12 - (f.angularVelocity ? f.angularVelocity.x * 0.8 : 0), -1, 1);
  inp.roll = clamp((rollT - f.roll) * 0.05, -1, 1);
}
/** Mission objectives run in order on a sampler (like the runtime); → { obs, cur, update(s), onLanding(card, td) } */
function runner(m) {
  const obs = m.objectives.map((d) => createObjective(d, env(m)));
  obs.forEach((o) => { o.start(); if (o.orient) o.orient(m.start.x ?? 0, m.start.z ?? 0); });
  const r = {
    obs, cur: 0, msgs: [],
    get o() { return obs[r.cur] || null; },
    update(s) {
      const o = obs[r.cur];
      if (!o || o.status !== 'active') return;
      o.update(s);
      if (o.message) { r.msgs.push(o.message); o.message = null; }
      if (o.status === 'done') r.cur++;
    },
    onLanding(card, td) { const o = obs[r.cur]; if (o) { o.onLanding(card, td); if (o.message) { r.msgs.push(o.message); o.message = null; } if (o.status === 'done') r.cur++; } },
    get done() { return r.cur >= obs.length; },
    get failed() { return obs.some((o) => o.status === 'fail'); },
    score(t) {
      const sc = m.score || {};
      let v = sc.base || 0;
      for (const o of obs) v += o.points;
      if (sc.par && sc.perSec) v += Math.round(Math.max(0, sc.par - t) * sc.perSec);
      return Math.round(v);
    },
    stars(t) {
      if (m.stars === 'landing') { const l = obs.find((o) => o.landing); return l ? l.landing.stars : 1; }
      if (m.stars === 'ditch') { const o = obs.find((x) => x.def.type === 'ditch'); return o && o.ditch ? o.ditch.stars : 1; }
      return clamp(m.stars.filter((th) => r.score(t) >= th).length, 1, 3);
    },
  };
  return r;
}
const inside = (x, z) => { const b = REGION.local; return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ; };

// =====================================================================================================================
// 1. catalog: 16–20 missions, every aircraft, 90 daily variations, geometry inside the map, texts
{
  const ac = new Set(MISSIONS.map((m) => m.aircraft));
  const lv = [1, 2, 3].map((l) => MISSIONS.filter((m) => m.level === l).length);
  const ids = MISSIONS.map((m) => m.id);
  check(`Catalog: ${MISSIONS.length} missions (16–20), ids ist-<name> (unique, ≤ 40 chars, no clash with San Francisco), all five aircraft, levels 1–3`,
    MISSIONS.length >= 16 && MISSIONS.length <= 20 && ids.every((id) => /^ist-[a-z0-9-]+$/.test(id) && id.length <= 40) && new Set(ids).size === ids.length
    && !ids.some((id) => SF_MISSIONS.some((m) => m.id === id)) && ac.size === 5 && lv.every((n) => n >= 4),
    `${ids.join(' ')} | aircraft ${[...ac].join(',')} | per level ${lv.join('/')}`);
  const bad = [];
  const DAYS = [];
  for (let i = 0; i < 90; i++) { const d = new Date(Date.UTC(2026, 9, 1) + i * 86400e3); DAYS.push(d.toISOString().slice(0, 10).replace(/-/g, '')); }
  const ascii = /\b(Kiz|Halic|Bogaz|Camlica|Sabiha Gokcen|Ataturk|Istanbul|Uskudar|Kopru|Koprusu|Dolmabahce|Suleymaniye|Topkapi|Sarayburnu Hisari)\b/;
  for (const def of MISSIONS) {
    for (const day of [null, ...DAYS]) {
      const m = buildMission(def.id, day);
      const st = m.start;
      const e = st.runway || st.final ? ENDS.find((r) => r.name === (st.runway || st.final)) : null;
      if ((st.runway || st.final) && !e) bad.push(`${def.id} ${day} start runway ${st.runway || st.final}`);
      if (!e && !inside(st.x, st.z)) bad.push(`${def.id} ${day} start outside`);
      if (!e && !(st.alt > 20 && st.kt > 0)) bad.push(`${def.id} ${day} start alt/kt`);
      if (e && st.final) { const x0 = e.x - e.dx * st.dist, z0 = e.z - e.dz * st.dist; if (!inside(x0, z0)) bad.push(`${def.id} ${day} final outside`); }
      for (const o of m.objectives) {
        if (o.target && !ENDS.find((r) => r.name === o.target)) bad.push(`${def.id} target ${o.target}`);
        if (o.runways && o.runways.some((n) => !ENDS.find((r) => r.name === n))) bad.push(`${def.id} runways ${o.runways}`);
        if (o.airports && o.airports.some((a) => !RUNWAYS.airports.find((x) => x.icao === a))) bad.push(`${def.id} airports ${o.airports}`);
        if (o.bridge && !BRIDGES[o.bridge]) bad.push(`${def.id} bridge ${o.bridge}`);
        for (const g of o.gates || []) {
          if (!inside(g.x, g.z)) bad.push(`${def.id} gate outside`);
          if (o.shape === 'frame' && g.y - g.hh < 40 && !world.isWater(g.x, g.z)) bad.push(`${def.id} ${day} low frame over land ${g.x},${g.z}`);
        }
        if ((o.gates || []).length > 16) bad.push(`${def.id} > 16 gates (markers)`);
        if (o.type === 'orbit' && !(o.rmin < o.rmax && o.ymin < o.ymax && inside(o.x, o.z))) bad.push(`${def.id} orbit`);
        if ((o.type === 'pad' || o.type === 'hover') && !inside(o.x, o.z)) bad.push(`${def.id} pad`);
      }
      for (const p of m.route || []) if (!inside(p.x, p.z) || !(p.alt > 100)) bad.push(`${def.id} route point`);
      if (!m.title || !m.brief || !m.goal || !m.teaches || /\{\w+\}/.test(m.brief + m.goal)) bad.push(`${def.id} text`);
      if (ascii.test(m.title + m.brief + m.goal + m.teaches + (m.note || ''))) bad.push(`${def.id} ASCII place name`);
      const sentences = m.brief.split(/[.!?](\s|$)/).filter((x) => x && x.trim().length > 2).length;
      if (sentences < 1 || sentences > 3) bad.push(`${def.id} brief ${sentences} sentences`);
      if (day && !m.note) bad.push(`${def.id} daily note`);
      if (!(m.stars === 'landing' || m.stars === 'ditch' || (Array.isArray(m.stars) && m.stars.length === 3 && m.stars[0] < m.stars[1] && m.stars[1] < m.stars[2]))) bad.push(`${def.id} stars`);
      if (!(m.limit > 30)) bad.push(`${def.id} limit`);
    }
  }
  check(`Catalog: ${MISSIONS.length} missions × (default + 90 daily variations) build — starts in region.json bounds, runways / bridges / targets exist, low frames over water, ≤ 16 gates, texts filled (no ASCII place names), 1–3 sentence briefs`,
    bad.length === 0, [...new Set(bad)].slice(0, 8).join('; '));
  // daily
  const a = dailyMissionId('20260924'), b = dailyMissionId('20260924'), m1 = dailyMission('20260924'), m2 = dailyMission('20260924');
  let repeats = 0, prev = null; const counts = {};
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400e3);
    const id = dailyMissionId(d.toISOString().slice(0, 10).replace(/-/g, ''));
    if (id === prev) repeats++;
    prev = id; counts[id] = (counts[id] || 0) + 1;
  }
  check('Daily (İstanbul): same day → same mission and variation, never twice in a row, every mission in rotation, map = ist',
    a === b && JSON.stringify(m1.params) === JSON.stringify(m2.params) && m1.day === '20260924' && m1.map === 'ist' && repeats === 0 && Object.keys(counts).length === MISSIONS.length,
    `${a} ${JSON.stringify(m1.params)} "${m1.note}"; 400 days: ${repeats} repeats`);
}

// 2. geometry against data/ist: runway ends, bridges (landmarks pipeline), places on the right side of the water
{
  // the missions read the thresholds from runways.json (useRunways, per-end elevations of the sloped runways); the
  // built-in table they start with until then must equal the file
  const bad = [];
  const file = runwayThresholds(RUNWAYS);
  for (const [name, e] of Object.entries(RW_FALLBACK)) {
    const r = file[name];
    if (!r || Math.hypot(r.x - e.x, r.z - e.z) > 1 || Math.abs(wrap180(r.hdg - e.hdg)) > 0.05 || Math.abs(r.elev - e.elev) > 0.2) bad.push(`${name} ${r ? `${r.x.toFixed(1)},${r.z.toFixed(1)} ${r.hdg} ${r.elev}` : 'missing'}`);
  }
  const perEnd = file['LTFM 17L'] && file['LTFM 35R'] && file['LTFM 17L'].elev < file['LTFM 35R'].elev - 20;
  check('Geometry: runway thresholds read from data/ist/runways.json (per-end elevations: LTFM 17L below 35R), the built-in fallback table = the file (±1 m, ±0.05°, ±0.2 m)',
    bad.length === 0 && perEnd && JSON.parse(FALLBACK_BEFORE)['LTFM 35L'].elev === RW_FALLBACK['LTFM 35L'].elev && RW_ENDS['LTFM 17L'] && RW_ENDS['LTFM 17L'].elev === file['LTFM 17L'].elev,
    bad.join('; ') || `LTFM 35R ${file['LTFM 35R'].elev} m, 17L ${file['LTFM 17L'].elev} m`);
  const bb = [];
  if (BRIDGE_DATA) {
    for (const [id, b] of Object.entries(BRIDGES)) {
      const f = (BRIDGE_DATA.bridges || []).find((x) => x.id === id);
      if (!f || Math.hypot(f.x - b.x, f.z - b.z) > 5 || Math.abs(wrap180(f.axis - b.axis)) > 0.5 || f.half !== b.half || Math.abs(f.clear - b.clear) > 1.5 || f.name !== b.name) bb.push(`${id} ${f ? `${f.x},${f.z} ${f.axis} ${f.half} ${f.clear} ${f.name}` : 'missing'}`);
    }
  }
  check(`Geometry: bridges = data/ist/bridges.json (±5 m, ±0.5°, half spacing, clearance ±1.5 m, names)${BRIDGE_DATA ? '' : ' — file not present yet'}`, bb.length === 0, bb.join('; '));
  const wet = [['Boğaz centreline', PATHS.bogaz.every(([x, z]) => fakeWorld.isWater(x, z))], ['Haliç centreline', PATHS.halic.every(([x, z]) => fakeWorld.isWater(x, z))],
    ['bridges over water', Object.values(BRIDGES).every((b) => fakeWorld.isWater(b.x, b.z))], ['Kız Kulesi at sea', fakeWorld.isWater(PLACES.kizKulesi.x, PLACES.kizKulesi.z)],
    ['Galata Kulesi / Çamlıca / Topkapı on land', ['galataKulesi', 'camlicaCamii', 'camlicaKulesi', 'topkapi', 'suleymaniye'].every((k) => !seaAt(PLACES[k].x, PLACES[k].z))],
    ['pads on land', Object.values(PADS).every((p) => !seaAt(p.x, p.z))]];
  check('Geometry: water centrelines and bridges over the sea, landmarks and pads on land (fake world water = DEM coastline)', wet.every((w) => w[1]), wet.filter((w) => !w[1]).map((w) => w[0]).join(', '));
}

// 3. objectives with scripted samples
{
  const put = (o, s, x, y, z, dt = 0.1, extra = {}) => { s.px = s.x; s.py = s.y; s.pz = s.z; Object.assign(s, { x, y, z, dt, ...extra }); s.t += dt; o.update(s); s.first = false; };
  // orbit: right-hand circle of r 200 at 80 m round a point; 90° the wrong way does not count; leaving the band for > grace restarts
  const def = { type: 'orbit', shape: 'ring', x: 1000, z: 1000, rmin: 150, rmax: 250, ymin: 50, ymax: 120, dir: 'right', grace: 5, label: 't' };
  const o = createObjective(def, { score: {} });
  o.orient(1000, 0); o.start();
  const s = { t: 0, first: true, onGround: false, px: 0, py: 0, pz: 0, x: 0, y: 0, z: 0, dt: 0.1 };
  const at = (a, r = 200, y = 80) => [1000 + Math.sin(a * DEG) * r, y, 1000 - Math.cos(a * DEG) * r];
  const idx0 = o.index, g0 = o.gates[0];
  const firstRingAhead = Math.abs(wrap180(bearing(1000, 1000, g0.x, g0.z) - 45)) < 1 && Math.abs(Math.hypot(g0.x - 1000, g0.z - 1000) - 200) < 0.01;
  put(o, s, ...at(0), 0.1, { first: true });
  for (let a = 0; a >= -90; a -= 3) put(o, s, ...at(a));                          // wrong way: nothing counts
  const wrongWay = o.swept === 0 && o.status === 'active';
  for (let a = -90; a <= 0; a += 3) put(o, s, ...at(a));                           // turned round: 90° to the right
  const half = o.swept > 85 && o.swept < 95 && o.index === 2;
  for (let i = 0; i < 70; i++) put(o, s, ...at(0, 400));                             // 7 s outside the radius band → restart
  const restarted = o.swept === 0 && o.exits === 1;
  for (let a = 0; a <= 365; a += 3) put(o, s, ...at(a, 210, 85));                   // a full circle
  const doneR = o.status === 'done';
  check('Objective orbit: rings from the start side; wrong way / outside the band do not count; > grace outside restarts; 360° right → done (radius, height, restart parts)',
    firstRingAhead && idx0 === 0 && wrongWay && half && restarted && doneR && o.points > 400 && o.points < 800 && o.parts.length === 3,
    `ring0 ${firstRingAhead}, wrong ${wrongWay}, half ${half} (${o.swept.toFixed(0)}), restart ${restarted}, ${o.status} ${o.points} ${JSON.stringify(o.parts)}`);
  // left orbit, clean → 800 − small deviations
  const o2 = createObjective({ ...def, dir: 'left' }, { score: {} }); o2.orient(1000, 0); o2.start();
  const s2 = { t: 0, first: true, onGround: false, px: 0, py: 0, pz: 0, x: 0, y: 0, z: 0 };
  for (let a = 360; a >= -5; a -= 2) put(o2, s2, ...at(a, 200, 85));
  check('Objective orbit: a clean left-hand circle on the ideal radius → done ≥ 780 points', o2.status === 'done' && o2.points >= 780, `${o2.status} ${o2.points}`);

  // go-around: height lost after the call costs points, a touchdown fails
  const ga = createObjective({ type: 'goaround', min: 600 }, { score: {} }); ga.start();
  const s3 = { t: 0, first: true, onGround: false, px: 0, py: 0, pz: 0, x: 0, y: 0, z: 0 };
  put(ga, s3, 0, 150, 0); const called = /PAS GEÇ/.test(ga.message || '');
  for (let y = 150; y >= 135; y -= 1) put(ga, s3, 0, y, 0);
  for (let y = 135; y <= 610; y += 5) put(ga, s3, 0, y, 0);
  const ga2 = createObjective({ type: 'goaround', min: 600 }, { score: {} }); ga2.start();
  const s4 = { t: 0, first: true, onGround: false, px: 0, py: 0, pz: 0, x: 0, y: 0, z: 0 };
  put(ga2, s4, 0, 60, 0); put(ga2, s4, 0, 5, 0, 0.1, { onGround: true });
  check('Objective goaround: call on activation; 15 m lost → done ≈ 360 pts; a touchdown → fail', called && ga.status === 'done' && ga.points > 300 && ga.points < 400 && ga2.status === 'fail' && /değ/.test(ga2.failReason),
    `${ga.status} ${ga.points} ${JSON.stringify(ga.parts)}; ${ga2.status} "${ga2.failReason}"`);

  // corridor + speed window gates (Boğaz low pass): above the ceiling for more than `grace` fails; a short hop costs points
  const m = buildMission('ist-bogaz-alcak');
  const mk = () => { const g = createObjective(m.objectives[0], env(m)); g.orient(m.start.x, m.start.z); g.start(); return g; };
  const thru = (g, s, q, y, extra = {}) => { put(g, s, q.x - q.nx * 60, y, q.z - q.nz * 60, 2, extra); put(g, s, q.x + q.nx * 60, y, q.z + q.nz * 60, 0.5, extra); };
  const g1 = mk(), s5 = { t: 0, first: true, onGround: false, ias: 180 };
  thru(g1, s5, g1.gates[0], 40);
  for (let i = 0; i < 40; i++) put(g1, s5, g1.gates[1].x - g1.gates[1].nx * 300, 200, g1.gates[1].z - g1.gates[1].nz * 300, 0.1);   // 4 s at 200 m
  const g2 = mk(), s6 = { t: 0, first: true, onGround: false, ias: 180 };
  thru(g2, s6, g2.gates[0], 40);
  put(g2, s6, g2.gates[1].x - g2.gates[1].nx * 400, 180, g2.gates[1].z - g2.gates[1].nz * 400, 1);    // 1 s high
  for (let i = 1; i < g2.gates.length; i++) thru(g2, s6, g2.gates[i], 40);
  const low = g2.parts.find((p) => p[0] === 'Alçak kalma');
  check('Objective gates corridor: > 3 s above 500 ft after gate 1 → fail; a 1 s hop → done with reduced "Alçak kalma" points',
    g1.status === 'fail' && /Alçak kalmadın/.test(g1.failReason) && g2.status === 'done' && low && low[2] > 0 && low[2] < 300,
    `${g1.status} "${g1.failReason}"; ${g2.status} ${g2.points} ${JSON.stringify(g2.parts)}`);
  const jm = buildMission('ist-kiz-kulesi-jet');
  const fb = createObjective(jm.objectives[1], env(jm)); fb.orient(jm.start.x, jm.start.z); fb.start();
  const s7 = { t: 0, first: true, onGround: false, ias: 305 * KT };
  thru(fb, s7, fb.gates[0], 31, { ias: 305 * KT });
  const kt = fb.parts.find((p) => p[0] === 'Hız');
  const fb2 = createObjective(jm.objectives[1], env(jm)); fb2.orient(jm.start.x, jm.start.z); fb2.start();
  const s8 = { t: 0, first: true, onGround: false, ias: 380 * KT };
  thru(fb2, s8, fb2.gates[0], 31, { ias: 380 * KT });
  const kt2 = fb2.parts.find((p) => p[0] === 'Hız');
  check('Objective gates speed window: 305 kt for 300 ± 40 → full speed points; 380 kt → none (still passes)', fb.status === 'done' && kt && kt[2] === 200 && fb2.status === 'done' && kt2 && kt2[2] === 0,
    `${fb.points} ${JSON.stringify(fb.parts)}; ${fb2.points} ${JSON.stringify(kt2)}`);
  // hover pointer height and done message; autorotation field: a touchdown outside fails
  const hm = buildMission('ist-heli-tur');
  const hv = createObjective(hm.objectives[0], env(hm)); hv.start();
  const s9 = { t: 0, onGround: false, x: hm.objectives[0].x + 5, z: hm.objectives[0].z, y: 95, gs: 0.5, dt: 0.1 };
  for (let i = 0; i < 60 && hv.status === 'active'; i++) hv.update(s9);
  const am = buildMission('ist-otorotasyon'), pd = am.objectives[0];
  const po = createObjective(pd, env(am)); po.start();
  po.onLanding(scoreLanding({ x: pd.x + pd.r + 40, z: pd.z, heading: 0, track: 0, vs: -1, roll: 0, pitch: 3, gs: 3 }, { category: 'helicopter', ends: ENDS, profile: 'autorotation' }), { x: pd.x + pd.r + 40, z: pd.z });
  check('Objective hover (Galata): pointer at the balcony height (ty), done message; pad with outFail: touchdown outside the field → fail',
    hv.target.y === 95 && hv.status === 'done' && /Haliç/.test(hv.message || '') && po.status === 'fail' && /Meydanın dışına/.test(po.failReason), `${hv.target.y} ${hv.status} "${hv.message}"; ${po.status} "${po.failReason}"`);
}

// =====================================================================================================================
// 4. missions flown by the flight models (fake İstanbul world)

/**
 * Low-level path pilot for the fighters (stands in for the player): pure pursuit of a point `look` m ahead on a
 * polyline [{ x, z, y }] (y = the height to hold near that vertex, interpolated), roll-rate commands up to 70° of bank,
 * a vertical-speed loop on the stick and the throttle for `kt` (no afterburner unless `ab`).
 */
function pathPilot(path, { kt = 330, ab = false, look = 700, maxBank = 70, vsMax = 10, legs = false, xk = 0.25, hk = 2.2 } = {}) {
  let k = 0;
  const P = path;
  return function steer(f, inp) {
    const x = f.position.x, z = f.position.z;
    // advance along the path: segment k while the projection is before its end
    let t = 0;
    for (;;) {
      const a = P[k], b = P[k + 1];
      if (!b) break;
      const lx = b.x - a.x, lz = b.z - a.z, L2 = lx * lx + lz * lz;
      t = ((x - a.x) * lx + (z - a.z) * lz) / L2;
      if (k >= P.length - 2) break;
      if (legs && t < 1) {   // fly-by: turn onto the next leg R·tan(Δψ/2) before the point (60° of bank)
        const c = P[k + 2], d1 = bearing(a.x, a.z, b.x, b.z), d2 = bearing(b.x, b.z, c.x, c.z);
        const v = f.ias, R = v * v / (9.81 * Math.tan(60 * DEG));
        const ant = R * Math.tan(Math.abs(wrap180(d2 - d1)) * DEG / 2);
        if ((1 - t) * Math.sqrt(L2) > ant) break;
      } else if (t < 1) break;
      k++;
    }
    const a = P[k], b = P[k + 1] || P[k];
    const tt = clamp(t, 0, 1);
    let hdgT, yT;
    if (legs) {
      // on the straight leg a → b (gates / frames): leg bearing + cross-track correction, the height of the next point
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1, ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      const xt = (x - a.x) * -uz + (z - a.z) * ux;
      hdgT = bearing(0, 0, ux, uz) + clamp(-xt * xk, -40, 40);
      yT = b.y;
    } else {
      yT = a.y + (b.y - a.y) * tt;
      // lookahead point along the path
      let rem = look, px = a.x + (b.x - a.x) * tt, pz = a.z + (b.z - a.z) * tt, j = k;
      while (rem > 0 && j < P.length - 1) {
        const q = P[j + 1], d = Math.hypot(q.x - px, q.z - pz);
        if (d >= rem) { px += (q.x - px) * rem / d; pz += (q.z - pz) * rem / d; rem = 0; } else { rem -= d; px = q.x; pz = q.z; j++; }
      }
      hdgT = bearing(x, z, px, pz);
    }
    const vsT = clamp((yT - f.altitude) * 0.5, -10, vsMax);
    inp.pitch = clamp((vsT - f.verticalSpeed) * 0.07, -0.5, 0.8);
    inp.roll = clamp((clamp(wrap180(hdgT - f.heading) * hk, -maxBank, maxBank) - f.roll) * 0.02, -0.45, 0.45);
    inp.throttle = clamp(0.5 + (kt - f.ias / KT) * 0.02, 0, ab ? 1 : 0.89);
    return { k, yT, hdgT };
  };
}
const pts = (arr, y) => arr.map(([x, z]) => ({ x, z, y }));
/** Straight ahead from the aircraft's position and heading, climbing to y (after the last objective point). */
const climbOut = (f, y = 800, kt = 330) => { const d = dirOf(f.heading); const x = f.position.x, z = f.position.z; return pathPilot([{ x, z, y }, { x: x + d.dx * 20000, z: z + d.dz * 20000, y }], { kt, vsMax: 40, maxBank: 30 }); };
/** Boğaz centreline from index i0 to i1 (either direction) at height y. */
function bogazPath(i0, i1, y) { const out = []; const st = i1 >= i0 ? 1 : -1; for (let i = i0; st > 0 ? i <= i1 : i >= i1; i += st) out.push({ x: PATHS.bogaz[i][0], z: PATHS.bogaz[i][1], y }); return out; }
/** A fighter mission flown with the path pilot; `then(o, f)` may change the path / targets per objective. */
function flyFighter(id, day, ac, path, opts, secs = 300, each = null) {
  const m = buildMission(id, day);
  const f = createFixedWingModel(SPECS[ac], {});
  start(m, f);
  const r = runner(m);
  const smp = sampler(); const inp = input({ throttle: f.throttle });
  let steer = pathPilot(path, opts);
  const trace = [];
  const t = fly(f, inp, secs, (t, dt) => {
    const g = steer(f, inp);
    if (each) { const ns = each(r, f, inp, g); if (ns) steer = ns; }
    smp.fill(f, dt); const nm = r.msgs.length; r.update(smp.s); smp.s.first = false;
    if (r.msgs.length > nm && /kaçtı|üstünden/.test(r.msgs.at(-1)) && r.o && r.o.p && r.o.gates) { const q = r.o.gates[r.o.index]; trace.push(`MISS g${r.o.index} at (${Math.round(r.o.p.x)},${Math.round(r.o.p.z)}) y ${Math.round(r.o.p.y)} vs (${q.x},${q.z}) y ${q.y}`); }
    if (Math.round(t * 60) % 120 === 0) trace.push(`${t.toFixed(0)}s (${Math.round(f.position.x)},${Math.round(f.position.z)}) ${Math.round(f.altitude)}m ${Math.round(f.ias / KT)}kt r${Math.round(f.roll)} o${r.cur}`);
    return !r.done && !r.failed;
  });
  return { m, f, r, t, trace, score: r.score(t), stars: r.done ? r.stars(t) : 0 };
}
const brief = (res) => `${res.t.toFixed(0)} s, ${res.r.obs.map((o) => `${o.def.type}:${o.status}:${o.points}`).join(' ')} → ${res.score} (${res.stars}★)${res.f.crashed ? ` CRASH ${res.f.crashReason}` : ''}${res.r.failed ? ` FAIL ${res.r.obs.find((o) => o.status === 'fail').failReason}` : ''}`;

// 4a. "15 Temmuz Şehitler Köprüsü'nün altından" (F-16): every start; along the Boğaz at 35 m, under the deck, climb
{
  const out = [];
  let ok = true;
  for (const [from, i0, i1] of [[0, 2, 4], [1, 1, 4], [2, 6, 3], [3, 8, 3]]) {
    const day = null;
    const def = MISSIONS.find((x) => x.id === 'ist-15temmuz');
    const save = def.params.from; def.params.from = from;
    const m = buildMission('ist-15temmuz', day);
    const path = [{ x: m.start.x, z: m.start.z, y: 35 }, ...bogazPath(i0, i1, 35)];
    let climbing = false;
    const res = flyFighter('ist-15temmuz', day, 'f16', path, { kt: 300 }, 150, (r, f) => { if (r.cur === 1 && !climbing) { climbing = true; return climbOut(f); } return null; });
    def.params.from = save;
    if (!(res.r.done && res.stars >= 2 && !res.f.crashed)) ok = false;
    out.push(`from ${from}: ${brief(res)}${!res.r.done ? ' | ' + res.trace.slice(-5).join(' | ') : ''}`);
  }
  check('Mission ist-15temmuz (F-16): from each of the 4 starts along the Boğaz, under the deck between the towers, 1.500 ft → ≥ 2★', ok, out.join(' || '));
}

// 4b. "Fatih Sultan Mehmet Köprüsü'nün altından" (F-22): each start, following the bends of the Boğaz
{
  const out = []; let ok = true;
  const def = MISSIONS.find((x) => x.id === 'ist-fsm');
  for (const [from, i0, i1] of [[0, 6, 11], [1, 13, 10], [2, 12, 10]]) {
    const save = def.params.from; def.params.from = from;
    const m = buildMission('ist-fsm');
    let climbing = false;
    const res = flyFighter('ist-fsm', null, 'f22', [{ x: m.start.x, z: m.start.z, y: 35 }, ...bogazPath(i0, i1, 35)], { kt: 300 }, 150, (r, f) => { if (r.cur === 1 && !climbing) { climbing = true; return climbOut(f); } return null; });
    def.params.from = save;
    if (!(res.r.done && res.stars >= 2 && !res.f.crashed)) ok = false;
    out.push(`from ${from}: ${brief(res)}${!res.r.done ? ' | ' + res.trace.slice(-5).join(' | ') : ''}`);
  }
  check('Mission ist-fsm (F-22): from each start through the Rumeli Hisarı bends, under the deck, 1.500 ft → ≥ 2★', ok, out.join(' || '));
}

// 4c. "Üç köprü" (F-22, level 3): 25 km of Boğaz at 35 m and 380 kt, under 15 Temmuz, FSM and YSS in order (both ways)
{
  const out = []; let ok = true;
  for (const north of [true, false]) {
    const day = north ? null : (() => { for (let i = 0; i < 60; i++) { const d = new Date(Date.UTC(2026, 9, 1) + i * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''); if (!buildMission('ist-uc-kopru', d).params.north) return d; } return null; })();
    const m = buildMission('ist-uc-kopru', day);
    const path = north ? [{ x: m.start.x, z: m.start.z, y: 35 }, ...bogazPath(1, 25, 35)] : [{ x: m.start.x, z: m.start.z, y: 35 }, ...bogazPath(24, 0, 35)];
    const res = flyFighter('ist-uc-kopru', day, 'f22', path, { kt: 340, look: 800 }, 300);
    if (!(res.r.done && res.stars >= 2 && !res.f.crashed)) ok = false;
    out.push(`${north ? 'north' : 'south'}: ${brief(res)}${!res.r.done ? ' | ' + res.r.msgs.join(' / ') + ' | ' + res.trace.slice(-6).join(' | ') : ''}`);
  }
  check('Mission ist-uc-kopru (F-22): both directions, under all three bridges in order at 340 kt, 35 m → ≥ 2★', ok, out.join(' || '));
}

// 4d. "Boğaz'da alçak geçiş" (F-22): six frames between Rumeli Hisarı and Kız Kulesi below 500 ft (both ways)
{
  const out = []; let ok = true;
  for (const south of [true, false]) {
    const day = south ? null : (() => { for (let i = 0; i < 60; i++) { const d = new Date(Date.UTC(2026, 9, 1) + i * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''); if (!buildMission('ist-bogaz-alcak', d).params.south) return d; } return null; })();
    const m = buildMission('ist-bogaz-alcak', day);
    const g = m.objectives[0].gates;
    const path = [{ x: m.start.x, z: m.start.z, y: g[0].y }, ...g.map((q) => ({ x: q.x, z: q.z, y: q.y }))];
    const last = g.at(-1), prev = g.at(-2);
    path.push({ x: last.x + (last.x - prev.x), z: last.z + (last.z - prev.z), y: last.y });
    const res = flyFighter('ist-bogaz-alcak', day, 'f22', path, { kt: 340, legs: true }, 150);
    if (!(res.r.done && res.stars >= 2 && !res.f.crashed)) ok = false;
    out.push(`${south ? 'south' : 'north'}: ${brief(res)} ${res.r.obs[0].parts.map((p) => p.join(' ')).join(', ')}${!res.r.done ? ' | ' + res.r.msgs.join(' / ') + ' | ' + res.trace.filter((x) => /MISS/.test(x)).join(' | ') + ' | ' + res.trace.slice(0, 20).join(' | ') : ''}`);
  }
  check('Mission ist-bogaz-alcak (F-22): six frames at 15–65 m, under 500 ft after gate 1, both directions → ≥ 2★', ok, out.join(' || '));
}

// 4e. "Haliç'te alçak uçuş" (F-16): six frames at 75–125 m up (and down) the Golden Horn, over all its bridges, climb
{
  const out = []; let ok = true;
  for (const up of [true, false]) {
    const day = up ? null : (() => { for (let i = 0; i < 60; i++) { const d = new Date(Date.UTC(2026, 9, 1) + i * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''); if (!buildMission('ist-halic', d).params.up) return d; } return null; })();
    const m = buildMission('ist-halic', day);
    const g = m.objectives[0].gates;
    const path = [{ x: m.start.x, z: m.start.z, y: g[0].y }, ...g.map((q) => ({ x: q.x, z: q.z, y: q.y }))];
    let climbing = false;
    const res = flyFighter('ist-halic', day, 'f16', path, { kt: 230, legs: true, xk: 0.3, hk: 2.5 }, 150, (r, f) => { if (r.cur === 1 && !climbing) { climbing = true; return climbOut(f, 800, 300); } return null; });
    if (!(res.r.done && res.stars >= 2 && !res.f.crashed)) ok = false;
    out.push(`${up ? 'up' : 'down'}: ${brief(res)}${!res.r.done ? ' | ' + res.r.msgs.join(' / ') + ' | ' + res.trace.filter((x) => /MISS/.test(x)).join(' | ') + ' | ' + res.trace.slice(0, 30).join(' | ') : ''}`);
  }
  check('Mission ist-halic (F-16): six Golden Horn frames at 100 m (both ways), then 2.000 ft → ≥ 2★', ok, out.join(' || '));
}

// 4f. "Kız Kulesi'nde alçak geçiş" (F-16): a left-hand circle of 1.45 km at 330 m round the tower, then down to the frame
//     beside it at 30 m and 300 kt
{
  const m = buildMission('ist-kiz-kulesi-jet');
  const k = PLACES.kizKulesi;
  const circle = [];
  const a0 = bearing(k.x, k.z, m.start.x, m.start.z);
  for (let i = 0; i <= 44; i++) { const a = (a0 - i * 10) * DEG; circle.push({ x: k.x + Math.sin(a) * 1450, z: k.z - Math.cos(a) * 1450, y: 330 }); }
  const fr = m.objectives[1].gates[0];
  let phase = 0;
  const res = flyFighter('ist-kiz-kulesi-jet', null, 'f16', [{ x: m.start.x, z: m.start.z, y: 330 }, ...circle], { kt: 280, look: 500 }, 240, (r, f) => {
    if (r.cur === 1 && phase === 0) {
      phase = 1;
      // the circle ends south of the tower: out over the Marmara, back north through the frame at 30 m
      return pathPilot([{ x: f.position.x, z: f.position.z, y: 330 }, { x: 4000, z: 4200, y: 250 }, { x: fr.x, z: 4000, y: 80 }, { x: fr.x, z: 2400, y: 30 }, { x: fr.x, z: fr.z, y: 30 }, { x: fr.x, z: fr.z - 2500, y: 30 }], { kt: 300, look: 500 });
    }
    return null;
  });
  const ok = res.r.done && res.stars >= 2 && !res.f.crashed;
  check('Mission ist-kiz-kulesi-jet (F-16): 360° left round Kız Kulesi in the band, then the 30 m / 300 kt frame → ≥ 2★', ok,
    `${brief(res)} ${res.r.obs.map((o) => o.parts.map((p) => p.join(' ')).join(', ')).join(' | ')}${!res.r.done ? ' | ' + res.r.msgs.join(' / ') + ' | ' + res.trace.filter((x) => /MISS/.test(x)).join(' | ') + ' | ' + res.trace.slice(-8).join(' | ') : ''}`);
}

// ---- helicopter flights: the UH-60's own NAV autopilot on routes stands in for the player (≤ 20° of bank, guided hover
//      at the route's last point); rings sit on straight route segments (a point 350 m before and after each ring);
//      a pad landing is the hover hold's point, then the collective down like the Alcatraz test
function heliNav(f, points, kt) {
  const route = createRoute();
  route.env = { groundAt: (x, z) => world.getGroundHeight(x, z), bounds: REGION.local };
  route.setPosition(f.position.x, f.position.z, f.heading * DEG);
  route.setDefaultSpeed({ ias: kt * KT });
  for (const p of points) route.add(p.x, p.z, { alt: p.y });
  f.setRoute(route);
  f.command('nav');
  return route;
}
/** Route points through rings: 350 m before each ring on the line from `from` (the ring plane's normal), the ring, 250 m after. */
function ringRoute(gates, x0, z0) {
  const out = [];
  let px = x0, pz = z0;
  for (const g of gates) {
    const fx = g.from ? g.from[0] : px, fz = g.from ? g.from[1] : pz;
    const L = Math.hypot(g.x - fx, g.z - fz), ux = (g.x - fx) / L, uz = (g.z - fz) / L;
    if (L > 500) out.push({ x: g.x - ux * 350, z: g.z - uz * 350, y: g.y });
    out.push({ x: g.x, z: g.z, y: g.y }, { x: g.x + ux * 250, z: g.z + uz * 250, y: g.y });
    px = g.x; pz = g.z;
  }
  return out;
}
/** Fly a helicopter mission: stages = [{ route: (f) => points, kt, pad?: { x, z, y } }] per objective index. */
function flyHeli(id, day, stagesFor, secs = 900) {
  const m = buildMission(id, day);
  const f = createHelicopterModel(SPECS.uh60, {});
  start(m, f);
  const r = runner(m);
  const smp = sampler(); const inp = input({ throttle: f.collective });
  let stage = -1, landing = false, card = null, manual = null;
  const trace = [];
  f.on('touchdown', (i) => { const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'helicopter', ends: ENDS, profile: (m.objectives.find((o) => o.profile) || {}).profile || null }); r.onLanding(card, td); });
  fly(f, inp, 0.2, () => true);
  const t = fly(f, inp, secs, (t, dt) => {
    if (r.cur !== stage && !landing) {
      stage = r.cur;
      const st = stagesFor(stage, m, f);
      if (st && st.route) { heliNav(f, st.route, st.kt || 80); manual = null; }
      if (st && st.steer) { if (f.autopilot.on) f.command('autopilot'); inp.throttle = f.collective; manual = st.steer; }
      if (st && st.land) landing = st.land;
    }
    if (manual) manual(f, inp);
    if (landing && landing !== true) {   // over the pad: hover hold reached → collective down
      const d = Math.hypot(f.position.x - landing.x, f.position.z - landing.z), gs = Math.hypot(f.velocity.x, f.velocity.z);
      if (d < 6 && gs < 1.2 && f.autopilot.on) { f.command('autopilot'); inp.throttle = f.collective; landing = true; }
    }
    if (landing === true) {
      const vsT = -clamp((f.agl - 1.5) * 0.25, 0.3, 1.0);
      inp.throttle = clamp(inp.throttle + (vsT - f.verticalSpeed) * 0.004, 0, 1);
    }
    smp.fill(f, dt); r.update(smp.s); smp.s.first = false;
    if (Math.round(t * 60) % 600 === 0) trace.push(`${t.toFixed(0)}s (${Math.round(f.position.x)},${Math.round(f.position.z)}) ${Math.round(f.altitude)}m ${Math.round(f.ias / KT)}kt ${f.autopilot.mode || '-'} o${r.cur}`);
    return !r.done && !r.failed;
  });
  return { m, f, r, t, trace, card, score: r.score(t), stars: r.done ? r.stars(t) : 0 };
}
/** Hand-flown helicopter circle round (cx, cz): tangent heading + radius correction on the cyclic (attitude targets),
 *  speed on the pitch attitude, height on the collective. dir = +1 clockwise (right), −1 left. */
function heliOrbit(cx, cz, rT, yT, kt, dir) {
  let I = 0;
  return (f, inp) => {
    const x = f.position.x, z = f.position.z, r = Math.hypot(x - cx, z - cz);
    const hdgT = bearing(cx, cz, x, z) + 90 * dir + dir * clamp((r - rT) * 0.3, -45, 45);
    const v = f.ias, ff = Math.atan(v * v / (9.81 * rT)) / DEG * dir;
    const rollT = clamp(ff + wrap180(hdgT - f.heading) * 1.2, -35, 35);
    const pitchT = clamp(2 + (f.ias / KT - kt) * 0.4, -10, 12);
    stick(f, inp, pitchT, rollT);
    const vsT = clamp((yT - f.altitude) * 0.3, -4, 4), e = vsT - f.verticalSpeed;
    I = clamp(I + e * 0.003, -0.5, 0.5);
    inp.throttle = clamp(f.collective + e * 0.01 + I * 0.02, 0.05, 0.95);
  };
}
/** Collective for a height target (P + slow integral on the vertical speed error). */
function collective(yT, vsMax = 4) {
  let I = 0;
  return (f, inp) => {
    const vsT = clamp((yT() - f.altitude) * 0.3, -vsMax, vsMax), e = vsT - f.verticalSpeed;
    I = clamp(I + e * 0.003, -0.5, 0.5);
    inp.throttle = clamp(f.collective + e * 0.01 + I * 0.02, 0.05, 0.95);
  };
}
/** Hand-flown helicopter path (pure pursuit 250 m ahead, heights interpolated), `kt` in forward flight. */
function heliPath(P, kt = 80, look = 250) {
  let k = 0, yT = P[0].y;
  const col = collective(() => yT, 8);
  return (f, inp) => {
    const x = f.position.x, z = f.position.z;
    let t = 0;
    for (;;) {
      const a = P[k], b = P[k + 1];
      if (!b) break;
      const lx = b.x - a.x, lz = b.z - a.z;
      t = ((x - a.x) * lx + (z - a.z) * lz) / (lx * lx + lz * lz);
      if (t < 1 || k >= P.length - 2) break;
      k++;
    }
    const a = P[k], b = P[k + 1] || P[k], tt = clamp(t, 0, 1);
    let rem = look, px = a.x + (b.x - a.x) * tt, pz = a.z + (b.z - a.z) * tt, j = k, py = a.y + (b.y - a.y) * tt;
    while (rem > 0 && j < P.length - 1) {
      const q = P[j + 1], d = Math.hypot(q.x - px, q.z - pz);
      if (d >= rem) { const u = rem / d; px += (q.x - px) * u; pz += (q.z - pz) * u; py += (q.y - py) * u; rem = 0; } else { rem -= d; px = q.x; pz = q.z; py = q.y; j++; }
    }
    yT = py;   // the height of the point ahead: climbs / descents start early
    const hdgT = bearing(x, z, px, pz);
    stick(f, inp, clamp(2 + (f.ias / KT - kt) * 0.4, -10, 12), clamp(wrap180(hdgT - f.heading) * 1.2, -30, 30));
    col(f, inp);
  };
}
/** Hand-flown approach to a hover point: ground velocity toward it (≤ ktMax, slowing with the distance) on the pitch
 *  and roll attitudes, nose toward it with the pedals, height on the collective; close and slow → the hover hold (AP). */
function heliGoto(x, z, y, ktMax = 40, yCruise = 0) {
  let d = Infinity;
  const col = collective(() => (d > 600 ? Math.max(y, yCruise) : y), 3);
  let held = false, Ix = 0, Iz = 0;
  return (f, inp) => {
    if (held) return;
    const dx = x - f.position.x, dz = z - f.position.z;
    d = Math.hypot(dx, dz);
    const brg = bearing(0, 0, dx, dz), h = f.heading * DEG;
    const vT = Math.min(ktMax * KT, Math.max(0.6, d * 0.15));
    const vx = f.velocity.x, vz = f.velocity.z;
    const vF = vx * Math.sin(h) - vz * Math.cos(h), vR = vx * Math.cos(h) + vz * Math.sin(h);
    const rel = (brg - f.heading) * DEG;
    const vFd = d < 1 ? 0 : vT * Math.cos(rel), vRd = d < 1 ? 0 : vT * Math.sin(rel);
    if (d < 40) { Ix = clamp(Ix + (vFd - vF) * 0.02, -3, 3); Iz = clamp(Iz + (vRd - vR) * 0.02, -3, 3); }
    stick(f, inp, clamp(3 - (vFd - vF) * 1.5 - Ix, -10, 12), clamp((vRd - vR) * 2 + Iz, -15, 15));
    inp.yaw = d > 60 ? clamp(wrap180(brg - f.heading) * 0.03, -0.5, 0.5) : 0;
    col(f, inp);
    if (d < 3 && Math.hypot(vx, vz) < 1 && Math.abs(f.verticalSpeed) < 1 && Math.abs(f.altitude - y) < 3) {
      held = true; inp.yaw = 0; inp.pitch = 0; inp.roll = 0;
      if (!f.autopilot.on) f.command('autopilot');
    }
  };
}
const hbrief = (res) => `${brief(res)}${res.card ? `; landing ${res.card.points} ${res.card.label} ${res.card.fpm} ft/min` : ''} ${res.r.obs.map((o) => o.parts.map((p) => p.slice(0, 3).join(' ')).join(', ')).filter(Boolean).join(' | ')}${!res.r.done ? ' || ' + res.r.msgs.join(' / ') + ' || ' + res.trace.slice(-8).join(' | ') : ''}`;

// 4g. "Kız Kulesi turu" (UH-60): a right-hand circle of 220 m at 80 m round the tower (NAV on a 13-point circle), then
//     the hover beside the tower
{
  const k = PLACES.kizKulesi;
  const res = flyHeli('ist-kiz-kulesi', null, (stage, m) => {
    if (stage === 0) return { steer: heliOrbit(k.x, k.z, 220, 80, 60, m.params.dir === 'left' ? -1 : 1) };
    if (stage === 1) { const h = m.objectives[1]; return { steer: heliGoto(h.x, h.z, 20) }; }
    return null;
  }, 300);
  check('Mission ist-kiz-kulesi (UH-60): 360° right round Kız Kulesi (120–320 m, 100–500 ft), then 5 s hover beside it → ≥ 2★',
    res.r.done && res.stars >= 2 && !res.f.crashed, hbrief(res));
}

// 4h. "Tarihi Yarımada turu" (UH-60): six rings (Galata … Ayasofya · Sultanahmet) hand-flown at 80 kt, then the
//     Yenikapı pad (hover hold over it, collective down)
{
  const res = flyHeli('ist-yarimada', null, (stage, m, f) => {
    if (stage === 0) return { steer: heliPath([{ x: m.start.x, z: m.start.z, y: m.start.alt }, ...ringRoute(m.objectives[0].gates, m.start.x, m.start.z)], 80) };
    if (stage === 1) { const p = m.objectives[1]; void f; return { steer: heliGoto(p.x, p.z, p.y + 10, 60, 150) }; }
    if (stage === 2) { const p = m.objectives[2]; return { land: { x: p.x, z: p.z } }; }
    return null;
  }, 540);
  check('Mission ist-yarimada (UH-60): six rings over the historic peninsula in order, 5 s hover over the Yenikapı pad, a soft landing on it → ≥ 2★',
    res.r.done && res.stars >= 2 && !res.f.crashed, hbrief(res));
}

// 4i. "İstanbul helikopter turu" (UH-60): hover beside Galata Kulesi, four rings, under 15 Temmuz, Rumeli Hisarı and
//     Çamlıca rings, Kısıklı pad
{
  const res = flyHeli('ist-heli-tur', null, (stage, m) => {
    const o = m.objectives;
    if (stage === 0) return { steer: heliGoto(o[0].x, o[0].z, 95, 50) };
    if (stage === 1) return { steer: heliPath([{ x: o[0].x, z: o[0].z, y: 95 }, ...ringRoute(o[1].gates, o[0].x, o[0].z)], 90) };
    if (stage === 2) {   // down the Beşiktaş shore and under the bridge at 30 m
      const b = BRIDGES.bogazici;
      return { steer: heliPath([{ x: 2350, z: -1400, y: 60 }, { x: 3598, z: -1371, y: 40 }, { x: 4300, z: -1880, y: 30 }, { x: b.x, z: b.z, y: 30 }, { x: 5656, z: -2976, y: 40 }, { x: 6025, z: -4224, y: 60 }], 90) };
    }
    if (stage === 3) return { steer: heliPath([{ x: 5656, z: -2976, y: 40 }, ...ringRoute(o[3].gates, 5656, -2976)], 90) };
    if (stage === 4) { const p = o[4]; return { steer: heliGoto(p.x, p.z, p.y + 10, 50, 330), land: { x: p.x, z: p.z } }; }
    return null;
  }, 900);
  check('Mission ist-heli-tur (UH-60): Galata hover, Haliç / Sarayburnu / Kız Kulesi / Dolmabahçe rings, under 15 Temmuz, Rumeli Hisarı / Çamlıca rings, Kısıklı pad → ≥ 2★',
    res.r.done && res.stars >= 2 && !res.f.crashed, hbrief(res));
}

// 4j. "Yenikapı'ya otorotasyon" (UH-60): both engines out at 1.500 ft over the Marmara → collective down, 60 kt glide
//     toward the field, flare, cushion → a survivable touchdown inside the marked field (autorotation landing profile)
{
  const out = []; let ok = true;
  for (const day of [null, '20261003', '20261011']) {
    const m = buildMission('ist-otorotasyon', day);
    const f = createHelicopterModel(SPECS.uh60, {});
    start(m, f);
    const r = runner(m);
    const fd = m.objectives[0];
    const inp = input({ throttle: f.collective });
    let injected = false, card = null, cush = null, minNr = 9;
    const trace = [];
    f.on('touchdown', (i) => { if (card) return; const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'helicopter', ends: ENDS, profile: 'autorotation' }); r.onLanding(card, td); });
    const t = fly(f, inp, 150, (t) => {
      if (!injected && t >= m.failures[0].at.t) injected = f.failures.inject('engineAll', {});
      const kt = f.ias / KT, agl = f.agl;
      const d = Math.hypot(fd.x - f.position.x, fd.z - f.position.z), hdgT = bearing(f.position.x, f.position.z, fd.x, fd.z);
      const bank = d > 150 ? clamp(wrap180(hdgT - f.heading) * 1.0, -20, 20) : 0;
      if (injected) {
        if (agl > 25) { inp.throttle = 0.1; stick(f, inp, clamp(2 + (kt - 60) * 0.4, -6, 12), bank); }
        else if (agl > 8 && kt > 12) { inp.throttle = 0.1; stick(f, inp, 18, 0); }
        else { cush = clamp((cush ?? 0.3) + (-0.8 - f.verticalSpeed) * 0.02, 0.1, 1); inp.throttle = cush; stick(f, inp, 5, 0); }
        if (t > 6 && agl > 25) minNr = Math.min(minNr, f.rotorRPM || 0);
      } else stick(f, inp, f.pitch, 0);
      if (Math.round(t * 60) % 120 === 0) trace.push(`${t.toFixed(0)}s d${Math.round(d)} ${Math.round(agl)}m ${Math.round(kt)}kt`);
      return !card && !f.crashed;
    });
    const res = { m, f, r, t, card, trace, score: r.score(t), stars: r.done ? r.stars(t) : 0 };
    if (!(r.done && res.stars >= 2 && !f.crashed && minNr >= 0.9)) ok = false;
    out.push(`${m.note || 'default'}: ${hbrief(res)} NR ${minNr.toFixed(2)}`);
  }
  check('Mission ist-otorotasyon (UH-60): engines out over the Marmara (3 starts / heights), autorotation into the Yenikapı field → ≥ 2★, rotor RPM in the green',
    ok, out.join(' ||| '));
}

// ---- airliners: the autopilot (ILS + autoland, LNAV) stands in for the player where the SF tests do the same
/** From a final start: autopilot ILS + autoland → the landing card (≥ 2★ expected: touchdown zone, centreline). */
function autoland(id, day, ac) {
  const m = buildMission(id, day);
  const f = createFixedWingModel(SPECS[ac], {});
  start(m, f);
  const r = runner(m);
  const inp = input({ throttle: f.throttle });
  let card = null;
  f.on('touchdown', (i) => { if (card) return; const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'airliner', ends: ENDS }); r.onLanding(card, td); });
  fly(f, inp, 1, () => true);
  f.command('autopilot');
  const t = fly(f, inp, 300, () => !card || f.groundSpeed > 20);
  return { m, f, r, t, card, trace: [], score: r.score(t), stars: r.done ? r.stars(t) : 0 };
}
const cbrief = (res) => `${res.m.params.rw || ''} ${res.card ? `${res.card.points} pts ${res.card.stars}★ ${res.card.label}: ${res.card.fpm} ft/min, cl ${res.card.cl} m, ${res.card.tdz} m, ${res.card.runway}` : `no touchdown${res.f.crashed ? ` CRASH ${res.f.crashReason}` : ''}`} → ${res.score} (${res.stars}★)`;

// 4k. "İstanbul Havalimanı'na iniş" (A320) on five of its runways (north- and southbound finals) and 4l. "Sabiha
//     Gökçen'e iniş" (737) on both: autoland → a touchdown in the zone on the asked runway, ≥ 2★
{
  const out = []; let ok = true;
  const def = MISSIONS.find((x) => x.id === 'ist-ltfm-inis');
  for (const [rw, dist] of [['35L', 8000], ['35R', 11000], ['34R', 10000], ['34L', 7000], ['36', 9000], ['17L', 6500], ['17R', 7000], ['16L', 5500], ['16R', 6000], ['18', 6500]]) {
    const save = { ...def.params }; Object.assign(def.params, { rw, dist });
    const res = autoland('ist-ltfm-inis', null, 'a320neo');
    Object.assign(def.params, save);
    if (!(res.r.done && res.stars >= 2 && res.card.runway === `LTFM ${rw}`)) ok = false;
    out.push(cbrief(res));
  }
  check('Mission ist-ltfm-inis (A320): finals to all ten LTFM ends (sloped runways: northbound downhill, southbound uphill), autoland → on the asked runway, ≥ 2★', ok, out.join(' || '));
  const out2 = []; let ok2 = true;
  const d2 = MISSIONS.find((x) => x.id === 'ist-saw-inis');
  for (const rw of ['06L', '06R']) {
    const save = { ...d2.params }; d2.params.rw = rw;
    const res = autoland('ist-saw-inis', null, 'b737');
    Object.assign(d2.params, save);
    if (!(res.r.done && res.stars >= 2 && res.card.runway === `LTFJ ${rw}`)) ok2 = false;
    out2.push(cbrief(res));
  }
  check('Mission ist-saw-inis (737): finals to LTFJ 06L / 06R over Pendik, autoland → ≥ 2★', ok2, out2.join(' || '));
}

// 4m. "Boğaz turu" (737): the mission's route on LNAV, autopilot NAV → Kız Kulesi, 15 Temmuz, FSM, YSS rings (both ways)
{
  const out = []; let ok = true;
  for (const north of [true, false]) {
    const day = north ? null : (() => { for (let i = 0; i < 60; i++) { const d = new Date(Date.UTC(2026, 9, 1) + i * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''); if (!buildMission('ist-bogaz-turu', d).params.north) return d; } return null; })();
    const m = buildMission('ist-bogaz-turu', day);
    const f = createFixedWingModel(SPECS.b737, {});
    const route = createRoute();
    route.env = { groundAt: (x, z) => world.getGroundHeight(x, z), bounds: REGION.local };
    f.setRoute(route);
    route.setPosition(m.start.x, m.start.z, m.start.hdg * DEG);
    for (const p of m.route) route.add(p.x, p.z, { alt: p.alt });
    start(m, f);
    const r = runner(m);
    const smp = sampler(); const inp = input({ throttle: f.throttle });
    fly(f, inp, 0.5, () => true);
    f.command('autopilot');
    const nav = f.autopilot.lnav;
    const t = fly(f, inp, m.limit, (t, dt) => { smp.fill(f, dt); r.update(smp.s); smp.s.first = false; return !r.done; });
    const res = { m, f, r, t, trace: [], score: r.score(t), stars: r.done ? r.stars(t) : 0 };
    if (!(nav && r.done && res.stars >= 2)) ok = false;
    out.push(`${north ? 'north' : 'south'} ${m.params.altFt} ft: NAV ${nav}, ${brief(res)} acc ${r.obs[0].gates.map((g) => g.acc.toFixed(2)).join('/')}`);
  }
  check('Mission ist-bogaz-turu (737): route loaded, AP NAV flies the four Boğaz rings in order, both directions → ≥ 2★', ok, out.join(' || '));
}

// 4n. "İstanbul'dan Sabiha Gökçen'e" (A320): take-off from LTFM 35R by hand, autopilot NAV on the mission route over
//     the FSM and Çamlıca rings, slowed on the last legs, flaps / gear before the 9 km final point → APP, autoland on 06L
{
  const m = buildMission('ist-aktarma');
  const f = createFixedWingModel(SPECS.a320neo, {});
  const route = createRoute();
  route.env = { groundAt: (x, z) => world.getGroundHeight(x, z), bounds: REGION.local };
  f.setRoute(route);
  const e = ENDS.find((x) => x.name === m.start.runway);
  route.setPosition(e.x, e.z, e.course);
  const wps = m.route.map((p) => route.add(p.x, p.z, { alt: p.alt }));
  start(m, f);
  const r = runner(m);
  const smp = sampler(); const inp = input({ throttle: 1 });
  let card = null, apOn = false, cfgT = 0, slowed = false;
  const trace = [];
  f.on('touchdown', (i) => { if (card || !apOn) return; const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'airliner', ends: ENDS }); r.onLanding(card, td); });
  const t = fly(f, inp, m.limit, (t, dt) => {
    const kt = f.ias / KT;
    if (!apOn) {
      stick(f, inp, f.onGround ? (kt > 145 ? 10 : 0) : clamp(f.pitch + (kt - 170) * 0.1, 3, 15), 0);
      inp.throttle = 1;
      if (!f.onGround && f.gearHandleDown && f.agl > 15) f.command('gear');
      if (!f.onGround && f.agl > 300) { inp.pitch = 0; inp.roll = 0; inp.throttle = f.throttle; f.command('autopilot'); apOn = true; }
    } else {
      if (f.agl > 450 && f.flapsIndex > 0 && kt > 190 && (cfgT -= dt) <= 0) { f.command('flapsUp'); cfgT = 3; }
      const last = wps.at(-2), dLast = Math.hypot(last.x - f.position.x, last.z - f.position.z);   // the final join point
      if (!slowed && dLast < 22000) { slowed = true; route.setSpeed(wps.at(-3).id, { ias: 200 * KT }); route.setSpeed(last.id, { ias: 170 * KT }); route.setSpeed(wps.at(-1).id, { ias: 160 * KT }); }
      if (dLast < 12000 && (cfgT -= dt) <= 0) {
        const det = SPECS.a320neo.flapDetents, k = f.flapsIndex;
        if (k < (SPECS.a320neo.landingFlapIndex ?? det.length - 1) && kt < (det[k + 1].vfe || 999 * KT) / KT - 5) { f.command('flapsDown'); cfgT = 4; }
        if (!f.gearHandleDown && dLast < 6000) f.command('gear');
      }
    }
    smp.fill(f, dt); r.update(smp.s); smp.s.first = false;
    if (Math.round(t * 60) % 1800 === 0) trace.push(`${t.toFixed(0)}s (${Math.round(f.position.x)},${Math.round(f.position.z)}) ${Math.round(f.altitude / FT)}ft ${Math.round(kt)}kt ${f.autopilot.mode || '-'} wp${route.active} o${r.cur}`);
    return !(card && f.groundSpeed < 20) && !r.failed;
  });
  const res = { m, f, r, t, card, trace, score: r.score(t), stars: r.done ? r.stars(t) : 0 };
  check('Mission ist-aktarma (A320): LTFM 35R take-off, NAV over the FSM and Çamlıca rings, configured on the final → APP autoland at Sabiha Gökçen → ≥ 2★',
    r.done && res.stars >= 2 && !f.crashed, `${brief(res)}; ${cbrief(res)} | ${trace.join(' | ')}`);
}

// 4o. "Atatürk'te pas geçme" (737): autopilot ILS to LTBA 05 (and 23); at the decision frame the pilot disconnects,
//     TOGA, 12° nose up, gear up → 2.000 ft; the circuit abbreviated (repositioned 8 km out, gear down) → autoland
{
  const out = []; let ok = true;
  const def = MISSIONS.find((x) => x.id === 'ist-ataturk-pas');
  for (const rw of ['05', '23']) {
    const save = { ...def.params }; def.params.rw = rw;
    const m = buildMission('ist-ataturk-pas');
    Object.assign(def.params, save);
    const f = createFixedWingModel(SPECS.b737, {});
    start(m, f);
    const r = runner(m);
    const smp = sampler(); const inp = input({ throttle: f.throttle });
    let card = null, phase = 0;
    const trace = [];
    const e = ENDS.find((x) => x.name === `LTBA ${rw}`);
    f.on('touchdown', (i) => { if (card || phase < 2) return; const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'airliner', ends: ENDS }); r.onLanding(card, td); });
    fly(f, inp, 1, () => true);
    f.command('autopilot');
    const t = fly(f, inp, m.limit, (t, dt) => {
      if (phase === 0 && r.cur === 1) { phase = 1; if (f.autopilot.on) f.command('autopilot'); inp.throttle = f.throttle; }
      if (phase === 1) {
        stick(f, inp, 12, 0); inp.throttle = Math.min(1, inp.throttle + 0.05);   // (the lever has to move: pickup after the disconnect)
        if (f.verticalSpeed > 2 && f.gearHandleDown) f.command('gear');
        if (r.cur === 2) {   // the circuit, abbreviated: 8 km final, gear down, autopilot ILS
          phase = 2;
          f.reset({ x: e.x - e.dx * 8000, z: e.z - e.dz * 8000, heading: e.course, altitude: e.elevation + 8300 * Math.tan(3 * DEG) }, world);
          inp.pitch = 0; inp.roll = 0; inp.throttle = f.throttle; f.step(0, inp, world); f.command('autopilot');
          smp.s.first = true;
        }
      }
      smp.fill(f, dt); r.update(smp.s); smp.s.first = false;
      if (Math.round(t * 60) % 180 === 0) trace.push(`${t.toFixed(0)}s ${Math.round(f.altitude)}m ${Math.round(f.ias / KT)}kt vs${f.verticalSpeed.toFixed(1)} p${f.pitch.toFixed(0)} ap${f.autopilot.on ? f.autopilot.mode : '-'} thr${f.throttle.toFixed(2)} ph${phase} o${r.cur}`);
      return !(card && f.groundSpeed < 20) && !r.failed;
    });
    const res = { m, f, r, t, card, trace, score: r.score(t), stars: r.done ? r.stars(t) : 0 };
    if (!(r.done && res.stars >= 2 && !f.crashed)) ok = false;
    out.push(`${rw}: ${brief(res)}${!r.done ? ' | ' + trace.slice(0, 40).join(' | ') : ''}; ${r.obs.map((o) => o.parts.slice(0, 1).map((p) => p.join(' ')).join('')).join(' | ')}; ${cbrief(res)}`);
  }
  check('Mission ist-ataturk-pas (737): ILS to LTBA 05 / 23, decision frame, go-around to 2.000 ft without touching, then the landing → ≥ 2★', ok, out.join(' || '));
}

// 4p. "Sabiha Gökçen'de kalkışta motor arızası" (737): take-off 24R, engine 1 fails at 400 ft AGL → one-engine climb
//     to 2.000 ft; then (standing in for the turn back over Pendik) 8 km out on the 06L final with the engine still out,
//     the autopilot's single-engine ILS + the pilot's rudder → a Sabiha Gökçen landing
{
  const m = buildMission('ist-saw-motor');
  const f = createFixedWingModel(SPECS.b737, {});
  start(m, f);
  const r = runner(m);
  let injected = false, card = null, climbT = 0, relanded = false;
  const smp = sampler(); const inp = input({ throttle: 1 });
  const e = ENDS.find((x) => x.name === 'LTFJ 06L');
  const dep = ENDS.find((x) => x.name === 'LTFJ 24R');
  const trace = [];
  f.on('touchdown', (i) => { if (card || !relanded) return; const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'airliner', ends: ENDS }); r.onLanding(card, td); });
  const t = fly(f, inp, m.limit, (t, dt) => {
    const kt = f.ias / KT;
    smp.fill(f, dt);
    if (!injected && !f.onGround && f.agl >= m.failures[0].at.agl) injected = f.failures.inject('engine', { index: 0 });
    if (r.cur === 0) {
      const pT = f.onGround ? (kt > 145 ? 8 : 0) : clamp(f.pitch + (kt - 165) * 0.12, 2, 12);
      stick(f, inp, pT, clamp(wrap180(dep.course / DEG - f.heading) * 1.5, -15, 15));
      inp.throttle = 1;
      if (!f.onGround && f.gearHandleDown && f.agl > 30) f.command('gear');
      if (injected) climbT += dt;
    }
    r.update(smp.s); smp.s.first = false;
    if (r.cur === 1 && !relanded) {
      relanded = true;
      f.reset({ x: e.x - e.dx * 8000, z: e.z - e.dz * 8000, heading: e.course, altitude: e.elevation + 8300 * Math.tan(3 * DEG) }, world);
      f.failures.inject('engine', { index: 0 });
      inp.pitch = 0; inp.roll = 0; inp.throttle = f.throttle; f.step(0, inp, world); f.command('autopilot');
      smp.s.first = true;
    }
    if (relanded) inp.yaw = clamp(-((f.position.x - e.x) * -e.dz + (f.position.z - e.z) * e.dx) * 0.01, -0.6, 0.6);
    if (Math.round(t * 60) % 600 === 0) trace.push(`${t.toFixed(0)}s ${Math.round(f.altitude / FT)}ft ${Math.round(kt)}kt ${f.autopilot.mode || ''}`);
    return !(card && f.groundSpeed < 30) && !f.crashed && !r.failed;
  });
  const res = { m, f, r, t, card, trace, score: r.score(t), stars: r.done ? r.stars(t) : 0 };
  check('Mission ist-saw-motor (737): engine failure at 400 ft after the 24R take-off, one-engine climb to 2.000 ft, single-engine ILS to 06L → landing ≥ 2★',
    injected && climbT > 0 && r.done && res.stars >= 2 && !f.crashed, `climb ${climbT.toFixed(0)} s; ${brief(res)}; ${cbrief(res)}${!r.done ? ' | ' + trace.join(' | ') : ''}`);
}

// 4q. "Marmara'ya mecburi iniş" (A320): dual engine failure 4 km past the Atatürk 23 departure end at 2.500 ft, wings
//     level glide at ~150 kt, flare → ditching
{
  const out = []; let ok = true;
  for (const day of [null, '20261005', '20261017']) {
    const m = buildMission('ist-marmara', day);
    const f = createFixedWingModel(SPECS.a320neo, {});
    start(m, f);
    const inp = input({ throttle: f.throttle });
    const r = runner(m);
    let injected = false, ditch = null;
    f.on('ditch', (i) => { ditch = i; r.obs[0].onDitch({ fpm: Math.max(0, -i.verticalSpeed * FPM), pitch: i.pitch, roll: i.roll, kt: i.ias / KT, gear: 0, survived: true }); if (r.obs[0].status === 'done') r.cur = 1; });
    const t = fly(f, inp, m.limit, (t) => {
      if (!injected && t >= 3) injected = f.failures.inject('engineAll', { restartable: false });
      const agl = f.agl, kt = f.ias / KT;
      const vsT = agl > 60 ? null : -Math.max(1.0, agl * 0.05);
      const pT = vsT === null ? clamp(f.pitch + (kt - 150) * 0.12, -6, 8) : clamp(f.pitch + (vsT - f.verticalSpeed) * 0.6, 2, 11.5);
      stick(f, inp, pT, 0);
      inp.throttle = 0;
      return !f.ditched && !f.crashed;
    });
    const res = { m, f, r, t, trace: [], score: r.score(t), stars: r.done ? r.stars(t) : 0 };
    const wet = world.isWater(f.position.x, f.position.z);
    if (!(injected && f.ditched && !f.crashed && r.done && res.stars >= 2 && wet)) ok = false;
    out.push(`${m.note || 'default'}: ${ditch ? `${Math.round(-ditch.verticalSpeed * FPM)} ft/min, pitch ${ditch.pitch.toFixed(1)}°, ${Math.round(ditch.ias / KT)} kt at (${Math.round(f.position.x)},${Math.round(f.position.z)}) ${wet ? 'sea' : 'LAND'}` : 'no ditch'} → ${res.score} ${res.stars}★ ${r.obs[0].ditch ? r.obs[0].ditch.label : r.obs[0].failReason}`);
  }
  check('Mission ist-marmara (A320): engineAll off Yeşilköy (3 variations), glide + flare → a survivable ditching in the Marmara ≥ 2★', ok, out.join(' || '));
}

// 4r. "Alev sönmesi" (F-16): engine out at 7.000 ft 12 km out on the Sabiha Gökçen 06L / Atatürk 05 centreline: glide,
//     6° path with the speed brake, G + ACİL (alternate gear), flare → touchdown on the runway
{
  const out = []; let ok = true;
  const def = MISSIONS.find((x) => x.id === 'ist-alev');
  for (const from of [0, 1, 2, 3]) {
    const save = def.params.from; def.params.from = from;
    const m = buildMission('ist-alev');
    def.params.from = save;
    const f = createFixedWingModel(SPECS.f16, {});
    start(m, f);
    const r = runner(m);
    const e = ENDS.find((x) => x.name === m.objectives[0].target);
    const inp = input({ throttle: f.throttle });
    let injected = false, card = null, gear = false, sb = false;
    f.on('touchdown', (i) => { if (card) return; card = scoreLanding(sampleTouchdown(f, i, {}), { category: 'fighter', ends: ENDS }); r.onLanding(card); });
    const t = fly(f, inp, m.limit, (t) => {
      if (!injected && t >= 4) injected = f.failures.inject('engine', { index: 0, restartable: false });
      inp.throttle = 0;
      const kt = f.ias / KT, agl = f.agl;
      const along = -((f.position.x - e.x) * e.dx + (f.position.z - e.z) * e.dz), lat = (f.position.x - e.x) * -e.dz + (f.position.z - e.z) * e.dx;
      const pathAlt = e.elevation + Math.max(0, along + 600) * Math.tan(6 * DEG);
      if (!gear && along < 4500) { gear = true; f.command('gear'); }
      if (gear && f.gear < 0.5 && f.gearHandleDown) f.command('emergency');
      const wantSb = f.altitude > pathAlt + 40 && kt > 185;
      if (wantSb !== sb) { sb = wantSb; f.command('speedbrake'); }
      const vsT = clamp(-kt * KT * Math.tan(6 * DEG) + (pathAlt - f.altitude) * 0.12, -40, 3);
      let pT = clamp(f.pitch + (vsT - f.verticalSpeed) * 0.3, -16, 12);
      if (kt < 175 && agl > 35) pT = Math.min(pT, f.pitch - 0.5);
      if (agl < 35) pT = clamp(3 + (35 - agl) * (8 / 35), 3, 11);
      stick(f, inp, pT, clamp(-lat * 0.08 + wrap180(e.course / DEG - f.heading) * 1.5, -30, 30));
      return !card && !f.crashed;
    });
    const res = { m, f, r, t, card, trace: [], score: r.score(t), stars: r.done ? r.stars(t) : 0 };
    if (!(injected && card && card.onRunway && r.done && res.stars >= 2)) ok = false;
    out.push(`${m.objectives[0].target}: ${card ? `${card.points} pts ${card.stars}★ ${card.label}, ${card.fpm} ft/min, ${card.runway}, ${card.tdz} m` : `no touchdown${f.crashed ? ` CRASH ${f.crashReason}` : ''}`} → ${res.score} (${res.stars}★)`);
  }
  check('Mission ist-alev (F-16): engine out at 7.000 ft, straight-in glide with gear + speed brake to Sabiha Gökçen 06L / 06R, Atatürk 05 and İstanbul Havalimanı 35L → ≥ 2★', ok, out.join(' || '));
}

// 4s. "İstanbul Havalimanı'ndan dik tırmanış" (F-22): full afterburner from LTFM 35R, 30° climb → 10.000 ft, ≥ 2★
{
  const m = buildMission('ist-tirmanis');
  const f = createFixedWingModel(SPECS.f22, {});
  start(m, f);
  const r = runner(m);
  const smp = sampler(); const inp = input({ throttle: 1 });
  const t = fly(f, inp, 120, (t, dt) => {
    const kt = f.ias / KT;
    stick(f, inp, f.onGround ? (kt > 125 ? 10 : 0) : Math.min(35, 10 + smp.s.t * 3), 0);
    if (!f.onGround && f.gearHandleDown && f.agl > 20) f.command('gear');
    smp.fill(f, dt); r.update(smp.s); smp.s.first = false;
    return !r.done;
  });
  const res = { m, f, r, t, trace: [], score: r.score(t), stars: r.done ? r.stars(t) : 0 };
  check('Mission ist-tirmanis (F-22): LTFM 35R, full afterburner, 10.000 ft → ≥ 2★ for a clean max-performance climb', r.done && res.stars >= 2 && !f.crashed, brief(res));
}

// =====================================================================================================================
// 5. free-flight challenges (src/missions/ist/challenges.js data, run by the engine's tracker as the game does:
//    loadChallengeSet('ist') → createChallengeTracker({ challenges, catalog }))
const SET = await loadChallengeSet('ist');
function ffTracker(aircraft, category, hooks = {}) {
  const ev = [];
  const tr = createChallengeTracker({
    aircraft, category, ends: ENDS, challenges: SET.challenges, catalog: SET.catalog, spanAt: (x, z, o) => world.getObstacleSpan(x, z, o),
    isOnRunway: world.isOnRunway, isWater: world.isWater, hooks, emit: (type, e, data) => ev.push({ type, id: e.id, data }),
  });
  const s = sampler().s;
  const put = (o, dt = 0.1) => { s.px = s.x; s.py = s.y; s.pz = s.z; Object.assign(s, o); s.dt = dt; s.t += dt; tr.update(s); s.first = false; };
  return { tr, ev, s, put, last: (type, id) => [...ev].reverse().find((x) => x.type === type && (!id || x.id === id)) };
}
{
  const ids = (ac) => challengesFor(ac).map((c) => c.id).join(',');
  const boards = new Set(CHALLENGES.map((c) => c.board));
  const KINDS = ['bridge', 'gates', 'climb', 'alcatraz', 'landing', 'emergency'];   // the tracker's kinds
  const bad = CHALLENGES.filter((c) => !(c.board === `ff-${c.id}` && /^ff-ist-[a-z0-9-]+$/.test(c.board) && c.board.length <= 40 && buildMission(c.mission) && KINDS.includes(c.kind)
    && c.title && c.hint && typeof c.trackable === 'boolean' && maxChallengeScore(c) > 0 && (c.stars === 'landing' || c.stars === 'ditch' || (c.stars.length === 3 && c.stars[2] <= maxChallengeScore(c)))
    && (c.kind !== 'gates' || (c.score.par > 0 && c.score.perSec > 0 && c.near > 0)) && (c.kind !== 'bridge' || BRIDGES[c.bridge])
    && (c.kind !== 'alcatraz' || (buildMission(c.mission).objectives.some((o) => o.type === 'hover') && buildMission(c.mission).objectives.some((o) => o.type === 'pad')))
    && !/\b(Kiz|Halic|Bogaz|Camlica|Gokcen|Ataturk)\b/.test(c.title + c.hint))).map((c) => c.id);
  const trs = ['f16', 'f22', 'a320neo', 'b737', 'uh60'].map((a) => ffTracker(a, a === 'uh60' ? 'helicopter' : a[0] === 'f' ? 'fighter' : 'airliner').tr.entries.length);
  check('Free flight (İstanbul): boards ff-ist-<name> (unique, no clash with San Francisco), only the tracker\'s kinds, sibling missions, texts, 3-star score reachable; the engine\'s tracker builds every aircraft\'s entries',
    bad.length === 0 && boards.size === CHALLENGES.length && !CHALLENGES.some((c) => SF_CHALLENGES.some((x) => x.board === c.board)) && CHALLENGES.length >= 12
    && SET && SET.map === 'ist' && SET.challenges === CHALLENGES && trs.every((n, i) => n === challengesFor(['f16', 'f22', 'a320neo', 'b737', 'uh60'][i]).length)
    && ids('uh60').includes('ist-yenikapi-ped') && ids('uh60').includes('ist-kiz-kulesi') && ids('f16').includes('ist-kiz-kulesi-jet') && !ids('f16').includes('ist-yenikapi-ped')
    && ids('f16').includes('ist-alev') && !ids('f22').includes('ist-alev') && ids('b737').includes('ist-denize-inis') && ids('uh60').includes('ist-otorotasyon') && !ids('uh60').includes('ist-tirmanis'),
    `${bad.join(' ')} | ${['f16', 'f22', 'a320neo', 'b737', 'uh60'].map((a) => `${a}: ${ids(a)}`).join(' | ')}`);
}
// 5a. every Boğaz bridge: over the deck → message, under it → done (base + centre + height)
{
  const out = []; let ok = true;
  for (const [id, bid] of [['ist-bogazici', 'bogazici'], ['ist-fsm', 'fsm'], ['ist-yss', 'yss']]) {
    const { ev, put, last } = ffTracker('f16', 'fighter');
    const b = BRIDGES[bid], ax = dirOf(b.axis), n = { dx: -ax.dz, dz: ax.dx };
    const at = (d, a) => ({ x: b.x + ax.dx * a + n.dx * d, z: b.z + ax.dz * a + n.dz * d });
    put({ ...at(-40, 0), y: 110, first: true }); put({ ...at(40, 0), y: 110 });
    const over = ev.some((x) => x.type === 'message' && x.id === id && /üstünden/.test(x.data)) && !last('done');
    put({ ...at(-40, 50), y: 35, first: true }); put({ ...at(40, 50), y: 35 });
    const d = last('done', id);
    if (!(over && d && d.data.ok && d.data.board === `ff-${id}` && d.data.score >= 1700 && d.data.stars === 3)) ok = false;
    out.push(`${id}: over ${over}, ${d ? `${d.data.score} ${d.data.stars}★` : 'no pass'}`);
  }
  check('Free flight bridges: 15 Temmuz, FSM, YSS — over the deck → message; under it mid-span → done ≥ 1700, 3★', ok, out.join(' | '));
}
// 5b. Kız Kulesi orbit (a gates run over its checkpoint rings): UH-60 right (220 m, 80 m), fixed wing left (1.5 km,
//     320 m); the run starts at the first checkpoint, the full circle completes it
{
  const K = PLACES.kizKulesi;
  const circle = (put, r, y, dir, deg, a0) => { for (let a = a0; Math.abs(a - a0) <= deg; a += 2 * dir) put({ x: K.x + Math.sin(a * DEG) * r, y, z: K.z - Math.cos(a * DEG) * r, onGround: false }, r > 500 ? 0.35 : 0.25); };   // (≈ 280 kt / 60 kt)
  const H = ffTracker('uh60', 'helicopter');
  H.put({ x: 1400, y: 120, z: 500, onGround: false, first: true });
  circle(H.put, 220, 80, 1, 372, 270);
  const dh = H.last('done', 'ist-kiz-kulesi'), sh = H.last('start', 'ist-kiz-kulesi');
  const F = ffTracker('f16', 'fighter');
  F.put({ x: 2400, y: 330, z: 6800, onGround: false, first: true });
  circle(F.put, 1450, 320, -1, 372, 180);
  const df = F.last('done', 'ist-kiz-kulesi-jet');
  const W = ffTracker('uh60', 'helicopter');
  W.put({ x: 1400, y: 120, z: 500, onGround: false, first: true });
  circle(W.put, 220, 80, -1, 372, 270);        // the wrong way round: never completes
  check('Free flight Kız Kulesi: UH-60 right circle (220 m, 80 m) → run from the first checkpoint, done; F-16 left circle (1.5 km, 320 m) → done; the wrong way → no result',
    sh && dh && dh.data.ok && dh.data.stars >= 2 && df && df.data.ok && df.data.stars >= 2 && !W.last('done'),
    `${dh ? `${dh.data.score} ${dh.data.stars}★ in ${dh.data.time.toFixed(0)} s` : 'heli no done'} | ${df ? `${df.data.score} ${df.data.stars}★ in ${df.data.time.toFixed(0)} s` : 'jet no done'}`);
}
// 5c. gates runs: Boğaz low pass (clock from gate 1; 4 s above 500 ft costs the "Alçak kalma" points), Haliç frames
{
  const { tr, ev, put, last } = ffTracker('f22', 'fighter');
  const lp = tr.byId['ist-bogaz-alcak'], G = lp.gates;
  const thru = (g, y, dt) => { put({ x: g.x - g.nx * 60, y, z: g.z - g.nz * 60 }, dt); put({ x: g.x + g.nx * 60, y, z: g.z + g.nz * 60 }, 0.5); };
  put({ x: 7178, y: 40, z: -7300, first: true });
  thru(G[0], 40, 0.1);
  const started = last('start', 'ist-bogaz-alcak') && lp.status === 'run';
  for (let i = 1; i < G.length; i++) thru(G[i], 40, 8);
  const d = last('done', 'ist-bogaz-alcak');
  thru(G[0], 40, 0.1);
  for (let i = 0; i < 40; i++) put({ x: G[1].x - G[1].nx * 500, y: 250, z: G[1].z - G[1].nz * 500 }, 0.1);
  for (let i = 1; i < G.length; i++) thru(G[i], 40, 8);
  const d2 = last('done', 'ist-bogaz-alcak');
  const low1 = d && d.data.rows.find((r) => r[0] === 'Alçak kalma'), low2 = d2 && d2.data.rows.find((r) => r[0] === 'Alçak kalma');
  const H = tr.byId['ist-halic'], HG = H.gates;
  put({ x: 2600, y: 100, z: -200, first: true });
  for (let i = 0; i < HG.length; i++) thru(HG[i], 100, i ? 5 : 0.1);
  const dh = last('done', 'ist-halic');
  check('Free flight gates: Boğaz low pass auto-starts at gate 1, 6 frames → done with "Alçak kalma" 300 + time bonus; with 4 s at 250 m → 0 for staying low; Haliç 6 frames → done',
    started && d && d.data.ok && low1 && low1[2] === 300 && d2 && d2 !== d && low2 && low2[2] === 0 && d2.data.score < d.data.score && dh && dh.data.ok,
    `${d ? `${d.data.score} ${d.data.stars}★ in ${d.data.time.toFixed(1)} s` : 'no done'}; high run ${d2 ? `${d2.data.score} (${low2 && low2[1]})` : '—'}; Haliç ${dh ? `${dh.data.score} ${dh.data.stars}★` : 'no done'}; ${ev.length} events`);
}
// 5d. Yenikapı pad (UH-60): hover 5 s, then a soft touchdown on the pad → done; emergencies gated and completed
{
  const { tr, put, last } = ffTracker('uh60', 'helicopter', { inject: () => true });
  const p = PADS.yenikapi;
  put({ x: p.x + 300, y: 60, z: p.z, onGround: false, gs: 20, first: true });
  for (let i = 0; i < 70; i++) put({ x: p.x + 2, y: p.y + 8, z: p.z + 1, onGround: false, gs: 0.3 });
  const started = tr.byId['ist-yenikapi-ped'].status === 'run';
  const td = { x: p.x + 1, z: p.z, heading: 0, track: 0, vs: -0.4, roll: 0.5, pitch: 2, gs: 0.3 };
  tr.onLanding(scoreLanding(td, { category: 'helicopter', ends: ENDS }), td);
  const d = last('done', 'ist-yenikapi-ped');
  const low = tr.canStart('ist-otorotasyon', { onGround: false, agl: 100, x: 0, z: 0 }).reason;
  const st = tr.start('ist-otorotasyon', { onGround: false, agl: 400, x: -2400, z: 4300, t: 10 }, null);
  const td2 = { x: -2400, z: 2650, heading: 0, track: 0, vs: -1.5, roll: 1, pitch: 4, gs: 8 };
  tr.onLanding(scoreLanding(td2, { category: 'helicopter', ends: ENDS, profile: 'autorotation' }), td2);
  const da = last('done', 'ist-otorotasyon');
  const B = ffTracker('b737', 'airliner', { inject: () => true });
  const land = B.tr.canStart('ist-denize-inis', { onGround: false, agl: 600, x: PLACES.galataKulesi.x, z: PLACES.galataKulesi.z }).reason;
  const sea = B.tr.canStart('ist-denize-inis', { onGround: false, agl: 600, x: 0, z: 8000 }).ok;
  check('Free flight pad + emergencies: Yenikapı hover 5 s → run, soft touchdown → done; autorotation gated below 500 ft, done on a heli touchdown; ditching only over the sea',
    started && d && d.data.ok && d.data.score > 2000 && /500 ft/.test(low) && st.ok && da && da.data.ok && /Denizin/.test(land) && sea,
    `${d ? `${d.data.score} ${d.data.stars}★` : 'no pad done'}; low "${low}"; ${da ? `${da.data.score} ${da.data.stars}★` : 'no autorot done'}; land "${land}"`);
}
// 5e. flown through the tracker: the F-16 under 15 Temmuz from the Boğaz mouth (free flight: no mission objectives)
{
  const m = buildMission('ist-15temmuz');
  const f = createFixedWingModel(SPECS.f16, {});
  start(m, f);
  const A = ffTracker('f16', 'fighter');
  const smp = sampler(); const inp = input({ throttle: f.throttle });
  const steer = pathPilot([{ x: m.start.x, z: m.start.z, y: 35 }, ...bogazPath(2, 6, 35)], { kt: 300 });
  fly(f, inp, 60, (t, dt) => { steer(f, inp); smp.fill(f, dt); A.tr.update(smp.s); smp.s.first = false; return !A.last('done', 'ist-bogazici'); });
  const d = A.last('done', 'ist-bogazici');
  check('Free flight flown (F-16): under 15 Temmuz Şehitler Köprüsü along the Boğaz → ff-ist-bogazici done ≥ 2★', d && d.data.ok && d.data.stars >= 2 && !f.crashed,
    d ? `${d.data.score} pts ${d.data.stars}★ ${JSON.stringify(d.data.rows)}` : `no pass; crashed ${f.crashed}`);
}

// =====================================================================================================================
let failed = 0;
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
}
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
