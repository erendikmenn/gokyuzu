// STUB (AV replaces): every display shows its type and "NO DATA".
import * as THREE from 'three';
export function createDisplay(type, { size = 512 } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return {
    canvas, texture,
    update(dt, flight) {
      g.fillStyle = '#05080c'; g.fillRect(0, 0, size, size);
      g.fillStyle = '#3cff7a'; g.font = `${size / 14}px monospace`; g.fillText(type, 20, 60);
      g.fillText(`IAS ${(flight.ias * 1.944).toFixed(0)}  ALT ${(flight.altitude * 3.281).toFixed(0)}`, 20, size / 2);
      texture.needsUpdate = true;
    },
  };
}
