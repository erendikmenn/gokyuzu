#!/bin/zsh
# Rebuild everything for the 737-800: textures -> full GLB (+ .blend for renders) -> LOD GLB -> Cycles renders.
#   blender/aircraft/b737/make_all.sh [--norender]
set -e
cd "$(dirname "$0")/../../.."
PY=.venv/bin/python
# every Blender run under a hard time limit (shared GPU, CONTRACTS-SF.md 10)
BL=(perl -e 'alarm 2400; exec @ARGV' /Applications/Blender.app/Contents/MacOS/Blender)
$PY blender/aircraft/b737/textures.py
$PY blender/aircraft/b737/textures_fd.py          # flight-deck panel atlas + structure swatches
# optional: $PY blender/aircraft/b737/capture_displays.py   (live avionics pages for the renders; dev server needed)
# exterior + interior_lite -> b737.glb, detailed flight deck (AO / soft light baked, Cycles) -> b737_cockpit.glb
"${BL[@]}" -b -P blender/aircraft/b737/build.py -- --save
"${BL[@]}" -b -P blender/aircraft/b737/build.py -- --lod
if [[ "$1" != "--norender" ]]; then
  for s in hero front takeoff planform flightdeck fd_fwd fd_overhead fd_pedestal fd_overview cabin thumb; do
    "${BL[@]}" -b assets/aircraft/b737/b737.blend -P blender/aircraft/b737/render.py -- --shot $s --samples 256
  done
fi
