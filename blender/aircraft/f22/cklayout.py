"""F-22A cockpit layout (pure python): positions shared by the art generator (textures.py) and the geometry
(cockpit.py).  World frame as everywhere: station s (m aft of the nose tip), x right, z up; Blender y = Y0 - s.

Layout from USAF cockpit photos (ref/cockpit_ground.jpg, ref/cockpit_lit.jpg, ref/cockpit_closeup.jpg):
  top centre   : wide-FOV HUD on the glareshield, Integrated Control Panel (ICP) below it,
                 Up-Front Displays (UFD, 3x4 in) left and right of the ICP, master caution/warning lights beside them
  middle row   : left SMFD (6.25 in) - PMFD (8x8 in) - right SMFD, the side facets angled toward the pilot
  right, upper : Standby Flight Display (3x3 in) above the right SMFD
  lower centre : third SMFD on the knee panel, landing-gear handle lower left
  consoles     : throttles (left), side-stick (right), ACES II seat, canopy rails
"""
import math

EYE = (0.0, 4.55, 0.86)              # design eye (x, s, z)

# ---------------------------------------------------------------- instrument panel facets
# centre facet: origin PO (s, z), "up" direction tilted back 16 deg (moving up the panel goes forward)
PO = (3.95, 0.20)
TILT = math.radians(16.3)
EW = (-math.sin(TILT), math.cos(TILT))   # (ds, dz) per metre of w
HALF_C = 0.145                           # centre facet half width (u): PMFD bezel-to-bezel with the side SMFDs
W_TOP = 0.43                             # panel top edge (w)
W_BOT_C = -0.045                         # bottom of the centre facet (w); knee panel below
WING = math.radians(24.0)                # side facets rotated toward the pilot about the facet hinge
WING_W = 0.30                            # side facet width (u')
KNEE_TILT = math.radians(20.0)           # knee panel tilts back further
KNEE_HALF = 0.135                        # knee panel half width
KNEE_L = 0.27                            # knee panel length (down its slope)

# displays: (facet, u, w, active width, active height).  u' on side facets is measured from the hinge outward.
DISPLAYS = {
    'screen_pmfd': ('C', 0.0, 0.13, 0.2032, 0.2032),
    'screen_smfd_L': ('L', 0.110, 0.16, 0.1588, 0.1588),
    'screen_smfd_R': ('R', 0.110, 0.16, 0.1588, 0.1588),
    'screen_smfd_C': ('K', 0.0, 0.158, 0.1588, 0.1588),
    'screen_ufd_L': ('L', 0.075, 0.352, 0.0762, 0.1016),     # 3x4 in, portrait, above the side SMFD
    'screen_ufd_R': ('R', 0.075, 0.352, 0.0762, 0.1016),
}
SFD = ('R', 0.215, 0.33, 0.0762, 0.0762)          # standby flight display (static face, see report)
ICP = ('C', 0.0, 0.352, 0.190, 0.128, 0.055)       # facet, u, w, width, height, depth
BEZEL = {'pmfd': 0.034, 'smfd': 0.028, 'ufd': 0.012, 'sfd': 0.010}
OSB_N = 5                                          # option select buttons per bezel side (MFDs)

# ---------------------------------------------------------------- glareshield + HUD
GLARE_S = (3.43, 3.86)               # front / aft lip stations
GLARE_Z = 0.645                      # crown height
GLARE_HALF = 0.47
HUD_B = (3.805, 0.648)               # combiner bottom centre (s, z)
HUD_T = (3.745, 0.955)               # combiner top centre
HUD_W = 0.33
HUD_BOX = (3.50, 3.83, 0.30)         # housing s0, s1, width (sits on the glareshield)

# ---------------------------------------------------------------- consoles, floor, seat
CON_X = (0.300, 0.535)
CON_S = (3.98, 5.18)
CON_Z = 0.225
FLOOR_Z = -0.42
STICK = (0.405, 4.30, CON_Z)
THROTTLE = (-0.420, 4.40, CON_Z)
THR_SLOT_S = (4.18, 4.60)
SEAT_BASE = (4.66, 0.115)            # seat back / cushion junction (s, z)
SEAT_RECLINE = math.radians(15.0)
SEAT_HALF = 0.25
BULKHEAD_S = 5.22

# ---------------------------------------------------------------- art atlas (textures.py -> cockpit_art.png)
ART = 4096
# name: (x0, y0, x1, y1) pixel rect (top-left origin) and metres covered (width, height)
ART_REGIONS = {
    'lcon': ((0, 0, 1952, 376), (CON_S[1] - CON_S[0], CON_X[1] - CON_X[0])),
    'rcon': ((2048, 0, 4000, 376), (CON_S[1] - CON_S[0], CON_X[1] - CON_X[0])),
    'wall_L': ((0, 400, 1760, 800), (1.76, 0.40)),
    'wall_R': ((2048, 400, 3808, 800), (1.76, 0.40)),
    'pan_C': ((0, 820, 598, 1800), (2 * HALF_C, W_TOP - W_BOT_C)),
    'pan_L': ((880, 820, 1494, 1800), (WING_W, W_TOP - W_BOT_C)),
    'pan_R': ((1510, 820, 2124, 1800), (WING_W, W_TOP - W_BOT_C)),
    'pan_K': ((2140, 820, 2693, 1373), (2 * KNEE_HALF, KNEE_L)),
    'icp': ((2710, 820, 3488, 1344), (ICP[3], ICP[4])),
    'sfd': ((3510, 820, 3822, 1132), (SFD[3], SFD[4])),
    'seat': ((0, 1820, 512, 2332), (0.5, 0.5)),
    'headbox': ((520, 1820, 1032, 2332), (0.42, 0.42)),
    'stripe': ((1040, 1820, 1552, 1948), (0.3, 0.075)),
    'canopy_sw': ((1560, 1820, 1816, 2076), (0.10, 0.10)),
    'glare': ((1830, 1820, 2342, 2332), (0.5, 0.5)),
    'deck': ((2350, 1820, 2862, 2332), (0.5, 0.5)),
    'floor': ((2870, 1820, 3382, 2332), (0.5, 0.5)),
    'bulk': ((3390, 1820, 3902, 2332), (0.5, 0.5)),
}
PATCH_Y = 3968
PATCHES = {
    'black': (14, 15, 16), 'panel': (30, 32, 34), 'wall': (46, 49, 52), 'metal': (96, 100, 103),
    'white': (232, 232, 226), 'rubber': (20, 20, 20), 'seatgreen': (70, 76, 62), 'yellow': (222, 178, 26),
    'red': (170, 28, 24), 'olive': (84, 88, 70), 'grip': (30, 30, 32), 'chrome': (175, 178, 182),
    'glass': (26, 34, 32), 'khaki': (120, 112, 88), 'amber': (220, 150, 30), 'gray': (78, 82, 86),
    'helmet': (104, 108, 106), 'visor': (20, 22, 26), 'green': (46, 150, 70), 'bay': (160, 162, 158),
}


def patch_rect(name):
    i = list(PATCHES).index(name)
    return (i * 128 + 8, PATCH_Y + 8, i * 128 + 120, PATCH_Y + 120)


def region_uv(name):
    """Normalized UV rect (u0, v0, u1, v1) with v up."""
    if name.startswith('patch_'):
        r = patch_rect(name[6:])
    else:
        r = ART_REGIONS[name][0]
    return (r[0] / ART, 1 - r[3] / ART, r[2] / ART, 1 - r[1] / ART)


# ---------------------------------------------------------------- geometry helpers (pure math)
def facet_point(facet, u, w, d=0.0):
    """Point (x, s, z) on a panel facet at facet coords (u, w) plus d along the facet normal (toward the pilot)."""
    ds, dz = EW
    ns, nz = math.cos(TILT), math.sin(TILT)     # facet normal in the (s, z) plane: aft / up toward the pilot
    if facet == 'C':
        x = u
        s = PO[0] + w * ds + d * ns
        z = PO[1] + w * dz + d * nz
        return (x, s, z)
    if facet == 'K':
        # knee panel hangs below the centre facet bottom edge, tilted back by KNEE_TILT more
        s0 = PO[0] + W_BOT_C * ds
        z0 = PO[1] + W_BOT_C * dz
        t = TILT + KNEE_TILT
        # w measured downward from the hinge; KNEE panel's own "up" points to the hinge
        kw = (-math.sin(t), math.cos(t))
        kn = (math.cos(t), math.sin(t))
        ww = w - KNEE_L                 # w in [0, KNEE_L]: 0 = bottom edge
        return (u, s0 + ww * kw[0] + d * kn[0], z0 + ww * kw[1] + d * kn[1])
    sign = -1 if facet == 'L' else 1
    # side facet: hinge line at u = +-HALF_C of the centre facet; rotated about the facet "up" axis by WING
    hx = sign * HALF_C
    hs = PO[0] + w * ds
    hz = PO[1] + w * dz
    # in-plane outward direction rotated toward the pilot: x component cos(WING), normal component sin(WING)
    ox = sign * math.cos(WING)
    on = math.sin(WING)
    # facet normal: rotate the centre normal about the up axis
    nx = -sign * math.sin(WING)
    nn = math.cos(WING)
    x = hx + u * ox + d * nx
    s = hs + (u * on + d * nn) * ns
    z = hz + (u * on + d * nn) * nz
    return (x, s, z)


def facet_axes(facet):
    """(ex, ew, en) unit vectors (x, s, z) of a facet: along u, along w, normal toward the pilot."""
    import numpy as np
    p0 = np.array(facet_point(facet, 0.0, 0.1))
    pu = np.array(facet_point(facet, 0.01, 0.1))
    pw = np.array(facet_point(facet, 0.0, 0.11))
    pn = np.array(facet_point(facet, 0.0, 0.1, 0.01))
    return (pu - p0) / 0.01, (pw - p0) / 0.01, (pn - p0) / 0.01


def facet_range(facet):
    """(u0, u1, w0, w1) extent of each facet."""
    if facet == 'C':
        return (-HALF_C, HALF_C, W_BOT_C, W_TOP)
    if facet == 'K':
        return (-KNEE_HALF, KNEE_HALF, 0.0, KNEE_L)
    return (0.0, WING_W, W_BOT_C, W_TOP)
