"""Bake soft interior lighting / ambient occlusion into the flight-deck colour textures (CONTRACTS-SF.md 6.2.1).

Lighting rig: daylight sky through the windows (fuselage skin, window glass hidden) + a soft fill from the cabin door.
  * panel atlases A/B: diffuse irradiance baked on the flat panel faces (their atlas UVs; raised parts hidden, their
    contact shadows are already painted by cockpit_tex.py) -> atlas colour x f(irradiance)
  * shell (lining, floor, bulkhead, glareshield, pedestal / overhead / console bodies, seats, window frames ...): new
    lightmap UVs ('bake', smart projection + packing), albedo and irradiance baked -> one 4096^2 colour texture
f(E) = clamp((E / E_ref)^0.55, 0.28, 1.08): a normalised light factor, so the realtime lights (sky IBL + cockpit fill)
still shade the result.  Results: build/bake/*.jpg (the GLB references them).
"""
import math
import os
import numpy as np
import bpy
import geo
import cockpit_layout as CL

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'build', 'bake')
TEX = os.path.join(HERE, 'build', 'tex')
SHELL_RES, IRR_RES, PANEL_IRR_RES = 4096, 2048, 1024
UNBAKED_MATS = ('ck_dome', 'ck_visor', 'ck_lens', 'ck_screen')
# relative texel density of the shell lightmap islands
DENSITY = (('ck_seat', 1.7), ('ck_static_ck_glare', 1.3), ('ck_static_ck_bluegrey', 1.2), ('ck_static_lining_multi', 0.85),
           ('ck_static_ck_carpet', 0.5))


def _log(*a):
    print('[bake]', *a, flush=True)


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def new_image(name, res, float_buffer=True):
    im = bpy.data.images.get(name)
    if im:
        bpy.data.images.remove(im)
    im = bpy.data.images.new(name, res, res, alpha=True, float_buffer=float_buffer)
    im.generated_color = (0, 0, 0, 0)
    if float_buffer:
        im.colorspace_settings.name = 'Linear Rec.709'
    return im


def pixels(im):
    a = np.empty(im.size[0] * im.size[1] * 4, np.float32)
    im.pixels.foreach_get(a)
    return a.reshape(im.size[1], im.size[0], 4)


def set_target(mats, image):
    """Make `image` the active image node of every material (the bake target)."""
    nodes = []
    for m in mats:
        nt = m.node_tree
        n = nt.nodes.get('__bake__')
        if n is None:
            n = nt.nodes.new('ShaderNodeTexImage')
            n.name = '__bake__'
            n.location = (-1200, 800)
        n.image = image
        nt.nodes.active = n
        nodes.append(n)
    return nodes


def clear_targets():
    for m in bpy.data.materials:
        if m.node_tree and m.node_tree.nodes.get('__bake__'):
            m.node_tree.nodes.remove(m.node_tree.nodes['__bake__'])


def select_only(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def lighting_rig():
    sc = bpy.context.scene
    world = bpy.data.worlds.new('BakeSky')
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    sky = nt.nodes.new('ShaderNodeTexSky')
    for t in ('MULTIPLE_SCATTERING', 'NISHITA', 'SINGLE_SCATTERING'):
        try:
            sky.sky_type = t
            break
        except TypeError:
            continue
    for attr, val in (('sun_elevation', math.radians(55)), ('sun_rotation', math.radians(200)), ('sun_disc', False),
                      ('air_density', 1.4), ('aerosol_density', 3.0), ('dust_density', 3.0)):
        if hasattr(sky, attr):
            setattr(sky, attr, val)
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = 1.0
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    lights = []
    for name, loc, tgt, power, size in (('bake_fill', (0.0, CL.S_CG - 3.9, 0.9), (0.0, CL.S_CG - 1.8, 0.2), 45.0, 1.4),
                                        ('bake_dome', (0.0, CL.S_CG - 3.7, 1.35), (0.0, CL.S_CG - 3.0, 0.0), 25.0, 0.6)):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = power
        ld.size = size
        ld.color = (1.0, 0.96, 0.9)
        o = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(o)
        o.location = loc
        from mathutils import Vector
        o.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        lights.append(o)
    return lights


def setup_cycles(samples):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    if hasattr(prefs, 'kernel_optimization_level'):
        prefs.kernel_optimization_level = 'OFF'
    sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.render.bake.margin = 16
    sc.render.bake.margin_type = 'EXTEND'


def do_bake(target_objs, kind, uv_layer, margin=16):
    select_only(target_objs)
    if kind == 'irr':
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=margin, uv_layer=uv_layer,
                            target='IMAGE_TEXTURES', use_clear=True)
    else:
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=margin, uv_layer=uv_layer, target='IMAGE_TEXTURES',
                            use_clear=True)


def lum(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def blur(a, r=2):
    """Separable box blur (numpy only) to smooth sampling noise of the irradiance bakes."""
    k = 2 * r + 1
    out = a.copy()
    for ax in (0, 1):
        c = np.cumsum(np.pad(out, [(r + 1, r) if i == ax else (0, 0) for i in range(out.ndim)], mode='edge'), axis=ax)
        sl_hi = [slice(None)] * out.ndim
        sl_lo = [slice(None)] * out.ndim
        sl_hi[ax] = slice(k, None)
        sl_lo[ax] = slice(0, -k)
        out = (c[tuple(sl_hi)] - c[tuple(sl_lo)]) / k
    return out


def upsample(a, f):
    """Bilinear-ish upsample by an integer factor (repeat + blur)."""
    b = np.repeat(np.repeat(a, f, axis=0), f, axis=1)
    return blur(b, f // 2)


def light_factor(E, E_ref):
    return np.clip(np.power(np.maximum(E, 0) / E_ref, 0.55), 0.28, 1.08)


def save_rgb(arr_srgb, path, quality=90):
    """arr_srgb: (H, W, 3) sRGB-encoded 0..1 (row 0 = bottom, Blender order) -> JPEG via a byte image."""
    h, w = arr_srgb.shape[:2]
    name = os.path.basename(path)
    im = bpy.data.images.get(name)
    if im:
        bpy.data.images.remove(im)
    im = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    im.colorspace_settings.name = 'sRGB'
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = np.clip(arr_srgb, 0, 1)
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = 'JPEG'
    im.save(quality=quality)
    bpy.data.images.remove(im)
    return path


# ================================================================================================ shell lightmap UVs

def shell_uvs(objs):
    for o in objs:
        me = o.data
        if 'bake' in me.uv_layers:
            me.uv_layers.remove(me.uv_layers['bake'])
        if len(me.uv_layers) == 0:
            me.uv_layers.new(name='UVMap')
        me.uv_layers[0].active_render = True
        lay = me.uv_layers.new(name='bake')
        me.uv_layers.active = lay
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, correct_aspect=True,
                             scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode='OBJECT')
    # relative texel density per object group
    for o in objs:
        k = 1.0
        for pre, f in DENSITY:
            if o.name.startswith(pre):
                k = f
        if k != 1.0:
            lay = o.data.uv_layers['bake']
            uv = np.empty(len(lay.data) * 2, np.float32)
            lay.data.foreach_get('uv', uv)
            uv *= k
            lay.data.foreach_set('uv', uv)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.0015)
    bpy.ops.object.mode_set(mode='OBJECT')


# ================================================================================================ main entry

def shell_objects(grp):
    return [o for o in grp['shell'] if o is not None and o.type == 'MESH']


def bake(grp, samples=96):
    os.makedirs(OUT, exist_ok=True)
    sc = bpy.context.scene
    setup_cycles(samples)
    lights = lighting_rig()
    hidden = []
    for o in bpy.data.objects:
        if o.type == 'MESH' and (o.name.startswith('glass_') or o.name == 'cockpit_glass' or o.name.startswith('screen_')
                                 or any(m and m.name in ('cockpit_glass',) for m in o.data.materials)):
            if not o.hide_render:
                o.hide_render = True
                hidden.append(o)
    # split unbakeable parts (emissive dome lights, lenses) out of the merged shell objects
    shell = shell_objects(grp)
    keep = []
    for o in shell:
        mats = [m.name for m in o.data.materials if m]
        if mats and all(m in UNBAKED_MATS for m in mats):
            grp['smalls'].append(o)
        else:
            keep.append(o)
    grp['shell'] = keep
    shell = keep

    # ---------------------------------------------------------------- panels: irradiance on the atlas faces
    items = [o for o in list(grp['items'].values()) + grp['smalls'] + grp['anim'] if o is not None]
    for o in items:
        o.hide_render = True
    irr = {}
    for a in 'AB':
        base = grp['base'][a]
        im = new_image(f'irr_panel{a}', PANEL_IRR_RES)
        set_target([m for m in base.data.materials if m], im)
        _log('panel', a, 'irradiance')
        do_bake([base], 'irr', 'UVMap', margin=12)
        irr[a] = pixels(im)
    for o in items:
        o.hide_render = False
    clear_targets()

    # ---------------------------------------------------------------- shell: lightmap UVs, albedo + irradiance
    shell_uvs(shell)
    mats = sorted({m for o in shell for m in o.data.materials if m}, key=lambda m: m.name)
    alb_im = new_image('shell_albedo', SHELL_RES)
    set_target(mats, alb_im)
    _log('shell albedo', len(shell), 'objects', len(mats), 'materials')
    sc.cycles.samples = 4
    do_bake(shell, 'alb', 'bake', margin=8)
    alb = pixels(alb_im)
    irr_im = new_image('shell_irr', IRR_RES)
    set_target(mats, irr_im)
    sc.cycles.samples = samples
    _log('shell irradiance')
    do_bake(shell, 'irr', 'bake', margin=8)
    irr_s = pixels(irr_im)
    clear_targets()

    # ---------------------------------------------------------------- compose
    Es = blur(lum(irr_s[..., :3]), 2)
    valid_s = irr_s[..., 3] > 0.5
    Ea = {a: blur(lum(irr[a][..., :3]), 1) for a in 'AB'}
    valid_a = {a: irr[a][..., 3] > 0.5 for a in 'AB'}
    samples_E = np.concatenate([Es[valid_s].ravel()[::7]] + [Ea[a][valid_a[a]].ravel()[::3] for a in 'AB'])
    E_ref = float(np.percentile(samples_E, 96))
    _log('E_ref', E_ref, 'median', float(np.median(samples_E)))
    grp['bake'] = dict(E_ref=E_ref)
    # shell texture
    f = light_factor(upsample(Es, SHELL_RES // IRR_RES), E_ref)
    col = alb[..., :3] * f[..., None]
    mask = alb[..., 3] > 0.5
    col[~mask] = 0.08
    save_rgb(lin_to_srgb(col), os.path.join(OUT, 'ck_shell.jpg'), 88)
    # panel atlases
    for a in 'AB':
        src = bpy.data.images.load(os.path.join(TEX, f'ck_atlas{a}.png'), check_existing=True)
        px = pixels(src)[..., :3]
        lin = srgb_to_lin(px)
        # each atlas is normalised on its own (the overhead faces down and only gets bounce light, which the
        # realtime sky IBL cannot lift either); panels keep a higher floor than the shell
        E_a = float(np.percentile(Ea[a][valid_a[a]], 92)) if valid_a[a].any() else E_ref
        fa = np.clip(np.power(np.maximum(Ea[a], 0) / E_a, 0.5), 0.45, 1.06)
        fa = np.where(valid_a[a], fa, 0.85)
        _log('panel', a, 'E_ref', E_a)
        fa = upsample(fa, CL.ATLAS // PANEL_IRR_RES)
        save_rgb(lin_to_srgb(lin * fa[..., None]), os.path.join(OUT, f'ck_panel{a}.jpg'), 90)
        em = bpy.data.images.load(os.path.join(TEX, f'ck_emit{a}.png'), check_existing=True)
        save_rgb(pixels(em)[..., :3], os.path.join(OUT, f'ck_emit{a}.jpg'), 85)
    for o in hidden:
        o.hide_render = False
    for o in lights:
        bpy.data.objects.remove(o, do_unlink=True)
    grp['baked'] = True


# ================================================================================================ materials after baking

def finalize(grp):
    """Swap in the baked materials, merge by material, drop the helper UVs. Without a bake the painted atlases and the
    original materials are exported as they are."""
    P = geo.principled
    interior = grp['root']
    if grp.get('baked'):
        for a in 'AB':
            m = P(f'ck_panel{a}_baked', color=(1, 1, 1), roughness=0.55,
                  tex=os.path.join(OUT, f'ck_panel{a}.jpg'), emission=(1, 1, 1), emission_strength=1.0,
                  emission_tex=os.path.join(OUT, f'ck_emit{a}.jpg'))
            for o in (grp['base'][a], grp['items'][a]):
                o.data.materials.clear()
                o.data.materials.append(m)
        shell_mat = P('ck_shell_baked', color=(1, 1, 1), roughness=0.72, tex=os.path.join(OUT, 'ck_shell.jpg'))
        for o in grp['shell']:
            me = o.data
            me.materials.clear()
            me.materials.append(shell_mat)
            me.polygons.foreach_set('material_index', np.zeros(len(me.polygons), np.int32))
            for lay in [l for l in me.uv_layers if l.name != 'bake']:
                me.uv_layers.remove(lay)
            me.uv_layers['bake'].name = 'UVMap'
            me.update()
    # panels: base + items per atlas in one mesh each
    panels = []
    for a in 'AB':
        o = geo.join([grp['base'][a], grp['items'][a]], f'ck_panels{a}')
        panels.append(o)
    grp['panels'] = panels
    # shell: parts that cast shadows (glareshield, panel boxes, seats) vs the rest
    cast, rest = [], []
    for o in grp['shell']:
        (cast if (o.name.startswith('ck_seat') or 'glare' in o.name or 'bluegrey' in o.name) else rest).append(o)
    if grp.get('baked'):
        if rest:
            grp['shell_rest'] = geo.join(rest, 'ck_shell')
        if cast:
            grp['shell_cast'] = geo.join(cast, 'ck_shell_cast')
    for o in interior.children_recursive:
        if o.type == 'MESH':
            o.data.update()


def lite_sources(grp):
    """What cockpit_lite.py needs from the detailed build: the baked panel atlases (paths)."""
    baked = grp.get('baked')
    return dict(panelA=os.path.join(OUT, 'ck_panelA.jpg') if baked else os.path.join(TEX, 'ck_atlasA.png'),
                emitA=os.path.join(OUT, 'ck_emitA.jpg') if baked else os.path.join(TEX, 'ck_emitA.png'))
