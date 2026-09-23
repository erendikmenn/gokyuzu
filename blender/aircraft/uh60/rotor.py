"""UH-60M main rotor (4 wide-chord swept-tip blades, elastomeric hub, bifilar, swashplate) and canted tail rotor."""
import math
import numpy as np
from mathutils import Matrix, Vector, Euler
from lib import (new_mesh_obj, empty, prim_cylinder, prim_tube, prim_box, prim_sphere, prim_torus, merge_parts, prim_rbox,
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
        (pv, pf), (bv, bf) = cuff_bright_mesh()
        cpl = new_mesh_obj(f'_cplate{i}', pv, pf, mat=M['mast'], smooth=True, sharp_deg=45)
        cbim = new_mesh_obj(f'_cbim{i}', bv, bf, mat=M['label_white'], smooth=True, sharp_deg=45)
        from lib import join
        ob = join([ob, cuff, cpl, cbim], f'blade_{i + 1}')
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
    sw = new_mesh_obj('swashplate', *swash_mesh(), mat=M['metal_dark'], smooth=True, sharp_deg=40)
    d = 0.52
    sw.location = (HUB[0], HUB[1] - d * math.sin(MAST_TILT), HUB[2] - d * math.cos(MAST_TILT))
    sw.rotation_euler = (-MAST_TILT, 0, 0)
    sw.parent = root
    return rot, blades, blur, sw


def _rot(parts, th):
    Mr = Matrix.Rotation(th, 4, 'Z')
    return [(transform_verts(v, Mr), f) for v, f in parts]


def _rod(p0, p1, r, n=10, ends=True):
    """Push-pull rod with spherical rod ends (bearing eyes) at both ends."""
    p0, p1 = Vector(p0), Vector(p1)
    parts = [prim_tube([p0, p1], r, n=n)]
    if ends:
        for p in (p0, p1):
            parts.append(prim_sphere(r * 1.9, n=10, m=6, center=tuple(p)))
    # turnbuckle / lock nut near the lower end
    d = (p1 - p0)
    parts.append(prim_tube([p0 + d * 0.22, p0 + d * 0.30], r * 1.45, n=8))
    return parts


def hub_mesh():
    """Titanium hub forging: central body + four yoke loops (upper/lower plates joined outboard), mast + flange."""
    parts = []
    # flange and hub nut (the bare-metal mast itself is added in add_hub_extras)
    parts.append(prim_cylinder(0.17, 0.17, 0.035, n=28, center=(0, 0, -0.125)))
    for k in range(12):                                              # flange bolts
        a = 2 * math.pi * k / 12
        parts.append(prim_cylinder(0.011, 0.011, 0.05, n=6, center=(0.145 * math.cos(a), 0.145 * math.sin(a), -0.135)))
    parts.append(prim_cylinder(0.215, 0.215, 0.20, n=32, center=(0, 0, -0.10)))
    parts.append(prim_cylinder(0.215, 0.18, 0.03, n=32, center=(0, 0, 0.10)))
    for i in range(4):
        th = i * math.pi / 2
        arm = []
        for zc in (0.078, -0.078):                                    # upper / lower plates of the loop
            v, f = prim_rbox((0.30, 0.30, 0.048), (0.30, 0, zc), r=0.018, n=2)
            v = [(x, y * (1.0 - 0.28 * max(0.0, (x - 0.2) / 0.25)), z) for x, y, z in v]   # taper outboard
            arm.append((v, f))
        arm.append(prim_rbox((0.075, 0.24, 0.205), (0.445, 0, 0.0), r=0.03, n=3))       # outboard bridge of the loop
        arm.append(prim_rbox((0.10, 0.34, 0.20), (0.19, 0, 0.0), r=0.03, n=2))          # inboard web
        # droop stop (below) and anti-flap stop (above) blocks on the loop
        arm.append(prim_rbox((0.07, 0.12, 0.05), (0.40, 0, -0.135), r=0.012, n=2))
        arm.append(prim_rbox((0.06, 0.10, 0.04), (0.40, 0, 0.125), r=0.01, n=2))
        # bolts along the loop plates
        for x in (0.22, 0.31, 0.40):
            for y in (-0.10, 0.10):
                arm.append(prim_cylinder(0.012, 0.012, 0.215, n=6, center=(x, y * (1.0 - 0.28 * max(0.0, (x - 0.2) / 0.25)), -0.1075)))
        parts += _rot(arm, th)
    return merge_parts(parts)


def add_hub_extras(rot, M):
    from lib import join
    objs = []
    # bare aluminium main rotor shaft (mast) between the transmission and the hub
    import cplib as _c
    bell = _c.lathe_z([(0.0, -0.80), (0.20, -0.80), (0.20, -0.74), (0.16, -0.70), (0.13, -0.64), (0.118, -0.56), (0.118, -0.14),
                       (0.0, -0.14)], 36)
    v, f = merge_parts([bell, prim_cylinder(0.126, 0.126, 0.03, n=32, center=(0, 0, -0.34))])
    objs.append(new_mesh_obj('_mast', v, f, mat=M['mast'], smooth=True, sharp_deg=40))
    # blade de-ice slip ring + distributor box on top of the bifilar, cables to each blade cuff
    parts = [prim_cylinder(0.05, 0.05, 0.10, n=16, center=(0, 0, 0.30)),
             prim_rbox((0.30, 0.20, 0.07), (0, 0, 0.43), r=0.02, n=2)]
    v, f = prim_rbox((0.24, 0.16, 0.03), (0, 0, 0.475), r=0.015, n=2)
    parts.append((v, f))
    cables = []
    for i in range(4):
        th = i * math.pi / 2
        pth = [(0.10, 0.03, 0.36), (0.26, 0.06, 0.31), (0.46, 0.09, 0.19), (0.66, 0.10, 0.09)]
        cables += _rot([prim_tube([Vector(p) for p in pth], 0.008, n=6)], th)
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_slipring', v, f, mat=M['metal_dark'], smooth=True, sharp_deg=40))
    v, f = merge_parts(cables)
    objs.append(new_mesh_obj('_deice', v, f, mat=M['rubber'], smooth=True))
    # laminated elastomeric bearings inside each loop (alternating rubber / steel shims) + the spindle stub through them
    rub, shim = [], []
    for i in range(4):
        th = i * math.pi / 2
        for k in range(9):
            r0 = 0.235 + k * 0.018
            rad = 0.105 - 0.004 * abs(k - 4)
            (rub if k % 2 == 0 else shim).extend(_rot([prim_cylinder(rad, rad, 0.018, n=20, axis='X', center=(r0, 0, 0))], th))
    v, f = merge_parts(rub)
    objs.append(new_mesh_obj('_elasto', v, f, mat=M['rubber'], smooth=True, sharp_deg=50))
    v, f = merge_parts(shim)
    objs.append(new_mesh_obj('_shim', v, f, mat=M['metal'], smooth=True, sharp_deg=50))
    # bifilar vibration absorber on top: four-arm support plate + pendulum masses hanging in forks at the arm ends
    parts = []
    parts.append(prim_cylinder(0.16, 0.16, 0.06, n=28, center=(0, 0, 0.13)))
    parts.append(prim_cylinder(0.10, 0.07, 0.07, n=24, center=(0, 0, 0.19)))
    parts.append(prim_cylinder(0.06, 0.02, 0.06, n=16, center=(0, 0, 0.26)))
    masses = []
    for i in range(4):
        th = i * math.pi / 2
        arm = [prim_rbox((0.36, 0.11, 0.045), (0.25, 0, 0.16), r=0.015, n=2)]
        for zc in (0.200, 0.075):                                     # fork plates above/below the mass
            arm.append(prim_rbox((0.13, 0.10, 0.022), (0.43, 0, zc), r=0.01, n=2))
        arm.append(prim_rbox((0.03, 0.10, 0.15), (0.365, 0, 0.14), r=0.008, n=2))
        for y in (-0.03, 0.03):                                       # the two bifilar pins
            arm.append(prim_cylinder(0.012, 0.012, 0.15, n=8, center=(0.43, y, 0.065)))
        parts += _rot(arm, th)
        mv, mf = prim_cylinder(0.078, 0.078, 0.095, n=24, center=(0.44, 0, 0.09))
        masses += _rot([(mv, mf), prim_cylinder(0.068, 0.068, 0.11, n=24, center=(0.44, 0, 0.083))], th)
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_bifilar', v, f, mat=M['metal_dark'], smooth=True, sharp_deg=40))
    v, f = merge_parts(masses)
    objs.append(new_mesh_obj('_bifmass', v, f, mat=M['titanium'], smooth=True, sharp_deg=40))
    # pitch control rods (rotating) from the swashplate rotating ring up to the pitch horns on the leading side
    parts = []
    for i in range(4):
        th = i * math.pi / 2
        parts += _rot(_rod((0.30, 0.215, -0.495), (0.40, 0.235, -0.085), 0.018), th)
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_plinks', v, f, mat=M['metal_dark'], smooth=True))
    # colour-coded identification bands on each pitch rod (blade 1..4: yellow, blue, white, red) + white decal band
    for i, key in enumerate(('label_yellow', 'label_blue', 'label_white', 'label_red')):
        th = i * math.pi / 2
        p0, p1 = Vector((0.30, 0.215, -0.495)), Vector((0.40, 0.235, -0.085))
        dd = (p1 - p0).normalized()
        q = p0.lerp(p1, 0.30)
        bands = _rot([prim_tube([q, q + dd * 0.03], 0.0195, n=10)], th)
        q = p0.lerp(p1, 0.55)
        wb = _rot([prim_tube([q, q + dd * 0.07], 0.0192, n=10)], th)
        v, f = merge_parts(bands)
        objs.append(new_mesh_obj(f'_pband{i}', v, f, mat=M[key], smooth=True))
        v, f = merge_parts(wb)
        objs.append(new_mesh_obj(f'_pdecal{i}', v, f, mat=M['label_white'], smooth=True))
    # hydraulic lead-lag dampers: body anchored to the hub on the trailing side, piston rod to the spindle lug
    body, rod = [], []
    for i in range(4):
        th = i * math.pi / 2
        body += _rot([prim_tube([(0.17, -0.25, 0.0), (0.52, -0.21, 0.0)], [0.058, 0.058], n=18),
                      prim_sphere(0.05, n=12, m=8, center=(0.17, -0.25, 0.0)),
                      prim_rbox((0.08, 0.06, 0.10), (0.16, -0.19, 0.0), r=0.012, n=2),        # hub bracket
                      prim_cylinder(0.064, 0.064, 0.05, n=18, axis='X', center=(0.46, -0.214, 0.0))], th)
        rod += _rot([prim_tube([(0.52, -0.21, 0.0), (0.74, -0.18, 0.0)], 0.022, n=10),
                     prim_sphere(0.032, n=10, m=6, center=(0.745, -0.18, 0.0))], th)
    v, f = merge_parts(body)
    objs.append(new_mesh_obj('_dampers', v, f, mat=M['metal_dark'], smooth=True))
    # yellow caution labels on the dampers
    labs = []
    for i in range(4):
        labs += _rot([prim_tube([Vector((0.30, -0.235, 0.0)), Vector((0.36, -0.228, 0.0))], 0.0595, n=18)], i * math.pi / 2)
    v, f = merge_parts(labs)
    objs.append(new_mesh_obj('_dlabel', v, f, mat=M['label_yellow'], smooth=True))
    v, f = merge_parts(rod)
    objs.append(new_mesh_obj('_damprod', v, f, mat=M['chrome'], smooth=True))
    # rotating scissors (mast to the swashplate rotating ring)
    parts = []
    for sgn in (1, -1):
        parts.append(prim_tube([(0.12 * sgn, 0.0, -0.30), (0.22 * sgn, 0.06, -0.39), (0.29 * sgn, 0.0, -0.485)], 0.018, n=8))
        parts.append(prim_sphere(0.03, n=10, m=6, center=(0.22 * sgn, 0.06, -0.39)))
    v, f = merge_parts(parts)
    objs.append(new_mesh_obj('_rscis', v, f, mat=M['metal_dark'], smooth=True))
    join([rot] + objs, 'rotor_main')


def cuff_mesh():
    """Spindle + blade cuff in the blade frame (origin = elastomeric focal point / flap hinge, span +X, LE +Y):
    spindle through the bearing, pitch horn (leading side), damper lug (trailing side), clevis cuff with two
    retention / fold pins clamping the blade root, and the trailing-edge trim tab."""
    parts = []
    r0, r1 = 5.9 - HINGE_R, 6.6 - HINGE_R
    parts.append(prim_box((r1 - r0, 0.06, 0.006), center=((r0 + r1) / 2, -0.75 * CHORD - 0.025, 0.0)))
    # spindle (starts inside the bearing, exits through the loop bridge)
    parts.append(prim_cylinder(0.072, 0.072, 0.30, n=20, axis='X', center=(-0.16, 0, 0)))
    v, f = prim_cylinder(0.075, 0.095, 0.30, n=20, axis='X', center=(0.13, 0, 0))
    parts.append((v, f))
    # pitch horn toward the leading edge + its clevis for the pitch rod (rod end sits at hub-frame radius ~0.40)
    parts.append(prim_rbox((0.07, 0.20, 0.05), (0.02, 0.13, -0.045), r=0.012, n=2))
    parts.append(prim_cylinder(0.022, 0.022, 0.07, n=10, center=(0.02, 0.235, -0.12)))
    # damper lug on the trailing side
    parts.append(prim_rbox((0.08, 0.13, 0.07), (0.36, -0.11, 0.0), r=0.015, n=2))
    # clevis cuff: upper / lower straps around the blade root, joined at the inboard end
    parts.append(prim_rbox((0.16, 0.24, 0.20), (0.50, 0, 0), r=0.04, n=3))
    for zc in (0.058, -0.058):          # forged clevis straps (narrow, thick) clamping the blade root
        v, f = prim_rbox((0.62, 0.19, 0.05), (0.86, 0, zc), r=0.02, n=3)
        v = [(x, y * (1.0 + 0.45 * max(0.0, (x - 0.7) / 0.5)), z) for x, y, z in v]
        parts.append((v, f))
    for x in (0.74, 1.00):                                             # blade retention / fold pins
        parts.append(prim_cylinder(0.034, 0.034, 0.16, n=14, center=(x, 0.0, -0.08)))
        for zc in (0.078, -0.078):
            parts.append(prim_cylinder(0.046, 0.046, 0.012, n=6, center=(x, 0.0, zc - 0.006)))
    return merge_parts(parts)


def cuff_bright_mesh():
    """Bare-metal retention plates on the cuff sides and the white BIM (blade inspection method) pressure indicator."""
    plates, bim = [], []
    for sy in (-1, 1):
        plates.append(prim_rbox((0.30, 0.010, 0.13), (0.64, sy * 0.125, 0.0), r=0.02, n=2))
        for x in (0.54, 0.62, 0.70):
            plates.append(prim_cylinder(0.009, 0.009, 0.012, n=6, axis='Y', center=(x, sy * 0.135, 0.03)))
    bim.append(prim_cylinder(0.030, 0.030, 0.07, n=14, axis='X', center=(0.43, 0.10, 0.06)))
    bim.append(prim_cylinder(0.022, 0.018, 0.03, n=14, axis='X', center=(0.50, 0.10, 0.06)))
    return merge_parts(plates), merge_parts(bim)


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
    # rotating ring (upper) with four pitch-rod lugs, bearing race, stationary star (lower) with three servo lugs
    parts.append(prim_cylinder(0.31, 0.31, 0.045, n=40, center=(0, 0, 0.015)))
    parts.append(prim_cylinder(0.25, 0.25, 0.03, n=40, center=(0, 0, 0.055)))
    for i in range(4):
        th = i * math.pi / 2
        v, f = prim_rbox((0.10, 0.07, 0.05), (0.33, 0.215, 0.035), r=0.012, n=2)
        parts.append((transform_verts(v, Matrix.Rotation(th, 4, 'Z')), f))
    parts.append(prim_cylinder(0.27, 0.27, 0.02, n=40, center=(0, 0, -0.012)))
    parts.append(prim_cylinder(0.33, 0.30, 0.05, n=40, center=(0, 0, -0.06)))
    parts.append(prim_cylinder(0.16, 0.16, 0.20, n=28, center=(0, 0, -0.16)))    # uniball / guide
    for i in range(3):   # primary servos (transmission deck -> stationary star)
        th = i * 2 * math.pi / 3 + math.pi / 6
        c = (0.34 * math.cos(th), 0.34 * math.sin(th))
        parts.append(prim_rbox((0.09, 0.09, 0.07), (c[0], c[1], -0.07), r=0.015, n=2))
        parts.append(prim_cylinder(0.055, 0.055, 0.12, n=16, center=(c[0] * 1.04, c[1] * 1.04, -0.26)))
        parts.append(prim_cylinder(0.03, 0.03, 0.12, n=12, center=(c[0] * 1.02, c[1] * 1.02, -0.16)))
        parts.append(prim_rbox((0.13, 0.10, 0.07), (c[0] * 1.06, c[1] * 1.06, -0.20), r=0.015, n=2))   # servo valve block
    # stationary scissors
    v, f = prim_tube([(0.0, -0.33, -0.05), (0.0, -0.31, -0.18), (0.0, -0.18, -0.26)], 0.018, n=8)
    parts.append((v, f))
    return merge_parts(parts)


# ------------------------------------------------------------------------------------------------ tail rotor
def build_tail_rotor(M, root):
    """rotor_tail: origin on the shaft axis at the hub, local +X = shaft axis outboard (canted 20 deg up).
    Bearingless crossbeam rotor: two composite spars clamped between hub plates, pitch-change spider outboard with
    four links to the blade pitch horns, conical cap; blades have a torque-tube root cuff and a tip cap."""
    parts = []
    parts.append(prim_cylinder(0.055, 0.055, 0.34, n=16, axis='-X', center=(-0.03, 0, 0)))       # output shaft
    parts.append(prim_cylinder(0.13, 0.13, 0.035, n=24, axis='X', center=(-0.075, 0, 0)))        # inboard hub plate
    parts.append(prim_cylinder(0.12, 0.12, 0.03, n=24, axis='X', center=(0.075, 0, 0)))          # outboard hub plate
    for k in range(8):                                                                             # clamp bolts
        a = 2 * math.pi * (k + 0.5) / 8
        parts.append(prim_cylinder(0.011, 0.011, 0.19, n=6, axis='X', center=(-0.085, 0.095 * math.cos(a), 0.095 * math.sin(a))))
    for k in range(2):   # two crossbeam spars (flat), each carrying two opposite blades
        a = k * math.pi / 2
        Mr = Matrix.Rotation(a, 4, 'X')
        v, f = prim_rbox((0.05 if k else 0.045, 0.085, 0.64), (-0.02 + 0.05 * k - 0.025, 0, 0), r=0.01, n=2)
        parts.append((transform_verts(v, Mr), f))
    # pitch-change spider (4 arms) on the shaft outboard of the hub + links to the pitch horns
    parts.append(prim_cylinder(0.05, 0.05, 0.07, n=16, axis='X', center=(0.12, 0, 0)))
    for k in range(4):
        a = k * math.pi / 2 + math.radians(24)
        Mr = Matrix.Rotation(a, 4, 'X')
        v, f = prim_rbox((0.03, 0.035, 0.16), (0.14, 0, 0.09), r=0.008, n=2)
        parts.append((transform_verts(v, Mr), f))
        p0 = Mr @ Vector((0.14, 0, 0.165))
        p1 = Matrix.Rotation(k * math.pi / 2, 4, 'X') @ Vector((0.03, -0.06, 0.30))
        parts += _rod(p0, p1, 0.009, n=6)
    parts.append(prim_cylinder(0.075, 0.018, 0.13, n=20, axis='X', center=(0.155, 0, 0)))       # spinner cap
    v, f = merge_parts(parts)
    tr = new_mesh_obj('rotor_tail', v, f, mat=M['metal'], smooth=True, sharp_deg=40)
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
        # torque-tube root cuff (elliptic) with the pitch horn, and a metal tip cap
        cp = []
        rr = []
        for r_, sc_ in ((0.24, 0.9), (0.30, 1.0), (0.40, 1.0), (0.47, 0.75)):
            ring = [(0.06 * (k % 2) + 0.030 * sc_ * math.cos(t_), 0.075 * sc_ * math.sin(t_), r_) for t_ in np.linspace(0, 2 * math.pi, 16, endpoint=False)]
            rr.append(np.array(ring))
        cv, cf = loft_rings(rr, cap_start='fan', cap_end='fan')
        cp.append((cv, cf))
        cp.append(prim_rbox((0.03, 0.08, 0.03), (0.03 + 0.06 * (k % 2), -0.06, 0.30), r=0.008, n=2))
        cv, cf = merge_parts(cp)
        cuff = new_mesh_obj(f'_tcuff{k}', cv, cf, mat=M['metal_dark'], smooth=True, sharp_deg=45)
        from lib import join as _join
        tipc = new_mesh_obj(f'_ttip{k}', *prim_box((0.03, TR_CHORD * 0.95, 0.05), center=(0.06 * (k % 2), 0.0, R_TAIL - 0.02)),
                            mat=M['blade_tip'], smooth=False)
        b = _join([b, cuff, tipc], f'tail_blade_{k + 1}')
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
