"""SF tree species for instancing (Blender, headless): Monterey cypress, blue-gum eucalyptus, Monterey pine, redwood-type
conifer, London-plane-type broadleaf, small evergreen street tree, Canary Island date palm, Mexican fan palm, coastal
scrub shrub.

  Blender -b -P blender/city/trees.py -- [--only broadleaf,palm_date] [--textures-only]

1. Textures are rendered by Cycles from real geometry: leaf litter canopies (thousands of instanced leaf/needle cards
   scattered in a periodic slab, top-down orthographic, sky-lit so inner leaves are darker), bark (displaced noise), and
   palm fronds (leaflets on a rachis, alpha).
2. Each species is modelled from code (trunk, limbs, displaced canopy clumps with vertex-colour ambient occlusion;
   palms with arching frond strips) at two LODs and exported as assets/sf/city/trees/<species>.glb with nodes
   '<species>_lod0' and '<species>_lod1'. Origin = trunk base, +Y up in glTF, height = refHeight in trees.json.
"""
import math
import os
import random
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix, noise

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'common'))
from util import reset_scene, setup_cycles, export_glb, REPO  # noqa: E402

OUT = os.path.join(REPO, 'assets', 'sf', 'city', 'trees')
TEX = os.path.join(OUT, 'tex')
REF_H = {'broadleaf': 12, 'small': 7, 'eucalyptus': 28, 'cypress': 14, 'pine': 18, 'conifer': 22, 'palm_date': 11,
         'palm_fan': 16, 'shrub': 2}


def lin(c):
    f = lambda x: (x / 255) / 12.92 if x / 255 <= 0.04045 else ((x / 255 + 0.055) / 1.055) ** 2.4
    return tuple(f(v) for v in c)


# ================================================================================================ texture rendering
def ortho_cam(size, z=20.0, res=512):
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = size
    ob = bpy.data.objects.new('cam', cam)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (size / 2, size / 2, z)
    bpy.context.scene.camera = ob
    sc = bpy.context.scene
    sc.render.resolution_x = sc.render.resolution_y = res
    return ob


def sky_world(strength=1.0):
    w = bpy.data.worlds.new('W')
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (1, 1, 1, 1)
    bg.inputs[1].default_value = strength


def simple_mat(name, color, rough=0.8, emit=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Specular IOR Level'].default_value = 0.1
    return m


def leaf_mesh(kind):
    bm = bmesh.new()
    if kind == 'needle':
        # a small spray of needles: thin quads radiating
        for k in range(7):
            a = k / 7 * math.pi * 2
            d = Vector((math.cos(a), math.sin(a), 0))
            p = Vector((-d.y, d.x, 0)) * 0.006
            vs = [bm.verts.new(v) for v in (p, -p, d * 0.09 - p, d * 0.09 + p)]
            bm.faces.new(vs)
    else:
        L, Wd = (0.11, 0.05) if kind == 'broad' else (0.12, 0.022)
        n = 8
        vs = []
        for k in range(n):
            t = k / (n - 1)
            w = math.sin(t * math.pi) * Wd
            vs.append((t * L, w))
        pts = [Vector((x, y, 0)) for x, y in vs] + [Vector((x, -y, 0)) for x, y in reversed(vs[1:-1])]
        bm.faces.new([bm.verts.new(p) for p in pts])
    me = bpy.data.meshes.new('leaf')
    bm.to_mesh(me)
    bm.free()
    return me


def render_leaves(name, kind, colors, size=1.2, count=5200, res=1024):
    """Periodic top-down canopy texture made of real leaf geometry."""
    reset_scene()
    sc = setup_cycles(samples=48, width=res, height=res, gpu='--cpu' not in sys.argv)
    sc.view_settings.view_transform = 'Standard'
    sky_world(1.0)
    ortho_cam(size, res=res)
    me = leaf_mesh(kind)
    mats = [simple_mat(f'l{i}', lin(c), 0.6) for i, c in enumerate(colors)]
    under = simple_mat('under', lin((34, 50, 26)), 1.0)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size * 1.5)
    ground = bpy.data.meshes.new('g')
    bm.to_mesh(ground)
    bm.free()
    g = bpy.data.objects.new('g', ground)
    g.location = (size / 2, size / 2, -0.25)
    g.data.materials.append(under)
    sc.collection.objects.link(g)
    rnd = random.Random(hash(name) & 0xffff)
    objs = []
    for k in range(count):
        x, y, z = rnd.uniform(0, size), rnd.uniform(0, size), rnd.uniform(-0.2, 0.0)
        rot = (rnd.uniform(-0.9, 0.9), rnd.uniform(-0.9, 0.9), rnd.uniform(0, math.pi * 2))
        mat = mats[rnd.randrange(len(mats))]
        s = rnd.uniform(0.8, 1.25)
        for ox in (-size, 0, size):
            for oy in (-size, 0, size):
                px, py = x + ox, y + oy
                if -0.15 <= px <= size + 0.15 and -0.15 <= py <= size + 0.15:
                    objs.append(((px, py, z), rot, s, mat))
    # build one mesh with all leaves (fast)
    bm = bmesh.new()
    src = [v.co.copy() for v in me.vertices]
    faces = [list(p.vertices) for p in me.polygons]
    mat_index = {m.name: i for i, m in enumerate(mats)}
    for (loc, rot, s, mat) in objs:
        M = Matrix.Translation(loc) @ Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[0], 4, 'X') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Scale(s, 4)
        vs = [bm.verts.new(M @ c) for c in src]
        for f in faces:
            face = bm.faces.new([vs[i] for i in f])
            face.material_index = mat_index[mat.name]
    lm = bpy.data.meshes.new('leaves')
    bm.to_mesh(lm)
    bm.free()
    for m in mats:
        lm.materials.append(m)
    lo = bpy.data.objects.new('leaves', lm)
    sc.collection.objects.link(lo)
    os.makedirs(TEX, exist_ok=True)
    sc.render.filepath = os.path.join(TEX, f'{name}.png')
    bpy.ops.render.render(write_still=True)
    # normal pass via emission of world normals (flat top-down -> tangent space = world xy)
    for m in mats + [under]:
        nt = m.node_tree
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        vm = nt.nodes.new('ShaderNodeVectorMath')
        vm.operation = 'MULTIPLY_ADD'
        vm.inputs[1].default_value = (0.5, 0.5, 0.5)
        vm.inputs[2].default_value = (0.5, 0.5, 0.5)
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(geo.outputs['Normal'], vm.inputs[0])
        nt.links.new(vm.outputs[0], em.inputs['Color'])
        nt.links.new(em.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
    sky_world(0.0)
    sc.cycles.samples = 16
    sc.cycles.use_denoising = False
    sc.view_settings.view_transform = 'Raw'
    sc.render.filepath = os.path.join(TEX, f'{name}_n.png')
    bpy.ops.render.render(write_still=True)


def render_bark(name, color, res=512, size=1.0, ridges=True):
    reset_scene()
    sc = setup_cycles(samples=32, width=res, height=res, gpu='--cpu' not in sys.argv)
    sc.view_settings.view_transform = 'Standard'
    sky_world(1.0)
    ortho_cam(size, res=res)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=200, y_segments=200, size=size / 2)
    for v in bm.verts:
        x, y = v.co.x + size / 2, v.co.y + size / 2
        # periodic noise via torus mapping
        ax, ay = x / size * math.pi * 2, y / size * math.pi * 2
        p = Vector((math.cos(ax) * 3, math.sin(ax) * 3, math.cos(ay) * 1.2))
        n1 = noise.noise(p + Vector((0, 0, math.sin(ay) * 1.2)))
        rid = abs(math.sin(ax * 9 + n1 * 3)) if ridges else 0.5
        v.co.z = rid * 0.012 + n1 * 0.01
        v.co.x, v.co.y = x, y
    me = bpy.data.meshes.new('bark')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('bark', me)
    sc.collection.objects.link(ob)
    me.materials.append(simple_mat('b', lin(color), 0.9))
    for p in me.polygons:
        p.use_smooth = True
    sun = bpy.data.lights.new('s', 'SUN')
    sun.energy = 1.5
    so = bpy.data.objects.new('s', sun)
    so.rotation_euler = (0.9, 0.3, 0.4)
    sc.collection.objects.link(so)
    sc.render.filepath = os.path.join(TEX, f'{name}.png')
    bpy.ops.render.render(write_still=True)


def render_frond(name, color, dead=False, fan=False, res=512):
    """Palm frond on transparent film: rachis along +Y, leaflets either side (fan: radial segments)."""
    reset_scene()
    sc = setup_cycles(samples=32, width=res, height=res, transparent=True, gpu='--cpu' not in sys.argv)
    sc.view_settings.view_transform = 'Standard'
    sky_world(1.0)
    ortho_cam(1.0, res=res)
    rnd = random.Random(5)
    bm = bmesh.new()
    def leaflet(p0, d, L, w):
        n = Vector((-d.y, d.x, 0))
        pts = [p0 + n * w * 0.3, p0 + d * L * 0.5 + n * w, p0 + d * L, p0 + d * L * 0.5 - n * w, p0 - n * w * 0.3]
        bm.faces.new([bm.verts.new(p) for p in pts])
    if fan:
        c = Vector((0.5, 0.12, 0))
        for k in range(38):
            a = math.radians(-75 + 150 * k / 37)
            d = Vector((math.sin(a), math.cos(a), 0))
            leaflet(c + d * 0.05, d, 0.8 + rnd.uniform(-0.05, 0.05), 0.018)
    else:
        for k in range(46):
            t = k / 45
            y = 0.03 + t * 0.94
            L = 0.42 * math.sin(math.pi * (0.15 + 0.85 * t)) + 0.04
            for side in (-1, 1):
                a = math.radians(55 + rnd.uniform(-8, 8))
                d = Vector((side * math.sin(a), math.cos(a), 0))
                leaflet(Vector((0.5, y, 0)), d, L, 0.012)
        # rachis
        bm.faces.new([bm.verts.new(p) for p in (Vector((0.49, 0, 0)), Vector((0.51, 0, 0)), Vector((0.503, 1, 0)), Vector((0.497, 1, 0)))])
    me = bpy.data.meshes.new('frond')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('frond', me)
    sc.collection.objects.link(ob)
    me.materials.append(simple_mat('f', lin(color), 0.6))
    sc.render.film_transparent = True
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.filepath = os.path.join(TEX, f'{name}.png')
    bpy.ops.render.render(write_still=True)


def render_card(name, kind, colors, count=260, res=512):
    """Leaf-cluster card (alpha): many leaves around a sprig inside a soft disc, front view on transparent film."""
    reset_scene()
    sc = setup_cycles(samples=32, width=res, height=res, transparent=True, gpu='--cpu' not in sys.argv)
    sc.view_settings.view_transform = 'Standard'
    sc.render.film_transparent = True
    sc.render.image_settings.color_mode = 'RGBA'
    sky_world(1.0)
    ortho_cam(1.0, res=res)
    me = leaf_mesh(kind)
    mats = [simple_mat(f'c{i}', lin(c), 0.6) for i, c in enumerate(colors)]
    rnd = random.Random(hash(name) & 0xffff)
    bm = bmesh.new()
    src = [v.co.copy() for v in me.vertices]
    faces = [list(p.vertices) for p in me.polygons]
    sc_leaf = 1.05 if kind != 'needle' else 1.3
    for k in range(count):
        a = rnd.uniform(0, math.pi * 2)
        lobe = 0.34 + 0.1 * math.sin(a * 3 + 1.3) + 0.05 * math.sin(a * 7)   # ragged cluster outline
        r = lobe * math.sqrt(rnd.random())
        x, y = 0.5 + r * math.cos(a), 0.5 + r * math.sin(a)
        rot = (rnd.uniform(-0.8, 0.8), rnd.uniform(-0.8, 0.8), rnd.uniform(0, math.pi * 2))
        M = Matrix.Translation((x, y, rnd.uniform(-0.1, 0.1))) @ Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[0], 4, 'X') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Scale(sc_leaf * rnd.uniform(0.8, 1.2), 4)
        vs = [bm.verts.new(M @ c) for c in src]
        mi = rnd.randrange(len(mats))
        for f in faces:
            face = bm.faces.new([vs[i] for i in f])
            face.material_index = mi
    lm = bpy.data.meshes.new('card')
    bm.to_mesh(lm)
    bm.free()
    for m in mats:
        lm.materials.append(m)
    ob = bpy.data.objects.new('card', lm)
    sc.collection.objects.link(ob)
    sc.render.filepath = os.path.join(TEX, f'{name}.png')
    bpy.ops.render.render(write_still=True)


def render_textures():
    render_leaves('leaves_broad', 'broad', [(86, 124, 52), (104, 140, 60), (76, 110, 46), (118, 150, 66), (94, 130, 56)])
    render_leaves('leaves_needle', 'needle', [(58, 92, 48), (68, 102, 54), (50, 80, 42), (76, 108, 58)], count=6500)
    render_leaves('leaves_euc', 'narrow', [(108, 130, 100), (124, 144, 110), (96, 116, 90), (138, 152, 116)], count=4200)
    render_bark('bark_brown', (92, 74, 60))
    render_bark('bark_euc', (150, 140, 124), ridges=False)
    render_bark('bark_palm', (120, 104, 84))
    render_frond('frond_date', (70, 100, 44))
    render_frond('frond_fan', (84, 110, 52), fan=True)
    render_cards()


def render_cards():
    render_card('card_broad', 'broad', [(86, 124, 52), (104, 140, 60), (76, 110, 46), (118, 150, 66)], count=700)
    render_card('card_needle', 'needle', [(58, 92, 48), (68, 102, 54), (50, 80, 42), (76, 108, 58)], count=1100)
    render_card('card_euc', 'narrow', [(108, 130, 100), (124, 144, 110), (96, 116, 90), (138, 152, 116)], count=700)


# ===================================================================================================== tree models
def image_mat(name, tex, normal=None, alpha=False, color=(1, 1, 1), rough=0.85, vcol=True, double=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    img = nt.nodes.new('ShaderNodeTexImage')
    img.image = bpy.data.images.load(os.path.join(TEX, tex + '.png'), check_existing=True)
    last = img.outputs['Color']
    if color != (1, 1, 1):
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        nt.links.new(last, mix.inputs[6])
        mix.inputs[7].default_value = (*color, 1)
        last = mix.outputs[2]
    if vcol:
        vc = nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = 'Col'
        mix2 = nt.nodes.new('ShaderNodeMix')
        mix2.data_type = 'RGBA'
        mix2.blend_type = 'MULTIPLY'
        mix2.inputs['Factor'].default_value = 1.0
        nt.links.new(last, mix2.inputs[6])
        nt.links.new(vc.outputs['Color'], mix2.inputs[7])
        last = mix2.outputs[2]
    nt.links.new(last, b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    b.inputs['Specular IOR Level'].default_value = 0.2
    if normal:
        nimg = nt.nodes.new('ShaderNodeTexImage')
        nimg.image = bpy.data.images.load(os.path.join(TEX, normal + '.png'), check_existing=True)
        nimg.image.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = 0.8
        nt.links.new(nimg.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if alpha:
        nt.links.new(img.outputs['Alpha'], b.inputs['Alpha'])
        try:
            m.blend_method = 'CLIP'
        except Exception:
            pass
        try:
            m.surface_render_method = 'DITHERED'
        except Exception:
            pass
    m.use_backface_culling = not double
    return m


class MB:
    """bmesh-based mesh builder with per-face material index, UVs and a 'Col' corner colour (AO)."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.col = self.bm.loops.layers.color.new('Col')
        self.mats = []
        self.custom = {}      # BMVert -> custom normal (foliage: radial from the crown centre)

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def face(self, pts, uvs, mat, cols=None):
        vs = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = self.mi(mat)
        for k, l in enumerate(f.loops):
            l[self.uv].uv = uvs[k]
            c = cols[k] if cols else 1.0
            l[self.col] = (c, c, c, 1.0)
        return f

    def cylinder(self, p0, p1, r0, r1, sides, mat, v_scale=1.0, smooth=True, u_rep=1.0):
        p0, p1 = Vector(p0), Vector(p1)
        axis = (p1 - p0)
        L = axis.length
        d = axis.normalized()
        a = Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))
        n1 = d.cross(a).normalized()
        n2 = d.cross(n1)
        ring = lambda p, r, k: p + (n1 * math.cos(k / sides * math.pi * 2) + n2 * math.sin(k / sides * math.pi * 2)) * r
        for k in range(sides):
            q = [ring(p0, r0, k), ring(p0, r0, k + 1), ring(p1, r1, k + 1), ring(p1, r1, k)]
            u0, u1 = k / sides * u_rep, (k + 1) / sides * u_rep
            f = self.face(q, [(u0, 0), (u1, 0), (u1, L * v_scale), (u0, L * v_scale)], mat, [0.75, 0.75, 1, 1])
            f.smooth = smooth

    def blob(self, c, r, mat, subdiv=1, seed=0, rough=0.22, tex_scale=0.45, ao=(0.62, 1.0), flat_bottom=0.0, crown=None):
        """Displaced icosphere canopy clump with cube-projected UVs, height-based AO colour and soft 'volumetric'
        normals (blend of the clump and whole-crown radial directions) so the foliage shades like a leafy volume."""
        c = Vector(c)
        crown = Vector(crown) if crown is not None else c
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=subdiv, radius=1.0)
        rnd = random.Random(seed)
        off = Vector((rnd.uniform(0, 100), rnd.uniform(0, 100), rnd.uniform(0, 100)))
        for v in tmp.verts:
            n = v.co.normalized()
            k = 1.0 + rough * noise.noise(n * 1.7 + off) + rough * 0.5 * noise.noise(n * 3.9 + off)
            p = Vector((n.x * r[0], n.y * r[1], n.z * r[2])) * k
            if flat_bottom and p.z < -r[2] * flat_bottom:
                p.z = -r[2] * flat_bottom + (p.z + r[2] * flat_bottom) * 0.25
            v.co = c + p
        tmp.normal_update()
        for f in tmp.faces:
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            pts = [v.co.copy() for v in f.verts]
            uvs = []
            for p in pts:
                q = [p[i] for i in range(3) if i != ax]
                uvs.append((q[0] * tex_scale, q[1] * tex_scale))
            cols = []
            for p in pts:
                t = (p.z - (c.z - r[2])) / (2 * r[2])
                cols.append(ao[0] + (ao[1] - ao[0]) * max(0.0, min(1.0, t)))
            nf = self.face(pts, uvs, mat, cols)
            nf.smooth = True
            for v in nf.verts:
                a = (v.co - c)
                b_ = (v.co - crown)
                a = a.normalized() if a.length > 1e-6 else Vector((0, 0, 1))
                b_ = b_.normalized() if b_.length > 1e-6 else Vector((0, 0, 1))
                self.custom[v] = (a * 0.45 + b_ * 0.55 + Vector((0, 0, 0.15))).normalized()
        tmp.free()

    def cards(self, c, r, mat, n=14, size=1.6, seed=0, crown=None):
        """Alpha-tested leaf-cluster cards on the clump surface (fuzzy silhouette), normals radial from the crown."""
        c = Vector(c)
        crown = Vector(crown) if crown is not None else c
        rnd = random.Random(seed * 31 + 7)
        gold = math.pi * (3 - math.sqrt(5))
        for k in range(n):
            zz = 1 - 2 * (k + 0.5) / n
            rr = math.sqrt(max(0.0, 1 - zz * zz))
            a = gold * k + rnd.uniform(0, 0.5)
            d = Vector((math.cos(a) * rr, math.sin(a) * rr, zz))
            p = c + Vector((d.x * r[0], d.y * r[1], d.z * r[2])) * rnd.uniform(0.92, 1.08)
            nrm = d.normalized()
            t1 = nrm.cross(Vector((0, 0, 1)))
            if t1.length < 1e-3:
                t1 = Vector((1, 0, 0))
            t1.normalize()
            t2 = nrm.cross(t1)
            ang = rnd.uniform(0, math.pi * 2)
            u = t1 * math.cos(ang) + t2 * math.sin(ang)
            v = nrm.cross(u)
            h = size * rnd.uniform(0.8, 1.2) / 2
            q = [p - u * h - v * h, p + u * h - v * h, p + u * h + v * h, p - u * h + v * h]
            t = (p.z - (c.z - r[2])) / (2 * r[2])
            ao = 0.7 + 0.3 * max(0.0, min(1.0, t))
            f = self.face(q, [(0, 0), (1, 0), (1, 1), (0, 1)], mat, [ao] * 4)
            f.smooth = True
            radial = (p - crown).normalized() if (p - crown).length > 1e-6 else nrm
            for vv in f.verts:
                self.custom[vv] = (radial * 0.7 + nrm * 0.3 + Vector((0, 0, 0.15))).normalized()

    def frond(self, base, direction, length, width, droop, mat, segs=5, twist=0.0):
        """Arching frond strip (texture v along the frond)."""
        base = Vector(base)
        d = Vector(direction).normalized()
        side = d.cross(Vector((0, 0, 1)))
        if side.length < 1e-3:
            side = Vector((1, 0, 0))
        side.normalize()
        pts = []
        for k in range(segs + 1):
            t = k / segs
            p = base + d * (length * t) + Vector((0, 0, -droop * t * t * length))
            pts.append(p)
        for k in range(segs):
            t0, t1 = k / segs, (k + 1) / segs
            s0 = side * width * 0.5 * (1 - 0.2 * t0)
            s1 = side * width * 0.5 * (1 - 0.2 * t1)
            lift0 = Vector((0, 0, twist * t0))
            lift1 = Vector((0, 0, twist * t1))
            q = [pts[k] - s0 - lift0, pts[k] + s0 + lift0, pts[k + 1] + s1 + lift1, pts[k + 1] - s1 - lift1]
            f = self.face(q, [(0, t0), (1, t0), (1, t1), (0, t1)], mat, [0.8, 0.8, 1, 1])
            f.smooth = True

    def to_object(self, name):
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.verts.index_update()
        vn = {v.index: n for v, n in self.custom.items()}
        self.bm.to_mesh(me)
        self.bm.free()
        if vn:
            loop_normals = []
            for poly in me.polygons:
                for li in poly.loop_indices:
                    vi = me.loops[li].vertex_index
                    n = vn.get(vi)
                    loop_normals.append(tuple(n) if n is not None else tuple(poly.normal))
            me.normals_split_custom_set(loop_normals)
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ca = me.color_attributes.get('Col')
        if ca:
            me.color_attributes.active_color = ca
        return ob


def clumps_ring(rnd, n, center_z, spread, r, rz, jitter=0.3):
    out = []
    for k in range(n):
        a = k / n * math.pi * 2 + rnd.uniform(-jitter, jitter)
        d = spread * rnd.uniform(0.6, 1.0)
        out.append(((math.cos(a) * d, math.sin(a) * d, center_z + rnd.uniform(-1, 1) * rz * 0.3),
                    (r * rnd.uniform(0.8, 1.15), r * rnd.uniform(0.8, 1.15), rz * rnd.uniform(0.85, 1.1))))
    return out


def build_species(sp):
    reset_scene()
    rnd = random.Random(sp)
    H = REF_H[sp]
    bark = image_mat(f'bark_{sp}', 'bark_euc' if sp == 'eucalyptus' else ('bark_palm' if sp.startswith('palm') else 'bark_brown'),
                     rough=0.95, vcol=True)
    leaf_tex = {'broadleaf': 'leaves_broad', 'small': 'leaves_broad', 'eucalyptus': 'leaves_euc', 'cypress': 'leaves_needle',
                'pine': 'leaves_needle', 'conifer': 'leaves_needle', 'shrub': 'leaves_euc'}.get(sp)
    tint = {'broadleaf': (1.0, 1.0, 0.95), 'small': (0.85, 0.95, 0.85), 'eucalyptus': (1.0, 1.0, 1.0), 'cypress': (0.8, 0.9, 0.85),
            'pine': (0.95, 1.0, 0.95), 'conifer': (0.9, 1.0, 0.9), 'shrub': (1.05, 1.0, 0.85)}.get(sp, (1, 1, 1))
    lod0, lod1 = MB(), MB()
    if leaf_tex:
        leaves = image_mat(f'leaves_{sp}', leaf_tex, normal=leaf_tex + '_n', color=tint, rough=0.8)
        leaves1 = image_mat(f'leaves_{sp}_far', leaf_tex, color=tint, rough=0.9)
    clumps, trunk_top, trunk_r = [], 0.3 * H, 0.02 * H
    if sp == 'broadleaf':
        trunk_top, trunk_r = 4.5, 0.32
        clumps = [((0, 0, 8.2), (4.3, 4.3, 3.6))] + clumps_ring(rnd, 5, 7.6, 3.0, 2.8, 2.4)
        far = [((0, 0, 8.0), (5.6, 5.6, 4.0))]
    elif sp == 'small':
        trunk_top, trunk_r = 2.4, 0.16
        clumps = [((0, 0, 4.7), (2.2, 2.2, 2.3))] + clumps_ring(rnd, 3, 4.3, 1.2, 1.5, 1.5)
        far = [((0, 0, 4.6), (2.7, 2.7, 2.4))]
    elif sp == 'eucalyptus':
        trunk_top, trunk_r = 19.0, 0.5
        clumps = [((0.6, 0.3, 23.5), (3.6, 3.4, 3.4))] + clumps_ring(rnd, 5, 20.0, 4.2, 3.0, 2.6, 0.6) + clumps_ring(rnd, 3, 25.0, 2.5, 2.4, 2.0)
        far = [((0.3, 0, 22.0), (5.8, 5.4, 5.5))]
    elif sp == 'cypress':
        trunk_top, trunk_r = 4.0, 0.55
        clumps = [((0, 0, 11.0), (4.4, 4.0, 2.2))] + clumps_ring(rnd, 6, 10.2, 4.6, 3.4, 1.9, 0.5) + clumps_ring(rnd, 3, 12.2, 2.4, 2.8, 1.5)
        far = [((0, 0, 10.6), (7.8, 7.2, 3.2))]
    elif sp == 'pine':
        trunk_top, trunk_r = 6.5, 0.45
        clumps = [((0, 0, 13.5), (4.2, 4.2, 3.6))] + clumps_ring(rnd, 5, 11.5, 3.6, 3.3, 2.8) + clumps_ring(rnd, 2, 15.6, 1.8, 2.4, 1.8)
        far = [((0, 0, 13.8), (6.2, 6.2, 4.6))]
    elif sp == 'conifer':
        trunk_top, trunk_r = 6.0, 0.55
        far = []
    elif sp == 'shrub':
        trunk_top, trunk_r = 0.0, 0.0
        clumps = [((0, 0, 0.9), (1.4, 1.2, 0.95))] + clumps_ring(rnd, 3, 0.8, 0.9, 1.0, 0.8)
        far = [((0, 0, 0.9), (1.9, 1.7, 1.0))]
    if sp == 'conifer':
        cardc = image_mat('cards_conifer', 'card_needle', alpha=True, color=tint, rough=0.8, double=True)
        # stacked cones (redwood / cedar silhouette)
        lod0.cylinder((0, 0, 0), (0, 0, H * 0.9), trunk_r, 0.1, 7, bark, v_scale=0.5)
        levels = 6
        for k in range(levels):
            z0 = 3.0 + k * (H - 4.0) / levels
            r = 3.6 * (1 - k / levels) + 0.8
            tmp = MB()
            lod0.blob((0, 0, z0 + 1.6), (r, r, 2.2), leaves, subdiv=2, seed=k, rough=0.18, flat_bottom=0.5)
            lod0.cards((0, 0, z0 + 1.6), (r, r, 2.2), cardc, n=max(8, int(r * r * 1.4)), size=1.4, seed=k)
        lod1.cylinder((0, 0, 0), (0, 0, 3.5), trunk_r, trunk_r * 0.7, 3, bark, smooth=False)
        lod1.blob((0, 0, H * 0.55), (3.6, 3.6, H * 0.45), leaves1, subdiv=1, seed=3, rough=0.1)
    elif sp.startswith('palm'):
        date = sp == 'palm_date'
        frond_mat = image_mat(f'frond_{sp}', 'frond_date' if date else 'frond_fan', alpha=True, rough=0.7, vcol=True, double=True)
        top = H * (0.8 if date else 0.93)
        r0 = 0.5 if date else 0.26
        # slightly curved trunk in segments
        segs = 6
        prev = Vector((0, 0, 0))
        for k in range(segs):
            t = (k + 1) / segs
            p = Vector((0.0 if date else 0.5 * math.sin(t * 1.4), 0, top * t))
            lod0.cylinder(prev, p, r0 * (1 - 0.15 * (k / segs)), r0 * (1 - 0.15 * t), 8, bark, v_scale=0.6, u_rep=2)
            prev = p
        crown = prev
        if date:
            lod0.blob(crown + Vector((0, 0, 0.3)), (0.9, 0.9, 0.9), bark, subdiv=1, rough=0.1, tex_scale=1.0)
            n = 26
            for k in range(n):
                a = k / n * math.pi * 2 * 1.618 * 3
                tilt = 0.25 + 0.75 * (k % 4) / 3
                d = Vector((math.cos(a) * tilt, math.sin(a) * tilt, 0.6 - tilt * 0.5))
                lod0.frond(crown + Vector((0, 0, 0.4)), d, 5.0, 1.6, 0.3 + 0.35 * tilt, frond_mat, segs=5)
        else:
            lod0.cylinder(crown - Vector((0, 0, 2.6)), crown - Vector((0, 0, 0.2)), 0.55, 0.45, 8, bark, v_scale=0.3)   # dead-frond skirt
            n = 16
            for k in range(n):
                a = k / n * math.pi * 2 * 1.618 * 2
                tilt = 0.4 + 0.6 * (k % 3) / 2
                d = Vector((math.cos(a) * tilt, math.sin(a) * tilt, 0.8 - tilt * 0.6))
                lod0.frond(crown, d, 2.4, 1.5, 0.15 + 0.2 * tilt, frond_mat, segs=3)
        # LOD1: 3-sided trunk + 4 crossed drooping cards
        lod1.cylinder((0, 0, 0), tuple(crown), r0, r0 * 0.8, 3, bark, smooth=False)
        for k in range(4):
            a = k / 4 * math.pi * 2 + 0.4
            d = Vector((math.cos(a), math.sin(a), 0.35))
            lod1.frond(crown, d, 4.6 if date else 2.4, 2.2 if date else 2.0, 0.45, frond_mat, segs=2)
    else:
        if trunk_top > 0:
            lod0.cylinder((0, 0, 0), (0, 0, trunk_top + 1.0), trunk_r, trunk_r * 0.6, 7, bark, v_scale=0.5)
            # limbs to the clumps
            for (c, r) in clumps[1:6]:
                lod0.cylinder((0, 0, trunk_top * 0.9), (c[0] * 0.7, c[1] * 0.7, c[2] - r[2] * 0.4), trunk_r * 0.45, trunk_r * 0.2, 5, bark, v_scale=0.5)
            lod1.cylinder((0, 0, 0), (0, 0, trunk_top + 0.5), trunk_r, trunk_r * 0.7, 3, bark, smooth=False)
        crown = clumps[0][0] if clumps else (0, 0, 0)
        card_tex = {'leaves_broad': 'card_broad', 'leaves_needle': 'card_needle', 'leaves_euc': 'card_euc'}[leaf_tex]
        cardm = image_mat(f'cards_{sp}', card_tex, alpha=True, color=tint, rough=0.8, double=True)
        for k, (c, r) in enumerate(clumps):
            lod0.blob(c, r, leaves, subdiv=3 if k == 0 else 2, seed=k * 7 + len(sp), rough=0.2, crown=crown)
            area = r[0] * r[1] + r[1] * r[2] + r[0] * r[2]
            lod0.cards(c, r, cardm, n=max(8, int(area / 2.2)), size=1.5 if sp != 'shrub' else 0.8, seed=k + len(sp), crown=crown)
        for k, (c, r) in enumerate(far):
            lod1.blob(c, r, leaves1, subdiv=1, seed=k, rough=0.1, crown=c)
    o0 = lod0.to_object(f'{sp}_lod0')
    o1 = lod1.to_object(f'{sp}_lod1')
    for o in (o0, o1):
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        print(f'[trees] {o.name}: {tris} tris', flush=True)
    os.makedirs(OUT, exist_ok=True)
    export_glb(os.path.join(OUT, f'{sp}.glb'), objects=[o0, o1], image_format='AUTO' if sp.startswith('palm') else 'JPEG')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = None
    if '--only' in argv:
        only = set(argv[argv.index('--only') + 1].split(','))
    if '--cards-only' in argv:
        render_cards()
        render_bark('bark_euc', (150, 140, 124), ridges=False)
    elif '--models-only' not in argv:
        render_textures()
    if '--textures-only' in argv:
        return
    for sp in REF_H:
        if only and sp not in only:
            continue
        build_species(sp)


if __name__ == '__main__':
    main()
