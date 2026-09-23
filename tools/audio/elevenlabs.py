"""ElevenLabs text-to-speech provider for the voice callouts (REST API, cached).

The API key is read from $ELEVENLABS_API_KEY or ~/.config/elevenlabs.env (KEY=value lines). It is never printed or
logged. Raw downloads (16-bit PCM) are cached under data/sf/raw/elevenlabs/ (gitignored), keyed by a hash of
voice + model + settings + text, so rebuilding the voice assets does not spend characters again.

CLI:  .venv/bin/python tools/audio/elevenlabs.py voices|models|usage
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from scipy import signal

API = 'https://api.elevenlabs.io/v1'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.path.join(ROOT, 'data', 'sf', 'raw', 'elevenlabs')
SR_OUT = 48000
_chars_used = 0


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


def _request(method, path, body=None, accept='application/json', retries=4):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header('xi-api-key', _key())
        req.add_header('Accept', accept)
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            msg = e.read()[:300].decode(errors='replace')
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f'ElevenLabs {method} {path.split("?")[0]} → HTTP {e.code}: {msg}') from None
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f'ElevenLabs network error: {e.reason}') from None


def list_voices():
    return json.loads(_request('GET', '/voices'))['voices']


def list_models():
    return json.loads(_request('GET', '/models'))


def usage():
    return json.loads(_request('GET', '/user/subscription'))


def tts(text, voice_id, model='eleven_multilingual_v2', stability=0.8, similarity=0.8, style=0.0, speed=1.0,
        speaker_boost=True, seed=1234):
    """Speech for `text` as float samples at 48 kHz (cached raw 44.1 kHz PCM)."""
    global _chars_used
    settings = {'stability': stability, 'similarity_boost': similarity, 'style': style,
                'use_speaker_boost': speaker_boost, 'speed': speed}
    h = hashlib.sha1(json.dumps([voice_id, model, settings, text, seed], sort_keys=True).encode()).hexdigest()[:20]
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'{voice_id[:8]}_{h}.pcm')
    if not os.path.exists(path):
        body = {'text': text, 'model_id': model, 'voice_settings': settings, 'seed': seed}
        raw = _request('POST', f'/text-to-speech/{voice_id}?output_format=pcm_44100', body, accept='audio/pcm')
        with open(path + '.tmp', 'wb') as fh:
            fh.write(raw)
        os.replace(path + '.tmp', path)
        with open(os.path.join(CACHE, 'index.jsonl'), 'a') as fh:
            fh.write(json.dumps({'file': os.path.basename(path), 'voice': voice_id, 'model': model, 'text': text,
                                 'settings': settings}) + '\n')
        _chars_used += len(text)
    with open(path, 'rb') as fh:
        pcm = np.frombuffer(fh.read(), dtype='<i2').astype(float) / 32768.0
    return signal.resample_poly(pcm, 160, 147)        # 44.1 kHz → 48 kHz


def sound_effect(text, duration, prompt_influence=0.6, tag='sfx'):
    """ElevenLabs sound-effects generation → float samples at 48 kHz (MP3 cached under data/sf/raw/elevenlabs/sfx)."""
    import subprocess
    import tempfile
    body = {'text': text, 'duration_seconds': duration, 'prompt_influence': prompt_influence}
    h = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:20]
    d = os.path.join(CACHE, 'sfx')
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f'{tag}_{h}.mp3')
    if not os.path.exists(path):
        raw = _request('POST', '/sound-generation', body, accept='audio/mpeg')
        with open(path, 'wb') as fh:
            fh.write(raw)
        with open(os.path.join(d, 'index.jsonl'), 'a') as fh:
            fh.write(json.dumps({'file': os.path.basename(path), **body}) + '\n')
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, 'o.wav')
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', f'LEI16@{SR_OUT}', path, wav], check=True, capture_output=True)
        from scipy.io import wavfile
        sr, x = wavfile.read(wav)
    x = x.astype(float) / 32768.0
    return x.mean(axis=1) if x.ndim > 1 else x


def chars_used():
    return _chars_used


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'voices'
    if cmd == 'voices':
        for v in list_voices():
            lab = v.get('labels') or {}
            print(f"{v['voice_id']}  {v['name'][:28]:28s} {v.get('category', ''):10s} "
                  f"{lab.get('gender', ''):7s} {lab.get('age', ''):12s} {lab.get('accent', ''):14s} "
                  f"{lab.get('description', '') or lab.get('descriptive', '')} {lab.get('use_case', '') or lab.get('use case', '')}")
    elif cmd == 'models':
        for m in list_models():
            print(m['model_id'], '|', m.get('name'), '| tts' if m.get('can_do_text_to_speech') else '', '| en' if any(
                l.get('language_id') == 'en' for l in m.get('languages', [])) else '')
    elif cmd == 'usage':
        u = usage()
        print({k: u.get(k) for k in ('tier', 'character_count', 'character_limit', 'status')})
