"""Dev helper: orthographic silhouette renders of the built model, overlaid on the Airbus AC drawings.

Called from build.py with --compare <outdir>. Needs the 400-dpi drawing rasters in <refdir> (hi-042.png, hi-043.png),
created with: pdftoppm -r 400 -png -f 42 -l 43 AC_A320_0624.pdf hi
"""
import math
import os
import numpy as np
import bpy
from mathutils import Vector
import geo
import layout as LY

ZS = 4.14 / 4.06
WS = 1.975 / 1.92


def _setup(res_x, res_y):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'FLAT'
    sh.color_type = 'SINGLE'
    sh.single_color = (1, 1, 1)
    sc.render.film_transparent = True
    sc.render.resolution_x = res_x
    sc.render.resolution_y = res_y
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.view_settings.view_transform = 'Standard'


def _cam(loc, rot_euler, ortho):
    cam = bpy.data.cameras.new('cmpcam')
    cam.type = 'ORTHO'
    cam.ortho_scale = ortho
    cam.clip_end = 500
    o = bpy.data.objects.new('cmpcam', cam)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = rot_euler
    bpy.context.scene.camera = o
    return o


def render_views(outdir):
    os.makedirs(outdir, exist_ok=True)
    hide = [o for o in bpy.context.scene.objects if o.name.startswith('ck_') or o.name == 'interior']
    for o in hide:
        o.hide_render = True
    ppm = 44.53
    # side view (from the left, nose to the image left). width 40 m (s -1..39), height 14 m (z -4.6..9.4)
    W, H = 40.0, 14.0
    _setup(int(W * ppm), int(H * ppm))
    s_c, z_c = 19.0, 2.4
    _cam((-60, geo.S_CG - s_c, z_c), (math.pi / 2, 0, -math.pi / 2), W)
    sc = bpy.context.scene
    sc.render.filepath = os.path.join(outdir, 'side.png')
    bpy.ops.render.render(write_still=True)
    # top view (from above, nose to the left, right wing up)
    W, H = 40.0, 40.0
    _setup(int(W * ppm), int(H * ppm))
    _cam((0, geo.S_CG - 19.0, 60), (0, 0, -math.pi / 2), W)
    sc.render.filepath = os.path.join(outdir, 'top.png')
    bpy.ops.render.render(write_still=True)
    # front view
    ppm_f = 43.94
    W, H = 40.0, 14.0
    _setup(int(W * ppm_f), int(H * ppm_f))
    _cam((0, 80, 2.4), (math.pi / 2, 0, math.pi), W)
    sc.render.filepath = os.path.join(outdir, 'front.png')
    bpy.ops.render.render(write_still=True)
    for o in hide:
        o.hide_render = False
