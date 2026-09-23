"""A320neo (CFM LEAP-1A) — Turkish Airlines TC-LUA (livery from textures.py / livery_thy.py). Deterministic Blender build.

.venv/bin/python blender/aircraft/a320neo/cockpit_tex.py          # flight-deck panel atlases first
/Applications/Blender.app/Contents/MacOS/Blender -b -P blender/aircraft/a320neo/build.py -- [--no-export] [--no-lod]
    [--save-blend] [--skip-interior] [--no-bake] [--bake-samples N]

Outputs (CONTRACTS-SF.md 6.2.1):
  assets/aircraft/a320neo/a320neo.glb          exterior + `interior_lite` (light stand-in seen through the windows)
  assets/aircraft/a320neo/a320neo_cockpit.glb  root `interior`: detailed flight deck (same frame), all screen_* meshes
  assets/aircraft/a320neo/a320neo_lod.glb      static LOD
  assets/aircraft/a320neo/a320neo.blend        (--save-blend) exterior + detailed flight deck with unbaked materials,
                                               used by render.py for the Cycles renders
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))

import importlib
import bpy
import util
import geo
import layout as LY
for m in (geo, LY):
    importlib.reload(m)

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
REPO = util.REPO
OUT = os.path.join(REPO, 'assets', 'aircraft', 'a320neo')
T0 = time.time()


def log(*a):
    print(f'[a320neo {time.time() - T0:6.1f}s]', *a, flush=True)


def main(lod=False):
    import materials as MT
    import fuselage as FU
    import wing as WG
    import empennage as EM
    import engine as EN
    import gear as GR
    import details as DT
    for m in (MT, FU, WG, EM, EN, GR, DT):
        importlib.reload(m)
    geo.DETAIL = 0.30 if lod else 1.0
    util.reset_scene()
    root = bpy.data.objects.new('a320neo_lod' if lod else 'a320neo', None)
    bpy.context.scene.collection.objects.link(root)
    col_ext = geo.collection('EXT')
    col_int = geo.collection('INT')
    mats = MT.build_materials(lod=lod)
    log('materials', 'LOD' if lod else '')

    skin, glass = FU.build(col_ext, mats['fuselage'], mats['glass'], cut_windows=not lod)
    belly = FU.belly_fairing(col_ext, mats['belly'])
    apu = FU.apu_exhaust(col_ext, mats['dark'], mats['exhaust'])
    if not lod:
        c_mlg, c_mlgf, c_nlg = GR.cutters(col_ext)
        geo.boolean(belly, c_mlg)
        geo.boolean(skin, c_mlgf)
        geo.boolean(skin, c_nlg)
        for c in (c_mlg, c_mlgf, c_nlg):
            bpy.data.objects.remove(c, do_unlink=True)
    FU.fuselage_uv(skin)
    FU.window_frames(col_ext, mats['frame_paint'])
    log('fuselage')
    wing_objs = WG.build(col_ext, mats)
    log('wing')
    emp = EM.build(col_ext, mats)
    log('empennage')
    eng = EN.build(col_ext, mats)
    log('engines')
    gear = GR.build(col_ext, mats)
    log('gear')
    dt = DT.build(col_ext, mats, lod=lod)
    log('details')
    if '--compare' in ARGS and not lod:
        import preview as PV
        importlib.reload(PV)
        PV.render_views(ARGS[ARGS.index('--compare') + 1])

    if lod:
        # static copy: drop empties / wells, join every mesh into one multi-material node
        for o in list(bpy.context.scene.objects):
            if o.type != 'MESH' and o is not root:
                bpy.data.objects.remove(o, do_unlink=True)
            elif o.type == 'MESH' and o.name in ('gear_wells',):
                bpy.data.objects.remove(o, do_unlink=True)
        meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        for o in meshes:
            w = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = w
            geo.apply_transform(o)
        body = geo.join(meshes, 'a320neo_lod_mesh')
        geo.parent_keep(body, root)
        tl = geo.tri_count(body)
        path = os.path.join(OUT, 'a320neo_lod.glb')
        util.export_glb(path)
        log('exported LOD', tl, 'tris', round(os.path.getsize(path) / 1e6, 2), 'MB')
        return

    grp = None
    if '--skip-interior' not in ARGS:
        import cockpit as CK
        importlib.reload(CK)
        grp = CK.build(col_int, mats)
        log('cockpit')

    # parent every top-level object to the root
    for o in list(bpy.context.scene.objects):
        if o is not root and o.parent is None:
            geo.parent_keep(o, root)

    tris = {}
    for o in bpy.context.scene.objects:
        top = o
        while top.parent is not None and top.parent is not root:
            top = top.parent
        key = 'interior' if top.name == 'interior' else 'exterior'
        tris[key] = tris.get(key, 0) + geo.tri_count(o)
    log('triangles', tris)

    if '--save-blend' in ARGS:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'a320neo.blend'))
        log('saved blend')
    if '--no-export' in ARGS:
        return
    if grp is not None:
        import cockpit_bake as CB
        importlib.reload(CB)
        if '--no-bake' not in ARGS:
            CB.bake(grp, samples=int(ARGS[ARGS.index('--bake-samples') + 1]) if '--bake-samples' in ARGS else 96)
            log('baked')
        CB.finalize(grp)
        interior = bpy.data.objects['interior']
        objs = [interior] + list(interior.children_recursive)
        path = os.path.join(OUT, 'a320neo_cockpit.glb')
        util.export_glb(path, objects=objs)
        ti = sum(geo.tri_count(o) for o in objs)
        log('exported cockpit', ti, 'tris', round(os.path.getsize(path) / 1e6, 2), 'MB')
        lite_src = CB.lite_sources(grp)
        import cockpit_lite as LT
        importlib.reload(LT)
        lite = LT.build(col_int, lite_src)
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
        geo.parent_keep(lite, root)
        tl = sum(geo.tri_count(o) for o in [lite] + list(lite.children_recursive))
        log('interior_lite', tl, 'tris')
    path = os.path.join(OUT, 'a320neo.glb')
    util.export_glb(path)
    log('exported', round(os.path.getsize(path) / 1e6, 2), 'MB')


if '--lod-only' in ARGS:
    main(lod=True)
else:
    main()
    if '--no-lod' not in ARGS and '--no-export' not in ARGS:
        main(lod=True)
