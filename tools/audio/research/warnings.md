# Cockpit warning sounds — real-recording research (wave 6)

> Wave 7 implemented the alerts per real system: decisions in `alerts.md`, logic research in `alerts_logic.md`.
> Corrections to this file: the F-16 LG warning horn is pulsed at 5 ± 1 Hz (DTIC AD-A145469), not 0.5 s on/off; the
> A320 has no EGPWS BANK ANGLE callout; the F-16 low-speed schedule is airspeed < 2.22 × pitch for pitch 45–90°.

Research only. No game sound, `assets/audio/manifest.json` or `src/audio/**` was changed. Everything below is
reproducible with the scripts in this directory; the candidate files live in the gitignored
`assets/audio/candidates/<aircraft>/<sound>/` tree (unmodified originals in `orig/`, 48 kHz listening previews next to
them) and are listed in `assets/audio/candidates/review.json`, which the listening page `dev/sesler.html` reads.

## Summary

| Aircraft | Alerts reviewed | Real recording with a redistributable licence | Only community / unknown-provenance files | Nothing usable |
|---|---|---|---|---|
| A320neo | 22 | 3 — radio-altitude callouts, RETARD, A/P-disconnect cavalry charge (A319 cockpit videos on Commons, CC BY-SA 3.0 / CC BY 3.0) | 17 (FlightGear A320-family / fgdata) | 2 (windshear, SPEED SPEED SPEED) |
| 737-800 | 20 | 2 — EGPWS callouts (P-8A on DVIDS, public domain; Transaero 737NG, CC BY 3.0), intermittent configuration horn (P-8A) | 15 (FlightGear 737-800YV / fgdata) | 3 (gear horn, windshear, A/P wailer) |
| F-16C | 10 | 0 usable (one unidentified real 241 Hz square-wave tone from a USAF Auto-GCAS HUD tape, PD, reference only) | 8 (NikolaiVChr/f16 — probably TTS / document-based synthesis) | 1 (over-G: does not exist in the real jet) |
| F-22A | 8 | 0 | 5 (FlightGear community F-22s, unknown provenance, 8-bit/11–24 kHz) | 3 |
| UH-60M | 6 | 0 | 1 (generic 650 Hz tone from the FlightGear Bo105) | 5 |

Key findings
1. **Real, licensed recordings exist only for the airliner callouts** (and the A320 A/P disconnect, a 737 horn). They are
   cockpit-camera recordings: intelligible but 3–16 dB above engine/wind noise and lossy-encoded — good as a reference
   or, after denoising, as game sounds; not studio-clean.
2. **The shipped A320 "cavalry charge" is not a recording**: A320-family PR #364 (2025) re-synthesised it from a
   waveform diagram (1660/830 Hz square waves alternating every 40 ms, 200 ms on/off). The real A319 recording found on
   Commons has exactly that waveform, so the sound is right — but `assets/audio/CREDITS.txt` and the comment in
   `src/audio/profiles/common.js` call it a "recording" (AU agent should reword). The 737 wailer (`Apdisco.wav`) entered
   737-800YV as "Added 2 new sounds from 733" with no statement of origin.
3. **Almost every FlightGear alert file has no stated provenance.** The A320-family and 737-800YV GPWS voices are the
   same files (identical SHA-256), added in 2016 without a source. fgdata's TCAS voices are TTS ("Artificial female
   voice"); fgdata's RETARD/100-above are text2speech.org TTS; the F-16 "Betty" set is described by a contributor as
   synthesised; the F-16 tones are synthesised from the -1 manual. GPL makes them legally usable, but none is a proven
   real recording, and none is clearly better than the current ElevenLabs/synth sounds.
4. **Biggest realism gains are content, not recordings** (all sourced):
   * F-16: the VMS has no "LANDING GEAR", "LOW SPEED" or "OVER G" messages. Gear warning = LG warning horn (tone),
     stall/low speed = low-speed warning tone (≈250 Hz square), "WARNING WARNING" belongs to the red warning lights
     (1.5 s delay), "CAUTION CAUTION" to caution lights (7 s delay). VMS is inhibited with weight on wheels.
   * F-22: uses the F-16 message list verbatim; no public source confirms the F-22 ICAWS vocabulary.
   * UH-60: low rotor RPM is "a low steady tone" (UH-60A TM), not a 4 Hz warble, inhibited on the ground; ENG OUT has its
     own steady tone; the radar-altimeter low-altitude warning is visual only on the UH-60A — "ALTITUDE", "PULL UP",
     "BANK ANGLE" voices are unverified for the UH-60M.
   * 737-800: there is no master-caution chime (the game's `chime` has no real counterpart); the landing-gear warning
     is a steady horn before any "TOO LOW, GEAR"; takeoff-config/cabin-altitude = intermittent horn.
   * A320/737: `single_chime`, `c_chord`, `v_terrain`, `v_toolow_terrain`, `v_dontsink`, `v_glideslope`, `v_windshear`,
     `cricket` are generated but never triggered.
5. **Excluded but notable**: FlyByWire's A32NX sound project (`flybywiresim/a32nx-wwise`, ~1900 WAVs incl. CRC, chimes,
   callouts, TCAS) and the X-Plane A321neo sound pack are **CC BY-NC-SA 4.0** — the game is non-commercial, but NC is
   outside the owner's allowed list and their provenance is mixed ("CRC & Master Caution audio — Recorded by JayZee",
   aircraft not stated; rest "royalty free" or made by the team).


## 1. Method and licence rules

* Usable = redistributable in a free, public, non-commercial web game: GPL-2.0/3.0, CC0, CC-BY, CC-BY-SA, US-government
  public domain (work of a federal employee in the course of duty; DVIDS items marked "Courtesy" are not automatically
  PD). Commercial-simulator rips (MSFS, X-Plane payware, DCS, Falcon BMS, PMDG…) and YouTube rips are listed only as
  references.
* "Provenance" records what the source itself states (real cockpit recording / community-made / not stated). A GPL
  label on a FlightGear repository only says the contributor offered the file under GPL; where the repository never
  says how a sound was produced, the file is marked **unknown** — legally usable under the licence, but not proven
  to be a real recording and carrying the (small) risk that the contributor copied it from somewhere else.
* Nobody could listen during the research: files were characterised with ffprobe, a spectral/onset analysis
  (`analyze.py`) and whisper.cpp (small model) transcripts. Transcripts that look wrong ("Stool. Stool.") are flagged
  because they usually mean poor intelligibility.
* Tools: GitHub API (`gh`), GitLab API (fgdata), Wikimedia Commons API, Internet Archive advancedsearch, DVIDS through
  headless Playwright (curl is blocked by an AWS WAF challenge), ffmpeg, whisper.cpp. WebSearch was broken and
  DuckDuckGo HTML returned bot pages. Two research sub-agents mined DVIDS/Commons/NASA/open projects (military jets +
  helicopter; airliners); their raw findings are in `found_mil.json` and `found_air.json`.

## 2. What the game has today (inventory)

Alert logic: `src/audio/profiles/common.js` (`airlinerAlerts`, `bettyAlerts`, `heloAlerts`) driven by the flight
models' `warnings` (`src/flight/fixedwing.js` `_updateWarnings`, `src/flight/helicopter.js` `_updateWarnings`).
Voices = ElevenLabs TTS (`tools/audio/gen_voices.py`), tones = numpy synthesis, A/P disconnect = FlightGear files.

### A320neo
| Sound (file) | When it plays in the game |
|---|---|
| `v_pullup` | `warnings.pullUp` (terrain/obstacle look-ahead 14 s, or extreme sink near the ground), repeat 0.3 s, priority 10 |
| `v_sinkrate` | `warnings.sinkRate` (sink > 5 m/s + 0.035·AGL below 750 m) and no pull-up, repeat 0.9 s |
| `v_toolow_gear` | `warnings.gear` (gear not down with landing flaps, or low/idle/slow below 230 m), repeat 1.4 s |
| `v_toolow_flaps` | gear down, descending, < 95 m/s, 8–75 m AGL, flaps not in landing position, repeat 1.4 s |
| `v_bankangle` | bank > 35°, repeat 1.2 s |
| `v_stall` (synth cricket 0.6 s + "Stall, stall") | `warnings.stall` (FBW: only when actually stalled), repeat 0.15 s, priority 11 |
| `crc` (loop, −4 dB) | `warnings.overspeed` (VMO/MMO, VFE, VLE) |
| radio-altitude callouts `v_2500 v_1000 v_500 v_400`, `v_hundredabove` @300 ft, `v_minimums` @200 ft, `v_100 v_50 v_40 v_30 v_20 v_10 v_5` | descending through each height (re-armed above it) |
| `v_retard` | replaces the 20 ft call (10 ft with A/P on) and repeats every 2.2 s while thrust > idle near the ground |
| `cavalry` + `ap_button` / `cavalry_loop` | A/P disconnect: intentional = once + pushbutton click; involuntary = loop until acknowledged (KeyO) |
| `single_chime`, `c_chord` | loaded but **never triggered** in flight (single_chime only via `play('chime')`, used by `dev/audio.html`) |
| `v_terrain`, `v_toolow_terrain`, `v_dontsink`, `v_glideslope`, `v_windshear`, `v_200`, `v_300`, `cricket` | generated but **not used** by any rule |

### 737-800
Same GPWS rules/timings as the A320 (pull-up repeat 0.2 s; `v_pullup` = two synthetic "whoops" + "Pull up"), plus:
`shaker` loop on `warnings.stall` (conventional law: stick-shaker AOA before the stall), `clacker` loop on
`warnings.overspeed`, callouts 2500 ("twenty five hundred"), 1000, 500, "approaching minimums" @300 ft, "minimums"
@200 ft, 100, 50, 40, 30, 20, 10; `wailer` on A/P disconnect (≈3 s intentional, up to 8 s involuntary). `chime`
(ding-dong) and `c_chord` are loaded but never triggered; `v_terrain`, `v_toolow_terrain`, `v_dontsink`,
`v_glideslope`, `v_windshear` unused. No fire bell, no configuration horns.

### F-16C and F-22A (identical rule set, `bettyAlerts`)
| Voice | Trigger |
|---|---|
| `v_pullup` | `warnings.pullUp` (8 s look-ahead), repeat 0.25 s |
| `v_altitude` | sink-rate warning (fighters: only with the gear handle down) below 400 ft AGL, repeat 0.9 s |
| stall: F-16 `v_warning`, F-22 `v_lowspeed` | `warnings.stall`, repeat 1.2 s |
| `v_overg` | g > 9.3, repeat 1.5 s |
| `v_gear` ("Landing gear") | `warnings.gear` (gear up, < 230 m, idle, descending, < 110 m/s), repeat 3 s |
| `v_caution` | `warnings.overspeed`, repeat 4 s; also the `chime` |
| `v_bingo` | fuel < 12 % of the initial load, once |

Same text for both jets (ElevenLabs "Sarah"; F-22 slightly cleaner processing). F-16 `v_lowspeed` and F-22 `v_warning`
exist but are unused.

### UH-60M
| Sound | Trigger |
|---|---|
| `low_rotor` (700/850 Hz warble at 4 Hz, loop −6 dB) + `v_lowrotor` ("Low rotor R.P.M.", every 3 s) | airborne (or collective > 0.2) and NR < 95 % (hysteresis 96 %) |
| `v_altitude` | `warnings.sinkRate` (< 30 m & < −4 m/s & slow, or < 300 m & < −12 m/s), repeat 1 s |
| `v_pullup` | terrain/obstacle look-ahead 2–9 s, repeat 0.4 s |
| `v_bankangle` | bank > 60°, repeat 1.5 s |

## 3. The real aircraft — aural alerts and voice messages

Sources actually fetched and read are marked ✔; the rest are cited from general knowledge (FCOMs are not public).

### A320neo (FWC sounds + EGPWS + TCAS)
* **CRC** (continuous repetitive chime) — red/level-3 warnings (engine fire, overspeed, L/G not down, takeoff config,
  excess cabin altitude…); until MASTER WARN is pressed or the condition clears. ✔ NTSB AAR-10/03 CVR transcript
  labels "FWC [sound of continuous repetitive chime]" (via sub-agent).
* **Single chime** — amber/level-2 cautions. ✔ same transcript "FWC [sound of single chime]".
* **C-chord** — altitude alert (approaching FCU altitude ≈750 ft; deviation ≈250 ft).
* **Cricket + "STALL, STALL"** — stall warning (alternate/direct law).
* **Cavalry charge** — A/P disconnect: once (≈1.5 s, three 200 ms bursts of 1660/830 Hz square waves alternating
  every 40 ms, 200 ms gaps) for an intentional disconnect, continuous if involuntary. ✔ A320-family PR #364 diagram,
  ✔ confirmed by band analysis of the Adria A319 cockpit video.
* **Triple click** — approach-capability downgrade; **buzzer** — SATCOM/ATC/cabin calls.
* **Auto callouts** (FWC, male voice; British RP accent on recent builds ✔ Wikipedia "Voice warning system"):
  "TWO THOUSAND FIVE HUNDRED"/"TWENTY FIVE HUNDRED", 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10, 5,
  "HUNDRED ABOVE", "MINIMUM"; **RETARD** at 20 ft (10 ft autoland), repeated until idle. ✔ measured in the F-GRXM video:
  50/40/30/20 ≈1.0–1.3 s apart, RETARD ×4 at ≈1.2–1.3 s intervals. ✔ NTSB AAR-10/03: "FWC retard."
* **EGPWS**: SINK RATE, PULL UP, TERRAIN TERRAIN, TERRAIN AHEAD (PULL UP), CAUTION TERRAIN, TOO LOW TERRAIN,
  TOO LOW GEAR, TOO LOW FLAPS, DON'T SINK, GLIDE SLOPE, BANK ANGLE (option). ✔ NTSB AAR-10/03 lists "too low, terrain;
  too low, gear; terrain, terrain, pull up; caution terrain".
* **Windshear**: "WINDSHEAR ×3" (reactive), "WINDSHEAR AHEAD", "GO AROUND, WINDSHEAR AHEAD", "MONITOR RADAR DISPLAY".
* **SPEED SPEED SPEED** — low-energy warning, repeated every 5 s (normal law, CONF 2/3/FULL). ✔ NTSB AAR-10/03 quoting
  the FCOM.
* **PRIORITY LEFT / PRIORITY RIGHT**, **DUAL INPUT** (sidesticks).
* **TCAS II v7.1**: TRAFFIC TRAFFIC; CLIMB CLIMB; DESCEND DESCEND; CLIMB, CROSSING CLIMB; DESCEND, CROSSING DESCEND;
  LEVEL OFF LEVEL OFF; CLIMB, CLIMB NOW; DESCEND, DESCEND NOW; INCREASE CLIMB/DESCENT; MAINTAIN VERTICAL SPEED;
  MONITOR VERTICAL SPEED; CLEAR OF CONFLICT. ✔ FAA "Introduction to TCAS II Version 7.1", Table 4.

### 737-800 (Boeing aural warning system + Honeywell EGPWS + TCAS)
✔ b737.org.uk "Warning Systems": cockpit aural warnings are the **fire bell**, **takeoff configuration warning**,
**cabin altitude warning**, **landing-gear configuration warning**, **Mach/airspeed overspeed (clacker)**, **stall
warning (stick shaker)**, GPWS and TCAS; external: fire bell in the wheel well, ground-call horn. No master-caution
aural is listed. Plus the **A/P disconnect wailer**, **altitude alert tone**, **hi-lo crew-call/SELCAL chime**.
* Takeoff-config and cabin-altitude = intermittent horn; gear config = steady horn. ✔ measured on the P-8A: intermittent
  horn ≈0.21 s on / 0.52 s period, ≈200 Hz harmonic series.
* ✔ Stick shaker = eccentric-weight motor on each column (b737.org.uk "Stall Warning System"); ✔ NTSB AAR-07/06 CVR
  labels "[sound similar to stick shaker]", "[sound similar to altitude warning horn]".
* ✔ GPWS priority (b737.org.uk): WINDSHEAR ×3 > PULL UP (sink rate) > PULL UP (terrain closure) > V1 > TERRAIN TERRAIN
  PULL UP > WINDSHEAR AHEAD > TERRAIN TERRAIN > MINIMUMS > CAUTION TERRAIN > TOO LOW TERRAIN > altitude callouts >
  TOO LOW GEAR > TOO LOW FLAPS > SINK RATE > DON'T SINK > GLIDESLOPE > MONITOR RADAR DISPLAY > APPROACHING MINIMUMS >
  BANK ANGLE > TCAS RA > TCAS TA.
* ✔ Radio-altitude callouts (customer option): 2500 ("TWENTY FIVE HUNDRED" or "RADIO ALTIMETER"), 1000, 500, 400, 300,
  200, 100, 50, 40, 30, 20, 10, "MINIMUMS", "PLUS HUNDRED", "APPROACHING MINIMUMS" (DH+80 ft), "APPROACHING DECISION
  HEIGHT", "DECISION HEIGHT". ✔ P-8A and Transaero 737NG recordings: same male voice.
* TCAS: as for the A320.

### F-16C (VMS/VMU, female voice — Erica Lane per Wikipedia)
✔ From the -1 excerpts (T.O. GR1F-16CJ-1, Block 52-class; and MLU M3 tape docs) posted in NikolaiVChr/f16 issue #368:
* "WARNING-WARNING (pause) WARNING-WARNING" 1.5 s after any glareshield warning light; reset with WARN RESET.
* "CAUTION-CAUTION" 7 s after a caution light (not IFF); not heard if MASTER CAUTION is reset immediately.
* "ALTITUDE-ALTITUDE" (descent after takeoff, below CARA ALOW, below MSL floor); "BINGO-BINGO"; "PULLUP-PULLUP-…"
  (automatic fly-up / TF failure / GAAF); "JAMMER", "COUNTER", "CHAFF-FLARE", "LOW", "OUT", "LOCK", "DATA", "IFF"
  (ground test only). MLU: 10 VMU messages; EWMS "MISSILE, MISSILE", NOSE/TAIL/RIGHT/LEFT, HI/LO/LEVEL, "COUNTER, COUNTER".
* Priority: PULLUP > ALTITUDE > WARNING > JAMMER > COUNTER > CHAFF-FLARE > LOW > OUT > LOCK > CAUTION > BINGO > DATA >
  IFF. All voice messages have priority over the **low-speed warning tone** and the **LG warning horn**. The VMS does not
  work with weight on wheels (MAL & IND LTS test plays every word once).
* ✔ NikolaiVChr/f16 `jsb-misc.xml`/`f16-sound.xml` (citing Dash-1 1-70/1-95 and DTIC AD-A145-469): LG warning horn =
  250 Hz square tone in 1 Hz intervals when the gear is not down, < 190 kt, < 10,000 ft and descending > 250 ft/min;
  low-speed warning tone = steady 250 Hz square below an airspeed schedule (gear up) or AOA > 15° (gear down).
  (DTIC was under maintenance; AD-A145-469 itself could not be read.)
* Not in the VMS list: "OVER G", "LANDING GEAR", "LOW SPEED".

### F-22A
No public primary source for the ICAWS aural vocabulary was found (the sub-agent checked DVIDS F-22 Demo Team cockpit
clips — ambient mic or music only). Commonly described as a female voice; the words, priorities and tones are
unverified. The game's F-16 list for the F-22 is an assumption.

### UH-60 (✔ TM 1-1520-237-10, UH-60A/EH-60A operator's manual, 1988, Internet Archive, Public Domain Mark)
* Master warning panel: #1 ENG OUT, #2 ENG OUT, FIRE, LOW ROTOR RPM, MASTER CAUTION.
* LOW ROTOR RPM light flashes 3–5 times per second below 95 % NR; below 95 % NR **or** Ng < 55 % "a low steady tone is
  provided"; the low-rotor tone is inhibited on the ground (left WOW switch); the Ng (ENG OUT) tone is not inhibited;
  ENG OUT lights and tone at 55 % Ng and below.
* Stabilator auto-mode failure: MASTER CAUTION + STABILATOR caution and "a beeping tone … in the pilot's and copilot's
  headphones", silenced by MASTER CAUTION reset.
* Radar altimeter (AN/APN-209) low-altitude warning: LO light only (no aural mentioned).
* UH-60M (CAAS glass cockpit) voice messages could not be verified from public sources (sub-agent: DTIC snippets list
  "Low rotor RPM, Master caution, Caution advisory, Fire warning, AFCS" as UH-60 warning systems; an Army Flightfax
  narrative says "the Low Rotor RPM continued to sound").


## 4. Candidates found

All files: `assets/audio/candidates/<id>/<sound>/orig/` (unmodified; FlightGear files prefixed with the repo key, video
excerpts ±1 s around the event with the full unmodified soundtrack in `<id>/_sources/`), previews next to them.

### Real recordings with a usable licence
| Aircraft / sound | Source | Licence / credit | Quality |
|---|---|---|---|
| A320 callouts 500, 400, 300, 200, 100, 50, 40, 30, 20; RETARD (single + ×4) | Commons `Baïonnette_CDG.ogv` — Air France A319 F-GRXM cockpit, CDG 26R, 2010, own work of Sygoletto | **CC BY-SA 3.0** (or GFDL). Credit "Sygoletto / Wikimedia Commons, CC BY-SA 3.0", licence link, note changes; edited audio must stay CC BY-SA | 44.1 kHz mono Vorbis ≈64 kb/s; voice 11–16 dB over engine/wind noise; no clipping. High confidence. |
| A320 callouts 500, 400, 300, HUNDRED ABOVE, 200, MINIMUM, 100, 50, 40, 30, 20; RETARD ×2; **A/P disconnect cavalry charge** | Commons `Adria_Airways_A319_Night_landing_takeoff_Frankfurt_+_Landing_at_Ljubljana_(cockpit).ogv` — S5-AAP, YouTube CC-BY upload by jan tisler, licence-reviewed | **CC BY 3.0**. Credit "jan tisler (YouTube aircraft16), via Wikimedia Commons, CC BY 3.0", note changes | 44.1 kHz stereo Vorbis ≈80 kb/s; 6–11 dB over noise; some full-scale samples; radio/crew speech nearby. Medium confidence (cavalry: high — waveform verified). |
| 737 callouts 500, APPROACHING MINIMUMS, 50, 40, 30, 20, 10; **intermittent configuration horn** | DVIDS 910648 "P-8A Poseidon Night Approach" (VP-46, 2024), U.S. Navy video by MC2 Jacquelin Frost | **Public domain** (not "Courtesy"); credit optional; do not imply DoD endorsement | 48 kHz AAC ≈93 kb/s; only 3–5 dB over noise but intelligible; b-roll edits. High (callouts) / medium (horn identity). |
| 737 callouts 500, 400, 300, APPROACHING MINIMUMS, MINIMUMS, 100, 50, 40, 30, 20, 10 | Internet Archive `youtube-_0F9Ojz705s` — Transaero 737NG Irkutsk landing (2015), YouTube channel Vnebelaynery | **CC BY 3.0** per the 2020 mirror's YouTube metadata — **re-check the live YouTube page before shipping**. Credit "Vnebelaynery (YouTube), CC BY 3.0" | 48 kHz Opus; ≈5 dB over noise; ATC/crew speech nearby. Same voice as the P-8A (template match). |

### Real, public domain, reference only (F-16)
* Commons `Auto-GCAS_Saves_Unconscious_F-16_Pilot—Declassified_USAF_Footage.webm` (Arizona ANG F-16 HUD tape, 2016,
  PD US Air Force per Commons review; uploaded from Aviation Week's YouTube): a ≈5.5 s steady **240.8 Hz near-ideal square
  wave** (odd harmonics −9.5/−16/−20 dB, unclipped) right after the fly-up — consistent with the F-16's 250 Hz warning
  tones but unidentified (could also be a radio heterodyne); a 1 s unidentified buzz; the IP's radio call "Two, recover"
  ×4. No VMS words anywhere in the clip. Source audio is clipped at 0 dBFS in places.
* DVIDS 454188 (Thunderbirds F-16D intercom, PD): "Bingo. Bingo." during a G manoeuvre — pitch contours differ, so almost
  certainly the pilot, not the VMS. Rejected (also contains actor Gerard Butler's voice elsewhere).

### FlightGear (GPL-2.0) — legally usable, provenance mostly not stated
* **A320-family** (`legoboyvdlp/A320-family` @ b6d40c4): crc, chime, c-chord, cricket, stall_voice, retard, callouts
  2500…5 + 100-above + minimum, GPWS voices, priority-left/right, dual-input, click. The CRC/chime are 1 kHz square-wave
  beeps, the C-chord a 128 Hz-harmonic major chord — synthetic; whisper hears the stall voice as "Stool. Stool.".
* **737-800YV** (`YV3399/737-800YV` @ 9d967d8): fire-bell (11 kHz, inharmonic bell partials → a real bell of unknown
  origin), overspeed clacker (8 kHz / 8-bit), stall = stick shaker (22 kHz, 50–200 Hz rattle), altAlert ("custom", i.e.
  community-made chord), cabincall hi-lo chime, gpws callouts and voices.
* **fgdata** (`flightgear/fgdata` @ ac5327c): MK VIII EGPWS voices (2006, 11 kHz / 8-bit, origin not stated), TCAS female
  voice (TTS by its own commit message), RETARD/100-above (text2speech.org TTS), `gear-hrn.wav` (2001, 8 kHz; the same
  contributor's commits mention "courtesy simphonics.com" and "a little copyright problem" → rejected).
* **NikolaiVChr/f16** (@ 0d0d3d4): betty/*.wav (warning, caution, pullup, altitude, bingo, lock, data, jammer, chaff-flare
  (-out), IFF, missile, combined MAL & IND test) — clean studio voice, provenance not stated, a contributor believes TTS;
  250 Hz square tones (document-based synthesis).
* **F-22** (`racerretrocoder/Flightgear-F-22A-Raptor`, `FGMEMBERS/Lockheed-Martin-FA-22A-Raptor`): pullup (24 kHz/8-bit),
  "Over G" (48 kHz, digitally silent background), "Fuel low" (11 kHz), generic beeps — provenance not stated.
* **FGUK UH-60** (`FGMEMBERS/UH-60`): warn650/warn2600 — generic sine tones inherited from the Bo105.

### Not usable (details in `found_air.json` / `found_mil.json` → `references`, also on the page)
FlyByWire `a32nx-wwise` and X-Plane A321neo sound packs (CC BY-NC-SA 4.0); `flybywiresim/aircraft` (no audio files);
GitHub sound folders without licence or ripped from games/sims (GeoFS GPWS, default-sim B777/Beech sets); Freesound
(CC0 imitations made in Audacity, sci-fi TTS, NonCommercial, a real DHC-6 intercom recording = wrong aircraft, an NZ A320
cabin double chime = not a cockpit alert); Commons GPWS snippets by "Unknown" from "scratch"; Commons "Tcas_*.ogg"
(CC BY-SA, "own work" but not stated whether real 737 or simulator — kept as "review" on the page); NATO A330 MRTT videos
on DVIDS ("Courtesy Natochannel"); NTSB (CVR audio never released); ≈40 P-8A/C-40 and ≈330 F-16/F-22/UH-60 DVIDS videos
without alerts (ambient GoPro audio, music, or "Audio was not cleared for release"); MSFS H-60M (GPL-3.0 code, sounds
only in a compiled Wwise bank with no provenance); DCS, Falcon BMS, MSFS add-ons, YouTube.


## 5. How the missing ones really sound (for faithful re-synthesis)

| Alert | Description (sourced where marked ✔) |
|---|---|
| A320 cavalry charge | ✔ 1660 Hz / 830 Hz square waves alternating every 40 ms (A-B-A-B-A = 200 ms), 200 ms off; 3 bursts for an intentional disconnect. The game's file already matches. |
| A320 CRC / single chime / C-chord / cricket | FWC-generated electronic sounds; waveform specs exist in Airbus maintenance documentation (the cavalry diagram came from the same kind of table) but were not found publicly. CRC = rapidly repeating single chime; SC = one decaying chime; C-chord ≈1.5 s three-note chord; cricket = rapid high-pitched pulses, followed by "STALL STALL" (synthetic male voice). |
| A320 SPEED SPEED SPEED | ✔ FWC voice, repeated every 5 s while the low-energy condition persists. |
| A320/737 windshear | Reactive: "WINDSHEAR" ×3 (737: preceded by a two-tone siren). Predictive: "WINDSHEAR AHEAD" ×2 / "GO AROUND, WINDSHEAR AHEAD" / "MONITOR RADAR DISPLAY". |
| 737 intermittent horn (takeoff config / cabin altitude) | ✔ measured (P-8A): ≈1.9 pulses/s, pulse ≈0.21 s, harsh harmonic tone with ≈200 Hz partial spacing (600 Hz–4.4 kHz). |
| 737 landing-gear horn | Steady (continuous) horn, same family of sound as the intermittent horn (unverified). Sounds before EGPWS "TOO LOW, GEAR". |
| 737 fire bell | Classic fast-striking electric bell, continuous until BELL CUTOUT. |
| 737 stick shaker / clacker | ✔ eccentric-weight motor shaking both columns (loud low-frequency rattle); clacker = mechanical fast clacking until below VMO/MMO. |
| F-16 LG warning horn | ✔ 250 Hz square wave, 0.5 s on / 0.5 s off; gear up, < 190 kt, < 10,000 ft, descending > 250 ft/min. |
| F-16 low-speed warning tone | ✔ steady 250 Hz square wave; gear-up airspeed schedule or AOA > 15° gear down. Possibly the 241 Hz tone in the Auto-GCAS tape. |
| F-16 VMS words | ✔ female voice; one recorded word per message replayed ("WARNING WARNING – WARNING WARNING"), headset band-limited; timings 1.5 s (warning) / 7 s (caution). |
| UH-60 low rotor RPM | ✔ low **steady** tone below 95 % NR (or Ng < 55 %), none on the ground; LOW ROTOR RPM light flashing 3–5 Hz. Frequency not stated. |
| UH-60 ENG OUT | ✔ steady tone at Ng ≤ 55 % (not inhibited on the ground). |
| UH-60 stabilator | ✔ beeping tone in the headsets until MASTER CAUTION reset. |
| F-22 | Unknown from public sources. |


## 6. Licences and what crediting they require

* **GPL-2.0** (FlightGear A320-family, 737-800YV, fgdata, F-16, F-22, UH-60): ship the licence text, keep the copyright
  notice / authors (as `assets/audio/CREDITS.txt` does for the A/P sounds), derived audio is GPL-2.0 too, make the
  "source" (the WAV) available — the repo already keeps originals in `tools/audio/third_party/flightgear/`.
* **CC BY 3.0** (Adria A319 — jan tisler; Transaero 737NG — Vnebelaynery): name the author, link the licence and the
  source, state that the clip was cut/processed. Re-verify the Transaero YouTube licence on the live page.
* **CC BY-SA 3.0** (Air France A319 — Sygoletto): as CC BY, plus the edited audio files must be released under CC BY-SA
  3.0 (or compatible); the game code is not affected.
* **Public domain** (P-8A DVIDS 910648, USAF Auto-GCAS tape): no attribution required; courtesy credit recommended
  ("U.S. Navy video by MC2 Jacquelin Frost / DVIDS"); no implication of DoD endorsement.
* Note: a PD/CC recording of a real cockpit captures sounds (FWC/EGPWS voices) that were themselves produced by
  Airbus/Honeywell. Short functional alerts captured incidentally in a cockpit video are generally treated as part of
  that recording; the risk is low but non-zero and applies equally to every "real recording" option.
* Process note: twice during the research (once by the lead research agent, once by the military sub-agent) a Wikimedia
  request carried the owner's e-mail address in its User-Agent header; this was not repeated.


## Reproduce

```
.venv/bin/python tools/audio/research/fetch_fg.py        # FlightGear originals, pinned commits, SHA-256 → fg_sources.json
.venv/bin/python tools/audio/research/analyze.py --whisper  # metrics + transcripts → analysis.json
.venv/bin/python tools/audio/research/build_review.py    # previews + assets/audio/candidates/review.json
node tools/shot.mjs "dev/sesler.html" /tmp/sesler.png     # page check (0 console errors)
```
DVIDS/Commons originals were downloaded by the sub-agents (URLs, segments and licences in `found_*.json` /
`external_candidates.json`).
