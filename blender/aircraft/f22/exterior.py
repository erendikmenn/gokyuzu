"""Assemble the F-22 exterior objects (geometry only; materials are replaced by the skin pipeline later)."""
import bpy
import bmesh

import geom as G
import oml as O


def mat(name, color, metallic=0.0, roughness=0.5, alpha=None, emission=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    m.diffuse_color = (*color, 1)
    m.metallic, m.roughness = metallic, roughness
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


def base_materials():
    return {
        'skin': mat('f22_skin', (0.30, 0.315, 0.33), 0.2, 0.5),
        'dark': mat('f22_dark', (0.02, 0.02, 0.022), 0.0, 0.7),
        'hot': mat('f22_nozzle', (0.20, 0.18, 0.165), 0.7, 0.45),
        'bay': mat('f22_bay', (0.62, 0.63, 0.62), 0.0, 0.6),
        'duct': mat('f22_duct', (0.035, 0.037, 0.04), 0.0, 0.75),
    }


def build(preview=False):
    import fuselage as F
    import surfaces as SF
    import aft as A
    M = base_materials()
    M['glow'] = mat('f22_ab_glow', (0.05, 0.03, 0.02), 0.0, 0.6, emission=(1.0, 0.45, 0.15, 0.0))
    mats = [M['skin'], M['dark'], M['hot'], M['bay'], M['duct'], M['glow']]
    objs = {}
    bm, st = F.build_fuselage()
    for sign in (1, -1):
        w = SF.build_wing(sign, [M['skin']])
        G.join_bm(bm, w['fixed'])
        for k in ('lef', 'flaperon', 'aileron'):
            objs[w[k].name] = w[k]
        fixed, rud = SF.build_fin(sign, [M['skin']])
        G.join_bm(bm, fixed)
        objs[rud.name] = rud
        stab = SF.build_stab(sign, [M['skin']])
        objs[stab.name] = stab
    G.join_bm(bm, A.build_booms())
    G.join_bm(bm, A.build_stinger())
    for sign in (1, -1):
        G.join_bm(bm, A.build_nozzle_static(sign))
    bulk = A.build_bulkhead()
    glow = bmesh.new()
    G.join_bm(glow, bulk)
    bmesh.ops.delete(glow, geom=[f for f in glow.faces if f.material_index != A.M_GLOW], context='FACES')
    bmesh.ops.delete(bulk, geom=[f for f in bulk.faces if f.material_index == A.M_GLOW], context='FACES')
    G.join_bm(bm, bulk)
    G.weld(bm, 1e-5)
    bm.normal_update()
    # ---------------- landing gear, bays and doors
    import gear as GR
    M['gear'] = mat('f22_gear', (0.78, 0.79, 0.78), 0.05, 0.42)
    M['tire'] = mat('f22_tire', (0.035, 0.035, 0.035), 0.0, 0.85)
    M['hub'] = mat('f22_hub', (0.62, 0.63, 0.63), 0.5, 0.35)
    M['chrome'] = mat('f22_chrome', (0.85, 0.86, 0.88), 1.0, 0.12)
    M['lens'] = mat('f22_lens', (0.8, 0.82, 0.85), 0.0, 0.05, emission=(1.0, 0.97, 0.9, 0.0))
    door_objs, bay = GR.cut_doors(bm, [M['skin'], M['bay']])
    for ob in door_objs:
        objs[ob.name] = ob
    for f in bay.faces:
        f.material_index = A.M_BAY
    G.join_bm(bm, bay)
    gmats = [M['gear'], M['tire'], M['hub'], M['skin'], M['chrome'], M['lens'], M['bay']]
    gobjs = GR.build_gear(gmats)
    objs.update(gobjs)
    G.set_parent(gobjs['gear_nose_steer'], gobjs['gear_nose'])
    for w, g in (('wheel_nose', 'gear_nose_steer'), ('wheel_main_L', 'gear_main_L'), ('wheel_main_R', 'gear_main_R')):
        G.set_parent(gobjs[w], gobjs[g])
    G.smooth_sharp(bm, 32)
    objs['airframe'] = G.new_object('airframe', bm, mats)
    # afterburner glow faces: one object per engine (engine 1 = left)
    for idx, sgn in ((1, -1), (2, 1)):
        gb = bmesh.new()
        G.join_bm(gb, glow)
        bmesh.ops.delete(gb, geom=[f for f in gb.faces if (f.calc_center_median().x > 0) != (sgn > 0)], context='FACES')
        for f in gb.faces:
            f.material_index = 0
        objs[f'ab_glow_{idx}'] = G.new_object(f'ab_glow_{idx}', gb, [M['glow']])
    for idx, sgn in ((1, -1), (2, 1)):
        for up in (True, False):
            fb = A.build_flap(sgn, up)
            name = f'nozzle_flap_{"upper" if up else "lower"}_{idx}'
            zh = (A.Z_HINGE_U + 0.05) if up else (A.Z_HINGE_L - 0.06)
            sh = A.S_HINGE_U if up else A.S_HINGE_L
            from geom import Y
            objs[name] = G.pivot_object(name, fb, (sgn * A.NOZ_XC, Y(sh), zh), (1, 0, 0), (0, 0, 1),
                                        materials=[M['skin'], M['dark'], M['hot']])
    import canopy as CN
    from geom import Y
    M['glass'] = mat('f22_canopy', (0.55, 0.42, 0.18), 0.6, 0.05, alpha=0.35)
    M['frame'] = mat('f22_canopy_frame', (0.09, 0.095, 0.1), 0.2, 0.5)
    cb = CN.build_canopy()
    G.smooth_sharp(cb, 50)
    objs['canopy'] = G.pivot_object('canopy', cb, (0, Y(CN.HINGE_S), O.can_zs(O.S_CAN1) - 0.06), (1, 0, 0), (0, 0, 1),
                                    materials=[M['glass'], M['frame']])
    tub = CN.build_tub()
    objs['cockpit_tub'] = G.new_object('cockpit_tub', tub, [M['dark']])
    db = F.build_ducts(st)
    G.smooth_sharp(db, 40)
    objs['ducts'] = G.new_object('ducts', db, mats)
    for ob in objs.values():
        if ob.type == 'MESH' and ob.name.startswith(('ctl_', 'nozzle_')):
            b2 = bmesh.new()
            b2.from_mesh(ob.data)
            G.smooth_sharp(b2, 32)
            b2.to_mesh(ob.data)
            b2.free()
    return objs
