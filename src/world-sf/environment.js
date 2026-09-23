// W1: sky, sun + cascaded shadows, aerial perspective / marine haze, clouds, environment map, exposure.
// Time & weather: the sun and moon follow the real sky over SFO for the chosen local time (environment-astro.js);
// setTime(h) re-lights everything live (sky LUT, moon + stars, key light sun/moon, ambient, exposure, PMREM environment,
// the shared aerial-perspective uniforms); setWeather(p) switches the cloud deck, fog bank coverage, haze and light.
// Query params (for dev/tuning): time=HH:MM, date=YYYY-MM-DD, sunEl, sunAz (deg: fixed sun, no clock), haze (marine
// haze multiplier), exposure, shadows=0, clouds=0, fogbank=0
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { ATMO, sunTransmittance, createSkyLUT, SKY_LUT_SAMPLE, atmoGLSL, patchAerialPerspective, SF_ATM } from './environment-atmosphere.js';
import { NOISE_GLSL, CLOUD_GLSL, createCloudLayer, createCloudDeck, createNoiseData } from './environment-clouds.js';
import { createFogBank, loadBankHeight } from './environment-fogbank.js';
import { skyAt, parseTime, parseDate, DEFAULT_DATE, DEFAULT_TIME } from './environment-astro.js';
import { createStarField } from './environment-night.js';
import { createCumulus } from './environment-cumulus.js';

export { DEFAULT_TIME };
const D2R = Math.PI / 180;

/**
 * Sky state read by the light layers (city windows, street lights, landmarks, airports) and the weather module.
 * night: 0 day … 1 night (stars, exposure); lights: street/window lights switched on (0..1, earlier in dark weather);
 * extinction: 1/m for light sprites at the camera's altitude (weather visibility); inLayer: camera inside fog/cloud.
 */
export const SKY_STATE = {
  hours: DEFAULT_TIME, sunEl: 20, moonEl: 0, moonIllum: 0, night: 0, lights: 0,
  extinction: 4.5e-5, visibility: 60000, inLayer: 0, layerK: 0, wet: 0, rain: 0, weather: 'açık',
  live: false,   // true once an environment drives it (dev pages without one keep their own day/night logic)
  exposureComp: 1,   // default exposure / current exposure (light sprites designed for daytime exposure)
  lowVis: 0,         // 0..1: low-visibility weather (airfield lights switched to full intensity)
};

const smooth = (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

export async function createEnvironment(ctx) {
  const { scene, renderer } = ctx;
  const q = new URLSearchParams(location.search);
  const num = (k, d) => (q.has(k) && q.get(k) !== '' && !Number.isNaN(+q.get(k)) ? +q.get(k) : d);
  const fixedSun = q.has('sunEl') || q.has('sunAz');   // dev: fixed sun direction, no clock
  const fixedEl = num('sunEl', 20) * D2R, fixedAz = num('sunAz', 255) * D2R;
  let date = parseDate(q.get('date')) || DEFAULT_DATE;
  let hours = ctx.time != null ? parseTime(ctx.time) : null;
  if (hours == null) hours = parseTime(q.get('time'));
  if (hours == null) hours = DEFAULT_TIME;
  const baseHaze = num('haze', 0.85);
  const baseExposure = num('exposure', 1.05);
  const useBank = q.get('fogbank') !== '0';
  const useClouds = q.get('clouds') !== '0';

  // heading convention: azimuth clockwise from north (-Z); +X = east
  const sunDirection = new THREE.Vector3(0, 1, 0);   // true sun (may be below the horizon); shared, mutated in place
  const moonDirection = new THREE.Vector3(0, -1, 0);
  const keyDirection = new THREE.Vector3(0, 1, 0);   // direction of the key light (sun by day, moon at night)
  const sky = skyAt(hours, date);
  const applyAstro = () => {
    skyAt(hours, date, sky);
    if (fixedSun) sunDirection.set(Math.sin(fixedAz) * Math.cos(fixedEl), Math.sin(fixedEl), -Math.cos(fixedAz) * Math.cos(fixedEl)).normalize();
    else sunDirection.set(sky.sun.x, sky.sun.y, sky.sun.z).normalize();
    moonDirection.set(sky.moon.x, sky.moon.y, sky.moon.z).normalize();
  };
  applyAstro();
  ctx.sunDirection = sunDirection;   // shared with the terrain (baked terrain shadows are valid for one sun only)

  patchAerialPerspective();
  // THREE.Fog as a parameter block for the patched chunks: near = haze multiplier, far = time (s)
  scene.fog = new THREE.Fog(0x000000, baseHaze, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = baseExposure;

  // ---------------- sky ----------------
  const lut = createSkyLUT(renderer);
  lut.uniforms.uHaze.value = baseHaze;
  lut.uniforms.uCamH.value = 300;
  const skyUniforms = {
    uLut: { value: lut.texture }, uSunDir: { value: new THREE.Vector3() }, uCamH: { value: 300 },
    uSunDisk: { value: new THREE.Vector3() }, uTime: { value: 0 }, uClouds: { value: useClouds ? 1 : 0 },
    uSunE: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Vector3() },
    uCamPos: { value: new THREE.Vector3() }, uBank: { value: new THREE.Vector2() },
    // night + weather
    uNight: { value: 0 }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) }, uMoonDisk: { value: new THREE.Vector3() },
    uMoonGlow: { value: new THREE.Vector3() }, uNightZen: { value: new THREE.Vector3() }, uNightHor: { value: new THREE.Vector3() },
    uFogCol: { value: new THREE.Vector3() }, uFogK: { value: 0.022 },
    uOvercast: { value: 0 }, uOvercastCol: { value: new THREE.Vector3() }, uDeckBelow: { value: 0 }, uDeckTopCol: { value: new THREE.Vector3() },
    // ground bounce (environment map only): lower hemisphere radiance of the lit land/bay below
    uGroundMix: { value: 0 }, uGroundCol: { value: new THREE.Vector3() }, uTwilight: { value: 0 },
  };
  const SKY_FRAG = /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uLut; uniform vec3 uSunDir; uniform float uCamH; uniform vec3 uSunDisk; uniform float uTime;
      uniform float uClouds; uniform vec3 uSunE; uniform vec3 uAmb; uniform vec3 uCamPos;
      uniform float uNight; uniform vec3 uMoonDir; uniform vec3 uMoonDisk; uniform vec3 uMoonGlow;
      uniform vec3 uNightZen; uniform vec3 uNightHor; uniform vec3 uFogCol; uniform float uFogK;
      uniform float uOvercast; uniform vec3 uOvercastCol; uniform float uDeckBelow; uniform vec3 uDeckTopCol;
      uniform float uGroundMix; uniform vec3 uGroundCol; uniform float uTwilight;
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
        // civil/nautical twilight (the blue hour): multiple scattering the single-scattering LUT misses — deep blue
        // overhead, a warm band toward the set sun, the pink Belt of Venus / Earth shadow on the other side
        if (uTwilight > 0.001) {
          vec2 sa = normalize(uSunDir.xz + 1e-5), da = normalize(dir.xz + 1e-5);
          float toward = 0.5 + 0.5 * dot(sa, da);
          float up = max(dir.y, 0.0);
          float hz = pow(1.0 - min(up, 1.0), 4.0);
          vec3 tw = mix(vec3(0.010, 0.020, 0.052), vec3(0.020, 0.030, 0.060), hz);
          tw += vec3(0.075, 0.034, 0.012) * pow(toward, 3.0) * pow(1.0 - min(up * 2.2, 1.0), 3.0);
          tw += vec3(0.022, 0.012, 0.018) * (1.0 - toward) * exp(-up * 14.0);
          col += tw * uTwilight;
        }
        // night sky: airglow + city light pollution (warm, toward the horizon) + moonlit sky + moon aureole
        if (uNight > 0.001) {
          float up = max(dir.y - sin(horizon), 0.0);
          float hz = pow(1.0 - min(up, 1.0), 6.0);
          vec3 ns = mix(uNightZen, uNightHor, hz);
          float mu = dot(dir, uMoonDir);
          ns += uMoonGlow * (0.55 * (1.0 + mu * mu) * (0.4 + 0.6 * hz) + 1.4 * pow(max(mu, 0.0), 12.0) + 7.0 * pow(max(mu, 0.0), 90.0));
          col += ns * uNight;
        }
        float cs = dot(dir, uSunDir);
        float sunR = 0.00475;
        float d = acos(clamp(cs, -1.0, 1.0));
        if (d < sunR * 1.3 && el > horizon) {
          float x = clamp(d / sunR, 0.0, 1.0);
          float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - x * x, 0.0)));
          col += uSunDisk * limb * (1.0 - smoothstep(0.85, 1.3, d / sunR));
        }
        // the moon: a sphere lit by the real sun direction (phase and bright limb come out right), faint maria
        float cm = dot(dir, uMoonDir);
        const float moonR = 0.0046;
        if (cm > 0.99997 && el > horizon && uMoonDisk.r > 0.0) {
          vec3 pm = (dir - uMoonDir * cm) / moonR;
          float r2 = dot(pm, pm);
          if (r2 < 1.3) {
            vec3 n = pm - uMoonDir * sqrt(max(1.0 - r2, 0.0));
            vec3 ax = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
            vec3 ay = cross(ax, uMoonDir);
            vec2 mp = vec2(dot(pm, ax), dot(pm, ay));
            float maria = 0.72 + 0.28 * smoothstep(0.35, 0.7, sfFbm3(mp * 2.2 + 3.7)) - 0.18 * smoothstep(0.55, 0.8, sfVNoise(mp * 3.1 + 1.3));
            float lit = smoothstep(-0.02, 0.08, dot(n, uSunDir));
            vec3 mc = uMoonDisk * (lit * maria + 0.012);
            float edge = 1.0 - smoothstep(0.92, 1.05, r2);
            col = mix(col, mc, edge);
          }
        }
        // overcast seen from below / cloud deck seen from above (environment map + sky beyond the deck edge)
        // the ground seen from above (environment map): bounce light of the sunlit land and bay under the aircraft
        if (uGroundMix > 0.001 && dir.y < 0.0) col = mix(col, max(col, uGroundCol), uGroundMix * smoothstep(0.0, -0.12, dir.y));
        // (also below the horizon: beyond the terrain edge the hazy LUT horizon would show as a bright line)
        if (uOvercast > 0.001) col = mix(col, uOvercastCol * (0.85 + 0.15 * clamp(dir.y * 3.0, 0.0, 1.0)), uOvercast * smoothstep(-0.35, -0.1, dir.y));
        if (uDeckBelow > 0.001 && dir.y < 0.02) col = mix(col, uDeckTopCol, uDeckBelow * smoothstep(0.02, -0.03, dir.y));
        if (uBank.x > 0.001) {
          float tExit = dir.y > 1e-3 ? uBank.y / dir.y : 1e9;
          col = mix(col, uFogCol, (1.0 - exp(-uFogK * tExit)) * uBank.x);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`;
  const SKY_VERT = /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`;
  const skyMat = new THREE.ShaderMaterial({
    name: 'sf-sky', uniforms: skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), skyMat);
  dome.name = 'sf-sky-dome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.scale.setScalar(60000);
  dome.onBeforeRender = (r, s, cam) => { dome.position.copy(cam.position); dome.updateMatrixWorld(); };
  scene.add(dome);

  // ---------------- stars ----------------
  const stars = createStarField();
  scene.add(stars.points);

  // ---------------- environment map (PMREM of the sky; shares the sky uniforms except camera/fog) ----------------
  const envScene = new THREE.Scene();
  const envUniforms = { ...skyUniforms, uClouds: { value: 0 }, uCamPos: { value: new THREE.Vector3(0, 300, 0) }, uBank: { value: new THREE.Vector2() },
    uGroundMix: { value: 1 } };
  const envMat = new THREE.ShaderMaterial({ uniforms: envUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), envMat));
  let pmrem = null, envRT = null;
  scene.environmentIntensity = num('envI', 1.0);
  function renderEnvMap() {
    if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(envScene, 0, 1, 1000);
    scene.environment = rt.texture;
    if (envRT) envRT.dispose();
    envRT = rt;
  }

  // ---------------- lights ----------------
  const sun = new SunLight(0xffffff, 1);
  sun.name = 'sf-sun';
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
  const hemi = new THREE.HemisphereLight(0xffffff, new THREE.Color(0.18, 0.17, 0.15), 0.15);
  hemi.name = 'sf-hemi';
  scene.add(hemi);

  // ---------------- cloud layers ----------------
  const clouds = createCloudLayer(THREE, { sunDir: sunDirection, sunE: [1, 1, 1], amb: [0.1, 0.1, 0.1] });
  clouds.mesh.visible = useClouds;
  scene.add(clouds.mesh);
  const deck = createCloudDeck(THREE, { sunDir: sunDirection, sunE: [1, 1, 1], amb: [0.1, 0.1, 0.1], noise: createNoiseData(128) });
  scene.add(deck.mesh);
  // fair-weather cumulus (partly cloudy): puff impostors instead of the flat deck slices
  const cumulus = createCumulus({ sunDir: sunDirection, sunE: [1, 1, 1], amb: [0.1, 0.1, 0.1], noiseTex: deck.uniforms.uNoise.value });
  scene.add(cumulus.mesh);

  // ---------------- Golden Gate fog bank ----------------
  // always created (cheap) so it can be toggled at runtime; ?fogbank=0 starts with it off
  const bank = createFogBank({ sunDir: sunDirection, sunE: [1, 1, 1], amb: [0.1, 0.1, 0.1], ground: null });   // ground map loads after start
  let bankGroundRequested = false;
  bank.mesh.visible = useBank;
  let bankWanted = useBank;
  scene.add(bank.mesh);

  // ---------------- weather (visual part; src/world-sf/weather.js owns the presets and world.weather) ----------------
  const wx = {
    id: 'açık', haze: 1, high: 1, deck: null, fog: null, bank: true, sun: 1, dark: 0, wet: 0, rain: 0,
  };
  let deckSlices = 3;
  // an overcast deck is opaque: from below only its base shows, from above only its top → fewer slices (1 on low)
  const deckSlicesFor = (d) => (d && d.cover > 0.97 ? (deckSlices <= 2 ? 1 : Math.min(deckSlices, 3)) : deckSlices);

  // ---------------- lighting model (recomputed by setTime / setWeather) ----------------
  const L = {
    sunRGB: [0, 0, 0], amb: [0, 0, 0], key: new THREE.Color(), keyI: 0, keyIsMoon: false, exposure: baseExposure,
    fogCol: [0.5, 0.5, 0.5], glow: [0, 0, 0], night: 0, lights: 0, overcastCol: [0, 0, 0], deckTopCol: [0, 0, 0],
  };
  function computeLighting() {
    const sy = sunDirection.y, elDeg = Math.asin(Math.max(-1, Math.min(1, sy))) / D2R;
    // sun colour at low altitude through the whole atmosphere (0 below the horizon)
    const Tg = sunTransmittance(30, sy);
    const sunRGB = Tg.map((t) => t * ATMO.sunE);
    // ambient (sky) irradiance: the original multiple-scattering term, dimmed through twilight
    const twi = elDeg >= 0 ? mix(0.4, 1.0, smooth(0, 14, elDeg)) : 0.4 * Math.exp(elDeg / 3.4);
    const ms = ATMO.sunE * (ATMO.ms * 0.25 / Math.PI + 0.012 * Math.max(sy + 0.2, 0)) * twi;
    const night = smooth(-2, -13, elDeg);
    const lights = smooth(3, -4, elDeg - 7 * wx.dark);
    // moon: key light at night (blue-ish, Purkinje), scales with phase and altitude
    const mEl = Math.asin(Math.max(-1, Math.min(1, moonDirection.y))) / D2R;
    const moonUp = smooth(-0.5, 8, mEl);
    const moonI = 0.04 * Math.pow(sky.moonIllum, 1.5) * moonUp;
    // night ambient floor: skyglow of the city (warm) + airglow + moonlit sky (blue)
    const nAmb = [0.0055 + 0.02 * moonI, 0.0058 + 0.026 * moonI, 0.0075 + 0.04 * moonI];
    const amb = [ms * 0.92, ms * 0.98, ms * 1.08].map((v, i) => v + nAmb[i] * night);
    // weather: overcast hides the sun and flattens the light (cloud-top above the camera)
    const sunK = wx.sun, dark = wx.dark;
    const ambK = mix(1, 0.62 + 0.25 * (1 - dark), 1 - sunK) * (1 - 0.35 * dark);
    for (let i = 0; i < 3; i++) { amb[i] *= ambK; amb[i] += sunRGB[i] * (1 - sunK) * 0.055 * (1 - dark * 0.7); }
    const sunLit = sunRGB.map((v) => v * sunK);
    L.sunRGB = sunLit; L.sunRaw = sunRGB; L.amb = amb; L.night = night; L.lights = lights;
    // key light: sun, or the moon when it is brighter
    const sunI = Math.max(...sunLit);
    if (sunI >= moonI * sunK || fixedSun) {
      L.keyIsMoon = false; keyDirection.copy(sunDirection);
      L.key.setRGB(sunLit[0], sunLit[1], sunLit[2]); L.keyI = sunI;
    } else {
      L.keyIsMoon = true; keyDirection.copy(moonDirection);
      const mk = moonI * sunK;
      L.key.setRGB(0.62 * mk, 0.72 * mk, 1.0 * mk); L.keyI = mk;
    }
    if (L.keyI > 0) L.key.multiplyScalar(1 / L.keyI);
    // exposure: eye adaptation from day to night (city lights stay bright, the land shows by moon/skyglow)
    const adapt = elDeg >= 0 ? mix(1.22, 1.0, smooth(0, 12, elDeg)) * mix(1.0, 0.74, smooth(20, 62, elDeg)) : mix(1.22, 2.6, smooth(0, -12, elDeg));
    L.exposure = baseExposure * adapt * mix(1, 1.25, (1 - sunK) * (1 - night));
    // light inside fog/clouds: sun scattered in + ambient; at night the city lights glow in it
    const cityGlow = [0.030, 0.019, 0.010];   // orange sodium/LED glow (linear, before exposure)
    const g = lights * (wx.fog ? 1.0 : wx.deck ? 0.8 * wx.deck.cover : 0.25);
    L.glow = cityGlow.map((v) => v * g);
    L.fogCol = [0, 1, 2].map((i) => sunRGB[i] * (wx.fog ? 0.075 : 0.06) * mix(1, 0.7, 1 - sunK) + amb[i] * 1.5 + L.glow[i] * 1.2);
    // overcast underside radiance (environment + sky beyond the deck edge) and cloud-top radiance seen from above
    L.overcastCol = [0, 1, 2].map((i) => (sunRGB[i] * 0.06 * (1 - dark) + amb[i] * 1.4) * (1 - 0.3 * dark) + L.glow[i] * 0.8);
    L.deckTopCol = [0, 1, 2].map((i) => sunRGB[i] * 0.3 + amb[i] * 1.8 + L.glow[i] * 0.5);
    SKY_STATE.night = night; SKY_STATE.lights = lights; SKY_STATE.sunEl = elDeg; SKY_STATE.moonEl = mEl;
    SKY_STATE.moonIllum = sky.moonIllum; SKY_STATE.hours = hours; SKY_STATE.live = true;
  }

  let quality = null;
  let envDirty = true, envTimer = 0;
  /** Push the lighting model into the lights, the sky, the clouds, the fog bank and the shared uniforms. */
  function applyLighting() {
    computeLighting();
    const { sunRGB, amb } = L;
    // shared aerial perspective (every material): haze scatters the key light; at night the moon (dim)
    const keyRGB = L.keyIsMoon ? [L.key.r * L.keyI, L.key.g * L.keyI, L.key.b * L.keyI] : sunRGB;
    SF_ATM.set([keyDirection.x, keyDirection.y, keyDirection.z, L.night], 0);
    SF_ATM.set([keyRGB[0], keyRGB[1], keyRGB[2], 0], 4);
    SF_ATM.set([amb[0], amb[1], amb[2], 0], 8);
    SF_ATM[12] = L.fogCol[0]; SF_ATM[13] = L.fogCol[1]; SF_ATM[14] = L.fogCol[2];
    SF_ATM[20] = wx.wet;
    // key light
    sun.position.copy(keyDirection);
    sun.color.copy(L.key);
    sun.intensity = L.keyI;
    updateShadowCasting();
    hemi.color.setRGB(amb[0] * 1.6, amb[1] * 1.7, amb[2] * 2.1);
    // ground bounce (lead request: shaded undersides must keep detail): Lambertian land/bay, average albedo ~0.17
    // (warm grey land, darker bluish bay), lit by the sun + sky; at night by the moon, the sky and the city lights
    const sunY = Math.max(keyDirection.y, 0);
    const keyE = L.keyIsMoon ? [L.key.r * L.keyI, L.key.g * L.keyI, L.key.b * L.keyI] : sunRGB;
    // (brighter than a physical ~0.15 average: stands in for the multiple bounces and the bright haze under the aircraft)
    const gAlb = [0.3, 0.285, 0.255];
    const gc = [0, 1, 2].map((i) => gAlb[i] / Math.PI * (keyE[i] * sunY + amb[i] * Math.PI * 1.6) + L.glow[i] * 0.9 * L.lights);
    envUniforms.uGroundCol.value.set(gc[0], gc[1], gc[2]);
    hemi.groundColor.setRGB(gc[0] * 1.2, gc[1] * 1.2, gc[2] * 1.2);
    renderer.toneMappingExposure = L.exposure;
    SKY_STATE.exposureComp = baseExposure / L.exposure;
    // sky
    const su = skyUniforms;
    su.uSunDir.value.copy(sunDirection);
    const Tcam = sunTransmittance(300, sunDirection.y);
    su.uSunDisk.value.set(...Tcam.map((t) => Math.min(t * ATMO.sunE * 4000, 60000) * wx.sun));
    su.uSunE.value.set(...sunRGB); su.uAmb.value.set(...amb);
    su.uNight.value = L.night;
    const eld = SKY_STATE.sunEl;
    su.uTwilight.value = smooth(-13, -3, eld) * (1 - smooth(-1, 5, eld)) * wx.sun;
    su.uMoonDir.value.copy(moonDirection);
    const mT = sunTransmittance(300, Math.max(moonDirection.y, 0.0));
    const moonDisk = moonDirection.y > -0.01 ? 0.9 * wx.sun : 0;   // radiance of the lit surface (exposure does the rest)
    su.uMoonDisk.value.set(mT[0] * moonDisk * 1.05, mT[1] * moonDisk, mT[2] * moonDisk * 0.92);
    const mg = 0.0035 * Math.pow(sky.moonIllum, 1.5) * smooth(-2, 6, SKY_STATE.moonEl) * wx.sun;
    su.uMoonGlow.value.set(mg * 0.55, mg * 0.72, mg * 1.0);
    su.uNightZen.value.set(0.0012, 0.0019, 0.0042);
    su.uNightHor.value.set(0.0105 + L.glow[0] * 0.2, 0.0082 + L.glow[1] * 0.2, 0.0072 + L.glow[2] * 0.2);
    su.uFogCol.value.set(...L.fogCol);
    su.uOvercastCol.value.set(...L.overcastCol);
    deck.uniforms.uFarCol.value.set(...L.overcastCol);
    su.uDeckTopCol.value.set(...L.deckTopCol);
    lut.uniforms.uSunDir.value.copy(sunDirection);
    lut.uniforms.uHaze.value = baseHaze * wx.haze;
    lut.render();
    // clouds + fog bank: their sunlit tops see the sun even when an overcast deck hides it from the camera; after dusk
    // the moon lights them (silvery tops)
    const moonKey = Math.max(...L.sunRaw) < 0.02 && L.keyIsMoon;
    const cDir = moonKey ? moonDirection : sunDirection;
    const cE = moonKey ? [L.key.r * L.keyI / wx.sun, L.key.g * L.keyI / wx.sun, L.key.b * L.keyI / wx.sun] : L.sunRaw;
    for (const u of [clouds.mesh.material.uniforms, deck.uniforms, bank.uniforms, cumulus.uniforms]) {
      u.uSunDir.value.copy(cDir);
      u.uSunE.value.set(...cE);
      u.uAmb.value.set(...amb);
      u.uGlow.value.set(...L.glow);
    }
    bank.uniforms.uFogCol.value.set(...L.fogCol);
    stars.setRotation(sky.starMatrix);
    envDirty = true;
  }

  function updateShadowCasting() {
    const on = shadowsOn && (!quality || quality.shadows !== false) && !L.keyIsMoon && L.keyI > 0.08 && wx.sun > 0.35;
    if (sun.castShadow !== on) sun.castShadow = on;
  }

  /** Visual weather (from weather.js presets). */
  function applyWeather(p) {
    wx.id = p.id;
    wx.haze = p.haze ?? 1;
    wx.high = p.high ?? 1;
    wx.deck = p.deck || null;
    wx.fog = p.fog || null;
    wx.bank = p.bank !== false;
    wx.dark = p.dark || 0;
    wx.wet = p.wet || 0;
    wx.rain = p.rain || 0;
    clouds.mesh.material.uniforms.uAmount.value = wx.high;
    clouds.mesh.visible = useClouds && wx.high > 0.01;
    const cum = wx.deck && wx.deck.type === 0;
    deck.set(cum ? null : wx.deck);
    cumulus.set(cum ? wx.deck : null);
    deck.setSlices(deckSlicesFor(wx.deck));
    bank.setWeather(wx.fog ? wx.fog.cover : 0, wx.fog ? wx.fog.top : 0);
    bankWanted = useBank && (wx.bank || !!wx.fog);
    bank.mesh.visible = bankWanted;
    scene.fog.near = baseHaze * wx.haze;
    SKY_STATE.weather = p.id; SKY_STATE.wet = wx.wet; SKY_STATE.rain = wx.rain;
    // low-visibility procedures: airfield lights at full intensity by day in fog / rain / low overcast
    SKY_STATE.lowVis = wx.fog ? 1 : wx.rain ? 0.8 : wx.deck && wx.deck.cover > 0.97 ? 0.35 : 0;
    updateSunForCamera(lastCamY, true);
  }

  // overcast: the sun is hidden below the deck; above it (and in clear air) it shines. Recomputed when the camera
  // crosses the layer (smoothly through the cloud).
  let lastCamY = 300;
  function updateSunForCamera(camY, force = false) {
    let s = 1, below = 0;
    if (wx.deck) {
      const top = wx.deck.base + wx.deck.thick;
      const f = smooth(wx.deck.base, top, camY);   // 0 below the base … 1 above the top
      const cover = wx.deck.cover;
      s = mix(1 - 0.92 * smooth(0.6, 1, cover) - 0.3 * cover * (1 - smooth(0.6, 1, cover)), 1, f);
      below = (1 - f) * smooth(0.85, 1, cover);
    }
    if (wx.fog) {
      // under/inside the widespread fog the sun is a pale disc at best
      const top = wx.fog.top + 40;
      s = Math.min(s, mix(0.18, 1, smooth(top - 150, top + 30, camY)));
    }
    const above = wx.deck ? smooth(wx.deck.base + wx.deck.thick * 0.6, wx.deck.base + wx.deck.thick, camY) * smooth(0.85, 1, wx.deck.cover) : 0;
    if (!force && Math.abs(s - wx.sun) < 0.02 && Math.abs(below - skyUniforms.uOvercast.value) < 0.02 && Math.abs(above - skyUniforms.uDeckBelow.value) < 0.02) return;
    wx.sun = s;
    skyUniforms.uOvercast.value = below;
    skyUniforms.uDeckBelow.value = above;
    applyLighting();
  }

  let time = 0, lutTimer = 0, lastLutH = 300;
  const layerInfo = { inside: 0, top: 0, bottom: 1e7, k: 0.022 };
  const env = {
    sunDirection, moonDirection, keyDirection,
    sun, hemi, dome, bank, clouds, deck, cumulus, stars,
    get sunColor() { return sun.color.clone().multiplyScalar(sun.intensity); },
    skyUniforms,
    lut,
    state: SKY_STATE,
    /** Local time in hours (0..24). */
    get time() { return hours; },
    get date() { return { ...date }; },
    /** Set the local time (hours, or 'HH:MM'); live. */
    setTime(h) {
      const v = parseTime(h);
      if (v == null) return hours;
      hours = v;
      applyAstro();
      applyLighting();
      return hours;
    },
    setDate(d) { const p = typeof d === 'string' ? parseDate(d) : d; if (p) { date = p; applyAstro(); applyLighting(); } },
    /** Visual part of a weather preset (weather.js resolves names → preset objects). */
    setWeather(p) { if (p) applyWeather(p); },
    get weatherVisual() { return { ...wx }; },
    /** Live quality change (CONTRACTS-SF.md §8): shadows, shadowMapSize, shadowCascades, clouds. */
    setQuality(qq) {
      if (!qq) return;
      quality = qq;
      updateShadowCasting();   // renderer.shadowMap.enabled is set by main.js
      const size = qq.shadowMapSize || 4096;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }   // reallocated on the next shadow pass
      }
      // SunLight always renders 2 cascades (fixed in three's shader); "1 cascade" = short shadow range, so the second
      // cascade covers little and its caster pass is cheap
      sun.shadow.camera.far = (qq.shadowCascades || 2) >= 2 ? shadowDist : Math.min(shadowDist, 500);
      clouds.setQuality(qq.clouds || 'high');
      bank.setQuality(qq.clouds || 'high');
      cumulus.setQuality(qq.clouds || 'high');
      deckSlices = qq.clouds === 'low' ? 2 : qq.clouds === 'medium' ? 3 : qq.id === 'ultra' ? 5 : 4;
      deck.setSlices(deckSlicesFor(wx.deck));
    },
    get quality() { return quality; },
    /** Show/hide the Golden Gate fog bank (also removes the in-fog visibility effect). */
    setFogBank(on) { bankWanted = !!on; bank.mesh.visible = bankWanted; },
    get fogBankEnabled() { return bank.mesh.visible; },
    /** Ground light map (lights.js): orange city glow under fog and clouds at night follows the real city. */
    setGlowMap(tex, xf) {
      for (const u of [deck.uniforms, bank.uniforms, clouds.mesh.material.uniforms, cumulus.uniforms]) {
        u.uGlowMap.value = tex; u.uGlowXf.value.copy(xf);
      }
    },
    /** Camera inside fog/cloud: { inside 0..1, top (m above), bottom (m below), k (1/m) } (last frame). */
    get layer() { return layerInfo; },
    update(dt, camera) {
      if (!bankGroundRequested) { bankGroundRequested = true; loadBankHeight().then((g) => bank.setGround(g)); }
      time += dt;
      skyUniforms.uTime.value = time;
      if (scene.fog && scene.fog.isFog) scene.fog.far = time % 100000;
      const cy = camera.position.y;
      if (Math.abs(cy - lastCamY) > 5) { lastCamY = cy; updateSunForCamera(cy); }
      // camera inside the fog bank or a cloud → in-layer visibility (shared uniforms + sky)
      const b = bank.mesh.visible ? bank.update(dt, camera) : { inside: 0, topAbove: 0 };
      let inside = b.inside, top = b.topAbove, bottom = 1e7, k = wx.fog ? wx.fog.k : 0.022;
      deck.update(time, camera);
      cumulus.update(dt, camera);
      if (cumulus.mesh.visible) {
        const dd = cumulus.densityAt(camera.position.x, cy, camera.position.z);
        if (dd > inside) { inside = dd; top = 120; bottom = 120; k = 0.03; }
      }
      if (deck.mesh.visible) {
        const dd = deck.densityAt(camera.position.x, cy, camera.position.z, time);
        if (dd > inside) {
          inside = dd;
          top = Math.max(wx.deck.base + wx.deck.thick - cy, 0);
          bottom = Math.max(cy - wx.deck.base, 0);
          k = wx.deck.cover > 0.97 ? 0.035 : 0.025;
        }
      }
      layerInfo.inside = inside; layerInfo.top = top; layerInfo.bottom = bottom; layerInfo.k = k;
      SF_ATM[16] = inside; SF_ATM[17] = top; SF_ATM[18] = bottom; SF_ATM[15] = k;
      skyUniforms.uBank.value.set(inside, top);
      skyUniforms.uFogK.value = k;
      SKY_STATE.inLayer = inside; SKY_STATE.layerK = k;
      // visibility for light sprites at the camera: haze (weather) and fog/cloud around the camera
      const hazeK = 3.912 / (wx.fog ? mix(60000, 9000, smooth(wx.fog.top + 250, 50, cy)) : 60000 / Math.max(wx.haze, 0.5));
      SKY_STATE.extinction = hazeK * (0.35 + 0.65 * Math.exp(-Math.max(cy, 0) / 1500)) + inside * k;
      SKY_STATE.visibility = 3.912 / SKY_STATE.extinction;
      skyUniforms.uCamPos.value.copy(camera.position);
      clouds.update(time, camera);
      const h = Math.max(cy, 1);
      skyUniforms.uCamH.value = h;
      lutTimer += dt;
      if (lutTimer > 0.2 && Math.abs(h - lastLutH) > Math.max(20, lastLutH * 0.03)) {
        lut.uniforms.uCamH.value = h;
        lut.render();
        lastLutH = h;
        lutTimer = 0;
      }
      // stars: fade in after civil dusk, fewer under skyglow / moonlight / haze, hidden by overcast and in fog
      const starGain = smooth(0.35, 1, L.night) * wx.sun * (1 - inside) * (1 - skyUniforms.uOvercast.value) / Math.max(wx.haze, 1);
      const limit = 5.9 - 1.2 * Math.pow(sky.moonIllum, 2) * smooth(0, 20, SKY_STATE.moonEl) - 0.5 * (1 - L.night);
      const pxs = renderer.getPixelRatio();
      stars.update(time, camera, starGain * 0.9, limit, pxs);
      // environment map: re-rendered after lighting changes (throttled)
      envTimer -= dt;
      if (envDirty && envTimer <= 0) { renderEnvMap(); envDirty = false; envTimer = 0.4; }
    },
  };
  applyWeather({ id: 'açık' });
  if (ctx.quality) env.setQuality(ctx.quality);   // before the first frame: no 4096² allocation on a low preset
  renderEnvMap(); envDirty = false;
  return env;
}
