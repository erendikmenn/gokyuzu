"""A320 flight deck geometry (node `interior`): lining shell with window reveals, floor, rear bulkhead + door,
main instrument panel with 7 display surfaces (screen_*), glareshield (FCU/EFIS), pedestal (MCDUs, thrust quadrant),
overhead panel, side consoles with sidesticks and tillers, two pilot seats, rudder pedals, sun visors, standby
compass. Panel artwork comes from the atlas painted by cockpit_tex.py from the same cockpit_layout.py data.

Animated nodes (rig in model.js): ck_thr_1/2, ck_sb_lever, ck_flap_lever, ck_gear_lever, ck_stick_capt/fo,
ck_pedal_{capt,fo}_{L,R}. Pivots: local frame = world axes, origin on the pivot.
"""
import math
import os
import numpy as np
import bpy
from mathutils import Matrix, Vector
import geo
import layout as LY
import cockpit_layout as CL

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, 'build', 'tex')
B = CL.B


def _img(name):
    p = os.path.join(TEX, name)
    return bpy.data.images.load(p, check_existing=True) if os.path.exists(p) else None


def materials():
    P = geo.principled
    m = {}
    m['panel'] = P('ck_panel', color=(0.30, 0.34, 0.40), roughness=0.62, tex=_img('ck_atlas.jpg'),
                   emission=(1, 1, 1), emission_strength=1.0, emission_tex=_img('ck_atlas_emit.jpg'))
    m['screen'] = P('ck_screen', color=(0.005, 0.006, 0.008), roughness=0.08, emission=(0, 0, 0))
    m['lining'] = P('ck_lining', color=(0.40, 0.41, 0.40), roughness=0.85, tex=_img('ck_lining.jpg'))
    m['dark'] = P('ck_dark', color=(0.035, 0.038, 0.045), roughness=0.55)
    m['grey'] = P('ck_grey', color=(0.10, 0.115, 0.135), roughness=0.6)
    m['frame'] = P('ck_frame', color=(0.035, 0.037, 0.04), roughness=0.5, double_sided=True)
    m['glare'] = P('ck_glare', color=(0.018, 0.019, 0.021), roughness=0.92)
    m['fabric'] = P('ck_fabric', color=(0.06, 0.07, 0.09), roughness=0.95, tex=_img('ck_fabric.jpg'))
    m['carpet'] = P('ck_carpet', color=(0.05, 0.055, 0.06), roughness=0.98, tex=_img('ck_carpet.jpg'))
    m['metal'] = P('ck_metal', color=(0.55, 0.56, 0.58), metallic=0.9, roughness=0.35)
    m['rubber'] = P('ck_rubber', color=(0.02, 0.02, 0.02), roughness=0.7)
    m['visor'] = P('ck_visor', color=(0.10, 0.08, 0.04), roughness=0.2, alpha=0.55)
    m['plug'] = P('ck_plug_mat', color=(0.02, 0.022, 0.026), roughness=0.9)
    m['knob'] = P('ck_knob', color=(0.05, 0.055, 0.06), roughness=0.45, metallic=0.2)
    m['red'] = P('ck_red', color=(0.55, 0.04, 0.03), roughness=0.5)
    m['leather'] = P('ck_leather', color=(0.055, 0.058, 0.066), roughness=0.62, tex=_img('ck_leather.jpg'))
    m['strap'] = P('ck_strap', color=(0.08, 0.09, 0.12), roughness=0.8)
    m['dome'] = P('ck_dome', color=(0.8, 0.8, 0.78), roughness=0.3, emission=(1.0, 0.95, 0.85), emission_strength=0.4)
    return m


# ================================================================================================ helpers

class Acc:
    """Accumulates quads/tris with per-loop UVs into one mesh."""

    def __init__(self):
        self.v, self.f, self.uv = [], [], []

    def quad(self, pts, uvs):
        base = len(self.v)
        self.v.extend([tuple(p) for p in pts])
        self.f.append(tuple(range(base, base + len(pts))))
        self.uv.extend(uvs)

    def box(self, frame_pts, uv_top, uv_side):
        """frame_pts: 8 corners (bottom 4 then top 4, CCW seen from the top)."""
        b, t = frame_pts[:4], frame_pts[4:]
        self.quad(t, uv_top)
        for k in range(4):
            k2 = (k + 1) % 4
            self.quad([b[k], b[k2], t[k2], t[k]], [uv_side] * 4)

    def build(self, name, col, mat, smooth=False):
        if not self.f:
            return None
        o = geo.mesh_object(name, np.array(self.v), self.f, col=col, mat=mat, smooth=smooth,
                            loop_uvs=np.array(self.uv))
        return o


def atlas_uv(region, px, py):
    x0, y0, w, h = region
    return ((x0 + px * CL.APPM) / CL.ATLAS, 1 - (y0 + py * CL.APPM) / CL.ATLAS)


def panel_geometry(pn, region, acc, knobs, extras, col, mats):
    fr = pn['frame']
    W, H = pn['w'], pn['h']
    uv = lambda x, y: atlas_uv(region, x, y)
    # panel face
    acc.quad([fr.p(0, 0), fr.p(0, H), fr.p(W, H), fr.p(W, 0)], [uv(0, 0), uv(0, H), uv(W, H), uv(W, 0)])
    # thickness rim (towards the back)
    back = -0.03
    for (a, b) in (((0, 0), (W, 0)), ((W, 0), (W, H)), ((W, H), (0, H)), ((0, H), (0, 0))):
        acc.quad([fr.p(*a), fr.p(*b), fr.p(*b, back), fr.p(*a, back)], [uv(0.003, 0.003)] * 4)
    for it in pn['items']:
        k = it[0]
        if k in ('btn', 'gbtn'):
            _, x, y, w, h = it[:5]
            raise_h = 0.007
            pts = [fr.p(x, y), fr.p(x + w, y), fr.p(x + w, y + h), fr.p(x, y + h)]
            top = [fr.p(x, y, raise_h), fr.p(x + w, y, raise_h), fr.p(x + w, y + h, raise_h), fr.p(x, y + h, raise_h)]
            # top quad must face the pilot: order (x,y)->(x,y+h)->(x+w,y+h)->(x+w,y) like the panel
            acc.quad([top[0], top[3], top[2], top[1]], [uv(x, y), uv(x, y + h), uv(x + w, y + h), uv(x + w, y)])
            for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
                acc.quad([pts[b], pts[a], top[a], top[b]], [uv(x + 0.001, y + 0.001)] * 4)
            if k == 'gbtn':
                # guard: red open frame around the button
                g = 0.004
                gp = [fr.p(x - g, y - g, 0.014), fr.p(x + w + g, y - g, 0.014)]
                extras.append(geo.cylinder('guard', gp[0], gp[1], 0.0022, n=6, col=col, mat=mats['red']))
        elif k in ('knob', 'bigknob'):
            _, x, y, r = it[:4]
            h = 0.016 if k == 'knob' else 0.022
            c0 = fr.p(x, y, 0.0)
            c1 = fr.p(x, y, h)
            knobs.append(geo.cylinder('knob', c0, c1, r * 1.05, r * 0.92, n=14, col=col, mat=mats['knob']))
            # pointer line
            knobs.append(geo.box('kptr', tuple(fr.p(x, y - r * 0.5, h + 0.0005)), (0.002, 0.002, 0.002), col=col, mat=mats['metal']))
        elif k == 'toggle':
            _, x, y = it[:3]
            base = fr.p(x, y, 0.0)
            tip = fr.p(x, y - 0.012, 0.022)
            knobs.append(geo.cylinder('tgl', base, tip, 0.0028, 0.0022, n=8, col=col, mat=mats['metal']))
            knobs.append(geo.cylinder('tglb', base, fr.p(x, y, 0.003), 0.007, n=12, col=col, mat=mats['metal']))
        elif k == 'bezel':
            _, x, y, w, h = it
            d = 0.012
            for (a0, a1, b0, b1) in ((x, x + w, y, y + 0.012), (x, x + w, y + h - 0.012, y + h), (x, x + 0.012, y, y + h),
                                     (x + w - 0.012, x + w, y, y + h)):
                pts = [fr.p(a0, b0), fr.p(a1, b0), fr.p(a1, b1), fr.p(a0, b1)]
                top = [fr.p(a0, b0, d), fr.p(a1, b0, d), fr.p(a1, b1, d), fr.p(a0, b1, d)]
                acc.quad([top[0], top[3], top[2], top[1]], [uv(a0, b0), uv(a0, b1), uv(a1, b1), uv(a1, b0)])
                for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
                    acc.quad([pts[b], pts[a], top[a], top[b]], [uv(x + 0.002, y + 0.002)] * 4)
        elif k == 'lcd':
            pass
        elif k == 'mcdu':
            _, x, y, w, h, side = it
            L = CL.mcdu_layout(x, y, w, h)
            for (kx, ky, kw, kh, lab, kind) in L['keys']:
                hh = 0.005
                pts = [fr.p(kx, ky), fr.p(kx + kw, ky), fr.p(kx + kw, ky + kh), fr.p(kx, ky + kh)]
                top = [fr.p(kx, ky, hh), fr.p(kx + kw, ky, hh), fr.p(kx + kw, ky + kh, hh), fr.p(kx, ky + kh, hh)]
                acc.quad([top[0], top[3], top[2], top[1]], [uv(kx, ky), uv(kx, ky + kh), uv(kx + kw, ky + kh), uv(kx + kw, ky)])
                for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
                    acc.quad([pts[b], pts[a], top[a], top[b]], [uv(kx + 0.001, ky + 0.001)] * 4)


def screen_quads(pn, col, mats):
    """screen_* meshes: quads slightly in front of the panel, UV 0..1 (v = 1 at the top edge)."""
    out = []
    fr = pn['frame']
    for it in pn['items']:
        if it[0] != 'screen':
            continue
        _, name, x, y, w, h = it
        z = 0.004
        pts = [fr.p(x, y, z), fr.p(x, y + h, z), fr.p(x + w, y + h, z), fr.p(x + w, y, z)]
        o = geo.mesh_object(name, np.array(pts), [(0, 1, 2, 3)], col=col, mat=mats['screen'], smooth=False,
                            loop_uvs=np.array([(0, 1), (0, 0), (1, 0), (1, 1)]))
        # face must point to the pilot
        o.data.update()
        n = np.array(o.data.polygons[0].normal)
        if np.dot(n, fr.N) < 0:
            geo.flip_normals(o)
        out.append(o)
    return out


# ================================================================================================ shell

LINING_OFF = 0.045


def lining_pts(s, th, off):
    """Points on the fuselage surface pulled radially toward the section centre by `off` meters (no folding at
    the windshield kinks, unlike a normal offset)."""
    s = np.asarray(s, float)
    th = np.asarray(th, float)
    y, z = LY.surface(s, th)
    zc = LY.section_params(s)[0]
    dy, dz = y, z - zc
    r = np.sqrt(dy * dy + dz * dz) + 1e-9
    k = 1 - off / r
    return np.stack([dy * k, geo.S_CG - s * np.ones_like(y), zc + dz * k], -1)


def lining(col, mats):
    """Inner lining (normals facing the cabin), window openings cut radially + reveals to the skin."""
    s_arr = np.r_[np.linspace(1.22, 2.0, 26), np.linspace(2.0, 3.6, 34)[1:], np.linspace(3.6, 4.40, 9)[1:]]
    th = np.linspace(0, 2 * math.pi, 128, endpoint=False)
    S, T = np.meshgrid(s_arr, th, indexing='ij')
    P = lining_pts(S, T, LINING_OFF)
    N, M = P.shape[:2]
    verts = P.reshape(-1, 3)
    faces, luv = [], []
    for i in range(N - 1):
        for j in range(M):
            j2 = (j + 1) % M
            a, b, c, d = i * M + j, i * M + j2, (i + 1) * M + j2, (i + 1) * M + j
            faces.append((a, d, c, b))
            for (ii, jj) in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
                luv.append((s_arr[ii] * 1.6, jj / M * 12.0))
    o = geo.mesh_object('ck_lining', verts, faces, col=col, mat=mats['lining'], loop_uvs=np.array(luv))
    o.data.update()
    nrm = np.zeros(len(o.data.polygons) * 3)
    cen = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('normal', nrm)
    o.data.polygons.foreach_get('center', cen)
    nrm, cen = nrm.reshape(-1, 3), cen.reshape(-1, 3)
    radial = cen.copy()
    radial[:, 1] = 0
    radial[:, 2] -= -0.4
    if np.einsum('ij,ij->i', nrm, radial).sum() > 0:
        geo.flip_normals(o)
    cutters, reveals = [], []
    for side in (1, -1):
        for wn in ('ws', 'slide', 'fixed'):
            prm = LY.ck_window_params(wn, side)
            if side < 0:
                prm = prm[::-1]
            outline = densify(prm, 20)
            cutters.append(radial_prism(outline, col))
            reveals.append(reveal(outline, col, mats))
    cut = geo.join(cutters, 'ckcut')
    geo.boolean(o, cut, 'DIFFERENCE', 'EXACT')
    bpy.data.objects.remove(cut, do_unlink=True)
    o.data.polygons.foreach_set('use_smooth', np.ones(len(o.data.polygons), bool))
    return o, geo.join(reveals, 'ck_reveals')


def densify(params, samples):
    pts = []
    n = len(params)
    for k in range(n):
        s0, t0 = params[k]
        s1, t1 = params[(k + 1) % n]
        for t in np.linspace(0, 1, samples, endpoint=False):
            pts.append((s0 + (s1 - s0) * t, t0 + (t1 - t0) * t))
    return np.array(pts)


def radial_prism(outline, col):
    outer = lining_pts(outline[:, 0], outline[:, 1], -0.03)
    inner = lining_pts(outline[:, 0], outline[:, 1], 0.20)
    m = len(outline)
    verts = np.vstack([outer, inner, outer.mean(0, keepdims=True), inner.mean(0, keepdims=True)])
    co, ci = 2 * m, 2 * m + 1
    faces = []
    for k in range(m):
        k2 = (k + 1) % m
        faces += [(k, k2, m + k2, m + k), (co, k2, k), (ci, m + k, m + k2)]
    o = geo.mesh_object('ckc', verts, faces, col=col, smooth=False)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    return o


def reveal(outline, col, mats):
    outer = lining_pts(outline[:, 0], outline[:, 1], 0.004)
    inner = lining_pts(outline[:, 0], outline[:, 1], LINING_OFF + 0.002)
    m = len(outline)
    verts = np.vstack([outer, inner])
    faces = [(k, (k + 1) % m, m + (k + 1) % m, m + k) for k in range(m)]
    luv = []
    for _ in faces:
        luv += [(0, 0), (1, 0), (1, 1), (0, 1)]
    o = geo.mesh_object('rev', verts, faces, col=col, mat=mats['frame'], loop_uvs=np.array(luv))
    o.data.update()
    c = outer.mean(0)
    nrm = np.zeros(len(o.data.polygons) * 3)
    cen = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('normal', nrm)
    o.data.polygons.foreach_get('center', cen)
    if np.einsum('ij,ij->i', nrm.reshape(-1, 3), c - cen.reshape(-1, 3)).sum() < 0:
        geo.flip_normals(o)
    return o


def lining_halfwidth(s, z):
    ths = np.linspace(0.0, math.pi, 721)
    Pl = lining_pts(np.full_like(ths, s), ths, LINING_OFF)
    yi, zi = Pl[:, 0], Pl[:, 2]
    # nearest point at height z
    k = np.argmin(np.abs(zi - z))
    return float(yi[k])


def floor_and_bulkhead(col, mats):
    objs = []
    ss = np.linspace(1.50, 4.40, 16)
    z = CL.FLOOR_Z
    rows = []
    for s in ss:
        w = lining_halfwidth(s, z) + 0.02
        rows.append([B(s, -w, z), B(s, w, z)])
    acc = Acc()
    for i in range(len(ss) - 1):
        a, b = rows[i], rows[i + 1]
        acc.quad([a[0], b[0], b[1], a[1]], [(ss[i] * 2, 0), (ss[i + 1] * 2, 0), (ss[i + 1] * 2, 6), (ss[i] * 2, 6)])
    fl = acc.build('ck_floor', col, mats['carpet'])
    _face(fl, (0, 0, 1))
    objs.append(fl)
    # rear bulkhead at s = 4.36 (full lining section above the floor) with the cockpit door
    sb = 4.36
    th = np.linspace(0, 2 * math.pi, 96, endpoint=False)
    Pl = lining_pts(np.full_like(th, sb), th, LINING_OFF)
    yi, zi = Pl[:, 0], Pl[:, 2]
    keep = zi >= z - 0.01
    poly = [B(sb, a, max(c, z)) for a, c in zip(yi[keep], zi[keep])]
    # sort around the centre for a clean fan
    cen = np.mean(poly, 0)
    ang = [math.atan2(p[2] - cen[2], p[0] - cen[0]) for p in poly]
    poly = [p for _, p in sorted(zip(ang, poly))]
    verts = [tuple(cen)] + [tuple(p) for p in poly]
    faces = [(0, k + 1, (k + 1) % len(poly) + 1) for k in range(len(poly))]
    luv = [(0.5, 0.5)] * (3 * len(faces))
    bh = geo.mesh_object('ck_bulkhead', np.array(verts), faces, col=col, mat=mats['lining'], smooth=False, loop_uvs=np.array(luv))
    _face(bh, (0, 1, 0))
    objs.append(bh)
    # door (slightly proud of the bulkhead) + handle + viewer
    dw, dh = 0.76, 1.88
    door = geo.box('ck_door', tuple(B(sb - 0.02, 0.0, z + dh / 2 + 0.01)), (dw, 0.04, dh), col=col, mat=mats['grey'])
    handle = geo.box('ck_door_h', tuple(B(sb - 0.05, 0.28, z + 1.02)), (0.12, 0.03, 0.025), col=col, mat=mats['metal'])
    peep = geo.cylinder('ck_peep', B(sb - 0.045, 0.0, z + 1.55), B(sb - 0.03, 0.0, z + 1.55), 0.012, n=10, col=col,
                        mat=mats['metal'])
    objs += [door, handle, peep]
    # jump seats (folded) against the bulkhead
    for yy in (-0.62, 0.62):
        objs.append(geo.box('ck_jump', tuple(B(sb - 0.07, yy, z + 0.95)), (0.42, 0.10, 0.62), col=col, mat=mats['fabric'], bevel=0.015))
    return objs


def _face(o, direction):
    o.data.update()
    nrm = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('normal', nrm)
    if np.dot(nrm.reshape(-1, 3).sum(0), direction) < 0:
        geo.flip_normals(o)


# ================================================================================================ structures

def glareshield(col, mats):
    """Glareshield body: anti-glare top reaching forward under the windshield frame, front face behind the FCU."""
    ys = np.linspace(-0.80, 0.80, 33)
    rings = []
    for yv in ys:
        k = abs(yv) / 0.80
        s_front = CL.GS_FRONT_S
        z_top = CL.GS_TOP_Z - 0.012 * k ** 2
        # forward end: as far forward as the lining allows (stays 2.5 cm inside it)
        z_fwd = 0.405 - 0.03 * k
        s_fwd = s_front - 0.06
        for s_try in np.arange(s_front - 0.06, 1.25, -0.01):
            ths = np.linspace(-1.4, 1.4, 281)
            Pl = lining_pts(np.full_like(ths, s_try), ths, LINING_OFF)
            j = np.argmin(np.abs(Pl[:, 0] - yv))
            if Pl[j, 2] < z_fwd + 0.025 or abs(Pl[j, 0] - yv) > 0.02:
                break
            s_fwd = s_try
        prof = [(s_fwd, CL.FCU_BOT_Z - 0.03), (s_fwd, z_fwd), (0.5 * (s_fwd + s_front), 0.5 * (z_fwd + z_top) + 0.012),
                (s_front - 0.005, z_top), (s_front + 0.012, z_top - 0.006), (s_front + 0.016, z_top - 0.02),
                (s_front + 0.020, CL.FCU_BOT_Z - 0.004), (s_front + 0.012, CL.FCU_BOT_Z - 0.012),
                (s_front - 0.10, CL.FCU_BOT_Z - 0.02)]
        rings.append([B(s, yv, zz) for s, zz in prof])
    o = geo.grid_mesh('ck_glareshield', np.array(rings), closed=True, col=col, mat=mats['glare'], cap0=True, cap1=True,
                      auto_orient=True)
    return o


def mip_body(col, mats):
    """Box behind the main instrument panel + knee-area lower fascia under the side panels."""
    objs = []
    t, b = CL.MIP_TOP, CL.MIP_BOT
    # back box (closes the space between panel and nose)
    # knee panels below the side panels, slanted
    for y0, y1 in ((-0.95, -0.265), (0.265, 0.95)):
        objs.append(geo.box('knee', tuple(B(1.66, (y0 + y1) / 2, -0.18)), (y1 - y0, 0.06, 0.36), col=col, mat=mats['dark']))
    return objs


def pedestal_body(col, mats):
    objs = []
    y = CL.PED_Y
    z0 = CL.FLOOR_Z
    # main box under the flat part
    objs.append(geo.box('ped', tuple(B((CL.PED_S1 + CL.PED_S2) / 2, 0, (z0 + CL.PED_FLAT_Z) / 2 - 0.005)),
                        (2 * y, CL.PED_S2 - CL.PED_S1, CL.PED_FLAT_Z - z0 - 0.01), col=col, mat=mats['grey']))
    # under the MCDU incline
    objs.append(geo.box('ped2', tuple(B((CL.PED_S0 + CL.PED_S1) / 2 - 0.02, 0, (z0 + CL.MIP_BOT[1]) / 2 - 0.02)),
                        (2 * y, CL.PED_S1 - CL.PED_S0 + 0.04, CL.MIP_BOT[1] - z0 - 0.04), col=col, mat=mats['grey']))
    return objs


def overhead_body(col, mats):
    """Side walls of the overhead panel, from the panel edge up to the ceiling lining."""
    fr, H = CL.ovh_frame()
    W = CL.OVH_W
    acc = Acc()
    edge = []
    for x, y in ((0, 0), (W, 0), (W, H), (0, H)):
        p = fr.p(x, y)
        s = CL.S_CG - p[1]
        # ceiling lining height at (s, y)
        ths = np.linspace(-0.9, 0.9, 181)
        Pl = lining_pts(np.full_like(ths, s), ths, LINING_OFF)
        k = np.argmin(np.abs(Pl[:, 0] - p[0]))
        edge.append((p, np.array([p[0], p[1], Pl[k, 2] + 0.02])))
    for a, b2 in ((0, 1), (1, 2), (2, 3), (3, 0)):
        (pa, ua), (pb, ub) = edge[a], edge[b2]
        acc.quad([pa, pb, ub, ua], [(0, 0), (1, 0), (1, 1), (0, 1)])
    return [acc.build('ck_ovh_box', col, mats['grey'])]


def console_body(col, mats):
    objs = []
    for side in (-1, 1):
        yi, yo = 0.83, 1.12
        yc = side * (yi + yo) / 2
        objs.append(geo.box('cons', tuple(B(2.51, yc, (CL.FLOOR_Z - 0.03) / 2 - 0.015)), (yo - yi, 0.98, -0.03 - CL.FLOOR_Z),
                            col=col, mat=mats['grey']))
        # armrest pad along the inner edge
        objs.append(geo.box('crest', tuple(B(2.62, side * 0.86, 0.02)), (0.07, 0.42, 0.05), col=col, mat=mats['fabric'], bevel=0.012))
        # tiller handwheel (forward on the console)
        c = B(2.155, side * 0.955, 0.0)
        objs.append(geo.cylinder('tiller_hub', c, c + np.array([0, 0, 0.03]), 0.022, n=14, col=col, mat=mats['dark']))
        ring = []
        for k in range(20):
            a = 2 * math.pi * k / 20
            ring.append(c + np.array([0.055 * math.cos(a), 0.055 * math.sin(a), 0.035]))
        for k in range(20):
            objs.append(geo.cylinder('tiller_r', ring[k], ring[(k + 1) % 20], 0.008, n=6, col=col, mat=mats['dark']))
        objs.append(geo.cylinder('tiller_h', ring[5], ring[5] + np.array([0, 0, 0.04]), 0.008, n=8, col=col, mat=mats['dark']))
        # oxygen mask stowage box (aft on the console)
        objs.append(geo.box('oxy', tuple(B(2.85, side * 0.96, 0.03)), (0.17, 0.20, 0.10), col=col, mat=mats['dark'], bevel=0.01))
    return objs


def sidestick(side, col, mats):
    """Grip lofted from ellipses along a curved spine; pivot at the console surface."""
    tag = 'capt' if side < 0 else 'fo'
    base = B(2.47, side * 0.955, -0.03)
    rings = []
    for k, t in enumerate(np.linspace(0, 1, 12)):
        h = 0.20 * t
        # grip leans back slightly and bulges
        cx = 0.0
        cy = -0.02 * t ** 2          # aft (Blender -Y) lean
        rx = 0.020 + 0.012 * math.sin(math.pi * min(t * 1.15, 1)) - 0.004 * (t > 0.85)
        ry = 0.026 + 0.010 * math.sin(math.pi * min(t * 1.1, 1))
        if t < 0.18:
            rx, ry = 0.012, 0.012
        ring = [base + np.array([cx + rx * math.cos(a), cy + ry * math.sin(a), h]) for a in np.linspace(0, 2 * math.pi, 14, endpoint=False)]
        rings.append(ring)
    grip = geo.grid_mesh('grip', np.array(rings), closed=True, col=col, mat=mats['rubber'], cap1=True)
    boot = geo.cylinder('boot', base - np.array([0, 0, 0.01]), base + np.array([0, 0, 0.035]), 0.045, 0.02, n=16, col=col, mat=mats['dark'])
    # priority takeover button (red) + trigger
    btn = geo.cylinder('prio', base + np.array([side * -0.012, 0.012, 0.195]), base + np.array([side * -0.012, 0.012, 0.206]),
                       0.008, n=10, col=col, mat=mats['red'])
    o = geo.join([grip, boot, btn], f'ck_stick_{tag}')
    geo.set_origin(o, base)
    return o


def seat(side, col, mats):
    """Pilot seat (Ipeco-style): sculpted leather cushions with side bolsters, headrest, pivoting armrests,
    4-point harness, seat frame on floor rails."""
    y0 = side * CL.EYE['y']
    SE = geo.superellipsoid
    parts = []
    zc = -0.10
    L = mats['leather']
    # seat pan (slightly tilted back) + side bolsters
    Rp = np.array(Matrix.Rotation(math.radians(-5), 3, 'X'))
    parts.append(SE('pan', B(2.60, y0, zc - 0.035), (0.46, 0.47, 0.09), n=(5, 3), rot=Rp, col=col, mat=L))
    for dy in (-0.215, 0.215):
        parts.append(SE('bol', B(2.61, y0 + dy, zc - 0.005), (0.07, 0.44, 0.10), n=(3, 3), rot=Rp, col=col, mat=L))
    # backrest: reclined 14 deg, lumbar bend, tapering toward the top
    Rb = np.array(Matrix.Rotation(math.radians(-14), 3, 'X'))
    parts.append(SE('back', B(2.86, y0, 0.26), (0.48, 0.11, 0.66), n=(5, 3), rot=Rb, col=col, mat=L,
                    taper=lambda z: 1.0 - 0.10 * z, bend=lambda z: 0.025 * math.sin(math.pi * z)))
    for dy in (-0.225, 0.225):
        parts.append(SE('bbol', B(2.855, y0 + dy, 0.20), (0.07, 0.13, 0.50), n=(3, 3), rot=Rb, col=col, mat=L))
    # headrest
    parts.append(SE('head', B(2.955, y0, 0.70), (0.30, 0.10, 0.19), n=(4, 3), rot=Rb, col=col, mat=L))
    # seat shell (back) - hard plastic
    parts.append(SE('shell', B(2.93, y0, 0.24), (0.50, 0.05, 0.72), n=(6, 5), rot=Rb, col=col, mat=mats['dark']))
    # armrests on posts (outboard one folded up, inboard down)
    for dy, up in ((-0.29, side < 0), (0.29, side > 0)):
        if up:
            parts.append(SE('armu', B(2.80, y0 + dy, 0.36), (0.07, 0.07, 0.34), n=(4, 4), rot=Rb, col=col, mat=L))
        else:
            parts.append(SE('arm', B(2.70, y0 + dy, 0.075), (0.075, 0.34, 0.06), n=(4, 4), col=col, mat=L))
            parts.append(geo.cylinder('armp', B(2.80, y0 + dy, 0.05), B(2.83, y0 + dy, -0.07), 0.015, n=8, col=col, mat=mats['dark']))
    # harness: shoulder straps from the backrest top, lap belt parked on the pan
    for dy in (-0.09, 0.09):
        a = B(2.93, y0 + dy, 0.62)
        b2 = B(2.75, y0 + dy * 0.6, 0.02)
        parts.append(geo.cylinder('strap', a, b2, 0.022, 0.022, n=4, col=col, mat=mats['strap']))
    parts.append(SE('buckle', B(2.66, y0, -0.02), (0.09, 0.03, 0.09), n=(6, 6), col=col, mat=mats['metal']))
    # frame + base + rails
    parts.append(SE('frame', B(2.62, y0, zc - 0.12), (0.40, 0.44, 0.07), n=(8, 8), col=col, mat=mats['dark']))
    parts.append(geo.box('base', tuple(B(2.64, y0, (CL.FLOOR_Z + zc - 0.14) / 2)), (0.30, 0.34, zc - 0.14 - CL.FLOOR_Z),
                         col=col, mat=mats['dark']))
    for dy in (-0.15, 0.15):
        parts.append(geo.box('rail', tuple(B(2.62, y0 + dy, CL.FLOOR_Z + 0.015)), (0.04, 0.78, 0.03), col=col, mat=mats['metal']))
    return geo.join(parts, f'ck_seat_{"capt" if side < 0 else "fo"}')


def pedals(side, col, mats):
    """Rudder/brake pedals: pads on swinging arms hinged at the top, footrest plate below."""
    tag = 'capt' if side < 0 else 'fo'
    out = []
    SE = geo.superellipsoid
    Rt = np.array(Matrix.Rotation(math.radians(28), 3, 'X'))
    for lr, dy in (('L', -0.115), ('R', 0.115)):
        yv = side * CL.EYE['y'] + dy
        hinge = B(1.86, yv, CL.FLOOR_Z + 0.40)
        pad = SE('pd', B(1.94, yv, CL.FLOOR_Z + 0.21), (0.10, 0.028, 0.23), n=(5, 5), rot=Rt, col=col, mat=mats['dark'])
        grip = SE('pdg', B(1.945, yv, CL.FLOOR_Z + 0.21) + np.array([0, 0.012, 0]), (0.085, 0.01, 0.20), n=(6, 6), rot=Rt,
                  col=col, mat=mats['rubber'])
        arm = geo.cylinder('pa', hinge, B(1.95, yv, CL.FLOOR_Z + 0.30), 0.014, n=8, col=col, mat=mats['dark'])
        o = geo.join([pad, grip, arm], f'ck_pedal_{tag}_{lr}')
        geo.set_origin(o, hinge)
        out.append(o)
    return out


def cb_panels(col, mats, region):
    """Circuit-breaker panels on the rear side walls (behind both seats)."""
    x0, y0, w, h = region
    out = []
    for side in (-1, 1):
        s0, s1 = 3.35, 4.15
        z0, z1 = -0.05, 0.62
        yl = [lining_halfwidth(s, (z0 + z1) / 2) * side - side * 0.02 for s in (s0, s1)]
        pts = [B(s0, yl[0], z1), B(s0, yl[0], z0), B(s1, yl[1], z0), B(s1, yl[1], z1)]
        uv = [((x0) / CL.ATLAS, 1 - y0 / CL.ATLAS), ((x0) / CL.ATLAS, 1 - (y0 + h) / CL.ATLAS),
              ((x0 + w) / CL.ATLAS, 1 - (y0 + h) / CL.ATLAS), ((x0 + w) / CL.ATLAS, 1 - y0 / CL.ATLAS)]
        if side > 0:
            pts = [pts[3], pts[2], pts[1], pts[0]]
        o = geo.mesh_object('cb', np.array(pts), [(0, 1, 2, 3)], col=col, mat=mats['panel'], smooth=False, loop_uvs=np.array(uv))
        c = np.mean(pts, 0)
        o.data.update()
        if np.dot(np.array(o.data.polygons[0].normal), np.array([-c[0], 0, 0])) < 0:
            geo.flip_normals(o)
        out.append(o)
    return out


def ceiling(col, mats):
    objs = []
    SE = geo.superellipsoid
    # dome lights + reading lights along the ceiling centre, aft of the overhead panel
    for s in (3.45, 3.95):
        zt = lining_top(s) - 0.012
        objs.append(SE('dome', B(s, 0.0, zt), (0.20, 0.20, 0.03), n=(2, 4), col=col, mat=mats['dome']))
    for side in (-1, 1):
        # map/reading lights + air outlets (gaspers) above each seat, outboard of the overhead panel
        s = 2.75
        y = side * 0.62
        zt = lining_top_at(s, y) - 0.02
        objs.append(SE('rl', B(s, y, zt), (0.08, 0.08, 0.04), n=(2, 3), col=col, mat=mats['grey']))
        objs.append(SE('gasp', B(s + 0.12, y, zt), (0.06, 0.06, 0.035), n=(2, 3), col=col, mat=mats['metal']))
        # assist handle on the side wall above the side windows
        a = B(3.1, side * 1.40, 0.98)
        b2 = B(3.45, side * 1.36, 0.98)
        objs.append(geo.cylinder('hdl', a, b2, 0.014, n=8, col=col, mat=mats['dark']))
        # sliding window crank handle
        objs.append(SE('crank', B(2.45, side * 1.40, 0.42), (0.03, 0.12, 0.05), n=(4, 4), col=col, mat=mats['dark']))
    return objs


def lining_top(s):
    ths = np.array([0.0])
    return float(lining_pts(np.array([s]), ths, LINING_OFF)[0, 2])


def lining_top_at(s, y):
    ths = np.linspace(-1.2, 1.2, 241)
    P = lining_pts(np.full_like(ths, s), ths, LINING_OFF)
    k = np.argmin(np.abs(P[:, 0] - y))
    return float(P[k, 2])


def levers(col, mats):
    out = {}
    z = CL.PED_FLAT_Z
    s_piv = 2.46
    # thrust levers (two), pivot below the pedestal top
    for i, yy in ((1, -0.042), (2, 0.042)):
        piv = B(s_piv, yy, z - 0.10)
        shaft = geo.box('ts', tuple(B(s_piv, yy, z + 0.03)), (0.012, 0.018, 0.26), col=col, mat=mats['metal'])
        handle = geo.box('th', tuple(B(s_piv - 0.005, yy + (-0.012 if i == 1 else 0.012), z + 0.175)), (0.062, 0.05, 0.045),
                         col=col, mat=mats['dark'], bevel=0.012)
        disc = geo.box('tdisc', tuple(B(s_piv + 0.01, yy + (-0.045 if i == 1 else 0.045), z + 0.175)), (0.012, 0.02, 0.02),
                       col=col, mat=mats['red'])
        rev = geo.box('trev', tuple(B(s_piv + 0.03, yy, z + 0.13)), (0.03, 0.012, 0.02), col=col, mat=mats['dark'])
        o = geo.join([shaft, handle, disc, rev], f'ck_thr_{i}')
        geo.set_origin(o, piv)
        out[o.name] = o
    # speedbrake (left) and flaps (right) levers
    for name, yy, knob in (('ck_sb_lever', -0.168, 'flat'), ('ck_flap_lever', 0.168, 'flap')):
        piv = B(2.23, yy, z - 0.02)
        shaft = geo.cylinder('ls', piv, B(2.20, yy, z + 0.10), 0.006, n=8, col=col, mat=mats['metal'])
        if knob == 'flat':
            h = geo.box('lh', tuple(B(2.20, yy, z + 0.11)), (0.05, 0.02, 0.03), col=col, mat=mats['dark'], bevel=0.006)
        else:
            h = geo.box('lh', tuple(B(2.20, yy, z + 0.11)), (0.045, 0.035, 0.02), col=col, mat=mats['dark'], bevel=0.006)
        o = geo.join([shaft, h], name)
        geo.set_origin(o, piv)
        out[name] = o
    # landing gear lever (centre panel, right of the SD): wheel knob on a short arm
    fr = CL.panel_mip_center()['frame']
    piv = fr.p(0.45, 0.38, 0.01)
    arm = geo.cylinder('ga', piv, fr.p(0.45, 0.33, 0.05), 0.007, n=8, col=col, mat=mats['metal'])
    wheel = geo.cylinder('gw', fr.p(0.45, 0.325, 0.045) - fr.U * 0.018, fr.p(0.45, 0.325, 0.045) + fr.U * 0.018, 0.022,
                         n=18, col=col, mat=mats['knob'])
    o = geo.join([arm, wheel], 'ck_gear_lever')
    geo.set_origin(o, piv)
    out['ck_gear_lever'] = o
    return out


def visors_and_misc(col, mats):
    objs = []
    # sun visors stowed at the top of the side windows (tinted plates)
    for side in (-1, 1):
        a = B(2.05, side * 0.82, 0.83)
        b2 = B(2.60, side * 1.05, 0.82)
        pts = [a, b2, b2 + np.array([0, 0, -0.14]), a + np.array([0, 0, -0.14])]
        o = geo.mesh_object('visor', np.array(pts), [(0, 1, 2, 3)], col=col, mat=mats['visor'], smooth=False,
                            loop_uvs=np.array([(0, 0), (1, 0), (1, 1), (0, 1)]))
        objs.append(o)
    # standby compass on the centre post
    c = B(1.93, 0.0, 0.86)
    objs.append(geo.box('ck_compass', tuple(c), (0.07, 0.06, 0.06), col=col, mat=mats['dark'], bevel=0.008))
    # window centre post trim
    return objs


# ================================================================================================ build

def build(col, mats_ext):
    mats = materials()
    root = bpy.data.objects.new('interior', None)
    col.objects.link(root)
    panels = CL.all_panels()
    regions = CL.pack(panels)
    acc = Acc()
    knobs, extras, screens = [], [], []
    for pn in panels:
        panel_geometry(pn, regions[pn['name']], acc, knobs, extras, col, mats)
        screens += screen_quads(pn, col, mats)
    ck_panels = acc.build('ck_panels', col, mats['panel'])
    ck_knobs = geo.join(knobs + extras, 'ck_knobs')
    shell, reveals = lining(col, mats)
    fixed = [shell, reveals, glareshield(col, mats)]
    fixed += floor_and_bulkhead(col, mats)
    fixed += mip_body(col, mats) + pedestal_body(col, mats) + overhead_body(col, mats) + console_body(col, mats)
    fixed += visors_and_misc(col, mats)
    fixed += cb_panels(col, mats, CL.reserved_regions()['cb'])
    fixed += ceiling(col, mats)
    seats = [seat(-1, col, mats), seat(1, col, mats)]
    anim = [sidestick(-1, col, mats), sidestick(1, col, mats)] + pedals(-1, col, mats) + pedals(1, col, mats)
    anim += list(levers(col, mats).values())
    # merge static parts by material to keep draw calls low
    by_mat = {}
    for o in fixed + seats:
        if o is None:
            continue
        key = o.data.materials[0].name if o.data.materials else 'none'
        by_mat.setdefault(key, []).append(o)
    merged = []
    for k, lst in by_mat.items():
        merged.append(geo.join(lst, f'ck_static_{k}'))
    for o in merged + [ck_panels, ck_knobs] + screens + anim:
        if o is not None:
            geo.parent_keep(o, root)
    # exterior 'plug': dark low-poly shell shown instead of the interior when the camera is far away
    plug = plug_shell(col, mats)
    tris = sum(geo.tri_count(o) for o in merged + [ck_panels, ck_knobs] + screens + anim if o is not None)
    print('[cockpit] triangles', tris)
    return root


def plug_shell(col, mats):
    s_arr = np.linspace(1.3, 4.3, 12)
    th = np.linspace(0, 2 * math.pi, 32, endpoint=False)
    S, T = np.meshgrid(s_arr, th, indexing='ij')
    y, z = LY.surface(S, T)
    Nn = LY.normal(S, T)
    P = np.stack([y, geo.S_CG - S, z], -1) - Nn * 0.10
    o = geo.grid_mesh('ck_plug', P, closed=True, col=col, mat=mats['plug'], auto_orient=True)
    geo.flip_normals(o)          # visible from outside through the windows (faces point inward)
    return o
