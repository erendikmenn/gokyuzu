"""Small numpy mesh kit for the 737 builder: build geometry as arrays, then turn it into Blender objects.

MeshData holds verts (N,3), faces (list of index lists), per-loop UVs (flat list aligned with faces)
and a per-face material slot index. Everything is in Blender coordinates unless noted.
"""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Matrix, Vector


class MeshData:
    def __init__(self):
        self.v = np.zeros((0, 3))
        self.f = []
        self.uv = []      # list of (u, v) per loop, in face order
        self.mi = []      # material slot per face
        self.sharp = []   # per face: flat shaded?

    @property
    def nv(self):
        return len(self.v)

    def add(self, verts, faces, uvs=None, mat=0, flat=False):
        base = len(self.v)
        verts = np.asarray(verts, float).reshape(-1, 3)
        self.v = np.vstack([self.v, verts]) if len(self.v) else verts.copy()
        k = 0
        for fi, face in enumerate(faces):
            self.f.append([base + int(i) for i in face])
            if uvs is None:
                self.uv.extend([(0.5, 0.5)] * len(face))
            else:
                self.uv.extend(uvs[k:k + len(face)])
            k += len(face)
            self.mi.append(mat if np.isscalar(mat) else mat[fi])
            self.sharp.append(flat)
        return self

    def merge(self, other, mat_offset=0):
        base = len(self.v)
        self.v = np.vstack([self.v, other.v]) if len(self.v) else other.v.copy()
        self.f.extend([[base + i for i in f] for f in other.f])
        self.uv.extend(other.uv)
        self.mi.extend([m + mat_offset for m in other.mi])
        self.sharp.extend(other.sharp)
        return self

    def copy(self):
        m = MeshData()
        m.v = self.v.copy(); m.f = [list(f) for f in self.f]; m.uv = list(self.uv); m.mi = list(self.mi)
        m.sharp = list(self.sharp)
        return m

    def transform(self, M):
        M = np.asarray(M, float)
        h = np.hstack([self.v, np.ones((len(self.v), 1))])
        self.v = (h @ M.T)[:, :3]
        if np.linalg.det(M[:3, :3]) < 0:
            self.flip()
        return self

    def translate(self, d):
        self.v = self.v + np.asarray(d, float)
        return self

    def mirror_x(self):
        self.v = self.v * np.array([-1.0, 1.0, 1.0])
        self.flip()
        return self

    def flip(self):
        k = 0
        new_uv = []
        for i, f in enumerate(self.f):
            n = len(f)
            uvs = self.uv[k:k + n]
            self.f[i] = f[::-1]
            new_uv.extend(uvs[::-1])
            k += n
        self.uv = new_uv
        return self

    def set_mat(self, m):
        self.mi = [m] * len(self.f)
        return self

    def ntris(self):
        return sum(len(f) - 2 for f in self.f)


def grid(P, UV=None, wrap=False, flip=False, mat=0, flat=False, md=None):
    """Quad grid from P (ni, nj, 3). If wrap, columns are closed (j -> j+1 mod nj) and UV must have nj+1
    columns (the last is the seam copy). Returns MeshData."""
    md = md or MeshData()
    P = np.asarray(P, float)
    ni, nj = P.shape[:2]
    base = md.nv
    md.v = np.vstack([md.v, P.reshape(-1, 3)]) if md.nv else P.reshape(-1, 3).copy()
    ncol = nj if wrap else nj - 1
    for i in range(ni - 1):
        for j in range(ncol):
            j1 = (j + 1) % nj
            a, b, c, d = i * nj + j, i * nj + j1, (i + 1) * nj + j1, (i + 1) * nj + j
            face = [a, b, c, d]
            ju = j + 1
            uvs = None
            if UV is not None:
                uvs = [tuple(UV[i, j]), tuple(UV[i, ju]), tuple(UV[i + 1, ju]), tuple(UV[i + 1, j])]
            else:
                uvs = [(0.5, 0.5)] * 4
            if flip:
                face = face[::-1]
                uvs = uvs[::-1]
            md.f.append([base + x for x in face])
            md.uv.extend(uvs)
            md.mi.append(mat)
            md.sharp.append(flat)
    return md


def cap(md, ring_idx, center=None, uv=(0.5, 0.5), flip=False, mat=0):
    """Close a ring of vertex indices with an n-gon (or a fan to center)."""
    ring = list(ring_idx)
    if center is None:
        f = ring[::-1] if flip else ring
        md.f.append(f); md.uv.extend([uv] * len(f)); md.mi.append(mat); md.sharp.append(True)
    else:
        c = md.nv
        md.v = np.vstack([md.v, np.asarray(center, float)[None]])
        n = len(ring)
        for k in range(n):
            f = [ring[k], ring[(k + 1) % n], c]
            if flip:
                f = f[::-1]
            md.f.append(f); md.uv.extend([uv] * 3); md.mi.append(mat); md.sharp.append(False)
    return md


# ------------------------------------------------------------------ primitives (Blender coords)
def frame_from(axis, ref=(0, 0, 1)):
    a = np.asarray(axis, float); a = a / np.linalg.norm(a)
    r = np.asarray(ref, float)
    if abs(np.dot(a, r / np.linalg.norm(r))) > 0.95:
        r = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
    u = r - a * np.dot(r, a); u /= np.linalg.norm(u)
    w = np.cross(a, u)
    return a, u, w


def lathe(profile, n=24, origin=(0, 0, 0), axis=(0, 0, 1), ref=(1, 0, 0), mat=0, flat=False, uv_scale=(1, 1),
          angle0=0.0, arc=2 * math.pi, close_ends=False, md=None):
    """Revolve a profile [(r, h), ...] around axis. Returns MeshData. Poles (r=0) are collapsed."""
    md = md or MeshData()
    a, u, w = frame_from(axis, ref)
    o = np.asarray(origin, float)
    prof = np.asarray(profile, float)
    full = abs(arc - 2 * math.pi) < 1e-6
    nj = n if full else n + 1
    ang = angle0 + np.arange(nj) * (arc / n)
    P = (o[None, None] + prof[:, 1, None, None] * a[None, None]
         + prof[:, 0, None, None] * (np.cos(ang)[None, :, None] * u[None, None] + np.sin(ang)[None, :, None] * w[None, None]))
    # UV: u along profile arc-length, v around
    seg = np.concatenate([[0], np.cumsum(np.hypot(np.diff(prof[:, 0]), np.diff(prof[:, 1])))])
    UV = np.zeros((len(prof), n + 1, 2))
    UV[..., 0] = (seg / max(seg[-1], 1e-6))[:, None] * uv_scale[0]
    UV[..., 1] = (np.arange(n + 1) / n)[None, :] * uv_scale[1]
    base = md.nv
    grid(P, UV if full else UV[:, :nj], wrap=full, mat=mat, flat=flat, md=md)
    if close_ends:
        cap(md, [base + j for j in range(nj)], flip=False, mat=mat)
        cap(md, [base + (len(prof) - 1) * nj + j for j in range(nj)], flip=True, mat=mat)
    return md


def tube(p0, p1, r0, r1=None, n=16, caps=True, mat=0, ref=(0, 0, 1), flat=False, md=None):
    r1 = r0 if r1 is None else r1
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
    L = np.linalg.norm(p1 - p0)
    prof = [(r0, 0.0), (r1, L)]
    if caps:
        prof = [(0.0, 0.0), (r0, 0.0), (r0, 0.0), (r1, L), (r1, L), (0.0, L)]
    md = md or MeshData()
    lathe(prof, n=n, origin=p0, axis=p1 - p0, ref=ref, mat=mat, flat=flat, md=md)
    return md


def box(center, size, axes=None, mat=0, md=None, uv_scale=1.0):
    md = md or MeshData()
    c = np.asarray(center, float); sx, sy, sz = [s / 2 for s in size]
    A = np.eye(3) if axes is None else np.asarray(axes, float)   # rows = local x, y, z axes in world
    corners = np.array([[-sx, -sy, -sz], [sx, -sy, -sz], [sx, sy, -sz], [-sx, sy, -sz],
                        [-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz]])
    V = c + corners @ A
    faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
    uvs = []
    for f in faces:
        uvs.extend([(0, 0), (uv_scale, 0), (uv_scale, uv_scale), (0, uv_scale)])
    md.add(V, faces, uvs, mat=mat, flat=True)
    return md


def rounded_rect(w, h, r, n=4):
    """2D rounded rectangle polygon (counter-clockwise), centred at 0."""
    r = min(r, w / 2 - 1e-4, h / 2 - 1e-4)
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.array(pts)


def extrude(poly2d, depth, origin, xaxis, yaxis, mat=0, side_mat=None, md=None, bevel=0.0, uv_rect=None, back=True):
    """Extrude a 2D polygon (ccw) along the normal (xaxis x yaxis) by depth. Front face at +depth.
    uv_rect=(u0,v0,u1,v1) maps the polygon bbox onto that UV rectangle for the front face."""
    md = md or MeshData()
    poly = np.asarray(poly2d, float)
    x = np.asarray(xaxis, float); y = np.asarray(yaxis, float); nrm = np.cross(x, y)
    o = np.asarray(origin, float)
    n = len(poly)
    base3 = o + poly[:, 0:1] * x + poly[:, 1:2] * y
    top = base3 + nrm * depth
    if bevel > 0:
        c = poly.mean(0)
        inner = c + (poly - c) * (1 - bevel)
        top = o + inner[:, 0:1] * x + inner[:, 1:2] * y + nrm * depth
    V = np.vstack([base3, top])
    faces = []
    uvs = []
    mn, mx = poly.min(0), poly.max(0)
    def puv(p):
        if uv_rect is None:
            return (0.5, 0.5)
        t = (p - mn) / np.maximum(mx - mn, 1e-9)
        return (uv_rect[0] + t[0] * (uv_rect[2] - uv_rect[0]), uv_rect[1] + t[1] * (uv_rect[3] - uv_rect[1]))
    front = [n + i for i in range(n)]
    md_front_uv = [puv(poly[i]) for i in range(n)]
    sm = mat if side_mat is None else side_mat
    b = md.nv
    md.v = np.vstack([md.v, V]) if md.nv else V
    md.f.append([b + i for i in front]); md.uv.extend(md_front_uv); md.mi.append(mat); md.sharp.append(True)
    if back:
        md.f.append([b + i for i in range(n)][::-1]); md.uv.extend([(0.5, 0.5)] * n); md.mi.append(sm); md.sharp.append(True)
    for i in range(n):
        j = (i + 1) % n
        md.f.append([b + i, b + j, b + n + j, b + n + i]); md.uv.extend([(0.02, 0.02)] * 4); md.mi.append(sm); md.sharp.append(True)
    return md


def sweep(profile2d, path, up=(0, 0, 1), closed_profile=True, mat=0, md=None, uv_v_scale=1.0):
    """Sweep a 2D profile (x = lateral, y = up) along a 3D polyline path."""
    md = md or MeshData()
    path = np.asarray(path, float)
    prof = np.asarray(profile2d, float)
    P = np.zeros((len(path), len(prof), 3))
    upv = np.asarray(up, float)
    for i in range(len(path)):
        t = path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        lat = np.cross(t, upv); lat /= np.linalg.norm(lat)
        u2 = np.cross(lat, t)
        P[i] = path[i] + prof[:, 0:1] * lat + prof[:, 1:2] * u2
    seg = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    n = len(prof)
    UV = np.zeros((len(path), n + 1, 2))
    UV[..., 0] = seg[:, None]
    UV[..., 1] = (np.arange(n + 1) / n)[None] * uv_v_scale
    grid(P, UV if closed_profile else UV[:, :n], wrap=closed_profile, mat=mat, md=md)
    return md


# ------------------------------------------------------------------ Blender objects
def to_mesh(name, md, smooth=True, sharp_angle=None):
    me = bpy.data.meshes.new(name)
    verts = md.v
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    nl = sum(len(f) for f in md.f)
    me.loops.add(nl)
    me.polygons.add(len(md.f))
    loop_start = np.zeros(len(md.f), dtype=np.int32)
    loop_total = np.zeros(len(md.f), dtype=np.int32)
    vi = np.zeros(nl, dtype=np.int32)
    k = 0
    for i, f in enumerate(md.f):
        loop_start[i] = k; loop_total[i] = len(f)
        vi[k:k + len(f)] = f
        k += len(f)
    me.loops.foreach_set('vertex_index', vi)
    me.polygons.foreach_set('loop_start', loop_start)
    try:
        me.polygons.foreach_set('loop_total', loop_total)
    except Exception:
        pass
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', np.asarray(md.uv, np.float32).ravel())
    me.polygons.foreach_set('material_index', np.asarray(md.mi, np.int32))
    sm = np.array([smooth and not s for s in md.sharp], dtype=bool)
    me.polygons.foreach_set('use_smooth', sm)
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    if sharp_angle is not None:
        me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    return me


def obj(name, md, mats, parent=None, smooth=True, sharp_angle=None, matrix=None, coll=None):
    """Create an object. md verts are in WORLD coords; if matrix (4x4 world) is given the mesh is stored
    in that local frame and the object gets that matrix."""
    md2 = md
    if matrix is not None:
        M = np.asarray(matrix, float)
        md2 = md.copy()
        Mi = np.linalg.inv(M)
        h = np.hstack([md2.v, np.ones((len(md2.v), 1))])
        md2.v = (h @ Mi.T)[:, :3]
    me = to_mesh(name, md2, smooth=smooth, sharp_angle=sharp_angle)
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(o)
    if matrix is not None:
        o.matrix_world = Matrix(np.asarray(matrix).tolist())
    if parent is not None:
        set_parent(o, parent)
    return o


def empty(name, loc, parent=None, matrix=None, size=0.2, coll=None):
    o = bpy.data.objects.new(name, None)
    o.empty_display_size = size
    (coll or bpy.context.scene.collection).objects.link(o)
    if matrix is not None:
        o.matrix_world = Matrix(np.asarray(matrix).tolist())
    else:
        o.location = Vector(loc)
    if parent is not None:
        set_parent(o, parent)
    return o


def set_parent(child, parent):
    """Parent keeping the world transform, with an identity parent-inverse (clean glTF local transforms)."""
    bpy.context.view_layer.update()
    mw = child.matrix_world.copy()
    pw = parent.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)
    child.matrix_basis = pw.inverted() @ mw


def orient_outward(md, center=None):
    """Flip the whole mesh if most face normals point towards the centroid."""
    V = md.v
    c = V.mean(0) if center is None else np.asarray(center, float)
    s = 0.0
    for f in md.f:
        if len(f) < 3:
            continue
        p = V[f]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        s += np.dot(p.mean(0) - c, n)
    if s < 0:
        md.flip()
    return md


def hinge_matrix(origin, xdir, zref=(0, 0, 1)):
    """4x4 world matrix with local X along xdir, Z as close to zref as possible."""
    x = np.asarray(xdir, float); x /= np.linalg.norm(x)
    z = np.asarray(zref, float)
    z = z - x * np.dot(z, x); z /= np.linalg.norm(z)
    y = np.cross(z, x)
    M = np.eye(4)
    M[:3, 0] = x; M[:3, 1] = y; M[:3, 2] = z; M[:3, 3] = origin
    return M


def tri_count(objs):
    n = 0
    for o in objs:
        if o.type == 'MESH':
            n += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return n
