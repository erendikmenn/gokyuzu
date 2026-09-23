#!/usr/bin/env python3
"""Field performance from the CloudFront access logs already downloaded by tools/analytics/report.py
(data/analytics/<target>/*.gz). Read-only, local, aggregated: no IP, no visitor id and no per-session line is printed.

    .venv/bin/python tools/perf/field.py [production|staging] [--json out.json]

Reports per platform (browser/OS, mobile vs desktop):
  - sessions, share that started a flight (aircraft GLB requested)
  - load time proxy: first world request (assets/sf/terrain/index.bin, i.e. the "Uç" click) → cockpit GLB request
    (main.js requests it right after the world is ready = first playable frame), and the bytes sent in between
  - transfer rate per request for objects > 1 MB (sc-bytes / time-taken). Behind the Cloudflare proxy most requests come
    from Cloudflare's servers (cache fills), so this is Cloudflare↔CloudFront speed, not the players' bandwidth
  - requests/bytes by file type (= CloudFront egress, mostly Cloudflare cache fills), CloudFront cache results
  - the terrain height packs (h/<L>.bin): whole-file fetches (Cloudflare fills its cache with the full 0.01-381 MB file
    although the game asks for 9.5 KB ranges)
"""
import argparse
import gzip
import hashlib
import json
import secrets
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
GAP = timedelta(minutes=15)
BOTS = ('bot', 'crawl', 'spider', 'slurp', 'curl', 'wget', 'python', 'go-http', 'scan', 'monitor', 'preview', 'headless')


def client(ua):
    u = ua.lower()
    browser = ('Edge' if 'edg/' in u else 'Opera' if 'opr/' in u else 'Firefox' if 'firefox/' in u
               else 'Chrome' if 'chrome/' in u or 'crios/' in u else 'Safari' if 'safari/' in u else 'other')
    system = ('iOS' if 'iphone' in u or 'ipad' in u else 'Android' if 'android' in u else 'Windows' if 'windows' in u
              else 'macOS' if 'mac os x' in u else 'ChromeOS' if 'cros' in u else 'Linux' if 'linux' in u else 'other')
    # in-app browsers (Instagram, TikTok, …) on iOS carry no Safari token
    if system == 'iOS' and browser == 'other':
        browser = 'in-app'
    return browser, system


def kind(stem):
    s = stem.lower()
    if s in ('/', '/index.html'):
        return 'html'
    for pre, k in (('/assets/sf/terrain/img/', 'terrain-img'), ('/assets/sf/terrain/h/', 'terrain-h'), ('/assets/sf/terrain/', 'terrain-other'),
                   ('/assets/sf/city/trees/', 'trees'), ('/assets/sf/city/obst/', 'city-obst'), ('/assets/sf/city/', 'city'),
                   ('/assets/sf/landmarks/', 'landmarks'), ('/assets/sf/airports/', 'airports'), ('/assets/aircraft/', 'aircraft'),
                   ('/assets/audio/', 'audio'), ('/renders/', 'renders'), ('/node_modules/', 'three'), ('/src/', 'src'), ('/data/', 'data')):
        if s.startswith(pre):
            return k
    return 'other'


def pct(v, p):
    if not v:
        return None
    s = sorted(v)
    return s[min(len(s) - 1, int(len(s) * p))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target', nargs='?', default='production')
    ap.add_argument('--json')
    a = ap.parse_args()
    salt = secrets.token_hex(8)   # in-memory only: visitor keys cannot be linked to report.py or across runs
    rows = []
    for path in sorted((ROOT / 'data' / 'analytics' / a.target).glob('*.gz')):
        with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as f:
            fields = []
            for line in f:
                if line.startswith('#Fields:'):
                    fields = line.split()[1:]
                    continue
                if line.startswith('#') or not fields:
                    continue
                r = dict(zip(fields, line.rstrip('\n').split('\t')))
                ua = unquote(r.get('cs(User-Agent)', '-'))
                if any(w in ua.lower() for w in BOTS):
                    continue
                xff = unquote(r.get('x-forwarded-for', '-'))
                ip = xff.split(',')[0].strip() if xff not in ('-', '') else r.get('c-ip', '')
                rows.append({
                    'at': datetime.fromisoformat(f"{r['date']}T{r['time']}"), 'vid': hashlib.sha256(f'{salt}|{ip}|{ua}'.encode()).hexdigest()[:12],
                    'ua': client(ua), 'stem': r.get('cs-uri-stem', ''), 'status': r.get('sc-status', ''), 'bytes': int(r.get('sc-bytes', '0') or 0),
                    'took': float(r.get('time-taken', '0') or 0), 'ttfb': float(r.get('time-to-first-byte', '0') or 0), 'res': r.get('x-edge-result-type', ''),
                    'proto': r.get('cs-protocol-version', ''), 'ctype': r.get('sc-content-type', ''),
                })
    rows.sort(key=lambda r: r['at'])
    by_vid = defaultdict(list)
    for r in rows:
        by_vid[r['vid']].append(r)
    sessions = []
    for vid, rs in by_vid.items():
        cur = [rs[0]]
        for r in rs[1:]:
            if r['at'] - cur[-1]['at'] > GAP:
                sessions.append(cur)
                cur = []
            cur.append(r)
        sessions.append(cur)

    out = {'requests': len(rows), 'sessions': len(sessions), 'platforms': {}, 'types': {}, 'edgeTransferMbps': {}, 'cache': {}, 'protocol': {}}
    plat = defaultdict(lambda: {'sessions': 0, 'flights': 0, 'load_s': [], 'load_mb': [], 'menu_s': [], 'session_mb': []})
    for s in sessions:
        b, sy = s[0]['ua']
        key = f'{b}/{sy}'
        mob = 'mobile' if sy in ('iOS', 'Android') else 'desktop'
        for k in (key, mob, 'all'):
            plat[k]['sessions'] += 1
        stems = [r['stem'] for r in s]
        flight = any(st.startswith('/assets/aircraft/') and st.endswith('.glb') and not st.endswith(('_lod.glb', '_cockpit.glb')) for st in stems)
        world0 = next((r for r in s if r['stem'] == '/assets/sf/terrain/index.bin'), None)
        cockpit = next((r for r in s if r['stem'].endswith('_cockpit.glb')), None)
        html = next((r for r in s if r['stem'] in ('/', '/index.html')), None)
        mb = sum(r['bytes'] for r in s) / 1e6
        for k in (key, mob, 'all'):
            p = plat[k]
            p['session_mb'].append(mb)
            if flight:
                p['flights'] += 1
            if world0 and cockpit and cockpit['at'] >= world0['at']:
                p['load_s'].append((cockpit['at'] - world0['at']).total_seconds())
                p['load_mb'].append(sum(r['bytes'] for r in s if world0['at'] <= r['at'] <= cockpit['at']) / 1e6)
            if html and world0:
                p['menu_s'].append((world0['at'] - html['at']).total_seconds())
    for k, p in sorted(plat.items(), key=lambda kv: -kv[1]['sessions']):
        out['platforms'][k] = {
            'sessions': p['sessions'], 'flightShare': round(p['flights'] / max(1, p['sessions']), 2), 'withLoadTiming': len(p['load_s']),
            'loadS_p50': pct(p['load_s'], 0.5), 'loadS_p90': pct(p['load_s'], 0.9), 'loadMB_p50': round(pct(p['load_mb'], 0.5) or 0, 1),
            'menuToFlyS_p50': pct(p['menu_s'], 0.5), 'sessionMB_p50': round(pct(p['session_mb'], 0.5) or 0, 1), 'sessionMB_p90': round(pct(p['session_mb'], 0.9) or 0, 1),
        }
    t = defaultdict(lambda: [0, 0])
    for r in rows:
        k = kind(r['stem'])
        t[k][0] += 1
        t[k][1] += r['bytes']
    out['types'] = {k: {'requests': n, 'MB': round(b / 1e6, 1)} for k, (n, b) in sorted(t.items(), key=lambda kv: -kv[1][1])}
    thr = defaultdict(list)
    for r in rows:
        if r['bytes'] > 1_000_000 and r['took'] > 0.05:
            b, sy = r['ua']
            mob = 'mobile' if sy in ('iOS', 'Android') else 'desktop'
            thr[mob].append(r['bytes'] * 8 / 1e6 / r['took'])
            thr['all'].append(r['bytes'] * 8 / 1e6 / r['took'])
    out['edgeTransferMbps'] = {k: {'n': len(v), 'p10': round(pct(v, 0.1), 1), 'p50': round(pct(v, 0.5), 1), 'p90': round(pct(v, 0.9), 1)} for k, v in thr.items() if v}
    hp = defaultdict(lambda: [0, 0])
    for r in rows:
        if r['stem'].startswith('/assets/sf/terrain/h/'):
            hp[r['stem'].rsplit('/', 1)[-1]][0] += 1
            hp[r['stem'].rsplit('/', 1)[-1]][1] += r['bytes']
    out['terrainHeightPacks'] = {k: {'requests': n, 'MB': round(b / 1e6, 1), 'MBperRequest': round(b / 1e6 / max(1, n), 1)} for k, (n, b) in sorted(hp.items(), key=lambda kv: -kv[1][1])}
    out['cache'] = dict(Counter(r['res'] for r in rows).most_common())
    out['protocol'] = dict(Counter(r['proto'] for r in rows).most_common())
    ext = Counter(Path(r['stem']).suffix or r['stem'] for r in rows)
    out['extensions'] = dict(ext.most_common(20))
    out['status'] = dict(Counter(r['status'] for r in rows).most_common(8))
    print(json.dumps(out, indent=1, default=str))
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1, default=str))


if __name__ == '__main__':
    main()
