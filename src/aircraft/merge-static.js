// Static parts that share a material, drawn as one mesh: the rig of a model whose build keeps them as separate nodes
// (the A320's wings, tail surfaces and the two engines' nacelle parts) merges them when it is created, so each material
// costs one draw call (and one per shadow cascade) instead of one per part. Same material object, geometry baked into
// the model's frame: the same picture.
// The original meshes stay in the scene graph (names, nodes, bounds for anything that looks them up) but are never drawn:
// their layer mask is cleared (three.js tests layers per object, not per subtree) and their geometry released.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Merge the meshes of the named nodes by material. The nodes must be ones the rig never moves or hides, without child
 * nodes. Materials used by a single part, see-through materials and parts smaller than `minRadius` (the mobile shadow
 * rules in src/app/main.js class casters by their bounding radius) are left alone.
 * @returns {{ merged: THREE.Mesh[], originals: THREE.Mesh[] } | null} (null: a skeleton of placeholders, nothing merged)
 */
export function mergeStatic(root, nodeNames, { minRadius = 0.5 } = {}) {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map();
  for (const n of nodeNames) {
    const node = root.getObjectByName(n);
    if (!node) continue;
    const parts = node.isMesh ? [node] : node.children.filter((c) => c.isMesh && !c.children.length);
    for (const m of parts) {
      const mat = m.material;
      if (m.userData.placeholder) return null;   // the LOD stand-in's skeleton (src/app/aircraft-lod.js)
      if (!mat || Array.isArray(mat) || mat.transparent || mat.transmission > 0) continue;
      if (Object.keys(m.geometry.morphAttributes || {}).length) continue;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      if (m.geometry.boundingSphere.radius * m.matrixWorld.getMaxScaleOnAxis() < minRadius) continue;
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat).push(m);
    }
  }
  const out = { merged: [], originals: [] };
  const rel = new THREE.Matrix4();
  for (const [mat, parts] of byMat) {
    if (parts.length < 2) continue;
    const geos = parts.map((m) => {
      rel.multiplyMatrices(toRoot, m.matrixWorld);
      const g = m.geometry.clone().applyMatrix4(rel);
      // a mirrored part (negative determinant: three.js draws it with the front face flipped) keeps its facing once the
      // mirror is baked in only with its triangles wound the other way
      if (rel.determinant() < 0) {
        if (!g.index) return null;
        const ix = g.index.array;
        for (let i = 0; i + 2 < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
      }
      return g;
    });
    const geo = geos.includes(null) ? null : mergeGeometries(geos, false);
    for (const g of geos) if (g) g.dispose();
    if (!geo) continue;   // attribute sets differ: keep the parts as they are
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `static_${mat.name || 'merged'}`;
    mesh.renderOrder = parts[0].renderOrder;
    mesh.castShadow = parts.some((m) => m.castShadow);
    mesh.receiveShadow = parts.some((m) => m.receiveShadow);
    root.add(mesh);
    out.merged.push(mesh);
    for (const m of parts) {
      m.layers.disableAll();                  // never drawn (view, shadow passes), still in the graph
      m.geometry = new THREE.BufferGeometry();   // (the merged copy holds the vertices; this one was never uploaded)
      out.originals.push(m);
    }
  }
  return out;
}
