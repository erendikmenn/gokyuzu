// Tutorial scenarios (src/ui/tutorial.js runs them): one list of steps per aircraft category × start.
//
// A step:
//   id         short id for telemetry ('tut' events)
//   topics     contextual hints about these topics stay quiet while the step is shown (src/ui/hints.js)
//   keys(k, c) chip labels for the card ("X · 9", "Shift / Ctrl"); k = key set (src/ui/tutorial-keys.js)
//   title(k, c, phase), text(k, c, phase), explicit(k, c, phase)   Turkish; {Label} renders an inline key chip
//   phase(c)   optional small integer (text variant: e.g. 0 = accelerating, 1 = at rotation speed); re-rendered on change
//   ripe(c)    optional: the ~12 s "more explicit" timer only runs while this is true (default: always)
//   nudge      seconds of ripe time before the explicit text (default 12)
//   enter(c)   optional: capture baselines into c.base when the step starts
//   done(c)    true when the player has done it (read from the flight model / input state)
//   meter(c,m) optional live readout: fills m.label, m.value, m.frac (0..1), m.warn; called ~5×/s
//   optional   shown as "isteğe bağlı" (completes by itself when the player moves on)
//   final      last card ("Serbestsin"): closes by itself after `hold` seconds
// The context c is filled once per frame by the controller (numbers only, no allocations): see tutorial.js.

const pct = (v) => `%${Math.round(v * 100)}`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------- shared steps ----------
function throttleStep(fighter) {
  return {
    id: fighter ? 'mil' : 'thr',
    topics: ['idle'],
    keys: (k) => (k.kb ? `${k.label('thrUp')} · ${k.label('preset')}` : k.touch ? k.label('thr') : k.label('thrUp')),
    title: () => (fighter ? 'Gazı MIL’e getir' : 'Gazı kalkış gücüne getir'),
    text: (k) => (fighter
      ? `${k.hold('thrUp')}: gaz kolu %90’da (MIL) durur.${k.kb ? ' Kısayol: {9}.' : ''}`
      : `${k.hold('thrUp')}${k.kb ? ' ya da {9} tuşuna bas' : k.touch ? ', %90 çizgisine kadar' : ''}. Frenler kendiliğinden bırakılır.`),
    explicit: (k) => (fighter
      ? `${k.hold('thrUp')}, gaz göstergesi MIL (%90) olana kadar.${k.kb ? ' Ya da {9} tuşuna bir kez bas.' : ''}`
      : `${k.hold('thrUp')}, gaz göstergesi %90’a çıkana kadar.${k.kb ? ' Kısayol: {9} tuşu gazı tek seferde %90 yapar.' : ''}`),
    meter(c, m) { m.label = 'Gaz'; m.value = pct(c.lever); m.frac = clamp01(c.lever / c.detent); },
    // also done when the player rolls off with a little less power (8 → 80 %) or is already flying
    done: (c) => c.lever >= c.detent - 0.02 || c.kt > 60 || c.airborne,
  };
}

const afterburnerStep = {
  id: 'ab',
  topics: [],
  optional: true,
  keys: (k) => k.label('thrUp'),
  title: () => 'Art yakıcı',
  text: (k) => (k.touch
    ? 'Gaz sürgüsünü MIL çizgisinden biraz daha yukarı it: kısa bir dirençten sonra art yakıcı yanar.'
    : k.pad
      ? 'Tetiği bırak, sonra {RT} tetiğini yeniden çek: kol MIL’i geçer, art yakıcı yanar.'
      : `Tuşu bırak, sonra ${k.chip('thrUp')} tuşuna yeniden basıp basılı tut: kol MIL’i geçer, art yakıcı yanar.`),
  explicit: (k) => (k.touch
    ? 'Sürgüyü MIL’de tutarken parmağını yukarı kaydırmaya devam et. İstemezsen bekle: hızlanınca bu adım kendiliğinden geçer.'
    : k.pad
      ? 'Tetiği bırak ve {RT} tetiğini yeniden çek. İstemezsen bekle: hızlanınca bu adım kendiliğinden geçer.'
      : `${k.chip('thrUp')} tuşunu bırak ve yeniden bas. İstemezsen bekle: hızlanınca bu adım kendiliğinden geçer.`),
  meter(c, m) { m.label = 'Gaz'; m.value = `${pct(c.lever)}${c.lever > c.detent + 0.005 ? ' AB' : ''}`; m.frac = clamp01(c.lever); },
  done: (c) => c.lever > c.detent + 0.01 || c.ab || c.kt > 100,
};

const rotateStep = {
  id: 'rotate',
  topics: ['rotate'],
  keys: (k) => k.label('pitchUp'),
  phase: (c) => (c.kt >= c.vr - 4 ? 1 : 0),
  ripe: (c) => c.kt >= c.vr - 4,
  title: (k, c, p) => (p ? 'Şimdi burnu kaldır!' : 'Hızlan, sonra burnu kaldır'),
  text: (k, c, p) => (p
    ? `${k.hold('pitchUp')}; uçak yerden kesilince yavaşça bırak.`
    : `Hız ${c.vr} kt olunca ${k.hold('pitchUp')}. Pistin ortasında kalmak için ${k.chip('yaw')}.`),
  explicit: (k) => `${k.hold('pitchUp')} ve burun yaklaşık 10° kalkana kadar tut. Havalanınca bırak.`,
  meter(c, m) { m.label = 'Hız'; m.value = `${Math.round(c.kt)} / ${c.vr} kt`; m.frac = clamp01(c.kt / c.vr); },
  done: (c) => c.ev.takeoff || (!c.f.onGround && c.f.agl > 5),
};

const gearUpStep = {
  id: 'gear',
  topics: ['gear'],
  keys: (k) => k.label('gear'),
  title: () => 'İniş takımını topla',
  text: (k) => `Havalandın! Tırmanırken ${k.press('gear')}.`,
  explicit: (k) => `${k.press('gear')}, bir kez yeter. Ekranda “İniş takımı YUKARI” yazısını göreceksin.`,
  done: (c) => c.f.gearHandleDown === false,
};

const flapsUpStep = {
  id: 'flaps',
  topics: ['flaps'],
  keys: (k) => k.label('flapsUp'),
  enter(c) { c.base.idx0 = Math.max(1, c.f.flapsIndex || 1); },
  phase: (c) => (c.kt >= c.flapKt ? 1 : 0),
  ripe: (c) => c.kt >= c.flapKt,
  title: () => 'Flapleri topla',
  text: (k, c, p) => (p
    ? `${k.press('flapsUp')}: her basış flapleri bir kademe toplar.`
    : `Hız ${c.flapKt} kt’yi geçince ${k.press('flapsUp')}. Hızlanmak için burnu biraz indir (${k.chip('pitchDown')}).`),
  explicit: (k, c) => `${k.press('flapsUp')}, flap göstergesi ${c.flap0} olana kadar tek tek.`,
  meter(c, m) {
    if (c.kt < c.flapKt && c.f.flapsIndex > 0) { m.label = 'Hız'; m.value = `${Math.round(c.kt)} / ${c.flapKt} kt`; m.frac = clamp01(c.kt / c.flapKt); return; }
    m.label = 'Flap'; m.value = `${c.f.flapsLabel} → ${c.flap0}`; m.frac = clamp01(1 - (c.f.flapsIndex || 0) / c.base.idx0);
  },
  done: (c) => (c.f.flapsIndex || 0) === 0,
};

function freeStep(cat) {
  return {
    id: 'free',
    topics: [],
    final: true,
    hold: 10,
    keys: (k) => (cat === 'fighter' ? `${k.label('speedbrake')} · ${k.label('autopilot')} · ${k.label('camera')} · ${k.label('help')}`
      : cat === 'helicopter' ? `${k.label('autopilot')} · ${k.label('thrDown')} · ${k.label('help')}` : `${k.label('autopilot')} · ${k.label('camera')} · ${k.label('help')}`),
    title: () => 'Serbestsin, iyi uçuşlar!',
    text: (k) => (cat === 'fighter' ? `${k.chip('speedbrake')} hava freni, ${k.chip('autopilot')} otopilot, ${k.chip('camera')} kameralar, ${k.chip('help')} tüm kontroller.`
      : cat === 'helicopter' ? `İnmek için ${k.chip('autopilot')} ile askıda kal, sonra ${k.chip('thrDown')} ile kolektifi azalt. ${k.chip('help')} tüm kontroller.`
        : `${k.chip('autopilot')} otopilot, ${k.chip('camera')} kameralar, ${k.chip('help')} tüm kontroller.`),
    explicit: null,
    done: (c) => c.stepT >= 10,
  };
}

// ---------- airborne (AIR-GGB, AIR-CITY, helicopter anywhere in the air) ----------
function airborneSteps(cat) {
  const heli = cat === 'helicopter';
  return [
    {
      id: 'pitch',
      topics: ['pitch'],
      keys: (k) => k.label('pitch'),
      title: () => (heli ? 'Cyclic: ileri ve geri' : 'Burnu kontrol et'),
      text: (k) => (heli
        ? `${k.chip('pitchDown')} burnu eğer ve hızlandırır, ${k.chip('pitchUp')} kaldırır ve yavaşlatır. Kısa dokunuşlarla dene.`
        : `${k.chip('pitchDown')} burnu indirir, ${k.chip('pitchUp')} kaldırır. Kısa dokunuşlarla dene.`),
      explicit: (k) => `${k.hold('pitchUp')} bir saniye, sonra bırak: burun kalkar. Ufku ekranın ortasında tut.`,
      meter(c, m) { m.label = 'Burun'; m.value = `${c.f.pitch >= 0 ? '+' : '−'}${Math.abs(Math.round(c.f.pitch))}°`; m.frac = clamp01(c.acc.pitch / 1.2); },
      done: (c) => c.acc.pitch >= 1.2,
    },
    {
      id: 'roll',
      topics: ['roll'],
      keys: (k) => k.label('roll'),
      phase: (c) => (c.base.banked ? 1 : 0),
      title: (k, c, p) => (p ? 'Şimdi kanatları düzelt' : 'Yatır ve dön'),
      text: (k, c, p) => (p
        ? `${k.touch ? 'Çubuğu ters yöne kısa it' : 'Ters yöne kısa bas'}: yatış 0° olsun. ${heli ? 'Helikopter' : 'Uçak'} düz uçar.`
        : `${k.chip('rollLeft')} / ${k.chip('rollRight')} yana yatırır, ${heli ? 'helikopter' : 'uçak'} o yöne döner. Yatış 20° olsun.`),
      explicit: (k, c, p) => (p
        ? `Sağa yatıksan ${k.chip('rollLeft')}, sola yatıksan ${k.chip('rollRight')} ${k.touch ? 'yönüne kısa it' : k.pad ? 'yönüne kısa it' : 'tuşuna kısa bas'}; yatış 0° olana kadar.`
        : `${k.hold('rollRight')}, yatış 20° olana kadar; sonra ${k.chip('rollLeft')} ile kanatları düzelt.`),
      meter(c, m) {
        const r = Math.round(c.f.roll);
        m.label = 'Yatış'; m.value = `${Math.abs(r)}°${r > 1 ? ' sağ' : r < -1 ? ' sol' : ''}`;
        m.frac = c.base.banked ? clamp01(1 - Math.abs(c.f.roll) / 20) : clamp01(Math.abs(c.f.roll) / 18);
      },
      done(c) {
        if (Math.abs(c.f.roll) > 16) c.base.banked = true;
        return !!c.base.banked && Math.abs(c.f.roll) < 7;
      },
    },
    {
      id: heli ? 'collective' : 'throttle',
      topics: ['throttle'],
      keys: (k) => k.label('thr'),
      enter(c) { c.base.thr0 = c.lever; },
      title: () => (heli ? 'Kolektif: yüksel ve alçal' : 'Gazı ayarla'),
      text: (k) => (heli
        ? `${k.chip('thrUp')} kolektifi artırır (yükselir), ${k.chip('thrDown')} azaltır (alçalır).`
        : `${k.chip('thrUp')} gazı artırır, ${k.chip('thrDown')} azaltır. Hız göstergesini izle.`),
      explicit: (k) => (heli
        ? `${k.hold('thrDown')} yarım saniye: kolektif azalır, helikopter alçalır.`
        : `${k.hold('thrDown')} bir saniye: gaz azalır, uçak yavaşlar.`),
      meter(c, m) { m.label = heli ? 'Kolektif' : 'Gaz'; m.value = pct(c.lever); m.frac = clamp01(Math.abs(c.lever - c.base.thr0) / (heli ? 0.05 : 0.08)); },
      done: (c) => Math.abs(c.lever - c.base.thr0) >= (heli ? 0.05 : 0.08),
    },
    heli ? {
      ...freeStep('helicopter'),
      text: (k) => `${k.chip('autopilot')} hızı, irtifayı ve yönü tutar; yavaşken askıda tutar. ${k.chip('camera')} kameralar, ${k.chip('help')} tüm kontroller.`,
      keys: (k) => `${k.label('autopilot')} · ${k.label('camera')} · ${k.label('help')}`,
    } : freeStep(cat),
  ];
}

// ---------- AIR-SFO-FINAL: landing (fixed wing, gear and flaps already out) ----------
function landingSteps(cat) {
  const airliner = cat === 'airliner';
  return [
    {
      id: 'app',
      topics: ['approach', 'autopilot'],
      keys: (k) => (airliner ? `${k.label('autopilot')} · ${k.label('pitch')}` : `${k.label('pitch')} · ${k.label('roll')}`),
      title: () => 'Son yaklaşmadasın',
      text: (k) => (airliner
        ? `Takım ve flaplar açık. ${k.chip('autopilot')}: otomatik ILS inişi; ya da ${k.chip('pitch')}, ${k.chip('roll')} ile elle uç.`
        : `Takım açık. ${k.chip('pitch')} ile süzülüşü, ${k.chip('roll')} ile piste hizayı koru.`),
      explicit: (k) => (airliner
        ? `En kolayı: ${k.press('autopilot')}, bir kez. Otopilot pisti yakalar, süzülür ve kendisi iner.`
        : `Pist ekranın ortasında kalsın, burun ufkun biraz altında. Hız artarsa gazı azalt (${k.chip('thrDown')}).`),
      done: (c) => (airliner && c.ap) || c.acc.stick >= 2,
    },
    {
      id: 'touch',
      topics: ['approach', 'sink'],
      keys: (k, c) => (airliner && c.ap ? k.label('autopilot') : `${k.label('pitchUp')} · ${k.label('thrDown')}`),
      phase: (c) => (airliner && c.ap ? 1 : 0),
      ripe: (c) => !(airliner && c.ap) && c.sinkFpm > 950,
      nudge: 3,
      title: (k, c, p) => (p ? 'Otopilot iniyor' : 'Piste yumuşak koy'),
      text: (k, c, p) => (p
        ? `Otopilot süzülür, pist başında burnu kaldırır ve yerde fren yapar. Devralmak için ${k.chip('autopilot')}.`
        : `Alçalma 700 ft/dk’nın altında kalsın. Pist başında gazı kes (${k.chip('thrDown')}) ve burnu hafif kaldır (${k.chip('pitchUp')}).`),
      explicit: (k, c, p) => (p ? null
        : `Çok hızlı alçalıyorsun: ${k.chip('pitchUp')} ile burnu biraz kaldır, hız düşerse gaz ver (${k.chip('thrUp')}).`),
      meter(c, m) {
        const fpm = Math.max(0, Math.round(c.sinkFpm / 10) * 10);
        m.label = 'Alçalma'; m.value = `${fpm} ft/dk`; m.frac = clamp01(fpm / 1200); m.warn = fpm > 900;
      },
      done: (c) => c.ev.touchdown || (c.f.onGround && c.f.agl < 1),
    },
    {
      id: 'stop',
      topics: ['brake'],
      keys: (k) => k.label('brake'),
      title: () => 'Yavaşla ve dur',
      text: (k, c) => (airliner && c.f.autobrake
        ? `Otomatik fren devrede. Daha sert frenlemek için ${k.hold('brake')}.`
        : `${k.hold('brake')}; uçak dursun.`),
      ripe: (c) => c.inp.brake < 0.3 && c.gsKt > 20,     // no nagging while the player brakes
      explicit: (k) => `${k.hold('brake')}, hız 20 kt’nin altına inene kadar.`,
      meter(c, m) { m.label = 'Hız'; m.value = `${Math.round(c.gsKt)} kt`; m.frac = clamp01(1 - c.gsKt / 140); },
      done: (c) => c.f.onGround && c.gsKt < 20,
    },
    {
      id: 'free',
      topics: [],
      final: true,
      hold: 10,
      keys: (k) => (k.touch ? `${k.label('pause')}` : `${k.label('reset')} · ${k.label('menu')} · F1`),
      title: () => 'Tebrikler, indin!',
      text: (k) => (k.touch ? `${k.chip('pause')} menüsünden yeniden dene, ana menüye dön ya da tüm kontrolleri gör.`
        : `${k.chip('reset')} ile yeniden dene, ${k.chip('menu')} ana menü, {F1} tüm kontroller.`),
      explicit: null,
      done: (c) => c.stepT >= 10,
    },
  ];
}

// ---------- helicopter from the ground ----------
const HELI_GROUND = [
  {
    id: 'lift',
    topics: ['idle'],
    keys: (k) => k.label('thrUp'),
    title: () => 'Kolektifi artır, havalan',
    text: (k) => `${k.hold('thrUp')}; helikopter yerden kesilince bırak.`,
    explicit: (k) => `${k.hold('thrUp')}, kolektif %60 civarına gelene kadar. Yükselmeye başlayınca bırak.`,
    meter(c, m) { m.label = 'Kolektif'; m.value = pct(c.lever); m.frac = clamp01(c.lever / 0.62); },
    done: (c) => !c.f.onGround && c.f.agl > 2,
  },
  {
    id: 'hover',
    topics: ['autopilot'],
    keys: (k, c) => (c.f.onGround ? k.label('thrUp') : k.label('autopilot')),
    phase: (c) => (c.f.onGround ? 0 : 1),
    ripe: (c) => !c.f.onGround,
    title: (k, c, p) => (p ? 'Askıda kal' : 'Biraz yüksel'),
    text: (k, c, p) => (p
      ? `${k.press('autopilot')}: askıda tutma, helikopteri bu yükseklikte yerinde tutar.`
      : `${k.hold('thrUp')}; birkaç metre yüksel, sonra ${k.press('autopilot')}.`),
    explicit: (k) => `${k.press('autopilot')}, bir kez. Ekranda “Otopilot AÇIK” yazısını göreceksin.`,
    meter(c, m) { m.label = 'Yükseklik'; m.value = `${Math.round(c.f.agl * 3.28084)} ft`; m.frac = clamp01(c.f.agl / 10); },
    done: (c) => c.ap && !c.f.onGround,
  },
  {
    id: 'forward',
    topics: ['cyclic'],
    keys: (k) => k.label('pitchDown'),
    title: () => 'İleri uç',
    text: (k) => `${k.hold('pitchDown')}: burun eğilir, helikopter ileri gider.`,
    explicit: (k) => `${k.hold('pitchDown')} ve hız 15 kt’yi geçene kadar bırakma.`,
    meter(c, m) { m.label = 'Hız'; m.value = `${Math.max(0, Math.round(c.fwdKt))} / 15 kt`; m.frac = clamp01(c.fwdKt / 15); },
    done: (c) => c.fwdKt >= 15,
  },
  {
    id: 'turn',
    topics: ['turn'],
    keys: (k) => `${k.label('yaw')} · ${k.label('roll')}`,
    enter(c) { c.base.hdg0 = c.f.heading; },
    title: () => 'Dön',
    text: (k) => `${k.chip('yaw')} pedallarla burnu çevirir, ${k.chip('roll')} yana yatırır. 45° dön.`,
    explicit: (k) => `${k.hold('yawRight')}: helikopter sağa döner. Pusula 45° değişene kadar tut.`,
    meter(c, m) { m.label = 'Dönüş'; m.value = `${Math.round(c.turned)}° / 45°`; m.frac = clamp01(c.turned / 45); },
    done: (c) => c.turned >= 45,
  },
  freeStep('helicopter'),
];

/** Pick the scenario for a flight start: 'runway' | 'air' | 'final' × category. */
export function pickScenario(category, spawn, flight) {
  const cat = category === 'fighter' || category === 'helicopter' ? category : 'airliner';
  const air = !!(spawn && spawn.altitude != null);
  if (cat === 'helicopter') return air ? { id: 'heli-air', steps: airborneSteps(cat) } : { id: 'heli-ground', steps: HELI_GROUND };
  if (air && (spawn.id === 'AIR-SFO-FINAL' || spawn.final) && flight && flight.gearHandleDown) return { id: `${cat}-final`, steps: landingSteps(cat) };
  if (air) return { id: `${cat}-air`, steps: airborneSteps(cat) };
  const steps = cat === 'fighter'
    ? [throttleStep(true), afterburnerStep, rotateStep, gearUpStep, freeStep('fighter')]
    : [throttleStep(false), rotateStep, gearUpStep, flapsUpStep, freeStep('airliner')];
  return { id: `${cat}-runway`, steps };
}
