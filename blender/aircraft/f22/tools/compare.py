"""before | after | reference photo strips for renders/aircraft/f22/before/compare_<view>.jpg (project venv).

  python compare.py            (uses the default view -> reference table below)
The before/ folder is never published; reference photos only ever end up there (CONTRACTS-SF.md 10).
"""
import os
from PIL import Image, ImageDraw, ImageFont

H = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
REPO = os.path.abspath(os.path.join(H, '..', '..', '..'))
R = os.path.join(REPO, 'renders', 'aircraft', 'f22')
REF = os.path.join(H, 'ref')
VIEWS = {   # view: (render file, reference photo, optional crop box of the reference (fractions))
    'hero': ('hero.png', 'q34_71fs.png', (0.0, 0.18, 1.0, 0.92)),
    'front_34': ('front_34.png', 'q34_low_220606.jpg', None),
    'planform': ('planform.png', 'top_refuel_140807.jpg', None),
    'rear_nozzles': ('rear_nozzles.png', 'rear_tailfeathers.jpg', None),
    'cockpit': ('cockpit.png', 'cockpit_ground.jpg', None),
}
FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'


def fit(im, w, h):
    """Cover-crop to w x h."""
    r = max(w / im.width, h / im.height)
    im = im.resize((int(im.width * r + 0.5), int(im.height * r + 0.5)), Image.LANCZOS)
    x0 = (im.width - w) // 2
    y0 = (im.height - h) // 2
    return im.crop((x0, y0, x0 + w, y0 + h))


def main():
    w, h = 960, 540
    try:
        f = ImageFont.truetype(FONT, 26)
    except OSError:
        f = ImageFont.load_default()
    for view, (rf, ref, crop) in VIEWS.items():
        b = os.path.join(R, 'before', rf)
        a = os.path.join(R, rf)
        p = os.path.join(REF, ref)
        if not (os.path.exists(b) and os.path.exists(a) and os.path.exists(p)):
            print('skip', view)
            continue
        refim = Image.open(p).convert('RGB')
        if crop:
            W, Hh = refim.size
            refim = refim.crop((int(crop[0] * W), int(crop[1] * Hh), int(crop[2] * W), int(crop[3] * Hh)))
        tiles = [fit(Image.open(b).convert('RGB'), w, h), fit(Image.open(a).convert('RGB'), w, h), fit(refim, w, h)]
        out = Image.new('RGB', (w * 3 + 8, h + 44), (18, 18, 20))
        d = ImageDraw.Draw(out)
        for k, (t, lab) in enumerate(zip(tiles, ('ÖNCE / before', 'SONRA / after', 'GERÇEK / reference: ' + ref))):
            out.paste(t, (k * (w + 4), 44))
            d.text((k * (w + 4) + 12, 8), lab, fill=(235, 235, 230), font=f)
        path = os.path.join(R, 'before', f'compare_{view}.jpg')
        out.save(path, quality=88)
        print('wrote', path)


if __name__ == '__main__':
    main()
