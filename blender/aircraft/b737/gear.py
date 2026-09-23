"""737-800 landing gear: main gear retracting inboard (wheels exposed in the belly), nose gear retracting forward
with two doors, wheel wells cut into the fuselage."""
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


def G(x, y, z):
    return TB(x, y, z)


def tire_md(center_g, r, w, hub_r, outer_sign, n=40, mats=(0, 1)):
    n = S.qn(n, 12)
    """Tire + hub around a lateral axle (ground frame centre). outer_sign: +1 hubcap faces +Y."""
    c = G(*center_g)
    ax = np.array([1.0, 0, 0])   # blender x = ground Y (lateral)
    hw = w / 2
    prof = [(hub_r * 0.98, -hw * 0.80), (hub_r * 1.08, -hw * 0.97), (r * 0.72, -hw), (r * 0.88, -hw * 0.93),
            (r * 0.965, -hw * 0.75), (r * 0.995, -hw * 0.45), (r, -hw * 0.15), (r, hw * 0.15), (r * 0.995, hw * 0.45),
            (r * 0.965, hw * 0.75), (r * 0.88, hw * 0.93), (r * 0.72, hw), (hub_r * 1.08, hw * 0.97), (hub_r * 0.98, hw * 0.80)]
    md = mk.lathe(prof, n=n, origin=c, axis=ax, ref=(0, 0, 1), mat=mats[0])
    # hub: outer face domed hubcap, inner face flat with brake
    s = outer_sign
    hub = [(0.0, s * (hw * 0.95)), (hub_r * 0.35, s * hw * 0.93), (hub_r * 0.62, s * hw * 0.86), (hub_r * 0.75, s * hw * 0.80),
           (hub_r * 0.80, s * hw * 0.72), (hub_r * 0.98, s * hw * 0.78), (hub_r * 0.98, -s * hw * 0.78),
           (hub_r * 0.55, -s * hw * 0.80), (hub_r * 0.25, -s * hw * 0.70), (0.0, -s * hw * 0.70)]
    h = mk.lathe(hub, n=n, origin=c, axis=ax, ref=(0, 0, 1), mat=mats[1])
    mk.orient_outward(h, center=c)
    md.merge(h)
    return md


def build_gear(mats, fus_obj):
    created = []
    # ------------------------------------------------------------ MAIN GEAR
    for side, sfx in ((1, 'R'), (-1, 'L')):
        Y = side * S.MG_Y
        X = S.MG_X
        T = (X, Y, S.MG_TRUNNION_Z)
        axis = np.array([0, 1.0, 0]) * side     # positive rotation = retract inboard
        M = mk.hinge_matrix(G(*T), axis, (0, 0, 1))
        leg = MeshData()
        mk.tube(G(X, Y, 2.08), G(X, Y, 0.98), 0.105, n=20, mat=0, md=leg)            # outer cylinder
        mk.tube(G(X - 0.32, Y, S.MG_TRUNNION_Z), G(X + 0.32, Y, S.MG_TRUNNION_Z), 0.075, n=14, mat=0, md=leg)
        mk.tube(G(X, Y, 1.05), G(X, Y, 0.95), 0.125, n=20, mat=0, md=leg)            # gland nut
        # torque links (front), upper half on the leg
        mk.box(G(X + 0.14, Y, 0.93), (0.05, 0.16, 0.24), mat=0, md=leg)
        # hydraulic lines
        mk.tube(G(X - 0.11, Y + side * 0.06, 2.0), G(X - 0.11, Y + side * 0.06, 0.95), 0.012, n=6, mat=2, md=leg)
        mk.tube(G(X - 0.13, Y - side * 0.05, 2.0), G(X - 0.13, Y - side * 0.05, 0.95), 0.012, n=6, mat=2, md=leg)
        lego = mk.obj(f'gear_main_{sfx}', leg, [mats['gear'], mats['chrome'], mats['metal_dark']], matrix=M, sharp_angle=45)
        created.append(lego)
        # strut door on the outboard side of the leg (covers the slot when retracted)
        door = MeshData()
        prof = []
        for zz in np.linspace(1.93, 1.00, 6):
            row = []
            for xx in np.linspace(X - 0.33, X + 0.33, 7):
                bow = 0.05 * (1 - ((xx - X) / 0.33) ** 2)
                row.append(G(xx, Y + side * (0.15 + bow), zz))
            prof.append(row)
        P = np.array(prof)
        UV = np.zeros((P.shape[0], P.shape[1], 2)) + 0.5
        dm = mk.grid(P, UV, wrap=False)
        dm2 = dm.copy(); dm2.translate(np.array([-side * 0.02, 0, 0])); dm2.flip()
        dm.merge(dm2)
        door.merge(dm)
        created.append(mk.obj(f'gear_door_main_{sfx}', door, [mats['fuselage_plain']], parent=lego, smooth=True))
        # side brace (folds during retraction)
        B0 = (X, Y, 1.33)
        B1 = (X, side * 1.72, 2.12)
        brace = MeshData()
        mk.tube(G(*B0), G(*B1), 0.045, n=10, mat=0, md=brace)
        mk.tube(G(X + 0.12, Y, 1.36), G(*B1), 0.03, n=8, mat=0, md=brace)
        Mb = mk.hinge_matrix(G(*B0), axis, (0, 0, 1))
        created.append(mk.obj(f'gear_main_{sfx}_brace', brace, [mats['gear']], matrix=Mb, parent=lego, sharp_angle=45))
        # piston + axle + brakes + lower torque link (compresses along the leg)
        pis = MeshData()
        zA = S.MG_STATIC_R
        mk.tube(G(X, Y, 1.08), G(X, Y, zA + 0.10), 0.078, n=18, mat=1, md=pis)
        mk.box(G(X, Y, zA + 0.05), (0.26, 0.22, 0.16), mat=0, md=pis)                  # axle housing
        mk.tube(G(X, Y - 0.56, zA), G(X, Y + 0.56, zA), 0.055, n=14, mat=0, md=pis)    # axle
        mk.box(G(X + 0.14, Y, 0.72), (0.05, 0.16, 0.22), mat=0, md=pis)
        for dy in (-S.MG_WHEEL_DY, S.MG_WHEEL_DY):
            yb = Y + dy - np.sign(dy) * 0.03
            mk.tube(G(X, yb - 0.11, zA), G(X, yb + 0.11, zA), 0.215, n=24, mat=2, md=pis)   # brake stack
        Mp = mk.hinge_matrix(G(X, Y, zA), axis, (0, 0, 1))
        piso = mk.obj(f'gear_main_{sfx}_piston', pis, [mats['gear'], mats['chrome'], mats['metal_dark']],
                      matrix=Mp, parent=lego, sharp_angle=45)
        created.append(piso)
        for k, dy in ((1, S.MG_WHEEL_DY), (2, -S.MG_WHEEL_DY)):
            cen = (X, Y + side * dy, zA)
            outer = side * (1 if k == 1 else -1)
            tm = tire_md(cen, S.MG_TIRE_R, S.MG_TIRE_W, 0.275, outer)
            Mw = np.eye(4); Mw[:3, 3] = G(*cen)
            created.append(mk.obj(f'wheel_main_{sfx}_{k}', tm, [mats['tire'], mats['hub']], matrix=Mw, parent=piso,
                                  sharp_angle=50))
        mk.empty(f'contact_main_{sfx}', G(X, Y, 0.0))
    # ------------------------------------------------------------ NOSE GEAR
    X = S.NG_X
    T = (X, 0.0, S.NG_TRUNNION_Z)
    M = mk.hinge_matrix(G(*T), (1.0, 0, 0), (0, 0, 1))
    leg = MeshData()
    mk.tube(G(X, 0, 1.78), G(X, 0, 0.92), 0.078, n=18, mat=0, md=leg)
    mk.tube(G(X, -0.24, S.NG_TRUNNION_Z), G(X, 0.24, S.NG_TRUNNION_Z), 0.06, n=12, mat=0, md=leg)
    mk.tube(G(X, 0, 1.18), G(X, 0, 1.06), 0.105, n=18, mat=0, md=leg)                   # steering collar
    mk.tube(G(X - 0.02, -0.16, 1.14), G(X + 0.18, -0.16, 1.24), 0.03, n=8, mat=0, md=leg)  # steering actuators
    mk.tube(G(X - 0.02, 0.16, 1.14), G(X + 0.18, 0.16, 1.24), 0.03, n=8, mat=0, md=leg)
    mk.box(G(X - 0.11, 0, 0.88), (0.04, 0.12, 0.2), mat=0, md=leg)                      # torque link upper
    # taxi light housing on the front of the strut
    mk.box(G(X - 0.12, 0, 1.30), (0.10, 0.14, 0.12), mat=0, md=leg)
    lens = mk.lathe([(0.0, 0.0), (0.045, 0.0), (0.045, 0.012)], n=12, origin=G(X - 0.175, 0, 1.30),
                    axis=(0, 1, 0), mat=2)
    leg.merge(lens)
    lego = mk.obj('gear_nose', leg, [mats['gear'], mats['chrome'], mats['lens_clear']], matrix=M, sharp_angle=45)
    created.append(lego)
    e = mk.empty('light_taxi', G(X - 0.19, 0, 1.30), parent=lego)
    # drag brace (folds)
    B0 = (X, 0, 1.22)
    B1 = (X - 0.85, 0, 1.78)
    brace = MeshData()
    mk.tube(G(X, -0.08, 1.22), G(*B1), 0.035, n=8, mat=0, md=brace)
    mk.tube(G(X, 0.08, 1.22), G(*B1), 0.035, n=8, mat=0, md=brace)
    Mb = mk.hinge_matrix(G(*B0), (1.0, 0, 0), (0, 0, 1))
    created.append(mk.obj('gear_nose_brace', brace, [mats['gear']], matrix=Mb, parent=lego, sharp_angle=45))
    pis = MeshData()
    zA = S.NG_STATIC_R
    mk.tube(G(X, 0, 1.00), G(X, 0, zA + 0.06), 0.058, n=16, mat=1, md=pis)
    mk.box(G(X, 0, zA + 0.03), (0.14, 0.16, 0.12), mat=0, md=pis)
    mk.tube(G(X, -0.30, zA), G(X, 0.30, zA), 0.035, n=12, mat=0, md=pis)
    mk.box(G(X - 0.11, 0, 0.70), (0.04, 0.12, 0.18), mat=0, md=pis)
    Mp = mk.hinge_matrix(G(X, 0, zA), (1.0, 0, 0), (0, 0, 1))
    piso = mk.obj('gear_nose_piston', pis, [mats['gear'], mats['chrome']], matrix=Mp, parent=lego, sharp_angle=45)
    created.append(piso)
    for sfx, dy in (('R', S.NG_WHEEL_DY), ('L', -S.NG_WHEEL_DY)):
        cen = (X, dy, zA)
        tm = tire_md(cen, S.NG_TIRE_R, S.NG_TIRE_W, 0.155, 1 if dy > 0 else -1, n=32)
        Mw = np.eye(4); Mw[:3, 3] = G(*cen)
        created.append(mk.obj(f'wheel_nose_{sfx}', tm, [mats['tire'], mats['hub']], matrix=Mw, parent=piso, sharp_angle=50))
    mk.empty('contact_nose', G(X, 0, 0.0))
    # ------------------------------------------------------------ nose doors (hinged at the outer edges)
    x0, x1 = 2.42, 4.48
    half_w = 0.36
    for sfx, side in (('R', 1), ('L', -1)):
        rows = []
        uvr = []
        for xx in np.linspace(x0, x1, 12):
            # theta range at this station from the belly centre to |Y| = half_w
            th = np.linspace(math.pi, math.pi / 2 if side > 0 else 3 * math.pi / 2, 400)
            yy, zz = S.fus_point(np.full_like(th, xx), th)
            j = np.argmin(np.abs(np.abs(yy) - half_w))
            ths = np.linspace(math.pi, th[j], 6)
            yy, zz = S.fus_point(np.full_like(ths, xx), ths)
            rows.append(TB(np.full_like(ths, xx), yy, zz - 0.004))
            uvr.append(np.stack(S.fus_uv(np.full_like(ths, xx), ths), -1))
        P = np.array(rows)
        UV = np.array(uvr)
        UV[..., 1] = np.where(UV[..., 1] < 0.02, 1.0 if side > 0 else 0.0, UV[..., 1]) if side > 0 else UV[..., 1]
        dm = mk.grid(P, UV, wrap=False)
        inner = dm.copy(); inner.translate(np.array([0, 0, 0.025])); inner.flip()
        dm.merge(inner)
        mk.orient_outward(dm, center=TB(3.4, 0, 2.2))
        hp0 = TB(x0, side * half_w, float(S.fus_point(x0, S.fus_theta_at(x0, side, 1.5))[1]))
        # hinge axis along the outer edge; positive rotation = open (inner edge swings down)
        axis = np.array([0, -1.0, 0]) if side > 0 else np.array([0, 1.0, 0])
        edge = P[:, -1]
        o = edge[0]
        Md = mk.hinge_matrix(o, axis, (0, 0, 1))
        created.append(mk.obj(f'gear_door_nose_{sfx}', dm, [mats['fuselage']], matrix=Md, smooth=True))
    return created


def cut_wells(bm, uncut_obj):
    """Cut the nose and main wheel wells into the fuselage skin (bmesh); returns the cavity MeshData."""
    from exterior import _poly_inside
    bm.normal_update()
    wells = []
    # nose well: rectangle (X, Y)
    wells.append(('nose', np.array([(2.42, -0.36), (4.48, -0.36), (4.48, 0.36), (2.42, 0.36)]), 2.35))
    for side in (1, -1):
        c = np.array([S.MG_X, side * (S.MG_Y - (S.MG_TRUNNION_Z - S.MG_STATIC_R))])
        circ = np.array([c + 0.60 * np.array([math.cos(a), math.sin(a)]) for a in np.linspace(0, 2 * math.pi, 28, endpoint=False)])
        wells.append((f'main{side}', circ, 2.55))
    bvh = BVHTree.FromObject(uncut_obj, bpy.context.evaluated_depsgraph_get())
    cav = MeshData()
    for name, poly, ztop in wells:
        lo, hi = poly.min(0) - 0.3, poly.max(0) + 0.3
        def proj(p):
            X, Y, Z = S.from_b(np.array(p))
            return np.array([X, Y]), Z
        region = set()
        for f in bm.faces:
            q, z = proj(f.calc_center_median())
            if lo[0] < q[0] < hi[0] and lo[1] < q[1] < hi[1] and f.normal.z < -0.25 and z < 2.2:
                region.add(f)
        n = len(poly)
        for k in range(n):
            a, b = poly[k], poly[(k + 1) % n]
            A3 = TB(a[0], a[1], 0.0); B3 = TB(b[0], b[1], 0.0)
            no = np.cross(B3 - A3, np.array([0, 0, 1.0]))
            no /= np.linalg.norm(no)
            mid = (a + b) / 2
            rad = np.linalg.norm(b - a) / 2 + 0.15
            near = [f for f in region if f.is_valid and np.linalg.norm(proj(f.calc_center_median())[0] - mid) < rad]
            if not near:
                continue
            geom = set()
            for f in near:
                geom.add(f); geom.update(f.edges); geom.update(f.verts)
            res = bmesh.ops.bisect_plane(bm, geom=list(geom), plane_co=Vector(A3), plane_no=Vector(no))
            region = {f for f in region if f.is_valid}
            for g in res['geom_cut']:
                if isinstance(g, bmesh.types.BMVert):
                    region.update(g.link_faces)
        inside = [f for f in region if f.is_valid and _poly_inside(proj(f.calc_center_median())[0], poly)]
        bmesh.ops.delete(bm, geom=list(set(inside)), context='FACES_ONLY')
        # cavity walls from the skin up to ztop, plus a ceiling
        pts = []
        for k in range(n):
            a, b = poly[k], poly[(k + 1) % n]
            for t in np.linspace(0, 1, 4, endpoint=False):
                pts.append(a + (b - a) * t)
        bot, top = [], []
        for q in pts:
            o = TB(q[0], q[1], -1.0)
            hit = bvh.ray_cast(Vector(o), Vector((0, 0, 1)))
            zb = hit[0].z if hit[0] is not None else TB(0, 0, 1.3)[2]
            bot.append(np.array([o[0], o[1], zb - 0.01]))
            top.append(np.array([o[0], o[1], TB(0, 0, ztop)[2]]))
        m = len(pts)
        base = cav.nv
        cav.v = np.vstack([cav.v, np.array(bot), np.array(top)]) if cav.nv else np.vstack([np.array(bot), np.array(top)])
        for k in range(m):
            k1 = (k + 1) % m
            cav.f.append([base + k, base + k1, base + m + k1, base + m + k]); cav.uv.extend([(0.5, 0.5)] * 4)
            cav.mi.append(0); cav.sharp.append(False)
        cav.f.append([base + m + k for k in range(m)]); cav.uv.extend([(0.5, 0.5)] * m); cav.mi.append(0); cav.sharp.append(True)
    return cav
