"""Shared geometry helpers for the airport pipeline (W4).

Local frame: x east, z south (north = -z), meters. Heading h (deg, 0 = north, clockwise):
  direction d = (sin h, -cos h), right-hand side r = (cos h, sin h).
"""
import math, json, os, struct
import numpy as np
import mapbox_earcut as earcut
from shapely.geometry import Polygon, MultiPolygon, LineString, MultiLineString, Point, box, GeometryCollection
from shapely.ops import unary_union
from shapely import affinity
from shapely.prepared import prep

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'sf', 'airports')

# marking colour classes (runtime maps these to paint colours)
WHITE, YELLOW, BLACK, RED, RUBBER, ORANGE, GREEN = 0, 1, 2, 3, 4, 5, 6

FT = 0.3048


def hdg_vec(h_deg):
    h = math.radians(h_deg)
    return (math.sin(h), -math.cos(h)), (math.cos(h), math.sin(h))


def polys_of(g):
    """Iterate polygons of any shapely geometry."""
    if g is None or g.is_empty:
        return
    if isinstance(g, Polygon):
        yield g
    elif isinstance(g, (MultiPolygon, GeometryCollection)):
        for p in g.geoms:
            yield from polys_of(p)


def lines_of(g):
    if g is None or g.is_empty:
        return
    if isinstance(g, LineString):
        yield g
    elif hasattr(g, 'geoms'):
        for p in g.geoms:
            yield from lines_of(p)


# ---------------------------------------------------------------- triangulation
def triangulate_polygon(p):
    """earcut a shapely polygon (with holes) -> (verts Nx2, tris Mx3)."""
    rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in p.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return np.zeros((0, 2)), np.zeros((0, 3), dtype=np.int64)
    verts = np.concatenate(rings).astype(np.float64)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    idx = earcut.triangulate_float64(verts, ends)
    return verts, np.asarray(idx, dtype=np.int64).reshape(-1, 3)


class Mesh:
    """2D (x,z) triangle soup with optional per-vertex attributes; vertices deduped per add call."""

    def __init__(self, attrs=()):
        self.p = []          # list of (x, z)
        self.i = []          # indices
        self.attrs = {a: [] for a in attrs}

    def add(self, verts, tris, **attr):
        """verts Nx2, tris Mx3; attr values: scalar/tuple per mesh or callable(x, z) -> value/tuple, or array per vertex."""
        base = len(self.p)
        verts = np.asarray(verts, dtype=np.float64)
        for k, v in enumerate(verts):
            self.p.append((float(v[0]), float(v[1])))
            for a, lst in self.attrs.items():
                val = attr.get(a)
                if callable(val):
                    val = val(v[0], v[1])
                elif isinstance(val, np.ndarray) and val.ndim >= 1 and len(val) == len(verts):
                    val = val[k]
                lst.append(val)
        # make every triangle face up (+y) in the x/z frame: cross((b-a),(c-a)).y = dz1*dx2 - dx1*dz2 > 0
        for t in np.asarray(tris, dtype=np.int64).reshape(-1, 3):
            a, b, c = verts[t[0]], verts[t[1]], verts[t[2]]
            cy = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])
            if cy < 0:
                self.i.extend((int(t[0]) + base, int(t[2]) + base, int(t[1]) + base))
            else:
                self.i.extend((int(t[0]) + base, int(t[1]) + base, int(t[2]) + base))

    def add_polygon(self, poly, **attr):
        for p in polys_of(poly):
            v, t = triangulate_polygon(p)
            if len(t):
                self.add(v, t, **attr)

    def add_quad(self, c, **attr):
        """c: 4 corners in order (x,z)."""
        self.add(c, [(0, 1, 2), (0, 2, 3)], **attr)

    @property
    def nverts(self):
        return len(self.p)


def grid_pieces(geom, cell=40.0, origin=(0.0, 0.0)):
    """Split geometry into pieces clipped by a square grid (so draped surfaces have vertices at most `cell` apart)."""
    geom = geom.buffer(0)
    if geom.is_empty:
        return []
    minx, minz, maxx, maxz = geom.bounds
    ox, oz = origin
    i0, i1 = math.floor((minx - ox) / cell), math.ceil((maxx - ox) / cell)
    j0, j1 = math.floor((minz - oz) / cell), math.ceil((maxz - oz) / cell)
    pg = prep(geom)
    out = []
    for i in range(i0, i1):
        for j in range(j0, j1):
            b = box(ox + i * cell, oz + j * cell, ox + (i + 1) * cell, oz + (j + 1) * cell)
            if not pg.intersects(b):
                continue
            if pg.contains(b):
                out.append(b)
                continue
            piece = geom.intersection(b)
            out.extend(polys_of(piece))
    return out


def add_draped(mesh, geom, cell=40.0, rotate_deg=0.0, pivot=(0, 0), **attr):
    """Triangulate a (large) polygon on a grid (optionally rotated grid aligned with the airport axis)."""
    if rotate_deg:
        g = affinity.rotate(geom, -rotate_deg, origin=pivot)
        for piece in grid_pieces(g, cell):
            v, t = triangulate_polygon(piece)
            if len(t) == 0:
                continue
            pts = affinity.rotate(MultiPoint_from(v), rotate_deg, origin=pivot)
            v2 = np.array([(p.x, p.y) for p in pts.geoms])
            mesh.add(v2, t, **attr)
    else:
        for piece in grid_pieces(geom, cell):
            v, t = triangulate_polygon(piece)
            if len(t):
                mesh.add(v, t, **attr)


def MultiPoint_from(v):
    from shapely.geometry import MultiPoint
    return MultiPoint([tuple(p) for p in v])


def dedupe(mesh, q=0.01):
    """Merge identical vertices (same pos and attrs)."""
    key_to = {}
    newp, newattrs, remap = [], {a: [] for a in mesh.attrs}, []
    for k, (x, z) in enumerate(mesh.p):
        key = (round(x / q), round(z / q)) + tuple(_hashable(mesh.attrs[a][k]) for a in mesh.attrs)
        j = key_to.get(key)
        if j is None:
            j = len(newp)
            key_to[key] = j
            newp.append((x, z))
            for a in mesh.attrs:
                newattrs[a].append(mesh.attrs[a][k])
        remap.append(j)
    idx = [remap[i] for i in mesh.i]
    # drop degenerate triangles
    tri = [idx[i:i + 3] for i in range(0, len(idx), 3)]
    tri = [t for t in tri if t[0] != t[1] and t[1] != t[2] and t[0] != t[2]]
    mesh.p, mesh.attrs, mesh.i = newp, newattrs, [v for t in tri for v in t]
    return mesh


def _hashable(v):
    if isinstance(v, (list, tuple, np.ndarray)):
        return tuple(round(float(x), 3) for x in v)
    return round(float(v), 3) if v is not None else None


# ---------------------------------------------------------------- binary container
class BinWriter:
    """Collects typed arrays; writes <name>.bin and returns a manifest {key: [byteOffset, length, type]}."""

    def __init__(self):
        self.chunks, self.offset, self.manifest = [], 0, {}

    def add(self, key, arr, dtype):
        a = np.ascontiguousarray(np.asarray(arr, dtype=dtype).ravel())
        pad = (-self.offset) % 4
        if pad:
            self.chunks.append(b'\0' * pad)
            self.offset += pad
        self.manifest[key] = [self.offset, int(a.size), {'float32': 'f32', 'uint32': 'u32', 'uint16': 'u16', 'uint8': 'u8', 'int16': 'i16'}[np.dtype(dtype).name]]
        b = a.tobytes()
        self.chunks.append(b)
        self.offset += len(b)

    def add_mesh(self, key, mesh, origin, attr_types=None):
        """Positions stored relative to origin (float32 x,z)."""
        attr_types = attr_types or {}
        if not mesh.p:
            return
        p = np.asarray(mesh.p, dtype=np.float64) - np.asarray(origin, dtype=np.float64)
        self.add(key + '.p', p, np.float32)
        n = len(mesh.p)
        self.add(key + '.i', mesh.i, np.uint32 if n > 65535 else np.uint16)
        for a, lst in mesh.attrs.items():
            arr = np.asarray(lst, dtype=np.float64)
            self.add(f'{key}.{a}', arr, attr_types.get(a, np.float32))

    def write(self, path):
        with open(path, 'wb') as f:
            for c in self.chunks:
                f.write(c)
        return self.manifest


# ---------------------------------------------------------------- runway font (FAA-style block numerals)
GW, GH, GS = 6.1, 18.3, 1.5        # glyph box width, height (60 ft), stroke


def _arc(cx, cy, r, a0, a1, n=10):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / n)), cy + r * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]


def glyph_strokes(ch, w=GW, h=GH, s=GS):
    """Stroke centre polylines of a glyph in a (w x h) box, x right, y up (reading direction)."""
    i = s / 2
    r = (w - s) / 2          # radius of round parts
    L, R, B, T = i, w - i, i, h - i
    cx = w / 2
    mid = h * 0.5
    if ch == '0':
        return [[(L, B + r), (L, T - r)] + _arc(cx, T - r, r, 180, 0)[1:] + [(R, B + r)] + _arc(cx, B + r, r, 0, -180)[1:]]
    if ch == '1':
        return [[(cx + 0.4, B - i), (cx + 0.4, T)], [(cx + 0.4, T), (cx - 1.9, T - 2.6)]]
    if ch == '2':
        return [_arc(cx, T - r, r, 180, 0) + [(R, T - r - 1.2), (L, B + 1.6), (L, B)], [(L - i, B), (R + i, B)]]
    if ch == '3':
        return [[(L - i, T), (R, T), (cx - 0.6, mid + 1.2)], _bowl(cx, B, mid + 1.2, w, s, open_left=True)]
    if ch == '4':
        x4 = R - 1.2
        return [[(x4, B - i), (x4, T + i)], [(x4, T), (L, h * 0.33)], [(L - i, h * 0.33), (R + i, h * 0.33)]]
    if ch == '5':
        return [[(R + i, T), (L, T), (L, mid + 1.2)], _bowl(cx, B, mid + 1.2, w, s, open_left=True, start_left=True)]
    if ch == '6':
        top = _arc(cx, T - r, r, 0, 180)
        return [top + [(L, B + r)] + _arc(cx, B + r, r, 180, 360) + [(R, mid - r + 1.0)] + _arc(cx, mid - r + 1.0, r, 0, 180) + [(L, mid - r + 1.0)]]
    if ch == '7':
        return [[(L - i, T), (R, T), (cx - 0.6, B - i)]]
    if ch == '8':
        rb = r
        rt = r * 0.88
        bot = _loop(cx, B, mid + 0.3, rb, s)
        top = _loop(cx, mid + 0.3, T, rt, s)
        return [bot, top]
    if ch == '9':
        g6 = glyph_strokes('6', w, h, s)
        return [[(w - x, h - y) for (x, y) in g6[0]]]
    if ch == 'L':
        return [[(L, T + i), (L, B), (R + i, B)]]
    if ch == 'R':
        yb = mid - 0.5
        return [[(L, B - i), (L, T), (R - r, T)] + _arc(R - r, T - (T - yb) / 2, (T - yb) / 2, 90, -90) + [(L, yb)], [(cx - 0.3, yb), (R, B - i)]]
    if ch == 'C':
        return [_arc(cx, T - r, r, 0, 180) + [(L, B + r)] + _arc(cx, B + r, r, 180, 360)]
    if ch == '-':
        return [[(L, mid), (R, mid)]]
    if ch == 'A':
        return [[(L, B - i), (cx, T), (R, B - i)], [(L + 1.2, h * 0.35), (R - 1.2, h * 0.35)]]
    if ch == 'B':
        return [[(L, B), (L, T), (R - r, T)] + _arc(R - r, (T + mid) / 2, (T - mid) / 2, 90, -90) + [(L, mid)],
                [(L, mid), (R - r, mid)] + _arc(R - r, (mid + B) / 2, (mid - B) / 2, 90, -90) + [(L, B)]]
    if ch == 'D':
        return [[(L, B), (L, T), (R - r, T)] + _arc(R - r, T - r, r, 90, 0) + [(R, B + r)] + _arc(R - r, B + r, r, 0, -90) + [(L, B)]]
    if ch == 'E':
        return [[(R + i, T), (L, T), (L, B), (R + i, B)], [(L, mid), (R - 0.6, mid)]]
    if ch == 'F':
        return [[(R + i, T), (L, T), (L, B - i)], [(L, mid), (R - 0.6, mid)]]
    if ch == 'G':
        return [_arc(cx, T - r, r, 0, 180) + [(L, B + r)] + _arc(cx, B + r, r, 180, 360) + [(R, mid), (cx, mid)]]
    if ch == 'H':
        return [[(L, B - i), (L, T + i)], [(R, B - i), (R, T + i)], [(L, mid), (R, mid)]]
    if ch == 'K':
        return [[(L, B - i), (L, T + i)], [(R + 0.3, T + i), (L, mid - 1.0), (R + 0.3, B - i)]]
    if ch == 'M':
        return [[(L, B - i), (L, T), (cx, mid), (R, T), (R, B - i)]]
    if ch == 'N':
        return [[(L, B - i), (L, T), (R, B), (R, T + i)]]
    if ch == 'P':
        return [[(L, B - i), (L, T), (R - r, T)] + _arc(R - r, (T + mid) / 2, (T - mid) / 2, 90, -90) + [(L, mid)]]
    if ch == 'S':
        g = glyph_strokes('5', w, h, s)
        return g
    if ch == 'T':
        return [[(L - i, T), (R + i, T)], [(cx, T), (cx, B - i)]]
    if ch == 'U':
        return [[(L, T + i), (L, B + r)] + _arc(cx, B + r, r, 180, 360) + [(R, T + i)]]
    if ch == 'V':
        return [[(L, T + i), (cx, B), (R, T + i)]]
    if ch == 'W':
        return [[(L, T + i), (L + 0.8, B), (cx, mid), (R - 0.8, B), (R, T + i)]]
    if ch == 'Y':
        return [[(L, T + i), (cx, mid), (R, T + i)], [(cx, mid), (cx, B - i)]]
    if ch == 'Z':
        return [[(L - i, T), (R, T), (L, B), (R + i, B)]]
    if ch == 'Q':
        return glyph_strokes('0', w, h, s) + [[(cx, B + 2.5), (R + 0.4, B - i)]]
    if ch == 'O':
        return glyph_strokes('0', w, h, s)
    if ch == 'I':
        return [[(cx, B - i), (cx, T + i)]]
    if ch == 'J':
        return [[(R, T + i), (R, B + r)] + _arc(cx, B + r, r, 0, -180)]
    if ch == 'X':
        return [[(L, T + i), (R, B - i)], [(R, T + i), (L, B - i)]]
    return []


def _bowl(cx, B, top, w, s, open_left=True, start_left=False):
    """Lower bowl of 3/5: from top-left, arc round the right and end at bottom-left."""
    i = s / 2
    L, R = i, w - i
    rr = (top - B) / 2
    cy = B + rr
    rx = (R - L) / 2 + 0.3
    pts = []
    x0 = L if start_left else cx - 0.6
    pts.append((x0, top))
    n = 14
    for k in range(n + 1):
        a = math.radians(90 - 180 * k / n)
        pts.append((cx - 0.3 + rx * math.cos(a) * 0.95, cy + rr * math.sin(a)))
    pts.append((L - i * 0.5, B))
    return pts


def _loop(cx, y0, y1, r, s):
    i = s / 2
    b = y0 + i + r
    t = y1 - i - r
    if t < b:
        t = b
    return [(cx - r, b)] + [(cx - r, t)] + _arc(cx, t, r, 180, 0)[1:] + [(cx + r, b)] + _arc(cx, b, r, 0, -180)[1:]


def glyph_polygon(ch, w=GW, h=GH, s=GS):
    """Buffered glyph as a shapely polygon in the (w x h) box."""
    strokes = glyph_strokes(ch, w, h, s)
    parts = []
    for st in strokes:
        if len(st) >= 2:
            parts.append(LineString(st).buffer(s / 2, cap_style='flat', join_style='mitre', mitre_limit=3.0))
    if not parts:
        return Polygon()
    g = unary_union(parts)
    return g.intersection(box(-0.05, -0.05, w + 0.05, h + 0.05)).buffer(0)


def text_polygon(text, h=GH, gap=None, s=None, w=None):
    """Horizontal text as polygon, origin bottom-left, width returned. Scaled from the runway font."""
    sc = h / GH
    w = w or GW * sc
    s = s or GS * sc
    gap = gap if gap is not None else 1.2 * sc
    parts, x = [], 0.0
    for ch in text:
        if ch == ' ':
            x += w * 0.6
            continue
        g = glyph_polygon(ch, w, h, s)
        cw = w * (0.55 if ch in '1I-' else 1.0)
        if ch in '1I':
            g = affinity.translate(g, -(w - cw) / 2 + 0.3 * sc, 0)
        parts.append(affinity.translate(g, x, 0))
        x += cw + gap
    return unary_union(parts) if parts else Polygon(), x - gap


# ---------------------------------------------------------------- runway frame
class RunwayFrame:
    """Frame of one runway: ends a (index 0) and b; s along from a, t lateral (right of a->b)."""

    def __init__(self, r):
        a, b = r['ends']
        self.r = r
        self.a = np.array([a['x'], a['z']], dtype=np.float64)
        self.b = np.array([b['x'], b['z']], dtype=np.float64)
        d = self.b - self.a
        self.L = float(np.linalg.norm(d))
        self.u = d / self.L
        self.n = np.array([-self.u[1], self.u[0]])   # right of a->b: (cos h, sin h) with d=(sin h,-cos h) -> (-dz, dx)
        self.w = r['width']
        self.id = r['id']

    def P(self, s, t):
        return self.a + self.u * s + self.n * t

    def st(self, x, z):
        p = np.array([x, z]) - self.a
        return float(p @ self.u), float(p @ self.n)

    def rect(self, s0, s1, t0, t1):
        return Polygon([tuple(self.P(s0, t0)), tuple(self.P(s1, t0)), tuple(self.P(s1, t1)), tuple(self.P(s0, t1))])

    def poly(self, extend0=0.0, extend1=0.0, margin=0.0):
        hw = self.w / 2 + margin
        return self.rect(-extend0, self.L + extend1, -hw, hw)


class EndFrame:
    """Frame anchored at one runway end, looking down the runway: s from that end, t to the right."""

    def __init__(self, rf, which):
        self.rf, self.which = rf, which
        self.L = rf.L

    def P(self, s, t):
        if self.which == 0:
            return self.rf.P(s, t)
        return self.rf.P(self.rf.L - s, -t)

    def rect(self, s0, s1, t0, t1):
        return Polygon([tuple(self.P(s0, t0)), tuple(self.P(s1, t0)), tuple(self.P(s1, t1)), tuple(self.P(s0, t1))])

    def to_poly(self, local_poly, s0, t0):
        """Map a polygon in (t, s) text coords (x = lateral right, y = along) placed at (t0, s0)."""
        def f(x, y, z=None):
            xs = np.asarray(x) + t0
            ys = np.asarray(y) + s0
            if self.which == 0:
                px = self.rf.a[0] + self.rf.u[0] * ys + self.rf.n[0] * xs
                pz = self.rf.a[1] + self.rf.u[1] * ys + self.rf.n[1] * xs
            else:
                px = self.rf.a[0] + self.rf.u[0] * (self.rf.L - ys) - self.rf.n[0] * xs
                pz = self.rf.a[1] + self.rf.u[1] * (self.rf.L - ys) - self.rf.n[1] * xs
            return px, pz
        from shapely.ops import transform
        return transform(f, local_poly)


def save_json(path, obj):
    with open(path, 'w') as f:
        json.dump(obj, f, separators=(',', ':'))


def place_poly(poly, cx, cz, up_hdg_deg, ox=0.0, oy=0.0):
    """Map a local polygon (x right, y up; (ox, oy) = local anchor) so that its anchor sits at world (cx, cz) and
    local +y points along heading up_hdg_deg (0 = north)."""
    from shapely.ops import transform
    (ux, uz), (rx, rz) = hdg_vec(up_hdg_deg)
    def f(x, y, z=None):
        xx = np.asarray(x) - ox
        yy = np.asarray(y) - oy
        return cx + rx * xx + ux * yy, cz + rz * xx + uz * yy
    return transform(f, poly)
