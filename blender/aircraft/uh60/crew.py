"""UH-60M crew station furniture (G frame): armoured crew seats with sliding side armour, harness and inertia reel,
cyclic sticks with grips, collectives with switch boxes, anti-torque pedals, cockpit floor mats."""
import math
import numpy as np
from mathutils import Vector, Matrix
from lib import (prim_cylinder, prim_tube, prim_box, prim_sphere, prim_rbox, prim_torus, merge_parts, transform_verts,
                 loft_rings)
import cplib

X = Vector((1, 0, 0))
Y = Vector((0, 1, 0))
Z = Vector((0, 0, 1))


def rb(size, c, r=0.02, n=3, axes=None):
    return prim_rbox(size, tuple(c), r=r, n=n, axes=axes)


def xf(vf, M):
    v, f = vf
    return transform_verts(v, M), f


def shell_profile_loft(sx, y0, zp, tilt_deg, side_h=0.16):
    """Armoured bucket: one continuous shell (seat pan + curved back) with raised side walls, as a lofted U section
    swept along the seat's side profile. Returns verts, faces (closed ends)."""
    tilt = math.radians(tilt_deg)
    # side profile path (y, z) from the front lip of the pan, back along the pan, up the back to the top
    path = []
    for t in np.linspace(0, 1, 7):                  # pan (front -> rear)
        path.append((y0 - 0.46 * t, zp - 0.06 - 0.02 * math.sin(t * math.pi)))
    for t in np.linspace(0.12, 1, 10):             # back (rear -> top), bending up
        a = tilt
        path.append((y0 - 0.49 - 0.07 * t - math.sin(a) * 0.80 * t, zp - 0.02 + math.cos(a) * 0.80 * t))
    rings = []
    W = 0.50
    for k, (yy, zz) in enumerate(path):
        # local normal of the path (pointing "inside" the bucket: up on the pan, forward on the back)
        if k == 0:
            d = Vector((0, path[1][0] - yy, path[1][1] - zz))
        elif k == len(path) - 1:
            d = Vector((0, yy - path[k - 1][0], zz - path[k - 1][1]))
        else:
            d = Vector((0, path[k + 1][0] - path[k - 1][0], path[k + 1][1] - path[k - 1][1]))
        d.normalize()
        nrm = X.cross(d).normalized()          # inside direction
        if nrm.z < -0.2 or (abs(nrm.z) < 0.2 and nrm.y < 0):
            nrm = -nrm
        c = Vector((sx, yy, zz))
        sh = side_h if k < 7 else side_h * (1.0 - 0.45 * (k - 7) / 9)
        hw = W / 2 * (1.0 if k < 12 else 1 - 0.18 * (k - 12) / 4)
        # U section: outer skin of the shell (thickness 0.025) - left wall top -> floor -> right wall top and back
        t = 0.025
        sec = [(-hw, sh), (-hw, 0.02), (-hw + 0.04, -0.005), (hw - 0.04, -0.005), (hw, 0.02), (hw, sh),
               (hw - t, sh), (hw - t, 0.03), (hw - 0.05, t), (-hw + 0.05, t), (-hw + t, 0.03), (-hw + t, sh)]
        rings.append(np.array([tuple(c + X * a + nrm * b) for a, b in sec]))
    v, f = loft_rings(rings, cap_start='ngon', cap_end='ngon', closed=True)
    return v, f


def crew_seat(A, sx, y0=2.99, zp=1.13, floor=0.70):
    """Armoured crashworthy crew seat. sx: seat centre x; y0: front edge of the pan; zp: cushion top height."""
    so = 1 if sx > 0 else -1
    tilt = 13.0
    ta = math.radians(tilt)
    up = Vector((0, -math.sin(ta), math.cos(ta)))
    fw = Vector((0, math.cos(ta), math.sin(ta)))
    base = Vector((sx, y0 - 0.50, zp - 0.04))
    # armoured bucket shell (ceramic/composite armour, grey-green)
    A.add('int_seatshell', shell_profile_loft(sx, y0, zp, tilt))
    # seat cushion (two bolsters + centre), back cushion, lumbar roll, headrest
    A.add('int_cushion', rb((0.40, 0.42, 0.07), (sx, y0 - 0.235, zp - 0.035), r=0.03))
    for ox in (-0.175, 0.175):
        A.add('int_cushion', rb((0.07, 0.40, 0.09), (sx + ox, y0 - 0.24, zp - 0.025), r=0.03))
    A.add('int_cushion', rb((0.38, 0.52, 0.07), base + up * 0.36 + fw * 0.06, r=0.03, axes=(X, up, fw)))
    A.add('int_cushion', rb((0.36, 0.10, 0.08), base + up * 0.10 + fw * 0.07, r=0.035, axes=(X, up, fw)))
    A.add('int_cushion', rb((0.26, 0.15, 0.08), base + up * 0.80 + fw * 0.035, r=0.035, axes=(X, up, fw)))
    # harness: shoulder straps from the inertia reel at the top of the back, lap belts, crotch strap, rotary buckle
    reel = base + up * 0.90 - fw * 0.06
    A.add('int_black', rb((0.12, 0.07, 0.07), reel, r=0.015, axes=(X, up, fw)))
    buckle = Vector((sx, y0 - 0.20, zp + 0.075))
    for ox in (-0.06, 0.06):
        p0 = reel + X * ox * 0.5 + up * 0.02
        p1 = base + up * 0.70 + fw * 0.10 + X * ox
        p2 = base + up * 0.40 + fw * 0.13 + X * ox * 1.2
        A.add('int_strap', strap([p0, p1, p2, buckle + Vector((ox * 0.4, 0.0, 0.02))], 0.045, fw))
    for ox in (-0.21, 0.21):
        A.add('int_strap', strap([Vector((sx + ox, y0 - 0.44, zp + 0.01)), Vector((sx + ox * 0.75, y0 - 0.30, zp + 0.05)),
                                  buckle + Vector((ox * 0.12, 0, 0))], 0.045, Z))
    A.add('int_strap', strap([Vector((sx, y0 - 0.03, zp - 0.01)), Vector((sx, y0 - 0.10, zp + 0.045)), buckle], 0.04, Z))
    v, f = prim_cylinder(0.042, 0.042, 0.018, n=16, axis='Y', center=tuple(buckle))
    A.add('int_metal', xf((v, f), Matrix.Identity(4)))
    v, f = prim_cylinder(0.03, 0.03, 0.022, n=12, axis='Y', center=tuple(buckle + Vector((0, 0.01, 0))))
    A.add('int_black', (v, f))
    # sliding side armour panel on the outboard side (stowed aft), its track and handle
    sap_c = base + up * 0.48 + X * (so * 0.285) + fw * 0.05
    A.add('int_seatshell', rb((0.03, 0.56, 0.36), sap_c, r=0.012, axes=(X, up, fw)))
    A.add('int_metal', rb((0.02, 0.62, 0.025), sap_c - X * so * 0.022 + fw * 0.12, r=0.006, axes=(X, up, fw)))
    h0 = sap_c + X * so * 0.02 + up * 0.20 + fw * 0.12
    A.add('int_black', strap([h0, h0 + X * so * 0.03 + fw * 0.01, h0 + X * so * 0.03 + fw * 0.07, h0 + fw * 0.08], 0.018, X))
    # seat frame: two stroking guide tubes behind the back, energy attenuators, floor structure and rails
    for ox in (-0.16, 0.16):
        g0 = Vector((sx + ox, y0 - 0.66, floor + 0.02))
        A.add('int_frame', prim_tube([g0, g0 + Vector((0, -0.10, 1.05))], 0.022, n=10))
        A.add('int_metal', prim_tube([g0 + Vector((0, -0.02, 0.18)), g0 + Vector((0, -0.07, 0.62))], 0.013, n=8))
        A.add('int_frame', rb((0.05, 0.62, 0.05), (sx + ox, y0 - 0.33, floor + 0.035), r=0.008))
        A.add('int_frame', prim_tube([Vector((sx + ox, y0 - 0.05, floor + 0.05)), Vector((sx + ox, y0 - 0.12, zp - 0.13))], 0.016, n=8))
        A.add('int_frame', prim_tube([Vector((sx + ox, y0 - 0.55, floor + 0.05)), Vector((sx + ox, y0 - 0.48, zp - 0.12))], 0.016, n=8))
    A.add('int_frame', prim_tube([Vector((sx - 0.16, y0 - 0.70, floor + 0.95)), Vector((sx + 0.16, y0 - 0.70, floor + 0.95))], 0.018, n=8))
    # adjustment handles (vertical on the inboard side, fore/aft under the front lip)
    A.add('int_black', prim_tube([Vector((sx - so * 0.26, y0 - 0.12, zp - 0.10)), Vector((sx - so * 0.27, y0 - 0.02, zp - 0.07))], 0.008, n=6))
    A.add('int_yellow', rb((0.06, 0.02, 0.02), (sx, y0 + 0.01, zp - 0.12), r=0.006))


def strap(pts, width, normal, t=0.003):
    """Flat webbing strap along a polyline; 'normal' = approximate strap face normal."""
    pts = [Vector(p) for p in pts]
    n = Vector(normal).normalized()
    rings = []
    for k, p in enumerate(pts):
        d = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
        s = d.cross(n)
        if s.length < 1e-4:
            s = d.cross(Vector((0, 0, 1)))
        s.normalize()
        nn = s.cross(d).normalized()
        w2, t2 = width / 2, t / 2
        rings.append(np.array([tuple(p + s * a + nn * b) for a, b in ((-w2, -t2), (w2, -t2), (w2, t2), (-w2, t2))]))
    return loft_rings(rings, cap_start='ngon', cap_end='ngon', closed=True)


def cyclic(A, sx, yb=3.30, floor=0.70):
    """UH-60M cyclic (cockpit_m_06): rubber floor boot, S-shaped gooseneck stick, base block with the trim spring,
    tall textured grip whose head leans forward with the 4-way trim hat, red buttons, trigger and a PNL LTS switch."""
    prof = [(0.0, 0.0), (0.085, 0.0), (0.078, 0.02), (0.06, 0.03), (0.062, 0.045), (0.045, 0.06), (0.047, 0.075), (0.032, 0.09),
            (0.022, 0.10), (0.0, 0.10)]
    A.add('int_rubber', xf(cplib.lathe_z(prof, 18), Matrix.Translation((sx, yb, floor))))
    # stick: up and slightly aft, then the gooseneck curving forward to the grip base
    path = [Vector((sx, yb, floor + 0.05)), Vector((sx, yb - 0.015, floor + 0.28)), Vector((sx, yb - 0.055, floor + 0.44)),
            Vector((sx, yb - 0.075, floor + 0.52)), Vector((sx, yb - 0.060, floor + 0.575)), Vector((sx, yb - 0.035, floor + 0.60))]
    A.add('int_stick', prim_tube(path, 0.0155, n=12))
    top = path[-1]
    # base block with the trim spring + collar
    A.add('int_stick', prim_rbox((0.045, 0.06, 0.05), tuple(top + Vector((0, 0.005, 0.01))), r=0.01, n=2))
    for k in range(5):
        A.add('int_metal', prim_torus(0.011, 0.0025, n=10, m=5, center=tuple(top + Vector((0.026, -0.02, -0.005 + k * 0.007))), axis='Z'))
    base = top + Vector((0, 0.012, 0.035))
    A.add('int_grip', prim_cylinder(0.025, 0.025, 0.028, n=16, center=tuple(base)))
    # PNL LTS switch on the collar (red tip)
    A.add('int_knob', prim_cylinder(0.008, 0.008, 0.03, n=8, axis='X', center=tuple(base + Vector((-0.03, 0.0, 0.014)))))
    A.add('int_red', prim_sphere(0.0065, n=8, m=5, center=tuple(base + Vector((-0.036, 0.0, 0.014)))))
    # grip body: rings up the grip axis (leaning 12 deg forward), widest at the palm, finger ridges in front
    ga = math.radians(12)
    gu = Vector((0, math.sin(ga), math.cos(ga)))
    gf = X.cross(gu).normalized()
    if gf.y < 0:
        gf = -gf
    g0 = base + Vector((0, 0, 0.028))
    rings = []
    for h, rw, rd, fb in ((0.0, 0.020, 0.024, 0.0), (0.025, 0.022, 0.028, 0.004), (0.055, 0.023, 0.031, 0.008),
                          (0.085, 0.022, 0.030, 0.006), (0.110, 0.021, 0.028, 0.004), (0.13, 0.022, 0.031, 0.008),
                          (0.15, 0.021, 0.030, 0.012)):
        c = g0 + gu * h
        ring = []
        for i in range(18):
            a = 2 * math.pi * i / 18
            ring.append(tuple(c + X * (rw * math.cos(a)) + gf * (rd * math.sin(a) + (fb if math.sin(a) > 0 else 0))))
        rings.append(np.array(ring))
    A.add('int_grip', loft_rings(rings, cap_start='fan', cap_end=None))
    # head: rounded, leaning further forward; trim hat on the top-back, red buttons, trigger underneath at the front
    hc = g0 + gu * 0.165 + gf * 0.012
    ha = math.radians(32)
    hu = Vector((0, math.sin(ha), math.cos(ha)))
    hf = X.cross(hu).normalized()
    if hf.y < 0:
        hf = -hf
    A.add('int_grip', prim_rbox((0.044, 0.030, 0.064), tuple(hc), r=0.015, n=3, axes=(X, hu, hf)))
    hat = hc + hu * 0.028 - hf * 0.014
    A.add('int_knob', prim_cylinder(0.013, 0.012, 0.012, n=14, center=tuple(hat)))
    A.add('int_stick', prim_cylinder(0.009, 0.009, 0.008, n=10, center=tuple(hat + Vector((0, 0, 0.012)))))
    A.add('int_red', prim_cylinder(0.0065, 0.0065, 0.008, n=10, axis='Y', center=tuple(hc + hf * 0.028 + hu * 0.012)))
    A.add('int_red', prim_cylinder(0.0065, 0.0065, 0.008, n=10, axis='Y', center=tuple(g0 + gu * 0.105 + gf * 0.034)))
    thumb = -1
    for dv in (0.0, -0.022):
        p = hc + hu * dv + X * thumb * 0.024
        A.add('int_button', prim_cylinder(0.0045, 0.0045, 0.006, n=8, axis='-X', center=tuple(p)))
    trig = g0 + gu * 0.115 + gf * 0.04
    A.add('int_knob', prim_rbox((0.014, 0.028, 0.012), tuple(trig), r=0.004, n=2, axes=(X, gu, gf)))


def collective(A, sx, floor=0.70, y_piv=2.72, z_piv=0.93):
    """Collective lever left of the seat: housing, lever tube pivoting aft, friction knob, switch box head."""
    cx = sx - 0.33
    # lever housing along the seat side
    A.add('int_frame', rb((0.09, 0.56, 0.20), (cx, y_piv + 0.20, floor + 0.12), r=0.02))
    A.add('int_black', rb((0.03, 0.46, 0.008), (cx, y_piv + 0.22, floor + 0.222), r=0.003))
    # lever: from the pivot forward and slightly up
    p0 = Vector((cx, y_piv, z_piv))
    p1 = Vector((cx, y_piv + 0.40, z_piv + 0.065))
    A.add('int_stick', prim_tube([p0, p0.lerp(p1, 0.5), p1], [0.018, 0.017, 0.016], n=12))
    # friction adjuster collar and knob
    fc = p0.lerp(p1, 0.35)
    A.add('int_metal', prim_cylinder(0.024, 0.024, 0.03, n=14, axis='Y', center=tuple(fc)))
    A.add('int_knob', prim_rbox((0.03, 0.02, 0.02), tuple(fc + Vector((0.03, 0, 0))), r=0.006, n=2))
    # twist grip section (throttle-like, idle / fly detent on older types; on the M it is a rubber grip)
    d = (p1 - p0).normalized()
    g0 = p1 - d * 0.02
    g1 = p1 + d * 0.13
    A.add('int_grip', prim_tube([g0, g0.lerp(g1, 0.5), g1], [0.024, 0.026, 0.024], n=14))
    # switch box head: a rounded block angled up with switches on top and the inboard side
    sb = g1 + d * 0.045 + Vector((0, 0, 0.02))
    up = Vector((0, -0.25, 1)).normalized()
    fw = X.cross(up).normalized()
    if fw.y < 0:
        fw = -fw
    A.add('int_grip', rb((0.055, 0.075, 0.07), sb, r=0.012, axes=(X, up, fw)))
    top = sb + up * 0.037
    for k, (dx, dy) in enumerate(((-0.014, 0.018), (0.014, 0.018), (-0.014, -0.01), (0.014, -0.01), (0.0, -0.028))):
        p = top + X * dx + fw * dy
        vf = cplib.toggle(True, bat=0.011) if k < 4 else cplib.pushbutton(0.012, 0.01, 0.005)
        A.add('int_switch' if k < 4 else 'int_button', cplib.place(vf, cplib.frame(p, X, fw, up)))
    # searchlight control 4-way switch on the front face + landing light switch on the side
    A.add('int_knob', prim_cylinder(0.007, 0.007, 0.008, n=10, axis='Y', center=tuple(sb + fw * 0.04)))
    A.add('int_switch', cplib.place(cplib.toggle(True, 0.01), cplib.frame(sb + X * 0.029, Vector((0, 1, 0)), up, X)))


def pedals(A, sx, floor=0.70, y=3.86):
    """Anti-torque pedals: adjustment beam across the floor, pedal arms and ribbed pedal pads."""
    A.add('int_frame', rb((0.40, 0.06, 0.06), (sx, y + 0.12, floor + 0.05), r=0.012))
    for ps in (-1, 1):
        px = sx + ps * 0.125
        piv = Vector((px, y + 0.10, floor + 0.09))
        pad = Vector((px, y - 0.02, floor + 0.23))
        A.add('int_metal', prim_tube([piv, pad + Vector((0, 0.03, -0.02))], 0.011, n=8))
        pu = Vector((0, -0.40, 0.92)).normalized()
        pn = X.cross(pu).normalized()
        if pn.y > 0:
            pn = -pn
        A.add('int_pedal', rb((0.10, 0.21, 0.018), pad, r=0.008, axes=(X, pu, -pn)))
        for k in range(5):
            A.add('int_rubber', rb((0.086, 0.008, 0.006), pad + pu * (-0.08 + k * 0.04) - pn * 0.011, r=0.002, n=1, axes=(X, pu, -pn)))
        # heel slide
        A.add('int_frame', rb((0.11, 0.10, 0.012), (px, y - 0.20, floor + 0.012), r=0.004))
