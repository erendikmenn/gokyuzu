// Player-facing reference data (Turkish): aircraft facts for the menu cards, loading tips, airport and
// landmark labels. Published figures (manufacturer / USAF / US Army fact sheets), rounded.
import { IS_MAC, THROTTLE_KEYS } from '../core/platform.js';

export const AIRCRAFT_INFO = {
  f16: {
    short: 'F-16C',
    blurb: 'Çevik, tek motorlu çok rollü savaş uçağı. Fly-by-wire kontrol, 9 G manevra kabiliyeti.',
    specs: [
      ['Azami hız', '2.120 km/sa · Mach 2,05'],
      ['Menzil', '4.220 km · feribot'],
      ['Motor', '1 × GE F110‑GE‑129 · 131 kN (art yakıcılı)'],
    ],
    extra: [['Uzunluk', '15,1 m'], ['Kanat açıklığı', '9,96 m'], ['Mürettebat', '1 pilot']],
    tags: ['Art yakıcı', '9 G'],
  },
  f22: {
    short: 'F-22A',
    blurb: 'Radara az görünen hava üstünlük uçağı. İtki yönlendirmeli nozullar ve art yakıcısız süper seyir.',
    specs: [
      ['Azami hız', '2.410 km/sa · Mach 2,25'],
      ['Menzil', '2.960 km · feribot'],
      ['Motor', '2 × P&W F119‑PW‑100 · 2 × 156 kN'],
    ],
    extra: [['Uzunluk', '18,9 m'], ['Kanat açıklığı', '13,6 m'], ['Mürettebat', '1 pilot']],
    tags: ['İtki yönlendirme', 'Süper seyir'],
  },
  a320neo: {
    short: 'A320neo',
    blurb: 'Yeni nesil motorlu dar gövde yolcu uçağı. Fly-by-wire yan çubuk, sharklet kanat uçları.',
    specs: [
      ['Seyir hızı', '830 km/sa · Mach 0,78'],
      ['Menzil', '6.300 km'],
      ['Motor', '2 × CFM LEAP‑1A · 2 × 121 kN'],
    ],
    extra: [['Uzunluk', '37,6 m'], ['Kanat açıklığı', '35,8 m'], ['Yolcu', '165–194']],
    tags: ['Otopilot', 'CONF 1–FULL'],
  },
  b737: {
    short: '737-800',
    blurb: 'Dünyanın en yaygın yolcu jeti ailesinden. Klasik boyunduruk, kanat ucu winglet’leri.',
    specs: [
      ['Seyir hızı', '842 km/sa · Mach 0,785'],
      ['Menzil', '5.440 km'],
      ['Motor', '2 × CFM56‑7B27 · 2 × 121 kN'],
    ],
    extra: [['Uzunluk', '39,5 m'], ['Kanat açıklığı', '35,8 m'], ['Yolcu', '162–189']],
    tags: ['Otopilot', 'Flap 1–40'],
  },
  uh60: {
    short: 'UH-60M',
    blurb: 'Dört palli, çift motorlu genel maksatlı helikopter. Havada asılı kalabilir, her yere iner.',
    specs: [
      ['Azami hız', '294 km/sa · 159 kt'],
      ['Menzil', '590 km · iç yakıtla'],
      ['Motor', '2 × GE T700‑GE‑701D · 2 × 1.490 kW'],
    ],
    extra: [['Uzunluk', '19,8 m'], ['Rotor çapı', '16,4 m'], ['Kabin', '11 asker']],
    tags: ['Havada asılı', 'Dikey iniş'],
  },
};

export const CATEGORY_LABEL = { fighter: 'Savaş uçağı', airliner: 'Yolcu uçağı', helicopter: 'Helikopter' };

export const AIRPORTS = {
  KSFO: { code: 'SFO', name: 'San Francisco Uluslararası', short: 'SFO' },
  KNGZ: { code: 'NGZ', name: 'Alameda Hava Üssü', short: 'Alameda' },
  KOAK: { code: 'OAK', name: 'Oakland Uluslararası', short: 'Oakland' },
};
export const AIRPORT_ORDER = ['KSFO', 'KNGZ', 'KOAK'];

// landmark ids from data/sf/landmarks.json → Turkish display names
export const LANDMARK_NAMES = {
  golden_gate_bridge: 'Golden Gate Köprüsü',
  bay_bridge_west: 'Bay Bridge',
  bay_bridge_east: 'Bay Bridge (doğu)',
  transamerica_pyramid: 'Transamerica Piramidi',
  salesforce_tower: 'Salesforce Kulesi',
  coit_tower: 'Coit Kulesi',
  ferry_building: 'Ferry Building',
  alcatraz: 'Alcatraz Adası',
  sutro_tower: 'Sutro Kulesi',
  palace_of_fine_arts: 'Güzel Sanatlar Sarayı',
  city_hall: 'Belediye Binası',
  oracle_park: 'Oracle Park',
  treasure_island: 'Treasure Island',
  yerba_buena_island: 'Yerba Buena Adası',
  angel_island: 'Angel Adası',
  twin_peaks: 'Twin Peaks',
  mount_davidson: 'Davidson Tepesi',
  san_bruno_mountain: 'San Bruno Dağı',
  chase_center: 'Chase Center',
  painted_ladies: 'Painted Ladies',
  fort_point: 'Fort Point',
  pier_39: 'Pier 39',
  lombard_street: 'Lombard Caddesi',
  port_of_oakland_cranes: 'Oakland Limanı',
  sfo_tower: 'SFO kulesi',
};

// Rotating loading-screen tips (controls + a little local colour).
export const TIPS = [
  'Kalkış: gazı tam aç (Shift veya X), kalkış hızına ulaşınca burnu yavaşça kaldır (S).',
  'C tuşu kamera açıları arasında geçiş yapar: Takip, Kanat, Serbest, Geçiş, Kule ve Kokpit.',
  'T tuşu doğrudan kokpit ile dış görünüm arasında geçiş yapar.',
  'Kokpitte fareyle sürükleyerek etrafına bak, tekerlekle yakınlaştır. Çift tıklama bakışı ortalar.',
  'F-16 ve F-22’de gaz kolu MIL kademesinde durur; gaz tuşunu bırakıp yeniden basınca art yakıcı devreye girer.',
  'Yolcu uçaklarında O tuşu otopilotu ve otomatik gazı açar; iniş takımı inikken ILS yaklaşmasını uçar.',
  'Black Hawk’ta O tuşu otomatik havada asılı kalmayı (hover hold) açar.',
  'Y tuşuyla arkaya bakabilir, virgül ve nokta ile kameralar arasında geri / ileri geçebilirsin.',
  'H tuşu göstergeleri Tam → Sade → Kapalı arasında değiştirir.',
  'İnişe geçmeden önce G ile iniş takımlarını indir ve flapleri (F) kademe kademe aç.',
  `Black Hawk’ta ${THROTTLE_KEYS} kolektifi kontrol eder: havada asılı kalmak için küçük dokunuşlarla ayarla.`,
  'Yolcu uçaklarında yaklaşma hızı ağırlığa göre değişir; hız bandındaki VREF işaretini takip et.',
  '“PULL UP” uyarısını duyduğunda gazı aç ve burnu hemen kaldır.',
  'Golden Gate Köprüsü’nün kuleleri deniz seviyesinden 227 metre yükselir.',
  'SFO’nun 28L ve 28R pistleri körfeze doğru uzanır; sık sık paralel iniş yapılır.',
  'Alcatraz Adası, Golden Gate ile Bay Bridge’in tam arasında yer alır.',
  'Sutro Kulesi, şehrin en yüksek tepelerinden birinin üstünde durur; alçak uçarken dikkat.',
  'San Francisco’nun ünlü sisi (Karl) yazın öğleden sonra Golden Gate’ten içeri süzülür.',
  'Serbest kamerada fareyle sürükleyerek uçağın etrafında dön, tekerlekle uzaklaş.',
  'P veya Esc oyunu duraklatır, F1 tüm kontrolleri gösterir.',
  'Yumuşak iniş için pist başında gazı kes ve burnu hafifçe kaldırarak alçalma hızını azalt.',
];

// Controls summary for the menu (keys as shown on a Turkish-Q / US keyboard; the in-game help lists the live bindings)
export const MENU_CONTROLS = {
  common: [
    ['W / S', 'Burun'],
    ['A / D', 'Yatış'],
    ['Q / E', 'Dümen'],
    [THROTTLE_KEYS, 'Gaz'],
    ['C', 'Kamera'],
    ['T', 'Kokpit'],
    ['P', 'Duraklat'],
    ['F1', 'Tüm kontroller'],
  ],
  fighter: [['G', 'İniş takımı'], [IS_MAC ? '2× Shift' : '2× X', 'Art yakıcı']],
  airliner: [['G', 'İniş takımı'], ['F / V', 'Flap']],
  helicopter: [[THROTTLE_KEYS, 'Kolektif'], ['Q / E', 'Pedal'], ['W A S D', 'Cyclic']],
};
