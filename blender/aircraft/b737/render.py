"""Cycles renders of the 737-800 ("gerçek renderlar").

  Blender -b assets/aircraft/b737/b737.blend -P blender/aircraft/b737/render.py -- --shot hero [--samples 256] [--scale 1.0]
Shots: hero (2560x1440 golden hour), front (3/4 front), takeoff (low-angle rotation), planform (top view),
flightdeck (captain's view), cabin, thumb (800x450). Output: renders/aircraft/b737/<shot>.png (+ thumb.jpg).
"""
import os
import sys
import math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))
import bpy
from mathutils import Matrix, Vector, Euler
from util import setup_cycles, add_sun, add_camera, render_still, REPO
import shape as S

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = os.path.join(REPO, 'renders', 'aircraft', 'b737')
TEX = os.path.join(HERE, 'tex')
D = math.pi / 180
GROUND_Z = -S.Z_CG          # blender z of the ground (gear down, static)


# ------------------------------------------------------------------ posing (same conventions as model.js)
BASE = {}


def ob(n):
    return bpy.data.objects.get(n)


def remember():
    for o in bpy.data.objects:
        BASE[o.name] = o.matrix_basis.copy()


def set_pose(name, angle=0.0, offset=(0, 0, 0), axis='X'):
    """Rotate about the local axis and translate in the local frame (Blender axes: -Y aft, -Z down)."""
    o = ob(name)
    if o is None:
        return
    b = BASE[o.name]
    o.matrix_basis = b @ Matrix.Translation(Vector(offset)) @ Matrix.Rotation(angle, 4, axis)


def smooth(a, b, x):
    t = min(1, max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def pose(flaps=0.0, slats=None, gear=1.0, spoilers=0.0, speedbrake=0.0, aileron=0.0, elevator=0.0, rudder=0.0,
         reverser=0.0, fan_angle=0.0):
    slats = flaps if slats is None else slats
    set_pose('ctl_aileron_R', -aileron * 20 * D)
    set_pose('ctl_aileron_L', aileron * 20 * D)
    ee = -elevator * 26 * D if elevator >= 0 else -elevator * 18 * D
    set_pose('ctl_elevator_L', ee); set_pose('ctl_elevator_R', ee)
    set_pose('ctl_rudder', rudder * 26 * D)
    fdeg = flaps * 40
    for s in 'LR':
        for i, chord in ((1, 1.6), (2, 1.25)):
            travel = chord * 0.42 * min(1, fdeg / 15) ** 0.75
            set_pose(f'ctl_flap_{s}_{i}', fdeg * 0.55 * D, (0, -travel, -0.18 * travel))
            set_pose(f'flap_{s}_{i}_fore', -fdeg * 0.18 * D, (0, 0.06 * travel, 0.02 * fdeg / 40))
            set_pose(f'flap_{s}_{i}_aft', fdeg * 0.45 * D, (0, -0.26 * travel, -0.04 * travel))
        for i in (1, 2, 3):
            set_pose(f'canoe_{s}_{i}', fdeg * 0.42 * D)
        ext = min(1, slats * 3)
        for i in range(1, 5):
            set_pose(f'ctl_slat_{s}_{i}', -(8 + 12 * slats) * ext * D, (0, 0.22 * ext, -0.10 * ext))
        for k in ('K1', 'K2'):
            set_pose(f'ctl_slat_{s}_{k}', 105 * smooth(0, 0.35, slats) * D)
        for i in range(1, 7):
            a = spoilers * 60
            if 2 <= i <= 5:
                a = max(a, speedbrake * 38)
            set_pose(f'ctl_spoiler_{s}_{i}', -a * D)
    legM = 1 - smooth(0.12, 0.92, gear)
    legN = 1 - smooth(0.2, 0.95, gear)
    for s in 'LR':
        set_pose(f'gear_main_{s}', legM * 88 * D)
        set_pose(f'gear_main_{s}_brace', legM * 55 * D)
        set_pose(f'gear_door_nose_{s}', smooth(0, 0.18, gear) * 84 * D)
    set_pose('gear_nose', legN * 101 * D)
    set_pose('gear_nose_brace', legN * 57 * D)
    for i in (1, 2):
        set_pose(f'reverser_{i}', 0, (0, -0.58 * reverser, 0))
        set_pose(f'fan_{i}', fan_angle, axis='Y')


def piston_extend(amount):
    """amount 0..1 of the in-flight extension (weight off wheels)."""
    for n, stroke in (('gear_nose_piston', 0.30), ('gear_main_L_piston', 0.34), ('gear_main_R_piston', 0.34)):
        set_pose(n, 0, (0, 0, -0.35 * stroke * amount))


# ------------------------------------------------------------------ environment
def world_sky(elev, azim, strength=1.0):
    sc = bpy.context.scene
    w = bpy.data.worlds.new('SkyW')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    sky = nt.nodes.new('ShaderNodeTexSky')
    for t in ('MULTIPLE_SCATTERING', 'SINGLE_SCATTERING', 'NISHITA'):
        try:
            sky.sky_type = t
            break
        except TypeError:
            continue
    sky.sun_elevation = elev * D
    sky.sun_rotation = azim * D
    try:
        sky.air_density = 1.0
        sky.aerosol_density = 1.6
    except AttributeError:
        try:
            sky.dust_density = 1.6
        except AttributeError:
            pass
    try:
        sky.sun_disc = True
    except AttributeError:
        pass
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    return sky


def sun_lamp(elev, azim, energy, color=(1, 1, 1), angle=0.53):
    l = add_sun(elev, azim, energy, angle)
    l.data.color = color
    # blender sun rotation convention in util: rotation_euler = (90-elev, 0, azim); align with sky azimuth
    l.rotation_euler = (math.radians(90 - elev), 0, math.radians(azim + 90))
    return l


def ground_material():
    m = bpy.data.materials.new('ground')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Object'], sep.inputs['Vector'])
    # asphalt noise
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 3.0; nz.inputs['Detail'].default_value = 12
    nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
    nz2 = nt.nodes.new('ShaderNodeTexNoise'); nz2.inputs['Scale'].default_value = 0.08; nz2.inputs['Detail'].default_value = 4
    nt.links.new(tc.outputs['Object'], nz2.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.022, 0.023, 0.025, 1)
    ramp.color_ramp.elements[1].color = (0.058, 0.057, 0.055, 1)
    mixn = nt.nodes.new('ShaderNodeMath'); mixn.operation = 'MULTIPLY_ADD'
    nt.links.new(nz.outputs['Fac'], mixn.inputs[0]); mixn.inputs[1].default_value = 0.5
    nt.links.new(nz2.outputs['Fac'], mixn.inputs[2])
    nt.links.new(mixn.outputs[0], ramp.inputs['Fac'])
    # runway markings along Y: centreline dashes (x=0), edge lines (|x| = 21.5), threshold piano keys
    ax = nt.nodes.new('ShaderNodeMath'); ax.operation = 'ABSOLUTE'
    nt.links.new(sep.outputs['X'], ax.inputs[0])
    cl = nt.nodes.new('ShaderNodeMath'); cl.operation = 'LESS_THAN'; cl.inputs[1].default_value = 0.45
    nt.links.new(ax.outputs[0], cl.inputs[0])
    dash = nt.nodes.new('ShaderNodeMath'); dash.operation = 'PINGPONG'; dash.inputs[1].default_value = 25.0
    nt.links.new(sep.outputs['Y'], dash.inputs[0])
    dash2 = nt.nodes.new('ShaderNodeMath'); dash2.operation = 'GREATER_THAN'; dash2.inputs[1].default_value = 10.0
    nt.links.new(dash.outputs[0], dash2.inputs[0])
    cld = nt.nodes.new('ShaderNodeMath'); cld.operation = 'MULTIPLY'
    nt.links.new(cl.outputs[0], cld.inputs[0]); nt.links.new(dash2.outputs[0], cld.inputs[1])
    e1 = nt.nodes.new('ShaderNodeMath'); e1.operation = 'SUBTRACT'; e1.inputs[1].default_value = 21.0
    nt.links.new(ax.outputs[0], e1.inputs[0])
    e2 = nt.nodes.new('ShaderNodeMath'); e2.operation = 'ABSOLUTE'
    nt.links.new(e1.outputs[0], e2.inputs[0])
    e3 = nt.nodes.new('ShaderNodeMath'); e3.operation = 'LESS_THAN'; e3.inputs[1].default_value = 0.45
    nt.links.new(e2.outputs[0], e3.inputs[0])
    lines = nt.nodes.new('ShaderNodeMath'); lines.operation = 'MAXIMUM'
    nt.links.new(cld.outputs[0], lines.inputs[0]); nt.links.new(e3.outputs[0], lines.inputs[1])
    # outside the runway (|x| > 30): dry grass / concrete shoulder
    off = nt.nodes.new('ShaderNodeMath'); off.operation = 'GREATER_THAN'; off.inputs[1].default_value = 30.0
    nt.links.new(ax.outputs[0], off.inputs[0])
    grass_n = nt.nodes.new('ShaderNodeTexNoise'); grass_n.inputs['Scale'].default_value = 0.6; grass_n.inputs['Detail'].default_value = 10
    nt.links.new(tc.outputs['Object'], grass_n.inputs['Vector'])
    gr = nt.nodes.new('ShaderNodeValToRGB')
    gr.color_ramp.elements[0].color = (0.10, 0.10, 0.05, 1)
    gr.color_ramp.elements[1].color = (0.24, 0.20, 0.10, 1)
    nt.links.new(grass_n.outputs['Fac'], gr.inputs['Fac'])
    mx1 = nt.nodes.new('ShaderNodeMix'); mx1.data_type = 'RGBA'
    nt.links.new(lines.outputs[0], mx1.inputs['Factor'])
    nt.links.new(ramp.outputs['Color'], mx1.inputs['A'])
    mx1.inputs['B'].default_value = (0.62, 0.62, 0.60, 1)
    mx2 = nt.nodes.new('ShaderNodeMix'); mx2.data_type = 'RGBA'
    nt.links.new(off.outputs[0], mx2.inputs['Factor'])
    nt.links.new(mx1.outputs['Result'], mx2.inputs['A'])
    nt.links.new(gr.outputs['Color'], mx2.inputs['B'])
    # bay water beyond ~700 m
    vl = nt.nodes.new('ShaderNodeVectorMath'); vl.operation = 'LENGTH'
    nt.links.new(tc.outputs['Object'], vl.inputs[0])
    wf = nt.nodes.new('ShaderNodeMapRange')
    nt.links.new(vl.outputs['Value'], wf.inputs['Value'])
    wf.inputs['From Min'].default_value = 640; wf.inputs['From Max'].default_value = 700
    mx3 = nt.nodes.new('ShaderNodeMix'); mx3.data_type = 'RGBA'
    nt.links.new(wf.outputs['Result'], mx3.inputs['Factor'])
    nt.links.new(mx2.outputs['Result'], mx3.inputs['A'])
    mx3.inputs['B'].default_value = (0.012, 0.03, 0.045, 1)
    nt.links.new(mx3.outputs['Result'], bsdf.inputs['Base Color'])
    rr = nt.nodes.new('ShaderNodeMapRange')
    nt.links.new(nz.outputs['Fac'], rr.inputs['Value'])
    rr.inputs['To Min'].default_value = 0.72; rr.inputs['To Max'].default_value = 0.92
    rmix = nt.nodes.new('ShaderNodeMix'); rmix.data_type = 'FLOAT'
    nt.links.new(wf.outputs['Result'], rmix.inputs['Factor'])
    nt.links.new(rr.outputs['Result'], rmix.inputs['A'])
    rmix.inputs['B'].default_value = 0.06
    nt.links.new(rmix.outputs['Result'], bsdf.inputs['Roughness'])
    bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.25
    wave = nt.nodes.new('ShaderNodeTexWave'); wave.inputs['Scale'].default_value = 0.02; wave.inputs['Distortion'].default_value = 6
    nt.links.new(tc.outputs['Object'], wave.inputs['Vector'])
    hmix = nt.nodes.new('ShaderNodeMix'); hmix.data_type = 'FLOAT'
    nt.links.new(wf.outputs['Result'], hmix.inputs['Factor'])
    nt.links.new(nz.outputs['Fac'], hmix.inputs['A'])
    nt.links.new(wave.outputs['Fac'], hmix.inputs['B'])
    nt.links.new(hmix.outputs['Result'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def add_ground(size=60000, rot_deg=0.0, offset=(0, 0)):
    me = bpy.data.meshes.new('ground')
    h = size / 2
    me.from_pydata([(-h, -h, 0), (h, -h, 0), (h, h, 0), (-h, h, 0)], [], [(0, 1, 2, 3)])
    o = bpy.data.objects.new('ground', me)
    bpy.context.scene.collection.objects.link(o)
    o.location = (offset[0], offset[1], GROUND_Z - 0.003)
    o.rotation_euler = (0, 0, rot_deg * D)
    me.materials.append(ground_material())
    return o


def lights_on(nav=True, beacon=True, landing=False, strobe=False):
    def emit(mname, strength):
        m = bpy.data.materials.get(mname)
        if m and m.use_nodes:
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = strength
    emit('lens_red', 40 if nav else 0)
    emit('lens_green', 40 if nav else 0)
    emit('lens_beacon', 60 if beacon else 0)
    emit('lens_clear', 60 if (landing or strobe) else 0)
    for n, col, en in (('light_nav_L', (1, 0.05, 0.03), 8 if nav else 0), ('light_nav_R', (0.1, 1, 0.3), 8 if nav else 0),
                       ('light_beacon_top', (1, 0.05, 0.02), 25 if beacon else 0), ('light_beacon_bottom', (1, 0.05, 0.02), 25 if beacon else 0)):
        e = ob(n)
        if e is None or en == 0:
            continue
        ld = bpy.data.lights.new(n + '_pt', 'POINT'); ld.energy = en; ld.color = col; ld.shadow_soft_size = 0.05
        lo = bpy.data.objects.new(n + '_pt', ld); bpy.context.scene.collection.objects.link(lo)
        lo.matrix_world = e.matrix_world.copy()
    if landing:
        for n in ('light_landing_L', 'light_landing_R', 'light_taxi'):
            e = ob(n)
            if e is None:
                continue
            ld = bpy.data.lights.new(n + '_spot', 'SPOT'); ld.energy = 60000; ld.spot_size = 22 * D; ld.spot_blend = 0.6
            ld.color = (1, 0.95, 0.86); ld.shadow_soft_size = 0.05
            lo = bpy.data.objects.new(n + '_spot', ld); bpy.context.scene.collection.objects.link(lo)
            mw = e.matrix_world.copy()
            lo.matrix_world = mw @ Matrix.Rotation(math.radians(90 - 4), 4, 'X')


def screens():
    for sname, img in (('screen_pfd_capt', 'pfd'), ('screen_pfd_fo', 'pfd'), ('screen_nd_capt', 'nd'), ('screen_nd_fo', 'nd'),
                       ('screen_eicas_upper', 'eicas'), ('screen_eicas_lower', 'cdu'), ('screen_cdu_capt', 'cdu'), ('screen_cdu_fo', 'cdu')):
        o = ob(sname)
        p = os.path.join(TEX, f'fd_screen_{img}.png')
        if o is None or not os.path.exists(p):
            continue
        m = o.data.materials[0]
        nt = m.node_tree
        bsdf = nt.nodes['Principled BSDF']
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(p, check_existing=True)
        nt.links.new(t.outputs['Color'], bsdf.inputs['Emission Color'])
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.6
        bsdf.inputs['Roughness'].default_value = 0.15


def glass_for_render(cockpit=False):
    m = bpy.data.materials.get('glass_cockpit')
    if not m:
        return
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.8, 0.85, 0.85, 1) if cockpit else (0.02, 0.025, 0.03, 1)
    b.inputs['Roughness'].default_value = 0.0
    b.inputs['Alpha'].default_value = 0.08 if cockpit else 0.85
    b.inputs['IOR'].default_value = 1.52


def skin_backfaces_transparent(names=('fuselage', 'fuselage_plain', 'wing', 'tail', 'stab', 'nacelle', 'pylon')):
    """Mimic three.js back-face culling: from inside, the exterior skin is invisible (windows show the world)."""
    for n in names:
        m = bpy.data.materials.get(n)
        if not m or not m.use_nodes:
            continue
        nt = m.node_tree
        out = nt.nodes.get('Material Output')
        src = out.inputs['Surface'].links[0].from_socket
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mix = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(geo.outputs['Backfacing'], mix.inputs['Fac'])
        nt.links.new(src, mix.inputs[1])
        nt.links.new(tr.outputs['BSDF'], mix.inputs[2])
        nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])


def cabin_lights():
    # up-lit cove lights on top of the bins (washing the ceiling) + softer down-lights along the PSUs
    for i, X in enumerate(range(8, 30, 3)):
        for side in (-1, 1):
            ld = bpy.data.lights.new(f'cab{i}{side}', 'AREA')
            ld.shape = 'RECTANGLE'; ld.size = 0.10; ld.size_y = 2.9; ld.energy = 260; ld.color = (1.0, 0.94, 0.84)
            lo = bpy.data.objects.new(f'cab{i}{side}', ld); bpy.context.scene.collection.objects.link(lo)
            lo.location = (side * 0.76, S.X_CG - X, 4.93 - S.Z_CG)
            lo.rotation_euler = (math.pi, math.radians(-side * 25), 0)
            ld2 = bpy.data.lights.new(f'cabd{i}{side}', 'AREA')
            ld2.shape = 'RECTANGLE'; ld2.size = 0.25; ld2.size_y = 2.9; ld2.energy = 90; ld2.color = (1.0, 0.96, 0.9)
            lo2 = bpy.data.objects.new(f'cabd{i}{side}', ld2); bpy.context.scene.collection.objects.link(lo2)
            lo2.location = (side * 0.80, S.X_CG - X, 4.20 - S.Z_CG)


def hide_interior(h=True):
    inter = ob('interior')
    if inter is None:
        return
    stack = [inter]
    while stack:
        o = stack.pop()
        o.hide_render = h
        stack.extend(o.children)


def place_aircraft(pitch_deg=0.0, lift=0.0, pivot_y=None):
    """Rotate the whole aircraft (all root objects) about a lateral axis through the main gear contact."""
    bpy.context.view_layer.update()          # set_pose() changed matrix_basis: refresh world matrices first
    py = S.X_CG - S.MG_X if pivot_y is None else pivot_y
    piv = Vector((0, py, GROUND_Z))
    R = Matrix.Translation(piv + Vector((0, 0, lift))) @ Matrix.Rotation(pitch_deg * D, 4, 'X') @ Matrix.Translation(-piv)
    for o in bpy.data.objects:
        if o.parent is None and o.name not in ('ground',) and o.type in ('MESH', 'EMPTY'):
            o.matrix_world = R @ o.matrix_world


def cam(loc, tgt, lens, name='cam', ortho=None, shift=(0, 0)):
    c = add_camera(loc, tgt, lens=lens, name=name)
    c.data.clip_start = 0.02
    if ortho:
        c.data.type = 'ORTHO'
        c.data.ortho_scale = ortho
    c.data.shift_x, c.data.shift_y = shift
    c.data.dof.use_dof = False
    return c


def finish(name, w, h, samples):
    sc = setup_cycles(samples=samples, width=w, height=h, gpu='--cpu' not in argv)
    if '--cpu' in argv:
        sc.cycles.device = 'CPU'
        sc.render.threads_mode = 'FIXED'
        sc.render.threads = int(arg('--threads', 8))
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.02
    sc.cycles.max_bounces = 10
    sc.cycles.transparent_max_bounces = 16
    vt = arg('--view', 'Khronos PBR Neutral')
    try:
        sc.view_settings.view_transform = vt
        sc.view_settings.look = 'None'
    except TypeError:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    try:
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        pass
    if arg('--exposure') is not None:
        sc.view_settings.exposure = float(arg('--exposure'))
    if arg('--out') and name != 'custom':
        name = arg('--out')
    path = os.path.join(OUT, f'{name}.png')
    render_still(path)
    print('RENDERED', path)
    return path


def shot(name, samples):
    remember()
    scale = float(arg('--scale', 1.0))
    if name in ('hero', 'thumb'):
        # golden hour, low 3/4 front-left, on the runway
        pose(flaps=0.0, gear=1.0)
        hide_interior(True)
        glass_for_render(False)
        world_sky(5.5, float(arg('--az', 45)), float(arg('--sky', 0.45)))
        add_ground(rot_deg=0)
        lights_on(nav=True, beacon=True)
        cam((-27.0, 30.0, GROUND_Z + 1.55), (-1.0, 1.0, GROUND_Z + 3.4), 42)
        if name == 'hero':
            return finish('hero', int(2560 * scale), int(1440 * scale), samples)
        return finish('thumb_src', int(1600 * scale), int(900 * scale), samples)
    if name == 'front':
        pose(flaps=0.0, gear=1.0)
        hide_interior(True)
        glass_for_render(False)
        world_sky(float(arg('--sunel', 34)), float(arg('--az', 315)), float(arg('--sky', 0.45)))
        add_ground(rot_deg=0)
        cam((23.0, 28.0, GROUND_Z + 5.5), (0.5, 1.5, GROUND_Z + 2.8), 40)
        return finish('front', int(1920 * scale), int(1080 * scale), samples)
    if name == 'takeoff':
        pose(flaps=0.125, slats=0.25, gear=1.0, elevator=0.35)
        piston_extend(1.0)
        place_aircraft(pitch_deg=9.0, lift=0.35)
        hide_interior(True)
        glass_for_render(False)
        world_sky(float(arg('--sunel', 14)), float(arg('--az', 25)), float(arg('--sky', 0.45)))
        add_ground(rot_deg=0)
        lights_on(nav=True, beacon=True, landing=True, strobe=True)
        cam((-15.5, 34.0, GROUND_Z + 0.55), (0.0, 3.0, GROUND_Z + 4.6), 38)
        return finish('takeoff', int(1920 * scale), int(1080 * scale), samples)
    if name == 'planform':
        pose(flaps=0.0, gear=1.0)
        hide_interior(True)
        glass_for_render(False)
        world_sky(float(arg('--sunel', 60)), float(arg('--az', 20)), float(arg('--sky', 0.45)))
        g = add_ground(rot_deg=0, offset=(0, 0))
        c = cam((0, 0.8, 90), (0, 0.8, 0), 50, ortho=68)
        c.rotation_euler = (0, 0, math.radians(90))      # nose to the left, fuselage along the image width
        return finish('planform', int(1920 * scale), int(1080 * scale), samples)
    if name == 'flightdeck':
        pose(flaps=0.0, gear=1.0)
        hide_interior(False)
        glass_for_render(True)
        screens()
        skin_backfaces_transparent()
        world_sky(float(arg('--sunel', 32)), float(arg('--az', 330)), float(arg('--sky', 0.45)))
        add_ground(rot_deg=0)
        e = ob('eye_pilot').matrix_world.translation
        eye = Vector((e.x + 0.05, e.y - 0.12, e.z + 0.02))
        c = cam(tuple(eye), (eye.x + 0.25, eye.y + 1.0, eye.z - 0.42), 17)
        bpy.context.scene.view_settings.exposure = float(arg('--exposure', -0.6))
        return finish('flightdeck', int(1920 * scale), int(1080 * scale), samples)
    if name == 'cabin':
        pose()
        hide_interior(False)
        skin_backfaces_transparent()
        cabin_lights()
        cab = ob('interior_cabin')
        world_sky(float(arg('--sunel', 30)), float(arg('--az', 100)), float(arg('--sky', 0.45)))
        add_ground()
        X = 7.6
        cam((0.18, S.X_CG - X, S.FLOOR_Z - S.Z_CG + 1.62), (-0.15, S.X_CG - 22.0, S.FLOOR_Z - S.Z_CG + 0.95), 18)
        bpy.context.scene.view_settings.exposure = float(arg('--exposure', 0.3))
        return finish('cabin', int(1920 * scale), int(1080 * scale), samples)
    if name == 'jfe':
        # same viewpoint as the reference photo b738_TC-JFE_MUC.jpg: climbing out, seen from below-right
        pose(flaps=float(arg('--flaps', 0.0)), gear=0.0)
        piston_extend(1.0)
        place_aircraft(pitch_deg=float(arg('--pitch', 13.0)), lift=0.0, pivot_y=0.0)
        hide_interior(True)
        glass_for_render(False)
        world_sky(float(arg('--sunel', 38)), float(arg('--az', 60)), float(arg('--sky', 0.5)))
        f = lambda k, d: tuple(float(x) for x in arg(k, d).split(','))
        c = cam(f('--cam', '183,32,-75'), f('--tgt', '0,0.5,0.8'), float(arg('--lens', 150)))
        return finish(arg('--out', 'cmp_jfe'), int(arg('--w', 1920)), int(arg('--h', 1080)), samples)
    if name == 'custom':
        f = lambda k, d: tuple(float(x) for x in arg(k, d).split(','))
        pose(flaps=float(arg('--flaps', 0)), gear=float(arg('--gear', 1)), spoilers=float(arg('--spoilers', 0)),
             reverser=float(arg('--rev', 0)))
        hide_interior(arg('--interior', '0') != '1')
        glass_for_render(arg('--interior', '0') == '1')
        if arg('--interior', '0') == '1':
            screens()
        world_sky(float(arg('--sunel', 35)), float(arg('--az', 150)), float(arg('--sky', 0.45)))
        add_ground()
        cam(f('--cam', '-20,20,0'), f('--tgt', '0,0,0'), float(arg('--lens', 50)))
        return finish(arg('--out', 'custom'), int(arg('--w', 1280)), int(arg('--h', 720)), samples)
    raise SystemExit('unknown shot ' + name)


if __name__ == '__main__':
    s = arg('--shot', 'hero')
    p = shot(s, int(arg('--samples', 192)))
    if s == 'thumb':
        # 800x450 jpg from the render (PNG -> JPG via Blender image save)
        im = bpy.data.images.load(p)
        im.scale(800, 450)
        sc = bpy.context.scene
        sc.render.image_settings.file_format = 'JPEG'
        sc.render.image_settings.quality = 90
        im.save_render(os.path.join(OUT, 'thumb.jpg'), scene=sc)
        print('RENDERED thumb.jpg')
