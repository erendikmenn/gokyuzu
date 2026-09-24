"""İstanbul airport buildings in Blender: blender/airports/build_buildings.py (unchanged, shared with San Francisco) plus
the İstanbul models, in one run.

  GEO_REGION=ist /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/geo/airports_ist_blender.py -- ltfm

The shared builder is executed as it is; its GLB export is intercepted (blender/common/util.export_glb is wrapped
before the builder imports it) and, just before the export,
  1. the generic objects of buildings / structures the İstanbul models replace are removed
     (assets/ist/airports/_cache/models_<icao>.json `remove`: object names as build_buildings.py makes them),
  2. the models of that file are added (face lists in Blender coordinates relative to each object's anchor, written by
     tools/geo/airports_ist_models.py through airports_build.py): İstanbul Havalimanı terminal + piers, Sabiha
     Gökçen's terminals, the control towers, the Turkish Technic hangar lettering,
  3. every constant-colour material (metal / paint / concrete swatches) is moved onto ONE atlas material `ist_atlas`
     (assets/ist/airports/_cache/atlas/ist_atlas.png + _mr.png, tools/geo/airports_ist_atlas.py; the GLBs embed them,
     tools/assets/textures.mjs turns them into shared KTX2): each polygon's UVs point at its colour swatch, roughness / metalness come from the swatch's texel of the metallic-roughness map.
     The runtime merges meshes per material, so seven constant materials become one draw call per airport.
San Francisco never runs this script (its buildings stay exactly as build_buildings.py makes them).
"""
import sys, os, json, runpy
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'blender', 'common'))
sys.path.insert(0, os.path.join(REPO, 'blender', 'airports'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import util  # noqa: E402
import materials as M  # noqa: E402
from geom import MB  # noqa: E402
from airports_ist_atlas import SWATCH, swatch_uv, ATLAS_PNG, ATLAS_MR_PNG  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ICAO = (argv[0] if argv else 'ltfm').lower()
OUT = os.path.join(REPO, 'assets', os.environ.get('GEO_REGION', 'ist'), 'airports')
MODELS = os.path.join(OUT, '_cache', f'models_{ICAO}.json')


def atlas_material():
    """Principled BSDF: base colour = ist_atlas.png (sRGB), roughness / metallic = G / B of ist_atlas_mr.png."""
    m = bpy.data.materials.new('ist_atlas')
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    img = bpy.data.images.load(ATLAS_PNG, check_existing=True)
    tx = nt.nodes.new('ShaderNodeTexImage')
    tx.image = img
    tx.interpolation = 'Linear'
    nt.links.new(tx.outputs['Color'], bsdf.inputs['Base Color'])
    mr = bpy.data.images.load(ATLAS_MR_PNG, check_existing=True)
    mr.colorspace_settings.name = 'Non-Color'
    tm = nt.nodes.new('ShaderNodeTexImage')
    tm.image = mr
    tm.interpolation = 'Linear'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(tm.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    return m


def add_models(models):
    n_obj, n_tri = 0, 0
    for ob in models.get('objects', []):
        mb = MB()
        for mat, v, uv in ob['faces']:
            pts = [tuple(v[i:i + 3]) for i in range(0, len(v), 3)]
            uvs = [tuple(uv[i:i + 2]) for i in range(0, len(uv), 2)]
            mb.face(pts, uvs, mat, bool(ob.get('smooth')))
            n_tri += len(pts) - 2
        o = mb.to_object(ob['name'], (ob['anchor'][0], ob['anchor'][1], 0.0))
        if o is not None:
            o['kind'] = ob.get('kind', ob['name'].split('_')[0])
            n_obj += 1
    print(f'[{ICAO}] İstanbul models: {n_obj} objects, {n_tri} triangles')


def remove_generic(models):
    names = set(models.get('remove', []))
    prefixes = tuple(models.get('remove_prefix', []))
    gone = 0
    for ob in list(bpy.context.scene.objects):
        base = ob.name
        if base in names or (prefixes and base.startswith(prefixes)):
            bpy.data.objects.remove(ob, do_unlink=True)
            gone += 1
    print(f'[{ICAO}] removed {gone} generic objects')


def remap_constants():
    """Constant-colour materials -> the atlas swatch (UVs of the polygon at the swatch centre)."""
    atlas = M._cache['ist_atlas']
    moved = 0
    for ob in bpy.context.scene.objects:
        if ob.type != 'MESH':
            continue
        me = ob.data
        names = [m.name if m else '' for m in me.materials]
        if not any(n in SWATCH for n in names):
            continue
        if 'ist_atlas' not in names:
            me.materials.append(atlas)
            names.append('ist_atlas')
        ai = names.index('ist_atlas')
        uvl = me.uv_layers.active or me.uv_layers.new(name='UVMap')
        for p in me.polygons:
            n = names[p.material_index]
            if n not in SWATCH:
                continue
            u, v = swatch_uv(n)
            p.material_index = ai
            for li in p.loop_indices:
                uvl.data[li].uv = (u, v)
            moved += 1
        # drop the now unused slots (the exporter writes one primitive per used material)
        used = {p.material_index for p in me.polygons}
        for k in range(len(me.materials) - 1, -1, -1):
            if k not in used:
                for p in me.polygons:
                    if p.material_index > k:
                        p.material_index -= 1
                me.materials.pop(index=k)
    print(f'[{ICAO}] {moved} polygons moved onto the atlas')


_export = util.export_glb


def export_with_models(path, *a, **kw):
    models = json.load(open(MODELS)) if os.path.exists(MODELS) else {}
    remove_generic(models)
    add_models(models)
    remap_constants()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH')
    mats = sorted({m.name for o in bpy.context.scene.objects if o.type == 'MESH' for m in o.data.materials if m})
    print(f'[{ICAO}] final: {len(bpy.context.scene.objects)} objects, ~{tris} triangles, materials {len(mats)}: {", ".join(mats)}')
    return _export(path, *a, **kw)


util.export_glb = export_with_models
# the atlas material is created once and handed to the shared builder's material cache (geom.MB.to_object -> M.get)
_reset = util.reset_scene


def reset_and_atlas():
    sc = _reset()
    M._cache.clear()
    M._cache['ist_atlas'] = atlas_material()
    return sc


util.reset_scene = reset_and_atlas
sys.argv = [sys.argv[0], '--', ICAO] + argv[1:]
runpy.run_path(os.path.join(REPO, 'blender', 'airports', 'build_buildings.py'), run_name='__main__')
