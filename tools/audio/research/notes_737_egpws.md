# 737-800 (NG) aural warnings and EGPWS: research notes

The manuals are copyrighted; these notes paraphrase them and cite section, page or OCR line so the originals can be checked. No manual text is reproduced.

Compiled 2026-09-23 for the audio team. Confidence: **H** = stated in a primary source (paraphrased here), **M** = inferred or a secondary source, **L** = guess or not found.

## Sources (local copies in `research/dl/egpws/`)

| Tag | Document | URL | Local file |
|---|---|---|---|
| **FCOM** | Boeing *737-600/-700/-800/-900/-900ER Flight Crew Operations Manual*, D6-27370-TBC, Rev 26, 25 Mar 2010. This is Boeing's generic "TBC" demonstration FCOM and is marked "DO NOT USE FOR FLIGHT". | https://archive.org/download/boeing-fcom-ftcm-qrh-2010/_737-TBC_OM_TBC_C_100325_V1V2_B8P-C_djvu.txt (PDF in the same item) | `fcom_737TBC_2010_djvu.txt` (OCR text. "L####" below means a line number in this file.) |
| **MAXFCOM** | B737 MAX 8 FCOM (archive.org), used only as a cross-check | https://archive.org/download/b-737-max-8-fcom/B737%20MAX%208%20FCOM_djvu.txt | `fcom_737MAX8_djvu.txt` |
| **MKV** | Honeywell *MK V & MK VII EGPWS and RAAS Pilot Guide* 060-4241-000 Rev E, Dec 2003 | https://web.archive.org/web/20060311033930/http://www.egpws.com/engineering_support/documents/pilot_guides/060-4241-000.pdf | `060-4241-000.pdf/.txt` |
| **MKVIII** | Honeywell *MK VI & MK VIII EGPWS Pilot Guide* 060-4314-000 Rev C, May 2004 | https://web.archive.org/web/20060311034059/http://www.egpws.com/engineering_support/documents/pilot_guides/060-4314-000.pdf | `060-4314-000.pdf/.txt` |
| **FG** | FlightGear `src/Instrumentation/mk_viii.cxx` at pinned commit `5a08bcf7964ef0eda0bd9dc0137c9b0abbae5502` (2023-04-13) | https://github.com/FlightGear/flightgear/blob/5a08bcf7964ef0eda0bd9dc0137c9b0abbae5502/src/Instrumentation/mk_viii.cxx | `mk_viii.cxx`, `mk_viii.hxx`, `voiceplayer.hxx` |
| **B737UK** | b737.org.uk warningsystems.htm (cached text) | http://www.b737.org.uk/warningsystems.htm | `audio/web/warningsystems.txt` |

The FG file is an emulation written by J-Y Lefort from the Honeywell MK VI/VIII Pilot Guide ([PILOT]), the Product Spec 965-1180-601 ([SPEC]) and the Install Guide 060-4314-150 (FG L23-41). It is GPL code, described here in our own words.

b737.org.uk stopped resolving in DNS during this session, so gpws.htm and autoflight.htm could not be fetched. The cached warningsystems.txt was used instead.

---

## B1. Non-EGPWS aurals (737NG)

### Master list of aurals (H)

- Clacker: airspeed limit. Warning tone: autopilot disconnect. Intermittent horn: takeoff configuration and cabin altitude. Steady horn: landing gear. Bell: fire. Voice: ground proximity and windshear (FCOM 15.20.1, L129482-129487).
- Aurals normally stop by themselves once their condition clears (FCOM 15.20.2, L129497).
- External aurals: fire bell in the wheel well; ground-call horn in the nose wheel well for an E&E bay overheat or IRS on DC (B737UK).

### (a) Landing-gear configuration warning (steady horn)

**Main rule (H).** Steady horn when landing with any gear not down and locked; flaps and thrust levers decide when (FCOM 15.20.6, L129735-129768; MAX FCOM identical):

| Flaps | Horn sounds when | HORN CUTOUT |
|---|---|---|
| Up to 10 | RA < 800 ft, and either lever idle to about 20° TLA or one engine out with the other lever < 34° | Silences (resets) it, except below 200 ft RA |
| 15 to 25 | Either lever below about 20°, or one engine out with the other lever < 34° | No effect |
| > 25 | Any thrust lever position | No effect |

- Cancels when the configuration is corrected. One lever below about 20° TLA is enough; both need not be at idle. No RA gate at flaps 15 or more.
- HORN CUTOUT (H): works only at flaps up to 10 and above 200 ft RA (FCOM 15.10.6, L128734).
- Visual (H): red gear light when gear not down and locked, one or both levers at idle, below 800 ft AGL (FCOM 15.20.5).
- Real-world (M): the TK1951 RA fault from 1,950 ft to −8 ft triggered the gear warning horn repeatedly on approach (Wikipedia, Turkish Airlines Flight 1951), i.e. the flaps ≤10, RA<800 gate firing on a bad RA.
- Not found: the horn's frequency and timbre.

### (b) Takeoff configuration warning (intermittent horn)

**Conditions (H).** Armed on the ground once either thrust lever is advanced for takeoff. Horn if any of (FCOM 15.20.5, L129659-129679):
- trailing edge flaps outside 1-25, or skewed, asymmetric or moving uncommanded;
- leading edge devices not in takeoff position, or moving uncommanded;
- speed brake lever not DOWN;
- spoiler control valve open, pressurising the ground spoiler interlock valve;
- parking brake set;
- stabilizer trim outside the takeoff range.

- Rudder trim is not a condition on the NG (H: absent). The MAX adds only mid exit door and overwing door not secure (MAXFCOM L138650+).
- Stabilizer (H): the STAB TRIM green band is the takeoff range (FCOM 9.20, L85268).
- Light (H): red TAKEOFF CONFIG light with the horn; optional on older airframes (FCOM 15.10.3, L128586).
- Silencing (M): no cutout switch; stops when the configuration is fixed or the levers are retarded.
- "Advanced for takeoff" (M): B737UK gives PSEU TLA > 53°. The FCOM has no number.

### (c) Cabin altitude warning horn (intermittent) (H)

- Cabin altitude above 10,000 ft sounds the intermittent horn (FCOM 15.20.5, L129687-129694).
- A momentary push of ALT HORN CUTOUT (cabin altitude panel) silences it (L68114).
- It shares its intermittent tone with the takeoff configuration warning (FCOM WARNING note). Use the same sample.
- CABIN ALTITUDE light (L128600): red, on with the horn.

### (d) Altitude alert

**Rules (H)**, same for EFIS/MAP and PFD/ND options (FCOM 15.20.8-10, L129923-130066):
- Alerts when approaching or leaving the MCP altitude. Inhibited at trailing edge flaps 25 or more, or with G/S captured (either alone).
- Acquisition: momentary tone 900 ft before the selected altitude; its box disappears at 300 ft.
- Deviation: momentary tone at 300 ft off; the current altitude box flashes amber until deviation is below 300 ft, above 900 ft, or a new altitude is set.
- Tone (L): only "momentary tone". Pitch, length and "C-chord" not found; assume one short tone of about 1 s.

### (e) Autopilot and autothrottle disconnect

**A/P (H)** (switch: FCOM 4.10.20, L72538-72549; light: FCOM 4.10.21, L72601-72604):
- Intentional (switch push): both autopilots off, red A/P disengage lights flash, wailer for at least 2 s. A second push puts the lights out and silences it.
- Automatic: lights flash and the wailer plays until either disengage light or either disengage switch is pushed.

**A/T (H)** (FCOM 4.10.20-22, L72553-72560, L72638-72642, L73781):
- Switch: A/T off, the A/T ARM switch drops to OFF and the A/T disengage lights start flashing until a second press. No lights for the automatic disengage after touchdown.
- No A/T aural anywhere; the intro list names only the A/P tone (H by omission).
- The Aural Warning circuit breaker also feeds the A/P disconnect tone and cabin altitude horn (L5485).

### (f) Overspeed clacker (H)

- Two independent Mach/airspeed systems; clacker whenever Vmo/Mmo is exceeded, silenced only by slowing below it. ADIRU drives the aural warning module; ground test only (FCOM 15.20.7, L129811-129845).
- Vmo/Mmo only: no flap- or gear-placard clacker (H by omission). Test switches (L128696): clacker sounds; inhibited airborne.
- Loudness (B737UK): audible at Vmo (340 kt) at 10,000 ft.

### (g) Stick shaker (H)

- Two eccentric-weight motors, one per column; the warning shakes both columns. Always armed when airborne, off on the ground (FCOM 15.20.7-8, L129850-129880).
- Two SMYDs use AoA vanes, ADIRU, anti-ice, wing configuration, air/ground, thrust, FMC and Mach compensation. Either shaker moves both columns via the column interconnect.
- Onset AoA or speed: not found (L); SMYD computes it from configuration.
- Minimum maneuver speed (FCOM): 0.3 g margin (40° bank) to the shaker.

### (h) Fire bell (H)

- BELL CUTOUT push: both master FIRE WARN lights out, bell silenced, remote APU fire horn silenced (ground only), system reset for further warnings (FCOM 8.10, L82626-82635).
- Pushing either master FIRE WARN light does the same (FCOM 15.20.2).

What rings the bell (FCOM 8.20.1-5):

| Source | Bell? | Details (FCOM line) |
|---|---|---|
| Engine fire | Yes | Plus FIRE WARN lights and a lit engine fire switch (L83229) |
| APU fire | Yes | Plus a main wheel well horn, ground only. APU fire light flashes red (L83063). |
| Main wheel well fire | Yes | L83433 |
| Fwd/aft cargo fire | Yes | L83463 |
| Engine OVERHEAT | **No** | MASTER CAUTION and OVHT/DET only (L83205) |
| Lavatory smoke | Local only | Aural in the cabin, not the flight deck |

### (i) Master caution (H by omission)

- **No aural on the 737NG.** FCOM 15.20.2 covers MASTER CAUTION lights and recall only.
- The exhaustive aural list in (B1) has no caution chime; neither does B737UK's.

### (j) Chimes and windshear

**Call chimes (H)** (FCOM 5.20.4 table, L76452-76466, and 5.10.13):

| Call | Heard in | Sound |
|---|---|---|
| Attendant or ground crew (ext. power panel) to flight deck | Flight deck | Single high-tone chime, blue CALL light |
| PILOT or CAPTAIN call switch | Flight deck | Single-tone chime |
| Flight deck to attendants | Cabin | Two-tone chime (hi-lo, cabin only) |
| NO SMOKING / FASTEN BELT on or off | Cabin | Single low-tone chime |
| GRD CALL | Nose wheel well | Horn while the switch is held |

So the flight deck gets no hi-lo chime, only these call chimes (H).

**Reactive windshear (GPWS) (H):**
- Two-tone siren, then "WINDSHEAR"; enabled below 1,500 ft RA, detection from rotation (FCOM 15.20.19, L130722).
- MKV p.23: "WINDSHEAR" ×3 after the siren; repeats only for a separate new event. Priority 1 in B737UK's table.
- Sound design: siren then "WINDSHEAR" ×3, once per event. Not found (L): siren frequencies and duration.

**Predictive windshear (weather radar) (H)** (FCOM 15.20.21, L130770-130805):

| Aural | Level | When |
|---|---|---|
| "WINDSHEAR AHEAD" | Warning | Takeoff, below 1,200 ft RA |
| "GO AROUND, WINDSHEAR AHEAD" | Warning | Approach, within 1.5 NM |
| "MONITOR RADAR DISPLAY" | Caution | Within 3 NM |

- Inhibits: new cautions between 80 kt and 400 ft RA; new warnings between 100 kt and 50 ft RA.
- Predictive alerts are inhibited by reactive windshear, look-ahead terrain and RA-based alerts.

---

## B2. EGPWS on the 737NG (Honeywell MK V)

### What the Boeing FCOM says the crew hears (H)

**Style.** FCOM 15.20.12-13 (L130230-130275) never uses "WHOOP WHOOP"; in MKV p.7/p.37 that prefix is an audio-menu option (the Airbus/other menu). **Use plain "PULL UP" for the 737** (H/M).

**Look-ahead alerts (FCOM 15.20.12):**
- "TERRAIN TERRAIN PULL UP": warning, 20-30 s to impact; then "PULL UP" continuously (MKV).
- "CAUTION TERRAIN": caution, 40-60 s; every 7 s while the conflict is in the caution area (MKV). Named in the FCOM test text (L23480).
- "TOO LOW TERRAIN" (Terrain Clearance Floor, TCF): too low on RA while far from any airport.
- Obstacles: "OBSTACLE OBSTACLE PULL UP", "CAUTION OBSTACLE".

**Radio-altitude alerts (FCOM 15.20.13):**
- SINK RATE: excessive descent rate. PULL UP: after SINK RATE, or after TERRAIN with gear or flaps not landing. TERRAIN: excessive closure rate. DON'T SINK: altitude loss after takeoff or go-around.
- GLIDE SLOPE: volume and repeat rate rise with deviation; BELOW G/S P-INHIBIT cancels it below 1,000 ft RA.
- TOO LOW FLAPS / TOO LOW GEAR: FLAP INHIBIT / GEAR INHIBIT switches. TOO LOW TERRAIN: high-speed Mode 4, and after DON'T SINK on a second descent (see Mode 3).
- PULL UP light for all except glide slope (BELOW G/S light). A windshear warning inhibits all terrain alerts.
- Mode 1 needs at least one "SINK RATE" before "PULL UP" (MKV/FG; FG L2999-3005, [SPEC] 6.2.1).

### Aural priority (MKV p.37, H; B737UK table matches)

Highest first: 1 Windshear; 2 Pull Up; 3 Terrain, Terrain; 4 Terrain Terrain Pull Up (TA); 5 Obstacle Pull Up; 6 Terrain; 7 Minimums; 8 Caution Terrain / Caution Obstacle; 9 Too Low Terrain; 10 Altitude callouts; 11 Too Low Gear; 12 Too Low Flaps; 13 Sink Rate; 14 Don't Sink; 15 Glideslope; 16 Approaching Minimums; 17 Bank Angle; 18 Caution Windshear; 19 RAAS.

- A higher message starts first or immediately cuts off a lower one already playing (MKV p.37).
- B737UK's 24-row table puts V1 callout (option), "MONITOR RADAR DISPLAY" and TCAS TA/RA below Bank Angle.

**FG AlertHandler order** (FG L2624-2805): 1 Mode 1 PULL UP (SINK RATE first unless already playing, then PULL UP looped); 2 Mode 2 preface TERRAIN, TERRAIN; 3 Mode 2 PULL UP looped; 4 altitude-gain / Mode 2B landing, TERRAIN looped; 5 MINIMUMS; 6 MINIMUMS_100; 7 RETARD; 8 Mode 4 / TCF (TOO LOW TERRAIN); 9 altitude callout; 10 TOO LOW GEAR; 11 TOO LOW FLAPS; 12 SINK RATE; 13 DON'T SINK; 14 glideslope (hard, then soft); 15 bank angle.

### Voice construction in FG (FG L2156-2192)

- `STDPAUSE` = 0.75 s ([SPEC] 6.4.4 standard delay). Pairs with that gap: "sink-rate", "terrain", "dont-sink". "minimums""minimums" has no pause.
- Hard glideslope: "glideslope""glideslope" + 3.0 s silence, looped (about one pair every 3 s, as in MKV).
- Soft glideslope: one "glideslope" at −6 dB (MKV: half volume).
- "bank-angle" 0.75 s "bank-angle" at RA ≥ 210 ft; no pause below 210 ft.
- Mode 6 low-volume discrete: −6 dB (L1518). Global output level 0/−6/−12/−18/−24 dB (L783-812).

### Mode 1: excessive descent rate

**MKV p.7 (H):**
- Outer boundary: caution lights, "SINKRATE, SINKRATE", again for each further 20% altitude degradation.
- Inner boundary: warning lights, "PULL UP" continuously until exit.
- Glideslope bias: less sensitive when above the glideslope.

**FG numbers.** Types 254/255 use `m1_t1` (L453: min RA 10 ft, breakpoint 284 ft, max 2,450 ft; formulas L377-378). vs = baro rate in fpm, negative descending.

| Boundary | Formula | Values |
|---|---|---|
| Sink rate (outer), L3044-3053 | 10 < RA < 2450 and RA < −572 − 0.6035·vs | 964 fpm at 10 ft → 5,008 fpm at 2,450 ft |
| Pull up (inner), RA 10-284 ft | RA < −1620 − 1.1133·vs | 1,464 fpm at 10 ft → 1,710 fpm at 284 ft |
| Pull up (inner), RA 284-2450 ft | RA < −400 − 0.4·vs | 1,710 fpm at 284 ft → 7,125 fpm at 2,450 ft |

These match the classic Honeywell air-transport figures (about 1,000/5,000 and 1,710/7,125 fpm).

**FG timing:**
- Sink-rate debounce 0.8 s (L3078). Repeat when time-to-impact falls to ≤80% of the stored value, i.e. 20% degradation (L3069).
- Pull up needs "SINK RATE" playing, or a 0.2 s delay (L3004).
- Bias: up to +300 fpm above the G/S, −150·dots, scaled below 100 ft (L3016-3041). Steep approach adds +500 (bizjet only, not relevant).

**Confidence:** H for FG code; M that the 737 MK V uses exactly these (same curves; the MKV graph has the same shape).

### Mode 2: excessive terrain closure

**MKV pp.8-11 (H):**
- 2A (flaps not landing, not on G/S): "TERRAIN, TERRAIN", then "PULL UP" continuously while in the warning envelope. After exit, "TERRAIN" while clearance still decreases; the light stays until +300 ft baro, 45 s, or landing flaps / flap override.
- 2A boundary grows from 220 to 310 kt (MK V). With TAD on software -210-210 and later, 2A upper limit 1250 ft (950 ft on -218-218).
- 2B: landing flaps, ILS with G/S and LOC < 2 dots, or first 60 s after takeoff. With gear and flaps landing, "PULL UP" is suppressed and "TERRAIN" repeats until exit.

**FG numbers (L3196-3262):**

| Mode | Condition | Values |
|---|---|---|
| 2A, RA < 1220 | RA < −1579 + 0.7895·closure | About 2,000 fpm closure at 0 ft, 3,545 fpm at 1,220 ft |
| 2A, RA ≥ 1220 | RA < 522 + 0.1968·closure, up to an upper limit | 1,650 ft at ≤190 kt to 2,450 ft at ≥280 kt, `1650 + 8.9·(IAS−190)` (type 254/255 `m2_t1`, 190/280 kt, L457) |
| 2B | RA < 789 ft, same closure line | Lower limit 30 ft (flaps up). Flaps down: 200 ft if descending < 400 fpm, 600 ft if > 1,000 fpm, linear between (L3243-3255) |

- FG timing: "TERRAIN, TERRAIN", then voice idle +1 s, then "PULL UP" looped (L3268-3285). Altitude-gain phase arms only if 2A lasted >3 s (L3335); ends at +300 ft, 45 s, or flaps down (L3307-3316).

**Confidence:** H (code), M (737 values).

### Mode 3: altitude loss after takeoff or go-around

**MKV p.11-12 (H):**
- Active after takeoff, or a go-around below 245 ft AGL or 150 ft (by aircraft type), while gear or flaps are not set for landing.
- "DON'T SINK" is said twice, and twice more at every further 20% altitude loss; lights and voice stop once climbing.

**FCOM (H):** "TOO LOW TERRAIN" follows "DON'T SINK" if a new descent starts before regaining the altitude where the first began.

**FG numbers.** `m3_t1` (L382-383, L461):
- Active band RA 30-1,500 ft.
- Allowed loss `5.4 + 0.092·RA` ft: 8 ft at 30 ft RA, 143 ft at 1,500 ft RA.
- Repeats each further 20% (bias += 0.2, L3440-3456). No repeats below 30 ft.

**Takeoff-mode state** (FG L2876-2911) gates Mode 3 and 4C. Entered on the ground, or on a go-around when RA < Mode 4B min (245 ft) with flaps and gear down. Exited when terrain clearance exceeds the Mode 4A upper limit (500-1,000 ft by speed).

**Confidence:** H (code), M (737 applicability).

### Mode 4: unsafe terrain clearance

**MKV pp.12-15 (H):**

| Sub-mode | Condition | Voice |
|---|---|---|
| 4A (gear up) | < 1000 ft AGL, > 190 kt; 500 ft at 190 kt ramping to 1000 ft at 250 kt | TOO LOW TERRAIN |
| 4A | < 500 ft AGL, < 190 kt | TOO LOW GEAR |
| 4B (gear down, flaps not landing) | < 1000 ft AGL, > 159 kt; 245 ft at 159 kt ramping to 1000 ft at 250 kt | TOO LOW TERRAIN |
| 4B | < 245 ft AGL, < 159 kt | TOO LOW FLAPS |
| 4C (takeoff) | Below MTC = 75% of RA averaged over the previous 15 s; max 500 ft AGL below 190 kt, rising linearly from 190 kt to 1000 ft at 250 kt | TOO LOW TERRAIN |

- 4A/4B repeat for each 20% degradation in altitude. Above 250 kt the ceiling falls from 1,000 to 800 ft when RA jumps suddenly (aircraft overflight).

**FG numbers.** `m4_t1_ac`: 190-250 kt, 500 ft floor, ramp `−1083+8.333·IAS`, 1000 ft cap. `m4_t1_b`: 159-250 kt, 245 ft floor, same ramp and cap (L466-478, L377-395). Both match MKV exactly.
- 4A/B inactive in takeoff mode and below 30 ft RA. Repeats each further 20% (L3583-3618).
- 4B if gear down OR flaps down (L3572-3580). 4B at 150/170 ft and 148/150 kt are turboprop or MK VIII variants (types 0-4).

**737 inhibit switches (FCOM):** FLAP INHIBIT, GEAR INHIBIT and TERRAIN INHIBIT.

**Confidence:** H.

### Mode 5: below glideslope

**MKV pp.16-17 (H):**
- Soft: below 1000 ft RA, ≥ 1.3 dots low. "GLIDESLOPE" at half volume; each further 20% deviation adds one, progressively faster.
- Hard: below 300 ft RA, ≥ 2 dots. Louder "GLIDESLOPE, GLIDESLOPE" every 3 s until out of the hard envelope.
- Armed only with gear down, localizer < 2 dots, no G/S cancel, and a front course. Upper limit 1,000 ft if descending > 500 fpm, down to 500 ft when slower. Both levels desensitised below 150 ft.
- G/S cancel clears itself below 30 ft or above 2,000 ft AGL (1000 ft AGL on current Boeing production aircraft).

**FG numbers (L3719-3862):**

| Level | Condition | Below 150 ft |
|---|---|---|
| Soft | dev > 1.3 dots, RA 30 to upper limit. Upper limit 1,000 if descending > 500 fpm, 500 if level or climbing, `500 − vs` between. | RA > 243 − 71.43·dots: 1.3 dots at 150 ft, about 3 dots at 30 ft |
| Hard | RA 30-300 ft, dev > 2 dots | RA > 293 − 71.43·dots |

- Debounce 0.8 s for both levels. Soft re-trigger every further 1.3 × 20% dots.
- Boeing writes "GLIDE SLOPE" (two words).

**Confidence:** H.

### Mode 6: altitude callouts, minimums, bank angle

#### 737NG callouts (FCOM 15.20.23, L130900-130950, "[Option - Typical]") (H)

- RA-based: 2,500 ft TWENTY FIVE HUNDRED; 100 ft ONE HUNDRED; 50, 40, 30, 20, 10 ft: FIFTY, FORTY, THIRTY, TWENTY, TEN.
- Baro above landing field elevation: 1,000 ft ONE THOUSAND; 500 ft FIVE HUNDRED.
- Captain's MINS selector (RADIO or BARO): DH/MDA + 100 ft PLUS HUNDRED; DH/MDA MINIMUMS.
- Options (B737UK): 400/300/200, "Minimums, Minimums", "Approaching Minimums" (DH+80), "Approaching Decision Height", "Decision Height", custom 60 ft.
- MKV tone options (p.18): Five Hundred Tone (2 s, 960 Hz), One Hundred Tone (2 s, 700 Hz), Thirty Five Tone (1 s, 1400 Hz), Twenty Tone (1/2 s, 2800 Hz). Unlikely on a 737 (M).

#### Once per approach (MKV p.19, H)

- Some callouts are doubled (e.g. "MINIMUMS, MINIMUMS"), but each plays only once per approach.
- DH-based callouts need gear down and win over an overlapping altitude callout: with DH 200, only "MINIMUMS" plays at 200 ft AGL, not "TWO HUNDRED".

#### Re-arm and suppression rules in FG

[SPEC] 6.4.2 as implemented; generic MK VI/VIII, believed the same on the MK V (M).

- Callout table: 2500, 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10 (L3873-3874). Option tables L581-603; option 13 = MINIMUMS + 1000/500/400/300/200/100/50/40/30/20/10.
- Fires only on a downward crossing (last RA > callout ≥ RA); all callouts at or above it are then locked out (L4110-4131).
- Skipped if RA is already > 20 ft below it (callout > 150 ft) or > 10 ft below (callout ≤ 150 ft) (L3928-3932).
- Skipped within ±30 ft of DH (RA ≥ 200) or −3/+6 ft (RA < 200); MINIMUMS wins (L3904-3925).
- Re-arm: callouts and minimums reset whenever not in takeoff mode and RA > 1,000 ft (L4334-4342), and on entering or leaving takeoff mode (L3993-4005). So after a go-around: on leaving takeoff mode (500-1,000 ft) or above 1,000 ft RA. No other hysteresis.
- Field-elevation 500 ("above field" option): fires below 550 ft, re-arms above 700 ft (L4210-4262).
- "MINIMUMS MINIMUMS" once when the DH discrete goes true with gear down; cuts off any callout in progress (L4025-4081).
- The Airbus-style RETARD option (L599-603, L4088-4099) is not 737.

#### SMART 500 (MKV p.19, H)

- Optional "FIVE HUNDRED" to help on non-precision approaches.
- Non-precision is assumed when G/S deviation is > 2 dots, whether or not the G/S is valid, or on a detected back course. Net effect: 500 added on non-precision, removed on precision approaches.
- FG `inhibit_smart_500()` (L3935-3957) drops "FIVE HUNDRED" when G/S is valid, not backcourse or cancelled, and localizer (or G/S) is within 2 dots.
- 737: the Boeing typical list always calls 500 (baro above field); Smart 500 is an option (M).

#### Bank angle

**737NG (FCOM 15.20.22, L130875-130881; MAX FCOM identical) (H):** "BANK ANGLE, BANK ANGLE" past 35°, 40° and 45°; each threshold stays silent until bank is back to 30° or less.

This is Honeywell **Bank Angle Option 1** (MKV p.21): 35/40/45° at any altitude, one advisory per step in order; a step skipped because roll rate outran the callout is not announced; reset below 30°.

Option 2 uses Basic below 130 ft and Option 1 above. The Air Transport Basic envelope is 10° at 5-30 ft, 10→40° at 30-150 ft, and 40° above. Bank angle is inhibited below 5 ft.

**FG does NOT implement Option 1**; its curves are **MK VIII-specific (bizjet/turboprop)**:
- `m6_t2` (types 254/255, L402-426), A/P off: 10° at 5-30 ft; `RA < 4·roll − 10` (10→40°) at 30-150 ft; `RA < 153.33·roll − 5983` (40→55°) at 150-2,450 ft; 55° above 2,450 ft. A/P on: 33° above 122 ft.
- `m6_t4` (types 0-4, L428-446): 50° above 210 ft (33° with A/P above 156 ft); `RA < 5.714·roll − 75.7` below.
- Repetition (FG L4279-4329, MKVIII p.24): once at the threshold; again at +20% roll (roll ≥ 1.25× threshold); continuous, looped with 3 s silence, past the second step (roll ≥ 1.67× threshold). Resets when roll drops below the initial limit.

**For the 737, use the FCOM rule:** one "BANK ANGLE, BANK ANGLE" as each of 35°, 40° and 45° is first exceeded, all re-armed at |roll| ≤ 30°.

### Other MK V/Boeing voices

- TCF ("TOO LOW TERRAIN"), FG L4442-4500: RA < 700 ft beyond 15 NM from a runway, ramping to 400 ft at 4-12 NM and to 0 at the runway. Repeats every 20% (L4560-4580).
- "CAUTION TERRAIN" every 7 s while the conflict persists (MKV p.27); "TERRAIN TERRAIN PULL UP" then "PULL UP" continuous.

### Summary of MK VIII-specific items in mk_viii.cxx (do not copy for the 737)

- Types 0-4 envelopes: Mode 1 `m1_t4`; Mode 4 at 148-178 kt and 150-200 ft; Mode 3 `m3_t2`.
- Bizjet/turboprop bank-angle curves (`m6_t2`, `m6_t4`) with A/P-engaged 33°. Flap-override and steep-approach biases.
- Mode 2A airspeed expansion of 190→280 kt for types 254/255 (MK V and FG types 0-4 use 220→310 kt).
- The RETARD, MINIMUMS_ABOVE_100 and "500 ABOVE" options.

## Not found or open

- Tone parameters: altitude-alert tone pitch and length, horn and siren frequencies and cadences, clacker rate. Boeing does not publish them.
- Stick-shaker onset AoA and shaker frequency.
- Windshear siren: exact number of cycles.
- Tooling: b737.org.uk gpws.htm and autoflight.htm were unreachable (DNS failure).
