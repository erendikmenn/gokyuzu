"""Fidelity check: render ortho silhouettes of the model registered onto the USAF F-22 3-view
(Commons 'Lockheed Martin F-22A Raptor 3-view.png') and write red-overlay comparisons.
  Blender -b -P blender/aircraft/f22/tools/overlay.py -- <ref.png> <out_dir>
"""
import bpy, sys, os, math
H = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, H); sys.path.insert(0, os.path.join(H, '..', '..', 'common'))
from mathutils import Vector
from util import reset_scene
import scene_f22, renders_f22 as R, shape as S, details as D
from geom import Y0

ref, out = sys.argv[sys.argv.index('--') + 1:][:2]
os.makedirs(out, exist_ok=True)
reset_scene()
ctx = scene_f22.build_all()
R.pose(gear=0.0, nose_doors=0, main_doors=0, nozzle_open=2.0)
for o in list(bpy.data.objects):
    if o.name in ('pilot',) or (o.type == 'MESH' and o.parent and o.parent.name == 'interior'):
        o.hide_render = True
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'FLAT'
sc.display.shading.color_type = 'SINGLE'
sc.display.shading.single_color = (0.0, 0.0, 0.0)
sc.display.shading.show_object_outline = False
sc.render.film_transparent = True
sc.view_settings.view_transform = 'Standard'
REF_W, REF_H = 2048, 976
# view: (ppm, anchor pixel, anchor world point, camera setup)
VIEWS = {
    'top': dict(ppm=61.0, px=(829, 457), world=(0.0, Y0, 0.0)),
    'side': dict(ppm=59.7, px=(18, 812.5), world=(0.0, Y0, S.z_top(0.0))),
    'front': dict(ppm=59.5, px=(503.5, 77), world=(0.0, 0.0, D.FIN_Z0 + D.FIN_H * math.cos(D.FIN_CANT))),
}
for name, v in VIEWS.items():
    cam = bpy.data.cameras.new(name)
    cam.type = 'ORTHO'
    cam.ortho_scale = REF_W / v['ppm']
    cam.clip_start, cam.clip_end = 0.1, 500
    ob = bpy.data.objects.new(name, cam)
    sc.collection.objects.link(ob)
    wx, wy, wz = v['world']
    dx = (v['px'][0] - REF_W / 2) / v['ppm']       # anchor offset from image centre (metres, image right)
    dy = (REF_H / 2 - v['px'][1]) / v['ppm']       # (image up)
    if name == 'top':        # looking down, nose to the left: image right = -Y, image up = +X
        ob.rotation_euler = (0, 0, -math.pi / 2)
        ob.location = (wx - dy, wy + dx, 100)
    elif name == 'side':     # from -X (port side), nose left: image right = -Y, up = +Z
        ob.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
        ob.location = (-100, wy + dx, wz - dy)
    else:                    # from the front (+Y looking -Y): image right = -X, up = +Z
        ob.rotation_euler = (math.pi / 2, 0, math.pi)
        ob.location = (wx + dx, 100, wz - dy)
    sc.camera = ob
    sc.render.resolution_x, sc.render.resolution_y = REF_W, REF_H
    sc.render.filepath = os.path.join(out, f'sil_{name}.png')
    bpy.ops.render.render(write_still=True)
print('OVERLAY done')
