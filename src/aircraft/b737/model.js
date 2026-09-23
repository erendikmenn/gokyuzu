// Boeing 737-800 (CFM56-7B, blended winglets) — runtime rig for the Blender-built GLB.
// Node names follow CONTRACTS-SF.md §5.1. Pivot nodes have their local +X on the hinge line; a positive
// rotation about local X moves a trailing edge DOWN (wing surfaces), the rudder trailing edge RIGHT,
// and gear legs towards RETRACTED. Fans spin about their local Z (engine axis).
import * as THREE from 'three';

// URLs resolve against the repo root whatever page imports this module (index.html or dev/*.html).
const repo = (p) => new URL(`../../../${p}`, import.meta.url).href;

export const model = {
  url: repo('assets/aircraft/b737/b737.glb'),
  lodUrl: repo('assets/aircraft/b737/b737_lod.glb'),
  // detailed flight deck (CONTRACTS-SF.md 6.2.1): streamed after the exterior, root node `interior`, same frame
  cockpitUrl: repo('assets/aircraft/b737/b737_cockpit.glb'),
  displays: {
    screen_pfd_capt: 'b737.pfd',
    screen_nd_capt: 'b737.nd',
    screen_eicas_upper: 'b737.eicas',
    screen_eicas_lower: 'b737.lower',
    screen_nd_fo: 'b737.nd',
    screen_pfd_fo: 'b737.pfd',
    screen_cdu_capt: 'b737.cdu',
    screen_cdu_fo: 'b737.cdu',
    // integrated standby flight display: no 'b737.isfd' type exists; the Airbus ISIS draws the same page
    // (attitude, speed / altitude tapes, baro) and is visually a close match
    screen_isfd: 'a320.isis',
  },
  thumbnail: repo('renders/aircraft/b737/thumb.jpg'),
};

const D = Math.PI / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const NO_ENGINES = [];
const NO_LIGHTS = {};
const IDLE_ENGINE = { n1: 0, throttle: 0, reverser: 0 };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const approach = (cur, target, rate, dt) => cur + Math.max(-rate * dt, Math.min(rate * dt, target - cur));

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function blurTexture() {
  // fan blur disc: faint radial streaks, transparent hub
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    g.strokeStyle = `rgba(150,155,165,${0.05 + 0.05 * Math.random()})`;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(Math.cos(a) * 44, Math.sin(a) * 44);
    g.lineTo(Math.cos(a + 0.35) * 126, Math.sin(a + 0.35) * 126);
    g.stroke();
  }
  const grd = g.createRadialGradient(0, 0, 40, 0, 0, 128);
  grd.addColorStop(0, 'rgba(120,125,135,0.55)');
  grd.addColorStop(0.9, 'rgba(110,115,125,0.45)');
  grd.addColorStop(1, 'rgba(90,95,105,0.0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(0, 0, 128, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createRig(gltfScene) {
  const root = gltfScene || new THREE.Group();
  root.name = root.name || 'b737';
  root.updateMatrixWorld(true);
  const byName = new Map();
  root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  const get = (n) => byName.get(n) || null;
  const localPos = (name, fallback) => {
    const o = get(name);
    if (!o) return fallback.clone();
    const v = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    return root.worldToLocal(v);
  };

  // ---------------------------------------------------------------- pivots
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  function pivot(name) {
    const o = get(name);
    if (!o) return null;
    return { o, q0: o.quaternion.clone(), p0: o.position.clone() };
  }
  function setRot(p, angle, axis = X_AXIS) {
    if (!p) return;
    p.o.quaternion.copy(p.q0).multiply(tmpQ.setFromAxisAngle(axis, angle));
  }
  function setOffset(p, x, y, z) {
    if (!p) return;
    // offset expressed in the node's own (neutral) local frame
    p.o.position.copy(p.p0).add(tmpV.set(x, y, z).applyQuaternion(p.q0));
  }

  const P = {};
  for (const s of ['L', 'R']) {
    P['ail' + s] = pivot(`ctl_aileron_${s}`);
    P['elev' + s] = pivot(`ctl_elevator_${s}`);
    for (const i of [1, 2]) {
      P[`flap${s}${i}`] = pivot(`ctl_flap_${s}_${i}`);
      P[`flap${s}${i}fore`] = pivot(`flap_${s}_${i}_fore`);
      P[`flap${s}${i}aft`] = pivot(`flap_${s}_${i}_aft`);
    }
    for (let i = 1; i <= 6; i++) P[`spl${s}${i}`] = pivot(`ctl_spoiler_${s}_${i}`);
    for (let i = 1; i <= 4; i++) P[`slat${s}${i}`] = pivot(`ctl_slat_${s}_${i}`);
    for (const k of ['K1', 'K2']) P[`kr${s}${k}`] = pivot(`ctl_slat_${s}_${k}`);
    for (let i = 1; i <= 3; i++) P[`canoe${s}${i}`] = pivot(`canoe_${s}_${i}`);
    P['mg' + s] = pivot(`gear_main_${s}`);
    P['mgBrace' + s] = pivot(`gear_main_${s}_brace`);
    P['mgPiston' + s] = pivot(`gear_main_${s}_piston`);
    P['ngDoor' + s] = pivot(`gear_door_nose_${s}`);
  }
  P.rudder = pivot('ctl_rudder');
  P.ng = pivot('gear_nose');
  P.ngBrace = pivot('gear_nose_brace');
  P.ngPiston = pivot('gear_nose_piston');
  // flat part lists (update() is allocation-free)
  const SIDES = ['L', 'R'];
  const flapList = [];
  for (const s of SIDES) for (const i of [1, 2]) {
    if (P[`flap${s}${i}`]) flapList.push({ main: P[`flap${s}${i}`], fore: P[`flap${s}${i}fore`], aft: P[`flap${s}${i}aft`], chord: i === 1 ? 1.6 : 1.25 });
  }
  const canoeList = [], slatList = [], kruegerList = [], spoilerList = [];
  for (const s of SIDES) {
    for (let i = 1; i <= 3; i++) if (P[`canoe${s}${i}`]) canoeList.push(P[`canoe${s}${i}`]);
    for (let i = 1; i <= 4; i++) if (P[`slat${s}${i}`]) slatList.push(P[`slat${s}${i}`]);
    for (const k of ['K1', 'K2']) if (P[`kr${s}${k}`]) kruegerList.push(P[`kr${s}${k}`]);
    for (let i = 1; i <= 6; i++) if (P[`spl${s}${i}`]) spoilerList.push({ p: P[`spl${s}${i}`], right: s === 'R', flight: i >= 2 && i <= 5 });
  }
  const mainGear = SIDES.map((s) => ({ leg: P['mg' + s], brace: P['mgBrace' + s], door: P['ngDoor' + s] }));
  const wheels = [];
  for (const n of ['wheel_nose_L', 'wheel_nose_R']) { const p = pivot(n); if (p) wheels.push({ p, r: 0.343, a: 0 }); }
  for (const s of ['L', 'R']) for (const i of [1, 2]) { const p = pivot(`wheel_main_${s}_${i}`); if (p) wheels.push({ p, r: 0.565, a: 0 }); }

  // ---------------------------------------------------------------- engines
  const blurTex = blurTexture();
  const engines = [1, 2].map((i) => {
    const fan = pivot(`fan_${i}`);
    const rev = pivot(`reverser_${i}`);
    let blur = null;
    if (fan) {
      const mat = new THREE.MeshBasicMaterial({ map: blurTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      blur = new THREE.Mesh(new THREE.CircleGeometry(0.77, 48), mat);
      blur.name = `fan_blur_${i}`;
      blur.position.set(0, 0, -0.02);         // just ahead of the blades (fan local frame: -Z = forward)
      blur.renderOrder = 2;
      blur.visible = false;
      fan.o.add(blur);
    }
    return { fan, rev, blur, angle: 0 };
  });

  // ---------------------------------------------------------------- materials & view
  // the detailed interior arrives later (attachCockpit); the exterior GLB carries the light stand-in interior_lite
  let interior = get('interior');
  let cabin = get('interior_cabin');
  const lite = get('interior_lite');
  let glassMat = null;
  const lensMats = {};
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.name === 'glass_cockpit') glassMat = m;
      if (m.name && m.name.startsWith('lens_')) lensMats[m.name] = m;
      if (m.name && m.name.startsWith('screen')) { m.toneMapped = false; }
    }
  });
  if (glassMat) {
    glassMat.transparent = true;
    glassMat.depthWrite = false;
    glassMat.roughness = 0.03;
    glassMat.metalness = 0.0;
    glassMat.envMapIntensity = 1.6;
  }
  root.traverse((o) => { if (o.isMesh && o.material === glassMat) o.renderOrder = 5; });
  // the enclosed flight deck gets far less sky light than the image-based environment implies (ambient occlusion and
  // soft window light are baked into the cockpit textures; this only tones down the unoccluded environment map)
  function tuneInteriorMaterials(node) {
    if (!node) return;
    const seen = new Set();
    node.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        if ((m.name || '').startsWith('screen')) { m.toneMapped = false; continue; }
        m.envMapIntensity = 0.55;
      }
    });
  }
  tuneInteriorMaterials(interior);
  tuneInteriorMaterials(lite);

  const LENS_COL = { lens_red: 0xff2010, lens_green: 0x20ff60, lens_clear: 0xfff6e8, lens_beacon: 0xff1808 };
  for (const [n, m] of Object.entries(lensMats)) { if (LENS_COL[n] !== undefined) m.emissive = new THREE.Color(LENS_COL[n]); m.emissiveIntensity = 0; }
  function setLens(n, k) { const m = lensMats[n]; if (m && m.emissiveIntensity !== k) m.emissiveIntensity = k; }
  // ---------------------------------------------------------------- lights (sprites + one spot)
  const glowTex = glowTexture();
  const lights = [];
  function addGlow(name, color, size, kind, fallbackPos) {
    const anchor = get(name);
    const mat = new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(size);
    s.renderOrder = 10;
    s.visible = false;
    if (anchor) anchor.add(s);
    else { s.position.copy(fallbackPos || new THREE.Vector3()); root.add(s); }
    const l = { s, kind, size, name };
    lights.push(l);
    return l;
  }
  addGlow('light_nav_L', 0xff2a1a, 0.9, 'nav');
  addGlow('light_nav_R', 0x22ff66, 0.9, 'nav');
  addGlow('light_tail_L', 0xffffff, 0.8, 'nav');
  addGlow('light_tail_R', 0xffffff, 0.8, 'nav');
  addGlow('light_strobe_L', 0xf4f8ff, 3.2, 'strobe');
  addGlow('light_strobe_R', 0xf4f8ff, 3.2, 'strobe');
  addGlow('light_strobe_tail', 0xf4f8ff, 2.6, 'strobe');
  addGlow('light_beacon_top', 0xff2010, 1.6, 'beaconTop');
  addGlow('light_beacon_bottom', 0xff2010, 1.6, 'beaconBottom');
  addGlow('light_landing_L', 0xfff4e0, 2.4, 'landing');
  addGlow('light_landing_R', 0xfff4e0, 2.4, 'landing');
  addGlow('light_turnoff_L', 0xfff4e0, 1.4, 'landing');
  addGlow('light_turnoff_R', 0xfff4e0, 1.4, 'landing');
  addGlow('light_taxi', 0xfff4e0, 1.3, 'taxi');
  addGlow('light_logo_L', 0xffffff, 0.7, 'logo');
  addGlow('light_logo_R', 0xffffff, 0.7, 'logo');

  // one SpotLight for the landing lights: below the nose (nose-gear bay), aimed forward-down so that its cone never
  // reaches the flight deck or the wings (no shadow casting)
  const spot = new THREE.SpotLight(0xfff1dc, 0, 700, 0.26, 0.5, 2);
  spot.castShadow = false;
  const nosePos = localPos('contact_nose', new THREE.Vector3(0, -2.9, -13.85));
  spot.position.set(0, nosePos.y + 1.25, nosePos.z - 0.8);
  spot.target.position.copy(spot.position).add(new THREE.Vector3(0, -6.5, -60));
  root.add(spot);
  root.add(spot.target);

  // ---------------------------------------------------------------- geometry info
  const eye = {
    pilot: localPos('eye_pilot', new THREE.Vector3(-0.53, 0.9, -14.85)),
    copilot: localPos('eye_copilot', new THREE.Vector3(0.53, 0.9, -14.85)),
  };
  const contacts = [
    { name: 'contact_nose', position: localPos('contact_nose', new THREE.Vector3(0, -2.9, -13.85)), kind: 'nose' },
    { name: 'contact_main_L', position: localPos('contact_main_L', new THREE.Vector3(-2.86, -2.9, 1.7)), kind: 'main' },
    { name: 'contact_main_R', position: localPos('contact_main_R', new THREE.Vector3(2.86, -2.9, 1.7)), kind: 'main' },
  ];
  const screens = {};
  root.traverse((o) => { if (o.isMesh && o.name.startsWith('screen_')) screens[o.name] = o; });

  // yokes and levers live in the cockpit GLB: (re)bound in attachCockpit
  const yokes = [];
  const levers = {};
  function bindControls() {
    yokes.length = 0;
    for (const s of ['L', 'R']) yokes.push({ col: pivot(`yoke_col_${s}`), wheel: pivot(`yoke_${s}`) });
    Object.assign(levers, { thr1: pivot('lever_thrust_1'), thr2: pivot('lever_thrust_2'), sb: pivot('lever_speedbrake'), flap: pivot('lever_flap') });
  }
  bindControls();

  // ---------------------------------------------------------------- state
  const st = { flapDeg: 0, slat: 0, gear: 1, t: 0, view: null, flagsApplied: false };

  function update(dt, v) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    st.t += dt;
    const t = v && Number.isFinite(v.time) ? v.time : st.t;
    const ail = v.aileron || 0, elev = v.elevator || 0, rud = v.rudder || 0;
    // ---- primary surfaces
    setRot(P.ailR, -ail * 20 * D);
    setRot(P.ailL, ail * 20 * D);
    const ee = elev >= 0 ? -elev * 26 * D : -elev * 18 * D;
    setRot(P.elevL, ee); setRot(P.elevR, ee);
    setRot(P.rudder, rud * 26 * D);
    // ---- flaps: 40 deg at 1; fowler travel saturates around flaps 15
    const fdeg = clamp01(v.flaps || 0) * 40;
    for (const f of flapList) {
      const travel = f.chord * 0.42 * Math.pow(Math.min(1, fdeg / 15), 0.75);
      // three local: +Z = aft, +Y = up
      setOffset(f.main, 0, -0.18 * travel, travel);
      setRot(f.main, fdeg * 0.55 * D);
      if (f.fore) { setOffset(f.fore, 0, 0.02 * (fdeg / 40), -0.06 * travel); setRot(f.fore, -fdeg * 0.18 * D); }
      if (f.aft) { setOffset(f.aft, 0, -0.04 * travel, 0.26 * travel); setRot(f.aft, fdeg * 0.45 * D); }
    }
    for (const c of canoeList) setRot(c, fdeg * 0.42 * D);
    // ---- leading edge: slats (2-stage) + krueger flaps
    const sl = clamp01(v.slats ?? v.flaps ?? 0);
    const slatExt = Math.min(1, sl * 3);
    for (const p of slatList) {
      setOffset(p, 0, -0.10 * slatExt, -0.22 * slatExt);
      setRot(p, -(8 + 12 * sl) * slatExt * D);
    }
    const kr = 105 * smooth(0, 0.35, sl) * D;
    for (const p of kruegerList) setRot(p, kr);
    // ---- spoilers: 1 & 6 ground only, 2..5 flight (speedbrake + roll assist on the up-aileron side)
    const ground = clamp01(v.spoilers || 0);
    const sb = clamp01(v.speedbrake || 0);
    const rollR = Math.max(0, ail - 0.1) / 0.9, rollL = Math.max(0, -ail - 0.1) / 0.9;
    for (const sp of spoilerList) {
      let a = ground * 60;
      if (sp.flight) a = Math.max(a, sb * 38, (sp.right ? rollR : rollL) * 38);
      setRot(sp.p, -a * D);
    }
    // ---- landing gear sequence (1 = down & locked)
    const g = clamp01(v.gear ?? 1);
    const legMain = 1 - smooth(0.12, 0.92, g);      // 0 down .. 1 retracted
    const legNose = 1 - smooth(0.2, 0.95, g);
    const doorN = smooth(0.0, 0.18, g);             // nose doors open whenever the gear is not up & locked
    for (const m of mainGear) {
      setRot(m.leg, legMain * 88 * D);
      setRot(m.brace, legMain * 55 * D);
      setRot(m.door, doorN * 84 * D);
    }
    setRot(P.ng, legNose * 101 * D);
    setRot(P.ngBrace, legNose * 57 * D);
    // strut compression (0 = extended; ~0.35 at static load where the model sits)
    const comp = v.gearCompression || [];
    const cN = g > 0.99 ? clamp01(comp[0] ?? 0.35) : 0, cL = g > 0.99 ? clamp01(comp[1] ?? 0.35) : 0, cR = g > 0.99 ? clamp01(comp[2] ?? 0.35) : 0;
    setOffset(P.ngPiston, 0, (cN - 0.35) * 0.30, 0);
    // nose-wheel steering (VisualState.steer, rad, + = right): lower strut + wheels turn about the strut axis
    const steer = g > 0.98 ? Math.max(-1.3, Math.min(1.3, v.steer || 0)) : 0;
    setRot(P.ngPiston, -steer, Y_AXIS);
    setOffset(P.mgPistonL, 0, (cL - 0.35) * 0.34, 0);
    setOffset(P.mgPistonR, 0, (cR - 0.35) * 0.34, 0);
    // wheels
    const ws = g > 0.5 ? (v.wheelSpeed || 0) : 0;
    for (const w of wheels) {
      w.a -= (ws / w.r) * dt;
      setRot(w.p, w.a);
    }
    // ---- engines
    const eng = v.engines || NO_ENGINES;
    for (let i = 0; i < engines.length; i++) {
      const e = engines[i];
      const en = eng[i] || eng[0] || IDLE_ENGINE;
      const n1 = clamp01(en.n1 || 0);
      if (e.fan) {
        e.angle += n1 * 38 * Math.PI * 2 * dt;
        setRot(e.fan, e.angle % (Math.PI * 2), Z_AXIS);
        const b = smooth(0.12, 0.35, n1);
        e.blur.visible = b > 0.01;
        e.blur.material.opacity = 0.85 * b;
        e.blur.rotation.z = -e.angle * 0.13;
      }
      if (e.rev) setOffset(e.rev, 0, 0, 0.58 * clamp01(en.reverser || 0));
    }
    // ---- lights
    const L = v.lights || NO_LIGHTS;
    const strobePhase = t % 1.2;
    const strobeOn = !!L.strobe && (strobePhase < 0.05 || (strobePhase > 0.14 && strobePhase < 0.19));
    const beaconPhase = (t * 1.1) % 1;
    for (const l of lights) {
      let on = false, k = 1;
      switch (l.kind) {
        case 'nav': on = !!L.nav; break;
        case 'logo': on = !!L.nav; break;
        case 'strobe': on = strobeOn; break;
        case 'beaconTop': on = !!L.beacon && beaconPhase < 0.18; k = 1 - beaconPhase / 0.18; break;
        case 'beaconBottom': { const ph = (beaconPhase + 0.5) % 1; on = !!L.beacon && ph < 0.18; k = 1 - ph / 0.18; break; }
        case 'landing': on = !!L.landing; break;
        case 'taxi': on = !!L.taxi && g > 0.98; break;
      }
      l.s.visible = on;
      if (on) l.s.scale.setScalar(l.size * (0.6 + 0.4 * k));
    }
    spot.intensity = L.landing ? 30000 : 0;
    setLens('lens_red', L.nav ? 3 : 0);
    setLens('lens_green', L.nav ? 3 : 0);
    setLens('lens_clear', (L.landing || L.taxi || L.nav) ? 3 : 0);
    setLens('lens_beacon', (L.beacon && (beaconPhase < 0.2 || (beaconPhase > 0.5 && beaconPhase < 0.7))) ? 5 : 0);
    // ---- flight deck controls
    for (const y of yokes) {
      setRot(y.col, elev * 9 * D);
      if (y.wheel) y.wheel.o.quaternion.copy(y.wheel.q0).multiply(tmpQ.setFromAxisAngle(Z_AXIS, -ail * 70 * D));
    }
    const e0 = eng[0] || IDLE_ENGINE, e1 = eng[1] || e0;
    // travel matches the quadrant slots: thrust idle -> full 37 deg, speed brake DOWN -> UP 31 deg, flaps UP -> 40 over 40 deg
    if (levers.thr1) setRot(levers.thr1, -clamp01(e0.throttle ?? e0.n1 ?? 0) * 37 * D);
    if (levers.thr2) setRot(levers.thr2, -clamp01(e1.throttle ?? e1.n1 ?? 0) * 37 * D);
    if (levers.sb) setRot(levers.sb, Math.max(sb, ground) * 31 * D);
    if (levers.flap) setRot(levers.flap, (fdeg / 40) * 40 * D);
  }

  function setView(view) {
    if (!st.flagsApplied) {
      // interior never casts shadows (the lead enables shadows on every mesh after createRig)
      if (interior) interior.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
      root.traverse((o) => { if (o.isMesh && (o.material === glassMat || o.name.startsWith('screen_'))) { o.castShadow = false; } });
      for (const e of engines) if (e.blur) { e.blur.castShadow = false; e.blur.receiveShadow = false; }
      st.flagsApplied = true;
    }
    if (view === st.view) return;
    st.view = view;
    const cockpit = view === 'cockpit';
    if (interior) interior.visible = cockpit;
    // the stand-in shows from outside, and in the cockpit view until the detailed interior is attached
    if (lite) lite.visible = !cockpit || !interior;
    if (cabin) cabin.visible = false;
    if (glassMat) {
      glassMat.opacity = cockpit ? 0.08 : 0.9;
      glassMat.color.setRGB(cockpit ? 0.03 : 0.02, cockpit ? 0.04 : 0.025, cockpit ? 0.045 : 0.03);
      glassMat.envMapIntensity = cockpit ? 0.5 : 1.6;
      glassMat.needsUpdate = true;
    }
  }

  /** Detailed flight deck (second GLB, root node `interior`, exported from the same scene frame as the exterior). */
  function attachCockpit(gltfScene) {
    if (!gltfScene || rig.cockpitReady) return;
    root.add(gltfScene);
    gltfScene.updateMatrixWorld(true);
    gltfScene.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
    interior = byName.get('interior') || gltfScene;
    cabin = byName.get('interior_cabin') || null;
    gltfScene.traverse((o) => { if (o.isMesh && o.name.startsWith('screen_')) screens[o.name] = o; });
    tuneInteriorMaterials(interior);
    bindControls();
    rig.cockpitReady = true;
    const v = st.view || 'exterior';
    st.view = null;
    setView(v);
  }

  const rig = {
    object: root,
    eye,
    contacts,
    screens,
    bounds: { length: 39.47, span: 35.79, height: 12.55, radius: 21.5 },
    update,
    setView,
    attachCockpit,
    cockpitReady: !!interior,
  };
  update(0, { aileron: 0, elevator: 0, rudder: 0, flaps: 0, slats: 0, spoilers: 0, speedbrake: 0, gear: 1, gearCompression: [0.35, 0.35, 0.35], wheelSpeed: 0, engines: [{ n1: 0 }, { n1: 0 }], lights: {} });
  setView('exterior');
  return rig;
}
