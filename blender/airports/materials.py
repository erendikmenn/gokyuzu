"""Material library for the airport buildings (glTF-compatible Principled BSDF + image textures).

Textures come from tools/geo/airports_facades.py (assets/sf/airports/tex/). Tile sizes (m) are in facades.json.
Night: materials with an emissive map (*_e.jpg) or 'glass'/'lamp' in the name are driven by the runtime.
"""
import os, json
import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TEX = os.path.join(REPO, 'assets', 'sf', 'airports', 'tex')
TILES = json.load(open(os.path.join(TEX, 'facades.json')))

# name: (texture | None, emissive texture | None, base colour (linear), roughness, metallic, emission colour for constants)
DEFS = {
    'fac_glass': ('fac_glass.jpg', 'fac_glass_e.jpg', None, 0.12, 0.25),
    'fac_terminal': ('fac_terminal.jpg', 'fac_terminal_e.jpg', None, 0.32, 0.35),
    'fac_office': ('fac_office.jpg', 'fac_office_e.jpg', None, 0.8, 0.0),
    'fac_hangar': ('fac_hangar.jpg', None, None, 0.45, 0.55),
    'fac_hangar_door': ('fac_hangar_door.jpg', None, None, 0.45, 0.55),
    'fac_garage': ('fac_garage.jpg', 'fac_garage_e.jpg', None, 0.9, 0.0),
    'fac_industrial': ('fac_industrial.jpg', None, None, 0.85, 0.0),
    'fac_cargo': ('fac_cargo.jpg', None, None, 0.8, 0.1),
    'roof_membrane': ('roof_membrane.jpg', None, None, 0.85, 0.0),
    'roof_gravel': ('roof_gravel.jpg', None, None, 0.95, 0.0),
    'roof_metal': ('roof_metal.jpg', None, None, 0.45, 0.6),
    'fac_mil_concrete': ('fac_mil_concrete.jpg', None, None, 0.92, 0.0),
    'fac_mil_stucco': ('fac_mil_stucco.jpg', 'fac_mil_stucco_e.jpg', None, 0.85, 0.0),
    'fac_mil_hangar': ('fac_mil_hangar.jpg', None, None, 0.5, 0.45),
    'tower_shaft': ('tower_shaft.jpg', None, None, 0.6, 0.0),
    'fac_jetbridge': ('fac_jetbridge.jpg', None, None, 0.4, 0.5),
    # constants
    'glass_dark': (None, None, (0.035, 0.05, 0.065), 0.06, 0.6),
    'glass_cab': (None, None, (0.05, 0.09, 0.1), 0.04, 0.5),
    'metal_white': (None, None, (0.72, 0.73, 0.74), 0.35, 0.6),
    'metal_grey': (None, None, (0.32, 0.33, 0.34), 0.45, 0.7),
    'steel_dark': (None, None, (0.06, 0.065, 0.07), 0.5, 0.6),
    'concrete': (None, None, (0.42, 0.41, 0.38), 0.9, 0.0),
    'concrete_dark': (None, None, (0.12, 0.12, 0.115), 0.95, 0.0),
    'paint_white': (None, None, (0.8, 0.8, 0.78), 0.5, 0.0),
    'paint_red': (None, None, (0.55, 0.035, 0.03), 0.45, 0.1),
    'paint_yellow': (None, None, (0.8, 0.55, 0.03), 0.5, 0.0),
    'paint_black': (None, None, (0.02, 0.02, 0.02), 0.6, 0.0),
    'rubber': (None, None, (0.02, 0.02, 0.02), 0.85, 0.0),
    'earth': (None, None, (0.13, 0.15, 0.07), 1.0, 0.0),
    'tank_paint': (None, None, (0.46, 0.47, 0.42), 0.55, 0.2),
    'mil_green': (None, None, (0.12, 0.15, 0.09), 0.8, 0.1),
    'mil_tan': (None, None, (0.42, 0.36, 0.25), 0.85, 0.0),
    'roof_tile': (None, None, (0.36, 0.1, 0.05), 0.75, 0.0),
    'lamp_warm': (None, None, (1.0, 0.9, 0.7), 0.4, 0.0),
    'flag_red': (None, None, (0.6, 0.02, 0.02), 0.8, 0.0),
    'flag_tr': ('flag_tr.png', None, None, 0.8, 0.0),
    'paint_navy': (None, None, (0.02, 0.03, 0.07), 0.6, 0.0),
    'sign_white': (None, None, (0.85, 0.85, 0.85), 0.5, 0.0),
}

_cache = {}


def get(name):
    if name in _cache:
        return _cache[name]
    tex, emis, col, rough, metal = DEFS[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if tex:
        img = bpy.data.images.load(os.path.join(TEX, tex), check_existing=True)
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img
        n.interpolation = 'Linear'
        nt.links.new(n.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = (*col, 1.0)
    if emis:
        img = bpy.data.images.load(os.path.join(TEX, emis), check_existing=True)
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img
        nt.links.new(n.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    elif name in ('glass_cab', 'lamp_warm'):
        bsdf.inputs['Emission Color'].default_value = (0.9, 0.85, 0.7, 1.0) if name == 'lamp_warm' else (0.35, 0.45, 0.4, 1.0)
        bsdf.inputs['Emission Strength'].default_value = 1.0
    _cache[name] = m
    return m


def tile(name):
    return TILES.get(name, (8.0, 8.0))
