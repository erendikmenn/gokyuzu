"""Curate the sub-agents' DVIDS / Commons / Internet Archive finds (found_mil.json, found_air.json) into
external_candidates.json (candidate records for review_data.py). Turkish UI text."""
import json
import os

HERE = os.path.dirname(__file__)
air = json.load(open(os.path.join(HERE, 'found_air.json')))['items']


def pick(prefix, sound_prefix=None, only=None):
    out = []
    for f in air:
        if prefix not in f['orig']:
            continue
        if sound_prefix and not f['sound'].startswith(sound_prefix):
            continue
        if only and f['sound'] not in only:
            continue
        out.append(f)
    return out


def files(items, pad=(0.08, 0.15), label=True):
    fs = []
    for f in items:
        s, e = f['segment']
        fs.append(dict(orig=f['orig'], label=(f.get('transcript') or '').strip() if label else '',
                       segment=[max(0.0, s - pad[0]), e + pad[1]]))
    return fs


BCDG = dict(source_url='https://commons.wikimedia.org/wiki/File:Ba%C3%AFonnette_CDG.ogv', license='CC BY-SA 3.0 (veya GFDL)',
            license_url='https://creativecommons.org/licenses/by-sa/3.0/',
            credit='Sygoletto / Wikimedia Commons, CC BY-SA 3.0 — lisans bağlantısı + "değiştirildi" notu; kesilmiş/işlenmiş ses '
                   'dosyaları da CC BY-SA 3.0 ile paylaşılmalı (oyun kodu etkilenmez).',
            provenance='real',
            provenance_note='Commons açıklaması (yükleyenin kendi eseri): "Video from the cockpit of Airbus A319-111 aircraft (reg. '
                            'F-GRXM) of Air France landing on the runway 26R at Paris-Charles de Gaulle Airport" (2010). Anonslar uçağın '
                            'FWC sesi, kamera mikrofonuyla kaydedilmiş.')
ADRIA = dict(source_url='https://commons.wikimedia.org/wiki/File:Adria_Airways_A319_Night_landing_takeoff_Frankfurt_%2B_Landing_at_Ljubljana_(cockpit).ogv',
             license='CC BY 3.0', license_url='https://creativecommons.org/licenses/by/3.0/',
             credit='jan tisler (YouTube "aircraft16"), Wikimedia Commons üzerinden, CC BY 3.0 — lisans bağlantısı + "değiştirildi" notu.',
             provenance='real',
             provenance_note='Commons: YouTube CC-BY yüklemesi, lisansı Commons\'ta doğrulanmış (MZaplotnik, 2014). Başlık: "Adria Airways '
                             'A319 Night landing takeoff Frankfurt + Landing at Ljubljana (cockpit)", uçak S5-AAP. Sesler kokpitteki kamera '
                             'mikrofonundan.')
P8 = dict(source_url='https://www.dvidshub.net/video/910648/p-8a-poseidon-night-approach', license='Kamu malı (ABD Donanması)',
          license_url='https://www.dvidshub.net/about/copyright',
          credit='Zorunlu değil. Önerilen: "U.S. Navy video by MC2 Jacquelin Frost / DVIDS". DoD onayı ima edilmemeli.',
          provenance='real',
          provenance_note='DVIDS: "A b-roll package of a P-8A Poseidon attached to Patrol Squadron (VP) 46 … conducting an approach at night '
                          'at Lamezia Terme International Airport, Italy, Jan. 11, 2024." Uçakta Donanma kameramanınca çekilmiş; '
                          '"Courtesy" işareti yok. P-8A = 737-800ERX tabanlı askeri türev.')
IRK = dict(source_url='https://archive.org/details/youtube-_0F9Ojz705s', license='CC BY 3.0',
           license_url='https://creativecommons.org/licenses/by/3.0/',
           credit='Vnebelaynery (YouTube, https://www.youtube.com/watch?v=_0F9Ojz705s), CC BY 3.0 — lisans bağlantısı + "değiştirildi".',
           provenance='real',
           provenance_note='Yükleyen: "Полное видео посадки в Иркутске из кабины пилотов. Архив от 23 апреля 2015 года." (Irkutsk\'a '
                           'inişin kokpitten tam videosu), etiketler "B737NG", "Transaero". Lisans, Internet Archive\'ın 2020 kopyasındaki '
                           'YouTube bilgisinden (CC BY); yayından önce canlı YouTube sayfasında yeniden kontrol edilmeli.')
TCAS = dict(license='CC BY-SA 3.0 (veya GFDL)', license_url='https://creativecommons.org/licenses/by-sa/3.0/',
            credit='Unnamedboy / Wikimedia Commons, CC BY-SA 3.0', provenance='unknown',
            provenance_note='Açıklama yalnızca "Boeing 737 TCAS报警声 …，有降噪处理" (Boeing 737 TCAS uyarı sesi, gürültü azaltılmış), '
                            '"own work" (2008). Gerçek uçakta mı simülatörde mi kaydedildiği yazmıyor; 2008\'de PC simülatöründen alınmış '
                            'olması olası.')

ORDER_A = ['FIVE HUNDRED', 'FOUR HUNDRED', 'THREE HUNDRED', 'HUNDRED ABOVE', 'TWO HUNDRED', 'MINIMUM', 'ONE HUNDRED', 'FIFTY',
           'FORTY', 'THIRTY', 'TWENTY']
ORDER_B = ['FIVE HUNDRED', 'FOUR HUNDRED', 'THREE HUNDRED', 'APPROACHING MINIMUMS', 'MINIMUMS', 'ONE HUNDRED', 'FIFTY', 'FORTY',
           'THIRTY', 'TWENTY', 'TEN']


def ordered(items, order):
    best = {}
    rank = {'high': 0, 'medium': 1, 'low': 2}
    for f in items:
        t = (f.get('transcript') or '').strip().upper()
        if t in order and (t not in best or rank.get(f.get('confidence'), 3) < rank.get(best[t].get('confidence'), 3)):
            best[t] = f
    return [best[t] for t in order if t in best]


ext = [
    dict(id='air_bcdg_callouts', aircraft='a320neo', sound='callouts',
         title='Air France A319 F-GRXM kokpit videosu (CDG 26R, 2010) — gerçek FWC anonsları',
         files=files(ordered(pick('commons_bcdg', 'callout_'), ORDER_A)), **BCDG,
         note='Gerçek A320 ailesi FWC sesi (A319; A320neo\'da aynı ses ailesi, neo için ayrıca doğrulanmadı). 500→20 eksiksiz; ses arka '
              'plandan ≈11–16 dB yukarıda, motor/rüzgâr gürültüsü var; kayıplı Ogg kaynağı (≈64 kb/s, mono). Temiz bir oyun sesi için '
              'gürültü azaltma gerekir.', usable=True, recommended=True, confidence='yüksek'),
    dict(id='air_adria_callouts', aircraft='a320neo', sound='callouts',
         title='Adria Airways A319 S5-AAP kokpit videosu (Frankfurt + Ljubljana) — gerçek FWC anonsları',
         files=files(ordered(pick('commons_adria', 'callout_'), ORDER_A)), **ADRIA,
         note='İki yaklaşma: HUNDRED ABOVE ve MINIMUM burada var (CDG videosunda yok). Daha gürültülü (≈6–11 dB), telsiz/konuşma '
              'karışabiliyor; bazı yerlerde tam ölçek.', usable=True, confidence='orta'),
    dict(id='air_bcdg_retard', aircraft='a320neo', sound='retard', title='Air France A319 F-GRXM — gerçek "RETARD" (tek ve ×4)',
         files=[dict(orig=f['orig'], label=f['transcript'].title(), segment=[max(0, f['segment'][0] - 0.08), f['segment'][1] + 0.15])
                for f in pick('commons_bcdg', 'retard')], **BCDG,
         note='20 ft\'ten sonra 4 kez tekrar ediyor — oyundaki tekrar mantığıyla birebir karşılaştırılabilir. Arkada motor/teker sesi.',
         usable=True, recommended=True, confidence='orta'),
    dict(id='air_adria_retard', aircraft='a320neo', sound='retard', title='Adria A319 S5-AAP — gerçek "RETARD RETARD"',
         files=files(pick('commons_adria', 'retard'), label=False), **ADRIA, note='Daha gürültülü ikinci örnek.', usable=True,
         confidence='orta'),
    dict(id='air_adria_cavalry', aircraft='a320neo', sound='cavalry', title='Adria A319 S5-AAP — gerçek otopilot ayırma (cavalry charge)',
         files=[dict(orig='assets/audio/candidates/a320neo/other_unidentified_triple_tone/orig/commons_adria_a319_335.82-338.90.wav',
                     segment=[0.9, 2.2])], **ADRIA,
         note='Alt ajan "tanımlanamayan üçlü ton" olarak buldu; bant analizi (bu araştırma) ile doğrulandı: 1660 Hz ↔ 830 Hz her 40 ms\'de '
              'değişen (A-B-A-B-A) 200 ms\'lik üç patlama, aralarında ≈200 ms sessizlik — PR #364\'teki cavalry charge şemasının aynısı. '
              'Frankfurt yaklaşmasında 500 ft anonsundan ≈2 s önce (kasıtlı A/P ayırma). Bu kayıt oyundaki sentez cavalry sesinin '
              'gerçeğe uygun olduğunu da gösteriyor.', usable=True, confidence='yüksek'),
    dict(id='air_p8_callouts', aircraft='b737', sound='callouts',
         title='DVIDS 910648 — P-8A Poseidon gece yaklaşması (2024) — gerçek EGPWS anonsları',
         files=files(ordered(pick('dvids910648', 'callout_'), ORDER_B)), **P8,
         note='Gerçek Boeing/Honeywell sesi (737-800 tabanlı P-8A). 500, APPROACHING MINIMUMS, 50–10. Kelimeler net ama gürültü yüksek '
              '(ses bandında ≈3–5 dB); b-roll kurgusu nedeniyle bazı anonslar yok.', usable=True, confidence='yüksek'),
    dict(id='air_irk_callouts', aircraft='b737', sound='callouts',
         title='Transaero 737NG Irkutsk inişi (2015, Vnebelaynery) — gerçek EGPWS anonsları',
         files=files(ordered(pick('ia_irk_737ng', 'callout_'), ORDER_B)), **IRK,
         note='En eksiksiz 737 seti: 500, 400, 300, APPROACHING MINIMUMS, MINIMUMS, 100, 50, 40, 30, 20, 10. Ses P-8A kaydıyla aynı '
              '(şablon eşleşmesi). Gürültülü (≈5 dB), telsiz/pilot konuşması karışabiliyor.', usable=True, recommended=True,
         confidence='orta–yüksek'),
    dict(id='air_p8_horn', aircraft='b737', sound='config_horn', title='DVIDS 910648 — P-8A dokun-kalk sırasında kesikli korna',
         files=files(pick('dvids910648', 'config_horn'), pad=(0.0, 0.0), label=False), **P8,
         note='"TEN" anonsundan ≈4 s sonra: ≈0,21 s açık / 0,52 s periyot (≈1,9 Hz) kesikli korna, ≈200 Hz aralıklı harmonikler '
              '(600–4400 Hz). Dokun-kalkta flaplar iniş konumundayken gaz verilince çalan kalkış konfigürasyon uyarısı olması en '
              'olası açıklama (kaynakta yazmıyor). Dosyada 4 darbelik ilk bir seri de var.', usable=True, recommended=True,
         confidence='orta'),
    dict(id='air_commons_tcas', aircraft='b737', sound='tcas', title='Commons "Tcas traffic / descend crossing / climb now" (2008)',
         files=[dict(orig='assets/audio/candidates/b737/tcas_traffic/orig/Tcas_traffic.ogg', label='TRAFFIC, TRAFFIC'),
                dict(orig='assets/audio/candidates/b737/tcas_descend_crossing/orig/Tcas_descend_crossing.ogg', label='DESCEND, CROSSING, DESCEND'),
                dict(orig='assets/audio/candidates/b737/tcas_climb_now/orig/Tcas_climb_now.ogg', label='CLIMB, CLIMB NOW')],
         source_url='https://commons.wikimedia.org/wiki/File:Tcas_traffic.ogg', **TCAS,
         note='Temiz, gürültüsü azaltılmış. Kökeni belirsiz (gerçek uçak mı simülatör mü?) → yükleyene sorulmadan kullanılmamalı.',
         usable=True, verdict='review', confidence='kimlik yüksek / kullanılabilirlik düşük'),
]
mil = [c for c in json.load(open(os.path.join(HERE, 'external_candidates.json'))) if c['id'].startswith('mil_')]
json.dump(mil + ext, open(os.path.join(HERE, 'external_candidates.json'), 'w'), ensure_ascii=False, indent=1)
for c in ext:
    print(c['id'], len(c['files']), [f.get('label') for f in c['files']])
