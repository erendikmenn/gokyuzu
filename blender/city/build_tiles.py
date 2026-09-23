"""Build the SF city tile meshes in Blender and export GLBs (LOD0 500 m, LOD1 1 km, LOD2 2 km).

  Blender -b -P blender/city/build_tiles.py -- --tiles 3_-20,4_-20 [--force]      (tools/geo/city_build.py runs it in parallel)
  Blender -b -P blender/city/build_tiles.py -- --far 1_-10,...

Input : data/sf/cache/city/tiles/L1_<i>_<j>.json (tools/geo/city_prep.py), L2_<i>_<j>.json
Output: assets/sf/city/l0/<i>_<j>.glb, l1/<i>_<j>.glb, l2/<i>_<j>.glb (+ .json tile meta next to each GLB)

Geometry per building (LOD0): walls extruded from the LiDAR footprint to the roof height, split in a ground-floor band
(storefront / garage / lobby / stoop cell on street-facing edges) and upper floors; party walls shared with neighbours
are only built above the neighbour's roof; flat roofs get parapets (inner wall + cap), rooftop HVAC units and mechanical
penthouses; small near-rectangular houses get gable or hip roofs with eave overhangs. LOD1 drops parapets, rooftop
details and ground bands and uses simplified footprints; LOD2 are merged blocks.

Vertex attributes (glTF): POSITION (y relative to the building's anchor ground; walls that start at the ground have
y = 0 and are dropped onto the terrain at runtime), NORMAL, TEXCOORD_0 = facade/roof coordinates in texture repeats,
TEXCOORD_1 = building anchor (x, z) relative to the tile centre, TEXCOORD_2 = (atlas layer, per-building seed),
COLOR_0 = tint multiplier (rgb). One mesh / one material ("city") per tile; the runtime supplies the atlas material.
"""
import hashlib
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'common'))
from util import reset_scene, export_glb, REPO  # noqa: E402

TILES = os.path.join(REPO, 'data', 'sf', 'cache', 'city', 'tiles')
OUT = os.path.join(REPO, 'assets', 'sf', 'city')
ATLAS = json.load(open(os.path.join(OUT, 'atlas', 'atlas.json')))
CELL = {l['index']: l for l in ATLAS['layers']}
LAYER = {l['name']: l['index'] for l in ATLAS['layers']}
HVAC = LAYER['hvac']
ROOF_UNIT_TOP = LAYER['roof_membrane']


class Buf:
    """Accumulates flat-shaded faces with per-vertex attributes (positions in three.js local tile coords)."""

    def __init__(self):
        self.P, self.UV, self.A, self.L, self.C, self.F = [], [], [], [], [], []
        self.n = 0
        self.tris = 0

    def face(self, pts, uvs, layer, color, anchor, seed):
        """pts: list of (x, y, z) three.js coords (tile-local), CCW seen from outside; uvs: list of (u, v)."""
        k = len(pts)
        self.P.extend(pts)
        self.UV.extend(uvs)
        self.A.extend([anchor] * k)
        self.L.extend([(layer, seed)] * k)
        self.C.extend([color] * k)
        self.F.append((self.n, k))
        self.n += k
        self.tris += k - 2


# ------------------------------------------------------------------------------------------------------ uv helpers
def wall_v(style, y0, y1, ground_h=0.0):
    """Map a wall band [y0, y1] to v repeats: floors snapped to whole storeys of the style's cell."""
    c = CELL[style]
    H, floors = c['H'], c['floors']
    if c['kind'] == 'ground':
        return 0.0, 1.0
    span = y1 - y0
    if floors <= 0:   # stretch styles are anchored at the top (clerestories / cornices stay at the top)
        return 1.0 - span / H, 1.0
    fh = H / floors
    n = max(1, round(span / fh))
    return 0.0, n / floors


def wall_u(style, L):
    W = CELL[style]['W']
    if L < 0.55 * W:
        return L / W
    return float(max(1, round(L / W)))


# ------------------------------------------------------------------------------------------------------ building
def ring_xyz(ring):
    return [(float(x), float(z)) for x, z in ring]


def inset_ring(ring, t):
    """Miter-inset of a CCW (x, z) ring by t meters (material on the left in x,z; inward = left normal)."""
    n = len(ring)
    out = []
    for i in range(n):
        p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
        e0 = (p1[0] - p0[0], p1[1] - p0[1])
        e1 = (p2[0] - p1[0], p2[1] - p1[1])
        l0, l1 = math.hypot(*e0) or 1e-6, math.hypot(*e1) or 1e-6
        n0 = (-e0[1] / l0, e0[0] / l0)   # left normal = inward for CCW in (x, z)
        n1 = (-e1[1] / l1, e1[0] / l1)
        bx, bz = n0[0] + n1[0], n0[1] + n1[1]
        bl = math.hypot(bx, bz)
        if bl < 1e-6:
            out.append((p1[0] + n0[0] * t, p1[1] + n0[1] * t))
            continue
        bx, bz = bx / bl, bz / bl
        cos = bx * n0[0] + bz * n0[1]
        m = min(t / max(cos, 0.3), 3 * t)
        out.append((p1[0] + bx * m, p1[1] + bz * m))
    return out


def poly_area(ring):
    return abs(sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))) / 2


def tri_polygon(outer, holes):
    """Triangulate an (x, z) polygon with holes; returns list of index triples into outer + holes concatenated."""
    loops = [[Vector((x, z, 0)) for x, z in outer]] + [[Vector((x, z, 0)) for x, z in h] for h in holes]
    try:
        return tessellate_polygon(loops)
    except Exception:
        return []


class Builder:
    def __init__(self, origin_center, lod):
        self.cx, self.cz = origin_center
        self.lod = lod
        self.buf = Buf()

    def L(self, x, z):
        return x - self.cx, z - self.cz

    def building(self, b):
        lod = self.lod
        ax, az = b['a']
        anchor = (ax - self.cx, az - self.cz)
        seed = b['seed']
        tint = tuple(b['c'])
        rtint = tuple(b['rc'])
        base = b.get('base', 0.0) or 0.0
        roof = b['roof']
        flat = roof['t'] == 'flat'
        h = b['h']
        par = b['par'] if (flat and lod == 0) else 0.0
        if par and b['h'] < 12 and poly_area(b['p']) < 180:
            par = 0.0            # small houses: the 0.5 m false-front parapet is invisible from the air
        top = h + par
        use_p1 = lod >= 1 and b.get('p1') and len(b['p1']) != len(b['p'])
        outer = b['p1'] if use_p1 else b['p']
        holes = [] if use_p1 else b.get('holes', [])
        edges = None if use_p1 else b.get('e')
        rings = [outer] + holes
        for ri, ring in enumerate(rings):
            ering = {}
            if edges and ri < len(edges):
                for k, segs in edges[ri]:
                    ering[k] = segs
            n = len(ring)
            for k in range(n):
                a, c = ring[k], ring[(k + 1) % n]
                Lx, Lz = c[0] - a[0], c[1] - a[1]
                Ltot = math.hypot(Lx, Lz)
                if Ltot < 0.05:
                    continue
                segs = ering.get(k, [[-1, 1 if ri == 0 else 0]])
                ns = len(segs)
                # merge consecutive identical segments
                runs = []
                for s, (ph, st) in enumerate(segs):
                    if ph > 0 and ph >= top - 1.0:
                        ph = 1e3                       # neighbour (almost) as tall: no wall at all
                    key = (round(ph) if ph > 0 else -1, st)
                    if runs and runs[-1][0] == key:
                        runs[-1][2] = s + 1
                    else:
                        runs.append([key, s, s + 1])
                for (ph, st), s0, s1 in runs:
                    t0, t1 = s0 / ns, s1 / ns
                    self.wall_segment(b, a, (Lx, Lz), Ltot, t0, t1, ph, st, base, top, anchor, seed, tint, ri)
        # roof
        if flat:
            self.flat_roof(b, outer, holes, h, par, anchor, seed, rtint)
        else:
            self.pitched_roof(b, roof, h, anchor, seed, rtint, tint)
        if lod == 0:
            for u in b.get('units') or []:
                self.box_unit(u, top if par else h, anchor, seed, h)
            if b.get('pent'):
                p = b['pent']
                self.prism([tuple(q) for q in p['rect']], h, h + p['h'], HVAC, LAYER['roof_gravel'], anchor, seed, (0.9, 0.9, 0.9), rtint)

    def wall_segment(self, b, a, e, Ltot, t0, t1, ph, street, base, top, anchor, seed, tint, ri):
        lod = self.lod
        y_bot = base
        party = ph is not None and ph > 0
        if party:
            if ph >= top - 1.0:
                return
            y_bot = max(base, ph - 1.5)
        p0 = (a[0] + e[0] * t0, a[1] + e[1] * t0)
        p1 = (a[0] + e[0] * t1, a[1] + e[1] * t1)
        L = Ltot * (t1 - t0)
        main = b['s']
        if party:
            style = b['side']
        elif street:
            style = main
        else:
            style = b.get('rear', main)
        if not party and CELL[style]['kind'] == 'facade' and L < 0.55 * CELL[style]['W'] and Ltot < 0.55 * CELL[style]['W']:
            style = b['side']
        # u over the whole edge (so segments of one edge stay continuous)
        uW = wall_u(style, Ltot)
        u0, u1 = uW * t0, uW * t1
        bands = []
        g = b.get('g', -1)
        gh = CELL[g]['H'] if g is not None and g >= 0 else 0
        if lod == 0 and street and not party and g is not None and g >= 0 and y_bot <= 0.01 and top - gh > 2.0:
            gu = wall_u(g, Ltot)
            bands.append((0.0, gh, g, gu * t0, gu * t1, 0.0, 1.0))
            yv0, yv1 = wall_v(style, gh, top)
            bands.append((gh, top, style, u0, u1, yv0, yv1))
        else:
            v0, v1 = wall_v(style, y_bot, top)
            bands.append((y_bot, top, style, u0, u1, v0, v1))
        # walk the edge reversed (q0 = end, q1 = start): the quad then faces outward and u runs left -> right
        x0, z0 = self.L(*p1)
        x1, z1 = self.L(*p0)
        for (ya, yb, st, ua, ub, va, vb) in bands:
            if yb - ya < 0.05:
                continue
            self.buf.face([(x0, ya, z0), (x1, ya, z1), (x1, yb, z1), (x0, yb, z0)],
                          [(-ub, va), (-ua, va), (-ua, vb), (-ub, vb)], st, tint, anchor, seed)

    def roof_uv(self, x, z, layer):
        W = CELL[layer]['W']
        return ((x - self.cx) / W, -(z - self.cz) / W)

    def flat_roof(self, b, outer, holes, h, par, anchor, seed, rtint):
        rs = b['rs']
        pts = outer + [p for hh in holes for p in hh]
        tris = tri_polygon(outer, holes)
        for t in tris:
            q = [pts[i] for i in t]
            # ensure upward normal: in three coords (x, z) CCW seen from above (+y) means clockwise in (x, z) math axes
            area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1])
            if area > 0:
                q = [q[0], q[2], q[1]]
            self.buf.face([(self.L(*p)[0], h, self.L(*p)[1]) for p in q], [self.roof_uv(p[0], p[1], rs) for p in q],
                          rs, rtint, anchor, seed)
        if par > 0:
            t = 0.28
            for ring, sign in [(outer, 1)] + [(hh, 1) for hh in holes]:
                inner = inset_ring(ring, t)
                n = len(ring)
                for k in range(n):
                    a, c = ring[k], ring[(k + 1) % n]
                    ia, ic = inner[k], inner[(k + 1) % n]
                    # cap (top of the parapet)
                    self.quad_up([a, c, ic, ia], h + par, b['rs'], rtint, anchor, seed, cap=True)
                    # inner parapet wall (faces inward: from ic to ia)
                    L = math.hypot(ic[0] - ia[0], ic[1] - ia[1])
                    if L < 0.05:
                        continue
                    xa, za = self.L(*ia)
                    xc, zc = self.L(*ic)
                    st = b['side']
                    u = L / CELL[st]['W']
                    self.buf.face([(xa, h, za), (xc, h, zc), (xc, h + par, zc), (xa, h + par, za)],
                                  [(0, 0), (u, 0), (u, par / CELL[st]['H']), (0, par / CELL[st]['H'])], st,
                                  tuple(b['c']), anchor, seed)

    def quad_up(self, q, y, layer, color, anchor, seed, cap=False):
        area = 0.0
        for i in range(len(q)):
            x0, z0 = q[i]
            x1, z1 = q[(i + 1) % len(q)]
            area += x0 * z1 - x1 * z0
        if area > 0:
            q = q[::-1]
        self.buf.face([(self.L(*p)[0], y, self.L(*p)[1]) for p in q], [self.roof_uv(p[0], p[1], layer) for p in q],
                      layer, color, anchor, seed)

    def pitched_roof(self, b, roof, h, anchor, seed, rtint, tint):
        r = [tuple(p) for p in roof['rect']]
        rise = roof['rise']
        rs = b['rs']
        W = CELL[rs]['W']
        # orient: make long axis a->b (r0->r1)
        e0 = (r[1][0] - r[0][0], r[1][1] - r[0][1])
        e1 = (r[2][0] - r[1][0], r[2][1] - r[1][1])
        if math.hypot(*e1) > math.hypot(*e0):
            r = r[1:] + r[:1]
            e0, e1 = e1, (r[2][0] - r[1][0], r[2][1] - r[1][1])
        Llong, Lshort = math.hypot(*e0), math.hypot(*e1)
        ux, uz = e0[0] / Llong, e0[1] / Llong
        vx, vz = e1[0] / Lshort, e1[1] / Lshort
        ov = 0.35 if self.lod == 0 else 0.0
        # expanded rectangle (overhang)
        c0 = (r[0][0] - ux * ov - vx * ov, r[0][1] - uz * ov - vz * ov)
        L2, S2 = Llong + 2 * ov, Lshort + 2 * ov
        def P(s, t):   # s along long axis 0..L2, t along short 0..S2
            return (c0[0] + ux * s + vx * t, c0[1] + uz * s + vz * t)
        drop = ov * (2 * rise / Lshort)   # eave lowers with the overhang to keep the slope
        ye = h - drop
        yr = h + rise
        hip = roof['t'] == 'hip'
        inset = min(S2 / 2, L2 / 2) if hip else 0.0
        a0, a1 = P(0, 0), P(L2, 0)
        b0, b1 = P(0, S2), P(L2, S2)
        m0, m1 = P(inset, S2 / 2), P(L2 - inset, S2 / 2)
        slope_len = math.hypot(S2 / 2, rise + drop)
        faces = [
            ([a0, a1, m1, m0], [(0, 0), (L2 / W, 0), ((L2 - inset) / W, slope_len / W), (inset / W, slope_len / W)]),
            ([b1, b0, m0, m1], [(0, 0), (L2 / W, 0), ((L2 - inset) / W, slope_len / W), (inset / W, slope_len / W)]),
        ]
        ys = {id(a0): ye, id(a1): ye, id(b0): ye, id(b1): ye, id(m0): yr, id(m1): yr}
        for pts, uvs in faces:
            q = [pts[0], pts[1], pts[2], pts[3]]
            if m0 == m1 or (hip and inset * 2 >= L2 - 1e-3):
                q = [pts[0], pts[1], pts[2]]
                uvs = uvs[:3]
            self._roof_face(q, [ys[id(p)] for p in q], uvs, rs, rtint, anchor, seed)
        if hip:
            half = S2 / 2
            hl = math.hypot(inset, rise + drop)
            self._roof_face([b0, a0, m0], [ye, ye, yr], [(0, 0), (S2 / W, 0), (half / W, hl / W)], rs, rtint, anchor, seed)
            self._roof_face([a1, b1, m1], [ye, ye, yr], [(0, 0), (S2 / W, 0), (half / W, hl / W)], rs, rtint, anchor, seed)
        else:
            # gable end walls (triangles above the eave) with the facade style; built on the wall rectangle (no overhang)
            st = b['s'] if b['s'] is not None else b['side']
            gW, gH = CELL[st]['W'], CELL[st]['H']
            w0, w1 = r[0], r[3]
            w2, w3 = r[1], r[2]
            mid0 = ((w0[0] + w1[0]) / 2, (w0[1] + w1[1]) / 2)
            mid1 = ((w2[0] + w3[0]) / 2, (w2[1] + w3[1]) / 2)
            v0 = wall_v(st, 0, h)[1]
            for (p, q, m) in ((w1, w0, mid0), (w2, w3, mid1)):
                pts = [(self.L(*p)[0], h, self.L(*p)[1]), (self.L(*q)[0], h, self.L(*q)[1]), (self.L(*m)[0], h + rise, self.L(*m)[1])]
                # orientation: outward normal (away from the house centre)
                self._oriented(pts, [(0, v0), (Lshort / gW, v0), (Lshort / gW / 2, v0 + rise / gH)], st, tint, anchor, seed,
                               outward=((p[0] + q[0]) / 2 - (r[0][0] + r[2][0]) / 2, (p[1] + q[1]) / 2 - (r[0][1] + r[2][1]) / 2))

    def _roof_face(self, q, ys, uvs, layer, color, anchor, seed):
        pts = [(self.L(*p)[0], y, self.L(*p)[1]) for p, y in zip(q, ys)]
        self._oriented(pts, uvs, layer, color, anchor, seed, up=True)

    def _oriented(self, pts, uvs, layer, color, anchor, seed, up=False, outward=None):
        a, b_, c = (np.array(p) for p in pts[:3])
        n = np.cross(b_ - a, c - a)
        flip = False
        if up and n[1] < 0:
            flip = True
        if outward is not None and n[0] * outward[0] + n[2] * outward[1] < 0:
            flip = True
        if flip:
            pts = pts[::-1]
            uvs = uvs[::-1]
        self.buf.face(pts, uvs, layer, color, anchor, seed)

    def prism(self, rect, y0, y1, side_layer, top_layer, anchor, seed, color, rcolor):
        """Closed box on a (x, z) quad (sides + top)."""
        # CCW in x,z for outward normals
        area = sum(rect[i][0] * rect[(i + 1) % 4][1] - rect[(i + 1) % 4][0] * rect[i][1] for i in range(4))
        if area < 0:
            rect = rect[::-1]
        W, H = CELL[side_layer]['W'], CELL[side_layer]['H']
        for k in range(4):
            a, c = rect[k], rect[(k + 1) % 4]
            L = math.hypot(c[0] - a[0], c[1] - a[1])
            xa, za = self.L(*a)
            xc, zc = self.L(*c)
            u = max(1.0, round(L / W))
            v = (y1 - y0) / H
            self._oriented([(xa, y0, za), (xc, y0, zc), (xc, y1, zc), (xa, y1, za)], [(0, 0), (u, 0), (u, v), (0, v)],
                           side_layer, color, anchor, seed,
                           outward=((a[0] + c[0]) / 2 - sum(p[0] for p in rect) / 4, (a[1] + c[1]) / 2 - sum(p[1] for p in rect) / 4))
        self.quad_up(list(rect), y1, top_layer, rcolor, anchor, seed)

    def box_unit(self, u, y0, anchor, seed, h):
        x, z, w, d, hh, ang = u
        ca, sa = math.cos(ang), math.sin(ang)
        pts = []
        for (px, pz) in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
            pts.append((x + px * ca - pz * sa, z + px * sa + pz * ca))
        self.prism(pts, h, h + hh, HVAC, ROOF_UNIT_TOP, anchor, seed, (0.95, 0.95, 0.95), (0.85, 0.85, 0.85))

    def block(self, blk):
        """LOD2 merged block: walls + flat roof, per-vertex terrain placement (anchor unused)."""
        ring = blk['p']
        h = blk['h']
        base = blk.get('base', 0.0) or 0.0
        st, rs = blk['s'], blk['rs']
        tint, rtint = tuple(blk['c']), tuple(blk['rc'])
        anchor = (0.0, 0.0)
        n = len(ring)
        for k in range(n):
            a, c = ring[k], ring[(k + 1) % n]
            L = math.hypot(c[0] - a[0], c[1] - a[1])
            if L < 0.05:
                continue
            u = wall_u(st, L)
            v0, v1 = wall_v(st, base, h)
            xa, za = self.L(*a)
            xc, zc = self.L(*c)
            self.buf.face([(xa, base, za), (xc, base, zc), (xc, h, zc), (xa, h, za)], [(0, v0), (u, v0), (u, v1), (0, v1)],
                          st, tint, anchor, 0.5)
        fake = {'rs': rs}
        self.flat_roof(fake, ring, [], h, 0.0, anchor, 0.5, rtint)


# --------------------------------------------------------------------------------------------------------- export
def make_object(name, buf, center):
    P = np.asarray(buf.P, np.float32)
    if len(P) == 0:
        return None
    nv = len(P)
    # three.js (x, y, z) -> Blender (x, -z, y)
    co = np.stack([P[:, 0], -P[:, 2], P[:, 1]], 1)
    me = bpy.data.meshes.new(name)
    me.vertices.add(nv)
    me.vertices.foreach_set('co', co.ravel())
    starts = np.array([s for s, k in buf.F], np.int32)
    totals = np.array([k for s, k in buf.F], np.int32)
    me.loops.add(nv)
    me.loops.foreach_set('vertex_index', np.arange(nv, dtype=np.int32))
    me.polygons.add(len(buf.F))
    me.polygons.foreach_set('loop_start', starts)
    me.polygons.foreach_set('loop_total', totals)
    uv = np.asarray(buf.UV, np.float32)
    an = np.asarray(buf.A, np.float32)
    ly = np.asarray(buf.L, np.float32)
    l0 = me.uv_layers.new(name='UVMap')
    l0.data.foreach_set('uv', np.stack([uv[:, 0], 1.0 - uv[:, 1]], 1).ravel())
    l1 = me.uv_layers.new(name='Anchor')
    l1.data.foreach_set('uv', np.stack([an[:, 0], 1.0 - an[:, 1]], 1).ravel())
    l2 = me.uv_layers.new(name='Layer')
    l2.data.foreach_set('uv', np.stack([ly[:, 0], 1.0 - ly[:, 1]], 1).ravel())
    col = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
    C = np.asarray(buf.C, np.float32)
    C = np.concatenate([C, np.ones((nv, 1), np.float32)], 1)
    col.data.foreach_set('color', C.ravel())
    me.polygons.foreach_set('use_smooth', np.zeros(len(buf.F), bool))
    me.update(calc_edges=True)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (center[0], -center[1], 0.0)
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    me.materials.append(city_material())
    return ob


def city_material():
    """Placeholder material (the runtime replaces it); it reads the 'Color' attribute so the glTF exporter writes it
    as COLOR_0."""
    mat = bpy.data.materials.get('city')
    if mat:
        return mat
    mat = bpy.data.materials.new('city')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Color'
    nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def export_tile(buf, center, path, meta):
    reset_scene()
    ob = make_object(os.path.splitext(os.path.basename(path))[0].replace('-', 'm'), buf, center)
    if ob is None:
        return None
    export_glb(path, objects=[ob])
    P = np.asarray(buf.P, np.float32)
    meta.update({
        'center': [round(center[0], 2), round(center[1], 2)],
        'minX': round(float(P[:, 0].min() + center[0]), 1), 'maxX': round(float(P[:, 0].max() + center[0]), 1),
        'minZ': round(float(P[:, 2].min() + center[1]), 1), 'maxZ': round(float(P[:, 2].max() + center[1]), 1),
        'maxY': round(float(P[:, 1].max()), 1), 'tris': buf.tris, 'bytes': os.path.getsize(path),
    })
    json.dump(meta, open(path[:-4] + '.json', 'w'))
    return meta


def src_hash(path):
    return hashlib.md5(open(path, 'rb').read()).hexdigest()[:12]


def build_l1(i, j, force=False):
    path = os.path.join(TILES, f'L1_{i}_{j}.json')
    hsh = src_hash(path)
    out1 = os.path.join(OUT, 'l1', f'{i}_{j}.glb')
    if not force and os.path.exists(out1[:-4] + '.json'):
        try:
            if json.load(open(out1[:-4] + '.json')).get('src') == hsh:
                print(f'[city] skip {i}_{j} (unchanged)', flush=True)
                return
        except Exception:
            pass
    js = json.load(open(path))
    T = js['size']
    x0, z0 = js['origin']
    blds = js['buildings']
    # LOD0: four 500 m sub-tiles
    for sub in range(4):
        si, sj = 2 * i + (sub & 1), 2 * j + (sub >> 1)
        center = (x0 + (sub & 1) * T / 2 + T / 4, z0 + (sub >> 1) * T / 2 + T / 4)
        bld = Builder(center, 0)
        for b in blds:
            if b['sub'] == sub:
                try:
                    bld.building(b)
                except Exception as e:  # noqa
                    print(f'[city] building {b["id"]} failed: {e}', flush=True)
        p = os.path.join(OUT, 'l0', f'{si}_{sj}.glb')
        if bld.buf.n:
            export_tile(bld.buf, center, p, {'level': 0, 'i': si, 'j': sj, 'size': T / 2, 'placement': 'anchor', 'src': hsh,
                                             'buildings': sum(1 for b in blds if b['sub'] == sub)})
        else:
            for ext in ('.glb', '.json'):
                if os.path.exists(p[:-4] + ext):
                    os.remove(p[:-4] + ext)
    # LOD1
    center = (x0 + T / 2, z0 + T / 2)
    bld = Builder(center, 1)
    for b in blds:
        try:
            bld.building(b)
        except Exception as e:  # noqa
            print(f'[city] building {b["id"]} (L1) failed: {e}', flush=True)
    export_tile(bld.buf, center, out1, {'level': 1, 'i': i, 'j': j, 'size': T, 'placement': 'anchor', 'src': hsh, 'buildings': len(blds)})
    print(f'[city] tile {i}_{j}: {len(blds)} buildings', flush=True)


def build_l2(i, j, force=False, level=2):
    path = os.path.join(TILES, f'L{level}_{i}_{j}.json')
    if not os.path.exists(path):
        return
    hsh = src_hash(path)
    out = os.path.join(OUT, f'l{level}', f'{i}_{j}.glb')
    if not force and os.path.exists(out[:-4] + '.json'):
        try:
            if json.load(open(out[:-4] + '.json')).get('src') == hsh:
                return
        except Exception:
            pass
    js = json.load(open(path))
    T = js['size']
    x0, z0 = js['origin']
    center = (x0 + T / 2, z0 + T / 2)
    bld = Builder(center, 2)
    for blk in js['blocks']:
        try:
            bld.block(blk)
        except Exception as e:  # noqa
            print(f'[city] block failed: {e}', flush=True)
    if bld.buf.n:
        export_tile(bld.buf, center, out, {'level': level, 'i': i, 'j': j, 'size': T, 'placement': 'vertex', 'src': hsh,
                                          'buildings': len(js['blocks'])})
    else:
        for ext in ('.glb', '.json'):
            if os.path.exists(out[:-4] + ext):
                os.remove(out[:-4] + ext)
    print(f'[city] far tile {i}_{j}: {len(js["blocks"])} blocks', flush=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    force = '--force' in argv
    for d in ('l0', 'l1', 'l2', 'l3'):
        os.makedirs(os.path.join(OUT, d), exist_ok=True)
    if '--tiles' in argv:
        for t in argv[argv.index('--tiles') + 1].split(','):
            i, j = (int(v) for v in t.split('_'))
            build_l1(i, j, force)
    if '--far' in argv:
        for t in argv[argv.index('--far') + 1].split(','):
            i, j = (int(v) for v in t.split('_'))
            build_l2(i, j, force, 2)
            build_l2(i, j, force, 3)


if __name__ == '__main__':
    main()
