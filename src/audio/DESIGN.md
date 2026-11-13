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

## Listening round 1

A person listened in `demos/audio.html` for the first time. The complete
feedback was: "walking really bad", "impact metal bad", "crate break bad".
Nothing else was criticised. Below is what most plausibly causes each
complaint, ranked, checked against the code and the spectrograms
(`bun src/audio/preview.ts`), and the three alternatives built for each
family. Everything in this section is **[I]** unless tagged.

New measuring tools (`analysis.ts`), used throughout:

- `tonalPeak(eventSpectrum(takes))`: how far the most prominent narrow peak
  stands above its 2/3-octave neighbourhood, over the spectra of all takes
  of a sound. What repeats from take to take is what becomes "the pitch" of
  a sound heard every 0.39 s. Shaped noise reads 4–7 dB; a ringing mode
  reads 15–30 dB.
- `kLoudnessDb`: loudest 50 ms RMS after an approximate K-weighting (the
  BS.1770 pre-filter), to compare dull and bright sounds fairly.

### Diagnosis

**Footsteps** ("really bad"):

1. **A pitch that repeats twice a second.** Every surface was built from
   resonating sine modes: sole modes at 160–2100 Hz, tile modes at
   1.8–5.9 kHz, and on the grate ten modes ringing for 312 ms (flatness
   0.00). Takes only moved those modes by ±1 %, so every step had the same
   pitch. The game then varies pitch by ±4 % at random, which turns the
   repeated pitch into a wandering tune. Tonal peak: tile 19 dB, grate
   28 dB, concrete 8.6 dB. Real steps on hard floors are short band-limited
   noise with almost no pitch.
2. **Hard clicks, twice.** Contact pulses of 0.2–1.6 ms and noise bursts
   with 0.2 ms attacks give attacks under 1 ms. The heel and the ball of the
   foot were two separate hard strikes 34–58 ms apart, so each step was a
   "click-click". The "weight" was a pure 95–130 Hz sine, which reads as a
   bloop.
3. **Too loud, and distorted by the limiter.** Footsteps sat at −13 dB
   (rms50), 3 dB under impacts, for a sound that plays 2.6 times a second.
   At that level the raw heel transient peaks 2–4 dB above full scale, so
   the soft limiter (knee at −7.4 dBFS) flattened every heel by 5–7 dB: a
   waveshaped, crunchy click on every step. Measured by re-rendering without
   the limiter.
4. **Ticking grit.** The concrete grit was sparse single-sample impulses at
   2600 per second: ticks rather than grain.

**Metal impact** ("bad"):

1. **It is a bell.** 19 clean, exponentially decaying sines at fixed
   frequencies with d = 220 ring to −40 dB in 935 ms. Tonal peak 28.6 dB.
   The deliberate near-degenerate pairs add the shimmer of a chime. The
   metal prop is a 60 kg steel case (`crate_metal`) on concrete: the floor
   damps it, and most of the energy is gone in 0.2–0.35 s.
2. **Too few, too tidy partials.** A real struck case has hundreds of
   crowded, irregular modes whose highs die much faster than the lows. 19
   modes read as an instrument.
3. **A thin hit.** The contact transient was a 3 ms high-passed (2.5 kHz)
   noise tick over a pure 120→85 Hz sine thump. The three micro-collisions
   inside 15 ms merge into the attack instead of reading as rattle.
4. The 1 s room reverb (send 0.24) stretches the ring further.

**Crate break** ("bad"):

1. **A xylophone at the end.** The 12 falling planks used the exact
   free-free bar mode ratios 1 : 2.76 : 5.4 : 8.93, which are the ratios of
   xylophone and marimba bars. Late pieces were isolated pitched "plinks";
   tonal peak 15.7 dB, visible as horizontal lines in the spectrogram.
2. **Static, not splinters.** The fracture was a dense 1.2–9.5 kHz
   white-noise wash plus 5000 clicks per second for 0.45 s. It reads as
   hiss or an explosion rather than wood tearing.
3. **Boom.** A 120→70 Hz sine thump and crate modes at 112–341 Hz put 42 %
   of the energy in 80–250 Hz. It was also the loudest one-shot (−9 dB),
   with peaks limited by about 2.5 dB.

**Things that affect all three:**

- **The era resampler distorted at 48 kHz** (most browsers on Windows run at
  48 kHz). It decimated by taking the nearest sample. At a non-integer ratio
  that jitters timing by up to half a sample, adding inharmonic noise: a
  500 Hz sine came out with a −36 dB residual (−58 dB when interpolated), a
  2 kHz sine with −24 dB (−37.5 dB). Fixed in `applyEra`: decimation now
  interpolates linearly. At 44.1 kHz the output is bit-identical, so every
  existing measurement stands.
- **Soft limiter.** Harmless when a design's natural crest fits under its
  ceiling, audible when the level target forces it to work (see footsteps).
  The new designs' ceilings sit above their natural crest.
- **Loudness normalisation** works on the loudest 50 ms, so it does not lift
  tails or noise floors. That is fine as it is.
- **Reverb send** is fine for short sounds. It mattered only for the ringing
  metal.
- **Takes.** In the old designs takes differed too little: the same modes,
  so the same pitch every time. The new designs draw every element afresh
  per take, so takes differ in detail and keep the same character.

### Candidates

Each family has `current` (the rejected design, kept for comparison) and
three new designs, which differ in approach and not just in parameters.
Code: `candidates.ts`, with building blocks in `foley.ts` (enveloped and
then filtered noise, grain clouds, dense damped partial clusters, wood
knocks at random non-harmonic ratios). Numbers are for take 0 at 44.1 kHz.
Tonal is measured over all takes. rms50 and K are dBFS.

| family | design                 | approach                                                                                                                                                                                         | dur (s)   | d40 (ms) | onset centroid (Hz) | tonal (dB) | rms50 / K    |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------- | ------------------- | ---------- | ------------ |
| steps  | A soft boot            | Noise only: low band-passed thump (115–155 Hz) with a 5 ms raised-cosine attack, a softer ball-of-foot roll 30–45 ms later, a quiet scuff (1.4/2.5/1.7 kHz); grate adds noisy rattle bursts      | 0.12–0.16 | 79–92    | 530 / 735 / 408     | 4.3–5.8    | −16 / −16    |
| steps  | B hard sole            | Unpitched 1.5 ms heel tick, firmer thump, louder scuff, fine grit grains; tile adds a short broad knock; grate is a 50-partial damped clank with two re-contacts                                 | 0.12–0.19 | 81–113   | 1285 / 1137 / 590   | 4.0–7.6    | −15 / −13.5  |
| steps  | C muffled / heavy      | Noise thump at 90–110 Hz, 7 ms attack, faint low scuff, everything low-passed at 2 kHz; grate is a hollow 70 Hz thud with a little rattle                                                        | 0.17–0.26 | 101–120  | 152 / 211 / 130     | 4.1–4.4    | −16 / −17    |
| steps  | current                | Modal sole knocks, tile clicks, ringing grate                                                                                                                                                    | 0.11–0.32 | 69–312   | 1297 / 1615 / 782   | 8.6–28.2   | −13 / −12    |
| metal  | A clank                | 140 partials drawn at random (40 log-spaced 170–1500 Hz, 100 linear 0.8–7.5 kHz), each with scattered damping (d 50, c 14); wide-band contact noise, floor thud, two re-contacts (rattle)        | 0.38      | 214      | 866                 | 6.7        | −10.5 / −9.6 |
| metal  | B hollow drum          | Six heavily damped low shell modes (~130–420 Hz, jittered per take) under a noisy clatter and a 60-partial short crowd; air "boom"; the rim comes down 50–80 ms later                            | 0.64      | 338      | 268                 | 11.3       | −9.5 / −10.2 |
| metal  | C case thud            | Mostly noise: 170 Hz thud and 1.2 kHz slap, a brief 40-partial edge (1.5–6.5 kHz, c 45), two tiny rattle bursts                                                                                  | 0.15      | 94       | 377                 | 4.4        | −11 / −11    |
| metal  | current                | 19 clean modes, d 220                                                                                                                                                                            | 1.20      | 935      | 756                 | 28.6       | −10 / −9.5   |
| break  | A crack and scatter    | Two dry cracks (sharp edge plus a 1.5–2.8 kHz body, 7–11 ms), the crate's box modes jittered and damped, then 18 wood knocks (random non-harmonic partials plus a click) thinning out over 0.5 s | 0.57      | 528      | 1978                | 5.9        | −11.5 / −9.6 |
| break  | B short snap           | One crack, a damped wooden thunk and noise thump, four debris ticks within 0.3 s                                                                                                                 | 0.35      | 313      | 802                 | 8.1        | −11 / −9.6   |
| break  | C splinter and clatter | Crack, then a sparse, uneven grain cloud of snaps (900/s at most, swelling for 40 ms), then 7 planks landing with bounces over 0.9 s                                                             | 0.90      | 826      | 2111                | 7.0        | −14 / −11.8  |
| break  | current                | Noise wash, crackle, bar-ratio planks                                                                                                                                                            | 0.78      | 673      | 876                 | 15.7       | −9 / −9.1    |

**Levels.** Footsteps now sit lower: −16 dB (A, C) and −15 dB (B), from
−13 dB. They play 2–3 times a second and the game halves them, so they
should be the quietest repeated cue. The old level also forced the limiter
to clip every heel. Land moves with them (−13/−12/−13). Metal stays near
its old K-weighted level. The breaks are set by K-weighted loudness: A and B
land 0.5 dB under the old break, and C (the long one) 2.7 dB under, as its
brief asked. Peak ceilings sit above each design's natural crest.

**Defaults** (`CANDIDATES` in `mix.ts`): A, A, A.

- **Footsteps A.** The most likely causes of the complaint are pitch and
  hard clicks, and A removes both completely while staying understated. B is
  the fallback if A turns out too dull; C if the listener wants weight.
- **Metal A.** It keeps a recognisably metallic identity (a crowd of
  partials, a hard contact) while losing the bell. C may stop sounding like
  metal. B is a drum, and the prop is a case.
- **Break A.** Discrete, woody events, with no wash and no xylophone, at a
  medium length. B is the fallback if it is too busy, C if the listener wants
  more of it.

**Selecting.** `CANDIDATES` holds the defaults. Any page URL overrides them
with `?sfx=footsteps:B,impact_metal:C,crate_break:A` (case-insensitive;
`metal`, `break` and `steps` also work; unknown entries are ignored). The
same string works on the game (`index.html?sfx=...`) and on the demo. The
demo's candidates section switches designs without a reload and shows the
string to paste. Only the selected design is rendered at start-up: all
takes of the default set take about 280 ms at 48 kHz.

**Previews.** `bun src/audio/preview.ts --candidates` writes every design
to `out/audio/cand/`: one PNG and WAV per sound, an 8-step walk at the
game's cadence (`walk_*.png`), and a contact sheet. It also prints the
table above.

## Round 2: contact loops, occlusion, rooms, new cues

Everything here is **[I]** unless tagged, and is built in the idiom round 1
accepted: shaped noise, irregular events, no clean ringing modes.

### Contact loops (`contact.ts`)

Four loops of 2^18 samples (5.9 s at 44.1 kHz, 5.5 s at 48 kHz). The game
glides their gain and playback rate continuously, so each must work from a
whisper to full level and at rates 0.6–1.6.

- **Built circularly, so they are exactly seamless.** Events that run past
  the end wrap to the start. Every filter is first run over the last 0.25 s
  of the loop, so it reaches sample 0 in the state it would have after
  sample n−1 (`circularFilter`). Drifts use 4–60 whole cycles per loop.
- **Then two clean-ups.** `deswell` divides out any 1–3 cycles-per-loop
  swell, which random event clustering leaves behind; the gain curve
  changes over seconds. `startInLull` rotates the loop so that it starts
  in its quietest 10 ms.
- **Friction.** A noise bed whose level flickers (random, low-passed at
  25–110 Hz), plus stick-slip chatter: Poisson bursts whose rate drifts.
  Each burst is a short noise grain band-passed at its own random centre.
  Played faster, the chatter gets denser and brighter but never turns into
  a buzz, because nothing in it is regular.

| loop           | design                                                                                                                                                                                                                | centroid | tonal @0.6/1/1.6 (dB) | envelope spread | render (48 kHz) |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- | --------------- | --------------- |
| scrape_wood    | 0.26–3.2 kHz bed flickering to 35 Hz; ~45 slips/s at 0.35–1.6 kHz; ~7 heavier catches/s at 170–420 Hz (the crate body); fine grit grains at 1.8–5 kHz; low-passed at 6.5 kHz                                          | 1.4 kHz  | 1.5 / 1.5 / 1.8       | 4.4 dB          | ~65 ms          |
| scrape_metal   | 0.65–8 kHz grinding bed flickering to 110 Hz; ~90 bright slips/s at 1.1–5 kHz; a low thrum; a squeal (Q 14 band plus one at 1.47×, centre wandering ±0.45 octave around ~2 kHz, in only 5 swells per loop, low level) | 3.3 kHz  | 2.5 / 2.2 / 3.2       | 4.7 dB          | ~50 ms          |
| scrape_plastic | Quieter 0.4–4.5 kHz bed; ~28 softer scuffs/s; two broad shell resonances (650 Hz, 1.5 kHz, +5/+6 dB); brief skips where the level dips by ~10 dB for 40–120 ms                                                        | 1.6 kHz  | 3.2 / 3.1 / 3.2       | 6.9 dB          | ~30 ms          |
| roll_metal     | 35–300 Hz rumble that undulates; a quiet rolling band around 600 Hz; ~2.5 soft knocks/s, never closer than 0.12 s apart, each a 5 ms-attack thud with a faint crowd of 24 damped partials drawn afresh                | 0.2 kHz  | 5.3 / 1.3 / 1.6       | 9.0 dB          | ~35 ms          |

- **Levels** (whole-loop RMS at gain 1): wood −20, metal −21, plastic
  −22.5, roll −20 dBFS. That is 10 dB or more under the impacts that start
  and end a push. The game's gain from `contactLoopParams` (at most about
  0.95) comes on top.
- **Mapping** (`contactLoopParams` in `contactVoices.ts`):
  - Level = (1 − e^(−(v − 0.08)/0.35)) × (0.25 + p), where
    p = F / (F + 250 N). The loop is silent at or below 0.08 m/s; the level
    is 29 % at 0.2 m/s and 70 % at 0.5 m/s.
  - Pitch = 0.8 + 0.45 × (rise with speed), × (1.12 − 0.25 p), so heavier
    sounds slightly lower. Rolls rise more slowly and their pitch range is
    wider.
- **Voices** (`createContactVoicePool`):
  - 4 voices. Only a contact whose target gain is at least 0.03 can claim
    a voice.
  - A voice keeps its body until that body stops. Another contact can take
    it only if it is at least 2× louder and the voice has played for at
    least 0.3 s. The voice then fades out over 40 ms before it is handed
    over.
  - Gain is smoothed with 30 ms attack and 120 ms release, pitch over
    80 ms.
  - Scrape and roll switch only after the other kind has been 1.5× louder
    for 120 ms. The switch cross-fades between the voice's two loops.
  - A voice is free again once its gain falls below 0.002, after one final
    zero.
  - Each body gets a fixed ±3 % detune.
- **Silence costs nothing.** A loop at gain 0 fades out, stops and releases
  every node; the next non-zero gain starts it again at a new offset.
  Loops never use voice-limiter slots.

### Occlusion (`voices.ts`)

`occlusionParams(o)`:

- Direct sound: low-passed from 20 kHz down to 800 Hz
  (cutoff = 20000 · (800/20000)^(o^0.75)), and turned down by up to
  −14 dB.
- Reverb send: drops only 5 dB, so the wet/dry ratio rises by 9 dB at
  full occlusion.
- Graph: the send is tapped before the occlusion stage, and changes glide
  smoothly.

`measureOcclusion` casts four rays: the direct ray (weighted ½) and three
rays 0.6 m beside and above the source (⅙ each). A dead zone of 0.2 is
removed, so one grazing ray does nothing.

### Rooms (`rooms.ts`)

Four procedural impulse responses, generated once per rate and cached. All
four take about 25–45 ms to generate. They are scaled from the EAX-era
presets **[S10]**: room 0.4 s, hallway 1.5 s. Measured T20 at 44.1 kHz:

| room     | RT60 low/mid/high (s) | pre-delay | measured T20 | character                                                                | wet |
| -------- | --------------------- | --------- | ------------ | ------------------------------------------------------------------------ | --- |
| small    | 0.32 / 0.28 / 0.22    | 2 ms      | 0.26 s       | dense reflections within 14 ms, bright                                   | 0.5 |
| lab      | 0.62 / 0.55 / 0.40    | 5 ms      | 0.52 s       | slightly bright                                                          | 0.7 |
| corridor | 1.3 / 1.1 / 0.5       | 8 ms      | 1.07 s       | darker; flutter echo every 13.5 ms (walls ~2.3 m apart) dying in ~0.25 s | 0.9 |
| hall     | 2.3 / 1.8 / 0.8       | 20 ms     | 2.1 s        | slow 70 ms build-up, low-mid heavy, dull reflections                     | 1.0 |

- A room change cross-fades two convolvers over 0.4 s.
- "corridor" is the default outside every zone; it replaces the single
  0.85 s room.
- `roomAt` adds 0.4 m of hysteresis at zone boundaries, so standing in a
  doorway does not flip the reverb.

### New one-shots (`cues.ts`)

| sound        | design                                                                                                                                                                                                            | dur    | rms50 / K (dBFS) | tonal           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | --------------- |
| timer_tick   | Relay tick: noise click (0.6 ms rounded attack, 2.9 kHz band), a soft 900 Hz "tock", a faint bounce 7 ms later and a trace of low weight; at pitch 1.2 shorter and brighter                                       | 0.05 s | −19 / −16.3      | 6 dB            |
| door_blocked | Motor running, then at 0.1 s a dull rounded knock (noise thud and 50 damped partials). The motor sags and buzzes roughly (46 Hz) with a gritty groan; at 0.56 s a brake click, a brief spin-up and an air release | 1.15 s | −12.5 / −13      | 7 dB            |
| objective    | Soft speaker-band noise swell under C5, G5 and then an E5+B5 chord. The tones are rounded (12 ms attack, harmonics fading fast) through a 250 Hz–4 kHz band. An original major-seventh outline                    | 1.6 s  | −17 / −16.7      | tonal by design |

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
