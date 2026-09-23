// UH-60M Black Hawk — model + rig (aircraft agent uh60). Blender source: blender/aircraft/uh60/build.py
import * as THREE from 'three';

// URLs resolved against this module so they work from index.html and from dev/ pages alike
const repo = (p) => new URL(`../../../${p}`, import.meta.url).href;

export const model = {
  url: repo('assets/aircraft/uh60/uh60.glb'),
  lodUrl: repo('assets/aircraft/uh60/uh60_lod.glb'),
  displays: {
    screen_mfd_1: 'uh60.mfd.pfd', // pilot (right seat) PFD
    screen_mfd_2: 'uh60.mfd.nd', // pilot ND
    screen_mfd_3: 'uh60.mfd.eng', // engine / system page (centre)
    screen_mfd_4: 'uh60.mfd.pfd', // copilot PFD
  },
  thumbnail: repo('renders/aircraft/uh60/thumb.jpg'),
};

// ---- real UH-60M numbers
const NR_RPM = 258; // main rotor 100 % NR
const TR_RPM = 1190; // tail rotor 100 %
const MAIN = { R: 8.18, root: 1.3, chord: 0.58, tipStart: 7.52, sweep: Math.tan((20 * Math.PI) / 180), tipTaper: 0.4, cuffR: 0.95, cuffW: 0.18,
  base: 3.2, ring: 0.12, fres: 2.6, maxA: 0.6 };
const TAIL = { R: 1.675, root: 0.3, chord: 0.246, tipStart: 99, sweep: 0, tipTaper: 0, cuffR: 0.18, cuffW: 0.12,
  base: 3.0, ring: 0.16, fres: 2.6, maxA: 0.65 };
const DEG = Math.PI / 180;
const BLADE_SWITCH = 0.07; // rad swept per frame above which the shader disc replaces the blade meshes

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const approach = (cur, target, rate, dt) => cur + Math.max(-rate * dt, Math.min(rate * dt, target - cur));

/**
 * Motion-blurred rotor disc: for every fragment computes the fraction of the exposure (one frame) during which a blade
 * covered it, from the true rotor azimuth psi and the swept angle delta = omega * dt. Converges to the classic uniform
 * blur disc at high rpm and to crisp blades at low rpm — no stroboscopic wagon-wheel effect at any frame rate.
 * plane: 'xz' (main rotor, azimuth atan2(-z, x)) or 'yz' (tail rotor, azimuth atan2(z, y)).
 */
function rotorGLSL(plane) {
  const az = plane === 'xz' ? 'atan(-vRotorPos.z, vRotorPos.x)' : 'atan(vRotorPos.z, vRotorPos.y)';
  const rr = plane === 'xz' ? 'length(vRotorPos.xz)' : 'length(vRotorPos.yz)';
  return `
varying vec3 vRotorPos;
uniform float uPsi, uDelta, uFade, uR, uRoot, uChord, uTip, uSweep, uTaper, uCuffR, uCuffW;
uniform float uBase, uGhost, uRing, uMaxA;
float bladeChord(float r) {
  float c = uChord;
  if (r > uTip) { float k = (r - uTip) / (uR - uTip); c *= 1.0 - uTaper * pow(k, 1.2); }
  if (r < uRoot) c = uCuffW;
  return c;
}
// time-averaged coverage of one blade whose quarter-chord line ends the exposure at relative angle 0
float bladeCov(float rel, float r) {
  float c = bladeChord(r), off = 0.0;
  if (r > uTip) off = -(r - uTip) * uSweep;
  if (r < uRoot) off = 0.5 * uCuffW - 0.25 * c;
  // blade spans arc distance [off - 0.75c, off + 0.25c] around its axis (positive = ahead in rotation)
  float s = rel * r;
  float a = s - (off + 0.25 * c), b = s - (off - 0.75 * c);
  float d = max(uDelta * r, 1e-4);
  float lo = max(a, -d), hi = min(b, 0.0);
  return clamp((hi - lo) / d, 0.0, 1.0);
}
// density of the spinning rotor as a camera sees it: persistent disc (blade solidity, radial falloff) + this
// frame's motion-blurred blade ghosts + the brighter tip-path ring
float rotorDensity(out float tip) {
  float r = ${rr};
  tip = 0.0;
  if (r > uR || r < uCuffR) return 0.0;
  float th = ${az};
  float u = mod(th - uPsi, 1.5707963);
  float ghost = clamp(bladeCov(u, r) + bladeCov(u - 1.5707963, r), 0.0, 1.0);
  float solidity = 4.0 * bladeChord(r) / (6.2831853 * r);
  float edge = smoothstep(uR, uR - 0.12 * uR, r) * smoothstep(uCuffR, uCuffR + 0.25 * uR, r);
  float disc = min(solidity, 0.075) * (0.8 + 0.2 * r / uR) * edge;
  tip = smoothstep(uR - 0.06 * uR, uR - 0.015 * uR, r) * (1.0 - smoothstep(uR - 0.01 * uR, uR, r));
  return uBase * disc + uGhost * ghost + uRing * tip;
}`;
}

function makeRotorDiscMaterial(p, plane, color) {
  // near-black: a blurred rotor mostly *darkens* what is behind it (blades are dark and largely self-shadowed);
  // a lit grey disc ends up as bright as sunlit concrete and disappears
  // diffuse-only (Lambert): a Standard material shows a strong grazing-angle Fresnel sheen of the sky, which is wrong for
  // a blur of discrete blades and made the disc as bright as the ground
  const mat = new THREE.MeshLambertMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mat.forceSinglePass = true;
  const uniforms = {
    uPsi: { value: 0 }, uDelta: { value: 0 }, uFade: { value: 0 },
    uR: { value: p.R }, uRoot: { value: p.root }, uChord: { value: p.chord }, uTip: { value: p.tipStart },
    uSweep: { value: p.sweep }, uTaper: { value: p.tipTaper }, uCuffR: { value: p.cuffR }, uCuffW: { value: p.cuffW },
    uBase: { value: p.base }, uGhost: { value: 0.6 }, uRing: { value: p.ring }, uFres: { value: p.fres }, uMaxA: { value: p.maxA },
  };
  mat.userData.uniforms = uniforms;
  const vert = (shader) => shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRotorPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRotorPos = position;');
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = vert(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFres;\n' + rotorGLSL(plane))
      .replace('#include <color_fragment>', `#include <color_fragment>
{ float tipMark; float dens = rotorDensity(tipMark);
  // fresnel-like term: a disc seen edge-on shows much more blade per pixel (and reads as a thin dark band)
  vec3 nV = normalize(vNormal);
  float cosv = abs(dot(nV, normalize(vViewPosition)));
  float fres = 1.0 + uFres * pow(1.0 - cosv, 4.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30), tipMark * 0.55);
  diffuseColor.a = clamp(dens * fres, 0.0, uMaxA) * uFade; if (diffuseColor.a < 0.004) discard; }`);
  };
  mat.customProgramCacheKey = () => `uh60rotor-${plane}`;
  // shadow: hashed alpha from the same density (no view-dependent term) -> faint rotor shadow with blade streaks
  const depth = new THREE.MeshDepthMaterial({ alphaHash: true, side: THREE.DoubleSide });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = vert(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + rotorGLSL(plane))
      .replace('#include <alphatest_fragment>', `{ float tm; diffuseColor.a = clamp(rotorDensity(tm) * 0.7, 0.0, uMaxA) * uFade; }
#include <alphatest_fragment>`);
  };
  depth.customProgramCacheKey = () => `uh60rotor-depth-${plane}`;
  mat.userData.depthMaterial = depth;
  return mat;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createRig(gltfScene) {
  const object = new THREE.Group();
  object.name = 'uh60_rig';
  object.add(gltfScene);
  object.updateMatrixWorld(true);
  const find = (n) => gltfScene.getObjectByName(n);
  const localPos = (n) => {
    const o = find(n);
    if (!o) return null;
    o.getWorldPosition(_v);
    return object.worldToLocal(_v.clone());
  };

  // ---- contract data
  const eye = { pilot: localPos('eye_pilot') || new THREE.Vector3(0.54, 0.39, -3.28) };
  const cop = localPos('eye_copilot');
  if (cop) eye.copilot = cop;
  const contacts = [];
  for (const [name, kind] of [['contact_main_L', 'main'], ['contact_main_R', 'main'], ['contact_tail', 'tail']]) {
    const p = localPos(name);
    if (p) contacts.push({ name, position: p, kind });
  }
  const screens = {};
  gltfScene.traverse((o) => { if (o.isMesh && o.name.startsWith('screen_')) screens[o.name] = o; });
  const bounds = { length: 19.76, span: 16.36, height: 5.13, radius: 10.4 };

  // ---- nodes
  const rotorMain = find('rotor_main');
  const rotorTail = find('rotor_tail');
  const blurMain = find('rotor_main_blur');
  const blurTail = find('rotor_tail_blur');
  const swash = find('swashplate');
  const stab = find('ctl_stabilator');
  const interior = find('interior');
  const blades = [1, 2, 3, 4].map((i) => find(`blade_${i}`)).filter(Boolean);
  const tailBlades = [1, 2, 3, 4].map((i) => find(`tail_blade_${i}`)).filter(Boolean);
  const bladeBase = blades.map((b) => b.quaternion.clone());
  const tailBase = tailBlades.map((b) => b.quaternion.clone());
  const blurMainBase = blurMain ? blurMain.quaternion.clone() : null;
  const swashBase = swash ? { q: swash.quaternion.clone(), p: swash.position.clone() } : null;
  const wheels = ['wheel_main_L', 'wheel_main_R', 'wheel_tail'].map(find).filter(Boolean);
  const wheelR = [0.33, 0.33, 0.24];
  const doors = ['door_cabin_L', 'door_cabin_R'].map((n) => {
    const o = find(n);
    return o ? { o, base: o.position.clone(), side: n.endsWith('_R') ? 1 : -1 } : null;
  }).filter(Boolean);

  // rotor discs get the motion-blur shader
  const discMat = {};
  if (blurMain) {
    discMat.main = makeRotorDiscMaterial(MAIN, 'xz', 0x191b19);
    // high renderOrder: drawn after the world's transparent layers (runway markings, water), which would otherwise
    // paint over the depth-write-free disc
    blurMain.traverse((o) => { if (o.isMesh) { o.material = discMat.main; o.customDepthMaterial = discMat.main.userData.depthMaterial; o.renderOrder = 20; } });
  }
  if (blurTail) {
    discMat.tail = makeRotorDiscMaterial(TAIL, 'yz', 0x191b19);
    blurTail.traverse((o) => { if (o.isMesh) { o.material = discMat.tail; o.customDepthMaterial = discMat.tail.userData.depthMaterial; o.renderOrder = 20; } });
  }
  // the discs cast a faint hashed shadow through customDepthMaterial (castShadow is enabled by the loader)
  const discMeshes = [];
  for (const d of [blurMain, blurTail]) if (d) d.traverse((o) => { if (o.isMesh) discMeshes.push(o); });

  // ---- lights: emissive lenses + additive glow sprites, one spot light for the landing light
  const glowTex = glowTexture();
  const mkGlow = (node, color, size) => {
    const m = new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const s = new THREE.Sprite(m);
    s.scale.setScalar(size);
    s.renderOrder = 21;
    node.add(s);
    return s;
  };
  const L = {};
  const addL = (key, name, color, size) => { const n = find(name); if (n) L[key] = mkGlow(n, color, size); };
  addL('navL', 'light_nav_L', 0xff2a1a, 0.55);
  addL('navR', 'light_nav_R', 0x22ff55, 0.55);
  addL('tail', 'light_tail', 0xffffff, 0.5);
  addL('beaconTop', 'light_beacon_top', 0xff2010, 1.1);
  addL('beaconBottom', 'light_beacon_bottom', 0xff2010, 1.1);
  const lensMats = {};
  gltfScene.traverse((o) => {
    if (o.isMesh && o.name.startsWith('lens_')) {
      o.material = o.material.clone();
      lensMats[o.name] = o.material;
    }
  });
  let spot = null;
  const landingNode = find('light_landing');
  if (landingNode) {
    spot = new THREE.SpotLight(0xfff4e0, 0, 260, 0.32, 0.45, 1.2);
    spot.position.set(0, 0, 0);
    spot.target.position.set(0, 0, -10);
    landingNode.add(spot, spot.target);
    L.landing = mkGlow(landingNode, 0xfff4e0, 0.9);
  }

  // ---- interior fill: the cabin/cockpit sit inside a closed shell, so image-based light and the sun barely reach them.
  // Interior materials get an emissive term equal to their own albedo, scaled by a day factor from the scene's sun.
  const interiorMats = new Set();
  gltfScene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m && /^int_/.test(m.name) && !/lamp/.test(m.name) && m.emissive) interiorMats.add(m);
    }
  });
  for (const m of interiorMats) {
    m.emissive.copy(m.color);
    if (m.map) m.emissiveMap = m.map;
    m.emissiveIntensity = 0;
    m.needsUpdate = true;
  }
  // electroluminescent formation lights (emissive mask in the hull atlas), on with the nav lights, stronger at night
  let hullMat = null;
  gltfScene.traverse((o) => {
    if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && m.name === 'hull' && m.emissiveMap) hullMat = m;
  });
  if (hullMat) hullMat.emissiveIntensity = 0;
  let dayLevel = 1;
  let sunLight = null;
  let sunSearch = 0;
  const _sd = new THREE.Vector3();
  function interiorFill(dt) {
    if (!interiorMats.size && !hullMat) return;
    if (!sunLight && (sunSearch -= dt) <= 0) {
      sunSearch = 2;
      let root = object;
      while (root.parent) root = root.parent;
      root.traverse((o) => { if (o.isDirectionalLight && (!sunLight || o.intensity > sunLight.intensity)) sunLight = o; });
    }
    let day = 0.6;
    if (sunLight) {
      _sd.copy(sunLight.position).sub(sunLight.target.position).normalize();
      day = smooth(-0.04, 0.25, _sd.y) * Math.min(1.2, sunLight.intensity / 3);
    }
    dayLevel = Math.min(1, day);
    const k = 0.95 * day + 0.03;
    for (const m of interiorMats) m.emissiveIntensity = k;
  }

  // ---- state
  let psi = 0; // main rotor azimuth (rad)
  let psiT = 0; // tail rotor azimuth
  let stabDeg = 40; // stabilator incidence, + = trailing edge down
  let doorOpen = 0;
  let wheelAngle = 0;
  let t = 0;
  let view = 'exterior';

  function update(dt, v) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    t += dt;
    interiorFill(dt);
    const ro = v.rotor || null;
    let rpm = ro ? ro.rpm : v.engines && v.engines[0] ? v.engines[0].n1 : 0;
    if (rpm > 3) rpm /= NR_RPM; // tolerate absolute rpm
    rpm = Math.max(0, Math.min(1.2, rpm || 0));
    const coll = ro ? ro.collective || 0 : 0.3;
    const cx = ro ? ro.cyclicX || 0 : 0; // roll right +
    const cy = ro ? ro.cyclicY || 0 : 0; // pitch (nose up +)
    const pedal = ro ? ro.pedal || 0 : 0;

    // ---- main rotor (prefer the flight model's exact rotor state when it provides one)
    const omega = ro && Number.isFinite(ro.omega) ? Math.max(0, ro.omega) : (2 * Math.PI * NR_RPM * rpm) / 60;
    psi = (psi + omega * dt) % (Math.PI * 2);
    const delta = omega * Math.max(dt, 1 / 240) * 1.0; // exposure = one frame
    const spin = rpm; // 0..1
    const cone = ro && Number.isFinite(ro.coning) ? Math.max(-3.2 * DEG, ro.coning - 0.9 * DEG * (1 - Math.min(1, spin * 2)))
      : (-3.2 + (4.4 + 2.4 * coll) * Math.min(1, spin * spin)) * DEG; // droop at rest, ~2-3.5 deg coning when turning
    // tip-path-plane tilt: flight model tiltLon (+ forward) / tiltLat (+ right), else from the cyclic
    const pitchTilt = ro && Number.isFinite(ro.tiltLon) ? -ro.tiltLon : cy * 5 * DEG * Math.min(1, spin * 2);
    const rollTilt = ro && Number.isFinite(ro.tiltLat) ? ro.tiltLat : cx * 5 * DEG * Math.min(1, spin * 2);
    const theta0 = (2 + 14 * coll) * DEG;
    if (rotorMain) {
      rotorMain.rotation.y = psi;
      const showBlades = delta < BLADE_SWITCH; // slow rotor: real blade meshes; fast: motion-blurred disc
      for (let i = 0; i < blades.length; i++) {
        const b = blades[i];
        b.visible = showBlades;
        if (!showBlades) continue;
        const az = psi + (i * Math.PI) / 2;
        // first-harmonic flapping: disc tilts toward the cyclic
        const beta = cone + pitchTilt * Math.sin(az) - rollTilt * Math.cos(az);
        const feather = theta0 - cx * 6 * DEG * Math.sin(az) + cy * 6 * DEG * Math.cos(az);
        _q.setFromAxisAngle(AX_Z, beta);
        _q2.setFromAxisAngle(AX_X, feather);
        b.quaternion.copy(bladeBase[i]).multiply(_q).multiply(_q2);
      }
    }
    if (blurMain && discMat.main) {
      const u = discMat.main.userData.uniforms;
      u.uPsi.value = psi;
      u.uDelta.value = delta;
      u.uFade.value = 1;
      u.uBase.value = MAIN.base * smooth(0.12, 0.75, spin);
      u.uRing.value = MAIN.ring * smooth(0.3, 0.9, spin);
      blurMain.visible = delta >= BLADE_SWITCH;
      // coning (the disc mesh is built with a 2.5 deg cone) and tip-path-plane tilt
      blurMain.scale.set(1, Math.max(0.05, (cone / DEG) / 2.5), 1);
      _e.set(pitchTilt, 0, -rollTilt);
      blurMain.quaternion.copy(blurMainBase).multiply(_q.setFromEuler(_e));
    }
    if (swash && swashBase) {
      _e.set(pitchTilt * 0.8, 0, -rollTilt * 0.8);
      swash.quaternion.copy(swashBase.q).multiply(_q.setFromEuler(_e));
      swash.position.copy(swashBase.p);
      _v.set(0, (coll - 0.5) * 0.05, 0).applyQuaternion(swashBase.q);
      swash.position.add(_v);
    }

    // ---- tail rotor (spins about its local X)
    const omegaT = ro && Number.isFinite(ro.tailOmega) ? Math.max(0, ro.tailOmega) : (2 * Math.PI * TR_RPM * rpm) / 60;
    psiT = (psiT + omegaT * dt) % (Math.PI * 2);
    const deltaT = omegaT * Math.max(dt, 1 / 240);
    if (rotorTail) {
      rotorTail.rotation.x = psiT;
      const show = deltaT < BLADE_SWITCH;
      for (let i = 0; i < tailBlades.length; i++) {
        tailBlades[i].visible = show;
        if (!show) continue;
        _q.setFromAxisAngle(AX_Y, (4 + 12 * pedal) * DEG);
        tailBlades[i].quaternion.copy(tailBase[i]).multiply(_q);
      }
    }
    if (blurTail && discMat.tail) {
      const u = discMat.tail.userData.uniforms;
      u.uPsi.value = psiT;
      u.uDelta.value = deltaT;
      u.uFade.value = 1;
      u.uBase.value = TAIL.base * smooth(0.05, 0.5, spin);
      u.uRing.value = TAIL.ring * smooth(0.2, 0.8, spin);
      blurTail.visible = deltaT >= BLADE_SWITCH;
    }

    // ---- stabilator: ~40 deg trailing-edge down in the hover, ~0 in cruise, slightly up at high speed
    const kt = (v.airspeed || 0) * 1.943844;
    let target;
    if (kt < 30) target = 40;
    else if (kt < 80) target = 40 - (40 * (kt - 30)) / 50;
    else target = Math.max(-8, -(kt - 80) * 0.12);
    target -= (coll - 0.5) * 4 * smooth(30, 60, kt); // collective coupling in forward flight
    if (Number.isFinite(v.stabilator)) stabDeg = v.stabilator / DEG; // flight model schedule (rad, TE down +)
    else stabDeg = approach(stabDeg, target, 12, dt);
    if (stab) stab.rotation.x = stabDeg * DEG; // + about X = trailing edge down

    // ---- cabin doors (VisualState.canopy drives the sliding doors)
    doorOpen = approach(doorOpen, v.canopy || 0, 0.6, dt);
    for (const d of doors) {
      const e = smooth(0, 0.12, doorOpen);
      d.o.position.set(d.base.x + d.side * 0.045 * e, d.base.y, d.base.z + 1.74 * smooth(0.06, 1, doorOpen));
    }

    // ---- wheels
    wheelAngle += ((v.wheelSpeed || 0) * dt);
    for (let i = 0; i < wheels.length; i++) wheels[i].rotation.x = -wheelAngle / wheelR[i];

    // ---- lights
    const lt = v.lights || {};
    const nav = !!lt.nav;
    if (L.navL) L.navL.visible = nav;
    if (L.navR) L.navR.visible = nav;
    if (L.tail) L.tail.visible = nav;
    const ph = t % 1.1;
    const flash = !!(lt.beacon || lt.strobe) && (ph < 0.08 || (ph > 0.22 && ph < 0.3));
    if (L.beaconTop) L.beaconTop.visible = flash;
    if (L.beaconBottom) L.beaconBottom.visible = flash;
    for (const [n, m] of Object.entries(lensMats)) {
      const on = n.includes('nav') || n.includes('tail') ? nav : n.includes('beacon') ? flash : n.includes('landing') ? !!lt.landing : true;
      m.emissiveIntensity = on ? 1 : 0.02;
    }
    if (hullMat) hullMat.emissiveIntensity = nav ? 0.06 + 1.6 * (1 - dayLevel) : 0;
    const land = !!(lt.landing || lt.taxi);
    if (spot) spot.intensity = land ? 180 : 0;
    if (L.landing) L.landing.visible = land;
  }

  function setView(vw) {
    if (vw === view) return;
    view = vw;
    if (interior) interior.visible = true; // the cabin/cockpit is visible through the large windows in both views
  }

  update(0, { rotor: { rpm: 0, collective: 0, cyclicX: 0, cyclicY: 0, pedal: 0 }, airspeed: 0, lights: {}, canopy: 0 });
  return { object, eye, contacts, screens, bounds, update, setView };
}
