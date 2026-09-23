# Third-party sounds (FlightGear aircraft, GPL-2.0)

These four sound files (the A320 cavalry charge is a re-synthesis from an Airbus waveform diagram, not a recording) are unmodified copies of files from two open-source FlightGear aircraft. Both repositories are
licensed under the **GNU General Public License, version 2** (full text: `LICENSE-GPL-2.0.txt`, copied from the
repositories). `tools/audio/gen_fgsounds.py` derives the game assets from them (resampling to 48 kHz, level matching,
an 80 Hz high-pass, and for the 737 wailer a seamless loop cut); the derived files are therefore also GPL-2.0.

| File here | Original path | Repository | Authors |
|---|---|---|---|
| `a320_cavalry_once.wav` | `Sounds/Cockpit/cavalry-charge-once.wav` | https://github.com/legoboyvdlp/A320-family | legoboyvdlp, Octal450 and contributors (A320-family for FlightGear) |
| `a320_cavalry_loop.wav` | `Sounds/Cockpit/cavalry-charge-loop.wav` | https://github.com/legoboyvdlp/A320-family | legoboyvdlp, Octal450 and contributors |
| `a320_ap_button.wav` | autopilot-disconnect pushbutton sound, `Sounds/` | https://github.com/legoboyvdlp/A320-family | legoboyvdlp, Octal450 and contributors |
| `b737_apdisco.wav` | `Sounds/Apdisco.wav` | https://github.com/YV3399/737-800YV | YV3399 and contributors (Boeing 737-800YV for FlightGear) |

SHA-256 of the copies:

```
4f18e00bbce00a937eb9d0816a09fc113201c8dbae2b24184c73b1935c768cbb  a320_cavalry_once.wav
b46e41715e064a9c53e3a9807eddadfd48d5f4a8c4d517cf2d91874719033ec9  a320_cavalry_loop.wav
b4a953400f02af3a638c345df736854219d797a033501ad5ba8e773d87c79d9c  a320_ap_button.wav
56a2c8fb3fd1f49ec6eadfca0439821410cf37e7b4a524f991eb2babe337b1bf  b737_apdisco.wav
```
