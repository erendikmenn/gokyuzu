"""Cycles renders of the SF city assets ("gerçek renderlar"): real terrain + aerial imagery (W1 tiles), the city
buildings built by the same Builder as the game tiles with the Cycles-rendered facade atlas, instanced Blender tree
species, W3 landmarks where available, Nishita sky + sun.

  Blender -b -P blender/city/render_city.py -- --view alamo|downtown|sunset|mission [--samples 160] [--res 1920x1080]

Output: renders/city/<view>.png
"""
import json
import math
import os
import struct
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'common'))
from util import reset_scene, setup_cycles, nishita_sky, add_sun, add_camera, render_still, REPO  # noqa: E402
import build_tiles as BT  # noqa: E402

TER = os.path.join(REPO, 'assets', 'sf', 'terrain')
CITY = os.path.join(REPO, 'assets', 'sf', 'city')
TILES = os.path.join(REPO, 'data', 'sf', 'cache', 'city', 'tiles')

# camera / look in three.js local meters (y = above terrain when agl=True); sun elevation, azimuth (deg from north, cw)
VIEWS = {
    'alamo': dict(cam=(-5330, 70, -17370), look=(-2900, 70, -18750), lens=40, radius=3200, far=16000, sun=(11, 215), agl=True, haze=0.00005),
    'downtown': dict(cam=(-400, 480, -17300), look=(-2400, 90, -19300), lens=32, radius=3400, far=18000, sun=(24, 235), agl=True, haze=0.00007),
    'sunset': dict(cam=(-9000, 160, -14200), look=(-10400, 10, -16000), lens=30, radius=2600, far=12000, sun=(14, 250), agl=True, haze=0.00008),
    'mission': dict(cam=(-4390, 40, -15230), look=(-4380, 12, -15950), lens=35, radius=2000, far=9000, sun=(12, 255), agl=True),
}


# ======================================================================================================== terrain (W1)
class Terrain:
    """Reads W1's quadtree height tiles (assets/sf/terrain/h/<level>.bin) — finest level wins."""

    def __init__(self):
        self.idx = json.load(open(os.path.join(TER, 'index.json')))
        self.RX, self.RZ, self.root = self.idx['rootMinX'], self.idx['rootMinZ'], self.idx['rootSize']
        self.grid = self.idx['grid']
        self.tb = self.idx['tileBytes']
        order = {}
        self.nodes = {}
        for n in self.idx['nodes']:
            L, i, j = n[0], n[1], n[2]
            k = order.get(L, 0)
            order[L] = k + 1
            self.nodes[(L, i, j)] = (k, n)
        self.maxL = max(L for (L, _, _) in self.nodes)
        self.files = {}
        self.cache = {}

    def tile(self, L, i, j):
        key = (L, i, j)
        if key in self.cache:
            return self.cache[key]
        if key not in self.nodes:
            return None
        k, n = self.nodes[key]
        f = self.files.get(L)
        if f is None:
            f = self.files[L] = open(os.path.join(TER, 'h', f'{L}.bin'), 'rb')
        f.seek(k * self.tb)
        b = f.read(self.tb)
        hmin, scale = struct.unpack('<ff', b[:8])
        s = self.grid + 3
        h = np.frombuffer(b[8:8 + s * s * 2], '<u2').astype(np.float32).reshape(s, s) * scale + hmin
        self.cache[key] = h
        return h

    def height(self, x, z):
        for L in range(self.maxL, -1, -1):
            size = self.root / (1 << L)
            i, j = int(math.floor((x - self.RX) / size)), int(math.floor((z - self.RZ) / size))
            h = self.tile(L, i, j)
            if h is None:
                continue
            step = size / self.grid
            fx = (x - (self.RX + i * size)) / step + 1
            fz = (z - (self.RZ + j * size)) / step + 1
            c0, r0 = int(fx), int(fz)
            tx, tz = fx - c0, fz - r0
            c0, r0 = min(max(c0, 0), self.grid + 1), min(max(r0, 0), self.grid + 1)
            a = h[r0, c0] * (1 - tx) + h[r0, c0 + 1] * tx
            b = h[r0 + 1, c0] * (1 - tx) + h[r0 + 1, c0 + 1] * tx
            return max(0.0, float(a * (1 - tz) + b * tz)) if L else float(a * (1 - tz) + b * tz)
        return 0.0


def to_bl(x, y, z):
    return (x, -z, y)


# ============================================================================================================ ground
def water_mat():
    m = bpy.data.materials.new('water')
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.012, 0.03, 0.04, 1)
    b.inputs['Roughness'].default_value = 0.06
    b.inputs['IOR'].default_value = 1.33
    nt = m.node_tree
    tex = nt.nodes.new('ShaderNodeTexNoise')
    tex.inputs['Scale'].default_value = 0.35
    tex.inputs['Detail'].default_value = 8
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.08
    coord = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(coord.outputs['Object'], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    return m


def ground_tile_mat(path, wmat):
    """Aerial image; alpha = land (0 -> water shader)."""
    m = bpy.data.materials.new(os.path.basename(path))
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    img = nt.nodes.new('ShaderNodeTexImage')
    img.image = bpy.data.images.load(path, check_existing=True)
    img.extension = 'EXTEND'
    nt.links.new(img.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.92
    b.inputs['Specular IOR Level'].default_value = 0.3
    # water mix via alpha
    wb = nt.nodes.new('ShaderNodeBsdfPrincipled')
    wb.inputs['Base Color'].default_value = (0.012, 0.03, 0.04, 1)
    wb.inputs['Roughness'].default_value = 0.05
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(img.outputs['Alpha'], mix.inputs['Fac'])
    nt.links.new(wb.outputs[0], mix.inputs[1])
    nt.links.new(b.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
    return m


def build_ground(T, cx, cz, radius, far):
    wmat = water_mat()
    RX, RZ, root = T.RX, T.RZ, T.root
    made = 0
    # near: imagery level 8 (512 m, 1 m/px), mesh step 4 m; mid: level 6 (2 km), step 32 m; far: level 4, step 128 m
    rings = [(8, radius + 400, 4.0), (6, far * 0.6, 32.0), (4, far * 2.0, 128.0)]
    covered = []
    for (L, R, step) in rings:
        size = root / (1 << L)
        i0, i1 = int(math.floor((cx - R - RX) / size)), int(math.floor((cx + R - RX) / size))
        j0, j1 = int(math.floor((cz - R - RZ) / size)), int(math.floor((cz + R - RZ) / size))
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                x0, z0 = RX + i * size, RZ + j * size
                if any(a <= x0 and x0 + size <= b and c <= z0 and z0 + size <= d for (a, b, c, d) in covered):
                    continue
                path = os.path.join(TER, 'img', str(L), f'{i}_{j}.webp')
                if not os.path.exists(path):
                    continue
                n = int(size / step)
                xs = x0 + np.arange(n + 1) * step
                zs = z0 + np.arange(n + 1) * step
                H = np.array([[T.height(x, z) for x in xs] for z in zs], np.float32)
                X, Z = np.meshgrid(xs, zs)
                verts = np.stack([X.ravel(), -Z.ravel(), H.ravel()], 1)
                me = bpy.data.meshes.new(f'g{L}_{i}_{j}')
                me.vertices.add(len(verts))
                me.vertices.foreach_set('co', verts.ravel())
                q = []
                for r in range(n):
                    for c in range(n):
                        a = r * (n + 1) + c
                        q.append((a, a + 1, a + n + 2, a + n + 1))
                q = np.array(q, np.int32)
                me.loops.add(len(q) * 4)
                me.loops.foreach_set('vertex_index', q.ravel())
                me.polygons.add(len(q))
                me.polygons.foreach_set('loop_start', np.arange(len(q), dtype=np.int32) * 4)
                me.polygons.foreach_set('loop_total', np.full(len(q), 4, np.int32))
                uv = me.uv_layers.new(name='UVMap')
                U = ((verts[:, 0] - x0) / size)
                V = 1.0 - ((-verts[:, 1] - z0) / size)
                uv.data.foreach_set('uv', np.stack([U, V], 1)[q.ravel()].ravel().astype(np.float32))
                me.polygons.foreach_set('use_smooth', np.ones(len(q), bool))
                me.update()
                me.materials.append(ground_tile_mat(path, wmat))
                ob = bpy.data.objects.new(me.name, me)
                bpy.context.scene.collection.objects.link(ob)
                made += 1
        covered.append((cx - R, cx + R, cz - R, cz + R))
    # sea beyond
    bpy.ops.mesh.primitive_plane_add(size=200000, location=(cx, -cz, -1.0))
    bpy.context.active_object.data.materials.append(wmat)
    print(f'[render] ground tiles: {made}', flush=True)


# ======================================================================================================= city material
def atlas_material():
    meta = json.load(open(os.path.join(CITY, 'atlas', 'atlas.json')))
    g = meta['grid']
    m = bpy.data.materials.new('city_atlas')
    m.use_nodes = True
    nt = m.node_tree
    N = nt.nodes
    L = nt.links.new
    b = N['Principled BSDF']
    def math_(op, a, bval=None):
        n = N.new('ShaderNodeMath')
        n.operation = op
        for k, x in enumerate((a, bval)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                n.inputs[k].default_value = x
            else:
                L(x, n.inputs[k])
        return n.outputs[0]
    uv0 = N.new('ShaderNodeUVMap'); uv0.uv_map = 'UVMap'
    uvl = N.new('ShaderNodeUVMap'); uvl.uv_map = 'Layer'
    s0 = N.new('ShaderNodeSeparateXYZ'); L(uv0.outputs['UV'], s0.inputs[0])
    sl = N.new('ShaderNodeSeparateXYZ'); L(uvl.outputs['UV'], sl.inputs[0])
    layer = math_('ROUND', sl.outputs['X'])
    gx = math_('MODULO', layer, float(g))
    gy = math_('FLOOR', math_('DIVIDE', layer, float(g)))
    fu = math_('FRACT', s0.outputs['X'])
    fv = math_('FRACT', math_('SUBTRACT', 1.0, s0.outputs['Y']))     # facade v (blender stores 1 - v)
    U = math_('DIVIDE', math_('ADD', gx, fu), float(g))
    V = math_('DIVIDE', math_('ADD', math_('SUBTRACT', float(g - 1), gy), fv), float(g))
    comb = N.new('ShaderNodeCombineXYZ'); L(U, comb.inputs[0]); L(V, comb.inputs[1])
    def img(name, color):
        t = N.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(os.path.join(CITY, 'atlas', meta['images'][name]), check_existing=True)
        if not color:
            t.image.colorspace_settings.name = 'Non-Color'
        t.interpolation = 'Closest'
        L(comb.outputs[0], t.inputs['Vector'])
        return t
    ta, tm, tn = img('albedo', True), img('mat', False), img('nrm', False)
    smat = N.new('ShaderNodeSeparateColor'); L(tm.outputs['Color'], smat.inputs[0])
    snrm = N.new('ShaderNodeSeparateColor'); L(tn.outputs['Color'], snrm.inputs[0])
    vc = N.new('ShaderNodeVertexColor'); vc.layer_name = 'Color'
    tint = N.new('ShaderNodeMix'); tint.data_type = 'RGBA'
    L(smat.outputs['Red'], tint.inputs['Factor'])
    tint.inputs[6].default_value = (1, 1, 1, 1)
    L(vc.outputs['Color'], tint.inputs[7])
    mul = N.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1
    L(ta.outputs['Color'], mul.inputs[6]); L(tint.outputs[2], mul.inputs[7])
    L(mul.outputs[2], b.inputs['Base Color'])
    L(smat.outputs['Green'], b.inputs['Roughness'])
    L(snrm.outputs['Blue'], b.inputs['Metallic'])
    # normal map (xy from atlas, z reconstructed)
    nx = math_('SUBTRACT', math_('MULTIPLY', snrm.outputs['Red'], 2.0), 1.0)
    ny = math_('SUBTRACT', math_('MULTIPLY', snrm.outputs['Green'], 2.0), 1.0)
    nz = math_('SQRT', math_('MAXIMUM', math_('SUBTRACT', 1.0, math_('ADD', math_('MULTIPLY', nx, nx), math_('MULTIPLY', ny, ny))), 0.0))
    cn = N.new('ShaderNodeCombineColor')
    L(math_('MULTIPLY_ADD', nx, 0.5) if False else math_('ADD', math_('MULTIPLY', nx, 0.5), 0.5), cn.inputs[0])
    L(math_('ADD', math_('MULTIPLY', ny, 0.5), 0.5), cn.inputs[1])
    L(math_('ADD', math_('MULTIPLY', nz, 0.5), 0.5), cn.inputs[2])
    nm = N.new('ShaderNodeNormalMap'); nm.uv_map = 'UVMap'; nm.inputs['Strength'].default_value = 0.9
    L(cn.outputs[0], nm.inputs['Color'])
    L(nm.outputs['Normal'], b.inputs['Normal'])
    return m


# ========================================================================================================= buildings
def build_city(T, cam, radius, far):
    """LOD by distance to the camera, same Builder as the game tiles; anchor placement on W1 terrain."""
    cx, cz = cam[0], cam[2]
    mat = atlas_material()
    total = 0
    idx = json.load(open(os.path.join(TILES, 'index_L1.json')))
    near_r, mid_r = 1400.0, radius
    for t in idx:
        i, j = t['i'], t['j']
        tx, tz = i * 1000 + 500, j * 1000 + 500
        d = math.hypot(tx - cx, tz - cz) - 707
        if d > mid_r:
            continue
        lod = 0 if d < near_r else 1
        js = json.load(open(os.path.join(TILES, f'L1_{i}_{j}.json')))
        bld = BT.Builder((tx, tz), lod)
        for b in js['buildings']:
            try:
                bld.building(b)
            except Exception as e:  # noqa
                pass
        total += add_buf(bld.buf, (tx, tz), f'city_{i}_{j}', mat, T, 'anchor')
    # far blocks (L2) between radius and far
    for f in os.listdir(TILES):
        if not f.startswith('L2_'):
            continue
        i, j = (int(v) for v in f[3:-5].split('_'))
        tx, tz = i * 2000 + 1000, j * 2000 + 1000
        d = math.hypot(tx - cx, tz - cz) - 1414
        if d < radius - 1500 or d > far:
            continue
        # skip blocks inside the detailed radius
        js = json.load(open(os.path.join(TILES, f)))
        bld = BT.Builder((tx, tz), 2)
        for blk in js['blocks']:
            px, pz = blk['p'][0]
            if math.hypot(px - cx, pz - cz) < radius:
                continue
            try:
                bld.block(blk)
            except Exception:
                pass
        total += add_buf(bld.buf, (tx, tz), f'far_{i}_{j}', mat, T, 'vertex')
    print(f'[render] city triangles: {total}', flush=True)


def add_buf(buf, center, name, mat, T, placement):
    if not buf.P:
        return 0
    P = np.asarray(buf.P, np.float64)
    A = np.asarray(buf.A, np.float64)
    cx, cz = center
    cache = {}
    for v in range(len(P)):
        x, y, z = P[v]
        if placement == 'anchor':
            ax, az = A[v][0] + cx, A[v][1] + cz
            k = (round(ax, 1), round(az, 1))
            g = cache.get(k)
            if g is None:
                g = cache[k] = T.height(ax, az)
            if y < 0.05:
                P[v][1] = min(g, T.height(x + cx, z + cz)) - 1.5
            else:
                P[v][1] = y + g
        else:
            g = T.height(x + cx, z + cz)
            P[v][1] = g - 2.0 if y < 0.05 else y + g
    buf.P = [tuple(p) for p in P]
    ob = BT.make_object(name, buf, center)
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return buf.tris


# ============================================================================================================== trees
def build_trees(T, cam, radius):
    meta = json.load(open(os.path.join(CITY, 'trees', 'trees.json')))
    species = meta['species']
    size = meta['size']
    cx, cz = cam[0], cam[2]
    pts = {s: [] for s in species}
    for t in meta['tiles']:
        i, j = t['i'], t['j']
        if math.hypot(i * size + size / 2 - cx, j * size + size / 2 - cz) - size * 0.71 > radius:
            continue
        b = open(os.path.join(CITY, 'trees', f'{i}_{j}.bin'), 'rb').read()
        n = struct.unpack('<I', b[12:16])[0]
        arr = np.frombuffer(b[16:16 + n * 12], dtype=[('x', '<f4'), ('z', '<f4'), ('s', 'u1'), ('h', 'u1'), ('r', 'u1'), ('c', 'u1')])
        for rec in arr:
            x, z = float(rec['x']), float(rec['z'])
            if math.hypot(x - cx, z - cz) > radius:
                continue
            pts[species[rec['s']]].append((x, z, rec['h'] / 4.0, rec['r'] / 255 * math.pi * 2))
    col = bpy.data.collections.new('tree_protos')
    bpy.context.scene.collection.children.link(col)
    count = 0
    for sp in species:
        if not pts[sp]:
            continue
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(CITY, 'trees', f'{sp}.glb'))
        new = [o for o in bpy.data.objects if o not in before]
        proto = next((o for o in new if o.name.startswith(f'{sp}_lod0')), None)
        for o in new:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            col.objects.link(o)
            o.hide_render = True
            o.hide_viewport = True
        if proto is None:
            continue
        ref = meta['refHeight'][sp]
        # point cloud with per-point scale/rotation -> geometry nodes instancing
        P = [(x, -z, T.height(x, z) - 0.15) for (x, z, h, r) in pts[sp]]
        me = bpy.data.meshes.new(f'trees_{sp}')
        me.from_pydata(P, [], [])
        sc = me.attributes.new('tscale', 'FLOAT', 'POINT')
        sc.data.foreach_set('value', [h / ref for (x, z, h, r) in pts[sp]])
        ro = me.attributes.new('trot', 'FLOAT', 'POINT')
        ro.data.foreach_set('value', [r for (x, z, h, r) in pts[sp]])
        ob = bpy.data.objects.new(f'trees_{sp}', me)
        bpy.context.scene.collection.objects.link(ob)
        mod = ob.modifiers.new('inst', 'NODES')
        ng = bpy.data.node_groups.new(f'inst_{sp}', 'GeometryNodeTree')
        ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
        ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
        gi = ng.nodes.new('NodeGroupInput')
        go = ng.nodes.new('NodeGroupOutput')
        inst = ng.nodes.new('GeometryNodeInstanceOnPoints')
        oi = ng.nodes.new('GeometryNodeObjectInfo')
        oi.inputs['Object'].default_value = proto
        oi.transform_space = 'ORIGINAL'
        a_s = ng.nodes.new('GeometryNodeInputNamedAttribute'); a_s.data_type = 'FLOAT'; a_s.inputs['Name'].default_value = 'tscale'
        a_r = ng.nodes.new('GeometryNodeInputNamedAttribute'); a_r.data_type = 'FLOAT'; a_r.inputs['Name'].default_value = 'trot'
        rot = ng.nodes.new('ShaderNodeCombineXYZ')
        ng.links.new(a_r.outputs['Attribute'], rot.inputs['Z'])
        ng.links.new(gi.outputs[0], inst.inputs['Points'])
        ng.links.new(oi.outputs['Geometry'], inst.inputs['Instance'])
        ng.links.new(a_s.outputs['Attribute'], inst.inputs['Scale'])
        ng.links.new(rot.outputs[0], inst.inputs['Rotation'])
        ng.links.new(inst.outputs['Instances'], go.inputs[0])
        mod.node_group = ng
        count += len(P)
    print(f'[render] trees: {count}', flush=True)


# ========================================================================================================== landmarks
def add_landmarks(T, cam, far):
    path = os.path.join(REPO, 'assets', 'sf', 'landmarks', 'index.json')
    if not os.path.exists(path):
        return
    idx = json.load(open(path))
    for l in idx.get('landmarks', []):
        o = l['origin']
        d = math.hypot(o['x'] - cam[0], o['z'] - cam[2])
        if d > far:
            continue
        url = l['lods'][0]['url'] if d < 2500 else l['lods'][min(1, len(l['lods']) - 1)]['url']
        f = os.path.join(REPO, url)
        if not os.path.exists(f):
            continue
        before = set(bpy.data.objects)
        try:
            bpy.ops.import_scene.gltf(filepath=f)
        except Exception as e:  # noqa
            print('[render] landmark failed', l['id'], e)
            continue
        new = [ob for ob in bpy.data.objects if ob not in before]
        roots = [ob for ob in new if ob.parent is None]
        y = T.height(o['x'], o['z']) if l.get('base') == 'terrain' else 0.0
        for r in roots:
            r.location = to_bl(o['x'], y, o['z'])
            r.rotation_mode = 'XYZ'
            r.rotation_euler = (r.rotation_euler[0], r.rotation_euler[1], r.rotation_euler[2] - l.get('heading', 0.0))
        print(f"[render] landmark {l['id']}", flush=True)


def add_haze(k, color):
    """Cheap aerial perspective: every surface shader is blended toward a haze emission by 1 - exp(-k * distance)."""
    for m in bpy.data.materials:
        if not m.use_nodes or m.name.startswith('haze'):
            continue
        nt = m.node_tree
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
        if out is None or not out.inputs['Surface'].links:
            continue
        src = out.inputs['Surface'].links[0].from_socket
        cam = nt.nodes.new('ShaderNodeCameraData')
        mul = nt.nodes.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = -k
        nt.links.new(cam.outputs['View Distance'], mul.inputs[0])
        ex = nt.nodes.new('ShaderNodeMath'); ex.operation = 'EXPONENT'
        nt.links.new(mul.outputs[0], ex.inputs[0])
        inv = nt.nodes.new('ShaderNodeMath'); inv.operation = 'SUBTRACT'; inv.inputs[0].default_value = 0.92
        nt.links.new(ex.outputs[0], inv.inputs[1])
        cl = nt.nodes.new('ShaderNodeMath'); cl.operation = 'MAXIMUM'; cl.inputs[1].default_value = 0.0
        nt.links.new(inv.outputs[0], cl.inputs[0])
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (*color, 1)
        em.inputs['Strength'].default_value = 1.0
        mix = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(cl.outputs[0], mix.inputs['Fac'])
        nt.links.new(src, mix.inputs[1])
        nt.links.new(em.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs['Surface'])


# =============================================================================================================== main
def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    view = argv[argv.index('--view') + 1] if '--view' in argv else 'alamo'
    samples = int(argv[argv.index('--samples') + 1]) if '--samples' in argv else 160
    res = argv[argv.index('--res') + 1] if '--res' in argv else '1920x1080'
    W, H = (int(v) for v in res.split('x'))
    V = VIEWS[view]
    reset_scene()
    T = Terrain()
    cam = list(V['cam'])
    look = list(V['look'])
    if V.get('agl'):
        cam[1] += T.height(cam[0], cam[2])
        look[1] += T.height(look[0], look[2])
    build_ground(T, cam[0], cam[2], V['radius'], V['far'])
    build_city(T, cam, V['radius'], V['far'])
    build_trees(T, cam, min(V['radius'], 2600))
    add_landmarks(T, cam, V['far'])
    setup_cycles(samples=samples, width=W, height=H, gpu='--cpu' not in argv)
    sc = bpy.context.scene
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.cycles.max_bounces = 6
    el, az = V['sun']
    world = nishita_sky(sun_elevation_deg=el, sun_rotation_deg=(180 - az) % 360, strength=V.get('sky', 0.35), altitude=0)
    for n in world.node_tree.nodes:
        if n.type == 'TEX_SKY':
            try:
                n.sun_disc = False
            except AttributeError:
                pass
    sun = add_sun(elevation_deg=el, azimuth_deg=180 - az, strength=V.get('sunI', 3.2))
    warm = max(0.0, min(1.0, (25 - el) / 20))          # golden hour tint for low sun
    sun.data.color = (1.0, 1.0 - 0.28 * warm, 1.0 - 0.55 * warm)
    sc.view_settings.exposure = V.get('exposure', 0.0)
    if V.get('haze'):
        add_haze(V['haze'], V.get('hazeColor', (0.62, 0.70, 0.82)))
    add_camera(to_bl(*cam), to_bl(*look), lens=V['lens'])
    sc.camera.data.clip_end = 60000
    # atmospheric haze via volume-free mist: use film exposure + world strength; keep it simple and physical
    out = os.path.join(REPO, 'renders', 'city', f'{view}.png')
    render_still(out)
    print(f'[render] saved {out}', flush=True)


if __name__ == '__main__':
    main()
