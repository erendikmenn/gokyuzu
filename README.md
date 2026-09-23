# Gökyüzü SF: San Francisco Körfezi uçuş simülatörü

Tarayıcıda çalışan, Three.js ile yazılmış bir uçuş simülatörü. Harita, San Francisco Körfezi'nin gerçek arazisi ve gerçek hava fotoğraflarıyla kurulu: SFO, Oakland, Alameda Hava Üssü, Golden Gate ve Bay Bridge, şehir binaları. Beş uçağın modelleri, kokpitleri ve render'ları Blender ile üretildi. Sesler tamamen sentezlendi.

## Nasıl oynanır

1. Finder'da `oyna.command` dosyasına çift tıkla. Yerel sunucu başlar ve Safari açılır.
   (Elle başlatmak için: `node tools/serve.mjs 5173` ve tarayıcıda `http://localhost:5173/`.)
2. Menüden uçağı ve kalkış noktasını seç, **Uç** butonuna bas.
3. Diğer sayfalar:
   - `galeri.html`: Blender render galerisi (önce `node tools/make_gallery.mjs` çalıştır)
   - `ada.html`: ilk sürümdeki küçük ada oyunu (Cessna)

Menüyü atlamak için doğrudan bağlantı da kullanılabilir: `index.html?aircraft=f16&spawn=AIR-GGB`
- Uçaklar: `f16`, `f22`, `a320neo`, `b737`, `uh60`
- Kalkış noktaları: `KSFO-28R`, `KSFO-28L`, `KSFO-01R`, `KNGZ-24`, `KNGZ-06`, `KOAK-30`, `AIR-GGB`, `AIR-SFO-FINAL`, `AIR-CITY`

## Uçaklar

| Uçak | Öne çıkanlar |
|---|---|
| F-16C Fighting Falcon | FLCS kontrol yasaları (+9/−3 g, 25° hücum açısı sınırı), afterburner, HUD, 2 MFD, DED, RWR |
| F-22A Raptor | 60° hücum açısına kadar kontrol, itki yönlendirme, çift afterburner, 7 ekranlı cam kokpit |
| Airbus A320neo | Normal law korumaları, flare modu, ECAM, otomatik gaz, ILS'li otomatik iniş |
| Boeing 737-800 | Klasik yoke kontrolü, stick shaker, 6 DU ve 2 CDU, ters itki, otomatik fren |
| UH-60M Black Hawk | Yer etkisi, geçiş kaldırması (ETL), vorteks halkası, otorotasyon, askıda tutma otopilotu (AFCS) |

## Kontroller (klavye)

| Tuş | İşlev |
|---|---|
| W / S  ·  ↑ / ↓ | Burun aşağı / yukarı |
| A / D  ·  ← / → | Sola / sağa yatış |
| Q / E | Dümen sola / sağa (yerde burun tekerleği) |
| Shift / Ctrl | Gaz artır / azalt (helikopterde kolektif) |
| X / Z  ·  + / − | Gaz artır / azalt (Mac'te Ctrl + ok tuşları masaüstü değiştirdiği için bunlar önerilir) |
| 1 … 9  ·  0 | Gaz %10 … %90  ·  %100 |
| G | İniş takımı indir / topla |
| F / V | Flap bir kademe indir / topla |
| K | Spoiler / hava freni |
| N | Ters itki (yerde, rölantide) |
| O | Otopilot (yolcu uçaklarında ILS yaklaşma; helikopterde askıda tutma) |
| B / Boşluk | Fren |
| L | Işıklar |
| C  ·  , / . | Kamera değiştir (Kokpit, Takip, Kanat, Serbest, Geçiş, Kule) |
| T | Kokpit / dış görünüm |
| Y | Arkaya bak |
| R | Yeniden başla |
| P / Esc | Duraklat |
| H | Göstergeleri gizle / göster |
| M | Sesi kapat / aç |
| F1 / ? | Yardım |
| Tab | Ana menü |

Savaş uçaklarında gaz kolu MIL'de durur. Afterburner için gaz artırma tuşuna bir kez daha bas. Kokpitte fareyle sürükleyerek etrafa bakılır, tekerlekle yakınlaştırılır, çift tıklamayla bakış ortalanır. Oyun kolu da desteklenir (standart eşleme).

## Proje yapısı

- `src/app/`: ana döngü ve kalkış noktaları · `src/world-sf/`: arazi, su, gökyüzü, şehir, simge yapılar, havalimanları
- `src/aircraft/<id>/`: uçak modeli, animasyonu (`model.js`) ve uçuş verileri (`spec.js`)
- `src/flight/`: sabit kanat ve helikopter fiziği, girdi · `src/avionics/`: kokpit ekranları · `src/audio/`: ses motoru · `src/ui/`: menü, HUD, kameralar
- `blender/`: tüm Blender script'leri (uçaklar, simge yapılar, havalimanları, şehir) · `tools/geo/`: veri hattı (USGS 3DEP, NAIP, OSM, DataSF) · `tools/audio/`: ses sentezi
- `CONTRACTS-SF.md`: modüller arası sözleşme (koordinat sistemi, arayüzler, Blender kuralları)

## Varlıkları yeniden üretmek

`assets/`, `renders/` ve `data/sf/raw/` git'e girmez, hepsi script'lerden yeniden üretilir:
- Uçaklar: `blender/aircraft/<id>/make_all.sh` (veya `build.py`)
- Sesler: `.venv/bin/python tools/audio/build_all.py`
- Arazi ve hava fotoğrafı: `tools/geo/terrain_*.py` ve `imagery_*.py` (ayrıntı: `assets/sf/terrain/README.md`)

Testler: `node tests/fixedwing.test.mjs` (182), `node tests/helicopter.test.mjs` (46), `node tests/physics.test.mjs` (ada oyunu, 26).

Veri kaynakları: USGS 3DEP ve NAIP (kamu malı), OpenStreetMap (© OpenStreetMap katkıcıları, ODbL), DataSF (açık veri).

## Geliştirme ve yayın düzeni

| | Yerel | Staging | Canlı |
|---|---|---|---|
| Adres | `node tools/serve.mjs` → localhost:5173 | https://staging.fs.erenailab.com (yalnızca izinli IP) | https://fs.erenailab.com |
| Git dalı | `dev` | `dev` | `main` |
| Yayın | – | `tools/deploy/deploy.sh staging` | `tools/deploy/deploy.sh production` |

- Geliştirme `dev` dalında yapılır; staging'de denenir; onaylanınca `dev` → `main` birleştirilir ve canlıya çıkılır.
- Canlıya çıkış yalnızca temiz bir `main` dalından olur, onay ister ve yayını `release-YYYYMMDD-HHMM` etiketiyle işaretler.
- Staging'in ekranında turuncu "STAGING · sürüm" etiketi görünür. IP değişirse: `tools/deploy/staging_access.sh` (izinli IP listesi repo dışında: `~/.config/gokyuzu/staging_ips`).
- Geri alma: kovalar sürümlüdür (eski sürümler 30 gün saklanır). `.venv/bin/python tools/deploy/rollback.py production --list` ile yayın anlarını gör, `--to 2026-09-23T14:05` ile önizle, `--apply` ile geri al.
- Yayın script'leri AWS'ye root ile değil, yalnızca iki kovaya ve iki CloudFront dağıtımına yetkili `gokyuzu-deployer` IAM kullanıcısıyla (`~/.aws/credentials` → `[gokyuzu-deploy]`) bağlanır.
- Altyapı: AWS S3 + CloudFront (hesap "gokyuzu-admin", eu-central-1), sertifikalar ACM (us-east-1), DNS Cloudflare (erenailab.com, "DNS only").
