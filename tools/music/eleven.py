"""ElevenLabs Music API client for the soundtrack (Eleven Music, POST /v1/music), cached.

The API key is read from $ELEVENLABS_API_KEY or ~/.config/elevenlabs.env (KEY=value lines) and is never printed or
logged. Raw downloads are cached under data/sf/raw/music/ (gitignored, never published), keyed by a hash of the
request, so rebuilding the delivery files does not spend credits again. Requests carry nothing but the API key and the
musical prompt (no user or project data).

CLI:  .venv/bin/python tools/music/eleven.py usage     (plan tier + credit counter)
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.elevenlabs.io/v1'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.path.join(ROOT, 'data', 'sf', 'raw', 'music')


def _key():
    k = os.environ.get('ELEVENLABS_API_KEY')
    if k:
        return k.strip()
    path = os.path.expanduser('~/.config/elevenlabs.env')
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith('export '):
                    line = line[7:]
                if line.startswith('ELEVENLABS_API_KEY='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise RuntimeError('ELEVENLABS_API_KEY not found (environment or ~/.config/elevenlabs.env)')


def _request(method, path, body=None, accept='application/json', retries=3, timeout=600):
    """→ (bytes, headers). Errors carry the HTTP status and the API's message, never the key."""
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header('xi-api-key', _key())
        req.add_header('Accept', accept)
        req.add_header('User-Agent', 'gokyuzu-music-build/1')
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            msg = e.read()[:600].decode(errors='replace')
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f'ElevenLabs {method} {path.split("?")[0]} → HTTP {e.code}: {msg}') from None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f'ElevenLabs network error: {getattr(e, "reason", e)}') from None


def usage():
    raw, _ = _request('GET', '/user/subscription')
    u = json.loads(raw)
    return {k: u.get(k) for k in ('tier', 'status', 'character_count', 'character_limit')}


def compose(body, output_format='pcm_48000', tag='track'):
    """POST /v1/music → path of the cached raw file (+ its sidecar .json with the request and response headers)."""
    os.makedirs(CACHE, exist_ok=True)
    h = hashlib.sha1(json.dumps([body, output_format], sort_keys=True).encode()).hexdigest()[:16]
    ext = 'pcm' if output_format.startswith('pcm') else 'mp3'
    path = os.path.join(CACHE, f'{tag}_{h}.{ext}')
    if os.path.exists(path):
        return path
    before = usage()['character_count']
    t0 = time.time()
    raw, headers = _request('POST', f'/music?output_format={output_format}', body, accept='*/*')
    with open(path + '.tmp', 'wb') as fh:
        fh.write(raw)
    os.replace(path + '.tmp', path)
    after = usage()['character_count']
    keep = {k: v for k, v in headers.items() if k.lower() in ('song-id', 'content-type', 'x-character-count',
                                                             'request-id', 'x-request-id', 'history-item-id')}
    meta = {'file': os.path.basename(path), 'request': body, 'output_format': output_format, 'bytes': len(raw),
            'seconds': round(time.time() - t0, 1), 'credits': after - before, 'headers': keep,
            'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    with open(path + '.json', 'w') as fh:
        json.dump(meta, fh, indent=1)
    with open(os.path.join(CACHE, 'index.jsonl'), 'a') as fh:
        fh.write(json.dumps(meta) + '\n')
    return path


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'usage'
    if cmd == 'usage':
        print(usage())
