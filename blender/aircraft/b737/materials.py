"""Materials for the 737 (glTF-compatible Principled BSDF: constants and/or image textures)."""
import os
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, 'tex')


def _img(name, colorspace='sRGB'):
    for ext in ('.jpg', '.png'):
        p = os.path.join(TEX, name + ext)
        if os.path.exists(p):
            im = bpy.data.images.load(p, check_existing=True)
            im.colorspace_settings.name = colorspace
            return im
    return None


def principled(name, color=(0.8, 0.8, 0.8), rough=0.5, metal=0.0, base=None, orm=None, normal=None,
               emission=None, emission_strength=1.0, alpha=None, blend=None, double=False, normal_strength=1.0,
               emission_tex=None, coat=0.0, ior=1.5, transmission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    out = nt.nodes.get('Material Output')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['IOR'].default_value = ior
    if coat > 0:
        bsdf.inputs['Coat Weight'].default_value = coat
        bsdf.inputs['Coat Roughness'].default_value = 0.08
    if transmission > 0:
        bsdf.inputs['Transmission Weight'].default_value = transmission
    uv = None
    if base or orm or normal or emission_tex:
        uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'; uv.location = (-900, 0)
    if base:
        im = _img(base)
        if im:
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = im; t.location = (-500, 250)
            t.interpolation = 'Cubic' if False else 'Linear'
            nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
            nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if orm:
        im = _img(orm, 'Non-Color')
        if im:
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = im; t.location = (-500, -50)
            nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
            sep = nt.nodes.new('ShaderNodeSeparateColor'); sep.location = (-250, -50)
            nt.links.new(t.outputs['Color'], sep.inputs['Color'])
            nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
            nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    if normal:
        im = _img(normal, 'Non-Color')
        if im:
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = im; t.location = (-500, -350)
            nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
            nm = nt.nodes.new('ShaderNodeNormalMap'); nm.location = (-250, -350)
            nm.inputs['Strength'].default_value = normal_strength
            nt.links.new(t.outputs['Color'], nm.inputs['Color'])
            nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    if emission_tex:
        im = _img(emission_tex)
        if im:
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = im; t.location = (-500, 500)
            nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
            nt.links.new(t.outputs['Color'], bsdf.inputs['Emission Color'])
            bsdf.inputs['Emission Strength'].default_value = emission_strength
    if alpha is not None:
        bsdf.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
        m.blend_method = 'BLEND' if hasattr(m, 'blend_method') else None
    m.use_backface_culling = not double
    return m


def create(textured=True):
    T = textured
    M = {}
    M['fuselage'] = principled('fuselage', (0.9, 0.9, 0.9), 0.32, 0.0,
                               base='fus_base' if T else None, orm='fus_orm' if T else None,
                               normal='fus_nrm' if T else None, coat=0.12)
    M['wing'] = principled('wing', (0.62, 0.64, 0.66), 0.38, 0.15,
                           base='wing_base' if T else None, orm='wing_orm' if T else None,
                           normal='wing_nrm' if T else None)
    M['tail'] = principled('tail', (0.05, 0.12, 0.3), 0.3, 0.0,
                           base='tail_base' if T else None, orm='tail_orm' if T else None,
                           normal='tail_nrm' if T else None, coat=0.12)
    M['stab'] = principled('stab', (0.62, 0.64, 0.66), 0.38, 0.1,
                           base='stab_base' if T else None, orm='stab_orm' if T else None,
                           normal='stab_nrm' if T else None)
    M['nacelle'] = principled('nacelle', (0.05, 0.12, 0.3), 0.3, 0.0,
                              base='nac_base' if T else None, orm='nac_orm' if T else None,
                              normal='nac_nrm' if T else None, coat=0.25)
    M['core'] = principled('core_cowl', (0.50, 0.51, 0.52), 0.42, 0.5)
    M['pylon'] = principled('pylon', (0.80, 0.81, 0.82), 0.38, 0.05, base='pylon_base' if T else None)
    M['fuselage_plain'] = principled('belly_paint', (0.62, 0.64, 0.66), 0.35, 0.0)
    M['structure'] = principled('structure', (0.32, 0.34, 0.36), 0.6, 0.3)
    M['metal'] = principled('metal_bare', (0.78, 0.79, 0.8), 0.22, 1.0)
    M['metal_dark'] = principled('metal_dark', (0.18, 0.18, 0.19), 0.45, 0.8, double=True)
    M['exhaust'] = principled('exhaust', (0.07, 0.065, 0.06), 0.55, 0.6, double=True)
    M['fan'] = principled('fan', (0.45, 0.46, 0.48), 0.3, 0.9, double=True)
    M['spinner'] = principled('spinner', (0.6, 0.6, 0.62), 0.3, 0.6, base='spinner_base' if T else None)
    M['glass'] = principled('glass_cockpit', (0.02, 0.025, 0.03), 0.04, 0.0, alpha=0.35, coat=0.0)
    M['frame'] = principled('frame_dark', (0.03, 0.03, 0.035), 0.6, 0.0, double=True)
    M['gear'] = principled('gear_paint', (0.72, 0.73, 0.74), 0.4, 0.2)
    M['chrome'] = principled('gear_chrome', (0.9, 0.9, 0.92), 0.12, 1.0)
    M['tire'] = principled('tire', (0.035, 0.035, 0.037), 0.82, 0.0, base='tire_base' if T else None)
    M['hub'] = principled('hub', (0.62, 0.63, 0.64), 0.35, 0.7, base='hub_base' if T else None)
    M['well'] = principled('wheel_well', (0.3, 0.31, 0.3), 0.7, 0.2, double=True)
    M['black'] = principled('black', (0.02, 0.02, 0.02), 0.6, 0.0)
    M['lens_red'] = principled('lens_red', (0.6, 0.02, 0.02), 0.1, 0.0, emission=(1, 0.05, 0.03), emission_strength=0.0)
    M['lens_green'] = principled('lens_green', (0.02, 0.5, 0.1), 0.1, 0.0, emission=(0.1, 1, 0.3), emission_strength=0.0)
    M['lens_clear'] = principled('lens_clear', (0.8, 0.82, 0.85), 0.05, 0.0, emission=(1, 1, 1), emission_strength=0.0)
    M['lens_beacon'] = principled('lens_beacon', (0.5, 0.02, 0.02), 0.1, 0.0, emission=(1, 0.05, 0.03), emission_strength=0.0)
    M['antenna'] = principled('antenna', (0.85, 0.86, 0.87), 0.4, 0.0)
    return M
