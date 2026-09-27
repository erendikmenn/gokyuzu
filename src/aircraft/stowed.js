// Parts nothing outside the aircraft can see in some states: the gear legs and wheels once the bay doors are shut, the
// inner faces of shut doors, the thrust-reverser cascades inside a stowed sleeve. The rigs hide them in those states
// (Object3D.visible = false, which also keeps them out of every shadow pass): on a tablet the F-16's retracted gear was
// 15 meshes drawn once in the view and once or twice more in the shadow cascades.
// Which parts, and in which states, was measured, not guessed: an ID-buffer render of each model from ~600 outside
// viewpoints per state (full-frame, close and belly close-up rings, mirrored about the plane of symmetry) — a part is
// listed only where it covered no pixel in any of them.
// Only meshes are hidden, never the nodes above them: lights hang under the gear legs, and a hidden parent would take the
// landing light out of the scene's light list (three.js recompiles every lit shader for a new light count).

/**
 * Meshes under the named nodes of `root` that `pick(mesh, nodeName)` accepts (default: all), in a switch that only
 * writes `visible` when the state changes.
 * @returns {{ meshes: THREE.Mesh[], set(hidden: boolean): void }}
 */
export function stowedParts(root, nodeNames, pick = () => true) {
  const meshes = [];
  for (const name of nodeNames) {
    const node = root.getObjectByName(name);
    if (!node) continue;
    node.traverse((o) => { if (o.isMesh && !meshes.includes(o) && pick(o, name)) meshes.push(o); });
  }
  let state = null;
  return {
    meshes,
    set(hidden) {
      hidden = !!hidden;
      if (hidden === state) return;
      state = hidden;
      for (const m of meshes) m.visible = !hidden;
    },
  };
}

/** Material name of a mesh (first material). */
export const matName = (m) => { const x = Array.isArray(m.material) ? m.material[0] : m.material; return (x && x.name) || ''; };
