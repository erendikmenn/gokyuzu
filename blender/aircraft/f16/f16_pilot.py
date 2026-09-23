"""Seated F-16 pilot (HGU-55/P helmet, MBU-20 mask, flight suit, harness, G-suit) for exterior views.

Two groups: 'helmet' (head + torso: hidden in the cockpit view, it would enclose the camera) and 'body' (arms, legs:
kept in the cockpit view so the pilot sees his own hands and knees). Built with numpy MeshData, drawing frame.
"""
import math
import numpy as np
from f16_geom import MeshData, to_blender, grid_faces
import f16_cockpit_layout as CL


def ellipsoid(c, r, axes=None, nu=20, nv=12, name='ell'):
    c = np.asarray(c, float)
    ax = np.eye(3) if axes is None else np.array([np.asarray(a, float) / np.linalg.norm(a) for a in axes])
    V = []
    for i in range(nv + 1):
        th = math.pi * i / nv
        for j in range(nu):
            ph = 2 * math.pi * j / nu
            p = np.array([r[0] * math.sin(th) * math.cos(ph), r[1] * math.sin(th) * math.sin(ph), r[2] * math.cos(th)])
            V.append(c + p @ ax)
    V = np.array(V)
    F = []
    for i in range(nv):
        for j in range(nu):
            j2 = (j + 1) % nu
            F.append((i * nu + j, i * nu + j2, (i + 1) * nu + j2, (i + 1) * nu + j))
    md = MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), F, None, name)
    return md


def capsule(p0, p1, r0, r1=None, n=14, rings=4, name='cap'):
    """Tapered limb segment with rounded ends (drawing frame)."""
    r1 = r0 if r1 is None else r1
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
    ax = p1 - p0; L = np.linalg.norm(ax); ax /= L
    tmp = np.array([0, 0, 1.0]) if abs(ax[2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(ax, tmp); u /= np.linalg.norm(u); v = np.cross(ax, u)
    prof = []
    for k in range(rings, 0, -1):             # start cap
        a = math.pi / 2 * k / rings
        prof.append((-r0 * math.sin(a), r0 * math.cos(a)))
    prof += [(0.0, r0), (L, r1)]
    for k in range(1, rings + 1):
        a = math.pi / 2 * k / rings
        prof.append((L + r1 * math.sin(a), r1 * math.cos(a)))
    V = []
    for x, r in prof:
        for j in range(n):
            ph = 2 * math.pi * j / n
            V.append(p0 + ax * x + r * (math.cos(ph) * u + math.sin(ph) * v))
    V = np.array(V)
    F = grid_faces(len(prof), n, wrap_c=True)
    return MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), F, None, name)


def build():
    """Returns dict group -> dict material key -> MeshData."""
    out = {'helmet': {}, 'body': {}}

    def add(group, key, md):
        g = out[group]
        if key not in g:
            g[key] = MeshData(np.zeros((0, 3)), [], None, key)
        g[key].add(md)

    hs, _, hz = CL.SEAT_HIP
    ang = CL.SEAT_BACK
    up = np.array((math.sin(ang), 0.0, math.cos(ang)))
    fwd = np.array((-math.cos(ang), 0.0, math.sin(ang)))
    H = np.array((hs, 0.0, hz + 0.05))
    eye = np.array(CL.EYE)
    # ---- head / helmet (centered ~9 cm behind the eyes, 4 cm above)
    head_c = eye + np.array((0.085, 0.0, 0.035))
    hax = (up * 0 + np.array((1.0, 0, 0)), np.array((0, 1.0, 0)), np.array((0, 0, 1.0)))
    add('helmet', 'helmet', ellipsoid(head_c, (0.135, 0.118, 0.145), nu=24, nv=14))
    # visor (dark, upper front) and oxygen mask (lower front) + hose
    add('helmet', 'visor', ellipsoid(head_c + np.array((-0.045, 0, 0.005)), (0.105, 0.112, 0.07), nu=20, nv=10))
    mask_c = eye + np.array((-0.055, 0.0, -0.075))
    add('helmet', 'mask', ellipsoid(mask_c, (0.055, 0.045, 0.06), nu=16, nv=10))
    add('helmet', 'mask', capsule(mask_c + np.array((0.0, 0.03, -0.04)), H + up * 0.40 + fwd * 0.13 + np.array((0, 0.10, 0)), 0.014, n=10, rings=2))
    # ---- torso (flight suit + survival vest), neck
    chest = H + up * 0.40 + fwd * 0.03
    tax = (fwd, np.array((0, 1.0, 0)), up)
    add('helmet', 'suit', ellipsoid(H + up * 0.66 + fwd * 0.06, (0.05, 0.06, 0.07), axes=tax))           # neck
    add('helmet', 'vest', ellipsoid(chest + fwd * 0.04, (0.12, 0.20, 0.27), axes=tax, nu=22, nv=12))
    add('helmet', 'suit', ellipsoid(H + up * 0.14 + fwd * 0.03, (0.12, 0.18, 0.14), axes=tax))           # hips
    for sg in (-1, 1):
        # shoulder harness straps
        a = H + up * 0.62 + fwd * 0.13 + np.array((0, sg * 0.09, 0))
        b = H + up * 0.20 + fwd * 0.15 + np.array((0, sg * 0.10, 0))
        add('helmet', 'strap', capsule(a, b, 0.018, n=8, rings=1))
    # ---- arms: right hand on the sidestick, left hand on the throttle
    sh_y = 0.19
    for sg, grip in ((1, np.array((3.955, 0.31, CL.CONSOLE_R['z0'] + 0.13))), (-1, np.array((3.975, -0.29, CL.CONSOLE_L['z0'] + 0.13)))):
        shoulder = H + up * 0.55 + fwd * 0.05 + np.array((0, sg * sh_y, 0))
        elbow = np.array((4.22, sg * 0.27, hz + 0.19))
        wrist = grip + np.array((0.06, 0, 0.0))
        add('body', 'suit', capsule(shoulder, elbow, 0.052, 0.045))
        add('body', 'suit', capsule(elbow, wrist, 0.043, 0.035))
        add('body', 'glove', ellipsoid(grip + np.array((0.01, 0, 0.01)), (0.05, 0.04, 0.045), nu=14, nv=8))
    # ---- legs (wave 6: below the canopy sill, seen only from the cockpit): G-suit thighs and calves with oval
    # sections, knee bulge, flight-suit ankles, boots; kneeboard strapped to the right thigh
    for sg in (-1, 1):
        hipj = H + np.array((-0.05, sg * 0.10, -0.01))
        knee = np.array((3.67, sg * 0.155, hz + 0.075))
        ankle = np.array((3.27, sg * 0.14, 2.02))
        add('body', 'gsuit', limb(hipj + np.array((0.04, 0, 0.0)), knee, [(0.0, 0.088, 0.068), (0.3, 0.084, 0.066), (0.65, 0.074, 0.060),
                                                                         (0.9, 0.062, 0.056), (1.0, 0.056, 0.052)]))
        add('body', 'gsuit', ellipsoid(knee + np.array((-0.004, 0, 0.004)), (0.052, 0.056, 0.056), nu=16, nv=10))
        add('body', 'gsuit', limb(knee, ankle, [(0.0, 0.050, 0.052), (0.25, 0.052, 0.056), (0.55, 0.046, 0.048), (0.8, 0.040, 0.040),
                                                (1.0, 0.036, 0.036)]))
        add('body', 'suit', limb(ankle + (knee - ankle) * 0.22, ankle, [(0.0, 0.040, 0.040), (1.0, 0.037, 0.037)]))
        foot = ankle + np.array((-0.02, 0.0, -0.035))
        add('body', 'boot', limb(ankle + np.array((0.03, 0, 0.03)), foot + np.array((-0.20, 0, -0.005)),
                                 [(0.0, 0.045, 0.042), (0.35, 0.052, 0.048), (0.7, 0.045, 0.040), (0.92, 0.038, 0.030), (1.0, 0.022, 0.018)],
                                 up=(0, 0, 1.0)))
        if sg > 0:
            # kneeboard on the right thigh: board + paper card + strap
            a = hipj + (knee - hipj) * 0.40
            b = hipj + (knee - hipj) * 0.95
            d = (b - a) / np.linalg.norm(b - a)
            upn = np.array((0.0, 0.0, 1.0)) - d * d[2]; upn /= np.linalg.norm(upn)
            c = (a + b) / 2 + upn * 0.066
            add('body', 'board', box(c, (np.linalg.norm(b - a), 0.135, 0.010), (d, np.cross(upn, d), upn)))
            add('body', 'paper', box(c + upn * 0.0055, (np.linalg.norm(b - a) * 0.86, 0.118, 0.002), (d, np.cross(upn, d), upn)))
            add('body', 'strap', box(hipj + (knee - hipj) * 0.55 + upn * 0.005, (0.030, 0.19, 0.13), (d, np.cross(upn, d), upn)))
    return out


def box(c, size, axes):
    A = np.array([np.asarray(a, float) / np.linalg.norm(a) for a in axes])
    h = np.array(size) / 2
    V = np.array([[sx * h[0], sy * h[1], sz * h[2]] for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]) @ A + np.asarray(c, float)
    F = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    return MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), F, None, 'box')


def limb(p0, p1, prof, n=16, up=(0.0, 0.0, 1.0)):
    """Limb segment with oval sections: prof = [(t 0..1, half width, half height)], rounded caps."""
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
    ax = p1 - p0; L = np.linalg.norm(ax); ax /= L
    upv = np.asarray(up, float) - ax * np.dot(up, ax); upv /= np.linalg.norm(upv)
    side = np.cross(ax, upv)
    rings = []
    t0, w0, h0 = prof[0]
    rings.append((p0 - ax * min(w0, h0) * 0.55, w0 * 0.55, h0 * 0.55))
    for t, w, h in prof:
        rings.append((p0 + ax * L * t, w, h))
    t1, w1, h1 = prof[-1]
    rings.append((p1 + ax * min(w1, h1) * 0.55, w1 * 0.55, h1 * 0.55))
    V = []
    for c, w, h in rings:
        for k in range(n):
            a = 2 * math.pi * k / n
            V.append(c + w * math.cos(a) * side + h * math.sin(a) * upv)
    V = np.array(V)
    F = grid_faces(len(rings), n, wrap_c=True)
    m = len(rings)
    F = [tuple(f) for f in F] + [tuple(range(n))[::-1], tuple(range((m - 1) * n, m * n))]
    return MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), F, None, 'limb')
