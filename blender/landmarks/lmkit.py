"""W3 landmark modeling kit (Blender 5.2, headless).

Everything is built from code: a small mesh builder (MB) accumulates quads/triangles with per-corner UVs, then turns
into one Blender object per material. Textures are generated procedurally with numpy (deterministic seeds), stored as
Blender images, saved under assets/sf/landmarks/tex/ and embedded in the GLBs.

Frame convention (per landmark): Blender +X = right, +Y = forward (landmark heading), +Z = up.
glTF/Three: (x, y, z)_three = (X, Z, -Y)_blender.  Metadata (collision, lights) is written in Three local coordinates.
"""
import json
import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'common'))
from util import REPO, reset_scene, export_glb  # noqa: E402,F401

OUT = os.path.join(REPO, 'assets', 'sf', 'landmarks')
TEX = os.path.join(OUT, 'tex')
LAYOUT = json.load(open(os.path.join(HERE, 'layout.json')))

# ----------------------------------------------------------------------------------------------------------------
# vector helpers (plain tuples -> numpy)


def V(*a):
    return np.array(a if len(a) > 1 else a[0], dtype=np.float64)


def norm(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def perp_axes(d, up=(0.0, 0.0, 1.0)):
    """Two unit axes perpendicular to direction d: (side, upish)."""
    d = norm(V(d))
    up = V(up)
    if abs(np.dot(d, up)) > 0.98:
        up = V(1.0, 0.0, 0.0) if abs(d[0]) < 0.9 else V(0.0, 1.0, 0.0)
    s = norm(np.cross(d, up))
    u = norm(np.cross(s, d))
    return s, u


# ----------------------------------------------------------------------------------------------------------------
class MB:
    """Mesh builder: vertices, faces (tuples of indices), per-face-corner UVs, per-face smooth flag."""

    def __init__(self, name=''):
        self.name = name
        self.v = []
        self.f = []
        self.uv = []
        self.smooth = []
        self.col = []   # per-vertex color (r,g,b) optional
        self.anc = []   # per-vertex ground anchor (x, g, z) in Three local coords, or None
        self.anchor = None

    def __len__(self):
        return len(self.f)

    def tris(self):
        return sum(len(f) - 2 for f in self.f)

    def add_verts(self, pts, col=None):
        i0 = len(self.v)
        self.v.extend([tuple(map(float, p)) for p in pts])
        c = (1.0, 1.0, 1.0) if col is None else col
        self.col.extend([c] * len(pts))
        self.anc.extend([self.anchor] * len(pts))
        return i0

    def face(self, idx, uvs, smooth=False):
        self.f.append(tuple(idx))
        self.uv.append([tuple(map(float, t)) for t in uvs])
        self.smooth.append(smooth)

    # -- planar quad with world-projected UVs (texel density `ts` meters per UV unit)
    def quad(self, a, b, c, d, ts=4.0, uv=None, col=None, uvoff=(0.0, 0.0)):
        a, b, c, d = V(a), V(b), V(c), V(d)
        i0 = self.add_verts([a, b, c, d], col)
        if uv is None:
            t = b - a
            if np.linalg.norm(t) < 1e-9:
                t = c - d
            t = norm(t)
            n = norm(np.cross(b - a, d - a))
            bt = norm(np.cross(n, t))
            uv = [(np.dot(p, t) / ts + uvoff[0], np.dot(p, bt) / ts + uvoff[1]) for p in (a, b, c, d)]
        self.face((i0, i0 + 1, i0 + 2, i0 + 3), uv)

    def quad_facing(self, a, b, c, d, outward, ts=4.0, uv=None, col=None):
        """Quad whose normal is flipped if needed so that it points along `outward`."""
        A, B, D = V(a), V(b), V(d)
        if float(np.dot(np.cross(B - A, D - A), V(outward))) < 0:
            a, b, c, d = b, a, d, c
            if uv is not None:
                uv = [uv[1], uv[0], uv[3], uv[2]]
        self.quad(a, b, c, d, ts, uv=uv, col=col)

    def tri_facing(self, a, b, c, outward, ts=4.0, uv=None, col=None):
        A, B, C = V(a), V(b), V(c)
        if float(np.dot(np.cross(B - A, C - A), V(outward))) < 0:
            a, b = b, a
            if uv is not None:
                uv = [uv[1], uv[0], uv[2]]
        self.tri(a, b, c, ts, uv=uv, col=col)

    def tri(self, a, b, c, ts=4.0, uv=None, col=None):
        a, b, c = V(a), V(b), V(c)
        i0 = self.add_verts([a, b, c], col)
        if uv is None:
            t = norm(b - a)
            n = norm(np.cross(b - a, c - a))
            bt = norm(np.cross(n, t))
            uv = [(np.dot(p, t) / ts, np.dot(p, bt) / ts) for p in (a, b, c)]
        self.face((i0, i0 + 1, i0 + 2), uv)

    # -- oriented box: center, axes (unit ax, ay, az), half sizes. faces: subset of 'xXyYzZ' (lower=neg side)
    def obox(self, c, ax, ay, az, hx, hy, hz, ts=4.0, faces='xXyYzZ', col=None):
        c, ax, ay, az = V(c), V(ax), V(ay), V(az)
        P = lambda sx, sy, sz: c + ax * (sx * hx) + ay * (sy * hy) + az * (sz * hz)
        if 'X' in faces:
            self.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), ts, col=col)
        if 'x' in faces:
            self.quad(P(-1, 1, -1), P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), ts, col=col)
        if 'Y' in faces:
            self.quad(P(1, 1, -1), P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), ts, col=col)
        if 'y' in faces:
            self.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), ts, col=col)
        if 'Z' in faces:
            self.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), ts, col=col)
        if 'z' in faces:
            self.quad(P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), P(-1, -1, -1), ts, col=col)

    def box(self, lo, hi, ts=4.0, faces='xXyYzZ', col=None):
        lo, hi = V(lo), V(hi)
        c = (lo + hi) / 2
        h = (hi - lo) / 2
        self.obox(c, (1, 0, 0), (0, 1, 0), (0, 0, 1), h[0], h[1], h[2], ts, faces, col)

    def beam(self, p0, p1, w, h, up=(0.0, 0.0, 1.0), ts=4.0, caps=True, col=None):
        """Rectangular member from p0 to p1: width w (side axis), height h (up axis)."""
        p0, p1 = V(p0), V(p1)
        d = p1 - p0
        L = np.linalg.norm(d)
        if L < 1e-6:
            return
        dn = d / L
        s, u = perp_axes(dn, up)
        self.obox((p0 + p1) / 2, s, dn, u, w / 2, L / 2, h / 2, ts, 'xXzZyY' if caps else 'xXzZ', col)

    def tube(self, pts, r, sides=8, ts=4.0, closed_ends=False, up=(0.0, 0.0, 1.0), rs=None, col=None):
        """Smooth round tube along a polyline (parallel-transported frame). UV u = around, v = along / ts."""
        pts = [V(p) for p in pts]
        n = len(pts)
        rings = []
        dist = [0.0]
        for i in range(1, n):
            dist.append(dist[-1] + np.linalg.norm(pts[i] - pts[i - 1]))
        prev_s = None
        for i in range(n):
            d = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
            d = norm(d)
            if prev_s is None:
                s, u = perp_axes(d, up)
            else:
                u = norm(np.cross(prev_s, d))
                s = norm(np.cross(d, u))
            prev_s = s
            rr = r if rs is None else rs[i]
            ring = [pts[i] + (s * math.cos(a) + u * math.sin(a)) * rr for a in np.linspace(0, 2 * math.pi, sides + 1)[:-1]]
            rings.append(self.add_verts(ring, col))
        circ = 2 * math.pi * r
        for i in range(n - 1):
            a0, a1 = rings[i], rings[i + 1]
            for k in range(sides):
                k1 = (k + 1) % sides
                u0, u1 = k / sides * circ / ts, (k + 1) / sides * circ / ts
                v0, v1 = dist[i] / ts, dist[i + 1] / ts
                self.face((a0 + k, a0 + k1, a1 + k1, a1 + k), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], smooth=True)
        if closed_ends:
            for ring, rev in ((rings[0], True), (rings[-1], False)):
                idx = [ring + k for k in range(sides)]
                if rev:
                    idx = idx[::-1]
                self.face(idx, [(0.5, 0.5)] * sides)

    def cylinder(self, c, r, h, sides=12, ts=4.0, cap_top=True, cap_bottom=False, r_top=None, col=None, smooth=True):
        """Vertical (Z) cylinder / cone frustum from base center c upward."""
        c = V(c)
        rt = r if r_top is None else r_top
        ang = np.linspace(0, 2 * math.pi, sides + 1)
        bot = self.add_verts([c + V(math.cos(a) * r, math.sin(a) * r, 0) for a in ang], col)
        top = self.add_verts([c + V(math.cos(a) * rt, math.sin(a) * rt, h) for a in ang], col)
        circ = 2 * math.pi * r
        for k in range(sides):
            self.face((bot + k, bot + k + 1, top + k + 1, top + k),
                      [(k / sides * circ / ts, 0), ((k + 1) / sides * circ / ts, 0), ((k + 1) / sides * circ / ts, h / ts), (k / sides * circ / ts, h / ts)], smooth=smooth)
        if cap_top and rt > 0:
            i0 = self.add_verts([c + V(math.cos(a) * rt, math.sin(a) * rt, h) for a in ang[:-1]], col)
            self.face([i0 + k for k in range(sides)], [(0.5 + 0.5 * math.cos(a), 0.5 + 0.5 * math.sin(a)) for a in ang[:-1]])
        if cap_bottom:
            i0 = self.add_verts([c + V(math.cos(a) * r, math.sin(a) * r, 0) for a in ang[:-1]], col)
            self.face([i0 + k for k in range(sides)][::-1], [(0.5 + 0.5 * math.cos(a), 0.5 + 0.5 * math.sin(a)) for a in ang[:-1]][::-1])

    def prism(self, poly, z0, z1, ts=4.0, top=True, bottom=False, col=None, wall_uv_v0=0.0):
        """Extrude a CCW polygon [(x,y)...] from z0 to z1. Walls use (perimeter, z) UVs."""
        n = len(poly)
        per = 0.0
        for i in range(n):
            a = V(poly[i][0], poly[i][1], z0)
            b = V(poly[(i + 1) % n][0], poly[(i + 1) % n][1], z0)
            L = np.linalg.norm(b - a)
            self.quad(a, b, b + V(0, 0, z1 - z0), a + V(0, 0, z1 - z0),
                      uv=[(per / ts, (z0 - wall_uv_v0) / ts), ((per + L) / ts, (z0 - wall_uv_v0) / ts),
                          ((per + L) / ts, (z1 - wall_uv_v0) / ts), (per / ts, (z1 - wall_uv_v0) / ts)], col=col)
            per += L
        if top:
            self.polygon([(p[0], p[1], z1) for p in poly], ts, col=col)
        if bottom:
            self.polygon([(p[0], p[1], z0) for p in poly[::-1]], ts, col=col)

    def polygon(self, pts3, ts=4.0, col=None):
        """Planar polygon (may be concave) -> triangulated with ear clipping via mapbox_earcut if available."""
        pts3 = [V(p) for p in pts3]
        n = len(pts3)
        if n == 3 or n == 4 and is_convex([(p[0], p[1]) for p in pts3]):
            i0 = self.add_verts(pts3, col)
            self.face(tuple(range(i0, i0 + n)), [(p[0] / ts, p[1] / ts) for p in pts3])
            return
        tri = earcut([(p[0], p[1]) for p in pts3])
        i0 = self.add_verts(pts3, col)
        for a, b, c in tri:
            self.face((i0 + a, i0 + b, i0 + c), [(pts3[k][0] / ts, pts3[k][1] / ts) for k in (a, b, c)])

    def merge(self, other, offset=(0, 0, 0), rotz=0.0, scale=1.0):
        """Append another builder, transformed (scale, then rotate about Z, then translate)."""
        c, s = math.cos(rotz), math.sin(rotz)
        o = V(offset)
        i0 = len(self.v)
        for p in other.v:
            x, y, z = p[0] * scale, p[1] * scale, p[2] * scale
            self.v.append((x * c - y * s + o[0], x * s + y * c + o[1], z + o[2]))
        self.col.extend(other.col)
        self.anc.extend(other.anc)
        for f, uv, sm in zip(other.f, other.uv, other.smooth):
            self.f.append(tuple(i + i0 for i in f))
            self.uv.append(uv)
            self.smooth.append(sm)

    def to_object(self, name, material, collection=None, use_colors=False):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        uvl = me.uv_layers.new(name='UVMap')
        flat = [c for face in self.uv for t in face for c in t]
        uvl.data.foreach_set('uv', flat)
        me.polygons.foreach_set('use_smooth', self.smooth)
        if use_colors:
            attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
            attr.data.foreach_set('color', [c for rgb in self.col for c in (*rgb, 1.0)])
        if any(a is not None for a in self.anc):
            # custom glTF attribute _ANCHOR: (x, design ground height, z) of the building each vertex belongs to;
            # the runtime re-snaps every building to the loaded terrain. g = -100 means "not anchored".
            at = me.attributes.new('_ANCHOR', 'FLOAT_VECTOR', 'POINT')
            at.data.foreach_set('vector', [c for a in self.anc for c in (a if a is not None else (0.0, -100.0, 0.0))])
        me.validate(clean_customdata=False)
        me.update()
        if material is not None:
            me.materials.append(material)
        ob = bpy.data.objects.new(name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        return ob


def is_convex(pts):
    n = len(pts)
    sgn = 0
    for i in range(n):
        a, b, c = pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if abs(cr) < 1e-12:
            continue
        s = 1 if cr > 0 else -1
        if sgn == 0:
            sgn = s
        elif s != sgn:
            return False
    return True


def earcut(pts2):
    """Simple O(n^2) ear clipping for a simple polygon (CCW or CW). Returns index triples."""
    n = len(pts2)
    idx = list(range(n))
    area = sum(pts2[i][0] * pts2[(i + 1) % n][1] - pts2[(i + 1) % n][0] * pts2[i][1] for i in range(n))
    ccw = area > 0
    out = []

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        d1, d2, d3 = cross(a, b, p), cross(b, c, p), cross(c, a, p)
        neg = d1 < 0 or d2 < 0 or d3 < 0
        pos = d1 > 0 or d2 > 0 or d3 > 0
        return not (neg and pos)
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        m = len(idx)
        for k in range(m):
            i0, i1, i2 = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            a, b, c = pts2[i0], pts2[i1], pts2[i2]
            cr = cross(a, b, c)
            if (cr > 0) != ccw or abs(cr) < 1e-12:
                continue
            def same(p, q):
                return abs(p[0] - q[0]) < 1e-7 and abs(p[1] - q[1]) < 1e-7
            if any(inside(pts2[j], a, b, c) for j in idx if j not in (i0, i1, i2)
                   and not (same(pts2[j], a) or same(pts2[j], b) or same(pts2[j], c))):
                continue
            out.append((i0, i1, i2) if ccw else (i0, i2, i1))
            idx.pop(k)
            break
        else:
            break
    if len(idx) == 3:
        out.append(tuple(idx) if ccw else (idx[0], idx[2], idx[1]))
    # make all triangles CCW when seen from +Z
    res = []
    for a, b, c in out:
        if cross(pts2[a], pts2[b], pts2[c]) < 0:
            res.append((a, c, b))
        else:
            res.append((a, b, c))
    return res


# ----------------------------------------------------------------------------------------------------------------
# textures

def _img_from_array(name, arr, path, alpha=False, colorspace='sRGB'):
    """arr: HxWx3 or HxWx4 float 0..1, row 0 = top. Saves to path (png/jpg) and returns a Blender image."""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1))], axis=2)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = bpy.data.images.new(name, w, h, alpha=alpha)
    img.pixels.foreach_set(np.ascontiguousarray(np.flipud(np.clip(arr, 0, 1))).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG' if path.endswith('.png') else 'JPEG'
    try:
        img.save(quality=92)
    except TypeError:
        img.save()
    img.colorspace_settings.name = colorspace
    # reload from disk so the exporter embeds the compressed file as-is
    img.source = 'FILE'
    img.filepath = path
    img.reload()
    img.colorspace_settings.name = colorspace
    return img


def rng(seed):
    return np.random.default_rng(seed)


def fbm(h, w, seed=0, octaves=5, base=4, persistence=0.55, tile=True):
    """Tileable fractal value noise in [-1, 1] (approximately)."""
    r = rng(seed)
    out = np.zeros((h, w))
    amp = 1.0
    tot = 0.0
    for o in range(octaves):
        f = base * (2 ** o)
        g = r.standard_normal((f, f))
        # bicubic-ish upsample of the periodic grid
        yy = np.linspace(0, f, h, endpoint=False)
        xx = np.linspace(0, f, w, endpoint=False)
        y0 = np.floor(yy).astype(int)
        x0 = np.floor(xx).astype(int)
        ty = yy - y0
        tx = xx - x0
        ty = ty * ty * (3 - 2 * ty)
        tx = tx * tx * (3 - 2 * tx)
        y1 = (y0 + 1) % f
        x1 = (x0 + 1) % f
        a = g[y0][:, x0]
        b = g[y0][:, x1]
        c = g[y1][:, x0]
        d = g[y1][:, x1]
        TX = tx[None, :]
        TY = ty[:, None]
        n = (a * (1 - TX) + b * TX) * (1 - TY) + (c * (1 - TX) + d * TX) * TY
        out += amp * n
        tot += amp
        amp *= persistence
    return out / tot


def blur(a, k=3):
    """Cheap separable periodic box blur."""
    out = a.copy()
    for ax in (0, 1):
        acc = np.zeros_like(out)
        for s in range(-k, k + 1):
            acc += np.roll(out, s, axis=ax)
        out = acc / (2 * k + 1)
    return out


def srgb(hexstr):
    hexstr = hexstr.lstrip('#')
    return np.array([int(hexstr[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def height_to_normal(hmap, strength=2.0):
    gy, gx = np.gradient(hmap)
    nx = -gx * strength
    ny = gy * strength       # image rows go down; OpenGL-style normal map (+Y up)
    nz = np.ones_like(hmap)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / l * 0.5 + 0.5, ny / l * 0.5 + 0.5, nz / l * 0.5 + 0.5], axis=2)


_TEX_CACHE = {}


def texture(name, fn, ext='jpg', colorspace='sRGB', alpha=False):
    """Create (once) a texture image by calling fn() -> HxWx3/4 array."""
    if name in _TEX_CACHE:
        return _TEX_CACHE[name]
    arr = fn()
    img = _img_from_array(name, arr, os.path.join(TEX, f'{name}.{ext}'), alpha=alpha, colorspace=colorspace)
    _TEX_CACHE[name] = img
    return img


# ----------------------------------------------------------------------------------------------------------------
# materials

def material(name, color=(0.8, 0.8, 0.8), rough=0.6, metal=0.0, albedo=None, rough_img=None, normal=None,
             normal_strength=1.0, emissive=None, emissive_strength=1.0, alpha_img=False, alpha_clip=None,
             blend=False, alpha=1.0, double_sided=False, spec=0.5, emissive_img=None, metal_img=False):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    try:
        bsdf.inputs['Specular IOR Level'].default_value = spec
    except KeyError:
        pass
    if albedo is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = albedo
        t.location = (-600, 300)
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha_img:
            nt.links.new(t.outputs['Alpha'], bsdf.inputs['Alpha'])
    if rough_img is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = rough_img
        t.location = (-600, 0)
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        sep.location = (-300, 0)
        nt.links.new(t.outputs['Color'], sep.inputs['Color'])
        # glTF metallic-roughness: G = roughness, B = metallic
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        if metal > 0 or metal_img:
            nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    if normal is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal
        t.location = (-600, -300)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.location = (-300, -300)
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if emissive is not None:
        bsdf.inputs['Emission Color'].default_value = (*emissive, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emissive_strength
    if emissive_img is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = emissive_img
        t.location = (-600, -600)
        nt.links.new(t.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = emissive_strength
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
    if alpha_img or alpha < 1.0:
        # Blender 4.2+: blend_method replaced by surface_render_method; glTF exporter reads alpha from node setup
        try:
            m.surface_render_method = 'BLENDED' if blend else 'DITHERED'
        except Exception:
            pass
        if alpha_clip is not None and not blend:
            # glTF MASK mode: exporter detects a Math(>=) / "alpha clip" node pattern. Use Round-trip friendly setup:
            t = [n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image is albedo][0]
            mth = nt.nodes.new('ShaderNodeMath')
            mth.operation = 'GREATER_THAN'
            mth.inputs[1].default_value = alpha_clip
            nt.links.new(t.outputs['Alpha'], mth.inputs[0])
            nt.links.new(mth.outputs[0], bsdf.inputs['Alpha'])
    m.use_backface_culling = not double_sided
    return m


# ----------------------------------------------------------------------------------------------------------------
# metadata: collision primitives and lights, in Three local coordinates (x = right, y = up, z = -forward)

def to_three(p):
    return [round(float(p[0]), 3), round(float(p[2]), 3), round(float(-p[1]), 3)]


class Meta:
    def __init__(self, lid, name):
        self.d = {'id': lid, 'name': name, 'collision': [], 'lights': [], 'lods': [], 'tris': {}}
        self.anchor = None      # current ground anchor (x, g, z) for the next primitives

    def box(self, lo, hi, name=None, yaw=0.0):
        """Axis-aligned (in the landmark frame, optionally yawed about Z by `yaw` rad around its center) box."""
        lo, hi = V(lo), V(hi)
        c = (lo + hi) / 2
        h = (hi - lo) / 2
        e = {'t': 'box', 'c': to_three(c), 'h': [round(float(h[0]), 3), round(float(h[2]), 3), round(float(h[1]), 3)]}
        if yaw:
            e['yaw'] = round(float(yaw), 5)   # rotation about the up axis (Blender CCW = Three rotation.y)
        if name:
            e['n'] = name
        if self.anchor is not None:
            e['ga'] = [round(float(v), 2) for v in self.anchor]
        self.d['collision'].append(e)

    def obox(self, c, fwd2, hx, hy, hz, name=None):
        """Box centered at c with its local +Y along the 2D direction fwd2 (x, y) in the frame; hy = half-length."""
        yaw = math.atan2(fwd2[1], fwd2[0]) - math.pi / 2
        self.box(V(c) - V(hx, hy, hz), V(c) + V(hx, hy, hz), name, yaw)

    def capsule(self, a, b, r, name=None):
        e = {'t': 'cap', 'a': to_three(a), 'b': to_three(b), 'r': round(float(r), 3)}
        if name:
            e['n'] = name
        if self.anchor is not None:
            e['ga'] = [round(float(v), 2) for v in self.anchor]
        self.d['collision'].append(e)

    def light(self, p, color='#ff2a1a', size=4.0, period=0.0, duty=0.5, phase=0.0, intensity=1.0, kind='warn', anchor=None):
        e = {'p': to_three(p), 'c': color, 's': size, 'per': period, 'duty': duty, 'ph': phase, 'i': intensity, 'k': kind}
        a = anchor if anchor is not None else self.anchor
        if a is not None:
            e['ga'] = [round(float(v), 2) for v in a]
        self.d['lights'].append(e)

    def lane(self, pts, speed=20.0, gap=(22.0, 70.0)):
        """Traffic lane polyline (Blender frame points, in driving order) for the runtime traffic system."""
        self.d.setdefault('traffic', []).append({'p': [to_three(p) for p in pts], 'v': round(float(speed), 2),
                                                 'gap': [float(gap[0]), float(gap[1])]})

    def save(self, path=None):
        path = path or os.path.join(OUT, f"{self.d['id']}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        json.dump(self.d, open(path, 'w'), separators=(',', ':'))
        return path


# ----------------------------------------------------------------------------------------------------------------
def export(path, objects, draco_bits=18):
    """GLB export of the given objects (Draco, higher position precision for kilometer-sized models)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(path), export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
        export_texcoords=True, export_normals=True, export_materials='EXPORT',
        export_cameras=False, export_lights=False, export_animations=False, export_extras=False,
        export_image_format='WEBP', export_image_quality=88, export_attributes=True,
        export_draco_generic_quantization=14,
        export_vertex_color='ACTIVE' if any(o.data.color_attributes for o in objects if o.type == 'MESH') else 'MATERIAL',
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
        export_draco_position_quantization=draco_bits, export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=14, export_draco_color_quantization=8,
    )
    return path


def tri_count(objects):
    n = 0
    for o in objects:
        me = o.data
        n += sum(len(p.vertices) - 2 for p in me.polygons)
    return n


def clear_objects():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)


def bridge_hole(outer, inner):
    """Merge a hole into a CCW outer ring via a zero-width slit (for ear clipping). Rings: lists of (x, y)."""
    def area(p):
        return sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))
    outer = list(outer) if area(outer) > 0 else list(outer)[::-1]
    inner = list(inner) if area(inner) < 0 else list(inner)[::-1]
    best = None
    for i, a in enumerate(inner):
        for j, b in enumerate(outer):
            d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
            if best is None or d < best[0]:
                best = (d, i, j)
    _, i, j = best
    ring = outer[:j + 1] + inner[i:] + inner[:i + 1] + outer[j:]
    return ring


def polygon_hole(mb, outer, inner, z, ts=4.0, col=None):
    ring = bridge_hole(outer, inner)
    pts3 = [(p[0], p[1], z) for p in ring]
    tri = earcut([(p[0], p[1]) for p in ring])
    i0 = mb.add_verts(pts3, col)
    for a, b, c in tri:
        mb.face((i0 + a, i0 + b, i0 + c), [(pts3[k][0] / ts, pts3[k][1] / ts) for k in (a, b, c)])
