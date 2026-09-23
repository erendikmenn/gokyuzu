"""A320neo shared geometry layout (pure numpy; imported by the Blender build AND by the texture generator).

Sources: Airbus "A320 Aircraft Characteristics - Airport and Maintenance Planning" (Jun 2024): general dimensions,
ground clearances, door locations, LEAP-1A power plant dimensions, visibility from cockpit; digitized silhouettes in
ref/*.json (see ref/fit_profiles.py).

Frame: station s = meters aft of the nose tip; z = meters above the fuselage axis; y = meters to the right.
Blender: X = y, Y = S_CG - s, Z = z.  Ground (gear static) at z = -Z_GROUND.
"""
import json
import math
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
L_FUS = 37.57
S_CG = 16.47
Z_GROUND = 3.90            # fuselage axis height above ground at OEW, gear static
HALF_H = 2.07
HW = 1.975

_P = json.load(open(os.path.join(HERE, 'ref', 'profiles.json')))
_S = np.array(_P['s'])
_TOP = np.array(_P['top'])
_BOT = np.array(_P['bot'])
_HW = np.array(_P['hw'])

S_END = 37.50              # fuselage skin ends here (APU exhaust opening)


def prof(s):
    s = np.asarray(s, float)
    top = np.interp(s, _S, _TOP)
    bot = np.interp(s, _S, _BOT)
    hw = np.interp(s, _S, _HW)
    return top, bot, hw


def section_params(s):
    """-> zc, a_up, a_dn, hw, n_up, n_dn (superellipse exponents) for station(s) s."""
    top, bot, hw = prof(s)
    s = np.asarray(s, float)
    # centre of the widest line: mid-height, pulled slightly down in the cockpit area so the nose sides are fuller
    mid = 0.5 * (top + bot)
    zc = mid
    a_up = top - zc
    a_dn = zc - bot
    # slightly fuller lower lobe in the nose (radome / nose gear bay) and the belly
    n_up = 2.0 + 0.30 * np.exp(-((s - 2.4) / 1.5) ** 2)      # fuller cockpit shoulders
    n_dn = 2.0 + 0.22 * np.exp(-((s - 2.5) / 2.0) ** 2)
    return zc, a_up, a_dn, hw, n_up, n_dn


def _spow(x, p):
    return np.sign(x) * np.abs(x) ** p


def surface(s, th):
    """Fuselage surface point(s). th: angle around the section, 0 = top, pi/2 = right (+y), pi = bottom.
    Broadcasts s and th. Returns y, z arrays."""
    s = np.asarray(s, float)
    th = np.asarray(th, float)
    zc, a_up, a_dn, hw, n_up, n_dn = section_params(s)
    c, sn = np.cos(th), np.sin(th)
    up = c >= 0
    n = np.where(up, n_up, n_dn)
    y = hw * _spow(sn, 2.0 / n)
    z = zc + np.where(up, a_up, a_dn) * _spow(c, 2.0 / n)
    return y, z


def normal(s, th, ds=1e-3, dth=1e-3):
    """Outward unit normal (in s,y,z order converted to (y, -s, z) Blender-like below)."""
    y0, z0 = surface(s, th)
    y1, z1 = surface(s + ds, th)
    y2, z2 = surface(s, th + dth)
    # tangent vectors in Blender coords (X=y, Y=-s, Z=z)
    ts = np.stack([(y1 - y0) / ds, np.full_like(y0, -1.0), (z1 - z0) / ds], -1)
    tt = np.stack([(y2 - y0) / dth, np.zeros_like(y0), (z2 - z0) / dth], -1)
    n = np.cross(ts, tt)                      # outward
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def theta_at(s, z, side=1):
    """Angle th on the given side (+1 right, -1 left) where the section at s reaches height z."""
    ths = np.linspace(0.0, math.pi, 2001)
    _, zz = surface(np.full_like(ths, s), ths)
    th = np.interp(-z, -zz, ths)      # zz decreases with th
    return th if side > 0 else 2 * math.pi - th


def s_at_front(y, z, s_lo=0.02, s_hi=8.0):
    """Station where the nose surface passes through front-view point (y, z) (right side, y >= 0)."""
    def inside(s):
        zc, a_up, a_dn, hw, n_up, n_dn = section_params(s)
        a = a_up if z >= zc else a_dn
        n = n_up if z >= zc else n_dn
        return (abs(y) / hw) ** n + (abs(z - zc) / a) ** n - 1.0
    lo, hi = s_lo, s_hi
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if inside(mid) > 0:
            lo = mid
        else:
            hi = mid
    s = 0.5 * (lo + hi)
    zc, a_up, a_dn, hw, n_up, n_dn = section_params(s)
    a = a_up if z >= zc else a_dn
    n = float(n_up if z >= zc else n_dn)
    # invert superellipse param: y = hw*sin^(2/n), z-zc = a*cos^(2/n)
    sn = (abs(y) / hw) ** (n / 2.0)
    cs = (abs(z - zc) / a) ** (n / 2.0) * (1 if z >= zc else -1)
    th = math.atan2(sn, cs)
    return float(s), float(th)


# ------------------------------------------------------------------------------------------------ openings
# Cabin windows (A320: 0.23 x 0.33 m), centre height z = +0.70; stations digitized from the AC side view.
WIN_Z = 0.70
WIN_W = 0.235
WIN_H = 0.335
_ws = [6.16, 6.68, 7.21, 7.74, 8.30, 8.84, 9.37, 9.91, 10.45, 10.99, 11.53, 12.08, 12.62, 13.16, 13.71,
       15.96, 16.49, 17.03, 17.57, 18.10, 18.63, 19.17, 19.71, 20.25, 20.79, 21.33, 21.86, 22.40, 22.94, 23.48,
       24.02, 24.54, 25.06, 25.59, 26.12, 26.64, 27.17, 27.70]
CABIN_WINDOWS = _ws
EXIT_WINDOWS = [14.46, 15.31]          # windows in the overwing exit hatches

# doors: (name, s_center, width, z_bottom, z_top, sides, corner_radius)
DOORS = [
    ('door_1', 5.04, 0.81, -0.40, 1.46, (-1, 1), 0.14),
    ('door_4', 29.53, 0.81, -0.28, 1.58, (-1, 1), 0.14),
    ('exit_1', 14.43, 0.51, 0.08, 1.05, (-1, 1), 0.10),
    ('exit_2', 15.28, 0.51, 0.08, 1.05, (-1, 1), 0.10),
    ('cargo_fwd', 8.16, 1.82, -1.72, -0.52, (1,), 0.10),
    ('cargo_aft', 22.69, 1.82, -1.72, -0.52, (1,), 0.10),
    ('cargo_bulk', 26.29, 0.95, -1.45, -0.55, (1,), 0.08),
]

# cockpit windows: corners as ('S', s, z) = side-view point (right side) or ('F', y, z) = front-view point.
# Polygons listed for the right side; the left side is mirrored.
CK_WINDOWS = {
    # windshield: front-view corners (y, z); the outboard edge leans back like the real post
    'ws': [('F', 0.050, 0.445), ('F', 0.93, 0.415), ('F', 0.745, 0.905), ('F', 0.050, 0.925)],
    # side windows: side-view corners (s, z) on the right side (AC side view: band z +0.35..+0.90);
    # ('W', k, dth, ds) = windshield corner k shifted by dth (rad) / ds (m) -> ~9 cm post
    'slide': [('W', 1, 0.075, 0.015), ('S', 2.62, 0.355), ('S', 2.62, 0.895), ('W', 2, 0.068, 0.02)],
    'fixed': [('S', 2.69, 0.355), ('S', 3.30, 0.375), ('S', 3.16, 0.895), ('S', 2.69, 0.895)],
}


def ck_corner_param(c, side=1):
    if c[0] == 'W':
        s, th = ck_corner_param(CK_WINDOWS['ws'][c[1]], 1)
        s, th = s + c[3], th + c[2]
        return s, (th if side > 0 else 2 * math.pi - th)
    if c[0] == 'S':
        s, z = c[1], c[2]
        return s, theta_at(s, z, side)
    y, z = c[1], c[2]
    s, th = s_at_front(abs(y), z)
    return s, (th if side > 0 else 2 * math.pi - th)


def ck_window_params(name, side=1):
    return [ck_corner_param(c, side) for c in CK_WINDOWS[name]]


# ------------------------------------------------------------------------------------------------ wing
WING = dict(
    le0=11.92, le_slope=0.513,           # leading edge station at y: le0 + le_slope*y
    te_in=18.83, y_kink=6.44, te_slope=0.306,
    y_side=1.975, y_tip=16.30,
    z_side=-0.82, dihedral_deg=5.1,     # chord plane height at the fuselage side and dihedral outboard
    tc_root=0.145, tc_kink=0.112, tc_tip=0.098,
    twist_root=2.5, twist_kink=0.8, twist_tip=-1.8,   # incidence (deg, + = nose up)
)


def wing_le(y):
    return WING['le0'] + WING['le_slope'] * y


def wing_te(y):
    y = np.asarray(y, float)
    return np.where(y <= WING['y_kink'], WING['te_in'], WING['te_in'] + WING['te_slope'] * (y - WING['y_kink']))


def wing_z(y):
    """Chord-plane height at span y (at the quarter chord)."""
    y = np.asarray(y, float)
    t = math.tan(math.radians(WING['dihedral_deg']))
    return WING['z_side'] + (y - WING['y_side']) * t


def wing_tc(y):
    y = np.asarray(y, float)
    return np.where(y < WING['y_kink'],
                    np.interp(y, [0, WING['y_side'], WING['y_kink']], [WING['tc_root'] + 0.005, WING['tc_root'], WING['tc_kink']]),
                    np.interp(y, [WING['y_kink'], WING['y_tip']], [WING['tc_kink'], WING['tc_tip']]))


def wing_twist(y):
    return np.interp(y, [0, WING['y_side'], WING['y_kink'], WING['y_tip']],
                     [WING['twist_root'], WING['twist_root'], WING['twist_kink'], WING['twist_tip']])


# engine (LEAP-1A)
ENG_Y = 5.75
ENG_Z = -2.09
ENG_S_LIP = 11.14          # top inlet lip station (AC: 11.14 m nose -> inlet)

# landing gear
NLG_S = 5.07
MLG_S = 17.71
MLG_Y = 7.59 / 2
MLG_WHEEL_DY = 0.93 / 2
NLG_WHEEL_DY = 0.50 / 2
MLG_TIRE_D = 1.168         # 46x17R20
MLG_TIRE_W = 0.43
NLG_TIRE_D = 0.762         # 30x8.8R15
NLG_TIRE_W = 0.224

EYE_S = 2.41
EYE_Y = 0.53
EYE_Z = 4.56 - Z_GROUND


def uv_of(s, th):
    """Fuselage texture coordinates (Blender convention, v up)."""
    return np.asarray(s, float) / L_FUS, np.asarray(th, float) / (2 * math.pi)
