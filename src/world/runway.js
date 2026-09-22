// Runway: asphalt surface (exactly RUNWAY.length × RUNWAY.width) with anti-aliased markings drawn
// in the fragment shader (edge lines, centerline dashes, threshold "piano keys", touchdown-zone and
// aiming-point bars, tire rubber), designators "36" (south end) / "18" (north end) from a canvas
// texture, plus edge / threshold / end lights and a PAPI for runway 36.
import * as THREE from 'three';
import { RUNWAY } from '../config.js';
import { makeAsphaltTexture, makeRunwayNumbersTexture } from './textures.js';

const LIGHT_EDGE = new THREE.Color(3.0, 2.8, 2.2);
const LIGHT_GREEN = new THREE.Color(0.3, 3.0, 0.8);
const LIGHT_RED = new THREE.Color(3.2, 0.25, 0.2);
const LIGHT_WHITE = new THREE.Color(3.2, 3.2, 3.0);

export function createRunway(renderer, camera0) {
  const W = RUNWAY.width, L = RUNWAY.length;
  const y0 = RUNWAY.elevation + 0.04;
  const group = new THREE.Group();
  group.name = 'runway';

  // ---- surface --------------------------------------------------------------------------
  const asphalt = makeAsphaltTexture(renderer);
  asphalt.repeat.set(W / 7, L / 7);
  const numbers = makeRunwayNumbersTexture();
  const mat = new THREE.MeshStandardMaterial({
    map: asphalt,
    roughness: 0.88,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNumbers = { value: numbers };
    shader.uniforms.uRw = { value: new THREE.Vector2(W, L) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRw;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRw = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vRw;
        uniform sampler2D uNumbers;
        uniform vec2 uRw;
        float band(float v, float a, float b, float fw) {
          return smoothstep(a - fw, a + fw, v) * (1.0 - smoothstep(b - fw, b + fw, v));
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float x = (vRw.x - 0.5) * uRw.x;      // across, meters (+X = east)
          float s = vRw.y * uRw.y;              // along, meters from the south threshold
          float north = step(uRw.y * 0.5, s);
          if (north > 0.5) { s = uRw.y - s; x = -x; }
          float ax = abs(x);
          float fx = max(fwidth(x), 0.002) * 0.8;
          float fs = max(fwidth(s), 0.002) * 0.8;
          float halfW = uRw.x * 0.5;
          float paint = 0.0;
          // edge lines
          paint = max(paint, band(ax, halfW - 1.5, halfW - 0.6, fx));
          // centerline dashes (30 m stripe, 20 m gap)
          float ph = mod(s - 80.0, 50.0);
          paint = max(paint, band(ax, -1.0, 0.45, fx) * band(ph, 0.0, 30.0, fs) * step(80.0, s));
          // threshold piano keys: 6 stripes each side, 1.8 m wide, 1.8 m gaps
          if (s > 6.0 && s < 36.0) {
            float k = ax - 2.0;
            float m = mod(k, 3.6);
            float key = band(m, 0.0, 1.8, fx) * step(0.0, k) * step(k, 21.0 - 1.8 + 0.01);
            paint = max(paint, key * band(s, 6.0, 36.0, fs));
          }
          // runway designator
          if (s > 44.0 && s < 70.0 && ax < 10.0) {
            vec2 nuv = vec2((x + 10.0) / 20.0 * 0.5 + north * 0.5, (s - 45.0) / 24.0);
            paint = max(paint, texture2D(uNumbers, nuv).a);
          }
          // touchdown zone bars (3/2/1 pairs) and aiming point
          float tdz = 0.0;
          float b1 = band(ax, 6.0, 7.8, fx), b2 = band(ax, 9.3, 11.1, fx), b3 = band(ax, 12.6, 14.4, fx);
          tdz = max(tdz, band(s, 150.0, 172.5, fs) * (b1 + b2 + b3));
          tdz = max(tdz, band(s, 450.0, 472.5, fs) * (b1 + b2));
          tdz = max(tdz, band(s, 600.0, 622.5, fs) * b1);
          tdz = max(tdz, band(s, 300.0, 345.0, fs) * band(ax, 6.5, 14.0, fx));
          paint = max(paint, tdz);
          // paint wear
          float wear = 0.82 + 0.18 * texture2D(map, vMapUv * 3.1).r * 2.0;
          vec3 paintCol = vec3(0.86, 0.86, 0.83) * wear;
          // tire rubber in the touchdown areas
          float rub = band(s, 110.0, 560.0, 40.0) * band(ax, 0.8, 8.0, 2.0);
          float streak = texture2D(map, vec2(x * 0.09, s * 0.0045)).r;
          rub *= smoothstep(0.1, 0.35, streak) * 0.55;
          diffuseColor.rgb *= 1.0 - rub * 0.6;
          // lighter, sun-bleached asphalt toward the edges
          diffuseColor.rgb *= 1.0 + 0.12 * smoothstep(6.0, halfW, ax);
          diffuseColor.rgb = mix(diffuseColor.rgb, paintCol, clamp(paint, 0.0, 1.0) * 0.95);
        }`);
  };
  const surf = new THREE.Mesh(new THREE.PlaneGeometry(W, L, 1, 8).rotateX(-Math.PI / 2), mat);
  surf.position.set(RUNWAY.x, y0, RUNWAY.z);
  surf.receiveShadow = true;
  surf.name = 'runwaySurface';
  group.add(surf);

  // ---- lights -----------------------------------------------------------------------------
  const lights = []; // {x, z, color}
  const zS = RUNWAY.z + L / 2, zN = RUNWAY.z - L / 2;
  for (let s = 0; s <= L + 0.1; s += 60) {
    for (const side of [-1, 1]) lights.push({ x: RUNWAY.x + side * (W / 2 + 1.2), z: zS - s, color: LIGHT_EDGE });
  }
  for (let i = 0; i < 12; i++) {
    const x = RUNWAY.x - W / 2 + 1.5 + i * ((W - 3) / 11);
    lights.push({ x, z: zS + 2.0, color: LIGHT_GREEN });   // threshold 36
    lights.push({ x: x + 1.2, z: zS + 3.2, color: LIGHT_RED }); // end of 18
    lights.push({ x, z: zN - 2.0, color: LIGHT_GREEN });   // threshold 18
    lights.push({ x: x + 1.2, z: zN - 3.2, color: LIGHT_RED }); // end of 36
  }
  // PAPI for runway 36 on the west side, abeam the aiming point
  const papi = [];
  for (let i = 0; i < 4; i++) {
    const p = { x: RUNWAY.x - W / 2 - 15 - i * 9, z: zS - 320, color: LIGHT_WHITE.clone(), papi: 3.5 - i * (1 / 3) };
    papi.push(p);
    lights.push(p);
  }

  const fixtureGeo = new THREE.CylinderGeometry(0.22, 0.26, 0.45, 8).translate(0, 0.22, 0);
  const fixtureMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const fixtures = new THREE.InstancedMesh(fixtureGeo, fixtureMat, lights.length);
  const m4 = new THREE.Matrix4();
  lights.forEach((l, i) => {
    const big = l.papi ? 2.2 : 1;
    m4.makeScale(big, big, big).setPosition(l.x, RUNWAY.elevation, l.z);
    fixtures.setMatrixAt(i, m4);
    fixtures.setColorAt(i, l.color);
  });
  fixtures.name = 'runwayLights';
  group.add(fixtures);

  // Glow sprites (points with a pixel-size floor so lights stay visible from far away).
  const n = lights.length;
  const gPos = new Float32Array(n * 3), gCol = new Float32Array(n * 3), gSize = new Float32Array(n);
  lights.forEach((l, i) => {
    gPos[i * 3] = l.x; gPos[i * 3 + 1] = RUNWAY.elevation + 0.5; gPos[i * 3 + 2] = l.z;
    gCol[i * 3] = l.color.r; gCol[i * 3 + 1] = l.color.g; gCol[i * 3 + 2] = l.color.b;
    gSize[i] = l.papi ? 5 : 2.6;
  });
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
  glowGeo.setAttribute('color', new THREE.BufferAttribute(gCol, 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(gSize, 1));
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      attribute float size;
      uniform float uScale;
      varying vec3 vColor;
      varying float vFade;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        gl_PointSize = clamp(size * uScale / d, 2.5, 48.0);
        vFade = 1.0 - smoothstep(3000.0, 7000.0, d);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vFade;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        float a = exp(-r * r * 5.0) * vFade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor * 0.5 * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const glow = new THREE.Points(glowGeo, glowMat);
  glow.frustumCulled = false;
  glow.renderOrder = 5;
  glow.name = 'runwayGlow';
  group.add(glow);

  // ---- per-frame: PAPI colors by the camera's elevation angle -------------------------------
  const tmp = new THREE.Color();
  const papiIndex = papi.map((p) => lights.indexOf(p));
  function update(dt, camera) {
    if (!camera) return;
    const h = (typeof window !== 'undefined' ? window.innerHeight : 900) * (renderer ? renderer.getPixelRatio() : 1);
    glowMat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 60) / 2));
    // PAPI: a light shows white when the eye is above its angle, red below.
    let changed = false;
    papi.forEach((p, k) => {
      const dx = camera.position.x - p.x, dz = camera.position.z - p.z;
      const ang = THREE.MathUtils.radToDeg(Math.atan2(camera.position.y - RUNWAY.elevation, Math.hypot(dx, dz)));
      const white = dz > 0 && ang > p.papi;
      tmp.copy(white ? LIGHT_WHITE : LIGHT_RED);
      if (!tmp.equals(p.color)) {
        p.color.copy(tmp);
        const i = papiIndex[k];
        fixtures.setColorAt(i, tmp);
        gCol[i * 3] = tmp.r; gCol[i * 3 + 1] = tmp.g; gCol[i * 3 + 2] = tmp.b;
        changed = true;
      }
    });
    if (changed) {
      fixtures.instanceColor.needsUpdate = true;
      glowGeo.attributes.color.needsUpdate = true;
    }
  }
  if (camera0) update(0, camera0);
  return { group, update };
}
