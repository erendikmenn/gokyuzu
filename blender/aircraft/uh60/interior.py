"""UH-60M detailed cockpit + cabin (the 'interior' root of uh60_cockpit.glb, CONTRACTS-SF.md §6.2.1).

Cockpit: CAAS glass instrument panel with four 6x8 in MFDs, glare shield with master warning panels, lower console
(2 CDUs, AFCS, ICS, lighting / IFF / stabilator panels), upper console (ENG EMER OFF T-handles, engine control and fuel
selector levers, rotor brake, system panels, circuit breakers), armoured crew seats, cyclics, collectives, pedals.
Cabin: see cabin.py. All in the G frame. Every mesh is tagged with an atlas group; ibake.py joins each group into one
object and bakes albedo x soft light into its textures. Panel legends come from label plates (plates.py -> cptex.py).
"""
import os
import math
import subprocess
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix
from lib import (new_mesh_obj, prim_cylinder, prim_tube, prim_box, prim_sphere, merge_parts, transform_verts,
                 half_profile, ring_from_half, loft_rings, join, prim_rbox, prim_torus)
import hull
import cplib
import plates
import crew
import cabin

HERE = os.path.dirname(os.path.abspath(__file__))
FLOOR_CP = 0.70      # cockpit floor
FLOOR_CB = 0.62      # cabin floor (door sill)
Y_PANEL = 3.56
SEAT_X = 0.54
SEAT_Y0, SEAT_ZP = 2.99, 1.13
ATLAS_SIZES = {'int_panels': 4096, 'int_consoles': 4096, 'int_cockpit': 4096, 'int_cabin': 4096}

# instrument panel frame: centre, right, up (tilted back), normal toward the crew
PANEL_TILT = math.radians(15)
P_O = Vector((0.0, Y_PANEL, 1.33))
P_R = Vector((1, 0, 0))
P_U = Vector((0, math.sin(PANEL_TILT), math.cos(PANEL_TILT)))
P_N = Vector((0, -math.cos(PANEL_TILT), math.sin(PANEL_TILT)))
P_V0, P_V1 = -0.13, 0.30
# UH-60M CAAS: four 8 x 6 in MFDs mounted LANDSCAPE in two pairs, a centre column between the pairs (ESIS, standby
# clock, load-access placard). screen_mfd_1..4: 1 = pilot outboard (right seat), 2 = pilot inboard, 3 = copilot
# inboard, 4 = copilot outboard.
MFD_X = (0.527, 0.253, -0.253, -0.527)
MFD_V = 0.172
BEZEL_W, BEZEL_H, BEZEL_D = 0.262, 0.214, 0.032
SCREEN_W, SCREEN_H = 0.2032, 0.1524        # 8 x 6 inch landscape glass
PAGE_W = SCREEN_H * 0.75                   # avionics pages are portrait (750 x 1000): pillar-boxed in the glass

# lower console: sloped front section carrying the two CDUs, then the aft top (front -> aft) and the upper console
CON_T = Vector((0, 3.515, 1.200))          # top of the CDU section, just under the panel's lower edge
CON_F, CON_A, CON_W = Vector((0, 3.215, 0.985)), Vector((0, 2.52, 0.885)), 0.46
OVH_F, OVH_A, OVH_W = Vector((0, 3.16, 2.03)), Vector((0, 2.26, 2.10)), 0.36


class Acc:
    """Accumulates geometry per material key for one atlas group."""

    def __init__(self, group):
        self.group = group
        self.parts = {}

    def add(self, key, vf, keep=False):
        """keep=True: open surface whose authored winding is correct (normals must face the air for the light bake);
        closed parts get their normals recalculated outward."""
        self.parts.setdefault((key, keep), []).append(vf)

    def build(self, M, parent):
        out = {}
        for (key, keep), parts in self.parts.items():
            v, f = merge_parts(parts)
            o = new_mesh_obj(f'{self.group}_{key}{"_k" if keep else ""}', v, f, M[key], smooth=True, sharp_deg=38, recalc=not keep)
            o.parent = parent
            o['atlas'] = self.group
            if key in out:
                o = join([out[key], o], f'{self.group}_{key}')
            out[key] = o
        return list(out.values())


def panel_pt(u, v, w=0.0):
    return P_O + P_R * u + P_U * v + P_N * w


def inner_halfwidth(y, z, inset=0.035):
    return max(0.05, hull.fuse_halfwidth_at(y, z) - inset)


def oriented_box(center, right, up, normal, sx, sy, sz):
    c = Vector(center)
    verts = []
    for a in (-0.5, 0.5):
        for b in (-0.5, 0.5):
            for d in (-0.5, 0.5):
                verts.append(tuple(c + right * (a * sx) + up * (b * sy) + normal * (d * sz)))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return verts, faces


def quad_uv(name, corners, uvs, mat, parent):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(c) for c in corners], [], [(0, 1, 2, 3)])
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    for l in me.loops:
        uv.data[l.index].uv = uvs[l.vertex_index]
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat)
    ob.parent = parent
    return ob


# ---------------------------------------------------------------------------------------------- shared shapes (lite too)
PANEL_HW = 0.685      # the UH-60M panel face is only as wide as the MFD row; outboard of it are the door frames


def panel_face_mesh(nu=16, nv=6, w=0.0):
    """Instrument panel background (as wide as the MFD row), clipped to the cockpit walls."""
    verts, faces = [], []
    for j in range(nv + 1):
        for i in range(nu + 1):
            u = PANEL_HW * (-1.0 + 2.0 * i / nu)
            v = P_V0 + (P_V1 - P_V0) * j / nv
            p = panel_pt(u, v, w)
            lim = inner_halfwidth(p.y, p.z, 0.045)
            p.x = max(-lim, min(lim, p.x))
            verts.append(tuple(p))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    return verts, faces


def glareshield_mesh(n=15, lite=False):
    """Padded glare shield hood over the panel: deep overhang in the middle, rounded ends past the outboard MFDs."""
    rings = []
    GW = PANEL_HW + 0.10
    for k, t in enumerate(np.linspace(-1.0, 1.0, n)):
        u = GW * math.sin(t * math.pi / 2)
        e = max(0.0, 1.0 - abs(u / GW) ** 3) ** 0.5            # 1 in the middle -> 0 at the ends
        T = panel_pt(0, P_V1, 0)
        # deep padded hood: large overhang toward the crew and a lip hanging down over the MFD tops
        # (the lip must stay above the pilots' line of sight to the top edge of the MFD glass)
        sec = [(0.16, 0.080), (0.02, 0.100), (-0.16, 0.095), (-0.215, 0.076), (-0.228, 0.046), (-0.222, 0.024),
               (-0.200, 0.016), (-0.05, -0.008)]
        pts = []
        for dy, dz in sec:
            dy = dy if dy > 0 else dy * (0.35 + 0.65 * e)
            dz = dz * (0.55 + 0.45 * e)
            p = Vector((u, T.y + dy, T.z + dz))
            lim = inner_halfwidth(p.y, p.z, 0.05) - (0.02 if lite else 0.0)
            p.x = max(-lim, min(lim, p.x))
            pts.append(tuple(p))
        rings.append(np.array(pts))
    return loft_rings(rings, cap_start='fan', cap_end='fan', closed=True)


def console_frame():
    """Lower console top frame: origin at the aft-left corner, R = +x, U = forward along the top, N = up normal."""
    U = (CON_F - CON_A).normalized()
    R = Vector((1, 0, 0))
    N = R.cross(U).normalized()
    if N.z < 0:
        N = -N
    return CON_A - R * (CON_W / 2), R, U, N, (CON_F - CON_A).length


def cdu_frame():
    """Sloped front section of the lower console (the CDUs): origin bottom-left, U up the slope (forward)."""
    U = (CON_T - CON_F).normalized()
    R = Vector((1, 0, 0))
    N = R.cross(U).normalized()
    return CON_F - R * (CON_W / 2), R, U, N, (CON_T - CON_F).length


def console_block():
    """Closed console body: aft top, sloped CDU face, sides down to the floor."""
    o, R, U, N, L = console_frame()
    hw = CON_W / 2
    prof = [(CON_A.y, CON_A.z), (CON_F.y, CON_F.z), (CON_T.y, CON_T.z), (CON_T.y + 0.02, FLOOR_CP), (CON_A.y, FLOOR_CP)]
    verts = [(-hw, y, z) for y, z in prof] + [(hw, y, z) for y, z in prof]
    n = len(prof)
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        i1 = (i + 1) % n
        faces.append((i, n + i, n + i1, i1))
    return verts, faces


def overhead_frame():
    """Upper console underside, read by a pilot looking up-forward: legends have their top toward the aft end.
    Origin at the front-left corner, R = +x, U = aft along the underside, N = down (toward the crew)."""
    U = (OVH_A - OVH_F).normalized()
    R = Vector((1, 0, 0))
    N = R.cross(U).normalized()
    o = OVH_F - R * (OVH_W / 2)
    return o, R, U, N, (OVH_F - OVH_A).length


def overhead_block():
    o, R, U, N, L = overhead_frame()
    bot = [o, o + R * OVH_W, o + R * OVH_W + U * L, o + U * L]
    verts = [tuple(p) for p in bot] + [tuple(p - N * 0.26) for p in bot]
    faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    return verts, faces


# ---------------------------------------------------------------------------------------------- instrument panel
def build_panel(M, P, A, parent):
    objs = []
    A.add('int_panelpaint', panel_face_mesh(), keep=True)
    # panel box behind the face (seen from above between the glare shield and the windshield, and from below)
    v, f = panel_face_mesh(8, 2, -0.16)
    A.add('int_structure', (v, [ff[::-1] for ff in f]), keep=True)
    bot = []
    for u in np.linspace(-PANEL_HW, PANEL_HW, 9):
        p0 = panel_pt(u, P_V0, 0.0)
        p1 = panel_pt(u, P_V0, -0.16)
        lim = inner_halfwidth(p0.y, p0.z, 0.05)
        p0.x = p1.x = max(-lim, min(lim, u))
        bot.append(np.array([tuple(p0), tuple(p1)]))
    v, f = loft_rings(bot, closed=False)
    A.add('int_structure', (v, f))
    for sgn in (-1, 1):            # side closeouts of the panel box
        q = [panel_pt(sgn * PANEL_HW, P_V0, 0), panel_pt(sgn * PANEL_HW, P_V1, 0), panel_pt(sgn * PANEL_HW, P_V1, -0.16),
             panel_pt(sgn * PANEL_HW, P_V0, -0.16)]
        A.add('int_structure', ([tuple(p) for p in q], [(0, 1, 2, 3) if sgn > 0 else (3, 2, 1, 0)]), keep=True)
    A.add('int_glarepad', glareshield_mesh())
    R, U, N = P_R, P_U, P_N

    def pplate(name, u0, v0, w, h, **kw):
        return P.plate(A, name, panel_pt(u0, v0, 0.0), R, U, N, w, h, **kw)

    # ---- four landscape MFDs: case, bezel plate (keys on all four sides), glass, screen quad (portrait page)
    for i, x in enumerate(MFD_X):
        cv, cf = oriented_box(panel_pt(x, MFD_V, BEZEL_D / 2), R, U, N, BEZEL_W - 0.004, BEZEL_H - 0.004, BEZEL_D)
        A.add('int_bezelbody', (cv, [f_ for f_ in cf if f_ not in ((1, 5, 7, 3), (0, 2, 6, 4))]))
        cx, cy = BEZEL_W / 2, BEZEL_H / 2 + 0.003
        sx0, sx1 = cx - SCREEN_W / 2, cx + SCREEN_W / 2
        sy0, sy1 = cy - SCREEN_H / 2, cy + SCREEN_H / 2
        px0, px1 = cx - PAGE_W / 2, cx + PAGE_W / 2
        bz = P.plate(A, f'mfd{i + 1}', panel_pt(x - BEZEL_W / 2, MFD_V - BEZEL_H / 2, BEZEL_D - 0.002), R, U, N,
                     BEZEL_W, BEZEL_H, bg='#34363a', thick=0.003, screws=False, edgewear=16.0,
                     hole=(px0 + 0.0015, sy0 + 0.0015, px1 - 0.0015, sy1 - 0.0015))
        bz.box(sx0 - 0.003, sy0 - 0.003, sx1 + 0.003, sy1 + 0.003, fill='#0a0b0c', ol='#1c1d1f', w=0.0015, r=0.002)
        bz.box(sx0, sy0, sx1, sy1, fill='#07080a')
        # keys: 5 per side, 3 + 3 along the top and the bottom (tall narrow keys), tick marks toward the glass
        for k in range(5):
            yy = sy0 + (k + 0.5) * SCREEN_H / 5
            for xx, dx in ((sx0 - 0.0135, 0.008), (sx1 + 0.0135, -0.008)):
                bz.add('int_button', cplib.bezel_key(0.0135, 0.0115, 0.005), xx, yy, 0.001)
                bz.line([(xx + dx * 0.95, yy), (xx + dx * 1.3, yy)], c='#c8c8bc', w=0.0007)
        for grp in (0, 1):
            for k in range(3):
                xx = (sx0 + 0.022 + k * 0.019) if grp == 0 else (sx1 - 0.022 - (2 - k) * 0.019)
                for yy in (sy1 + 0.0125, sy0 - 0.0125):
                    bz.add('int_button', cplib.bezel_key(0.012, 0.0145, 0.005), xx, yy, 0.001)
        # brightness rocker and day/night label in the middle of the bottom edge, light sensor in the top middle
        bz.add('int_button', cplib.rocker(0.018, 0.010, 0.005), cx, sy0 - 0.0125, 0.001)
        bz.text(cx - 0.020, sy0 - 0.0125, 'DIM', 0.0021)
        bz.text(cx + 0.020, sy0 - 0.0125, 'BRT', 0.0021)
        bz.circle(cx, sy1 + 0.0125, 0.0025, fill='#0b0b0c', ol='#5a5a5a')
        z = BEZEL_D + 0.0013
        o0 = (x - BEZEL_W / 2, MFD_V - BEZEL_H / 2)
        c = [panel_pt(o0[0] + px0, o0[1] + sy0, z), panel_pt(o0[0] + px1, o0[1] + sy0, z),
             panel_pt(o0[0] + px1, o0[1] + sy1, z), panel_pt(o0[0] + px0, o0[1] + sy1, z)]
        # avionics CanvasTextures keep flipY = true -> after the glTF v flip the top edge must have Blender v = 0
        objs.append(quad_uv(f'screen_mfd_{i + 1}', c, [(0, 1), (1, 1), (1, 0), (0, 0)], M['screen'], parent))
        # glass frame lip (the glass reads as recessed)
        for (a0, b0, a1, b1) in ((sx0 - 0.004, sy0 - 0.004, sx1 + 0.004, sy0), (sx0 - 0.004, sy1, sx1 + 0.004, sy1 + 0.004),
                                 (sx0 - 0.004, sy0, sx0, sy1), (sx1, sy0, sx1 + 0.004, sy1)):
            A.add('int_bezelbody', oriented_box(panel_pt(o0[0] + (a0 + a1) / 2, o0[1] + (b0 + b1) / 2, BEZEL_D + 0.003), R, U, N,
                                                a1 - a0, b1 - b0, 0.004))

    # ---- centre column between the pairs: load-access placard, ESIS standby display, standby clock, cursor knob
    cw = 2 * (MFD_X[1] - BEZEL_W / 2) - 0.012
    cu0 = -cw / 2
    pc = pplate('ctr', cu0, 0.005, cw, 0.29, bg='#2a2c2f', screws=True)
    pc.box(0.012, 0.150, 0.080, 0.262, fill='#dcdcd2', ol='#101010', w=0.0008)
    pc.text(0.046, 0.254, 'LOAD ACCESS', 0.0033, c='#101010')
    for r in range(11):
        yy = 0.243 - r * 0.0085
        pc.line([(0.014, yy + 0.004), (0.078, yy + 0.004)], c='#303030', w=0.0004)
        pc.text(0.020, yy, str(r + 1), 0.0024, c='#101010', f='r')
        pc.text(0.050, yy, ('COM 1 COMSEC', 'COM 2 COMSEC', 'COM 3 COMSEC', 'COM 4', 'COM 5', 'IFF', 'EGI', 'SPARE', 'DTS', 'MAP', 'SPARE')[r],
                0.0022, c='#101010', f='r')
    # ESIS: raised case + square display (unpowered attitude picture, dim)
    es_u, es_v = cw / 2 + 0.018, 0.225
    A.add('int_bezelbody', oriented_box(panel_pt(cu0 + es_u, es_v, 0.022), R, U, N, 0.092, 0.092, 0.044))
    pe = P.plate(A, 'esis', panel_pt(cu0 + es_u - 0.046, es_v - 0.046, 0.044), R, U, N, 0.092, 0.092, bg='#303236', thick=0.002, screws=False)
    pe.box(0.012, 0.014, 0.080, 0.082, fill='#07080a', ol='#1a1a1a', r=0.002)
    pe.box(0.016, 0.050, 0.076, 0.078, fill='#122036')
    pe.box(0.016, 0.018, 0.076, 0.050, fill='#2c2016')
    pe.line([(0.030, 0.050), (0.062, 0.050)], c='#8a8a80', w=0.0012)
    pe.knob(0.012, 0.007, None, r=0.0045, h=0.009, scale=False)
    pe.knob(0.080, 0.007, None, r=0.0045, h=0.009, scale=False)
    pc.text(es_u, 0.279, 'MAIN CAL', 0.0024)
    # standby clock (round, dark face)
    ck_u, ck_v = es_u, 0.118
    A.add('int_bezelbody', cplib.place(prim_cylinder(0.036, 0.036, 0.022, n=24), cplib.frame(panel_pt(cu0 + ck_u, ck_v, 0.0), R, U, N)))
    pk = P.plate(A, 'clock', panel_pt(cu0 + ck_u - 0.032, ck_v - 0.032, 0.022), R, U, N, 0.064, 0.064, bg='#0d0d0e', thick=0.001,
                 screws=False, border=False)
    pk.circle(0.032, 0.032, 0.030, fill='#0b0b0b', ol='#707070', w=0.001)
    pk.scale(0.032, 0.032, 0.024, 0.029, n=12, a0=0, a1=330, labels=['12', '', '', '3', '', '', '6', '', '', '9', '', ''], lh=0.0036)
    pk.line([(0.032, 0.032), (0.032, 0.052)], c='#e8e8e0', w=0.0012)
    pk.line([(0.032, 0.032), (0.046, 0.028)], c='#e8e8e0', w=0.0015)
    pc.text(ck_u, 0.074, 'ETL', 0.0026)
    pc.knob(ck_u + 0.038, 0.090, None, r=0.004, h=0.008, scale=False)
    # cursor control dome at the bottom of the column
    pc.add('int_knob', prim_sphere(0.012, n=14, m=8, center=(0, 0, 0.002), scale=(1, 1, 0.7)), cw / 2, 0.035, 0.0)
    pc.circle(cw / 2, 0.035, 0.016, fill=None, ol='#8a8a80', w=0.0008)
    pc.text(cw / 2, 0.013, 'CURSOR', 0.0024)

    # ---- control strips under the MFD pairs
    for side, s in (('pilot', 1), ('copilot', -1)):
        xo, xi = (MFD_X[0], MFD_X[1]) if s > 0 else (MFD_X[3], MFD_X[2])
        # outboard strip: display select keys
        u0 = xo - BEZEL_W / 2 if s > 0 else xo - BEZEL_W / 2
        so = pplate(f'dsel_{side}', xo - BEZEL_W / 2, -0.035, BEZEL_W, 0.058, bg='#2a2c2f')
        for k, lab in enumerate(('PFD', 'NAV', 'ENG', 'FUEL', 'SYS')):
            uu = (0.030 + k * 0.024) if s < 0 else (BEZEL_W - 0.126 + k * 0.024)
            so.button(uu, 0.030, 0.019, 0.019, legend=lab, lc='#c9c9bd')
        so.text(BEZEL_W / 2 + (0.07 if s < 0 else -0.07), 0.030, 'DISPLAY SEL', 0.0026)
        # inboard strip: flight director / navigation control panel (two concentric knobs, readout windows, 5 knobs)
        dc = pplate(f'dcp_{side}', xi - BEZEL_W / 2, -0.080, BEZEL_W, 0.104, bg='#2a2c2f')
        for k, lab in enumerate(('HDG', 'CRS')):
            dc.knob(0.024, 0.074 - k * 0.036, None, r=0.0075, h=0.012, style='concentric', scale=False)
            dc.text(0.024, 0.059 - k * 0.036, lab, 0.0022)
        for r in range(2):
            for c_ in range(3):
                u_ = 0.058 + c_ * 0.066
                dc.box(u_, 0.060 - r * 0.028, u_ + 0.058, 0.082 - r * 0.028, fill='#0a0b0a', ol='#141414', r=0.001)
                dc.text(u_ + 0.029, 0.071 - r * 0.028, ('263', '240', '1500', '121.50', '243.00', '1200')[r * 3 + c_], 0.0048,
                        f='d', c='#2f3a2e')
        for k in range(5):
            dc.knob(0.078 + k * 0.040, 0.019, None, r=0.0068, h=0.012, scale=False)
            dc.text(0.078 + k * 0.040, 0.005, 'PUSH', 0.0019)
        # master warning panel hanging under the glare-shield lip at the outboard corner, turned toward the pilot
        T = panel_pt(s * 0.66, P_V1, 0)
        yaw = math.radians(-s * 16)
        mR = Vector((math.cos(yaw), math.sin(yaw), 0))
        mN = Vector((0, -1, 0.10))
        mN = (mN - mR * mN.dot(mR)).normalized()
        mU = mN.cross(mR).normalized() * -1
        if mU.z < 0:
            mU = -mU
        o = Vector((s * 0.66, T.y - 0.205, T.z - 0.040)) - mR * 0.075
        box = oriented_box(o + mR * 0.075 + mU * 0.024 - mN * 0.03, mR, mU, mN, 0.15, 0.048, 0.06)
        A.add('int_bezelbody', box)
        mw = P.plate(A, f'mwp_{side}', o, mR, mU, mN, 0.15, 0.048, bg='#1c1d1f', thick=0.002, screws=False)
        for k, (lab, c) in enumerate((('MASTER\nCAUTION', '#b8902a'), ('FIRE', '#b03a2a'), ('LOW\nROTOR', '#b03a2a'), ('ENG\nOUT', '#b8902a'))):
            mw.annunciator(0.021 + k * 0.036, 0.024, lab, w=0.032, h=0.034, c=c)
    # small placards on the lower panel edge (copilot side: secure-radio note; pilot side: ICS)
    pm = pplate('plac_l', -0.33, -0.125, 0.16, 0.030, bg='#e0e0d6', screws=False, border=False)
    pm.text(0.08, 0.019, 'NON-SECURE RADIOS WILL BE MONITORED', 0.0021, c='#141414', f='r')
    pm.text(0.08, 0.009, 'WHEN USING ANY SECURE RADIO', 0.0021, c='#141414', f='r')
    pr = pplate('plac_r', 0.17, -0.125, 0.16, 0.030, bg='#e0e0d6', screws=False, border=False)
    pr.text(0.08, 0.019, 'ICS CONF  1  2  3  4', 0.0024, c='#141414', f='r')
    # standby magnetic compass on the windshield centre post
    A.add('int_black', prim_rbox((0.075, 0.065, 0.07), (0, 3.62, 1.86), r=0.012, n=2))
    A.add('int_frame', prim_box((0.02, 0.05, 0.08), center=(0, 3.66, 1.82)))
    return objs


# ---------------------------------------------------------------------------------------------- lower console
def build_console(M, P, A):
    A.add('int_structure', console_block())
    # --- sloped front: two CDUs rolled toward their pilots, emergency switch strip between them
    o, R, U, N, L = cdu_frame()
    for k, s in enumerate((-1, 1)):
        roll = math.radians(s * 11)
        Rr = (Matrix.Rotation(roll, 3, U) @ R).normalized()
        Nr = Rr.cross(U).normalized()
        w, h = 0.172, 0.305
        c0 = CON_F + (CON_T - CON_F) * 0.5 + Vector((s * 0.128, 0, 0))
        base = c0 - Rr * (w / 2) - U * (h / 2) + Nr * 0.035
        A.add('int_bezelbody', oriented_box(c0 + Nr * 0.017, Rr, U, Nr, w - 0.004, h - 0.004, 0.036))
        cd = P.plate(A, f'cdu_{k}', base, Rr, U, Nr, w, h, bg='#2e3033', thick=0.003, screws=False, edgewear=14.0)
        cd.box(0.034, 0.212, w - 0.034, 0.292, fill='#070908', ol='#1a1a1a', r=0.002)
        for r, line in enumerate(('  FLT PLAN     1/2', 'KNGZ          24', 'ALMDA   263  1.8', 'SFO  VOR  115.8', '', 'EXEC      RTE>')):
            cd.text(0.038, 0.284 - r * 0.0125, line, 0.0048, f='c', c='#23391f', a='lm')
        for r in range(6):
            yy = 0.283 - r * 0.0125
            for xx in (0.017, w - 0.017):
                cd.button(xx, yy, 0.016, 0.0095, legend='')
        rows = (['IDX', 'FPLN', 'DIR', 'PERF', 'MARK'], ['NAV', 'COM', 'IFF', 'MSG', 'MENU'], list('ABCDEF'), list('GHIJKL'),
                list('MNOPQR'), list('STUVWX'), ['Y', 'Z', '-', '/', 'SP', 'CLR'], list('123456'), list('789.0') + ['+/-'])
        for r, keys in enumerate(rows):
            n = len(keys)
            for c_, kname in enumerate(keys):
                xx = 0.012 + (c_ + 0.5) * (w - 0.024) / n
                yy = 0.192 - r * 0.0205
                cd.button(xx, yy, (w - 0.024) / n - 0.0035, 0.0145, legend=kname)
        cd.text(w / 2, 0.006, 'CDU ' + ('CPLT' if s < 0 else 'PLT'), 0.0024)
    em = P.plate(A, 'emer', o + R * (CON_W / 2 - 0.036) + U * 0.02 + N * 0.001, R, U, N, 0.072, L - 0.04, bg='#26282b', thick=0.003)
    em.text(0.036, L - 0.052, 'FMS-2', 0.0026)
    for k, (lab, g) in enumerate((('FMS-1', False), ('EGI', False), ('EMER\nCONTROL', True), ('ZEROIZE', True), ('BACKUP', False))):
        em.toggle(0.036, L - 0.085 - k * 0.052, lab if '\n' not in lab else None, pos=('ON', 'OFF'), guard=g)
        if '\n' in lab:
            em.text(0.036, L - 0.066 - k * 0.052, lab.replace('\n', ' '), 0.0022)
    # --- aft top: palm rests behind the CDUs, stabilator / AFCS / switch panels, parking brake, accumulator gauge
    o, R, U, N, L = console_frame()
    for s in (-1, 1):
        pr_c = CON_F + Vector((s * 0.160, -0.09, 0.055))
        A.add('int_palmrest', prim_rbox((0.18, 0.17, 0.09), tuple(pr_c), r=0.04, n=3))
        A.add('int_palmrest', prim_rbox((0.16, 0.15, 0.025), tuple(pr_c + Vector((0, 0.005, 0.05))), r=0.012, n=2))

    def cplate(name, v0, u0, w, h, **kw):
        return P.plate(A, name, o + R * u0 + U * v0 + N * 0.0005, R, U, N, w, h, **kw)

    Wc = 0.21
    u0 = CON_W / 2 - Wc / 2
    v = L - 0.015
    h = 0.075
    v -= h
    st = cplate('stab', v, u0, Wc, h)
    st.text(0.052, h - 0.008, 'STABILATOR', 0.0027)
    st.toggle(0.035, 0.030, 'MAN SLEW', pos=('UP', 'DOWN'))
    st.button(0.095, 0.034, 0.016, 0.016, label='TEST', key='int_red')
    st.text(0.160, h - 0.008, 'CONTROL', 0.0027)
    st.button(0.160, 0.034, 0.036, 0.022, legend='AUTO\nCONTROL')
    h = 0.100
    v -= h + 0.004
    af = cplate('afcs', v, u0, Wc, h)
    af.text(Wc / 2, h - 0.008, 'AUTO FLIGHT CONTROL', 0.0028)
    for k, lab in enumerate(('SAS 1', 'SAS 2', 'TRIM', 'FPS')):
        af.button(0.030 + k * 0.050, 0.064, 0.034, 0.020, legend=lab)
    for k, lab in enumerate(('SAS/BOOST', '', 'FAILURE\nRESET', '')):
        af.button(0.030 + k * 0.050, 0.026, 0.034, 0.020, legend=lab)
    h = 0.080
    v -= h + 0.004
    sw = cplate('misc', v, u0, Wc, h)
    for k, (lab, pos) in enumerate((('COIL 1', ('', 'OFF')), ('RADALT', ('ON', 'OFF')), ('IFF', ('NORM', 'HOLD')), ('COIL 2', ('', 'OFF')))):
        sw.toggle(0.028 + k * 0.051, 0.036, lab, pos=pos)
    sw.text(0.130, 0.006, 'M4 HOLD', 0.0022)
    h = 0.070
    v -= h + 0.004
    pb = cplate('pbrake', v, u0, Wc, h)
    pb.add('int_black', cplib.t_handle(0.085, 0.022, 0.03), Wc / 2, 0.040, 0.0)
    pb.box(Wc / 2 - 0.046, 0.052, Wc / 2 + 0.046, 0.066, fill='#d8d8cc', ol='#101010')
    pb.text(Wc / 2, 0.059, 'PARKING BRAKE', 0.0036, c='#101010')
    # side plates with Dzus fasteners either side of the centre stack + accumulator pressure gauge (aft left)
    for s in (-1, 1):
        sp = cplate(f'side_{"l" if s < 0 else "r"}', 0.012, (0.012 if s < 0 else CON_W / 2 + Wc / 2 + 0.006), CON_W / 2 - Wc / 2 - 0.018,
                    L - 0.20, bg='#27292c', ppm=1000.0)
        for k in range(6):
            sp.add('int_metal', cplib.dzus(0.003), 0.012, 0.02 + k * (L - 0.24) / 5, 0.0)
            sp.add('int_metal', cplib.dzus(0.003), CON_W / 2 - Wc / 2 - 0.03, 0.02 + k * (L - 0.24) / 5, 0.0)
    gg = cplate('gauge', 0.012, 0.030, 0.10, 0.075, bg='#27292c', screws=False, border=False)
    gg.add('int_bezelbody', prim_cylinder(0.030, 0.030, 0.012, n=24), 0.05, 0.040, 0.0)
    gg.face_quad(0.022, 0.012, 0.078, 0.068, 0.0125)
    gg.circle(0.05, 0.040, 0.026, fill='#e8e8e0', ol='#202020', w=0.001)
    gg.box(0.030, 0.042, 0.042, 0.050, fill='#b02020')
    gg.box(0.042, 0.042, 0.058, 0.050, fill='#d0b020')
    gg.box(0.058, 0.042, 0.070, 0.050, fill='#20a040')
    gg.line([(0.05, 0.032), (0.062, 0.050)], c='#101010', w=0.0012)
    gg.text(0.05, 0.030, 'UTIL ACCUM', 0.0022, c='#101010')


# ---------------------------------------------------------------------------------------------- upper console
def build_overhead(M, P, A):
    o, R, U, N, L = overhead_frame()
    A.add('int_structure', overhead_block())

    def oplate(name, v0, u0, w, h, **kw):
        return P.plate(A, name, o + R * u0 + U * v0 + N * 0.0005, R, U, N, w, h, **kw)

    W = OVH_W - 0.02
    v = 0.01
    # --- engine control quadrant (front end): ENG EMER OFF T-handles, 2 engine power control levers (inboard),
    #     2 fuel selector levers (outboard), rotor brake handle (right). Plate v runs aft, so forward = -v.
    h = 0.20
    q = oplate('quadrant', v, 0.01, W, h, bg='#1b1c1e')
    v += h + 0.004
    q.text(W / 2, 0.056, 'ENG EMER OFF', 0.0032, c='#e0dcd0')
    for k, (u, lab) in enumerate(((W / 2 - 0.085, '1'), (W / 2 + 0.085, '2'))):
        q.add('int_red', cplib.t_handle(0.085, 0.026, 0.03), u, 0.030, 0.0)
        q.text(u, 0.066, 'ENG ' + lab, 0.0028)
        q.stripes(u - 0.05, 0.006, u + 0.05, 0.011, s=0.004)
    labs = (('FUEL SEL', -0.125), ('ENG PWR CONT', -0.045), ('ENG PWR CONT', 0.045), ('FUEL SEL', 0.125))
    ang = -22.0
    for k, (lab, du) in enumerate(labs):
        u = W / 2 + du
        q.box(u - 0.008, 0.080, u + 0.008, 0.180, fill='#060606', ol='#333', r=0.004)
        q.text(u, 0.190, lab, 0.0022)
        for t_, lb in enumerate(('FLY', 'IDLE', 'OFF') if 'ENG' in lab else ('XFD', 'DIR', 'OFF')):
            q.text(u + (0.019 if du > 0 else -0.019), 0.092 + t_ * 0.036, lb, 0.0022)
        key = 'int_knob' if 'ENG' in lab else 'int_fuelknob'
        q.add('int_metal', cplib.lever_quadrant_lever(0.07, 0.03, 0.026, 0.034, angle_deg=ang), u, 0.118, 0.0)
        tip = Vector((0, math.sin(math.radians(ang)) * 0.07, math.cos(math.radians(ang)) * 0.07))
        q.add(key, prim_rbox((0.032, 0.03, 0.028), tuple(tip), r=0.009, n=3), u, 0.118, 0.0)
    for uu in (0.004, W + 0.016):     # yellow / black striped emergency handles at the front corners
        q.add('int_yellow', prim_rbox((0.022, 0.07, 0.02), (0, 0, 0.03), r=0.006, n=2), uu, 0.04, 0.0)
        q.add('int_black', prim_box((0.023, 0.012, 0.021), center=(0, 0.0, 0.03)), uu, 0.04, 0.0)
    rbu = W - 0.012
    q.add('int_red', prim_rbox((0.018, 0.10, 0.018), (0, 0, 0.045), r=0.006, n=2), rbu, 0.13, 0.0)
    q.add('int_metal', prim_box((0.01, 0.01, 0.045), center=(0, -0.03, 0.022)), rbu, 0.13, 0.0)
    q.text(rbu - 0.004, 0.060, 'ROTOR\nBRAKE', 0.0024, c='#e0dcd0')
    # --- system panels
    rows = [
        ('ENGINE START / APU', [('tog', 'ENG 1 START'), ('tog', 'ENG 2 START'), ('tog', 'APU CONT'), ('tog', 'APU GEN'), ('gtog', 'APU FIRE EXT')]),
        ('FUEL PUMP / ELECT', [('tog', 'FUEL PUMP'), ('tog', 'BOOST 1'), ('tog', 'BOOST 2'), ('tog', 'GEN 1'), ('tog', 'GEN 2'), ('tog', 'BATT')]),
        ('ANTI-ICE', [('tog', 'ENG 1'), ('tog', 'ENG 2'), ('tog', 'PITOT'), ('tog', 'WSHLD'), ('knob', 'BLADE')]),
        ('EXTERIOR LIGHTS', [('tog', 'POSITION'), ('tog', 'ANTI COL'), ('knob', 'FORMATION'), ('tog', 'IR'), ('tog', 'SEARCH')]),
        ('WIPERS / HYD', [('knob', 'WIPER'), ('tog', 'BACKUP PUMP'), ('tog', 'SERVO 1'), ('tog', 'SERVO 2'), ('tog', 'TAIL SERVO')]),
    ]
    for name, ctrls in rows:
        h = 0.074
        if v + h > L - 0.15:
            break
        pl = oplate(name.split()[0].lower(), v, 0.01, W, h)
        v += h + 0.004
        pl.text(W / 2, h - 0.0075, name, 0.0029)
        n = len(ctrls)
        for k, (typ, lab) in enumerate(ctrls):
            u = 0.03 + (k + 0.5) * (W - 0.06) / n
            if typ == 'knob':
                pl.knob(u, 0.034, lab, r=0.0072, labels=['OFF', '', '', '', 'HI'])
            else:
                pl.toggle(u, 0.030, lab, pos=('ON', 'OFF'), guard=(typ == 'gtog'))
    # --- circuit breaker panel (aft end)
    h = L - 0.01 - v
    if h > 0.05:
        cbp = oplate('cb', v, 0.01, W, h, bg='#1b1c1e')
        cbp.text(W / 2, h - 0.007, 'NO. 1 AC / DC PRIMARY BUS', 0.0026)
        rows_n = int((h - 0.02) / 0.028)
        names = ['FUEL', 'IGN', 'START', 'AFCS', 'MFD', 'CDU', 'EGI', 'RAD ALT', 'ICS', 'VHF', 'UHF', 'IFF', 'LTS', 'WIPER']
        for r in range(rows_n):
            for c_ in range(11):
                u = 0.022 + c_ * (W - 0.044) / 10
                vv = h - 0.026 - r * 0.028
                cbp.cb(u, vv, ('5', '7.5', '10', '3', '15')[(r + c_) % 5], names[(r * 11 + c_) % len(names)] if r % 2 == 0 else None)


# ---------------------------------------------------------------------------------------------- cockpit structure
def build_cockpit_structure(A):
    # floor with non-skid mats and the pedal wells
    fl = []
    for yy in np.linspace(4.05, 2.45, 9):
        xw = inner_halfwidth(yy, FLOOR_CP + 0.02, 0.04)
        fl.append(np.array([(-xw, yy, FLOOR_CP), (xw, yy, FLOOR_CP)]))
    v, f = loft_rings(fl, closed=False)
    A.add('int_floor_cp', (v, [ff[::-1] for ff in f]), keep=True)
    for s in (-1, 1):
        A.add('int_rubber', prim_box((0.46, 0.60, 0.006), center=(s * SEAT_X, 3.62, FLOOR_CP + 0.003)))
    # door sills / jettison handles (yellow-black) and interior door handles
    for s in (-1, 1):
        xw = inner_halfwidth(3.0, 1.0, 0.05)
        A.add('int_structure', prim_box((0.05, 1.0, 0.10), center=(s * (xw - 0.02), 3.05, 0.93)))
        xh = inner_halfwidth(2.70, 1.60, 0.06)
        A.add('int_yellow', prim_rbox((0.03, 0.14, 0.03), (s * xh, 2.70, 1.60), r=0.008, n=2))
        A.add('int_black', prim_box((0.032, 0.02, 0.032), center=(s * xh, 2.66, 1.60)))
        A.add('int_black', prim_box((0.032, 0.02, 0.032), center=(s * xh, 2.74, 1.60)))
        xd = inner_halfwidth(3.05, 1.22, 0.06)
        A.add('int_metal', prim_tube([(s * xd, 2.92, 1.22), (s * (xd - 0.04), 2.94, 1.22), (s * (xd - 0.04), 3.12, 1.22),
                                      (s * xd, 3.14, 1.22)], 0.011, n=6))
        # map / utility light on the door frame (swivel) and a map case below the side window
        xw2 = inner_halfwidth(2.62, 1.98, 0.06)
        A.add('int_black', prim_cylinder(0.022, 0.026, 0.09, n=12, axis='Y', center=(s * (xw2 - 0.03), 2.62, 1.95)))
        A.add('int_kit', prim_box((0.05, 0.40, 0.22), center=(s * (inner_halfwidth(2.75, 0.95, 0.06) - 0.03), 2.70, 0.92)))
    # roof trim either side of the upper console and the windshield centre post cover
    for s in (-1, 1):
        A.add('int_structure', prim_box((0.26, 0.90, 0.03), center=(s * 0.34, 2.72, 2.17)))
    # portable fire extinguisher between the seats (behind the console)
    A.add('int_red', prim_cylinder(0.055, 0.055, 0.34, n=16, axis='Y', center=(0.0, 2.36, FLOOR_CP + 0.09)))
    A.add('int_black', prim_cylinder(0.02, 0.02, 0.07, n=10, axis='Y', center=(0.0, 2.38 + 0.34, FLOOR_CP + 0.09)))
    A.add('int_frame', prim_box((0.14, 0.04, 0.02), center=(0, 2.45, FLOOR_CP + 0.01)))


def seat_side_plate(P, A, sx):
    """'NO HANDLE' stencil on the outboard face of the sliding side armour (as on UH-60M crew seats)."""
    so = 1 if sx > 0 else -1
    ta = math.radians(13)
    up = Vector((0, -math.sin(ta), math.cos(ta)))
    fw = Vector((0, math.cos(ta), math.sin(ta)))
    base = Vector((sx, SEAT_Y0 - 0.50, SEAT_ZP - 0.04))
    c = base + up * 0.48 + Vector((so * 0.301, 0, 0)) + fw * 0.05
    R = fw if so > 0 else -fw
    N = Vector((so, 0, 0))
    w, h = 0.34, 0.52
    o = c - R * (w / 2) - up * (h / 2)
    pl = P.plate(A, f'seatarm_{"R" if so > 0 else "L"}', o, R, up, N, w, h, bg='#1e1f20', thick=0.0015, screws=False,
                 border=False, edgewear=6.0, mottle=2.5, ppm=900.0)
    pl.text(w / 2, 0.06, 'NO  HANDLE', 0.016, f='d', c='#d8d8cc')


def ics_cords(A):
    """Coiled ICS cords hanging from the cabin ceiling at the gunner stations and behind the crew seats."""
    for (x, y) in ((0.72, 2.05), (-0.72, 2.05), (0.35, 2.30), (-0.35, 2.30)):
        top = Vector((x, y, 2.14))
        pts = [top]
        for k in range(28):
            a = k * 1.2
            pts.append(Vector((x + 0.012 * math.cos(a), y + 0.012 * math.sin(a), 2.08 - k * 0.012)))
        A.add('int_black', prim_tube(pts, 0.005, n=5))
        plug = pts[-1] - Vector((0, 0, 0.05))
        A.add('int_yellow', prim_cylinder(0.011, 0.011, 0.07, n=10, center=tuple(plug)))
        A.add('int_black', prim_cylinder(0.018, 0.018, 0.012, n=10, center=tuple(top - Vector((0, 0, 0.01)))))


# ---------------------------------------------------------------------------------------------- orchestration
def build_interior(M, parent):
    import mats
    mats.interior_materials(M)
    P = plates.Plates(page='lbl', ppm=2400.0)
    Apn = Acc('int_panels')
    Acn = Acc('int_consoles')
    Acp = Acc('int_cockpit')
    Acb = Acc('int_cabin')
    objs = []
    objs += build_panel(M, P, Apn, parent)
    build_console(M, P, Acn)
    build_overhead(M, P, Acn)
    build_cockpit_structure(Acp)
    for s in (-1, 1):
        sx = s * SEAT_X
        crew.crew_seat(Acp, sx, SEAT_Y0, SEAT_ZP, FLOOR_CP)
        seat_side_plate(P, Acp, sx)
        crew.cyclic(Acp, sx, 3.30, FLOOR_CP)
        crew.collective(Acp, sx, FLOOR_CP)
        crew.pedals(Acp, sx, FLOOR_CP, 3.86)
    cabin.build_cabin(Acb, Acb)
    ics_cords(Acb)
    # label plates -> texture page (venv PIL) -> material
    import tempfile
    tdir = os.path.join(tempfile.gettempdir(), 'uh60_build_cache', 'cptex')
    os.makedirs(tdir, exist_ok=True)
    lay = os.path.join(tdir, 'layout.json')
    P.write(lay)
    venv = os.path.join(HERE, '..', '..', '..', '.venv', 'bin', 'python')
    r = subprocess.run([venv, os.path.join(HERE, 'cptex.py'), lay, tdir], capture_output=True, text=True)
    print(r.stdout[-1500:], r.stderr[-3000:], flush=True)
    if r.returncode != 0:
        raise RuntimeError('cptex failed')
    mats.textured_material(M['int_labels'], os.path.join(tdir, 'lbl.png'))
    import tempfile as _t
    ttex = os.path.join(_t.gettempdir(), 'uh60_build_cache', 'tex')
    subprocess.run([venv, os.path.join(HERE, 'intex.py'), ttex], capture_output=True, text=True)
    mats.box_textured(M['int_quiltpad'], os.path.join(ttex, 'int_quilt.jpg'), tile=0.45)
    mats.box_textured(M['int_floor'], os.path.join(ttex, 'int_floor.jpg'), tile=0.5, blend=0.0)
    for A in (Apn, Acn, Acp, Acb):
        objs += A.build(M, parent)
    objs += P.build_quads(M, parent)
    for o in objs:
        if o.name.startswith('screen_'):
            continue
        clamp_inside(o)
    print(f'[uh60] interior plates: {len(P.plates)}', flush=True)
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
    if moved > 50:
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
