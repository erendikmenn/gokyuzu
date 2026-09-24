// Flat double-sided transparent panes of the aircraft models (HUD combiners, gauge glass, sun visors; the fan blur
// discs are built with the flag in their model.js). three.js draws a double-sided transparent material in two passes
// (back faces, then front faces) so a closed transparent shell blends in the right order; a flat pane has only one face
// in front of any pixel, so one pass gives the same image (checked pixel-exact per aircraft in chase, close-up and
// cockpit views) for half the draw calls and program checks. Canopies and cabin windows are shells: they keep two passes.
export const SINGLE_PASS_GLASS = new Set(['hud_glass', 'gauge_glass', 'ck_visor', 'fd_visor']);

/** Sets forceSinglePass on the flat glass materials under root (call after a GLB is added). */
export function singlePassFlatGlass(root) {
  if (!root || !root.traverse) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m && m.transparent && m.side === 2 /* DoubleSide */ && SINGLE_PASS_GLASS.has(m.name)) m.forceSinglePass = true;
    }
  });
}
