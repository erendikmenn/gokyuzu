"""Small cockpit hardware generators (knobs, toggle switches, guards, push buttons, levers, Dzus fasteners).

Every function returns (verts, faces) in a local frame and is placed with frame(o, R, U, N): o = point on the panel face,
R = panel right, U = panel up, N = panel normal toward the crew. Sizes in metres.
"""
import math
from mathutils import Vector, Matrix
from lib import prim_cylinder, prim_tube, prim_box, prim_sphere, prim_rbox, merge_parts, transform_verts


def lathe_z(profile, n=16, z0=0.0):
    """Revolve (r, z) profile about local +Z (outward = panel normal). Closed at both ends when r = 0."""
    verts, faces = [], []
    m = len(profile)
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        for r, z in profile:
            verts.append((r * c, r * s, z + z0))
    for i in range(n):
        i1 = (i + 1) % n
        for j in range(m - 1):
            faces.append((i * m + j, i1 * m + j, i1 * m + j + 1, i * m + j + 1))
    return verts, faces


def frame(o, R, U, N):
    """Matrix mapping local (x right, y up, z out) to the panel frame at point o."""
    R, U, N = Vector(R).normalized(), Vector(U).normalized(), Vector(N).normalized()
    M = Matrix((R, U, N)).transposed().to_4x4()
    M.translation = Vector(o)
    return M


def place(vf, M):
    v, f = vf
    return transform_verts(v, M), f


# ------------------------------------------------------------------------------------------------ knobs
def knob(r=0.009, h=0.014, style='fluted', n=14):
    """Panel knob: skirt + body (+ pointer bar). style: fluted | round | concentric | small."""
    if style == 'concentric':
        prof = [(0, 0), (r * 1.35, 0), (r * 1.35, h * 0.35), (r * 1.25, h * 0.42), (r * 0.78, h * 0.45),
                (r * 0.75, h * 0.95), (r * 0.62, h), (0, h)]
    elif style == 'small':
        prof = [(0, 0), (r, 0), (r, h * 0.85), (r * 0.8, h), (0, h)]
    else:
        prof = [(0, 0), (r * 1.25, 0), (r * 1.25, h * 0.18), (r, h * 0.26), (r * 0.96, h * 0.9), (r * 0.8, h), (0, h)]
    parts = [lathe_z(prof, n)]
    if style in ('fluted', 'concentric'):
        # pointer ridge across the top
        parts.append(prim_box((r * 0.28, r * 1.7, h * 0.12), center=(0, r * 0.1, h + h * 0.04)))
    return merge_parts(parts)


def knob_bar(w=0.03, h=0.016, t=0.009):
    """Bar-type selector knob (like radio/mode selectors): a round base + a long pointed bar."""
    parts = [lathe_z([(0, 0), (w * 0.38, 0), (w * 0.38, h * 0.3), (0, h * 0.3)], 14)]
    parts.append(prim_rbox((t, w, h * 0.8), (0, w * 0.06, h * 0.55), r=t * 0.35, n=2))
    return merge_parts(parts)


# ------------------------------------------------------------------------------------------------ switches
def toggle(up=True, bat=0.018, n=8):
    """Toggle switch: hex nut + thin collar + bat lever tilted up (or down)."""
    parts = [lathe_z([(0, 0), (0.0065, 0), (0.0065, 0.004), (0, 0.004)], 6)]
    parts.append(lathe_z([(0, 0.004), (0.0042, 0.004), (0.0042, 0.007), (0, 0.007)], n))
    s = 1 if up else -1
    tip = Vector((0, s * bat * 0.42, 0.007 + bat * 0.9))
    parts.append(prim_tube([Vector((0, 0, 0.006)), tip], [0.0022, 0.0028], n=6))
    parts.append(prim_sphere(0.0032, n=8, m=5, center=tuple(tip)))
    return merge_parts(parts)


def lever_lock_toggle(up=True):
    """Lever-lock toggle (pull-to-unlock): longer bat with a collar."""
    v, f = toggle(up, bat=0.022)
    return v, f


def guard(w=0.028, h=0.03, depth=0.022, t=0.0025):
    """Red flip-up switch guard (closed): a U-shaped cover over a switch, hinged at the bottom."""
    parts = []
    parts.append(prim_box((w, t, depth), center=(0, h * 0.5, depth / 2)))                 # top wall
    for sx in (-1, 1):
        parts.append(prim_box((t, h, depth), center=(sx * (w / 2 - t / 2), 0, depth / 2)))  # side walls
    parts.append(prim_box((w, h * 0.6, t), center=(0, h * 0.2, depth)))                  # cover plate (front)
    return merge_parts(parts)


def pushbutton(w=0.016, h=0.012, d=0.008, r=0.0015):
    return prim_rbox((w, h, d), (0, 0, d / 2), r=r, n=2)


def bezel_key(w=0.016, h=0.011, d=0.005):
    """MFD bezel key: low rounded rectangular key."""
    return prim_rbox((w, h, d), (0, 0, d / 2), r=0.0022, n=2)


def rocker(w=0.012, h=0.022, d=0.008):
    parts = [prim_box((w + 0.004, h + 0.004, 0.002), center=(0, 0, 0.001))]
    v, f = prim_rbox((w, h, d), (0, 0, d / 2), r=0.002, n=2)
    # tilt: top half proud
    v = [(x, y, z + (0.002 if y > 0 else 0)) for x, y, z in v]
    parts.append((v, f))
    return merge_parts(parts)


def dzus(r=0.0035):
    """Quarter-turn Dzus fastener head (tiny dome)."""
    return lathe_z([(0, 0), (r, 0), (r * 0.9, r * 0.35), (r * 0.5, r * 0.55), (0, r * 0.6)], 8)


def lamp_capsule(w=0.022, h=0.016, d=0.006):
    """Push-to-test annunciator capsule (square cap)."""
    return prim_rbox((w, h, d), (0, 0, d / 2), r=0.0015, n=2)


def t_handle(w=0.075, h=0.026, reach=0.03):
    """Fire / emergency T-handle: shaft out of the panel + a T grip."""
    parts = [prim_tube([Vector((0, 0, 0)), Vector((0, 0, reach))], 0.005, n=8)]
    parts.append(prim_rbox((w, h, 0.016), (0, 0, reach + 0.008), r=0.006, n=3))
    return merge_parts(parts)


def circuit_breaker(r=0.0045, h=0.009):
    """Pop-out circuit breaker: hex collar + white-banded button."""
    parts = [lathe_z([(0, 0), (0.0065, 0), (0.0065, 0.0025), (0, 0.0025)], 6)]
    parts.append(lathe_z([(0, 0.0025), (r, 0.0025), (r, h), (r * 0.85, h + 0.0012), (0, h + 0.0012)], 10))
    return merge_parts(parts)


def screw(r=0.0022):
    return lathe_z([(0, 0), (r, 0), (r * 0.85, r * 0.5), (0, r * 0.62)], 6)


# ------------------------------------------------------------------------------------------------ levers & grips
def lever_quadrant_lever(length=0.10, knob_w=0.03, knob_h=0.026, knob_d=0.034, angle_deg=0.0):
    """Engine power / fuel control lever: a flat blade arm rising out of a slot plus a moulded knob, in local
    (x across the slot, y along the slot, z out of the panel). angle: lean along +y."""
    a = math.radians(angle_deg)
    tip = Vector((0, math.sin(a) * length, math.cos(a) * length))
    parts = []
    # flat arm: box along the lever direction
    d = tip.normalized()
    M = Matrix((Vector((1, 0, 0)), d.cross(Vector((1, 0, 0))).normalized(), d)).transposed().to_4x4()
    v, f = prim_box((0.008, 0.014, length), center=(0, 0, length / 2))
    parts.append((transform_verts(v, M), f))
    v, f = prim_rbox((knob_w, knob_d, knob_h), (0, 0, 0), r=0.008, n=3)
    parts.append((transform_verts(v, Matrix.Translation(tip) @ M), f))
    return merge_parts(parts)
