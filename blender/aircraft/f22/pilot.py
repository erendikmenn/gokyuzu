"""Seated F-22 pilot figure (exterior views only; the rig hides it in cockpit view).

Built from revolved/tapered primitives, textured with colour patches of the cockpit atlas (single material)."""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix

import geom as G
from geom import Y


def ellipsoid(bm, c, r, seg=16, rings=10, rot=None):
    """Ellipsoid centred at c with radii r=(rx, ry, rz)."""
    c = Vector(c)
    R = rot or Matrix.Identity(3)
    rows = []
    for i in range(rings + 1):
        th = math.pi * i / rings
        row = []
        for j in range(seg):
            ph = 2 * math.pi * j / seg
            p = Vector((math.sin(th) * math.cos(ph) * r[0], math.sin(th) * math.sin(ph) * r[1], math.cos(th) * r[2]))
            row.append(bm.verts.new(c + R @ p))
        rows.append(row)
    for i in range(rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            G.add_face(bm, [rows[i][j], rows[i + 1][j], rows[i + 1][j2], rows[i][j2]])
    return rows


def limb(bm, pts, radii, seg=12):
    """Chain of tapered cylinders with ball joints."""
    for k in range(len(pts) - 1):
        G.bm_cylinder(bm, pts[k], pts[k + 1], radii[k], radii[k + 1], seg=seg, cap0=False, cap1=False)
    for p, r in zip(pts, radii):
        ellipsoid(bm, p, (r, r, r), seg=seg, rings=6)


def orient_out(bm):
    """Outward normals for closed blobby parts: flip faces pointing towards the local centroid of their island."""
    bm.normal_update()
    islands = []
    seen = set()
    for f in bm.faces:
        if f in seen:
            continue
        stack, isl = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        islands.append(isl)
    for isl in islands:
        c = sum((f.calc_center_median() for f in isl), Vector()) / len(isl)
        for f in isl:
            if f.normal.dot(f.calc_center_median() - c) < 0:
                f.normal_flip()


def build_pilot(mats):
    """Seated pilot for the exterior views (hidden in cockpit view).  mats: [suit, vest, black, helmet, visor, mask].
    Posed on the cklayout seat: hips on the cushion, right hand on the side-stick, left hand on the throttles."""
    import cklayout as L
    E = Vector((L.EYE[0], Y(L.EYE[1]), L.EYE[2]))

    def P(x, s, z):
        return Vector((x, Y(s), z))
    rec = math.radians(15)
    bm_all = []

    def part(fn, mat):
        b = bmesh.new()
        fn(b)
        for f in b.faces:
            f.material_index = mat
        bm_all.append(b)
    hip = P(0, 4.56, 0.24)
    chest = P(0, 4.64, 0.56)

    def suit(b):
        ellipsoid(b, hip.lerp(chest, 0.5), (0.19, 0.13, 0.30), seg=18, rings=12, rot=Matrix.Rotation(-rec, 3, 'X'))
        ellipsoid(b, P(0, 4.68, 0.66), (0.23, 0.12, 0.12), seg=18, rings=8)
        limb(b, [P(0.20, 4.69, 0.66), P(0.28, 4.56, 0.44), P(L.STICK[0] - 0.01, L.STICK[1] + 0.02, L.STICK[2] + 0.11)],
             [0.055, 0.047, 0.04])
        limb(b, [P(-0.20, 4.69, 0.66), P(-0.30, 4.60, 0.44), P(L.THROTTLE[0] + 0.02, L.THROTTLE[1], L.CON_Z + 0.14)],
             [0.055, 0.047, 0.04])
        for sx in (-1, 1):
            limb(b, [P(sx * 0.10, 4.52, 0.22), P(sx * 0.16, 4.03, 0.36), P(sx * 0.16, 3.50, -0.16)], [0.085, 0.062, 0.05])
    part(suit, 0)

    def vest(b):
        ellipsoid(b, P(0, 4.63, 0.50), (0.20, 0.135, 0.18), seg=18, rings=8, rot=Matrix.Rotation(-rec, 3, 'X'))
        for sx in (-1, 1):
            G.bm_cylinder(b, P(sx * 0.11, 4.40, 0.28), P(sx * 0.14, 4.12, 0.34), 0.068, 0.064, seg=12)
    part(vest, 1)

    def black(b):
        ellipsoid(b, P(L.STICK[0], L.STICK[1] + 0.01, L.STICK[2] + 0.12), (0.035, 0.05, 0.03), seg=12, rings=6)
        ellipsoid(b, P(L.THROTTLE[0], L.THROTTLE[1] - 0.01, L.CON_Z + 0.15), (0.035, 0.05, 0.03), seg=12, rings=6)
        for sx in (-1, 1):
            ellipsoid(b, P(sx * 0.16, 3.44, -0.20), (0.05, 0.13, 0.055), seg=12, rings=6)
    part(black, 2)
    hc = E + Vector((0, -0.10, 0.03))

    def helmet(b):
        ellipsoid(b, hc, (0.135, 0.155, 0.15), seg=22, rings=14)
        ellipsoid(b, hc + Vector((0, -0.02, -0.14)), (0.07, 0.07, 0.07), seg=12, rings=6)
    part(helmet, 3)

    def visor(b):
        rows = []
        for i in range(7):
            th = math.radians(62 + i * 9)
            row = []
            for j in range(13):
                ph = math.radians(-70 + j * (140 / 12))
                p = Vector((math.sin(th) * math.sin(ph) * 0.142, math.sin(th) * math.cos(ph) * 0.162, math.cos(th) * 0.157))
                row.append(b.verts.new(hc + p))
            rows.append(row)
        for i in range(6):
            for j in range(12):
                G.add_face(b, [rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]])
    part(visor, 4)
    mc = hc + Vector((0, 0.13, -0.10))

    def mask(b):
        ellipsoid(b, mc, (0.05, 0.05, 0.055), seg=12, rings=6)
        limb(b, [mc + Vector((0.02, 0.0, -0.05)), P(0.08, 4.50, 0.52), P(0.12, 4.52, 0.36)], [0.017, 0.017, 0.017], seg=8)
    part(mask, 5)
    bm = bmesh.new()
    for b in bm_all:
        G.join_bm(bm, b)
    orient_out(bm)
    G.smooth_sharp(bm, 70)
    return G.new_object('pilot', bm, mats)
