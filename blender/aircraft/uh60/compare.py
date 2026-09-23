"""Before | after | reference photo strips (venv python). Written to renders/aircraft/uh60/before/ (never published).

    python compare.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
REN = os.path.join(REPO, 'renders', 'aircraft', 'uh60')
BEF = os.path.join(REN, 'before')
REF = os.path.join(HERE, 'ref')
H = 600
FONT = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf', 26)

VIEWS = {
    # view: (before file, after file, reference photo, caption)
    'hero': ('hero.png', 'hero.png', 'exterior_inflight_01_34_front_slightly_above.jpg', 'UH-60M in flight, front-right from above'),
    'helipad': ('helipad.png', 'helipad.png', 'exterior_front34_right_02_slovak_7641.jpg', 'UH-60M front-right 3/4 (Slovak AF)'),
    'side': ('side.png', 'side_doors_open.png', 'exterior_side_right_04_parked_door_open_us_army.jpg', 'US Army UH-60M right side, door open'),
    'rotorhead': ('rotorhead.png', 'rotorhead.png', 'rotorhead_03_hub_swashplate_left_side.jpg', 'UH-60 rotor head, mast, pitch rods'),
    'cockpit': ('cockpit.png', 'cockpit.png', 'cockpit_m_01_panel_from_rear_empty.jpg', 'UH-60M CAAS cockpit (DVIDS 815181)'),
    'cockpit_ref': ('cockpit_ref.png', 'cockpit_ref.png', 'cockpit_m_01_panel_from_rear_empty.jpg', 'same viewpoint as the photo'),
    'cabin': ('cabin.png', 'cabin.png', 'cabin_02_right_door_open_from_outside.jpg', 'UH-60M cabin, right door open'),
    'front': ('front.png', 'front.png', 'exterior_front_01_nose_on_low_camera.jpg', 'UH-60M head-on'),
}


def fit(path, h):
    im = Image.open(path).convert('RGB')
    w = int(im.width * h / im.height)
    return im.resize((w, h), Image.LANCZOS)


def label(im, text):
    d = ImageDraw.Draw(im)
    tw = d.textlength(text, font=FONT)
    d.rectangle([0, 0, tw + 20, 38], fill=(0, 0, 0))
    d.text((10, 5), text, font=FONT, fill=(255, 235, 150))
    return im


def main():
    made = []
    for view, (bf, af, rf, cap) in VIEWS.items():
        pb, pa, pr = os.path.join(BEF, bf), os.path.join(REN, af), os.path.join(REF, rf)
        if not (os.path.exists(pa) and os.path.exists(pr)):
            continue
        tiles = []
        if os.path.exists(pb):
            tiles.append(label(fit(pb, H), 'BEFORE'))
        tiles.append(label(fit(pa, H), 'AFTER'))
        tiles.append(label(fit(pr, H), 'REFERENCE: ' + cap))
        W = sum(t.width for t in tiles) + 8 * (len(tiles) - 1)
        out = Image.new('RGB', (W, H), (12, 12, 12))
        x = 0
        for t in tiles:
            out.paste(t, (x, 0))
            x += t.width + 8
        p = os.path.join(BEF, f'compare_{view}.jpg')
        if os.path.exists(p):
            os.remove(p)
        out.save(p, quality=88)
        made.append(p)
    print('\n'.join(made))


if __name__ == '__main__':
    main()
