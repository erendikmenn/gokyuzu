"""UH-60M main rotor (4 wide-chord swept-tip blades, elastomeric hub, bifilar, swashplate) and canted tail rotor."""
import math
import numpy as np
from mathutils import Matrix, Vector, Euler
from lib import (new_mesh_obj, empty, prim_cylinder, prim_tube, prim_box, prim_sphere, prim_torus, merge_parts,
                 transform_verts, airfoil, loft_rings)

MAST_TILT = math.radians(3.0)                 # forward tilt of the main rotor shaft
HUB = (0.0, 0.65 * math.sin(MAST_TILT), 2.77 + 0.65 * math.cos(MAST_TILT))   # blade plane centre (G)
R_MAIN = 8.18
HINGE_R = 0.381                               # elastomeric bearing / flap hinge offset (15 in)
CHORD = 0.58                                  # UH-60M wide-chord blade
TR_HUB = (0.36, -9.92, 3.52)                 # tail rotor hub centre (G), right side of the pylon
TR_CANT = math.radians(20.0)
R_TAIL = 1.675
TR_CHORD = 0.246


def _xf(parts, M):
    return [(transform_verts(v, M), f) for v, f in parts]


def blade_mesh(r_root_local=0.0):
    """Main blade in the blade frame: origin at the flap hinge, span +X, leading edge +Y, up +Z.
    Returns (verts, faces, le_faces_mask) — radii are measured from the rotor axis (hinge at HINGE_R)."""
    af = airfoil(n=22, t=0.095, camber=0.012)
    npts = len(af)
    # spanwise stations (rotor radius r)
    rs = np.concatenate([np.linspace(1.30, 1.75, 4), np.linspace(1.95, 7.40, 22), np.linspace(7.50, R_MAIN, 9)])
    rings = []
    for r in rs:
        f = r / R_MAIN
        twist = math.radians(-18.0) * (f - 0.75)
        chord = CHORD
        sweep = 0.0
        anh = 0.0
        thick = 1.0
        if r < 1.80:   # root transition: thicker, narrower
            k = (1.80 - r) / 0.5
            chord = CHORD * (1 - 0.35 * k)
            thick = 1 + 1.6 * k
        if r > 7.52:   # swept tapered tip (20 deg LE sweep, 60 % taper, slight anhedral)
            k = (r - 7.52) / (R_MAIN - 7.52)
            sweep = (r - 7.52) * math.tan(math.radians(20.0))
            chord = CHORD * (1 - 0.40 * k ** 1.2)
            anh = -0.035 * k * k
        pts = []
        ct, st = math.cos(twist), math.sin(twist)
        for (xc, zc) in af:
            # chord coordinate from LE (xc=0) -> TE (xc=1); pitch axis at quarter chord
            yy = (0.25 - xc) * chord - sweep * (1.0 if xc < 2 else 0)
            zz = zc * chord * thick
            # twist about the pitch axis (positive = LE up)
            y2 = yy * ct - zz * st
            z2 = yy * st + zz * ct
            pts.append((r - HINGE_R, y2, z2 + anh))
        rings.append(np.array(pts))
    # tip: close with a fan to a point slightly aft
    verts, faces = loft_rings(rings, cap_start='fan', cap_end='fan')
    # leading-edge strip faces: the first/last few airfoil points around the LE
    le_idx = set()
    half = npts // 2
    for i in range(len(rs) - 1):
        if rs[i] < 2.0:
            continue
        for j in range(npts):
            # airfoil ordering: TE -> upper -> LE (index n) -> lower -> TE; LE region = indices near 22
            if abs(j - 22) <= 3:
                le_idx.add(i * npts + j)
    return verts, faces, le_idx


def blade_object(name, M):
    """Blade mesh with UVs: u = r / R (span), v = position around the airfoil (0 TE upper -> 0.5 LE -> 1 TE lower)."""
    import bpy
    v, f, _ = blade_mesh()
    npts = 44
    nrings = (len(v) - 2) // npts
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        js = [vi % npts if vi < nrings * npts else -1 for vi in p.vertices]
        wrap = (0 in js) and (npts - 1 in js)
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            co = me.vertices[vi].co
            if vi >= nrings * npts:          # cap centres
                j = npts / 2
            else:
                j = vi % npts
                if wrap and j == 0:
                    j = npts
            uv.data[li].uv = ((co.x + HINGE_R) / R_MAIN, j / npts)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(M['blade'])
    # outward normals: a face on the upper surface near mid span must point up
    me.update()
    test = [p for p in me.polygons if abs(p.center.x - 3.0) < 0.3 and abs(p.center.y) < 0.05]
    if test and max(test, key=lambda p: p.center.z).normal.z < 0:
        me.flip_normals()
    for p in me.polygons:
        p.use_smooth = True
    from lib import mark_sharp
    mark_sharp(ob, 70)
    return ob


def build_main_rotor(M, root):
    """rotor_main (hub, spins about local +Z Blender = +Y three), blade_1..4 children, rotor_main_blur, swashplate."""
    rot = new_mesh_obj('rotor_main', *hub_mesh(), mat=M['titanium'], smooth=True, sharp_deg=40)
    add_hub_extras(rot, M)
    rot.location = HUB
    rot.rotation_euler = (-MAST_TILT, 0, 0)
    rot.parent = root
    blades = []
    for i in range(4):
        th = i * math.pi / 2
        ob = blade_object(f'blade_{i + 1}', M)
        cuff_v, cuff_f = cuff_mesh()
        cuff = new_mesh_obj(f'_cuff{i}', cuff_v, cuff_f, mat=M['metal_dark'], smooth=True, sharp_deg=45)
        from lib import join
        ob = join([ob, cuff], f'blade_{i + 1}')
        ob.parent = rot
        ob.location = (HINGE_R * math.cos(th), HINGE_R * math.sin(th), 0.0)
        ob.rotation_euler = (0, 0, th)
        blades.append(ob)
    # blur disc (non-rotating, same tilt)
    blur = new_mesh_obj('rotor_main_blur', *disc_mesh(0.95, R_MAIN + 0.02, 72, cone_deg=2.5), mat=M['blur_main'], smooth=True)
    blur.location = HUB
    blur.rotation_euler = (-MAST_TILT, 0, 0)
    blur.parent = root
    # swashplate (non-rotating, rig tilts it)
    sw = new_mesh_obj('swashplate', *swash_mesh(), mat=M['metal'], smooth=True, sharp_deg=40)
    d = 0.42
    sw.location = (HUB[0], HUB[1] - d * math.sin(MAST_TILT), HUB[2] - d * math.cos(MAST_TILT))
    sw.rotation_euler = (-MAST_TILT, 0, 0)
    sw.parent = root
    return rot, blades, blur, sw


def hub_mesh():
    parts = []
    # rotating mast / shaft from the transmission to the hub
    parts.append(prim_cylinder(0.115, 0.11, 0.70, n=24, center=(0, 0, -0.70)))
    # rotating scissors (mast to swashplate rotating ring)
    for sgn in (1, -1):
        v, f = prim_tube([(0.09 * sgn, 0.0, -0.20), (0.20 * sgn, 0.04, -0.28), (0.29 * sgn, 0.0, -0.38)], 0.018, n=8)
        parts.append((v, f))
    # central hub plate (4-arm titanium forging)
    for i in range(4):
        th = i * math.pi / 2
        Mr = Matrix.Rotation(th, 4, 'Z')
        # arm: two plates (upper/lower) around the elastomeric bearing
        for zc in (0.10, -0.10):
            v, f = prim_box((0.36, 0.30, 0.055), center=(0.29, 0, zc))
            parts.append((transform_verts(v, Mr), f))
        # outboard arm bridge (bearing housing)
        v, f = prim_box((0.07, 0.32, 0.26), center=(0.47, 0, 0))
        parts.append((transform_verts(v, Mr), f))
        # droop stop under the arm
        v, f = prim_box((0.12, 0.08, 0.05), center=(0.36, 0, -0.16))
        parts.append((transform_verts(v, Mr), f))
    v, f = prim_cylinder(0.27, 0.27, 0.25, n=28, center=(0, 0, -0.125))
    parts.append((v, f))
    # hub top cap
    parts.append(prim_cylinder(0.20, 0.14, 0.10, n=24, center=(0, 0, 0.11)))
    return merge_parts(parts)


def add_hub_extras(rot, M):
    from lib import join
    objs = []
    # elastomeric bearings (black laminated rubber) between the arm plates
    parts = []
    for i in range(4):
        th = i * math.pi / 2
        Mr = Matrix.Rotation(th, 4, 'Z')
        for k in range(5):
            r0 = 0.20 + k * 0.04
            v, f = prim_cylinder(0.125 - (k % 2) * 0.014, 0.125 - (k % 2) * 0.014, 0.036, n=18, axis='X', center=(r0, 0, 0))
            parts.append((transform_verts(v, Mr), f))
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_elasto', v, f, mat=M['rubber'], smooth=True, sharp_deg=50))
    # bifilar vibration absorber on top: 4 arms (between blades) with two pendulum weights each
    parts = []
    for i in range(4):
        th = i * math.pi / 2 + math.pi / 4
        Mr = Matrix.Rotation(th, 4, 'Z')
        v, f = prim_box((0.46, 0.07, 0.05), center=(0.25, 0, 0.22))
        parts.append((transform_verts(v, Mr), f))
        for s in (-1, 1):
            v, f = prim_cylinder(0.075, 0.075, 0.10, n=16, axis='Y', center=(0.47, s * 0.075 - 0.05 * (s < 0) + 0.0, 0.22))
            v, f = prim_cylinder(0.075, 0.075, 0.09, n=16, axis='Y', center=(0.47, s * 0.06 - 0.045, 0.22))
            parts.append((transform_verts(v, Mr), f))
    parts.append(prim_cylinder(0.13, 0.13, 0.10, n=20, center=(0, 0, 0.17)))
    parts.append(prim_cylinder(0.07, 0.03, 0.08, n=16, center=(0, 0, 0.27)))
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_bifilar', v, f, mat=M['metal_dark'], smooth=True, sharp_deg=40))
    # pitch links (rotating) from the swashplate rotating ring up to the pitch horns (leading side)
    parts = []
    for i in range(4):
        th = i * math.pi / 2
        Mr = Matrix.Rotation(th, 4, 'Z')
        path = [(0.30, 0.20, -0.40), (0.33, 0.21, -0.07)]
        v, f = prim_tube(path, 0.018, n=8)
        parts.append((transform_verts(v, Mr), f))
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_plinks', v, f, mat=M['chrome'], smooth=True))
    # dampers (lead-lag) from the hub to the cuffs, trailing side
    parts = []
    for i in range(4):
        th = i * math.pi / 2
        Mr = Matrix.Rotation(th, 4, 'Z')
        v, f = prim_tube([(0.22, -0.24, 0.02), (0.70, -0.13, 0.0)], [0.062, 0.050], n=14)
        parts.append((transform_verts(v, Mr), f))
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_dampers', v, f, mat=M['metal'], smooth=True))
    join([rot] + objs, 'rotor_main')


def cuff_mesh():
    """Blade cuff/spindle from the hinge to the blade root (blade frame) + trailing-edge trim tab."""
    parts = []
    # trim tab at r = 5.9..6.6 m on the trailing edge (twist at 0.75 R ~ 0)
    r0, r1 = 5.9 - HINGE_R, 6.6 - HINGE_R
    v, f = prim_box((r1 - r0, 0.06, 0.006), center=((r0 + r1) / 2, -0.75 * CHORD - 0.025, 0.0))
    parts.append((v, f))
    parts.append(prim_cylinder(0.10, 0.085, 0.60, n=18, axis='X', center=(0.0, 0, 0)))
    # root fitting widening into the blade root (flattened)
    v, f = prim_cylinder(0.085, 0.11, 0.42, n=18, axis='X', center=(0.55, 0, 0))
    v = [(x, y * 1.35, z * 0.75) for x, y, z in v]
    parts.append((v, f))
    # pitch horn toward the leading edge
    v, f = prim_box((0.10, 0.22, 0.04), center=(0.05, 0.14, -0.03))
    parts.append((v, f))
    # damper lug on trailing side
    v, f = prim_box((0.08, 0.10, 0.06), center=(0.28, -0.11, 0.0))
    parts.append((v, f))
    return merge_parts(parts)


def disc_mesh(r0, r1, n=64, cone_deg=0.0, rings=5):
    verts, faces = [], []
    rs = np.linspace(r0, r1, rings)
    for r in rs:
        dz = (r - r0) * math.tan(math.radians(cone_deg))
        for i in range(n):
            a = 2 * math.pi * i / n
            verts.append((r * math.cos(a), r * math.sin(a), dz))
    for k in range(rings - 1):
        for i in range(n):
            i1 = (i + 1) % n
            faces.append((k * n + i, k * n + i1, (k + 1) * n + i1, (k + 1) * n + i))
    return verts, faces


def swash_mesh():
    parts = []
    parts.append(prim_cylinder(0.30, 0.30, 0.05, n=32, center=(0, 0, 0.02)))    # rotating ring
    parts.append(prim_cylinder(0.33, 0.33, 0.05, n=32, center=(0, 0, -0.04)))   # stationary ring
    parts.append(prim_cylinder(0.16, 0.16, 0.16, n=24, center=(0, 0, -0.10)))   # uniball / guide
    for i in range(3):   # primary servos (from the transmission deck up to the stationary ring)
        th = i * 2 * math.pi / 3 + math.pi / 6
        c = (0.33 * math.cos(th), 0.33 * math.sin(th))
        v, f = prim_box((0.08, 0.08, 0.06), center=(c[0], c[1], -0.07))
        parts.append((v, f))
        parts.append(prim_cylinder(0.045, 0.045, 0.22, n=14, center=(c[0] * 1.05, c[1] * 1.05, -0.33)))
        parts.append(prim_cylinder(0.025, 0.025, 0.14, n=10, center=(c[0] * 1.02, c[1] * 1.02, -0.18)))
    # stationary scissors
    v, f = prim_tube([(0.0, -0.33, -0.05), (0.0, -0.30, -0.18), (0.0, -0.18, -0.26)], 0.018, n=8)
    parts.append((v, f))
    return merge_parts(parts)


# ------------------------------------------------------------------------------------------------ tail rotor
def build_tail_rotor(M, root):
    """rotor_tail: origin on the shaft axis at the hub, local +X = shaft axis (canted 20 deg up)."""
    parts = []
    # hub: crossbeam clamp + nose cap along +X
    parts.append(prim_cylinder(0.10, 0.10, 0.16, n=20, axis='X', center=(-0.02, 0, 0)))
    parts.append(prim_cylinder(0.10, 0.02, 0.16, n=20, axis='X', center=(0.14, 0, 0)))
    parts.append(prim_cylinder(0.05, 0.05, 0.30, n=12, axis='-X', center=(-0.02, 0, 0)))   # shaft to gearbox
    for k in range(2):   # two crossbeam spars (4 blades)
        a = k * math.pi / 2
        Mr = Matrix.Rotation(a, 4, 'X')
        v, f = prim_box((0.05, 0.10, 0.62), center=(0.03 + 0.03 * k, 0, 0))
        parts.append((transform_verts(v, Mr), f))
    v, f = merge_parts(parts)
    tr = new_mesh_obj('rotor_tail', v, f, mat=M['metal_dark'], smooth=True, sharp_deg=40)
    tr.location = TR_HUB
    tr.rotation_euler = (0, -TR_CANT, 0)
    tr.parent = root
    af = airfoil(n=14, t=0.10)
    blades = []
    for k in range(4):
        phi = k * math.pi / 2
        rings = []
        for r in np.linspace(0.30, R_TAIL, 10):
            f = r / R_TAIL
            twist = math.radians(-18.0) * (f - 0.75)
            pts = []
            for (xc, zc) in af:
                yy = (xc - 0.25) * TR_CHORD     # LE toward -Y (top blade moves aft for +X rotation)
                xx = zc * TR_CHORD
                y2 = yy * math.cos(twist) - xx * math.sin(twist)
                x2 = yy * math.sin(twist) + xx * math.cos(twist)
                pts.append((x2 + 0.06 * (k % 2), y2, r))
            rings.append(np.array(pts))
        v, f = loft_rings(rings, cap_start='fan', cap_end='fan')
        b = new_mesh_obj(f'tail_blade_{k + 1}', v, f, mat=M['blade'], smooth=True, sharp_deg=70)
        b.parent = tr
        b.rotation_euler = (phi, 0, 0)
        blades.append(b)
    blur = new_mesh_obj('rotor_tail_blur', *disc_mesh(0.18, R_TAIL + 0.01, 48, rings=4), mat=M['blur_tail'], smooth=True)
    # disc mesh is in local XY (normal Z); rotate so its normal is the shaft axis (local X of rotor_tail)
    blur.data.transform(Matrix.Rotation(math.pi / 2, 4, 'Y'))
    blur.location = (TR_HUB[0] + 0.03 * math.cos(TR_CANT), TR_HUB[1], TR_HUB[2] + 0.03 * math.sin(TR_CANT))
    blur.rotation_euler = (0, -TR_CANT, 0)
    blur.parent = root
    return tr, blades, blur
