"""F-22A tails, stabilators, booms, nozzles (2-D TVC), landing gear, bays and doors."""
import math
import numpy as np
try:
    import bpy
    import bmesh
    from mathutils import Vector, Matrix
except ImportError:    # plain python (texture scripts)
    bpy = bmesh = Vector = Matrix = None

import geom as G
from geom import Y, P, chain, lerp, smoothstep
import shape as S

# ==============================================================================================
# vertical tails (canted 28 deg outboard) + all-moving... (F-22: fixed fin + large rudder)
# ==============================================================================================
FIN_CANT = math.radians(28.0)
FIN_X0, FIN_Z0 = 1.52, 0.20          # root reference line (tail-boom top)
FIN_S_LE0, FIN_S_TE0 = 13.24, 17.41  # root chord at h = 0 (USAF 3-view)
FIN_H = 3.10                         # span along the cant (tip 5.09 m above ground)
FIN_TAN_LE = 0.413                   # 22.4 deg
FIN_TAN_TE = 0.519                   # 27.4 deg (tip chord 1.28 m)
FIN_TC = 0.042
RUD_V = 0.68                         # rudder hinge chord fraction
RUD_H0, RUD_H1 = 0.10, 2.05


def fin_frame(sign):
    d = Vector((sign * math.sin(FIN_CANT), 0, math.cos(FIN_CANT)))       # span direction
    n = Vector((sign * math.cos(FIN_CANT), 0, -math.sin(FIN_CANT)))      # outboard normal
    return d, n


def fin_le(h):
    return FIN_S_LE0 + FIN_TAN_LE * max(h, 0)


def fin_te(h):
    return FIN_S_TE0 - FIN_TAN_TE * max(h, 0)


def fin_pt(h, v, outer, sign):
    d, n = fin_frame(sign)
    le, te = fin_le(h), fin_te(h)
    c = te - le
    s = le + v * c
    t = S.naca_half(v, FIN_TC) * c
    base = Vector((sign * FIN_X0, Y(s), FIN_Z0)) + d * h
    return base + n * (t if outer else -t)


def fin_region(h0, h1, v0, v1, sign, nh, closes=()):
    hs = np.linspace(h0, h1, nh)
    vs = [v for v in S.WING_V if v0 - 1e-9 <= v <= v1 + 1e-9]
    if vs[0] > v0 + 1e-6:
        vs = [v0] + vs
    if vs[-1] < v1 - 1e-6:
        vs = vs + [v1]
    O = np.array([[tuple(fin_pt(h, v, True, sign)) for v in vs] for h in hs])
    I = np.array([[tuple(fin_pt(h, v, False, sign)) for v in vs] for h in hs])
    bm = bmesh.new()
    G.bm_grid(bm, O)
    G.bm_grid(bm, I)
    if 'front' in closes:
        G.bm_grid(bm, np.stack([O[:, 0], I[:, 0]]))
    if 'back' in closes:
        G.bm_grid(bm, np.stack([O[:, -1], I[:, -1]]))
    if 'bottom' in closes:
        G.bm_grid(bm, np.stack([O[0, :], I[0, :]]))
    if 'top' in closes:
        G.bm_grid(bm, np.stack([O[-1, :], I[-1, :]]))
    G.weld(bm, 1e-6)
    d, n = fin_frame(sign)

    def ref(c):
        # outward from the fin mid-plane
        base = Vector((sign * FIN_X0, c.y, FIN_Z0))
        rel = c - base
        h = rel.dot(d)
        off = rel.dot(n)
        s = Y(0) - c.y
        le, te = fin_le(h), fin_te(h)
        v = (s - le) / max(te - le, 1e-6)
        r = n * off
        if v < 0.02:
            r += Vector((0, 1, 0)) * 0.02
        if v > 0.985:
            r += Vector((0, -1, 0)) * 0.02
        if h > FIN_H - 0.01:
            r += d * 0.05
        if h < -0.3:
            r -= d * 0.05
        return r if r.length > 1e-7 else None
    G.orient_faces(bm, ref)
    return bm


def build_fin(sign, mats):
    sfx = 'R' if sign > 0 else 'L'
    fixed = bmesh.new()
    # fin body including the root extension into the fuselage
    G.join_bm(fixed, fin_region(-0.30, 0.0, 0.0, 1.0, sign, 3, ('bottom',)))
    G.join_bm(fixed, fin_region(0.0, RUD_H0, 0.0, 1.0, sign, 2))
    G.join_bm(fixed, fin_region(RUD_H0, RUD_H1, 0.0, RUD_V, sign, 18, ('back',)))
    G.join_bm(fixed, fin_region(RUD_H1, FIN_H, 0.0, 1.0, sign, 10, ('top',)))
    G.weld(fixed, 1e-5)
    # rudder
    bm = fin_region(RUD_H0 + 0.01, RUD_H1 - 0.01, RUD_V, 1.0, sign, 18, ('front', 'top', 'bottom'))
    a = (fin_pt(RUD_H0, RUD_V, True, sign) + fin_pt(RUD_H0, RUD_V, False, sign)) / 2
    b = (fin_pt(RUD_H1, RUD_V, True, sign) + fin_pt(RUD_H1, RUD_V, False, sign)) / 2
    d, n = fin_frame(sign)
    rud = G.pivot_object(f'ctl_rudder_{sfx}', bm, a, b - a, n * sign, materials=mats)
    return fixed, rud


# ==============================================================================================
# stabilators
# ==============================================================================================
STAB_X0, STAB_X1 = 1.98, 4.44
STAB_XK = 2.87
STAB_Z = 0.02
STAB_TC = 0.035
STAB_PIVOT_S = 16.70


def stab_le(x):
    # 42.9 deg LE through (2.97, 15.79) and (4.44, 17.18); kinked near the root to clear the flaperon TE
    le = 14.85 + 0.946 * (x - 1.98)
    return max(le, S.w_te(max(x, S.X_ROOT)) + 0.15)


def stab_te(x):
    if x >= STAB_XK:
        return 18.41 + 0.312 * (STAB_X1 - x)
    return 18.90 - 1.056 * (STAB_XK - x)


def stab_pt(x, v, upper):
    le, te = stab_le(x), stab_te(x)
    c = te - le
    s = le + v * c
    t = S.naca_half(v, STAB_TC) * c
    return np.array([x, s, STAB_Z + (t if upper else -t)])


def build_stab(sign, mats):
    sfx = 'R' if sign > 0 else 'L'
    xs = sorted(set([round(v, 5) for v in list(np.linspace(STAB_X0, STAB_XK, 9)) + list(np.linspace(STAB_XK, STAB_X1, 14))]))
    vs = [0, 0.0015, 0.005, 0.011, 0.02, 0.032, 0.047, 0.065, 0.09, 0.12, 0.16, 0.2, 0.25, 0.3, 0.36, 0.42, 0.48,
          0.54, 0.6, 0.66, 0.72, 0.78, 0.84, 0.89, 0.93, 0.965, 1.0]
    U = np.array([[(sign * p[0], Y(p[1]), p[2]) for p in (stab_pt(x, v, True) for v in vs)] for x in xs])
    L = np.array([[(sign * p[0], Y(p[1]), p[2]) for p in (stab_pt(x, v, False) for v in vs)] for x in xs])
    bm = bmesh.new()
    G.bm_grid(bm, U)
    G.bm_grid(bm, L)
    G.bm_grid(bm, np.stack([U[0], L[0]]))
    G.bm_grid(bm, np.stack([U[-1], L[-1]]))
    G.weld(bm, 1e-6)

    def ref(c):
        x = abs(c.x)
        s = Y(0) - c.y
        le, te = stab_le(x), stab_te(x)
        v = (s - le) / max(te - le, 1e-6)
        r = Vector((0, 0, c.z - STAB_Z))
        if v < 0.02:
            r += Vector((0, 0.02, 0))
        if v > 0.985:
            r += Vector((0, -0.02, 0))
        if x > STAB_X1 - 0.01:
            r += Vector((sign * 0.05, 0, 0))
        if x < STAB_X0 + 0.01:
            r += Vector((-sign * 0.05, 0, 0))
        return r if r.length > 1e-7 else None
    G.orient_faces(bm, ref)
    pivot = (sign * STAB_X0, Y(STAB_PIVOT_S), STAB_Z)
    return G.pivot_object(f'ctl_stabilator_{sfx}', bm, pivot, (1, 0, 0), (0, 0, 1), materials=mats)


# ==============================================================================================
# tail booms
# ==============================================================================================
BOOM_S0, BOOM_S1 = 15.60, 18.05


def boom_section(s):
    """Faceted boom section (right side) as list of (x, z): matches the fuselage corner at S_END, then a flat wedge."""
    t = smoothstep(S.S_END, BOOM_S1, s)
    xo = lerp(2.0, 1.80, t)
    xi = lerp(1.30, 1.50, t)
    zm = lerp(-0.10, 0.03, t)
    ht = lerp(0.30, 0.025, t ** 0.85)
    hb = lerp(0.34, 0.025, t ** 0.7)
    zt, zb = zm + ht, zm - hb
    cht, chb = lerp(0.09, 0.012, t), lerp(0.08, 0.012, t)
    return [(xi + 0.03, zt), (xo - cht * 1.5, zt), (xo, zt - cht), (xo, zb + chb),
            (xo - chb * 1.5, zb), (xi + 0.03, zb), (xi, zb + chb), (xi, zt - cht)]


def build_booms():
    bm = bmesh.new()
    ss = [BOOM_S0] + list(np.linspace(S.S_END, BOOM_S1, 9))
    for sign in (1, -1):
        rows = []
        for s in ss:
            sec = boom_section(max(s, S.S_END))
            rows.append([(sign * x, Y(s), z) for (x, z) in sec])
        Gb = np.array(rows)
        G.bm_grid(bm, Gb, closed_v=True)
        last = Gb[-1]
        c = last.mean(axis=0)
        G.bm_fan(bm, c + np.array([0, -0.015, 0]), list(last) + [last[0]])
    G.weld(bm, 1e-5)

    def ref(c):
        x = abs(c.x)
        s = Y(0) - c.y
        r = Vector((math.copysign(x - 1.63, c.x), 0, c.z + 0.05))
        if s > BOOM_S1 - 0.02:
            r += Vector((0, -0.3, 0))
        return r
    G.orient_faces(bm, ref)
    return bm


# ==============================================================================================
# nozzles (2-D convergent/divergent, pitch vectoring flaps)
# ==============================================================================================
NOZ_XC = 0.70
NOZ_HW = 0.50          # inner half-width
NOZ_Z_TOP = 0.335      # inner surface of the upper flap at the hinge
NOZ_Z_BOT = -0.305     # inner surface of the lower flap at the hinge
UF_LEN, LF_LEN = 0.90, 0.58
EXIT_S = S.S_END + 0.78


def _upper_outer_z(x, s):
    """Upper fuselage height at the deck (for flap continuity)."""
    return 0.462 - 0.02 * (abs(x) / 1.2) ** 2


def build_aft_deck():
    """Closes the fuselage at S_END around the two nozzle openings (dark metal)."""
    bm = bmesh.new()
    s = S.S_END
    up = S.upper_profile(s)
    lo = S.nac_lower_profile(s)
    right = [(p[0], p[1]) for p in up] + [(p[0], p[1]) for p in lo[1:]]
    left = [(-p[0], p[1]) for p in right[::-1]]
    ring = right[:-1] + left[:-1]
    verts = [bm.verts.new((x, Y(s) + 0.0005, z)) for (x, z) in ring]
    edges = [bm.edges.new((verts[i], verts[(i + 1) % len(verts)])) for i in range(len(verts))]
    for sign in (1, -1):
        x0, x1 = NOZ_XC - NOZ_HW - 0.045, NOZ_XC + NOZ_HW + 0.045
        rect = [(x0, NOZ_Z_BOT - 0.12), (x1, NOZ_Z_BOT - 0.12), (x1, NOZ_Z_TOP + 0.1), (x0, NOZ_Z_TOP + 0.1)]
        hv = [bm.verts.new((sign * x, Y(s) + 0.0005, z)) for (x, z) in rect]
        for i in range(4):
            edges.append(bm.edges.new((hv[i], hv[(i + 1) % 4])))
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges, normal=Vector((0, -1, 0)))
    for f in bm.faces:
        f.normal_update()
        if f.normal.y > 0:
            f.normal_flip()
    return bm


def _plate(bm, poly_sz, x, t, mat=0):
    """Thick plate in the plane x = const, polygon given as (s, z)."""
    n = len(poly_sz)
    A = [(x + t, Y(s), z) for (s, z) in poly_sz]
    B = [(x - t, Y(s), z) for (s, z) in poly_sz]
    G.bm_poly(bm, A, mat=mat)
    G.bm_poly(bm, B[::-1], mat=mat)
    for i in range(n):
        j = (i + 1) % n
        G.bm_poly(bm, [A[i], B[i], B[j], A[j]], mat=mat)


def build_nozzle(sign, mats_skin_hot):
    """Returns (static bmesh [sidewalls, tunnel, glow face], [upper flap, lower flap] objects)."""
    idx = 2 if sign > 0 else 1
    xc = sign * NOZ_XC
    st = bmesh.new()
    s0 = S.S_END
    # sidewalls: top edge under the upper flap, bottom edge above the lower flap, slanted aft edge
    for side in (-1, 1):
        xw = xc + side * (NOZ_HW + 0.03)
        poly = [(s0 - 0.02, NOZ_Z_BOT - 0.17), (s0 + LF_LEN - 0.06, NOZ_Z_BOT - 0.07),
                (s0 + UF_LEN - 0.12, NOZ_Z_TOP + 0.02), (s0 - 0.02, NOZ_Z_TOP + 0.12)]
        _plate(st, poly, xw, 0.03, mat=0)
    # tunnel into the fuselage + flame-holder face
    x0, x1 = xc - NOZ_HW, xc + NOZ_HW
    zb, zt = NOZ_Z_BOT, NOZ_Z_TOP
    rows = []
    for s in (s0 + 0.01, s0 - 0.35, s0 - 0.95):
        k = 0.0 if s > s0 - 0.1 else 0.06
        rows.append([(x0 + k, Y(s), zb + k), (x1 - k, Y(s), zb + k), (x1 - k, Y(s), zt - k), (x0 + k, Y(s), zt - k)])
    Gt = np.array(rows)
    G.bm_grid(st, Gt, closed_v=True, mat=1)
    for f in st.faces:
        if f.material_index == 1:
            f.normal_update()
            c = f.calc_center_median()
            r = Vector((xc - c.x, 0, 0.015 - c.z))
            if f.normal.dot(r) < 0:
                f.normal_flip()
    G.join_bm(st, flameholder(xc, s0 - 0.94, x1 - x0 - 0.12, zt - zb - 0.12))
    # flaps
    flaps = []
    for (name, up, ln) in ((f'nozzle_flap_upper_{idx}', True, UF_LEN), (f'nozzle_flap_lower_{idx}', False, LF_LEN)):
        fb = bmesh.new()
        n = 13
        xs = np.linspace(x0 - 0.02, x1 + 0.02, n)

        def te_off(x):
            u = (x - x0) / (x1 - x0)
            if up:     # shallow double sawtooth
                return -0.16 * abs(((u * 2.0) % 1.0) - 0.5) * 2 + 0.0
            return -0.13 * abs(u - 0.5) * 2
        rows_o, rows_i = [], []
        for k in range(7):
            t = k / 6
            ro, ri = [], []
            for x in xs:
                s = s0 + t * (ln + te_off(x))
                if up:
                    zo = lerp(_upper_outer_z(x, s0), 0.365, t)
                    zi = lerp(NOZ_Z_TOP, 0.335, t)
                    zi = min(zi, zo - 0.012)
                else:
                    zo = lerp(-0.485, -0.36, t)
                    zi = lerp(NOZ_Z_BOT, -0.325, t)
                    zi = max(zi, zo + 0.012)
                ro.append((x, Y(s), zo))
                ri.append((x, Y(s), zi))
            rows_o.append(ro)
            rows_i.append(ri)
        Go, Gi = np.array(rows_o), np.array(rows_i)
        G.bm_grid(fb, Go, mat=0)
        G.bm_grid(fb, Gi, mat=1)
        G.bm_grid(fb, np.stack([Go[-1], Gi[-1]]), mat=1)
        G.bm_grid(fb, np.stack([Go[:, 0], Gi[:, 0]]), mat=0)
        G.bm_grid(fb, np.stack([Go[:, -1], Gi[:, -1]]), mat=0)
        G.bm_grid(fb, np.stack([Go[0], Gi[0]]), mat=1)
        G.weld(fb, 1e-6)
        for f in fb.faces:
            f.normal_update()
            c = f.calc_center_median()
            if abs(f.normal.z) > 0.5:
                outer = (f.material_index == 0)
                r = Vector((0, 0, 1 if up == outer else -1))
            elif abs(f.normal.x) > 0.7:
                r = Vector((math.copysign(1, c.x - xc), 0, 0))
            else:
                s = Y(0) - c.y
                r = Vector((0, -1, 0)) if s > s0 + 0.2 else Vector((0, 1, 0))
            if f.normal.dot(r) < 0:
                f.normal_flip()
        G.smooth_sharp(fb, 30)
        zh = (NOZ_Z_TOP + 0.05) if up else (NOZ_Z_BOT - 0.07)
        ob = G.pivot_object(name, fb, (xc, Y(s0), zh), (1, 0, 0), (0, 0, 1), materials=mats_skin_hot)
        flaps.append(ob)
    return st, flaps


def flameholder(xc, s, w, h):
    """Dark turbine/flame-holder face with radial gutters (material 2 = glow)."""
    bm = bmesh.new()
    y = Y(s)
    # back plate (glow material)
    G.bm_poly(bm, [(xc - w / 2, y, -h / 2), (xc + w / 2, y, -h / 2), (xc + w / 2, y, h / 2), (xc - w / 2, y, h / 2)],
              mat=2)
    # vertical flame-holder gutters (dark)
    for k in range(7):
        x = xc - w / 2 + w * (k + 0.5) / 7
        G.bm_box(bm, (x, y - 0.06, 0), (0.035, 0.1, h * 0.92), mat=1)
    G.bm_box(bm, (xc, y - 0.1, 0), (w * 0.92, 0.1, 0.04), mat=1)
    for f in bm.faces:
        f.normal_update()
        if f.material_index == 2 and f.normal.y < 0:
            f.normal_flip()
    return bm


# ==============================================================================================
# landing gear
# ==============================================================================================
NOSE_TRUN = (0.0, 5.12, -0.62)
NOSE_AXLE = (0.0, 4.98, S.Z_GROUND + 0.30)
NOSE_R, NOSE_W = 0.30, 0.19
MAIN_TRUN = (1.34, 11.12, -0.52)
MAIN_AXLE = (1.62, 10.97, S.Z_GROUND + 0.47)
MAIN_R, MAIN_W = 0.47, 0.29


def V3(x, s, z):
    return Vector((x, Y(s), z))


def tire_bm(center, axis, R, W, mat_tire=1, mat_hub=2, seg=40):
    """Tire (revolved profile with tread grooves) + hub with bolts + brake housing, around axis through center."""
    bm = bmesh.new()
    prof = []
    n = 14
    for k in range(n + 1):
        a = -math.pi / 2 + math.pi * k / n
        r = R - (R * 0.13) * (1 - math.cos(a)) ** 1.6
        # shallow circumferential tread grooves
        if abs(math.sin(a)) < 0.45 and k % 3 == 1:
            r -= 0.006
        prof.append((r, W / 2 * math.sin(a) * 1.0))
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


def _tube(bm, pts, r, mat=0, seg=8):
    for a, b in zip(pts[:-1], pts[1:]):
        G.bm_cylinder(bm, Vector(a), Vector(b), r, seg=seg, mat=mat)


def build_gear(mats):
    """mats: [gear paint, tire, hub, skin door, chrome, lens]. Returns dict of objects (world-space pivots)."""
    M_GEAR, M_TIRE, M_HUB, M_DOOR, M_CHROME, M_LENS = 0, 1, 2, 3, 4, 5
    objs = {}
    # ---------------- nose gear
    t = V3(*NOSE_TRUN)
    a = V3(*NOSE_AXLE)
    leg = bmesh.new()
    ax = (a - t)
    L = ax.length
    d = ax.normalized()
    up = -d
    fwd = Vector((0, 1, 0))
    # trunnion cross-tube + steering collar
    G.bm_cylinder(leg, t - Vector((0.17, 0, 0)), t + Vector((0.17, 0, 0)), 0.055, seg=14, mat=M_GEAR)
    G.bm_cylinder(leg, t + d * 0.02, t + d * 0.60, 0.078, 0.072, seg=20, mat=M_GEAR)       # outer cylinder
    G.bm_cylinder(leg, t + d * 0.18, t + d * 0.26, 0.098, seg=20, mat=M_GEAR)              # steering collar
    G.bm_box(leg, t + d * 0.22 + fwd * 0.10, (0.07, 0.10, 0.06), mat=M_GEAR)               # steering actuator
    G.bm_cylinder(leg, t + d * 0.58, t + d * 0.63, 0.085, seg=20, mat=M_GEAR)              # gland nut
    # ---- steerable lower part (piston, fork, axle, lower torque link) -> gear_nose_steer
    low = bmesh.new()
    G.bm_cylinder(low, t + d * 0.60, a + up * 0.20, 0.052, seg=18, mat=M_CHROME)           # chrome piston
    crown = a + up * 0.24
    G.bm_box(low, crown, (NOSE_W + 0.12, 0.13, 0.07), mat=M_GEAR)
    for sx in (-1, 1):
        G.bm_box(low, a + up * 0.12 + Vector((sx * (NOSE_W / 2 + 0.04), 0, 0)), (0.035, 0.11, 0.26), mat=M_GEAR)
    G.bm_cylinder(low, a - Vector((NOSE_W / 2 + 0.06, 0, 0)), a + Vector((NOSE_W / 2 + 0.06, 0, 0)), 0.025, seg=10,
                  mat=M_CHROME)
    p1 = t + d * 0.63 + fwd * 0.07
    p2 = t + d * 0.78 + fwd * 0.16
    p3 = crown + fwd * 0.07 + up * 0.03
    _tube(low, [p2, p3], 0.017, M_GEAR)
    G.bm_cylinder(low, p2 - Vector((0.03, 0, 0)), p2 + Vector((0.03, 0, 0)), 0.022, seg=8, mat=M_GEAR)
    _tube(leg, [p1, p2], 0.017, M_GEAR)
    G.smooth_sharp(low, 40)
    steer_pivot = t + d * 0.60
    # drag brace up and aft into the bay
    brace_top = t + Vector((0, -0.62, 0.20))
    _tube(leg, [t + d * 0.46, brace_top], 0.028, M_GEAR, 10)
    _tube(leg, [t + d * 0.46 + Vector((0.04, 0, 0)), brace_top + Vector((0.08, 0, 0))], 0.014, M_GEAR, 6)
    # hydraulic lines
    _tube(leg, [t + d * 0.05 + Vector((0.08, 0, 0)), t + d * 0.55 + Vector((0.08, 0, 0))], 0.007, M_CHROME, 6)
    # landing / taxi light assembly (forward face)
    lb = t + d * 0.45 + fwd * 0.13
    G.bm_box(leg, lb, (0.22, 0.08, 0.10), mat=M_GEAR)
    for dx in (-0.06, 0.06):
        G.bm_cylinder(leg, lb + Vector((dx, 0.04, 0)), lb + Vector((dx, 0.055, 0)), 0.038, seg=16, mat=M_LENS)
    G.smooth_sharp(leg, 40)
    objs['gear_nose'] = G.pivot_object('gear_nose', leg, t, (1, 0, 0), (0, 0, 1), materials=mats)
    # steer node: local X along the strut, pointing up (rotation about local X = steering)
    objs['gear_nose_steer'] = G.pivot_object('gear_nose_steer', low, steer_pivot, up, (0, 1, 0), materials=mats)
    wb = tire_bm(a, (1, 0, 0), NOSE_R, NOSE_W, M_TIRE, M_HUB)
    objs['wheel_nose'] = G.pivot_object('wheel_nose', wb, a, (1, 0, 0), (0, 0, 1), materials=mats)
    # ---------------- main gear
    for sign in (1, -1):
        sfx = 'R' if sign > 0 else 'L'
        t = V3(sign * MAIN_TRUN[0], MAIN_TRUN[1], MAIN_TRUN[2])
        a = V3(sign * MAIN_AXLE[0], MAIN_AXLE[1], MAIN_AXLE[2])
        strut_x = sign * (MAIN_AXLE[0] - MAIN_W / 2 - 0.10)
        leg = bmesh.new()
        knee = Vector((strut_x, a.y + 0.02, a.z + 0.02))
        dd = (knee - t).normalized()
        Lk = (knee - t).length
        G.bm_cylinder(leg, t - Vector((0, 0.22, 0)), t + Vector((0, 0.22, 0)), 0.07, seg=14, mat=M_GEAR)     # trunnion
        G.bm_cylinder(leg, t + dd * 0.03, t + dd * (Lk * 0.60), 0.092, 0.086, seg=20, mat=M_GEAR)
        G.bm_cylinder(leg, t + dd * (Lk * 0.58), t + dd * (Lk * 0.63), 0.1, seg=20, mat=M_GEAR)
        G.bm_cylinder(leg, t + dd * (Lk * 0.60), knee, 0.064, seg=18, mat=M_CHROME)
        G.bm_box(leg, knee + Vector((0, 0, 0.02)), (0.16, 0.16, 0.12), mat=M_GEAR)                         # axle yoke
        G.bm_cylinder(leg, knee, a + Vector((sign * MAIN_W * 0.3, 0, 0)), 0.05, seg=14, mat=M_GEAR)         # axle stub
        # brake housing (inside the hub, inboard side)
        G.bm_cylinder(leg, a - Vector((sign * MAIN_W * 0.28, 0, 0)), a - Vector((sign * MAIN_W * 0.05, 0, 0)),
                      MAIN_R * 0.42, seg=18, mat=M_HUB)
        # side brace to the fuselage
        _tube(leg, [t + dd * (Lk * 0.42), Vector((sign * 0.95, Y(10.75), -0.60))], 0.032, M_GEAR, 10)
        # torque links (front)
        q1 = t + dd * (Lk * 0.64) + Vector((0, 0.08, 0))
        q2 = t + dd * (Lk * 0.80) + Vector((0, 0.19, 0))
        q3 = knee + Vector((0, 0.08, 0.06))
        _tube(leg, [q1, q2, q3], 0.02, M_GEAR, 8)
        G.bm_cylinder(leg, q2 - Vector((0.035, 0, 0)), q2 + Vector((0.035, 0, 0)), 0.025, seg=8, mat=M_GEAR)
        # hydraulic / brake lines
        _tube(leg, [t + Vector((0, -0.09, -0.05)), t + dd * (Lk * 0.55) + Vector((0, -0.1, 0)),
                    knee + Vector((0, -0.09, 0.05)), a - Vector((sign * MAIN_W * 0.2, 0.08, -0.1))], 0.008, M_CHROME, 6)
        # strut door attached to the leg (outboard), sawtooth top/bottom edges
        door = bmesh.new()
        dx = sign * (MAIN_AXLE[0] + MAIN_W / 2 + 0.055)
        ys0, ys1 = Y(11.48), Y(10.60)
        z_top, z_bot = t.z - 0.04, knee.z + 0.16
        teeth = 3
        poly = []
        for k in range(teeth * 2 + 1):
            y = ys0 + (ys1 - ys0) * k / (teeth * 2)
            poly.append((y, z_top + (0.05 if k % 2 else 0.0)))
        for k in range(teeth * 2 + 1):
            y = ys1 + (ys0 - ys1) * k / (teeth * 2)
            poly.append((y, z_bot - (0.05 if k % 2 else 0.0)))
        G.bm_extrude_polygon(door, poly, (dx - 0.012, 0, 0), (0, 1, 0), (0, 0, 1), 0.024, mat=M_DOOR)
        for f in door.faces:
            f.normal_update()
        # door brackets
        for zz in (z_top - 0.15, z_bot + 0.15):
            G.bm_box(door, Vector((sign * (MAIN_AXLE[0] + MAIN_W / 2 - 0.02), (ys0 + ys1) / 2, zz)), (0.16, 0.05, 0.04),
                     mat=M_GEAR)
        G.join_bm(leg, door)
        G.smooth_sharp(leg, 40)
        alpha = math.radians(16)
        objs[f'gear_main_{sfx}'] = G.pivot_object(f'gear_main_{sfx}', leg, t, (math.cos(alpha), sign * math.sin(alpha), 0),
                                                  (0, 0, 1), materials=mats)
        wb = tire_bm(a, (sign, 0, 0), MAIN_R, MAIN_W, M_TIRE, M_HUB)
        objs[f'wheel_main_{sfx}'] = G.pivot_object(f'wheel_main_{sfx}', wb, a, (1, 0, 0), (0, 0, 1), materials=mats)
    return objs


# ==============================================================================================
# bays: cut door outlines out of the belly skin, add bay boxes, create door objects
# ==============================================================================================
def zigzag(p0, p1, n, amp):
    """Polyline from p0 to p1 (2-D) with n teeth of amplitude amp (perpendicular)."""
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


NOSE_BAY = [(-0.27, 3.45), (0.27, 3.45), (0.27, 5.35), (-0.27, 5.35)]
MAIN_BAY_X = (0.97, 1.66)
MAIN_BAY_S = (9.70, 11.42)


def door_polygons():
    """Planform polygons (x, s) of the gear doors: dict name -> (poly, hinge_a, hinge_b)."""
    doors = {}
    # nose: two doors split on the centreline, sawtooth fore/aft ends
    for sign, sfx in ((1, 'R'), (-1, 'L')):
        x0, x1 = 0.0, sign * 0.27
        fore = zigzag((x0, 3.45), (x1, 3.45), 1, 0.12 * -1)
        aft = zigzag((x1, 5.35), (x0, 5.35), 1, 0.12 * -1)
        poly = [tuple(p) for p in fore] + [tuple(p) for p in aft]
        doors[f'gear_door_nose_{sfx}'] = (poly, (x1, 3.45), (x1, 5.35))
    for sign, sfx in ((1, 'R'), (-1, 'L')):
        xa, xb = sign * MAIN_BAY_X[0], sign * MAIN_BAY_X[1]
        sa, sb = MAIN_BAY_S
        fore = zigzag((xa, sa), (xb, sa), 2, -0.13 * sign)
        aft = zigzag((xb, sb), (xa, sb), 2, -0.13 * sign)
        poly = [tuple(p) for p in fore] + [tuple(p) for p in aft]
        doors[f'gear_door_main_{sfx}'] = (poly, (xb, sa), (xb, sb))
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


def cut_doors(bm, mats, depth_fn):
    """Cut door outlines out of the downward-facing skin in bm. Returns list of door objects and a bay bmesh."""
    doors = door_polygons()
    bay = bmesh.new()
    objs = []
    for name, (poly, ha, hb) in doors.items():
        poly_s = [(x, Y(s)) for (x, s) in poly]   # planform in world (x, y)
        n = len(poly_s)
        for i in range(n):
            a = Vector((poly_s[i][0], poly_s[i][1], 0))
            b = Vector((poly_s[(i + 1) % n][0], poly_s[(i + 1) % n][1], 0))
            d = (b - a)
            if d.length < 1e-6:
                continue
            nrm = Vector((-d.y, d.x, 0)).normalized()
            mid = (a + b) / 2
            rad = d.length / 2 + 0.35
            faces = [f for f in bm.faces if f.normal.z < -0.2 and f.calc_center_median().z < -0.6 and
                     (Vector((f.calc_center_median().x, f.calc_center_median().y, 0)) - mid).length < rad + 0.3]
            if not faces:
                continue
            geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=a, plane_no=nrm)
        bm.faces.ensure_lookup_table()
        inside = [f for f in bm.faces if f.normal.z < -0.2 and f.calc_center_median().z < -0.6 and
                  _pip((f.calc_center_median().x, f.calc_center_median().y), poly_s)]
        if not inside:
            print('[f22] door cut found no faces for', name)
            continue
        # door geometry = copy of inside faces
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
        # thickness (inward)
        ret = bmesh.ops.solidify(db, geom=list(db.faces), thickness=0.025)
        for f in db.faces:
            f.material_index = 0
        # boundary edges of the hole -> bay walls
        edges = set()
        for f in inside:
            for e in f.edges:
                if sum(1 for lf in e.link_faces if lf in inside) == 1:
                    edges.add(e)
        for e in edges:
            v0, v1 = e.verts[0].co.copy(), e.verts[1].co.copy()
            dz = depth_fn(name)
            q = [v0, v1, v1 + Vector((0, 0, dz)), v0 + Vector((0, 0, dz))]
            G.bm_poly(bay, q, mat=0)
        # bay ceiling
        ceil_z = min(v.co.z for f in inside for v in f.verts) + depth_fn(name)
        ring = [(x, y, ceil_z + 0.0) for (x, y) in poly_s]
        bmesh.ops.delete(bm, geom=inside, context='FACES')
        f = G.bm_poly(bay, [Vector(p) for p in ring], mat=0)
        # structural ribs across the ceiling + a longeron + hydraulic lines
        xs = [p[0] for p in poly_s]
        ys = [p[1] for p in poly_s]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        nrib = max(3, int((y1 - y0) / 0.28))
        for k in range(1, nrib):
            yy = y0 + (y1 - y0) * k / nrib
            G.bm_box(bay, ((x0 + x1) / 2, yy, ceil_z - 0.035), ((x1 - x0) * 0.92, 0.025, 0.07), mat=0)
        G.bm_box(bay, ((x0 + x1) / 2, (y0 + y1) / 2, ceil_z - 0.02), (0.04, (y1 - y0) * 0.92, 0.04), mat=0)
        for k, off in enumerate((0.25, 0.32, 0.39)):
            xx = x0 + (x1 - x0) * off
            G.bm_cylinder(bay, (xx, y0 + 0.05, ceil_z - 0.08 - k * 0.012), (xx, y1 - 0.05, ceil_z - 0.08 - k * 0.012),
                          0.008, seg=6, mat=0)
        # hinge axis
        hA = Vector((ha[0], Y(ha[1]), 0))
        hB = Vector((hb[0], Y(hb[1]), 0))
        zh = max(v.co.z for v in db.verts if abs(v.co.x - hA.x) < 0.05) if any(abs(v.co.x - hA.x) < 0.05 for v in db.verts) else -1.0
        hA.z = hB.z = zh
        axis = (hB - hA)
        if axis.y < 0:
            axis = -axis
        pivot = (hA + hB) / 2
        G.weld(db, 1e-6)
        for ff in db.faces:
            ff.smooth = False
        ob = G.pivot_object(name, db, pivot, axis, (0, 0, 1), materials=mats)
        objs.append(ob)
    # bay walls face inward
    for f in bay.faces:
        f.normal_update()
    return objs, bay


# ==============================================================================================
# formation light strips (electroluminescent) + light positions
# ==============================================================================================
def build_formation_strips():
    """Thin emissive strips: forward fuselage sides, wingtips, fin tips (outboard)."""
    bm = bmesh.new()
    for sign in (1, -1):
        # forward fuselage, just below the chine under the canopy
        for s0, s1 in ((3.4, 4.3),):
            pts = []
            for s in np.linspace(s0, s1, 6):
                xc, zc = S.chine(s)
                pts.append(Vector((sign * (xc - 0.012), Y(s), zc - 0.07)))
            _strip(bm, pts, Vector((sign, 0, -0.25)).normalized(), 0.05)
        # wingtip upper surface, along the tip chord
        x = S.X_TIP - 0.10
        pts = []
        for v in np.linspace(0.18, 0.8, 6):
            p = S.wing_pt(x, v, True)
            pts.append(Vector((sign * p[0], Y(p[1]), p[2] + 0.004)))
        _strip(bm, pts, Vector((0, 0, 1)), 0.045)
        # fin outboard side near the tip
        pts = []
        h = FIN_H - 0.28
        for v in np.linspace(0.12, 0.7, 6):
            pts.append(fin_pt(h, v, True, sign) + fin_frame(sign)[1] * 0.004)
        _strip(bm, pts, fin_frame(sign)[1], 0.05, up=fin_frame(sign)[0])
    return bm


def _strip(bm, pts, normal, width, up=None):
    n = Vector(normal).normalized()
    rows = []
    for i, p in enumerate(pts):
        a = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        side = n.cross(a).normalized() if up is None else Vector(up).normalized()
        rows.append([tuple(p - side * width / 2), tuple(p + side * width / 2)])
    Gs = np.array(rows)
    V = G.bm_grid(bm, Gs)
    for f in bm.faces:
        f.normal_update()
    for f in list(bm.faces)[-(len(pts) - 1):]:
        if f.normal.dot(n) < 0:
            f.normal_flip()


LIGHTS = {
    # name: (x, s, z)
    'light_nav_L': (-(S.X_TIP - 0.05), 12.66, -0.27),
    'light_nav_R': ((S.X_TIP - 0.05), 12.66, -0.27),
    'light_strobe_L': (-(S.X_TIP - 0.03), 13.55, -0.26),
    'light_strobe_R': ((S.X_TIP - 0.03), 13.55, -0.26),
    'light_tail': (1.66, BOOM_S1 - 0.02, 0.05),
    'light_beacon_top': (0.0, 9.6, 0.585),
    'light_beacon_bottom': (0.0, 9.2, -1.055),
}


def build_nav_lenses():
    """Small lens fairings for the position lights: mat 0 red (left tip), 1 green (right tip), 2 clear (strobes/tail)."""
    bm = bmesh.new()
    for name, (x, s, z) in LIGHTS.items():
        if not name.startswith(('light_nav', 'light_strobe', 'light_tail')):
            continue
        mat = 0 if name == 'light_nav_L' else 1 if name == 'light_nav_R' else 2
        c = Vector((x, Y(s), z))
        # half-ellipsoid bump facing outboard (or aft for the tail light)
        if name == 'light_tail':
            axis = Vector((0, -1, 0))
        else:
            axis = Vector((math.copysign(1, x), 0, 0))
        prof = [(0.0, 0.028), (0.018, 0.024), (0.03, 0.014), (0.036, 0.0)]
        prof = [(r, h - 0.012) for (r, h) in prof]
        rows = G.bm_revolve(bm, prof, c, axis, seg=12, mat=mat)
    G.weld(bm, 1e-6)
    centers = [Vector((x, Y(s), z)) for n, (x, s, z) in LIGHTS.items() if n.startswith(('light_nav', 'light_strobe', 'light_tail'))]
    for f in bm.faces:
        f.normal_update()
        fc = f.calc_center_median()
        cc = min(centers, key=lambda q: (q - fc).length)
        if f.normal.dot(fc - cc) < 0:
            f.normal_flip()
    G.smooth_sharp(bm, 60)
    return bm
