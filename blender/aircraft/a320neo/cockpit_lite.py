"""Light flight-deck stand-in `interior_lite` for the exterior GLB (CONTRACTS-SF.md 6.2.1, <= 15k triangles): what is
seen through the windows from outside -- lining with the window openings, floor and bulkhead, glareshield, the panel
faces (baked atlas downsampled to 1024^2 / 512^2, display images painted in and self-lit), pedestal / overhead /
console bodies, two low-poly seats and two pilots with headsets.  Built after cockpit.py in the same Blender session."""
import math
import os
import numpy as np
import bpy
from mathutils import Matrix
import geo
import layout as LY
import cockpit as CK
import cockpit_layout as CL

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'build', 'bake')
DISP = os.path.join(HERE, 'build', 'displays')
B = CL.B


def _pixels(im):
    a = np.empty(im.size[0] * im.size[1] * 4, np.float32)
    im.pixels.foreach_get(a)
    return a.reshape(im.size[1], im.size[0], 4)


def _save(arr, path, q=85):
    h, w = arr.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), w, h, alpha=False, float_buffer=False)
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = np.clip(arr[..., :3], 0, 1)
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = 'JPEG'
    im.save(quality=q)
    bpy.data.images.remove(im)
    return path


def _scaled(path, res):
    im = bpy.data.images.load(path, check_existing=False)
    im.scale(res, res)
    a = _pixels(im)
    bpy.data.images.remove(im)
    return a


def lite_textures(src):
    """Downsample the baked panel atlases; paste the display images (self-lit) into the A atlas."""
    os.makedirs(OUT, exist_ok=True)
    res = 1024
    col = _scaled(src['panelA'], res)
    emi = _scaled(src['emitA'], res) * 1.0
    k = res / CL.ATLAS
    for pn in CL.all_panels():
        if pn['atlas'] != 'A':
            continue
        a, x0, y0, w, h = CK.REG[pn['name']]
        appm = w / pn['w']
        for it in pn['items']:
            if it['k'] != 'screen':
                continue
            p = os.path.join(DISP, it['name'] + '.png')
            if not os.path.exists(p):
                continue
            px0, py0 = (x0 + it['x'] * appm) * k, (y0 + it['y'] * appm) * k
            pw, ph = max(2, int(it['w'] * appm * k)), max(2, int(it['h'] * appm * k))
            im = bpy.data.images.load(p, check_existing=False)
            im.scale(pw, ph)
            d = _pixels(im)[..., :3] * 0.85
            bpy.data.images.remove(im)
            # Blender pixel rows start at the bottom
            r0 = res - int(py0) - ph
            c0 = int(px0)
            col[r0:r0 + ph, c0:c0 + pw, :3] = d
            emi[r0:r0 + ph, c0:c0 + pw, :3] = d
    pa = _save(col, os.path.join(OUT, 'lite_panelA.jpg'), 85)
    pe = _save(emi, os.path.join(OUT, 'lite_emitA.jpg'), 80)
    srcB = src['panelA'].replace('panelA', 'panelB').replace('atlasA', 'atlasB')
    pb = _save(_scaled(srcB, 512), os.path.join(OUT, 'lite_panelB.jpg'), 82)
    return pa, pe, pb


def lite_lining(col, mat):
    s_arr = np.linspace(1.25, 4.40, 16)
    th = np.linspace(0, 2 * math.pi, 44, endpoint=False)
    S, T = np.meshgrid(s_arr, th, indexing='ij')
    P = CK.lining_pts(S, T, CK.LINING_OFF)
    o = geo.grid_mesh('lite_lining', P, closed=True, col=col, mat=mat, auto_orient=True)
    geo.flip_normals(o)                    # visible from inside
    cutters = []
    for side in (1, -1):
        for wn in ('ws', 'slide', 'fixed'):
            prm = LY.ck_window_params(wn, side)
            if side < 0:
                prm = prm[::-1]
            cutters.append(CK.radial_prism(CK.densify(prm, 6), col))
    cut = geo.join(cutters, 'litecut')
    geo.boolean(o, cut, 'DIFFERENCE', 'EXACT')
    bpy.data.objects.remove(cut, do_unlink=True)
    return o


def low_seat(side, col, m_fab, m_shell):
    y0 = side * CL.EYE['y']
    SE = geo.superellipsoid
    rec = math.radians(14)
    Rb = np.array(Matrix.Rotation(-rec, 3, 'X'))
    back_dir = np.array([0, -math.sin(rec), math.cos(rec)])
    back_n = np.array([0, math.cos(rec), math.sin(rec)])
    sp = B(CL.SRP['s'], y0, CL.SRP['z'])
    parts = [SE('lpan', sp + np.array([0, 0.225, -0.04]), (0.46, 0.46, 0.10), n=(6, 3), seg=(12, 6), col=col, mat=m_fab),
             SE('lback', sp + back_dir * 0.33 + back_n * 0.05, (0.46, 0.11, 0.62), n=(6, 3), seg=(12, 6), rot=Rb, col=col, mat=m_fab),
             SE('lshell', sp + back_dir * 0.38 - back_n * 0.02, (0.50, 0.07, 0.80), n=(6, 4), seg=(12, 6), rot=Rb, col=col, mat=m_shell),
             SE('lhead', sp + back_dir * 0.80 + back_n * 0.04, (0.30, 0.10, 0.18), n=(4, 3), seg=(10, 6), rot=Rb, col=col, mat=m_fab),
             geo.box('lcol', tuple(B(CL.SRP['s'] - 0.18, y0, (CL.FLOOR_Z + CL.SRP['z'] - 0.12) / 2)),
                     (0.30, 0.34, CL.SRP['z'] - 0.12 - CL.FLOOR_Z), col=col, mat=m_shell)]
    for dy in (-0.285, 0.285):
        parts.append(SE('larm', B(CL.SRP['s'] - 0.13, y0 + dy, CL.SRP['z'] + 0.235), (0.065, 0.32, 0.055), n=(4, 3), seg=(8, 4),
                        col=col, mat=m_shell))
    return geo.join(parts, f'lite_seat_{side}')


def pilot(side, col, M):
    """Seated pilot: white shirt, dark trousers, headset; outboard hand on the side-stick."""
    y0 = side * CL.EYE['y']
    SE = geo.superellipsoid
    cyl = geo.cylinder
    parts = []
    head = B(2.48, y0, 0.67)
    parts.append(SE('phead', head, (0.155, 0.19, 0.225), n=(2.2, 2.2), seg=(14, 10), col=col, mat=M['skin']))
    parts.append(SE('phair', head + np.array([0, -0.02, 0.035]), (0.165, 0.19, 0.17), n=(2.2, 2.2), seg=(14, 8), col=col, mat=M['hair']))
    parts.append(cyl('pneck', head + np.array([0, -0.02, -0.08]), head + np.array([0, -0.03, -0.17]), 0.05, n=8, col=col, mat=M['skin']))
    for dy in (-0.085, 0.085):
        parts.append(cyl('pear', head + np.array([dy, -0.01, 0.0]), head + np.array([dy * 1.25, -0.01, 0.0]), 0.042, n=10, col=col,
                         mat=M['black']))
    arc = [head + np.array([0.09 * math.cos(a), -0.01, 0.12 * math.sin(a)]) for a in np.linspace(0, math.pi, 7)]
    for a, b in zip(arc, arc[1:]):
        parts.append(cyl('pband', a, b, 0.009, n=6, col=col, mat=M['black']))
    torso = B(2.56, y0, 0.28)
    parts.append(SE('ptorso', torso, (0.40, 0.24, 0.56), n=(2.6, 2.4), seg=(14, 10), col=col, mat=M['shirt'],
                    rot=np.array(Matrix.Rotation(math.radians(-8), 3, 'X'))))
    parts.append(SE('phips', B(2.50, y0, -0.02), (0.38, 0.28, 0.16), n=(2.6, 2.6), seg=(12, 6), col=col, mat=M['trousers']))
    for sgn in (-1, 1):
        sh = B(2.55, y0 + sgn * 0.20, 0.48)
        outboard = sgn == side
        if outboard:        # side-stick hand
            el = B(2.36, y0 + sgn * 0.33, 0.20)
            hand = B(2.17, side * CL.STICK['y'], 0.17)
        else:               # hand resting on the thigh
            el = B(2.40, y0 + sgn * 0.22, 0.16)
            hand = B(2.20, y0 + sgn * 0.12, 0.05)
        parts.append(cyl('puarm', sh, el, 0.055, 0.048, n=8, col=col, mat=M['shirt']))
        parts.append(cyl('pfarm', el, hand, 0.042, 0.035, n=8, col=col, mat=M['skin']))
        parts.append(SE('phand', hand, (0.07, 0.09, 0.05), n=(2.2, 2.2), seg=(8, 5), col=col, mat=M['skin']))
        hip = B(2.48, y0 + sgn * 0.10, -0.04)
        knee = B(2.02, y0 + sgn * 0.12, 0.03)
        foot = B(1.66, y0 + sgn * 0.12, -0.36)
        parts.append(cyl('pthigh', hip, knee, 0.085, 0.065, n=8, col=col, mat=M['trousers']))
        parts.append(cyl('pshin', knee, foot, 0.058, 0.045, n=8, col=col, mat=M['trousers']))
        parts.append(SE('pshoe', foot + np.array([0, 0.06, -0.03]), (0.10, 0.26, 0.09), n=(2.5, 2.5), seg=(8, 5), col=col, mat=M['black']))
    return geo.join(parts, f'lite_pilot_{side}')


def build(col, src):
    P = geo.principled
    pa, pe, pb = lite_textures(src)
    M = dict(
        panelA=P('lite_panelA', color=(1, 1, 1), roughness=0.55, tex=pa, emission=(1, 1, 1), emission_strength=1.0, emission_tex=pe),
        panelB=P('lite_panelB', color=(1, 1, 1), roughness=0.6, tex=pb),
        wall=P('lite_wall', color=(0.16, 0.17, 0.18), roughness=0.85),
        dark=P('lite_dark', color=(0.03, 0.032, 0.036), roughness=0.7),
        body=P('lite_body', color=(0.12, 0.145, 0.18), roughness=0.65),
        fab=P('lite_fabric', color=(0.05, 0.06, 0.08), roughness=0.95),
        shirt=P('lite_shirt', color=(0.80, 0.82, 0.85), roughness=0.8),
        skin=P('lite_skin', color=(0.55, 0.38, 0.29), roughness=0.6),
        hair=P('lite_hair', color=(0.04, 0.03, 0.025), roughness=0.7),
        trousers=P('lite_trousers', color=(0.02, 0.025, 0.04), roughness=0.8),
        black=P('lite_black', color=(0.012, 0.012, 0.014), roughness=0.5),
    )
    root = bpy.data.objects.new('interior_lite', None)
    col.objects.link(root)
    objs = [lite_lining(col, M['wall'])]
    # floor + bulkhead
    acc = CK.Acc()
    z = CL.FLOOR_Z
    ss = np.linspace(1.35, 4.40, 4)
    rows = [[B(s, -CK.lining_halfwidth(s, z), z), B(s, CK.lining_halfwidth(s, z), z)] for s in ss]
    for a, b in zip(rows, rows[1:]):
        acc.poly([a[0], b[0], b[1], a[1]], [(0, 0)] * 4, want=(0, 0, 1))
    th = np.linspace(0, 2 * math.pi, 24, endpoint=False)
    Pl = CK.lining_pts(np.full_like(th, 4.36), th, CK.LINING_OFF)
    ring = [B(4.36, a, max(c, z)) for a, c in zip(Pl[:, 0], Pl[:, 2])]
    cen = np.mean(ring, 0)
    for k in range(len(ring)):
        acc.poly([cen, ring[k], ring[(k + 1) % len(ring)]], [(0, 0)] * 3, want=(0, 1, 0))
    objs.append(acc.build('lite_floor', col, M['dark']))
    gs = CK.glareshield(col, {'glare': M['dark']})
    objs.append(gs)
    # panel faces (downsampled baked atlases share the atlas UVs)
    for at in 'AB':
        acc = CK.Acc()
        for pn in CL.all_panels():
            if pn['atlas'] == at:
                CK.panel_base(pn, acc, at)
        objs.append(acc.build(f'lite_panels{at}', col, M['panel' + at]))
    mats = {'bluegrey': M['body'], 'dark': M['dark'], 'frame': M['dark'], 'lining_dk': M['body']}
    objs += CK.pedestal_body(col, mats)
    objs += CK.overhead_body(col, mats)
    for side in (-1, 1):
        acc = CK.Acc()
        zt, fz = CL.CONS_Z, CL.FLOOR_Z
        yi = side * CL.CONS_Y0
        acc.poly([B(CL.CONS_S0, yi, zt), B(CL.CONS_S1, yi, zt), B(CL.CONS_S1, yi, fz), B(CL.CONS_S0, yi, fz)], [(0, 0)] * 4,
                 want=(-side, 0, 0))
        objs.append(acc.build('lite_cons', col, M['body']))
        objs.append(low_seat(side, col, M['fab'], M['dark']))
        objs.append(pilot(side, col, M))
    # merge by material
    by = {}
    for o in objs:
        if o is None:
            continue
        by.setdefault(o.data.materials[0].name if o.data.materials else 'x', []).append(o)
    out = [geo.join(l, f'lite_{k}') for k, l in by.items()]
    for o in out:
        geo.parent_keep(o, root)
    return root
