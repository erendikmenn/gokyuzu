"""W3 hero renders ("gerçek renderlar") of the landmarks in Cycles.

Run:  Blender -b -P blender/landmarks/render.py -- <scene> [--preview] [--samples N]
Scenes: ggb_golden_hour, bay_bridge_dusk, downtown_skyline, alcatraz, ggb_fog, (see SCENES)

Context: 3DEP DEM + NAIP imagery patches (tools/geo/landmarks_context.py, generated on demand from W1's raw caches),
the city tiles built by W2 (assets/sf/city/l*/ imported read-only and snapped to the DEM like the runtime does), a water
plane, Nishita multiple-scattering sky and an atmospheric volume. The landmarks are the same LOD0 geometry/materials as
the game assets, built by the W3 builders.
World frame in Blender: X = local x (east), Y = -local z (north), Z = meters MSL.
"""
import json
import math
import os
import subprocess
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lmkit import REPO, LAYOUT, reset_scene  # noqa: E402

CACHE = os.path.join(REPO, 'data', 'sf', 'cache', 'landmarks')
RENDERS = os.path.join(REPO, 'renders', 'landmarks')
PY = os.path.join(REPO, '.venv', 'bin', 'python')

# ------------------------------------------------------------------------------------------------ scenes
SCENES = {
    # Battery Spencer (Marin headlands) at golden hour: north tower, main span, San Francisco behind
    'ggb_golden_hour': dict(
        cam=(-9925.0, 116.0, -23125.0), look=(-9268.0, 112.0, -22380.0), lens=30.0, size=(2560, 1440),
        sun_el=3.2, sun_az=290.0, exposure=-1.55, haze=4e-6, samples=256, clouds=0.5, air=1.35,
        near=('ggb_near', -11600, -24400, -8200, -20600, 3.0, 1.0),
        far=('bay_far', -22000, -34000, 16000, 0, 32.0, 12.0),
        landmarks=['golden_gate', 'fort_point', 'alcatraz', 'palace_of_fine_arts', 'transamerica', 'salesforce', 'coit',
                   'bay_bridge_west', 'sutro'],
        city=dict(level='l2', radius=16000)),
    # Bay Bridge west span at dusk from Treasure Island / YBI north shore, looking SW to the city
    'bay_bridge_dusk': dict(
        cam=(-260.0, 38.0, -22230.0), look=(-1150.0, 88.0, -19620.0), lens=30.0, size=(2560, 1440),
        sun_el=1.2, sun_az=262.0, exposure=-0.9, haze=6e-6, samples=256, night=0.6,
        near=('bb_near', -3200, -22800, 2400, -17600, 3.0, 2.0),
        far=('bay_far', -22000, -34000, 16000, 0, 32.0, 12.0),
        landmarks=['bay_bridge_west', 'bay_bridge_east', 'transamerica', 'salesforce', 'coit', 'ferry', 'sutro', 'golden_gate'],
        city=dict(level='l1', radius=7000, far_level='l2', far_radius=16000)),
    # downtown skyline from the water east of the Ferry Building, morning light
    'downtown_skyline': dict(
        cam=(-800.0, 70.0, -20150.0), look=(-2300.0, 115.0, -19400.0), lens=32.0, size=(2560, 1440),
        sun_el=22.0, sun_az=108.0, exposure=-2.3, haze=5e-6, samples=256,
        near=('dt_near', -4600, -21600, 400, -17400, 3.0, 1.0),
        far=('bay_far', -22000, -34000, 16000, 0, 32.0, 12.0),
        landmarks=['transamerica', 'salesforce', 'coit', 'ferry', 'bay_bridge_west', 'sutro', 'city_hall', 'oracle_park'],
        city=dict(level='l0', radius=4000, far_level='l2', far_radius=16000)),
    # Alcatraz from the air (north-west), city behind
    'alcatraz': dict(
        cam=(-4950.0, 230.0, -23620.0), look=(-4380.0, 25.0, -23000.0), lens=35.0, size=(2560, 1440),
        sun_el=24.0, sun_az=235.0, exposure=-2.4, haze=4e-6, samples=256, grade=(0.78, 0.78, 0.76),
        near=('alc_near', -5400, -24000, -3400, -22200, 2.0, 0.5),
        far=('bay_far', -22000, -34000, 16000, 0, 32.0, 12.0),
        landmarks=['alcatraz', 'transamerica', 'salesforce', 'coit', 'bay_bridge_west', 'golden_gate', 'pier_39', 'ferry'],
        city=dict(level='l2', radius=16000)),
}


# ------------------------------------------------------------------------------------------------ helpers
def W(x, y, z):
    """Local game coords (x east, y up, z south) -> Blender world."""
    return (x, -z, y)


class DEM:
    """Bilinear sampling of one or more DEM patches (near first)."""

    def __init__(self, names):
        self.p = []
        for n in names:
            meta = json.load(open(os.path.join(CACHE, f'{n}.json')))
            self.p.append((meta, np.load(os.path.join(CACHE, f'{n}_dem.npy'))))

    def h(self, x, z):
        for m, a in self.p:
            fx = (x - m['x0']) / m['dem_res']
            fz = (z - m['z0']) / m['dem_res']
            if 0 <= fx < a.shape[1] - 1 and 0 <= fz < a.shape[0] - 1:
                i, j = int(fx), int(fz)
                tx, tz = fx - i, fz - j
                return float(a[j, i] * (1 - tx) * (1 - tz) + a[j, i + 1] * tx * (1 - tz) + a[j + 1, i] * (1 - tx) * tz + a[j + 1, i + 1] * tx * tz)
        return 0.0


def ensure_patch(spec):
    name, x0, z0, x1, z1, dres, ires = spec
    if not os.path.exists(os.path.join(CACHE, f'{name}_dem.npy')):
        subprocess.check_call([PY, os.path.join(REPO, 'tools', 'geo', 'landmarks_context.py'), 'patch', name,
                               str(x0), str(z0), str(x1), str(z1), str(dres), str(ires)])
    return name


def terrain_object(name, hole=None, drop=0.0, rough=0.92, grade=(1.0, 1.0, 1.0)):
    meta = json.load(open(os.path.join(CACHE, f'{name}.json')))
    a = np.load(os.path.join(CACHE, f'{name}_dem.npy')).astype(np.float64)
    h, w = a.shape
    xs = meta['x0'] + np.arange(w) * meta['dem_res']
    zs = meta['z0'] + np.arange(h) * meta['dem_res']
    X, Z = np.meshgrid(xs, zs)
    H = np.maximum(a, -6.0)
    H = np.where(H < 0.4, H - 2.5, H)          # water areas sink below the water plane
    if hole is not None:
        hx0, hz0, hx1, hz1 = hole
        inside = (X > hx0 + 30) & (X < hx1 - 30) & (Z > hz0 + 30) & (Z < hz1 - 30)
        H = np.where(inside, H - drop, H)
    verts = np.stack([X.ravel(), -Z.ravel(), H.ravel()], axis=1)
    ii, jj = np.meshgrid(np.arange(w - 1), np.arange(h - 1))
    a0 = (jj * w + ii).ravel()
    faces = np.stack([a0, a0 + w, a0 + w + 1, a0 + 1], axis=1)      # CCW seen from +Z (y = -z flips)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.ravel())
    me.loops.add(faces.size)
    me.loops.foreach_set('vertex_index', faces.ravel())
    me.polygons.add(len(faces))
    me.polygons.foreach_set('loop_start', np.arange(0, faces.size, 4))
    me.polygons.foreach_set('loop_total', np.full(len(faces), 4))
    uv = me.uv_layers.new(name='UVMap')
    U = (verts[faces.ravel(), 0] - meta['x0']) / (meta['x1'] - meta['x0'])
    Vv = 1.0 - ((-verts[faces.ravel(), 1]) - meta['z0']) / (meta['z1'] - meta['z0'])
    uv.data.foreach_set('uv', np.stack([U, Vv], axis=1).ravel())
    me.update()
    me.polygons.foreach_set('use_smooth', [True] * len(faces))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    # material: NAIP orthophoto, graded
    m = bpy.data.materials.new(name + '_mat')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = bpy.data.images.load(os.path.join(CACHE, f'{name}_img.jpg'))
    t.extension = 'EXTEND'
    hsv = nt.nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = 1.15
    hsv.inputs['Value'].default_value = 0.92
    nt.links.new(t.outputs['Color'], hsv.inputs['Color'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    mix.inputs[7].default_value = (*grade, 1.0)
    nt.links.new(hsv.outputs['Color'], mix.inputs[6])
    nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    try:
        bsdf.inputs['Specular IOR Level'].default_value = 0.25
    except KeyError:
        pass
    me.materials.append(m)
    return ob


def water_plane(night=0.0):
    me = bpy.data.meshes.new('water')
    s = 60000.0
    me.from_pydata([(-s, -s, 0.0), (s, -s, 0.0), (s, s, 0.0), (-s, s, 0.0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new('water', me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (0, 20000, 0)
    m = bpy.data.materials.new('water_mat')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.010, 0.030, 0.034, 1)
    b.inputs['Roughness'].default_value = 0.13
    b.inputs['IOR'].default_value = 1.333
    coord = nt.nodes.new('ShaderNodeTexCoord')
    # large swells + mid chop + fine ripples (world-space procedural bump)
    layers = []
    for scale, stretch, detail in ((0.0035, (1.0, 1.8, 1.0), 3.0), (0.03, (1.0, 1.6, 1.0), 5.0), (0.35, (1.0, 1.3, 1.0), 4.0)):
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = tuple(scale * k for k in stretch)
        nt.links.new(coord.outputs['Object'], mp.inputs['Vector'])
        nz = nt.nodes.new('ShaderNodeTexNoise')
        nz.inputs['Scale'].default_value = 1.0
        nz.inputs['Detail'].default_value = detail
        nz.inputs['Roughness'].default_value = 0.55
        nt.links.new(mp.outputs['Vector'], nz.inputs['Vector'])
        layers.append(nz)
    acc = layers[0].outputs['Fac']
    for nz, wgt in ((layers[1], 0.6), (layers[2], 0.25)):
        mu = nt.nodes.new('ShaderNodeMath')
        mu.operation = 'MULTIPLY_ADD'
        mu.inputs[1].default_value = wgt
        nt.links.new(nz.outputs['Fac'], mu.inputs[0])
        nt.links.new(acc, mu.inputs[2])
        acc = mu.outputs[0]
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.55
    bump.inputs['Distance'].default_value = 1.2
    nt.links.new(acc, bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    me.materials.append(m)
    return ob


def sky(sc, el, az, strength=1.0, haze=2e-5, night=0.0):
    world = bpy.data.worlds.new('Sky')
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    s = nt.nodes.new('ShaderNodeTexSky')
    s.sky_type = 'MULTIPLE_SCATTERING'
    s.sun_elevation = math.radians(el)
    s.sun_rotation = math.radians(az)
    s.altitude = 60.0
    s.air_density = AIR
    s.aerosol_density = 1.1
    s.sun_intensity = 1.0 - 0.6 * night
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(s.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    if haze > 0:
        haze_slab(haze)
    return world


def haze_slab(density, top=2500.0):
    """Finite atmospheric haze: a 90 km x 90 km slab, density falling off with height (scale height ~900 m)."""
    me = bpy.data.meshes.new('haze')
    s = 45000.0
    v = [(-s, -s, -20), (s, -s, -20), (s, s, -20), (-s, s, -20), (-s, -s, top), (s, -s, top), (s, s, top), (-s, s, top)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me.from_pydata(v, [], f)
    ob = bpy.data.objects.new('haze', me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (0, 20000, 0)
    m = bpy.data.materials.new('haze_mat')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    vol = nt.nodes.new('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = (1.0, 0.98, 0.96, 1)
    vol.inputs['Anisotropy'].default_value = 0.6
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Position'], sep.inputs['Vector'])
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = -1.0 / 900.0
    nt.links.new(sep.outputs['Z'], mul.inputs[0])
    ex = nt.nodes.new('ShaderNodeMath')
    ex.operation = 'EXPONENT'
    nt.links.new(mul.outputs[0], ex.inputs[0])
    sc = nt.nodes.new('ShaderNodeMath')
    sc.operation = 'MULTIPLY'
    sc.inputs[1].default_value = density
    nt.links.new(ex.outputs[0], sc.inputs[0])
    nt.links.new(sc.outputs[0], vol.inputs['Density'])
    nt.links.new(vol.outputs['Volume'], out.inputs['Volume'])
    me.materials.append(m)
    return ob


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, import_shading='NORMALS')
    return [o for o in bpy.data.objects if o not in before]


def city(dem, spec, cam_xz):
    """Import W2 city tiles around the camera and place them on the DEM like src/world-sf/city.js does."""
    idx = json.load(open(os.path.join(REPO, 'assets', 'sf', 'city', 'index.json')))
    levels = {L['dir']: L for L in idx['levels']}
    jobs = [(spec['level'], 0.0, spec['radius'])]
    if spec.get('far_level'):
        jobs.append((spec['far_level'], spec['radius'], spec['far_radius']))
    n = 0
    for lvl, r0, r1 in jobs:
        L = levels[lvl]
        for t in L['tiles']:
            cx = (t['minX'] + t['maxX']) / 2
            cz = (t['minZ'] + t['maxZ']) / 2
            d = math.hypot(cx - cam_xz[0], cz - cam_xz[1])
            if not (r0 - L['size'] <= d <= r1):
                continue
            if r0 > 0 and d < r0:
                continue
            path = os.path.join(REPO, 'assets', 'sf', 'city', L['dir'], f"{t['i']}_{t['j']}.glb")
            if not os.path.exists(path):
                continue
            meta = json.load(open(path[:-4] + '.json'))
            tcx, tcz = meta['center']
            try:
                obs = import_glb(path)
            except Exception as e:
                print('tile import failed', path, e)
                continue
            for ob in obs:
                if ob.type != 'MESH':
                    continue
                me = ob.data
                co = np.zeros(len(me.vertices) * 3)
                me.vertices.foreach_get('co', co)
                co = co.reshape(-1, 3)
                # glTF import: blender (x, y, z) = (three x, -three z, three y); tile-local coordinates
                if L['placement'] == 'anchor' and len(me.uv_layers) > 1:
                    uvl = me.uv_layers[1]
                    uv = np.zeros(len(me.loops) * 2)
                    uvl.data.foreach_get('uv', uv)
                    uv = uv.reshape(-1, 2)
                    vi = np.zeros(len(me.loops), dtype=np.int64)
                    me.loops.foreach_get('vertex_index', vi)
                    anc = np.zeros((len(me.vertices), 2))
                    anc[vi] = uv
                    ax, az = anc[:, 0] + tcx, (1.0 - anc[:, 1]) + tcz
                    cache = {}
                    for k in range(len(co)):
                        key = (round(ax[k] * 4), round(az[k] * 4))
                        g = cache.get(key)
                        if g is None:
                            g = dem.h(ax[k], az[k])
                            cache[key] = g
                        if co[k, 2] < 0.05:
                            co[k, 2] = min(g, dem.h(co[k, 0] + tcx, -co[k, 1] + tcz)) - 1.5
                        else:
                            co[k, 2] += g
                else:
                    for k in range(len(co)):
                        g = dem.h(co[k, 0] + tcx, -co[k, 1] + tcz)
                        co[k, 2] = g - 2.0 if co[k, 2] < 0.05 else co[k, 2] + g
                me.vertices.foreach_set('co', co.ravel())
                me.update()
                ob.location = (tcx, -tcz, 0.0)
                n += 1
    print(f'city: {n} tile objects')


# ------------------------------------------------------------------------------------------------ landmarks
NIGHT = 0.0
AIR = 1.0


def cloud_layer(cover=0.5, z=6500.0):
    """High cirrus: a translucent sheet whose coverage comes from stretched procedural noise (lit by the sun)."""
    me = bpy.data.meshes.new('cirrus')
    s = 60000.0
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new('cirrus', me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (0, 20000, z)
    m = bpy.data.materials.new('cirrus_mat')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    coord = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (0.00004, 0.00022, 1.0)
    mp.inputs['Rotation'].default_value = (0, 0, math.radians(35))
    nt.links.new(coord.outputs['Object'], mp.inputs['Vector'])
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Detail'].default_value = 8.0
    nz.inputs['Roughness'].default_value = 0.62
    nz.inputs['Distortion'].default_value = 0.6
    nt.links.new(mp.outputs['Vector'], nz.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.60 - 0.12 * cover
    ramp.color_ramp.elements[1].position = 0.80 - 0.08 * cover
    nt.links.new(nz.outputs['Fac'], ramp.inputs['Fac'])
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    tl = nt.nodes.new('ShaderNodeBsdfTranslucent')
    tl.inputs['Color'].default_value = (1, 1, 1, 1)
    df = nt.nodes.new('ShaderNodeBsdfDiffuse')
    add = nt.nodes.new('ShaderNodeAddShader')
    nt.links.new(tl.outputs[0], add.inputs[0])
    nt.links.new(df.outputs[0], add.inputs[1])
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(ramp.outputs['Color'], mix.inputs['Fac'])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(add.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    me.materials.append(m)
    ob.visible_shadow = False
    return ob


def glow_points(lights, name, color, strength, size):
    """Small emissive cubes at landmark light positions (meta lights are in Three local coords)."""
    from lmkit import MB
    mb = MB(name)
    for L in lights:
        x, y, z = L['p'][0], -L['p'][2], L['p'][1]
        mb.box((x - size, y - size, z - size), (x + size, y + size, z + size))
    m = bpy.data.materials.new(name + '_mat')
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Emission Color'].default_value = (*color, 1)
    bsdf.inputs['Emission Strength'].default_value = strength
    return mb.to_object(name, m)


def night_emission(objs):
    """Night-only emission (windows, street lamps, floodlights, LED crowns) scaled by the scene's night factor;
    aviation warning lights stay on."""
    for o in objs:
        for slot in getattr(o, 'material_slots', []):
            m = slot.material
            if not m or '_emit' not in m.name or 'warn' in m.name or m.get('_nightscaled'):
                continue
            m['_nightscaled'] = True
            b = m.node_tree.nodes.get('Principled BSDF') if m.node_tree else None
            if b:
                b.inputs['Emission Strength'].default_value *= NIGHT


def place(objs, origin, heading, z=0.0):
    night_emission(objs)
    for o in objs:
        o.location = (origin[0], -origin[1], z)
        o.rotation_euler = (0.0, 0.0, -heading)
        o.hide_render = False
        o.hide_set(False)


def add_landmark(key, dem):
    """Build a landmark at LOD0 with the W3 builders and place it in the world frame."""
    import importlib
    if key == 'golden_gate':
        gg = importlib.import_module('golden_gate')
        b = gg.Bridge(0, gg.make_materials(0))
        b.build()
        place(b.objects('ggb'), (gg.G['origin']['x'], gg.G['origin']['z']), gg.G['heading'])
    elif key in ('bay_bridge_west', 'bay_bridge_east'):
        bb = importlib.import_module('bay_bridge')
        if key == 'bay_bridge_west':
            b = bb.West(0)
            b.build()
            obs = b.objects('bbw')
            if NIGHT > 0.3:
                obs.append(glow_points([L for L in b.meta.d['lights'] if L['c'] == '#f4f6ff'], 'bay_lights', (1.0, 1.0, 1.0), 18.0, 0.22))
                obs.append(glow_points([L for L in b.meta.d['lights'] if L['k'] == 'lamp' and L['c'] != '#f4f6ff'], 'bbw_lamps', (1.0, 0.78, 0.45), 30.0, 0.35))
            place(obs, (bb.WL['origin']['x'], bb.WL['origin']['z']), bb.WL['heading'])
        else:
            b = bb.East(0)
            b.build()
            place(b.objects('bbe'), (float(b.origin[0]), float(b.origin[1])), float(b.heading))
    elif key in ('transamerica', 'salesforce', 'coit', 'ferry', 'sutro'):
        tw = importlib.import_module('towers')
        fn, origin, heading, fp = {
            'transamerica': (tw.build_transamerica, tw.TAM_ORIGIN, tw.TAM_HEADING, [(-26, -26), (26, -26), (26, 26), (-26, 26)]),
            'salesforce': (tw.build_salesforce, tw.SF_ORIGIN, tw.SF_HEADING, [(-26, -26), (26, -26), (26, 26), (-26, 26)]),
            'coit': (tw.build_coit, tw.COIT_ORIGIN, 0.0, [(-8, -8), (8, -8), (8, 8), (-8, 8)]),
            'ferry': (tw.build_ferry, tw.FERRY_ORIGIN, tw.FERRY_HEADING, [(-20, -90), (20, -90), (20, 90), (-20, 90)]),
            'sutro': (tw.build_sutro, tw.SUTRO_C, tw.SUTRO_HEADING, [(0, 0)]),
        }[key]
        b = fn(0)
        c, s = math.cos(-heading), math.sin(-heading)
        gz = min(dem.h(origin[0] + lx * c + (-ly) * s, origin[1] - lx * s + (-ly) * c) for lx, ly in fp)
        place(b.objects(key), origin, heading, gz)
    else:
        st = importlib.import_module('sites')
        fn, origin, heading = {
            'alcatraz': (st.build_alcatraz, st.ALC_ORIGIN, 0.0), 'fort_point': (st.build_fortpoint, st.FP_ORIGIN, 0.0),
            'city_hall': (st.build_cityhall, st.CH_ORIGIN, 0.0), 'palace_of_fine_arts': (st.build_palace, st.PAL_ORIGIN, 0.0),
            'chase_center': (st.build_chase, st.CC_ORIGIN, 0.0), 'painted_ladies': (st.build_painted, st.PL_ORIGIN, 0.0),
            'pier_39': (st.build_pier39, st.PI_ORIGIN, 0.0), 'oracle_park': (st.build_oracle, st.OP_HOME, st.OP_HEADING),
        }[key]
        b = fn(0)
        place(b.objects(key), origin, heading, 0.0)


# ------------------------------------------------------------------------------------------------ main
def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['ggb_golden_hour']
    name = args[0]
    preview = '--preview' in args
    S = SCENES[name]
    global NIGHT, AIR
    NIGHT = S.get('night', 0.0)
    AIR = S.get('air', 1.0)
    t0 = time.time()
    reset_scene()
    sc = bpy.context.scene
    samples = S['samples'] if not preview else 24
    if '--samples' in args:
        samples = int(args[args.index('--samples') + 1])
    w, h = S['size'] if not preview else (960, 540)
    from util import setup_cycles
    setup_cycles(samples=samples, width=w, height=h, denoise=True, gpu='--cpu' not in args)
    if '--cpu' in args:
        sc.render.threads_mode = 'AUTO'
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.max_bounces = 6
    sc.cycles.volume_bounces = 1
    sc.cycles.volume_step_rate = 4.0
    sc.view_settings.look = 'AgX - Punchy' if name != 'bay_bridge_dusk' else 'AgX - Medium High Contrast'
    sc.view_settings.exposure = S.get('exposure', 0.0)
    near = ensure_patch(S['near'])
    far = ensure_patch(S['far'])
    dem = DEM([near, far])
    nb = S['near'][1:5]
    terrain_object(near, grade=S.get('grade', (1.0, 1.0, 1.0)))
    terrain_object(far, hole=nb, drop=6.0)
    water_plane(S.get('night', 0.0))
    if S.get('clouds'):
        cloud_layer(S['clouds'])
    sky(sc, S['sun_el'], S['sun_az'], haze=S['haze'], night=S.get('night', 0.0))
    if S.get('city') and os.path.exists(os.path.join(REPO, 'assets', 'sf', 'city', 'index.json')):
        try:
            city(dem, S['city'], (S['cam'][0], S['cam'][2]))
        except Exception as e:  # the city is context only: never fail the landmark render because of it
            print('city import failed:', e)
    for k in S['landmarks']:
        try:
            add_landmark(k, dem)
        except Exception as e:
            print('landmark failed', k, e)
            import traceback
            traceback.print_exc()
    from util import add_camera
    cam = add_camera(W(*S['cam']), W(*S['look']), lens=S['lens'])
    cam.data.clip_start = 0.5
    cam.data.clip_end = 90000
    out = os.path.join(RENDERS, f"{name}{'_preview' if preview else ''}.png")
    os.makedirs(RENDERS, exist_ok=True)
    print(f'setup {time.time() - t0:.1f} s, rendering {w}x{h} @ {samples} spp -> {out}')
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f'done in {time.time() - t0:.1f} s')
    if '--blend' in args:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(RENDERS, f'{name}.blend'))


if __name__ == '__main__':
    main()
