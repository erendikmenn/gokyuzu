// Shared asset loading: one GLTFLoader configured with Draco, Meshopt and KTX2 decoders.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const LIBS = new URL('../../node_modules/three/examples/jsm/libs/', import.meta.url).href;

export function createAssetLoader(renderer, manager = THREE.DefaultLoadingManager) {
  const draco = new DRACOLoader(manager).setDecoderPath(LIBS + 'draco/gltf/');
  const ktx2 = new KTX2Loader(manager).setTranscoderPath(LIBS + 'basis/');
  if (renderer) ktx2.detectSupport(renderer);
  const gltf = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const texture = new THREE.TextureLoader(manager);
  const file = new THREE.FileLoader(manager).setResponseType('arraybuffer');
  const cache = new Map();
  return {
    gltf, ktx2, draco, texture, file, manager,
    /** Load a GLB once; subsequent calls return the same promise (clone the scene yourself if you need copies). */
    loadGLTF(url) {
      if (!cache.has(url)) cache.set(url, gltf.loadAsync(url));
      return cache.get(url);
    },
    loadTexture(url, { srgb = true } = {}) {
      return texture.loadAsync(url).then((t) => { if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; });
    },
    loadJSON(url) { return fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }); },
    loadBinary(url) { return fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); }); },
  };
}
