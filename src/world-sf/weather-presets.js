// Time & weather: weather presets and the start conditions chosen in the main menu. Dependency-free (no three.js),
// so the menu can import it; src/world-sf/weather.js applies the presets to the world.

/**
 * Presets (Turkish ids are the public names; ASCII/English aliases are accepted by resolveWeather).
 * Visual fields (environment.js): haze = marine haze multiplier, high = high cloud amount (0 none, 1 default patches),
 * deck = low cloud layer { base, thick (m MSL / m), cover 0..1, type 0 cumulus | 1 stratus | 2 nimbostratus, dark },
 * fog = widespread marine fog { cover, top (mean top height, m), k (1/m extinction inside) }, bank = the Golden Gate
 * fog tongue, wet = wet surfaces 0..1, rain = rain rate 0..1.
 * Physics-facing fields: visibility (m, prevailing at the surface), wind { direction (deg true, from), speed, gust (m/s) },
 * temperature (°C at MSL), qnh (hPa).
 */
export const WEATHER_PRESETS = {
  'açık': {
    id: 'açık', label: 'Açık', icon: '☀',
    haze: 1.0, high: 0.8, deck: null, fog: null, bank: true, dark: 0, wet: 0, rain: 0,
    visibility: 60000, wind: { direction: 280, speed: 6, gust: 0 }, temperature: 19, qnh: 1015,
  },
  'parçalı bulutlu': {
    id: 'parçalı bulutlu', label: 'Parçalı bulutlu', icon: '⛅',
    haze: 1.3, high: 1.3, deck: { base: 1250, thick: 650, cover: 0.42, type: 0, dark: 0 }, fog: null, bank: true, dark: 0, wet: 0, rain: 0,
    visibility: 40000, wind: { direction: 270, speed: 7, gust: 0 }, temperature: 18, qnh: 1013,
  },
  'kapalı': {
    id: 'kapalı', label: 'Kapalı', icon: '☁',
    haze: 9, high: 0, deck: { base: 700, thick: 650, cover: 1, type: 1, dark: 0.15 }, fog: null, bank: false, dark: 0.25, wet: 0.15, rain: 0,
    visibility: 15000, wind: { direction: 200, speed: 6, gust: 0 }, temperature: 15, qnh: 1009,
  },
  'sis': {
    id: 'sis', label: 'Sis', icon: '🌫',
    haze: 2.2, high: 0.25, deck: null, fog: { cover: 1, top: 215, k: 0.0039 }, bank: true, dark: 0.3, wet: 0.35, rain: 0,
    visibility: 1000, wind: { direction: 250, speed: 3, gust: 0 }, temperature: 14, qnh: 1016,
  },
  'yağmur': {
    id: 'yağmur', label: 'Yağmur', icon: '🌧',
    haze: 28, high: 0, deck: { base: 480, thick: 1600, cover: 1, type: 2, dark: 0.5 }, fog: null, bank: false, dark: 0.7, wet: 1, rain: 1,
    visibility: 5000, wind: { direction: 170, speed: 9, gust: 14 }, temperature: 13, qnh: 1004,
  },
};
export const WEATHER_ORDER = ['açık', 'parçalı bulutlu', 'kapalı', 'sis', 'yağmur'];
export const DEFAULT_WEATHER = 'açık';

const ALIASES = {
  acik: 'açık', clear: 'açık', 'açik': 'açık',
  parcali: 'parçalı bulutlu', 'parçalı': 'parçalı bulutlu', 'parcali bulutlu': 'parçalı bulutlu', partly: 'parçalı bulutlu', 'partly cloudy': 'parçalı bulutlu', cloudy: 'parçalı bulutlu',
  kapali: 'kapalı', overcast: 'kapalı',
  fog: 'sis',
  yagmur: 'yağmur', rain: 'yağmur',
};
/** Preset name (Turkish, ASCII or English, case-insensitive) → preset id, or null. */
export function resolveWeather(name) {
  if (!name) return null;
  const s = String(name).trim().toLocaleLowerCase('tr').replace(/[_+-]/g, ' ');
  if (WEATHER_PRESETS[s]) return s;
  return ALIASES[s] || null;
}


// ---------------------------------------------------------------------------------------------- start conditions
/**
 * Time/weather chosen before the world exists (main menu). createSFWorld (src/world-sf/index.js) reads it when its own
 * options do not carry them; `?time=` / `?weather=` URL parameters are the fallback.
 * { time: hours | 'HH:MM' | null, weather: preset id | null }
 */
export const START_CONDITIONS = { time: null, weather: null };
export function setStartConditions({ time, weather } = {}) {
  if (time !== undefined) START_CONDITIONS.time = time;
  if (weather !== undefined) START_CONDITIONS.weather = weather;
}
