"""Seated F-22 pilot figure (exterior views only; the rig hides it in cockpit view).

Built from revolved/tapered primitives, textured with colour patches of the cockpit atlas (single material)."""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix

import geom as G
from geom import Y
import cockpit as CK


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


def build_pilot(uvh, material):
    ex, es, ez = CK.EYE
    E = Vector((ex, Y(es), ez))
    back = Vector((0, -math.sin(math.radians(15)), math.cos(math.radians(15))))   # up along the seat back
    fwd = Vector((0, 1, 0))
    parts = {}

    def P(x, s, z):
        return Vector((x, Y(s), z))

    # --- flight suit (sage): torso, arms, legs
    suit = bmesh.new()
    suit.loops.layers.uv.verify()
    hip = P(0, 4.86, 0.20)
    chest = P(0, 4.93, 0.58)
    ellipsoid(suit, hip.lerp(chest, 0.5), (0.20, 0.13, 0.30), seg=18, rings=12,
              rot=Matrix.Rotation(math.radians(-15), 3, 'X'))
    ellipsoid(suit, P(0, 4.95, 0.64), (0.23, 0.12, 0.12), seg=18, rings=8)                  # shoulders
    # arms: right to the side stick, left to the throttle
    limb(suit, [P(0.20, 4.96, 0.64), P(0.27, 4.84, 0.40), P(0.355, 4.64, 0.33)], [0.055, 0.047, 0.04])
    limb(suit, [P(-0.20, 4.96, 0.64), P(-0.28, 4.85, 0.42), P(-0.36, 4.66, 0.37)], [0.055, 0.047, 0.04])
    # legs
    for sx in (-1, 1):
        limb(suit, [P(sx * 0.10, 4.78, 0.20), P(sx * 0.13, 4.25, 0.26), P(sx * 0.15, 3.86, -0.10)],
             [0.085, 0.062, 0.05])
    uvh.patch(suit, list(suit.faces), 'olive')
    # --- harness / survival vest + G-suit (darker green)
    vest = bmesh.new()
    vest.loops.layers.uv.verify()
    ellipsoid(vest, P(0, 4.915, 0.50), (0.21, 0.135, 0.18), seg=18, rings=8,
              rot=Matrix.Rotation(math.radians(-15), 3, 'X'))
    for sx in (-1, 1):
        G.bm_cylinder(vest, P(sx * 0.10, 4.62, 0.24), P(sx * 0.12, 4.36, 0.27), 0.068, 0.064, seg=12)   # G-suit thigh bladders
    uvh.patch(vest, list(vest.faces), 'seatgreen')
    # --- gloves + boots (black)
    blk = bmesh.new()
    blk.loops.layers.uv.verify()
    ellipsoid(blk, P(0.372, 4.60, 0.335), (0.035, 0.05, 0.03), seg=12, rings=6)
    ellipsoid(blk, P(-0.375, 4.63, 0.37), (0.035, 0.05, 0.03), seg=12, rings=6)
    for sx in (-1, 1):
        ellipsoid(blk, P(sx * 0.15, 3.78, -0.14), (0.05, 0.13, 0.055), seg=12, rings=6)
    uvh.patch(blk, list(blk.faces), 'black')
    # --- helmet (gray), visor (dark), oxygen mask + hose
    hel = bmesh.new()
    hel.loops.layers.uv.verify()
    hc = E + Vector((0, -0.04, 0.035))
    ellipsoid(hel, hc, (0.135, 0.155, 0.15), seg=22, rings=14)
    ellipsoid(hel, hc + Vector((0, -0.02, -0.14)), (0.07, 0.07, 0.07), seg=12, rings=6)       # neck
    uvh.patch(hel, list(hel.faces), 'metal')
    vis = bmesh.new()
    vis.loops.layers.uv.verify()
    # visor: partial ellipsoid shell in front of the eyes
    rows = []
    for i in range(7):
        th = math.radians(62 + i * 9)          # from brow down to below the eyes
        row = []
        for j in range(13):
            ph = math.radians(-70 + j * (140 / 12))
            p = Vector((math.sin(th) * math.sin(ph) * 0.142, math.sin(th) * math.cos(ph) * 0.162, math.cos(th) * 0.157))
            row.append(vis.verts.new(hc + p))
        rows.append(row)
    for i in range(6):
        for j in range(12):
            G.add_face(vis, [rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]])
    uvh.patch(vis, list(vis.faces), 'glass')
    mask = bmesh.new()
    mask.loops.layers.uv.verify()
    mc = E + Vector((0, 0.12, -0.075))
    ellipsoid(mask, mc, (0.05, 0.05, 0.055), seg=12, rings=6)
    limb(mask, [mc + Vector((0.02, 0.0, -0.05)), P(0.08, 4.76, 0.52), P(0.12, 4.80, 0.36)], [0.017, 0.017, 0.017], seg=8)
    uvh.patch(mask, list(mask.faces), 'grip')
    bm = bmesh.new()
    bm.loops.layers.uv.verify()
    for b in (suit, vest, blk, hel, vis, mask):
        G.join_bm(bm, b)
    orient_out(bm)
    G.smooth_sharp(bm, 70)
    ob = G.new_object('pilot', bm, [material])
    return ob
