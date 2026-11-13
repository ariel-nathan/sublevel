/**
 * One-shots added in round 2: the door timer's tick, a door straining
 * against an obstruction, and the completion cue at the exit. Built in the
 * idiom the first listening round accepted: shaped noise with rounded
 * attacks, crowds of heavily damped partials rather than a few clean modes.
 * Only the completion cue is tonal, because it is meant to be heard as a
 * signal. Pure and deterministic.
 */
import type { Rng } from "../core/rng";
import { TAU, samples } from "./dsp";
import {
  between,
  cluster,
  filter,
  layer,
  noiseEvent,
  type FilterSpec,
} from "./foley";
import { buffer } from "./modal";
import type { Recipe } from "./recipes";

/**
 * Door timer tick: a small relay or escapement behind the panel. A dry
 * armature click (noise, 0.6 ms rounded attack, 2-3.6 kHz), the housing's
 * soft "tock" under it (900 Hz band, 5 ms), a faint bounce 7 ms later and
 * a trace of low weight. About 60 ms, no pitch. Played at pitch 1.2 it is
 * shorter and brighter, which reads as more urgent.
 */
export const timerTick: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.09);
  const click = (
    attack: number,
    decay: number,
    filters: readonly FilterSpec[],
  ) => noiseEvent(sr, rng, { attack, decay, filters });
  layer(
    b,
    click(0.0006, 0.0018, [
      ["hp", 1400, 0.707],
      ["bp", 2900, 1.1],
      ["lp", 6500, 0.707],
    ]),
    sr,
    0,
    1,
  );
  layer(
    b,
    click(0.0009, 0.005, [
      ["bp", 900, 1.3],
      ["lp", 2400, 0.707],
    ]),
    sr,
    0.0004,
    0.55,
  );
  layer(
    b,
    click(0.0004, 0.0012, [
      ["bp", 3600, 1.4],
      ["lp", 7000, 0.707],
    ]),
    sr,
    0.0072,
    0.28,
  );
  layer(
    b,
    click(0.0015, 0.006, [
      ["bp", 210, 1],
      ["lp", 600, 0.707],
    ]),
    sr,
    0,
    0.3,
  );
  return b;
};

/** When the blocked door's edge meets the obstruction, seconds. */
export const BLOCK_HIT = 0.1;
/** When the drive lets go and backs off, seconds. */
export const BLOCK_RELEASE = 0.56;

/**
 * Door straining against an obstruction, then letting go:
 * - 0-0.1 s: the drive running as the door closes (motor tone, rail rumble);
 * - 0.1 s: the edge meets something: a dull, rounded knock (noise thud and
 *   a crowd of heavily damped slab partials, no ring);
 * - 0.1-0.56 s: the motor bogs down and strains: its tone sags and turns
 *   rough (a 40-50 Hz stall buzz), a gritty groan from the gearing swells;
 * - 0.56 s: the brake lets go with a small click, the motor briefly spins
 *   up as the load comes off, and air escapes; all gone by about 1.1 s.
 * Clearly mechanical and obstructed; no alarm tones.
 */
export const doorBlocked: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 1.15);
  const n = b.length;
  // Motor speed profile (0..1).
  const speed = (t: number): number => {
    if (t < BLOCK_HIT) return 0.85 + 0.15 * (t / BLOCK_HIT);
    if (t < BLOCK_HIT + 0.09) {
      const u = (t - BLOCK_HIT) / 0.09;
      return 1 - 0.78 * (u * u * (3 - 2 * u));
    }
    if (t < BLOCK_RELEASE) return 0.22 - 0.04 * ((t - BLOCK_HIT) / 0.46);
    if (t < BLOCK_RELEASE + 0.07)
      return 0.18 + 0.62 * ((t - BLOCK_RELEASE) / 0.07);
    return 0.8 * Math.exp(-(t - BLOCK_RELEASE - 0.07) / 0.09);
  };
  // How hard the motor is labouring (0..1): the stall.
  const strain = (t: number): number => {
    if (t < BLOCK_HIT + 0.02 || t > BLOCK_RELEASE + 0.03) return 0;
    const a = Math.min(1, (t - BLOCK_HIT - 0.02) / 0.06);
    const r = Math.min(1, (BLOCK_RELEASE + 0.03 - t) / 0.03);
    return Math.min(a, r) * (0.75 + 0.25 * ((t - BLOCK_HIT) / 0.46));
  };
  const motor = new Float32Array(n);
  const grind = new Float32Array(n);
  let phase = 0;
  let wobble = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = speed(t);
    const s = strain(t);
    // A little random wander in the motor's speed so it is never a clean
    // tone.
    wobble += (rng.next() - 0.5) * 0.004 - wobble * 0.0008;
    const f = 98 * (0.5 + 0.5 * v) * (1 + wobble);
    phase += (TAU * f) / sr;
    const tone =
      0.5 * Math.sin(phase) +
      0.3 * Math.sin(2 * phase + 0.3) +
      0.18 * Math.sin(3 * phase + 1.1) +
      0.06 * Math.sin(9 * phase);
    // Stall: the tone buzzes roughly at 40-50 Hz.
    const buzz =
      1 + 0.6 * s * Math.sin(TAU * 46 * t + 0.7 * Math.sin(TAU * 7 * t));
    const level = Math.sqrt(Math.max(0, v)) * (0.55 + 0.45 * s);
    motor[i] = tone * buzz * level;
    grind[i] = (rng.next() * 2 - 1) * (0.25 * Math.sqrt(Math.max(0, v)) + s);
  }
  filter(motor, sr, [
    ["hp", 50, 0.707],
    ["lp", 1400, 0.707],
  ]);
  filter(grind, sr, [
    ["hp", 120, 0.707],
    ["bp", 420, 0.8],
    ["lp", 1600, 0.707],
  ]);
  layer(b, motor, sr, 0, 0.32);
  layer(b, grind, sr, 0, 0.45);
  // The knock: dull and rounded.
  layer(
    b,
    noiseEvent(sr, rng, {
      attack: 0.003,
      decay: 0.035,
      filters: [
        ["bp", 115, 0.9],
        ["lp", 500, 0.707],
      ],
    }),
    sr,
    BLOCK_HIT,
    1,
  );
  layer(
    b,
    cluster(sr, rng, {
      count: 50,
      lo: 170,
      hi: 1800,
      spacing: "log",
      tilt: -0.5,
      material: { d: 25, c: 45 },
      scatter: 0.5,
      contact: 0.0025,
      length: 0.3,
    }),
    sr,
    BLOCK_HIT,
    0.45,
  );
  // Release: brake click, then air.
  layer(
    b,
    noiseEvent(sr, rng, {
      attack: 0.0005,
      decay: 0.0018,
      filters: [
        ["hp", 1200, 0.707],
        ["bp", 2600, 1.2],
        ["lp", 6500, 0.707],
      ],
    }),
    sr,
    BLOCK_RELEASE,
    0.3,
  );
  layer(
    b,
    noiseEvent(sr, rng, {
      attack: 0.012,
      decay: 0.09,
      filters: [
        ["hp", 1500, 0.707],
        ["lp", 6500, 0.707],
      ],
    }),
    sr,
    BLOCK_RELEASE + 0.01,
    0.32,
  );
  // A softer second contact as the slab eases back off the obstruction.
  layer(
    b,
    noiseEvent(sr, rng, {
      attack: 0.006,
      decay: 0.03,
      filters: [
        ["bp", between(rng, 140, 170), 0.9],
        ["lp", 500, 0.707],
      ],
    }),
    sr,
    BLOCK_RELEASE + 0.035,
    0.35,
  );
  return b;
};

/** Notes of the completion cue: [start s, Hz, 1/e decay s, level]. */
export const OBJECTIVE_NOTES: readonly (readonly [
  number,
  number,
  number,
  number,
])[] = [
  [0.06, 523.25, 0.3, 0.8],
  [0.22, 783.99, 0.3, 0.75],
  [0.4, 659.26, 0.55, 0.6],
  [0.4, 987.77, 0.55, 0.42],
];

/** A soft, rounded tone: sine with weak 2nd and 3rd harmonics. */
function softTone(
  out: Float32Array,
  sr: number,
  start: number,
  freq: number,
  decay: number,
  amp: number,
  rng: Rng,
): void {
  const s0 = Math.round(start * sr);
  const attack = 0.012;
  const len = Math.min(out.length - s0, samples(sr, attack + decay * 7));
  const p0 = rng.next() * TAU;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env =
      t < attack
        ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack)
        : Math.exp(-(t - attack) / decay);
    const ph = TAU * freq * t + p0;
    // Upper harmonics fade faster than the fundamental (a soft mallet).
    const h = Math.exp(-t / (decay * 0.4));
    const v =
      Math.sin(ph) + 0.16 * h * Math.sin(2 * ph) + 0.05 * h * Math.sin(3 * ph);
    out[s0 + i] = out[s0 + i]! + v * env * amp;
  }
}

/**
 * Completion cue for reaching the exit: an understated terminal/PA
 * acknowledgement. A soft filtered noise swell (a speaker opening) under
 * three quiet rounded tones: two single notes rising a fifth, then a
 * two-note chord (a major seventh arpeggio overall, C-G-E/B), each with a
 * 12 ms attack, through a small-speaker band (250 Hz-4 kHz). About 1.5 s.
 * Original; built not to quote any known jingle.
 */
export const objective: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 1.6);
  const swell = noiseEvent(sr, rng, {
    attack: 0.22,
    decay: 0.18,
    filters: [
      ["bp", 700, 0.8],
      ["lp", 2200, 0.707],
    ],
  });
  layer(b, swell, sr, 0, 0.09);
  const tones = new Float32Array(b.length);
  for (const [start, hz, decay, amp] of OBJECTIVE_NOTES)
    softTone(tones, sr, start, hz, decay, amp, rng);
  layer(b, tones, sr, 0, 0.5);
  return filter(b, sr, [
    ["hp", 250, 0.707],
    ["lp", 4000, 0.707],
  ]);
};
