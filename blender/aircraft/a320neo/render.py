"""Cycles renders of the A320neo (reads assets/aircraft/a320neo/a320neo.blend written by build.py --save-blend).

/Applications/Blender.app/Contents/MacOS/Blender -b assets/aircraft/a320neo/a320neo.blend -P blender/aircraft/a320neo/render.py -- \
    [hero] [front34] [takeoff] [planform] [flightdeck] [--samples N] [--scale 0.5]
Writes renders/aircraft/a320neo/*.png and thumb.jpg (from the hero).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))
import bpy
from mathutils import Matrix, Vector
import util
import layout as LY

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.join(util.REPO, 'renders', 'aircraft', 'a320neo')
DISP = os.path.join(HERE, 'build', 'displays')
ZG = -LY.Z_GROUND


def arg(name, default):
    return type(default)(ARGS[ARGS.index(name) + 1]) if name in ARGS else default


SAMPLES = arg('--samples', 256)
SCALE = arg('--scale', 1.0)
D = math.radians


# ------------------------------------------------------------------------------------------------ scene prep

def prep_materials():
    # cockpit glass -> thin 'architectural' glass (transparent + Fresnel reflection, no refraction volume)
    m = bpy.data.materials.get('cockpit_glass')
    if m:
        nt = m.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        mix = nt.nodes.new('ShaderNodeMixShader')
        mix.inputs['Fac'].default_value = 0.0
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        tr.inputs['Color'].default_value = (0.90, 0.94, 0.93, 1)
        gl = nt.nodes.new('ShaderNodeBsdfGlossy')
        gl.inputs['Roughness'].default_value = 0.015
        # Layer Weight 'Fresnel' is symmetric for back faces (the Fresnel node goes into total internal
        # reflection when the cockpit glass is seen from inside)
        fr = nt.nodes.new('ShaderNodeLayerWeight')
        fr.inputs['Blend'].default_value = 0.10
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = 0.8
        nt.links.new(fr.outputs['Fresnel'], mul.inputs[0])
        nt.links.new(mul.outputs[0], mix.inputs['Fac'])
        nt.links.new(tr.outputs['BSDF'], mix.inputs[1])
        nt.links.new(gl.outputs['BSDF'], mix.inputs[2])
        nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
        try:
            m.surface_render_method = 'DITHERED'
        except Exception:
            pass
    # display screens: emissive images captured from the avionics module
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.name.startswith('screen_'):
            p = os.path.join(DISP, o.name + '.png')
            mat = bpy.data.materials.new('r_' + o.name)
            mat.use_nodes = True
            nt = mat.node_tree
            b = nt.nodes['Principled BSDF']
            b.inputs['Base Color'].default_value = (0, 0, 0, 1)
            b.inputs['Roughness'].default_value = 0.08
            if os.path.exists(p):
                t = nt.nodes.new('ShaderNodeTexImage')
                t.image = bpy.data.images.load(p, check_existing=True)
                nt.links.new(t.outputs['Color'], b.inputs['Emission Color'])
                b.inputs['Emission Strength'].default_value = 2.2
            o.data.materials.clear()
            o.data.materials.append(mat)
    # the exterior 'plug' is a realtime stand-in for the interior
    for n in ('ck_plug',):
        o = bpy.data.objects.get(n)
        if o:
            o.hide_render = True
    # panel emissive (integral lighting) is too strong in daylight renders
    m = bpy.data.materials.get('ck_panel')
    if m:
        m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 0.6


def concrete_material(name='apron', slab=5.0, runway=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    b = nodes['Principled BSDF']
    tc = nodes.new('ShaderNodeTexCoord')
    mp = nodes.new('ShaderNodeMapping')
    links.new(tc.outputs['Object'], mp.inputs['Vector'])
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 0.35
    noise.inputs['Detail'].default_value = 12
    links.new(mp.outputs['Vector'], noise.inputs['Vector'])
    fine = nodes.new('ShaderNodeTexNoise')
    fine.inputs['Scale'].default_value = 40
    fine.inputs['Detail'].default_value = 8
    links.new(mp.outputs['Vector'], fine.inputs['Vector'])
    ramp = nodes.new('ShaderNodeValToRGB')
    if runway:
        ramp.color_ramp.elements[0].color = (0.035, 0.036, 0.038, 1)
        ramp.color_ramp.elements[1].color = (0.085, 0.085, 0.088, 1)
    else:
        ramp.color_ramp.elements[0].color = (0.22, 0.215, 0.20, 1)
        ramp.color_ramp.elements[1].color = (0.42, 0.41, 0.39, 1)
    mix_in = nodes.new('ShaderNodeMath')
    mix_in.operation = 'MULTIPLY_ADD'
    mix_in.inputs[1].default_value = 0.6
    links.new(noise.outputs['Fac'], mix_in.inputs[0])
    links.new(fine.outputs['Fac'], mix_in.inputs[2])
    mix_in.inputs[2].default_value = 0.2
    links.new(mix_in.outputs[0], ramp.inputs['Fac'])
    col = ramp.outputs['Color']
    if not runway:
        # slab joints
        brick = nodes.new('ShaderNodeTexBrick')
        brick.offset = 0.0
        brick.inputs['Scale'].default_value = 1.0 / slab
        brick.inputs['Mortar Size'].default_value = 0.012 * slab / 5
        brick.inputs['Brick Width'].default_value = 1.0
        brick.inputs['Row Height'].default_value = 1.0
        brick.inputs['Color1'].default_value = (1, 1, 1, 1)
        brick.inputs['Color2'].default_value = (0.90, 0.90, 0.88, 1)
        brick.inputs['Mortar'].default_value = (0.55, 0.55, 0.55, 1)
        links.new(mp.outputs['Vector'], brick.inputs['Vector'])
        mul = nodes.new('ShaderNodeMix')
        mul.data_type = 'RGBA'
        mul.blend_type = 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1.0
        links.new(col, mul.inputs['A'])
        links.new(brick.outputs['Color'], mul.inputs['B'])
        col = mul.outputs['Result']
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 0.3
        links.new(brick.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], b.inputs['Normal'])
    links.new(col, b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.85 if not runway else 0.9
    return m


def line_material(color, name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = 0.6
    return m


def plane(name, x0, x1, y0, y1, z, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [(0, 1, 2, 3)])
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    return o


def build_ground(kind='apron'):
    for o in list(bpy.data.objects):
        if o.name.startswith('g_'):
            bpy.data.objects.remove(o, do_unlink=True)
    if kind == 'apron':
        plane('g_apron', -3000, 3000, -3000, 3000, ZG, concrete_material('apron'))
        yl = line_material((0.95, 0.70, 0.08), 'yline')
        plane('g_lead', -0.08, 0.08, -60, 120, ZG + 0.004, yl)            # lead-in line along the centreline
        plane('g_stop', -1.6, 1.6, LY.S_CG - 3.0, LY.S_CG - 2.7, ZG + 0.004, yl)
        wl = line_material((0.9, 0.9, 0.88), 'wline')
        plane('g_edge1', 24.0, 24.2, -120, 140, ZG + 0.004, wl)
        plane('g_edge2', -24.2, -24.0, -120, 140, ZG + 0.004, line_material((0.8, 0.12, 0.1), 'rline'))
    else:
        plane('g_grass', -2000, 2000, -2000, 2000, ZG - 0.05, grass_material())
        plane('g_rwy', -22.5, 22.5, -1500, 1500, ZG, concrete_material('runway', runway=True))
        wl = line_material((0.92, 0.92, 0.9), 'wline2')
        for k in range(-40, 40):
            y0 = k * 60.0
            plane(f'g_cl{k}', -0.45, 0.45, y0, y0 + 36, ZG + 0.004, wl)
        plane('g_e1', 21.5, 22.4, -1500, 1500, ZG + 0.004, wl)
        plane('g_e2', -22.4, -21.5, -1500, 1500, ZG + 0.004, wl)


def simple_mat(name, color, rough=0.6, metal=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = strength
    return m


def boxo(name, center, size, mat, rot_z=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    o.rotation_euler = (0, 0, rot_z)
    o.data.materials.append(mat)
    return o


def cylo(name, center, r, h, mat, verts=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=center)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def apron_context(view_from, view_to):
    """Background terminal + jet bridges, apron flood-light masts, distant hills, cones and chocks."""
    import numpy as np
    vf, vt = np.array(view_from[:2]), np.array(view_to[:2])
    d = (vt - vf) / np.linalg.norm(vt - vf)
    n = np.array([-d[1], d[0]])
    ang = math.atan2(d[1], d[0]) + math.pi / 2
    glass = simple_mat('g_glass', (0.30, 0.36, 0.42), rough=0.12, metal=0.6)
    wall = simple_mat('g_wall', (0.62, 0.62, 0.60), rough=0.7)
    roof = simple_mat('g_roof', (0.45, 0.46, 0.47), rough=0.45, metal=0.6)
    warm = simple_mat('g_warm', (0.9, 0.8, 0.6), rough=0.5, emit=(1.0, 0.78, 0.5), strength=2.0)
    dist = arg('--term', 620.0)
    c = vf + d * dist
    boxo('g_term_base', (c[0], c[1], ZG + 3.0), (900, 40, 6), wall, ang)
    boxo('g_term', (c[0], c[1], ZG + 10.5), (900, 34, 9), glass, ang)
    boxo('g_term_roof', (c[0], c[1], ZG + 16.0), (910, 46, 2.0), roof, ang)
    for k in range(-11, 12):
        p = c + n * (k * 40) - d * 18.5
        boxo(f'g_band{k}', (p[0], p[1], ZG + 9.5), (26, 0.4, 0.6), warm, ang)
        q = c + n * (k * 40 + 10) - d * 40
        boxo(f'g_bridge{k}', (q[0], q[1], ZG + 5.2), (3.2, 34, 3.2), wall, ang + 0.3)
        cylo(f'g_bleg{k}', (q[0] - d[0] * 14, q[1] - d[1] * 14, ZG + 1.8), 0.35, 3.6, roof)
        # tail fins of aircraft parked at the gates
        if k % 2 == 0:
            f = c + n * (k * 40 + 22) - d * 70
            boxo(f'g_fin{k}', (f[0], f[1], ZG + 9.0), (0.4, 6.0, 7.0), wall, ang + math.pi / 2)
    pole = simple_mat('g_pole', (0.5, 0.5, 0.52), rough=0.4, metal=0.8)
    lamp = simple_mat('g_lamp', (1, 1, 1), emit=(1.0, 0.85, 0.6), strength=12.0)
    for k, off in enumerate((-260, -120, 30, 170, 320)):
        p = vf + d * 260 + n * off
        cylo(f'g_mast{k}', (p[0], p[1], ZG + 14), 0.35, 28, pole)
        boxo(f'g_lamp{k}', (p[0], p[1], ZG + 28.3), (3.5, 1.0, 0.8), lamp, ang)
    # distant hills (San Bruno mountain-ish) on the horizon
    hill = simple_mat('g_hill', (0.17, 0.15, 0.12), rough=0.9, emit=(0.30, 0.33, 0.40), strength=0.35)
    verts, faces = [], []
    N = 60
    for i in range(N + 1):
        u = (i / N - 0.5) * 2
        hgt = 90 + 110 * math.exp(-((u - 0.3) / 0.35) ** 2) + 60 * math.exp(-((u + 0.5) / 0.25) ** 2) + 18 * math.sin(i * 1.7)
        p = vf + d * 3500 + n * (u * 6000)
        verts += [(p[0], p[1], ZG - 5), (p[0], p[1], ZG + hgt)]
    for i in range(N):
        a = 2 * i
        faces.append((a, a + 2, a + 3, a + 1))
    me = bpy.data.meshes.new('g_hills')
    me.from_pydata(verts, [], faces)
    o = bpy.data.objects.new('g_hills', me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(hill)
    # traffic cones (wingtips, engines, nose) and wheel chocks
    cone_o = simple_mat('g_cone', (0.9, 0.25, 0.02), rough=0.5)
    for k, (x, y) in enumerate(((-18.5, -4.5), (18.5, -4.5), (-5.75, 16.0), (5.75, 16.0), (0.0, 19.8))):
        bpy.ops.mesh.primitive_cone_add(vertices=20, radius1=0.2, radius2=0.03, depth=0.75, location=(x, y, ZG + 0.375))
        o = bpy.context.active_object
        o.name = f'g_cone{k}'
        o.data.materials.append(cone_o)
    chock = simple_mat('g_chock', (0.85, 0.65, 0.05), rough=0.6)
    for k, dy in enumerate((0.55, -0.55)):
        boxo(f'g_chock{k}', (0.0, LY.S_CG - LY.NLG_S + dy, ZG + 0.09), (0.7, 0.18, 0.18), chock)


def grass_material():
    m = bpy.data.materials.new('grass')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    n = nt.nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = 0.05
    r = nt.nodes.new('ShaderNodeValToRGB')
    r.color_ramp.elements[0].color = (0.10, 0.12, 0.05, 1)
    r.color_ramp.elements[1].color = (0.24, 0.22, 0.10, 1)
    nt.links.new(n.outputs['Fac'], r.inputs['Fac'])
    nt.links.new(r.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.95
    return m


def sky(elev, azim, strength=1.0):
    w = util.nishita_sky(sun_elevation_deg=elev, sun_rotation_deg=azim, strength=strength)
    nt = w.node_tree
    sk = [n for n in nt.nodes if n.type == 'TEX_SKY'][0]
    try:
        sk.sky_type = 'MULTIPLE_SCATTERING'
    except TypeError:
        pass
    sk.sun_elevation = math.radians(elev)
    sk.sun_rotation = math.radians(azim)
    for attr, val in (('sun_intensity', 1.0), ('air_density', 1.2), ('aerosol_density', 2.0), ('dust_density', 2.0),
                      ('ozone_density', 1.0)):
        if hasattr(sk, attr):
            setattr(sk, attr, val)
    return w


# ------------------------------------------------------------------------------------------------ poses

def rotate_local(o, axis, angle):
    o.matrix_world = o.matrix_world @ Matrix.Rotation(angle, 4, axis)


def pose_takeoff():
    """CONF 1+F: slats 18 deg, flaps 10 deg with Fowler travel; nose rotated 9 deg about the main gear."""
    for o in bpy.data.objects:
        n = o.name
        if n.startswith('ctl_flap_'):
            rotate_local(o, 'X', D(11))
            o.location += Vector((0, -0.45, -0.08))
        elif n.startswith('ctl_slat_'):
            rotate_local(o, 'X', -D(18))
            o.location += Vector((0, 0.17, -0.07))
    # nose strut fully extended
    p = bpy.data.objects.get('gear_nose_piston')
    if p:
        p.location += Vector((0, 0, -0.12))
    root = bpy.data.objects['a320neo']
    piv = Vector((0, LY.S_CG - LY.MLG_S, ZG + LY.MLG_TIRE_D / 2 - 0.02))
    R = Matrix.Translation(piv) @ Matrix.Rotation(D(9), 4, 'X') @ Matrix.Translation(-piv)
    root.matrix_world = R @ root.matrix_world


def pose_parked():
    pass


# ------------------------------------------------------------------------------------------------ shots

EXPOSURE_BASE = -3.4          # physical sky radiance -> display


def cycles(w, h, samples, exposure=0.0):
    sc = util.setup_cycles(samples=samples, width=int(w * SCALE), height=int(h * SCALE))
    prefs = bpy.context.preferences.addons['cycles'].preferences
    if hasattr(prefs, 'kernel_optimization_level'):
        prefs.kernel_optimization_level = 'OFF'      # avoid background kernel specialisation (crashes when shared)
    if '--cpu' in ARGS:
        sc.cycles.device = 'CPU'
    sc.view_settings.exposure = EXPOSURE_BASE + exposure + arg('--ev', 0.0)
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.01
    sc.cycles.max_bounces = 8
    sc.cycles.glossy_bounces = 4
    sc.cycles.transmission_bounces = 8
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.render.film_transparent = False
    return sc


def cam(loc, tgt, lens, name='cam', ortho=None, roll=0.0):
    c = util.add_camera(loc, tgt, lens=lens, name=name)
    c.data.clip_start = 0.02
    c.data.dof.use_dof = False
    if ortho:
        c.data.type = 'ORTHO'
        c.data.ortho_scale = ortho
    if roll:
        c.rotation_euler = (c.rotation_euler.to_matrix() @ Matrix.Rotation(roll, 3, 'Z')).to_euler()
    return c


def shot_hero():
    build_ground('apron')
    sky(arg('--el', 4.5), arg('--az', 290.0), 1.0)
    cycles(2560, 1440, SAMPLES, exposure=arg('--exp', 0.55))
    loc, tgt = (-50.0, 66.0, ZG + 1.6), (1.5, 3.0, -0.6)
    apron_context(loc, tgt)
    c = cam(loc, tgt, arg('--lens', 75.0))
    c.data.dof.use_dof = True
    c.data.dof.focus_distance = (Vector(loc) - Vector((0, 8.0, 0))).length
    c.data.dof.aperture_fstop = 5.6
    util.render_still(os.path.join(OUT, arg('--out', 'hero.png')))
    if '--out' in ARGS:
        return
    # thumbnail
    img = bpy.data.images.load(os.path.join(OUT, 'hero.png'))
    img.scale(800, 450)
    img.filepath_raw = os.path.join(OUT, 'thumb.jpg')
    img.file_format = 'JPEG'
    bpy.context.scene.render.image_settings.quality = 90
    img.save()


def shot_front34():
    build_ground('apron')
    sky(14, 60, 1.0)
    cycles(1920, 1080, SAMPLES, exposure=0.1)
    loc, tgt = (25.0, 31.0, ZG + 6.5), (-0.8, 2.0, -1.2)
    apron_context(loc, tgt)
    cam(loc, tgt, 45)
    util.render_still(os.path.join(OUT, 'front34.png'))


def shot_takeoff():
    build_ground('runway')
    pose_takeoff()
    sky(9, 290, 1.0)
    cycles(1920, 1080, SAMPLES, exposure=0.3)
    cam((-26.0, 18.0, ZG + 0.55), (0.0, -2.0, 1.6), 30, roll=D(-3))
    util.render_still(os.path.join(OUT, 'takeoff.png'))


def shot_planform():
    build_ground('apron')
    sky(58, 200, 1.0)
    cycles(1920, 1080, SAMPLES, exposure=-0.2)
    c = cam((0.0, -1.5, 60.0), (0.0, -1.5, 0.0), 50, ortho=41.0)
    c.rotation_euler = (0, 0, D(-90))
    util.render_still(os.path.join(OUT, 'planform.png'))


def fill_light(loc, target, power, size=1.0, color=(1.0, 0.95, 0.88)):
    l = bpy.data.lights.new('fill', 'AREA')
    l.energy = power
    l.size = size
    l.color = color
    o = bpy.data.objects.new('fill', l)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return o


def shot_flightdeck():
    build_ground('apron')
    sky(24, 320, 1.0)
    cycles(1920, 1080, SAMPLES, exposure=0.9)
    # classic flight-deck photo from the observer seat, between and behind the pilot seats; soft fill from behind
    loc = (0.0, LY.S_CG - 3.30, 0.90)
    cam(loc, (0.0, LY.S_CG - 1.70, 0.18), 15)
    fill_light((0.0, LY.S_CG - 3.6, 0.95), (0.0, LY.S_CG - 1.7, 0.1), 60, size=1.2)
    util.render_still(os.path.join(OUT, 'flightdeck.png'))


SHOTS = dict(hero=shot_hero, front34=shot_front34, takeoff=shot_takeoff, planform=shot_planform,
             flightdeck=shot_flightdeck)

if __name__ == '__main__':
    prep_materials()
    names = [a for a in ARGS if a in SHOTS] or ['hero']
    if '--hide' in ARGS:
        for nm in ARGS[ARGS.index('--hide') + 1].split(','):
            if bpy.data.objects.get(nm):
                bpy.data.objects[nm].hide_render = True
    if '--wb' in ARGS:          # debug: workbench instead of cycles
        _orig = util.render_still
        def _wb(path):
            sc = bpy.context.scene
            sc.render.engine = 'BLENDER_WORKBENCH'
            sc.display.shading.light = 'STUDIO'
            sc.display.shading.color_type = 'MATERIAL'
            return _orig(path.replace('.png', '_wb.png'))
        util.render_still = _wb
    for n in names:
        SHOTS[n]()
