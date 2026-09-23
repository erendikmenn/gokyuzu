"""Cockpit texture bake: art atlas (UV 'art') + soft interior light / ambient occlusion -> one unique-UV colour map.

1. every baked cockpit mesh gets a second UV layer 'bake' (smart project, panels/consoles/ICP scaled up for more texels,
   packed together into one 0..1 layout)
2. Cycles bakes (a) the art colour (emission of the art texture through UV 'art') and (b) the diffuse irradiance under a
   soft sky dome with the exterior skin and the canopy frame as occluders (direct + indirect, no colour)
3. numpy composite: colour * light -> cockpit.jpg (4096^2), the 'art' UV layer is removed and the final material uses
   UV 'bake' only (glTF: one TEXCOORD).
"""
import os
import time
import numpy as np
import bpy
import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
TEX = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'tex')
CACHE = os.path.join(REPO, 'assets', 'aircraft', 'f22', '_bake')
SRC = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'src')

DETAIL_SCALE = 3.2          # texel density boost for faces mapped to panel / console / ICP art


def _is_detail_uv(uvs):
    """Face UVs inside the high-detail art regions (panels, consoles, ICP, walls) -> boost."""
    import cklayout as L
    for name in ('pan_C', 'pan_L', 'pan_R', 'pan_K', 'icp', 'lcon', 'rcon', 'canopy_sw', 'headbox'):
        u0, v0, u1, v1 = L.region_uv(name)
        if all(u0 - 1e-4 <= u <= u1 + 1e-4 and v0 - 1e-4 <= v <= v1 + 1e-4 for (u, v) in uvs):
            return True
    return False


def make_bake_uv(objs, margin=0.003):
    """Unique UV layout over all objects (one shared 0..1 space)."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        me = o.data
        if 'bake' in me.uv_layers:
            me.uv_layers.remove(me.uv_layers['bake'])
        lay = me.uv_layers.new(name='bake')
        me.uv_layers.active = lay
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    import math
    bpy.ops.uv.smart_project(angle_limit=math.radians(50), island_margin=margin, area_weight=0.0, correct_aspect=True,
                             scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    # texel density per face class (islands are scaled about the UV origin, then everything is re-packed):
    #   panel / console / ICP / placard art x DETAIL_SCALE, plain colour patches x 0.3, large plain surfaces x 0.6
    import cklayout as L
    big = [L.region_uv(n) for n in ('floor', 'bulk', 'deck', 'glare', 'wall_L', 'wall_R')]
    for o in objs:
        me = o.data
        art = me.uv_layers['art'].data
        bk = me.uv_layers['bake'].data
        for poly in me.polygons:
            li = list(poly.loop_indices)
            uvs = [tuple(art[i].uv) for i in li]
            if _is_detail_uv(uvs):
                k = DETAIL_SCALE
            elif max(abs(u - uvs[0][0]) + abs(v - uvs[0][1]) for (u, v) in uvs) < 1e-6:
                k = 0.3
            elif any(all(r[0] - 1e-4 <= u <= r[2] + 1e-4 and r[1] - 1e-4 <= v <= r[3] + 1e-4 for (u, v) in uvs) for r in big):
                k = 0.6
            else:
                k = 1.0
            for i in li:
                u, v = bk[i].uv
                bk[i].uv = (u * k, v * k)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    try:
        bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, scale=True, margin=margin,
                                margin_method='SCALED', shape_method='CONCAVE')
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.scene.tool_settings.use_uv_select_sync = False


def _new_img(name, size, alpha=False, float_buf=True):
    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    img = bpy.data.images.new(name, size, size, alpha=alpha, float_buffer=float_buf)
    img.colorspace_settings.name = 'Non-Color'
    return img


def _setup_cycles(samples):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    if os.environ.get('F22_DEVICE', 'GPU').upper() == 'CPU':
        sc.cycles.device = 'CPU'
    else:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.render.bake.margin = 8
    sc.render.bake.use_clear = True
    sc.render.bake.target = 'IMAGE_TEXTURES'


def bake(objs, art_path, occluders=(), size=4096, light_size=2048, samples=128):
    """Returns (colour, light) float arrays (H, W, 3/1), v=0 at row 0."""
    os.makedirs(CACHE, exist_ok=True)
    sc = bpy.context.scene
    _setup_cycles(1)
    orig = {o.name: [s.material for s in o.material_slots] for o in objs}
    for o in objs:
        o.data.uv_layers.active = o.data.uv_layers['bake']
    art = bpy.data.images.load(art_path, check_existing=True)

    def select():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]

    # ---- (a) art colour via emission
    img = _new_img('ck_col', size)
    m = bpy.data.materials.new('ck_bake_art')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    uvn = nt.nodes.new('ShaderNodeUVMap')
    uvn.uv_map = 'art'
    tx = nt.nodes.new('ShaderNodeTexImage')
    tx.image = art
    tx.interpolation = 'Closest' if False else 'Linear'
    nt.links.new(uvn.outputs['UV'], tx.inputs['Vector'])
    nt.links.new(tx.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    tgt = nt.nodes.new('ShaderNodeTexImage')
    tgt.image = img
    nt.nodes.active = tgt
    for o in objs:
        for s in o.material_slots:
            s.material = m
    select()
    t0 = time.time()
    bpy.ops.object.bake(type='EMIT', margin=8, use_clear=True)
    print(f'[f22] cockpit art bake {time.time() - t0:.1f}s')
    col = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(col)
    col = col.reshape(size, size, 4)
    # ---- (b) soft interior light: diffuse irradiance under a sky dome (white material)
    _setup_cycles(samples)
    world = bpy.data.worlds.new('ck_bake_sky')
    world.use_nodes = True
    wn = world.node_tree
    wn.nodes.clear()
    wo = wn.nodes.new('ShaderNodeOutputWorld')
    bg = wn.nodes.new('ShaderNodeBackground')
    tc = wn.nodes.new('ShaderNodeTexCoord')
    sep = wn.nodes.new('ShaderNodeSeparateXYZ')
    mr = wn.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = -0.3
    mr.inputs['From Max'].default_value = 1.0
    mr.inputs['To Min'].default_value = 0.15
    mr.inputs['To Max'].default_value = 1.6
    wn.links.new(tc.outputs['Generated'], sep.inputs[0])
    wn.links.new(sep.outputs['Z'], mr.inputs['Value'])
    wn.links.new(mr.outputs['Result'], bg.inputs['Strength'])
    bg.inputs['Color'].default_value = (1, 1, 1, 1)
    wn.links.new(bg.outputs[0], wo.inputs['Surface'])
    prev_world = sc.world
    sc.world = world
    limg = _new_img('ck_light', light_size)
    wm = bpy.data.materials.new('ck_bake_white')
    wm.use_nodes = True
    p = wm.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1)
    p.inputs['Roughness'].default_value = 0.9
    t2 = wm.node_tree.nodes.new('ShaderNodeTexImage')
    t2.image = limg
    wm.node_tree.nodes.active = t2
    for o in objs:
        for s in o.material_slots:
            s.material = wm
    # hide everything that is neither baked nor an occluder
    keep = set(objs) | set(occluders)
    hidden = []
    for o in bpy.data.objects:
        if o.type == 'MESH' and o not in keep and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    sc.render.bake.use_pass_direct = True
    sc.render.bake.use_pass_indirect = True
    sc.render.bake.use_pass_color = False
    select()
    t0 = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=8, use_clear=True)
    print(f'[f22] cockpit light bake {time.time() - t0:.1f}s')
    lt = np.empty(light_size * light_size * 4, np.float32)
    limg.pixels.foreach_get(lt)
    lt = lt.reshape(light_size, light_size, 4)
    for o in hidden:
        o.hide_render = False
    sc.world = prev_world
    for o in objs:
        for i, s in enumerate(o.material_slots):
            s.material = orig[o.name][i]
    np.save(os.path.join(CACHE, 'ck_col.npy'), col.astype(np.float16))
    np.save(os.path.join(CACHE, 'ck_light.npy'), lt.astype(np.float16))
    return col, lt


def composite(col, lt, out_path, size=4096):
    """numpy/PIL part runs in the project venv (Blender's Python has no PIL/scipy): ckcomp.py reads the cached bakes."""
    import subprocess
    py = os.path.join(REPO, '.venv', 'bin', 'python')
    r = subprocess.run([py, os.path.join(HERE, 'ckcomp.py'), CACHE, out_path, str(size)], capture_output=True, text=True)
    print(r.stdout[-2000:])
    if r.returncode != 0:
        print(r.stderr[-4000:])
        raise RuntimeError('cockpit composite failed')
    return out_path


def final_material(path, name='f22_cockpit'):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'bake'
    tx = nt.nodes.new('ShaderNodeTexImage')
    tx.image = bpy.data.images.load(path, check_existing=False)
    nt.links.new(uv.outputs['UV'], tx.inputs['Vector'])
    nt.links.new(tx.outputs['Color'], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = 0.72
    p.inputs['Metallic'].default_value = 0.0
    m.diffuse_color = (0.1, 0.1, 0.1, 1)
    return m


def apply(objs, mat):
    for o in objs:
        me = o.data
        me.materials.clear()
        me.materials.append(mat)
        for poly in me.polygons:
            poly.material_index = 0
        if 'art' in me.uv_layers:
            me.uv_layers.remove(me.uv_layers['art'])
        me.uv_layers['bake'].active = True
        me.uv_layers['bake'].active_render = True
