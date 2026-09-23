// Airbus A320neo (CFM LEAP-1A) — "Gökyüzü Hava Yolları" TC-GKA. Geometry/textures: blender/aircraft/a320neo/build.py.
// Rig: control surfaces, Fowler flaps + slats, spoilers (speedbrake / ground spoilers / roll), gear sequence with
// doors + folding side stays, strut compression, wheel spin + nose-wheel steering, fan spin + blur disc,
// translating-sleeve reversers, lights (nav, double-flash strobes, beacons, landing spot), cockpit view.
import * as THREE from 'three';

// URLs resolved against this module so they work from index.html and from dev/*.html alike.
const repo = (p) => new URL(`../../../${p}`, import.meta.url).href;
export const model = {
  url: repo('assets/aircraft/a320neo/a320neo.glb'),
  lodUrl: repo('assets/aircraft/a320neo/a320neo_lod.glb'),
  displays: {
    screen_pfd_capt: 'a320.pfd', screen_nd_capt: 'a320.nd', screen_ewd: 'a320.ewd', screen_sd: 'a320.sd',
    screen_nd_fo: 'a320.nd', screen_pfd_fo: 'a320.pfd', screen_isis: 'a320.isis',
  },
  thumbnail: repo('renders/aircraft/a320neo/thumb.jpg'),
};

const D = THREE.MathUtils.DEG2RAD;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

// ---- motion tables (A320: ailerons ±25°, elevator +30/-17°, rudder ±30°, spoilers 50°, flaps 40°, slats 27°)
const AIL_UP = 25 * D, AIL_DN = 25 * D, ELEV_UP = 30 * D, ELEV_DN = 17 * D, RUD = 30 * D;
const SPOILER_MAX = 50 * D, SPEEDBRAKE_MAX = 40 * D, ROLL_SPOILER = 35 * D;
const FLAP_MAX = 40 * D, SLAT_MAX = 27 * D;
const FLAP_TRAVEL = { 1: [0.74, 0.17], 2: [0.47, 0.11] };      // Fowler travel aft / down (m) at full flaps (~0.16 c)
const MLG_RETRACT = 86 * D, NLG_RETRACT = 98 * D, MAIN_DOOR_OPEN = 84 * D, NOSE_DOOR_OPEN = 82 * D;
const MLG_STROKE = 0.45, NLG_STROKE = 0.35, C_STATIC = 0.35;   // fixedwing.js: 0.35 = static load
const REV_TRAVEL = 0.48;

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.18)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function fanBlurTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), m = s / 2;
  g.clearRect(0, 0, s, s);
  // hub-to-tip smeared blades: darker ring with faint radial streaks
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    const k = 0.35 + 0.25 * Math.sin(i * 0.7) * Math.sin(i * 0.13);
    g.strokeStyle = `rgba(40,42,46,${0.10 + 0.08 * k})`; g.lineWidth = 3;
    g.beginPath(); g.moveTo(m + Math.cos(a) * m * 0.40, m + Math.sin(a) * m * 0.40);
    g.lineTo(m + Math.cos(a + 0.35) * m * 0.99, m + Math.sin(a + 0.35) * m * 0.99); g.stroke();
  }
  const r = g.createRadialGradient(m, m, m * 0.38, m, m, m);
  r.addColorStop(0, 'rgba(30,32,36,0.0)'); r.addColorStop(0.05, 'rgba(30,32,36,0.55)');
  r.addColorStop(0.9, 'rgba(45,47,52,0.45)'); r.addColorStop(1, 'rgba(45,47,52,0)');
  g.fillStyle = r; g.beginPath(); g.arc(m, m, m, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function createRig(gltfScene) {
  const object = new THREE.Group();
  object.name = 'a320neo_rig';
  object.add(gltfScene);
  gltfScene.updateMatrixWorld(true);
  const byName = new Map();
  gltfScene.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  const N = (n) => byName.get(n) || null;
  const localPos = (n) => { const o = N(n); const v = new THREE.Vector3(); if (o) o.getWorldPosition(v); return object.worldToLocal(v); };

  // ---------------------------------------------------------------- hinged parts (rest quaternion * axis rotation)
  const hinges = [];
  function hinge(name, axis) {
    const o = N(name); if (!o) return null;
    const h = { o, q0: o.quaternion.clone(), p0: o.position.clone(), axis, q: new THREE.Quaternion(), angle: 0 };
    hinges.push(h); return h;
  }
  function setHinge(h, angle, dx = 0, dy = 0, dz = 0) {
    if (!h) return;
    h.q.setFromAxisAngle(h.axis, angle);
    h.o.quaternion.copy(h.q0).multiply(h.q);
    if (dx || dy || dz || h.moved) { h.o.position.set(h.p0.x + dx, h.p0.y + dy, h.p0.z + dz); h.moved = !!(dx || dy || dz); }
  }
  const ail = { L: hinge('ctl_aileron_L', X), R: hinge('ctl_aileron_R', X) };
  const elev = { L: hinge('ctl_elevator_L', X), R: hinge('ctl_elevator_R', X) };
  const rudder = hinge('ctl_rudder', Y);
  const flaps = [];
  for (const s of ['L', 'R']) for (const i of [1, 2]) { const h = hinge(`ctl_flap_${s}_${i}`, X); if (h) { h.idx = i; flaps.push(h); } }
  const slats = [];
  for (const s of ['L', 'R']) for (let i = 1; i <= 5; i++) { const h = hinge(`ctl_slat_${s}_${i}`, X); if (h) slats.push(h); }
  const spoilers = [];
  for (const s of ['L', 'R']) for (let i = 1; i <= 5; i++) { const h = hinge(`ctl_spoiler_${s}_${i}`, X); if (h) { h.side = s; h.idx = i; spoilers.push(h); } }

  // ---------------------------------------------------------------- flight-deck controls (local frames = aircraft axes)
  const ck = {
    thr: [hinge('ck_thr_1', X), hinge('ck_thr_2', X)], flap: hinge('ck_flap_lever', X), sb: hinge('ck_sb_lever', X),
    gearLever: hinge('ck_gear_lever', X), stickC: hinge('ck_stick_capt', X), stickF: hinge('ck_stick_fo', X),
    pedals: ['capt', 'fo'].flatMap((s) => [hinge(`ck_pedal_${s}_L`, X), hinge(`ck_pedal_${s}_R`, X)]),
  };
  const ckQ = new THREE.Quaternion(), ckQ2 = new THREE.Quaternion();
  let gearLeverDown = true, lastGear = 1;
  function setStick(h, pitch, roll) {
    if (!h) return;
    ckQ.setFromAxisAngle(X, pitch); ckQ2.setFromAxisAngle(Z, roll);
    h.o.quaternion.copy(h.q0).multiply(ckQ).multiply(ckQ2);
  }

  // ---------------------------------------------------------------- gear
  const gear = {
    mainL: hinge('gear_main_L', Z), mainR: hinge('gear_main_R', Z), nose: hinge('gear_nose', X),
    doorL: hinge('gear_door_main_L', Z), doorR: hinge('gear_door_main_R', Z),
    nfL: hinge('gear_door_nose_fwd_L', Z), nfR: hinge('gear_door_nose_fwd_R', Z),
    naL: hinge('gear_door_nose_aft_L', Z), naR: hinge('gear_door_nose_aft_R', Z),
    pistL: hinge('gear_main_L_piston', Y), pistR: hinge('gear_main_R_piston', Y), pistN: hinge('gear_nose_piston', Y),
  };
  // nose strut axis (raked) in the leg frame
  const noseAxis = new THREE.Vector3();
  if (gear.pistN) noseAxis.copy(gear.pistN.p0).normalize();
  // two-link chains (side stays, nose drag brace) solved in a plane: A fixed on the structure, B = end marker on the leg
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  const rootPos = (o, out) => { o.getWorldPosition(out); return gltfScene.worldToLocal(out); };
  function chain(upName, loName, endName, plane, leg) {
    const up = N(upName), lo = N(loName), end = N(endName); if (!up || !lo || !end) return null;
    const A = rootPos(up, new THREE.Vector3()), K0 = rootPos(lo, new THREE.Vector3()), B0 = rootPos(end, new THREE.Vector3());
    return { up, lo, end, leg, plane, A, K0, B0, L1: A.distanceTo(K0), L2: K0.distanceTo(B0), q0u: up.quaternion.clone(), q0l: lo.quaternion.clone() };
  }
  const stays = ['L', 'R'].map((s) => chain(`gear_main_${s}_stay_up`, `gear_main_${s}_stay_lo`, `gear_main_${s}_stay_end`, 'xy', s === 'L' ? gear.mainL : gear.mainR)).filter(Boolean);
  const brace = chain('gear_nose_brace_up', 'gear_nose_brace_lo', 'gear_nose_brace_end', 'yz', gear.nose);
  function solveChain(c) {
    c.leg.o.updateMatrixWorld(true);
    const B = rootPos(c.end, tmpV);
    const [i, j] = c.plane === 'xy' ? ['x', 'y'] : ['y', 'z'];
    const Bi = B[i], Bj = B[j];
    const dx = Bi - c.A[i], dy = Bj - c.A[j];
    const dist = Math.hypot(dx, dy) || 1e-6;
    const d = Math.min(Math.max(dist, Math.abs(c.L1 - c.L2) + 1e-4), c.L1 + c.L2 - 1e-6);
    const a = (c.L1 * c.L1 - c.L2 * c.L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(c.L1 * c.L1 - a * a, 0));
    const ux = dx / dist, uy = dy / dist;
    // bend direction: keep the knee on the same side it would fold to (upwards / forwards)
    const side = c.plane === 'xy' ? (c.A.x > 0 ? 1 : -1) : -1;     // knee folds up (into the bay)
    const Ki = c.A[i] + ux * a - uy * h * side, Kj = c.A[j] + uy * a + ux * h * side;
    const ang0u = Math.atan2(c.K0[j] - c.A[j], c.K0[i] - c.A[i]), angU = Math.atan2(Kj - c.A[j], Ki - c.A[i]);
    const ang0l = Math.atan2(c.B0[j] - c.K0[j], c.B0[i] - c.K0[i]), angL = Math.atan2(Bj - Kj, Bi - Ki);
    const axis = c.plane === 'xy' ? Z : X;
    const du = angU - ang0u;
    c.up.quaternion.copy(c.q0u).multiply(tmpQ.setFromAxisAngle(axis, du));
    c.lo.quaternion.copy(c.q0l).multiply(tmpQ.setFromAxisAngle(axis, angL - ang0l - du));
  }

  // wheels
  const wheels = [];
  for (const n of ['wheel_nose_L', 'wheel_nose_R', 'wheel_main_L_in', 'wheel_main_L_out', 'wheel_main_R_in', 'wheel_main_R_out']) {
    const o = N(n); if (!o) continue;
    wheels.push({ o, q0: o.quaternion.clone(), r: n.startsWith('wheel_nose') ? 0.375 : 0.56, a: 0 });
  }

  // ---------------------------------------------------------------- engines
  const blurTex = fanBlurTexture();
  const engines = [1, 2].map((i) => {
    const fan = N(`fan_${i}`), rev = N(`reverser_${i}`);
    let disc = null;
    if (fan) {
      disc = new THREE.Mesh(new THREE.CircleGeometry(0.985, 48),
        new THREE.MeshBasicMaterial({ map: blurTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      disc.position.set(0, 0, -0.05); disc.renderOrder = 2; disc.visible = false; disc.name = `fan_blur_${i}`;
      fan.add(disc);
    }
    return { fan, q0: fan ? fan.quaternion.clone() : null, rev, p0: rev ? rev.position.clone() : null, disc, a: 0, n1: 0 };
  });

  // ---------------------------------------------------------------- lights
  const glow = glowTexture();
  const sprites = [];
  function sprite(name, color, size, kind) {
    const o = N(name); if (!o) return null;
    const m = new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 1 });
    const sp = new THREE.Sprite(m); sp.scale.setScalar(size); sp.renderOrder = 3; sp.name = `${name}_glow`;
    sp.userData = { size, kind }; o.add(sp); sprites.push(sp);
    // keep a minimum apparent size so lights stay visible from far away (strobes/beacons more so)
    const minAng = kind === 'strobe' ? 0.006 : kind === 'beacon' ? 0.004 : kind === 'landing' ? 0.005 : 0.0025;
    sp.onBeforeRender = (renderer, scene, camera) => {
      sp.getWorldPosition(tmpV2);
      const d = camera.position.distanceTo(tmpV2);
      const s = Math.max(size, d * minAng);
      if (Math.abs(sp.scale.x - s) > 1e-3) { sp.scale.setScalar(s); sp.updateMatrixWorld(); }
    };
    return sp;
  }
  const L = {
    navL: sprite('light_nav_L', 0xff2a1a, 0.9, 'nav'), navR: sprite('light_nav_R', 0x22ff66, 0.9, 'nav'),
    navAL: sprite('light_navaft_L', 0xffffff, 0.6, 'nav'), navAR: sprite('light_navaft_R', 0xffffff, 0.6, 'nav'),
    tail: sprite('light_tail', 0xffffff, 0.7, 'nav'),
    strL: sprite('light_strobe_L', 0xf4f7ff, 4.0, 'strobe'), strR: sprite('light_strobe_R', 0xf4f7ff, 4.0, 'strobe'),
    strT: sprite('light_strobe_tail', 0xf4f7ff, 3.2, 'strobe'),
    bcT: sprite('light_beacon_top', 0xff2010, 2.2, 'beacon'), bcB: sprite('light_beacon_bottom', 0xff2010, 2.2, 'beacon'),
    landL: sprite('light_landing_L', 0xfff4e0, 2.6, 'landing'), landR: sprite('light_landing_R', 0xfff4e0, 2.6, 'landing'),
    taxi: sprite('light_taxi', 0xfff4e0, 1.6, 'taxi'), toL: sprite('light_turnoff_L', 0xfff4e0, 1.1, 'taxi'),
    toR: sprite('light_turnoff_R', 0xfff4e0, 1.1, 'taxi'),
    logoL: sprite('light_logo_L', 0xfff0d8, 0.5, 'nav'), logoR: sprite('light_logo_R', 0xfff0d8, 0.5, 'nav'),
    wingL: sprite('light_wing_L', 0xfff4e0, 0.6, 'nav'), wingR: sprite('light_wing_R', 0xfff4e0, 0.6, 'nav'),
  };
  const spot = new THREE.SpotLight(0xfff2dd, 0, 900, 16 * D, 0.45, 1.6);
  spot.name = 'landing_spot';
  const pl = localPos('light_landing_L'), pr = localPos('light_landing_R');
  spot.position.copy(pl).add(pr).multiplyScalar(0.5);
  spot.target.position.copy(spot.position).add(new THREE.Vector3(0, -0.07, -1).normalize().multiplyScalar(60));
  object.add(spot, spot.target);

  // ---------------------------------------------------------------- interior / cockpit view
  const interior = N('interior');
  const glass = N('cockpit_glass');
  const glassMats = [];
  if (glass) glass.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); glassMats.push(o.material); } });
  for (const m of glassMats) { m.transparent = true; m.depthWrite = false; }
  const plug = N('ck_plug');
  let view = 'exterior', camNear = false;
  if (glass) {
    glass.traverse((o) => {
      if (!o.isMesh) return;
      o.onBeforeRender = (renderer, scene, camera) => {
        o.getWorldPosition(tmpV2);
        camNear = camera.position.distanceToSquared(tmpV2) < 40 * 40;
      };
    });
  }
  function applyView() {
    const inCk = view === 'cockpit';
    const showInt = inCk || camNear;
    if (interior) interior.visible = showInt;
    if (plug) plug.visible = !showInt;
    for (const m of glassMats) {
      m.opacity = inCk ? 0.10 : 0.82; m.side = inCk ? THREE.DoubleSide : THREE.FrontSide;
      m.roughness = inCk ? 0.02 : 0.05; m.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- screens (UV orientation follows the texture flipY)
  const screens = {};
  gltfScene.traverse((o) => { if (o.isMesh && o.name.startsWith('screen_')) { screens[o.name] = o; o.userData.uvFlipped = false; } });
  function syncScreenUV() {
    for (const k in screens) {
      const m = screens[k], map = m.material && m.material.map;
      if (!map) continue;
      const want = !!map.flipY;
      if (want !== m.userData.uvFlipped) {
        const uv = m.geometry.attributes.uv;
        if (uv) { for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); uv.needsUpdate = true; }
        m.userData.uvFlipped = want;
      }
    }
  }

  // ---------------------------------------------------------------- eye, contacts, bounds
  const eye = { pilot: localPos('eye_pilot'), copilot: localPos('eye_copilot') };
  const contacts = [
    { name: 'contact_nose', position: localPos('contact_nose'), kind: 'nose' },
    { name: 'contact_main_L', position: localPos('contact_main_L'), kind: 'main' },
    { name: 'contact_main_R', position: localPos('contact_main_R'), kind: 'main' },
  ];
  const bounds = { length: 37.57, span: 35.8, height: 11.76, radius: 21 };

  // ---------------------------------------------------------------- state
  const st = { ail: 0, elev: 0, rud: 0, flaps: 0, slats: 0, spoil: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], gear: 1, rev: [0, 0], first: true, steer: 0 };
  let tStrobe = 0, tBeacon = 0;

  function update(dt, v) {
    if (!v) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    if (st.first) {
      st.first = false;
      // interior and tiny parts do not cast shadows (main.js enables shadows on every mesh after createRig)
      // interior: no shadow casting; damp the image-based ambient (env maps ignore the fuselage occlusion)
      if (interior) interior.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m && 'envMapIntensity' in m && !o.name.startsWith('screen_')) m.envMapIntensity = 0.35;
      });
      if (glass) glass.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      for (const sp of sprites) sp.castShadow = false;
      applyView();
    }
    // --- primary controls (small actuator lag)
    st.ail = approach(st.ail, v.aileron || 0, 18, dt);
    st.elev = approach(st.elev, v.elevator || 0, 18, dt);
    st.rud = approach(st.rud, v.rudder || 0, 14, dt);
    const a = st.ail;
    setHinge(ail.R, a > 0 ? -a * AIL_UP : -a * AIL_DN);
    setHinge(ail.L, a > 0 ? a * AIL_DN : a * AIL_UP);
    const e = st.elev, eAng = e > 0 ? -e * ELEV_UP : -e * ELEV_DN;
    setHinge(elev.L, eAng); setHinge(elev.R, eAng);
    setHinge(rudder, st.rud * RUD);
    // --- high lift: Fowler flaps (translate aft/down, rotate), slats (droop + extend)
    st.flaps = approach(st.flaps, clamp01(v.flaps || 0), 3, dt);
    st.slats = approach(st.slats, clamp01(v.slats ?? v.flaps ?? 0), 3, dt);
    const f = st.flaps;
    for (const h of flaps) {
      const [aft, down] = FLAP_TRAVEL[h.idx];
      const tr = Math.pow(f, 0.65), rot = Math.pow(f, 1.35);
      setHinge(h, rot * FLAP_MAX, 0, -down * tr, aft * tr);
    }
    const sl = st.slats;
    for (const h of slats) setHinge(h, -sl * SLAT_MAX, 0, -0.10 * sl, -0.26 * sl);
    // --- spoilers: ground spoilers / speedbrake (all panels) + roll spoilers 2-5 on the down-going wing
    const ground = clamp01(v.spoilers || 0), sb = clamp01(v.speedbrake || 0);
    for (let k = 0; k < spoilers.length; k++) {
      const h = spoilers[k];
      // A320: speedbrake uses spoilers 2-4 (VisualState.speedbrake is a fraction of full spoiler travel)
      let ang = Math.max(ground * SPOILER_MAX, h.idx >= 2 && h.idx <= 4 ? sb * SPOILER_MAX : 0);
      const roll = h.side === 'R' ? a : -a;
      if (h.idx > 1 && roll > 0.1) ang = Math.max(ang, (roll - 0.1) / 0.9 * ROLL_SPOILER);
      st.spoil[k] = approach(st.spoil[k], ang, 8, dt);
      setHinge(h, -st.spoil[k]);
    }
    // --- gear sequence: doors open (0..0.2), legs travel (0.18..0.85), doors close (0.86..1)
    st.gear = approach(st.gear, clamp01(v.gear ?? 1), 20, dt);
    const g = st.gear;
    const legT = smooth(0.18, 0.85, g);
    const doorOpen = smooth(0.0, 0.18, g) * (1 - smooth(0.86, 1.0, g));
    const mlgA = (1 - legT) * MLG_RETRACT, nlgA = (1 - legT) * NLG_RETRACT;
    setHinge(gear.mainL, mlgA); setHinge(gear.mainR, -mlgA); setHinge(gear.nose, nlgA);
    setHinge(gear.doorL, doorOpen * MAIN_DOOR_OPEN); setHinge(gear.doorR, -doorOpen * MAIN_DOOR_OPEN);
    setHinge(gear.nfL, -doorOpen * NOSE_DOOR_OPEN); setHinge(gear.nfR, doorOpen * NOSE_DOOR_OPEN);
    const aftOpen = smooth(0.0, 0.18, g);
    setHinge(gear.naL, -aftOpen * NOSE_DOOR_OPEN); setHinge(gear.naR, aftOpen * NOSE_DOOR_OPEN);
    for (const c of stays) solveChain(c);
    if (brace) solveChain(brace);
    // --- struts (compression per contact: nose, main L, main R) + nose-wheel steering
    const comp = v.gearCompression || [];
    const down = legT > 0.999;
    const cn = down ? (comp[0] ?? C_STATIC) : 0, cl = down ? (comp[1] ?? C_STATIC) : 0, cr = down ? (comp[2] ?? C_STATIC) : 0;
    // VisualState.steer: nose-wheel angle in rad (+ = right), fixedwing.js; fall back to pedal steering
    const steerT = down ? -(Number.isFinite(v.steer) ? v.steer : (v.onGround ? (v.rudder || 0) * 7 * D : 0)) : 0;
    st.steer = approach(st.steer, steerT, 6, dt);
    if (gear.pistN) {
      const off = (C_STATIC - cn) * NLG_STROKE;
      setHinge(gear.pistN, st.steer, noseAxis.x * off, noseAxis.y * off, noseAxis.z * off);
    }
    setHinge(gear.pistL, 0, 0, -(C_STATIC - cl) * MLG_STROKE, 0);
    setHinge(gear.pistR, 0, 0, -(C_STATIC - cr) * MLG_STROKE, 0);
    // --- wheels
    const ws = down ? (v.wheelSpeed || 0) : 0;
    for (const w of wheels) {
      w.a -= (ws / w.r) * dt; w.a %= Math.PI * 2;
      w.o.quaternion.copy(w.q0).multiply(tmpQ.setFromAxisAngle(X, w.a));
    }
    // --- engines: fan spin (visual speed capped, blur disc fades in), reversers
    const eng = v.engines || [];
    for (let i = 0; i < 2; i++) {
      const E = engines[i]; if (!E.fan) continue;
      const n1 = clamp01(eng[i] ? eng[i].n1 : 0);
      E.n1 = approach(E.n1, n1, 4, dt);
      const w = Math.min(E.n1 * 408, 9.0 + E.n1 * 6);          // rad/s (real max ~408 rad/s)
      E.a = (E.a - w * dt) % (Math.PI * 2);
      E.fan.quaternion.copy(E.q0).multiply(tmpQ.setFromAxisAngle(Z, E.a));
      if (E.disc) {
        const o = smooth(0.06, 0.4, E.n1) * 0.9;
        E.disc.visible = o > 0.01; E.disc.material.opacity = o;
      }
      if (E.rev) {
        st.rev[i] = approach(st.rev[i], clamp01(eng[i] ? eng[i].reverser : 0), 2.5, dt);
        E.rev.position.set(E.p0.x, E.p0.y, E.p0.z + st.rev[i] * REV_TRAVEL);
      }
    }
    // --- flight-deck controls: thrust levers (IDLE aft .. TOGA forward, reverse behind idle), flap / speedbrake
    //     levers, gear lever (follows the commanded direction), sidesticks, rudder pedals
    for (let i = 0; i < 2; i++) {
      const e = eng[i] || {};
      const thr = clamp01(e.throttle ?? 0), rev = clamp01(e.reverser ?? 0);
      setHinge(ck.thr[i], rev > 0.05 ? 20 * D * rev + 14 * D : (14 - 48 * thr) * D);
    }
    setHinge(ck.flap, (-18 + 38 * st.flaps) * D);
    setHinge(ck.sb, (-12 + 34 * Math.max(sb, ground)) * D);
    const gv = clamp01(v.gear ?? 1);
    if (gv > lastGear + 1e-4) gearLeverDown = true; else if (gv < lastGear - 1e-4) gearLeverDown = false;
    else if (gv > 0.999) gearLeverDown = true; else if (gv < 0.001) gearLeverDown = false;
    lastGear = gv;
    setHinge(ck.gearLever, gearLeverDown ? 64 * D : 0);
    setStick(ck.stickC, st.elev * 16 * D, -st.ail * 16 * D);
    setStick(ck.stickF, st.elev * 16 * D, -st.ail * 16 * D);
    ck.pedals.forEach((h, k) => setHinge(h, (k % 2 ? 1 : -1) * st.rud * 12 * D));
    // --- lights
    const lt = v.lights || {};
    tStrobe = (tStrobe + dt) % 1.0; tBeacon = (tBeacon + dt) % 1.0;
    const strobeOn = lt.strobe && (tStrobe < 0.05 || (tStrobe > 0.13 && tStrobe < 0.18));
    const bc = lt.beacon ? Math.max(0, 1 - Math.abs(tBeacon - 0.1) / 0.12) : 0;
    const bc2 = lt.beacon ? Math.max(0, 1 - Math.abs(tBeacon - 0.6) / 0.12) : 0;
    for (const sp of sprites) {
      const k = sp.userData.kind;
      let on = 0;
      if (k === 'nav') on = lt.nav ? 1 : 0;
      else if (k === 'strobe') on = strobeOn ? 1 : 0;
      else if (k === 'landing') on = lt.landing && legT > 0.5 ? 1 : 0;
      else if (k === 'taxi') on = lt.taxi && legT > 0.98 ? 1 : 0;
      if (k === 'beacon') on = sp === L.bcT ? bc : bc2;
      sp.visible = on > 0.01;
      sp.material.opacity = on;
    }
    spot.intensity = lt.landing && legT > 0.5 ? 380 : 0;
    spot.visible = spot.intensity > 0;
    syncScreenUV();
    if (view === 'exterior') { const vis = interior ? interior.visible : false; if (vis !== camNear) applyView(); }
  }

  function setView(v) {
    if (v === view) return;
    view = v; applyView();
  }

  return { object, eye, contacts, screens, bounds, update, setView };
}
