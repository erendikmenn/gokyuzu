"""Mesh building helpers for the airport buildings (pure Python lists -> one bpy mesh per object).

Coordinates: Blender X = local x (east), Blender Y = -local z (north), Z = up. Objects are created with their origin on
the building anchor (ground level); vertices are relative to it.
"""
import math
import bpy
from mathutils import Vector, geometry
import materials as M


class MB:
    def __init__(self):
        self.v, self.f, self.uv, self.mi, self.smooth = [], [], [], [], []
        self.mats = []

    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def face(self, pts, uvs, mat, smooth=False):
        base = len(self.v)
        self.v.extend(tuple(p) for p in pts)
        self.f.append(list(range(base, base + len(pts))))
        self.uv.append([tuple(u) for u in uvs])
        self.mi.append(self.mat(mat))
        self.smooth.append(smooth)

    def quad(self, a, b, c, d, mat, uv=((0, 0), (1, 0), (1, 1), (0, 1)), smooth=False):
        self.face([a, b, c, d], uv, mat, smooth)

    # ---------------------------------------------------------------- primitives
    def wall(self, a, b, z0, z1, mat, u0=0.0, flip=False, tile=None):
        """Vertical quad from 2D a to b, UV in metres / tile (u continues from u0). Returns u at b."""
        tw, th = tile or M.tile(mat)
        L = math.dist(a, b)
        u1 = u0 + L / tw
        pts = [(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)]
        uvs = [(u0, z0 / th), (u1, z0 / th), (u1, z1 / th), (u0, z1 / th)]
        if flip:
            pts, uvs = pts[::-1], uvs[::-1]
        self.face(pts, uvs, mat)
        return u1

    def ring_walls(self, ring, z0, z1, mat, flip=False, tile=None):
        u = 0.0
        n = len(ring)
        for i in range(n):
            u = self.wall(ring[i], ring[(i + 1) % n], z0, z1, mat, u, flip, tile)

    def cap(self, outer, holes, z, mat, up=True, tile=None, uv_origin=(0.0, 0.0)):
        """Horizontal polygon (with holes) at height z, planar UVs."""
        tw, th = tile or M.tile(mat)
        rings = [[Vector((p[0], p[1], z)) for p in outer]] + [[Vector((p[0], p[1], z)) for p in h] for h in holes]
        try:
            tris = geometry.tessellate_polygon(rings)
        except Exception:
            return
        flat = [p for r in rings for p in r]
        for t in tris:
            a, b, c = flat[t[0]], flat[t[1]], flat[t[2]]
            nz = (b - a).cross(c - a).z
            if (nz < 0) == up:
                a, c = c, a
            pts = [a, b, c]
            self.face([tuple(p) for p in pts], [((p.x - uv_origin[0]) / tw, (p.y - uv_origin[1]) / th) for p in pts], mat)

    def box(self, cx, cy, z0, sx, sy, sz, mat, rot=0.0, tile=None, top=True, bottom=False):
        """Axis box (sx along local X rotated by rot radians about Z)."""
        c, s = math.cos(rot), math.sin(rot)
        hx, hy = sx / 2, sy / 2
        P = lambda x, y: (cx + x * c - y * s, cy + x * s + y * c)
        ring = [P(-hx, -hy), P(hx, -hy), P(hx, hy), P(-hx, hy)]
        self.ring_walls(ring, z0, z0 + sz, mat, tile=tile or (max(sx, sy, 1.0), max(sz, 1.0)))
        if top:
            self.cap(ring, [], z0 + sz, mat, True, tile=tile or (max(sx, 1.0), max(sy, 1.0)))
        if bottom:
            self.cap(ring, [], z0, mat, False, tile=tile or (max(sx, 1.0), max(sy, 1.0)))

    def cylinder(self, cx, cy, z0, z1, r0, r1, mat, seg=16, top=True, smooth=True, tile=None):
        tw, th = tile or (2 * math.pi * max(r0, r1) / 4, max(1.0, (z1 - z0)))
        for i in range(seg):
            a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
            p = [(cx + r0 * math.cos(a0), cy + r0 * math.sin(a0), z0), (cx + r0 * math.cos(a1), cy + r0 * math.sin(a1), z0),
                 (cx + r1 * math.cos(a1), cy + r1 * math.sin(a1), z1), (cx + r1 * math.cos(a0), cy + r1 * math.sin(a0), z1)]
            u0 = 2 * math.pi * r0 * i / seg / tw
            u1 = 2 * math.pi * r0 * (i + 1) / seg / tw
            self.face(p, [(u0, z0 / th), (u1, z0 / th), (u1, z1 / th), (u0, z1 / th)], mat, smooth)
        if top:
            ring = [(cx + r1 * math.cos(2 * math.pi * i / seg), cy + r1 * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
            self.cap(ring, [], z1, mat, True, tile=(2 * r1, 2 * r1))

    def loft(self, rings, mat, closed=True, smooth=True, tile=(4.0, 4.0), cap_top=True):
        """rings: list of lists of 3D points with equal counts (bottom -> top)."""
        tw, th = tile
        n = len(rings[0])
        for k in range(len(rings) - 1):
            A, B = rings[k], rings[k + 1]
            u = 0.0
            for i in range(n if closed else n - 1):
                j = (i + 1) % n
                L = math.dist(A[i][:2], A[j][:2])
                self.face([A[i], A[j], B[j], B[i]], [(u / tw, A[i][2] / th), ((u + L) / tw, A[j][2] / th), ((u + L) / tw, B[j][2] / th), (u / tw, B[i][2] / th)], mat, smooth)
                u += L
        if cap_top:
            top = rings[-1]
            self.cap([p[:2] for p in top], [], top[0][2], mat, True, tile=(8.0, 8.0))

    # ---------------------------------------------------------------- output
    def to_object(self, name, location=(0, 0, 0), collection=None):
        if not self.f:
            return None
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        uvl = me.uv_layers.new(name='UVMap')
        li = 0
        for fi, poly in enumerate(me.polygons):
            poly.material_index = self.mi[fi]
            poly.use_smooth = self.smooth[fi]
            for k, loop in enumerate(poly.loop_indices):
                uvl.data[loop].uv = self.uv[fi][k]
        for mname in self.mats:
            me.materials.append(M.get(mname))
        me.validate(clean_customdata=False)
        me.update()
        ob = bpy.data.objects.new(name, me)
        ob.location = location
        (collection or bpy.context.scene.collection).objects.link(ob)
        return ob


def ccw(ring):
    a = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        a += x0 * y1 - x1 * y0
    return a > 0


def orient(ring, want_ccw=True):
    return ring if ccw(ring) == want_ccw else ring[::-1]


def point_in(ring, x, y):
    inside = False
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside
