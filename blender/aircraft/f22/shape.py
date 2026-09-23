"""F-22A Raptor outer mold line definition (pure math, no bpy).

Station s = meters aft of the nose tip (overall length 18.92 m). Lateral x (+ right), vertical z (0 = wing-root
chord plane, which is also the chine plane aft of the inlets). Ground (gear down, static) at z = Z_GROUND.
"""
import math
import numpy as np
from geom import P, chain, smoothstep, lerp

LENGTH = 18.92
SPAN = 13.56
Z_GROUND = -2.15

# ------------------------------------------------------------------ wing (clipped diamond, 42 deg LE / -17 deg TE)
TAN_LE = math.tan(math.radians(42.0))
TAN_TE = math.tan(math.radians(18.1))
W_S_LE0 = 6.47              # theoretical LE at the centreline
W_S_TE0 = 16.52             # theoretical TE at the centreline
X_ROOT = 2.20               # wing/body junction (chine half-width)
X_TIP = SPAN / 2
ANHEDRAL = math.radians(3.25)
TC_ROOT, TC_TIP = 0.059, 0.043
V_LEF = 0.10                # LEF hinge chord fraction
V_HINGE = 0.775             # flaperon / aileron hinge chord fraction


def w_le(x):
    return W_S_LE0 + TAN_LE * x


X_CLIP = 5.95                # wing-tip trailing corner is clipped outboard of this span


def w_te(x):
    te = W_S_TE0 - TAN_TE * x
    if x > X_CLIP:
        te0 = W_S_TE0 - TAN_TE * X_CLIP
        te = te0 - (x - X_CLIP) * (te0 - 13.78) / (X_TIP - X_CLIP)
    return te


def w_chord(x):
    return w_te(x) - w_le(x)


def w_zc(x):
    return -(x - X_ROOT) * math.tan(ANHEDRAL)


def w_tc(x):
    u = (x - X_ROOT) / (X_TIP - X_ROOT)
    return lerp(TC_ROOT, TC_TIP, max(0.0, min(1.0, u)))


def naca_half(v, tc):
    v = max(0.0, min(1.0, v))
    return 5 * tc * (0.2969 * math.sqrt(v) - 0.126 * v - 0.3516 * v ** 2 + 0.2843 * v ** 3 - 0.1036 * v ** 4)


def wing_pt(x, v, upper):
    """Point on the wing surface (x, s, z) at span x and chord fraction v."""
    c = w_chord(x)
    s = w_le(x) + v * c
    h = naca_half(v, w_tc(x)) * c
    # a little conical camber: LE region droops slightly outboard
    camber = -0.004 * c * math.exp(-v * 12) * ((x - X_ROOT) / (X_TIP - X_ROOT))
    z = w_zc(x) + camber + (h if upper else -h)
    return np.array([x, s, z])


# chordwise stations (fractions); LEF + hinge breaks included exactly
def wing_v_stations():
    le = [0.0, 0.0008, 0.0025, 0.0055, 0.0095, 0.015, 0.022, 0.031, 0.042, 0.055, 0.07, 0.085, V_LEF]
    mid = list(np.linspace(V_LEF, V_HINGE, 26)[1:])
    te = list(np.linspace(V_HINGE, 1.0, 10)[1:])
    return np.array(le + mid + te)


WING_V = wing_v_stations()
S_WROOT_LE = w_le(X_ROOT)
S_WROOT_TE = w_te(X_ROOT)


def wing_root_z(s, upper):
    """Height of the wing-root section at station s (x = X_ROOT)."""
    c = w_chord(X_ROOT)
    v = (s - S_WROOT_LE) / c
    if v < 0 or v > 1:
        return 0.0
    return wing_pt(X_ROOT, v, upper)[2]


# ------------------------------------------------------------------ inlet (caret, parallelogram lip)
S_TI = 4.74      # top-inner lip corner station
S_TO = 5.61      # top-outer
S_BO = 6.30      # bottom-outer
S_BI = 5.50      # bottom-inner
S_END = 16.15    # end of the fuselage body (nozzle hinge deck; exits at ~16.9)
CANT_NAC = math.radians(35.0)      # (legacy) nominal nacelle wall cant
x_lo_nac = P((5.61, 1.18), (6.3, 1.19), (8.0, 1.24), (10.0, 1.28), (12.0, 1.32), (13.5, 1.42), (15.0, 1.58),
             (16.15, 1.68))

# ------------------------------------------------------------------ canopy
S_CAN0, S_CAN1 = 2.60, 7.30
can_x = P((2.60, 0.0), (2.70, 0.12), (2.85, 0.23), (3.10, 0.335), (3.45, 0.425), (3.95, 0.49), (4.5, 0.515), (5.1, 0.52),
          (5.6, 0.505), (6.0, 0.47), (6.4, 0.40), (6.75, 0.30), (7.05, 0.17), (7.30, 0.0))
can_zs = P((2.60, 0.43), (3.2, 0.46), (4.0, 0.49), (5.0, 0.515), (5.8, 0.55), (6.4, 0.59), (6.9, 0.625), (7.30, 0.66))
can_zt = P((2.60, 0.43), (3.0, 0.655), (3.4, 0.84), (3.8, 0.98), (4.2, 1.09), (4.5, 1.15), (4.8, 1.175), (5.1, 1.17),
           (5.5, 1.10), (6.0, 1.0), (6.4, 0.92), (6.9, 0.78), (7.30, 0.66))

# ------------------------------------------------------------------ fuselage parameters
z_top = P((0.0, -0.40), (0.33, -0.23), (0.8, -0.08), (1.29, 0.06), (2.0, 0.21), (2.3, 0.3), (2.60, 0.43),
          (7.30, 0.66), (7.6, 0.625), (8.5, 0.595), (9.5, 0.565), (10.5, 0.54), (12.0, 0.515), (14.0, 0.495),
          (15.2, 0.48), (16.15, 0.465))
x_ch_fore = P((0.0, 0.0), (0.3, 0.17), (0.57, 0.30), (1.19, 0.52), (1.98, 0.71), (3.0, 0.815), (4.0, 0.885),
              (4.74, 0.94))
x_ch_aft = P((S_TO, 1.90), (6.43, 1.99), (7.4, 2.10), (S_WROOT_LE, X_ROOT), (S_WROOT_TE, X_ROOT), (15.9, 2.10),
             (16.15, 2.02))
z_ch = P((0.0, -0.40), (0.6, -0.34), (1.2, -0.28), (2.0, -0.21), (3.0, -0.14), (4.0, -0.07), (4.74, -0.02),
         (5.61, -0.02), (6.4, -0.01), (S_WROOT_LE, 0.0), (S_WROOT_TE, 0.0), (15.9, 0.01), (16.15, 0.02))
z_belly = P((0.0, -0.40), (0.33, -0.57), (0.7, -0.64), (1.0, -0.69), (1.5, -0.785), (2.0, -0.86), (2.5, -0.915),
            (3.0, -0.955), (4.0, -0.99), (5.0, -1.01), (6.0, -1.03), (7.0, -1.03), (12.0, -1.03), (12.8, -1.01),
            (13.6, -0.96), (14.5, -0.87), (15.3, -0.73), (16.15, -0.53))
x_bi = P((0.0, 0.0), (0.5, 0.06), (1.0, 0.11), (2.0, 0.19), (3.0, 0.27), (4.0, 0.35), (4.9, 0.41), (5.5, 0.45),
         (12.0, 0.48), (14.0, 0.56), (16.15, 0.70))
belly_bulge = P((0.0, 0.0), (0.4, 0.03), (1.0, 0.04), (3.0, 0.03), (6.0, 0.02), (16.15, 0.012))
# shoulder (soft crease above the inlets, continuation of the forebody chine)
x_sh = P((4.74, 0.74), (5.61, 0.98), (6.4, 1.08), (7.4, 1.15), (8.5, 1.2), (11.0, 1.2), (12.5, 1.17), (14.0, 1.13),
         (15.5, 1.1), (16.15, 1.1))
z_sh = P((4.74, 0.24), (5.61, 0.30), (6.4, 0.34), (7.4, 0.36), (8.5, 0.37), (10.0, 0.385), (12.0, 0.4),
         (14.0, 0.405), (16.15, 0.40))
cant_fore = P((0.0, 36.0), (2.0, 32.0), (4.0, 28.0), (4.74, 27.0), (5.5, 27.0))
dz_lo = P((0.0, 0.10), (2.0, 0.10), (4.0, 0.08), (5.5, 0.07), (8.0, 0.06), (16.15, 0.06))
spine_bulge = P((0.0, 0.02), (2.60, 0.025), (7.3, 0.05), (9.0, 0.03), (12.0, 0.015), (16.15, 0.01))


def chine(s):
    """(x, z) of the chine; in the wing-root range returns the upper point."""
    if s <= S_TI:
        x = x_ch_fore(s)
    elif s <= S_TO:
        t = (s - S_TI) / (S_TO - S_TI)
        x = lerp(x_ch_fore(S_TI), x_ch_aft(S_TO), t)
    else:
        x = x_ch_aft(s)
    return x, z_ch(s)


def in_canopy(s):
    return S_CAN0 < s < S_CAN1


def upper_keys(s):
    """Right upper half-profile keys [S, A, U, B, C] (top/sill -> chine)."""
    xc, zc = chine(s)
    if S_WROOT_LE < s < S_WROOT_TE:
        zc = wing_root_z(s, True)
    if in_canopy(s):
        xs, zs = can_x(s), can_zs(s)
    else:
        xs, zs = 0.0, z_top(s)
    # shoulder
    if s <= S_TI:
        f = lerp(0.38, 0.47, smoothstep(2.5, 4.0, s))
        xu = xs + 0.5 * (xc - xs)
        zu = zs + (zc - zs) * f
    else:
        # blend from the forebody formula into the explicit shoulder line
        xu, zu = x_sh(s), z_sh(s)
    A = _bulged(np.array([xs, zs]), np.array([xu, zu]), 0.5, spine_bulge(s))
    B = _bulged(np.array([xu, zu]), np.array([xc, zc]), 0.5, 0.012 if s > S_TI else 0.02)
    return [np.array([xs, zs]), A, np.array([xu, zu]), B, np.array([xc, zc])]


def _bulged(a, b, t, bulge):
    p = a + (b - a) * t
    d = b - a
    n = np.array([d[1], -d[0]])  # right-hand normal (outward for our ordering: top -> chine going +x, -z)
    n = n / (np.linalg.norm(n) + 1e-12)
    # outward = away from the body centre: for the upper profile that is +z side => n has positive z when d.x > 0
    if n[1] < 0:
        n = -n
    return p + n * bulge


UPPER_NSUB = [5, 7, 5, 8]          # per segment S-A, A-U, U-B, B-C
UPPER_SHARP = [False, False, False, False, True]


def upper_profile(s):
    k = upper_keys(s)
    tan = [None] * len(k)
    if not in_canopy(s):
        tan[0] = (1.0, 0.0)       # symmetric top centre
    return chain(k, UPPER_NSUB, sharp=UPPER_SHARP, tan=tan)


def fore_lower_keys(s):
    """Forebody lower half-profile keys [C, F1, Lo, Bi, M, BC]."""
    xc, zc = chine(min(s, S_TI)) if s <= S_TI else _fore_chine_ext(s)
    zb = z_belly(s)
    depth = max(zc - zb, 1e-4)
    zlo = zb + min(dz_lo(s), 0.3 * depth)
    xlo = xc - (zc - zlo) * math.tan(math.radians(cant_fore(s)))
    xb = min(x_bi(s), 0.8 * xlo)
    xlo = max(xlo, xb + min(0.06, 0.2 * xc))
    bb = min(belly_bulge(s), 0.12 * depth)
    C = np.array([xc, zc])
    F1 = _bulged_out(C, np.array([xlo, zlo]), 0.5, 0.015)
    Lo = np.array([xlo, zlo])
    Bi = np.array([xb, zb + bb * 0.9])
    M = np.array([xb * 0.5, zb + bb * 0.25])
    BC = np.array([0.0, zb])
    return [C, F1, Lo, Bi, M, BC]


def _fore_chine_ext(s):
    """Forebody side top edge inside the inlet (continuation of the forebody chine under the shelf)."""
    x = x_ch_fore(S_TI) - 0.02 * (s - S_TI)
    return x, z_ch(s)


def _bulged_out(a, b, t, bulge):
    p = a + (b - a) * t
    d = b - a
    n = np.array([d[1], -d[0]])
    n = n / (np.linalg.norm(n) + 1e-12)
    if n[0] < 0:
        n = -n
    return p + n * bulge


FORE_NSUB = [5, 5, 4, 3, 3]
FORE_SHARP = [True, False, False, True, False, False]


def fore_lower_profile(s):
    k = fore_lower_keys(s)
    tan = [None] * len(k)
    tan[-1] = (-1.0, 0.0)
    return chain(k, FORE_NSUB, sharp=FORE_SHARP, tan=tan)


def nac_lower_keys(s):
    """Nacelle / aft lower half-profile keys [C, N1, Lo, N2, Bi, M, BC] (C = wing lower surface in the root range)."""
    xc, zc = chine(s)
    if S_WROOT_LE < s < S_WROOT_TE:
        zc = wing_root_z(s, False)
    zb = z_belly(s)
    zlo = zb + dz_lo(s)
    xlo = min(x_lo_nac(s), xc - 0.2)
    xb = min(x_bi(s), xlo - 0.2)
    bb = belly_bulge(s)
    C = np.array([xc, zc])
    Lo = np.array([xlo, zlo])
    N1 = _bulged_out(C, Lo, 0.45, 0.03)
    Bi = np.array([xb, zb + bb * 0.9])
    N2 = np.array([lerp(xlo, xb, 0.3), zb + bb * 0.9 + (dz_lo(s) * 0.15)])
    M = np.array([xb * 0.5, zb + bb * 0.25])
    BC = np.array([0.0, zb])
    return [C, N1, Lo, N2, Bi, M, BC]


NAC_NSUB = [5, 5, 3, 6, 3, 3]
NAC_SHARP = [True, False, False, False, True, False, False]


def nac_lower_profile(s):
    k = nac_lower_keys(s)
    tan = [None] * len(k)
    tan[-1] = (-1.0, 0.0)
    return chain(k, NAC_NSUB, sharp=NAC_SHARP, tan=tan)


# ------------------------------------------------------------------ station list
def global_stations():
    st = [0.0, 0.015, 0.04, 0.08, 0.13, 0.19, 0.26, 0.34, 0.43, 0.53, 0.64, 0.76, 0.88, 1.0]
    st += list(np.arange(1.12, S_CAN0 - 0.02, 0.12)) + [S_CAN0] + [S_CAN0 + d for d in (0.03, 0.07, 0.12, 0.18, 0.25, 0.33, 0.42)]
    st += list(np.arange(S_CAN0 + 0.52, S_TI, 0.1)) + [S_TI]
    st += list(np.linspace(S_TI, S_TO, 13)[1:])
    st += list(np.linspace(S_TO, S_CAN1, 12)[1:])
    st += list(np.linspace(S_CAN1, S_WROOT_LE, 6)[1:])
    st += [S_WROOT_LE + v * w_chord(X_ROOT) for v in WING_V[1:]]
    st += list(np.linspace(S_WROOT_TE, S_END, 8)[1:])
    st = sorted(set(round(float(v), 6) for v in st))
    out = []
    for v in st:
        if not out or v - out[-1] > 0.01:
            out.append(v)
        elif v in (S_CAN0, S_CAN1, S_TI, S_TO, S_WROOT_LE, S_WROOT_TE):
            out[-1] = v
    return np.array(out)
