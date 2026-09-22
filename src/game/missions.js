// STUB: replaced by Agent D.
export function createMissions(scene, world) {
  const state = { title: 'Serbest uçuş', objective: '', score: 0, ringsDone: 0, ringsTotal: 0, time: 0, bestTime: null, nextTarget: null };
  return { update(dt) { state.time += dt; return state; }, reset() { state.time = 0; }, onEvent() {} };
}
