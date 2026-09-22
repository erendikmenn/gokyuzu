"""Shared Blender helpers (lead-owned). Use from any Blender script:

    import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'common'))  # adjust depth
    from util import *

Conventions (see CONTRACTS-SF.md §5): meters; aircraft nose → +Y, up → +Z, right wing → +X; object names = glTF node names.
"""
import os
import math
import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    return sc


def setup_cycles(samples=128, gpu=True, denoise=True, width=1920, height=1080, transparent=False):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    if gpu:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = denoise
    sc.render.resolution_x, sc.render.resolution_y = width, height
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = transparent
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.render.image_settings.file_format = 'PNG'
    return sc


def nishita_sky(sun_elevation_deg=35.0, sun_rotation_deg=160.0, strength=1.0, altitude=0.0):
    """Physical sky world (Nishita) — realistic daylight for renders."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('Sky')
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    sky = nt.nodes.new('ShaderNodeTexSky')
    for t in ('NISHITA', 'SINGLE_SCATTERING', 'MULTIPLE_SCATTERING'):
        try:
            sky.sky_type = t
            break
        except TypeError:
            continue
    try:
        sky.sun_elevation = math.radians(sun_elevation_deg)
        sky.sun_rotation = math.radians(sun_rotation_deg)
        sky.altitude = altitude
    except AttributeError:
        pass
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    return world


def add_sun(elevation_deg=35.0, azimuth_deg=160.0, strength=4.0, angle_deg=0.53):
    light = bpy.data.lights.new('Sun', 'SUN')
    light.energy = strength
    light.angle = math.radians(angle_deg)
    obj = bpy.data.objects.new('Sun', light)
    bpy.context.scene.collection.objects.link(obj)
    obj.rotation_euler = (math.radians(90 - elevation_deg), 0, math.radians(azimuth_deg))
    return obj


def studio_lighting():
    """Soft three-point studio setup + neutral world, for turntable/product renders."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('Studio')
    sc.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.62, 0.66, 0.72, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
    for name, loc, energy, size in (('Key', (8, -8, 9), 3000, 6), ('Fill', (-9, -4, 5), 1200, 8), ('Rim', (0, 10, 7), 2000, 5)):
        l = bpy.data.lights.new(name, 'AREA')
        l.energy = energy
        l.size = size
        o = bpy.data.objects.new(name, l)
        sc.collection.objects.link(o)
        o.location = loc
        direction = -o.location.normalized()
        o.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


def add_camera(location, look_at, lens=50.0, name='Camera'):
    from mathutils import Vector
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_end = 100000
    obj = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    d = Vector(look_at) - Vector(location)
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = obj
    return obj


def render_still(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.context.scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    return path


def export_glb(path, objects=None, draco=True, image_format='AUTO', extras=True):
    """Export to GLB (+Y up). objects=None exports every visible object in the scene."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if objects is not None:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:
            o.select_set(True)
    kwargs = dict(
        filepath=os.path.abspath(path), export_format='GLB', use_selection=objects is not None,
        export_yup=True, export_apply=True, export_texcoords=True, export_normals=True,
        export_materials='EXPORT', export_image_format=image_format, export_extras=extras,
        export_cameras=False, export_lights=False, export_animations=False,
    )
    if draco:
        kwargs.update(export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                      export_draco_position_quantization=16, export_draco_normal_quantization=12,
                      export_draco_texcoord_quantization=14)
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        # option names differ between Blender versions: fall back to the safe subset
        for k in ('export_draco_position_quantization', 'export_draco_normal_quantization', 'export_draco_texcoord_quantization', 'export_extras'):
            kwargs.pop(k, None)
        bpy.ops.export_scene.gltf(**kwargs)
    return path
