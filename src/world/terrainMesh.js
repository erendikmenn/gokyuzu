// Terrain rendering: the (N+1)² height grid split into 4×4 chunk meshes (frustum culling,
// ≤16 draw calls, 16-bit-safe index sharing) with one MeshStandardMaterial whose shader is
// extended with world-space detail texturing and crisp procedural farmland fields.
import * as THREE from 'three';
import { makeDetailTexture, makeMaskTexture } from './textures.js';

const CHUNKS = 4;

export function createTerrainMesh(terrain, renderer) {
  const { N, V, cell, half, heights, normals, colors, farm, surf: surfData } = terrain;
  const seg = N / CHUNKS;          // cells per chunk side
  const cv = seg + 1;              // vertices per chunk side

  // Shared index buffer (identical topology for every chunk).
  const idx = new Uint32Array(seg * seg * 6);
  let k = 0;
  for (let z = 0; z < seg; z++) {
    for (let x = 0; x < seg; x++) {
      const a = z * cv + x, b = a + 1, c = a + cv, d = c + 1;
      // diagonal b–c: must match sampleGrid() in terrain.js
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = c; idx[k++] = d; idx[k++] = b;
    }
  }
  const index = new THREE.BufferAttribute(idx, 1);

  const detail = makeDetailTexture(renderer);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
  });
  const farmTex = makeMaskTexture(farm, V);
  material.userData.uniforms = {
    uDetail: { value: detail },
    uFarm: { value: farmTex },
    uGridRect: { value: new THREE.Vector3(-half, 1 / (N * cell), 0.5 / V) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 surf;
        varying vec4 vSurf;
        varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurf = surf;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetail;
        uniform sampler2D uFarm;
        uniform vec3 uGridRect;
        varying vec4 vSurf;
        float tBump;
        vec3 perturbNormalTerrain(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
          vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
          vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
          vec3 R1 = cross(vSigmaY, surf_norm);
          vec3 R2 = cross(surf_norm, vSigmaX);
          float fDet = dot(vSigmaX, R1) * faceDir;
          vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
          return normalize(abs(fDet) * surf_norm - vGrad);
        }
        varying vec3 vWPos;
        float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
        float farmAt(vec2 p) {
          vec2 uv = (p - uGridRect.x) * uGridRect.y;
          return texture2D(uFarm, uv * (1.0 - 2.0 * uGridRect.z) + uGridRect.z).r;
        }
        // returns rgb = field color, a = field coverage (whole fields on/off by the mask at their center)
        vec4 fieldColor(vec2 p, float dist) {
          vec2 q = mat2(0.94, -0.342, 0.342, 0.94) * p;
          // irregular field widths: each column has its own width scale
          float colW = 150.0;
          float cx = floor(q.x / colW);
          float rowH = 90.0 + 90.0 * fhash(vec2(cx, 3.1));
          float cz = floor(q.y / rowH);
          vec2 id = vec2(cx, cz);
          vec2 f = vec2(fract(q.x / colW), fract(q.y / rowH));
          vec2 centerQ = vec2((cx + 0.5) * colW, (cz + 0.5) * rowH);
          vec2 centerP = centerQ * mat2(0.94, -0.342, 0.342, 0.94);
          float on = step(0.45, farmAt(centerP));
          // split some fields lengthwise
          float fwM = colW;
          if (fhash(id + 7.7) > 0.55) { id.x += step(0.5, f.x) * 0.5; f.x = fract(f.x * 2.0); fwM *= 0.5; }
          float h = fhash(id * 1.37 + 0.5);
          vec3 c;
          if (h < 0.22) c = vec3(0.80, 0.70, 0.40);        // ripe wheat
          else if (h < 0.42) c = vec3(0.40, 0.56, 0.22);   // young crop
          else if (h < 0.56) c = vec3(0.55, 0.64, 0.30);   // pasture
          else if (h < 0.72) c = vec3(0.50, 0.40, 0.29);   // ploughed soil
          else if (h < 0.84) c = vec3(0.70, 0.64, 0.42);   // stubble / hay
          else if (h < 0.93) c = vec3(0.34, 0.47, 0.19);   // dark crop
          else c = vec3(0.86, 0.78, 0.30);                 // sunflower / rapeseed
          c = lin(c);
          // crop rows
          float fw = max(fwidth(q.x), 0.001);
          float rowFade = 1.0 - smoothstep(0.3, 1.2, fw);
          float dirSel = step(0.5, fhash(id + 3.3));
          float rc = mix(q.x, q.y, dirSel);
          c *= 1.0 + 0.10 * sin(rc * 6.2832 / 2.4) * rowFade;
          // field borders (grass/hedge tracks)
          vec2 e = min(f, 1.0 - f) * vec2(fwM, rowH);
          float bw = max(fwidth(q.x), fwidth(q.y));
          float border = 1.0 - smoothstep(1.2, 1.2 + 2.0 * bw + 1.0, min(e.x, e.y));
          c = mix(c, lin(vec3(0.33, 0.42, 0.2)), border * 0.85);
          return vec4(c, on);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float dist = length(vWPos - cameraPosition);
          vec4 dA = texture2D(uDetail, vWPos.xz / 29.0);
          vec4 dB = texture2D(uDetail, vWPos.xz / 233.0);
          vec4 dC = texture2D(uDetail, vWPos.xz / 4.3);
          float nearF = 1.0 - smoothstep(60.0, 260.0, dist);
          float midF = 1.0 - smoothstep(900.0, 3500.0, dist);
          float rockW = vSurf.z;
          float det = 1.0;
          det *= mix(1.0, 0.8 + 0.4 * dA.r, midF);
          det *= 0.8 + 0.4 * dB.g;
          det *= mix(1.0, 0.8 + 0.4 * dC.b, nearF);
          if (vSurf.x > 0.004) {
            vec4 fc = fieldColor(vWPos.xz, dist);
            diffuseColor.rgb = mix(diffuseColor.rgb, fc.rgb, fc.a * smoothstep(0.05, 0.7, vSurf.x));
          }
          // forest floor / canopy mottling (reads as tree crowns from altitude)
          float canopy = texture2D(uDetail, vWPos.xz / 41.0).b;
          diffuseColor.rgb *= 1.0 - vSurf.y * (0.12 + 0.18 * dB.r) * (0.6 + 0.8 * canopy);
          // rock: horizontal strata + stronger contrast
          if (rockW > 0.01) {
            float strata = texture2D(uDetail, vec2(vWPos.y / 23.0 + dA.g * 0.35, vWPos.x / 1700.0 + vWPos.z / 2300.0)).a;
            vec3 rt = mix(vec3(0.78, 0.76, 0.73), vec3(1.14, 1.1, 1.04), strata) * (0.78 + 0.44 * dA.a);
            diffuseColor.rgb *= mix(vec3(1.0), rt, rockW);
          }
          // wet sand darker near the waterline, ripples
          diffuseColor.rgb *= 1.0 - vSurf.w * 0.08 * dC.b;
          diffuseColor.rgb *= det;
          // bump height for the normal perturbation below
          float bumpK = mix(0.18, 2.2, rockW) * (1.0 - smoothstep(120.0, 600.0, dist));
          tBump = (dA.r * 0.55 + dC.b * 0.25 + dA.a * 0.2) * bumpK;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = perturbNormalTerrain(-vViewPosition, normal, vec2(dFdx(tBump), dFdy(tBump)), faceDirection);`);
  };

  const group = new THREE.Group();
  group.name = 'terrain';
  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) {
      const count = cv * cv;
      const pos = new Float32Array(count * 3);
      const nor = new Float32Array(count * 3);
      const col = new Uint8Array(count * 3);
      const surf = new Uint8Array(count * 4);
      for (let z = 0; z < cv; z++) {
        const gz = cz * seg + z;
        for (let x = 0; x < cv; x++) {
          const gx = cx * seg + x;
          const g = gz * V + gx;
          const l = z * cv + x;
          pos[l * 3] = -half + gx * cell;
          pos[l * 3 + 1] = heights[g];
          pos[l * 3 + 2] = -half + gz * cell;
          nor[l * 3] = normals[g * 3];
          nor[l * 3 + 1] = normals[g * 3 + 1];
          nor[l * 3 + 2] = normals[g * 3 + 2];
          col[l * 3] = colors[g * 3];
          col[l * 3 + 1] = colors[g * 3 + 1];
          col[l * 3 + 2] = colors[g * 3 + 2];
          surf[l * 4] = surfData[g * 4];
          surf[l * 4 + 1] = surfData[g * 4 + 1];
          surf[l * 4 + 2] = surfData[g * 4 + 2];
          surf[l * 4 + 3] = surfData[g * 4 + 3];
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
      geo.setAttribute('surf', new THREE.BufferAttribute(surf, 4, true));
      geo.setIndex(index);
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.name = `terrain_${cx}_${cz}`;
      group.add(mesh);
    }
  }
  return { group, material, detail };
}
