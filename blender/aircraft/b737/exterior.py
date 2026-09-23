"""737-800 exterior airframe: fuselage (with cut flight-deck windows), wings with all movable surfaces,
horizontal/vertical tail. Geometry is generated from shape.py in the ground frame and converted to Blender."""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import shape as S
import mk
from mk import MeshData

TB = S.to_b


# =========================================================================================== FUSELAGE
def fuselage_grid():
    xs = S.fus_stations()
    th = np.linspace(0, 2 * np.pi, S.n_theta(), endpoint=False)
    X, TH = np.meshgrid(xs, th, indexing='ij')
    Y, Z = S.fus_point(X, TH)
    P = TB(X, Y, Z)
    th1 = np.linspace(0, 2 * np.pi, S.n_theta() + 1)
    X1, TH1 = np.meshgrid(xs, th1, indexing='ij')
    u, v = S.fus_uv(X1, TH1)
    # seam at the belly (theta = pi): make v continuous across the ring start (theta=0 -> v=0.5)
    UV = np.stack([u, v], -1)
    # columns crossing the seam: v jumps from ~1 to ~0 between theta<pi and theta>pi; fix per face below
    return xs, th, P, UV


def build_fuselage_md():
    xs, th, P, UV = fuselage_grid()
    ni, nj = P.shape[:2]
    md = MeshData()
    base = 0
    md.v = P.reshape(-1, 3).copy()
    half = nj // 2   # theta index of pi (belly seam)
    for i in range(ni - 1):
        for j in range(nj):
            j1 = (j + 1) % nj
            a, b, c, d = i * nj + j, i * nj + j1, (i + 1) * nj + j1, (i + 1) * nj + j
            uvs = [UV[i, j], UV[i, j + 1], UV[i + 1, j + 1], UV[i + 1, j]]
            if j == half - 1:   # face from theta just below pi to pi: v of the pi column must be 1.0
                uvs[1] = (uvs[1][0], 1.0); uvs[2] = (uvs[2][0], 1.0)
            uvs = [tuple(x) for x in uvs]
            # orientation: rows go aft (-Y blender), theta goes top -> right -> bottom: normal = d(theta) x d(X)
            md.f.append([a, d, c, b]); md.uv.extend([uvs[0], uvs[3], uvs[2], uvs[1]])
            md.mi.append(0); md.sharp.append(False)
    # tail cap: APU exhaust pipe (dark material slot 1)
    last = [(ni - 1) * nj + j for j in range(nj)]
    ring = P[-1]
    c = ring.mean(0)
    inner1 = c + (ring - c) * 0.80
    inner2 = inner1 + np.array([0, 0.45, 0])
    b1 = md.nv
    md.v = np.vstack([md.v, inner1, inner2, c[None] + np.array([0, 0.45, 0])])
    for j in range(nj):
        j1 = (j + 1) % nj
        md.f.append([last[j], last[j1], b1 + j1, b1 + j]); md.uv.extend([(0.99, 0.5)] * 4); md.mi.append(1); md.sharp.append(False)
        md.f.append([b1 + j, b1 + j1, b1 + nj + j1, b1 + nj + j]); md.uv.extend([(0.99, 0.5)] * 4); md.mi.append(1); md.sharp.append(False)
        md.f.append([b1 + nj + j, b1 + nj + j1, b1 + 2 * nj]); md.uv.extend([(0.99, 0.5)] * 3); md.mi.append(1); md.sharp.append(False)
    return md


def _poly_inside(pt, poly):
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xi:
                inside = not inside
    return inside


def round_poly(poly, r, n=4):
    """Round the corners of a convex polygon (list of 2D points) with radius r."""
    P = np.asarray(poly, float)
    out = []
    m = len(P)
    for i in range(m):
        p0, p1, p2 = P[i - 1], P[i], P[(i + 1) % m]
        a = p0 - p1; b = p2 - p1
        la, lb = np.linalg.norm(a), np.linalg.norm(b)
        a /= la; b /= lb
        ang = math.acos(np.clip(np.dot(a, b), -1, 1))
        d = min(r / math.tan(ang / 2), la * 0.45, lb * 0.45)
        rr = d * math.tan(ang / 2)
        s = p1 + a * d; e = p1 + b * d
        bis = (a + b); bis /= np.linalg.norm(bis)
        cen = p1 + bis * (rr / math.sin(ang / 2))
        a0 = math.atan2(*(s - cen)[::-1]); a1 = math.atan2(*(e - cen)[::-1])
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(n + 1):
            t = a0 + da * k / n
            out.append(cen + rr * np.array([math.cos(t), math.sin(t)]))
    return np.array(out)


class Window:
    """A window: 2D polygon in a projection. proj(Pb) -> 2D coords, axis = projection direction (blender),
    side_ok(center_b, normal_b) filters which surface patch is cut."""

    def __init__(self, name, poly, kind, side):
        self.name, self.kind, self.side = name, kind, side
        self.poly = round_poly(poly, S.WIN_CORNER_R, 4 if S.Q > 0.6 else 1)

    def proj(self, P):
        P = np.asarray(P, float)
        X, Y, Z = S.from_b(P)
        if self.kind == 'side':
            return np.stack([X, Z], -1)
        return np.stack([Y * self.side, Z], -1)

    def to3(self, q, depth):
        """2D point + position along the projection axis (ground Y for side, ground X for front) -> blender."""
        if self.kind == 'side':
            return TB(q[0], depth * self.side, q[1])
        return TB(depth, q[0] * self.side, q[1])

    @property
    def axis(self):
        return np.array([self.side, 0, 0]) if self.kind == 'side' else np.array([0, 1.0, 0])   # outward-ish

    def side_ok(self, c, n):
        X, Y, Z = S.from_b(np.asarray(c))
        if Y * self.side < 0.02:
            return False
        if self.kind == 'side':
            return n[0] * self.side > 0.25 and Z > 3.2
        return n[1] > 0.10 and Z > 3.3 and X < 3.3


def cockpit_windows():
    wins = []
    for side, sfx in ((1, 'R'), (-1, 'L')):
        wins.append(Window('W1' + sfx, S.WIN_W1, 'front', side))
        wins.append(Window('W2' + sfx, S.WIN_W2, 'side', side))
        wins.append(Window('W3' + sfx, S.WIN_W3, 'side', side))
    return wins


def cut_windows(bm, windows, margin=0.25, on_inside=None):
    """Bisect the mesh along each window edge (locally) and delete the faces inside each window right away
    (later windows' bisects would otherwise split already-collected faces). on_inside(name, faces) is called
    before deletion (e.g. to copy the glass). Returns {window: face count}."""
    result = {}
    for w in windows:
        poly = w.poly
        lo, hi = poly.min(0) - margin, poly.max(0) + margin
        region = set()
        for f in bm.faces:
            c = f.calc_center_median()
            q = w.proj(np.array(c))
            if lo[0] < q[0] < hi[0] and lo[1] < q[1] < hi[1] and w.side_ok(c, f.normal):
                region.add(f)
        n = len(poly)
        for k in range(n):
            a, b = poly[k], poly[(k + 1) % n]
            A3 = w.to3(a, 0.0); B3 = w.to3(b, 0.0)
            e = B3 - A3
            no = np.cross(e, w.axis if w.kind == 'side' else np.array([0, 1.0, 0]))
            if np.linalg.norm(no) < 1e-9:
                continue
            no /= np.linalg.norm(no)
            mid = (a + b) / 2
            rad = np.linalg.norm(b - a) / 2 + 0.10
            near = []
            for f in region:
                if not f.is_valid:
                    continue
                q = w.proj(np.array(f.calc_center_median()))
                if np.linalg.norm(q - mid) < rad + 0.08:
                    near.append(f)
            if not near:
                continue
            geom = set()
            for f in near:
                geom.add(f)
                geom.update(f.edges)
                geom.update(f.verts)
            res = bmesh.ops.bisect_plane(bm, geom=list(geom), plane_co=Vector(A3), plane_no=Vector(no))
            newv = [g for g in res['geom_cut'] if isinstance(g, bmesh.types.BMVert)]
            # refresh region: keep valid faces, add faces touching new verts
            region = {f for f in region if f.is_valid}
            for v in newv:
                region.update(v.link_faces)
        bm.normal_update()
        inside = []
        for f in region:
            if not f.is_valid:
                continue
            c = f.calc_center_median()
            q = w.proj(np.array(c))
            if _poly_inside(q, poly) and w.side_ok(c, f.normal):
                inside.append(f)
        if on_inside:
            on_inside(w.name, inside)
        result[w.name] = len(inside)
        bmesh.ops.delete(bm, geom=list(set(inside)), context='FACES_ONLY')
    return result


def offset_inner_md(md_src, thickness, xmin, xmax):
    """Inner shell: faces of the fuselage grid between stations xmin..xmax, offset inward (normals flipped)."""
    xs, th, P, UV = fuselage_grid()
    sel = np.where((xs >= xmin - 1e-6) & (xs <= xmax + 1e-6))[0]
    Pn = P[sel]
    # 3D normals by finite differences on the grid
    dX = np.gradient(Pn, axis=0)
    dT = np.roll(Pn, -1, axis=1) - np.roll(Pn, 1, axis=1)
    N = np.cross(dT, dX)
    N /= np.linalg.norm(N, axis=-1, keepdims=True) + 1e-12
    # ensure outward
    c = Pn.mean(axis=1, keepdims=True)
    sgn = np.sign(np.sum((Pn - c) * N, axis=-1, keepdims=True))
    N *= np.where(sgn == 0, 1, sgn)
    Pi = Pn - N * thickness
    ni, nj = Pi.shape[:2]
    md = MeshData()
    md.v = Pi.reshape(-1, 3).copy()
    for i in range(ni - 1):
        for j in range(nj):
            j1 = (j + 1) % nj
            a, b, cc, d = i * nj + j, i * nj + j1, (i + 1) * nj + j1, (i + 1) * nj + j
            md.f.append([a, b, cc, d])   # inward-facing (opposite of the skin)
            X0 = xs[sel[i]]
            md.uv.extend([(X0, th[j] / (2 * np.pi)), (X0, (j + 1) / nj), (xs[sel[i + 1]], (j + 1) / nj), (xs[sel[i + 1]], th[j] / (2 * np.pi))])
            md.mi.append(0); md.sharp.append(False)
    return md


def bm_from_md(md):
    me = mk.to_mesh('_tmp', md)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    return bm


def reveal_strips(windows, bvh_out, bvh_in, step=None, glass_depth=0.012, max_depth=0.30):
    step = step or (0.02 / S.Q)
    """Window reveal (frame depth) quads between the outer skin and the inner shell, plus glass panes."""
    reveal = MeshData()
    for w in windows:
        poly = w.poly
        pts = []
        n = len(poly)
        for k in range(n):
            a, b = poly[k], poly[(k + 1) % n]
            L = np.linalg.norm(b - a)
            m = max(1, int(L / step))
            for t in range(m):
                pts.append(a + (b - a) * t / m)
        outer, inner = [], []
        for q in pts:
            if w.kind == 'side':
                o = w.to3(q, 3.0)
                d = np.array([-w.side, 0, 0])
            else:
                o = w.to3(q, -2.0)
                d = np.array([0, -1.0, 0])
            ho = bvh_out.ray_cast(Vector(o), Vector(d))
            hi = bvh_in.ray_cast(Vector(o), Vector(d))
            if ho[0] is None or hi[0] is None or (hi[0] - ho[0]).length > max_depth:
                outer.append(None); inner.append(None)
                continue
            outer.append(np.array(ho[0])); inner.append(np.array(hi[0]))
        m = len(pts)
        for k in range(m):
            k1 = (k + 1) % m
            if outer[k] is None or outer[k1] is None:
                continue
            quad = [outer[k], outer[k1], inner[k1], inner[k]]
            reveal.add(np.array(quad), [[0, 1, 2, 3]], [(0.5, 0.5)] * 4, mat=0)
    return mk.orient_outward(reveal) if False else reveal


def inner_shell_from_cut(bm, xmin, xmax, thickness, bvh=None):
    """Copy the cut skin faces with stations in [xmin, xmax], offset them inwards along the vertex normals and
    flip them (inner lining). Window hole edges are bridged to their offset copies (reveal strips)."""
    faces = []
    for f in bm.faces:
        X = S.from_b(np.array(f.calc_center_median()))[0]
        if xmin <= X <= xmax:
            faces.append(f)
    fset = set(faces)
    vmap = {}
    V_out, V_in = [], []
    for f in faces:
        for v in f.verts:
            if v.index not in vmap:
                vmap[v.index] = len(V_out)
                co = np.array(v.co); n = np.array(v.normal)
                if bvh is not None:
                    hit = bvh.find_nearest(v.co)
                    if hit[1] is not None:
                        n = np.array(hit[1])
                V_out.append(co); V_in.append(co - n * thickness)
    bm.verts.index_update()
    shell = MeshData()
    shell.v = np.array(V_in)
    for f in faces:
        idx = [vmap[v.index] for v in f.verts][::-1]
        shell.f.append(idx); shell.uv.extend([(0.5, 0.5)] * len(idx)); shell.mi.append(0); shell.sharp.append(False)
    rev = MeshData()
    for f in faces:
        for e in f.edges:
            other = [g for g in e.link_faces if g is not f]
            if other and other[0] in fset:
                continue
            if other:           # boundary of the selected band (fore/aft cut), not a window
                continue
            mid = (np.array(e.verts[0].co) + np.array(e.verts[1].co)) / 2
            Xm = S.from_b(mid)[0]
            if Xm < xmin + 0.03 or Xm > xmax - 0.03:
                continue
            # edge order as used by face f (so the reveal faces the hole)
            vs = list(f.verts)
            i0 = vs.index(e.verts[0]); i1 = vs.index(e.verts[1])
            a, b = (e.verts[0], e.verts[1]) if (i1 - i0) % len(vs) == 1 else (e.verts[1], e.verts[0])
            ia, ib = vmap[a.index], vmap[b.index]
            quad = [V_out[ia], V_out[ib], V_in[ib], V_in[ia]]
            rev.add(np.array(quad)[::-1], [[0, 1, 2, 3]], [(0.5, 0.5)] * 4, mat=0)
    return shell, rev


def build_fuselage(mats, interior_parent=None, mats_interior=None):
    """Returns (fuselage_obj, glass_obj, inner_shell_obj)."""
    md = build_fuselage_md()
    uncut = mk.obj('_fus_uncut', md, [mats['fuselage'], mats['exhaust']])
    bm = bm_from_md(md)
    wins = cockpit_windows()
    # glass: copy the faces inside each window (inset 12 mm) before they are deleted from the skin
    glass = MeshData()

    def take_glass(name, faces):
        for f in set(faces):
            vs = [np.array(v.co) - np.array(f.normal) * 0.012 for v in f.verts]
            glass.add(np.array(vs), [list(range(len(vs)))], [(0.5, 0.5)] * len(vs), mat=0)
    counts = cut_windows(bm, wins, on_inside=take_glass)
    print('window faces', counts)
    # ---- flight-deck inner shell = the cut skin (X 1.30..4.75) offset inwards; window reveals bridge the hole edges
    bm.normal_update()
    bvh_u = BVHTree.FromObject(uncut, bpy.context.evaluated_depsgraph_get())
    shell_md, rev = inner_shell_from_cut(bm, 1.30, 4.75, 0.085, bvh_u)
    import gear
    wells_md = gear.cut_wells(bm, uncut)
    me = bpy.data.meshes.new('fuselage')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mats['fuselage']); me.materials.append(mats['exhaust'])
    fus = bpy.data.objects.new('fuselage', me)
    bpy.context.scene.collection.objects.link(fus)
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    # smooth normals from the uncut surface
    mod = fus.modifiers.new('nt', 'DATA_TRANSFER')
    mod.object = uncut
    mod.use_loop_data = True
    mod.data_types_loops = {'CUSTOM_NORMAL'}
    mod.loop_mapping = 'POLYINTERP_NEAREST'
    with bpy.context.temp_override(object=fus, active_object=fus, selected_objects=[fus]):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # glass object (weld duplicates)
    gl = mk.obj('glass_cockpit', glass, [mats['glass']])
    bmg = bmesh.new(); bmg.from_mesh(gl.data)
    bmesh.ops.remove_doubles(bmg, verts=bmg.verts, dist=1e-5)
    bmg.to_mesh(gl.data); bmg.free()
    gl.data.polygons.foreach_set('use_smooth', np.ones(len(gl.data.polygons), bool))
    shell = mk.obj('flightdeck_shell', shell_md, [mats_interior['trim'] if mats_interior else mats['fuselage']], smooth=True)
    rev_o = mk.obj('_reveal', rev, [mats['frame']], smooth=False)
    wells = mk.obj('wheel_wells', wells_md, [mats['well']], smooth=False)
    bpy.data.objects.remove(uncut)
    return fus, gl, shell, rev_o, wells


# =========================================================================================== LIFTING SURFACES
def stations_between(l0, l1, step, breaks=()):
    step = step / S.Q
    pts = set([l0, l1])
    n = max(1, int(math.ceil((l1 - l0) / step)))
    for k in range(n + 1):
        pts.add(l0 + (l1 - l0) * k / n)
    for b in breaks:
        if l0 < b < l1:
            pts.add(b)
    arr = np.array(sorted(pts))
    # remove near-duplicates
    keep = [arr[0]]
    for x in arr[1:]:
        if x - keep[-1] > 0.02:
            keep.append(x)
        else:
            keep[-1] = x if x in breaks else keep[-1]
    return np.array(keep)


def tdist(n, t0, t1, cluster='le'):
    k = np.arange(n + 1) / n
    if cluster == 'le':
        f = 1 - np.cos(k * np.pi / 2)
    elif cluster == 'both':
        f = 0.5 - 0.5 * np.cos(k * np.pi)
    else:
        f = k
    return t0 + (t1 - t0) * f


def surf_scalar(st, i):
    return {k: (v[i] if isinstance(v, np.ndarray) else v) for k, v in st.items()}


class Surface:
    """A lifting surface definition: station function, point function, uv function."""

    def __init__(self, station_fn, uv_fn, mirror_sign=1):
        self.station = station_fn
        self.uv = uv_fn

    def pts(self, l, t, upper):
        st = self.station(np.array([l]))
        st = surf_scalar(st, 0)
        x2, y2 = S.airfoil(t, st['tc'], st['camber'], upper)
        X, Y, Z = S.section_to_3d(st, x2, y2)
        return np.stack([X, Y, Z], -1), st

    def sec(self, l):
        return surf_scalar(self.station(np.array([l])), 0)

    def point2(self, st, x2, y2):
        X, Y, Z = S.section_to_3d(st, np.asarray(x2, float), np.asarray(y2, float))
        return np.stack([X, Y, Z], -1)


def ring_fixed(surf, l, t_end, N=S.qn(44, 12), te_full=False):
    """Section ring: upper t_end->0, lower 0->t_end. Returns (pts ground (M,3), uv (M,2), is_closing_last)."""
    st = surf.sec(l)
    tu = tdist(N, 0.0, t_end, 'le')[::-1]
    tl = tdist(N, 0.0, t_end, 'le')[1:]
    pu, _ = surf.pts(l, tu, True)
    pl, _ = surf.pts(l, tl, False)
    P = np.vstack([pu, pl])
    uu, vu = surf.uv(l, tu, True, st['c'])
    ul, vl = surf.uv(l, tl, False, st['c'])
    UV = np.stack([np.concatenate([np.broadcast_to(uu, tu.shape), np.broadcast_to(ul, tl.shape)]),
                   np.concatenate([vu, vl])], -1)
    return P, UV


def ring_chunk(surf, l, ta, tb, N=14, nose=True, te=False, nose_scale=(0.92, 0.9)):
    """Control-surface chunk ring between chord fractions ta..tb with a rounded nose at ta.
    Order: upper tb->ta, nose arc, lower ta->tb."""
    st = surf.sec(l)
    t = tdist(N, ta, tb, 'none')
    tu = t[::-1]
    pu, _ = surf.pts(l, tu, True)
    pl, _ = surf.pts(l, t, False)
    uu, vu = surf.uv(l, tu, True, st['c'])
    ul, vl = surf.uv(l, t, False, st['c'])
    # nose arc in section coords
    x_u, y_u = S.airfoil(np.array([ta]), st['tc'], st['camber'], True)
    x_l, y_l = S.airfoil(np.array([ta]), st['tc'], st['camber'], False)
    ym = (y_u[0] + y_l[0]) / 2
    hh = (y_u[0] - y_l[0]) / 2 * nose_scale[1]
    a = hh * nose_scale[0] * 1.6
    arc = []
    arcuv = []
    if nose:
        na = 7
        for k in range(1, na):
            al = math.pi * k / na
            arc.append((ta - a * math.sin(al), ym + hh * math.cos(al)))
            arcuv.append((vu[-1] if k <= na // 2 else vl[0]))
    parts = [pu]
    uvv = [vu]
    if arc:
        arc = np.array(arc)
        pa = surf.point2(st, arc[:, 0], arc[:, 1])
        parts.append(pa)
        uvv.append(np.array(arcuv))
    parts.append(pl)
    uvv.append(vl)
    P = np.vstack(parts)
    V = np.concatenate(uvv)
    U = np.full(len(V), float(np.atleast_1d(uu)[0]))
    return P, np.stack([U, V], -1), st


def loft_rings(rings, uvs, wrap=True, closing_mat=None, mat=0, cap_start=False, cap_end=False, md=None):
    """rings: list of (M,3) ground-frame arrays (same M). Returns MeshData in blender coords."""
    md = md or MeshData()
    P = np.array([TB(r[:, 0], r[:, 1], r[:, 2]) for r in rings])
    UV = np.array(uvs)
    ni, nj = P.shape[:2]
    UVw = np.concatenate([UV, UV[:, :1]], axis=1)
    base_f = len(md.f)
    base_v = md.nv
    mk.grid(P, UVw, wrap=wrap, mat=mat, md=md)
    if closing_mat is not None and wrap:
        ncol = nj
        for i in range(ni - 1):
            md.mi[base_f + i * ncol + (nj - 1)] = closing_mat
            md.sharp[base_f + i * ncol + (nj - 1)] = True
    if cap_start:
        mk.cap(md, [base_v + j for j in range(nj)], mat=closing_mat if closing_mat is not None else mat)
    if cap_end:
        mk.cap(md, [base_v + (ni - 1) * nj + j for j in range(nj)], mat=closing_mat if closing_mat is not None else mat)
    return md


def wing_surface():
    return Surface(S.wing_station, S.wing_uv)


def stab_surface():
    def uvf(l, t, upper, c):
        st = S.stab_station(np.atleast_1d(l))
        u = np.asarray(l, float) / (S.S_LEND + 0.05)
        d = S.airfoil_arc(t, upper) * c
        v = 0.5 + np.where(upper, d, -d) / (2 * 4.6)
        return u, v
    return Surface(S.stab_station, uvf)


def wing_breaks():
    ys = [1.0, 1.95, S.W_YKINK, S.W_YKINK + 0.02, 12.50, 12.54, 16.10, 16.12, S.ENGINE_Y - 0.25, S.ENGINE_Y + 0.25]
    for a, b in S.W_SPOILERS + S.W_SLATS + S.W_KRUEGER:
        ys += [a, b]
    return [S.wing_l_of_Y(y) for y in ys]


def build_wing_fixed(side, mats):
    """Fixed wing structure for one side (blender MeshData, not yet an object)."""
    surf = wing_surface()
    md = MeshData()
    l_ail_end = S.wing_l_of_Y(16.12)
    ls = stations_between(0.0, l_ail_end, 0.30, wing_breaks())
    rings, uvs = [], []
    for l in ls:
        st = surf.sec(l)
        tcut = float(S.wing_tcut(st['Y'], st))
        P, UV = ring_fixed(surf, l, tcut, N=S.qn(44, 12))
        rings.append(P); uvs.append(UV)
    loft_rings(rings, uvs, closing_mat=1, md=md)
    # tip + winglet (full chord)
    ls2 = np.concatenate([stations_between(l_ail_end, S.W_LA, 0.2), stations_between(S.W_LA, S.W_LB, 0.10)[1:],
                          stations_between(S.W_LB, S.W_LEND, 0.16)[1:]])
    rings, uvs = [], []
    for l in ls2:
        P, UV = ring_fixed(surf, l, 1.0, N=S.qn(44, 12))
        rings.append(P); uvs.append(UV)
    # rounded tip: shrink thickness towards the chord line in 3 extra rings
    st = surf.sec(S.W_LEND)
    tdir = np.array([0, math.cos(S.W_PHI_END), math.sin(S.W_PHI_END)])
    last = rings[-1]
    mid = None
    NN = S.qn(44, 12)
    tu = tdist(NN, 0, 1, 'le')[::-1]; tl = tdist(NN, 0, 1, 'le')[1:]
    x2 = np.concatenate([tu, tl])
    _, yu = S.airfoil(tu, st['tc'], st['camber'], True)
    _, yl = S.airfoil(tl, st['tc'], st['camber'], False)
    _, ycu = S.airfoil(tu, 0.0, st['camber'], True)
    _, ycl = S.airfoil(tl, 0.0, st['camber'], False)
    y2 = np.concatenate([yu, yl]); yc = np.concatenate([ycu, ycl])
    for s_, ext in ((0.7, 0.012), (0.35, 0.022), (0.0, 0.026)):
        yy = yc + (y2 - yc) * s_
        P = surf.point2(st, x2, yy) + tdir[None] * ext
        rings.append(P); uvs.append(uvs[-1])
    loft_rings(rings, uvs, closing_mat=None, cap_start=True, md=md)
    md.mi = [m if m is not None else 0 for m in md.mi]
    return md


def weld(obj, dist=1e-5):
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    bm.to_mesh(obj.data); bm.free()


def mirror_md(md):
    m = md.copy()
    m.mirror_x()
    return m


def hinge_frame_ground(pa, pb, zref=(0, 0, 1)):
    """Hinge matrix (blender) from two ground-frame points; x axis from pa to pb, oriented to +X blender."""
    A = TB(*pa); B = TB(*pb)
    d = B - A
    if d[0] < 0 and abs(d[0]) > abs(d[2]):
        A, B = B, A
        d = -d
    return mk.hinge_matrix(A, d, zref)


def te_surface(surf, name_base, side, l0, l1, t_fn, parts, mats, mat_key, nsp=None):
    """Trailing-edge control surface(s) between arc-lengths l0..l1.
    parts: list of (name_suffix, fa, fb) fractions of the chunk [tcut..1]: e.g. [('', 0, 1)].
    Returns dict name->(MeshData world blender, hinge points ground (inboard, outboard))."""
    ls = stations_between(l0, l1, 0.35 if nsp is None else nsp)
    out = {}
    for suffix, fa, fb in parts:
        rings, uvs = [], []
        for l in ls:
            st = surf.sec(l)
            tcut = t_fn(st)
            ta = tcut + (1 - tcut) * fa
            tb = tcut + (1 - tcut) * fb
            P, UV, _ = ring_chunk(surf, l, ta, tb, N=S.qn(14, 5) if fb - fa > 0.3 else S.qn(8, 4))
            rings.append(P); uvs.append(UV)
        md = loft_rings(rings, uvs, cap_start=True, cap_end=True, mat=0)
        mk.orient_outward(md)
        # hinge points: nose centre at the two ends
        hp = []
        for l in (ls[0], ls[-1]):
            st = surf.sec(l)
            tcut = t_fn(st)
            ta = tcut + (1 - tcut) * fa
            _, yu = S.airfoil(np.array([ta]), st['tc'], st['camber'], True)
            _, yl = S.airfoil(np.array([ta]), st['tc'], st['camber'], False)
            p = surf.point2(st, np.array([ta]), np.array([(yu[0] + yl[0]) / 2]))[0]
            hp.append(p)
        out[suffix] = (md, hp)
    return out


def _mirror_pt(p):
    return np.array([p[0], -p[1], p[2]])


def make_pivot(name, md_ground_right, hp_right, side, mats, zref=(0, 0, 1), parent=None, smooth=True):
    """md is blender-coords MeshData for the right side; create L or R object with hinge frame."""
    md = md_ground_right.copy()
    hp = [np.asarray(p, float) for p in hp_right]
    if side < 0:
        md.mirror_x()
        hp = [_mirror_pt(p) for p in hp]
    M = hinge_frame_ground(hp[0], hp[1], zref)
    return mk.obj(name, md, mats, matrix=M, parent=parent, smooth=smooth, sharp_angle=50)


def spoiler_md(surf, y0, y1):
    l0, l1 = S.wing_l_of_Y(y0), S.wing_l_of_Y(y1)
    ls = stations_between(l0, l1, 0.4)
    rings, uvs = [], []
    for l in ls:
        st = surf.sec(l)
        xc = float(S.wing_xcut(st['Y']))
        xa, xb = xc - S.W_SPOILER_CHORD, xc + 0.03
        t = (np.linspace(xa, xb, 7) - st['X']) / st['c']
        top, _ = surf.pts(l, t[::-1], True)
        nrm = np.array([0, -math.sin(st['phi']), math.cos(st['phi'])])
        top = top + nrm * 0.008
        bot = top[::-1] - nrm * 0.035
        # taper the trailing edge thickness
        bot[-1] = top[0] - nrm * 0.004
        bot[-2] = (bot[-2] + top[1]) / 2
        P = np.vstack([top, bot])
        uu, vv = surf.uv(l, t[::-1], True, st['c'])
        UV = np.stack([np.full(len(P), float(np.atleast_1d(uu)[0])), np.concatenate([vv, vv[::-1]])], -1)
        rings.append(P); uvs.append(UV)
    md = loft_rings(rings, uvs, cap_start=True, cap_end=True)
    mk.orient_outward(md)
    hp = []
    for l in (ls[0], ls[-1]):
        st = surf.sec(l)
        xc = float(S.wing_xcut(st['Y']))
        t = np.array([(xc - S.W_SPOILER_CHORD - st['X']) / st['c']])
        p, _ = surf.pts(l, t, True)
        hp.append(p[0])
    return md, hp


def slat_md(surf, y0, y1, t_up=S.W_SLAT_T, t_lo=0.035, krueger=False):
    l0, l1 = S.wing_l_of_Y(y0), S.wing_l_of_Y(y1)
    ls = stations_between(l0, l1, 0.3)
    rings, uvs = [], []
    for l in ls:
        st = surf.sec(l)
        nrm_b = None
        if not krueger:
            tu = tdist(12, 0, t_up, 'le')[::-1]
            tl = tdist(5, 0, t_lo, 'le')[1:]
            pu, _ = surf.pts(l, tu, True)
            pl, _ = surf.pts(l, tl, False)
            outer = np.vstack([pu, pl])
            # offset outward from the section centre line
            cen = surf.point2(st, np.array([0.25]), np.array([0.0]))[0]
            d = outer - cen
            # move outward along the local 2D normal approx: push away from the chord line point nearest
            outer_off = []
            allp = outer
            for k in range(len(allp)):
                a = allp[max(k - 1, 0)]; b = allp[min(k + 1, len(allp) - 1)]
                tan = b - a
                sp = np.array([0, math.cos(st['phi']), math.sin(st['phi'])])
                n = np.cross(tan, sp)
                n /= np.linalg.norm(n) + 1e-12
                outer_off.append(n)
            N = np.array(outer_off)
            # make normals point away from the airfoil interior
            chk = np.sum(N * (allp - cen), axis=1)
            N *= np.sign(chk)[:, None]
            o = allp + N * 0.008
            i = allp - N * 0.03
            i[0] = o[0] - N[0] * 0.006
            P = np.vstack([o, i[::-1]])
            uu, vu = surf.uv(l, tu, True, st['c'])
            ul, vl = surf.uv(l, tl, False, st['c'])
            V = np.concatenate([vu, vl])
            UV = np.stack([np.full(len(P), float(np.atleast_1d(uu)[0])), np.concatenate([V, V[::-1]])], -1)
        else:
            tl = np.linspace(0.02, 0.16, 7)
            pl, _ = surf.pts(l, tl, False)
            nrm = -np.array([0, -math.sin(st['phi']), math.cos(st['phi'])])
            o = pl + nrm * 0.006
            i = pl - nrm * 0.02
            P = np.vstack([o, i[::-1]])
            uu, vl = surf.uv(l, tl, False, st['c'])
            UV = np.stack([np.full(len(P), float(np.atleast_1d(uu)[0])), np.concatenate([vl, vl[::-1]])], -1)
        rings.append(P); uvs.append(UV)
    md = loft_rings(rings, uvs, cap_start=True, cap_end=True)
    mk.orient_outward(md)
    hp = []
    for l in (ls[0], ls[-1]):
        st = surf.sec(l)
        if krueger:
            p, _ = surf.pts(l, np.array([0.02]), False)
        else:
            p, _ = surf.pts(l, np.array([t_up]), True)
        hp.append(p[0])
    return md, hp


def canoe_md(Yc, x0, x1, xcut, depth=0.46, width=0.36, part='front'):
    """Flap-track fairing under the wing at span Yc (ground frame). part: 'front' (x0..xcut) or 'aft'."""
    surf = wing_surface()
    l = S.wing_l_of_Y(Yc)
    st = surf.sec(l)
    # lower surface height along x
    xs_all = np.linspace(x0, x1, 40)
    def zlow(x):
        t = np.clip((x - st['X']) / st['c'], 0, 1)
        p, _ = surf.pts(l, np.atleast_1d(t), False)
        return p[:, 2], p[:, 1]
    if part == 'front':
        xs = np.linspace(x0, xcut + 0.05, S.qn(16, 6))
    else:
        xs = np.linspace(xcut - 0.10, x1, S.qn(16, 6))
    n = S.qn(14, 8)
    rings = []
    for x in xs:
        s = (x - x0) / (x1 - x0)
        # body: depth profile peaks around 70 %
        dep = depth * (np.sin(np.pi * np.clip(s, 0, 1) ** 0.75) ** 0.8) + 0.02
        wid = width * (np.sin(np.pi * np.clip(s, 0, 1) ** 0.6) ** 0.6) / 2 + 0.01
        zl, yl = zlow(np.array([min(x, st['X'] + st['c'] * 0.999)]))
        ztop = zl[0] + 0.05
        if x > st['X'] + st['c']:
            ztop = zl[0] - 0.06 * (x - st['X'] - st['c'])
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            yy = Yc + wid * math.sin(a)
            zz = ztop - dep * (0.5 - 0.5 * math.cos(a)) if True else 0
            ring.append((x, yy, ztop - dep * (1 - math.cos(a)) / 2 * 1.0))
        rings.append(np.array(ring))
    uvs = [np.full((n, 2), 0.5) for _ in rings]
    md = loft_rings(rings, uvs, cap_start=True, cap_end=True)
    mk.orient_outward(md)
    return md


# =========================================================================================== TAIL
def build_fin_md(part='fixed'):
    """Vertical fin. part: 'fixed' (sections cut at the rudder hinge within the rudder span) or 'rudder'."""
    md = MeshData()
    N = S.qn(40, 10)
    def sec_pts(Z, xa, xb, nose=False, te=True):
        st = S.fin_station(np.array([Z]))
        st = surf_scalar(st, 0)
        if nose:
            xs = np.linspace(xa, xb, 12)
        else:
            k = np.arange(N + 1) / N
            xs = xa + (xb - xa) * (1 - np.cos(k * np.pi / 2))
        y = S.fin_half_thickness(st, xs)
        right = np.stack([xs[::-1], y[::-1], np.full_like(xs, Z)], -1)
        left = np.stack([xs[1:], -y[1:], np.full_like(xs[1:], Z)], -1)
        if nose:
            # rounded nose at xa inside the fin cove
            hh = float(S.fin_half_thickness(st, np.array([xa]))[0]) * 0.9
            arc = []
            for k in range(1, 7):
                al = math.pi * k / 7
                arc.append((xa - hh * 1.3 * math.sin(al), hh * math.cos(al), Z))
            left = np.stack([xs, -y, np.full_like(xs, Z)], -1)
            P = np.vstack([right, np.array(arc), left])
            ur, vr = S.fin_uv(right[:, 0], Z, True, st)
            ul, vl = S.fin_uv(left[:, 0], Z, False, st)
            ua = np.concatenate([np.full(3, ur[-1]), np.full(3, ul[0])])
            U = np.concatenate([ur, ua, ul]); V = np.full(len(P), float(vr))
            return P, np.stack([U, V], -1)
        P = np.vstack([right, left])
        ur, vr = S.fin_uv(right[:, 0], Z, True, st)
        ul, vl = S.fin_uv(left[:, 0], Z, False, st)
        U = np.concatenate([ur, ul]); V = np.full(len(P), float(vr))
        return P, np.stack([U, V], -1)

    if part == 'fixed':
        zs1 = np.concatenate([np.linspace(S.F_Z0, 5.0, 5), np.linspace(5.0, 6.6, 14)[1:], np.linspace(6.6, S.F_RUDDER[1], 18)[1:]])
        zs1 = np.unique(np.concatenate([zs1, [S.F_RUDDER[0]]]))
        rings, uvs = [], []
        for Z in zs1:
            st = surf_scalar(S.fin_station(np.array([Z])), 0)
            xb = float(S.fin_xcut(Z)) if Z >= S.F_RUDDER[0] - 1e-6 else st['xte']
            if Z < S.F_RUDDER[0] - 1e-6:
                xb = st['xte']
            P, UV = sec_pts(Z, st['xle'], xb)
            rings.append(P); uvs.append(UV)
        # sections below the rudder use the full chord: we need equal ring sizes -> they are (same N)
        loft_rings(rings, uvs, closing_mat=1, md=md)
        zs2 = np.linspace(S.F_RUDDER[1], S.F_Z1 - 0.001, 8)
        rings, uvs = [], []
        for Z in zs2:
            st = surf_scalar(S.fin_station(np.array([Z])), 0)
            P, UV = sec_pts(Z, st['xle'], st['xte'])
            rings.append(P); uvs.append(UV)
        # tip closure
        c = rings[-1].mean(0)
        md2 = loft_rings(rings, uvs, cap_start=True, cap_end=True)
        md.merge(md2)
        mk.orient_outward(md)
        return md
    # rudder
    zs = np.linspace(S.F_RUDDER[0] + 0.01, S.F_RUDDER[1] - 0.01, S.qn(16, 6))
    rings, uvs = [], []
    for Z in zs:
        st = surf_scalar(S.fin_station(np.array([Z])), 0)
        P, UV = sec_pts(Z, float(S.fin_xcut(Z)), st['xte'], nose=True)
        rings.append(P); uvs.append(UV)
    md = loft_rings(rings, uvs, cap_start=True, cap_end=True, md=md)
    mk.orient_outward(md)
    Za, Zb = zs[0], zs[-1]
    hp = [np.array([float(S.fin_xcut(Za)), 0.0, Za]), np.array([float(S.fin_xcut(Zb)), 0.0, Zb])]
    return md, hp


def build_stab_fixed():
    surf = stab_surface()
    md = MeshData()
    le0, le1 = S.S_ELEV[0] / math.cos(S.S_DIHEDRAL), S.S_ELEV[1] / math.cos(S.S_DIHEDRAL)
    # root part (full chord, inside tail cone), elevator span (cut), tip (full chord)
    ls = stations_between(0.0, le1 + 0.01, 0.3, [le0 - 0.01, le0])
    rings, uvs = [], []
    for l in ls:
        st = surf.sec(l)
        tcut = (float(S.stab_xcut(st['Y'])) - st['X']) / st['c'] if l >= le0 - 0.011 else 1.0
        tcut = min(tcut, 1.0)
        P, UV = ring_fixed(surf, l, tcut, N=S.qn(34, 10))
        rings.append(P); uvs.append(UV)
    loft_rings(rings, uvs, closing_mat=1, md=md)
    ls2 = stations_between(le1 + 0.01, S.S_LEND, 0.12)
    rings, uvs = [], []
    for l in ls2:
        P, UV = ring_fixed(surf, l, 1.0, N=S.qn(34, 10))
        rings.append(P); uvs.append(UV)
    loft_rings(rings, uvs, cap_start=True, cap_end=True, md=md)
    mk.orient_outward(md)
    return md


def build_elevator_md():
    surf = stab_surface()
    le0, le1 = S.S_ELEV[0] / math.cos(S.S_DIHEDRAL), S.S_ELEV[1] / math.cos(S.S_DIHEDRAL)
    t_fn = lambda st: (float(S.stab_xcut(st['Y'])) - st['X']) / st['c']
    out = te_surface(surf, 'elev', 1, le0 + 0.01, le1, t_fn, [('', 0.0, 1.0)], None, None)
    return out['']


# =========================================================================================== WING ASSEMBLY
def build_wings(mats):
    """Creates wing objects and all movable surfaces for both sides. Returns list of created objects."""
    surf = wing_surface()
    created = []
    wing_mats = [mats['wing'], mats['structure'], mats['pylon']]
    fixed_r = build_wing_fixed(1, mats)
    mk.orient_outward(fixed_r)
    # fixed canoe (flap-track fairing) fronts + krueger/slat/spoiler/flaps
    canoes = [(3.85, 'flap_1'), (8.05, 'flap_2'), (10.85, 'flap_2')]
    canoe_front = MeshData()
    for Yc, fl in canoes:
        st = surf.sec(S.wing_l_of_Y(Yc))
        xc = float(S.wing_xcut(Yc))
        x0 = st['X'] + 0.45 * st['c']
        x1 = st['X'] + st['c'] + 1.25
        canoe_front.merge(canoe_md(Yc, x0, x1, xc, part='front'))
    import details as DET
    wl = []
    for lw in (S.W_LEND - 0.35, S.W_LEND - 0.15):
        X, Y, Z = S.wing_point(np.array([lw]), np.array([1.0]), True)
        wl.append(((float(X[0]) - 0.01, float(Y[0]), float(Z[0])), (1, 0.05, 0.2)))
    X, Y, Z = S.wing_point(np.array([S.wing_l_of_Y(16.4)]), np.array([1.0]), True)
    wl.append(((float(X[0]) - 0.01, float(Y[0]), float(Z[0])), (1, 0.1, 0)))
    fixed_r.merge(DET.wicks(wl))
    fixed_r_all = fixed_r.copy()
    fixed_r_all.merge(canoe_front.copy().set_mat(2))
    for side, sfx in ((1, 'R'), (-1, 'L')):
        md = fixed_r_all.copy()
        if side < 0:
            md.mirror_x()
        o = mk.obj('wing_' + sfx, md, wing_mats, sharp_angle=55)
        weld(o)
        created.append(o)

    t_cut_fn = lambda st: float(S.wing_tcut(st['Y'], st))
    # flaps: main element is the pivot object, fore vane + aft element are children
    flap_parts = [('_fore', 0.0, 0.26), ('', 0.20, 0.74), ('_aft', 0.66, 1.0)]
    for idx, key in (('1', 'flap_1'), ('2', 'flap_2')):
        y0, y1 = S.W_TE_SURF[key]
        pieces = te_surface(surf, key, 1, S.wing_l_of_Y(y0), S.wing_l_of_Y(y1), t_cut_fn, flap_parts, mats, 'wing')
        for side, sfx in ((1, 'R'), (-1, 'L')):
            mdm, hpm = pieces['']
            main = make_pivot(f'ctl_flap_{sfx}_{idx}', mdm, hpm, side, [mats['wing']])
            created.append(main)
            for suf in ('_fore', '_aft'):
                mdp, hpp = pieces[suf]
                ch = make_pivot(f'flap_{sfx}_{idx}{suf}', mdp, hpp, side, [mats['wing']], parent=main)
                created.append(ch)
    # canoe aft parts: own lateral hinge at the flap cut, rotate down with the flaps
    for k, (Yc, fl) in enumerate(canoes, start=1):
        l = S.wing_l_of_Y(Yc)
        st = surf.sec(l)
        xc = float(S.wing_xcut(Yc))
        cm = canoe_md(Yc, st['X'] + 0.45 * st['c'], st['X'] + st['c'] + 1.25, xc, part='aft')
        p, _ = surf.pts(l, np.array([(xc - st['X']) / st['c']]), False)
        p = p[0] - np.array([0, 0, 0.12])
        hp = [p - np.array([0, 0.2, 0]), p + np.array([0, 0.2, 0])]
        for side, sfx in ((1, 'R'), (-1, 'L')):
            created.append(make_pivot(f'canoe_{sfx}_{k}', cm, hp, side, [mats['pylon']]))
    # ailerons
    y0, y1 = S.W_TE_SURF['aileron']
    pieces = te_surface(surf, 'ail', 1, S.wing_l_of_Y(y0), S.wing_l_of_Y(y1), t_cut_fn, [('', 0.0, 1.0)], mats, 'wing')
    import details as DET
    wl = []
    for Yw in (13.2, 14.4, 15.6):
        X, Y, Z = S.wing_point(np.array([S.wing_l_of_Y(Yw)]), np.array([1.0]), True)
        wl.append(((float(X[0]) - 0.01, float(Y[0]), float(Z[0])), (1, 0.15, 0)))
    pieces[''][0].merge(DET.wicks(wl))
    for side, sfx in ((1, 'R'), (-1, 'L')):
        md, hp = pieces['']
        created.append(make_pivot(f'ctl_aileron_{sfx}', md, hp, side, [mats['wing']]))
    # spoilers
    for n, (a, b) in enumerate(S.W_SPOILERS, start=1):
        md, hp = spoiler_md(surf, a, b)
        for side, sfx in ((1, 'R'), (-1, 'L')):
            created.append(make_pivot(f'ctl_spoiler_{sfx}_{n}', md, hp, side, [mats['wing']]))
    # slats (bare metal leading edge) + krueger flaps
    for n, (a, b) in enumerate(S.W_SLATS, start=1):
        md, hp = slat_md(surf, a, b)
        for side, sfx in ((1, 'R'), (-1, 'L')):
            created.append(make_pivot(f'ctl_slat_{sfx}_{n}', md, hp, side, [mats['wing']]))
    for n, (a, b) in enumerate(S.W_KRUEGER, start=1):
        md, hp = slat_md(surf, a, b, krueger=True)
        for side, sfx in ((1, 'R'), (-1, 'L')):
            created.append(make_pivot(f'ctl_slat_{sfx}_K{n}', md, hp, side, [mats['wing']]))
    return created


def build_tail(mats):
    created = []
    fin = build_fin_md('fixed')
    o = mk.obj('fin', fin, [mats['tail'], mats['structure']], sharp_angle=55)
    weld(o)
    created.append(o)
    rmd, hp = build_fin_md('rudder')
    import details as DET
    wl = []
    for Zw in (7.0, 9.0, 11.0):
        st = S.fin_station(np.array([Zw]))
        wl.append(((float(st['xte'][0]) - 0.01, 0.0, Zw), (1, 0, 0.1)))
    rmd.merge(DET.wicks(wl))
    M = mk.hinge_matrix(TB(*hp[0]), TB(*hp[1]) - TB(*hp[0]), zref=(1, 0, 0))
    created.append(mk.obj('ctl_rudder', rmd, [mats['tail']], matrix=M, sharp_angle=55))
    st = build_stab_fixed()
    for side, sfx in ((1, 'R'), (-1, 'L')):
        m = st.copy()
        if side < 0:
            m.mirror_x()
        o = mk.obj('stab_' + sfx, m, [mats['stab'], mats['structure']], sharp_angle=55)
        weld(o)
        created.append(o)
    emd, ehp = build_elevator_md()
    wl = []
    for Yw in (4.0, 5.5, 6.6):
        st = S.stab_station(np.array([Yw / math.cos(S.S_DIHEDRAL)]))
        wl.append(((float(st['X'][0] + st['c'][0]) - 0.01, Yw, float(st['Z'][0]) - 0.02), (1, 0.1, 0)))
    emd.merge(DET.wicks(wl))
    for side, sfx in ((1, 'R'), (-1, 'L')):
        created.append(make_pivot(f'ctl_elevator_{sfx}', emd, ehp, side, [mats['stab']]))
    return created
