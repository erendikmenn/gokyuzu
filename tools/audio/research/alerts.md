# Cockpit alerts per real system — decisions (wave 7)

What ships, and why. Evidence: `alerts_logic.md` (which unit says what, thresholds; A320 FCOM 2023, FlyByWire FWC/FAC
code, Boeing 737NG FCOM, Honeywell MK V/VII guide + FlightGear `mk_viii.cxx`, T.O. 1F-16A-1 + DTIC AD-A145469,
TM 1-1520-237-10 / TC 3-04.33), `notes_737_egpws.md`, `notes_f22_uh60.md`, `warnings.md` (wave-6 recording search),
`real_clips.json` / `voice_refs.json` / `voicematch.json` (measurements below). Runtime: `src/audio/alertlogic.js`.
Listening record: `dev/sesler.html` (old / shipped / alternatives / source / licence / reason for every row).

## Rules applied
1. **One voice per real system.** A system's set is taken from real recordings only if clean real clips cover all of it;
   otherwise the whole set is generated with the ElevenLabs voice closest to the real one (no cloning), with the real
   phrasing, repetition and timing, through a cockpit-speaker chain matched to the real recordings.
2. **Triggers follow the real logic** (thresholds, priorities, repetition, inhibits). Sounds of alerts the real aircraft
   does not have were removed (they stay audible on the listening page as "eskiden oyunda").
3. Real-recording excerpts are never shipped (dev page only; `build_dist.mjs` skips `candidates/`).

## Real recordings: extraction and verdict (`tools/audio/real_clips.py`)
Spectral gating (noisereduce, noise print just before each word) + 250–4000 Hz + edge gate + −19 dBFS active speech
level. demucs `htdemucs_ft` was tried on every clip and **rejected**: it classifies the synthetic FWC/EGPWS voice as
non-vocal and removed it in most clips (retention −17…−77 dB); where it kept it, whisper no longer understood the word.

| Source | Clips | Source SNR (speech band) | Verdict |
|---|---|---|---|
| Air France A319 F-GRXM (CC BY-SA 3.0) | 500, 400, 300, 200, 100, 50, 40, 30, 20, RETARD, RETARD×4 | 11–22 dB | 500/400/300/200/40/30/20/RETARD clean enough; 100/50 audible noise |
| Adria A319 S5-AAP (CC BY 3.0) | HUNDRED ABOVE, MINIMUM (×2), 500, RETARD | 9.5–16 dB | usable with audible noise |
| P-8A DVIDS 910648 (PD) | 500, APPROACHING MINIMUMS, 50, 40, 30, 20, 10; config horn | 3–8 dB | reference only |

**A320 FWC**: the real clips miss 2500, 1000, 10, 5, the intermediate callouts, STALL and SPEED SPEED SPEED → generated.
**737 EGPWS**: the P-8A clips are too noisy and cover no warning → generated. Both real sets are kept on the page.

## Voice choice (`tools/audio/voicematch.py`)
Measured on the real recordings: FWC median F0 **110 Hz**, fast delivery (FIVE HUNDRED ≈ 0.6 s); Honeywell EGPWS (P-8A)
F0 **≈124 Hz**. Documented accents (Wikipedia, non-primary): recent Airbus FWC British RP; Boeing/Honeywell American.
Score = |ΔF0| (semitones) + 6·|log2 duration ratio| + 4 if the accent differs.
* FWC → ElevenLabs **Voice Design** voice "FWC DesignB" (text description: deep British RP male, flat automated
  announcement; not a clone), F0 116 Hz, score 3.1 (next: DesignA 5.5, Daniel 6.6, George 7.0).
* Honeywell EGPWS → **Adam**, F0 129 Hz, score 4.0 (Roger 4.7, Brian 5.9). Same voice on the A320 and the 737 (same
  Honeywell unit), equalised to each cockpit (A320: A319 spectrum; 737: P-8A spectrum).
* Loudspeaker chain: matched EQ (85 % of the third-octave difference to the real long-term spectrum, ±15 dB), 250–4000 Hz,
  syllable compressor, light tanh saturation, small flight-deck room, −19 dBFS. Military voices: headset chain.
* F-16 VMS: Sarah (female; no real VMS recording is redistributable). F-22: Matilda (a different female voice).
* UH-60M VWS: Bella (female, headset chain; no H-60 VWS recording exists publicly).

## What each aircraft does now
**A320neo** — FWC (FWC voice): callouts 2500 (TWO THOUSAND FIVE HUNDRED), 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20,
10, 5 with the FBW detection windows / lockouts / re-arm, descending only, inhibited while the EGPWS speaks (+2 s), STALL
and SPEED SPEED SPEED; HUNDRED ABOVE / MINIMUM at DH 200 ft (approach = gear down); intermediate callouts below 410 ft;
"TWENTY, RETARD" (manual) / "TEN, RETARD" (autoland) then RETARD every ≈1.1 s until IDLE/REV/TOGA or 80 kt (real video:
1.07–1.23 s); cricket + STALL (only when actually stalled — the game stays in normal law); SPEED SPEED SPEED (CONF ≥ 2,
100–2000 ft, < VLS−10 kt or < VLS decelerating, every 5 s; uses `warnings.lowEnergy` when the flight model publishes it,
inhibited by an alpha-floor flag); CRC for OVERSPEED, L/G GEAR NOT DOWN (< 750 ft, not in take-off phase 5) and
T.O CONFIG; single chime for A/THR OFF and FUEL LO LVL; C-chord (approach 750 ft only without A/P; continuous on a 250 ft
deviation; inhibited gear down / G/S / LAND); cavalry charge unchanged. EGPWS (Adam): modes 1–5, "TERRAIN AHEAD, PULL
UP" for the look-ahead; **no BANK ANGLE** (not on the A320).
**737-800** — EGPWS (Adam) modes 1–6: callouts TWENTY FIVE HUNDRED, 1000, 500, 100, 50…10 once per approach (re-arm above
1000 ft), APPROACHING MINIMUMS / MINIMUMS (gear down), BANK ANGLE at 35/40/45° once each, plain PULL UP, "TERRAIN TERRAIN
PULL UP". Aural module: steady gear horn (FCOM flap/thrust/800 ft rules), intermittent take-off-config horn (horn
re-synthesised from the P-8A recording: 202 Hz series, 0.21 s / 0.52 s), clacker at VMO/MMO only, stick shaker, altitude
alert chord 504/630/756 Hz 1.13 s (measured on a 737NG recording) at 900 ft before / 300 ft deviation, wailer ≥ 2 s /
until acknowledged; fire bell (partials 1333/2266/2665 Hz, 15 strikes/s, measured on the 737-800YV bell) behind
FLAGS.fire. **No master-caution aural** (FCOM 15.20: MASTER CAUTION is lights only).
**F-16C** — VMS (inoperative with WOW): WARNING WARNING (pause) WARNING WARNING 1.5 s after TO/LDG CONFIG / ENGINE (< 55 %) /
CANOPY lights; CAUTION CAUTION 7 s after FUEL LOW; ALTITUDE ALTITUDE below ALOW 500 ft with the gear up; BINGO (1500 lb)
once; PULLUP ×4 repeating. Tones: LG warning horn 250 Hz pulsed **5 Hz** (AD-A145469; FlightGear's 1 Hz is wrong);
low-speed tone steady 250 Hz (AOA ≥ 15° gear down; pitch 45–90° and kt < 2.22·pitch gear up). Voice > low-speed tone >
LG horn. Removed: LANDING GEAR, LOW SPEED, OVER G voices, CAUTION on overspeed.
**F-22A** — no public vocabulary. Sourced: cautions = aural tone (+ CAUT in the HUD), warnings reach the headset, voice
synthesis exists, LAWS off by default. Shipped: caution tone (FUEL LOW), warning tone + voice ("LANDING GEAR", "LEFT/RIGHT
ENGINE FAIL"), PULL UP — words and tone shapes are assumptions; no F-16 VMS copy.
**UH-60M** — voice warning system in the **MH-60K VWS format** (TM 1-1520-250-10 para 2-227 / table 2-6, the closest
documented Army H-60 voice system; the UH-60M manual TM 1-1520-280-10 is Distribution D, TC 3-04.33 only names "low rotor
RPM audio" / "engine out audio", ARL 2006 confirms "low bug audio" on the M): ENGINE 1 OUT / ENGINE 2 OUT (Ng ≤ 55 %, also
on the ground) and LOW ROTOR (NR < 96 %, WOW-inhibited) = 2 s continuous 250 Hz tone (the A/L manual's "low steady tone"),
0.5 s, message, 1 s, message; ALTITUDE LOW = message ×3 when descending > 300 fpm through the 50 ft low bug. A cycle
repeats after 1 s while its condition holds and is **cut at once** when it clears; with no VOICE ACK button in the game,
simultaneous messages take turns. Voice: ElevenLabs "Bella" (headset chain). **Nothing on rotor overspeed** (no H-60
manual has a high-rotor aural): the staging "music" (NR 124 %, collective down) is gone. Removed: 4 Hz warble, PULL UP,
BANK ANGLE, old ALTITUDE. Changed in wave 7b from "tones only": the lead asked for UH-60M voice warnings and the MH-60K
format keeps the documented steady tone in front of every NR/Ng message; the tone-only variant stays on the page.

## Flight-model flags (one line each in `alertlogic.js` FLAGS)
`lowEnergy` → A320 SPEED SPEED SPEED (the FAC rule is computed in the audio only when the model does not publish it);
`alphaFloor` / `aFloor` / `togaLock` → inhibit SPEED SPEED SPEED (A.FLOOR and TOGA LK have no aural of their own);
`lowSpeed` → F-16 low-speed warning tone **with the gear handle down only** (AoA > 15°); gear up the tone follows only the
real nose-high schedule (pitch 45–90°, KIAS < 2.22 × pitch) — the model's gear-up flag is HUD/hint only (F-22: no sourced
aural, not used); `lowRotor` → UH-60 LOW ROTOR (+ WOW inhibit); `fire` / `engineFire` / `apuFire` → 737 fire bell, A320
CRC, F-16 WARNING (ENG FIRE) — no flight model reports a fire yet. `highRotor` is deliberately unused.
Also read: `flight.athrMode` ('' / 'A.FLOOR' / 'TOGA LK'): leaving it without the A/THR engaged = A/THR OFF single chime;
`flight.crashCause` counts as a crash (every alert stops). Exported: `audio.alertActive` (boolean getter for the hints).

## Staging bug ("after takeoff, reduce power → music, then dark screen")
* UH-60 collective down: the 4 Hz warble was the "music"; now NR 124 % is silent, LOW ROTOR only below 96 % NR airborne.
* F-16 at 53 m/s, gear up, level pitch: the real jet has no low-speed tone there; it gets TO/LDG CONFIG (gear up, < 190 kt,
  < 10 000 ft, descending > 250 fpm) → LG warning horn + WARNING WARNING, then ALTITUDE / PULLUP in the real priority
  order (verified in the game); gear down, AoA > 15° → steady 250 Hz low-speed tone.
* A320: SPEED SPEED SPEED from the flight model's `lowEnergy`, then A.FLOOR / TOGA LK.
* Every alert loop stops when its condition ends, on a crash and on a reset; the A/P-disconnect alert is stopped by the
  crash and never started after one (the A/P disengages silently when crashed); an autoland rollout disconnect counts
  as the crew's take-over (single cavalry charge, not the permanent one).

## Verification (`tools/audio/alertprobe.mjs`, headless Chromium on the real game)
Scripted situations per aircraft (flight.reset + commands + lever moves), checked against `window.__audioSys.trace`
(voice / tone / loop± with its cause / apd±): 10–12 scenarios per aircraft incl. crash and "owner report" replays; results
in `alertprobe.json` and on `dev/sesler.html`. 0 console errors, no missing audio file.

## Not modelled (gaps for the lead)
Windshear (no wind model), TCAS (no traffic), fires (the fire bell is ready behind FLAGS.fire), cabin altitude, hydraulic/electrical failures, F-16
canopy opening in flight (the game only opens it on the ground), HORN CUTOUT / MASTER WARN / MASTER CAUTION / VOICE ACK buttons (the
A/P key acknowledges the A/P-disconnect alert), UH-60 stabilator. The FCU/MCP altitude is the autopilot target (valid once
the A/P was engaged). The physical thrust lever is not visible to the audio, so RETARD uses the effective lever.
