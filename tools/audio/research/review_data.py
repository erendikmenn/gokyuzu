# -*- coding: utf-8 -*-
"""Curated content of the warning-sound review (Turkish UI text for dev/sesler.html).

Every candidate: id, aircraft, sound, title, files [{orig, label?, segment?, loop?, repeat_to?}], source_url, license,
license_url, credit, provenance ('real' | 'community' | 'unknown'), provenance_note, note, usable (redistributable?).
Research only — nothing here changes the game's sounds.
"""
import json
import os

GENERATED = '2026-09-23'
HERE = os.path.dirname(__file__)

# --------------------------------------------------------------------------------------------- FlightGear repos
FG = {
    'a320fam': dict(
        blob='https://github.com/legoboyvdlp/A320-family/blob/b6d40c4b11007da25eca4a6df76c9776beca6339/',
        license='GPL-2.0', license_url='https://github.com/legoboyvdlp/A320-family/blob/dev/README.copyright.md',
        credit='A320-family for FlightGear — Josh Davidson (Octal450), Jonathan Redpath (legoboyvdlp) ve katkıda '
               'bulunanlar, GPL-2.0'),
    'b737yv': dict(
        blob='https://github.com/YV3399/737-800YV/blob/9d967d89dd2ee0ae1bf01d00c49839a574aa9da5/',
        license='GPL-2.0', license_url='https://github.com/YV3399/737-800YV/blob/master/LICENSE',
        credit='Boeing 737-800YV for FlightGear — YV3399 (Gabriel Hernandez) ve katkıda bulunanlar, GPL-2.0'),
    'fgdata': dict(
        blob='https://gitlab.com/flightgear/fgdata/-/blob/ac5327c656fa8de16d5ded7a90501a07120a3b8b/',
        license='GPL-2.0', license_url='https://gitlab.com/flightgear/fgdata/-/blob/next/LICENSE.md',
        credit='FlightGear temel veri paketi (fgdata) — FlightGear katkıcıları, GPL-2.0'),
    'f16nvc': dict(
        blob='https://github.com/NikolaiVChr/f16/blob/0d0d3d425a9a852b9cd6a764dedee7c9c72cdf51/',
        license='GPL-2.0', license_url='https://github.com/NikolaiVChr/f16/blob/master/LICENSE',
        credit='F-16 for FlightGear — Nikolai V. Chr. ve katkıda bulunanlar (authors.txt), GPL-2.0'),
    'f22rrc': dict(
        blob='https://github.com/racerretrocoder/Flightgear-F-22A-Raptor/blob/ff9ae92220f6bf8dcb30ef012685025ca618bf92/',
        license='GPL-2.0', license_url='https://github.com/racerretrocoder/Flightgear-F-22A-Raptor/blob/master/LICENSE.md',
        credit='Flightgear-F-22A-Raptor — racerretrocoder ve katkıda bulunanlar, GPL-2.0'),
    'f22fgm': dict(
        blob='https://github.com/FGMEMBERS/Lockheed-Martin-FA-22A-Raptor/blob/616a258ed23353c633d2205477ed53a73b13e32d/',
        license='GPL-2.0',
        license_url='https://github.com/FGMEMBERS/Lockheed-Martin-FA-22A-Raptor/blob/master/f22-jsbsim-set.xml',
        credit='FA-22A Raptor for FlightGear — Fabrizio Fracaroli (2010), GPL-2.0'),
    'uh60fgm': dict(
        blob='https://github.com/FGMEMBERS/UH-60/blob/fb5d383fca3b47f28761b9d1edc361f75ad3bde7/',
        license='GPL-2.0', license_url='https://github.com/FGMEMBERS/UH-60/blob/master/COPYING',
        credit='FGUK UH-60 for FlightGear (ses: GEED) — GPL-2.0'),
}

P_A320 = ('Kaynağı belirtilmemiş. Dosyalar 2016–2019 arasında IDG-A32X / A320-family commit\'leriyle eklenmiş '
          '("add missing GPWS and apdisc sounds", "A320-family fork"); kayıt mı, sentez mi, başka bir yerden mi alındığı '
          'yazılmamış. GPL etiketi, katkıcının bu dosyaları paylaşma hakkına sahip olduğu varsayımına dayanır.')
P_GPWS2016 = ('Kaynağı belirtilmemiş. A320-family ve 737-800YV aynı dosyayı paylaşıyor (SHA-256 aynı); 737-800YV\'ye '
              '2016\'da "new GPWS sounds" commit\'iyle girmiş. Nereden geldiği yazılmamış.')
P_MKVIII = ('FlightGear MK VIII EGPWS emülasyonuyla (Jean-Yves Lefort, 2006) eklenmiş; seslerin nasıl üretildiği '
            'yazılmamış. 11 kHz / 8-bit, eski ve dar bantlı.')
P_TCAS = 'fgdata commit mesajı (ThorstenB, 2011): "TCAS voice sound samples. Artificial female voice. Stubs until we have something more realistic." — yani TTS (yapay ses).'
P_F16 = ('Kaynağı belirtilmemiş ("Sound: Bitching betty reborn", 2018). Projedeki bir katkıcı issue #368\'de bu '
         'seslerin sentezlendiğini (TTS) düşündüğünü yazıyor. Temiz stüdyo sesi; kokpitte kaydedilmemiş.')
P_F22 = 'Kaynağı belirtilmemiş (commit mesajlarında ve README\'de bilgi yok). Topluluk F-22 modelleri FGUK F-22\'den türetilmiş.'


def fg(cid, aid, snd, rk, path, title, prov, pnote, note, usable=True, files=None, **fkw):
    r = FG[rk]
    fname = f'{rk}__{os.path.basename(path)}'
    if files is None:
        files = [dict(orig=f'assets/audio/candidates/{aid}/{snd}/orig/{fname}', **fkw)]
    return dict(id=cid, aircraft=aid, sound=snd, title=title, files=files, source_url=r['blob'] + path,
                license=r['license'], license_url=r['license_url'], credit=r['credit'], provenance=prov,
                provenance_note=pnote, note=note, usable=usable)


def fgset(cid, aid, snd, rk, items, title, prov, pnote, note, usable=True, dirpath=''):
    files = [dict(orig=f'assets/audio/candidates/{aid}/{snd}/orig/{rk}__{os.path.basename(p)}', label=lab)
             for lab, p in items]
    c = fg(cid, aid, snd, rk, dirpath or os.path.dirname(items[0][1]) + '/', title, prov, pnote, note, usable, files=files)
    return c


A = 'Sounds/GPWS/'
Y = 'Sounds/gpws/'
M = 'Sounds/mk-viii/'
T = 'Sounds/tcas/female/'
TCAS = [('TRAFFIC', T + 'traffic.wav'), ('CLIMB', T + 'climb.wav'), ('DESCEND', T + 'descend.wav'),
        ('MONITOR VERTICAL SPEED', T + 'monitor_vertical_speed.wav'), ('ADJUST VERTICAL SPEED', T + 'adjust_vertical_speed.wav'),
        ('CLEAR (OF CONFLICT)', T + 'clear.wav')]

CANDIDATES = [
    # ============================================================================================== A320neo
    fg('a320fam_crc', 'a320neo', 'crc', 'a320fam', 'Sounds/Cockpit/crc.wav', 'A320-family crc.wav', 'unknown', P_A320,
       'Tek döngü 0,75 s (3 bip); önizlemede 4 kez tekrarlandı. Spektrum 1000 Hz + tek harmonikler (3/5/7 kHz): '
       'elektronik kare-dalga bip. Oyundaki sentez CRC ile aynı karakterde; belirgin bir kazanç yok.',
       loop=True, repeat_to=3.0),
    fg('a320fam_sc', 'a320neo', 'single_chime', 'a320fam', 'Sounds/Cockpit/chime.wav', 'A320-family chime.wav',
       'unknown', P_A320, '0,5 s, 1000 Hz kare-dalga "bip" (3/5/7… kHz harmonikler). Gerçek tek çan daha çok "ding" '
       'gibi sönümlenen bir çan sesidir; bu dosya bip gibi.'),
    fg('a320fam_cchord', 'a320neo', 'c_chord', 'a320fam', 'Sounds/Cockpit/c-chord.wav', 'A320-family c-chord.wav',
       'unknown', P_A320, '1,5 s sabit akor; tepe frekanslar 384/512/640/768 Hz (128 Hz\'in 3.–6. harmonikleri = '
       'majör akor). Sentetik; oyundaki c_chord ile çok benzer.'),
    fg('a320fam_cricket', 'a320neo', 'cricket_stall', 'a320fam', 'Sounds/Cockpit/cricket.wav',
       'A320-family cricket.wav + stall_voice.wav', 'unknown', P_A320,
       'Cricket döngüsü 0,48 s (önizlemede 3 s) ve ayrı "STALL" sesi (22 kHz). Whisper sesi "Stool. Stool." diye '
       'yazdı → telaffuz/kalite şüpheli.',
       files=[dict(orig='assets/audio/candidates/a320neo/cricket_stall/orig/a320fam__cricket.wav', label='cricket',
                   loop=True, repeat_to=3.0),
              dict(orig='assets/audio/candidates/a320neo/cricket_stall/orig/a320fam__stall_voice.wav', label='STALL STALL')]),
    fg('a320fam_retard', 'a320neo', 'retard', 'a320fam', A + 'retard.wav', 'A320-family retard.wav', 'unknown', P_A320,
       '22 kHz, 0,77 s, tek "RETARD" (oyunda tekrar mantığı var). Dar bant (≈2,2 kHz).'),
    fg('fgdata_retard', 'a320neo', 'retard', 'fgdata', M + 'retard.wav', 'fgdata mk-viii retard.wav', 'community',
       'fgdata commit (ThorstenB, 2018): "The other callouts generated by text2speech.org (which allows to use their '
       'generated sounds for any purpose and with any license)." — TTS.',
       '11 kHz TTS. Oyundaki ElevenLabs sesinden daha iyi değil.',
       files=[dict(orig='assets/audio/candidates/_fgdata/mk-viii/orig/fgdata__retard.wav')]),
    fgset('a320fam_callouts', 'a320neo', 'callouts', 'a320fam',
          [(n, A + f) for n, f in (('2500', '2500.wav'), ('2000', '2000.wav'), ('1000', '1000.wav'), ('500', '500.wav'),
                                   ('400', '400.wav'), ('300', '300.wav'), ('200', '200.wav'), ('100', '100.wav'),
                                   ('50', '50.wav'), ('40', '40.wav'), ('30', '30.wav'), ('20', '20.wav'), ('10', '10.wav'),
                                   ('5', '5.wav'), ('HUNDRED ABOVE', '100-above.wav'), ('MINIMUM', 'minimum.wav'))],
          'A320-family GPWS/ sayı anonsları (16 dosya)', 'unknown', P_A320,
          '22 kHz, dar bant (≈1–2,4 kHz). 10–1000 arası çok temiz (dinamik 45–80 dB: stüdyo/TTS gibi); 2500, 2000, 5, '
          'HUNDRED ABOVE, MINIMUM daha gürültülü ve farklı kaynaktan (2016\'da ayrı eklenmiş). Whisper "2000"i '
          '"2004" diye duydu.'),
    fg('a320fam_sinkrate', 'a320neo', 'sinkrate', 'a320fam', A + 'sink-rate.wav', 'A320-family sink-rate.wav', 'unknown',
       P_GPWS2016, '44,1 kHz, 0,93 s, bant ≈4 kHz. Aynı dosya 737-800YV\'de de var.'),
    fg('a320fam_pullup', 'a320neo', 'pullup', 'a320fam', A + 'pull-up.wav', 'A320-family pull-up.wav', 'unknown',
       P_GPWS2016, '44,1 kHz, 1,09 s, tek "PULL UP". Aynı dosya 737-800YV\'de de var.'),
    fg('a320fam_terrain', 'a320neo', 'terrain', 'a320fam', A + 'terrain.wav', 'A320-family terrain.wav', 'unknown',
       P_GPWS2016, '44,1 kHz, 0,89 s, tek "TERRAIN" (gerçekte "TERRAIN TERRAIN").'),
    fg('a320fam_toolow_gear', 'a320neo', 'toolow_gear', 'a320fam', A + 'too-low-gear.wav', 'A320-family too-low-gear.wav',
       'unknown', P_GPWS2016, '44,1 kHz, 1,47 s.'),
    fg('a320fam_toolow_flaps', 'a320neo', 'toolow_flaps', 'a320fam', A + 'too-low-flaps.wav',
       'A320-family too-low-flaps.wav', 'unknown', P_GPWS2016, '44,1 kHz, 1,63 s.'),
    fg('a320fam_toolow_terrain', 'a320neo', 'toolow_terrain', 'a320fam', A + 'too-low-terrain.wav',
       'A320-family too-low-terrain.wav', 'unknown', P_GPWS2016, '44,1 kHz, 1,48 s.'),
    fg('a320fam_dontsink', 'a320neo', 'dontsink', 'a320fam', A + 'dont-sink.wav', 'A320-family dont-sink.wav', 'unknown',
       P_GPWS2016, '44,1 kHz, 3,05 s, "DON\'T SINK, DON\'T SINK".'),
    fg('a320fam_glideslope', 'a320neo', 'glideslope', 'a320fam', A + 'glideslope.wav', 'A320-family glideslope.wav',
       'unknown', P_GPWS2016, '44,1 kHz, 1,26 s.'),
    fg('fgdata_bankangle', 'a320neo', 'bankangle', 'fgdata', M + 'bank-angle.wav', 'fgdata mk-viii bank-angle.wav',
       'unknown', P_MKVIII, '11 kHz / 8-bit, 0,89 s; A320-family\'deki bank-angle.wav boş (44 bayt), bu yüzden fgdata '
       'dosyası. Kalite düşük.'),
    fgset('a320fam_priority', 'a320neo', 'priority', 'a320fam',
          [('PRIORITY LEFT', 'Sounds/Cockpit/priority-left.wav'), ('PRIORITY RIGHT', 'Sounds/Cockpit/priority-right.wav')],
          'A320-family priority-left/right.wav', 'unknown',
          'Kaynağı belirtilmemiş (2021, "Sidestick priority with indicators and sound").', '48 kHz, temiz, bant ≈2,3 kHz.'),
    fg('a320fam_dual', 'a320neo', 'dual_input', 'a320fam', 'Sounds/Cockpit/dual-input.wav', 'A320-family dual-input.wav',
       'unknown', 'Kaynağı belirtilmemiş (2021, "Sidestick priority with indicators and sound").',
       '48 kHz, 5 s dosya (ses başı/sonu kırpıldı). Whisper "Your input." duydu.'),
    fg('a320fam_click', 'a320neo', 'triple_click', 'a320fam', 'Sounds/Cockpit/click.wav', 'A320-family click.wav',
       'unknown', P_A320, '0,78 s, üç tık (0 / 0,26 / 0,52 s), ≈1,6 kHz.', loop=True),
    fgset('fgdata_tcas_a', 'a320neo', 'tcas', 'fgdata', TCAS, 'fgdata TCAS (kadın sesi, 6 dosya)', 'community', P_TCAS,
          '11 kHz TTS, tek kelime ("CLIMB" — gerçekte "CLIMB, CLIMB"). "clear.wav" = "Clear of traffic" (gerçek: '
          '"CLEAR OF CONFLICT").'),
    # ============================================================================================== 737-800
    fg('b737yv_firebell', 'b737', 'fire_bell', 'b737yv', 'Sounds/fire-bell.wav', '737-800YV fire-bell.wav', 'unknown',
       'Kaynağı belirtilmemiş (2018, "port 737-800 changes").',
       '11 kHz, 0,57 s tek döngü (önizlemede 3 s). İnharmonik kısmi sesler (365/595/1280/2270 Hz) → gerçek bir zil '
       'kaydı gibi; hangi zil olduğu bilinmiyor.', loop=True, repeat_to=3.0),
    fg('b737yv_clacker', 'b737', 'clacker', 'b737yv', 'Sounds/overspeed.wav', '737-800YV overspeed.wav', 'unknown',
       'Kaynağı belirtilmemiş (2016, "add new sounds").',
       '8 kHz / 8-bit, 2,67 s döngü; ≈14 vuruş/s, bant ≈3,5 kHz. Mekanik bir clacker kaydına benziyor ama çok düşük '
       'çözünürlük.', loop=True),
    fg('b737yv_shaker', 'b737', 'shaker', 'b737yv', 'Sounds/stall.wav', '737-800YV stall.wav (stick shaker)', 'unknown',
       'Kaynağı belirtilmemiş (2017, "New sound more realistic").',
       '22 kHz, 2,43 s döngü; enerji 50–200 Hz\'de (motor gürültüsü + tıkırtı). Kokpitte kaydedilmiş bir sarsıcı '
       'olabilir; doğrulanamadı.', loop=True),
    fg('b737yv_altalert', 'b737', 'alt_alert', 'b737yv', 'Sounds/altAlert.wav', '737-800YV altAlert.wav', 'community',
       'Commit mesajı (Michael Soitanen, 2015): "Added custom altitude alert sound" — topluluk yapımı.',
       '1,06 s sabit akor (128 Hz\'in harmonikleri, A320 c-chord ile aynı yapı). Sentetik.'),
    fg('b737yv_crewcall', 'b737', 'crew_call', 'b737yv', 'Sounds/cabincall.wav', '737-800YV cabincall.wav', 'unknown',
       'Kaynağı belirtilmemiş (2017, "New sounds with some improvements").',
       '44,1 kHz, 2,5 s; iki nota (0,08 s ve 1,07 s) — hi-lo çan.'),
    fgset('b737yv_callouts', 'b737', 'callouts', 'b737yv',
          [(n, Y + f'altitude-{f}.wav') for n, f in (('TWENTY FIVE HUNDRED', '2500'), ('1000', '1000'), ('500', '500'),
                                                     ('400', '400'), ('300', '300'), ('200', '200'), ('100', '100'),
                                                     ('50', '50'), ('40', '40'), ('30', '30'), ('20', '20'), ('10', '10'))]
          + [('APPROACHING MINIMUMS', Y + 'approaching-minimums.wav'), ('MINIMUMS', Y + 'minimums.wav')],
          '737-800YV gpws/ anonsları (14 dosya)', 'unknown',
          'Kaynağı belirtilmemiş (2016, "Gabriel YV changes … new GPWS sounds", "add correct GPWS bank angle / minimums").',
          '44,1 kHz, bant ≈3,5 kHz, temiz. Whisper "10"u "Tim." diye yazdı.'),
    fg('b737yv_sinkrate', 'b737', 'sinkrate', 'b737yv', Y + 'sink-rate.wav', '737-800YV sink-rate.wav', 'unknown',
       P_GPWS2016, 'A320-family ile aynı dosya.'),
    fg('b737yv_pullup', 'b737', 'pullup', 'b737yv', Y + 'pull-up.wav', '737-800YV pull-up.wav', 'unknown', P_GPWS2016,
       'Tek "PULL UP", "WHOOP WHOOP" yok. A320-family ile aynı dosya.'),
    fg('fgdata_terrain', 'b737', 'terrain', 'fgdata', M + 'terrain.wav', 'fgdata mk-viii terrain.wav', 'unknown', P_MKVIII,
       '11 kHz / 8-bit, 0,51 s.'),
    fg('b737yv_toolow_gear', 'b737', 'toolow_gear', 'b737yv', Y + 'too-low-gear.wav', '737-800YV too-low-gear.wav',
       'unknown', P_GPWS2016, 'A320-family ile aynı dosya.'),
    fg('b737yv_toolow_flaps', 'b737', 'toolow_flaps', 'b737yv', Y + 'too-low-flaps.wav', '737-800YV too-low-flaps.wav',
       'unknown', P_GPWS2016, 'A320-family ile aynı dosya.'),
    fg('fgdata_toolow_terrain', 'b737', 'toolow_terrain', 'fgdata', M + 'too-low-terrain.wav',
       'fgdata mk-viii too-low-terrain.wav', 'unknown', P_MKVIII, '11 kHz / 8-bit; Whisper "Till love terrain" duydu → anlaşılırlık zayıf.'),
    fg('b737yv_dontsink', 'b737', 'dontsink', 'b737yv', Y + 'dont-sink.wav', '737-800YV dont-sink.wav', 'unknown',
       P_GPWS2016, 'A320-family ile aynı dosya.'),
    fg('b737yv_glideslope', 'b737', 'glideslope', 'b737yv', Y + 'glideslope.wav', '737-800YV glideslope.wav', 'unknown',
       P_GPWS2016, 'A320-family ile aynı dosya.'),
    fg('b737yv_bankangle', 'b737', 'bankangle', 'b737yv', Y + 'bank-angle.wav', '737-800YV bank-angle.wav', 'unknown',
       'Kaynağı belirtilmemiş (2016, "add correct GPWS bank angle / minimums / tolo gear").', '44,1 kHz, 0,95 s.'),
    fg('fgdata_gearhorn', 'b737', 'gear_horn', 'fgdata', 'Sounds/gear-hrn.wav', 'fgdata gear-hrn.wav', 'unknown',
       'fgdata\'ya 2001\'de eklenmiş ("gear related sounds", j4strngs). Aynı katkıcının o haftaki commit\'lerinde '
       '"basic wav files courtesy simphonics.com" ve "Oopsie, a little copyright problem" notları var → kaynak ve hak '
       'durumu belirsiz.',
       '8 kHz / 8-bit, 8,5 s; ≈0,55 s aralıklı kesikli korna (453 Hz temel). Genel amaçlı bir "gear horn"; 737 NG\'nin '
       'sürekli (steady) iniş takımı kornasıyla birebir değil.', usable=False, segment=[0.4, 4.9], loop=True),
    fgset('fgdata_tcas_b', 'b737', 'tcas', 'fgdata', TCAS, 'fgdata TCAS (kadın sesi, 6 dosya)', 'community', P_TCAS,
          'A320 satırındakiyle aynı dosyalar. 11 kHz TTS.'),
    # ============================================================================================== F-16C
    fg('f16nvc_warning', 'f16', 'warning', 'f16nvc', 'Sounds/betty/warning.wav', 'NikolaiVChr/f16 betty/warning.wav',
       'unknown', P_F16, '44,1 kHz, 2,47 s, "WARNING, WARNING" (gerçekte "WARNING WARNING – ara – WARNING WARNING"). '
       'Bant ≈2,8 kHz (VMS/kulaklık süzgeci uygulanmış).'),
    fg('f16nvc_caution', 'f16', 'caution', 'f16nvc', 'Sounds/betty/caution.wav', 'NikolaiVChr/f16 betty/caution.wav',
       'unknown', P_F16, '44,1 kHz, 3,4 s, "CAUTION, CAUTION".'),
    fg('f16nvc_pullup', 'f16', 'pullup', 'f16nvc', 'Sounds/betty/pullup.wav', 'NikolaiVChr/f16 betty/pullup.wav',
       'unknown', P_F16, '44,1 kHz, 1,94 s, "PULL UP, PULL UP".'),
    fg('f16nvc_altitude', 'f16', 'altitude', 'f16nvc', 'Sounds/betty/altitude.wav', 'NikolaiVChr/f16 betty/altitude.wav',
       'unknown', P_F16, '44,1 kHz, 2,03 s, "ALTITUDE, ALTITUDE".'),
    fg('f16nvc_bingo', 'f16', 'bingo', 'f16nvc', 'Sounds/betty/bingo.wav', 'NikolaiVChr/f16 betty/bingo.wav', 'unknown',
       P_F16, '44,1 kHz, 3,0 s ("BINGO, BINGO").'),
    fgset('f16nvc_ew', 'f16', 'ew_msgs', 'f16nvc',
          [('LOCK', 'Sounds/betty/lock.wav'), ('DATA', 'Sounds/betty/data.wav'), ('JAMMER', 'Sounds/betty/jammer.wav'),
           ('CHAFF FLARE', 'Sounds/betty/chaff-flare.wav'), ('CHAFF FLARE OUT', 'Sounds/betty/chaff-flare-out.wav'),
           ('IFF', 'Sounds/betty/IFF.wav'), ('MISSILE', 'Sounds/betty/missile.wav'),
           ('MAL & IND LTS testi (tüm dizi)', 'Sounds/betty/combined.wav')],
          'NikolaiVChr/f16 betty/ (7 dosya)', 'unknown', P_F16,
          'Oyunda karşılığı yok (silah/EW sistemi yok). "combined.wav" = MAL & IND LTS testindeki tüm mesaj dizisi.'),
    fg('f16nvc_gearhorn', 'f16', 'gear_horn', 'f16nvc', 'Sounds/250hz-square.wav', 'NikolaiVChr/f16 250hz-square.wav',
       'community', 'XML yorumu: "Source: Dash-1 1-70 and AD-A145-469. 250hz square tone in 1hz intervals." — belgeye '
       'dayanarak sentezlenmiş.', '1 s döngü (0,5 s ton / 0,5 s sessiz), 250 Hz kare dalga; önizlemede 4 s.',
       loop=True, repeat_to=4.0),
    fg('f16nvc_lowspeed', 'f16', 'lowspeed_tone', 'f16nvc', 'Sounds/250hz-square-steady.wav',
       'NikolaiVChr/f16 250hz-square-steady.wav', 'community',
       'XML yorumu: kaynak "Dash-1 1-95 and AD-A145-469" — belgeye dayanarak sentezlenmiş.',
       'Sürekli 250 Hz kare dalga; önizlemede 3 s.', loop=True, repeat_to=3.0),
    # ============================================================================================== F-22A
    fg('f22rrc_pullup', 'f22', 'pullup', 'f22rrc', 'Sounds/pullup.wav', 'racerretrocoder F-22 pullup.wav', 'unknown', P_F22,
       '24 kHz / 8-bit, 0,97 s, tek "PULL UP". F-16C (FGMEMBERS) ve FGUK F-22 türevlerinde de aynı dosya var.'),
    fg('f22rrc_overg', 'f22', 'overg', 'f22rrc', 'Sounds/Overgwarning.wav', 'racerretrocoder F-22 Overgwarning.wav',
       'unknown', P_F22, '48 kHz, 2,0 s, "OVER G, OVER G"; tamamen sessiz arka plan (dijital sentez/TTS izlenimi).'),
    fg('f22rrc_fuellow', 'f22', 'bingo', 'f22rrc', 'Sounds/fuellow.wav', 'racerretrocoder F-22 fuellow.wav', 'unknown',
       P_F22, '11 kHz, 1,3 s, "FUEL LOW".'),
    fg('f22fgm_lowalt', 'f22', 'altitude', 'f22fgm', 'Sounds/low-alt-warning.wav', 'FA-22A (FGMEMBERS) low-alt-warning.wav',
       'unknown', 'Kaynağı belirtilmemiş (2011 "Initial revision", Erik Hofman).',
       '1000 Hz bipler, 0,5 s aralık, 2,9 s. Jenerik sentez ton.'),
    fg('f22rrc_stall', 'f22', 'lowspeed', 'f22rrc', 'Sounds/AV/stall.wav', 'racerretrocoder F-22 AV/stall.wav', 'unknown',
       P_F22, '44,1 kHz, 3,8 s; 770–910 Hz kesikli ton. Jenerik.'),
    # ============================================================================================== UH-60M
    fg('uh60fgm_warn650', 'uh60', 'low_rotor', 'uh60fgm', 'Sounds/warn650.wav', 'FGUK UH-60 warn650.wav', 'community',
       'Bo105 FlightGear modelinden devralınmış jenerik 650 Hz uyarı tonu (UH-60 kayıt değil).',
       '0,5 s sürekli 650 Hz sinüs; önizlemede 2 s. Gerçek UH-60 tonuna dair bir iddiası yok.', loop=True, repeat_to=2.0),
]

# external (DVIDS / Commons / other open projects) — produced by the research sub-agents, curated in external.json
_ext = os.path.join(HERE, 'external_candidates.json')
if os.path.exists(_ext):
    CANDIDATES += json.load(open(_ext))

# --------------------------------------------------------------------------------------------- page content
INTRO = ('Bu sayfa yalnızca araştırma içindir: oyundaki hiçbir ses değiştirilmedi. Her uçak için gerçek uçağın sesli '
         'uyarıları, oyunun bugün çaldığı ses ve lisansı yeniden dağıtıma izin veren aday kayıtlar yan yana. Önizlemeler '
         '48 kHz\'e çevrilip kırpıldı ve seviyeleri eşitlendi (EQ/limiter yok); işlenmemiş özgün dosyalar '
         'assets/audio/candidates/<uçak>/<ses>/orig/ altında.')
LEGEND = {
    'real': 'Gerçek kayıt — gerçek uçakta/kokpitte kaydedildiği kaynağında yazıyor',
    'community': 'Topluluk yapımı — kaynağında sentez/TTS/kendi yapımı olduğu yazıyor',
    'unknown': 'Kaynağı belirsiz — açık lisanslı bir projede ama nasıl üretildiği yazmıyor',
}

G = lambda files, trigger, kind='': dict(files=files, trigger=trigger, kind=kind)  # noqa: E731
NOT_TRIG = 'Dosya yükleniyor ama oyunda hiçbir koşul çalmıyor.'

AIRCRAFT = [
    dict(id='a320neo', name='Airbus A320neo', sub='THY · FWC (uçuş uyarı bilgisayarı) sesleri + Honeywell EGPWS + TCAS',
         sounds=[
             dict(key='crc', name='Master Warning — CRC (sürekli tekrarlayan çan)',
                  real='Kırmızı (seviye 3) uyarılarda çalar: motor yangını, aşırı hız, iniş takımı inmemiş, kalkış konfigürasyon '
                       'uyarıları vb. Hızlı tekrarlanan elektronik çan; MASTER WARN butonuna basılana veya koşul bitene kadar sürer.',
                  game=G(['crc'], 'Aşırı hızda (VMO/MMO, VFE, VLE) döngü olarak, −4 dB.', 'sentez'),
                  cands=['a320fam_crc'], status='community',
                  rec='Gerçek kayıt bulunamadı. A320-family dosyası oyundaki sentezden daha gerçekçi değil ve kaynağı belirsiz → '
                      'mevcut sentezi koru; ileride gerçek CRC tınısına (sönümlü çan, hızlı tekrar) göre yeniden sentezle.'),
             dict(key='single_chime', name='Master Caution — tek çan (SC)',
                  real='Amber (seviye 2) uyarılarda bir kez çalar: kısa, sönümlenen tek "ding".',
                  game=G(['single_chime'], NOT_TRIG + ' (play("chime") ile çağrılabilir.)', 'sentez'),
                  cands=['a320fam_sc'], status='community',
                  rec='Aday dosya bir "bip"; oyundaki sönümlü çan sentezi gerçeğe daha yakın. Değiştirme.'),
             dict(key='c_chord', name='İrtifa uyarısı — C-chord',
                  real='FCU\'da seçilen irtifaya yaklaşırken (≈750 ft kala) ve seçilen irtifadan sapınca (≈250 ft) çalan '
                       'kısa akor (≈1,5 s).',
                  game=G(['c_chord'], NOT_TRIG, 'sentez'), cands=['a320fam_cchord'], status='community',
                  rec='Aday da sentetik bir akor; oyundakiyle aynı sınıf. Değiştirmeye gerek yok.'),
             dict(key='cricket_stall', name='Stall — cricket + "STALL STALL"',
                  real='Alternate/direct law\'da stall açısına yaklaşınca: cırcır böceği sesi ("cricket") ve yapay ses '
                       '"STALL, STALL", koşul sürdükçe tekrar.',
                  game=G(['v_stall'], 'warnings.stall iken 0,15 s arayla tekrar (sentez cricket + ElevenLabs "Stall, stall").',
                         'sentez + ElevenLabs'),
                  cands=['a320fam_cricket'], status='community',
                  rec='Adayın "STALL" sesi anlaşılırlık açısından şüpheli; cricket dosyası kullanılabilir ama kaynağı belirsiz. '
                      'Gerçek kayıt yok.'),
             dict(key='retard', name='"RETARD"',
                  real='Manuel inişte 20 ft\'te (autoland\'de 10 ft) FWC söyler; gaz kolları IDLE\'a çekilene kadar tekrarlar.',
                  game=G(['v_retard'], '20 ft callout\'unun yerine (otopilotta 10 ft) ve gaz IDLE\'a çekilene kadar 2,2 s arayla.',
                         'ElevenLabs'),
                  cands=['a320fam_retard', 'fgdata_retard'], status='community', rec=''),
             dict(key='callouts', name='Radyo altimetre anonsları (auto callouts)',
                  real='FWC erkek sesi: "TWO THOUSAND FIVE HUNDRED" (veya "TWENTY FIVE HUNDRED"), "ONE THOUSAND", "FIVE HUNDRED", '
                       '"FOUR HUNDRED", "THREE HUNDRED", "TWO HUNDRED", "ONE HUNDRED", "FIFTY", "FORTY", "THIRTY", "TWENTY", '
                       '"TEN", "FIVE"; karar irtifasında "HUNDRED ABOVE" ve "MINIMUM". Hangi anonsların etkin olduğu havayolu seçeneği.',
                  game=G(['v_2500', 'v_1000', 'v_500', 'v_400', 'v_hundredabove', 'v_minimums', 'v_100', 'v_50', 'v_40', 'v_30',
                          'v_20', 'v_10', 'v_5'],
                         'Alçalırken eşik geçildiğinde: 2500, 1000, 500, 400, 300 ft\'te "HUNDRED ABOVE", 200 ft\'te "MINIMUM", '
                         '100, 50, 40, 30, 20 (RETARD), 10, 5.', 'ElevenLabs'),
                  cands=['a320fam_callouts'], status='community', rec=''),
             dict(key='pullup', name='"PULL UP" (EGPWS)',
                  real='EGPWS mod 1/2 uyarısı (kırmızı): "PULL UP" (öncesinde "SINK RATE" / "TERRAIN TERRAIN"). İleri bakışlı '
                       'arazi uyarısında "TERRAIN AHEAD, PULL UP".',
                  game=G(['v_pullup'], 'warnings.pullUp (arazi/engel ileri bakış veya çok yüksek alçalma) — 0,3 s arayla.',
                         'ElevenLabs'),
                  cands=['a320fam_pullup'], status='community', rec=''),
             dict(key='sinkrate', name='"SINK RATE"', real='EGPWS mod 1: yere yakın aşırı alçalma hızı (amber).',
                  game=G(['v_sinkrate'], 'warnings.sinkRate (pull up yokken) — 0,9 s arayla.', 'ElevenLabs'),
                  cands=['a320fam_sinkrate'], status='community', rec=''),
             dict(key='toolow_gear', name='"TOO LOW, GEAR"', real='EGPWS mod 4A: takımlar inmeden alçakta.',
                  game=G(['v_toolow_gear'], 'warnings.gear — 1,4 s arayla.', 'ElevenLabs'),
                  cands=['a320fam_toolow_gear'], status='community', rec=''),
             dict(key='toolow_flaps', name='"TOO LOW, FLAPS"', real='EGPWS mod 4B: flaplar iniş konumunda değilken alçakta.',
                  game=G(['v_toolow_flaps'], 'Takım inik, alçalıyor, yavaş, < 75 m ve flap iniş konumunda değil.', 'ElevenLabs'),
                  cands=['a320fam_toolow_flaps'], status='community', rec=''),
             dict(key='bankangle', name='"BANK ANGLE, BANK ANGLE"', real='EGPWS yatış açısı uyarısı (seçenek).',
                  game=G(['v_bankangle'], 'Yatış > 35° — 1,2 s arayla.', 'ElevenLabs'),
                  cands=['fgdata_bankangle'], status='community', rec=''),
             dict(key='terrain', name='"TERRAIN TERRAIN" / "TERRAIN AHEAD"',
                  real='EGPWS mod 2 ("TERRAIN TERRAIN") ve ileri bakışlı uyarı ("TERRAIN AHEAD", "TERRAIN AHEAD, PULL UP").',
                  game=G(['v_terrain'], NOT_TRIG, 'ElevenLabs'), cands=['a320fam_terrain'], status='community', rec=''),
             dict(key='toolow_terrain', name='"TOO LOW, TERRAIN"', real='EGPWS mod 4 / arazi yakınlığı.',
                  game=G(['v_toolow_terrain'], NOT_TRIG, 'ElevenLabs'), cands=['a320fam_toolow_terrain'], status='community',
                  rec=''),
             dict(key='dontsink', name='"DON\'T SINK"', real='EGPWS mod 3: kalkış/pas geçme sonrası irtifa kaybı.',
                  game=G(['v_dontsink'], NOT_TRIG, 'ElevenLabs'), cands=['a320fam_dontsink'], status='community', rec=''),
             dict(key='glideslope', name='"GLIDE SLOPE"', real='EGPWS mod 5: süzülüş yolunun altına inme.',
                  game=G(['v_glideslope'], NOT_TRIG, 'ElevenLabs'), cands=['a320fam_glideslope'], status='community', rec=''),
             dict(key='windshear', name='"WINDSHEAR WINDSHEAR WINDSHEAR"',
                  real='Reaktif rüzgâr kesmesi (kırmızı, 3 kez). Öngörülü: "WINDSHEAR AHEAD", "GO AROUND, WINDSHEAR AHEAD", '
                       '"MONITOR RADAR DISPLAY".',
                  game=G(['v_windshear'], NOT_TRIG, 'ElevenLabs'), cands=[], status='none', rec=''),
             dict(key='tcas', name='TCAS (TA / RA)',
                  real='"TRAFFIC, TRAFFIC" (TA); RA: "CLIMB, CLIMB", "DESCEND, DESCEND", "LEVEL OFF, LEVEL OFF", '
                       '"MONITOR VERTICAL SPEED", "CLIMB, CLIMB NOW", "INCREASE CLIMB", "CLEAR OF CONFLICT" (TCAS II v7.1).',
                  game=None, cands=['fgdata_tcas_a'], status='community', rec=''),
             dict(key='priority', name='"PRIORITY LEFT" / "PRIORITY RIGHT"',
                  real='Bir pilot sidestick\'teki takeover butonuna basınca FWC söyler.',
                  game=None, cands=['a320fam_priority'], status='community', rec=''),
             dict(key='dual_input', name='"DUAL INPUT"', real='İki sidestick aynı anda hareket ettirilince.',
                  game=None, cands=['a320fam_dual'], status='community', rec=''),
             dict(key='speed', name='"SPEED SPEED SPEED" (low energy)',
                  real='Yaklaşmada enerji düşükken (itki artırılmalı) FWC uyarısı.', game=None, cands=[], status='none', rec=''),
             dict(key='triple_click', name='Üçlü tık (triple click)',
                  real='Yaklaşma yeteneği düşünce (ör. CAT seviyesi değişimi) duyulan üç kısa tık.',
                  game=None, cands=['a320fam_click'], status='community', rec=''),
             dict(key='cavalry', name='Otopilot ayırma — cavalry charge',
                  real='A/P ayrılınca kısa "süvari borusu"; istem dışı ayrılmada onaylanana kadar tekrar.',
                  game=G(['cavalry', 'cavalry_loop', 'ap_button'], 'A/P ayrılınca (kasıtlı: 1 kez + buton tık; istem dışı: döngü).',
                         'FlightGear A320-family kaydı (GPL-2.0)'),
                  cands=[], status='community',
                  rec='Oyundaki dosya gerçek kokpit kaydı DEĞİL: A320-family PR #364 (2025) bir teknik şemaya göre 1660/830 Hz kare '
                      'dalgalarla yeniden sentezlemiş (analizle doğrulandı: 40 ms dönüşüm, 200 ms açık/kapalı). Şema doğruysa ses '
                      'gerçeğe sadık; ama CREDITS.txt\'deki "recordings" ifadesi düzeltilmeli (AU ajanı).'),
         ]),
    dict(id='b737', name='Boeing 737-800', sub='THY · Boeing aural uyarı sistemi + Honeywell EGPWS + TCAS',
         sounds=[
             dict(key='fire_bell', name='Yangın zili (fire warning bell)',
                  real='Motor, APU, kargo veya teker yuvası yangınında sürekli çalan elektrikli zil; FIRE WARN ışığına basınca '
                       '(BELL CUTOUT) susar.',
                  game=None, cands=['b737yv_firebell'], status='community', rec=''),
             dict(key='config_horn', name='Kalkış konfigürasyonu / kabin irtifası kornası (kesikli)',
                  real='Kalkış için gaz verildiğinde flap/stabilizer trim/speedbrake/park freni yanlışsa kesikli korna. 737 NG\'de '
                       'aynı kesikli korna kabin irtifası 10.000 ft\'i aşınca da çalar (Helios 522 kazası).',
                  game=None, cands=[], status='none', rec=''),
             dict(key='gear_horn', name='İniş takımı konfigürasyon kornası (sürekli)',
                  real='Takımlar inik-kilitli değilken flap iniş konumunda ya da gaz rölantideyken (≈800 ft RA altı) sürekli korna.',
                  game=G(['v_toolow_gear'], 'Oyunda bu durum için korna yok; EGPWS "TOO LOW, GEAR" sesi çalıyor.', 'ElevenLabs'),
                  cands=['fgdata_gearhorn'], status='none', rec=''),
             dict(key='clacker', name='Aşırı hız clacker\'ı',
                  real='VMO/MMO aşıldığında mekanik "tak-tak-tak" (clacker); hız düşene kadar.',
                  game=G(['clacker'], 'warnings.overspeed iken döngü, −2 dB.', 'sentez'),
                  cands=['b737yv_clacker'], status='community', rec=''),
             dict(key='shaker', name='Stick shaker',
                  real='Stall\'a yaklaşırken iki kumanda kolonunu sarsan eksantrik ağırlıklı motor: yüksek, hırıltılı titreşim ve '
                       'tıkırtı; stall uyarısı sürdükçe.',
                  game=G(['shaker'], 'warnings.stall iken döngü (stick shaker açısından önce).', 'sentez'),
                  cands=['b737yv_shaker'], status='community', rec=''),
             dict(key='wailer', name='Otopilot ayırma — wailer',
                  real='A/P ayrılınca inip çıkan siren; ikinci basışla susar.',
                  game=G(['wailer'], 'A/P ayrılınca (kasıtlı ≈3 s, istem dışı onaylanana kadar).', 'FlightGear 737-800YV kaydı (GPL-2.0)'),
                  cands=[], status='community',
                  rec='Oyundaki dosya 737-800YV\'nin Apdisco.wav\'ı; commit mesajı yalnızca "Added 2 new sounds from 733" (FlightGear '
                      '737-300\'den) diyor — kaydın kökeni belirtilmemiş. GPL etiketli ama "gerçek kayıt" olduğu kanıtlanamıyor.'),
             dict(key='alt_alert', name='İrtifa uyarı tonu',
                  real='MCP\'de seçilen irtifaya yaklaşırken (≈900 ft) ve sapınca (≈300 ft) kısa tek ton.',
                  game=G(['c_chord'], NOT_TRIG, 'sentez'), cands=['b737yv_altalert'], status='community', rec=''),
             dict(key='crew_call', name='Hi-lo çan (kabin çağrısı / SELCAL)',
                  real='Kabin ekibi çağrısı ve SELCAL\'de iki notalı "ding-dong". 737 NG\'de MASTER CAUTION\'ın sesli uyarısı '
                       'yoktur (yalnız ışık).',
                  game=G(['chime'], NOT_TRIG + ' (oyunda "master caution çanı" olarak düşünülmüş; gerçek 737\'de yok).', 'sentez'),
                  cands=['b737yv_crewcall'], status='community', rec=''),
             dict(key='callouts', name='Radyo altimetre anonsları',
                  real='Honeywell EGPWS erkek sesi: "TWENTY FIVE HUNDRED", "ONE THOUSAND", "FIVE HUNDRED", "ONE HUNDRED", '
                       '"FIFTY", "FORTY", "THIRTY", "TWENTY", "TEN"; "APPROACHING MINIMUMS" (DH+80 ft) veya "PLUS HUNDRED", '
                       '"MINIMUMS". Hangi anonsların etkin olduğu havayolu seçeneği.',
                  game=G(['v_2500', 'v_1000', 'v_500', 'v_hundredabove', 'v_minimums', 'v_100', 'v_50', 'v_40', 'v_30', 'v_20', 'v_10'],
                         '2500, 1000, 500; 300 ft\'te "APPROACHING MINIMUMS", 200 ft\'te "MINIMUMS"; 100, 50, 40, 30, 20, 10.',
                         'ElevenLabs'),
                  cands=['b737yv_callouts'], status='community', rec=''),
             dict(key='pullup', name='"WHOOP WHOOP PULL UP" / "PULL UP"',
                  real='EGPWS mod 1/2 kırmızı uyarı; Boeing\'de "WHOOP WHOOP PULL UP" veya "TERRAIN TERRAIN, PULL UP"; ileri '
                       'bakışta "TERRAIN AHEAD, PULL UP".',
                  game=G(['v_pullup'], 'warnings.pullUp — 0,2 s arayla (iki sentez "whoop" + ElevenLabs "Pull up").',
                         'sentez + ElevenLabs'),
                  cands=['b737yv_pullup'], status='community', rec=''),
             dict(key='sinkrate', name='"SINK RATE"', real='EGPWS mod 1.',
                  game=G(['v_sinkrate'], 'warnings.sinkRate — 0,9 s arayla.', 'ElevenLabs'), cands=['b737yv_sinkrate'],
                  status='community', rec=''),
             dict(key='toolow_gear', name='"TOO LOW, GEAR"', real='EGPWS mod 4A.',
                  game=G(['v_toolow_gear'], 'warnings.gear — 1,4 s arayla.', 'ElevenLabs'), cands=['b737yv_toolow_gear'],
                  status='community', rec=''),
             dict(key='toolow_flaps', name='"TOO LOW, FLAPS"', real='EGPWS mod 4B.',
                  game=G(['v_toolow_flaps'], 'Takım inik, alçalıyor, yavaş, < 75 m, flap iniş konumunda değil.', 'ElevenLabs'),
                  cands=['b737yv_toolow_flaps'], status='community', rec=''),
             dict(key='bankangle', name='"BANK ANGLE, BANK ANGLE"', real='EGPWS yatış açısı uyarısı.',
                  game=G(['v_bankangle'], 'Yatış > 35° — 1,2 s arayla.', 'ElevenLabs'), cands=['b737yv_bankangle'],
                  status='community', rec=''),
             dict(key='terrain', name='"TERRAIN TERRAIN" / "CAUTION TERRAIN"',
                  real='EGPWS mod 2 ve ileri bakış ("CAUTION TERRAIN", "TERRAIN AHEAD").',
                  game=G(['v_terrain'], NOT_TRIG, 'ElevenLabs'), cands=['fgdata_terrain'], status='community', rec=''),
             dict(key='toolow_terrain', name='"TOO LOW, TERRAIN"', real='EGPWS mod 4 / arazi yakınlığı.',
                  game=G(['v_toolow_terrain'], NOT_TRIG, 'ElevenLabs'), cands=['fgdata_toolow_terrain'], status='community',
                  rec=''),
             dict(key='dontsink', name='"DON\'T SINK"', real='EGPWS mod 3.',
                  game=G(['v_dontsink'], NOT_TRIG, 'ElevenLabs'), cands=['b737yv_dontsink'], status='community', rec=''),
             dict(key='glideslope', name='"GLIDESLOPE"', real='EGPWS mod 5.',
                  game=G(['v_glideslope'], NOT_TRIG, 'ElevenLabs'), cands=['b737yv_glideslope'], status='community', rec=''),
             dict(key='windshear', name='"WINDSHEAR WINDSHEAR WINDSHEAR" (+ siren)',
                  real='Reaktif: iki tonlu siren + "WINDSHEAR" ×3. Öngörülü (hava radarı): "MONITOR RADAR DISPLAY", '
                       '"GO AROUND, WINDSHEAR AHEAD", "WINDSHEAR AHEAD".',
                  game=G(['v_windshear'], NOT_TRIG, 'ElevenLabs'), cands=[], status='none', rec=''),
             dict(key='tcas', name='TCAS (TA / RA)', real='A320 satırındaki TCAS II v7.1 anonsları; aynı sistem.',
                  game=None, cands=['fgdata_tcas_b'], status='community', rec=''),
         ]),
    dict(id='f16', name='F-16C Fighting Falcon', sub='VMS/VMU kadın sesi ("Bitching Betty") + uyarı tonları',
         sounds=[
             dict(key='warning', name='"WARNING WARNING"',
                  real='Göstergeye monte herhangi bir kırmızı WARNING ışığı yandıktan 1,5 s sonra: "WARNING-WARNING (ara) '
                       'WARNING-WARNING" (ENGINE, TO/LDG CONFIG, HYD/OIL PRESS, FLCS, CANOPY…). WARN RESET ile susar.',
                  game=G(['v_warning'], 'Oyunda stall uyarısında (warnings.stall) 1,2 s arayla.', 'ElevenLabs'),
                  cands=['f16nvc_warning'], status='community', rec=''),
             dict(key='caution', name='"CAUTION CAUTION"',
                  real='Caution panelinde bir ışık yandıktan 7 s sonra (MASTER CAUTION hemen resetlenirse çalmaz).',
                  game=G(['v_caution'], 'Aşırı hızda 4 s arayla; ayrıca "chime" bu ses.', 'ElevenLabs'),
                  cands=['f16nvc_caution'], status='community', rec=''),
             dict(key='pullup', name='"PULL UP, PULL UP"',
                  real='Otomatik fly-up/TF arızası, GCAS/GAAF uyarısı; en yüksek öncelikli VMS mesajı.',
                  game=G(['v_pullup'], 'warnings.pullUp — 0,25 s arayla.', 'ElevenLabs'), cands=['f16nvc_pullup'],
                  status='community', rec=''),
             dict(key='altitude', name='"ALTITUDE ALTITUDE"',
                  real='Kalkıştan sonra alçalma, radar irtifası CARA ALOW değerinin altında veya barometrik irtifa MSL '
                       'floor\'un altında.',
                  game=G(['v_altitude'], 'Takım kolu inikken sinkRate ve < 400 ft\'te (pull up yoksa) 0,9 s arayla.', 'ElevenLabs'),
                  cands=['f16nvc_altitude'], status='community', rec=''),
             dict(key='bingo', name='"BINGO BINGO"', real='Bingo yakıt seviyesinin altına inince (HUD\'da FUEL yanıp söner).',
                  game=G(['v_bingo'], 'Yakıt < %12 olunca bir kez.', 'ElevenLabs'), cands=['f16nvc_bingo'],
                  status='community', rec=''),
             dict(key='gear_horn', name='İniş takımı uyarı kornası (ton)',
                  real='Ses değil TON: takımlar inik değilken < 190 kt, < 10.000 ft ve alçalırken (> 250 ft/dk) kesikli ton '
                       '(FlightGear notu: 250 Hz kare dalga, 1 Hz aralık). F-16 VMS\'inde "LANDING GEAR" diye bir mesaj yok.',
                  game=G(['v_gear'], 'warnings.gear iken 3 s arayla "Landing gear" sesi (gerçekte yok).', 'ElevenLabs'),
                  cands=['f16nvc_gearhorn'], status='community', rec=''),
             dict(key='lowspeed_tone', name='Düşük hız uyarı tonu',
                  real='Ses değil TON: takımlar yukarıdayken hız programın altına düşünce veya takımlar inikken AOA > 15°. '
                       'Kitaba göre sesli mesajlar bu tondan önceliklidir. F-16 VMS\'inde "LOW SPEED" diye mesaj yok.',
                  game=G(['v_warning'], 'Stall\'da "WARNING WARNING" sesi çalıyor.', 'ElevenLabs'),
                  cands=['f16nvc_lowspeed'], status='community', rec=''),
             dict(key='overg', name='Over-G',
                  real='F-16 VMS mesaj listesinde "OVER G" yok (FLCS G sınırlayıcı var; uyarı sesi yok).',
                  game=G(['v_overg'], 'g > 9,3 iken 1,5 s arayla "Over G".', 'ElevenLabs'), cands=[], status='none',
                  rec='Gerçekte olmayan bir uyarı; kaldırmak gerçekçiliği artırır.'),
             dict(key='ew_msgs', name='Diğer VMS mesajları (LOCK, DATA, JAMMER, COUNTER, CHAFF-FLARE, LOW, OUT, IFF)',
                  real='Radar kilidi, datalink verisi, karşı tedbir/EW bildirimleri; oyunda karşılığı yok.',
                  game=None, cands=['f16nvc_ew'], status='community', rec='Oyunda silah/EW olmadığı için gerek yok.'),
         ]),
    dict(id='f22', name='F-22A Raptor', sub='ICAWS (entegre uyarı sistemi) kadın sesi + tonlar',
         sounds=[
             dict(key='pullup', name='"PULL UP"', real='', game=G(['v_pullup'], 'warnings.pullUp — 0,25 s arayla.', 'ElevenLabs'),
                  cands=['f22rrc_pullup'], status='community', rec=''),
             dict(key='altitude', name='"ALTITUDE"', real='',
                  game=G(['v_altitude'], 'Takım kolu inikken sinkRate ve < 400 ft.', 'ElevenLabs'),
                  cands=['f22fgm_lowalt'], status='community', rec=''),
             dict(key='warning', name='"WARNING"', real='', game=None, cands=[], status='none', rec=''),
             dict(key='caution', name='"CAUTION"', real='',
                  game=G(['v_caution'], 'Aşırı hızda 4 s arayla; "chime" da bu ses.', 'ElevenLabs'), cands=[], status='none', rec=''),
             dict(key='lowspeed', name='Düşük hız / stall', real='',
                  game=G(['v_lowspeed'], 'warnings.stall iken 1,2 s arayla "Low speed".', 'ElevenLabs'),
                  cands=['f22rrc_stall'], status='community', rec=''),
             dict(key='overg', name='"OVER G"', real='', game=G(['v_overg'], 'g > 9,3.', 'ElevenLabs'),
                  cands=['f22rrc_overg'], status='community', rec=''),
             dict(key='bingo', name='"BINGO FUEL"', real='', game=G(['v_bingo'], 'Yakıt < %12, bir kez.', 'ElevenLabs'),
                  cands=['f22rrc_fuellow'], status='community', rec=''),
             dict(key='gear', name='İniş takımı uyarısı', real='', game=G(['v_gear'], 'warnings.gear — 3 s arayla.', 'ElevenLabs'),
                  cands=[], status='none', rec=''),
         ]),
    dict(id='uh60', name='UH-60M Black Hawk', sub='Master warning paneli tonları (+ UH-60M CAAS sesli uyarıları)',
         sounds=[
             dict(key='low_rotor', name='LOW ROTOR RPM — ton',
                  real='Rotor devri %95 NR\'nin altına inince (ya da Ng < %55) kulaklıklarda "alçak, sabit bir ton"; kırmızı LOW '
                       'ROTOR RPM ışığı saniyede 3–5 kez yanıp söner. Ton yerde (sol teker WOW) susturulur. (TM 1-1520-237-10, UH-60A)',
                  game=G(['low_rotor', 'v_lowrotor'], 'Havada NR %30–93 arası: 700/850 Hz\'de 4 Hz titreyen ton döngüsü (−6 dB) + 3 s '
                         'arayla "Low rotor R.P.M." sesi.', 'sentez + ElevenLabs'),
                  cands=['uh60fgm_warn650'], status='community', rec=''),
             dict(key='engine_out', name='#1 / #2 ENG OUT — ton',
                  real='Bir motorun Ng\'si %55\'in altına düşünce ENG OUT ışığı ve sabit ton (yerde susturulmaz).',
                  game=None, cands=[], status='none', rec=''),
             dict(key='stab_beep', name='Stabilatör / master caution bip tonu',
                  real='Stabilatör otomatik modu devre dışı kalınca MASTER CAUTION + STABILATOR ışığı ve kulaklıkta kesikli bip; '
                       'MASTER CAUTION\'a basınca susar.',
                  game=None, cands=[], status='none', rec=''),
             dict(key='altitude', name='"ALTITUDE" (alçak irtifa)', real='',
                  game=G(['v_altitude'], 'warnings.sinkRate iken 1 s arayla "Altitude, altitude".', 'ElevenLabs'),
                  cands=[], status='none', rec=''),
             dict(key='pullup', name='"PULL UP"', real='', game=G(['v_pullup'], 'warnings.pullUp — 0,4 s arayla.', 'ElevenLabs'),
                  cands=[], status='none', rec=''),
             dict(key='bankangle', name='"BANK ANGLE"', real='', game=G(['v_bankangle'], 'Yatış > 60°.', 'ElevenLabs'),
                  cands=[], status='none', rec=''),
         ]),
]

REFERENCES = []   # non-usable references (filled from found_air.json / found_mil.json below)
SOURCES = [       # sources for the real alert lists (fetched and read during this research unless noted)
    dict(title='FAA — Introduction to TCAS II Version 7.1 (2011), Tablo 4 "TCAS Aural Annunciations"',
         url='https://www.faa.gov/documentLibrary/media/Advisory_Circular/TCAS%20II%20V7.1%20Intro%20booklet.pdf',
         what='A320 ve 737 TCAS sesli uyarılarının tam listesi (TRAFFIC TRAFFIC, CLIMB CLIMB, LEVEL OFF…, CLEAR OF CONFLICT).'),
    dict(title='The Boeing 737 Technical Site — Warning Systems', url='http://www.b737.org.uk/warningsystems.htm',
         what='737 kokpit sesli uyarıları (yangın zili, kalkış konfig., kabin irtifası, iniş takımı konfig., overspeed, stall, '
              'GPWS, TCAS), GPWS öncelik tablosu, radyo altimetre anons seçenekleri. Master caution için ses listelenmiyor.'),
    dict(title='The Boeing 737 Technical Site — Stall Warning System', url='http://www.b737.org.uk/stallwarningsys.htm',
         what='Stick shaker: eksantrik ağırlıklı motor, iki kolon birlikte titrer (SMYD).'),
    dict(title='F-16 -1 (T.O. GR1F-16CJ-1) ve MLU M3 tape alıntıları — NikolaiVChr/f16 issue #368',
         url='https://github.com/NikolaiVChr/f16/issues/368',
         what='F-16 VMS/VMU mesaj listesi, zamanlama (WARNING 1,5 s, CAUTION 7 s), öncelik sırası, WOW\'da çalışmama, '
              'düşük hız tonu ve LG kornası (tonlar), MISSILE/NOSE/TAIL… EWMS mesajları.'),
    dict(title='NikolaiVChr/f16 Systems/f16-sound.xml + jsb-misc.xml',
         url='https://github.com/NikolaiVChr/f16/blob/master/Systems/f16-sound.xml',
         what='LG uyarı kornası (250 Hz kare, 1 Hz aralık; < 190 kt, < 10.000 ft, alçalma) ve düşük hız tonu koşulları; '
              'kaynak olarak Dash-1 s. 1-70/1-95 ve DTIC AD-A145-469 gösteriliyor (DTIC bakımda olduğu için okunamadı).'),
    dict(title='TM 1-1520-237-10 Operator\'s Manual: UH-60A and EH-60A (1988) — Internet Archive, Public Domain Mark',
         url='https://archive.org/details/TM1-1520-237-10',
         what='Master warning paneli: LOW ROTOR RPM ışığı 3–5 Hz yanıp söner, %95 NR altında "low steady tone", yerde WOW ile '
              'susar; ENG OUT tonu Ng < %55; stabilatör arızasında kulaklıkta bip.'),
    dict(title='Wikipedia — Voice warning system ("Bitching Betty")', url='https://en.wikipedia.org/wiki/Voice_warning_system',
         what='Airbus: yeni A320\'lerde İngiliz (RP) aksanlı erkek ses, eski A320\'lerde Fransız aksanı; Boeing: erkek ses; '
              'F-16 sesi: Erica Lane.'),
    dict(title='legoboyvdlp/A320-family PR #364 "Update autopilot disconnect sound"',
         url='https://github.com/legoboyvdlp/A320-family/pull/364',
         what='A320 cavalry charge dalga biçimi şeması: 1660 Hz / 830 Hz kare dalga, 40 ms dönüşümlü, 200 ms açık / 200 ms '
              'kapalı. Oyundaki cavalry sesi bu şemaya göre sentezlenmiş dosya.'),
    dict(title='NTSB AAR-10/03 — US Airways 1549 (A320), CVR dökümü ve FCOM alıntısı (alt ajan okudu)',
         url='https://www.ntsb.gov/investigations/AccidentReports/Reports/AAR1003.pdf',
         what='"FWC [single chime]", "FWC [continuous repetitive chime]", "FWC retard", EGPWS "terrain terrain pull up", '
              '"too low gear", "caution terrain"; "SPEED SPEED SPEED" her 5 s\'de bir tekrar.'),
    dict(title='NTSB AAR-07/06 — Southwest 1248 (737-700), CVR dökümü (alt ajan okudu)',
         url='https://www.ntsb.gov/investigations/AccidentReports/Reports/AAR0706.pdf',
         what='"[sound similar to altitude warning horn]", "[single chime]", "[double chime]", "[sound similar to stick shaker]".'),
    dict(title='Airbus A320 FCOM / Boeing 737 NG FCOM (kamuya açık değil — okunmadı)', url=None,
         what='CRC, tek çan, C-chord, cricket, RETARD, auto callouts, SPEED SPEED SPEED, PRIORITY LEFT/RIGHT, DUAL INPUT; '
              '737 konfig. kornaları, alt. alert tonu. Bu satırlardaki açıklamalar genel havacılık bilgisine dayanıyor, '
              'sayısal eşikler yaklaşık.'),
]

# --------------------------------------------------------------------------------------------- overrides
# extra rows, extra candidates and the final recommendation text per (aircraft, sound key)
EXTRA_ROWS = {
    'f16': [dict(key='other', name='Tanımlanamayan gerçek F-16 kokpit sesleri',
                 real='Auto-GCAS kurtarma HUD kaydında (2016, ABD Hava Kuvvetleri) duyulan, hangi uyarı olduğu belirlenemeyen tonlar.',
                 game=None, cands=['mil_autogcas_tone', 'mil_autogcas_buzz'], status='ref')],
}
EXTRA_CANDS = {
    ('f16', 'bingo'): ['mil_dvids_bingo'],
    ('a320neo', 'callouts'): ['air_bcdg_callouts', 'air_adria_callouts'],
    ('a320neo', 'retard'): ['air_bcdg_retard', 'air_adria_retard'],
    ('a320neo', 'cavalry'): ['air_adria_cavalry'],
    ('b737', 'callouts'): ['air_irk_callouts', 'air_p8_callouts'],
    ('b737', 'config_horn'): ['air_p8_horn'],
    ('b737', 'tcas'): ['air_commons_tcas'],
}
# candidates listed first in a row (real recordings before the FlightGear files)
FIRST = {('a320neo', 'callouts'), ('a320neo', 'retard'), ('b737', 'callouts'), ('b737', 'tcas')}
REC = {}
# filled below per aircraft (rec = Öneri, recreate = gerçeği nasıl duyulur, status override)


def _apply():
    for ac in AIRCRAFT:
        ac['sounds'] += EXTRA_ROWS.get(ac['id'], [])
        for s in ac['sounds']:
            ex = EXTRA_CANDS.get((ac['id'], s['key']), [])
            s['cands'] = ex + s.get('cands', []) if (ac['id'], s['key']) in FIRST else s.get('cands', []) + ex
            s.update(REC.get((ac['id'], s['key']), {}))

NOREC = ('Kamuya açık, lisansı uygun gerçek kayıt bulunamadı: DVIDS\'te 129 aramada 327 video, Commons, NASA, Internet Archive '
         'tarandı — kokpit videolarının sesi çoğunlukla kamera mikrofonu ya da müzik; interkom sesi olanlarda VMS/ICAWS kelimesi '
         'duyulmadı.')
REC.update({
    # ---------------------------------------------------------------- F-16C
    ('f16', 'warning'): dict(
        rec='FlightGear seti temiz ama kaynağı belirsiz (büyük olasılıkla TTS). Asıl düzeltme içerikte: oyunda "WARNING" '
            'stall için çalıyor; gerçek F-16\'da stall/düşük hız için TON var. "WARNING WARNING – WARNING WARNING" kırmızı uyarı '
            'ışıklarına (motor yangını, TO/LDG CONFIG vb.) bağlanmalı.',
        recreate='Kadın sesi, sakin ve düz tonlama, kulaklık bandı (≈300–3400 Hz). Aynı kayıt iki kez + kısa ara + iki kez; '
                 'uyarı ışığından 1,5 s sonra başlar.'),
    ('f16', 'caution'): dict(
        rec='Oyunda aşırı hıza bağlı; gerçekte caution panelindeki bir ışıktan 7 s sonra ve MASTER CAUTION resetlenmediyse '
            'çalar. Mevcut ElevenLabs sesi kalabilir.',
        recreate='"CAUTION, CAUTION" — WARNING ile aynı ses ve işleme.'),
    ('f16', 'pullup'): dict(rec='Mevcut ses kalabilir; FlightGear dosyası alternatif (kaynağı belirsiz).',
                            recreate='Tek kaydın arka arkaya tekrarı: "PULL UP, PULL UP…"; en yüksek öncelikli mesaj.'),
    ('f16', 'altitude'): dict(rec='Mevcut ses kalabilir. Tetikleme gerçeğe daha yakın olabilir: CARA ALOW / MSL floor altına '
                                          'inince veya kalkıştan sonra alçalınca (oyunda yalnız takım koluyla sink rate).'),
    ('f16', 'bingo'): dict(rec='Thunderbirds interkomundaki "Bingo. Bingo." büyük olasılıkla pilotun sesi, kullanılmamalı.'),
    ('f16', 'gear_horn'): dict(
        rec='Gerçek F-16\'da "LANDING GEAR" diye bir ses yok → 250 Hz, 1 Hz aralıklı kesikli tonla değiştirilmeli. FlightGear dosyası '
            'belgeye dayalı sentez (GPL-2.0); aynısı projenin kendi sentezleyicisiyle de kolayca üretilir (tercih edilir, atıf gerekmez).',
        recreate='250 Hz kare dalga, 0,5 s açık / 0,5 s kapalı (FlightGear notu: Dash-1 s. 1-70, DTIC AD-A145-469). Takımlar yukarıda, '
                 '< 190 kt, < 10.000 ft ve > 250 ft/dk alçalırken; kokpitteki düğmeyle susturulabilir.'),
    ('f16', 'lowspeed_tone'): dict(
        rec='Oyunda stall\'da "WARNING WARNING" çalıyor; gerçekte sürekli bir TON. FlightGear 250 Hz sürekli kare dalga (belgeye dayalı '
            'sentez) veya kendi sentezimiz. Auto-GCAS kaydındaki 241 Hz sürekli kare dalga ("Tanımlanamayan" satırı) bu tona çok '
            'benziyor — dinleyip doğrulanırsa gerçek referans olur.',
        recreate='Sürekli ≈250 Hz kare dalga (sert, "vızıldayan" ton); takımlar yukarıdayken hız programın altına inince veya takımlar '
                 'inikken AOA > 15°. Sesli mesajlar bu tonun önüne geçer.'),
    ('f16', 'overg'): dict(recreate='Gerçekte sesli uyarı yok.'),
    ('f16', 'other'): dict(rec='Yalnız referans: gerçek F-16 kaydı ama hangi uyarı olduğu belli değil. 241 Hz ton düşük hız tonu/LG '
                               'kornasıyla uyumlu; doğrulanmadan oyuna konmamalı.'),
    ('f16', 'ew_msgs'): dict(status='community'),
    # ---------------------------------------------------------------- F-22A
    **{('f22', k): dict(
        rec='FlightGear F-22 dosyalarının kaynağı yazmıyor, '
            'kalitesi düşük (8-bit/11–24 kHz) → önerilmez. F-22\'nin mesaj listesi kamuya açık belgelerde doğrulanamadı; mevcut '
            'ElevenLabs seti kalsın; F-16 ile aynı mesaj listesini kullanmak doğrulanmamış bir varsayım.',
        recreate='Doğrulanmış bilgi yok. F-22 ICAWS\'ın kadın sesiyle konuştuğu söylenir; kelimeler ve ton kamuya açık kaynaklarda '
                 'bulunamadı.') for k in ('pullup', 'altitude', 'warning', 'caution', 'lowspeed', 'overg', 'bingo', 'gear')},
    # ---------------------------------------------------------------- UH-60M
    ('uh60', 'low_rotor'): dict(
        rec='Kılavuza göre gerçek uyarı "alçak, sabit bir ton"; oyundaki 700/850 Hz\'lik 4 Hz titreyen ton ve "Low rotor RPM" '
            'sesi buna uymuyor. Sabit alçak tona geçilmeli; UH-60M\'de sesli mesaj olup olmadığı doğrulanamadı. FGUK dosyası jenerik '
            '650 Hz sinüs (Bo105\'ten), gerçek değil.',
        recreate='Alçak, sabit (kesintisiz) ton; NR < %95 (veya Ng < %55) olduğunda başlar, yerde WOW ile susar. Kırmızı LOW ROTOR RPM '
                 'ışığı saniyede 3–5 kez yanıp söner. Frekans kılavuzda yazmıyor.'),
    ('uh60', 'engine_out'): dict(recreate='Sabit ton + #1/#2 ENG OUT ışığı, Ng < %55; yerde de susmaz (TM 1-1520-237-10).',
                                 rec='Oyunda motor arızası yok; eklenirse sabit ton olarak sentezlenmeli.'),
    ('uh60', 'stab_beep'): dict(recreate='Kulaklıkta kesikli bip; MASTER CAUTION\'a basınca susar.', rec='Oyunda stabilatör arızası yok; eklenirse sentezle.'),
    **{('uh60', k): dict(
        rec='UH-60A kılavuzunda radar altimetre uyarısı yalnız görsel (LO ışığı); sesli "ALTITUDE", "PULL UP", "BANK ANGLE" '
            'mesajları UH-60M için doğrulanamadı (bazı UH-60M/HH-60M\'lerde TAWS olabilir). Gerçekçilik için kaldırmayı veya tona '
            'çevirmeyi düşün.',
        recreate='Doğrulanmış bilgi yok.') for k in ('altitude', 'pullup', 'bankangle')},
})

NOTES = {
    'f16': NOREC + ' Tek gerçek F-16 sesi Auto-GCAS HUD kaydındaki tanımlanamayan 241 Hz ton. En büyük gerçekçilik kazancı kayıttan '
           'değil içerikten gelir: gerçek F-16\'da "LANDING GEAR", "LOW SPEED", "OVER G" sesleri yok; takım ve düşük hız için TON var, '
           '"WARNING" kırmızı uyarı ışıklarına bağlı.',
    'f22': NOREC + ' F-22 Demo Team kokpit videolarının hepsi ortam mikrofonu/müzik. F-22\'nin sesli uyarı listesi kamuya açık '
           'belgelerde doğrulanamadı.',
    'uh60': NOREC + ' Kaynak olarak UH-60A kullanıcı kılavuzu (TM 1-1520-237-10, kamu malı) kullanıldı: uyarılar TON; UH-60M\'nin '
            '(CAAS) sesli mesajları doğrulanamadı.',
}
for _ac in AIRCRAFT:
    if _ac['id'] in NOTES:
        _ac['note'] = NOTES[_ac['id']]

NOREC_AIR = ('Kamuya açık, lisansı uygun gerçek kayıt bulunamadı (Commons, DVIDS P-8A/C-40, Internet Archive, Freesound, NASA/FAA ve '
             'açık kaynak projeler tarandı).')
FG_UNK = ' FlightGear dosyası kaynağı belirsiz; gerçek sesle karşılaştırılamadığı için önerilmez.'
REC.update({
    # ---------------------------------------------------------------- A320neo
    ('a320neo', 'callouts'): dict(status='real',
        rec='Gerçek kayıt VAR: Air France A319 (CC BY-SA 3.0) ve Adria A319 (CC BY 3.0) kokpit videolarında FWC anonsları. Ses net ama '
            'motor/rüzgâr gürültüsü üstünde (≈6–16 dB) ve kayıplı kaynak; oyunda doğrudan kullanmak için gürültü azaltma gerekir, '
            'sonuç ElevenLabs kadar temiz olmayabilir. En iyi yol: bu kayıtları dinleyip "gerçek referans" olarak kullanmak — ya '
            'temizlenmiş CDG setini (500–20) almak ya da ElevenLabs sesini bunlara göre (hız, tonlama, İngiliz aksanı) yeniden '
            'üretmek. 2500, 1000, 10, 5 için gerçek kayıt yok. CC BY-SA seçilirse işlenmiş ses dosyaları da CC BY-SA olur.'),
    ('a320neo', 'retard'): dict(status='real',
        rec='Gerçek kayıt VAR (Air France A319, CC BY-SA 3.0): tek "RETARD" ve 4\'lü tekrar. Callout\'larla aynı gürültü sorunu. '
            'Tekrar aralığı oyundakiyle (2,2 s) karşılaştırılmalı.'),
    ('a320neo', 'cavalry'): dict(status='real',
        rec='Oyundaki ses (A320-family\'nin şemaya göre sentezi) gerçek A319 kaydıyla aynı dalga biçiminde: değiştirmeye gerek yok. '
            'Adria kaydı doğrulama referansı; CREDITS.txt\'teki "recordings" ifadesi "şemadan sentez" olarak düzeltilmeli.'),
    ('a320neo', 'crc'): dict(recreate='FWC\'nin ürettiği elektronik ses; aynı kaynaktaki cavalry şemasına benzer bir dalga biçimi '
                                      'tanımı muhtemel ama bulunamadı. Hızlı tekrarlanan tek-nota çan; MASTER WARN\'a basınca susar.'),
    ('a320neo', 'single_chime'): dict(recreate='Tek, kısa, sönümlenen elektronik çan; amber uyarıyla bir kez.'),
    ('a320neo', 'c_chord'): dict(recreate='Kısa (≈1,5 s) üç notalı akor; irtifaya yaklaşırken bir kez, sapmada tekrar.'),
    ('a320neo', 'cricket_stall'): dict(rec=NOREC_AIR + ' Oyundaki sentez cricket + "STALL STALL" kalsın.' + FG_UNK,
        recreate='Tiz, hızlı "cırcır" darbeleri ve ardından yapay erkek ses "STALL, STALL" (İngiliz aksanı); koşul sürdükçe döngü.'),
    **{('a320neo', k): dict(rec=NOREC_AIR + FG_UNK + ' Mevcut ElevenLabs sesi kalsın. Not: bu uyarıları Airbus\'ta FWC değil '
                                              'EGPWS bilgisayarı seslendirir; ses, callout kayıtlarındaki FWC sesinden farklı olabilir.',
                            recreate='EGPWS (Honeywell) erkek sesi — büyük olasılıkla Boeing\'dekiyle aynı ses ailesi; net, vurgulu, dar bant.')
       for k in ('pullup', 'sinkrate', 'toolow_gear', 'toolow_flaps', 'bankangle', 'terrain', 'toolow_terrain', 'dontsink',
                 'glideslope')},
    ('a320neo', 'windshear'): dict(rec=NOREC_AIR + ' Oyunda tetiklenmiyor.',
        recreate='Reaktif: "WINDSHEAR, WINDSHEAR, WINDSHEAR" (Airbus FWC sesi, kırmızı). Öngörülü: "WINDSHEAR AHEAD, WINDSHEAR AHEAD", '
                 '"GO AROUND, WINDSHEAR AHEAD", "MONITOR RADAR DISPLAY".'),
    ('a320neo', 'tcas'): dict(rec=NOREC_AIR + ' fgdata TCAS dosyaları TTS ve kelime dizileri eksik; oyunda TCAS yok.',
        recreate='FAA TCAS II v7.1 tablosundaki ifadeler, sakin erkek/kadın ses (üreticiye göre), iki kez tekrar ("CLIMB, CLIMB").'),
    ('a320neo', 'priority'): dict(rec='Oyunda sidestick önceliği yok. A320-family dosyaları temiz ama kaynağı belirsiz.'),
    ('a320neo', 'dual_input'): dict(rec='Oyunda yok. A320-family dosyası kaynağı belirsiz; Whisper anlaşılırlığı zayıf buldu.'),
    ('a320neo', 'speed'): dict(rec=NOREC_AIR, recreate='FWC erkek sesi "SPEED, SPEED, SPEED", koşul sürdükçe ≈5 s arayla.'),
    ('a320neo', 'triple_click'): dict(rec='Oyunda yok; gerekirse A320-family dosyası veya basit sentez yeterli.'),
    # ---------------------------------------------------------------- 737-800
    ('b737', 'callouts'): dict(status='real',
        rec='Gerçek kayıt VAR: Transaero 737NG (CC BY 3.0 — lisansı canlı YouTube sayfasında yeniden doğrula) en eksiksiz set; '
            'P-8A (kamu malı, atıf gerekmez) aynı ses. İkisi de gürültülü (≈3–5 dB). Kamu malı P-8A seti lisans açısından en '
            'rahatı ama 400/300/MINIMUMS/100 eksik. Öneri: ElevenLabs "Bill" sesini bu kayıtlara göre ayarla ya da gürültü '
            'azaltmayla temizlenmiş bir karma set dene. "TWENTY FIVE HUNDRED" ve "1000" için gerçek kayıt yok.'),
    ('b737', 'config_horn'): dict(status='real',
        rec='Gerçek kayıt VAR (P-8A, kamu malı): dokun-kalkta çalan kesikli korna. Oyunda konfigürasyon uyarısı yok; eklenirse bu '
            'kayıttan ya da ölçülen değerlerle (≈1,9 Hz, 0,21 s açık, ≈200 Hz temelli harmonik korna) sentezlenebilir.',
        recreate='Kesikli korna ≈1,9 darbe/s, darbe ≈0,21 s, ≈200 Hz temelli sert harmonik ses (P-8A kaydından ölçüldü).'),
    ('b737', 'gear_horn'): dict(rec=NOREC_AIR + ' fgdata dosyası jenerik ve hak durumu belirsiz → kullanılamaz. Oyunda bu durumda '
                                           '"TOO LOW, GEAR" konuşuyor; gerçek 737\'de önce sürekli korna çalar.',
        recreate='Sürekli (kesintisiz) korna; ton karakteri büyük olasılıkla kesikli kornayla aynı üreteç (≈200 Hz temelli) ama '
                 'kesintisiz — doğrulanmadı.'),
    ('b737', 'fire_bell'): dict(rec=NOREC_AIR + ' 737-800YV zili gerçek bir zil kaydına benziyor ama kaynağı belirsiz, 11 kHz. Oyunda '
                                           'yangın yok.',
        recreate='Hızlı vuruşlu klasik elektrikli zil (okul zili gibi), sürekli; BELL CUTOUT ile susar.'),
    ('b737', 'clacker'): dict(rec=NOREC_AIR + ' 737-800YV dosyası 8 kHz/8-bit; mevcut sentez kalsın.',
        recreate='Mekanik, sert "tak-tak-tak" (saniyede birkaç vuruş), hız VMO/MMO\'nun altına inene kadar.'),
    ('b737', 'shaker'): dict(rec=NOREC_AIR + ' Mevcut sentez kalsın.' + FG_UNK,
        recreate='Eksantrik ağırlıklı motorun kolonu sarsması: alçak frekanslı güçlü titreşim + mekanik tıkırtı, kokpitte çok yüksek.'),
    ('b737', 'wailer'): dict(status='none', rec='Gerçek kayıt bulunamadı. ' + 'Oyundaki dosya 737-800YV Apdisco.wav (kökeni "from 733", belirtilmemiş).'),
    ('b737', 'alt_alert'): dict(rec=NOREC_AIR + ' Oyunda tetiklenmiyor.', recreate='Kısa, tek elektronik ton; yaklaşırken bir kez.'),
    ('b737', 'crew_call'): dict(rec='Oyunda kabin çağrısı yok; oyundaki "chime" (master caution) gerçek 737\'de karşılıksız.',
                                recreate='İki notalı "ding-dong" (yüksek-alçak).'),
    **{('b737', k): dict(rec=NOREC_AIR + FG_UNK + ' Mevcut ElevenLabs sesi kalsın; ton olarak gerçek 737 anons kayıtlarındaki '
                                          'Honeywell sesine yaklaştırılabilir.',
                         recreate='Honeywell EGPWS erkek sesi (callout kayıtlarındaki ses), net ve vurgulu.')
       for k in ('sinkrate', 'toolow_gear', 'toolow_flaps', 'bankangle', 'terrain', 'toolow_terrain', 'dontsink', 'glideslope')},
    ('b737', 'pullup'): dict(rec=NOREC_AIR + FG_UNK,
        recreate='"WHOOP WHOOP PULL UP" (iki yükselen siren + ses) veya "TERRAIN TERRAIN, PULL UP"; kırmızı uyarı, sürdükçe tekrar.'),
    ('b737', 'windshear'): dict(rec=NOREC_AIR, recreate='İki tonlu siren + "WINDSHEAR, WINDSHEAR, WINDSHEAR".'),
    ('b737', 'tcas'): dict(rec='Commons dosyaları temiz ama kökeni belirsiz (simülatör olabilir) — yükleyene sorulmadan kullanma. '
                               'Oyunda TCAS yok.'),
})
for _ac in AIRCRAFT:
    if _ac['id'] == 'a320neo':
        _ac['note'] = ('Gerçek kayıt: FWC radyo altimetre anonsları, RETARD ve otopilot ayırma (cavalry charge) — Air France ve Adria '
                       'A319 kokpit videolarından (CC BY-SA 3.0 / CC BY 3.0). Oyundaki cavalry sesi gerçek kayıtla aynı dalga '
                       'biçiminde. Uyarı tonları (CRC, tek çan, C-chord, cricket), EGPWS ve rüzgâr kesmesi sesleri için lisansı '
                       'uygun gerçek kayıt yok.')
    if _ac['id'] == 'b737':
        _ac['note'] = ('Gerçek kayıt: EGPWS radyo altimetre anonsları (P-8A — kamu malı; Transaero 737NG — CC BY 3.0) ve kesikli '
                       'konfigürasyon kornası (P-8A). Yangın zili, clacker, stick shaker, wailer ve EGPWS uyarı sesleri için lisansı '
                       'uygun gerçek kayıt yok. Gerçek 737\'de master caution sesi yok.')

def _refs():
    out = []
    for fn in ('found_air.json', 'found_mil.json'):
        p = os.path.join(HERE, fn)
        if not os.path.exists(p):
            continue
        for r in json.load(open(p)).get('references', []):
            out.append(dict(url=(r.get('url') or '').split(' ')[0] if (r.get('url') or '').startswith('http') else None,
                            title=r.get('title') or r.get('url') or '',
                            content=r.get('contains') or r.get('content') or r.get('what') or '',
                            why=r.get('why_not_usable') or r.get('why') or r.get('reason') or ''))
    return out


REFERENCES += _refs()


_apply()
