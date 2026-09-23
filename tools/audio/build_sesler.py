# -*- coding: utf-8 -*-
"""Listening page data (dev/sesler.html ← assets/audio/candidates/sesler.json): for every aural alert of every aircraft
the old sound, what ships in the game ("oyunda"), the alternatives (real cockpit clips, other voices, research
candidates), source, licence and the reason for the choice. Turkish UI text.

Inputs: assets/audio/candidates/review.json (wave-6 research rows and candidates), candidates/old/ (the sounds the
game had before wave 7), candidates/final/ (real clips, voice auditions, alternatives), the shipped files, and
tools/audio/research/{voicematch,real_clips,alertprobe}.json.
Usage: .venv/bin/python tools/audio/build_sesler.py
"""
import json
import os
import sys
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import OUT, SR, read_wav, write_wav  # noqa: E402

HERE = os.path.dirname(__file__)
RES = os.path.join(HERE, 'research')
CAND = os.path.join(OUT, 'candidates')

L_GPL = ('GPL-2.0', 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html')
L_EL = ('ElevenLabs (projenin ücretli lisansı)', 'https://elevenlabs.io/terms-of-use')
L_OWN = ('Proje sentezi (tools/audio)', None)
L_BYSA = ('CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/')
L_BY = ('CC BY 3.0', 'https://creativecommons.org/licenses/by/3.0/')
L_PD = ('Kamu malı (ABD Donanması)', 'https://www.dvidshub.net/about/copyright')


def f(rel, label=None, loop=False):
    """A playable file (rel under assets/audio, no extension) → {src, label, dur, loop} or None if missing."""
    p = os.path.join(OUT, rel + '.wav')
    if not os.path.exists(p):
        return None
    import soundfile as sf
    info = sf.info(p)
    return {'src': f'assets/audio/{rel}.wav', 'label': label or os.path.basename(rel).replace('v_', ''), 'dur': round(info.duration, 2),
            'loop': loop}


def files(*items):
    out = []
    for it in items:
        if isinstance(it, tuple):
            x = f(*it)
        else:
            x = f(it)
        if x:
            out.append(x)
    return out


def old(ac, *names):
    return files(*[(f'candidates/old/{ac}/{n}', n.replace('v_', ''), n in ('crc', 'cricket', 'shaker', 'clacker', 'wailer', 'low_rotor', 'cavalry_loop'))
                   for n in names])


def real(ac, *keys):
    rc = json.load(open(os.path.join(RES, 'real_clips.json')))
    out = []
    for k in keys:
        m = rc.get(f'{ac}/{k}', {})
        x = f(f'candidates/final/real/{ac}/{k}', f'{k} (temizlenmiş)')
        r = f(f'candidates/final/real/{ac}/{k}_raw', f'{k} (ham)')
        if x:
            x['note'] = f"kaynak SNR {m.get('snr_in_db')} dB → {m.get('verdict')}; whisper: “{m.get('transcript')}”"
            out.append(x)
        if r:
            out.append(r)
    return out


# ------------------------------------------------------------------------------------------------ comparisons
def mix_at(parts, total):
    y = np.zeros(int(total * SR))
    for t, rel in parts:
        x = read_wav(os.path.join(OUT, rel + '.wav'))
        i = int(t * SR)
        k = min(len(x), len(y) - i)
        if k > 0:
            y[i:i + k] += x[:k]
    return y


def build_compare():
    """Generated flare sequences placed at the onsets measured on the real recordings (A/B with the real ones)."""
    # A319 F-GRXM (sequence starts at 81.90 s): 50 82.06, 40 83.07, 30 84.27, 20 85.50, RETARD ×4 from 85.95 (1.07/1.23/1.23 s)
    a = [(0.16, 'a320neo/v_50'), (1.17, 'a320neo/v_40'), (2.37, 'a320neo/v_30'), (3.60, 'a320neo/v_20_retard')]
    t = 3.60 + 1.01 + 0.4
    for _ in range(3):
        a.append((t, 'a320neo/v_retard')); t += 0.62 + 0.4
    write_wav('candidates/final/compare/a320_flare_generated.wav', mix_at(a, 8.7))
    # P-8A (sequence starts at 44.10 s): 50 44.25, 40 45.25, 30 46.50, 20 47.88, 10 49.08
    b = [(0.15, 'b737/v_50'), (1.15, 'b737/v_40'), (2.40, 'b737/v_30'), (3.78, 'b737/v_20'), (4.98, 'b737/v_10')]
    write_wav('candidates/final/compare/b737_flare_generated.wav', mix_at(b, 5.7))


# ------------------------------------------------------------------------------------------------ decisions
FWC_REASON = ('FWC sesi için gerçek kayıtlar (A319 kokpit videoları) 500–20 ft, HUNDRED ABOVE, MINIMUM ve RETARD\'ı kapsıyor; '
              '2500, 1000, 10, 5, ara anonslar, STALL ve SPEED SPEED SPEED yok, Adria kayıtları da gürültülü. Aynı sistemin '
              'sesleri tek bir sesle konuşmalı (gerçek FWC tek kayıtlı ses) → FWC setinin tamamı gerçek FWC sesine en yakın '
              'ElevenLabs sesiyle üretildi: Voice Design ile tarif edilen İngiliz RP erkek sesi (klon değil), F0 116 Hz (gerçek: '
              '110 Hz), konuşma hızı gerçeğe yakın; hoparlör rengi A319 kayıtlarının uzun dönem spektrumuna eşlendi. Temizlenmiş '
              'gerçek kayıtlar alternatif olarak burada.')
EGPWS_REASON_A320 = ('Honeywell EGPWS sesi: gerçek temiz kayıt yok. Tek ses = Honeywell sesi; P-8A kaydına en yakın ElevenLabs '
                     'sesi (Adam, F0 129 Hz / gerçek 124 Hz, Amerikan). A320\'de FWC ile aynı hoparlörlerden çıktığı için A319 '
                     'kayıtlarının hoparlör rengiyle işlendi. A320 EGPWS\'inde yalnız mod 1–5 var (irtifa anonsları FWC\'den).')
EGPWS_REASON_737 = ('737\'de EGPWS hem anonsları hem uyarıları söylüyor → tek ses. P-8A\'daki gerçek anonslar (kamu malı) '
                    '3–8 dB SNR ile yalnızca referans olabilecek kadar gürültülü ve uyarı sesleri (SINK RATE, PULL UP…) hiç yok → '
                    'tüm set, P-8A sesine en yakın ElevenLabs sesiyle (Adam, F0 129/124 Hz) üretildi, hoparlör rengi P-8A '
                    'kaydına eşlendi. Temizlenmiş P-8A kayıtları alternatif olarak burada.')


def sound(key, name, system, real_txt, trigger, old_files, shipped, kind, source, lic, reason, alts=(), research=None, removed=False):
    return dict(key=key, name=name, system=system, real=real_txt, trigger=trigger, old=old_files, shipped=shipped, kind=kind,
                source=source, license=lic[0], license_url=lic[1], reason=reason, alts=list(alts), research=research,
                removed=removed)


def voice_alts(system):
    vm = json.load(open(os.path.join(RES, 'voicematch.json')))['systems'][system]
    out = []
    for r in vm['ranking']:
        x = f(f'candidates/final/voices/{system}/{r["voice"]}', f'{r["voice"]} ({"seçildi, " if r["voice"] == vm["chosen"] else ""}F0 {r["f0_hz"]} Hz, skor {r["score"]})')
        if x:
            out.append(x)
    return out


def rows():
    A, B = 'a320neo', 'b737'
    fwc_voices = voice_alts('airbus_fwc')
    egp_voices = voice_alts('honeywell_egpws')
    D = {}
    D[A] = [
        sound('callouts', 'Radyo altimetre anonsları (FWC)', 'FWC',
              'FWC sentetik sesi, 2500 ft altında hoparlörden: TWO THOUSAND FIVE HUNDRED, ONE THOUSAND, 500, 400, 300, 200, '
              '100, 50, 40, 30, 20, 10, 5 (havayolu seçimi). Yalnız alçalırken; her yükseklik bir kez.',
              'Alçalırken bant girişinde: 2500 (3000 ft üstünde yeniden kurulur), 1000 (1100 ft), 500 (11 s kilit), 400–100 '
              '(5 s), 50–5 (2 s); EGPWS konuşurken (+2 s), STALL ve SPEED SPEED SPEED sırasında susar; 10/5 RETARD sürerken çalmaz.',
              old(A, 'v_2500', 'v_1000', 'v_500', 'v_400', 'v_100', 'v_50', 'v_40', 'v_30', 'v_20', 'v_10', 'v_5'),
              files(*[f'{A}/v_{h}' for h in (2500, 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10, 5)],
                    ('candidates/final/compare/a320_flare_generated', 'flare dizisi (gerçek zamanlamayla)')),
              'üretilmiş ses (ElevenLabs, FWC sesi)', 'tools/audio/gen_voices.py (gen_fwc) + voicematch.py', L_EL, FWC_REASON,
              [{'title': 'Gerçek A320 FWC anonsları — Air France A319 F-GRXM (Sygoletto, CC BY-SA 3.0) ve Adria A319 (jan tisler, '
                         'CC BY 3.0), gürültü azaltılmış', 'files': real(A, '500', '400', '300', '200', '100', '50', '40', '30', '20', '500_b'),
                'license': 'CC BY-SA 3.0 / CC BY 3.0', 'provenance': 'real',
                'note': 'Spektral kapılama (noisereduce) + 250–4000 Hz; demucs denendi, sentetik FWC sesini çoğu klipte sildi '
                        '(−17…−77 dB) → reddedildi. Kayıttaki gürültünün kelime altındaki kısmı kalıyor.'},
               {'title': 'Gerçek flare dizisi 50→RETARD×4 (F-GRXM)', 'files': files(('candidates/final/real/sequences/a320_flare_50_to_retard', 'gerçek flare dizisi')),
                'license': 'CC BY-SA 3.0', 'provenance': 'real', 'note': 'Oyundaki üretilmiş diziyle aynı zamanlamada karşılaştırın.'},
               {'title': 'Ses seçimi — aday ElevenLabs sesleri aynı kelimelerle', 'files': fwc_voices, 'license': L_EL[0], 'provenance': 'community',
                'note': 'Skor = |F0 farkı| (yarım ton) + 6·|log2 süre oranı| + aksan cezası (Airbus yeni FWC: İngiliz RP).'}],
              'callouts'),
        sound('dh', 'HUNDRED ABOVE / MINIMUM', 'FWC', 'DH/MDA + 100 ft\'te HUNDRED ABOVE, DH\'de MINIMUM (FWC).',
              'Karar yüksekliği 200 ft (CAT I): 315 ft\'te HUNDRED ABOVE, 215 ft\'te MINIMUM, yaklaşma başına bir kez; 300/200 '
              'sayı anonslarını bastırır.',
              old(A, 'v_hundredabove', 'v_minimums'), files(f'{A}/v_hundredabove', f'{A}/v_minimum'),
              'üretilmiş ses (ElevenLabs, FWC sesi)', 'gen_voices.py', L_EL, FWC_REASON,
              [{'title': 'Gerçek HUNDRED ABOVE / MINIMUM — Adria A319 (CC BY 3.0), temizlenmiş', 'files': real(A, 'hundredabove', 'minimum', 'minimum_b'),
                'license': 'CC BY 3.0', 'provenance': 'real', 'note': 'Kaynak SNR 9–12 dB: temizlense de motor gürültüsü duyuluyor.'}]),
        sound('intermediate', 'Ara anonslar (ör. "ONE HUNDRED AND NINETY")', 'FWC',
              'FCOM: iki anons arası 11 s\'yi (50 ft altında 4 s) aşarsa o anki yükseklik 4 s\'de bir söylenir; 410 ft altında.',
              '410 ft altında, tırmanmıyorken, son anonstan 11 s (50 ft altında 4 s) sonra mevcut yükseklik 10 ft\'e yuvarlanıp '
              '4 s\'de bir.', [], files(f'{A}/v_i190', f'{A}/v_i250', f'{A}/v_i60'),
              'üretilmiş ses (ElevenLabs, FWC sesi) — yeni', 'gen_voices.py (FWC_INTERMEDIATE)', L_EL,
              'Gerçek sistemde var, oyunda yoktu. 60–390 ft arası 31 dosya.'),
        sound('retard', '"RETARD"', 'FWC',
              'FCOM: kollar IDLE/REV değilken 20 ft\'te (autoland + A/THR: 10 ft) bir kez, sonra kollar IDLE veya REV olana kadar '
              'sürekli. FWC mantığı: "TWENTY… RETARD" tek çağrı; ≈1,1 s aralıkla tekrar; 10 ve 5 bu sırada söylenmez.',
              'Manuel: 20 ft\'te "TWENTY, RETARD", autoland\'de 10 ft\'te "TEN, RETARD"; sonra kollar rölanti/ters itki olana, '
              'TOGA\'ya veya yerde 80 kt\'a kadar ≈1,1 s\'de bir "RETARD" (gerçek videoda ölçülen 1,07–1,23 s).',
              old(A, 'v_retard'), files(f'{A}/v_20_retard', f'{A}/v_10_retard', f'{A}/v_retard'),
              'üretilmiş ses (ElevenLabs, FWC sesi)', 'gen_voices.py', L_EL,
              FWC_REASON + ' Eski oyun RETARD\'ı 2,2 s\'de bir tekrarlıyor ve 20 ft anonsunun yerine koyuyordu; gerçek kayıtta '
              '"TWENTY" ile RETARD art arda ve RETARD ≈1,2 s\'de bir.',
              [{'title': 'Gerçek RETARD — F-GRXM (CC BY-SA 3.0) ve Adria (CC BY 3.0), temizlenmiş', 'files': real(A, 'retard', 'retard_b') +
                files(('candidates/final/real/sequences/a320_retard_x4', 'gerçek RETARD ×4')), 'license': 'CC BY-SA 3.0 / CC BY 3.0', 'provenance': 'real',
                'note': 'F-GRXM RETARD: kaynak SNR 17 dB, "clean enough" — tek başına oyuna konabilirdi ama FWC setinin geri kalanı '
                        'üretilmiş olduğundan ses tutarlılığı için alternatif olarak kaldı.'}], 'retard'),
        sound('crc', 'Master Warning — CRC', 'FWC',
              'Kırmızı uyarılarda sürekli tekrarlayan çan (FCOM). Frekans/kadans yayımlanmamış.',
              'OVERSPEED (VMO+4 kt / MMO+0,006, VFE, VLE), L/G GEAR NOT DOWN (750 ft RA altı, iniş takımı kilitli değil, CONF 3/FULL '
              'veya iki N1 < %75, TOGA değil), T.O CONFIG (yerde kalkış gücü + flap 0/FULL, spoiler açık veya park freni), ENG/APU FIRE '
              '(uçuş modeli yangın bildirirse). Koşul bitince, düşünce/kazada ve yeniden doğuşta susar.', old(A, 'crc'), files((f'{A}/crc', 'crc', True)), 'sentez', 'tools/audio/gen_alerts.py', L_OWN,
              'Gerçek kayıt/spec yok. Saniyede 4 çan (FlightGear A320-family ile aynı hız; doğrulanmadı), daha kısa sönüm. '
              'Eskiden yalnız aşırı hızda çalıyordu; artık gerçek FWC\'deki üç kırmızı uyarıda.', research='crc'),
        sound('single_chime', 'Master Caution — tek çan', 'FWC', 'Amber uyarılarda 0,5 s tek çan (FCOM).',
              'A/THR OFF (uçuşta, 50 ft üstünde; oyunda A/P ile birlikte ayrılır), FUEL WING TK LO LVL (toplam yakıt < 1500 kg, 30 s).',
              old(A, 'single_chime'), files(f'{A}/single_chime'), 'sentez', 'gen_alerts.py', L_OWN,
              'Eskiden yüklenip hiç çalmıyordu. Süre FCOM\'a göre 0,5 s\'ye indirildi.', research='single_chime'),
        sound('c_chord', 'İrtifa uyarısı — C-chord', 'FWC',
              'FCU irtifasına yaklaşırken (750 ft) 1,5 s, seçilen irtifadan sapınca (250 ft) sürekli; iniş takımı inik, G/S/LAND, '
              'yerde susturulur.',
              'FCU irtifası = otopilot hedefi (A/P bir kez bağlandıktan sonra). Yaklaşma: 750 ft\'te 1,5 s — yalnız A/P bağlı değilken '
              '(FBW mantığı). Sapma: yakalandıktan sonra 250–750 ft arası sürekli C-chord.',
              old(A, 'c_chord'), files(f'{A}/c_chord', (f'{A}/c_chord_loop', 'sürekli (sapma)', True)), 'sentez', 'gen_alerts.py', L_OWN,
              'Eskiden hiç tetiklenmiyordu. Frekans yayımlanmamış: Do majör üçlü (C5-E5-G5).', research='c_chord'),
        sound('cricket_stall', 'Stall — cricket + "STALL"', 'FWC',
              'Alternate/direct law\'da stall yaklaşırken cricket + "STALL" sürekli (normal law\'da yok).',
              'Oyundaki A320 normal law\'da kalıyor: yalnız gerçekten stall olunca (koruma aşılırsa) sürekli.',
              old(A, 'v_stall'), files(f'{A}/v_stall'), 'sentez + üretilmiş ses', 'gen_alerts.py + gen_voices.py', L_EL,
              'Cricket + tek "STALL" (FCOM "crickets + STALL"), FWC sesiyle.',
              [{'title': 'Cricket tek başına', 'files': files(('candidates/final/alt/a320neo/cricket', 'cricket', True)), 'license': L_OWN[0], 'provenance': 'community', 'note': ''}],
              'cricket_stall'),
        sound('speed', '"SPEED SPEED SPEED" (düşük enerji)', 'FAC → FWC sesi',
              'FAC hesaplar, FWC söyler: CONF 2/3/FULL, 100–2000 ft RA, hız VLS altına düşüyor; 5 s\'de bir. TOGA, alpha floor, GPWS '
              'uyarısı sırasında yok.',
              'CONF ≥ 2, 100–2000 ft, TOGA değil, GPWS yok; hız < VLS−10 kt veya < VLS iken yavaşlıyorsa (0,5 s teyit) 5 s\'de bir.',
              [], files(f'{A}/v_speed'), 'üretilmiş ses (ElevenLabs, FWC sesi) — yeni', 'gen_voices.py', L_EL,
              'Gerçek sistemde var, oyunda yoktu.', research='speed'),
        sound('cavalry', 'Otopilot ayırma — cavalry charge', 'FWC',
              '1660/830 Hz kare dalgalar 40 ms\'de bir (200 ms açık / 200 ms kapalı). Düğmeyle ayırmada 1,5 s; otomatik ayrılmada '
              'onaylanana kadar.',
              'Pilot ayırırsa bir kez (+ düğme tıkı); otomatik ayrılırsa O tuşuna/A/P yeniden bağlanana kadar (en çok 30 s).',
              old(A, 'cavalry', 'cavalry_loop', 'ap_button'), files(f'{A}/cavalry', (f'{A}/cavalry_loop', 'döngü', True), f'{A}/ap_button'),
              'yeniden sentez (FlightGear, GPL-2.0)', 'legoboyvdlp/A320-family PR #364 (Airbus dalga şeması)', L_GPL,
              'Değişmedi: bu bir kayıt değil, Airbus dalga şemasından yeniden sentez; Adria kaydındaki gerçek ses aynı dalga biçimini '
              'gösteriyor. Künye düzeltildi.', research='cavalry'),
        sound('pullup', '"PULL UP" / "TERRAIN AHEAD, PULL UP" (EGPWS)', 'EGPWS',
              'Mod 1 iç sınır (1464 fpm@10 ft … 7125 fpm@2450 ft) → "PULL UP" sürekli; arazi tahmini → "TERRAIN AHEAD, PULL UP".',
              'Mod 1 iç sınır (0,2 s) veya mod 2 (TERRAIN TERRAIN sonrası) → PULL UP sürekli; uçuş modelinin arazi/engel tahmini → '
              '"TERRAIN AHEAD, PULL UP".', old(A, 'v_pullup'), files(f'{A}/v_pullup', f'{A}/v_terrainahead_pullup'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py (gen_egpws)', L_EL, EGPWS_REASON_A320,
              [{'title': 'Ses seçimi — aday sesler', 'files': egp_voices, 'license': L_EL[0], 'provenance': 'community', 'note': ''}], 'pullup'),
        sound('sinkrate', '"SINK RATE, SINK RATE"', 'EGPWS', 'Mod 1 dış sınır (964 fpm@10 ft → 5008 fpm@2450 ft), her %20 kötüleşmede tekrar.',
              'Aynı zarf (0,8 s teyit), çarpmaya kalan süre %20 kısaldıkça tekrar; ikili arası 0,75 s (Honeywell standart duraklama).',
              old(A, 'v_sinkrate'), files(f'{A}/v_sinkrate'), 'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, EGPWS_REASON_A320, research='sinkrate'),
        sound('toolow', '"TOO LOW, GEAR / FLAPS / TERRAIN"', 'EGPWS',
              'Mod 4A (takım yukarı): 500 ft altı < 190 kt → TOO LOW GEAR; üstünde TOO LOW TERRAIN (500→1000 ft). Mod 4B (takım inik, '
              'flap iniş değil): 245 ft altı < 159 kt → TOO LOW FLAPS.',
              'Aynı zarflar, kalkış modunda değil, %20 irtifa kaybında tekrar. Takım inikken TOO LOW GEAR çalmaz.',
              old(A, 'v_toolow_gear', 'v_toolow_flaps', 'v_toolow_terrain'), files(f'{A}/v_toolow_gear', f'{A}/v_toolow_flaps', f'{A}/v_toolow_terrain'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, EGPWS_REASON_A320 + ' TOO LOW TERRAIN eskiden hiç çalmıyordu.', research='toolow_gear'),
        sound('terrain_m2', '"TERRAIN, TERRAIN" (mod 2)', 'EGPWS', 'Aşırı arazi yaklaşma hızı: "TERRAIN TERRAIN", sonra PULL UP; iniş konfigürasyonunda yalnız "TERRAIN".',
              'Radyo altimetre değişiminden yaklaşma hızı (MK V zarfı), 0,6 s teyit.', old(A, 'v_terrain'), files(f'{A}/v_terrain2', f'{A}/v_terrain'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, 'Eskiden dosya vardı ama tetiklenmiyordu.', research='terrain'),
        sound('dontsink', '"DON\'T SINK, DON\'T SINK"', 'EGPWS', 'Mod 3: kalkış/pas geçme sonrası 30–1500 ft\'te irtifa kaybı (5,4 + 0,092·RA ft).',
              'Kalkış modunda, iniş konfigürasyonu değilken aynı formül; her %20 ek kayıpta tekrar.', old(A, 'v_dontsink'), files(f'{A}/v_dontsink'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, 'Eskiden tetiklenmiyordu.', research='dontsink'),
        sound('glideslope', '"GLIDE SLOPE"', 'EGPWS', 'Mod 5: 1000 ft altında süzülüş yolunun 1,3 nokta altı → yarım sesle; 300 ft altında 2 nokta → yüksek sesle ikili, 3 s\'de bir.',
              'Oyundaki pistlerin 3° yolu (otopilotun ILS modeli) ile sapma hesaplanır; takım inik, LOC 2 noktadan az.',
              old(A, 'v_glideslope'), files(f'{A}/v_glideslope', f'{A}/v_glideslope2'), 'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL,
              'Eskiden tetiklenmiyordu.', research='glideslope'),
        sound('bankangle', '"BANK ANGLE"', 'EGPWS (A320\'de yok)', 'A320 FCOM\'unda EGPWS mod 6 / BANK ANGLE yok.', 'Kaldırıldı.',
              old(A, 'v_bankangle'), [], '—', '—', ('—', None), 'Gerçek A320\'de yok (FCOM\'da 0 eşleşme) → oyundan çıkarıldı.', research='bankangle', removed=True),
        sound('windshear', '"WINDSHEAR"', 'FAC/radar', 'Reaktif ve öngörülü rüzgâr kesmesi uyarıları.', 'Oyunda rüzgâr modeli yok → tetiklenmez.',
              old(A, 'v_windshear'), [], '—', '—', ('—', None), 'Uçuş modelinde rüzgâr kesmesi yok (lider için boşluk).', research='windshear', removed=True),
    ]
    D[B] = [
        sound('callouts', 'Radyo altimetre anonsları (EGPWS mod 6)', 'EGPWS',
              'FCOM tipik: TWENTY FIVE HUNDRED, ONE THOUSAND, FIVE HUNDRED, ONE HUNDRED, 50, 40, 30, 20, 10; yaklaşma başına bir kez, '
              '1000 ft üstünde yeniden kurulur.',
              'Aşağı geçişte bir kez; aşılan her şey kilitlenir; 1000 ft üstünde (kalkış modu dışında) yeniden kurulur; uyarılar '
              'sırasında söylenmez.',
              old(B, 'v_2500', 'v_1000', 'v_500', 'v_100', 'v_50', 'v_40', 'v_30', 'v_20', 'v_10'),
              files(*[f'{B}/v_{h}' for h in (2500, 1000, 500, 100, 50, 40, 30, 20, 10)], ('candidates/final/compare/b737_flare_generated', 'flare dizisi (P-8A zamanlaması)')),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py (gen_egpws)', L_EL, EGPWS_REASON_737,
              [{'title': 'Gerçek anonslar — P-8A (ABD Donanması, kamu malı), temizlenmiş', 'files': real(B, '500', 'apprmin', '50', '40', '30', '20', '10') +
                files(('candidates/final/real/sequences/b737_flare_50_to_10', 'gerçek flare dizisi')), 'license': L_PD[0], 'provenance': 'real',
                'note': 'Kaynak SNR 3–8 dB: kelimeler anlaşılır ama gürültü baskın → yalnız referans.'},
               {'title': 'Ses seçimi — aday sesler', 'files': egp_voices, 'license': L_EL[0], 'provenance': 'community', 'note': ''}], 'callouts'),
        sound('minimums', 'APPROACHING MINIMUMS / MINIMUMS', 'EGPWS', 'DH+80 ft APPROACHING MINIMUMS (seçenek, her iki gerçek kayıtta var), DH\'de MINIMUMS; takım inik olmalı.',
              'DH 200 ft: 280 ft\'te APPROACHING MINIMUMS, 200 ft\'te MINIMUMS; bir kez.', old(B, 'v_hundredabove', 'v_minimums'),
              files(f'{B}/v_apprmin', f'{B}/v_minimums'), 'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, EGPWS_REASON_737),
        sound('pullup', '"PULL UP" / "TERRAIN TERRAIN PULL UP"', 'EGPWS', 'Boeing: düz "PULL UP" (whoop-whoop yok). Arazi tahmini: TERRAIN TERRAIN PULL UP.',
              'A320 ile aynı mod 1/2 mantığı; arazi tahmini → "TERRAIN, TERRAIN, PULL UP", sonra PULL UP sürekli.',
              old(B, 'v_pullup'), files(f'{B}/v_pullup', f'{B}/v_terrain_pullup'), 'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL,
              EGPWS_REASON_737 + ' Eski dosyadaki iki "whoop" kaldırıldı (Boeing FCOM\'unda yok).', research='pullup'),
        sound('sinkrate', '"SINK RATE, SINK RATE"', 'EGPWS', 'Mod 1 dış sınır.', 'A320 ile aynı.', old(B, 'v_sinkrate'), files(f'{B}/v_sinkrate'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, EGPWS_REASON_737, research='sinkrate'),
        sound('toolow', '"TOO LOW, GEAR / FLAPS / TERRAIN"', 'EGPWS', 'Mod 4A/4B (MK V).', 'A320 ile aynı zarflar; iniş flapı = 30/40.',
              old(B, 'v_toolow_gear', 'v_toolow_flaps', 'v_toolow_terrain'), files(f'{B}/v_toolow_gear', f'{B}/v_toolow_flaps', f'{B}/v_toolow_terrain'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, EGPWS_REASON_737, research='toolow_gear'),
        sound('terrain_m2', '"TERRAIN, TERRAIN" (mod 2)', 'EGPWS', 'Mod 2.', 'A320 ile aynı.', old(B, 'v_terrain'), files(f'{B}/v_terrain2', f'{B}/v_terrain'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, 'Eskiden tetiklenmiyordu.', research='terrain'),
        sound('dontsink', '"DON\'T SINK"', 'EGPWS', 'Mod 3.', 'A320 ile aynı.', old(B, 'v_dontsink'), files(f'{B}/v_dontsink'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, 'Eskiden tetiklenmiyordu.', research='dontsink'),
        sound('glideslope', '"GLIDE SLOPE"', 'EGPWS', 'Mod 5.', 'A320 ile aynı.', old(B, 'v_glideslope'), files(f'{B}/v_glideslope', f'{B}/v_glideslope2'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, 'Eskiden tetiklenmiyordu.', research='glideslope'),
        sound('bankangle', '"BANK ANGLE, BANK ANGLE"', 'EGPWS', 'FCOM: 35°, 40°, 45° geçildikçe bir kez; 30° altına inince sıfırlanır.',
              'Aynı (eskiden 35° üstünde 1,2 s\'de bir tekrarlıyordu).', old(B, 'v_bankangle'), files(f'{B}/v_bankangle'),
              'üretilmiş ses (ElevenLabs, Honeywell sesi)', 'gen_voices.py', L_EL, EGPWS_REASON_737, research='bankangle'),
        sound('gear_horn', 'İniş takımı kornası (sürekli)', 'Boeing aural uyarı', 'FCOM: flap UP–10 + 800 ft RA altı + kol rölantiye yakın; flap 15–25 + kol rölanti; flap > 25 her itkide.',
              'Aynı kurallar (takım kilitli değilken, havada). Korna kesme düğmesi oyunda yok.', [], files((f'{B}/horn', 'sürekli korna', True)),
              'sentez (gerçek P-8A kornasının ölçülen tınısı)', 'gen_alerts.py (P-8A ölçümü)', L_OWN,
              'Eskiden 737\'de iniş takımı kornası yoktu (sesli "TOO LOW GEAR" vardı). P-8A kaydındaki kornanın 202 Hz harmonik '
              'dizisi ölçülüp sürekli çalınıyor (aynı korna ailesi, doğrulanmadı).', research='gear_horn'),
        sound('config_horn', 'Kalkış konfigürasyonu kornası (kesikli)', 'Boeing aural uyarı', 'Yerde kalkış gücünde flap 1–25 dışı, spoiler kolu inik değil, park freni…',
              'Yerde kol ≥ 0,6 ve (flap UP veya 30/40, spoiler açık, park freni) → kesikli korna; düzeltilince susar.', [],
              files((f'{B}/horn_int', 'kesikli korna', True)), 'sentez (gerçek kaydın ölçümüyle)', 'gen_alerts.py', L_OWN,
              'P-8A kaydındaki gerçek korna: 202 Hz harmonik dizi (h3–h25 seviyeleri ölçüldü), 0,21 s açık / 0,52 s periyot. '
              'Kaydın kendisi 3–5 dB SNR ile çok gürültülü → ölçümle yeniden sentez.',
              [{'title': 'Gerçek kesikli korna — P-8A (kamu malı)', 'files': files(('candidates/final/real/sequences/b737_config_horn', 'gerçek korna')),
                'license': L_PD[0], 'provenance': 'real', 'note': 'Dokun-kalk sırasında; en olası: kalkış konfigürasyon uyarısı.'}], 'config_horn'),
        sound('clacker', 'Aşırı hız clacker\'ı', 'Boeing aural uyarı', 'Yalnız VMO/MMO; hız düşünce susar.', 'IAS > VMO veya Mach > MMO (flap/takım hızlarında değil).',
              old(B, 'clacker'), files((f'{B}/clacker', 'clacker', True)), 'sentez', 'gen_alerts.py', L_OWN,
              'Eskiden VFE/VLE aşımında da çalıyordu; gerçek 737\'de yalnız VMO/MMO.', research='clacker'),
        sound('shaker', 'Stick shaker', 'Boeing (SMYD)', 'Stall AOA\'sı yaklaşırken kolonları titreten eksantrik motor.', 'Uçuş modelinin shaker AOA\'sı (havada).',
              old(B, 'shaker'), files((f'{B}/shaker', 'shaker', True)), 'sentez', 'gen_alerts.py', L_OWN, 'Değişmedi.', research='shaker'),
        sound('alt_alert', 'İrtifa uyarı tonu', 'Boeing (MCP irtifa uyarısı)', 'Seçilen irtifaya 900 ft kala anlık ton; yakalandıktan sonra 300 ft sapmada ton; flap ≥ 25 veya G/S\'te yok.',
              'MCP irtifası = otopilot hedefi (A/P bir kez bağlandıktan sonra); aynı eşikler, A/P bağlıyken de.', old(B, 'c_chord'),
              files(f'{B}/alt_alert'), 'sentez (gerçek 737NG kaydının ölçümüyle)', 'gen_alerts.py', L_OWN,
              'Transaero 737NG kokpit kaydında (yalnız analiz; lisansı doğrulanmadığı için dağıtılmıyor) alçalma boyunca 4 kez '
              'aynı akor: 503,9 / 629,9 / 755,9 Hz (4:5:6), 1,13 s, sabit. Oyunda eskiden Airbus C-chord\'u kullanılıyordu.', research='alt_alert'),
        sound('wailer', 'Otopilot ayırma — wailer', 'Boeing', 'Ayırma düğmesiyle en az 2 s; otomatik ayrılmada sıfırlanana kadar.',
              'Pilot: 2,2 s; otomatik: O tuşuna/A/P yeniden bağlanana kadar (en çok 30 s).', old(B, 'wailer'), files((f'{B}/wailer', 'wailer', True)),
              'FlightGear 737-800YV (GPL-2.0)', 'YV3399/737-800YV Sounds/Apdisco.wav', L_GPL,
              'Hâlâ en iyi aday: gerçek kayıt bulunamadı (Transaero kaydında da yok), sentez adayları daha yapay.', research='wailer'),
        sound('fire_bell', 'Yangın zili', 'Boeing', 'FCOM: motor/APU/tekerlek yuvası/kargo yangını; BELL CUTOUT ile susar (motor aşırı ısınmasında zil yok).',
              'Uçuş modeli yangın bildirirse (warnings.fire / engineFire / apuFire) koşul sürdükçe; şu an hiçbir uçuş modelinde yangın yok.',
              [], files((f'{B}/fire_bell', 'zil', True)), 'sentez (ölçülmüş zil)', 'gen_alerts.py (fire_bell)', L_OWN,
              'Kısmi ve tını 737-800YV FlightGear fire-bell.wav\'dan ölçüldü (GPL-2.0, kökeni belirtilmemiş gerçek bir zil; yalnız '
              'ölçüm): 1333 / 2266 Hz en güçlü, sonra 2665 / 596 / 366 Hz, saniyede 15 vuruş. Tetikleme tek satırlık bayrak eşlemesi '
              '(alertlogic.js FLAGS.fire) — yangın modeli gelince çalışır.',
              [{'title': 'FlightGear 737-800YV fire-bell (ölçüm kaynağı)', 'files': files(('candidates/b737/fire_bell/b737yv_firebell', 'YV zil')), 'license': L_GPL[0],
                'provenance': 'community', 'note': '11 kHz / 0,57 s.'}], 'fire_bell'),
        sound('master_caution', 'Master caution çanı', 'Boeing', 'b737.org.uk ve FCOM: 737\'de master caution\'ın sesi yok (yalnız ışık).',
              'Kaldırıldı.', old(B, 'chime'), [], '—', '—', ('—', None), 'Eski "ding-dong" gerçek 737\'de yok → kaldırıldı.', research='crew_call', removed=True),
    ]
    F = 'f16'
    D[F] = [
        sound('warning', '"WARNING WARNING … WARNING WARNING"', 'VMS', 'Dash-1: herhangi bir gösterge paneli uyarı ışığı yandıktan 1,5 s sonra; yerde (WOW) VMS çalışmaz.',
              'Uyarı ışıkları: TO/LDG CONFIG (10 000 ft altı, < 190 kt, > 250 fpm alçalma, takım kilitli değil), ENGINE (devir < %55), '
              'CANOPY (havada kanopi açık), ENG FIRE (uçuş modeli bildirirse) → 1,5 s sonra bir kez.', old(F, 'v_warning'), files(f'{F}/v_warning'),
              'üretilmiş ses (ElevenLabs, VMS sesi)', 'gen_voices.py (gen_vms)', L_EL,
              'Eskiden stall\'da çalıyordu (gerçekte yok). Kelime bir kez kaydedilip aynen tekrarlanıyor (VMS gibi). Gerçek kayıt yok.', research='warning'),
        sound('caution', '"CAUTION CAUTION"', 'VMS', 'Uyarı paneli ışığı yandıktan 7 s sonra.', 'FWD/AFT FUEL LOW (≈ 650 lb) ışığından 7 s sonra bir kez.',
              old(F, 'v_caution'), files(f'{F}/v_caution'), 'üretilmiş ses (ElevenLabs, VMS sesi)', 'gen_voices.py', L_EL,
              'Eskiden aşırı hızda çalıyordu; F-16\'da aşırı hız sesli uyarısı yok.', research='caution'),
        sound('pullup', '"PULLUP PULLUP PULLUP PULLUP"', 'VMS', 'Otomatik fly-up / TF arızası / yer-kaçınma tavsiyesi (GAAF).', 'Uçuş modelinin arazi tahmini → sürekli.',
              old(F, 'v_pullup'), files(f'{F}/v_pullup'), 'üretilmiş ses (ElevenLabs, VMS sesi)', 'gen_voices.py', L_EL, 'Dash-1 yazımıyla 4 kez.', research='pullup'),
        sound('altitude', '"ALTITUDE ALTITUDE"', 'VMS', 'Radar altimetre CARA ALOW altına inince (takım yukarı); kalkıştan sonra ALOW üstüne çıkınca kurulur.',
              'ALOW 500 ft (pilot girer; tek bulunan varsayılan), takım yukarı, geçişte bir kez.', old(F, 'v_altitude'), files(f'{F}/v_altitude'),
              'üretilmiş ses (ElevenLabs, VMS sesi)', 'gen_voices.py', L_EL, 'Eskiden takım inikken alçalma hızına bağlıydı.', research='altitude'),
        sound('bingo', '"BINGO BINGO"', 'VMS', 'Girilen bingo yakıtına inince bir kez.', 'Bingo 1500 lb (680 kg), bir kez.', old(F, 'v_bingo'), files(f'{F}/v_bingo'),
              'üretilmiş ses (ElevenLabs, VMS sesi)', 'gen_voices.py', L_EL, 'Eşik gerçek varsayılana (pilot girer) yaklaştırıldı.', research='bingo'),
        sound('gear_horn', 'İniş takımı uyarı kornası (ton)', 'F-16 ses sistemi', 'DTIC AD-A145469: 250 ± 50 Hz, 5 ± 1 Hz kesikli; takım inik değil, < 190 kt, < 10 000 ft, > 250 fpm alçalma.',
              'Aynı koşullar (0,5 s teyit); VMS konuşurken ve düşük hız tonu varken susar.', old(F, 'v_gear'), files((f'{F}/lg_horn', 'korna 5 Hz', True)),
              'sentez (gerçek F-16 tonunun spektrumuyla)', 'gen_alerts.py', L_OWN,
              'Eskiden sesli "LANDING GEAR" vardı — VMS\'de böyle bir mesaj yok. 250 Hz kare dalganın harmonikleri, Auto-GCAS HUD '
              'kaydındaki gerçek 241 Hz kare tona göre ayarlandı.', research='gear_horn'),
        sound('lowspeed_tone', 'Düşük hız uyarı tonu', 'F-16 ses sistemi', 'Sabit 250 Hz: takım inik/ALT FLAPS iken AOA ≥ 15°; takım yukarı iken burun 45–90° ve hız < 2,22 × yunuslama.',
              'Aynı; LG kornasından öncelikli, VMS konuşurken susar.', old(F, 'v_lowspeed'), files((f'{F}/low_speed', 'sabit ton', True)),
              'sentez', 'gen_alerts.py', L_OWN, 'Eskiden stall\'da sesli "WARNING" vardı.', research='lowspeed_tone'),
        sound('overg', '"OVER G"', '—', 'F-16 VMS listesinde yok.', 'Kaldırıldı.', old(F, 'v_overg'), [], '—', '—', ('—', None),
              'Gerçek F-16\'da yok → kaldırıldı.', research='overg', removed=True),
    ]
    G = 'f22'
    D[G] = [
        sound('caution', 'ICAW caution tonu', 'ICAWS', 'DoD IG 2013 / 2010 kaza raporu: caution ICAW\'ları "aural tone" + HUD\'da CAUT.',
              'FUEL LOW (%12 altı) → bir kez.', old(G, 'v_caution'), files(f'{G}/caution'), 'sentez (biçim varsayım)', 'gen_alerts.py', L_OWN,
              'Tonun varlığı kaynaklı, sesi yayımlanmamış: iki kısa 1,2 kHz bip.', research='caution'),
        sound('warning', 'ICAW uyarısı: ton + ses ("LANDING GEAR", "LEFT/RIGHT ENGINE FAIL")', 'ICAWS',
              'AGARD AR-349: uyarılar kulaklığa da gelir; CNI\'da ses sentezi var. Kelime listesi yayımlanmamış.',
              'Takım yukarı + < 10 000 ft + < 200 kt + alçalma → ton + "LANDING GEAR" (4 s arayla); motor < %55 → ton + "LEFT/RIGHT ENGINE FAIL".',
              old(G, 'v_warning', 'v_gear'), files(f'{G}/v_gear', f'{G}/v_engfail_l', f'{G}/v_engfail_r'), 'üretilmiş ses (ElevenLabs, ayrı kadın sesi) + sentez ton',
              'gen_voices.py (gen_icaws)', L_EL, 'F-16 VMS kopyası yerine ayrı set; kelimeler varsayım (ICAW adları), ses F-16\'dan farklı (Matilda).', research='warning'),
        sound('pullup', '"PULL UP, PULL UP"', 'ICAWS', 'Doğrulanamadı (Auto-GCAS/LAWS ailesi varsayımı).', 'Arazi tahmini → sürekli.', old(G, 'v_pullup'),
              files(f'{G}/v_pullup'), 'üretilmiş ses (ElevenLabs)', 'gen_voices.py', L_EL, 'Varsayım (L).', research='pullup'),
        sound('altitude', '"ALTITUDE"', '—', 'LAWS pilot tarafından ayarlanır, varsayılan kapalı (2010 kaza raporu).', 'Kaldırıldı.', old(G, 'v_altitude'), [], '—', '—', ('—', None),
              'Varsayılan kapalı olduğu için oyunda yok.', research='altitude', removed=True),
        sound('lowspeed', 'Düşük hız / stall', '—', 'Kaynak yok.', 'Kaldırıldı.', old(G, 'v_lowspeed'), [], '—', '—', ('—', None), 'Kaynak yok → kaldırıldı.', research='lowspeed', removed=True),
        sound('overg', '"OVER G"', '—', 'Yalnız F-15\'te belgeli; F-22 için yok.', 'Kaldırıldı.', old(G, 'v_overg'), [], '—', '—', ('—', None), 'F-22 için kaynak yok.', research='overg', removed=True),
        sound('bingo', '"BINGO"', '—', 'Kaynak yok.', 'Kaldırıldı (yakıt az → caution tonu).', old(G, 'v_bingo'), [], '—', '—', ('—', None), '', research='bingo', removed=True),
    ]
    H = 'uh60'
    VWS_REASON = ('UH-60M kullanma kılavuzu (TM 1-1520-280-10) kısıtlı dağıtımlı; açık kaynaklar M\'de "low rotor RPM audio", '
                  '"engine out audio" ve radar altimetre "low bug audio" olduğunu söylüyor ama sözcükleri vermiyor. Belgelenmiş en '
                  'yakın Ordu H-60 sesli uyarı sistemi MH-60K VWS (TM 1-1520-250-10, par. 2-227, tablo 2-6): öncelik 2 = 2 s sürekli '
                  '250 Hz ton, 0,5 s, mesaj, 1 s, mesaj; öncelik 4 = mesaj ×3; 1 s ara ile tekrar. UH-60A/L\'nin "alçak sabit ton"u '
                  'bu döngünün başındaki sürekli ton. Bu biçim UH-60M için vekil olarak kullanıldı (M düzeyi güven); ses ElevenLabs '
                  '"Bella" (F-16/F-22 seslerinden farklı), kulaklık zinciri. Oyunda VOICE ACK düğmesi olmadığından aynı anda etkin '
                  'mesajlar sırayla çalar; koşul bitince mesaj hemen kesilir.')
    D[H] = [
        sound('low_rotor', '"LOW ROTOR" (2 s sabit 250 Hz ton + mesaj ×2)', 'UH-60M sesli uyarı (MH-60K VWS biçimi)',
              'TM 1-1520-237-10: NR < %96 (2000 öncesi %95) → yanıp sönen LOW ROTOR RPM ışığı + "alçak sabit ton", yerde (WOW) '
              'susar. MH-60K: aynı koşulda ton + "LOW ROTOR". Rotor aşırı devri (yüksek NR) için hiçbir H-60 kılavuzunda ses yok.',
              'Havada NR < %96 (histerezis %97) → döngü koşul sürdükçe tekrar; NR düzelince kesilir. NR %124 (kolektif dipte) → ses YOK.',
              old(H, 'low_rotor', 'v_lowrotor'), files(f'{H}/v_lowrotor'), 'üretilmiş ses (ElevenLabs "Bella") + sentez ton',
              'gen_voices.py (gen_uh60) + gen_alerts.steady_tone', L_EL,
              VWS_REASON + ' Eskiden 4 Hz çift tonlu siren ("müzik gibi") vardı ve kolektif dipteyken yüksek rotor devrinde de çalıyordu.',
              [{'title': 'Alternatif: yalnız ton (UH-60A/L "low steady tone")', 'files': files(('candidates/final/alt/uh60/low_rotor_tone', 'sabit 250 Hz', True)),
                'license': L_OWN[0], 'provenance': 'community', 'note': 'Sesli mesaj olmadan; UH-60A/L kılavuzuna birebir.'}], 'low_rotor'),
        sound('eng_out', '"ENGINE ONE OUT" / "ENGINE TWO OUT"', 'UH-60M sesli uyarı (MH-60K VWS biçimi)',
              'TM 1-1520-237-10: Ng ≤ %55 → #1/#2 ENG OUT ışığı + ton, yerde de çalar. MH-60K: ton + "ENGINE 1/2 OUT" (öncelik 2).',
              'Motor Ng ≤ %55 (rotor dönerken) → 2 s ton + mesaj ×2, koşul sürdükçe; motor düzelince kesilir.', [],
              files(f'{H}/v_eng1out', f'{H}/v_eng2out'), 'üretilmiş ses (ElevenLabs "Bella") + sentez ton', 'gen_voices.py (gen_uh60)', L_EL,
              VWS_REASON + ' Oyunda eskiden motor arızası sesi yoktu.', research='low_rotor'),
        sound('alt_low', '"ALTITUDE LOW" (mesaj ×3)', 'UH-60M radar altimetre / VWS',
              'ARL 2006 UH-60M değerlendirmesi: "low bug audio" var. MH-60K: RALT SET altına inince "ALTITUDE LOW" (öncelik 4).',
              'Radar irtifası 50 ft low bug\'ın altına > 300 fpm alçalarak inince bir kez (75 ft üstünde yeniden kurulur); yavaş, '
              'kontrollü iniş/hover\'da çalmaz (pilot bug\'ı indirir/onaylar).', old(H, 'v_altitude'), files(f'{H}/v_altlow'),
              'üretilmiş ses (ElevenLabs "Bella")', 'gen_voices.py (gen_uh60)', L_EL, VWS_REASON + ' Eski sesli "ALTITUDE" alçalma hızına bağlıydı.',
              [{'title': 'Alternatif: üç kısa 1 kHz bip (biçim varsayım)', 'files': files(('candidates/final/alt/uh60/lobug', 'low bug bip')), 'license': L_OWN[0],
                'provenance': 'community', 'note': ''}], 'altitude'),
        sound('pullup', '"PULL UP"', '—', 'UH-60/UH-60M için belgelenmemiş (TAWS yok).', 'Kaldırıldı.', old(H, 'v_pullup'), [], '—', '—', ('—', None), 'Kaynak yok → kaldırıldı.', research='pullup', removed=True),
        sound('bankangle', '"BANK ANGLE"', '—', 'UH-60 için belgelenmemiş.', 'Kaldırıldı.', old(H, 'v_bankangle'), [], '—', '—', ('—', None), 'Kaynak yok → kaldırıldı.', research='bankangle', removed=True),
        sound('stab_beep', 'Stabilatör bip tonu / "STABILATOR"', 'UH-60', 'Stabilatör otomatik mod arızasında bip (MH-60K: öncelik 1, kesikli ton + "STABILATOR"); MASTER CAUTION ile susar.',
              'Oyunda stabilatör arızası yok.', [], [], '—', '—', ('—', None), 'Uçuş modelinde yok (boşluk).', research='stab_beep', removed=True),
    ]
    return D


SYSTEMS = {
    'a320neo': [('FWC (uçuş uyarı bilgisayarı)', 'Otomatik anonslar, RETARD, HUNDRED ABOVE/MINIMUM, ara anonslar, STALL, SPEED SPEED SPEED; CRC, tek çan, C-chord, cavalry',
                 'Voice Design İngiliz RP erkek sesi (F0 116 Hz; gerçek FWC 110 Hz)'),
                ('Honeywell EGPWS (mod 1–5)', 'SINK RATE, PULL UP, TERRAIN…, TOO LOW…, DON\'T SINK, GLIDE SLOPE (BANK ANGLE yok)', 'Adam (Amerikan erkek, F0 129 Hz)')],
    'b737': [('Honeywell MK V EGPWS (mod 1–6)', 'Tüm sesli anons ve uyarılar', 'Adam (F0 129 Hz; P-8A kaydı 124 Hz)'),
             ('Boeing aural uyarı modülü', 'Kornalar, clacker, stick shaker, irtifa tonu, wailer', 'ses yok (tonlar)')],
    'f16': [('VMS (sesli mesaj sistemi)', 'WARNING, CAUTION, ALTITUDE, BINGO, PULLUP', 'Sarah (kadın; kulaklık)'),
            ('Ses tonları', 'LG uyarı kornası (250 Hz, 5 Hz), düşük hız tonu (250 Hz sabit)', '—')],
    'f22': [('ICAWS', 'Caution tonu; uyarı tonu + ses (LANDING GEAR, ENGINE FAIL); PULL UP', 'Matilda (F-16\'dan farklı kadın sesi)')],
    'uh60': [('Sesli uyarı sistemi (MH-60K VWS biçimi, UH-60M için vekil)', 'ENGINE 1/2 OUT, LOW ROTOR (2 s sabit 250 Hz ton + mesaj ×2); '
              'ALTITUDE LOW (low bug); rotor aşırı devrinde ses yok', 'Bella (kadın; kulaklık)')],
}


def main():
    build_compare()
    review = json.load(open(os.path.join(CAND, 'review.json')))
    by = {a['id']: a for a in review['aircraft']}
    probe = {}
    pp = os.path.join(RES, 'alertprobe.json')
    if os.path.exists(pp):
        probe = json.load(open(pp))
    D = rows()
    out = {'generated': '2026-09-23', 'aircraft': [], 'sources': review.get('sources', []), 'references': review.get('references', []),
           'intro': ('Her satır: gerçek uçakta ne olduğu, oyunda eskiden ne çaldığı, şimdi oyunda ne çaldığı ("oyunda"), alternatifler '
                     '(gerçek kokpit kayıtları, başka sesler, araştırma adayları), kaynak, lisans ve seçimin nedeni. Kural: her gerçek '
                     'sistem tek sesle konuşur; bir sistemin tüm seti temiz gerçek kayıtlarla karşılanamıyorsa set, gerçek sese en yakın '
                     'ElevenLabs sesiyle baştan üretilir (klon yok). Ayrıntı: tools/audio/research/alerts.md.')}
    for ac, rs in D.items():
        R = by.get(ac, {})
        rmap = {s['key']: s for s in R.get('sounds', [])}
        for r in rs:
            rr = rmap.get(r.pop('research') or '')
            if rr:
                r['research_candidates'] = rr.get('candidates', [])
                r['research_real'] = rr.get('real')
        out['aircraft'].append({'id': ac, 'name': R.get('name', ac), 'systems': [{'name': a, 'what': b, 'voice': c} for a, b, c in SYSTEMS[ac]],
                                'probe': probe.get(ac, []), 'sounds': rs})
    with open(os.path.join(CAND, 'sesler.json'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    n = sum(len(a['sounds']) for a in out['aircraft'])
    print(f'sesler.json: {len(out["aircraft"])} aircraft, {n} rows')


if __name__ == '__main__':
    main()
