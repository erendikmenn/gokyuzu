"""737-800 (NG) flight deck layout, shared by the panel painter (textures_fd.py), the geometry builder
(interior.py) and the bake step (bake_fd.py).

Built from reference photos in blender/aircraft/b737/ref/ (frontal jumpseat views of the main instrument
panel, overhead and pedestal close-ups). Real proportions: 8" square display units (0.20 m visible),
ARINC-width (146 mm) CDUs and radio panels, MIP 1.66 m wide, MCP 0.56 m, forward overhead 0.80 x 0.94 m.

Every panel is a flat plate with a frame in the ground frame (X aft of the nose tip, Y right, Z up):
origin = lower-left corner as seen by the crew, x/y unit vectors in the plate, size w x h (m) and a pixel
rectangle in the panel atlas (ATLAS x ATLAS px, allocated by pack_atlas()). Controls are placed in panel
coordinates (m from the lower-left corner); the builder turns them into geometry whose visible faces are
UV-mapped onto the same atlas pixels the painter draws on, so labels and legends line up with the 3D parts.
"""
import math
import numpy as np

ATLAS = 4096
FLOOR = 2.65


def _n(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


class Ctl:
    def __init__(self, kind, x, y, **kw):
        self.kind, self.x, self.y = kind, x, y
        self.kw = kw

    def __getattr__(self, k):
        if k == 'kw':
            raise AttributeError
        return self.kw.get(k)


class Panel:
    def __init__(self, name, origin, xaxis, yaxis, w, h, density=1.8, bg='gray', depth=0.03, shape=None, lite=True):
        self.name = name
        self.o = np.asarray(origin, float)
        self.x = _n(xaxis)
        self.y = _n(yaxis)
        self.n = _n(np.cross(self.x, self.y))      # towards the crew
        self.w, self.h = w, h
        self.density = density                      # atlas px per mm
        self.rect = None                            # px (x0, y0, x1, y1), y0 = top row (set by pack_atlas)
        self.bg = bg
        self.depth = depth
        self.shape = shape                          # optional polygon in panel coords (m)
        self.lite = lite                            # copied into interior_lite
        self.ctls = []
        self.plates = []                            # (x, y, w, h, title, style) sub-panel plates (Dzus panels)
        self.texts = []                             # (x, y, text, size_m, colour, anchor, font)
        self.lines = []                             # (pts, width_m, colour) painted lines
        self.nogeo = False                          # atlas-only panel (painted, mapped by special geometry)

    def P(self, x, y, off=0.0):
        return self.o + self.x * x + self.y * y + self.n * off

    def uv(self, x, y):
        x0, y0, x1, y1 = self.rect
        px = x0 + (x / self.w) * (x1 - x0)
        py = y1 - (y / self.h) * (y1 - y0)
        return (px / ATLAS, 1.0 - py / ATLAS)

    def px(self, x, y):
        x0, y0, x1, y1 = self.rect
        return (x0 + (x / self.w) * (x1 - x0), y1 - (y / self.h) * (y1 - y0))

    def ppm(self):
        return (self.rect[2] - self.rect[0]) / self.w

    def add(self, kind, x, y, **kw):
        c = Ctl(kind, x, y, **kw)
        self.ctls.append(c)
        return c

    def plate(self, x, y, w, h, title=None, style='gray', title_at='top'):
        self.plates.append((x, y, w, h, title, style, title_at))

    def text(self, x, y, s, size=0.0045, col='white', anchor='mm', font='futura'):
        self.texts.append((x, y, s, size, col, anchor, font))

    def line(self, pts, width=0.0008, col='white'):
        self.lines.append((pts, width, col))


# ================================================================== geometry anchors (ground frame)
EYE_CAPT = (3.13, -0.53, 3.86)
EYE_FO = (3.13, 0.53, 3.86)

# main instrument panel: flat, 1.66 m wide, top leaning 7 deg forward
MIP_W, MIP_H = 1.66, 0.450
MIP_O = np.array((2.465, -0.83, 2.97))
MIP_Y = _n((-0.06, 0.0, 0.474))
MIP_N = _n(np.cross((0, 1, 0), MIP_Y))
DU = 0.200                                  # visible display (8 in)
DU_Y0 = 0.151                               # DU bottom edge (panel y)
P9_TOP = 0.100                              # panel y where the sloped forward electronic panel (P9) starts
P9_HALF = 0.28
P9_SLOPE = math.radians(43)                 # from vertical
P9_LEN = 0.275
# glareshield
GS_TOP_Z = 3.588                            # anti-glare top (just below the windshield sill)
GS_FACE_TOP = np.array((2.500, 3.556))      # (X, Z) upper edge of the aft face (MCP), leaning forward
GS_FACE_BOT = np.array((2.530, 3.450))      # (X, Z) lower edge
GS_FACE_HALF = 0.70                         # planar part of the aft face (|Y|)
# control stand
TQ_X0, TQ_X1, TQ_HALF = 2.655, 3.235, 0.128
TQ_PIVOT = np.array((2.955, 2.44))          # (X, Z) thrust-lever pivot (below the cover)
TQ_R = 0.54                                 # cover radius about the pivot
P8_X0, P8_X1, P8_HALF = 3.235, 3.935, 0.222
P8_Z0, P8_Z1 = 2.935, 2.895                 # top surface height at the forward / aft end
# overhead
OV_FWD_O = np.array((2.800, -0.40, 3.985))   # forward overhead: forward-left corner (hangs over the windshield top)
OV_FWD_DIR = _n((math.cos(math.radians(22)), 0, math.sin(math.radians(22))))
OV_FWD_L = 0.94
OV_W = 0.80
OV_AFT_DIR = _n((math.cos(math.radians(9)), 0, math.sin(math.radians(9))))
OV_AFT_L = 0.36
SEAT_X = 3.19                               # seat pan centre station (seats slid a little aft, as parked)
SEAT_Z = 3.13                               # seat pan top


def mip_point(yy, zz):
    """Panel coordinates on the MIP from (ground Y, ground Z)."""
    return yy + MIP_W / 2, (zz - MIP_O[2]) / MIP_Y[2]


def tq_top_z(X):
    dx = X - TQ_PIVOT[0]
    return TQ_PIVOT[1] + math.sqrt(max(TQ_R ** 2 - dx * dx, 0.0))


# ================================================================== layout
def build_layout():
    panels = {}
    card = Panel('yoke_card', (0, 0, 0), (0, 1, 0), (0, 0, 1), 0.095, 0.125, density=2.0, bg='white', lite=False)
    card.nogeo = True
    panels['yoke_card'] = card
    _mip(panels)
    _glareshield(panels)
    _p9(panels)
    _tq(panels)
    _p8(panels)
    _overhead(panels)
    _side_consoles(panels)
    _cb_panels(panels)
    return panels


# ------------------------------------------------------------------ MIP (P1 captain, P2 centre, P3 first officer)
def _mip(panels):
    W, H = MIP_W, MIP_H
    c = W / 2
    shape = [(0.0, 0.0), (c - P9_HALF - 0.012, 0.0), (c - P9_HALF - 0.012, P9_TOP), (c + P9_HALF + 0.012, P9_TOP),
             (c + P9_HALF + 0.012, 0.0), (W, 0.0), (W, H), (0.0, H)]
    mip = Panel('mip', MIP_O, (0, 1, 0), MIP_Y, W, H, density=1.9, shape=shape)
    panels['mip'] = mip
    y0, y1 = DU_Y0, DU_Y0 + DU
    yc = (y0 + y1) / 2
    # sub-panel plates (Dzus panels): captain / centre / F/O columns + top strip + lower strips
    for s in (-1, 1):
        # outboard column with the clock
        mip.plate(c + s * 0.83 - (0.13 if s > 0 else 0.0), 0.0, 0.13, H, None)
        # PFD+ND panel
        x0 = c + s * 0.213 if s > 0 else c - 0.70
        mip.plate(x0, y0 - 0.034, 0.487, DU + 0.052, None)
        # top strip above PFD/ND
        mip.plate(x0, y1 + 0.018, 0.487, H - y1 - 0.018, None)
        # lower strip (knee panel) below the DUs, outboard of the pedestal
        lx0 = c + s * (P9_HALF + 0.012) if s > 0 else c - 0.70
        mip.plate(lx0, 0.0, 0.70 - P9_HALF - 0.012, y0 - 0.036, None)
    mip.plate(c - 0.213, P9_TOP, 0.426, y1 + 0.018 - P9_TOP, None)      # centre DU column
    mip.plate(c - 0.213, y1 + 0.018, 0.426, H - y1 - 0.018, None)       # centre top strip
    # ---- display units
    for name, yy in (('screen_pfd_capt', -0.558), ('screen_nd_capt', -0.328), ('screen_eicas_upper', 0.0),
                     ('screen_nd_fo', 0.328), ('screen_pfd_fo', 0.558)):
        mip.add('du', c + yy, yc, w=DU, h=DU, name=name)
    # ---- clocks (outboard, upper half)
    for s in (-1, 1):
        cx = c + s * 0.742
        mip.add('clock', cx, yc + 0.045, r=0.034)
        mip.text(cx, yc + 0.045 + 0.047, 'CLOCK', 0.0042)
        mip.add('pbtn', cx - 0.02, yc - 0.035, w=0.018, h=0.012, text='CHR', col='white')
        mip.add('pbtn', cx + 0.02, yc - 0.035, w=0.018, h=0.012, text='DATE', col='white')
        mip.add('knob', cx, yc - 0.075, r=0.009, style='round', label='SET')
        # BELOW G/S and speed-brake/stab annunciator block under the clock
        mip.add('pbtn', cx, y0 - 0.075, w=0.036, h=0.022, text='BELOW\nG/S\nP-INHIBIT', col='amber')
        mip.add('toggle', cx, 0.030, label='NOSE WHEEL\nSTEERING' if s < 0 else 'GPWS\nFLAP INHIBIT', pos=('ALT', 'NORM') if s < 0 else ('NORM', 'INHIBIT'), guard=s > 0)
    # ---- top strip above PFD/ND (P1-1 / P3-1)
    for s in (-1, 1):
        # MAIN PANEL DUs + LOWER DU selectors above the PFD/ND boundary
        kx = c + s * 0.44
        mip.add('knob', kx - s * 0.035, y1 + 0.036, r=0.011, style='pointer', label='MAIN PANEL DUs',
                ring=['OUTBD PFD', 'NORM', 'ENG PRI', 'PFD', 'MFD'] if s < 0 else ['MFD', 'PFD', 'ENG PRI', 'NORM', 'OUTBD PFD'])
        mip.add('knob', kx + s * 0.035, y1 + 0.036, r=0.011, style='pointer', label='LOWER DU',
                ring=['ENG PRI', 'NORM', 'ND'] if s < 0 else ['ND', 'NORM', 'ENG PRI'])
        # autopilot / autothrottle / FMC disengage lights + test switch (inboard)
        ax = c + s * 0.305
        for i, (t, col) in enumerate((('A/P\nP/RST', 'red'), ('A/T\nP/RST', 'red'), ('FMC\nP/RST', 'amber'))):
            mip.add('pbtn', ax - 0.036 + i * 0.024, y1 + 0.034, w=0.021, h=0.016, text=t, col=col)
        mip.add('toggle', ax + 0.052, y1 + 0.032, label='LIGHTS', pos=('TEST', 'BRT', 'DIM'))
        mip.text(ax - 0.012, y1 + 0.056, 'DISENGAGE LIGHTS', 0.0030)
        # SPD REF / N1 set knobs on the outboard end
        ox = c + s * 0.64
        mip.add('pbtn', ox, y1 + 0.034, w=0.030, h=0.016, text='FMC', col='amber')
        mip.text(ox, y1 + 0.054, 'FMC', 0.0032)
        # DU brightness knobs under PFD / ND
        for du in (0.558, 0.328):
            mip.add('knob', c + s * du + 0.07, y0 - 0.017, r=0.0075, style='round', label=None)
            mip.text(c + s * du + 0.07, y0 - 0.030, 'BRT', 0.003)
        # knee panel (P1-3 / P3-3): EFIS source / displays / range / selectors
        kx0 = c + s * 0.58
        mip.add('knob', kx0 - 0.07, 0.050, r=0.013, style='pointer', label='VHF NAV', ring=['BOTH 1', 'NORM', 'BOTH 2'])
        mip.add('knob', kx0, 0.050, r=0.013, style='pointer', label='IRS', ring=['BOTH L', 'NORM', 'BOTH R'])
        mip.add('knob', kx0 + 0.07, 0.050, r=0.013, style='pointer', label='DISPLAYS', ring=['ALL 1', 'AUTO', 'ALL 2'])
        mip.add('annun', kx0 - 0.105, 0.098, w=0.040, h=0.014, text='SPEEDBRAKE\nARMED', col='green' if s < 0 else 'amber')
        mip.add('annun', kx0 - 0.060, 0.098, w=0.040, h=0.014, text='SPEEDBRAKE\nDO NOT ARM' if s < 0 else 'GPWS\nINOP', col='amber')
        mip.add('annun', kx0 - 0.015, 0.098, w=0.040, h=0.014, text='STAB OUT\nOF TRIM' if s < 0 else 'TERR\nINOP', col='amber')
        mip.add('annun', kx0 + 0.030, 0.098, w=0.040, h=0.014, text='AUTOLAND' if s < 0 else 'TAKEOFF\nCONFIG', col='red' if s < 0 else 'red')
        mip.add('pbtn', kx0 + 0.085, 0.098, w=0.030, h=0.018, text='SYS\nTEST', col='white')
    # ---- centre column: yaw damper, ISFD, RDMI | upper DU | gear lever, brake pressure
    mip.add('gauge', c - 0.165, y1 + 0.040, r=0.019, dial='yaw', label=None)
    mip.text(c - 0.165, y1 + 0.068, 'YAW DAMPER', 0.0030)
    mip.add('isfd', c - 0.165, yc + 0.042, w=0.066, h=0.066, name='screen_isfd')
    mip.text(c - 0.165, yc + 0.092, 'ISFD HEADING FROM\nLEFT IRS ONLY', 0.0026, col='white')
    mip.add('gauge', c - 0.165, yc - 0.066, r=0.036, dial='rdmi', label=None)
    mip.add('placard', c - 0.165, y0 - 0.008, w=0.07, h=0.012, text='STANDBY RMI')
    # autobrake / N1 set / SPD REF / fuel flow / MFD block above the upper DU
    bx = c - 0.06
    mip.plate(bx - 0.062, y1 + 0.004, 0.160, 0.074, None, style='gray2')
    mip.add('knob', bx - 0.038, y1 + 0.050, r=0.0095, style='pointer', label='N1 SET', ring=['2', '1', 'AUTO', 'BOTH'], ring_r=1.7)
    mip.add('knob', bx + 0.008, y1 + 0.050, r=0.0095, style='pointer', label='SPD REF', ring=['V1', 'VR', 'WT', 'VREF', '80', 'SET'], ring_r=1.7)
    mip.add('knob', bx + 0.068, y1 + 0.048, r=0.0125, style='pointer', label='AUTO BRAKE', ring=['RTO', 'OFF', '1', '2', '3', 'MAX'], ring_r=1.7)
    mip.add('toggle', bx - 0.044, y1 + 0.017, label=None, pos=('RESET', 'USED'), small=True)
    mip.text(bx - 0.030, y1 + 0.026, 'FUEL FLOW', 0.0026)
    mip.add('pbtn', bx - 0.004, y1 + 0.016, w=0.016, h=0.012, text='ENG', col='white')
    mip.add('pbtn', bx + 0.016, y1 + 0.016, w=0.016, h=0.012, text='SYS', col='white')
    mip.text(bx + 0.006, y1 + 0.028, 'MFD', 0.0028)
    mip.add('annun', bx + 0.068, y1 + 0.013, w=0.034, h=0.011, text='ANTISKID\nINOP', col='amber')
    mip.add('gauge', c + 0.080, y1 + 0.042, r=0.026, dial='flaps', label=None)
    # gear column (right of the upper DU)
    gx = c + 0.158
    mip.add('annun', gx, y1 + 0.052, w=0.024, h=0.015, text='NOSE\nGEAR', col='green', lit=True)
    mip.add('annun', gx - 0.026, y1 + 0.034, w=0.024, h=0.015, text='LEFT\nGEAR', col='green', lit=True)
    mip.add('annun', gx + 0.026, y1 + 0.034, w=0.024, h=0.015, text='RIGHT\nGEAR', col='green', lit=True)
    mip.add('annun', gx, y1 + 0.016, w=0.024, h=0.012, text='NOSE\nGEAR', col='red')
    mip.add('gear', gx, yc - 0.012)
    mip.add('placard', gx, y0 - 0.020, w=0.058, h=0.040,
            text='LANDING GEAR\nLIMIT (IAS)\nOPERATING\nEXTEND  270K-.82M\nRETRACT 235K\nEXTENDED 320K-.82M')
    mip.add('gauge', c + 0.232, y1 + 0.040, r=0.020, dial='brake', label=None)
    mip.text(c + 0.232, y1 + 0.068, 'BRAKE PRESS', 0.0028)
    return mip


# ------------------------------------------------------------------ glareshield (P7): EFIS, MCP, warning lights
def gs_panel_frame():
    """Aft (tilted) face of the glareshield: origin at lower-left (Y = -GS_FACE_HALF)."""
    bot, top = GS_FACE_BOT, GS_FACE_TOP
    yax = _n((top[0] - bot[0], 0.0, top[1] - bot[1]))
    h = float(np.hypot(*(top - bot)))
    return np.array((bot[0], -GS_FACE_HALF, bot[1])), yax, h


def _glareshield(panels):
    o, yax, h = gs_panel_frame()
    W = 2 * GS_FACE_HALF
    gs = Panel('glareshield', o, (0, 1, 0), yax, W, h, density=2.4, bg='black')
    panels['glareshield'] = gs
    c = W / 2
    # ---------------- MCP (0.62 m): captain COURSE ... A/P ENGAGE, F/D and COURSE of the first officer
    m0, m1 = c - 0.31, c + 0.31
    gs.plate(m0, 0.004, m1 - m0, h - 0.008, None, style='mcp')
    top = h - 0.018          # label row
    win = h - 0.034          # display windows
    kno = h - 0.066          # knobs
    btn2 = 0.017             # lower button row

    def mcpwin(x, w, text, label):
        gs.add('lcd', m0 + x, win, w=w, h=0.017, text=text, col='mcp', label=label, label_y=top)

    def mbtn(x, y, text, lit=False, w=0.024, h=0.014):
        gs.add('pbtn', m0 + x, y, w=w, h=h, text=text, col='white', lit=lit, bar=True)

    for cx, lab in ((0.030, 'COURSE'), (0.590, 'COURSE')):
        mcpwin(cx, 0.036, '087', lab)
        gs.add('knob', m0 + cx, kno, r=0.0110, style='mcp')
    for cx in (0.068, 0.555):
        gs.add('toggle', m0 + cx, win - 0.004, label='F/D', pos=('ON', 'OFF'), small=True, handle='black')
        gs.add('annun', m0 + cx, win + 0.014, w=0.016, h=0.007, text='MA', col='green', lit=True)
    gs.add('toggle', m0 + 0.100, win - 0.004, label='A/T ARM', pos=('ARM', 'OFF'), small=True, handle='black')
    gs.add('annun', m0 + 0.100, win + 0.014, w=0.016, h=0.007, text='ARM', col='green', lit=True)
    mbtn(0.078, kno - 0.004, 'N1')
    mbtn(0.106, kno - 0.004, 'SPEED')
    mcpwin(0.160, 0.050, '250', 'IAS/MACH')
    gs.add('knob', m0 + 0.160, kno, r=0.0115, style='mcp')
    mbtn(0.137, btn2, 'C/O', w=0.018, h=0.011)
    mbtn(0.183, btn2, 'SPD\nINTV', w=0.018, h=0.011)
    mbtn(0.218, win - 0.002, 'VNAV', lit=True)
    mbtn(0.218, kno - 0.004, 'LVL CHG')
    mcpwin(0.270, 0.040, '287', 'HEADING')
    gs.add('knob', m0 + 0.270, kno, r=0.0125, style='mcp', ring=['10', '15', '20', '25', '30'], label=None)
    mbtn(0.270, btn2, 'HDG SEL', w=0.026, h=0.011)
    mbtn(0.320, win - 0.002, 'LNAV', lit=True)
    mbtn(0.320, kno + 0.009, 'VOR LOC')
    mbtn(0.320, kno - 0.016, 'APP')
    mcpwin(0.376, 0.058, '10000', 'ALTITUDE')
    gs.add('knob', m0 + 0.376, kno, r=0.0125, style='mcp')
    mbtn(0.402, btn2, 'ALT\nINTV', w=0.018, h=0.011)
    mbtn(0.425, kno - 0.004, 'ALT HLD')
    mcpwin(0.462, 0.048, '+1500', 'VERT SPEED')
    gs.add('wheel', m0 + 0.458, kno - 0.004, w=0.012, h=0.030)
    mbtn(0.482, kno - 0.004, 'V/S', w=0.018)
    for i, t in enumerate(('CMD A', 'CMD B', 'CWS A', 'CWS B')):
        mbtn(0.511 + (i % 2) * 0.025, win - 0.002 - (i // 2) * 0.021, t, lit=(t == 'CMD A'), w=0.022)
    gs.text(m0 + 0.5235, top, 'A/P ENGAGE', 0.0030)
    gs.add('pbtn', m0 + 0.5235, btn2 - 0.001, w=0.046, h=0.010, text='DISENGAGE', col='white', bar=False)
    # ---------------- EFIS control panels (0.145 m) either side
    for s in (-1, 1):
        ex = c + s * 0.390
        e0 = ex - 0.0725
        gs.plate(e0, 0.004, 0.145, h - 0.008, None, style='mcp')
        gs.add('knob', ex - 0.045, h - 0.035, r=0.0105, style='mcp', label='MINS', ring=['RADIO', 'BARO'], ring_r=1.9)
        gs.add('knob', ex + 0.045, h - 0.035, r=0.0105, style='mcp', label='BARO', ring=['IN', 'HPA'], ring_r=1.9)
        gs.add('pbtn', ex - 0.012, h - 0.030, w=0.016, h=0.010, text='FPV', col='white')
        gs.add('pbtn', ex + 0.012, h - 0.030, w=0.016, h=0.010, text='MTRS', col='white')
        gs.add('toggle', ex - 0.060, 0.042, label='VOR1', pos=('VOR', 'OFF', 'ADF'), small=True, handle='black')
        gs.add('knob', ex - 0.022, 0.044, r=0.011, style='mcp', label='MODE', ring=['APP', 'VOR', 'MAP', 'PLN'], ring_r=1.75)
        gs.add('knob', ex + 0.024, 0.044, r=0.011, style='mcp', label='RANGE', ring=['5', '10', '20', '40', '80', '160', '320', '640'], ring_r=1.75)
        gs.add('toggle', ex + 0.060, 0.042, label='VOR2', pos=('VOR', 'OFF', 'ADF'), small=True, handle='black')
        for i, t in enumerate(('WXR', 'STA', 'WPT', 'ARPT', 'DATA', 'POS', 'TERR')):
            gs.add('pbtn', ex - 0.060 + i * 0.020, 0.013, w=0.016, h=0.009, text=t, col='white')
        # six-pack (system annunciator) + master caution / fire warning at the ends
        sx = c + s * 0.533
        labels = (('FLT CONT', 'IRS', 'FUEL', 'ELEC', 'APU', 'OVHT/DET') if s < 0 else
                  ('ANTI-ICE', 'HYD', 'DOORS', 'ENG', 'OVERHEAD', 'AIR COND'))
        gs.plate(sx - 0.058, 0.022, 0.116, 0.056, None, style='mcp')
        for i, t in enumerate(labels):
            col_i, row_i = i % 3, i // 3
            gs.add('annun', sx - 0.036 + col_i * 0.036, 0.061 - row_i * 0.021, w=0.033, h=0.017, text=t, col='amber', recess=True)
        wx = c + s * 0.642
        gs.plate(wx - 0.040, 0.012, 0.080, 0.078, None, style='mcp')
        gs.add('mc', wx - s * 0.018, 0.051, w=0.032, h=0.030, text='FIRE\nWARN', col='red')
        gs.add('mc', wx + s * 0.018, 0.051, w=0.032, h=0.030, text='MASTER\nCAUTION', col='amber')
        gs.text(wx - s * 0.018, 0.026, 'PUSH TO RESET', 0.0022)
        gs.text(wx + s * 0.018, 0.026, 'PUSH TO RESET', 0.0022)
    return gs


# ------------------------------------------------------------------ P9: forward electronic panel (CDUs + lower DU)
def p9_frame():
    top = MIP_O + MIP_Y * P9_TOP
    d = np.array((math.sin(P9_SLOPE), 0.0, -math.cos(P9_SLOPE)))
    o = top + d * P9_LEN
    o = np.array((o[0], -P9_HALF, o[2]))
    return o, -d


CDU_W, CDU_H = 0.146, 0.228
CDU_SCREEN = (0.073, 0.170, 0.100, 0.080)      # cx, cy, w, h in CDU-local metres (from the bottom edge)


def _p9(panels):
    o, yax = p9_frame()
    p9 = Panel('p9', o, (0, 1, 0), yax, 2 * P9_HALF, P9_LEN, density=2.2, bg='gray')
    panels['p9'] = p9
    c = P9_HALF
    p9.add('du', c, P9_LEN - 0.020 - DU / 2, w=DU, h=DU, name='screen_eicas_lower')
    for s, name in ((-1, 'screen_cdu_capt'), (1, 'screen_cdu_fo')):
        p9.add('cdu', c + s * 0.199, P9_LEN - 0.008 - CDU_H, name=name)
    return p9


def cdu_keys():
    """(name, cx, cy, w, h, label, style) in CDU-local coordinates (x from the left, y from the bottom edge)."""
    keys = []
    sx, sy, sw, sh = CDU_SCREEN
    for i in range(6):
        y = sy + sh / 2 - 0.0085 - i * 0.0126
        keys.append(('lsk_l%d' % i, 0.010, y, 0.012, 0.008, '', 'lsk'))
        keys.append(('lsk_r%d' % i, CDU_W - 0.010, y, 0.012, 0.008, '', 'lsk'))
    row1 = ['INIT\nREF', 'RTE', 'CLB', 'CRZ', 'DES']
    row2 = ['MENU', 'LEGS', 'DEP\nARR', 'HOLD', 'PROG', 'EXEC']
    row3 = ['N1\nLIMIT', 'FIX', 'PREV\nPAGE', 'NEXT\nPAGE']
    fy = 0.117
    for i, lab in enumerate(row1):
        keys.append(('f1_%d' % i, 0.019 + i * 0.0215, fy, 0.018, 0.010, lab, 'fn'))
    for i, lab in enumerate(row2):
        keys.append(('f2_%d' % i, 0.019 + i * 0.0215, fy - 0.0135, 0.018, 0.010, lab, 'exec' if lab == 'EXEC' else 'fn'))
    for i, lab in enumerate(row3):
        keys.append(('f3_%d' % i, 0.019 + i * 0.0215, fy - 0.027, 0.018, 0.010, lab, 'fn'))
    letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    extra = ['SP', 'DEL', '/', 'CLR']
    allk = list(letters) + extra
    for i, ch in enumerate(allk):
        r, cc = divmod(i, 5)
        keys.append(('a%d' % i, 0.062 + cc * 0.0148, 0.078 - r * 0.0122, 0.0118, 0.0098, ch, 'alpha'))
    nums = '123456789.0+'
    for i, ch in enumerate(nums):
        r, cc = divmod(i, 3)
        keys.append(('n%d' % i, 0.013 + cc * 0.0148, 0.064 - r * 0.0122, 0.0118, 0.0098, ch if ch != '+' else '+/-', 'alpha'))
    return keys


# ------------------------------------------------------------------ throttle quadrant top + sides
def _tq(panels):
    # top cover, unrolled along the arc: y runs from the aft end (y=0) to the forward end
    L = arc_len_tq()
    tq = Panel('tq_top', (TQ_X1, -TQ_HALF, tq_top_z(TQ_X1)), (0, 1, 0), (-1, 0, 0), 2 * TQ_HALF, L, density=1.8, bg='dark')
    panels['tq_top'] = tq
    for s, name in ((-1, 'tq_side_L'), (1, 'tq_side_R')):
        # vertical side plates (outboard faces) up to the curved cover; x runs forward->aft on the left, aft->forward on the right
        H = 0.262
        if s < 0:
            sp = Panel(name, (TQ_X0, -TQ_HALF, 2.72), (1, 0, 0), (0, 0, 1), TQ_X1 - TQ_X0, H, density=1.2, bg='light')
        else:
            sp = Panel(name, (TQ_X1, TQ_HALF, 2.72), (-1, 0, 0), (0, 0, 1), TQ_X1 - TQ_X0, H, density=1.2, bg='light')
        pts = [(0.0, 0.0), (sp.w, 0.0)]
        for k in range(13):
            x = sp.w * (1 - k / 12)
            X = TQ_X0 + x if s < 0 else TQ_X1 - x
            pts.append((x, min(H, tq_top_z(X) - 0.004 - 2.72)))
        sp.shape = pts
        panels[name] = sp
    return tq


def arc_len_tq():
    a0 = math.asin((TQ_X0 - TQ_PIVOT[0]) / TQ_R)
    a1 = math.asin((TQ_X1 - TQ_PIVOT[0]) / TQ_R)
    return TQ_R * (a1 - a0)


def tq_point(x, y, off=0.0):
    """Point on the curved TQ cover from panel coords (x lateral from -TQ_HALF, y arc length from the aft end)."""
    a1 = math.asin((TQ_X1 - TQ_PIVOT[0]) / TQ_R)
    a = a1 - y / TQ_R
    r = TQ_R + off
    return np.array((TQ_PIVOT[0] + r * math.sin(a), x - TQ_HALF, TQ_PIVOT[1] + r * math.cos(a)))


# ------------------------------------------------------------------ P8: aft electronic panel (fire, radios, audio, trims)
def p8_frame():
    yax = _n((-(P8_X1 - P8_X0), 0.0, P8_Z0 - P8_Z1))
    L = float(np.hypot(P8_X1 - P8_X0, P8_Z0 - P8_Z1))
    return np.array((P8_X1, -P8_HALF, P8_Z1)), yax, L


def _p8(panels):
    o, yax, L = p8_frame()
    W = 2 * P8_HALF
    p8 = Panel('p8', o, (0, 1, 0), yax, W, L, density=1.8, bg='gray')
    panels['p8'] = p8
    cw = W / 3
    # rows from the forward end (y = L) aft
    y = L
    # fire protection panel (full width)
    h = 0.100
    y -= h
    p8.plate(0.002, y, W - 0.004, h - 0.002, 'ENGINE / APU FIRE', style='gray')
    for i, (lab, xx) in enumerate((('1', 0.075), ('APU', W / 2), ('2', W - 0.075))):
        p8.add('firehandle', xx, y + 0.052, w=0.052, h=0.024, text=lab)
        p8.add('annun', xx, y + 0.020, w=0.036, h=0.011, text='BOTTLE\nDISCHARGE', col='amber')
    p8.add('toggle', 0.155, y + 0.060, label='OVHT DET', pos=('A', 'NORMAL', 'B'))
    p8.add('toggle', W - 0.155, y + 0.060, label='OVHT DET', pos=('A', 'NORMAL', 'B'))
    p8.add('pbtn', 0.150, y + 0.022, w=0.024, h=0.014, text='BELL\nCUTOUT', col='white')
    p8.add('toggle', W - 0.150, y + 0.024, label='TEST', pos=('FAULT/INOP', 'OVHT/FIRE'))
    # VHF COMM 1 | CARGO FIRE | VHF COMM 2
    h = 0.078
    y -= h
    for col, title in ((0, 'VHF COMM 1'), (2, 'VHF COMM 2')):
        _radio(p8, col * cw, y, cw, h, title, ('118.700', '121.500') if col == 0 else ('121.800', '122.800'))
    p8.plate(cw + 0.002, y, cw - 0.004, h - 0.002, 'CARGO FIRE', style='gray')
    for i, t in enumerate(('FWD', 'AFT')):
        p8.add('pbtn', cw + 0.035 + i * 0.040, y + 0.045, w=0.030, h=0.018, text=t, col='white')
    p8.add('pbtn', cw + cw - 0.032, y + 0.045, w=0.030, h=0.018, text='DISCH', col='amber')
    p8.add('pbtn', cw + cw / 2, y + 0.017, w=0.034, h=0.012, text='TEST', col='white')
    # NAV 1 | WXR | NAV 2
    h = 0.070
    y -= h
    for col, title in ((0, 'NAV 1'), (2, 'NAV 2')):
        _radio(p8, col * cw, y, cw, h, title, ('110.30', '109.90') if col == 0 else ('113.70', '114.10'), nav=True)
    p8.plate(cw + 0.002, y, cw - 0.004, h - 0.002, 'WX RADAR', style='gray')
    for i, (lab, ring) in enumerate((('GAIN', None), ('TILT', None), ('MODE', ['TEST', 'WX', 'WX/T', 'MAP']))):
        p8.add('knob', cw + 0.030 + i * 0.044, y + 0.030, r=0.010, style='pointer' if ring else 'round', label=lab, ring=ring)
    # audio control panels (L, R) and SELCAL centre
    h = 0.108
    y -= h
    for col in (0, 2):
        _acp(p8, col * cw, y, cw, h)
    p8.plate(cw + 0.002, y, cw - 0.004, h - 0.002, 'ADF', style='gray')
    p8.add('lcd', cw + 0.040, y + 0.070, w=0.050, h=0.016, text='0350.0', col='amber')
    p8.add('lcd', cw + cw - 0.040, y + 0.070, w=0.050, h=0.016, text='0415.0', col='amber')
    p8.add('knob', cw + cw / 2, y + 0.040, r=0.012, style='dual')
    p8.add('toggle', cw + 0.030, y + 0.030, label='ANT', pos=('ANT', 'ADF'), small=True)
    p8.add('toggle', cw + cw - 0.030, y + 0.030, label='TONE', pos=('ON', 'OFF'), small=True)
    # ATC transponder (full width lower)
    h = 0.078
    y -= h
    p8.plate(0.002, y, W - 0.004, h - 0.002, 'ATC', style='gray')
    p8.add('lcd', W / 2 - 0.050, y + 0.050, w=0.050, h=0.017, text='2000', col='amber')
    p8.add('lcd', W / 2 + 0.050, y + 0.050, w=0.050, h=0.017, text='7000', col='amber')
    p8.add('knob', W / 2 - 0.105, y + 0.028, r=0.012, style='dual')
    p8.add('knob', W / 2 + 0.105, y + 0.028, r=0.012, style='dual')
    p8.add('knob', 0.045, y + 0.040, r=0.012, style='pointer', label='MODE', ring=['STBY', 'ALT RPTG OFF', 'XPNDR', 'TA ONLY', 'TA/RA'])
    p8.add('pbtn', W / 2, y + 0.022, w=0.030, h=0.012, text='IDENT', col='white')
    p8.add('toggle', W - 0.045, y + 0.040, label='XPNDR', pos=('1', '2'))
    p8.add('annun', W / 2, y + 0.068, w=0.030, h=0.009, text='ATC FAIL', col='amber')
    # stabilizer trim override / aileron + rudder trim at the aft end
    h = y
    y = 0.0
    p8.plate(0.002, y, W - 0.004, h - 0.002, 'TRIM', style='gray')
    p8.add('gauge', W / 2, y + h * 0.55, r=0.030, dial='rudtrim', label=None)
    p8.add('knob', W / 2, y + 0.020, r=0.016, style='rudder', label='RUDDER', ring=['NOSE LEFT', 'NOSE RIGHT'], ring_r=2.1)
    p8.add('toggle', 0.060, y + h * 0.55, label='AILERON', pos=('L WING DN', 'R WING DN'))
    p8.add('toggle', W - 0.060, y + h * 0.55, label='STAB TRIM', pos=('NORM', 'OVRD'), guard='black')
    p8.text(W / 2, y + h - 0.012, 'RUDDER TRIM', 0.0045)
    return p8


def _radio(p, x0, y0, w, h, title, freqs, nav=False):
    p.plate(x0 + 0.002, y0, w - 0.004, h - 0.002, title, style='gray')
    p.add('lcd', x0 + 0.036, y0 + h - 0.028, w=0.054, h=0.016, text=freqs[0], col='amber', label='ACTIVE', label_y=y0 + h - 0.012)
    p.add('lcd', x0 + w - 0.036, y0 + h - 0.028, w=0.054, h=0.016, text=freqs[1], col='amber', label='STANDBY', label_y=y0 + h - 0.012)
    p.add('pbtn', x0 + w / 2, y0 + h - 0.028, w=0.016, h=0.012, text='TFR', col='white')
    p.add('knob', x0 + w - 0.032, y0 + 0.020, r=0.0115, style='dual')
    p.add('pbtn', x0 + 0.030, y0 + 0.018, w=0.024, h=0.011, text='TEST' if not nav else 'TEST', col='white')
    if not nav:
        p.add('annun', x0 + 0.070, y0 + 0.018, w=0.026, h=0.009, text='OFFSIDE\nTUNING', col='white')


def _acp(p, x0, y0, w, h):
    p.plate(x0 + 0.002, y0, w - 0.004, h - 0.002, 'AUDIO', style='gray')
    tx = ('VHF1', 'VHF2', 'VHF3', 'HF1', 'HF2', 'FLT', 'SVC', 'PA')
    for i, t in enumerate(tx[:6]):
        p.add('pbtn', x0 + 0.015 + i * 0.0233, y0 + h - 0.024, w=0.018, h=0.012, text=t, col='white', lit=(t == 'VHF1'))
    for i, t in enumerate(('VHF1', 'VHF2', 'VHF3', 'HF1', 'HF2', 'FLT')):
        p.add('rxknob', x0 + 0.015 + i * 0.0233, y0 + h - 0.056, w=0.010, h=0.022, text=t)
    for i, t in enumerate(('VOR1', 'VOR2', 'MKR', 'ADF1', 'ADF2', 'SPKR')):
        p.add('rxknob', x0 + 0.015 + i * 0.0233, y0 + 0.022, w=0.010, h=0.020, text=t)


# ------------------------------------------------------------------ overhead (P5 forward + aft)
def ov_frames():
    fwd_o = OV_FWD_O
    aft_o = fwd_o + OV_FWD_DIR * OV_FWD_L
    return (fwd_o, OV_FWD_DIR, OV_FWD_L), (aft_o, OV_AFT_DIR, OV_AFT_L)


def _overhead(panels):
    (fo, fd, fl), (ao, ad, al) = ov_frames()
    # the crew looks up at the panel: x to the right, "up" on the panel = aft (towards the seats), normal points down
    fwd = Panel('ovh_fwd', fo, (0, 1, 0), fd, OV_W, fl, density=1.65, bg='gray', depth=0.02)
    aft = Panel('ovh_aft', ao, (0, 1, 0), ad, OV_W, al, density=1.4, bg='gray', depth=0.02)
    panels['ovh_fwd'] = fwd
    panels['ovh_aft'] = aft
    _ovh_forward(fwd)
    _ovh_aft(aft)


class Grid:
    """Row-based helper to fill an overhead sub-panel: items are laid out evenly in rows."""

    def __init__(self, p, x0, y0, w, h, title=None, style='gray'):
        self.p, self.x0, self.y0, self.w, self.h = p, x0, y0, w, h
        p.plate(x0 + 0.002, y0 + 0.002, w - 0.004, h - 0.004, title, style=style)

    def row(self, yf, items, x_from=0.0, x_to=1.0):
        """yf: 0 (forward/bottom edge) .. 1 (aft/top edge); items: list of (kind, kwargs) or None."""
        n = len(items)
        y = self.y0 + yf * self.h
        for i, it in enumerate(items):
            if it is None:
                continue
            kind, kw = it
            xf = x_from + (i + 0.5) / n * (x_to - x_from)
            self.p.add(kind, self.x0 + xf * self.w, y, **kw)


def T(label, pos=('ON', 'OFF'), **kw):
    return ('toggle', dict(label=label, pos=pos, **kw))


def G(label, pos=('ON', 'OFF'), guard='black', **kw):
    return ('toggle', dict(label=label, pos=pos, guard=guard, **kw))


def K(label, ring=None, r=0.0115, style='pointer', **kw):
    return ('knob', dict(label=label, ring=ring, r=r, style=style, **kw))


def A(text, col='amber', lit=False, w=0.034, h=0.013):
    return ('annun', dict(text=text, col=col, lit=lit, w=w, h=h))


def B(text, col='white', w=0.026, h=0.014, lit=False):
    return ('pbtn', dict(text=text, col=col, w=w, h=h, lit=lit))


def D(dial, r=0.022, label=None):
    return ('gauge', dict(dial=dial, r=r, label=label))


def L(text, w=0.05, col='green', h=0.014):
    return ('lcd', dict(text=text, w=w, h=h, col=col))


def _ovh_forward(p):
    W = OV_W
    cw = [0.205, 0.195, 0.195, 0.205]
    xs = [0.0, 0.205, 0.400, 0.595]
    # forward-most strip (lights / engine start), y from 0
    hF = 0.150
    g = Grid(p, 0.0, 0.0, 0.265, hF, 'LANDING')
    g.row(0.72, [T('RETRACT\nL', ('EXTEND', 'RETRACT')), T('RETRACT\nR', ('EXTEND', 'RETRACT')), T('FIXED\nL'), T('FIXED\nR')])
    g.row(0.28, [T('RUNWAY\nTURNOFF L'), T('RUNWAY\nTURNOFF R'), T('TAXI')])
    g = Grid(p, 0.265, 0.0, 0.070, hF, None)
    g.row(0.65, [K('L WIPER', ['PARK', 'INT', 'LOW', 'HIGH'], r=0.012)])
    g.row(0.25, [T('APU', ('START', 'OFF', 'ON'))])
    g = Grid(p, 0.335, 0.0, 0.200, hF, 'ENGINE START')
    g.row(0.62, [K('1', ['GRD', 'OFF', 'CONT', 'FLT'], r=0.016, style='start'), K('2', ['GRD', 'OFF', 'CONT', 'FLT'], r=0.016, style='start')])
    g.row(0.18, [T('IGNITION', ('IGN L', 'BOTH', 'IGN R'))])
    g = Grid(p, 0.535, 0.0, 0.070, hF, None)
    g.row(0.65, [K('R WIPER', ['PARK', 'INT', 'LOW', 'HIGH'], r=0.012)])
    g = Grid(p, 0.605, 0.0, 0.195, hF, None)
    g.row(0.70, [T('LOGO'), T('POSITION', ('STROBE &\nSTEADY', 'OFF', 'STEADY')), T('ANTI\nCOLLISION')])
    g.row(0.28, [T('WING'), T('WHEEL\nWELL')])
    # ---------------- column 1 (captain side): FUEL, NAV/DISPLAYS, FLT CONTROL (aft)
    y = hF
    x, w = xs[0], cw[0]
    g = Grid(p, x, y, w, 0.300, 'FUEL')
    g.row(0.86, [D('fueltemp', r=0.019), A('ENG VALVE\nCLOSED', 'blue'), A('SPAR VALVE\nCLOSED', 'blue')])
    g.row(0.68, [A('FILTER\nBYPASS'), K('CROSSFEED', None, r=0.013), A('FILTER\nBYPASS')])
    g.row(0.53, [A('VALVE\nOPEN', 'blue', w=0.03)], 0.35, 0.65)
    g.row(0.40, [T('CTR L'), T('CTR R')], 0.2, 0.8)
    g.row(0.29, [A('LOW\nPRESSURE'), A('LOW\nPRESSURE')], 0.2, 0.8)
    g.row(0.15, [T('AFT 1'), T('FWD 1'), T('FWD 2'), T('AFT 2')])
    g.row(0.05, [A('LOW PRESS', w=0.03, h=0.010), A('LOW PRESS', w=0.03, h=0.010), A('LOW PRESS', w=0.03, h=0.010), A('LOW PRESS', w=0.03, h=0.010)])
    y += 0.300
    g = Grid(p, x, y, w, 0.130, 'NAVIGATION / DISPLAYS')
    g.row(0.62, [T('VHF NAV', ('BOTH 1', 'NORMAL', 'BOTH 2')), T('IRS', ('BOTH L', 'NORMAL', 'BOTH R')), T('FMC', ('BOTH L', 'NORMAL', 'BOTH R'))])
    g.row(0.20, [K('SOURCE', ['ALL 1', 'AUTO', 'ALL 2'], r=0.011), T('CONTROL\nPANEL', ('BOTH 1', 'NORMAL', 'BOTH 2'))])
    y += 0.130
    g = Grid(p, x, y, w, p.h - y, 'FLIGHT CONTROL')
    g.row(0.88, [G('A', ('STBY RUD', 'OFF', 'ON')), G('B', ('STBY RUD', 'OFF', 'ON')), A('LOW\nQUANTITY')])
    g.row(0.70, [A('LOW\nPRESSURE'), A('LOW\nPRESSURE'), A('STBY RUD\nON')])
    g.row(0.53, [G('SPOILER A'), G('SPOILER B'), G('ALTERNATE\nFLAPS', ('ARM', 'OFF'), guard='red')])
    g.row(0.36, [A('FEEL DIFF\nPRESS'), A('SPEED TRIM\nFAIL'), T('ALTN FLAPS', ('UP', 'OFF', 'DOWN'))])
    g.row(0.20, [A('MACH TRIM\nFAIL'), A('AUTO SLAT\nFAIL'), A('YAW\nDAMPER')])
    g.row(0.06, [G('YAW DAMPER', ('ON', 'OFF'))], 0.3, 0.7)
    # ---------------- column 2: APU, GENERATORS / BUS, ELECTRICAL meters
    x, w = xs[1], cw[1]
    y = hF
    g = Grid(p, x, y, w, 0.120, 'APU')
    g.row(0.60, [D('egt', r=0.021, label='APU EGT'), A('MAINT', 'blue'), A('LOW OIL\nPRESSURE')])
    g.row(0.18, [A('FAULT'), A('OVER\nSPEED')], 0.3, 1.0)
    y += 0.120
    g = Grid(p, x, y, w, 0.250, 'GENERATORS')
    g.row(0.88, [A('TRANSFER\nBUS OFF'), A('SOURCE\nOFF'), A('TRANSFER\nBUS OFF')])
    g.row(0.72, [G('BUS TRANSFER', ('AUTO', 'OFF'))], 0.25, 0.75)
    g.row(0.55, [T('GEN 1', ('ON', 'OFF')), T('APU GEN', ('ON', 'OFF')), T('APU GEN', ('ON', 'OFF')), T('GEN 2', ('ON', 'OFF'))])
    g.row(0.37, [A('GEN OFF\nBUS', 'blue'), A('APU GEN\nOFF BUS', 'blue'), A('GEN OFF\nBUS', 'blue')])
    g.row(0.20, [T('GRD POWER', ('ON', 'OFF')), A('GRD POWER\nAVAILABLE', 'blue')])
    g.row(0.05, [G('GEN 1 DRIVE', ('DISCON', 'NORM'), guard='red'), G('GEN 2 DRIVE', ('DISCON', 'NORM'), guard='red')], 0.1, 0.9)
    y += 0.250
    g = Grid(p, x, y, w, p.h - y, 'ELECTRICAL')
    g.row(0.88, [L('28', w=0.034), L('115', w=0.034), L('400', w=0.034)])
    g.row(0.72, [K('DC', ['STBY PWR', 'BAT BUS', 'BAT', 'AUX BAT', 'TR1', 'TR2', 'TR3', 'TEST'], r=0.013),
                 K('AC', ['STBY PWR', 'GRD PWR', 'GEN 1', 'APU GEN', 'GEN 2', 'INV', 'TEST'], r=0.013)])
    g.row(0.52, [A('BAT\nDISCHARGE'), A('TR UNIT'), A('ELEC')])
    g.row(0.35, [G('BAT', ('ON', 'OFF'), guard='black'), T('CAB/UTIL'), T('IFE/PASS\nSEAT')])
    g.row(0.18, [A('DRIVE'), A('STANDBY\nPWR OFF'), A('DRIVE')])
    g.row(0.05, [G('STANDBY\nPOWER', ('BAT', 'OFF', 'AUTO'), guard='red')], 0.3, 0.7)
    # ---------------- column 3: HYD, ANTI-ICE, WINDOW/PROBE HEAT, cabin signs
    x, w = xs[2], cw[2]
    y = hF
    g = Grid(p, x, y, w, 0.130, 'HYDRAULIC PUMPS')
    g.row(0.70, [T('ENG 1'), T('ELEC 2'), T('ELEC 1'), T('ENG 2')])
    g.row(0.38, [A('LOW\nPRESS'), A('LOW\nPRESS'), A('LOW\nPRESS'), A('LOW\nPRESS')])
    g.row(0.12, [A('OVERHEAT', w=0.03), None, None, A('OVERHEAT', w=0.03)])
    y += 0.130
    g = Grid(p, x, y, w, 0.130, 'ANTI-ICE')
    g.row(0.74, [A('L VALVE\nOPEN', 'blue'), A('R VALVE\nOPEN', 'blue'), A('COWL\nANTI-ICE'), A('COWL\nANTI-ICE')])
    g.row(0.46, [T('WING ANTI-ICE'), T('ENG 1'), T('ENG 2')])
    g.row(0.14, [A('COWL VALVE\nOPEN', 'blue'), A('COWL VALVE\nOPEN', 'blue')], 0.35, 1.0)
    y += 0.130
    g = Grid(p, x, y, w, 0.200, 'WINDOW HEAT')
    g.row(0.88, [A('OVERHEAT', w=0.03, h=0.011)] * 4)
    g.row(0.76, [A('ON', 'green', lit=True, w=0.03, h=0.011)] * 4)
    g.row(0.58, [T('L SIDE'), T('L FWD'), T('R FWD'), T('R SIDE')])
    g.row(0.38, [T('TEST', ('OVHT', 'PWR TEST')), T('PROBE HEAT\nA'), T('PROBE HEAT\nB')])
    g.row(0.16, [A('CAPT PITOT'), A('L ELEV\nPITOT'), A('L ALPHA\nVANE'), A('TEMP\nPROBE')])
    y += 0.200
    g = Grid(p, x, y, w, p.h - y, None)
    g.row(0.86, [K('CIRCUIT\nBREAKER', None, r=0.010, style='round'), K('PANEL', None, r=0.010, style='round')])
    g.row(0.66, [T('EQUIP COOLING\nSUPPLY', ('NORMAL', 'ALTN')), T('EXHAUST', ('NORMAL', 'ALTN')), A('OFF'), A('OFF')])
    g.row(0.46, [G('EMER EXIT\nLIGHTS', ('OFF', 'ARMED', 'ON'), guard='black'), A('NOT\nARMED')])
    g.row(0.26, [T('NO SMOKING', ('ON', 'AUTO', 'OFF')), T('FASTEN BELTS', ('ON', 'AUTO', 'OFF'))])
    g.row(0.08, [B('ATTEND'), B('GRD CALL'), A('CALL', 'blue', w=0.022)])
    # ---------------- column 4 (F/O side): PRESSURIZATION, BLEED, AIR COND, cabin alt, CVR
    x, w = xs[3], cw[3]
    y = hF
    g = Grid(p, x, y, w, 0.190, 'PRESSURIZATION')
    g.row(0.84, [A('AUTO\nFAIL'), A('OFF\nSCHED DES'), A('ALTN', 'green'), A('MANUAL', 'green')])
    g.row(0.60, [L('37000', w=0.046, col='amber'), D('valve', r=0.017)])
    g.row(0.40, [K('FLT ALT', None, r=0.010, style='round'), T('VALVE', ('CLOSE', 'OPEN'))])
    g.row(0.20, [L('00020', w=0.046, col='amber'), K('MODE', ['AUTO', 'ALTN', 'MAN'], r=0.013)])
    g.row(0.04, [K('LAND ALT', None, r=0.010, style='round')], 0.0, 0.5)
    y += 0.190
    g = Grid(p, x, y, w, 0.250, 'BLEED')
    g.row(0.86, [T('L RECIRC\nFAN', ('OFF', 'AUTO')), D('press', r=0.022, label='DUCT PRESS'), T('R RECIRC\nFAN', ('OFF', 'AUTO'))])
    g.row(0.66, [T('L PACK', ('OFF', 'AUTO', 'HIGH')), K('ISOLATION\nVALVE', ['CLOSE', 'AUTO', 'OPEN'], r=0.012), T('R PACK', ('OFF', 'AUTO', 'HIGH'))])
    g.row(0.46, [A('PACK'), B('TRIP\nRESET', w=0.022), A('PACK')])
    g.row(0.34, [A('WING-BODY\nOVERHEAT'), A('BLEED\nTRIP OFF'), A('WING-BODY\nOVERHEAT')])
    g.row(0.14, [T('1', ('ON', 'OFF')), T('APU BLEED', ('ON', 'OFF')), T('2', ('ON', 'OFF'))])
    y += 0.250
    g = Grid(p, x, y, w, 0.190, 'AIR TEMP')
    g.row(0.84, [D('duct', r=0.020, label='TEMP'), K('SOURCE', ['CONT CAB', 'SUPPLY', 'PASS CAB'], r=0.011)])
    g.row(0.56, [K('CONT CAB', ['C', 'AUTO', 'W', 'OFF'], r=0.012), K('FWD CAB', ['C', 'AUTO', 'W', 'OFF'], r=0.012), K('AFT CAB', ['C', 'AUTO', 'W', 'OFF'], r=0.012)])
    g.row(0.30, [A('ZONE\nTEMP'), A('ZONE\nTEMP'), A('ZONE\nTEMP')])
    g.row(0.10, [T('TRIM AIR', ('ON', 'OFF'))], 0.3, 0.7)
    y += 0.190
    g = Grid(p, x, y, w, p.h - y, None)
    g.row(0.80, [D('cabalt', r=0.030, label='CABIN ALT'), D('climb', r=0.022, label='CABIN CLIMB')])
    g.row(0.38, [B('ALT HORN\nCUTOUT', w=0.028), T('VOICE\nRECORDER', ('AUTO', 'ON'))])
    g.row(0.14, [B('ERASE', w=0.022), B('TEST', w=0.022), A('STATUS', 'green', w=0.022)])


def _ovh_aft(p):
    W = OV_W
    g = Grid(p, 0.0, 0.0, 0.260, p.h, 'IRS')
    g.row(0.86, [L('N37 37.1', w=0.07, col='green'), L('W122 22.5', w=0.07, col='green')])
    g.row(0.66, [K('DSPL SEL', ['TEST', 'TK/GS', 'PPOS', 'WIND', 'HDG/STS'], r=0.012), K('SYS DSPL', ['L', 'R'], r=0.010)])
    g.row(0.42, [('keypad', dict(w=0.09, h=0.06))], 0.1, 0.6)
    g.row(0.18, [K('L', ['OFF', 'ALIGN', 'NAV', 'ATT'], r=0.013), K('R', ['OFF', 'ALIGN', 'NAV', 'ATT'], r=0.013)], 0.1, 1.0)
    g = Grid(p, 0.260, 0.0, 0.180, p.h, 'LE DEVICES')
    g.row(0.70, [('ledev', dict(w=0.15, h=0.09))])
    g.row(0.22, [T('TEST', ('TEST', 'OFF')), A('PSEU', 'amber')])
    g = Grid(p, 0.440, 0.0, 0.180, p.h, 'ENGINE')
    g.row(0.84, [A('REVERSER'), A('REVERSER')])
    g.row(0.66, [A('ENGINE\nCONTROL'), A('ENGINE\nCONTROL')])
    g.row(0.44, [G('EEC 1', ('ON', 'ALTN')), G('EEC 2', ('ON', 'ALTN'))])
    g.row(0.18, [D('oxy', r=0.022, label='CREW OXY'), T('PASS OXY', ('ON', 'NORMAL'))])
    g = Grid(p, 0.620, 0.0, 0.180, p.h, None)
    g.row(0.84, [B('STALL\nWARN TEST', w=0.03), B('STALL\nWARN TEST', w=0.03)])
    g.row(0.62, [B('MACH\nWARN TEST', w=0.03), B('MACH\nWARN TEST', w=0.03)])
    g.row(0.40, [T('SERVICE\nINTERPHONE', ('ON', 'OFF')), A('GPS', 'amber')])
    g.row(0.16, [T('FLIGHT\nRECORDER', ('TEST', 'NORMAL')), A('OFF', 'amber')])


# ------------------------------------------------------------------ side consoles (outboard, below the side windows)
CONSOLE_X0, CONSOLE_X1, CONSOLE_Z = 2.72, 3.86, 3.30
CONSOLE_Y_IN = 0.905


def _side_consoles(panels):
    for side in (-1, 1):
        name = 'console_L' if side < 0 else 'console_R'
        w = 0.24
        L = CONSOLE_X1 - CONSOLE_X0
        if side < 0:
            o = (CONSOLE_X1, -CONSOLE_Y_IN - w, CONSOLE_Z)
            p = Panel(name, o, (0, 1, 0), (-1, 0, 0), w, L, density=1.0, bg='light')
        else:
            o = (CONSOLE_X1, CONSOLE_Y_IN, CONSOLE_Z)
            p = Panel(name, o, (0, 1, 0), (-1, 0, 0), w, L, density=1.0, bg='light')
        panels[name] = p
        inboard = w if side < 0 else 0.0
        # oxygen mask stowage box (aft) + test/reset
        ox = w / 2
        p.plate(ox - 0.075, 0.12, 0.15, 0.20, 'OXYGEN', style='gray')
        p.add('pbtn', ox - 0.035, 0.17, w=0.040, h=0.025, text='RESET/\nTEST', col='white')
        p.add('annun', ox + 0.035, 0.17, w=0.030, h=0.014, text='YELLOW\nFLOW', col='amber')
        p.add('toggle', ox, 0.26, label='EMERGENCY', pos=('TEST', 'NORMAL'))
        p.plate(ox - 0.08, 0.36, 0.16, 0.12, 'MIC SELECTOR', style='gray')
        p.add('toggle', ox, 0.41, label='BOOM/MASK', pos=('BOOM', 'MASK'))
        if side < 0:
            p.add('tiller', w * 0.42, L - 0.20)
            p.text(w * 0.42, L - 0.33, 'NOSE WHEEL STEERING', 0.006, col='white')
        p.plate(ox - 0.08, L - 0.47, 0.16, 0.10, None, style='gray')
        p.add('knob', ox - 0.04, L - 0.42, r=0.010, style='round', label='MAP LIGHT')
        p.add('knob', ox + 0.04, L - 0.42, r=0.010, style='round', label='PANEL')


# ------------------------------------------------------------------ circuit breaker panels (P18 / P6, aft side walls)
def _cb_panels(panels):
    for side in (-1, 1):
        yw = -1.465 if side < 0 else 1.465
        if side < 0:
            cb = Panel('cb_L', (4.62, yw, 3.30), (-1, 0, 0), (0, 0, 1), 0.52, 0.72, density=0.8, bg='gray', lite=False)
        else:
            cb = Panel('cb_R', (4.10, yw, 3.30), (1, 0, 0), (0, 0, 1), 0.52, 0.72, density=0.8, bg='gray', lite=False)
        panels[cb.name] = cb
        for r in range(8):
            cb.plate(0.01, 0.02 + r * 0.087, 0.50, 0.08, ('P18' if side < 0 else 'P6') + '-%d' % (r + 1), style='gray', title_at='top')
            for cc in range(12):
                cb.add('cb', 0.035 + cc * 0.039, 0.045 + r * 0.087)


# ================================================================== atlas packing
# regions of the panel atlas that must keep their old content (the passenger cabin samples them)
RESERVED = [(0, 2900, 2390, 3424), (1300, 2096, 1564, 2624), (2396, 3436, 2880, 3504)]
# solid colour patches used by interior_lite (painted into the panel atlas, sampled from its 1024 copy)
LITE_SW = {k: (2400 + 68 * i, 3440, 2460 + 68 * i, 3500) for i, k in enumerate(('skin', 'shirt', 'navy', 'hair', 'seat', 'lining', 'black'))}
LITE_COL = {'skin': (196, 156, 128), 'shirt': (236, 237, 239), 'navy': (32, 36, 50), 'hair': (40, 33, 28), 'seat': (78, 82, 86),
            'lining': (186, 190, 192), 'black': (26, 27, 29)}
SWATCH = {
    'cab_fabric': (0, 2900, 512, 3412), 'cab_head': (520, 2900, 776, 3156), 'cab_carpet': (800, 2900, 1312, 3412),
    'cab_wall': (1320, 2900, 1576, 3156), 'cab_bin': (1320, 3164, 1576, 3420), 'cab_ceiling': (1584, 2900, 1840, 3156),
    'cab_psu': (1584, 3164, 2096, 3228), 'cab_light': (1584, 3240, 2096, 3270), 'cab_curtain': (1860, 2900, 2116, 3156),
    'cab_reveal': (2130, 2900, 2386, 3156),
    'plastic': (1304, 2100, 1560, 2356), 'grey': (1304, 2364, 1560, 2620),
}


def pack_atlas(panels, size=ATLAS, pad=10):
    """First-fit packing of all panel rectangles around the reserved regions (deterministic). Several
    orderings are tried; the first one that places everything wins."""
    base = []
    for p in panels.values():
        w = int(math.ceil(p.w * 1000 * p.density))
        h = int(math.ceil(p.h * 1000 * p.density))
        base.append((w, h, p))
    manual = ['glareshield', 'mip', 'p8', 'ovh_fwd', 'p9', 'ovh_aft', 'tq_top', 'console_L', 'console_R', 'tq_side_L', 'tq_side_R', 'cb_L', 'cb_R', 'yoke_card']
    orders = [lambda t: (manual.index(t[2].name) if t[2].name in manual else 99, t[2].name),
              lambda t: (-t[0] * t[1], t[2].name), lambda t: (-t[0], t[2].name), lambda t: (-t[1], t[2].name)]
    for key in orders:
        items = sorted(base, key=key)
        placed = [tuple(r) for r in RESERVED]
        ok = True
        for w, h, p in items:
            r = _place(placed, w, h, size, pad)
            if r is None:
                ok = False
                break
            p.rect = r
            placed.append(r)
        if ok:
            return panels
    raise RuntimeError('atlas full')


def _place(placed, w, h, size, pad):
    for y in range(0, size - h + 1, 8):
        x = 0
        while x + w <= size:
            hit = None
            for (a0, b0, a1, b1) in placed:
                if x < a1 + pad and x + w + pad > a0 and y < b1 + pad and y + h + pad > b0:
                    hit = a1 + pad if hit is None else max(hit, a1 + pad)
            if hit is None:
                return (x, y, x + w, y + h)
            x = hit
    return None


# source swatches for the structure (tex/fd_swatch.png, 1024^2): the bake step turns them into fd_body
SWATCH_SRC = {          # 1024^2 image, (x0, y0, x1, y1)
    'lining': (0, 0, 256, 256), 'black': (256, 0, 512, 256), 'grayp': (512, 0, 768, 256), 'floor': (768, 0, 1024, 256),
    'leather': (0, 256, 256, 512), 'mesh': (256, 256, 512, 512), 'sheep': (512, 256, 768, 512), 'dark': (768, 256, 1024, 512),
    'column': (0, 512, 256, 768), 'white': (256, 512, 512, 768), 'visor': (512, 512, 768, 768), 'metal': (768, 512, 1024, 768),
    'door': (0, 768, 512, 1024), 'frame': (512, 768, 768, 1024), 'kick': (768, 768, 1024, 1024),
}


LAYOUT = None


def layout():
    global LAYOUT
    if LAYOUT is None:
        LAYOUT = pack_atlas(build_layout())
    return LAYOUT


if __name__ == '__main__':
    L = layout()
    tot = 0
    for n, p in L.items():
        r = p.rect
        tot += (r[2] - r[0]) * (r[3] - r[1])
        print(f'{n:12s} {p.w:.3f}x{p.h:.3f} m  rect {r}  ppm {p.ppm():.0f}  ctls {len(p.ctls)}')
    print('atlas use', tot / ATLAS ** 2)
