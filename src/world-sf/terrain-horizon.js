// W1: horizon ring around the terrain quadtree root (131 km square) out to ~500 km, so high-altitude views never show
// the edge of the data: Pacific Ocean west of the coast, generic hazy land elsewhere (aerial perspective does the rest).
import * as THREE from 'three';

/** waveUniform: the terrain's shared { value: waves texture } (the full texture replaces a small one after the start). */
export function createHorizonRing({ rootMinX, rootMinZ, rootSize, waveUniform, oceanGLSL = null }) {
  const x0 = rootMinX, z0 = rootMinZ, x1 = rootMinX + rootSize, z1 = rootMinZ + rootSize;
  const R = 500000;
  // square annulus as 4 quads (outer square -> inner square)
  const pos = [
    -R, 0, -R, R, 0, -R, x1, 0, z0, x0, 0, z0,     // north band
    R, 0, -R, R, 0, R, x1, 0, z1, x1, 0, z0,       // east band
    R, 0, R, -R, 0, R, x0, 0, z1, x1, 0, z1,       // south band
    -R, 0, R, -R, 0, -R, x0, 0, z0, x0, 0, z1,     // west band
  ];
  const idx = [];
  for (let q = 0; q < 4; q++) { const b = q * 4; idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(16).fill(0).flatMap(() => [0, 1, 0]), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const uniforms = { uWaveTex: waveUniform };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  m.name = 'sf-horizon';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHzWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvHzWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHzWorld;\nuniform sampler2D uWaveTex;\nfloat hzOcean;')
      .replace('#include <map_fragment>', `
        {
          vec2 p = vHzWorld.xz;
          // Pacific: everything west of the root, plus the offshore parts of the north/south bands
          ${oceanGLSL || `float coastX = p.y > 0.0 ? mix(-12000.0, 10000.0, clamp((p.y - 55000.0) / 60000.0, 0.0, 1.0))
                                   : mix(-58000.0, -95000.0, clamp((-p.y - 75000.0) / 80000.0, 0.0, 1.0));
          hzOcean = smoothstep(coastX + 3000.0, coastX - 3000.0, p.x);`}
          vec3 land = vec3(0.20, 0.17, 0.12) * (0.85 + 0.3 * texture2D(uWaveTex, p / 23000.0).b);
          diffuseColor.rgb = mix(land, vec3(0.006, 0.022, 0.040), hzOcean);
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.95, 0.22, hzOcean);')
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.specularColor = mix(vec3(0.01), vec3(0.02), hzOcean);
        material.specularColorBlended = material.specularColor;
        material.specularF90 = mix(0.3, 1.0, hzOcean);`);
  };
  m.customProgramCacheKey = () => (oceanGLSL ? 'sf-horizon-1o' : 'sf-horizon-1');
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'sf-horizon-ring';
  mesh.position.y = -0.5;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}
