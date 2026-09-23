"""Geometry helpers for the A320neo build: numpy lofts -> Blender meshes, pivots, parenting, materials.

Conventions: Blender world, meters. Aircraft nose -> +Y, right wing -> +X, up -> +Z, origin at the CG.
Station s = distance aft of the nose tip; Blender Y = S_CG - s.
"""
import math
import numpy as np
import bpy
from mathutils import Matrix, Vector

S_CG = 16.47          # CG station (25 % MAC) aft of the nose tip
DETAIL = 1.0          # geometric detail (1 = full model, ~0.3 = static LOD)


def NS(n, lo=4):
    """Scale a segment count by DETAIL."""
    return max(lo, int(round(n * DETAIL)))


def Y(s):
    return S_CG - s


# ----------------------------------------------------------------------------------------------- collections

def collection(name, parent=None):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(col)
    return col


def link(obj, col=None):
    (col or bpy.context.scene.collection).objects.link(obj)
    return obj


# ----------------------------------------------------------------------------------------------- mesh building

def mesh_object(name, verts, faces, uvs=None, col=None, smooth=True, sharp_edges=None, mat=None, loop_uvs=None):
    """verts (V,3), faces list of index tuples; loop_uvs: flat (L,2) per-loop uvs matching face order."""
    me = bpy.data.meshes.new(name)
    verts = np.asarray(verts, dtype=np.float64)
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    nl = sum(len(f) for f in faces)
    me.loops.add(nl)
    me.polygons.add(len(faces))
    loop_start = np.zeros(len(faces), dtype=np.int32)
    loop_total = np.array([len(f) for f in faces], dtype=np.int32)
    loop_start[1:] = np.cumsum(loop_total)[:-1]
    me.polygons.foreach_set('loop_start', loop_start)
    idx = np.fromiter((i for f in faces for i in f), dtype=np.int32, count=nl)
    me.loops.foreach_set('vertex_index', idx)
    me.update(calc_edges=True)
    if loop_uvs is not None:
        uvl = me.uv_layers.new(name='UVMap')
        uvl.data.foreach_set('uv', np.asarray(loop_uvs, dtype=np.float32).ravel())
    if smooth:
        me.polygons.foreach_set('use_smooth', np.ones(len(faces), dtype=bool))
    if sharp_edges is not None and len(sharp_edges):
        mark_sharp(me, sharp_edges)
    me.validate(clean_customdata=False)
    me.update()
    obj = bpy.data.objects.new(name, me)
    link(obj, col)
    if mat is not None:
        me.materials.append(mat)
    return obj


def mark_sharp(me, vert_pairs):
    """Mark edges (given as vertex index pairs) sharp."""
    pairs = set((min(a, b), max(a, b)) for a, b in vert_pairs)
    attr = me.attributes.get('sharp_edge') or me.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
    ev = np.zeros(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get('vertices', ev)
    ev = ev.reshape(-1, 2)
    vals = np.array([(min(a, b), max(a, b)) in pairs for a, b in ev], dtype=bool)
    old = np.zeros(len(me.edges), dtype=bool)
    attr.data.foreach_get('value', old)
    attr.data.foreach_set('value', old | vals)


def grid_mesh(name, P, closed=True, uv=None, col=None, mat=None, cap0=False, cap1=False, sharp_cols=(),
              sharp_rows=(), smooth=True, flip=False, uv_u=None, uv_v=None, auto_orient=True):
    """Loft mesh from a grid of points P (N sections, M points per section, 3).

    closed: each section is a closed loop.  uv_u (N,) and uv_v (M+1 if closed else M,) give a separable UV
    layout (u along the loft, v around the section) unless a full uv grid (N, M(+1), 2) is given.
    sharp_cols: section-point indices whose lengthwise edges are sharp (e.g. trailing edges).
    sharp_rows: section indices whose ring edges are sharp.
    """
    P = np.asarray(P, dtype=np.float64)
    N, M, _ = P.shape
    verts = P.reshape(-1, 3)
    faces, luv = [], []
    mcols = M if closed else M - 1
    if uv is None:
        if uv_u is None:
            seg = np.linalg.norm(np.diff(P.mean(axis=1), axis=0), axis=1)
            uv_u = np.r_[0, np.cumsum(seg)]
            uv_u = uv_u / max(uv_u[-1], 1e-9)
        if uv_v is None:
            uv_v = np.linspace(0, 1, M + 1 if closed else M)
        uv = np.zeros((N, len(uv_v), 2))
        uv[:, :, 0] = np.asarray(uv_u)[:, None]
        uv[:, :, 1] = np.asarray(uv_v)[None, :]
    for i in range(N - 1):
        for j in range(mcols):
            j2 = (j + 1) % M
            a, b, c, d = i * M + j, i * M + j2, (i + 1) * M + j2, (i + 1) * M + j
            jj2 = j + 1  # uv column (seam duplicated)
            f = (a, d, c, b)
            fu = (uv[i, j], uv[i + 1, j], uv[i + 1, jj2], uv[i, jj2])
            if flip:
                f = f[::-1]
                fu = fu[::-1]
            faces.append(f)
            luv.extend(fu)
    caps = []
    if cap0 and closed:
        f = tuple(range(M))[::-1] if not flip else tuple(range(M))
        caps.append((f, P[0]))
    if cap1 and closed:
        f = tuple((N - 1) * M + j for j in range(M))
        f = f if not flip else f[::-1]
        caps.append((f, P[-1]))
    for f, ring in caps:
        faces.append(f)
        c = ring.mean(axis=0)
        # planar-ish projected uv for caps (small, rarely seen)
        for k in f:
            p = verts[k] - c
            luv.append((0.5 + 0.02 * p[0], 0.5 + 0.02 * p[2]))
    sharp = []
    for j in sharp_cols:
        for i in range(N - 1):
            sharp.append((i * M + j, (i + 1) * M + j))
    for i in sharp_rows:
        for j in range(mcols):
            sharp.append((i * M + j, i * M + (j + 1) % M))
    if cap0 and closed:
        sharp += [(j, (j + 1) % M) for j in range(M)]
    if cap1 and closed:
        sharp += [((N - 1) * M + j, (N - 1) * M + (j + 1) % M) for j in range(M)]
    obj = mesh_object(name, verts, faces, col=col, smooth=smooth, sharp_edges=sharp, mat=mat, loop_uvs=np.array(luv))
    if auto_orient:
        orient_outward(obj, P)
    return obj


def orient_outward(obj, P):
    """Flip all faces if, on average, normals point toward the local section centroid (tube-like lofts)."""
    me = obj.data
    me.update()
    n = len(me.polygons)
    if n == 0:
        return
    normals = np.zeros(n * 3)
    centers = np.zeros(n * 3)
    me.polygons.foreach_get('normal', normals)
    me.polygons.foreach_get('center', centers)
    normals = normals.reshape(-1, 3)
    centers = centers.reshape(-1, 3)
    cents = P.mean(axis=1)                       # section centroids
    # nearest section centroid for each face (by index along loft is simpler: use nearest point)
    from numpy.linalg import norm
    d = norm(centers[:, None, :] - cents[None, :, :], axis=2)
    k = d.argmin(axis=1)
    score = np.einsum('ij,ij->i', normals, centers - cents[k])
    if score.sum() < 0:
        flip_normals(obj)


def flip_normals(obj):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for f in bm.faces:
        f.normal_flip()
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def set_origin(obj, origin, rot=None):
    """Move the object's origin to `origin` (world) and orient its local frame by rotation matrix `rot`
    (3x3, columns = local axes in world), keeping the geometry in place."""
    origin = Vector(origin)
    R = Matrix.Identity(3) if rot is None else Matrix(rot)
    M = R.to_4x4()
    M.translation = origin
    Minv = M.inverted()
    world = obj.matrix_world.copy()
    obj.data.transform(Minv @ world)
    obj.matrix_world = M
    return obj


def hinge_frame(p0, p1, up_hint=(0, 0, 1)):
    """Rotation matrix with local X along p0->p1 (hinge axis), local Z as close as possible to up_hint."""
    x = Vector(p1) - Vector(p0)
    x.normalize()
    up = Vector(up_hint)
    y = up.cross(x)
    if y.length < 1e-6:
        y = Vector((0, 1, 0)).cross(x)
    y.normalize()
    z = x.cross(y)
    z.normalize()
    return Matrix((x, y, z)).transposed()


def parent_keep(child, parent):
    w = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)
    child.matrix_basis = parent.matrix_world.inverted() @ w


def empty(name, loc, col=None, parent=None, size=0.2, rot=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = size
    e.empty_display_type = 'PLAIN_AXES'
    link(e, col)
    M = (Matrix.Identity(3) if rot is None else Matrix(rot)).to_4x4()
    M.translation = Vector(loc)
    e.matrix_world = M
    if parent is not None:
        parent_keep(e, parent)
    return e


def join(objs, name):
    """Join mesh objects into one (all must share transforms applied = identity)."""
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    if len(objs) == 1:
        objs[0].name = name
        objs[0].data.name = name
        return objs[0]
    ctx = bpy.context
    for o in ctx.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    ctx.view_layer.objects.active = objs[0]
    with ctx.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    o = objs[0]
    o.name = name
    o.data.name = name
    return o


def apply_transform(obj):
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)


def tri_count(obj):
    if obj.type != 'MESH':
        return 0
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ----------------------------------------------------------------------------------------------- primitives

def revolve(name, profile, n=48, axis_origin=(0, 0, 0), axis='Y', col=None, mat=None, cap0=False, cap1=False,
            theta0=0.0, theta1=2 * math.pi, uv_v=None, sharp_rows=(), scale_xz=(1.0, 1.0), smooth=True):
    """Surface of revolution. profile: list of (t, r) with t along the axis (+axis), r radius.
    Returns object in world coordinates. Axis 'Y' (engine-like), 'X' (wheels) or 'Z'."""
    prof = np.asarray(profile, dtype=np.float64)
    full = abs((theta1 - theta0) - 2 * math.pi) < 1e-6
    th = np.linspace(theta0, theta1, n, endpoint=not full)
    N = len(prof)
    P = np.zeros((N, len(th), 3))
    ox, oy, oz = axis_origin
    sx, sz = scale_xz
    for i, (t, r) in enumerate(prof):
        c, s = np.cos(th) * r, np.sin(th) * r
        if axis == 'Y':
            P[i, :, 0] = ox + c * sx
            P[i, :, 1] = oy + t
            P[i, :, 2] = oz + s * sz
        elif axis == 'X':
            P[i, :, 0] = ox + t
            P[i, :, 1] = oy + c * sx
            P[i, :, 2] = oz + s * sz
        else:
            P[i, :, 0] = ox + c * sx
            P[i, :, 1] = oy + s * sz
            P[i, :, 2] = oz + t
    lens = np.r_[0, np.cumsum(np.hypot(np.diff(prof[:, 0]), np.diff(prof[:, 1])))]
    uv_u = lens / max(lens[-1], 1e-9)
    obj = grid_mesh(name, P, closed=full, col=col, mat=mat, cap0=cap0, cap1=cap1, uv_u=uv_u, uv_v=uv_v,
                    sharp_rows=sharp_rows, smooth=smooth, auto_orient=False)
    # orientation: make normals point away from the axis on average (for outer skins); caller may flip
    return obj


def box(name, center, size, col=None, mat=None, rot=None, bevel=0.0):
    cx, cy, cz = center
    sx, sy, sz = (s / 2 for s in size)
    v = np.array([[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
                 dtype=float) * [sx, sy, sz]
    if rot is not None:
        v = v @ np.asarray(rot).T
    v += [cx, cy, cz]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    luv = []
    for face in f:
        luv += [(0, 0), (1, 0), (1, 1), (0, 1)]
    o = mesh_object(name, v, f, col=col, mat=mat, smooth=False, loop_uvs=np.array(luv))
    if bevel > 0:
        bev = o.modifiers.new('bev', 'BEVEL')
        bev.width = bevel
        bev.segments = 2
        bev.limit_method = 'NONE'
        apply_modifiers(o)
    return o


def cylinder(name, p0, p1, r0, r1=None, n=16, col=None, mat=None, caps=True, smooth=True):
    """Tapered cylinder between world points p0 and p1."""
    r1 = r0 if r1 is None else r1
    p0 = np.asarray(p0, float)
    p1 = np.asarray(p1, float)
    ax = p1 - p0
    L = np.linalg.norm(ax)
    ax /= L
    tmp = np.array([0, 0, 1.0]) if abs(ax[2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(ax, tmp)
    u /= np.linalg.norm(u)
    v = np.cross(ax, u)
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ring = np.cos(th)[:, None] * u + np.sin(th)[:, None] * v
    P = np.stack([p0 + ring * r0, p1 + ring * r1])
    o = grid_mesh(name, P, closed=True, col=col, mat=mat, cap0=caps, cap1=caps, smooth=smooth, auto_orient=True)
    return o


def apply_modifiers(obj):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    name = old.name
    bpy.data.meshes.remove(old)
    me.name = name


def boolean(obj, cutter, op='DIFFERENCE', solver='EXACT', holes=True):
    """Boolean with `cutter`. With holes=True (open surfaces such as skins): faces that the solver takes over from
    the cutter (pocket walls / caps) are deleted afterwards, leaving clean openings."""
    tmp = None
    if holes:
        tmp = bpy.data.materials.get('__cutter__') or bpy.data.materials.new('__cutter__')
        cutter.data.materials.clear()
        cutter.data.materials.append(tmp)
        if tmp.name not in [m.name for m in obj.data.materials if m]:
            obj.data.materials.append(tmp)
    m = obj.modifiers.new('bool', 'BOOLEAN')
    m.operation = op
    m.object = cutter
    m.solver = solver
    if hasattr(m, 'material_mode'):
        m.material_mode = 'TRANSFER'
    apply_modifiers(obj)
    if holes:
        import bmesh
        me = obj.data
        idx = [i for i, mm in enumerate(me.materials) if mm and mm.name == '__cutter__']
        if idx:
            bm = bmesh.new()
            bm.from_mesh(me)
            dead = [f for f in bm.faces if f.material_index in idx]
            bmesh.ops.delete(bm, geom=dead, context='FACES')
            bm.to_mesh(me)
            bm.free()
            me.materials.pop(index=idx[0])
        me.update()


def transform_verts(obj, M):
    obj.data.transform(Matrix(M))
    obj.data.update()


def mirror_x(obj, name):
    """Duplicate an object mirrored across the X=0 plane (world). Applies transforms."""
    me = obj.data.copy()
    o = bpy.data.objects.new(name, me)
    for c in obj.users_collection:
        c.objects.link(o)
    o.matrix_world = obj.matrix_world.copy()
    apply_transform(o)
    S = Matrix.Scale(-1, 4, (1, 0, 0))
    me.transform(S)
    me.flip_normals()
    me.update()
    return o


# ----------------------------------------------------------------------------------------------- materials

def principled(name, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5, emission=None, emission_strength=0.0,
               alpha=1.0, tex=None, rough_tex=None, normal_tex=None, normal_strength=1.0, emission_tex=None,
               double_sided=False, coat=0.0):
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color[:3], 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if coat and 'Coat Weight' in bsdf.inputs:
        bsdf.inputs['Coat Weight'].default_value = coat
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*emission[:3], 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
        try:
            m.blend_method = 'BLEND'
        except Exception:
            pass
    m.use_backface_culling = not double_sided
    x = -700
    if tex is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = tex if isinstance(tex, bpy.types.Image) else bpy.data.images.load(tex, check_existing=True)
        t.location = (x, 300)
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if rough_tex is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = rough_tex if isinstance(rough_tex, bpy.types.Image) else bpy.data.images.load(rough_tex, check_existing=True)
        t.image.colorspace_settings.name = 'Non-Color'
        t.location = (x, 0)
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        sep.location = (x + 300, 0)
        nt.links.new(t.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    if normal_tex is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal_tex if isinstance(normal_tex, bpy.types.Image) else bpy.data.images.load(normal_tex, check_existing=True)
        t.image.colorspace_settings.name = 'Non-Color'
        t.location = (x, -300)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = normal_strength
        nm.location = (x + 300, -300)
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if emission_tex is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = emission_tex if isinstance(emission_tex, bpy.types.Image) else bpy.data.images.load(emission_tex, check_existing=True)
        t.location = (x, -600)
        nt.links.new(t.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = max(emission_strength, 1.0)
    return m


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


# ----------------------------------------------------------------------------------------------- math

def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def resample_polyline(pts, n):
    pts = np.asarray(pts, float)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    d = np.r_[0, np.cumsum(seg)]
    t = np.linspace(0, d[-1], n)
    return np.stack([np.interp(t, d, pts[:, k]) for k in range(pts.shape[1])], axis=1)


def superellipsoid(name, center, size, n=(4.0, 4.0), seg=(16, 10), rot=None, col=None, mat=None, taper=None,
                   bend=None):
    """Rounded box: |x/a|^n1 + |y/b|^n1 + |z/c|^n2 = 1 (n1 horizontal, n2 vertical roundness).
    size = full extents (sx, sy, sz); taper(z01) -> xy scale; bend(z01) -> y offset (curved backrests)."""
    a, b, c = (s / 2 for s in size)
    n1, n2 = n
    nu, nv = seg
    rings = []
    for i in range(nv + 1):
        v = -math.pi / 2 + math.pi * i / nv
        cv, sv = math.cos(v), math.sin(v)
        ez = np.sign(sv) * abs(sv) ** (2 / n2)
        er = abs(cv) ** (2 / n2)
        z01 = (ez + 1) / 2
        k = taper(z01) if taper else 1.0
        dy = bend(z01) if bend else 0.0
        ring = []
        for j in range(nu):
            u = 2 * math.pi * j / nu
            cu, su = math.cos(u), math.sin(u)
            ex = np.sign(cu) * abs(cu) ** (2 / n1)
            ey = np.sign(su) * abs(su) ** (2 / n1)
            ring.append((a * er * ex * k, b * er * ey * k + dy, c * ez))
        rings.append(ring)
    P = np.array(rings)
    if rot is not None:
        P = P @ np.asarray(rot).T
    P = P + np.asarray(center)
    # poles: collapse first/last ring (keep as tiny rings; caps close them)
    o = grid_mesh(name, P, closed=True, col=col, mat=mat, cap0=True, cap1=True, auto_orient=False)
    # orient outward from the centre
    me = o.data
    me.update()
    nrm = np.zeros(len(me.polygons) * 3)
    cen = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('normal', nrm)
    me.polygons.foreach_get('center', cen)
    if np.einsum('ij,ij->i', nrm.reshape(-1, 3), cen.reshape(-1, 3) - np.asarray(center)).sum() < 0:
        flip_normals(o)
    # caps are flat & tiny: smooth everything
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), dtype=bool))
    if 'sharp_edge' in me.attributes:
        me.attributes.remove(me.attributes['sharp_edge'])
    return o
