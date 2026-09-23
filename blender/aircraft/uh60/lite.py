"""interior_lite: light stand-in (<= 15k triangles) for the exterior GLB (CONTRACTS-SF.md §6.2.1).

Low-poly shells that follow the detailed interior's surfaces (same constants); after the detailed interior is baked,
ibake.bake_lite() projects its final colours onto one small atlas, so seats, panels and the cabin look furnished
through the windows and open doors from outside at a fraction of the triangles."""
import math
import numpy as np
from mathutils import Vector, Matrix
from lib import (new_mesh_obj, prim_cylinder, prim_tube, prim_box, prim_rbox, merge_parts, transform_verts, loft_rings)
import interior as I
import cabin as C
import crew

X = Vector((1, 0, 0))


class LAcc:
    def __init__(self):
        self.parts = {}

    def add(self, key, vf, keep=False):
        self.parts.setdefault(key, []).append(vf)


def build_lite(M, parent):
    A = LAcc()
    # instrument panel: face grid + body + glare shield hood (same outline as the detailed one)
    pv, pf = I.panel_face_mesh(nu=8, nv=3)
    A.add('int_panelpaint', (pv, pf))
    A.add('int_structure', I.glareshield_mesh(n=7, lite=True))
    # centre console and overhead console blocks
    A.add('int_panelpaint', I.console_block())
    A.add('int_panelpaint', I.overhead_block())
    for s in (-1, 1):
        sx = s * I.SEAT_X
        y0, zp = I.SEAT_Y0, I.SEAT_ZP
        ta = math.radians(13)
        up = Vector((0, -math.sin(ta), math.cos(ta)))
        fw = Vector((0, math.cos(ta), math.sin(ta)))
        base = Vector((sx, y0 - 0.50, zp - 0.04))
        A.add('int_seatshell', prim_rbox((0.52, 0.50, 0.10), (sx, y0 - 0.24, zp - 0.08), r=0.03, n=1))
        A.add('int_seatshell', prim_rbox((0.52, 0.86, 0.08), tuple(base + up * 0.42 - fw * 0.03), r=0.03, n=1, axes=(X, up, fw)))
        A.add('int_cushion', prim_rbox((0.40, 0.44, 0.06), (sx, y0 - 0.235, zp - 0.03), r=0.02, n=1))
        A.add('int_cushion', prim_rbox((0.38, 0.56, 0.06), tuple(base + up * 0.40 + fw * 0.05), r=0.02, n=1, axes=(X, up, fw)))
        A.add('int_cushion', prim_rbox((0.26, 0.15, 0.07), tuple(base + up * 0.80 + fw * 0.035), r=0.02, n=1, axes=(X, up, fw)))
        A.add('int_seatshell', prim_rbox((0.03, 0.56, 0.36), tuple(base + up * 0.48 + X * (s * 0.285) + fw * 0.05), r=0.01, n=1,
                                         axes=(X, up, fw)))
        # cyclic + collective (thin)
        A.add('int_stick', prim_tube([(sx, 3.30, I.FLOOR_CP), (sx, 3.29, I.FLOOR_CP + 0.40), (sx, 3.225, I.FLOOR_CP + 0.60)], 0.017, n=5))
        A.add('int_grip', prim_rbox((0.045, 0.06, 0.15), (sx, 3.215, I.FLOOR_CP + 0.67), r=0.015, n=1))
        cx = sx - 0.33
        A.add('int_frame', prim_box((0.09, 0.56, 0.20), center=(cx, 2.92, I.FLOOR_CP + 0.12)))
        A.add('int_stick', prim_tube([(cx, 2.72, 0.93), (cx, 3.12, 0.995), (cx, 3.30, 1.03)], 0.02, n=5))
    # cockpit floor
    fl = []
    for yy in np.linspace(4.02, 2.45, 3):
        xw = I.inner_halfwidth(yy, I.FLOOR_CP + 0.02, 0.05)
        fl.append(np.array([(-xw, yy, I.FLOOR_CP + 0.004), (xw, yy, I.FLOOR_CP + 0.004)]))
    v, f = loft_rings(fl, closed=False)
    A.add('int_floor_cp', (v, [ff[::-1] for ff in f]))
    # cabin floor and troop seats (pan + back + straps)
    fl = []
    for yy in np.linspace(C.Y_AFT, C.Y_FWD, 4):
        xw = C.inner_hw(yy, C.FLOOR_CB + 0.02, 0.05)
        fl.append(np.array([(-xw, yy, C.FLOOR_CB + 0.003), (xw, yy, C.FLOOR_CB + 0.003)]))
    v, f = loft_rings(fl, closed=False)
    A.add('int_floor', (v, f))

    def seat(base, yaw):
        Mx = Matrix.Translation(base) @ Matrix.Rotation(yaw, 4, 'Z')
        for vf in (prim_box((0.42, 0.40, 0.04), center=(0, 0.03, 0.44)), prim_box((0.42, 0.04, 0.64), center=(0, -0.17, 0.81))):
            A.add('int_canvas', (transform_verts(vf[0], Mx), vf[1]))
        for sx_ in (-0.21, 0.21):
            vf = prim_box((0.03, 0.02, 2.12 - base.z - 1.0), center=(sx_, -0.19, (2.12 - base.z + 1.0) / 2))
            A.add('int_strap', (transform_verts(vf[0], Mx), vf[1]))
            vf = prim_box((0.02, 0.02, 0.44), center=(sx_, 0.18, 0.22))
            A.add('int_tube', (transform_verts(vf[0], Mx), vf[1]))
            vf = prim_box((0.03, 0.03, 2.12 - base.z), center=(sx_, -0.215, (2.12 - base.z) / 2))
            A.add('int_frame', (transform_verts(vf[0], Mx), vf[1]))
    for x in (-0.69, -0.23, 0.23, 0.69):
        seat(Vector((x, -1.50, C.FLOOR_CB)), 0.0)
    for x in (-0.69, -0.23, 0.23, 0.69):
        seat(Vector((x, 1.98, C.FLOOR_CB)), math.pi)
    for s in (-1, 1):
        seat(Vector((s * 0.60, 1.50, C.FLOOR_CB)), -s * math.pi / 2)
    # aft bulkhead panel
    pts = C.section(C.Y_AFT, 0.04, C.FLOOR_CB, n=16)
    verts = [(a, C.Y_AFT + 0.02, b) for a, b in pts] + [(0.0, C.Y_AFT + 0.02, 1.4)]
    n = len(pts)
    A.add('int_quiltpad', (verts, [((i + 1) % n, i, n) for i in range(n)]))
    objs = []
    for key, parts in A.parts.items():
        v, f = merge_parts(parts)
        o = new_mesh_obj(f'lite_{key}', v, f, M[key], smooth=True, sharp_deg=40)
        o.parent = parent
        objs.append(o)
    return objs
