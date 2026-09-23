"""UH-60M cockpit (glass cockpit with four 6x8" MFDs, consoles, armoured seats, flight controls) and troop cabin.
All in the G frame; objects are merged per material and parented to the 'interior' empty."""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix
from lib import (new_mesh_obj, prim_cylinder, prim_tube, prim_box, prim_sphere, merge_parts, transform_verts,
                 half_profile, ring_from_half, loft_rings, join, prim_rbox, prim_torus)
import hull

FLOOR_CP = 0.70      # cockpit floor
FLOOR_CB = 0.62      # cabin floor (door sill)
Y_PANEL = 3.56
SEAT_X = 0.54
EYE_Y, EYE_Z = 2.78, 1.88

# instrument panel frame: origin, right, up (tilted back 15 deg), normal toward the crew
PANEL_TILT = math.radians(15)
P_O = Vector((0.0, Y_PANEL, 1.33))
P_R = Vector((1, 0, 0))
P_U = Vector((0, math.sin(PANEL_TILT), math.cos(PANEL_TILT)))
P_N = Vector((0, -math.cos(PANEL_TILT), math.sin(PANEL_TILT)))
P_W, P_H = 1.92, 0.60                      # panel face size
MFD_X = (0.535, 0.195, -0.195, -0.535)       # MFD 1..4 centres (x); 1 = pilot PFD (right seat), 4 = copilot PFD
MFD_UP = 0.075
BEZEL_W, BEZEL_H = 0.236, 0.292
SCREEN_W, SCREEN_H = 0.1524, 0.2032        # 6 x 8 inch active area


class Acc:
    """Accumulates geometry per material key."""

    def __init__(self):
        self.parts = {}

    def add(self, key, vf):
        self.parts.setdefault(key, []).append(vf)

    def build(self, M, parent, prefix='int'):
        out = []
        for key, parts in self.parts.items():
            v, f = merge_parts(parts)
            o = new_mesh_obj(f'{prefix}_{key}', v, f, M[key], smooth=True, sharp_deg=35)
            o.parent = parent
            out.append(o)
        return out


def panel_pt(u, v, w=0.0):
    """Point on the instrument panel face: u right, v up (metres from the panel centre), w toward the crew."""
    return P_O + P_R * u + P_U * v + P_N * w


def oriented_box(center, right, up, normal, sx, sy, sz):
    """Box with its axes along right/up/normal (sizes sx, sy, sz)."""
    c = Vector(center)
    verts = []
    for a in (-0.5, 0.5):
        for b in (-0.5, 0.5):
            for d in (-0.5, 0.5):
                verts.append(tuple(c + right * (a * sx) + up * (b * sy) + normal * (d * sz)))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return verts, faces


def quad_uv(name, corners, uvs, mat, parent):
    """Single textured quad. corners: 4 points (bl, br, tr, tl); uvs: 4 (u, v) in Blender convention."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(c) for c in corners], [], [(0, 1, 2, 3)])
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    for li, l in enumerate(me.loops):
        uv.data[li].uv = uvs[l.vertex_index]
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat)
    ob.parent = parent
    return ob


def grid_uv(name, pts_fn, nu, nv, mat, parent, uv_fn):
    """Grid surface with explicit UVs: pts_fn(i/nu, j/nv) -> point, uv_fn(s, t) -> (u, v)."""
    verts, faces, uvs = [], [], []
    for j in range(nv + 1):
        for i in range(nu + 1):
            s, t = i / nu, j / nv
            verts.append(tuple(pts_fn(s, t)))
            uvs.append(uv_fn(s, t))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    for l in me.loops:
        uv.data[l.index].uv = uvs[l.vertex_index]
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat)
    ob.parent = parent
    return ob


def inner_halfwidth(y, z, inset=0.035):
    return max(0.05, hull.fuse_halfwidth_at(y, z) - inset)


# ---------------------------------------------------------------------------------------------------------- cockpit
def build_cockpit(M, parent, A):
    objs = []
    # ---- instrument panel body (behind the face) + glare shield
    A.add('int_grey', oriented_box(panel_pt(0, 0, -0.07), P_R, P_U, P_N, 1.30, P_H, 0.14))
    # glare shield: a hood over the top of the panel
    gs = []
    for k, u in enumerate(np.linspace(-0.96, 0.96, 13)):
        top = panel_pt(u, P_H / 2 + 0.01, 0.0)
        ring = [top + Vector((0, 0.06, 0.0)), top + Vector((0, -0.10, 0.035)), top + Vector((0, -0.19, 0.01)),
                top + Vector((0, -0.19, -0.02)), top + Vector((0, -0.05, -0.01))]
        gs.append(np.array([tuple(p) for p in ring]))
    v, f = loft_rings(gs, cap_start='fan', cap_end='fan', closed=True)
    A.add('int_glare', (v, f))
    # panel face (textured) — a grid whose outer columns follow the curved cockpit wall
    def face_pt(s_, t_):
        p = panel_pt(-P_W / 2 + P_W * s_, -P_H / 2 + P_H * t_)
        lim = inner_halfwidth(p.y, p.z, 0.05)
        p.x = max(-lim, min(lim, p.x))
        return p
    pf = grid_uv('int_panelface', face_pt, 16, 6, M['int_panel'], parent,
                 lambda s_, t_: ((face_pt(s_, t_).x + P_W / 2) / P_W, t_))
    objs.append(pf)
    # ---- MFD bezels (textured front) + screens
    for i, x in enumerate(MFD_X):
        A.add('int_black', oriented_box(panel_pt(x, MFD_UP, 0.014), P_R, P_U, P_N, BEZEL_W, BEZEL_H, 0.028))
        c = [panel_pt(x - BEZEL_W / 2, MFD_UP - BEZEL_H / 2, 0.0285), panel_pt(x + BEZEL_W / 2, MFD_UP - BEZEL_H / 2, 0.0285),
             panel_pt(x + BEZEL_W / 2, MFD_UP + BEZEL_H / 2, 0.0285), panel_pt(x - BEZEL_W / 2, MFD_UP + BEZEL_H / 2, 0.0285)]
        objs.append(quad_uv(f'int_bezel_{i + 1}', c, [(0, 0), (1, 0), (1, 1), (0, 1)], M['int_bezel'], parent))
        c = [panel_pt(x - SCREEN_W / 2, MFD_UP - SCREEN_H / 2 + 0.004, 0.0295), panel_pt(x + SCREEN_W / 2, MFD_UP - SCREEN_H / 2 + 0.004, 0.0295),
             panel_pt(x + SCREEN_W / 2, MFD_UP + SCREEN_H / 2 + 0.004, 0.0295), panel_pt(x - SCREEN_W / 2, MFD_UP + SCREEN_H / 2 + 0.004, 0.0295)]
        # avionics CanvasTextures keep flipY = true -> after the glTF v flip the top edge must have Blender v = 0
        s = quad_uv(f'screen_mfd_{i + 1}', c, [(0, 1), (1, 1), (1, 0), (0, 0)], M['screen'], parent)
        objs.append(s)
    # standby flight display (ESIS) + master caution panel on the centre
    A.add('int_black', oriented_box(panel_pt(0, -0.20, 0.02), P_R, P_U, P_N, 0.09, 0.09, 0.04))
    A.add('int_black', oriented_box(panel_pt(0, 0.255, 0.02), P_R, P_U, P_N, 0.13, 0.05, 0.03))
    # knobs along the bottom edge of the panel
    for u in np.linspace(-0.85, 0.85, 14):
        p = panel_pt(u, -0.255, 0.012)
        v, f = prim_cylinder(0.011, 0.010, 0.02, n=10, axis='Z')
        R = Matrix((P_R, -P_U.cross(P_N) if False else P_U, P_N)).transposed().to_4x4()
        v = transform_verts(v, Matrix.Translation(p) @ R)
        A.add('int_knob', (v, f))
    # side consoles along the cockpit walls (under the door windows)
    for s in (-1, 1):
        y0, y1 = 3.45, 2.60
        for yy in (y0, y1):
            pass
        xw = inner_halfwidth(3.0, 0.80)
        A.add('int_grey', prim_box((0.12, 0.85, 0.28), center=(s * (xw - 0.07), 3.02, 0.92)))

    # ---- centre (lower) console
    top_f, top_a = (3.42, 1.05), (2.62, 0.93)
    y0, y1 = top_f[0], top_a[0]
    cv = []
    for (yy, zz) in (top_f, top_a):
        for xx in (-0.19, 0.19):
            cv.append((xx, yy, zz))
    for (yy, zz) in (top_f, top_a):
        for xx in (-0.19, 0.19):
            cv.append((xx, yy, FLOOR_CP))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    A.add('int_grey', (cv, faces))
    c = [Vector((-0.185, top_a[0], top_a[1] + 0.002)), Vector((0.185, top_a[0], top_a[1] + 0.002)),
         Vector((0.185, top_f[0], top_f[1] + 0.002)), Vector((-0.185, top_f[0], top_f[1] + 0.002))]
    objs.append(quad_uv('int_consoletop', c, [(0, 0), (0.5, 0), (0.5, 1), (0, 1)], M['int_console'], parent))
    # CDU keypads raised a little + small knobs
    for (yy, n) in ((3.25, 6), (2.95, 6), (2.75, 5)):
        for k in range(n):
            xx = -0.15 + k * 0.3 / max(1, n - 1)
            zz = top_a[1] + (yy - top_a[0]) / (top_f[0] - top_a[0]) * (top_f[1] - top_a[1])
            v, f = prim_cylinder(0.009, 0.008, 0.016, n=8, center=(xx, yy, zz))
            A.add('int_knob', (v, f))

    # ---- overhead console
    oy0, oy1 = 3.18, 2.40
    oz = 2.03
    ov = [(-0.17, oy0, oz + 0.30), (0.17, oy0, oz + 0.30), (-0.17, oy1, oz + 0.30), (0.17, oy1, oz + 0.30),
          (-0.17, oy0, oz - 0.02), (0.17, oy0, oz - 0.02), (-0.17, oy1, oz - 0.10), (0.17, oy1, oz - 0.10)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    A.add('int_grey', (ov, faces))
    c = [Vector((-0.165, oy0, oz - 0.023)), Vector((0.165, oy0, oz - 0.023)), Vector((0.165, oy1, oz - 0.103)), Vector((-0.165, oy1, oz - 0.103))]
    # faces down (normal -z); read by a pilot looking up: +x to the right, forward at the top of the panel
    objs.append(quad_uv('int_overhead', [c[0], c[1], c[2], c[3]], [(0.5, 1), (1.0, 1), (1.0, 0), (0.5, 0)], M['int_console'], parent))
    # engine power control levers (PCL 1/2) and fuel selector levers in the quadrant at the front of the overhead
    slope = (Vector((0, oy1, oz - 0.10)) - Vector((0, oy0, oz - 0.02))).normalized()
    for k, xx in enumerate((-0.10, -0.04, 0.04, 0.10)):
        base = Vector((xx, 3.04, oz - 0.03))
        tip = base + Vector((0, -0.08, -0.10))
        v, f = prim_tube([base, tip], 0.007, n=8)
        A.add('int_metal', (v, f))
        knob_key = 'int_black' if k in (0, 3) else 'int_red'
        A.add(knob_key if k in (0, 3) else 'int_knob', prim_rbox((0.032, 0.026, 0.034), tuple(tip), r=0.01))
        # quadrant slot
        A.add('int_black', prim_box((0.012, 0.16, 0.004), center=(xx, 3.02, oz - 0.03 - 0.004)))
    # fire T-handles (red) at the front face of the overhead
    for xx in (-0.07, 0.07):
        A.add('int_red', prim_rbox((0.085, 0.02, 0.022), (xx, oy0 - 0.022, oz - 0.05), r=0.008))
        v, f = prim_tube([(xx, oy0 - 0.005, oz - 0.05), (xx, oy0 - 0.02, oz - 0.05)], 0.006, n=6)
        A.add('int_metal', (v, f))
    # rotor brake lever
    v, f = prim_tube([(0.13, 2.60, oz - 0.08), (0.13, 2.50, oz - 0.18)], 0.01, n=6)
    A.add('int_red', (v, f))
    # crew door interior release handles and utility (map) lights on the door frames
    for s_ in (-1, 1):
        xw = inner_halfwidth(2.95, 1.25, 0.05)
        A.add('int_black', prim_rbox((0.03, 0.16, 0.035), (s_ * xw, 2.95, 1.25), r=0.01))
        A.add('int_red', prim_rbox((0.02, 0.05, 0.02), (s_ * (xw - 0.01), 3.05, 1.25), r=0.006))
        xw2 = inner_halfwidth(2.62, 1.98, 0.05)
        v, f = prim_cylinder(0.02, 0.025, 0.08, n=10, axis='Y', center=(s_ * (xw2 - 0.03), 2.62, 1.95))
        A.add('int_black', (v, f))
    # standby magnetic compass on the windshield centre post
    v, f = prim_box((0.07, 0.06, 0.06), center=(0, 3.10, 1.98))
    A.add('int_black', (v, f))

    # ---- floor + pedals + cyclic + collective + seats (per crew position)
    floor = []
    for yy in np.linspace(4.05, 2.45, 9):
        xw = inner_halfwidth(yy, FLOOR_CP + 0.02, 0.04)
        floor.append(np.array([(-xw, yy, FLOOR_CP), (xw, yy, FLOOR_CP)]))
    v, f = loft_rings(floor, closed=False)
    A.add('int_floor_cp', (v, f))
    for s in (-1, 1):
        sx = s * SEAT_X
        build_seat(A, sx)
        # cyclic
        v, f = prim_cylinder(0.07, 0.03, 0.10, n=14, center=(sx, 3.30, FLOOR_CP))
        A.add('int_rubber', (v, f))
        v, f = prim_tube([(sx, 3.30, FLOOR_CP + 0.05), (sx, 3.27, 1.00), (sx, 3.20, 1.22)], 0.014, n=10)
        A.add('int_metal', (v, f))
        v, f = prim_sphere(0.034, n=12, m=8, center=(sx, 3.185, 1.28), scale=(0.9, 1.1, 2.0))
        A.add('int_black', (v, f))
        # collective (left of each seat), pivot aft
        cx = sx - 0.31
        v, f = prim_tube([(cx, 2.72, 0.92), (cx, 3.06, 1.00), (cx, 3.18, 1.02)], 0.016, n=10)
        A.add('int_metal', (v, f))
        v, f = prim_cylinder(0.028, 0.028, 0.16, n=12, axis='Y', center=(cx, 3.18, 1.02))
        A.add('int_black', (v, f))
        v, f = prim_box((0.06, 0.05, 0.05), center=(cx, 3.36, 1.03))
        A.add('int_black', (v, f))
        v, f = prim_box((0.10, 0.60, 0.16), center=(cx - 0.02, 2.90, 0.80))
        A.add('int_grey', (v, f))
        # pedals
        for ps in (-1, 1):
            px = sx + ps * 0.13
            v, f = prim_tube([(px, 3.98, FLOOR_CP + 0.02), (px, 3.90, 0.93)], 0.012, n=8)
            A.add('int_metal', (v, f))
            ped = oriented_box((px, 3.88, 0.95), Vector((1, 0, 0)), Vector((0, -0.45, 0.89)).normalized(),
                               Vector((0, 0.89, 0.45)).normalized(), 0.10, 0.20, 0.02)
            A.add('int_black', ped)
    return objs


def build_seat(A, sx):
    """Armoured crashworthy crew seat (bucket shell, side armour wing, cushions, headrest, 5-point harness)."""
    y0 = 2.96           # front edge of the seat pan
    zp = 1.12           # cushion top
    X = Vector((1, 0, 0))
    so = 1 if sx > 0 else -1
    # seat pan bucket shell + cushion
    A.add('int_seatframe', prim_rbox((0.52, 0.48, 0.10), (sx, y0 - 0.24, zp - 0.10), r=0.03))
    A.add('int_cushion', prim_rbox((0.44, 0.44, 0.075), (sx, y0 - 0.23, zp - 0.025), r=0.03))
    # side bolsters of the pan
    for ox in (-0.23, 0.23):
        A.add('int_seatframe', prim_rbox((0.05, 0.46, 0.14), (sx + ox, y0 - 0.24, zp - 0.02), r=0.02))
    # backrest (reclined ~12 deg): shell, cushion, headrest
    tilt = math.radians(12)
    up = Vector((0, -math.sin(tilt), math.cos(tilt)))
    fw = Vector((0, math.cos(tilt), math.sin(tilt)))
    base = Vector((sx, y0 - 0.47, zp - 0.05))
    A.add('int_seatframe', prim_rbox((0.54, 0.88, 0.09), base + up * 0.42 - fw * 0.05, r=0.035, axes=(X, up, fw)))
    A.add('int_cushion', prim_rbox((0.42, 0.62, 0.07), base + up * 0.37 + fw * 0.02, r=0.03, axes=(X, up, fw)))
    A.add('int_cushion', prim_rbox((0.28, 0.16, 0.08), base + up * 0.80 + fw * 0.03, r=0.035, axes=(X, up, fw)))
    for ox in (-0.25, 0.25):       # backrest side wings
        A.add('int_seatframe', prim_rbox((0.05, 0.70, 0.14), base + up * 0.40 + X * ox + fw * 0.02, r=0.02, axes=(X, up, fw)))
    # sliding side armour panel (outboard) + armour plate behind the back
    A.add('int_armor', prim_rbox((0.035, 0.66, 0.40), base + up * 0.44 + X * (so * 0.30) + fw * 0.10, r=0.015, axes=(X, up, fw)))
    A.add('int_armor', prim_rbox((0.56, 0.92, 0.03), base + up * 0.42 - fw * 0.11, r=0.012, axes=(X, up, fw)))
    # harness: shoulder straps + lap belt + crotch strap + buckle
    for ox in (-0.08, 0.08):
        p0 = base + up * 0.74 + fw * 0.06 + Vector((ox, 0, 0))
        p1 = Vector((sx + ox * 0.6, y0 - 0.21, zp + 0.06))
        v, f = prim_tube([p0, p0.lerp(p1, 0.5) + fw * 0.07, p1], 0.013, n=6)
        A.add('int_strap', (v, f))
    for ox in (-0.2, 0.2):
        v, f = prim_tube([(sx + ox, y0 - 0.40, zp + 0.01), (sx + ox * 0.4, y0 - 0.25, zp + 0.05), (sx, y0 - 0.21, zp + 0.06)], 0.013, n=6)
        A.add('int_strap', (v, f))
    v, f = prim_tube([(sx, y0 - 0.02, zp + 0.0), (sx, y0 - 0.20, zp + 0.06)], 0.013, n=6)
    A.add('int_strap', (v, f))
    v, f = prim_cylinder(0.04, 0.04, 0.02, n=14, axis='Y', center=(sx, y0 - 0.19, zp + 0.065))
    A.add('int_metal', (v, f))
    # seat rails / stroking frame
    for ox in (-0.18, 0.18):
        A.add('int_metal', prim_box((0.04, 0.60, 0.04), center=(sx + ox, y0 - 0.25, FLOOR_CP + 0.02)))
        v, f = prim_tube([(sx + ox, y0 - 0.08, FLOOR_CP + 0.03), (sx + ox, y0 - 0.12, zp - 0.14)], 0.018, n=8)
        A.add('int_metal', (v, f))
        v, f = prim_tube([(sx + ox, y0 - 0.45, FLOOR_CP + 0.03), (sx + ox, y0 - 0.45, zp - 0.14)], 0.018, n=8)
        A.add('int_metal', (v, f))
        # energy-attenuating stroke guides behind the backrest
        g0 = base - fw * 0.14 + X * ox
        v, f = prim_tube([g0, g0 + up * 0.85], 0.02, n=8)
        A.add('int_metal', (v, f))


# ---------------------------------------------------------------------------------------------------------- cabin
def build_cabin(M, parent, A):
    objs = []
    # floor (textured, tiling)
    def fpt(s, t):
        yy = -1.78 + (2.45 + 1.78) * t          # t increases forward -> floor normal faces up
        xw = inner_halfwidth(yy, FLOOR_CB + 0.02, 0.04)
        return Vector((-xw + 2 * xw * s, yy, FLOOR_CB))
    objs.append(grid_uv('int_cabinfloor', fpt, 1, 12, M['int_floor'], parent,
                        lambda s, t: (s * 2.2 / 0.5, t * 4.23 / 0.5)))
    # seat tracks along the cabin floor and raised cargo tie-down rings
    for xx in (-0.86, -0.48, 0.48, 0.86):
        A.add('int_tube', prim_box((0.028, 4.05, 0.008), center=(xx, 0.33, FLOOR_CB + 0.004)))
    for yy in (1.95, 1.2, 0.45, -0.3, -1.05):
        for xx in (-0.72, 0.0, 0.72):
            v, f = prim_torus(0.035, 0.006, n=10, m=5, center=(xx, yy, FLOOR_CB + 0.008))
            A.add('int_metal', (v, f))
    # step between cockpit and cabin floors
    A.add('int_grey', prim_box((2.0, 0.04, FLOOR_CP - FLOOR_CB), center=(0, 2.45, (FLOOR_CP + FLOOR_CB) / 2)))
    # aft bulkhead: fuselage inner section at y = -1.78, above the cabin floor (quilted)
    yb = -1.78
    zb, zm, zt, w, nb, nt, tt = [float(v) for v in hull.fuse_params(yb)]
    x, z = half_profile(w - 0.035, zb + 0.035, zm, zt - 0.035, nb, nt, tt, n=40)
    pts = [(xx, zz) for xx, zz in zip(x, z) if zz >= FLOOR_CB]
    pts = [(inner_halfwidth(yb, FLOOR_CB, 0.035), FLOOR_CB)] + pts
    left = [(-xx, zz) for xx, zz in pts[::-1]]
    ring = pts + left[1:]
    verts = [(xx, yb, zz) for xx, zz in ring]
    me = bpy.data.meshes.new('int_bulkhead')
    me.from_pydata(verts, [], [tuple(range(len(verts)))])
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for l in me.loops:
        vv = verts[l.vertex_index]
        uvl.data[l.index].uv = (vv[0] / 0.5, vv[2] / 0.5)
    ob = bpy.data.objects.new('int_bulkhead', me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(M['int_quilt'])
    ob.parent = parent
    # the polygon faces +y (into the cabin)?
    if me.polygons[0].normal.y < 0:
        me.flip_normals()
    objs.append(ob)
    # troop seats: 4 forward-facing at the aft bulkhead, 3 aft-facing mid cabin, 2 gunner seats facing outboard
    for xx in (-0.72, -0.24, 0.24, 0.72):
        troop_seat(A, Vector((xx, -1.52, FLOOR_CB)), 0.0)
    for xx in (-0.45, 0.0, 0.45):
        troop_seat(A, Vector((xx, 1.55, FLOOR_CB)), math.pi)
    for s in (-1, 1):
        troop_seat(A, Vector((s * 0.62, 2.10, FLOOR_CB)), -s * math.pi / 2)
    # aft bulkhead equipment: fire extinguisher, first-aid kits, crash axe, cable bundles
    v, f = prim_cylinder(0.07, 0.07, 0.42, n=16, center=(0.85, -1.70, 1.25))
    A.add('int_red', (v, f))
    v, f = prim_cylinder(0.03, 0.02, 0.06, n=10, center=(0.85, -1.70, 1.67))
    A.add('int_black', (v, f))
    for k, xx in enumerate((-0.95, -0.60)):
        A.add('int_kit', prim_box((0.30, 0.10, 0.22), center=(xx, -1.71, 1.62)))
    for zz in (1.95, 2.02):
        v, f = prim_tube([(-0.9, -1.72, zz), (0.9, -1.72, zz)], 0.018, n=6)
        A.add('int_black', (v, f))
    # cabin door interior handles and gunner-window sills
    for s_ in (-1, 1):
        xw = inner_halfwidth(1.5, 1.2, 0.06)
        v, f = prim_tube([(s_ * xw, 1.36, 1.05), (s_ * (xw - 0.05), 1.36, 1.08), (s_ * (xw - 0.05), 1.36, 1.28), (s_ * xw, 1.36, 1.31)], 0.012, n=6)
        A.add('int_metal', (v, f))
        A.add('int_grey', prim_box((0.06, 0.52, 0.04), center=(s_ * (inner_halfwidth(2.07, 1.28, 0.06) - 0.02), 2.07, 1.26)))
    # ceiling beams, grab handles and dome lights
    for yy in (1.95, 0.55, -0.85):
        A.add('int_grey', prim_box((1.9, 0.08, 0.06), center=(0, yy, 2.19)))
    for s in (-1, 1):
        v, f = prim_tube([(s * 0.55, 1.4, 2.17), (s * 0.55, 1.35, 2.07), (s * 0.55, -0.6, 2.07), (s * 0.55, -0.65, 2.17)], 0.012, n=6)
        A.add('int_metal', (v, f))
    for yy in (1.2, -0.3):
        v, f = prim_sphere(0.06, n=12, m=6, center=(0, yy, 2.21), scale=(1, 1, 0.4))
        A.add('int_lamp', (v, f))
    return objs


def troop_seat(A, base, yaw):
    """Crashworthy troop seat: canvas pan + back on a tubular frame, energy-attenuating struts to the ceiling."""
    R = Matrix.Rotation(yaw, 4, 'Z')
    T = Matrix.Translation(base)
    X = T @ R

    def tr(vf):
        v, f = vf
        return (transform_verts(v, X), f)
    zp = 0.43
    A.add('int_canvas', tr(prim_rbox((0.42, 0.40, 0.03), (0, 0.02, zp), r=0.012)))
    A.add('int_canvas', tr(prim_rbox((0.42, 0.03, 0.46), (0, -0.19, zp + 0.28), r=0.012)))
    # frame
    for sx in (-0.215, 0.215):
        A.add('int_tube', tr(prim_tube([(sx, 0.22, zp), (sx, -0.20, zp), (sx, -0.21, zp + 0.55), (sx, -0.22, 1.56)], 0.013, n=6, cap=False)))
        A.add('int_tube', tr(prim_tube([(sx, 0.20, zp), (sx, 0.10, 0.0)], 0.011, n=6, cap=False)))
    A.add('int_tube', tr(prim_tube([(-0.215, 0.22, zp), (0.215, 0.22, zp)], 0.013, n=6)))
    A.add('int_tube', tr(prim_tube([(-0.215, -0.21, zp + 0.55), (0.215, -0.21, zp + 0.55)], 0.013, n=6)))
    # lap belt
    A.add('int_strap', tr(prim_box((0.40, 0.04, 0.012), center=(0, 0.05, zp + 0.02))))


def build_interior(M, parent):
    A = Acc()
    objs = []
    objs += build_cockpit(M, parent, A)
    objs += build_cabin(M, parent, A)
    objs += A.build(M, parent)
    # panel body behind the fitted face
    pf = bpy.data.objects['int_panelface']
    body = bpy.data.objects.new('int_panelbody', pf.data.copy())
    bpy.context.scene.collection.objects.link(body)
    body.data.materials.clear()
    body.data.materials.append(M['int_grey'])
    body.parent = parent
    from lib import add_modifier_apply
    add_modifier_apply(body, 'SOLIDIFY', thickness=0.10, offset=1.0 if False else -1.0)
    body.data.transform(Matrix.Translation(-P_N * 0.002))
    objs.append(body)
    for o in objs:
        if not o.name.startswith('screen_'):
            clamp_inside(o)
    return objs


def clamp_inside(ob, margin=0.03):
    """Pull any interior vertex that would poke through the skin back inside (x toward the centre, z below the roof)."""
    me = ob.data
    moved = 0
    for v in me.vertices:
        p = v.co.copy()          # interior meshes are authored in the G frame (identity local transforms)
        if p.y > 4.6 or p.y < -9.0:
            continue
        zb, zm, zt, w, nb, nt, tt = [float(a) for a in hull.fuse_params(p.y)]
        zc = min(max(p.z, zb + 0.01), zt - 0.01)
        lim = hull.fuse_halfwidth_at(p.y, zc) - margin
        q = p.copy()
        if abs(q.x) > lim:
            q.x = math.copysign(max(lim, 0.0), q.x)
        if q.z > zt - margin - 0.02:
            q.z = zt - margin - 0.02
        if q.z < zb + margin:
            q.z = zb + margin
        if (q - p).length > 1e-6:
            v.co = q
            moved += 1
    me.update()
    if moved:
        print(f'[uh60] clamp_inside {ob.name}: {moved} verts', flush=True)


def assign_wall_materials(fuse, M):
    """Inner skin faces (material slot 1 'int_wall'): cockpit part -> dark grey paint, cabin -> quilted insulation.
    Gives them tiling box-projected UVs (the hull atlas unwrap only covers the outer faces)."""
    me = fuse.data
    slots = [s.material for s in fuse.material_slots]
    if M['int_cockpit'] not in slots:
        me.materials.append(M['int_cockpit'])
    if M['int_quilt'] not in slots:
        me.materials.append(M['int_quilt'])
    slots = [s.material for s in fuse.material_slots]
    i_wall = slots.index(M['int_wall'])
    i_cp = slots.index(M['int_cockpit'])
    i_q = slots.index(M['int_quilt'])
    uv = me.uv_layers.active or me.uv_layers.new(name='UVMap')
    mw = fuse.matrix_world
    for p in me.polygons:
        if p.material_index != i_wall:
            continue
        c = mw @ p.center
        if c.y > 2.45:
            p.material_index = i_cp
        elif c.y > -1.85:
            p.material_index = i_q
        n = mw.to_3x3() @ p.normal
        for li in p.loop_indices:
            v = mw @ me.vertices[me.loops[li].vertex_index].co
            if abs(n.z) > 0.7:
                uv.data[li].uv = (v.x / 0.45, v.y / 0.45)
            else:
                uv.data[li].uv = (v.y / 0.45, v.z / 0.45)
