"""b737_lod.glb: static parked/AI copy (≤ 40k triangles, no interior, small textures, no normal maps).
Destructive on the current scene: call after the main export (and after saving the .blend)."""
import os
import bpy

import mk

HERE = os.path.dirname(os.path.abspath(__file__))
LODTEX = os.path.join(HERE, 'tex', 'lod')

def _delete_tree(o):
    for c in list(o.children):
        _delete_tree(c)
    bpy.data.objects.remove(o, do_unlink=True)


def finish_lod(out_path, log=print):
    """LOD scene was generated at low resolution: flatten to one static node, small textures, export."""
    inter = bpy.data.objects.get('interior')
    if inter:
        _delete_tree(inter)
    for n in ('flightdeck_shell',):
        if n in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
    for o in list(bpy.data.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.view_layer.update()
    for o in bpy.data.objects:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    bpy.context.view_layer.update()
    for o in bpy.data.objects:
        o.data = o.data.copy()
        o.data.transform(o.matrix_world)
        o.matrix_world.identity()
    # small plain-material parts: collapse-decimate (their UVs do not matter)
    for o in list(bpy.data.objects):
        if o.name.startswith(('gear_', 'wheel_')) and mk.tri_count([o]) > 150:
            import bmesh
            bm = bmesh.new(); bm.from_mesh(o.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
            bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
            bm.to_mesh(o.data); bm.free()
            mod = o.modifiers.new('dec', 'DECIMATE')
            mod.decimate_type = 'COLLAPSE'
            mod.ratio = 0.35
            n0 = mk.tri_count([o])
            with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
                r = bpy.ops.object.modifier_apply(modifier=mod.name)
    objs = list(bpy.data.objects)
    stats = sorted(((mk.tri_count([o]), o.name) for o in objs), reverse=True)
    log('LOD parts', stats[:16])
    tgt = bpy.data.objects['fuselage']
    with bpy.context.temp_override(active_object=tgt, object=tgt, selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    tgt.name = 'b737_lod'
    tgt.data.name = 'b737_lod'
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        nt = m.node_tree
        for n in list(nt.nodes):
            if n.type == 'NORMAL_MAP':
                nt.nodes.remove(n)
            elif n.type == 'TEX_IMAGE' and n.image is not None:
                base = os.path.splitext(os.path.basename(n.image.filepath))[0]
                p = os.path.join(LODTEX, base + '.jpg')
                if os.path.exists(p):
                    im = bpy.data.images.load(p, check_existing=True)
                    im.colorspace_settings.name = n.image.colorspace_settings.name
                    n.image = im
                elif base.endswith('_nrm'):
                    nt.nodes.remove(n)
    tris = mk.tri_count([tgt])
    from util import export_glb
    export_glb(out_path, objects=[tgt], draco=True)
    log('LOD', out_path, f'{os.path.getsize(out_path) / 1e6:.2f} MB', 'tris', tris)
    return tris
