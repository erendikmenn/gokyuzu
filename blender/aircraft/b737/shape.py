"""Boeing 737-800 analytic shape definitions (pure numpy, no bpy).

Shared by the Blender builder (geometry + UVs) and the texture painter (per-texel 3D evaluation),
so the livery lines up exactly with the geometry.

Ground frame used here ("G"): X = station aft of the nose tip (m), Y = right (m), Z = height above
ground with the gear down at static load (m). Blender frame: to_b() -> origin at the CG,
nose +Y, up +Z, right wing +X (CONTRACTS-SF.md §1).
"""
import math
import numpy as np

# ---------------------------------------------------------------- global dimensions
LENGTH = 39.47          # overall length (nose tip .. APU exhaust)
SPAN = 35.79            # with blended winglets
HEIGHT = 12.55          # fin tip above ground
X_CG, Z_CG = 17.9, 2.9  # CG (≈ 30 % MAC), origin of the model
FLOOR_Z = 2.65          # cabin / flight-deck floor (door sill)
D2R = math.pi / 180.0
Q = 1.0                 # geometric resolution factor (1 = full model, ~0.4 = LOD)


def qn(n, minimum):
    return max(minimum, int(round(n * Q)))


def to_b(X, Y, Z):
    """Ground frame -> Blender local coordinates (numpy arrays or scalars)."""
    X, Y, Z = np.broadcast_arrays(np.asarray(X, float), np.asarray(Y, float), np.asarray(Z, float))
    return np.stack([Y, X_CG - X, Z - Z_CG], axis=-1)


def from_b(P):
    P = np.asarray(P, float)
    return X_CG - P[..., 1], P[..., 0], P[..., 2] + Z_CG


# ---------------------------------------------------------------- monotone cubic interpolation
class Pchip:
    def __init__(self, pts):
        pts = np.asarray(pts, float)
        self.x, self.y = pts[:, 0], pts[:, 1]
        x, y = self.x, self.y
        h = np.diff(x)
        d = np.diff(y) / h
        n = len(x)
        m = np.zeros(n)
        for k in range(1, n - 1):
            if d[k - 1] * d[k] <= 0:
                m[k] = 0.0
            else:
                w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
                m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])

        def end(h0, h1, d0, d1):
            mm = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
            if np.sign(mm) != np.sign(d0):
                mm = 0.0
            elif np.sign(d0) != np.sign(d1) and abs(mm) > abs(3 * d0):
                mm = 3 * d0
            return mm
        if n > 2:
            m[0] = end(h[0], h[1], d[0], d[1])
            m[-1] = end(h[-1], h[-2], d[-1], d[-2])
        else:
            m[:] = d[0]
        self.h, self.m = h, m

    def __call__(self, xq):
        xq = np.clip(np.asarray(xq, float), self.x[0], self.x[-1])
        i = np.clip(np.searchsorted(self.x, xq, side='right') - 1, 0, len(self.x) - 2)
        h = self.h[i]
        t = (xq - self.x[i]) / h
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * self.y[i] + (t3 - 2 * t2 + t) * h * self.m[i]
                + (-2 * t3 + 3 * t2) * self.y[i + 1] + (t3 - t2) * h * self.m[i + 1])


def lerp_pts(pts, x):
    pts = np.asarray(pts, float)
    return np.interp(x, pts[:, 0], pts[:, 1])


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ================================================================== FUSELAGE
# Cross-section: upper lobe = superellipse (half width hw, height zt-zm), lower lobe = superellipse
# (hw, zm-zb) + a wing-body fairing bulge. theta: 0 = top centreline, +pi/2 = right side, pi = bottom.
_HW = Pchip([(0, 0), (0.02, 0.115), (0.06, 0.20), (0.15, 0.315), (0.3, 0.445), (0.55, 0.60), (0.9, 0.775),
             (1.4, 0.975), (2.0, 1.185), (2.6, 1.38), (3.3, 1.56), (4.1, 1.71), (5.0, 1.81), (6.0, 1.865),
             (7.0, 1.88), (25.5, 1.88), (27.5, 1.845), (29.5, 1.75), (31.5, 1.59), (33.5, 1.37),
             (35.5, 1.09), (37.5, 0.74), (38.8, 0.46), (39.47, 0.235)])
_ZT = Pchip([(0, 2.78), (0.02, 2.865), (0.06, 2.925), (0.15, 2.995), (0.3, 3.07), (0.6, 3.18), (1.0, 3.305),
             (1.5, 3.44), (1.95, 3.56), (2.25, 3.66), (2.55, 3.95), (2.9, 4.29), (3.35, 4.58), (3.95, 4.81),
             (4.7, 4.98), (5.6, 5.10), (6.6, 5.165), (7.6, 5.18), (27.0, 5.18), (29.0, 5.14), (31.0, 5.06),
             (33.0, 4.95), (35.0, 4.83), (37.0, 4.68), (38.5, 4.54), (39.47, 4.35)])
_ZB = Pchip([(0, 2.78), (0.02, 2.695), (0.06, 2.635), (0.15, 2.56), (0.3, 2.47), (0.6, 2.335), (1.0, 2.18),
             (1.6, 1.97), (2.4, 1.71), (3.3, 1.49), (4.3, 1.33), (5.3, 1.235), (6.3, 1.185), (7.3, 1.17),
             (25.3, 1.17), (26.8, 1.21), (28.3, 1.33), (30.0, 1.57), (32.0, 1.96), (34.0, 2.42), (36.0, 2.93),
             (38.0, 3.47), (39.47, 3.87)])
_ZM = Pchip([(0, 2.78), (1.0, 2.93), (2.0, 3.06), (3.0, 3.16), (4.0, 3.235), (5.0, 3.28), (6.2, 3.30),
             (26.0, 3.30), (28.0, 3.35), (30.0, 3.47), (32.0, 3.63), (34.0, 3.79), (36.0, 3.93),
             (38.0, 4.05), (39.47, 4.11)])
# wing-body fairing bulge (lateral, lower lobe) and upper-lobe exponent (windshield "peak")
_BULGE = Pchip([(0, 0), (10.0, 0), (11.5, 0.05), (13.0, 0.17), (14.5, 0.27), (16.0, 0.31), (19.5, 0.31),
                (21.0, 0.27), (22.5, 0.17), (24.0, 0.06), (25.5, 0), (40, 0)])
# windshield region: the crown is pinched towards a ridge (the two flat front panels meet at a centre post)
_PEAK = Pchip([(0, 0.0), (1.2, 0.0), (2.1, 0.20), (3.3, 0.20), (4.6, 0.04), (5.6, 0.0), (40, 0.0)])


def fus_profiles(X):
    X = np.asarray(X, float)
    bul = _BULGE(X)
    return dict(hw=_HW(X), zt=_ZT(X), zb=_ZB(X) - 0.20 * bul, zm=_ZM(X), peak=_PEAK(X),
                nl=2.0 + 1.6 * bul, bul=bul)


def _section(p, c, s):
    """Section point from profile dict p (arrays broadcastable with c=cos(theta), s=sin(theta))."""
    up = c >= 0
    e_lo = 2.0 / p['nl']
    # upper lobe: ellipse with a smooth crown pinch (G1 at the widest line); lower lobe: superellipse >= 2
    cz = np.where(up, c, -np.abs(c) ** e_lo)
    cy_up = s * (1.0 - p['peak'] * c * c)
    cy_lo = np.sign(s) * np.abs(s) ** e_lo
    cy = np.where(up, cy_up, cy_lo)
    half_h = np.where(up, p['zt'] - p['zm'], p['zm'] - p['zb'])
    Z = p['zm'] + half_h * cz
    th = np.arctan2(s, c)
    phi = np.clip(np.abs(np.mod(th, 2 * np.pi) - np.pi), 0, np.pi / 2)   # 0 bottom .. pi/2 side
    bulge = np.where(up, 0.0, p['bul'] * np.sin(2 * phi) ** 1.4)
    Y = (p['hw'] + bulge) * cy
    return Y, Z


def fus_point(X, theta):
    """(Y, Z) on the fuselage surface at station X, angle theta (broadcasting)."""
    X, theta = np.broadcast_arrays(np.asarray(X, float), np.asarray(theta, float))
    p = fus_profiles(X)
    return _section(p, np.cos(theta), np.sin(theta))


def fus_point_grid(X1, th1):
    """Grid evaluation: X1 (W,), th1 (H,) -> Y, Z of shape (H, W) (profiles evaluated once per station)."""
    p = fus_profiles(np.asarray(X1, float))
    p = {k: v[None, :] for k, v in p.items()}
    th1 = np.asarray(th1, float)[:, None]
    return _section(p, np.cos(th1), np.sin(th1))


def fus_theta_at(X, Y_sign, Z):
    """Numerically invert fus_point for a given height on one side (for painting / placing items)."""
    th = np.linspace(0, np.pi, 721) if Y_sign > 0 else np.linspace(np.pi, 2 * np.pi, 721)
    _, z = fus_point(np.full_like(th, X), th)
    i = np.argmin(np.abs(z - Z))
    return th[i]


def fus_stations():
    """Station distribution: dense at the nose tip, windshield and tail cone."""
    xs = [0.0]
    x = 0.0
    while x < LENGTH - 1e-6:
        if x < 0.3:
            dx = 0.02 + 0.08 * x
        elif x < 5.5:
            dx = 0.075
        elif x < 26.0:
            dx = 0.30
        elif x < 37.5:
            dx = 0.18
        else:
            dx = 0.10
        x = min(LENGTH, x + dx / Q)
        xs.append(x)
    return np.array(xs)


N_THETA = 144   # vertices around the fuselage (full resolution)


def n_theta():
    return max(40, int(round(N_THETA * Q / 8)) * 8)


def fus_uv(X, theta):
    """UV (u along the length, v around; seam at the belly). v=0.5 top, 0.25 left side, 0.75 right side."""
    u = np.asarray(X, float) / LENGTH
    v = np.mod(np.asarray(theta, float) + np.pi, 2 * np.pi) / (2 * np.pi)
    return u, v


# ================================================================== WING (right wing; left = mirror)
W_XLE0 = 12.58                  # LE station at the centreline
W_ZLE0 = 2.02                   # LE height at the centreline
W_SWEEP_LE = 28.5 * D2R
W_DIHEDRAL = 6.0 * D2R
W_YKINK = 5.9
W_YA = 16.55                    # start of the winglet blend
W_R = 1.155                     # blend radius
W_PHI_END = 78.0 * D2R          # winglet cant (from horizontal)
W_LW = 1.617                    # straight winglet length
W_LA = W_YA / math.cos(W_DIHEDRAL)
W_LB = W_LA + W_R * (W_PHI_END - W_DIHEDRAL)
W_LEND = W_LB + W_LW
_K_MAIN = math.tan(W_SWEEP_LE) * math.cos(W_DIHEDRAL)
_K_WL = 1.40
_ZA = W_ZLE0 + W_YA * math.tan(W_DIHEDRAL)
_CA = (W_YA - W_R * math.sin(W_DIHEDRAL), _ZA + W_R * math.cos(W_DIHEDRAL))
_PB = (_CA[0] + W_R * math.sin(W_PHI_END), _CA[1] - W_R * math.cos(W_PHI_END))
_XA = W_XLE0 + _K_MAIN * W_LA
_XB = _XA + _K_MAIN * (W_LB - W_LA) + 0.5 * (_K_WL - _K_MAIN) * (W_LB - W_LA)


def wing_chord_Y(Y):
    return lerp_pts([(0, 7.89), (W_YKINK, 5.0), (17.16, 1.25)], Y)


C_A = float(wing_chord_Y(W_YA))


def wing_station(l):
    """Reference (LE) point, chord, t/c, twist (rad), bank (rad), camber for arc-length l (arrays)."""
    l = np.asarray(l, float)
    Y = np.empty_like(l); Z = np.empty_like(l); X = np.empty_like(l); phi = np.empty_like(l)
    c = np.empty_like(l); tc = np.empty_like(l)
    m0 = l <= W_LA
    m1 = (l > W_LA) & (l <= W_LB)
    m2 = l > W_LB
    # main
    Y[m0] = l[m0] * math.cos(W_DIHEDRAL)
    Z[m0] = W_ZLE0 + l[m0] * math.sin(W_DIHEDRAL)
    X[m0] = W_XLE0 + _K_MAIN * l[m0]
    phi[m0] = W_DIHEDRAL
    c[m0] = wing_chord_Y(Y[m0])
    tc[m0] = lerp_pts([(0, 0.155), (1.9, 0.148), (W_YKINK, 0.125), (W_YA, 0.105)], Y[m0])
    # blend arc
    s = l[m1] - W_LA
    ph = W_DIHEDRAL + s / W_R
    Y[m1] = _CA[0] + W_R * np.sin(ph)
    Z[m1] = _CA[1] - W_R * np.cos(ph)
    X[m1] = _XA + _K_MAIN * s + 0.5 * (_K_WL - _K_MAIN) * s * s / (W_LB - W_LA)
    phi[m1] = ph
    f = smoothstep(0, 1, s / (W_LB - W_LA))
    c[m1] = C_A + (1.05 - C_A) * f
    tc[m1] = 0.105 - 0.012 * f
    # winglet
    s = l[m2] - W_LB
    Y[m2] = _PB[0] + s * math.cos(W_PHI_END)
    Z[m2] = _PB[1] + s * math.sin(W_PHI_END)
    X[m2] = _XB + _K_WL * s
    phi[m2] = W_PHI_END
    c[m2] = 1.05 - (1.05 - 0.50) * (s / W_LW) ** 1.15
    tc[m2] = 0.093 - 0.01 * s / W_LW
    twist = lerp_pts([(0, 2.0), (W_LA * 0.36, 0.4), (W_LA, -1.0), (W_LEND, -1.5)], l) * D2R
    camber = lerp_pts([(0, 0.022), (W_LA, 0.016), (W_LB, 0.008), (W_LEND, 0.006)], l)
    return dict(X=X, Y=Y, Z=Z, phi=phi, c=c, tc=tc, twist=twist, camber=camber)


def airfoil(t, tc, camber, upper):
    """Unit-chord cambered airfoil: returns (x, y) for chord fraction t in [0,1]."""
    t = np.clip(np.asarray(t, float), 0.0, 1.0)
    yt = 5 * tc * (0.2969 * np.sqrt(t) - 0.1260 * t - 0.3516 * t ** 2 + 0.2843 * t ** 3 - 0.1015 * t ** 4)
    p = 0.48
    yc = np.where(t < p, camber / p ** 2 * (2 * p * t - t * t),
                  camber / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * t - t * t))
    # supercritical-ish: flatten the upper crest a little, add aft loading on the lower surface
    yc = yc + 0.25 * camber * np.sin(np.pi * t) ** 2 * (t - 0.35)
    return t, np.where(upper, yc + yt, yc - yt)


def wing_point(l, t, upper, st=None):
    """3D point (X, Y, Z) in the ground frame on the right wing surface."""
    st = st if st is not None else wing_station(l)
    x2, y2 = airfoil(t, st['tc'], st['camber'], upper)
    return section_to_3d(st, x2, y2)


def section_to_3d(st, x2, y2, pivot=0.35):
    """Unit-chord section coords (x2 aft, y2 'up' normal to chord) -> ground frame via twist and bank."""
    c = st['c']
    tw = st['twist']
    xs = (x2 - pivot) * c
    ys = y2 * c
    # twist: positive = LE up (rotate about the pivot)
    xr = xs * np.cos(tw) + ys * np.sin(tw)
    yr = -xs * np.sin(tw) + ys * np.cos(tw)
    xr = xr + pivot * c
    yr = yr + pivot * c * np.sin(tw)  # keep the LE on the reference line approximately
    ph = st['phi']
    X = st['X'] + xr
    Y = st['Y'] - yr * np.sin(ph)
    Z = st['Z'] + yr * np.cos(ph)
    return X, Y, Z


# airfoil surface arc-length (unit chord, typical 12 %) used for the wing UV chordwise coordinate
_T_ARC = np.linspace(0, 1, 2001) ** 2
_xa, _ya = airfoil(_T_ARC, 0.12, 0.018, True)
_ARC_UP = np.concatenate([[0], np.cumsum(np.hypot(np.diff(_xa), np.diff(_ya)))])
_xa, _ya = airfoil(_T_ARC, 0.12, 0.018, False)
_ARC_LO = np.concatenate([[0], np.cumsum(np.hypot(np.diff(_xa), np.diff(_ya)))])


def airfoil_arc(t, upper):
    return np.where(upper, np.interp(t, _T_ARC, _ARC_UP), np.interp(t, _T_ARC, _ARC_LO))


def airfoil_arc_inv(a, upper):
    return np.where(upper, np.interp(a, _ARC_UP, _T_ARC), np.interp(a, _ARC_LO, _T_ARC))


WING_UV_D = 8.3  # metres of surface distance mapped to half the V range


def wing_uv(l, t, upper, c):
    u = np.asarray(l, float) / W_LEND
    d = airfoil_arc(t, upper) * c
    v = 0.5 + np.where(upper, d, -d) / (2 * WING_UV_D)
    return u, v


# control-surface hinge line (station of the cut) as a function of Y on the main wing
# (Y, X_cut): inboard flap 1.9..5.9, outboard flap 5.9..12.5, aileron 12.55..16.1
W_CUT = [(0.0, 18.65), (1.95, 18.95), (W_YKINK, 19.00), (12.52, 20.95), (16.12, 22.05)]
W_TE_SURF = {
    'flap_1': (1.95, W_YKINK),
    'flap_2': (W_YKINK + 0.02, 12.50),
    'aileron': (12.54, 16.10),
}
W_SPOILERS = [(2.25, 5.15), (5.95, 7.28), (7.30, 8.63), (8.65, 9.98), (10.00, 11.30), (11.32, 12.45)]
W_SPOILER_CHORD = 0.62  # m ahead of the hinge line
W_SLATS = [(6.10, 8.70), (8.72, 11.32), (11.34, 13.94), (13.96, 16.45)]
W_SLAT_T = 0.14   # chord fraction covered by slats (upper)
W_KRUEGER = [(2.05, 3.25), (3.27, 4.40)]
ENGINE_Y = 4.90


def wing_xcut(Y):
    return lerp_pts(W_CUT, Y)


def wing_tcut(Y, st):
    return (wing_xcut(Y) - st['X']) / st['c']


def wing_l_of_Y(Y):
    return np.asarray(Y, float) / math.cos(W_DIHEDRAL)


# ================================================================== HORIZONTAL STABILIZER (right)
S_XLE0, S_ZLE0 = 33.30, 4.08
S_SWEEP_LE = 32.0 * D2R
S_DIHEDRAL = 7.0 * D2R
S_HALF = 7.175
S_ELEV = (1.10, 6.80)
S_CUT = [(0.0, 36.35), (1.10, 36.62), (6.80, 38.62), (S_HALF, 38.70)]


def stab_station(l):
    l = np.asarray(l, float)
    Y = l * math.cos(S_DIHEDRAL)
    tipf = smoothstep(S_HALF - 0.35, S_HALF, Y)
    c = lerp_pts([(0, 4.25), (S_HALF, 1.35)], Y) * (1 - 0.35 * tipf ** 2)
    X = S_XLE0 + Y * math.tan(S_SWEEP_LE) + 0.25 * 1.35 * 0.35 * tipf ** 2
    return dict(X=X, Y=Y, Z=S_ZLE0 + l * math.sin(S_DIHEDRAL), phi=np.full_like(l, S_DIHEDRAL), c=c,
                tc=lerp_pts([(0, 0.105), (S_HALF, 0.09)], Y), twist=np.zeros_like(l),
                camber=np.full_like(l, -0.008))


S_LEND = S_HALF / math.cos(S_DIHEDRAL)


def stab_xcut(Y):
    return lerp_pts(S_CUT, Y)


# ================================================================== VERTICAL FIN (sections by height Z)
F_Z0, F_Z1 = 4.35, HEIGHT
F_RUDDER = (4.95, 12.22)


def fin_station(Z):
    Z = np.asarray(Z, float)
    xle_main = 31.40 + (Z - 5.0) * math.tan(38.0 * D2R)
    ext = np.where(Z <= 5.0, 4.6, 4.6 * np.exp(-(np.maximum(Z, 5.0) - 5.0) / 0.40))
    xte = 37.62 + (Z - 5.0) * (39.25 - 37.62) / (HEIGHT - 5.0)
    T = lerp_pts([(4.3, 0.28), (5.0, 0.265), (HEIGHT, 0.105)], Z)   # max half thickness
    # rounded tip cap
    capf = smoothstep(HEIGHT - 0.22, HEIGHT, Z)
    return dict(xle=xle_main - ext + 0.25 * capf ** 2, xle_main=xle_main + 0.25 * capf ** 2, xte=xte - 0.12 * capf ** 2,
                T=T * (1 - 0.8 * capf ** 2), Z=Z)


def fin_half_thickness(st, X):
    X = np.asarray(X, float)
    cm = st['xte'] - st['xle_main']
    xm = st['xle_main'] + 0.30 * cm
    D = np.maximum(xm - st['xle'], 1e-3)
    fwd = np.sqrt(np.clip(1 - ((xm - X) / D) ** 2, 0, 1))
    thin = 0.35 + 0.65 * smoothstep(st['xle_main'] - 1.4, st['xle_main'] + 0.4, X)
    aft = np.clip(1 - ((X - xm) / np.maximum(st['xte'] - xm, 1e-3)) ** 2, 0, 1) ** 0.85
    y = np.where(X < xm, fwd * thin, aft)
    return st['T'] * y + 0.004


def fin_xcut(Z):
    return lerp_pts([(F_RUDDER[0], 35.85), (F_RUDDER[1], 38.55)], Z)


FIN_UV_W = 22.0


def fin_uv(X, Z, right, st):
    u = 0.5 + np.where(right, 1, -1) * (np.asarray(X) - st['xle']) / FIN_UV_W
    v = (np.asarray(Z) - F_Z0) / (F_Z1 - F_Z0 + 0.05)
    return u, v


# ================================================================== ENGINE NACELLE (CFM56-7B)
ENG_X0 = 11.85      # inlet highlight station
ENG_Z = 1.38        # engine axis height
ENG_R_FAN = 0.776
# outer cowl radius along s (aft of the highlight)
NAC_OUT = Pchip([(0.0, 0.862), (0.03, 0.915), (0.10, 0.958), (0.25, 0.992), (0.5, 1.012), (0.9, 1.022),
                 (1.5, 1.018), (2.1, 1.000), (2.6, 0.968), (3.1, 0.912), (3.45, 0.855), (3.62, 0.828)])
NAC_IN = Pchip([(0.0, 0.862), (0.025, 0.815), (0.08, 0.792), (0.3, 0.781), (0.72, 0.776)])
NAC_LEN = 3.62
NAC_SLEEVE = 2.10   # translating sleeve starts here
CORE = Pchip([(3.25, 0.63), (3.62, 0.595), (4.0, 0.52), (4.42, 0.41)])
PLUG = Pchip([(4.20, 0.335), (4.42, 0.318), (4.7, 0.25), (5.0, 0.12), (5.14, 0.03)])


def nac_flatten(psi, amount):
    """Radius scale for the flattened lower lip. psi: 0 top, pi bottom. amount 0..1"""
    c = np.cos(psi)
    low = np.clip(-c, 0, 1)   # 0 at the side, 1 at the bottom
    k = 1 - 0.155 * amount * low ** 2.2
    return k


# ================================================================== COCKPIT WINDOWS (ground frame)
# Side windows: polygons in the side projection (X, Z), cut along Y. Front windshield: polygon in the
# front projection (Y, Z), cut along X. All for the right side (mirror for the left).
WIN_W1 = [(0.045, 3.618), (0.83, 3.585), (0.905, 3.64), (0.74, 4.13), (0.63, 4.19), (0.045, 4.302)]   # (Y,Z)
WIN_W2 = [(2.93, 3.56), (3.54, 3.53), (3.56, 3.57), (3.56, 4.13), (3.52, 4.16), (3.06, 4.23), (2.95, 4.19)]  # (X,Z)
WIN_W3 = [(3.66, 3.555), (4.10, 3.555), (4.13, 3.59), (4.13, 3.96), (4.09, 3.995), (3.70, 4.12), (3.66, 4.09)]
WIN_CORNER_R = 0.035


# ================================================================== PASSENGER WINDOWS / DOORS (for painting)
WIN_Z = 3.625        # window centre height
WIN_WH = (0.245, 0.335)
DOORS = {           # (X_fwd, X_aft, Z_sill, height, side)  side: -1 left, +1 right
    'L1': (5.18, 6.04, 2.66, 1.83, -1), 'R1': (5.22, 5.98, 2.66, 1.65, 1),
    'L2': (31.38, 32.22, 2.72, 1.83, -1), 'R2': (31.44, 32.20, 2.72, 1.65, 1),
    'OW1L': (16.05, 16.56, 3.10, 0.97, -1), 'OW2L': (17.05, 17.56, 3.10, 0.97, -1),
    'OW1R': (16.05, 16.56, 3.10, 0.97, 1), 'OW2R': (17.05, 17.56, 3.10, 0.97, 1),
}
CARGO = {'FWD': (8.35, 9.57, 1.52, 1.22, 1), 'AFT': (25.25, 26.47, 1.58, 1.22, 1)}


def window_stations():
    xs = []
    x = 6.95
    while x < 30.9:
        ok = True
        for k, (a, b, zs, h, side) in DOORS.items():
            if k.startswith('OW'):
                continue
            if a - 0.30 < x < b + 0.30:
                ok = False
        if ok:
            xs.append(round(x, 3))
        x += 0.508
    # overwing exits have their windows at the regular pitch inside the hatch; ensure they are present
    return xs


# ================================================================== LANDING GEAR
MG_X, MG_Y = 19.60, 2.86          # main gear axle station, half track
MG_TRUNNION_Z = 1.96
MG_TIRE_R, MG_TIRE_W = 0.565, 0.41
MG_WHEEL_DY = 0.435               # wheel offset from the leg centre
MG_STATIC_R = 0.515               # loaded radius (axle height at static load)
NG_X = 4.05
NG_TRUNNION_Z = 1.70
NG_TIRE_R, NG_TIRE_W = 0.343, 0.197
NG_WHEEL_DY = 0.19
NG_STATIC_R = 0.325


# ================================================================== LIVERY CURVES
BLUE = (0.035, 0.105, 0.265)        # deep blue (linear-ish sRGB values used for paint)
ORANGE = (0.96, 0.46, 0.10)
WHITE = (0.93, 0.935, 0.94)
_BELLY = Pchip([(0.0, 2.62), (1.5, 2.44), (4.0, 2.38), (22.0, 2.38), (24.5, 2.46), (27.0, 2.78), (29.0, 3.25),
                (31.0, 3.88), (33.0, 4.52), (34.8, 5.20), (36.0, 5.5)])


def belly_line(X):
    return _BELLY(X)


def nacelle_profile():
    """Fixed nacelle (inlet duct + lip + fan cowl + cascade band). Returns list of (s, r, flatten, part)."""
    pts = []
    for s_ in [1.0, 0.9, 0.8, 0.72, 0.6, 0.45, 0.32, 0.22, 0.14, 0.08, 0.045, 0.022, 0.009]:
        a = 0.45 * (1 - smoothstep(0.0, 0.45, s_))
        pts.append((s_, float(NAC_IN(min(s_, 0.72))) if s_ <= 0.72 else ENG_R_FAN, a, 'inner'))
    for s_ in [0.0, 0.006, 0.018, 0.04, 0.075, 0.13, 0.21, 0.32, 0.47, 0.66, 0.9, 1.2, 1.5, 1.8, 2.0, 2.1]:
        a = 0.45 + 0.55 * smoothstep(0.0, 0.16, s_)
        pts.append((s_, float(NAC_OUT(s_)), a, 'outer'))
    pts.append((2.1, 0.955, 1.0, 'step'))
    pts.append((2.12, 0.94, 1.0, 'cascade'))
    pts.append((2.78, 0.93, 0.9, 'cascade'))
    pts.append((2.80, 0.87, 0.9, 'step'))
    return pts


def sleeve_profile():
    """Translating reverser sleeve (closed ring profile). (s, r, flatten, part)"""
    pts = []
    for s_ in [2.1, 2.25, 2.45, 2.7, 2.95, 3.2, 3.4, 3.55, 3.62]:
        a = 1.0 - 0.55 * smoothstep(2.1, 3.62, s_)
        pts.append((s_, float(NAC_OUT(s_)), a, 'outer'))
    pts.append((3.625, 0.815, 0.45, 'lip'))
    for s_ in [3.6, 3.4, 3.1, 2.8, 2.5, 2.25]:
        a = 0.2
        pts.append((s_, 0.800 + 0.05 * smoothstep(3.6, 2.4, s_), a, 'duct'))
    pts.append((2.15, 0.93, 0.8, 'step'))
    return pts


def nac_v_coords(profile, v0, v1):
    P = np.array([(p[0], p[1]) for p in profile])
    seg = np.concatenate([[0], np.cumsum(np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1])))])
    return v0 + (v1 - v0) * seg / seg[-1]
