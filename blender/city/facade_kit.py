"""Facade/roof modelling kit for the SF city atlas (imported by facade_atlas.py inside Blender).

Every atlas cell is a small, periodic piece of real geometry (walls with window holes, reveals, frames, sills, bay
windows, cornices, storefronts, roof gravel/shingles/tiles ...) built from code and rendered orthographically by Cycles.
Facades lie in the XZ plane (x right, z up, wall surface at y = 0, outward normal -Y, protrusions go to -y). Roofs lie
in the XY plane looking down -Z. Each cell is W x H meters; geometry is instanced at the 3x3 neighbouring offsets so
occlusion is continuous across the tile border, and all noise is torus-mapped (4D) so textures tile seamlessly.

Every material carries four shader branches that facade_atlas.py switches between for the render passes:
  'beauty'  diffuse albedo lit by a uniform white sky (-> albedo with baked occlusion)
  'data'    emission (tintMask, roughness, metalness)
  'win'     emission (window light mask: 0 = no window, 0.2..1 = random lighting threshold per window)
  'normal'  emission tangent-space normal (x = right, y = up/along-slope, z = out of the surface)
"""
import math
import random
import bpy
import bmesh

TAU = math.pi * 2

# ----------------------------------------------------------------------------------------------------------- scene state
class Cell:
    """Current cell context: size, mode and the object/material registries."""
    W = 8.0
    H = 8.0
    mode = 'facade'   # or 'roof'
    mats = []


def new_cell(W, H, mode='facade'):
    Cell.W, Cell.H, Cell.mode = float(W), float(H), mode
    Cell.mats = []


# ------------------------------------------------------------------------------------------------------ node utilities
def _n(nt, kind, loc=(0, 0), **props):
    node = nt.nodes.new(kind)
    node.location = loc
    for k, v in props.items():
        setattr(node, k, v)
    return node


def _link(nt, a, b):
    nt.links.new(a, b)


def _val(nt, v):
    node = _n(nt, 'ShaderNodeValue')
    node.outputs[0].default_value = v
    return node.outputs[0]


def _math(nt, op, a, b=None, c=None, clamp=False):
    node = _n(nt, 'ShaderNodeMath', operation=op, use_clamp=clamp)
    for i, x in enumerate((a, b, c)):
        if x is None:
            continue
        if isinstance(x, (int, float)):
            node.inputs[i].default_value = x
        else:
            _link(nt, x, node.inputs[i])
    return node.outputs[0]


def _mix(nt, fac, a, b):
    """RGB mix (fac socket or float, colors as tuples or sockets)."""
    node = _n(nt, 'ShaderNodeMix', data_type='RGBA', blend_type='MIX')
    ins = [s for s in node.inputs if s.type in ('RGBA',)]
    fac_in = node.inputs['Factor'] if 'Factor' in node.inputs else node.inputs[0]
    if isinstance(fac, (int, float)):
        fac_in.default_value = fac
    else:
        _link(nt, fac, fac_in)
    for sock, x in zip(ins[:2], (a, b)):
        if isinstance(x, tuple):
            sock.default_value = (*x[:3], 1.0)
        else:
            _link(nt, x, sock)
    out = [s for s in node.outputs if s.type == 'RGBA'][0]
    return out


def _mul_color(nt, color, fac):
    node = _n(nt, 'ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
    node.inputs['Factor'].default_value = 1.0
    ins = [s for s in node.inputs if s.type == 'RGBA']
    if isinstance(color, tuple):
        ins[0].default_value = (*color[:3], 1.0)
    else:
        _link(nt, color, ins[0])
    if isinstance(fac, tuple):
        ins[1].default_value = (*fac[:3], 1.0)
    else:
        comb = _n(nt, 'ShaderNodeCombineColor')
        for i in range(3):
            if isinstance(fac, (int, float)):
                comb.inputs[i].default_value = fac
            else:
                _link(nt, fac, comb.inputs[i])
        _link(nt, comb.outputs[0], ins[1])
    return [s for s in node.outputs if s.type == 'RGBA'][0]


def _coords(nt):
    """Object-space coordinates projected on the cell plane: returns (u, v) sockets in meters."""
    tc = _n(nt, 'ShaderNodeTexCoord')
    sep = _n(nt, 'ShaderNodeSeparateXYZ')
    _link(nt, tc.outputs['Object'], sep.inputs[0])
    if Cell.mode == 'facade':
        return sep.outputs['X'], sep.outputs['Z']
    return sep.outputs['X'], sep.outputs['Y']


def pnoise(nt, scale=4.0, detail=4.0, rough=0.55, seed=0.0, stretch=(1.0, 1.0)):
    """Seamlessly tiling (4D torus mapped) noise over the W x H cell. Returns Fac socket (0..1)."""
    u, v = _coords(nt)
    W, H = Cell.W, Cell.H
    # frequency: `scale` features per meter-ish; radius on the torus accordingly
    rx = max(0.2, scale * stretch[0] * W / TAU)
    rz = max(0.2, scale * stretch[1] * H / TAU)
    ax = _math(nt, 'MULTIPLY', u, TAU / W)
    az = _math(nt, 'MULTIPLY', v, TAU / H)
    cx = _math(nt, 'MULTIPLY', _math(nt, 'COSINE', ax), rx)
    sx = _math(nt, 'MULTIPLY', _math(nt, 'SINE', ax), rx)
    cz = _math(nt, 'MULTIPLY', _math(nt, 'COSINE', az), rz)
    sz = _math(nt, 'ADD', _math(nt, 'MULTIPLY', _math(nt, 'SINE', az), rz), seed * 17.31)
    comb = _n(nt, 'ShaderNodeCombineXYZ')
    _link(nt, cx, comb.inputs[0])
    _link(nt, sx, comb.inputs[1])
    _link(nt, cz, comb.inputs[2])
    tex = _n(nt, 'ShaderNodeTexNoise', noise_dimensions='4D')
    _link(nt, comb.outputs[0], tex.inputs['Vector'])
    _link(nt, sz, tex.inputs['W'])
    tex.inputs['Scale'].default_value = 1.0
    tex.inputs['Detail'].default_value = detail
    tex.inputs['Roughness'].default_value = rough
    return tex.outputs['Fac']


def stripes(nt, period, axis='v', sharp=0.12, offset=0.0):
    """Sawtooth 0..1 repeating every `period` meters along u or v (period is snapped to divide the cell)."""
    u, v = _coords(nt)
    size = Cell.H if axis == 'v' else Cell.W
    n = max(1, round(size / period))
    period = size / n
    s = v if axis == 'v' else u
    f = _math(nt, 'FRACT', _math(nt, 'ADD', _math(nt, 'DIVIDE', s, period), offset))
    return f


def band(nt, f, lo, hi):
    """1 inside [lo, hi] of a 0..1 sawtooth, else 0 (hard)."""
    a = _math(nt, 'GREATER_THAN', f, lo)
    b = _math(nt, 'LESS_THAN', f, hi)
    return _math(nt, 'MULTIPLY', a, b)


# ------------------------------------------------------------------------------------------------------------ material
class Mat:
    """A material with beauty/data/win/normal branches. `color` is a socket or tuple (sRGB-ish linear floats)."""

    def __init__(self, name, tint=0.0, rough=0.85, metal=0.0, win=0.0):
        self.m = bpy.data.materials.new(name)
        self.m.use_nodes = True
        self.nt = nt = self.m.node_tree
        nt.nodes.clear()
        self.out = _n(nt, 'ShaderNodeOutputMaterial')
        self.tint, self.rough, self.metal, self.win = tint, rough, metal, win
        self.color = (0.5, 0.5, 0.5)
        self.height = None       # bump height socket (meters-ish scale set by bump_strength)
        self.bump_strength = 0.3
        self.bump_distance = 0.02
        self.rough_socket = None
        Cell.mats.append(self)

    def finish(self):
        nt = self.nt
        # beauty: pure diffuse
        bsdf = _n(nt, 'ShaderNodeBsdfPrincipled')
        if isinstance(self.color, tuple):
            bsdf.inputs['Base Color'].default_value = (*self.color[:3], 1.0)
        else:
            _link(nt, self.color, bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 1.0
        bsdf.inputs['Specular IOR Level'].default_value = 0.0
        normal_socket = None
        if self.height is not None:
            bump = _n(nt, 'ShaderNodeBump')
            bump.inputs['Strength'].default_value = self.bump_strength
            bump.inputs["Distance"].default_value = self.bump_distance * 2.5
            _link(nt, self.height, bump.inputs['Height'])
            _link(nt, bump.outputs['Normal'], bsdf.inputs['Normal'])
            normal_socket = bump.outputs['Normal']
        else:
            geo = _n(nt, 'ShaderNodeNewGeometry')
            normal_socket = geo.outputs['Normal']
        self.beauty = bsdf.outputs[0]
        # data: (tint, rough, metal)
        comb = _n(nt, 'ShaderNodeCombineColor')
        comb.inputs[0].default_value = self.tint
        if self.rough_socket is not None:
            _link(nt, self.rough_socket, comb.inputs[1])
        else:
            comb.inputs[1].default_value = self.rough
        comb.inputs[2].default_value = self.metal
        em = _n(nt, 'ShaderNodeEmission')
        _link(nt, comb.outputs[0], em.inputs['Color'])
        self.data = em.outputs[0]
        # window mask
        em2 = _n(nt, 'ShaderNodeEmission')
        em2.inputs['Color'].default_value = (self.win, self.win, self.win, 1)
        self.winout = em2.outputs[0]
        # tangent-space normal: world normal -> (right, up, out)
        sep = _n(nt, 'ShaderNodeSeparateXYZ')
        _link(nt, normal_socket, sep.inputs[0])
        comb2 = _n(nt, 'ShaderNodeCombineXYZ')
        if Cell.mode == 'facade':
            parts = (sep.outputs['X'], sep.outputs['Z'], _math(nt, 'MULTIPLY', sep.outputs['Y'], -1.0))
        else:
            parts = (sep.outputs['X'], sep.outputs['Y'], sep.outputs['Z'])
        for i, p in enumerate(parts):
            _link(nt, _math(nt, 'MULTIPLY_ADD', p, 0.5, 0.5), comb2.inputs[i])
        em3 = _n(nt, 'ShaderNodeEmission')
        _link(nt, comb2.outputs[0], em3.inputs['Color'])
        self.normalout = em3.outputs[0]
        self.set_mode('beauty')
        return self

    def set_mode(self, mode):
        sock = {'beauty': self.beauty, 'data': self.data, 'win': self.winout, 'normal': self.normalout}[mode]
        for l in list(self.out.inputs['Surface'].links):
            self.nt.links.remove(l)
        self.nt.links.new(sock, self.out.inputs['Surface'])


def set_all_modes(mode):
    for m in Cell.mats:
        m.set_mode(mode)


# ------------------------------------------------------------------------------------------------- material library
def srgb(c):
    """sRGB 0..255 tuple (or hex) -> linear floats."""
    if isinstance(c, str):
        c = tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
    def f(x):
        x = x / 255.0
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
    return tuple(f(x) for x in c[:3])


def m_plain(name, color, rough=0.6, tint=0.0, metal=0.0, noise=0.05, win=0.0):
    m = Mat(name, tint=tint, rough=rough, metal=metal, win=win)
    nt = m.nt
    if noise > 0:
        n = pnoise(nt, scale=6.0, detail=3)
        f = _math(nt, 'MULTIPLY_ADD', n, noise * 2, 1.0 - noise)
        m.color = _mul_color(nt, srgb(color) if not isinstance(color, tuple) or max(color) > 1 else color, f)
    else:
        m.color = srgb(color) if (isinstance(color, str) or max(color) > 1) else color
    return m.finish()


def _lin(color):
    return srgb(color) if (isinstance(color, str) or max(color) > 1) else color


def m_stucco(name, color, tint=1.0, rough=0.92, grain=0.06, dirt=0.10, bump=0.25):
    m = Mat(name, tint=tint, rough=rough)
    nt = m.nt
    fine = pnoise(nt, scale=9.0, detail=6, rough=0.6, seed=1)
    big = pnoise(nt, scale=0.6, detail=3, rough=0.5, seed=2)
    f = _math(nt, 'MULTIPLY_ADD', fine, grain * 2, 1.0 - grain)
    f = _math(nt, 'MULTIPLY', f, _math(nt, 'MULTIPLY_ADD', big, dirt * 2, 1.0 - dirt))
    m.color = _mul_color(nt, _lin(color), f)
    m.height = fine
    m.bump_strength = bump
    return m.finish()


def m_concrete(name, color, tint=0.6, rough=0.9, joints=(3.0, 1.9), joint_dark=0.72, stains=0.16):
    m = Mat(name, tint=tint, rough=rough)
    nt = m.nt
    fine = pnoise(nt, scale=7.0, detail=6, rough=0.65, seed=3)
    big = pnoise(nt, scale=0.9, detail=4, rough=0.55, seed=4, stretch=(0.5, 1.6))
    f = _math(nt, 'MULTIPLY_ADD', fine, 0.12, 0.94)
    f = _math(nt, 'MULTIPLY', f, _math(nt, 'MULTIPLY_ADD', big, stains * 2, 1.0 - stains))
    h = fine
    if joints:
        ju = band(nt, stripes(nt, joints[0], 'u'), 0.004, 0.996)
        jv = band(nt, stripes(nt, joints[1], 'v'), 0.006, 0.994)
        j = _math(nt, 'MULTIPLY', ju, jv)            # 1 = panel, 0 = joint
        f = _math(nt, 'MULTIPLY', f, _math(nt, 'MULTIPLY_ADD', j, 1.0 - joint_dark, joint_dark))
        h = _math(nt, 'ADD', _math(nt, 'MULTIPLY', fine, 0.3), j)
    m.color = _mul_color(nt, _lin(color), f)
    m.height = h
    m.bump_strength = 0.35
    return m.finish()


def m_brick(name, color, mortar=(0.62, 0.60, 0.56), tint=0.35, rough=0.9, brick=(0.225, 0.075), var=0.18):
    m = Mat(name, tint=tint, rough=rough)
    nt = m.nt
    u, v = _coords(nt)
    nb = max(1, round(Cell.W / brick[0]))
    nr = max(2, round(Cell.H / brick[1] / 2) * 2)
    bw, rh = Cell.W / nb, Cell.H / nr
    comb = _n(nt, 'ShaderNodeCombineXYZ')
    _link(nt, u, comb.inputs[0])
    _link(nt, v, comb.inputs[1])
    tex = _n(nt, 'ShaderNodeTexBrick', offset=0.5, offset_frequency=2, squash=1.0, squash_frequency=2)
    _link(nt, comb.outputs[0], tex.inputs['Vector'])
    c = _lin(color)
    tex.inputs['Color1'].default_value = (*c, 1)
    tex.inputs['Color2'].default_value = (*[x * (1 - var) for x in c], 1)
    tex.inputs['Mortar'].default_value = (*_lin(mortar), 1)
    tex.inputs['Scale'].default_value = 1.0
    tex.inputs['Mortar Size'].default_value = 0.010
    tex.inputs['Mortar Smooth'].default_value = 0.2
    tex.inputs['Bias'].default_value = 0.0
    tex.inputs['Brick Width'].default_value = bw
    tex.inputs['Row Height'].default_value = rh
    fine = pnoise(nt, scale=12.0, detail=5, rough=0.6, seed=5)
    big = pnoise(nt, scale=0.7, detail=3, seed=6, stretch=(0.6, 1.5))
    f = _math(nt, 'MULTIPLY_ADD', fine, 0.16, 0.92)
    f = _math(nt, 'MULTIPLY', f, _math(nt, 'MULTIPLY_ADD', big, 0.2, 0.9))
    m.color = _mul_color(nt, tex.outputs['Color'], f)
    m.height = _math(nt, 'ADD', _math(nt, 'MULTIPLY', tex.outputs['Fac'], -1.0), _math(nt, 'MULTIPLY', fine, 0.2))
    m.bump_strength = 0.6
    m.bump_distance = 0.01
    return m.finish()


def m_stone(name, color, tint=0.4, rough=0.8, block=(1.2, 0.6), joint=0.006, var=0.06):
    m = Mat(name, tint=tint, rough=rough)
    nt = m.nt
    u, v = _coords(nt)
    nb = max(1, round(Cell.W / block[0]))
    nr = max(2, round(Cell.H / block[1] / 2) * 2)
    comb = _n(nt, 'ShaderNodeCombineXYZ')
    _link(nt, u, comb.inputs[0])
    _link(nt, v, comb.inputs[1])
    tex = _n(nt, 'ShaderNodeTexBrick', offset=0.5, offset_frequency=2)
    _link(nt, comb.outputs[0], tex.inputs['Vector'])
    c = _lin(color)
    tex.inputs['Color1'].default_value = (*c, 1)
    tex.inputs['Color2'].default_value = (*[x * (1 - var) for x in c], 1)
    tex.inputs['Mortar'].default_value = (*[x * 0.75 for x in c], 1)
    tex.inputs['Scale'].default_value = 1.0
    tex.inputs['Mortar Size'].default_value = joint
    tex.inputs['Brick Width'].default_value = Cell.W / nb
    tex.inputs['Row Height'].default_value = Cell.H / nr
    fine = pnoise(nt, scale=10.0, detail=6, rough=0.62, seed=7)
    f = _math(nt, 'MULTIPLY_ADD', fine, 0.12, 0.94)
    m.color = _mul_color(nt, tex.outputs['Color'], f)
    m.height = _math(nt, 'ADD', _math(nt, 'MULTIPLY', tex.outputs['Fac'], -1.0), _math(nt, 'MULTIPLY', fine, 0.15))
    m.bump_strength = 0.4
    return m.finish()


def m_siding(name, color, board=0.16, tint=1.0, rough=0.7, shadow=0.25):
    """Horizontal wood lap siding (painted): darker shadow line under each board + bevel bump."""
    m = Mat(name, tint=tint, rough=rough)
    nt = m.nt
    f = stripes(nt, board, 'v')                         # 0 at board bottom edge .. 1 at top
    shade = _math(nt, 'POWER', f, 0.35)                 # dark quickly under the lap
    shade = _math(nt, 'MULTIPLY_ADD', shade, shadow, 1.0 - shadow)
    fine = pnoise(nt, scale=6.0, detail=5, seed=8, stretch=(0.25, 3.0))
    shade = _math(nt, 'MULTIPLY', shade, _math(nt, 'MULTIPLY_ADD', fine, 0.08, 0.96))
    m.color = _mul_color(nt, _lin(color), shade)
    m.height = _math(nt, 'MULTIPLY', f, -1.0)
    m.bump_strength = 0.5
    m.bump_distance = 0.01
    return m.finish()


def m_corrugated(name, color, period=0.19, tint=0.8, rough=0.55, metal=0.35, axis='u'):
    m = Mat(name, tint=tint, rough=rough, metal=metal)
    nt = m.nt
    f = stripes(nt, period, axis)
    wave = _math(nt, 'MULTIPLY_ADD', _math(nt, 'SINE', _math(nt, 'MULTIPLY', f, TAU)), 0.5, 0.5)
    stains = pnoise(nt, scale=0.8, detail=4, seed=9, stretch=(0.4, 2.0))
    shade = _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY_ADD', wave, 0.16, 0.86), _math(nt, 'MULTIPLY_ADD', stains, 0.22, 0.86))
    m.color = _mul_color(nt, _lin(color), shade)
    m.height = wave
    m.bump_strength = 0.7
    m.bump_distance = 0.02
    return m.finish()


def m_glass(name, seed, style='interior', tint_color=None, win=None, rough=0.08, metal=0.0):
    """Window glass seen from outside (albedo = interior impression); runtime adds the reflections (low roughness)."""
    rnd = random.Random(seed)
    if win is None:
        win = rnd.uniform(0.25, 1.0)
    m = Mat(name, tint=0.0, rough=rough, metal=metal, win=win)
    nt = m.nt
    uvn = _n(nt, 'ShaderNodeUVMap')
    sep = _n(nt, 'ShaderNodeSeparateXYZ')
    _link(nt, uvn.outputs['UV'], sep.inputs[0])
    y = sep.outputs['Y']
    x = sep.outputs['X']
    base = tint_color or rnd.choice([(0.035, 0.045, 0.055), (0.05, 0.05, 0.05), (0.03, 0.04, 0.06), (0.06, 0.055, 0.05)])
    top = tuple(min(1, b * rnd.uniform(1.6, 2.6)) for b in base)
    col = _mix(nt, _math(nt, 'POWER', y, 1.5), base, top)          # brighter ceiling at the top
    if style == 'interior':
        kind = rnd.random()
        if kind < 0.35:      # blinds pulled down part way (horizontal slats)
            cover = rnd.uniform(0.15, 0.9)
            slat = _math(nt, 'FRACT', _math(nt, 'MULTIPLY', y, 38.0))
            sl = _mix(nt, _math(nt, 'MULTIPLY', slat, 0.35), (0.62, 0.60, 0.55), (0.45, 0.44, 0.41))
            mask = _math(nt, 'GREATER_THAN', y, 1.0 - cover)
            col = _mix(nt, mask, col, sl)
        elif kind < 0.62:    # curtains at the sides / drawn
            cc = rnd.choice([(0.55, 0.50, 0.40), (0.62, 0.60, 0.56), (0.35, 0.18, 0.12), (0.42, 0.44, 0.47), (0.58, 0.52, 0.30)])
            half = rnd.uniform(0.12, 0.5)
            folds = _math(nt, 'MULTIPLY_ADD', _math(nt, 'SINE', _math(nt, 'MULTIPLY', x, 60.0)), 0.12, 0.85)
            cur = _mul_color(nt, cc, folds)
            left = _math(nt, 'LESS_THAN', x, half)
            right = _math(nt, 'GREATER_THAN', x, 1.0 - half * rnd.uniform(0.2, 1.0))
            mask = _math(nt, 'MAXIMUM', left, right)
            col = _mix(nt, mask, col, cur)
        elif kind < 0.72:    # sheer white curtain across
            col = _mix(nt, 0.7, col, (0.55, 0.55, 0.53))
    elif style == 'curtainwall':
        # reflective tinted glass: mostly the tint with faint interior (ceiling band) visible
        n = pnoise(nt, scale=1.5, detail=2, seed=seed)
        col = _mix(nt, _math(nt, 'MULTIPLY', n, 0.4), base, top)
    m.color = col
    return m.finish()


def m_gravel(name, color, tint=0.5, rough=0.95, speck=0.35):
    m = Mat(name, tint=tint, rough=rough)
    nt = m.nt
    fine = pnoise(nt, scale=55.0, detail=2, rough=0.5, seed=11)
    mid = pnoise(nt, scale=4.0, detail=4, seed=12)
    big = pnoise(nt, scale=0.35, detail=3, seed=13)
    f = _math(nt, 'MULTIPLY_ADD', fine, speck, 1 - speck / 2)
    f = _math(nt, 'MULTIPLY', f, _math(nt, 'MULTIPLY_ADD', mid, 0.14, 0.93))
    f = _math(nt, 'MULTIPLY', f, _math(nt, 'MULTIPLY_ADD', big, 0.3, 0.85))
    m.color = _mul_color(nt, _lin(color), f)
    m.height = fine
    m.bump_strength = 0.3
    return m.finish()


# ---------------------------------------------------------------------------------------------------------- geometry
_meshes = []


def _obj(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat.m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def box(x0, x1, y0, y1, z0, z1, mat, name='box', uv=False):
    """Axis aligned box (facade coords: x right, y depth (-y = out), z up)."""
    bm = bmesh.new()
    res = bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x = x0 if v.co.x < 0 else x1
        v.co.y = y0 if v.co.y < 0 else y1
        v.co.z = z0 if v.co.z < 0 else z1
    if uv:
        _box_uv(bm)
    return _obj(name, bm, mat)


def _box_uv(bm):
    lay = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        for l in f.loops:
            c = l.vert.co
            if abs(n.z) > 0.5:
                l[lay].uv = (c.x, c.y)
            elif abs(n.y) > 0.5:
                l[lay].uv = (c.x, c.z)
            else:
                l[lay].uv = (c.y, c.z)


def quad(p0, p1, p2, p3, mat, name='quad', uvs=((0, 0), (1, 0), (1, 1), (0, 1))):
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in (p0, p1, p2, p3)]
    f = bm.faces.new(vs)
    lay = bm.loops.layers.uv.verify()
    for l, uv in zip(f.loops, uvs):
        l[lay].uv = uv
    return _obj(name, bm, mat)


def prism(points, y0, y1, mat, name='prism'):
    """Extrude a closed XZ polygon (list of (x, z)) between depth y0..y1 (y0 < y1; -y is toward the viewer)."""
    bm = bmesh.new()
    front = [bm.verts.new((x, y0, z)) for x, z in points]
    back = [bm.verts.new((x, y1, z)) for x, z in points]
    bm.faces.new(front[::-1])
    bm.faces.new(back)
    n = len(points)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _obj(name, bm, mat)


def wall_with_holes(x0, x1, z0, z1, holes, mat, y=0.0, name='wall'):
    """Planar wall (normal -Y) covering [x0,x1]x[z0,z1] minus rectangular holes [(hx0,hx1,hz0,hz1)]."""
    xs = sorted({x0, x1, *[h[0] for h in holes], *[h[1] for h in holes]})
    zs = sorted({z0, z1, *[h[2] for h in holes], *[h[3] for h in holes]})
    xs = [x for x in xs if x0 <= x <= x1]
    zs = [z for z in zs if z0 <= z <= z1]
    bm = bmesh.new()
    vid = {}
    def V(x, z):
        k = (round(x, 5), round(z, 5))
        if k not in vid:
            vid[k] = bm.verts.new((x, y, z))
        return vid[k]
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            cx, cz = (xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2
            if any(h[0] < cx < h[1] and h[2] < cz < h[3] for h in holes):
                continue
            bm.faces.new((V(xs[i], zs[j]), V(xs[i], zs[j + 1]), V(xs[i + 1], zs[j + 1]), V(xs[i + 1], zs[j])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:           # force normal to -Y
        if f.normal.y > 0:
            f.normal_flip()
    return _obj(name, bm, mat)


def reveal(hx0, hx1, hz0, hz1, depth, mat, y=0.0):
    """The 4 inner faces of a window opening from the wall plane (y) back to y + depth."""
    y1 = y + depth
    quad((hx0, y, hz0), (hx0, y1, hz0), (hx0, y1, hz1), (hx0, y, hz1), mat, 'rev')
    quad((hx1, y, hz1), (hx1, y1, hz1), (hx1, y1, hz0), (hx1, y, hz0), mat, 'rev')
    quad((hx0, y, hz1), (hx0, y1, hz1), (hx1, y1, hz1), (hx1, y, hz1), mat, 'rev')
    quad((hx1, y, hz0), (hx1, y1, hz0), (hx0, y1, hz0), (hx0, y, hz0), mat, 'rev')


def window(hx0, hx1, hz0, hz1, glass, frame, depth=0.14, fw=0.05, mullions=(1, 1), sill=None, y=0.0,
           frame_depth=0.05, transom=None):
    """Glass pane recessed `depth` behind the wall plane, a frame ring and mullion grid."""
    gy = y + depth
    quad((hx0, gy, hz0), (hx1, gy, hz0), (hx1, gy, hz1), (hx0, gy, hz1), glass, 'glass')
    fy0, fy1 = gy - frame_depth, gy - 0.005
    box(hx0, hx1, fy0, fy1, hz0, hz0 + fw, frame, 'frame')
    box(hx0, hx1, fy0, fy1, hz1 - fw, hz1, frame, 'frame')
    box(hx0, hx0 + fw, fy0, fy1, hz0, hz1, frame, 'frame')
    box(hx1 - fw, hx1, fy0, fy1, hz0, hz1, frame, 'frame')
    nx, nz = mullions
    for i in range(1, nx):
        x = hx0 + (hx1 - hx0) * i / nx
        box(x - fw * 0.6, x + fw * 0.6, fy0, fy1, hz0, hz1, frame, 'mull')
    for j in range(1, nz):
        z = hz0 + (hz1 - hz0) * j / nz
        box(hx0, hx1, fy0, fy1, z - fw * 0.6, z + fw * 0.6, frame, 'mull')
    if transom is not None:
        z = hz0 + (hz1 - hz0) * transom
        box(hx0, hx1, fy0, fy1, z - fw * 0.7, z + fw * 0.7, frame, 'transom')
    if sill is not None:
        box(hx0 - 0.06, hx1 + 0.06, y - 0.07, gy - frame_depth, hz0 - 0.07, hz0, sill, 'sill')


def punched(hx0, hx1, hz0, hz1, wallmat, glass, frame, depth=0.16, **kw):
    reveal(hx0, hx1, hz0, hz1, depth, wallmat)
    window(hx0, hx1, hz0, hz1, glass, frame, depth=depth, **kw)


def periodic(builder):
    """Run builder(ox, oz) for the 3x3 neighbour offsets of the cell."""
    W, H = Cell.W, Cell.H
    for ox in (-W, 0.0, W):
        for oz in (-H, 0.0, H):
            builder(ox, oz)


def join_all():
    """Join everything into one object (faster rendering)."""
    obs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if len(obs) < 2:
        return
    ctx = bpy.context.copy()
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.join()
