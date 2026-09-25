"""A320 flight-deck layout (pure python/numpy): 3D anchors of every panel + the panel contents.

Shared by cockpit_tex.py (atlas painting, venv/PIL) and cockpit.py (Blender geometry), so the painted legends and the
modelled pushbuttons / knobs / switches always line up.

Frame: station s = meters aft of the nose tip, y to the right, z above the fuselage axis (layout.py).
Blender vector = (y, S_CG - s, z).  Human scale (A320 references, ref/flightdeck/*): design eye s = 2.41, y = -/+0.53,
z = +0.66; floor z = -0.55; seat reference point ~0.8 m below and ~0.13 m aft of the eye; rudder pedals ~0.9 m ahead
of it in the footwell under the main instrument panel.

Main panel proportions from the reference photos (display units 190 mm square, active area 158 mm; FCU 330 mm and
EFIS control panels 195 mm wide on the glareshield; MCDUs 148 x 226 mm; pedestal 0.50 m wide; overhead 0.80 m wide).

Panel item coordinates: meters from the panel's top-left corner as seen by the pilot (x right, y down).  Items are
dicts with a kind 'k':
  pb      Korry pushbutton  x y w h  up/lo=(legend, colour, lit) label (printed above) guard ('red'|'clear'|None)
  key     keypad key        x y w h  text
  knob    rotary knob       x y (centre) r  style ('bar'|'round'|'big'|'small'|'dual')  label  pos (labels around)
  tog     toggle switch     x y (bushing)  label  pos (top..bottom)  state (index of pos)
  lcd     segment display   x y w h  text colour
  screen  avionics display  name x y w h           bezel  raised display frame  x y w h  kind
  title   section title     x y w text             text   printed legend  x y text size colour anchor
  line    flow line         pts colour             plate  panel plate (gap + Dzus screws)  x y w h
  ann     flat annunciator  x y w h text colour lit    rect  filled rectangle  x y w h colour
  placard white placard     x y w h lines          grille speaker grille  x y r
  clock   digital clock     x y w h                gauge  brake pressure triple indicator  x y r
  slot    lever slot        x y w h                mcdu/dcdu screen  x y w h  (painted page)
"""
import math
import os
import sys
import numpy as np

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'common'))
import brand  # noqa: E402

S_CG = 16.47
# registration plate on the centre panel: the fictional livery's registration (textures.py) and a SELCAL code, or a
# local livery module's REG_PLATE (LIVERY=<name>, blender/common/brand.py)
REG_PLATE = getattr(brand.livery_module('a320neo', 'A320_LIVERY'), 'REG_PLATE', ('TC-GKA', 'SELCAL CODE  GK-AB'))
FLOOR_Z = -0.55
EYE = dict(s=2.41, y=0.53, z=0.66)
SRP = dict(s=2.54, z=-0.14)          # seat reference point (captain / F/O at y = -/+0.53)

# Airbus flight-deck blue-grey ("Airbus grey" panels), a slightly darker tone for recesses, legend white
PANEL_BG = (104, 118, 134)
PANEL_DK = (84, 96, 110)
CAP_BG = (22, 24, 27)
WHITE = (232, 234, 236)
COL = dict(white=(236, 238, 240), amber=(255, 158, 24), green=(60, 255, 120), blue=(70, 175, 255),
           red=(255, 42, 36), cyan=(70, 225, 255), magenta=(255, 90, 255), flow=(150, 214, 150))


def B(s, y, z):
    """Blender coordinates of a flight-deck point."""
    return np.array([y, S_CG - s, z], float)


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


class Frame:
    """Panel frame: origin O = top-left corner, U = right, V = down, N = V x U (towards the pilot)."""

    def __init__(self, O, U, V):
        self.O = np.asarray(O, float)
        self.U = unit(U)
        V = np.asarray(V, float)
        V = V - self.U * np.dot(V, self.U)
        self.V = unit(V)
        self.N = np.cross(self.V, self.U)

    def p(self, x, y, h=0.0):
        return self.O + self.U * x + self.V * y + self.N * h


def seg_frame(p_top, p_bot, y_left):
    """Frame of a panel spanning from (s, z) p_top to p_bot, starting at y_left (U = +y)."""
    O = B(p_top[0], y_left, p_top[1])
    V = B(p_bot[0], y_left, p_bot[1]) - O
    return Frame(O, (1, 0, 0), V), float(np.linalg.norm(V))


# ================================================================================================ 3D anchors
MIP_TOP = (1.708, 0.360)                 # main instrument panel top edge (s, z); panel leans back 7.7 deg
_MIP_T = unit((0.064, -0.475))
MIP_H_CENTER = 0.440                     # centre panel (E/WD + SD + ISIS + gear column)
MIP_H_SIDE = 0.245                       # captain / F/O panels (PFD + ND); the stowed tables sit below
MIP_Y = 0.86                             # half width of the panel
MIP_YC = 0.29                            # half width of the centre panel
GS_FRONT_S, GS_TOP_Z = 1.705, 0.468      # glareshield front lip
FCU_TOP_Z, FCU_BOT_Z = 0.456, 0.367
PED_Y = 0.25                             # pedestal half width
# pedestal top: MCDU incline (40 deg), main part (RMP/ACP/thrust quadrant/ENG/...), aft part (printer, stowage)
PED_P0 = (MIP_TOP[0] + _MIP_T[0] * MIP_H_CENTER, MIP_TOP[1] + _MIP_T[1] * MIP_H_CENTER)
PED_P1 = (PED_P0[0] + 0.174, PED_P0[1] - 0.146)
PED_P2 = (2.64, PED_P1[1] - 0.022)
PED_P3 = (2.82, PED_P2[1] - 0.012)
OVH_FRONT = (2.08, 0.985)
OVH_AFT = (3.26, 1.325)
OVH_W = 0.60                             # 1 + 2 + 1 modules of 146 mm
CONS_Y0, CONS_Y1 = 0.83, 1.33            # side console top: inboard edge .. outboard (wall) edge
CONS_S0, CONS_S1 = 2.02, 3.00
CONS_Z = -0.02
STICK = dict(s=2.15, y=0.965)            # side-stick pivot on the console (mirrored for the captain)
TILLER = dict(s=2.33, y=0.895)


def mip_point(v):
    return MIP_TOP[0] + _MIP_T[0] * v, MIP_TOP[1] + _MIP_T[1] * v


def mip_frame(y_left):
    O = B(MIP_TOP[0], y_left, MIP_TOP[1])
    V = B(MIP_TOP[0] + _MIP_T[0], y_left, MIP_TOP[1] + _MIP_T[1]) - O
    return Frame(O, (1, 0, 0), V)


def gs_frame(y_left):
    """FCU/EFIS face on the glareshield front, tilted face-up (bottom edge further aft)."""
    O = B(GS_FRONT_S + 0.010, y_left, FCU_TOP_Z)
    V = B(GS_FRONT_S + 0.024, y_left, FCU_BOT_Z) - O
    return Frame(O, (1, 0, 0), V), float(np.linalg.norm(V))


# ================================================================================================ panel builder
class Panel:
    def __init__(self, name, frame, w, h, atlas='A', appm=None, bg=PANEL_BG):
        self.d = dict(name=name, frame=frame, w=w, h=h, items=[], atlas=atlas, appm=appm, bg=bg)
        self.it = self.d['items']

    def add(self, k, **kw):
        kw['k'] = k
        self.it.append(kw)
        return kw

    # -- primitives
    def pb(self, x, y, w=0.017, h=0.017, up=None, lo=None, label=None, guard=None, lsize=0.0042, bars=False):
        return self.add('pb', x=x, y=y, w=w, h=h, up=up, lo=lo, label=label, guard=guard, lsize=lsize, bars=bars)

    def pbc(self, cx, cy, **kw):
        w, h = kw.pop('w', 0.017), kw.pop('h', 0.017)
        return self.pb(cx - w / 2, cy - h / 2, w=w, h=h, **kw)

    def knob(self, x, y, r=0.0085, style='bar', label=None, pos=None, lsize=0.0042, arc=2.2):
        return self.add('knob', x=x, y=y, r=r, style=style, label=label, pos=pos or [], lsize=lsize, arc=arc)

    def tog(self, x, y, label=None, pos=('ON', 'OFF'), state=0, lsize=0.0042):
        return self.add('tog', x=x, y=y, label=label, pos=list(pos), state=state, lsize=lsize)

    def lcd(self, x, y, w, h, text, colour='amber', label=None):
        return self.add('lcd', x=x, y=y, w=w, h=h, text=text, colour=colour, label=label)

    def text(self, x, y, text, size=0.0045, colour='white', anchor='mm'):
        return self.add('text', x=x, y=y, text=text, size=size, colour=colour, anchor=anchor)

    def title(self, x, y, w, text, size=0.0052):
        return self.add('title', x=x, y=y, w=w, text=text, size=size)

    def plate(self, x, y, w, h, screws=True):
        return self.add('plate', x=x, y=y, w=w, h=h, screws=screws)

    def line(self, pts, colour='flow', width=0.0009):
        return self.add('line', pts=pts, colour=colour, width=width)

    def ann(self, x, y, w, h, text, colour='amber', lit=False):
        return self.add('ann', x=x, y=y, w=w, h=h, text=text, colour=colour, lit=lit)

    def rect(self, x, y, w, h, colour):
        return self.add('rect', x=x, y=y, w=w, h=h, colour=colour)

    def key(self, x, y, w, h, text, style='key'):
        return self.add('key', x=x, y=y, w=w, h=h, text=text, style=style)


# ================================================================================================ main instrument panel
DU = 0.190          # display unit case
DU_ACT = 0.158      # active area


def du(p, name, cx, cy):
    p.add('bezel', x=cx - DU / 2, y=cy - DU / 2, w=DU, h=DU, kind='du')
    p.add('screen', name=name, x=cx - DU_ACT / 2, y=cy - DU_ACT / 2 - 0.002, w=DU_ACT, h=DU_ACT)


DU_CY = 0.112       # display centre below the panel top edge


def panel_mip_side(side):
    """Captain (side -1) / F/O (+1) panel: PFD + ND, lighting knobs, loudspeaker; tables stowed below."""
    W = MIP_Y - MIP_YC
    y_left = -MIP_Y if side < 0 else MIP_YC
    tag = 'capt' if side < 0 else 'fo'
    p = Panel(f'mip_{tag}', mip_frame(y_left), W, MIP_H_SIDE)
    # display centres in world y
    nd_y = side * (MIP_YC + 0.007 + DU / 2)
    pfd_y = nd_y + side * (DU + 0.006)
    X = lambda yw: yw - y_left
    p.plate(0.004, 0.004, W - 0.008, MIP_H_SIDE - 0.008, screws=False)
    du(p, f'screen_pfd_{tag}', X(pfd_y), DU_CY)
    du(p, f'screen_nd_{tag}', X(nd_y), DU_CY)
    # outboard strip: AUTO LAND light, PFD/ND brightness, PFD/ND XFR, LOUDSPEAKER, CONSOLE/FLOOR, FOOT WARMER
    ox = 0.0 if side < 0 else W - 0.176
    p.plate(ox + 0.012, 0.018, 0.150, 0.118)
    p.add('sq', x=ox + 0.020, y=0.028, w=0.022, h=0.018, text=['AUTO', 'LAND'], colour='red', lit=False)
    p.knob(ox + 0.040, 0.070, 0.0075, 'round', 'PFD', ['OFF', 'BRT'])
    p.pbc(ox + 0.087, 0.070, w=0.016, h=0.016, lo=('ND', 'white', False), label='PFD/ND XFR')
    p.knob(ox + 0.134, 0.070, 0.0075, 'round', 'ND', ['OFF', 'BRT'])
    p.knob(ox + 0.040, 0.112, 0.0075, 'round', 'LOUD SPEAKER', ['', 'MAX'])
    p.knob(ox + 0.087, 0.112, 0.0075, 'round', 'CONSOLE/FLOOR', ['DIM', 'OFF', 'BRT'])
    p.knob(ox + 0.134, 0.112, 0.0075, 'round', 'FOOT WARMER', ['OFF', 'ON'])
    p.add('grille', x=ox + 0.088, y=0.192, r=0.034)
    # printed display names + brightness knobs under the displays (LCD units: separate BRT knobs)
    for yw, lab in ((pfd_y, 'PFD'), (nd_y, 'ND')):
        p.knob(X(yw) + side * 0.080, DU_CY + DU / 2 + 0.014, 0.0055, 'small', None, [])
    p.text(W / 2 if side > 0 else W / 2, MIP_H_SIDE - 0.012, '', 0.004)
    return p.d


def panel_mip_center():
    W = 2 * MIP_YC
    p = Panel('mip_center', mip_frame(-MIP_YC), W, MIP_H_CENTER)
    cx = W / 2
    du(p, 'screen_ewd', cx, DU_CY)
    du(p, 'screen_sd', cx, DU_CY + DU + 0.006)
    # ---- left column: registration plate, limitations placard, ISIS, TERR ON ND, DCDU 1
    p.plate(0.006, 0.006, 0.182, 0.212)
    p.add('placard', x=0.018, y=0.016, w=0.158, h=0.028, lines=[(REG_PLATE[0], 0.016, 'l'), (REG_PLATE[1], 0.0042, 'r')],
          bg=(66, 76, 90), fg=(236, 238, 240))
    p.add('placard', x=0.098, y=0.052, w=0.080, h=0.058, bg=(66, 76, 90), fg=(236, 238, 240),
          lines=[('LIMIT     SPD (IAS)', 0.0036, 'l'), ('VLE   280KT/M.67', 0.0036, 'l'), ('VLO  EXT 250KT', 0.0036, 'l'),
                 ('       RET 220KT', 0.0036, 'l'), ('VFE  1    230KT', 0.0036, 'l'), ('       1+F  215KT', 0.0036, 'l'),
                 ('       2    200KT', 0.0036, 'l'), ('       3    185KT', 0.0036, 'l'), ('    FULL  177KT', 0.0036, 'l')])
    p.add('bezel', x=0.052, y=0.118, w=0.090, h=0.092, kind='isis')
    p.add('screen', name='screen_isis', x=0.060, y=0.124, w=0.074, h=0.074)
    p.pbc(0.036, 0.160, w=0.017, h=0.017, lo=('ON', 'green', False), label='TERR ON ND')
    p.plate(0.006, 0.224, 0.182, 0.080)
    p.pbc(0.034, 0.244, w=0.015, h=0.015, lo=('', 'white', False), label=None)
    p.add('dcdu', x=0.016, y=0.306, w=0.162, h=0.108)
    # ---- right column: LDG GEAR, BRK FAN, AUTO BRK, A/SKID & N/W STRG, clock, TERR ON ND, gear lever, brakes, DCDU 2
    rx = W - 0.188
    p.plate(rx, 0.006, 0.182, 0.107)
    p.title(rx + 0.010, 0.016, 0.110, 'LDG GEAR', 0.0048)
    for k in range(3):
        p.ann(rx + 0.012 + k * 0.036, 0.024, 0.032, 0.014, 'UNLK', 'red', False)
        p.ann(rx + 0.012 + k * 0.036, 0.039, 0.032, 0.012, 'v', 'green', True)
    p.pbc(rx + 0.158, 0.040, w=0.017, h=0.017, up=('HOT', 'amber', False), lo=('ON', 'blue', False), label='BRK FAN')
    p.title(rx + 0.010, 0.066, 0.110, 'AUTO/BRK', 0.0048)
    for k, lab in enumerate(('LO', 'MED', 'MAX')):
        p.text(rx + 0.028 + k * 0.037, 0.074, lab, 0.0040)
        p.pbc(rx + 0.028 + k * 0.037, 0.090, w=0.024, h=0.017, up=('DECEL', 'green', False), lo=('ON', 'blue', k == 0))
    p.tog(rx + 0.158, 0.090, 'A/SKID &\nN/W STRG', ('ON', 'OFF'), 0)
    p.plate(rx, 0.117, 0.182, 0.097)
    p.add('clock', x=rx + 0.012, y=0.124, w=0.084, h=0.084)
    p.pbc(rx + 0.150, 0.160, w=0.017, h=0.017, lo=('ON', 'green', False), label='TERR ON ND')
    p.plate(rx, 0.218, 0.182, 0.086)
    p.add('slot', x=rx + 0.022, y=0.226, w=0.028, h=0.074)
    p.text(rx + 0.064, 0.232, 'UP', 0.0045)
    p.text(rx + 0.064, 0.296, 'DOWN', 0.0045)
    p.add('arrow', x=rx + 0.064, y0=0.240, y1=0.288)
    p.add('gauge', x=rx + 0.130, y=0.262, r=0.026)
    p.add('dcdu', x=W - 0.178, y=0.306, w=0.162, h=0.108)
    # screws along the upper edge
    return p.d


# ================================================================================================ glareshield
EFIS_W, FCU_W = 0.195, 0.330


def panel_fcu():
    W = FCU_W
    fr, H = gs_frame(-W / 2)
    p = Panel('fcu', fr, W, H, bg=(96, 110, 126))
    p.plate(0.002, 0.002, W - 0.004, H - 0.004)
    # continuous LCD strip + labels above the windows
    p.rect(0.022, 0.012, W - 0.044, 0.020, (14, 12, 10))
    for x, lab in ((0.040, 'SPD'), (0.078, 'MACH'), (0.118, 'HDG'), (0.146, 'TRK'), (0.166, 'LAT'), (0.212, 'ALT'),
                   (0.244, 'LVL/CH'), (0.282, 'V/S'), (0.300, 'FPA')):
        p.text(x, 0.008, lab, 0.0036)
    p.lcd(0.026, 0.015, 0.052, 0.014, '---*', 'amber')
    p.lcd(0.104, 0.015, 0.048, 0.014, '280', 'amber', label='HDG')
    p.lcd(0.156, 0.015, 0.024, 0.014, 'HDG', 'amber')
    p.lcd(0.184, 0.015, 0.018, 0.014, 'V/S', 'amber')
    p.lcd(0.204, 0.015, 0.060, 0.014, '05000', 'amber')
    p.lcd(0.268, 0.015, 0.042, 0.014, '-----', 'amber')
    # big knobs
    for x in (0.058, 0.128, 0.226, 0.290):
        p.knob(x, 0.058, 0.0118, 'big', None, [])
    p.knob(0.021, 0.050, 0.0055, 'round', 'SPD\nMACH', [])
    p.knob(0.160, 0.046, 0.0055, 'round', None, [])
    p.text(0.160, 0.034, 'HDG-V/S  TRK-FPA', 0.0030)
    p.knob(0.258, 0.046, 0.0055, 'round', 'METRIC\nALT', [])
    p.text(0.210, 0.043, '100', 0.0034)
    p.text(0.242, 0.043, '1000', 0.0034)
    p.text(0.306, 0.043, 'UP', 0.0034)
    p.text(0.306, 0.074, 'DN', 0.0034)
    # AP / A/THR / LOC / EXPED / APPR
    p.pbc(0.185 - 0.013, 0.060, w=0.020, h=0.013, lo=('AP1', 'white', False), bars=True)
    p.pbc(0.185 + 0.013, 0.060, w=0.020, h=0.013, lo=('AP2', 'white', False), bars=True)
    p.pbc(0.185, 0.078, w=0.020, h=0.012, lo=('A/THR', 'white', True), bars=True)
    p.pbc(0.100, 0.078, w=0.020, h=0.012, lo=('LOC', 'white', False), bars=True)
    p.pbc(0.258, 0.078, w=0.020, h=0.012, lo=('EXPED', 'white', False), bars=True)
    p.pbc(0.310, 0.078, w=0.018, h=0.012, lo=('APPR', 'white', False), bars=True)
    return p.d


def panel_efis(side):
    W = EFIS_W
    y_left = -(FCU_W / 2 + W) if side < 0 else FCU_W / 2
    fr, H = gs_frame(y_left)
    tag = 'capt' if side < 0 else 'fo'
    p = Panel(f'efis_{tag}', fr, W, H, bg=(96, 110, 126))
    p.plate(0.002, 0.002, W - 0.004, H - 0.004)
    m = (lambda x: x) if side < 0 else (lambda x: W - x)
    # QNH window + baro knob
    p.text(m(0.034), 0.009, 'QNH', 0.0038)
    p.lcd(m(0.034) - 0.019, 0.013, 0.038, 0.013, '1013', 'amber')
    p.knob(m(0.034), 0.048, 0.0085, 'dual', None, [])
    p.text(m(0.034) - 0.015, 0.036, 'in Hg', 0.0030)
    p.text(m(0.034) + 0.015, 0.036, 'hPa', 0.0030)
    p.pbc(m(0.022), 0.076, w=0.016, h=0.011, lo=('FD', 'white', True), bars=True)
    p.pbc(m(0.046), 0.076, w=0.016, h=0.011, lo=('LS', 'white', False), bars=True)
    labs = ['CSTR', 'WPT', 'VOR.D', 'NDB', 'ARPT']
    if side > 0:
        labs = labs[::-1]
    for k, lab in enumerate(labs):
        p.pbc(0.075 + k * 0.0255 if side < 0 else W - 0.176 + k * 0.0255, 0.017, w=0.019, h=0.012,
              lo=(lab, 'white', lab == 'CSTR'), bars=True)
    kx1, kx2 = (0.100, 0.155) if side < 0 else (W - 0.155, W - 0.100)
    mode_x, rng_x = (kx1, kx2) if side < 0 else (kx2, kx1)
    p.knob(mode_x, 0.049, 0.0085, 'bar', None, ['LS', 'VOR', 'NAV', 'ARC', 'PLAN'], arc=2.3)
    p.knob(rng_x, 0.049, 0.0085, 'bar', None, ['10', '20', '40', '80', '160', '320'], arc=1.8)
    for k, x in enumerate((mode_x - 0.012, rng_x - 0.012) if side < 0 else (rng_x + 0.012, mode_x + 0.012)):
        pass
    p.tog(m(0.090) if side < 0 else W - 0.090, 0.075, None, ('', ''), 0)
    p.tog(m(0.140) if side < 0 else W - 0.140, 0.075, None, ('', ''), 0)
    for x, n in ((0.090, '1'), (0.140, '2')):
        xx = x if side < 0 else W - x
        p.text(xx - 0.013, 0.076, 'ADF', 0.0030)
        p.text(xx + 0.013, 0.076, 'VOR', 0.0030)
        p.text(xx, 0.086, 'OFF', 0.0030)
        p.text(xx, 0.066, n, 0.0030)
    return p.d


def panel_gs_side(side):
    """Outboard glareshield panels: CHRONO, SIDE STICK PRIORITY, MASTER WARN / MASTER CAUT, AUTO LAND."""
    y0 = FCU_W / 2 + EFIS_W
    W = MIP_Y - y0
    y_left = -MIP_Y if side < 0 else y0
    fr, H = gs_frame(y_left)
    tag = 'capt' if side < 0 else 'fo'
    p = Panel(f'gs_{tag}', fr, W, H, bg=(96, 110, 126))
    inner = (lambda d: W - d) if side < 0 else (lambda d: d)
    p.plate(0.002, 0.002, W - 0.004, H - 0.004)
    p.text(inner(0.045), 0.012, 'CHRONO', 0.0038)
    p.knob(inner(0.045), 0.026, 0.0062, 'round', None, [])
    p.text(inner(0.045), 0.043, 'SIDE STICK PRIORITY', 0.0032)
    p.add('sq', x=inner(0.045) - 0.010, y=0.051, w=0.020, h=0.020, text=['', ''], colour='red', lit=False,
          split=True, colours=('red', 'green'), texts=('CAPT' if side < 0 else 'F/O', 'ARROW'))
    for k, (t, c) in enumerate((('MASTER\nWARN', 'red'), ('MASTER\nCAUT', 'amber'))):
        p.add('sq', x=inner(0.150) - 0.012, y=0.014 + k * 0.032, w=0.024, h=0.024, text=t.split('\n'), colour=c, lit=False)
    return p.d


# ================================================================================================ pedestal
MCDU_W, MCDU_H = 0.148, 0.224


def mcdu_keys(p, x, y, w, h):
    """MCDU face (keys as geometry, page painted): line select keys, function keys, keypad."""
    p.add('mcdu', x=x, y=y, w=w, h=h)
    sx, sy, sw, sh = x + w * 0.19, y + h * 0.045, w * 0.62, h * 0.33
    for k in range(6):
        yy = sy + sh * (0.10 + 0.155 * k)
        p.key(x + w * 0.035, yy, w * 0.10, h * 0.030, '-', 'lsk')
        p.key(x + w * 0.865, yy, w * 0.10, h * 0.030, '-', 'lsk')
    fy = sy + sh + h * 0.035
    fnames = ['DIR', 'PROG', 'PERF', 'INIT', 'DATA', '', 'F-PLN', 'RAD\nNAV', 'FUEL\nPRED', 'SEC\nF-PLN', 'ATC\nCOMM',
              'MCDU\nMENU', 'AIR\nPORT', '', '<', '^', '>', 'v']
    for k, lab in enumerate(fnames):
        r, c = divmod(k, 6)
        if not lab:
            continue
        p.key(x + w * 0.055 + c * w * 0.148, fy + r * h * 0.056, w * 0.128, h * 0.042, lab, 'fn')
    ky = fy + 3 * h * 0.056 + h * 0.006
    letters = [chr(ord('A') + i) for i in range(26)] + ['SP', 'OVFY', 'CLR', '/']
    for i, lab in enumerate(letters):
        r, c = divmod(i, 5)
        p.key(x + w * 0.435 + c * w * 0.108, ky + r * h * 0.050, w * 0.092, h * 0.040, lab, 'alpha')
    nums = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '+/-']
    for i, lab in enumerate(nums):
        r, c = divmod(i, 3)
        p.key(x + w * 0.060 + c * w * 0.112, ky + r * h * 0.050, w * 0.094, h * 0.040, lab, 'num')
    p.text(x + w * 0.10, sy + sh * 0.5, 'FAIL', 0.0030)
    p.text(x + w * 0.90, sy + sh * 0.5, 'BRT', 0.0030)
    p.knob(x + w * 0.90, sy + sh * 0.70, 0.004, 'small', None, [])


def panel_ped_mcdu():
    fr, H = seg_frame(PED_P0, PED_P1, -PED_Y)
    W = 2 * PED_Y
    p = Panel('ped_mcdu', fr, W, H)
    mcdu_keys(p, 0.012, 0.001, MCDU_W, min(MCDU_H, H - 0.002))
    mcdu_keys(p, W - 0.012 - MCDU_W, 0.001, MCDU_W, min(MCDU_H, H - 0.002))
    # centre column: SWITCHING + ECAM control panel
    cx0, cw = 0.012 + MCDU_W + 0.006, W - 2 * (0.012 + MCDU_W + 0.006)
    p.plate(cx0, 0.002, cw, 0.070)
    p.title(cx0 + 0.008, 0.012, cw - 0.016, 'SWITCHING', 0.0042)
    for k, lab in enumerate(('ATT HDG', 'AIR DATA', 'EIS DMC', 'ECAM/ND XFR')):
        x = cx0 + cw * (0.14 + 0.24 * k)
        p.knob(x, 0.044, 0.0072, 'bar', lab, ['CAPT 3', 'NORM', 'F/O 3'] if k < 3 else ['CAPT', 'NORM', 'F/O'], lsize=0.0030)
    p.plate(cx0, 0.075, cw, H - 0.077)
    p.title(cx0 + 0.008, 0.084, cw - 0.016, 'ECAM', 0.0042)
    p.knob(cx0 + 0.022, 0.104, 0.0062, 'round', 'UPPER\nDISPLAY', ['OFF', 'BRT'], lsize=0.0028)
    p.knob(cx0 + 0.058, 0.104, 0.0062, 'round', 'LOWER\nDISPLAY', ['OFF', 'BRT'], lsize=0.0028)
    p.pbc(cx0 + 0.098, 0.103, w=0.024, h=0.016, lo=('TO\nCONFIG', 'white', False))
    p.pbc(cx0 + 0.134, 0.103, w=0.024, h=0.016, lo=('EMER\nCANC', 'white', False))
    rows = [('ENG', 'BLEED', 'PRESS', 'ELEC', 'HYD', 'FUEL'), ('APU', 'COND', 'DOOR', 'WHEEL', 'F/CTL', 'ALL')]
    for r, row in enumerate(rows):
        for c, lab in enumerate(row):
            p.pbc(cx0 + cw * (0.10 + 0.16 * c), 0.140 + r * 0.026, w=0.021, h=0.016, lo=(lab, 'white', False), bars=True)
    for c, lab in enumerate(('CLR', 'STS', 'RCL', 'CLR')):
        p.pbc(cx0 + cw * (0.10 + 0.267 * c), 0.196, w=0.021, h=0.016, lo=(lab, 'white', False))
    return p.d


def rmp(p, x, y, w, n):
    p.plate(x, y, w, 0.103)
    p.text(x + w * 0.27, y + 0.010, 'ACTIVE', 0.0034)
    p.text(x + w * 0.73, y + 0.010, 'STBY/CRS', 0.0034)
    p.lcd(x + 0.010, y + 0.015, w * 0.40, 0.016, '118.300' if n == 1 else '121.900', 'amber')
    p.lcd(x + w - 0.010 - w * 0.40, y + 0.015, w * 0.40, 0.016, '124.380' if n == 1 else '118.700', 'amber')
    p.pbc(x + w / 2, y + 0.023, w=0.014, h=0.010, lo=('<>', 'white', True))
    for k, lab in enumerate(('VHF1', 'VHF2', 'VHF3')):
        p.pbc(x + 0.020 + k * 0.026, y + 0.048, w=0.019, h=0.012, lo=(lab, 'white', k == n - 1), bars=True)
    for k, lab in enumerate(('HF1', 'SEL', 'HF2', 'AM')):
        p.pbc(x + 0.020 + k * 0.026, y + 0.068, w=0.019, h=0.012, lo=(lab, 'white', False), bars=True)
    for k, lab in enumerate(('NAV', 'VOR', 'ILS', 'MLS', 'ADF', 'BFO')):
        p.pbc(x + 0.014 + k * 0.022, y + 0.090, w=0.016, h=0.010, lo=(lab, 'white', False))
    p.knob(x + w - 0.028, y + 0.058, 0.0095, 'dual', None, [])
    p.tog(x + w - 0.012, y + 0.036, None, ('ON', 'OFF'), 0)


def acp(p, x, y, w):
    p.plate(x, y, w, 0.126)
    labs = ('VHF1', 'VHF2', 'VHF3', 'HF1', 'HF2', 'INT', 'CAB')
    pitch = (w - 0.014) / 7
    for k, lab in enumerate(labs):
        p.pbc(x + 0.007 + pitch * (k + 0.5), y + 0.014, w=pitch * 0.82, h=0.012, up=('CALL', 'amber', False),
              lo=(lab, 'white', k == 0), bars=True)
    for k, lab in enumerate(labs):
        p.knob(x + 0.007 + pitch * (k + 0.5), y + 0.042, 0.0062, 'round', None, [])
        p.text(x + 0.007 + pitch * (k + 0.5), y + 0.054, lab, 0.0026)
    for k, lab in enumerate(('VOR1', 'VOR2', 'MKR1', 'MKR2', 'ADF1', 'ADF2', 'PA')):
        p.knob(x + 0.007 + pitch * (k + 0.5), y + 0.074, 0.0062, 'round', None, [])
        p.text(x + 0.007 + pitch * (k + 0.5), y + 0.086, lab, 0.0026)
    p.pbc(x + 0.030, y + 0.106, w=0.022, h=0.012, lo=('VOICE', 'white', False))
    p.pbc(x + 0.070, y + 0.106, w=0.022, h=0.012, lo=('RESET', 'white', False))
    p.tog(x + w - 0.030, y + 0.106, 'INT/RAD', ('INT', '', 'RAD'), 1, lsize=0.0028)


def panel_ped_main():
    fr, H = seg_frame(PED_P1, PED_P2, -PED_Y)
    W = 2 * PED_Y
    p = Panel('ped_main', fr, W, H)
    cw0, cw1 = 0.158, W - 0.158          # centre column (thrust quadrant, trim wheels, ENG, park brake, rudder trim)
    lw = cw0 - 0.006
    # ---- left column
    rmp(p, 0.004, 0.002, lw, 1)
    acp(p, 0.004, 0.108, lw)
    p.plate(0.004, 0.238, lw, 0.064)
    p.title(0.012, 0.248, lw - 0.016, 'LIGHTING', 0.0038)
    p.knob(0.040, 0.276, 0.0085, 'dual', 'FLOOD LT MAIN PNL & PED', ['OFF', 'BRT'], lsize=0.0030)
    p.knob(0.110, 0.276, 0.0085, 'dual', 'INTEG LT', ['OFF', 'BRT'], lsize=0.0030)
    p.plate(0.004, 0.306, lw, 0.100)
    p.title(0.012, 0.316, lw - 0.016, 'WX RADAR', 0.0038)
    p.knob(0.030, 0.346, 0.0072, 'round', 'GAIN', ['MAX', 'CAL'], lsize=0.0030)
    p.tog(0.066, 0.344, 'MULTISCAN', ('AUTO', 'MAN'), 0, lsize=0.0028)
    p.tog(0.100, 0.344, 'GCS', ('AUTO', 'OFF'), 0, lsize=0.0028)
    p.knob(0.132, 0.346, 0.0072, 'bar', 'MODE', ['WX', 'WX+T', 'TURB', 'MAP'], lsize=0.0030)
    p.knob(0.040, 0.384, 0.0072, 'round', 'TILT', ['UP', 'DN'], lsize=0.0030)
    p.tog(0.084, 0.384, 'SYS', ('1', 'OFF', '2'), 0, lsize=0.0028)
    p.tog(0.122, 0.384, 'PWS', ('AUTO', 'OFF'), 0, lsize=0.0028)
    p.plate(0.004, 0.410, lw, H - 0.412)
    p.title(0.012, 0.420, lw - 0.016, 'COCKPIT DOOR', 0.0038)
    p.tog(0.060, 0.450, None, ('UNLOCK', 'NORM', 'LOCK'), 1, lsize=0.0028)
    p.ann(0.094, 0.438, 0.034, 0.012, 'OPEN', 'amber', False)
    p.ann(0.094, 0.453, 0.034, 0.012, 'FAULT', 'amber', False)
    p.title(0.012, 0.490, lw - 0.016, 'ENG', 0.0038)
    p.pbc(0.040, 0.516, w=0.020, h=0.016, up=('FAULT', 'amber', False), lo=('OFF', 'white', False), label='N1 MODE 1')
    p.pbc(0.110, 0.516, w=0.020, h=0.016, up=('FAULT', 'amber', False), lo=('OFF', 'white', False), label='N1 MODE 2')
    p.rect(0.030, 0.560, 0.100, 0.080, (54, 60, 68))
    p.text(0.080, 0.600, 'STOWAGE', 0.0034)
    # ---- right column
    rx = cw1 + 0.002
    rmp(p, rx, 0.002, lw, 2)
    acp(p, rx, 0.108, lw)
    p.plate(rx, 0.238, lw, 0.064)
    p.title(rx + 0.008, 0.248, lw - 0.016, 'FLT LT', 0.0038)
    p.knob(rx + 0.030, 0.276, 0.0072, 'round', 'FLOOD LT', ['OFF', 'BRT'], lsize=0.0030)
    p.pbc(rx + 0.080, 0.274, w=0.020, h=0.016, lo=('PRINT', 'white', False), label='AIDS')
    p.pbc(rx + 0.124, 0.274, w=0.020, h=0.016, lo=('EVENT', 'white', False), label='DFDR')
    p.plate(rx, 0.306, lw, 0.128)
    p.title(rx + 0.008, 0.316, lw - 0.016, 'ATC', 0.0038)
    p.lcd(rx + 0.088, 0.328, 0.050, 0.016, '2000', 'amber')
    for i, lab in enumerate(('1', '2', '3', '4', '5', '6', '7', 'CLR')):
        r, c = divmod(i, 3)
        p.key(rx + 0.090 + c * 0.016, 0.352 + r * 0.018, 0.013, 0.013, lab, 'num')
    p.knob(rx + 0.030, 0.346, 0.0072, 'bar', 'XPDR', ['STBY', 'AUTO', 'ON'], lsize=0.0030)
    p.tog(rx + 0.024, 0.392, 'ALT RPTG', ('ON', 'OFF'), 0, lsize=0.0028)
    p.pbc(rx + 0.052, 0.392, w=0.017, h=0.012, lo=('IDENT', 'white', False))
    p.knob(rx + 0.030, 0.420, 0.0062, 'bar', 'TCAS', ['STBY', 'TA', 'TA/RA'], lsize=0.0028)
    p.plate(rx, 0.438, lw, H - 0.440)
    p.title(rx + 0.008, 0.448, lw - 0.016, 'SWITCHING', 0.0038)
    p.knob(rx + 0.040, 0.476, 0.0070, 'bar', 'AUDIO SWITCHING', ['CAPT 3', 'NORM', 'F/O 3'], lsize=0.0028)
    p.knob(rx + 0.110, 0.476, 0.0070, 'bar', 'SEL', ['1', '2'], lsize=0.0028)
    p.rect(rx + 0.020, 0.540, 0.115, 0.080, (54, 60, 68))
    p.text(rx + 0.078, 0.580, 'DOCUMENTS', 0.0034)
    # ---- centre column: thrust quadrant (drum + trim wheels are geometry), ENG masters, PARK BRK, RUD TRIM
    cx = W / 2
    p.rect(cw0, 0.0, cw1 - cw0, 0.300, (58, 64, 72))
    p.add('quadrant', x=cx, y0=0.010, y1=0.290)
    for k, lab in enumerate(('A/THR', '', '', '')):
        pass
    m0, m1 = cw0 + 0.036, cw1 - 0.036          # ENG / PARK BRK / RUD TRIM plates; lever slots in the margins
    mw = m1 - m0
    p.plate(m0, 0.302, mw, 0.112)
    p.title(m0 + 0.010, 0.310, mw - 0.020, 'ENG', 0.0038)
    for k, n in enumerate(('1', '2')):
        x = cx + (k * 2 - 1) * 0.034
        p.add('master', x=x, y=0.350, n=n)
        p.ann(x - 0.013, 0.382, 0.026, 0.011, 'FIRE', 'red', False)
        p.ann(x - 0.013, 0.395, 0.026, 0.011, 'FAULT', 'amber', False)
        p.text(x + 0.016 * (1 if k else -1), 0.338, 'ON', 0.0028)
        p.text(x + 0.016 * (1 if k else -1), 0.364, 'OFF', 0.0028)
    p.knob(cx, 0.372, 0.0085, 'bar', 'MODE', ['CRANK', 'NORM', 'IGN'], lsize=0.0030, arc=1.4)
    p.plate(m0, 0.418, mw, 0.088)
    p.title(m0 + 0.010, 0.428, mw - 0.020, 'PARK BRK', 0.0038)
    p.text(cx - 0.030, 0.452, 'OFF', 0.0034)
    p.text(cx + 0.030, 0.452, 'ON', 0.0034)
    p.add('parkbrk', x=cx, y=0.470)
    p.plate(m0, 0.510, mw, H - 0.512)
    p.title(m0 + 0.010, 0.520, mw - 0.020, 'RUD TRIM', 0.0038)
    p.lcd(cx - 0.024, 0.532, 0.048, 0.016, 'L 0.0', 'amber')
    p.knob(cx - 0.018, 0.576, 0.0105, 'bar', None, ['NOSE L', 'NOSE R'], arc=1.2)
    p.pbc(cx + 0.030, 0.576, w=0.018, h=0.013, lo=('RESET', 'white', False))
    p.tog(cx, 0.645, 'GRVTY GEAR EXTN', ('', ''), 0, lsize=0.0028)
    # speed brake (left margin) and flap (right margin) lever slots with detent labels
    p.rect(cw0, 0.300, 0.036, H - 0.300, (80, 92, 106))
    p.rect(cw1 - 0.036, 0.300, 0.036, H - 0.300, (80, 92, 106))
    p.add('slot', x=cw0 + 0.006, y=0.302, w=0.010, h=0.150)
    for k, lab in enumerate(('RET', '1/2', 'FULL')):
        p.text(cw0 + 0.027, 0.312 + k * 0.064, lab, 0.0032)
    p.text(cw0 + 0.018, 0.466, 'SPEED', 0.0028)
    p.text(cw0 + 0.018, 0.472, 'BRAKE', 0.0028)
    p.add('slot', x=cw1 - 0.016, y=0.302, w=0.010, h=0.170)
    for k, lab in enumerate(('0', '1', '2', '3', 'FULL')):
        p.text(cw1 - 0.027, 0.312 + k * 0.038, lab, 0.0034)
    p.text(cw1 - 0.018, 0.486, 'FLAPS', 0.0030)
    return p.d


def panel_ped_aft():
    fr, H = seg_frame(PED_P2, PED_P3, -PED_Y)
    W = 2 * PED_Y
    p = Panel('ped_aft', fr, W, H)
    p.plate(0.004, 0.004, 0.150, H - 0.008)
    p.title(0.012, 0.014, 0.134, 'FLOOD LT', 0.0038)
    p.knob(0.080, 0.050, 0.0070, 'round', 'PED FLOOD', ['OFF', 'BRT'], lsize=0.0030)
    p.plate(0.158, 0.004, W - 0.316, H - 0.008)
    p.rect(0.178, 0.030, W - 0.356, 0.110, (40, 44, 50))
    p.text(W / 2, 0.020, 'PRINTER', 0.0036)
    p.rect(0.190, 0.040, W - 0.380, 0.012, (18, 18, 20))
    p.plate(W - 0.154, 0.004, 0.150, H - 0.008)
    p.title(W - 0.146, 0.014, 0.134, 'GRAVITY GEAR', 0.0038)
    p.rect(W - 0.120, 0.040, 0.080, 0.060, (150, 30, 26))
    p.text(W - 0.080, 0.070, 'TURN 3 TIMES', 0.0030)
    return p.d


# ================================================================================================ overhead
def ovh_frame():
    """Overhead faces down; read by the pilot looking up, so the panel 'top' is the aft edge."""
    O = B(OVH_AFT[0], -OVH_W / 2, OVH_AFT[1])
    V = B(OVH_FRONT[0], -OVH_W / 2, OVH_FRONT[1]) - O
    fr = Frame(O, (1, 0, 0), V)
    return fr, float(np.linalg.norm(V))


def cell_pb(label, up, lo, guard=None, w=0.019, h=0.019):
    return ('pb', label, up, lo, guard, w, h)


F, O_, A_, ON, AV = (('FAULT', 'amber', False), ('OFF', 'white', False), ('AUTO', 'white', False),
                     ('ON', 'blue', False), ('AVAIL', 'green', False))


def panel_overhead():
    fr, H = ovh_frame()
    W = OVH_W
    p = Panel('overhead', fr, W, H, atlas='B')

    def block(x, y, w, h, title, rows, row_y=None):
        """Panel plate with a title and evenly spaced rows of cells.  Cell forms:
           ('pb', label, up, lo, guard, w, h) | ('k', label, pos, style) | ('t', label, pos, state) | ('l', text) | None"""
        p.plate(x, y, w, h)
        if title:
            p.title(x + 0.008, y + 0.010, w - 0.016, title, 0.0046)
        n = len(rows)
        top = y + (0.024 if title else 0.010)
        rh = (h - (top - y) - 0.004) / max(n, 1)
        centres = []
        for r, row in enumerate(rows):
            cy = top + rh * (r + 0.58) if row_y is None else y + row_y[r]
            pitch = (w - 0.012) / max(len(row), 1)
            for c, cell in enumerate(row):
                if cell is None:
                    continue
                cx = x + 0.006 + pitch * (c + 0.5)
                centres.append((cx, cy))
                kind = cell[0]
                if kind == 'pb':
                    _, label, up, lo, guard, bw, bh = cell
                    p.pbc(cx, cy + 0.003, w=bw, h=bh, up=up, lo=lo, label=label, guard=guard)
                elif kind == 'k':
                    _, label, pos, style = cell
                    p.knob(cx, cy + 0.004, 0.0085 if style != 'big' else 0.0105, style, label, pos)
                elif kind == 't':
                    _, label, pos, state = cell
                    p.tog(cx, cy + 0.004, label, pos, state)
                elif kind == 'l':
                    p.lcd(cx - 0.018, cy - 0.004, 0.036, 0.014, cell[1], 'amber')
        return centres

    # ---- aft maintenance strip (panel top = aft edge)
    block(0.008, 0.006, W - 0.016, 0.080, 'MAINTENANCE', [[
        cell_pb('FADEC GND PWR', None, ('ENG 1', 'white', False)), cell_pb('', None, ('ENG 2', 'white', False)),
        cell_pb('BLUE PUMP OVRD', None, ('ON', 'blue', False)), cell_pb('HYD LEAK', None, O_),
        cell_pb('', None, O_), cell_pb('APU AUTO EXTING', None, ('TEST', 'white', False)),
        cell_pb('', None, ('RESET', 'white', False)), cell_pb('SVCE INT', None, ('OVRD', 'white', False)),
        cell_pb('AVNCS LT', None, ('AUTO', 'white', False))]])
    Y0 = 0.090
    # ---- left column
    xl, wl = 0.008, 0.146
    blocks_l = [
        (0.070, 'ADIRS CDU', [[('l', 'N37.37'), ('l', 'W122.2')], [('pb', '1', None, None, None, 0.012, 0.010), ('pb', '2', None, None, None, 0.012, 0.010),
                               ('pb', '3', None, None, None, 0.012, 0.010), ('pb', 'CLR', None, None, None, 0.012, 0.010),
                               ('pb', 'ENT', None, None, None, 0.012, 0.010)]]),
        (0.150, 'ADIRS', [[('k', None, ['OFF', 'NAV', 'ATT'], 'bar'), ('k', None, ['OFF', 'NAV', 'ATT'], 'bar'),
                          ('k', None, ['OFF', 'NAV', 'ATT'], 'bar')],
                         [cell_pb('IR 1', F, O_), cell_pb('IR 3', F, O_), cell_pb('IR 2', F, O_)],
                         [cell_pb('ADR 1', F, O_), cell_pb('ADR 3', F, O_), cell_pb('ADR 2', F, O_)],
                         [('pb', 'ON BAT', None, None, None, 0.024, 0.010)]]),
        (0.072, 'FLT CTL', [[cell_pb('ELAC 1', F, O_), cell_pb('SEC 1', F, O_), cell_pb('FAC 1', F, O_)]]),
        (0.072, 'EVAC', [[cell_pb('COMMAND', ('EVAC', 'red', False), ('ON', 'white', False)),
                          cell_pb('HORN SHUT OFF', None, None), ('t', 'CAPT & PURS', ['CAPT', 'CAPT&PURS'], 0)]]),
        (0.084, 'EMER ELEC PWR', [[cell_pb('EMER GEN TEST', None, None, 'clear'), cell_pb('GEN 1 LINE', ('SMOKE', 'amber', False), O_),
                                   cell_pb('RAT & EMER GEN', F, ('MAN ON', 'white', False), 'red', 0.020, 0.020)]]),
        (0.070, 'GPWS', [[cell_pb('TERR', F, O_), cell_pb('SYS', F, O_), cell_pb('G/S MODE', None, O_),
                          cell_pb('FLAP MODE', None, O_), cell_pb('LDG FLAP 3', None, ON)]]),
        (0.066, 'RCDR', [[cell_pb('GND CTL', None, ON), cell_pb('CVR ERASE', None, None), cell_pb('CVR TEST', None, None)]]),
        (0.072, 'OXYGEN', [[cell_pb('MASK MAN ON', None, None, 'red', 0.020, 0.020),
                            cell_pb('PASSENGER', ('SYS ON', 'white', False), None), cell_pb('CREW SUPPLY', None, O_)]]),
        (0.064, 'CALLS', [[cell_pb('MECH', None, None), cell_pb('FWD', None, None), cell_pb('AFT', None, None),
                           cell_pb('EMER', ('CALL', 'amber', False), ('ON', 'white', False))]]),
        (0.100, None, [[cell_pb('RAIN RPLNT', None, None), ('k', 'WIPER', ['OFF', 'SLOW', 'FAST'], 'bar')]]),
    ]
    # ---- centre column
    xc, wc = 0.157, 0.286
    blocks_c = [
        (0.160, 'FIRE', [[('pb', 'ENG 1', ('FIRE', 'red', False), ('PUSH', 'white', False), 'fire', 0.050, 0.030),
                          ('pb', 'APU', ('FIRE', 'red', False), ('PUSH', 'white', False), 'fire', 0.050, 0.030),
                          ('pb', 'ENG 2', ('FIRE', 'red', False), ('PUSH', 'white', False), 'fire', 0.050, 0.030)],
                         [cell_pb('AGENT 1', ('SQUIB', 'white', False), ('DISCH', 'amber', False)),
                          cell_pb('AGENT 2', ('SQUIB', 'white', False), ('DISCH', 'amber', False)),
                          cell_pb('AGENT', ('SQUIB', 'white', False), ('DISCH', 'amber', False)),
                          cell_pb('AGENT 1', ('SQUIB', 'white', False), ('DISCH', 'amber', False)),
                          cell_pb('AGENT 2', ('SQUIB', 'white', False), ('DISCH', 'amber', False))],
                         [cell_pb('TEST', None, None), None, cell_pb('TEST', None, None), None, cell_pb('TEST', None, None)]]),
        (0.090, 'HYD', [[cell_pb('ENG 1 PUMP', F, O_), cell_pb('RAT MAN ON', None, None, 'red', 0.020, 0.020),
                         cell_pb('ELEC PUMP', F, O_), cell_pb('PTU', F, O_), cell_pb('ELEC PUMP', F, ('ON', 'white', False)),
                         cell_pb('ENG 2 PUMP', F, O_)]]),
        (0.140, 'FUEL', [[cell_pb('L TK PUMP 1', F, O_), cell_pb('L TK PUMP 2', F, O_), cell_pb('CTR TK PUMP 1', F, O_),
                          cell_pb('MODE SEL', F, ('MAN', 'white', False)), cell_pb('CTR TK PUMP 2', F, O_),
                          cell_pb('R TK PUMP 1', F, O_), cell_pb('R TK PUMP 2', F, O_)],
                         [None, None, cell_pb('X FEED', ('OPEN', 'green', False), ('ON', 'white', False)), None, None]]),
        (0.176, 'ELEC', [[cell_pb('BAT 1', F, O_), ('l', '28.2V'), cell_pb('BAT 2', F, O_), cell_pb('GALLEY', F, O_),
                          cell_pb('AC ESS FEED', F, ('ALTN', 'white', False))],
                         [cell_pb('IDG 1', ('FAULT', 'amber', False), None, 'red'), cell_pb('GEN 1', F, O_),
                          cell_pb('BUS TIE', None, O_), cell_pb('APU GEN', F, O_), cell_pb('EXT PWR', ('AVAIL', 'green', False), ('ON', 'blue', False)),
                          cell_pb('GEN 2', F, O_), cell_pb('IDG 2', ('FAULT', 'amber', False), None, 'red')],
                         [cell_pb('COMMERCIAL', F, O_), None, None, None, None, None, cell_pb('ESS TR', None, None)]]),
        (0.176, 'AIR COND', [[('k', 'PACK FLOW', ['LO', 'NORM', 'HI'], 'bar'), ('k', 'COCKPIT', ['COLD', 'HOT'], 'big'),
                              ('k', 'FWD CABIN', ['COLD', 'HOT'], 'big'), ('k', 'AFT CABIN', ['COLD', 'HOT'], 'big'),
                              cell_pb('HOT AIR', F, O_)],
                             [cell_pb('PACK 1', F, O_), cell_pb('ENG 1 BLEED', F, O_), cell_pb('RAM AIR', None, ('ON', 'white', False), 'red'),
                              cell_pb('APU BLEED', F, ('ON', 'blue', True)), ('k', 'X BLEED', ['SHUT', 'AUTO', 'OPEN'], 'bar'),
                              cell_pb('ENG 2 BLEED', F, O_), cell_pb('PACK 2', F, O_)]]),
        (0.090, [(0.52, 'ANTI ICE', [[cell_pb('WING', F, ('ON', 'blue', False)), cell_pb('ENG 1', F, ('ON', 'blue', False)),
                                      cell_pb('ENG 2', F, ('ON', 'blue', False))],
                                     [None, cell_pb('PROBE/WINDOW HEAT', None, ('ON', 'blue', False)), None]]),
                 (0.48, 'CABIN PRESS', [[cell_pb('LDG ELEV', None, None), ('k', None, ['-2', '0', '14'], 'round')],
                                        [cell_pb('MODE SEL', F, ('MAN', 'white', False)), ('t', 'MAN V/S CTL', ['UP', '', 'DN'], 1),
                                         cell_pb('DITCHING', None, ('ON', 'white', False))]])]),
        (0.140, [(0.56, 'EXT LT', [[('t', 'STROBE', ['ON', 'AUTO', 'OFF'], 0), ('t', 'BEACON', ['ON', 'OFF'], 0),
                                    ('t', 'WING', ['ON', 'OFF'], 1), ('t', 'NAV&LOGO', ['1', 'OFF', '2'], 0),
                                    ('t', 'RWY TURN OFF', ['ON', 'OFF'], 0)],
                                   [('t', 'LAND L', ['ON', 'OFF', 'RETR'], 0), ('t', 'LAND R', ['ON', 'OFF', 'RETR'], 0),
                                    ('t', 'NOSE', ['T.O.', 'TAXI', 'OFF'], 0)]]),
                 (0.16, 'APU', [[cell_pb('MASTER SW', F, ('ON', 'blue', True))], [cell_pb('START', ('ON', 'blue', False), ('AVAIL', 'green', True))]]),
                 (0.28, 'SIGNS', [[('t', 'SEAT\nBELTS', ['ON', 'OFF'], 0), ('t', 'NO\nSMOKING', ['ON', 'AUTO', 'OFF'], 1),
                                   ('t', 'EMER\nEXIT LT', ['ON', 'ARM', 'OFF'], 1)],
                                  [('k', 'INTEG LT', ['OFF', 'BRT'], 'round'), ('t', 'DOME', ['BRT', 'DIM', 'OFF'], 2),
                                   ('t', 'ANN LT', ['TEST', 'BRT', 'DIM'], 1)]])]),
    ]
    # ---- right column
    xr, wr = 0.446, 0.146
    blocks_r = [
        (0.100, None, [[cell_pb('TFTS', None, ('INOP', 'amber', False)), None], [None, None]]),
        (0.072, 'FLT CTL', [[cell_pb('ELAC 2', F, O_), cell_pb('SEC 2', F, O_), cell_pb('SEC 3', F, O_), cell_pb('FAC 2', F, O_)]]),
        (0.086, 'CARGO VENT', [[cell_pb('AFT ISOL VALVE', F, O_), ('k', 'AFT', ['COLD', 'HOT'], 'round'), cell_pb('HOT AIR', F, O_)]]),
        (0.096, 'CARGO SMOKE', [[cell_pb('DISCH', None, None, 'red', 0.020, 0.020), cell_pb('FWD', ('SMOKE', 'red', False), None),
                                 cell_pb('TEST', None, None), cell_pb('AFT', ('SMOKE', 'red', False), None),
                                 cell_pb('DISCH', None, None, 'red', 0.020, 0.020)]]),
        (0.082, 'VENTILATION', [[cell_pb('BLOWER', F, O_), cell_pb('EXTRACT', F, O_), cell_pb('CAB FANS', None, O_)]]),
        (0.072, 'ENG', [[cell_pb('MAN START 1', None, ON), cell_pb('MAN START 2', None, ON)]]),
        (0.070, 'AUDIO SWITCHING', [[('k', 'ACP', ['CAPT 3', 'NORM', 'F/O 3'], 'bar'), cell_pb('APU', None, None)]]),
        (0.090, 'CVR', [[cell_pb('CVR', None, ('TEST', 'white', False)), ('l', '00:00')]]),
        (0.100, None, [[('k', 'WIPER', ['OFF', 'SLOW', 'FAST'], 'bar'), cell_pb('RAIN RPLNT', None, None)]]),
    ]
    y_end = H - 0.010
    for x, w, blocks in ((xl, wl, blocks_l), (xc, wc, blocks_c), (xr, wr, blocks_r)):
        tot = sum(b[0] for b in blocks)
        k = (y_end - Y0 - 0.003 * (len(blocks) - 1)) / tot
        y = Y0
        for b in blocks:
            hh = b[0] * k
            if isinstance(b[1], list):          # side-by-side sub panels: (h, [(width fraction, title, rows), ...])
                xx = x
                for frac, title, rows in b[1]:
                    ww = w * frac - (0.003 if frac < 1 else 0)
                    block(xx, y, ww, hh, title, rows)
                    xx += ww + 0.003
            else:
                block(x, y, w, hh, b[1], b[2])
            y += hh + 0.003
    # flow lines on the synoptic panels (HYD / FUEL / ELEC / AIR COND): drawn by the painter from these hints
    return p.d


# ================================================================================================ side consoles
def panel_console(side):
    tag = 'capt' if side < 0 else 'fo'
    W = CONS_Y1 - CONS_Y0
    H = CONS_S1 - CONS_S0
    if side < 0:
        O = B(CONS_S0, -CONS_Y1, CONS_Z)
        U = B(CONS_S0, -CONS_Y0, CONS_Z) - O
        V = B(CONS_S1, -CONS_Y1, CONS_Z) - O
    else:
        O = B(CONS_S0, CONS_Y0, CONS_Z)
        U = B(CONS_S0, CONS_Y1, CONS_Z) - O
        V = B(CONS_S1, CONS_Y0, CONS_Z) - O
    fr = Frame(O, U, V)
    p = Panel(f'console_{tag}', fr, W, H, atlas='B', appm=1200, bg=(92, 104, 118))
    X = (lambda yw: CONS_Y1 - yw) if side < 0 else (lambda yw: yw - CONS_Y0)
    sx, ty = X(STICK['y']), STICK['s'] - CONS_S0
    p.plate(sx - 0.075, ty - 0.080, 0.150, 0.170)
    p.text(sx, ty + 0.080, 'SIDE STICK', 0.0045)
    p.rect(sx - 0.052, ty - 0.052, 0.104, 0.104, (30, 32, 36))
    tx, tty = X(TILLER['y']), TILLER['s'] - CONS_S0
    p.plate(tx - 0.070, tty - 0.060, 0.140, 0.125)
    p.text(tx, tty + 0.056, 'STEERING', 0.0042)
    p.plate(0.010, 0.010, W - 0.020 if side < 0 else W - 0.020, 0.060)
    p.rect(0.030 if side < 0 else W - 0.130, 0.018, 0.100, 0.044, (36, 40, 46))
    p.text(0.080 if side < 0 else W - 0.080, 0.070, 'CUP HOLDER', 0.0036)
    ox = 0.020 if side < 0 else W - 0.220
    p.plate(ox, 0.560, 0.200, 0.200)
    p.text(ox + 0.100, 0.574, 'OXYGEN MASK', 0.0048)
    p.rect(ox + 0.020, 0.590, 0.160, 0.140, (40, 44, 50))
    p.text(ox + 0.100, 0.742, 'PRESS TO TEST AND RESET', 0.0032)
    p.plate(0.010, 0.780, W - 0.020, 0.190)
    p.rect(0.030, 0.800, W - 0.060, 0.150, (54, 60, 68))
    p.text(W / 2, 0.875, 'DOCUMENTS', 0.0048)
    return p.d


def all_panels():
    return [panel_mip_side(-1), panel_mip_center(), panel_mip_side(1), panel_fcu(), panel_efis(-1), panel_efis(1),
            panel_gs_side(-1), panel_gs_side(1), panel_ped_mcdu(), panel_ped_main(), panel_ped_aft(), panel_overhead(),
            panel_console(-1), panel_console(1)]


# ================================================================================================ atlas packing
ATLAS = 4096
APPM = {'A': 2950, 'B': 2600}          # atlas pixels per meter (panels may override with 'appm')
PAD = 10


def panel_appm(p):
    return p['appm'] or APPM[p['atlas']]


def pack(panels, extra=None):
    """Shelf-pack every panel into its atlas; returns dict name -> (atlas, x0, y0, w_px, h_px)."""
    out = {}
    for atlas in ('A', 'B'):
        items = [(p['name'], int(math.ceil(p['w'] * panel_appm(p))), int(math.ceil(p['h'] * panel_appm(p))))
                 for p in panels if p['atlas'] == atlas]
        items += [(n, w, h) for (n, a, w, h) in (extra or []) if a == atlas]
        items.sort(key=lambda t: -t[2])
        x = y = shelf = 0
        for name, w, h in items:
            if x + w > ATLAS:
                x, y, shelf = 0, y + shelf + PAD, 0
            out[name] = (atlas, x, y, w, h)
            x += w + PAD
            shelf = max(shelf, h)
        if y + shelf > ATLAS:
            raise RuntimeError(f'atlas {atlas} overflow: {y + shelf}')
    return out


# extra atlas regions: circuit-breaker panels (rear side walls), button/knob side colours
CB_W, CB_H = 0.80, 0.66
EXTRA = [('cb', 'B', int(CB_W * 900), int(CB_H * 900)), ('swatch', 'A', 64, 64), ('swatchB', 'B', 64, 64),
         ('quadrant', 'A', 330, 900)]


def regions():
    return pack(all_panels(), EXTRA)


MCDU_PAGE = [
    ('         F-PLN      TK1234', 'w'),
    (' FROM             SPD/ALT', 'w'),
    ('KSFO28R  1302    ---/   13', 'g'),
    (' C284°', 'w'),
    ('SFO01    1304    160/ 1200', 'g'),
    ('          (SPD)', 'c'),
    ('SEPDO    1306    250/ 4000', 'g'),
    (' TRK286', 'w'),
    ('PORTE    1311    250/FL100', 'g'),
    ('       (DECEL)', 'c'),
    (' DEST    UTC   DIST  EFOB', 'w'),
    ('KOAK28R  1341    412   6.8', 'w'),
]

if __name__ == '__main__':
    ps = all_panels()
    r = regions()
    tot = {'A': 0, 'B': 0}
    for p in ps:
        print(f"{p['name']:12s} {p['w']:.3f} x {p['h']:.3f} items {len(p['items']):4d}  {r[p['name']]}")
        tot[p['atlas']] += p['w'] * p['h']
    print('area', tot)
    print('PED', PED_P0, PED_P1, PED_P2, PED_P3)
