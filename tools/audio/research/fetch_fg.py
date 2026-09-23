"""Download the FlightGear (GPL) candidate recordings for the warning-sound research into
assets/audio/candidates/<aircraft>/<sound>/orig/ (unmodified files, pinned to a commit).

Research only: nothing here is used by the game. Re-run to rebuild the (gitignored) candidates tree:
    .venv/bin/python tools/audio/research/fetch_fg.py
Writes tools/audio/research/fg_sources.json (url, commit, sha256, size of every file).
"""
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
CAND = os.path.join(ROOT, 'assets', 'audio', 'candidates')
UA = 'flight-sim-audio-research/1.0 (fs.erenailab.com; non-commercial research)'

# repo key -> (raw URL prefix pinned to a commit, human URL, licence)
REPOS = {
    'a320fam': ('https://raw.githubusercontent.com/legoboyvdlp/A320-family/b6d40c4b11007da25eca4a6df76c9776beca6339/',
                'https://github.com/legoboyvdlp/A320-family', 'GPL-2.0'),
    'b737yv': ('https://raw.githubusercontent.com/YV3399/737-800YV/9d967d89dd2ee0ae1bf01d00c49839a574aa9da5/',
               'https://github.com/YV3399/737-800YV', 'GPL-2.0'),
    'fgdata': ('https://gitlab.com/flightgear/fgdata/-/raw/ac5327c656fa8de16d5ded7a90501a07120a3b8b/',
               'https://gitlab.com/flightgear/fgdata', 'GPL-2.0'),
    'f16nvc': ('https://raw.githubusercontent.com/NikolaiVChr/f16/0d0d3d425a9a852b9cd6a764dedee7c9c72cdf51/',
               'https://github.com/NikolaiVChr/f16', 'GPL-2.0'),
    'f22rrc': ('https://raw.githubusercontent.com/racerretrocoder/Flightgear-F-22A-Raptor/ff9ae92220f6bf8dcb30ef012685025ca618bf92/',
               'https://github.com/racerretrocoder/Flightgear-F-22A-Raptor', 'GPL-2.0'),
    'f22fgm': ('https://raw.githubusercontent.com/FGMEMBERS/Lockheed-Martin-FA-22A-Raptor/616a258ed23353c633d2205477ed53a73b13e32d/',
               'https://github.com/FGMEMBERS/Lockheed-Martin-FA-22A-Raptor', 'GPL-2.0'),
    'uh60fgm': ('https://raw.githubusercontent.com/FGMEMBERS/UH-60/fb5d383fca3b47f28761b9d1edc361f75ad3bde7/',
                'https://github.com/FGMEMBERS/UH-60', 'GPL-2.0'),
}

A = 'Sounds/GPWS/'
Y = 'Sounds/gpws/'
M = 'Sounds/mk-viii/'
T = 'Sounds/tcas/female/'
FILES = [
    # ---- A320neo: A320-family (FlightGear)
    ('a320neo', 'crc', 'a320fam', 'Sounds/Cockpit/crc.wav'),
    ('a320neo', 'single_chime', 'a320fam', 'Sounds/Cockpit/chime.wav'),
    ('a320neo', 'c_chord', 'a320fam', 'Sounds/Cockpit/c-chord.wav'),
    ('a320neo', 'cricket_stall', 'a320fam', 'Sounds/Cockpit/cricket.wav'),
    ('a320neo', 'cricket_stall', 'a320fam', 'Sounds/Cockpit/stall_voice.wav'),
    ('a320neo', 'retard', 'a320fam', A + 'retard.wav'),
    *[('a320neo', 'callouts', 'a320fam', A + f'{n}.wav')
      for n in ('2500', '2000', '1000', '500', '400', '300', '200', '100', '50', '40', '30', '20', '10', '5',
                '100-above', 'minimum')],
    ('a320neo', 'sinkrate', 'a320fam', A + 'sink-rate.wav'),
    ('a320neo', 'pullup', 'a320fam', A + 'pull-up.wav'),
    ('a320neo', 'terrain', 'a320fam', A + 'terrain.wav'),
    ('a320neo', 'toolow_gear', 'a320fam', A + 'too-low-gear.wav'),
    ('a320neo', 'toolow_flaps', 'a320fam', A + 'too-low-flaps.wav'),
    ('a320neo', 'toolow_terrain', 'a320fam', A + 'too-low-terrain.wav'),
    ('a320neo', 'dontsink', 'a320fam', A + 'dont-sink.wav'),
    ('a320neo', 'glideslope', 'a320fam', A + 'glideslope.wav'),
    ('a320neo', 'bankangle', 'fgdata', M + 'bank-angle.wav'),
    ('a320neo', 'priority', 'a320fam', 'Sounds/Cockpit/priority-left.wav'),
    ('a320neo', 'priority', 'a320fam', 'Sounds/Cockpit/priority-right.wav'),
    ('a320neo', 'dual_input', 'a320fam', 'Sounds/Cockpit/dual-input.wav'),
    ('a320neo', 'triple_click', 'a320fam', 'Sounds/Cockpit/click.wav'),
    *[('a320neo', 'tcas', 'fgdata', T + f'{n}.wav')
      for n in ('traffic', 'climb', 'descend', 'monitor_vertical_speed', 'adjust_vertical_speed', 'clear')],
    # ---- 737-800: 737-800YV (FlightGear)
    ('b737', 'fire_bell', 'b737yv', 'Sounds/fire-bell.wav'),
    ('b737', 'clacker', 'b737yv', 'Sounds/overspeed.wav'),
    ('b737', 'shaker', 'b737yv', 'Sounds/stall.wav'),
    ('b737', 'alt_alert', 'b737yv', 'Sounds/altAlert.wav'),
    ('b737', 'crew_call', 'b737yv', 'Sounds/cabincall.wav'),
    *[('b737', 'callouts', 'b737yv', Y + f'altitude-{n}.wav')
      for n in ('2500', '1000', '500', '400', '300', '200', '100', '50', '40', '30', '20', '10')],
    ('b737', 'callouts', 'b737yv', Y + 'approaching-minimums.wav'),
    ('b737', 'callouts', 'b737yv', Y + 'minimums.wav'),
    ('b737', 'sinkrate', 'b737yv', Y + 'sink-rate.wav'),
    ('b737', 'pullup', 'b737yv', Y + 'pull-up.wav'),
    ('b737', 'toolow_gear', 'b737yv', Y + 'too-low-gear.wav'),
    ('b737', 'toolow_flaps', 'b737yv', Y + 'too-low-flaps.wav'),
    ('b737', 'dontsink', 'b737yv', Y + 'dont-sink.wav'),
    ('b737', 'glideslope', 'b737yv', Y + 'glideslope.wav'),
    ('b737', 'bankangle', 'b737yv', Y + 'bank-angle.wav'),
    ('b737', 'terrain', 'fgdata', M + 'terrain.wav'),
    ('b737', 'toolow_terrain', 'fgdata', M + 'too-low-terrain.wav'),
    ('b737', 'gear_horn', 'fgdata', 'Sounds/gear-hrn.wav'),
    *[('b737', 'tcas', 'fgdata', T + f'{n}.wav')
      for n in ('traffic', 'climb', 'descend', 'monitor_vertical_speed', 'adjust_vertical_speed', 'clear')],
    # ---- generic FlightGear MK VIII set (for provenance comparison: A320-family / 737-800YV copies)
    *[('_fgdata', 'mk-viii', 'fgdata', M + f'{n}.wav')
      for n in ('pull-up', 'sink-rate', 'terrain', 'too-low-gear', 'too-low-flaps', 'too-low-terrain', 'dont-sink',
                'glideslope', 'bank-angle', 'minimums', 'altitude-100', 'altitude-500', 'altitude-1000', 'retard',
                '100-above', 'altitude-2500')],
    # ---- F-16C: NikolaiVChr/f16 (FlightGear)
    *[('f16', k, 'f16nvc', f'Sounds/betty/{f}.wav') for k, f in (
        ('pullup', 'pullup'), ('altitude', 'altitude'), ('warning', 'warning'), ('caution', 'caution'),
        ('bingo', 'bingo'), ('ew_msgs', 'lock'), ('ew_msgs', 'data'), ('ew_msgs', 'jammer'), ('ew_msgs', 'chaff-flare'),
        ('ew_msgs', 'chaff-flare-out'), ('ew_msgs', 'IFF'), ('ew_msgs', 'missile'), ('ew_msgs', 'combined'))],
    ('f16', 'gear_horn', 'f16nvc', 'Sounds/250hz-square.wav'),
    ('f16', 'lowspeed_tone', 'f16nvc', 'Sounds/250hz-square-steady.wav'),
    # ---- F-22A: FlightGear community F-22s (provenance not stated)
    ('f22', 'pullup', 'f22rrc', 'Sounds/pullup.wav'),
    ('f22', 'altitude', 'f22rrc', 'Sounds/AV/alt.wav'),
    ('f22', 'overg', 'f22rrc', 'Sounds/Overgwarning.wav'),
    ('f22', 'bingo', 'f22rrc', 'Sounds/fuellow.wav'),
    ('f22', 'lowspeed', 'f22rrc', 'Sounds/AV/stall.wav'),
    ('f22', 'altitude', 'f22fgm', 'Sounds/low-alt-warning.wav'),
    ('f22', 'lowspeed', 'f22fgm', 'Sounds/stall.wav'),
    # ---- UH-60: FGUK UH-60 (FlightGear) — generic rotor-RPM tones inherited from the Bo105
    ('uh60', 'low_rotor', 'uh60fgm', 'Sounds/warn650.wav'),
    ('uh60', 'low_rotor', 'uh60fgm', 'Sounds/warn2600.wav'),
]


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    out = []
    for aid, snd, rk, path in FILES:
        base, human, lic = REPOS[rk]
        url = base + path
        dst_dir = os.path.join(CAND, aid, snd, 'orig')
        os.makedirs(dst_dir, exist_ok=True)
        name = f'{rk}__{os.path.basename(path)}'
        dst = os.path.join(dst_dir, name)
        if not os.path.exists(dst):
            data = fetch(url)
            with open(dst, 'wb') as f:
                f.write(data)
        data = open(dst, 'rb').read()
        out.append({'aircraft': aid, 'sound': snd, 'repo': human, 'licence': lic, 'path': path, 'url': url,
                    'file': os.path.relpath(dst, ROOT), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        print(f'{aid:8s} {snd:16s} {len(data):8d}  {path}')
    with open(os.path.join(os.path.dirname(__file__), 'fg_sources.json'), 'w') as f:
        json.dump(out, f, indent=1)


if __name__ == '__main__':
    sys.exit(main())
