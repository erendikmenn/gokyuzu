"""Exterior skin texturing for the F-22: UV atlas, Cycles bake of world position / normal / class / AO, then the
numpy compositor (composite.py, run with the project venv) turns those into baseColor / metallicRoughness / normal maps.
"""
import os
import subprocess
import time
import numpy as np
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CACHE = os.path.join(REPO, 'assets', 'aircraft', 'f22', '_bake')     # gitignored (assets/)
TEX = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'tex')
VENV_PY = os.path.join(REPO, '.venv', 'bin', 'python')

CLASS = {'f22_skin': 0.1, 'f22_dark': 0.3, 'f22_nozzle': 0.5, 'f22_bay': 0.7}
POS_OFF = (10.0, 10.0, 3.0)
POS_SCALE = (20.0, 20.0, 6.0)


def atlas_objects():
    out = []
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        n = ob.name
        if n == 'airframe' or n.startswith(('ctl_', 'gear_door_', 'nozzle_flap_')):
            out.append(ob)
    return out


def unwrap(objs, margin=0.0022):
    bpy.ops.object.mode_set(mode='OBJECT') if bpy.context.object and bpy.context.object.mode != 'OBJECT' else None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        while len(o.data.uv_layers):
            o.data.uv_layers.remove(o.data.uv_layers[0])
        o.data.uv_layers.new(name='atlas')
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    import math
    bpy.ops.uv.smart_project(angle_limit=math.radians(52), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def _emit_mat(name, build):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    build(nt, em)
    img = nt.nodes.new('ShaderNodeTexImage')
    nt.nodes.active = img
    return m, img


def _bake_image(name, size):
    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    img = bpy.data.images.new(name, size, size, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.generated_color = (0, 0, 0, 0)
    return img


def _vec_affine(nt, src, add, scale):
    a = nt.nodes.new('ShaderNodeVectorMath')
    a.operation = 'ADD'
    a.inputs[1].default_value = add
    nt.links.new(src, a.inputs[0])
    m = nt.nodes.new('ShaderNodeVectorMath')
    m.operation = 'MULTIPLY'
    m.inputs[1].default_value = scale
    nt.links.new(a.outputs[0], m.inputs[0])
    return m.outputs[0]


def bake_passes(objs, size=4096, ao_size=2048, ao_samples=96, hide=()):
    os.makedirs(CACHE, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    if os.environ.get('F22_DEVICE', 'GPU').upper() == 'CPU':
        sc.cycles.device = 'CPU'
        sc.render.threads_mode = 'AUTO'
    else:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    sc.render.bake.margin = 10
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.use_clear = True
    sc.render.bake.target = 'IMAGE_TEXTURES'
    if sc.world is None:
        sc.world = bpy.data.worlds.new('bakeworld')
    sc.world.light_settings.distance = 1.6
    # remember original materials
    orig = {o.name: [s.material for s in o.material_slots] for o in objs}
    hidden = []
    for o in bpy.data.objects:
        if o.name in hide or any(o.name.startswith(h) for h in hide if h.endswith('*')):
            pass
    for o in bpy.data.objects:
        if o.type == 'MESH' and o not in objs:
            if any(o.name == h or (h.endswith('_') and o.name.startswith(h)) for h in hide) or o.name.startswith(('gear_', 'wheel_')) and not o.name.startswith('gear_door_'):
                o.hide_render = True
                hidden.append(o)

    def select_all():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]

    def assign(mat_fn):
        for o in objs:
            for i, slot in enumerate(o.material_slots):
                slot.material = mat_fn(orig[o.name][i])

    results = {}

    def run(name, img, typ, samples):
        sc.cycles.samples = samples
        select_all()
        t0 = time.time()
        bpy.ops.object.bake(type=typ, margin=10, use_clear=True)
        print(f'[f22] bake {name}: {time.time() - t0:.1f}s')
        a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
        img.pixels.foreach_get(a)
        a = a.reshape(img.size[1], img.size[0], 4)
        np.save(os.path.join(CACHE, f'{name}.npy'), a.astype(np.float16) if name != 'pos' else a)
        results[name] = a

    # position
    img = _bake_image('bk_pos', size)
    m, node = _emit_mat('bk_pos', lambda nt, em: nt.links.new(
        _vec_affine(nt, nt.nodes.new('ShaderNodeNewGeometry').outputs['Position'], POS_OFF,
                    tuple(1 / v for v in POS_SCALE)), em.inputs['Color']))
    node.image = img
    assign(lambda _: m)
    run('pos', img, 'EMIT', 1)
    # normal: world-space corner normals stored in a colour attribute (Geometry.Normal can be flipped in bakes)
    for o in objs:
        me = o.data
        R = o.matrix_world.to_3x3()
        if 'wnrm' in me.color_attributes:
            me.color_attributes.remove(me.color_attributes['wnrm'])
        att = me.color_attributes.new('wnrm', 'FLOAT_COLOR', 'CORNER')
        cn = me.corner_normals
        for i in range(len(me.loops)):
            n = (R @ cn[i].vector).normalized()
            att.data[i].color = (n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, n.z * 0.5 + 0.5, 1.0)
    img = _bake_image('bk_nrm', size)

    def _nrm_build(nt, em):
        a = nt.nodes.new('ShaderNodeAttribute')
        a.attribute_name = 'wnrm'
        a.attribute_type = 'GEOMETRY'
        nt.links.new(a.outputs['Color'], em.inputs['Color'])
    m, node = _emit_mat('bk_nrm', _nrm_build)
    node.image = img
    assign(lambda _: m)
    run('nrm', img, 'EMIT', 1)
    # class id (per original material)
    img = _bake_image('bk_cls', size // 2)
    cls_mats = {}
    for mname, code in CLASS.items():
        mm, node = _emit_mat('bk_cls_' + mname, lambda nt, em, c=code: em.inputs['Color'].__setattr__(
            'default_value', (c, c, c, 1)))
        node.image = img
        cls_mats[mname] = mm
    assign(lambda om: cls_mats.get(om.name if om else 'f22_skin', cls_mats['f22_skin']))
    run('cls', img, 'EMIT', 1)
    # ambient occlusion (hide gear legs, interior, canopy)
    for o in bpy.data.objects:
        if o.type == 'MESH' and o not in objs and o.name not in ('formation_lights',):
            if o.name.startswith(('gear_nose', 'gear_main', 'wheel_', 'canopy', 'hud_', 'screen_', 'cockpit_', 'ab_glow', 'pilot')) \
                    or (o.parent and o.parent.name == 'interior'):
                o.hide_render = True
                hidden.append(o)
    img = _bake_image('bk_ao', ao_size)
    m, node = _emit_mat('bk_ao', lambda nt, em: None)
    node.image = img
    assign(lambda _: m)
    run('ao', img, 'AO', ao_samples)
    # restore
    for o in objs:
        for i, slot in enumerate(o.material_slots):
            slot.material = orig[o.name][i]
        if 'wnrm' in o.data.color_attributes:
            o.data.color_attributes.remove(o.data.color_attributes['wnrm'])
    for o in hidden:
        o.hide_render = False
    return results


def composite():
    os.makedirs(TEX, exist_ok=True)
    cmd = [VENV_PY, os.path.join(HERE, 'composite.py'), CACHE, os.path.join(REPO, 'assets', 'aircraft', 'f22', 'src'), TEX]
    print('[f22] composite:', ' '.join(cmd))
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout[-3000:])
    if r.returncode != 0:
        print(r.stderr[-5000:])
        raise RuntimeError('composite failed')
    print(f'[f22] composite done in {time.time() - t0:.1f}s')


def skin_material(name='f22_skin_baked'):
    """Final glTF-friendly material: baseColor + metallicRoughness (G/B) + normal map, UV 'atlas'."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'atlas'

    def img(file, noncolor):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(os.path.join(TEX, file), check_existing=True)
        if noncolor:
            n.image.colorspace_settings.name = 'Non-Color'
        nt.links.new(uv.outputs['UV'], n.inputs['Vector'])
        return n
    bc = img('f22_basecolor.jpg', False)
    nt.links.new(bc.outputs['Color'], p.inputs['Base Color'])
    mr = img('f22_metalrough.jpg', True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(mr.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], p.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
    nm = img('f22_normal.jpg', True)
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nmap.uv_map = 'atlas'
    nmap.inputs['Strength'].default_value = 1.0
    nt.links.new(nm.outputs['Color'], nmap.inputs['Color'])
    nt.links.new(nmap.outputs['Normal'], p.inputs['Normal'])
    m.diffuse_color = (0.35, 0.37, 0.39, 1)
    return m


def apply_skin(objs, mat):
    import bmesh
    for o in objs:
        me = o.data
        for f in me.polygons:
            f.material_index = 0
        me.materials.clear()
        me.materials.append(mat)
