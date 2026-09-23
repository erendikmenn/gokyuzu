"""UH-60M Cycles renders ("gerçek renderlar"). Loads the build .blend (built with --save) and renders:

    Blender -b -P blender/aircraft/uh60/render.py -- <shot> [--samples N] [--scale 0.5] [--out path]

shots: hero (hovering over the bay at golden hour, motion-blurred rotor, 2560x1440), helipad (3/4 front on a
helipad), side (side view, cabin doors open), cockpit (interior), lookdev (quick check), all, thumb.
"""
import os
import sys
import math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))
import bpy
import numpy as np
from mathutils import Vector, Matrix, Euler
import util

REPO = util.REPO
BLEND = os.path.join(REPO, 'assets', 'aircraft', 'uh60', 'uh60_build.blend')
OUT = os.path.join(REPO, 'renders', 'aircraft', 'uh60')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SHOT = ARGS[0] if ARGS else 'lookdev'


def arg(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        return ARGS[i + 1] if i + 1 < len(ARGS) else True
    return default


CG = (0.0, -0.35, 1.55)
NR = 258.0
DEG = math.pi / 180


def obj(n):
    return bpy.data.objects.get(n)


def setup(samples, w, h):
    sc = util.setup_cycles(samples=samples, width=w, height=h, gpu=not arg('--cpu'))
    if arg('--cpu'):
        sc.cycles.device = 'CPU'
        sc.render.threads_mode = 'FIXED'
        sc.render.threads = int(arg('--threads', 12))
    scale = float(arg('--scale', 1.0))
    sc.render.resolution_percentage = int(100 * scale)
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        pass
    sc.cycles.max_bounces = 8
    sc.cycles.glossy_bounces = 4
    sc.cycles.transparent_max_bounces = 16
    sc.cycles.volume_bounces = 1
    sc.cycles.volume_step_rate = 4.0
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = arg('--look_', 'AgX - Punchy')
    return sc


def place_aircraft(loc=(0, 0, 0), rot=(0, 0, 0)):
    """Root 'uh60' origin = CG. loc: position of the CG in the world; rot: (pitch, roll, heading) radians."""
    root = obj('uh60')
    root.location = loc
    root.rotation_mode = 'YXZ'
    pitch, roll, hdg = rot
    root.rotation_euler = (pitch, roll, hdg)
    # children are in G coordinates relative to the root: shift the geometry by -CG via a delta
    root.delta_location = (0, 0, 0)
    return root


def parent_offset():
    """The build parents everything under 'uh60' with location -CG; renders re-anchor with a child offset empty."""
    root = obj('uh60')
    return root


def blades(beta_deg=-3.2, feather_deg=0.0, rpm_pose=False):
    for i in range(4):
        b = obj(f'blade_{i + 1}')
        th = i * math.pi / 2
        b.rotation_euler = (feather_deg * DEG, -beta_deg * DEG, th)
        if beta_deg < 0:
            # parked blades sag in a curve (flexible composite spar), not as a straight line: render-only bend
            m = b.modifiers.new('droop', 'SIMPLE_DEFORM')
            m.deform_method = 'BEND'
            m.deform_axis = 'Y'
            m.angle = math.radians(float(arg('--droop', 7.0)))


def spin_rotors(rpm_frac=1.0, fps=24, shutter=0.5):
    """Keyframe linear rotor rotation around frame 1 so Cycles motion blur smears the blades."""
    sc = bpy.context.scene
    sc.render.fps = fps
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = shutter
    sc.frame_set(1)
    w_main = 2 * math.pi * NR * rpm_frac / 60.0 / fps          # rad per frame
    w_tail = 2 * math.pi * 1190 * rpm_frac / 60.0 / fps
    for name, axis, w, phase in (('rotor_main', 2, w_main, 0.35), ('rotor_tail', 0, w_tail, 0.2)):
        o = obj(name)
        base = list(o.rotation_euler)
        for f in (0, 1, 2):
            e = list(base)
            e[axis] = base[axis] + phase + w * (f - 1)
            o.rotation_euler = e
            o.keyframe_insert('rotation_euler', index=axis, frame=f)
        act = o.animation_data.action
        try:
            fcs = act.fcurves
        except AttributeError:
            fcs = [fc for layer in act.layers for strip in layer.strips for cb in strip.channelbags for fc in cb.fcurves]
        for fc in fcs:
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
    sc.frame_set(1)


def hide(names, v=True):
    for n in names:
        o = obj(n)
        if o:
            o.hide_render = v
            o.hide_viewport = v


def base_setup():
    hide(['rotor_main_blur', 'rotor_tail_blur'])
    # renders show the detailed interior; the lite stand-in (exterior GLB) is hidden
    il = obj('interior_lite')
    if il and obj('interior') and not arg('--lite'):
        for o in il.children_recursive:
            o.hide_render = True
    elif arg('--lite') and obj('interior'):
        for o in obj('interior').children_recursive:
            o.hide_render = True
    h = bpy.data.materials.get('hull')
    if h and h.node_tree:
        h.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = float(arg('--formation', 0.0))
    # glass: slightly reflective, thin
    g = bpy.data.materials.get('glass')
    if g:
        b = g.node_tree.nodes['Principled BSDF']
        b.inputs['Alpha'].default_value = 0.18
        b.inputs['Roughness'].default_value = 0.02


def ground_plane(size=400, mat=None, z=0.0):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, z))
    p = bpy.context.active_object
    if mat:
        p.data.materials.append(mat)
    return p


def mat_concrete(scale=1.0, markings=None):
    m = bpy.data.materials.new('concrete')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    n1 = nt.nodes.new('ShaderNodeTexNoise')
    n1.inputs['Scale'].default_value = 0.6 * scale
    n1.inputs['Detail'].default_value = 12
    n1.inputs['Roughness'].default_value = 0.62
    n2 = nt.nodes.new('ShaderNodeTexNoise')
    n2.inputs['Scale'].default_value = 40 * scale
    n2.inputs['Detail'].default_value = 8
    nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
    nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.13, 0.128, 0.12, 1)
    ramp.color_ramp.elements[1].color = (0.24, 0.235, 0.22, 1)
    nt.links.new(n1.outputs['Fac'], ramp.inputs['Fac'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 0.35
    nt.links.new(ramp.outputs['Color'], mix.inputs['A'])
    nt.links.new(n2.outputs['Color'], mix.inputs['B'])
    col = mix.outputs['Result']
    if markings:
        img = bpy.data.images.load(markings)
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img
        tex.extension = 'CLIP'
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1 / 30.0, 1 / 30.0, 1)
        mp.inputs['Location'].default_value = (0.5, 0.5, 0)
        nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
        nt.links.new(mp.outputs['Vector'], tex.inputs['Vector'])
        mix2 = nt.nodes.new('ShaderNodeMix')
        mix2.data_type = 'RGBA'
        nt.links.new(tex.outputs['Alpha'], mix2.inputs['Factor'])
        nt.links.new(col, mix2.inputs['A'])
        nt.links.new(tex.outputs['Color'], mix2.inputs['B'])
        col = mix2.outputs['Result']
    nt.links.new(col, b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.85
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.15
    nt.links.new(n2.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    return m


def airfield_ground(pad=True, hills_az=230, seed=7):
    """Concrete helipad (40 x 40 m) on an asphalt apron, grass beyond, low hills on the horizon."""
    mk = os.path.join(HERE, 'refimg', 'helipad.png')
    p = ground_plane(40, mat_concrete(1.0, mk if (pad and os.path.exists(mk)) else None), z=0.0)
    asph = mat_concrete(3.0)
    r = asph.node_tree.nodes['Color Ramp'] if 'Color Ramp' in asph.node_tree.nodes else None
    for n in asph.node_tree.nodes:
        if n.type == 'VALTORGB':
            n.color_ramp.elements[0].color = (0.035, 0.036, 0.038, 1)
            n.color_ramp.elements[1].color = (0.075, 0.075, 0.078, 1)
    ground_plane(400, asph, z=-0.005)
    ground_plane(8000, mat_simple('grass', (0.045, 0.055, 0.025), 0.95), z=-0.02)
    terrain_hills(3200, 12000, hills_az, 150, 300, seed, 'terrain_far', dry=(0.13, 0.105, 0.07), green=(0.025, 0.036, 0.022))
    haze_box(density=0.00006, color=(0.55, 0.68, 0.95))


def world_sky(sun_el, sun_az, strength=0.25, exposure=0.0, sun_size=0.545):
    """Physical (Nishita-type) sky incl. its sun disc as the only light source."""
    w = util.nishita_sky(sun_elevation_deg=sun_el, sun_rotation_deg=sun_az, strength=strength)
    sky = next(n for n in w.node_tree.nodes if n.type == 'TEX_SKY')
    try:
        sky.sun_disc = True
        sky.sun_size = math.radians(sun_size)
    except AttributeError:
        pass
    bpy.context.scene.view_settings.exposure = exposure
    return w


def camera(loc, look, lens, name='Cam', dof=None):
    cam = util.add_camera(loc, look, lens=lens, name=name)
    if dof:
        cam.data.dof.use_dof = True
        cam.data.dof.focus_distance = dof[0]
        cam.data.dof.aperture_fstop = dof[1]
    return cam


def render(path):
    if os.path.exists(path):
        os.remove(path)              # new inode: never write through a hard link (dist/ links the published renders)
    util.render_still(path)
    print('[render] saved', path, flush=True)


# ------------------------------------------------------------------------------------------------------------ helpers
def rig_empty(loc, pitch=0.0, roll=0.0, heading=0.0):
    """Parent the aircraft root under an empty placing the CG at 'loc' with the given attitude (radians).
    heading: rotation about world Z (0 = nose toward +Y)."""
    e = bpy.data.objects.new('placer', None)
    bpy.context.scene.collection.objects.link(e)
    e.location = loc
    e.rotation_mode = 'YXZ'
    e.rotation_euler = (pitch, roll, heading)       # pitch about X (nose up +), roll about Y
    root = obj('uh60')
    root.parent = e
    return e


def stabilator(deg_te_down):
    o = obj('ctl_stabilator')
    o.rotation_euler = (deg_te_down * DEG, 0, 0)


def cabin_doors(open_frac):
    for n, sgn in (('door_cabin_L', -1), ('door_cabin_R', 1)):
        o = obj(n)
        if o.get('_base') is None:
            o['_base'] = list(o.location)
        b = o['_base']
        o.location = (b[0] + sgn * 0.045 * min(1, open_frac * 8), b[1] - 1.74 * open_frac, b[2])


def screens():
    """Emissive MFD pages (captured from src/avionics, flipped to match the screen UV convention)."""
    pages = {1: 'pfd', 2: 'nd', 3: 'eng', 4: 'pfd'}
    for i, p in pages.items():
        o = obj(f'screen_mfd_{i}')
        if o is None:
            continue
        m = bpy.data.materials.new(f'mfd_page_{i}')
        m.use_nodes = True
        nt = m.node_tree
        b = nt.nodes['Principled BSDF']
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(os.path.join(HERE, 'refimg', f'mfd_{p}_flip.png'))
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        nt.links.new(t.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = 2.2
        b.inputs['Roughness'].default_value = 0.08
        b.inputs['Base Color'].default_value = (0, 0, 0, 1)
        o.data.materials.clear()
        o.data.materials.append(m)


def mat_simple(name, color, rough=0.8, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m


def mat_water(center=(0, 0), downwash=14.0):
    """Deep bay water: dark, glossy, multi-scale bump waves; rotor downwash roughens a ring around 'center'."""
    m = bpy.data.materials.new('water')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.006, 0.014, 0.018, 1)
    b.inputs['Roughness'].default_value = 0.035
    b.inputs['IOR'].default_value = 1.333
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Object'], sep.inputs['Vector'])
    # distance from the downwash centre
    dx = nt.nodes.new('ShaderNodeMath'); dx.operation = 'SUBTRACT'; dx.inputs[1].default_value = center[0]
    dy = nt.nodes.new('ShaderNodeMath'); dy.operation = 'SUBTRACT'; dy.inputs[1].default_value = center[1]
    nt.links.new(sep.outputs['X'], dx.inputs[0]); nt.links.new(sep.outputs['Y'], dy.inputs[0])
    cmb = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(dx.outputs[0], cmb.inputs['X']); nt.links.new(dy.outputs[0], cmb.inputs['Y'])
    ln = nt.nodes.new('ShaderNodeVectorMath'); ln.operation = 'LENGTH'
    nt.links.new(cmb.outputs['Vector'], ln.inputs[0])
    # downwash factor: 1 inside ~downwash m, fades out to 2x
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = downwash * 0.4
    mr.inputs['From Max'].default_value = downwash * 1.6
    mr.inputs['To Min'].default_value = 1.0
    mr.inputs['To Max'].default_value = 0.0
    nt.links.new(ln.outputs['Value'], mr.inputs['Value'])
    # waves: large swell (stretched), medium chop, fine ripples
    def noise(scale, detail, stretch=(1, 1, 1)):
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = stretch
        nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
        n = nt.nodes.new('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = 0.55
        nt.links.new(mp.outputs['Vector'], n.inputs['Vector'])
        return n.outputs['Fac']
    w1 = noise(0.04, 4, (1.0, 0.35, 1))
    w2 = noise(0.35, 6, (1.0, 0.6, 1))
    w3 = noise(3.0, 8)
    w4 = noise(9.0, 4)       # downwash ripples
    add = nt.nodes.new('ShaderNodeMath'); add.operation = 'MULTIPLY_ADD'
    nt.links.new(w2, add.inputs[0]); add.inputs[1].default_value = 0.5; nt.links.new(w1, add.inputs[2])
    add2 = nt.nodes.new('ShaderNodeMath'); add2.operation = 'MULTIPLY_ADD'
    nt.links.new(w3, add2.inputs[0]); add2.inputs[1].default_value = 0.12; nt.links.new(add.outputs[0], add2.inputs[2])
    dwm = nt.nodes.new('ShaderNodeMath'); dwm.operation = 'MULTIPLY'
    nt.links.new(w4, dwm.inputs[0]); nt.links.new(mr.outputs['Result'], dwm.inputs[1])
    add3 = nt.nodes.new('ShaderNodeMath'); add3.operation = 'MULTIPLY_ADD'
    nt.links.new(dwm.outputs[0], add3.inputs[0]); add3.inputs[1].default_value = 0.6; nt.links.new(add2.outputs[0], add3.inputs[2])
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = float(arg('--wave', 0.75))
    bump.inputs['Distance'].default_value = 0.6
    nt.links.new(add3.outputs[0], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    # roughness: calm glossy water, spray-roughened under the rotor
    rr = nt.nodes.new('ShaderNodeMapRange')
    rr.inputs['To Min'].default_value = 0.03
    rr.inputs['To Max'].default_value = float(arg('--dwrough', 0.06))
    nt.links.new(mr.outputs['Result'], rr.inputs['Value'])
    nt.links.new(rr.outputs['Result'], b.inputs['Roughness'])
    # foam / spray tint in the downwash ring
    ring = nt.nodes.new('ShaderNodeMapRange')
    ring.inputs['From Min'].default_value = downwash * 0.2
    ring.inputs['From Max'].default_value = downwash * 1.1
    ring.interpolation_type = 'SMOOTHSTEP'
    nt.links.new(ln.outputs['Value'], ring.inputs['Value'])
    foamn = nt.nodes.new('ShaderNodeMath'); foamn.operation = 'MULTIPLY'
    fn = noise(1.6, 10)
    fr = nt.nodes.new('ShaderNodeMapRange')
    fr.inputs['From Min'].default_value = 0.52
    fr.inputs['From Max'].default_value = 0.75
    nt.links.new(fn, fr.inputs['Value'])
    nt.links.new(fr.outputs['Result'], foamn.inputs[0])
    nt.links.new(mr.outputs['Result'], foamn.inputs[1])
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
    mix.inputs['A'].default_value = (0.006, 0.014, 0.018, 1)
    mix.inputs['B'].default_value = (0.62, 0.66, 0.66, 1)
    fm = nt.nodes.new('ShaderNodeMath'); fm.operation = 'MULTIPLY'; fm.inputs[1].default_value = float(arg('--foam', 0.12))
    nt.links.new(foamn.outputs[0], fm.inputs[0])
    nt.links.new(fm.outputs[0], mix.inputs['Factor'])
    nt.links.new(mix.outputs['Result'], b.inputs['Base Color'])
    return m


def spray_volume(center, radius=13.0, height=2.5):
    """Low mist of rotor-wash spray: a torus-ish cylinder with noisy volume scatter."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=radius, depth=height, location=(center[0], center[1], height / 2 - 0.05))
    c = bpy.context.active_object
    c.name = 'spray'
    m = bpy.data.materials.new('spray')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes['Principled BSDF'])
    out = nt.nodes['Material Output']
    vs = nt.nodes.new('ShaderNodeVolumePrincipled')
    vs.inputs['Color'].default_value = (0.95, 0.96, 0.97, 1)
    try:
        vs.inputs['Anisotropy'].default_value = 0.4
    except KeyError:
        pass
    tc = nt.nodes.new('ShaderNodeTexCoord')
    n = nt.nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = 0.6
    n.inputs['Detail'].default_value = 6
    nt.links.new(tc.outputs['Object'], n.inputs['Vector'])
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Object'], sep.inputs['Vector'])
    # radial ring profile * height falloff * noise
    ln = nt.nodes.new('ShaderNodeVectorMath'); ln.operation = 'LENGTH'
    cmb = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(sep.outputs['X'], cmb.inputs['X']); nt.links.new(sep.outputs['Y'], cmb.inputs['Y'])
    nt.links.new(cmb.outputs['Vector'], ln.inputs[0])
    ring = nt.nodes.new('ShaderNodeFloatCurve')
    cm = ring.mapping
    cm.clip_max_x = radius
    pts = cm.curves[0].points
    pts[0].location = (0.0, 0.25)
    pts[1].location = (1.0, 0.0)
    pts.new(0.55, 1.0)
    pts.new(0.3, 0.6)
    ring.inputs['Factor'].default_value = 1.0
    div = nt.nodes.new('ShaderNodeMath'); div.operation = 'DIVIDE'; div.inputs[1].default_value = radius
    nt.links.new(ln.outputs['Value'], div.inputs[0])
    nt.links.new(div.outputs[0], ring.inputs['Value'])
    hz = nt.nodes.new('ShaderNodeMapRange')
    hz.inputs['From Min'].default_value = -height / 2
    hz.inputs['From Max'].default_value = height / 2
    hz.inputs['To Min'].default_value = 1.0
    hz.inputs['To Max'].default_value = 0.0
    nt.links.new(sep.outputs['Z'], hz.inputs['Value'])
    m1 = nt.nodes.new('ShaderNodeMath'); m1.operation = 'MULTIPLY'
    nt.links.new(ring.outputs['Value'], m1.inputs[0]); nt.links.new(hz.outputs['Result'], m1.inputs[1])
    nr = nt.nodes.new('ShaderNodeMapRange')
    nr.inputs['From Min'].default_value = 0.45
    nr.inputs['From Max'].default_value = 0.8
    nt.links.new(n.outputs['Fac'], nr.inputs['Value'])
    m2 = nt.nodes.new('ShaderNodeMath'); m2.operation = 'MULTIPLY'
    nt.links.new(m1.outputs[0], m2.inputs[0]); nt.links.new(nr.outputs['Result'], m2.inputs[1])
    m3 = nt.nodes.new('ShaderNodeMath'); m3.operation = 'MULTIPLY'; m3.inputs[1].default_value = float(arg('--spray', 0.14))
    nt.links.new(m2.outputs[0], m3.inputs[0])
    nt.links.new(m3.outputs[0], vs.inputs['Density'])
    nt.links.new(vs.outputs['Volume'], out.inputs['Volume'])
    c.data.materials.append(m)
    return c


def hills(dist=5200, az_center_deg=225, span_deg=140, h=320, seed=3, color=(0.05, 0.06, 0.055), name='hills'):
    """Distant ridge line (a vertical strip mesh on a circle arc) standing for the Bay Area hills."""
    rng = np.random.default_rng(seed)
    n = 220
    verts, faces = [], []
    ph = rng.uniform(0, 10, 4)
    for i in range(n + 1):
        a = math.radians(az_center_deg - span_deg / 2 + span_deg * i / n)
        t = i / n
        hh = h * (0.35 + 0.35 * math.sin(t * 7 + ph[0]) ** 2 + 0.2 * math.sin(t * 19 + ph[1]) + 0.1 * math.sin(t * 53 + ph[2]))
        hh = max(20, hh)
        x, y = dist * math.cos(a), dist * math.sin(a)
        verts += [(x, y, -5), (x, y, hh)]
    for i in range(n):
        faces.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    m = bpy.data.materials.new(name + '_m')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    n = nt.nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = 0.004
    n.inputs['Detail'].default_value = 10
    nt.links.new(tc.outputs['Object'], n.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (color[0] * 0.55, color[1] * 0.55, color[2] * 0.6, 1)
    ramp.color_ramp.elements[1].color = (color[0] * 1.3, color[1] * 1.25, color[2] * 1.2, 1)
    nt.links.new(n.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.95
    ob.data.materials.append(m)
    return ob


def terrain_hills(r0=2600, r1=9000, az_center=225, span=160, hmax=420, seed=4, name='terrain', nr=90, na=360,
                  dry=(0.30, 0.22, 0.12), green=(0.05, 0.07, 0.035)):
    """Distant Bay-Area-like hills: polar grid of ridged fBm heights, rising from the shoreline at r0."""
    rng = np.random.default_rng(seed)
    g = rng.standard_normal((96, 96))
    from math import cos, sin
    def vnoise(x, y, scale):
        # bilinear value noise on a wrapped lattice
        u, v = x / scale, y / scale
        i0, j0 = np.floor(u).astype(int), np.floor(v).astype(int)
        fu, fv = u - i0, v - j0
        fu, fv = fu * fu * (3 - 2 * fu), fv * fv * (3 - 2 * fv)
        a = g[i0 % 96, j0 % 96]; b = g[(i0 + 1) % 96, j0 % 96]
        c = g[i0 % 96, (j0 + 1) % 96]; d = g[(i0 + 1) % 96, (j0 + 1) % 96]
        return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv
    rs = np.linspace(r0, r1, nr)
    As = np.radians(np.linspace(az_center - span / 2, az_center + span / 2, na))
    R, Aa = np.meshgrid(rs, As, indexing='ij')
    X, Y = R * np.cos(Aa), R * np.sin(Aa)
    h = np.zeros_like(X)
    amp, sc = 1.0, 2600.0
    for o in range(6):
        n = vnoise(X + 1000 * o, Y - 700 * o, sc)
        h += amp * (1 - np.abs(n)) ** 2          # ridged
        amp *= 0.5
        sc *= 0.5
    h = h / 1.9
    rise = np.clip((R - r0) / 900.0, 0, 1)
    rise = rise * rise * (3 - 2 * rise)
    H = hmax * h * rise * (0.6 + 0.4 * np.clip((R - r0) / (r1 - r0) * 2, 0, 1)) - 3
    verts = np.stack([X, Y, H], -1).reshape(-1, 3)
    faces = []
    for i in range(nr - 1):
        for j in range(na - 1):
            a0 = i * na + j
            faces.append((a0, a0 + 1, a0 + na + 1, a0 + na))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    m = bpy.data.materials.new(name + '_m')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    n1 = nt.nodes.new('ShaderNodeTexNoise')
    n1.inputs['Scale'].default_value = 0.0012
    n1.inputs['Detail'].default_value = 12
    n1.inputs['Roughness'].default_value = 0.65
    nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.50
    ramp.color_ramp.elements[0].color = (*green, 1)
    ramp.color_ramp.elements[1].position = 0.58
    ramp.color_ramp.elements[1].color = (*dry, 1)
    n2 = nt.nodes.new('ShaderNodeTexNoise')
    n2.inputs['Scale'].default_value = 0.012
    n2.inputs['Detail'].default_value = 8
    nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
    mixf = nt.nodes.new('ShaderNodeMath'); mixf.operation = 'MULTIPLY_ADD'
    nt.links.new(n2.outputs['Fac'], mixf.inputs[0]); mixf.inputs[1].default_value = 0.35
    nt.links.new(n1.outputs['Fac'], mixf.inputs[2])
    sub = nt.nodes.new('ShaderNodeMath'); sub.operation = 'SUBTRACT'; sub.inputs[1].default_value = 0.17
    nt.links.new(mixf.outputs[0], sub.inputs[0])
    nt.links.new(sub.outputs[0], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.95
    me.materials.append(m)
    return ob


def haze_box(size=26000, height=1400, density=0.00016, color=(0.80, 0.84, 0.92)):
    """Bounded homogeneous volume for aerial perspective (the world background stays visible above it)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, height / 2 - 1))
    c = bpy.context.active_object
    c.name = 'haze'
    c.scale = (size, size, height)
    m = bpy.data.materials.new('haze')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes['Principled BSDF'])
    v = nt.nodes.new('ShaderNodeVolumeScatter')
    v.inputs['Density'].default_value = density
    v.inputs['Color'].default_value = (*color, 1)
    v.inputs['Anisotropy'].default_value = 0.55
    nt.links.new(v.outputs['Volume'], nt.nodes['Material Output'].inputs['Volume'])
    c.data.materials.append(m)
    c.visible_shadow = False
    return c


def aerial_haze(density=0.00012, color=(0.75, 0.82, 0.92)):
    """(disabled: an unbounded world volume blacks out the sky background in Cycles)"""
    return
    w = bpy.context.scene.world
    nt = w.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_WORLD')
    v = nt.nodes.new('ShaderNodeVolumeScatter')
    v.inputs['Density'].default_value = density
    v.inputs['Color'].default_value = (*color, 1)
    v.inputs['Anisotropy'].default_value = 0.6
    nt.links.new(v.outputs['Volume'], out.inputs['Volume'])


# ------------------------------------------------------------------------------------------------------------ shots
def shot_lookdev():
    sc = setup(int(arg('--samples', 64)), 1600, 900)
    base_setup()
    blades(-3.2)
    stabilator(40)
    world_sky(38, 200, strength=float(arg('--sky', 0.25)), exposure=float(arg('--exp', 0.0)))
    ground_plane(300, mat_concrete())
    rig_empty((0, 0, CG[2]))
    c = [float(v) for v in arg('--cam', '10.5,11.5,3.2').split(',')]
    t = [float(v) for v in arg('--look', '0,0.8,1.6').split(',')]
    camera(c, t, float(arg('--lens', 40)))
    if arg('--doors'):
        cabin_doors(1.0)
    render(arg('--out', os.path.join('/tmp', 'uh60_lookdev.png')))


def shot_hero():
    sc = setup(int(arg('--samples', 256)), 2560, 1440)
    base_setup()
    blades(4.0, 9.0)
    stabilator(36)
    alt = float(arg('--alt', 6.3))
    rig_empty((0, 0, alt), pitch=-3.0 * DEG, roll=-2.5 * DEG, heading=math.radians(float(arg('--hdg', 8))))
    spin_rotors(1.0, fps=24, shutter=0.5)
    world_sky(float(arg('--sunel', 6.0)), float(arg('--sunaz', 125)), strength=float(arg('--sky', 0.32)), exposure=float(arg('--exp', -0.55)))
    ground_plane(20000, mat_water((0, 0), float(arg('--dw', 7.0))), z=0.0)
    if arg('--spray'):
        spray_volume((0, 0), 9.0, 1.2)
    terrain_hills(float(arg('--hillr', 5200)), 14000, 222, 170, float(arg('--hillh', 280)), 4, 'terrain_far',
                  dry=(0.13, 0.105, 0.07), green=(0.025, 0.036, 0.022))
    haze_box(density=float(arg('--haze', 0.00006)), color=(0.55, 0.68, 0.95))
    c = [float(v) for v in arg('--cam', '22,22,8.8').split(',')]
    t = [float(v) for v in arg('--look', '0,0.4,5.9').split(',')]
    d = (Vector(c) - Vector(t)).length
    camera(c, t, float(arg('--lens', 58)), dof=(d, 8.0))
    render(arg('--out', os.path.join(OUT, 'hero.png')))


def helipad_markings(path):
    """Helipad marking texture (30 x 30 m): white touchdown circle, white H, yellow perimeter."""
    from PIL import Image, ImageDraw   # noqa (not available in Blender's python) -> fallback below
    return path


def shot_helipad():
    sc = setup(int(arg('--samples', 192)), 1920, 1080)
    base_setup()
    blades(-3.4)
    stabilator(40)
    world_sky(float(arg('--sunel', 24)), float(arg('--sunaz', 115)), strength=0.28, exposure=float(arg('--exp', -1.1)))
    airfield_ground(True, 231, 7)
    rig_empty((0, 0, CG[2]), heading=math.radians(0))
    c = [float(v) for v in arg('--cam', '11.5,14.0,2.4').split(',')]
    t = [float(v) for v in arg('--look', '0.3,0.9,2.0').split(',')]
    camera(c, t, float(arg('--lens', 40)), dof=((Vector(c) - Vector(t)).length, 8.0))
    render(arg('--out', os.path.join(OUT, 'helipad.png')))


def shot_side():
    sc = setup(int(arg('--samples', 192)), 1920, 1080)
    base_setup()
    blades(-3.4)
    stabilator(40)
    cabin_doors(1.0)
    world_sky(float(arg('--sunel', 30)), float(arg('--sunaz', 70)), strength=0.28, exposure=float(arg('--exp', -1.1)))
    airfield_ground(True, 180, 9)
    rig_empty((0, 0, CG[2]))
    c = [float(v) for v in arg('--cam', '23.5,-2.2,2.6').split(',')]
    t = [float(v) for v in arg('--look', '0.0,-2.2,2.0').split(',')]
    camera(c, t, float(arg('--lens', 38)))
    render(arg('--out', os.path.join(OUT, 'side_doors_open.png')))


def shot_cockpit():
    sc = setup(int(arg('--samples', 256)), 1920, 1080)
    base_setup()
    blades(-3.4)
    screens()
    sc.view_settings.look = arg('--look_', 'AgX - Medium High Contrast')
    world_sky(float(arg('--sunel', 38)), float(arg('--sunaz', 60)), strength=0.28, exposure=float(arg('--exp', -0.3)))
    airfield_ground(True, 90, 11)
    rig_empty((0, 0, CG[2]))
    c = [float(v) for v in arg('--cam', '-0.50,2.62,1.84').split(',')]
    t = [float(v) for v in arg('--look', '0.30,3.52,1.30').split(',')]
    off = Vector((0, -CG[1], 0))       # G -> world: the placer sits at the CG; G origin is 0.35 m ahead
    cam = camera(Vector(c) + off, Vector(t) + off, float(arg('--lens', 17)))
    cam.data.clip_start = 0.02
    render(arg('--out', os.path.join(OUT, 'cockpit.png')))


def shot_rotorhead():
    """Close 3/4 front-right view of the main rotor head from a maintenance-stand height."""
    sc = setup(int(arg('--samples', 192)), 1920, 1080)
    base_setup()
    blades(-3.4)
    stabilator(40)
    world_sky(float(arg('--sunel', 32)), float(arg('--sunaz', 115)), strength=0.28, exposure=float(arg('--exp', -1.1)))
    airfield_ground(True, 231, 7)
    rig_empty((0, 0, CG[2]))
    off = Vector((0, -CG[1], 0))
    c = [float(v) for v in arg('--cam', '2.5,2.9,4.25').split(',')]
    t = [float(v) for v in arg('--look', '0.0,-0.05,3.30').split(',')]
    camera(Vector(c) + off, Vector(t) + off, float(arg('--lens', 32)))
    render(arg('--out', os.path.join(OUT, 'rotorhead.png')))


def shot_cabin():
    """Cabin interior seen through the open right cabin door."""
    sc = setup(int(arg('--samples', 192)), 1920, 1080)
    base_setup()
    blades(-3.4)
    stabilator(40)
    cabin_doors(1.0)
    world_sky(float(arg('--sunel', 30)), float(arg('--sunaz', 70)), strength=0.28, exposure=float(arg('--exp', -1.1)))
    airfield_ground(True, 180, 9)
    rig_empty((0, 0, CG[2]))
    off = Vector((0, -CG[1], 0))
    c = [float(v) for v in arg('--cam', '2.95,0.30,1.72').split(',')]
    t = [float(v) for v in arg('--look', '-0.5,-0.25,1.05').split(',')]
    cam = camera(Vector(c) + off, Vector(t) + off, float(arg('--lens', 18)))
    cam.data.clip_start = 0.02
    render(arg('--out', os.path.join(OUT, 'cabin.png')))


def shot_cockpit_ref():
    """Cockpit from behind and between the seats, the viewpoint of the reference photo (DVIDS 815181)."""
    sc = setup(int(arg('--samples', 192)), 1920, 1080)
    base_setup()
    blades(-3.4)
    screens()
    sc.view_settings.look = arg('--look_', 'AgX - Medium High Contrast')
    world_sky(float(arg('--sunel', 34)), float(arg('--sunaz', 20)), strength=0.28, exposure=float(arg('--exp', 0.4)))
    airfield_ground(True, 90, 11)
    rig_empty((0, 0, CG[2]))
    off = Vector((0, -CG[1], 0))
    c = [float(v) for v in arg('--cam', '0.0,2.78,1.93').split(',')]
    t = [float(v) for v in arg('--look', '0.0,3.60,1.18').split(',')]
    cam = camera(Vector(c) + off, Vector(t) + off, float(arg('--lens', 15)))
    cam.data.clip_start = 0.02
    render(arg('--out', os.path.join(OUT, 'cockpit_ref.png')))


def shot_front():
    """Head-on at standing height (reference: exterior_front_01)."""
    sc = setup(int(arg('--samples', 192)), 1920, 1080)
    base_setup()
    blades(-3.4)
    stabilator(40)
    world_sky(float(arg('--sunel', 30)), float(arg('--sunaz', 150)), strength=0.28, exposure=float(arg('--exp', -1.1)))
    airfield_ground(True, 20, 5)
    rig_empty((0, 0, CG[2]))
    off = Vector((0, -CG[1], 0))
    c = [float(v) for v in arg('--cam', '0.35,13.15,1.55').split(',')]
    t = [float(v) for v in arg('--look', '0.0,2.65,1.75').split(',')]
    camera(Vector(c) + off, Vector(t) + off, float(arg('--lens', 60)))
    render(arg('--out', os.path.join(OUT, 'front.png')))


def main():
    bpy.ops.wm.open_mainfile(filepath=arg('--blend', BLEND))
    shots = {'lookdev': shot_lookdev, 'hero': shot_hero, 'helipad': shot_helipad, 'side': shot_side, 'cockpit': shot_cockpit,
             'rotorhead': shot_rotorhead, 'cabin': shot_cabin, 'cockpit_ref': shot_cockpit_ref, 'front': shot_front}
    shots.get(SHOT, shot_lookdev)()


if __name__ == '__main__':
    main()
