"""UH-60M exterior hull shapes (design frame G: x right, y forward from the mast, z up from the ground)."""
import math
import numpy as np
from lib import (pchip, half_profile, ring_from_half, loft_rings, new_mesh_obj, airfoil)

# ------------------------------------------------------------------------------------------------ fuselage
# station table: y, zb (belly), zm (z of max width), zt (roof crown), w (half width), nb, nt, tt (tumblehome)
FUSE = np.array([
    # y      zb     zm     zt     w      nb    nt    tt
    [4.745, 0.975, 1.010, 1.045, 0.060, 2.0, 2.0, 0.00],
    [4.715, 0.880, 1.000, 1.150, 0.360, 3.0, 2.6, 0.00],     # blunt, broad nose: nearly flat front face (UH-60M head-on)
    [4.620, 0.770, 0.995, 1.270, 0.580, 3.3, 2.9, 0.02],
    [4.450, 0.690, 0.995, 1.410, 0.720, 3.4, 3.0, 0.04],
    [4.200, 0.635, 1.005, 1.560, 0.810, 3.4, 2.9, 0.07],
    [3.950, 0.605, 1.020, 1.665, 0.860, 3.2, 2.8, 0.10],
    [3.710, 0.585, 1.040, 1.735, 0.900, 3.2, 2.8, 0.12],
    [3.300, 0.565, 1.070, 1.930, 1.010, 3.2, 3.3, 0.13],
    [2.900, 0.540, 1.095, 2.110, 1.095, 3.4, 4.0, 0.12],
    [2.570, 0.515, 1.115, 2.230, 1.145, 3.5, 4.4, 0.12],
    [2.200, 0.490, 1.130, 2.265, 1.170, 3.6, 4.6, 0.12],
    [1.500, 0.450, 1.140, 2.280, 1.180, 3.8, 4.7, 0.12],
    [0.000, 0.400, 1.140, 2.280, 1.180, 3.8, 4.7, 0.12],
    [-1.10, 0.375, 1.140, 2.280, 1.180, 3.8, 4.7, 0.12],
    [-1.70, 0.380, 1.140, 2.270, 1.170, 3.6, 4.4, 0.13],
    [-2.50, 0.420, 1.160, 2.230, 1.080, 3.2, 3.6, 0.18],
    [-3.30, 0.460, 1.200, 2.130, 0.900, 3.0, 3.0, 0.22],
    [-4.10, 0.500, 1.240, 1.985, 0.665, 2.8, 2.8, 0.20],
    [-5.00, 0.560, 1.250, 1.875, 0.525, 2.6, 2.6, 0.18],
    [-6.20, 0.690, 1.240, 1.725, 0.430, 2.5, 2.5, 0.15],
    [-7.50, 0.780, 1.220, 1.555, 0.360, 2.4, 2.4, 0.12],
    [-8.80, 0.860, 1.200, 1.440, 0.300, 2.4, 2.4, 0.10],
    [-9.60, 0.900, 1.190, 1.400, 0.270, 2.4, 2.4, 0.10],
])


def fuse_params(y):
    """Interpolated section parameters at station(s) y."""
    ys = FUSE[::-1, 0]
    out = [pchip(ys, FUSE[::-1, k], y) for k in range(1, 8)]
    return out


def fuse_halfwidth_at(y, z):
    """Half width of the fuselage at station y and height z (for placing parts on the skin)."""
    zb, zm, zt, w, nb, nt, tt = [float(v) for v in fuse_params(y)]
    x, zz = half_profile(w, zb, zm, zt, nb, nt, tt, n=200)
    return float(np.interp(z, zz[:101] if False else np.sort(zz), x[np.argsort(zz)]))


def build_fuselage(mat, n_half=40, stations=None):
    if stations is None:
        # denser near the nose and the tail-cone transition
        s1 = np.linspace(4.745, 3.6, 22) ** 1.0
        s2 = np.linspace(3.55, -1.6, 34)
        s3 = np.linspace(-1.75, -9.6, 44)
        stations = np.concatenate([s1, s2, s3])
    rings = []
    bias = lambda u: u  # arc-length uniform
    for y in stations:
        zb, zm, zt, w, nb, nt, tt = [float(v) for v in fuse_params(y)]
        x, z = half_profile(w, zb, zm, zt, nb, nt, tt, n=n_half, bias=bias)
        rings.append(ring_from_half(y, x, z))
    tip = (0.0, 4.752, 1.010)
    verts, faces = loft_rings(rings, cap_start=tip, cap_end='fan')
    return new_mesh_obj('fuselage', verts, faces, mat, smooth=True)


# ------------------------------------------------------------------------------------------------ doghouse
DOG = np.array([
    # y      zb     zt     w     nt
    [2.55, 2.02, 2.20, 0.36, 3.0],
    [2.30, 2.02, 2.40, 0.54, 3.5],
    [1.90, 2.02, 2.60, 0.64, 4.0],
    [1.20, 2.02, 2.73, 0.70, 4.5],
    [0.20, 2.02, 2.77, 0.72, 4.5],
    [-1.00, 2.02, 2.765, 0.72, 4.5],
    [-1.80, 2.02, 2.72, 0.71, 4.3],
    [-2.60, 2.00, 2.53, 0.64, 4.0],
    [-3.40, 1.94, 2.25, 0.52, 3.6],
    [-4.10, 1.86, 2.03, 0.38, 3.2],
    [-4.60, 1.82, 1.93, 0.22, 3.0],
])


def build_doghouse(mat, n_half=28):
    ys = DOG[::-1, 0]
    stations = np.linspace(2.55, -4.6, 60)
    rings = []
    for y in stations:
        zb, zt, w, nt = [float(pchip(ys, DOG[::-1, k], y)) for k in range(1, 5)]
        zm = zb + 0.12
        x, z = half_profile(w, zb - 0.05, zm, zt, 2.0, nt, 0.06, n=n_half)
        rings.append(ring_from_half(y, x, z))
    verts, faces = loft_rings(rings, cap_start='fan', cap_end='fan')
    return new_mesh_obj('doghouse', verts, faces, mat, smooth=True)


# ------------------------------------------------------------------------------------------------ engine nacelles
NAC_X, NAC_Z = 0.86, 2.40
NAC_Y0, NAC_Y1 = 0.88, -1.50


def nacelle_rings(side, n=32):
    """Engine nacelle rings from the inlet lip aft. side = +1 right / -1 left."""
    prof = np.array([
        # y       ry     rz    (semi axes)
        [0.88, 0.235, 0.255],
        [0.85, 0.285, 0.305],
        [0.78, 0.310, 0.330],
        [0.56, 0.325, 0.345],
        [-0.40, 0.330, 0.350],
        [-1.10, 0.320, 0.338],
        [-1.50, 0.290, 0.300],
    ])
    rings = []
    ys = np.linspace(prof[0, 0], prof[-1, 0], 26)
    for y in ys:
        rx = float(np.interp(-y, -prof[:, 0], prof[:, 1]))
        rz = float(np.interp(-y, -prof[:, 0], prof[:, 2]))
        a = np.linspace(0, 2 * math.pi, n, endpoint=False)
        ca, sa = np.cos(a), np.sin(a)
        # slightly squarish section (superellipse exponent 2.6)
        e = 2 / 2.6
        x = side * NAC_X + rx * np.sign(ca) * np.abs(ca) ** e
        z = NAC_Z + rz * np.sign(sa) * np.abs(sa) ** e
        rings.append(np.stack([x, np.full_like(x, y), z], 1))
    return rings


def build_nacelle(side, mat):
    rings = nacelle_rings(side)
    # inlet lip: roll inward to an inner ring, then the duct wall goes back to the engine face
    r0 = rings[0]
    c = np.array([side * NAC_X, 0, NAC_Z])
    inner = []
    for k, f in enumerate((0.86, 0.74, 0.70)):
        rr = r0.copy()
        rr[:, 0] = c[0] + (r0[:, 0] - c[0]) * f
        rr[:, 2] = c[2] + (r0[:, 2] - c[2]) * f
        rr[:, 1] = r0[0, 1] - [0.0, 0.05, 0.20][k]
        inner.append(rr)
    rings = inner[::-1] + rings
    verts, faces = loft_rings(rings, cap_start='fan', cap_end='fan')
    if side < 0:
        faces = [f[::-1] for f in faces]
    return new_mesh_obj(f'nacelle_{"R" if side > 0 else "L"}', verts, faces, mat, smooth=True)


# ------------------------------------------------------------------------------------------------ HIRSS exhaust
HIRSS_Y0, HIRSS_Y1 = -1.42, -2.62      # suppressor fairing: straight continuation of the nacelle, oblique outboard exit


def hirss_path(side):
    """Centre line of the suppressor (nacelle axis, toeing slightly outboard and up aft). Last point = exit centre."""
    pts = np.array([[NAC_X, HIRSS_Y0, NAC_Z], [NAC_X + 0.05, -1.90, NAC_Z + 0.013], [NAC_X + 0.20, -2.30, NAC_Z + 0.03],
                    [NAC_X + 0.24, -2.40, NAC_Z + 0.035]])
    pts[:, 0] *= side
    return pts


def hirss_ring(side, y, n=32, cut=None):
    """Suppressor section at station y (rx, rz semi axes shrinking a little aft). cut: exit plane -> per-point y."""
    t = (HIRSS_Y0 - y) / (HIRSS_Y0 - HIRSS_Y1)
    rx = 0.318 - 0.03 * t
    rz = 0.335 - 0.045 * t
    cx = side * (NAC_X + 0.30 * t * t)          # toes out: 9 ft 8 in overall width across the suppressors
    cz = NAC_Z + 0.04 * t
    a = np.linspace(0, 2 * math.pi, n, endpoint=False)
    ca, sa = np.cos(a), np.sin(a)
    e = 2 / 2.6
    x = cx + rx * np.sign(ca) * np.abs(ca) ** e
    z = cz + rz * np.sign(sa) * np.abs(sa) ** e
    yy = np.full_like(x, y)
    if cut is not None:
        # oblique exit: the outboard side ends ~0.55 m further forward than the inboard side, the top a little aft
        o = side * ca                               # +1 outboard ... -1 inboard
        yy = y + 0.28 * (1 + o) - 0.06 * sa
    return np.stack([x, yy, z], 1)


def build_hirss(side, mat):
    ys = list(np.linspace(HIRSS_Y0, HIRSS_Y1 + 0.25, 10))
    rings = [hirss_ring(side, y) for y in ys]
    rings.append(hirss_ring(side, HIRSS_Y1, cut=True))
    # rolled exit lip turning inward, then the dark inner duct wall a short way back in
    lip = hirss_ring(side, HIRSS_Y1, cut=True)
    c = lip.mean(0)
    inner = c + (lip - c) * 0.88
    inner[:, 1] += 0.03
    deep = c + (lip - c) * 0.80
    deep[:, 1] += 0.35
    rings += [inner, deep]
    verts, faces = loft_rings(rings, cap_start=None, cap_end='fan')
    if side < 0:
        faces = [f[::-1] for f in faces]
    return new_mesh_obj(f'hirss_{"R" if side > 0 else "L"}', verts, faces, mat, smooth=True, sharp_deg=55)


# ------------------------------------------------------------------------------------------------ tail pylon
PYLON_BASE = dict(y_le=-7.57, z=1.20, chord=2.06)
PYLON_TOP = dict(y_le=-9.66, z=3.30, chord=1.16)


def build_pylon(mat, n=26):
    af = airfoil(n=n, t=0.15)
    rings = []
    zs = np.linspace(0.95, 3.40, 16)
    for z in zs:
        f = (z - PYLON_BASE['z']) / (PYLON_TOP['z'] - PYLON_BASE['z'])
        f = min(max(f, -0.2), 1.05)
        y_le = PYLON_BASE['y_le'] + (PYLON_TOP['y_le'] - PYLON_BASE['y_le']) * f
        chord = PYLON_BASE['chord'] + (PYLON_TOP['chord'] - PYLON_BASE['chord']) * f
        thick = chord * 0.15
        pts = []
        for (xc, zc) in af:
            pts.append((zc * chord, y_le - xc * chord, z))
        rings.append(np.array(pts))
    verts, faces = loft_rings(rings, cap_start='fan', cap_end='fan')
    faces = [f[::-1] for f in faces]
    return new_mesh_obj('pylon', verts, faces, mat, smooth=True, sharp_deg=60)


# ------------------------------------------------------------------------------------------------ stabilator
STAB_HINGE = (0.0, -9.15, 1.47)
STAB_SPAN = 4.38


def build_stabilator(mat, n=20):
    af = airfoil(n=n, t=0.13)
    rings = []
    xs = np.concatenate([np.linspace(-STAB_SPAN / 2, -0.35, 10), np.linspace(0.35, STAB_SPAN / 2, 10)])
    xs = np.linspace(-STAB_SPAN / 2, STAB_SPAN / 2, 25)
    for x in xs:
        s = abs(x) / (STAB_SPAN / 2)
        chord = 1.18 - 0.22 * s
        y_le = -8.80 - 0.10 * s
        tip_round = 1.0 if s < 0.96 else max(0.35, 1 - (s - 0.96) / 0.04 * 0.65)
        pts = []
        for (xc, zc) in af:
            pts.append((x, y_le - xc * chord, STAB_HINGE[2] + zc * chord * tip_round))
        rings.append(np.array(pts))
    verts, faces = loft_rings(rings, cap_start='fan', cap_end='fan')
    return new_mesh_obj('ctl_stabilator', verts, faces, mat, smooth=True, sharp_deg=50)


# ------------------------------------------------------------------------------------------------ tail drive-shaft cover
def build_shaft_cover(mat):
    rings = []
    ys = np.linspace(-3.9, -7.6, 20)
    for y in ys:
        zb, zm, zt, w, nb, nt, tt = [float(v) for v in fuse_params(y)]
        x, z = half_profile(0.17, zt - 0.10, zt - 0.02, zt + 0.10, 2.0, 2.2, 0.0, n=10)
        rings.append(ring_from_half(y, x, z))
    verts, faces = loft_rings(rings, cap_start='fan', cap_end='fan')
    return new_mesh_obj('shaft_cover', verts, faces, mat, smooth=True)
