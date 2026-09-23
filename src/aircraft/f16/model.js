// F-16C Block 50 "Fighting Falcon" — model definition + runtime rig (aircraft agent f16).
// The GLB is produced by blender/aircraft/f16/build.py. Node conventions (CONTRACTS-SF.md §5.1): every animated node
// has its origin on the hinge and its local +X along the rotation axis; rotation angles are applied on top of the
// rest quaternion. Signs: positive rotation about local +X moves a trailing edge DOWN (surfaces aft of the hinge).
import * as THREE from 'three';

// URLs are resolved relative to this module so that pages outside the repo root (dev/*.html) load the same files.
const ROOT = new URL('../../../', import.meta.url).href;
export const model = {
  url: ROOT + 'assets/aircraft/f16/f16.glb',
  lodUrl: ROOT + 'assets/aircraft/f16/f16_lod.glb',
  // detailed cockpit (CONTRACTS-SF.md §6.2.1): streamed after the exterior, attached with rig.attachCockpit()
  cockpitUrl: ROOT + 'assets/aircraft/f16/f16_cockpit.glb',
  displays: {
    screen_hud: 'f16.hud',
    screen_mfd_L: 'f16.mfd.left',
    screen_mfd_R: 'f16.mfd.right',
    screen_ded: 'f16.ded',
    screen_rwr: 'f16.rwr',
  },
  thumbnail: ROOT + 'renders/aircraft/f16/thumb.jpg',
};

const D2R = Math.PI / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const approach = (cur, target, rate, dt) => cur + clamp(target - cur, -rate * dt, rate * dt);

// ---------------------------------------------------------------------------------------------------------------------
// Shared glow sprite texture (radial gradient)
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

function makeGlow(color, size) {
  const m = new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  s.renderOrder = 10;
  s.userData.baseSize = size;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// Afterburner flame: layered additive cones + shock diamonds (custom shader with log-depth support).
const FLAME_VS = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vPos;
  void main() {
    vUv = uv; vPos = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const FLAME_FS = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime; uniform float uAB; uniform float uLen; uniform vec3 uColA; uniform vec3 uColB; uniform float uGain;
  uniform float uDiamond; uniform float uSeed;
  varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vPos;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    #include <logdepthbuf_fragment>
    float t = clamp(vUv.y, 0.0, 1.0);                      // 0 at the nozzle (cylinder bottom), 1 at the tail
    float facing = abs(dot(normalize(vN), normalize(vV)));  // thick in the middle, thin at the silhouette
    float body = 0.25 + 0.75 * pow(facing, 1.3);
    float ang = atan(vPos.x, vPos.y);
    float n = noise(vec2(ang * 3.0 + uSeed, vPos.z * 2.2 - uTime * 18.0)) * 0.6 + noise(vec2(ang * 7.0, vPos.z * 5.0 - uTime * 31.0)) * 0.4;
    float fall = pow(1.0 - t, 0.85) * (0.65 + 0.7 * n);
    float d = 0.0;
    if (uDiamond > 0.0) { float k = fract(vPos.z / uDiamond + 0.15); d = pow(1.0 - abs(k * 2.0 - 1.0), 6.0) * smoothstep(0.95, 0.2, t); }
    vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.8, t));
    float a = body * fall * uGain * uAB + d * uAB * 1.6;
    gl_FragColor = vec4(col * a, a);
  }`;

function flameMaterial(colA, colB, gain, diamond, seed) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uAB: { value: 0 }, uLen: { value: 1 }, uColA: { value: new THREE.Color(colA) }, uColB: { value: new THREE.Color(colB) },
      uGain: { value: gain }, uDiamond: { value: diamond }, uSeed: { value: seed },
    },
    vertexShader: FLAME_VS, fragmentShader: FLAME_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: false,
  });
}

function flameCone(r0, r1, len, mat) {
  // Open cone along +Z (aft), starting at z=0 (nozzle exit)
  const g = new THREE.CylinderGeometry(r1, r0, len, 40, 16, true);
  g.rotateX(Math.PI / 2);          // cylinder axis Y -> Z ; top (r1) goes to +Z
  g.translate(0, 0, len / 2);
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 11;
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

function diamondMesh(r, len, mat) {
  const pts = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const rr = r * Math.sin(Math.PI * t) ** 0.9;
    pts.push(new THREE.Vector2(Math.max(rr, 0.0001), (t - 0.5) * len));
  }
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 12;
  m.frustumCulled = false;
  return m;
}

function createAfterburner() {
  const group = new THREE.Group();
  group.name = 'ab_flame';
  const outer = flameMaterial(0xff8a3a, 0xb03a10, 0.75, 0, 1.3);
  const mid = flameMaterial(0xffc070, 0xff6a20, 1.05, 0, 4.1);
  const core = flameMaterial(0xfff0d8, 0xffb070, 1.4, 0.58, 7.7);
  const diamond = flameMaterial(0xfffae0, 0xffd090, 2.2, 0, 2.2);
  const layers = [
    { mesh: flameCone(0.42, 0.16, 1, outer), len: 4.4 },
    { mesh: flameCone(0.34, 0.08, 1, mid), len: 3.0 },
    { mesh: flameCone(0.25, 0.04, 1, core), len: 2.2 },
  ];
  for (const l of layers) group.add(l.mesh);
  const diamonds = [];
  for (let i = 0; i < 5; i++) {
    const d = diamondMesh(0.15 - i * 0.017, 0.42 - i * 0.03, diamond);
    d.position.z = 0.36 + i * 0.55;
    group.add(d);
    diamonds.push(d);
  }
  // heat glow disc inside the nozzle (visible in dry thrust too)
  const glowMat = flameMaterial(0xff7a30, 0xff3a08, 1.0, 0, 9.9);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.40, 40), glowMat);
  glow.position.z = -0.35;
  glow.renderOrder = 10;
  group.add(glow);
  const mats = [outer, mid, core, diamond];
  return {
    group, layers, diamonds, mats, glow, glowMat,
    update(time, ab, n1, nozzleR) {
      const on = ab > 0.01;
      for (const l of layers) {
        l.mesh.visible = on;
        const L = l.len * (0.35 + 0.65 * ab) * (0.94 + 0.08 * Math.sin(time * 37.0 + l.len));
        l.mesh.scale.set(nozzleR / 0.44, nozzleR / 0.44, L);
      }
      for (let i = 0; i < diamonds.length; i++) {
        const d = diamonds[i];
        d.visible = on && ab > 0.15 + i * 0.12;
        const s = (0.8 + 0.25 * Math.sin(time * 53 + i * 1.7)) * (0.6 + 0.4 * ab);
        d.scale.set(s, s, 1);
      }
      for (const m of mats) { m.uniforms.uTime.value = time; m.uniforms.uAB.value = ab; }
      diamond.uniforms.uAB.value = ab * (0.85 + 0.15 * Math.sin(time * 71));
      // glow: faint in dry thrust, bright with AB
      glowMat.uniforms.uTime.value = time;
      glowMat.uniforms.uAB.value = clamp(0.08 + 0.35 * n1 * n1 + 1.2 * ab, 0, 1.5);
      glow.visible = n1 > 0.05 || on;
      glow.scale.setScalar(nozzleR / 0.44);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Canopy glass: cheap premultiplied-alpha glass with a gold ITO reflection tint (avoids the transmission render pass,
// which would re-render the whole city every frame).
function canopyGlassMaterial(src) {
  const m = new THREE.MeshPhysicalMaterial({
    name: 'canopy_glass_rt',
    color: new THREE.Color(0.30, 0.215, 0.075),
    metalness: 0.0,
    roughness: 0.035,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    side: THREE.DoubleSide,
    specularColor: new THREE.Color(1.0, 0.80, 0.42),
    specularIntensity: 1.0,
    ior: 1.75,
    envMapIntensity: 1.6,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <opaque_fragment>', `
        vec3 spec = gl_FrontFacing ? totalSpecular : totalSpecular * 0.22;   // weaker reflections seen from inside
        gl_FragColor = vec4( totalDiffuse * diffuseColor.a + spec + totalEmissiveRadiance, diffuseColor.a );`)
      .replace('#include <premultiplied_alpha_fragment>', '');
  };
  m.premultipliedAlpha = true;
  m.customProgramCacheKey = () => 'f16-canopy-glass';
  if (src && src.envMap) m.envMap = src.envMap;
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
export function createRig(gltfScene) {
  const object = new THREE.Group();
  object.name = 'F16_rig';
  object.add(gltfScene);
  object.updateMatrixWorld(true);

  const byName = (n) => gltfScene.getObjectByName(n);
  const nodes = {};
  gltfScene.traverse((o) => { if (o.name) nodes[o.name] = o; });

  // animated node helper: remember the rest quaternion; set(angle) rotates about local +X
  const tmpQ = new THREE.Quaternion();
  const anim = (name) => {
    const n = nodes[name];
    if (!n) return null;
    return { node: n, rest: n.quaternion.clone(), restPos: n.position.clone(), data: n.userData || {}, cur: 0 };
  };
  const setRot = (a, angle) => { if (a) { a.node.quaternion.copy(a.rest).multiply(tmpQ.setFromAxisAngle(X_AXIS, angle)); a.cur = angle; } };

  const S = {
    flapR: anim('ctl_flaperon_R'), flapL: anim('ctl_flaperon_L'),
    lefR: anim('ctl_lef_R'), lefL: anim('ctl_lef_L'),
    stabR: anim('ctl_stabilator_R'), stabL: anim('ctl_stabilator_L'),
    rudder: anim('ctl_rudder'),
    sbRu: anim('speedbrake_R_upper'), sbRl: anim('speedbrake_R_lower'),
    sbLu: anim('speedbrake_L_upper'), sbLl: anim('speedbrake_L_lower'),
    canopy: anim('canopy'),
  };
  const legs = ['gear_nose', 'gear_main_L', 'gear_main_R'].map(anim).filter(Boolean);
  const braces = ['gear_brace_L', 'gear_brace_R'].map((n) => nodes[n]).filter(Boolean);   // fixed braces: hidden in transit
  const twists = ['gear_nose_twist', 'gear_main_L_twist', 'gear_main_R_twist'].map(anim);
  const doors = [];
  for (const n of Object.keys(nodes)) if (n.startsWith('gear_door_')) doors.push(anim(n));
  const wheels = [
    { a: anim('wheel_nose'), r: 0.212 },
    { a: anim('wheel_main_L'), r: 0.325 },
    { a: anim('wheel_main_R'), r: 0.325 },
  ].filter((w) => w.a);
  const petals = [];
  for (const n of Object.keys(nodes)) if (n.startsWith('nozzle_petal_')) petals.push(anim(n));

  // ---- eye, contacts, bounds
  const wpos = (n) => { const o = nodes[n]; return o ? o.getWorldPosition(new THREE.Vector3()) : null; };
  const eye = { pilot: wpos('eye_pilot') || new THREE.Vector3(0, 0.92, -4.48) };
  const contacts = [
    { name: 'contact_nose', position: wpos('contact_nose') || new THREE.Vector3(0, -1.9, -3.48), kind: 'nose' },
    { name: 'contact_main_L', position: wpos('contact_main_L') || new THREE.Vector3(-1.18, -1.9, 0.51), kind: 'main' },
    { name: 'contact_main_R', position: wpos('contact_main_R') || new THREE.Vector3(1.18, -1.9, 0.51), kind: 'main' },
  ];
  const screens = {};
  const collectScreens = (root) => {
    const named = {};
    root.traverse((o) => { if (o.name) named[o.name] = o; if (o.isMesh && o.name.startsWith('screen_')) screens[o.name] = o; });
    // multi-primitive nodes: the screen mesh may be a child of the named node
    for (const n of Object.keys(named)) if (n.startsWith('screen_') && !screens[n]) {
      const m = named[n].isMesh ? named[n] : named[n].children.find((c) => c.isMesh);
      if (m) screens[n] = m;
    }
  };
  collectScreens(gltfScene);
  const box = new THREE.Box3().setFromObject(gltfScene);
  const size = box.getSize(new THREE.Vector3());
  const bounds = { length: size.z, span: size.x, height: size.y, radius: size.length() / 2 };

  // ---- materials: canopy glass replacement; lamp lens; formation lights
  const glassMeshes = [];
  const navLensMats = [];
  let lensMat = null;
  const exteriorGlass = [];   // HUD rear plate: never casts shadows
  gltfScene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m, i) => {
      if (!m) return;
      if (m.name === 'canopy_glass') {
        const g = canopyGlassMaterial(m);
        if (Array.isArray(o.material)) o.material[i] = g; else o.material = g;
        glassMeshes.push(o);
        o.renderOrder = 5;
      }
      if (m.name === 'lamp_lens') { lensMat = m; m.emissive = new THREE.Color(1, 0.95, 0.85); m.emissiveIntensity = 0; }
      if (m.name.startsWith('navlens_')) {
        const c = m.name === 'navlens_red' ? [1, 0.06, 0.03] : m.name === 'navlens_green' ? [0.1, 1, 0.3] : [1, 1, 1];
        m.emissive = new THREE.Color(...c); m.emissiveIntensity = 0; navLensMats.push(m);
      }
      if (m.name === 'hud_glass') exteriorGlass.push(o);
    });
  });

  // ---- afterburner, heat glow
  const nozzle = nodes['nozzle_1'];
  const ab = createAfterburner();
  if (nozzle) nozzle.add(ab.group); else object.add(ab.group);

  // ---- lights
  const lightNodes = {};
  const addGlow = (nodeName, color, size) => {
    const n = nodes[nodeName];
    if (!n) return null;
    const s = makeGlow(color, size);
    n.add(s);
    lightNodes[nodeName] = s;
    return s;
  };
  const navL = addGlow('light_nav_L', 0xff2a1a, 0.42);
  const navR = addGlow('light_nav_R', 0x2aff5a, 0.42);
  const tail = addGlow('light_tail', 0xffffff, 0.36);
  const strobe = addGlow('light_strobe_top', 0xffffff, 1.6);
  const formL = addGlow('light_formation_L', 0x7dff9a, 0.28);
  const formR = addGlow('light_formation_R', 0x7dff9a, 0.28);
  const landGlow = addGlow('light_landing', 0xfff4e0, 0.45);
  const taxiGlow = addGlow('light_taxi', 0xfff4e0, 0.35);
  const spot = new THREE.SpotLight(0xfff2dd, 0, 700, 13 * D2R, 0.45, 1.6);
  spot.castShadow = false;
  const landNode = nodes['light_landing'];
  if (landNode) {
    landNode.add(spot);
    spot.position.set(0, 0, 0);
    const target = new THREE.Object3D();
    target.position.set(0, -0.35, -30);     // forward (-Z) and slightly down
    landNode.add(target);
    spot.target = target;
  } else {
    object.add(spot);
  }

  // ---- state
  const st = { gear: 1, t: 0, view: 'exterior', nozzleOpen: 0.5, lef: 0 };

  function update(dt, v) {
    dt = Math.min(dt || 0, 0.1);
    st.t += dt;
    const t = v.time ?? st.t;
    // --- flight controls
    const ail = clamp(v.aileron ?? 0, -1, 1);
    const ele = clamp(v.elevator ?? 0, -1, 1);
    const rud = clamp(v.rudder ?? 0, -1, 1);
    const flaps = clamp(v.flaps ?? 0, 0, 1);
    // flaperons: + angle = TE down. Right TE up on right roll.
    setRot(S.flapR, clamp(flaps * 20 - ail * 21.5, -23, 23) * D2R);
    setRot(S.flapL, clamp(flaps * 20 + ail * 21.5, -23, 23) * D2R);
    // stabilators: nose-up -> TE up (negative); differential for roll
    setRot(S.stabR, clamp(-ele * 25 - ail * 5, -25, 25) * D2R);
    setRot(S.stabL, clamp(-ele * 25 + ail * 5, -25, 25) * D2R);
    // rudder: yaw right -> TE right (negative about the up-pointing hinge)
    setRot(S.rudder, -rud * 30 * D2R);
    // leading-edge flaps: scheduled droop (slats if provided, else AoA / gear schedule)
    // the fixed-wing model provides the F-16 LEF schedule in v.slats (0..1 of 25 deg); fallback: AoA (rad) schedule
    const aoaDeg = (v.aoa ?? 0) * (180 / Math.PI);
    const lefTarget = typeof v.slats === 'number' ? clamp(v.slats, 0, 1) : clamp((1.38 * aoaDeg + 1.45) / 25, 0, 1);
    st.lef = approach(st.lef, lefTarget, 1.5, dt);
    setRot(S.lefR, -st.lef * 25 * D2R);
    setRot(S.lefL, -st.lef * 25 * D2R);
    // speedbrakes
    const sb = clamp(v.speedbrake ?? 0, 0, 1) * ((v.gear ?? 0) > 0.5 ? 43 / 58 : 1);
    for (const a of [S.sbRu, S.sbRl, S.sbLu, S.sbLl]) if (a) setRot(a, sb * (a.data.open_angle ?? 1));
    // canopy
    if (S.canopy) setRot(S.canopy, clamp(v.canopy ?? 0, 0, 1) * (S.canopy.data.open_angle ?? 0.66));

    // --- landing gear sequence: doors open (0..0.2) -> legs swing (0.15..0.85) -> doors close (0.8..1)
    const g = clamp(v.gear ?? 1, 0, 1);
    const retract = 1 - smooth(0.15, 0.85, g);
    for (const a of legs) setRot(a, (a.data.retract_angle ?? 0) * retract);
    for (const b of braces) b.visible = retract < 0.02;
    const comp = v.gearCompression || null;
    const steer = clamp(v.steer ?? 0, -1.3, 1.3) * (1 - retract);      // nose-wheel angle (rad, + = right)
    for (let i = 0; i < twists.length; i++) {
      const a = twists[i];
      if (!a) continue;
      // retraction twist (wheel lies flat when stowed) + nose-wheel steering about the strut axis (local +X = down)
      setRot(a, (a.data.twist_angle ?? 0) * smooth(0.0, 0.7, retract) + (i === 0 ? steer : 0));
      // oleo: gearCompression 0 = fully extended, 0.35 = static (modelled pose), 1 = bottomed
      const c = comp && comp[i] != null ? clamp(comp[i], 0, 1) : 0.35;
      const travel = i === 0 ? 0.20 : 0.24;
      a.node.position.copy(a.restPos);
      a.node.position.addScaledVector(tmpV.set(1, 0, 0).applyQuaternion(a.rest), (0.35 - c) * travel * (1 - retract));
    }
    const doorOpen = smooth(0.0, 0.2, g) - smooth(0.8, 1.0, g) + (g <= 0 ? 0 : 0);
    for (const a of doors) {
      if (!a) continue;
      const seq = a.data.sequence || 'cycle';
      const k = seq === 'leg' ? 1 - retract : doorOpen;
      setRot(a, (a.data.open_angle ?? 0) * clamp(k, 0, 1));
    }
    // wheels
    const ws = v.wheelSpeed ?? 0;
    for (const w of wheels) {
      w.a.cur -= (ws / w.r) * dt;
      w.a.node.quaternion.copy(w.a.rest).multiply(tmpQ.setFromAxisAngle(X_AXIS, w.a.cur));
    }

    // --- engine: nozzle area + afterburner + heat glow
    const e = (v.engines && v.engines[0]) || { n1: 0.3, throttle: 0.3, afterburner: 0 };
    const abv = clamp(e.afterburner ?? 0, 0, 1);
    const n1 = clamp(e.n1 ?? e.throttle ?? 0, 0, 1);
    // nozzle area 0 (closed, MIL) .. 1 (full open, max AB); idle is open. Physics provides engines[i].nozzle.
    const nozTarget = typeof e.nozzle === 'number' ? clamp(e.nozzle, 0, 1)
      : (abv > 0.01 ? 0.3 + 0.7 * abv : clamp(0.85 - n1, 0, 1) * 0.85);
    st.nozzleOpen = approach(st.nozzleOpen, nozTarget, 1.2, dt);
    for (const a of petals) setRot(a, (a.data.open_angle ?? 0.13) * st.nozzleOpen);
    const nozR = 0.44 + 0.09 * st.nozzleOpen;
    ab.update(t, abv, n1, nozR);

    // --- lights
    const L = v.lights || {};
    if (navL) navL.visible = navR.visible = tail.visible = !!L.nav;
    if (formL) formL.visible = formR.visible = !!L.nav;
    if (strobe) {
      const ph = (t % 1.2);
      const on = !!L.strobe && (ph < 0.05 || (ph > 0.12 && ph < 0.17));
      strobe.visible = on;
    }
    const gearDown = g > 0.95;
    const landOn = !!L.landing && gearDown;
    const taxiOn = !!L.taxi && gearDown;
    spot.intensity = landOn ? 900 : taxiOn ? 300 : 0;
    if (landGlow) landGlow.visible = landOn;
    if (taxiGlow) taxiGlow.visible = taxiOn || landOn;
    if (lensMat) lensMat.emissiveIntensity = landOn || taxiOn ? 6 : 0;
    for (const m of navLensMats) m.emissiveIntensity = L.nav ? 3 : 0;

    // shadows: glass & effects must never cast (the host enables castShadow on every mesh after createRig)
    for (const m of glassMeshes) if (m.castShadow) m.castShadow = false;
    for (const m of exteriorGlass) if (m.castShadow) m.castShadow = false;
  }
  const tmpV = new THREE.Vector3();

  // ---- detailed cockpit (second GLB, root node 'interior', same frame as the exterior) + light stand-in
  let interior = nodes.interior || null;            // wave-5 GLBs carried the interior inside the exterior file
  const interiorLite = nodes.interior_lite || null;
  let cockpitReady = !!interior && !interiorLite;
  function applyView() {
    const cockpit = st.view === 'cockpit';
    // the pilot's head and torso would enclose the camera: hide them in the cockpit view (hands/knees stay visible)
    if (nodes.pilot_helmet) nodes.pilot_helmet.visible = !cockpit;
    if (nodes.interior_lod) nodes.interior_lod.visible = false;
    const detailed = cockpit && cockpitReady && !!interior;
    if (interior) interior.visible = detailed;
    if (interiorLite) interiorLite.visible = !detailed;
  }
  function setView(view) {
    if (view === st.view) return;
    st.view = view;
    applyView();
  }
  function attachCockpit(cockpitScene) {
    if (!cockpitScene) return;
    const root = cockpitScene.getObjectByName('interior') || cockpitScene;
    if (interior && interior !== root && interior.parent) interior.parent.remove(interior);
    // the cockpit GLB is exported in the exterior's frame (origin = CG): no offset, just parent it next to the exterior
    gltfScene.add(cockpitScene);
    cockpitScene.updateMatrixWorld(true);
    interior = root;
    collectScreens(cockpitScene);
    cockpitScene.traverse((o) => {
      if (o.name && !nodes[o.name]) nodes[o.name] = o;
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) if (m && m.name === 'hud_glass') exteriorGlass.push(o);
    });
    cockpitReady = true;
    rig.cockpitReady = true;
    applyView();
  }

  // initial pose: gear down, everything neutral
  update(0, { gear: 1, engines: [{ n1: 0, afterburner: 0 }], lights: {} });
  applyView();

  const rig = { object, eye, contacts, screens, bounds, update, setView, attachCockpit, cockpitReady, nodes };
  return rig;
}
