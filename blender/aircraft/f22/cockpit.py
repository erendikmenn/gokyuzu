"""F-22A cockpit interior: tub, glass-cockpit instrument panel (PMFD, SMFDs, UFDs, ICP), wide-angle HUD,
side consoles with right-hand side-stick and left throttles, ACES II seat, pedals, sill rails.

Everything is parented to the `interior` empty. Screen meshes (`screen_*`) are single-material quads with UVs 0..1
(u left->right, v bottom->top as seen by the pilot)."""
import os
import json
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix

import geom as G
from geom import lerp
import shape as S

# The cockpit is authored in its own station frame; it sits DS metres forward of that frame and DZ lower
# (fitted under the canopy of the USAF 3-view).  Y() maps cockpit stations to world y.
DS = 0.35
DZ = -0.10


def Y(s):
    return G.Y(s - DS)


def can_x(c):
    return S.can_x(c - DS)


def can_zs(c):
    return S.can_zs(c - DS)

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'assets', 'aircraft', 'f22', 'src'))

EYE = (0.0, 4.80, 0.90)      # (x, s, z) in cockpit coordinates
EYE_REAL = (0.0, 4.80 - DS, 0.90 + DZ)   # world station / height

# instrument panel frame
PAN_O = Vector((0.0, Y(4.18), -0.10))
PAN_EX = Vector((1, 0, 0))
PAN_EW = Vector((0, 0.20, 0.62)).normalized()
PAN_N = PAN_EX.cross(PAN_EW).normalized()        # towards the pilot
PAN_L = math.hypot(0.20, 0.62)
PAN_U = 0.45


def PP(u, w, d=0.0):
    return PAN_O + PAN_EX * u + PAN_EW * w + PAN_N * d


PAN_ROT = Matrix((PAN_EX, PAN_EW, PAN_N)).transposed()

SCREENS = {    # name: (u, w, width, height)
    'screen_pmfd': (0.0, 0.40, 0.203, 0.203),
    'screen_smfd_L': (-0.245, 0.37, 0.159, 0.159),
    'screen_smfd_R': (0.245, 0.37, 0.159, 0.159),
    'screen_smfd_C': (0.0, 0.14, 0.159, 0.159),
    'screen_ufd_L': (-0.163, 0.598, 0.102, 0.076),
    'screen_ufd_R': (0.163, 0.598, 0.102, 0.076),
}


class UV:
    def __init__(self):
        with open(os.path.join(SRC, 'cockpit_regions.json')) as f:
            self.R = json.load(f)

    def rect(self, name):
        return self.R[name]

    def planar(self, bm, faces, origin, ex, ey, W, H, rect, flip_u=False):
        uv = bm.loops.layers.uv.verify()
        u0, v0, u1, v1 = self.R[rect] if isinstance(rect, str) else rect
        o, ex, ey = Vector(origin), Vector(ex), Vector(ey)
        for f in faces:
            for l in f.loops:
                p = l.vert.co - o
                a = p.dot(ex) / W
                b = p.dot(ey) / H
                if flip_u:
                    a = 1 - a
                a = min(1, max(0, a))
                b = min(1, max(0, b))
                l[uv].uv = (u0 + (u1 - u0) * a, v0 + (v1 - v0) * b)

    def patch(self, bm, faces, name):
        uv = bm.loops.layers.uv.verify()
        u0, v0, u1, v1 = self.R['patch_' + name]
        c = ((u0 + u1) / 2, (v0 + v1) / 2)
        for f in faces:
            for l in f.loops:
                l[uv].uv = c


def part(uvh, fill_fn, patch=None):
    """Create a temp bmesh, let fill_fn(bm) add geometry, assign a colour patch to all faces."""
    bm = bmesh.new()
    bm.loops.layers.uv.verify()
    fill_fn(bm)
    if patch:
        uvh.patch(bm, list(bm.faces), patch)
    return bm


def obox(bm, center, axes, size, mat=0):
    R = Matrix((Vector(axes[0]), Vector(axes[1]), Vector(axes[2]))).transposed()
    vs, fs = G.bm_box(bm, center, size, rot=R, mat=mat)
    return fs


def rbox(bm, center, size, rot=None, bevel=0.01, segs=2, mat=0):
    """Box with bevelled edges."""
    vs, fs = G.bm_box(bm, center, size, rot=rot, mat=mat)
    edges = list({e for f in fs for e in f.edges})
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=edges + vs, offset=bevel, segments=segs, affect='EDGES', profile=0.5)
    return fs


def build_cockpit(mats):
    """mats: dict with 'atlas', 'screen', 'hudglass'. Returns dict of objects."""
    uvh = UV()
    objs = {}
    main = bmesh.new()
    main.loops.layers.uv.verify()

    def add(bm):
        G.join_bm(main, bm)

    # ------------------------------------------------------------------ tub: floor, footwell, side walls, bulkhead
    def floor(bm):
        G.bm_box(bm, (0, Y(4.45), -0.335), (0.9, 1.9, 0.03))
        G.bm_box(bm, (0, Y(3.56), 0.08), (0.8, 0.03, 0.8))           # footwell front wall
    add(part(uvh, floor, 'black'))

    def walls(bm):
        ss = np.linspace(3.30, 5.60, 24)
        for sign in (1, -1):
            rows = []
            for s in ss:
                xw = max(0.30, can_x(min(max(s, (S.S_CAN0 + DS) + 0.05), (S.S_CAN1 + DS) - 0.05)) - 0.012)
                zt = can_zs(s) - 0.005 - DZ
                rows.append([(sign * min(xw, 0.49), Y(s), -0.33), (sign * min(xw, 0.49), Y(s), zt - 0.12),
                             (sign * (xw + 0.004), Y(s), zt)])
            Gw = np.array(rows)
            G.bm_grid(bm, Gw, flip=(sign > 0))
    bm = part(uvh, walls)
    # side-wall panel art: u along s (3.30 .. 5.60), v up (console top .. sill)
    uvl = bm.loops.layers.uv.verify()
    u0, v0, u1, v1 = uvh.rect('side')
    for f in bm.faces:
        for l in f.loops:
            p = l.vert.co
            s_ = Y(0) - p.y
            a = min(1, max(0, (s_ - 3.30) / 2.30))
            b = min(1, max(0, (p.z - 0.10) / 0.40))
            if p.x < 0:
                a = 1 - a
            l[uvl].uv = (u0 + (u1 - u0) * a, v0 + (v1 - v0) * b)
    add(bm)

    def bulkhead(bm):
        xh = can_x(5.40) - 0.02
        G.bm_box(bm, (0, Y(5.40), 0.19), (2 * xh, 0.03, 1.05))
        # deck bridging to the turtle deck behind
        xd = can_x(5.52) - 0.02
        G.bm_box(bm, (0, Y(5.52), 0.705 - DZ), (2 * xd, 0.26, 0.02))
    add(part(uvh, bulkhead, 'wall'))

    # ------------------------------------------------------------------ side consoles
    for sign, reg in ((-1, 'lcon'), (1, 'rcon')):
        def console(bm, sign=sign, reg=reg):
            x0, x1 = 0.285, 0.48
            s0, s1 = 4.20, 5.40
            top = 0.215
            vs, fs = G.bm_box(bm, (sign * (x0 + x1) / 2, Y((s0 + s1) / 2), (top - 0.33) / 2),
                              (x1 - x0, s1 - s0, top + 0.33))
            topf = [f for f in fs if f.normal.z > 0.9]
            others = [f for f in fs if f not in topf]
            # top face: u along s (front -> back), v across (outer wall -> inboard)
            if sign < 0:
                uvh.planar(bm, topf, (-x1, Y(s0), top), (0, -1, 0), (1, 0, 0), s1 - s0, x1 - x0, reg)
            else:
                uvh.planar(bm, topf, (x1, Y(s0), top), (0, -1, 0), (-1, 0, 0), s1 - s0, x1 - x0, reg)
            uvh.patch(bm, others, 'panel')
            # sloped front fairing down to the floor
            fr = [(sign * x0, Y(s0), top), (sign * x1, Y(s0), top), (sign * x1, Y(s0 - 0.35), -0.33),
                  (sign * x0, Y(s0 - 0.35), -0.33)]
            f = G.bm_poly(bm, fr)
            if f:
                uvh.patch(bm, [f], 'panel')
        add(part(uvh, console))

    # 3-D controls on the console tops at the positions drawn in the atlas
    def controls(bm):
        x0, x1, s0, s1, top = 0.285, 0.48, 4.20, 5.40, 0.215
        for (reg, u, v, kind) in uvh.R.get('controls', []):
            s_ = s0 + u * (s1 - s0)
            if reg == 'lcon':
                x = -x1 + v * (x1 - x0)
            else:
                x = x1 - v * (x1 - x0)
            p = Vector((x, Y(s_), top))
            if reg == 'rcon' and (p - Vector((0.375, Y(4.60), top))).length < 0.07:
                continue
            if reg == 'lcon' and 4.36 < s_ < 4.76 and -0.42 < x < -0.34:
                continue
            if kind == 'knob':
                G.bm_cylinder(bm, p, p + Vector((0, 0, 0.018)), 0.011, 0.0095, seg=12)
                G.bm_box(bm, p + Vector((0, 0, 0.019)), (0.004, 0.016, 0.003))
            elif kind == 'toggle':
                G.bm_cylinder(bm, p, p + Vector((0, 0, 0.006)), 0.0075, seg=10)
                G.bm_cylinder(bm, p + Vector((0, 0, 0.005)), p + Vector((0, 0.006, 0.024)), 0.0022, seg=6)
                G.bm_cylinder(bm, p + Vector((0, 0.006, 0.024)), p + Vector((0, 0.007, 0.028)), 0.0035, seg=6)
            else:
                G.bm_box(bm, p + Vector((0, 0, 0.004)), (0.02, 0.013, 0.008))
    add(part(uvh, controls, 'metal'))
    # throttle quadrant rails
    def quadrant(bm):
        for dx in (-0.034, 0.034):
            G.bm_box(bm, (-0.382 + dx, Y(4.56), 0.226), (0.012, 0.40, 0.022))
        G.bm_box(bm, (-0.382, Y(4.56), 0.216), (0.06, 0.40, 0.004))
    add(part(uvh, quadrant, 'black'))

    # ------------------------------------------------------------------ instrument panel
    def panel(bm):
        # slab: pedestal + two wings
        pieces = [(-0.14, 0.14, 0.0, PAN_L), (-PAN_U, -0.14, 0.20, PAN_L), (0.14, PAN_U, 0.20, PAN_L)]
        for (u0, u1, w0, w1) in pieces:
            c = PP((u0 + u1) / 2, (w0 + w1) / 2, -0.02)
            fs = obox(bm, c, (PAN_EX, PAN_EW, PAN_N), (u1 - u0, w1 - w0, 0.04))
            front = [f for f in fs if f.normal.dot(PAN_N) > 0.9]
            uvh.planar(bm, front, PP(-PAN_U, 0, 0), PAN_EX, PAN_EW, 2 * PAN_U, PAN_L, 'panel')
            uvh.patch(bm, [f for f in fs if f not in front], 'panel')
    add(part(uvh, panel))

    # bezels with push buttons around each display
    def bezels(bm):
        for name, (u, w, W, H) in SCREENS.items():
            m = 0.028 if 'ufd' not in name else 0.016
            d = 0.024
            for (cu, cw, su, sw) in ((u, w + H / 2 + m / 2, W + 2 * m, m), (u, w - H / 2 - m / 2, W + 2 * m, m),
                                     (u - W / 2 - m / 2, w, m, H), (u + W / 2 + m / 2, w, m, H)):
                obox(bm, PP(cu, cw, d / 2), (PAN_EX, PAN_EW, PAN_N), (su, sw, d))
            if 'ufd' in name:
                continue
            nb = 5
            for k in range(nb):
                t = (k + 0.5) / nb - 0.5
                for (cu, cw, su, sw) in ((u + t * W * 0.9, w + H / 2 + m / 2, W / nb * 0.6, m * 0.55),
                                         (u + t * W * 0.9, w - H / 2 - m / 2, W / nb * 0.6, m * 0.55),
                                         (u - W / 2 - m / 2, w + t * H * 0.9, m * 0.55, H / nb * 0.6),
                                         (u + W / 2 + m / 2, w + t * H * 0.9, m * 0.55, H / nb * 0.6)):
                    obox(bm, PP(cu, cw, d + 0.004), (PAN_EX, PAN_EW, PAN_N), (su, sw, 0.008))
        # recess behind each screen (dark glass surround)
    add(part(uvh, bezels, 'grip'))

    # ICP keypad
    def icp(bm):
        fs = obox(bm, PP(0, 0.598, 0.018), (PAN_EX, PAN_EW, PAN_N), (0.15, 0.078, 0.036))
        front = [f for f in fs if f.normal.dot(PAN_N) > 0.9]
        uvh.planar(bm, front, PP(-0.075, 0.598 - 0.039, 0.036), PAN_EX, PAN_EW, 0.15, 0.078, 'icp')
        uvh.patch(bm, [f for f in fs if f not in front], 'grip')
    add(part(uvh, icp))

    # landing gear handle (left of the panel) + standby display bezel
    def gear_handle(bm):
        base = PP(-0.36, 0.27, 0.0)
        G.bm_box(bm, base + PAN_N * 0.03, (0.03, 0.03, 0.06), rot=PAN_ROT)
        G.bm_cylinder(bm, base + PAN_N * 0.06 + PAN_EX * -0.02, base + PAN_N * 0.06 + PAN_EX * 0.02, 0.022, seg=12)
    add(part(uvh, gear_handle, 'white'))

    def isfd(bm):
        obox(bm, PP(-0.33, 0.07, 0.015), (PAN_EX, PAN_EW, PAN_N), (0.085, 0.085, 0.03))
    add(part(uvh, isfd, 'grip'))

    # glare shield: crowned hood, narrower forward, rolled aft lip over the panel top
    def glare(bm):
        ss = np.linspace(3.50, 3.995, 12)
        nx = 12
        rows_t, rows_b = [], []
        for s in ss:
            t = (s - 3.50) / 0.495
            xh = min(lerp(0.29, 0.43, t ** 0.8), can_x(max(s, (S.S_CAN0 + DS) + 0.08)) - 0.03)
            z0 = lerp(0.545, 0.525, t)
            crown = 0.035
            rt, rb = [], []
            for k in range(nx + 1):
                u = -1 + 2 * k / nx
                zt = z0 + crown * (1 - u * u)
                rt.append((u * xh, Y(s), zt))
                rb.append((u * xh * 0.97, Y(s), zt - 0.03))
            rows_t.append(rt)
            rows_b.append(rb)
        # rolled lip: extra rows curling down to the panel top
        last = rows_t[-1]
        for (ds, dz, sc) in ((0.012, -0.008, 1.0), (0.018, -0.024, 0.995), (0.014, -0.042, 0.99)):
            rows_t.append([(p[0] * sc, p[1] - ds, p[2] + dz) for p in last])
        Gt, Gb = np.array(rows_t), np.array(rows_b)
        G.bm_grid(bm, Gt)
        G.bm_grid(bm, Gb, flip=True)
        G.bm_grid(bm, np.stack([Gt[:len(ss), 0], Gb[:, 0]]), flip=True)
        G.bm_grid(bm, np.stack([Gt[:len(ss), -1], Gb[:, -1]]))
        for f in bm.faces:
            f.normal_update()
    add(part(uvh, glare, 'black'))

    # HUD: projector body on the glare shield + combiner frame (combiner centred ~5 deg below the boresight)
    HUD_B = Vector((0, Y(4.005), 0.705))     # bottom centre of the combiner
    HUD_T = Vector((0, Y(3.935), 0.955))
    HUD_W = 0.34
    hud_up = (HUD_T - HUD_B).normalized()
    hud_n = PAN_EX.cross(hud_up).normalized()

    def hud_body(bm):
        rbox(bm, (0, Y(3.86), 0.605), (0.25, 0.30, 0.09), bevel=0.015, segs=2)
        rbox(bm, (0, Y(3.99), 0.668), (0.30, 0.07, 0.06), bevel=0.012, segs=2)
        for sx in (-1, 1):
            # slim side rails holding the combiner, only up to ~60 % of its height
            a = HUD_B + PAN_EX * sx * (HUD_W / 2 + 0.008) - hud_up * 0.04
            b = HUD_B + PAN_EX * sx * (HUD_W / 2 + 0.008) + hud_up * 0.15
            G.bm_cylinder(bm, a, b, 0.0055, 0.004, seg=8)
        # combiner mount along the bottom edge
        rbox(bm, HUD_B - hud_up * 0.012, (HUD_W + 0.03, 0.03, 0.025), rot=Matrix((PAN_EX, hud_n, hud_up)).transposed(),
             bevel=0.006, segs=1)
    add(part(uvh, hud_body, 'grip'))

    # rudder pedals
    def pedals(bm):
        for sx in (-1, 1):
            rbox(bm, (sx * 0.15, Y(3.70), -0.16), (0.10, 0.03, 0.2),
                 rot=Matrix.Rotation(math.radians(-20), 3, 'X'), bevel=0.006)
            G.bm_cylinder(bm, (sx * 0.15, Y(3.64), -0.10), (sx * 0.15, Y(3.58), 0.05), 0.012, seg=8)
    add(part(uvh, pedals, 'metal'))

    # canopy sill rails
    def rails(bm):
        for sign in (1, -1):
            pts = []
            for s in np.linspace(3.25, 6.9, 30):
                pts.append(Vector((sign * (can_x(s) - 0.02), Y(s), can_zs(s) - 0.015 - DZ)))
            for a, b in zip(pts[:-1], pts[1:]):
                G.bm_cylinder(bm, a, b, 0.018, seg=8, cap0=False, cap1=False)
    add(part(uvh, rails, 'metal'))

    # ------------------------------------------------------------------ ACES II seat
    recline = math.radians(15)
    back_dir = Vector((0, -math.sin(recline), math.cos(recline)))     # up along the seat back
    back_n = Vector((0, math.cos(recline), math.sin(recline)))        # seat back front normal (towards the nose)
    rotB = Matrix((PAN_EX, back_n, back_dir)).transposed()
    seat_back0 = Vector((0, Y(4.90), 0.12))

    def SB(h, d=0.0, x=0.0):
        return seat_back0 + back_dir * h + back_n * d + Vector((x, 0, 0))

    def seat_metal(bm):
        # bucket sides (thick plates with rounded top)
        for sx in (-1, 1):
            poly = [(4.30, -0.18), (4.30, 0.25), (4.34, 0.29), (4.62, 0.31), (4.95, 0.44), (4.99, 0.40), (4.99, -0.18)]
            G.bm_extrude_polygon(bm, [(Y(s_), z) for (s_, z) in poly], (sx * 0.245 - 0.017, 0, 0), (0, 1, 0), (0, 0, 1), 0.034)
        # seat bucket front + base structure
        rbox(bm, (0, Y(4.32), 0.0), (0.47, 0.035, 0.32), bevel=0.01, segs=1)
        rbox(bm, (0, Y(4.62), -0.10), (0.46, 0.60, 0.16), bevel=0.02, segs=2)
        # survival kit lid
        rbox(bm, (0, Y(4.60), 0.02), (0.43, 0.54, 0.05), bevel=0.012, segs=1)
        # back frame, catapult tube, guide rails
        rbox(bm, SB(0.45, -0.07), (0.46, 0.06, 0.95), rot=rotB, bevel=0.015)
        for sx in (-1, 1):
            rbox(bm, SB(0.55, -0.13, sx * 0.165), (0.045, 0.05, 1.24), rot=rotB, bevel=0.008)
        G.bm_cylinder(bm, SB(-0.1, -0.12), SB(0.95, -0.12), 0.035, seg=12)
        # headbox (parachute container): slightly wider at the top, rounded
        rbox(bm, SB(0.93, -0.05), (0.38, 0.20, 0.16), rot=rotB, bevel=0.03, segs=3)
        rbox(bm, SB(1.04, -0.06), (0.41, 0.22, 0.13), rot=rotB, bevel=0.035, segs=3)
        # drogue gun + canopy breakers on top
        G.bm_cylinder(bm, SB(1.08, -0.10, 0.13), SB(1.12, -0.10, 0.13), 0.03, seg=12)
        for sx in (-1, 1):
            G.bm_cylinder(bm, SB(1.09, 0.02, sx * 0.12), SB(1.12, 0.02, sx * 0.12), 0.012, 0.004, seg=8)
        # inertia reel housing / shoulder harness outlet
        rbox(bm, SB(0.84, 0.02), (0.18, 0.05, 0.05), rot=rotB, bevel=0.01, segs=1)
        # emergency oxygen bottle (left side of the seat)
        G.bm_cylinder(bm, (-0.27, Y(4.95), -0.1), (-0.27, Y(4.95), 0.25), 0.035, seg=12)
    bm = part(uvh, seat_metal, 'seatgreen')
    add(bm)

    def seat_fabric(bm):
        rbox(bm, (0, Y(4.60), 0.085), (0.42, 0.52, 0.085), bevel=0.03, segs=3)                 # seat cushion
        rbox(bm, SB(0.20, 0.0), (0.40, 0.075, 0.30), rot=rotB, bevel=0.03, segs=3)          # lumbar
        rbox(bm, SB(0.55, -0.005), (0.38, 0.06, 0.42), rot=rotB, bevel=0.03, segs=3)        # back pad
        rbox(bm, SB(0.92, 0.07), (0.26, 0.065, 0.18), rot=rotB, bevel=0.025, segs=3)        # headrest pad
        # harness: shoulder straps from the reel down the back, lap belt halves, crotch strap
        for sx in (-1, 1):
            rbox(bm, SB(0.52, 0.045, sx * 0.085), (0.048, 0.01, 0.66), rot=rotB, bevel=0.003, segs=1)
            rbox(bm, (sx * 0.13, Y(4.70), 0.137), (0.05, 0.30, 0.01), bevel=0.003, segs=1)
            rbox(bm, (sx * 0.06, Y(4.54), 0.14), (0.07, 0.05, 0.018), bevel=0.004, segs=1)   # buckles
        rbox(bm, (0, Y(4.40), 0.137), (0.05, 0.14, 0.01), bevel=0.003, segs=1)
    bm = part(uvh, seat_fabric)
    uvh.planar(bm, list(bm.faces), (0, Y(4.9), 0), (1, 0, 0), (0, -0.3, 0.95), 0.5, 1.2, 'seat')
    add(bm)

    def eject_handles(bm):
        for sx in (-1, 1):
            # D-ring style handle at the front of each armrest
            G.bm_torus(bm, (sx * 0.262, Y(4.40), 0.31), (1, 0, 0), 0.042, 0.011, seg=16, rseg=6)
    bm = part(uvh, eject_handles)
    uvh.planar(bm, list(bm.faces), (0, Y(4.34), 0.26), (0, -1, 0), (0, 0, 1), 0.12, 0.12, 'stripe')
    add(bm)

    def seat_black(bm):
        # armrest pads and the leg-restraint snubbers
        for sx in (-1, 1):
            rbox(bm, (sx * 0.245, Y(4.64), 0.325), (0.05, 0.30, 0.02), bevel=0.006, segs=1)
            G.bm_cylinder(bm, (sx * 0.2, Y(4.33), -0.1), (sx * 0.2, Y(4.29), -0.1), 0.02, seg=8)
    add(part(uvh, seat_black, 'rubber'))

    # headbox warning placard (front of the headbox faces the pilot's back; placard on the rear face)
    ob_main = G.new_object('cockpit_tub', main, [mats['atlas']])
    objs['cockpit_tub'] = ob_main

    # ------------------------------------------------------------------ side stick (right console)
    stick_p = Vector((0.375, Y(4.60), 0.215))

    def stick(bm):
        G.bm_cylinder(bm, stick_p, stick_p + Vector((0, 0, 0.03)), 0.05, 0.036, seg=18)           # rubber boot
        G.bm_cylinder(bm, stick_p + Vector((0, 0, 0.028)), stick_p + Vector((0, 0.008, 0.075)), 0.015, seg=12)
        g0 = stick_p + Vector((0, 0.008, 0.07))
        rot = Matrix.Rotation(math.radians(14), 3, 'X') @ Matrix.Rotation(math.radians(-10), 3, 'Y')
        # ergonomic grip: stacked, slightly tapered rounded sections
        for k, (h, w, dpt) in enumerate(((0.00, 0.038, 0.046), (0.03, 0.042, 0.052), (0.06, 0.044, 0.054),
                                        (0.09, 0.042, 0.05), (0.115, 0.038, 0.046))):
            rbox(bm, g0 + rot @ Vector((0, 0, h + 0.015)), (w, dpt, 0.034), rot=rot, bevel=0.013, segs=2)
        rbox(bm, g0 + rot @ Vector((0.0, -0.004, 0.148)), (0.04, 0.05, 0.026), rot=rot, bevel=0.011, segs=2)   # head
        rbox(bm, g0 + rot @ Vector((-0.012, 0.012, 0.155)), (0.012, 0.012, 0.012), rot=rot, bevel=0.004, segs=1)  # trim hat
        G.bm_cylinder(bm, g0 + rot @ Vector((0.01, -0.012, 0.16)), g0 + rot @ Vector((0.01, -0.012, 0.166)), 0.006, seg=8)
        rbox(bm, g0 + rot @ Vector((0, 0.032, 0.105)), (0.016, 0.014, 0.032), rot=rot, bevel=0.005, segs=1)  # trigger
        rbox(bm, g0 + rot @ Vector((0.024, 0.005, 0.12)), (0.01, 0.018, 0.016), rot=rot, bevel=0.004, segs=1)  # pinky
    bm = part(uvh, stick, 'grip')
    objs['cockpit_stick'] = G.pivot_object('cockpit_stick', bm, stick_p, (1, 0, 0), (0, 0, 1), materials=[mats['atlas']])

    # ------------------------------------------------------------------ throttles (left console)
    thr_p = Vector((-0.375, Y(4.62), 0.10))

    def throttle(bm):
        for dx in (-0.017, 0.017):
            G.bm_cylinder(bm, thr_p + Vector((dx, 0, 0)), thr_p + Vector((dx, 0.0, 0.19)), 0.009, seg=8)
        rot = Matrix.Rotation(math.radians(-12), 3, 'X')
        base = thr_p + Vector((0, 0.0, 0.215))
        rbox(bm, base, (0.085, 0.07, 0.05), rot=rot, bevel=0.018, segs=2)                   # grip body (both levers)
        rbox(bm, base + rot @ Vector((0, -0.005, 0.045)), (0.08, 0.075, 0.045), rot=rot, bevel=0.02, segs=3)
        rbox(bm, base + rot @ Vector((-0.045, 0.01, 0.05)), (0.012, 0.05, 0.03), rot=rot, bevel=0.005, segs=1)  # thumb switches
        for k in range(3):
            G.bm_cylinder(bm, base + rot @ Vector((-0.05, -0.012 + k * 0.014, 0.058)),
                          base + rot @ Vector((-0.056, -0.012 + k * 0.014, 0.058)), 0.004, seg=6)
        rbox(bm, base + rot @ Vector((0.0, 0.04, 0.03)), (0.05, 0.012, 0.02), rot=rot, bevel=0.004, segs=1)   # finger lift
    bm = part(uvh, throttle, 'grip')
    objs['cockpit_throttle'] = G.pivot_object('cockpit_throttle', bm, thr_p, (1, 0, 0), (0, 0, 1),
                                              materials=[mats['atlas']])

    # ------------------------------------------------------------------ screens
    for name, (u, w, W, H) in SCREENS.items():
        bm = bmesh.new()
        uv = bm.loops.layers.uv.verify()
        d = 0.011
        c = [PP(u - W / 2, w - H / 2, d), PP(u + W / 2, w - H / 2, d), PP(u + W / 2, w + H / 2, d), PP(u - W / 2, w + H / 2, d)]
        f = G.bm_poly(bm, c)
        for l, t in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            l[uv].uv = t
        objs[name] = G.new_object(name, bm, [mats['screen']])
    # HUD combiner: glass + symbology plane
    for name, off, mat in (('hud_glass', -0.002, mats['hudglass']), ('screen_hud', 0.003, mats['screen_hud'])):
        bm = bmesh.new()
        uv = bm.loops.layers.uv.verify()
        c = [HUD_B - PAN_EX * HUD_W / 2 + hud_n * off, HUD_B + PAN_EX * HUD_W / 2 + hud_n * off,
             HUD_T + PAN_EX * HUD_W / 2 + hud_n * off, HUD_T - PAN_EX * HUD_W / 2 + hud_n * off]
        f = G.bm_poly(bm, c)
        if f.normal.dot(Vector((0, -1, 0))) < 0:
            f.normal_flip()
            # keep UV corner order consistent with positions
        for l in f.loops:
            p = l.vert.co
            a = (p.x + HUD_W / 2) / HUD_W
            b = (p - HUD_B).dot(hud_up) / (HUD_T - HUD_B).length
            l[uv].uv = (a, b)
        objs[name] = G.new_object(name, bm, [mat])
    # smooth shading for the tub where bevelled
    for ob in objs.values():
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        G.smooth_sharp(bm, 35)
        bm.to_mesh(ob.data)
        bm.free()
    for ob in objs.values():
        ob.location.z += DZ
    interior = G.empty('interior', (0, 0, 0), size=0.5)
    for ob in objs.values():
        G.set_parent(ob, interior)
    objs['interior'] = interior
    return objs
