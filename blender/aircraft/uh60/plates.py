"""Label plates: flat textured panels whose legends (drawn by cptex.py) line up with the 3D controls placed on them.

    P = Plates()                                   # texture pages + layout JSON
    pl = P.plate(A, 'afcs', o, R, U, N, w, h)      # o = bottom-left corner of the plate face (G frame)
    pl.knob(u, v, label='BRT')                     # 3D knob at (u, v) + its legend / scale in the texture
    ...
    P.write(json_path)  -> run cptex.py -> P.apply_textures(M, texdir)
"""
import json
import math
from mathutils import Vector
import cplib
from lib import prim_box, prim_rbox, merge_parts, transform_verts

PAGE_SIZE = 4096


class Plate:
    def __init__(self, owner, A, name, o, R, U, N, w, h, rec, key):
        self.P, self.A, self.name = owner, A, name
        self.o, self.R, self.U, self.N = Vector(o), Vector(R).normalized(), Vector(U).normalized(), Vector(N).normalized()
        self.w, self.h, self.rec, self.key = w, h, rec, key
        self.items = rec['items']

    # geometry helpers --------------------------------------------------------------------------------------------
    def pt(self, u, v, z=0.0):
        return self.o + self.R * u + self.U * v + self.N * z

    def M(self, u, v, z=0.0):
        return cplib.frame(self.pt(u, v, z), self.R, self.U, self.N)

    def add(self, key, vf, u, v, z=0.0):
        self.A.add(key, cplib.place(vf, self.M(u, v, z)))

    def uv(self, u, v):
        S = float(PAGE_SIZE)
        r = self.rec
        return ((r['x'] + u / self.w * r['wpx']) / S, 1 - (r['y'] + (1 - v / self.h) * r['hpx']) / S)

    def face_quad(self, u0, v0, u1, v1, z):
        """Textured quad at height z showing the plate texture of the rectangle below it (legend on a key cap)."""
        c = [self.pt(u0, v0, z), self.pt(u1, v0, z), self.pt(u1, v1, z), self.pt(u0, v1, z)]
        uvs = [self.uv(u0, v0), self.uv(u1, v0), self.uv(u1, v1), self.uv(u0, v1)]
        self.P.quads.append((self.key, [tuple(p) for p in c], [(0, 1, 2, 3)], uvs, self.A))

    # texture items -------------------------------------------------------------------------------------------------
    def text(self, u, v, t, h=0.0035, f='b', c='#e2e2d8', a='mm', rot=0):
        self.items.append({'k': 'text', 'u': u, 'v': v, 't': t, 'h': h, 'f': f, 'c': c, 'a': a, 'rot': rot})

    def box(self, u0, v0, u1, v1, fill=None, ol=None, r=0.0, w=0.0008):
        self.items.append({'k': 'box', 'u0': u0, 'v0': v0, 'u1': u1, 'v1': v1, 'fill': fill, 'ol': ol, 'r': r, 'w': w})

    def line(self, pts, c='#d8d8d0', w=0.0007):
        self.items.append({'k': 'line', 'p': [list(p) for p in pts], 'c': c, 'w': w})

    def circle(self, u, v, r, fill=None, ol=None, w=0.0007):
        self.items.append({'k': 'circle', 'u': u, 'v': v, 'r': r, 'fill': fill, 'ol': ol, 'w': w})

    def scale(self, u, v, r0, r1, n=11, a0=-135, a1=135, labels=None, major=1, lh=0.0026):
        self.items.append({'k': 'scale', 'u': u, 'v': v, 'r0': r0, 'r1': r1, 'n': n, 'a0': a0, 'a1': a1,
                           'labels': labels or [], 'major': major, 'lh': lh})

    def stripes(self, u0, v0, u1, v1, s=0.006):
        self.items.append({'k': 'stripes', 'u0': u0, 'v0': v0, 'u1': u1, 'v1': v1, 's': s})

    # controls (geometry + legend) ------------------------------------------------------------------------------
    def knob(self, u, v, label=None, r=0.008, h=0.013, style='fluted', scale=True, labels=None, lab_dy=None, key='int_knob'):
        self.add(key, cplib.knob(r, h, style), u, v, 0.0)
        if scale:
            self.scale(u, v, r * 1.45, r * 1.85, n=len(labels) if labels else 9, labels=labels, a0=-120, a1=120)
        if label:
            dy = lab_dy if lab_dy is not None else -(r * 2.0 + 0.0045)
            if labels:
                dy = lab_dy if lab_dy is not None else -(r * 2.2 + 0.004)
            self.text(u, v + dy, label, 0.0028)

    def selector(self, u, v, label=None, labels=None, w=0.028, key='int_knob'):
        self.add(key, cplib.knob_bar(w, 0.016, 0.008), u, v, 0.0)
        n = len(labels) if labels else 5
        self.scale(u, v, w * 0.55, w * 0.68, n=n, labels=labels, a0=-90, a1=90, lh=0.0024)
        if label:
            self.text(u, v - w * 0.62 - 0.004, label, 0.0028)

    def toggle(self, u, v, label=None, up=True, pos=('ON', 'OFF'), key='int_switch', guard=False):
        self.add(key, cplib.toggle(up), u, v, 0.0)
        if pos:
            if pos[0]:
                self.text(u, v + 0.0105, pos[0], 0.0022)
            if len(pos) > 1 and pos[1]:
                self.text(u, v - 0.0105, pos[1], 0.0022)
        if label:
            self.text(u, v + (0.0165 if pos else 0.013), label, 0.0026)
        if guard:
            self.add('int_red', cplib.guard(0.024, 0.030, 0.02), u, v, 0.0)

    def button(self, u, v, w=0.016, h=0.012, label=None, key='int_button', legend=None, lc='#c8c8b8'):
        self.add(key, cplib.pushbutton(w, h, 0.006), u, v, 0.0)
        if legend is not None:
            # legend printed on the key cap: drawn in the plate texture under the key, shown by a quad on the cap
            self.items.append({'k': 'legend', 'u': u, 'v': v, 'w': w, 'h': h, 't': legend, 'c': lc, 'bg': '#2a2b2d', 'th': h * 0.3})
            self.face_quad(u - w / 2 + 0.0012, v - h / 2 + 0.0012, u + w / 2 - 0.0012, v + h / 2 - 0.0012, 0.00615)
        if label:
            self.text(u, v - h / 2 - 0.0035, label, 0.0024)

    def annunciator(self, u, v, t, w=0.024, h=0.017, c='#b8b08a', key='int_lens'):
        self.add(key, cplib.lamp_capsule(w, h, 0.004), u, v, 0.0)
        self.items.append({'k': 'legend', 'u': u, 'v': v, 'w': w, 'h': h, 't': t, 'c': c, 'th': h * 0.25})
        self.face_quad(u - w / 2 + 0.001, v - h / 2 + 0.001, u + w / 2 - 0.001, v + h / 2 - 0.001, 0.00415)

    def cb(self, u, v, amps='5', label=None):
        self.add('int_cb', cplib.circuit_breaker(), u, v, 0.0)
        self.text(u, v - 0.0085, amps, 0.0018)
        if label:
            self.text(u, v + 0.0095, label, 0.0018)

    def screws(self, inset=0.006):
        for (u, v) in ((inset, inset), (self.w - inset, inset), (inset, self.h - inset), (self.w - inset, self.h - inset)):
            self.add('int_metal', cplib.dzus(0.0032), u, v, 0.0)


class Plates:
    def __init__(self, page='lbl', ppm=2400.0, pad=6):
        self.page, self.ppm, self.pad = page, ppm, pad
        self.pages = {}
        self.plates = []
        self.cursor = {}
        self.quads = []          # (key, verts, faces, uvs)

    def _alloc(self, page, wpx, hpx):
        if page not in self.pages:
            self.pages[page] = {'w': PAGE_SIZE, 'h': PAGE_SIZE}
            self.cursor[page] = [self.pad, self.pad, 0]
        x, y, rowh = self.cursor[page]
        if x + wpx + self.pad > PAGE_SIZE:
            x, y, rowh = self.pad, y + rowh + self.pad, 0
        if y + hpx + self.pad > PAGE_SIZE:
            raise RuntimeError(f'label page {page} full')
        self.cursor[page] = [x + wpx + self.pad, y, max(rowh, hpx)]
        return x, y

    def plate(self, A, name, o, R, U, N, w, h, bg='#1e1f21', thick=0.004, page=None, ppm=None, key='int_labels',
              body_key='int_panelpaint', screws=True, border=True, edgewear=10.0, mottle=1.6, hole=None):
        """Create a label plate: textured front quad (material key) on a thin box (body_key)."""
        page = page or self.page
        ppm = ppm or self.ppm
        wpx, hpx = max(8, int(round(w * ppm))), max(8, int(round(h * ppm)))
        x, y = self._alloc(page, wpx, hpx)
        rec = {'name': name, 'page': page, 'x': x, 'y': y, 'wpx': wpx, 'hpx': hpx, 'w': w, 'h': h, 'bg': bg,
               'items': [], 'screws': False, 'border': border, 'edgewear': edgewear, 'mottle': mottle}
        self.plates.append(rec)
        pl = Plate(self, A, name, o, R, U, N, w, h, rec, key)
        # front face (z = thick) with UVs in the page; with a hole (u0, v0, u1, v1) it is a frame of four quads
        if hole is None:
            pl.face_quad(0, 0, w, h, thick)
        else:
            a0, b0, a1, b1 = hole
            for q in ((0, 0, w, b0), (0, b1, w, h), (0, b0, a0, b1), (a1, b0, w, b1)):
                pl.face_quad(q[0], q[1], q[2], q[3], thick)
        if thick > 0:
            # rim only (the front is the textured quad, the back sits on the panel)
            c0, c1 = pl.pt(0, 0, 0), None
            vs = [pl.pt(0, 0, 0), pl.pt(w, 0, 0), pl.pt(w, h, 0), pl.pt(0, h, 0),
                  pl.pt(0, 0, thick), pl.pt(w, 0, thick), pl.pt(w, h, thick), pl.pt(0, h, thick)]
            fs = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
            A.add(body_key, ([tuple(p) for p in vs], fs))
        if screws:
            pl.screws()
        return pl

    def write(self, path):
        json.dump({'pages': self.pages, 'plates': self.plates}, open(path, 'w'))

    def build_quads(self, M, parent, prefix='int'):
        """One mesh per (accumulator group, material key) holding all plate quads with their page UVs."""
        import bpy
        groups = {}
        for key, v, f, uvs, A in self.quads:
            groups.setdefault((A.group, key), []).append((v, f, uvs))
        out = []
        for (grp, key), items in groups.items():
            verts, faces, uvl = [], [], []
            for v, f, uvs in items:
                o = len(verts)
                verts += v
                faces += [tuple(i + o for i in ff) for ff in f]
                uvl += uvs
            me = bpy.data.meshes.new(f'{prefix}_{grp}_{key}')
            me.from_pydata(verts, [], faces)
            me.update()
            uv = me.uv_layers.new(name='UVMap')
            for l in me.loops:
                uv.data[l.index].uv = uvl[l.vertex_index]
            ob = bpy.data.objects.new(f'{prefix}_{grp}_{key}', me)
            bpy.context.scene.collection.objects.link(ob)
            me.materials.append(M[key])
            ob.parent = parent
            ob['atlas'] = grp
            out.append(ob)
        return out
