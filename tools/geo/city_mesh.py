"""City tile meshes in Python (no Blender): LOD0 500 m, LOD1 1 km, LOD2 / LOD3 2 km -> meshopt GLBs (city_glb.py).

  GEO_REGION=ist .venv/bin/python tools/geo/city_build.py        (runs this in parallel over all prepared tiles)
  GEO_REGION=ist .venv/bin/python tools/geo/city_mesh.py --tiles 3_-20,4_-20 [--far 1_-10,...] [--force]

Same vertex layout and conventions as San Francisco's Blender builder (blender/city/build_tiles.py), so the city
runtime (src/world-sf/city.js + city_material.js) draws both maps unchanged: POSITION (y relative to the building's
anchor ground; walls starting at the ground have y = 0 and are dropped onto the terrain at runtime), NORMAL,
TEXCOORD_0 = facade / roof coordinates in texture repeats, TEXCOORD_1 = building anchor (x, z) relative to the tile
centre, TEXCOORD_2 = (atlas layer, per-building seed), COLOR_0 = tint multiplier. One mesh per tile.

İstanbul budgets (the city is ~2x San Francisco's building count and dense to the horizon, so every level is leaner):
  LOD0  one mesh per 1 km (the four 500 m sub-tiles merged); walls from the 0.4 m-simplified footprint; walls shared with a neighbour of (almost) the same height are not
        built (party walls, İstanbul's attached rows); a shop-front band only on main-road facades of 3+ storey
        buildings; hipped / gabled tile roofs with a small overhang, flat roofs without parapets or rooftop units;
        mosques: drum + dome (12 x 4) + minarets (8-sided shaft, şerefe balcony, conical cap).
  LOD1  merged blocks: footprints of one height class (about two storeys) fused (attached rows and neighbours
        closer than 5 m become one block, 2 m-simplified, near-rectangular footprints as rectangles, height =
        area-weighted mean; single storeys (< 7 m) and < 50 m2 annexes dropped), towers >= 40 m and mosques on their
        own (dome 8 x 2, 4-sided minarets); per-vertex terrain placement ('vertex' in index.json, no anchor attribute).
  LOD2  merged blocks (height bins) + towers + big mosque domes; LOD3 only the skyline (towers, blocks >= 24 m).
"""
import hashlib, json, math, os, sys, time

import numpy as np
import mapbox_earcut as earcut

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from city_paths import CACHE, OUT  # noqa: E402
from city_glb import write_glb  # noqa: E402

TILES = os.path.join(CACHE, 'tiles')
ATLAS = json.load(open(os.path.join(OUT, 'atlas', 'atlas.json')))
CELL = {l['index']: l for l in ATLAS['layers']}
LAYER = {l['name']: l['index'] for l in ATLAS['layers']}
LEAD = (0.52, 0.54, 0.56)
MINARET = LAYER['blank_stucco']
METAL = LAYER['roof_metal']


class Buf:
    """Indexed triangle buffer with per-vertex attributes (three.js tile-local coordinates)."""

    def __init__(self):
        self.P, self.N, self.UV, self.A, self.L, self.C, self.I = [], [], [], [], [], [], []
        self.n = 0
        self.tris = 0

    def poly(self, pts, uvs, idx, layer, color, anchor, seed, normal):
        k = len(pts)
        self.P.extend(pts)
        self.UV.extend(uvs)
        self.N.extend([normal] * k)
        self.A.extend([anchor] * k)
        self.L.extend([(layer, seed)] * k)
        self.C.extend([color] * k)
        b = self.n
        self.I.extend(b + i for i in idx)
        self.n += k
        self.tris += len(idx) // 3

    def quad(self, pts, uvs, layer, color, anchor, seed):
        """Planar quad (CCW seen from outside)."""
        n = face_normal(pts[0], pts[1], pts[2])
        self.poly(pts, uvs, (0, 1, 2, 0, 2, 3), layer, color, anchor, seed, n)

    def tri(self, pts, uvs, layer, color, anchor, seed):
        self.poly(pts, uvs, (0, 1, 2), layer, color, anchor, seed, face_normal(*pts))

    def arrays(self):
        P = np.asarray(self.P, np.float32).reshape(-1, 3)
        N = np.asarray(self.N, np.float32).reshape(-1, 3)
        UV = np.asarray(self.UV, np.float32).reshape(-1, 2)
        A = np.asarray(self.A, np.float32).reshape(-1, 2)
        L = np.asarray(self.L, np.float64).reshape(-1, 2)
        Lq = np.stack([L[:, 0], np.round(L[:, 1] * 255)], 1).astype(np.uint16)
        C = np.asarray(self.C, np.float64).reshape(-1, 3)
        Cq = np.concatenate([np.clip(np.round(C * 255), 0, 255), np.full((len(C), 1), 255)], 1).astype(np.uint8)
        return P, N, UV, A, Lq, Cq, np.asarray(self.I, np.uint32)


def face_normal(a, b, c):
    u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    L = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
    return (n[0] / L, n[1] / L, n[2] / L)


# ------------------------------------------------------------------------------------------------------ uv helpers
def wall_v(style, y0, y1):
    c = CELL[style]
    H, floors = c['H'], c['floors']
    if c['kind'] == 'ground':
        return 0.0, 1.0
    span = y1 - y0
    if floors <= 0:
        return 1.0 - span / H, 1.0
    fh = H / floors
    n = max(1, round(span / fh))
    return 0.0, n / floors


def wall_u(style, L):
    W = CELL[style]['W']
    if L < 0.55 * W:
        return L / W
    return float(max(1, round(L / W)))


def poly_area(ring):
    n = len(ring)
    return abs(sum(ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1] for i in range(n))) / 2


def earcut_rings(outer, holes):
    rings = [outer] + [h for h in holes if len(h) >= 3]
    verts = np.asarray([p for r in rings for p in r], np.float64)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    try:
        idx = earcut.triangulate_float64(verts, ends)
    except Exception:
        return verts, np.zeros(0, np.int64)
    return verts, np.asarray(idx, np.int64)


class Builder:
    def __init__(self, center, lod):
        self.cx, self.cz = center
        self.lod = lod
        self.buf = Buf()

    def L(self, x, z):
        return x - self.cx, z - self.cz

    # ------------------------------------------------------------------ building (LOD0 / LOD1)
    def building(self, b):
        lod = self.lod
        ax, az = b['a']
        anchor = (ax - self.cx, az - self.cz)
        seed = b['seed']
        tint, rtint = tuple(b['c']), tuple(b['rc'])
        base = b.get('base', 0.0) or 0.0
        roof = b['roof']
        flat = roof['t'] == 'flat'
        top = b['h']
        use_p1 = lod >= 1 and b.get('p1') and len(b['p1']) != len(b['p'])
        outer = b['p1'] if use_p1 else b['p']
        holes = [] if (use_p1 or lod >= 1) else b.get('holes', [])
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
                runs = []
                for s, (ph, st) in enumerate(segs):
                    if ph > 0 and ph >= top - 1.0:
                        ph = 1e3
                    key = (round(ph) if ph > 0 else -1, st if lod == 0 else 0)
                    if runs and runs[-1][0] == key:
                        runs[-1][2] = s + 1
                    else:
                        runs.append([key, s, s + 1])
                for (ph, st), s0, s1 in runs:
                    self.wall_segment(b, a, (Lx, Lz), Ltot, s0 / ns, s1 / ns, ph, st, base, top, anchor, seed, tint)
        if flat:
            self.flat_roof(outer, holes, top, b['rs'], rtint, anchor, seed)
        else:
            self.pitched_roof(b, roof, top, anchor, seed, rtint, tint)
        if b.get('mq'):
            self.mosque(b['mq'], anchor, seed, tint)

    def wall_segment(self, b, a, e, Ltot, t0, t1, ph, street, base, top, anchor, seed, tint):
        y_bot = base
        party = ph is not None and ph > 0
        if party:
            if ph >= top - 1.0:
                return
            y_bot = max(base, ph - 1.5)
        p0 = (a[0] + e[0] * t0, a[1] + e[1] * t0)
        p1 = (a[0] + e[0] * t1, a[1] + e[1] * t1)
        main = b['s']
        style = b['side'] if party else (main if street else b.get('rear', main))
        if not party and CELL[style]['kind'] == 'facade' and Ltot < 0.55 * CELL[style]['W']:
            style = b['side']
        uW = wall_u(style, Ltot)
        u0, u1 = uW * t0, uW * t1
        bands = []
        g = b.get('g', -1)
        gh = CELL[g]['H'] if g is not None and g >= 0 else 0
        # shop-front band: main-road facades (street == 2) of 3+ storey buildings, or the building's own ground style
        band = (self.lod == 0 and not party and g is not None and g >= 0 and y_bot <= 0.01 and top - gh > 2.0
                and (street == 2 or (street == 1 and b.get('lv', 1) <= 2)))
        if band:
            gu = wall_u(g, Ltot)
            bands.append((0.0, gh, g, gu * t0, gu * t1, 0.0, 1.0))
            v0, v1 = wall_v(style, gh, top)
            bands.append((gh, top, style, u0, u1, v0, v1))
        else:
            v0, v1 = wall_v(style, y_bot, top)
            bands.append((y_bot, top, style, u0, u1, v0, v1))
        x0, z0 = self.L(*p1)
        x1, z1 = self.L(*p0)
        for (ya, yb, st, ua, ub, va, vb) in bands:
            if yb - ya < 0.05:
                continue
            self.buf.quad([(x0, ya, z0), (x1, ya, z1), (x1, yb, z1), (x0, yb, z0)],
                          [(-ub, va), (-ua, va), (-ua, vb), (-ub, vb)], st, tint, anchor, seed)

    def roof_uv(self, x, z, layer):
        W = CELL[layer]['W']
        return ((x - self.cx) / W, -(z - self.cz) / W)

    def flat_roof(self, outer, holes, h, rs, rtint, anchor, seed):
        verts, idx = earcut_rings(outer, holes)
        if len(idx) < 3:
            return
        tri = idx.reshape(-1, 3)
        # upward normals: in (x, z) with z south, a triangle is +y facing when its (x, z) signed area is negative
        a, b_, c = verts[tri[:, 0]], verts[tri[:, 1]], verts[tri[:, 2]]
        area = (b_[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b_[:, 1] - a[:, 1])
        flip = area > 0
        tri[flip] = tri[flip][:, [0, 2, 1]]
        pts = [(x - self.cx, h, z - self.cz) for x, z in verts]
        uvs = [self.roof_uv(x, z, rs) for x, z in verts]
        self.buf.poly(pts, uvs, tri.ravel().tolist(), rs, rtint, anchor, seed, (0.0, 1.0, 0.0))

    def pitched_roof(self, b, roof, h, anchor, seed, rtint, tint):
        r = [tuple(p) for p in roof['rect']]
        rise = roof['rise']
        rs = b['rs']
        W = CELL[rs]['W']
        e0 = (r[1][0] - r[0][0], r[1][1] - r[0][1])
        e1 = (r[2][0] - r[1][0], r[2][1] - r[1][1])
        if math.hypot(*e1) > math.hypot(*e0):
            r = r[1:] + r[:1]
            e0, e1 = e1, (r[2][0] - r[1][0], r[2][1] - r[1][1])
        Llong, Lshort = math.hypot(*e0), math.hypot(*e1)
        ux, uz = e0[0] / Llong, e0[1] / Llong
        vx, vz = e1[0] / Lshort, e1[1] / Lshort
        ov = 0.35 if self.lod == 0 else 0.0
        c0 = (r[0][0] - ux * ov - vx * ov, r[0][1] - uz * ov - vz * ov)
        L2, S2 = Llong + 2 * ov, Lshort + 2 * ov

        def P(s, t):
            return (c0[0] + ux * s + vx * t, c0[1] + uz * s + vz * t)
        drop = ov * (2 * rise / Lshort)
        ye, yr = h - drop, h + rise
        hip = roof['t'] == 'hip'
        inset = min(S2 / 2, L2 / 2) if hip else 0.0
        a0, a1, b0, b1 = P(0, 0), P(L2, 0), P(0, S2), P(L2, S2)
        m0, m1 = P(inset, S2 / 2), P(L2 - inset, S2 / 2)
        slope = math.hypot(S2 / 2, rise + drop)
        tri_only = hip and inset * 2 >= L2 - 1e-3
        for pts in ([a0, a1, m1, m0], [b1, b0, m0, m1]):
            ys = [ye, ye, yr, yr]
            uvs = [(0, 0), (L2 / W, 0), ((L2 - inset) / W, slope / W), (inset / W, slope / W)]
            q = [(self.L(*p)[0], y, self.L(*p)[1]) for p, y in zip(pts, ys)]
            if tri_only:
                self._oriented(q[:3], uvs[:3], rs, rtint, anchor, seed, up=True)
            else:
                self._oriented(q, uvs, rs, rtint, anchor, seed, up=True)
        if hip:
            hl = math.hypot(inset, rise + drop)
            for pts in ([b0, a0, m0], [a1, b1, m1]):
                q = [(self.L(*pts[0])[0], ye, self.L(*pts[0])[1]), (self.L(*pts[1])[0], ye, self.L(*pts[1])[1]),
                     (self.L(*pts[2])[0], yr, self.L(*pts[2])[1])]
                self._oriented(q, [(0, 0), (S2 / W, 0), (S2 / 2 / W, hl / W)], rs, rtint, anchor, seed, up=True)
        else:
            st = b['s']
            gW, gH = CELL[st]['W'], CELL[st]['H']
            w0, w1, w2, w3 = r[0], r[3], r[1], r[2]
            mid0 = ((w0[0] + w1[0]) / 2, (w0[1] + w1[1]) / 2)
            mid1 = ((w2[0] + w3[0]) / 2, (w2[1] + w3[1]) / 2)
            v0 = wall_v(st, 0, h)[1]
            cxr, czr = (r[0][0] + r[2][0]) / 2, (r[0][1] + r[2][1]) / 2
            for (p, q_, m) in ((w1, w0, mid0), (w2, w3, mid1)):
                pts = [(self.L(*p)[0], h, self.L(*p)[1]), (self.L(*q_)[0], h, self.L(*q_)[1]), (self.L(*m)[0], h + rise, self.L(*m)[1])]
                self._oriented(pts, [(0, v0), (Lshort / gW, v0), (Lshort / gW / 2, v0 + rise / gH)], st, tint, anchor, seed,
                               outward=((p[0] + q_[0]) / 2 - cxr, (p[1] + q_[1]) / 2 - czr))

    def _oriented(self, pts, uvs, layer, color, anchor, seed, up=False, outward=None):
        n = face_normal(pts[0], pts[1], pts[2])
        flip = (up and n[1] < 0) or (outward is not None and n[0] * outward[0] + n[2] * outward[1] < 0)
        if flip:
            pts, uvs = pts[::-1], uvs[::-1]
        if len(pts) == 3:
            self.buf.tri(pts, uvs, layer, color, anchor, seed)
        else:
            self.buf.quad(pts, uvs, layer, color, anchor, seed)

    # ------------------------------------------------------------------ mosques
    def ring_prism(self, cx, cz, r, y0, y1, sides, layer, color, anchor, seed, phase=0.0, r_top=None):
        """Open prism / frustum (sides only), CCW from outside."""
        rt = r if r_top is None else r_top
        W = CELL[layer]['W']
        circ = 2 * math.pi * r
        for k in range(sides):
            a0 = phase + 2 * math.pi * k / sides
            a1 = phase + 2 * math.pi * (k + 1) / sides
            pa = (cx + r * math.cos(a0), cz + r * math.sin(a0))
            pb = (cx + r * math.cos(a1), cz + r * math.sin(a1))
            qa = (cx + rt * math.cos(a0), cz + rt * math.sin(a0))
            qb = (cx + rt * math.cos(a1), cz + rt * math.sin(a1))
            u0, u1 = circ * k / sides / W, circ * (k + 1) / sides / W
            v1 = (y1 - y0) / CELL[layer]['H']
            pts = [(*self._xz(pb, y0),), (*self._xz(pa, y0),), (*self._xz(qa, y1),), (*self._xz(qb, y1),)]
            self._oriented(pts, [(u1, 0), (u0, 0), (u0, v1), (u1, v1)], layer, color, anchor, seed,
                           outward=(math.cos((a0 + a1) / 2), math.sin((a0 + a1) / 2)))

    def _xz(self, p, y):
        x, z = self.L(*p)
        return (x, y, z)

    def disc(self, cx, cz, r, y, sides, layer, color, anchor, seed, down=False, phase=0.0):
        pts = [self._xz((cx + r * math.cos(phase + 2 * math.pi * k / sides), cz + r * math.sin(phase + 2 * math.pi * k / sides)), y)
               for k in range(sides)]
        uvs = [self.roof_uv(p[0] + self.cx, p[2] + self.cz, layer) for p in pts]
        idx = []
        for k in range(1, sides - 1):
            idx += [0, k, k + 1]
        n = face_normal(pts[0], pts[1], pts[2])
        if (n[1] < 0) != down:
            idx = [idx[i + j] for i in range(0, len(idx), 3) for j in (0, 2, 1)]
        self.buf.poly(pts, uvs, idx, layer, color, anchor, seed, (0.0, -1.0 if down else 1.0, 0.0))

    def dome(self, cx, cz, r, y0, rise, seg, rings, color, anchor, seed):
        """Spherical cap (lead grey) as quads between latitude rings + a fan at the top."""
        W = CELL[METAL]['W']
        lat = [math.pi / 2 * k / rings for k in range(rings)]
        for k in range(len(lat)):
            f0 = lat[k]
            f1 = lat[k + 1] if k + 1 < len(lat) else math.pi / 2
            r0, r1 = r * math.cos(f0), r * math.cos(f1)
            y_a, y_b = y0 + rise * math.sin(f0), y0 + rise * math.sin(f1)
            if k + 1 < len(lat):
                self.ring_prism(cx, cz, r0, y_a, y_b, seg, METAL, color, anchor, seed, r_top=r1)
            else:
                for s in range(seg):
                    a0 = 2 * math.pi * s / seg
                    a1 = 2 * math.pi * (s + 1) / seg
                    pa = self._xz((cx + r0 * math.cos(a0), cz + r0 * math.sin(a0)), y_a)
                    pb = self._xz((cx + r0 * math.cos(a1), cz + r0 * math.sin(a1)), y_a)
                    tp = self._xz((cx, cz), y_b)
                    self._oriented([pb, pa, tp], [(s / seg * 2 * math.pi * r0 / W, 0), ((s + 1) / seg * 2 * math.pi * r0 / W, 0),
                                                  ((s + 0.5) / seg * 2 * math.pi * r0 / W, rise / W)], METAL, color, anchor, seed,
                                   outward=(math.cos((a0 + a1) / 2), math.sin((a0 + a1) / 2)))

    def mosque(self, mq, anchor, seed, tint):
        cx, cz, r, y0, drum, rise = mq['d']
        lod = self.lod
        seg = 12 if lod == 0 else 8
        wall = LAYER['blank_stucco']
        self.ring_prism(cx, cz, r, y0 - 0.3, y0 + drum, seg, wall, tint, anchor, seed)
        self.dome(cx, cz, r * 1.02, y0 + drum, rise, seg, 4 if lod == 0 else 2, LEAD, anchor, seed)
        for (x, z, mr, h) in mq['m']:
            self.minaret(x, z, mr, h, anchor, seed)

    def minaret(self, x, z, mr, h, anchor, seed):
        white = (0.97, 0.96, 0.93)
        if self.lod == 0:
            s = 8
            y_bal = h * 0.74
            self.ring_prism(x, z, mr, 0.0, y_bal, s, MINARET, white, anchor, seed, phase=math.pi / s)
            self.disc(x, z, mr * 1.55, y_bal, s, MINARET, white, anchor, seed, down=True, phase=math.pi / s)
            self.ring_prism(x, z, mr * 1.55, y_bal, y_bal + 1.0, s, MINARET, white, anchor, seed, phase=math.pi / s)
            self.disc(x, z, mr * 1.55, y_bal + 1.0, s, MINARET, white, anchor, seed, phase=math.pi / s)
            y_cap = h * 0.86
            self.ring_prism(x, z, mr * 0.85, y_bal + 1.0, y_cap, s, MINARET, white, anchor, seed, phase=math.pi / s)
            self.ring_prism(x, z, mr * 0.95, y_cap, h, s, METAL, LEAD, anchor, seed, phase=math.pi / s, r_top=0.05)
        else:
            self.ring_prism(x, z, mr, 0.0, h * 0.86, 4, MINARET, white, anchor, seed, phase=math.pi / 4)
            self.ring_prism(x, z, mr, h * 0.86, h, 4, METAL, LEAD, anchor, seed, phase=math.pi / 4, r_top=0.05)

    # ------------------------------------------------------------------ far blocks (LOD2 / LOD3)
    def block(self, blk):
        for hole in blk.get('holes', []):
            self.block_ring(blk, hole)
        self.block_ring(blk, blk['p'], roof_holes=blk.get('holes', []))

    def block_ring(self, blk, ring, roof_holes=None):
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
            self.buf.quad([(xc, base, zc), (xa, base, za), (xa, h, za), (xc, h, zc)], [(-u, v0), (0, v0), (0, v1), (-u, v1)],
                          st, tint, anchor, blk.get('seed', 0.5))
        if roof_holes is not None:
            self.flat_roof(ring, roof_holes, h, rs, rtint, anchor, blk.get('seed', 0.5))

    def far_mosque(self, m, lod):
        cx, cz, r, y0, drum, rise = m['d']
        anchor = (0.0, 0.0)
        seg = 8 if lod == 2 else 6
        self.ring_prism(cx, cz, r, 0.0, y0 + drum, seg, LAYER['blank_stucco'], (0.97, 0.95, 0.9), anchor, 0.5)
        self.dome(cx, cz, r, y0 + drum, rise, seg, 1, LEAD, anchor, 0.5)
        if lod == 2:
            for (x, z, mr, h) in m['m']:
                self.ring_prism(x, z, mr, 0.0, h * 0.86, 4, MINARET, (0.97, 0.96, 0.93), anchor, 0.5, phase=math.pi / 4)
                self.ring_prism(x, z, mr, h * 0.86, h, 4, METAL, LEAD, anchor, 0.5, phase=math.pi / 4, r_top=0.05)


# --------------------------------------------------------------------------------------------------------- export
L1_BINS = [0, 9.5, 16, 24, 40]         # about two storeys per class
L1_BUF, L1_SIMP = 2.5, 2.0             # fuse footprints closer than 5 m, 2 m simplification


def l1_blocks(blds):
    """LOD1 blocks from the LOD0 records: towers alone, the rest fused per height class."""
    import shapely
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    from shapely import STRtree
    out, rest = [], []
    for b in blds:
        top = b['h'] + (0.5 * b['roof'].get('rise', 0) if b['roof']['t'] != 'flat' else 0)
        try:
            poly = Polygon(b['p1'] or b['p'])
        except Exception:
            continue
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            continue
        if not b.get('mq') and (top < 7.0 or (poly.area < 50 and top < 12)):
            continue          # single storeys, sheds, kiosks: a few pixels beyond 1.3 km
        if isinstance(poly, Polygon):
            r = poly.minimum_rotated_rectangle      # near-rectangular footprints: 4 corners
            if isinstance(r, Polygon) and r.area > 0 and poly.area / r.area >= 0.75:
                poly = r
        rec = {'poly': poly, 'top': top, 'b': b, 'area': poly.area}
        if top >= L1_BINS[-1] or b.get('base', 0) > 0.5:
            p = shapely.geometry.polygon.orient(poly if isinstance(poly, Polygon) else max(poly.geoms, key=lambda g: g.area), 1.0)
            out.append({'p': [list(c) for c in list(p.exterior.coords)[:-1]], 'h': round(top, 2), 'base': b.get('base', 0.0),
                        's': b['s'], 'rs': b['rs'], 'c': b['c'], 'rc': b['rc'], 'seed': b['seed']})
        else:
            rest.append(rec)
    for lo, hi in zip(L1_BINS[:-1], L1_BINS[1:]):
        sel = [r for r in rest if lo <= r['top'] < hi]
        if not sel:
            continue
        u = unary_union([r['poly'].buffer(L1_BUF, join_style=2) for r in sel]).buffer(-L1_BUF, join_style=2)
        geoms = [u] if isinstance(u, Polygon) else list(getattr(u, 'geoms', []))
        tree = STRtree([r['poly'] for r in sel])
        for g in geoms:
            if not isinstance(g, Polygon) or g.area < 12:
                continue
            g = g.simplify(L1_SIMP, preserve_topology=True)
            if g.is_empty or not isinstance(g, Polygon):
                continue
            g = shapely.geometry.polygon.orient(Polygon(g.exterior, [r for r in g.interiors if Polygon(r).area > 40]), 1.0)
            members = [sel[k] for k in tree.query(g, predicate='intersects')]
            if not members:
                continue
            w = np.array([m['area'] for m in members])
            h = float((np.array([m['top'] for m in members]) * w).sum() / w.sum())
            dom = max(members, key=lambda m: m['area'])['b']
            col = (np.array([m['b']['c'] for m in members]) * w[:, None]).sum(0) / w.sum()
            rcol = (np.array([m['b']['rc'] for m in members]) * w[:, None]).sum(0) / w.sum()
            out.append({'p': [list(c) for c in list(g.exterior.coords)[:-1]],
                        'holes': [[list(c) for c in list(r.coords)[:-1]] for r in g.interiors],
                        'h': round(h, 2), 'base': 0.0, 's': dom['s'], 'rs': dom['rs'], 'seed': dom['seed'],
                        'c': [float(x) for x in col], 'rc': [float(x) for x in rcol]})
    return out


def export_tile(buf, center, path, meta, anchors=True):
    if not buf.n:
        for ext in ('.glb', '.json'):
            if os.path.exists(path[:-4] + ext):
                os.remove(path[:-4] + ext)
        return None
    P, N, UV, A, L, C, I = buf.arrays()
    if not anchors:
        A = None
    name = os.path.splitext(os.path.basename(path))[0].replace('-', 'm')
    size = write_glb(path, name, center, P, N, UV, A, L, C, I, lod=meta['level'])
    meta.update({
        'center': [round(center[0], 2), round(center[1], 2)],
        'minX': round(float(P[:, 0].min() + center[0]), 1), 'maxX': round(float(P[:, 0].max() + center[0]), 1),
        'minZ': round(float(P[:, 2].min() + center[1]), 1), 'maxZ': round(float(P[:, 2].max() + center[1]), 1),
        'maxY': round(float(P[:, 1].max()), 1), 'tris': buf.tris, 'verts': buf.n, 'bytes': size,
    })
    json.dump(meta, open(path[:-4] + '.json', 'w'))
    return meta


def src_hash(path):
    h = hashlib.md5(open(path, 'rb').read())
    h.update(open(__file__, 'rb').read())      # builder changes rebuild too
    return h.hexdigest()[:12]


def up_to_date(meta_path, hsh):
    try:
        return json.load(open(meta_path)).get('src') == hsh
    except Exception:
        return False


def build_l1(i, j, force=False):
    path = os.path.join(TILES, f'L1_{i}_{j}.json')
    hsh = src_hash(path)
    out1 = os.path.join(OUT, 'l1', f'{i}_{j}.glb')
    if not force and up_to_date(out1[:-4] + '.json', hsh):
        return 'skip'
    js = json.load(open(path))
    T = js['size']
    x0, z0 = js['origin']
    blds = js['buildings']
    # LOD0: the whole 1 km tile in ONE mesh at sub-tile (2i, 2j) (the runtime shows all four 500 m sub-tiles of an
    # LOD1 tile together, missing ones are skipped): a quarter of San Francisco's LOD0 draw calls for the same area
    center = (x0 + T / 2, z0 + T / 2)
    bld = Builder(center, 0)
    for b in blds:
        try:
            bld.building(b)
        except Exception as e:  # noqa
            print(f'[city] building {b["id"]} failed: {e}', flush=True)
    for sub in range(1, 4):
        p = os.path.join(OUT, 'l0', f'{2 * i + (sub & 1)}_{2 * j + (sub >> 1)}')
        for ext in ('.glb', '.json'):
            if os.path.exists(p + ext):
                os.remove(p + ext)
    export_tile(bld.buf, center, os.path.join(OUT, 'l0', f'{2 * i}_{2 * j}.glb'),
                {'level': 0, 'i': 2 * i, 'j': 2 * j, 'size': T, 'placement': 'anchor', 'src': hsh, 'buildings': len(blds)})
    center = (x0 + T / 2, z0 + T / 2)
    bld = Builder(center, 1)
    for blk in l1_blocks(blds):
        try:
            bld.block(blk)
        except Exception as e:  # noqa
            print(f'[city] L1 block failed: {e}', flush=True)
    for b in blds:
        if b.get('mq'):
            bld.mosque(b['mq'], (0.0, 0.0), b['seed'], tuple(b['c']))
    export_tile(bld.buf, center, out1, {'level': 1, 'i': i, 'j': j, 'size': T, 'placement': 'vertex', 'src': hsh,
                                        'buildings': len(blds)}, anchors=False)
    return 'built'


def build_far(i, j, level, force=False):
    path = os.path.join(TILES, f'L{level}_{i}_{j}.json')
    out = os.path.join(OUT, f'l{level}', f'{i}_{j}.glb')
    if not os.path.exists(path):
        for ext in ('.glb', '.json'):
            if os.path.exists(out[:-4] + ext):
                os.remove(out[:-4] + ext)
        return 'none'
    hsh = src_hash(path)
    if not force and up_to_date(out[:-4] + '.json', hsh):
        return 'skip'
    js = json.load(open(path))
    T = js['size']
    x0, z0 = js['origin']
    center = (x0 + T / 2, z0 + T / 2)
    bld = Builder(center, level)
    for blk in js['blocks']:
        try:
            bld.block(blk)
        except Exception as e:  # noqa
            print(f'[city] block failed: {e}', flush=True)
    for m in js.get('mosques', []):
        bld.far_mosque(m, level)
    export_tile(bld.buf, center, out, {'level': level, 'i': i, 'j': j, 'size': T, 'placement': 'vertex', 'src': hsh,
                                       'buildings': len(js['blocks'])}, anchors=False)
    return 'built'


def main():
    argv = sys.argv[1:]
    force = '--force' in argv
    for d in ('l0', 'l1', 'l2', 'l3'):
        os.makedirs(os.path.join(OUT, d), exist_ok=True)
    t0 = time.time()
    if '--tiles' in argv:
        for t in argv[argv.index('--tiles') + 1].split(','):
            if t:
                i, j = (int(v) for v in t.split('_'))
                build_l1(i, j, force)
    if '--far' in argv:
        for t in argv[argv.index('--far') + 1].split(','):
            if t:
                i, j = (int(v) for v in t.split('_'))
                build_far(i, j, 2, force)
                build_far(i, j, 3, force)
    print(f'[city_mesh] done in {time.time() - t0:.0f} s', flush=True)


if __name__ == '__main__':
    main()
