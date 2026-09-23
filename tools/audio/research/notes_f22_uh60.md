# F-22A ICAWS and UH-60 aural warnings: research notes

Downloaded texts are in `research/dl/` (file names are given with each finding).
Research date: 2026-09-23. All quotes below are verbatim from the source (OCR text, so small OCR errors are possible).

---

## D1. F-22A ICAWS aural vocabulary

**Bottom line:** No public source gives the F-22 voice-warning word list or tone specs. Primary sources do confirm these points:
- ICAW alerts are aural as well as visual.
- Cautions have an "aural tone".
- Warnings also go to the pilot's headset.
- The HUD shows "CAUT".
- The CNI system includes speech synthesis.
- A Low Altitude Warning System (LAWS) "sounds" an alert.

No source quoted any spoken F-22 phrase ("PULL UP", "ALTITUDE", "BLEED AIR", etc.).

### Findings

1. **"C BLEED HOT caution ICAW asserted (a visual and audible cue to the MP)"**, and "“CAUT” was displayed in the head-up display (HUD) advising the MP of the caution ICAW."
   - Source: USAF AIB Report, Second Addendum, F-22A T/N 06-4125, 16 Nov 2010 (JBER, Capt. Haney), Executive Summary and p. 6.
   - URL: https://web.archive.org/web/2015id_/http://usaf.aib.law.af.mil/ExecSum2011/F-22%202nd%20Addendum%2C%20JBER%2C%2016%20Nov%2010.pdf (also PACAF AFD-131024-066.pdf).
   - Local file: `dl/F22_JBER_16Nov10_2ndAddendum.txt`
   - Confidence: HIGH (that the caution has an audible cue). The report does not describe the sound itself.
   - ICAW message names in this report, in sequence:
     - `C BLEED HOT` (caution), 19:42:18
     - `OBOGS FAIL` (caution), 19:42:23, triggered by OBOGS output below 10 psi
     - `CABIN PRESS` / "CABIN PRESSURE" (caution), 19:43:13
     - `AIR COOLING` (caution), 19:43:18. It asserts 60 s after C BLEED HOT when avionics cooling is lost.
   - Caution definition, quoting TO 1F-22A-1: "[a]ircraft operation that could result in damage to aircraft. Corrective procedures may be required, but not immediately." (p. 7)

2. **"...the CABIN PRESSURE caution ICAW aural tone at 18,500 feet and the AIR COOLING caution ICAW aural tone at 13,000 feet, should have alerted the MP..."** Also: "when the AIR COOLING caution ICAW aural tone occurred, the pilot was 'heads down'... The F-22 pilot immediately ceased manipulating the EOS ring, upon hearing the aural tone, to check the new indicated malfunction."
   - Source: DoD IG Report DODIG-2013-041 (6 Feb 2013), "Assessment of the USAF AIB Report on the F-22A Mishap of November 16, 2010", p. 8–9. Also on DTIC as ADA573745.
   - URL: https://web.archive.org/web/20130222134851id_/http://www.dodig.mil/pubs/documents/DODIG-2013-041.pdf
   - Local file: `dl/DODIG-2013-041.txt`
   - Confidence: HIGH that each new caution ICAW produces an aural **tone**. The tone type or frequency is not stated.
   - Note: the IG expands ICAW as "Indications, Cautions, and Warnings".

3. **"Warning System - All warning, caution, and advisory information is presented on the left UFD. Warning messages are also presented on the HUD and through the pilot headset. Warnings consist of both subsystem health and tactical advisories."**
   - Source: AGARD AR-349 "Glass Cockpit Operational Effectiveness" (FVP WG-21, Apr 1996), F-22 aircraft sheet, section "III Backup Modes & Equipment", ~p. 138.
   - URL: https://archive.org/download/DTIC_ADA310523/DTIC_ADA310523_djvu.txt
   - Local file: `dl/ADA310523.txt`
   - Confidence: MED-HIGH. This is an official NATO/AGARD document but pre-production, from 1996.
   - The same sheet lists an "Audio" control panel among the subsystem panels.

4. **"Integrated Caution, Advisory, and Warning (ICAW) - The F-22 ICAW system filters unnecessary detail and duplication... Up to 12 ICAW messages can be displayed at the same time. An ICAW warning to the pilot may be evidenced by an aural or visual indication or both."**
   - Also: "The 'OBOGS Fail' light on the ICAWS has a 12-second delay for low oxygen" (Executive Summary). "provides system warning to the F-22's ICAWS when the oxygen production is below a software-defined warning band for 12 seconds" (p. 14). The warning band is 45 % O2 (p. 25–26).
   - Source: USAF SAB Report SAB-TR-11-04 "Aircraft Oxygen Generation", 1 Feb 2012 (Distribution A). Glossary is ~p. 172.
   - URL: https://archive.org/download/DTIC_ADA567568/DTIC_ADA567568_djvu.txt
   - Local file: `dl/ADA567568.txt`
   - Confidence: HIGH
   - The same 12-second delay text appears in the NASA NESC F-22 HSI report (NTRS 20150022283).

5. **"The F-22A is equipped with a Low Altitude Warning System (LAWS). ... the LAWS was programmed to alert at 14,000 ft MSL, but the default setting was to the off position, meaning an alert would not sound unless the MP activated the system."**
   - Source: 2010 AIB Second Addendum, p. 17–18 (same URL as finding 1).
   - Confidence: HIGH that LAWS is pilot-set, off by default, and aural. The wording of the alert is not given.
   - AFI 11-2F-22A Vol 3 (8 Dec 2009), para 2.4.1.5 requires briefing "altitude-warning features (low altitude warning)". Its briefing guide includes an item "Altitude Warning Settings".
     - GitHub mirror: https://github.com/thatpub/pubs/blob/master/txt/afi11-2f-22av3.txt
     - Local file: `dl/thatpub_afi11-2f-22av3.txt`
     - Confidence: HIGH as a document, LOW as audio information.

6. **The CNI subsystem includes an "Interphone/Intercom subsystem for voice communication and synthesis".**
   - Source: R. W. Brower (USAF), "Lockheed F-22 Raptor", *The Avionics Handbook* ch. 32 (CRC 2001), §32.3 CNI item 5.
   - URL: https://helitavia.com/avionics/TheAvionicsHandbook_Cap_32.pdf
   - Local file: `dl/AvionicsHandbook_ch32.txt`
   - Confidence: MED. This implies synthesized voice messages but does not list any.

7. **Other ICAW names seen:**
   - "Do not take off with the SES LOW ICAW displayed." (AFI 11-2F-22A V3 para 3.6.8)
   - "flight control system ICAWS that reset IAW flight manual procedures" (para 7.4.3.2)
   - The 2009 Tyndall AIB executive summary says a missing ICAW for a failure mode was causal: "an ICAW would have led MP to abort".
   - Local files: `dl/F22_Tyndall_8Apr09_ES.txt`, `dl/thatpub_afi11-2f-22av3.txt`
   - Confidence: HIGH (names only).

### Searched with no aural vocabulary found (F-22)

- 2009 Edwards AIB full report (Cooley; airforcemag mirror). "ICAWS" appears only in the acronym list. File: `dl/F22_Edwards_2009_AIB.txt`
- 2004 Nellis executive summary, 2007 Nellis executive summary (image-only PDF), 2009 Tyndall executive summary.
- 2020 Nellis F-22 AIB. This is a ground maintenance mishap with nothing on audio.
- The 2010 JBER **original** full AIB (usaf.aib…/F-22A_AK_16 Nov 10.pdf) returned 404 in Wayback. Only the 2nd addendum and the IG report were obtained.
- 2012 Tyndall and 2020 Eglin F-22 AIBs are not in the afjag Wayback index. Not found.
- archive.org full-text searches that returned only non-F-22 or fiction hits:
  - `"F-22" "voice warning"`
  - `"Raptor" "Bitching Betty"` (screenplays and games only)
  - `"F-22" "aural warning"`
- GitHub code search for "ICAWS F-22", "F-22 voice warning" and "raptor bitching betty": only the AFI texts were useful.
- DTIC ADA387109 (electronic checklists): mentions F-22 test pilots but not the audio.

---

## E1. UH-60 aural and voice warnings

### (a) UH-60M (CAAS)

**Bottom line:** No public source lists UH-60M CAAS voice or tone messages.
- The UH-60M operator's manual, TM 1-1520-280-10, is **Distribution D** (not public). A 2009 DTIC bibliography in archive item `gray-eagle-dtic-documents` cites it as "TM 1-1520-280-10, 14 August 2009, DISTRIBUTION D". Not found online.
- The closest public H-60 voice vocabulary is the **MH-60K** Voice Warning System (finding a1), from a 1994 Distribution C TM that is posted on archive.org.

**a1. MH-60K TM 1-1520-250-10 (1994)**
- Source: archive.org item `mh-60-k-flight-manual`. The cover shows Distribution C, but the manual is publicly posted.
- URL: https://archive.org/download/mh-60-k-flight-manual/MH-60K%20Flight%20Manual_djvu.txt
- Local file: `dl/MH60K.txt`
- Confidence: HIGH as MH-60K data; LOW-MED as a stand-in for the UH-60M.
- **Para 2-226, Master Warning Panel (p. 2-104/105):** "The LOW ROTOR RPM warning light will flash at a rate of three to five flashes per second if rotor rpm drops below 96% NR. In addition, if NR drops below 96% or NG drops below 55%, a low frequency tone will precede voice messages. The low rotor audio, VWS message, and LOW ROTOR RPM lights are inhibited on the ground through the right landing gear weight-on-wheels switch. The engine out audio, VWS message, ENG OUT lights are not inhibited... will go on at 55% NG speed and below."
- **Para 2-227, Voice Warning System (VWS), p. 2-105:** "There are three voice announcement formats for the twelve messages."
  - Priority 1: "a 2 second intermittent 250 Hz tone, a 0.5 second gap, the voice message, a 1 second gap, the voice message, and 1 second gap"
  - Priority 2: "a 2 second continuous 250 Hz tone, a 0.5 second gap, the voice message, a 1 second gap, the voice message, and 1 second gap"
  - Priorities 3–10: "the voice message, a 0.5 second gap, the voice message, a 1 second gap, the voice message, and 1 second gap"
  - Acknowledgement is by MASTER CAUTION PRESS TO RESET or the cyclic VOICE ACK button. Unacknowledged messages "will be repeated continuously". Simultaneous messages play in priority order, and each must be acknowledged separately.
- **Table 2-6, VWS messages (message / priority / condition):**

  | Message | Priority | Condition |
  |---|---|---|
  | STABILATOR | 1 | Automatic stabilator control failed |
  | ENGINE 1 OUT | 2 | NG 1 ≤ 55 % |
  | ENGINE 2 OUT | 2 | NG 2 ≤ 55 % |
  | LOW ROTOR | 2 | "NR is at or below 95%" (the table says 95 %; the text says 96 %) |
  | TERRAIN AHEAD | 3 | Multimode-radar terrain-following terrain point |
  | ALTITUDE LOW | 4 | Below the CDU RALT SET minimum |
  | CW RADAR LOCK | 7 | |
  | CW RADAR JAMMING | 8 | |
  | PULSE JAMMING FORWARD | 9 | |
  | PULSE JAMMING AFT | 9 | |
  | BING BONG | 12 | Timer or alarm clock |

  - Table note: VWS priorities 1–4 block APR-39A voice messages until they are acknowledged.
- **Para 2-115 "Stabilator Control Panel":** "a beeping tone and voice warning message 'stabilator' will be heard in the pilot's and copilot's headphones." The voice message remains on until acknowledged.
- **APR-39A voice messages (Ch. 4):** "CW, CW, Launch" and "Missile, Missile, xx (2, 4, 8, or 10) O'Clock Launch".

**a2. UH-60M radar altimeter low-bug audio exists**
- User comment: "Low bug audio on radar ALT enhanced situation awareness greatly."
- Source: ARL, "Human Factors Assessment of the UH-60M Crew Station During the Limited User Test (LUT)", Feb 2006, DTIC ADA444913, p. 58 (task 2081 comments).
- URL: https://archive.org/download/DTIC_ADA444913/DTIC_ADA444913_djvu.txt
- Local file: `dl/DTIC_ADA444913.txt`
- Confidence: MED. This confirms an aural low-altitude-bug cue in the UH-60M, but the report does not give its sound or wording.
- The companion reports ADA430014 (EUD2) and ADA441422 (CAAS crew station) contain nothing on aural warnings. They cover EICAS, the Master Warning Panel and inverse-video cautions.

**a3. Other UH-60M items**
- DTIC ADA506356 (West Point ORCEN 2009, "Overcoming Information Overload in the Cockpit") uses a UH-60M PFD. Its survey lists "Audio Tones from aircraft malfunction" and "CMWS tones" as auditory stimuli, and it proposes 3D audio. No vocabulary. Confidence: LOW.
- The TC 3-04.33 H-60 ATM (2012 FAD) covers UH-60M/HH-60M. The only audio mentions are generic H-60:
  - "engine out audio should sound when the APU generator is engaged... Reset the engine out audio using either MASTER CAUTION PRESS TO RESET switch or ... EXT PWR switch to OFF" (Task 2108, APU start, p. 4-177)
  - "Have crew acknowledge each reception of a stabilator audio tone" (p. 5-8)
  - "(3) Low rotor RPM audio." (maintenance test flight task, generator underfrequency / low rotor RPM check)
  - URL: https://archive.org/download/manualzilla-id-5667027/5667027_djvu.txt
  - Local file: `dl/TC3-04.33.txt`
  - Confidence: HIGH (generic H-60).

Not found for the UH-60M: whether it has voice callouts (e.g., "LOW ROTOR RPM", "ENGINE ONE OUT", "ALTITUDE"), a high-rotor-RPM aural, a fire aural, or tone frequencies.
- The 2018 Taiwan NASC UH-60M NA-706 TTSB report (Chinese only) might contain CVR aural alerts. It was not retrieved.

### (b) UH-60A/L TM 1-1520-237-10: exact wording

Sources:
- **1988 edition** (UH-60A/EH-60A, 8 Jan 1988): https://archive.org/download/TM1-1520-237-10/TM1-1520-237-10_djvu.txt. Local file: `dl/TM237_1988.txt`
- **1996 edition** (UH-60A/UH-60L/EH-60A, 31 Oct 1996, with Changes 1–10 through 30 Sep 2002, Distribution A): https://archive.org/download/Operators_Manual_for_UH-60A_Helicopter_TM_1-1520-237-10/Operators_Manual_for_UH-60A_Helicopter_TM_1-1520-237-10_djvu.txt. Also DTIC ADA409934. Local file: `dl/TM237_b.txt`
- Confidence: HIGH for both.

**b1. Master warning, low rotor and ENG OUT tone**
- **1988, para 2-217 "Master Warning System" (~p. 2-84):** "Four red warning lights... #1 ENG OUT, #2 ENG OUT, FIRE, and LOW ROTOR RPM. The LOW ROTOR RPM warning light will flash at a rate of three to five flashes per second if rotor rpm drops below 95% RPM R. In addition, if % RPM R drops below 95% or Ng drops below 55%, a low steady tone is provided. The low rotor rpm tone is inhibited on the ground through the left landing gear weight-on-wheels switch. The engine Ng steady tone is not inhibited. The ENG OUT warning lights and tone will go on at 55% Ng SPEED and below. Refer to paragraph 2-33 for description of the FIRE warning lights."
- **1996 edition, para 2.81 "MASTER WARNING SYSTEM" (p. 2-78, Change 6 dated 3 Apr 2000):** same text with **"96%"** in place of 95 %, marked with change bars. It reads "Four amber warning lights" in the OCR (the 1988 edition says "red").
  - So the low-rotor threshold is **<96 % NR** from Change 6 (2000) onward, and <95 % before that.
- Tone description: "low steady tone" is the only wording anywhere. No frequency is given, and nothing describes it as a warble.
- **Table 2-1 "Weight-On-Wheels Functions" (1996, p. 2-11/2-12):** "Low % RPM R Audio Warning — On ground: Disabled / In flight: Enabled".
- **Engine alternator / DEC paragraphs (1996, para 2.19.1–2.19.2):** loss of the Ng signal gives "an ENG OUT warning light and audio".
- **Emergency para 9-7 "Engine Malfunction – Partial or Complete Power Loss" (1988):** "Changes in affected engine RPM, change in rotor RPM, low rotor and/or engine-out audio warning, illumination of the low-rotor and/or engine-out warning lights, change in engine noise, and left yaw."

**b2. High rotor RPM:** no high-rotor-RPM light or tone exists in either edition (searched "high rotor" and "overspeed"). Not found.

**b3. Stabilator beeping tone**
- **1988, para 2-112 "Stabilator Control Panel":** "If a malfunction occurs in the automatic mode, the system will switch to manual, ON will go off in the AUTO CONTROL window, and the STABILATOR caution and MASTER CAUTION lights will go on and a beeping tone will be heard in the pilot's and copilot's headphones. ... If the automatic mode is not regained, the MASTER CAUTION must be reset, which turns off the beeping tone..."
- **1996, para 2.38.1 (p. 2-47, Change 10):** identical text.
- No beep rate or frequency is given anywhere.
- Emergency para 9-73 adds: "There is a remote possibility that a stabilator malfunction could occur in the automatic or manual mode without audio warning or caution light illumination."

**b4. Master caution:** lights only ("MASTER CAUTION PRESS TO RESET"). No caution tone is described in the A/L TM, except that master-caution reset silences the stabilator beep and the engine-out audio (ATM). **Fire:** FIRE warning light and T-handles only. No fire tone is mentioned.

**b5. Radar altimeter (AN/APN-209(V), 1996 para 3.29, p. 3-78.1, Change 8):** "A low-altitude warning light, on the center left of the indicator, will light to show the word LO any time the helicopter is at or below the altitude limit selected by the low altitude bug. Each pilot may individually select a low-altitude limit and only his LO light will go on..."
- **No audio** in the A/L TM, including the 2002 changes.
- The UH-60M does have low-bug audio (see a2).

**b6. No voice warnings** appear in the UH-60A/L TM through Change 10 (2002). The only other audio is avionics: APR-39 "Audio warning signals are applied to the pilot's and copilot's headsets" (1988, para 4-22.1), plus radio and crypto tones.

**b7. Supporting field wording (Army safety)**
- Flightfax Vol 25 (DTIC ADA322519): "Low rotor rpm master warning light came on... Low rotor rpm audio horn could not be deactivated". Confidence: MED. The quote is from an archive.org full-text snippet.
- Leoni, *Black Hawk: the story of a world class helicopter*: "Low-engine rpm lights came on, and the low-rotor rpm audio warning sounded."
- Crews call it an "audio"/"horn". The TM calls it a "low steady tone".

### Searched with nothing useful found (UH-60)

- archive.org metadata searches for "1-1520-280" and UH-60M operator manuals: none.
- archive.org full-text searches with no UH-60M vocabulary:
  - `"UH-60M" "voice warning"`
  - `"UH-60M" "voice message"`
  - `"CAAS" "voice warning"`
  - `"UH-60M" "aural warnings"`
  - `"UH-60" "altitude, altitude"`
- GitHub code search `UH-60M "LOW ROTOR RPM" voice`: one hit, an aerossurance-type accident compilation (Taiwan NA-706), with no vocabulary.
- DTIC ADA557615 (NATO brownout report): "BUGGING ** FEET (for RadAlt audio warning)" is generic crew patter, not UH-60 specific.
- No USAARL "auditory warnings in Army helicopters" study was found in the time available.
