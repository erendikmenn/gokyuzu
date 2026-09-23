"""Simple 737-800 passenger cabin (node `interior_cabin`, child of `interior`): lining with cut windows and
reveals, 3-3 economy seats, overhead bins with PSU strips, cove lights, carpet, bulkheads with curtains."""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import shape as S
import mk
from mk import MeshData
import fdlayout as FL
import exterior as EXT
from interior import swatch_uv, oriented_box, quad, frame3, M_PANEL, M_DARK, M_METAL

TB = S.to_b
X0, X1 = 6.95, 30.7
LINING = 0.10
PITCH = 0.787


def lining_point(X, th):
    Y, Z = S.fus_point(X, th)
    Y2, Z2 = S.fus_point(X, th + 1e-3)
    ty, tz = Y2 - Y, Z2 - Z
    L = math.hypot(ty, tz) + 1e-12
    ny, nz = tz / L, -ty / L          # outward for increasing theta (top -> right)
    return float(Y - ny * LINING), float(Z - nz * LINING)


def floor_theta(X):
    th = np.linspace(math.pi / 2, math.pi, 400)
    zs = np.array([lining_point(X, t)[1] for t in th])
    i = int(np.argmin(np.abs(zs - S.FLOOR_Z)))
    return float(th[i])


def build_lining():
    xs = np.arange(X0, X1 + 1e-6, 0.25)
    nt = 64
    rows, uvs = [], []
    for X in xs:
        tf = floor_theta(X)
        ths = np.linspace(-tf, tf, nt)
        ring = [TB(X, *lining_point(X, t)) for t in ths]
        rows.append(np.array(ring))
        uvs.append([swatch_uv('cab_wall', 0.1 + 0.8 * (j / (nt - 1)), 0.1 + 0.8 * ((X - X0) % 2.0) / 2.0) for j in range(nt)])
    P = np.array(rows)
    UV = np.array(uvs)
    md = mk.grid(P, UV, wrap=False, mat=M_PANEL)
    # the lining must face the cabin (inwards): orient against the section centre
    c = TB((X0 + X1) / 2, 0, 3.4)
    s = 0.0
    for f in md.f[:200]:
        p = md.v[f]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        s += np.dot(c - p.mean(0), n)
    if s < 0:
        md.flip()
    return md


def cabin_windows():
    wins = []
    xs = [x for x in S.window_stations() if not (S.OW_RANGE[0] < x < S.OW_RANGE[1])] + list(S.OW_WINDOWS)
    for side in (1, -1):
        for i, x in enumerate(xs):
            w = EXT.Window(f'cw{side}_{i}', [(x - 0.11, S.WIN_Z - 0.155), (x + 0.11, S.WIN_Z - 0.155),
                                            (x + 0.11, S.WIN_Z + 0.155), (x - 0.11, S.WIN_Z + 0.155)], 'side', side)
            w.poly = EXT.round_poly(np.array([(x - 0.11, S.WIN_Z - 0.155), (x + 0.11, S.WIN_Z - 0.155),
                                              (x + 0.11, S.WIN_Z + 0.155), (x - 0.11, S.WIN_Z + 0.155)]), 0.075, 3)
            wins.append(w)
    return wins


def seat_row(md, xr, yc):
    """Triple seat unit centred at lateral yc, row station xr (passengers face -X)."""
    ax = (np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0]))
    fab = lambda s, t: swatch_uv('cab_fabric', 0.05 + 0.9 * s, 0.05 + 0.9 * t)
    head = lambda s, t: swatch_uv('cab_head', 0.05 + 0.9 * s, 0.05 + 0.9 * t)
    # legs + beam
    for dy in (-0.45, 0.45):
        oriented_box(md, (xr + 0.10, yc + dy, 2.85), ax, (0.42, 0.04, 0.40), M_METAL)
    oriented_box(md, (xr + 0.02, yc, 3.02), ax, (0.06, 1.36, 0.05), M_METAL)
    t = math.radians(12)
    up = np.array([math.sin(t), 0, math.cos(t)])
    fwd = np.array([-math.cos(t), 0, math.sin(t)])
    for k in (-1, 0, 1):
        y = yc + k * 0.455
        # cushion: +z face (top) in fabric
        oriented_box(md, (xr, y, 3.09), (np.array([0, 1.0, 0]), np.array([-1.0, 0, 0]), np.array([0, 0, 1.0])),
                     (0.43, 0.46, 0.10), M_PANEL, front_uv=fab, other='cab_fabric')
        # backrest: front (+z = fwd) in fabric, back shell grey
        bc = np.array([xr + 0.26, y, 3.12]) + up * 0.36
        oriented_box(md, bc, (np.array([0, -1.0, 0]), up, fwd), (0.43, 0.72, 0.07), M_PANEL, front_uv=fab, other='cab_fabric')
        # headrest cover wraps over the top of the backrest
        oriented_box(md, bc + up * 0.33 - fwd * 0.036, (np.array([0, -1.0, 0]), up, -fwd), (0.36, 0.08, 0.004), M_PANEL,
                     front_uv=head, other='cab_head')
        hc = bc + up * 0.24 + fwd * 0.047
        oriented_box(md, hc, (np.array([0, -1.0, 0]), up, fwd), (0.36, 0.20, 0.006), M_PANEL, front_uv=head, other='cab_head')
    for k in (-1.5, -0.5, 0.5, 1.5):
        y = yc + k * 0.455
        oriented_box(md, (xr + 0.08, y, 3.29), ax, (0.40, 0.05, 0.05), M_PANEL, other='grey')


def bins(md):
    """Overhead bins both sides, swept along X, following the aft taper."""
    prof = [(0.84, 4.30), (1.40, 4.22), (1.49, 4.40), (1.08, 4.86), (0.90, 4.76), (0.83, 4.55)]
    uv_of = ['cab_psu', 'cab_wall', 'cab_wall', 'cab_light', 'cab_bin', 'cab_bin']
    xs = np.arange(7.0, 29.4 + 1e-6, 0.4)
    for side in (1, -1):
        rings = []
        for X in xs:
            k = float(S.fus_profiles(X)['hw']) / 1.88
            dz = float(S.fus_profiles(X)['zt']) - 5.18
            rings.append([np.array([X, side * y * k, z + dz]) for y, z in prof])
        n = len(prof)
        for i in range(len(xs) - 1):
            for j in range(n):
                j1 = (j + 1) % n
                a, b = rings[i][j], rings[i][j1]
                c, d = rings[i + 1][j1], rings[i + 1][j]
                sw = uv_of[j]
                u0 = ((xs[i] - 7.0) % 1.6) / 1.6
                u1 = u0 + 0.4 / 1.6
                uvs = [swatch_uv(sw, u0, 0.1), swatch_uv(sw, u0, 0.9), swatch_uv(sw, u1, 0.9), swatch_uv(sw, u1, 0.1)]
                pts = [a, b, c, d]
                if side > 0:
                    pts = pts[::-1]; uvs = uvs[::-1]
                quad(md, pts, uvs, M_PANEL, flat=False)
        # end caps
        for i, s in ((0, 1), (len(xs) - 1, -1)):
            pts = rings[i]
            uvs = [swatch_uv('cab_bin', 0.5, 0.5)] * n
            face = list(range(n))
            if (s * side) < 0:
                face = face[::-1]
            md.add(np.array(pts), [face if (s > 0) != (side < 0) else face[::-1]], uvs, mat=M_PANEL, flat=True)


def bulkhead(md, X, facing):
    """Partition across the cabin at station X with an aisle opening (curtain). facing: +1 faces aft."""
    tf = floor_theta(X)
    ths = np.linspace(0, tf, 30)
    edge = [lining_point(X, t) for t in ths]          # right half, top -> floor
    aw, ah = 0.36, 4.55
    # right panel polygon: from aisle opening edge to the wall
    right = [(aw, S.FLOOR_Z), (aw, ah)] + [(y, z) for y, z in edge if y > aw and z < 5.2][:: 1]
    right = [(aw, S.FLOOR_Z), (aw, ah)]
    pts_r = [(y, z) for y, z in edge if y >= aw]
    poly = [(aw, ah)] + [(y, z) for y, z in pts_r[::-1] if z >= ah][::-1]
    # build as a fan of quads between the aisle edge and the lining profile
    zs = np.linspace(S.FLOOR_Z, 5.0, 16)
    def wall_y(z):
        zz = np.array([p[1] for p in edge]); yy = np.array([p[0] for p in edge])
        i = np.argsort(zz)
        return float(np.interp(z, zz[i], yy[i]))
    for side in (1, -1):
        for i in range(len(zs) - 1):
            z0, z1 = zs[i], zs[i + 1]
            ya0 = aw if z0 < ah else 0.0
            ya1 = aw if z1 < ah else 0.0
            if z0 < ah < z1:
                ya1 = aw
            pts = [np.array([X, side * ya0, z0]), np.array([X, side * wall_y(z0), z0]), np.array([X, side * wall_y(z1), z1]),
                   np.array([X, side * ya1, z1])]
            uvs = [swatch_uv('cab_wall', 0.1, 0.1), swatch_uv('cab_wall', 0.9, 0.1), swatch_uv('cab_wall', 0.9, 0.9), swatch_uv('cab_wall', 0.1, 0.9)]
            # normal of this quad points +X*side*? -> orient to face `facing`
            n = np.cross(pts[1] - pts[0], pts[2] - pts[0])
            if n[0] * facing < 0:
                pts = pts[::-1]; uvs = uvs[::-1]
            quad(md, pts, uvs, M_PANEL)
    # lintel above the opening
    top = wall_y(4.9)
    pts = [np.array([X, -aw, ah]), np.array([X, aw, ah]), np.array([X, aw, 5.02]), np.array([X, -aw, 5.02])]
    n = np.cross(pts[1] - pts[0], pts[2] - pts[0])
    uvs = [swatch_uv('cab_wall', 0.2, 0.2)] * 4
    if n[0] * facing < 0:
        pts = pts[::-1]
    quad(md, pts, uvs, M_PANEL)
    # curtain slightly behind the opening
    xc = X - facing * 0.05
    pts = [np.array([xc, -aw, S.FLOOR_Z + 0.05]), np.array([xc, aw, S.FLOOR_Z + 0.05]), np.array([xc, aw, ah]), np.array([xc, -aw, ah])]
    n = np.cross(pts[1] - pts[0], pts[2] - pts[0])
    uvs = [swatch_uv('cab_curtain', 0, 0), swatch_uv('cab_curtain', 1, 0), swatch_uv('cab_curtain', 1, 1), swatch_uv('cab_curtain', 0, 1)]
    if n[0] * facing < 0:
        pts = pts[::-1]; uvs = uvs[::-1]
    quad(md, pts, uvs, M_PANEL)


def build_cabin(imats, fus_uncut_obj=None):
    inter = bpy.data.objects.get('interior') or mk.empty('interior', (0, 0, 0))
    root = mk.empty('interior_cabin', (0, 0, 0))
    mk.set_parent(root, inter)
    # ---- lining with window cut-outs
    lin = build_lining()
    lo = mk.obj('_lining', lin, [imats['panel']])
    bm = bmesh.new(); bm.from_mesh(lo.data); bm.normal_update()
    bmesh.ops.reverse_faces(bm, faces=bm.faces); bm.normal_update()
    wins = cabin_windows()
    EXT.cut_windows(bm, wins, margin=0.12)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    me = bpy.data.meshes.new('cabin_lining'); bm.to_mesh(me); bm.free()
    me.materials.append(imats['panel'])
    lining = bpy.data.objects.new('cabin_lining', me); bpy.context.scene.collection.objects.link(lining)
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    # reveals between the lining and the skin
    dg = bpy.context.evaluated_depsgraph_get()
    rev = None
    if fus_uncut_obj is not None:
        bvh_out = BVHTree.FromObject(fus_uncut_obj, dg)
        bvh_in = BVHTree.FromObject(lo, dg)
        rev = EXT.reveal_strips(wins, bvh_out, bvh_in, step=0.03)
        rev.uv = [swatch_uv('cab_reveal', 0.5, 0.5)] * len(rev.uv)
        rev.set_mat(M_PANEL)
    bpy.data.objects.remove(lo)
    md = MeshData()
    if rev is not None:
        md.merge(rev)
    # ---- floor
    xs = np.arange(X0, X1 + 1e-6, 0.5)
    for i in range(len(xs) - 1):
        w0 = lining_point(xs[i], floor_theta(xs[i]))[0]
        w1 = lining_point(xs[i + 1], floor_theta(xs[i + 1]))[0]
        pts = [np.array([xs[i], -w0, S.FLOOR_Z]), np.array([xs[i + 1], -w1, S.FLOOR_Z]),
               np.array([xs[i + 1], w1, S.FLOOR_Z]), np.array([xs[i], w0, S.FLOOR_Z])]
        u0 = (i % 4) / 4
        quad(md, pts, [swatch_uv('cab_carpet', 0, u0), swatch_uv('cab_carpet', 0, u0 + 0.25),
                       swatch_uv('cab_carpet', 1, u0 + 0.25), swatch_uv('cab_carpet', 1, u0)], M_PANEL)
    # ---- seats
    rows = []
    x = 7.55
    while x < 29.9:
        if 15.7 < x < 17.95:          # exit rows get extra legroom
            x = 18.0
        rows.append(x)
        if abs(x - 15.2) < 0.4:
            rows.append(16.62)
        x += PITCH
    for xr in rows:
        for side in (1, -1):
            seat_row(md, xr, side * 0.94)
    # ---- bins, bulkheads
    bins(md)
    bulkhead(md, X0 - 0.02, +1)
    bulkhead(md, X1 + 0.02, -1)
    md.v = TB(md.v[:, 0], md.v[:, 1], md.v[:, 2])
    mats = [imats['panel'], imats['dark'], imats['metal']]
    cab = mk.obj('cabin', md, mats, smooth=True, sharp_angle=35)
    for o in (lining, cab):
        mk.set_parent(o, root)
    return [lining, cab]
