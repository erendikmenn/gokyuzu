#!/bin/sh
# F-16C full asset pipeline. Run from the repo root:  sh blender/aircraft/f16/make_all.sh [--no-renders]
#   1. nozzle texture + cockpit panel art (PIL)     -> assets/aircraft/f16/tex/, blender/aircraft/f16/build/art/
#   2. AO bake of the exterior (Cycles)             -> tex/skin_ao.png
#   3. skin atlas incl. AO (numpy/PIL)              -> tex/skin_color.jpg, skin_normal.png, skin_orm.png
#   4. cockpit bake (albedo x soft light, Cycles) + GLB export
#        -> assets/aircraft/f16/f16.glb (exterior + interior_lite), f16_cockpit.glb (detailed cockpit), f16_lod.glb
#   5. Cycles renders + menu thumbnail              -> renders/aircraft/f16/
set -e
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"   # Blender 5.2; override with the BLENDER env var
B="perl -e 'alarm 1800; exec @ARGV' \"\$BLENDER\""
PY=.venv/bin/python
$PY blender/aircraft/f16/f16_ck_art.py
$PY blender/aircraft/f16/textures.py --nozzle
# the exterior skin (AO bake + atlas) is only rebuilt when missing, so re-running the pipeline keeps the exterior
# byte-identical (delete tex/skin_ao.png to force a re-bake)
if [ ! -f assets/aircraft/f16/tex/skin_ao.png ]; then
  [ -f assets/aircraft/f16/tex/skin_color.jpg ] || $PY blender/aircraft/f16/textures.py
  eval $B -b -P blender/aircraft/f16/build.py -- --bake
  $PY blender/aircraft/f16/textures.py
fi
eval $B -b -P blender/aircraft/f16/build.py -- --export --lod
if [ "$1" != "--no-renders" ]; then
  eval $B -b -P blender/aircraft/f16/build.py -- --renders
  eval $B -b -P blender/aircraft/f16/build.py -- --renders --shots cockpit,ck_game,ck_front,ck_left,ck_right,ck_ref00,ck_ref08,ck_hud --samples 160
fi
