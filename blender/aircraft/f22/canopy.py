"""F-22A canopy: one-piece gold-tinted bubble on a thin frame (sill band, front V seal, rear frame), hinged at the
rear; plus the cockpit tub walls below the sill (closes the fuselage opening, dark)."""
import math
import numpy as np
import bmesh
from mathutils import Vector

import geom as G
from geom import Y, lerp, smoothstep, chain
import oml as O

M_GLASS, M_FRAME = 0, 1
NS, NU = 64, 18          # stations, points per half section
HINGE_S = 6.05           # canopy hinge station (behind the frame's rear point, on the spine)


def section(s, n=NU):
    """Right half of the canopy outer surface at station s: sill -> crown, (n, 2)."""
    xs, zs, zt = O.can_x(s), O.can_zs(s), O.can_zt(s)
    h = max(zt - zs, 1e-4)
    keys = [(xs, zs), (xs * 1.015, zs + 0.34 * h), (xs * 0.80, zs + 0.84 * h), (0.0, zt)]
    tans = [(0.10, 1.0), None, None, (-1.0, 0.0)]
    pts = chain(keys, [8, 8, 8], tan=tans)
    return G.resample_polyline(pts, n)


def stations():
    return np.concatenate([[O.S_CAN0], G.cosine_space(O.S_CAN0, O.S_CAN1, NS)[1:-1], [O.S_CAN1]])


def build_canopy():
    """Outer shell (glass + frame materials) and a thickened frame band (inner face) - world coordinates."""
    ss = stations()
    rows = []
    for s in ss:
        half = section(s)
        full = [(-p[0], Y(s), p[1]) for p in half] + [(p[0], Y(s), p[1]) for p in half[::-1][1:]]
        rows.append(full)
    A = np.array(rows)
    bm = bmesh.new()
    G.bm_grid(bm, A)
    G.weld(bm, 1e-6)
    G.orient_faces(bm, lambda c: Vector((c.x, 0, c.z - 0.25)))
    # frame: band along the sill (~7 cm of arc), wider at the front V and the rear
    for f in bm.faces:
        c = f.calc_center_median()
        s = Y(0) - c.y
        xs, zs = O.can_x(s), O.can_zs(s)
        above = c.z - zs
        frame_h = 0.062 + 0.10 * smoothstep(O.S_GL0 + 0.35, O.S_GL0 - 0.05, s) + 0.12 * smoothstep(O.S_GL1 - 0.25, O.S_CAN1, s)
        f.material_index = M_FRAME if (above < frame_h or s < O.S_GL0 or s > O.S_GL1) else M_GLASS
    # inner skin for the frame band (so the frame has thickness when seen from the cockpit)
    inner = bmesh.new()
    for s in ss:
        pass
    rows_i = []
    for s in ss[1:-1]:
        half = section(s)
        xs, zs = O.can_x(s), O.can_zs(s)
        band = [p for p in half if p[1] - zs < 0.075]
        if len(band) < 2:
            band = list(half[:2])
        a, b = np.array(band[0]), np.array(band[-1])
        rows_i.append([(a[0] - 0.03, Y(s), a[1] + 0.005), (b[0] - 0.028, Y(s), b[1])])
    Ai = np.array(rows_i)
    for mir in (False, True):
        B = Ai.copy()
        if mir:
            B[..., 0] *= -1
        G.bm_grid(inner, B, flip=not mir, mat=M_FRAME)
    G.orient_faces(inner, lambda c: Vector((-c.x, 0, 0)))
    G.join_bm(bm, inner)
    return bm


def build_tub():
    """Cockpit opening walls: from the sill straight down/in to a floor (dark); keeps the fuselage closed."""
    bm = bmesh.new()
    ss = [s for s in stations() if O.S_CAN0 + 0.02 < s < O.S_CAN1 - 0.02]
    rows = []
    for s in ss:
        xs, zs = O.can_x(s), O.can_zs(s)
        zf = min(zs - 0.05, -0.30 + 0.12 * smoothstep(2.6, 5.8, s))
        rows.append([(xs - 0.004, Y(s), zs - 0.004), (xs * 0.97, Y(s), lerp(zs, zf, 0.5)), (xs * 0.9, Y(s), zf),
                     (0.0, Y(s), zf)])
    A = np.array(rows)
    for mir in (False, True):
        B = A.copy()
        if mir:
            B[..., 0] *= -1
        G.bm_grid(bm, B, flip=mir, mat=0)
    # front / rear bulkheads
    G.weld(bm, 1e-6)
    G.orient_faces(bm, lambda c: Vector((-c.x, 0, 1.0 if abs(c.x) < 0.3 else 0.0)))
    return bm
