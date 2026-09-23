"""A320 flight deck geometry (node `interior`, exported as a320neo_cockpit.glb, CONTRACTS-SF.md 6.2.1).

Built from cockpit_layout.py (the same data cockpit_tex.py paints), proportions from the reference photos in
ref/flightdeck/: lining shell with window reveals, sliding side windows with handles, sun visors on rails, windshield
centre post with the standby compass; main instrument panel with 7 display surfaces (screen_*) in raised bezels, stowed
pull-out tables, knee panels and footwells with the rudder pedals; glareshield with FCU / EFIS / warning panels; centre
pedestal (MCDUs, switching + ECAM control panel, RMPs, ACPs, thrust lever drum with detent scale, pitch trim wheels,
engine masters, speed brake / flap levers, park brake, rudder trim, ATC); overhead panel box; side consoles with
side-sticks (stepped boots), tillers, oxygen mask boxes; two Ipeco-style pilot seats; rear bulkhead, door, jump seats,
circuit-breaker panels, dome / map lights.

Every pushbutton cap, key, knob, toggle, guard and bezel is modelled; their legends come from the atlas.

Animated nodes (rig in model.js): ck_thr_1/2, ck_sb_lever, ck_flap_lever, ck_gear_lever, ck_stick_capt/fo,
ck_pedal_{capt,fo}_{L,R}. Pivots: local frame = world axes, origin on the pivot, rest pose = 0.

build() returns a dict of object groups for cockpit_bake.py (panel bases / items per atlas, shell parts, small parts).
"""
import math
import os
import numpy as np
import bpy
from mathutils import Matrix
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
    for a in 'AB':
        m['panel' + a] = P(f'ck_panel{a}', color=(0.30, 0.34, 0.40), roughness=0.58, tex=_img(f'ck_atlas{a}.png'),
                           emission=(1, 1, 1), emission_strength=1.0, emission_tex=_img(f'ck_emit{a}.png'))
    m['screen'] = P('ck_screen', color=(0.004, 0.005, 0.006), roughness=0.06)
    m['lining'] = P('ck_lining', color=(0.36, 0.37, 0.37), roughness=0.85, tex=_img('ck_lining.jpg'))
    m['lining_dk'] = P('ck_lining_dk', color=(0.105, 0.125, 0.15), roughness=0.8)
    m['bluegrey'] = P('ck_bluegrey', color=(0.135, 0.165, 0.20), roughness=0.6)
    m['dark'] = P('ck_dark', color=(0.030, 0.033, 0.038), roughness=0.55)
    m['frame'] = P('ck_frame', color=(0.06, 0.065, 0.07), roughness=0.5)
    m['glare'] = P('ck_glare', color=(0.016, 0.017, 0.019), roughness=0.9)
    m['fabric'] = P('ck_fabric', color=(0.06, 0.07, 0.10), roughness=0.95, tex=_img('ck_fabric.jpg'))
    m['leather'] = P('ck_leather', color=(0.03, 0.032, 0.036), roughness=0.62, tex=_img('ck_leather.jpg'))
    m['shell'] = P('ck_seatshell', color=(0.028, 0.030, 0.034), roughness=0.45)
    m['carpet'] = P('ck_carpet', color=(0.05, 0.055, 0.06), roughness=0.98, tex=_img('ck_carpet.jpg'))
    m['metal'] = P('ck_metal', color=(0.55, 0.56, 0.58), metallic=0.9, roughness=0.35)
    m['rubber'] = P('ck_rubber', color=(0.018, 0.018, 0.02), roughness=0.75)
    m['knob'] = P('ck_knob', color=(0.035, 0.038, 0.043), roughness=0.4)
    m['knob_lt'] = P('ck_knob_lt', color=(0.40, 0.42, 0.44), metallic=0.35, roughness=0.38)
    m['white'] = P('ck_white', color=(0.85, 0.86, 0.87), roughness=0.4)
    m['red'] = P('ck_red', color=(0.50, 0.035, 0.03), roughness=0.3)
    m['yellow'] = P('ck_yellow', color=(0.75, 0.55, 0.02), roughness=0.4)
    m['placard'] = P('ck_placard', color=(0.22, 0.02, 0.02), roughness=0.55)
    m['visor'] = P('ck_visor', color=(0.035, 0.03, 0.02), roughness=0.15, alpha=0.78, double_sided=True)
    m['dome'] = P('ck_dome', color=(0.8, 0.8, 0.78), roughness=0.3, emission=(1.0, 0.95, 0.85), emission_strength=0.6)
    m['lens'] = P('ck_lens', color=(0.02, 0.022, 0.025), roughness=0.08)
    return m


# ================================================================================================ mesh accumulator

class Acc:
    """Accumulates polygons with per-loop UVs into one mesh; polygons can be oriented towards a direction."""

    def __init__(self):
        self.v, self.f, self.uv = [], [], []

    def poly(self, pts, uvs, want=None):
        pts = [np.asarray(p, float) for p in pts]
        if want is not None and len(pts) >= 3:
            n = np.cross(pts[1] - pts[0], pts[2] - pts[1])
            if len(pts) > 3:
                n = n + np.cross(pts[2] - pts[0], pts[3] - pts[2])
            if np.dot(n, want) < 0:
                pts, uvs = pts[::-1], list(uvs)[::-1]
        base = len(self.v)
        self.v.extend([tuple(p) for p in pts])
        self.f.append(tuple(range(base, base + len(pts))))
        self.uv.extend(uvs)

    def build(self, name, col, mat, smooth=False):
        if not self.f:
            return None
        return geo.mesh_object(name, np.array(self.v), self.f, col=col, mat=mat, smooth=smooth, loop_uvs=np.array(self.uv))


REG = None          # atlas regions (set in build)


def auv(pname, x, y):
    a, x0, y0, w, h = REG[pname]
    appm = w / PANELS[pname]['w']
    return ((x0 + x * appm) / CL.ATLAS, 1 - (y0 + y * appm) / CL.ATLAS)


def swatch_uv(atlas, i):
    a, x0, y0, w, h = REG['swatch' if atlas == 'A' else 'swatchB']
    q = w // 4
    return ((x0 + (i % 4) * q + q / 2) / CL.ATLAS, 1 - (y0 + (i // 4) * q + q / 2) / CL.ATLAS)


SW_CAP, SW_KEY, SW_BEZEL, SW_MCDU, SW_PANEL, SW_BLACK, SW_RED, SW_CONS = range(8)


def prism(acc, fr, pname, x, y, w, h, z0, z1, side_sw, inset=0.0, top_uv=True, atlas='A'):
    """Raised block on a panel: top face textured from the atlas footprint, sides from a swatch colour."""
    i = inset
    pts0 = [fr.p(x, y, z0), fr.p(x + w, y, z0), fr.p(x + w, y + h, z0), fr.p(x, y + h, z0)]
    pts1 = [fr.p(x + i, y + i, z1), fr.p(x + w - i, y + i, z1), fr.p(x + w - i, y + h - i, z1), fr.p(x + i, y + h - i, z1)]
    fp = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    uvt = [auv(pname, *q) for q in fp] if top_uv else [swatch_uv(atlas, side_sw)] * 4
    acc.poly(pts1, uvt, want=fr.N)
    su = swatch_uv(atlas, side_sw)
    c = fr.p(x + w / 2, y + h / 2, (z0 + z1) / 2)
    for k in range(4):
        k2 = (k + 1) % 4
        q = [pts0[k], pts0[k2], pts1[k2], pts1[k]]
        mid = (pts0[k] + pts0[k2]) / 2
        acc.poly(q, [su] * 4, want=mid - c)


def disc_uv(pname, cx, cy, r, n):
    return [auv(pname, cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)]


def cyl_on(acc, fr, cx, cy, r0, r1, z0, z1, n, uv_side, uv_top=None, want_top=None):
    """Cylinder standing on a panel (axis = panel normal)."""
    ring0 = [fr.p(cx + r0 * math.cos(2 * math.pi * k / n), cy + r0 * math.sin(2 * math.pi * k / n), z0) for k in range(n)]
    ring1 = [fr.p(cx + r1 * math.cos(2 * math.pi * k / n), cy + r1 * math.sin(2 * math.pi * k / n), z1) for k in range(n)]
    c = fr.p(cx, cy, (z0 + z1) / 2)
    for k in range(n):
        k2 = (k + 1) % n
        mid = (ring0[k] + ring0[k2]) / 2
        acc.poly([ring0[k], ring0[k2], ring1[k2], ring1[k]], [uv_side] * 4, want=mid - c)
    acc.poly(ring1, uv_top if uv_top is not None else [uv_side] * n, want=fr.N)


# ================================================================================================ panels

def panel_base(pn, acc, atlas):
    """Flat panel face (atlas-mapped; irradiance is baked onto exactly these faces) + a rim towards the back."""
    fr, W, H, name = pn['frame'], pn['w'], pn['h'], pn['name']
    acc.poly([fr.p(0, 0), fr.p(0, H), fr.p(W, H), fr.p(W, 0)], [auv(name, 0, 0), auv(name, 0, H), auv(name, W, H), auv(name, W, 0)],
             want=fr.N)


def panel_rim(pn, acc, atlas, depth=0.03):
    fr, W, H = pn['frame'], pn['w'], pn['h']
    su = swatch_uv(atlas, SW_PANEL)
    c = fr.p(W / 2, H / 2, -depth / 2)
    for (a, b) in (((0, 0), (W, 0)), ((W, 0), (W, H)), ((W, H), (0, H)), ((0, H), (0, 0))):
        q = [fr.p(*a), fr.p(*b), fr.p(*b, -depth), fr.p(*a, -depth)]
        acc.poly(q, [su] * 4, want=(q[0] + q[1]) / 2 - c)


def inside(it, rects):
    for r in rects:
        if r['x'] - 1e-6 <= it['x'] <= r['x'] + r['w'] and r['y'] - 1e-6 <= it['y'] <= r['y'] + r['h']:
            return r
    return None


def panel_items(pn, acc, small, atlas):
    """Raised geometry for the panel items. acc: atlas-textured parts; small: dict material -> Acc (constant colours)."""
    fr, name = pn['frame'], pn['name']
    items = pn['items']
    mcdus = [it for it in items if it['k'] == 'mcdu']
    for it in items:
        k = it['k']
        if k == 'pb':
            x, y, w, h = it['x'], it['y'], it['w'], it['h']
            # Korry housing (thin dark frame) + cap
            prism(acc, fr, name, x - 0.0014, y - 0.0014, w + 0.0028, h + 0.0028, 0.0, 0.0022, SW_BLACK, top_uv=False, atlas=atlas)
            prism(acc, fr, name, x, y, w, h, 0.0022, 0.0062, SW_CAP, inset=0.0004, atlas=atlas)
            g = it.get('guard')
            if g == 'red':
                gx, gy, gw, gh = x - 0.003, y - 0.004, w + 0.006, h + 0.007
                prism(small['red'], fr, name, gx, gy, gw, gh, 0.0, 0.016, SW_RED, inset=0.0015, top_uv=False, atlas=atlas)
            elif g in ('clear', 'fire'):
                t = 0.0018
                for (bx, by, bw, bh) in ((x - 0.004, y - 0.004, t, h + 0.008), (x + w + 0.004 - t, y - 0.004, t, h + 0.008),
                                         (x - 0.004, y - 0.004, w + 0.008, t)):
                    prism(small['frame'], fr, name, bx, by, bw, bh, 0.0, 0.013, SW_BLACK, top_uv=False, atlas=atlas)
        elif k == 'sq':
            x, y, w, h = it['x'], it['y'], it['w'], it['h']
            prism(acc, fr, name, x - 0.0018, y - 0.0018, w + 0.0036, h + 0.0036, 0.0, 0.0025, SW_BLACK, top_uv=False, atlas=atlas)
            prism(acc, fr, name, x, y, w, h, 0.0025, 0.0085, SW_CAP, inset=0.0006, atlas=atlas)
        elif k == 'key':
            m = inside(it, mcdus)
            z0 = 0.013 if m else 0.0
            prism(acc, fr, name, it['x'], it['y'], it['w'], it['h'], z0, z0 + 0.0042, SW_KEY, inset=0.0005, atlas=atlas)
        elif k == 'mcdu':
            x, y, w, h = it['x'], it['y'], it['w'], it['h']
            prism(acc, fr, name, x, y, w, h, 0.0, 0.013, SW_MCDU, inset=0.0015, atlas=atlas)
        elif k == 'dcdu':
            prism(acc, fr, name, it['x'], it['y'], it['w'], it['h'], 0.0, 0.010, SW_MCDU, inset=0.0015, atlas=atlas)
        elif k == 'clock':
            prism(acc, fr, name, it['x'], it['y'], it['w'], it['h'], 0.0, 0.007, SW_BEZEL, inset=0.001, atlas=atlas)
        elif k == 'bezel':
            x, y, w, h = it['x'], it['y'], it['w'], it['h']
            t = 0.0160 if it['kind'] == 'du' else 0.008
            d = 0.012 if it['kind'] == 'du' else 0.008
            bars = ((x, y, w, t), (x, y + h - t - 0.002, w, t + 0.002), (x, y + t, t, h - 2 * t - 0.002),
                    (x + w - t, y + t, t, h - 2 * t - 0.002))
            for (bx, by, bw, bh) in bars:
                prism(acc, fr, name, bx, by, bw, bh, 0.0, d, SW_BEZEL, inset=0.0008, atlas=atlas)
        elif k == 'lcd':
            pass
        elif k == 'knob':
            knob(fr, it, small, name, atlas)
        elif k == 'tog':
            toggle(fr, it, small)
        elif k == 'gauge':
            cyl_on(small['frame'], fr, it['x'], it['y'], it['r'] * 1.02, it['r'] * 0.98, 0.0, 0.006, 24,
                   swatch_uv(atlas, SW_BEZEL))
            # glass-less rim only: the dial stays the painted atlas face
        elif k == 'master':
            master_switch(fr, it, small)
        elif k == 'parkbrk':
            park_brake(fr, it, small)


def knob(fr, it, small, pname, atlas):
    """Airbus knobs are light grey: bar selectors (dark skirt, grey bar grip with an index line), round knobs with a
    dark pointer, the large FCU knobs (satin grey with a darker centre), concentric baro/RMP knobs."""
    x, y, r, st = it['x'], it['y'], it['r'], it['style']
    su = swatch_uv(atlas, SW_BLACK)
    if st == 'bar':
        cyl_on(small['knob'], fr, x, y, r * 1.05, r * 1.0, 0.0, 0.004, 20, su)
        L, Wd = r * 1.25, r * 0.42
        prism(small['knob_lt'], fr, pname, x - Wd, y - L, 2 * Wd, 2 * L, 0.004, 0.015, SW_BLACK, inset=0.0008, top_uv=False, atlas=atlas)
        prism(small['knob'], fr, pname, x - 0.0006, y - L + 0.0015, 0.0012, L * 0.9, 0.015, 0.0156, SW_BLACK, top_uv=False, atlas=atlas)
    elif st == 'big':
        cyl_on(small['knob'], fr, x, y, r * 1.08, r * 1.02, 0.0, 0.004, 32, su)
        cyl_on(small['knob_lt'], fr, x, y, r * 0.98, r * 0.92, 0.004, 0.019, 32, su)
        cyl_on(small['knob'], fr, x, y, r * 0.45, r * 0.42, 0.019, 0.0200, 20, su)
    elif st == 'dual':
        cyl_on(small['knob'], fr, x, y, r * 1.1, r * 1.05, 0.0, 0.006, 24, su)
        cyl_on(small['knob_lt'], fr, x, y, r * 0.62, r * 0.58, 0.006, 0.016, 20, su)
    elif st == 'small':
        cyl_on(small['knob'], fr, x, y, r, r * 0.92, 0.0, 0.007, 14, su)
    else:   # round
        cyl_on(small['knob_lt'], fr, x, y, r * 1.05, r * 0.90, 0.0, 0.013, 22, su)
        prism(small['knob'], fr, pname, x - 0.0006, y - r * 0.85, 0.0012, r * 0.7, 0.013, 0.0136, SW_BLACK, top_uv=False, atlas=atlas)


def toggle(fr, it, small):
    x, y = it['x'], it['y']
    n = max(len(it['pos']), 2)
    st = it.get('state', 0)
    tilt = (st - (n - 1) / 2) / max((n - 1) / 2, 1) * 0.55      # towards the selected position label (panel V)
    base = fr.p(x, y, 0.0)
    small['metal_acc'].extend([('cyl', base, fr.p(x, y, 0.0035), 0.0040, 0.0036, 6, 'metal')])
    dirv = fr.N * math.cos(tilt) + fr.V * math.sin(tilt)
    tip = base + dirv * 0.0155
    small['metal_acc'].append(('cyl', fr.p(x, y, 0.0035), tip, 0.0014, 0.0012, 8, 'metal'))
    small['metal_acc'].append(('cyl', tip - dirv * 0.003, tip + dirv * 0.002, 0.0024, 0.0021, 10, 'knob_lt'))


def master_switch(fr, it, small):
    x, y = it['x'], it['y']
    small['metal_acc'].append(('cyl', fr.p(x, y, 0.0), fr.p(x, y, 0.004), 0.008, 0.0075, 16, 'knob'))
    small['metal_acc'].append(('cyl', fr.p(x, y, 0.004), fr.p(x, y - 0.004, 0.030), 0.0045, 0.004, 10, 'metal'))
    small['metal_acc'].append(('box', fr.p(x, y - 0.005, 0.034), (0.020, 0.012, 0.016), fr, 'knob'))


def park_brake(fr, it, small):
    x, y = it['x'], it['y']
    small['metal_acc'].append(('cyl', fr.p(x, y, 0.0), fr.p(x, y, 0.010), 0.012, 0.011, 20, 'knob'))
    small['metal_acc'].append(('box', fr.p(x, y, 0.020), (0.052, 0.014, 0.016), fr, 'knob'))
    small['metal_acc'].append(('box', fr.p(x + 0.018, y, 0.030), (0.008, 0.010, 0.008), fr, 'white'))


def screen_quads(pn, col, mats):
    """screen_* meshes: quads slightly in front of the panel, UV 0..1 (v = 1 at the top edge)."""
    out = []
    fr = pn['frame']
    for it in pn['items']:
        if it['k'] != 'screen':
            continue
        x, y, w, h, name = it['x'], it['y'], it['w'], it['h'], it['name']
        z = 0.0045
        pts = [fr.p(x, y, z), fr.p(x, y + h, z), fr.p(x + w, y + h, z), fr.p(x + w, y, z)]
        o = geo.mesh_object(name, np.array(pts), [(0, 1, 2, 3)], col=col, mat=mats['screen'], smooth=False,
                            loop_uvs=np.array([(0, 1), (0, 0), (1, 0), (1, 1)]))
        o.data.update()
        if np.dot(np.array(o.data.polygons[0].normal), fr.N) < 0:
            geo.flip_normals(o)
        out.append(o)
    return out


# ================================================================================================ shell (lining, windows)

LINING_OFF = 0.045


def lining_pts(s, th, off):
    """Points on the fuselage surface pulled radially toward the section centre by `off` meters."""
    s = np.asarray(s, float)
    th = np.asarray(th, float)
    y, z = LY.surface(s, th)
    zc = LY.section_params(s)[0]
    dy, dz = y, z - zc
    r = np.sqrt(dy * dy + dz * dz) + 1e-9
    k = 1 - off / r
    return np.stack([dy * k, geo.S_CG - s * np.ones_like(y), zc + dz * k], -1)


def lining(col, mats):
    """Inner lining (normals facing the cabin), window openings cut radially + reveals to the skin. Faces below the
    window sills get the darker blue-grey wall colour."""
    s_arr = np.r_[np.linspace(1.22, 2.0, 30), np.linspace(2.0, 3.6, 44)[1:], np.linspace(3.6, 4.40, 10)[1:]]
    th = np.linspace(0, 2 * math.pi, 160, endpoint=False)
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
    o.data.materials.append(mats['lining_dk'])
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
            outline = densify(prm, 24)
            cutters.append(radial_prism(outline, col))
            reveals.append(reveal(outline, col, mats))
    cut = geo.join(cutters, 'ckcut')
    geo.boolean(o, cut, 'DIFFERENCE', 'EXACT')
    bpy.data.objects.remove(cut, do_unlink=True)
    me = o.data
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    cen = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('center', cen)
    cz = cen.reshape(-1, 3)[:, 2]
    mi = np.where(cz < 0.30, 1, 0).astype(np.int32)
    me.polygons.foreach_set('material_index', mi)
    me.update()
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
    """Window reveal from the lining to the skin (dark trim)."""
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
    nrm = np.zeros(len(o.data.polygons) * 3)
    cen = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('normal', nrm)
    o.data.polygons.foreach_get('center', cen)
    cc = outer.mean(0)
    if np.einsum('ij,ij->i', nrm.reshape(-1, 3), cc - cen.reshape(-1, 3)).sum() < 0:
        geo.flip_normals(o)
    return o


def lining_halfwidth(s, z):
    ths = np.linspace(0.0, math.pi, 721)
    Pl = lining_pts(np.full_like(ths, s), ths, LINING_OFF)
    k = np.argmin(np.abs(Pl[:, 2] - z))
    return float(Pl[k, 0])


def lining_top(s):
    return float(lining_pts(np.array([s]), np.array([0.0]), LINING_OFF)[0, 2])


def lining_top_at(s, y):
    ths = np.linspace(-1.3, 1.3, 261)
    P = lining_pts(np.full_like(ths, s), ths, LINING_OFF)
    k = np.argmin(np.abs(P[:, 0] - y))
    return float(P[k, 2])


def _face(o, direction):
    o.data.update()
    nrm = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('normal', nrm)
    if np.dot(nrm.reshape(-1, 3).sum(0), direction) < 0:
        geo.flip_normals(o)


def floor_and_bulkhead(col, mats):
    objs = []
    z = CL.FLOOR_Z
    ss = np.linspace(1.30, 4.40, 20)
    acc = Acc()
    rows = [[B(s, -(lining_halfwidth(s, z) + 0.02), z), B(s, lining_halfwidth(s, z) + 0.02, z)] for s in ss]
    for i in range(len(ss) - 1):
        a, b = rows[i], rows[i + 1]
        acc.poly([a[0], b[0], b[1], a[1]], [(ss[i] * 2, 0), (ss[i + 1] * 2, 0), (ss[i + 1] * 2, 6), (ss[i] * 2, 6)],
                 want=(0, 0, 1))
    objs.append(acc.build('ck_floor', col, mats['carpet']))
    # rear bulkhead with the cockpit door
    sb = 4.36
    th = np.linspace(0, 2 * math.pi, 120, endpoint=False)
    Pl = lining_pts(np.full_like(th, sb), th, LINING_OFF)
    yi, zi = Pl[:, 0], Pl[:, 2]
    keep = zi >= z - 0.01
    poly = [B(sb, a, max(c, z)) for a, c in zip(yi[keep], zi[keep])]
    cen = np.mean(poly, 0)
    ang = [math.atan2(p[2] - cen[2], p[0] - cen[0]) for p in poly]
    poly = [p for _, p in sorted(zip(ang, poly), key=lambda t: t[0])]
    verts = [tuple(cen)] + [tuple(p) for p in poly]
    faces = [(0, k + 1, (k + 1) % len(poly) + 1) for k in range(len(poly))]
    luv = [(0.5, 0.5)] * (3 * len(faces))
    bh = geo.mesh_object('ck_bulkhead', np.array(verts), faces, col=col, mat=mats['lining'], smooth=False, loop_uvs=np.array(luv))
    _face(bh, (0, 1, 0))
    objs.append(bh)
    dw, dh = 0.76, 1.88
    objs.append(geo.box('ck_door', tuple(B(sb - 0.02, 0.0, z + dh / 2 + 0.01)), (dw, 0.04, dh), col=col, mat=mats['bluegrey'],
                        bevel=0.01))
    objs.append(geo.box('ck_door_h', tuple(B(sb - 0.055, 0.29, z + 1.02)), (0.13, 0.03, 0.028), col=col, mat=mats['metal'], bevel=0.006))
    objs.append(geo.cylinder('ck_peep', B(sb - 0.05, 0.0, z + 1.55), B(sb - 0.03, 0.0, z + 1.55), 0.014, n=12, col=col, mat=mats['metal']))
    for yy in (-0.66, 0.66):
        objs.append(geo.superellipsoid('ck_jump', B(sb - 0.08, yy, z + 0.95), (0.40, 0.10, 0.60), n=(6, 6), seg=(20, 10),
                                       col=col, mat=mats['fabric']))
        objs.append(geo.box('ck_jumpf', tuple(B(sb - 0.03, yy, z + 0.95)), (0.44, 0.03, 0.66), col=col, mat=mats['dark'], bevel=0.01))
    return objs


# ================================================================================================ structures

def glareshield(col, mats):
    """Glareshield: black anti-glare top reaching forward under the windshield, padded front lip above the FCU."""
    ys = np.linspace(-0.86, 0.86, 45)
    rings = []
    for yv in ys:
        k = abs(yv) / 0.86
        s_front = CL.GS_FRONT_S
        z_top = CL.GS_TOP_Z - 0.012 * k ** 2
        z_fwd = 0.405 - 0.03 * k
        s_fwd = s_front - 0.06
        for s_try in np.arange(s_front - 0.06, 1.25, -0.01):
            ths = np.linspace(-1.4, 1.4, 281)
            Pl = lining_pts(np.full_like(ths, s_try), ths, LINING_OFF)
            j = np.argmin(np.abs(Pl[:, 0] - yv))
            if Pl[j, 2] < z_fwd + 0.025 or abs(Pl[j, 0] - yv) > 0.02:
                break
            s_fwd = s_try
        # profile (s, z): under the lip down the FCU face and back under the panel top
        prof = [(s_fwd, CL.FCU_BOT_Z - 0.03), (s_fwd, z_fwd), (0.5 * (s_fwd + s_front), 0.5 * (z_fwd + z_top) + 0.010),
                (s_front - 0.020, z_top), (s_front - 0.004, z_top - 0.001), (s_front + 0.008, z_top - 0.005),
                (s_front + 0.013, z_top - 0.013), (s_front + 0.006, CL.FCU_TOP_Z + 0.002),
                (s_front + 0.020, CL.FCU_BOT_Z - 0.002), (s_front + 0.022, CL.FCU_BOT_Z - 0.012),
                (s_front + 0.004, CL.FCU_BOT_Z - 0.016), (s_front - 0.10, CL.FCU_BOT_Z - 0.022)]
        rings.append([B(s, yv, zz) for s, zz in prof])
    return geo.grid_mesh('ck_glareshield', np.array(rings), closed=True, col=col, mat=mats['glare'], cap0=True, cap1=True,
                         auto_orient=True)


def mip_structure(col, mats):
    """Back box of the main panel, side fillers to the lining, stowed tables, knee panels and footwells."""
    objs = []
    t0 = CL.MIP_TOP
    for side in (-1, 1):
        # side filler between the panel edge and the lining (dark wall)
        acc = Acc()
        pts = []
        for v in np.linspace(0, CL.MIP_H_SIDE + 0.06, 6):
            s, z = CL.mip_point(v)
            yl = lining_halfwidth(s + 0.02, z) - 0.005
            pts.append((B(s, side * CL.MIP_Y, z), B(s + 0.02, side * yl, z)))
        for (a0, a1), (b0, b1) in zip(pts, pts[1:]):
            acc.poly([a0, a1, b1, b0], [(0, 0)] * 4, want=(0, -1, 0))
        objs.append(acc.build('mipfill', col, mats['lining_dk']))
        # stowed pull-out table: slab under the PFD/ND panel with a handle recess
        s0, z0 = CL.mip_point(CL.MIP_H_SIDE)
        yc = side * (CL.MIP_YC + CL.MIP_Y) / 2 + side * 0.02
        objs.append(geo.box('ck_table', tuple(B(s0 + 0.012, yc, z0 - 0.032)), (0.50, 0.075, 0.062), col=col,
                            mat=mats['bluegrey'], bevel=0.006))
        objs.append(geo.box('ck_tableh', tuple(B(s0 + 0.050, yc, z0 - 0.020)), (0.22, 0.012, 0.014), col=col, mat=mats['dark'],
                            bevel=0.003))
        objs.append(geo.box('ck_tablelip', tuple(B(s0 + 0.047, yc, z0 - 0.050)), (0.50, 0.008, 0.024), col=col,
                            mat=mats['bluegrey'], bevel=0.002))
        # knee panel below the table (slanted back at the bottom), two knee pads, pedal adjust handle
        zk0, zk1 = z0 - 0.066, -0.26
        acc = Acc()
        yo, yi = side * (CL.MIP_Y - 0.01), side * (CL.PED_Y + 0.035)
        q = [B(s0 + 0.004, yo, zk0), B(s0 + 0.004, yi, zk0), B(s0 - 0.03, yi, zk1), B(s0 - 0.03, yo, zk1)]
        acc.poly(q, [(0, 0)] * 4, want=(0, -1, 0))
        objs.append(acc.build('knee', col, mats['bluegrey']))
        for yy in (0.58, 0.38):
            objs.append(geo.superellipsoid('kpad', B(s0 + 0.004, side * yy, (zk0 + zk1) / 2 + 0.01), (0.13, 0.05, 0.20),
                                           n=(6, 6), seg=(16, 10), col=col, mat=mats['dark']))
        ph = B(s0 - 0.02, side * 0.48, zk1 - 0.02)
        objs.append(geo.box('ck_pedadj', tuple(ph), (0.06, 0.03, 0.05), col=col, mat=mats['frame'], bevel=0.005))
        objs.append(geo.box('ck_pedadjt', tuple(ph + np.array([0, -0.02, -0.03])), (0.07, 0.015, 0.02), col=col, mat=mats['frame'],
                            bevel=0.004))
        # footwell: dark floor ramp + side walls forward to the nose bulkhead
        acc = Acc()
        fz = CL.FLOOR_Z
        sa, sb_ = 1.40, s0 + 0.02
        ya, yb = side * (CL.PED_Y + 0.02), side * (lining_halfwidth(1.5, -0.4) - 0.01)
        acc.poly([B(sa, ya, fz + 0.12), B(sb_, ya, fz + 0.002), B(sb_, yb, fz + 0.002), B(sa, yb, fz + 0.12)], [(0, 0)] * 4,
                 want=(0, 0, 1))
        acc.poly([B(sa, ya, fz + 0.12), B(sa, yb, fz + 0.12), B(sa, yb, zk1 + 0.05), B(sa, ya, zk1 + 0.05)], [(0, 0)] * 4,
                 want=(0, -1, 0))
        acc.poly([B(sa, ya, zk1 + 0.05), B(sa, yb, zk1 + 0.05), B(s0 - 0.03, yb, zk1), B(s0 - 0.03, ya, zk1)], [(0, 0)] * 4,
                 want=(0, 0, -1))
        objs.append(acc.build('footwell', col, mats['dark']))
    # centre: pedestal front below the MCDU incline handled by pedestal_body; box behind the centre panel top
    return objs


def pedestal_body(col, mats):
    """Pedestal sides, front and aft faces from the panel segments down to the floor."""
    objs = []
    y = CL.PED_Y
    fz = CL.FLOOR_Z
    prof = [CL.PED_P0, CL.PED_P1, CL.PED_P2, CL.PED_P3]
    for side in (-1, 1):
        acc = Acc()
        pts = [(s, z) for s, z in prof]
        for (sa, za), (sb, zb) in zip(pts, pts[1:]):
            acc.poly([B(sa, side * y, za), B(sb, side * y, zb), B(sb, side * y, fz), B(sa, side * y, fz)], [(0, 0)] * 4,
                     want=(side, 0, 0))
        objs.append(acc.build('pedside', col, mats['bluegrey']))
        # kick plate
        objs.append(geo.box('kick', tuple(B((prof[0][0] + prof[-1][0]) / 2, side * (y + 0.004), fz + 0.04)),
                            (0.01, prof[-1][0] - prof[0][0], 0.08), col=col, mat=mats['dark']))
    acc = Acc()
    s3, z3 = CL.PED_P3
    acc.poly([B(s3, -y, z3), B(s3, y, z3), B(s3, y, fz), B(s3, -y, fz)], [(0, 0)] * 4, want=(0, -1, 0))
    s0, z0 = CL.PED_P0
    acc.poly([B(s0, -y, z0), B(s0, y, z0), B(s0 - 0.01, y, fz), B(s0 - 0.01, -y, fz)], [(0, 0)] * 4, want=(0, 1, 0))
    objs.append(acc.build('pedends', col, mats['bluegrey']))
    # panel rims along the pedestal top edges
    for side in (-1, 1):
        for (sa, za), (sb, zb) in zip(prof, prof[1:]):
            objs.append(geo.cylinder('pedrim', B(sa, side * y, za + 0.004), B(sb, side * y, zb + 0.004), 0.006, n=8, col=col,
                                     mat=mats['bluegrey']))
    return objs


def overhead_body(col, mats):
    """Walls of the overhead panel box from the panel edge up to the ceiling lining."""
    fr, H = CL.ovh_frame()
    W = CL.OVH_W
    acc = Acc()
    edge = []
    for x, y in ((0, 0), (W, 0), (W, H), (0, H)):
        p = fr.p(x, y)
        s = CL.S_CG - p[1]
        edge.append((p, np.array([p[0], p[1], lining_top_at(s, p[0]) + 0.03])))
    c = fr.p(W / 2, H / 2, 0.1)
    for a, b2 in ((0, 1), (1, 2), (2, 3), (3, 0)):
        (pa, ua), (pb, ub) = edge[a], edge[b2]
        acc.poly([pa, pb, ub, ua], [(0, 0), (1, 0), (1, 1), (0, 1)], want=(pa + pb) / 2 - c)
    objs = [acc.build('ck_ovh_box', col, mats['bluegrey'])]
    # frame lip around the panel
    for a, b2 in ((0, 1), (1, 2), (2, 3), (3, 0)):
        pa, pb = edge[a][0], edge[b2][0]
        objs.append(geo.cylinder('ovhlip', pa, pb, 0.007, n=8, col=col, mat=mats['bluegrey']))
    return objs


def console_body(col, mats):
    objs = []
    zt = CL.CONS_Z
    fz = CL.FLOOR_Z
    for side in (-1, 1):
        acc = Acc()
        s0, s1 = CL.CONS_S0, CL.CONS_S1
        yi = side * CL.CONS_Y0
        # inboard face, front and aft faces
        acc.poly([B(s0, yi, zt), B(s1, yi, zt), B(s1, yi, fz), B(s0, yi, fz)], [(0, 0)] * 4, want=(-side, 0, 0))
        for s in (s0, s1):
            yo = side * (lining_halfwidth(s, (zt + fz) / 2) + 0.01)
            acc.poly([B(s, yi, zt), B(s, yo, zt), B(s, yo, fz), B(s, yi, fz)], [(0, 0)] * 4, want=(0, 1 if s == s0 else -1, 0))
        objs.append(acc.build('cons', col, mats['bluegrey']))
        # edge trim along the inboard top edge
        objs.append(geo.cylinder('consrim', B(s0, yi, zt - 0.002), B(s1, yi, zt - 0.002), 0.008, n=8, col=col, mat=mats['dark']))
        # oxygen mask stowage box, cup holder ring, documents lid
        ox = side * (CL.CONS_Y1 - 0.12)
        objs.append(geo.superellipsoid('oxy', B(2.68, ox, zt + 0.045), (0.16, 0.18, 0.09), n=(8, 5), seg=(20, 10), col=col,
                                       mat=mats['dark']))
        objs.append(geo.box('oxyflap', tuple(B(2.68, ox, zt + 0.092)), (0.13, 0.14, 0.006), col=col, mat=mats['frame']))
        cup = B(2.05, side * (CL.CONS_Y1 - 0.08), zt)
        objs.append(geo.cylinder('cup', cup, cup + np.array([0, 0, 0.02]), 0.042, 0.040, n=20, col=col, mat=mats['dark'], caps=False))
    return objs


def sidestick(side, col, mats):
    """Side-stick: grip lofted along a curved spine (index trigger, red takeover button, thumb rest), square stepped
    rubber boot on a base plate. Pivot on the console surface."""
    tag = 'capt' if side < 0 else 'fo'
    base = B(CL.STICK['s'], side * CL.STICK['y'], CL.CONS_Z)
    parts = []
    # boot: four stacked rounded squares
    for k, (sz, h) in enumerate(((0.100, 0.012), (0.082, 0.012), (0.064, 0.012), (0.046, 0.012))):
        c = base + np.array([0, 0, 0.006 + k * 0.011])
        parts.append(geo.superellipsoid('boot', c, (sz, sz, h), n=(6, 3), seg=(24, 6), col=col, mat=mats['rubber']))
    # grip: tilted slightly forward and inboard
    rings = []
    n_r = 20
    for t in np.linspace(0, 1, 16):
        h = 0.045 + 0.140 * t
        fwd = 0.012 * math.sin(math.pi * t) + 0.018 * t          # forward lean (+Y Blender = forward)
        rx = 0.014 + 0.012 * math.sin(math.pi * min(t * 1.05, 1)) - (0.004 if t > 0.9 else 0)
        ry = 0.018 + 0.013 * math.sin(math.pi * min(t * 1.02, 1))
        if t > 0.86:                                            # flared pommel
            rx += 0.006 * (t - 0.86) / 0.14
            ry += 0.008 * (t - 0.86) / 0.14
        ring = []
        for a in np.linspace(0, 2 * math.pi, n_r, endpoint=False):
            finger = 0.004 * max(0, math.cos(a - math.pi / 2)) * math.sin(6 * math.pi * t) if t < 0.8 else 0
            ring.append(base + np.array([rx * math.cos(a), fwd + (ry + finger) * math.sin(a), h]))
        rings.append(ring)
    parts.append(geo.grid_mesh('grip', np.array(rings), closed=True, col=col, mat=mats['rubber'], cap1=True, cap0=True))
    top = base + np.array([0, 0.03, 0.188])
    parts.append(geo.cylinder('prio', top + np.array([side * -0.010, -0.004, -0.003]), top + np.array([side * -0.010, -0.004, 0.005]),
                              0.0065, n=12, col=col, mat=mats['red']))
    parts.append(geo.box('trig', tuple(base + np.array([0, 0.050, 0.140])), (0.014, 0.012, 0.026), col=col, mat=mats['knob'],
                         bevel=0.004))
    parts.append(geo.cylinder('shaft', base, base + np.array([0, 0.004, 0.05]), 0.011, n=12, col=col, mat=mats['knob']))
    o = geo.join(parts, f'ck_stick_{tag}')
    geo.set_origin(o, base)
    return o


def tiller(side, col, mats):
    c = B(CL.TILLER['s'], side * CL.TILLER['y'], CL.CONS_Z)
    parts = []
    parts.append(geo.cylinder('thub', c, c + np.array([0, 0, 0.035]), 0.028, 0.024, n=20, col=col, mat=mats['knob']))
    R = 0.060
    ring = [c + np.array([R * math.cos(a), R * math.sin(a), 0.040]) for a in np.linspace(0, 2 * math.pi, 32, endpoint=False)]
    tube = []
    for k in range(32):
        p0 = ring[k]
        tube.append([p0 + np.array([0.009 * math.cos(b) * math.cos(2 * math.pi * k / 32), 0.009 * math.cos(b) * math.sin(2 * math.pi * k / 32),
                                     0.009 * math.sin(b)]) for b in np.linspace(0, 2 * math.pi, 10, endpoint=False)])
    tube.append(tube[0])
    parts.append(geo.grid_mesh('trim', np.array(tube), closed=True, col=col, mat=mats['knob'], auto_orient=False))
    for a in (0.3, 2.4, 4.4):
        parts.append(geo.cylinder('tspk', c + np.array([0, 0, 0.036]), c + np.array([R * math.cos(a), R * math.sin(a), 0.040]), 0.006,
                                  n=8, col=col, mat=mats['knob']))
    h = c + np.array([R * math.cos(1.2), R * math.sin(1.2), 0.04])
    parts.append(geo.cylinder('thdl', h, h + np.array([0, 0, 0.045]), 0.008, 0.007, n=12, col=col, mat=mats['knob']))
    return geo.join(parts, f'ck_tiller_{"capt" if side < 0 else "fo"}')


def seat(side, col, mats):
    """Ipeco-style pilot seat around the seat reference point: sculpted fabric cushions with side bolsters, lumbar,
    headrest on the hard shell, two armrests with adjustment wheels, 5-point harness, frame, column and floor rails."""
    y0 = side * CL.EYE['y']
    SE = geo.superellipsoid
    fab, shell, dark, metal = mats['fabric'], mats['shell'], mats['dark'], mats['metal']
    srp_s, srp_z = CL.SRP['s'], CL.SRP['z']
    rec = math.radians(14)
    Rb = np.array(Matrix.Rotation(-rec, 3, 'X'))          # backrest recline (top aft = -Y Blender)
    Rp = np.array(Matrix.Rotation(math.radians(-6), 3, 'X'))  # pan: front edge up
    back_dir = np.array([0, -math.sin(rec), math.cos(rec)])   # along the backrest (Blender)
    back_n = np.array([0, math.cos(rec), math.sin(rec)])      # backrest front normal
    sp = B(srp_s, y0, srp_z)
    parts = []
    # seat pan cushion + thigh bolsters
    pan_c = sp + np.array([0, 0.225, -0.035])
    parts.append(SE('pan', pan_c, (0.44, 0.46, 0.085), n=(7, 3.2), seg=(36, 18), rot=Rp, col=col, mat=fab))
    for dy in (-0.215, 0.215):
        parts.append(SE('bol', pan_c + np.array([dy, 0.02, 0.022]), (0.07, 0.40, 0.085), n=(3, 3), seg=(20, 12), rot=Rp, col=col, mat=fab))
    # backrest cushion with lumbar bulge, side bolsters
    bc = sp + back_dir * 0.33 + back_n * 0.055
    parts.append(SE('back', bc, (0.42, 0.10, 0.60), n=(7, 3.2), seg=(36, 20), rot=Rb, col=col, mat=fab,
                    taper=lambda z: 1.0 - 0.08 * z, bend=lambda z: 0.022 * math.sin(math.pi * (1 - z) * 0.9)))
    for dy in (-0.225, 0.225):
        parts.append(SE('bbol', bc + back_dir * -0.04 + back_n * 0.02 + np.array([dy, 0, 0]), (0.065, 0.12, 0.46), n=(3, 3),
                        seg=(20, 12), rot=Rb, col=col, mat=fab))
    # hard bucket shell behind the back cushion (wraps the sides, tapers towards the shoulders)
    shc = sp + back_dir * 0.34 - back_n * 0.015
    parts.append(SE('shell', shc, (0.47, 0.09, 0.68), n=(4.5, 4), seg=(56, 28), rot=Rb, col=col, mat=shell,
                    taper=lambda z: 1.0 - 0.20 * z))
    parts.append(SE('shellrim', shc + back_n * 0.03 + back_dir * 0.29, (0.40, 0.05, 0.07), n=(4, 3), seg=(40, 10), rot=Rb, col=col,
                    mat=shell))
    # headrest: tall cushion directly on top of the shell, with its own hard back cover
    hc = sp + back_dir * 0.80 + back_n * 0.02
    parts.append(SE('head', hc, (0.29, 0.12, 0.22), n=(4.5, 3.4), seg=(56, 24), rot=Rb, col=col, mat=fab))
    parts.append(SE('headsh', hc - back_n * 0.05, (0.31, 0.06, 0.225), n=(5, 4), seg=(56, 20), rot=Rb, col=col, mat=shell))
    # back of the shell: map pocket and the red LIFE VEST placard
    bk = sp + back_dir * 0.30 - back_n * 0.065
    parts.append(SE('pocket', bk, (0.34, 0.025, 0.26), n=(6, 6), seg=(20, 10), rot=Rb, col=col, mat=dark))
    parts.append(geo.box('lvest', tuple(sp + back_dir * 0.58 - back_n * 0.062), (0.085, 0.004, 0.022), col=col, mat=mats['placard'],
                         rot=Rb))
    # armrests (both down), pivots on the shell, adjustment wheels at the front
    for dy in (-0.285, 0.285):
        piv = sp + back_dir * 0.30 - back_n * 0.01 + np.array([dy, 0, 0])
        arm_c = B(srp_s - 0.13, y0 + dy, srp_z + 0.235)
        parts.append(SE('arm', arm_c, (0.065, 0.32, 0.055), n=(4, 3), seg=(20, 12), col=col, mat=mats['leather']))
        parts.append(SE('armb', arm_c + np.array([0, 0.03, -0.035]), (0.05, 0.26, 0.03), n=(4, 4), seg=(16, 8), col=col, mat=dark))
        parts.append(geo.cylinder('armp', piv, arm_c + np.array([0, -0.15, -0.01]), 0.018, n=10, col=col, mat=dark))
        wh = arm_c + np.array([0, 0.17, -0.02])
        parts.append(geo.cylinder('armw', wh + np.array([-0.012, 0, 0]), wh + np.array([0.012, 0, 0]), 0.022, n=18, col=col, mat=dark))
    # harness (not worn): shoulder straps lying on the backrest, lap belts and the rotary buckle on the seat pan
    buckle = B(srp_s - 0.20, y0, srp_z + 0.022)
    for dx in (-0.075, 0.075):
        top = sp + back_dir * 0.70 + back_n * 0.108 + np.array([dx, 0, 0])
        low = sp + back_dir * 0.16 + back_n * 0.108 + np.array([dx * 1.3, 0, 0])
        parts.append(strap(top, low, back_n, col, mats['strap']))
    for dx in (-0.21, 0.21):
        parts.append(strap(B(srp_s - 0.03, y0 + dx, srp_z + 0.035), buckle + np.array([dx * 0.25, 0, 0.004]), np.array([0, 0, 1.0]),
                           col, mats['strap']))
    parts.append(geo.cylinder('buckle', buckle, buckle + np.array([0, 0.01, 0.018]), 0.032, n=20, col=col, mat=metal))
    # frame, pan tub, column, rails; life vest pouch
    parts.append(SE('tub', pan_c + np.array([0, -0.01, -0.075]), (0.46, 0.46, 0.07), n=(8, 6), seg=(28, 10), rot=Rp, col=col, mat=shell))
    base_top = srp_z - 0.12
    parts.append(geo.box('column', tuple(B(srp_s - 0.18, y0, (CL.FLOOR_Z + base_top) / 2)), (0.30, 0.34, base_top - CL.FLOOR_Z),
                         col=col, mat=dark, bevel=0.02))
    parts.append(geo.box('colcov', tuple(B(srp_s - 0.18, y0, (CL.FLOOR_Z + base_top) / 2 + 0.03)), (0.34, 0.30, 0.10), col=col,
                         mat=shell, bevel=0.02))
    for dy in (-0.15, 0.15):
        parts.append(geo.box('rail', tuple(B(srp_s - 0.15, y0 + dy, CL.FLOOR_Z + 0.015)), (0.04, 0.80, 0.03), col=col, mat=metal,
                             bevel=0.005))
    return geo.join(parts, f'ck_seat_{"capt" if side < 0 else "fo"}')


def strap(a, b, up, col, mat, w=0.045, t=0.004):
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    L = np.linalg.norm(d)
    d = d / L
    side = np.cross(d, up)
    side = side / (np.linalg.norm(side) + 1e-9)
    nrm = np.cross(side, d)
    R = np.stack([side, d, nrm], 1)
    return geo.box('strap', tuple((a + b) / 2), (w, L, t), col=col, mat=mat, rot=R)


def pedals(side, col, mats):
    """Rudder/brake pedals in the footwell under the main panel: pads on arms hinged at the top."""
    tag = 'capt' if side < 0 else 'fo'
    out = []
    SE = geo.superellipsoid
    Rt = np.array(Matrix.Rotation(math.radians(30), 3, 'X'))
    for lr, dy in (('L', -0.115), ('R', 0.115)):
        yv = side * CL.EYE['y'] + dy
        hinge = B(1.54, yv, CL.FLOOR_Z + 0.30)
        pc = B(1.61, yv, CL.FLOOR_Z + 0.17)
        pad = SE('pd', pc, (0.10, 0.028, 0.23), n=(5, 5), seg=(16, 10), rot=Rt, col=col, mat=mats['dark'])
        grip = SE('pdg', pc + np.array([0, -0.012, 0]), (0.085, 0.010, 0.20), n=(6, 6), seg=(12, 8), rot=Rt, col=col, mat=mats['rubber'])
        arm = geo.cylinder('pa', hinge, pc + np.array([0, 0.012, 0.08]), 0.014, n=8, col=col, mat=mats['frame'])
        o = geo.join([pad, grip, arm], f'ck_pedal_{tag}_{lr}')
        geo.set_origin(o, hinge)
        out.append(o)
    return out


def cb_panels(col, mats, region):
    """Circuit-breaker panels on the rear side walls (behind both seats)."""
    a, x0, y0, w, h = region
    out = []
    for side in (-1, 1):
        s0, s1 = 3.35, 4.15
        z0, z1 = -0.05, 0.60
        yl = [lining_halfwidth(s, (z0 + z1) / 2) * side - side * 0.02 for s in (s0, s1)]
        pts = [B(s0, yl[0], z1), B(s0, yl[0], z0), B(s1, yl[1], z0), B(s1, yl[1], z1)]
        uv = [(x0 / CL.ATLAS, 1 - y0 / CL.ATLAS), (x0 / CL.ATLAS, 1 - (y0 + h) / CL.ATLAS),
              ((x0 + w) / CL.ATLAS, 1 - (y0 + h) / CL.ATLAS), ((x0 + w) / CL.ATLAS, 1 - y0 / CL.ATLAS)]
        if side > 0:
            pts = [pts[3], pts[2], pts[1], pts[0]]
            uv = [uv[3], uv[2], uv[1], uv[0]]
        acc = Acc()
        acc.poly(pts, uv, want=np.array([-side, 0, 0]))
        out.append(acc)
    return out


def ceiling(col, mats):
    objs = []
    SE = geo.superellipsoid
    for s in (3.45, 3.95):
        zt = lining_top(s) - 0.012
        objs.append(SE('dome', B(s, 0.0, zt), (0.22, 0.22, 0.03), n=(2, 4), seg=(24, 8), col=col, mat=mats['dome']))
    for side in (-1, 1):
        # map/reading lights + air outlets beside the overhead, assist handle, sliding window handle and rail
        for s, kind in ((2.35, 'rl'), (2.55, 'gasp'), (2.85, 'rl')):
            y = side * 0.46
            zt = lining_top_at(s, y) - 0.012
            if kind == 'rl':      # map / reading light: flat bezel with a lens
                objs.append(SE('rl', B(s, y, zt), (0.095, 0.095, 0.018), n=(2, 6), seg=(20, 6), col=col, mat=mats['frame']))
                objs.append(SE('rll', B(s, y, zt - 0.009), (0.045, 0.045, 0.012), n=(2, 3), seg=(16, 6), col=col, mat=mats['dome']))
            else:                 # air outlet (gasper): ring + nozzle
                objs.append(SE('gasp', B(s, y, zt), (0.070, 0.070, 0.016), n=(2, 6), seg=(20, 6), col=col, mat=mats['frame']))
                objs.append(geo.cylinder('gnoz', B(s, y, zt - 0.006), B(s, y, zt - 0.03), 0.016, 0.012, n=14, col=col, mat=mats['metal']))
        a = B(3.1, side * 1.38, 0.98)
        b2 = B(3.45, side * 1.34, 0.98)
        objs.append(geo.cylinder('hdl', a, b2, 0.013, n=10, col=col, mat=mats['frame']))
    return objs


def windows(col, mats):
    """Sliding side windows: inner frame, locking handle, track; sun visors stowed on rails; centre-post compass."""
    objs = []
    for side in (-1, 1):
        prm = np.array(LY.ck_window_params('slide', side))
        pts = lining_pts(prm[:, 0], prm[:, 1], LINING_OFF + 0.012)
        # frame bars along the four edges of the sliding window
        for k in range(4):
            objs.append(geo.cylinder('swf', pts[k], pts[(k + 1) % 4], 0.012, n=8, col=col, mat=mats['frame']))
        # handle on the aft-lower part: grip bar on two standoffs
        s_h, z_h = 2.52, 0.42
        ph = lining_pts(np.array([s_h]), np.array([LY.theta_at(s_h, z_h, side)]), LINING_OFF + 0.06)[0]
        ph2 = lining_pts(np.array([s_h + 0.10]), np.array([LY.theta_at(s_h + 0.10, z_h, side)]), LINING_OFF + 0.06)[0]
        objs.append(geo.cylinder('swh', ph, ph2, 0.011, n=10, col=col, mat=mats['frame']))
        for q in (ph, ph2):
            w = lining_pts(np.array([CL.S_CG - q[1]]), np.array([LY.theta_at(CL.S_CG - q[1], z_h, side)]), LINING_OFF)[0]
            objs.append(geo.cylinder('swhs', w, q, 0.007, n=8, col=col, mat=mats['frame']))
        objs.append(geo.box('swlock', tuple(ph + (ph2 - ph) * 0.1 + np.array([0, 0, 0.03])), (0.03, 0.03, 0.05), col=col,
                            mat=mats['red'], bevel=0.006))
        # sun visor stowed along the top of the sliding window, on a rail
        s0, s1, zv = 2.14, 2.58, 0.935
        r0 = lining_pts(np.array([s0]), np.array([LY.theta_at(s0, zv, side)]), LINING_OFF + 0.02)[0]
        r1 = lining_pts(np.array([s1]), np.array([LY.theta_at(s1, zv, side)]), LINING_OFF + 0.02)[0]
        objs.append(geo.cylinder('vrail', r0, r1, 0.006, n=8, col=col, mat=mats['metal']))
        vz = 0.11
        vpts = [r0 + np.array([0, 0, -0.01]), r1 + np.array([0, 0, -0.01]), r1 + np.array([-side * 0.03, 0, -vz]),
                r0 + np.array([-side * 0.03, 0, -vz])]
        acc = Acc()
        acc.poly(vpts, [(0, 0), (1, 0), (1, 1), (0, 1)], want=np.array([-side, 0, 0]))
        objs.append(acc.build('ck_visor', col, mats['visor']))
        objs.append(geo.cylinder('vedge', vpts[3], vpts[2], 0.004, n=6, col=col, mat=mats['frame']))
    # standby compass + compass light on the windshield centre post
    c = B(1.895, 0.0, 0.84)
    objs.append(geo.box('ck_compass', tuple(c), (0.075, 0.06, 0.055), col=col, mat=mats['dark'], bevel=0.008))
    objs.append(geo.cylinder('ck_compglass', c + np.array([0, -0.031, 0]), c + np.array([0, -0.036, 0]), 0.022, n=16, col=col,
                             mat=mats['lens']))
    for dx, m in ((-0.022, 'white'), (0.0, 'red'), (0.022, 'white')):
        q = c + np.array([dx, -0.02, -0.05])
        objs.append(geo.cylinder('cl', q, q + np.array([0, -0.01, 0]), 0.006, n=10, col=col, mat=mats[m]))
    return objs


def levers(col, mats, ped_main):
    """Thrust levers (on the drum axis), speed brake + flap levers (pivots below the pedestal), gear lever."""
    out = {}
    fr = ped_main['frame']
    W = ped_main['w']
    cx = W / 2
    # --- thrust lever drum axis (see drum()): the levers pivot on it
    piv_y, depth = DRUM['yc'], DRUM['depth']
    for i, dx in ((1, -0.022), (2, 0.022)):
        piv = fr.p(cx + dx, piv_y, -depth)
        up = fr.N
        L = DRUM['R'] + 0.085
        parts = [geo.cylinder('ts', piv, piv + up * L, 0.006, n=10, col=col, mat=mats['metal'])]
        top = piv + up * (L + 0.012)
        outward = fr.U * (-1 if i == 1 else 1)
        # handle: rounded block leaning outward with the A/THR disconnect button on the outside face
        parts.append(geo.superellipsoid('th', top, (0.040, 0.058, 0.034), n=(4, 3), seg=(20, 12), col=col, mat=mats['knob']))
        parts.append(geo.superellipsoid('tg', top + outward * 0.018 + up * 0.004, (0.018, 0.050, 0.030), n=(3, 3), seg=(14, 10),
                                        col=col, mat=mats['knob']))
        parts.append(geo.cylinder('tdisc', top + outward * 0.026, top + outward * 0.032, 0.0065, n=12, col=col, mat=mats['red']))
        # reverse latch lever in front of the handle
        parts.append(geo.box('trev', tuple(piv + up * (L - 0.035) + fr.V * -0.014), (0.012, 0.010, 0.040), col=col, mat=mats['knob'],
                             bevel=0.003))
        o = geo.join(parts, f'ck_thr_{i}')
        geo.set_origin(o, piv)
        out[o.name] = o
    # --- speed brake (left margin slot) and flap lever (right margin slot)
    for name, x, v_rest, L in (('ck_sb_lever', 0.158 + 0.011, 0.358, 0.22), ('ck_flap_lever', W - 0.158 - 0.011, 0.383, 0.226)):
        top_pt = fr.p(x, v_rest, 0.0)
        piv = top_pt - fr.N * (L - 0.06)
        parts = [geo.cylinder('ls', piv, top_pt + fr.N * 0.05, 0.004, n=8, col=col, mat=mats['metal'])]
        h = top_pt + fr.N * 0.062
        if name == 'ck_sb_lever':
            parts.append(geo.superellipsoid('lh', h, (0.012, 0.040, 0.030), n=(3, 4), seg=(12, 10), col=col, mat=mats['knob']))
            parts.append(geo.superellipsoid('lhp', h + fr.N * 0.012, (0.014, 0.046, 0.010), n=(3, 4), seg=(12, 8), col=col,
                                            mat=mats['knob']))
        else:
            parts.append(geo.superellipsoid('lh', h, (0.050, 0.016, 0.016), n=(4, 4), seg=(14, 8), col=col, mat=mats['knob']))
            parts.append(geo.superellipsoid('lhk', h + fr.N * 0.012, (0.020, 0.024, 0.020), n=(3, 3), seg=(12, 8), col=col,
                                            mat=mats['knob']))
        o = geo.join(parts, name)
        geo.set_origin(o, piv)
        out[name] = o
    # --- landing gear lever (centre panel, right of the SD): arm from a pivot behind the slot, wheel-shaped knob
    cp = PANELS['mip_center']
    frc = cp['frame']
    rx = cp['w'] - 0.188
    xs, vs = rx + 0.036, 0.263
    piv = frc.p(xs, vs, -0.02)
    ang = math.radians(32)
    dirv = frc.N * math.cos(ang) - frc.V * math.sin(ang)       # rest = UP position
    tip = piv + dirv * 0.056
    parts = [geo.cylinder('ga', piv, tip, 0.0055, n=10, col=col, mat=mats['metal'])]
    parts.append(geo.cylinder('gw', tip - frc.U * 0.010, tip + frc.U * 0.010, 0.017, n=24, col=col, mat=mats['knob_lt']))
    parts.append(geo.cylinder('gwh', tip - frc.U * 0.011, tip + frc.U * 0.011, 0.007, n=12, col=col, mat=mats['knob']))
    o = geo.join(parts, 'ck_gear_lever')
    geo.set_origin(o, piv)
    out['ck_gear_lever'] = o
    return out


DRUM = dict(R=0.16, depth=0.115, yc=0.133, half_w=0.055)


def drum(col, mats, ped_main):
    """Thrust lever quadrant drum (cylinder segment about the lever pivot axis), textured from the 'quadrant' region,
    with the pitch trim wheels on both sides."""
    fr = ped_main['frame']
    cx = ped_main['w'] / 2
    R, depth, yc, hw = DRUM['R'], DRUM['depth'], DRUM['yc'], DRUM['half_w']
    a_max = math.acos(depth / R)
    a, x0, y0, w, h = REG['quadrant']
    acc = Acc()
    na = 28
    angs = np.linspace(-a_max, a_max, na)
    rows = []
    for t in angs:
        v = yc + R * math.sin(t)
        hgt = R * math.cos(t) - depth
        rows.append((fr.p(cx - hw, v, hgt), fr.p(cx + hw, v, hgt)))
    for i in range(na - 1):
        (a0, a1), (b0, b1) = rows[i], rows[i + 1]
        u0, u1 = x0 / CL.ATLAS, (x0 + w) / CL.ATLAS
        v0 = 1 - (y0 + h * i / (na - 1)) / CL.ATLAS
        v1 = 1 - (y0 + h * (i + 1) / (na - 1)) / CL.ATLAS
        acc.poly([a0, b0, b1, a1], [(u0, v0), (u0, v1), (u1, v1), (u1, v0)], want=fr.N)
    # side caps (circular segments)
    su = swatch_uv('A', SW_PANEL)
    for sx in (-hw, hw):
        pts = [fr.p(cx + sx, yc + R * math.sin(t), R * math.cos(t) - depth) for t in angs]
        acc.poly(pts, [su] * len(pts), want=fr.U * np.sign(sx))
    dr = acc.build('ck_drum', col, mats['panelA'])
    # pitch trim wheels: black discs with white index stripes
    parts = []
    for sgn in (-1, 1):
        wc = fr.p(cx + sgn * 0.074, yc - 0.004, -0.058)
        axis = fr.U
        parts.append(geo.cylinder('tw', wc - axis * 0.014, wc + axis * 0.014, 0.125, n=56, col=col, mat=mats['rubber']))
        parts.append(geo.cylinder('twh', wc - axis * 0.0145, wc + axis * 0.0145, 0.030, n=16, col=col, mat=mats['frame']))
        for k in range(8):
            t = -0.6 + k * 0.16
            p = wc + (fr.N * math.cos(t) + fr.V * math.sin(t)) * 0.125
            parts.append(geo.box('twm', tuple(p + fr.N * 0.0005), (0.029, 0.004, 0.004), col=col, mat=mats['white'],
                                 rot=np.stack([fr.U, fr.V * math.cos(t) - fr.N * math.sin(t), fr.N * math.cos(t) + fr.V * math.sin(t)], 1)))
    return dr, parts


# ================================================================================================ build

PANELS = {}


def build(col, mats_ext):
    global REG, PANELS
    mats = materials()
    mats['strap'] = geo.principled('ck_strap', color=(0.05, 0.055, 0.07), roughness=0.8)
    root = bpy.data.objects.new('interior', None)
    col.objects.link(root)
    panels = CL.all_panels()
    PANELS = {p['name']: p for p in panels}
    REG = CL.regions()
    base = {'A': Acc(), 'B': Acc()}
    items = {'A': Acc(), 'B': Acc()}
    small = {k: Acc() for k in ('knob', 'knob_lt', 'white', 'red', 'frame')}
    small['metal_acc'] = []
    screens = []
    for pn in panels:
        at = pn['atlas']
        panel_base(pn, base[at], at)
        panel_rim(pn, items[at], at)
        panel_items(pn, items[at], small, at)
        screens += screen_quads(pn, col, mats)
    for acc in cb_panels(col, mats, REG['cb']):
        # CB panels are flat atlas-B faces: merge into the base accumulator (irradiance baked on them too)
        off = len(base['B'].v)
        base['B'].v.extend(acc.v)
        base['B'].f.extend([tuple(i + off for i in fc) for fc in acc.f])
        base['B'].uv.extend(acc.uv)
    ped_main = PANELS['ped_main']
    dr, trim_parts = drum(col, mats, ped_main)
    grp = {}
    grp['base'] = {a: base[a].build(f'ck_panelbase{a}', col, mats['panel' + a]) for a in 'AB'}
    grp['items'] = {a: items[a].build(f'ck_panelitems{a}', col, mats['panel' + a]) for a in 'AB'}
    grp['items']['A'] = geo.join([grp['items']['A'], dr], 'ck_panelitemsA')
    smalls = []
    for k in ('knob', 'knob_lt', 'white', 'red', 'frame'):
        o = small[k].build(f'ck_small_{k}', col, mats[k], smooth=False)
        if o is not None:
            smalls.append(o)
    extra = {}
    for e in small['metal_acc']:
        if e[0] == 'cyl':
            _, p0, p1, r0, r1, n, mk = e
            extra.setdefault(mk, []).append(geo.cylinder('sm', p0, p1, r0, r1, n=n, col=col, mat=mats[mk]))
        else:
            _, c, size, fr, mk = e
            R = np.stack([fr.U, fr.V, fr.N], 1)
            extra.setdefault(mk, []).append(geo.box('sm', tuple(c), size, col=col, mat=mats[mk], rot=R, bevel=0.002))
    for mk, lst in extra.items():
        smalls.append(geo.join(lst, f'ck_small2_{mk}'))
    smalls.append(geo.join(trim_parts, 'ck_trimwheels'))
    # ---- shell and structures
    shell, reveals = lining(col, mats)
    fixed = [shell, reveals, glareshield(col, mats)]
    fixed += floor_and_bulkhead(col, mats)
    fixed += mip_structure(col, mats) + pedestal_body(col, mats) + overhead_body(col, mats) + console_body(col, mats)
    fixed += windows(col, mats) + ceiling(col, mats)
    fixed += [tiller(-1, col, mats), tiller(1, col, mats)]
    seats = [seat(-1, col, mats), seat(1, col, mats)]
    anim = [sidestick(-1, col, mats), sidestick(1, col, mats)] + pedals(-1, col, mats) + pedals(1, col, mats)
    anim += list(levers(col, mats, ped_main).values())
    # merge static structure by material (few draw calls); visors stay separate (alpha blended)
    by_mat = {}
    visors = []
    for o in fixed:
        if o is None:
            continue
        if o.name.startswith('ck_visor'):
            visors.append(o)
            continue
        key = o.data.materials[0].name if o.data.materials else 'none'
        if o.name == 'ck_lining':
            key = 'lining_multi'
        by_mat.setdefault(key, []).append(o)
    merged = [geo.join(lst, f'ck_static_{k}') for k, lst in by_mat.items()]
    vis = geo.join(visors, 'ck_visors')
    allobj = merged + seats + smalls + [vis] + list(grp['base'].values()) + list(grp['items'].values()) + screens + anim
    for o in allobj:
        if o is not None:
            geo.parent_keep(o, root)
    grp.update(root=root, shell=merged + seats, smalls=smalls, visors=[vis] if vis else [], screens=screens, anim=anim)
    tris = sum(geo.tri_count(o) for o in allobj if o is not None)
    print('[cockpit] triangles', tris, flush=True)
    return grp


if __name__ == '__main__':
    pass
