"""Quick workbench previews of the F-22 exterior while shaping it (dev tool, not part of the build).

  Blender -b -P blender/aircraft/f22/tools/preview.py -- <out_dir> [views] [--sil]
views: comma list of: side,top,front,bottom (orthographic frames used by tools/overlay_ref.py) and any camera
named in CAMS below.  --sil renders flat black silhouettes with a transparent background (for overlays).
"""
import bpy, sys, os, math
H = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, H)
sys.path.insert(0, os.path.join(H, '..', '..', 'common'))
for m in list(sys.modules):
    if m in ('geom', 'oml', 'fuselage', 'surfaces', 'aft', 'gear', 'details', 'canopy', 'exterior'):
        del sys.modules[m]
from mathutils import Vector
from util import reset_scene
from geom import Y0

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
out = argv[0] if argv else '/tmp/f22pv'
views = argv[1].split(',') if len(argv) > 1 and not argv[1].startswith('--') else ['side', 'top', 'front', 'q_front', 'q_rear']
SIL = '--sil' in argv
os.makedirs(out, exist_ok=True)
reset_scene()
import exterior
objs = exterior.build(preview=True)

# orthographic frames (must match tools/overlay_ref.py): px per metre and world window
FR = {
    'side': dict(W=2000, H=600, ppm=100.0, a0=-0.5, b1=3.7),     # s in [-0.5, 19.5], z in [-2.3, 3.7]
    'top': dict(W=2000, H=1500, ppm=100.0, a0=-0.5, b1=7.5),     # s in [-0.5, 19.5], x in [-7.5, 7.5]
    'bottom': dict(W=2000, H=1500, ppm=100.0, a0=-0.5, b1=7.5),
    'front': dict(W=1500, H=600, ppm=100.0, a0=-7.5, b1=3.7),    # x in [-7.5, 7.5] (image right = -x), z [-2.3, 3.7]
}
CAMS = {   # name: (location, target, lens)
    'q_front': ((13, Y0 + 7.0, 5.0), (0, Y0 - 9.5, -0.2), 45),
    'q_rear': ((-12.0, Y0 - 27.0, 6.0), (0, Y0 - 11.5, -0.2), 45),
    'q_low': ((9, Y0 + 3.5, -2.0), (0, Y0 - 8.5, -0.4), 40),
    'nose': ((3.6, Y0 + 3.5, 0.5), (0, Y0 - 3.5, -0.2), 38),
    'intake': ((3.8, Y0 + 1.0, -0.9), (0.9, Y0 - 5.8, -0.5), 35),
    'hero': ((-13.8, 23.0, -1.30), (0.7, 1.4, -0.45), 48),
    'front34': ((15.0, 18.5, 4.2), (0, 0.6, -0.2), 50),
    'rear34': ((5.2, -19.5, -0.85), (0.1, -7.4, -0.1), 56),
}
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sh = sc.display.shading
if SIL:
    sh.light = 'FLAT'
    sh.color_type = 'SINGLE'
    sh.single_color = (0, 0, 0)
    sc.render.film_transparent = True
else:
    sh.light = 'STUDIO'
    sh.color_type = 'MATERIAL'
    sh.show_cavity = True
    sh.cavity_type = 'BOTH'
    sh.show_specular_highlight = True
    sc.render.film_transparent = False
sh.show_object_outline = False
sc.view_settings.view_transform = 'Standard'
for name in views:
    cam = bpy.data.cameras.new(name)
    cam.clip_start, cam.clip_end = 0.05, 500
    ob = bpy.data.objects.new(name, cam)
    sc.collection.objects.link(ob)
    if name in FR:
        f = FR[name]
        cam.type = 'ORTHO'
        cam.ortho_scale = max(f['W'], f['H']) / f['ppm']
        sc.render.resolution_x, sc.render.resolution_y = f['W'], f['H']
        cx = f['a0'] + f['W'] / f['ppm'] / 2          # window centre (horizontal axis coordinate)
        cy = f['b1'] - f['H'] / f['ppm'] / 2          # (vertical axis coordinate)
        if name == 'side':      # from -X, nose left: image right = +s = -Y, up = +Z
            ob.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
            ob.location = (-100, Y0 - cx, cy)
        elif name == 'top':     # from above, nose left: image right = +s, image up = +X
            ob.rotation_euler = (0, 0, -math.pi / 2)
            ob.location = (cy, Y0 - cx, 100)
        elif name == 'bottom':  # from below, nose left: image right = +s, image up = -X
            ob.rotation_euler = (math.pi, 0, math.pi / 2)
            ob.location = (-cy, Y0 - cx, -100)
        else:                   # front: from +Y, image right = -X, up = +Z
            ob.rotation_euler = (math.pi / 2, 0, math.pi)
            ob.location = (-cx, 100, cy)
    else:
        loc, tgt, lens = CAMS[name]
        cam.lens = lens
        ob.location = loc
        ob.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.render.resolution_x, sc.render.resolution_y = 1400, 900
    sc.camera = ob
    sc.render.filepath = os.path.join(out, f'{name}{"_sil" if SIL else ""}.png')
    bpy.ops.render.render(write_still=True)
print('PREVIEW done', out)
