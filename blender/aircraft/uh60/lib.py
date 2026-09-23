"""Geometry helpers for the UH-60 build (Blender 5.2, headless).

Design frame "G": meters, x = right, y = forward (main-rotor mast axis at y = 0), z = up from the ground.
Everything is modelled in G and parented under the root empty, which is offset by -CG so that the exported
scene origin is the centre of gravity (CONTRACTS-SF.md §1, §5).
"""
import math
import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix, Euler

# ----------------------------------------------------------------------------------------------------------------
# interpolation

def pchip(xs, ys, x):
    """Monotone piecewise cubic (Fritsch-Carlson) interpolation. xs increasing."""
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    x = np.asarray(x, float)
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.zeros_like(ys)
    m[0], m[-1] = d[0], d[-1]
    for k in range(1, len(xs) - 1):
        if d[k - 1] * d[k] <= 0:
            m[k] = 0.0
        else:
            w1 = 2 * h[k] + h[k - 1]
            w2 = h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    idx = np.clip(np.searchsorted(xs, x) - 1, 0, len(xs) - 2)
    t = (x - xs[idx]) / h[idx]
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * ys[idx] + (t3 - 2 * t2 + t) * h[idx] * m[idx]
            + (-2 * t3 + 3 * t2) * ys[idx + 1] + (t3 - t2) * h[idx] * m[idx + 1])


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------------------------------------------
# section profiles

def half_profile(w, zb, zm, zt, nb=2.5, nt=2.5, tt=0.0, n=24, xoff=0.0, bias=None):
    """Right half of a symmetric cross-section, bottom centre -> max width -> top centre, resampled by arc length.
    w: half width at z = zm; lower quadrant exponent nb, upper nt; tt = tumblehome (upper x shrinks by tt*s^2)."""
    t = np.linspace(0, 1, 400)
    ang = t * math.pi / 2
    # lower quadrant: from bottom centre (ang=0) to side (ang=pi/2)
    xl = w * np.sin(ang) ** (2 / nb)
    zl = zm - (zm - zb) * np.cos(ang) ** (2 / nb)
    # upper quadrant: side to top centre
    s = np.sin(ang) ** (2 / nt)                      # height fraction 0..1
    xu = w * np.cos(ang) ** (2 / nt) * (1 - tt * s * s)
    zu = zm + (zt - zm) * s
    xs = np.concatenate([xl, xu[1:]])
    zs = np.concatenate([zl, zu[1:]])
    seg = np.hypot(np.diff(xs), np.diff(zs))
    L = np.concatenate([[0], np.cumsum(seg)])
    u = np.linspace(0, 1, n + 1)
    if bias is not None:
        u = bias(u)
    L0 = u * L[-1]
    x = np.interp(L0, L, xs) + xoff
    z = np.interp(L0, L, zs)
    x[0] = xoff
    x[-1] = xoff
    return x, z


def ring_from_half(y, x, z):
    """Closed ring (bottom centre, right side up, top, left side down), no duplicate points."""
    n = len(x) - 1
    xr = np.concatenate([x, -x[n - 1:0:-1]])
    zr = np.concatenate([z, z[n - 1:0:-1]])
    yr = np.full_like(xr, y)
    return np.stack([xr, yr, zr], 1)


def loft_rings(rings, cap_start=None, cap_end=None, closed=True):
    """rings: list of (N,3) arrays with equal N. Returns verts (list), faces (list of tuples).
    cap_*: None, 'fan' (to ring centroid), or a 3-tuple tip point."""
    verts = []
    faces = []
    N = len(rings[0])
    for r in rings:
        verts.extend([tuple(p) for p in r])
    M = len(rings)
    for i in range(M - 1):
        a0, b0 = i * N, (i + 1) * N
        for j in range(N if closed else N - 1):
            j1 = (j + 1) % N
            faces.append((a0 + j, a0 + j1, b0 + j1, b0 + j))
    def cap(ring_index, spec, flip):
        if spec is None:
            return
        base = ring_index * N
        if spec == 'fan':
            c = np.mean(rings[ring_index], 0)
        elif spec == 'ngon':
            idx = [base + j for j in range(N)]
            faces.append(tuple(idx if flip else idx[::-1]))
            return
        else:
            c = np.asarray(spec, float)
        ci = len(verts)
        verts.append(tuple(c))
        for j in range(N):
            j1 = (j + 1) % N
            faces.append((base + j, ci, base + j1) if not flip else (base + j1, ci, base + j))
    cap(0, cap_start, False)
    cap(M - 1, cap_end, True)
    return verts, faces


# ----------------------------------------------------------------------------------------------------------------
# object helpers

def coll():
    return bpy.context.scene.collection


def new_mesh_obj(name, verts, faces, mat=None, smooth=True, parent=None, sharp_deg=None, uvs=None, recalc=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate(clean_customdata=False)
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
    me.update()
    ob = bpy.data.objects.new(name, me)
    coll().objects.link(ob)
    if mat is not None:
        me.materials.append(mat)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    if sharp_deg is not None:
        mark_sharp(ob, sharp_deg)
    if parent is not None:
        ob.parent = parent
    return ob


def mark_sharp(ob, deg):
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    thr = math.radians(deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            try:
                ang = e.calc_face_angle()
            except ValueError:
                ang = 0
            e.smooth = ang < thr
        else:
            e.smooth = True
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me)
    bm.free()
    me.update()


def empty(name, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, size=0.2, kind='PLAIN_AXES'):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = kind
    ob.empty_display_size = size
    coll().objects.link(ob)
    ob.location = loc
    ob.rotation_euler = rot
    if parent is not None:
        ob.parent = parent
    return ob


def set_parent_keep(child, parent):
    """Parent while keeping the world transform."""
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)
    child.matrix_world = mw


def apply_transform(ob):
    """Bake the object's local transform into its mesh (location/rotation/scale -> identity)."""
    if ob.type != 'MESH':
        return
    ob.data.transform(ob.matrix_basis)
    ob.matrix_basis = Matrix.Identity(4)


def set_origin(ob, point_world, rot_euler=None):
    """Move the object's origin to point (in the parent's frame, object assumed at identity) and optionally
    give it a rotation, keeping the mesh where it is. Used for pivots."""
    M = Matrix.Translation(Vector(point_world))
    if rot_euler is not None:
        M = M @ Euler(rot_euler).to_matrix().to_4x4()
    ob.data.transform(M.inverted())
    ob.matrix_basis = M


def add_modifier_apply(ob, kind, **props):
    mod = ob.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob


def boolean(ob, cutter, op='DIFFERENCE', solver='EXACT', keep_cutter=True):
    mod = ob.modifiers.new('bool', 'BOOLEAN')
    mod.operation = op
    mod.object = cutter
    mod.solver = solver
    try:
        mod.material_mode = 'INDEX'
    except (AttributeError, TypeError):
        pass
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if not keep_cutter:
        bpy.data.objects.remove(cutter, do_unlink=True)
    return ob


def duplicate(ob, name):
    me = ob.data.copy()
    o2 = bpy.data.objects.new(name, me)
    coll().objects.link(o2)
    o2.matrix_world = ob.matrix_world.copy()
    return o2


def join(objs, name=None):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    if len(objs) == 1:
        if name:
            objs[0].name = name
        return objs[0]
    base = objs[0]
    with bpy.context.temp_override(object=base, active_object=base, selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    if name:
        base.name = name
        base.data.name = name
    return base


def tri_count(ob):
    me = ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh() if ob.modifiers else ob.data
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    return n


# ----------------------------------------------------------------------------------------------------------------
# primitive builders (all return verts, faces lists in local coords)

def prim_cylinder(r1, r2, length, n=16, axis='Z', cap=True, center=(0, 0, 0), r_top=None):
    """Cylinder/cone along axis from 0 to length (then shifted by center)."""
    verts, faces = [], []
    for k, (rr, h) in enumerate(((r1, 0.0), (r2, length))):
        for i in range(n):
            a = 2 * math.pi * i / n
            verts.append((rr * math.cos(a), rr * math.sin(a), h))
    for i in range(n):
        i1 = (i + 1) % n
        faces.append((i, i1, n + i1, n + i))
    if cap:
        faces.append(tuple(range(n - 1, -1, -1)))
        faces.append(tuple(range(n, 2 * n)))
    verts = _orient(verts, axis, center)
    return verts, faces


def prim_tube(path, radius, n=10, cap=True):
    """Sweep a circle along a polyline path (list of 3D points). radius may be a scalar or a list."""
    path = [np.asarray(p, float) for p in path]
    rs = radius if isinstance(radius, (list, tuple, np.ndarray)) else [radius] * len(path)
    verts, faces = [], []
    prev_n = None
    for k, p in enumerate(path):
        if k == 0:
            t = path[1] - path[0]
        elif k == len(path) - 1:
            t = path[-1] - path[-2]
        else:
            t = (path[k + 1] - path[k - 1])
        t = t / (np.linalg.norm(t) + 1e-12)
        if prev_n is None:
            ref = np.array([0, 0, 1.0]) if abs(t[2]) < 0.9 else np.array([1.0, 0, 0])
            nrm = np.cross(t, ref)
        else:
            nrm = prev_n - t * np.dot(prev_n, t)
        nrm = nrm / (np.linalg.norm(nrm) + 1e-12)
        prev_n = nrm
        b = np.cross(t, nrm)
        for i in range(n):
            a = 2 * math.pi * i / n
            verts.append(tuple(p + rs[k] * (math.cos(a) * nrm + math.sin(a) * b)))
    M = len(path)
    for k in range(M - 1):
        for i in range(n):
            i1 = (i + 1) % n
            faces.append((k * n + i, k * n + i1, (k + 1) * n + i1, (k + 1) * n + i))
    if cap:
        faces.append(tuple(range(n - 1, -1, -1)))
        faces.append(tuple(range((M - 1) * n, M * n)))
    return verts, faces


def prim_box(size, center=(0, 0, 0), bevel=0.0):
    sx, sy, sz = [s / 2 for s in size]
    cx, cy, cz = center
    v = [(cx + x * sx, cy + y * sy, cz + z * sz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return v, f


def prim_torus(R, r, n=24, m=10, axis='Z', center=(0, 0, 0)):
    verts, faces = [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        for j in range(m):
            b = 2 * math.pi * j / m
            rr = R + r * math.cos(b)
            verts.append((rr * math.cos(a), rr * math.sin(a), r * math.sin(b)))
    for i in range(n):
        for j in range(m):
            i1, j1 = (i + 1) % n, (j + 1) % m
            faces.append((i * m + j, i1 * m + j, i1 * m + j1, i * m + j1))
    return _orient(verts, axis, center), faces


def prim_sphere(r, n=16, m=10, center=(0, 0, 0), scale=(1, 1, 1)):
    verts, faces = [], []
    verts.append((0, 0, -r))
    for j in range(1, m):
        b = -math.pi / 2 + math.pi * j / m
        for i in range(n):
            a = 2 * math.pi * i / n
            verts.append((r * math.cos(b) * math.cos(a), r * math.cos(b) * math.sin(a), r * math.sin(b)))
    verts.append((0, 0, r))
    top = len(verts) - 1
    for i in range(n):
        i1 = (i + 1) % n
        faces.append((0, 1 + i1, 1 + i))
    for j in range(m - 2):
        for i in range(n):
            i1 = (i + 1) % n
            a0 = 1 + j * n
            b0 = 1 + (j + 1) * n
            faces.append((a0 + i, a0 + i1, b0 + i1, b0 + i))
    last = 1 + (m - 2) * n
    for i in range(n):
        i1 = (i + 1) % n
        faces.append((last + i, last + i1, top))
    verts = [(v[0] * scale[0] + center[0], v[1] * scale[1] + center[1], v[2] * scale[2] + center[2]) for v in verts]
    return verts, faces


def _orient(verts, axis, center):
    out = []
    for x, y, z in verts:
        # proper rotations only (det = +1) so face winding / normals stay outward
        if axis == 'Z':
            p = (x, y, z)
        elif axis == 'Y':
            p = (x, z, -y)
        elif axis == 'X':
            p = (z, x, y)
        elif axis == '-X':
            p = (-z, -x, y)
        elif axis == '-Y':
            p = (x, -z, y)
        elif axis == '-Z':
            p = (x, -y, -z)
        else:
            raise ValueError(axis)
        out.append((p[0] + center[0], p[1] + center[1], p[2] + center[2]))
    return out


def transform_verts(verts, M):
    M = Matrix(M) if not isinstance(M, Matrix) else M
    return [tuple(M @ Vector(v)) for v in verts]


def merge_parts(parts):
    """parts: list of (verts, faces). Returns combined verts, faces."""
    V, F = [], []
    for v, f in parts:
        o = len(V)
        V.extend(v)
        F.extend([tuple(i + o for i in face) for face in f])
    return V, F


def airfoil(n=24, t=0.12, camber=0.0):
    """NACA 4-digit-ish closed airfoil, chord 0..1 along +x (LE at 0), returns list of (x, z) going
    TE -> upper -> LE -> lower -> TE (without duplicate TE)."""
    beta = np.linspace(0, math.pi, n + 1)
    xc = (1 - np.cos(beta)) / 2
    yt = 5 * t * (0.2969 * np.sqrt(xc) - 0.1260 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)
    yc = camber * 4 * xc * (1 - xc)
    upper = list(zip(xc[::-1], (yc + yt)[::-1]))
    lower = list(zip(xc[1:-1], (yc - yt)[1:-1]))
    return upper + lower


def prim_rbox(size, center=(0, 0, 0), r=0.02, n=6, axes=None):
    """Rounded box (superellipsoid-ish): size (sx, sy, sz), corner radius r. axes: optional (right, up, normal)
    Vectors to orient the local x/y/z axes. Returns verts, faces (closed, outward)."""
    sx, sy, sz = [s / 2 for s in size]
    r = min(r, sx * 0.95, sy * 0.95, sz * 0.95)
    verts, faces = [], []
    # build a rounded rectangle ring in XY, lofted along Z with rounded ends
    def ring(ix, iy, rr):
        pts = []
        for cx, cy, a0 in ((ix, iy, 0), (-ix, iy, 90), (-ix, -iy, 180), (ix, -iy, 270)):
            for k in range(n + 1):
                a = math.radians(a0 + 90 * k / n)
                pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
        return pts
    zs = []
    for k in range(n + 1):
        a = math.radians(-90 + 90 * k / n)
        zs.append((-sz + r - r * math.cos(math.radians(90 * k / n)) * 0 + r * (math.sin(a) + 1) - r, r * math.cos(a)))
    # bottom cap -> top cap profile: (z, inset radius)
    prof = []
    for k in range(n + 1):
        a = -math.pi / 2 + (math.pi / 2) * k / n
        prof.append((-sz + r + r * math.sin(a), r * math.cos(a)))
    for k in range(n + 1):
        a = (math.pi / 2) * k / n
        prof.append((sz - r + r * math.sin(a), r * math.cos(a)))
    rings = []
    for z, rr in prof:
        pts = ring(sx - r, sy - r, max(rr, 1e-5))
        rings.append([(x, y, z) for x, y in pts])
    m = len(rings[0])
    for rg in rings:
        verts.extend(rg)
    for i in range(len(rings) - 1):
        for j in range(m):
            j1 = (j + 1) % m
            faces.append((i * m + j, i * m + j1, (i + 1) * m + j1, (i + 1) * m + j))
    faces.append(tuple(range(m - 1, -1, -1)))
    last = (len(rings) - 1) * m
    faces.append(tuple(range(last, last + m)))
    c = Vector(center)
    if axes is not None:
        R, U, N = [Vector(a) for a in axes]
        verts = [tuple(c + R * x + U * y + N * z) for x, y, z in verts]
    else:
        verts = [(x + c.x, y + c.y, z + c.z) for x, y, z in verts]
    return verts, faces
