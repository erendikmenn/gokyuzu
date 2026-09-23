// Time & weather: weather presets, the physics-facing `world.weather` object and rain.
// The visual weather (cloud deck, fog bank coverage, haze, light) lives in environment.js; this module resolves preset
// names, keeps the numbers the flight model may use later (visibility, cloud base/top, ceiling, precipitation, wind)
// separate from the visuals, and draws the rain streaks around the camera. No wind physics here: `wind` is data only.
import * as THREE from 'three';
import { SKY_STATE } from './environment.js';
import { WEATHER_PRESETS, DEFAULT_WEATHER, resolveWeather } from './weather-presets.js';

export { WEATHER_PRESETS, WEATHER_ORDER, DEFAULT_WEATHER, resolveWeather, START_CONDITIONS, setStartConditions } from './weather-presets.js';

// ---------------------------------------------------------------------------------------------- rain
const RAIN_BOX = new THREE.Vector3(70, 46, 70);   // camera-centred wrap box (m)
function createRain(maxDrops) {
  const quad = new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]);   // x: 0 = head … 1 = tail; y: side
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(maxDrops * 4);
  let s = 12345;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < maxDrops; i++) seeds.set([rnd(), rnd(), rnd(), rnd()], i * 4);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    name: 'sf-rain',
    uniforms: {
      uTime: { value: 0 }, uBox: { value: RAIN_BOX.clone() }, uCam: { value: new THREE.Vector3() },
      uVel: { value: new THREE.Vector3() },          // rain velocity relative to the camera (m/s)
      uFall: { value: new THREE.Vector3(1.5, -8.5, 0.8) },
      uCol: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uPx: { value: 1 }, uAlpha: { value: 0.3 },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 aSeed;
      uniform float uTime, uPx, uAlpha; uniform vec3 uBox, uCam, uVel, uFall;
      varying float vA; varying float vY;
      void main() {
        // drop position: falls with uFall, wraps in a box that follows the camera
        vec3 p = aSeed.xyz * uBox + uFall * uTime * (0.85 + 0.3 * aSeed.w);
        p = mod(p - uCam + 0.5 * uBox, uBox) - 0.5 * uBox + uCam;
        // streak = motion during ~1/40 s relative to the camera (long and slanted when flying fast)
        vec3 tail = p - uVel * (0.025 + 0.01 * aSeed.w);
        vec4 h = viewMatrix * vec4(p, 1.0), t = viewMatrix * vec4(tail, 1.0);
        vec4 e = mix(h, t, position.x);
        float dcam = length(p - uCam);
        // no drops inside the cockpit / right at the lens; fade with distance
        vA = uAlpha * smoothstep(3.0, 7.0, dcam) * (1.0 - smoothstep(22.0, 34.0, dcam));
        vec4 ch = projectionMatrix * h, ct = projectionMatrix * t;
        vec2 sh = ch.xy / max(ch.w, 1e-3), st = ct.xy / max(ct.w, 1e-3);
        vec2 dir = st - sh;
        dir = length(dir) > 1e-5 ? normalize(dir) : vec2(0.0, 1.0);
        vec2 side = vec2(-dir.y, dir.x);
        gl_Position = projectionMatrix * e;
        gl_Position.xy += side * position.y * uPx * gl_Position.w;
        vY = position.y;
        if (h.z > -0.5 || vA < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uCol;
      varying float vA; varying float vY;
      void main() {
        #include <logdepthbuf_fragment>
        float a = vA * (1.0 - vY * vY);
        gl_FragColor = vec4(uCol, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sf-rain';
  mesh.frustumCulled = false;
  mesh.renderOrder = 30;
  mesh.visible = false;
  return { mesh, geo, mat, maxDrops };
}

/**
 * @param env environment (environment.js)
 * @param opts { scene, quality, camera }
 */
export function createWeather(env, { scene }) {
  const rain = createRain(16000);
  scene.add(rain.mesh);
  let drops = 9000;
  let preset = WEATHER_PRESETS[DEFAULT_WEATHER];
  const prevCam = new THREE.Vector3();
  let havePrev = false;
  const camVel = new THREE.Vector3();
  const _v = new THREE.Vector3();

  /** Physics-facing weather (read-only for the flight model; the visuals do not depend on it). */
  const state = {
    preset: preset.id, label: preset.label,
    visibility: preset.visibility,   // m, prevailing surface visibility
    cloudBase: null, cloudTop: null, cloudCover: 0, ceiling: null, fogTop: null,
    precipitation: 0, temperature: preset.temperature, qnh: preset.qnh,
    wind: { ...preset.wind },          // reserved for a future wind model: direction (deg true, FROM), speed, gust (m/s)
    turbulence: 0,
    /** Current visibility (m) at a point: fog bank / cloud deck / haze, as rendered. */
    visibilityAt(x, y, z) {
      let v = preset.visibility;
      if (state.fogTop != null && y < state.fogTop) v = Math.min(v, 3.912 / preset.fog.k);
      if (state.cloudBase != null && y >= state.cloudBase && y <= state.cloudTop) {
        const d = state.cloudAt(x, y, z);
        if (d > 0.05) v = Math.min(v, 3.912 / (d * (preset.deck.cover > 0.97 ? 0.035 : 0.025)));
      }
      return v;
    },
    /**
     * Wind vector (m/s, world axes: +X east, -Z north) at a point — DATA ONLY, no physics uses it yet. Surface wind of
     * the preset (direction it blows FROM, degrees true) growing with height (1/7 power law above 10 m, capped at 3x).
     */
    windAt(x, y, z, out = { x: 0, y: 0, z: 0 }) {
      const w = state.wind;
      const k = Math.min(3, Math.pow(Math.max(y, 10) / 10, 1 / 7));
      const to = (w.direction + 180) * Math.PI / 180;   // blowing toward
      out.x = Math.sin(to) * w.speed * k; out.y = 0; out.z = -Math.cos(to) * w.speed * k;
      return out;
    },
    /** Is (x,y,z) inside the cloud deck? 0..1 density. */
    cloudAt(x, y, z) { return Math.max(env.deck.densityAt(x, y, z, 0), env.cumulus ? env.cumulus.densityAt(x, y, z) : 0); },
  };

  function apply(id) {
    preset = WEATHER_PRESETS[id] || WEATHER_PRESETS[DEFAULT_WEATHER];
    env.setWeather(preset);
    const d = preset.deck;
    Object.assign(state, {
      preset: preset.id, label: preset.label, visibility: preset.visibility,
      cloudBase: d ? d.base : null, cloudTop: d ? d.base + d.thick : null, cloudCover: d ? d.cover : 0,
      ceiling: d && d.cover >= 0.625 ? d.base : null,   // BKN (5/8) or more
      fogTop: preset.fog ? preset.fog.top : null,   // mean top of the fog layer (m MSL; ±40 m billows)
      precipitation: preset.rain || 0, temperature: preset.temperature, qnh: preset.qnh,
    });
    state.wind = { ...preset.wind };
    if (state.fogTop != null) { state.ceiling = 0; state.cloudBase = 0; }   // fog: sky obscured (vertical visibility)
    rain.mesh.visible = (preset.rain || 0) > 0;
    rain.geo.instanceCount = Math.round(drops * (preset.rain || 0));
    return preset.id;
  }

  return {
    state,
    get preset() { return preset; },
    set(name) {
      const id = resolveWeather(name);
      if (!id) { console.warn('[weather] unknown preset', name); return preset.id; }
      return apply(id);
    },
    setQuality(q) {
      if (!q) return;
      drops = q.id === 'low' ? 3500 : q.id === 'medium' ? 6500 : q.id === 'ultra' ? 14000 : 10000;
      rain.geo.instanceCount = Math.round(drops * (preset.rain || 0));
    },
    update(dt, camera, renderer) {
      if (!rain.mesh.visible) { havePrev = false; return; }
      const u = rain.mat.uniforms;
      u.uTime.value += dt;
      camera.getWorldPosition(_v);
      if (havePrev && dt > 0) camVel.subVectors(_v, prevCam).divideScalar(dt).clampLength(0, 400);
      prevCam.copy(_v); havePrev = true;
      u.uCam.value.copy(_v);
      u.uVel.value.copy(u.uFall.value).sub(camVel);
      // lit by the ambient light (+ city glow at night); brighter streaks in daylight
      const a = SKY_STATE;
      const day = 1 - a.night;
      u.uCol.value.set(0.30 * day + 0.035, 0.31 * day + 0.034, 0.33 * day + 0.036);
      u.uAlpha.value = 0.3;
      const h = renderer ? renderer.getDrawingBufferSize(_v).y : 900;
      u.uPx.value = 1.4 / Math.max(h, 1);   // half-width 0.7 px
    },
    apply,
    rain,
  };
}
