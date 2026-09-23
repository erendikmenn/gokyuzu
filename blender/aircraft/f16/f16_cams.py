"""Extra render cameras for the cockpit (drawing frame s aft, y right, z up) shared by the before/after renders.

Each entry: (camera location, target, lens mm, resolution[, options]). options: {'hide': [object names], 'pilot': False
(hide the pilot figure), 'exposure': EV}. Shots whose name ends in '_ext' render the matching shot with the interior, the
pilot and the HUD hidden (exterior-only check for before/after pixel diffs). Extra cameras for quick experiments can be
merged from a JSON file named by the environment variable F16_CAMS_EXTRA.
Reference-matched cameras (same angle as the photos in blender/aircraft/f16/ref/):
  ck_ref00  LM/USAF F-16C cockpit photo (pilot's view of the whole front panel)
  ck_ref08  Asian Aerospace 2006 F-16 cockpit (camera fitted to 13 panel features; the photo's cockpit has no canopy)
  ck_hud    side view of the glareshield / HUD like the 85-1479 canopy-open photo
"""
import os
import json

CAMS = {
    # the pilot's eye looking forward (design eye 4.26, 0, 2.815), level-ish gaze toward the HUD
    'ck_front': ((4.27, 0.0, 2.83), (3.30, 0.0, 2.58), 20, (1920, 1080)),
    # the pilot's eye looking down at the left / right console
    'ck_left': ((4.30, 0.06, 2.84), (3.98, -0.33, 2.25), 17, (1920, 1080)),
    'ck_right': ((4.30, -0.06, 2.84), (3.98, 0.33, 2.25), 17, (1920, 1080)),
    # in-game default cockpit view: design eye, pitch -2 deg, 74 deg vertical FOV (16:9)
    'ck_game': ((4.26, 0.0, 2.815), (3.26, 0.0, 2.780), 13.4, (1920, 1080)),
    'ck_ref00': ((4.10, 0.0, 2.78), (3.72, 0.0, 2.45), 17, (1136, 1080), {'pilot': False, 'exposure': 0.4}),
    'ck_ref08': ((4.451, -0.293, 2.75), (3.945, -0.069, 2.519), 27, (1440, 1080), {'pilot': False, 'hide': ['canopy'], 'exposure': 0.4}),
    'ck_hud': ((4.45, -2.60, 3.05), (3.70, 0.0, 2.62), 70, (1600, 1080), {'pilot': False, 'hide': ['canopy']}),
    # looking down on the side consoles from above the canopy rail (pilot hidden)
    'ck_lcons': ((4.35, -0.20, 2.95), (4.15, -0.32, 2.27), 24, (1440, 1080), {'pilot': False}),
    'ck_rcons': ((4.35, 0.20, 2.95), (4.15, 0.32, 2.27), 24, (1440, 1080), {'pilot': False}),
}

extra = os.environ.get('F16_CAMS_EXTRA')
if extra and os.path.exists(extra):
    for k, v in json.load(open(extra)).items():
        CAMS[k] = tuple(tuple(x) if isinstance(x, list) else x for x in v)
