// Soft cumulus clouds: each cloud is a cluster of camera-facing puff sprites (one instanced draw
// call for all of them). Puffs are shaded by their height inside the cloud (bright sunlit tops, grey
// flat bases) and by the sun direction, fade out when the camera gets close, get the scene fog, and
// are re-sorted back-to-front so alpha blending stays clean. Clouds drift with the wind and wrap.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { makeCloudTexture } from './textures.js';

const CLOUDS = 46;
const DOMAIN = 26000;            // clouds live in a square of this size centered on the camera
const WIND = new THREE.Vector2(3.2, 1.1); // m/s

export function createClouds(sky) {
  const rand = mulberry32(777);
  const puffs = []; // {cloud, ox, oy, oz, size, tile, shade}
  const clouds = [];
  for (let c = 0; c < CLOUDS; c++) {
    const base = 750 + rand() * 650;
    const scale = 0.6 + rand() * 0.9;
    const cloud = {
      x: (rand() - 0.5) * DOMAIN,
      z: (rand() - 0.5) * DOMAIN,
      base,
    };
    clouds.push(cloud);
    const len = (260 + rand() * 360) * scale, wid = (180 + rand() * 200) * scale;
    const height = (110 + rand() * 180) * scale;
    const n = Math.round(14 + scale * 16);
    for (let i = 0; i < n; i++) {
      // distribute puffs in a squashed dome: wide flat base, rounded top
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand());
      const ox = Math.cos(a) * r * len * 0.5;
      const oz = Math.sin(a) * r * wid * 0.5;
      const edge = 1 - r * 0.75;
      const oy = Math.pow(rand(), 1.4) * height * edge + 20;
      const size = (110 + rand() * 120) * scale * (0.65 + 0.5 * edge);
      puffs.push({ cloud, ox, oy, oz, size, tile: Math.floor(rand() * 4), rel: oy / (height + 20) });
    }
    // flat dark-ish base layer
    for (let i = 0; i < Math.round(4 + scale * 4); i++) {
      const ox = (rand() - 0.5) * len * 0.7, oz = (rand() - 0.5) * wid * 0.6;
      puffs.push({ cloud, ox, oy: 10, oz, size: (130 + rand() * 90) * scale, tile: Math.floor(rand() * 4), rel: 0 });
    }
  }

  const N = puffs.length;
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  const aOffset = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const aData = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4); // size, tile, rel, rot
  aOffset.setUsage(THREE.DynamicDrawUsage);
  aData.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aOffset', aOffset);
  geo.setAttribute('aData', aData);
  geo.instanceCount = N;

  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uMap: { value: null },
    uSunDir: { value: null },
    uLight: { value: new THREE.Color('#ffffff') },
    uShadow: { value: new THREE.Color('#a9b6c6') },
  }]);
  uniforms.uMap.value = makeCloudTexture();
  uniforms.uSunDir = sky.uniforms.uSunDir;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec3 aOffset;
      attribute vec4 aData;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying float vRel;
      varying float vAlpha;
      varying float vSunSide;
      #include <fog_pars_vertex>
      void main() {
        float size = aData.x;
        float tile = aData.y;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float c = cos(aData.w), s = sin(aData.w);
        vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
        vec3 wp = aOffset + (right * p.x + up * p.y) * size;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vUv = (uv + vec2(mod(tile, 2.0), floor(tile / 2.0))) * 0.5;
        vRel = aData.z;
        float d = length(aOffset - cameraPosition);
        vAlpha = smoothstep(size * 0.35, size * 1.4, d);   // fade when flying through
        vSunSide = dot(normalize(aOffset - cameraPosition), uSunDir);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform vec3 uLight;
      uniform vec3 uShadow;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying float vRel;
      varying float vAlpha;
      varying float vSunSide;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec4 t = texture2D(uMap, vUv);
        float a = t.a * vAlpha;
        if (a < 0.01) discard;
        // vertical shading + silver lining when looking toward the sun
        float lit = smoothstep(0.0, 0.85, vRel);
        vec3 col = mix(uShadow, uLight, 0.35 + 0.65 * lit);
        col += vec3(1.0, 0.95, 0.85) * pow(max(vSunSide, 0.0), 6.0) * (1.0 - t.a) * 0.6;
        gl_FragColor = vec4(col, a * 0.92);
        #include <colorspace_fragment>
        #ifdef USE_FOG
          float fogDepth2 = vFogDepth * 0.55;
          float fogFactor = smoothstep(fogNear, fogFar, fogDepth2);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
          gl_FragColor.a *= 1.0 - smoothstep(fogFar * 0.9, fogFar * 1.6, vFogDepth);
        #endif
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.name = 'clouds';

  // Positions + back-to-front sorting.
  const order = new Uint32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  const dist = new Float32Array(N);
  const wx = new Float32Array(N), wy = new Float32Array(N), wz = new Float32Array(N);
  let windX = 0, windZ = 0;
  let sortTimer = 0;
  const camPos = new THREE.Vector3();

  function wrap(v, c) {
    const h = DOMAIN / 2;
    return ((((v - c) + h) % DOMAIN) + DOMAIN) % DOMAIN - h + c;
  }

  function refresh(camera) {
    if (camera) camPos.copy(camera.position);
    for (let i = 0; i < N; i++) {
      const p = puffs[i];
      const cx = wrap(p.cloud.x + windX, camPos.x);
      const cz = wrap(p.cloud.z + windZ, camPos.z);
      wx[i] = cx + p.ox; wy[i] = p.cloud.base + p.oy; wz[i] = cz + p.oz;
      const dx = wx[i] - camPos.x, dy = wy[i] - camPos.y, dz = wz[i] - camPos.z;
      dist[i] = dx * dx + dy * dy + dz * dz;
    }
    const idx = Array.from(order);
    idx.sort((a, b) => dist[b] - dist[a]);
    const off = aOffset.array, dat = aData.array;
    for (let k = 0; k < N; k++) {
      const i = idx[k], p = puffs[i];
      off[k * 3] = wx[i]; off[k * 3 + 1] = wy[i]; off[k * 3 + 2] = wz[i];
      dat[k * 4] = p.size; dat[k * 4 + 1] = p.tile; dat[k * 4 + 2] = p.rel; dat[k * 4 + 3] = (i * 2.399) % 6.283;
    }
    aOffset.needsUpdate = true;
    aData.needsUpdate = true;
  }
  refresh(null);

  function update(dt, camera) {
    windX += WIND.x * dt;
    windZ += WIND.y * dt;
    sortTimer -= dt;
    // positions change slowly; re-sort a few times per second (cheap: ~1k puffs)
    if (sortTimer <= 0 || !camera) {
      sortTimer = 0.12;
      refresh(camera);
    }
  }

  return { mesh, update, count: N };
}
