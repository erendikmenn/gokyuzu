"""Cycles render scenes for the F-16 (flight line at golden hour, rear afterburner, planform, cockpit)."""
import math
import os
import bpy
from mathutils import Vector, Matrix
import util
from f16_geom import CG_S, CG_Z, bl


def node(nt, kind, loc=(0, 0), **inputs):
    n = nt.nodes.new(kind)
    n.location = loc
    for k, v in inputs.items():
        kk = k.replace('_', ' ')
        if kk in n.inputs:
            n.inputs[kk].default_value = v
        elif k in n.inputs:
            n.inputs[k].default_value = v
        else:
            setattr(n, k, v)
    return n


def concrete_material():
    m = bpy.data.materials.new('flightline_concrete')
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = N.get('Principled BSDF')
    tc = node(nt, 'ShaderNodeTexCoord', (-1400, 0))
    mp = node(nt, 'ShaderNodeMapping', (-1200, 0))
    L.new(tc.outputs['Object'], mp.inputs['Vector'])
    # large-scale stains
    n1 = node(nt, 'ShaderNodeTexNoise', (-900, 300), Scale=0.08, Detail=8.0, Roughness=0.6)
    n2 = node(nt, 'ShaderNodeTexNoise', (-900, 0), Scale=2.5, Detail=12.0, Roughness=0.7)
    n3 = node(nt, 'ShaderNodeTexNoise', (-900, -300), Scale=40.0, Detail=4.0)
    for n in (n1, n2, n3):
        L.new(mp.outputs['Vector'], n.inputs['Vector'])
    # slab joints: 5 m grid via a brick texture
    br = node(nt, 'ShaderNodeTexBrick', (-900, -600), Scale=0.2, Mortar_Size=0.0025, Bias=0.0)
    try:
        br.offset = 0.0
        br.inputs['Brick Width'].default_value = 1.0
        br.inputs['Row Height'].default_value = 1.0
        br.inputs['Mortar Smooth'].default_value = 0.3
    except Exception:
        pass
    br.inputs['Color1'].default_value = (1, 1, 1, 1)
    br.inputs['Color2'].default_value = (1, 1, 1, 1)
    br.inputs['Mortar'].default_value = (0.35, 0.35, 0.35, 1)
    L.new(mp.outputs['Vector'], br.inputs['Vector'])
    cr = node(nt, 'ShaderNodeValToRGB', (-600, 300))
    cr.color_ramp.elements[0].color = (0.30, 0.29, 0.27, 1)
    cr.color_ramp.elements[1].color = (0.46, 0.45, 0.43, 1)
    L.new(n1.outputs['Fac'], cr.inputs['Fac'])
    mix = node(nt, 'ShaderNodeMix', (-350, 200))
    mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 0.35
    L.new(cr.outputs['Color'], mix.inputs[6])
    L.new(n2.outputs['Color'], mix.inputs[7])
    mix2 = node(nt, 'ShaderNodeMix', (-150, 200))
    mix2.data_type = 'RGBA'; mix2.blend_type = 'MULTIPLY'
    mix2.inputs['Factor'].default_value = 1.0
    L.new(mix.outputs[2], mix2.inputs[6])
    L.new(br.outputs['Color'], mix2.inputs[7])
    L.new(mix2.outputs[2], bsdf.inputs['Base Color'])
    rr = node(nt, 'ShaderNodeMapRange', (-350, -200))
    rr.inputs['To Min'].default_value = 0.75; rr.inputs['To Max'].default_value = 0.95
    L.new(n3.outputs['Fac'], rr.inputs['Value'])
    L.new(rr.outputs['Result'], bsdf.inputs['Roughness'])
    bump = node(nt, 'ShaderNodeBump', (-150, -400), Strength=0.25, Distance=0.02)
    L.new(n3.outputs['Fac'], bump.inputs['Height'])
    L.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def paint_line_material(color):
    m = bpy.data.materials.new('line_paint')
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = 0.7
    return m


def flight_line(size=400):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, -CG_Z))
    g = bpy.context.active_object
    g.name = 'ground'
    g.data.materials.append(concrete_material())
    # yellow taxi line + parking T
    ym = paint_line_material((0.75, 0.52, 0.05))
    for loc, sc in (((0.0, 20.0, -CG_Z + 0.004), (0.08, 60, 1)), ((0.0, 10.2, -CG_Z + 0.004), (3.0, 0.08, 1))):
        bpy.ops.mesh.primitive_plane_add(size=1, location=loc)
        o = bpy.context.active_object
        o.scale = sc
        o.data.materials.append(ym)
    return g


def aircraft_collection():
    coll = bpy.data.collections.get('F16C')
    if coll is None:
        coll = bpy.data.collections.new('F16C')
        for o in list(bpy.context.scene.collection.objects):
            if o.type in ('MESH', 'EMPTY') and not o.name.startswith(('ground', 'ab_', 'chock', 'Plane', 'Cube', 'hill', 'hangar')):
                coll.objects.link(o)
    return coll


def context_props():
    """Two more jets on the flight line (collection instances), hangars and hazy hills far away."""
    coll = aircraft_collection()
    for i, (x, y) in enumerate(((17.0, -2.0), (34.0, -4.0))):
        e = bpy.data.objects.new(f'f16_row_{i}', None)
        e.instance_type = 'COLLECTION'
        e.instance_collection = coll
        e.location = (x, y, 0)
        bpy.context.scene.collection.objects.link(e)
    hm = bpy.data.materials.new('hangar')
    hm.use_nodes = True
    b = hm.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (0.32, 0.34, 0.33, 1)
    b.inputs['Roughness'].default_value = 0.6
    b.inputs['Metallic'].default_value = 0.4
    for i in range(4):
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=22, depth=60, location=(-90 + i * 62, -230, -CG_Z))
        o = bpy.context.active_object
        o.name = f'hangar_{i}'
        o.rotation_euler = (math.radians(90), 0, 0)
        o.scale = (1.0, 0.55, 1.0)
        o.data.materials.append(hm)


def chocks_and_props():
    """Wheel chocks and a crew ladder for context."""
    mat = paint_line_material((0.55, 0.40, 0.05))
    for x, y in ((1.18, -0.513 - 0.45), (1.18, -0.513 + 0.45), (-1.18, -0.513 - 0.45), (-1.18, -0.513 + 0.45),
                 (0.0, 3.48 - 0.33), (0.0, 3.48 + 0.33)):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, -CG_Z + 0.07))
        o = bpy.context.active_object
        o.scale = (0.28, 0.16, 0.14)
        o.data.materials.append(mat)


def sky(sun_elev, sun_az, strength=1.0, sun_strength=4.0, warm=0.0, sky_rot=None):
    w = util.nishita_sky(sun_elevation_deg=sun_elev, sun_rotation_deg=(sun_az + SKY_ROT_OFF) if sky_rot is None else sky_rot, strength=strength * SKY_SCALE)
    for n in w.node_tree.nodes:
        if n.type == 'TEX_SKY':
            try:
                n.sun_disc = False
            except Exception:
                pass
    # the Nishita sky includes the sun disc; add a sun lamp for crisp shadows
    s = util.add_sun(elevation_deg=sun_elev, azimuth_deg=sun_az, strength=sun_strength, angle_deg=0.6)
    s.data.color = (1.0, 1.0 - 0.25 * warm, 1.0 - 0.48 * warm)
    return s


SKY_SCALE = 0.22
SKY_ROT_OFF = 0.0
HERO_AZ = 240
PCT = 100


def solidify_glass():
    o = bpy.data.objects.get('canopy')
    if o and not any(m.type == 'SOLIDIFY' for m in o.modifiers):
        m = o.modifiers.new('glass_thick', 'SOLIDIFY')
        m.thickness = 0.008
        m.offset = -1


def ab_flame(strength=1.0, L=4.2, r0=0.46, r1=0.20):
    """Volumetric afterburner plume: emission volume in a cone, radial/axial falloff + periodic shock diamonds."""
    nz = bpy.data.objects.get('nozzle_1')
    base = nz.matrix_world.translation.copy() if nz else Vector(bl((14.57, 0, 1.885)))
    bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=r0, radius2=r1, depth=L, end_fill_type='NGON')
    o = bpy.context.active_object
    o.name = 'ab_plume'
    o.rotation_euler = (math.radians(90), 0, 0)
    o.location = base + Vector((0, -L / 2 + 0.02, 0))
    m = bpy.data.materials.new('ab_plume')
    m.use_nodes = True
    nt = m.node_tree
    N, Lk = nt.nodes, nt.links
    N.clear()
    out = N.new('ShaderNodeOutputMaterial')
    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ')
    Lk.new(tc.outputs['Generated'], sep.inputs['Vector'])

    def math_node(op, a, b=None, val=None):
        n = N.new('ShaderNodeMath'); n.operation = op
        for i, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                n.inputs[i].default_value = x
            else:
                Lk.new(x, n.inputs[i])
        return n.outputs[0]
    x, y, z = sep.outputs['X'], sep.outputs['Y'], sep.outputs['Z']
    # generated z: 0 at radius1 end (nozzle, local -Z) .. 1 at the tail
    rx = math_node('SUBTRACT', x, 0.5); ry = math_node('SUBTRACT', y, 0.5)
    r2 = math_node('ADD', math_node('MULTIPLY', rx, rx), math_node('MULTIPLY', ry, ry))
    r = math_node('MULTIPLY', math_node('SQRT', r2), 2.0)
    rf = math_node('ADD', math_node('MULTIPLY', z, (r1 / r0) - 1.0), 1.0)          # local radius fraction
    rn = math_node('DIVIDE', r, rf)
    core = math_node('EXPONENT', math_node('MULTIPLY', math_node('MULTIPLY', rn, rn), -3.5))
    tail = math_node('POWER', math_node('SUBTRACT', 1.0, z), 1.6)
    body = math_node('MULTIPLY', core, tail)
    # shock diamonds: periodic along the axis (0.55 m spacing), tight on the axis, fading with distance
    zz = math_node('MULTIPLY', z, L)
    ph = math_node('COSINE', math_node('MULTIPLY', math_node('SUBTRACT', zz, 0.38), 2 * math.pi / 0.55))
    dia = math_node('POWER', math_node('ADD', math_node('MULTIPLY', ph, 0.5), 0.5), 10.0)
    dia = math_node('MULTIPLY', dia, math_node('EXPONENT', math_node('MULTIPLY', math_node('MULTIPLY', rn, rn), -14.0)))
    dia = math_node('MULTIPLY', dia, math_node('POWER', math_node('SUBTRACT', 1.0, math_node('MINIMUM', math_node('MULTIPLY', zz, 1 / 3.0), 1.0)), 1.2))
    em_str = math_node('ADD', math_node('MULTIPLY', body, 5.0 * strength), math_node('MULTIPLY', dia, 45.0 * strength))
    # colour: pale yellow core near the nozzle -> orange -> deep orange tail
    ramp = N.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (1.0, 0.36, 0.08, 1)
    ramp.color_ramp.elements[1].color = (1.0, 0.86, 0.62, 1)
    Lk.new(math_node('MULTIPLY', core, math_node('SUBTRACT', 1.0, z)), ramp.inputs['Fac'])
    em = N.new('ShaderNodeEmission')
    Lk.new(ramp.outputs['Color'], em.inputs['Color'])
    Lk.new(em_str, em.inputs['Strength'])
    Lk.new(em.outputs[0], out.inputs['Volume'])
    o.data.materials.append(m)
    o.visible_shadow = False
    # glow inside the nozzle + light on the surroundings
    bpy.ops.mesh.primitive_circle_add(vertices=48, radius=0.42, fill_type='NGON', location=base + Vector((0, 0.35, 0)))
    g = bpy.context.active_object
    g.name = 'ab_glow'
    g.rotation_euler = (math.radians(90), 0, 0)
    gm = bpy.data.materials.new('ab_glow')
    gm.use_nodes = True
    b = gm.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (0, 0, 0, 1)
    b.inputs['Emission Color'].default_value = (1.0, 0.38, 0.10, 1)
    b.inputs['Emission Strength'].default_value = 0.9 * strength
    g.data.materials.append(gm)
    ld = bpy.data.lights.new('ab_light', 'POINT')
    ld.energy = 400 * strength
    ld.color = (1.0, 0.6, 0.3)
    ld.shadow_soft_size = 0.8
    lo = bpy.data.objects.new('ab_light', ld)
    bpy.context.scene.collection.objects.link(lo)
    lo.location = base + Vector((0, -1.2, 0))
    return [o, g, lo]


def pose_nozzle(open_frac):
    for o in bpy.data.objects:
        if o.name.startswith('nozzle_petal_'):
            ang = o.get('open_angle', 0.13) * open_frac
            o.rotation_mode = 'QUATERNION'
            base = o.get('_rest_q')
            if base is None:
                o['_rest_q'] = list(o.rotation_quaternion)
                base = o['_rest_q']
            from mathutils import Quaternion
            q = Quaternion(base) @ Quaternion((1, 0, 0), ang)
            o.rotation_quaternion = q


USE_CPU = False


def setup(samples=256, w=1920, h=1080):
    sc = util.setup_cycles(samples=samples, width=w, height=h, gpu=not USE_CPU)
    if USE_CPU:
        sc.cycles.device = 'CPU'
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.01
    sc.cycles.max_bounces = 8
    sc.cycles.glossy_bounces = 4
    sc.cycles.transmission_bounces = 8
    sc.cycles.transparent_max_bounces = 16
    try:
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        pass
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.render.resolution_percentage = PCT
    return sc


def cam(loc, target, lens, name='cam', dof=None):
    c = util.add_camera(loc, target, lens=lens, name=name)
    c.data.sensor_width = 36
    if dof:
        c.data.dof.use_dof = True
        c.data.dof.focus_distance = dof[0]
        c.data.dof.aperture_fstop = dof[1]
    return c


def render_all(outdir, which=None, samples=256, fast=False):
    os.makedirs(outdir, exist_ok=True)
    solidify_glass()
    shots = which or ['hero', 'front34', 'rear_ab', 'top', 'cockpit', 'thumb']
    ground = flight_line()
    chocks_and_props()
    if any(sh in ('hero', 'thumb', 'front34') for sh in shots):
        context_props()
    sc = bpy.context.scene
    res = {}
    if fast:
        samples = 32
    pilot_objs = [o for o in bpy.data.objects if o.name.startswith('pilot_')]
    for shot in shots:
        for o in pilot_objs:
            o.hide_render = not (shot == 'cockpit' and o.name.startswith('pilot_body'))
        # clear previous world/sun/cameras
        for o in list(bpy.data.objects):
            if o.type in ('CAMERA',) or o.name.startswith('Sun') or o.name.startswith('ab_'):
                bpy.data.objects.remove(o)
        pose_nozzle(0.35)
        sc.cycles.volume_step_rate = 0.5
        if shot == 'hero':
            setup(samples, 2560, 1440)
            sky(8.5, HERO_AZ, 0.8, 6.5, warm=1.0)
            cam(bl((-9.0, -15.5, 1.25)), bl((8.0, 0.4, 1.95)), 50, dof=(20.0, 11.0))
        elif shot == 'thumb':
            setup(samples, 800, 450)
            sky(8.5, HERO_AZ, 0.8, 6.5, warm=1.0)
            cam(bl((-5.2, -10.8, 1.6)), bl((7.8, 0.3, 1.9)), 45)
        elif shot == 'front34':
            setup(samples, 1920, 1080)
            sky(12, 150, 1.0, 3.8)
            cam(bl((1.2, 7.8, 2.4)), bl((5.2, 0.5, 2.0)), 40, dof=(8.2, 10))
        elif shot == 'rear_ab':
            setup(samples, 1920, 1080)
            sky(1.5, 250, 0.35, 1.2)
            pose_nozzle(1.0)
            ab_flame(1.0)
            cam(bl((22.5, -5.5, 1.3)), bl((13.2, 0.0, 1.95)), 45)
        elif shot == 'top':
            setup(samples, 1920, 1920)
            sky(55, 160, 1.0, 4.0)
            c = cam(bl((7.53, 0, 60)), bl((7.53, 0, 0)), 50)
            c.data.type = 'ORTHO'
            c.data.ortho_scale = 16.6
            c.rotation_euler = (0, 0, math.radians(0))
        elif shot == 'debug_seat':
            setup(samples, 1600, 1000)
            sky(35, 200, 1.0, 4.0)
            for nm in ('fuselage', 'canopy', 'wing_L', 'ctl_lef_L', 'ctl_flaperon_L', 'aim9_L', 'launcher_L', 'intake_hood', 'intake_lip'):
                ob = bpy.data.objects.get(nm)
                if ob: ob.hide_render = True
            cam(bl((4.1, -3.2, 2.7)), bl((4.0, 0.0, 2.35)), 40)
        elif shot == 'cockpit':
            setup(samples, 1920, 1080)
            sky(35, 200, 1.0, 4.0)
            # pilot's eye view (slightly behind the design eye) looking at the panel, canopy closed
            cam(bl((4.40, 0.05, 2.86)), bl((3.62, -0.02, 2.42)), 17)
        path = os.path.join(outdir, f'{shot}.png')
        if shot == 'thumb':
            sc.render.image_settings.file_format = 'JPEG'
            sc.render.image_settings.quality = 90
            path = os.path.join(outdir, 'thumb.jpg')
        util.render_still(path)
        sc.render.image_settings.file_format = 'PNG'
        res[shot] = path
        if shot == 'cockpit':
            can = bpy.data.objects.get('canopy')
            if can and '_q0' in can:
                from mathutils import Quaternion
                can.rotation_quaternion = Quaternion(can['_q0'])
    return res
