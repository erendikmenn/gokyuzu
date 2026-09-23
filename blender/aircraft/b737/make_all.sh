#!/bin/zsh
# Rebuild everything for the 737-800: textures -> full GLB (+ .blend for renders) -> LOD GLB -> Cycles renders.
#   blender/aircraft/b737/make_all.sh [--norender]
set -e
cd "$(dirname "$0")/../../.."
BL=/Applications/Blender.app/Contents/MacOS/Blender
PY=.venv/bin/python
$PY blender/aircraft/b737/textures.py
$PY blender/aircraft/b737/textures_fd.py
$BL -b -P blender/aircraft/b737/build.py -- --save
$BL -b -P blender/aircraft/b737/build.py -- --lod
if [[ "$1" != "--norender" ]]; then
  for s in hero front takeoff planform flightdeck cabin thumb; do
    $BL -b assets/aircraft/b737/b737.blend -P blender/aircraft/b737/render.py -- --shot $s --samples 256
  done
fi
