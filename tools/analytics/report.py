#!/usr/bin/env python3
"""Anonymous usage report for Gökyüzü SF from the CloudFront access logs (CONTRACTS-SF.md §11).

    .venv/bin/python tools/analytics/report.py                    # production, last 7 days
    .venv/bin/python tools/analytics/report.py staging --days 30
    .venv/bin/python tools/analytics/report.py --sessions 50      # longer session list
    .venv/bin/python tools/analytics/report.py --hourly           # hour by hour (Türkiye time) instead of the report
    .venv/bin/python tools/analytics/report.py --hourly --map ist # … only İstanbul flights (beacon columns)

Downloads new log files (profile AWS_PROFILE_ANALYTICS, default "gokyuzu-analytics", read-only on the log bucket
S3_BUCKET_LOGS of the local deploy config ~/.config/gokyuzu/deploy.env, tools/deploy/deploy.env.example) into data/analytics/<target>/
(gitignored; the bucket itself deletes logs after 30 days) and prints players, sessions and minutes played.
Two sources: the game's beacons (/_e, exact: flight start, one heartbeat per active minute, errors) and, for clients
without beacons (versions before telemetry, blocked requests), sessions rebuilt from asset requests (approximate).
Nobody is identified: a visitor is a salted hash of IP + browser (salt in ~/.config/gokyuzu/analytics_salt, never
shared); raw IPs are never printed. Your own IPs (~/.config/gokyuzu/staging_ips) are marked "sen", headless test
browsers "test". Countries come from the free DB-IP Lite database (CC BY 4.0, https://db-ip.com), looked up offline.
Maps (src/maps/index.js): İstanbul beacons carry mp=ist (open / fly / mission / ffc); a session's map is its flight's
(else the page's), minutes and heartbeats follow the session; sessions rebuilt from asset requests go by assets/<map>/.
"Platformlar": per browser / system and per GPU family (the `open` beacon's gpu / dc): reaching a flight, load time,
frame rate against the cap, pixel ratio, dead pages, graphics events; and the visitors whose browser sends no beacon.
"Geri dönen oyuncular": retention from the identifier-free visit fields of `open` (d0 / vn / vd / vo,
src/core/telemetry.js), by cohort day and device. --field KEY lists the values of any beacon field by event type
(e.g. --field as: the assisted-flight flag).
--json PATH (- = stdout) writes the dashboard snapshot instead (stats.erenailab.com, ingest contract v1: cards and the
tables Günlük / Haftalık / Toplam / Saatlik, the same definitions as above); --state PATH keeps a per-day history next
to it so days older than the logs still count (the hourly feed in AWS keeps its own, infra/stats-feed/README.md).
"""
import argparse
import bisect
import ipaddress
import datetime as dt
import gzip
import hashlib
import json
import re
import secrets
import statistics
import sys
from types import SimpleNamespace
from zoneinfo import ZoneInfo
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import parse_qs, unquote

import boto3

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools' / 'deploy'))
import deploy_config  # noqa: E402   (the log bucket is read only when syncing)
CONFIG = Path.home() / '.config' / 'gokyuzu'
SESSION_GAP = dt.timedelta(minutes=15)   # asset requests further apart than this start a new (approximate) session
AIRCRAFT = {'f16': 'F-16', 'f22': 'F-22', 'a320neo': 'A320neo', 'b737': '737-800', 'uh60': 'UH-60M'}
MAPS = {'sf': 'San Francisco', 'ist': 'İstanbul'}   # telemetry `mp` (absent = San Francisco)


def session_map(evs):
    """Map of a beacon session: its flight's `mp`, else the page's (open), else San Francisco."""
    fly = next((q for _, q, _ in evs if q.get('t') == 'fly'), None)
    if fly is not None:
        return fly.get('mp') or 'sf'
    return next((q.get('mp') for _, q, _ in evs if q.get('t') == 'open' and q.get('mp')), 'sf')
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
    bucket = deploy_config.get('S3_BUCKET_LOGS')
    s3 = boto3.Session(profile_name=profile).client('s3')
    have = {p.name for p in local.iterdir()}
    new = 0
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=f'{target}/'):
        for obj in page.get('Contents', []):
            name = obj['Key'].split('/')[-1]
            if name not in have:
                s3.download_file(bucket, obj['Key'], str(local / name))
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


def parse_own_ips(text):
    """The owner's IPs from the staging_ips list (one per line, an optional /prefix is dropped): marked "sen"."""
    return {line.strip().split('/')[0] for line in text.splitlines() if line.strip()}


def own_ips():
    p = CONFIG / 'staging_ips'
    return parse_own_ips(p.read_text()) if p.exists() else set()


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


def people(evs, pred=lambda q: True):
    """Distinct visitors among events [(at, vid, sid, q)] matching pred(q)."""
    return {vid for _, vid, _, q in evs if pred(q)}


def med(values, fmt='{:.0f}'):
    v = [x for x in values if x is not None]
    return fmt.format(statistics.median(v)) if v else '-'


def flyers(beacons, visitors):
    """People who started a flight (the `fly` beacon)."""
    return people(real_events(beacons, visitors, {'fly'}))


def report_missions(beacons, visitors, top):
    """Mission mode (§12, §11): `mission` (brief with via, start, done, fail, quit, retry, next, menu) and `mmenu` (the
    main menu's missions tab: open, daily, detail). People = the report's anonymous visitors, not events."""
    evs = real_events(beacons, visitors, {'mission'})
    menu = real_events(beacons, visitors, {'mmenu'})
    print('\nGörevler (görev modu):')
    if menu:
        opened = people(menu, lambda q: q.get('st') == 'open')
        via = Counter(q.get('via') or '?' for *_, q in menu if q.get('st') == 'open')
        details = Counter(q.get('id') or '?' for *_, q in menu if q.get('st') == 'detail')
        print(f"  Menüde Görevler sekmesini açan: {len(opened)} kişi ({sum(via.values())} kez; {top(via, 3)}) · günlük görev kartına bakan "
              f"{len(people(menu, lambda q: q.get('st') == 'daily'))} kişi · ayrıntısına bakılan görevler: {top(details, 6)}")
    else:
        print('  Menüde Görevler sekmesi: henüz sinyal yok.')
    if not evs:
        print('  Görev sinyali yok.')
        return None
    st = lambda *names: (lambda q: q.get('st') in names)
    print(f"  Brifing gören {len(people(evs, st('brief')))} · başlayan {len(people(evs, st('start')))} · bitiren {len(people(evs, st('done')))} · "
          f"başarısız {len(people(evs, st('fail')))} · bırakan {len(people(evs, st('quit')))} kişi · giriş yolu (kişi): "
          + (' · '.join(f"{k} {len(people(evs, lambda q, k=k: q.get('st') == 'brief' and (q.get('via') or '?') == k))}"
                        for k in ('menu', 'daily', 'link', 'ff', 'next') if people(evs, lambda q, k=k: q.get('st') == 'brief' and q.get('via') == k)) or '-'))
    acts = Counter(q.get('st') for *_, q in evs if q.get('st') in ('retry', 'next', 'menu'))
    if acts:
        print(f"  Kart düğmeleri: tekrar dene {acts['retry']} · sonraki görev {acts['next']} · menü {acts['menu']}")
    ids = sorted({q.get('id') or '?' for *_, q in evs}, key=lambda i: -len(people(evs, lambda q, i=i: q.get('id') == i and q.get('st') == 'start')))
    print(f"  {'görev':<14} {'brifing':>7} {'başla':>6} {'bitir':>6} {'başarısız':>9} {'bırak':>6} {'bitirme':>7} {'yıldız':>6} {'süre':>6}  {'puan (medyan/en iyi)':<20} {'günlük/normal':<13} giriş (menü/günlük/bağlantı/ff/sonraki)")
    for i in ids:
        e = [x for x in evs if (x[3].get('id') or '?') == i]
        started, done = people(e, st('start')), people(e, st('done'))
        dn = [q for *_, q in e if q.get('st') == 'done']
        daily_p = len(people(e, lambda q: q.get('st') == 'start' and is_daily(q)))
        vias = [len(people(e, lambda q, k=k: q.get('st') == 'brief' and q.get('via') == k)) for k in ('menu', 'daily', 'link', 'ff', 'next')]
        score = [num(q.get('score')) for q in dn]
        sc = f"{med(score)} / {max(x for x in score if x is not None):.0f}" if any(x is not None for x in score) else '-'
        secs = [num(q.get('sec')) for q in dn]
        print(f"  {i[:14]:<14} {len(people(e, st('brief'))):>7} {len(started):>6} {len(done):>6} {len(people(e, st('fail'))):>9} {len(people(e, st('quit'))):>6} "
              f"{pct(len(done), len(started)):>7} {med([num(q.get('stars')) for q in dn]):>6} {(fmt_sec(statistics.median([x for x in secs if x is not None])) if any(x is not None for x in secs) else '-'):>6}  "
              f"{sc:<20} {f'{daily_p}/{len(started) - daily_p}':<13} {'/'.join(map(str, vias))}")

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


FFC_NAMES = {'bridge': 'Golden Gate altı', 'lowpass': 'Alçak geçiş', 'baytour': 'Körfez turu', 'climb': 'Dik tırmanış', 'alcatraz': 'Alcatraz pedi',
             'land': 'En iyi iniş', 'eng': 'Motor arızası', 'flameout': 'Alev sönmesi', 'ditch': 'Suya iniş', 'autorot': 'Otorotasyon',
             'lseries': 'İniş serisi', 'dland': 'Günün inişi'}


def report_challenges(beacons, visitors, top):
    """Free-flight challenges (§12.1, §11): `ffp` (panel: open with src, track, untrack, play) and `ffc` (start, done,
    fail, cancel, drop). The bridge and landing entries are instant (done only); the climb starts at every take-off roll
    from a standstill on a runway."""
    panel = real_events(beacons, visitors, {'ffp'})
    evs = real_events(beacons, visitors, {'ffc'})
    print('\nSerbest uçuş görevleri:')
    if not panel and not evs:
        print('  Henüz sinyal yok.')
        return
    flew = flyers(beacons, visitors)
    opened = people(panel, lambda q: q.get('st') == 'open')
    src = Counter(q.get('src') or '?' for *_, q in panel if q.get('st') == 'open')
    plays = [q for *_, q in panel if q.get('st') == 'play']
    via_ff = people(real_events(beacons, visitors, {'mission'}), lambda q: q.get('st') == 'brief' and q.get('via') == 'ff')
    print(f"  Paneli açan: {len(opened)} kişi (uçanların {pct(len(opened & flew) if flew else len(opened), len(flew))}; {sum(src.values())} kez: "
          f"{top(src, 4)}) · takip eden {len(people(panel, lambda q: q.get('st') == 'track'))} kişi · \"Görev olarak oyna\": {len(plays)} tık "
          f"({len(people(panel, lambda q: q.get('st') == 'play'))} kişi; {top(Counter(FFC_NAMES.get(q.get('id'), q.get('id')) for q in plays), 4)}) → görev brifingine gelen {len(via_ff)} kişi")
    if not evs:
        return
    st = lambda name: (lambda q: q.get('st') == name)
    ids = sorted({q.get('id') or '?' for *_, q in evs} | {q.get('id') for *_, q in panel if q.get('st') == 'track' and q.get('id')},
                 key=lambda i: -len(people(evs, lambda q, i=i: q.get('id') == i and q.get('st') in ('start', 'done'))))
    print(f"  {'görev':<16} {'takip':>5} {'başla':>6} {'bitir':>6} {'başarısız':>9} {'vazgeç':>6} {'yarım':>6}  {'puan (medyan/en iyi)':<20} uçak (bitirenler)")
    for i in ids:
        e = [x for x in evs if x[3].get('id') == i]
        dn = [q for *_, q in e if q.get('st') == 'done']
        score = [num(q.get('score')) for q in dn]
        sc = f"{med(score)} / {max(x for x in score if x is not None):.0f}" if any(x is not None for x in score) else '-'
        tracked = people(panel, lambda q, i=i: q.get('st') == 'track' and q.get('id') == i)
        start = '-' if i in ('bridge', 'land') else len(people(e, st('start')))
        print(f"  {FFC_NAMES.get(i, i)[:16]:<16} {len(tracked):>5} {start:>6} {len(people(e, st('done'))):>6} {len(people(e, st('fail'))):>9} "
              f"{len(people(e, st('cancel'))):>6} {len(people(e, st('drop'))):>6}  {sc:<20} {top(Counter(AIRCRAFT.get(q.get('ac'), q.get('ac') or '?') for q in dn), 5)}")
    drops = Counter(q.get('why') or '?' for *_, q in evs if q.get('st') == 'drop')
    if drops:
        print(f"  Yarım kalma nedeni: {top(drops, 4)} (time: süre sınırı · gap: kapılar arası çok uzun · far: çok uzaklaştı · landed: 10.000 ft'ten önce indi)")


def lb_base(b):
    """A leaderboard's base board: the assisted variant (as-<board>, w-<yyyyww>-as-<base>) on the base board's line."""
    return re.sub(r'^(w-\d{6}-)?as-', r'\1', b or '?')


def report_lb(beacons, visitors, top):
    """Leaderboard use in the game (§11 `lb`): tables shown, scores submitted (with or without a nickname; the nickname
    itself is never sent), failed submissions; split into the manual ("Elle") and the assisted ("Destekli", as=1: boards
    as-<board> / w-<yyyyww>-as-<base>) lists; per board (the assisted variant on the base board's line)."""
    evs = real_events(beacons, visitors, {'lb'})
    if not evs:
        print('\nSıralama tablosu: henüz sinyal yok.')
        return
    st = lambda name: (lambda q: q.get('st') == name)
    shown, sub = people(evs, st('show')), people(evs, st('submit'))
    named = people(evs, lambda q: q.get('st') == 'submit' and q.get('nm') == '1')
    ranks = [num(q.get('r')) for *_, q in evs if q.get('st') == 'submit']
    print(f"\nSıralama tablosu: gören {len(shown)} kişi · skor gönderen {len(sub)} kişi (takma adla {len(named)}) · gönderilemeyen "
          f"{sum(1 for *_, q in evs if q.get('st') == 'fail')} · sıra medyanı {med(ranks)} · rekorunu geliştiren "
          f"{sum(1 for *_, q in evs if q.get('st') == 'submit' and q.get('im') == '1')} gönderim")
    for name, pred in (('Elle', lambda q: q.get('as') != '1'), ('Destekli', lambda q: q.get('as') == '1')):
        e = [x for x in evs if pred(x[3])]
        subs = [q for *_, q in e if q.get('st') == 'submit']
        print(f"  {name:<8} görüntüleme {sum(1 for *_, q in e if q.get('st') == 'show')} ({len(people(e, st('show')))} kişi) · gönderim {len(subs)} "
              f"({len(people(e, st('submit')))} kişi) · sıra medyanı {med([num(q.get('r')) for q in subs])}")
    base = lb_base
    boards = Counter(base(q.get('b')) for *_, q in evs if q.get('st') in ('show', 'submit'))
    for b, n in boards.most_common(12):
        e = [x for x in evs if base(x[3].get('b')) == b]
        sub_m = sum(1 for *_, q in e if q.get('st') == 'submit' and q.get('as') != '1')
        sub_a = sum(1 for *_, q in e if q.get('st') == 'submit' and q.get('as') == '1')
        print(f"  {b:<22} görüntüleme {sum(1 for *_, q in e if q.get('st') == 'show')} ({len(people(e, st('show')))} kişi) · gönderim elle {sub_m} / destekli {sub_a} "
              f"({len(people(e, st('submit')))} kişi) · sıra medyanı {med([num(q.get('r')) for *_, q in e if q.get('st') == 'submit'])}"
              + (' · günlük' if any(q.get('d') == '1' for *_, q in e) else ''))


def tried_or_done(beacons, visitors):
    """People who tried (mission start, challenge start / done / fail) and who completed (mission / challenge done); the
    landing entry is left out (every runway landing counts for it)."""
    ev = real_events(beacons, visitors, {'mission', 'ffc'})
    tried = people(ev, lambda q: (q.get('t') == 'mission' and q.get('st') == 'start')
                   or (q.get('t') == 'ffc' and q.get('st') in ('start', 'done', 'fail') and q.get('id') != 'land'))
    done = people(ev, lambda q: q.get('st') == 'done' and (q.get('t') == 'mission' or q.get('id') != 'land'))
    return tried, done


def report_funnel(beacons, visitors):
    flew = flyers(beacons, visitors)
    if not flew:
        return
    opened = people(real_events(beacons, visitors, {'ffp', 'mmenu'}), lambda q: q.get('st') == 'open')
    tried, done = tried_or_done(beacons, visitors)
    f = lambda group: f'{len(group & flew)} ({pct(len(group & flew), len(flew))})'
    print(f"\nHuni (kişi, uçanlara göre): uçan {len(flew)} → görev paneli / menü sekmesi açan {f(opened)} → en az bir görev deneyen {f(tried)} "
          f"→ en az birini bitiren {f(done)}  (görev modu + serbest uçuş; iniş puanı hariç)")


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


# settings beacons (src/ui/settings-live.js): `set` with k = setting, v2 = bucketed value (volumes 0/25/50/75/100, switches
# 1/0, valert 2 all / 1 critical / 0 off); default volume buckets: master .9 → 100, engine / voice 1 → 100, atc / ambient .8 → 75
VOLUME_DEFAULT = {'master': 100, 'engine': 100, 'voice': 100, 'atc': 75, 'ambient': 75}


def volume_lowered(q):
    k = q.get('k')
    return k in VOLUME_DEFAULT and num(q.get('v2')) is not None and num(q.get('v2')) < VOLUME_DEFAULT[k]


SETTING_GROUPS = {   # `set` beacon groups counted in people: report_settings and the feed's "Ayarlar" table
    'mute': ('Sesi kapatan', lambda q: q.get('k') == 'mute' and q.get('v2') == '1'),
    'lower': ('Sesi kısan (varsayılanın altı)', volume_lowered),
    'zero': ('Genel sesi sıfıra çeken', lambda q: q.get('k') == 'master' and q.get('v2') == '0'),
    'assist': ('Destekli uçuşu kapatan', lambda q: q.get('k') == 'assist' and q.get('v2') == '0'),
    'assiston': ('Destekli uçuşu açan', lambda q: q.get('k') == 'assist' and q.get('v2') == '1'),
    'crit': ('Sesli uyarılar: sadece kritik', lambda q: q.get('k') == 'valert' and q.get('v2') == '1'),
    'voff': ('Sesli uyarıları kapatan', lambda q: q.get('k') == 'valert' and q.get('v2') == '0'),
    'chime': ('Uyarı çanını kapatan', lambda q: q.get('k') == 'chime' and q.get('v2') == '0'),
    'hud': ('Ekran uyarılarını kapatan', lambda q: q.get('k') == 'hudwarn' and q.get('v2') == '0'),
    'calm': ('Yanıp sönmeyi azaltan', lambda q: q.get('k') == 'calm' and q.get('v2') == '1'),
}


def report_settings(beacons, visitors, top):
    """How many people mute the sound, lower a volume, turn off assisted flight or the spoken warnings."""
    evs = real_events(beacons, visitors, {'set'})
    if not evs:
        return
    base = len(flyers(beacons, visitors)) or len({vid for _, vid, _, _ in evs})

    def who(group):
        return len(people(evs, SETTING_GROUPS[group][1]))

    muted, lower, zero, assist = who('mute'), who('lower'), who('zero'), who('assist')
    crit, voff, chime, hud, calm = who('crit'), who('voff'), who('chime'), who('hud'), who('calm')
    print(f'\nAyarlar (kişi; uçanların oranı): sesi kapatan {muted} ({pct(muted, base)}) · sesi kısan {lower} ({pct(lower, base)};'
          f' genel sesi sıfıra çeken {zero}) · destekli uçuşu kapatan {assist} ({pct(assist, base)}) · sesli uyarıları kısan'
          f' {crit + voff} ({pct(crit + voff, base)}; sadece kritik {crit}, kapalı {voff}) · uyarı çanı kapalı {chime}'
          f' · ekran uyarıları kapalı {hud} · yanıp sönme azaltılmış {calm}')
    print('  değiştirilen ayarlar (kişi):', top(Counter(k for k, _ in {(q.get('k') or '?', vid) for _, vid, _, q in evs}), 10))


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


def hour_of(at):
    """The Türkiye hour of a UTC time (--hourly rows)."""
    return at.astimezone(IST).replace(minute=0, second=0, microsecond=0)


def release_hours():
    """Git tags release-YYYYMMDD-HHMM (Türkiye time) → {hour: 'HH:MM'} for the --hourly table's last column."""
    import subprocess
    try:
        tags = subprocess.run(['git', '-C', str(ROOT), 'tag', '--list', 'release-*'], capture_output=True, text=True, timeout=10).stdout.split()
    except Exception:
        return {}
    out = {}
    for t in tags:
        m = re.fullmatch(r'release-(\d{8})-(\d{4})', t)
        if m:
            at = dt.datetime.strptime(m[1] + m[2], '%Y%m%d%H%M').replace(tzinfo=IST)
            out[at.replace(minute=0)] = (out.get(at.replace(minute=0), '') + ' ' + f'{at:%H:%M} yayın').strip()
    return out


def report_maps(real, visitors):
    """Per map: people who flew it, flights, minutes (session length) and active minutes (heartbeats)."""
    rows = []
    for m, name in MAPS.items():
        fl = [s for s in real if s['aircraft'] and s['map'] == m]
        if not fl:
            continue
        mins, act = sum(s['minutes'] for s in fl), sum(s['active'] or 0 for s in fl)
        rows.append(f"{name} {len({s['vid'] for s in fl})} kişi · {len(fl)} uçuş · {fmt_min(mins)} (aktif {act} dk)")
    print('Haritalar:', ' | '.join(rows) or '-')


def fps_target(q):
    """Frame rate a heartbeat aims at: its `cap` (frame pacing: 30 on phones, 60 on tablets, the player's setting),
    60 for the display rate (cap 0) and for beacons from before the cap was sent (the old loop drew every refresh)."""
    c = q.get('cap') or ''
    return int(c) if c.isdigit() and int(c) > 0 else 60


def fps_rel(q):
    """Heartbeat fps as a share of its target (1.0 = the cap is held; a phone at 30 of 30 is not slow)."""
    return min(1.0, int(q['fps']) / fps_target(q))


def report_hourly(hours, first_seen, beacons, visitors, requests, only=None):
    """Hour by hour (Türkiye time), players only: visitors, new visitors (first request in the window), players (a flight
    beacon or an aircraft model download), flights, touch flights, active minutes (heartbeats), take-offs, landings
    (runway), crashes, finished tutorials, fps, phone / X-Instagram share, errors, GB, and the missions columns: görev
    (people who started a mission), ffc (people who opened the free-flight panel), tamam (people who completed a mission
    or a challenge; the landing entry left out), ist (people who flew İstanbul). only = a map id: the beacon columns
    count only that map's sessions (visitor / request columns stay for everyone)."""
    k = hourly_counts(beacons, visitors, requests, only)
    c, fps, frel, players, mis, ffc, done, ist = k.c, k.fps, k.frel, k.players, k.mis, k.ffc, k.done, k.ist
    new = Counter(hour_of(t) for t in first_seen.values())
    rel = release_hours()
    print(f"{'saat (TR)':<11}|{'ziyar.':>6}|{'yeni':>5}|{'oyna.':>5}|{'uçuş':>5}|{'dokun.':>6}|{'aktif dk':>8}|{'kalkış':>6}|{'iniş(pist)':>10}|{'kaza':>5}|"
          f"{'eğit.bitti':>10}|{'fps':>4}|{'hdf%':>4}|{'tel%':>4}|{'X/IG%':>5}|{'hata':>4}|{'GB':>5}|{'görev':>5}|{'ffc':>4}|{'tamam':>5}|{'ist':>4}| yayın")
    for h in sorted(hours):
        r, k, n = hours[h], c[h], len(hours[h]['vis'])
        f = statistics.mean(fps[h]) if fps[h] else 0
        fr = 100 * statistics.mean(frel[h]) if frel[h] else 0
        print(f"{h:%d.%m %H}:00|{n:6d}|{new[h]:5d}|{len(players[h]):5d}|{k['fly']:5d}|{k['touch']:6d}|{k['hb']:8d}|{k['takeoff']:6d}|"
              f"{k['land']:5d}({k['landrw']:2d})  |{k['crash']:5d}|{k['tutdone']:10d}|{f:4.0f}|{fr:4.0f}|{100 * len(r['phone']) / n:4.0f}|{100 * len(r['iab']) / n:5.0f}|"
              f"{k['err']:4d}|{r['bytes'] / 1e9:5.1f}|{len(mis[h]):5d}|{len(ffc[h]):4d}|{len(done[h]):5d}|{len(ist[h]):4d}| {rel.get(h, '')}")
    tot = set().union(*(r['vis'] for r in hours.values())) if hours else set()
    print(f"Toplam tekil ziyaretçi {len(tot)} · görev başlatan {len(set().union(*mis.values())) if mis else 0} · paneli açan "
          f"{len(set().union(*ffc.values())) if ffc else 0} · bitiren {len(set().union(*done.values())) if done else 0} · İstanbul'da uçan "
          f"{len(set().union(*ist.values())) if ist else 0} kişi" + (f' · yalnız {MAPS.get(only, only)} uçuşları' if only else '')
          + ' (saatler Türkiye saati; kişiler anonim ziyaretçi kimliği; sen/test ve botlar hariç)')


def hourly_counts(beacons, visitors, requests, only=None):
    """The beacon / request columns of --hourly per Türkiye hour (report_hourly and the feed's "Saatlik" table)."""
    c = defaultdict(Counter)
    fps, frel = defaultdict(list), defaultdict(list)   # frel: fps as a share of the flight cap
    players, mis, ffc, done, ist = (defaultdict(set) for _ in range(5))
    for evs in beacons.values():
        m = session_map(evs)
        if only and m != only:
            continue
        for at, q, vid in evs:
            if visitors[vid]['who']:
                continue
            h, t, st = hour_of(at), q.get('t'), q.get('st')
            if t == 'fly':
                c[h]['fly'] += 1
                c[h]['touch'] += q.get('in') == 'touch'
                players[h].add(vid)
                if m == 'ist':
                    ist[h].add(vid)
            elif t == 'hb':
                c[h]['hb'] += 1
                if (q.get('fps') or '').isdigit():
                    fps[h].append(int(q['fps']))
                    frel[h].append(fps_rel(q))
            elif t == 'takeoff':
                c[h]['takeoff'] += 1
            elif t == 'land':
                c[h]['land'] += 1
                c[h]['landrw'] += q.get('rw') == '1'
            elif t == 'crash':
                c[h]['crash'] += 1
            elif t == 'tut' and st == 'done':
                c[h]['tutdone'] += 1
            elif t == 'err' and q.get('x') != 'foreign':
                c[h]['err'] += 1
            elif t == 'mission' and st == 'start':
                mis[h].add(vid)
            elif t == 'ffp' and st == 'open':
                ffc[h].add(vid)
            if st == 'done' and (t == 'mission' or (t == 'ffc' and q.get('id') != 'land')):
                done[h].add(vid)
    for vid, reqs in requests.items():
        if visitors[vid]['who']:
            continue
        hours_of_map = {hour_of(at) for at, uri in reqs if uri.startswith(f'/assets/{only}/')} if only else None
        for at, uri in reqs:
            if uri.startswith('/assets/aircraft/') and uri.endswith('.glb') and not uri.endswith(('_lod.glb', '_cockpit.glb')):
                if hours_of_map is None or hour_of(at) in hours_of_map:
                    players[hour_of(at)].add(vid)
    return SimpleNamespace(c=c, fps=fps, frel=frel, players=players, mis=mis, ffc=ffc, done=done, ist=ist)


def fmt_min(m):
    return f'{m:.0f} dk' if m >= 10 else f'{m:.1f} dk'


def gpu_family(g):
    """GPU family of an `open` beacon's gpu name (src/core/gpu-device.js gpuLabel; builds before 27 Sep 2026 cut Intel /
    AMD APU names to "Intel" / "AMD Radeon" and SwiftShader to "Vulkan 1.3.0")."""
    g = g or ''
    if not g:
        return '?'
    if re.search(r'Basic Render', g, re.I):
        return 'yazılım: MS Basic Render'
    if re.search(r'SwiftShader|^Vulkan 1\.\d', g, re.I):
        return 'yazılım: SwiftShader'
    if re.search(r'llvmpipe|softpipe', g, re.I):
        return 'yazılım: llvmpipe'
    if re.search(r'Apple M\d+ (Pro|Max|Ultra)', g):
        return 'Apple M Pro/Max/Ultra'
    if re.search(r'Apple M\d', g):
        return 'Apple M'
    if g.startswith('Apple GPU'):
        return 'Apple GPU (Safari)'
    for k in ('Adreno', 'Mali', 'Xclipse', 'PowerVR'):
        if k.lower() in g.lower():
            return k
    if re.search(r'NVIDIA|GeForce|Quadro|RTX', g, re.I):
        if re.search(r'\bGTS? \d{3,4}\b|GTX [4-7]\d\d\b|Quadro (K\d|FX|NVS)|MX ?[1-3]\d\d|\b[89]\d0MX?\b', g):
            return 'NVIDIA eski / giriş'
        if re.search(r'RTX', g):
            return 'NVIDIA RTX'
        return 'NVIDIA GTX / MX / Quadro'
    if 'Intel' in g:
        if 'Arc' in g:
            return 'Intel Arc'
        if 'Iris' in g:
            return 'Intel Iris'
        return 'Intel UHD / HD' if re.search(r'UHD|HD', g) else 'Intel (modelsiz, eski sürüm)'
    if re.search(r'Radeon', g, re.I):
        if re.search(r'RX|Pro|R9', g):
            return 'AMD Radeon RX'
        return 'AMD APU (tümleşik)'
    return 'diğer'


def pctile(values, p):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    k = (len(v) - 1) * p
    f = int(k)
    c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)


def page_sessions(beacons, visitors):
    """Beacon sessions of players that sent `open`: [(visitor, platform, open, fly, heartbeats, events)]."""
    out = []
    for sid, evs in beacons.items():
        vid = evs[0][2]
        if visitors[vid]['who']:
            continue
        first = next((q for _, q, _ in evs if q.get('t') == 'open'), None)
        if first is None:
            continue
        v = visitors[vid]
        fly = next((q for _, q, _ in evs if q.get('t') == 'fly'), None)
        hbs = [q for _, q, _ in evs if q.get('t') == 'hb' and (q.get('fps') or '').isdigit()]
        out.append((vid, f"{v['browser']}/{v['system']}", first, fly, hbs, [q for _, q, _ in evs]))
    return out


def report_platforms(beacons, visitors, requests, min_n=10):
    """Per browser / system and per system · GPU family (players, pages with `open`): uçuşa geçen (share of pages with a
    flight), yükleme p50 / p90 (fly lt, s), hedef % (heartbeat fps as a share of its cap, mean) and <%80 (share of active
    minutes below 80 % of the cap), çözünürlük (pixel ratio p50: dynamic resolution at its 0.6 floor = the GPU cannot keep
    up), ölü (dead pages reported by the next page of the tab), gfx (context lost / budget step events), hata (own errors).
    Then the visitors whose browser loaded the page but sent no beacon (Do Not Track / GPC, blockers, very quick exits)."""
    rows = page_sessions(beacons, visitors)
    if not rows:
        return
    by_sid_dead = Counter()
    for evs in beacons.values():
        for _, q, vid in evs:
            if q.get('t') == 'dead' and not visitors[vid]['who']:
                by_sid_dead[f"{visitors[vid]['browser']}/{visitors[vid]['system']}"] += 1

    def table(title, key, dead_by=None):
        groups = defaultdict(list)
        for r in rows:
            groups[key(r)].append(r)
        print(f'\n{title}')
        print(f"  {'':<34}{'sayfa':>6}{'uçuş%':>6}{'yük.p50':>8}{'p90':>6}{'hedef%':>7}{'<%80':>6}{'çöz.':>6}{'ölü':>5}{'gfx':>5}{'hata':>5}  kalite (açılış)")
        for k, g in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            if len(g) < min_n:
                continue
            flew = [r for r in g if r[3]]
            lts = [num(r[3].get('lt')) for r in flew]
            hbs = [q for r in g for q in r[4]]
            rel = [fps_rel(q) for q in hbs]
            prs = [num(q.get('pr')) for q in hbs]
            gfx = sum(1 for r in g for q in r[5] if q.get('t') == 'gfx' and q.get('ev') in ('lost', 'budget', 'render'))
            err = sum(1 for r in g for q in r[5] if q.get('t') == 'err' and q.get('x') != 'foreign')
            dead = dead_by[k] if dead_by is not None else sum(1 for r in g for q in r[5] if q.get('t') == 'dead')
            qs = Counter(r[2].get('q') or '?' for r in g)
            f = lambda x, d=1: '-' if x is None else f'{x:.{d}f}'
            print(f"  {str(k)[:33]:<34}{len(g):>6}{100 * len(flew) / len(g):>6.0f}{f(pctile(lts, .5)):>8}{f(pctile(lts, .9)):>6}"
                  f"{f(100 * statistics.mean(rel) if rel else None, 0):>7}{f(100 * sum(1 for x in rel if x < 0.8) / len(rel) if rel else None, 0):>6}"
                  f"{f(pctile(prs, .5), 2):>6}{dead:>5}{gfx:>5}{err:>5}  {' '.join(f'{a} {b}' for a, b in qs.most_common(4))}")

    print('\nPlatformlar (oyuncu sayfaları; en az %d sayfalık gruplar):' % min_n)
    table('Tarayıcı / sistem:', lambda r: r[1], by_sid_dead)
    table('Sistem · ekran kartı ailesi:', lambda r: f"{r[1].split('/')[-1]} · {gpu_family(r[2].get('gpu'))}")
    dcs = Counter(r[2].get('dc') for r in rows if r[2].get('dc'))
    if dcs:
        tiers = Counter(d.split('/')[-1] for d in dcs.elements())
        mq = Counter(r[2].get('mq') for r in rows if r[2].get('mq'))
        print(f"  Cihaz sınıfı (dc, yeni sürümler): {' · '.join(f'{k} {v}' for k, v in tiers.most_common(10))}  |  kalite neden (mq): "
              f"{' · '.join(f'{k} {v}' for k, v in mq.most_common(6))}")
    sw = [r for r in rows if gpu_family(r[2].get('gpu')).startswith('yazılım')]
    if sw:
        act = [max([int(q.get('a', 0) or 0) for q in r[5] if (q.get('a') or '').isdigit()] + [0]) for r in sw if r[3]]
        print(f"  Yazılımla çizen sayfalar: {len(sw)} ({len({r[0] for r in sw})} kişi; {pct(len(sw), len(rows))} tüm sayfaların) · "
              f"aktif dk medyanı {med(act)} · bildirim gösterilen {sum(1 for r in sw for q in r[5] if q.get('t') == 'gfx' and q.get('ev') == 'sw')}")
    # visitors who loaded the page (/) after the first beacon but never sent one
    if beacons:
        t_first = min(e[0] for evs in beacons.values() for e in evs)
        with_beacon = {evs[0][2] for evs in beacons.values()}
        loaded = {vid for vid, reqs in requests.items() if not visitors[vid]['who'] and any(u == '/' and at >= t_first for at, u in reqs)}
        loaded |= {vid for vid in with_beacon if not visitors[vid]['who']}
        silent = Counter(f"{visitors[v]['browser']}/{visitors[v]['system']}" for v in loaded if v not in with_beacon)
        total = Counter(f"{visitors[v]['browser']}/{visitors[v]['system']}" for v in loaded)
        print('  Sinyal göndermeyen ziyaretçi (sayfayı açtı, hiç sinyal yok: DNT / GPC, engelleyici, hemen çıkış): '
              + ' · '.join(f'{k} {pct(silent[k], n)} ({silent[k]}/{n})' for k, n in total.most_common(8)))


def report_mobile(beacons, visitors, top):
    """Phones in social-app webviews and the way out (src/ui/touch-gate.js, src/ui/touch-env.js): pages opened inside an
    app's webview (`open` iab) and the share that flew, the "Tarayıcıda aç" banner (`iab`: show, chrome, copy, close),
    the pages that arrived in a real browser from a webview (`open` hf, marked in the webview's address) and the share of
    them that flew; then the touch screens' pointer media queries (`open` ptr: c / f / n = primary coarse / fine / none,
    F = a fine pointer listed, h = hover) and how many of those pages started with the touch controls (`in`)."""
    rows = page_sessions(beacons, visitors)
    inapp, arrived, ptr = defaultdict(list), defaultdict(list), defaultdict(Counter)
    for vid, plat, first, fly, hbs, evs in rows:
        if first.get('iab'):
            inapp[f"{first['iab']}/{plat.split('/')[-1]}"].append((vid, bool(fly)))
        if first.get('hf'):
            arrived[f"{first['hf']} → {plat}"].append((vid, bool(fly)))
        if first.get('ptr'):
            ptr[plat][(first['ptr'], first.get('in') or '?')] += 1
    ev = real_events(beacons, visitors, {'iab'})
    if not (inapp or arrived or ev or ptr):
        return
    fmt = lambda g: ' · '.join(f"{k} {len(v)} sayfa ({len({x[0] for x in v})} kişi), uçan %{100 * sum(1 for x in v if x[1]) / len(v):.0f}"
                               for k, v in sorted(g.items(), key=lambda kv: -len(kv[1])))
    print('\nUygulama içi tarayıcı (sosyal uygulamaların webview\'i):')
    if inapp:
        print(f'  Webview\'de açılan: {fmt(inapp)}')
    if ev:
        acts = Counter(q.get('st') or q.get('x') or '?' for *_, q in ev)
        print(f"  \"Tarayıcıda aç\" bandı (olay): {top(acts, 6)} · kişi: gören {len(people(ev, lambda q: q.get('st') == 'show'))}, "
              f"dokunan {len(people(ev, lambda q: q.get('x') in ('browser', 'chrome', 'copy')))}")
    print(f"  Webview'den tarayıcıya geçen (hf): {fmt(arrived) if arrived else '-'}")
    for plat, c in sorted(ptr.items(), key=lambda kv: -sum(kv[1].values()))[:8]:
        print(f"  Dokunmatik ekran {plat}: ptr/in {top(Counter({f'{a}/{b}': n for (a, b), n in c.items()}), 6)}")


def device_kind(q, v):
    dc = (q.get('dc') or '').split('/')[0]
    if dc in ('phone', 'tablet', 'desktop'):
        return {'phone': 'telefon', 'tablet': 'tablet', 'desktop': 'masaüstü'}[dc]
    return 'telefon' if v['system'] in ('iOS', 'Android') else 'masaüstü'


VISIT_KINDS = ('masaüstü', 'telefon', 'tablet')


def visit_firsts(beacons, visitors):
    """The first pages of a day that carry the visit fields: [(Türkiye day, open beacon, device kind)], players only."""
    firsts = []
    for evs in beacons.values():
        for at, q, vid in evs:
            if q.get('t') == 'open' and q.get('vd') == '1' and q.get('d0') and not visitors[vid]['who']:
                firsts.append((at.astimezone(IST).date(), q, device_kind(q, visitors[vid])))
    return firsts


def visit_cohorts(firsts):
    """Cohort counts of report_visit_retention: new (d0=0), back {1: D1, 7: D7} and within (first return in 7 days), each
    cohort day -> device -> browsers. Additive over beacon days (the feed sums them per day)."""
    new = defaultdict(Counter)                        # cohort day -> device -> new browsers
    back = {k: defaultdict(Counter) for k in (1, 7)}  # D1 / D7: cohort day -> device -> returned that day
    within = defaultdict(Counter)                     # first return within 7 days
    for day, q, kind in firsts:
        if q.get('vo') == '1' or not q['d0'].isdigit():
            continue
        d0 = int(q['d0'])
        cohort = day - dt.timedelta(days=d0)
        if d0 == 0:
            new[cohort][kind] += 1
        if d0 in back:
            back[d0][cohort][kind] += 1
        if q.get('vn') == '2' and 1 <= d0 <= 7:
            within[cohort][kind] += 1
    return new, back, within


def report_visit_retention(beacons, visitors):
    """Returning players without any identifier (src/core/telemetry.js, CONTRACTS-SF.md §11): every `open` carries d0 (days
    since this browser's first visit; exact to 14), vn (visit days incl. today), vd=1 on the first page of a day and vo=1
    for browsers that played before the counter existed. A cohort = the browsers whose first page (d0=0, vd=1) fell on a
    day (Türkiye day of the beacon); D1 = those with a first-page-of-the-day beacon at d0=1, D7 at d0=7, "7 gün içinde" =
    first return (vn=2) within d0 1..7. Each browser counts once per day; nobody is identified."""
    firsts = visit_firsts(beacons, visitors)
    print('\nGeri dönen oyuncular (kimliksiz sayaç: tarayıcıdaki ilk ziyaret günü, sadece günlük ilk sayfa):')
    if not firsts:
        print('  Henüz sinyal yok (d0 / vn alanları 27 Eylül 2026 sonrası sürümlerde).')
        return
    today = dt.datetime.now(IST).date()
    last = today - dt.timedelta(days=1)
    kinds = VISIT_KINDS
    new, back, within = visit_cohorts(firsts)

    def rate(num_, den, ok):
        return f'{pct(num_, den)} ({num_}/{den})' if ok and den else '-'
    print(f"  {'kohort':<8}{'yeni':>6}  {'masaüstü/telefon/tablet':<24}{'D1':>13}{'D7':>13}{'7 gün içinde':>15}")
    for c in sorted(new)[-14:]:
        n = sum(new[c].values())
        d1_ok, d7_ok = c + dt.timedelta(days=1) <= last, c + dt.timedelta(days=7) <= last
        print(f"  {c:%d.%m}  {n:>6}  {'/'.join(str(new[c][k]) for k in kinds):<24}{rate(sum(back[1][c].values()), n, d1_ok):>13}"
              f"{rate(sum(back[7][c].values()), n, d7_ok):>13}{rate(sum(within[c].values()), n, d7_ok):>15}")
    for kind in kinds:
        c1 = [c for c in new if c + dt.timedelta(days=1) <= last]
        c7 = [c for c in new if c + dt.timedelta(days=7) <= last]
        n1, n7 = sum(new[c][kind] for c in c1), sum(new[c][kind] for c in c7)
        if n1:
            print(f"  {kind}: D1 {rate(sum(back[1][c][kind] for c in c1), n1, True)} · D7 {rate(sum(back[7][c][kind] for c in c7), n7, bool(c7))} · "
                  f"7 gün içinde {rate(sum(within[c][kind] for c in c7), n7, bool(c7))}")
    by_day = defaultdict(Counter)
    for day, q, kind in firsts:
        vn = q.get('vn') or '1'
        by_day[day]['all'] += 1
        by_day[day]['ret'] += vn != '1'
        by_day[day]['old'] += q.get('vo') == '1' and vn == '1'
    print('  Dönen ziyaretçi (günün ilk sayfalarında daha önce gelmiş tarayıcılar):',
          ' · '.join(f"{d:%d.%m} {pct(c['ret'] + c['old'], c['all'])} ({c['ret'] + c['old']}/{c['all']})" for d, c in sorted(by_day.items())[-10:]))
    print('  Sınırlar: tarayıcı başına sayılır (aynı kişinin telefonu ve bilgisayarı iki tarayıcıdır); site verisini silen, gizli\n'
          '  pencere kullanan veya Do Not Track / GPC açık olan hiç dönmemiş görünür (oran düşük çıkar); gün, oyuncunun kendi takvim\n'
          '  günüdür ama kohort Türkiye gününe göre kurulur (başka saat dilimlerinde bir gün kayabilir); sayaçtan önce oynamış\n'
          '  tarayıcılar (vo=1) kohortlara girmez; D7 için kohorttan sonra 8 günlük kayıt gerekir.')


def report_field(beacons, visitors, key):
    """--field KEY: the values of one beacon field per event type (events and people), players only."""
    per = defaultdict(lambda: defaultdict(set))
    count = defaultdict(Counter)
    for evs in beacons.values():
        for _, q, vid in evs:
            if key in q and not visitors[vid]['who']:
                per[q.get('t')][q[key]].add(vid)
                count[q.get('t')][q[key]] += 1
    print(f'\nAlan "{key}" (olay türüne göre: değer olay/kişi):')
    if not per:
        print('  Bu alanı taşıyan sinyal yok.')
    for t, vals in sorted(per.items(), key=lambda kv: -sum(count[kv[0]].values())):
        print(f"  {t}: " + ' · '.join(f'{v} {count[t][v]}/{len(p)}' for v, p in sorted(vals.items(), key=lambda kv: -count[t][kv[0]])[:12]))


def report_extras(beacons, visitors, top):
    """Fields other modules add (hook): `as` (assisted flight, src/flight/assist.js: sent on `fly` and outcome events) →
    per value the flights and their outcomes (take-off, runway landings, crashes per flight); other events carrying it
    are counted (details: --field as). The `set` beacons (settings) have their own line (report_settings)."""
    flights = defaultdict(list)
    for evs in beacons.values():
        vid = evs[0][2]
        if visitors[vid]['who']:
            continue
        fly = next((q for _, q, _ in evs if q.get('t') == 'fly'), None)
        if fly is not None and 'as' in fly:
            kinds = [q.get('t') for _, q, _ in evs]
            flights[fly['as']].append((vid, 'takeoff' in kinds, sum(1 for _, q, _ in evs if q.get('t') == 'land' and q.get('rw') == '1'), kinds.count('crash')))
    if flights:
        print('\nDestekli uçuş (fly as=…): ' + ' | '.join(
            f"as={k}: {len(v)} uçuş ({len({x[0] for x in v})} kişi) · kalkış {pct(sum(1 for x in v if x[1]), len(v))} · pist inişi/uçuş "
            f"{sum(x[2] for x in v) / len(v):.2f} · kaza/uçuş {sum(x[3] for x in v) / len(v):.2f}" for k, v in sorted(flights.items())))
    others = Counter(q.get('t') for evs in beacons.values() for _, q, vid in evs if 'as' in q and q.get('t') != 'fly' and not visitors[vid]['who'])
    if others:
        print(f"  'as' taşıyan diğer olaylar: {top(others, 8)} (ayrıntı: --field as)")
    ev = real_events(beacons, visitors, {'assist'})   # src/ui/assist-hud.js: st = app (assisted approach: via button / gear), tip, …
    if ev:
        sts = sorted({q.get('st') or '?' for *_, q in ev})
        print('Destekli uçuş olayları (assist, kişi / olay): ' + ' · '.join(
            f"{st} {len(people(ev, lambda q, st=st: (q.get('st') or '?') == st))}/{sum(1 for *_, q in ev if (q.get('st') or '?') == st)}" for st in sts)
            + (f" · yaklaşma nasıl: {top(Counter(q.get('via') or '?' for *_, q in ev if q.get('st') == 'app'), 4)}" if any(q.get('st') == 'app' for *_, q in ev) else ''))


def flight_device(evs, visitor):
    """phone / tablet / desktop of a beacon session: the `open` device class (dc), else touch + screen size, else the UA."""
    op = next((q for _, q, _ in evs if q.get('t') == 'open'), {})
    dc = (op.get('dc') or '').split('/')[0]
    if dc in ('phone', 'tablet', 'desktop'):
        return dc
    touch = op.get('touch') == '1' or any(q.get('in') == 'touch' for _, q, _ in evs if q.get('t') == 'fly')
    w, h = num(op.get('w')), num(op.get('h'))
    if visitor['system'] in ('iOS', 'Android') or touch:
        return 'phone' if (w and h and min(w, h) <= 500) or (not w and visitor['system'] in ('iOS', 'Android')) else 'tablet'
    return 'desktop'


def assist_flights(beacons, visitors):
    """The flights of report_assist per assisted-flight state ('1' / '0' / '?'): ground start, take-offs, landings,
    runway landings, assisted approaches, crash causes, device, the session's first beacon time (`at`) and id."""
    rows = defaultdict(list)
    for sid, evs in beacons.items():
        vid = evs[0][2]
        if visitors[vid]['who']:
            continue
        fly = next((q for _, q, _ in evs if q.get('t') == 'fly'), None)
        if fly is None:
            continue
        outcome = [q for _, q, _ in evs if q.get('t') in ('takeoff', 'land', 'crash')]
        state = fly.get('as') or next((q.get('as') for q in outcome if q.get('as')), '?')
        sp = fly.get('sp') or ''
        land = [q for q in outcome if q.get('t') == 'land']
        rows[state].append({
            'ground': not sp.startswith('AIR') and not fly.get('mi'), 'to': sum(1 for q in outcome if q.get('t') == 'takeoff'),
            'ld': len(land), 'rw': sum(1 for q in land if q.get('rw') == '1'), 'aa': sum(1 for q in land if q.get('aa') == '1'),
            'cr': [q.get('r') or '?' for q in outcome if q.get('t') == 'crash'], 'dev': flight_device(evs, visitors[vid]),
            'at': evs[0][0], 'sid': sid,
        })
    return rows


def report_assist(beacons, visitors, top):
    """Take-off / landing / crash funnel per assisted-flight state (src/flight/assist.js, "Destekli uçuş"): `as` on the
    `fly` beacon (main.js hook) or else on the flight's first outcome event (takeoff / land / crash, src/ui/tutorial.js);
    '?' = builds before the field. Per state: flights, share of ground starts with a take-off, take-offs, landings and
    runway landings per take-off, flights with a runway landing, crashes per flight / per take-off, the top crash causes,
    landings flown with the assisted approach ("İnişe geç", aa=1); then take-off share and runway landings per take-off by
    device. Flights are page sessions with a `fly` beacon; players only."""
    rows = assist_flights(beacons, visitors)
    if not rows:
        return
    name = {'1': 'destekli', '0': 'desteksiz', '?': 'bilinmiyor (eski sürüm)'}
    print('\nKalkış / iniş hunisi, destekli uçuşa göre (as; uçuş = fly sinyali olan sayfa oturumu):')
    for k in ('1', '0', '?'):
        fl = rows.get(k)
        if not fl:
            continue
        n, g = len(fl), [f for f in fl if f['ground']]
        to, ld, rw = sum(f['to'] for f in fl), sum(f['ld'] for f in fl), sum(f['rw'] for f in fl)
        cr = Counter(c for f in fl for c in f['cr'])
        print(f"  {name[k]:<24} uçuş {n} · yerden kalkış yapan {pct(sum(1 for f in g if f['to']), len(g))} · kalkış {to} · iniş/kalkış "
              f"{ld / max(to, 1):.2f} (pist {rw / max(to, 1):.2f}) · pist inişi yapan uçuş {pct(sum(1 for f in fl if f['rw']), n)} · kaza/uçuş "
              f"{sum(cr.values()) / n:.2f} (kaza/kalkış {sum(cr.values()) / max(to, 1):.2f})"
              + (f" · İnişe geç ile iniş {sum(f['aa'] for f in fl)}" if k == '1' else '') + (f" · kaza nedenleri: {top(cr, 4)}" if cr else ''))
        by = defaultdict(list)
        for f in fl:
            by[f['dev']].append(f)
        print('    ' + ' · '.join(f"{d} {len(v)} uçuş: kalkış {pct(sum(1 for f in v if f['ground'] and f['to']), sum(1 for f in v if f['ground']))}, pist inişi/kalkış "
                                  f"{sum(f['rw'] for f in v) / max(sum(f['to'] for f in v), 1):.2f}" for d, v in sorted(by.items(), key=lambda kv: -len(kv[1]))))
    report_assist_off(beacons, visitors, top)


def report_assist_off(beacons, visitors, top):
    """Açma / kapatma: the "DESTEKLİ UÇUŞ" chip on the flight screen and Ayarlar (people, players only). The chip: on →
    `assist` st=chip (tapped, the question "Destekli uçuşu kapat?"), st=off via=chip ("Kapat"), st=keep (Vazgeç / a second
    tap / the 4 s timeout / the chip hid); off → st=on via=chip (one tap). Its switch sends the `set` k=assist beacon too
    (v2=0 off, v2=1 on), so Ayarlar = `set` people without the chip's own event. How far into the page the chip's "Kapat"
    came (median minutes). Callouts pointing at the chip (st=hint): k=start (a new player's first flights, `as` = the
    state then) and k=crash (the one-time suggestion after two crashes with the assist off) → the same page's chip taps
    that followed."""
    ev = real_events(beacons, visitors, {'assist'})
    chip = [x for x in ev if x[3].get('st') in ('chip', 'off', 'keep', 'on')]
    hints = [x for x in ev if x[3].get('st') == 'hint']
    sets = real_events(beacons, visitors, {'set'})
    off_set = people(sets, lambda q: q.get('k') == 'assist' and q.get('v2') == '0')
    on_set = people(sets, lambda q: q.get('k') == 'assist' and q.get('v2') == '1')
    if not chip and not off_set and not on_set and not hints:
        return
    st = lambda name: (lambda q: q.get('st') == name)
    tapped, keep = people(chip, st('chip')), people(chip, st('keep'))
    off, on = people(chip, lambda q: q.get('st') == 'off' and q.get('via') == 'chip'), people(chip, lambda q: q.get('st') == 'on' and q.get('via') == 'chip')
    keeps = Counter(q.get('via') or '?' for *_, q in chip if q.get('st') == 'keep')
    mins = [num(q.get('m')) for *_, q in chip if q.get('st') == 'off']
    base = len(flyers(beacons, visitors))
    n = lambda name: sum(1 for *_, q in chip if q.get('st') == name)
    print(f"  Açma / kapatma (çip): açıkken dokunan {len(tapped)} kişi ({n('chip')} kez) → \"Kapat\" {len(off)} kişi "
          f"({pct(len(off), len(tapped))}; uçanların {pct(len(off), base)}; sayfada medyan {med(mins, '{:.1f}')} dk) · vazgeçen {len(keep - off)} kişi "
          f"({top(keeps, 5)}) · kapalıyken dokunup açan {len(on)} kişi ({n('on')} kez; uçanların {pct(len(on), base)}) · Ayarlar'dan kapatan "
          f"{len(off_set - off)} kişi · Ayarlar'dan açan {len(on_set - on)} kişi")
    if hints:
        # the chip taps after a callout in the same page session
        after = defaultdict(list)
        for at, vid, sid, q in chip:
            after[sid].append((at, q))
        def then(kind, pred):
            return {vid for at, vid, sid, q in hints if q.get('k') == kind and any(t >= at and pred(x) for t, x in after.get(sid, ()))}
        start = [x for x in hints if x[3].get('k') == 'start']
        crash = people(hints, lambda q: q.get('k') == 'crash')
        s_on, s_off = people(start, lambda q: q.get('as') == '1'), people(start, lambda q: q.get('as') == '0')
        print(f"  Hatırlatmalar: başlangıç ({len(start)} kez) açıkken gören {len(s_on)} kişi → aynı sayfada kapatan "
              f"{len(then('start', lambda q: q.get('st') == 'off') & s_on)} · kapalıyken gören {len(s_off)} kişi → aynı sayfada açan "
              f"{len(then('start', lambda q: q.get('st') == 'on') & s_off)} · iki kazadan sonra öneri gören {len(crash)} kişi → aynı sayfada açan "
              f"{len(then('crash', lambda q: q.get('st') == 'on'))} ({pct(len(then('crash', lambda q: q.get('st') == 'on')), len(crash))})")


def report_comeback(beacons, visitors, top):
    """Reasons to come back (src/retention/**, owned by the retention work; CONTRACTS-SF.md §11): the daily streak
    (`streak`: day with b = streak bucket and k = what finished the day, badge, pick, open), the weekly challenge (`wk`:
    show / play / submit with the week's pick in id), challenge links (`chl`: open / beat / lost / back), the "Yenilikler"
    card (`news`: show / close), the home-screen suggestion (`inst`: show with p = android | ios, accept / dismiss / later /
    installed) and the landing challenges (`ffc` ids lseries / dland, `ffp` final = "Son yaklaşmaya git"). People =
    anonymous visitors, players only."""
    ev = real_events(beacons, visitors, {'streak', 'wk', 'chl', 'news', 'inst'})
    lc = [e for e in real_events(beacons, visitors, {'ffc', 'ffp'}) if e[3].get('id') in ('lseries', 'dland')]
    if not ev and not lc:
        print('\nGeri gelme özellikleri (seri, haftanın görevi, beni geç, yenilikler, ana ekran): henüz sinyal yok.')
        return
    t = lambda name, st=None: [e for e in ev if e[3].get('t') == name and (st is None or e[3].get('st') == st)]
    print('\nGeri gelme özellikleri:')
    days = t('streak', 'day')
    if days:
        order = ['1', '2', '3-6', '7-13', '14-29', '30+']
        b = Counter(q.get('b') or '?' for *_, q in days)
        print(f"  Seri: seriye gün ekleyen {len(people(days))} kişi ({len(days)} gün) · seri uzunluğu: "
              + ' · '.join(f'{k} gün {b[k]}' for k in order if b[k])
              + f" · günü bitiren: {top(Counter({'m': 'görev', 'l': 'iniş', 'a': '2 dk uçuş', 'c': 'serbest görev'}.get(q.get('k'), q.get('k') or '?') for *_, q in days), 4)}"
              + f" · rozet: {top(Counter(q.get('id') or '?' for *_, q in t('streak', 'badge')), 6)}"
              + f" · kartı açan {len(people(t('streak', 'open')))} kişi, rozet seçen {len(people(t('streak', 'pick')))} kişi")
    if t('wk'):
        print(f"  Haftanın görevi: sıralamasını gören {len(people(t('wk', 'show')))} kişi · menüden başlatan {len(people(t('wk', 'play')))} kişi · "
              f"haftalık sıralamaya giren {len(people(t('wk', 'submit')))} kişi ({len(t('wk', 'submit'))} gönderim, gönderilemeyen {len(t('wk', 'fail'))}) · "
              f"görevler: {top(Counter(q.get('id') or '?' for *_, q in t('wk', 'play') + t('wk', 'submit')), 4)}")
    if t('chl'):
        lost = Counter(q.get('o') or '?' for *_, q in t('chl', 'lost'))
        print(f"  Beni geç bağlantısı: açan {len(people(t('chl', 'open')))} kişi · geçen {len(people(t('chl', 'beat')))} kişi · geçemeyen "
              f"{len(people(t('chl', 'lost')))} kişi ({top(lost, 3)}) · skorunu geri gönderen {len(people(t('chl', 'back')))} kişi · "
              f"görevler: {top(Counter(q.get('id') or '?' for *_, q in t('chl', 'open')), 4)}")
    if t('news'):
        print(f"  Yenilikler kartı: gören {len(people(t('news', 'show')))} kişi · kapatan {len(people(t('news', 'close')))} kişi · sürüm: "
              f"{top(Counter(q.get('id') or '?' for *_, q in t('news', 'show')), 3)}")
    if t('inst'):
        shown = t('inst', 'show')
        print(f"  Ana ekrana ekle: önerilen {len(people(shown))} kişi ({top(Counter(q.get('p') or '?' for *_, q in shown), 2)}; "
              f"{top(Counter(q.get('via') or '?' for *_, q in shown), 2)}) · kabul {len(people(t('inst', 'accept')))} · reddeden "
              f"{len(people(t('inst', 'dismiss')))} · sonra {len(people(t('inst', 'later')))} · yükleyen {len(people(t('inst', 'installed')))}")
    if lc:
        for i, name in (('lseries', 'İniş serisi'), ('dland', 'Günün inişi')):
            e = [x for x in lc if x[3].get('id') == i]
            if not e:
                continue
            done = [q for *_, q in e if q.get('t') == 'ffc' and q.get('st') == 'done']
            print(f"  {name}: tamamlayan {len(people([x for x in e if x[3].get('t') == 'ffc' and x[3].get('st') == 'done']))} kişi ({len(done)} kez; "
                  f"destekli {sum(1 for q in done if q.get('as') == '1')}) · puan medyanı {med([num(q.get('score')) for q in done])} · "
                  f"\"Son yaklaşmaya git\" {sum(1 for *_, q in e if q.get('t') == 'ffp' and q.get('st') == 'final')} kez "
                  f"({len(people([x for x in e if x[3].get('t') == 'ffp' and x[3].get('st') == 'final']))} kişi)")


def load(folder, since, target='production', key_salt=None, mine=None, geo=None):
    """Read the access logs in `folder` from `since` (UTC) on into the structures every report works from (the text
    report, --hourly, --field, --json and the stats feed infra/stats-feed/). key_salt / mine default to the local files
    (analytics_salt, staging_ips); without `geo` countries are '?'. Bots are skipped, own IPs are "sen", headless test
    browsers "test"; raw IPs and user agents are not kept."""
    key_salt = salt() if key_salt is None else key_salt
    mine = own_ips() if mine is None else mine
    beacons = defaultdict(list)          # sid -> [(at, event dict, visitor)]
    orphans = []                         # tutorial beacons of old builds whose session id was overwritten
    requests = defaultdict(list)         # visitor -> [(at, uri)]
    visitors = {}                        # visitor -> {browser, system, city, who}
    days_seen = defaultdict(set)         # visitor -> Istanbul days with any request (retention)
    api = Counter()                      # leaderboard API (players only): (method, path, status) -> requests
    api_time = defaultdict(list)         # 'POST' / 'GET hit' / 'GET miss' -> CloudFront time-taken (s)
    api_own = Counter()                  # leaderboard requests of "sen" / test browsers (staging checks)
    api_day = Counter()                  # (Türkiye day, method, path, status) -> requests (players only; --json)
    blocked = Counter()
    hours = defaultdict(lambda: {'vis': set(), 'phone': set(), 'iab': set(), 'bytes': 0})   # --hourly: Türkiye hour -> requests
    first_seen = {}                      # visitor -> first request in the window
    last_at = None                       # newest log line read
    for row in read_logs(folder, since):
        if last_at is None or row['at'] > last_at:
            last_at = row['at']
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
                api_day[(row['at'].astimezone(IST).date(), method, uri, status)] += 1
                hit = row.get('x-edge-result-type') in ('Hit', 'RefreshHit')
                try:
                    api_time['POST' if method == 'POST' else 'GET hit' if hit else 'GET miss'].append(float(row.get('time-taken') or 0))
                except ValueError:
                    pass
            continue
        if status == '403':   # staging: IP lock; production: a missing file (S3 answers 403 for unknown keys)
            blocked[(uri or '?') if target == 'production' else edge_city(row.get('x-edge-location', ''))] += 1
            continue
        if not status.startswith(('2', '3')):
            continue
        vid = hashlib.sha256(f'{key_salt}|{ip}|{ua}'.encode()).hexdigest()[:6]
        browser, system = client(ua)
        who = 'sen' if ip in mine else 'test' if browser == 'test' else ''
        if vid not in visitors:
            visitors[vid] = {'browser': browser, 'system': system, 'city': geo.country(ip) if geo else '?', 'who': who}
        days_seen[vid].add(row['at'].astimezone(IST).date())
        if not who:
            h = hours[hour_of(row['at'])]
            h['vis'].add(vid)
            u = ua.lower()
            if 'iphone' in u or 'ipad' in u or 'android' in u:
                h['phone'].add(vid)
            if 'twitter' in u or 'instagram' in u or 'fban' in u or 'fbav' in u:
                h['iab'].add(vid)
            try:
                h['bytes'] += int(row.get('sc-bytes') or 0)
            except ValueError:
                pass
            if vid not in first_seen or row['at'] < first_seen[vid]:
                first_seen[vid] = row['at']
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
        rel = [fps_rel(q) for q in hbs if q.get('fps', '').isdigit()]
        caps = Counter(int(q['cap']) if (q.get('cap') or '').isdigit() else None for q in hbs if q.get('fps', '').isdigit())
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
            'fps_rel': statistics.mean(rel) if rel else None, 'cap': caps.most_common(1)[0][0] if caps else None,
            'gpu': first.get('gpu'), 'quality': fly.get('q') or first.get('q'), 'version': first.get('v') or fly.get('v'),
            'errors': [q.get('e') for _, q, _ in evs if q.get('t') == 'err' and q.get('x') != 'foreign'], 'exact': True,
            'map': session_map(evs), 'sid': sid,
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
                             'aircraft': ac, 'spawn': None, 'load': None, 'fps': None, 'fps_rel': None, 'cap': None, 'gpu': None, 'quality': None,
                             'version': None, 'errors': [], 'exact': False, 'sid': None,
                             'map': next((m for m in MAPS if any(p.startswith(f'/assets/{m}/') for _, p in g)), 'sf')})

    real = [s for s in sessions if not visitors[s['vid']]['who']]
    return SimpleNamespace(beacons=beacons, requests=requests, visitors=visitors, days_seen=days_seen, api=api,
                           api_day=api_day, api_time=api_time, api_own=api_own, blocked=blocked, hours=hours,
                           first_seen=first_seen, sessions=sessions, real=real, since=since, last_at=last_at, target=target)


# ── Dashboard snapshot: --json and the hourly stats feed (infra/stats-feed/) ──────────────────────────────────────────
# The snapshot follows the stats.erenailab.com ingest contract v1: {v, generated_at, source, range, stale, cards, tables};
# tables carry id, title, tab (genel | gunluk | haftalik | toplam | saatlik), columns and rows; titles and columns are
# Turkish, numbers stay numbers (hours with 1 decimal, shares in % with 1 decimal), null = not available yet; a table's
# `note` says what its numbers mean. The dashboard (stats.erenailab.com, src/ingest.ts) has no "saatlik" tab yet, so the
# last-48-hours table sits on HOURLY_TAB; a stale snapshot also gets a "Veri durumu" card (the dashboard also shows `stale`).
# Definitions (the same as the text report): visitor = anonymous id (salted hash of IP + browser) with a session;
# player = visitor who started a flight (a `fly` beacon or, without beacons, an aircraft model download); flight = such a
# session; hours = active flight minutes (one heartbeat per active minute) / 60. Sessions go by their start, other events
# by their own time, days are Türkiye days. "sen" / test browsers and bots are left out.
# History: the logs are kept 30 days, so every Türkiye day gets a record ("days" of the state: additive counts + a few
# facts per anonymous id, no IP, no browser string) that the next runs merge with; since-launch numbers are unions and
# sums over the records. A record is rewritten while its day is inside the logs read and marked final 26 h after the day.
FEED_LAUNCH = dt.date(2026, 9, 23)                                           # production went public
FEED_LAUNCH_AT = dt.datetime(2026, 9, 23, 13, tzinfo=dt.timezone.utc)        # its first access log hour
FEED_MARGIN = dt.timedelta(hours=6)       # a day counts only if the logs read start ≥ 6 h before it (earlier sessions)
FEED_FINAL = dt.timedelta(days=2, hours=2)   # a day's record is final 26 h after the day (late sessions, log delivery)
FEED_CATCH_UP = 10                        # the feed rereads at most this many days of logs (after an outage)
DEVICE_TR = {'desktop': 'masaüstü', 'phone': 'telefon', 'tablet': 'tablet'}
ASSIST_TR = {'1': 'destekli', '0': 'desteksiz', '?': 'bilinmiyor (eski sürüm)'}
HOURLY_TAB = 'saatlik'                    # the dashboard's Saatlik tab (stats.erenailab.com)


def mark_stale(payload, why):
    """Flag a snapshot as possibly out of date: `stale` and a first card the dashboard shows."""
    payload['stale'] = True
    if not any(c['label'] == 'Veri durumu' for c in payload['cards']):
        payload['cards'].insert(0, {'label': 'Veri durumu', 'value': 'eski olabilir', 'note': why})


def day_start(day):
    return dt.datetime.combine(day, dt.time(0), IST)


def covered_days(since, now):
    """The Türkiye days, up to today, whose sessions the logs read from `since` cover completely."""
    today, day, out = now.astimezone(IST).date(), FEED_LAUNCH, []
    while day <= today:
        if since <= max(day_start(day) - FEED_MARGIN, FEED_LAUNCH_AT):
            out.append(day)
        day += dt.timedelta(days=1)
    return out


def feed_since(state, now):
    """Where the feed starts reading logs: before the oldest day without a final record (at most FEED_CATCH_UP days
    back) and at least 48 h back (the "Saatlik" table), less FEED_MARGIN."""
    today, stored = now.astimezone(IST).date(), (state or {}).get('days', {})
    first, day = today, FEED_LAUNCH
    while day <= today:
        if not stored.get(day.isoformat(), {}).get('final'):
            first = day
            break
        day += dt.timedelta(days=1)
    first = max(first, today - dt.timedelta(days=FEED_CATCH_UP))
    return min(day_start(first), now - dt.timedelta(hours=48)) - FEED_MARGIN


def event_keys(q):
    """Keys of one gameplay beacon: the snapshot counts people (distinct anonymous ids) and events per key. The groups
    are those of report_missions, report_challenges, report_lb, report_settings, report_assist_off and report_funnel."""
    t, st, out = q.get('t'), q.get('st'), []
    if t == 'fly':
        out.append('fly')
    elif t == 'mission' and st in ('brief', 'start', 'done', 'fail', 'quit'):
        out.append(f"m:{st}:{q.get('id') or '?'}")
    elif t == 'mmenu' and st == 'open':
        out.append('mm:open')
    elif t == 'ffp' and st == 'open':
        out.append('cp:open')
    elif t == 'ffp' and st == 'track' and q.get('id'):
        out.append(f"cp:track:{q['id']}")
    elif t == 'ffc' and st in ('start', 'done', 'fail', 'cancel', 'drop'):
        out.append(f"c:{st}:{q.get('id') or '?'}")
    elif t == 'lb' and st in ('show', 'submit', 'fail'):
        lst = 'a' if q.get('as') == '1' else 'm'   # Destekli / Elle
        out += [f'l:{st}:{lst}', f"lb:{st}:{lst}:{lb_base(q.get('b'))}"]
    elif t == 'set':
        out += [f's:{g}' for g, (_, pred) in SETTING_GROUPS.items() if pred(q)] + [f"sk:{q.get('k') or '?'}"]
    elif t == 'assist' and st == 'chip':
        out.append('as:chip')
    elif t == 'assist' and st == 'off' and q.get('via') == 'chip':
        out.append('as:off')
    elif t == 'assist' and st == 'keep':
        out.append('as:keep')
    elif t == 'assist' and st == 'on' and q.get('via') == 'chip':
        out.append('as:on')
    elif t == 'assist' and st == 'hint' and q.get('k') in ('start', 'crash'):
        out.append(f"as:hint:{q['k']}")
    if st == 'open' and t in ('ffp', 'mmenu'):                               # report_funnel
        out.append('t:open')
    if (t == 'mission' and st == 'start') or (t == 'ffc' and st in ('start', 'done', 'fail') and q.get('id') != 'land'):
        out.append('t:tried')
    if st == 'done' and (t == 'mission' or (t == 'ffc' and q.get('id') != 'land')):
        out.append('t:done')
    return out


def day_records(d, days, skip=frozenset()):
    """{Türkiye day: record} for `days` from the loaded logs `d`. A record: 'c' = additive counts (sessions, flights,
    active and session minutes, per aircraft / map / platform [flights, active min], events per key, assisted-flight
    funnel per state, visit-cohort counts, leaderboard API requests), 'p' = per anonymous id: flights 'f', aircraft
    'ac', maps 'mp', platforms flown 'pf' / visited 'pv', event keys 'k'; 'sids' = the page sessions (random beacon ids)
    that started that day. Sessions in `skip` began on an earlier day (a page kept open across the logs' start)."""
    wanted, recs = set(days), {}

    def rec(day):
        if day not in recs:
            recs[day] = {'c': {'ses': 0, 'fl': 0, 'act': 0, 'min': 0.0, 'ac': {}, 'mp': {}, 'pf': {}, 'ev': Counter(),
                               'as': {}, 'ret': Counter(), 'api': Counter()}, 'p': {}, 'sids': []}
        return recs[day]

    def add(p, key, value):
        values = p.setdefault(key, [])
        if value not in values:
            values.append(value)

    def bump(table, key, active):
        t = table.setdefault(key, [0, 0])
        t[0] += 1
        t[1] += active

    for day in days:
        rec(day)
    for s in d.real:
        day = s['start'].astimezone(IST).date()
        if day not in wanted or s['sid'] in skip:
            continue
        r, v = rec(day), d.visitors[s['vid']]
        if s['sid']:
            r['sids'].append(s['sid'])
        p = r['p'].setdefault(s['vid'], {})
        dev = flight_device(d.beacons[s['sid']], v) if s['sid'] else 'phone' if v['system'] in ('iOS', 'Android') else 'desktop'
        plat = f"{dev}/{v['system']}"
        add(p, 'pv', plat)
        c = r['c']
        c['ses'] += 1
        if s['aircraft']:
            act = s['active'] or 0
            c['fl'] += 1
            c['act'] += act
            c['min'] += s['minutes']
            bump(c['ac'], s['aircraft'], act)
            bump(c['mp'], s['map'], act)
            bump(c['pf'], plat, act)
            p['f'] = p.get('f', 0) + 1
            add(p, 'ac', s['aircraft'])
            add(p, 'mp', s['map'])
            add(p, 'pf', plat)
    for evs in d.beacons.values():
        for at, q, vid in evs:
            if d.visitors[vid]['who']:
                continue
            day = at.astimezone(IST).date()
            keys = event_keys(q) if day in wanted else ()
            if keys:
                r = rec(day)
                p = r['p'].setdefault(vid, {})
                for k in keys:
                    add(p, 'k', k)
                    r['c']['ev'][k] += 1
    firsts = defaultdict(list)
    for f in visit_firsts(d.beacons, d.visitors):
        if f[0] in wanted:
            firsts[f[0]].append(f)
    for day, fs in firsts.items():
        new, back, within = visit_cohorts(fs)
        ret = rec(day)['c']['ret']
        for name, table in (('n', new), ('d1', back[1]), ('d7', back[7]), ('w', within)):
            for cohort, kinds in table.items():
                for kind, n in kinds.items():
                    ret[f'{cohort.isoformat()}|{name}|{kind}'] += n
    for state, flights in assist_flights(d.beacons, d.visitors).items():
        for f in flights:
            day = f['at'].astimezone(IST).date()
            if day in wanted and f['sid'] not in skip:
                a = rec(day)['c']['as'].setdefault(state, Counter())
                for k, n in (('n', 1), ('g', f['ground']), ('gto', f['ground'] and f['to'] > 0), ('to', f['to']), ('ld', f['ld']),
                             ('rw', f['rw']), ('rwf', f['rw'] > 0), ('aa', f['aa']), ('cr', len(f['cr']))):
                    a[k] += int(n)
    for (day, method, uri, status), n in d.api_day.items():
        if day in wanted:
            rec(day)['c']['api'][f'{method} {uri} {status}'] += n
    for r in recs.values():
        r['c']['min'] = round(r['c']['min'], 2)
        r['sids'].sort()
        for p in r['p'].values():
            for values in p.values():
                if isinstance(values, list):
                    values.sort()
    return {day.isoformat(): r for day, r in sorted(recs.items())}


def hourly_rows(d, now, n=48):
    """The last n Türkiye hours, newest first (the columns of --hourly that the dashboard shows)."""
    k = hourly_counts(d.beacons, d.visitors, d.requests)
    end, rows = hour_of(now), []
    for i in range(n):
        h = end - dt.timedelta(hours=i)
        c, vis = k.c.get(h, Counter()), d.hours.get(h)
        nv = len(vis['vis']) if vis else 0
        rows.append([f'{h:%Y-%m-%d %H}:00', nv, len(k.players.get(h, ())), c['fly'], c['hb'], c['takeoff'], c['land'], c['crash'],
                     len(k.mis.get(h, ())), len(k.done.get(h, ())), len(k.ist.get(h, ())),
                     round(100 * len(vis['phone']) / nv, 1) if nv else None])
    return rows


def share(a, b):
    return round(100 * a / b, 1) if b else None


def hours1(minutes):
    return round(minutes / 60, 1)


def build_payload(stored, now, hourly=None, last_at=None, stale=False):
    """The dashboard snapshot from the day records `stored` ({iso day: record}) since launch."""
    today = now.astimezone(IST).date()
    yesterday = today - dt.timedelta(days=1)
    days = sorted(dt.date.fromisoformat(k) for k in stored if FEED_LAUNCH <= dt.date.fromisoformat(k) <= today)
    R = {day: stored[day.isoformat()] for day in days}
    seen, first_fly, fly_days, flights_of = set(), {}, Counter(), Counter()
    keys, ac_p, mp_p, pf_p, pv_p = (defaultdict(set) for _ in range(5))
    C = {'fl': 0, 'act': 0, 'ses': 0, 'min': 0.0}
    C_ac, C_mp, C_pf = (defaultdict(lambda: [0, 0]) for _ in range(3))
    C_ev, C_ret, C_api = Counter(), Counter(), Counter()
    C_as = defaultdict(Counter)
    for day in days:
        r = R[day]
        for vid, p in r['p'].items():
            if p.get('pv'):
                seen.add(vid)
            for x in p.get('pv', ()):
                pv_p[x].add(vid)
            if p.get('f'):
                first_fly.setdefault(vid, day)
                fly_days[vid] += 1
                flights_of[vid] += p['f']
                for key, group in (('ac', ac_p), ('mp', mp_p), ('pf', pf_p)):
                    for x in p.get(key, ()):
                        group[x].add(vid)
            for k in p.get('k', ()):
                keys[k].add(vid)
        c = r['c']
        for k in C:
            C[k] += c[k]
        for src, dst in ((c['ac'], C_ac), (c['mp'], C_mp), (c['pf'], C_pf)):
            for k, (n, a) in src.items():
                dst[k][0] += n
                dst[k][1] += a
        C_ev.update(c['ev'])
        C_ret.update(c['ret'])
        C_api.update(c['api'])
        for state, a in c['as'].items():
            C_as[state].update(a)
    players = set(first_fly)
    ac_ids = sorted(C_ac, key=lambda a: (-C_ac[a][0], a))
    mp_ids = [m for m in MAPS if m in C_mp] + sorted(m for m in C_mp if m not in MAPS)
    ac_cols = [a for a in AIRCRAFT if a in C_ac] + sorted(a for a in C_ac if a not in AIRCRAFT)

    def day_nums(r):
        pl = [v for v, p in r['p'].items() if p.get('f')]
        return sum(1 for p in r['p'].values() if p.get('pv')), pl, r['c']['fl'], hours1(r['c']['act'])

    def people_of(prefix):
        return set().union(*(v for k, v in keys.items() if k.startswith(prefix))) if keys else set()

    since = "23 Eylül'den beri"
    last = f" · son kayıt {last_at.astimezone(IST):%H:%M}" if last_at else ''
    cards = [
        {'label': 'Toplam ziyaretçi', 'value': len(seen), 'note': f'{since} · tekil anonim ziyaretçi'},
        {'label': 'Toplam oyuncu', 'value': len(players), 'note': f'{since} · uçuş başlatan tekil kişi'},
        {'label': 'Toplam uçuş', 'value': C['fl'], 'note': since},
        {'label': 'Toplam uçuş saati', 'value': hours1(C['act']), 'note': f'{since} · aktif uçuş dakikaları'},
        {'label': '2+ uçuş yapan oyuncu', 'value': sum(1 for n in flights_of.values() if n >= 2),
         'note': f"oyuncuların %{share(sum(1 for n in flights_of.values() if n >= 2), len(players)) or 0:.0f}'i"},
        {'label': '2+ gün uçan oyuncu', 'value': sum(1 for n in fly_days.values() if n >= 2),
         'note': f"oyuncuların %{share(sum(1 for n in fly_days.values() if n >= 2), len(players)) or 0:.0f}'i · farklı günlerde"},
    ]
    for label, day in (('Bugün', today), ('Dün', yesterday)):
        r = R.get(day)
        vis, pl, fl, hr = day_nums(r) if r else (0, [], 0, 0.0)
        note = f'{day:%d.%m}' + (last if day == today else '')
        cards += [{'label': f'{label} ziyaretçi', 'value': vis, 'note': note}, {'label': f'{label} oyuncu', 'value': len(pl), 'note': note},
                  {'label': f'{label} uçuş', 'value': fl, 'note': note}, {'label': f'{label} uçuş saati', 'value': hr, 'note': note}]
    ist_fl = C_mp['ist'][0] if 'ist' in C_mp else 0
    cards.append({'label': 'İstanbul payı (%)', 'value': share(ist_fl, C['fl']),
                  'note': f"uçuşların yüzdesi · İstanbul'da uçan {len(mp_p.get('ist', ()))} oyuncu (%{share(len(mp_p.get('ist', ())), len(players)) or 0:.0f})"})

    # Günlük: the owner's table (day, visitors, players, flights, hours, per aircraft, per map; totals at the bottom)
    daily_cols = (['Gün', 'Ziyaretçi', 'Oyuncu', 'Uçuş', 'Saat', 'Yeni oyuncu', 'Dönen oyuncu']
                  + [AIRCRAFT.get(a, a) for a in ac_cols] + [MAPS.get(m, m) for m in mp_ids])
    daily, returning = [], 0
    for day in reversed(days):
        r = R[day]
        vis, pl, fl, hr = day_nums(r)
        new = sum(1 for v in pl if first_fly[v] == day)
        returning += len(pl) - new
        daily.append([day.isoformat(), vis, len(pl), fl, hr, new, len(pl) - new]
                     + [r['c']['ac'].get(a, [0, 0])[0] for a in ac_cols] + [r['c']['mp'].get(m, [0, 0])[0] for m in mp_ids])
    total = (['Toplam', len(seen), len(players), C['fl'], hours1(C['act']), len(players), returning]
             + [C_ac[a][0] for a in ac_cols] + [C_mp[m][0] for m in mp_ids])
    week_rows = daily[:7]
    wk = [day for day in days if day > today - dt.timedelta(days=7)]
    wk_seen = set().union(*({v for v, p in R[day]['p'].items() if p.get('pv')} for day in wk)) if wk else set()
    wk_pl = set().union(*({v for v, p in R[day]['p'].items() if p.get('f')} for day in wk)) if wk else set()
    wk_total = (['7 gün', len(wk_seen), len(wk_pl), sum(R[x]['c']['fl'] for x in wk), hours1(sum(R[x]['c']['act'] for x in wk)),
                 sum(r[5] for r in week_rows), sum(r[6] for r in week_rows)]
                + [sum(r[7 + i] for r in week_rows) for i in range(len(ac_cols) + len(mp_ids))])
    tables = [
        {'id': 'son7', 'title': 'Son 7 gün', 'tab': 'genel', 'columns': daily_cols, 'rows': week_rows + [wk_total],
         'note': 'Türkiye günleri. Oyuncu = uçuş başlatan tekil kişi, saat = aktif uçuş saati, uçak ve harita sütunları uçuş '
                 'sayısı. "7 gün" satırında ziyaretçi ve oyuncu tekil.'},
        {'id': 'daily', 'title': 'Günlük', 'tab': 'gunluk', 'columns': daily_cols, 'rows': daily + [total],
         'note': "23 Eylül'den beri, Türkiye günleri. Oyuncu = uçuş başlatan tekil kişi, saat = aktif uçuş saati, uçak ve "
                 'harita sütunları uçuş sayısı; yeni oyuncu o gün ilk kez uçan. Toplam satırında ziyaretçi ve oyuncu tekil, '
                 'dönen oyuncu günlerin toplamı.'},
    ]

    # Haftalık: ISO weeks (Monday-Sunday, Türkiye days)
    weeks = defaultdict(list)
    for day in days:
        y, w, _ = day.isocalendar()
        weeks[(y, w)].append(day)
    weekly = []
    for (y, w), ds in sorted(weeks.items(), reverse=True):
        vis = {v for x in ds for v, p in R[x]['p'].items() if p.get('pv')}
        pl = {v for x in ds for v, p in R[x]['p'].items() if p.get('f')}
        new = sum(1 for v in pl if first_fly[v] in ds)
        weekly.append([f'{y}-W{w:02d}', dt.date.fromisocalendar(y, w, 1).isoformat(), len(ds), len(vis), len(pl),
                       sum(R[x]['c']['fl'] for x in ds), hours1(sum(R[x]['c']['act'] for x in ds)), new, len(pl) - new,
                       sum(R[x]['c']['mp'].get('ist', [0, 0])[0] for x in ds)])
    tables.append({'id': 'weekly', 'title': 'Haftalık', 'tab': 'haftalik',
                   'note': 'ISO hafta (Pazartesi-Pazar, Türkiye günleri); ziyaretçi ve oyuncu hafta içinde tekil; "Gün" = '
                           'verisi olan gün sayısı (ilk ve bu hafta eksik).', 'columns': ['Hafta', 'Pazartesi', 'Gün', 'Ziyaretçi', 'Oyuncu', 'Uçuş', 'Saat',
                                                  'Yeni oyuncu', 'Dönen oyuncu', 'İstanbul uçuşu'], 'rows': weekly})

    # Toplam (since launch)
    tables.append({'id': 'aircraft', 'title': 'Uçaklar', 'tab': 'toplam', 'note': "23 Eylül'den beri; oyuncu = o uçakla uçan tekil kişi.",
                   'columns': ['Uçak', 'Uçuş', 'Saat', 'Oyuncu', 'Uçuş payı (%)'],
                   'rows': [[AIRCRAFT.get(a, a), C_ac[a][0], hours1(C_ac[a][1]), len(ac_p[a]), share(C_ac[a][0], C['fl'])] for a in ac_ids]})
    tables.append({'id': 'maps', 'title': 'Haritalar', 'tab': 'toplam', 'note': "23 Eylül'den beri; oyuncu = o haritada uçan tekil kişi.",
                   'columns': ['Harita', 'Uçuş', 'Saat', 'Oyuncu', 'Uçuş payı (%)'],
                   'rows': [[MAPS.get(m, m), C_mp[m][0], hours1(C_mp[m][1]), len(mp_p[m]), share(C_mp[m][0], C['fl'])] for m in mp_ids]})
    plats = sorted(pv_p, key=lambda k: (-len(pv_p[k]), k))
    tables.append({'id': 'platforms', 'title': 'Platformlar', 'tab': 'toplam',
                   'note': "23 Eylül'den beri; cihaz sınıfı oyunun kendi ölçümünden (yoksa tarayıcıdan), sistem tarayıcıdan.",
                   'columns': ['Cihaz', 'Sistem', 'Ziyaretçi', 'Oyuncu', 'Uçuş', 'Saat'],
                   'rows': [[DEVICE_TR.get(k.split('/')[0], k.split('/')[0]), k.split('/', 1)[1], len(pv_p[k]), len(pf_p.get(k, ())),
                             C_pf[k][0] if k in C_pf else 0, hours1(C_pf[k][1]) if k in C_pf else 0.0] for k in plats]})

    def ids(prefix):
        return {k.split(':', 2)[2] for k in keys if k.startswith(prefix)}

    def n_people(key):
        return len(keys.get(key, ()))
    m_ids = sorted(ids('m:'), key=lambda i: (-n_people(f'm:start:{i}'), i))
    rows = [[i, n_people(f'm:brief:{i}'), n_people(f'm:start:{i}'), n_people(f'm:done:{i}'), n_people(f'm:fail:{i}'),
             n_people(f'm:quit:{i}'), C_ev[f'm:start:{i}'], C_ev[f'm:done:{i}'], share(n_people(f'm:done:{i}'), n_people(f'm:start:{i}'))]
            for i in m_ids]
    rows.append(['Tümü (kişi)', len(people_of('m:brief:')), len(people_of('m:start:')), len(people_of('m:done:')),
                 len(people_of('m:fail:')), len(people_of('m:quit:')), sum(C_ev[f'm:start:{i}'] for i in m_ids),
                 sum(C_ev[f'm:done:{i}'] for i in m_ids), share(len(people_of('m:done:')), len(people_of('m:start:')))])
    tables.append({'id': 'missions', 'title': 'Görevler (görev modu)', 'tab': 'toplam',
                   'note': '(kişi) sütunları tekil oyuncu, Başlatma ve Bitirme olay sayısı; bitirme oranı = bitiren / başlayan.',
                   'columns': ['Görev', 'Brifing (kişi)', 'Başlayan (kişi)', 'Bitiren (kişi)', 'Başarısız (kişi)', 'Bırakan (kişi)',
                               'Başlatma', 'Bitirme', 'Bitirme oranı (%)'], 'rows': rows})
    c_ids = sorted(ids('c:') | ids('cp:track:'), key=lambda i: (-(n_people(f'c:start:{i}') + n_people(f'c:done:{i}')), i))
    tables.append({'id': 'challenges', 'title': 'Serbest uçuş görevleri', 'tab': 'toplam',
                   'note': 'Kişi sayıları (tekil); Bitirme = olay sayısı. Golden Gate altı ve En iyi iniş anında biter (başlangıç yok).',
                   'columns': ['Görev', 'Takip eden', 'Başlayan', 'Bitiren', 'Başarısız', 'Vazgeçen', 'Yarım kalan', 'Bitirme'],
                   'rows': [[FFC_NAMES.get(i, i), n_people(f'cp:track:{i}'), None if i in ('bridge', 'land') else n_people(f'c:start:{i}'),
                             n_people(f'c:done:{i}'), n_people(f'c:fail:{i}'), n_people(f'c:cancel:{i}'), n_people(f'c:drop:{i}'),
                             C_ev[f'c:done:{i}']] for i in c_ids]})
    boards = Counter()
    for k, n in C_ev.items():
        if k.startswith(('lb:show:', 'lb:submit:')):
            boards[k.split(':', 3)[3]] += n
    lb_rows = [['Tümü', C_ev['l:show:m'] + C_ev['l:show:a'], len(people_of('l:show:')), C_ev['l:submit:m'], C_ev['l:submit:a'],
                len(people_of('l:submit:')), C_ev['l:fail:m'] + C_ev['l:fail:a']]]
    for b, _ in sorted(boards.items(), key=lambda kv: (-kv[1], kv[0]))[:20]:
        lb_rows.append([b, C_ev[f'lb:show:m:{b}'] + C_ev[f'lb:show:a:{b}'], len(keys.get(f'lb:show:m:{b}', set()) | keys.get(f'lb:show:a:{b}', set())),
                        C_ev[f'lb:submit:m:{b}'], C_ev[f'lb:submit:a:{b}'],
                        len(keys.get(f'lb:submit:m:{b}', set()) | keys.get(f'lb:submit:a:{b}', set())), C_ev[f'lb:fail:m:{b}'] + C_ev[f'lb:fail:a:{b}']])
    tables.append({'id': 'leaderboard', 'title': 'Sıralama tablosu', 'tab': 'toplam',
                   'note': 'Oyun içi olaylar: ilk satır hepsi, sonra en çok kullanılan 20 tablo; destekli listeler kendi tablosunun satırında.',
                   'columns': ['Tablo', 'Görüntüleme', 'Gören (kişi)', 'Gönderim (elle)', 'Gönderim (destekli)', 'Gönderen (kişi)', 'Gönderilemeyen'],
                   'rows': lb_rows})
    post = {s: n for k, n in C_api.items() for m, p, s in [k.split(' ')] if m == 'POST' and p == '/api/score'}
    tables.append({'id': 'score_api', 'title': 'Skor sunucusu', 'tab': 'toplam', 'note': 'İstek sayısı (/api/score, /api/top); sen / test hariç.',
                   'columns': ['İstek', 'Sayı'],
                   'rows': [['Kabul edilen skor', post.get('200', 0)], ['Geçersiz (400)', post.get('400', 0)], ['Sınıra takılan (429)', post.get('429', 0)],
                            ['Diğer', sum(n for s, n in post.items() if s not in ('200', '400', '429'))],
                            ['Tablo görüntüleme (GET)', sum(n for k, n in C_api.items() if k.startswith('GET /api/top '))]]})
    as_rows = []
    for state in ('1', '0', '?'):
        a = C_as.get(state)
        if a:
            as_rows.append([ASSIST_TR[state], a['n'], a['g'], share(a['gto'], a['g']), a['to'], a['ld'], a['rw'],
                            round(a['rw'] / max(a['to'], 1), 2), share(a['rwf'], a['n']), a['cr'], round(a['cr'] / a['n'], 2), a['aa']])
    tables.append({'id': 'assist', 'title': 'Destekli uçuş: kalkış ve iniş', 'tab': 'toplam',
                   'note': 'Uçuşun destekli uçuş durumuna (as) göre; uçuş = fly sinyali olan sayfa oturumu; bilinmiyor = alan eklenmeden önceki sürümler.',
                   'columns': ['Destekli uçuş', 'Uçuş', 'Yerden başlayan', 'Kalkış yapan (%)', 'Kalkış', 'İniş', 'Pist inişi',
                               'Pist inişi / kalkış', 'Pist inişi yapan uçuş (%)', 'Kaza', 'Kaza / uçuş', 'İnişe geç ile iniş'], 'rows': as_rows})
    flew = keys.get('fly', set())
    off = keys.get('as:off', set())
    on = keys.get('as:on', set())
    tables.append({'id': 'assist_off', 'title': 'Destekli uçuşu açma / kapatma', 'tab': 'toplam', 'note': 'Kişi; oran uçan oyunculara göre. Çip: uçuş ekranındaki "DESTEKLİ UÇUŞ" düğmesi.',
                   'columns': ['Adım', 'Kişi', 'Uçanların %'],
                   'rows': [[label, len(g), share(len(g), len(flew))] for label, g in (
                       ('Çipe dokunan (açıkken)', keys.get('as:chip', set())), ('Çipten kapatan', off), ('Vazgeçen', keys.get('as:keep', set()) - off),
                       ('Çipten açan', on), ("Ayarlar'dan kapatan", keys.get('s:assist', set()) - off), ("Ayarlar'dan açan", keys.get('s:assiston', set()) - on),
                       ('Başlangıç ipucunu gören', keys.get('as:hint:start', set())), ('Kaza sonrası öneriyi gören', keys.get('as:hint:crash', set())))]})
    set_rows = [[label, n_people(f's:{g}'), share(n_people(f's:{g}'), len(flew))] for g, (label, _) in SETTING_GROUPS.items()]
    set_rows += [[f'Değiştirilen: {k[3:]}', len(v), share(len(v), len(flew))]
                 for k, v in sorted(((k, v) for k, v in keys.items() if k.startswith('sk:')), key=lambda kv: (-len(kv[1]), kv[0]))]
    tables.append({'id': 'settings', 'title': 'Ayarlar', 'tab': 'toplam', 'note': 'Ayarı değiştiren kişi; oran uçan oyunculara göre.',
                   'columns': ['Ayar', 'Kişi', 'Uçanların %'], 'rows': set_rows})
    tables.append({'id': 'funnel', 'title': 'Görev hunisi', 'tab': 'toplam',
                   'note': 'Uçan oyuncular içinde kişi; görev modu ve serbest uçuş görevleri, iniş puanı hariç.',
                   'columns': ['Adım', 'Kişi', 'Uçanların %'],
                   'rows': [[label, len(g & flew), share(len(g & flew), len(flew))] for label, g in (
                       ('Uçan', flew), ('Görev paneli / menü sekmesini açan', keys.get('t:open', set())),
                       ('En az bir görev deneyen', keys.get('t:tried', set())), ('En az birini bitiren', keys.get('t:done', set())))]})
    cohorts = defaultdict(Counter)
    for k, n in C_ret.items():
        cohort, name, kind = k.split('|')
        cohorts[dt.date.fromisoformat(cohort)][(name, kind)] += n
    ret_rows, sums = [], Counter()
    for c in sorted((c for c in cohorts if any(name == 'n' for name, _ in cohorts[c])), reverse=True):
        x = cohorts[c]
        new = {k: x[('n', k)] for k in VISIT_KINDS}
        n = sum(new.values())
        tot = {name: sum(x[(name, k)] for k in VISIT_KINDS) for name in ('d1', 'd7', 'w')}
        d1_ok, d7_ok = c + dt.timedelta(days=1) <= yesterday, c + dt.timedelta(days=7) <= yesterday
        ret_rows.append([c.isoformat(), n] + [new[k] for k in VISIT_KINDS]
                        + [share(tot['d1'], n) if d1_ok else None, share(tot['d7'], n) if d7_ok else None, share(tot['w'], n) if d7_ok else None])
        if d1_ok:
            sums['n1'] += n
            sums['d1'] += tot['d1']
        if d7_ok:
            sums['n7'] += n
            sums['d7'] += tot['d7']
            sums['w'] += tot['w']
    if ret_rows:
        ret_rows.append(['Tümü', sum(r[1] for r in ret_rows)] + [sum(r[2 + i] for r in ret_rows) for i in range(len(VISIT_KINDS))]
                        + [share(sums['d1'], sums['n1']), share(sums['d7'], sums['n7']), share(sums['w'], sums['n7'])])
    tables.append({'id': 'retention', 'title': 'Geri dönüş (D1 / D7)', 'tab': 'toplam',
                   'note': 'Kimliksiz sayaç: kohort = tarayıcının ilk ziyaret günü; D1 / D7 = 1. / 7. gün yeniden gelenlerin yüzdesi, '
                           'o gün bitince dolar (27 Eylül sonrası sürümler).', 'columns': ['Kohort', 'Yeni', 'Masaüstü', 'Telefon', 'Tablet', 'D1 (%)', 'D7 (%)', '7 gün içinde (%)'],
                   'rows': ret_rows})
    if hourly is not None:
        tables.append({'id': 'hourly', 'title': 'Son 48 saat', 'tab': HOURLY_TAB,
                       'note': 'Türkiye saati, en yeni üstte (bu saat sürüyor); oyuncu = uçuş sinyali ya da uçak modeli indiren; kayıtlar ~1 saat gecikebilir.',
                       'columns': ['Saat', 'Ziyaretçi', 'Oyuncu', 'Uçuş', 'Aktif dk', 'Kalkış', 'İniş', 'Kaza', 'Görev başlatan',
                                   'Görev bitiren', 'İstanbul oyuncusu', 'Telefon (%)'], 'rows': hourly})
    payload = {'v': 1, 'generated_at': now.astimezone(IST).isoformat(timespec='seconds'), 'source': 'gokyuzu',
               'range': {'from': (days[0] if days else today).isoformat(), 'to': today.isoformat()}, 'stale': False,
               'cards': cards, 'tables': tables}
    if stale:
        mark_stale(payload, f"En yeni kayıt {last_at.astimezone(IST):%d.%m %H:%M}: erişim kayıtları gelmiyor olabilir."
                   if last_at else 'Okunan erişim kaydı yok.')
    return payload


def feed_snapshot(d, now, state=None):
    """(payload, state): the records of the days the logs of `d` cover replace those in `state` (older days keep theirs);
    the snapshot is built from all records. stale = the newest log line is more than 3 hours old."""
    state = state if state is not None else {'v': 1, 'days': {}}
    stored = state.setdefault('days', {})
    days = covered_days(d.since, now)
    skip = set()   # page sessions that began on one of the 3 stored days before the logs read (their start day counts)
    for i in range(1, 4):
        skip.update(stored.get((days[0] - dt.timedelta(days=i)).isoformat(), {}).get('sids', ()) if days else ())
    for day, r in day_records(d, days, skip).items():
        r['final'] = now >= day_start(dt.date.fromisoformat(day)) + FEED_FINAL
        r['at'] = now.isoformat(timespec='seconds')
        stored[day] = r
    old = (now.astimezone(IST).date() - dt.timedelta(days=14)).isoformat()
    for day, r in stored.items():   # session ids are only needed near the logs' start
        if day < old:
            r.pop('sids', None)
    stale = d.last_at is None or now - d.last_at > dt.timedelta(hours=3)
    return build_payload(state['days'], now, hourly_rows(d, now), d.last_at, stale), state


def load_state(path):
    p = Path(path)
    return json.loads(gzip.decompress(p.read_bytes())) if p.exists() else None


def dump_state(state):
    return gzip.compress(json.dumps(state, separators=(',', ':'), sort_keys=True).encode(), mtime=0)


def save_state(path, state):
    Path(path).write_bytes(dump_state(state))


def dump_payload(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(',', ':'))


def write_json(payload, path):
    text = dump_payload(payload)
    if path == '-':
        sys.stdout.write(text + '\n')
    else:
        Path(path).write_text(text + '\n', encoding='utf-8')
    card = {c['label']: c['value'] for c in payload['cards']}
    print(f"snapshot {payload['range']['from']} → {payload['range']['to']}: {card.get('Toplam ziyaretçi')} ziyaretçi · "
          f"{card.get('Toplam oyuncu')} oyuncu · {card.get('Toplam uçuş')} uçuş · {card.get('Toplam uçuş saati')} saat · "
          f"{len(payload['tables'])} tablo · {len(text.encode()) / 1024:.0f} KB", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', nargs='?', default='production', choices=['production', 'staging'])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--sessions', type=int, default=25, help='how many sessions to list (newest first)')
    ap.add_argument('--no-sync', action='store_true', help='use the already downloaded logs')
    ap.add_argument('--logs', type=Path, help='read the .gz logs from this folder instead (implies --no-sync)')
    ap.add_argument('--hourly', action='store_true', help='print the hour-by-hour table (Türkiye time) instead of the report')
    ap.add_argument('--map', choices=list(MAPS), help='--hourly: count only this map\'s flights in the beacon columns')
    ap.add_argument('--field', help='list the values of this beacon field per event type (e.g. as, q, dc, mq) and stop')
    ap.add_argument('--json', metavar='PATH', help='write the dashboard snapshot (stats.erenailab.com contract v1) to PATH '
                    '(- = stdout) instead of the text report')
    ap.add_argument('--state', type=Path, metavar='PATH', help='--json: per-day history (.json.gz) to merge with and update, '
                    'so days older than the logs keep counting (the stats feed keeps its own copy in S3)')
    a = ap.parse_args()

    profile = deploy_config.profile('AWS_PROFILE_ANALYTICS')
    folder = a.logs or ROOT / 'data' / 'analytics' / a.target
    if not a.no_sync and not a.logs:
        folder, new = sync(a.target, profile)
        print(f'{new} yeni kayıt dosyası indirildi.', file=sys.stderr)
    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(days=a.days)
    if a.json:
        d = load(folder, since, a.target)
        state = load_state(a.state) if a.state else None
        payload, state = feed_snapshot(d, now, state)
        if a.state:
            save_state(a.state, state)
        write_json(payload, a.json)
        return
    d = load(folder, since, a.target, geo=Geo())
    beacons, requests, visitors, days_seen = d.beacons, d.requests, d.visitors, d.days_seen
    api, api_time, api_own, blocked, hours, first_seen = d.api, d.api_time, d.api_own, d.blocked, d.hours, d.first_seen
    sessions, real = d.sessions, d.real
    label = {'production': 'canlı (fs.erenailab.com)', 'staging': 'staging'}[a.target]
    print(f'\nGökyüzü SF · {label} · son {a.days} gün')
    if a.hourly:
        report_hourly(hours, first_seen, beacons, visitors, requests, a.map)
        return
    if a.field:
        report_field(beacons, visitors, a.field)
        return
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
    report_maps(real, visitors)

    def top(counter, n=8):
        return ' · '.join(f'{k} {v}' for k, v in counter.most_common(n)) or '-'
    print('\nUçaklar:', top(Counter(AIRCRAFT.get(s['aircraft'], s['aircraft']) for s in flights)))
    print('Kalkış noktaları:', top(Counter(s['spawn'] for s in flights if s['spawn'])))
    print('Günler:', top(Counter(s['start'].astimezone().strftime('%d.%m') for s in real), 14))
    print('Ülke:', top(Counter(visitors[v]['city'] for v in real_v), 12))
    print('Tarayıcı / sistem:', top(Counter(f"{visitors[v]['browser']}/{visitors[v]['system']}" for v in real_v)))
    fps = [s['fps'] for s in real if s['fps']]
    if fps:
        # heartbeat fps is the drawn rate: phones are capped at 30 (tablets 60, or 30 when 60 is not held), so a session
        # is judged against its cap (fps_rel); sessions from before the cap was sent count against 60
        rels = [s['fps_rel'] for s in real if s['fps_rel'] is not None]
        low = sum(1 for r in rels if r < 0.8)
        caps = Counter('eski' if s['cap'] is None else 'ekran' if s['cap'] == 0 else str(s['cap']) for s in real if s['fps'])
        print(f'Performans: ortalama {statistics.mean(fps):.0f} fps · hedefin %{100 * statistics.mean(rels):.0f}’i · '
              f'hedefin %80 altında: {low} oturum · hedef (fps): {top(caps)}')
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
    dead = [(d, s) for s in real for d in s['dead']]
    if dead:
        plat = Counter(f"{visitors[s['vid']]['browser']}/{visitors[s['vid']]['system']}" for _, s in dead)
        vers = Counter((d.get('pv') or '?')[-7:] for d, _ in dead if d.get('pv'))
        print(f"Uçuşta ölen sayfa (sonraki açılışta bildirilen): {len(dead)} · uçuştan sonra medyan {statistics.median(int(d.get('after', 0)) for d, _ in dead):.0f} sn · "
              f"{top(plat, 5)}" + (f" · tarayıcı sekmeyi kapattı (wd) {sum(1 for d, _ in dead if d.get('wd') == '1')}" if any(d.get('wd') for d, _ in dead) else '')
              + (f" · ölen sayfanın sürümü: {top(vers, 4)}" if vers else ''))
    fails = Counter(f.get('ph', '?') + (' (ağ)' if f.get('net') == '1' else '') for s in real for f in s['fail'])
    if fails:
        print('Yükleme hataları:', top(fails, 5))
    if blocked:
        print('Eksik dosya (403):' if a.target == 'production' else 'IP kilidine takılan istek:', top(blocked, 5))

    report_platforms(beacons, visitors, requests)
    report_mobile(beacons, visitors, top)   # social-app webviews: banner, hand-off to the browser; touch screens' pointer queries

    # wave 7 (§12): missions, daily mission, landing score, shares, failures, leaderboard, retention
    by_day = report_missions(beacons, visitors, top)
    report_daily(by_day, days_seen, visitors)
    report_challenges(beacons, visitors, top)
    report_lb(beacons, visitors, top)
    report_funnel(beacons, visitors)
    report_landings(beacons, visitors, top)
    report_shares(beacons, visitors, top)
    report_failures(beacons, visitors, top)
    report_settings(beacons, visitors, top)
    report_leaderboard(api, api_time, api_own, top)
    report_retention(days_seen, visitors, beacons, since, a.target)
    report_visit_retention(beacons, visitors)
    report_extras(beacons, visitors, top)
    report_assist(beacons, visitors, top)
    report_comeback(beacons, visitors, top)   # retention: streak, weekly, challenge links, what's new, install, landing challenges

    print(f'\nSon {min(a.sessions, len(sessions))} oturum (anonim ziyaretçi kimliği · başlangıç · ülke · tarayıcı · uçak · süre):')
    for s in sorted(sessions, key=lambda s: s['start'], reverse=True)[:a.sessions]:
        v = visitors[s['vid']]
        ac = AIRCRAFT.get(s['aircraft'], s['aircraft'] or 'menüde kaldı')
        dur = fmt_min(s['minutes']) + (f" (aktif {s['active']} dk)" if s['active'] else '') + ('' if s['exact'] else ' ~')
        extra = ' · '.join(x for x in [(f"{s['fps']}/{s['cap']} fps" if s['cap'] else f"{s['fps']} fps") if s['fps'] else '', s['spawn'] or '', f"yükleme {s['load']} sn" if s['load'] else ''] if x)
        who = f"  [{v['who']}]" if v['who'] else ''
        print(f"  #{s['vid']}  {s['start'].astimezone():%d.%m %H:%M}  {v['city']:<16} {v['browser'] + '/' + v['system']:<16} {ac:<12} {dur}"
              + (f'  · {extra}' if extra else '') + who)


if __name__ == '__main__':
    main()
