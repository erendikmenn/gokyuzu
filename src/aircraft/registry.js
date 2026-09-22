// Lead-owned: the playable aircraft. Each entry loads its model (aircraft agent) and spec (physics agent) lazily.
export const AIRCRAFT = [
  { id: 'f16', name: 'F-16C Fighting Falcon', role: 'Savaş uçağı', category: 'fighter', defaultSpawn: 'KNGZ-24' },
  { id: 'f22', name: 'F-22A Raptor', role: 'Hava üstünlük uçağı', category: 'fighter', defaultSpawn: 'KNGZ-24' },
  { id: 'a320neo', name: 'Airbus A320neo', role: 'Yolcu uçağı', category: 'airliner', defaultSpawn: 'KSFO-28R' },
  { id: 'b737', name: 'Boeing 737-800', role: 'Yolcu uçağı', category: 'airliner', defaultSpawn: 'KSFO-28L' },
  { id: 'uh60', name: 'UH-60M Black Hawk', role: 'Helikopter', category: 'helicopter', defaultSpawn: 'KNGZ-24' },
];

export async function loadAircraftDefinition(id) {
  const entry = AIRCRAFT.find((a) => a.id === id);
  if (!entry) throw new Error(`unknown aircraft ${id}`);
  const [modelMod, specMod] = await Promise.all([import(`./${id}/model.js`), import(`./${id}/spec.js`)]);
  return { ...entry, model: modelMod.model, createRig: modelMod.createRig, spec: specMod.default };
}
