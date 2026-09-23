// The soundtrack (generated with ElevenLabs Eleven Music by tools/music/build.py, prompts in tools/music/tracks.py;
// licence notes in assets/music/CREDITS.txt). Files: assets/music/<id>.m4a (AAC-LC ~128 kbit/s, -18 LUFS each).
// lists: 'menu' = main menu (and the loading screen after it), 'flight' = in flight. `first` = the track a playlist
// opens with; later tracks are shuffled.
export const TRACKS = [
  { id: 'korfezde_sabah', title: 'Körfezde Sabah', lists: ['menu'] },
  { id: 'sisin_ustunde', title: 'Sisin Üstünde', lists: ['menu', 'flight'] },
  { id: 'seyir_irtifasi', title: 'Seyir İrtifası', lists: ['flight'] },
  { id: 'pasifik_kiyisi', title: 'Pasifik Kıyısı', lists: ['flight'] },
  { id: 'gun_batimi', title: 'Gün Batımı', lists: ['menu', 'flight'] },
  { id: 'gece_isiklari', title: 'Gece Işıkları', lists: ['flight'] },
  { id: 'art_yakici', title: 'Art Yakıcı', lists: ['flight'], energetic: true },
];

/** Which track a playlist starts with: the menu theme in the menu, the energetic track for fighters, else a calm one. */
export const FIRST = { menu: 'korfezde_sabah', fighter: 'art_yakici' };
