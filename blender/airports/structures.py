"""Special airport structures built from code (W4): SFO control tower ("torch"), International Terminal roof,
jet bridges, AirTrain guideway, and the KNGZ military structures (HAS, hangars, tower, fire station, fuel tanks,
blast walls, radar, gate, berm). All functions fill a geom.MB in a local frame (origin at ground, metres)."""
import math, random
from geom import MB, orient, ccw
import materials as M


def lerp(a, b, t):
    return a + (b - a) * t


# ================================================================== SFO air traffic control tower
def sfo_tower(mb, r_cab=7.8, cab0=60.0, top=67.36):
    """Tapered 'torch' shaft flaring toward the cab, glass cab with outward-leaning windows, overhanging roof."""
    prof = [(-3.0, 3.7, 3.1, 0), (0.0, 3.7, 3.1, 0), (12.0, 3.8, 3.2, 4), (24.0, 4.1, 3.5, 9), (34.0, 4.6, 4.0, 14),
            (42.0, 5.3, 4.7, 19), (48.0, 6.1, 5.6, 23), (53.0, 6.9, 6.5, 26), (56.5, 7.4, 7.1, 28)]
    seg = 36
    rings = []
    for z, a, b, tw in prof:
        rot = math.radians(tw)
        ring = []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            x, y = a * math.cos(t), b * math.sin(t)
            # torch spine: one side slightly pinched (vertical fin bundle)
            k = 1.0 - 0.06 * math.exp(-((t - math.pi) ** 2) / 0.3)
            x, y = x * k, y * k
            ring.append((x * math.cos(rot) - y * math.sin(rot), x * math.sin(rot) + y * math.cos(rot), z))
        rings.append(ring)
    mb.loft(rings, 'tower_shaft', tile=(3.0, 3.0), cap_top=False)
    # flare to the cab floor
    rc0 = r_cab * 1.02
    last = rings[-1]
    ring2 = [(rc0 * math.cos(2 * math.pi * i / seg), rc0 * math.sin(2 * math.pi * i / seg), cab0 - 1.2) for i in range(seg)]
    ring3 = [(p[0] * 1.03, p[1] * 1.03, cab0 - 0.1) for p in ring2]
    mb.loft([last, ring2], 'metal_white', tile=(4.0, 4.0), cap_top=False)
    mb.loft([ring2, ring3], 'metal_white', tile=(4.0, 4.0), cap_top=False)
    ring3b = [(p[0], p[1], cab0 + 0.05) for p in ring3]
    mb.loft([ring3, ring3b], 'metal_white', cap_top=True)
    # cab: 16 sided glass leaning outward, mullions
    n = 16
    z0, z1 = cab0 + 0.05, top - 1.1
    r0, r1 = r_cab * 0.97, r_cab * 1.06
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p = [(r0 * math.cos(a0), r0 * math.sin(a0), z0), (r0 * math.cos(a1), r0 * math.sin(a1), z0),
             (r1 * math.cos(a1), r1 * math.sin(a1), z1), (r1 * math.cos(a0), r1 * math.sin(a0), z1)]
        mb.face(p, [(0, 0), (1, 0), (1, 1), (0, 1)], 'glass_cab')
        # mullion
        cx0, cy0 = r0 * math.cos(a0), r0 * math.sin(a0)
        cx1, cy1 = r1 * math.cos(a0), r1 * math.sin(a0)
        w = 0.14
        nx, ny = -math.sin(a0) * w, math.cos(a0) * w
        mb.quad((cx0 - nx, cy0 - ny, z0), (cx0 + nx, cy0 + ny, z0), (cx1 + nx, cy1 + ny, z1), (cx1 - nx, cy1 - ny, z1), 'metal_white')
    # roof: overhanging disc + fascia, penthouse, antennas
    rr = r_cab * 1.2
    mb.cylinder(0, 0, z1, z1 + 0.6, rr, rr, 'metal_white', seg=32, top=False, smooth=True)
    mb.cylinder(0, 0, z1 - 0.01, z1, r1, rr, 'metal_white', seg=32, top=False)
    mb.cylinder(0, 0, z1 + 0.6, top, rr * 0.98, r_cab * 0.9, 'metal_white', seg=32, top=True)
    mb.box(0.0, 0.0, top, 5.0, 5.0, 2.4, 'metal_white')
    for (x, y, h) in ((1.5, 1.5, 7.0), (-1.8, 1.2, 5.0), (0.8, -1.9, 4.2)):
        mb.cylinder(x, y, top + 2.4, top + 2.4 + h, 0.08, 0.05, 'metal_grey', seg=6, top=True)
    mb.cylinder(-1.2, -1.2, top + 2.4, top + 3.6, 0.7, 0.7, 'paint_white', seg=12, top=True)


# ================================================================== SFO International Terminal main hall
def intl_terminal(mb, ring, holes, obb_local, h_top=40.0):
    """Glass hall under a long-span 'gull-wing' roof. ring/holes local (blender XY); obb_local = (cx, cy, L, W, ang)."""
    cx, cy, L, W, ang = obb_local
    ca, sa = math.cos(ang), math.sin(ang)

    def uv_of(x, y):
        dx, dy = x - cx, y - cy
        return dx * ca + dy * sa, -dx * sa + dy * ca

    def roof_z(u, v):
        uu = min(1.0, abs(u) / (L / 2 + 8))
        f = 0.35 + 0.65 * max(0.0, 1 - ((uu - 0.42) / 0.58) ** 2)
        z = 21.0 + (h_top - 23.0) * f
        return z - 3.5 * (v / (W / 2 + 8)) ** 2
    ring = orient(ring, True)
    # glass walls up to the roof soffit (tops follow the roof)
    def walls(r):
        u_acc = 0.0
        n = len(r)
        for i in range(n):
            a, b = r[i], r[(i + 1) % n]
            L2 = math.dist(a, b)
            k = max(1, int(L2 // 6))
            for j in range(k):
                p = (lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k))
                q = (lerp(a[0], b[0], (j + 1) / k), lerp(a[1], b[1], (j + 1) / k))
                zp = roof_z(*uv_of(*p)) - 2.0
                zq = roof_z(*uv_of(*q)) - 2.0
                seg = math.dist(p, q)
                tw, th = M.tile('fac_glass')
                mb.face([(p[0], p[1], -3.0), (q[0], q[1], -3.0), (q[0], q[1], zq), (p[0], p[1], zp)],
                        [(u_acc / tw, -3 / th), ((u_acc + seg) / tw, -3 / th), ((u_acc + seg) / tw, zq / th), (u_acc / tw, zp / th)], 'fac_glass')
                u_acc += seg
    walls(ring)
    for hh in holes:
        walls(orient(hh, False))
    # roof: grid over the oriented box + overhang; top skin + soffit + edge fascia
    ov = 10.0
    nu, nv = 36, 10
    U = [-(L / 2 + ov) + (L + 2 * ov) * i / nu for i in range(nu + 1)]
    V = [-(W / 2 + ov) + (W + 2 * ov) * j / nv for j in range(nv + 1)]

    def P(u, v, dz=0.0):
        return (cx + u * ca - v * sa, cy + u * sa + v * ca, roof_z(u, v) + dz)
    for i in range(nu):
        for j in range(nv):
            a, b, c, d = P(U[i], V[j]), P(U[i + 1], V[j]), P(U[i + 1], V[j + 1]), P(U[i], V[j + 1])
            mb.face([a, b, c, d], [(U[i] / 6, V[j] / 6), (U[i + 1] / 6, V[j] / 6), (U[i + 1] / 6, V[j + 1] / 6), (U[i] / 6, V[j + 1] / 6)], 'roof_metal', True)
            a2, b2, c2, d2 = P(U[i], V[j], -1.8), P(U[i + 1], V[j], -1.8), P(U[i + 1], V[j + 1], -1.8), P(U[i], V[j + 1], -1.8)
            mb.face([d2, c2, b2, a2], [(0, 0), (1, 0), (1, 1), (0, 1)], 'metal_white', True)
    # fascia around the edge
    edge = [(U[i], V[0]) for i in range(nu)] + [(U[nu], V[j]) for j in range(nv)] + [(U[nu - i], V[nv]) for i in range(nu)] + [(U[0], V[nv - j]) for j in range(nv)]
    for k in range(len(edge)):
        (u0, v0), (u1, v1) = edge[k], edge[(k + 1) % len(edge)]
        a, b = P(u0, v0), P(u1, v1)
        a2, b2 = P(u0, v0, -1.8), P(u1, v1, -1.8)
        mb.face([a2, b2, b, a], [(0, 0), (1, 0), (1, 1), (0, 1)], 'metal_white')
    # big V-shaped roof supports on the landside and airside edges
    for s in (-0.3, 0.3):
        for side in (-1, 1):
            u = s * L
            v = side * (W / 2 + 4)
            top = P(u, v, -1.8)
            for du in (-6.0, 6.0):
                bx, by, _ = P(u + du * 0.3, v, 0)
                mb.box(bx, by, -1.0, 1.2, 1.2, top[2] + 1.0, 'metal_white', rot=ang)


# ================================================================== jet bridge
def jetbridge(mb, pts, door=None, door_z=3.4, face=None, occupied=True):
    """pts: polyline (local, blender XY) from the terminal to the OSM bridge end. door: target door point for the cab
    (local) when occupied; face: unit vector the cab faces (toward the fuselage)."""
    # rotunda = start of the straight tail
    n = len(pts)
    k = n - 2
    while k > 0:
        path = sum(math.dist(pts[i], pts[i + 1]) for i in range(k - 1, n - 1))
        if path / max(1e-6, math.dist(pts[k - 1], pts[-1])) > 1.06:
            break
        k -= 1
    R = pts[k]
    end = pts[-1]
    if occupied and door is not None:
        cab = (door[0] + face[0] * -2.2, door[1] + face[1] * -2.2)
    else:
        cab = (R[0] + (end[0] - R[0]) * 0.62, R[1] + (end[1] - R[1]) * 0.62)
    floor0 = 4.6
    floor1 = door_z if occupied else 3.8
    # fixed link from the terminal door to the rotunda
    for i in range(k):
        a, b = pts[i], pts[i + 1]
        _tube(mb, a, b, floor0, floor0, 2.6, 2.8, 'fac_jetbridge')
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        mb.box(mid[0], mid[1], -1.0, 0.5, 0.5, floor0 + 1.0, 'metal_grey')
    # rotunda
    mb.cylinder(R[0], R[1], floor0 - 0.3, floor0 + 3.2, 2.3, 2.3, 'metal_white', seg=12, top=True)
    mb.cylinder(R[0], R[1], -1.0, floor0 - 0.3, 0.55, 0.55, 'metal_grey', seg=8, top=False)
    # telescoping tunnels (smaller near the rotunda)
    L = math.dist(R, cab)
    if L < 3:
        return
    d = ((cab[0] - R[0]) / L, (cab[1] - R[1]) / L)
    m1 = (R[0] + d[0] * L * 0.55, R[1] + d[1] * L * 0.55)
    zm = lerp(floor0, floor1, 0.55)
    _tube(mb, (R[0] + d[0] * 2.0, R[1] + d[1] * 2.0), (m1[0] + d[0] * 0.8, m1[1] + d[1] * 0.8), floor0, zm, 2.5, 2.65, 'fac_jetbridge')
    _tube(mb, m1, (cab[0] - d[0] * 1.2, cab[1] - d[1] * 1.2), zm, floor1, 2.8, 2.95, 'fac_jetbridge')
    # drive column + bogie at 80 %
    q = (R[0] + d[0] * L * 0.8, R[1] + d[1] * L * 0.8)
    zq = lerp(floor0, floor1, 0.8)
    nrm = (-d[1], d[0])
    for sg in (-1, 1):
        mb.box(q[0] + nrm[0] * sg * 1.1, q[1] + nrm[1] * sg * 1.1, 0.6, 0.35, 0.35, zq - 0.6, 'metal_grey', rot=math.atan2(d[1], d[0]))
    mb.box(q[0], q[1], 0.0, 1.2, 3.2, 0.9, 'steel_dark', rot=math.atan2(d[1], d[0]))
    # cab (rotated to face the fuselage) + bellows
    f = face if (occupied and face is not None) else d
    rot = math.atan2(f[1], f[0])
    mb.box(cab[0], cab[1], floor1 - 0.3, 3.4, 3.6, 3.3, 'fac_jetbridge', rot=rot)
    mb.box(cab[0] + f[0] * 1.95, cab[1] + f[1] * 1.95, floor1 - 0.1, 0.6, 3.0, 2.8, 'steel_dark', rot=rot)


def _tube(mb, a, b, za, zb, w, h, mat):
    L = math.dist(a, b)
    if L < 0.3:
        return
    d = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
    n = (-d[1] * w / 2, d[0] * w / 2)
    A = [(a[0] + n[0], a[1] + n[1]), (a[0] - n[0], a[1] - n[1])]
    B = [(b[0] + n[0], b[1] + n[1]), (b[0] - n[0], b[1] - n[1])]
    tw, th = M.tile(mat)
    # sides (UV: u along, v across the tube height so the window strip stays level)
    for (pa, pb, flip) in ((A[1], B[1], False), (A[0], B[0], True)):
        pts = [(pa[0], pa[1], za), (pb[0], pb[1], zb), (pb[0], pb[1], zb + h), (pa[0], pa[1], za + h)]
        uvs = [(0, 0), (L / tw, 0), (L / tw, h / th), (0, h / th)]
        if flip:
            pts, uvs = pts[::-1], uvs[::-1]
        mb.face(pts, uvs, mat)
    mb.face([(A[0][0], A[0][1], za + h), (A[1][0], A[1][1], za + h), (B[1][0], B[1][1], zb + h), (B[0][0], B[0][1], zb + h)], [(0, 0), (1, 0), (1, 1), (0, 1)], 'metal_grey')
    mb.face([(A[1][0], A[1][1], za), (A[0][0], A[0][1], za), (B[0][0], B[0][1], zb), (B[1][0], B[1][1], zb)], [(0, 0), (1, 0), (1, 1), (0, 1)], 'steel_dark')
    mb.face([(A[0][0], A[0][1], za), (A[1][0], A[1][1], za), (A[1][0], A[1][1], za + h), (A[0][0], A[0][1], za + h)], [(0, 0), (1, 0), (1, 1), (0, 1)], 'metal_grey')
    mb.face([(B[1][0], B[1][1], zb), (B[0][0], B[0][1], zb), (B[0][0], B[0][1], zb + h), (B[1][0], B[1][1], zb + h)], [(0, 0), (1, 0), (1, 1), (0, 1)], 'metal_grey')


# ================================================================== AirTrain guideway
def airtrain(mb, pts, z=10.0):
    acc = 0.0
    nxt = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        L = math.dist(a, b)
        if L < 0.2:
            continue
        d = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        rot = math.atan2(d[1], d[0])
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        mb.box(mid[0], mid[1], z, L + 0.3, 4.2, 1.7, 'concrete', rot=rot, bottom=True)
        mb.box(mid[0], mid[1], z + 1.7, L + 0.3, 0.3, 0.9, 'paint_white', rot=rot, top=True)
        while nxt <= acc + L:
            t = (nxt - acc) / L
            p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            mb.box(p[0], p[1], -2.0, 1.4, 1.4, z + 2.0, 'concrete', rot=rot)
            mb.box(p[0], p[1], z - 0.8, 1.6, 4.6, 0.8, 'concrete', rot=rot)
            nxt += 32.0
        acc += L


# ================================================================== military (KNGZ) — local frame: door faces +Y
def has(mb, w=22.0, d=38.0, h=9.5, num=1):
    """Hardened aircraft shelter: concrete arch shell, front headwall with the opening, sliding doors parked open at the
    sides, rear exhaust port. Door at +Y."""
    a, H, t = w / 2, h, 1.1
    seg = 16
    prof_in = [(a * math.cos(math.pi * i / seg), H * 0.93 * math.sin(math.pi * i / seg)) for i in range(seg + 1)]
    prof_out = [((a + t) * math.cos(math.pi * i / seg), (H * 0.93 + t) * math.sin(math.pi * i / seg)) for i in range(seg + 1)]
    y0, y1 = -d / 2, d / 2
    tw, th = M.tile('fac_mil_concrete')
    # outer shell (arch) + inner shell (dark)
    acc = 0.0
    for i in range(seg):
        (x0, z0), (x1, z1) = prof_out[i], prof_out[i + 1]
        L = math.dist((x0, z0), (x1, z1))
        mb.face([(x1, y0, z1), (x0, y0, z0), (x0, y1, z0), (x1, y1, z1)], [((acc + L) / tw, y0 / th), (acc / tw, y0 / th), (acc / tw, y1 / th), ((acc + L) / tw, y1 / th)], 'fac_mil_concrete', True)
        acc += L
        (x0, z0), (x1, z1) = prof_in[i], prof_in[i + 1]
        mb.face([(x0, y0, z0), (x1, y0, z1), (x1, y1, z1), (x0, y1, z0)], [(0, 0), (1, 0), (1, 1), (0, 1)], 'concrete_dark', True)
    # ground skirt of the shell (below 0)
    for sx in (-1, 1):
        x = sx * (a + t)
        mb.quad((x, y0, -1.5), (x, y1, -1.5), (x, y1, 0.0), (x, y0, 0.0), 'fac_mil_concrete') if sx > 0 else \
            mb.quad((x, y1, -1.5), (x, y0, -1.5), (x, y0, 0.0), (x, y1, 0.0), 'fac_mil_concrete')
    # front headwall (+Y) with arch opening: polygon outer rectangle minus inner arch
    fy = y1
    hw_w, hw_h = a + t + 3.5, H + t + 1.2
    outer = [(-hw_w, -1.0), (hw_w, -1.0), (hw_w, hw_h), (-hw_w, hw_h)]
    hole = [(x, z) for x, z in prof_in[::-1]] + [(-a, -1.0 + 0.01)][:0]
    _vertical_poly(mb, outer, [hole], fy, 'fac_mil_concrete', +1)
    _vertical_poly(mb, outer, [hole], fy - 1.2, 'fac_mil_concrete', -1)
    # headwall top / sides thickness
    mb.box(0.0, fy - 0.6, hw_h, 2 * hw_w, 1.2, 0.01, 'fac_mil_concrete')
    for sx in (-1, 1):
        mb.box(sx * hw_w, fy - 0.6, -1.0, 0.01, 1.2, hw_h + 1.0, 'fac_mil_concrete', top=False)
    # door leaves parked open at both sides (in front of the headwall), on rails
    for sx in (-1, 1):
        mb.box(sx * (a + 1.2), fy + 1.4, -0.2, a * 1.05, 1.0, H * 0.95, 'mil_green', tile=(4, 4))
        mb.box(sx * (a + 1.2), fy + 1.4, H * 0.95 - 0.2, a * 1.05 + 0.4, 1.3, 0.8, 'steel_dark')
    mb.box(0.0, fy + 1.4, -0.05, 2 * (2 * a + 2.0), 0.4, 0.12, 'steel_dark')
    # rear wall (closed) with exhaust port
    ry = y0
    rear = [(x, z) for x, z in prof_out]
    rear_poly = [(x, max(0.0, z)) for x, z in rear] + [(-(a + t), -1.5), ((a + t), -1.5)][::-1]
    _vertical_poly(mb, [(a + t, -1.5)] + [(x, z) for x, z in prof_out[1:]] + [(-(a + t), -1.5)], [], ry, 'fac_mil_concrete', -1)
    mb.box(0.0, ry - 1.5, 1.0, 5.0, 3.0, 3.2, 'concrete', tile=(4, 4))
    mb.box(0.0, ry - 3.2, 0.5, 6.0, 0.6, 4.2, 'fac_mil_concrete', tile=(4, 4))
    # shelter number plate on the headwall
    mb.box(0.0, fy + 0.05, H + t + 0.2, 3.0, 0.1, 0.9, 'paint_yellow')
    text(mb, f'{num:02d}', 0.7, (0.0, fy + 0.12, H + t + 0.3), '+Y', 'paint_black')


def _vertical_poly(mb, outer, holes, y, mat, facing):
    """Polygon in the XZ plane at Y=y (x, z pairs), facing +Y (facing=1) or -Y."""
    from mathutils import Vector, geometry
    rings = [[Vector((p[0], p[1], 0)) for p in outer]] + [[Vector((p[0], p[1], 0)) for p in h] for h in holes if len(h) >= 3]
    tris = geometry.tessellate_polygon(rings)
    flat = [p for r in rings for p in r]
    tw, th = M.tile(mat) if mat in M.TILES else (4.0, 4.0)
    for t3 in tris:
        a, b, c = flat[t3[0]], flat[t3[1]], flat[t3[2]]
        # normal of (x, z) triangle mapped to (x, y, z): facing +Y requires clockwise in (x, z)
        cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        want = -1 if facing > 0 else 1
        if (cr > 0) != (want > 0):
            a, c = c, a
        pts = [(p.x, y, p.y) for p in (a, b, c)]
        mb.face(pts, [(p.x / tw, p.y / th) for p in (a, b, c)], mat)


def hangar_mil(mb, w, d, h, wall='fac_mil_hangar', door_mat='fac_hangar_door', annex=True, label=''):
    """Steel hangar with barrel roof spanning X, big sliding doors on the +Y face."""
    he = h * 0.72
    seg = 14
    hx, hy = w / 2, d / 2
    rise = h - he
    # barrel profile along X
    prof = [(-hx + w * i / seg, he + rise * math.sin(math.pi * i / seg)) for i in range(seg + 1)]
    tw, th = M.tile('roof_metal')
    for i in range(seg):
        (x0, z0), (x1, z1) = prof[i], prof[i + 1]
        mb.face([(x0, -hy - 0.8, z0), (x1, -hy - 0.8, z1), (x1, hy + 0.8, z1), (x0, hy + 0.8, z0)],
                [(x0 / tw, -hy / th), (x1 / tw, -hy / th), (x1 / tw, hy / th), (x0 / tw, hy / th)], 'roof_metal', True)
    # side walls
    mb.wall((hx, -hy), (hx, hy), -2.0, he, wall)
    mb.wall((-hx, hy), (-hx, -hy), -2.0, he, wall)
    # gable walls (front + back) up to the roof profile
    for y, facing in ((hy, 1), (-hy, -1)):
        poly = [(-hx, -2.0), (hx, -2.0)] + [(x, z) for x, z in prof[::-1]]
        _vertical_poly(mb, poly[:2] + [(x, z) for x, z in prof[::-1]], [], y, wall, facing)
    # doors on +Y (front): 6 panels, slightly proud, with header
    dh = he * 0.95
    mb.box(0.0, hy + 0.45, -0.2, w * 0.92, 0.8, dh + 0.2, door_mat, tile=(8.0, 8.0))
    mb.box(0.0, hy + 0.9, dh, w * 0.96, 1.8, 1.6, 'metal_grey')
    mb.box(0.0, hy + 0.8, -0.05, w, 0.6, 0.12, 'steel_dark')
    # hangar number on the header
    mb.box(0.0, hy + 1.85, dh + 0.2, 6.0, 0.1, 1.2, 'paint_white')
    if label:
        text(mb, label, 0.9, (0.0, hy + 1.92, dh + 0.35), '+Y', 'paint_black')
    if annex:
        mb.box(0.0, -hy - 5.0, -1.0, w * 0.7, 10.0, 7.5, 'fac_mil_stucco', tile=(6.0, 3.6))
        mb.box(0.0, -hy - 5.0, 6.5, w * 0.7 + 0.4, 10.4, 0.5, 'metal_grey')


def tower_mil(mb, h=36.0):
    cab0 = h - 6.0
    mb.box(0.0, 0.0, -2.0, 5.2, 5.2, cab0 + 2.0, 'fac_mil_concrete', tile=(4.0, 4.0))
    # stair/elevator core windows strip
    mb.box(0.0, 2.62, 3.0, 1.2, 0.1, cab0 - 5.0, 'glass_dark')
    # cab floor, 8-sided glass cab leaning outward, roof
    mb.cylinder(0.0, 0.0, cab0 - 1.2, cab0, 3.2, 5.0, 'fac_mil_concrete', seg=8, top=True, smooth=False)
    n = 8
    z0, z1 = cab0, cab0 + 3.8
    r0, r1 = 4.6, 5.1
    for i in range(n):
        a0, a1 = 2 * math.pi * (i + 0.5) / n, 2 * math.pi * (i + 1.5) / n
        mb.face([(r0 * math.cos(a0), r0 * math.sin(a0), z0), (r0 * math.cos(a1), r0 * math.sin(a1), z0),
                 (r1 * math.cos(a1), r1 * math.sin(a1), z1), (r1 * math.cos(a0), r1 * math.sin(a0), z1)], [(0, 0), (1, 0), (1, 1), (0, 1)], 'glass_cab')
    mb.cylinder(0.0, 0.0, z1, z1 + 0.7, 5.8, 5.8, 'paint_white', seg=8, top=True, smooth=False)
    mb.box(0.0, 0.0, z1 + 0.7, 3.0, 3.0, 1.6, 'paint_white')
    mb.cylinder(1.0, 1.0, z1 + 2.3, z1 + 8.0, 0.1, 0.06, 'paint_red', seg=6)
    mb.cylinder(-1.0, -0.8, z1 + 2.3, z1 + 5.0, 0.08, 0.05, 'metal_grey', seg=6)
    # catwalk ring
    mb.cylinder(0.0, 0.0, z0 - 0.2, z0, 5.9, 5.9, 'metal_grey', seg=8, top=True, smooth=False)


def fire_station(mb, w, d, h):
    hx, hy = w / 2, d / 2
    ring = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    mb.ring_walls(ring, -2.0, h, 'fac_mil_stucco')
    mb.cap(ring, [], h, 'roof_gravel', True)
    for k in range(4):
        x = -hx + w * (k + 0.5) / 4
        mb.box(x, hy + 0.06, 0.0, w / 4 - 2.4, 0.12, 5.2, 'paint_red', tile=(3, 3))
        mb.box(x, hy + 0.1, 5.2, w / 4 - 1.8, 0.1, 0.35, 'paint_white')
    mb.box(hx - 4.0, -hy + 4.0, -1.0, 4.0, 4.0, h + 6.0, 'fac_mil_stucco', tile=(6.0, 3.6))
    mb.box(0.0, hy + 3.0, h - 0.6, w * 0.95, 6.0, 0.4, 'metal_grey')


def fuel_tank(mb, r=9.0, h=12.0):
    mb.cylinder(0.0, 0.0, -1.0, h, r, r, 'tank_paint', seg=28, top=False, smooth=True, tile=(6.0, 6.0))
    ring = [(r * 1.01 * math.cos(2 * math.pi * i / 28), r * 1.01 * math.sin(2 * math.pi * i / 28), h) for i in range(28)]
    apex = [(0.001 * math.cos(2 * math.pi * i / 28), 0.001 * math.sin(2 * math.pi * i / 28), h + 1.1) for i in range(28)]
    mb.loft([ring, apex], 'tank_paint', cap_top=False, tile=(4.0, 4.0))
    # spiral stair hint + handrail on top
    mb.box(r + 0.4, 0.0, 0.0, 0.8, 2.0, h, 'metal_grey')
    mb.cylinder(0.0, 0.0, h + 0.9, h + 1.4, 1.2, 1.2, 'metal_grey', seg=8)


def blast_wall(mb, length=15.0, height=4.5):
    """Row of precast concrete T-walls along local Y."""
    n = int(length // 1.52)
    for k in range(n):
        y = -length / 2 + 0.76 + k * 1.52
        mb.box(0.0, y, 0.0, 2.2, 1.46, 0.45, 'fac_mil_concrete', tile=(2.0, 2.0))
        mb.box(0.0, y, 0.45, 0.35, 1.46, height - 0.45, 'fac_mil_concrete', tile=(2.0, 4.0))


def radar(mb, h=22.0):
    b = 2.2
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box(sx * b, sy * b, -1.0, 0.35, 0.35, h + 1.0, 'paint_white')
    for z in range(3, int(h), 4):
        for (x0, y0, x1, y1) in ((-b, -b, b, -b), (b, -b, b, b), (b, b, -b, b), (-b, b, -b, -b)):
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            rot = math.atan2(y1 - y0, x1 - x0)
            mb.box(mx, my, z, 2 * b, 0.15, 0.15, 'paint_red' if (z // 4) % 2 else 'paint_white', rot=rot)
    mb.box(0.0, 0.0, h, 5.4, 5.4, 0.4, 'metal_grey')
    mb.box(0.0, 0.0, h + 0.4, 1.0, 1.0, 1.4, 'metal_grey')
    # antenna reflector (slightly curved panel)
    for i in range(5):
        x = -3.0 + 1.5 * i
        yb = 0.25 * ((i - 2) ** 2) / 4
        mb.box(x, yb, h + 1.8, 1.5, 0.3, 2.4, 'paint_white')


def gate(mb):
    # guard house, canopy over two lanes, barrier arms, base sign
    mb.box(0.0, 0.0, -0.5, 3.6, 4.0, 3.4, 'fac_mil_stucco', tile=(6.0, 3.6))
    mb.box(0.0, 0.0, 2.9, 4.4, 4.8, 0.3, 'metal_grey')
    mb.box(0.0, 0.0, 5.6, 14.0, 22.0, 0.8, 'metal_white')
    for sx in (-6.5, 6.5):
        for sy in (-10.0, 10.0):
            mb.box(sx, sy, -0.5, 0.5, 0.5, 6.1, 'metal_grey')
    for sx in (-4.0, 4.0):
        mb.box(sx, 3.0, 0.9, 0.3, 4.0, 0.12, 'paint_red')
        mb.box(sx, 1.0, 0.0, 0.4, 0.4, 1.0, 'paint_yellow')
    mb.box(0.0, -14.0, 0.0, 9.0, 0.6, 2.2, 'fac_mil_stucco', tile=(6.0, 3.6))
    mb.box(0.0, -14.35, 0.6, 7.6, 0.1, 1.3, 'sign_white')
    text(mb, 'ALAMEDA HAVA ÜSSÜ', 0.62, (0.0, -14.42, 1.05), '-Y', 'paint_navy')
    # flag pole + Turkish flag (textured quad, both sides)
    mb.cylinder(6.0, -14.0, 0.0, 12.0, 0.1, 0.06, 'metal_white', seg=8)
    flag(mb, 6.1, -14.0, 9.6, 2.4, 1.6)


def berm(mb, ring, h=1.8):
    """Earth embankment along a closed ring (local XY)."""
    ring = orient(ring, True)
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        L = math.dist(a, b)
        d = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        nx, ny = d[1], -d[0]     # outward
        for side, w0, w1, z0, z1 in ((1, 2.5, 0.5, 0.0, h), (-1, 2.5, 0.5, 0.0, h)):
            pa0 = (a[0] + nx * side * w0, a[1] + ny * side * w0)
            pb0 = (b[0] + nx * side * w0, b[1] + ny * side * w0)
            pa1 = (a[0] + nx * side * w1, a[1] + ny * side * w1)
            pb1 = (b[0] + nx * side * w1, b[1] + ny * side * w1)
            pts = [(pa0[0], pa0[1], -0.3), (pb0[0], pb0[1], -0.3), (pb1[0], pb1[1], z1), (pa1[0], pa1[1], z1)]
            if side < 0:
                pts = pts[::-1]
            mb.face(pts, [(0, 0), (L / 4, 0), (L / 4, 1), (0, 1)], 'earth')
        mb.face([(a[0] + nx * 0.5, a[1] + ny * 0.5, h), (b[0] + nx * 0.5, b[1] + ny * 0.5, h), (b[0] - nx * 0.5, b[1] - ny * 0.5, h), (a[0] - nx * 0.5, a[1] - ny * 0.5, h)],
                [(0, 0), (1, 0), (1, 1), (0, 1)], 'earth')


def pitched_building(mb, w, d, h, wall, roof_mat, pitch=0.35):
    hx, hy = w / 2, d / 2
    ring = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    mb.ring_walls(ring, -2.0, h, wall)
    ridge = h + pitch * hy
    ov = 0.6
    tw, th = M.tile(roof_mat) if roof_mat in M.TILES else (4.0, 4.0)
    for sy in (-1, 1):
        a = (-hx - ov, sy * (hy + ov), h - 0.2)
        b = (hx + ov, sy * (hy + ov), h - 0.2)
        c = (hx + ov, 0.0, ridge)
        e = (-hx - ov, 0.0, ridge)
        pts = [a, b, c, e] if sy < 0 else [b, a, e, c]
        mb.face(pts, [(0, 0), (w / tw, 0), (w / tw, hy / th), (0, hy / th)], roof_mat)
    for sx in (-1, 1):
        tri = [(sx * hx, -hy, h), (sx * hx, hy, h), (sx * hx, 0.0, ridge)]
        if sx < 0:
            tri = tri[::-1]
        mb.face(tri, [(0, 0), (1, 0), (0.5, 0.5)], wall)


def tower_generic(mb, r_cab=5.2, cab0=64.0, top=72.0):
    """Slender concrete control tower: round shaft, flared cab floor, glass cab leaning outward, overhanging roof."""
    mb.cylinder(0.0, 0.0, -2.0, cab0 - 3.0, 3.4, 3.0, 'fac_mil_concrete', seg=20, top=False, tile=(4.0, 4.0))
    mb.cylinder(0.0, 0.0, cab0 - 3.0, cab0, 3.0, r_cab * 1.05, 'fac_mil_concrete', seg=20, top=True, tile=(4.0, 4.0))
    n = 12
    z0, z1 = cab0, top - 1.0
    r0, r1 = r_cab * 0.97, r_cab * 1.07
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        mb.face([(r0 * math.cos(a0), r0 * math.sin(a0), z0), (r0 * math.cos(a1), r0 * math.sin(a1), z0),
                 (r1 * math.cos(a1), r1 * math.sin(a1), z1), (r1 * math.cos(a0), r1 * math.sin(a0), z1)], [(0, 0), (1, 0), (1, 1), (0, 1)], 'glass_cab')
    mb.cylinder(0.0, 0.0, z1, z1 + 0.6, r_cab * 1.25, r_cab * 1.25, 'metal_white', seg=24, top=True)
    mb.box(0.0, 0.0, z1 + 0.6, 3.0, 3.0, 1.8, 'metal_white')
    mb.cylinder(0.8, 0.8, z1 + 2.4, z1 + 7.0, 0.08, 0.05, 'metal_grey', seg=6)


def text(mb, txt, size, origin, facing, mat, depth=0.03):
    """Solid text (Blender's built-in font) standing on a vertical plane. origin = centre-bottom (local x, y, z);
    facing: '+Y' | '-Y' | '+X' | '-X' (direction the readable side faces)."""
    import bpy
    from mathutils import Matrix
    cu = bpy.data.curves.new('tmp_text', 'FONT')
    cu.body = txt
    cu.size = size
    cu.align_x = 'CENTER'
    cu.extrude = depth
    ob = bpy.data.objects.new('tmp_text', cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    # text lies in XY (reading along +X, up +Y, front +Z) -> rotate so that front faces `facing`, up = +Z
    rotx = Matrix.Rotation(math.pi / 2, 4, 'X')                 # front -> -Y, up -> +Z
    rz = {'-Y': 0.0, '+X': math.pi / 2, '+Y': math.pi, '-X': -math.pi / 2}[facing]
    M4 = Matrix.Translation(origin) @ Matrix.Rotation(rz, 4, 'Z') @ rotx
    verts = [M4 @ v.co for v in me.vertices]
    for poly in me.polygons:
        pts = [tuple(verts[i]) for i in poly.vertices]
        mb.face(pts, [(0, 0)] * len(pts), mat)
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)


def flag(mb, x, y, z, w, h):
    """Turkish flag quad on both sides (hoist at x)."""
    a, b, c, d = (x, y, z), (x + w, y, z), (x + w, y, z + h), (x, y, z + h)
    mb.face([a, b, c, d], [(0, 0), (1, 0), (1, 1), (0, 1)], 'flag_tr')
    mb.face([d, c, b, a], [(0, 1), (1, 1), (1, 0), (0, 0)], 'flag_tr')


def localizer(mb, width=42.0):
    """Localizer antenna array across the extended centreline (local X), antennas facing +Y (toward the runway)."""
    n = int(width // 2.1)
    for k in range(n):
        x = -width / 2 + width * (k + 0.5) / n
        mb.box(x, 0.0, 0.0, 0.12, 0.12, 2.6, 'paint_white')              # mast
        mb.box(x, 0.18, 2.35, 0.9, 0.08, 0.25, 'metal_grey')            # log-periodic element (simplified)
        mb.box(x, 0.18, 1.65, 0.7, 0.08, 0.2, 'metal_grey')
    mb.box(0.0, -0.05, 0.25, width, 0.12, 0.12, 'metal_grey')            # feed line / ground frame
    mb.box(0.0, -0.05, 2.9, width, 0.1, 0.1, 'metal_grey')
    mb.box(0.0, -9.0, -0.3, 3.0, 2.4, 2.9, 'paint_white')               # equipment shelter
    mb.box(0.0, -9.0, 2.6, 3.4, 2.8, 0.2, 'metal_grey')


def glideslope(mb):
    """Glideslope mast (15 m lattice, red/white) with three antennas facing the approach (+Y) and a shelter."""
    b = 0.45
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box(sx * b, sy * b, -0.5, 0.12, 0.12, 15.5, 'paint_white')
    for z in range(1, 15, 2):
        for (x0, y0, x1, y1) in ((-b, -b, b, -b), (b, -b, b, b), (b, b, -b, b), (-b, b, -b, -b)):
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            mb.box(mx, my, z, 2 * b, 0.06, 0.06, 'paint_red' if (z // 2) % 2 else 'paint_white', rot=math.atan2(y1 - y0, x1 - x0))
    for z in (4.5, 9.0, 13.5):
        mb.box(0.0, b + 0.4, z, 1.6, 0.25, 0.6, 'metal_grey')
    mb.box(3.5, 0.0, -0.3, 3.0, 2.4, 2.9, 'paint_white')
    mb.box(3.5, 0.0, 2.6, 3.4, 2.8, 0.2, 'metal_grey')
