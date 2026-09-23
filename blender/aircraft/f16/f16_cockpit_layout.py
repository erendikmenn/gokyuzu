"""F-16C Block 50 cockpit layout (pure Python; shared by the geometry and the cockpit texture painter).

Frames:
  drawing frame (s aft, y right, z up) like the rest of the build.
  panel frame: main instrument panel plane; u = right (m), v = up along the panel (m) from its bottom edge.
"""
import math

EYE = (4.285, 0.0, 2.82)            # design eye point (drawing frame)

# main instrument panel plane (tilted back by PANEL_TILT from vertical)
PANEL_P0 = (3.780, 0.0, 2.030)      # bottom-center point of the panel face
PANEL_TILT = math.radians(20.0)
PANEL_W = 0.66                      # full width at the top
PANEL_H = 0.455


def panel_point(u, v, depth=0.0):
    """Panel (u, v) -> drawing frame (s, y, z). depth > 0 moves toward the pilot (normal)."""
    su, zu = math.sin(PANEL_TILT), math.cos(PANEL_TILT)
    # the panel leans back (top forward): up = (-sin, cos) in (s, z); normal toward the pilot = (cos, sin)
    s = PANEL_P0[0] - v * su + depth * zu
    z = PANEL_P0[2] + v * zu + depth * su
    return (s, u, z)


def panel_normal():
    su, zu = math.sin(PANEL_TILT), math.cos(PANEL_TILT)
    return (zu, 0.0, su)


# panel outline in (u, v): top wide, lower part stepped toward the center pedestal
PANEL_OUTLINE = [(-0.33, 0.455), (0.33, 0.455), (0.33, 0.17), (0.25, 0.11), (0.115, 0.11), (0.115, 0.0),
                 (-0.115, 0.0), (-0.115, 0.11), (-0.25, 0.11), (-0.33, 0.17)]

# displays (screen rectangles in panel coords: center u, v, width, height) + bezel size
MFD_L = dict(c=(-0.192, 0.262), screen=(0.1016, 0.1016), bezel=(0.162, 0.168))
MFD_R = dict(c=(0.192, 0.262), screen=(0.1016, 0.1016), bezel=(0.162, 0.168))
DED = dict(c=(0.0, 0.338), screen=(0.086, 0.032), bezel=(0.112, 0.050))
RWR = dict(c=(-0.192, 0.402), screen=(0.064, 0.064), bezel=(0.086, 0.086))
ICP = dict(c=(0.0, 0.405), size=(0.150, 0.082))

# round instruments: name -> (u, v, diameter)
GAUGES = {
    'adi': (0.0, 0.262, 0.072),
    'ehsi': (0.0, 0.160, 0.078),
    'asi': (-0.078, 0.190, 0.050),
    'alt': (0.078, 0.190, 0.050),
    'vvi': (0.078, 0.128, 0.040),
    'aoa': (-0.078, 0.128, 0.040),
    'fuel': (0.192, 0.402, 0.066),
    'ftit': (0.300, 0.345, 0.044),
    'rpm': (0.300, 0.285, 0.044),
    'noz': (0.300, 0.225, 0.040),
    'oil': (0.300, 0.172, 0.036),
    'clock': (-0.075, 0.060, 0.036),
    'hyd': (0.075, 0.060, 0.036),
}

GEAR_HANDLE = (-0.300, 0.215)       # landing gear handle (left side of the panel)

# texture atlas (2048 x 2048): pixel rects (x0, y0, w, h)
ATLAS = 2048
TEX = {
    'panel': (0, 0, 1400, 966),          # panel face, 0.70 x 0.483 m (panel u -0.35..0.35, v -0.01..0.47)
    'lcons': (1410, 0, 300, 1300),       # left console top (0.19 x 0.82 m)
    'rcons': (1720, 0, 300, 1300),       # right console top
    'icp': (0, 980, 600, 330),           # ICP face
    'glare': (610, 980, 780, 300),       # glareshield top (anti-glare)
    'seat': (0, 1320, 700, 700),         # seat cushion / harness fabric
    'placard': (710, 1320, 690, 330),    # misc placards
    'mfdbezel': (1410, 1310, 420, 420),  # MFD bezel face with OSBs (both MFDs share)
    'dedbezel': (710, 1660, 360, 180),
    'rwrbezel': (1080, 1660, 300, 300),
    'hudctl': (1840, 1310, 200, 420),
}
PANEL_TEX_U = (-0.35, 0.35)
PANEL_TEX_V = (-0.013, 0.470)

# consoles (drawing frame): top surface rectangle for each side (s0, s1, y_in, y_out, z_top at s0/s1)
CONSOLE_L = dict(s0=3.86, s1=4.72, y_in=-0.235, y_out=-0.395, z0=2.262, z1=2.262)
CONSOLE_R = dict(s0=3.86, s1=4.72, y_in=0.235, y_out=0.395, z0=2.262, z1=2.262)

# seat (ACES II): hip point, back angle
SEAT_HIP = (4.075, 0.0, 2.100)
SEAT_BACK = math.radians(30.0)
