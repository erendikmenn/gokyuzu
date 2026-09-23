#!/bin/sh
# F-16C full asset pipeline. Run from the repo root:  sh blender/aircraft/f16/make_all.sh [--no-renders]
#   1. cockpit + nozzle textures (PIL)            -> assets/aircraft/f16/tex/
#   2. AO bake of the exterior (Cycles)            -> tex/skin_ao.png
#   3. skin atlas incl. AO (numpy/PIL)             -> tex/skin_color.jpg, skin_normal.png, skin_orm.png
#   4. GLB + LOD export                            -> assets/aircraft/f16/f16.glb, f16_lod.glb
#   5. Cycles renders + menu thumbnail             -> renders/aircraft/f16/
set -e
B=/Applications/Blender.app/Contents/MacOS/Blender
PY=.venv/bin/python
$PY blender/aircraft/f16/cockpit_textures.py
$PY blender/aircraft/f16/textures.py --nozzle
[ -f assets/aircraft/f16/tex/skin_color.jpg ] || $PY blender/aircraft/f16/textures.py
$B -b -P blender/aircraft/f16/build.py -- --bake
$PY blender/aircraft/f16/textures.py
$B -b -P blender/aircraft/f16/build.py -- --export --lod
if [ "$1" != "--no-renders" ]; then
  $B -b -P blender/aircraft/f16/build.py -- --renders
fi
