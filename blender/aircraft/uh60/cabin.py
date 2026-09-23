"""UH-60M troop cabin (G frame): floor with seat tracks and tie-down rings, cargo-hook access hatch, quilted
soundproofing blankets between the frames, ceiling troop-seat rails, crashworthy troop seats (tube frames, canvas,
ceiling straps), gunner seats and M240 window mounts, aft bulkhead equipment, dome lights and handholds."""
import math
import numpy as np
from mathutils import Vector, Matrix
from lib import (prim_cylinder, prim_tube, prim_box, prim_sphere, prim_rbox, prim_torus, merge_parts, transform_verts,
                 half_profile, loft_rings)
import hull

FLOOR_CB = 0.62
Y_AFT, Y_FWD = -1.78, 2.40          # cabin between the aft bulkhead and the crew seat backs
X = Vector((1, 0, 0))
Z = Vector((0, 0, 1))


def inner_hw(y, z, inset=0.035):
    return max(0.05, hull.fuse_halfwidth_at(y, z) - inset)


def section(y, inset, z_min, n=40):
    """Inner section of the fuselage at station y, above z_min, as a list of (x, z) from right floor up and over to left."""
    zb, zm, zt, w, nb, nt, tt = [float(v) for v in hull.fuse_params(y)]
    x, z = half_profile(w - inset, zb + inset, zm, zt - inset, nb, nt, tt, n=n)
    pts = [(xx, zz) for xx, zz in zip(x, z) if zz >= z_min]
    pts = [(inner_hw(y, z_min, inset), z_min)] + pts
    return pts + [(-a, b) for a, b in pts[::-1][1:]]


def xf(vf, M):
    v, f = vf
    return transform_verts(v, M), f


# ------------------------------------------------------------------------------------------------------------- seats
def troop_seat(A, base, yaw, strut_top=2.12, legs=True):
    """Crashworthy troop seat: tube frame, canvas pan + back, lap belt; two energy-absorbing straps to the ceiling."""
    M = Matrix.Translation(base) @ Matrix.Rotation(yaw, 4, 'Z')
    zp = 0.44
    A.add('int_canvas', xf(prim_rbox((0.40, 0.38, 0.035), (0, 0.03, zp), r=0.014, n=2), M))
    A.add('int_canvas', xf(prim_rbox((0.40, 0.035, 0.62), (0, -0.17, zp + 0.37), r=0.014, n=2), M))
    A.add('int_canvas', xf(prim_rbox((0.30, 0.05, 0.10), (0, -0.15, zp + 0.62), r=0.02, n=2), M))       # head pad
    for sx in (-0.21, 0.21):
        A.add('int_tube', xf(prim_tube([(sx, 0.23, zp - 0.01), (sx, -0.17, zp - 0.01), (sx, -0.19, zp + 0.72)], 0.012, n=6, cap=False), M))
        # black energy-attenuating frame post from the floor track up to the ceiling rail
        A.add('int_frame', xf(prim_tube([(sx, -0.215, 0.0), (sx, -0.215, strut_top - base.z)], 0.017, n=8), M))
        if legs:
            A.add('int_tube', xf(prim_tube([(sx, 0.18, zp - 0.02), (sx, 0.12, 0.01)], 0.011, n=6, cap=False), M))
            A.add('int_tube', xf(prim_tube([(sx, -0.15, zp - 0.02), (sx, -0.20, 0.01)], 0.011, n=6, cap=False), M))
        # ceiling strap (webbing) with the energy attenuator buckle
        top = strut_top - base.z
        A.add('int_strap', xf(prim_box((0.035, 0.004, top - zp - 0.72), center=(sx, -0.19, (top + zp + 0.72) / 2)), M))
        A.add('int_metal', xf(prim_box((0.045, 0.012, 0.05), center=(sx, -0.19, zp + 0.90)), M))
    A.add('int_tube', xf(prim_tube([(-0.21, 0.23, zp - 0.01), (0.21, 0.23, zp - 0.01)], 0.012, n=6), M))
    A.add('int_tube', xf(prim_tube([(-0.21, -0.19, zp + 0.72), (0.21, -0.19, zp + 0.72)], 0.012, n=6), M))
    # lap belt halves + buckle, shoulder strap
    for sx in (-1, 1):
        A.add('int_strap', xf(prim_box((0.17, 0.04, 0.004), center=(sx * 0.10, 0.07, zp + 0.022)), M))
    A.add('int_metal', xf(prim_box((0.05, 0.035, 0.008), center=(0, 0.07, zp + 0.026)), M))
    A.add('int_strap', xf(prim_box((0.04, 0.004, 0.40), center=(0.08, -0.145, zp + 0.30)), M))


def troop_bench(A, y, n, yaw, xs, strut_top=2.12):
    for x in xs[:n]:
        troop_seat(A, Vector((x, y, FLOOR_CB)), yaw, strut_top)


# ------------------------------------------------------------------------------------------------------------- walls
def half_curve(y, inset, z_min, n=160):
    """Right half of the inner section from the floor (z_min) up to the top centre: arrays x, z, cumulative length."""
    zb, zm, zt, w, nb, nt, tt = [float(v) for v in hull.fuse_params(y)]
    x, z = half_profile(w - inset, zb + inset, zm, zt - inset, nb, nt, tt, n=n)
    keep = z >= z_min
    x, z = x[keep], z[keep]
    x = np.concatenate([[inner_hw(y, z_min, inset)], x])
    z = np.concatenate([[z_min], z])
    L = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(z)))])
    return x, z, L


def band_pts(y, inset, z0, z1, n, z_min=FLOOR_CB + 0.02):
    """n points along the right half curve between heights z0 and z1 (z1 = None: up to the top centre)."""
    x, z, L = half_curve(y, inset, z_min)
    l0 = float(np.interp(z0, z, L))
    l1 = L[-1] if z1 is None else float(np.interp(z1, z, L))
    ls = np.linspace(l0, l1, n)
    return np.interp(ls, L, x), np.interp(ls, L, z)


# cabin openings (both sides): sliding-door opening and gunner window, with a margin for the blanket edges
DOOR_Y, DOOR_Z1 = (-0.84, 1.38), 1.97
GUN_Y, GUN_Z = (1.79, 2.37), (1.23, 1.95)


def _loft_band(A, key, y0, y1, z0, z1, side, n=10, inset=0.075, roof=False):
    rings = []
    for yy in np.linspace(y0, y1, 5):
        if roof:
            xr, zr = band_pts(yy, inset, z0, None, n)
            pts = [(a, yy, b) for a, b in zip(xr, zr)] + [(-a, yy, b) for a, b in zip(xr[::-1][1:], zr[::-1][1:])]
        else:
            xr, zr = band_pts(yy, inset, z0, z1, n)
            pts = [(side * a, yy, b) for a, b in zip(xr, zr)]
        rings.append(np.array(pts))
    v, f = loft_rings(rings, closed=False)
    # face into the cabin (right wall and roof are wound that way; the mirrored left wall is flipped)
    if not roof and side < 0:
        f = [ff[::-1] for ff in f]
    A.add(key, (v, f), keep=True)


def quilt_blankets(A, key='int_quiltpad'):
    """Soundproofing blankets: quilted pads just inside the skin between the frames (walls + ceiling), leaving the
    sliding-door openings and the gunner windows free. Tiling quilt texture via box projection (material)."""
    zf = FLOOR_CB + 0.03
    bays = [((1.80, 2.315), [(zf, GUN_Z[0])], GUN_Z[1]),        # gunner window bay: wall below the window + roof
            ((1.455, 1.80), [(zf, 1.93)], 1.93),                # between gunner window and door
            ((DOOR_Y[0] + 0.04, DOOR_Y[1]), [], DOOR_Z1),       # door opening: roof only
            ((-1.745, -0.875), [(zf, 1.95)], 1.95)]             # aft bay: full walls
    for (y0, y1), walls, zroof in bays:
        _loft_band(A, key, y0, y1, zroof, None, 1, n=14, roof=True)
        for z0, z1 in walls:
            for sd in (1, -1):
                _loft_band(A, key, y0, y1, z0, z1, sd, n=10)


def frames_and_stringers(A):
    for y, full in ((2.35, True), (1.42, True), (0.40, False), (-0.86, True)):
        z0 = FLOOR_CB + 0.03 if full else DOOR_Z1
        xr, zr = band_pts(y, 0.05, z0, None, 14)
        path = [Vector((a, y, b)) for a, b in zip(xr, zr)] + [Vector((-a, y, b)) for a, b in zip(xr[::-1][1:], zr[::-1][1:])]
        A.add('int_framepaint', prim_tube(path, 0.022, n=6, cap=True))
    # ceiling troop-seat / litter rails
    for x in (-0.46, 0.46):
        A.add('int_metal', prim_box((0.04, 3.9, 0.03), center=(x, 0.30, 2.13)))


# ------------------------------------------------------------------------------------------------------------- build
def build_cabin(A, Ak):
    """A: cabin accumulator (atlas 'int_cabin'). Ak: accumulator for small separately-coloured kit (same atlas)."""
    # floor plates, seat tracks, recessed tie-down rings, cargo hook hatch
    for yy in np.linspace(Y_AFT, Y_FWD, 3)[:-1]:
        pass
    floor = []
    for yy in np.linspace(Y_AFT, Y_FWD, 12):
        xw = inner_hw(yy, FLOOR_CB + 0.02, 0.045)
        floor.append(np.array([(-xw, yy, FLOOR_CB), (xw, yy, FLOOR_CB)]))
    v, f = loft_rings(floor, closed=False)
    A.add('int_floor', (v, f), keep=True)
    for xx in (-0.86, -0.48, 0.48, 0.86):
        A.add('int_track', prim_box((0.030, 4.10, 0.010), center=(xx, 0.31, FLOOR_CB + 0.005)))
    for yy in (2.0, 1.25, 0.5, -0.25, -1.0):
        for xx in (-0.72, 0.0, 0.72):
            A.add('int_track', prim_cylinder(0.045, 0.045, 0.004, n=14, center=(xx, yy, FLOOR_CB)))
            A.add('int_metal', prim_torus(0.03, 0.006, n=12, m=5, center=(xx, yy, FLOOR_CB + 0.008)))
    # cargo hook access hatch (centre of the cabin floor) with its hinged cover outline and latch
    A.add('int_hatch', prim_box((0.62, 0.72, 0.012), center=(0, 0.02, FLOOR_CB + 0.006)))
    A.add('int_black', prim_box((0.14, 0.04, 0.012), center=(0, 0.32, FLOOR_CB + 0.014)))
    A.add('int_yellow', prim_box((0.60, 0.02, 0.013), center=(0, -0.33, FLOOR_CB + 0.0065)))
    # step between cockpit and cabin floors
    A.add('int_frame', prim_box((2.0, 0.05, 0.08), center=(0, 2.43, 0.66)))
    quilt_blankets(A)
    frames_and_stringers(A)
    # aft bulkhead: quilted panel on a frame
    yb = Y_AFT
    pts = section(yb, 0.04, FLOOR_CB, n=40)
    verts = [(a, yb + 0.02, b) for a, b in pts]
    n = len(verts)
    c = (0.0, yb + 0.02, (FLOOR_CB + 2.2) / 2)
    verts.append(c)
    faces = [((i + 1) % n, i, n) for i in range(n)]            # facing forward, into the cabin
    A.add('int_quiltpad', (verts, faces), keep=True)
    # troop seats: 4 forward-facing at the aft bulkhead, 3 aft-facing against the cockpit, 2 outboard-facing gunners
    troop_bench(A, -1.50, 4, 0.0, (-0.69, -0.23, 0.23, 0.69))
    troop_bench(A, 1.98, 4, math.pi, (-0.69, -0.23, 0.23, 0.69))
    for s in (-1, 1):
        troop_seat(A, Vector((s * 0.60, 1.50, FLOOR_CB)), -s * math.pi / 2)
    # M240 gunner mounts at the gunner windows (post + swing arm + pintle, gun not fitted)
    for s in (-1, 1):
        xw = inner_hw(2.08, 1.15, 0.08)
        base = Vector((s * xw, 2.08, 1.02))
        A.add('int_frame', prim_tube([base - Vector((0, 0, 0.40)), base + Vector((0, 0, 0.12))], 0.022, n=10))
        arm = base + Vector((-s * 0.18, 0.0, 0.12))
        A.add('int_frame', prim_tube([base + Vector((0, 0, 0.12)), arm], 0.018, n=8))
        A.add('int_metal', prim_cylinder(0.025, 0.02, 0.09, n=10, center=tuple(arm)))
        A.add('int_black', prim_box((0.06, 0.12, 0.05), center=tuple(arm + Vector((0, 0, 0.11)))))
        # ammunition can bracket
        A.add('int_kit', prim_box((0.14, 0.26, 0.20), center=(s * (xw - 0.12), 2.18, FLOOR_CB + 0.10)))
    # aft bulkhead equipment: fire extinguisher, first-aid kits, crash axe, intercom box, cable bundles
    A.add('int_red', prim_cylinder(0.065, 0.065, 0.40, n=16, center=(0.86, -1.72, 1.24)))
    A.add('int_black', prim_cylinder(0.025, 0.02, 0.06, n=10, center=(0.86, -1.72, 1.64)))
    A.add('int_metal', prim_box((0.05, 0.03, 0.5), center=(0.95, -1.74, 1.40)))
    for xx in (-0.95, -0.62):
        A.add('int_kit', prim_rbox((0.28, 0.10, 0.20), (xx, -1.71, 1.60), r=0.02, n=2))
    A.add('int_black', prim_box((0.10, 0.06, 0.14), center=(0.45, -1.73, 1.55)))
    for zz in (1.96, 2.03):
        A.add('int_black', prim_tube([(-0.9, -1.73, zz), (0.9, -1.73, zz)], 0.016, n=6))
    # interior cabin door handles and hand holds along the door frames
    for s in (-1, 1):
        xw = inner_hw(1.5, 1.2, 0.07)
        A.add('int_metal', prim_tube([(s * xw, 1.40, 1.02), (s * (xw - 0.05), 1.40, 1.05), (s * (xw - 0.05), 1.40, 1.30),
                                      (s * xw, 1.40, 1.33)], 0.012, n=6))
        A.add('int_metal', prim_tube([(s * (inner_hw(-0.8, 1.9, 0.07)), -0.84, 1.20), (s * (inner_hw(-0.8, 1.9, 0.12)), -0.84, 1.24),
                                      (s * (inner_hw(-0.8, 1.9, 0.12)), -0.84, 1.80), (s * (inner_hw(-0.8, 1.9, 0.07)), -0.84, 1.84)], 0.012, n=6))
    # dome lights (white/NVG) and the ceiling grab handles
    for yy in (1.3, -0.3):
        A.add('int_lampbody', prim_cylinder(0.075, 0.065, 0.03, n=16, center=(0, yy, 2.155)))
    for s in (-1, 1):
        A.add('int_metal', prim_tube([(s * 0.25, 1.1, 2.15), (s * 0.25, 1.06, 2.07), (s * 0.25, -0.5, 2.07), (s * 0.25, -0.54, 2.15)], 0.012, n=6))
