"""Assemble the F-22 scene (wave 6 rebuild): exterior, details, cockpit (+ light stand-in), empties, texturing, export.

Exterior GLB  (f22.glb)          : airframe + control surfaces + gear + canopy + lights + `interior_lite`
Cockpit GLB   (f22_cockpit.glb)  : root `interior` (detailed cockpit + all screen_* meshes), same frame
LOD GLB       (f22_lod.glb)      : one merged, decimated parked copy
"""
import os
import math
import bpy
import bmesh
from mathutils import Vector

import geom as G
from geom import Y
import oml as O
from util import REPO, export_glb

OUT_DIR = os.path.join(REPO, 'assets', 'aircraft', 'f22')
SRC = os.path.join(OUT_DIR, 'src')
TEX = os.path.join(OUT_DIR, 'tex')


class Ctx:
    pass


def mat_simple(name, color, metallic=0.0, roughness=0.5, emission=None, alpha=None):
    import exterior
    return exterior.mat(name, color, metallic, roughness, alpha=alpha, emission=emission)


def mat_image(name, path, roughness=0.6, emission=0.0, uv=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(path, check_existing=True)
    if uv:
        u = nt.nodes.new('ShaderNodeUVMap')
        u.uv_map = uv
        nt.links.new(u.outputs['UV'], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'], p.inputs['Base Color'])
    if emission:
        nt.links.new(tex.outputs['Color'], p.inputs['Emission Color'])
        p.inputs['Emission Strength'].default_value = emission
    p.inputs['Roughness'].default_value = roughness
    m.diffuse_color = (0.3, 0.3, 0.3, 1)
    return m


def build_all(bake=False, cockpit_bake=None):
    import exterior
    import extras as X
    import aft as A
    import gear as GR
    import cklayout as L
    ctx = Ctx()
    ctx.objects = exterior.build()
    M = {m.name: m for m in bpy.data.materials}
    ctx.mats = M
    # ---------------- small details
    fm = mat_simple('f22_formation', (0.50, 0.53, 0.46), 0.0, 0.45, emission=(0.6, 1.0, 0.45, 0.0))
    ctx.objects['formation_lights'] = G.new_object('formation_lights', X.build_formation_strips(), [fm])
    lens = [mat_simple('f22_lens_red', (0.55, 0.02, 0.02), 0.0, 0.08), mat_simple('f22_lens_green', (0.02, 0.45, 0.08), 0.0, 0.08),
            mat_simple('f22_lens_clear', (0.8, 0.82, 0.85), 0.0, 0.05)]
    ctx.objects['nav_lenses'] = G.new_object('nav_lenses', X.build_lenses(), lens)
    for ob in ctx.objects.values():
        if ob.type == 'MESH' and not ob.name.startswith(('gear_', 'wheel_')):
            b2 = bmesh.new()
            b2.from_mesh(ob.data)
            G.smooth_sharp(b2, 32 if not ob.name.startswith('canopy') else 50)
            b2.to_mesh(ob.data)
            b2.free()
    add_empties(ctx)
    # ---------------- detailed cockpit (interior) + light stand-in (interior_lite)
    build_cockpit(ctx, cockpit_bake)
    # ---------------- exterior skin texturing (UV atlas + baked maps)
    import materials as MT
    ctx.atlas_objs = MT.atlas_objects()
    MT.unwrap(ctx.atlas_objs)
    if bake:
        MT.bake_passes(ctx.atlas_objs)
        MT.composite()
    if os.path.exists(os.path.join(MT.TEX, 'f22_basecolor.jpg')):
        ctx.mats['skin_baked'] = MT.skin_material()
        MT.apply_skin(ctx.atlas_objs, ctx.mats['skin_baked'])
    return ctx


def add_empties(ctx):
    import extras as X
    import aft as A
    import gear as GR
    import cklayout as L
    E = {}
    E['eye_pilot'] = G.empty('eye_pilot', (L.EYE[0], Y(L.EYE[1]), L.EYE[2]))
    E['contact_nose'] = G.empty('contact_nose', (0, Y(GR.NOSE_AXLE[1]), O.Z_GROUND))
    E['contact_main_L'] = G.empty('contact_main_L', (-GR.MAIN_AXLE[0], Y(GR.MAIN_AXLE[1]), O.Z_GROUND))
    E['contact_main_R'] = G.empty('contact_main_R', (GR.MAIN_AXLE[0], Y(GR.MAIN_AXLE[1]), O.Z_GROUND))
    zc = 0.5 * (A.Z_HINGE_U + A.Z_HINGE_L)
    E['engine_1'] = G.empty('engine_1', (-A.NOZ_XC, Y(12.3), zc))
    E['engine_2'] = G.empty('engine_2', (A.NOZ_XC, Y(12.3), zc))
    E['nozzle_1'] = G.empty('nozzle_1', (-A.NOZ_XC, Y(A.EXIT_S), zc))
    E['nozzle_2'] = G.empty('nozzle_2', (A.NOZ_XC, Y(A.EXIT_S), zc))
    for name, (x, s_, z) in X.LIGHTS.items():
        E[name] = G.empty(name, (x, Y(s_), z), size=0.1)
    # landing / taxi lights on the nose gear strut (retract with it)
    gn = bpy.data.objects['gear_nose']
    t = Vector((0, Y(GR.NOSE_TRUN[1]), GR.NOSE_TRUN[2]))
    a = Vector((0, Y(GR.NOSE_AXLE[1]), GR.NOSE_AXLE[2]))
    d = (a - t).normalized()
    p = t + d * 0.42 + Vector((0, 0.18, 0))
    for name, dx in (('light_landing', -0.065), ('light_taxi', 0.065)):
        E[name] = G.empty(name, (dx, p.y, p.z), size=0.1)
        G.set_parent(E[name], gn)
    ctx.empties = E


def build_cockpit(ctx, cockpit_bake):
    import cockpit as CK
    import cklayout as L
    import pilot as PL
    import ckbake as KB
    art = os.path.join(SRC, 'cockpit_art.png')
    m = {}
    m['art'] = mat_image('f22_cockpit_art', art, 0.7, uv='art')
    m['screen'] = mat_simple('f22_screen', (0.01, 0.012, 0.012), 0.0, 0.25)
    m['hud'] = mat_simple('f22_hud', (0.0, 0.0, 0.0), 0.0, 0.2, alpha=0.0)
    m['hudglass'] = mat_simple('f22_hud_glass', (0.45, 0.6, 0.5), 0.0, 0.05, alpha=0.12)
    m['sfd'] = mat_image('f22_sfd', os.path.join(SRC, 'disp_sfd.png'), 0.3, emission=1.0)
    objs = CK.build_cockpit(m)
    ctx.cockpit = objs
    baked = [objs['cockpit_shell'], objs['cockpit_stick'], objs['cockpit_throttle']]
    tex_path = os.path.join(TEX, 'f22_cockpit.jpg')
    KB.make_bake_uv(baked)
    do_bake = cockpit_bake if cockpit_bake is not None else not os.path.exists(tex_path)
    if do_bake:
        os.makedirs(TEX, exist_ok=True)
        occl = [o for o in bpy.data.objects if o.type == 'MESH' and o.name in ('airframe', 'cockpit_tub')]
        # canopy frame as occluder: frame material faces only (glass would black out the sky)
        col, lt = KB.bake(baked, art, occluders=occl, size=4096, light_size=2048, samples=96)
        KB.composite(col, lt, tex_path)
    fm = KB.final_material(tex_path)
    KB.apply(baked, fm)
    ctx.mats['cockpit'] = fm
    # ---------------- interior_lite: decimated copy of the shell + seat, pilot, combiner glass
    lite = G.empty('interior_lite', (0, 0, 0), size=0.4)
    src = objs['cockpit_shell']
    me = src.data.copy()
    ob = bpy.data.objects.new('cockpit_lite', me)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = src.matrix_world.copy()
    n0 = G.tri_count(ob)
    mod = ob.modifiers.new('dec', 'DECIMATE')
    mod.ratio = min(1.0, 9000 / max(n0, 1))
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier='dec')
    small = os.path.join(TEX, 'f22_cockpit_lite.jpg')
    img = bpy.data.images.load(tex_path)
    img.scale(512, 512)
    img.filepath_raw = small
    img.file_format = 'JPEG'
    img.save()
    lm = KB.final_material(small, 'f22_cockpit_lite')
    ob.data.materials.clear()
    ob.data.materials.append(lm)
    G.set_parent(ob, lite)
    pm = [mat_simple('f22_pilot_suit', (0.20, 0.22, 0.15), 0.0, 0.8), mat_simple('f22_pilot_vest', (0.10, 0.12, 0.08), 0.0, 0.8),
          mat_simple('f22_pilot_black', (0.02, 0.02, 0.02), 0.0, 0.6), mat_simple('f22_pilot_helmet', (0.30, 0.32, 0.31), 0.1, 0.5),
          mat_simple('f22_pilot_visor', (0.02, 0.02, 0.03), 0.6, 0.08), mat_simple('f22_pilot_mask', (0.04, 0.04, 0.045), 0.0, 0.6)]
    pl = PL.build_pilot(pm)
    G.set_parent(pl, lite)
    hg = objs['hud_glass']
    hl = bpy.data.objects.new('hud_glass_lite', hg.data.copy())
    bpy.context.scene.collection.objects.link(hl)
    hl.matrix_world = hg.matrix_world.copy()
    G.set_parent(hl, lite)
    ctx.lite = lite
    ctx.pilot = pl


def is_under(ob, root):
    p = ob
    while p is not None:
        if p.name == root:
            return True
        p = p.parent
    return False


def report(ctx):
    ext = inn = lite = 0
    for ob in bpy.data.objects:
        if ob.type != 'MESH' or ob.name.startswith(('r_', 'lod_', 'f22_lod')):
            continue
        n = G.tri_count(ob)
        if is_under(ob, 'interior'):
            inn += n
        elif is_under(ob, 'interior_lite'):
            lite += n
        else:
            ext += n
    ctx.tris = (ext, lite, inn)
    print(f'[f22] triangles: exterior {ext}, interior_lite {lite}, cockpit {inn}')


def _select_export(roots_in, exclude_root=None):
    objs = []
    for ob in bpy.data.objects:
        if ob.name.startswith(('r_', 'lod_', 'f22_lod', 'pvcam', 'rcam')) or ob.type in ('CAMERA', 'LIGHT'):
            continue
        if roots_in == 'interior':
            if is_under(ob, 'interior'):
                objs.append(ob)
        else:
            if not is_under(ob, 'interior'):
                objs.append(ob)
    return objs


def export_main(ctx):
    path = os.path.join(OUT_DIR, 'f22.glb')
    export_glb(path, objects=_select_export('exterior'))
    print('[f22] exported', path, os.path.getsize(path) // 1024, 'KB')


def export_cockpit(ctx):
    path = os.path.join(OUT_DIR, 'f22_cockpit.glb')
    export_glb(path, objects=_select_export('interior'))
    print('[f22] exported', path, os.path.getsize(path) // 1024, 'KB')


def export_lod(ctx, target=36000):
    """Static parked copy: one merged mesh (gear down, doors as parked), decimated, 2K textures."""
    import renders_f22 as R
    import materials as MT
    R.pose()
    bpy.context.view_layer.update()

    def small(name, size):
        src = os.path.join(MT.TEX, name)
        dst = os.path.join(MT.TEX, name.replace('.jpg', '_lod.jpg'))
        img = bpy.data.images.load(src)
        img.scale(size, size)
        img.filepath_raw = dst
        img.file_format = 'JPEG'
        img.save()
        return dst
    bc = small('f22_basecolor.jpg', 2048)
    mr = small('f22_metalrough.jpg', 1024)
    lod_skin = bpy.data.materials.new('f22_skin_lod')
    lod_skin.use_nodes = True
    lod_skin.use_backface_culling = True
    nt = lod_skin.node_tree
    p = nt.nodes['Principled BSDF']
    t1 = nt.nodes.new('ShaderNodeTexImage')
    t1.image = bpy.data.images.load(bc)
    nt.links.new(t1.outputs['Color'], p.inputs['Base Color'])
    t2 = nt.nodes.new('ShaderNodeTexImage')
    t2.image = bpy.data.images.load(mr)
    t2.image.colorspace_settings.name = 'Non-Color'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(t2.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], p.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
    canopy_lod = mat_simple('f22_canopy_lod', (0.36, 0.28, 0.13), 0.7, 0.08)
    parts = []
    deps = bpy.context.evaluated_depsgraph_get()
    for ob in list(bpy.data.objects):
        if ob.type != 'MESH' or is_under(ob, 'interior') or is_under(ob, 'interior_lite') or \
                ob.name.startswith(('r_', 'formation', 'ab_glow', 'hud_', 'pilot', 'nav_lenses')):
            continue
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(deps))
        me.transform(ob.matrix_world)
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            if m.name.startswith('f22_skin'):
                me.materials[i] = lod_skin
            elif m.name.startswith(('f22_canopy', 'r_canopy')) and 'frame' not in m.name:
                me.materials[i] = canopy_lod
        o2 = bpy.data.objects.new('lod_' + ob.name, me)
        bpy.context.scene.collection.objects.link(o2)
        parts.append(o2)
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    lod = bpy.context.view_layer.objects.active
    lod.name = 'f22_lod'
    lod.data.name = 'f22_lod'
    n0 = G.tri_count(lod)
    if n0 > target:
        mod = lod.modifiers.new('dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = target / n0
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier='dec')
    n1 = G.tri_count(lod)
    print(f'[f22] LOD triangles {n0} -> {n1}')
    ctx.lod_tris = n1
    keep = [lod]
    for n in ('contact_nose', 'contact_main_L', 'contact_main_R'):
        e = G.empty('lod_' + n, bpy.data.objects[n].matrix_world.translation.copy())
        keep.append(e)
    path = os.path.join(OUT_DIR, 'f22_lod.glb')
    names = {}
    for o in keep[1:]:
        orig = o.name[4:]
        bpy.data.objects[orig].name = orig + '_main'
        names[o] = orig
        o.name = orig
    export_glb(path, objects=keep)
    for o, orig in names.items():
        o.name = 'lod_' + orig
        bpy.data.objects[orig + '_main'].name = orig
    print('[f22] exported', path, os.path.getsize(path) // 1024, 'KB')
