"""Doors, windows and windshield cut out of the solidified fuselage skin (exact booleans), plus glass panels."""
import math
import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix
from lib import new_mesh_obj, boolean, duplicate, add_modifier_apply, join

SKIN_T = 0.03   # skin thickness (solidify inward)


def rounded_poly(pts, r, segs=5):
    """Fillet every corner of a closed 2D polygon with radius r (or a list of radii)."""
    pts = [np.asarray(p, float) for p in pts]
    n = len(pts)
    rs = r if isinstance(r, (list, tuple)) else [r] * n
    out = []
    for i in range(n):
        P, A, B = pts[i], pts[i - 1], pts[(i + 1) % n]
        d1 = (A - P) / np.linalg.norm(A - P)
        d2 = (B - P) / np.linalg.norm(B - P)
        cosang = float(np.clip(np.dot(d1, d2), -1, 1))
        ang = math.acos(cosang)
        if rs[i] <= 0 or ang > math.radians(178):
            out.append(P)
            continue
        t = rs[i] / math.tan(ang / 2)
        t = min(t, 0.45 * np.linalg.norm(A - P), 0.45 * np.linalg.norm(B - P))
        rr = t * math.tan(ang / 2)
        p1, p2 = P + d1 * t, P + d2 * t
        bis = (d1 + d2) / np.linalg.norm(d1 + d2)
        c = P + bis * (rr / math.sin(ang / 2))
        a1 = math.atan2(*(p1 - c)[::-1])
        a2 = math.atan2(*(p2 - c)[::-1])
        da = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
        for k in range(segs + 1):
            a = a1 + da * k / segs
            out.append(c + rr * np.array([math.cos(a), math.sin(a)]))
    return out


def prism(name, poly2d, to3d, t0, t1, mat=None):
    """Closed prism: to3d(a, b, t) -> xyz. poly2d is a closed 2D polygon (counter-clockwise or not)."""
    n = len(poly2d)
    verts = [to3d(a, b, t0) for a, b in poly2d] + [to3d(a, b, t1) for a, b in poly2d]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        i1 = (i + 1) % n
        faces.append((i, i1, n + i1, n + i))
    ob = new_mesh_obj(name, verts, faces, None, smooth=False)
    # cutter faces land in material slot 2 ('rim') of whatever they cut (boolean INDEX material mode)
    for _ in range(3):
        ob.data.materials.append(None)
    for p in ob.data.polygons:
        p.material_index = 2
    return ob


def side_prism(name, poly, side, mat=None, x0=0.25, x1=2.2):
    """Prism through the right (side=+1) or left (-1) skin; poly in (y, z)."""
    return prism(name, poly, lambda a, b, t: (side * t, a, b), x0, x1, mat)


# windshield plane: base centre B, slope direction D (up/aft), normal N (forward/up)
WS_B = np.array([0.0, 3.71, 1.715])
WS_D = np.array([0.0, -1.14, 0.52]) / math.hypot(1.14, 0.52)
WS_N = np.array([0.0, 0.52, 1.14]) / math.hypot(1.14, 0.52)


def ws_prism(name, poly, mat=None):
    def to3d(a, b, t):
        p = WS_B + np.array([a, 0, 0]) + WS_D * b + WS_N * t
        return tuple(p)
    return prism(name, poly, to3d, -0.45, 0.45, mat)


# ---------------------------------------------------------------------------------------------- outlines (G frame)
CREW_DOOR = rounded_poly([(3.53, 0.92), (2.56, 0.92), (2.56, 2.02), (2.86, 2.05), (3.56, 1.70), (3.60, 1.28)], 0.07)
CREW_WIN = rounded_poly([(3.42, 1.27), (2.63, 1.27), (2.63, 1.96), (2.88, 1.98), (3.48, 1.66), (3.52, 1.42)], 0.08)
GUNNER_WIN = rounded_poly([(2.33, 1.30), (1.84, 1.30), (1.84, 1.90), (2.33, 1.90)], 0.09)
CABIN_DOOR = rounded_poly([(1.40, 0.58), (-0.86, 0.58), (-0.86, 1.975), (1.40, 1.975)], 0.06)
CABIN_OPEN = rounded_poly([(1.32, 0.62), (-0.78, 0.62), (-0.78, 1.93), (1.32, 1.93)], 0.05)
CABIN_WIN_A = rounded_poly([(1.26, 1.30), (0.16, 1.30), (0.16, 1.86), (1.26, 1.86)], 0.09)
CABIN_WIN_B = rounded_poly([(-0.04, 1.30), (-0.74, 1.30), (-0.74, 1.86), (-0.04, 1.86)], 0.09)
CHIN_WIN = rounded_poly([(4.30, 0.96), (4.08, 0.70), (3.66, 0.66), (3.62, 1.14), (4.10, 1.20)], [0.12, 0.14, 0.08, 0.08, 0.14])
# windshield pane (right half) in (x, s) plane coordinates
WS_PANE = rounded_poly([(0.055, 0.04), (0.87, 0.04), (0.79, 1.12), (0.055, 1.19)], [0.03, 0.08, 0.08, 0.03])


def solidify_skin(ob, thickness=SKIN_T):
    add_modifier_apply(ob, 'SOLIDIFY', thickness=thickness, offset=-1.0, material_offset=1, material_offset_rim=2,
                       use_even_offset=True, use_quality_normals=True)
    return ob


def outer_only(ob, keep_index=0):
    """Delete all faces not using material index keep_index (i.e. keep the outer skin surface)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    dead = [f for f in bm.faces if f.material_index != keep_index]
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def fix_slots(ob, n):
    """Boolean cutter faces may land in extra (empty) slots: move them to slot n-1 ('rim') and drop extra slots."""
    me = ob.data
    for p in me.polygons:
        if p.material_index >= n:
            p.material_index = n - 1
    while len(me.materials) > n:
        me.materials.pop(index=len(me.materials) - 1)


def offset_along_normals(ob, d):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * d
    bm.to_mesh(ob.data)
    bm.free()


def cut_openings(fuse, M):
    """fuse: closed fuselage skin with material slots [hull, int_wall, rim]. Returns dict of new objects."""
    solidify_skin(fuse)
    src = duplicate(fuse, '_fuse_src')   # uncut solid skin for door panels / glass
    out = {'doors': {}, 'glass': []}
    cutters = []
    # --- door panels (intersections), cut before the fuselage openings
    for side, sname in ((1, 'R'), (-1, 'L')):
        # crew doors: pilot sits right
        dn = 'door_pilot' if side > 0 else 'door_copilot'
        d = duplicate(src, dn)
        boolean(d, side_prism('_c', CREW_DOOR, side), 'INTERSECT', keep_cutter=False)
        w = side_prism('_w', CREW_WIN, side)
        boolean(d, w, 'DIFFERENCE')
        g = duplicate(src, f'glass_{dn}')
        boolean(g, w, 'INTERSECT', keep_cutter=False)
        outer_only(g)
        offset_along_normals(g, -0.012)
        out['doors'][dn] = d
        out['glass'].append((g, d))
        # cabin sliding doors
        cn = f'door_cabin_{sname}'
        d = duplicate(src, cn)
        boolean(d, side_prism('_c', CABIN_DOOR, side), 'INTERSECT', keep_cutter=False)
        for k, poly in enumerate((CABIN_WIN_A, CABIN_WIN_B)):
            w = side_prism('_w', poly, side)
            boolean(d, w, 'DIFFERENCE')
            g = duplicate(src, f'glass_{cn}_{k}')
            boolean(g, w, 'INTERSECT', keep_cutter=False)
            outer_only(g)
            offset_along_normals(g, -0.012)
            g.data.transform(Matrix.Translation((side * 0.024, 0, 0)))
            out['glass'].append((g, d))
        # door stands proud of the skin (external rails)
        d.data.transform(Matrix.Translation((side * 0.024, 0, 0)))
        out['doors'][cn] = d
        # fixed windows in the fuselage
        for poly, gname in ((GUNNER_WIN, f'glass_gunner_{sname}'), (CHIN_WIN, f'glass_chin_{sname}')):
            w = side_prism('_w', poly, side)
            g = duplicate(src, gname)
            boolean(g, w, 'INTERSECT')
            outer_only(g)
            offset_along_normals(g, -0.012)
            out['glass'].append((g, None))
            cutters.append(w)
        cutters.append(side_prism('_c', CREW_DOOR, side))
        cutters.append(side_prism('_c', CABIN_OPEN, side))
    # windshield panes
    for s, nm in ((1, 'R'), (-1, 'L')):
        poly = [(s * a, b) for a, b in WS_PANE]
        if s < 0:
            poly = poly[::-1]
        w = ws_prism('_ws', poly)
        g = duplicate(src, f'glass_windshield_{nm}')
        boolean(g, w, 'INTERSECT')
        outer_only(g)
        offset_along_normals(g, -0.012)
        out['glass'].append((g, None))
        cutters.append(w)
    # cut all openings from the fuselage in one union
    for c in cutters:
        boolean(fuse, c, 'DIFFERENCE', keep_cutter=False)
    for o in [fuse] + list(out['doors'].values()):
        fix_slots(o, 3)
    bpy.data.objects.remove(src, do_unlink=True)
    for g, _ in out['glass']:
        g.data.materials.clear()
        g.data.materials.append(M['glass'])
    return out
