// W4 airports: incremental re-draping. ctx.terrain.getHeight samples the terrain LOD that is currently rendered, so an
// airport built while the camera was far away sits on coarse heights (errors of 1-2 m measured). While the camera is
// near an airport, its heights are re-sampled a few thousand per frame and every draped thing is re-grounded:
// pavement + paint vertices, light sprites, light fixtures, signs, props and whole buildings.
import * as THREE from 'three';

/** A drape job walks `n` items: sample(i) -> [worldX, worldZ]; apply(i, h) -> true if something moved. */
export class Draper {
  constructor(terrain) {
    this.terrain = terrain;
    this.jobs = [];
    this.cursor = 0;       // job index
    this.item = 0;         // item index inside the job
    this.changed = false;
    this.maxDelta = 0;
    this.passes = 0;
  }
  add(job) { this.jobs.push(job); }
  get busy() { return this.jobs.length > 0 && (this.cursor > 0 || this.item > 0); }
  /** Process up to `budget` samples; returns true when a full pass has completed. */
  step(budget) {
    if (!this.jobs.length) return true;
    const t = this.terrain;
    while (budget > 0) {
      const job = this.jobs[this.cursor];
      const end = Math.min(job.n, this.item + budget);
      let changed = false;
      for (let i = this.item; i < end; i++) {
        const [x, z] = job.sample(i);
        if (job.apply(i, t.getHeight(x, z))) changed = true;
      }
      budget -= end - this.item;
      this.item = end;
      if (changed) job.dirty = true;
      if (this.item >= job.n) {
        if (job.dirty && job.done) job.done();
        if (job.dirty) this.changed = true;
        job.dirty = false;
        this.item = 0;
        this.cursor++;
        if (this.cursor >= this.jobs.length) {
          this.cursor = 0;
          this.passes++;
          return true;
        }
      }
    }
    return false;
  }
}

const EPS = 0.03;

/** Pavement / paint mesh: positions x,z are relative to `origin`, y = ground + off. */
export function meshJob(mesh, origin, off) {
  const pos = mesh.geometry.attributes.position;
  const a = pos.array;
  const [ox, oz] = origin;
  const s = [0, 0];
  return {
    n: pos.count,
    sample(i) { s[0] = a[3 * i] + ox; s[1] = a[3 * i + 2] + oz; return s; },
    apply(i, h) { const y = h + off; if (Math.abs(a[3 * i + 1] - y) > EPS) { a[3 * i + 1] = y; return true; } return false; },
    done() { pos.needsUpdate = true; mesh.geometry.computeBoundingSphere(); },
  };
}

/** Instanced light sprites: iPos (x, y, z) with per-light height rule. */
export function lightsJob(mesh, origin, heights, modes, isWater) {
  const attr = mesh.geometry.attributes.iPos;
  const a = attr.array;
  const [ox, oz] = origin;
  const s = [0, 0];
  return {
    n: attr.count,
    sample(i) { s[0] = a[3 * i] + ox; s[1] = a[3 * i + 2] + oz; return s; },
    apply(i, g) {
      const mode = modes[i], h = heights[i];
      if (mode === 1) return false;
      const water = mode === 2 && isWater && isWater(s[0], s[1]);
      const y = mode === 0 ? g + h : Math.max(h, (water ? 0 : g) + 0.1);
      if (Math.abs(a[3 * i + 1] - y) > EPS) { a[3 * i + 1] = y; return true; }
      return false;
    },
    done() { attr.needsUpdate = true; },
  };
}

const _m = new THREE.Matrix4();
/** InstancedMesh whose instances sit on the ground (+dy): re-grounds the matrix translation. */
export function instancedJob(im, origin, dy = 0) {
  const [ox, oz] = origin;
  const arr = im.instanceMatrix.array;
  const s = [0, 0];
  return {
    n: im.count,
    sample(i) { s[0] = arr[16 * i + 12] + ox; s[1] = arr[16 * i + 14] + oz; return s; },
    apply(i, h) { const y = h + dy; if (Math.abs(arr[16 * i + 13] - y) > EPS) { arr[16 * i + 13] = y; return true; } return false; },
    done() { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); },
  };
}

/** Rigid groups of vertices inside merged geometries (buildings, signs): each group moves by the change of the ground
 *  height at its anchor. groups: [{ ax, az (world), g (ground used), ranges: [[geometry, start, count], ...] }] */
export function rigidJob(groups) {
  const touched = new Set();
  const s = [0, 0];
  return {
    n: groups.length,
    sample(i) { s[0] = groups[i].ax; s[1] = groups[i].az; return s; },
    apply(i, h) {
      const gr = groups[i];
      const dy = h - gr.g;
      if (Math.abs(dy) <= EPS) return false;
      gr.g = h;
      for (const [geo, start, count] of gr.ranges) {
        const a = geo.attributes.position.array;
        for (let k = start; k < start + count; k++) a[3 * k + 1] += dy;
        touched.add(geo);
      }
      return true;
    },
    done() {
      for (const geo of touched) { geo.attributes.position.needsUpdate = true; geo.computeBoundingSphere(); }
      touched.clear();
    },
  };
}
