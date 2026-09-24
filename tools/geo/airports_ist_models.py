"""İstanbul airport models (terminal, piers, towers, hangar lettering) as face lists for tools/geo/airports_ist_blender.py.

Pure Python (shapely / numpy), called by tools/geo/airports_build.py for GEO_REGION=ist. Coordinates are Blender's
(X = local x, Y = -local z, Z = up), relative to each object's anchor; faces carry the material names of
blender/airports/materials.py (textured facades / roofs, glass_cab) or `ist_atlas` with UVs on a swatch / lettering strip
(tools/geo/airports_ist_atlas.py). Output: assets/ist/airports/_cache/models_<icao>.json (never published; the GLB is).
"""
import math, os, json
import numpy as np
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
from shapely import affinity
from airports_lib import triangulate_polygon, polys_of, OUT
import airports_ist_atlas as A

# facade / roof tile sizes (m) of the shared textures (assets/sf/airports/tex/facades.json)
TILES = json.load(open(os.path.join(os.path.dirname(OUT), '..', 'sf', 'airports', 'tex', 'facades.json'))) \
    if os.path.exists(os.path.join(os.path.dirname(OUT), '..', 'sf', 'airports', 'tex', 'facades.json')) else {}


def tile(mat):
    return tuple(TILES.get(mat, (8.0, 8.0)))


class FM:
    """Face list of one object (Blender XY relative to the anchor)."""

    def __init__(self, name, anchor_local, kind=None):
        self.name = name
        self.ax, self.ay = anchor_local[0], -anchor_local[1]
        self.faces = []
        self.kind = kind

    # local (x, z) -> Blender (x, y) relative to the anchor
    def B(self, p):
        return (p[0] - self.ax, -p[1] - self.ay)

    def face(self, pts, uvs, mat):
        self.faces.append((mat, pts, uvs))

    def sw(self, pts, swatch):
        """Face with every UV at an atlas swatch."""
        uv = A.swatch_uv(swatch)
        self.faces.append(('ist_atlas', pts, [uv] * len(pts)))

    def paint(self, pts, mat, uvs=None):
        """Atlas swatch name -> swatch UVs; textured material -> the given UVs; other constants (glass_cab) -> 0."""
        if mat in A.SWATCH:
            self.sw(pts, mat)
        elif uvs is not None:
            self.face(pts, uvs, mat)
        else:
            self.face(pts, [(0.0, 0.0)] * len(pts), mat)

    # ------------------------------------------------------------ primitives (Blender coordinates)
    def wall(self, a, b, z0, z1, mat, u0=0.0, tile_=None, v0=None):
        """Vertical quad a -> b (outside = right-hand side seen from above when the ring is CCW)."""
        if mat not in TILES:
            self.paint([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], mat)
            return u0
        tw, th = tile_ or tile(mat)
        L = math.dist(a, b)
        u1 = u0 + L / tw
        vb = z0 / th if v0 is None else v0
        vt = z1 / th if v0 is None else v0 + (z1 - z0) / th
        self.face([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)],
                  [(u0, vb), (u1, vb), (u1, vt), (u0, vt)], mat)
        return u1

    def ring_walls(self, ring, z0, z1, mat, tile_=None, v0=None):
        u = 0.0
        for i in range(len(ring)):
            u = self.wall(ring[i], ring[(i + 1) % len(ring)], z0, z1, mat, u, tile_, v0)

    def cap(self, poly_b, z, mat, up=True, tile_=None, zfn=None):
        """Horizontal (or zfn(x, y)-heighted) polygon in Blender XY, earcut triangles, planar UVs (metres / tile)."""
        for p in polys_of(poly_b):
            v, t = triangulate_polygon(p)
            if not len(t):
                continue
            tw, th = tile_ or tile(mat)
            zs = [zfn(x, y) if zfn else z for x, y in v]
            for a, b, c in t:
                pa, pb, pc = v[a], v[b], v[c]
                cr = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
                idx = (a, b, c) if (cr > 0) == up else (a, c, b)
                pts = [(float(v[k][0]), float(v[k][1]), float(zs[k])) for k in idx]
                self.paint(pts, mat, [(q[0] / tw, q[1] / th) for q in pts] if mat in TILES else None)

    def box(self, cx, cy, z0, sx, sy, sz, mat, rot=0.0, top=True):
        c, s = math.cos(rot), math.sin(rot)
        P = lambda x, y: (cx + x * c - y * s, cy + x * s + y * c)
        ring = [P(-sx / 2, -sy / 2), P(sx / 2, -sy / 2), P(sx / 2, sy / 2), P(-sx / 2, sy / 2)]
        for i in range(4):
            self.wall(ring[i], ring[(i + 1) % 4], z0, z0 + sz, mat)
        if top:
            self.cap(Polygon(ring), z0 + sz, mat)

    def loft(self, rings, mat, closed=True, v_tile=None, u_tile=None):
        """rings: lists of (x, y, z) with equal counts, bottom -> top (outward faces for CCW rings)."""
        n = len(rings[0])
        for k in range(len(rings) - 1):
            Ar, Br = rings[k], rings[k + 1]
            u = 0.0
            for i in range(n if closed else n - 1):
                j = (i + 1) % n
                pts = [Ar[i], Ar[j], Br[j], Br[i]]
                if mat not in TILES:
                    self.paint(pts, mat)
                else:
                    tw, th = u_tile or tile(mat)[0], v_tile or tile(mat)[1]
                    L = math.dist(Ar[i][:2], Ar[j][:2])
                    self.face(pts, [(u / tw, Ar[i][2] / th), ((u + L) / tw, Ar[j][2] / th),
                                    ((u + L) / tw, Br[j][2] / th), (u / tw, Br[i][2] / th)], mat)
                    u += L

    def sign(self, a, b, z0, height, strip, off=0.12):
        """Lettering quad on a wall a -> b (Blender XY, outward normal on the right of a -> b), centred, `height` tall,
        its width from the strip's aspect; `off` metres in front of the wall."""
        L = math.dist(a, b)
        w = min(L * 0.8, height * A.strip_aspect(strip))
        h = w / A.strip_aspect(strip)
        d = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        n = (d[1], -d[0])                                   # right-hand normal of a CCW ring edge = outside
        m = ((a[0] + b[0]) / 2 + n[0] * off, (a[1] + b[1]) / 2 + n[1] * off)
        p0 = (m[0] - d[0] * w / 2, m[1] - d[1] * w / 2)
        p1 = (m[0] + d[0] * w / 2, m[1] + d[1] * w / 2)
        u0, v0, u1, v1 = A.strip_uv(strip)
        zc = z0 + (height - h) / 2
        self.face([(p0[0], p0[1], zc), (p1[0], p1[1], zc), (p1[0], p1[1], zc + h), (p0[0], p0[1], zc + h)],
                  [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], 'ist_atlas')
        return w, h

    def json(self, origin=(0.0, 0.0)):
        """origin: the airport origin (local x, z) the GLB's nodes are relative to (<icao>.json 'origin')."""
        f = []
        for mat, pts, uvs in self.faces:
            f.append([mat, [round(float(c), 3) for p in pts for c in p], [round(float(c), 5) for q in uvs for c in q]])
        return {'name': self.name, 'kind': self.kind or self.name.split('_')[0],
                'anchor': [round(self.ax - origin[0], 3), round(self.ay + origin[1], 3)], 'faces': f}

    def tris(self):
        return sum(len(p) - 2 for _, p, _ in self.faces)


def to_b(poly_local, fm):
    """shapely polygon in local (x, z) -> Blender XY relative to fm's anchor."""
    return affinity.affine_transform(poly_local, [1, 0, 0, -1, -fm.ax, -fm.ay])


def ccw_ring(p):
    c = list(p.exterior.coords)[:-1]
    a = sum(c[i][0] * c[(i + 1) % len(c)][1] - c[(i + 1) % len(c)][0] * c[i][1] for i in range(len(c)))
    return c if a > 0 else c[::-1]


def write(icao, objects, origin, remove=(), remove_prefix=()):
    path = os.path.join(OUT, '_cache', f'models_{icao.lower()}.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {'objects': [o.json(origin) for o in objects], 'remove': sorted(set(remove)), 'remove_prefix': list(remove_prefix)}
    json.dump(data, open(path, 'w'), separators=(',', ':'))
    print(f'{icao} models: {len(objects)} objects, {sum(o.tris() for o in objects)} triangles -> {path}')
    return path


# ==================================================================== İstanbul Havalimanı (LTFM) terminal
def _edge_walls(fm, poly_b, z0, z1, mat, others=(), tile_=None, v0=None):
    """Walls around a part (Blender XY): an edge shared with a taller neighbour part is left out, one shared with a
    lower part only rises above it (the hall's airside wall above a pier roof)."""
    for ring in [ccw_ring(poly_b)]:
        u = 0.0
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            L = math.dist(a, b)
            if L < 0.05:
                continue
            m = ((a[0] + b[0]) / 2 + (b[1] - a[1]) / L * 0.6, (a[1] + b[1]) / 2 - (b[0] - a[0]) / L * 0.6)
            lo = z0
            for q, top in others:
                if q.contains(Point(m)):
                    lo = max(lo, top)
            if lo >= z1 - 0.1:
                u += L / (tile_ or tile(mat))[0] if mat in TILES else 0.0
                continue
            u = fm.wall(a, b, lo, z1, mat, u, tile_, None if v0 is None else v0 + (lo - z0) / (tile_ or tile(mat))[1])


def dome_roof(fm, roof_b, origin, ang, Mu, Mv, u_range, v_range, z_edge, z_apex, sky=0.26, mat='roof_metal', full=0.97):
    """Grid of shallow square domes (4 sloped facets rising to a glazed skylight) over roof_b (Blender XY), grid
    aligned with the angle `ang` (radians, u axis) through `origin`; cells cut by the outline are flat at z_edge."""
    ca, sa = math.cos(ang), math.sin(ang)
    P = lambda u, v: (origin[0] + u * ca - v * sa, origin[1] + u * sa + v * ca)
    tw, th = tile(mat)
    uvp = lambda p: (p[0] / tw, p[1] / th)
    covered = []
    n_dome = 0
    for i in range(u_range[0], u_range[1]):
        for j in range(v_range[0], v_range[1]):
            u0, u1, v0, v1 = i * Mu, (i + 1) * Mu, j * Mv, (j + 1) * Mv
            cell = Polygon([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)])
            inter = cell.intersection(roof_b)
            if inter.is_empty or inter.area < 1.0:
                continue
            covered.append(inter)
            if inter.area < full * cell.area:
                fm.cap(inter, z_edge, mat)
                continue
            n_dome += 1
            du, dv = (u1 - u0) * sky / 2, (v1 - v0) * sky / 2
            uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
            C = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]
            S = [P(uc - du, vc - dv), P(uc + du, vc - dv), P(uc + du, vc + dv), P(uc - du, vc + dv)]
            Cz = [(x, y, z_edge) for x, y in C]
            Sz = [(x, y, z_apex) for x, y in S]
            for k in range(4):
                q = (Cz[k], Cz[(k + 1) % 4], Sz[(k + 1) % 4], Sz[k])
                fm.face(list(q), [uvp(p) for p in q], mat)
            fm.face(Sz, [(0.0, 0.0)] * 4, 'glass_cab')
    return unary_union(covered) if covered else Polygon(), n_dome


def ridge_points(poly_b, spacing=15.0, min_half=9.0, res=1.0):
    """Points along the medial axis of an elongated polygon (distance-transform ridge, 1 m raster), `spacing` apart,
    with the local axis direction: [(x, y, dir_x, dir_y, half_width)]."""
    from scipy import ndimage
    x0, y0, x1, y1 = poly_b.bounds
    nx, ny = int((x1 - x0) / res) + 3, int((y1 - y0) / res) + 3
    from shapely import contains_xy
    gx, gy = np.meshgrid(x0 - res + np.arange(nx) * res, y0 - res + np.arange(ny) * res)
    inside = contains_xy(poly_b, gx, gy)
    dist = ndimage.distance_transform_edt(inside) * res
    mx = ndimage.maximum_filter(dist, size=3)
    ridge = inside & (dist >= mx - 1e-6) & (dist >= min_half)
    iy, ix = np.nonzero(ridge)
    order = np.argsort(-dist[iy, ix])
    pts = np.stack([gx[iy, ix], gy[iy, ix]], 1)[order]
    dd = dist[iy, ix][order]
    picked = []
    for p, d in zip(pts, dd):
        if all(math.dist(p, q[:2]) >= spacing for q in picked):
            picked.append((p[0], p[1], d))
    out = []
    for x, y, d in picked:
        near = pts[np.linalg.norm(pts - (x, y), axis=1) < spacing * 1.5]
        if len(near) >= 3:
            w, v = np.linalg.eigh(np.cov((near - near.mean(0)).T))
            dx, dy = v[:, 1]
        else:
            dx, dy = 1.0, 0.0
        out.append((x, y, dx, dy, d))
    return out


def vault_roof(fm, poly_b, ds, hs, mat='roof_metal', sky=(7.0, 5.0), spacing=15.0):
    """Pier roof: inset rings (mitred buffers) at distances ds from the outline lifted to heights hs -> a vault;
    skylights in a row along the ridge (the medial axis)."""
    cur = poly_b
    ext = poly_b.exterior
    zfn = lambda x, y: float(np.interp(ext.distance(Point(x, y)), ds, hs))
    for k in range(len(ds) - 1):
        inner = poly_b.buffer(-ds[k + 1], join_style='mitre', mitre_limit=2.0).simplify(0.6)
        band = cur.difference(inner) if not inner.is_empty else cur
        fm.cap(band, 0.0, mat, zfn=zfn)
        if inner.is_empty:
            cur = None
            break
        cur = inner
    if cur is not None:
        fm.cap(cur, hs[-1], mat)
    n = 0
    for x, y, dx, dy, half in ridge_points(poly_b, spacing):
        la, lb = sky
        ax_, ay_ = dx * la / 2, dy * la / 2
        bx_, by_ = -dy * lb / 2, dx * lb / 2
        z = zfn(x, y) + 0.35
        q = [(x - ax_ - bx_, y - ay_ - by_, z), (x + ax_ - bx_, y + ay_ - by_, z), (x + ax_ + bx_, y + ay_ + by_, z), (x - ax_ + bx_, y - ay_ + by_, z)]
        if (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]) < 0:
            q = q[::-1]
        fm.face(q, [(0.0, 0.0)] * 4, 'glass_cab')
        n += 1
    return n


def ltfm_terminal(hall_l, canopy_l, piers_l, h_hall=45.0, h_pier=27.0):
    """İstanbul Havalimanı terminal (Grimshaw / Nordic / Haptic / Scott Brownrigg, 2018) from the OSM building parts:
    the main hall under a grid of skylit domes (45 m), the roof running on over the landside curb as the canopy on
    columns, three piers (27 m: the X-shaped west and east arms and the central pier) with vaulted roofs and a row of
    skylights along each ridge (the roof is "dotted with skylights": Dezeen 2014 / world-architects "Mosque of mobility").
    The fixed links and bridges are jet bridges (airports_build.fixed_link_jets). Returns FM objects."""
    out = []
    # ---- main hall + canopy (one object, anchored at the hall centroid)
    c = hall_l.centroid
    fm = FM('terminal_ist_hall', (c.x, c.y), kind='terminal')
    hall = to_b(hall_l.simplify(0.8), fm)
    canopy = to_b(canopy_l.simplify(0.8), fm)
    roof = unary_union([hall, canopy.buffer(0.05)]).buffer(-0.05, join_style='mitre').simplify(0.5)
    # grid frame: u along the airside facade, origin mid-way on the landside wall line (the canopy's inner edge)
    mrr = hall.minimum_rotated_rectangle
    cc = list(mrr.exterior.coords)[:4]
    e = max(((cc[k], cc[k + 1]) for k in range(3)), key=lambda ab: math.dist(*ab))
    ang = math.atan2(e[1][1] - e[0][1], e[1][0] - e[0][0])
    if abs(ang) > math.pi / 2:
        ang -= math.copysign(math.pi, ang)
    ca, sa = math.cos(ang), math.sin(ang)
    cu = lambda p: (p[0] * ca + p[1] * sa, -p[0] * sa + p[1] * ca)
    hu = [cu(p) for p in hall.exterior.coords]
    cnu = [cu(p) for p in canopy.exterior.coords]
    u_mid = (min(p[0] for p in hu) + max(p[0] for p in hu)) / 2
    v_land = min(p[1] for p in hu)                   # the hall's landside wall = the canopy's inner edge
    origin = (u_mid * ca - v_land * sa, u_mid * sa + v_land * ca)
    z_wall, z_edge, z_apex = h_hall - 8.0, h_hall - 6.0, h_hall - 0.5
    Mu, Mv = 32.0, 30.0
    umax = max(abs(p[0] - u_mid) for p in hu)
    vmin = min(p[1] - v_land for p in cnu + hu)
    vmax = max(p[1] - v_land for p in hu)
    covered, n_dome = dome_roof(fm, roof, origin, ang, Mu, Mv, (-int(math.ceil(umax / Mu)), int(math.ceil(umax / Mu))),
                                (int(math.floor(vmin / Mv)), int(math.ceil(vmax / Mv))), z_edge, z_apex)
    # hall walls: full-height glazing up to the roof edge
    # walls reach 8 m below the anchor's ground: the graded apron falls up to ~5 m along a 1 km pier
    _edge_walls(fm, hall, -8.0, z_edge, 'fac_glass', others=[(q, h_pier) for q in [to_b(p, fm) for p in piers_l]])
    # canopy: soffit, fascia, columns
    fm.cap(canopy, z_wall, 'ist_soffit', up=False)
    ring = ccw_ring(roof)
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        mid = Point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if canopy.buffer(0.5).contains(mid) and not hall.buffer(0.5).contains(mid):
            fm.wall(a, b, z_wall, z_edge, 'ist_white')
    for i in range(-int(umax // 48), int(umax // 48) + 1):
        u = i * 48.0
        p = (origin[0] + u * ca - (vmin + 6.0) * sa, origin[1] + u * sa + (vmin + 6.0) * ca)
        if canopy.contains(Point(p)):
            fm.box(p[0], p[1], -1.0, 1.6, 1.6, z_wall + 1.0, 'ist_structure', rot=ang)
    out.append(fm)
    # ---- piers
    for k, pl in enumerate(piers_l):
        c = pl.representative_point()
        pm = FM(f'terminal_ist_pier{k}', (c.x, c.y), kind='pier')
        pb = to_b(pl.simplify(1.2), pm)
        others = [(to_b(hall_l, pm), h_hall)] + [(to_b(q, pm), h_pier) for j, q in enumerate(piers_l) if j != k]
        _edge_walls(pm, pb, -8.0, h_pier - 7.0, 'fac_terminal', others=others, tile_=(9.0, h_pier - 7.0))
        vault_roof(pm, pb, [0.0, 4.0, 9.0, 14.0, 19.0], [h_pier - 7.0, h_pier - 4.2, h_pier - 2.0, h_pier - 0.8, h_pier - 0.3])
        out.append(pm)
    print(f'LTFM terminal: {n_dome} domes, hall {out[0].tris()} tris, piers {[o.tris() for o in out[1:]]}')
    return out


# ==================================================================== control towers
def _ring(z, rx, ry, rot, n=24, lobes=0, lobe_amp=0.0):
    c, s = math.cos(rot), math.sin(rot)
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        k = 1.0 + lobe_amp * math.cos(lobes * t) if lobes else 1.0
        x, y = rx * k * math.cos(t), ry * k * math.sin(t)
        out.append((x * c - y * s, x * s + y * c, z))
    return out


def tulip_tower(name, center_local, top=90.0, plan=(11.35, 6.0), rot=0.0, podium=None):
    """İstanbul Havalimanı main ATC tower "TWR-1" (AECOM + Pininfarina, 2018; the tulip): an elliptical, white GRC-clad
    shaft, narrowest at about a third of its height, flaring like a tulip into a cantilevered tray at 74 m, two stacked
    glazed cabs (ground control ~78 m, air control ~85 m), roof ~88 m + antennas to 90+ m; a sweeping wing with three
    seams on one side. Proportions measured on the Commons photo "Istanbul airport tower.jpg" (A. Mueseler) scaled to the
    90 m height; plan = the cab's half axes (OSM way 572703385: 22.7 x 12.0 m), rot = its long axis (radians, Blender).
    podium = (half axes, rot, centre offset (Blender XY)) of the elliptical podium it rises from (OSM way 572703382: 85.5 x 35.2 m, ~10 m tall)."""
    fm = FM(name, center_local, kind='tower')
    k = top / 90.0
    ax, ay = plan
    q = ay / ax                                           # plan aspect (short / long)
    n = 32
    def ell(z, a, dx=0.0):
        pts = _ring(z * k, a, a * q, rot, n)
        c, s_ = math.cos(rot), math.sin(rot)
        return [(p[0] + dx * c, p[1] + dx * s_, p[2]) for p in pts]
    # shaft: long half axis a(z) (m); the flare leans slightly toward the wing side (-x of the plan)
    prof = [(-2.0, 7.8, 0.0), (10.0, 7.6, 0.0), (25.0, 7.3, -0.2), (40.0, 7.9, -0.5), (50.0, 8.9, -0.8), (60.0, 10.6, -1.0),
            (67.0, 12.2, -1.1), (72.0, 13.6, -1.2), (74.0, 14.3, -1.2)]
    rings = [ell(z, a_, dx) for z, a_, dx in prof]
    for i in range(len(rings) - 1):
        fm.loft([rings[i], rings[i + 1]], 'ist_white')
    # tray (cantilevered lip) and the two cabs
    fm.loft([ell(74.0, 14.3, -1.2), ell(75.2, 14.3, -1.2)], 'ist_white')
    fm.cap(Polygon([(p[0], p[1]) for p in ell(75.2, 14.3, -1.2)]), 75.2 * k, 'ist_white')
    fm.loft([ell(75.2, 10.3), ell(80.6, 10.8)], 'glass_cab')
    fm.loft([ell(80.6, 11.4), ell(81.8, 11.4)], 'ist_white')
    fm.cap(Polygon([(p[0], p[1]) for p in ell(80.6, 11.4)]), 80.6 * k, 'ist_soffit', up=False)
    fm.cap(Polygon([(p[0], p[1]) for p in ell(81.8, 11.4)]), 81.8 * k, 'ist_white')
    fm.loft([ell(81.8, 10.4), ell(86.8, 10.9)], 'glass_cab')
    fm.loft([ell(86.8, 11.7), ell(88.4, 11.7)], 'ist_white')
    fm.cap(Polygon([(p[0], p[1]) for p in ell(86.8, 11.7)]), 86.8 * k, 'ist_soffit', up=False)
    fm.cap(Polygon([(p[0], p[1]) for p in ell(88.4, 11.7)]), 88.4 * k, 'ist_white')
    fm.box(0.0, 0.0, 88.4 * k, 5.0, 3.0, 1.6, 'ist_white', rot=rot)
    for dx, h in ((-3.0, 5.5), (0.5, 7.0), (3.5, 4.5)):
        fm.box(dx * math.cos(rot), dx * math.sin(rot), 90.0 * k, 0.2, 0.2, h, 'metal_grey')
    # the wing's three seams: grey strips standing 0.15 m off the shaft on the -x side of the plan
    for j, t in enumerate((math.radians(160), math.radians(180), math.radians(200))):
        c, s_ = math.cos(rot), math.sin(rot)
        pts = []
        for z, a_, dx in prof[1:]:
            x, y = (a_ + 0.15) * math.cos(t) + dx, (a_ + 0.15) * q * math.sin(t)
            pts.append((x * c - y * s_, x * s_ + y * c, z * k))
        for i in range(len(pts) - 1):
            p0, p1 = pts[i], pts[i + 1]
            d = 0.25
            nx, ny = -math.sin(t + rot) * d, math.cos(t + rot) * d
            quad = [(p0[0] - nx, p0[1] - ny, p0[2]), (p0[0] + nx, p0[1] + ny, p0[2]), (p1[0] + nx, p1[1] + ny, p1[2]), (p1[0] - nx, p1[1] - ny, p1[2])]
            fm.sw(quad, 'ist_soffit')
            fm.sw(quad[::-1], 'ist_soffit')
    # elliptical podium with glazed bands
    if podium:
        (pa, pb), prot, (ox, oy) = podium
        pr = lambda z, f=1.0: [(p[0] + ox, p[1] + oy, p[2]) for p in _ring(z, pa * f, pb * f, prot, 40)]
        fm.loft([pr(-2.0), pr(3.2)], 'ist_white')
        fm.loft([pr(3.2, 0.99), pr(6.4, 0.99)], 'ist_glass')
        fm.loft([pr(6.4), pr(10.0)], 'ist_white')
        fm.cap(Polygon([(p[0], p[1]) for p in pr(10.0)]).difference(Polygon([(p[0], p[1]) for p in ell(10.0, 7.6)])), 10.0, 'ist_roof')
    return fm, {'cab0': round(75.2 * k, 1), 'top': round(88.4 * k, 1), 'r': round(ax * 0.75, 1)}


def generic_tower(name, center_local, top, r_cab=6.5, shaft='ist_concrete', cab_h=6.0, base=None):
    """Concrete ATC tower: round shaft, flared cab floor, outward-leaning glazed cab, overhanging roof; optional base
    block (w, d, h) around the foot."""
    fm = FM(name, center_local, kind='tower')
    cab0 = top - cab_h - 2.0
    r0 = max(3.0, r_cab * 0.5)
    fm.loft([_ring(-2.0, r0 * 1.1, r0 * 1.1, 0, 16), _ring(cab0 - 4.0, r0, r0, 0, 16)], shaft)
    fm.loft([_ring(cab0 - 4.0, r0, r0, 0, 16), _ring(cab0, r_cab * 1.05, r_cab * 1.05, 0, 16)], shaft)
    fm.cap(Polygon([(p[0], p[1]) for p in _ring(cab0, r_cab * 1.05, r_cab * 1.05, 0, 16)]), cab0, shaft, up=False)
    fm.loft([_ring(cab0, r_cab * 0.97, r_cab * 0.97, 0, 12), _ring(cab0 + cab_h, r_cab * 1.08, r_cab * 1.08, 0, 12)], 'glass_cab')
    fm.loft([_ring(cab0 + cab_h, r_cab * 1.3, r_cab * 1.3, 0, 16), _ring(cab0 + cab_h + 0.8, r_cab * 1.3, r_cab * 1.3, 0, 16)], 'ist_white')
    fm.cap(Polygon([(p[0], p[1]) for p in _ring(cab0 + cab_h, r_cab * 1.3, r_cab * 1.3, 0, 16)]), cab0 + cab_h, 'ist_soffit', up=False)
    fm.cap(Polygon([(p[0], p[1]) for p in _ring(cab0 + cab_h + 0.8, r_cab * 1.3, r_cab * 1.3, 0, 16)]), cab0 + cab_h + 0.8, 'ist_white')
    fm.box(0.0, 0.0, cab0 + cab_h + 0.8, 2.6, 2.6, 1.6, 'ist_white')
    fm.box(0.8, 0.8, cab0 + cab_h + 2.4, 0.2, 0.2, 5.0, 'metal_grey')
    if base:
        w, d, h = base
        fm.box(0.0, 0.0, -2.0, w, d, h + 2.0, 'ist_concrete')
    return fm, {'cab0': round(cab0, 1), 'top': round(top, 1), 'r': round(r_cab, 1)}


# ==================================================================== hangar lettering
def hangar_signs(b, origin, strip, faces=('door',), frac_h=None):
    """Lettering quads on a hangar building of <icao>.json (b: building dict, local coords relative to `origin`):
    'door' = over the doors of the door edge (b['door_edge'], the long edge facing the apron; the band between the
    door head and the roof: build_buildings.py makes the doors min(0.82 h, h - 3) tall), 'back' = the opposite long
    edge at the same height. One object per building (anchor = the building's anchor, like its generic object)."""
    poly = [(x + origin[0], z + origin[1]) for x, z in b['poly']]
    anc = (b['anchor'][0] + origin[0], b['anchor'][1] + origin[1])
    fm = FM(f'sign_{b["id"]}', anc, kind='sign')
    P = Polygon(poly)
    h = b['h']
    dz = min(h * 0.82, h - 3.0)
    n = len(poly)
    k = b.get('door_edge', -1)
    if k < 0:
        k = max(range(n), key=lambda i: math.dist(poly[i], poly[(i + 1) % n]))
    edges = []
    if 'door' in faces:
        edges.append(k)
    if 'back' in faces:
        a, c = np.array(poly[k]), np.array(poly[(k + 1) % n])
        d = (c - a) / np.linalg.norm(c - a)
        best = max((i for i in range(n) if i != k), key=lambda i: (np.dot((np.array(poly[(i + 1) % n]) - np.array(poly[i])), -d) > 0) * math.dist(poly[i], poly[(i + 1) % n]))
        edges.append(best)
    Pb = to_b(P, fm)
    for i in edges:
        A, C = fm.B(poly[i]), fm.B(poly[(i + 1) % n])
        L = math.dist(A, C)
        m = ((A[0] + C[0]) / 2 + (C[1] - A[1]) / L, (A[1] + C[1]) / 2 - (C[0] - A[0]) / L)   # 1 m to the right
        if Pb.contains(Point(m)):
            A, C = C, A                                          # outside must be on the right of A -> C
        band = (h - dz - 0.8) if i == k else (frac_h or h * 0.22)
        z0 = dz + 0.4 if i == k else h - band - 1.0
        fm.sign(A, C, z0, band, strip)
    return fm


def octagon_tower(name, center_local, top=62.0):
    """Atatürk (LTBA) ATC tower (Commons photos "ControlTowerIstanbulAtatürkAirport.jpg" 2019, "Atatürk Havalimanı
    ATC.JPG"): a concrete shaft of eight fins flaring out under a two-level octagonal head (an office storey widening
    upward, the glazed cab leaning out above it, flat roof with antennas)."""
    fm = FM(name, center_local, kind='tower')
    k = top / 62.0
    oc = lambda z, r: _ring(z * k, r, r, math.pi / 8, 8)
    fm.loft([oc(-2.0, 3.2), oc(40.0, 3.0)], 'ist_concrete')
    # fins: eight thin blades, flaring from 36 m to the head
    for j in range(8):
        t = 2 * math.pi * j / 8
        c, s_ = math.cos(t), math.sin(t)
        prof = [(-2.0, 4.6), (30.0, 4.3), (38.0, 5.0), (44.0, 6.8), (47.0, 8.0)]
        for (z0, r0), (z1, r1) in zip(prof, prof[1:]):
            a0, a1 = (2.9 * c, 2.9 * s_, z0 * k), (2.9 * c, 2.9 * s_, z1 * k)
            b0, b1 = (r0 * c, r0 * s_, z0 * k), (r1 * c, r1 * s_, z1 * k)
            fm.sw([a0, b0, b1, a1], 'ist_concrete')
            fm.sw([a1, b1, b0, a0], 'ist_concrete')
    fm.loft([oc(44.0, 6.2), oc(50.5, 9.6)], 'ist_concrete')                 # office storey (widening)
    fm.cap(Polygon([(p[0], p[1]) for p in oc(44.0, 6.2)]), 44.0 * k, 'ist_concrete', up=False)
    fm.loft([oc(50.5, 9.9), oc(51.3, 9.9)], 'ist_white')                    # balcony
    fm.cap(Polygon([(p[0], p[1]) for p in oc(50.5, 9.9)]), 50.5 * k, 'ist_soffit', up=False)
    fm.loft([oc(51.3, 8.9), oc(56.5, 9.8)], 'glass_cab')                    # cab
    fm.loft([oc(56.5, 9.8), oc(59.5, 10.3)], 'ist_concrete')                # roof band
    fm.cap(Polygon([(p[0], p[1]) for p in oc(59.5, 10.3)]), 59.5 * k, 'ist_concrete')
    fm.box(0.0, 0.0, 59.5 * k, 3.0, 3.0, 2.0, 'metal_grey')
    for dx, dy, h in ((1.0, 0.4, 7.0), (-1.2, 0.8, 6.0), (0.3, -1.3, 5.0)):
        fm.box(dx, dy, 61.5 * k, 0.15, 0.15, h, 'metal_grey')
    return fm, {'cab0': round(51.3 * k, 1), 'top': round(59.5 * k, 1), 'r': 9.0}


def steel_frame_tower(name, center_local, top=91.0, r_cab=8.0):
    """Sabiha Gökçen's second ATC tower (91 m, in service since 9 Jan 2023; OSM way 1159751665): a concrete shaft
    with its steel members left exposed outside it (havasosyalmedya.com "Sabiha Gökçen Havalimanı ikinci kulesi"),
    here four external steel columns braced to the shaft, and a glazed cab."""
    fm, dims = generic_tower(name, center_local, top, r_cab=r_cab)
    cab0 = dims['cab0']
    for j in range(4):
        t = math.pi / 4 + j * math.pi / 2
        x, y = 6.2 * math.cos(t), 6.2 * math.sin(t)
        fm.box(x, y, -2.0, 0.9, 0.9, cab0 + 1.0, 'ist_structure', rot=t)
        for z in range(12, int(cab0) - 4, 14):
            fm.box(x * 0.72, y * 0.72, z, 3.6, 0.35, 0.5, 'ist_structure', rot=t)
    return fm, dims


def barrel_roof(fm, poly_b, ang, z_eave, rise, segments=None, mat='roof_metal', cell=12.0, wall_mat='fac_glass'):
    """Walls to the eave + a barrel roof over poly_b (Blender XY): the roof rises across the width (axis along `ang`,
    radians) or, with segments = n, as n shells arching along the length (Sabiha Gökçen's terminals)."""
    ca, sa = math.cos(ang), math.sin(ang)
    c = poly_b.centroid
    loc = lambda x, y: ((x - c.x) * ca + (y - c.y) * sa, -(x - c.x) * sa + (y - c.y) * ca)
    us, vs = zip(*[loc(x, y) for x, y in poly_b.exterior.coords])
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    def z_of(x, y):
        u, v = loc(x, y)
        if segments:
            L = (u1 - u0) / segments
            f = ((u - u0) % L) / L if u < u1 else 1.0
            return z_eave + rise * (1.0 - (2.0 * f - 1.0) ** 2)
        f = (v - v0) / max(1e-6, v1 - v0)
        return z_eave + rise * (1.0 - (2.0 * f - 1.0) ** 2)
    # interior vertices: clip the polygon by a grid aligned with the axis
    rp = affinity.rotate(poly_b, -ang, origin=c, use_radians=True)
    from airports_lib import grid_pieces
    for piece in grid_pieces(rp, cell, origin=(c.x, c.y)):
        fm.cap(affinity.rotate(piece, ang, origin=c, use_radians=True), 0.0, mat, zfn=z_of)
    ring = ccw_ring(poly_b)
    u = 0.0
    tw, th = tile(wall_mat)
    for i in range(len(ring)):
        A, B = ring[i], ring[(i + 1) % len(ring)]
        n = max(1, int(math.ceil(math.dist(A, B) / cell)))     # wall tops follow the curved roof edge
        for j in range(n):
            a = (A[0] + (B[0] - A[0]) * j / n, A[1] + (B[1] - A[1]) * j / n)
            b = (A[0] + (B[0] - A[0]) * (j + 1) / n, A[1] + (B[1] - A[1]) * (j + 1) / n)
            za, zb = z_of(*a), z_of(*b)
            L = math.dist(a, b)
            fm.face([(a[0], a[1], -6.0), (b[0], b[1], -6.0), (b[0], b[1], zb), (a[0], a[1], za)],
                    [(u / tw, -6.0 / th), ((u + L) / tw, -6.0 / th), ((u + L) / tw, zb / th), (u / tw, za / th)], wall_mat)
            u += L
