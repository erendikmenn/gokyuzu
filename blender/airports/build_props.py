"""W4 airport props: parked aircraft LODs + ground vehicles -> assets/sf/airports/props.glb

Run: /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/airports/build_props.py -- [--render out.png]

Every prop is a top-level empty (glTF node) with vertex-coloured child meshes (one shared material 'prop_paint';
floodlight lamps use 'prop_lamp' which is emissive). Aircraft tails are separate '<name>_tail' meshes so the runtime
can tint liveries with InstancedMesh.instanceColor.
Frame: Blender +Y = nose/forward, +Z up, +X right. Origins: aircraft = nose-wheel ground contact (helicopter: rotor
mast on the ground), vehicles/windsock/floodlight = ground centre.
"""
import sys, os, math
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'common'))
sys.path.insert(0, HERE)
from util import reset_scene, export_glb, setup_cycles, add_camera, nishita_sky, add_sun, render_still, REPO  # noqa
from props_geom import MB, loft, ellipse, cylinder, box, prism, wheel, wing_section, fin_section, mirror_x, add_lin, ring_perp  # noqa

OUT = os.path.join(REPO, 'assets', 'sf', 'airports', 'props.glb')

# ------------------------------------------------------------------ palette (sRGB)
WHITE = (0.93, 0.93, 0.94)
BELLY = (0.74, 0.75, 0.77)
WINGG = (0.70, 0.71, 0.73)
DARK = (0.06, 0.07, 0.08)
WIN = (0.10, 0.12, 0.16)
TYRE = (0.06, 0.06, 0.06)
METAL = (0.45, 0.46, 0.48)
HUB = (0.62, 0.63, 0.65)
DOOR = (0.80, 0.81, 0.83)
NACELLE = (0.86, 0.87, 0.88)
FAN = (0.14, 0.14, 0.15)
EXH = (0.30, 0.30, 0.31)


def make_materials():
    def mat(name, rough, emissive=None):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get('Principled BSDF')
        ca = nt.nodes.new('ShaderNodeVertexColor')
        ca.layer_name = 'Col'
        nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = 0.0
        if emissive:
            bsdf.inputs['Emission Color'].default_value = (*emissive, 1)
            bsdf.inputs['Emission Strength'].default_value = 1.0
        return m
    return mat('prop_paint', 0.48), mat('prop_lamp', 0.3, emissive=(1.0, 0.85, 0.62))


PAINT, LAMP = None, None


def new_root(name, loc):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.location = loc
    e.empty_display_size = 1
    return e


def finish(root, parts):
    """parts: list of (suffix, MB, material)."""
    tris = 0
    for suf, mb, mat in parts:
        if not mb.f:
            continue
        mb.to_object(f'{root.name}{suf}', mat, parent=root)
        tris += mb.tris
    print(f'  {root.name}: {tris} tris')
    return tris


# ================================================================== airliners
def airliner(name, P, loc):
    """Generic twin-engine airliner. P: dict of dimensions (see NARROW/WIDE)."""
    root = new_root(name, loc)
    body, tail = MB(), MB()
    ny = P['nose']                 # nose tip y (nose gear at 0)
    L = P['L']
    R, RZ, zc = P['R'], P['R'] * 1.03, P['zc']
    n = 24
    # ---- fuselage loft: (distance from nose tip, radius factor, centre z offset)
    prof = [(0.0, 0.03, -0.55), (0.35, 0.28, -0.45), (0.9, 0.5, -0.33), (1.7, 0.7, -0.2), (2.6, 0.84, -0.1), (3.6, 0.93, -0.04),
            (4.8, 0.985, 0.0), (6.2, 1.0, 0.0)]
    cyl_end = L * P.get('cyl_end', 0.71)
    k = 6.2 + 2.2
    while k < cyl_end - 0.1:
        prof.append((k, 1.0, 0.0))
        k += 2.2
    prof.append((cyl_end, 1.0, 0.0))
    tc = L - cyl_end
    for f, rf, dz in ((0.2, 0.93, 0.08), (0.42, 0.76, 0.22), (0.63, 0.55, 0.36), (0.82, 0.33, 0.46), (0.95, 0.16, 0.52), (1.0, 0.08, 0.53)):
        prof.append((cyl_end + tc * f, rf, dz * R * 2))
    sections = []
    for d, rf, dz in prof:
        y = ny - d
        # tail cone flattens its underside (upsweep): lower half squashed
        sb = 1.0 if d <= cyl_end else max(0.35, 1.0 - (d - cyl_end) / tc * 0.8)
        sections.append(ellipse(0, y, zc + dz, max(0.02, R * rf), max(0.02, RZ * rf), n, 1.0, sb, phase=-math.pi / 2))
    cockpit_rng = (1.55 * P['cs'], 2.45 * P['cs'])
    side_rng = (2.45 * P['cs'], 3.25 * P['cs'])

    def fus_color(c, si, seg):
        d = ny - c.y
        # angle from +X in the x-z plane about the section centre
        zz = c.z - zc
        a = math.degrees(math.atan2(zz, c.x))
        if zz < -0.62 * R:
            return BELLY
        return WHITE
    loft(body, sections, fus_color, smooth=True, cap0=False, cap1=True, cap_color=EXH)
    # ---- cockpit windshield panes: quads sampled on the nose surface, lifted 2 cm
    def nose_pt(dist, ang, lift=0.02):
        for (d0, r0, z0), (d1, r1, z1) in zip(prof, prof[1:]):
            if d0 <= dist <= d1:
                t = (dist - d0) / (d1 - d0)
                rf, dz = r0 + (r1 - r0) * t, z0 + (z1 - z0) * t
                break
        a = math.radians(ang)
        rr, rz = R * rf + lift, RZ * rf + lift
        return (rr * math.cos(a), ny - dist, zc + dz + rz * math.sin(a))
    cs = P['cs']
    panes = [((1.85, 2.42), (60, 87)), ((1.85, 2.42), (93, 120)), ((2.3, 2.95), (33, 56)), ((2.3, 2.95), (124, 147)),
             ((3.0, 3.5), (30, 50)), ((3.0, 3.5), (130, 150))]
    for (d0, d1), (a0, a1) in panes:
        d0, d1 = d0 * cs, d1 * cs
        # top edge slightly narrower (windows taper toward the crown)
        pts = [nose_pt(d0, a0), nose_pt(d0, a1), nose_pt(d1, a1 - 3), nose_pt(d1, a0 + 3)]
        mid = sum((Vector(p) for p in pts), Vector((0, 0, 0))) / 4
        from props_geom import _orient  # noqa
        idx = [body.vert(p) for p in pts]
        body.face(_orient(body, idx, Vector((0, mid.y, zc))), WIN)
    # ---- passenger windows + doors (thin quads just outside the skin)
    wz = zc + P['win_z'] * R
    xw = math.sqrt(max(0.0, 1 - ((wz - zc) / RZ) ** 2)) * R + 0.035
    d = P['win_start']
    exits = P.get('exits', [])
    while d < P['win_end']:
        if not any(a <= d <= b for a, b in exits):
            y = ny - d
            for sg in (1, -1):
                hw, hh = 0.12 * P['ws'], 0.17 * P['ws']
                pts = [(sg * xw, y - hw, wz - hh), (sg * xw, y + hw, wz - hh), (sg * xw, y + hw, wz + hh), (sg * xw, y - hw, wz + hh)]
                if sg < 0:
                    pts = pts[::-1]
                body.poly(pts, WIN)
        d += P['pitch']
    for dd in P['doors']:
        y = ny - dd
        for sg in (1, -1):
            x = xw + 0.004
            dw, dh = 0.45 * P['ws'], 0.95 * P['ws']
            z0 = wz - 0.55 * P['ws']
            pts = [(sg * x, y - dw, z0 - dh), (sg * x, y + dw, z0 - dh), (sg * x, y + dw, z0 + dh * 0.9), (sg * x, y - dw, z0 + dh * 0.9)]
            if sg < 0:
                pts = pts[::-1]
            body.poly(pts, DOOR)
    # ---- wing-body fairing
    fy0 = P['wing_le'] + 1.5
    fz = zc - 0.62 * R
    fair = [ellipse(0, fy0, fz + 0.25, R * 0.55, R * 0.25, 12), ellipse(0, fy0 - 2.5, fz, R * 1.05, R * 0.45, 12),
            ellipse(0, P['wing_le'] - P['root_chord'] + 0.5, fz, R * 1.05, R * 0.45, 12),
            ellipse(0, P['wing_le'] - P['root_chord'] - 2.5, fz + 0.3, R * 0.5, R * 0.22, 12)]
    loft(body, fair, BELLY, smooth=True)
    # ---- wings (root, kink, tip), mirrored
    wing = MB()
    rx = R * 0.8
    wz0 = zc - P['wing_drop'] * R
    tan_sw = math.tan(math.radians(P['sweep']))
    semi = P['span'] / 2
    dih = math.tan(math.radians(P['dihedral']))
    le = lambda x: P['wing_le'] - (x - rx) * tan_sw
    zf = lambda x: wz0 + (x - rx) * dih
    kx = P['kink']
    te_root = P['wing_le'] - P['root_chord']
    secs = [wing_section(rx, le(rx), P['root_chord'], zf(rx), P['t_root']),
            wing_section(kx, le(kx), le(kx) - te_root, zf(kx), P['t_root'] * 0.62),
            wing_section(semi - 0.05, le(semi - 0.05), P['tip_chord'], zf(semi - 0.05), P['t_root'] * 0.22)]
    loft(wing, secs, WINGG, smooth=False)
    if P.get('winglet'):
        tx = semi - 0.05
        z0 = zf(tx)
        wl = [fin_section(z0, le(tx), P['tip_chord'], tx, 0.14), fin_section(z0 + P['winglet'], le(tx) - P['winglet'] * 0.75, P['tip_chord'] * 0.45, tx + 0.35, 0.07)]
        loft(wing, wl, WHITE, smooth=False)
    # ---- engine + pylon
    ex, ez, er, el = P['eng_x'], P['eng_z'], P['eng_r'], P['eng_len']
    ey0 = le(ex) + P['eng_fwd']
    eng = [ellipse(ex, ey0, ez, er * 0.9, er * 0.9, 16), ellipse(ex, ey0 - 0.08 * el, ez, er, er, 16),
           ellipse(ex, ey0 - 0.35 * el, ez, er * 1.02, er * 1.02, 16), ellipse(ex, ey0 - 0.78 * el, ez, er * 0.8, er * 0.8, 16)]
    loft(wing, eng, NACELLE, smooth=True, cap0=True, cap1=False, cap_color=FAN)
    loft(wing, [ellipse(ex, ey0 - 0.78 * el, ez, er * 0.62, er * 0.62, 12), ellipse(ex, ey0 - 1.02 * el, ez - 0.02, er * 0.12, er * 0.12, 12)], EXH, smooth=True, cap0=True, cap1=True)
    # pylon
    py_top = zf(ex)
    prism(wing, [(ey0 - 0.25 * el, ez + er * 0.8), (ey0 - 0.95 * el, ez + er * 0.5), (le(ex) - (le(ex) - (P['wing_le'] - P['root_chord'])) * 0.8, py_top), (ey0 - 0.1 * el, py_top + 0.05)],
          ex - 0.18, ex + 0.18, WHITE)
    # ---- main gear (per side) + mirror
    gy = -P['wheelbase']
    gx = P['track'] / 2
    wr = P['main_r']
    for bog in P['bogie']:            # y offsets of axles
        for dx in (-P['wheel_dx'], P['wheel_dx']):
            wheel(wing, (gx + dx, gy + bog, wr), wr, wr * 0.55, 12, TYRE, HUB)
    cylinder(wing, (gx, gy, wr), (gx, gy + 0.3, zf(gx) - 0.1), 0.14 * P['ws'], None, 8, METAL)
    if len(P['bogie']) > 1:
        cylinder(wing, (gx, gy + min(P['bogie']) - 0.3, wr), (gx, gy + max(P['bogie']) + 0.3, wr), 0.1, None, 6, METAL)
    add_lin(body, wing)
    add_lin(body, mirror_x(wing))
    # ---- nose gear
    nr = P['nose_r']
    for dx in (-0.22 * P['ws'], 0.22 * P['ws']):
        wheel(body, (dx, 0, nr), nr, nr * 0.55, 10, TYRE, HUB)
    cylinder(body, (0, 0, nr), (0, 0.25, zc - R * 0.8), 0.1 * P['ws'], None, 8, METAL)
    # ---- horizontal tail
    ht = MB()
    hrx = R * 0.25
    hz = zc + P['ht_z'] * R
    ht_le = ny - L + P['ht_from_end']
    hsw = math.tan(math.radians(P['sweep'] + 5))
    hs = [wing_section(hrx, ht_le, P['ht_chord'], hz, 0.28 * P['ws']),
          wing_section(P['ht_span'] / 2, ht_le - (P['ht_span'] / 2 - hrx) * hsw, P['ht_chord'] * 0.38, hz + (P['ht_span'] / 2) * 0.1, 0.1 * P['ws'])]
    loft(ht, hs, WHITE, smooth=False)
    add_lin(body, ht)
    add_lin(body, mirror_x(ht))
    # ---- vertical tail (livery tintable)
    vz0 = zc + P['vt_z0'] * R
    vle = ny - L + P['vt_from_end']
    vh = P['height'] - vz0
    vs = [fin_section(vz0 - 0.4, vle + 0.6, P['vt_chord'] + 0.8, 0, 0.5 * P['ws']),
          fin_section(vz0, vle, P['vt_chord'], 0, 0.45 * P['ws']),
          fin_section(P['height'], vle - vh * math.tan(math.radians(P['vt_sweep'])), P['vt_chord'] * 0.36, 0, 0.16 * P['ws'])]
    loft(tail, vs, WHITE, smooth=False)
    return finish(root, [('_body', body, PAINT), ('_tail', tail, PAINT)])


NARROW = dict(L=37.6, nose=5.1, R=1.98, zc=3.95, cs=1.0, ws=1.0, win_z=0.2, win_start=6.3, win_end=29.0, pitch=0.53,
              exits=[(13.0, 14.6)], doors=[4.4, 32.4], wing_le=-7.3, root_chord=6.3, kink=6.3, span=35.8, sweep=27.0,
              dihedral=5.1, wing_drop=0.62, tip_chord=1.6, t_root=0.75, winglet=2.3, eng_x=5.75, eng_z=1.78, eng_r=1.16,
              eng_len=4.6, eng_fwd=2.6, wheelbase=12.64, track=7.59, main_r=0.58, wheel_dx=0.46, bogie=[0.0], nose_r=0.38,
              ht_z=0.35, ht_from_end=7.4, ht_chord=3.6, ht_span=12.45, vt_z0=0.55, vt_from_end=8.8, vt_chord=6.2, vt_sweep=38,
              height=11.76, cyl_end=0.70)
WIDE = dict(L=62.8, nose=6.8, R=2.95, zc=5.55, cs=1.35, ws=1.25, win_z=0.25, win_start=8.5, win_end=50.0, pitch=0.55,
            exits=[(25.0, 26.6)], doors=[6.0, 17.5, 38.0, 54.5], wing_le=-13.8, root_chord=11.6, kink=10.2, span=60.1, sweep=32.0,
            dihedral=6.0, wing_drop=0.6, tip_chord=2.4, t_root=1.3, winglet=0, eng_x=9.9, eng_z=2.75, eng_r=1.85,
            eng_len=7.0, eng_fwd=3.6, wheelbase=26.8, track=9.8, main_r=0.66, wheel_dx=0.72, bogie=[-0.85, 0.85], nose_r=0.55,
            ht_z=0.3, ht_from_end=11.5, ht_chord=6.0, ht_span=19.8, vt_z0=0.55, vt_from_end=13.3, vt_chord=10.2, vt_sweep=40,
            height=17.0, cyl_end=0.72)


# ================================================================== fighters
def fighter_f16(loc):
    root = new_root('fighter_f16', loc)
    mb = MB()
    zc = 1.95
    UP, LO, RAD = (0.36, 0.39, 0.42), (0.52, 0.55, 0.57), (0.30, 0.31, 0.33)
    col = lambda c, si, seg: RAD if c.y > 3.6 else (UP if c.z > zc + 0.05 else LO)
    fs = [(5.0, 0.03, 0.03, -0.05), (4.4, 0.3, 0.3, -0.02), (3.6, 0.48, 0.48, 0.0), (2.6, 0.6, 0.62, 0.02), (1.6, 0.66, 0.72, 0.05),
          (0.4, 0.72, 0.75, 0.05), (-1.0, 0.95, 0.72, 0.0), (-3.0, 1.1, 0.72, 0.0), (-5.0, 0.95, 0.7, 0.0), (-7.0, 0.78, 0.66, 0.0),
          (-8.6, 0.62, 0.6, 0.0), (-9.4, 0.55, 0.55, 0.0)]
    loft(mb, [ellipse(0, y, zc + dz, rx, rz, 16, 1.0, 0.85, -math.pi / 2) for y, rx, rz, dz in fs], col, True, False, False)
    # nozzle
    loft(mb, [ellipse(0, -9.4, zc, 0.55, 0.55, 14), ellipse(0, -10.06, zc, 0.47, 0.47, 14)], EXH, True, False, True, (0.12, 0.12, 0.12))
    # canopy (gold tinted)
    loft(mb, [ellipse(0, y, zc + dz, rx, rz, 12, 1.0, 0.2) for y, rx, rz, dz in
              ((3.3, 0.05, 0.05, 0.45), (2.8, 0.36, 0.4, 0.5), (1.8, 0.44, 0.5, 0.52), (0.6, 0.4, 0.44, 0.5), (-0.3, 0.2, 0.25, 0.55))],
         (0.30, 0.26, 0.14), True)
    # spine
    loft(mb, [ellipse(0, y, zc + dz, rx, rz, 10, 1.0, 0.3) for y, rx, rz, dz in ((-0.3, 0.25, 0.3, 0.55), (-3.0, 0.35, 0.3, 0.6), (-6.2, 0.3, 0.22, 0.55))], UP, True)
    # ventral intake
    loft(mb, [ellipse(0, y, z, rx, rz, 12) for y, z, rx, rz in ((4.35, 1.2, 0.5, 0.38), (3.0, 1.18, 0.55, 0.45), (0.5, 1.35, 0.58, 0.45), (-2.5, 1.55, 0.55, 0.35))],
         LO, True, True, False, FAN)
    half = MB()
    # wing
    loft(half, [wing_section(0.85, -2.2, 4.9, zc, 0.24), wing_section(4.72, -2.2 - 3.87 * math.tan(math.radians(40)), 1.05, zc, 0.06)], UP, False)
    # LEX strake
    loft(half, [wing_section(0.6, 2.0, 4.2, zc + 0.08, 0.06), wing_section(1.1, -1.4, 0.6, zc + 0.08, 0.03)], UP, False)
    # stabilator (anhedral)
    loft(half, [wing_section(0.75, -7.3, 2.5, zc - 0.1, 0.12), wing_section(2.8, -8.95, 0.95, zc - 0.45, 0.04)], UP, False)
    # wingtip AIM-9
    cylinder(half, (4.95, -2.9, zc), (4.95, -5.9, zc), 0.065, None, 6, (0.85, 0.85, 0.85))
    for dy in (-5.3, -5.7):
        box(half, (4.95, dy, zc), (0.02, 0.35, 0.5), (0.85, 0.85, 0.85))
    # main gear
    wheel(half, (1.18, -4.0, 0.39), 0.39, 0.22, 10, TYRE, HUB)
    cylinder(half, (1.18, -4.0, 0.39), (0.9, -3.8, 1.35), 0.06, None, 6, METAL)
    add_lin(mb, half)
    add_lin(mb, mirror_x(half))
    # vertical fin
    loft(mb, [fin_section(zc + 0.55, -5.0, 3.8, 0, 0.18), fin_section(4.88, -7.9, 1.25, 0, 0.06)], UP, False)
    # nose gear
    wheel(mb, (0, 0, 0.29), 0.29, 0.16, 10, TYRE, HUB)
    cylinder(mb, (0, 0, 0.29), (0, 0.1, 0.95), 0.05, None, 6, METAL)
    return finish(root, [('_body', mb, PAINT)])


def fighter_f22(loc):
    root = new_root('fighter_f22', loc)
    mb = MB()
    zc = 2.0
    C, CD = (0.50, 0.53, 0.56), (0.42, 0.45, 0.48)
    col = lambda c, si, seg: CD if c.z > zc + 0.2 else C
    fs = [(5.6, 0.03, 0.03, -0.1), (4.8, 0.36, 0.25, -0.06), (3.8, 0.62, 0.38, -0.02), (2.6, 0.82, 0.48, 0.0), (1.2, 1.05, 0.55, 0.0),
          (0.0, 1.55, 0.62, 0.0), (-2.5, 1.78, 0.66, 0.0), (-6.0, 1.72, 0.62, 0.0), (-9.0, 1.5, 0.55, 0.0), (-11.5, 1.25, 0.42, 0.0), (-12.2, 1.2, 0.36, 0.0)]
    # diamond-ish (chined) cross section: 8 points
    def chine(y, rx, rz, dz):
        z = zc + dz
        return [(rx, y, z), (rx * 0.6, y, z + rz * 0.75), (0, y, z + rz), (-rx * 0.6, y, z + rz * 0.75), (-rx, y, z), (-rx * 0.6, y, z - rz * 0.8), (0, y, z - rz * 0.9), (rx * 0.6, y, z - rz * 0.8)]
    loft(mb, [chine(*s) for s in fs], col, False, False, False)
    # 2D nozzles
    for sx in (-0.62, 0.62):
        box(mb, (sx, -12.75, zc), (1.0, 1.1, 0.55), EXH, colors={'back': (0.1, 0.1, 0.1)})
    # canopy
    loft(mb, [ellipse(0, y, zc + dz, rx, rz, 12, 1.0, 0.2) for y, rx, rz, dz in
              ((3.9, 0.05, 0.05, 0.42), (3.2, 0.42, 0.42, 0.45), (2.0, 0.52, 0.55, 0.47), (0.6, 0.46, 0.45, 0.5), (-0.6, 0.12, 0.2, 0.55))],
         (0.42, 0.34, 0.14), True)
    half = MB()
    # caret intake (side box)
    prism(half, [(1.3, zc - 0.55), (1.3, zc + 0.3), (-2.8, zc + 0.35), (-2.8, zc - 0.55)], 1.0, 1.55, C, colors={'rim': lambda m: FAN if m.y > 1.2 else C})
    # wing: diamond
    loft(half, [wing_section(1.5, -1.3, 8.2, zc - 0.05, 0.3), wing_section(6.78, -1.3 - 5.28 * math.tan(math.radians(42)), 1.7, zc - 0.05, 0.06)], C, False)
    # horizontal tail
    loft(half, [wing_section(1.35, -9.7, 3.4, zc - 0.1, 0.12), wing_section(4.4, -11.6, 1.6, zc - 0.1, 0.04)], C, False)
    # canted vertical tail
    loft(half, [fin_section(zc + 0.45, -7.4, 4.4, 1.35, 0.18), fin_section(5.08, -10.1, 1.7, 1.35 + (5.08 - zc - 0.45) * math.tan(math.radians(28)), 0.06)], CD, False)
    wheel(half, (1.6, -6.0, 0.42), 0.42, 0.24, 10, TYRE, HUB)
    cylinder(half, (1.6, -6.0, 0.42), (1.3, -5.8, 1.4), 0.07, None, 6, METAL)
    add_lin(mb, half)
    add_lin(mb, mirror_x(half))
    wheel(mb, (0, 0, 0.33), 0.33, 0.18, 10, TYRE, HUB)
    cylinder(mb, (0, 0, 0.33), (0, 0.15, 1.35), 0.06, None, 6, METAL)
    return finish(root, [('_body', mb, PAINT)])


def heli_uh60(loc):
    root = new_root('heli_uh60', loc)
    mb = MB()
    OD, ODD = (0.27, 0.29, 0.21), (0.22, 0.24, 0.17)
    zc = 1.85
    fs = [(5.35, 0.05, 0.05, -0.2), (5.0, 0.55, 0.55, -0.15), (4.3, 0.88, 0.85, -0.05), (3.1, 1.08, 0.96, 0.0), (1.6, 1.14, 0.98, 0.02),
          (-0.4, 1.14, 0.98, 0.02), (-1.7, 0.95, 0.85, 0.18), (-3.0, 0.48, 0.5, 0.45), (-6.0, 0.32, 0.36, 0.62), (-8.8, 0.24, 0.3, 0.78)]
    def col(c, si, seg):
        a = math.degrees(math.atan2(c.z - zc, c.x))
        if 3.2 < c.y < 4.95 and c.z > zc - 0.05 and (5 < a < 85 or 95 < a < 175):
            return WIN
        if 1.6 < c.y < 2.9 and zc + 0.05 < c.z < zc + 0.6 and (a < 40 or a > 140):
            return WIN
        return OD
    loft(mb, [ellipse(0, y, zc + dz, rx, rz, 16, 1.0, 0.8, -math.pi / 2) for y, rx, rz, dz in fs], col, True, False, True)
    # engine nacelles + doghouse
    for sx in (-0.55, 0.55):
        loft(mb, [ellipse(sx, 1.2, 2.95, 0.3, 0.3, 10), ellipse(sx, 0.9, 3.0, 0.38, 0.36, 10), ellipse(sx, -1.4, 3.0, 0.36, 0.34, 10), ellipse(sx, -2.0, 2.95, 0.2, 0.2, 10)],
             ODD, True, True, True, (0.1, 0.1, 0.1))
    box(mb, (0, 0.4, 2.95), (0.9, 2.6, 0.5), ODD)
    # tail pylon + stabilator
    loft(mb, [fin_section(2.3, -8.6, 1.3, 0, 0.3), fin_section(4.3, -9.7, 0.9, 0, 0.18)], OD, False)
    half = MB()
    loft(half, [wing_section(0.2, -8.7, 1.1, 2.05, 0.1), wing_section(2.2, -8.8, 0.9, 2.05, 0.06)], OD, False)
    wheel(half, (1.37, 2.9, 0.39), 0.39, 0.2, 10, TYRE, HUB)
    cylinder(half, (1.37, 2.9, 0.39), (0.95, 2.6, 1.2), 0.06, None, 6, METAL)
    cylinder(half, (1.37, 2.9, 0.39), (0.95, 3.4, 1.1), 0.05, None, 6, METAL)
    add_lin(mb, half)
    add_lin(mb, mirror_x(half))
    wheel(mb, (0, -8.3, 0.23), 0.23, 0.12, 8, TYRE, HUB)
    cylinder(mb, (0, -8.3, 0.23), (0, -8.1, 1.9), 0.05, None, 6, METAL)
    # mast + hub
    cylinder(mb, (0, 0, 3.2), (0, 0, 3.72), 0.16, 0.13, 10, METAL)
    cylinder(mb, (0, 0, 3.62), (0, 0, 3.85), 0.45, 0.3, 10, (0.2, 0.2, 0.2))
    # main rotor: 4 drooping blades
    BL = (0.12, 0.12, 0.12)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        u = Vector((math.cos(a), math.sin(a), 0))
        w = Vector((-math.sin(a), math.cos(a), 0))
        p0 = Vector((0, 0, 3.74)) + u * 0.4
        p1 = Vector((0, 0, 3.74 - 0.55)) + u * 8.18
        c = 0.27
        pts = [p0 - w * c, p1 - w * c, p1 + w * c, p0 + w * c]
        mb.poly([tuple(p) for p in pts], BL)
        mb.poly([tuple(p + Vector((0, 0, -0.04))) for p in reversed(pts)], BL)
    # tail rotor (on the right side, disc in the y-z plane)
    for k in range(4):
        a = math.radians(20 + 90 * k)
        u = Vector((0, math.cos(a), math.sin(a)))
        cen = Vector((0.32, -9.55, 3.9))
        p1 = cen + u * 1.68
        w = Vector((0, -math.sin(a), math.cos(a))) * 0.12
        pts = [cen - w, p1 - w, p1 + w, cen + w]
        mb.poly([tuple(p) for p in pts], BL)
        mb.poly([tuple(p + Vector((0.03, 0, 0))) for p in reversed(pts)], BL)
    return finish(root, [('_body', mb, PAINT)])


# ================================================================== vehicles
def wheels4(mb, L, W, r, y0=None, y1=None, width=0.3, n=8, extra_axle=None):
    y0 = L * 0.33 if y0 is None else y0
    y1 = -L * 0.33 if y1 is None else y1
    ys = [y0, y1] + ([extra_axle] if extra_axle is not None else [])
    for y in ys:
        for sx in (-1, 1):
            wheel(mb, (sx * (W / 2 - width / 2 + 0.02), y, r), r, width, n, TYRE, HUB)


def tug(loc):
    root = new_root('tug', loc)
    mb = MB()
    Y = (0.93, 0.74, 0.12)
    box(mb, (0, 0, 0.75), (2.9, 6.0, 0.9), Y)
    box(mb, (0, 1.6, 1.45), (1.9, 1.3, 0.5), Y, colors={'front': WIN, 'left': WIN, 'right': WIN})
    box(mb, (0, 1.6, 1.75), (2.0, 1.4, 0.08), (0.2, 0.2, 0.2))
    box(mb, (0, 3.05, 0.6), (2.3, 0.2, 0.4), (0.15, 0.15, 0.15))
    box(mb, (0.0, 1.6, 1.84), (0.4, 0.2, 0.1), (1.0, 0.5, 0.05))
    wheels4(mb, 6.0, 2.9, 0.55, 2.0, -2.0, 0.45)
    return finish(root, [('_body', mb, PAINT)])


def baggage_tractor(loc):
    root = new_root('baggage_tractor', loc)
    mb = MB()
    C = (0.90, 0.90, 0.88)
    box(mb, (0, 0.2, 0.6), (1.4, 2.8, 0.6), C)
    box(mb, (0, -0.3, 1.35), (1.3, 1.2, 0.9), C, colors={'front': WIN, 'back': WIN, 'left': WIN, 'right': WIN, 'top': C})
    box(mb, (0, -0.3, 1.85), (1.4, 1.35, 0.08), (0.25, 0.25, 0.25))
    box(mb, (0, -0.3, 1.93), (0.3, 0.2, 0.1), (1.0, 0.5, 0.05))
    wheels4(mb, 2.8, 1.4, 0.32, 1.0, -0.9, 0.25)
    return finish(root, [('_body', mb, PAINT)])


def baggage_cart(loc):
    root = new_root('baggage_cart', loc)
    mb = MB()
    box(mb, (0, 0, 0.6), (1.6, 3.0, 0.12), (0.3, 0.3, 0.32))
    box(mb, (0, 0, 1.3), (1.55, 2.95, 1.3), (0.22, 0.34, 0.55), colors={'top': (0.75, 0.76, 0.78)})
    box(mb, (0, 1.8, 0.45), (0.08, 0.7, 0.06), (0.2, 0.2, 0.2))
    wheels4(mb, 3.0, 1.6, 0.22, 1.1, -1.1, 0.16)
    return finish(root, [('_body', mb, PAINT)])


def truck_cab(mb, y, W, color, h=2.6, L=2.2):
    box(mb, (0, y, 0.55 + h / 2), (W, L, h), color, colors={'front': (0.14, 0.16, 0.2)})
    box(mb, (0, y + L / 2 + 0.01, 0.55 + h * 0.72), (W * 0.9, 0.02, h * 0.38), WIN)
    box(mb, (0, y + L / 2 + 0.02, 0.8), (W * 0.9, 0.04, 0.4), (0.3, 0.3, 0.3))


def fuel_truck(loc, name='fuel_truck', tank=(0.92, 0.92, 0.9), cab=(0.92, 0.92, 0.9), stripe=(0.8, 0.12, 0.08)):
    root = new_root(name, loc)
    mb = MB()
    L = 9.5
    truck_cab(mb, L / 2 - 1.2, 2.5, cab)
    box(mb, (0, -0.8, 0.9), (2.4, 7.2, 0.35), (0.2, 0.2, 0.2))
    loft(mb, [ellipse(0, y, 2.0, 1.18, 0.95, 16) for y in (2.4, 2.2, -3.8, -4.3)], lambda c, a, b: stripe if abs(c.z - 1.55) < 0.12 else tank, True)
    wheels4(mb, L, 2.5, 0.52, L / 2 - 1.3, -2.6, 0.4, extra_axle=-3.8)
    return finish(root, [('_body', mb, PAINT)])


def catering_truck(loc):
    root = new_root('catering_truck', loc)
    mb = MB()
    truck_cab(mb, 3.2, 2.5, (0.93, 0.93, 0.93))
    box(mb, (0, -0.6, 0.9), (2.4, 6.2, 0.35), (0.25, 0.25, 0.25))
    box(mb, (0, -1.0, 1.6), (2.2, 5.0, 0.3), (0.5, 0.5, 0.52))       # scissor base
    box(mb, (0, -1.0, 3.2), (2.5, 5.4, 2.4), (0.95, 0.95, 0.95), colors={'back': (0.6, 0.6, 0.62)})
    box(mb, (0, -1.0, 2.05), (2.52, 5.42, 0.2), (0.15, 0.3, 0.6))
    wheels4(mb, 8.0, 2.5, 0.48, 3.0, -2.8, 0.38)
    return finish(root, [('_body', mb, PAINT)])


def stairs_truck(loc):
    root = new_root('stairs_truck', loc)
    mb = MB()
    C = (0.92, 0.92, 0.92)
    box(mb, (0, 0, 0.8), (2.2, 6.4, 0.5), C)
    box(mb, (0, 2.3, 1.7), (1.9, 1.4, 1.4), C, colors={'front': WIN, 'left': WIN, 'right': WIN})
    # stair ramp rising toward -Y
    prism(mb, [(1.4, 1.05), (-3.6, 3.6), (-3.6, 3.3), (1.4, 1.05)], -0.6, 0.6, (0.72, 0.72, 0.74))
    prism(mb, [(1.4, 1.05), (-3.6, 3.6), (-3.6, 4.6), (1.2, 2.0)], 0.62, 0.7, (0.95, 0.75, 0.1))
    prism(mb, [(1.4, 1.05), (-3.6, 3.6), (-3.6, 4.6), (1.2, 2.0)], -0.7, -0.62, (0.95, 0.75, 0.1))
    box(mb, (0, -3.9, 3.5), (1.3, 0.7, 0.12), (0.72, 0.72, 0.74))
    wheels4(mb, 6.4, 2.2, 0.42, 2.2, -2.2, 0.32)
    return finish(root, [('_body', mb, PAINT)])


def fire_truck(loc):
    root = new_root('fire_truck', loc)
    mb = MB()
    G = (0.80, 0.86, 0.10)   # ARFF lime yellow
    L = 12.0
    box(mb, (0, 0, 1.9), (3.0, L, 2.6), G, colors={'front': (0.2, 0.22, 0.25)})
    box(mb, (0, L / 2 - 1.3, 2.6), (2.9, 2.2, 1.2), G, colors={'front': WIN, 'left': WIN, 'right': WIN})
    box(mb, (0, 0.0, 1.2), (3.02, L * 0.92, 0.18), (0.85, 0.1, 0.08))
    box(mb, (0, L / 2 - 1.3, 3.3), (1.8, 0.3, 0.15), (0.95, 0.15, 0.1))
    cylinder(mb, (0, 3.5, 3.2), (0, 5.8, 3.6), 0.12, 0.08, 8, (0.8, 0.8, 0.8))      # roof turret
    box(mb, (0, 3.5, 3.3), (0.6, 0.6, 0.3), (0.3, 0.3, 0.3))
    for y in (3.8, 0.3, -3.8):
        for sx in (-1, 1):
            wheel(mb, (sx * 1.3, y, 0.62), 0.62, 0.5, 10, TYRE, HUB)
    return finish(root, [('_body', mb, PAINT)])


def bus(loc):
    root = new_root('bus', loc)
    mb = MB()
    C = (0.94, 0.94, 0.94)
    box(mb, (0, 0, 1.75), (3.0, 13.5, 2.5), C, colors={'front': WIN, 'back': WIN})
    for sx in (-1, 1):
        box(mb, (sx * 1.505, 0, 2.05), (0.01, 12.8, 1.4), WIN)
    box(mb, (0, 0, 3.05), (2.6, 12.0, 0.12), (0.85, 0.85, 0.86))
    box(mb, (0, 0, 0.55), (3.02, 13.4, 0.3), (0.2, 0.35, 0.65))
    wheels4(mb, 13.5, 3.0, 0.45, 5.4, -5.4, 0.35)
    return finish(root, [('_body', mb, PAINT)])


def gpu(loc):
    root = new_root('gpu', loc)
    mb = MB()
    box(mb, (0, 0, 0.9), (1.3, 2.4, 1.1), (0.9, 0.72, 0.1))
    box(mb, (0, 1.6, 0.5), (0.08, 1.0, 0.08), (0.2, 0.2, 0.2))
    wheels4(mb, 2.4, 1.3, 0.28, 0.8, -0.8, 0.2)
    return finish(root, [('_body', mb, PAINT)])


def car(loc):
    root = new_root('car', loc)
    mb = MB()
    C = (0.95, 0.95, 0.95)
    box(mb, (0, 0, 0.85), (1.95, 5.3, 0.75), C)
    box(mb, (0, 0.75, 1.55), (1.85, 2.1, 0.7), C, colors={'front': WIN, 'back': WIN, 'left': WIN, 'right': WIN})
    box(mb, (0, 0.8, 1.95), (1.2, 0.3, 0.12), (1.0, 0.55, 0.05))
    box(mb, (0, -1.4, 1.0), (1.8, 2.3, 0.02), (0.2, 0.2, 0.2))
    wheels4(mb, 5.3, 1.95, 0.38, 1.7, -1.6, 0.25)
    return finish(root, [('_body', mb, PAINT)])


def hmmwv(loc):
    root = new_root('hmmwv', loc)
    mb = MB()
    T = (0.55, 0.50, 0.36)
    box(mb, (0, 0.2, 1.0), (2.18, 4.6, 0.75), T)
    box(mb, (0, -0.3, 1.7), (2.0, 2.3, 0.7), T, colors={'front': WIN, 'left': WIN, 'right': WIN})
    prism(mb, [(2.5, 0.65), (2.5, 1.2), (1.1, 1.38), (1.1, 0.65)], -1.05, 1.05, T)
    wheels4(mb, 4.6, 2.18, 0.47, 1.6, -1.6, 0.35)
    return finish(root, [('_body', mb, PAINT)])


def windsock(loc):
    root = new_root('windsock', loc)
    mb = MB()
    cylinder(mb, (0, 0, 0), (0, 0, 6.2), 0.08, 0.06, 8, (0.85, 0.85, 0.85))
    ring = ring_perp((0, 0.1, 6.0), (0, 1, 0), 0.45, 12)
    secs = []
    n = 5
    for k in range(n + 1):
        f = k / n
        secs.append(ring_perp((0, 0.1 + 3.6 * f, 6.0 - 0.35 * f * f), (0, 1, 0), 0.45 - 0.22 * f, 12))
    loft(mb, secs, lambda c, si, seg: (0.95, 0.35, 0.05) if si % 2 == 0 else (0.95, 0.95, 0.95), True, False, False)
    return finish(root, [('_body', mb, PAINT)])


def floodlight(loc):
    root = new_root('floodlight', loc)
    mb, lamp = MB(), MB()
    G = (0.62, 0.63, 0.64)
    cylinder(mb, (0, 0, 0), (0, 0, 25.0), 0.32, 0.16, 10, G)
    box(mb, (0, 0, 0.3), (1.0, 1.0, 0.6), (0.55, 0.55, 0.55))
    box(mb, (0, 0, 25.3), (3.2, 0.3, 0.2), G)
    box(mb, (0, 0, 26.3), (3.2, 0.3, 0.2), G)
    for i in range(4):
        for j in range(2):
            x = -1.2 + 0.8 * i
            z = 25.55 + 0.9 * j
            box(mb, (x, 0.35, z), (0.6, 0.3, 0.55), (0.3, 0.3, 0.32), colors={'front': 'skip'})
            lamp.poly([(x - 0.27, 0.51, z - 0.24), (x + 0.27, 0.51, z - 0.24), (x + 0.27, 0.51, z + 0.24), (x - 0.27, 0.51, z + 0.24)][::-1], (1.0, 0.95, 0.85))
    return finish(root, [('_body', mb, PAINT), ('_lamp', lamp, LAMP)])


# ================================================================== main
def main():
    global PAINT, LAMP
    reset_scene()
    PAINT, LAMP = make_materials()
    total = 0
    items = [
        lambda l: airliner('airliner_narrow', NARROW, l), lambda l: airliner('airliner_wide', WIDE, l),
        fighter_f16, fighter_f22, heli_uh60, tug, baggage_tractor, baggage_cart,
        lambda l: fuel_truck(l), catering_truck, stairs_truck, fire_truck, bus, gpu, car, hmmwv,
        lambda l: fuel_truck(l, 'fuel_truck_mil', (0.30, 0.32, 0.22), (0.30, 0.32, 0.22), (0.26, 0.28, 0.2)), windsock, floodlight,
    ]
    x = 0.0
    spacing = [70, 75, 25, 25, 25] + [14] * 20
    for k, fn in enumerate(items):
        total += fn((x, 0, 0))
        x += spacing[k]
    print('total tris', total)
    roots = [o for o in bpy.context.scene.objects if o.parent is None]
    export_glb(OUT, objects=[o for o in bpy.context.scene.objects])
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if '--render' in argv:
        out = argv[argv.index('--render') + 1]
        setup_cycles(samples=32, width=1600, height=900)
        nishita_sky(35, 140, 0.25)
        add_sun(35, 140, 3.0)
        bpy.context.scene.view_settings.exposure = -1.0
        g = bpy.data.meshes.new('ground')
        g.from_pydata([(-100, -100, 0), (500, -100, 0), (500, 100, 0), (-100, 100, 0)], [], [(0, 1, 2, 3)])
        go = bpy.data.objects.new('ground', g)
        bpy.context.scene.collection.objects.link(go)
        gm = bpy.data.materials.new('g')
        gm.use_nodes = True
        gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.25, 0.25, 0.25, 1)
        g.materials.append(gm)
        view = argv[argv.index('--view') + 1] if '--view' in argv else 'all'
        if '--cam' in argv:
            cam = [float(v) for v in argv[argv.index('--cam') + 1].split(',')]
            look = [float(v) for v in argv[argv.index('--look') + 1].split(',')]
            add_camera(tuple(cam), tuple(look), 40)
        elif view == 'all':
            add_camera((150, -95, 60), (150, 0, 0), 35)
        else:
            cx, dist = [float(v) for v in view.split(':')]
            add_camera((cx + dist * 0.8, -dist, dist * 0.42), (cx, -dist * 0.05, dist * 0.08), 40)
        render_still(out)


main()
