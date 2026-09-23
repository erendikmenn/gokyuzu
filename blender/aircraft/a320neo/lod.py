"""Static LOD (parked copies at the gates): decimated exterior, gear down, no interior, <= 40k triangles,
opaque cockpit glass, textures downscaled. Called from build.py after the main export."""
import os
import bpy
import numpy as np
import geo

BUDGET = [  # (category, name predicates, triangle budget)
    ('fuselage', ('fuselage',), 9500),
    ('belly', ('belly_fairing', 'apu_exhaust'), 900),
    ('frames', ('cockpit_frames', 'cockpit_glass'), 900),
    ('wing', ('wing_', 'ctl_slat', 'ctl_flap', 'ctl_spoiler', 'ctl_aileron', 'ftf_'), 11000),
    ('tail', ('fin', 'ctl_rudder', 'htail', 'ctl_elevator'), 2600),
    ('engine', ('nacelle_', 'reverser_'), 6400),
    ('fan', ('fan_',), 1400),
    ('gear', ('gear_', 'wheel_'), 5200),
    ('lights', ('light_fixtures',), 600),
]
SKIP = ('antennas', 'wipers', 'gear_wells', 'ck_', 'interior', 'screen_')
TEX_MAX = {'fuselage_color.jpg': (2048, 1024), 'fuselage_normal.png': None, 'fuselage_orm.png': None,
           'wing_color.jpg': (1024, 1024), 'wing_orm.png': None, 'wing_normal.png': None, 'tail_color.jpg': (1024, 512),
           'tail_orm.png': None, 'htail_color.jpg': (512, 512), 'nacelle_color.jpg': (512, 256)}


def category(name):
    for cat, preds, budget in BUDGET:
        if any(name.startswith(p) for p in preds):
            return cat
    return None


def lod_material(mat, cache):
    if mat.name in cache:
        return cache[mat.name]
    m = mat.copy()
    m.name = 'lod_' + mat.name
    if mat.name == 'cockpit_glass':
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Alpha'].default_value = 1.0
        try:
            m.surface_render_method = 'DITHERED'
        except Exception:
            pass
        try:
            m.blend_method = 'OPAQUE'
        except Exception:
            pass
    for n in list(m.node_tree.nodes):
        if n.type == 'TEX_IMAGE' and n.image is not None:
            key = os.path.basename(n.image.filepath)
            lodp = os.path.join(os.path.dirname(bpy.path.abspath(n.image.filepath)), 'lod_' + key)
            if os.path.exists(lodp):
                n.image = bpy.data.images.load(lodp, check_existing=True)
            else:                                   # detail maps (normal / ORM) are dropped in the LOD
                m.node_tree.nodes.remove(n)
    cache[mat.name] = m
    return m


def build_lod(root_name='a320neo_lod'):
    src = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not any(o.name.startswith(s) for s in SKIP)]
    # skip anything inside the interior hierarchy
    def in_interior(o):
        p = o.parent
        while p is not None:
            if p.name == 'interior':
                return True
            p = p.parent
        return False
    src = [o for o in src if not in_interior(o) and category(o.name)]
    col = geo.collection('LOD')
    copies = {}
    for o in src:
        me = o.data.copy()
        c = bpy.data.objects.new('lodsrc_' + o.name, me)
        col.objects.link(c)
        c.matrix_world = o.matrix_world.copy()
        geo.apply_transform(c)
        copies.setdefault(category(o.name), []).append(c)
    out = []
    matcache = {}
    total = 0
    for cat, preds, budget in BUDGET:
        objs = copies.get(cat, [])
        if not objs:
            continue
        tris = sum(geo.tri_count(o) for o in objs)
        ratio = min(1.0, budget / max(tris, 1))
        for o in objs:
            if ratio < 0.999:
                m = o.modifiers.new('dec', 'DECIMATE')
                m.decimate_type = 'COLLAPSE'
                m.ratio = ratio
                m.use_collapse_triangulate = True
                geo.apply_modifiers(o)
            for i, mat in enumerate(o.data.materials):
                if mat is not None:
                    o.data.materials[i] = lod_material(mat, matcache)
        j = geo.join(objs, f'lod_{cat}')
        j.data.validate(clean_customdata=False)
        total += geo.tri_count(j)
        out.append(j)
    root = bpy.data.objects.new(root_name, None)
    col.objects.link(root)
    for o in out:
        geo.parent_keep(o, root)
    print('[lod] triangles', total)
    return root, out, total
