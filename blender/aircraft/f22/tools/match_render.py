"""Render the current F-22 model from fitted photo cameras (tools/camfit.py) for same-angle comparisons.

  Blender -b -P blender/aircraft/f22/tools/match_render.py -- <out_dir> <cam.json>[,<cam.json>...] [--scale 0.5]
      [--cycles N] [--gear up|down]
Writes <out_dir>/<cam name>_wb.png (workbench, studio light) and <cam name>_sil.png (flat silhouette, alpha).
With --cycles N it also renders a Cycles image with the full materials (only if the scene has them).
"""
import bpy, sys, os, json, math
H = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, H)
sys.path.insert(0, os.path.join(H, '..', '..', 'common'))
from mathutils import Quaternion
from util import reset_scene

argv = sys.argv[sys.argv.index('--') + 1:]
out = argv[0]
cams = argv[1].split(',')
scale = float(argv[argv.index('--scale') + 1]) if '--scale' in argv else 0.5
os.makedirs(out, exist_ok=True)
reset_scene()
import exterior
exterior.build(preview=True)
# pose: gear down, doors as on the ground (nose doors open, main doors hanging open)
from mathutils import Quaternion as _Q


def _rot(name, deg):
    ob = bpy.data.objects.get(name)
    if ob:
        ob.rotation_quaternion = ob.rotation_quaternion @ _Q((1, 0, 0), math.radians(deg))
for n, a in (('gear_door_nose_R', -88), ('gear_door_nose_L', 88), ('gear_door_main_R', float(os.environ.get('F22_MD', '-58'))), ('gear_door_main_L', -float(os.environ.get('F22_MD', '-58')))):
    _rot(n, a)
bpy.context.view_layer.update()
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sh = sc.display.shading
sc.view_settings.view_transform = 'Standard'
for cp in cams:
    c = json.load(open(cp))
    name = os.path.splitext(os.path.basename(cp))[0].replace('_cam', '')
    cam = bpy.data.cameras.new(name)
    cam.lens = c['lens_mm']
    cam.sensor_width = c['sensor']
    cam.sensor_fit = 'HORIZONTAL'
    cam.clip_start, cam.clip_end = 0.05, 100000
    ob = bpy.data.objects.new(name, cam)
    sc.collection.objects.link(ob)
    ob.location = c['pos']
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = Quaternion(c['quat'])
    sc.camera = ob
    W, Hh = c['size']
    sc.render.resolution_x, sc.render.resolution_y = int(W * scale), int(Hh * scale)
    for mode in ('wb', 'sil'):
        if mode == 'sil':
            sh.light = 'FLAT'
            sh.color_type = 'SINGLE'
            sh.single_color = (0, 0, 0)
            sc.render.film_transparent = True
            sh.show_cavity = False
        else:
            sh.light = 'STUDIO'
            sh.color_type = 'MATERIAL'
            sh.show_cavity = True
            sh.cavity_type = 'BOTH'
            sh.show_specular_highlight = True
            sc.render.film_transparent = True
        sh.show_object_outline = False
        sc.render.filepath = os.path.join(out, f'{name}_{mode}.png')
        bpy.ops.render.render(write_still=True)
print('MATCH done')
