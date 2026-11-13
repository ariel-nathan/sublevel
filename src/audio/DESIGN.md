# Audio design reference

For whoever tunes these sounds next. The numbers are what the code does now,
and every claim is tagged: **[S#]** = from source # below, **[I]** = my own
inference or design choice. To check a change, run
`bun src/audio/preview.ts`: it writes a WAV and a spectrogram PNG per sound
to `out/audio/`, a contact sheet (`sheet.png`), and a table of descriptors.

## Era facts that drive the treatment

- **Sample format.** The period's engine family stored world sounds as mono
  PCM, 8- or 16-bit, at 11 025 or 22 050 Hz. Most effects were 11 025 Hz, and
  22 050 Hz was the maximum. Other rates were resampled to 22 050 Hz with
  linear interpolation **[S1, S2, S3]**. The engine it grew from mixed at
  11 025 Hz by default **[S4]**. A 22 050 Hz rate band-limits a sound to
  about 10 kHz and 11 025 Hz to about 5 kHz. 8-bit samples carry a noise
  floor near −48 dB **[I, textbook]**.
- **Mono world sounds, panned at mix time.** Only mono is supported for
  world sounds **[S1, S3]**. The mixer pans each mono sample by the dot
  product of the source direction with the listener's right vector **[S4]**.
- **Attenuation.** Distance falloff was _linear to silence_. The gain is
  `1 − dist · attn / 1000 units` **[S4]**, and the attenuation classes are
  NORM 0.8, IDLE 2 and STATIC 1.25 **[S5]**. At about 2.5 cm per unit,
  normal sounds fade out by about 32 m and static/looping ones by about 20 m
  **[I]**. Quake-era static sounds fall off faster still **[S4]**. DirectSound
  instead used inverse distance, with a 1 m minimum distance and rolloff 1
  **[S11]**.
- **Room DSP.** The listener's room sets a DSP/reverb preset. Designers
  placed one per space by hand **[S14]**. The I3DL2/EAX presets of the
  period describe hard rooms in measurable terms **[S10]**:
  - Room: decay 0.40 s.
  - Hallway: 1.49 s, high-frequency decay ratio 0.59.
  - Stone corridor: 2.70 s, ratio 0.79.
  - Stone room: 2.31 s, ratio 0.64.
  - Every preset: first reflections at 7–13 ms, late reverb at 11–20 ms,
    reverb level −10 dB.
- **Few voices.** The engine had 8 dynamic channels plus ambient and static
  ones. Ambient level faded in and out per area at a fixed rate **[S4]**.
- **Variation by takes, not processing.** Footsteps used 4 recordings per
  surface, alternating feet, at fixed pitch, with volume 0.5 when running
  and 0.2 when walking, every 300 or 400 ms **[S5]**. Material hit sounds
  played at volume 0.8–0.9 with a random pitch of 96–111 % **[S5]**.
- **Impact level from speed.** The physics-era successor used these rules
  **[S6, S7]**:
  - No impact sound below 70 in/s (about 1.8 m/s), and at most one per
    object every 50 ms.
  - Volume = (speed / 320 in/s)², clamped to 1.
  - Each surface has separate _soft_ and _hard_ impact sounds, chosen by
    velocity and hardness thresholds.

## Physical models used

- **Modal synthesis** **[S8, S9]**. A struck object is a sum of exponentially
  decaying sinusoids. Each mode is a two-pole resonator (`modal.ts`) driven
  by a contact-force pulse `(1 − cos 2πt/T)/2`.
  - The pulse duration T conveys hardness: short T gives a bright sound.
  - Hard contacts are not single clicks. Micro-collisions within about
    15 ms add realism.
- **Material is decay, not pitch** **[S9]**. A mode at f decays by 1/e in
  `d / f` seconds, and listeners judge material mostly from d.
  - d ranges over 3–300. Rubber is lowest, then wood, then glass, then
    steel.
  - Code: `tau = 1/(f/d + c)`, adding a frequency-independent loss c for
    contact with the floor **[I]**.
- **Footsteps are micro-impacts** of sole against floor, excited by the
  ground reaction force **[S16]**. They split usefully into a heel and a
  toe/ball event **[S17]**.
- **Fluorescent hum.** The magnetic ballast's core flexes at twice the mains
  frequency (120 Hz on 60 Hz mains), with harmonics from saturation and
  mounting **[S12]**.
- **Motors and fans** **[S13]**. Motors are built from a rotor tone,
  brush/gear noise and body resonance. Fans are periodic air pulses at the
  blade rate, with jitter.

## Per category: target, technique

Durations and descriptors are measured at 44.1 kHz (`preview.ts`). "rms50" is
the loudest 50 ms RMS.

| Sound                           | What the genre does (S = sourced, I = inferred)                                                                          | Technique here                                                                                                                                                                                                                     | Key numbers now                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| footstep_concrete               | Short boot knock with grit; 4 takes/surface, played softer than impacts [S5]; little floor resonance [I]                 | Rubber-sole modes (d 6), heel then ball 38–58 ms later, sparse 1.2–6.5 kHz crackle, 95 Hz weight                                                                                                                                   | 0.12 s, attack < 1 ms, d40 79 ms, onset centroid 1.3 kHz |
| footstep_tile                   | Harder, brighter click; short ceramic ring [I]                                                                           | 0.2 ms contact on tile modes 1.8–5.9 kHz (d 40, c 110) + sole                                                                                                                                                                      | 0.11 s, onset centroid 1.6 kHz (brightest)               |
| footstep_metal (grate over pit) | Resonant, rattly hollow metal; separate surface class in the period [S5, S7]                                             | Grating modes 318 Hz–4.6 kHz (d 90), 4 decaying rattle re-strikes 11–27 ms apart, 82 Hz pit boom                                                                                                                                   | 0.32 s, d40 312 ms, flatness 0.00 (tonal)                |
| land / jump                     | Land: body-weight thud and grit; jump: soft scuff and cloth [I]                                                          | Two staggered sole strikes, 70–120 Hz thumps, grit, gear rustle / scuff and band-passed swish                                                                                                                                      | land 0.21 s; jump −22 dB rms50 (quiet)                   |
| impact_wood (crate)             | Dull, short "thock" plus a snap; level grows ~ v² [S6]                                                                   | 11 modes 112–2590 Hz, d 20, c 14; 0.35 ms contact; second-edge strike 16–30 ms; floor thump; crackle                                                                                                                               | 0.37 s, d40 200 ms, strongest peaks 254/112/342/178 Hz   |
| impact_metal (drum/case)        | Long inharmonic ring; cylindrical shells give beating near-pairs [I]                                                     | 19 modes 148–5530 Hz, d 220, c 3.2; 0.15 ms contact; 3 micro-collisions < 15 ms [S8]                                                                                                                                               | 1.2 s, d40 935 ms, peaks 489/347/148/231 Hz              |
| impact_plastic                  | Short hollow "tok" with rattle [I]                                                                                       | 8 modes 214–3390 Hz, d 7, c 28; rattling loose parts                                                                                                                                                                               | 0.12 s, d40 69 ms                                        |
| crate_break                     | Crack, splinters, then pieces falling [I]                                                                                | Hard modal hit, 7 fracture bursts < 60 ms, splinter crackle, 12 plank strikes (free-bar ratios 1:2.76:5.4:8.93) over 0.7 s                                                                                                         | 0.78 s, loudest category                                 |
| pickup / throw                  | Short, quiet handling cues [I]                                                                                           | Muffled knock + rustle / swept band-noise swing 350→2050 Hz                                                                                                                                                                        | −18 / −19 dB rms50                                       |
| button_press                    | Mechanical: cap click, switch clunk, release; era interfaces add a short tone [I]                                        | Cap modes 1.2–5.1 kHz, damped panel modes, relay tick at 45 ms, one soft 1.05 kHz tone rising 4 %                                                                                                                                  | 0.19 s                                                   |
| button_deny                     | Clearly negative: lower, rough, descending [I; roughness from psychoacoustics]                                           | Same mechanics + two buzzer pulses (165 then 131 Hz, tritone pair, 50 Hz AM roughness) through a 280–2800 Hz "panel speaker"                                                                                                       | 0.39 s                                                   |
| door_open / door_close          | Heavy pneumatic/servo slide; distinct start and end events [I]                                                           | Speed-profiled motor (base 104/96 Hz, gear whine ×9), rail rumble, roller ticks; open = latch clunk + air burst at start, soft bumper at 1.17 s; close = small click at start, heavy seal thud + latch bolt + gasket air at 1.17 s | open loudest in first 15 %, close in last 35 %           |
| plate_down / plate_up           | Heavy plate sinking / springing back [I]                                                                                 | 78–120 Hz thump + damped plate modes + switch click / lighter clank 1.45× higher, spring tick                                                                                                                                      | centroid down < up                                       |
| hum_fluorescent                 | 120 Hz + harmonics, unstable ballast [S12]                                                                               | 12 even + 4 odd mains harmonics drifting in 4 groups; 1.8–6.5 kHz buzz gated by the 120 Hz cycle with unsteady level                                                                                                               | strongest peak 119.9 Hz; loop 11.9 s                     |
| hum_machine                     | Motor + fan blade-pass + airflow [S13]                                                                                   | 29.6 Hz shaft and harmonics, 87 Hz blade rate, 120 Hz electrical; duct-shaped airflow noise                                                                                                                                        | peaks 86.8 / 120 / 59.2 Hz                               |
| ambient_drone (room tone)       | Depth without fatigue; distant machinery hum is the usual description of facility silence (editorial, not developer) [I] | Broadband noise flat 90–250 Hz then −4.5 dB/oct, corridor-mode bands at 185/425/950 Hz, faint 120 Hz; no events                                                                                                                    | sub < 3 %, envelope spread 2.6 dB                        |

All loops are exactly periodic: 2^19 samples, every tone an integer number
of cycles, noise from one inverse FFT. Their slow level drifts use
modulators with 4–60 cycles per loop and never 1–3, so the level does not
swell once per repeat **[I]**. Tests require loop-rate modulation below
5 % and the loudest 50 ms frame within 4 dB of the median.

## Era treatment and mix (dial in `mix.ts`)

- **`ERA = { rate: 22050, amount: 1, bits: 0 }`**, applied to every
  one-shot. It runs an 8th-order low-pass at 9.9 kHz, decimates to 22 050 Hz
  and re-interpolates linearly, as the period's resampler did **[S1]**.
  - 22 050 Hz rather than 11 025 Hz: 11 025 Hz removes the 5–10 kHz grit
    and click that separate concrete from tile **[I]**.
  - Bit reduction is off. An 8-bit floor would hiss in the reverb tails
    **[I]**. Set `bits: 8` to hear it.
  - Loops stay full band.
- **`LOUDNESS`** sets a level per sound: loudest-50 ms RMS for one-shots,
  whole-file RMS for loops, plus a peak ceiling. Every buffer is normalised
  to it, and a soft knee holds peaks under the ceiling.
  - Order, loudest first: break −9 > impacts −10/−11 > doors −11/−12 >
    land −12 > plates −13/−15 > footsteps −13 > buttons −15 >
    handling −18/−19 > jump −22 > loops −23 to −26 dBFS.
  - Footsteps sit 3 dB under impacts before the game's 0.5 gain, mirroring
    the period's 0.5 vs 0.9 **[S5]**.
  - The category hierarchy (gameplay cues over ambience) follows current
    practice **[S15]**.
- **`BUSES`** holds the bus layout:
  - One-shots go through a glue compressor (−16 dB threshold, 3:1, 4 ms
    attack, 250 ms release).
  - Loops bypass the compressor, so a falling pile cannot pump the hum.
  - Everything then passes a −3 dB, 20:1 safety limiter.
  - Reverb send is 0.24 for world sounds, 0.12 for the player's own sounds
    and 0.10 for loops.
- **Room (`voices.ts`, `ROOM`).** RT60 is 1.0 s low, 0.85 s mid and 0.42 s
  high, with a 9 ms pre-delay and 9 early reflections at 8–45 ms. The tail is
  dense three-band noise, so it cannot ring metallically. The choice sits
  between the period's room and hallway presets, with highs dying faster as
  in its stone and hallway presets **[S10, I]**.
- **Distance (`voices.ts`, `ATTENUATION`).** Gain is inverse distance times
  a linear fade to zero, combining the period's linear-to-silence curve
  **[S4]** with modern inverse falloff **[S11, S18]**.
  - World sounds: full level to 1.5 m, silent at 32 m.
  - Ambience: full level to 1 m, silent at 16 m. A hum 10 m away is −28 dB.
  - A low-pass falls from 20 kHz to 2.5 kHz with distance.
  - The reverb send falls as √gain, so distant sources sound wetter.
- **Voices.** One-shots are capped at 24, with priorities player (3) >
  break (2) > debris (1). Debris can never steal a footstep, a door or a
  button; the player's sounds steal debris first. Loops are not voices.

## Sources

1. Valve Developer Community, "WAV" — https://developer.valvesoftware.com/wiki/WAV
2. Valve Developer Community, "ADPCM" (most HL1 effects 11 025 Hz; 22 050 max) — https://developer.valvesoftware.com/wiki/ADPCM
3. the303.org, "GoldSrc audio" tutorial (mono only; 11 025/22 050; loop cue points) — https://the303.org/tutorials/gold_audio.htm
4. id Software, Quake source, `WinQuake/snd_dma.c`, `sound.h` (GPL) — https://github.com/id-Software/Quake
5. Valve, Half-Life SDK: `common/const.h`, `pm_shared/pm_shared.c`, `dlls/sound.cpp` — https://github.com/ValveSoftware/halflife
6. Valve, Source SDK 2013, `src/game/server/physics.cpp` (PhysCollisionSound) — https://github.com/ValveSoftware/source-sdk-2013
7. Source SDK 2013, `src/public/vphysics_interface.h` (hard/soft thresholds); VDC "Material surface properties" — https://developer.valvesoftware.com/wiki/Material_surface_properties
8. van den Doel, Kry, Pai, "FoleyAutomatic", SIGGRAPH 2001 — https://www.cs.mcgill.ca/~kry/pubs/foleyautomatic/foleyautomatic.pdf
9. Klatzky, Pai, Krotkov, "Perception of material from contact sounds", Presence 9(4), 2000 — https://www.cs.ubc.ca/labs/lci/papers/docs2000/pai-KlaPai00.pdf
10. OpenAL Soft, `include/AL/efx-presets.h` (EAX/I3DL2 reverb presets) — https://github.com/kcat/openal-soft/blob/master/include/AL/efx-presets.h
11. Microsoft, DirectSound "Rolloff Factor" / minimum distance defaults — https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee418787(v=vs.85)
12. Make:, "Why do fluorescent lights buzz?" and HyperPhysics, "Magnetostriction" — https://makezine.com/article/maker-news/ask-make-why-do-flourescent-lights/ , https://hyperphysics.gsu.edu/hbase/Solids/magstrict.html
13. Farnell, _Designing Sound_ (MIT Press), practicals 21 (motors) and 23 (fans) — https://mitp-content-server.mit.edu/books/content/sectbyfn/books_pres_0/8375/designing_sound.zip/practical21.html
14. Half-Life 2 developer commentary (on HL1's hand-placed DSP nodes), via Combine OverWiki — https://combineoverwiki.net/wiki/Developer_commentary/Half-Life_2
15. Audiokinetic, "Loudness processing best practice, ch. 3" — https://blog.audiokinetic.com/loudness-processing-best-practice-chapter-3-scalable-loudness-processing-for-games/
16. Serafin, Turchet, Nordahl, ground-reaction-force footstep synthesis — https://vbn.aau.dk/ws/files/18424996/serafin_turchet_nordahl.pdf
17. CRI Middleware blog, "Advanced Footsteps" (heel/toe split) — https://blog.criware.com/?p=3604
18. MDN, `PannerNode.distanceModel` formulas — https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/distanceModel

Notes on the sources:

- Sources 2, 7 (wiki page), 11, 14 and 15 were read through search
  summaries, because the pages refused direct fetching.
- I found no developer statement about the audio of the recent co-op
  facility game, so nothing here relies on it.
- No game audio was downloaded or analysed.
