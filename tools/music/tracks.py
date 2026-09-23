"""The soundtrack: one entry per track (id, player-facing Turkish title, playlists, Eleven Music prompt, length).

The prompts follow the Eleven Music terms (https://elevenlabs.io/music-terms, section 2(b)): no artist, songwriter,
song, album, publisher or label names and no lyrics. Every track is instrumental (force_instrumental).
The runtime list in src/music/tracks.js must name the same ids.
"""

MODEL = 'music_v2_5'

TRACKS = [
    {
        'id': 'korfezde_sabah',
        'title': 'Körfezde Sabah',
        'lists': ['menu'],
        'ms': 140000,
        'prompt': (
            'Main menu theme for a calm, cinematic flight simulator set over a foggy coastal bay city at dawn. '
            'Opens with just a warm felt piano motif and airy synth pads, then a soft string ensemble and gentle '
            'French horn swells join, light brushed percussion enters in the middle for a hopeful lift. '
            'Wonder, open sky, quiet anticipation. 84 BPM, D major. Modern orchestral-ambient film score, wide stereo, '
            'clean and warm mix, no vocals. Ends softly on a sustained final chord that fades out.'),
    },
    {
        'id': 'sisin_ustunde',
        'title': 'Sisin Üstünde',
        'lists': ['menu', 'flight'],
        'ms': 135000,
        'prompt': (
            'Serene ambient score for gliding above a sea of fog at sunrise, one continuous slowly evolving piece '
            'without breaks. Shimmering glassy synth pads, slow legato strings, sparse solo piano notes with long reverb '
            'tails, a soft cello line, no drums. 68 BPM, A major. Weightless, calm, spacious, gently uplifting. Cinematic '
            'ambient production, lush plate reverb, wide stereo, instrumental only. Fades out slowly at the very end.'),
    },
    {
        'id': 'seyir_irtifasi',
        'title': 'Seyir İrtifası',
        'lists': ['flight'],
        'ms': 135000,
        'prompt': (
            'Laid-back cinematic downtempo for cruising high above the clouds. Warm electric piano chords, round '
            'sub bass, soft sidechained pads, a steady gentle beat with brushed hi-hats and a soft kick, plucked '
            'synth arpeggios. 92 BPM, F major. Relaxed, optimistic, smooth travel mood. Polished modern chillout '
            'production, warm analog glue, instrumental only. Starts with just pads and electric piano, the beat '
            'comes in after eight bars, ends with a smooth fade-out.'),
    },
    {
        'id': 'pasifik_kiyisi',
        'title': 'Pasifik Kıyısı',
        'lists': ['flight'],
        'ms': 130000,
        'prompt': (
            'Sunny coastal acoustic instrumental for a scenic flight along ocean cliffs. Fingerpicked steel-string '
            'acoustic guitar, warm upright bass, light shaker and soft kick drum, gentle lap steel slides, subtle '
            'string pads. 100 BPM, G major. Breezy, open, sea wind, carefree but calm. Warm natural production, '
            'close-miked guitar, instrumental only. Ends gently with a last strummed chord ringing out.'),
    },
    {
        'id': 'gun_batimi',
        'title': 'Gün Batımı',
        'lists': ['menu', 'flight'],
        'ms': 140000,
        'prompt': (
            'Golden-hour cinematic piece for flying into the sunset over a bay. Slow felt piano melody, lush legato '
            'strings, warm analog synth pads, a tender cello countermelody, broad swells; a soft pulsing rhythm '
            'enters only in the middle section, then falls away. 72 BPM, E-flat major. Nostalgic, bittersweet, '
            'beautiful, wide open sky. Emotional modern film score production, wide stereo, instrumental only. '
            'Ends quietly with solo piano and a long fade.'),
    },
    {
        'id': 'gece_isiklari',
        'title': 'Gece Işıkları',
        'lists': ['flight'],
        'ms': 135000,
        'prompt': (
            'Nocturnal synthwave ambient for flying over a glittering city at night. Slow pulsing analog '
            'arpeggio, deep warm bass, dreamy reverb-soaked pads, a soft gated snare far in the background, '
            'twinkling bell tones. 84 BPM, F minor. Calm, mysterious, neon reflections on dark water, late-night '
            'solitude. Retro 1980s analog synth production with modern clarity, instrumental only. '
            'Fades out at the end.'),
    },
    {
        'id': 'art_yakici',
        'title': 'Art Yakıcı',
        'lists': ['flight'],          # first track of the fighters' playlist (src/music/tracks.js FIRST)
        'ms': 130000,
        'prompt': (
            'Energetic cinematic hybrid action score for high-speed jet fighter flight. Driving pulsing synth bass '
            'ostinato, punchy electronic drums with big taiko hits, soaring heroic brass, staccato strings, rising '
            'risers into a powerful main section with a clear melodic hook. 128 BPM, E minor. Exciting, determined, '
            'adventurous and bright, not dark or aggressive. Modern epic production, tight low end, instrumental '
            'only. Short calm intro, big middle, ends with a final strong hit that rings out.'),
    },
]
