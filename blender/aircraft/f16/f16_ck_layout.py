"""F-16C Block 50/52 cockpit layout (wave 6 rebuild; pure Python, shared by f16_ck_geom.py and f16_ck_art.py).

Drawing frame: s = meters aft of the pitot tip, y = right, z = up (see f16_geom). Design eye (4.26, 0, 2.815).
References (blender/aircraft/f16/ref/): LM/USAF F-16C cockpit photo (front layout), Asian Aerospace 2006 F-16 cockpit
(ICP / MISC / gear panel / engine column / right aux console close-ups), side photos of F-16C Block 30/50 with the
canopy open/closed (glareshield + HUD heights), ACES II egress photos.

Every panel is a plane with a local frame: u = right, v = up along the panel, n = toward the pilot. Items are placed in
panel coordinates (meters, origin = panel center). The texture painter draws each panel's face (labels, dials, key caps,
knob tops, bezel faces) into build/art/<panel>.png at PPM pixels per meter; the geometry projects every face that looks
along +n onto that image, so painted legends always line up with the 3-D keys and knobs.
"""
import math

EYE = (4.26, 0.0, 2.815)

LIP_Z = 2.64            # glareshield rear lip (= ICP top) on the centerline
LIP_S = 3.645
LIP_W = 0.415           # half width where the glareshield meets the side walls
SILL_Z = 2.40
CONSOLE_Z = 2.265       # side console top
FLOOR_Z = 1.905


LIP_FLAT = 0.19         # half width of the flat part over the ICP / RWR / DED


def lip_profile(y, flat=LIP_FLAT, w=LIP_W):
    """0 on the flat top, 1 at the side wall: the 'eyebrow' slope of the glareshield."""
    t = min(max((abs(y) - flat) / (w - flat), 0.0), 1.0)
    return t ** 1.5


def lip_z(y):
    """Height of the glareshield rear lip at lateral position y (flat over the ICP, sloping 'eyebrows' outboard)."""
    return LIP_Z - (LIP_Z - SILL_Z + 0.02) * lip_profile(y)


ICP_PROUD = 0.060       # the ICP (on the HUD's rear face) stands this far aft of the glareshield lip over the RWR/DED


def lip_s(y):
    """Station of the glareshield rear lip: the ICP housing juts aft in the middle, the eyebrows curve aft outboard."""
    a = min(abs(y) / LIP_W, 1.0)
    t = min(max((abs(y) - 0.100) / 0.022, 0.0), 1.0)
    bump = 1.0 - t * t * (3 - 2 * t)
    return LIP_S + ICP_PROUD * bump + 0.13 * a ** 2


def glare_top_z(s):
    """Glareshield top on the centerline, sloping down toward the windscreen."""
    return LIP_Z - 0.30 * max(0.0, LIP_S + ICP_PROUD - s)


# ----------------------------------------------------------------------------------------------------------------------
def _norm(a):
    l = math.sqrt(sum(x * x for x in a))
    return tuple(x / l for x in a)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


class Frame:
    """Panel frame. tilt: lean back from vertical (deg, top away from the pilot); yaw: normal turned toward +y (deg);
    roll: rotation of u/v about n (deg)."""

    def __init__(self, c, tilt=0.0, yaw=0.0, roll=0.0, n=None, u=None):
        self.c = tuple(c)
        if n is None:
            t, p = math.radians(tilt), math.radians(yaw)
            n = (math.cos(t) * math.cos(p), math.cos(t) * math.sin(p), math.sin(t))
        n = _norm(n)
        if u is None:
            u = _norm(_cross((0.0, 0.0, 1.0), n))
        else:
            # make u orthogonal to n
            d = sum(a * b for a, b in zip(u, n))
            u = _norm(tuple(a - d * b for a, b in zip(u, n)))
        v = _cross(n, u)
        if roll:
            r = math.radians(roll)
            u, v = (tuple(math.cos(r) * a + math.sin(r) * b for a, b in zip(u, v)),
                    tuple(-math.sin(r) * a + math.cos(r) * b for a, b in zip(u, v)))
        self.n, self.u, self.v = n, u, v

    def p(self, x, y, d=0.0):
        return tuple(self.c[i] + x * self.u[i] + y * self.v[i] + d * self.n[i] for i in range(3))


# ----------------------------------------------------------------------------------------------------------------------
# item helpers (panel coordinates in meters)
def gauge(u, v, dia, face, label=None, flange='square', knob=None):
    return dict(k='gauge', u=u, v=v, dia=dia, face=face, label=label, flange=flange, knob=knob)


def key(u, v, w, h, text='', sub='', style='gray', depth=0.007, lit=None):
    return dict(k='key', u=u, v=v, w=w, h=h, text=text, sub=sub, style=style, depth=depth, lit=lit)


def light(u, v, w, h, text, color='amber', depth=0.004):
    return dict(k='light', u=u, v=v, w=w, h=h, text=text, color=color, depth=depth)


def knob(u, v, r, label=None, marks=None, style='fluted', h=0.014, ang=0.0):
    return dict(k='knob', u=u, v=v, r=r, label=label, marks=marks or [], style=style, h=h, ang=ang)


def toggle(u, v, label=None, up='', dn='', mid='', pos='up', guard=None, lever='bat', size=1.0):
    return dict(k='toggle', u=u, v=v, label=label, up=up, dn=dn, mid=mid, pos=pos, guard=guard, lever=lever, size=size)


def label(u, v, text, size=0.0045, color='white', anchor='mm', bold=True):
    return dict(k='label', u=u, v=v, text=text, size=size, color=color, anchor=anchor, bold=bold)


def box(u0, v0, u1, v1, title=None, screws=True):
    """Sub-panel outline (painted seam + screws + title)."""
    return dict(k='box', u0=u0, v0=v0, u1=u1, v1=v1, title=title, screws=screws)


def display(name, u, v, bw, bh, sw, sh, kind, depth=0.02, osb=0, soff=(0.0, 0.0)):
    return dict(k='display', name=name, u=u, v=v, bw=bw, bh=bh, sw=sw, sh=sh, kind=kind, depth=depth, osb=osb, soff=soff)


def wheel(u, v, r, w, label=None):
    return dict(k='wheel', u=u, v=v, r=r, w=w, label=label)


def special(name, u, v, **kw):
    d = dict(k='special', name=name, u=u, v=v)
    d.update(kw)
    return d


def paint(name, u, v, **kw):
    """Painted-only detail (e.g. vent grille, placard)."""
    d = dict(k='paint', name=name, u=u, v=v)
    d.update(kw)
    return d


def osb_positions(it):
    """MFD push buttons (OSB) around a display item: list of (u, v, w, h) in panel coords."""
    n = it['osb']
    out = []
    if not n:
        return out
    x, y, bw, bh, sw = it['u'], it['v'], it['bw'], it['bh'], it['sw']
    pitch = sw / (n - 0.2) * 0.98
    for side in range(4):
        for k in range(n):
            t = (k - (n - 1) / 2) * pitch
            if side == 0: out.append((x + t, y + bh / 2 - 0.0095, 0.0125, 0.0095))
            elif side == 1: out.append((x + t, y - bh / 2 + 0.0095, 0.0125, 0.0095))
            elif side == 2: out.append((x - bw / 2 + 0.0095, y + t, 0.0095, 0.0125))
            else: out.append((x + bw / 2 - 0.0095, y + t, 0.0095, 0.0125))
    return out


# ----------------------------------------------------------------------------------------------------------------------
PANELS = {}


def panel(name, frame, w, h, items, ppm=4000, outline=None, depth=0.03, base='panel', lite=True):
    PANELS[name] = dict(name=name, f=frame, w=w, h=h, items=items, ppm=ppm, outline=outline, depth=depth, base=base, lite=lite)


# ---- ICP (integrated control panel) under the HUD -------------------------------------------------------------------
def _icp_items():
    it = []
    # top row: override buttons (round, recessed in a dark strip)
    for i, t in enumerate(('COM\n1', 'COM\n2', 'IFF', 'LIST', 'A-A', 'A-G')):
        it.append(key(-0.0575 + i * 0.023, 0.049, 0.0175, 0.0175, t, style='round', depth=0.006))
    # keypad 4 x 3
    rows = [[('1', 'T-ILS'), ('2', 'ALOW'), ('3', ''), ('RCL', '')],
            [('4', 'STPT'), ('5', 'CRUS'), ('6', 'TIME'), ('ENTR', '')],
            [('7', 'MARK'), ('8', 'FIX'), ('9', 'A-CAL'), ('0', 'M-SEL')]]
    for r, row in enumerate(rows):
        for c, (t, s) in enumerate(row):
            it.append(key(-0.045 + c * 0.0215, 0.0215 - r * 0.0215, 0.0175, 0.0175, t, s,
                          style='keyw' if c < 3 or r == 2 else 'keyb', depth=0.006))
    it.append(key(-0.067, -0.045, 0.012, 0.022, '', style='keyb', depth=0.006))          # WX / FLIR mode
    it.append(label(-0.081, 0.019, 'SYM', 0.0045))
    it.append(label(-0.081, -0.005, 'ICP', 0.0055))
    it.append(label(-0.081, -0.030, 'BRT', 0.0045))
    it.append(label(-0.070, 0.003, 'OFF', 0.0030, anchor='lm'))
    it.append(label(-0.070, -0.057, 'OFF', 0.0030, anchor='lm'))
    it.append(wheel(-0.0845, 0.020, 0.012, 0.010))
    it.append(wheel(-0.0845, -0.036, 0.012, 0.010))
    it.append(wheel(0.0845, 0.030, 0.012, 0.010))
    it.append(wheel(0.0845, -0.024, 0.012, 0.010))
    it.append(label(0.078, 0.047, 'RET', 0.0034, anchor='mm'))
    it.append(label(0.078, 0.040, 'DEPR', 0.0034, anchor='mm'))
    it.append(label(0.078, -0.003, 'CONT', 0.0034))
    it.append(key(0.060, 0.030, 0.011, 0.011, '', style='round', depth=0.005))              # WIDE
    it.append(key(0.060, 0.006, 0.010, 0.022, '', style='keyb', depth=0.006))               # FLIR rocker
    it.append(label(0.0715, 0.012, 'FLIR', 0.0034))
    it.append(toggle(0.062, -0.030, None, 'GAIN', 'AUTO', 'LVL', pos='mid', size=0.8))
    it.append(toggle(0.020, -0.045, None, 'DRIFT C/O', 'WARN RESET', 'NORM', pos='mid', size=0.85))
    it.append(special('dobber', -0.020, -0.047))
    it.append(label(-0.036, -0.047, 'RTN', 0.0036))
    it.append(label(-0.004, -0.047, 'SEQ', 0.0036))
    k = ICP_SCALE
    for x in it:
        for f in ('u', 'v', 'w', 'h', 'r', 'size', 'depth'):
            if f in x and isinstance(x[f], float):
                x[f] = x[f] * k
    return it


ICP_W, ICP_H, ICP_SCALE = 0.215, 0.158, 1.16


# ---- center column: ASI / ALT / ADI / HSI --------------------------------------------------------------------------
def _cstack_items():
    it = [
        gauge(-0.047, 0.108, 0.078, 'asi', 'AIRSPEED/MACH', knob=('ll', 0.007)),
        gauge(0.047, 0.108, 0.078, 'alt', None, knob=('lr', 0.007)),
        gauge(0.0, 0.010, 0.086, 'adi', None, knob=('lr', 0.007)),
        gauge(-0.075, 0.010, 0.030, 'aoa', None, flange='tall'),
        gauge(0.075, 0.010, 0.030, 'vvi', None, flange='tall'),
        gauge(0.0, -0.093, 0.088, 'hsi', None, knob=('both', 0.0075)),
        knob(-0.076, -0.070, 0.0085, 'MODE', ['ILS/TCN', 'TCN', 'NAV', 'ILS/NAV'], style='bar'),
        knob(-0.076, -0.118, 0.008, 'HDG', ['PUSH'], style='fluted'),
        knob(0.074, -0.070, 0.0085, 'FUEL QTY SEL', ['TEST', 'NORM', 'RSVR', 'INT WING', 'EXT WING', 'EXT CTR'], style='bar'),
        toggle(0.074, -0.122, 'EXT FUEL TRANS', 'NORM', 'WING FIRST', pos='up', size=0.8),
        box(-0.098, 0.058, 0.098, 0.160, None),
        box(-0.098, -0.042, 0.098, 0.056, None),
        box(-0.098, -0.160, 0.098, -0.044, None),
    ]
    return it


# ---- MFDs --------------------------------------------------------------------------------------------------------
def _mfd_items(name):
    return [display(name, 0.0, 0.0, 0.132, 0.132, 0.1016, 0.1016, 'mfd', depth=0.022, osb=5)]


# ---- upper left: threat warning prime + RWR azimuth indicator ---------------------------------------------------------
def _ulp_items():
    it = [display('screen_rwr', 0.028, -0.004, 0.076, 0.076, 0.058, 0.058, 'rwr', depth=0.02)]
    tw = [('HANDOFF', 'H', 'green'), ('LAUNCH', '', 'red'), ('MODE', 'PRI', 'green'), ('UNKNOWN', 'U', 'green'),
          ('SYS TEST', '', 'green'), ('T', '', 'green')]
    for i, (t, s, c) in enumerate(tw):
        it.append(key(-0.060 + (i % 2) * 0.0185, 0.022 - (i // 2) * 0.0185, 0.016, 0.016, t, s, style='lit', lit=c, depth=0.006))
    it.append(label(-0.051, 0.036, 'THREAT WARNING PRIME', 0.0028))
    return it


# ---- upper right: DED + standby attitude (SAI) + clock -----------------------------------------------------------------
def _urp_items():
    return [
        display('screen_ded', -0.015, 0.018, 0.122, 0.052, 0.098, 0.036, 'ded', depth=0.018),
        gauge(-0.032, -0.024, 0.036, 'sai', None, knob=('lr', 0.005)),
        gauge(0.020, -0.024, 0.032, 'clock', None, knob=('lr', 0.0045)),
        toggle(0.058, -0.024, 'PFL', 'RESET', '', pos='mid', size=0.7),
    ]


# ---- MISC panel (left of the left MFD) -----------------------------------------------------------------------------
def _misc_items():
    return [
        box(-0.040, -0.098, 0.040, 0.098, None),
        label(0.0, 0.088, 'MISC', 0.0042),
        key(-0.018, 0.070, 0.016, 0.014, 'IFF', 'IDENT', style='lit', lit='white', depth=0.006),
        key(0.018, 0.070, 0.014, 0.014, 'ALT', 'REL', style='round', depth=0.005),
        toggle(0.0, 0.035, 'MASTER ARM', 'MASTER ARM', 'SIMULATE', 'OFF', pos='mid', guard='red'),
        toggle(-0.018, -0.005, 'LASER ARM', 'ARM', 'OFF', pos='dn', size=0.8),
        toggle(0.020, -0.005, 'RF', 'NORM', 'SILENT', 'QUIET', pos='up', size=0.8),
        key(0.0, -0.032, 0.020, 0.012, 'ADV', 'MODE', style='lit', lit='green', depth=0.005),
        toggle(-0.018, -0.070, 'PITCH', 'ALT HOLD', 'ATT HOLD', 'A/P OFF', pos='mid', size=0.85),
        toggle(0.020, -0.070, 'ROLL', 'HDG SEL', 'STRG SEL', 'ATT HOLD', pos='mid', size=0.85),
        label(0.0, -0.093, 'AUTOPILOT', 0.0034),
    ]


# ---- engine instruments column (right of the right MFD) ---------------------------------------------------------------
def _eng_items():
    return [
        gauge(0.0, 0.074, 0.032, 'oil', None),
        gauge(0.0, 0.031, 0.042, 'noz', None),
        gauge(0.0, -0.019, 0.047, 'rpm', None),
        gauge(0.0, -0.071, 0.047, 'ftit', None),
    ]


# ---- landing gear / stores panel (left auxiliary console) --------------------------------------------------------------
def _gear_items():
    return [
        box(-0.078, 0.005, 0.078, 0.095, None),
        box(-0.078, -0.095, 0.078, 0.003, None),
        special('jettison', -0.045, 0.058),
        label(-0.045, 0.089, 'EMER STORES', 0.0033), label(-0.045, 0.083, 'JETTISON', 0.0033),
        paint('gearlamps', 0.012, 0.062),
        toggle(0.060, 0.070, 'HOOK', 'UP', 'DN', pos='up', guard='yb', size=0.85),
        toggle(-0.058, 0.018, 'BRAKES', 'CHAN 1', 'CHAN 2', pos='up', size=0.8),
        toggle(-0.022, 0.018, 'PARKING BRAKE', 'ANTI-SKID', 'OFF', 'PARKING BRAKE', pos='mid', size=0.8),
        special('gearhandle', 0.052, -0.010),
        label(0.052, 0.040, 'LG', 0.0055),
        label(0.070, 0.028, 'UP', 0.0038),
        label(0.070, -0.058, 'DN', 0.0038),
        key(0.020, -0.030, 0.014, 0.014, 'DN LOCK', 'REL', style='yb', depth=0.006),
        key(-0.058, -0.030, 0.012, 0.012, 'HORN', 'SILENCER', style='round', depth=0.005),
        toggle(-0.022, -0.030, 'LIGHTS', 'LANDING', 'TAXI', 'OFF', pos='up', size=0.8),
        toggle(-0.058, -0.072, 'STORES CONFIG', 'CAT I', 'CAT III', pos='up', size=0.8),
        toggle(-0.022, -0.072, 'ALT FLAPS', 'EXTEND', 'NORM', pos='dn', size=0.8),
        label(0.052, -0.088, 'DN LOCK REL', 0.0028),
    ]


# ---- right auxiliary: fuel flow, fuel quantity, hydraulics, oxygen ------------------------------------------------------
def _fuel_items():
    return [
        box(-0.078, 0.010, 0.078, 0.095, None),
        box(-0.078, -0.095, 0.078, 0.008, None),
        special('fuelflow', -0.038, 0.058),
        gauge(0.036, 0.052, 0.060, 'fuel', None),
        gauge(-0.052, -0.022, 0.034, 'hyda', 'HYD PRESS A'),
        gauge(-0.010, -0.022, 0.034, 'hydb', 'HYD PRESS B'),
        gauge(0.040, -0.030, 0.044, 'lox', 'LIQUID OXYGEN'),
        gauge(-0.052, -0.070, 0.032, 'epu', 'EPU FUEL'),
        gauge(-0.012, -0.070, 0.034, 'cabin', 'CABIN PRESS ALT'),
        paint('vent', 0.042, -0.075, w=0.044, h=0.030),
    ]


# ---- eyebrow warning light strips ---------------------------------------------------------------------------------------
def _reyebrow_items():
    it = []
    names = [('ENG FIRE', 'red'), ('HYD/OIL', 'red'), ('FLCS', 'amber'), ('TO/LDG', 'red'),
             ('ENGINE', 'red'), ('CANOPY', 'red'), ('DBU ON', 'amber'), ('OXY LOW', 'red')]
    for i, (t, c) in enumerate(names):
        it.append(light(-0.054 + (i % 4) * 0.036, 0.0095 - (i // 4) * 0.019, 0.032, 0.016, t, c))
    return it


def _leyebrow_items():
    return [light(-0.036, 0.0, 0.050, 0.028, 'MASTER\nCAUTION', 'amber'),
            light(0.022, 0.0, 0.040, 0.024, 'TF FAIL', 'red'),
            light(0.062, 0.0, 0.026, 0.024, '', 'amber')]


# ---- side consoles (horizontal) -------------------------------------------------------------------------------------------
CONS_S0, CONS_S1 = 3.845, 4.74
CONS_YI, CONS_YO = 0.236, 0.404          # inner / outer |y|
CONS_W = CONS_YO - CONS_YI
CONS_L = CONS_S1 - CONS_S0
THROTTLE = dict(s=3.985, y=-0.290, slot=(3.90, 4.10))
STICK = dict(s=3.955, y=0.300)


def _console_frame(side):
    sg = 1 if side == 'R' else -1
    c = ((CONS_S0 + CONS_S1) / 2, sg * (CONS_YI + CONS_YO) / 2, CONSOLE_Z)
    # panel "up" (v) points forward (-s) so the art reads from the seat; u points outboard on the right, inboard on the left
    return Frame(c, n=(0.0, 0.0, 1.0), u=(0.0, 1.0, 0.0), roll=0.0), sg


def _rows(it, y, W, rows):
    for title, h, items in rows:
        it.append(box(-W + 0.004, y - h, W - 0.004, y, title))
        for x in items:
            x = dict(x)
            x['v'] = y + x['v']
            it.append(x)
        y -= h + 0.003
    return y


def _lcons_items():
    """Left console, front (v > 0) to aft. Panel coords: u = right (+y, i.e. inboard), v = forward (-s)."""
    it = []
    L = CONS_L / 2
    W = CONS_W / 2
    front = 0.262
    tu = THROTTLE['y'] + (CONS_YI + CONS_YO) / 2               # throttle lateral position in panel coords
    # throttle quadrant (inboard) + TEST panel (outboard strip) at the front
    it.append(box(tu - 0.045, L - front, W - 0.004, L - 0.004, None, screws=False))
    it.append(special('throttle_slot', tu, L - 0.155))
    it.append(label(tu + 0.030, L - 0.030, 'IDLE', 0.0036))
    it.append(label(tu + 0.030, L - 0.250, 'OFF', 0.0036))
    it.append(label(tu + 0.030, L - 0.110, 'MIL', 0.0036))
    it.append(label(tu + 0.030, L - 0.058, 'AB', 0.0036))
    x0, x1 = -W + 0.004, tu - 0.049
    it.append(box(x0, L - 0.130, x1, L - 0.004, 'TEST'))
    xa, xb = x0 + 0.015, x1 - 0.015
    it += [toggle(xa, L - 0.036, 'FIRE & OHEAT', 'DETECT', '', pos='mid', size=0.65),
           toggle(xb, L - 0.036, 'OXY QTY', 'TEST', '', pos='mid', size=0.65),
           toggle(xa, L - 0.076, 'MAL & IND', 'LTS', '', pos='mid', size=0.65),
           toggle(xb, L - 0.076, 'PROBE HEAT', 'ON', 'TEST', 'OFF', pos='mid', size=0.65),
           toggle(xa, L - 0.114, 'EPU/GEN', 'TEST', '', pos='mid', size=0.65),
           toggle(xb, L - 0.114, 'FLCS PWR', 'TEST', '', pos='mid', size=0.65)]
    it.append(box(x0, L - front, x1, L - 0.134, 'MANUAL TRIM'))
    it += [knob((xa + xb) / 2, L - 0.170, 0.010, 'ROLL TRIM', ['L WING DN', 'R WING DN'], style='fluted'),
           knob((xa + xb) / 2, L - 0.212, 0.011, 'PITCH TRIM', ['NOSE DN', 'NOSE UP'], style='wheelv'),
           knob((xa + xb) / 2, L - 0.246, 0.009, 'YAW TRIM', ['L', 'R'], style='fluted')]
    y = L - front - 0.003
    rows = [
        ('FLT CONTROL', 0.074, [toggle(-0.050, -0.030, 'DIGITAL BACKUP', 'BACKUP', 'OFF', pos='dn', size=0.65, guard='red'),
                                toggle(-0.016, -0.030, 'ALT FLAPS', 'EXTEND', 'NORM', pos='dn', size=0.65),
                                toggle(0.018, -0.030, 'LE FLAPS', 'AUTO', 'LOCK', pos='up', size=0.65),
                                key(0.052, -0.026, 0.014, 0.012, 'FLCS', 'RESET', style='gray', depth=0.005),
                                toggle(-0.033, -0.060, 'TRIM/AP DISC', 'DISC', 'NORM', pos='dn', size=0.6),
                                key(0.020, -0.058, 0.014, 0.011, 'BIT', '', style='lit', lit='white', depth=0.005)]),
        ('FUEL', 0.076, [toggle(-0.045, -0.030, 'MASTER', 'MASTER', 'OFF', pos='up', guard='red', size=0.8),
                         toggle(-0.010, -0.030, 'TANK INERTING', 'TANK INERTING', 'OFF', pos='dn', size=0.65),
                         knob(0.038, -0.034, 0.010, 'ENG FEED', ['OFF', 'NORM', 'AFT', 'FWD'], style='bar'),
                         toggle(-0.028, -0.062, 'AIR REFUEL', 'OPEN', 'CLOSE', pos='dn', size=0.65)]),
        ('EXT LIGHTING', 0.080, [knob(-0.050, -0.028, 0.008, 'ANTI-COLL', ['OFF', '1', '2', '3', '4'], style='bar'),
                                 toggle(-0.016, -0.028, 'POSITION', 'FLASH', 'STEADY', pos='up', size=0.6),
                                 toggle(0.018, -0.028, 'WING/TAIL', 'BRT', 'DIM', 'OFF', pos='up', size=0.6),
                                 toggle(0.052, -0.028, 'FUSELAGE', 'BRT', 'DIM', 'OFF', pos='up', size=0.6),
                                 knob(-0.040, -0.061, 0.008, 'FORM', ['OFF', 'BRT'], style='fluted'),
                                 toggle(0.0, -0.061, 'MASTER', 'NORM', 'OFF', pos='up', size=0.6),
                                 knob(0.040, -0.061, 0.008, 'AERIAL REFUEL', ['OFF', 'BRT'], style='fluted')]),
        ('UHF', 0.100, [special('uhf', 0.0, -0.028),
                        knob(-0.048, -0.074, 0.009, 'FUNCTION', ['OFF', 'MAIN', 'BOTH', 'ADF'], style='bar'),
                        knob(-0.010, -0.074, 0.009, 'MODE', ['MNL', 'PRESET', 'GRD'], style='bar'),
                        knob(0.030, -0.074, 0.008, 'VOL', [], style='fluted'),
                        toggle(0.058, -0.074, 'SQUELCH', 'ON', 'OFF', pos='up', size=0.55)]),
        ('AUDIO 1', 0.070, [knob(-0.052 + i * 0.026, -0.027, 0.0075, t, [], style='fluted') for i, t in
                            enumerate(('COMM 1', 'COMM 2', 'SECURE', 'MSL', 'TF'))] +
                           [toggle(-0.040, -0.055, 'COMM 1 MODE', 'GD', 'OFF', pos='dn', size=0.55),
                            toggle(0.0, -0.055, 'COMM 2 MODE', 'GD', 'OFF', pos='dn', size=0.55),
                            knob(0.040, -0.055, 0.007, 'THREAT', [], style='fluted')]),
        ('EPU', 0.062, [toggle(-0.030, -0.030, 'EPU', 'ON', 'OFF', 'NORM', pos='mid', guard='red', size=0.8),
                        light(0.032, -0.022, 0.030, 0.011, 'RUN', 'green'),
                        light(0.032, -0.040, 0.030, 0.011, 'HYDRAZN', 'amber')]),
        ('ENG & JET START', 0.070, [toggle(-0.030, -0.028, 'JFS', 'START 1', 'START 2', 'OFF', pos='mid', size=0.75),
                                    toggle(0.004, -0.028, 'ENG CONT', 'PRI', 'SEC', pos='up', guard='red', size=0.7),
                                    toggle(0.040, -0.028, 'AB RESET', 'AB RESET', 'ENG DATA', 'NORM', pos='mid', size=0.65),
                                    toggle(-0.010, -0.054, 'MAX POWER', 'ON', 'OFF', pos='dn', size=0.65)]),
    ]
    _rows(it, y, W, rows)
    return it


def _rcons_items():
    """Right console, front (v > 0) to aft. Panel coords: u = right (+y, outboard), v = forward."""
    it = []
    L = CONS_L / 2
    W = CONS_W / 2
    front = 0.232
    su = STICK['y'] - (CONS_YI + CONS_YO) / 2
    it.append(special('stick_base', su, L - (STICK['s'] - CONS_S0)))
    x0, x1 = su + 0.042, W - 0.004
    xa, xb = x0 + 0.014, x1 - 0.014
    it.append(box(x0, L - 0.100, x1, L - 0.004, 'SNSR PWR'))
    it += [toggle(xa, L - 0.034, 'LEFT HDPT', 'ON', 'OFF', pos='up', size=0.6),
           toggle(xb, L - 0.034, 'RIGHT HDPT', 'ON', 'OFF', pos='up', size=0.6),
           toggle(xa, L - 0.074, 'FCR', 'FCR', 'OFF', pos='up', size=0.6),
           toggle(xb, L - 0.074, 'RDR ALT', 'RDR ALT', 'OFF', 'STBY', pos='up', size=0.6)]
    it.append(box(x0, L - front, x1, L - 0.104, 'HUD'))
    it += [toggle(xa, L - 0.134, 'SCALES', 'VV/VAH', 'OFF', 'VAH', pos='up', size=0.55),
           toggle(xb, L - 0.134, 'FPM', 'ATT/FPM', 'OFF', 'FPM', pos='up', size=0.55),
           toggle(xa, L - 0.170, 'DED DATA', 'DED', 'OFF', 'PFL', pos='up', size=0.55),
           toggle(xb, L - 0.170, 'DEPR RET', 'STBY', 'OFF', 'PRI', pos='mid', size=0.55),
           toggle(xa, L - 0.206, 'SPEED', 'CAS', 'GND SPD', 'TAS', pos='up', size=0.55),
           toggle(xb, L - 0.206, 'ALT', 'RADAR', 'BARO', 'AUTO', pos='mid', size=0.55)]
    y = L - front - 0.003
    rows = [
        ('ELEC', 0.064, [toggle(-0.045, -0.030, 'MAIN PWR', 'MAIN PWR', 'OFF', 'BATT', pos='up', size=0.8),
                         key(-0.005, -0.030, 0.016, 0.012, 'CAUTION', 'RESET', style='gray', depth=0.005),
                         light(0.042, -0.022, 0.032, 0.010, 'FLCS PMG', 'amber'),
                         light(0.042, -0.038, 0.032, 0.010, 'MAIN GEN', 'amber')]),
        ('AVIONICS POWER', 0.100, [toggle(-0.052 + i * 0.026, -0.030, t, 'ON', 'OFF', pos='up', size=0.55)
                                   for i, t in enumerate(('MMC', 'ST STA', 'MFD', 'UFC', 'MAP'))] +
                                  [toggle(-0.045, -0.070, 'GPS', 'ON', 'OFF', pos='up', size=0.55),
                                   toggle(-0.015, -0.070, 'DL', 'ON', 'OFF', pos='up', size=0.55),
                                   knob(0.035, -0.070, 0.010, 'INS', ['OFF', 'STOR HDG', 'NORM', 'NAV', 'CAL', 'INFLT ALIGN'], style='bar')]),
        ('INTR LIGHTING', 0.084, [knob(-0.050 + i * 0.033, -0.030, 0.0082, t, ['OFF', 'BRT'], style='fluted')
                                  for i, t in enumerate(('PRIMARY', 'INST PNL', 'DATA ENTRY', 'CONSOLE'))] +
                                 [knob(-0.033, -0.063, 0.0082, 'FLOOD CONSOLES', ['OFF', 'BRT'], style='fluted'),
                                  knob(0.008, -0.063, 0.0082, 'FLOOD INST PNL', ['OFF', 'BRT'], style='fluted'),
                                  toggle(0.048, -0.063, 'MAL & IND LTS', 'BRT', 'DIM', pos='up', size=0.55)]),
        ('AIR COND', 0.070, [knob(-0.036, -0.034, 0.011, 'TEMP', ['MAN', 'AUTO', 'COLD', 'HOT'], style='bar'),
                             knob(0.018, -0.034, 0.010, 'AIR SOURCE', ['OFF', 'NORM', 'DUMP', 'RAM'], style='bar'),
                             toggle(0.058, -0.034, '', 'AUTO', 'MAN', pos='up', size=0.55)]),
        ('OXYGEN REGULATOR', 0.118, [special('oxyreg', 0.0, -0.059)]),
        ('ZEROIZE', 0.048, [toggle(-0.030, -0.024, 'OFP', 'OFP', 'OFF', pos='mid', guard='red', size=0.65),
                            toggle(0.020, -0.024, 'DATA', 'DATA', 'OFF', pos='mid', guard='red', size=0.65)]),
        ('KY-58', 0.060, [knob(-0.040, -0.030, 0.0085, 'MODE', ['P', 'C', 'LD', 'RV'], style='bar'),
                          knob(0.0, -0.030, 0.0085, 'FILL', ['Z 1-5', '1', '2', '3', '4', '5', '6', 'Z ALL'], style='bar'),
                          knob(0.040, -0.030, 0.0085, 'POWER', ['OFF', 'ON', 'TD'], style='bar')]),
    ]
    _rows(it, y, W, rows)
    return it


# ----------------------------------------------------------------------------------------------------------------------
def build_layout():
    PANELS.clear()
    t = math.radians(10)
    panel('icp', Frame((LIP_S + ICP_PROUD + ICP_H / 2 * math.sin(t), 0.0, LIP_Z - ICP_H / 2 * math.cos(t)), tilt=10), ICP_W, ICP_H,
          _icp_items(), ppm=4400, depth=0.075)
    panel('cstack', Frame((3.747, 0.0, 2.320), tilt=16), 0.200, 0.320, _cstack_items(), ppm=4000, depth=0.10)
    panel('lmfd', Frame((3.712, -0.182, 2.462), tilt=16, yaw=14), 0.160, 0.150, _mfd_items('screen_mfd_L'), ppm=4000)
    panel('rmfd', Frame((3.712, 0.182, 2.462), tilt=16, yaw=-14), 0.160, 0.150, _mfd_items('screen_mfd_R'), ppm=4000)
    panel('ulp', Frame((3.676, -0.180, 2.584), tilt=18, yaw=12), 0.156, 0.090, _ulp_items(), ppm=4000,
          outline=[(-0.078, -0.045), (0.078, -0.045), (0.078, 0.045), (-0.050, 0.045), (-0.078, 0.020)])
    panel('urp', Frame((3.676, 0.180, 2.584), tilt=18, yaw=-12), 0.156, 0.090, _urp_items(), ppm=4000,
          outline=[(-0.078, -0.045), (0.078, -0.045), (0.078, 0.020), (0.050, 0.045), (-0.078, 0.045)])
    panel('lmisc', Frame((3.748, -0.300, 2.414), tilt=12, yaw=30), 0.085, 0.190, _misc_items(), ppm=4000)
    panel('reng', Frame((3.748, 0.300, 2.414), tilt=12, yaw=-30), 0.085, 0.190, _eng_items(), ppm=4000)
    panel('lgear', Frame((3.800, -0.300, 2.222), tilt=6, yaw=34), 0.165, 0.195, _gear_items(), ppm=3600)
    panel('rfuel', Frame((3.800, 0.300, 2.222), tilt=6, yaw=-34), 0.165, 0.195, _fuel_items(), ppm=3600)
    # eyebrows hang under the glareshield slopes
    for side, items in (('L', _leyebrow_items()), ('R', _reyebrow_items())):
        sg = 1 if side == 'R' else -1
        ya, yb = 0.262, 0.405
        pa = (lip_s(ya) + 0.006, sg * ya, lip_z(ya) - 0.024)
        pb = (lip_s(yb) + 0.006, sg * yb, lip_z(yb) - 0.024)
        c = tuple((a + b) / 2 for a, b in zip(pa, pb))
        ud = tuple((b - a) for a, b in zip(pa, pb))
        if sg < 0:
            ud = tuple(-x for x in ud)
        L = math.sqrt(sum(x * x for x in ud))
        n = (0.93, -sg * 0.30, 0.20)
        panel(side.lower() + 'eyebrow', Frame(c, n=n, u=ud), L + 0.004, 0.046, items, ppm=4000, depth=0.02)
    # consoles
    fr, _ = _console_frame('L')
    panel('lcons', fr, CONS_W, CONS_L, _lcons_items(), ppm=3000, depth=0.35, base='wall')
    fr, _ = _console_frame('R')
    panel('rcons', fr, CONS_W, CONS_L, _rcons_items(), ppm=3000, depth=0.35, base='wall')
    return PANELS


build_layout()
