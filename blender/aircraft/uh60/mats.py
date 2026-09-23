"""Materials (glTF-compatible Principled BSDF) for the UH-60 build."""
import bpy


def srgb(h):
    """'#rrggbb' -> linear RGBA."""
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (*lin, 1.0)


def principled(name, color='#808080', rough=0.5, metal=0.0, emit=None, emit_strength=1.0, alpha=None,
               blend=None, spec=0.5, coat=0.0):
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = srgb(color) if isinstance(color, str) else color
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    try:
        b.inputs['Specular IOR Level'].default_value = spec
    except KeyError:
        pass
    if coat:
        b.inputs['Coat Weight'].default_value = coat
    if emit is not None:
        b.inputs['Emission Color'].default_value = srgb(emit) if isinstance(emit, str) else emit
        b.inputs['Emission Strength'].default_value = emit_strength
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED' if blend != 'CLIP' else 'DITHERED'
        except AttributeError:
            pass
        m.blend_method = 'BLEND' if blend != 'CLIP' else 'CLIP'
    m.diffuse_color = srgb(color) if isinstance(color, str) else color
    return m


ARMY_GREEN = '#3b4034'     # FS 34031-ish lusterless helo drab (sRGB)


def make_materials(textured=False):
    M = {}
    M['hull'] = principled('hull', ARMY_GREEN, rough=0.62)
    M['paint'] = principled('paint', ARMY_GREEN, rough=0.6)
    M['paint_dark'] = principled('paint_dark', '#2e322a', rough=0.62)
    M['metal'] = principled('metal', '#55585a', rough=0.48, metal=0.85)
    M['metal_dark'] = principled('metal_dark', '#3a3c3e', rough=0.45, metal=0.85)
    M['titanium'] = principled('titanium', '#626463', rough=0.42, metal=0.8)
    M['chrome'] = principled('chrome', '#d8dadc', rough=0.08, metal=1.0)
    M['rubber'] = principled('rubber', '#141414', rough=0.85)
    M['black'] = principled('black', '#0c0c0c', rough=0.6)
    M['soot'] = principled('soot', '#101010', rough=0.9)
    M['blade'] = principled('blade', '#2f312e', rough=0.55)
    M['blade_tip'] = principled('blade_tip', '#6b6d6a', rough=0.35, metal=0.9)
    M['glass'] = principled('glass', '#5d6a66', rough=0.04, alpha=0.22, spec=0.6)
    M['light_red'] = principled('light_red', '#ff2a1a', rough=0.2, emit='#ff2010', emit_strength=4.0)
    M['light_green'] = principled('light_green', '#20ff50', rough=0.2, emit='#10ff40', emit_strength=4.0)
    M['light_white'] = principled('light_white', '#ffffff', rough=0.2, emit='#fff6e8', emit_strength=4.0)
    M['lens'] = principled('lens', '#e8eef0', rough=0.05, alpha=0.35)
    M['blade_le'] = principled('blade_le', '#7a7c7a', rough=0.3, metal=0.9)
    M['blur_main'] = principled('blur_main', '#26282a', rough=0.6, alpha=0.12)
    M['blur_tail'] = principled('blur_tail', '#26282a', rough=0.6, alpha=0.15)
    M['int_wall'] = principled('int_wall', '#4a4f47', rough=0.8)
    M['rim'] = principled('rim', '#2a2d28', rough=0.7)
    # interior
    M['int_grey'] = principled('int_grey', '#34373a', rough=0.6)
    M['int_black'] = principled('int_black', '#151617', rough=0.6)
    M['int_glare'] = principled('int_glare', '#101111', rough=0.95, spec=0.2)
    M['int_panel'] = principled('int_panel', '#2e3134', rough=0.55)
    M['int_bezel'] = principled('int_bezel', '#1a1b1d', rough=0.45)
    M['int_console'] = principled('int_console', '#2a2d30', rough=0.55)
    M['screen'] = principled('screen', '#040506', rough=0.12, emit='#000000', emit_strength=1.0)
    M['int_knob'] = principled('int_knob', '#1b1b1c', rough=0.4)
    M['int_metal'] = principled('int_metal', '#8a8c8e', rough=0.35, metal=0.85)
    M['int_red'] = principled('int_red', '#b01c14', rough=0.45)
    M['int_floor_cp'] = principled('int_floor_cp', '#2c2e30', rough=0.85)
    M['int_rubber'] = principled('int_rubber', '#111111', rough=0.9)
    M['int_seatframe'] = principled('int_seatframe', '#474c43', rough=0.55)
    M['int_cushion'] = principled('int_cushion', '#1d1f1e', rough=0.9)
    M['int_armor'] = principled('int_armor', '#575b49', rough=0.6)
    M['int_strap'] = principled('int_strap', '#4b4935', rough=0.9)
    M['int_floor'] = principled('int_floor', '#46484a', rough=0.85)
    M['int_quilt'] = principled('int_quilt', '#6f6b57', rough=0.92)
    M['int_canvas'] = principled('int_canvas', '#55553f', rough=0.92)
    M['int_tube'] = principled('int_tube', '#a3a5a7', rough=0.4, metal=0.9)
    M['int_lamp'] = principled('int_lamp', '#ffffff', rough=0.3, emit='#fff2dc', emit_strength=0.6)
    M['int_cockpit'] = principled('int_cockpit', '#2d3032', rough=0.7)
    M['int_kit'] = principled('int_kit', '#4a4d38', rough=0.9)
    return M


SINGLE_SIDED = ('hull', 'paint', 'paint_dark', 'metal', 'titanium', 'chrome', 'black', 'soot', 'blade', 'blade_le',
                'rim', 'int_wall', 'int_cockpit', 'int_quilt')


def set_culling(M):
    """Closed meshes export single-sided (less overdraw, no double-sided shadow acne); thin/open parts stay double-sided."""
    for k in SINGLE_SIDED:
        if k in M:
            M[k].use_backface_culling = True


def texture_interior(M, texdir):
    import os
    j = lambda n: os.path.join(texdir, n)
    textured_material(M['int_panel'], j('int_panel.jpg'))
    textured_material(M['int_bezel'], j('int_bezel.jpg'))
    textured_material(M['int_console'], j('int_console.jpg'))
    textured_material(M['int_floor'], j('int_floor.jpg'))
    textured_material(M['int_quilt'], j('int_quilt.jpg'), normal=j('int_quilt_nrm.jpg'))
    textured_material(M['blade'], j('blade.jpg'))
    textured_material(M['screen'], j('screen_off.jpg'))


def gltf_output_group():
    """Node group recognised by the Blender glTF exporter for the occlusion texture."""
    g = bpy.data.node_groups.get('glTF Material Output')
    if g is not None:
        return g
    g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    try:
        g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    except AttributeError:
        g.inputs.new('NodeSocketFloat', 'Occlusion')
    return g


def load_image(path, non_color=False):
    img = bpy.data.images.load(path, check_existing=True)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def textured_material(mat, base=None, orm=None, normal=None, normal_strength=1.0, use_ao=True, emit=None):
    """Rebuild 'mat' as Principled + image textures (glTF-exportable)."""
    nt = mat.node_tree
    b = nt.nodes.get('Principled BSDF')
    uv = nt.nodes.new('ShaderNodeUVMap')
    if base:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = load_image(base)
        nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if orm:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = load_image(orm, True)
        nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(t.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
        if use_ao:
            grp = nt.nodes.new('ShaderNodeGroup')
            grp.node_tree = gltf_output_group()
            nt.links.new(sep.outputs['Red'], grp.inputs['Occlusion'])
    if normal:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = load_image(normal, True)
        nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if emit:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = load_image(emit)
        nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
        nt.links.new(t.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = 1.0
    return mat
