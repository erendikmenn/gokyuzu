"""F-22A cockpit (Blender): detailed interior (root `interior`, cockpit GLB) + light stand-in (`interior_lite`, exterior
GLB).  Layout in cklayout.py; art atlas from textures.py (cockpit_art.png); the build bakes the art together with
ambient occlusion / soft interior light into one unique-UV texture (ckbake.py).

UV layer 'art' maps every face into the art atlas (planar projections for panels, colour patches elsewhere).
"""
import os
import json
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix

import geom as G
from geom import Y, lerp, smoothstep
import oml as O
import cklayout as L

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'assets', 'aircraft', 'f22', 'src'))

EYE_W = Vector((L.EYE[0], Y(L.EYE[1]), L.EYE[2]))


def W(x, s, z):
    return Vector((x, Y(s), z))


def FP(facet, u, w, d=0.0):
    x, s, z = L.facet_point(facet, u, w, d)
    return W(x, s, z)


def FAX(facet):
    ex, ew, en = L.facet_axes(facet)
    f = lambda v: Vector((v[0], -v[1], v[2])).normalized()     # (x, s, z) -> world (x, y, z)
    return f(ex), f(ew), f(en)


# ------------------------------------------------------------------------------------------------ UV helpers
def uv_layer(bm):
    return bm.loops.layers.uv.get('art') or bm.loops.layers.uv.new('art')


def uv_planar(bm, faces, origin, ex, ey, Wm, Hm, region, flip_u=False, flip_v=False):
    """Project faces onto the plane (origin, ex, ey) covering Wm x Hm metres -> atlas region."""
    uv = uv_layer(bm)
    u0, v0, u1, v1 = L.region_uv(region)
    o, ex, ey = Vector(origin), Vector(ex), Vector(ey)
    for f in faces:
        for l in f.loops:
            p = l.vert.co - o
            a = min(1.0, max(0.0, p.dot(ex) / Wm))
            b = min(1.0, max(0.0, p.dot(ey) / Hm))
            if flip_u:
                a = 1 - a
            if flip_v:
                b = 1 - b
            l[uv].uv = (u0 + (u1 - u0) * a, v0 + (v1 - v0) * b)


def uv_patch(bm, faces, name):
    uv = uv_layer(bm)
    u0, v0, u1, v1 = L.region_uv('patch_' + name)
    c = ((u0 + u1) / 2, (v0 + v1) / 2)
    for f in faces:
        for l in f.loops:
            l[uv].uv = c


class Part:
    """Accumulates geometry with 'art' UVs; each add_* call assigns UVs to the newly created faces."""

    def __init__(self):
        self.bm = bmesh.new()
        uv_layer(self.bm)

    def new_faces(self, fn):
        n0 = len(self.bm.faces)
        fn(self.bm)
        self.bm.faces.ensure_lookup_table()
        fs = list(self.bm.faces)[n0:]
        for f in fs:
            f.normal_update()
        return fs

    def patch(self, fn, name):
        fs = self.new_faces(fn)
        uv_patch(self.bm, fs, name)
        return fs


def rbox(bm, center, size, rot=None, bevel=0.0, segs=1, mat=0):
    vs, fs = G.bm_box(bm, center, size, rot=rot, mat=mat)
    if bevel > 0:
        edges = list({e for f in fs for e in f.edges})
        bmesh.ops.bevel(bm, geom=edges + vs, offset=bevel, segments=segs, affect='EDGES', profile=0.5)
    return fs


def frame_rot(ex, ey, ez):
    return Matrix((ex, ey, ez)).transposed()


def facet_box(bm, facet, u, w, su, sw, d0, d1):
    """Box on a facet: centre (u, w), size (su, sw), from d0 to d1 along the facet normal."""
    ex, ew, en = FAX(facet)
    c = FP(facet, u, w, (d0 + d1) / 2)
    return G.bm_box(bm, c, (su, sw, d1 - d0), rot=frame_rot(ex, ew, en))[1]


def art_uv_facet(facet, u, w):
    """Facet coords -> region metres of the facet art (matches textures.facet_uv)."""
    u0, u1, w0, w1 = L.facet_range(facet)
    return ((u1 - u) if facet == 'L' else (u - u0)), (w - w0)


# ================================================================================================ build
def build_cockpit(mats):
    """mats: 'art' (cockpit art material), 'screen', 'hud', 'hudglass', 'sfd'.  Returns dict name -> object; all
    parented to the `interior` empty."""
    P = Part()
    bm = P.bm
    objs = {}

    # ---------------------------------------------------------------- panel facets (slabs)
    reg = {'C': 'pan_C', 'L': 'pan_L', 'R': 'pan_R', 'K': 'pan_K'}
    for facet in 'CLRK':
        u0, u1, w0, w1 = L.facet_range(facet)
        ex, ew, en = FAX(facet)
        fs = P.new_faces(lambda b: facet_box(b, facet, (u0 + u1) / 2, (w0 + w1) / 2, u1 - u0, w1 - w0, -0.05, 0.0))
        front = [f for f in fs if f.normal.dot(en) > 0.9]
        # origin = art (0, 0) corner: pilot's left, bottom
        if facet == 'L':
            org = FP(facet, u1, w0)
            uv_planar(bm, front, org, -ex, ew, u1 - u0, w1 - w0, reg[facet])
        else:
            org = FP(facet, u0, w0)
            uv_planar(bm, front, org, ex, ew, u1 - u0, w1 - w0, reg[facet])
        uv_patch(bm, [f for f in fs if f not in front], 'panel')

    # ---------------------------------------------------------------- display bezels + OSB pads (3-D)
    for name, (facet, u, w, aw, ah) in L.DISPLAYS.items():
        kind = 'pmfd' if 'pmfd' in name else 'ufd' if 'ufd' in name else 'smfd'
        m = L.BEZEL[kind]
        dep = 0.016 if kind != 'ufd' else 0.010
        for (cu, cw, su, sw) in ((u, w + ah / 2 + m / 2, aw + 2 * m, m), (u, w - ah / 2 - m / 2, aw + 2 * m, m),
                                 (u - aw / 2 - m / 2, w, m, ah), (u + aw / 2 + m / 2, w, m, ah)):
            P.patch(lambda b, cu=cu, cw=cw, su=su, sw=sw: facet_box(b, facet, cu, cw, su, sw, 0.0, dep), 'grip')
        if kind == 'ufd':
            continue
        n = L.OSB_N
        for k in range(n):
            t = (k + 0.5) / n - 0.5
            for (cu, cw) in ((u + t * aw * 0.9, w + ah / 2 + m / 2), (u + t * aw * 0.9, w - ah / 2 - m / 2),
                             (u - aw / 2 - m / 2, w + t * ah * 0.9), (u + aw / 2 + m / 2, w + t * ah * 0.9)):
                P.patch(lambda b, cu=cu, cw=cw: facet_box(b, facet, cu, cw, 0.0125, 0.0125, dep, dep + 0.006), 'white')
    # rotary knobs at the MFD bezel corners (white caps, ref: cockpit_ground.jpg)
    for name, (facet, u, w, aw, ah) in L.DISPLAYS.items():
        if 'ufd' in name:
            continue
        m = L.BEZEL['pmfd' if 'pmfd' in name else 'smfd']
        ex, ew, en = FAX(facet)
        for (cu, cw) in ((u - aw / 2 - m / 2, w + ah / 2 + m / 2), (u + aw / 2 + m / 2, w + ah / 2 + m / 2)):
            p0 = FP(facet, cu, cw, 0.016)
            P.patch(lambda b, p0=p0, en=en: G.bm_cylinder(b, p0, p0 + en * 0.014, 0.0085, 0.0075, seg=12), 'white')
    # landing gear handle: lever out of the lower left facet with a wheel-shaped knob (DN position)
    ex, ew, en = FAX('L')
    gb = FP('L', 0.259, 0.10, 0.0)
    gt = gb + en * 0.07 + ew * -0.02
    P.patch(lambda b: G.bm_cylinder(b, gb, gt, 0.007, seg=8), 'chrome')
    P.patch(lambda b: G.bm_torus(b, gt, en, 0.022, 0.008, seg=16, rseg=6), 'white')
    P.patch(lambda b: G.bm_cylinder(b, gt - en * 0.006, gt + en * 0.006, 0.012, seg=12), 'white')
    # SFD bezel
    f, u, w, aw, ah = L.SFD
    for (cu, cw, su, sw) in ((u, w + ah / 2 + 0.006, aw + 0.024, 0.012), (u, w - ah / 2 - 0.006, aw + 0.024, 0.012),
                             (u - aw / 2 - 0.006, w, 0.012, ah), (u + aw / 2 + 0.006, w, 0.012, ah)):
        P.patch(lambda b, cu=cu, cw=cw, su=su, sw=sw: facet_box(b, f, cu, cw, su, sw, 0.0, 0.01), 'grip')

    # ---------------------------------------------------------------- ICP (protruding keypad housing)
    f, u, w, iw, ih, idp = L.ICP
    ex, ew, en = FAX('C')
    fs = P.new_faces(lambda b: facet_box(b, 'C', u, w, iw, ih, 0.0, idp))
    front = [x for x in fs if x.normal.dot(en) > 0.9]
    uv_planar(bm, front, FP('C', u - iw / 2, w - ih / 2, idp), ex, ew, iw, ih, 'icp')
    uv_patch(bm, [x for x in fs if x not in front], 'grip')
    # raised keys (top row + keypad) as small boxes over the art
    kw = 0.0165
    for k in range(9):
        ku = u - iw / 2 + 0.011 + k * (iw - 0.022) / 8
        kwv = w - ih / 2 + ih - 0.016
        _key(P, ku, kwv, kw, idp, u, w, iw, ih)
    for k in range(12):
        ku = u - iw / 2 + 0.018 + (k % 3) * 0.024
        kwv = w - ih / 2 + ih - 0.043 - (k // 3) * 0.022
        _key(P, ku, kwv, kw, idp, u, w, iw, ih)
    # master warning / caution light housings
    for sx in (-1, 1):
        for k in range(2):
            cu = u + sx * 0.118 + (k - 0.5) * 0.026
            cw = w + 0.068
            fs = P.new_faces(lambda b, cu=cu, cw=cw: facet_box(b, 'C', cu, cw, 0.022, 0.016, 0.0, 0.008))
            uv_patch(bm, fs, 'red' if k == 0 else 'amber')

    # ---------------------------------------------------------------- 3-D controls from the art (knobs, toggles)
    ctl = json.load(open(os.path.join(SRC, 'cockpit_controls.json')))
    for (region, cu, cv, kind) in ctl:
        pos = _control_pos(region, cu, cv)
        if pos is None:
            continue
        p, n, xa = pos
        _control(P, p, n, xa, kind)

    # ---------------------------------------------------------------- glareshield (crowned hood, rolled aft lip)
    def glare(b):
        s0, s1 = L.GLARE_S
        ss = np.linspace(s0, s1, 12)
        nx = 16
        rows_t, rows_b = [], []
        for s in ss:
            xh = min(L.GLARE_HALF, O.can_x(s) - 0.035)
            rt, rb = [], []
            for k in range(nx + 1):
                uu = -1 + 2 * k / nx
                zt = L.GLARE_Z + 0.03 * (1 - uu * uu) - 0.02 * smoothstep(s1 - 0.1, s1, s)
                rt.append((uu * xh, Y(s), zt))
                rb.append((uu * xh * 0.985, Y(s), zt - 0.025))
            rows_t.append(rt)
            rows_b.append(rb)
        last = rows_t[-1]
        for (ds, dz) in ((0.012, -0.012), (0.014, -0.032), (0.008, -0.05)):
            rows_t.append([(p[0], p[1] - ds, p[2] + dz) for p in last])
        Gt, Gb = np.array(rows_t), np.array(rows_b)
        G.bm_grid(b, Gt)
        G.bm_grid(b, Gb, flip=True)
    fs = P.new_faces(glare)
    uv_planar(bm, fs, W(-0.5, L.GLARE_S[1], 0), Vector((1, 0, 0)), Vector((0, 1, 0)), 1.0, 0.5, 'glare')
    for f in fs:
        f.normal_update()
    # glareshield cheeks down to the panel wings (close the gap to the walls)
    for sx in (-1, 1):
        fs = P.new_faces(lambda b, sx=sx: G.bm_poly(b, [FP('L' if sx < 0 else 'R', L.WING_W, L.W_TOP, -0.05),
                                                           FP('L' if sx < 0 else 'R', L.WING_W, L.W_BOT_C, -0.05),
                                                           W(sx * (O.can_x(3.95) - 0.03), 3.97, 0.15),
                                                           W(sx * (O.can_x(3.80) - 0.03), 3.80, L.GLARE_Z - 0.03)]))
        uv_patch(bm, fs, 'panel')

    # ---------------------------------------------------------------- HUD housing + combiner frame
    s0, s1, hw = L.HUD_BOX
    fs = P.new_faces(lambda b: rbox(b, W(0, (s0 + s1) / 2, L.GLARE_Z + 0.02), (hw, s1 - s0, 0.06), bevel=0.01, segs=2))
    uv_patch(bm, fs, 'black')
    hb, ht = W(0, *L.HUD_B), W(0, *L.HUD_T)
    hup = (ht - hb).normalized()
    hx = Vector((1, 0, 0))
    hn = hx.cross(hup).normalized()
    fs = P.new_faces(lambda b: rbox(b, hb - hup * 0.008 + hn * 0.0, (L.HUD_W + 0.03, 0.035, 0.03),
                                    rot=frame_rot(hx, hn, hup), bevel=0.006))
    uv_patch(bm, fs, 'black')

    def hud_frame(b):
        # side posts + top arch (ref: cockpit_lit.jpg arch over the combiner)
        pts = []
        n = 14
        for k in range(n + 1):
            a = math.pi * k / n
            pts.append(hb + hx * (-math.cos(a) * (L.HUD_W / 2 + 0.01)) + hup * ((ht - hb).length * (0.62 + 0.40 * math.sin(a))))
        pts = [hb - hx * (L.HUD_W / 2 + 0.01) + hup * 0.02] + pts + [hb + hx * (L.HUD_W / 2 + 0.01) + hup * 0.02]
        for a, c in zip(pts[:-1], pts[1:]):
            G.bm_cylinder(b, a, c, 0.0065, seg=8, cap0=False, cap1=False)
    fs = P.new_faces(hud_frame)
    uv_patch(bm, fs, 'grip')

    # ---------------------------------------------------------------- forward deck (under the front canopy)
    def deck(b):
        ss = np.linspace(O.S_CAN0 + 0.03, L.GLARE_S[0] + 0.02, 14)
        rows = []
        for s in ss:
            xs = O.can_x(s) - 0.01
            zs = O.can_zs(s)
            t = smoothstep(O.S_CAN0, L.GLARE_S[0], s)
            zc = lerp(zs + 0.02, L.GLARE_Z - 0.005, t ** 0.8)
            row = []
            for k in range(9):
                uu = -1 + 2 * k / 8
                row.append((uu * xs, Y(s), lerp(zc, zs, abs(uu) ** 3)))
            rows.append(row)
        G.bm_grid(b, np.array(rows))
    fs = P.new_faces(deck)
    uv_planar(bm, fs, W(-0.6, L.GLARE_S[0], 0), Vector((1, 0, 0)), Vector((0, 1, 0)), 1.2, 1.1, 'deck')

    # ---------------------------------------------------------------- tub side walls (sill -> console / floor)
    for sx, rg in ((-1, 'wall_L'), (1, 'wall_R')):
        def walls(b, sx=sx):
            ss = np.linspace(3.45, L.BULKHEAD_S + 0.05, 30)
            rows = []
            for s in ss:
                xw = O.can_x(min(max(s, O.S_CAN0 + 0.1), O.S_CAN1 - 0.1)) - 0.03
                zt = O.can_zs(s) - 0.01
                zb = L.CON_Z if L.CON_S[0] - 0.05 < s < L.CON_S[1] + 0.05 else L.FLOOR_Z
                rows.append([(sx * xw, Y(s), zb), (sx * xw, Y(s), lerp(zb, zt, 0.6)), (sx * (xw + 0.005), Y(s), zt)])
            G.bm_grid(b, np.array(rows), flip=(sx > 0))
        fs = P.new_faces(walls)
        o = W(sx * 0.6, 3.45, L.CON_Z - 0.02)
        uv_planar(bm, fs, o, Vector((0, -1, 0)), Vector((0, 0, 1)), 1.76, 0.40, rg, flip_u=(sx > 0))

    # ---------------------------------------------------------------- consoles
    for sx, rg in ((-1, 'lcon'), (1, 'rcon')):
        x0, x1 = L.CON_X
        c0, c1 = L.CON_S
        fs = P.new_faces(lambda b, sx=sx: G.bm_box(b, W(sx * (x0 + x1) / 2, (c0 + c1) / 2, (L.CON_Z + L.FLOOR_Z) / 2),
                                                   (x1 - x0, c1 - c0, L.CON_Z - L.FLOOR_Z))[1])
        top = [f for f in fs if f.normal.z > 0.9]
        # region: u along s (front -> back), v across from the inboard edge outward
        uv_planar(bm, top, W(sx * x0, c0, L.CON_Z), Vector((0, -1, 0)), Vector((sx, 0, 0)), c1 - c0, x1 - x0, rg)
        uv_patch(bm, [f for f in fs if f not in top], 'panel')
        fs = P.new_faces(lambda b, sx=sx: G.bm_poly(b, [W(sx * x0, c0, L.CON_Z), W(sx * x1, c0, L.CON_Z),
                                                         W(sx * x1, c0 - 0.40, L.FLOOR_Z), W(sx * x0, c0 - 0.40, L.FLOOR_Z)]))
        uv_patch(bm, fs, 'panel')
    # throttle slot rails
    for dx in (-0.024, 0.024):
        fs = P.new_faces(lambda b, dx=dx: G.bm_box(b, W(L.THROTTLE[0] + dx, sum(L.THR_SLOT_S) / 2, L.CON_Z + 0.006),
                                                    (0.008, L.THR_SLOT_S[1] - L.THR_SLOT_S[0], 0.012))[1])
        uv_patch(bm, fs, 'metal')

    # ---------------------------------------------------------------- floor, pedals, bulkhead, rear deck
    fs = P.new_faces(lambda b: G.bm_box(b, W(0, 4.30, L.FLOOR_Z - 0.01), (1.0, 2.0, 0.02))[1])
    uv_planar(bm, fs, W(-0.5, 5.3, 0), Vector((1, 0, 0)), Vector((0, 1, 0)), 1.0, 2.0, 'floor')
    for sx in (-1, 1):
        fs = P.new_faces(lambda b, sx=sx: rbox(b, W(sx * 0.16, 3.46, -0.20), (0.10, 0.03, 0.20),
                                               rot=Matrix.Rotation(math.radians(-22), 3, 'X'), bevel=0.008))
        uv_patch(bm, fs, 'metal')
        fs = P.new_faces(lambda b, sx=sx: G.bm_cylinder(b, W(sx * 0.16, 3.40, -0.12), W(sx * 0.16, 3.30, 0.05), 0.014, seg=8))
        uv_patch(bm, fs, 'metal')
    fs = P.new_faces(lambda b: G.bm_box(b, W(0, 3.36, -0.12), (0.80, 0.03, 0.60))[1])      # footwell front wall
    uv_patch(bm, fs, 'wall')

    def bulk(b):
        xh = O.can_x(L.BULKHEAD_S) - 0.03
        G.bm_box(b, W(0, L.BULKHEAD_S, (O.can_zs(L.BULKHEAD_S) + L.FLOOR_Z) / 2),
                 (2 * xh, 0.03, O.can_zs(L.BULKHEAD_S) - L.FLOOR_Z))
    fs = P.new_faces(bulk)
    uv_planar(bm, fs, W(-0.6, L.BULKHEAD_S, L.FLOOR_Z), Vector((1, 0, 0)), Vector((0, 0, 1)), 1.2, 1.3, 'bulk')

    # ---------------------------------------------------------------- canopy sill rails + canopy switch panel
    def rails(b):
        for sign in (1, -1):
            pts = [W(sign * (O.can_x(s) - 0.025), s, O.can_zs(s) - 0.018) for s in np.linspace(O.S_CAN0 + 0.35, O.S_CAN1 - 0.25, 26)]
            for a, c in zip(pts[:-1], pts[1:]):
                G.bm_cylinder(b, a, c, 0.016, seg=8, cap0=False, cap1=False)
    fs = P.new_faces(rails)
    uv_patch(bm, fs, 'metal')
    s_cs = 4.95
    xw = O.can_x(s_cs) - 0.035
    zc = O.can_zs(s_cs) - 0.08
    fs = P.new_faces(lambda b: G.bm_box(b, W(xw - 0.012, s_cs, zc), (0.024, 0.10, 0.10))[1])
    inner = [f for f in fs if f.normal.x < -0.9]
    uv_planar(bm, inner, W(xw - 0.024, s_cs - 0.05, zc - 0.05), Vector((0, -1, 0)), Vector((0, 0, 1)), 0.10, 0.10,
              'canopy_sw')
    uv_patch(bm, [f for f in fs if f not in inner], 'black')

    # ---------------------------------------------------------------- ACES II seat
    _seat(P)

    # ---------------------------------------------------------------- finish the static shell
    G.weld(bm, 1e-6)
    for f in bm.faces:
        f.normal_update()
    G.smooth_sharp(bm, 35)
    objs['cockpit_shell'] = G.new_object('cockpit_shell', bm, [mats['art']])

    # ---------------------------------------------------------------- side stick (pivot at its base, local X lateral)
    sp = W(L.STICK[0], L.STICK[1], L.STICK[2])
    S2 = Part()
    rot = Matrix.Rotation(math.radians(12), 3, 'X') @ Matrix.Rotation(math.radians(-8), 3, 'Y')

    def stick(b):
        G.bm_cylinder(b, sp, sp + Vector((0, 0, 0.03)), 0.045, 0.034, seg=18)                   # boot
        G.bm_cylinder(b, sp + Vector((0, 0, 0.028)), sp + Vector((0, 0.01, 0.07)), 0.014, seg=12)
        g0 = sp + Vector((0, 0.012, 0.065))
        for (h, w, dp) in ((0.0, 0.038, 0.046), (0.03, 0.042, 0.052), (0.06, 0.044, 0.054), (0.09, 0.042, 0.05),
                           (0.115, 0.038, 0.046)):
            rbox(b, g0 + rot @ Vector((0, 0, h + 0.015)), (w, dp, 0.034), rot=rot, bevel=0.012, segs=2)
        rbox(b, g0 + rot @ Vector((0.0, -0.004, 0.148)), (0.04, 0.05, 0.026), rot=rot, bevel=0.01, segs=2)
        rbox(b, g0 + rot @ Vector((0, 0.032, 0.105)), (0.016, 0.014, 0.032), rot=rot, bevel=0.005)
    S2.patch(stick, 'grip')
    S2.patch(lambda b: rbox(b, g0_head(sp, rot), (0.012, 0.012, 0.012), rot=rot, bevel=0.003), 'metal')
    objs['cockpit_stick'] = G.pivot_object('cockpit_stick', S2.bm, sp, (1, 0, 0), (0, 0, 1), materials=[mats['art']])

    # ---------------------------------------------------------------- throttles (two levers, joined grip)
    tp = W(L.THROTTLE[0], L.THROTTLE[1], L.CON_Z - 0.10)
    T2 = Part()
    trot = Matrix.Rotation(math.radians(-10), 3, 'X')

    def throttle(b):
        for dx in (-0.018, 0.018):
            G.bm_cylinder(b, tp + Vector((dx, 0, 0)), tp + Vector((dx, 0.0, 0.19)), 0.009, seg=8)
        base = tp + Vector((0, 0.0, 0.215))
        rbox(b, base, (0.08, 0.07, 0.05), rot=trot, bevel=0.016, segs=2)
        rbox(b, base + trot @ Vector((0, -0.005, 0.045)), (0.076, 0.075, 0.045), rot=trot, bevel=0.018, segs=3)
        rbox(b, base + trot @ Vector((0.04, 0.01, 0.05)), (0.012, 0.05, 0.03), rot=trot, bevel=0.005)
        rbox(b, base + trot @ Vector((0.0, 0.04, 0.03)), (0.05, 0.012, 0.02), rot=trot, bevel=0.004)
    T2.patch(throttle, 'grip')
    objs['cockpit_throttle'] = G.pivot_object('cockpit_throttle', T2.bm, tp, (1, 0, 0), (0, 0, 1), materials=[mats['art']])

    # ---------------------------------------------------------------- screens (UV 0..1, u left->right, v up)
    for name, (facet, u, w, aw, ah) in L.DISPLAYS.items():
        objs[name] = _quad(name, facet, u, w, aw, ah, 0.003, mats['screen'])
    f, u, w, aw, ah = L.SFD
    objs['sfd_display'] = _quad('sfd_display', f, u, w, aw, ah, 0.003, mats['sfd'])
    # HUD combiner glass + symbology plane
    for name, off, mt in (('hud_glass', -0.002, mats['hudglass']), ('screen_hud', 0.002, mats['hud'])):
        b = bmesh.new()
        uv = b.loops.layers.uv.verify()
        c = [hb - hx * L.HUD_W / 2 + hn * off, hb + hx * L.HUD_W / 2 + hn * off,
             ht + hx * L.HUD_W / 2 + hn * off, ht - hx * L.HUD_W / 2 + hn * off]
        f_ = G.bm_poly(b, c)
        if f_.normal.dot(Vector((0, -1, 0))) < 0:
            f_.normal_flip()
        for l in f_.loops:
            p = l.vert.co
            l[uv].uv = ((p.x + L.HUD_W / 2) / L.HUD_W, (p - hb).dot(hup) / (ht - hb).length)
        objs[name] = G.new_object(name, b, [mt])

    interior = G.empty('interior', (0, 0, 0), size=0.5)
    for ob in objs.values():
        G.set_parent(ob, interior)
    objs['interior'] = interior
    return objs


def g0_head(sp, rot):
    return sp + Vector((0, 0.012, 0.065)) + rot @ Vector((-0.012, 0.012, 0.158))


def _key(P, ku, kw_, size, idp, u, w, iw, ih):
    """Raised ICP key; its top face shows the legend from the ICP art."""
    fs = P.new_faces(lambda b: facet_box(b, 'C', ku, kw_, size * 0.95, size * 0.95, idp, idp + 0.004))
    ex, ew, en = FAX('C')
    top = [f for f in fs if f.normal.dot(en) > 0.9]
    uv_planar(P.bm, top, FP('C', u - iw / 2, w - ih / 2, idp), ex, ew, iw, ih, 'icp')
    uv_patch(P.bm, [f for f in fs if f not in top], 'white')


def _quad(name, facet, u, w, aw, ah, d, mat):
    b = bmesh.new()
    uv = b.loops.layers.uv.verify()
    if facet == 'L':
        c = [FP(facet, u + aw / 2, w - ah / 2, d), FP(facet, u - aw / 2, w - ah / 2, d), FP(facet, u - aw / 2, w + ah / 2, d),
             FP(facet, u + aw / 2, w + ah / 2, d)]
    else:
        c = [FP(facet, u - aw / 2, w - ah / 2, d), FP(facet, u + aw / 2, w - ah / 2, d), FP(facet, u + aw / 2, w + ah / 2, d),
             FP(facet, u - aw / 2, w + ah / 2, d)]
    f = G.bm_poly(b, c)
    for l, t in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        l[uv].uv = t
    ex, ew, en = FAX(facet)
    if f.normal.dot(en) < 0:
        f.normal_flip()
        # keep UV corners with their vertices (normal_flip reverses the loop order only)
    return G.new_object(name, b, [mat])


def _control_pos(region, cu, cv):
    """Art-region metres -> (world point, surface normal, lateral axis) for 3-D knobs/toggles."""
    if region.startswith('pan_'):
        facet = region[4]
        u0, u1, w0, w1 = L.facet_range(facet)
        u = (u1 - cu) if facet == 'L' else (u0 + cu)
        w = w0 + cv
        ex, ew, en = FAX(facet)
        return FP(facet, u, w, 0.0), en, ex
    if region in ('lcon', 'rcon'):
        sx = -1 if region == 'lcon' else 1
        s = L.CON_S[0] + cu
        x = sx * (L.CON_X[0] + cv)
        return W(x, s, L.CON_Z), Vector((0, 0, 1)), Vector((1, 0, 0))
    return None


def _control(P, p, n, xa, kind):
    n = Vector(n).normalized()
    if kind.startswith('knob'):
        r = 0.011 if kind == 'knob' else 0.0065
        P.patch(lambda b: G.bm_cylinder(b, p, p + n * 0.014, r, r * 0.88, seg=14), 'grip')
        P.patch(lambda b: G.bm_cylinder(b, p + n * 0.014, p + n * 0.017, r * 0.5, seg=8), 'metal')
    elif kind.startswith('toggle'):
        P.patch(lambda b: G.bm_cylinder(b, p, p + n * 0.006, 0.0075, seg=10), 'metal')
        yv = n.cross(xa).normalized()
        P.patch(lambda b: G.bm_cylinder(b, p + n * 0.005, p + n * 0.022 + yv * 0.005, 0.0021, seg=6), 'chrome')
        P.patch(lambda b: G.bm_cylinder(b, p + n * 0.022 + yv * 0.005, p + n * 0.026 + yv * 0.006, 0.0035, seg=6), 'chrome')
    else:
        P.patch(lambda b: G.bm_box(b, p + n * 0.003, (0.022, 0.014, 0.006),
                                   rot=frame_rot(xa, n.cross(xa).normalized(), n))[1], 'grip')


def _seat(P):
    bm = P.bm
    rec = L.SEAT_RECLINE
    back = Vector((0, -math.sin(rec), math.cos(rec)))        # up along the seat back (world)
    bn = Vector((0, math.cos(rec), math.sin(rec)))           # seat back front normal (towards the nose)
    rotB = frame_rot(Vector((1, 0, 0)), bn, back)
    sb0 = W(0, L.SEAT_BASE[0], L.SEAT_BASE[1])

    def SB(h, d=0.0, x=0.0):
        return sb0 + back * h + bn * d + Vector((x, 0, 0))
    sh = L.SEAT_HALF

    def metal(b):
        for sx in (-1, 1):
            poly = [(4.20, -0.20), (4.20, 0.17), (4.24, 0.22), (4.52, 0.25), (4.80, 0.40), (4.84, 0.36), (4.84, -0.20)]
            G.bm_extrude_polygon(b, [(Y(s), z) for (s, z) in poly], (sx * sh - 0.017, 0, 0), (0, 1, 0), (0, 0, 1), 0.034)
        rbox(b, W(0, 4.22, -0.02), (2 * sh - 0.03, 0.035, 0.34), bevel=0.01)
        rbox(b, W(0, 4.45, -0.12), (2 * sh - 0.04, 0.50, 0.16), bevel=0.02, segs=2)
        rbox(b, W(0, 4.44, 0.01), (2 * sh - 0.07, 0.46, 0.05), bevel=0.012)
        rbox(b, SB(0.45, -0.07), (2 * sh - 0.04, 0.06, 0.95), rot=rotB, bevel=0.015)
        for sx in (-1, 1):
            rbox(b, SB(0.55, -0.13, sx * 0.165), (0.045, 0.05, 1.24), rot=rotB, bevel=0.008)
        G.bm_cylinder(b, SB(-0.1, -0.12), SB(0.95, -0.12), 0.035, seg=12)
        rbox(b, SB(0.84, 0.02), (0.18, 0.05, 0.05), rot=rotB, bevel=0.01)
        G.bm_cylinder(b, W(-0.27, 4.80, -0.12), W(-0.27, 4.80, 0.22), 0.035, seg=12)
    P.patch(metal, 'seatgreen')

    def headbox(b):
        rbox(b, SB(0.93, -0.05), (0.38, 0.20, 0.16), rot=rotB, bevel=0.03, segs=3)
        rbox(b, SB(1.04, -0.06), (0.41, 0.22, 0.13), rot=rotB, bevel=0.035, segs=3)
    fs = P.new_faces(headbox)
    uv_planar(bm, fs, SB(0.84, 0.1, -0.21), Vector((1, 0, 0)), back, 0.42, 0.42, 'headbox')
    P.patch(lambda b: [G.bm_cylinder(b, SB(1.09, 0.02, sx * 0.12), SB(1.12, 0.02, sx * 0.12), 0.012, 0.004, seg=8)
                       for sx in (-1, 1)], 'metal')

    def fabric(b):
        rbox(b, W(0, 4.44, 0.075), (2 * sh - 0.08, 0.44, 0.085), bevel=0.03, segs=3)
        rbox(b, SB(0.20, 0.0), (2 * sh - 0.10, 0.075, 0.30), rot=rotB, bevel=0.03, segs=3)
        rbox(b, SB(0.55, -0.005), (2 * sh - 0.12, 0.06, 0.42), rot=rotB, bevel=0.03, segs=3)
        rbox(b, SB(0.92, 0.07), (0.26, 0.065, 0.18), rot=rotB, bevel=0.025, segs=3)
        for sx in (-1, 1):
            rbox(b, SB(0.52, 0.045, sx * 0.085), (0.048, 0.01, 0.66), rot=rotB, bevel=0.003)
            rbox(b, W(sx * 0.13, 4.52, 0.127), (0.05, 0.28, 0.01), bevel=0.003)
    fs = P.new_faces(fabric)
    uv_planar(bm, fs, W(-0.25, 4.7, 0), Vector((1, 0, 0)), Vector((0, -0.3, 0.95)).normalized(), 0.5, 0.5, 'seat')
    # ejection handle: yellow/black D-ring on the seat front, between the knees
    fs = P.new_faces(lambda b: G.bm_torus(b, W(0, 4.19, 0.015), (1, 0, 0), 0.05, 0.011, seg=18, rseg=6))
    uv_planar(bm, fs, W(-0.06, 4.19, -0.045), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.12, 0.12, 'stripe')
    P.patch(lambda b: [rbox(b, W(sx * sh, 4.46, 0.26), (0.05, 0.30, 0.02), bevel=0.006) for sx in (-1, 1)], 'rubber')
