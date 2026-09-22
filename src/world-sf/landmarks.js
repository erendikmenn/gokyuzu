// STUB (replaced by its owner agent): empty layer.
import * as THREE from 'three';
export async function createLandmarks(ctx) {
  return { object: new THREE.Group(), update() {}, heightAt: () => -Infinity, hitTest: () => null, ready: Promise.resolve() };
}
