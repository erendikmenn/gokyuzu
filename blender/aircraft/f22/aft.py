"""F-22A aft body: tail booms, aft bulkhead, 2-D thrust-vectoring nozzles (upper/lower flaps with chevron trailing
edges, faceted sidewalls), centre stinger, afterburner glow faces.

References: ref/rear_top_477.jpg (top-down), ref/rear_nozzles_siaf.jpg, ref/rear_tailfeathers.jpg.
"""
import math
import numpy as np
try:
    import bmesh
    from mathutils import Vector
except ImportError:     # plain python (texture scripts)
    bmesh = Vector = None

import geom as G
from geom import Y, lerp, smoothstep
import oml as O

M_SKIN, M_DARK, M_HOT, M_BAY, M_DUCT, M_GLOW = 0, 1, 2, 3, 4, 5

NOZ_XC = 0.70            # engine / nozzle centre (|x|)
NOZ_HW = 0.45            # inner half-width of the nozzle channel
S_HINGE_U = 15.55        # upper flap hinge (under the sawtooth deck edge)
S_HINGE_L = 15.62        # lower flap hinge
Z_HINGE_U = 0.30         # inner surface of the upper flap at the hinge
Z_HINGE_L = -0.34        # inner surface of the lower flap at the hinge
UF_LEN = 1.30            # upper flap length at the centre (chevron apex, Lockheed 3-view s = 16.85)
LF_LEN = 1.05
EXIT_S = S_HINGE_U + 1.10       # nominal exhaust exit (nozzle_1/2 empties)
BOOM_S0, BOOM_S1 = 14.4, 17.55


def _poly_prism(bm, pts2d, axis_u, axis_v, origin, depth_dir, depth, mat):
    """Extrude a 2-D polygon (in the (axis_u, axis_v) plane at origin) along depth_dir."""
    o = Vector(origin)
    u, v, d = Vector(axis_u), Vector(axis_v), Vector(depth_dir).normalized()
    A = [bm.verts.new(o + u * p[0] + v * p[1]) for p in pts2d]
    B = [bm.verts.new(o + u * p[0] + v * p[1] + d * depth) for p in pts2d]
    n = len(pts2d)
    G.add_face(bm, A[::-1], True, mat)
    G.add_face(bm, B, True, mat)
    for i in range(n):
        j = (i + 1) % n
        G.add_face(bm, [A[i], A[j], B[j], B[i]], True, mat)


def _loft_closed(bm, sections, mat, cap_end=True, cap_start=False):
    """sections: list of (n, 3) closed rings (same n). Returns nothing; faces oriented later."""
    A = np.array(sections)
    G.bm_grid(bm, A, closed_v=True, mat=mat)
    if cap_end:
        c = A[-1].mean(axis=0)
        G.bm_fan(bm, c, list(A[-1]) + [A[-1][0]], mat=mat)
    if cap_start:
        c = A[0].mean(axis=0)
        G.bm_fan(bm, c, list(A[0]) + [A[0][0]], mat=mat)


def _orient_convex(bm, center_fn):
    for f in bm.faces:
        f.normal_update()
        c = f.calc_center_median()
        r = c - center_fn(c)
        if f.normal.dot(r) < 0:
            f.normal_flip()


# ============================================================================================ booms
def boom_section(s):
    """Right boom section (x, z) ring: flat faceted hexagon, tapering to a wedge at the aft tip."""
    t = smoothstep(15.3, BOOM_S1, s)
    xi = lerp(1.26, 1.47, t ** 1.2)          # inner side
    xo = lerp(1.99, 1.70, t ** 1.1)          # outer side
    zt = lerp(0.20, 0.035, t ** 0.9)
    zb = lerp(-0.42, -0.035, t ** 0.8)
    zm = lerp(-0.08, 0.0, t)
    bt = min(0.12, (zt - zm) * 0.45)
    bb = min(0.14, (zm - zb) * 0.45)
    return [(xi, zt), (xo - bt * 1.4, zt), (xo, zm + (zt - zm) * 0.35), (xo, zm - (zm - zb) * 0.35),
            (xo - bb * 1.6, zb), (xi, zb)]


def build_booms():
    bm = bmesh.new()
    ss = list(np.linspace(BOOM_S0, 15.3, 4)) + list(np.linspace(15.5, BOOM_S1 - 0.02, 10))
    for sign in (1, -1):
        rows = []
        for s in ss:
            rows.append([(sign * x, Y(s), z) for (x, z) in boom_section(s)])
        if sign < 0:
            rows = [r[::-1] for r in rows]
        _loft_closed(bm, rows, M_SKIN, cap_end=True, cap_start=True)
    G.weld(bm, 1e-5)

    def cen(c):
        s = Y(0) - c.y
        sec = boom_section(min(max(s, BOOM_S0), BOOM_S1))
        xm = sum(p[0] for p in sec) / len(sec)
        zm = sum(p[1] for p in sec) / len(sec)
        return Vector((math.copysign(xm, c.x), c.y + (0.3 if s > BOOM_S1 - 0.1 else -0.3 if s < BOOM_S0 + 0.05 else 0), zm))
    _orient_convex(bm, cen)
    return bm


# ============================================================================================ aft bulkhead
def build_bulkhead():
    """Closes the fuselage skin at S_END around the two nozzle channels (dark), incl. the channel tunnels."""
    bm = bmesh.new()
    s = O.S_END
    up = O.upper_profile(s)
    nac = [O.nac_profile_point(s, j) for j in range(O.NAC_N[0] + O.NAC_N[1] + 1)]
    right = [(p[0], p[1]) for p in up] + [(p[0], p[1]) for p in nac[1:]]
    left = [(-p[0], p[1]) for p in right[::-1]]
    ring = right[:-1] + left[:-1]
    y = Y(s) + 0.002
    verts = [bm.verts.new((x, y, z)) for (x, z) in ring]
    edges = [bm.edges.new((verts[i], verts[(i + 1) % len(verts)])) for i in range(len(verts))]
    for sign in (1, -1):
        x0, x1 = NOZ_XC - NOZ_HW - 0.03, NOZ_XC + NOZ_HW + 0.03
        rect = [(x0, Z_HINGE_L - 0.03), (x1, Z_HINGE_L - 0.03), (x1, Z_HINGE_U + 0.03), (x0, Z_HINGE_U + 0.03)]
        hv = [bm.verts.new((sign * x, y, z)) for (x, z) in rect]
        for i in range(4):
            edges.append(bm.edges.new((hv[i], hv[(i + 1) % 4])))
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges, normal=Vector((0, -1, 0)))
    for f in bm.faces:
        f.material_index = M_DARK
        f.normal_update()
        if f.normal.y > 0:
            f.normal_flip()
    # channel tunnels into the fuselage + afterburner face (glow material, split off later)
    for sign in (1, -1):
        xc = sign * NOZ_XC
        rows = []
        for (ss, k) in ((s + 0.001, 0.0), (s - 0.45, 0.04), (s - 1.05, 0.10)):
            x0, x1 = xc - NOZ_HW + k, xc + NOZ_HW - k
            zb, zt = Z_HINGE_L + k * 0.8, Z_HINGE_U - k * 0.8
            rows.append([(x0, Y(ss), zb), (x1, Y(ss), zb), (x1, Y(ss), zt), (x0, Y(ss), zt)])
        T = np.array(rows)
        n0 = len(bm.faces)
        G.bm_grid(bm, T, closed_v=True, mat=M_HOT)
        for f in list(bm.faces)[n0:]:
            f.normal_update()
            c = f.calc_center_median()
            r = Vector((xc - c.x, 0, -0.03 - c.z))
            if f.normal.dot(r) < 0:
                f.normal_flip()
        # flame holder face (glow) with dark radial gutters
        ss = s - 1.04
        w, h = 2 * (NOZ_HW - 0.10), (Z_HINGE_U - Z_HINGE_L) - 0.16
        zc = 0.5 * (Z_HINGE_U + Z_HINGE_L)
        f = G.bm_poly(bm, [(xc - w / 2, Y(ss), zc - h / 2), (xc + w / 2, Y(ss), zc - h / 2), (xc + w / 2, Y(ss), zc + h / 2),
                           (xc - w / 2, Y(ss), zc + h / 2)], mat=M_GLOW)
        if f:
            f.normal_update()
            if f.normal.y < 0:
                f.normal_flip()
        for k in range(7):
            gx = xc - w / 2 + w * (k + 0.5) / 7
            G.bm_box(bm, (gx, Y(ss) - 0.05, zc), (0.03, 0.08, h * 0.94), mat=M_DARK)
        G.bm_box(bm, (xc, Y(ss) - 0.08, zc), (w * 0.94, 0.08, 0.035), mat=M_DARK)
    return bm


# ============================================================================================ nozzles
def _deck_z(x):
    """Aft deck (upper skin) height at S_END for continuity of the upper flap's outer surface."""
    up = O.upper_profile(O.S_END)
    xs = [p[0] for p in up]
    zs = [p[1] for p in up]
    return float(np.interp(abs(x), xs, zs))


def _belly_z(x):
    return O.z_nac_bot(O.S_END)


def build_flap(sign, upper):
    """One nozzle flap as a thick plate; world coordinates (pivot applied by the caller). Chevron trailing edge."""
    xc = sign * NOZ_XC
    x0, x1 = xc - NOZ_HW - 0.02, xc + NOZ_HW + 0.02
    nx, nt = 15, 9
    xs = np.linspace(x0, x1, nx)
    rows_o, rows_i = [], []
    s0 = S_HINGE_U if upper else S_HINGE_L
    for k in range(nt):
        t = k / (nt - 1)
        ro, ri = [], []
        for x in xs:
            u = (x - xc) / (NOZ_HW + 0.02)             # -1 .. 1 across the flap
            if upper:
                ln = UF_LEN - 0.42 * abs(u) ** 1.0      # chevron pointing aft
            else:
                ln = LF_LEN - 0.20 * abs(u) ** 1.2
            s = s0 + t * ln
            if upper:
                zo = lerp(_deck_z(x) - 0.012, 0.215, t ** 0.9)
                zi = lerp(Z_HINGE_U, 0.195, t)
                zi = min(zi, zo - 0.014)
            else:
                zo = lerp(_belly_z(x) + 0.03, -0.30, t ** 0.9)
                zi = lerp(Z_HINGE_L, -0.285, t)
                zi = max(zi, zo + 0.014)
            ro.append((x, Y(s), zo))
            ri.append((x, Y(s), zi))
        rows_o.append(ro)
        rows_i.append(ri)
    Go, Gi = np.array(rows_o), np.array(rows_i)
    bm = bmesh.new()
    up = 1 if upper else -1
    grid_dir(bm, Go, Vector((0, 0, up)), mat=M_SKIN)         # outer skin (coated like the airframe)
    grid_dir(bm, Gi, Vector((0, 0, -up)))                    # channel side
    grid_dir(bm, np.stack([Go[-1], Gi[-1]]), Vector((0, -1, 0)))
    grid_dir(bm, np.stack([Go[:, 0], Gi[:, 0]]), Vector((-1, 0, 0)))
    grid_dir(bm, np.stack([Go[:, -1], Gi[:, -1]]), Vector((1, 0, 0)))
    grid_dir(bm, np.stack([Go[0], Gi[0]]), Vector((0, 1, 0)))
    G.weld(bm, 1e-6)
    G.smooth_sharp(bm, 30)
    return bm


def grid_dir(bm, A, want, mat=M_HOT):
    """Add a grid and flip it as a whole so that its mean normal points along `want`."""
    n0 = len(bm.faces)
    G.bm_grid(bm, A, mat=mat)
    bm.faces.ensure_lookup_table()
    fs = list(bm.faces)[n0:]
    tot = Vector((0, 0, 0))
    for f in fs:
        f.normal_update()
        tot += f.normal * f.calc_area()
    if tot.dot(want) < 0:
        for f in fs:
            f.normal_flip()
    return fs


def build_nozzle_static(sign):
    """Faceted sidewalls (inner + outer, pointed aft) for one nozzle; returns bmesh (hot metal)."""
    bm = bmesh.new()
    xc = sign * NOZ_XC
    for side in (-1, 1):
        xw = xc + side * (NOZ_HW + 0.035)
        s0, s1 = O.S_END - 0.05, 17.45 if side * sign > 0 else 17.25
        prof = [(s0, Z_HINGE_U + 0.10), (16.15, Z_HINGE_U + 0.0), (s1 - 0.5, 0.19), (s1, -0.02), (s1 - 0.5, -0.24),
                (16.15, Z_HINGE_L - 0.03), (s0, Z_HINGE_L - 0.12)]
        rows = []
        for dx, k in ((-0.045, 0.93), (0.0, 1.0), (0.045, 0.93)):
            rows.append([(xw + dx, Y(s), z * k) for (s, z) in prof])
        A = np.array(rows)
        n0 = len(bm.faces)
        G.bm_grid(bm, A, closed_v=True, mat=M_SKIN)
        cxw = xw
        for f in list(bm.faces)[n0:]:
            f.normal_update()
            c = f.calc_center_median()
            r = c - Vector((cxw, Y(16.3), -0.02))
            if f.normal.dot(r) < 0:
                f.normal_flip()
    G.weld(bm, 1e-6)
    return bm


def build_stinger():
    """Centre stinger between the nozzles (faceted, pointed)."""
    bm = bmesh.new()
    prof = [(O.S_END - 0.05, 0.40), (16.2, 0.30), (17.15, 0.14), (17.70, 0.0), (17.15, -0.15), (16.2, -0.33),
            (O.S_END - 0.05, -0.44)]
    rows = []
    for x in (-0.16, -0.10, 0.0, 0.10, 0.16):
        k = 1.0 if abs(x) < 0.12 else 0.82
        rows.append([(x * (0.25 if s > 17.5 else 1.0), Y(s), z * k) for (s, z) in prof])
    A = np.array(rows)
    G.bm_grid(bm, A, closed_v=True, mat=M_SKIN)
    G.weld(bm, 1e-6)
    _orient_convex(bm, lambda c: Vector((0, Y(16.4), -0.02)))
    return bm
