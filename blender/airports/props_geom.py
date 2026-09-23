"""Tiny procedural mesh builder for the airport props (W4). Vertex-coloured, glTF friendly.

Blender frame: +X right, +Y forward (nose), +Z up. Colours are given in sRGB (0..1) and stored linear.
"""
import math
import bpy
from mathutils import Vector, Matrix


def srgb_to_lin(c):
    return tuple(((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c[:3])


class MB:
    """Mesh builder: vertices, faces, per-face colour (linear) and smooth flag."""

    def __init__(self):
        self.v = []
        self.f = []
        self.col = []
        self.smooth = []

    def vert(self, p):
        self.v.append(tuple(float(x) for x in p))
        return len(self.v) - 1

    def face(self, idx, color, smooth=False):
        self.f.append(tuple(idx))
        self.col.append(srgb_to_lin(color))
        self.smooth.append(bool(smooth))

    def poly(self, pts, color, smooth=False):
        self.face([self.vert(p) for p in pts], color, smooth)

    def merge(self, other, matrix=None):
        base = len(self.v)
        for p in other.v:
            q = matrix @ Vector(p) if matrix is not None else p
            self.v.append(tuple(q))
        for f, c, s in zip(other.f, other.col, other.smooth):
            self.f.append(tuple(i + base for i in f))
            self.col.append(c)
            self.smooth.append(s)

    @property
    def tris(self):
        return sum(len(f) - 2 for f in self.f)

    def to_object(self, name, material, parent=None, collection=None):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        me.update()
        attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
        k = 0
        for pi, poly in enumerate(me.polygons):
            c = self.col[pi]
            for li in poly.loop_indices:
                attr.data[li].color = (c[0], c[1], c[2], 1.0)
        me.polygons.foreach_set('use_smooth', self.smooth)
        me.materials.append(material)
        ob = bpy.data.objects.new(name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        if parent is not None:
            ob.parent = parent
        return ob


def _orient(mb, idx, center):
    """Flip polygon winding so its normal points away from `center`."""
    pts = [Vector(mb.v[i]) for i in idx]
    n = Vector((0, 0, 0))
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    c = sum(pts, Vector((0, 0, 0))) / len(pts)
    if n.dot(c - Vector(center)) < 0:
        return list(reversed(idx))
    return list(idx)


def loft(mb, sections, color, smooth=True, cap0=True, cap1=True, cap_color=None, closed=True):
    """sections: list of lists of 3D points (same count, each a closed convex-ish ring).
    color: rgb or callable(centroid Vector, section_index, seg_index) -> rgb."""
    rings = [[mb.vert(p) for p in s] for s in sections]
    cents = [sum((Vector(p) for p in s), Vector((0, 0, 0))) / len(s) for s in sections]
    n = len(sections[0])
    segs = n if closed else n - 1
    for k in range(len(rings) - 1):
        r0, r1 = rings[k], rings[k + 1]
        axis_c = (cents[k] + cents[k + 1]) / 2
        for i in range(segs):
            j = (i + 1) % n
            idx = [r0[i], r0[j], r1[j], r1[i]]
            # degenerate (collapsed) quads -> triangles
            pts = [Vector(mb.v[q]) for q in idx]
            uniq = []
            for q, p in zip(idx, pts):
                if all((p - Vector(mb.v[u])).length > 1e-6 for u in uniq):
                    uniq.append(q)
            if len(uniq) < 3:
                continue
            c = sum((Vector(mb.v[q]) for q in uniq), Vector((0, 0, 0))) / len(uniq)
            col = color(c, k, i) if callable(color) else color
            mb.face(_orient(mb, uniq, axis_c), col, smooth)
    cc = cap_color or (color if not callable(color) else None)
    for which, do in ((0, cap0), (len(sections) - 1, cap1)):
        if not do:
            continue
        s = sections[which]
        other = cents[1] if which == 0 else cents[-2]
        idx = [mb.vert(p) for p in s]
        # cap normal must point away from the neighbouring section
        cen = cents[which]
        away = cen + (cen - other)
        pts = [Vector(p) for p in s]
        col = cc if cc is not None else color(cen, which, 0)
        idx2 = _orient(mb, idx, cen - (away - cen))
        mb.face(idx2, col, False)
    return mb


def ellipse(cx, y, cz, rx, rz, n=16, squash_top=1.0, squash_bot=1.0, phase=0.0):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n + phase
        s = math.sin(a)
        z = cz + rz * s * (squash_top if s > 0 else squash_bot)
        pts.append((cx + rx * math.cos(a), y, z))
    return pts


def ring_perp(center, axis, r, n=12, up=Vector((0, 0, 1))):
    axis = Vector(axis).normalized()
    if abs(axis.dot(up)) > 0.95:
        up = Vector((1, 0, 0))
    u = axis.cross(up).normalized()
    w = axis.cross(u).normalized()
    c = Vector(center)
    return [tuple(c + (u * math.cos(2 * math.pi * i / n) + w * math.sin(2 * math.pi * i / n)) * r) for i in range(n)]


def cylinder(mb, p0, p1, r0, r1=None, n=12, color=(0.5, 0.5, 0.5), smooth=True, caps=True, cap_color=None):
    r1 = r0 if r1 is None else r1
    ax = Vector(p1) - Vector(p0)
    return loft(mb, [ring_perp(p0, ax, r0, n), ring_perp(p1, ax, r1, n)], color, smooth, caps, caps, cap_color)


def box(mb, center, size, color, rot_z=0.0, colors=None):
    """Axis box (optionally rotated about Z). colors: dict face->rgb for 'top','bottom','front'(+Y),'back','left','right'."""
    cx, cy, cz = center
    sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
    c, s = math.cos(rot_z), math.sin(rot_z)
    def P(x, y, z):
        return (cx + x * c - y * s, cy + x * s + y * c, cz + z)
    V = {k: P(*k) for k in [(a * sx, b * sy, d * sz) for a in (-1, 1) for b in (-1, 1) for d in (-1, 1)]}
    def g(a, b, d):
        return V[(a * sx, b * sy, d * sz)]
    faces = {
        'top': [g(-1, -1, 1), g(1, -1, 1), g(1, 1, 1), g(-1, 1, 1)],
        'bottom': [g(-1, -1, -1), g(-1, 1, -1), g(1, 1, -1), g(1, -1, -1)],
        'front': [g(-1, 1, -1), g(-1, 1, 1), g(1, 1, 1), g(1, 1, -1)],
        'back': [g(-1, -1, -1), g(1, -1, -1), g(1, -1, 1), g(-1, -1, 1)],
        'right': [g(1, -1, -1), g(1, 1, -1), g(1, 1, 1), g(1, -1, 1)],
        'left': [g(-1, -1, -1), g(-1, -1, 1), g(-1, 1, 1), g(-1, 1, -1)],
    }
    colors = colors or {}
    for k, pts in faces.items():
        if colors.get(k) == 'skip':
            continue
        mb.poly(pts, colors.get(k, color))
    return mb


def prism(mb, pts2d_yz, x0, x1, color, colors=None):
    """Extrude a side profile polygon (list of (y, z)) between x0 and x1 (windings fixed automatically)."""
    colors = colors or {}
    L = [(x0, y, z) for y, z in pts2d_yz]
    R = [(x1, y, z) for y, z in pts2d_yz]
    n = len(pts2d_yz)
    cen = Vector(((x0 + x1) / 2, sum(p[0] for p in pts2d_yz) / n, sum(p[1] for p in pts2d_yz) / n))
    li = [mb.vert(p) for p in L]
    ri = [mb.vert(p) for p in R]
    mb.face(_orient(mb, li, cen), colors.get('left', color))
    mb.face(_orient(mb, ri, cen), colors.get('right', color))
    for i in range(n):
        j = (i + 1) % n
        idx = [mb.vert(L[i]), mb.vert(L[j]), mb.vert(R[j]), mb.vert(R[i])]
        mid = (Vector(L[i]) + Vector(L[j])) / 2
        col = colors.get('rim', color)
        if callable(col):
            col = col(mid)
        mb.face(_orient(mb, idx, Vector((mid.x, cen.y, cen.z))), col)
    return mb


def wheel(mb, center, r, width, n=10, color=(0.08, 0.08, 0.08), hub=(0.6, 0.6, 0.6), axis=(1, 0, 0)):
    c = Vector(center)
    a = Vector(axis).normalized() * width / 2
    cylinder(mb, c - a, c + a, r, r, n, color, smooth=True, caps=True, cap_color=hub)
    return mb


def wing_section(x, y_le, chord, z, t, sweep_up=0.0):
    """Wing cross-section in the x = const plane: LE, upper, TE, lower (diamond-ish airfoil)."""
    ym = y_le - 0.32 * chord
    return [(x, y_le, z), (x, ym, z + t * 0.6), (x, y_le - chord, z + 0.02), (x, ym, z - t * 0.4)]


def fin_section(z, y_le, chord, x, t):
    ym = y_le - 0.35 * chord
    return [(x, y_le, z), (x + t / 2, ym, z), (x, y_le - chord, z), (x - t / 2, ym, z)]


def mirror_x(mb_src):
    """Return a new MB mirrored in X (winding fixed)."""
    m = MB()
    for p in mb_src.v:
        m.v.append((-p[0], p[1], p[2]))
    for f, c, s in zip(mb_src.f, mb_src.col, mb_src.smooth):
        m.f.append(tuple(reversed(f)))
        m.col.append(c)
        m.smooth.append(s)
    return m


def add_lin(mb, other):
    """Merge keeping already-linear colours."""
    base = len(mb.v)
    mb.v.extend(other.v)
    for f, c, s in zip(other.f, other.col, other.smooth):
        mb.f.append(tuple(i + base for i in f))
        mb.col.append(c)
        mb.smooth.append(s)
