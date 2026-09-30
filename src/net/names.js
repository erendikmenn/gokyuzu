// Leaderboard nicknames (CONTRACTS-SF.md §12): optional, ≤ 16 characters, Latin letters incl. Turkish (ç ğ ı İ ö ş ü),
// digits, space, _ and -. No URLs, handles, phone-like numbers, reserved or offensive names.
// One module for both sides: the page may pre-check a name for instant feedback (src/net/leaderboard.js re-exports
// cleanName), and the leaderboard Lambda (infra/leaderboard) bundles this same file and is the authority.
// A word filter is never complete: it stops the obvious cases (Turkish and English, spacing, repeated letters, digit
// look-alikes, Latin look-alike letters such as ø ł ƒ ǀ) and deliberately avoids short stems that are parts of real names
// (e.g. "Işık", "Nazif", "Kemal", "Sıkı", "Amasya", "Nigar", "Zuniga"). Invisible characters (bidi controls, zero-width
// marks: Unicode Cf) are removed before any check; combining marks, other scripts (Cyrillic / Greek homoglyphs), emoji
// and fillers are outside the allowed letters. The leaderboard Lambda also re-checks stored names when it reads a board,
// so a word added here hides an existing entry's name at once.

export const NAME_MAX = 16;

// Latin-1 / Latin Extended-A/B letters (without × and ÷), ASCII letters and digits, space, _ and -
const ALLOWED = /^[A-Za-z0-9 _\-\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+$/;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };
// allowed letters that Unicode decomposition leaves alone but that read as a plain Latin letter (lower case)
const FOLD = {
  'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'ħ': 'h', 'ŧ': 't', 'ƒ': 'f', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'þ': 'p', 'ŋ': 'n',
  'ĸ': 'k', 'ǀ': 'l', 'ǁ': 'll', 'ǃ': 'i', 'ƀ': 'b', 'ƃ': 'b', 'ƅ': 'b', 'ɓ': 'b', 'ƈ': 'c', 'ȼ': 'c', 'ƌ': 'd', 'ɖ': 'd',
  'ɗ': 'd', 'ȡ': 'd', 'ǝ': 'e', 'ɇ': 'e', 'ɛ': 'e', 'ǥ': 'g', 'ɠ': 'g', 'ɨ': 'i', 'ɩ': 'i', 'ȷ': 'j', 'ɉ': 'j', 'ƙ': 'k',
  'ƚ': 'l', 'ȴ': 'l', 'ɯ': 'm', 'ƞ': 'n', 'ȵ': 'n', 'ɲ': 'n', 'ɔ': 'o', 'ɵ': 'o', 'ƥ': 'p', 'ƿ': 'p', 'ɋ': 'q', 'ɍ': 'r',
  'ʀ': 'r', 'ȿ': 's', 'ƨ': 's', 'ƽ': 's', 'ʃ': 's', 'ƫ': 't', 'ƭ': 't', 'ȶ': 't', 'ʈ': 't', 'ⱦ': 't', 'ʉ': 'u', 'ʊ': 'u',
  'ʋ': 'v', 'ʌ': 'v', 'ƴ': 'y', 'ɏ': 'y', 'ɣ': 'y', 'ƶ': 'z', 'ȥ': 'z', 'ɀ': 'z', 'ʒ': 'z', 'ȝ': 'z', 'ⱥ': 'a',
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'g');

// matched anywhere in the name with separators removed and repeated letters collapsed ("o r o s p u", "orrrospu")
const ANYWHERE = [
  'orospu', 'orosbu', 'oruspu', 'orusbu', 'pezevenk', 'kahpe', 'amcik', 'amcuk', 'aminako', 'aminak', 'aminagor',
  'yavsak', 'dalyarak', 'gotveren', 'kodumun', 'fahise', 'surtuk', 'serefsiz', 'kaltak', 'kancik', 'ibne', 'gavat',
  'orspu', 'amcig', 'ananisik', 'anasinisik', 'bacinisik', 'sikeyim', 'sikerim', 'sikiyim', 'siktig',
  'fuck', 'fvck', 'phuck', 'shit', 'bitch', 'cunt', 'whore', 'slut', 'fagot', 'ashole', 'niger', 'pusy', 'porn', 'penis',
  'vagina', 'dickhead', 'cocksuck', 'blowjob', 'jerkof', 'cumshot', 'dildo', 'wanker', 'bastard', 'trany', 'wetback',
  'raghead', 'towelhead', 'hitler', 'siegheil', 'retard', 'motherf',
];
// matched as a whole word, or as the whole name without separators ("a m k")
const WORDS = new Set([
  'am', 'amk', 'amq', 'aq', 'mk', 'sik', 'got', 'oc', 'pic', 'pust', 'yarak', 'yarag', 'fag', 'fuk', 'fck', 'dick', 'cock',
  'twat', 'tits', 'anal', 'rape', 'rapist', 'pedo', 'sex', 'seks', 'xxx', 'nazi', 'heil', 'kkk', 'niga', 'nigas', 'nigaz',
  'kike', 'chink', 'spic', 'gook', 'coon', 'dyke',
]);
// matched at the start of a word ("siktirgit", "sexy")
const PREFIXES = ['siktir', 'siker', 'sikey', 'sikiy', 'sikim', 'sikis', 'sikik', 'siktim', 'sikici', 'yarak', 'yarag', 'sexy', 'fuck', 'amina',
  'gotun', 'gotlek', 'gotos', 'tasak', 'pedofil', 'pedophil'];
// hate-symbol numbers, matched in the name's digits ("14 88", "Pilot1488")
const HATE_NUMBERS = ['1488'];
// impersonation of the game / its staff: prefixes of any word, and whole words
const RESERVED_PREFIXES = ['admin', 'moderat', 'yonetici', 'gokyuzu', 'erenailab'];
const RESERVED_WORDS = new Set(['mod', 'yonetim', 'official', 'resmi', 'destek', 'support', 'staff', 'sistem', 'system']);
// links and promotion: a word that is a web/social marker, or a generic top-level domain after another word ("site com";
// "." and "/" are not allowed at all, so "site.com" never gets this far). Two-letter country domains and word-like ones
// (tr, de, gg, me, co, io, dev, app, online …) are ordinary words or tags in a nickname ("Ahmet TR", "Ben de", "Pilot GG")
const LINK_WORDS = new Set(['www', 'http', 'https', 'discord', 'instagram', 'insta', 'tiktok', 'youtube', 'telegram', 'twitch', 'whatsapp', 'onlyfans', 'twitter']);
const TLDS = new Set(['com', 'net', 'org', 'xyz', 'info', 'biz']);

/** Lower-case skeleton for matching: Turkish-aware case folding, accents removed, look-alike letters and digits mapped. */
function skeleton(s) {
  return s.replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase().replace(/ı/g, 'i')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(FOLD_RE, (c) => FOLD[c])
    .replace(/[0134578]/g, (d) => LEET[d]);
}
const collapse = (s) => s.replace(/(.)\1+/g, '$1');
// reserved names also against the l / I confusion ("Admln" reads as "Admin" in many fonts)
const lToI = (s) => s.replace(/l/g, 'i');
const RESERVED_PREFIXES_I = RESERVED_PREFIXES.map(lToI);
const RESERVED_WORDS_I = new Set([...RESERVED_WORDS].map(lToI));

/**
 * Normalize and check a nickname.
 * → { ok: true, name: string | null }   (null = no name given: the entry is anonymous)
 * → { ok: false, name: null, reason: 'long' | 'chars' | 'digits' | 'link' | 'reserved' | 'bad' }
 */
export function cleanName(raw) {
  if (raw === undefined || raw === null) return { ok: true, name: null };
  if (typeof raw !== 'string') return { ok: false, name: null, reason: 'chars' };
  const name = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim()
    .replace(/[_-]{2,}/g, (m) => m[0]);
  if (!name) return { ok: true, name: null };
  if ([...name].length > NAME_MAX) return { ok: false, name: null, reason: 'long' };
  if (!ALLOWED.test(name) || !/[\p{L}\p{Nd}]/u.test(name)) return { ok: false, name: null, reason: 'chars' };
  if ((name.match(/\d/g) || []).length >= 7) return { ok: false, name: null, reason: 'digits' };   // phone / ID numbers

  const plainWords = name.toLowerCase().split(/[ _-]+/).filter(Boolean);
  if (plainWords.some((w) => LINK_WORDS.has(w)) || plainWords.slice(1).some((w) => TLDS.has(w))) {
    return { ok: false, name: null, reason: 'link' };
  }
  const words = skeleton(name).split(/[ _-]+/).filter(Boolean);
  const joined = collapse(words.join(''));
  const cwords = words.map(collapse);
  const joinedI = lToI(joined), cwordsI = cwords.map(lToI);
  if (RESERVED_PREFIXES_I.some((r) => joinedI.startsWith(r) || cwordsI.some((w) => w.startsWith(r)))
    || words.some((w) => RESERVED_WORDS_I.has(lToI(w)))) return { ok: false, name: null, reason: 'reserved' };
  if (LINK_WORDS.has(joined) || [...LINK_WORDS].some((l) => l.length >= 5 && joined.includes(l))) return { ok: false, name: null, reason: 'link' };
  const bad = ANYWHERE.some((b) => joined.includes(b))
    || WORDS.has(joined) || words.some((w) => WORDS.has(w) || WORDS.has(collapse(w)))
    || cwords.some((w) => PREFIXES.some((p) => w.startsWith(collapse(p))))
    || HATE_NUMBERS.some((h) => name.replace(/\D/g, '').includes(h));
  if (bad) return { ok: false, name: null, reason: 'bad' };
  return { ok: true, name };
}
