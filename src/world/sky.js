// Sky dome (analytic gradient + sun), fog matched to the horizon, hemisphere + sun lights,
// a sky-based environment map for PBR materials, and a shadow frustum that follows the camera.
import * as THREE from 'three';
import { WORLD } from '../config.js';

// Afternoon sun: ~35° elevation, from the south-west (behind the player at spawn, who faces -Z).
const SUN_ELEVATION = THREE.MathUtils.degToRad(35);
const SUN_AZIMUTH = THREE.MathUtils.degToRad(32); // measured from +Z (south) toward -X (west)

export const SKY_COLORS = {
  horizon: new THREE.Color('#c3d6e6'),
  zenith: new THREE.Color('#3f79c4'),
  sun: new THREE.Color('#fff2de'),
};

const SHADOW_HALF = 200;     // shadow frustum half-size (m) → 400 m square
const SHADOW_MAP = 2048;

export const skyGLSL = /* glsl */`
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  vec3 skyColor(vec3 d, float sunDisc) {
    float y = d.y;
    float t = pow(clamp(y, 0.0, 1.0), 0.42);
    vec3 col = mix(uHorizon, uZenith, t);
    // slight whitening right at the horizon (haze band)
    col = mix(col, uHorizon * 1.06, (1.0 - smoothstep(0.0, 0.08, abs(y))) * 0.6);
    if (y < 0.0) col = uHorizon;
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 48.0) * 0.35 + pow(sd, 600.0) * 1.2);
    col += uSunColor * smoothstep(0.99955, 0.99975, sd) * 30.0 * sunDisc;
    return col;
  }
`;

function makeSkyMaterial(uniforms, sunDisc) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // at the far plane
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      ${skyGLSL}
      void main() {
        vec3 col = skyColor(normalize(vDir), ${sunDisc ? '1.0' : '0.0'});
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,   // horizon must match the (un-tonemapped) fog color exactly
  });
}

export function createSky(scene, renderer) {
  const sunDirection = new THREE.Vector3(
    -Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
    Math.sin(SUN_ELEVATION),
    Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  ).normalize();

  const uniforms = {
    uHorizon: { value: SKY_COLORS.horizon },
    uZenith: { value: SKY_COLORS.zenith },
    uSunDir: { value: sunDirection },
    uSunColor: { value: SKY_COLORS.sun },
  };

  scene.background = SKY_COLORS.horizon.clone();
  scene.fog = new THREE.Fog(SKY_COLORS.horizon.clone(), WORLD.fogNear, WORLD.fogFar);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), makeSkyMaterial(uniforms, true));
  dome.scale.setScalar(10000);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.name = 'sky';
  scene.add(dome);

  // Environment map from the same sky (no sun disc → no double highlight with the real sun).
  try {
    const envScene = new THREE.Scene();
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), makeSkyMaterial(uniforms, false));
    envScene.add(envDome);
    // a dark-green "ground" hemisphere so reflections below the horizon are not sky blue
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(9, 32, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2 - 0.02),
      new THREE.MeshBasicMaterial({ color: '#4d5a3c', side: THREE.BackSide }),
    );
    envScene.add(ground);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(envScene, 0.02);
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
  } catch (e) {
    console.warn('world: environment map failed', e);
  }

  const hemi = new THREE.HemisphereLight('#c4dcf5', '#5b6441', 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(SKY_COLORS.sun, 3.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
  sc.near = 10; sc.far = 4000;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.12;
  sun.shadow.intensity = 0.85;
  scene.add(sun);
  scene.add(sun.target);

  // Light-space basis for texel snapping (matches the shadow camera's lookAt with up = +Y).
  const lz = sunDirection.clone();
  const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), lz).normalize();
  const ly = new THREE.Vector3().crossVectors(lz, lx);
  const texel = (2 * SHADOW_HALF) / SHADOW_MAP;
  const fwd = new THREE.Vector3();
  const center = new THREE.Vector3();

  function update(dt, camera) {
    if (!camera) return;
    dome.position.copy(camera.position);
    camera.getWorldDirection(fwd);
    // Center the shadow box ahead of the camera (covers the aircraft in chase/cockpit views).
    center.copy(camera.position).addScaledVector(fwd, SHADOW_HALF * 0.55);
    let a = center.dot(lx), b = center.dot(ly);
    const c = center.dot(lz);
    a = Math.round(a / texel) * texel;
    b = Math.round(b / texel) * texel;
    center.set(0, 0, 0).addScaledVector(lx, a).addScaledVector(ly, b).addScaledVector(lz, c);
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(lz, 2000);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }
  update(0, null);
  sun.target.position.set(0, 0, 0);
  sun.position.copy(sunDirection).multiplyScalar(2000);

  return { sunDirection, sun, hemi, dome, uniforms, update };
}
