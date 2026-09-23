"""F-16 landing gear: struts, wheels, doors, wells (pure numpy; drawing frame -> Blender via to_blender)."""
import math
import numpy as np
from f16_geom import MeshData, grid_faces, cap_fan, to_blender, rot_matrix, CG_S, CG_Z

# ---- geometry constants (drawing frame: s aft, y right, z up from ground)
MAIN_WHEEL_R = 0.3525        # 27.75 in tire
MAIN_TIRE_W = 0.222
MAIN_RIM_R = 0.184
MAIN_STATIC_R = 0.325        # loaded radius (tire deflection)
NOSE_WHEEL_R = 0.2286        # 18 in tire
NOSE_TIRE_W = 0.145
NOSE_RIM_R = 0.102
NOSE_STATIC_R = 0.212

MAIN_AXLE = (9.248, 1.180, MAIN_STATIC_R)       # right side wheel center
MAIN_HUB_Y = 1.045                               # strut lower end (axle root), inboard of the wheel
MAIN_TRUNNION = (9.02, 0.70, 1.18)
MAIN_STOW_AXLE = (8.22, 0.47, 1.08)              # retracted wheel center (approx, right side)

NOSE_AXLE = (5.254, 0.0, NOSE_STATIC_R)
NOSE_TRUNNION = (5.38, 0.0, 1.00)


def D(p):
    """drawing (s,y,z) -> Blender numpy vector"""
    return np.array([p[1], CG_S - p[0], p[2] - CG_Z], float)


# ---------------------------------------------------------------- primitives in Blender coords
def cylinder(p0, p1, r0, r1=None, n=16, cap=True, name='cyl'):
    r1 = r0 if r1 is None else r1
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
    ax = p1 - p0
    L = np.linalg.norm(ax); ax /= L
    tmp = np.array([1, 0, 0]) if abs(ax[0]) < 0.9 else np.array([0, 1, 0])
    u = np.cross(ax, tmp); u /= np.linalg.norm(u)
    v = np.cross(ax, u)
    verts = []
    for p, r in ((p0, r0), (p1, r1)):
        for k in range(n):
            a = 2 * math.pi * k / n
            verts.append(p + r * (math.cos(a) * u + math.sin(a) * v))
    faces = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    V = np.array(verts)
    if cap:
        c0 = len(V); c1 = c0 + 1
        V = np.concatenate([V, [p0, p1]])
        faces += [((k + 1) % n, k, c0) for k in range(n)]
        faces += [(n + k, n + (k + 1) % n, c1) for k in range(n)]
    return MeshData(V, faces, None, name)


def box(center, size, axes=None, name='box'):
    c = np.asarray(center, float)
    hx, hy, hz = [s / 2 for s in size]
    if axes is None:
        axes = np.eye(3)
    ax, ay, az = [np.asarray(a, float) for a in axes]
    V = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                V.append(c + sx * hx * ax + sy * hy * ay + sz * hz * az)
    F = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return MeshData(np.array(V), F, None, name)


def revolve_axis(profile, center, axis, n=32, name='rev', closed=False):
    """profile: [(r, x)] with x along the axis; revolved around `axis` through `center` (Blender coords)."""
    axis = np.asarray(axis, float); axis /= np.linalg.norm(axis)
    tmp = np.array([0, 0, 1]) if abs(axis[2]) < 0.9 else np.array([0, 1, 0])
    u = np.cross(axis, tmp); u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    c = np.asarray(center, float)
    P = np.asarray(profile, float)
    m = len(P)
    V = []
    for r, x in P:
        for k in range(n):
            a = 2 * math.pi * k / n
            V.append(c + axis * x + r * (math.cos(a) * u + math.sin(a) * v))
    faces = grid_faces(m, n, wrap_c=True, wrap_r=closed)
    return MeshData(np.array(V), faces, None, name)


def tire(center, axis, R, W, rim_r, n=40, name='tire'):
    """Aircraft tire (bias ply): rounded tread, bulging sidewalls. Closed torus-like surface."""
    h = W / 2
    prof = []
    # from inner bead (left) around the outside to the inner bead (right) and back inside (closed profile)
    k = 14
    for i in range(k + 1):
        t = i / k
        a = -math.pi / 2 + math.pi * t
        # superellipse cross-section
        ca, sa = math.cos(a), math.sin(a)
        rr = rim_r + (R - rim_r) * (0.5 + 0.5 * abs(ca) ** 0.55 * (1 if ca >= 0 else -1)) if False else None
        # parametric: x = h*sin, r = rim + (R-rim)*(cos^0.4)
        x = h * (abs(sa) ** 0.8) * (1 if sa >= 0 else -1) * 1.0
        r = rim_r + (R - rim_r) * (abs(ca) ** 0.35)
        prof.append((r, x))
    prof = prof[::-1]
    prof += [(rim_r - 0.004, -h * 0.9), (rim_r - 0.004, h * 0.9)]
    md = revolve_axis(prof, center, axis, n=n, name=name, closed=True)
    return md


def wheel_hub(center, axis, rim_r, W, n=28, brake=True, name='hub'):
    h = W / 2
    prof = [(0.02, -h * 0.55), (rim_r * 0.55, -h * 0.55), (rim_r * 0.75, -h * 0.75), (rim_r * 0.98, -h * 0.85),
            (rim_r, -h * 0.9), (rim_r, h * 0.9), (rim_r * 0.98, h * 0.85), (rim_r * 0.7, h * 0.5), (rim_r * 0.35, h * 0.55),
            (0.03, h * 0.62), (0.02, h * 0.62)]
    md = revolve_axis(prof, center, axis, n=n, name=name)
    return md


def merge(*mds, name='merged'):
    out = MeshData(np.zeros((0, 3)), [], None, name)
    for m in mds:
        out.add(m)
    out.name = name
    return out


# ---------------------------------------------------------------- main gear (right side; mirror for left)
def main_leg(side='R'):
    """Returns dict of MeshData in Blender coords (gear-down pose) + key points."""
    sg = 1 if side == 'R' else -1
    T = D((MAIN_TRUNNION[0], sg * MAIN_TRUNNION[1], MAIN_TRUNNION[2]))
    A = D((MAIN_AXLE[0], sg * MAIN_HUB_Y, MAIN_AXLE[2]))
    W = D((MAIN_AXLE[0], sg * MAIN_AXLE[1], MAIN_AXLE[2]))
    leg = A - T
    L = np.linalg.norm(leg)
    ld = leg / L
    parts = []
    # upper cylinder (outer) and chromed lower piston
    up_end = T + ld * (L * 0.55)
    parts.append(('strut', cylinder(T - ld * 0.05, up_end, 0.070, 0.066, n=18)))
    parts.append(('piston', cylinder(up_end - ld * 0.03, A + ld * 0.02, 0.052, 0.052, n=18)))
    # axle housing / fork block at the bottom
    parts.append(('strut', box(A + ld * 0.0, (0.14, 0.16, 0.12), name='axleblk')))
    parts.append(('strut', cylinder(A - np.array([sg * 0.06, 0, 0]), W, 0.045, 0.045, n=14)))
    # drag brace (forward) and side brace (inboard) up to the fuselage
    brace_top = D((8.55, sg * 0.66, 1.20))
    mid = T + ld * (L * 0.52)
    parts.append(('brace', cylinder(mid, brace_top, 0.028, 0.028, n=10)))
    side_top = D((9.10, sg * 0.42, 1.15))
    parts.append(('brace', cylinder(T + ld * (L * 0.35), side_top, 0.024, 0.024, n=10)))
    # torque links (scissors) at the front of the piston
    fwd = np.array([0, 1, 0.0])
    k1 = up_end + fwd * 0.07
    k2 = A + fwd * 0.07 - ld * 0.05
    kmid = 0.5 * (k1 + k2) + fwd * 0.09
    parts.append(('brace', cylinder(k1, kmid, 0.016, 0.016, n=8)))
    parts.append(('brace', cylinder(kmid, k2, 0.016, 0.016, n=8)))
    # trunnion pin
    parts.append(('strut', cylinder(T - np.array([0, 0.12, 0]), T + np.array([0, 0.12, 0]), 0.045, n=12)))
    # brake lines
    parts.append(('dark', cylinder(T + ld * 0.1 + np.array([sg * 0.07, 0, 0]), A + np.array([sg * 0.06, -0.04, 0.05]), 0.008, n=6)))
    return dict(parts=parts, T=T, A=A, W=W, leg=ld, L=L)


def main_wheel(side='R'):
    sg = 1 if side == 'R' else -1
    W = D((MAIN_AXLE[0], sg * MAIN_AXLE[1], MAIN_AXLE[2]))
    ax = np.array([1.0, 0, 0])
    t = tire(W, ax, MAIN_WHEEL_R, MAIN_TIRE_W, MAIN_RIM_R, n=44, name='tire')
    h = wheel_hub(W, ax * sg, MAIN_RIM_R, MAIN_TIRE_W * 0.92, name='hub')
    return W, t, h


def nose_leg():
    T = D(NOSE_TRUNNION)
    A = D(NOSE_AXLE) + np.array([0, 0, 0.0])
    fork_top = D((5.30, 0.0, 0.52))
    parts = []
    ld = (fork_top - T) / np.linalg.norm(fork_top - T)
    up_end = T + (fork_top - T) * 0.55
    parts.append(('strut', cylinder(T - ld * 0.04, up_end, 0.058, 0.055, n=16)))
    parts.append(('piston', cylinder(up_end - ld * 0.03, fork_top, 0.043, 0.043, n=16)))
    # fork: crown + two arms down to the axle
    crown_c = fork_top + np.array([0, 0.0, -0.02])
    parts.append(('strut', box(crown_c, (0.23, 0.10, 0.06), name='crown')))
    for sx in (-1, 1):
        top = crown_c + np.array([sx * 0.100, 0, -0.02])
        bot = A + np.array([sx * 0.100, 0, 0])
        parts.append(('strut', box(0.5 * (top + bot), (0.028, 0.07, np.linalg.norm(top - bot) + 0.04), name='arm')))
        parts.append(('strut', cylinder(bot - np.array([sx * 0.02, 0, 0]), bot + np.array([sx * 0.02, 0, 0]), 0.035, n=12)))
    # torque links at the front
    fwd = np.array([0, 1.0, 0])
    k1 = up_end + fwd * 0.06
    k2 = fork_top + fwd * 0.06 + np.array([0, 0, 0.03])
    km = 0.5 * (k1 + k2) + fwd * 0.07
    parts.append(('strut', cylinder(k1, km, 0.013, n=8)))
    parts.append(('strut', cylinder(km, k2, 0.013, n=8)))
    # drag brace aft to the duct
    parts.append(('strut', cylinder(T + (fork_top - T) * 0.45, D((5.85, 0.0, 0.98)), 0.026, n=10)))
    # trunnion pin
    parts.append(('strut', cylinder(T - np.array([0.10, 0, 0]), T + np.array([0.10, 0, 0]), 0.04, n=12)))
    # landing/taxi light pod on the front of the strut
    lp = T + (fork_top - T) * 0.68 + fwd * 0.075
    parts.append(('strut', box(lp, (0.16, 0.07, 0.07), name='lightpod')))
    lights = [lp + fwd * 0.036 + np.array([-0.045, 0, 0]), lp + fwd * 0.036 + np.array([0.045, 0, 0])]
    lens = [('lens', cylinder(l - fwd * 0.005, l + fwd * 0.006, 0.028, n=16)) for l in lights]
    parts += lens
    return dict(parts=parts, T=T, A=A, lights=lights, fork_top=fork_top)


def nose_wheel():
    A = D(NOSE_AXLE)
    ax = np.array([1.0, 0, 0])
    t = tire(A, ax, NOSE_WHEEL_R, NOSE_TIRE_W, NOSE_RIM_R, n=36, name='ntire')
    h = wheel_hub(A, ax, NOSE_RIM_R, NOSE_TIRE_W * 0.9, name='nhub')
    h2 = wheel_hub(A, -ax, NOSE_RIM_R, NOSE_TIRE_W * 0.9, name='nhub2')
    h.add(h2)
    return A, t, h


# ---------------------------------------------------------------- wells & door outlines (top-view polygons, drawing frame)
NOSE_WELL = [(5.30, -0.255), (6.46, -0.255), (6.46, 0.255), (5.30, 0.255)]     # (s, y) under the intake duct
MAIN_WELL_R = [(7.66, 0.045), (8.93, 0.045), (8.93, 0.78), (7.66, 0.78)]    # right side belly well (door)
MAIN_SLOT_R = [(8.93, 0.56), (9.16, 0.56), (9.16, 0.80), (8.93, 0.80)]    # strut slot (no door)


def well_liner(poly, z_bottom, depth, name='well'):
    """Open box (5 faces, inward normals) hanging above the belly opening."""
    (s0, y0), (s1, _), (_, y1) = poly[0], poly[1], poly[2]
    zt = z_bottom + depth
    zb = z_bottom - 0.25
    P = lambda s, y, z: D((s, y, z))
    V = np.array([P(s0, y0, zb), P(s1, y0, zb), P(s1, y1, zb), P(s0, y1, zb),
                  P(s0, y0, zt), P(s1, y0, zt), P(s1, y1, zt), P(s0, y1, zt)])
    F = [(4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    md = MeshData(V, F, None, name)
    return md


# Retraction kinematics solved numerically (random search + refinement) so the stowed tire and leg lie inside the
# lower fuselage with clearance: rotation axis in Blender coords (right side), angle (rad), wheel twist about the leg.
MAIN_RETRACT_AXIS_R = (0.90576, 0.20946, 0.3684)
MAIN_RETRACT_ANGLE = math.radians(113.49)
MAIN_TWIST_R = math.radians(-68.46)
NOSE_RETRACT_AXIS = (0.99859, -0.03609, -0.039)
NOSE_RETRACT_ANGLE = math.radians(-109.45)
NOSE_TWIST = math.radians(93.49)
