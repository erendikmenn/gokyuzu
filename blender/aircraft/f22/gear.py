"""F-22A landing gear: nose gear (forward retracting, landing/taxi lights), main gear (strut leaning inboard, wheel
on an outboard stub), wheels, bays cut into the skin, sawtooth-edged doors.

Refs: ref/gear_main_150126.jpg (main gear + hanging main door), ref/front_ground_japan.jpg, ref/q34_low_220606.jpg.
Gear paint is white (legs, bay interiors, door insides) - see the references.
"""
import math
import numpy as np
import bmesh
from mathutils import Vector

import geom as G
from geom import Y, lerp
import oml as O

ZG = O.Z_GROUND
NOSE_TRUN = (0.0, 5.40, -0.84)
NOSE_AXLE = (0.0, 5.56, ZG + 0.292)
NOSE_R, NOSE_W = 0.300, 0.19
MAIN_TRUN = (1.30, 11.12, -0.96)
MAIN_KNEE = (1.37, 11.47, -1.60)
MAIN_AXLE = (1.68, 11.50, ZG + 0.455)
MAIN_R, MAIN_W = 0.470, 0.29

M_GEAR, M_TIRE, M_HUB, M_DOOR, M_CHROME, M_LENS, M_BAY = 0, 1, 2, 3, 4, 5, 6


def V3(x, s, z):
    return Vector((x, Y(s), z))


def tire_bm(center, axis, R, W, mat_tire=M_TIRE, mat_hub=M_HUB, seg=40):
    """Tyre (revolved profile, tread grooves) + hub with bolts, around axis through center."""
    bm = bmesh.new()
    prof = []
    n = 14
    for k in range(n + 1):
        a = -math.pi / 2 + math.pi * k / n
        r = R - (R * 0.13) * (1 - math.cos(a)) ** 1.6
        if abs(math.sin(a)) < 0.45 and k % 3 == 1:
            r -= 0.006
        prof.append((r, W / 2 * math.sin(a)))
    prof = [(0.60 * R, -W * 0.43)] + prof + [(0.60 * R, W * 0.43)]
    G.bm_revolve(bm, prof, center, axis, seg=seg, mat=mat_tire)
    hub = [(0.0, -W * 0.30), (0.16 * R, -W * 0.31), (0.2 * R, -W * 0.36), (0.42 * R, -W * 0.37), (0.5 * R, -W * 0.42),
           (0.61 * R, -W * 0.43), (0.61 * R, W * 0.43), (0.5 * R, W * 0.42), (0.42 * R, W * 0.37), (0.2 * R, W * 0.36),
           (0.16 * R, W * 0.31), (0.0, W * 0.30)]
    G.bm_revolve(bm, hub, center, axis, seg=28, mat=mat_hub)
    ax = Vector(axis).normalized()
    c = Vector(center)
    ref = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
    u = ax.cross(ref).normalized()
    w = ax.cross(u).normalized()
    for side in (-1, 1):
        for k in range(8):
            a = 2 * math.pi * k / 8
            p0 = c + (u * math.cos(a) + w * math.sin(a)) * 0.3 * R + ax * side * W * 0.36
            G.bm_cylinder(bm, p0, p0 + ax * side * 0.012, 0.011, seg=6, mat=mat_hub)
        # wheel "spokes" pockets (dark ring)
        G.bm_cylinder(bm, c + ax * side * W * 0.37, c + ax * side * W * 0.372, 0.47 * R, 0.47 * R, seg=24, cap0=False,
                      mat=mat_hub)
    G.weld(bm, 1e-6)
    for f in bm.faces:
        f.normal_update()
        cc = f.calc_center_median()
        rel = cc - c
        radial = rel - ax * rel.dot(ax)
        r = radial.normalized() * 0.3 + ax * math.copysign(1, rel.dot(ax) or 1) * (0.7 if f.material_index == mat_hub else 0.2)
        if f.normal.dot(r) < 0:
            f.normal_flip()
    G.smooth_sharp(bm, 40)
    return bm


def _tube(bm, pts, r, mat=M_GEAR, seg=8):
    for a, b in zip(pts[:-1], pts[1:]):
        G.bm_cylinder(bm, Vector(a), Vector(b), r, seg=seg, mat=mat)


def build_gear(mats):
    """Returns dict of objects: gear_nose, gear_nose_steer, wheel_nose, gear_main_L/R, wheel_main_L/R."""
    objs = {}
    # ---------------------------------------------------------------- nose gear
    t = V3(*NOSE_TRUN)
    a = V3(*NOSE_AXLE)
    d = (a - t).normalized()
    up = -d
    fwd = Vector((0, 1, 0))
    leg = bmesh.new()
    G.bm_cylinder(leg, t - Vector((0.17, 0, 0)), t + Vector((0.17, 0, 0)), 0.055, seg=14, mat=M_GEAR)
    L = (a - t).length
    G.bm_cylinder(leg, t + d * 0.02, t + d * 0.56, 0.078, 0.072, seg=20, mat=M_GEAR)       # outer cylinder
    G.bm_cylinder(leg, t + d * 0.16, t + d * 0.24, 0.098, seg=20, mat=M_GEAR)              # steering collar
    G.bm_box(leg, t + d * 0.20 + fwd * 0.10, (0.07, 0.10, 0.06), mat=M_GEAR)               # steering actuator
    G.bm_cylinder(leg, t + d * 0.54, t + d * 0.59, 0.085, seg=20, mat=M_GEAR)              # gland nut
    brace_top = t + Vector((0, -0.70, 0.18))
    _tube(leg, [t + d * 0.40, brace_top], 0.028, M_GEAR, 10)                                # drag brace (aft, up)
    _tube(leg, [t + d * 0.40 + Vector((0.05, 0, 0)), brace_top + Vector((0.09, 0, 0))], 0.014, M_GEAR, 6)
    _tube(leg, [t + d * 0.05 + Vector((0.08, 0, 0)), t + d * 0.52 + Vector((0.08, 0, 0))], 0.007, M_CHROME, 6)
    # landing / taxi lights on the forward face
    lb = t + d * 0.42 + fwd * 0.12
    G.bm_box(leg, lb, (0.24, 0.08, 0.11), mat=M_GEAR)
    for dx in (-0.065, 0.065):
        G.bm_cylinder(leg, lb + Vector((dx, 0.04, 0)), lb + Vector((dx, 0.056, 0)), 0.042, seg=16, mat=M_LENS)
    G.smooth_sharp(leg, 40)
    low = bmesh.new()
    G.bm_cylinder(low, t + d * 0.56, a + up * 0.20, 0.052, seg=18, mat=M_CHROME)            # chrome piston
    crown = a + up * 0.24
    G.bm_box(low, crown, (NOSE_W + 0.12, 0.13, 0.07), mat=M_GEAR)
    for sx in (-1, 1):
        G.bm_box(low, a + up * 0.12 + Vector((sx * (NOSE_W / 2 + 0.04), 0, 0)), (0.035, 0.11, 0.26), mat=M_GEAR)
    G.bm_cylinder(low, a - Vector((NOSE_W / 2 + 0.06, 0, 0)), a + Vector((NOSE_W / 2 + 0.06, 0, 0)), 0.025, seg=10,
                  mat=M_CHROME)
    p1 = t + d * 0.60 + fwd * 0.07
    p2 = t + d * 0.76 + fwd * 0.16
    p3 = crown + fwd * 0.07 + up * 0.03
    _tube(low, [p2, p3], 0.017, M_GEAR)
    _tube(leg, [p1, p2], 0.017, M_GEAR)
    G.smooth_sharp(low, 40)
    objs['gear_nose'] = G.pivot_object('gear_nose', leg, t, (1, 0, 0), (0, 0, 1), materials=mats)
    objs['gear_nose_steer'] = G.pivot_object('gear_nose_steer', low, t + d * 0.56, up, (0, 1, 0), materials=mats)
    wb = tire_bm(a, (1, 0, 0), NOSE_R, NOSE_W)
    objs['wheel_nose'] = G.pivot_object('wheel_nose', wb, a, (1, 0, 0), (0, 0, 1), materials=mats)
    # ---------------------------------------------------------------- main gear
    for sign in (1, -1):
        sfx = 'R' if sign > 0 else 'L'
        t = V3(sign * MAIN_TRUN[0], MAIN_TRUN[1], MAIN_TRUN[2])
        k = V3(sign * MAIN_KNEE[0], MAIN_KNEE[1], MAIN_KNEE[2])
        a = V3(sign * MAIN_AXLE[0], MAIN_AXLE[1], MAIN_AXLE[2])
        dd = (k - t).normalized()
        Lk = (k - t).length
        leg = bmesh.new()
        G.bm_cylinder(leg, t - Vector((0, 0.24, 0)), t + Vector((0, 0.24, 0)), 0.075, seg=14, mat=M_GEAR)   # trunnion
        G.bm_cylinder(leg, t + dd * 0.03, t + dd * (Lk * 0.60), 0.098, 0.090, seg=20, mat=M_GEAR)            # cylinder
        G.bm_cylinder(leg, t + dd * (Lk * 0.58), t + dd * (Lk * 0.64), 0.108, seg=20, mat=M_GEAR)            # gland
        G.bm_cylinder(leg, t + dd * (Lk * 0.60), k, 0.066, seg=18, mat=M_CHROME)                            # piston
        G.bm_box(leg, k + Vector((0, 0, 0.03)), (0.17, 0.19, 0.14), mat=M_GEAR)                              # axle yoke
        G.bm_cylinder(leg, k, a + Vector((sign * MAIN_W * 0.3, 0, 0)), 0.055, seg=14, mat=M_GEAR)            # axle stub
        G.bm_cylinder(leg, a - Vector((sign * MAIN_W * 0.30, 0, 0)), a - Vector((sign * MAIN_W * 0.04, 0, 0)),
                      MAIN_R * 0.42, seg=18, mat=M_HUB)                                                      # brake
        # side brace from mid-strut up/inboard to the nacelle wall
        _tube(leg, [t + dd * (Lk * 0.50), Vector((sign * 1.02, Y(11.25), -0.99))], 0.034, M_GEAR, 10)
        _tube(leg, [t + dd * (Lk * 0.50) + Vector((0, 0.06, 0)), Vector((sign * 1.02, Y(11.40), -0.99))], 0.018, M_GEAR, 6)
        # drag brace forward/up
        _tube(leg, [t + dd * (Lk * 0.35), Vector((sign * 1.40, Y(10.45), -0.95))], 0.03, M_GEAR, 10)
        # torque links (front)
        q1 = t + dd * (Lk * 0.66) + Vector((0, 0.09, 0))
        q2 = t + dd * (Lk * 0.82) + Vector((0, 0.21, 0))
        q3 = k + Vector((0, 0.09, 0.07))
        _tube(leg, [q1, q2, q3], 0.021, M_GEAR, 8)
        G.bm_cylinder(leg, q2 - Vector((0.035, 0, 0)), q2 + Vector((0.035, 0, 0)), 0.026, seg=8, mat=M_GEAR)
        _tube(leg, [t + Vector((0, -0.09, -0.05)), t + dd * (Lk * 0.55) + Vector((0, -0.11, 0)),
                    k + Vector((0, -0.10, 0.05)), a - Vector((sign * MAIN_W * 0.2, 0.08, -0.1))], 0.009, M_CHROME, 6)
        # strut door on the inboard/forward side of the leg (skin outside, white inside), pointed ends
        door = bmesh.new()
        n_in = Vector((-sign * math.cos(math.radians(25)), 0, -math.sin(math.radians(25))))
        base = t + dd * (Lk * 0.18) + n_in * 0.13
        ex = dd * (Lk * 0.70)
        ey = Vector((0, 1, 0)) * 0.46
        poly = [(0.0, -0.35), (0.12, -0.5), (0.9, -0.5), (1.0, -0.3), (1.0, 0.3), (0.9, 0.5), (0.12, 0.5), (0.0, 0.35)]
        vs_o = [door.verts.new(base + ex * p[0] + ey * p[1]) for p in poly]
        vs_i = [door.verts.new(base + ex * p[0] + ey * p[1] - n_in * 0.022) for p in poly]
        G.add_face(door, vs_o, True, M_DOOR)
        G.add_face(door, vs_i[::-1], True, M_BAY)
        for i in range(len(poly)):
            j = (i + 1) % len(poly)
            G.add_face(door, [vs_o[i], vs_o[j], vs_i[j], vs_i[i]], True, M_DOOR)
        G.join_bm(leg, door)
        G.smooth_sharp(leg, 40)
        alpha = math.radians(12)
        objs[f'gear_main_{sfx}'] = G.pivot_object(f'gear_main_{sfx}', leg, t, (math.cos(alpha), sign * math.sin(alpha), 0),
                                                  (0, 0, 1), materials=mats)
        wb = tire_bm(a, (sign, 0, 0), MAIN_R, MAIN_W)
        objs[f'wheel_main_{sfx}'] = G.pivot_object(f'wheel_main_{sfx}', wb, a, (1, 0, 0), (0, 0, 1), materials=mats)
    return objs


# ============================================================================================ bays and doors
def zigzag(p0, p1, n, amp):
    p0, p1 = np.array(p0, float), np.array(p1, float)
    d = p1 - p0
    L = np.linalg.norm(d)
    u = d / L
    nrm = np.array([-u[1], u[0]])
    pts = [p0]
    for k in range(n):
        a = p0 + d * ((k + 0.5) / n) + nrm * amp
        b = p0 + d * ((k + 1) / n)
        pts += [a, b]
    return pts


NOSE_BAY_X = 0.235
NOSE_BAY_S = (3.72, 5.82)
MAIN_BAY_X = (1.75, 2.90)          # nacelle wall + wing root (door hinged at the outer edge, hangs open)
MAIN_BAY_S = (10.30, 11.88)


def door_polygons():
    doors = {}
    for sign, sfx in ((1, 'R'), (-1, 'L')):
        x0, x1 = 0.0, sign * NOSE_BAY_X
        fore = zigzag((x0, NOSE_BAY_S[0]), (x1, NOSE_BAY_S[0]), 1, 0.11 * sign)
        aft = zigzag((x1, NOSE_BAY_S[1]), (x0, NOSE_BAY_S[1]), 1, 0.11 * sign)
        poly = [tuple(p) for p in fore] + [tuple(p) for p in aft]
        doors[f'gear_door_nose_{sfx}'] = dict(poly=poly, hinge=((x1, NOSE_BAY_S[0]), (x1, NOSE_BAY_S[1])), zmax=-0.55,
                                               depth=0.50, nz=-0.6)
    for sign, sfx in ((1, 'R'), (-1, 'L')):
        xa, xb = sign * MAIN_BAY_X[0], sign * MAIN_BAY_X[1]
        sa, sb = MAIN_BAY_S
        fore = zigzag((xa, sa), (xb, sa), 2, -0.14 * sign)
        aft = zigzag((xb, sb), (xa, sb), 2, -0.14 * sign)
        poly = [tuple(p) for p in fore] + [tuple(p) for p in aft]
        doors[f'gear_door_main_{sfx}'] = dict(poly=poly, hinge=((xb, sa), (xb, sb)), zmax=-0.05, depth=0.30, nz=-0.3)
    return doors


def _pip(pt, poly):
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xi:
                inside = not inside
    return inside


def cut_doors(bm, mats):
    """Cut door outlines out of the downward-facing skin in bm. Returns (door objects, bay bmesh)."""
    doors = door_polygons()
    bay = bmesh.new()
    objs = []
    for name, spec in doors.items():
        poly, zmax, depth, nzmax = spec['poly'], spec['zmax'], spec['depth'], spec['nz']
        poly_s = [(x, Y(s)) for (x, s) in poly]
        xs = [p[0] for p in poly_s]
        ys = [p[1] for p in poly_s]
        bx0, bx1, by0, by1 = min(xs) - 0.3, max(xs) + 0.3, min(ys) - 0.3, max(ys) + 0.3

        def cand(f):
            c = f.calc_center_median()
            return f.normal.z < nzmax and c.z < zmax and bx0 < c.x < bx1 and by0 < c.y < by1
        n = len(poly_s)
        for i in range(n):
            a = Vector((poly_s[i][0], poly_s[i][1], 0))
            b = Vector((poly_s[(i + 1) % n][0], poly_s[(i + 1) % n][1], 0))
            d = b - a
            if d.length < 1e-6:
                continue
            nrm = Vector((-d.y, d.x, 0)).normalized()
            faces = [f for f in bm.faces if cand(f)]
            if not faces:
                continue
            geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=a, plane_no=nrm)
        bm.faces.ensure_lookup_table()
        for f in bm.faces:
            f.normal_update()
        inside = [f for f in bm.faces if cand(f) and _pip((f.calc_center_median().x, f.calc_center_median().y), poly_s)]
        if not inside:
            print('[f22] door cut found no faces for', name)
            continue
        db = bmesh.new()
        vmap = {}
        for f in inside:
            vs = []
            for v in f.verts:
                if v not in vmap:
                    vmap[v] = db.verts.new(v.co)
                vs.append(vmap[v])
            try:
                db.faces.new(vs)
            except ValueError:
                pass
        bmesh.ops.solidify(db, geom=list(db.faces), thickness=0.022)
        for f in db.faces:
            f.normal_update()
            f.material_index = 1 if f.normal.z > 0.3 else 0          # inside face: bay paint
        nb0 = len(bay.faces)
        edges = set()
        for f in inside:
            for e in f.edges:
                if sum(1 for lf in e.link_faces if lf in inside) == 1:
                    edges.add(e)
        # bay = the cut skin offset inward (up) by `depth` along the averaged normal + side walls
        nsum = Vector((0, 0, 0))
        for f in inside:
            nsum += f.normal * f.calc_area()
        ndir = nsum.normalized()                       # outward (down-ish)
        off = -ndir * depth
        vm = {}
        for f in inside:
            vs = []
            for v in f.verts:
                if v not in vm:
                    vm[v] = bay.verts.new(v.co + off)
                vs.append(vm[v])
            try:
                bay.faces.new(vs[::-1])
            except ValueError:
                pass
        for e in edges:
            v0, v1 = e.verts[0].co.copy(), e.verts[1].co.copy()
            G.bm_poly(bay, [v0, v1, v1 + off, v0 + off], mat=0)
        # a few structural ribs across the bay roof and hydraulic lines along it
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        cz = sum(v.co.z for v in vm) / max(len(vm), 1)
        roof = Vector(((x0 + x1) / 2, (y0 + y1) / 2, cz)) + off + ndir * 0.035
        nrib = max(3, int((y1 - y0) / 0.28))
        from mathutils import Matrix as _M
        ax = ndir.cross(Vector((0, 1, 0))).normalized()
        R = _M((ax, Vector((0, 1, 0)), ndir.cross(ax).normalized() * -1)).transposed()
        for k in range(1, nrib):
            yy = y0 + (y1 - y0) * k / nrib
            G.bm_box(bay, (roof.x, yy, roof.z), ((x1 - x0) * 0.8, 0.025, 0.06), rot=R, mat=0)
        for k, o2 in enumerate((-0.12, -0.05, 0.02)):
            p0 = roof + ax * o2 * (x1 - x0) + ndir * (0.03 + k * 0.012)
            G.bm_cylinder(bay, (p0.x, y0 + 0.05, p0.z), (p0.x, y1 - 0.05, p0.z), 0.008, seg=6, mat=0)
        bmesh.ops.delete(bm, geom=inside, context='FACES')
        bay.faces.ensure_lookup_table()
        cen = Vector(((x0 + x1) / 2, (y0 + y1) / 2, cz)) + off * 0.5
        for f in list(bay.faces)[nb0:]:
            f.normal_update()
            c = f.calc_center_median()
            r = cen - c
            if f.normal.dot(r) < 0:
                f.normal_flip()
        ha, hb = spec['hinge']
        hA = Vector((ha[0], Y(ha[1]), 0))
        hB = Vector((hb[0], Y(hb[1]), 0))
        near = [v.co.z for v in db.verts if abs(v.co.x - hA.x) < 0.06]
        zh = max(near) if near else -1.0
        hA.z = hB.z = zh
        axis = hB - hA
        if axis.y < 0:
            axis = -axis
        G.weld(db, 1e-6)
        for ff in db.faces:
            ff.smooth = False
        ob = G.pivot_object(name, db, (hA + hB) / 2, axis, (0, 0, 1), materials=mats)
        objs.append(ob)
    for f in bay.faces:
        f.normal_update()
    return objs, bay
