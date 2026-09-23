"""737NG flight deck geometry (node `interior`): panels with UV-mapped atlas faces, knobs/switches/keys,
six display units + two CDU screens, yokes, throttle quadrant with levers, seats, floor, bulkheads."""
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

# material slots of the merged static interior object
M_PANEL, M_DARK, M_METAL, M_RED, M_WHITE, M_TRIM, M_GLASS = range(7)


def create_materials(textured=True):
    M = {}
    T = textured
    M['trim'] = MAT.principled('fd_trim', (0.24, 0.25, 0.26), 0.72, 0.0)
    M['panel'] = MAT.principled('fd_panel', (0.1, 0.105, 0.11), 0.55, 0.0, base='fd_base' if T else None,
                                orm='fd_orm' if T else None, emission_tex='fd_emit' if T else None, emission_strength=1.0)
    M['dark'] = MAT.principled('fd_knob', (0.018, 0.018, 0.02), 0.42, 0.0)
    M['metal'] = MAT.principled('fd_metal', (0.75, 0.76, 0.78), 0.25, 1.0)
    M['red'] = MAT.principled('fd_guard_red', (0.45, 0.02, 0.02), 0.4, 0.0)
    M['white'] = MAT.principled('fd_white', (0.8, 0.8, 0.8), 0.35, 0.0)
    M['glass'] = MAT.principled('fd_glass', (0.02, 0.02, 0.02), 0.05, 0.0, alpha=0.25)
    return M


def swatch_uv(name, u, v):
    x0, y0, x1, y1 = SW[name]
    return ((x0 + u * (x1 - x0)) / A, 1 - (y0 + (1 - v) * (y1 - y0)) / A)


SW = FL.SWATCH


def quad(md, pts, uvs, mat, flat=True):
    md.add(np.array(pts), [[0, 1, 2, 3]], list(uvs), mat=mat, flat=flat)


def oriented_box(md, c, axes, size, mat, front_uv=None, front_axis=2, other='plastic', other_mat=None):
    """Box centred at c with axes (3 unit vectors: x, y, z). front_uv: callable (s, t)->uv for the +z face."""
    ax = [np.asarray(a, float) for a in axes]
    hx, hy, hz = [s / 2 for s in size]
    c = np.asarray(c, float)
    corners = {}
    for i, sx in enumerate((-1, 1)):
        for j, sy in enumerate((-1, 1)):
            for k, sz in enumerate((-1, 1)):
                corners[(sx, sy, sz)] = c + ax[0] * hx * sx + ax[1] * hy * sy + ax[2] * hz * sz
    om = mat if other_mat is None else other_mat
    # +z (front)
    f = [corners[(-1, -1, 1)], corners[(1, -1, 1)], corners[(1, 1, 1)], corners[(-1, 1, 1)]]
    if front_uv:
        uvs = [front_uv(0, 0), front_uv(1, 0), front_uv(1, 1), front_uv(0, 1)]
    else:
        uvs = [swatch_uv(other, 0.2, 0.2), swatch_uv(other, 0.8, 0.2), swatch_uv(other, 0.8, 0.8), swatch_uv(other, 0.2, 0.8)]
    quad(md, f, uvs, mat)
    su = [swatch_uv(other, 0.2, 0.2), swatch_uv(other, 0.8, 0.2), swatch_uv(other, 0.8, 0.8), swatch_uv(other, 0.2, 0.8)]
    sides = [
        [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],
        [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
        [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],
        [(1, 1, -1), (-1, 1, -1), (-1, 1, 1), (1, 1, 1)],
        [(-1, 1, -1), (-1, -1, -1), (-1, -1, 1), (-1, 1, 1)],
    ]
    for s in sides:
        quad(md, [corners[k] for k in s], su, om)


def frame3(z, xhint):
    """Right-handed axes (x, y, z) with z given and x as close as possible to xhint."""
    z = np.asarray(z, float); z = z / np.linalg.norm(z)
    x = np.asarray(xhint, float); x = x - z * np.dot(x, z); x = x / np.linalg.norm(x)
    y = np.cross(z, x)
    return (x, y, z)


def panel_box(md, p, cx, cy, w, h, d, mat=M_PANEL, off=0.0, side_mat=M_DARK):
    """Raised box on panel p with its front face mapped to the atlas footprint (cx±w/2, cy±h/2)."""
    c = p.P(cx, cy, off + d / 2)
    fu = lambda s, t: p.uv(cx - w / 2 + s * w, cy - h / 2 + t * h)
    oriented_box(md, c, (p.x, p.y, p.n), (w, h, d), mat, front_uv=fu, other_mat=side_mat)


def panel_slab(md, p, mat=M_PANEL):
    poly = p.shape or [(0, 0), (p.w, 0), (p.w, p.h), (0, p.h)]
    n = len(poly)
    front = [p.P(x, y, 0.0) for x, y in poly]
    back = [p.P(x, y, -p.depth) for x, y in poly]
    base = md.nv
    md.v = np.vstack([md.v, np.array(front), np.array(back)]) if md.nv else np.vstack([np.array(front), np.array(back)])
    md.f.append([base + i for i in range(n)]); md.uv.extend([p.uv(x, y) for x, y in poly]); md.mi.append(mat); md.sharp.append(True)
    md.f.append([base + n + i for i in range(n)][::-1]); md.uv.extend([swatch_uv('plastic', 0.5, 0.5)] * n); md.mi.append(M_DARK); md.sharp.append(True)
    for i in range(n):
        j = (i + 1) % n
        md.f.append([base + i, base + n + i, base + n + j, base + j]); md.uv.extend([swatch_uv('grey', 0.5, 0.5)] * 4)
        md.mi.append(M_PANEL); md.sharp.append(True)


def knob(md, p, c, height=0.017):
    r = c.r or 0.012
    base = p.P(c.x, c.y, 0.0)
    prof = [(r * 1.18, 0.0), (r * 1.18, 0.004), (r * 1.0, 0.0045), (r * 0.98, height * 0.9), (r * 0.85, height), (0.0, height)]
    mk.lathe(prof, n=20, origin=base, axis=p.n, ref=p.y, mat=M_DARK, md=md)
    # pointer line
    tip = p.P(c.x, c.y + r * 0.8, height + 0.0005)
    ctr = p.P(c.x, c.y + r * 0.1, height + 0.0005)
    w = p.x * 0.0012
    quad(md, [ctr - w, ctr + w, tip + w, tip - w], [swatch_uv('trim', 0.5, 0.5)] * 4, M_WHITE)


def toggle(md, p, c, guard=False):
    b = p.P(c.x, c.y, 0.0)
    mk.lathe([(0.0055, 0.0), (0.0055, 0.003), (0.004, 0.0045), (0.0, 0.0045)], n=10, origin=b, axis=p.n, ref=p.y, mat=M_METAL, md=md)
    d = p.n * math.cos(math.radians(28)) + p.y * math.sin(math.radians(28))
    a0 = b + p.n * 0.004
    a1 = a0 + d * 0.019
    mk.tube(a0, a1, 0.0018, 0.0026, n=8, caps=True, mat=M_METAL, md=md)
    mk.lathe([(0.0, -0.003), (0.0032, -0.0015), (0.0032, 0.0015), (0.0, 0.003)], n=8, origin=a1, axis=d, ref=p.x, mat=M_METAL, md=md)
    if guard:
        red = c.label in ('BAT', 'EMER EXIT', 'BUS TFR', 'ALT FLAPS')
        cen = p.P(c.x, c.y + 0.004, 0.012)
        oriented_box(md, cen + p.n * 0.0, (p.x, p.y, p.n), (0.017, 0.030, 0.003), M_RED if red else M_DARK)
        for sx in (-1, 1):
            oriented_box(md, p.P(c.x + sx * 0.0085, c.y + 0.004, 0.006), (p.x, p.y, p.n), (0.0015, 0.030, 0.012), M_RED if red else M_DARK)


def bezel_ring(md, p, c):
    r = c.r
    prof = [(r * 1.0, 0.0), (r * 1.14, 0.0), (r * 1.14, 0.004), (r * 1.0, 0.004), (r * 1.0, 0.0)]
    mk.lathe(prof, n=24, origin=p.P(c.x, c.y, 0.0), axis=p.n, ref=p.y, mat=M_DARK, md=md)


def screen_obj(name, p, cx, cy, w, h, off, mats, parent):
    pts = [p.P(cx - w / 2, cy - h / 2, off), p.P(cx + w / 2, cy - h / 2, off), p.P(cx + w / 2, cy + h / 2, off),
           p.P(cx - w / 2, cy + h / 2, off)]
    md = MeshData()
    # v = 0 at the TOP of the screen (canvas textures use flipY = true)
    md.add(TB(*np.array(pts).T), [[0, 1, 2, 3]], [(0, 1), (1, 1), (1, 0), (0, 0)], mat=0, flat=True)
    mat = MAT.principled(name, (0.0, 0.0, 0.0), 0.12, 0.0, emission=(0, 0, 0), emission_strength=1.0)
    o = mk.obj(name, md, [mat], smooth=False)
    o['interior'] = 1
    return o


def cdu_geo(md, p, c, mats, parent, created):
    from fdlayout import CDU_W, CDU_H, CDU_SCREEN, cdu_keys
    ox = c.x - CDU_W / 2
    oy = c.y + 0.005
    # body
    panel_box(md, p, c.x, oy + CDU_H / 2, CDU_W, CDU_H, 0.012, side_mat=M_DARK)
    sx, sy, sw, sh = CDU_SCREEN
    created.append(screen_obj(c.name, p, ox + sx, oy + sy, sw, sh, 0.0125, mats, parent))
    for (name, kx, ky, kw, kh, lab) in cdu_keys():
        panel_box(md, p, ox + kx, oy + ky, kw, kh, 0.004, off=0.012, side_mat=M_DARK if name[0] != 'a' else M_WHITE)


def gear_lever(md, p, c):
    base = p.P(c.x, c.y - 0.04, 0.0)
    tip = base + p.n * 0.085 - p.y * 0.035
    mk.tube(base, tip, 0.006, n=10, mat=M_METAL, md=md)
    # wheel-shaped knob (white)
    mk.lathe([(0.012, -0.009), (0.02, -0.008), (0.022, 0.0), (0.02, 0.008), (0.012, 0.009)], n=20, origin=tip,
             axis=p.x, ref=p.n, mat=M_WHITE, md=md)
    oriented_box(md, p.P(c.x, c.y, 0.002), (p.x, p.y, p.n), (0.02, 0.14, 0.004), M_DARK)


def tiller(md, p, c):
    cen = p.P(c.x, c.y, 0.03)
    mk.lathe([(0.055, -0.006), (0.064, 0.0), (0.055, 0.006), (0.052, 0.0), (0.055, -0.006)], n=24, origin=cen, axis=p.n, ref=p.x, mat=M_DARK, md=md)
    mk.tube(p.P(c.x, c.y, 0.0), cen, 0.012, n=10, mat=M_DARK, md=md)
    mk.tube(cen + p.x * 0.035, cen + p.x * 0.035 + p.n * 0.035, 0.008, n=8, mat=M_DARK, md=md)
    for a in (0, 120, 240):
        d = p.x * math.cos(math.radians(a)) + p.y * math.sin(math.radians(a))
        mk.tube(cen, cen + d * 0.053, 0.004, n=6, caps=False, mat=M_DARK, md=md)


def build_controls(md, p, mats, parent, created):
    for c in p.ctls:
        k = c.kind
        if k == 'du':
            panel_box(md, p, c.x, c.y, c.w + 0.036, c.h + 0.040, 0.012)
            created.append(screen_obj(c.name, p, c.x, c.y, c.w, c.h, 0.0122, mats, parent))
        elif k == 'isfd':
            panel_box(md, p, c.x, c.y, c.w + 0.022, c.h + 0.022, 0.012)
        elif k == 'knob':
            knob(md, p, c)
        elif k == 'toggle':
            toggle(md, p, c)
        elif k == 'guard':
            toggle(md, p, c, guard=True)
        elif k == 'annun':
            panel_box(md, p, c.x, c.y, c.w, c.h, 0.004)
        elif k == 'button':
            panel_box(md, p, c.x, c.y, c.w, c.h, 0.007)
        elif k in ('gauge', 'clock'):
            bezel_ring(md, p, c)
        elif k == 'gear':
            gear_lever(md, p, c)
        elif k == 'cb':
            mk.lathe([(0.0062, 0.0), (0.0062, 0.004), (0.0045, 0.009), (0.0, 0.009)], n=8, origin=p.P(c.x, c.y, 0.0),
                     axis=p.n, ref=p.y, mat=M_DARK, md=md)
        elif k == 'tiller':
            tiller(md, p, c)
        elif k == 'cdu':
            cdu_geo(md, p, c, mats, parent, created)


# ------------------------------------------------------------------ structure helpers
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


def section_plate(md, X, z0, z1, mat, uvname='trim', flip=False, xfun=None):
    """Flat plate filling the inner section at station X between heights z0..z1 (xfun(Z) may tilt it)."""
    zs = np.linspace(z0, z1, 12)
    right = [(half_width_at(X, z), z) for z in zs]
    pts = right + [(-y, z) for y, z in right[::-1]]
    P = [np.array([xfun(z) if xfun else X, y, z]) for y, z in pts]
    ymax = max(abs(y) for y, _ in pts) + 1e-6
    uvs = [swatch_uv(uvname, 0.5 + y / (2 * ymax), (z - z0) / max(z1 - z0, 1e-6)) for y, z in pts]
    face = list(range(len(P)))
    if flip:
        face = face[::-1]; uvs = uvs[::-1]
    md.add(np.array(P), [face], uvs, mat=mat, flat=True)


def cushion(md, c, axes, w, h, d, r, mat, uvname, bulge=0.012, n=4):
    """Rounded cushion: rounded rectangle (w x h, corner radius r) in the axes[0]/axes[1] plane, depth d along
    axes[2], front face slightly domed. UVs map the front face onto the swatch."""
    ax, ay, az = [np.asarray(a_, float) for a_ in axes]
    c = np.asarray(c, float)
    poly = mk.rounded_rect(w, h, r, n)
    m = len(poly)
    rings = []
    for k, (zz, sc) in enumerate(((-d / 2, 0.96), (-d / 2 + 0.25 * d, 1.0), (d / 2 - 0.3 * d, 1.0), (d / 2, 0.93))):
        ring = [c + ax * px * sc + ay * py * sc + az * zz for px, py in poly]
        rings.append(ring)
    V = []
    for ring in rings:
        V.extend(ring)
    base = md.nv
    md.v = np.vstack([md.v, np.array(V)]) if md.nv else np.array(V)
    uvf = lambda px, py: swatch_uv(uvname, 0.5 + px / w * 0.9, 0.5 + py / h * 0.9)
    for k in range(3):
        for i in range(m):
            j = (i + 1) % m
            f = [base + k * m + i, base + k * m + j, base + (k + 1) * m + j, base + (k + 1) * m + i]
            md.f.append(f)
            md.uv.extend([uvf(*poly[i]), uvf(*poly[j]), uvf(*poly[j]), uvf(*poly[i])])
            md.mi.append(mat); md.sharp.append(False)
    # front (domed) and back caps
    cf = c + az * (d / 2 + bulge)
    ci = md.nv
    md.v = np.vstack([md.v, cf[None], (c - az * d / 2)[None]])
    for i in range(m):
        j = (i + 1) % m
        md.f.append([base + 3 * m + i, base + 3 * m + j, ci]); md.uv.extend([uvf(*poly[i]), uvf(*poly[j]), uvf(0, 0)])
        md.mi.append(mat); md.sharp.append(False)
        md.f.append([base + j, base + i, ci + 1]); md.uv.extend([uvf(*poly[j]), uvf(*poly[i]), uvf(0, 0)])
        md.mi.append(mat); md.sharp.append(False)


def seat(md, yc):
    """737NG pilot seat: pedestal + rails, sheepskin-covered rounded cushions, headrest, armrests on the backrest."""
    cx = 3.34
    X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])
    oriented_box(md, (cx + 0.02, yc, 2.82), (X, Y, Z), (0.34, 0.30, 0.30), M_PANEL, other='grey')
    for dy in (-0.14, 0.14):
        oriented_box(md, (cx - 0.05, yc + dy, 2.675), (X, Y, Z), (0.70, 0.04, 0.03), M_METAL)
    oriented_box(md, (cx - 0.02, yc, 2.99), (X, Y, Z), (0.46, 0.44, 0.04), M_DARK)      # seat frame
    # seat pan cushion (front face up)
    cushion(md, (cx - 0.03, yc, 3.06), (Y, -X, Z), 0.48, 0.48, 0.10, 0.07, M_PANEL, 'sheep')
    # backrest, tilted 14 deg aft, cushion facing forward
    t = math.radians(14)
    up = np.array([math.sin(t), 0, math.cos(t)])
    fwd = np.array([-math.cos(t), 0, math.sin(t)])
    bc = np.array([cx + 0.24, yc, 3.13]) + up * 0.36
    oriented_box(md, bc - fwd * 0.035, (-Y, up, fwd), (0.46, 0.70, 0.05), M_DARK)      # shell
    cushion(md, bc + fwd * 0.03, (-Y, up, fwd), 0.44, 0.68, 0.09, 0.09, M_PANEL, 'sheep', bulge=0.02)
    for sy in (-1, 1):   # side bolsters
        cushion(md, bc + fwd * 0.05 + (-Y) * (sy * 0.20) + up * 0.02, (-Y, up, fwd), 0.07, 0.55, 0.08, 0.03, M_PANEL, 'sheep')
    hc = bc + up * 0.46 + fwd * 0.02
    cushion(md, hc, (-Y, up, fwd), 0.30, 0.17, 0.10, 0.06, M_PANEL, 'sheep')
    # armrests pivoting on the backrest (outboard one down, inboard one down as well)
    for sy in (-1, 1):
        piv = bc + (-Y) * (sy * 0.265) - up * 0.10 + fwd * 0.02
        arm_c = piv + fwd * 0.17 - up * 0.01
        oriented_box(md, arm_c, frame3(Y * sy, fwd), (0.30, 0.06, 0.055), M_PANEL, other='leather')
        oriented_box(md, piv, frame3(Y * sy, fwd), (0.06, 0.06, 0.03), M_METAL)


def rudder_pedals(md, yc):
    for dy in (-0.105, 0.105):
        c = np.array([2.12, yc + dy, 2.84])
        t = math.radians(35)
        up = np.array([-math.sin(t), 0, math.cos(t)])
        oriented_box(md, c, (np.array([0, 1, 0]), up, np.array([math.cos(t), 0, math.sin(t)])), (0.09, 0.20, 0.02), M_DARK)
        mk.tube(c - up * 0.08 + np.array([0.02, 0, 0]), np.array([2.0, yc + dy, 2.72]), 0.012, n=8, mat=M_METAL, md=md)


# ------------------------------------------------------------------ movable parts
def yoke_parts(side):
    """Returns (column MeshData, column pivot, wheel MeshData, wheel pivot) in ground coords."""
    yc = side * 0.53
    base = np.array([2.64, yc, 2.66])
    top = np.array([2.66, yc, 3.10])
    col = MeshData()
    mk.lathe([(0.09, 0.0), (0.075, 0.05), (0.05, 0.11), (0.045, 0.14), (0.0, 0.14)], n=16, origin=base, axis=(0, 0, 1), ref=(1, 0, 0), mat=M_DARK, md=col)
    mk.tube(base, top, 0.036, 0.032, n=16, mat=M_DARK, md=col)
    hub = np.array([2.72, yc, 3.17])
    mk.tube(top, hub - np.array([0.04, 0, 0]), 0.032, n=16, mat=M_DARK, md=col)
    wheel = MeshData()
    mk.tube(hub - np.array([0.05, 0, 0]), hub + np.array([0.035, 0, 0]), 0.045, n=18, mat=M_DARK, md=wheel)
    # crossbar + ram's horn grips
    ax = (np.array([0, 1, 0]), np.array([0, 0, 1]), np.array([1, 0, 0]))
    oriented_box(wheel, hub + np.array([0.03, 0, -0.01]), ax, (0.26, 0.05, 0.03), M_DARK)
    for sy in (-1, 1):
        p0 = hub + np.array([0.03, sy * 0.12, -0.02])
        p1 = hub + np.array([0.04, sy * 0.165, 0.06])
        p2 = hub + np.array([0.03, sy * 0.15, 0.13])
        mk.tube(p0, p1, 0.019, 0.02, n=12, mat=M_DARK, md=wheel)
        mk.tube(p1, p2, 0.02, 0.016, n=12, mat=M_DARK, md=wheel)
        # PTT / trim switch tops
        mk.lathe([(0.0, 0.0), (0.009, 0.0), (0.008, 0.008), (0.0, 0.009)], n=8, origin=p2, axis=(0, 0, 1), ref=(1, 0, 0), mat=M_RED if sy < 0 else M_METAL, md=wheel)
    # checklist clip plate + brand-free centre boss
    oriented_box(wheel, hub + np.array([0.055, 0, 0.035]), ax, (0.13, 0.085, 0.006), M_PANEL, other='grey')
    return col, base, wheel, hub


def thrust_lever(y):
    piv = np.array([3.06, y, 2.84])
    md = MeshData()
    ang = math.radians(25)          # idle: leaning aft
    d = np.array([math.sin(ang), 0, math.cos(ang)])
    tip = piv + d * 0.34
    oriented_box(md, piv + d * 0.17, frame3(d, (0, 1, 0)), (0.012, 0.03, 0.34), M_METAL)
    knob_c = tip + np.array([0.0, 0.0, 0.0])
    mk.tube(knob_c - np.array([0, 0.045, 0]), knob_c + np.array([0, 0.045, 0]), 0.022, n=16, mat=M_DARK, md=md)
    # TO/GA button + reverse lever (piggy-back)
    mk.lathe([(0.0, 0.0), (0.007, 0.0), (0.007, 0.004), (0.0, 0.004)], n=8, origin=knob_c + np.array([0.0, 0.0, 0.022]),
             axis=(0, 0, 1), ref=(1, 0, 0), mat=M_WHITE, md=md)
    rv = piv + d * 0.24 + np.array([-0.02, 0, 0])
    oriented_box(md, rv + np.array([-0.025, 0, 0.02]), frame3((0, 0, 1), (0, 1, 0)), (0.02, 0.05, 0.015), M_DARK)
    return md, piv


def side_lever(y, length, handle, neutral_deg):
    piv = np.array([3.13, y, 2.87])
    md = MeshData()
    a = math.radians(neutral_deg)          # leaning forward at neutral
    d = np.array([-math.sin(a), 0, math.cos(a)])
    oriented_box(md, piv + d * length / 2, frame3(d, (0, 1, 0)), (0.01, 0.018, length), M_METAL)
    tip = piv + d * length
    if handle == 'flap':
        oriented_box(md, tip, frame3(d, (0, 1, 0)), (0.05, 0.04, 0.035), M_WHITE)
    else:
        oriented_box(md, tip, frame3(d, (0, 1, 0)), (0.045, 0.07, 0.018), M_DARK)
    return md, piv


# ------------------------------------------------------------------ main builder
def build_interior(imats):
    created = []
    inter = bpy.data.objects.get('interior') or mk.empty('interior', (0, 0, 0))
    L = FL.layout()
    md = MeshData()   # static, ground coords, slots: panel, dark, metal, red, white, trim, glass
    for name, p in L.items():
        panel_slab(md, p)
        build_controls(md, p, imats, inter, created)
    # ---- glareshield body (trapezoid top, anti-glare)
    gs = L['glareshield']
    GX = 2.525
    top_pts = [np.array([GX, -0.98, 3.56]), np.array([GX, 0.98, 3.56]), np.array([2.26, 0.70, 3.57]), np.array([2.26, -0.70, 3.57])]
    quad(md, top_pts, [swatch_uv('plastic', u, v) for u, v in ((0, 0), (1, 0), (1, 1), (0, 1))], M_DARK)
    bot = [np.array([GX, -0.98, 3.43]), np.array([GX, 0.98, 3.43]), np.array([2.33, 0.95, 3.46]), np.array([2.33, -0.95, 3.46])]
    quad(md, bot[::-1], [swatch_uv('plastic', 0.5, 0.5)] * 4, M_DARK)
    for sy in (-1, 1):
        side = [np.array([GX, sy * 0.98, 3.43]), np.array([GX, sy * 0.98, 3.56]), np.array([2.26, sy * 0.70, 3.57]), np.array([2.33, sy * 0.95, 3.46])]
        quad(md, side[::-1] if sy > 0 else side, [swatch_uv('plastic', 0.5, 0.5)] * 4, M_DARK)
    # ---- panel surround (fills the section around the MIP up to the glareshield) and footwell
    tilt = lambda z: 2.402 - (z - 2.80) * 0.105 / 0.66
    section_plate(md, 2.47, 2.80, 3.45, M_PANEL, 'grey', flip=False, xfun=tilt)
    section_plate(md, 1.98, 2.60, 2.84, M_PANEL, 'plastic', flip=False)
    fw = [np.array([1.98, -0.9, 2.82]), np.array([1.98, 0.9, 2.82]), np.array([2.46, 0.95, 2.80]), np.array([2.46, -0.95, 2.80])]
    quad(md, fw, [swatch_uv('plastic', 0.5, 0.5)] * 4, M_DARK)
    for side in (-1, 1):
        rudder_pedals(md, side * 0.53)
        seat(md, side * 0.53)
    # ---- floor (carpet) from the footwell to the door bulkhead
    xs = np.linspace(1.98, 4.72, 12)
    ws = [half_width_at(x, 2.66) for x in xs]
    for i in range(len(xs) - 1):
        pts = [np.array([xs[i], -ws[i], 2.65]), np.array([xs[i + 1], -ws[i + 1], 2.65]), np.array([xs[i + 1], ws[i + 1], 2.65]), np.array([xs[i], ws[i], 2.65])]
        u0, u1 = (xs[i] - 1.98) / 2.74, (xs[i + 1] - 1.98) / 2.74
        quad(md, pts, [swatch_uv('carpet', 0, u0), swatch_uv('carpet', 0, u1), swatch_uv('carpet', 1, u1), swatch_uv('carpet', 1, u0)], M_PANEL)
    # ---- pedestal body
    for (x0, x1, zt, hw) in ((2.44, 2.76, 2.87, 0.225), (2.745, 3.33, 2.955, 0.20), (3.33, 3.98, 2.905, 0.20)):
        c = np.array([(x0 + x1) / 2, 0, (2.65 + zt) / 2 - 0.004])
        oriented_box(md, c, (np.array([1, 0, 0]), np.array([0, 1, 0]), np.array([0, 0, 1])), (x1 - x0, 2 * hw, zt - 2.65 - 0.01), M_PANEL, other='grey')
    # throttle quadrant side plates (stab trim scale) + trim wheels
    for sy, sw in ((-1, 'tq_side_l'), (1, 'tq_side_r')):
        pts = [np.array([3.33, sy * 0.201, 2.70]), np.array([2.75, sy * 0.201, 2.70]), np.array([2.75, sy * 0.201, 2.95]), np.array([3.33, sy * 0.201, 2.95])]
        uvs = [swatch_uv(sw, 0, 0), swatch_uv(sw, 1, 0), swatch_uv(sw, 1, 1), swatch_uv(sw, 0, 1)]
        if sy < 0:
            pts = pts[::-1]; uvs = uvs[::-1]
        quad(md, pts, uvs, M_PANEL)
        cen = np.array([3.02, sy * 0.232, 2.83])
        mk.lathe([(0.0, -0.016), (0.10, -0.016), (0.13, -0.012), (0.135, 0.0), (0.13, 0.012), (0.10, 0.016), (0.0, 0.016)],
                 n=32, origin=cen, axis=(0, 1, 0), ref=(1, 0, 0), mat=M_DARK, md=md)
        # white stripe on the trim wheel rim
        mk.lathe([(0.1355, -0.004), (0.137, 0.0), (0.1355, 0.004)], n=32, origin=cen, axis=(0, 1, 0), ref=(1, 0, 0), mat=M_WHITE, md=md)
        mk.tube(cen + np.array([0, sy * 0.012, 0]) + np.array([0.08, 0, 0.08]), cen + np.array([0, sy * 0.05, 0]) + np.array([0.08, 0, 0.08]), 0.01, n=8, mat=M_WHITE, md=md)
    # start levers (fuel cutoff) aft of the thrust levers
    for y in (-0.05, 0.05):
        b = np.array([3.28, y, 2.955])
        mk.tube(b, b + np.array([0.0, 0, 0.07]), 0.006, n=8, mat=M_METAL, md=md)
        oriented_box(md, b + np.array([0, 0, 0.08]), (np.array([1, 0, 0]), np.array([0, 1, 0]), np.array([0, 0, 1])), (0.03, 0.03, 0.025), M_DARK)
    # ---- side consoles
    for sy in (-1, 1):
        c = np.array([3.35, sy * 1.07, 2.885])
        oriented_box(md, c, (np.array([1, 0, 0]), np.array([0, 1, 0]), np.array([0, 0, 1])), (1.20, 0.46, 0.47), M_PANEL, other='grey')
    # ---- overhead housing skirts
    ov = L['overhead']
    for x in (0.0, ov.w):
        a, b = ov.P(x, 0, 0), ov.P(x, ov.h, 0)
        c, d = ov.P(x, ov.h, -0.14), ov.P(x, 0, -0.14)
        quad(md, [a, b, c, d], [swatch_uv('grey', 0.5, 0.5)] * 4, M_PANEL)
        quad(md, [d, c, b, a], [swatch_uv('grey', 0.5, 0.5)] * 4, M_PANEL)
    fwd = [ov.P(0, 0, 0), ov.P(ov.w, 0, 0), ov.P(ov.w, 0, -0.14), ov.P(0, 0, -0.14)]
    quad(md, fwd, [swatch_uv('grey', 0.5, 0.5)] * 4, M_PANEL)
    quad(md, fwd[::-1], [swatch_uv('grey', 0.5, 0.5)] * 4, M_PANEL)
    # ---- door bulkhead + door
    section_plate(md, 4.72, 2.65, 4.95, M_PANEL, 'trim', flip=True)
    door = [np.array([4.71, 0.42, 2.66]), np.array([4.71, -0.42, 2.66]), np.array([4.71, -0.42, 4.55]), np.array([4.71, 0.42, 4.55])]
    quad(md, door, [swatch_uv('door', 0, 0), swatch_uv('door', 1, 0), swatch_uv('door', 1, 1), swatch_uv('door', 0, 1)], M_PANEL)
    mk.tube(np.array([4.70, -0.30, 3.62]), np.array([4.64, -0.30, 3.62]), 0.012, n=8, mat=M_METAL, md=md)
    oriented_box(md, np.array([4.64, -0.25, 3.62]), frame3((-1, 0, 0), (0, 1, 0)), (0.12, 0.022, 0.02), M_METAL)
    # ---- sun visors (stowed) and window-post trim
    for sy in (-1, 1):
        c = np.array([3.30, sy * 1.08, 4.22])
        oriented_box(md, c, frame3((0, -sy * math.sin(0.6), math.cos(0.6)), (1, 0, 0)), (0.42, 0.20, 0.006), M_DARK)
    # convert to blender and create the merged static object
    md.v = TB(md.v[:, 0], md.v[:, 1], md.v[:, 2])
    mats = [imats['panel'], imats['dark'], imats['metal'], imats['red'], imats['white'], imats['trim'], imats['glass']]
    st = mk.obj('flightdeck', md, mats, smooth=True, sharp_angle=35)
    created.append(st)
    # ---- movable: yokes, levers
    for side, sfx in ((-1, 'L'), (1, 'R')):
        col, base, wheel, hub = yoke_parts(side)
        for m in (col, wheel):
            m.v = TB(m.v[:, 0], m.v[:, 1], m.v[:, 2])
        Mc = mk.hinge_matrix(TB(*base), (1, 0, 0), (0, 0, 1))
        co = mk.obj(f'yoke_col_{sfx}', col, mats, matrix=Mc, sharp_angle=40)
        Mw = mk.hinge_matrix(TB(*hub), (1, 0, 0), (0, 0, 1))
        wo = mk.obj(f'yoke_{sfx}', wheel, mats, matrix=Mw, parent=co, sharp_angle=40)
        created += [co, wo]
    for i, y in ((1, -0.07), (2, 0.07)):
        m, piv = thrust_lever(y)
        m.v = TB(m.v[:, 0], m.v[:, 1], m.v[:, 2])
        created.append(mk.obj(f'lever_thrust_{i}', m, mats, matrix=mk.hinge_matrix(TB(*piv), (1, 0, 0), (0, 0, 1)), sharp_angle=40))
    for name, y, length, h, nd in (('lever_speedbrake', -0.17, 0.20, 'sb', 30), ('lever_flap', 0.17, 0.19, 'flap', 30)):
        m, piv = side_lever(y, length, h, nd)
        m.v = TB(m.v[:, 0], m.v[:, 1], m.v[:, 2])
        created.append(mk.obj(name, m, mats, matrix=mk.hinge_matrix(TB(*piv), (1, 0, 0), (0, 0, 1)), sharp_angle=40))
    # eye points
    mk.empty('eye_pilot', TB(*FL.EYE_CAPT))
    mk.empty('eye_copilot', TB(*FL.EYE_FO))
    for o in created:
        if o.parent is None:
            mk.set_parent(o, inter)
    return created
