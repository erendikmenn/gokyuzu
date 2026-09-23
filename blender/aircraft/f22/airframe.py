"""F-22A exterior geometry: fuselage, inlets, canopy, wings, tails, nozzles (Blender objects)."""
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


def V3(x, s, z):
    return (x, Y(s), z)


def grid_from_profiles(rows_s, prof_fn, mirror=False):
    """rows_s: (nrows, ncols) array of stations per (row, col) or 1-D list (same for all columns)."""
    rows_s = np.asarray(rows_s, float)
    out = []
    if rows_s.ndim == 1:
        for s in rows_s:
            pr = prof_fn(s)
            out.append([(p[0] * (-1 if mirror else 1), Y(s), p[1]) for p in pr])
        return np.array(out)
    nr, nc = rows_s.shape
    for i in range(nr):
        row = []
        cache = {}
        for j in range(nc):
            s = rows_s[i, j]
            key = round(s, 9)
            if key not in cache:
                cache[key] = prof_fn(s)
            p = cache[key][j]
            row.append((p[0] * (-1 if mirror else 1), Y(s), p[1]))
        out.append(row)
    return np.array(out)


# ==============================================================================================
# fuselage skin
# ==============================================================================================
class Fuselage:
    def __init__(self):
        self.g = S.global_stations()
        g = self.g
        # upper skin: global stations, all columns
        self.up_cols = len(S.upper_profile(1.0))
        # forebody lower: rows = global stations <= S_TI mapped to per-column end stations
        gf = g[g <= S.S_TI + 1e-9]
        self.nf_cols = len(S.fore_lower_profile(1.0))
        j_bi = sum(S.FORE_NSUB[:3])
        s_end = np.array([lerp(S.S_TI, S.S_BI, min(j, j_bi) / j_bi) for j in range(self.nf_cols)])
        t = gf / S.S_TI
        self.fore_s = np.outer(t, s_end)
        self.fore_j_bi = j_bi
        # nacelle lower
        ga = g[g >= S.S_TO - 1e-9]
        self.na_cols = len(S.nac_lower_profile(10.0))
        j_lo = sum(S.NAC_NSUB[:2])
        j_bi2 = sum(S.NAC_NSUB[:4])
        self.nac_j_lo, self.nac_j_bi = j_lo, j_bi2
        s_lip = []
        for j in range(self.na_cols):
            if j <= j_lo:
                s_lip.append(lerp(S.S_TO, S.S_BO, j / j_lo))
            elif j <= j_bi2:
                s_lip.append(lerp(S.S_BO, S.S_BI, (j - j_lo) / (j_bi2 - j_lo)))
            else:
                s_lip.append(S.S_BI)
        s_lip = np.array(s_lip)
        tau = (ga - S.S_TO) / (S.S_END - S.S_TO)
        self.nac_s = s_lip[None, :] + np.outer(tau, S.S_END - s_lip)

    def build(self):
        bm = bmesh.new()
        self.parts = {}
        for side, mir in (('R', False), ('L', True)):
            Gu = grid_from_profiles(self.g, S.upper_profile, mir)
            Gf = grid_from_profiles(self.fore_s, S.fore_lower_profile, mir)
            Gn = grid_from_profiles(self.nac_s, S.nac_lower_profile, mir)
            self.parts[side] = (Gu, Gf, Gn)
            G.bm_grid(bm, Gu, flip=mir)
            G.bm_grid(bm, Gf, flip=not mir)
            G.bm_grid(bm, Gn, flip=not mir)
        G.weld(bm, 2e-4)
        # consistent outward orientation (reference: away from a longitudinal axis)
        def ref(c):
            s = Y(0) - c.y
            zc = 0.5 * (S.z_top(min(max(s, 0), 17.1)) + S.z_belly(min(max(s, 0), 17.1)))
            return Vector((c.x, 0, c.z - zc))
        G.orient_faces(bm, ref)
        return bm

    def inlet_loop(self, side='R'):
        """Closed loop of the inlet lip (TI -> TO -> BO -> BI -> TI), world coordinates."""
        Gu, Gf, Gn = self.parts[side]
        g = self.g
        top = [Gu[i, -1] for i in range(len(g)) if S.S_TI - 1e-6 <= g[i] <= S.S_TO + 1e-6]
        outer = [Gn[0, j] for j in range(self.nac_j_bi + 1)]
        inner = [Gf[-1, j] for j in range(self.fore_j_bi, -1, -1)]
        loop = top + outer[1:] + inner[1:-1]
        return np.array(loop)


def build_duct(fus, side, mat_index=0):
    """Inlet duct: from the lip loop into the fuselage, ending at the (hidden) engine face."""
    loop = fus.inlet_loop(side)
    sign = -1 if side == 'L' else 1
    n = len(loop)
    ts = G.arc_params(np.vstack([loop, loop[:1]]))[:-1]
    # engine face ring: rounded square centred at (0.66, -0.34) at s = 9.4
    ef_c = np.array([0.62 * sign, Y(10.6), -0.22])
    ring = []
    for t in ts:
        a = 2 * math.pi * t + math.pi * 0.75
        # superellipse
        ca, sa = math.cos(a), math.sin(a)
        e = 0.6
        rx = 0.47 * math.copysign(abs(ca) ** e, ca)
        rz = 0.47 * math.copysign(abs(sa) ** e, sa)
        ring.append(ef_c + np.array([rx * sign, 0, rz]))
    ring = np.array(ring)
    # align ring phase to the loop: rotate ring index to minimise distance
    best, bi = 1e9, 0
    for k in range(n):
        d = np.sum(np.linalg.norm((np.roll(ring, k, axis=0) - loop)[:, [0, 2]], axis=1))
        if d < best:
            best, bi = d, k
    ring = np.roll(ring, bi, axis=0)
    cen = loop.mean(axis=0)
    rows = [loop]
    # lip inset ring
    inset = loop + (cen - loop) * 0.035 + np.array([0, -0.04, 0])
    rows.append(inset)
    nsteps = 16
    for k in range(1, nsteps + 1):
        t = k / nsteps
        tt = t * t * (3 - 2 * t)
        r = inset + (ring - inset) * tt
        r = r + np.array([0.16 * sign, 0.0, -0.10]) * math.sin(math.pi * t) ** 1.5
        rows.append(r)
    Gd = np.array(rows)
    bm = bmesh.new()
    G.bm_grid(bm, Gd, closed_v=True)
    # engine face cap (dark)
    G.bm_fan(bm, ef_c, list(ring) + [ring[0]], mat=1)
    # orient: duct faces must point inward (towards the duct axis)
    def ref(c):
        s = Y(0) - c.y
        t = min(1, max(0, (s - 5.3) / 5.3))
        ax = cen + (ef_c - cen) * t
        return Vector((ax[0] - c.x, ax[1] - c.y, ax[2] - c.z))
    G.orient_faces(bm, ref, [f for f in bm.faces if f.material_index == 0])
    for f in bm.faces:
        if f.material_index == 1 and f.normal.y < 0:
            f.normal_flip()
    return bm


# ==============================================================================================
# canopy (glass) + turtle deck
# ==============================================================================================
def canopy_section(s, n_half=14):
    xs, zs, zt = S.can_x(s), S.can_zs(s), S.can_zt(s)
    h = zt - zs
    keys = [np.array([xs, zs]), np.array([xs * 1.045, zs + 0.28 * h]), np.array([xs * 0.78, zs + 0.8 * h]),
            np.array([0.0, zt])]
    tan = [(0.12, 1.0), None, None, (-1.0, 0.0)]
    pts = chain(keys, [6, 8, 8], tan=tan)
    return pts   # sill -> top (right half)


def build_canopy():
    ss = np.concatenate([[S.S_CAN0], G.cosine_space(S.S_CAN0, S.S_CAN1, 72)[1:-1], [S.S_CAN1]])
    rows = []
    for s in ss:
        half = canopy_section(s)
        full = [(-p[0], Y(s), p[1]) for p in half] + [(p[0], Y(s), p[1]) for p in half[::-1][1:]]
        rows.append(full)
    Gc = np.array(rows)
    bm = bmesh.new()
    V = G.bm_grid(bm, Gc)
    G.weld(bm, 1e-5)
    G.orient_faces(bm, lambda c: Vector((c.x, 0, c.z - 0.3)))
    # frame band: faces touching the sill rows -> material 1
    ncol = Gc.shape[1]
    return bm


def build_canopy_frame():
    """Metal frame band along the canopy sill (sits on the fuselage, part of the canopy object)."""
    ss = np.concatenate([[S.S_CAN0 + 0.005], G.cosine_space(S.S_CAN0 + 0.005, S.S_CAN1 - 0.005, 72)[1:-1],
                         [S.S_CAN1 - 0.005]])
    bm = bmesh.new()
    for sign in (1, -1):
        rows = []
        for s in ss:
            xs, zs, zt = S.can_x(s), S.can_zs(s), S.can_zt(s)
            h = zt - zs
            w = min(0.06, 0.25 * h + 0.005)
            p0 = (sign * (xs + 0.012), Y(s), zs - 0.004)
            p1 = (sign * (xs * 1.0 + 0.016), Y(s), zs + w * 0.5)
            p2 = (sign * (xs * 1.012 + 0.004), Y(s), zs + w)
            rows.append([p0, p1, p2])
        Gf = np.array(rows)
        G.bm_grid(bm, Gf, flip=(sign < 0))
    G.orient_faces(bm, lambda c: Vector((c.x, 0, 0.3)))
    return bm


def build_turtle_deck():
    """Deck under the aft canopy (behind the seat bulkhead)."""
    ss = np.linspace(5.27, S.S_CAN1 - 0.02, 14)
    rows = []
    for s in ss:
        xs, zs, zt = S.can_x(s), S.can_zs(s), S.can_zt(s)
        top = zs + max(0.0, (zt - zs) * lerp(0.28, 0.9, smoothstep(5.6, 7.4, s)))
        n = 10
        row = []
        for k in range(n + 1):
            u = -1 + 2 * k / n
            x = u * xs * 0.99
            z = zs + (top - zs) * (1 - u * u) ** 0.35
            row.append((x, Y(s), z - 0.005))
        rows.append(row)
    bm = bmesh.new()
    G.bm_grid(bm, np.array(rows))
    G.weld(bm, 1e-5)
    G.orient_faces(bm, lambda c: Vector((0, 0, 1)))
    # front bulkhead
    s = 5.62
    xs, zs, zt = S.can_x(s), S.can_zs(s), S.can_zt(s)
    return bm


# ==============================================================================================
# wing
# ==============================================================================================
X_FLAP0, X_FLAP1 = 2.23, 4.55
X_AIL0, X_AIL1 = 4.59, 5.85
X_LEF0 = 2.22


def wing_x_stations():
    xs = [S.X_ROOT, X_LEF0, X_FLAP0]
    xs += list(np.linspace(X_FLAP0, X_FLAP1, 18)[1:])
    xs += [X_AIL0]
    xs += list(np.linspace(X_AIL0, X_AIL1, 13)[1:])
    xs += list(np.linspace(X_AIL1, S.X_CLIP, 3)[1:]) + list(np.linspace(S.X_CLIP, S.X_TIP, 4)[1:])
    return np.array(sorted(set(round(v, 6) for v in xs)))


def wing_grid(xs, vs, upper, sign=1):
    out = np.zeros((len(xs), len(vs), 3))
    for i, x in enumerate(xs):
        for j, v in enumerate(vs):
            p = S.wing_pt(x, v, upper)
            out[i, j] = (p[0] * sign, Y(p[1]), p[2])
    return out


def wing_region_bm(x0, x1, v0, v1, sign, close_front=False, close_back=False, close_in=False, close_out=False,
                   mat=0):
    xs_all = wing_x_stations()
    xs = [x for x in xs_all if x0 - 1e-9 <= x <= x1 + 1e-9]
    if xs[0] > x0 + 1e-6:
        xs = [x0] + xs
    if xs[-1] < x1 - 1e-6:
        xs = xs + [x1]
    vs = [v for v in S.WING_V if v0 - 1e-9 <= v <= v1 + 1e-9]
    xs, vs = np.array(xs), np.array(vs)
    U = wing_grid(xs, vs, True, sign)
    L = wing_grid(xs, vs, False, sign)
    bm = bmesh.new()
    G.bm_grid(bm, U, mat=mat)
    G.bm_grid(bm, L, mat=mat)
    # closures (planar quads between upper and lower edges)
    def strip(a, b):
        Gs = np.stack([a, b], axis=0)
        G.bm_grid(bm, Gs, mat=mat)
    if close_front:
        strip(U[:, 0], L[:, 0])
    if close_back:
        strip(U[:, -1], L[:, -1])
    if close_in:
        strip(U[0, :], L[0, :])
    if close_out:
        strip(U[-1, :], L[-1, :])
    G.weld(bm, 1e-6)
    zc_fn = lambda x: S.w_zc(abs(x))

    def ref(c):
        x = abs(c.x)
        s = Y(0) - c.y
        le, te = S.w_le(x), S.w_te(x)
        v = (s - le) / max(te - le, 1e-6)
        zc = S.w_zc(x)
        d = Vector((0, 0, c.z - zc))
        if v < 0.02:
            d += Vector((0, 1, 0)) * 0.05
        if v > 0.985:
            d += Vector((0, -1, 0)) * 0.05
        if x > S.X_TIP - 0.01:
            d += Vector((sign, 0, 0)) * 0.05
        if d.length < 1e-6:
            return None
        return d
    G.orient_faces(bm, ref)
    return bm


def hinge_line(x0, x1, v, sign):
    """Hinge points (on the chord/camber plane) at chord fraction v between spans x0..x1."""
    pa = S.wing_pt(x0, v, True)
    pb = S.wing_pt(x0, v, False)
    pc = S.wing_pt(x1, v, True)
    pd = S.wing_pt(x1, v, False)
    a = (pa + pb) / 2
    b = (pc + pd) / 2
    A = Vector((a[0] * sign, Y(a[1]), a[2]))
    B = Vector((b[0] * sign, Y(b[1]), b[2]))
    return A, B


def build_wing(sign, mats):
    """Returns dict name -> object for one side (sign +1 right, -1 left)."""
    sfx = 'R' if sign > 0 else 'L'
    objs = {}
    # fixed structure pieces
    fixed = bmesh.new()
    G.join_bm(fixed, wing_region_bm(S.X_ROOT, S.X_TIP, S.V_LEF, S.V_HINGE, sign, close_front=True,
                                    close_back=True, close_out=True))
    G.join_bm(fixed, wing_region_bm(S.X_ROOT, X_FLAP0, S.V_HINGE, 1.0, sign, close_out=True))
    G.join_bm(fixed, wing_region_bm(X_FLAP1, X_AIL0, S.V_HINGE, 1.0, sign, close_in=True, close_out=True))
    G.join_bm(fixed, wing_region_bm(X_AIL1, S.X_TIP, S.V_HINGE, 1.0, sign, close_in=True, close_out=True))
    G.join_bm(fixed, wing_region_bm(S.X_ROOT, X_LEF0, 0.0, S.V_LEF, sign, close_out=True))
    objs['fixed'] = fixed
    # control surfaces (pivot on hinge, local X along the hinge, pointing to +X world)
    def surf(name, x0, x1, v0, v1, hv):
        bm = wing_region_bm(x0, x1, v0, v1, sign, close_front=(v0 > 0), close_back=(v1 < 1), close_in=True,
                            close_out=True)
        A, B = hinge_line(x0, x1, hv, sign)
        axis = (B - A) if sign > 0 else (A - B)
        ob = G.pivot_object(name, bm, A if sign > 0 else B, axis, (0, 0, 1), materials=mats)
        return ob
    objs['lef'] = surf(f'ctl_lef_{sfx}', X_LEF0, S.X_TIP, 0.0, S.V_LEF, S.V_LEF)
    objs['flaperon'] = surf(f'ctl_flaperon_{sfx}', X_FLAP0, X_FLAP1, S.V_HINGE, 1.0, S.V_HINGE)
    objs['aileron'] = surf(f'ctl_aileron_{sfx}', X_AIL0, X_AIL1, S.V_HINGE, 1.0, S.V_HINGE)
    return objs
