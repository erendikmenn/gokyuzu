"""F-16C fuselage loft: key cross-sections digitized from a 1:1-scaled 3-view (see build notes) in the drawing frame.

Each half-section (right side, y >= 0) has 11 control points C0..C10 from the top centerline around to the bottom
centerline:
  C0 top center, C1 upper shoulder, C2 upper side (canopy sill level), C3 LEX root / upper blend, C4 LEX / strake edge,
  C5 LEX underside root, C6 lower side top (nacelle top), C7 lower side, C8 bottom corner, C9 bottom, C10 bottom center.
Coordinates are interpolated along s with monotone cubics; the section curve is a Hermite spline with a corner at C4.
"""
import math
import numpy as np
from f16_geom import pchip, section_curve, grid_faces, cap_fan, MeshData, to_blender

NC = 11
SEG_COUNTS = [5, 5, 6, 7, 6, 4, 5, 4, 4, 4]   # samples per segment (per half)
NHALF = sum(SEG_COUNTS) + 1                    # 51 samples per half-section (incl. both centerline points)


def _nose(zt, zb, hw, zw, n_up=2.25, n_lo=2.5):
    ang = [90, 66, 43, 21, 0, -14, -30, -46, -62, -77, -90]
    pts = []
    for a in ang:
        t = math.radians(a)
        c, s = abs(math.cos(t)), math.sin(t)
        if a >= 0:
            y = hw * c ** (2 / n_up); z = zw + (zt - zw) * abs(s) ** (2 / n_up)
        else:
            y = hw * c ** (2 / n_lo); z = zw - (zw - zb) * abs(s) ** (2 / n_lo)
        pts.append((y, z))
    return pts


def _tube(zc, r_top, r_side, r_bot):
    ang = [90, 70, 50, 26, 0, -20, -40, -58, -72, -84, -90]
    pts = []
    for a in ang:
        t = math.radians(a)
        c, s = math.cos(t), math.sin(t)
        rv = r_top if a >= 0 else r_bot
        pts.append((r_side * c, zc + rv * s))
    return pts


# (s, points C0..C10 as (y,z), sharpness at C4)
def key_stations():
    K = []
    # --- radome / nose (top, bottom, half-width from the side/top views) ---
    nose = [  # s, zt, zb, hw
        (0.47, 1.640, 1.600, 0.010),
        (0.50, 1.662, 1.582, 0.034),
        (0.55, 1.684, 1.572, 0.048),
        (0.60, 1.704, 1.564, 0.064),
        (0.70, 1.747, 1.542, 0.104),
        (0.80, 1.793, 1.527, 0.148),
        (1.00, 1.875, 1.499, 0.231),
        (1.30, 1.985, 1.469, 0.335),
        (1.60, 2.082, 1.455, 0.414),
        (2.00, 2.204, 1.460, 0.473),
        (2.20, 2.252, 1.467, 0.496),
        (2.50, 2.317, 1.476, 0.528),
        (2.78, 2.392, 1.490, 0.553),
    ]
    for s, zt, zb, hw in nose:
        f = (s - 0.47) / (2.78 - 0.47)
        zw = zb + (zt - zb) * (0.5 - 0.06 * f)
        K.append((s, _nose(zt, zb, hw, zw), 0.0))
    # --- cockpit / LEX / intake ---
    K.append((3.00, [(0, 2.430), (0.20, 2.420), (0.40, 2.350), (0.52, 2.130), (0.624, 1.865), (0.585, 1.780),
                     (0.560, 1.700), (0.520, 1.620), (0.450, 1.560), (0.25, 1.515), (0, 1.508)], 0.55))
    K.append((3.50, [(0, 2.450), (0.22, 2.440), (0.43, 2.370), (0.56, 2.100), (0.702, 1.865), (0.600, 1.790),
                     (0.565, 1.710), (0.525, 1.625), (0.450, 1.565), (0.25, 1.530), (0, 1.523)], 0.95))
    K.append((4.00, [(0, 2.490), (0.23, 2.480), (0.45, 2.400), (0.585, 2.090), (0.746, 1.866), (0.630, 1.795),
                     (0.580, 1.715), (0.535, 1.635), (0.460, 1.577), (0.25, 1.548), (0, 1.540)], 1.0))
    K.append((4.57, [(0, 2.550), (0.23, 2.540), (0.46, 2.450), (0.60, 2.090), (0.800, 1.867), (0.665, 1.800),
                     (0.610, 1.720), (0.560, 1.645), (0.470, 1.590), (0.25, 1.565), (0, 1.558)], 1.0))
    # intake lip plane: the nacelle appears
    K.append((4.60, [(0, 2.554), (0.23, 2.544), (0.46, 2.453), (0.60, 2.091), (0.803, 1.867), (0.700, 1.790),
                     (0.720, 1.560), (0.700, 1.330), (0.580, 1.100), (0.32, 1.035), (0, 1.025)], 1.0))
    K.append((4.75, [(0, 2.575), (0.23, 2.565), (0.46, 2.475), (0.605, 2.098), (0.826, 1.867), (0.720, 1.795),
                     (0.745, 1.560), (0.745, 1.310), (0.610, 1.050), (0.33, 0.968), (0, 0.960)], 1.0))
    K.append((5.00, [(0, 2.620), (0.23, 2.605), (0.46, 2.510), (0.610, 2.110), (0.873, 1.868), (0.740, 1.800),
                     (0.765, 1.560), (0.765, 1.300), (0.630, 1.030), (0.34, 0.950), (0, 0.943)], 1.0))
    K.append((5.50, [(0, 2.700), (0.23, 2.685), (0.47, 2.570), (0.630, 2.130), (0.993, 1.870), (0.770, 1.800),
                     (0.780, 1.560), (0.780, 1.290), (0.645, 1.015), (0.345, 0.932), (0, 0.925)], 1.0))
    K.append((6.30, [(0, 2.765), (0.24, 2.740), (0.49, 2.585), (0.680, 2.130), (1.225, 1.875), (0.800, 1.795),
                     (0.790, 1.560), (0.790, 1.280), (0.655, 1.005), (0.350, 0.935), (0, 0.929)], 1.0))
    K.append((7.00, [(0, 2.697), (0.26, 2.670), (0.52, 2.520), (0.750, 2.130), (1.346, 1.885), (0.840, 1.795),
                     (0.795, 1.560), (0.795, 1.270), (0.660, 1.020), (0.350, 0.962), (0, 0.957)], 1.0))
    K.append((7.22, [(0, 2.672), (0.27, 2.645), (0.53, 2.495), (0.780, 2.110), (1.360, 1.890), (0.855, 1.797),
                     (0.795, 1.560), (0.795, 1.270), (0.662, 1.024), (0.350, 0.966), (0, 0.962)], 0.9))
    # wing region: the strake edge retreats inside the wing root
    K.append((7.60, [(0, 2.640), (0.28, 2.615), (0.54, 2.470), (0.820, 2.080), (1.100, 1.915), (0.870, 1.800),
                     (0.795, 1.560), (0.795, 1.270), (0.665, 1.030), (0.350, 0.978), (0, 0.975)], 0.4))
    K.append((8.50, [(0, 2.620), (0.30, 2.600), (0.56, 2.450), (0.850, 2.060), (1.080, 1.920), (0.880, 1.800),
                     (0.795, 1.560), (0.795, 1.260), (0.665, 1.040), (0.350, 0.992), (0, 0.990)], 0.35))
    K.append((9.50, [(0, 2.620), (0.30, 2.600), (0.57, 2.440), (0.860, 2.050), (1.070, 1.925), (0.880, 1.810),
                     (0.795, 1.565), (0.795, 1.260), (0.665, 1.060), (0.350, 1.018), (0, 1.015)], 0.3))
    K.append((10.50, [(0, 2.620), (0.30, 2.600), (0.58, 2.430), (0.860, 2.020), (1.060, 1.925), (0.880, 1.830),
                      (0.790, 1.580), (0.785, 1.270), (0.655, 1.080), (0.345, 1.040), (0, 1.037)], 0.2))
    # aft strakes (shelves) beside the engine
    K.append((11.00, [(0, 2.620), (0.30, 2.600), (0.58, 2.420), (0.850, 2.040), (1.050, 1.955), (0.870, 1.855),
                      (0.780, 1.600), (0.770, 1.280), (0.640, 1.100), (0.340, 1.062), (0, 1.059)], 0.0))
    K.append((12.00, [(0, 2.615), (0.28, 2.590), (0.55, 2.420), (0.800, 2.055), (1.050, 1.960), (0.800, 1.860),
                      (0.720, 1.620), (0.680, 1.330), (0.550, 1.150), (0.300, 1.110), (0, 1.105)], 0.0))
    K.append((13.00, [(0, 2.550), (0.26, 2.520), (0.50, 2.380), (0.720, 2.060), (1.050, 1.965), (0.720, 1.870),
                      (0.660, 1.650), (0.620, 1.400), (0.480, 1.240), (0.260, 1.195), (0, 1.190)], 0.0))
    K.append((13.30, [(0, 2.530), (0.25, 2.500), (0.48, 2.370), (0.700, 2.060), (1.050, 1.965), (0.700, 1.870),
                      (0.640, 1.660), (0.600, 1.420), (0.460, 1.270), (0.250, 1.230), (0, 1.225)], 0.0))
    # shelf ends (speedbrake hinge face); round engine tube to the nozzle
    K.append((13.36, _tube(1.885, 0.635, 0.625, 0.640), 0.0))
    K.append((13.62, _tube(1.885, 0.600, 0.595, 0.600), 0.0))
    K.append((13.90, _tube(1.885, 0.566, 0.566, 0.566), 0.0))
    return K


_KS = None


def _key():
    global _KS
    if _KS is None:
        K = key_stations()
        s = np.array([k[0] for k in K])
        P = np.array([k[1] for k in K], float)      # (nk, 11, 2)
        sh = np.array([k[2] for k in K], float)
        _KS = (s, P, sh)
    return _KS


def control_points(s):
    ks, P, sh = _key()
    s = np.atleast_1d(s)
    Pi = pchip(ks, P, s)        # (n, 11, 2)
    shi = np.interp(s, ks, sh)
    return Pi, shi


def half_section(s):
    """Sampled right half-section at station s -> (NHALF,2) array (y,z), param array in [0,10]."""
    Pi, shi = control_points(s)
    P = Pi[0].copy()
    P[0, 0] = 0.0
    P[-1, 0] = 0.0
    sharp = np.zeros(NC)
    sharp[4] = shi[0]
    pts, par = section_curve(P, sharp, SEG_COUNTS)
    pts[:, 0] = np.maximum(pts[:, 0], 0.0)
    return pts, par


S_START, S_END = 0.47, 13.90
BREAKS = [4.57, 4.60, 13.30, 13.36]


def stations():
    out = []
    s = S_START
    while s < S_END - 1e-6:
        out.append(s)
        if s < 0.8:
            ds = 0.025
        elif s < 3.0:
            ds = 0.045
        elif s < 7.6:
            ds = 0.05
        else:
            ds = 0.075
        s += ds
    out.append(S_END)
    out = sorted(set([round(x, 5) for x in out] + BREAKS))
    # drop stations too close to the breaks (keep the breaks)
    res = []
    for x in out:
        if any(abs(x - b) < 0.012 and x != b for b in BREAKS):
            continue
        res.append(x)
    return np.array(res)


def arc_lengths(pts):
    d = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    return np.concatenate([[0], np.cumsum(d)])


def build_rings():
    S = stations()
    rings = np.zeros((len(S), NHALF, 2))
    arcs = np.zeros((len(S), NHALF))
    for i, s in enumerate(S):
        pts, _ = half_section(s)
        rings[i] = pts
        arcs[i] = arc_lengths(pts)
    return S, rings, arcs


def fuselage_mesh(uv_fn=None):
    """Closed fuselage surface. uv_fn(side, s, arc) -> (u,v) with side 'R'/'L' (arc from the top centerline)."""
    S, rings, arcs = build_rings()
    ns = len(S)
    nh = NHALF
    nring = 2 * nh - 2
    verts = np.zeros((ns, nring, 3))
    for i in range(ns):
        y = rings[i, :, 0]; z = rings[i, :, 1]
        full_y = np.concatenate([y, -y[-2:0:-1]])
        full_z = np.concatenate([z, z[-2:0:-1]])
        verts[i] = to_blender(np.full(nring, S[i]), full_y, full_z)
    V = verts.reshape(-1, 3)
    faces = []
    uvs = []
    col_half = lambda j: (('R', j) if j <= nh - 1 else ('L', nring - j))
    for i in range(ns - 1):
        for j in range(nring):
            j2 = (j + 1) % nring
            a, b, c, d = i * nring + j, i * nring + j2, (i + 1) * nring + j2, (i + 1) * nring + j
            # face orientation: outward normals. Ring runs top->right->bottom->left (viewed from the front, +s aft)
            faces.append((a, d, c, b))
            if uv_fn is not None:
                side = 'R' if j < nh - 1 else 'L'
                cor = []
                for (ii, jj) in ((i, j), (i + 1, j), (i + 1, j2), (i, j2)):
                    sd, k = col_half(jj)
                    if jj == 0:
                        k = 0
                    if side == 'L' and jj == 0:
                        k = 0
                    if side == 'R' and jj == nh - 1:
                        k = nh - 1
                    cor.append(uv_fn(side, S[ii], arcs[ii, k]))
                uvs.append(cor)
    # nose cap (fan to a point slightly ahead) and aft cap
    tip = len(V)
    V = np.concatenate([V, to_blender([S[0] - 0.012], [0.0], [rings[0, :, 1].mean()])])
    ring0 = list(range(0, nring))
    for f in cap_fan(ring0, tip, flip=False):
        faces.append(f)
        if uv_fn is not None:
            uvs.append([uv_fn('R', S[0], 0.0)] * 3)
    aft = len(V)
    zc = 0.5 * (rings[-1, 0, 1] + rings[-1, -1, 1])
    V = np.concatenate([V, to_blender([S[-1]], [0.0], [zc])])
    ringN = list(range((ns - 1) * nring, ns * nring))
    for f in cap_fan(ringN, aft, flip=True):
        faces.append(f)
        if uv_fn is not None:
            uvs.append([uv_fn('R', S[-1], 0.0)] * 3)
    m = MeshData(V, faces, uvs if uv_fn is not None else None, 'fuselage')
    # sharp edge rows along C4 where the LEX is sharp
    Pk, shk = control_points(S)
    c4 = sum(SEG_COUNTS[:4])
    for i in range(ns - 1):
        if shk[i] > 0.6 and shk[i + 1] > 0.6:
            for jj in (c4, nring - c4):
                m.sharp_edges.append((i * nring + jj, (i + 1) * nring + jj))
    m.meta = dict(S=S, rings=rings, arcs=arcs, nring=nring)
    return m


def surface_point(s, y_target, upper=True):
    """z of the fuselage surface at station s and lateral offset y (upper or lower side)."""
    pts, _ = half_section(s)
    c4 = sum(SEG_COUNTS[:4])
    seg = pts[:c4 + 1] if upper else pts[c4:]
    ys, zs = seg[:, 0], seg[:, 1]
    # find the first crossing of y_target
    for k in range(len(ys) - 1):
        y0, y1 = ys[k], ys[k + 1]
        if (y0 - y_target) * (y1 - y_target) <= 0 and y0 != y1:
            t = (y_target - y0) / (y1 - y0)
            return zs[k] + t * (zs[k + 1] - zs[k])
    return float(zs[np.argmin(np.abs(ys - y_target))])


def surface_normal(s, y_target, upper=True):
    """Outward surface normal (ds, dy, dz) of the fuselage at station s, lateral offset |y| (drawing frame).
    The longitudinal slope is included via a finite difference in s."""
    sign = 1.0 if y_target >= 0 else -1.0
    ya = abs(y_target)
    pts, _ = half_section(s)
    c4 = sum(SEG_COUNTS[:4])
    seg = pts[:c4 + 1] if upper else pts[c4:]
    ys, zs = seg[:, 0], seg[:, 1]
    k = int(np.argmin(np.abs(ys - ya)))
    k0, k1 = max(k - 1, 0), min(k + 1, len(ys) - 1)
    ty, tz = ys[k1] - ys[k0], zs[k1] - zs[k0]
    ny, nz = tz, -ty              # rotate tangent (going outward/down) by -90 deg -> outward normal
    if nz < 0 and upper:
        ny, nz = -ny, -nz
    # longitudinal slope
    ds = 0.02
    z1 = surface_point(s + ds, ya, upper); z0 = surface_point(s - ds, ya, upper)
    dzds = (z1 - z0) / (2 * ds)
    n = np.array([-dzds * abs(nz), ny * sign, nz])
    return n / np.linalg.norm(n)
