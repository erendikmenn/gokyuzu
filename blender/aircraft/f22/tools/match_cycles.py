"""Cycles render of the fully textured F-22 from fitted photo cameras (tools/camfit.py) for same-angle comparisons.

  Blender -b -P blender/aircraft/f22/tools/match_cycles.py -- <out_dir> <cam.json>[,...] [--scale 0.4] [--samples 48]
      [--sun elev,az,strength] [--sky strength] [--ground] [--pose ground|flight|parked]
Writes <out_dir>/<name>_cy.png (+ _sil.png silhouettes for match_compose.py).
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


def opt(name, default):
    return argv[argv.index(name) + 1] if name in argv else default
scale = float(opt('--scale', '0.4'))
samples = int(opt('--samples', '48'))
sun = [float(v) for v in opt('--sun', '35,210,3.2').split(',')]
skys = float(opt('--sky', '0.30'))
posek = opt('--pose', 'ground')
os.makedirs(out, exist_ok=True)
reset_scene()
import scene_f22
import renders_f22 as R
ctx = scene_f22.build_all(bake=False)
R.render_materials(ctx)
if '--ground' in argv:
    R.ground()
if posek == 'flight':
    R.pose(gear=0.0, nose_doors=0, main_doors=0, nozzle_open=1.5)
elif posek == 'parked':
    R.pose(stab=-22, rudder=0)
else:
    R.pose(main_doors=float(opt('--md', '50')))
for n in opt('--hide', '').split(','):
    ob = bpy.data.objects.get(n)
    if ob:
        ob.hide_render = True
        for c in ob.children_recursive:
            c.hide_render = True
R.setup(samples, 100, 100)
R.sky(sun[0], sun[1], skys, sun[2])
sc = bpy.context.scene
sc.render.film_transparent = '--ground' not in argv
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
    sc.render.resolution_percentage = 100
    sc.render.filepath = os.path.join(out, f'{name}_cy.png')
    bpy.ops.render.render(write_still=True)
print('MATCHCY done')
