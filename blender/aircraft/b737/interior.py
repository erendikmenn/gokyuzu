"""737-800 flight deck geometry (node `interior`): panels UV-mapped onto the painted panel atlas, 3D controls
(Boeing pointer knobs, bat-handle toggles, guards, pushbutton lights, gauges, CDUs, display units), glareshield,
control stand (thrust levers, speed brake, flap lever with gates, striped stab trim wheels, parking brake, start
levers, fire handles), yokes with the Boeing hub, seats, rudder pedals, tiller, window frames, sun visors,
standby compass, lining, floor, door. See fdlayout.py for the panel layout and textures_fd.py for the painter.

Objects created (all children of `interior`):
  flightdeck_panels  panel atlas material (fd_panel), ambient occlusion is baked into the atlas later
  flightdeck_parts   knobs / toggles / guards / bezels (small constant-colour materials)
  flightdeck_body    structure; built with UVs into tex/fd_swatch.png ("fd_src"), rebaked by bake_fd.py into a
                     unique-UV atlas with colour x ambient occlusion x soft interior light (fd_body)
  yoke_col_L/R, yoke_L/R, lever_thrust_1/2, lever_speedbrake, lever_flap   movable parts (pivot = hinge)
  screen_*           display surfaces (UV 0..1, v = 0 at the top)
"""
import math
import numpy as np
import bpy

import shape as S
import mk
from mk import MeshData
import materials as MAT
import fdlayout as FL

TB = S.to_b
A = FL.ATLAS

# material slots of the merged static objects (cabin.py uses M_PANEL / M_DARK / M_METAL with the panel list)
M_PANEL, M_DARK, M_METAL, M_RED, M_WHITE, M_TRIM, M_GLASS = range(7)
# parts object slots
P_BLACK, P_LIGHT, P_CHROME, P_TOGGLE, P_RED, P_GRAY, P_WHITE, P_GLASS, P_PANEL = range(9)
PARTS_KEYS = ['knob_black', 'knob_light', 'chrome', 'toggle', 'guard_red', 'part_gray', 'white', 'lens']


def create_materials(textured=True):
    T = textured
    M = {}
    M['panel'] = MAT.principled('fd_panel', (0.1, 0.105, 0.11), 0.58, 0.0, base='fd_base' if T else None,
                                emission_tex='fd_emit' if T else None, emission_strength=1.0)
    M['dark'] = MAT.principled('fd_knob', (0.018, 0.018, 0.02), 0.42, 0.0)
    M['metal'] = MAT.principled('fd_metal', (0.75, 0.76, 0.78), 0.25, 1.0)
    M['red'] = MAT.principled('fd_guard_red', (0.45, 0.02, 0.02), 0.4, 0.0)
    M['white'] = MAT.principled('fd_white', (0.8, 0.8, 0.8), 0.35, 0.0)
    M['trim'] = MAT.principled('fd_trim', (0.24, 0.25, 0.26), 0.72, 0.0)
    M['glass'] = MAT.principled('fd_glass', (0.02, 0.02, 0.02), 0.05, 0.0, alpha=0.25)
    # parts
    M['knob_black'] = MAT.principled('fd_knob_black', (0.016, 0.016, 0.018), 0.42, 0.0)
    M['knob_light'] = MAT.principled('fd_knob_light', (0.62, 0.60, 0.53), 0.42, 0.0)
    M['chrome'] = MAT.principled('fd_chrome', (0.80, 0.81, 0.82), 0.18, 1.0)
    M['toggle'] = MAT.principled('fd_toggle', (0.78, 0.76, 0.68), 0.32, 0.0)
    M['guard_red'] = MAT.principled('fd_guard_red2', (0.50, 0.025, 0.02), 0.32, 0.0)
    M['part_gray'] = MAT.principled('fd_part_gray', (0.085, 0.10, 0.115), 0.5, 0.2)
    M['lens'] = MAT.principled('fd_lens', (0.01, 0.01, 0.012), 0.06, 0.0)
    # structure source (swatch atlas) -- replaced by the baked fd_body material
    M['src'] = MAT.principled('fd_src', (0.5, 0.5, 0.5), 0.65, 0.0, base='fd_swatch' if T else None,
                              orm='fd_swatch_orm' if T else None)
    return M


def parts_mats(imats):
    return [imats[k] for k in PARTS_KEYS]


# ------------------------------------------------------------------ small helpers (also used by cabin.py)
SW = FL.SWATCH


def swatch_uv(name, u, v):
    x0, y0, x1, y1 = SW[name]
    return ((x0 + u * (x1 - x0)) / A, 1 - (y0 + (1 - v) * (y1 - y0)) / A)


def src_uv(name, u, v):
    x0, y0, x1, y1 = FL.SWATCH_SRC[name]
    return ((x0 + u * (x1 - x0)) / 1024.0, 1 - (y0 + (1 - v) * (y1 - y0)) / 1024.0)


def quad(md, pts, uvs, mat, flat=True):
    md.add(np.array(pts), [[0, 1, 2, 3]], list(uvs), mat=mat, flat=flat)


def oriented_box(md, c, axes, size, mat, front_uv=None, front_axis=2, other='plastic', other_mat=None, uvfun=None):
    """Box centred at c with axes (x, y, z unit vectors). front_uv(s, t) -> uv for the +z face; other faces use the
    'other' swatch of the panel atlas (or uvfun(face_index, s, t) if given)."""
    ax = [np.asarray(a, float) for a in axes]
    hx, hy, hz = [s / 2 for s in size]
    c = np.asarray(c, float)
    corners = {}
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                corners[(sx, sy, sz)] = c + ax[0] * hx * sx + ax[1] * hy * sy + ax[2] * hz * sz
    om = mat if other_mat is None else other_mat
    f = [corners[(-1, -1, 1)], corners[(1, -1, 1)], corners[(1, 1, 1)], corners[(-1, 1, 1)]]
    if front_uv:
        uvs = [front_uv(0, 0), front_uv(1, 0), front_uv(1, 1), front_uv(0, 1)]
    elif uvfun:
        uvs = [uvfun(0, 0, 0), uvfun(0, 1, 0), uvfun(0, 1, 1), uvfun(0, 0, 1)]
    else:
        uvs = [swatch_uv(other, 0.2, 0.2), swatch_uv(other, 0.8, 0.2), swatch_uv(other, 0.8, 0.8), swatch_uv(other, 0.2, 0.8)]
    quad(md, f, uvs, mat)
    sides = [
        [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],
        [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
        [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],
        [(1, 1, -1), (-1, 1, -1), (-1, 1, 1), (1, 1, 1)],
        [(-1, 1, -1), (-1, -1, -1), (-1, -1, 1), (-1, 1, 1)],
    ]
    for k, s in enumerate(sides):
        if uvfun:
            su = [uvfun(k + 1, 0, 0), uvfun(k + 1, 1, 0), uvfun(k + 1, 1, 1), uvfun(k + 1, 0, 1)]
        else:
            su = [swatch_uv(other, 0.2, 0.2), swatch_uv(other, 0.8, 0.2), swatch_uv(other, 0.8, 0.8), swatch_uv(other, 0.2, 0.8)]
        quad(md, [corners[q] for q in s], su, om)


def frame3(z, xhint):
    """Right-handed axes (x, y, z) with z given and x as close as possible to xhint."""
    z = np.asarray(z, float); z = z / np.linalg.norm(z)
    x = np.asarray(xhint, float); x = x - z * np.dot(x, z); x = x / np.linalg.norm(x)
    y = np.cross(z, x)
    return (x, y, z)


def cushion(md, c, axes, w, h, d, r, mat, uvf, bulge=0.012, n=4, taper=0.94):
    """Rounded cushion: rounded rectangle (w x h, corner radius r) in the axes[0]/axes[1] plane, depth d along
    axes[2], front face domed. uvf(px, py) -> uv (px, py in metres from the centre)."""
    ax, ay, az = [np.asarray(a_, float) for a_ in axes]
    c = np.asarray(c, float)
    poly = mk.rounded_rect(w, h, r, n)
    m = len(poly)
    V = []
    for zz, sc in ((-d / 2, taper), (-d / 2 + 0.3 * d, 1.0), (d / 2 - 0.25 * d, 1.0), (d / 2, taper - 0.02)):
        V.extend([c + ax * px * sc + ay * py * sc + az * zz for px, py in poly])
    base = md.nv
    md.v = np.vstack([md.v, np.array(V)]) if md.nv else np.array(V)
    for k in range(3):
        for i in range(m):
            j = (i + 1) % m
            md.f.append([base + k * m + i, base + k * m + j, base + (k + 1) * m + j, base + (k + 1) * m + i])
            md.uv.extend([uvf(*poly[i]), uvf(*poly[j]), uvf(*poly[j]), uvf(*poly[i])])
            md.mi.append(mat); md.sharp.append(False)
    cf = c + az * (d / 2 + bulge)
    ci = md.nv
    md.v = np.vstack([md.v, cf[None], (c - az * d / 2)[None]])
    for i in range(m):
        j = (i + 1) % m
        md.f.append([base + 3 * m + i, base + 3 * m + j, ci]); md.uv.extend([uvf(*poly[i]), uvf(*poly[j]), uvf(0, 0)])
        md.mi.append(mat); md.sharp.append(False)
        md.f.append([base + j, base + i, ci + 1]); md.uv.extend([uvf(*poly[j]), uvf(*poly[i]), uvf(0, 0)])
        md.mi.append(mat); md.sharp.append(False)


# ------------------------------------------------------------------ inner lining helpers
def inner_section(X, inset=0.085, n=96):
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    Y, Z = S.fus_point(np.full_like(th, X), th)
    zm = float(S.fus_profiles(X)['zm'])
    dY = np.gradient(np.concatenate([Y[-1:], Y, Y[:1]]))[1:-1]
    dZ = np.gradient(np.concatenate([Z[-1:], Z, Z[:1]]))[1:-1]
    ny, nz = -dZ, dY
    L = np.hypot(ny, nz) + 1e-9
    ny, nz = ny / L, nz / L
    sgn = np.sign(ny * Y + nz * (Z - zm) + 1e-9)
    return Y - ny * sgn * inset, Z - nz * sgn * inset


def half_width_at(X, Z, inset=0.085):
    Y, Zs = inner_section(X, inset, 180)
    m = Y > 0
    Ys, Zr = Y[m], Zs[m]
    i = np.argsort(Zr)
    return float(np.interp(Z, Zr[i], Ys[i]))


def x_of_halfwidth(Yabs, Z, inset=0.09, lo=1.6, hi=3.6):
    """Station where the inner lining at height Z reaches the lateral position Yabs (nose taper)."""
    for _ in range(40):
        mid = (lo + hi) / 2
        if half_width_at(mid, Z, inset) < Yabs:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def section_plate(md, X, z0, z1, mat, uvf, flip=False, xfun=None, inset=0.085, nz=14):
    """Flat plate filling the inner section at station X between heights z0..z1."""
    zs = np.linspace(z0, z1, nz)
    right = [(half_width_at(X, z, inset), z) for z in zs]
    pts = right + [(-y, z) for y, z in right[::-1]]
    P = [np.array([xfun(z) if xfun else X, y, z]) for y, z in pts]
    ymax = max(abs(y) for y, _ in pts) + 1e-6
    uvs = [uvf(0.5 + y / (2 * ymax), (z - z0) / max(z1 - z0, 1e-6)) for y, z in pts]
    face = list(range(len(P)))
    if flip:
        face = face[::-1]; uvs = uvs[::-1]
    md.add(np.array(P), [face], uvs, mat=mat, flat=True)


# =========================================================================================== PANELS
class Builder:
    def __init__(self, imats):
        self.imats = imats
        self.pan = MeshData()          # panel atlas material only (slot 0)
        self.parts = MeshData()        # slots per PARTS_KEYS
        self.body = MeshData()         # slot 0: fd_src
        self.screens = []
        self.lite_boxes = []           # simple shapes for interior_lite

    # --- atlas-mapped raised box on panel p (front face = atlas footprint)
    def pbox(self, p, cx, cy, w, h, d, off=0.0, side='plastic'):
        c = p.P(cx, cy, off + d / 2)
        fu = lambda s, t: p.uv(cx - w / 2 + s * w, cy - h / 2 + t * h)
        oriented_box(self.pan, c, (p.x, p.y, p.n), (w, h, d), 0, front_uv=fu, other=side)

    def slab(self, p):
        poly = p.shape or [(0, 0), (p.w, 0), (p.w, p.h), (0, p.h)]
        n = len(poly)
        md = self.pan
        front = [p.P(x, y, 0.0) for x, y in poly]
        back = [p.P(x, y, -p.depth) for x, y in poly]
        base = md.nv
        md.v = np.vstack([md.v, np.array(front), np.array(back)]) if md.nv else np.vstack([np.array(front), np.array(back)])
        # front face: triangulate concave outlines via ear clipping in 2D
        tris = ear_clip(poly)
        for t in tris:
            md.f.append([base + i for i in t]); md.uv.extend([p.uv(*poly[i]) for i in t]); md.mi.append(0); md.sharp.append(True)
        for i in range(n):
            j = (i + 1) % n
            md.f.append([base + i, base + n + i, base + n + j, base + j]); md.uv.extend([swatch_uv('grey', 0.5, 0.5)] * 4)
            md.mi.append(0); md.sharp.append(True)

    # --- controls
    def controls(self, p):
        for c in p.ctls:
            fn = getattr(self, 'c_' + c.kind, None)
            if fn:
                fn(p, c)

    def c_du(self, p, c):
        hw, hh = c.w + 0.030, c.h + 0.042
        self.pbox(p, c.x, c.y - 0.004, hw, hh, 0.014)
        self.screen(c.name, p, c.x, c.y, c.w, c.h, 0.0142)
        self.lite_boxes.append((p, c.x, c.y, c.w, c.h, c.name))

    def c_isfd(self, p, c):
        hw, hh = c.w + 0.016, c.h + 0.030
        self.pbox(p, c.x, c.y - 0.006, hw, hh, 0.016)
        self.screen(c.name, p, c.x, c.y, c.w, c.h, 0.0162)
        # BARO knob
        self.lathe_knob(p, c.x + hw / 2 - 0.007, c.y - c.h / 2 - 0.018, 0.0045, 0.010, P_BLACK, off=0.016, sides=14)

    def c_cdu(self, p, c):
        ox = c.x - FL.CDU_W / 2
        oy = c.y
        self.pbox(p, c.x, oy + FL.CDU_H / 2, FL.CDU_W, FL.CDU_H, 0.014)
        sx, sy, sw, sh = FL.CDU_SCREEN
        self.screen(c.name, p, ox + sx, oy + sy, sw, sh, 0.0141)
        for (name, kx, ky, kw, kh, lab, style) in FL.cdu_keys():
            self.pbox(p, ox + kx, oy + ky, kw, kh, 0.0045, off=0.014)
        self.lite_boxes.append((p, ox + sx, oy + sy, sw, sh, c.name))

    def c_knob(self, p, c):
        r = c.r or 0.012
        st = c.style or 'pointer'
        if st in ('pointer', 'start'):
            self.pointer_knob(p, c.x, c.y, r, big=(st == 'start'))
        elif st == 'round':
            self.lathe_knob(p, c.x, c.y, r, r * 1.3, P_LIGHT, knurl=True)
        elif st == 'mcp':
            self.lathe_knob(p, c.x, c.y, r, r * 1.35, P_BLACK, knurl=True, skirt=1.18)
        elif st == 'dual':
            self.lathe_knob(p, c.x, c.y, r, r * 0.7, P_BLACK, knurl=True, skirt=1.1)
            self.lathe_knob(p, c.x, c.y, r * 0.62, r * 1.45, P_BLACK, knurl=True, skirt=0.0)
        elif st == 'rudder':
            self.lathe_knob(p, c.x, c.y, r, r * 1.0, P_BLACK, knurl=True, skirt=1.1)
            self.pointer_knob(p, c.x, c.y, r * 0.75, big=False, mat=P_BLACK, base_h=r * 1.0)
        else:
            self.lathe_knob(p, c.x, c.y, r, r * 1.3, P_BLACK)

    def lathe_knob(self, p, x, y, r, h, mat, knurl=False, skirt=1.15, off=0.0, sides=None):
        base = p.P(x, y, off)
        prof = []
        if skirt:
            prof += [(r * skirt, 0.0), (r * skirt, 0.0022), (r * 0.98, 0.0030)]
        else:
            prof += [(r, 0.0)]
        prof += [(r, h * 0.85), (r * 0.9, h), (0.0, h)]
        n = sides or (24 if knurl else 18)
        mk.lathe(prof, n=n, origin=base, axis=p.n, ref=p.y, mat=mat, md=self.parts)
        # pointer line on top
        tip = p.P(x, y + r * 0.82, off + h + 0.0004)
        ctr = p.P(x, y + r * 0.15, off + h + 0.0004)
        w = p.x * max(0.0008, r * 0.08)
        quad(self.parts, [ctr - w, ctr + w, tip + w, tip - w], [(0.5, 0.5)] * 4, P_WHITE if mat == P_BLACK else P_BLACK)

    def pointer_knob(self, p, x, y, r, big=False, mat=P_LIGHT, base_h=None, angle=0.0):
        """Boeing rotary selector: round skirt + tapered pointer fin (cream)."""
        md = self.parts
        sk = r * 1.18
        bh = base_h if base_h is not None else r * 0.35
        mk.lathe([(sk, 0.0), (sk, bh * 0.7), (sk * 0.92, bh), (0.0, bh)], n=20, origin=p.P(x, y, 0.0), axis=p.n, ref=p.y,
                 mat=mat, md=md)
        # fin: rounded-teardrop outline in the panel plane, extruded along the normal, slightly tapered
        L = r * (2.3 if big else 2.1)
        W = r * (0.95 if big else 0.85)
        H = r * (1.25 if big else 1.15)
        pts = []
        for k in range(9):
            a = math.pi * k / 8
            pts.append((-W / 2 * math.cos(a) * 1.0, -L * 0.36 - W / 2 * math.sin(a)))
        pts = pts[::-1]
        pts = [(-W * 0.5, -L * 0.36), (-W * 0.34, L * 0.52), (0.0, L * 0.62), (W * 0.34, L * 0.52), (W * 0.5, -L * 0.36)] + \
              [(W / 2 * math.cos(math.pi * k / 8), -L * 0.36 - W / 2 * math.sin(math.pi * k / 8)) for k in range(1, 8)]
        ca, sa = math.cos(angle), math.sin(angle)
        rot = lambda q: (q[0] * ca - q[1] * sa, q[0] * sa + q[1] * ca)
        pts = [rot(q) for q in pts]
        n = len(pts)
        b = md.nv
        V = []
        for k, (zz, sc) in enumerate(((bh * 0.9, 1.0), (bh + H * 0.8, 0.96), (bh + H, 0.86))):
            V.extend([p.P(x + qx * sc, y + qy * sc, zz) for qx, qy in pts])
        md.v = np.vstack([md.v, np.array(V)])
        for k in range(2):
            for i in range(n):
                j = (i + 1) % n
                md.f.append([b + k * n + i, b + k * n + j, b + (k + 1) * n + j, b + (k + 1) * n + i])
                md.uv.extend([(0.5, 0.5)] * 4); md.mi.append(mat); md.sharp.append(False)
        md.f.append([b + 2 * n + i for i in range(n)]); md.uv.extend([(0.5, 0.5)] * n); md.mi.append(mat); md.sharp.append(True)
        # white index line on the fin top
        tip = p.P(x + rot((0, L * 0.55))[0] * 0.86, y + rot((0, L * 0.55))[1] * 0.86, bh + H + 0.0004)
        ctr = p.P(x + rot((0, L * 0.05))[0], y + rot((0, L * 0.05))[1], bh + H + 0.0004)
        w = p.x * max(0.0006, r * 0.06)
        if mat == P_LIGHT:
            quad(md, [ctr - w, ctr + w, tip + w, tip - w], [(0.5, 0.5)] * 4, P_BLACK)

    def c_toggle(self, p, c):
        md = self.parts
        small = bool(c.small)
        k = 0.72 if small else 1.0
        b = p.P(c.x, c.y, 0.0)
        # hex nut + bushing
        mk.lathe([(0.0056 * k, 0.0), (0.0056 * k, 0.0024 * k), (0.0036 * k, 0.0030 * k), (0.0036 * k, 0.0062 * k),
                  (0.0, 0.0062 * k)], n=6, origin=b, axis=p.n, ref=p.x, mat=P_CHROME, md=md)
        up = 1.0 if (hash(c.label or '') % 5) else -1.0     # most switches up, a few down
        if c.guard:
            up = -1.0
        tilt = math.radians(24) * up
        d = p.n * math.cos(tilt) + p.y * math.sin(tilt)
        a0 = b + p.n * 0.006 * k
        a1 = a0 + d * 0.013 * k
        mk.tube(a0, a1, 0.0015 * k, 0.0019 * k, n=8, caps=False, mat=P_CHROME, md=md)
        hmat = P_BLACK if c.handle == 'black' else P_TOGGLE
        hl = 0.0165 * k
        hr = 0.0053 * k
        mk.lathe([(0.0, 0.0), (hr * 0.85, 0.0), (hr, hl * 0.25), (hr, hl * 0.8), (hr * 0.75, hl * 0.97), (0.0, hl)],
                 n=12, origin=a1, axis=d, ref=p.x, mat=hmat, md=md)
        if c.guard:
            red = c.guard == 'red'
            gm = P_RED if red else P_BLACK
            cen = p.P(c.x, c.y + 0.004, 0.0175)
            oriented_box(md, cen, (p.x, p.y, p.n), (0.019, 0.034, 0.0022), gm, uvfun=lambda *a: (0.5, 0.5))
            for sx in (-1, 1):
                oriented_box(md, p.P(c.x + sx * 0.0086, c.y + 0.004, 0.0088), (p.x, p.y, p.n), (0.0018, 0.034, 0.0176), gm,
                             uvfun=lambda *a: (0.5, 0.5))
            oriented_box(md, p.P(c.x, c.y + 0.004 - 0.017, 0.004), (p.x, p.y, p.n), (0.019, 0.004, 0.008), gm,
                         uvfun=lambda *a: (0.5, 0.5))

    def c_annun(self, p, c):
        self.pbox(p, c.x, c.y, c.w, c.h, 0.0025 if not c.recess else 0.0015)

    def c_pbtn(self, p, c):
        self.pbox(p, c.x, c.y, c.w, c.h, 0.0065)

    def c_mc(self, p, c):
        self.pbox(p, c.x, c.y, c.w, c.h, 0.011)

    def c_rxknob(self, p, c):
        self.pbox(p, c.x, c.y, c.w, c.h, 0.009)

    def c_firehandle(self, p, c):
        self.pbox(p, c.x, c.y, c.w, c.h, 0.024)

    def c_lcd(self, p, c):
        # thin frame around the window (the window itself stays flush / painted)
        md = self.parts
        w, h = c.w + 0.004, c.h + 0.004
        t = 0.0018
        for (cx, cy, ww, hh) in ((c.x, c.y + h / 2, w + t, t), (c.x, c.y - h / 2, w + t, t), (c.x - w / 2, c.y, t, h), (c.x + w / 2, c.y, t, h)):
            oriented_box(md, p.P(cx, cy, 0.0012), (p.x, p.y, p.n), (ww, hh, 0.0024), P_GRAY, uvfun=lambda *a: (0.5, 0.5))

    def bezel(self, p, x, y, r, h=0.0045, mat=P_GRAY):
        prof = [(r * 0.98, h * 0.2), (r * 1.0, h), (r * 1.22, h * 0.9), (r * 1.24, 0.0)]
        mk.lathe(prof, n=32, origin=p.P(x, y, 0.0), axis=p.n, ref=p.y, mat=mat, md=self.parts)

    def c_gauge(self, p, c):
        self.bezel(p, c.x, c.y, c.r)

    def c_clock(self, p, c):
        self.bezel(p, c.x, c.y, c.r, h=0.006)

    def c_gear(self, p, c):
        md = self.parts
        piv = p.P(c.x, c.y, 0.0)
        tip = p.P(c.x, c.y - 0.070, 0.070)
        mk.tube(piv, tip, 0.0065, 0.0058, n=12, mat=P_CHROME, md=md)
        # white wheel-shaped handle, axis along the panel x
        mk.lathe([(0.0, -0.011), (0.013, -0.011), (0.021, -0.009), (0.024, -0.004), (0.024, 0.004), (0.021, 0.009), (0.013, 0.011),
                  (0.0, 0.011)], n=24, origin=tip, axis=p.x, ref=p.n, mat=P_TOGGLE, md=md)
        # slot guard plate
        oriented_box(md, p.P(c.x, c.y, 0.002), (p.x, p.y, p.n), (0.030, 0.160, 0.004), P_BLACK, uvfun=lambda *a: (0.5, 0.5))

    def c_wheel(self, p, c):
        mk.lathe([(0.0, -0.005), (0.013, -0.005), (0.014, 0.0), (0.013, 0.005), (0.0, 0.005)], n=24,
                 origin=p.P(c.x, c.y, -0.004), axis=p.x, ref=p.n, mat=P_BLACK, md=self.parts)

    def c_keypad(self, p, c):
        for i in range(12):
            rr, cc = divmod(i, 4)
            xx = c.x - c.w / 2 + (cc + 0.5) * c.w / 4
            yy = c.y + c.h / 2 - (rr + 0.5) * c.h / 3
            self.pbox(p, xx, yy, c.w / 4 * 0.78, c.h / 3 * 0.72, 0.004)

    def c_cb(self, p, c):
        mk.lathe([(0.0068, 0.0), (0.0068, 0.0025), (0.0052, 0.0035), (0.0048, 0.0085), (0.0, 0.0090)], n=10,
                 origin=p.P(c.x, c.y, 0.0), axis=p.n, ref=p.y, mat=P_BLACK, md=self.parts)
        mk.lathe([(0.0053, 0.0026), (0.0062, 0.0026), (0.0062, 0.0036), (0.0053, 0.0036)], n=10,
                 origin=p.P(c.x, c.y, 0.0), axis=p.n, ref=p.y, mat=P_WHITE, md=self.parts)

    def c_tiller(self, p, c):
        md = self.parts
        cen = p.P(c.x, c.y, 0.040)
        mk.lathe([(0.052, -0.007), (0.061, -0.004), (0.063, 0.0), (0.061, 0.004), (0.052, 0.007), (0.050, 0.0), (0.052, -0.007)],
                 n=32, origin=cen, axis=p.n, ref=p.x, mat=P_BLACK, md=md)
        mk.tube(p.P(c.x, c.y, 0.0), cen, 0.014, 0.012, n=12, mat=P_BLACK, md=md)
        mk.lathe([(0.0, 0.0), (0.018, 0.0), (0.017, 0.012), (0.0, 0.014)], n=16, origin=cen, axis=p.n, ref=p.x, mat=P_BLACK, md=md)
        for a in (90, 210, 330):
            d = p.x * math.cos(math.radians(a)) + p.y * math.sin(math.radians(a))
            mk.tube(cen, cen + d * 0.052, 0.005, n=8, caps=False, mat=P_BLACK, md=md)
        knob = cen + p.x * 0.056
        mk.tube(knob, knob + p.n * 0.040, 0.009, 0.008, n=12, mat=P_BLACK, md=md)
        mk.lathe([(0.0, 0.0), (0.075, 0.0), (0.075, 0.004), (0.0, 0.004)], n=32, origin=p.P(c.x, c.y, 0.0), axis=p.n, ref=p.x,
                 mat=P_GRAY, md=md)

    def screen(self, name, p, cx, cy, w, h, off):
        pts = [p.P(cx - w / 2, cy - h / 2, off), p.P(cx + w / 2, cy - h / 2, off), p.P(cx + w / 2, cy + h / 2, off),
               p.P(cx - w / 2, cy + h / 2, off)]
        self.screens.append((name, pts))


def ear_clip(poly):
    """Triangulate a simple polygon (list of 2D points, either winding) -> index triples with ccw orientation."""
    pts = [tuple(q) for q in poly]
    n = len(pts)
    if n == 3:
        return [(0, 1, 2)]
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    idx = list(range(n)) if area > 0 else list(range(n))[::-1]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(pt, a, b, c):
        return cross(a, b, pt) >= -1e-12 and cross(b, c, pt) >= -1e-12 and cross(c, a, pt) >= -1e-12

    tris = []
    guard = 0
    while len(idx) > 3 and guard < 1000:
        guard += 1
        m = len(idx)
        for k in range(m):
            i0, i1, i2 = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if cross(a, b, c) <= 1e-12:
                continue
            if any(inside(pts[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            break
    tris.append(tuple(idx))
    if area < 0:
        # the panel frame's front normal is +n; keep ccw in panel coordinates
        pass
    return tris


# =========================================================================================== STRUCTURE (fd_body)
C_IN = np.array((3.40, 0.0, 3.50))      # a point inside the flight deck (faces of the enclosure look at it)


def newell(P):
    P = np.asarray(P, float)
    n = np.zeros(3)
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        n += np.array(((a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])))
    return n


def face(md, pts, uvs, mat=0, toward=None, away=None, direction=None, flat=True):
    """Polygon whose normal is oriented towards a point / away from a point / along a direction."""
    P = np.asarray(pts, float)
    n = newell(P)
    c = P.mean(0)
    if direction is not None:
        ref = np.asarray(direction, float)
    elif toward is not None:
        ref = np.asarray(toward, float) - c
    elif away is not None:
        ref = c - np.asarray(away, float)
    else:
        ref = n
    if np.dot(n, ref) < 0:
        P = P[::-1]
        uvs = list(uvs)[::-1]
    md.add(P, [list(range(len(P)))], list(uvs), mat=mat, flat=flat)


def sbox(md, c, axes, size, sw, uvscale=1.0, faces=(0, 1, 2, 3, 4, 5)):
    """Closed box with swatch UVs (outward normals). axes = 3 unit vectors."""
    ax = [np.asarray(a, float) for a in axes]
    c = np.asarray(c, float)
    h = [s / 2 for s in size]
    corner = lambda sx, sy, sz: c + ax[0] * h[0] * sx + ax[1] * h[1] * sy + ax[2] * h[2] * sz
    quads = [
        [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],     # +z
        [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],  # -z
        [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],      # +x
        [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],  # -x
        [(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)],      # +y
        [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],  # -y
    ]
    uvq = [src_uv(sw, 0.1, 0.1), src_uv(sw, 0.9, 0.1), src_uv(sw, 0.9, 0.9), src_uv(sw, 0.1, 0.9)]
    for k in faces:
        pts = [corner(*q) for q in quads[k]]
        face(md, pts, uvq, 0, away=c)


def loft(md, rings, sw, closed=False, away=None, toward=None, cap=False, uv_rot=False):
    """Quads between consecutive rings (lists of 3D points of equal length). UVs: u along the ring, v across."""
    R = [np.asarray(r, float) for r in rings]
    n = len(R[0])
    L = []
    for r in R:
        seg = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(r, axis=0), axis=1))])
        L.append(seg / max(seg[-1], 1e-9))
    m = len(R)
    for i in range(m - 1):
        for j in range(n - 1 + (1 if closed else 0)):
            j1 = (j + 1) % n
            pts = [R[i][j], R[i][j1], R[i + 1][j1], R[i + 1][j]]
            if np.linalg.norm(newell(pts)) < 1e-10:
                continue
            u0, u1 = L[i][j], (L[i][j1] if j1 else 1.0)
            v0, v1 = i / (m - 1), (i + 1) / (m - 1)
            uvs = [src_uv(sw, 0.05 + 0.9 * u0, 0.05 + 0.9 * v0), src_uv(sw, 0.05 + 0.9 * u1, 0.05 + 0.9 * v0),
                   src_uv(sw, 0.05 + 0.9 * u1, 0.05 + 0.9 * v1), src_uv(sw, 0.05 + 0.9 * u0, 0.05 + 0.9 * v1)]
            if away is not None or toward is not None:
                face(md, pts, uvs, 0, away=away, toward=toward, flat=False)
            else:
                md.add(np.array(pts), [[0, 1, 2, 3]], uvs, mat=0, flat=False)


def gs_x_aft(Yabs):
    """Sweep of the glareshield aft face: straight across the MCP/EFIS/warning lights, then curving aft."""
    t = max(0.0, (Yabs - FL.GS_FACE_HALF) / 0.25)
    return 0.12 * t ** 1.6


def gs_lift(Yabs):
    """The brow gets shallower towards the side windows (its lower edge rises)."""
    t = max(0.0, (Yabs - FL.GS_FACE_HALF) / 0.25)
    return 0.06 * min(t, 1.0) ** 1.3


def glareshield(md):
    ys = np.concatenate([np.linspace(-0.95, -0.72, 8), np.linspace(-0.70, 0.70, 29), np.linspace(0.72, 0.95, 8)])
    rings = []
    Ztop = 3.575
    for Y in ys:
        a = abs(Y)
        sx = gs_x_aft(a)
        rec = 0.004 if a <= FL.GS_FACE_HALF + 1e-6 else 0.0
        ft = FL.GS_FACE_TOP + np.array((sx - rec * 0.96, -rec * 0.27))
        fb = FL.GS_FACE_BOT + np.array((sx - rec * 0.96, -rec * 0.27))
        xf = min(x_of_halfwidth(max(a, 0.02), Ztop, inset=0.095) + 0.004, ft[0] - 0.04)
        xm = 2.408 + sx
        lift = gs_lift(a)
        fb = fb + np.array((-lift * 0.28, lift))
        prof = [(xf, 3.40 + lift), (xf, Ztop), (ft[0] - 0.032, Ztop), (ft[0] - 0.012, Ztop - 0.003), (ft[0] - 0.002, Ztop - 0.011),
                (ft[0], ft[1]), (fb[0], fb[1]), (fb[0] - 0.003, fb[1] - 0.012), (fb[0] - 0.018, fb[1] - 0.024),
                (min(xm, fb[0] - 0.03), 3.418 + lift), (xf + 0.02, 3.40 + lift)]
        rings.append([np.array((x, Y, z)) for x, z in prof])
    # orient: the aft face must look aft, the top up -> faces away from the glareshield's internal axis
    axis_pt = lambda P: np.array((P[0] - 0.05, P[1], 3.49))
    R = [np.asarray(r) for r in rings]
    for i in range(len(R) - 1):
        for j in range(len(R[0]) - 1):
            pts = [R[i][j], R[i][j + 1], R[i + 1][j + 1], R[i + 1][j]]
            if np.linalg.norm(newell(pts)) < 1e-10:
                continue
            c = np.mean(pts, 0)
            inner = np.array((0.5 * (R[i][0][0] + R[i][6][0]), c[1], 3.49))
            uvs = [src_uv('black', 0.05 + 0.9 * j / 10, 0.05 + 0.9 * i / (len(R) - 1)), src_uv('black', 0.05 + 0.9 * (j + 1) / 10, 0.05 + 0.9 * i / (len(R) - 1)),
                   src_uv('black', 0.05 + 0.9 * (j + 1) / 10, 0.05 + 0.9 * (i + 1) / (len(R) - 1)), src_uv('black', 0.05 + 0.9 * j / 10, 0.05 + 0.9 * (i + 1) / (len(R) - 1))]
            face(md, pts, uvs, 0, away=inner, flat=False)
    for r in (R[0], R[-1]):
        face(md, r, [src_uv('black', 0.5, 0.5)] * len(r), 0, direction=(0, np.sign(r[0][1]), 0))


def mip_surround(md):
    """Cheek panels outboard of the MIP, footwell, forward pedestal body under P9."""
    ty = FL.MIP_Y
    # cheeks in the MIP plane from |Y| = 0.83 to the lining, floor .. glareshield
    for s in (-1, 1):
        zs = np.linspace(FL.FLOOR, 3.418, 10)
        outer, inner = [], []
        for z in zs:
            t = (z - FL.MIP_O[2]) / ty[2]
            X = FL.MIP_O[0] + ty[0] * t
            yl = half_width_at(X, z, 0.09)
            inner.append(np.array((X, s * 0.83, z)))
            outer.append(np.array((X, s * max(yl, 0.84), z)))
        loft(md, [inner, outer], 'lining', toward=np.array((3.2, 0.0, 3.2)))
    # footwell: MIP underside + back wall + side walls
    xb = 2.24
    for s in (-1, 1):
        y0, y1 = s * (FL.P9_HALF + 0.012), s * 0.83
        face(md, [(xb, y0, 2.97), (FL.MIP_O[0], y0, 2.97), (FL.MIP_O[0], y1, 2.97), (xb, y1, 2.97)],
             [src_uv('kick', 0.1, 0.1), src_uv('kick', 0.9, 0.1), src_uv('kick', 0.9, 0.9), src_uv('kick', 0.1, 0.9)], 0,
             direction=(0, 0, -1))
        yl = half_width_at(xb, 2.8, 0.09)
        face(md, [(xb, s * (FL.P9_HALF + 0.012), FL.FLOOR), (xb, s * yl, FL.FLOOR), (xb, s * yl, 2.97), (xb, s * (FL.P9_HALF + 0.012), 2.97)],
             [src_uv('kick', 0.1, 0.1), src_uv('kick', 0.9, 0.1), src_uv('kick', 0.9, 0.9), src_uv('kick', 0.1, 0.9)], 0,
             direction=(1, 0, 0))
        # outboard footwell side wall (between the back wall and the cheek)
        face(md, [(xb, s * 0.83, FL.FLOOR), (FL.MIP_O[0], s * 0.83, FL.FLOOR), (FL.MIP_O[0], s * 0.83, 2.97), (xb, s * 0.83, 2.97)],
             [src_uv('kick', 0.1, 0.1)] * 4, 0, direction=(0, -s, 0))
    # forward pedestal body under P9 (sides + aft face beside the throttle quadrant)
    o, yax = FL.p9_frame()
    top_aft = o + np.array((0, 0, 0))           # P9 aft edge (x = 0 side)
    Xa, Za = float(top_aft[0]), float(top_aft[2])
    topf = FL.MIP_O + FL.MIP_Y * FL.P9_TOP
    Xf, Zf = float(topf[0]), float(topf[2])
    hw = FL.P9_HALF + 0.012
    for s in (-1, 1):
        pts = [(Xf, s * hw, FL.FLOOR), (Xa, s * hw, FL.FLOOR), (Xa, s * hw, Za), (Xf, s * hw, Zf)]
        face(md, pts, [src_uv('grayp', 0.1, 0.1), src_uv('grayp', 0.9, 0.1), src_uv('grayp', 0.9, 0.9), src_uv('grayp', 0.1, 0.9)], 0,
             direction=(0, s, 0))
    # aft face (visible beside the TQ); the TQ body covers its centre
    face(md, [(Xa, -hw, FL.FLOOR), (Xa, hw, FL.FLOOR), (Xa, hw, Za), (Xa, -hw, Za)],
         [src_uv('lining', 0.1, 0.1), src_uv('lining', 0.9, 0.1), src_uv('lining', 0.9, 0.9), src_uv('lining', 0.1, 0.9)], 0,
         direction=(1, 0, 0))


def pedestal(md):
    # throttle quadrant body below the atlas side panels + end faces
    x0, x1, hw = FL.TQ_X0, FL.TQ_X1, FL.TQ_HALF
    for s in (-1, 1):
        face(md, [(x0, s * hw, FL.FLOOR), (x1, s * hw, FL.FLOOR), (x1, s * hw, 2.72), (x0, s * hw, 2.72)],
             [src_uv('lining', 0.1, 0.1), src_uv('lining', 0.9, 0.1), src_uv('lining', 0.9, 0.9), src_uv('lining', 0.1, 0.9)], 0,
             direction=(0, s, 0))
    # forward end is hidden against the forward pedestal; the aft end is covered by P8
    # P8 body: sides + aft face (top = atlas panel)
    X0, X1, h8 = FL.P8_X0, FL.P8_X1, FL.P8_HALF
    for s in (-1, 1):
        face(md, [(X0, s * h8, FL.FLOOR), (X1, s * h8, FL.FLOOR), (X1, s * h8, FL.P8_Z1), (X0, s * h8, FL.P8_Z0)],
             [src_uv('grayp', 0.1, 0.1), src_uv('grayp', 0.9, 0.1), src_uv('grayp', 0.9, 0.9), src_uv('grayp', 0.1, 0.9)], 0,
             direction=(0, s, 0))
    face(md, [(X1, -h8, FL.FLOOR), (X1, h8, FL.FLOOR), (X1, h8, FL.P8_Z1), (X1, -h8, FL.P8_Z1)],
         [src_uv('grayp', 0.1, 0.1), src_uv('grayp', 0.9, 0.1), src_uv('grayp', 0.9, 0.9), src_uv('grayp', 0.1, 0.9)], 0,
         direction=(1, 0, 0))
    # P8 forward face above the TQ cover ends (between TQ and P8 the cover meets the fire panel)
    zt = FL.tq_top_z(X0)
    for s in (-1, 1):
        face(md, [(X0, s * hw, zt - 0.01), (X0, s * h8, FL.FLOOR), (X0, s * h8, FL.P8_Z0), (X0, s * hw, FL.P8_Z0)],
             [src_uv('grayp', 0.5, 0.5)] * 4, 0, direction=(-1, 0, 0))
    face(md, [(X0, -hw, zt - 0.01), (X0, hw, zt - 0.01), (X0, hw, FL.P8_Z0), (X0, -hw, FL.P8_Z0)],
         [src_uv('grayp', 0.5, 0.5)] * 4, 0, direction=(-1, 0, 0))


def consoles(md):
    for s in (-1, 1):
        yi = s * FL.CONSOLE_Y_IN
        X0, X1, Zt = FL.CONSOLE_X0, FL.CONSOLE_X1, FL.CONSOLE_Z
        yo_panel = s * (FL.CONSOLE_Y_IN + 0.24)
        # inboard face
        face(md, [(X0, yi, FL.FLOOR), (X1, yi, FL.FLOOR), (X1, yi, Zt), (X0, yi, Zt)],
             [src_uv('lining', 0.1, 0.1), src_uv('lining', 0.9, 0.1), src_uv('lining', 0.9, 0.9), src_uv('lining', 0.1, 0.9)], 0,
             direction=(0, -s, 0))
        # front and aft faces up to the lining
        for X, dx in ((X0, -1), (X1, 1)):
            yl = half_width_at(X, 3.0, 0.09)
            face(md, [(X, yi, FL.FLOOR), (X, s * yl, FL.FLOOR), (X, s * yl, Zt), (X, yi, Zt)],
                 [src_uv('lining', 0.1, 0.1), src_uv('lining', 0.9, 0.1), src_uv('lining', 0.9, 0.9), src_uv('lining', 0.1, 0.9)], 0,
                 direction=(dx, 0, 0))
        # top outboard of the atlas panel, up to the lining
        xs = np.linspace(X0, X1, 6)
        for i in range(len(xs) - 1):
            ya = half_width_at(xs[i], Zt, 0.09)
            yb = half_width_at(xs[i + 1], Zt, 0.09)
            face(md, [(xs[i], yo_panel, Zt), (xs[i + 1], yo_panel, Zt), (xs[i + 1], s * yb, Zt), (xs[i], s * ya, Zt)],
                 [src_uv('lining', 0.2, 0.2)] * 4, 0, direction=(0, 0, 1))


def floor(md):
    xs = np.linspace(2.24, 4.72, 14)
    for i in range(len(xs) - 1):
        wa = half_width_at(xs[i], FL.FLOOR + 0.01, 0.09)
        wb = half_width_at(xs[i + 1], FL.FLOOR + 0.01, 0.09)
        u0, u1 = (xs[i] - 2.24) / 2.48, (xs[i + 1] - 2.24) / 2.48
        face(md, [(xs[i], -wa, FL.FLOOR), (xs[i + 1], -wb, FL.FLOOR), (xs[i + 1], wb, FL.FLOOR), (xs[i], wa, FL.FLOOR)],
             [src_uv('floor', 0.02, u0), src_uv('floor', 0.02, u1), src_uv('floor', 0.98, u1), src_uv('floor', 0.98, u0)], 0,
             direction=(0, 0, 1))


def overhead_housing(md):
    (fo, fd, fl), (ao, ad, al) = FL.ov_frames()
    W = FL.OV_W
    # skirts along both long edges, from the panel face up to the ceiling lining
    for s in (-1, 1):
        y = s * W / 2
        pts_lo, pts_hi = [], []
        for t in np.linspace(0, 1, 8):
            if t <= fl / (fl + al):
                P = fo + fd * (t * (fl + al))
            else:
                P = ao + ad * (t * (fl + al) - fl)
            X, Z = float(P[0]), float(P[2])
            zc = ceiling_z(X, abs(y)) + 0.03
            pts_lo.append(np.array((X, y, Z - 0.004)))
            pts_hi.append(np.array((X, y, max(zc, Z + 0.02))))
        loft(md, [pts_lo, pts_hi], 'lining', toward=np.array((3.4, 0.0, 3.6)) + np.array((0, s * 0.0, 0)))
    # forward end cap
    X, Z = float(fo[0]), float(fo[2])
    zc = ceiling_z(X, 0.0) + 0.04
    face(md, [(X, -W / 2, Z - 0.004), (X, W / 2, Z - 0.004), (X, W / 2, zc), (X, -W / 2, zc)],
         [src_uv('lining', 0.2, 0.2), src_uv('lining', 0.8, 0.2), src_uv('lining', 0.8, 0.8), src_uv('lining', 0.2, 0.8)], 0,
         direction=(-1, 0, 0))
    # aft end cap
    P = ao + ad * al
    X, Z = float(P[0]), float(P[2])
    zc = ceiling_z(X, 0.0) + 0.04
    face(md, [(X, -W / 2, Z - 0.004), (X, W / 2, Z - 0.004), (X, W / 2, zc), (X, -W / 2, zc)],
         [src_uv('lining', 0.2, 0.2)] * 4, 0, direction=(1, 0, 0))


def ceiling_z(X, Yabs, inset=0.09):
    Y, Z = inner_section(X, inset, 240)
    m = Z > float(S.fus_profiles(X)['zm'])
    Ys, Zs = np.abs(Y[m]), Z[m]
    i = np.argsort(Ys)
    return float(np.interp(Yabs, Ys[i], Zs[i]))


def bulkhead(md):
    """Aft flight-deck bulkhead with the door (faces forward)."""
    X = 4.72
    zs = np.linspace(FL.FLOOR, ceiling_z(X, 0.0), 16)
    right = [(half_width_at(X, z, 0.09), z) for z in zs]
    # outline split in two halves around the door opening
    dw, dz = 0.42, 2.66 + 1.90
    for s in (-1, 1):
        pts = [(X, s * dw, FL.FLOOR)] + [(X, s * y, z) for y, z in right] + [(X, 0.0, zs[-1]), (X, 0.0, dz), (X, s * dw, dz)]
        # fan triangulation from the door-side bottom corner (outline is convex enough)
        P = np.array(pts)
        c = P.mean(0)
        for i in range(len(P)):
            j = (i + 1) % len(P)
            tri = [c, P[i], P[j]]
            uvs = [src_uv('lining', 0.5, 0.5), src_uv('lining', 0.5 + 0.4 * P[i][1] / 1.8, (P[i][2] - 2.65) / 2.3),
                   src_uv('lining', 0.5 + 0.4 * P[j][1] / 1.8, (P[j][2] - 2.65) / 2.3)]
            if np.linalg.norm(newell(tri)) > 1e-9:
                face(md, tri, uvs, 0, direction=(-1, 0, 0))
    # door (slightly recessed)
    face(md, [(X + 0.012, -dw, FL.FLOOR), (X + 0.012, dw, FL.FLOOR), (X + 0.012, dw, dz), (X + 0.012, -dw, dz)],
         [src_uv('door', 0.0, 0.0), src_uv('door', 1.0, 0.0), src_uv('door', 1.0, 1.0), src_uv('door', 0.0, 1.0)], 0,
         direction=(-1, 0, 0))
    for s in (-1, 1):
        face(md, [(X, s * dw, FL.FLOOR), (X + 0.012, s * dw, FL.FLOOR), (X + 0.012, s * dw, dz), (X, s * dw, dz)],
             [src_uv('frame', 0.5, 0.5)] * 4, 0, direction=(0, -s, 0))
    face(md, [(X, -dw, dz), (X, dw, dz), (X + 0.012, dw, dz), (X + 0.012, -dw, dz)], [src_uv('frame', 0.5, 0.5)] * 4, 0,
         direction=(0, 0, -1))


def cb_backing(md, L):
    for name in ('cb_L', 'cb_R'):
        p = L[name]
        # box behind the panel to the wall
        c = p.P(p.w / 2, p.h / 2, -0.10)
        sbox(md, c, (p.x, p.y, p.n), (p.w + 0.02, p.h + 0.02, 0.19), 'grayp', faces=(0, 2, 3, 4, 5))


def seat(md, yc):
    """737NG pilot seat (Turkish Airlines: grey leather with woven inserts)."""
    X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])
    s = np.sign(yc)
    cx = FL.SEAT_X
    zt = FL.SEAT_Z
    lea = lambda sw: (lambda px, py: src_uv(sw, 0.5 + px * 1.6, 0.5 + py * 1.6))
    # rails + base
    for dy in (-0.15, 0.15):
        sbox(md, (cx + 0.05, yc + dy, FL.FLOOR + 0.02), (X, Y, Z), (0.95, 0.045, 0.04), 'metal')
    sbox(md, (cx + 0.06, yc, FL.FLOOR + 0.20), (X, Y, Z), (0.34, 0.30, 0.34), 'dark')
    sbox(md, (cx + 0.02, yc, zt - 0.115), (X, Y, Z), (0.46, 0.44, 0.05), 'dark')
    # seat pan cushion + woven insert
    cushion(md, (cx, yc, zt - 0.045), (Y, -X, Z), 0.49, 0.47, 0.085, 0.07, 0, lea('leather'), bulge=0.010)
    cushion(md, (cx - 0.02, yc, zt - 0.004), (Y, -X, Z), 0.30, 0.34, 0.012, 0.05, 0, lea('mesh'), bulge=0.004)
    # backrest (tilted 9 deg), leather shell + woven front insert + side bolsters
    t = math.radians(9)
    up = np.array([math.sin(t), 0, math.cos(t)])
    fwd = np.array([-math.cos(t), 0, math.sin(t)])
    bc = np.array([cx + 0.25, yc, zt + 0.02]) + up * 0.34
    cushion(md, bc, (-Y, up, fwd), 0.50, 0.68, 0.12, 0.10, 0, lea('leather'), bulge=0.012)
    cushion(md, bc + fwd * 0.066 - up * 0.04, (-Y, up, fwd), 0.30, 0.46, 0.016, 0.06, 0, lea('mesh'), bulge=0.006)
    for sy in (-1, 1):
        cushion(md, bc + fwd * 0.05 + (-Y) * (sy * 0.205) - up * 0.02, (-Y, up, fwd), 0.075, 0.56, 0.08, 0.035, 0, lea('leather'), bulge=0.01)
    # headrest
    hc = bc + up * 0.44 + fwd * 0.015
    cushion(md, hc, (-Y, up, fwd), 0.30, 0.19, 0.10, 0.07, 0, lea('leather'), bulge=0.012)
    sbox(md, bc + up * 0.36 - fwd * 0.02, (-Y, up, fwd), (0.08, 0.10, 0.04), 'dark')
    # armrests (both lowered), on the backrest sides
    for sy in (-1, 1):
        piv = bc + (-Y) * (sy * 0.285) - up * 0.10 - fwd * 0.01
        arm_c = piv + fwd * 0.17 - up * 0.02
        cushion(md, arm_c, (fwd, Y * sy, up), 0.32, 0.072, 0.055, 0.03, 0, lea('dark'), bulge=0.006)
        sbox(md, piv, (-Y, up, fwd), (0.05, 0.07, 0.05), 'dark')


def rudder_pedals(md, yc):
    for dy in (-0.105, 0.105):
        c = np.array([2.33, yc + dy, 2.84])
        t = math.radians(28)
        up = np.array([-math.sin(t), 0, math.cos(t)])
        fwd = np.array([math.cos(t), 0, math.sin(t)])
        sbox(md, c, (np.array([0, 1.0, 0]), up, fwd), (0.085, 0.21, 0.018), 'dark')
        a = c - fwd * 0.01 + up * 0.10
        sbox(md, (a + np.array((2.26, yc + dy, 3.02))) / 2, frame3(np.array((2.26, yc + dy, 3.02)) - a, (0, 1, 0)),
             (0.022, 0.022, float(np.linalg.norm(np.array((2.26, yc + dy, 3.02)) - a))), 'metal')


def visors(md, glass):
    """Sun visors stowed along the ceiling edge above the side windows: tinted translucent panels (own material)
    in a dark rail/frame (structure)."""
    for s in (-1, 1):
        c = np.array((3.24, s * 0.98, 4.30))
        n = np.array((0, -s * 0.42, -0.91))
        ax = frame3(n, (1, 0, 0))
        oriented_box(glass, c, ax, (0.36, 0.20, 0.004), 0, uvfun=lambda *a: (0.5, 0.5))
        for dy in (-0.10, 0.10):
            sbox(md, c + ax[1] * dy, ax, (0.37, 0.010, 0.010), 'dark')
        for dx in (-0.18, 0.18):
            sbox(md, c + ax[0] * dx, ax, (0.010, 0.21, 0.010), 'dark')
        sbox(md, c + ax[1] * 0.12 + ax[2] * 0.012, ax, (0.46, 0.016, 0.016), 'dark')    # rail


def compass(md, parts):
    """Standby magnetic compass hanging from the front of the overhead, above the centre post."""
    c = np.array((2.785, 0.0, 3.935))
    ax = (np.array((1.0, 0, 0)), np.array((0, 1.0, 0)), np.array((0, 0, 1.0)))
    sbox(md, c, ax, (0.050, 0.058, 0.044), 'dark')
    sbox(md, c + np.array((0.0, 0, 0.034)), ax, (0.018, 0.018, 0.028), 'dark')
    # card window facing aft (white card behind glass)
    quad(parts, [c + np.array((0.0251, -0.018, -0.010)), c + np.array((0.0251, 0.018, -0.010)), c + np.array((0.0251, 0.018, 0.010)),
                 c + np.array((0.0251, -0.018, 0.010))][::-1], [(0.5, 0.5)] * 4, P_WHITE)


def window_handles(md):
    """Sliding side window (W2) crank handles on the aft frame."""
    for s in (-1, 1):
        X = 3.525
        yl = half_width_at(X, 3.78, 0.10)
        base = np.array((X, s * yl, 3.78))
        n = np.array((0, -s, 0))
        ax = (np.array((1.0, 0, 0)), np.array((0, 0, 1.0)), n)
        sbox(md, base + n * 0.012, ax, (0.030, 0.16, 0.024), 'dark')
        sbox(md, base + n * 0.045 + np.array((0, 0, 0.0)), ax, (0.022, 0.13, 0.018), 'metal')
        for dz in (-0.055, 0.055):
            sbox(md, base + n * 0.030 + np.array((0, 0, dz)), ax, (0.016, 0.016, 0.030), 'metal')


def ceiling_details(md, parts):
    """Speaker grilles and escape-rope hatches in the ceiling above the side windows, dome light behind the overhead,
    oxygen mask stowage boxes on the side consoles, gasper vents."""
    for s in (-1, 1):
        # speaker grille (round) and escape rope hatch, on the ceiling lining outboard of the overhead
        for X, kind in ((3.45, 'speaker'), (3.95, 'hatch'), (4.30, 'speaker')):
            yl = 0.72 if kind == 'speaker' else 0.66
            z = ceiling_z(X, yl, 0.09)
            # local frame on the lining: normal from the section gradient
            z2 = ceiling_z(X, yl + 0.02, 0.09)
            nrm = np.array((0.0, -s * (z2 - z) / 0.02, -1.0))
            nrm = -nrm / np.linalg.norm(nrm)
            nrm = np.array((0.0, -s * abs(nrm[1]), -abs(nrm[2])))
            c = np.array((X, s * yl, z)) + nrm * 0.004
            ax = frame3(nrm, (1, 0, 0))
            if kind == 'speaker':
                # round grille in a moulded ring
                ring = [(0.0, 0.0), (0.075, 0.0), (0.076, 0.006), (0.066, 0.010), (0.058, 0.006), (0.0, 0.006)]
                P = [c + ax[2] * h + (ax[0] * math.cos(a) + ax[1] * math.sin(a)) * r for r, h in ring for a in np.linspace(0, 2 * math.pi, 29)[:-1]]
                n_ = 28
                for k in range(len(ring) - 1):
                    for j in range(n_):
                        j1 = (j + 1) % n_
                        q = [P[k * n_ + j], P[k * n_ + j1], P[(k + 1) * n_ + j1], P[(k + 1) * n_ + j]]
                        if np.linalg.norm(newell(q)) < 1e-12:
                            continue
                        sw = 'dark' if k >= 3 else 'frame'
                        face(md, q, [src_uv(sw, 0.5, 0.5)] * 4, 0, direction=nrm, flat=False)
            else:
                sbox(md, c, ax, (0.30, 0.16, 0.012), 'frame')
                sbox(md, c + nrm * 0.008 + ax[1] * 0.05, ax, (0.10, 0.018, 0.010), 'dark')
        # oxygen mask stowage box (aft part of the side console)
        cx = FL.CONSOLE_X0 + 0.25
        yi = s * (FL.CONSOLE_Y_IN + 0.12)
        sbox(md, (cx + 0.10, yi, FL.CONSOLE_Z + 0.055), (np.array((1.0, 0, 0)), np.array((0, 1.0, 0)), np.array((0, 0, 1.0))),
             (0.20, 0.17, 0.11), 'grayp')
        sbox(md, (cx + 0.10, yi, FL.CONSOLE_Z + 0.112), (np.array((1.0, 0, 0)), np.array((0, 1.0, 0)), np.array((0, 0, 1.0))),
             (0.19, 0.16, 0.006), 'dark')
        # gasper vents on the side wall below the W3 window
        for X in (3.75, 3.95):
            yl = half_width_at(X, 3.42, 0.10)
            base = np.array((X, s * yl, 3.42))
            mk.lathe([(0.030, 0.0), (0.030, 0.010), (0.018, 0.018), (0.012, 0.030), (0.0, 0.032)], n=14, origin=base,
                     axis=(0, -s, 0), ref=(1, 0, 0), mat=P_GRAY, md=parts)
    # dome light behind the overhead
    X = 4.30
    z = ceiling_z(X, 0.0, 0.09)
    sbox(md, (X, 0.0, z - 0.008), (np.array((1.0, 0, 0)), np.array((0, 1.0, 0)), np.array((0, 0, 1.0))), (0.30, 0.42, 0.016), 'frame')
    sbox(md, (X, 0.0, z - 0.017), (np.array((1.0, 0, 0)), np.array((0, 1.0, 0)), np.array((0, 0, 1.0))), (0.24, 0.36, 0.004), 'white')


def trim_wheels(parts):
    """Striped stabilizer trim wheels either side of the throttle quadrant (+ folding crank handles)."""
    for s in (-1, 1):
        cen = np.array((2.965, s * 0.150, 2.815))
        ax = (0, s, 0)
        prof = [(0.0, -0.016), (0.05, -0.016), (0.11, -0.014), (0.135, -0.012), (0.142, -0.006), (0.143, 0.0), (0.142, 0.006),
                (0.135, 0.012), (0.11, 0.014), (0.05, 0.016), (0.0, 0.016)]
        mk.lathe(prof, n=48, origin=cen, axis=ax, ref=(1, 0, 0), mat=P_BLACK, md=parts)
        # white stripes on the rim (diagonal bars)
        for k in range(18):
            a = 2 * math.pi * k / 18
            d = np.array((math.cos(a), 0, math.sin(a)))
            tng = np.array((-math.sin(a), 0, math.cos(a)))
            p0 = cen + d * 0.1438
            yv = np.array((0, 1.0, 0))
            pts = [p0 - tng * 0.010 - yv * 0.012, p0 - tng * 0.002 - yv * 0.012, p0 + tng * 0.010 + yv * 0.012, p0 + tng * 0.002 + yv * 0.012]
            pts = [q + d * 0.0006 for q in pts]
            face(parts, pts, [(0.5, 0.5)] * 4, P_WHITE, direction=d)
        # crank handle on the outer face
        hp = cen + np.array((0.08, 0, 0.07)) + np.array((0, s * 0.017, 0))
        mk.tube(hp, hp + np.array((0, s * 0.045, 0)), 0.009, 0.008, n=10, mat=P_TOGGLE, md=parts)


def start_levers_etc(parts, L):
    """Start (fuel cutoff) levers, parking brake handle, stab trim cutout switches on the TQ cover."""
    tq = L['tq_top']
    Ltq = tq.h
    c = tq.w / 2
    for sx in (-0.034, 0.034):
        b = FL.tq_point(c + sx, Ltq * 0.07, 0.0)
        nrm = (b - np.array((FL.TQ_PIVOT[0], b[1], FL.TQ_PIVOT[1])))
        nrm /= np.linalg.norm(nrm)
        tip = b + nrm * 0.055 + np.array((0.012, 0, 0))
        mk.tube(b, tip, 0.004, n=8, mat=P_CHROME, md=parts)
        sbox_p(parts, tip + nrm * 0.012, frame3(nrm, (0, 1, 0)), (0.020, 0.018, 0.028), P_BLACK)
        sbox_p(parts, tip + nrm * 0.012 + np.array((0.0101, 0, 0)), frame3(nrm, (0, 1, 0)), (0.0004, 0.012, 0.018), P_WHITE)
    # parking brake handle (left aft)
    b = FL.tq_point(c - 0.090, Ltq * 0.12, 0.0)
    nrm = np.array((0, 0, 1.0))
    mk.tube(b, b + np.array((0, 0, 0.03)), 0.005, n=8, mat=P_CHROME, md=parts)
    sbox_p(parts, b + np.array((0, 0, 0.035)), frame3((0, 0, 1), (0, 1, 0)), (0.030, 0.050, 0.012), P_TOGGLE)


def sbox_p(md, c, axes, size, mat):
    oriented_box(md, c, axes, size, mat, uvfun=lambda *a: (0.5, 0.5))


def window_trims(md, shell_obj):
    """Light-grey window mouldings covering the dark reveal between the lining and the skin."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    import exterior as EXT
    fus_md = EXT.build_fuselage_md()
    tmp = mk.obj('_fus_tmp', fus_md, [bpy.data.materials[0]])
    dg = bpy.context.evaluated_depsgraph_get()
    bvh_out = BVHTree.FromObject(tmp, dg)
    bvh_in = BVHTree.FromObject(shell_obj, dg)
    for w in EXT.cockpit_windows():
        poly = w.poly
        n = len(poly)
        cen = poly.mean(0)
        pts = []
        for k in range(n):
            a, b = poly[k], poly[(k + 1) % n]
            m = max(1, int(np.linalg.norm(b - a) / 0.03))
            for t in range(m):
                pts.append(a + (b - a) * t / m)
        rings = [[], [], []]
        ok = True

        def cast(q2):
            if w.kind == 'side':
                o = w.to3(q2, 3.0); d = np.array([-w.side, 0, 0])
            else:
                o = w.to3(q2, -2.0); d = np.array([0, -1.0, 0])
            ho = bvh_out.ray_cast(Vector(o), Vector(d))
            if ho[0] is None:
                return None, None
            n = np.array(ho[1])
            if np.dot(n, d) > 0:
                n = -n
            return np.array(ho[0]), n

        for q in pts:
            dq = q - cen
            dq = dq / (np.linalg.norm(dq) + 1e-9)
            po, n0 = cast(q + dq * 0.004)
            po2, n2 = cast(q + dq * 0.032)
            if po is None or po2 is None:
                print('trim miss', w.name, q)
                ok = False
                break
            pi = po - n0 * 0.085                    # the lining is the skin offset 85 mm along the normal
            pl = po2 - n2 * 0.089
            lat = lambda d2: w.to3(q + dq * d2, 0.0) - w.to3(q, 0.0)
            depth = pi - po
            # the moulding runs parallel to the reveal, ~1 cm inside the opening (covers it from the cabin side),
            # then turns out over the lining
            g = po + depth * 0.20 + lat(-0.012)
            m = pi + depth * 0.08 + lat(-0.008)
            l = pl
            rings[0].append(g); rings[1].append(m); rings[2].append(l)
        if not ok:
            print('window trim: ray miss for', w.name)
            continue
        # rings are in blender coordinates: convert to the ground frame (the builder converts back at the end)
        G = [np.stack(S.from_b(np.array(r)), -1) for r in rings]
        inside_pt = np.array((3.4, 0.0, 3.6))
        nr = len(G[0])
        for a_ in range(2):
            for j in range(nr):
                j1 = (j + 1) % nr
                pts = [G[a_][j], G[a_][j1], G[a_ + 1][j1], G[a_ + 1][j]]
                if np.linalg.norm(newell(pts)) < 1e-10:
                    continue
                zc = float(np.mean([q[2] for q in pts]))
                sw = 'black' if (w.kind == 'front' and zc < 3.70) else 'frame'
                face(md, pts, [src_uv(sw, 0.2, 0.2), src_uv(sw, 0.8, 0.2), src_uv(sw, 0.8, 0.8), src_uv(sw, 0.2, 0.8)], 0,
                     toward=inside_pt, flat=False)
    bpy.data.objects.remove(tmp)


# =========================================================================================== MOVABLES
def catmull(pts, n=6):
    """Catmull-Rom spline through the points (n samples per segment)."""
    P = [np.asarray(p, float) for p in pts]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for k in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[k - 1], P[k], P[k + 1], P[k + 2]
        for j in range(n):
            t = j / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return out


def tube_path(md, path, radii, mat, n=12, flat=1.0, side=(0, 1, 0)):
    """Swept tube with per-point radius; flat < 1 squashes the section along `side` x tangent."""
    path = [np.asarray(p, float) for p in path]
    rings = []
    for k, p in enumerate(path):
        t = path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]
        t /= np.linalg.norm(t)
        u = np.cross(t, np.asarray(side, float))
        if np.linalg.norm(u) < 1e-6:
            u = np.cross(t, (1, 0, 0))
        u /= np.linalg.norm(u)
        v = np.cross(t, u)
        r = radii[k]
        rings.append([p + u * r * math.cos(a) + v * r * flat * math.sin(a) for a in np.linspace(0, 2 * math.pi, n + 1)[:-1]])
    for k in range(len(rings) - 1):
        for j in range(n):
            j1 = (j + 1) % n
            md.add(np.array([rings[k][j], rings[k][j1], rings[k + 1][j1], rings[k + 1][j]]), [[0, 1, 2, 3]], [(0.5, 0.5)] * 4, mat=mat)
    for k, sgn in ((0, -1), (len(rings) - 1, 1)):
        c = path[k]
        for j in range(n):
            j1 = (j + 1) % n
            tri = [rings[k][j], rings[k][j1], c] if sgn > 0 else [rings[k][j1], rings[k][j], c]
            md.add(np.array(tri), [[0, 1, 2]], [(0.5, 0.5)] * 3, mat=mat)


def yoke_parts(side, card):
    """737NG control column + control wheel: ram's-horn grips on a swept crossbar, Boeing hub, checklist holder."""
    yc = side * 0.53
    base = np.array([2.60, yc, FL.FLOOR + 0.01])
    top = np.array([2.680, yc, 3.150])
    col = MeshData()
    mk.lathe([(0.10, 0.0), (0.09, 0.03), (0.06, 0.08), (0.048, 0.12), (0.0, 0.12)], n=20, origin=base, axis=(0, 0, 1), ref=(1, 0, 0),
             mat=P_BLACK, md=col)
    mk.tube(base, top, 0.032, 0.028, n=18, mat=P_GRAY, md=col)
    hub = np.array([2.738, yc, 3.226])
    tube_path(col, catmull([top, top + np.array([0.010, 0, 0.045]), hub - np.array([0.045, 0, 0])], 5), [0.028] * 11, P_GRAY, n=16)
    wheel = MeshData()
    X = np.array([1.0, 0, 0])
    # hub: dark cylinder with a polished boss
    mk.lathe([(0.0, -0.05), (0.036, -0.05), (0.040, -0.044), (0.040, 0.012), (0.034, 0.020), (0.0, 0.020)], n=24,
             origin=hub, axis=(1, 0, 0), ref=(0, 0, 1), mat=P_BLACK, md=wheel)
    mk.lathe([(0.0, 0.0), (0.024, 0.0), (0.024, 0.004), (0.0, 0.006)], n=24, origin=hub + X * 0.020, axis=(1, 0, 0),
             ref=(0, 0, 1), mat=P_CHROME, md=wheel)
    # crossbar (slightly swept down to the grips) + grips rising to the horn tips
    for sy in (-1, 1):
        pts = [hub + np.array([0.014, sy * 0.020, -0.006]), hub + np.array([0.016, sy * 0.075, -0.020]),
               hub + np.array([0.015, sy * 0.132, -0.034]), hub + np.array([0.013, sy * 0.168, -0.012]),
               hub + np.array([0.012, sy * 0.178, 0.035]), hub + np.array([0.012, sy * 0.170, 0.085]),
               hub + np.array([0.010, sy * 0.156, 0.122])]
        path = catmull(pts, 5)
        m = len(path)
        radii = [0.015 + 0.004 * max(0.0, min(1.0, (k - m * 0.45) / (m * 0.2))) - 0.004 * max(0.0, (k - m * 0.85) / (m * 0.15)) for k in range(m)]
        tube_path(wheel, path, radii, P_BLACK, n=12, flat=0.82, side=(1, 0, 0))
        tip = path[-1]
        # stab trim thumb switch on the top of the outboard grip / AP disconnect on the inboard face
        oriented_box(wheel, tip + np.array([0.006, 0, 0.012]), (np.array([0, 1.0, 0]), X, np.array([0, 0, 1.0])), (0.014, 0.012, 0.010), P_GRAY,
                     uvfun=lambda *a: (0.5, 0.5))
        mk.lathe([(0.0, 0.0), (0.006, 0.0), (0.006, 0.004), (0.0, 0.005)], n=10, origin=path[m * 3 // 4] + np.array([0.0, -sy * 0.017, 0.0]),
                 axis=(0, -sy, 0), ref=(1, 0, 0), mat=P_RED if sy < 0 else P_BLACK, md=wheel)
    # checklist holder on the aft face: black frame + printed card (panel atlas)
    ax = (np.array([0, 1.0, 0]), np.array([0, 0, 1.0]), np.array([1.0, 0, 0]))
    cc = hub + np.array([0.030, 0, 0.060])
    oriented_box(wheel, cc, ax, (0.105, 0.138, 0.010), P_BLACK, uvfun=lambda *a: (0.5, 0.5))
    oriented_box(wheel, cc + np.array([0.0, 0, 0.074]), ax, (0.050, 0.014, 0.012), P_GRAY, uvfun=lambda *a: (0.5, 0.5))
    fc = cc + np.array([0.0052, 0, 0])
    w2, h2 = card.w / 2, card.h / 2
    pts = [fc + np.array([0, -w2, -h2]), fc + np.array([0, w2, -h2]), fc + np.array([0, w2, h2]), fc + np.array([0, -w2, h2])]
    wheel.add(np.array(pts), [[0, 1, 2, 3]], [card.uv(0, 0), card.uv(card.w, 0), card.uv(card.w, card.h), card.uv(0, card.h)],
              mat=P_PANEL, flat=True)
    return col, base, wheel, hub


def thrust_lever(y):
    """Thrust lever: flat light-grey arm, big white paddle knob (engine number side), TO/GA switch below the knob,
    A/T disengage button on the outboard end, black piggy-back reverse thrust lever in front."""
    piv = np.array([FL.TQ_PIVOT[0], y, FL.TQ_PIVOT[1]])
    md = MeshData()
    ang = math.radians(13.7)        # idle: leaning aft (IDLE mark on the cover); the rig rotates it 37 deg forward at full
    d = np.array([math.sin(ang), 0, math.cos(ang)])
    fwd_l = np.array([-d[2], 0, d[0]])          # perpendicular to the lever (forward/down)
    L = FL.TQ_R + 0.215
    tip = piv + d * L
    s = np.sign(y) if y != 0 else 1.0
    arm_c = piv + d * (FL.TQ_R + 0.08)
    oriented_box(md, arm_c, frame3(d, (0, 1, 0)), (0.024, 0.011, 0.24), P_LIGHT, uvfun=lambda *a: (0.5, 0.5))
    kc = tip + d * 0.020
    cushion(md, kc + np.array([0, s * 0.004, 0]), (np.array([0, 1.0, 0]), d, -fwd_l), 0.064, 0.058, 0.030, 0.012, P_TOGGLE,
            lambda px, py: (0.5, 0.5), bulge=0.004, n=3, taper=0.9)
    mk.lathe([(0.0, 0.0), (0.0075, 0.0), (0.0075, 0.004), (0.0, 0.0045)], n=10, origin=kc + np.array([0, s * 0.034, 0]),
             axis=(0, s, 0), ref=(1, 0, 0), mat=P_BLACK, md=md)
    oriented_box(md, tip - d * 0.030 - fwd_l * 0.012, frame3(-fwd_l, (0, 1, 0)), (0.020, 0.014, 0.008), P_BLACK,
                 uvfun=lambda *a: (0.5, 0.5))
    # reverse thrust lever (in front of the thrust lever arm)
    rv0 = piv + d * (FL.TQ_R + 0.05) - fwd_l * 0.018
    rv1 = rv0 + d * 0.10 - fwd_l * 0.012
    mk.tube(rv0, rv1, 0.005, n=8, mat=P_BLACK, md=md)
    oriented_box(md, rv1 + d * 0.006 - fwd_l * 0.010, frame3(d, (0, 1, 0)), (0.030, 0.022, 0.014), P_BLACK,
                 uvfun=lambda *a: (0.5, 0.5))
    return md, piv


def side_lever(y, length, handle, neutral_deg):
    piv = np.array([FL.TQ_PIVOT[0], y, FL.TQ_PIVOT[1]])
    md = MeshData()
    a = math.radians(neutral_deg)
    d = np.array([-math.sin(a), 0, math.cos(a)])
    L = FL.TQ_R + length
    tip = piv + d * L
    mk.tube(piv + d * (FL.TQ_R - 0.03), tip, 0.006, 0.005, n=10, mat=P_CHROME, md=md)
    if handle == 'flap':
        # flap handle: white block (flap-section shape)
        oriented_box(md, tip + d * 0.018, frame3(d, (0, 1, 0)), (0.050, 0.030, 0.036), P_TOGGLE, uvfun=lambda *a: (0.5, 0.5))
    else:
        # speed brake: grey T handle
        oriented_box(md, tip + d * 0.012, frame3(d, (0, 1, 0)), (0.036, 0.090, 0.022), P_LIGHT, uvfun=lambda *a: (0.5, 0.5))
    return md, piv


# =========================================================================================== BUILD
def tq_cover(b, p):
    """Curved throttle-quadrant cover (arc about the thrust lever pivot), UV-mapped on the tq_top atlas panel."""
    nx, ny = 6, 24
    xs = np.linspace(0, p.w, nx)
    ys = np.linspace(0, p.h, ny)
    md = b.pan
    for i in range(ny - 1):
        for j in range(nx - 1):
            q = [(xs[j], ys[i]), (xs[j + 1], ys[i]), (xs[j + 1], ys[i + 1]), (xs[j], ys[i + 1])]
            pts = [FL.tq_point(x, y, 0.0) for x, y in q]
            face(md, pts, [p.uv(x, y) for x, y in q], 0, direction=(0, 0, 1), flat=False)


def tq_side_shape(p):
    """Side plate outline following the curved cover."""
    right = p.name.endswith('R')
    pts = [(0.0, 0.0), (p.w, 0.0)]
    for k in range(13):
        t = 1 - k / 12
        x = p.w * t
        X = FL.TQ_X0 + x if not right else FL.TQ_X1 - x
        pts.append((x, FL.tq_top_z(X) - 0.004 - 2.72))
    return pts


def build_interior(imats, shell_obj=None):
    created = []
    inter = bpy.data.objects.get('interior') or mk.empty('interior', (0, 0, 0))
    L = FL.layout()
    b = Builder(imats)
    for name, p in L.items():
        if p.nogeo:
            continue
        if name == 'tq_top':
            tq_cover(b, p)
            continue
        b.slab(p)
        b.controls(p)
    # ---- structure
    body = b.body
    glareshield(body)
    mip_surround(body)
    pedestal(body)
    consoles(body)
    floor(body)
    overhead_housing(body)
    bulkhead(body)
    cb_backing(body, L)
    for s in (-1, 1):
        seat(body, s * 0.53)
        rudder_pedals(body, s * 0.53)
    b.visor = MeshData()
    visors(body, b.visor)
    window_handles(body)
    ceiling_details(body, b.parts)
    compass(body, b.parts)
    trim_wheels(b.parts)
    start_levers_etc(b.parts, L)
    if shell_obj is not None:
        window_trims(body, shell_obj)
    # ---- objects (ground -> blender)
    for md in (b.pan, b.parts, body, b.visor):
        md.v = TB(md.v[:, 0], md.v[:, 1], md.v[:, 2])
    o_pan = mk.obj('flightdeck_panels', b.pan, [imats['panel']], smooth=True, sharp_angle=30)
    o_parts = mk.obj('flightdeck_parts', b.parts, parts_mats(imats), smooth=True, sharp_angle=40)
    o_body = mk.obj('flightdeck_body', body, [imats['src']], smooth=True, sharp_angle=40)
    vis_mat = MAT.principled('fd_visor', (0.035, 0.05, 0.045), 0.08, 0.0, alpha=0.55, double=True)
    o_vis = mk.obj('flightdeck_visors', b.visor, [vis_mat], smooth=False)
    created += [o_pan, o_parts, o_body, o_vis]
    for o in (o_pan, o_parts, o_body, o_vis):
        o['interior'] = 1
    # ---- screens
    for name, pts in b.screens:
        md = MeshData()
        P = np.array(pts)
        md.add(TB(*P.T), [[0, 1, 2, 3]], [(0, 1), (1, 1), (1, 0), (0, 0)], mat=0, flat=True)
        mat = MAT.principled(name, (0.0, 0.0, 0.0), 0.12, 0.0, emission=(0, 0, 0), emission_strength=1.0)
        o = mk.obj(name, md, [mat], smooth=False)
        o['interior'] = 1
        created.append(o)
    # ---- movables: yokes, levers
    pm = parts_mats(imats) + [imats['panel']]
    for side, sfx in ((-1, 'L'), (1, 'R')):
        col, base, wheel, hub = yoke_parts(side, L['yoke_card'])
        for m in (col, wheel):
            m.v = TB(m.v[:, 0], m.v[:, 1], m.v[:, 2])
        Mc = mk.hinge_matrix(TB(*base), (1, 0, 0), (0, 0, 1))
        co = mk.obj(f'yoke_col_{sfx}', col, pm, matrix=Mc, sharp_angle=40)
        Mw = mk.hinge_matrix(TB(*hub), (1, 0, 0), (0, 0, 1))
        wo = mk.obj(f'yoke_{sfx}', wheel, pm, matrix=Mw, parent=co, sharp_angle=40)
        created += [co, wo]
    for i, y in ((1, -0.034), (2, 0.034)):
        m, piv = thrust_lever(y)
        m.v = TB(m.v[:, 0], m.v[:, 1], m.v[:, 2])
        created.append(mk.obj(f'lever_thrust_{i}', m, pm, matrix=mk.hinge_matrix(TB(*piv), (1, 0, 0), (0, 0, 1)), sharp_angle=40))
    for name, y, length, h, nd in (('lever_speedbrake', -0.102, 0.11, 'sb', 21), ('lever_flap', 0.102, 0.12, 'flap', 22)):
        m, piv = side_lever(y, length, h, nd)
        m.v = TB(m.v[:, 0], m.v[:, 1], m.v[:, 2])
        created.append(mk.obj(name, m, pm, matrix=mk.hinge_matrix(TB(*piv), (1, 0, 0), (0, 0, 1)), sharp_angle=40))
    # eye points (root level: exterior GLB)
    if 'eye_pilot' not in bpy.data.objects:
        mk.empty('eye_pilot', TB(*FL.EYE_CAPT))
        mk.empty('eye_copilot', TB(*FL.EYE_FO))
    for o in created:
        if o.parent is None:
            mk.set_parent(o, inter)
    build_interior.lite_boxes = b.lite_boxes
    return created


def finish_shell(shell, imats, body):
    """Flight-deck lining (inner copy of the cut skin, built by exterior.build_fuselage): drop the faces nobody can see
    (below the floor, inside the nose below the glareshield, aft of the bulkhead), give it the lining swatch and join it
    into flightdeck_body so it shares the baked structure atlas."""
    import bmesh
    me = shell.data
    bm = bmesh.new()
    bm.from_mesh(me)
    kill = []
    for f in bm.faces:
        X, Y, Z = S.from_b(np.array(f.calc_center_median()))
        if Z < FL.FLOOR - 0.03 or X > 4.735 or (X < 2.20 and Z < 3.52):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    uvl = bm.loops.layers.uv.active or bm.loops.layers.uv.new('UVMap')
    uv = src_uv('lining', 0.5, 0.5)
    for f in bm.faces:
        for l in f.loops:
            l[uvl].uv = uv
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(imats['src'])
    lite_src = bpy.data.objects.new('_lite_src_shell', me.copy())
    bpy.context.scene.collection.objects.link(lite_src)
    lite_src.matrix_world = shell.matrix_world.copy()
    if shell.parent is not None:
        mw = shell.matrix_world.copy()
        shell.parent = None
        shell.matrix_world = mw
    with bpy.context.temp_override(active_object=body, object=body, selected_objects=[body, shell], selected_editable_objects=[body, shell]):
        bpy.ops.object.join()
    return lite_src
