// Time & weather: the star field (Yale Bright Star Catalogue, 4.5k stars to V 5.9, built by tools/geo/sky_stars.py) as
// one THREE.Points draw, rotated with the local sidereal time so the constellations are where they really are over
// San Francisco. Stars fade in after civil dusk, dim toward the horizon (air mass + city light pollution) and hide
// behind fog / overcast (the cloud layers are drawn after them).
import * as THREE from 'three';
import { assetData } from '../core/assets.js';

const URL_STARS = new URL('../../assets/sf/sky/stars.bin', import.meta.url).href;
const RADIUS = 52000;   // inside the sky dome (60 km), in front of the far plane (80 km)

/** B-V colour index → linear RGB (approximate blackbody), normalized to max 1. */
function bvToRGB(bv) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));   // Ballesteros
  // Planck-ish ratios via a simple fit (Tanner Helland), converted to linear
  const k = t / 100;
  let r, g, b;
  if (k <= 66) { r = 255; g = 99.47 * Math.log(k) - 161.12; b = k <= 19 ? 0 : 138.52 * Math.log(k - 10) - 305.04; }
  else { r = 329.7 * Math.pow(k - 60, -0.1332); g = 288.12 * Math.pow(k - 60, -0.0755); b = 255; }
  const c = [r, g, b].map((v) => Math.pow(Math.min(Math.max(v, 0), 255) / 255, 2.2));
  const m = Math.max(...c);
  // desaturate: the eye sees star colours only faintly
  return c.map((v) => 0.55 * v / m + 0.45);
}

export function createStarField() {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.ShaderMaterial({
    name: 'sf-stars',
    uniforms: {
      uGain: { value: 0 }, uTime: { value: 0 }, uPx: { value: 1 }, uHorizonFade: { value: 1 }, uLimit: { value: 5.9 },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec2 aMag;          // V magnitude, twinkle phase
      attribute vec3 aCol;
      uniform float uGain, uTime, uPx, uHorizonFade, uLimit;
      varying vec3 vCol;
      void main() {
        vec3 wdir = normalize(mat3(modelMatrix) * position);
        // air mass extinction + light-polluted horizon: stars need to be ~20° up to shine
        float el = wdir.y;
        float ext = smoothstep(-0.01, 0.35, el);
        ext *= mix(1.0, smoothstep(0.0, 0.55, el), uHorizonFade);
        float I = pow(10.0, -0.4 * (aMag.x - 1.0)) * uGain * ext;
        I *= smoothstep(uLimit + 0.4, uLimit - 0.6, aMag.x);          // magnitude limit (sky brightness)
        I *= 0.8 + 0.35 * sin(uTime * (3.0 + aMag.y * 4.0) + aMag.y * 40.0) * (1.0 - ext * 0.6);   // twinkle, stronger low
        vCol = aCol * I;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp((1.6 + 1.1 * max(0.0, 2.5 - aMag.x)) * uPx, 1.0, 7.0 * uPx);
        if (I < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec3 vCol;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        if (r2 > 1.0) discard;
        gl_FragColor = vec4(vCol * exp(-r2 * 4.0) * 1.6, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'sf-stars';
  points.frustumCulled = false;
  points.renderOrder = -999;
  points.matrixAutoUpdate = false;
  points.visible = false;
  let loaded = false, loading = null;
  const m4 = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  return {
    points,
    uniforms: mat.uniforms,
    /** Load the catalogue (once, only when the stars are first needed). */
    load() {
      if (loading) return loading;
      loading = assetData(URL_STARS, 'arrayBuffer').then((buf) => {
        const f = new Float32Array(buf);
        const n = Math.floor(f.length / 5);
        const pos = new Float32Array(n * 3), mag = new Float32Array(n * 2), col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          pos[3 * i] = f[5 * i] * RADIUS; pos[3 * i + 1] = f[5 * i + 1] * RADIUS; pos[3 * i + 2] = f[5 * i + 2] * RADIUS;
          mag[2 * i] = f[5 * i + 3];
          mag[2 * i + 1] = ((i * 0.618034) % 1);
          col.set(bvToRGB(f[5 * i + 4]), 3 * i);
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 2));
        geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
        loaded = true;
      }).catch((e) => { console.warn('[environment] stars unavailable', e.message || e); });
      return loading;
    },
    /** starMatrix: column-major 3x3 equatorial → local (environment-astro.js skyAt). */
    setRotation(sm) {
      rot.set(sm[0], sm[3], sm[6], 0, sm[1], sm[4], sm[7], 0, sm[2], sm[5], sm[8], 0, 0, 0, 0, 1);
    },
    /** gain: overall visibility (0 = day); limit: faintest magnitude shown. */
    update(time, camera, gain, limit, pxScale) {
      const u = mat.uniforms;
      u.uGain.value = gain;
      u.uTime.value = time;
      u.uLimit.value = limit;
      u.uPx.value = pxScale;
      const on = gain > 0.002 && loaded;
      points.visible = on;
      if (!on) { if (gain > 0.002) this.load(); return; }
      m4.makeTranslation(camera.position.x, camera.position.y, camera.position.z).multiply(rot);
      points.matrix.copy(m4);
      points.matrixWorld.copy(m4);
    },
  };
}
