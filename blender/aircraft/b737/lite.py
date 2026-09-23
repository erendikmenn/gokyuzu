"""interior_lite: light stand-in for the flight deck in the exterior GLB (CONTRACTS-SF.md 6.2.1, <= 15k triangles):
lining with the window openings, glareshield, the main panels as flat textured plates (small copy of the baked panel
atlas with the displays pasted in, emissive at night), pedestal, seats and two seated pilots."""
import os
import math
import numpy as np
import bpy
import bmesh

import shape as S
import mk
from mk import MeshData
import fdlayout as FL
import materials as MAT
import interior as INT

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, 'tex')
TB = S.to_b
LITE_RES = 1024


def luv(name, u=0.5, v=0.5):
    x0, y0, x1, y1 = FL.LITE_SW[name]
    return ((x0 + u * (x1 - x0)) / FL.ATLAS, 1 - (y0 + (1 - v) * (y1 - y0)) / FL.ATLAS)


def box(md, c, axes, size, sw):
    INT.oriented_box(md, c, axes, size, 0, uvfun=lambda *a: luv(sw))


def tube(md, p0, p1, r0, r1, sw, n=8):
    mk.tube(np.asarray(p0, float), np.asarray(p1, float), r0, r1, n=n, caps=True, mat=0, md=md)
    k = len(md.uv)
    # lathe gives its own uvs: remap the new loops to the swatch
    return md


def remap_uv(md, start_loop, sw):
    uv = luv(sw)
    for i in range(start_loop, len(md.uv)):
        md.uv[i] = uv


def pilot(md, yc):
    """Seated pilot (white shirt, dark trousers) - enough to read through the windows from outside."""
    X = np.array((1.0, 0, 0)); Y = np.array((0, 1.0, 0)); Z = np.array((0, 0, 1.0))
    s = np.sign(yc)
    hip = np.array((3.32, yc, 3.20))
    sh = np.array((3.32, yc, 3.60))
    # torso (lofted ellipses)
    rings = []
    for t, (rx, ry) in ((0.0, (0.10, 0.16)), (0.35, (0.11, 0.16)), (0.75, (0.12, 0.19)), (1.0, (0.09, 0.17))):
        c = hip + (sh - hip) * t
        rings.append([c + X * rx * math.cos(a) + Y * ry * math.sin(a) for a in np.linspace(0, 2 * math.pi, 11)[:-1]])
    st = len(md.uv)
    for i in range(len(rings) - 1):
        for j in range(10):
            j1 = (j + 1) % 10
            INT.face(md, [rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]], [luv('shirt')] * 4, 0,
                     away=hip + (sh - hip) * (i + 0.5) / 3)
    INT.face(md, rings[-1], [luv('shirt')] * 10, 0, direction=(0, 0, 1))
    # neck + head + hair + headset band
    st = len(md.uv)
    mk.tube(sh + Z * 0.0, sh + Z * 0.10 - X * 0.02, 0.045, 0.045, n=8, caps=False, mat=0, md=md)
    remap_uv(md, st, 'skin')
    head = np.array((3.26, yc, 3.80))
    st = len(md.uv)
    prof = [(0.0, -0.115), (0.06, -0.10), (0.088, -0.05), (0.095, 0.0), (0.09, 0.05), (0.065, 0.10), (0.0, 0.125)]
    mk.lathe(prof, n=10, origin=head, axis=(0, 0, 1), ref=(1, 0, 0), mat=0, md=md)
    remap_uv(md, st, 'skin')
    st = len(md.uv)
    prof = [(0.0, 0.0), (0.07, 0.01), (0.098, 0.05), (0.09, 0.10), (0.05, 0.135), (0.0, 0.14)]
    mk.lathe(prof, n=10, origin=head + X * 0.012 - Z * 0.01, axis=(0, 0, 1), ref=(1, 0, 0), mat=0, md=md)
    remap_uv(md, st, 'hair')
    # legs: thighs forward, shins down to the pedals
    for dy in (-0.10, 0.10):
        h0 = hip + Y * dy + Z * 0.0
        knee = np.array((2.90, yc + dy * 1.1, 3.25))
        foot = np.array((2.40, yc + dy * 1.05, 2.78))
        st = len(md.uv)
        mk.tube(h0, knee, 0.075, 0.058, n=8, caps=True, mat=0, md=md)
        mk.tube(knee, foot, 0.055, 0.042, n=8, caps=True, mat=0, md=md)
        remap_uv(md, st, 'navy')
        st = len(md.uv)
        box(md, foot + X * -0.04 + Z * -0.02, (Y, X, Z), (0.10, 0.26, 0.07), 'black')
    # arms: shoulders -> elbows -> hands on the yoke grips
    for dy in (-1, 1):
        a0 = sh + Y * dy * 0.19 - Z * 0.02
        el = np.array((3.10, yc + dy * 0.26, 3.36))
        hand = np.array((2.76, yc + dy * 0.17, 3.31))
        st = len(md.uv)
        mk.tube(a0, el, 0.048, 0.040, n=8, caps=True, mat=0, md=md)
        remap_uv(md, st, 'shirt')
        st = len(md.uv)
        mk.tube(el, hand, 0.036, 0.030, n=8, caps=True, mat=0, md=md)
        remap_uv(md, st, 'skin')


def seat(md, yc):
    X = np.array((1.0, 0, 0)); Y = np.array((0, 1.0, 0)); Z = np.array((0, 0, 1.0))
    cx, zt = FL.SEAT_X, FL.SEAT_Z
    box(md, (cx + 0.06, yc, FL.FLOOR + 0.22), (X, Y, Z), (0.34, 0.30, 0.40), 'black')
    box(md, (cx, yc, zt - 0.05), (X, Y, Z), (0.48, 0.49, 0.10), 'seat')
    t = math.radians(9)
    up = np.array([math.sin(t), 0, math.cos(t)])
    fwd = np.array([-math.cos(t), 0, math.sin(t)])
    bc = np.array([cx + 0.25, yc, zt + 0.02]) + up * 0.34
    box(md, bc, (-Y, up, fwd), (0.50, 0.68, 0.12), 'seat')
    box(md, bc + up * 0.44, (-Y, up, fwd), (0.30, 0.19, 0.10), 'seat')
    for sy in (-1, 1):
        box(md, bc + (-Y) * (sy * 0.285) - up * 0.12 + fwd * 0.16, (fwd, Y, up), (0.34, 0.075, 0.06), 'seat')


def panels(md, L):
    """Main panels as flat plates with the (small) panel atlas."""
    for name in ('mip', 'glareshield', 'p9', 'p8', 'ovh_fwd', 'ovh_aft', 'console_L', 'console_R'):
        p = L[name]
        poly = p.shape or [(0, 0), (p.w, 0), (p.w, p.h), (0, p.h)]
        tris = INT.ear_clip(poly)
        pts = [p.P(x, y, 0.002) for x, y in poly]
        for t in tris:
            md.add(np.array([pts[i] for i in t]), [[0, 1, 2]], [p.uv(*poly[i]) for i in t], mat=0, flat=True)
    tq = L['tq_top']
    for i in range(8):
        y0, y1 = tq.h * i / 8, tq.h * (i + 1) / 8
        q = [(0, y0), (tq.w, y0), (tq.w, y1), (0, y1)]
        md.add(np.array([FL.tq_point(x, y, 0.0) for x, y in q]), [[0, 1, 2, 3]], [tq.uv(x, y) for x, y in q], mat=0, flat=True)


def structure(md):
    X = np.array((1.0, 0, 0)); Y = np.array((0, 1.0, 0)); Z = np.array((0, 0, 1.0))
    # glareshield (coarse loft)
    ys = np.linspace(-0.95, 0.95, 11)
    rings = []
    for Yv in ys:
        a = abs(Yv)
        sx = INT.gs_x_aft(a)
        ft = FL.GS_FACE_TOP + np.array((sx, 0))
        fb = FL.GS_FACE_BOT + np.array((sx, 0))
        xf = min(INT.x_of_halfwidth(max(a, 0.02), 3.575, inset=0.095) + 0.004, ft[0] - 0.04)
        prof = [(xf, 3.40), (xf, 3.575), (ft[0] - 0.02, 3.575), (ft[0], ft[1]), (fb[0], fb[1]), (2.408 + sx, 3.418)]
        rings.append([np.array((x, Yv, z)) for x, z in prof])
    for i in range(len(rings) - 1):
        for j in range(len(rings[0]) - 1):
            pts = [rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]]
            inner = np.array((0.5 * (rings[i][0][0] + rings[i][4][0]), pts[0][1], 3.49))
            INT.face(md, pts, [luv('black')] * 4, 0, away=inner)
    # pedestal bodies
    box(md, ((FL.TQ_X0 + FL.TQ_X1) / 2, 0, (FL.FLOOR + 2.93) / 2), (X, Y, Z), (FL.TQ_X1 - FL.TQ_X0, 2 * FL.TQ_HALF, 2.93 - FL.FLOOR), 'seat')
    box(md, ((FL.P8_X0 + FL.P8_X1) / 2, 0, (FL.FLOOR + 2.88) / 2), (X, Y, Z), (FL.P8_X1 - FL.P8_X0, 2 * FL.P8_HALF, 2.88 - FL.FLOOR), 'seat')
    box(md, (2.55, 0, (FL.FLOOR + 2.86) / 2), (X, Y, Z), (0.16, 0.58, 2.86 - FL.FLOOR), 'seat')
    # side consoles
    for s in (-1, 1):
        box(md, ((FL.CONSOLE_X0 + FL.CONSOLE_X1) / 2, s * 1.10, (FL.FLOOR + FL.CONSOLE_Z) / 2), (X, Y, Z),
            (FL.CONSOLE_X1 - FL.CONSOLE_X0, 0.40, FL.CONSOLE_Z - FL.FLOOR), 'lining')
    # floor + bulkhead
    INT.face(md, [(2.24, -1.3, FL.FLOOR), (4.72, -1.3, FL.FLOOR), (4.72, 1.3, FL.FLOOR), (2.24, 1.3, FL.FLOOR)], [luv('black')] * 4, 0,
             direction=(0, 0, 1))
    Xb = 4.72
    zc = INT.ceiling_z(Xb, 0.0)
    zs = np.linspace(FL.FLOOR, zc, 7)
    right = [(INT.half_width_at(Xb, z, 0.09), z) for z in zs]
    outline = [(Xb, y, z) for y, z in right] + [(Xb, -y, z) for y, z in right[::-1]]
    P = np.array(outline)
    c = P.mean(0)
    for i in range(len(P)):
        j = (i + 1) % len(P)
        tri = [c, P[i], P[j]]
        if np.linalg.norm(INT.newell(tri)) > 1e-9:
            INT.face(md, tri, [luv('lining')] * 3, 0, direction=(-1, 0, 0))


def lite_shell(shell_src):
    """Decimated copy of the flight-deck lining (window openings kept)."""
    me = shell_src.data.copy()
    o = bpy.data.objects.new('_lite_shell', me)
    bpy.context.scene.collection.objects.link(o)
    o.matrix_world = shell_src.matrix_world.copy()
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(7.5), verts=bm.verts, edges=bm.edges, use_dissolve_boundaries=False)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    uvl = bm.loops.layers.uv.active or bm.loops.layers.uv.new('UVMap')
    uv = luv('lining')
    for f in bm.faces:
        for l in f.loops:
            l[uvl].uv = uv
    bm.to_mesh(me); bm.free()
    return o


def make_texture():
    """fd_lite.jpg (1024^2): downscaled baked panel atlas with the static display images pasted into the DU areas;
    fd_lite_emit.jpg (512^2): the displays only (glow at night)."""
    base = bpy.data.images.load(os.path.join(TEX, 'fd_base.jpg'), check_existing=False)
    base.scale(LITE_RES, LITE_RES)
    arr = np.empty(LITE_RES * LITE_RES * 4, np.float32)
    base.pixels.foreach_get(arr)
    arr = arr.reshape(LITE_RES, LITE_RES, 4)            # row 0 = bottom
    emit = np.zeros_like(arr)
    emit[..., 3] = 1
    k = LITE_RES / FL.ATLAS
    boxes = getattr(INT.build_interior, 'lite_boxes', [])
    for (p, cx, cy, w, h, name) in boxes:
        kind = 'pfd' if 'pfd' in name else 'nd' if '_nd' in name else 'cdu' if 'cdu' in name else 'lower' if 'lower' in name else 'eicas' if 'eicas' in name else 'isfd'
        path = os.path.join(TEX, f'fd_screen_{kind}.png')
        if not os.path.exists(path):
            continue
        a = p.px(cx - w / 2, cy + h / 2)
        b = p.px(cx + w / 2, cy - h / 2)
        x0, x1 = int(min(a[0], b[0]) * k), int(math.ceil(max(a[0], b[0]) * k))
        y0, y1 = int(min(a[1], b[1]) * k), int(math.ceil(max(a[1], b[1]) * k))
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        im = bpy.data.images.load(path, check_existing=False)
        im.scale(x1 - x0, y1 - y0)
        px = np.empty((x1 - x0) * (y1 - y0) * 4, np.float32)
        im.pixels.foreach_get(px)
        # the screen images are stored upside down (canvas flipY): blender row 0 (file bottom) = display top
        px = px.reshape(y1 - y0, x1 - x0, 4)
        bpy.data.images.remove(im)
        rows = slice(LITE_RES - y1, LITE_RES - y0)       # blender rows (0 = bottom) of the DU rectangle
        sub = px[::-1]                                    # row 0 = display bottom
        arr[rows, x0:x1, :3] = sub[..., :3] * 0.8
        emit[rows, x0:x1, :3] = sub[..., :3] * 0.6
    base.pixels.foreach_set(arr.ravel())
    import bake_fd
    bake_fd.save_raw(base, os.path.join(TEX, 'fd_lite.jpg'), 'JPEG', 88)
    bpy.data.images.remove(base)
    em = bpy.data.images.new('_lite_emit', LITE_RES, LITE_RES, alpha=False)
    em.pixels.foreach_set(emit.ravel())
    em.scale(512, 512)
    bake_fd.save_raw(em, os.path.join(TEX, 'fd_lite_emit.jpg'), 'JPEG', 88)
    bpy.data.images.remove(em)


def build_lite(shell_src):
    make_texture()
    root = mk.empty('interior_lite', (0, 0, 0))
    L = FL.layout()
    md = MeshData()
    panels(md, L)
    structure(md)
    for s in (-1, 1):
        seat(md, s * 0.53)
        pilot(md, s * 0.53)
    md.v = TB(md.v[:, 0], md.v[:, 1], md.v[:, 2])
    mat = MAT.principled('fd_lite', (0.5, 0.5, 0.5), 0.6, 0.0, base='fd_lite', emission_tex='fd_lite_emit', emission_strength=1.0,
                         double=True)
    o = mk.obj('interior_lite_mesh', md, [mat], smooth=True, sharp_angle=35)
    sh = lite_shell(shell_src)
    sh.data.materials.clear()
    sh.data.materials.append(mat)
    with bpy.context.temp_override(active_object=o, object=o, selected_objects=[o, sh], selected_editable_objects=[o, sh]):
        bpy.ops.object.join()
    o.name = 'interior_lite_mesh'
    o.data.name = 'interior_lite_mesh'
    mk.set_parent(o, root)
    return root, o
