"""F-22A Raptor outer mold line (pure numpy, no bpy) - wave-6 rebuild.

Digitised from the Lockheed Martin F-22A 3-view (blender/aircraft/f22/ref/3view_lines.jpg, 34.1 px/m) and checked
against USAF photos (ref/*.jpg).  Frame:
  s = station, metres aft of the nose tip (overall length 18.92 m = nose tip -> stabilator trailing-edge apex)
  x = lateral, + right wing;   z = vertical, 0 = wing-root / chine plane (the nose tip sits at z = -0.35)
  gear down, static: ground at z = Z_GROUND (fin tips 5.08 m above the ground)
Blender world: (x, y = Y0 - s, z).
"""
import math
import numpy as np
from geom import P, chain, smoothstep, lerp

LENGTH = 18.92
SPAN = 13.56
Z_TIP = -0.35
Z_GROUND = -2.11

# ============================================================================================ planform (wing)
TAN_LE = math.tan(math.radians(42.0))
TAN_TE = math.tan(math.radians(17.9))          # forward-swept trailing edge
X_ROOT = 2.20                                  # wing / fuselage junction (nacelle chine)
X_TIP = SPAN / 2.0                             # 6.78
W_LE_ROOT = 8.45                               # LE station at x = X_ROOT
W_TE_REF = (15.50, 3.03)                       # TE passes through (s, x)
W_TIP_TE = 13.78                               # streamwise tip chord 12.57 -> 13.78
W_CLIP = (14.55, 5.96)                         # clipped trailing corner (s, x)
ANHEDRAL = math.radians(3.25)
TC_ROOT, TC_TIP = 0.0592, 0.0429
LEF_W = 0.37                                   # leading-edge flap streamwise width
FLAPERON_X = (2.36, 4.50)
AILERON_X = (4.54, 5.90)


def w_le(x):
    return W_LE_ROOT + (x - X_ROOT) * TAN_LE


def w_te(x):
    """Trailing edge incl. the clipped tip corner."""
    te = W_TE_REF[0] + (W_TE_REF[1] - x) * TAN_TE
    if x > W_CLIP[1]:
        u = (x - W_CLIP[1]) / (X_TIP - W_CLIP[1])
        te = lerp(W_CLIP[0], W_TIP_TE, u)
    return te


def w_chord(x):
    return w_te(x) - w_le(x)


def w_zc(x):
    """Wing reference plane height (anhedral from the root)."""
    return -(x - X_ROOT) * math.tan(ANHEDRAL) + 0.02


def w_tc(x):
    u = min(1.0, max(0.0, (x - X_ROOT) / (X_TIP - X_ROOT)))
    return lerp(TC_ROOT, TC_TIP, u)


def airfoil_half(v, tc):
    """Half thickness / chord of a thin 64A-like section (sharp-ish LE, max thickness at ~40 %)."""
    v = min(1.0, max(0.0, v))
    # NACA 4-digit shape stretched to put max thickness further aft, closed TE
    t = 5 * tc * (0.2969 * math.sqrt(v) - 0.1260 * v - 0.3516 * v ** 2 + 0.2843 * v ** 3 - 0.1036 * v ** 4)
    return t * (1.0 - 0.15 * v) * (0.93 + 0.12 * smoothstep(0.0, 0.5, v))


def hinge_v_flaperon(x):
    """Chord fraction of the flaperon hinge (hinge line (14.60 @ 2.36) -> (13.85 @ 4.50))."""
    s = lerp(14.60, 13.85, (x - 2.36) / (4.50 - 2.36))
    return (s - w_le(x)) / w_chord(x)


def hinge_v_aileron(x):
    s = lerp(14.29, 13.82, (x - 4.54) / (5.90 - 4.54))
    return (s - w_le(x)) / w_chord(x)


def wing_pt(x, v, upper):
    """(x, s, z) on the wing surface at span x and chord fraction v."""
    c = w_chord(x)
    s = w_le(x) + v * c
    h = airfoil_half(v, w_tc(x)) * c
    u = (x - X_ROOT) / (X_TIP - X_ROOT)
    camber = -0.006 * c * math.exp(-v * 10) * u - 0.002 * c * math.sin(math.pi * v)   # conical LE droop
    z = w_zc(x) + camber + (h if upper else -h)
    return np.array([x, s, z])


def wing_root_z(s, upper, x=X_ROOT):
    c = w_chord(x)
    v = (s - w_le(x)) / c
    if v < 0 or v > 1:
        return w_zc(x)
    return float(wing_pt(x, v, upper)[2])


# ============================================================================================ canopy
S_CAN0 = 2.42        # frame front point (plan V)
S_GL0 = 2.62         # glass front
S_GL1 = 5.62         # glass rear
S_CAN1 = 5.88        # frame rear point
# frame outline half-width (plan) and sill height (side)
can_x = P((2.42, 0.0), (2.55, 0.16), (2.75, 0.34), (3.0, 0.46), (3.4, 0.54), (3.9, 0.585), (4.4, 0.595),
          (4.9, 0.575), (5.2, 0.52), (5.45, 0.38), (5.7, 0.17), (5.88, 0.0))
can_zs = P((2.42, 0.44), (2.8, 0.47), (3.4, 0.53), (4.0, 0.60), (4.6, 0.68), (5.2, 0.77), (5.45, 0.83), (5.7, 0.91),
           (5.88, 0.965))
# glass crown (top centre)
can_zt = P((2.42, 0.44), (2.62, 0.53), (3.0, 0.775), (3.5, 1.03), (3.9, 1.18), (4.25, 1.235), (4.6, 1.225),
           (5.0, 1.16), (5.4, 1.07), (5.88, 0.965))

# ============================================================================================ fuselage lines
# top centre line outside the canopy (nose, spine, aft deck)
z_top = P((0.0, Z_TIP), (0.12, -0.245), (0.25, -0.175), (0.5, -0.065), (0.75, 0.012), (1.0, 0.085), (1.25, 0.148),
          (1.5, 0.205), (1.75, 0.255), (2.0, 0.305), (2.2, 0.36), (2.42, 0.44),
          (5.88, 0.965), (6.2, 0.945), (6.6, 0.90), (7.0, 0.83), (7.5, 0.76), (8.0, 0.71), (8.6, 0.67), (9.5, 0.655),
          (11.0, 0.645), (12.5, 0.635), (13.5, 0.62), (14.5, 0.58), (15.5, 0.50), (16.3, 0.42))
# forebody chine (plan half-width and height); after the intake it is the top edge of the diverter wall
x_ch_fore = P((0.0, 0.0), (0.12, 0.095), (0.25, 0.170), (0.5, 0.290), (0.75, 0.392), (1.0, 0.470), (1.25, 0.538),
              (1.5, 0.593), (1.75, 0.645), (2.0, 0.692), (2.5, 0.768), (3.0, 0.822), (3.5, 0.864), (4.0, 0.895),
              (4.5, 0.922), (4.75, 0.932), (5.5, 0.93), (6.5, 0.90), (7.5, 0.86))
z_ch_fore = P((0.0, Z_TIP), (1.0, -0.275), (2.0, -0.200), (3.0, -0.128), (4.0, -0.060), (4.75, -0.012),
              (5.5, 0.0), (8.0, 0.0))
# forebody keel
z_bot_fore = P((0.0, Z_TIP), (0.12, -0.455), (0.25, -0.505), (0.5, -0.59), (0.75, -0.655), (1.0, -0.705),
               (1.25, -0.745), (1.5, -0.785), (2.0, -0.835), (2.5, -0.875), (3.0, -0.912), (3.5, -0.955),
               (4.0, -0.985), (4.5, -1.000), (5.5, -1.005), (6.5, -1.00), (7.5, -1.00))

# ---- intake (caret lip in one oblique plane: TI, TO, BO define it)
GAP = 0.075                           # boundary-layer diverter gap between forebody wall and nacelle inner lip
S_TI = 4.78
S_TO = 5.72
X_TO = 1.925
S_BO = 6.40                           # lip outer bottom corner (side view: lip slants aft/down)
Z_NAC_BOT0 = -1.135                   # nacelle bottom at the lip
CANT = math.radians(31.0)             # nacelle walls / intake walls lean outboard at the top


def lip_TI():
    return np.array([x_ch_fore(S_TI) + GAP, S_TI, z_ch_fore(S_TI)])


def lip_TO():
    return np.array([X_TO, S_TO, -0.035])


def lip_BO():
    TO = lip_TO()
    h = TO[2] - Z_NAC_BOT0
    return np.array([TO[0] - h * math.tan(CANT), S_BO, Z_NAC_BOT0])


def lip_BI():
    return lip_TI() + (lip_BO() - lip_TO())


# plan outline of the fuselage chine (upper skin lower edge): forebody -> lip flare -> nacelle -> (wing root) -> aft
def x_chine(s):
    if s <= S_TI:
        return x_ch_fore(s) + max(0.0, gap_w(s))
    if s <= S_TO:
        t = (s - S_TI) / (S_TO - S_TI)
        return lerp(x_ch_fore(S_TI) + GAP, X_TO, t)
    return x_nac_chine(s)


x_nac_chine = P((S_TO, X_TO), (6.5, 2.00), (7.5, 2.10), (8.45, 2.20), (14.9, 2.20), (15.55, 2.04))


def z_chine(s):
    """Height of the fuselage chine (upper-skin lower edge)."""
    if s <= S_TI:
        return z_ch_fore(s)
    if s <= S_TO:
        t = (s - S_TI) / (S_TO - S_TI)
        return lerp(z_ch_fore(S_TI), lip_TO()[2], t)
    if s < W_LE_ROOT:
        return lerp(lip_TO()[2], w_zc(X_ROOT), smoothstep(S_TO, W_LE_ROOT, s))
    if s < w_te(X_ROOT):
        return wing_root_z(s, True) - 0.012
    return w_zc(X_ROOT)


# nacelle lower lines (aft of the lip)
z_nac_bot = P((S_BO, Z_NAC_BOT0), (7.5, -1.10), (8.5, -1.075), (10.0, -1.045), (11.5, -1.015), (12.5, -0.985),
              (13.3, -0.955), (14.2, -0.895), (15.0, -0.80), (15.55, -0.70))
x_nac_bot_out = P((S_BO, 1.26), (7.5, 1.32), (9.0, 1.40), (11.0, 1.44), (12.5, 1.44), (13.5, 1.40), (14.5, 1.33),
                  (15.55, 1.24))
S_GAP_CLOSE = (6.9, 7.5)               # the diverter gap closes (nacelle inner wall merges into the keel)
S_NAC_MERGE = 9.0                      # nacelle bottoms meet on the centre line (flat belly)


def gap_w(s):
    """Width of the diverter gap between the forebody wall and the nacelle inner wall."""
    return GAP * smoothstep(S_TI - 0.28, S_TI, s) * (1.0 - smoothstep(*S_GAP_CLOSE, s)) - 0.05 * smoothstep(*S_GAP_CLOSE, s)

# ============================================================================================ upper-skin section
# The upper skin is one smooth arch (top centre A -> M1 -> M2 -> chine C) at every station.  Under the canopy the
# arch's crown is virtual (solved so that the surface passes through the canopy sill); the skin is trimmed at the sill.
NU = 22                                  # columns of the upper skin (sill/centre -> chine)
# key fractions: M = (a * xc, zc + b * (za - zc))
arch_a1 = P((0.0, 0.62), (2.4, 0.60), (3.2, 0.50), (5.0, 0.46), (5.9, 0.14), (6.6, 0.16), (8.6, 0.30), (13.0, 0.30),
            (16.3, 0.30))
arch_b1 = P((0.0, 0.86), (2.4, 0.87), (3.2, 0.86), (5.0, 0.88), (5.9, 0.82), (6.6, 0.80), (8.6, 0.90), (16.3, 0.90))
arch_a2 = P((0.0, 0.93), (2.4, 0.93), (3.2, 0.86), (4.6, 0.72), (5.9, 0.40), (7.0, 0.46), (8.6, 0.54), (13.0, 0.54),
            (16.3, 0.54))
arch_b2 = P((0.0, 0.45), (2.4, 0.46), (3.2, 0.50), (4.6, 0.52), (5.9, 0.44), (7.0, 0.44), (8.6, 0.50),
            (16.3, 0.50))
# tangent at the chine (dx, dz) going outward: steep at the nose, flat shelf over the intake, gentle aft
arch_tcx = P((0.0, 0.22), (2.4, 0.26), (3.6, 0.40), (S_TI - 0.2, 0.70), (S_TO, 1.0), (16.3, 1.0))
arch_tcz = P((0.0, -1.0), (2.4, -1.0), (3.6, -1.0), (S_TI - 0.2, -0.75), (S_TO, -0.28), (8.6, -0.30), (16.3, -0.30))


def _arch(s, za, n=48):
    xc, zc = x_chine(s), z_chine(s)
    h = za - zc
    keys = [(0.0, za), (arch_a1(s) * xc, zc + arch_b1(s) * h), (arch_a2(s) * xc, zc + arch_b2(s) * h), (xc, zc)]
    tans = [(1.0, 0.0), None, None, (arch_tcx(s), arch_tcz(s))]
    return chain(keys, [n // 3, n // 3, n // 3], tan=tans)


def _resample_from(pts, x0, n):
    """Trim the polyline at x = x0 (first crossing from the centre) and resample to n points by arc length."""
    import numpy as _np
    from geom import resample_polyline
    pts = _np.asarray(pts)
    if x0 > 1e-6:
        k = int(_np.argmax(pts[:, 0] >= x0))
        if k == 0:
            k = 1
        a, b = pts[k - 1], pts[k]
        t = (x0 - a[0]) / max(b[0] - a[0], 1e-9)
        p0 = a + (b - a) * min(max(t, 0.0), 1.0)
        pts = _np.vstack([p0[None, :], pts[k:]])
    return resample_polyline(pts, n)


def crown_z(s):
    """Arch crown height (real outside the canopy, virtual under it)."""
    if not (S_CAN0 < s < S_CAN1):
        return z_top(s)
    xs, zs = can_x(s), can_zs(s)
    lo, hi = zs, zs + 1.5
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        pts = _arch(s, mid, 60)
        k = int(np.argmax(pts[:, 0] >= xs))
        a, b = pts[max(k - 1, 0)], pts[k]
        t = (xs - a[0]) / max(b[0] - a[0], 1e-9)
        z = a[1] + (b[1] - a[1]) * t
        if z > zs:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def upper_profile(s, n=NU):
    """Right half, from the top centre (or the canopy sill) to the chine: (n, 2) array of (x, z)."""
    za = crown_z(s)
    pts = _arch(s, za, 60)
    x0 = can_x(s) if S_CAN0 < s < S_CAN1 else 0.0
    return _resample_from(pts, x0, n)


# ============================================================================================ forebody lower section
NL = 14                                  # columns of the forebody lower skin (gap roof edge -> keel centre)


def fore_lower_profile(s, n=NL):
    """Right half: G (outer edge of the diverter-gap roof) -> Cf (forebody chine) -> lower corner -> keel centre."""
    from geom import resample_polyline
    xc, zc = x_ch_fore(s), z_ch_fore(s)
    zb = z_bot_fore(s)
    d = zc - zb
    g = max(0.0, gap_w(s))
    # ahead of the intake: rounded lower side leaning inward ~55 deg; at the intake: a straight diverter wall
    # parallel to the nacelle inner wall (CANT), then a small rounded keel
    k = smoothstep(S_TI - 0.9, S_TI + 0.1, s)
    xl = lerp(xc * lerp(0.42, 0.50, smoothstep(0.5, 4.0, s)), xc - 0.93 * d * math.tan(CANT), k)
    zl = lerp(zb + d * lerp(0.30, 0.22, smoothstep(0.5, 4.0, s)), zb + 0.07 * d, k)
    bulge = lerp(0.018, 0.0, k)
    keys = [(xc, zc), (lerp(xc, xl, 0.5) + bulge, lerp(zc, zl, 0.5)), (xl, zl), (0.0, zb)]
    tans = [(lerp(-0.55, -math.tan(CANT), k), -1.0), None, None, (-1.0, 0.0)]
    pts = chain(keys, [8, 8, 10], tan=tans)
    pts = resample_polyline(pts, n - 1)
    G = np.array([[xc + g, zc]])
    return np.vstack([G, pts])


# ============================================================================================ nacelle section
S_END = 15.55                            # aft end of the fuselage skin (aft deck / nozzle flap hinges)
NAC_N = (6, 7, 5)                        # points on the outer wall, bottom, inner wall (without shared corners)


def nac_inner_top(s):
    return np.array([x_ch_fore(s) + gap_w(s), z_ch_fore(s)])


def nac_corner_out(s):
    if s <= S_BO:
        b = lip_BO()
        return np.array([b[0], b[2]])
    return np.array([x_nac_bot_out(s), z_nac_bot(s)])


def nac_corner_in(s):
    ti = nac_inner_top(s)
    zb = nac_corner_out(s)[1]
    x = ti[0] - (ti[1] - zb) * math.tan(CANT)
    x = lerp(x, 0.0, smoothstep(7.3, S_NAC_MERGE, s))
    return np.array([max(0.0, x), zb])


def nac_profile_point(s, j):
    """Point j of the nacelle U (outer wall top -> bottom outer -> bottom inner -> inner wall top) at station s."""
    no, nb, ni = NAC_N
    C = np.array([x_chine(s), z_chine(s)])
    N = nac_corner_out(s)
    Ni = nac_corner_in(s)
    Ti = nac_inner_top(s)
    if j <= no:
        return C + (N - C) * (j / no)
    j -= no
    if j <= nb:
        return N + (Ni - N) * (j / nb)
    j -= nb
    return Ni + (Ti - Ni) * (j / ni)


def nac_ncols():
    return sum(NAC_N) + 1


def nac_lip_point(j):
    """Row-0 point j on the lip loop (TO -> BO -> BI -> TI), (x, s, z)."""
    no, nb, ni = NAC_N
    TO, BO, BI, TI = lip_TO(), lip_BO(), lip_BI(), lip_TI()
    if j <= no:
        return TO + (BO - TO) * (j / no)
    j -= no
    if j <= nb:
        return BO + (BI - BO) * (j / nb)
    j -= nb
    return BI + (TI - BI) * (j / ni)


def nac_rows():
    """Outer-top column stations of the nacelle rows (also used as fuselage stations aft of the lip)."""
    r = [S_TO, 5.78, 5.86, 5.95, 6.05, 6.17, 6.31, 6.47, 6.65, 6.85, 7.07, 7.31, 7.57, 7.85, 8.15, W_LE_ROOT]
    r += [W_LE_ROOT + d for d in (0.05, 0.12, 0.22, 0.36, 0.55, 0.8)]
    r += list(np.arange(9.6, 15.0, 0.4)) + [15.15, 15.35, S_END]
    return np.array(sorted(set(round(v, 5) for v in r)))


def nac_station(k_s, j):
    """Station of column j in the row whose outer-top station is k_s (rows fan out from the oblique lip)."""
    s_lip = nac_lip_point(j)[1]
    tau = (k_s - S_TO) / (S_END - S_TO)
    return s_lip + tau * (S_END - s_lip)


# ============================================================================================ stations
def fuselage_stations(nac_rows):
    """Global stations: dense at the nose, canopy/lip breaks, then the nacelle rows' outer-top stations."""
    st = [0.0, 0.01, 0.03, 0.06, 0.1, 0.15, 0.21, 0.28, 0.36, 0.45, 0.55, 0.66, 0.78, 0.9, 1.03]
    st += list(np.arange(1.17, S_CAN0, 0.14)) + [S_CAN0]
    st += [S_CAN0 + d for d in (0.03, 0.07, 0.12, 0.18, 0.25, 0.33)]
    st += list(np.arange(S_CAN0 + 0.42, S_TI, 0.12)) + [S_TI]
    st += list(np.linspace(S_TI, S_TO, 10)[1:])
    st = [v for v in st if v <= S_TO + 1e-9]
    st += [v for v in nac_rows if v > S_TO + 1e-6]
    st += [S_CAN1] if S_CAN1 not in st else []
    st = sorted(set(round(float(v), 6) for v in st))
    out = []
    for v in st:
        if not out or v - out[-1] > 0.008:
            out.append(v)
    return np.array(out)
