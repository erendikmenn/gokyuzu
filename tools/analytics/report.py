#!/usr/bin/env python3
"""Anonymous usage report for Gökyüzü SF from the CloudFront access logs (CONTRACTS-SF.md §11).

    .venv/bin/python tools/analytics/report.py                    # production, last 7 days
    .venv/bin/python tools/analytics/report.py staging --days 30
    .venv/bin/python tools/analytics/report.py --sessions 50      # longer session list

Downloads new log files (profile "gokyuzu-analytics", read-only on the log bucket) into data/analytics/<target>/
(gitignored; the bucket itself deletes logs after 30 days) and prints players, sessions and minutes played.
Two sources: the game's beacons (/_e, exact: flight start, one heartbeat per active minute, errors) and, for clients
without beacons (versions before telemetry, blocked requests), sessions rebuilt from asset requests (approximate).
Nobody is identified: a visitor is a salted hash of IP + browser (salt in ~/.config/gokyuzu/analytics_salt, never
shared); raw IPs are never printed. Your own IPs (~/.config/gokyuzu/staging_ips) are marked "sen", headless test
browsers "test".
"""
import argparse
import datetime as dt
import gzip
import hashlib
import os
import secrets
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import parse_qs, unquote

import boto3

ROOT = Path(__file__).resolve().parents[2]
BUCKET = 'gokyuzu-sf-logs-<aws-account-id>-eu-central-1'
CONFIG = Path.home() / '.config' / 'gokyuzu'
SESSION_GAP = dt.timedelta(minutes=15)   # asset requests further apart than this start a new (approximate) session
AIRCRAFT = {'f16': 'F-16', 'f22': 'F-22', 'a320neo': 'A320neo', 'b737': '737-800', 'uh60': 'UH-60M'}
EDGES = {   # CloudFront edge codes start with the nearest airport's IATA code
    'IST': 'İstanbul', 'SAW': 'İstanbul', 'FRA': 'Frankfurt', 'AMS': 'Amsterdam', 'LHR': 'Londra', 'LON': 'Londra',
    'MAN': 'Manchester', 'CDG': 'Paris', 'PAR': 'Paris', 'MRS': 'Marsilya', 'MUC': 'Münih', 'VIE': 'Viyana',
    'WAW': 'Varşova', 'SOF': 'Sofya', 'ATH': 'Atina', 'OTP': 'Bükreş', 'BUD': 'Budapeşte', 'PRG': 'Prag',
    'MXP': 'Milano', 'MIL': 'Milano', 'FCO': 'Roma', 'PMO': 'Palermo', 'MAD': 'Madrid', 'BCN': 'Barselona',
    'LIS': 'Lizbon', 'ZRH': 'Zürih', 'DUS': 'Düsseldorf', 'HAM': 'Hamburg', 'BER': 'Berlin', 'TXL': 'Berlin',
    'CPH': 'Kopenhag', 'ARN': 'Stockholm', 'OSL': 'Oslo', 'HEL': 'Helsinki', 'DUB': 'Dublin', 'BRU': 'Brüksel',
    'ZAG': 'Zagreb', 'TLV': 'Tel Aviv', 'SFO': 'San Francisco', 'SJC': 'San Jose', 'LAX': 'Los Angeles',
    'HIO': 'Hillsboro (Oregon)', 'SEA': 'Seattle', 'IAD': 'Washington', 'JFK': 'New York', 'EWR': 'New York',
    'ORD': 'Chicago', 'DFW': 'Dallas', 'ATL': 'Atlanta', 'MIA': 'Miami', 'BOS': 'Boston', 'DEN': 'Denver',
    'PHX': 'Phoenix', 'YTO': 'Toronto', 'YYZ': 'Toronto', 'YUL': 'Montreal', 'YVR': 'Vancouver',
}
BOT_WORDS = ('bot', 'crawl', 'spider', 'slurp', 'curl', 'wget', 'python', 'go-http', 'scan', 'monitor', 'preview')


def sync(target, profile):
    local = ROOT / 'data' / 'analytics' / target
    local.mkdir(parents=True, exist_ok=True)
    s3 = boto3.Session(profile_name=profile).client('s3')
    have = {p.name for p in local.iterdir()}
    new = 0
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=f'{target}/'):
        for obj in page.get('Contents', []):
            name = obj['Key'].split('/')[-1]
            if name not in have:
                s3.download_file(BUCKET, obj['Key'], str(local / name))
                new += 1
    return local, new


def read_logs(folder, since):
    for path in sorted(folder.glob('*.gz')):
        with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as f:
            fields = []
            for line in f:
                if line.startswith('#Fields:'):
                    fields = line.split()[1:]
                    continue
                if line.startswith('#') or not fields:
                    continue
                row = dict(zip(fields, line.rstrip('\n').split('\t')))
                at = dt.datetime.fromisoformat(f"{row['date']}T{row['time']}+00:00")
                if at >= since:
                    row['at'] = at
                    yield row


def salt():
    p = CONFIG / 'analytics_salt'
    if not p.exists():
        CONFIG.mkdir(parents=True, exist_ok=True)
        p.write_text(secrets.token_hex(16))
        p.chmod(0o600)
    return p.read_text().strip()


def own_ips():
    p = CONFIG / 'staging_ips'
    return {l.strip().split('/')[0] for l in p.read_text().splitlines() if l.strip()} if p.exists() else set()


def client(ua):
    u = ua.lower()
    if 'headless' in u:
        return 'test', 'test'
    browser = ('Edge' if 'edg/' in u else 'Opera' if 'opr/' in u else 'Firefox' if 'firefox/' in u
               else 'Chrome' if 'chrome/' in u or 'crios/' in u else 'Safari' if 'safari/' in u else 'diğer')
    system = ('iOS' if 'iphone' in u or 'ipad' in u else 'Android' if 'android' in u else 'Windows' if 'windows' in u
              else 'macOS' if 'mac os x' in u else 'ChromeOS' if 'cros' in u else 'Linux' if 'linux' in u else 'diğer')
    return browser, system


def edge_city(code):
    return EDGES.get(code[:3], code[:3] or '?')


def query(row):
    q = row.get('cs-uri-query', '-')
    if q in ('-', ''):
        return {}
    if '%25' in q:            # CloudFront re-encodes '%' in logged query strings
        q = unquote(q)
    return {k: v[-1] for k, v in parse_qs(q).items()}


def fmt_min(m):
    return f'{m:.0f} dk' if m >= 10 else f'{m:.1f} dk'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', nargs='?', default='production', choices=['production', 'staging'])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--sessions', type=int, default=25, help='how many sessions to list (newest first)')
    ap.add_argument('--no-sync', action='store_true', help='use the already downloaded logs')
    a = ap.parse_args()

    profile = os.environ.get('AWS_PROFILE_ANALYTICS', 'gokyuzu-analytics')
    folder = ROOT / 'data' / 'analytics' / a.target
    if not a.no_sync:
        folder, new = sync(a.target, profile)
        print(f'{new} yeni kayıt dosyası indirildi.', file=sys.stderr)
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)
    key_salt, mine = salt(), own_ips()

    beacons = defaultdict(list)          # sid -> [(at, event dict, visitor)]
    requests = defaultdict(list)         # visitor -> [(at, uri)]
    visitors = {}                        # visitor -> {browser, system, city, who}
    blocked = Counter()
    for row in read_logs(folder, since):
        ua = unquote(row.get('cs(User-Agent)', '-'))
        if any(w in ua.lower() for w in BOT_WORDS):
            continue
        status = row.get('sc-status', '0')
        if status == '403':
            blocked[edge_city(row.get('x-edge-location', ''))] += 1
            continue
        if not status.startswith(('2', '3')):
            continue
        # behind the Cloudflare proxy c-ip is a Cloudflare address; the player is the first X-Forwarded-For entry
        xff = unquote(row.get('x-forwarded-for', '-'))
        ip = xff.split(',')[0].strip() if xff not in ('-', '') else row.get('c-ip', '')
        vid = hashlib.sha256(f'{key_salt}|{ip}|{ua}'.encode()).hexdigest()[:6]
        browser, system = client(ua)
        who = 'sen' if ip in mine else 'test' if browser == 'test' else ''
        visitors.setdefault(vid, {'browser': browser, 'system': system, 'city': edge_city(row.get('x-edge-location', '')), 'who': who})
        uri = row.get('cs-uri-stem', '')
        if uri == '/_e':
            q = query(row)
            if q.get('s'):
                beacons[q['s']].append((row['at'], q, vid))
        else:
            requests[vid].append((row['at'], uri))

    sessions = []
    covered = defaultdict(list)          # visitor -> [(start, end)] already described by beacons
    for sid, evs in beacons.items():
        evs.sort(key=lambda e: e[0])
        vid = evs[0][2]
        fly = next((q for _, q, _ in evs if q.get('t') == 'fly'), {})
        first = next((q for _, q, _ in evs if q.get('t') == 'open'), {})
        hbs = [q for _, q, _ in evs if q.get('t') == 'hb']
        start, end = evs[0][0], evs[-1][0]
        minutes = max(float(q.get('m', 0) or 0) for _, q, _ in evs)
        active = max([int(q.get('a', 0) or 0) for _, q, _ in evs] + [0])
        fps = [int(q['fps']) for q in hbs if q.get('fps', '').isdigit()]
        sessions.append({
            'vid': vid, 'start': start, 'minutes': max(minutes, (end - start).total_seconds() / 60), 'active': active,
            'aircraft': fly.get('ac'), 'spawn': fly.get('sp'), 'load': fly.get('lt'), 'fps': round(statistics.mean(fps)) if fps else None,
            'gpu': first.get('gpu'), 'quality': fly.get('q') or first.get('q'), 'version': first.get('v') or fly.get('v'),
            'errors': [q.get('e') for _, q, _ in evs if q.get('t') == 'err'], 'exact': True,
        })
        covered[vid].append((start - SESSION_GAP, end + SESSION_GAP))

    for vid, reqs in requests.items():
        reqs.sort()
        groups, cur = [], [reqs[0]]
        for r in reqs[1:]:
            if r[0] - cur[-1][0] > SESSION_GAP:
                groups.append(cur)
                cur = []
            cur.append(r)
        groups.append(cur)
        for g in groups:
            start, end = g[0][0], g[-1][0]
            if any(s <= start <= e for s, e in covered[vid]):
                continue
            ac = next((p.split('/')[3] for _, p in g if p.startswith('/assets/aircraft/') and p.endswith('.glb')
                       and not p.endswith(('_lod.glb', '_cockpit.glb'))), None)
            sessions.append({'vid': vid, 'start': start, 'minutes': (end - start).total_seconds() / 60, 'active': None,
                             'aircraft': ac, 'spawn': None, 'load': None, 'fps': None, 'gpu': None, 'quality': None,
                             'version': None, 'errors': [], 'exact': False})

    real = [s for s in sessions if not visitors[s['vid']]['who']]
    label = {'production': 'canlı (fs.erenailab.com)', 'staging': 'staging'}[a.target]
    print(f'\nGökyüzü SF · {label} · son {a.days} gün')
    if not sessions:
        print('Henüz kayıt yok. (Kayıtlar CloudFront\'tan 5–60 dakika gecikmeyle gelir.)')
        return
    all_v = {s['vid'] for s in sessions}
    real_v = {s['vid'] for s in real}
    flights = [s for s in real if s['aircraft']]
    mins = [s['minutes'] for s in flights]
    print(f'Tekil ziyaretçi: {len(real_v)}  (sen/test dahil: {len(all_v)})')
    print(f'Oturum: {len(real)} · uçuş başlatan: {len(flights)}')
    if mins:
        print(f'Oynama süresi: toplam {fmt_min(sum(mins))} · ortalama {fmt_min(statistics.mean(mins))} · medyan {fmt_min(statistics.median(mins))}')
    exact = sum(1 for s in real if s['exact'])
    print(f'(Kesin ölçüm: {exact} oturum oyun içi sinyallerden, {len(real) - exact} oturum dosya isteklerinden yaklaşık)')

    def top(counter, n=8):
        return ' · '.join(f'{k} {v}' for k, v in counter.most_common(n)) or '-'
    print('\nUçaklar:', top(Counter(AIRCRAFT.get(s['aircraft'], s['aircraft']) for s in flights)))
    print('Kalkış noktaları:', top(Counter(s['spawn'] for s in flights if s['spawn'])))
    print('Günler:', top(Counter(s['start'].astimezone().strftime('%d.%m') for s in real), 14))
    print('Konum (en yakın CloudFront noktası):', top(Counter(visitors[v]['city'] for v in real_v)))
    print('Tarayıcı / sistem:', top(Counter(f"{visitors[v]['browser']}/{visitors[v]['system']}" for v in real_v)))
    fps = [s['fps'] for s in real if s['fps']]
    if fps:
        low = sum(1 for f in fps if f < 40)
        print(f'Performans: ortalama {statistics.mean(fps):.0f} fps · 40 fps altında: {low} oturum')
        print('Ekran kartları:', top(Counter(s['gpu'] for s in real if s['gpu'])))
        print('Kalite ayarı:', top(Counter(s['quality'] for s in real if s['quality'])))
    errs = Counter(e for s in real for e in s['errors'])
    if errs:
        print('Hatalar:', top(errs, 5))
    if blocked:
        print('IP kilidine takılan istek:', top(blocked))

    print(f'\nSon {min(a.sessions, len(sessions))} oturum (anonim ziyaretçi kimliği · başlangıç · konum · tarayıcı · uçak · süre):')
    for s in sorted(sessions, key=lambda s: s['start'], reverse=True)[:a.sessions]:
        v = visitors[s['vid']]
        ac = AIRCRAFT.get(s['aircraft'], s['aircraft'] or 'menüde kaldı')
        dur = fmt_min(s['minutes']) + (f" (aktif {s['active']} dk)" if s['active'] else '') + ('' if s['exact'] else ' ~')
        extra = ' · '.join(x for x in [f"{s['fps']} fps" if s['fps'] else '', s['spawn'] or '', f"yükleme {s['load']} sn" if s['load'] else ''] if x)
        who = f"  [{v['who']}]" if v['who'] else ''
        print(f"  #{s['vid']}  {s['start'].astimezone():%d.%m %H:%M}  {v['city']:<12} {v['browser']}/{v['system']:<8} {ac:<12} {dur}"
              + (f'  · {extra}' if extra else '') + who)


if __name__ == '__main__':
    main()
