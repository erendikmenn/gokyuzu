"""Local deploy configuration for the Python ops scripts (rollback.py, tools/analytics/*, infra/leaderboard/setup.py).

The file is ~/.config/gokyuzu/deploy.env, or $GOKYUZU_DEPLOY_ENV; keys and rules: tools/deploy/deploy.env.example
(same parser as config.sh and config.mjs). Values are read from the file only and never printed.

    import deploy_config as cfg      # after sys.path.insert(0, <repo>/tools/deploy)
    cfg.get('S3_BUCKET_LOGS')         # required: exits naming the key if missing, empty or REPLACE_ME
    cfg.profile('AWS_PROFILE_ADMIN')  # environment, else the file, else the built-in default
"""
import os
import re
import sys
from pathlib import Path

PLACEHOLDER = 'REPLACE_ME'
PROFILE_DEFAULTS = {
    'AWS_PROFILE_DEPLOY': 'gokyuzu-deploy',
    'AWS_PROFILE_ADMIN': 'gokyuzu-admin',
    'AWS_PROFILE_ANALYTICS': 'gokyuzu-analytics',
}
_LINE = re.compile(r'^(?:export[ \t]+)?([^=]*?)[ \t]*=[ \t]*(.*?)[ \t\r]*$')
_cache = None


def path():
    return Path(os.environ.get('GOKYUZU_DEPLOY_ENV') or Path.home() / '.config' / 'gokyuzu' / 'deploy.env')


def shown():
    return os.environ.get('GOKYUZU_DEPLOY_ENV') or '~/.config/gokyuzu/deploy.env'


def parse(text):
    """KEY=VALUE lines → dict (last one wins); comment lines, blank lines and lines without '=' are ignored."""
    out = {}
    for raw in text.splitlines():
        line = raw.lstrip(' \t')
        if not line or line.startswith('#'):
            continue
        m = _LINE.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if len(val) >= 2 and val[0] == val[-1] and val[0] in '"\'':
            val = val[1:-1]
        out[key] = val
    return out


def load():
    """The whole file as a dict ({} if the file does not exist)."""
    global _cache
    if _cache is None:
        p = path()
        _cache = parse(p.read_text(encoding='utf-8')) if p.is_file() else {}
    return _cache


def get(key):
    if not path().is_file():
        sys.exit(f'Deploy config not found: {shown()}\n'
                 f'  Copy tools/deploy/deploy.env.example there (chmod 600) and fill it in, or set GOKYUZU_DEPLOY_ENV.')
    val = load().get(key, '')
    if not val or val == PLACEHOLDER:
        sys.exit(f'Deploy config: key {key} is missing, empty or still {PLACEHOLDER} in {shown()} '
                 f'(see tools/deploy/deploy.env.example).')
    return val


def profile(key):
    val = os.environ.get(key) or load().get(key, '')
    return val if val and val != PLACEHOLDER else PROFILE_DEFAULTS[key]
