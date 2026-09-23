"""Assemble the F-16: control-surface cuts, pivots, gear, wells, doors, empties (bpy)."""
import math
import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix, Quaternion
from f16_geom import CG_S, CG_Z, bl, to_blender, MeshData
from f16_bpy import (mesh_object, empty, boolean, copy_object, set_origin_basis, parent_keep, apply_modifiers,
                     principled, tri_count)
import f16_parts as PT
import f16_gear as GR
import f16_fuselage as FU


def B(p):
    return Vector(bl(p))


def dvec(v):
    """drawing-frame direction -> Blender direction"""
    return Vector((v[1], -v[0], v[2]))


def delete_faces_with_material(obj, mat_name):
    me = obj.data
    idx = [i for i, m in enumerate(me.materials) if m is not None and m.name.startswith(mat_name)]
    if not idx:
        return
    bm = bmesh.new(); bm.from_mesh(me)
    kill = [f for f in bm.faces if f.material_index in idx]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me); bm.free()
    # drop the material slot(s)
    for i in sorted(idx, reverse=True):
        me.materials.pop(index=i)


def resharp(obj, angle=40):
    me = obj.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(angle))


def cutter_obj(md, name, mat):
    o = mesh_object(md, name, mat, smooth=False, recalc=True)
    return o


def make_control(parent, cutter_md, name, pivot_d, axis_b, z_hint, mats, extras=None, gap=0.0):
    """Split `parent` with a hinge cutter; return the moving part with origin on the hinge, local X = axis_b."""
    cut = cutter_obj(cutter_md, name + '_cutter', mats['cutter'])
    ctl = copy_object(parent, name)
    boolean(ctl, cut, 'INTERSECT', keep_cutter=True)
    boolean(parent, cut, 'DIFFERENCE', keep_cutter=False)
    for o in (ctl, parent):
        # cutter faces become the cove / nose surfaces: keep them but give them the skin material
        me = o.data
        ci = [i for i, m in enumerate(me.materials) if m and m.name.startswith('cutter')]
        if ci:
            skin_i = 0
            for p in me.polygons:
                if p.material_index in ci:
                    p.material_index = skin_i
            for i in sorted(ci, reverse=True):
                me.materials.pop(index=i)
        resharp(o, 35)
    set_origin_basis(ctl, B(pivot_d), axis_b, z_hint)
    if extras:
        for k, v in extras.items():
            ctl[k] = v
    return ctl


def polygon_prism(poly_sy, z0, z1, name, mat, s_is_x=False):
    """Prism from a top-view polygon [(s, y)] in drawing frame, extruded from z0 to z1."""
    n = len(poly_sy)
    verts = [bl((s, y, z0)) for s, y in poly_sy] + [bl((s, y, z1)) for s, y in poly_sy]
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))] + [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    return cutter_obj(MeshData(np.array(verts), faces, None, name), name, mat)


def side_prism(poly_sz, y0, y1, name, mat):
    n = len(poly_sz)
    verts = [bl((s, y0, z)) for s, z in poly_sz] + [bl((s, y1, z)) for s, z in poly_sz]
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))] + [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    return cutter_obj(MeshData(np.array(verts), faces, None, name), name, mat)


def front_prism(poly_yz, s0, s1, name, mat):
    n = len(poly_yz)
    verts = [bl((s0, y, z)) for y, z in poly_yz] + [bl((s1, y, z)) for y, z in poly_yz]
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))] + [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    return cutter_obj(MeshData(np.array(verts), faces, None, name), name, mat)


# ----------------------------------------------------------------------------------------------------------------------
def cut_fuselage(fus, mats, coll=None):
    """Cockpit opening, intake mouth, gear wells + doors. Returns dict of door objects."""
    out = {}
    # --- intake mouth: remove the flat front face inside the mouth outline
    mouth = PT.intake_cutter_poly()
    c = front_prism([tuple(p) for p in mouth], 4.45, 4.63, 'mouth_cut', mats['cutter'])
    boolean(fus, c, 'DIFFERENCE')
    delete_faces_with_material(fus, 'cutter')
    # --- gear doors (skin patches) and wells
    wells = {
        'nose': GR.NOSE_WELL,
        'main_R': GR.MAIN_WELL_R,
        'main_L': [(s, -y) for s, y in GR.MAIN_WELL_R][::-1],
    }
    for key, poly in wells.items():
        zlo, zhi = (0.80, 1.29) if key == 'nose' else (0.80, 1.62)
        cut = polygon_prism(poly, zlo, zhi, 'well_' + key, mats['cutter'])
        door = copy_object(fus, 'door_' + key)
        boolean(door, cut, 'INTERSECT', keep_cutter=True)
        delete_faces_with_material(door, 'cutter')
        # well cavity: the cutter faces inside the fuselage become the well walls
        cut.data.materials.clear(); cut.data.materials.append(mats['well'])
        boolean(fus, cut, 'DIFFERENCE')
        out[key] = door
    # --- cockpit opening under the transparency
    S = np.linspace(2.93, 5.12, 40)
    right = [(s, max(PT.glass_edge_w(s) - 0.02, 0.02)) for s in S]
    poly = right + [(s, -y) for s, y in right[::-1]]
    c = polygon_prism(poly, 1.88, 3.3, 'cockpit_cut', mats['cockpit_wall'])
    boolean(fus, c, 'DIFFERENCE')
    resharp(fus, 50)
    return out


def split_doors(door_obj, poly, mats, kind):
    """Split a well door patch along s (nose: left/right halves; main: one door) and add thickness."""
    return door_obj


def solidify(obj, thick=0.012, mat_offset=1, inner_mat=None):
    if inner_mat is not None:
        obj.data.materials.append(inner_mat)
    m = obj.modifiers.new('solid', 'SOLIDIFY')
    m.thickness = thick
    m.offset = -1
    m.use_rim = True
    m.material_offset = mat_offset if inner_mat is not None else 0
    m.material_offset_rim = mat_offset if inner_mat is not None else 0
    apply_modifiers(obj)
    resharp(obj, 40)
    return obj


def bisect_keep(obj, plane_co, plane_no, keep_positive=True):
    bm = bmesh.new(); bm.from_mesh(obj.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=plane_co, plane_no=plane_no,
                                 clear_outer=not keep_positive, clear_inner=keep_positive)
    bm.to_mesh(obj.data); bm.free()
    return obj


# ----------------------------------------------------------------------------------------------------------------------
def rot_between(a, b):
    a = Vector(a).normalized(); b = Vector(b).normalized()
    return a.rotation_difference(b)


def build_gear(mats, root):
    """Gear legs with pivots and retraction data. Returns dict of objects."""
    objs = {}
    # ---------------- main gear
    for side in ('R', 'L'):
        sg = 1 if side == 'R' else -1
        g = GR.main_leg(side)
        # merge leg parts by material
        leg_md = {}
        for kind, md in g['parts']:
            leg_md.setdefault(kind, MeshData(np.zeros((0, 3)), [], None, kind)).add(md)
        mat_order = ['strut', 'piston', 'dark']
        combo = MeshData(np.zeros((0, 3)), [], None, 'leg')
        mi = []
        for k, kind in enumerate(mat_order):
            if kind in leg_md:
                n0 = len(combo.faces)
                combo.add(leg_md[kind])
                mi += [k] * (len(combo.faces) - n0)
        combo.mat_index = mi
        leg = mesh_object(combo, f'gear_main_{side}', [mats['strut'], mats['piston'], mats['dark']], recalc=True, auto_angle=40)
        brace = None
        if 'brace' in leg_md:
            brace = mesh_object(leg_md['brace'], f'gear_brace_{side}', mats['strut'], recalc=True, auto_angle=40)
        T, A, W = g['T'], g['A'], g['W']
        # retraction about the solved axis through the trunnion (mirrored for the left side)
        ax_r = Vector(GR.MAIN_RETRACT_AXIS_R)
        axis = ax_r if side == 'R' else Vector((ax_r.x, -ax_r.y, -ax_r.z))
        ang = GR.MAIN_RETRACT_ANGLE
        set_origin_basis(leg, Vector(T), axis, (0, 1, 0) if abs(axis.y) < 0.9 else (0, 0, 1))
        leg['retract_angle'] = float(ang)
        leg.parent = root
        if brace is not None:
            parent_keep(brace, leg)
        # twist node at the lower leg (wheel rotates 90 deg about the leg axis to lie flat)
        tw = empty(f'gear_main_{side}_twist', loc=(0, 0, 0), size=0.1)
        tw.matrix_world = Matrix.Translation(Vector(A))
        # local X of the twist = leg axis
        ld = Vector(g['leg'])
        set_origin_basis_empty(tw, Vector(A), ld)
        parent_keep(tw, leg)
        # wheel
        Wc, tire, hub = GR.main_wheel(side)
        tire.add(hub)
        nt = len(tire.faces) - len(hub.faces)
        tire.mat_index = [0] * nt + [1] * len(hub.faces)
        wheel = mesh_object(tire, f'wheel_main_{side}', [mats['tire'], mats['hub']], recalc=True, auto_angle=35)
        set_origin_basis(wheel, Vector(Wc), (1, 0, 0), (0, 0, 1))
        parent_keep(wheel, tw)
        tw['twist_angle'] = float(GR.MAIN_TWIST_R if side == 'R' else -GR.MAIN_TWIST_R)
        objs[f'gear_main_{side}'] = leg
        objs[f'wheel_main_{side}'] = wheel
        objs[f'twist_{side}'] = tw
    # ---------------- nose gear
    g = GR.nose_leg()
    leg_md = {}
    for kind, md in g['parts']:
        leg_md.setdefault(kind, MeshData(np.zeros((0, 3)), [], None, kind)).add(md)
    combo = MeshData(np.zeros((0, 3)), [], None, 'nleg'); mi = []
    order = ['strut', 'piston', 'lens']
    for k, kind in enumerate(order):
        if kind in leg_md:
            n0 = len(combo.faces); combo.add(leg_md[kind]); mi += [k] * (len(combo.faces) - n0)
    combo.mat_index = mi
    nleg = mesh_object(combo, 'gear_nose', [mats['strut'], mats['piston'], mats['lens']], recalc=True, auto_angle=40)
    T = Vector(g['T'])
    set_origin_basis(nleg, T, Vector(GR.NOSE_RETRACT_AXIS), (0, 0, 1))
    nleg['retract_angle'] = float(GR.NOSE_RETRACT_ANGLE)
    nleg.parent = root
    A = Vector(g['A'])
    ntw = empty('gear_nose_twist', size=0.1)
    ld = (Vector(g['fork_top']) - T).normalized()
    set_origin_basis_empty(ntw, Vector(g['fork_top']), ld)
    parent_keep(ntw, nleg)
    ntw['twist_angle'] = float(GR.NOSE_TWIST)
    Ac, tire, hub = GR.nose_wheel()
    tire.add(hub)
    tire.mat_index = [0] * (len(tire.faces) - len(hub.faces)) + [1] * len(hub.faces)
    nwheel = mesh_object(tire, 'wheel_nose', [mats['tire'], mats['hub']], recalc=True, auto_angle=35)
    set_origin_basis(nwheel, Vector(Ac), (1, 0, 0), (0, 0, 1))
    parent_keep(nwheel, ntw)
    # landing / taxi lights (empties pointing forward = +Y blender -> -Z three)
    for nm, p in (('light_landing', g['lights'][0]), ('light_taxi', g['lights'][1])):
        e = empty(nm, loc=tuple(p), size=0.05)
        parent_keep(e, nleg)
    objs['gear_nose'] = nleg
    objs['wheel_nose'] = nwheel
    return objs


def set_origin_basis_empty(obj, origin, x_axis, z_hint=(0, 0, 1)):
    x = Vector(x_axis).normalized()
    zh = Vector(z_hint)
    if abs(x.dot(zh.normalized())) > 0.95:
        zh = Vector((0, 1, 0))
    y = zh.cross(x).normalized()
    z = x.cross(y).normalized()
    R = Matrix((x, y, z)).transposed()
    obj.matrix_world = Matrix.Translation(Vector(origin)) @ R.to_4x4()
    return obj
