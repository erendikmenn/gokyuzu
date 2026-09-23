// W4 airports: emissive light points (runway/taxiway/approach lights, PAPI, flashers, beacons, floodlights).
// One instanced camera-facing quad per light, custom shader (log depth, tone mapping), additive blending.
// Directional lights fade outside their beam; PAPI units switch red/white with the viewer's elevation angle.
import * as THREE from 'three';
import { SKY_STATE } from './environment.js';
import { WATER_STREAK_GLSL, STREAK_FS } from './lights.js';

// type table (index = light type id from tools/geo/airports_build.py)
// [r, g, b (linear HDR), glow size m, day intensity, beam half-angle deg (0 = omni), kind]
// kind: 0 steady, 1 sequenced flasher, 2 PAPI, 3 wig-wag, 4 rotating beacon, 5 slow flash (obstruction)
const W = [1.0, 0.93, 0.78], Y = [1.0, 0.72, 0.18], R = [1.0, 0.07, 0.04], G = [0.12, 1.0, 0.38], B = [0.1, 0.22, 1.0];
export const LIGHT_TYPES = [
  [...W, 1.1, 0.18, 0, 0],      // 0 EDGE_W (omni)
  [...Y, 1.1, 0.2, 75, 0],      // 1 EDGE_Y (directional)
  [...W, 0.75, 0.12, 70, 0],    // 2 CL_W
  [...R, 0.75, 0.12, 70, 0],    // 3 CL_R
  [...W, 0.8, 0.12, 60, 0],     // 4 TDZ
  [...G, 1.1, 0.16, 70, 0],     // 5 THR_G
  [...R, 1.1, 0.16, 70, 0],     // 6 END_R
  [...W.map((v) => v * 0.8), 1.3, 0.45, 40, 0],     // 7 APP_W
  [...R, 1.3, 0.40, 40, 0],     // 8 APP_R
  [1.0, 1.0, 1.0, 3.2, 1.4, 45, 1],  // 9 SFL (sequenced flasher)
  [...W, 1.6, 0.9, 30, 2],      // 10 PAPI
  [...B.map((v) => v * 0.6), 0.5, 0.10, 0, 0],     // 11 TWY_B
  [...G.map((v) => v * 0.55), 0.45, 0.08, 0, 0],      // 12 TWY_G
  [...Y, 1.0, 0.9, 50, 3],      // 13 RGL (wig-wag)
  [...R, 1.4, 0.35, 0, 0],      // 14 OBS (steady red)
  [0.3, 1.0, 0.5, 4.0, 0.7, 0, 4],   // 15 BEACON
  [1.0, 0.82, 0.55, 5.5, 0.0, 0, 0], // 16 FLOOD
  [...R, 0.6, 0.2, 60, 0],      // 17 STOP
  [...Y, 0.7, 0.3, 0, 0],       // 18 HELI_Y
  [...G, 0.7, 0.3, 0, 0],       // 19 HELI_G
  [...R, 1.8, 0.8, 0, 5],       // 20 OBS_FL
  [...W, 1.1, 0.18, 75, 0],     // 21 EDGE_WD (directional white)
];

const VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iCol;      // rgb, size
attribute vec4 iDir;      // dir xyz (unit, horizontal-ish), cos(beam)  (w <= -1: omni)
attribute vec4 iPar;      // kind, phase, papi angle (deg), day intensity
uniform float uTime, uDay, uPxScale, uMinPx, uGain, uFogDensity, uFarFade, uWet, uPlaneY;
uniform vec2 uViewport;
varying vec3 vCol; varying vec2 vQ; varying float vSeed;
${WATER_STREAK_GLSL}
void main() {
  vec3 wp = (modelMatrix * vec4(iPos, 1.0)).xyz;
  vSeed = fract(iPos.x * 0.137 + iPos.z * 0.311);
  vec3 toCam = normalize(cameraPosition - wp);
  float dist0 = max(length(cameraPosition - wp), 0.1);
  // pull the sprite toward the camera by ~its world radius so the quad does not cut into the pavement
  float rw = max(iCol.w, uMinPx * 3.0 * dist0 / uPxScale);
#ifdef SF_MIRROR
  // time & weather: reflection streak on the bay (approach lights on piers, shoreline lights), lying on the water
  // (lights.js WATER_STREAK_GLSL); land in front hides it through the depth test
  float sDist, graze, sNat;
  // wet pavement (rain): the lights reflect in the runway itself; dry: only on the bay
  vec3 sp = sfWaterStreakAt(wp, position.xy, iCol.w, uPxScale, uMinPx * 1.6, uWet > 0.5 ? uPlaneY : 0.0, sDist, graze, sNat);
  vec4 mv = viewMatrix * vec4(sp, 1.0);
#else
  vec4 mv = viewMatrix * vec4(wp + toCam * min(rw + 0.08 * dist0, dist0 * 0.5), 1.0);
#endif
  float dist = max(-mv.z, 0.1);
  float I = mix(1.0, iPar.w * 0.55, uDay);
  vec3 col = iCol.rgb;
  float kind = iPar.x;
  if (iDir.w > -1.0) {
    vec3 d = iDir.xyz;
    float c = dot(normalize(vec3(toCam.x, 0.0, toCam.z)), d);
    I *= smoothstep(iDir.w - 0.15, iDir.w + 0.2, c);
    // vertical beam: most lights visible from 0..25 deg above
    I *= smoothstep(-0.05, 0.02, toCam.y) * (1.0 - smoothstep(0.55, 0.9, toCam.y) * 0.8);
  }
  if (kind > 0.5 && kind < 1.5) {            // sequenced flasher: 2 sweeps / s, 40 ms flash
    float t = fract(uTime * 2.0 - iPar.y * 0.5);
    I *= (t < 0.08 ? mix(6.0, 3.0, uDay) : 0.0);
  } else if (kind > 1.5 && kind < 2.5) {     // PAPI
    float el = degrees(asin(clamp(toCam.y, -1.0, 1.0)));
    float w = smoothstep(iPar.z - 0.06, iPar.z + 0.06, el);
    col = mix(vec3(1.0, 0.03, 0.02), vec3(1.0, 0.95, 0.85), w);
  } else if (kind > 2.5 && kind < 3.5) {     // wig-wag
    I *= 0.08 + 1.1 * step(0.5, fract(uTime * 0.8 + iPar.y));
  } else if (kind > 3.5 && kind < 4.5) {     // rotating beacon: green / white alternating, ~12 rpm, 2 beams
    float a = atan(toCam.x, toCam.z) / 6.2831853;
    float ph = fract(uTime * 0.2 + a);
    float beam = exp(-pow((ph - 0.25) * 18.0, 2.0)) + exp(-pow((ph - 0.75) * 18.0, 2.0));
    col = ph < 0.5 ? vec3(0.2, 1.0, 0.45) : vec3(1.0, 0.95, 0.9);
    I *= 0.15 + 3.0 * beam;
  } else if (kind > 4.5) {                   // obstruction flash 40/min
    I *= 0.05 + 1.2 * step(0.65, fract(uTime * 0.667 + iPar.y));
  }
  float natural = iCol.w * uPxScale / dist * mix(1.3, 0.5, uDay);
  float px = clamp(natural, uMinPx * mix(2.1, 1.6, uDay), uMinPx * mix(12.0, 5.0, uDay));
  I *= mix(0.35, 1.0, clamp(natural / uMinPx, 0.0, 1.0));
  I *= exp(-uFogDensity * dist) * (1.0 - smoothstep(uFarFade * 0.7, uFarFade, dist));
  vCol = col * I * uGain;
  vec2 corner = position.xy;
  vQ = corner;
#ifdef SF_MIRROR
  if (kind > 1.5 && kind < 2.5) I = 0.0;   // no PAPI reflections
  vCol *= (0.03 + 0.35 * (0.02 + 0.98 * pow(1.0 - graze, 5.0))) * (1.0 - uDay * 0.85);
  // dry: from the ground the reflection points fall on the pavement / shore, so only from the approach or higher;
  // wet: the runway mirrors its lights at every height (strong at grazing angles)
  vCol *= uWet > 0.5 ? 1.4 : smoothstep(25.0, 60.0, cameraPosition.y);
  gl_Position = projectionMatrix * mv;
#else
  // lower half of the glow squashed (light sits on / spills onto the pavement instead of being cut by it)
  if (corner.y < 0.0) corner.y *= 0.35;
  gl_Position = projectionMatrix * mv;
  gl_Position.xy += corner * px / uViewport * 2.0 * gl_Position.w;
#endif
  if (I < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
varying vec3 vCol; varying vec2 vQ; varying float vSeed;
void main() {
#ifdef SF_MIRROR
  ${STREAK_FS}
  vec3 outc = vCol * c;
#else
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 18.0);
  float halo = exp(-r2 * 4.5) * 0.16;
  vec3 outc = vCol * (core * 2.0 + halo);
#endif
  gl_FragColor = vec4(outc, 1.0);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Create the light sprites of one airport. A = arrays from <icao>.bin. */
export function buildLights(meta, A, ctx) {
  const { terrain } = ctx;
  const [ox, oz] = meta.origin;
  const P = A['lights.pos'], T = A['lights.type'], H = A['lights.hdg'], PR = A['lights.param'], M = A['lights.mode'];
  if (!P) return null;
  const n = T.length;
  const iPos = new Float32Array(n * 3), iCol = new Float32Array(n * 4), iDir = new Float32Array(n * 4), iPar = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = P[3 * i], zz = P[3 * i + 1], h = P[3 * i + 2];
    const g = terrain.getHeight(x + ox, zz + oz);
    const water = terrain.isWater && terrain.isWater(x + ox, zz + oz);
    const mode = M[i];
    const y = mode === 0 ? g + h : mode === 1 ? h : Math.max(h, (water ? 0 : g) + 0.1);
    iPos[3 * i] = x; iPos[3 * i + 1] = y; iPos[3 * i + 2] = zz;
    const t = LIGHT_TYPES[T[i]] || LIGHT_TYPES[0];
    // time & weather: taxiway edge/centreline lights are far weaker than runway lights (a few cd vs hundreds);
    // at night full strength they washed the field cyan
    const tw = T[i] === 11 || T[i] === 12 ? 0.45 : 1;
    iCol.set([t[0] * tw, t[1] * tw, t[2] * tw, t[3]], 4 * i);
    const hd = H[i];
    if (hd >= 0 && t[5] > 0) {
      const r = hd * Math.PI / 180;
      iDir.set([Math.sin(r), 0, -Math.cos(r), Math.cos(t[5] * Math.PI / 180)], 4 * i);
    } else iDir.set([0, 0, 0, -2], 4 * i);
    iPar.set([t[6], PR[i], PR[i], t[4]], 4 * i);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(iCol, 4));
  geo.setAttribute('iDir', new THREE.InstancedBufferAttribute(iDir, 4));
  geo.setAttribute('iPar', new THREE.InstancedBufferAttribute(iPar, 4));
  geo.instanceCount = n;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), (meta.radius || 3000) + 1500);
  const mat = new THREE.ShaderMaterial({
    name: 'apt-lights',
    vertexShader: VS, fragmentShader: FS,
    uniforms: {
      uTime: { value: 0 }, uDay: { value: 1 }, uPxScale: { value: 800 }, uMinPx: { value: 1.6 }, uGain: { value: 1 },
      uViewport: { value: new THREE.Vector2(1440, 900) }, uFogDensity: { value: 0 }, uFarFade: { value: 30000 },
      uWet: { value: 0 }, uPlaneY: { value: (meta.elevation != null ? +meta.elevation : 3) + 0.05 },
    },
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `apt-lights-${meta.icao}`;
  // time & weather: water reflections of the lights (same geometry and uniforms, SF_MIRROR variant)
  const mirror = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    name: 'apt-lights-mirror', defines: { SF_MIRROR: 1 }, vertexShader: VS, fragmentShader: FS, uniforms: mat.uniforms,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: true, side: THREE.DoubleSide,
  }));
  mirror.name = `apt-lights-mirror-${meta.icao}`;
  mirror.frustumCulled = false;
  mirror.renderOrder = 9;
  mirror.visible = false;
  mesh.add(mirror);
  mesh.userData.mirror = mirror;
  const hs = new Float32Array(n), ms = new Uint8Array(n);
  for (let i = 0; i < n; i++) { hs[i] = P[3 * i + 2]; ms[i] = M[i]; }
  mesh.userData.heights = hs;
  mesh.userData.modes = ms;
  mesh.position.set(ox, 0, oz);
  mesh.renderOrder = 9;   // time & weather: before the fog bank top (10), so fog hides lights below it
  mesh.frustumCulled = true;
  return mesh;
}

const _v2 = new THREE.Vector2();
/** Per-frame uniforms shared by every light mesh. */
export function updateLights(meshes, { time, day, camera, renderer, scene }) {
  if (!meshes.length) return;
  renderer.getDrawingBufferSize(_v2);
  const pxScale = _v2.y * (camera.zoom || 1) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  // extinction from the weather visibility (time & weather, environment.js SKY_STATE); ~70 km on a clear day
  // bright point lights stay visible well beyond the visibility of unlit objects (Allard's law): ~0.55x the extinction
  const dens = SKY_STATE.live ? SKY_STATE.extinction * 0.55 : 4.5e-5;
  void scene;
  for (const m of meshes) {
    const u = m.material.uniforms;
    u.uTime.value = time;
    u.uDay.value = day;
    u.uPxScale.value = pxScale;
    u.uMinPx.value = 1.5 * _v2.y / 900;
    u.uViewport.value.copy(_v2);
    u.uFogDensity.value = dens;
    // night exposure is raised (eye adaptation, environment.js): keep the lights at their designed brightness
    u.uGain.value = SKY_STATE.live ? Math.pow(SKY_STATE.exposureComp, 0.85) : 1;
    u.uWet.value = SKY_STATE.wet;
    if (m.userData.mirror) m.userData.mirror.visible = (day < 0.95 || SKY_STATE.wet > 0.5) && m.visible;
  }
}
