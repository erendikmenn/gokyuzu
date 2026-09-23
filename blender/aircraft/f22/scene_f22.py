"""Assemble the F-22 scene: geometry, materials, hierarchy, export."""
import os
import math
import bpy
import bmesh
from mathutils import Vector, Matrix

import geom as G
from geom import Y
import shape as S
import airframe as AF
import shape as S

from util import REPO, export_glb

OUT_DIR = os.path.join(REPO, 'assets', 'aircraft', 'f22')


def mat_simple(name, color, metallic=0.0, roughness=0.5, emission=None, alpha=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    m.diffuse_color = (*color, 1)
    m.metallic = metallic
    m.roughness = roughness
    if emission is not None:
        p.inputs['Emission Color'].default_value = (*emission[:3], 1)
        p.inputs['Emission Strength'].default_value = emission[3] if len(emission) > 3 else 1.0
    if alpha is not None:
        p.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    return m


def mat_image(name, path, roughness=0.6, metallic=0.0, alpha=False):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(path, check_existing=True)
    nt.links.new(tex.outputs['Color'], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metallic
    m.diffuse_color = (0.3, 0.3, 0.3, 1)
    return m


class Ctx:
    pass


M_SKIN, M_DARK, M_HOT, M_BAY = 0, 1, 2, 3


def remap(bm, mapping):
    for f in bm.faces:
        f.material_index = mapping.get(f.material_index, f.material_index)
    return bm


def build_all(bake=False):
    import details as D
    ctx = Ctx()
    ctx.mats = {
        'skin': mat_simple('f22_skin', (0.11, 0.118, 0.128), 0.2, 0.5),
        'dark': mat_simple('f22_dark', (0.03, 0.03, 0.035), 0.0, 0.7),
        'hot': mat_simple('f22_nozzle', (0.16, 0.14, 0.13), 0.8, 0.45),
        'bay': mat_simple('f22_bay', (0.62, 0.63, 0.62), 0.0, 0.6),
        'glow': mat_simple('f22_ab_glow', (0.05, 0.03, 0.02), 0.0, 0.6, emission=(1.0, 0.45, 0.15, 0.0)),
        'glass': mat_simple('f22_canopy', (0.55, 0.42, 0.18), 0.6, 0.05, alpha=0.35),
        'gear': mat_simple('f22_gear', (0.62, 0.63, 0.62), 0.05, 0.42),
        'chrome': mat_simple('f22_chrome', (0.85, 0.86, 0.88), 1.0, 0.12),
        'lens': mat_simple('f22_lens', (0.8, 0.82, 0.85), 0.0, 0.05, emission=(1.0, 0.97, 0.9, 0.0)),
        'tire': mat_simple('f22_tire', (0.035, 0.035, 0.035), 0.0, 0.85),
        'hub': mat_simple('f22_hub', (0.30, 0.31, 0.32), 0.5, 0.38),
    }
    m = ctx.mats
    skin = m['skin']
    af_mats = [m['skin'], m['dark'], m['hot'], m['bay']]
    ctx.objects = {}
    # ---------------- fuselage
    fus = AF.Fuselage()
    bm = fus.build()
    for side in ('R', 'L'):
        G.join_bm(bm, AF.build_duct(fus, side))
    G.join_bm(bm, AF.build_turtle_deck())
    for sign in (1, -1):
        w = AF.build_wing(sign, [skin])
        G.join_bm(bm, w['fixed'])
        for k in ('lef', 'flaperon', 'aileron'):
            ctx.objects[w[k].name] = w[k]
        fixed, rud = D.build_fin(sign, [skin])
        G.join_bm(bm, fixed)
        ctx.objects[rud.name] = rud
        st = D.build_stab(sign, [skin])
        ctx.objects[st.name] = st
    G.join_bm(bm, D.build_booms())
    G.join_bm(bm, remap(D.build_aft_deck(), {0: M_HOT}))
    G.weld(bm, 2e-4)
    bm.normal_update()
    # gear doors cut from the belly
    door_objs, bay = D.cut_doors(bm, [m['skin'], m['bay']], lambda n: 0.55 if 'nose' in n else 0.62)
    for ob in door_objs:
        ctx.objects[ob.name] = ob
    G.join_bm(bm, remap(bay, {0: M_BAY}))
    # nozzles
    ctx.glow = {}
    for sign in (1, -1):
        idx = 2 if sign > 0 else 1
        st, flaps = D.build_nozzle(sign, [m['skin'], m['hot']])
        glow = bmesh.new()
        # split glow faces (mat 2) into their own object
        G.join_bm(glow, st)
        bmesh.ops.delete(glow, geom=[f for f in glow.faces if f.material_index != 2], context='FACES')
        bmesh.ops.delete(st, geom=[f for f in st.faces if f.material_index == 2], context='FACES')
        remap(glow, {2: 0})
        ctx.glow[idx] = G.new_object(f'ab_glow_{idx}', glow, [m['glow']])
        G.join_bm(bm, remap(st, {1: M_HOT}))
        for f in flaps:
            ctx.objects[f.name] = f
    G.smooth_sharp(bm, 38)
    ctx.airframe = G.new_object('airframe', bm, af_mats)
    ctx.fus = fus
    ctx.mats['formation'] = mat_simple('f22_formation', (0.55, 0.62, 0.45), 0.0, 0.4, emission=(0.6, 1.0, 0.45, 0.0))
    ctx.formation = G.new_object('formation_lights', D.build_formation_strips(), [ctx.mats['formation']])
    lens = [mat_simple('f22_lens_red', (0.55, 0.02, 0.02), 0.0, 0.08), mat_simple('f22_lens_green', (0.02, 0.45, 0.08), 0.0, 0.08),
            mat_simple('f22_lens_clear', (0.8, 0.82, 0.85), 0.0, 0.05)]
    ctx.lenses = G.new_object('nav_lenses', D.build_nav_lenses(), lens)
    # ---------------- canopy
    cb = AF.build_canopy()
    G.smooth_sharp(cb, 60)
    fb = AF.build_canopy_frame()
    for f in fb.faces:
        f.material_index = 1
    G.join_bm(cb, fb)
    ctx.canopy = G.pivot_object('canopy', cb, (0, Y(7.52), 0.70), (1, 0, 0), (0, 0, 1),
                                materials=[m['glass'], skin])
    # ---------------- gear
    gear = D.build_gear([m['gear'], m['tire'], m['hub'], m['skin'], m['chrome'], m['lens']])
    for k, ob in gear.items():
        ctx.objects[k] = ob
    G.set_parent(gear['gear_nose_steer'], gear['gear_nose'])
    for w, g in (('wheel_nose', 'gear_nose_steer'), ('wheel_main_L', 'gear_main_L'), ('wheel_main_R', 'gear_main_R')):
        G.set_parent(gear[w], gear[g])
    for name in ('lef', 'flaperon', 'aileron', 'rudder', 'stabilator'):
        pass
    for ob in ctx.objects.values():
        if not ob.name.startswith(('gear_', 'wheel_')):
            smooth_obj(ob, 38)
    # ---------------- cockpit
    import cockpit as CK
    SRC = os.path.join(OUT_DIR, 'src')
    ctx.mats['atlas'] = mat_image('f22_cockpit', os.path.join(SRC, 'cockpit.png'), 0.65)
    ctx.mats['screen'] = mat_simple('f22_screen', (0.01, 0.012, 0.012), 0.0, 0.25)
    ctx.mats['screen_hud'] = mat_simple('f22_hud', (0.0, 0.0, 0.0), 0.0, 0.2, alpha=0.0)
    ctx.mats['hudglass'] = mat_simple('f22_hud_glass', (0.45, 0.6, 0.5), 0.0, 0.05, alpha=0.12)
    ctx.cockpit = CK.build_cockpit(ctx.mats)
    import pilot as PL
    ctx.pilot = PL.build_pilot(CK.UV(), ctx.mats['atlas'])
    add_empties(ctx)
    # ---------------- skin texturing (UV atlas + baked maps)
    import materials as MT
    ctx.atlas_objs = MT.atlas_objects()
    MT.unwrap(ctx.atlas_objs)
    if bake:
        MT.bake_passes(ctx.atlas_objs)
        MT.composite()
    if os.path.exists(os.path.join(MT.TEX, 'f22_basecolor.jpg')):
        ctx.mats['skin_baked'] = MT.skin_material()
        MT.apply_skin(ctx.atlas_objs, ctx.mats['skin_baked'])
    frame = mat_simple('f22_canopy_frame', (0.09, 0.095, 0.1), 0.2, 0.5)
    ctx.canopy.data.materials[1] = frame
    return ctx


def add_empties(ctx):
    import details as D
    E = {}
    import cockpit as CK
    E['eye_pilot'] = G.empty('eye_pilot', (CK.EYE[0], Y(CK.EYE[1]), CK.EYE[2]))
    E['contact_nose'] = G.empty('contact_nose', (0, Y(D.NOSE_AXLE[1]), S.Z_GROUND))
    E['contact_main_L'] = G.empty('contact_main_L', (-D.MAIN_AXLE[0], Y(D.MAIN_AXLE[1]), S.Z_GROUND))
    E['contact_main_R'] = G.empty('contact_main_R', (D.MAIN_AXLE[0], Y(D.MAIN_AXLE[1]), S.Z_GROUND))
    E['engine_1'] = G.empty('engine_1', (-D.NOZ_XC, Y(13.2), -0.02))
    E['engine_2'] = G.empty('engine_2', (D.NOZ_XC, Y(13.2), -0.02))
    E['nozzle_1'] = G.empty('nozzle_1', (-D.NOZ_XC, Y(D.EXIT_S), -0.01))
    E['nozzle_2'] = G.empty('nozzle_2', (D.NOZ_XC, Y(D.EXIT_S), -0.01))
    for name, (x, s_, z) in D.LIGHTS.items():
        E[name] = G.empty(name, (x, Y(s_), z), size=0.1)
    # landing / taxi lights on the nose gear strut (retract with it)
    gn = bpy.data.objects['gear_nose']
    t = Vector((0, Y(D.NOSE_TRUN[1]), D.NOSE_TRUN[2]))
    a = Vector((0, Y(D.NOSE_AXLE[1]), D.NOSE_AXLE[2]))
    p = t + (a - t) * 0.45 + Vector((0, 0.15, 0))
    for name, dx in (('light_landing', -0.06), ('light_taxi', 0.06)):
        E[name] = G.empty(name, (dx, p.y, p.z), size=0.1)
        G.set_parent(E[name], gn)
    ctx.empties = E


def smooth_obj(ob, angle):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    G.smooth_sharp(bm, angle)
    bm.to_mesh(ob.data)
    bm.free()


def is_interior(ob):
    p = ob
    while p is not None:
        if p.name == 'interior':
            return True
        p = p.parent
    return False


def report(ctx):
    ext = inn = 0
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and not ob.name.startswith(('r_', 'lod_', 'f22_lod')):
            n = G.tri_count(ob)
            if is_interior(ob):
                inn += n
            else:
                ext += n
    ctx.tris = (ext, inn)
    print(f'[f22] triangles: exterior {ext}, interior {inn}, total {ext + inn}')


# ----------------------------------------------------------------------------------------------
# quick previews
# ----------------------------------------------------------------------------------------------
def preview(ctx, out_dir, views=None):
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'MATERIAL'
    sc.display.shading.show_cavity = True
    sc.display.shading.cavity_type = 'BOTH'
    sc.display.shading.show_object_outline = False
    sc.display.shading.show_specular_highlight = True
    sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
    sc.render.film_transparent = False
    sc.world = bpy.data.worlds.new('pv') if not sc.world else sc.world
    sc.display_settings.display_device = 'sRGB'
    sc.view_settings.view_transform = 'Standard'
    ALL = {
        'side': ((30, 0.0, 0.2), (0, 0.0, 0.2), 'ORTHO', 21),
        'top': ((0, 0.0, 30), (0, 0.0, 0), 'ORTHO', 20),
        'nose_close': ((3.0, 9.5, 0.6), (0, 7.5, -0.2), 'PERSP', 35),
        'inlet': ((3.6, 7.4, -0.6), (1.2, 3.8, -0.5), 'PERSP', 35),
        'side_persp': ((9, 2, 0.8), (0, 1.0, 0), 'PERSP', 35),
        'wingroot': ((5, -3, 3), (1.5, -1, 0), 'PERSP', 35),
        'front': ((0, 30, 0.3), (0, 0, 0.3), 'ORTHO', 15),
        'rear': ((0, -30, 0.3), (0, 0, 0.3), 'ORTHO', 15),
        'bottom': ((0, 0.0, -30), (0, 0.0, 0), 'ORTHO', 20),
        'q_front': ((13, 16, 6), (0, 0.5, 0), 'PERSP', 50),
        'q_rear': ((-12, -15, 5), (0, -0.5, 0), 'PERSP', 50),
        'q_low': ((9, 12, -3.5), (0, 2, -0.3), 'PERSP', 50),
        'nose': ((4.5, 12.5, 1.5), (0, 6.0, 0), 'PERSP', 40),
        'nozzle': ((-3.2, -12.5, 1.2), (-0.3, -7.6, 0.0), 'PERSP', 40),
        'gear': ((4.5, 3.0, -1.6), (0, 2.0, -1.2), 'PERSP', 30),
        'ngear': ((-2.0, 7.2, -1.3), (0, 5.1, -1.35), 'PERSP', 32),
        'mgear': ((4.2, 1.8, -1.5), (1.5, -0.9, -1.25), 'PERSP', 32),
        'cockpit': ((0, 10.1 - 4.80, 0.90), (0, 10.1 - 3.8, 0.55), 'PERSP', 16),
        'cockpit_l': ((0, 10.1 - 4.80, 0.90), (-0.6, 10.1 - 4.5, 0.2), 'PERSP', 14),
        'cockpit_ext': ((1.6, 10.1 - 3.2, 2.2), (0, 10.1 - 4.6, 0.3), 'PERSP', 30),
    }
    V = {k: ALL[k] for k in views} if views else {k: ALL[k] for k in ('side', 'top', 'front', 'rear', 'bottom', 'q_front', 'q_rear', 'q_low', 'nose')}
    for name, (loc, tgt, kind, lens) in V.items():
        cam = bpy.data.cameras.new('pvcam')
        cam.clip_end = 1000
        ob = bpy.data.objects.new('pvcam', cam)
        sc.collection.objects.link(ob)
        ob.location = loc
        d = Vector(tgt) - Vector(loc)
        up = 'Y' if abs(d.normalized().z) < 0.99 else 'Y'
        ob.rotation_euler = d.to_track_quat('-Z', 'Y' if abs(d.normalized().z) < 0.99 else 'Y').to_euler()
        if abs(d.normalized().z) > 0.99:
            ob.rotation_euler = (0, 0, 0) if d.z < 0 else (math.pi, 0, 0)
            sc.render.resolution_x, sc.render.resolution_y = 1100, 1500
        else:
            sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
        if kind == 'ORTHO':
            cam.type = 'ORTHO'
            cam.ortho_scale = lens
        else:
            cam.lens = lens
        sc.camera = ob
        cam.clip_start = 0.02
        if 'canopy' in bpy.data.objects:
            bpy.data.objects['canopy'].hide_render = name in ('cockpit', 'cockpit_l', 'cockpit_ext')
        sc.render.filepath = os.path.join(out_dir, f'{name}.png')
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(ob)


def export_main(ctx):
    path = os.path.join(OUT_DIR, 'f22.glb')
    export_glb(path)
    print('[f22] exported', path, os.path.getsize(path) // 1024, 'KB')


def export_lod(ctx, target=36000):
    """Static parked copy: one merged mesh (gear down, nose doors open), decimated, 2K textures."""
    import renders_f22 as R
    import materials as MT
    R.pose()
    bpy.context.view_layer.update()
    # downscaled skin textures
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
    canopy_lod = mat_simple('f22_canopy_lod', (0.32, 0.26, 0.14), 0.7, 0.08)
    parts = []
    deps = bpy.context.evaluated_depsgraph_get()
    for ob in list(bpy.data.objects):
        if ob.type != 'MESH' or is_interior(ob) or ob.name.startswith(('r_', 'formation', 'ab_glow', 'hud_', 'pilot')):
            continue
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(deps))
        me.transform(ob.matrix_world)
        # remap materials
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
    # a crude seat/headbox silhouette so the canopy isn't empty
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
    # export only the LOD objects (rename contact empties to the contract names inside the file)
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
