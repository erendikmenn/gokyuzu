// F-22A Raptor: model definition + runtime rig (CONTRACTS-SF §6.2).
// The GLB is built by blender/aircraft/f22/build.py. Pivoting parts have their local X axis on the hinge and
// rotation 0 = neutral; the rig rotates them about local X from their rest quaternion.
import * as THREE from 'three';

// URLs are resolved against this module so they work from index.html and from dev/ pages alike.
const asset = (p) => new URL(`../../../${p}`, import.meta.url).href;

export const model = {
  url: asset('assets/aircraft/f22/f22.glb'),
  lodUrl: asset('assets/aircraft/f22/f22_lod.glb'),
  displays: {
    screen_hud: 'f22.hud',
    screen_pmfd: 'f22.pmfd',
    screen_ufd_L: 'f22.ufd',
    screen_ufd_R: 'f22.ufd',
    screen_smfd_L: 'f22.smfd',
    screen_smfd_R: 'f22.smfd',
    screen_smfd_C: 'f22.smfd',
  },
  thumbnail: 'renders/aircraft/f22/thumb.jpg',
};

const D2R = Math.PI / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

// control-surface travel (deg)
const MAX = {
  aileron: 25, flaperonRoll: 16, flaperonFlap: 35, stab: 25, stabRoll: 8, rudder: 30, lefDroop: 25,
  tvc: 20, nozzleOpen: 9, canopy: 38, noseGear: 96, mainGear: 92, noseDoor: 88, mainDoor: 95,
};

function radialTexture(inner = '#ffffff', mid = 'rgba(255,255,255,0.35)') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(0.18, inner); gr.addColorStop(0.45, mid); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- afterburner plume (volumetric-looking shader)
// Nested flattened tubes along +Z (downstream). Density ~ view-facing term (thicker through the centre), colour ramp
// blue-white core -> yellow -> orange, Mach-disk pinches (shock diamonds) on the inner core. Additive, no depth write.
const PLUME_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vV; varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;
const PLUME_FS = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uLevel; uniform float uTime; uniform float uCore; uniform float uSeed;
uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uColC;
varying vec3 vN; varying vec3 vV; varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float v = vUv.y;
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float thick = pow(facing, 1.6);
  float fade = (1.0 - smoothstep(0.35, 1.0, v)) * smoothstep(0.0, 0.02, v);
  vec3 col = mix(uColA, uColB, smoothstep(0.02, 0.22, v));
  col = mix(col, uColC, smoothstep(0.22, 0.75, v));
  float d = 0.0;
  for (int k = 0; k < 6; k++) {
    float c = 0.075 + float(k) * 0.105;
    d += exp(-pow((v - c) / 0.034, 2.0)) * (1.0 - float(k) * 0.15);
  }
  float n = sin(uTime * 53.0 + v * 37.0 + uSeed) * sin(uTime * 31.0 - v * 23.0 + uSeed * 2.0);
  float flick = 0.86 + 0.14 * n;
  float a = uLevel * fade * thick * (0.7 + uCore * d * 1.3) * flick;
  gl_FragColor = vec4(col * a, a);
}`;

function plumeGeometry(w0, h0, w1, h1, length, radial = 28, rings = 48, pinch = 0) {
  // flattened (superelliptic) tube; uv.x around, uv.y along (0 at the nozzle exit)
  const pos = [], nrm = [], uv = [], idx = [];
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    let sw = w0 + (w1 - w0) * Math.pow(v, 0.7), sh = h0 + (h1 - h0) * Math.pow(v, 0.7);
    if (pinch > 0) {
      const ph = ((v - 0.02) / 0.105) % 1;
      const k = 1 - pinch * (1 - Math.abs(Math.cos(Math.PI * ph)));
      sw *= k; sh *= k;
    }
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const e = 0.6;
      const x = Math.sign(c) * Math.pow(Math.abs(c), e) * sw / 2;
      const y = Math.sign(s) * Math.pow(Math.abs(s), e) * sh / 2;
      pos.push(x, y, v * length);
      const nx = c / Math.max(sw, 1e-3), ny = s / Math.max(sh, 1e-3);
      const l = Math.hypot(nx, ny) || 1;
      nrm.push(nx / l, ny / l, 0);
      uv.push(i / radial, v);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < radial; i++) {
      const a = j * (radial + 1) + i, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function makePlume(width, height, length, seed) {
  const group = new THREE.Group();
  const layers = [];
  const add = (geo, colA, colB, colC, core, gain) => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLUME_VS, fragmentShader: PLUME_FS,
      uniforms: {
        uLevel: { value: 0 }, uTime: { value: 0 }, uCore: { value: core }, uSeed: { value: seed },
        uColA: { value: new THREE.Color(...colA) }, uColB: { value: new THREE.Color(...colB) }, uColC: { value: new THREE.Color(...colC) },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 10;
    m.castShadow = false;
    group.add(m);
    layers.push({ mat, gain });
  };
  // outer envelope, mid flame, inner core with shock diamonds
  add(plumeGeometry(width * 1.02, height * 1.05, width * 0.9, height * 1.7, length), [1.0, 0.55, 0.25], [1.0, 0.42, 0.14], [0.8, 0.22, 0.06], 0.0, 0.55);
  add(plumeGeometry(width * 0.9, height * 0.85, width * 0.45, height * 0.8, length * 0.8), [1.0, 0.85, 0.6], [1.0, 0.6, 0.25], [1.0, 0.35, 0.1], 0.3, 0.75);
  add(plumeGeometry(width * 0.7, height * 0.6, width * 0.25, height * 0.3, length * 0.62, 24, 64, 0.45), [0.75, 0.8, 1.0], [1.0, 0.92, 0.75], [1.0, 0.6, 0.3], 1.0, 0.8);
  return { group, layers };
}

export function createRig(gltfScene) {
  const object = new THREE.Group();
  object.name = 'f22_rig';
  if (!gltfScene) throw new Error('f22: GLB not loaded');
  object.add(gltfScene);
  gltfScene.updateMatrixWorld(true);
  const node = (n) => gltfScene.getObjectByName(n);
  const localPos = (n) => {
    const o = node(n);
    if (!o) return null;
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    return gltfScene.worldToLocal(p);   // gltfScene sits at identity inside `object`
  };

  // ---------------- pivots (rest quaternions)
  const pivots = {};
  const piv = (n) => {
    const o = node(n);
    if (!o) return null;
    pivots[n] = { o, rest: o.quaternion.clone(), restPos: o.position.clone() };
    return pivots[n];
  };
  const names = ['ctl_aileron_L', 'ctl_aileron_R', 'ctl_flaperon_L', 'ctl_flaperon_R', 'ctl_stabilator_L', 'ctl_stabilator_R',
    'ctl_rudder_L', 'ctl_rudder_R', 'ctl_lef_L', 'ctl_lef_R', 'canopy', 'gear_nose', 'gear_main_L', 'gear_main_R',
    'gear_door_nose_L', 'gear_door_nose_R', 'gear_door_main_L', 'gear_door_main_R', 'wheel_nose', 'wheel_main_L', 'wheel_main_R',
    'gear_nose_steer',
    'nozzle_flap_upper_1', 'nozzle_flap_lower_1', 'nozzle_flap_upper_2', 'nozzle_flap_lower_2', 'cockpit_stick', 'cockpit_throttle'];
  for (const n of names) piv(n);
  const q = new THREE.Quaternion();
  const rotX = (n, angle) => {
    const p = pivots[n];
    if (!p) return;
    q.setFromAxisAngle(X_AXIS, angle);
    p.o.quaternion.copy(p.rest).multiply(q);
  };

  // ---------------- canopy material (gold ITO coating, iridescent)
  const canopy = node('canopy');
  const glassMats = [];
  if (canopy) {
    canopy.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (m && (m.transparent || /canopy/i.test(m.name))) {
        const g = new THREE.MeshPhysicalMaterial({
          name: 'f22_canopy_rt', color: new THREE.Color(0.62, 0.52, 0.30), metalness: 0.0, roughness: 0.04,
          transparent: true, opacity: 0.42, iridescence: 1.0, iridescenceIOR: 1.9, iridescenceThicknessRange: [260, 520],
          specularIntensity: 1.0, specularColor: new THREE.Color(1.0, 0.82, 0.45), envMapIntensity: 1.6,
          side: THREE.DoubleSide, depthWrite: false,
        });
        o.material = g;
        o.renderOrder = 5;
        o.castShadow = false;
        glassMats.push(g);
      }
    });
  }
  const hudGlass = node('hud_glass');
  if (hudGlass && hudGlass.isMesh) {
    hudGlass.material = new THREE.MeshPhysicalMaterial({ color: 0x9fd6b8, roughness: 0.05, transparent: true, opacity: 0.1,
      side: THREE.DoubleSide, depthWrite: false });
    hudGlass.castShadow = false;
  }

  // ---------------- screens
  const screens = {};
  gltfScene.traverse((o) => { if (o.isMesh && o.name.startsWith('screen_')) { screens[o.name] = o; o.castShadow = false; } });
  const screenFlip = new Set();
  const fixScreenUV = () => {
    // CanvasTexture uses flipY = true: flip the (glTF, top-left origin) UVs once so the canvas reads upright.
    for (const [n, m] of Object.entries(screens)) {
      if (screenFlip.has(n)) continue;
      const map = m.material && m.material.map;
      if (!map) continue;
      screenFlip.add(n);
      if (map.flipY) {
        const uv = m.geometry.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
        uv.needsUpdate = true;
      }
    }
  };

  // ---------------- engine glow + afterburner plumes
  const glow = [node('ab_glow_1'), node('ab_glow_2')].map((o) => {
    if (!o || !o.isMesh) return null;
    o.material = o.material.clone();
    o.material.emissive = new THREE.Color(1.0, 0.42, 0.12);
    o.material.emissiveIntensity = 0;
    o.castShadow = false;
    return o;
  });
  const plumes = [1, 2].map((i) => {
    const p = localPos(`nozzle_${i}`) || new THREE.Vector3(i === 1 ? -0.7 : 0.7, 0, 7.9);
    const holder = new THREE.Group();
    holder.position.copy(p);
    const pl = makePlume(0.98, 0.42, 5.5, i * 1.7);
    holder.add(pl.group);
    holder.visible = false;
    object.add(holder);
    return { holder, ...pl, level: 0 };
  });
  const abLight = new THREE.PointLight(0xff8a3a, 0, 25, 2);
  const nz1 = localPos('nozzle_1'), nz2 = localPos('nozzle_2');
  if (nz1 && nz2) abLight.position.copy(nz1).add(nz2).multiplyScalar(0.5).add(new THREE.Vector3(0, 0, 2.5));
  object.add(abLight);

  // ---------------- lights
  const flare = radialTexture();
  const sprites = {};
  const mkSprite = (n, color, size) => {
    const p = localPos(n);
    if (!p) return null;
    const m = new THREE.SpriteMaterial({ map: flare, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
    const s = new THREE.Sprite(m);
    s.position.copy(p);
    s.scale.setScalar(size);
    s.userData.base = size;
    s.renderOrder = 12;
    const parentNode = node(n).parent;
    // lights on the nose gear retract with it: attach the sprite to the node itself
    if (parentNode && parentNode !== gltfScene && parentNode.name.startsWith('gear_')) { s.position.set(0, 0, 0); node(n).add(s); }
    else object.add(s);
    sprites[n] = s;
    return s;
  };
  mkSprite('light_nav_L', new THREE.Color(1.0, 0.08, 0.05), 0.55);
  mkSprite('light_nav_R', new THREE.Color(0.1, 1.0, 0.25), 0.55);
  mkSprite('light_tail', new THREE.Color(1, 1, 1), 0.45);
  mkSprite('light_strobe_L', new THREE.Color(1, 1, 1), 2.2);
  mkSprite('light_strobe_R', new THREE.Color(1, 1, 1), 2.2);
  mkSprite('light_beacon_top', new THREE.Color(1.0, 0.1, 0.05), 1.4);
  mkSprite('light_beacon_bottom', new THREE.Color(1.0, 0.1, 0.05), 1.4);
  mkSprite('light_landing', new THREE.Color(1.0, 0.97, 0.9), 0.9);
  mkSprite('light_taxi', new THREE.Color(1.0, 0.97, 0.9), 0.7);
  const landNode = node('light_landing');
  const spot = new THREE.SpotLight(0xfff4e0, 0, 600, 0.22, 0.45, 1.6);
  spot.castShadow = false;
  if (landNode) {
    landNode.add(spot);
    landNode.add(spot.target);
    spot.target.position.set(0, -0.04, -1);   // local -Z = forward (Three), slightly down
  }
  const formation = node('formation_lights');
  if (formation) {
    formation.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.emissive = new THREE.Color(0.55, 1.0, 0.45);
        o.material.emissiveIntensity = 0;
        o.castShadow = false;
      }
    });
  }

  // ---------------- contacts, eye, bounds
  const contacts = [];
  for (const [n, kind] of [['contact_nose', 'nose'], ['contact_main_L', 'main'], ['contact_main_R', 'main']]) {
    const p = localPos(n);
    if (p) contacts.push({ name: n, position: p, kind });
  }
  const eye = { pilot: localPos('eye_pilot') || new THREE.Vector3(0, 0.9, -5.3) };
  const bounds = { length: 18.92, span: 13.56, height: 5.08, radius: 10.4 };

  // wheels: radius from geometry
  const wheelR = {};
  for (const n of ['wheel_nose', 'wheel_main_L', 'wheel_main_R']) {
    const o = node(n);
    if (!o) continue;
    const box = new THREE.Box3().setFromObject(o);
    wheelR[n] = Math.max(0.2, (box.max.y - box.min.y) / 2);
  }
  const wheelAngle = { wheel_nose: 0, wheel_main_L: 0, wheel_main_R: 0 };
  // nose strut axis (steer node local +X) expressed in its parent's frame, for oleo travel
  const noseUp = new THREE.Vector3(1, 0, 0);
  if (pivots.gear_nose_steer) noseUp.applyQuaternion(pivots.gear_nose_steer.rest);
  const interior = node('interior');
  const pilot = node('pilot');
  // meshes that must never cast shadows (glass would darken the cockpit; plumes/glows are light)
  const noShadow = [];
  const collectNoShadow = () => {
    noShadow.length = 0;
    for (const n of ['canopy', 'hud_glass', 'screen_hud', 'formation_lights', 'ab_glow_1', 'ab_glow_2']) {
      const o = node(n);
      if (o) o.traverse((m) => { if (m.isMesh && (n !== 'canopy' || m.material === glassMats[0] || glassMats.includes(m.material))) noShadow.push(m); });
    }
    for (const pl of plumes) pl.group.traverse((m) => { if (m.isMesh) noShadow.push(m); });
  };
  collectNoShadow();
  const formationMeshes = [];
  if (formation) formation.traverse((o) => { if (o.isMesh) formationMeshes.push(o); });
  const stickEuler = new THREE.Euler();

  // ---------------- state smoothing
  const st = { t: 0, sb: 0, flap: 0, tvc: 0, open: [0.25, 0.25], ab: [0, 0], gear: 1, canopy: 0, strobe: 0 };
  let view = 'exterior';

  // per-frame constants (no allocations inside update)
  const FLAP_U = ['nozzle_flap_upper_1', 'nozzle_flap_upper_2'], FLAP_L = ['nozzle_flap_lower_1', 'nozzle_flap_lower_2'];
  const MAIN_WHEELS = [['wheel_main_L', 1], ['wheel_main_R', 2]];
  const WHEELS = ['wheel_nose', 'wheel_main_L', 'wheel_main_R'];
  const NO_ENGINE = {};
  const EMPTY = [];
  let compArr = EMPTY;
  const TRAVEL = 0.26;                       // metres of oleo stroke over gearCompression 0..1
  const strutOff = (i) => (clamp(num(compArr[i], 0.35), 0, 1) - 0.35) * TRAVEL;   // + = compressed (wheel up)
  const setS = (n, on, gain = 1) => {
    const sp = sprites[n];
    if (sp) { sp.visible = on && gain > 0.01; sp.material.opacity = gain; sp.scale.setScalar(sp.userData.base * (0.6 + 0.4 * gain)); }
  };

  let shadowFix = 0;
  function update(dt, v) {
    dt = clamp(num(dt, 0.016), 0, 0.1);
    fixScreenUV();
    if (shadowFix < 3) {        // the app enables castShadow on every mesh after createRig(): undo it for glass/FX
      shadowFix++;
      for (const m of noShadow) { m.castShadow = false; m.receiveShadow = false; }
    }
    st.t += dt;
    const k = 1 - Math.exp(-dt * 12);
    const ail = clamp(num(v.aileron), -1, 1), ele = clamp(num(v.elevator), -1, 1), rud = clamp(num(v.rudder), -1, 1);
    const flaps = clamp(num(v.flaps), 0, 1), sb = clamp(num(v.speedbrake), 0, 1);
    st.sb += (sb - st.sb) * k;
    st.flap += (flaps - st.flap) * (1 - Math.exp(-dt * 4));
    // ailerons (+ = TE down about local X)
    const sbA = st.sb * 30 * D2R;
    rotX('ctl_aileron_R', (-ail * MAX.aileron) * D2R - sbA);
    rotX('ctl_aileron_L', (ail * MAX.aileron) * D2R - sbA);
    // flaperons: flaps + roll + speedbrake (down)
    const fl = st.flap * MAX.flaperonFlap + st.sb * 32;
    rotX('ctl_flaperon_R', (fl - ail * MAX.flaperonRoll) * D2R);
    rotX('ctl_flaperon_L', (fl + ail * MAX.flaperonRoll) * D2R);
    // stabilators (pitch + differential roll); nose-up = TE up = negative
    const buf = clamp(num(v.buffet), 0, 1) * 0.8 * Math.sin(st.t * 41) * Math.sin(st.t * 17.3);
    rotX('ctl_stabilator_R', (-ele * MAX.stab - ail * MAX.stabRoll + buf) * D2R);
    rotX('ctl_stabilator_L', (-ele * MAX.stab + ail * MAX.stabRoll - buf) * D2R);
    // rudders (hinge axis points up: + = TE to the right) + toe-out speedbrake
    const rs = st.sb * 25;
    rotX('ctl_rudder_R', (-rud * MAX.rudder + rs) * D2R);
    rotX('ctl_rudder_L', (-rud * MAX.rudder - rs) * D2R);
    // LEF: droop with AoA / flaps (negative = LE down). VisualState.aoa is in radians.
    const aoaDeg = num(v.aoa) / D2R;
    const lef = clamp(Math.max(st.flap * 0.8, (aoaDeg - 4) / 16), 0, 1) * MAX.lefDroop;
    rotX('ctl_lef_R', -lef * D2R);
    rotX('ctl_lef_L', -lef * D2R);

    // ---- TVC nozzles
    const tvcT = clamp(num(v.tvc && v.tvc.pitch), -1, 1);
    st.tvc += (tvcT - st.tvc) * (1 - Math.exp(-dt * 8));
    const eng = v.engines || EMPTY;
    for (let i = 0; i < 2; i++) {
      const e = eng[i] || eng[0] || NO_ENGINE;
      const ab = clamp(num(e.afterburner), 0, 1);
      const thr = clamp(num(e.throttle, num(e.n1)), 0, 1);
      // nozzle area: open at idle, closes toward MIL, opens wide in AB
      const openT = Number.isFinite(e.nozzle) && e.nozzle > 0 ? e.nozzle : clamp(0.55 - thr * 0.55, 0, 0.55) + ab * 0.9;
      st.open[i] += (clamp(openT, 0, 1.2) - st.open[i]) * (1 - Math.exp(-dt * 5));
      st.ab[i] += (ab - st.ab[i]) * (1 - Math.exp(-dt * (ab > st.ab[i] ? 10 : 6)));
      const open = st.open[i] * MAX.nozzleOpen;
      const vec = st.tvc * MAX.tvc;
      rotX(FLAP_U[i], (-vec - open) * D2R);
      rotX(FLAP_L[i], (-vec + open) * D2R);
      // glow + plume
      const g = glow[i];
      if (g) g.material.emissiveIntensity = 0.15 * thr + 5.5 * st.ab[i];
      const pl = plumes[i];
      const lvl = st.ab[i];
      pl.holder.visible = lvl > 0.02;
      if (pl.holder.visible) {
        const flick = 0.95 + 0.05 * Math.sin(st.t * 57 + i * 1.7) * Math.sin(st.t * 23.3 + i);
        const len = (0.45 + 0.55 * lvl) * flick;
        pl.group.scale.set(0.85 + 0.15 * lvl, 0.8 + 0.2 * lvl + 0.15 * st.open[i], len);
        pl.holder.rotation.x = -vec * D2R;     // plume follows the vectored flaps (TE up -> jet up)
        for (const L of pl.layers) { L.mat.uniforms.uLevel.value = L.gain * clamp(lvl * 1.2, 0, 1); L.mat.uniforms.uTime.value = st.t; }
      }
    }
    abLight.intensity = 60 * (st.ab[0] + st.ab[1]) * (0.9 + 0.1 * Math.sin(st.t * 40));

    // ---- landing gear sequence (0 = up, 1 = down)
    const gear = clamp(num(v.gear, 1), 0, 1);
    st.gear = gear;
    const doorsNose = sstep(0.0, 0.22, gear);                       // nose doors stay open when down
    const leg = sstep(0.2, 0.85, gear);
    const mainDoor = gear < 0.85 ? sstep(0.0, 0.2, gear) : 1 - sstep(0.88, 1.0, gear);   // open, then close again
    rotX('gear_door_nose_R', -doorsNose * MAX.noseDoor * D2R);
    rotX('gear_door_nose_L', doorsNose * MAX.noseDoor * D2R);
    rotX('gear_door_main_R', -mainDoor * MAX.mainDoor * D2R);
    rotX('gear_door_main_L', mainDoor * MAX.mainDoor * D2R);
    rotX('gear_nose', (1 - leg) * MAX.noseGear * D2R);
    rotX('gear_main_L', (1 - leg) * MAX.mainGear * D2R);
    rotX('gear_main_R', (1 - leg) * MAX.mainGear * D2R);
    // strut travel: gearCompression 0 = fully extended, 0.35 = static load (modelled pose), 1 = bottomed
    compArr = v.gearCompression || EMPTY;
    const ws = num(v.wheelSpeed);
    const ns = pivots.gear_nose_steer;
    if (ns) {
      ns.o.position.copy(ns.restPos).addScaledVector(noseUp, strutOff(0));
      q.setFromAxisAngle(X_AXIS, -clamp(num(v.steer), -1.3, 1.3));
      ns.o.quaternion.copy(ns.rest).multiply(q);
    }
    for (let k = 0; k < MAIN_WHEELS.length; k++) {
      const p = pivots[MAIN_WHEELS[k][0]];
      if (p) { p.o.position.copy(p.restPos); p.o.position.y += strutOff(MAIN_WHEELS[k][1]); }
    }
    for (const n of WHEELS) {
      if (!pivots[n]) continue;
      wheelAngle[n] -= (ws / (wheelR[n] || 0.4)) * dt;
      wheelAngle[n] %= Math.PI * 2;
      rotX(n, wheelAngle[n]);
    }

    // ---- canopy
    const can = clamp(num(v.canopy), 0, 1);
    st.canopy += (can - st.canopy) * (1 - Math.exp(-dt * 6));
    rotX('canopy', st.canopy * MAX.canopy * D2R);

    // ---- cockpit controls follow the inputs
    if (pivots.cockpit_stick) {
      q.setFromEuler(stickEuler.set(-ele * 12 * D2R, 0, -ail * 12 * D2R));
      pivots.cockpit_stick.o.quaternion.copy(pivots.cockpit_stick.rest).multiply(q);
    }
    const e0 = eng[0] || NO_ENGINE;
    const thr0 = clamp(num(e0.throttle ?? e0.n1), 0, 1);
    rotX('cockpit_throttle', (-(thr0 - 0.5) * 36 - clamp(num(e0.afterburner), 0, 1) * 6) * D2R);

    // ---- lights
    const L = v.lights || NO_ENGINE;
    const nav = !!L.nav, strobe = !!L.strobe, beacon = !!L.beacon;
    const tt = st.t;
    setS('light_nav_L', nav); setS('light_nav_R', nav); setS('light_tail', nav);
    const sp = tt % 1.3;
    const sflash = strobe && (sp < 0.05 || (sp > 0.14 && sp < 0.19)) ? 1 : 0;
    setS('light_strobe_L', sflash > 0, sflash); setS('light_strobe_R', sflash > 0, sflash);
    const bp = (tt + 0.4) % 1.0;
    const bflash = beacon ? Math.max(0, 1 - bp / 0.35) : 0;
    setS('light_beacon_top', bflash > 0.01, bflash); setS('light_beacon_bottom', bflash > 0.01, bflash * 0.9);
    const gearDown = leg > 0.95;
    setS('light_landing', !!L.landing && gearDown); setS('light_taxi', !!L.taxi && gearDown);
    spot.intensity = (L.landing && gearDown) ? 400 : (L.taxi && gearDown ? 120 : 0);
    for (const o of formationMeshes) o.material.emissiveIntensity = nav ? 1.6 : 0;
  }

  function setView(vw) {
    if (vw === view) return;
    view = vw;
    const inside = vw === 'cockpit';
    for (const g of glassMats) {
      g.opacity = inside ? 0.14 : 0.42;
      g.iridescence = inside ? 0.35 : 1.0;
    }
    if (interior) interior.visible = true;
    if (pilot) pilot.visible = !inside;       // the camera sits inside the pilot's helmet in cockpit view
  }

  return { object, eye, contacts, screens, bounds, update, setView };
}
