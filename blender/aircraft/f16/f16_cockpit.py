"""F-16C cockpit interior geometry (pure numpy MeshData; drawing frame -> Blender).

Materials are referenced by key; build.py maps keys to Blender materials:
  'panel' (cockpit atlas), 'dark', 'black', 'metal', 'seat' (atlas fabric), 'yellow', 'screen', 'hudglass', 'glass2',
  'mirror', 'rubber', 'red'
"""
import math
import numpy as np
from f16_geom import MeshData, to_blender, grid_faces, section_curve, smoothstep
import f16_cockpit_layout as CL
import f16_parts as PT
import f16_fuselage as FU

A = CL.ATLAS


def atlas_uv(rect, fu, fv):
    """rect (x0,y0,w,h) in atlas pixels; fu,fv in [0,1] (fv=0 at the rect bottom)."""
    x0, y0, w, h = rect
    return ((x0 + fu * w) / A, 1.0 - (y0 + (1 - fv) * h) / A)


class Builder:
    """Collects geometry per material key."""
    def __init__(self):
        self.parts = {}

    def md(self, key):
        return self.parts.setdefault(key, MeshData(np.zeros((0, 3)), [], [], key))

    def add_faces(self, key, verts_d, faces, uvs=None):
        m = self.md(key)
        V = to_blender(np.array([v[0] for v in verts_d]), np.array([v[1] for v in verts_d]), np.array([v[2] for v in verts_d]))
        off = len(m.verts)
        m.verts = np.concatenate([m.verts, V]) if len(m.verts) else V
        for k, f in enumerate(faces):
            m.faces.append(tuple(i + off for i in f))
            m.uvs.append(uvs[k] if uvs is not None else [(0.0, 0.0)] * len(f))

    # ------------------------------------------------------------------ primitives (drawing frame)
    def quad(self, key, p00, p10, p11, p01, uv=None, nu=1, nv=1):
        P = [np.array(p, float) for p in (p00, p10, p11, p01)]
        verts, faces, uvs = [], [], []
        for j in range(nv + 1):
            for i in range(nu + 1):
                a, b = i / nu, j / nv
                p = (1 - a) * (1 - b) * P[0] + a * (1 - b) * P[1] + a * b * P[2] + (1 - a) * b * P[3]
                verts.append(tuple(p))
        for j in range(nv):
            for i in range(nu):
                f = (j * (nu + 1) + i, j * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i)
                faces.append(f)
                if uv is not None:
                    uvs.append([uv(((k % (nu + 1)) / nu), ((k // (nu + 1)) / nv)) for k in f])
        self.add_faces(key, verts, faces, uvs if uv is not None else None)

    def box(self, key, center, size, axes=((1, 0, 0), (0, 1, 0), (0, 0, 1)), uv_top=None):
        c = np.array(center, float)
        ax = [np.array(a, float) / np.linalg.norm(a) for a in axes]
        h = [s / 2 for s in size]
        V = []
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    V.append(tuple(c + sx * h[0] * ax[0] + sy * h[1] * ax[1] + sz * h[2] * ax[2]))
        F = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        uvs = None
        if uv_top is not None:
            uvs = [[(0, 0)] * 4 for _ in F]
            # +z face (index 3: verts 2,3,7,6?) -> choose the face whose normal is +axes[2]
            uvs[3] = [uv_top(0, 0), uv_top(0, 1), uv_top(1, 1), uv_top(1, 0)]
        self._add_oriented(key, V, F, c, uvs)

    def _add_oriented(self, key, V, F, center, uvs=None):
        Vn = np.array(V)
        out, ouv = [], []
        for k, f in enumerate(F):
            p = Vn[list(f)]
            n = np.cross(p[1] - p[0], p[2] - p[0])
            if np.dot(n, p.mean(0) - center) < 0:
                f = f[::-1]
                if uvs is not None:
                    uvs[k] = uvs[k][::-1]
            out.append(f)
        self.add_faces(key, V, out, uvs)

    def cyl(self, key, p0, p1, r0, r1=None, n=16, cap=True):
        r1 = r0 if r1 is None else r1
        p0 = np.array(p0, float); p1 = np.array(p1, float)
        ax = p1 - p0; L = np.linalg.norm(ax); ax /= L
        tmp = np.array([1.0, 0, 0]) if abs(ax[0]) < 0.9 else np.array([0, 1.0, 0])
        u = np.cross(ax, tmp); u /= np.linalg.norm(u); v = np.cross(ax, u)
        V = []
        for p, r in ((p0, r0), (p1, r1)):
            for k in range(n):
                a = 2 * math.pi * k / n
                V.append(tuple(p + r * (math.cos(a) * u + math.sin(a) * v)))
        F = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
        if cap:
            V.append(tuple(p0)); V.append(tuple(p1))
            F += [((k + 1) % n, k, 2 * n) for k in range(n)] + [(n + k, n + (k + 1) % n, 2 * n + 1) for k in range(n)]
        # orient outward
        Vn = np.array(V)
        out = []
        for f in F:
            p = Vn[list(f)]
            nrm = np.cross(p[1] - p[0], p[2] - p[0])
            cen = p.mean(0)
            axis_pt = p0 + ax * np.dot(cen - p0, ax)
            ref = cen - axis_pt if len(f) == 4 else (ax if f[-1] == 2 * n + 1 else -ax)
            if np.dot(nrm, ref) < 0:
                f = f[::-1]
            out.append(f)
        self.add_faces(key, V, out)

    def disc(self, key, center, normal, r, n=24, uv=None):
        c = np.array(center, float); nn = np.array(normal, float); nn /= np.linalg.norm(nn)
        tmp = np.array([0, 1.0, 0]) if abs(nn[1]) < 0.9 else np.array([1.0, 0, 0])
        u = np.cross(nn, tmp); u /= np.linalg.norm(u); v = np.cross(nn, u)
        V = [tuple(c)] + [tuple(c + r * (math.cos(2 * math.pi * k / n) * u + math.sin(2 * math.pi * k / n) * v)) for k in range(n)]
        F = [(0, 1 + k, 1 + (k + 1) % n) for k in range(n)]
        Vn = np.array(V)
        out = []
        for f in F:
            p = Vn[list(f)]
            if np.dot(np.cross(p[1] - p[0], p[2] - p[0]), nn) < 0:
                f = f[::-1]
            out.append(f)
        uvs = None
        if uv is not None:
            uvs = []
            for f in out:
                cor = []
                for i in f:
                    d = Vn[i] - c
                    cor.append(uv(0.5 + 0.5 * np.dot(d, u) / r, 0.5 + 0.5 * np.dot(d, v) / r))
                uvs.append(cor)
        self.add_faces(key, V, out, uvs)

    # ------------------------------------------------------------------ panel-frame helpers
    def pquad(self, key, u0, v0, u1, v1, depth, uv=None, nu=1, nv=1):
        P = lambda u, v: CL.panel_point(u, v, depth)
        self.quad(key, P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), uv, nu, nv)

    def pbox(self, key, u0, v0, u1, v1, d0, d1):
        su, zu = math.sin(CL.PANEL_TILT), math.cos(CL.PANEL_TILT)
        up = (-su, 0.0, zu)
        nrm = (zu, 0.0, su)
        cu, cv, cd = (u0 + u1) / 2, (v0 + v1) / 2, (d0 + d1) / 2
        c = CL.panel_point(cu, cv, cd)
        self.box(key, c, (u1 - u0, v1 - v0, d1 - d0), axes=((0, 1, 0), up, nrm))

    def pring(self, key, u, v, r_out, r_in, depth0, depth1, n=28):
        """Round bezel ring (tube) on the panel."""
        su, zu = math.sin(CL.PANEL_TILT), math.cos(CL.PANEL_TILT)
        up = np.array((-su, 0.0, zu)); side = np.array((0.0, 1.0, 0.0)); nrm = np.array((zu, 0.0, su))
        c0 = np.array(CL.panel_point(u, v, 0.0))
        V, F = [], []
        rings = [(r_in, depth0), (r_in, depth1), (r_out, depth1), (r_out, depth0)]
        for r, d in rings:
            for k in range(n):
                a = 2 * math.pi * k / n
                V.append(tuple(c0 + nrm * d + r * (math.cos(a) * side + math.sin(a) * up)))
        for q in range(3):
            for k in range(n):
                k2 = (k + 1) % n
                F.append((q * n + k, q * n + k2, (q + 1) * n + k2, (q + 1) * n + k))
        # orientation: let the caller rely on double-sided-safe shading: orient faces away from the ring axis/center
        Vn = np.array(V); out = []
        for f in F:
            p = Vn[list(f)]
            nn = np.cross(p[1] - p[0], p[2] - p[0])
            cen = p.mean(0)
            rel = cen - (c0 + nrm * np.dot(cen - c0, nrm))
            ref = rel if np.linalg.norm(rel) > 1e-6 else nrm
            # inner wall faces point inward (toward axis), outer wall outward, front face toward the pilot
            dist = np.linalg.norm(rel)
            if abs(dist - r_in) < 1e-4 * 50 and abs(np.dot(p[1] - p[0], nrm)) + abs(np.dot(p[2] - p[1], nrm)) > 1e-6:
                ref = -rel
            elif abs(np.dot(nn / (np.linalg.norm(nn) + 1e-12), nrm)) > 0.9:
                ref = nrm
            if np.dot(nn, ref) < 0:
                f = f[::-1]
            out.append(f)
        self.add_faces(key, V, out)


# ----------------------------------------------------------------------------------------------------------------------
def build(scr):
    """Build the interior. `scr` collects screen quads: dict name -> MeshData (UV 0..1)."""
    b = Builder()
    tex = CL.TEX
    pu0, pu1 = CL.PANEL_TEX_U
    pv0, pv1 = CL.PANEL_TEX_V

    def panel_uv(u, v):
        return atlas_uv(tex['panel'], (u - pu0) / (pu1 - pu0), (v - pv0) / (pv1 - pv0))

    # ---------------- main instrument panel face (textured), split into the outline polygon (triangulated grid clip)
    outline = CL.PANEL_OUTLINE
    # rectangular strips approximating the outline
    strips = [(-0.33, 0.17, 0.33, 0.455), (-0.25, 0.11, 0.25, 0.17), (-0.115, 0.0, 0.115, 0.11)]
    for (u0, v0, u1, v1) in strips:
        b.pquad('panel', u0, v0, u1, v1, 0.0, uv=lambda fu, fv, u0=u0, v0=v0, u1=u1, v1=v1: panel_uv(u0 + fu * (u1 - u0), v0 + fv * (v1 - v0)), nu=4, nv=3)
    # chamfer quads between the side and the lower step (0.33,0.17)->(0.25,0.11)
    for sg in (-1, 1):
        P = lambda u, v: CL.panel_point(u, v, 0.0)
        a, bb, c = (sg * 0.33, 0.17), (sg * 0.25, 0.11), (sg * 0.25, 0.17)
        b.add_faces('panel', [P(*a), P(*bb), P(*c)], [(0, 1, 2) if sg > 0 else (0, 2, 1)],
                    [[panel_uv(*a), panel_uv(*bb), panel_uv(*c)] if sg > 0 else [panel_uv(*a), panel_uv(*c), panel_uv(*bb)]])
    # panel back box (thickness), dark
    b.pbox('dark', -0.335, 0.165, 0.335, 0.458, -0.09, -0.002)
    b.pbox('dark', -0.12, -0.005, 0.12, 0.17, -0.09, -0.002)
    b.pbox('dark', -0.255, 0.105, 0.255, 0.175, -0.09, -0.002)

    # ---------------- MFDs: bezel (textured face) + recessed screen
    for name, cfg in (('screen_mfd_L', CL.MFD_L), ('screen_mfd_R', CL.MFD_R)):
        cu, cv = cfg['c']; bw, bh = cfg['bezel']; sw, sh = cfg['screen']
        b.pbox('black', cu - bw / 2, cv - bh / 2, cu + bw / 2, cv + bh / 2, 0.0, 0.028)
        b.pquad('panel', cu - bw / 2, cv - bh / 2, cu + bw / 2, cv + bh / 2, 0.0285,
                uv=lambda fu, fv: atlas_uv(tex['mfdbezel'], fu, fv))
        # OSB push buttons: 5 per side
        for side in range(4):
            for k in range(5):
                t = (k - 2) * 0.0205
                if side == 0: bu, bv = cu + t, cv + bh / 2 - 0.013
                elif side == 1: bu, bv = cu + t, cv - bh / 2 + 0.013
                elif side == 2: bu, bv = cu - bw / 2 + 0.012, cv + t
                else: bu, bv = cu + bw / 2 - 0.012, cv + t
                b.pbox('rubber', bu - 0.0065, bv - 0.0055, bu + 0.0065, bv + 0.0055, 0.0285, 0.035)
        m = MeshData(np.zeros((0, 3)), [], [], name)
        sb = Builder(); sb.pquad('s', cu - sw / 2, cv - sh / 2, cu + sw / 2, cv + sh / 2, 0.0292, uv=lambda fu, fv: (fu, fv))
        scr[name] = sb.parts['s']
    # ---------------- DED
    cu, cv = CL.DED['c']; bw, bh = CL.DED['bezel']; sw, sh = CL.DED['screen']
    b.pbox('black', cu - bw / 2, cv - bh / 2, cu + bw / 2, cv + bh / 2, 0.0, 0.020)
    b.pquad('panel', cu - bw / 2, cv - bh / 2, cu + bw / 2, cv + bh / 2, 0.0205, uv=lambda fu, fv: atlas_uv(tex['dedbezel'], fu, fv))
    sb = Builder(); sb.pquad('s', cu - sw / 2, cv - sh / 2, cu + sw / 2, cv + sh / 2, 0.0212, uv=lambda fu, fv: (fu, fv))
    scr['screen_ded'] = sb.parts['s']
    # ---------------- RWR azimuth indicator
    cu, cv = CL.RWR['c']; bw, bh = CL.RWR['bezel']; sw, sh = CL.RWR['screen']
    b.pbox('black', cu - bw / 2, cv - bh / 2, cu + bw / 2, cv + bh / 2, 0.0, 0.024)
    b.pquad('panel', cu - bw / 2, cv - bh / 2, cu + bw / 2, cv + bh / 2, 0.0245, uv=lambda fu, fv: atlas_uv(tex['rwrbezel'], fu, fv))
    sb = Builder(); sb.pquad('s', cu - sw / 2, cv - sh / 2, cu + sw / 2, cv + sh / 2, 0.0252, uv=lambda fu, fv: (fu, fv))
    scr['screen_rwr'] = sb.parts['s']
    # ---------------- ICP (upfront controls): raised box with textured face
    cu, cv = CL.ICP['c']; iw, ih = CL.ICP['size']
    b.pbox('black', cu - iw / 2, cv - ih / 2, cu + iw / 2, cv + ih / 2, 0.0, 0.032)
    b.pquad('panel', cu - iw / 2, cv - ih / 2, cu + iw / 2, cv + ih / 2, 0.0325, uv=lambda fu, fv: atlas_uv(tex['icp'], fu, fv))
    # keypad buttons as small blocks (3x4 grid on the left half)
    for r in range(4):
        for c in range(3):
            bu = cu - iw / 2 + 0.018 + c * 0.017
            bv = cv + ih / 2 - 0.016 - r * 0.0165
            b.pbox('rubber', bu - 0.0065, bv - 0.006, bu + 0.0065, bv + 0.006, 0.0325, 0.039)
    # ---------------- round gauges: bezel rings + glass (faces are painted in the panel texture)
    for name, (gu, gv, dia) in CL.GAUGES.items():
        b.pring('black', gu, gv, dia / 2 + 0.004, dia / 2 - 0.001, 0.0, 0.010, n=28)
        # small knob at the lower-left of some gauges
        if name in ('adi', 'ehsi', 'alt', 'fuel'):
            ku, kv = gu - dia / 2 + 0.002, gv - dia / 2 + 0.002
            p0 = CL.panel_point(ku, kv, 0.008); p1 = CL.panel_point(ku, kv, 0.022)
            b.cyl('black', p0, p1, 0.0075, n=12)
    # ---------------- landing gear handle
    gu, gv = CL.GEAR_HANDLE
    base0 = CL.panel_point(gu, gv, 0.0); base1 = CL.panel_point(gu, gv - 0.03, 0.07)
    b.cyl('metal', base0, base1, 0.006, n=10)
    b.cyl('white', CL.panel_point(gu, gv - 0.032, 0.066), CL.panel_point(gu, gv - 0.032, 0.090), 0.017, n=18)
    b.cyl('red', CL.panel_point(gu, gv - 0.032, 0.089), CL.panel_point(gu, gv - 0.032, 0.093), 0.009, n=12)
    # ---------------- glareshield (anti-glare cowl over the panel), follows under the canopy
    gl_lip_s = CL.panel_point(0, 0.47, 0.0)[0] + 0.035
    rows = []
    for s in np.linspace(3.18, gl_lip_s, 7):
        f = (s - 3.18) / (gl_lip_s - 3.18)
        w = 0.16 + 0.19 * f ** 0.8
        ztop = 2.455 + 0.045 * f
        rows.append((s, w, ztop))
    # top surface (textured anti-glare), rounded edges
    verts, faces, uvs = [], [], []
    nu = 10
    for i, (s, w, zt) in enumerate(rows):
        for k in range(nu + 1):
            t = -1 + 2 * k / nu
            y = t * w
            z = zt - 0.035 * abs(t) ** 3
            verts.append((s, y, z))
    for i in range(len(rows) - 1):
        for k in range(nu):
            a = i * (nu + 1) + k
            f = (a, a + (nu + 1), a + (nu + 1) + 1, a + 1)
            faces.append(f)
            uvs.append([atlas_uv(tex['glare'], (vi % (nu + 1)) / nu, (vi // (nu + 1)) / (len(rows) - 1)) for vi in f])
    b.add_faces('panel', verts, faces, uvs)
    # lip face (front of the glareshield over the panel), dark
    s_l, w_l, z_l = rows[-1]
    b.quad('black', (s_l, -w_l, z_l - 0.035), (s_l, w_l, z_l - 0.035), (s_l + 0.004, w_l, z_l - 0.075), (s_l + 0.004, -w_l, z_l - 0.075))
    b.quad('black', (s_l, -w_l, z_l - 0.035), (s_l, -0.12, z_l), (s_l, 0.12, z_l), (s_l, w_l, z_l - 0.035))
    # side cheeks down to the panel
    for sg in (-1, 1):
        b.quad('dark', (3.18, sg * 0.16, 2.42), (s_l, sg * w_l, z_l - 0.035), (s_l, sg * w_l, 2.30), (3.18, sg * 0.16, 2.30))
    # ---------------- HUD: body, combiner frame, combiner glass (screen_hud)
    hs0, hs1 = 3.40, s_l - 0.02
    b.box('dark', ((hs0 + hs1) / 2, 0, 2.535), (hs1 - hs0, 0.15, 0.10))
    b.box('black', (hs1 - 0.03, 0, 2.595), (0.07, 0.17, 0.025))
    # HUD control panel face on the rear of the body is the ICP (below); combiner posts
    cs = hs1 - 0.015           # combiner base station
    # combiner glass: spans about +5 deg .. -15 deg around the eye's forward line (conformal HUD)
    e = np.array(CL.EYE)
    dist = e[0] - (cs + 0.018)
    z_top = e[2] + dist * math.tan(math.radians(5.2))
    z_bot = e[2] - dist * math.tan(math.radians(15.2))
    hw = dist * math.tan(math.radians(9.8))
    ztop = z_top + 0.014
    for sg in (-1, 1):
        b.cyl('black', (cs, sg * (hw + 0.008), 2.60), (cs + 0.035, sg * (hw + 0.008), ztop), 0.007, n=10)
    b.cyl('black', (cs + 0.035, -(hw + 0.008), ztop), (cs + 0.035, hw + 0.008, ztop), 0.006, n=10)
    b.cyl('black', (cs + 0.004, -(hw + 0.008), z_bot - 0.01), (cs + 0.004, hw + 0.008, z_bot - 0.01), 0.005, n=8)
    hc = np.array((cs + 0.018, 0.0, 0.5 * (z_top + z_bot)))
    dv = e - hc; dv /= np.linalg.norm(dv)
    side = np.array((0, 1.0, 0))
    upv = np.cross(dv, side); upv /= np.linalg.norm(upv)
    if upv[2] < 0: upv = -upv
    hh = 0.5 * (z_top - z_bot) / max(upv[2], 0.5)
    c00 = hc - side * hw - upv * hh; c10 = hc + side * hw - upv * hh; c11 = hc + side * hw + upv * hh; c01 = hc - side * hw + upv * hh
    sb = Builder(); sb.quad('s', tuple(c00), tuple(c10), tuple(c11), tuple(c01), uv=lambda fu, fv: (fu, fv))
    scr['screen_hud'] = sb.parts['s']
    # second (rear) combiner plate, faint tinted glass, slightly behind
    off = -dv * 0.012
    b.quad('glass2', tuple(c00 + off), tuple(c10 + off), tuple(c11 + off), tuple(c01 + off))
    # ---------------- side consoles (textured tops), walls
    for key, cfg in (('lcons', CL.CONSOLE_L), ('rcons', CL.CONSOLE_R)):
        s0, s1, yi, yo, z0 = cfg['s0'], cfg['s1'], cfg['y_in'], cfg['y_out'], cfg['z0']
        sg = 1 if yi > 0 else -1
        top = [(s0, yi, z0), (s1, yi, z0), (s1, yo, z0 + 0.012), (s0, yo, z0 + 0.012)]
        rect = tex[key]
        def cuv(fu, fv, rect=rect, sg=sg):
            # u along the console width (inboard->outboard), v along s (front at the top of the texture)
            return atlas_uv(rect, fu, fv)
        # map: along s -> texture v (front = top), across -> u (for the left console outboard at left)
        P = [np.array(p) for p in top]
        verts, faces, uvs = [], [], []
        ns, ny = 6, 2
        for i in range(ns + 1):
            for j in range(ny + 1):
                a, bb = i / ns, j / ny
                p = (1 - bb) * ((1 - a) * P[0] + a * P[1]) + bb * ((1 - a) * P[3] + a * P[2])
                verts.append(tuple(p))
        for i in range(ns):
            for j in range(ny):
                f = (i * (ny + 1) + j, (i + 1) * (ny + 1) + j, (i + 1) * (ny + 1) + j + 1, i * (ny + 1) + j + 1)
                if sg < 0:
                    f = f[::-1]
                faces.append(f)
                cor = []
                for vi in f:
                    ii, jj = divmod(vi, ny + 1)
                    fu = jj / ny if sg < 0 else 1 - jj / ny
                    cor.append(cuv(fu, 1 - ii / ns))
                uvs.append(cor)
        # ensure the console top faces up
        Vt = np.array(verts)
        fixed_f, fixed_uv = [], []
        for f, cor in zip(faces, uvs):
            p = Vt[list(f)]
            if np.cross(p[1] - p[0], p[2] - p[0])[2] < 0:
                f = f[::-1]; cor = cor[::-1]
            fixed_f.append(f); fixed_uv.append(cor)
        b.add_faces('panel', verts, fixed_f, fixed_uv)
        # console body (inner wall down to the floor)
        b.quad('dark', (s0, yi, z0), (s1, yi, z0), (s1, yi, 1.90), (s0, yi, 1.90))
        b.quad('dark', (s0, yi, z0), (s0, yo, z0 + 0.012), (s0, yo, 1.90), (s0, yi, 1.90))
        # knobs and switches on the console
        rng = np.random.default_rng(7 if sg > 0 else 11)
        for k in range(26):
            ss = s0 + 0.08 + rng.random() * (s1 - s0 - 0.16)
            yy = yi + (yo - yi) * (0.15 + 0.7 * rng.random())
            if key == 'rcons' and ss < 4.10:
                continue
            if key == 'lcons' and ss < 4.12 and abs(yy - (-0.31)) < 0.06:
                continue
            if rng.random() < 0.5:
                b.cyl('black', (ss, yy, z0 + 0.006), (ss, yy, z0 + 0.024), 0.007 + 0.004 * rng.random(), n=10)
            else:
                b.cyl('metal', (ss, yy, z0 + 0.006), (ss + 0.004, yy, z0 + 0.022), 0.0022, n=6)
    # ---------------- throttle (left console) with a quadrant slot
    ts, ty, tz = 3.99, -0.305, CL.CONSOLE_L['z0']
    b.box('black', (ts, ty, tz + 0.003), (0.22, 0.030, 0.008))
    b.cyl('metal', (ts + 0.02, ty, tz), (ts - 0.02, ty + 0.01, tz + 0.10), 0.010, n=10)
    b.box('dark', (ts - 0.03, ty + 0.012, tz + 0.125), (0.080, 0.048, 0.060), axes=((1, 0, 0.35), (0, 1, 0), (-0.35, 0, 1)))
    b.box('black', (ts - 0.06, ty + 0.03, tz + 0.15), (0.03, 0.02, 0.02))
    # ---------------- sidestick (right console) + armrest
    ks, ky, kz = 3.975, 0.310, CL.CONSOLE_R['z0']
    b.box('black', (ks, ky, kz + 0.012), (0.09, 0.07, 0.024))
    b.cyl('rubber', (ks, ky, kz + 0.02), (ks - 0.004, ky, kz + 0.05), 0.022, 0.018, n=14)
    grip_axes = ((1, 0, 0.15), (0, 1, 0), (-0.15, 0, 1))
    b.box('dark', (ks - 0.008, ky, kz + 0.105), (0.045, 0.040, 0.11), axes=grip_axes)
    b.box('dark', (ks - 0.02, ky - 0.004, kz + 0.165), (0.06, 0.044, 0.025), axes=grip_axes)
    b.cyl('red', (ks - 0.005, ky, kz + 0.178), (ks - 0.005, ky, kz + 0.186), 0.006, n=8)
    b.box('black', (ks + 0.012, ky - 0.018, kz + 0.14), (0.012, 0.014, 0.018))
    b.box('dark', (4.18, 0.315, kz + 0.035), (0.30, 0.085, 0.05))
    # ---------------- rudder pedals
    for sg in (-1, 1):
        y = sg * 0.115
        b.box('metal', (3.18, y, 2.03), (0.02, 0.07, 0.16), axes=((1, 0, 0.35), (0, 1, 0), (-0.35, 0, 1)))
        b.box('black', (3.20, y, 2.03), (0.012, 0.075, 0.12), axes=((1, 0, 0.35), (0, 1, 0), (-0.35, 0, 1)))
        b.cyl('metal', (3.10, y, 1.95), (3.17, y, 2.02), 0.01, n=8)
    # ---------------- cockpit floor + forward footwell box under the panel, aft bulkhead
    b.quad('dark', (3.05, -0.30, 1.905), (4.95, -0.30, 1.905), (4.95, 0.30, 1.905), (3.05, 0.30, 1.905))
    b.box('dark', (3.43, 0, 2.18), (0.30, 0.50, 0.12))
    b.quad('dark', (4.93, -0.42, 1.90), (4.93, 0.42, 1.90), (4.93, 0.34, 2.60), (4.93, -0.34, 2.60))
    # ---------------- seat
    build_seat(b)
    # ---------------- canopy inner details: rear-view mirrors on the canopy frame sides (move with the canopy)
    for sg in (-1, 1):
        s = 3.66; w = PT.glass_edge_w(s)
        zb = FU.surface_point(s, w) + 0.135
        p = np.array((s, sg * (w - 0.030), zb))
        ax = (np.array((0.94, -sg * 0.34, 0.0)), np.array((sg * 0.34, 0.94, 0.0)), np.array((0, 0, 1.0)))
        b.box('cmirror_frame', tuple(p + np.array((0, sg * 0.014, -0.03))), (0.015, 0.010, 0.05))
        b.box('cmirror_frame', tuple(p), (0.010, 0.066, 0.032), axes=(ax[0], ax[1], ax[2]))
        b.box('cmirror', tuple(p + ax[0] * 0.0055), (0.002, 0.060, 0.027), axes=(ax[0], ax[1], ax[2]))
    # canopy sill rails inside (dark), along the opening
    for sg in (-1, 1):
        pts = []
        for s in np.linspace(3.20, 5.05, 20):
            w = PT.glass_edge_w(s) - 0.02
            pts.append((s, sg * w, FU.surface_point(s, w + 0.02) - 0.005))
        for a, c in zip(pts[:-1], pts[1:]):
            b.quad('dark', a, c, (c[0], c[1] - sg * 0.035, c[2] - 0.01), (a[0], a[1] - sg * 0.035, a[2] - 0.01))
    return b.parts


def build_seat(b):
    """ACES II ejection seat, 30 deg back angle."""
    hs, hy, hz = CL.SEAT_HIP
    ang = CL.SEAT_BACK
    up = np.array((math.sin(ang), 0.0, math.cos(ang)))        # along the back (aft & up)
    fwd = np.array((-math.cos(ang), 0.0, math.sin(ang)))      # perpendicular to the back, toward the pilot
    side = np.array((0.0, 1.0, 0.0))
    H = np.array((hs, 0.0, hz))
    BA = (fwd, side, up)
    # back structure + cushion
    b.box('dark', tuple(H + up * 0.38 - fwd * 0.085), (0.05, 0.44, 0.78), axes=BA)
    b.box('seat', tuple(H + up * 0.33 - fwd * 0.035), (0.06, 0.36, 0.52), axes=BA)
    # parachute container / headbox and the headrest pad
    b.box('dark', tuple(H + up * 0.72 - fwd * 0.115), (0.15, 0.42, 0.30), axes=BA)
    b.box('black', tuple(H + up * 0.745 - fwd * 0.018), (0.06, 0.25, 0.17), axes=BA)
    # side rails up the back (bucket extensions)
    for sg in (-1, 1):
        b.box('dark', tuple(H + up * 0.30 - fwd * 0.06 + side * sg * 0.215), (0.12, 0.03, 0.62), axes=BA)
        # headbox top: drogue gun / pitot booms
        p0 = H + up * 0.86 - fwd * 0.13 + side * sg * 0.15
        b.cyl('metal', tuple(p0), tuple(p0 + up * 0.10 + fwd * 0.02), 0.0055, n=8)
        # seat guide rollers/rails behind
        r0 = H + up * 0.05 - fwd * 0.17 + side * sg * 0.12
        b.cyl('metal', tuple(r0), tuple(r0 + up * 0.80), 0.012, n=8)
    # seat pan (survival kit) + cushion, slightly raised at the front
    pan_axes = ((1, 0, -0.14), (0, 1, 0), (0.14, 0, 1))
    b.box('dark', (hs - 0.20, 0, hz - 0.07), (0.44, 0.42, 0.11), axes=pan_axes)
    b.box('seat', (hs - 0.20, 0, hz - 0.002), (0.40, 0.37, 0.05), axes=pan_axes)
    for sg in (-1, 1):
        # bucket side walls
        b.box('dark', (hs - 0.14, sg * 0.225, hz + 0.02), (0.46, 0.028, 0.20))
        # arm rests / side handles
        b.box('black', (hs - 0.25, sg * 0.228, hz + 0.13), (0.14, 0.035, 0.03))
    # ejection handle (yellow/black loop) at the front of the seat bucket
    for sg in (-1, 1):
        b.cyl('yellow', (hs - 0.405, sg * 0.05, hz - 0.03), (hs - 0.435, sg * 0.05, hz + 0.05), 0.009, n=8)
    b.cyl('yellow', (hs - 0.435, -0.05, hz + 0.05), (hs - 0.435, 0.05, hz + 0.05), 0.009, n=8)
    # harness: shoulder straps over the back cushion, lap belt
    for sg in (-1, 1):
        a = H + up * 0.58 + fwd * 0.0 + side * sg * 0.08
        c = H + up * 0.06 + fwd * 0.03 + side * sg * 0.10
        m = (a + c) / 2 + fwd * 0.012
        b.box('strap', tuple(m), (0.008, 0.045, np.linalg.norm(a - c)), axes=(fwd, side, (a - c)))
        b.box('strap', (hs - 0.08, sg * 0.14, hz + 0.05), (0.05, 0.12, 0.008), axes=((1, 0, 0.3), (0, 1, 0), (-0.3, 0, 1)))
    b.box('metal', (hs - 0.09, 0, hz + 0.065), (0.06, 0.07, 0.015))
