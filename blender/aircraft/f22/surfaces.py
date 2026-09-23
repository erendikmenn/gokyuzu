"""F-22A lifting surfaces: wings (LEF, flaperons, ailerons), canted fins (rudders), all-moving stabilators.

Planform from the Lockheed 3-view (oml.py).  Control surfaces are separate objects pivoting on their hinge lines
(local X along the hinge, pointing to world +X for both sides, rotation 0 = neutral) - CONTRACTS-SF.md 5.1.
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

M_SKIN = 0

# ============================================================================================ wing
X_WROOT = 1.90                  # inboard end of the wing box (buried in the fuselage)
X_LEF0 = 2.34                   # inboard end of the leading-edge flap


def v_lef(x):
    return min(0.30, O.LEF_W / O.w_chord(x))


def v_hinge(x):
    return O.hinge_v_flaperon(x) if x < 4.52 else O.hinge_v_aileron(x)


def wing_vs(x, v0, v1, n):
    """n+1 chord fractions between v0 and v1, clustered towards the leading edge when v0 == 0."""
    t = np.linspace(0, 1, n + 1)
    if v0 <= 1e-9:
        t = 1 - np.cos(t * math.pi / 2)
        t = t ** 1.25
    return v0 + (v1 - v0) * t


def wing_x_stations(x0, x1):
    xs = [X_WROOT, X_LEF0, O.FLAPERON_X[0], O.FLAPERON_X[1], 4.52, O.AILERON_X[0], O.AILERON_X[1],
          O.W_CLIP[1], O.X_TIP]
    xs += list(np.linspace(X_WROOT, O.X_TIP, 34))
    xs = sorted(set(round(v, 5) for v in xs))
    out = []
    for v in xs:
        if not out or v - out[-1] > 0.02 or v in (X_LEF0, O.FLAPERON_X[0], O.FLAPERON_X[1], 4.52, O.AILERON_X[0], O.AILERON_X[1], O.W_CLIP[1]):
            if out and v - out[-1] <= 0.02:
                out[-1] = v
            else:
                out.append(v)
    return [v for v in out if x0 - 1e-6 <= v <= x1 + 1e-6]


def wing_region(x0, x1, vfn0, vfn1, n, sign, closes=(), xs=None):
    """Upper + lower wing skin between span x0..x1 and chord fractions vfn0(x)..vfn1(x); closures optional."""
    xs = xs or wing_x_stations(x0, x1)
    if xs[0] > x0 + 1e-6:
        xs = [x0] + xs
    if xs[-1] < x1 - 1e-6:
        xs = xs + [x1]
    U, L = [], []
    for x in xs:
        vs = wing_vs(x, vfn0(x), vfn1(x), n)
        U.append([O.wing_pt(x, v, True) for v in vs])
        L.append([O.wing_pt(x, v, False) for v in vs])
    U = np.array(U)
    L = np.array(L)

    def w(A):
        B = A.copy()
        B[..., 0] *= sign
        B[..., 1] = Y(A[..., 1])
        return B
    U, L = w(U), w(L)
    bm = bmesh.new()
    G.bm_grid(bm, U, mat=M_SKIN)
    G.bm_grid(bm, L, mat=M_SKIN)
    if 'front' in closes:
        G.bm_grid(bm, np.stack([U[:, 0], L[:, 0]]))
    if 'back' in closes:
        G.bm_grid(bm, np.stack([U[:, -1], L[:, -1]]))
    if 'in' in closes:
        G.bm_grid(bm, np.stack([U[0], L[0]]))
    if 'out' in closes:
        G.bm_grid(bm, np.stack([U[-1], L[-1]]))
    G.weld(bm, 1e-6)

    def ref(c):
        x = abs(c.x)
        s = Y(0) - c.y
        le, te = O.w_le(x), O.w_te(x)
        v = (s - le) / max(te - le, 1e-6)
        d = Vector((0, 0, c.z - O.w_zc(min(max(x, O.X_ROOT), O.X_TIP))))
        if v < vfn0(x) + 0.01 and 'front' in closes:
            d += Vector((0, 0.05, 0))
        if v > vfn1(x) - 0.01 and 'back' in closes:
            d += Vector((0, -0.05, 0))
        if 'out' in closes and x > x1 - 0.004:
            d += Vector((sign * 0.05, 0, 0))
        if 'in' in closes and x < x0 + 0.004:
            d += Vector((-sign * 0.05, 0, 0))
        return d if d.length > 1e-8 else None
    G.orient_faces(bm, ref)
    return bm


def hinge_pts(x0, x1, vfn, sign):
    a = (O.wing_pt(x0, vfn(x0), True) + O.wing_pt(x0, vfn(x0), False)) / 2
    b = (O.wing_pt(x1, vfn(x1), True) + O.wing_pt(x1, vfn(x1), False)) / 2
    A = Vector((a[0] * sign, Y(a[1]), a[2]))
    B = Vector((b[0] * sign, Y(b[1]), b[2]))
    return A, B


def build_wing(sign, mats):
    """Returns {'fixed': bmesh, 'lef': obj, 'flaperon': obj, 'aileron': obj}."""
    sfx = 'R' if sign > 0 else 'L'
    zero = lambda x: 0.0
    one = lambda x: 1.0
    fixed = bmesh.new()
    # wing box between the LEF hinge and the TE hinges (two pieces: flaperon / aileron hinge lines)
    for (x0, x1) in ((X_WROOT, 4.52), (4.52, O.X_TIP)):
        G.join_bm(fixed, wing_region(x0, x1, v_lef, v_hinge, 22, sign,
                                     ('front', 'back', 'out', 'in') if x0 > 2 else ('back', 'out')))
    # fixed leading edge inboard of the LEF
    G.join_bm(fixed, wing_region(X_WROOT, X_LEF0, zero, v_lef, 10, sign, ('out',)))
    # fixed trailing-edge pieces
    for (x0, x1, cl) in ((X_WROOT, O.FLAPERON_X[0], ('out',)), (O.FLAPERON_X[1], O.AILERON_X[0], ('in', 'out')),
                         (O.AILERON_X[1], O.X_TIP, ('in', 'out'))):
        G.join_bm(fixed, wing_region(x0, x1, v_hinge, one, 6, sign, cl))
    G.weld(fixed, 1e-5)
    out = {'fixed': fixed}

    def surf(name, x0, x1, v0fn, v1fn, hfn, n, closes):
        bm = wing_region(x0, x1, v0fn, v1fn, n, sign, closes)
        A, B = hinge_pts(x0, x1, hfn, sign)
        axis = (B - A) if sign > 0 else (A - B)
        return G.pivot_object(name, bm, A if sign > 0 else B, axis, (0, 0, 1), materials=mats)
    out['lef'] = surf(f'ctl_lef_{sfx}', X_LEF0 + 0.01, O.X_TIP, zero, v_lef, v_lef, 10, ('back', 'in', 'out'))
    out['flaperon'] = surf(f'ctl_flaperon_{sfx}', O.FLAPERON_X[0] + 0.01, O.FLAPERON_X[1] - 0.01, v_hinge, one, v_hinge,
                           7, ('front', 'in', 'out'))
    out['aileron'] = surf(f'ctl_aileron_{sfx}', O.AILERON_X[0] + 0.01, O.AILERON_X[1] - 0.01, v_hinge, one, v_hinge, 7,
                          ('front', 'in', 'out'))
    return out


# ============================================================================================ vertical tails
FIN_CANT = math.radians(28.0)
FIN_X0, FIN_Z0 = 1.51, 0.19          # root reference (h = 0)
FIN_LE0, FIN_TE0 = 13.01, 17.19      # root chord at h = 0
FIN_LE1, FIN_TE1 = 14.40, 15.76      # tip chord
FIN_H = (2.97 - FIN_Z0) / math.cos(FIN_CANT)     # span along the cant (tip 5.08 m above the ground)
FIN_TC = 0.045
RUD_H0, RUD_H1 = 0.32, 2.88          # rudder span (along the cant)
RUD_S0, RUD_S1 = 16.46, 15.46        # hinge stations at RUD_H0 / RUD_H1


def fin_frame(sign):
    d = Vector((sign * math.sin(FIN_CANT), 0, math.cos(FIN_CANT)))      # span direction
    n = Vector((sign * math.cos(FIN_CANT), 0, -math.sin(FIN_CANT)))     # outboard normal
    return d, n


def fin_le(h):
    return lerp(FIN_LE0, FIN_LE1, h / FIN_H)


def fin_te(h):
    return lerp(FIN_TE0, FIN_TE1, h / FIN_H)


def rud_v(h):
    s = lerp(RUD_S0, RUD_S1, (h - RUD_H0) / (RUD_H1 - RUD_H0))
    return (s - fin_le(h)) / (fin_te(h) - fin_le(h))


def fin_pt(h, v, outer, sign):
    d, n = fin_frame(sign)
    le, te = fin_le(h), fin_te(h)
    c = te - le
    s = le + v * c
    t = O.airfoil_half(v, FIN_TC * lerp(1.0, 0.8, max(0.0, h) / FIN_H)) * c
    base = Vector((sign * FIN_X0, Y(s), FIN_Z0)) + d * h
    return base + n * (t if outer else -t)


def fin_region(h0, h1, vf0, vf1, sign, nh, nv, closes=()):
    hs = np.linspace(h0, h1, nh)
    O_, I_ = [], []
    for h in hs:
        vs = wing_vs(0, vf0(h), vf1(h), nv)
        O_.append([tuple(fin_pt(h, v, True, sign)) for v in vs])
        I_.append([tuple(fin_pt(h, v, False, sign)) for v in vs])
    O_, I_ = np.array(O_), np.array(I_)
    bm = bmesh.new()
    G.bm_grid(bm, O_)
    G.bm_grid(bm, I_)
    if 'front' in closes:
        G.bm_grid(bm, np.stack([O_[:, 0], I_[:, 0]]))
    if 'back' in closes:
        G.bm_grid(bm, np.stack([O_[:, -1], I_[:, -1]]))
    if 'bottom' in closes:
        G.bm_grid(bm, np.stack([O_[0], I_[0]]))
    if 'top' in closes:
        G.bm_grid(bm, np.stack([O_[-1], I_[-1]]))
    G.weld(bm, 1e-6)
    d, n = fin_frame(sign)

    def ref(c):
        base = Vector((sign * FIN_X0, c.y, FIN_Z0))
        rel = c - base
        h = rel.dot(d)
        off = rel.dot(n)
        s = Y(0) - c.y
        v = (s - fin_le(h)) / max(fin_te(h) - fin_le(h), 1e-6)
        r = n * off
        if 'front' in closes and v < vf0(h) + 0.01:
            r += Vector((0, 0.02, 0))
        if 'back' in closes and v > vf1(h) - 0.01:
            r += Vector((0, -0.02, 0))
        if 'top' in closes and h > h1 - 0.005:
            r += d * 0.05
        if 'bottom' in closes and h < h0 + 0.005:
            r -= d * 0.05
        return r if r.length > 1e-8 else None
    G.orient_faces(bm, ref)
    return bm


def build_fin(sign, mats):
    sfx = 'R' if sign > 0 else 'L'
    zero, one = (lambda h: 0.0), (lambda h: 1.0)
    fixed = bmesh.new()
    G.join_bm(fixed, fin_region(-0.35, RUD_H0, zero, one, sign, 4, 24, ('bottom',)))
    G.join_bm(fixed, fin_region(RUD_H0, RUD_H1, zero, rud_v, sign, 16, 22, ('back',)))
    G.join_bm(fixed, fin_region(RUD_H1, FIN_H, zero, one, sign, 4, 24, ('top',)))
    G.weld(fixed, 1e-5)
    bm = fin_region(RUD_H0 + 0.008, RUD_H1 - 0.008, rud_v, one, sign, 16, 6, ('front', 'top', 'bottom'))
    a = (fin_pt(RUD_H0, rud_v(RUD_H0), True, sign) + fin_pt(RUD_H0, rud_v(RUD_H0), False, sign)) / 2
    b = (fin_pt(RUD_H1, rud_v(RUD_H1), True, sign) + fin_pt(RUD_H1, rud_v(RUD_H1), False, sign)) / 2
    d, n = fin_frame(sign)
    rud = G.pivot_object(f'ctl_rudder_{sfx}', bm, a, b - a, n * sign, materials=mats)
    return fixed, rud


# ============================================================================================ stabilators
STAB_X0, STAB_X1 = 1.72, 4.44
STAB_Z = 0.0
STAB_TC = 0.036
STAB_PIVOT_S = 16.62
STAB_XK = 2.81               # TE apex span (the notched trailing edge)


def stab_le(x):
    le = 15.83 + (x - 3.03) * 0.936
    if x > O.X_ROOT - 0.3:
        le = max(le, O.w_te(max(x, O.X_ROOT)) + 0.14)
    return le


def stab_te(x):
    if x >= STAB_XK:
        return 18.91 - (x - STAB_XK) * 0.294
    return 18.91 - (STAB_XK - x) * 0.877


def stab_pt(x, v, upper):
    le, te = stab_le(x), stab_te(x)
    c = te - le
    s = le + v * c
    t = O.airfoil_half(v, STAB_TC) * c
    return np.array([x, s, STAB_Z + (t if upper else -t)])


def build_stab(sign, mats):
    sfx = 'R' if sign > 0 else 'L'
    xs = sorted(set([round(v, 5) for v in list(np.linspace(STAB_X0, STAB_XK, 12)) +
                     list(np.linspace(STAB_XK, STAB_X1, 12))]))
    U, L = [], []
    for x in xs:
        vs = wing_vs(0, 0.0, 1.0, 26)
        U.append([(sign * p[0], Y(p[1]), p[2]) for p in (stab_pt(x, v, True) for v in vs)])
        L.append([(sign * p[0], Y(p[1]), p[2]) for p in (stab_pt(x, v, False) for v in vs)])
    U, L = np.array(U), np.array(L)
    bm = bmesh.new()
    G.bm_grid(bm, U)
    G.bm_grid(bm, L)
    G.bm_grid(bm, np.stack([U[0], L[0]]))
    G.bm_grid(bm, np.stack([U[-1], L[-1]]))
    G.weld(bm, 1e-6)

    def ref(c):
        x = abs(c.x)
        r = Vector((0, 0, c.z - STAB_Z))
        s = Y(0) - c.y
        v = (s - stab_le(x)) / max(stab_te(x) - stab_le(x), 1e-6)
        if v < 0.01:
            r += Vector((0, 0.02, 0))
        if v > 0.99:
            r += Vector((0, -0.02, 0))
        if x > STAB_X1 - 0.004:
            r += Vector((sign * 0.05, 0, 0))
        if x < STAB_X0 + 0.004:
            r += Vector((-sign * 0.05, 0, 0))
        return r if r.length > 1e-8 else None
    G.orient_faces(bm, ref)
    pivot = (sign * STAB_X0, Y(STAB_PIVOT_S), STAB_Z)
    return G.pivot_object(f'ctl_stabilator_{sfx}', bm, pivot, (1, 0, 0), (0, 0, 1), materials=mats)
