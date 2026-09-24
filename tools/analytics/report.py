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
browsers "test". Countries come from the free DB-IP Lite database (CC BY 4.0, https://db-ip.com), looked up offline.
"""
import argparse
import bisect
import ipaddress
import datetime as dt
import gzip
import hashlib
import os
import re
import secrets
import statistics
import sys
from zoneinfo import ZoneInfo
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
IST = ZoneInfo('Europe/Istanbul')   # the game's day (daily mission) and the retention days
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
    if 'twitter' in u:
        browser = 'X uygulaması'
    elif 'instagram' in u:
        browser = 'Instagram uygulaması'
    elif 'fban' in u or 'fbav' in u:
        browser = 'Facebook uygulaması'
    else:
        browser = None
    browser = browser or ('Edge' if 'edg/' in u else 'Opera' if 'opr/' in u else 'Firefox' if 'firefox/' in u
               else 'Chrome' if 'chrome/' in u or 'crios/' in u else 'Safari' if 'safari/' in u else 'diğer')
    system = ('iOS' if 'iphone' in u or 'ipad' in u else 'Android' if 'android' in u else 'Windows' if 'windows' in u
              else 'macOS' if 'mac os x' in u else 'ChromeOS' if 'cros' in u else 'Linux' if 'linux' in u else 'diğer')
    return browser, system


COUNTRIES = {'TR': 'Türkiye', 'US': 'ABD', 'GB': 'Birleşik Krallık', 'DE': 'Almanya', 'NL': 'Hollanda', 'FR': 'Fransa',
             'IT': 'İtalya', 'AT': 'Avusturya', 'GR': 'Yunanistan', 'BG': 'Bulgaristan', 'RO': 'Romanya', 'AZ': 'Azerbaycan',
             'CY': 'Kıbrıs', 'ES': 'İspanya', 'CH': 'İsviçre', 'BE': 'Belçika', 'SE': 'İsveç', 'CA': 'Kanada', 'RU': 'Rusya',
             'UA': 'Ukrayna', 'PL': 'Polonya', 'IE': 'İrlanda', 'DK': 'Danimarka', 'NO': 'Norveç', 'FI': 'Finlandiya'}


class Geo:
    """IP → country from the free DB-IP Lite database (CC BY 4.0), downloaded once a month into data/analytics/geo/."""
    def __init__(self):
        import requests
        folder = ROOT / 'data' / 'analytics' / 'geo'
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / 'dbip-country-lite.csv.gz'
        if not path.exists() or dt.datetime.now().timestamp() - path.stat().st_mtime > 35 * 86400:
            for months_back in (0, 1):
                d = dt.date.today().replace(day=1) - dt.timedelta(days=28 * months_back)
                r = requests.get(f'https://download.db-ip.com/free/dbip-country-lite-{d:%Y-%m}.csv.gz', timeout=60)
                if r.ok:
                    path.write_bytes(r.content)
                    break
        self.v4, self.v6 = ([], []), ([], [])
        with gzip.open(path, 'rt') as f:
            for line in f:
                a, b, cc = line.strip().split(',')
                t = self.v6 if ':' in a else self.v4
                t[0].append(int(ipaddress.ip_address(a)))
                t[1].append((int(ipaddress.ip_address(b)), cc))

    def country(self, ip):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return '?'
        starts, ends = self.v6 if addr.version == 6 else self.v4
        i = bisect.bisect_right(starts, int(addr)) - 1
        if i >= 0 and int(addr) <= ends[i][0]:
            return COUNTRIES.get(ends[i][1], ends[i][1])
        return '?'


def edge_city(code):
    return EDGES.get(code[:3], code[:3] or '?')


def query(row):
    q = row.get('cs-uri-query', '-')
    if q in ('-', ''):
        return {}
    if '%25' in q:            # CloudFront re-encodes '%' in logged query strings
        q = unquote(q)
    return {k: v[-1] for k, v in parse_qs(q).items()}


def num(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def pct(a, b):
    return f'%{100 * a / b:.0f}' if b else '-'


def real_events(beacons, visitors, types):
    """[(at, visitor, session id, event)] of the given beacon types, players only (not "sen"/"test"), oldest first."""
    out = [(at, vid, sid, q) for sid, evs in beacons.items() for at, q, vid in evs
           if q.get('t') in types and not visitors[vid]['who']]
    return sorted(out, key=lambda e: e[0])


def is_daily(q):
    """src/missions/runtime.js sends d=1 on daily runs (the day is the Istanbul day of the beacon)."""
    return q.get('d') == '1' or bool(q.get('daily') or q.get('day'))


def report_missions(beacons, visitors, top):
    """§12 `mission` beacons: id, st = start|done|fail|quit, stars, score, sec (+ the daily marker)."""
    evs = real_events(beacons, visitors, {'mission'})
    if not evs:
        print('\nGörevler: henüz görev sinyali yok.')
        return
    per = defaultdict(lambda: {'start': 0, 'done': 0, 'fail': 0, 'quit': 0, 'stars': Counter(), 'sec': [], 'score': [], 'players': set()})
    for _, vid, _, q in evs:
        m = per[q.get('id') or '?']
        st = q.get('st', '')
        if st in ('start', 'done', 'fail', 'quit'):
            m[st] += 1
        if st == 'start':
            m['players'].add(vid)
        if st == 'done':
            if q.get('stars', '').isdigit():
                m['stars'][int(q['stars'])] += 1
            if num(q.get('sec')) is not None:
                m['sec'].append(num(q.get('sec')))
            if num(q.get('score')) is not None:
                m['score'].append(num(q.get('score')))
    starts = sum(m['start'] for m in per.values())
    done = sum(m['done'] for m in per.values())
    players = set().union(*(m['players'] for m in per.values()))
    print(f'\nGörevler: {len(players)} oyuncu · {starts} başlangıç · {done} tamamlanan ({pct(done, starts)}) · '
          f"başarısız {sum(m['fail'] for m in per.values())} · bırakılan {sum(m['quit'] for m in per.values())}")
    print(f"  {'görev':<22} {'oyuncu':>6} {'başla':>6} {'bitir':>6} {'başarısız':>9} {'bırak':>6} {'yarım':>6}  {'yıldız 0/1/2/3':<15} {'ort. süre':>9}  puan (medyan / en iyi)")
    for mid, m in sorted(per.items(), key=lambda kv: -kv[1]['start']):
        open_ = max(0, m['start'] - m['done'] - m['fail'] - m['quit'])   # page closed / menu without an end beacon
        stars = '/'.join(str(m['stars'][k]) for k in range(4))
        sec = fmt_sec(statistics.mean(m['sec'])) if m['sec'] else '-'
        score = f"{statistics.median(m['score']):.0f} / {max(m['score']):.0f}" if m['score'] else '-'
        print(f"  {mid[:22]:<22} {len(m['players']):>6} {m['start']:>6} {m['done']:>6} {m['fail']:>9} {m['quit']:>6} {open_:>6}  {stars:<15} {sec:>9}  {score}")

    daily = [(at, vid, q) for at, vid, _, q in evs if is_daily(q)]
    if daily:
        by_day = defaultdict(lambda: {'players': set(), 'done': set()})
        for at, vid, q in daily:
            d = next((x for x in (q.get('day'), q.get('daily')) if x and re.fullmatch(r'\d{8}', x)), at.astimezone(IST).strftime('%Y%m%d'))
            if q.get('st') == 'start':
                by_day[d]['players'].add(vid)
            if q.get('st') == 'done':
                by_day[d]['done'].add(vid)
        return by_day
    print('  Günlük görev: henüz sinyal yok.')
    return None


def report_daily(by_day, days_seen, visitors):
    """Daily-mission participation: players of each day's mission / all players seen that day."""
    if not by_day:
        return
    active = defaultdict(set)
    for vid, days in days_seen.items():
        if not visitors[vid]['who']:
            for d in days:
                active[d.strftime('%Y%m%d')].add(vid)
    print('Günlük görev katılımı (gün: oynayan / o gün gelen tekil ziyaretçi · bitiren):')
    print('  ' + ' · '.join(f"{d[6:]}.{d[4:6]}: {len(v['players'])}/{len(active.get(d, ()))} ({pct(len(v['players']), len(active.get(d, ())))})"
                            f" · {len(v['done'])} bitti" for d, v in sorted(by_day.items())[-14:]))


def fmt_sec(s):
    return f'{int(s // 60)}:{int(s % 60):02d}'


def report_landings(beacons, visitors, top):
    """`land` beacons: stars (st) and sink rate (fpm; older builds only send vs in m/s)."""
    lands = [q for *_, q in real_events(beacons, visitors, {'land'})]
    if not lands:
        return
    fpm = []
    for q in lands:
        f = num(q.get('fpm'))
        if f is None and num(q.get('vs')) is not None:
            f = abs(num(q.get('vs'))) * 196.85
        if f is not None:
            fpm.append(abs(f))
    stars = Counter(int(q['st']) for q in lands if q.get('st', '').isdigit())
    edges = [(0, 120, '<120'), (120, 240, '120-240'), (240, 360, '240-360'), (360, 600, '360-600'), (600, 1e9, '600+')]
    dist = ' · '.join(f'{label} {sum(1 for f in fpm if lo <= f < hi)}' for lo, hi, label in edges)
    runway = sum(1 for q in lands if q.get('rw') == '1')
    print(f'\nİnişler: {len(lands)} (pistte {runway}, {pct(runway, len(lands))})')
    if stars:
        print(f"  Yıldız (puanlanan {sum(stars.values())}): " + ' · '.join(f'{k}★ {stars[k]}' for k in (3, 2, 1, 0)))
    if fpm:
        print(f'  Dikey hız ft/dk (medyan {statistics.median(fpm):.0f}): {dist}')
    cl = [abs(num(q['cl'])) for q in lands if num(q.get('cl')) is not None]
    tdz = [num(q['tdz']) for q in lands if num(q.get('tdz')) is not None]
    parts = ([f'merkez hattından sapma medyan {statistics.median(cl):.1f} m'] if cl else []) + \
        ([f'eşikten temas noktası medyan {statistics.median(tdz):.0f} m'] if tdz else [])
    if parts:
        print('  ' + ' · '.join(parts).capitalize())


def report_shares(beacons, visitors, top):
    shares = real_events(beacons, visitors, {'share'})
    if shares:
        sessions = {sid for _, _, sid, _ in shares}
        print(f"\nPaylaşım: {len(shares)} ({len(sessions)} oturum) · kanal: {top(Counter(q.get('via') or '?' for *_, q in shares), 6)}"
              f" · görev: {top(Counter(q.get('id') or '?' for *_, q in shares), 6)}")


def report_failures(beacons, visitors, top):
    """Failure beacons from the flight models' failure system (kind, on, random), and crashes that followed one."""
    evs = real_events(beacons, visitors, {'failure', 'fl', 'flr'})
    starts = [(at, sid, q) for at, _, sid, q in evs if q.get('on', '1') in ('1', 'true')]
    if not starts:
        return
    kind = Counter(q.get('kind') or q.get('k') or '?' for *_, q in starts)
    rnd = sum(1 for *_, q in starts if q.get('random') in ('1', 'true') or q.get('rnd') == '1')
    crashes = defaultdict(list)
    for at, _, sid, _ in real_events(beacons, visitors, {'crash'}):
        crashes[sid].append(at)
    after = sum(1 for at, sid, _ in starts if any(c >= at for c in crashes.get(sid, [])))
    print(f'\nArızalar: {len(starts)} ({rnd} rastgele) · türler: {top(kind, 8)} · ardından kaza: {after} ({pct(after, len(starts))})')


def report_leaderboard(api, api_time, api_own, top):
    if not api and not api_own:
        return
    post = Counter({s: c for (m, p, s), c in api.items() if m == 'POST' and p == '/api/score'})
    gets = sum(c for (m, p, s), c in api.items() if m == 'GET' and p == '/api/top')
    hits = len(api_time.get('GET hit', []))
    print(f"\nLider tablosu: gönderilen skor {post.get('200', 0)} kabul · geçersiz {post.get('400', 0)} · "
          f"sınır (429) {post.get('429', 0)} · diğer {sum(c for s, c in post.items() if s not in ('200', '400', '429'))} · "
          f'tablo görüntüleme {gets} (önbellekten {pct(hits, gets)})'
          + (f" · sen/test: {api_own['/api/score']} gönderim, {api_own['/api/top']} görüntüleme (sayılmadı)" if api_own else ''))
    t = ' · '.join(f'{k} {statistics.median(v) * 1000:.0f} ms' for k, v in sorted(api_time.items()) if v)
    if t:
        print(f'  CloudFront yanıt süresi (medyan): {t}')


def report_retention(days_seen, visitors, beacons, since, target):
    """D1 / D7 return rates of first-time visitors (salted IP + browser hash), overall and for mission players."""
    real = {v: d for v, d in days_seen.items() if not visitors[v]['who']}
    if not real:
        return
    today = dt.datetime.now(IST).date()
    last = today - dt.timedelta(days=1)                       # last complete day
    first_log = since.astimezone(IST).date() + dt.timedelta(days=1)   # the window's first day is partial: no cohort
    first = {v: min(d) for v, d in real.items()}
    played = defaultdict(set)                                 # visitor -> days with a mission start
    daily_played = defaultdict(set)
    for at, vid, _, q in real_events(beacons, visitors, {'mission'}):
        if q.get('st') == 'start':
            played[vid].add(at.astimezone(IST).date())
            if is_daily(q):
                daily_played[vid].add(at.astimezone(IST).date())

    def rate(k, group=None):
        cohort = [v for v, d0 in first.items() if first_log <= d0 and d0 + dt.timedelta(days=k) <= last and (group is None or group(v, d0))]
        back = [v for v in cohort if first[v] + dt.timedelta(days=k) in real[v]]
        return len(back), len(cohort)

    def rolling(k):
        cohort = [v for v, d0 in first.items() if first_log <= d0 and d0 + dt.timedelta(days=k) <= last]
        back = [v for v in cohort if any(first[v] + dt.timedelta(days=i) in real[v] for i in range(1, k + 1))]
        return len(back), len(cohort)

    fmt = lambda r: f'{pct(*r)} ({r[0]}/{r[1]})' if r[1] else 'yeterli kayıt yok'
    print('\nGeri dönüş (ilk kez görülen ziyaretçilerin ertesi gün / 7. gün yeniden gelmesi, İstanbul günleri):')
    print(f'  D1 {fmt(rate(1))} · D7 {fmt(rate(7))} · 7 gün içinde herhangi bir gün {fmt(rolling(7))}')
    y = [v for v, d0 in first.items() if d0 == last and first_log <= d0]
    if y:   # yesterday's newcomers seen again today so far (today is not over: a lower bound of D1)
        print(f'  Dün ilk kez gelenlerden bugün şu ana kadar dönen: {pct(sum(1 for v in y if today in real[v]), len(y))} '
              f'({sum(1 for v in y if today in real[v])}/{len(y)})')
    if played:
        mission_day1 = lambda v, d0: d0 in played.get(v, ())
        print(f'  İlk gün görev oynayan: D1 {fmt(rate(1, mission_day1))} · D7 {fmt(rate(7, mission_day1))}  |  '
              f'oynamayan: D1 {fmt(rate(1, lambda v, d0: not mission_day1(v, d0)))} · D7 {fmt(rate(7, lambda v, d0: not mission_day1(v, d0)))}')
    if daily_played:
        daily_day1 = lambda v, d0: d0 in daily_played.get(v, ())
        print(f'  İlk gün günlük görevi oynayan: D1 {fmt(rate(1, daily_day1))} · D7 {fmt(rate(7, daily_day1))}')
    per_day = Counter(d for days in real.values() for d in days)
    new_day = Counter(first.values())
    print('  Gün (tekil / yeni):', ' · '.join(f'{d:%d.%m} {per_day[d]}/{new_day[d]}' for d in sorted(per_day)[-14:]))
    print('  Sınırlar: ziyaretçi = IP + tarayıcının tuzlu özeti. IP değişince (mobil ağ, modem yeniden bağlanınca) veya tarayıcı\n'
          '  güncellenince aynı kişi yeni sayılır (geri dönüş düşük çıkar); aynı IP ve tarayıcıyı paylaşanlar (ev, okul, operatör\n'
          '  NAT\'ı) tek kişi sayılır (yüksek çıkar). Kayıtlar 30 gün tutulur: pencereden önce gelmiş biri "yeni" görünebilir;\n'
          f'  D7 için en az 9 günlük kayıt gerekir (--days 30).{" Canlıda tarayıcı / Cloudflare önbelleği yalnızca dosya isteği atan (sinyali kapalı) ziyaretçileri gizleyebilir." if target == "production" else ""}\n'
          '  Görev oynayanlarla oynamayanların farkı bir ilişkidir, neden-sonuç değil (görev oynayanlar zaten daha ilgili olabilir).')


def fmt_min(m):
    return f'{m:.0f} dk' if m >= 10 else f'{m:.1f} dk'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', nargs='?', default='production', choices=['production', 'staging'])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--sessions', type=int, default=25, help='how many sessions to list (newest first)')
    ap.add_argument('--no-sync', action='store_true', help='use the already downloaded logs')
    ap.add_argument('--logs', type=Path, help='read the .gz logs from this folder instead (implies --no-sync)')
    a = ap.parse_args()

    profile = os.environ.get('AWS_PROFILE_ANALYTICS', 'gokyuzu-analytics')
    folder = a.logs or ROOT / 'data' / 'analytics' / a.target
    if not a.no_sync and not a.logs:
        folder, new = sync(a.target, profile)
        print(f'{new} yeni kayıt dosyası indirildi.', file=sys.stderr)
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)
    key_salt, mine = salt(), own_ips()
    geo = Geo()

    beacons = defaultdict(list)          # sid -> [(at, event dict, visitor)]
    orphans = []                         # tutorial beacons of old builds whose session id was overwritten
    requests = defaultdict(list)         # visitor -> [(at, uri)]
    visitors = {}                        # visitor -> {browser, system, city, who}
    days_seen = defaultdict(set)         # visitor -> Istanbul days with any request (retention)
    api = Counter()                      # leaderboard API (players only): (method, path, status) -> requests
    api_time = defaultdict(list)         # 'POST' / 'GET hit' / 'GET miss' -> CloudFront time-taken (s)
    api_own = Counter()                  # leaderboard requests of "sen" / test browsers (staging checks)
    blocked = Counter()
    for row in read_logs(folder, since):
        ua = unquote(row.get('cs(User-Agent)', '-'))
        if any(w in ua.lower() for w in BOT_WORDS):
            continue
        status = row.get('sc-status', '0')
        uri = row.get('cs-uri-stem', '')
        # behind the Cloudflare proxy c-ip is a Cloudflare address; the player is the first X-Forwarded-For entry
        xff = unquote(row.get('x-forwarded-for', '-'))
        ip = xff.split(',')[0].strip() if xff not in ('-', '') else row.get('c-ip', '')
        if uri.startswith('/api/'):     # leaderboard: every status counts (400 invalid, 429 rate-limited, …)
            if uri in ('/api/score', '/api/top') and (ip in mine or 'headless' in ua.lower()):
                api_own[uri] += 1
            elif uri in ('/api/score', '/api/top'):
                method = 'POST' if row.get('cs-method') == 'POST' else 'GET'
                api[(method, uri, status)] += 1
                hit = row.get('x-edge-result-type') in ('Hit', 'RefreshHit')
                try:
                    api_time['POST' if method == 'POST' else 'GET hit' if hit else 'GET miss'].append(float(row.get('time-taken') or 0))
                except ValueError:
                    pass
            continue
        if status == '403':   # staging: IP lock; production: a missing file (S3 answers 403 for unknown keys)
            blocked[(uri or '?') if a.target == 'production' else edge_city(row.get('x-edge-location', ''))] += 1
            continue
        if not status.startswith(('2', '3')):
            continue
        vid = hashlib.sha256(f'{key_salt}|{ip}|{ua}'.encode()).hexdigest()[:6]
        browser, system = client(ua)
        who = 'sen' if ip in mine else 'test' if browser == 'test' else ''
        if vid not in visitors:
            visitors[vid] = {'browser': browser, 'system': system, 'city': geo.country(ip), 'who': who}
        days_seen[vid].add(row['at'].astimezone(IST).date())
        if uri == '/_e':
            q = query(row)
            if q.get('t') == 'tut' and re.fullmatch(r'\d+(\.\d+)?', q.get('s', '')):
                # builds before the fix sent the step seconds as `s`, overwriting the session id: re-attach later
                q['sec'] = q['s']
                orphans.append((row['at'], q, vid))
            elif q.get('s'):
                beacons[q['s']].append((row['at'], q, vid))
        else:
            requests[vid].append((row['at'], uri))

    # orphaned tutorial beacons → the same visitor's session that was running at that moment
    starts = defaultdict(list)           # visitor -> [(first beacon time, sid)]
    for sid, evs in beacons.items():
        starts[evs[0][2]].append((min(e[0] for e in evs), sid))
    for at, q, vid in orphans:
        cands = [(t, sid) for t, sid in starts.get(vid, []) if t <= at]
        if cands:
            beacons[max(cands)[1]].append((at, q, vid))

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
        kinds = [q.get('t') for _, q, _ in evs]
        tut = [q for _, q, _ in evs if q.get('t') == 'tut']
        sessions.append({
            'took_off': 'takeoff' in kinds, 'landings': kinds.count('land'),
            'runway_landings': sum(1 for _, q, _ in evs if q.get('t') == 'land' and q.get('rw') == '1'),
            'crashes': [q.get('r') or q.get('d') or '?' for _, q, _ in evs if q.get('t') == 'crash'],
            'tut_steps': [(q.get('sc'), q.get('st'), q.get('sec'), q.get('x')) for q in tut],
            'dead': [q for _, q, _ in evs if q.get('t') == 'dead'], 'fail': [q for _, q, _ in evs if q.get('t') == 'fail'],
            'foreign': [q.get('e') for _, q, _ in evs if q.get('t') == 'err' and q.get('x') == 'foreign'],
            'vid': vid, 'start': start, 'minutes': max(minutes, (end - start).total_seconds() / 60), 'active': active,
            'aircraft': fly.get('ac'), 'spawn': fly.get('sp'), 'load': fly.get('lt'), 'fps': round(statistics.mean(fps)) if fps else None,
            'gpu': first.get('gpu'), 'quality': fly.get('q') or first.get('q'), 'version': first.get('v') or fly.get('v'),
            'errors': [q.get('e') for _, q, _ in evs if q.get('t') == 'err' and q.get('x') != 'foreign'], 'exact': True,
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
            sessions.append({'took_off': None, 'landings': 0, 'runway_landings': 0, 'crashes': [], 'tut_steps': [], 'dead': [], 'fail': [], 'foreign': [],
                             'vid': vid, 'start': start, 'minutes': (end - start).total_seconds() / 60, 'active': None,
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
    print('Ülke:', top(Counter(visitors[v]['city'] for v in real_v), 12))
    print('Tarayıcı / sistem:', top(Counter(f"{visitors[v]['browser']}/{visitors[v]['system']}" for v in real_v)))
    fps = [s['fps'] for s in real if s['fps']]
    if fps:
        low = sum(1 for f in fps if f < 40)
        print(f'Performans: ortalama {statistics.mean(fps):.0f} fps · 40 fps altında: {low} oturum')
        print('Ekran kartları:', top(Counter(s['gpu'] for s in real if s['gpu'])))
        print('Kalite ayarı:', top(Counter(s['quality'] for s in real if s['quality'])))
    exact_flights = [s for s in flights if s['exact']]
    if exact_flights:
        up = sum(1 for s in exact_flights if s['took_off'])
        crashes = Counter(c for s in exact_flights for c in s['crashes'])
        print(f"\nOynanış (kesin ölçülen {len(exact_flights)} uçuş): kalkış yapan {up} (%{100 * up / len(exact_flights):.0f}) · "
              f"iniş {sum(s['landings'] for s in exact_flights)} (pistte {sum(s['runway_landings'] for s in exact_flights)}) · "
              f"kaza {sum(crashes.values())}")
        if crashes:
            print('Kaza nedenleri:', top(crashes, 6))
        tut = [t for s in exact_flights for t in s['tut_steps']]
        if tut:
            started = sum(1 for s in exact_flights if s['tut_steps'])
            done = sum(1 for s in exact_flights if any(st == 'done' for _, st, _, _ in s['tut_steps']))
            skipped = sum(1 for s in exact_flights if any(x == 'skip' for _, _, _, x in s['tut_steps']))
            print(f'Eğitim: başlayan {started} · bitiren {done} · geçen {skipped}')
            times = defaultdict(list)
            for sc, st, sec, x in tut:
                if st not in ('done', 'restart') and not x and sec:
                    times[f'{sc}/{st}'].append(float(sec))
            slow = sorted(((statistics.median(v), k, len(v)) for k, v in times.items()), reverse=True)[:5]
            if slow:
                print('En uzun süren adımlar (medyan sn):', ' · '.join(f'{k} {m:.0f} sn ({n})' for m, k, n in slow))
            quit_at = Counter(st for s in exact_flights for sc, st, _, x in s['tut_steps'][-1:] if x in ('skip', 'crash'))
            if quit_at:
                print('Eğitimin bırakıldığı / kaza yapılan adım:', top(quit_at, 5))
    errs = Counter(e for s in real for e in s['errors'])
    if errs:
        print('Hatalar:', top(errs, 5))
    foreign = Counter(e for s in real for e in s['foreign'])
    if foreign:
        print('Başka kaynaklı hatalar (eklenti / uygulama içi tarayıcı):', top(foreign, 3))
    dead = [d for s in real for d in s['dead']]
    if dead:
        print(f"Uçuşta ölen sayfa (sonraki açılışta bildirilen): {len(dead)} · uçuştan sonra medyan {statistics.median(int(d.get('after', 0)) for d in dead):.0f} sn")
    fails = Counter(f.get('ph', '?') + (' (ağ)' if f.get('net') == '1' else '') for s in real for f in s['fail'])
    if fails:
        print('Yükleme hataları:', top(fails, 5))
    if blocked:
        print('Eksik dosya (403):' if a.target == 'production' else 'IP kilidine takılan istek:', top(blocked, 5))

    # wave 7 (§12): missions, daily mission, landing score, shares, failures, leaderboard, retention
    by_day = report_missions(beacons, visitors, top)
    report_daily(by_day, days_seen, visitors)
    report_landings(beacons, visitors, top)
    report_shares(beacons, visitors, top)
    report_failures(beacons, visitors, top)
    report_leaderboard(api, api_time, api_own, top)
    report_retention(days_seen, visitors, beacons, since, a.target)

    print(f'\nSon {min(a.sessions, len(sessions))} oturum (anonim ziyaretçi kimliği · başlangıç · ülke · tarayıcı · uçak · süre):')
    for s in sorted(sessions, key=lambda s: s['start'], reverse=True)[:a.sessions]:
        v = visitors[s['vid']]
        ac = AIRCRAFT.get(s['aircraft'], s['aircraft'] or 'menüde kaldı')
        dur = fmt_min(s['minutes']) + (f" (aktif {s['active']} dk)" if s['active'] else '') + ('' if s['exact'] else ' ~')
        extra = ' · '.join(x for x in [f"{s['fps']} fps" if s['fps'] else '', s['spawn'] or '', f"yükleme {s['load']} sn" if s['load'] else ''] if x)
        who = f"  [{v['who']}]" if v['who'] else ''
        print(f"  #{s['vid']}  {s['start'].astimezone():%d.%m %H:%M}  {v['city']:<16} {v['browser'] + '/' + v['system']:<16} {ac:<12} {dur}"
              + (f'  · {extra}' if extra else '') + who)


if __name__ == '__main__':
    main()
