"""W4 "gerçek renderlar": Cycles renders of the airports, rebuilt from the same data the game uses.

  /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/airports/render_scene.py -- <shot> [--samples N] [--res WxH] [--preview]

shots: sfo_tower, sfo_28r, kngz_has, kngz_line, oak (see SHOTS). Scene content:
  terrain heightfield + aerial imagery + water from W1's pack (tools/geo/airports_render_terrain.py -> assets/sf/airports/render/),
  pavement + markings from <icao>.bin (same textures as the runtime, rubber deposits in a node shader),
  buildings (<icao>_buildings.glb), parked aircraft / vehicles (props.glb) on the stands, runway/approach lights as emitters.
Output: renders/airports/<shot>.png
"""
import sys, os, json, math, random
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'common'))
sys.path.insert(0, HERE)
import numpy as np
import bpy
from mathutils import Vector
from util import reset_scene, setup_cycles, REPO

A_DIR = os.path.join(REPO, 'assets', 'sf', 'airports')
TEX = os.path.join(A_DIR, 'tex')
R_DIR = os.path.join(A_DIR, 'render')
OUT = os.path.join(REPO, 'renders', 'airports')

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SHOT = argv[0] if argv else 'sfo_tower'
opt = lambda k, d: argv[argv.index(k) + 1] if k in argv else d

# cam / look: world local coordinates (x east, y up above ground, z south); sun azimuth deg clockwise from north
SHOTS = {
    'sfo_tower': dict(icao='ksfo', terrain='sfo', cam=(-380.0, 58.0, 880.0), look=(-1010.0, 26.0, 330.0), lens=42, sun=(16.0, 112.0), res=(2560, 1440), radius=1900, lights=False, aerosol=0.7),
    'sfo_28r': dict(icao='ksfo', terrain='sfo', cam=(1880.0, 24.0, 754.0), look=(995.0, 0.0, 295.0), lens=38, sun=(-1.0, 292.0), res=(1920, 1080), radius=4500, lights=True, dusk=True, aerosol=0.45, exposure=-2.0),
    'kngz_has': dict(icao='kngz', terrain='kngz', cam=(4078.0, 3.2, -18762.0), look=(4022.0, 4.5, -18796.0), lens=26, sun=(7.0, 258.0), res=(1920, 1080), radius=1500, lights=False, aerosol=0.8),
    'kngz_line': dict(icao='kngz', terrain='kngz', cam=(4836.0, 2.0, -18314.0), look=(4866.0, 2.6, -18300.0), lens=28, sun=(8.0, 258.0), res=(1920, 1080), radius=1500, lights=False, aerosol=0.8),
}


def load_airport(icao):
    meta = json.load(open(os.path.join(A_DIR, f'{icao}.json')))
    raw = open(os.path.join(A_DIR, meta['bin']), 'rb').read()
    T = {'f32': np.float32, 'u32': np.uint32, 'u16': np.uint16, 'u8': np.uint8}
    A = {k: np.frombuffer(raw, T[t], n, o) for k, (o, n, t) in meta['arrays'].items()}
    return meta, A


class Terrain:
    def __init__(self, name, ox, oz):
        self.m = json.load(open(os.path.join(R_DIR, f'{name}.json')))
        self.H = np.load(os.path.join(R_DIR, f'{name}_h.npy'))
        self.ox, self.oz = ox, oz
        self.name = name

    def h(self, x, z):
        """bilinear height at world local (x, z)"""
        m = self.m
        fx = (np.asarray(x) - m['hx0']) / m['hsp']
        fz = (np.asarray(z) - m['hz0']) / m['hsp']
        nz, nx = self.H.shape
        fx = np.clip(fx, 0, nx - 1.001)
        fz = np.clip(fz, 0, nz - 1.001)
        i, j = np.floor(fx).astype(int), np.floor(fz).astype(int)
        tx, tz = fx - i, fz - j
        H = self.H
        return (H[j, i] * (1 - tx) * (1 - tz) + H[j, i + 1] * tx * (1 - tz) + H[j + 1, i] * (1 - tx) * tz + H[j + 1, i + 1] * tx * tz)


# ------------------------------------------------------------------ materials
def img(name, path=None, non_color=False):
    im = bpy.data.images.load(path or os.path.join(TEX, name), check_existing=True)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    return im


def new_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    return m, m.node_tree, next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def terrain_material(t):
    m, nt, bsdf = new_mat('terrain')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img(None, os.path.join(R_DIR, f'{t.name}_img.jpg'))
    tex.extension = 'EXTEND'
    uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    # slight saturation/contrast lift of the orthophoto + fine noise bump
    hsv = nt.nodes.new('ShaderNodeHueSaturation'); hsv.inputs['Saturation'].default_value = 1.08; hsv.inputs['Value'].default_value = 0.95
    nt.links.new(tex.outputs['Color'], hsv.inputs['Color'])
    water = nt.nodes.new('ShaderNodeAttribute'); water.attribute_name = 'water'
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
    nt.links.new(water.outputs['Fac'], mix.inputs['Factor'])
    nt.links.new(hsv.outputs['Color'], mix.inputs['A'])
    mix.inputs['B'].default_value = (0.006, 0.016, 0.02, 1)
    nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    rough = nt.nodes.new('ShaderNodeMapRange')
    nt.links.new(water.outputs['Fac'], rough.inputs['Value'])
    rough.inputs['To Min'].default_value = 0.92; rough.inputs['To Max'].default_value = 0.07
    nt.links.new(rough.outputs['Result'], bsdf.inputs['Roughness'])
    # small waves on water
    noise = nt.nodes.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 0.35; noise.inputs['Detail'].default_value = 8
    coord = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(coord.outputs['Object'], noise.inputs['Vector'])
    bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.12
    nt.links.new(noise.outputs['Fac'], bump.inputs['Height'])
    mulb = nt.nodes.new('ShaderNodeMath'); mulb.operation = 'MULTIPLY'
    nt.links.new(water.outputs['Fac'], mulb.inputs[0]); mulb.inputs[1].default_value = 0.2
    nt.links.new(mulb.outputs['Value'], bump.inputs['Strength'])
    nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def smoothstep_node(nt, value_socket, a, b):
    n = nt.nodes.new('ShaderNodeMapRange')
    n.interpolation_type = 'SMOOTHSTEP'
    n.inputs['From Min'].default_value = a
    n.inputs['From Max'].default_value = b
    nt.links.new(value_socket, n.inputs['Value'])
    return n.outputs['Result']


def math_node(nt, op, a, b=None):
    n = nt.nodes.new('ShaderNodeMath')
    n.operation = op
    for k, s in enumerate((a, b)):
        if s is None:
            continue
        if isinstance(s, (int, float)):
            n.inputs[k].default_value = s
        else:
            nt.links.new(s, n.inputs[k])
    return n.outputs['Value']


def pavement_material(name, tex, tile, rough=0.9, rubber=False, tint=(1, 1, 1)):
    m, nt, bsdf = new_mat(name)
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(tex)
    uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
    # macro variation (object space, 512 m and 70 m)
    coord = nt.nodes.new('ShaderNodeTexCoord')
    mac = nt.nodes.new('ShaderNodeTexImage'); mac.image = img('macro.jpg', non_color=True)
    sc = nt.nodes.new('ShaderNodeVectorMath'); sc.operation = 'SCALE'; sc.inputs['Scale'].default_value = 1 / 512
    nt.links.new(coord.outputs['Object'], sc.inputs[0]); nt.links.new(sc.outputs['Vector'], mac.inputs['Vector'])
    mac2 = nt.nodes.new('ShaderNodeTexImage'); mac2.image = mac.image
    sc2 = nt.nodes.new('ShaderNodeVectorMath'); sc2.operation = 'SCALE'; sc2.inputs['Scale'].default_value = 1 / 70
    nt.links.new(coord.outputs['Object'], sc2.inputs[0]); nt.links.new(sc2.outputs['Vector'], mac2.inputs['Vector'])
    m1 = math_node(nt, 'MULTIPLY_ADD', mac.outputs['Color'], 0.6)
    n1 = nt.nodes[-1]; n1.inputs[2].default_value = 0.7
    m2 = math_node(nt, 'MULTIPLY_ADD', mac2.outputs['Color'], 0.24)
    nt.nodes[-1].inputs[2].default_value = 0.88
    k = math_node(nt, 'MULTIPLY', m1, m2)
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
    nt.links.new(t.outputs['Color'], mul.inputs['A'])
    comb = nt.nodes.new('ShaderNodeCombineColor')
    for c, v in zip(('Red', 'Green', 'Blue'), tint):
        tm = math_node(nt, 'MULTIPLY', k, v)
        nt.links.new(tm, comb.inputs[c])
    nt.links.new(comb.outputs['Color'], mul.inputs['B'])
    col = mul.outputs['Result']
    rough_s = None
    if rubber:
        rub = rubber_amount(nt)
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
        f = math_node(nt, 'MULTIPLY', rub, 0.85)
        nt.links.new(f, mix.inputs['Factor']); nt.links.new(col, mix.inputs['A'])
        mix.inputs['B'].default_value = (0.018, 0.018, 0.02, 1)
        col = mix.outputs['Result']
        rough_s = math_node(nt, 'MULTIPLY_ADD', rub, -0.3)
        nt.nodes[-1].inputs[2].default_value = rough
    nt.links.new(col, bsdf.inputs['Base Color'])
    if rough_s is not None:
        nt.links.new(rough_s, bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = rough
    return m


def rubber_amount(nt):
    rw = nt.nodes.new('ShaderNodeUVMap'); rw.uv_map = 'RW'        # (t, s)
    rwd = nt.nodes.new('ShaderNodeUVMap'); rwd.uv_map = 'RWD'     # (dA, dB)
    s1 = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(rw.outputs['UV'], s1.inputs[0])
    s2 = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(rwd.outputs['UV'], s2.inputs[0])
    t, s = s1.outputs['X'], s1.outputs['Y']
    dA, dB = s2.outputs['X'], s2.outputs['Y']
    def env(d):
        a = smoothstep_node(nt, d, 60.0, 260.0)
        b = smoothstep_node(nt, d, 550.0, 1250.0)
        return math_node(nt, 'MULTIPLY', a, math_node(nt, 'SUBTRACT', 1.0, b))
    e = math_node(nt, 'MAXIMUM', env(dA), env(dB))
    at = math_node(nt, 'ABSOLUTE', t)
    lat1 = math_node(nt, 'SUBTRACT', 1.0, smoothstep_node(nt, math_node(nt, 'ABSOLUTE', math_node(nt, 'SUBTRACT', at, 3.5)), 4.0, 12.5))
    lat2 = math_node(nt, 'MULTIPLY', math_node(nt, 'SUBTRACT', 1.0, smoothstep_node(nt, math_node(nt, 'ABSOLUTE', math_node(nt, 'SUBTRACT', at, 6.2)), 0.0, 2.2)), 0.55)
    lat = math_node(nt, 'MAXIMUM', lat1, lat2)
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img('rubber.png', non_color=True)
    cxyz = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(math_node(nt, 'DIVIDE', t, 16.0), cxyz.inputs['X'])
    nt.links.new(math_node(nt, 'DIVIDE', s, 128.0), cxyz.inputs['Y'])
    nt.links.new(cxyz.outputs['Vector'], tex.inputs['Vector'])
    streak = math_node(nt, 'MULTIPLY_ADD', tex.outputs['Color'], 0.9)
    nt.nodes[-1].inputs[2].default_value = 0.35
    r = math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', e, lat), streak)
    n = nt.nodes.new('ShaderNodeClamp'); nt.links.new(r, n.inputs['Value'])
    return n.outputs['Result']


def paint_material():
    m, nt, bsdf = new_mat('paint')
    ca = nt.nodes.new('ShaderNodeAttribute'); ca.attribute_name = 'Col'
    coord = nt.nodes.new('ShaderNodeTexCoord')
    wear = nt.nodes.new('ShaderNodeTexImage'); wear.image = img('paintwear.jpg', non_color=True)
    sc = nt.nodes.new('ShaderNodeVectorMath'); sc.operation = 'SCALE'; sc.inputs['Scale'].default_value = 0.25
    nt.links.new(coord.outputs['Object'], sc.inputs[0]); nt.links.new(sc.outputs['Vector'], wear.inputs['Vector'])
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
    f = math_node(nt, 'MULTIPLY_ADD', wear.outputs['Color'], 0.65)
    nt.nodes[-1].inputs[2].default_value = 0.35
    nt.links.new(f, mix.inputs['Factor'])
    mix.inputs['A'].default_value = (0.07, 0.07, 0.072, 1)
    nt.links.new(ca.outputs['Color'], mix.inputs['B'])
    col = mix.outputs['Result']
    rub = rubber_amount(nt)
    mix2 = nt.nodes.new('ShaderNodeMix'); mix2.data_type = 'RGBA'
    nt.links.new(math_node(nt, 'MULTIPLY', rub, 0.8), mix2.inputs['Factor'])
    nt.links.new(col, mix2.inputs['A']); mix2.inputs['B'].default_value = (0.02, 0.02, 0.02, 1)
    nt.links.new(mix2.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.62
    return m


def emit_material(name, color, strength):
    m, nt, bsdf = new_mat(name)
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Emission Color'].default_value = (*color, 1)
    bsdf.inputs['Emission Strength'].default_value = strength
    return m


# ------------------------------------------------------------------ geometry
def mesh_object(name, verts, faces, mat, uvs=None, attrs=None, loop_attrs=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    if uvs:
        for uvname, arr in uvs.items():
            layer = me.uv_layers.new(name=uvname)
            li = np.array([l.vertex_index for l in me.loops], dtype=np.int64)
            layer.data.foreach_set('uv', np.asarray(arr, np.float32)[li].ravel())
    if attrs:
        for an, (dom, typ, arr) in attrs.items():
            a = me.attributes.new(an, typ, dom)
            if typ == 'FLOAT_COLOR':
                a.data.foreach_set('color', np.asarray(arr, np.float32).ravel())
            else:
                a.data.foreach_set('value', np.asarray(arr, np.float32).ravel())
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_terrain(t, ox, oz, cx, cz, R):
    """Heightfield around (cx, cz) (world local), in scene coordinates relative to the airport origin."""
    m = t.m
    H = t.H
    nz, nx = H.shape
    step = 1
    c0 = max(0, int((cx - R - m['hx0']) / m['hsp'])); c1 = min(nx - 1, int((cx + R - m['hx0']) / m['hsp']) + 1)
    r0 = max(0, int((cz - R - m['hz0']) / m['hsp'])); r1 = min(nz - 1, int((cz + R - m['hz0']) / m['hsp']) + 1)
    cols = np.arange(c0, c1 + 1, step); rows = np.arange(r0, r1 + 1, step)
    X = m['hx0'] + cols * m['hsp']; Z = m['hz0'] + rows * m['hsp']
    XX, ZZ = np.meshgrid(X, Z)
    HH = H[np.ix_(rows, cols)] - 0.08          # a hair below the pavement layers
    verts = np.stack([XX - ox, -(ZZ - oz), HH], -1).reshape(-1, 3)
    w = len(cols)
    idx = np.arange(len(rows) * w).reshape(len(rows), w)
    faces = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1, 4)
    faces = faces[:, ::-1]  # Blender Y = -z flips handedness -> reverse to face up
    u = (XX - m['ix0']) / m['isize'][0]
    v = 1 - (ZZ - m['iz0']) / m['isize'][1]
    uv = np.stack([u, v], -1).reshape(-1, 2)
    wimg = bpy.data.images.load(os.path.join(R_DIR, f'{t.name}_water.png'))
    wpx = np.array(wimg.pixels[:], np.float32).reshape(wimg.size[1], wimg.size[0], -1)[::-1, :, 0]
    water = wpx[np.ix_(rows, cols)]
    water = np.where(H[np.ix_(rows, cols)] > 1.2, 0.0, water).reshape(-1)   # W1's mask marks some SFO infields as water
    ob = mesh_object('terrain', verts, faces, terrain_material(t), uvs={'UVMap': uv}, attrs={'water': ('POINT', 'FLOAT', water)})
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def build_surfaces(meta, A, terr, center, R):
    ox, oz = meta['origin']
    mil = meta.get('military')
    mats = {
        'shoulder': pavement_material('shoulder', 'shoulder.jpg', 8, 0.95, tint=(0.95, 0.94, 0.9)),
        'apron': pavement_material('apron', 'concrete.jpg', 15.24, 0.86),
        'taxiway': pavement_material('taxiway', 'concrete.jpg' if mil else 'asphalt_twy.jpg', 15.24 if mil else 8, 0.9),
        'pad': pavement_material('pad', 'concrete.jpg', 15.24, 0.86),
        'blast': pavement_material('blast', 'asphalt_twy.jpg', 8, 0.93, tint=(0.85, 0.85, 0.85)),
        'runway': pavement_material('runway', 'concrete_rwy.jpg' if mil else 'asphalt_rwy.jpg', 15.24 if mil else 8, 0.9, rubber=True),
    }
    tiles = {'shoulder': 8, 'apron': 30.48, 'taxiway': 30.48 if mil else 8, 'pad': 30.48, 'blast': 8, 'runway': 15.24 if mil else 8}
    offs = {'shoulder': 0.03, 'apron': 0.05, 'taxiway': 0.05, 'pad': 0.06, 'blast': 0.06, 'runway': 0.07}
    rot = {'KSFO': -27.42, 'KNGZ': -75.0, 'KOAK': -21.7}[meta['icao']] * math.pi / 180
    cr, sr = math.cos(rot), math.sin(rot)
    cx, cz = center
    for key in ('shoulder', 'apron', 'taxiway', 'pad', 'blast', 'runway'):
        if f'surf.{key}.p' not in A:
            continue
        p = A[f'surf.{key}.p'].reshape(-1, 2).astype(np.float64)
        tri = A[f'surf.{key}.i'].reshape(-1, 3).astype(np.int64)
        wx, wz = p[:, 0] + ox, p[:, 1] + oz
        cen = p[tri].mean(axis=1) + [ox, oz]
        keep = np.hypot(cen[:, 0] - cx, cen[:, 1] - cz) < R
        tri = tri[keep]
        if not len(tri):
            continue
        h = terr.h(wx, wz) + offs[key]
        verts = np.stack([p[:, 0], -p[:, 1], h], -1)
        tl = tiles[key]
        if key == 'runway':
            e = A['surf.runway.e'].reshape(-1, 4)
            uvs = {'UVMap': np.stack([e[:, 0] / tl, e[:, 1] / tl], -1), 'RW': e[:, 0:2], 'RWD': e[:, 2:4]}
        else:
            uvs = {'UVMap': np.stack([(wx * cr - wz * sr) / tl, (wx * sr + wz * cr) / tl], -1)}
        mesh_object(f'surf_{key}', verts, tri[:, ::-1], mats[key], uvs=uvs)
    # markings
    p = A['marks.p'].reshape(-1, 2).astype(np.float64)
    tri = A['marks.i'].reshape(-1, 3).astype(np.int64)
    c = A['marks.c']
    e = A['marks.e'].reshape(-1, 4)
    cen = p[tri].mean(axis=1) + [ox, oz]
    tri = tri[np.hypot(cen[:, 0] - cx, cen[:, 1] - cz) < R]
    PAL = np.array([[0.74, 0.74, 0.72, 1], [0.92, 0.55, 0.035, 1], [0.012, 0.012, 0.012, 1], [0.5, 0.018, 0.02, 1],
                    [0.03, 0.03, 0.03, 1], [0.9, 0.25, 0.02, 1], [0.03, 0.35, 0.08, 1]], np.float32)
    h = terr.h(p[:, 0] + ox, p[:, 1] + oz) + 0.09
    verts = np.stack([p[:, 0], -p[:, 1], h], -1)
    mesh_object('markings', verts, tri[:, ::-1], paint_material(), uvs={'RW': e[:, 0:2], 'RWD': e[:, 2:4]},
                attrs={'Col': ('POINT', 'FLOAT_COLOR', PAL[np.minimum(c, 6)])})


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def place_buildings(meta, terr, center, R):
    ox, oz = meta['origin']
    objs = import_glb(os.path.join(A_DIR, f"{meta['icao'].lower()}_buildings.glb"))
    for o in objs:
        if o.parent is not None:
            continue
        wx, wz = o.location.x + ox, -o.location.y + oz
        if math.hypot(wx - center[0], wz - center[1]) > R + 400:
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        o.location.z += float(terr.h(wx, wz))
    # daylight renders: no interior glow
    for m in bpy.data.materials:
        if m.node_tree:
            b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if b is not None and 'Emission Strength' in b.inputs:
                b.inputs['Emission Strength'].default_value = 0.0 if not SHOT_CFG.get('dusk') else 0.6


_TPL = {}


def agent_template(aid):
    """Full aircraft model of the aircraft agents (read-only) as an excluded collection for instancing; the instance
    offset puts the nose-wheel contact (or the main-gear contact height for helicopters) at the empty's origin."""
    if aid in _TPL:
        return _TPL[aid]
    path = os.path.join(REPO, 'assets', 'aircraft', aid, f'{aid}.glb')
    if not os.path.exists(path):
        _TPL[aid] = None
        return None
    objs = import_glb(path)
    coll = bpy.data.collections.new(f'tpl_{aid}')
    bpy.context.scene.collection.children.link(coll)
    for o in objs:
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)
    bpy.context.view_layer.update()
    cn = next((o for o in objs if o.name.startswith('contact_nose')), None)
    if cn is not None:
        coll.instance_offset = cn.matrix_world.translation.copy()
    else:
        cs = [o for o in objs if o.name.startswith('contact_')]
        z = min(o.matrix_world.translation.z for o in cs) if cs else 0.0
        coll.instance_offset = Vector((0.0, 0.0, z))
    for o in objs:
        if o.name.startswith('interior'):
            o.hide_render = True
    lc = bpy.context.view_layer.layer_collection.children.get(coll.name)
    if lc:
        lc.exclude = True
    _TPL[aid] = coll
    return coll


def place_props(meta, terr, center, R):
    ox, oz = meta['origin']
    src = import_glb(os.path.join(A_DIR, 'props.glb'))
    lib = {o.name: o for o in src if o.parent is None}
    hidden = bpy.data.collections.new('props_src')
    for o in src:
        for c in o.users_collection:
            c.objects.unlink(o)
        hidden.objects.link(o)
    rng = random.Random(3)
    tails = [(0.03, 0.1, 0.35), (0.02, 0.05, 0.16), (0.6, 0.03, 0.03), (0.02, 0.25, 0.3), (0.9, 0.9, 0.9), (0.05, 0.3, 0.12)]

    AGENT = {'fighter_f16': ['f16'], 'fighter_f22': ['f22'], 'heli_uh60': ['uh60'], 'airliner_narrow': ['a320neo', 'b737']}
    counter = {'n': 0}

    def put(name, x, z, hdg, tail=None):
        if math.hypot(x + ox - center[0], z + oz - center[1]) > R:
            return
        if name in AGENT:
            ids = AGENT[name]
            aid = ids[counter['n'] % len(ids)]
            counter['n'] += 1
            coll = agent_template(aid)
            if coll is not None:
                e = bpy.data.objects.new(f'{aid}_inst', None)
                e.instance_type = 'COLLECTION'
                e.instance_collection = coll
                e.location = (x, -z, float(terr.h(x + ox, z + oz)))
                e.rotation_euler = (0, 0, -math.radians(hdg))
                bpy.context.scene.collection.objects.link(e)
                return
        if name not in lib:
            return
        root = lib[name].copy()
        bpy.context.scene.collection.objects.link(root)
        root.location = (x, -z, float(terr.h(x + ox, z + oz)))
        root.rotation_mode = 'XYZ'
        root.rotation_euler = (0, 0, -math.radians(hdg))
        for ch in lib[name].children:
            c2 = ch.copy()
            if tail is not None and ch.name.endswith('_tail'):
                c2.data = ch.data.copy()
                mt = ch.active_material.copy() if ch.active_material else None
                if mt:
                    b = next(n for n in mt.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
                    b.inputs['Base Color'].default_value = (*tail, 1)
                    for l in list(b.inputs['Base Color'].links):
                        mt.node_tree.links.remove(l)
                    c2.data.materials.clear(); c2.data.materials.append(mt)
            bpy.context.scene.collection.objects.link(c2)
            c2.parent = root
    for s in meta['stands']:
        if not s['occ']:
            continue
        cls = s['cls']
        if cls in ('narrow', 'remote', 'small'):
            name = 'airliner_narrow'
        elif cls in ('wide', 'cargo_wide'):
            name = 'airliner_wide'
        elif cls in ('fighter', 'fighter_has'):
            name = 'fighter_f22' if s.get('model') == 'f22' else 'fighter_f16'
        elif cls == 'heli':
            name = 'heli_uh60'
        else:
            continue
        x, z = s['x'], s['z']
        if cls == 'fighter_has' and not s['occ']:
            continue
        near_look = math.hypot(x + ox - SHOT_CFG['look'][0], z + oz - SHOT_CFG['look'][2]) < 45
        if cls == 'fighter_has' and (near_look or (int(''.join(ch for ch in s['ref'] if ch.isdigit()) or 0) % 2 == 0)):
            h = math.radians(s['h'])
            x, z = x + math.sin(h) * 24.0, z - math.cos(h) * 24.0
        put(name, x, z, s['h'], rng.choice(tails) if name.startswith('airliner') else None)
        if name.startswith('airliner'):
            h = math.radians(s['h'])
            fx, fz = math.sin(h), -math.cos(h)
            rx, rz = math.cos(h), math.sin(h)
            L = 30.0 if name == 'airliner_narrow' else 50.0
            # baggage train at the aft right, tug near the nose
            put('baggage_tractor', s['x'] - fx * L * 0.62 + rx * 7, s['z'] - fz * L * 0.62 + rz * 7, s['h'] + 90)
            for k in range(2):
                put('baggage_cart', s['x'] - fx * (L * 0.62 + 3 + 3.4 * k) + rx * 7, s['z'] - fz * (L * 0.62 + 3 + 3.4 * k) + rz * 7, s['h'] + 90)
            if rng.random() < 0.5:
                put('catering_truck', s['x'] - fx * 8 + rx * 5, s['z'] - fz * 8 + rz * 5, s['h'] + 90)
            if rng.random() < 0.4:
                put('fuel_truck', s['x'] - fx * 16 + rx * 12, s['z'] - fz * 16 + rz * 12, s['h'])
    for p in meta.get('props', []):
        put(p['t'], p['x'], p['z'], p.get('h', 0))


LIGHT_COL = {0: (1, 0.93, 0.78), 1: (1, 0.72, 0.18), 2: (1, 0.93, 0.78), 3: (1, 0.07, 0.04), 4: (1, 0.93, 0.78), 5: (0.1, 1, 0.4),
             6: (1, 0.07, 0.04), 7: (1, 0.93, 0.8), 8: (1, 0.07, 0.04), 9: (1, 1, 1), 10: (1, 1, 1), 11: (0.1, 0.22, 1), 12: (0.12, 1, 0.38),
             13: (1, 0.72, 0.18), 14: (1, 0.07, 0.04), 15: (0.2, 1, 0.45), 16: (1, 0.82, 0.55), 18: (1, 0.72, 0.18), 19: (0.1, 1, 0.4),
             20: (1, 0.07, 0.04), 21: (1, 0.93, 0.78)}
BEAM = {1: 75, 2: 70, 3: 70, 4: 60, 5: 70, 6: 70, 7: 40, 8: 40, 9: 45, 10: 30, 13: 50, 21: 75}


def place_lights(meta, A, terr, cam_w):
    """Runway / approach / taxiway lights as small emitters (sized up with distance so they stay visible)."""
    ox, oz = meta['origin']
    P = A['lights.pos'].reshape(-1, 3); T = A['lights.type']; Hd = A['lights.hdg']; Pr = A['lights.param']; Md = A['lights.mode']
    groups = {}
    cx, cy, cz = cam_w
    for k in range(len(T)):
        x, z, h = float(P[k, 0]) + ox, float(P[k, 1]) + oz, float(P[k, 2])
        t = int(T[k])
        if t not in LIGHT_COL or t == 16:
            continue
        g = float(terr.h(x, z))
        y = g + h if Md[k] == 0 else (h if Md[k] == 1 else max(h, g + 0.1))
        dx, dy, dz = cx - x, cy - y, cz - z
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if d > 6000:
            continue
        if Hd[k] >= 0 and t in BEAM:
            hr = math.radians(float(Hd[k]))
            c = (math.sin(hr) * dx - math.cos(hr) * dz) / max(1e-6, math.hypot(dx, dz))
            if c < math.cos(math.radians(BEAM[t])):
                continue
        col = LIGHT_COL[t]
        if t == 10:   # PAPI: white above the unit's angle, red below
            el = math.degrees(math.atan2(dy, math.hypot(dx, dz)))
            col = (1, 0.95, 0.85) if el > float(Pr[k]) else (1, 0.03, 0.02)
        r = max(0.12, d * 0.0011)
        groups.setdefault(col, []).append((x - ox, -(z - oz), y, r))
    for i, (col, pts) in enumerate(groups.items()):
        verts, faces = [], []
        for (x, y, z, r) in pts:
            b = len(verts)
            # octahedron
            for v in ((r, 0, 0), (-r, 0, 0), (0, r, 0), (0, -r, 0), (0, 0, r), (0, 0, -r)):
                verts.append((x + v[0], y + v[1], z + v[2]))
            for f in ((0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)):
                faces.append((b + f[0], b + f[1], b + f[2]))
        mesh_object(f'lights_{i}', verts, faces, emit_material(f'light_{i}', col, 60.0))


def place_als(meta, terr):
    ox, oz = meta['origin']
    steel = emit_material('als_steel', (0.35, 0.36, 0.37), 0.0)
    orange = emit_material('als_orange', (0.55, 0.16, 0.04), 0.0)
    verts, faces, verts2, faces2 = [], [], [], []
    def box(V, F, cx, cy, z0, sx, sy, sz, rot):
        c, s_ = math.cos(rot), math.sin(rot)
        b = len(V)
        for zz in (z0, z0 + sz):
            for (px, py) in ((-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2)):
                V.append((cx + px * c - py * s_, cy + px * s_ + py * c, zz))
        for f in ((0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7), (3, 2, 1, 0)):
            F.append(tuple(b + k for k in f))
    for als in meta.get('als', []):
        for st in als['stations']:
            if st['pave']:
                continue
            wx, wz = st['x'] + ox, st['z'] + oz
            g = max(0.0, float(terr.h(wx, wz)))
            rot = -math.radians(st['h'])
            box(verts, faces, st['x'], -st['z'], g - 1.0, 0.22, 0.22, st['y'] - g + 0.9, 0.0)
            box(verts2, faces2, st['x'], -st['z'], st['y'] - 0.25, st['w'], 0.16, 0.16, rot)
        ax, az, bx, bz = als['walk']
        L = math.hypot(bx - ax, bz - az)
        n = max(1, int(L // 12))
        hdg = math.atan2(bx - ax, -(bz - az))
        for k in range(n):
            x = ax + (bx - ax) * (k + 0.5) / n; z = az + (bz - az) * (k + 0.5) / n
            g = max(0.0, float(terr.h(x + ox, z + oz)))
            if als['y'] - g < 0.6:
                continue
            box(verts, faces, x, -z, als['y'], 1.2, L / n, 0.25, -hdg)
            box(verts, faces, x, -z, g - 1.0, 0.25, 0.25, als['y'] - g + 1.0, 0.0)
    if verts:
        mesh_object('als_steel', verts, faces, steel)
    if verts2:
        mesh_object('als_bars', verts2, faces2, orange)


def setup_world(sun_el, sun_az, strength=1.0):
    sc = bpy.context.scene
    world = bpy.data.worlds.new('Sky')
    sc.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    nt = world.node_tree
    nt.nodes.clear()
    sky = nt.nodes.new('ShaderNodeTexSky')
    for t in ('MULTIPLE_SCATTERING', 'NISHITA', 'SINGLE_SCATTERING'):
        try:
            sky.sky_type = t
            break
        except (TypeError, ValueError):
            continue
    sky.sun_elevation = math.radians(sun_el)
    # Blender sky: sun_rotation measured from +X toward +Y? -> we pass azimuth clockwise from north (+Y) = 90 - az
    sky.sun_rotation = math.radians(sun_az)          # calibrated: azimuth clockwise from north (+Y)
    for k, v in (('air_density', 1.0), ('aerosol_density', float(SHOT_CFG.get('aerosol', 1.0))), ('dust_density', float(SHOT_CFG.get('aerosol', 1.0))), ('ozone_density', 1.0)):
        try:
            setattr(sky, k, v)
        except Exception:
            pass
    try:
        sky.sun_disc = True
    except Exception:
        pass
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    # sun lamp matching the sky's sun
    l = bpy.data.lights.new('Sun', 'SUN')
    l.angle = math.radians(0.6)
    el, az = math.radians(sun_el), math.radians(sun_az)
    s = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    l.energy = 4.0 * max(0.0, min(1.0, (sun_el + 1.0) / 8.0)) ** 1.2
    l.color = (1.0, 0.78 + 0.22 * min(1, max(0, sun_el / 25)), 0.55 + 0.45 * min(1, max(0, sun_el / 25)))
    ob = bpy.data.objects.new('Sun', l)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = s.to_track_quat('Z', 'Y').to_euler()


SHOT_CFG = SHOTS.get(SHOT, SHOTS['sfo_tower'])


def main():
    cfg = SHOT_CFG
    reset_scene()
    meta, A = load_airport(cfg['icao'])
    ox, oz = meta['origin']
    terr = Terrain(cfg['terrain'], ox, oz)
    cam, look = cfg['cam'], cfg['look']
    cg = float(terr.h(cam[0], cam[2]))
    lg = float(terr.h(look[0], look[2]))
    cam_w = (cam[0], max(cg, 0.0) + cam[1], cam[2])
    look_w = (look[0], max(lg, 0.0) + look[1], look[2])
    center = ((cam[0] + look[0]) / 2, (cam[2] + look[2]) / 2)
    R = cfg['radius']
    build_terrain(terr, ox, oz, center[0], center[1], 6500)
    build_surfaces(meta, A, terr, center, R)
    place_buildings(meta, terr, center, R)
    place_props(meta, terr, center, R)
    if cfg.get('lights'):
        place_lights(meta, A, terr, cam_w)
    place_als(meta, terr)
    setup_world(cfg['sun'][0], cfg['sun'][1], 1.0)
    W, H = cfg['res']
    if '--res' in argv:
        W, H = map(int, opt('--res', '1920x1080').split('x'))
    samples = int(opt('--samples', 160 if '--preview' not in argv else 32))
    setup_cycles(samples=samples, width=W, height=H, gpu='--cpu' not in argv)
    sc = bpy.context.scene
    sc.view_settings.look = 'AgX - Punchy' if cfg.get('dusk') else 'AgX - Medium High Contrast'
    sc.render.film_transparent = False
    try:
        sc.cycles.use_adaptive_sampling = True
        sc.cycles.max_bounces = 6
    except Exception:
        pass
    # camera
    camd = bpy.data.cameras.new('Cam')
    camd.lens = cfg['lens']
    camd.clip_start = 0.5
    camd.clip_end = 30000
    co = bpy.data.objects.new('Cam', camd)
    sc.collection.objects.link(co)
    p = Vector((cam_w[0] - ox, -(cam_w[2] - oz), cam_w[1]))
    t = Vector((look_w[0] - ox, -(look_w[2] - oz), look_w[1]))
    co.location = p
    co.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = co
    # mist-like depth haze: volume in the world is slow; use a gentle exposure instead
    sc.view_settings.exposure = float(opt('--exposure', cfg.get('exposure', -3.2 if not cfg.get('dusk') else -1.0)))
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, f"{SHOT}{'_preview' if '--preview' in argv else ''}.png")
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print('rendered', out)


main()
