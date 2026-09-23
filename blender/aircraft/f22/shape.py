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
TAN_TE = math.tan(math.radians(17.0))
W_S_LE0 = 6.00              # theoretical LE at the centreline
W_S_TE0 = 15.84             # theoretical TE at the centreline
X_ROOT = 2.05               # wing/body junction (chine half-width)
X_TIP = SPAN / 2
ANHEDRAL = math.radians(3.25)
TC_ROOT, TC_TIP = 0.059, 0.043
V_LEF = 0.10                # LEF hinge chord fraction
V_HINGE = 0.775             # flaperon / aileron hinge chord fraction


def w_le(x):
    return W_S_LE0 + TAN_LE * x


def w_te(x):
    return W_S_TE0 - TAN_TE * x


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
S_TI = 5.55      # top-inner lip corner station
S_TO = 6.35      # top-outer
S_BO = 7.00      # bottom-outer
S_BI = 6.20      # bottom-inner
S_END = 17.10    # end of the fuselage body (nozzle deck)
CANT_NAC = math.radians(17.0)

# ------------------------------------------------------------------ canopy
S_CAN0, S_CAN1 = 2.85, 7.40
can_x = P((2.85, 0.0), (2.95, 0.12), (3.1, 0.23), (3.35, 0.335), (3.7, 0.425), (4.2, 0.49), (4.8, 0.515), (5.4, 0.52),
          (5.9, 0.505), (6.3, 0.47), (6.65, 0.4), (6.95, 0.3), (7.2, 0.17), (7.4, 0.0))
can_zs = P((2.85, 0.43), (3.5, 0.44), (4.5, 0.455), (5.5, 0.48), (6.2, 0.53), (6.7, 0.60), (7.1, 0.69), (7.4, 0.80))
can_zt = P((2.85, 0.43), (3.2, 0.62), (3.6, 0.83), (4.0, 1.01), (4.4, 1.15), (4.8, 1.245), (5.2, 1.295), (5.6, 1.30),
           (6.0, 1.265), (6.5, 1.16), (7.0, 0.985), (7.4, 0.80))

# ------------------------------------------------------------------ fuselage parameters
z_top = P((0.0, -0.195), (0.3, -0.11), (0.6, -0.035), (1.0, 0.06), (1.5, 0.16), (2.0, 0.26), (2.5, 0.355),
          (2.85, 0.43), (7.4, 0.80), (8.0, 0.80), (9.0, 0.775), (10.0, 0.75), (11.0, 0.72), (12.0, 0.685),
          (13.0, 0.645), (14.0, 0.60), (15.0, 0.555), (16.0, 0.51), (17.1, 0.47))
x_ch_fore = P((0.0, 0.0), (0.3, 0.13), (0.6, 0.25), (1.0, 0.38), (1.5, 0.52), (2.0, 0.64), (2.5, 0.74),
              (3.0, 0.83), (3.5, 0.905), (4.0, 0.965), (4.5, 1.015), (5.0, 1.06), (5.55, 1.10))
x_ch_aft = P((S_TO, 2.03), (7.0, 2.045), (S_WROOT_LE, X_ROOT), (S_WROOT_TE, X_ROOT), (15.8, 2.025), (16.5, 2.0),
             (17.1, 1.975))
z_ch = P((0.0, -0.195), (0.5, -0.185), (1.0, -0.17), (2.0, -0.14), (3.0, -0.11), (4.0, -0.078), (5.0, -0.042),
         (5.55, -0.02), (6.35, -0.02), (7.0, -0.01), (S_WROOT_LE, 0.0), (S_WROOT_TE, 0.0), (16.0, 0.02), (17.1, 0.03))
z_belly = P((0.0, -0.195), (0.3, -0.33), (0.6, -0.45), (1.0, -0.56), (1.5, -0.67), (2.0, -0.76), (2.5, -0.83),
            (3.0, -0.89), (3.5, -0.94), (4.0, -0.98), (4.5, -1.01), (5.0, -1.035), (5.5, -1.055), (6.2, -1.075),
            (7.0, -1.09), (8.0, -1.1), (12.0, -1.1), (12.8, -1.075), (13.6, -0.99), (14.5, -0.855), (15.5, -0.69),
            (16.3, -0.575), (17.1, -0.49))
x_bi = P((0.0, 0.0), (0.5, 0.075), (1.0, 0.13), (2.0, 0.23), (3.0, 0.33), (4.0, 0.43), (5.0, 0.55), (6.2, 0.72),
         (12.0, 0.72), (14.0, 0.8), (17.1, 0.88))
belly_bulge = P((0.0, 0.0), (0.4, 0.035), (1.0, 0.05), (3.0, 0.035), (6.0, 0.02), (17.1, 0.012))
# shoulder (soft crease above the inlets, continuation of the forebody chine)
x_sh = P((5.55, 0.80), (6.35, 1.03), (7.4, 1.15), (8.5, 1.2), (11.0, 1.2), (12.5, 1.22), (13.5, 1.36), (14.5, 1.52),
         (15.5, 1.66), (17.1, 1.72))
z_sh = P((5.55, 0.245), (6.35, 0.30), (7.4, 0.35), (8.5, 0.385), (10.0, 0.405), (12.0, 0.415), (13.5, 0.415),
         (15.5, 0.40), (17.1, 0.375))
cant_fore = P((0.0, 34.0), (2.0, 30.0), (4.0, 22.0), (5.5, 16.0), (6.2, 15.0))
dz_lo = P((0.0, 0.14), (2.0, 0.13), (4.0, 0.10), (6.2, 0.075), (8.0, 0.06), (17.1, 0.06))
spine_bulge = P((0.0, 0.02), (2.85, 0.02), (7.4, 0.045), (9.0, 0.03), (12.0, 0.02), (17.1, 0.01))


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
    xlo = xc - (zc - zlo) * math.tan(CANT_NAC)
    xb = x_bi(s)
    bb = belly_bulge(s)
    C = np.array([xc, zc])
    Lo = np.array([xlo, zlo])
    N1 = _bulged_out(C, Lo, 0.5, 0.0)
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
    st += list(np.arange(1.12, S_CAN0, 0.12)) + [S_CAN0, 2.88, 2.92, 2.97, 3.03, 3.1, 3.18, 3.27]
    st += list(np.arange(3.37, S_TI, 0.1)) + [S_TI]
    st += list(np.linspace(S_TI, S_TO, 13)[1:])
    st += list(np.linspace(S_TO, S_CAN1, 12)[1:])
    st += list(np.linspace(S_CAN1, S_WROOT_LE, 6)[1:])
    st += [S_WROOT_LE + v * w_chord(X_ROOT) for v in WING_V[1:]]
    st += list(np.linspace(S_WROOT_TE, S_END, 18)[1:])
    st = sorted(set(round(float(v), 6) for v in st))
    out = []
    for v in st:
        if not out or v - out[-1] > 0.01:
            out.append(v)
        elif v in (S_CAN0, S_CAN1, S_TI, S_TO, S_WROOT_LE, S_WROOT_TE):
            out[-1] = v
    return np.array(out)
