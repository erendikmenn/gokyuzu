"""Exterior details: light empties + lenses, antennas, pitot/AOA probes, wipers, tail skid, drain masts."""
import math
import numpy as np

import shape as S
import mk
from mk import MeshData

TB = S.to_b


def fus_top_z(X):
    return float(S.fus_profiles(X)['zt'])


def fus_bot_z(X):
    return float(S.fus_profiles(X)['zb'])


def blade(md, base_g, chord0, chord1, height, sweep_deg, thick, up=(0, 0, 1), mat=0):
    """Swept blade antenna from a base point (ground frame) along `up`."""
    up = np.asarray(up, float); up /= np.linalg.norm(up)
    fwd = np.array([-1.0, 0, 0])
    lat = np.cross(up, fwd); lat /= np.linalg.norm(lat)
    rings = []
    for h, c in ((-0.02, chord0), (0.0, chord0), (height, chord1)):
        off = np.array([math.tan(math.radians(sweep_deg)) * max(h, 0), 0, 0])
        ring = []
        for k in range(12):
            a = 2 * math.pi * k / 12
            x = -math.cos(a) * c / 2
            y = math.sin(a) * thick / 2 * (0.3 + 0.7 * math.cos(a * 0.5) ** 2)
            ring.append(np.asarray(base_g) + off + up * h + fwd * -x + lat * y)
        rings.append(np.array(ring))
    P = np.array([TB(r[:, 0], r[:, 1], r[:, 2]) for r in rings])
    UV = np.zeros((P.shape[0], P.shape[1] + 1, 2)) + 0.5
    m = mk.grid(P, UV, wrap=True, mat=mat)
    mk.cap(m, [(P.shape[0] - 1) * P.shape[1] + j for j in range(P.shape[1])], mat=mat)
    mk.orient_outward(m)
    md.merge(m)


def dome(md, c_g, r, h, axis=(0, 0, 1), mat=0, n=16):
    prof = [(r, 0.0), (r * 0.95, h * 0.45), (r * 0.7, h * 0.85), (r * 0.35, h * 0.98), (0.0, h)]
    m = mk.lathe(prof, n=n, origin=TB(*c_g), axis=TB(*np.asarray(axis)) - TB(0, 0, 0), ref=(1, 0, 0), mat=mat)
    md.merge(m)


def build_details(mats):
    created = []
    md = MeshData()      # slots: 0 antenna paint, 1 metal, 2 black, 3 lens_red, 4 lens_green, 5 lens_clear, 6 lens_beacon
    # ------------------------------------------------ antennas (top)
    for X, kind in ((7.2, 'tcas'), (11.6, 'vhf'), (14.6, 'gps'), (21.8, 'vhf'), (26.5, 'sat')):
        z = fus_top_z(X)
        if kind == 'vhf':
            blade(md, (X, 0, z), 0.34, 0.14, 0.34, 32, 0.022)
        elif kind == 'tcas':
            blade(md, (X, 0, z), 0.42, 0.34, 0.06, 5, 0.05)
        elif kind == 'gps':
            dome(md, (X, 0, z - 0.005), 0.07, 0.035)
        else:
            blade(md, (X, 0, z), 0.22, 0.10, 0.12, 25, 0.02)
    # (bottom)
    for X, kind in ((5.9, 'atc'), (6.6, 'tcas'), (8.6, 'vhf'), (10.3, 'dme'), (12.3, 'adf'), (24.8, 'ra')):
        z = fus_bot_z(X)
        if kind == 'vhf':
            blade(md, (X, 0, z), 0.34, 0.14, 0.30, 32, 0.022, up=(0, 0, -1))
        elif kind in ('atc', 'dme'):
            for y in (-0.25, 0.25):
                zz = float(S.fus_point(X, math.pi - y / 1.9)[1])
                blade(md, (X, y, zz), 0.10, 0.05, 0.09, 30, 0.015, up=(0, 0, -1))
        elif kind == 'tcas':
            blade(md, (X, 0, z), 0.42, 0.34, 0.05, 5, 0.05, up=(0, 0, -1))
        elif kind == 'adf':
            dome(md, (X, 0, z + 0.005), 0.18, 0.025, axis=(0, 0, -1))
        else:
            for y in (-0.3, 0.3):
                dome(md, (X, y, z + 0.01), 0.09, 0.015, axis=(0, 0, -1))
    # drain masts on the belly
    for X in (9.6, 23.0):
        blade(md, (X, 0.0, fus_bot_z(X)), 0.12, 0.06, 0.10, 40, 0.018, up=(0, 0, -1))
    # tail skid
    X = 33.55
    z = fus_bot_z(X)
    blade(md, (X, 0, z + 0.05), 0.75, 0.40, 0.16, -10, 0.12, up=(0, 0, -1))
    # ------------------------------------------------ pitot probes, AOA vanes, TAT probe
    for side in (-1, 1):
        for X, Z in ((2.18, 2.92), (2.46, 2.76)):
            th = S.fus_theta_at(X, side, Z)
            Y, Zs = S.fus_point(X, th)
            nrm = np.array([0, np.sign(Y), 0.0])
            p0 = np.array([X, float(Y), float(Zs)])
            p1 = p0 + np.array([0, 0.09 * side, -0.02])
            p2 = p1 + np.array([-0.16, 0, 0])
            m = mk.tube(TB(*p0), TB(*p1), 0.012, 0.008, n=8, mat=1)
            md.merge(m)
            md.merge(mk.tube(TB(*p1), TB(*p2), 0.008, 0.006, n=8, mat=1))
        # AOA vane
        X, Z = 3.05, 3.02
        th = S.fus_theta_at(X, side, Z)
        Y, Zs = S.fus_point(X, th)
        base = np.array([X, float(Y), float(Zs)])
        md.merge(mk.tube(TB(*base), TB(*(base + np.array([0, 0.02 * side, 0]))), 0.03, n=12, mat=1))
        blade(md, base + np.array([0, 0.02 * side, 0]), 0.10, 0.06, 0.09, 30, 0.008, up=(0, side, 0), mat=2)
    # TAT probe (left, below the window line)
    X, Z = 5.0, 2.55
    th = S.fus_theta_at(X, -1, Z)
    Y, Zs = S.fus_point(X, th)
    blade(md, (X, float(Y), float(Zs)), 0.10, 0.07, 0.08, 20, 0.02, up=(0, -1, 0), mat=1)
    # ------------------------------------------------ windshield wipers (parked along the lower frame)
    for side in (-1, 1):
        p0 = np.array([2.36, side * 0.80, 3.60])
        p1 = np.array([2.27, side * 0.20, 3.65])
        md.merge(mk.tube(TB(*p0), TB(*p1), 0.009, 0.007, n=6, mat=2))
        md.merge(mk.tube(TB(*(p0 + np.array([0.005, 0, 0.012]))), TB(*(p1 + np.array([0.005, 0, 0.012]))), 0.005, n=6, mat=2))
        md.merge(mk.tube(TB(*(p0 - np.array([0, 0, 0.0]))), TB(*(p0 + np.array([0.03, 0, 0.03]))), 0.018, n=10, mat=2))
    # ------------------------------------------------ light lenses + empties
    sts = S.wing_station(np.array([S.W_LA - 0.05]))
    Xle, Yt, Zt, c = float(sts['X'][0]), float(sts['Y'][0]), float(sts['Z'][0]), float(sts['c'][0])
    for side, sfx, lm in ((-1, 'L', 3), (1, 'R', 4)):
        pos = np.array([Xle - 0.02, side * Yt, Zt + 0.03])
        dome(md, pos + np.array([0.05, 0, 0]), 0.055, 0.08, axis=(-1, 0, 0), mat=lm, n=12)
        mk.empty(f'light_nav_{sfx}', TB(*(pos + np.array([-0.04, 0, 0]))))
        mk.empty(f'light_strobe_{sfx}', TB(*(pos + np.array([-0.02, side * 0.06, 0.02]))))
        tpos = np.array([Xle + c + 0.02, side * Yt, Zt + 0.02])
        dome(md, tpos - np.array([0.04, 0, 0]), 0.04, 0.06, axis=(1, 0, 0), mat=5, n=10)
        mk.empty(f'light_tail_{sfx}', TB(*(tpos + np.array([0.03, 0, 0]))))
        # wing-root landing + runway turnoff lights (clear lenses in the leading edge)
        for name, Yl in (('landing', 2.75), ('turnoff', 2.25)):
            l = S.wing_l_of_Y(Yl)
            st = S.wing_station(np.array([l]))
            p = np.array([float(st['X'][0]) + 0.005, side * float(st['Y'][0]), float(st['Z'][0]) + 0.02])
            dome(md, p + np.array([0.045, 0, 0]), 0.075, 0.05, axis=(-1, 0, 0), mat=5, n=14)
            e = mk.empty(f'light_{name}_{sfx}', TB(*(p - np.array([0.02, 0, 0]))))
            e.rotation_euler = (math.radians(-3), 0, math.radians(-side * (0 if name == 'landing' else 18)))
        # logo lights on the stabiliser upper surface, looking at the fin
        l = 3.0 / math.cos(S.S_DIHEDRAL)
        st = S.stab_station(np.array([l]))
        x2, y2 = S.airfoil(np.array([0.30]), float(st['tc'][0]), float(st['camber'][0]), True)
        stt = {k: float(v[0]) for k, v in st.items()}
        X, Y, Z = S.section_to_3d(stt, x2, y2)
        p = np.array([float(X[0]), side * float(Y[0]), float(Z[0])])
        dome(md, p - np.array([0, 0, 0.005]), 0.04, 0.03, mat=5, n=10)
        mk.empty(f'light_logo_{sfx}', TB(*(p + np.array([0, 0, 0.04]))))
    # beacons
    Xb = 19.2
    dome(md, (Xb, 0, fus_top_z(Xb) - 0.01), 0.075, 0.09, mat=6)
    mk.empty('light_beacon_top', TB(Xb, 0, fus_top_z(Xb) + 0.08))
    Xb2 = 16.6
    zb = fus_bot_z(Xb2)
    dome(md, (Xb2, 0, zb + 0.01), 0.075, 0.09, axis=(0, 0, -1), mat=6)
    mk.empty('light_beacon_bottom', TB(Xb2, 0, zb - 0.08))
    # tail cone strobe (+ contract name `light_tail`; the NG's white aft position lights are the wingtip
    # light_tail_L/R, so the rig draws no glow on this one)
    mk.empty('light_strobe_tail', TB(39.30, 0, 4.30))
    mk.empty('light_tail', TB(39.35, 0, 4.12))
    dome(md, (39.25, 0, 4.30), 0.03, 0.04, axis=(0, 0, 1), mat=5, n=10)
    mk.orient_outward(md) if False else None
    o = mk.obj('details', md, [mats['antenna'], mats['metal'], mats['black'], mats['lens_red'], mats['lens_green'],
                               mats['lens_clear'], mats['lens_beacon']], sharp_angle=50)
    created.append(o)
    return created


def wicks(te_points_g, length=0.10):
    """Static discharge wicks: list of (point, direction) in the ground frame -> MeshData (blender)."""
    md = MeshData()
    for p, d in te_points_g:
        d = np.asarray(d, float); d /= np.linalg.norm(d)
        a = TB(*np.asarray(p)); b = TB(*(np.asarray(p) + d * length))
        md.merge(mk.tube(a, b, 0.0035, 0.002, n=5, mat=0))
    return md
