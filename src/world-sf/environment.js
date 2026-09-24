// W1: sky, sun + cascaded shadows, aerial perspective / marine haze, clouds, environment map, exposure.
// Query params (for dev/tuning): sunEl, sunAz (deg), haze (marine haze multiplier), exposure, shadows=0, clouds=0, fogbank=0
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { ATMO, sunTransmittance, createSkyLUT, SKY_LUT_SAMPLE, atmoGLSL, patchAerialPerspective } from './environment-atmosphere.js';
import { NOISE_GLSL, CLOUD_GLSL, createCloudLayer } from './environment-clouds.js';
import { createFogBank, loadBankHeight } from './environment-fogbank.js';

const D2R = Math.PI / 180;
const NO_BANK = { inside: 0, topAbove: 0 };

export async function createEnvironment(ctx) {
  const { scene, renderer } = ctx;
  const q = new URLSearchParams(location.search);
  const num = (k, d) => (q.has(k) && q.get(k) !== '' && !Number.isNaN(+q.get(k)) ? +q.get(k) : d);
  const sunEl = num('sunEl', 20) * D2R, sunAz = num('sunAz', 255) * D2R;
  const haze = num('haze', 0.85);
  const useBank = q.get('fogbank') !== '0';
  const useClouds = q.get('clouds') !== '0';

  // heading convention: azimuth clockwise from north (-Z); +X = east
  const sunDirection = new THREE.Vector3(Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(sunAz) * Math.cos(sunEl)).normalize();
  ctx.sunDirection = sunDirection;   // shared with the terrain (baked terrain shadows are valid for this sun only)

  // sun color at low altitude (through the whole atmosphere, incl. the haze layer)
  const Tg = sunTransmittance(30, sunDirection.y);
  const sunRGB = Tg.map((t) => t * ATMO.sunE);
  const ms = ATMO.sunE * (ATMO.ms * 0.25 / Math.PI + 0.012 * Math.max(sunDirection.y + 0.2, 0));
  const ambient = [ms * 0.92, ms * 0.98, ms * 1.08];

  patchAerialPerspective({ sunDir: sunDirection, sunColor: sunRGB, ambient });
  // THREE.Fog as a parameter block for the patched chunks: near = haze multiplier, far = time (s)
  scene.fog = new THREE.Fog(0x000000, haze, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num('exposure', 1.05);

  // ---------------- sky ----------------
  const lut = createSkyLUT(renderer);
  lut.uniforms.uSunDir.value.copy(sunDirection);
  lut.uniforms.uHaze.value = haze;
  lut.uniforms.uCamH.value = 300;
  lut.render();
  const Tcam = sunTransmittance(300, sunDirection.y);
  const sunDisk = new THREE.Vector3(...Tcam.map((t) => Math.min(t * ATMO.sunE * 4000, 60000)));
  const skyUniforms = {
    uLut: { value: lut.texture }, uSunDir: { value: sunDirection.clone() }, uCamH: { value: 300 },
    uSunDisk: { value: sunDisk }, uTime: { value: 0 }, uClouds: { value: useClouds ? 1 : 0 },
    uSunE: { value: new THREE.Vector3(...sunRGB) }, uAmb: { value: new THREE.Vector3(...ambient) },
    uCamPos: { value: new THREE.Vector3() }, uBank: { value: new THREE.Vector2() },
  };
  const skyMat = new THREE.ShaderMaterial({
    name: 'sf-sky',
    uniforms: skyUniforms,
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uLut; uniform vec3 uSunDir; uniform float uCamH; uniform vec3 uSunDisk; uniform float uTime;
      uniform float uClouds; uniform vec3 uSunE; uniform vec3 uAmb; uniform vec3 uCamPos;
      varying vec3 vDir;
      ${atmoGLSL()}
      ${SKY_LUT_SAMPLE}
      uniform vec2 uBank;
      ${NOISE_GLSL}
      ${CLOUD_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 dir = normalize(vDir);
        vec3 col = sampleSkyLUT(uLut, dir, uSunDir, uCamH);
        float r = ATM_RG + max(uCamH, 1.0);
        float horizon = -acos(clamp(ATM_RG / r, -1.0, 1.0));
        float el = asin(clamp(dir.y, -1.0, 1.0));
        float cs = dot(dir, uSunDir);
        float sunR = 0.00475;
        float d = acos(clamp(cs, -1.0, 1.0));
        if (d < sunR * 1.3 && el > horizon) {
          float x = clamp(d / sunR, 0.0, 1.0);
          float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - x * x, 0.0)));
          col += uSunDisk * limb * (1.0 - smoothstep(0.85, 1.3, d / sunR));
        }
        if (uBank.x > 0.001) {
          float tExit = dir.y > 1e-3 ? uBank.y / dir.y : 1e9;
          col = mix(col, uSunE * 0.06 + uAmb * 1.5, (1.0 - exp(-0.022 * tExit)) * uBank.x);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), skyMat);
  dome.name = 'sf-sky-dome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.scale.setScalar(60000);
  dome.onBeforeRender = (r, s, cam) => { dome.position.copy(cam.position); dome.updateMatrixWorld(); };
  scene.add(dome);

  // ---------------- environment map (PMREM of the sky, ground-ish lower hemisphere) ----------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envUniforms = {};
  for (const k of Object.keys(skyUniforms)) {
    const v = skyUniforms[k].value;
    envUniforms[k] = { value: v && v.clone && !v.isTexture ? v.clone() : v };
  }
  envUniforms.uClouds.value = 0;
  envUniforms.uCamPos.value.set(0, 300, 0);
  const envMat = new THREE.ShaderMaterial({ uniforms: envUniforms, vertexShader: skyMat.vertexShader, fragmentShader: skyMat.fragmentShader, side: THREE.BackSide, depthWrite: false, fog: false });
  const envDome = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), envMat);
  envScene.add(envDome);
  const envRT = pmrem.fromScene(envScene, 0, 1, 1000);
  scene.environment = envRT.texture;
  scene.environmentIntensity = num('envI', 1.0);
  pmrem.dispose();

  // ---------------- lights ----------------
  const sunColor = new THREE.Color(sunRGB[0], sunRGB[1], sunRGB[2]);
  const sunIntensity = Math.max(sunColor.r, sunColor.g, sunColor.b);
  sunColor.multiplyScalar(1 / sunIntensity);
  const sun = new SunLight(sunColor, sunIntensity);
  sun.name = 'sf-sun';
  sun.position.copy(sunDirection);
  const shadowsOn = q.get('shadows') !== '0';
  sun.castShadow = shadowsOn;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near = 1;
  const shadowDist = num('shadowDist', 1600);
  sun.shadow.camera.far = shadowDist;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.35;
  sun.shadow.radius = 1.5;
  scene.add(sun);
  // weak hemisphere fill for non-PBR (Lambert/Phong) materials, which ignore scene.environment
  const hemi = new THREE.HemisphereLight(new THREE.Color(ambient[0] * 1.6, ambient[1] * 1.7, ambient[2] * 2.1), new THREE.Color(0.18, 0.17, 0.15), 0.15);
  hemi.name = 'sf-hemi';
  scene.add(hemi);

  // ---------------- cloud layer (geometry, visible from below and above) ----------------
  const clouds = createCloudLayer(THREE, { sunDir: sunDirection, sunE: sunRGB, amb: ambient });
  clouds.mesh.visible = useClouds;
  scene.add(clouds.mesh);

  // ---------------- Golden Gate fog bank ----------------
  // always created on San Francisco (cheap) so it can be toggled at runtime; ?fogbank=0 starts with it off; other maps
  // (src/maps/index.js) have none
  const bank = ctx.map && !ctx.map.fogBank ? null : createFogBank({ sunDir: sunDirection, sunE: sunRGB, amb: ambient, ground: null });   // ground map loads after start
  let bankGroundRequested = !bank;
  if (bank) { bank.mesh.visible = useBank; scene.add(bank.mesh); }

  let time = 0, lutTimer = 0, lastLutH = 300, quality = null;
  const env = {
    sunDirection,
    sun, hemi, dome, bank, clouds,
    sunColor: sunColor.clone().multiplyScalar(sunIntensity),
    skyUniforms,
    lut,
    /** Live quality change (CONTRACTS-SF.md §8): shadows, shadowMapSize, shadowCascades, clouds. */
    setQuality(qq) {
      if (!qq) return;
      const on = qq.shadows !== false && shadowsOn;
      if (sun.castShadow !== on) sun.castShadow = on;   // renderer.shadowMap.enabled is set by main.js
      const size = qq.shadowMapSize || 4096;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }   // reallocated on the next shadow pass
      }
      // SunLight always renders 2 cascades (fixed in three's shader); "1 cascade" = short shadow range, so the second
      // cascade covers little and its caster pass is cheap
      sun.shadow.camera.far = (qq.shadowCascades || 2) >= 2 ? shadowDist : Math.min(shadowDist, 500);
      clouds.setQuality(qq.clouds || 'high');
      if (bank) bank.setQuality(qq.clouds || 'high');
      quality = qq;
    },
    get quality() { return quality; },
    /** Show/hide the Golden Gate fog bank (also removes the in-fog visibility effect). */
    setFogBank(on) { if (bank) bank.mesh.visible = !!on; },
    get fogBankEnabled() { return !!bank && bank.mesh.visible; },
    update(dt, camera) {
      if (!bankGroundRequested) { bankGroundRequested = true; loadBankHeight().then((g) => bank.setGround(g)); }
      time += dt;
      skyUniforms.uTime.value = time;
      if (scene.fog && scene.fog.isFog) scene.fog.far = time % 100000;
      const b = bank && bank.mesh.visible ? bank.update(dt, camera) : NO_BANK;
      skyUniforms.uBank.value.set(b.inside, b.topAbove);
      if (scene.fog && scene.fog.isFog) scene.fog.color.setRGB(b.inside, b.topAbove / 1000, 0);
      skyUniforms.uCamPos.value.copy(camera.position);
      clouds.update(time, camera);
      const h = Math.max(camera.position.y, 1);
      skyUniforms.uCamH.value = h;
      lutTimer += dt;
      if (lutTimer > 0.2 && Math.abs(h - lastLutH) > Math.max(20, lastLutH * 0.03)) {
        lut.uniforms.uCamH.value = h;
        lut.render();
        lastLutH = h;
        lutTimer = 0;
      }
    },
  };
  if (ctx.quality) env.setQuality(ctx.quality);   // before the first frame: no 4096² allocation on a low preset
  return env;
}
