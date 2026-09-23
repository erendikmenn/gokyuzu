// Lead-owned: composes the SF world from the environment/terrain (W1), city (W2), landmarks (W3) and airports (W4).
import * as THREE from 'three';
import { createEnvironment } from './environment.js';
import { createTerrain } from './terrain.js';
import { createCity } from './city.js';
import { createLandmarks } from './landmarks.js';
import { createAirports } from './airports.js';

export async function createSFWorld({ scene, renderer, camera, loader, focus = { x: 0, z: 0 }, onProgress = () => {} }) {
  const [runways, landmarks, region] = await Promise.all([
    loader.loadJSON('data/sf/runways.json'), loader.loadJSON('data/sf/landmarks.json'), loader.loadJSON('data/sf/region.json'),
  ]);
  const ctx = { scene, renderer, camera, loader, runways, landmarks, region, focus };
  onProgress(0.05, 'Gökyüzü ve ışık');
  const environment = await createEnvironment(ctx);
  onProgress(0.15, 'Arazi ve hava fotoğrafları');
  const terrain = await createTerrain(ctx);
  scene.add(terrain.object);
  ctx.terrain = terrain;

  const layers = [];
  const steps = [['Havalimanları', createAirports], ['Şehir', createCity], ['Simge yapılar', createLandmarks]];
  for (let i = 0; i < steps.length; i++) {
    const [label, factory] = steps[i];
    onProgress(0.3 + 0.5 * i / steps.length, label);
    try {
      const layer = await factory(ctx);
      scene.add(layer.object);
      layers.push(layer);
    } catch (e) {
      console.error(`[world] ${label} failed to load`, e);
    }
  }
  onProgress(0.85, 'Detaylar yükleniyor');
  await Promise.all([terrain.ready, ...layers.map((l) => l.ready)].map((p) => Promise.resolve(p).catch((e) => console.error(e))));
  onProgress(1, 'Hazır');

  // runway rectangles for isOnRunway
  const rects = [];
  for (const apt of runways.airports) for (const r of apt.runways) {
    const [a, b] = r.ends;
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    rects.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2, airport: apt.icao, id: r.id });
  }

  return {
    runways, landmarks, region, environment, terrain, layers,
    towers: layers.flatMap((l) => l.towers || []),   // control-tower cab eye points (airports layer) for the tower camera
    sunDirection: environment.sunDirection,
    getGroundHeight: (x, z) => terrain.getHeight(x, z),
    isWater: (x, z) => terrain.isWater(x, z),
    runwayAt(x, z) {
      for (const r of rects) {
        const px = x - r.ax, pz = z - r.az;
        const along = px * r.ux + pz * r.uz;
        if (along < 0 || along > r.len) continue;
        if (Math.abs(px * -r.uz + pz * r.ux) <= r.half) return r;
      }
      return null;
    },
    isOnRunway(x, z) { return this.runwayAt(x, z) !== null; },
    getObstacleHeight(x, z) {
      let h = -Infinity;
      for (const l of layers) { const v = l.heightAt(x, z); if (v > h) h = v; }
      return h;
    },
    /**
     * Vertical extent of the obstacles above (x, z): { bottom, top }. Solid obstacles (buildings, towers) have
     * bottom = -Infinity; bridge decks report their underside as bottom so flying under them is not a pull-up.
     */
    getObstacleSpan(x, z) {
      let solidTop = -Infinity, span = null;
      for (const l of layers) {
        const s = l.spanAt ? l.spanAt(x, z) : null;
        if (s && Number.isFinite(s.bottom)) { if (!span || s.top > span.top) span = s; }
        else { const t = s ? s.top : l.heightAt(x, z); if (t > solidTop) solidTop = t; }
      }
      if (!span || solidTop >= span.top) return { bottom: -Infinity, top: solidTop };
      return { bottom: Math.max(span.bottom, solidTop), top: span.top };
    },
    hitTest(x, y, z, r) {
      for (const l of layers) { const hit = l.hitTest(x, y, z, r); if (hit) return hit; }
      return null;
    },
    update(dt, cam) {
      environment.update(dt, cam);
      terrain.update(dt, cam);
      for (const l of layers) l.update(dt, cam);
    },
  };
}
