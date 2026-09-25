"""Local brand / markings opt-ins: files outside git, used only when present.

The repository carries no third-party trademarks: every build script paints a fictional default (the "Gökyüzü" house
livery TC-GKA / TC-GKB, neutral hangar lettering, fictional military markings). Anything else (a real airline livery,
company lettering, real military insignia and serials) lives in a local brand directory outside git and is picked up
by generic hooks:

    ${GOKYUZU_BRAND_DIR:-~/.config/gokyuzu/brand}/
        liveries/<aircraft>/<name>.py   a livery module, selected with LIVERY=<name> (per aircraft: A320_LIVERY,
                                        B737_LIVERY); its hooks and the files it needs are documented in the aircraft's
                                        textures.py. Without LIVERY the built-in fictional livery is painted.
        airport_lettering.json          hangar lettering texts (tools/geo/airports_ist_atlas.py), used when present
        markings.json                   military markings: values (tail codes, serials, ...) per aircraft, used when
                                        present (keys: blender/aircraft/{f16/textures.py, f22/textures_ext.py,
                                        uh60/texgen.py})
        markings/<aircraft>.py          optional drawing code for insignia the repository does not draw

GOKYUZU_BRAND=off ignores the whole directory. Pure Python (no bpy, no PIL at import): used by the texture scripts
(project venv) and by Blender's Python alike.
"""
import importlib.util
import json
import os
import re
import sys

DEFAULT_LIVERY = 'gokyuzu'
_modules = {}


def enabled():
    """False when GOKYUZU_BRAND is off / 0 / no / none / false: every brand file is ignored."""
    return os.environ.get('GOKYUZU_BRAND', 'on').strip().lower() not in ('0', 'off', 'no', 'none', 'false')


def brand_dir():
    d = os.environ.get('GOKYUZU_BRAND_DIR') or os.path.join('~', '.config', 'gokyuzu', 'brand')
    return os.path.abspath(os.path.expanduser(d))


def path(name):
    """Absolute path of a brand file, or None when it is absent or brand files are switched off."""
    if not enabled():
        return None
    p = os.path.join(brand_dir(), name)
    return p if os.path.isfile(p) else None


def require(name, what):
    """Path of a brand file an opt-in build cannot do without; exits with instructions when it is missing."""
    p = path(name)
    if p is None:
        why = 'GOKYUZU_BRAND is off' if not enabled() else f'{os.path.join(brand_dir(), name)} is missing'
        raise SystemExit(f'{what} is a local opt-in and {why} (see blender/common/brand.py).')
    return p


def load_json(name, default=None):
    """Parsed brand JSON file, or `default` ({}) when absent / switched off."""
    p = path(name)
    if p is None:
        return {} if default is None else default
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def module(name):
    """Import the brand-directory Python file `name` (e.g. 'markings/f16.py'), or None when absent / switched off.
    Imported once per process under a private module name."""
    p = path(name)
    if p is None:
        return None
    if p not in _modules:
        key = 'gokyuzu_brand_' + re.sub(r'\W', '_', name[:-3] if name.endswith('.py') else name)
        spec = importlib.util.spec_from_file_location(key, p)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[key] = mod
        spec.loader.exec_module(mod)
        _modules[p] = mod
    return _modules[p]


def livery_name(aircraft_env):
    """Livery selected by the environment: <aircraft_env> (e.g. A320_LIVERY) wins over LIVERY; default 'gokyuzu'."""
    v = (os.environ.get(aircraft_env) or os.environ.get('LIVERY') or DEFAULT_LIVERY).strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]+', v):
        raise SystemExit(f'invalid livery name {v!r} ({aircraft_env} / LIVERY)')
    return v


def livery_module(aircraft, aircraft_env):
    """None for the built-in fictional livery; otherwise the local livery module liveries/<aircraft>/<name>.py
    (exits with instructions when it is missing or brand files are switched off)."""
    v = livery_name(aircraft_env)
    if v == DEFAULT_LIVERY:
        return None
    rel = f'liveries/{aircraft}/{v}.py'
    require(rel, f'The {aircraft} livery {v!r} ({aircraft_env} / LIVERY)')
    return module(rel)


def markings(aircraft, defaults):
    """Military markings of one aircraft: the fictional `defaults` updated by markings.json[aircraft] (if present)."""
    out = dict(defaults)
    out.update(load_json('markings.json').get(aircraft, {}))
    return out
