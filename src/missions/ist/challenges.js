// İstanbul free-flight challenges ("Serbest uçuş görevleri", CONTRACTS-SF.md §12.1 / CONTRACTS-IST.md §6 Missions):
// the İstanbul missions' objectives, detected while the player flies freely. Data in the format of
// src/missions/challenges.js CHALLENGES, run by its tracker (loadChallengeSet('ist') → createChallengeTracker({
// challenges, catalog })): only its kinds are used — bridge (def.bridge), gates (the first objective of def.mission:
// frames, rings, and the Kız Kulesi orbit, whose checkpoint rings make it a gates run), climb, alcatraz (the hover +
// pad objectives of def.mission), landing, emergency (need.waterText). Boards `ff-ist-<name>` (ids `ist-<name>`).
// No DOM, no three.js.
//
//   bridge    any aircraft, under the deck between the towers of 15 Temmuz, FSM, YSS; re-armed after each pass
//   gates     Boğaz low pass (with its 500 ft corridor), Haliç, Boğaz tour, historic peninsula rings, and the Kız Kulesi
//             orbit (UH-60: 120–320 m / 100–500 ft, right; fixed wing: 1–2 km / 700–1.450 ft, left): gate 1 (the first
//             checkpoint, 45° of circle) starts the clock, all gates / the full circle complete it
//   climb     fixed wing: from a standstill on a runway to 10,000 ft MSL (clock from the take-off roll)
//   alcatraz  UH-60: hover 5 s over the Yenikapı pad, then land on it (ist-yarimada's last two objectives)
//   landing   every runway landing (≥ 1★): points × 20
//   emergency explicit start: engine failure (A320 / 737), flameout (F-16), ditching (A320 / 737 over the sea),
//             autorotation (UH-60) — land safely
import { buildMission } from './catalog.js';
import { FT } from '../util.js';

const ALL = ['f16', 'f22', 'a320neo', 'b737', 'uh60'];
const FIXED = ['f16', 'f22', 'a320neo', 'b737'];

/** The İstanbul free-flight challenges. `board` = the leaderboard id (ff-<id>). */
export const CHALLENGES = [
  {
    id: 'ist-bogazici', kind: 'bridge', bridge: 'bogazici', mission: 'ist-15temmuz', aircraft: ALL, trackable: true,
    title: '15 Temmuz Şehitler Köprüsü\'nün altından geç',
    hint: 'Kuleler arasından, tabliyenin altından geç (ortada ≈ 64 m). Ortadan ve 15–50 m\'den geçmek tam puan.',
    score: { base: 1000 }, stars: [1000, 1450, 1650],
  },
  {
    id: 'ist-fsm', kind: 'bridge', bridge: 'fsm', mission: 'ist-fsm', aircraft: ALL, trackable: true,
    title: 'Fatih Sultan Mehmet Köprüsü\'nün altından geç',
    hint: 'Rumeli Hisarı\'nın hemen kuzeyinde: kuleler arasından, tabliyenin (ortada ≈ 64 m) altından geç.',
    score: { base: 1000 }, stars: [1000, 1450, 1650],
  },
  {
    id: 'ist-yss', kind: 'bridge', bridge: 'yss', mission: 'ist-uc-kopru', aircraft: ALL, trackable: true,
    title: 'Yavuz Sultan Selim Köprüsü\'nün altından geç',
    hint: 'Boğaz\'ın Karadeniz ağzında: kuleler 1.408 m aralıklı, tabliye ortada ≈ 73 m. Altından geç.',
    score: { base: 1000 }, stars: [1000, 1450, 1650],
  },
  {
    id: 'ist-kiz-kulesi', kind: 'gates', mission: 'ist-kiz-kulesi', aircraft: ['uh60'], trackable: true,
    title: 'Kız Kulesi turu',
    hint: 'Kız Kulesi\'nin çevresinde sağa (saat yönünde) tam tur: kuleden 120–320 m uzakta, 100–500 ft. İlk 45°\'de süre başlar.',
    near: 1500, limit: 600, score: { par: 90, perSec: 5 }, stars: [850, 1000, 1120],
  },
  {
    id: 'ist-kiz-kulesi-jet', kind: 'gates', mission: 'ist-kiz-kulesi-jet', aircraft: FIXED, trackable: true,
    title: 'Kız Kulesi çevresinde tur',
    hint: 'Kız Kulesi\'nin çevresinde sola (saat yönünün tersine) tam tur: 1–2 km yarıçapta, 700–1.450 ft. İlk 45°\'de süre başlar.',
    near: 2500, limit: 600, score: { par: 120, perSec: 5 }, stars: [850, 1000, 1120],
  },
  {
    id: 'ist-bogaz-alcak', kind: 'gates', mission: 'ist-bogaz-alcak', aircraft: ALL, trackable: true,
    title: 'Boğaz\'da alçak geçiş',
    hint: 'Rumeli Hisarı\'ndan Kız Kulesi\'ne 6 alçak kapı (deniz üstü 15–65 m); 1. kapıdan sonra 500 ft altında kal. 1. kapıda süre başlar.',
    near: 1500, limit: 600, score: { par: 110, perSec: 15 }, stars: [1000, 2300, 2800],
  },
  {
    id: 'ist-halic', kind: 'gates', mission: 'ist-halic', aircraft: ALL, trackable: true,
    title: 'Haliç\'te alçak uçuş',
    hint: 'Sarayburnu\'ndan Eyüp\'e Haliç boyunca 6 kapı (deniz üstü 75–125 m), köprülerin üstünden. 1. kapıda süre başlar.',
    near: 1500, limit: 600, score: { par: 100, perSec: 15 }, stars: [1000, 1800, 2200],
  },
  {
    id: 'ist-bogaz-turu', kind: 'gates', mission: 'ist-bogaz-turu', aircraft: ALL, trackable: true,
    title: 'Boğaz turu',
    hint: 'Kız Kulesi → 15 Temmuz → Fatih Sultan Mehmet → Yavuz Sultan Selim halkaları (≈ 2.000 ft). 1. halkada süre başlar.',
    near: 1500, limit: 900, score: { par: 300, perSec: 3 }, stars: [1150, 1700, 2050],
  },
  {
    id: 'ist-yarimada', kind: 'gates', mission: 'ist-yarimada', aircraft: ['uh60'], trackable: true,
    title: 'Tarihi Yarımada halkaları',
    hint: 'Galata Kulesi, Haliç, Süleymaniye, Ayasofya · Sultanahmet, Topkapı Sarayı ve Sarayburnu halkaları. 1. halkada süre başlar.',
    near: 1200, limit: 900, score: { par: 300, perSec: 4 }, stars: [1300, 1750, 2050],
  },
  {
    id: 'ist-tirmanis', kind: 'climb', mission: 'ist-tirmanis', aircraft: FIXED, trackable: false,
    title: 'Dik tırmanış',
    hint: 'Bir pistte dur ve kalkışa başla: süre tekerlekler dönünce başlar, 10.000 ft\'te biter.',
    limit: 300, score: { base: 1000, par: 120, perSec: 25 }, stars: [1000, 2125, 2625],
  },
  {
    id: 'ist-yenikapi-ped', kind: 'alcatraz', mission: 'ist-yarimada', aircraft: ['uh60'], trackable: true,
    title: 'Yenikapı pedi',
    hint: 'Yenikapı sahilindeki helikopter pedinin üstünde 5 sn asılı kal, sonra pedin ortasına yumuşakça in.',
    limit: 240, score: { base: 1000, landing: 8 }, stars: [1000, 1650, 2050],
  },
  {
    id: 'ist-inis', kind: 'landing', mission: 'ist-ltfm-inis', aircraft: ALL, trackable: false,
    title: 'En iyi iniş',
    hint: 'İstanbul Havalimanı, Sabiha Gökçen ya da Atatürk: her pist inişin puanlanır, en iyisi sayılır.',
    score: { landing: 20 }, stars: 'landing',
  },
  {
    id: 'ist-motor', kind: 'emergency', group: 'emergency', mission: 'ist-saw-motor', aircraft: ['a320neo', 'b737'], trackable: false,
    title: 'Motor arızası',
    hint: 'Bir motor şimdi duracak: dümenle düz uç, hızı koru, en yakın piste güvenli in.',
    need: { agl: 400 * FT }, failure: { kind: 'engine', opts: { index: 'random' } },
    objective: { type: 'land', any: true, minStars: 1 }, limit: 900, score: { base: 1000, landing: 12 }, stars: 'landing',
    message: (o) => `${o.index === 1 ? 'Sağ' : 'Sol'} motor arızası! Dümenle düz uç, en yakın piste in.`,
  },
  {
    id: 'ist-alev', kind: 'emergency', group: 'emergency', mission: 'ist-alev', aircraft: ['f16'], trackable: false,
    title: 'Alev sönmesi',
    hint: 'Motor sönecek ve yeniden yanmayacak: 200 kt ile süzül, takım için G sonra ACİL (I), bir piste in.',
    need: { agl: 4000 * FT }, failure: { kind: 'engine', opts: { index: 0, restartable: false } },
    objective: { type: 'land', any: true, minStars: 1 }, limit: 900, score: { base: 1000, landing: 10 }, stars: 'landing',
    message: () => 'Motor söndü: süzül ve en yakın piste in!',
  },
  {
    id: 'ist-denize-inis', kind: 'emergency', group: 'emergency', mission: 'ist-marmara', aircraft: ['a320neo', 'b737'], trackable: false,
    title: 'Suya mecburi iniş',
    hint: 'İki motor birden duracak: takım kapalı, kanatlar düz, burun hafif yukarıda denize kontrollü in.',
    need: { agl: 1000 * FT, water: true, waterText: 'Denizin üstündeyken başlat' }, failure: { kind: 'engineAll', opts: { restartable: false } },
    objective: { type: 'ditch' }, limit: 900, score: { base: 1000, ditch: 10 }, stars: 'ditch',
    message: () => 'Çift motor arızası! Denize kontrollü suya iniş yap.',
  },
  {
    id: 'ist-otorotasyon', kind: 'emergency', group: 'emergency', mission: 'ist-otorotasyon', aircraft: ['uh60'], trackable: false,
    title: 'Otorotasyon',
    hint: 'İki motor birden duracak: kolektifi hemen indir, 60–80 kt süzül, 25 m\'de burnu kaldır ve yumuşat.',
    need: { agl: 500 * FT }, failure: { kind: 'engineAll', opts: {} },
    objective: { type: 'land', any: true, heli: true, minStars: 1, profile: 'autorotation' }, limit: 600,
    score: { base: 1000, landing: 10, runwayBonus: 200 }, stars: 'landing',
    message: () => 'İki motor durdu: kolektifi indir, otorotasyon!',
  },
];
for (const c of CHALLENGES) c.board = `ff-${c.id}`;

export const challengeById = (id) => CHALLENGES.find((c) => c.id === id) || null;
/** The challenges an aircraft can do (the panel lists only these). */
export const challengesFor = (aircraft) => CHALLENGES.filter((c) => c.aircraft.includes(aircraft));

/**
 * The highest score a challenge can give (infra/leaderboard/build_rules.mjs adds a margin): the tracker's scoring with
 * the İstanbul objectives' extras (orbit 800; gates speed windows and corridor).
 */
export function maxChallengeScore(c) {
  const sc = c.score || {};
  if (c.kind === 'bridge') return (sc.base || 0) + 500 + 300;
  if (c.kind === 'gates') {
    const m = buildMission(c.mission), ms = { ...(m.score || {}), ...sc }, o = m.objectives[0];
    if (o.type === 'orbit') return 400 + 200 + 200 + sc.par * sc.perSec;
    let per = (ms.gate ?? 200) + (ms.gateAcc ?? 100);
    if (o.kt != null || o.gates.some((g) => g.kt != null)) per += ms.gateKt ?? 100;
    return o.gates.length * per + (Number.isFinite(o.ceiling) ? ms.low ?? 300 : 0) + sc.par * sc.perSec;
  }
  if (c.kind === 'climb') return (sc.base || 0) + sc.par * sc.perSec;
  if (c.kind === 'alcatraz') return (sc.base || 0) + 300 + 400 + (sc.landing ?? 8) * 100;
  if (c.kind === 'landing') return (sc.landing ?? 20) * 100;
  if (c.objective && c.objective.type === 'ditch') return (sc.base || 0) + (sc.ditch ?? 10) * 100;
  return (sc.base || 0) + (sc.landing ?? 10) * 100 + (sc.runwayBonus || 0);
}
