// Leaderboard nicknames (CONTRACTS-SF.md §12): optional, ≤ 16 characters, Latin letters incl. Turkish (ç ğ ı İ ö ş ü),
// digits, space, _ and -. No URLs, handles, phone-like numbers, reserved or offensive names.
// One module for both sides: the page may pre-check a name for instant feedback (src/net/leaderboard.js re-exports
// cleanName), and the leaderboard Lambda (infra/leaderboard) bundles this same file and is the authority.
// A word filter is never complete: it stops the obvious cases (Turkish and English, spacing, repeated letters, digit
// look-alikes) and deliberately avoids short stems that are parts of real names (e.g. "Işık", "Nazif", "Kemal").

export const NAME_MAX = 16;

// Latin-1 / Latin Extended-A/B letters (without × and ÷), ASCII letters and digits, space, _ and -
const ALLOWED = /^[A-Za-z0-9 _\-\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+$/;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };

// matched anywhere in the name with separators removed and repeated letters collapsed ("o r o s p u", "orrrospu")
const ANYWHERE = [
  'orospu', 'orosbu', 'oruspu', 'orusbu', 'pezevenk', 'kahpe', 'amcik', 'amcuk', 'aminako', 'aminak', 'aminagor',
  'yavsak', 'dalyarak', 'gotveren', 'kodumun', 'fahise', 'surtuk', 'serefsiz', 'kaltak', 'kancik', 'ibne', 'gavat',
  'fuck', 'shit', 'bitch', 'cunt', 'whore', 'slut', 'fagot', 'ashole', 'niger', 'pusy', 'porn', 'penis', 'vagina',
  'hitler', 'retard', 'motherf',
];
// matched as a whole word, or as the whole name without separators ("a m k")
const WORDS = new Set([
  'am', 'amk', 'amq', 'aq', 'mk', 'sik', 'got', 'oc', 'pic', 'pust', 'yarak', 'yarag', 'fag', 'fuk', 'dick', 'cock',
  'anal', 'rape', 'sex', 'nazi', 'niga',
]);
// matched at the start of a word ("siktirgit", "sexy")
const PREFIXES = ['siktir', 'siker', 'sikey', 'sikiy', 'sikim', 'sikis', 'sikik', 'siktim', 'sikici', 'yarak', 'yarag', 'sexy', 'fuck', 'amina'];
// impersonation of the game / its staff: prefixes of any word, and whole words
const RESERVED_PREFIXES = ['admin', 'moderat', 'yonetici', 'gokyuzu', 'erenailab'];
const RESERVED_WORDS = new Set(['mod', 'yonetim', 'official', 'resmi', 'destek', 'support', 'staff', 'sistem', 'system']);
// links and promotion: a word that is a web/social marker, or a top-level domain after another word ("site com")
const LINK_WORDS = new Set(['www', 'http', 'https', 'discord', 'instagram', 'insta', 'tiktok', 'youtube', 'telegram', 'twitch', 'whatsapp', 'onlyfans', 'twitter']);
const TLDS = new Set(['com', 'net', 'org', 'io', 'gg', 'xyz', 'tr', 'co', 'me', 'tv', 'app', 'dev', 'info', 'biz', 'ru', 'de', 'uk', 'ly', 'link', 'site', 'online']);

/** Lower-case skeleton for matching: Turkish-aware case folding, accents removed, digit look-alikes mapped. */
function skeleton(s) {
  return s.replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase().replace(/ı/g, 'i')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[0134578]/g, (d) => LEET[d]);
}
const collapse = (s) => s.replace(/(.)\1+/g, '$1');

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
  if (RESERVED_PREFIXES.some((r) => joined.startsWith(r) || cwords.some((w) => w.startsWith(r)))
    || words.some((w) => RESERVED_WORDS.has(w))) return { ok: false, name: null, reason: 'reserved' };
  if (LINK_WORDS.has(joined) || [...LINK_WORDS].some((l) => l.length >= 5 && joined.includes(l))) return { ok: false, name: null, reason: 'link' };
  const bad = ANYWHERE.some((b) => joined.includes(b))
    || WORDS.has(joined) || words.some((w) => WORDS.has(w) || WORDS.has(collapse(w)))
    || cwords.some((w) => PREFIXES.some((p) => w.startsWith(collapse(p))));
  if (bad) return { ok: false, name: null, reason: 'bad' };
  return { ok: true, name };
}
