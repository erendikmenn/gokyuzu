"""F-16C Block 50 "Fighting Falcon" — procedural Blender build (geometry from a CC0 3-view, see ref/).

Usage (repo root):
  Blender -b -P blender/aircraft/f16/build.py -- [--export] [--lod] [--bake] [--renders] [--cpu]
          [--shots hero,front34,rear_ab,top,cockpit,thumb] [--samples N] [--pct P] [--outdir DIR] [--preview DIR]
Full pipeline (textures -> AO bake -> skin atlas -> GLB/LOD -> renders): sh blender/aircraft/f16/make_all.sh
Modules: f16_geom (splines/loft), f16_fuselage (cross-section loft), f16_parts (wing/tails/canopy/nozzle/intake),
f16_gear, f16_pilot, f16_assemble (booleans, pivots), f16_render (Cycles scenes) + f16_cams (cockpit cameras),
textures.py (venv Python: numpy + PIL + scipy).
Cockpit (wave 6, CONTRACTS-SF.md §6.2.1): f16_ck_layout (panel frames + items), f16_ck_geom (geometry), f16_ck_art.py
(venv: paints build/art/<panel>.png). --export joins the cockpit, gives it unique UVs, bakes albedo x soft sky light into
tex/cockpit_atlas.jpg and writes f16_cockpit.glb (root 'interior') next to f16.glb (exterior + 'interior_lite').
f16_cockpit.py (wave 5) still provides the canopy mirrors of the exterior.
"""
import os
import sys
import math
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))

import importlib
import bpy
from mathutils import Vector, Matrix, Euler, Quaternion

import util
import f16_geom, f16_fuselage, f16_bpy
for _m in (f16_geom, f16_fuselage, f16_bpy):
    importlib.reload(_m)
from f16_geom import CG_S, CG_Z, bl, to_blender
from f16_bpy import *

REPO = util.REPO
ASSETS = os.path.join(REPO, 'assets', 'aircraft', 'f16')
RENDERS = os.path.join(REPO, 'renders', 'aircraft', 'f16')


def args():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'preview': None, 'export': False, 'lod': False, 'renders': False, 'fast': False, 'shots': None, 'samples': 256}
    i = 0
    while i < len(a):
        k = a[i]
        if k == '--preview':
            opts['preview'] = a[i + 1]; i += 1
        elif k == '--shots':
            opts['shots'] = a[i + 1].split(','); i += 1
        elif k == '--samples':
            opts['samples'] = int(a[i + 1]); i += 1
        elif k == '--set':
            kk, vv = a[i + 1].split('='); opts.setdefault('set', {})[kk] = float(vv); i += 1
        elif k == '--pct':
            opts['pct'] = int(a[i + 1]); i += 1
        elif k == '--outdir':
            opts['outdir'] = a[i + 1]; i += 1
        elif k == '--glbdir':
            opts['glbdir'] = a[i + 1]; i += 1
        elif k == '--res':
            opts['res'] = tuple(int(x) for x in a[i + 1].split('x')); i += 1
        elif k.startswith('--'):
            opts[k[2:]] = True
        i += 1
    return opts


def build_exterior(mats):
    import f16_parts as PT
    import f16_layout as LY
    import numpy as np
    from f16_geom import orient
    importlib.reload(LY); importlib.reload(PT)
    parts = {}
    fus = f16_fuselage.fuselage_mesh(uv_fn=LY.fus_uv)
    parts['fuselage'] = mesh_object(fus, 'fuselage', mats['skin'], smooth=True)
    for side in ('R', 'L'):
        parts['wing_' + side] = mesh_object(PT.wing_mesh(side), 'wing_' + side, mats['skin'], recalc=True, auto_angle=60)
        parts['stab_' + side] = mesh_object(PT.stab_mesh(side), 'stab_' + side, mats['skin'], recalc=True, auto_angle=60)
        parts['ventral_' + side] = mesh_object(PT.ventral_mesh(side), 'ventral_' + side, mats['skin'], recalc=True, auto_angle=50)
        parts['launcher_' + side] = mesh_object(PT.launcher_mesh(side), 'launcher_' + side, mats['skin_plain'], recalc=True, auto_angle=60)
        y = 4.815 if side == 'R' else -4.815
        parts['aim9_' + side] = mesh_object(PT.aim9x(y=y), 'aim9_' + side, mats['missile'], recalc=True, auto_angle=40)
        parts['aim9_dome_' + side] = mesh_object(PT.aim9_dome(y=y), 'aim9_dome_' + side, mats['seeker'], auto_angle=60)
        for key, md in PT.aim9_bands(y=y):
            parts[f'aim9_{key}_{side}'] = mesh_object(md, f'aim9_{key}_{side}', mats[key], auto_angle=60)
        for up in (True, False):
            md, hinge = PT.speedbrake_panel(side, up, cell=(0 if up else 1) + (0 if side == 'R' else 2))
            nm = f'speedbrake_{side}_{"upper" if up else "lower"}'
            parts[nm] = mesh_object(md, nm, mats['skin'], recalc=True, auto_angle=40)
    parts['fin'] = mesh_object(PT.fin_mesh(), 'fin', mats['skin'], recalc=True, auto_angle=60)
    parts['dorsal'] = mesh_object(PT.dorsal_mesh(), 'dorsal', mats['skin'], recalc=True, auto_angle=60)
    parts['fincap'] = mesh_object(PT.fincap_mesh(), 'fincap', mats['skin'], recalc=True, auto_angle=60)
    can = PT.canopy_mesh()
    orient(can, lambda c: np.array([c[0], 0.0, c[2] - 0.6]))
    parts['canopy_skin'] = mesh_object(can, 'canopy_skin', [mats['glass'], mats['skin']], auto_angle=50)
    parts['canopy_frame'] = mesh_object(PT.canopy_frame_mesh(), 'canopy_frame', mats['canopy_frame'], recalc=True, auto_angle=50)
    parts['canopy_arch'] = mesh_object(PT.arch_mesh(), 'canopy_arch', mats['canopy_frame'], recalc=True, auto_angle=50)
    for k in range(PT.NOZ_N):
        md, hp, tg, am = PT.nozzle_petal(k)
        parts[f'petal_{k:02d}'] = mesh_object(md, f'nozzle_petal_{k:02d}', mats['nozzle'], recalc=True, auto_angle=40)
    for nm, md in PT.nozzle_fixed().items():
        parts['noz_' + nm] = mesh_object(md, 'nozzle_' + nm, mats['nozzle_in'], auto_angle=50)
    duct = PT.intake_duct()
    orient(duct, lambda c: np.array([-c[0], 0.0, (-0.5) - c[2]]))
    parts['duct'] = mesh_object(duct, 'intake_duct', mats['duct'], auto_angle=60)
    parts['lip'] = mesh_object(PT.intake_lip(), 'intake_lip', mats['skin_plain'], recalc=True)
    parts['hood'] = mesh_object(PT.intake_hood(), 'intake_hood', mats['skin_plain'], recalc=True, auto_angle=50)
    parts['pitot'] = mesh_object(PT.pitot_mesh(), 'pitot', mats['metal'], recalc=True, auto_angle=50)
    for nm, md, mk in PT.details():
        parts['detail_' + nm] = mesh_object(md, nm, mats[mk], recalc=True, auto_angle=40)
    return parts


def preview(outdir, views=None):
    os.makedirs(outdir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'MATERIAL'
    sc.display.shading.show_cavity = True
    sc.display.shading.show_shadows = False
    sc.render.film_transparent = True
    world = bpy.data.worlds.new('W'); sc.world = world
    ppm = 120
    # calibrated ortho views matching the reference grid images (s 0..15.2, side z -0.2..5.3, top y -4.9..4.9)
    sc_mid = 7.6
    cal = {
        'side': dict(res=(int(15.2 * ppm), int(5.5 * ppm)), loc=(-30, CG_S - sc_mid, (2.55 - CG_Z)), rot=(math.radians(90), 0, math.radians(-90)), scale=15.2),
        'top': dict(res=(int(15.2 * ppm), int(9.8 * ppm)), loc=(0, CG_S - sc_mid, 30), rot=(0, 0, math.radians(-90)), scale=15.2),
        'front': dict(res=(int(9.8 * ppm), int(5.5 * ppm)), loc=(0, 30, (2.55 - CG_Z)), rot=(math.radians(90), 0, math.radians(180)), scale=9.8),
    }
    for name, c in cal.items():
        if views and name not in views:
            continue
        cam = bpy.data.cameras.new('C_' + name); cam.type = 'ORTHO'; cam.ortho_scale = c['scale']; cam.clip_end = 200
        co = bpy.data.objects.new('C_' + name, cam); bpy.context.scene.collection.objects.link(co)
        co.location = c['loc']; co.rotation_euler = c['rot']
        sc.camera = co
        sc.render.resolution_x, sc.render.resolution_y = c['res']
        util.render_still(os.path.join(outdir, f'cal_{name}.png'))
    sc.render.film_transparent = False
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    persp = {
        'q34': ((13, 13, 5), (0, 0.5, -0.3), 35),
        'q34r': ((-12, -13, 4), (0, -1, -0.3), 35),
        'q34low': ((9, 12, -3.2), (0, 1.2, -0.4), 35),
        'nose': ((4.5, 9.5, 1.2), (0, 4.0, 0.3), 35),
        'eye': (bl((4.285, 0, 2.82)), bl((3.2, 0, 2.55)), 18),
        'cockpit_out': ((1.6, 6.0, 1.6), (0, 4.4, 0.55), 30),
    }
    for name, (loc, tgt, lens) in persp.items():
        if views and name not in views:
            continue
        cam = util.add_camera(loc, tgt, lens=lens, name='Cam_' + name)
        sc.camera = cam
        util.render_still(os.path.join(outdir, f'prev_{name}.png'))

def make_materials():
    M = {}
    tex = os.path.join(ASSETS, 'tex')
    def img(name, colorspace='sRGB'):
        p = os.path.join(tex, name)
        if not os.path.exists(p):
            return None
        im = bpy.data.images.load(p, check_existing=True)
        im.colorspace_settings.name = colorspace
        return im
    sc, sn, so = img('skin_color.jpg'), img('skin_normal.png', 'Non-Color'), img('skin_orm.png', 'Non-Color')
    if sc is not None:
        M['skin'] = image_material('skin', sc, sn, so, rough=0.55, normal_strength=1.0)
    else:
        M['skin'] = principled('skin', (0.35, 0.37, 0.39), 0.5)
    M['skin_plain'] = principled('skin_plain', (0.36, 0.38, 0.40), 0.55)
    M['canopy_frame'] = principled('canopy_frame', (0.05, 0.05, 0.055), 0.45)
    g = principled('canopy_glass', (0.97, 0.90, 0.72), 0.02, transmission=1.0, ior=1.52)
    b = g.node_tree.nodes.get('Principled BSDF')
    try:
        b.inputs['Specular Tint'].default_value = (1.0, 0.80, 0.45, 1.0)
    except Exception:
        pass
    M['glass'] = g
    M['missile'] = principled('missile', (0.62, 0.64, 0.64), 0.45)
    nzi = img('nozzle_color.jpg')
    M['nozzle'] = image_material('nozzle', nzi, None, None, rough=0.42, metal=0.8) if nzi is not None else principled('nozzle', (0.25, 0.24, 0.22), 0.4, metal=0.8)
    M['nozzle_in'] = principled('nozzle_inner', (0.09, 0.085, 0.08), 0.65, metal=0.4)
    M['duct'] = principled('intake_duct', (0.62, 0.62, 0.60), 0.6)
    M['metal'] = principled('metal', (0.55, 0.55, 0.55), 0.3, metal=1.0)
    M['cutter'] = principled('cutter', (1, 0, 1), 0.5)
    M['well'] = principled('gear_well', (0.62, 0.63, 0.60), 0.7)
    M['cockpit_wall'] = principled('cockpit_wall', (0.12, 0.12, 0.13), 0.7)
    M['strut'] = principled('gear_strut', (0.72, 0.73, 0.72), 0.45)
    M['piston'] = principled('gear_piston', (0.85, 0.86, 0.88), 0.12, metal=1.0)
    M['tire'] = principled('tire', (0.03, 0.03, 0.03), 0.85)
    M['hub'] = principled('wheel_hub', (0.55, 0.56, 0.56), 0.4, metal=0.6)
    M['dark'] = principled('dark', (0.02, 0.02, 0.02), 0.6)
    M['lens'] = principled('lamp_lens', (0.9, 0.9, 0.9), 0.05, emission=(1, 0.95, 0.85), emission_strength=0.0)
    M['door_in'] = principled('door_inner', (0.62, 0.63, 0.60), 0.7)
    M['antenna'] = principled('antenna', (0.20, 0.215, 0.23), 0.5)
    M['seeker'] = principled('seeker_dome', (0.02, 0.02, 0.025), 0.05, metal=0.3)
    M['band_yellow'] = principled('band_yellow', (0.75, 0.55, 0.05), 0.5)
    M['band_brown'] = principled('band_brown', (0.25, 0.14, 0.06), 0.55)
    M['lens_red'] = principled('navlens_red', (0.8, 0.05, 0.03), 0.05, emission=(1, 0.08, 0.04), emission_strength=0.0)
    M['lens_green'] = principled('navlens_green', (0.05, 0.8, 0.2), 0.05, emission=(0.1, 1, 0.3), emission_strength=0.0)
    M['lens_white'] = principled('navlens_white', (0.85, 0.85, 0.85), 0.05, emission=(1, 1, 1), emission_strength=0.0)
    # cockpit
    M['ck_panel'] = principled('ck_panel', (0.10, 0.105, 0.11), 0.6)
    M['ck_dark'] = principled('ck_dark', (0.075, 0.078, 0.082), 0.7)
    M['ck_black'] = principled('ck_black', (0.018, 0.018, 0.02), 0.55)
    M['ck_metal'] = principled('ck_metal', (0.6, 0.6, 0.6), 0.35, metal=1.0)
    M['ck_seat'] = principled('ck_seat', (0.10, 0.11, 0.07), 0.9)
    M['ck_yellow'] = principled('ck_yellow', (0.85, 0.65, 0.05), 0.5)
    M['hud_glass'] = principled('hud_glass', (0.3, 0.5, 0.35), 0.05, alpha=0.12)
    M['ck_mirror'] = principled('ck_mirror', (0.9, 0.9, 0.9), 0.02, metal=1.0)
    M['ck_rubber'] = principled('ck_rubber', (0.03, 0.03, 0.03), 0.8)
    M['ck_red'] = principled('ck_red', (0.6, 0.02, 0.02), 0.4)
    M['ck_white'] = principled('ck_white', (0.8, 0.8, 0.78), 0.5)
    M['ck_strap'] = principled('ck_strap', (0.12, 0.13, 0.09), 0.85)
    M['screen'] = principled('screen', (0.0, 0.0, 0.0), 0.25)
    # pilot
    M['pl_suit'] = principled('pl_suit', (0.105, 0.115, 0.075), 0.85)
    M['pl_vest'] = principled('pl_vest', (0.06, 0.07, 0.045), 0.8)
    M['pl_gsuit'] = principled('pl_gsuit', (0.14, 0.13, 0.085), 0.85)
    M['pl_helmet'] = principled('pl_helmet', (0.20, 0.21, 0.22), 0.45)
    M['pl_visor'] = principled('pl_visor', (0.01, 0.01, 0.012), 0.05, metal=0.5)
    M['pl_mask'] = principled('pl_mask', (0.09, 0.10, 0.08), 0.6)
    M['pl_strap'] = principled('pl_strap', (0.07, 0.075, 0.05), 0.8)
    M['pl_glove'] = principled('pl_glove', (0.04, 0.035, 0.03), 0.7)
    M['pl_boot'] = principled('pl_boot', (0.02, 0.02, 0.02), 0.5)
    M['pl_board'] = principled('pl_board', (0.03, 0.03, 0.032), 0.6)
    M['pl_paper'] = principled('pl_paper', (0.62, 0.62, 0.58), 0.8)
    M['hud_combiner'] = principled('hud_combiner', (0.55, 0.85, 0.65), 0.02, transmission=1.0, ior=1.5)
    cki = img('cockpit_color.png')
    if cki is not None:
        M['ck_panel'] = image_material('ck_panel', cki, None, None, rough=0.62)
    M['ck_seat'] = principled('ck_seat', (0.075, 0.085, 0.05), 0.9)
    return M


def assemble(parts, mats):
    import f16_assemble as AS
    import f16_parts as PT
    import f16_gear as GR
    importlib.reload(GR); importlib.reload(AS)
    root = empty('F16', size=1.0)
    out = {}
    # --- control surfaces
    for side in ('R', 'L'):
        sg = 1 if side == 'R' else -1
        wing = parts['wing_' + side]
        md, p0, p1 = PT.flaperon_cutter(side)
        ax = AS.B(p1) - AS.B(p0) if side == 'R' else AS.B(p0) - AS.B(p1)
        out['ctl_flaperon_' + side] = AS.make_control(wing, md, 'ctl_flaperon_' + side, p0, ax, (0, 0, 1), mats)
        md, p0, p1 = PT.lef_cutter(side)
        ax = AS.B(p1) - AS.B(p0) if side == 'R' else AS.B(p0) - AS.B(p1)
        out['ctl_lef_' + side] = AS.make_control(wing, md, 'ctl_lef_' + side, p0, ax, (0, 0, 1), mats)
        # stabilator: pivot on the root at the pivot station, axis along the anhedral span direction
        st = parts['stab_' + side]
        st.name = 'ctl_stabilator_' + side
        piv = (PT.STAB_PIVOT_S, sg * PT.STAB_Y0, PT.STAB_Z0)
        span_dir = Vector((sg * math.cos(PT.STAB_ANHEDRAL), 0, -math.sin(PT.STAB_ANHEDRAL)))
        ax = span_dir if side == 'R' else -span_dir
        set_origin_basis(st, AS.B(piv), ax, (0, 0, 1))
        out['ctl_stabilator_' + side] = st
        # speedbrakes: group empty + two hinged panels
        grp = empty('ctl_speedbrake_' + side, loc=bl((PT.SB_S0, sg * 0.86, PT.SB_ZMID)), size=0.1)
        grp.parent = root
        for up in (True, False):
            o = parts[f'speedbrake_{side}_{"upper" if up else "lower"}']
            hz = PT.SB_ZMID + (0.095 if up else -0.095)
            set_origin_basis(o, AS.B((PT.SB_S0, sg * 0.86, hz)), (1, 0, 0), (0, 0, 1))
            o['open_angle'] = math.radians(-58 if up else 58)
            parent_keep(o, grp)
        out['ctl_speedbrake_' + side] = grp
    md, p0, p1 = PT.rudder_cutter()
    out['ctl_rudder'] = AS.make_control(parts['fin'], md, 'ctl_rudder', p0, AS.B(p1) - AS.B(p0), (1, 0, 0), mats)
    # --- fuselage openings, wells, doors
    doors = AS.cut_fuselage(parts['fuselage'], mats)
    # nose doors: split into left/right at y=0, hinge at the outer edges
    nd = doors['nose']
    ndL = copy_object(nd, 'gear_door_nose_L')
    nd.name = 'gear_door_nose_R'
    AS.bisect_keep(nd, Vector((0, 0, 0)), Vector((1, 0, 0)), keep_positive=True)
    AS.bisect_keep(ndL, Vector((0, 0, 0)), Vector((1, 0, 0)), keep_positive=False)
    door_list = [(nd, 'R', 0.255), (ndL, 'L', -0.255), (doors['main_R'], 'R', 0.78), (doors['main_L'], 'L', -0.78)]
    doors['main_R'].name = 'gear_door_main_R'
    doors['main_L'].name = 'gear_door_main_L'
    for o, side, yh in door_list:
        AS.solidify(o, 0.012, inner_mat=mats['door_in'])
        # hinge along s at the outer edge, at the lowest skin z there
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        ys = [v.y for v in bb]
        zs = [v.z for v in bb]
        hinge = Vector((yh, 0.5 * (min(ys) + max(ys)), max(zs) - 0.02 if abs(yh) > 0.5 else min(zs) + 0.03))
        set_origin_basis(o, hinge, (0, 1, 0), (0, 0, 1))
        # choose the opening sign that moves the door centroid down
        cen = sum((o.matrix_world @ v.co for v in o.data.vertices), Vector()) / len(o.data.vertices)
        rel = cen - hinge
        best = None
        for sgn in (1, -1):
            R = Matrix.Rotation(sgn * math.radians(60), 3, Vector((0, 1, 0)))
            z = (R @ rel).z
            if best is None or z < best[0]:
                best = (z, sgn)
        o['open_angle'] = best[1] * math.radians(95 if abs(yh) > 0.5 else 88)
        o['sequence'] = 'cycle'
        o.parent = root if False else None
        out[o.name] = o
    # --- landing gear
    g = AS.build_gear(mats, root)
    out.update(g)
    # --- canopy: join skin + frame + arch, pivot on the hinge
    cs = parts['canopy_skin']
    for k in ('canopy_frame', 'canopy_arch'):
        o = parts[k]
        with bpy.context.temp_override(active_object=cs, selected_editable_objects=[cs, o], object=cs):
            bpy.ops.object.join()
    cs.name = 'canopy'
    set_origin_basis(cs, AS.B((PT.CANOPY_HINGE[0], 0.0, PT.CANOPY_HINGE[1])), (1, 0, 0), (0, 0, 1))
    cs['open_angle'] = math.radians(38)
    out['canopy'] = cs
    # --- nozzle petals: pivot at their hinge, local X so that +angle opens
    pet_grp = empty('nozzle_petals', loc=bl((PT.NOZ_S0, 0, PT.NOZ_ZC)), size=0.2)
    pet_grp.parent = root
    for k in range(PT.NOZ_N):
        o = parts[f'petal_{k:02d}']
        _, hp, tg, am = PT.nozzle_petal(k)
        axis = Vector((-math.cos(am), 0.0, math.sin(am)))
        set_origin_basis(o, AS.B(hp), axis, (0, 1, 0))
        o['open_angle'] = math.radians(7.6)
        parent_keep(o, pet_grp)
    # --- empties
    E = {}
    E['eye_pilot'] = bl((4.26, 0.0, 2.815))
    E['contact_nose'] = bl((GR.NOSE_AXLE[0], 0.0, 0.0))
    E['contact_main_L'] = bl((GR.MAIN_AXLE[0], -GR.MAIN_AXLE[1], 0.0))
    E['contact_main_R'] = bl((GR.MAIN_AXLE[0], GR.MAIN_AXLE[1], 0.0))
    E['engine_1'] = bl((11.2, 0.0, 1.885))
    E['nozzle_1'] = bl((PT.NOZ_S1, 0.0, PT.NOZ_ZC))
    E['light_nav_L'] = bl((5.35, -0.79, 1.42))
    E['light_nav_R'] = bl((5.35, 0.79, 1.42))
    E['light_tail'] = bl((15.062, 0.0, 5.09))
    E['light_strobe_top'] = bl((14.45, 0.0, 5.19))
    E['light_formation_L'] = bl((6.2, -0.72, 2.28))
    E['light_formation_R'] = bl((6.2, 0.72, 2.28))
    for k, v in E.items():
        e = empty(k, loc=v, size=0.08)
        e.parent = root
        out[k] = e
    # parent all mesh parts to root
    for o in list(bpy.context.scene.objects):
        if o is root or o.parent is not None:
            continue
        if o.type in ('MESH', 'EMPTY'):
            parent_keep(o, root)
    return root, out


def build_canopy_mirrors(mats):
    """Rear-view mirrors on the canopy frame (exterior GLB, move with the canopy). Unchanged from wave 5."""
    import f16_cockpit as CP
    import f16_cockpit_layout as CLo
    importlib.reload(CLo); importlib.reload(CP)
    scr = {}
    parts = CP.build(scr)
    canopy = bpy.data.objects.get('canopy')
    objs = {}
    for key, matk in (('cmirror', 'ck_mirror'), ('cmirror_frame', 'ck_black')):
        md = parts.get(key)
        if md is None or not md.faces:
            continue
        o = mesh_object(md, 'cockpit_' + key, mats[matk], auto_angle=35)
        if key == 'cmirror_frame':
            bv = o.modifiers.new('bevel', 'BEVEL')
            bv.width = 0.0035
            bv.segments = 2
            bv.limit_method = 'ANGLE'
            bv.angle_limit = math.radians(40)
            try:
                bv.harden_normals = True
            except Exception:
                pass
            apply_modifiers(o)
        if canopy is not None:
            parent_keep(o, canopy)
        objs[key] = o
    return objs


# cockpit constant colours (sRGB 0..255), roughness, metallic (renders only; the bake uses metallic 0)
CK_COLORS = {
    'panel': ((44, 47, 50), 0.70, 0.0), 'black': ((20, 20, 21), 0.45, 0.0), 'rubber': ((30, 30, 31), 0.75, 0.0),
    'metal': ((168, 170, 173), 0.30, 1.0), 'lgray': ((172, 172, 166), 0.45, 0.0), 'white': ((226, 226, 220), 0.45, 0.0),
    'red': ((165, 30, 24), 0.40, 0.0), 'yellow': ((218, 168, 26), 0.45, 0.0), 'glare': ((38, 40, 43), 0.88, 0.0),
    'wall': ((64, 68, 72), 0.72, 0.0), 'floor': ((36, 37, 39), 0.90, 0.0), 'rail': ((42, 44, 47), 0.55, 0.0),
    'hudframe': ((52, 54, 57), 0.45, 0.0), 'lens_amber': ((70, 45, 10), 0.08, 0.0), 'lens_green': ((12, 55, 22), 0.08, 0.0),
    'lens_red': ((70, 12, 10), 0.08, 0.0), 'lever_green': ((40, 125, 55), 0.40, 0.0), 'lever_red': ((170, 32, 26), 0.40, 0.0),
    'stick': ((24, 24, 25), 0.55, 0.0), 'stickhat': ((44, 44, 46), 0.45, 0.0), 'cushion': ((82, 86, 78), 0.92, 0.0),
    'seatframe': ((124, 130, 134), 0.55, 0.0), 'headbox': ((60, 64, 58), 0.80, 0.0), 'strap': ((92, 98, 82), 0.90, 0.0),
    'fur': ((26, 26, 27), 1.0, 0.0), 'kit': ((52, 78, 60), 0.85, 0.0),
}
CK_BUILD = os.path.join(HERE, 'build')
CK_TEX_OUT = os.path.join(ASSETS, 'tex')


def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def ck_material(key):
    name = 'ck2_' + key
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    if key.startswith('art_'):
        path = os.path.join(CK_BUILD, 'art', key[4:] + '.png')
        im = bpy.data.images.load(path, check_existing=True)
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        b = nt.nodes.get('Principled BSDF')
        b.inputs['Roughness'].default_value = 0.62
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = im; t.name = 'art'
        uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'UVMap'
        nt.links.new(uvn.outputs['UV'], t.inputs['Vector'])
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        return m
    col, rough, metal = CK_COLORS[key]
    return principled(name, tuple(_lin(c) for c in col), rough, metal=metal)


def build_interior(mats, root):
    """Wave 6 cockpit: f16_ck_geom parts -> objects under 'interior' (art + constant materials), screens, glass."""
    import f16_ck_layout as CKL
    import f16_ck_geom as CKG
    importlib.reload(CKL); importlib.reload(CKG)
    interior = empty('interior', size=0.2)
    interior.parent = root
    md, screens, glass = CKG.build()
    objs = {}
    for key, m in md.items():
        base, _, lite = key.partition('|')
        kind, _, name = base.partition(':')
        mat = ck_material(('art_' + name) if kind == 'art' else name)
        o = mesh_object(m, 'ck_' + base.replace(':', '_') + ('_lite' if lite else ''), mat, auto_angle=40)
        o['ck_lite'] = 1 if lite else 0
        o['ck_art'] = 1 if kind == 'art' else 0
        o.parent = interior
        objs[o.name] = o
    for name, m in screens.items():
        o = mesh_object(m, name, mats['hud_combiner'] if name == 'screen_hud' else mats['screen'], smooth=False)
        o.parent = interior
        objs[name] = o
    gmat = {'hud_glass': mats['hud_glass'], 'gauge_glass': principled('gauge_glass', (0.6, 0.62, 0.62), 0.04, alpha=0.10)}
    for name, m in glass.items():
        o = mesh_object(m, 'ck_' + name, gmat[name], smooth=False)
        o.parent = interior
        objs[o.name] = o
    return interior, objs


def ck_join(interior):
    """Join every baked cockpit part into one mesh 'ck_main' with face attributes art / lite."""
    import bmesh
    parts = [o for o in interior.children if o.type == 'MESH' and 'ck_art' in o]
    for o in parts:
        me = o.data
        for nm, val in (('ck_art', o['ck_art']), ('ck_lite', o['ck_lite'])):
            a = me.attributes.new(nm, 'INT', 'FACE')
            a.data.foreach_set('value', [int(val)] * len(me.polygons))
    with bpy.context.temp_override(active_object=parts[0], selected_editable_objects=parts, object=parts[0]):
        bpy.ops.object.join()
    main = parts[0]
    main.name = 'ck_main'
    main.data.name = 'ck_main'
    return main


def _face_attr(me, name):
    a = me.attributes[name]
    v = [0] * len(me.polygons)
    a.data.foreach_get('value', v)
    return v


def ck_uv1(obj, art_density=4.2):
    """Unique lightmap-style UVs (UV1) for the bake: art faces get art_density x the texel density of the rest."""
    import bmesh
    me = obj.data
    art = _face_attr(me, 'ck_art')
    uv1 = me.uv_layers.new(name='UV1')
    me.uv_layers.active = uv1
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    for grp in (1, 0):
        bpy.ops.object.mode_set(mode='EDIT')
        bm = bmesh.from_edit_mesh(me)
        bm.faces.ensure_lookup_table()
        for f in bm.faces:
            f.select_set(art[f.index] == grp)
        bm.select_flush(True)
        bmesh.update_edit_mesh(me)
        bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.0, area_weight=0.0, correct_aspect=True,
                                 scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT')
    # texel density per group -> rescale so art faces get art_density x
    import numpy as np
    me = obj.data
    uv1 = me.uv_layers['UV1']
    uv = np.zeros(len(me.loops) * 2); uv1.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
    area3 = np.zeros(len(me.polygons)); me.polygons.foreach_get('area', area3)
    ls = np.zeros(len(me.polygons), int); me.polygons.foreach_get('loop_start', ls)
    lt = np.zeros(len(me.polygons), int); me.polygons.foreach_get('loop_total', lt)
    auv = np.zeros(len(me.polygons))
    for i in range(len(me.polygons)):
        P = uv[ls[i]:ls[i] + lt[i]]
        x, y = P[:, 0], P[:, 1]
        auv[i] = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    artv = np.array(art)
    scale = np.ones(len(me.polygons))
    for grp, target in ((1, art_density), (0, 1.0)):
        m = artv == grp
        d = math.sqrt(auv[m].sum() / max(area3[m].sum(), 1e-9))
        scale[m] = target / d
    for i in range(len(me.polygons)):
        uv[ls[i]:ls[i] + lt[i]] *= scale[i]
    me.uv_layers['UV1'].data.foreach_set('uv', uv.ravel())
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    print("[f16] packing", flush=True)
    bpy.ops.uv.pack_islands(margin=0.0012, rotate=True, scale=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    me = obj.data
    uv = np.zeros(len(me.loops) * 2); me.uv_layers['UV1'].data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
    for grp, nm in ((1, 'art'), (0, 'other')):
        a3 = auv_g = 0.0
        for i in range(len(me.polygons)):
            if art[i] != grp:
                continue
            P = uv[ls[i]:ls[i] + lt[i]]
            auv_g += 0.5 * abs(np.dot(P[:, 0], np.roll(P[:, 1], -1)) - np.dot(P[:, 1], np.roll(P[:, 0], -1)))
            a3 += area3[i]
        print(f'[f16] UV1 {nm}: {a3:.2f} m2, {auv_g * 100:.1f}% of the atlas, {math.sqrt(auv_g / max(a3, 1e-9)) * 4096:.0f} px/m at 4096', flush=True)
    print('[f16] UV1 packed', flush=True)


def _box_blur(a, r):
    import numpy as np
    if r <= 0:
        return a
    k = 2 * r + 1
    c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0)), mode='edge'), axis=0)
    a = (c[k:] - c[:-k]) / k
    c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r)), mode='edge'), axis=1)
    return (c[:, k:] - c[:, :-k]) / k


def ck_bake(obj, size=4096, samples=128, gpu=True):
    """Bake albedo (DIFFUSE colour) and soft interior light (DIFFUSE direct+indirect, uniform sky entering through the
    canopy) into UV1 and compose albedo x light -> tex/cockpit_atlas.jpg + tex/cockpit_atlas_lite.jpg (1024)."""
    import numpy as np
    sc = bpy.context.scene
    util.setup_cycles(samples=samples, width=64, height=64, gpu=gpu)
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.cycles.max_bounces = 4
    sc.cycles.diffuse_bounces = 3
    old_world = sc.world
    w = bpy.data.worlds.new('ck_bake_sky'); w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (1, 1, 1, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 1.0
    sc.world = w
    # the light enters through the canopy: glass fully transparent for the bake; pilot / glass parts / screens hidden
    hidden = []
    for o in sc.objects:
        if o.type != 'MESH' or o.hide_render:
            continue
        if o.name.startswith(('pilot', 'ck_gauge_glass', 'ck_hud_glass', 'screen_')):
            o.hide_render = True; hidden.append(o)
    glass = bpy.data.materials.get('canopy_glass')
    saved_glass = None
    if glass is not None:
        nt = glass.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        saved_glass = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].links else None
        tr = nt.nodes.new('ShaderNodeBsdfTransparent'); tr.name = 'ck_bake_transparent'
        nt.links.new(tr.outputs[0], out.inputs['Surface'])
    # metallic off for the albedo bake
    saved_metal = {}
    for m in obj.data.materials:
        b = m.node_tree.nodes.get('Principled BSDF')
        if b is not None:
            saved_metal[m.name] = b.inputs['Metallic'].default_value
            b.inputs['Metallic'].default_value = 0.0

    def target(name, is_float):
        im = bpy.data.images.new(name, size, size, alpha=True, float_buffer=is_float)
        im.colorspace_settings.name = 'Non-Color' if is_float else 'sRGB'
        im.generated_color = (0, 0, 0, 0)
        for m in obj.data.materials:
            nt = m.node_tree
            n = nt.nodes.get('ck_bake_target') or nt.nodes.new('ShaderNodeTexImage')
            n.name = 'ck_bake_target'; n.image = im
            for x in nt.nodes:
                x.select = False
            n.select = True
            nt.nodes.active = n
        return im

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    sc.render.bake.margin = 6
    sc.render.bake.use_selected_to_active = False
    t0 = time.time()
    alb = target('ck_albedo', False)
    sc.cycles.samples = 16
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, uv_layer='UV1', margin=6, use_clear=True)
    print(f'[f16] albedo baked {time.time() - t0:.1f}s', flush=True)
    t0 = time.time()
    lig = target('ck_light', True)
    sc.cycles.samples = samples
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, uv_layer='UV1', margin=6, use_clear=True)
    print(f'[f16] light baked {time.time() - t0:.1f}s', flush=True)
    A = np.empty(size * size * 4, np.float32); alb.pixels.foreach_get(A); A = A.reshape(size, size, 4)
    Lp = np.empty(size * size * 4, np.float32); lig.pixels.foreach_get(Lp); Lp = Lp.reshape(size, size, 4)
    mask = (Lp[..., 3] > 0.5).astype(np.float32)
    l = Lp[..., :3].mean(-1) * mask
    lb = _box_blur(l, 2) / np.maximum(_box_blur(mask, 2), 1e-4)
    ref = float(np.percentile(lb[mask > 0.5], 96))
    f = np.clip(0.26 + 0.86 * np.power(np.clip(lb / ref, 0, 4), 0.72), 0.26, 1.10)
    lin = np.where(A[..., :3] <= 0.04045, A[..., :3] / 12.92, ((A[..., :3] + 0.055) / 1.055) ** 2.4)
    out = lin * f[..., None]
    srgb = np.where(out <= 0.0031308, out * 12.92, 1.055 * np.power(np.clip(out, 0, None), 1 / 2.4) - 0.055)
    srgb = np.clip(srgb, 0, 1)
    fin = bpy.data.images.new('cockpit_atlas', size, size, alpha=False)
    px = np.concatenate([srgb, np.ones((size, size, 1), np.float32)], -1).astype(np.float32)
    fin.pixels.foreach_set(px.ravel())
    path = os.path.join(CK_TEX_OUT, 'cockpit_atlas.jpg')
    fin.filepath_raw = path; fin.file_format = 'JPEG'
    sc.render.image_settings.quality = 90
    try:
        fin.save(filepath=path, quality=92)
    except TypeError:
        fin.save()
    lite = fin.copy(); lite.scale(1024, 1024)
    lpath = os.path.join(CK_TEX_OUT, 'cockpit_atlas_lite.jpg')
    lite.filepath_raw = lpath; lite.file_format = 'JPEG'
    lite.save()
    # debug copies of the passes (bake inputs, not shipped)
    os.makedirs(CK_BUILD, exist_ok=True)
    dbg = bpy.data.images.new('ck_light_dbg', size, size, alpha=False)
    g = np.clip(f / 1.1, 0, 1)
    dbg.pixels.foreach_set(np.stack([g, g, g, np.ones_like(g)], -1).astype(np.float32).ravel())
    dbg.filepath_raw = os.path.join(CK_BUILD, 'ck_light.png'); dbg.file_format = 'PNG'; dbg.save()
    # restore
    for o in hidden:
        o.hide_render = False
    if glass is not None:
        nt = glass.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        if saved_glass is not None:
            nt.links.new(saved_glass, out.inputs['Surface'])
        nt.nodes.remove(nt.nodes['ck_bake_transparent'])
    for m in obj.data.materials:
        b = m.node_tree.nodes.get('Principled BSDF')
        if b is not None and m.name in saved_metal:
            b.inputs['Metallic'].default_value = saved_metal[m.name]
        n = m.node_tree.nodes.get('ck_bake_target')
        if n is not None:
            m.node_tree.nodes.remove(n)
    sc.world = old_world
    print('[f16] cockpit atlas ->', path, os.path.getsize(path) // 1024, 'KB', flush=True)
    return path, lpath


def ck_finalize(obj, atlas_path):
    """One baked material on UV1 (renamed to the only UV map)."""
    im = bpy.data.images.load(atlas_path, check_existing=False)
    m = bpy.data.materials.new('ck_baked')
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Roughness'].default_value = 0.62
    t = m.node_tree.nodes.new('ShaderNodeTexImage'); t.image = im
    m.node_tree.links.new(t.outputs['Color'], b.inputs['Base Color'])
    me = obj.data
    me.materials.clear()
    me.materials.append(m)
    me.polygons.foreach_set('material_index', [0] * len(me.polygons))
    old = me.uv_layers.get('UVMap')
    if old is not None:
        me.uv_layers.remove(old)
    me.uv_layers['UV1'].name = 'UVMap'
    me.uv_layers.active = me.uv_layers['UVMap']
    return m


def ck_make_lite(obj, root, lite_path):
    """interior_lite: copy of the lite-flagged faces of ck_main with a 1024 atlas + the HUD combiner plate."""
    import bmesh
    lite_empty = empty('interior_lite', size=0.2)
    lite_empty.parent = root
    o = obj.copy(); o.data = obj.data.copy()
    o.name = 'interior_lite_mesh'; o.data.name = 'interior_lite_mesh'
    bpy.context.scene.collection.objects.link(o)
    lite = _face_attr(o.data, 'ck_lite')
    bm = bmesh.new(); bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not lite[f.index]], context='FACES')
    bm.to_mesh(o.data); bm.free()
    im = bpy.data.images.load(lite_path, check_existing=False)
    m = bpy.data.materials.new('ck_baked_lite')
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Roughness'].default_value = 0.65
    t = m.node_tree.nodes.new('ShaderNodeTexImage'); t.image = im
    m.node_tree.links.new(t.outputs['Color'], b.inputs['Base Color'])
    o.data.materials.clear(); o.data.materials.append(m)
    o.parent = lite_empty
    o.matrix_parent_inverse.identity()
    for nm in ('ck_art', 'ck_lite'):
        if nm in o.data.attributes:
            o.data.attributes.remove(o.data.attributes[nm])
    hg = bpy.data.objects.get('ck_hud_glass')
    if hg is not None:
        g = hg.copy(); g.data = hg.data.copy(); g.name = 'interior_lite_hudglass'
        bpy.context.scene.collection.objects.link(g)
        g.parent = lite_empty
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    print(f'[f16] interior_lite {n} tris', flush=True)
    return lite_empty


def build_pilot(mats, root):
    import f16_pilot as PL
    importlib.reload(PL)
    groups = PL.build()
    pilot = empty('pilot', size=0.2)
    pilot.parent = root
    helmet = empty('pilot_helmet', size=0.2)
    helmet.parent = pilot
    for gname, parts in groups.items():
        for key, md in parts.items():
            o = mesh_object(md, f'pilot_{gname}_{key}', mats['pl_' + key], recalc=True, auto_angle=60)
            o.parent = helmet if gname == 'helmet' else pilot
    return pilot


def build_lod(path, target=38000):
    """Static LOD for parked copies: gear down, canopy closed & opaque, joined by material, decimated, 1K textures."""
    skip_prefix = ('cockpit_', 'screen_', 'nozzle_cone', 'nozzle_fh', 'intake_duct', 'cockpit', 'pilot', 'ck_', 'interior')
    bpy.context.view_layer.update()
    src = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.hide_render and not o.name.startswith(skip_prefix)]
    # small 1K texture copies for the LOD skin
    skin = bpy.data.materials.get('skin')
    lod_skin = skin.copy(); lod_skin.name = 'skin_lod'
    for n in lod_skin.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image is not None:
            if n.image.colorspace_settings.name == 'Non-Color':
                # drop normal/ORM detail for the LOD
                for l in list(n.outputs[0].links):
                    lod_skin.node_tree.links.remove(l)
                continue
            im = n.image.copy(); im.name = 'skin_color_lod'
            im.scale(1024, 1024)
            im.filepath_raw = os.path.join(ASSETS, 'tex', 'skin_color_lod.jpg')
            im.file_format = 'JPEG'
            im.save()
            n.image = bpy.data.images.load(os.path.join(ASSETS, 'tex', 'skin_color_lod.jpg'))
    glass_lod = principled('canopy_lod', (0.05, 0.045, 0.03), 0.08, metal=0.6)
    glass_lod.node_tree.nodes.get('Principled BSDF').inputs['Specular Tint'].default_value = (1.0, 0.8, 0.45, 1)
    dups = []
    for o in src:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        me.transform(o.matrix_world)
        d = bpy.data.objects.new(o.name + '_lod', me)
        bpy.context.scene.collection.objects.link(d)
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            if m.name == 'skin':
                me.materials[i] = lod_skin
            elif m.name == 'canopy_glass':
                me.materials[i] = glass_lod
        dups.append(d)
    # join everything into one mesh (materials become primitives)
    with bpy.context.temp_override(active_object=dups[0], selected_editable_objects=dups, object=dups[0]):
        bpy.ops.object.join()
    lod = dups[0]
    lod.name = 'f16_lod'
    n0 = sum(len(p.vertices) - 2 for p in lod.data.polygons)
    if n0 > target:
        dm = lod.modifiers.new('dec', 'DECIMATE')
        dm.ratio = target / n0 * 0.97
        try:
            dm.use_collapse_triangulate = True
        except Exception:
            pass
        apply_modifiers(lod)
    n1 = sum(len(p.vertices) - 2 for p in lod.data.polygons)
    lod.data.shade_smooth()
    lod.data.set_sharp_from_angle(angle=math.radians(40))
    root = empty('F16_lod', size=1.0)
    lod.parent = root
    for nm in ('contact_nose', 'contact_main_L', 'contact_main_R'):
        src_e = bpy.data.objects.get(nm)
        if src_e:
            e = empty(nm + '_', loc=src_e.matrix_world.translation, size=0.05)
            e.parent = root
    objs = [root, lod] + [c for c in root.children if c.type == 'EMPTY']
    util.export_glb(path, objects=objs, draco=True)
    print(f'[f16] LOD {n0} -> {n1} tris, exported', path, os.path.getsize(path) // 1024, 'KB')
    for o in objs:
        bpy.data.objects.remove(o)


def bake_ao(size=2048, samples=96, gpu=False):
    """Bake ambient occlusion of the exterior (gear legs/wheels hidden) into tex/skin_ao.png.
    CPU by default: the shared Metal device is often saturated by other agents' renders."""
    sc = bpy.context.scene
    util.setup_cycles(samples=samples, width=256, height=256, gpu=gpu)
    if not gpu:
        sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    skin = bpy.data.materials.get('skin')
    img = bpy.data.images.new('skin_ao_bake', size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    nt = skin.node_tree
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img
    for n in nt.nodes:
        n.select = False
    tn.select = True
    nt.nodes.active = tn
    hide = [o for o in sc.objects if o.type == 'MESH' and o.name.startswith(('gear_main', 'gear_nose', 'wheel_', 'pilot'))]
    for o in hide:
        o.hide_render = True
    targets = [o for o in sc.objects if o.type == 'MESH' and not o.hide_render and any(m is skin for m in o.data.materials)]
    bpy.ops.object.select_all(action='DESELECT')
    for o in targets:
        o.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    sc.render.bake.margin = 12
    sc.render.bake.use_selected_to_active = False
    t0 = time.time()
    bpy.ops.object.bake(type='AO')
    out = os.path.join(ASSETS, 'tex', 'skin_ao.png')
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    print(f'[f16] AO baked in {time.time() - t0:.1f}s ->', out)
    nt.nodes.remove(tn)
    for o in hide:
        o.hide_render = False


ANIMATED_PREFIX = ('ctl_', 'speedbrake_', 'canopy', 'gear_', 'wheel_', 'nozzle_petal', 'screen_', 'cockpit_')


def merge_static(root):
    """Join non-animated exterior meshes that are direct children of the root, grouped by material set."""
    groups = {}
    for o in list(root.children):
        if o.type != 'MESH' or o.name.startswith(ANIMATED_PREFIX):
            continue
        key = tuple(m.name if m else '' for m in o.data.materials)
        groups.setdefault(key, []).append(o)
    n = 0
    for key, objs in groups.items():
        if len(objs) < 2:
            continue
        with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, object=objs[0]):
            bpy.ops.object.join()
        objs[0].name = 'static_' + (key[0] if key else 'mesh')
        n += len(objs) - 1
    print(f'[f16] merged {n} static meshes', flush=True)


def _under(ob, name):
    p = ob
    while p is not None:
        if p.name == name:
            return True
        p = p.parent
    return False


def export(root, path):
    merge_static(root)
    objs = [o for o in bpy.context.scene.objects if o.type in ('MESH', 'EMPTY') and not o.hide_render and not _under(o, 'interior')]
    util.export_glb(path, objects=objs, draco=True)
    print('[f16] exported', path, os.path.getsize(path) // 1024, 'KB', flush=True)


def export_cockpit(interior, path):
    objs = [o for o in bpy.context.scene.objects if o.type in ('MESH', 'EMPTY') and _under(o, 'interior')]
    util.export_glb(path, objects=objs, draco=True)
    tris = sum(tri_count(o) for o in objs if o.type == 'MESH')
    print(f'[f16] exported cockpit {path} {os.path.getsize(path) // 1024} KB, {tris} tris', flush=True)


def main():
    o = args()
    util.reset_scene()
    mats = make_materials()
    t0 = time.time()
    parts = build_exterior(mats)
    root, out = assemble(parts, mats)
    build_canopy_mirrors(mats)
    interior, iobjs = build_interior(mats, root)
    build_pilot(mats, root)
    meshes = [ob for ob in bpy.context.scene.objects if ob.type == 'MESH']
    t_int = sum(tri_count(ob) for ob in meshes if _under(ob, 'interior'))
    t_ext = sum(tri_count(ob) for ob in meshes if not _under(ob, 'interior'))
    print(f'[f16] built in {time.time() - t0:.1f}s; tris exterior {t_ext}, interior {t_int}', flush=True)
    if o.get('bake'):
        bake_ao(samples=64, gpu=bool(o.get('gpu')))
    out_dir = o.get('glbdir') or ASSETS
    global CK_TEX_OUT
    if o.get('glbdir'):
        CK_TEX_OUT = o['glbdir']
        os.makedirs(CK_TEX_OUT, exist_ok=True)
    if o['export'] or o.get('ckbake'):
        ck = ck_join(interior)
        ck_uv1(ck)
        atlas, lite_path = ck_bake(ck, size=int(o.get('set', {}).get('cksize', 4096)), samples=int(o.get('set', {}).get('cksamples', 128)))
        ck_finalize(ck, atlas)
        ck_make_lite(ck, root, lite_path)
    if o['export']:
        export(root, os.path.join(out_dir, 'f16.glb'))
        export_cockpit(interior, os.path.join(out_dir, 'f16_cockpit.glb'))
    if o['lod']:
        build_lod(os.path.join(out_dir, 'f16_lod.glb'))
    if o['preview']:
        preview(o['preview'])
    if o['renders']:
        import f16_render
        importlib.reload(f16_render)
        f16_render.PCT = o.get('pct', 100)
        f16_render.USE_CPU = bool(o.get('cpu'))
        f16_render.RES = o.get('res')
        for kk, vv in o.get('set', {}).items():
            setattr(f16_render, kk, vv)
        f16_render.render_all(o.get('outdir') or RENDERS, o['shots'], samples=o['samples'], fast=o['fast'])


if __name__ == '__main__':
    main()
