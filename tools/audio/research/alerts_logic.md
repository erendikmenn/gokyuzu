# Aural alerts: which system says what, and when (logic research, wave 7)

> Copied from the research sub-agent's notes. The local copies it cites (`dl/`, `fbw/`, `f16/`, `rustfwc/`) were
> downloads in a scratch folder and are not kept in the repository (third-party manuals/code); every source has its
> public URL in the table below. The decisions taken from this research are in `alerts.md`.

Research only (no project files changed). Written for the audio agent so that the game's warnings follow the real
systems. Confidence: **H** = verbatim primary source or code written from the real logic sheets; **M** = secondary /
inferred / one step removed; **L** = weak or guess. "Not found" is stated where nothing was found.

## Sources used (local copies under `research/`)

| Tag | What | Where |
|---|---|---|
| **FCOM320** | Airbus A319/A320/A321 FCOM (LTM fleet), revision 02 MAY 23, full OCR text (Internet Archive item `a-319-a-320-a-321-fcom-02-may-23`) | https://archive.org/download/a-319-a-320-a-321-fcom-02-may-23/A319_A320_A321%20FCOM%20%2002%20MAY%2023_djvu.txt → `dl/a320_fcom_2023_djvu.txt` (line numbers "Lnnn" below refer to this file) |
| **FBW** | FlyByWire `flybywiresim/aircraft` @ `2baa2b35eadaf4c78e172ce41bbe6b40b4aeafb2` (GPL-3.0): `fbw-a32nx/src/systems/systems-host/systems/FWC/{PseudoFWC,FwsAutoCallouts,FwsSoundManager}.ts`, `fbw-a32nx/src/wasm/fbw_a320/src/model/FacComputer*.cpp` (Simulink FAC), `fbw-common/src/wasm/systems/systems/src/surveillance/egpws/runtime.rs` (Honeywell-style EGPWS), `.../navigation/adirs.rs` | `fbw/` |
| **FBW-RS** | FlyByWire Rust FWC rewrite (PR #4872, branch `beheh/flybywire-aircraft@05a50c64`, closed/unmerged) — FWC logic sheets reproduced in Rust + README | `rustfwc/` |
| **FBWDOC** | docs.flybywiresim.com source (`flybywiresim/docs`, protections overview) | `fbwdocs/` |
| **PR364** | legoboyvdlp/A320-family PR #364 waveform diagram (Airbus doc scan) | `dl/pr364.png` |
| **FCOM737 / MKV / MKVIII / FG** | Boeing 737NG FCOM D6-27370-TBC Rev 26 (2010, archive.org), Honeywell MK V/VII pilot guide 060-4241-000 Rev E, MK VI/VIII guide 060-4314-000 Rev C (Wayback of egpws.com), FlightGear `mk_viii.cxx` @ `5a08bcf7` | details + line numbers in `notes_737_egpws.md`, files in `dl/egpws/` |
| **TO1F16A** | USAF T.O. 1F-16A-1 Flight Manual (Blocks 10/15), Change 14, 15 Aug 2003, OCR on archive.org item `usaf-f-16` | https://archive.org/download/usaf-f-16/USAF-F16_djvu.txt → `dl/usaf_f16_djvu.txt` |
| **Dash1-368** | GR1F-16CJ-1 (Block 50/52-class) VMS pages posted as images in NikolaiVChr/f16 issue #368 | `f16/img1..8.png` |
| **NVC** | NikolaiVChr/f16 @ `0d0d3d425a9a852b9cd6a764dedee7c9c72cdf51` (GPL-2.0): `Systems/jsb-misc.xml`, `Systems/f16-sound.xml`, `Nasal/failures.nas`, `Models/Cockpit/Main/eyebrow_right.xml`, `f16-base.xml` | `f16/` |
| **ADA145469** | DTIC AD-A145469 "Auditory Information Systems in Military Aircraft: Current Configurations Versus the State of the Art" (June 1984) — F-16 Block 01/05/10 tone tables | https://archive.org/download/DTIC_ADA145469/ → `dl/ADA145469.pdf`, `dl/ADA145469_djvu.txt`, page crops `dl/ada_pages/` |
| F-22 / UH-60 | USAF AIB 2010 JBER 2nd addendum, DoD IG DODIG-2013-041, SAB-TR-11-04, AGARD AR-349; TM 1-1520-237-10 (1988 and 1996/2002), MH-60K TM 1-1520-250-10, ARL ADA444913 | `notes_f22_uh60.md`, `dl/` |

## Key decisions for the game (summary)

1. **A320:** callouts/RETARD/C-chord/CRC/SC/cricket+STALL/SPEED×3/PRIORITY/DUAL INPUT = FWC voice & sounds; SINK RATE,
   PULL UP, TERRAIN, TOO LOW …, DON'T SINK, GLIDESLOPE = EGPWS; **no BANK ANGLE, no EGPWS callouts**. Wire the unused
   `c_chord` (altitude alert), `single_chime` (A/THR off, fuel LO LVL 750 kg), `cricket` (only in alternate/direct law —
   in the game's normal law the A320 never gets STALL), CRC for overspeed (VMO+4/MMO+0.006, not cancellable), L/G NOT DOWN
   (< 750 ft RA), T.O CONFIG. RETARD: "TWENTY, RETARD" once at 20 ft (10 ft autoland) then "RETARD" every ≈ 1.1 s until
   all levers idle; 10/5 suppressed meanwhile. SPEED SPEED SPEED: CONF ≥ 2, 100–2000 ft RA, every 5 s.
2. **737-800:** no master-caution aural; gear horn = steady horn (flaps-dependent, see B1); config/cabin = intermittent
   horn; altitude alert = momentary tone at 900 ft / 300 ft deviation, inhibited flaps ≥ 25 or G/S captured; A/P wailer
   ≥ 2 s; plain "PULL UP"; BANK ANGLE at 35/40/45° once each, re-arm ≤ 30°; callouts once per approach, re-arm > 1000 ft.
3. **F-16C:** remove "LANDING GEAR", "LOW SPEED", "OVER G" voices. LG horn = **250 Hz tone pulsed ≈ 5 Hz** (< 190 kt, <
   10 000 ft, > 250 fpm descent, gear not down; silencer); low-speed tone = **steady 250 Hz** (AOA ≥ 15° gear down, or
   nose-high: speed < 2.22 × pitch for pitch 45–90° gear up). "WARNING WARNING" 1.5 s after any red glareshield light
   (ENGINE, HYD/OIL PRESS, TO/LDG CONFIG, CANOPY, FLCS, ENG FIRE …); "CAUTION CAUTION" 7 s after a caution light (FUEL
   LOW: fwd reservoir < 400 lb / aft < 250 lb); ALTITUDE (CARA ALOW, gear up), BINGO once; nothing with WOW.
4. **F-22A:** vocabulary unknown publicly; cautions = aural **tone** + HUD "CAUT"; warnings to headset (voice synthesis
   exists); LAWS low-altitude alert is pilot-set/off by default. Anything else is an assumption.
5. **UH-60M:** low rotor RPM / engine out = **low steady tone** (< 96 % NR or Ng ≤ 55 %; rotor tone inhibited on ground),
   stabilator = beeping tone until MASTER CAUTION reset, radar-altimeter low-bug audio exists on the M. Voice messages
   unverified for the M (MH-60K had "LOW ROTOR", "ENGINE 1 OUT", "ALTITUDE LOW", "STABILATOR" preceded by 2 s 250 Hz
   tones — best public stand-in). No bank-angle or pull-up voice sourced for any H-60.

---

## A. A320neo

### A1. Which unit generates which aural (H unless noted)

FCOM320 DSC-31-10 "Audio indicators" table (L262890–263340) + DSC-34-NAV-40-10 (L291087) + DSC-34-SURV-40-20
(L295260+) + DSC-22_40-30/40 (L224150, L224244):

| Aural | Generated by | Notes |
|---|---|---|
| CRC (continuous repetitive chime) | **FWC** | red warnings; "PERMANENT", cancel MASTER WARN (not for OVERSPEED or L/G NOT DOWN) |
| Single chime | **FWC** | amber cautions; **0.5 s** |
| Cavalry charge | **FWC** | A/P off: 1.5 s by take-over pb (cancel = 2nd push); PERMANENT if due to failure |
| Triple click | **FWC** | landing-capability downgrade / some mode reversions, 0.5 s (3 pulses) |
| Cricket + "STALL" | **FWC** | "PERMANENT", cancel NIL; alternate/direct law only (see A4) |
| C-chord | **FWC** | altitude alert, 1.5 s or PERMANENT (DSC-31-40: "The FWC generates an altitude warning (C chord…)") |
| Auto callouts 2500…5, HUNDRED ABOVE, MINIMUM, RETARD, intermediate callouts | **FWC** synthetic voice | "The FWC generates a synthetic voice for radio height announcement below 2 500 ft … through the cockpit loudspeakers, even if the speakers are turned off" (L291092) |
| "PRIORITY LEFT/RIGHT" (1 s), "DUAL INPUT" (every 5 s) | **FWC** synthetic voice | listed in the FWS table; FBW-RS `audio.rs` holds them as FWC voice files (IDs 60) |
| "SPEED SPEED SPEED" | computed by **FAC**, voiced as FWS synthetic voice | "The low energy aural alert is computed by the FAC" (L244582); FBW: FAC word 3 bit 11 → FWC `speedSpeedSpeed` voice (`FwsAutoCallouts.ts` L347–359) |
| "WINDSHEAR" ×3 (reactive) | detected by **FAC** | "The windshear detection function is provided by the FAC … An aural synthetic voice announcing 'WINDSHEAR' three times" (L224244+); the FCOM does not say which box synthesises the words (listed in the FWS audio table). FWC-voiced is **M/L**. Available 3 s after lift-off → 1300 ft RA, and 1300 → 50 ft RA on approach, CONF ≥ 1. |
| "WINDSHEAR AHEAD" (×2, take-off), "GO AROUND, WINDSHEAR AHEAD", "MONITOR RADAR DISPLAY" | **weather radar PWS** | FCOM table; permanent while detected |
| SINK RATE, PULL UP, TERRAIN, TOO LOW GEAR/FLAPS/TERRAIN, DON'T SINK, GLIDESLOPE, TERRAIN AHEAD (PULL UP), CAUTION TERRAIN, (OBSTACLE …) | **EGPWS** (Honeywell) or **T2CAS** (ACSS) | DSC-34-SURV-40-20 lists only basic modes 1–5 (no Mode 6). **No "BANK ANGLE" and no EGPWS altitude callouts on the A320** — heights are FWC (H for the FCOM content; bank-angle absence M: grep for "BANK ANGLE, BANK" in the whole FCOM = 0 hits). |
| TCAS voices | **TCAS** | |
| "RETARD-RETARD" after touchdown (one lever above idle, other idle/rev) | FWC | new standard (FCOM 02 MAY 23), "PERMANENT if triggered above 40 kt" |
| "STOP RUDDER INPUT" | FWC (mod) | cruise, high speed |

Arbitration (FBW `FwsSoundManager.ts` L17–22, L402–445): synthetic voice > aural warning (CRC, cavalry, C-chord,
click) > single chime; within a class by priority. Callouts are suppressed while EGPWS/TCAS speak (GPWS/TCAS
discretes to the FWC, FBW-RS README "Sound Inhibition") and while STALL or SPEED SPEED SPEED are active
(`FwsAutoCallouts.ts` L461–462). FBW comment L275: "single chimes are not filtered (in RL only once every two
seconds)" (M).

### A2. RETARD and auto-callout rules

**RETARD (H: FCOM L263200 & L291120; logic H/M: FBW).**
* FCOM: "RETARD — Thrust levers not in IDLE or REVERSE position for landing — ONE TIME at 20 ft (10 ft in autoland
  with A/THR ON), Then PERMANENT — cancelled when all thrust levers are set to IDLE or REVERSE."
  DSC-34-NAV-40-10: "The loudspeaker announces RETARD at: 20 ft, or at 10 ft if autothrust is active and one
  autopilot is in LAND mode."
* FWC sheet as reproduced by FBW (`FwsAutoCallouts.ts` L671–781; FBW-RS `auto_call_outs.rs` L2419–2452, L2692–2818):
  * Manual landing (no AP in LAND, or A/THR off): at the 20 ft window (RA 20–22 ft) a combined **"TWENTY… RETARD"**
    plays **once**, not gated by lever position (only TOGA, TLA > 43.3°, suppresses it). The plain "TWENTY" is only
    used in autoland.
  * Autoland (AP in LAND + A/THR active): "TEN… RETARD" at 10 ft (RA 10–12 ft).
  * Then "RETARD" **repeats** while RA < 20 ft (manual) / < 10 ft (autoland) (0.1 s confirm), in FWC phases 6/7/8,
    and **any running engine's lever is above idle** (idle = −4.3° ≤ TLA < 2.6°) and no reverser selected.
    Stops as soon as all levers are at IDLE or REV (FCOM). Also suppressed by go-around/TOGA, RA not decreasing.
  * Repeat period: FBW `retard_continuous` = 0.72 s voice + 0.4 s pause ≈ **1.1 s**; FBW-RS voice 716 ms + 200 ms
    gap ≈ 0.9 s; measured on a real A319 video ≈ 1.2–1.3 s (wave 6). Use ≈1.1–1.2 s.
  * **Levers already idle at 20 ft:** the single "TWENTY, RETARD" still plays (not TLA-gated); no repeats. (M — FBW
    sheet reading; FCOM wording "Thrust levers not in IDLE" could also be read as no call at all.)
  * **10 and 5 after RETARD:** "TEN"/"FIVE" are **inhibited while the RETARD repetition is active**
    (`inhibitCalloutDueToRetard`, FBW L766–769, L716–722, L788–792); if levers are already idle they still play.
    In autoland "TEN" is replaced by "TEN, RETARD".
* **Intermediate callouts** (FCOM H, L291112): "If time between two consecutive predetermined call outs exceeds a
  certain threshold, the present height is repeated at regular intervals. The threshold is: 11 s above 50 ft; 4 s
  below 50 ft. The repeating interval is 4 s." (Voices such as "ONE HUNDRED AND NINETY" exist in FBW-RS.) Only below
  410 ft (FBW-RS L2920).
* "If the aircraft remains at a height that is in the detection zone for a height callout, the corresponding
  message is repeated at regular intervals." (FCOM H.)

**Heights and wording (FCOM H, L291097–291130):** 2500 "TWO THOUSAND FIVE HUNDRED" **or** "TWENTY FIVE HUNDRED"
(pin-programmed), 2000, 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10, 5, "HUNDRED ABOVE" at DH/MDA+100,
"MINIMUM" at DH/MDA (+ SLS options 115/90 "STANDBY", 65 "FLARE"). All are operator pin-programmable. FBW's
"Airbus basic configuration" default pins: 2500 (TWO THOUSAND FIVE HUNDRED), 1000, 400, 50, 40, 30, 20, 10, 5
(`AutoCallOuts.ts` L21–31, M). The Adria/Air France recordings also had 500/300/200/100 (airline options).
Reference: RA for DH, baro for MDA/MDH (FCOM).

**Detection windows and re-arm (FBW H/M, `FwsAutoCallouts.ts` L407–442, L485–633):**
| Callout | Window (RA) | Re-arm |
|---|---|---|
| 2500 | 2500 ≤ RA < 2530, confirmed 0.2 s | after climbing **above 3000 ft** (hysteresis 3000/2500) |
| 2000 | 2000–2020, 0.2 s | above 2400 ft |
| 1000 | 1000–1020, 0.2 s | above 1100 ft |
| 500 | 500–513, 0.2 s; "smart 500" pin: only if G/S invalid or G/S dev > 0.175 DDM for 0.5 s | 11 s lockout |
| 400/300/200/100 | N ≤ RA < N+10 (rising edge on entering the band) | 5 s lockout |
| 50/40/30/20/10/5 | [50,53) [40,42) [30,32) [20,22) [10,12) [5,6) | 2 s lockout; a lower callout pre-empts a higher one in the same cycle |
| HUNDRED ABOVE | RA ≤ DH+105 (DH<90) / DH+115; or DMC MDA discrete | once (3 s monostable, memory) |
| MINIMUM | RA < DH+5 (DH<90) / DH+15; or DMC MDA discrete | once |

**Descending only:** callouts 1000…50 are inhibited when the (10 s low-pass filtered) RA is increasing or RA ≤ 3 ft,
while HUNDRED ABOVE/MINIMUM is being generated, and while a GPWS alert (+2 s) is active; 40/30/20 ignore the GPWS
inhibit; 10/5 are inhibited if RA has not been decreasing for 0.3 s. Global inhibit: RA invalid, STALL, SPEED SPEED
SPEED, on ground with both ENG MASTERs on (FBW L438–469).

### A3. C-chord altitude alert

* FCOM (H, DSC-31-40 L272300–272400): "The FWC generates an altitude warning (C chord sound and PFD's altitude window
  pulses in yellow or flashes in amber), when the aircraft approaches a preselected altitude or flight level, or when
  it deviates from its selected altitude or flight level." Duration "1.5 s or PERMANENT" (DSC-31-10). Continuous
  C-chord cancelled by selecting a new altitude, EMER CANC, or either MASTER WARN pb.
  Inhibited: "When the slats are out, with the landing gear selected down, or In approach after the aircraft
  captures the glideslope, or When the landing gear is locked down, [newer MSNs:] or In the case of a TCAS RA."
* Threshold numbers are in an FCOM diagram (not in the OCR text). **FBW implementation (H for code, M for the
  real numbers)** `PseudoFWC.ts` L4362–4458 (nodes L599–621):
  * **Approach:** entering the band 750 ft > |Δ| ≥ 200 ft → yellow **pulsing** window; **C-chord 1.5 s only if no
    AP is engaged** (`altAlertMtrig2 = !anyApEngaged && between200And750`, 1.5 s monostable).
  * **Deviation:** after having been within 200 ft (captured), |Δ| grows to 200–750 ft → amber **flashing** +
    **continuous C-chord** (AP state irrelevant). Also continuous if, after entering the 750 ft band, the aircraft
    goes back beyond 750 ft without capturing.
  * Inhibits: FCU altitude changed (and 1 s after), gear downlocked (and 1 s after), gear lever down with slats
    beyond ~position G, FMGC G/S mode, FINAL DES mode or LAND mode, altitude/FCU data invalid, on ground, TCAS mode.
  * Commonly quoted FCOM figures are **750 ft** (approach) and **250 ft** (deviation); FBW uses 200 ft for the
  deviation band. Use 750/250 unless matching FBW (M).
* Priority: C-chord is an "aural warning" class sound below synthetic voice; FBW issue #10423 notes the overspeed CRC
  should pre-empt a playing C-chord (open).

### A4. Warnings with CRC / SC in a simple sim

| Alert | Aural | Trigger (source) | Conf |
|---|---|---|---|
| **L/G GEAR NOT DOWN** | CRC | Two FBW variants (`PseudoFWC.ts` L3956–3991, EWD 3200150/3200155): (1) **non-cancellable**: gear not downlocked + RA < 750 ft + flaps beyond SFCC position D (FPPU > 152°, ≈ beyond CONF 2) or slats beyond position C (FPPU > 198°) + no take-off power (i.e. approach configuration, commonly described as "CONF 3/FULL"); (2) **cancellable**: gear not downlocked + RA < 750 ft + both N1 < 75 % + no take-off power (TLA ≥ 45°, or ≥ 35° with FLEX), inhibited above 18 500 ft with RA failed. Flight-phase inhibit 3/4/5 (take-off). FCOM: MASTER WARN cannot cancel it ("except for OVERSPEED or L/G NOT DOWN"). | H code / M real |
| **T.O CONFIG** (CONFIG FLAPS/SLATS NOT IN T.O CONFIG, SPD BRK NOT RETRACTED, PITCH TRIM / RUD TRIM NOT IN T.O RANGE, PARK BRK ON, L/R SIDESTICK FAULT) | CRC (red) | FCOM DSC-31-15 (L266035+): triggered "when the flight crew presses the TO CONFIG pushbutton … or applies takeoff power". FBW: FWC phase 3/4 (T.O power set → lift-off) with flaps 0 or FULL (not in T.O range), slats, speed brake extended, trims, park brake (phase 3 only). T.O power = TLA ≥ 45° (TOGA) or ≥ 35° with FLEX (L2925–2931). Phases 5–8 inhibited. | H |
| **OVERSPEED** (VMO/MMO, and VFE per flap config) | CRC, not cancellable | FCOM: "The ECAM displays an overspeed warning at **VMO + 4 kt and MMO + 0.006**" (L244556), aural remains available in alternate/direct law. FBW ADR: set at max speed + 8 kt, reset below + 4 kt (hysteresis, `adirs.rs` ~L1392). Flap overspeed (FBW EWD 3400210–240): FULL > 181, 3 > 189, 2 > 203, 1+F > 219, 1 > 233 kt (≈ VFE + 4). Phases 2–4, 8–10 inhibited. | H/M |
| **STALL** (cricket + "STALL") | cricket + voice, permanent | FCOM: in **alternate/direct law** "audio stall warnings (crickets + 'STALL' synthetic voice message) is activated at an appropriate margin from the stall condition" (L246921, L247299); none in normal law (α-max protection). FBW gate: not normal law, CAS > 60 kt, flight phase 5–7 (`PseudoFWC.ts` L3994–4005; FBW additionally requires both RA > 1500 ft or invalid — looks like an FBW artefact). FAC α_SW table (FBW `alphastallwarn`, Mach × config): CONF 0 6.5° (M ≤ 0.5) → 4.6° (M ≥ 0.9); CONF 1/1+F 11.7°; CONF 2 11.9°; CONF 3 11.0°; FULL 10.6°. | H (FCOM) / L (angles) |
| **SPEED SPEED SPEED** | FWC voice ×1 phrase, **every 5 s** | FCOM (L224159): CONF 2, 3, FULL; inhibited when TOGA selected, RA < 100 ft or > 2000 ft, alpha-floor, GPWS alert, alternate/direct law, both RA failed; triggers before α-floor. FAC logic (FBW `FacComputer.cpp` L1083–1094, params via `FacComputer_data.cpp`): (energy-predicted α > threshold **and** CAS < VLS) **or** CAS < VLS − 10 kt; config ≥ CONF 2; 100 < RA < 2000 ft; not A/THR ALPHA FLOOR (ATS word bit 23), not pitch T/O mode, not
within 8 s of pitch G/A mode; ELAC normal law; confirmed 0.5 s, held ≥ 3 s. FWC (FBW `FwsAutoCallouts.ts` L347–359): FWC phases 5/6/7, no GPWS alert; re-trigger lockout 6 s after each emission (FCOM says 5 s). | H |
| **A/THR OFF** (involuntary / standard) | **single chime** + MASTER CAUT | FCOM L216975: standard disconnection → AUTO FLT A/THR OFF (≤ 9 s), MASTER CAUT (≤ 3 s), single chime; non-standard → same until instinctive pb / MASTER CAUT / A/THR re-armed. No alert below 50 ft RA when levers set to idle. | H |
| **FUEL L(R) WING TK LO LVL** | single chime (level 2) | FCOM L254572: "When fuel quantity in one wing tank goes below **750 kg (1 650 lb)**, the low-level sensor triggers the LO LVL warning". FBW: < 750 kg confirmed **30 s**; L+R version if both. | H |
| **ENG DUAL FAILURE**, ENG/APU FIRE, EXCESS CAB ALT | CRC | FBW EWD list (level 3, default aural CRC) | H code |
| **FLAP LVR NOT ZERO** | CRC | FBW: pressure alt ≥ 22 000 ft, phase 6, flap lever not 0 | H code |
| A/P OFF | cavalry charge | FCOM L205738: take-over pb 1st push → cavalry at **low volume** until 2nd push; if not pushed quickly → high volume + AUTO FLT AP OFF; automatic disconnect → high volume, cancelled by MASTER WARN or take-over pb | H |

Other level-2 (SC) items in FBW that are easy to simulate: GEN 1/2 FAULT, HYD reservoir overheat, ICE DETECTED,
SPD BRK STILL OUT, GND SPLR NOT ARMED, BRAKES PARK BRK ON, GEAR NOT UPLOCKED, RA 1/2 FAULT, ALTN/DIRECT LAW.

### A5. Waveform specs

* **Cavalry charge (H, PR364 diagram):** A = 1660 Hz square, B = 830 Hz square; A-B-A-B-A in 40 ms slices (200 ms
  burst), 200 ms OFF, repeat. FCOM: 1.5 s for a take-over-pb disconnect.
* **Durations (H, FCOM table):** single chime 0.5 s; triple click 0.5 s (3 pulses); C-chord 1.5 s (approach) or
  continuous; cavalry 1.5 s or continuous; CRC, cricket continuous; PRIORITY L/R 1 s; cabin call 3 s; emer cabin call
  3 s × 3; FBW sample lengths (from their real-sound set): SC 0.54 s, triple click 0.62 s, cavalry 1 s,
  PITCH 0.48 s, SPEED 0.56 s ×3, MINIMUM 0.67 s, HUNDRED ABOVE 0.72 s, RETARD 0.72 s, "TWO THOUSAND FIVE HUNDRED"
  1.1–1.33 s, "TWENTY FIVE HUNDRED" 1.05 s.
* **CRC, single chime, C-chord, cricket frequencies/cadence: not found** in any public source (A320-family and FBW
  issues/PRs, FBW docs, FCOM text). The Airbus document that holds the cavalry table presumably holds these too, but
  no public scan was found. The FlightGear A320-family CRC/chime are 1 kHz synthetic beeps (wave 6), not a spec.

---

## B. Boeing 737-800 (NG)

Paraphrased notes with section, page and line references: `notes_737_egpws.md` (Boeing FCOM D6-27370-TBC Rev 26, Honeywell MK V/VII & MK VI/VIII
pilot guides, FlightGear mk_viii.cxx). Key points:

### B1. Boeing aural warning system (H: FCOM 15.20)
* **Master list (FCOM 15.20.1):** clacker = airspeed limits; warning tone = A/P disconnect; **intermittent horn** =
  takeoff configuration **and** cabin altitude (same tone); **steady horn** = landing gear; **fire bell**; voice =
  GPWS / windshear. "Generally, aurals automatically silence when the associated non-normal condition no longer
  exists." **No master-caution aural** (H by omission; MASTER CAUTION is lights only).
* **Gear horn (steady), "whenever a landing is attempted and any gear is not down and locked":**
  flaps UP–10: RA < 800 ft and either thrust lever between idle and ≈ 20° TLA (or one engine inop and the other
  < 34°) → HORN CUTOUT can silence it, **but not below 200 ft RA**; flaps 15–25: either lever < ≈ 20° → cannot be
  silenced; flaps > 25: any thrust → cannot be silenced. Cancelled when the configuration is corrected.
* **Takeoff config (intermittent):** on the ground with either thrust lever advanced for takeoff (PSEU ≈ TLA > 53°,
  b737.org.uk, M) and any of: TE flaps not 1–25 (or skew/asymmetry/uncommanded motion), LE devices not in takeoff
  config, speed brake lever not DOWN (or spoiler valve open), parking brake set, stabilizer trim outside green band.
  No rudder-trim input on the NG. No cutout; stops when corrected or levers retarded.
* **Cabin altitude (intermittent, same tone):** cabin > 10 000 ft; silenced by ALT HORN CUTOUT.
* **Altitude alert:** "momentary tone" at **900 ft** before the selected altitude, and on a **300 ft** deviation
  (amber flashing until deviation < 300 or > 900 ft, or new altitude). **Inhibited when TE flaps ≥ 25 or G/S
  captured.** Tone pitch/length: not found (≈ 1 s single tone is an assumption).
* **A/P disconnect wailer:** "sounds for a minimum of two seconds"; second push of the disengage switch (or pushing
  the red A/P disengage light) silences it; after an automatic disengage it continues until reset. **A/T disconnect:
  flashing lights only, no aural.**
* **Overspeed clacker:** Vmo/Mmo only; "can be silenced only by reducing airspeed below Vmo/Mmo".
* **Stick shaker:** both columns, armed in flight only (SMYD). Onset AoA: not found.
* **Fire bell:** engine, APU, wheel-well, cargo fire (not engine overheat); BELL CUTOUT or FIRE WARN light push.
* **Flight-deck chime:** only a "single high-tone chime" for cabin/ground calls (no hi-lo in the flight deck).
* **Reactive windshear (GPWS):** "Two-tone siren followed by WINDSHEAR" (×3), once per event, below 1500 ft RA,
  from rotation. Predictive (radar): "WINDSHEAR AHEAD", "GO AROUND, WINDSHEAR AHEAD", "MONITOR RADAR DISPLAY".

### B2. EGPWS (Honeywell MK V on the 737NG)
* **Wording:** Boeing uses plain **"PULL UP"** (no "WHOOP WHOOP"; MK V: "may be preceded by 'Whoop, Whoop' in some
  configurations"). Look-ahead: "TERRAIN TERRAIN PULL UP" (PULL UP then continuous), "CAUTION TERRAIN" (every 7 s).
* **Mode 1:** "SINK RATE, SINK RATE" (0.75 s gap) on the outer boundary — 964 fpm at 10 ft → 5 008 fpm at 2 450 ft
  (FG: RA < −572 − 0.6035·VS); repeated for each 20 % worsening of time-to-impact; inner boundary "PULL UP"
  continuous — 1 464 fpm at 10 ft, 1 710 fpm at 284 ft, 7 125 fpm at 2 450 ft. (FBW Rust uses the same curves:
  alert −964→−5007 fpm for 10→2450 ft; warning −1482/−1710/−7125 fpm; sink-rate confirm 0.8 s, pull-up 1.6 s.)
* **Mode 2:** "TERRAIN, TERRAIN" then "PULL UP" continuous; after leaving the warning envelope "TERRAIN" while
  closure continues. 2A upper limit 1650 ft (≤ 220 kt) → 2450 ft (≥ 310 kt) on MK V; 2B (landing flaps, ILS within
  2 dots, or first 60 s after takeoff) up to 789 ft; gear + flaps in landing config → "TERRAIN" only.
* **Mode 3:** "DON'T SINK, DON'T SINK" when altitude loss > 5.4 + 0.092·RA (8 ft at 30 ft … 143 ft at 1500 ft),
  RA 30–1500 ft after takeoff/go-around; repeated per further 20 %.
* **Mode 4:** 4A (gear up) "TOO LOW GEAR" below **500 ft < 190 kt**; "TOO LOW TERRAIN" above 190 kt, ramp 500 ft @
  190 kt → 1000 ft @ 250 kt. 4B (gear down, flaps not landing) "TOO LOW FLAPS" below **245 ft < 159 kt**; "TOO LOW
  TERRAIN" ramp 245 ft @ 159 kt → 1000 ft @ 250 kt. 4C (takeoff): 75 % of RA filter → "TOO LOW TERRAIN". Repeats per
  20 %. Same numbers in FBW Rust (`MODE_4_A/B_ALERT_AREA`).
* **Mode 5:** soft "GLIDESLOPE" (half volume, −6 dB) at ≥ 1.3 dots below 1000 ft (500 ft when not descending), faster
  as deviation grows 20 %; hard "GLIDESLOPE, GLIDESLOPE" at ≥ 2 dots below 300 ft **every 3 s**.
* **Mode 6 (737 FCOM):** callouts TWENTY FIVE HUNDRED (RA), ONE THOUSAND and FIVE HUNDRED (**baro above field**), ONE
  HUNDRED, FIFTY, FORTY, THIRTY, TWENTY, TEN (RA); "PLUS HUNDRED" at DH/MDA+100; "MINIMUMS" at DH/MDA (options:
  400/300/200, APPROACHING MINIMUMS at DH+80, "MINIMUMS, MINIMUMS"). Each callout **once per approach**, only when
  crossing downward; skipped if already > 20 ft (> 10 ft below 150 ft) past it or within ±30 ft of DH (MINIMUMS wins);
  **re-armed only when RA > 1000 ft outside takeoff mode** (FG). **"BANK ANGLE, BANK ANGLE"** at **35°, 40°, 45°**,
  each once, all reset when bank ≤ 30° (737 FCOM = Honeywell option 1). "SMART 500" = add FIVE HUNDRED only on
  non-precision approaches (G/S > 2 dots or back-course).
* **Priority (MK V):** windshear > PULL UP > TERRAIN TERRAIN > TERRAIN TERRAIN PULL UP > OBSTACLE PULL UP > TERRAIN >
  MINIMUMS > CAUTION TERRAIN > TOO LOW TERRAIN > altitude callouts > TOO LOW GEAR > TOO LOW FLAPS > SINK RATE > DON'T
  SINK > GLIDESLOPE > APPROACHING MINIMUMS > BANK ANGLE > … > TCAS.

(The same Honeywell envelopes apply to the A320's EGPWS — FBW Rust `egpws/runtime.rs` L179–204 — except the A320 has
no Mode 6: its height callouts and minimums come from the FWC.)

---

## C. F-16C (Block 50/52)

### C1.
**VMS vocabulary (H, Dash1-368 images of GR1F-16CJ-1 + TO1F16A L24785–25130, identical text):** "WARNING-WARNING
pause WARNING-WARNING" **1.5 s after illumination of any glareshield-mounted warning light**; "CAUTION-CAUTION"
**7 s after any caution-panel light except IFF** (not heard if MASTER CAUTION is reset immediately); reset by WARN
RESET (ICP) / MASTER CAUTION / condition gone. Discrete: ALTITUDE-ALTITUDE, BINGO-BINGO, IFF (ground test only),
JAMMER, LOCK-LOCK, PULLUP-PULLUP-PULLUP-PULLUP (ATF/TF fly-up, TF failure, GAAF), COUNTER, CHAFF-FLARE, LOW, OUT,
LOCK (ground test only), DATA. Priority PULLUP > ALTITUDE > WARNING > JAMMER > COUNTER > CHAFF-FLARE > LOW > OUT >
LOCK > CAUTION > BINGO > DATA > IFF. "All voice messages have priority over the low speed warning tone and LG warning
horn." "**The VMS does not function with WOW**" (test via MAL & IND LTS: each word once). Fixed volume, does not blank
other audio. VOICE MESSAGE/INHIBIT switch aft of the stick. → **No "LANDING GEAR", "LOW SPEED", "OVER G" voices.**
(MLU/M-tapes add EWMS "MISSILE" etc. — see wave 6.)

**Glareshield warning lights → "WARNING WARNING"** (Block 50 right eyebrow per NVC `eyebrow_right.xml`: ENG FIRE,
ENGINE, HYD/OIL PRESS, FLCS, DBU ON, TO/LDG CONFIG, CANOPY; left eyebrow: TF FAIL; OXY LOW is a caution-panel light
in NVC) (M for the Block 50 layout). Conditions (TO1F16A = F-16A Blocks 10/15, PW220; **H for that manual**, M for the
Block 50):
* **ENGINE** (TO1F16A L12710): "illuminates when RPM and FTIT … indicate … overtemperature, flameout, or stagnation …
  rpm decreases to subidle (**below 55 percent**), when engine stagnates, or approximately **2 seconds after FTIT
  exceeds 1000 °C**", also alternator failure. (F110 Block 50 thresholds may differ: not found.)
* **HYD/OIL PRESS** (L12684): oil pressure < ≈ 10 psi **for 30 s** (out above ≈ 20 psi), or **hydraulic system A or B
  < 1000 psi** (out when both > 1000). (NVC uses < 2000 psi — do not copy.)
* **TO/LDG CONFIG** (L20086–20105): in flight when **pressure altitude < 10 000 ft, airspeed < 190 kt, rate of descent
  > 250 fpm**, and either TEFs not full down **or** NLG/either MLG not down and locked (the latter accompanied by the LG
  horn); on the ground if TEFs not full down.
* **CANOPY:** canopy not closed/locked (NVC: canopy position > 0) (M; exact TO text not located in OCR).
* **FLCS / DBU ON / ENG FIRE / TF FAIL:** FLCS failure (fail list class 0 in NVC), digital backup engaged, fire
  detection, TF failure (M).

**Caution lights → "CAUTION CAUTION"** (TO1F16A L15182–15207, H): **FWD FUEL LOW** when the forward reservoir < **400
lb** (other config 250), **AFT FUEL LOW** when the aft reservoir < **250 lb** (other config 400) — independent of the
fuel gauges. NVC caution list: STORES CONFIG, SEAT NOT ARMED, OXY LOW (< 0.5 l or < 42 psi), LE FLAPS, HOOK, FWD/AFT
FUEL LOW (400/250 lb), ELEC SYS, CABIN PRESS (cabin > 27 000 ft), ADC, EQUIP HOT, OVERHEAT, SEC, AVIONICS FAULT, ENGINE
FAULT, FLCS FAULT (NVC `failures.nas` L537–553, M).

**ALTITUDE-ALTITUDE:** (Dash-1, H) descent after takeoff; radar altitude below the CARA ALOW; baro altitude below the
MSL floor. TO1F16A (L41285–41300, H): "Nuisance ALOW warnings may occur at **LG retraction** or during intermediate
level offs until above the entered ALOW value"; "If the RDR ALT switch is not in RDR ALT, the ALTITUDE voice message
is not available for descent warning after takeoff or AGL ALOW" → radar-altimeter based, armed with the gear
retracted. NVC model: plays (looped) when gear fully up, RA < CARA ALOW, CARA on, not WOW; inhibited after takeoff
until the aircraft has climbed above ALOW, re-inhibited when the gear is lowered (`f16.nas` L990–1000,
`f16-sound.xml` L3909–3940); MSL floor: once when crossing (default 18 000 ft). **Defaults in NVC: CARA ALOW 500 ft,
BINGO 1500 lb** (`f16-base.xml` L1268–1270) — real-aircraft defaults not found (L).
**BINGO-BINGO** (TO1F16A L15229, H): "when the entered bingo fuel value is reached"; bingo compares with the lesser of
fuselage fuel or total fuel (FUEL QTY SEL NORM). Once (NVC: once, then latched until reset).

**LG warning horn (H, TO1F16A L20055–20070):** "an **intermittent** fixed volume signal … in the headset when the NLG
or MLG is not down and locked and all: airspeed < **190 kt**, pressure altitude < **10 000 ft**, rate of descent >
**250 fpm**." HORN SILENCER button silences it until the condition clears.
**Tone spec (H): DTIC AD-A145469** (Doll/Folds et al., "Auditory Information Systems in Military Aircraft: Current
Configurations Versus the State of the Art", June 1984; archive.org `DTIC_ADA145469`, Table 5 "Auditory signals in
the F-16, production Block 10", PDF p. 40 — read from the page image, `dl/ada_pages/t5zoom.png`): "Landing gear —
Landing gear or trailing edge flap not down when airspeed is less than **170 kts** [1984; the 2003 manual says 190],
altitude is less than 10,000 ft, and descent rate is greater than 250 ft per minute — Tone — **250 ± 50 Hz,
repetition rate 5.0 ± 1.0 Hz** — Silencer, no volume control — Headset." Table 9 gives the same (250 ± 50 Hz,
5 ± 1 Hz) for Blocks 01/05/10. → The NVC implementation (250 Hz square "in 1 Hz intervals", `f16-sound.xml` L4213,
1.5 s delay) **misquotes the interruption rate; use ≈ 5 pulses/s** (≈ 100 ms on / 100 ms off). Waveform (square vs
other) not stated (NVC square = assumption).

**Low speed warning tone (H, TO1F16A L23526–23555):** "(steady) … when either: AOA is **15 degrees or greater with LG
handle down or ALT FLAPS in EXTEND**; combined airspeed and pitch angle fall within the tone-on area (fig. 1-49) with
LG handle up and ALT FLAPS in NORM." Priority over the LG horn; HORN SILENCER silences it until the condition clears.
AD-A145469 Table 5 (H, Block 10): "Low Speed — AOA ≥ 15° while landing gear down or flaps extended — **250 ± 50 Hz
steady** — Silencer — has priority over landing gear tone"; "Low Speed/High Attitude Warning — airspeed is too low for
current attitude while landing gear is up — 250 ± 50 Hz steady — applicable only when **pitch is between 45° and 90°.
Airspeed is too low if less than (pitch) × 2.22**" (i.e. 100 kt at 45°, 200 kt at 90°). NVC uses a different schedule
(75→183 kt on, 137→217 kt off, from Dash-1 fig. 1-95) — the 1984 formula is the sourced one. This is a
**nose-high low-speed** warning, not a generic stall horn. The early 800 Hz AOA tones (Blocks 01/05: AOA 12–18°
interrupted 1–10 Hz, > 18° steady; 800 Hz also for low altitude) were omitted from Block 10 onward (AD-A145469
p. 53 of the report); no AOA tone for later blocks was found (M). NVC still plays 800 Hz AOA tones in CAT III gear-up
(source "forgot") — do not copy for a Block 50.

---

## D. F-22A

### D1. ICAWS aural vocabulary — **no public word list or tone spec found** (details: `notes_f22_uh60.md`)
What primary sources do establish (H unless noted):
* ICAW = "Integrated Caution, Advisory and Warning" (SAB-TR-11-04 glossary; DoD IG writes "Indications, Cautions,
  and Warnings"): "Up to 12 ICAW messages can be displayed at the same time. An ICAW warning to the pilot may be
  evidenced by an **aural or visual indication or both**." (USAF SAB "Aircraft Oxygen Generation", 2012, DTIC
  ADA567568.) OBOGS FAIL asserts after O2 < warning band for 12 s.
* **Cautions have an aural tone:** "the CABIN PRESSURE caution ICAW **aural tone** at 18,500 feet and the AIR COOLING
  caution ICAW aural tone at 13,000 feet … The F-22 pilot immediately ceased manipulating the EOS ring, upon hearing the
  aural tone" (DoD IG DODIG-2013-041, pp. 8–9, on the 16 Nov 2010 JBER mishap). AIB 2nd addendum: "C BLEED HOT caution
  ICAW asserted (a visual and audible cue to the MP)" and "'CAUT' was displayed in the HUD". Caution sequence that
  night: C BLEED HOT → OBOGS FAIL → CABIN PRESS → AIR COOLING (60 s after C BLEED HOT). → Model a **caution = tone +
  "CAUT" in HUD**, not a spoken "CAUTION CAUTION" (M: the sources call it a tone, never a voice).
* **Warnings go to the headset:** "Warning messages are also presented on the HUD and through the pilot headset"
  (AGARD AR-349, 1996, DTIC ADA310523, F-22 sheet; M-H, pre-production). CNI includes an intercom subsystem "for voice
  communication and **synthesis**" (Avionics Handbook ch. 32, USAF author) → synthesized voice exists (M), words
  unknown.
* **Low Altitude Warning System (LAWS):** pilot-set, **off by default**; "an alert would not sound unless the MP
  activated the system" (2010 AIB 2nd addendum pp. 17–18). Wording not given.
* ICAW names seen: C BLEED HOT, OBOGS FAIL, CABIN PRESS, AIR COOLING, SES LOW, flight-control-system ICAWs.
* **Not found:** any quoted F-22 phrase ("PULL UP", "ALTITUDE", "WARNING", "BLEED AIR", "OVER G", "BINGO"), tone
  frequencies, voice gender. Searched: 2009 Edwards AIB (full), 2004/2007 Nellis and 2009 Tyndall executive summaries,
  2020 Nellis AIB, archive.org full text, GitHub. The original 2010 JBER full AIB is 404 in Wayback; 2012 Tyndall /
  2020 Eglin AIBs not found.
* Precedent only (not F-22): the F-15 over-G warning system gives a 900 Hz tone interrupted 4 Hz at 85 % of the g
  limit, 10 Hz at 92 %, and a voice "**OVER G, OVER G**" at 100 % (AD-A145469 bibliography note, citing AW&ST 1983).
  So an "OVER G" voice is plausible for a US fighter but **unverified for the F-22** (L).
* Recommendation: keep F-22 voices generic and few (warning voice + caution tone + PULL UP/ALTITUDE from the GCAS/LAWS
  family is an assumption, L); do not claim authenticity.

## E. UH-60M

### E1. (details and quotes: `notes_f22_uh60.md`)
**UH-60M (CAAS):** the operator's manual TM 1-1520-280-10 is Distribution D — **no public voice/tone list found**.
Evidence that exists:
* **Radar-altimeter low-bug audio exists on the UH-60M:** "Low bug audio on radar ALT enhanced situation awareness
  greatly" (ARL human-factors assessment of the UH-60M LUT, Feb 2006, DTIC ADA444913 p. 58) (M: crew comment; sound/
  wording not given). → a low-altitude aural (tone or voice) is justified for the M; "ALTITUDE ALTITUDE" wording is
  not verified.
* Generic H-60 ATM (TC 3-04.33, 2012, covers UH-60M): "engine out audio", "stabilator audio tone", "Low rotor RPM
  audio" — tones, no voice vocabulary (H for existence).
* **Closest public voice vocabulary — MH-60K VWS** (TM 1-1520-250-10, 1994, archive.org; H as MH-60K, L–M as a
  UH-60M stand-in): priority 1 = **2 s intermittent 250 Hz tone**, 0.5 s gap, message, 1 s, message, 1 s;
  priority 2 = **2 s continuous 250 Hz tone** then message ×2; priorities 3–10 = message ×3; repeated until
  acknowledged (MASTER CAUTION reset or cyclic VOICE ACK). Messages: STABILATOR (1), ENGINE 1 OUT / ENGINE 2 OUT (2,
  Ng ≤ 55 %), LOW ROTOR (2, NR ≤ 95–96 %), TERRAIN AHEAD (3), ALTITUDE LOW (4, below RALT SET), CW RADAR LOCK (7), CW
  RADAR JAMMING (8), PULSE JAMMING FORWARD/AFT (9), BING BONG (12). "if NR drops below 96% or NG drops below 55%, a
  **low frequency tone** will precede voice messages"; low-rotor audio/VWS inhibited on the ground by the WOW switch;
  engine-out audio not inhibited.

**UH-60A/L (TM 1-1520-237-10; H):**
* 1988 para 2-217 / 1996 (Change 6, 2000) para 2.81: LOW ROTOR RPM light flashes 3–5 /s below **95 %** (1988) /
  **96 %** (from 2000) NR; "if % RPM R drops below 95% [96%] or Ng drops below 55%, **a low steady tone** is provided.
  The low rotor rpm tone is inhibited on the ground through the left landing gear weight-on-wheels switch. The engine
  Ng steady tone is not inhibited. The ENG OUT warning lights and tone will go on at 55% Ng SPEED and below." No
  frequency, no warble. Field reports call it the "low rotor rpm audio horn".
* **No high-rotor-RPM light or tone; no fire tone; no master-caution tone** (FIRE = lights/T-handles).
* **Stabilator:** automatic-mode failure → STABILATOR caution + MASTER CAUTION + "**a beeping tone** will be heard in
  the pilot's and copilot's headphones", silenced by MASTER CAUTION reset (1988 para 2-112, 1996 para 2.38.1). Rate/
  frequency not given (MH-60K priority-1 pattern suggests an intermittent 250 Hz tone, L).
* **Radar altimeter AN/APN-209:** LO light only, **no audio** (through Change 10, 2002).
* **No voice warnings** in the UH-60A/L TM through 2002.
