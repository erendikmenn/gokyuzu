// Ring course mission: take off, fly through glowing rings in order around the island, then land on the
// runway and stop. Ring heights come from terrain samples at runtime, so the course adapts to the world.
import * as THREE from 'three';
import { RUNWAY, WORLD } from '../config.js';

// Nominal ring waypoints (x, z) in meters, flown in order. Take-off is toward -Z (north).
// Clockwise loop over the eastern half of the island: out over the northern plain, along the lake's
// south shore, over the eastern hills and coast, around the town, along the south coast, then a final
// approach ring on the extended runway centerline south of the runway (placed by planCourse).
// Each regular ring may slide up to ~300 m toward a spot that needs less height (valleys, low ground).
export const WAYPOINTS = [
  [0, -1900],       // 1  straight out after take-off, northern plain
  [1500, -1850],    // 2  foothills west of the lake
  [2550, -2150],    // 3  over the lake
  [3650, -1150],    // 4  eastern hills
  [3700, 650],      // 5  east coast
  [3200, 2150],     // 6  north of the town
  [2550, 3450],     // 7  over the town / harbour
  [1000, 4150],     // 8  south coast
  [-550, 4250],     // 9  turn to final
  // 10: final approach ring on the runway centerline (see planCourse)
];

const RING_RADIUS = 22;
const CLEAR_MAX = 120;      // m above the highest ground within SAMPLE_R
const MIN_AGL = 150;        // m above the ground right under the ring
const SAMPLE_R = 400;
const MAX_CLIMB = 0.07;     // flyable climb gradient between rings (m per m)
const MAX_DESCENT = 0.13;
const LEG_CLEAR = 70;       // m of terrain clearance along the straight line between rings
const BEST_KEY = 'gokyuzu.bestTime';
const TITLE = 'Halka Parkuru';
const _tmp = new THREE.Vector3();

function loadBest() {
  try {
    const v = parseFloat(window.localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}
function saveBest(t) {
  try { window.localStorage.setItem(BEST_KEY, String(t)); } catch { /* storage unavailable */ }
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function fmtTime(t) {
  const tenths = Math.floor(t * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const sec = (tenths % 600) / 10;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}

// ---------- course planning ----------
export function planCourse(world, waypoints = WAYPOINTS) {
  const gh = (x, z) => {
    try { const h = world.getGroundHeight(x, z); return Number.isFinite(h) ? h : WORLD.seaLevel; } catch { return WORLD.seaLevel; }
  };
  const maxAround = (x, z, r = SAMPLE_R) => {
    let m = gh(x, z);
    for (const [rr, n] of [[r * 0.5, 8], [r, 14]]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        m = Math.max(m, gh(x + Math.cos(a) * rr, z + Math.sin(a) * rr));
      }
    }
    return m;
  };
  const needAt = (x, z) => Math.max(maxAround(x, z) + CLEAR_MAX, gh(x, z) + MIN_AGL);

  const elev = RUNWAY.elevation;
  const thresholdZ = RUNWAY.z + RUNWAY.length / 2;   // south threshold (approach end for landing toward -Z)

  // regular rings: search a small neighbourhood for the lowest safe spot
  const pts = waypoints.map(([x, z]) => {
    let best = null;
    for (const dx of [-300, -150, 0, 150, 300]) {
      for (const dz of [-300, -150, 0, 150, 300]) {
        const cx = x + dx, cz = z + dz;
        const need = needAt(cx, cz);
        const cost = need + 0.12 * Math.hypot(dx, dz);
        if (!best || cost < best.cost) best = { x: cx, z: cz, y: need, cost };
      }
    }
    return new THREE.Vector3(best.x, best.y, best.z);
  });

  // final approach ring on the extended centerline: choose the distance with the shallowest clear glide path
  let fin = null;
  for (const d of [1300, 1550, 1800, 2050, 2300]) {
    const z = thresholdZ + d, x = RUNWAY.x;
    const y = Math.max(maxAround(x, z, 300) + CLEAR_MAX, elev + 120);
    let blocked = 0;
    for (let t = 0.1; t < 1; t += 0.1) {
      const lz = thresholdZ + d * t, ly = elev + 15 + (y - elev - 15) * t;
      if (gh(x, lz) + 25 > ly) blocked++;
    }
    const cost = (y - elev) / d + blocked * 0.05 + Math.abs(d - 1800) * 0.00001;
    if (!fin || cost < fin.cost) fin = { x, y, z, cost };
  }
  pts.push(new THREE.Vector3(fin.x, fin.y, fin.z));

  // make the height profile flyable. Rings are only ever raised, never lowered below their safe height:
  //  - each leg must clear the terrain under it by LEG_CLEAR (raise both ends),
  //  - climbs between rings stay under MAX_CLIMB (raise earlier rings),
  //  - descents stay under MAX_DESCENT (raise later rings, except the final approach ring).
  const start = new THREE.Vector3(RUNWAY.x, elev, RUNWAY.z);  // lift-off roughly mid-runway
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      let need = 0;
      for (let t = 0.1; t < 0.95; t += 0.1) {
        const g = gh(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
        need = Math.max(need, g + LEG_CLEAR - (a.y + (b.y - a.y) * t));
      }
      if (need > 0) { a.y += need; if (i < pts.length - 1) b.y += need; }
    }
    for (let i = pts.length - 1; i > 0; i--) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      pts[i - 1].y = Math.max(pts[i - 1].y, pts[i].y - MAX_CLIMB * d);
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      pts[i].y = Math.max(pts[i].y, pts[i - 1].y - MAX_DESCENT * d);
    }
  }

  // ring orientation: horizontal normal mostly facing the incoming leg (easy to fly through), turned a
  // little toward the outgoing leg so the course reads as a path
  const rings = pts.map((p, i) => {
    const prev = i === 0 ? start : pts[i - 1];
    const next = i === pts.length - 1 ? null : pts[i + 1];
    const nIn = new THREE.Vector3(p.x - prev.x, 0, p.z - prev.z).normalize();
    let n;
    if (!next) n = new THREE.Vector3(0, 0, -1);                        // final approach: heading north (-Z)
    else n = nIn.multiplyScalar(3).add(new THREE.Vector3(next.x - p.x, 0, next.z - p.z).normalize()).normalize();
    if (!Number.isFinite(n.x) || n.lengthSq() < 0.5) n.set(0, 0, -1);
    return { position: p, normal: n, radius: RING_RADIUS, passed: false };
  });
  return rings;
}

// ---------- visuals ----------
function makeHaloTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // ring radius sits at 0.72 of the half-size
  grad.addColorStop(0.0, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  grad.addColorStop(0.64, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.72, 'rgba(255,255,255,1)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.3)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeBeamTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.25)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0.75)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const COL_NEXT = new THREE.Color(0.36, 1.0, 0.8);    // matches the HUD accent (#5cf2c8)
const COL_LATER = new THREE.Color(0.85, 0.92, 1.0);

export function createMissions(scene, world) {
  const rings = planCourse(world);
  const total = rings.length;

  // ---------- meshes ----------
  const group = new THREE.Group();
  group.name = 'missionRings';
  scene.add(group);
  const torusGeo = new THREE.TorusGeometry(RING_RADIUS, 1.05, 10, 72);
  const haloSize = (RING_RADIUS / 0.72) * 2;
  const haloGeo = new THREE.PlaneGeometry(haloSize, haloSize);
  const haloTex = makeHaloTexture();
  const visuals = rings.map((r) => {
    const root = new THREE.Group();
    root.position.copy(r.position);
    root.lookAt(_tmp.copy(r.position).add(r.normal));   // local +Z along the course
    const torusMat = new THREE.MeshBasicMaterial({ color: COL_LATER.clone(), transparent: true, opacity: 0.5, toneMapped: false, depthWrite: false });
    const torus = new THREE.Mesh(torusGeo, torusMat);
    const haloMat = new THREE.MeshBasicMaterial({
      map: haloTex, color: COL_LATER.clone(), transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.renderOrder = 2;
    torus.renderOrder = 1;
    root.add(torus, halo);
    group.add(root);
    return { root, torus, halo, torusMat, haloMat, fade: 0 };
  });

  // vertical light beam under the next ring (helps spotting it from far away)
  const beamMat = new THREE.MeshBasicMaterial({
    map: makeBeamTexture(), color: COL_NEXT, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1, 8, 1, true), beamMat);
  beam.renderOrder = 1;
  group.add(beam);

  // ---------- state ----------
  const listeners = [];
  const emit = (e) => { for (const cb of listeners) { try { cb(e); } catch (err) { console.error(err); } } };
  const state = {
    title: TITLE, objective: '', score: 0, ringsDone: 0, ringsTotal: total, time: 0, bestTime: loadBest(),
    nextTarget: new THREE.Vector3(), rings, landing: false, complete: false,
  };
  const landingTarget = new THREE.Vector3();
  let running = false;
  let prevPos = null;
  let flightHooked = null;
  let lastTouchdownVS = null;
  let airborneMinVS = 0;
  let wasOnGround = true;
  let offRunwayNotified = false;
  let clock = 0;

  function reset() {
    state.ringsDone = 0;
    state.time = 0;
    state.score = 0;
    state.landing = false;
    state.complete = false;
    state.objective = 'Kalkış yap ve 1. halkaya uç';
    state.bestTime = loadBest() ?? state.bestTime;
    for (const r of rings) r.passed = false;
    for (const v of visuals) { v.fade = 0; v.root.visible = true; v.root.scale.setScalar(1); }
    running = false;
    prevPos = null;
    lastTouchdownVS = null;
    airborneMinVS = 0;
    wasOnGround = true;
    offRunwayNotified = false;
    updateTarget(null);
  }

  function updateTarget(f) {
    if (state.complete) { state.nextTarget = null; return; }
    if (state.landing) {
      // aim at the threshold until past it, then at the runway middle
      const tz = RUNWAY.z + RUNWAY.length / 2;
      const past = f && f.position.z < tz - 30 && Math.abs(f.position.x - RUNWAY.x) < 300;
      landingTarget.set(RUNWAY.x, RUNWAY.elevation, past ? RUNWAY.z : tz);
      state.nextTarget = landingTarget;
      return;
    }
    const r = rings[state.ringsDone];
    state.nextTarget = r ? r.position : null;
  }

  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _hit = new THREE.Vector3();
  function crossesRing(r, p0, p1) {
    const d0 = _a.subVectors(p0, r.position).dot(r.normal);
    const d1 = _b.subVectors(p1, r.position).dot(r.normal);
    if (d0 === d1 || (d0 > 0 && d1 > 0) || (d0 < 0 && d1 < 0)) return false;
    const t = d0 / (d0 - d1);
    _hit.lerpVectors(p0, p1, t);
    return _hit.distanceTo(r.position) <= r.radius + 1.5;
  }

  function landingBonus() {
    if (lastTouchdownVS == null) return 100;
    const vs = Math.abs(lastTouchdownVS);
    return vs < 1 ? 500 : vs < 2 ? 350 : vs < 3 ? 200 : 100;
  }

  function complete() {
    state.complete = true;
    state.landing = false;
    running = false;
    const t = state.time;
    const record = state.bestTime == null || t < state.bestTime;
    if (record) { state.bestTime = t; saveBest(t); }
    const timeBonus = Math.max(0, Math.round((600 - t) * 2));
    state.score = total * 100 + landingBonus() + timeBonus;
    state.objective = 'Tebrikler! Yeniden uçmak için R';
    updateTarget(null);
    emit({ type: 'complete', text: `Tamamlandı! Süre ${fmtTime(t)}${record ? ' — Rekor!' : ''}` });
  }

  function hookFlight(f) {
    if (flightHooked === f || typeof f.on !== 'function') return;
    flightHooked = f;
    try { f.on('touchdown', (info) => { if (info && Number.isFinite(info.verticalSpeed)) lastTouchdownVS = info.verticalSpeed; }); } catch { /* ignore */ }
  }

  function update(dt, f) {
    clock += dt;
    if (f && f.position) {
      hookFlight(f);
      const pos = f.position;

      // touchdown fallback: remember the strongest sink rate shortly before contact
      if (!f.onGround) airborneMinVS = Math.min(airborneMinVS * Math.exp(-dt * 2), f.verticalSpeed || 0);
      if (f.onGround && !wasOnGround && lastTouchdownVS == null) lastTouchdownVS = airborneMinVS;
      wasOnGround = !!f.onGround;

      if (!state.complete && !f.crashed) {
        if (!running && !f.onGround && (f.airspeed || 0) > 12) running = true;

        if (!state.landing && prevPos && prevPos.distanceToSquared(pos) < 500 * 500) {
          const r = rings[state.ringsDone];
          if (r && crossesRing(r, prevPos, pos)) {
            r.passed = true;
            state.ringsDone++;
            running = true;
            state.score = state.ringsDone * 100;
            if (state.ringsDone >= total) {
              state.landing = true;
              state.objective = 'Piste in ve dur';
              lastTouchdownVS = null;
              emit({ type: 'ring', text: `Halka ${state.ringsDone}/${total} — şimdi piste in` });
            } else {
              state.objective = state.ringsDone === total - 1 ? 'Son halka: pist yaklaşma hattı' : `${state.ringsDone + 1}. halkaya uç`;
              emit({ type: 'ring', text: `Halka ${state.ringsDone}/${total}` });
            }
          }
        }

        if (state.landing && f.onGround) {
          const onRwy = typeof world.isOnRunway === 'function' ? world.isOnRunway(pos.x, pos.z) : false;
          if (onRwy && (f.airspeed || 0) < 3) complete();
          else if (!onRwy && (f.airspeed || 0) < 3 && !offRunwayNotified) {
            offRunwayNotified = true;
            emit({ type: 'info', text: 'Pist dışında durdun — piste in' });
          }
        }
        if (!f.onGround) offRunwayNotified = false;
        if (running) state.time += dt;
      }
      if (!state.landing && state.ringsDone === 0 && running && state.objective.startsWith('Kalkış')) state.objective = '1. halkaya uç';
      prevPos = prevPos || new THREE.Vector3();
      prevPos.copy(pos);
      updateTarget(f);
    }
    animate(dt, f);
    return state;
  }

  function animate(dt, f) {
    const pulse = 0.5 + 0.5 * Math.sin(clock * 3.2);
    const k = 1 - Math.exp(-dt * 4);
    for (let i = 0; i < visuals.length; i++) {
      const v = visuals[i], r = rings[i];
      const isNext = !state.landing && !state.complete && i === state.ringsDone;
      if (r.passed) {
        v.fade = Math.min(1, v.fade + dt * 1.4);
        const a = 1 - v.fade;
        v.root.scale.setScalar(1 + v.fade * 0.35);
        v.torusMat.opacity = 0.9 * a * a;
        v.haloMat.opacity = 0.8 * a * a;
        v.torusMat.color.lerp(COL_NEXT, k);
        v.haloMat.color.lerp(COL_NEXT, k);
        v.root.visible = a > 0.01;
        continue;
      }
      v.root.visible = true;
      if (isNext) {
        v.torusMat.color.lerp(COL_NEXT, k);
        v.haloMat.color.lerp(COL_NEXT, k);
        v.torusMat.opacity += (1 - v.torusMat.opacity) * k;
        v.haloMat.opacity = 0.55 + 0.45 * pulse;
        v.root.scale.setScalar(1 + 0.025 * pulse);
      } else {
        const ahead = i - state.ringsDone;             // 1 = the ring after next
        const target = ahead === 1 ? 0.55 : 0.32;
        v.torusMat.color.lerp(COL_LATER, k);
        v.haloMat.color.lerp(COL_LATER, k);
        v.torusMat.opacity += (target - v.torusMat.opacity) * k;
        v.haloMat.opacity += (target * 0.45 - v.haloMat.opacity) * k;
        v.root.scale.setScalar(1);
      }
    }
    // beam under the next ring
    const next = !state.landing && !state.complete ? rings[state.ringsDone] : null;
    if (next) {
      const p = next.position;
      let g = WORLD.seaLevel;
      try { g = world.getGroundHeight(p.x, p.z); } catch { /* ignore */ }
      const h = Math.max(1, p.y - RING_RADIUS - g);
      beam.visible = true;
      beam.position.set(p.x, g + h / 2, p.z);
      beam.scale.set(1, h, 1);
      // fade out as the aircraft gets close (the beam is for spotting the ring from afar)
      const d = f && f.position ? Math.hypot(f.position.x - p.x, f.position.z - p.z) : 1e4;
      const near = clamp01((d - 250) / 600);
      beamMat.opacity = (0.16 + 0.08 * pulse) * near;
      beam.visible = near > 0.01;
    } else {
      beam.visible = false;
    }
  }

  reset();
  return {
    update,
    reset,
    onEvent(cb) { if (typeof cb === 'function') listeners.push(cb); },
    get state() { return state; },
    rings,
    group,
  };
}
