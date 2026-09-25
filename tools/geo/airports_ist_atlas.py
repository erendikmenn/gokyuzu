"""İstanbul airports: one small texture atlas for every constant-colour part of the airport buildings.

  .venv/bin/python tools/geo/airports_ist_atlas.py      -> assets/ist/airports/_cache/atlas/ist_atlas.png + ist_atlas_mr.png
  (GOKYUZU_TEX_OUT=<dir>: read / write the atlas there instead, e.g. the public asset pack's scratch tree)

Layout (1024 x 512 px, v = 1 at the top row as in Blender):
  rows 0-1   32 colour swatches of 64 x 64 px (San Francisco's constant materials of blender/airports/materials.py with
             their base colour, roughness and metalness, plus the İstanbul models' own colours). A face that uses a
             swatch has all its UVs at the swatch centre (tools/geo/airports_ist_blender.py remaps the generic
             buildings' constant materials onto it: one draw call instead of seven per airport).
  rows 2-7   lettering strips (1024 x 64 px each, text on the cladding colour of the building it is painted on):
             STRIPS[name] -> the UV rectangle a sign quad maps to.
Lettering: neutral by default (LETTERING). Company lettering (e.g. an operator's name on its maintenance hangars) is a
local opt-in, read when present from the brand directory outside git (blender/common/brand.py):
    ${GOKYUZU_BRAND_DIR:-~/.config/gokyuzu/brand}/airport_lettering.json
    {"mro_dark": "…", "mro_red": "…", "hangar_dark": "…", "cargo_dark": "…"}   (a value may also be
    {"text": "…", "ink": [r, g, b]} to change the letter colour); GOKYUZU_BRAND=off ignores it.
The metallic-roughness map has the swatch's roughness in G and metalness in B (glTF convention), mid values in the
strip rows. Importable without Pillow (Blender's Python reads SWATCH / STRIPS / swatch_uv).
"""
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
sys.path.append(os.path.join(REPO, 'blender', 'common'))
import brand  # noqa: E402

# sources only (never published; the GLBs embed the atlas)
TEX_DIR = os.environ.get('GOKYUZU_TEX_OUT') or os.path.join(REPO, 'assets', 'ist', 'airports', '_cache', 'atlas')
ATLAS_PNG = os.path.join(TEX_DIR, 'ist_atlas.png')
ATLAS_MR_PNG = os.path.join(TEX_DIR, 'ist_atlas_mr.png')
W, H, S = 1024, 512, 64          # atlas size, swatch size
COLS = W // S

# name: (linear base colour, roughness, metallic) -- the first block mirrors blender/airports/materials.py DEFS
SWATCH_DEFS = [
    ('metal_white', (0.72, 0.73, 0.74), 0.35, 0.6),
    ('metal_grey', (0.32, 0.33, 0.34), 0.45, 0.7),
    ('steel_dark', (0.06, 0.065, 0.07), 0.5, 0.6),
    ('concrete', (0.42, 0.41, 0.38), 0.9, 0.0),
    ('concrete_dark', (0.12, 0.12, 0.115), 0.95, 0.0),
    ('paint_white', (0.8, 0.8, 0.78), 0.5, 0.0),
    ('paint_red', (0.55, 0.035, 0.03), 0.45, 0.1),
    ('paint_yellow', (0.8, 0.55, 0.03), 0.5, 0.0),
    ('paint_black', (0.02, 0.02, 0.02), 0.6, 0.0),
    ('rubber', (0.02, 0.02, 0.02), 0.85, 0.0),
    ('paint_navy', (0.02, 0.03, 0.07), 0.6, 0.0),
    ('sign_white', (0.85, 0.85, 0.85), 0.5, 0.0),
    ('flag_red', (0.6, 0.02, 0.02), 0.8, 0.0),
    ('tank_paint', (0.46, 0.47, 0.42), 0.55, 0.2),
    ('mil_tan', (0.42, 0.36, 0.25), 0.85, 0.0),
    ('earth', (0.13, 0.15, 0.07), 1.0, 0.0),
    # İstanbul models
    ('ist_white', (0.74, 0.75, 0.76), 0.4, 0.25),        # white metal cladding (towers, canopy, fins)
    ('ist_soffit', (0.52, 0.53, 0.54), 0.55, 0.2),       # roof undersides, canopy soffits
    ('ist_structure', (0.4, 0.41, 0.42), 0.5, 0.5),      # columns, trusses
    ('ist_concrete', (0.5, 0.49, 0.46), 0.85, 0.0),      # tower shafts, plinths
    ('ist_roof', (0.6, 0.61, 0.62), 0.5, 0.35),          # light grey standing-seam roof (edges, vault steps)
    ('ist_glass', (0.05, 0.08, 0.1), 0.08, 0.5),         # dark glazing (non-emissive: link bridges, shaft windows)
    ('ist_red', (0.55, 0.02, 0.03), 0.45, 0.1),          # signal red
    ('ist_hangar', (0.49, 0.5, 0.52), 0.45, 0.5),        # hangar cladding average (sign background)
]
SWATCH = {n: (k, c, r, m) for k, (n, c, r, m) in enumerate(SWATCH_DEFS)}

# lettering strips: name -> (row index from the top in 64 px rows, text, text colour (sRGB), background swatch).
# 'mro_dark' is painted over the apron doors of the maintenance hangars (tools/geo/airports_build.py mro_signs); the
# neutral texts are the published default, airport_lettering.json (local, see above) replaces them.
LETTERING = {
    'mro_dark': (2, 'BAKIM HANGARI', (38, 40, 46), 'ist_hangar'),
    'mro_red': (3, 'MRO', (200, 16, 30), 'ist_hangar'),
    'hangar_dark': (4, 'HANGAR 1', (38, 40, 46), 'ist_hangar'),
    'cargo_dark': (5, 'KARGO', (38, 40, 46), 'ist_hangar'),
}


def _strips():
    out = dict(LETTERING)
    for name, v in brand.load_json('airport_lettering.json').items():
        if name not in out:
            raise SystemExit(f'airport_lettering.json: unknown strip {name!r} (one of {", ".join(LETTERING)})')
        row, text, ink, bg = out[name]
        if isinstance(v, dict):
            text, ink = v.get('text', text), tuple(v.get('ink', ink))
        else:
            text = v
        out[name] = (row, str(text), ink, bg)
    return out


STRIPS = _strips()


def swatch_uv(name):
    """Blender UV (v up) of a swatch centre."""
    k = SWATCH[name][0]
    col, row = k % COLS, k // COLS
    return ((col + 0.5) * S / W, 1.0 - (row + 0.5) * S / H)


def strip_uv(name, pad=2):
    """Blender UV rectangle (u0, v0, u1, v1) of a lettering strip's ink (the text box, a few texels of margin)."""
    row = STRIPS[name][0]
    y0, y1 = row * S + pad, (row + 1) * S - pad
    x0, x1 = strip_layout(name)[2:4]
    return (max(pad, x0 - 6) / W, 1.0 - y1 / H, min(W - pad, x1 + 6) / W, 1.0 - y0 / H)


def strip_aspect(name):
    """Width / height of the strip_uv rectangle in texels (sign quads keep it: undistorted letters)."""
    u0, v0, u1, v1 = strip_uv(name)
    return (u1 - u0) * W / ((v1 - v0) * H)


FONTS = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf',
         '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']
K = 4                             # lettering rendered at 4x, then downsampled


def strip_layout(name):
    """(font, tracking px at 4x, ink x0, ink x1 at 1x): capitals 68 % of the strip height, letter spacing widened up to
    0.2 em (painted hangar lettering, as on airline maintenance hangars)."""
    from PIL import ImageFont
    row, text, ink, bg = STRIPS[name]
    font_path = next(p for p in FONTS if os.path.exists(p))
    size = int(S * K * 0.68 / 0.716)                  # Arial cap height = 0.716 em
    f = ImageFont.truetype(font_path, size)
    widths = [f.getlength(ch) for ch in text]
    target = (W - 24) * K
    track = min(0.2 * size, max(0.0, (target - sum(widths)) / max(1, len(text) - 1)))
    total = sum(widths) + track * (len(text) - 1)
    if total > target:                                # too long even untracked: smaller letters
        size = int(size * target / total)
        f = ImageFont.truetype(font_path, size)
        widths = [f.getlength(ch) for ch in text]
        track, total = 0.0, sum(widths)
    x0 = (W * K - total) / 2
    return f, track, x0 / K, (x0 + total) / K


def _srgb(c):
    return int(round(255 * (12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)))


def main():
    from PIL import Image, ImageDraw, ImageFont
    os.makedirs(TEX_DIR, exist_ok=True)
    img = Image.new('RGB', (W, H), (128, 128, 128))
    mr = Image.new('RGB', (W, H), (0, 140, 60))          # drawn full size, saved at 1/4 (one texel per 16 px)
    d, dm = ImageDraw.Draw(img), ImageDraw.Draw(mr)
    for name, (k, c, r, m) in SWATCH.items():
        col, row = k % COLS, k // COLS
        box = [col * S, row * S, col * S + S - 1, row * S + S - 1]
        d.rectangle(box, fill=tuple(_srgb(v) for v in c))
        dm.rectangle(box, fill=(0, int(round(r * 255)), int(round(m * 255))))
    for name, (row, text, ink, bg) in STRIPS.items():
        bgc = tuple(_srgb(v) for v in SWATCH[bg][1])
        f, track, x0, x1 = strip_layout(name)
        big = Image.new('RGB', (W * K, S * K), bgc)
        bd = ImageDraw.Draw(big)
        top, bottom = bd.textbbox((0, 0), 'H', font=f)[1::2]
        y = (S * K - (bottom - top)) / 2 - top
        x = x0 * K
        for ch in text:
            bd.text((x, y), ch, font=f, fill=ink)
            x += f.getlength(ch) + track
        img.paste(big.resize((W, S), Image.LANCZOS), (0, row * S))
        r, m = SWATCH[bg][2], SWATCH[bg][3]
        dm.rectangle([0, row * S, W - 1, row * S + S - 1], fill=(0, int(round(r * 255)), int(round(m * 255))))
    img.save(ATLAS_PNG, optimize=True)
    mr.resize((W // 4, H // 4), Image.NEAREST).save(ATLAS_MR_PNG, optimize=True)
    print('wrote', ATLAS_PNG, os.path.getsize(ATLAS_PNG) // 1024, 'KB,', ATLAS_MR_PNG, os.path.getsize(ATLAS_MR_PNG) // 1024, 'KB')


if __name__ == '__main__':
    main()
