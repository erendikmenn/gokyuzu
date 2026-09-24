// Lead-owned: composes the world from the environment/terrain (W1), city (W2), landmarks (W3) and airports (W4), for the
// active map (src/maps/index.js; default San Francisco): every file comes from its data/<id>/ and assets/<id>/. Another
// map may still lack layers while it is built: a missing file (404 / 403) skips that layer (terrain: sea level).
import * as THREE from 'three';
import { createEnvironment } from './environment.js';
import { createTerrain } from './terrain.js';
import { createCity } from './city.js';
import { createLandmarks } from './landmarks.js';
import { createAirports } from './airports.js';
import { isNetworkError } from '../core/assets.js';

export async function createSFWorld({ scene, renderer, camera, loader, quality = null, focus = { x: 0, z: 0 }, onProgress = () => {}, map = null, runways: given = null }) {
  const other = map && map.id !== 'sf', D = map ? map.data : 'data/sf/';
  const optional = (p, empty) => (other ? p.catch((e) => { if (e && (e.status === 404 || e.status === 403)) return empty; throw e; }) : p);
  const [runways, landmarks, region] = await Promise.all([
    given || optional(loader.loadJSON(D + 'runways.json'), { airports: [] }), optional(loader.loadJSON(D + 'landmarks.json'), { landmarks: [] }), loader.loadJSON(D + 'region.json'),
  ]);
  const ctx = { scene, renderer, camera, loader, runways, landmarks, region, focus, quality, map };   // quality: src/core/quality.js preset (factories may read it at creation)
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
      if (isNetworkError(e)) throw e;   // connection lost: main.js shows the connection error screen
      if (other && e && (e.status === 404 || e.status === 403)) console.info(`[world] ${map.id}: no ${label.toLowerCase()} yet (${e.message})`);
      else console.error(`[world] ${label} failed to load`, e);
    }
  }
  onProgress(0.85, 'Detaylar yükleniyor');
  await Promise.all([terrain.ready, ...layers.map((l) => l.ready)].map((p) => Promise.resolve(p).catch((e) => { if (isNetworkError(e)) throw e; console.error(e); })));
  onProgress(1, 'Hazır');
  if (quality) for (const part of [environment, terrain, ...layers]) if (part && part.setQuality) { try { part.setQuality(quality); } catch (e) { console.error('[world] setQuality', e); } }

  // runway rectangles for isOnRunway
  const rects = [];
  for (const apt of runways.airports) for (const r of apt.runways) {
    const [a, b] = r.ends;
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    rects.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2, airport: apt.icao, id: r.id });
  }

  const spanScratch = { bottom: -Infinity, top: -Infinity };
  return {
    runways, landmarks, region, environment, terrain, layers,
    towers: layers.flatMap((l) => l.towers || []),   // control-tower cab eye points (airports layer) for the tower camera
    sunDirection: environment.sunDirection,
    /** Apply a src/core/quality.js preset to every part that supports it (CONTRACTS-SF.md §8). */
    setQuality(q) {
      ctx.quality = q;
      for (const part of [environment, terrain, ...layers]) if (part && part.setQuality) { try { part.setQuality(q); } catch (e) { console.error('[world] setQuality', e); } }
    },
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
    getObstacleSpan(x, z, out = { bottom: -Infinity, top: -Infinity }) {
      let solidTop = -Infinity, spanTop = -Infinity, spanBottom = Infinity;
      for (const l of layers) {
        if (l.spanAt) {
          const s = l.spanAt(x, z, spanScratch);
          if (Number.isFinite(s.bottom)) { if (s.top > spanTop) { spanTop = s.top; spanBottom = s.bottom; } }
          else if (s.top > solidTop) solidTop = s.top;
        } else {
          const t = l.heightAt(x, z);
          if (t > solidTop) solidTop = t;
        }
      }
      if (spanTop === -Infinity || solidTop >= spanTop) { out.bottom = -Infinity; out.top = solidTop; }
      else { out.bottom = Math.max(spanBottom, solidTop); out.top = spanTop; }
      return out;
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
