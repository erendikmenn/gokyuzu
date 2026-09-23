"""Cycles renders of the F-22 (hero at golden hour, 3/4 front, rear/nozzles, planform, cockpit, thumbnail)."""
import os
import math
import bpy
from mathutils import Vector, Quaternion, Euler

import geom as G
from geom import Y
import oml as S
from util import REPO, nishita_sky, add_sun, add_camera

OUT = os.environ.get('F22_OUT') or os.path.join(REPO, 'renders', 'aircraft', 'f22')
SRC = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'src')
ZG = S.Z_GROUND


def rot_x(name, deg):
    ob = bpy.data.objects.get(name)
    if not ob:
        return
    if 'rest_q' not in ob:
        ob['rest_q'] = list(ob.rotation_quaternion)
    rest = Quaternion(ob['rest_q'])
    ob.rotation_quaternion = rest @ Quaternion((1, 0, 0), math.radians(deg))


def pose(gear=1.0, nose_doors=88, main_doors=85, nozzle_open=4.0, tvc=0.0, canopy=0.0, flaperon=0.0, lef=0.0,
         stab=0.0, rudder=0.0):
    rot_x('gear_door_nose_R', -nose_doors)
    rot_x('gear_door_nose_L', nose_doors)
    rot_x('gear_door_main_R', -main_doors)
    rot_x('gear_door_main_L', main_doors)
    for n in ('gear_nose', 'gear_main_L', 'gear_main_R'):
        rot_x(n, (1 - gear) * 92)
    for i in (1, 2):
        rot_x(f'nozzle_flap_upper_{i}', -tvc - nozzle_open)
        rot_x(f'nozzle_flap_lower_{i}', -tvc + nozzle_open)
    rot_x('canopy', canopy)
    # gear fully up: legs and wheels are stowed (hidden, as the rig does)
    for n in ('gear_nose', 'gear_nose_steer', 'wheel_nose', 'gear_main_L', 'gear_main_R', 'wheel_main_L', 'wheel_main_R'):
        ob = bpy.data.objects.get(n)
        if ob:
            ob.hide_render = gear < 0.01
    for sd in 'LR':
        rot_x(f'ctl_flaperon_{sd}', flaperon)
        rot_x(f'ctl_lef_{sd}', -lef)
        rot_x(f'ctl_stabilator_{sd}', stab)
        rot_x(f'ctl_rudder_{sd}', rudder)
    bpy.context.view_layer.update()


def render_materials(ctx):
    # canopy: gold ITO-coated acrylic (thin-film interference)
    m = bpy.data.materials.new('r_canopy')
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (0.93, 0.86, 0.66, 1)
    p.inputs['Roughness'].default_value = 0.015
    p.inputs['IOR'].default_value = 1.49
    p.inputs['Transmission Weight'].default_value = 1.0
    p.inputs['Thin Film Thickness'].default_value = 300.0
    p.inputs['Thin Film IOR'].default_value = 1.7
    p.inputs['Specular Tint'].default_value = (1.0, 0.8, 0.45, 1)
    try:
        p.inputs['Thin Wall'].default_value = True
    except Exception:
        pass
    bpy.data.objects['canopy'].data.materials[0] = m
    # displays (emissive pages)
    def emis(name, file, strength=2.2, alpha=False):
        mm = bpy.data.materials.new(name)
        mm.use_nodes = True
        nt = mm.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(os.path.join(SRC, file), check_existing=True)
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Strength'].default_value = strength
        nt.links.new(tex.outputs['Color'], em.inputs['Color'])
        if alpha:
            tr = nt.nodes.new('ShaderNodeBsdfTransparent')
            mix = nt.nodes.new('ShaderNodeMixShader')
            nt.links.new(tex.outputs['Alpha'], mix.inputs['Fac'])
            nt.links.new(tr.outputs[0], mix.inputs[1])
            nt.links.new(em.outputs[0], mix.inputs[2])
            nt.links.new(mix.outputs[0], out.inputs['Surface'])
        else:
            gl = nt.nodes.new('ShaderNodeBsdfGlossy')
            gl.inputs['Roughness'].default_value = 0.08
            add = nt.nodes.new('ShaderNodeAddShader')
            nt.links.new(em.outputs[0], add.inputs[0])
            nt.links.new(gl.outputs[0], add.inputs[1])
            nt.links.new(add.outputs[0], out.inputs['Surface'])
        return mm
    pages = {'screen_pmfd': 'disp_pmfd.png', 'screen_smfd_L': 'disp_smfd.png', 'screen_smfd_R': 'disp_pmfd.png',
             'screen_smfd_C': 'disp_smfd.png', 'screen_ufd_L': 'disp_ufd.png', 'screen_ufd_R': 'disp_ufd.png',
             'sfd_display': 'disp_sfd.png'}
    for n, f in pages.items():
        ob = bpy.data.objects.get(n)
        if ob:
            ob.data.materials[0] = emis('r_' + n, f)
    hud = bpy.data.objects.get('screen_hud')
    if hud:
        hud.data.materials[0] = emis('r_hud', 'disp_hud.png', 3.0, alpha=True)
    for o in list(bpy.data.objects):
        if o.name == 'cockpit_lite':
            o.hide_render = True
    hg = bpy.data.objects.get('hud_glass')
    if hg:
        mm = bpy.data.materials.new('r_hudglass')
        mm.use_nodes = True
        p = mm.node_tree.nodes['Principled BSDF']
        p.inputs['Base Color'].default_value = (0.8, 1.0, 0.9, 1)
        p.inputs['Transmission Weight'].default_value = 1.0
        p.inputs['Roughness'].default_value = 0.0
        p.inputs['Thin Wall'].default_value = True
        hg.data.materials[0] = mm
    # translucent materials used by the viewport/export need proper blend in cycles: none else


def concrete_material():
    m = bpy.data.materials.new('r_concrete')
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    # slab joints every 5 m (brick texture), aggregate noise, stains
    br = nt.nodes.new('ShaderNodeTexBrick')
    br.inputs['Scale'].default_value = 0.2
    br.inputs['Mortar Size'].default_value = 0.004
    br.inputs['Bias'].default_value = 0.0
    br.inputs['Brick Width'].default_value = 1.0
    br.inputs['Row Height'].default_value = 1.0
    br.offset = 0.0
    br.inputs['Color1'].default_value = (0.25, 0.245, 0.235, 1)
    br.inputs['Color2'].default_value = (0.28, 0.275, 0.26, 1)
    br.inputs['Mortar'].default_value = (0.12, 0.12, 0.12, 1)
    nt.links.new(tc.outputs['Object'], br.inputs['Vector'])
    n1 = nt.nodes.new('ShaderNodeTexNoise')
    n1.inputs['Scale'].default_value = 0.35
    n1.inputs['Detail'].default_value = 8
    nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
    n2 = nt.nodes.new('ShaderNodeTexNoise')
    n2.inputs['Scale'].default_value = 60
    n2.inputs['Detail'].default_value = 4
    nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
    mix1 = nt.nodes.new('ShaderNodeMix')
    mix1.data_type = 'RGBA'
    mix1.blend_type = 'MULTIPLY'
    mix1.inputs['Factor'].default_value = 0.55
    nt.links.new(br.outputs['Color'], mix1.inputs['A'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.55, 0.53, 0.5, 1)
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
    nt.links.new(n1.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], mix1.inputs['B'])
    mix2 = nt.nodes.new('ShaderNodeMix')
    mix2.data_type = 'RGBA'
    mix2.blend_type = 'MULTIPLY'
    mix2.inputs['Factor'].default_value = 0.25
    nt.links.new(mix1.outputs['Result'], mix2.inputs['A'])
    nt.links.new(n2.outputs['Color'], mix2.inputs['B'])
    nt.links.new(mix2.outputs['Result'], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = 0.86
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.15
    nt.links.new(n2.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    return m


def water():
    m = bpy.data.materials.new('r_water')
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (0.012, 0.03, 0.04, 1)
    p.inputs['Roughness'].default_value = 0.06
    p.inputs['IOR'].default_value = 1.33
    tc = nt.nodes.new('ShaderNodeTexCoord')
    n1 = nt.nodes.new('ShaderNodeTexNoise')
    n1.inputs['Scale'].default_value = 0.05
    n1.inputs['Detail'].default_value = 10
    n1.inputs['Roughness'].default_value = 0.6
    nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.35
    bump.inputs['Distance'].default_value = 0.4
    nt.links.new(n1.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    bpy.ops.mesh.primitive_plane_add(size=60000, location=(0, 0, -900))
    w = bpy.context.object
    w.name = 'r_water'
    w.data.materials.append(m)
    w.hide_render = True
    return w


def flight(on):
    g = bpy.data.objects.get('r_ground')
    w = bpy.data.objects.get('r_water')
    if g:
        g.hide_render = on
    if w:
        w.hide_render = not on
    if on:
        pose(gear=0.0, nose_doors=0, main_doors=0, nozzle_open=1.5)
    else:
        pose()


def ground():
    bpy.ops.mesh.primitive_plane_add(size=4000, location=(0, 0, ZG))
    g = bpy.context.object
    g.name = 'r_ground'
    g.data.materials.append(concrete_material())
    return g


def setup(samples, width, height):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    if os.environ.get('F22_DEVICE', 'GPU').upper() == 'CPU':
        sc.cycles.device = 'CPU'
        sc.render.threads_mode = 'AUTO'
    else:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 8
    sc.cycles.transmission_bounces = 8
    sc.cycles.transparent_max_bounces = 16
    sc.render.resolution_x, sc.render.resolution_y = width, height
    sc.render.resolution_percentage = int(os.environ.get('F22_PCT', '100'))
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.view_settings.exposure = -0.6
    sc.render.image_settings.file_format = 'PNG'
    return sc


def sky(elev, az, strength=1.0, sun_strength=4.0, sun_color=(1, 1, 1)):
    w = nishita_sky(elev, az, strength)
    for n in w.node_tree.nodes:
        if n.type == 'TEX_SKY':
            try:
                n.sun_disc = True
                n.sun_intensity = 0.4
                n.air_density = 1.2
                n.dust_density = 2.0
            except Exception:
                pass
    for o in [o for o in bpy.data.objects if o.type == 'LIGHT']:
        bpy.data.objects.remove(o)
    sun = add_sun(elev, az, sun_strength, 0.55)
    sun.data.color = sun_color
    return sun


def cam(loc, tgt, lens, name='rcam', shift=True):
    # camera positions are authored for the pre-wave-6 origin (Y0 = 10.10): shift with the origin
    from geom import Y0
    dy = (Y0 - 10.10) if shift else 0.0
    loc = (loc[0], loc[1] + dy, loc[2])
    tgt = (tgt[0], tgt[1] + dy, tgt[2])
    for o in [o for o in bpy.data.objects if o.type == 'CAMERA']:
        bpy.data.objects.remove(o)
    c = add_camera(loc, tgt, lens, name)
    c.data.clip_start = 0.02
    c.data.sensor_width = 36
    return c


def shoot(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('[f22] rendered', path)


def render(ctx, which='all', samples=128):
    render_materials(ctx)
    ground()
    water()
    flight(False)
    # hide the runtime-only helpers
    for n in ('formation_lights',):
        if n in bpy.data.objects:
            bpy.data.objects[n].hide_render = False
    pose()
    shots = which.split(',') if which != 'all' else ['hero', 'front', 'rear', 'planform', 'cockpit']
    # aircraft heading: nose along +Y. Sun azimuth convention (util): rotation about Z.
    if 'hero' in shots:
        setup(max(samples, 192), 2560, 1440)
        sky(16.0, 235, 0.36, 2.6, (1.0, 0.88, 0.74))
        cam((-13.8, 23.0, -1.30), (0.7, 1.4, -0.45), 48)
        shoot(os.path.join(OUT, 'hero.png'))
        make_thumb()
    if 'front' in shots:
        setup(samples, 1920, 1080)
        sky(24, 215, 0.25, 3.6)
        bpy.context.scene.view_settings.exposure = -1.0
        flight(True)
        c = cam((15.0, 18.5, 4.2), (0, 0.6, -0.2), 50)
        c.rotation_euler.rotate_axis('Z', math.radians(-11))
        shoot(os.path.join(OUT, 'front_34.png'))
        flight(False)
    if 'rear' in shots:
        setup(samples, 1920, 1080)
        sky(28, 60, 0.22, 3.2)
        pose(nozzle_open=6.0)
        cam((5.2, -19.5, -0.85), (0.1, -7.4, -0.1), 56)
        shoot(os.path.join(OUT, 'rear_nozzles.png'))
        pose()
    if 'planform' in shots:
        setup(samples, 1920, 1080)
        sky(62, 150, 0.2, 3.4)
        bpy.context.scene.view_settings.exposure = -1.1
        c = cam((0.0, 0.25, 75.0), (0.0, 0.25, 0.0), 85)
        c.rotation_euler = (0, 0, -math.pi / 2)
        shoot(os.path.join(OUT, 'planform.png'))
    if 'cockpit' in shots:
        setup(samples, 1920, 1080)
        sky(18, 35, 0.25, 3.4)
        flight(True)
        import cklayout as L
        e = Vector((L.EYE[0], Y(L.EYE[1]), L.EYE[2]))
        hidden = []
        for o in bpy.data.objects:
            p = o
            while p is not None and p.name != 'interior_lite':
                p = p.parent
            if p is not None and not o.hide_render:
                o.hide_render = True
                hidden.append(o)
        cam(tuple(e + Vector((0.0, 0.02, 0.0))), tuple(e + Vector((0.0, 1.0, -0.36))), 16, shift=False)
        shoot(os.path.join(OUT, 'cockpit.png'))
        for o in hidden:
            o.hide_render = False
        flight(False)


def make_thumb():
    try:
        img = bpy.data.images.load(os.path.join(OUT, 'hero.png'))
        img.scale(800, 450)
        img.filepath_raw = os.path.join(OUT, 'thumb.jpg')
        img.file_format = 'JPEG'
        bpy.context.scene.render.image_settings.quality = 90
        img.save()
        print('[f22] thumb written')
    except Exception as e:
        print('[f22] thumb failed', e)
