"""Hull texture atlas: UV unwrap all hull-skin objects into one atlas and bake G-frame position / normal / AO / coverage
maps (float) that texgen.py turns into base colour, ORM and normal maps."""
import os
import math
import bpy
import bmesh
import numpy as np


def hull_objects(mat_name='hull'):
    out = []
    for o in bpy.data.objects:
        if o.type == 'MESH' and any(s.material and s.material.name == mat_name for s in o.material_slots):
            out.append(o)
    return out


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def unwrap_atlas(objs, mat_name='hull', angle=38.0, margin=0.0025):
    """Smart-project islands, then conformal unwrap per island (less projection stretch), pack all objects together."""
    select_only(objs)
    bpy.ops.object.mode_set(mode='EDIT')
    for o in objs:
        me = o.data
        bm = bmesh.from_edit_mesh(me)
        idx = [i for i, s in enumerate(o.material_slots) if s.material and s.material.name == mat_name]
        for f in bm.faces:
            f.select = f.material_index in idx
        bmesh.update_edit_mesh(me)
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    try:
        bpy.ops.uv.average_islands_scale()
    except Exception:
        pass
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method='CONCAVE')
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')


def _emit_setup(mat, img, source):
    """Temporarily route 'source' (a callable building a colour socket) into an Emission shader + active image node."""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
    old_link = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].links else None
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    sock = source(nt)
    if sock is not None:
        nt.links.new(sock, em.inputs['Color'])
    else:
        em.inputs['Color'].default_value = (1, 1, 1, 1)
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.nodes.active = tex
    return (em, tex, old_link, out)


def _emit_restore(mat, state):
    em, tex, old_link, out = state
    nt = mat.node_tree
    nt.nodes.remove(em)
    nt.nodes.remove(tex)
    if old_link is not None:
        nt.links.new(old_link, out.inputs['Surface'])


def bake_maps(objs, cache_dir, size=4096, mat_name='hull', samples_ao=96, hide=(), gpu=True):
    os.makedirs(cache_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    if gpu:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    else:
        sc.cycles.device = 'CPU'
    sc.cycles.samples = 1
    sc.render.bake.margin_type = 'EXTEND'
    hull_mat = bpy.data.materials[mat_name]
    others = set()
    for o in objs:
        for s in o.material_slots:
            if s.material and s.material != hull_mat:
                others.add(s.material)
    dummy = bpy.data.images.new('_bake_dummy', 8, 8, alpha=True, float_buffer=True)
    hidden = []
    for o in hide:
        if not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    select_only(objs)
    results = {}

    def run(name, kind, source, margin, float_buf=True):
        img = bpy.data.images.new('_bake_' + name, size, size, alpha=True, float_buffer=float_buf)
        img.colorspace_settings.name = 'Non-Color'
        img.generated_color = (0, 0, 0, 0)
        st = _emit_setup(hull_mat, img, source)
        other_st = [(m, _emit_setup(m, dummy, lambda nt: None)) for m in others]
        sc.render.bake.margin = margin
        t = bpy.context.scene.cycles
        t.samples = samples_ao if kind == 'AO' else 1
        bpy.ops.object.bake(type=kind, margin=margin, use_clear=True)
        _emit_restore(hull_mat, st)
        for m, s in other_st:
            _emit_restore(m, s)
        a = np.empty(size * size * 4, np.float32)
        img.pixels.foreach_get(a)
        a = a.reshape(size, size, 4)
        np.save(os.path.join(cache_dir, f'{name}.npy'), a)
        bpy.data.images.remove(img)
        results[name] = a
        print(f'[uh60] baked {name}', flush=True)

    def geo(out):
        def f(nt):
            g = nt.nodes.new('ShaderNodeNewGeometry')
            return g.outputs[out]
        return f

    run('mask', 'EMIT', lambda nt: None, 0)
    run('pos', 'EMIT', geo('Position'), 24)
    run('nrm', 'EMIT', geo('Normal'), 24)
    sc.world.light_settings.distance = 0.7 if sc.world else 0.7
    run('ao', 'AO', lambda nt: None, 24)
    for o in hidden:
        o.hide_render = False
    bpy.data.images.remove(dummy)
    return results
