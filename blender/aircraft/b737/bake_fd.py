"""Bake ambient occlusion and soft interior light (sky through the windows) into the flight-deck colour textures.

Called from build.py after the interior is built (Cycles, GPU):
  * panel atlas: every panel face gets a proxy plane (same atlas UVs); AO / irradiance are baked "selected to active"
    from all flight-deck geometry, so knobs, switches and bezels leave contact shadows on the painted panels and the
    glareshield shades the top of the main panel. fd_base_raw.png x shade -> tex/fd_base.jpg
  * structure (flightdeck_body): a unique lightmap UV is unwrapped, its colour (from fd_swatch.png) is baked and
    multiplied with AO / irradiance -> tex/fd_body.jpg; the object is switched to the baked material `fd_body`.
Intermediate float maps are cached in tex/bake/ (never shipped).
"""
import os
import math
import numpy as np
import bpy
import bmesh

import shape as S
import mk
from mk import MeshData
import fdlayout as FL
import materials as MAT

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, 'tex')
CACHE = os.path.join(TEX, 'bake')
TB = S.to_b


def log(*a):
    print('[bake]', *a, flush=True)


# ------------------------------------------------------------------ helpers
def new_image(name, res, float_buffer=True, color=(1, 1, 1, 1)):
    im = bpy.data.images.get(name)
    if im:
        bpy.data.images.remove(im)
    im = bpy.data.images.new(name, res, res, alpha=False, float_buffer=float_buffer)
    im.colorspace_settings.name = 'Non-Color' if float_buffer else 'sRGB'
    im.generated_color = color
    return im


def img_to_np(im):
    w, h = im.size
    a = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1]          # row 0 = top


def np_to_img(im, arr):
    h, w = arr.shape[:2]
    a = np.ones((h, w, 4), np.float32)
    a[..., :arr.shape[2] if arr.ndim == 3 else 1] = arr if arr.ndim == 3 else arr[..., None]
    im.pixels.foreach_set(a[::-1].ravel())


def save_np(path, arr):
    np.save(path, arr.astype(np.float16))


def setup_cycles(samples):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for dt in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
        try:
            prefs.compute_device_type = dt
            prefs.get_devices()
            if any(d.type == dt for d in prefs.devices):
                for d in prefs.devices:
                    d.use = True
                sc.cycles.device = 'GPU'
                break
        except TypeError:
            continue
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    try:
        sc.cycles.use_adaptive_sampling = False
    except AttributeError:
        pass
    sc.cycles.max_bounces = 4
    sc.cycles.diffuse_bounces = 3
    sc.cycles.glossy_bounces = 1
    sc.cycles.transmission_bounces = 2
    sc.cycles.transparent_max_bounces = 4
    return sc


def uniform_world(strength=1.0, ao_distance=0.2):
    sc = bpy.context.scene
    w = bpy.data.worlds.get('BakeWorld') or bpy.data.worlds.new('BakeWorld')
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Color'].default_value = (1, 1, 1, 1)
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    try:
        w.light_settings.distance = ao_distance
    except AttributeError:
        pass
    sc.world = w
    return w


def bake_target(obj, image, uv_name=None):
    """Make `image` the active bake target for every material of obj."""
    for m in obj.data.materials:
        nt = m.node_tree
        n = nt.nodes.get('_bake_target')
        if n is None:
            n = nt.nodes.new('ShaderNodeTexImage')
            n.name = '_bake_target'
            n.location = (-1200, -600)
        n.image = image
        if uv_name:
            uvn = nt.nodes.get('_bake_uv') or nt.nodes.new('ShaderNodeUVMap')
            uvn.name = '_bake_uv'
            uvn.uv_map = uv_name
            nt.links.new(uvn.outputs['UV'], n.inputs['Vector'])
        for nn in nt.nodes:
            nn.select = False
        n.select = True
        nt.nodes.active = n


def remove_bake_nodes(obj):
    for m in obj.data.materials:
        for k in ('_bake_target', '_bake_uv'):
            n = m.node_tree.nodes.get(k)
            if n:
                m.node_tree.nodes.remove(n)


def select_only(objs, active):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def do_bake(kind, active, sources, margin=8, cage=0.0, ray=0.0, pass_filter=None):
    select_only(sources + [active], active)
    kw = dict(type=kind, margin=margin, use_clear=False, target='IMAGE_TEXTURES')
    if pass_filter:
        kw['pass_filter'] = pass_filter
    if sources:
        kw.update(use_selected_to_active=True, cage_extrusion=cage, max_ray_distance=ray)
    else:
        kw.update(use_selected_to_active=False)
    try:
        kw['margin_type'] = 'EXTEND'
    except Exception:
        pass
    t = bpy.context.scene.frame_current
    bpy.ops.object.bake(**kw)


# ------------------------------------------------------------------ proxies for the panel atlas
def panel_proxy(L):
    md = MeshData()
    for name, p in L.items():
        if p.nogeo:
            continue
        if name == 'tq_top':
            nx, ny = 6, 24
            xs = np.linspace(0, p.w, nx)
            ys = np.linspace(0, p.h, ny)
            for i in range(ny - 1):
                for j in range(nx - 1):
                    q = [(xs[j], ys[i]), (xs[j + 1], ys[i]), (xs[j + 1], ys[i + 1]), (xs[j], ys[i + 1])]
                    pts = [FL.tq_point(x, y, -0.001) for x, y in q]
                    md.add(np.array(pts), [[0, 1, 2, 3]], [p.uv(x, y) for x, y in q], mat=0, flat=True)
            continue
        poly = [(0, 0), (p.w, 0), (p.w, p.h), (0, p.h)]
        pts = [p.P(x, y, -0.001) for x, y in poly]
        md.add(np.array(pts), [[0, 1, 2, 3]], [p.uv(x, y) for x, y in poly], mat=0, flat=True)
    md.v = TB(md.v[:, 0], md.v[:, 1], md.v[:, 2])
    mat = bpy.data.materials.get('_bake_proxy') or MAT.principled('_bake_proxy', (0.5, 0.5, 0.5), 0.8, 0.0)
    o = mk.obj('_panel_proxy', md, [mat], smooth=False)
    return o


def panel_mask(L, res):
    """1 inside panel rectangles (the only atlas areas the proxies cover)."""
    m = np.zeros((res, res), np.float32)
    k = res / FL.ATLAS
    for p in L.values():
        if p.nogeo:
            continue
        x0, y0, x1, y1 = p.rect
        m[int(y0 * k):int(math.ceil(y1 * k)), int(x0 * k):int(math.ceil(x1 * k))] = 1.0
    return m


# ------------------------------------------------------------------ lightmap UVs for the structure
def lightmap_uv(obj, margin=0.0025):
    me = obj.data
    if 'Lightmap' in me.uv_layers:
        me.uv_layers.remove(me.uv_layers['Lightmap'])
    lm = me.uv_layers.new(name='Lightmap')
    me.uv_layers.active = lm
    select_only([obj], obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=margin, area_weight=0.0, scale_to_bounds=False)
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    except TypeError:
        bpy.ops.uv.pack_islands(margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')
    return lm


# ------------------------------------------------------------------ combine
IRR_REF = 0.55      # irradiance (uniform white sky, strength 1) that maps to full brightness


def shade_from(ao, irr, ao_pow=0.6, lo=0.56, gain=0.50):
    """Colour multiplier from ambient occlusion (short range) and irradiance (sky through the windows). Gentle on
    purpose: the game adds its own sun / sky light, the bake only supplies what three.js cannot (occlusion, the
    darker footwell and corners, contact shadows)."""
    li = np.clip(irr / IRR_REF, 0.0, 1.0) ** 0.42
    s = (np.clip(ao, 0, 1) ** ao_pow) * (lo + gain * li)
    return np.clip(s, 0.30, 1.06)


def lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def resize(arr, res):
    """Bilinear resize of a (h, w) float array to (res, res)."""
    h, w = arr.shape
    if h == res:
        return arr
    ys = (np.arange(res) + 0.5) * h / res - 0.5
    xs = (np.arange(res) + 0.5) * w / res - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, h - 1); y1 = np.clip(y0 + 1, 0, h - 1)
    x0 = np.clip(np.floor(xs).astype(int), 0, w - 1); x1 = np.clip(x0 + 1, 0, w - 1)
    fy = np.clip(ys - y0, 0, 1)[:, None]; fx = np.clip(xs - x0, 0, 1)[None, :]
    a = arr[y0][:, x0] * (1 - fx) + arr[y0][:, x1] * fx
    b = arr[y1][:, x0] * (1 - fx) + arr[y1][:, x1] * fx
    return a * (1 - fy) + b * fy


def blur(arr, r=2):
    """Separable box blur (a few passes ~ gaussian) for noisy low-frequency irradiance."""
    out = arr.copy()
    for _ in range(3):
        k = 2 * r + 1
        c = np.cumsum(np.pad(out, ((0, 0), (r + 1, r)), mode='edge'), axis=1)
        out = (c[:, k:] - c[:, :-k]) / k
        c = np.cumsum(np.pad(out, ((r + 1, r), (0, 0)), mode='edge'), axis=0)
        out = (c[k:] - c[:-k]) / k
    return out


def save_raw(im, path, fmt='JPEG', quality=90):
    """Write an image without any view transform (save_render would bake the scene's AgX/Filmic tone mapping into
    the texture): Standard view, no look, exposure 0, gamma 1."""
    sc = bpy.context.scene
    vs = sc.view_settings
    keep = (vs.view_transform, vs.look, vs.exposure, vs.gamma, getattr(vs, 'use_white_balance', False))
    vs.view_transform = 'Standard'
    vs.look = 'None'
    vs.exposure = 0.0
    vs.gamma = 1.0
    try:
        vs.use_white_balance = False
    except AttributeError:
        pass
    sc.render.image_settings.file_format = fmt
    if fmt == 'JPEG':
        sc.render.image_settings.quality = quality
    try:
        sc.render.image_settings.color_management = 'FOLLOW_SCENE'
    except (AttributeError, TypeError):
        pass
    im.save_render(path, scene=sc)
    vs.view_transform, vs.look, vs.exposure, vs.gamma = keep[:4]
    try:
        vs.use_white_balance = keep[4]
    except AttributeError:
        pass


def write_jpg(path, rgb01, quality=90):
    """rgb01: values as they should be stored (sRGB-encoded colour or raw data)."""
    im = bpy.data.images.new('_out', rgb01.shape[1], rgb01.shape[0], alpha=False)
    np_to_img(im, rgb01)
    save_raw(im, path, 'JPEG', quality)
    bpy.data.images.remove(im)


# ------------------------------------------------------------------ main entry
def bake_all(imats, res_panel=4096, res_body=4096, res_irr=2048, spp_ao=96, spp_irr=192, only=None):
    os.makedirs(CACHE, exist_ok=True)
    sc = setup_cycles(spp_ao)
    L = FL.layout()
    # objects taking part
    hide = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        if o.name in ('glass_cockpit', 'flightdeck_visors') or o.name.startswith('screen_') or o.name in ('cabin', 'cabin_lining'):
            if not o.hide_render:
                o.hide_render = True
                hide.append(o)
    fd_objs = [o for o in bpy.data.objects if o.type == 'MESH' and not o.hide_render and _under(o, 'interior')]
    occluders = fd_objs + [bpy.data.objects[n] for n in ('fuselage',) if n in bpy.data.objects]
    body = bpy.data.objects['flightdeck_body']
    # ---------------- panel atlas
    if only in (None, 'panel'):
        proxy = panel_proxy(L)
        ao_im = new_image('_ao_panel', res_panel)
        bake_target(proxy, ao_im)
        uniform_world(1.0, ao_distance=0.10)
        sc.cycles.samples = spp_ao
        log('panel AO', res_panel, spp_ao)
        do_bake('AO', proxy, occluders, cage=0.07, ray=0.14)
        ao = img_to_np(ao_im)[..., 0]
        irr_im = new_image('_irr_panel', res_irr, color=(0, 0, 0, 1))
        bake_target(proxy, irr_im)
        sc.cycles.samples = spp_irr
        log('panel irradiance', res_irr, spp_irr)
        do_bake('DIFFUSE', proxy, occluders, cage=0.07, ray=0.14, pass_filter={'DIRECT', 'INDIRECT'})
        irr = blur(img_to_np(irr_im)[..., 0], 3)
        save_np(os.path.join(CACHE, 'panel_ao.npy'), ao)
        save_np(os.path.join(CACHE, 'panel_irr.npy'), irr)
        bpy.data.objects.remove(proxy)
        combine_panel(L, ao, irr, res_panel)
    # ---------------- structure atlas
    if only in (None, 'body'):
        lightmap_uv(body)
        col_im = new_image('_col_body', res_body)
        bake_target(body, col_im, 'Lightmap')
        sc.cycles.samples = 4
        log('body colour', res_body)
        do_bake('DIFFUSE', body, [], pass_filter={'COLOR'})
        col = img_to_np(col_im)[..., :3]
        ao_im = new_image('_ao_body', res_body)
        bake_target(body, ao_im, 'Lightmap')
        sc.cycles.samples = spp_ao
        uniform_world(1.0, ao_distance=0.12)
        log('body AO', res_body, spp_ao)
        do_bake('AO', body, [])
        ao = img_to_np(ao_im)[..., 0]
        irr_im = new_image('_irr_body', res_irr, color=(0, 0, 0, 1))
        bake_target(body, irr_im, 'Lightmap')
        sc.cycles.samples = spp_irr
        log('body irradiance', res_irr, spp_irr)
        do_bake('DIFFUSE', body, [], pass_filter={'DIRECT', 'INDIRECT'})
        irr = blur(img_to_np(irr_im)[..., 0], 3)
        rough_im = new_image('_rough_body', 1024)
        bake_target(body, rough_im, 'Lightmap')
        sc.cycles.samples = 1
        log('body roughness')
        do_bake('ROUGHNESS', body, [])
        rough = img_to_np(rough_im)[..., 0]
        orm = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], -1)
        write_jpg(os.path.join(TEX, 'fd_body_orm.jpg'), orm, 90)
        remove_bake_nodes(body)
        save_np(os.path.join(CACHE, 'body_ao.npy'), ao)
        save_np(os.path.join(CACHE, 'body_irr.npy'), irr)
        save_np(os.path.join(CACHE, 'body_col.npy'), col)
        combine_body(body, imats, col, ao, irr, res_body)
    for o in hide:
        o.hide_render = False


def _under(o, name):
    p = o
    while p is not None:
        if p.name == name:
            return True
        p = p.parent
    return False


def combine_panel(L, ao, irr, res):
    """fd_base_raw.png (sRGB painted) x shade inside the panel rectangles -> fd_base.jpg."""
    raw = bpy.data.images.load(os.path.join(TEX, 'fd_base_raw.png'), check_existing=False)
    raw.colorspace_settings.name = 'Non-Color'          # keep the stored sRGB values
    base = img_to_np(raw)[..., :3]
    bpy.data.images.remove(raw)
    if base.shape[0] != res:
        base = np.stack([resize(base[..., i], res) for i in range(3)], -1)
    irr_r = resize(irr, res)
    s = shade_from(ao, irr_r)
    mask = panel_mask(L, res)
    s = s * mask + (1 - mask)
    out = srgb(lin(base) * s[..., None])
    write_jpg(os.path.join(TEX, 'fd_base.jpg'), out, 92)
    log('wrote fd_base.jpg')
    im = bpy.data.images.get('fd_base.jpg')
    for img in bpy.data.images:
        if os.path.basename(img.filepath) == 'fd_base.jpg':
            img.reload()


def combine_body(body, imats, col, ao, irr, res):
    irr_r = resize(irr, res)
    s = shade_from(ao, irr_r)
    out = srgb(col * s[..., None])
    path = os.path.join(TEX, 'fd_body.jpg')
    write_jpg(path, out, 90)
    log('wrote fd_body.jpg')
    apply_body_material(body, imats)


def apply_body_material(body, imats):
    """Switch the structure to the baked atlas on the lightmap UV (becomes the only UV map)."""
    me = body.data
    if 'Lightmap' in me.uv_layers:
        old = me.uv_layers.get('UVMap')
        if old:
            me.uv_layers.remove(old)
        me.uv_layers['Lightmap'].name = 'UVMap'
    mat = bpy.data.materials.get('fd_body')
    if mat is None:
        mat = MAT.principled('fd_body', (0.5, 0.5, 0.5), 0.66, 0.0, base='fd_body', orm='fd_body_orm', double=True)
    else:
        for n in mat.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                n.image.reload()
    me.materials.clear()
    me.materials.append(mat)
    imats['body'] = mat
