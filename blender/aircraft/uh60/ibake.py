"""Interior texture atlases with baked soft lighting (CONTRACTS-SF.md §6.2.1: "bake ambient occlusion / soft interior
lighting into the cockpit's color textures").

For every atlas group (objects tagged with the custom property 'atlas' = group name):
  1. join the group's meshes into one object (one draw call), add a fresh 'atlas' UV layer and pack all faces into it
  2. bake, through an emission trick on the original materials: albedo, roughness, metallic
  3. bake the light arriving at every texel (diffuse direct + indirect, no colour) with every surface in the scene turned
     into grey clay, the glass hidden and an overcast sky dome as the only light -> soft window light + contact shadows
  4. ibake_compose.py (venv python) blurs/dilates and writes <group>_base.jpg (= albedo x light) and <group>_orm.jpg
  5. the object gets a single glTF material 'int_atlas_<group>' using those textures; old UV layers/materials are dropped
"""
import os
import math
import subprocess
import bpy
import bmesh
import numpy as np


def log(*a):
    print('[uh60 ibake]', *a, flush=True)


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def fix_source_uvs(mats, layer='UVMap'):
    """Texture lookups of the source materials must keep reading their own UV layer once 'atlas' becomes active."""
    for m in mats:
        if not m or not m.node_tree:
            continue
        nt = m.node_tree
        for n in list(nt.nodes):
            if n.type == 'UVMAP':
                n.uv_map = layer
            elif n.type == 'TEX_IMAGE' and not n.inputs['Vector'].is_linked:
                uv = nt.nodes.new('ShaderNodeUVMap')
                uv.uv_map = layer
                nt.links.new(uv.outputs['UV'], n.inputs['Vector'])


def join_group(objs, name, parent):
    objs = [o for o in objs if o.type == 'MESH']
    for o in objs:          # apply parent-relative transforms: everything is authored in the G frame under 'interior'
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    base = objs[0]
    if len(objs) > 1:
        with bpy.context.temp_override(object=base, active_object=base, selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
    base.name = name
    base.data.name = name
    mw = base.matrix_world.copy()
    base.data.transform(parent.matrix_world.inverted() @ mw)
    base.parent = parent
    base.matrix_parent_inverse.identity()
    base.matrix_basis.identity()
    return base


def mark_material_seams(ob):
    """Seams between faces of different materials so no UV island mixes a textured label plate with plain paint."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for e in bm.edges:
        fs = e.link_faces
        if len(fs) == 2 and fs[0].material_index != fs[1].material_index:
            e.seam = True
    bm.to_mesh(me)
    bm.free()


def scale_islands_by_material(ob):
    """Before packing: scale the 'atlas' UVs of faces whose material has a 'texel' boost (islands never mix materials)."""
    me = ob.data
    boost = [float(s.material.get('texel', 1.0)) if s.material else 1.0 for s in ob.material_slots]
    if all(b == 1.0 for b in boost):
        return
    bm = bmesh.new()
    bm.from_mesh(me)
    uvl = bm.loops.layers.uv['atlas']
    for f in bm.faces:
        k = boost[f.material_index] if f.material_index < len(boost) else 1.0
        if k == 1.0:
            continue
        for l in f.loops:
            l[uvl].uv = l[uvl].uv * k
    bm.to_mesh(me)
    bm.free()


def unwrap_group(ob, margin=0.0015, angle=60.0):
    me = ob.data
    if 'atlas' not in me.uv_layers:
        me.uv_layers.new(name='atlas')
    me.uv_layers.active = me.uv_layers['atlas']
    mark_material_seams(ob)
    select_only([ob])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    try:
        bpy.ops.uv.average_islands_scale()
    except Exception:
        pass
    bpy.ops.object.mode_set(mode='OBJECT')
    scale_islands_by_material(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method=os.environ.get('IB_PACK', 'CONCAVE'), scale=True)
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')
    for l in me.uv_layers:
        l.active_render = (l.name == 'atlas')


# ------------------------------------------------------------------------------------------------ emission-trick bakes
def _src(nt, b, name):
    """Return (socket or None, default) feeding input 'name' of Principled node b."""
    inp = b.inputs[name]
    if inp.is_linked:
        return inp.links[0].from_socket, None
    return None, inp.default_value


def _route(mat, target_img, channel):
    """Route a Principled input (Base Color / Roughness / Metallic) into an emission shader + active bake image node."""
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    old = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].is_linked else None
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    if b is None or channel == 'mask':
        em.inputs['Color'].default_value = (1, 1, 1, 1) if channel == 'mask' else (0.5, 0.5, 0.5, 1)
    else:
        sock, dv = _src(nt, b, channel)
        if sock is not None:
            nt.links.new(sock, em.inputs['Color'])
        elif channel == 'Base Color':
            em.inputs['Color'].default_value = tuple(dv)
        else:
            em.inputs['Color'].default_value = (dv, dv, dv, 1)
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = target_img
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'atlas'
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    for n in nt.nodes:
        n.select = False
    tex.select = True
    nt.nodes.active = tex
    return (em, tex, uv, old, out)


def _route_clay(mat, target_img, grey):
    """Grey diffuse surface + active bake image node (light bake)."""
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    old = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].is_linked else None
    em = nt.nodes.new('ShaderNodeBsdfDiffuse')
    em.inputs['Color'].default_value = (grey, grey, grey, 1)
    nt.links.new(em.outputs['BSDF'], out.inputs['Surface'])
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = target_img
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'atlas'
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    for n in nt.nodes:
        n.select = False
    tex.select = True
    nt.nodes.active = tex
    return (em, tex, uv, old, out)


def _unroute(mat, st):
    em, tex, uv, old, out = st
    nt = mat.node_tree
    for n in (em, tex, uv):
        nt.nodes.remove(n)
    if old is not None:
        nt.links.new(old, out.inputs['Surface'])


def _new_img(name, size):
    img = bpy.data.images.new(name, size, size, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.generated_color = (0, 0, 0, 0)
    return img


def _save_npy(img, path, size):
    a = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(a)
    np.save(path, a.reshape(size, size, 4))


def bake_group(ob, size, cache, light_samples=256, light_size=None, hide=(), clay_grey=0.35, sky=(0.78, 0.82, 0.88)):
    """Bake albedo / roughness / metal / light of one joined atlas object into cache/<name>_*.npy."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    sc.cycles.device = 'GPU'
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.use_clear = True
    select_only([ob])
    mats = [s.material for s in ob.material_slots if s.material]
    name = ob.name
    os.makedirs(cache, exist_ok=True)
    # --- material channels via emission
    for ch, key in (('mask', 'mask'), ('Base Color', 'alb'), ('Roughness', 'rough'), ('Metallic', 'metal')):
        img = _new_img(f'_ib_{name}_{key}', size)
        st = [(m, _route(m, img, ch)) for m in mats]
        sc.cycles.samples = 4 if key == 'alb' else 1
        bpy.ops.object.bake(type='EMIT', margin=0 if key == 'mask' else 8, use_clear=True)
        for m, s in st:
            _unroute(m, s)
        _save_npy(img, os.path.join(cache, f'{name}_{key}.npy'), size)
        bpy.data.images.remove(img)
        log('baked', name, key)
    # --- light: the group's own materials become grey clay (others keep theirs for the bounce light), glass hidden,
    # overcast sky dome as the only light
    ls = light_size or size
    img = _new_img(f'_ib_{name}_light', ls)
    world_old = sc.world
    w = bpy.data.worlds.get('_ib_sky') or bpy.data.worlds.new('_ib_sky')
    w.use_nodes = True
    wnt = w.node_tree
    for n in list(wnt.nodes):
        if n.type not in ('BACKGROUND', 'OUTPUT_WORLD'):
            wnt.nodes.remove(n)
    wb = next(n for n in wnt.nodes if n.type == 'BACKGROUND')
    wo = next(n for n in wnt.nodes if n.type == 'OUTPUT_WORLD')
    if not wb.outputs['Background'].is_linked:
        wnt.links.new(wb.outputs['Background'], wo.inputs['Surface'])
    # brighter overhead than at the horizon (direction z via the world's Generated coordinates)
    tc = wnt.nodes.new('ShaderNodeTexCoord')
    sep = wnt.nodes.new('ShaderNodeSeparateXYZ')
    wnt.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
    mr = wnt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = -0.3
    mr.inputs['From Max'].default_value = 1.0
    mr.inputs['To Min'].default_value = 0.35
    mr.inputs['To Max'].default_value = 1.25
    wnt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    wb.inputs['Color'].default_value = (*sky, 1)
    wnt.links.new(mr.outputs['Result'], wb.inputs['Strength'])
    sc.world = w
    hidden = []
    for o in hide:
        if not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    st = [(m, _route_clay(m, img, clay_grey)) for m in mats]
    sc.cycles.samples = light_samples
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.render.bake.use_pass_direct = True
    sc.render.bake.use_pass_indirect = True
    sc.render.bake.use_pass_color = False
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=8, use_clear=True)
    for m, s_ in st:
        _unroute(m, s_)
    for o in hidden:
        o.hide_render = False
    sc.world = world_old
    _save_npy(img, os.path.join(cache, f'{name}_light.npy'), ls)
    bpy.data.images.remove(img)
    log('baked', name, 'light')


def finalize(ob, texdir, M_principled, rough_default=0.6):
    """Replace the object's materials with one atlas material; keep only the 'atlas' UV layer (renamed UVMap)."""
    import mats as _m
    name = ob.name
    mat = bpy.data.materials.get(f'int_atlas_{name}') or bpy.data.materials.new(f'int_atlas_{name}')
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL'):
            nt.nodes.remove(n)
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Roughness'].default_value = rough_default
    _m.textured_material(mat, os.path.join(texdir, f'{name}_base.jpg'), os.path.join(texdir, f'{name}_orm.jpg'), use_ao=False)
    for n in nt.nodes:
        if n.type == 'UVMAP':
            n.uv_map = 'atlas'
    me = ob.data
    me.materials.clear()
    me.materials.append(mat)
    for p in me.polygons:
        p.material_index = 0
    for l in list(me.uv_layers):
        if l.name != 'atlas':
            me.uv_layers.remove(l)
    me.uv_layers['atlas'].name = 'UVMap'
    for n in nt.nodes:
        if n.type == 'UVMAP':
            n.uv_map = 'UVMap'
    return mat


def run(groups, cache, texdir, venv_py, compose_script, sizes, hide=(), light_samples=256):
    """groups: dict name -> list of objects (already parented under 'interior'). Returns list of atlas objects."""
    out = []
    mats = set()
    for objs in groups.values():
        for o in objs:
            for s in o.material_slots:
                if s.material:
                    mats.add(s.material)
    fix_source_uvs(mats)
    parent = next(iter(groups.values()))[0].parent
    joined = {}
    for name, objs in groups.items():
        ob = join_group(objs, name, parent)
        unwrap_group(ob)
        joined[name] = ob
        log('unwrapped', name, len(ob.data.polygons), 'faces')
    for name, ob in joined.items():
        size = sizes.get(name, 2048)
        bake_group(ob, size, cache, light_samples=light_samples, light_size=min(size, 2048), hide=hide)
    args = [venv_py, compose_script, cache, texdir] + [f'{n}:{sizes.get(n, 2048)}' for n in joined]
    r = subprocess.run(args, capture_output=True, text=True)
    print(r.stdout[-3000:], r.stderr[-3000:], flush=True)
    if r.returncode != 0:
        raise RuntimeError('ibake_compose failed')
    for name, ob in joined.items():
        finalize(ob, texdir, None)
        out.append(ob)
    return out


# ------------------------------------------------------------------------------------------------ lite projection bake
def _route_tex_emit(mat):
    """Detailed atlas material: base texture -> emission (the source of the selected-to-active projection)."""
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    old = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].is_linked else None
    em = nt.nodes.new('ShaderNodeEmission')
    sock, dv = _src(nt, b, 'Base Color')
    if sock is not None:
        nt.links.new(sock, em.inputs['Color'])
    else:
        em.inputs['Color'].default_value = tuple(dv)
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return (em, old, out)


def _unroute_tex_emit(mat, st):
    em, old, out = st
    mat.node_tree.nodes.remove(em)
    if old is not None:
        mat.node_tree.links.new(old, out.inputs['Surface'])


def bake_lite(lite_ob, sources, size, cache, texdir, venv_py, compose_script, extrusion=0.035, ray=0.09):
    """Project the detailed interior's final colours onto the joined lite mesh ('atlas' UVs already packed).
    Writes <name>_proj.npy (projected colour), <name>_hit.npy (hit mask) and <name>_alb.npy (own fallback colour)."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'GPU'
    sc.render.bake.margin_type = 'EXTEND'
    name = lite_ob.name
    os.makedirs(cache, exist_ok=True)
    lite_mats = [s.material for s in lite_ob.material_slots if s.material]
    # 1. own fallback albedo (plain bake of the lite object alone)
    select_only([lite_ob])
    img = _new_img(f'_ib_{name}_alb', size)
    st = [(m, _route(m, img, 'Base Color')) for m in lite_mats]
    sc.cycles.samples = 2
    bpy.ops.object.bake(type='EMIT', margin=8, use_clear=True)
    for m, s_ in st:
        _unroute(m, s_)
    _save_npy(img, os.path.join(cache, f'{name}_alb.npy'), size)
    bpy.data.images.remove(img)
    # 2. projected colour and 3. hit mask: sources emit their base texture / white
    src_mats = set()
    for o in sources:
        for s in o.material_slots:
            if s.material:
                src_mats.add(s.material)
    for key in ('proj', 'hit'):
        img = _new_img(f'_ib_{name}_{key}', size)
        st_l = [(m, _route(m, img, 'mask')) for m in lite_mats]      # target node active on the lite materials
        if key == 'proj':
            st_s = [(m, _route_tex_emit(m)) for m in src_mats]
        else:
            st_s = [(m, _route(m, _new_img('_ib_dummy', 8), 'mask')) for m in src_mats]
        select_only(list(sources) + [lite_ob], active=lite_ob)
        sc.cycles.samples = 4
        sc.render.bake.use_selected_to_active = True
        sc.render.bake.cage_extrusion = extrusion
        sc.render.bake.max_ray_distance = ray
        bpy.ops.object.bake(type='EMIT', margin=8, use_clear=True, use_selected_to_active=True,
                            cage_extrusion=extrusion, max_ray_distance=ray)
        sc.render.bake.use_selected_to_active = False
        for m, s_ in st_l:
            _unroute(m, s_)
        for m, s_ in st_s:
            if key == 'proj':
                _unroute_tex_emit(m, s_)
            else:
                _unroute(m, s_)
        _save_npy(img, os.path.join(cache, f'{name}_{key}.npy'), size)
        bpy.data.images.remove(img)
        log('lite baked', key)
    r = subprocess.run([venv_py, compose_script, cache, texdir, f'{name}:{size}', '--lite'], capture_output=True, text=True)
    print(r.stdout[-2000:], r.stderr[-2000:], flush=True)
    if r.returncode != 0:
        raise RuntimeError('lite compose failed')
