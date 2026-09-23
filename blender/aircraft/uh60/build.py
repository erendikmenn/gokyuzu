"""UH-60M Black Hawk — Blender 5.2 headless build.

    Blender -b -P blender/aircraft/uh60/build.py -- [--preview DIR] [--notex] [--save] [--noexport]

Builds the exterior, rotor system, cockpit/cabin interior, bakes the hull texture atlas, exports
assets/aircraft/uh60/uh60.glb and uh60_lod.glb. Design frame G (see lib.py); the root empty 'uh60' offsets by -CG.
"""
import os
import sys
import math
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))

import bpy
import numpy as np
from mathutils import Vector, Matrix, Euler

import util
import lib
import hull
import mats
import openings
import rotor
import details
import interior
import bake
import subprocess
import tempfile

REPO = util.REPO
OUT_DIR = os.path.join(REPO, 'assets', 'aircraft', 'uh60')
CG = (0.0, -0.35, 1.55)          # centre of gravity in G (0.35 m aft of the mast, 1.55 m above the ground)
EYE_PILOT = (0.52, 2.72, 1.87)   # right seat (pilot in command): ~0.8 m above the seat pan, ~0.85 m behind the panel
EYE_COPILOT = (-0.52, 2.72, 1.87)

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        if i + 1 < len(ARGS) and not ARGS[i + 1].startswith('--'):
            return ARGS[i + 1]
        return True
    return default


def log(*a):
    print('[uh60]', *a, flush=True)


def reparent_G(child, parent, G):
    """Parent 'child' under 'parent' so that the child's G-frame placement is preserved.
    G: dict object -> G-frame matrix (matrix_basis before parenting). Root children keep their G matrix."""
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)
    if parent.name == 'uh60':
        child.matrix_basis = G[child]
    else:
        child.matrix_basis = G[parent].inverted() @ G[child]


def build_exterior(M, root):
    P = {}
    fuse = hull.build_fuselage(M['hull'])
    fuse.data.materials.append(M['int_wall'])
    fuse.data.materials.append(M['rim'])
    op = openings.cut_openings(fuse, M)
    P['fuselage'] = fuse
    P['doghouse'] = hull.build_doghouse(M['hull'])
    for s in (1, -1):
        P[f'nacelle_{s}'] = hull.build_nacelle(s, M['hull'])
        h = hull.build_hirss(s, M['hull'])
        lib.add_modifier_apply(h, 'SOLIDIFY', thickness=0.02, offset=-1.0)
        P[f'hirss_{s}'] = h
    P['pylon'] = hull.build_pylon(M['hull'])
    P['shaft_cover'] = hull.build_shaft_cover(M['hull'])
    stab = hull.build_stabilator(M['hull'])
    lib.set_origin(stab, hull.STAB_HINGE)
    for k in ('fuselage', 'doghouse', 'nacelle_1', 'nacelle_-1', 'hirss_1', 'hirss_-1', 'pylon', 'shaft_cover'):
        P[k].parent = root
    stab.parent = root
    P['stab'] = stab

    # doors: pivots
    G = {}
    for name, d in op['doors'].items():
        bb = [d.matrix_world @ Vector(c) for c in d.bound_box]
        if name.startswith('door_cabin'):
            c = sum(bb, Vector()) / 8
            lib.set_origin(d, c)
        else:
            side = 1 if name == 'door_pilot' else -1
            xs = hull.fuse_halfwidth_at(3.55, 1.30)
            lib.set_origin(d, (side * xs, 3.55, 1.30))
        G[d] = d.matrix_basis.copy()
        d.parent = root
        P[name] = d
    for g, door in op['glass']:
        G[g] = g.matrix_basis.copy()
        if door is not None:
            reparent_G(g, door, G)
        else:
            g.parent = root
    P['glass'] = [g for g, _ in op['glass']]
    return P


def build_all(M):
    root = lib.empty('uh60', loc=(-CG[0], -CG[1], -CG[2]))
    P = build_exterior(M, root)
    rot, blades, blur, sw = rotor.build_main_rotor(M, root)
    tr, tblades, tblur = rotor.build_tail_rotor(M, root)
    for s in (1, -1):
        details.build_main_gear(M, root, s)
    details.build_tail_gear(M, root)
    details.build_details(M, root)
    details.build_lights(M, root)
    # contract empties
    lib.empty('eye_pilot', EYE_PILOT, parent=root)
    lib.empty('eye_copilot', EYE_COPILOT, parent=root)
    lib.empty('engine_1', (-hull.NAC_X, -0.25, hull.NAC_Z), parent=root)
    lib.empty('engine_2', (hull.NAC_X, -0.25, hull.NAC_Z), parent=root)
    for i, s in ((1, -1), (2, 1)):
        p = hull.hirss_path(s)[-1]
        lib.empty(f'nozzle_{i}', tuple(p), parent=root)
    inter = lib.empty('interior', (0, 0, 0), parent=root)
    interior.build_interior(M, inter)
    return root, P


VENV_PY = os.path.join(REPO, '.venv', 'bin', 'python')
CACHE = os.path.join(tempfile.gettempdir(), 'uh60_build_cache')
TEX = os.path.join(CACHE, 'tex')


def texture_hull(M, size=4096):
    root = bpy.data.objects['uh60']
    root.location = (0, 0, 0)                      # bake in the G frame
    bpy.context.view_layer.update()
    objs = bake.hull_objects('hull')
    log('atlas objects:', [o.name for o in objs])
    bake.unwrap_atlas(objs)
    if bpy.context.scene.world is None:
        bpy.context.scene.world = bpy.data.worlds.new('bake_world')
    hide = [o for o in bpy.data.objects if o.name.startswith(('blade_', 'rotor_', 'tail_blade', 'glass_', 'lens_'))
            or o.name in ('swashplate',)]
    if not arg('--skipbake'):
        bake.bake_maps(objs, CACHE, size=size, hide=hide, gpu=not arg('--cpubake'))
    if not arg('--skiptexgen'):
        r = subprocess.run([VENV_PY, os.path.join(HERE, 'texgen.py'), CACHE, TEX], capture_output=True, text=True)
        print(r.stdout[-4000:], r.stderr[-4000:], flush=True)
        if r.returncode != 0:
            raise RuntimeError('texgen failed')
    mats.textured_material(M['hull'], os.path.join(TEX, 'hull_base.jpg'), os.path.join(TEX, 'hull_orm.jpg'),
                           os.path.join(TEX, 'hull_nrm.jpg'), emit=os.path.join(TEX, 'hull_emit.jpg'))
    # inner skin: cockpit paint / cabin quilting with tiling UVs (after the atlas unwrap)
    for o in bake.hull_objects('int_wall'):
        interior.assign_wall_materials(o, M)
    r = subprocess.run([VENV_PY, os.path.join(HERE, 'intex.py'), TEX], capture_output=True, text=True)
    print(r.stdout[-2000:], r.stderr[-2000:], flush=True)
    mats.texture_interior(M, TEX)
    root.location = (-CG[0], -CG[1], -CG[2])


def build_lod(M, target=36000):
    """Destructive: turn the current scene into the <=40k-triangle LOD (parked copies) and export it."""
    inter = bpy.data.objects['interior']
    kill = [o for o in bpy.data.objects if o.parent == inter or o.name.startswith(('glass_door_cabin', 'lens_'))
            or o.name in ('details_metal', 'swashplate', 'searchlight')]
    for o in kill:
        bpy.data.objects.remove(o, do_unlink=True)
    # glass -> opaque dark tinted (no interior behind it)
    g = M['glass']
    gl = mats.principled('glass_lod', '#141a1c', rough=0.08, spec=0.7)
    for o in bpy.data.objects:
        if o.type == 'MESH':
            for s in o.material_slots:
                if s.material == g:
                    s.material = gl
    # hull textures at 1K for the LOD
    for key in ('hull_base.jpg', 'hull_orm.jpg', 'hull_nrm.jpg', 'blade.jpg', 'hull_emit.jpg'):
        img = bpy.data.images.get(key)
        if img is None:
            continue
        img2 = img.copy()
        img2.scale(1024, 1024) if key not in ('blade.jpg', 'hull_emit.jpg') else (img2.scale(512, 64) if key == 'blade.jpg' else img2.scale(512, 512))
        path = os.path.join(TEX, 'lod_' + key)
        img2.filepath_raw = path
        img2.file_format = 'JPEG'
        img2.save()
        img2 = bpy.data.images.load(path)
        for m in bpy.data.materials:
            if m.node_tree:
                for n in m.node_tree.nodes:
                    if n.type == 'TEX_IMAGE' and n.image == img:
                        n.image = img2
                        if 'nrm' in key or 'orm' in key:
                            img2.colorspace_settings.name = 'Non-Color'
    # the interior wall faces are invisible behind the opaque glass: drop the inner skin (keep outer + rims)
    for name in ('fuselage', 'door_cabin_L', 'door_cabin_R', 'door_pilot', 'door_copilot'):
        o = bpy.data.objects[name]
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(o.data)
        slots = [s.material.name if s.material else '' for s in o.material_slots]
        dead = [f for f in bm.faces if slots[f.material_index].startswith('int_')]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bm.to_mesh(o.data)
        bm.free()
    ratios = {'details_black': 1.0, 'fuselage': 0.28, 'doghouse': 0.25, 'blade_': 0.22, 'rotor_main': 0.30, 'ctl_stabilator': 0.3,
              'nacelle_': 0.3, 'pylon': 0.35, 'door_': 0.35, 'wheel_': 0.3, 'details_': 0.5, 'tail_blade': 0.4,
              'gear_': 0.5, 'shaft_cover': 0.35, 'hirss': 0.5, 'rotor_tail': 0.5}
    for o in list(bpy.data.objects):
        if o.type != 'MESH' or o.name.endswith('_blur'):
            continue
        r = next((v for k, v in ratios.items() if o.name.startswith(k)), 0.6)
        if r < 1.0:
            lib.add_modifier_apply(o, 'DECIMATE', ratio=r, use_collapse_triangulate=True)
    n = count_tris([o for o in bpy.data.objects if o.type == 'MESH'])
    log('LOD triangles:', n)
    util.export_glb(os.path.join(OUT_DIR, 'uh60_lod.glb'))
    log('LOD exported', os.path.getsize(os.path.join(OUT_DIR, 'uh60_lod.glb')) // 1024, 'KiB')
    return n


def cleanup():
    for ob in list(bpy.data.objects):
        if ob.name.startswith('_') or ob.name.startswith('pv_'):
            bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)


def check_names():
    bad = [o.name for o in bpy.data.objects if '.' in o.name]
    if bad:
        log('WARNING duplicate-suffixed names:', bad)


def count_tris(objs):
    n = 0
    for o in objs:
        if o.type == 'MESH':
            n += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return n


def preview(outdir):
    """Orthographic Workbench renders matching the reference drawing scale (root moved back to G)."""
    root = bpy.data.objects['uh60']
    old = root.location.copy()
    root.location = (0, 0, 0)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'MATERIAL'
    sc.display.shading.show_cavity = True
    sc.world = bpy.data.worlds.new('pvw') if sc.world is None else sc.world
    sc.world.color = (1, 1, 1)
    os.makedirs(outdir, exist_ok=True)
    views = {
        'left': ((-40, -1.884, 2.98), (math.radians(90), 0, math.radians(-90)), 20.7, 2000, 680),
        'front': ((0, 40, 2.2), (math.radians(90), 0, math.radians(180)), 7.0, 1000, 1000),
        'top': ((0, -2.5, 40), (0, 0, 0), 21.0, 1400, 1400),
        'rear': ((0, -40, 2.2), (math.radians(90), 0, 0), 7.0, 1000, 1000),
        'persp': None,
        'eye': 'eye',
    }
    for m in bpy.data.materials:
        m.diffuse_color = (0.55, 0.55, 0.55, 1)
    bpy.data.materials['glass'].diffuse_color = (0.1, 0.6, 0.9, 1)
    hidden = [o for o in bpy.data.objects if o.name.endswith('_blur')]
    for o in hidden:
        o.hide_render = True
    for name, spec in views.items():
        if spec == 'eye':
            # the game's cockpit camera: eye_pilot, looking forward, -8 deg rest pitch, 76 deg vertical fov, 16:10
            cam = bpy.data.cameras.new('pv_eye')
            cam.sensor_fit = 'VERTICAL'
            cam.angle_y = math.radians(76)
            cam.clip_start = 0.02
            ob = bpy.data.objects.new('pv_eye', cam)
            sc.collection.objects.link(ob)
            ob.location = EYE_PILOT
            ob.rotation_euler = (math.radians(90 - 8), 0, 0)
            sc.camera = ob
            sc.render.resolution_x, sc.render.resolution_y = 1440, 900
        elif spec is None:
            util.add_camera((9.5, 9.0, 4.2), (0, 0.4, 1.7), lens=35, name='pv_persp')
            sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
        else:
            loc, rot, scale, rx, ry = spec
            cam = bpy.data.cameras.new('pv_' + name)
            cam.type = 'ORTHO'
            cam.ortho_scale = scale
            cam.clip_end = 200
            ob = bpy.data.objects.new('pv_' + name, cam)
            sc.collection.objects.link(ob)
            ob.location = loc
            ob.rotation_euler = rot
            sc.camera = ob
            sc.render.resolution_x, sc.render.resolution_y = rx, ry
        util.render_still(os.path.join(outdir, f'pv_{name}.png'))
    for o in hidden:
        o.hide_render = False
    root.location = old


def main():
    t0 = time.time()
    util.reset_scene()
    M = mats.make_materials(textured=not arg('--notex'))
    root, P = build_all(M)
    mats.set_culling(M)
    cleanup()
    check_names()
    if not arg('--notex'):
        texture_hull(M, int(arg('--texsize', 4096)))
    ext = [o for o in bpy.data.objects if o.type == 'MESH']
    log('exterior+interior triangles:', count_tris(ext), 'objects:', len(ext))
    pv = arg('--preview')
    if pv:
        preview(pv)
    if not arg('--noexport'):
        os.makedirs(OUT_DIR, exist_ok=True)
        util.export_glb(os.path.join(OUT_DIR, 'uh60.glb'))
        log('exported', os.path.getsize(os.path.join(OUT_DIR, 'uh60.glb')) // 1024, 'KiB')
    if arg('--save'):
        bpy.context.preferences.filepaths.save_version = 0      # no .blend1 backups
        try:
            bpy.ops.file.pack_all()
        except Exception as e:
            log('pack failed', e)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, 'uh60_build.blend'), compress=True)
    if not arg('--nolod') and not arg('--noexport'):
        build_lod(M)
    log(f'done in {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
