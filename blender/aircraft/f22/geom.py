"""Geometry helpers for the F-22 build (Blender 5.2, bmesh + numpy).

Conventions: Blender world, meters. Aircraft nose -> +Y, up -> +Z, right wing -> +X.
Most airframe definitions use the fuselage station `s` (meters aft of the nose tip); y = Y0 - s.
"""
import math
import numpy as np
try:
    import bpy
    import bmesh
    from mathutils import Vector, Matrix
except ImportError:    # plain python (texture scripts)
    bpy = bmesh = Vector = Matrix = None

Y0 = 10.60          # station of the centre of gravity (object origin): y = Y0 - s (main gear 0.9 m aft)


def Y(s):
    return Y0 - s


# ----------------------------------------------------------------------------------------------
# 1-D keyframed parameters (monotone cubic / Fritsch-Carlson), evaluated as functions of s
# ----------------------------------------------------------------------------------------------
class P:
    """Keyframed scalar: P((s0, v0), (s1, v1), ...)(s) -> monotone cubic interpolation, clamped ends."""

    def __init__(self, *pairs, linear=False):
        pairs = sorted(pairs)
        self.x = np.array([p[0] for p in pairs], float)
        self.y = np.array([p[1] for p in pairs], float)
        self.linear = linear
        n = len(self.x)
        if n == 1:
            self.m = np.zeros(1)
            return
        h = np.diff(self.x)
        d = np.diff(self.y) / h
        m = np.zeros(n)
        m[0], m[-1] = d[0], d[-1]
        for k in range(1, n - 1):
            if d[k - 1] * d[k] <= 0:
                m[k] = 0.0
            else:
                w1 = 2 * h[k] + h[k - 1]
                w2 = h[k] + 2 * h[k - 1]
                m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
        self.m = m

    def __call__(self, s):
        x, y, m = self.x, self.y, self.m
        if len(x) == 1:
            return float(y[0])
        if s <= x[0]:
            return float(y[0])
        if s >= x[-1]:
            return float(y[-1])
        k = int(np.searchsorted(x, s) - 1)
        h = x[k + 1] - x[k]
        t = (s - x[k]) / h
        if self.linear:
            return float(y[k] + (y[k + 1] - y[k]) * t)
        t2, t3 = t * t, t * t * t
        return float((2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * h * m[k]
                     + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * h * m[k + 1])


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# ----------------------------------------------------------------------------------------------
# 2-D profile chains: G1 Hermite spline through key points, with sharp corners and fixed tangents
# ----------------------------------------------------------------------------------------------
def _unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v * 0.0


def chain(keys, nsub, sharp=None, tan=None, tension=1.0):
    """keys: list of 2-D points; nsub: subdivisions per segment (int or list); sharp: bools per key;
    tan: optional explicit tangent direction per key (None = automatic). Returns (N, 2) array incl. keys."""
    P_ = [np.asarray(k, float) for k in keys]
    n = len(P_)
    if isinstance(nsub, int):
        nsub = [nsub] * (n - 1)
    sharp = sharp or [False] * n
    tan = tan or [None] * n

    def tdir(k, outgoing):
        if tan[k] is not None:
            return _unit(np.asarray(tan[k], float))
        if sharp[k] or k == 0 or k == n - 1:
            if outgoing:
                return _unit(P_[k + 1] - P_[k])
            return _unit(P_[k] - P_[k - 1])
        a = _unit(P_[k] - P_[k - 1])
        b = _unit(P_[k + 1] - P_[k])
        return _unit(a + b)

    out = [P_[0]]
    for k in range(n - 1):
        a, b = P_[k], P_[k + 1]
        L = np.linalg.norm(b - a) * tension
        ta = tdir(k, True) * L
        tb = tdir(k + 1, False) * L
        for i in range(1, nsub[k] + 1):
            t = i / nsub[k]
            t2, t3 = t * t, t * t * t
            p = (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * ta + (-2 * t3 + 3 * t2) * b + (t3 - t2) * tb
            out.append(p)
    return np.array(out)


def resample_polyline(pts, n):
    """Resample a polyline (M, d) to n points evenly by arc length."""
    pts = np.asarray(pts, float)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    if cum[-1] < 1e-12:
        return np.repeat(pts[:1], n, axis=0)
    tgt = np.linspace(0, cum[-1], n)
    out = np.empty((n, pts.shape[1]))
    for d in range(pts.shape[1]):
        out[:, d] = np.interp(tgt, cum, pts[:, d])
    return out


def arc_params(pts):
    pts = np.asarray(pts, float)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    return cum / max(cum[-1], 1e-12)


def cosine_space(a, b, n, bias=1.0):
    """n points from a to b, clustered at both ends (bias=1) or only at a (bias='a')."""
    t = np.linspace(0, 1, n)
    if bias == 'a':
        u = 1 - np.cos(t * math.pi / 2)
    elif bias == 'b':
        u = np.sin(t * math.pi / 2)
    else:
        u = 0.5 - 0.5 * np.cos(t * math.pi)
    return a + (b - a) * u


# ----------------------------------------------------------------------------------------------
# bmesh construction
# ----------------------------------------------------------------------------------------------
def bm_grid(bm, G, closed_u=False, closed_v=False, flip=False, drop_degenerate=True, mat=0):
    """Add a quad grid G (nu, nv, 3) to bm. Returns 2-D list of BMVerts."""
    nu, nv = G.shape[0], G.shape[1]
    V = [[bm.verts.new(tuple(G[i, j])) for j in range(nv)] for i in range(nu)]
    iu = range(nu if closed_u else nu - 1)
    iv = range(nv if closed_v else nv - 1)
    for i in iu:
        i2 = (i + 1) % nu
        for j in iv:
            j2 = (j + 1) % nv
            q = [V[i][j], V[i2][j], V[i2][j2], V[i][j2]]
            if flip:
                q = q[::-1]
            add_face(bm, q, drop_degenerate, mat)
    return V


def add_face(bm, verts, drop_degenerate=True, mat=0):
    # remove consecutive duplicates (collapsed rows produce triangles)
    vs = []
    for v in verts:
        if not vs or (v.co - vs[-1].co).length > 1e-7:
            vs.append(v)
    if len(vs) > 2 and (vs[0].co - vs[-1].co).length < 1e-7:
        vs.pop()
    if len(vs) < 3:
        return None
    if len(set(vs)) != len(vs):
        return None
    if drop_degenerate:
        # area check
        c = Vector((0, 0, 0))
        for i in range(1, len(vs) - 1):
            c += (vs[i].co - vs[0].co).cross(vs[i + 1].co - vs[0].co)
        if c.length < 1e-10:
            return None
    try:
        f = bm.faces.new(vs)
    except ValueError:
        return None
    f.material_index = mat
    return f


def bm_poly(bm, pts, mat=0, flip=False):
    vs = [bm.verts.new(tuple(p)) for p in pts]
    if flip:
        vs = vs[::-1]
    return add_face(bm, vs, True, mat)


def bm_fan(bm, center, ring, mat=0, flip=False):
    c = bm.verts.new(tuple(center))
    vs = [bm.verts.new(tuple(p)) for p in ring]
    n = len(vs)
    for i in range(n - 1):
        q = [c, vs[i], vs[i + 1]]
        add_face(bm, q[::-1] if flip else q, True, mat)
    return c, vs


def orient_faces(bm, ref_fn, faces=None):
    """Flip faces whose normal points against ref_fn(center) (outward reference direction)."""
    for f in (faces if faces is not None else bm.faces):
        f.normal_update()
        c = f.calc_center_median()
        r = ref_fn(c)
        if r is None:
            continue
        if f.normal.dot(Vector(r)) < 0:
            f.normal_flip()


def weld(bm, dist=1e-4):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)


def smooth_sharp(bm, angle_deg=35.0, faces=None):
    """Smooth-shade faces and mark edges sharper than angle as sharp (split normals on export)."""
    lim = math.radians(angle_deg)
    for f in (faces if faces is not None else bm.faces):
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            a = e.calc_face_angle(0.0)
            e.smooth = a < lim
        else:
            e.smooth = True


def new_object(name, bm, materials=(), parent=None, collection=None):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def empty(name, loc=(0, 0, 0), parent=None, size=0.2, rot=None, collection=None):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = size
    ob.empty_display_type = 'PLAIN_AXES'
    (collection or bpy.context.scene.collection).objects.link(ob)
    ob.location = loc
    if rot is not None:
        ob.rotation_mode = 'QUATERNION'
        ob.rotation_quaternion = rot
    if parent is not None:
        set_parent(ob, parent)
    return ob


def set_parent(child, parent):
    """Parent keeping the world transform."""
    bpy.context.view_layer.update()
    mw = child.matrix_world.copy()
    child.parent = parent
    bpy.context.view_layer.update()
    child.matrix_parent_inverse = Matrix.Identity(4)
    child.matrix_world = mw


def frame_from_axis(axis_x, approx_z):
    """Rotation matrix whose local X = axis_x, local Z ~ approx_z (orthogonalized)."""
    x = Vector(axis_x).normalized()
    z = Vector(approx_z)
    z = (z - x * z.dot(x)).normalized()
    y = z.cross(x).normalized()
    return Matrix((x, y, z)).transposed()


def pivot_object(name, bm, pivot, axis_x, approx_z=(0, 0, 1), materials=(), parent=None, collection=None):
    """Create a mesh object from world-space bm geometry with its origin at `pivot` and local X along
    `axis_x` (hinge axis). Rotation 0 = neutral pose."""
    R = frame_from_axis(axis_x, approx_z)
    Rinv = R.transposed()
    pv = Vector(pivot)
    for v in bm.verts:
        v.co = Rinv @ (v.co - pv)
    ob = new_object(name, bm, materials, None, collection)
    ob.rotation_mode = 'QUATERNION'
    ob.location = pv
    ob.rotation_quaternion = R.to_quaternion()
    if parent is not None:
        bpy.context.view_layer.update()
        set_parent(ob, parent)
    return ob


def mirror_bm_x(bm):
    """Mirror all geometry in bm across X=0 (in place) and flip face winding."""
    for v in bm.verts:
        v.co.x = -v.co.x
    for f in bm.faces:
        f.normal_flip()


def copy_bm(bm):
    b2 = bm.copy()
    return b2


def join_bm(dst, src):
    """Append src bmesh geometry into dst (via a temporary mesh)."""
    me = bpy.data.meshes.new('_tmp_join')
    src.to_mesh(me)
    dst.from_mesh(me)
    bpy.data.meshes.remove(me)


def tri_count(ob):
    me = ob.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


# ----------------------------------------------------------------------------------------------
# primitives (bmesh) used for gear, interior, details
# ----------------------------------------------------------------------------------------------
def bm_cylinder(bm, p0, p1, r0, r1=None, seg=16, cap0=True, cap1=True, mat=0):
    r1 = r0 if r1 is None else r1
    p0, p1 = Vector(p0), Vector(p1)
    ax = (p1 - p0).normalized()
    ref = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
    u = ax.cross(ref).normalized()
    w = ax.cross(u).normalized()
    ring0, ring1 = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        d = u * math.cos(a) + w * math.sin(a)
        ring0.append(bm.verts.new(p0 + d * r0))
        ring1.append(bm.verts.new(p1 + d * r1))
    for i in range(seg):
        j = (i + 1) % seg
        add_face(bm, [ring0[i], ring0[j], ring1[j], ring1[i]], True, mat)
    if cap0:
        add_face(bm, ring0[::-1], True, mat)
    if cap1:
        add_face(bm, ring1, True, mat)
    return ring0, ring1


def bm_box(bm, center, size, rot=None, mat=0, bevel=0.0):
    """Axis-aligned (or rotated by Matrix rot) box."""
    c = Vector(center)
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    corners = [Vector((sx * hx, sy * hy, sz * hz)) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    if rot is not None:
        corners = [rot @ p for p in corners]
    vs = [bm.verts.new(c + p) for p in corners]
    idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    fs = []
    for q in idx:
        f = add_face(bm, [vs[i] for i in q], True, mat)
        if f:
            fs.append(f)
    return vs, fs


def bm_torus(bm, center, axis, R, r, seg=24, rseg=10, mat=0):
    c = Vector(center)
    ax = Vector(axis).normalized()
    ref = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
    u = ax.cross(ref).normalized()
    w = ax.cross(u).normalized()
    rows = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        d = u * math.cos(a) + w * math.sin(a)
        row = []
        for j in range(rseg):
            b = 2 * math.pi * j / rseg
            p = c + d * (R + r * math.cos(b)) + ax * (r * math.sin(b))
            row.append(bm.verts.new(p))
        rows.append(row)
    for i in range(seg):
        i2 = (i + 1) % seg
        for j in range(rseg):
            j2 = (j + 1) % rseg
            add_face(bm, [rows[i][j], rows[i2][j], rows[i2][j2], rows[i][j2]], True, mat)
    return rows


def bm_revolve(bm, profile, axis_p, axis_d, seg=32, mat=0, cap=False):
    """Revolve a 2-D profile [(r, h), ...] around the axis (point, direction). Returns rows."""
    c = Vector(axis_p)
    ax = Vector(axis_d).normalized()
    ref = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
    u = ax.cross(ref).normalized()
    w = ax.cross(u).normalized()
    rows = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        d = u * math.cos(a) + w * math.sin(a)
        rows.append([bm.verts.new(c + d * r + ax * h) for (r, h) in profile])
    for i in range(seg):
        i2 = (i + 1) % seg
        for j in range(len(profile) - 1):
            add_face(bm, [rows[i][j], rows[i][j + 1], rows[i2][j + 1], rows[i2][j]], True, mat)
    return rows


def bm_extrude_polygon(bm, poly2d, frame_origin, ex, ey, depth, mat=0, cap=True):
    """Extrude a planar polygon given in 2-D coords of frame (origin, ex, ey) along ex x ey by depth."""
    o, ex, ey = Vector(frame_origin), Vector(ex), Vector(ey)
    n = ex.cross(ey).normalized()
    top = [bm.verts.new(o + ex * p[0] + ey * p[1] + n * depth) for p in poly2d]
    bot = [bm.verts.new(o + ex * p[0] + ey * p[1]) for p in poly2d]
    m = len(poly2d)
    for i in range(m):
        j = (i + 1) % m
        add_face(bm, [bot[i], bot[j], top[j], top[i]], True, mat)
    if cap:
        add_face(bm, top, True, mat)
        add_face(bm, bot[::-1], True, mat)
    return top, bot
