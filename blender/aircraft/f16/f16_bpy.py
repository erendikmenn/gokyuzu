"""bpy helpers for the F-16 build: mesh objects from MeshData, materials, booleans, pivots."""
import math
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector


def link(obj, coll=None):
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj


def mesh_object(md, name=None, mat=None, smooth=True, auto_angle=None, coll=None, uv_name='UVMap', recalc=False, cull=None):
    name = name or md.name
    me = bpy.data.meshes.new(name)
    V = np.asarray(md.verts, float)
    me.from_pydata(V.tolist(), [], [tuple(int(i) for i in f) for f in md.faces])
    me.validate(clean_customdata=False)
    if md.uvs is not None and len(me.polygons) == len(md.uvs):
        uv = me.uv_layers.new(name=uv_name)
        flat = []
        for poly, cuv in zip(me.polygons, md.uvs):
            for k in range(poly.loop_total):
                flat.extend(cuv[k] if k < len(cuv) else (0.0, 0.0))
        uv.data.foreach_set('uv', flat)
    if recalc:
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
    if smooth:
        me.shade_smooth()
        if auto_angle is not None:
            me.set_sharp_from_angle(angle=math.radians(auto_angle))
    if md.sharp_edges:
        attr = me.attributes.get('sharp_edge') or me.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
        lookup = {}
        for e in me.edges:
            a, b = e.vertices
            lookup[(min(a, b), max(a, b))] = e.index
        vals = [False] * len(me.edges)
        attr.data.foreach_get('value', vals)
        for a, b in md.sharp_edges:
            k = lookup.get((min(a, b), max(a, b)))
            if k is not None:
                vals[k] = True
        attr.data.foreach_set('value', vals)
    if md.mat_index is not None and len(md.mat_index) == len(me.polygons):
        me.polygons.foreach_set('material_index', [int(i) for i in md.mat_index])
    obj = bpy.data.objects.new(name, me)
    if mat is not None:
        if isinstance(mat, (list, tuple)):
            for m in mat:
                me.materials.append(m)
        else:
            me.materials.append(mat)
    link(obj, coll)
    return obj


def empty(name, loc=(0, 0, 0), parent=None, size=0.1, kind='PLAIN_AXES', coll=None, rot=None):
    o = bpy.data.objects.new(name, None)
    o.empty_display_type = kind
    o.empty_display_size = size
    link(o, coll)
    if parent is not None:
        o.parent = parent
    o.location = loc
    if rot is not None:
        o.rotation_mode = 'QUATERNION'
        o.rotation_quaternion = rot
    return o


def apply_modifiers(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return obj


def boolean(obj, cutter, op='DIFFERENCE', solver='EXACT', apply=True, keep_cutter=False):
    m = obj.modifiers.new('bool', 'BOOLEAN')
    m.operation = op
    m.object = cutter
    try:
        m.solver = solver
    except TypeError:
        m.solver = 'EXACT'
    if solver == 'EXACT':
        try:
            m.use_hole_tolerant = False
            m.use_self = False
        except AttributeError:
            pass
    cutter.hide_render = True
    cutter.hide_viewport = True
    if apply:
        apply_modifiers(obj)
    if not keep_cutter:
        me = cutter.data
        bpy.data.objects.remove(cutter)
        if me.users == 0:
            bpy.data.meshes.remove(me)
    return obj


def copy_object(obj, name, coll=None):
    o = obj.copy()
    o.data = obj.data.copy()
    o.name = name
    o.data.name = name
    link(o, coll)
    return o


def set_origin_basis(obj, origin, x_axis, z_hint=(0, 0, 1)):
    """Move the object's origin to `origin` with local X along x_axis (Z close to z_hint); mesh stays in place."""
    x = Vector(x_axis).normalized()
    zh = Vector(z_hint).normalized()
    if abs(x.dot(zh)) > 0.95:
        zh = Vector((0, 1, 0)) if abs(x.y) < 0.9 else Vector((0, 0, 1))
    y = zh.cross(x).normalized()
    z = x.cross(y).normalized()
    R = Matrix((x, y, z)).transposed()      # columns = local axes
    M = Matrix.Translation(Vector(origin)) @ R.to_4x4()
    Minv = M.inverted()
    obj.data.transform(Minv @ obj.matrix_world)
    obj.matrix_world = M
    return obj


def parent_keep(child, parent):
    bpy.context.view_layer.update()
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = mw


def box_mesh(name, center, size, coll=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + Vector(center)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    link(o, coll)
    return o


def prism_mesh(name, poly2d, axis, a0, a1, coll=None):
    """Extrude a closed 2-D polygon (list of (p,q)) along an axis ('x','y','z') from a0 to a1.
    For axis 'z': poly is (x,y); 'y': (x,z); 'x': (y,z)."""
    n = len(poly2d)
    verts = []
    for a in (a0, a1):
        for p, q in poly2d:
            if axis == 'z':
                verts.append((p, q, a))
            elif axis == 'y':
                verts.append((p, a, q))
            else:
                verts.append((a, p, q))
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    link(o, coll)
    return o


def recalc_normals(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()


def tri_count(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    ev.to_mesh_clear()
    return n


def principled(name, color=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, emission=None, emission_strength=1.0, alpha=None,
               transmission=None, ior=None, coat=None, specular=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color[:3], 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emission is not None:
        b.inputs['Emission Color'].default_value = (*emission[:3], 1)
        b.inputs['Emission Strength'].default_value = emission_strength
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except AttributeError:
            pass
    if transmission is not None:
        b.inputs['Transmission Weight'].default_value = transmission
    if ior is not None:
        b.inputs['IOR'].default_value = ior
    if coat is not None:
        b.inputs['Coat Weight'].default_value = coat
    if specular is not None:
        b.inputs['Specular IOR Level'].default_value = specular
    return m


def image_material(name, color_img=None, normal_img=None, orm_img=None, rough=0.5, metal=0.0, normal_strength=1.0,
                   color=(1, 1, 1), uv='UVMap', emission_img=None, emission_strength=1.0, alpha_from_color=False):
    """Principled material with glTF-friendly image wiring (ORM: R=AO, G=roughness, B=metallic)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N = nt.nodes
    Lk = nt.links
    b = N.get('Principled BSDF')
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    b.inputs['Base Color'].default_value = (*color, 1)
    y = 300
    if color_img is not None:
        t = N.new('ShaderNodeTexImage'); t.image = color_img; t.location = (-600, y)
        Lk.new(t.outputs['Color'], b.inputs['Base Color'])
        if alpha_from_color:
            Lk.new(t.outputs['Alpha'], b.inputs['Alpha'])
        y -= 300
    if orm_img is not None:
        t = N.new('ShaderNodeTexImage'); t.image = orm_img; t.location = (-900, y)
        t.image.colorspace_settings.name = 'Non-Color'
        sep = N.new('ShaderNodeSeparateColor'); sep.location = (-600, y)
        Lk.new(t.outputs['Color'], sep.inputs['Color'])
        Lk.new(sep.outputs['Green'], b.inputs['Roughness'])
        Lk.new(sep.outputs['Blue'], b.inputs['Metallic'])
        # occlusion via the glTF settings group
        try:
            g = bpy.data.node_groups.get('glTF Material Output') or _gltf_output_group()
            gn = N.new('ShaderNodeGroup'); gn.node_tree = g; gn.location = (200, -400)
            Lk.new(sep.outputs['Red'], gn.inputs['Occlusion'])
        except Exception:
            pass
        y -= 300
    if normal_img is not None:
        t = N.new('ShaderNodeTexImage'); t.image = normal_img; t.location = (-900, y)
        t.image.colorspace_settings.name = 'Non-Color'
        nm = N.new('ShaderNodeNormalMap'); nm.location = (-600, y)
        nm.inputs['Strength'].default_value = normal_strength
        Lk.new(t.outputs['Color'], nm.inputs['Color'])
        Lk.new(nm.outputs['Normal'], b.inputs['Normal'])
        y -= 300
    if emission_img is not None:
        t = N.new('ShaderNodeTexImage'); t.image = emission_img; t.location = (-900, y)
        Lk.new(t.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = emission_strength
    return m


def _gltf_output_group():
    g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    try:
        g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    except Exception:
        g.inputs.new('NodeSocketFloat', 'Occlusion')
    return g
