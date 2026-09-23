"""737NG flight deck layout, shared by the panel painter (textures_fd.py) and the geometry builder (interior.py).

Every panel is a flat plate with a frame in the ground frame (X aft, Y right, Z up): origin = lower-left corner
as seen by the crew, xaxis/yaxis unit vectors in the plate, size w x h (m) and a pixel rectangle in the interior
atlas (ATLAS x ATLAS px). Controls are placed in panel coordinates (m from the lower-left corner); the builder turns
them into geometry whose visible faces are UV-mapped onto the same atlas pixels the painter draws on, so labels,
legends and key captions line up with the 3D parts.
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
    def __init__(self, name, origin, xaxis, yaxis, w, h, rect, bg=(88, 92, 98), depth=0.03, shape=None):
        self.name = name
        self.o = np.asarray(origin, float)
        self.x = _n(xaxis)
        self.y = _n(yaxis)
        self.n = _n(np.cross(self.x, self.y))      # towards the crew
        self.w, self.h = w, h
        self.rect = rect                            # px (x0, y0, x1, y1), y0 = top row
        self.bg = bg
        self.depth = depth
        self.shape = shape                          # optional polygon in panel coords (m)
        self.ctls = []
        self.boxes = []                             # (x, y, w, h, title) sub-panel outlines
        self.texts = []                             # (x, y, text, size_m, colour, anchor)

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

    def box(self, x, y, w, h, title=None):
        self.boxes.append((x, y, w, h, title))

    def text(self, x, y, s, size=0.011, col=(235, 235, 235), anchor='mm'):
        self.texts.append((x, y, s, size, col, anchor))


# ------------------------------------------------------------------ geometry anchors (ground frame)
EYE_CAPT = (3.13, -0.53, 3.86)
EYE_FO = (3.13, 0.53, 3.86)
MIP_TILT = math.atan2(0.105, 0.66)          # top leans forward
MIP_Y = _n((-0.105, 0.0, 0.66))             # up along the panel
MIP_O = (2.44, -0.92, 2.80)


def build_layout():
    panels = {}
    # ============================================================ MAIN INSTRUMENT PANEL
    mip = Panel('mip', MIP_O, (0, 1, 0), MIP_Y, 1.84, 0.68, (0, 0, 2760, 1020),
                shape=[(0.0, 0.0), (1.84, 0.0), (1.84, 0.50), (1.77, 0.68), (0.07, 0.68), (0.0, 0.50)])
    panels['mip'] = mip
    DU = 0.200
    for name, yy, zz in (('screen_pfd_capt', -0.655, 3.22), ('screen_nd_capt', -0.395, 3.22),
                         ('screen_eicas_upper', 0.0, 3.265), ('screen_eicas_lower', 0.0, 3.005),
                         ('screen_nd_fo', 0.395, 3.22), ('screen_pfd_fo', 0.655, 3.22)):
        x = yy + 0.92
        y = (zz - 2.80) / math.cos(MIP_TILT)
        mip.add('du', x, y, w=DU, h=DU, name=name)
    # standby instrument (ISFD), autobrake, gear
    mip.add('isfd', 0.92 - 0.205, 0.475, w=0.085, h=0.085)
    mip.add('knob', 0.92 - 0.205, 0.30, r=0.018, label='AUTO BRAKE', ring='OFF  1  2  3  MAX  RTO')
    mip.add('toggle', 0.92 - 0.24, 0.215, label='N1 SET')
    mip.add('knob', 0.92 - 0.17, 0.215, r=0.012, label='SPD REF')
    mip.add('annun', 0.92 - 0.205, 0.37, w=0.05, h=0.018, text='ANTISKID', col='amber')
    mip.add('gear', 0.92 + 0.215, 0.40, label='LANDING GEAR')
    for i, dx in enumerate((-0.025, 0.0, 0.025)):
        mip.add('annun', 0.92 + 0.215 + dx, 0.585, w=0.022, h=0.018, text=('LEFT', 'NOSE', 'RIGHT')[i], col='green', lit=True)
    mip.add('gauge', 0.92 + 0.215, 0.215, r=0.034, label='FLAPS', dial='flaps')
    mip.add('gauge', 0.92 + 0.30, 0.10, r=0.022, label='BRAKE PRESS', dial='brake')
    for side in (-1, 1):
        cx = 0.92 + side * 0.855
        mip.add('clock', cx, 0.34, r=0.036)
        mip.add('knob', cx, 0.20, r=0.012, label='MAIN PANEL DUs')
        mip.add('knob', cx, 0.12, r=0.012, label='LOWER DU')
        mip.add('button', cx - side * 0.0, 0.47, w=0.045, h=0.025, text='FMC', col='amber')
        mip.add('toggle', cx, 0.56, label='SPEED REF')
        # DU brightness knobs under PFD/ND
        for du_y in (0.655, 0.395):
            mip.add('knob', 0.92 + side * du_y, 0.235, r=0.010, label='BRT')
        mip.add('knob', 0.92 + side * 0.53, 0.11, r=0.013, label='NAV/DISPLAY')
        mip.add('toggle', 0.92 + side * 0.40, 0.11, label='VHF NAV')
        mip.add('toggle', 0.92 + side * 0.66, 0.11, label='IRS')
    mip.add('knob', 0.92 + 0.10, 0.08, r=0.010, label='UPPER DU')
    mip.add('knob', 0.92 - 0.10, 0.08, r=0.010, label='LOWER DU')
    mip.add('button', 0.92 + 0.155, 0.08, w=0.03, h=0.02, text='STAB OUT', col='amber')
    # ============================================================ GLARESHIELD (aft face: MCP, EFIS, warnings)
    gs = Panel('glareshield', (2.525, -0.98, 3.43), (0, 1, 0), (0, 0, 1), 1.96, 0.13, (0, 1040, 2744, 1222))
    panels['glareshield'] = gs
    mcp_x0, mcp_x1 = 0.98 - 0.36, 0.98 + 0.36
    gs.box(mcp_x0, 0.004, mcp_x1 - mcp_x0, 0.122, None)
    mcp = [('COURSE', 0.035, '087'), ('IAS/MACH', 0.145, '250'), ('HEADING', 0.300, '287'),
           ('ALTITUDE', 0.435, '10000'), ('VERT SPEED', 0.535, '+1500'), ('COURSE', 0.690, '087')]
    for lab, xo, val in mcp:
        x = mcp_x0 + xo
        gs.add('lcd', x, 0.098, w=0.052 if len(val) < 4 else 0.070, h=0.020, text=val, label=lab)
        gs.add('knob', x, 0.045, r=0.014, label=None)
    for i, lab in enumerate(('N1', 'SPEED', 'VNAV', 'LVL CHG', 'HDG SEL', 'LNAV', 'VOR LOC', 'APP', 'ALT HLD', 'V/S')):
        x = mcp_x0 + 0.07 + i * 0.058
        if lab in ('HDG SEL',):
            x += 0.0
        gs.add('button', x, 0.018, w=0.030, h=0.016, text=lab, col='white', lit=(lab in ('LNAV', 'VNAV')))
    for i, lab in enumerate(('CMD A', 'CMD B', 'CWS A', 'CWS B')):
        gs.add('button', mcp_x0 + 0.602 + (i % 2) * 0.031, 0.072 - (i // 2) * 0.026, w=0.026, h=0.018, text=lab, col='white')
    gs.add('toggle', mcp_x0 + 0.03, 0.075, label='F/D')
    gs.add('toggle', mcp_x1 - 0.03, 0.075, label='F/D')
    gs.add('toggle', mcp_x0 + 0.09, 0.075, label='A/T ARM')
    for side in (-1, 1):
        ex = 0.98 + side * 0.52
        gs.box(ex - 0.14, 0.004, 0.28, 0.122, None)
        gs.add('knob', ex - side * 0.095, 0.07, r=0.017, label='MINS', ring='RADIO  BARO')
        gs.add('knob', ex + side * 0.095, 0.07, r=0.017, label='BARO', ring='IN  HPA')
        gs.add('knob', ex - side * 0.01, 0.075, r=0.016, label='MODE', ring='APP VOR MAP PLN')
        gs.add('knob', ex + side * 0.035, 0.075, r=0.013, label='RANGE', ring='5 10 20 40 80 160')
        for i, lab in enumerate(('WXR', 'STA', 'WPT', 'ARPT', 'DATA', 'POS', 'TERR')):
            gs.add('button', ex - 0.105 + i * 0.035, 0.022, w=0.024, h=0.014, text=lab, col='white')
        wx = 0.98 + side * 0.845
        gs.add('button', wx - side * 0.03, 0.08, w=0.05, h=0.035, text='FIRE\nWARN', col='red')
        gs.add('button', wx + side * 0.03, 0.08, w=0.05, h=0.035, text='MASTER\nCAUTION', col='amber')
        for i, lab in enumerate(('FLT CONT', 'IRS', 'FUEL', 'ELEC', 'APU', 'OVHT/DET')):
            gs.add('annun', wx - 0.025 + (i % 2) * 0.05, 0.035 - (i // 2) * 0.0 - 0.0, w=0.045, h=0.013,
                   text=lab, col='amber') if i < 2 else None
    # ============================================================ PEDESTAL: forward electronic panel (CDUs)
    cdu_o = np.array((2.745, -0.225, 2.770))
    cdu_y = _n((-0.30, 0, 0.11))
    cdu = Panel('cdu', cdu_o, (0, 1, 0), cdu_y, 0.45, 0.32, (0, 1240, 630, 1688))
    panels['cdu'] = cdu
    for side, cx in ((-1, 0.117), (1, 0.333)):
        name = 'screen_cdu_capt' if side < 0 else 'screen_cdu_fo'
        cdu.add('cdu', cx, 0.0, name=name)
    # ============================================================ throttle quadrant (top plate + levers)
    tq = Panel('tq_top', (3.33, -0.20, 2.955), (0, 1, 0), (-1, 0, 0), 0.40, 0.56, (640, 1240, 1040, 1800))
    panels['tq_top'] = tq
    # ============================================================ aft electronic panel
    aft = Panel('aft', (3.98, -0.20, 2.905), (0, 1, 0), _n((-1, 0, 0.06)), 0.40, 0.64, (1600, 1240, 2080, 2008))
    panels['aft'] = aft
    rows = [('VHF COMM 1', 0.58, '118.700', '121.500'), ('VHF COMM 2', 0.505, '121.800', '122.800'),
            ('NAV 1', 0.43, '110.30', '109.90'), ('NAV 2', 0.355, '113.70', '114.10')]
    for title, y, a, b in rows:
        aft.box(0.01, y - 0.035, 0.38, 0.07, title)
        aft.add('lcd', 0.10, y, w=0.075, h=0.022, text=a)
        aft.add('lcd', 0.30, y, w=0.075, h=0.022, text=b, col='white')
        aft.add('knob', 0.20, y - 0.005, r=0.016)
        aft.add('button', 0.20, y + 0.024, w=0.03, h=0.012, text='TFR', col='white')
    aft.box(0.01, 0.215, 0.38, 0.10, 'AUDIO CONTROL')
    for i in range(6):
        aft.add('button', 0.04 + i * 0.058, 0.29, w=0.03, h=0.014, text=('VHF1', 'VHF2', 'VHF3', 'HF1', 'FLT', 'SERV')[i], col='white')
        aft.add('knob', 0.04 + i * 0.058, 0.245, r=0.009)
    aft.box(0.01, 0.12, 0.19, 0.09, 'TRANSPONDER')
    aft.add('lcd', 0.105, 0.175, w=0.06, h=0.02, text='7000')
    aft.add('knob', 0.05, 0.14, r=0.012)
    aft.add('knob', 0.16, 0.14, r=0.012)
    aft.box(0.21, 0.12, 0.18, 0.09, 'WXR')
    aft.add('knob', 0.26, 0.16, r=0.011)
    aft.add('knob', 0.34, 0.16, r=0.011)
    aft.box(0.01, 0.01, 0.38, 0.10, 'RUDDER TRIM')
    aft.add('gauge', 0.30, 0.06, r=0.03, dial='trim')
    aft.add('knob', 0.14, 0.055, r=0.02, label='RUDDER')
    # ============================================================ OVERHEAD
    ov_o = np.array((2.96, -0.40, 4.215))
    ov_y = _n((1.07, 0, 0.455))
    ov = Panel('overhead', ov_o, (0, 1, 0), ov_y, 0.80, 1.16, (2780, 0, 3820, 1508))
    panels['overhead'] = ov
    _overhead(ov)
    # ============================================================ side consoles
    for side, rect in ((-1, (2100, 1240, 2324, 2200)), (1, (2340, 1240, 2564, 2200))):
        y0 = -1.12 if side < 0 else 0.84
        sc = Panel(f'console_{"L" if side < 0 else "R"}', (3.95, y0, 3.12), (0, 1, 0), (-1, 0, 0), 0.28, 1.20, rect,
                   bg=(70, 74, 80))
        panels[sc.name] = sc
        sc.box(0.02, 0.62, 0.24, 0.30, 'OXYGEN')
        sc.add('button', 0.14, 0.70, w=0.05, h=0.03, text='TEST', col='white')
        sc.add('knob', 0.08, 0.80, r=0.014)
        sc.box(0.02, 0.30, 0.24, 0.25, None)
        sc.text(0.14, 0.42, 'MIC  INT', 0.012)
        if side < 0:
            sc.add('tiller', 0.10, 1.04)
    # ============================================================ circuit breaker panels (behind the seats, sidewalls)
    for side, rect in ((-1, (2580, 1560, 2980, 2120)), (1, (3000, 1560, 3400, 2120))):
        yw = -1.48 if side < 0 else 1.48
        if side < 0:
            cb = Panel('cb_L', (4.60, yw, 3.25), (-1, 0, 0), (0, 0, 1), 0.50, 0.70, rect, bg=(60, 64, 70))
        else:
            cb = Panel('cb_R', (4.10, yw, 3.25), (1, 0, 0), (0, 0, 1), 0.50, 0.70, rect, bg=(60, 64, 70))
        panels[cb.name] = cb
        for r in range(9):
            cb.box(0.02, 0.04 + r * 0.073, 0.46, 0.062, None)
            for c in range(11):
                cb.add('cb', 0.05 + c * 0.04, 0.062 + r * 0.073)
    return panels


def _overhead(ov):
    W = ov.w
    col_w = W / 4

    def grid(x0, y0, title, rows, box_h):
        ov.box(x0 + 0.004, y0 + 0.004, col_w - 0.008, box_h - 0.008, title)
        for ri, row in enumerate(rows):
            n = len(row)
            yy = y0 + box_h - 0.048 - ri * 0.052
            for ci, item in enumerate(row):
                if item is None:
                    continue
                xx = x0 + (ci + 0.5) * col_w / n
                kind, lab = item
                if kind == 't':
                    ov.add('toggle', xx, yy, label=lab)
                elif kind == 'g':
                    ov.add('guard', xx, yy, label=lab)
                elif kind == 'k':
                    ov.add('knob', xx, yy, r=0.013, label=lab)
                elif kind == 'K':
                    ov.add('knob', xx, yy, r=0.017, label=lab, ring='OFF GRD CONT FLT')
                elif kind == 'a':
                    ov.add('annun', xx, yy, w=0.036, h=0.014, text=lab, col='amber')
                elif kind == 'A':
                    ov.add('annun', xx, yy, w=0.036, h=0.014, text=lab, col='blue')
                elif kind == 'b':
                    ov.add('button', xx, yy, w=0.03, h=0.016, text=lab, col='white')
                elif kind == 'G':
                    ov.add('gauge', xx, yy - 0.01, r=0.026, dial=lab)
                elif kind == 'L':
                    ov.add('lcd', xx, yy, w=0.05, h=0.016, text=lab)
    t, g, k, K, a, A, b, G, L = 't', 'g', 'k', 'K', 'a', 'A', 'b', 'G', 'L'
    # y = 0 is the forward edge (closest to the windshield)
    # row A: lights + engine start (forward-most)
    hA = 0.20
    grid(0 * col_w, 0.0, 'LANDING', [[(t, 'L RETR'), (t, 'R RETR'), (t, 'L FIXED'), (t, 'R FIXED')],
                                     [(t, 'L TURNOFF'), (t, 'R TURNOFF'), (t, 'TAXI')]], hA)
    grid(1 * col_w, 0.0, 'ENGINE START', [[(K, '1'), (K, '2')], [(t, 'IGN')]], hA)
    grid(2 * col_w, 0.0, 'LIGHTS', [[(t, 'LOGO'), (t, 'POSITION'), (t, 'ANTI COLL')], [(t, 'WING'), (t, 'WHEEL WELL')]], hA)
    grid(3 * col_w, 0.0, 'APU', [[(k, 'APU'), (a, 'LOW OIL'), (a, 'FAULT')], [(G, 'egt'), (a, 'OVERSPEED')]], hA)
    # row B
    hB = 0.24
    y = hA
    grid(0 * col_w, y, 'HYDRAULIC PUMPS', [[(t, 'ENG 1'), (t, 'ELEC 2'), (t, 'ELEC 1'), (t, 'ENG 2')],
                                            [(a, 'LOW PRESS'), (a, 'LOW PRESS'), (a, 'LOW PRESS'), (a, 'LOW PRESS')],
                                            [(a, 'OVERHEAT'), None, None, (a, 'OVERHEAT')]], hB)
    grid(1 * col_w, y, 'ANTI-ICE', [[(t, 'WING'), (t, 'ENG 1'), (t, 'ENG 2')],
                                     [(A, 'VALVE OPEN'), (A, 'VALVE OPEN'), (A, 'VALVE OPEN')],
                                     [(a, 'COWL AI'), (a, 'COWL AI')]], hB)
    grid(2 * col_w, y, 'WINDOW HEAT', [[(A, 'ON'), (A, 'ON'), (A, 'ON'), (A, 'ON')],
                                        [(t, 'L SIDE'), (t, 'L FWD'), (t, 'R FWD'), (t, 'R SIDE')],
                                        [(t, 'PROBE A'), (t, 'PROBE B'), (b, 'TEST')]], hB)
    grid(3 * col_w, y, 'AIR COND', [[(k, 'CONT CAB'), (k, 'FWD CAB'), (k, 'AFT CAB')],
                                     [(G, 'duct'), (a, 'ZONE TEMP'), (t, 'TRIM AIR')],
                                     [(t, 'L RECIRC'), (t, 'R RECIRC')]], hB)
    # row C
    hC = 0.26
    y = hA + hB
    grid(0 * col_w, y, 'ELECTRICAL', [[(L, '28'), (L, '115')], [(k, 'DC'), (k, 'AC')],
                                       [(g, 'BAT'), (g, 'CAB/UTIL'), (g, 'IFE')], [(a, 'DRIVE'), (a, 'DRIVE')]], hC)
    grid(1 * col_w, y, 'GENERATORS', [[(a, 'TRANSFER'), (a, 'SOURCE'), (a, 'TRANSFER')],
                                       [(t, 'GEN 1'), (t, 'APU GEN'), (t, 'GEN 2')],
                                       [(A, 'GEN OFF'), (A, 'APU OFF'), (A, 'GEN OFF')], [(g, 'BUS TFR')]], hC)
    grid(2 * col_w, y, 'BLEED', [[(G, 'press'), (k, 'ISOL')], [(t, 'L PACK'), (t, 'R PACK')],
                                  [(t, 'ENG 1'), (t, 'APU'), (t, 'ENG 2')], [(a, 'DUAL BLEED'), (a, 'PACK')]], hC)
    grid(3 * col_w, y, 'PRESSURIZATION', [[(G, 'cabin'), (G, 'rate')], [(L, '37000'), (L, '00020')],
                                           [(k, 'MODE'), (k, 'VALVE')], [(a, 'AUTO FAIL'), (a, 'OFF SCHED')]], hC)
    # row D
    hD = 0.28
    y = hA + hB + hC
    grid(0 * col_w, y, 'FUEL', [[(G, 'fuel'), (k, 'XFEED')], [(t, 'AFT 1'), (t, 'FWD 1'), (t, 'FWD 2'), (t, 'AFT 2')],
                                 [(a, 'LOW PRESS'), (a, 'LOW PRESS'), (a, 'LOW PRESS'), (a, 'LOW PRESS')],
                                 [(t, 'CTR L'), (t, 'CTR R')], [(a, 'FILTER'), (a, 'FILTER')]], hD)
    grid(1 * col_w, y, 'IRS', [[(L, 'N37 37.1'), (L, 'W122 22.5')], [(k, 'L'), (k, 'R')],
                                [(A, 'ALIGN'), (A, 'ON DC'), (A, 'ALIGN')], [(b, 'ENT'), (b, 'CLR')]], hD)
    grid(2 * col_w, y, 'FLIGHT CONTROL', [[(g, 'A'), (g, 'B'), (g, 'SPOILER A'), (g, 'SPOILER B')],
                                           [(a, 'LOW PRESS'), (a, 'LOW PRESS'), (a, 'STBY RUD')],
                                           [(g, 'YAW DAMPER'), (g, 'ALT FLAPS')], [(A, 'YAW DAMPER')]], hD)
    grid(3 * col_w, y, 'CABIN', [[(k, 'NO SMOKING'), (k, 'SEAT BELTS')], [(b, 'ATTEND'), (b, 'GRD CALL')],
                                  [(g, 'EMER EXIT'), (t, 'CVR TEST')], [(G, 'cvr')]], hD)
    # aft strip
    y = hA + hB + hC + hD
    ov.box(0.004, y + 0.004, W - 0.008, ov.h - y - 0.008, None)
    ov.text(W / 2, y + (ov.h - y) / 2, 'P5 FORWARD OVERHEAD', 0.010, (200, 200, 200))


# CDU face, in CDU-local metres (0..0.145 wide, 0..0.30 tall from the aft/bottom edge)
CDU_W, CDU_H = 0.145, 0.30
CDU_SCREEN = (0.0725, 0.232, 0.105, 0.084)      # cx, cy, w, h
CDU_KEYS = []


def cdu_keys():
    """(name, cx, cy, w, h, label) in CDU-local coordinates."""
    if CDU_KEYS:
        return CDU_KEYS
    keys = []
    sx, sy, sw, sh = CDU_SCREEN
    for i in range(6):
        y = sy + sh / 2 - 0.009 - i * 0.0132
        keys.append(('lsk_l%d' % i, 0.0085, y, 0.011, 0.0075, '-'))
        keys.append(('lsk_r%d' % i, CDU_W - 0.0085, y, 0.011, 0.0075, '-'))
    fn = ['INIT\nREF', 'RTE', 'CLB', 'CRZ', 'DES', 'MENU', 'LEGS', 'DEP\nARR', 'HOLD', 'PROG', 'N1\nLIMIT', 'FIX', 'PREV\nPAGE', 'NEXT\nPAGE']
    for i, lab in enumerate(fn[:6]):
        keys.append(('f%d' % i, 0.016 + i * 0.0225, 0.172, 0.019, 0.011, lab))
    for i, lab in enumerate(fn[6:12]):
        keys.append(('g%d' % i, 0.016 + i * 0.0225, 0.157, 0.019, 0.011, lab))
    keys.append(('prev', 0.016, 0.142, 0.019, 0.011, fn[12]))
    keys.append(('next', 0.0385, 0.142, 0.019, 0.011, fn[13]))
    letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for i, ch in enumerate(letters + ' /'):
        r, cc = divmod(i, 5)
        keys.append(('a' + ch, 0.063 + cc * 0.0155, 0.140 - r * 0.0155, 0.012, 0.012, ch if ch != ' ' else 'SP'))
    nums = '123456789.0-'
    for i, ch in enumerate(nums):
        r, cc = divmod(i, 3)
        keys.append(('n' + ch, 0.012 + cc * 0.0155, 0.118 - r * 0.0155, 0.012, 0.012, ch))
    keys.append(('clr', 0.140 - 0.0, 0.035, 0.0, 0.0, ''))
    CDU_KEYS.extend([k for k in keys if k[3] > 0])
    return CDU_KEYS




SWATCH = {
    'cab_fabric': (0, 2900, 512, 3412), 'cab_head': (520, 2900, 776, 3156), 'cab_carpet': (800, 2900, 1312, 3412),
    'cab_wall': (1320, 2900, 1576, 3156), 'cab_bin': (1320, 3164, 1576, 3420), 'cab_ceiling': (1584, 2900, 1840, 3156),
    'cab_psu': (1584, 3164, 2096, 3228), 'cab_light': (1584, 3240, 2096, 3270), 'cab_curtain': (1860, 2900, 2116, 3156),
    'cab_reveal': (2130, 2900, 2386, 3156),
    'carpet': (0, 2100, 512, 2612), 'sheep': (520, 2100, 1032, 2612), 'leather': (1040, 2100, 1296, 2356),
    'trim': (1040, 2364, 1296, 2620), 'plastic': (1304, 2100, 1560, 2356), 'grey': (1304, 2364, 1560, 2620),
    'door': (1600, 2100, 1920, 2860), 'tq_side_l': (1060, 1240, 1580, 1490), 'tq_side_r': (1060, 1500, 1580, 1750),
}

LAYOUT = None


def layout():
    global LAYOUT
    if LAYOUT is None:
        LAYOUT = build_layout()
    return LAYOUT
