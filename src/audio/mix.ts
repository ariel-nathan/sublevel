/**
 * The one place where the overall sound of the set is dialled in:
 *
 * - `ERA`: the "late-90s sample playback" treatment applied to every
 *   one-shot after synthesis (band-limiting to a low sample rate with linear
 *   re-interpolation, optional bit-depth reduction).
 * - `LOUDNESS`: target levels per category; every recipe is normalised to
 *   its category's target, so categories stay in a fixed relationship.
 *
 * See DESIGN.md for the reasoning and sources.
 */
import type { SoundId } from "../core/api";
import { db, peakOf, shortTermMaxRms } from "./analysis";
import { applyChain, biquad } from "./dsp";

export interface EraTreatment {
  /**
   * Emulated playback sample rate for one-shots, in Hz. The waveform is
   * low-passed below this rate's Nyquist frequency, decimated, and linearly
   * re-interpolated to the output rate (the period's resampling method), which
   * leaves a little imaging grit above the cutoff. 0 disables. 22050 is the
   * period's "high quality" rate; 11025 is the common lower one and sounds
   * markedly duller.
   */
  rate: number;
  /** How much of the treated signal replaces the clean one, 0..1. */
  amount: number;
  /** Bit depth to quantise one-shots to (no dither, like the period). 0 disables. */
  bits: number;
}

export const ERA: EraTreatment = { rate: 22050, amount: 1, bits: 0 };

export type Category =
  | "footstep"
  | "body"
  | "impact"
  | "break"
  | "handling"
  | "button"
  | "door"
  | "plate"
  | "ambience";

export const CATEGORY_OF: Readonly<Record<SoundId, Category>> = {
  footstep_concrete: "footstep",
  footstep_tile: "footstep",
  footstep_metal: "footstep",
  land: "body",
  jump: "body",
  impact_wood: "impact",
  impact_metal: "impact",
  impact_plastic: "impact",
  crate_break: "break",
  pickup: "handling",
  throw: "handling",
  button_press: "button",
  button_deny: "button",
  door_open: "door",
  door_close: "door",
  plate_down: "plate",
  plate_up: "plate",
  hum_fluorescent: "ambience",
  hum_machine: "ambience",
  ambient_drone: "ambience",
};

export interface LoudnessTarget {
  /**
   * One-shots: loudest 50 ms RMS in dBFS (a "momentary loudness" that does
   * not depend on tail length). Loops: RMS of the whole loop in dBFS.
   */
  rmsDb: number;
  /** Sample peaks never exceed this (dBFS); a soft limiter enforces it. */
  peakDb: number;
}

/**
 * Buffer levels at gain 1. The game's own gains come on top (footsteps 0.5,
 * impacts 0.25..1, emitters 0.4..0.6). Ordering, loudest first: break >
 * impact (hard) > door > land > plate > footstep > button > handling > jump,
 * with ambience far below everything (see DESIGN.md, "Loudness").
 */
export const LOUDNESS: Readonly<Record<SoundId, LoudnessTarget>> = {
  crate_break: { rmsDb: -9, peakDb: -1 },
  impact_wood: { rmsDb: -10, peakDb: -1 },
  impact_metal: { rmsDb: -10, peakDb: -1 },
  impact_plastic: { rmsDb: -11, peakDb: -1.5 },
  door_open: { rmsDb: -12, peakDb: -2 },
  door_close: { rmsDb: -11, peakDb: -1.5 },
  land: { rmsDb: -12, peakDb: -2 },
  plate_down: { rmsDb: -13, peakDb: -3 },
  plate_up: { rmsDb: -15, peakDb: -4 },
  footstep_concrete: { rmsDb: -13, peakDb: -3 },
  footstep_tile: { rmsDb: -13, peakDb: -3 },
  footstep_metal: { rmsDb: -13, peakDb: -3 },
  button_press: { rmsDb: -15, peakDb: -4 },
  button_deny: { rmsDb: -15, peakDb: -5 },
  pickup: { rmsDb: -18, peakDb: -6 },
  throw: { rmsDb: -19, peakDb: -8 },
  jump: { rmsDb: -22, peakDb: -10 },
  hum_fluorescent: { rmsDb: -25, peakDb: -12 },
  hum_machine: { rmsDb: -23, peakDb: -10 },
  ambient_drone: { rmsDb: -26, peakDb: -12 },
};

// --- Candidate designs (listening round 1, see DESIGN.md) --------------------

/**
 * Sound families that have several competing designs. "current" is the
 * design a listener rejected in round 1; A, B and C are the alternatives.
 */
export type Family = "footsteps" | "impact_metal" | "crate_break";
export type Candidate = "current" | "A" | "B" | "C";

export const FAMILIES: readonly Family[] = [
  "footsteps",
  "impact_metal",
  "crate_break",
];
export const CANDIDATE_NAMES: readonly Candidate[] = ["current", "A", "B", "C"];

/** The sounds each family's choice switches together. */
export const FAMILY_SOUNDS: Readonly<Record<Family, readonly SoundId[]>> = {
  footsteps: ["footstep_concrete", "footstep_tile", "footstep_metal", "land"],
  impact_metal: ["impact_metal"],
  crate_break: ["crate_break"],
};

/**
 * Which design each family plays by default. The page URL can override it
 * without a code change: `?sfx=footsteps:B,impact_metal:C,crate_break:A`
 * (see `parseSfx`). Reasons for these defaults are in DESIGN.md
 * ("Listening round 1").
 */
export const CANDIDATES: Readonly<Record<Family, Candidate>> = {
  footsteps: "A",
  impact_metal: "A",
  crate_break: "C",
};

export type CandidateSelection = Record<Family, Candidate>;

/** The family a sound belongs to, or null for sounds with one design. */
export function familyOf(sound: SoundId): Family | null {
  for (const f of FAMILIES) if (FAMILY_SOUNDS[f].includes(sound)) return f;
  return null;
}

/** Short names accepted in `?sfx=` besides the family names themselves. */
const FAMILY_ALIASES: Readonly<Record<string, Family>> = {
  footsteps: "footsteps",
  footstep: "footsteps",
  steps: "footsteps",
  impact_metal: "impact_metal",
  metal: "impact_metal",
  crate_break: "crate_break",
  break: "crate_break",
};

/**
 * Parses a page query string (`location.search`, with or without the `?`)
 * for `sfx=family:candidate,...`. Case-insensitive; unknown families or
 * candidates, and malformed pairs, are ignored. Pure.
 */
export function parseSfx(search: string): Partial<CandidateSelection> {
  const out: Partial<CandidateSelection> = {};
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, " "));
      value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      continue;
    }
    if (key.trim().toLowerCase() !== "sfx") continue;
    for (const pair of value.split(",")) {
      const [rawFamily, rawCandidate, ...rest] = pair.split(":");
      if (rest.length || rawFamily === undefined || rawCandidate === undefined)
        continue;
      const family = FAMILY_ALIASES[rawFamily.trim().toLowerCase()];
      const c = rawCandidate.trim().toLowerCase();
      const candidate = CANDIDATE_NAMES.find((n) => n.toLowerCase() === c);
      if (family && candidate) out[family] = candidate;
    }
  }
  return out;
}

/** The `sfx=` value that reproduces a selection, e.g. "footsteps:B,...". */
export function formatSfx(selection: CandidateSelection): string {
  return FAMILIES.map((f) => `${f}:${selection[f]}`).join(",");
}

/**
 * Loudness of the new candidates where it departs from `LOUDNESS`.
 * Footsteps sit lower than the rejected design: a step plays two or three
 * times a second, the game already halves it, and the old -13 dB forced the
 * soft limiter to flatten every heel transient by 5-7 dB. Peak ceilings sit
 * above each design's natural crest so the limiter only catches stray tips.
 */
export const CANDIDATE_LOUDNESS: Readonly<
  Record<
    Exclude<Candidate, "current">,
    Partial<Record<SoundId, LoudnessTarget>>
  >
> = {
  A: {
    footstep_concrete: { rmsDb: -16, peakDb: -3 },
    footstep_tile: { rmsDb: -16, peakDb: -3 },
    footstep_metal: { rmsDb: -16, peakDb: -3 },
    land: { rmsDb: -13, peakDb: -1 },
    impact_metal: { rmsDb: -10.5, peakDb: -1 },
    crate_break: { rmsDb: -11.5, peakDb: -1 },
  },
  B: {
    footstep_concrete: { rmsDb: -15, peakDb: -1 },
    footstep_tile: { rmsDb: -15, peakDb: -1 },
    footstep_metal: { rmsDb: -15, peakDb: -1 },
    land: { rmsDb: -12, peakDb: -1 },
    impact_metal: { rmsDb: -9.5, peakDb: -1 },
    crate_break: { rmsDb: -11, peakDb: -1 },
  },
  C: {
    footstep_concrete: { rmsDb: -16, peakDb: -3 },
    footstep_tile: { rmsDb: -16, peakDb: -3 },
    footstep_metal: { rmsDb: -16, peakDb: -3 },
    land: { rmsDb: -13, peakDb: -2 },
    impact_metal: { rmsDb: -11, peakDb: -1 },
    crate_break: { rmsDb: -14, peakDb: -3 },
  },
};

/** Loudness target of a sound as rendered by a candidate design. */
export function loudnessFor(
  sound: SoundId,
  candidate: Candidate,
): LoudnessTarget {
  if (candidate === "current") return LOUDNESS[sound];
  return CANDIDATE_LOUDNESS[candidate][sound] ?? LOUDNESS[sound];
}

export interface CompressorSettings {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

/**
 * Bus settings for the Web Audio graph (index.ts):
 *
 *   one-shots -> sfx bus -> glue compressor --+
 *   loops ------> ambience bus ---------------+-> mix -> limiter -> master
 *   sends ------> room reverb ----------------+
 *
 * Ambience bypasses the glue compressor so a burst of impacts cannot pump
 * the hum down; the limiter only catches overs.
 */
export const BUSES = {
  master: 0.9,
  /** Reverb send for positional one-shots at reference distance. */
  reverbSend: 0.24,
  /** Reverb send for the player's own (non-positional) sounds. */
  playerReverbSend: 0.12,
  /** Reverb send for positional loops. */
  ambienceReverbSend: 0.1,
  sfxCompressor: {
    threshold: -16,
    knee: 8,
    ratio: 3,
    attack: 0.004,
    release: 0.25,
  } satisfies CompressorSettings,
  limiter: {
    threshold: -3,
    knee: 0,
    ratio: 20,
    attack: 0.001,
    release: 0.1,
  } satisfies CompressorSettings,
  /** Loops fade in and out over these times (s). */
  loopFadeIn: 0.8,
  loopFadeOut: 0.08,
} as const;

/** Voice-stealing priority per category (see voices.ts PRIORITY). */
export const PRIORITY_OF: Readonly<Record<Category, number>> = {
  footstep: 3,
  body: 3,
  handling: 3,
  button: 3,
  door: 3,
  plate: 3,
  break: 2,
  impact: 1,
  ambience: 3,
};

/** Applies `ERA` to a one-shot in place. */
export function applyEra(
  buf: Float32Array,
  sampleRate: number,
  era: EraTreatment = ERA,
): Float32Array {
  if (era.amount <= 0) return buf;
  const dry = era.amount < 1 ? buf.slice() : null;
  if (era.rate > 0 && era.rate < sampleRate) {
    // Anti-alias: 8th-order Butterworth low-pass at 45% of the emulated rate.
    const cutoff = era.rate * 0.45;
    applyChain(
      buf,
      biquad("lp", cutoff, 0.5098, sampleRate),
      biquad("lp", cutoff, 0.6013, sampleRate),
      biquad("lp", cutoff, 0.9, sampleRate),
      biquad("lp", cutoff, 2.5629, sampleRate),
    );
    // Decimate and re-interpolate linearly. The decimation reads between
    // samples (linearly) rather than taking the nearest one: at output rates
    // that are not a whole multiple of the emulated rate (48 kHz), picking the
    // nearest sample jitters the timing by up to half a sample, which adds
    // noise-like distortion (-24 dB at 2 kHz). At 44.1 kHz both are identical.
    const step = sampleRate / era.rate;
    const m = Math.floor((buf.length - 1) / step) + 1;
    const low = new Float32Array(m);
    const last = buf.length - 1;
    for (let k = 0; k < m; k++) {
      const x = k * step;
      const i0 = Math.min(last, Math.floor(x));
      const fr = x - i0;
      const a = buf[i0]!;
      low[k] = fr > 0 ? a + (buf[Math.min(last, i0 + 1)]! - a) * fr : a;
    }
    for (let i = 0; i < buf.length; i++) {
      const x = i / step;
      const k = Math.floor(x);
      const f = x - k;
      const p = low[Math.min(m - 1, k)]!;
      const q = low[Math.min(m - 1, k + 1)]!;
      buf[i] = p + (q - p) * f;
    }
  }
  if (era.bits > 0) {
    const levels = 2 ** (era.bits - 1);
    const peak = peakOf(buf) || 1;
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (Math.round((buf[i]! / peak) * levels) / levels) * peak;
    }
  }
  if (dry) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = dry[i]! * (1 - era.amount) + buf[i]! * era.amount;
    }
  }
  return buf;
}

/**
 * Scales `buf` so its level meets `target` (short-term max RMS for
 * one-shots, whole-buffer RMS for loops), then soft-limits any sample peaks
 * above the target peak. Returns the buffer.
 */
export function normalizeTo(
  buf: Float32Array,
  sampleRate: number,
  target: LoudnessTarget,
  loop: boolean,
): Float32Array {
  const ceiling = 10 ** (target.peakDb / 20);
  // Limiting lowers the level a little, so scale and limit a few times.
  for (let pass = 0; pass < 4; pass++) {
    const level = loop ? rmsAll(buf) : shortTermMaxRms(buf, sampleRate);
    if (level <= 1e-9) return buf;
    const error = target.rmsDb - db(level);
    if (pass > 0 && Math.abs(error) < 0.25) break;
    const gain = 10 ** (error / 20);
    for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * gain;
    softLimit(buf, ceiling);
  }
  return buf;
}

/**
 * Turns a recipe's raw output into the finished buffer, the same way for
 * every sound. One-shots: DC blocking, era treatment, trailing-silence trim,
 * fades, loudness normalisation. Loops: mean removal (periodicity is kept
 * exactly) and loudness normalisation.
 */
export function finishSound(
  sound: SoundId,
  raw: Float32Array,
  sampleRate: number,
  loop: boolean,
  era: EraTreatment = ERA,
  target: LoudnessTarget = LOUDNESS[sound],
): Float32Array {
  if (loop) {
    let m = 0;
    for (let i = 0; i < raw.length; i++) m += raw[i]!;
    m /= raw.length;
    for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! - m;
    return normalizeTo(raw, sampleRate, target, true);
  }
  applyChain(raw, biquad("hp", 25, 0.707, sampleRate));
  applyEra(raw, sampleRate, era);
  const buf = trimTail(raw, sampleRate, -70);
  let m = 0;
  for (let i = 0; i < buf.length; i++) m += buf[i]!;
  m /= buf.length;
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! - m;
  const fadeIn = Math.min(buf.length >> 2, Math.round(sampleRate * 0.0005));
  const fadeOut = Math.min(buf.length >> 1, Math.round(sampleRate * 0.012));
  for (let i = 0; i < fadeIn; i++) buf[i] = buf[i]! * (i / fadeIn);
  for (let i = 0; i < fadeOut; i++) {
    const k = buf.length - 1 - i;
    buf[k] = buf[k]! * (0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut));
  }
  return normalizeTo(buf, sampleRate, target, false);
}

/**
 * Cuts the buffer where its envelope has fallen `belowDb` under its peak for
 * good (plus a 15 ms margin). Returns a view-free copy.
 */
export function trimTail(
  buf: Float32Array,
  sampleRate: number,
  belowDb: number,
): Float32Array {
  const p = peakOf(buf);
  if (p <= 0) return buf;
  const threshold = p * 10 ** (belowDb / 20);
  let last = buf.length - 1;
  while (last > 0 && Math.abs(buf[last]!) < threshold) last--;
  const end = Math.min(buf.length, last + Math.round(0.015 * sampleRate));
  return buf.slice(0, Math.max(end, Math.round(0.02 * sampleRate)));
}

function rmsAll(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / Math.max(1, buf.length));
}

/**
 * Memoryless soft knee: linear below 60% of `ceiling`, then a tanh curve that
 * approaches but never reaches `ceiling`. Only touches the loudest samples
 * (transient tips), adding a little period-appropriate crunch.
 */
export function softLimit(buf: Float32Array, ceiling: number): void {
  if (peakOf(buf) <= ceiling) return;
  const knee = 0.6 * ceiling;
  const room = ceiling - knee;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    const a = Math.abs(x);
    if (a > knee)
      buf[i] = Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
  }
}
