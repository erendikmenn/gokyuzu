#!/usr/bin/env python3
"""Anonymous usage report for Gökyüzü SF from the CloudFront access logs (CONTRACTS-SF.md §11).

    .venv/bin/python tools/analytics/report.py                    # production, last 7 days
    .venv/bin/python tools/analytics/report.py staging --days 30
    .venv/bin/python tools/analytics/report.py --sessions 50      # longer session list
    .venv/bin/python tools/analytics/report.py --hourly           # hour by hour (Türkiye time) instead of the report
    .venv/bin/python tools/analytics/report.py --hourly --map ist # … only İstanbul flights (beacon columns)

Downloads new log files (profile "gokyuzu-analytics", read-only on the log bucket) into data/analytics/<target>/
(gitignored; the bucket itself deletes logs after 30 days) and prints players, sessions and minutes played.
Two sources: the game's beacons (/_e, exact: flight start, one heartbeat per active minute, errors) and, for clients
without beacons (versions before telemetry, blocked requests), sessions rebuilt from asset requests (approximate).
Nobody is identified: a visitor is a salted hash of IP + browser (salt in ~/.config/gokyuzu/analytics_salt, never
shared); raw IPs are never printed. Your own IPs (~/.config/gokyuzu/staging_ips) are marked "sen", headless test
browsers "test". Countries come from the free DB-IP Lite database (CC BY 4.0, https://db-ip.com), looked up offline.
Maps (src/maps/index.js): İstanbul beacons carry mp=ist (open / fly / mission / ffc); a session's map is its flight's
(else the page's), minutes and heartbeats follow the session; sessions rebuilt from asset requests go by assets/<map>/.
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
             'land': 'En iyi iniş', 'eng': 'Motor arızası', 'flameout': 'Alev sönmesi', 'ditch': 'Suya iniş', 'autorot': 'Otorotasyon'}


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


def report_lb(beacons, visitors, top):
    """Leaderboard use in the game (§11 `lb`): tables shown, scores submitted (with or without a nickname; the nickname
    itself is never sent), failed submissions; per board."""
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
    boards = Counter(q.get('b') or '?' for *_, q in evs if q.get('st') == 'show')
    for b, n in boards.most_common(12):
        e = [x for x in evs if x[3].get('b') == b]
        print(f"  {b:<14} görüntüleme {n} ({len(people(e, st('show')))} kişi) · gönderim {sum(1 for *_, q in e if q.get('st') == 'submit')} "
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
    c = defaultdict(Counter)
    fps, rel = defaultdict(list), defaultdict(list)
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
                    rel[h].append(fps_rel(q))
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
    new = Counter(hour_of(t) for t in first_seen.values())
    rel = release_hours()
    print(f"{'saat (TR)':<11}|{'ziyar.':>6}|{'yeni':>5}|{'oyna.':>5}|{'uçuş':>5}|{'dokun.':>6}|{'aktif dk':>8}|{'kalkış':>6}|{'iniş(pist)':>10}|{'kaza':>5}|"
          f"{'eğit.bitti':>10}|{'fps':>4}|{'hdf%':>4}|{'tel%':>4}|{'X/IG%':>5}|{'hata':>4}|{'GB':>5}|{'görev':>5}|{'ffc':>4}|{'tamam':>5}|{'ist':>4}| yayın")
    for h in sorted(hours):
        r, k, n = hours[h], c[h], len(hours[h]['vis'])
        f = statistics.mean(fps[h]) if fps[h] else 0
        fr = 100 * statistics.mean(rel[h]) if rel[h] else 0
        print(f"{h:%d.%m %H}:00|{n:6d}|{new[h]:5d}|{len(players[h]):5d}|{k['fly']:5d}|{k['touch']:6d}|{k['hb']:8d}|{k['takeoff']:6d}|"
              f"{k['land']:5d}({k['landrw']:2d})  |{k['crash']:5d}|{k['tutdone']:10d}|{f:4.0f}|{fr:4.0f}|{100 * len(r['phone']) / n:4.0f}|{100 * len(r['iab']) / n:5.0f}|"
              f"{k['err']:4d}|{r['bytes'] / 1e9:5.1f}|{len(mis[h]):5d}|{len(ffc[h]):4d}|{len(done[h]):5d}|{len(ist[h]):4d}| {rel.get(h, '')}")
    tot = set().union(*(r['vis'] for r in hours.values())) if hours else set()
    print(f"Toplam tekil ziyaretçi {len(tot)} · görev başlatan {len(set().union(*mis.values())) if mis else 0} · paneli açan "
          f"{len(set().union(*ffc.values())) if ffc else 0} · bitiren {len(set().union(*done.values())) if done else 0} · İstanbul'da uçan "
          f"{len(set().union(*ist.values())) if ist else 0} kişi" + (f' · yalnız {MAPS.get(only, only)} uçuşları' if only else '')
          + ' (saatler Türkiye saati; kişiler anonim ziyaretçi kimliği; sen/test ve botlar hariç)')


def fmt_min(m):
    return f'{m:.0f} dk' if m >= 10 else f'{m:.1f} dk'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', nargs='?', default='production', choices=['production', 'staging'])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--sessions', type=int, default=25, help='how many sessions to list (newest first)')
    ap.add_argument('--no-sync', action='store_true', help='use the already downloaded logs')
    ap.add_argument('--logs', type=Path, help='read the .gz logs from this folder instead (implies --no-sync)')
    ap.add_argument('--hourly', action='store_true', help='print the hour-by-hour table (Türkiye time) instead of the report')
    ap.add_argument('--map', choices=list(MAPS), help='--hourly: count only this map\'s flights in the beacon columns')
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
    hours = defaultdict(lambda: {'vis': set(), 'phone': set(), 'iab': set(), 'bytes': 0})   # --hourly: Türkiye hour -> requests
    first_seen = {}                      # visitor -> first request in the window
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
            'map': session_map(evs),
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
                             'version': None, 'errors': [], 'exact': False,
                             'map': next((m for m in MAPS if any(p.startswith(f'/assets/{m}/') for _, p in g)), 'sf')})

    real = [s for s in sessions if not visitors[s['vid']]['who']]
    label = {'production': 'canlı (fs.erenailab.com)', 'staging': 'staging'}[a.target]
    print(f'\nGökyüzü SF · {label} · son {a.days} gün')
    if a.hourly:
        report_hourly(hours, first_seen, beacons, visitors, requests, a.map)
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
    report_challenges(beacons, visitors, top)
    report_lb(beacons, visitors, top)
    report_funnel(beacons, visitors)
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
        extra = ' · '.join(x for x in [(f"{s['fps']}/{s['cap']} fps" if s['cap'] else f"{s['fps']} fps") if s['fps'] else '', s['spawn'] or '', f"yükleme {s['load']} sn" if s['load'] else ''] if x)
        who = f"  [{v['who']}]" if v['who'] else ''
        print(f"  #{s['vid']}  {s['start'].astimezone():%d.%m %H:%M}  {v['city']:<16} {v['browser'] + '/' + v['system']:<16} {ac:<12} {dur}"
              + (f'  · {extra}' if extra else '') + who)


if __name__ == '__main__':
    main()
