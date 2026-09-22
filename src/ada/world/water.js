// Ocean (huge plane reaching the horizon) + lake, sharing one custom shader:
// scrolling procedural normal maps, fresnel sky reflection, sun glint, depth-based color
// (teal shallows → deep blue) and soft animated foam, using a terrain height texture.
import * as THREE from 'three';
import { WORLD } from '../config.js';
import { makeWaterNormalTexture, makeHeightTexture } from './textures.js';
import { skyGLSL } from './sky.js';

const vertexShader = /* glsl */`
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  uniform float uLevel;
  uniform sampler2D uNormalMap;
  uniform sampler2D uHeight;
  uniform vec4 uHeightRect;   // x0, z0, 1/size, texel offset
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform float uFoam;
  varying vec3 vWorld;
  ${skyGLSL}
  #include <common>
  #include <fog_pars_fragment>

  vec2 nrm(vec2 uv) { return texture2D(uNormalMap, uv).xy * 2.0 - 1.0; }

  void main() {
    vec2 p = vWorld.xz;
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;

    // terrain height below the water surface → depth
    vec2 huv = (p - uHeightRect.xy) * uHeightRect.z;
    huv = huv * (1.0 - 2.0 * uHeightRect.w) + uHeightRect.w;
    float ground = texture2D(uHeight, huv).r;
    bool outside = any(lessThan(huv, vec2(0.0))) || any(greaterThan(huv, vec2(1.0)));
    if (outside) ground = -80.0;
    float depth = uLevel - ground;
    if (depth < -0.05) discard;

    // waves: three scrolling octaves, flattened with distance to avoid shimmering
    vec2 p1 = mat2(0.8, -0.6, 0.6, 0.8) * p;
    vec2 p2 = mat2(0.28, 0.96, -0.96, 0.28) * p;
    vec2 n = nrm(p1 / 241.0 + uTime * vec2(0.005, 0.003)) * 0.8
           + nrm(p / 83.0 + uTime * vec2(-0.009, 0.008)) * 0.7
           + nrm(p2 / 29.0 + uTime * vec2(0.017, -0.021)) * 0.5 * (1.0 - smoothstep(200.0, 1400.0, dist))
           + nrm(p1 / 7.7 + uTime * vec2(-0.045, 0.035)) * 0.35 * (1.0 - smoothstep(40.0, 260.0, dist));
    float calm = mix(0.55, 0.12, smoothstep(300.0, 6000.0, dist));
    vec3 N = normalize(vec3(n.x * calm, 1.0, n.y * calm));

    float ndv = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = skyColor(normalize(R), 0.0);

    // body color: shallow teal → deep blue; lit by the sun a little (subsurface-ish)
    float dShade = smoothstep(0.3, 14.0, depth);
    vec3 body = mix(uShallow, uDeep, dShade);
    float sunUp = max(uSunDir.y, 0.0);
    body *= 0.55 + 0.6 * sunUp;

    vec3 col = mix(body, refl, fres * 0.9);

    // sun glint
    vec3 H = normalize(uSunDir + V);
    float nh = max(dot(N, H), 0.0);
    col += uSunColor * (pow(nh, 900.0) * 8.0 + pow(nh, 120.0) * 0.35) * (1.0 - smoothstep(4000.0, 9000.0, dist) * 0.7);

    // shoreline foam (animated bands)
    float foamBand = 1.0 - smoothstep(0.0, 1.4, depth);
    float wav = 0.5 + 0.5 * sin(depth * 5.0 - uTime * 1.6 + texture2D(uNormalMap, p / 23.0).x * 6.0);
    float foamTex = texture2D(uNormalMap, p / 9.0 + uTime * 0.01).y;
    float foam = foamBand * smoothstep(0.35, 0.75, wav * foamTex + foamBand * 0.4) * uFoam;
    col = mix(col, vec3(0.92, 0.95, 0.96), clamp(foam, 0.0, 1.0) * 0.85);

    // alpha: see the sand through very shallow water
    float alpha = mix(0.25, 1.0, smoothstep(0.0, 3.5, depth));
    alpha = max(alpha, foam * 0.9);
    alpha = mix(alpha, 1.0, smoothstep(1500.0, 4000.0, dist));

    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createWater(terrain, sky) {
  const normalMap = makeWaterNormalTexture();
  const heightTex = makeHeightTexture(terrain.heights, terrain.V);
  const texelHalf = 0.5 / terrain.V;

  function makeMaterial(level, deep, shallow, foam) {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uLevel: { value: level },
      uNormalMap: { value: null },
      uHeight: { value: null },
      uHeightRect: { value: new THREE.Vector4(-terrain.half, -terrain.half, 1 / terrain.size, texelHalf) },
      uDeep: { value: new THREE.Color(deep) },
      uShallow: { value: new THREE.Color(shallow) },
      uFoam: { value: foam },
      uHorizon: { value: null }, uZenith: { value: null }, uSunDir: { value: null }, uSunColor: { value: null },
    }]);
    // share textures / sky uniforms by reference (merge() clones)
    uniforms.uNormalMap.value = normalMap;
    uniforms.uHeight.value = heightTex;
    uniforms.uHorizon = sky.uniforms.uHorizon;
    uniforms.uZenith = sky.uniforms.uZenith;
    uniforms.uSunDir = sky.uniforms.uSunDir;
    uniforms.uSunColor = sky.uniforms.uSunColor;
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: true,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
  }

  const group = new THREE.Group();
  group.name = 'water';

  const oceanMat = makeMaterial(WORLD.seaLevel, '#184c6e', '#2fa3a3', 1.0);
  // Follows the camera in x/z (the shader works in world space) so it always reaches the far plane.
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(58000, 58000, 1, 1).rotateX(-Math.PI / 2), oceanMat);
  ocean.position.y = WORLD.seaLevel;
  ocean.frustumCulled = false;
  ocean.renderOrder = 1;
  ocean.name = 'ocean';
  group.add(ocean);

  const L = terrain.layout.lake;
  const lakeMat = makeMaterial(terrain.lakeLevel, '#123f4a', '#3a8c7c', 0.35);
  const lakeGeo = new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2);
  const lake = new THREE.Mesh(lakeGeo, lakeMat);
  // ellipse covering the whole lake (shape wobble ≤ ~20 %)
  lake.scale.set(L.rx * 1.45, 1, L.rz * 1.45);
  lake.rotation.y = L.angle;
  lake.position.set(L.x, terrain.lakeLevel, L.z);
  lake.renderOrder = 1;
  lake.name = 'lake';
  group.add(lake);

  const mats = [oceanMat, lakeMat];
  let time = 0;
  function update(dt, camera) {
    time += dt;
    if (camera) { ocean.position.x = camera.position.x; ocean.position.z = camera.position.z; }
    for (const m of mats) m.uniforms.uTime.value = time;
  }
  return { group, update, heightTex };
}
