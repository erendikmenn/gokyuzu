"""Boeing 737-800 builder (Blender 5.2, headless).

  Blender -b -P blender/aircraft/b737/build.py -- [--notex] [--noexport] [--preview out_dir] [--save]

Builds the complete aircraft from code (shape.py = shared analytic geometry), exports
assets/aircraft/b737/b737.glb and b737_lod.glb, optionally saves a .blend for the render script.
"""
import os
import sys
import math
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))
for m in ('shape', 'mk', 'exterior', 'materials', 'engine', 'gear', 'details', 'interior', 'cabin', 'lod'):
    sys.modules.pop(m, None)

import bpy
import numpy as np
from util import reset_scene, export_glb, REPO
import shape as S
import mk
import materials
import exterior

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ARG = set(a for a in argv if a.startswith('--'))


def argval(name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


OUT_DIR = os.path.join(REPO, 'assets', 'aircraft', 'b737')
T0 = time.time()


def log(*a):
    print(f'[b737 {time.time() - T0:6.1f}s]', *a, flush=True)


LOD = '--lod' in ARG
if LOD:
    S.Q = 0.30


def build_all():
    reset_scene()
    mats = materials.create(textured='--notex' not in ARG)
    import interior as INT
    imats = INT.create_materials('--notex' not in ARG)
    fus, glass, shell, rev, wells = exterior.build_fuselage(mats, mats_interior=imats)
    log('fuselage', len(fus.data.polygons))
    import engine, gear
    for side, idx in ((-1, 1), (1, 2)):
        engine.build_engine(side, idx, mats)
    log('engines')
    gear.build_gear(mats, fus)
    log('gear')
    wings = exterior.build_wings(mats)
    log('wings', len(wings))
    tail = exterior.build_tail(mats)
    log('tail')
    if LOD:
        return dict(mats=mats)
    import details
    details.build_details(mats)
    log('details')
    fd = INT.build_interior(imats)
    log('flight deck', len(fd))
    if '--nocabin' not in ARG:
        import cabin
        cabin.build_cabin(imats, fus)
        log('cabin')
    return dict(mats=mats, imats=imats, fus=fus, glass=glass, shell=shell, reveal=rev)


def join(target_name, names, new_name=None):
    objs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    tgt = bpy.data.objects[target_name]
    others = [o for o in objs if o is not tgt]
    if others:
        with bpy.context.temp_override(active_object=tgt, object=tgt, selected_objects=[tgt] + others,
                                       selected_editable_objects=[tgt] + others):
            bpy.ops.object.join()
    if new_name:
        tgt.name = new_name
        tgt.data.name = new_name
    return tgt


def finalize():
    """Join static parts (fewer draw calls), build the interior hierarchy, name meshes after objects."""
    join('fuselage', ['fuselage', '_reveal', 'wheel_wells'])
    join('wing_R', ['wing_R', 'wing_L'], 'wings')
    join('fin', ['fin', 'stab_R', 'stab_L'], 'tail')
    join('nacelle_1', ['nacelle_1', 'nacelle_2'], 'nacelles')
    if 'details' in bpy.data.objects:
        join('tail', ['tail', 'details'])
    inter = bpy.data.objects.get('interior') or mk.empty('interior', (0, 0, 0))
    for o in list(bpy.data.objects):
        if o.get('interior') or o.name in ('flightdeck_shell',):
            if o.parent is None:
                mk.set_parent(o, inter)
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.name = o.name


def export_all():
    objs = [o for o in bpy.data.objects if o.type in ('MESH', 'EMPTY') and not o.name.startswith('_')]
    path = os.path.join(OUT_DIR, 'b737.glb')
    export_glb(path, objects=objs, draco=True)
    ext = [o for o in objs if o.type == 'MESH' and not is_interior(o)]
    inte = [o for o in objs if o.type == 'MESH' and is_interior(o)]
    cab = [o for o in inte if o.parent and o.parent.name == 'interior_cabin']
    log('EXPORT', path, f'{os.path.getsize(path) / 1e6:.2f} MB', 'tris exterior', mk.tri_count(ext),
        'flight deck', mk.tri_count(inte) - mk.tri_count(cab), 'cabin', mk.tri_count(cab))


def is_interior(o):
    p = o
    while p is not None:
        if p.name == 'interior':
            return True
        p = p.parent
    return False


def preview(out_dir, views=None, color='MATERIAL'):
    """Quick Workbench renders for shape checking."""
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = color
    sc.display.shading.show_cavity = False
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    sc.render.film_transparent = False
    from util import add_camera
    allviews = {
        'side': ((-60, 0, 2), (0, 0, 2), 60, True),
        'front': ((0, 60, 1.0), (0, 0, 1.5), 60, True),
        'top': ((0, 0, 80), (0, 0, 0), 60, True),
        'q34': ((-26, 28, 6), (0, 1, 0), 35, False),
        'nose': ((-7, 25, 2.2), (0, 14.5, 1.0), 40, False),
        'rear': ((-18, -40, 7), (0, -10, 1), 35, False),
        'tail': ((-12, -28, 5), (0, -18, 4.5), 40, False),
        'under': ((-14, 10, -9), (0, 0, -1), 35, False),
        'stab': ((-9, -12, 9), (-3, -19, 1.5), 40, False),
        'wingtop': ((-6, 6, 12), (-8, -1, 0), 35, False),
        'flaps': ((-10, -14, -1.5), (-6, -2, -0.3), 40, False),
        'engine': ((-9, 14, 0.5), (-4.9, 4.5, -1.2), 40, False),
        'gear': ((-7, 6, -1.2), (-2, -1.5, -2.0), 40, False),
    }
    views = views or ['side', 'front', 'top', 'q34', 'nose', 'rear', 'tail', 'under']
    for name in views:
        loc, tgt, lens, ortho = allviews[name]
        cam = add_camera(loc, tgt, lens=lens, name='cam_' + name)
        if ortho:
            cam.data.type = 'ORTHO'
            cam.data.ortho_scale = 44 if name != 'front' else 40
        sc.camera = cam
        sc.render.filepath = os.path.join(out_dir, f'wb_{name}.png')
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)


def main():
    parts = build_all()
    finalize()
    if LOD:
        import lod
        lod.finish_lod(os.path.join(OUT_DIR, 'b737_lod.glb'), log)
        log('done')
        return
    if '--stats' in ARG:
        from mathutils import Vector
        for o in sorted(bpy.data.objects, key=lambda o: o.name):
            if o.type != 'MESH':
                print('  E', o.name, tuple(round(x, 2) for x in o.matrix_world.translation))
                continue
            bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
            mn = [round(min(b[i] for b in bb), 2) for i in range(3)]
            mx = [round(max(b[i] for b in bb), 2) for i in range(3)]
            print('  M', o.name, mk.tri_count([o]), mn, mx, 'parent=' + (o.parent.name if o.parent else '-'))
    if argval('--preview'):
        v = argval('--views')
        preview(argval('--preview'), v.split(',') if v else None, 'RANDOM' if '--random' in ARG else 'MATERIAL')
    if '--noexport' not in ARG:
        export_all()
    if '--save' in ARG:
        for im in bpy.data.images:
            if im.filepath:
                im.filepath = bpy.path.abspath(im.filepath)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, 'b737.blend'), relative_remap=False)
    log('done')


main()
