/**
 * Building blocks for the round-1 candidate designs (candidates.ts). They
 * lean on shaped noise rather than clean sines, because short contact sounds
 * (steps, clanks, cracks) are heard mostly as noise with a spectral shape:
 *
 * - `noiseEvent`: noise times an envelope with a smooth (raised-cosine)
 *   attack, filtered after enveloping, so the onset is shaped by the filters
 *   too and never starts with a hard edge.
 * - `grains`: many tiny band-passed noise grains (splintering, grit).
 * - `cluster`: a dense bank of randomly placed, individually damped partials
 *   (a struck metal object's crowded, irregular modes), excited by a contact
 *   pulse.
 * - `knock`: a few damped partials at random, non-harmonic ratios (a small
 *   piece of wood hitting the floor).
 *
 * Every block renders into its own buffer and is mixed in with `layer`,
 * scaled so its loudest 10 ms RMS equals `amp`: layer levels are then
 * comparable no matter how they were made. Pure and deterministic.
 */
import type { Rng } from "../core/rng";
import { applyChain, biquad, samples, type BiquadMode } from "./dsp";
import { contactPulse, resonate, type Material, type Mode } from "./modal";

/** [mode, Hz, Q, gainDb?] for `biquad`. */
export type FilterSpec = readonly [BiquadMode, number, number, number?];

export function filter(
  buf: Float32Array,
  sr: number,
  filters: readonly FilterSpec[],
): Float32Array {
  return applyChain(
    buf,
    ...filters.map(([m, f, q, g]) => biquad(m, f, q, sr, g ?? 0)),
  );
}

/** Loudest RMS over a 10 ms window (2 ms hop). */
export function level10(buf: Float32Array, sr: number): number {
  const w = Math.max(1, Math.round(0.01 * sr));
  const hop = Math.max(1, Math.round(0.002 * sr));
  if (buf.length <= w) {
    let s = 0;
    for (const v of buf) s += v * v;
    return Math.sqrt(s / Math.max(1, buf.length));
  }
  // Running sum of squares.
  let s = 0;
  for (let i = 0; i < w; i++) s += buf[i]! * buf[i]!;
  let best = s;
  for (let i = w; i < buf.length; i++) {
    s += buf[i]! * buf[i]! - buf[i - w]! * buf[i - w]!;
    if ((i - w) % hop === 0 && s > best) best = s;
  }
  return Math.sqrt(Math.max(0, best) / w);
}

/** Adds `src` into `out` at `at` seconds, scaled to a 10 ms level of `amp`. */
export function layer(
  out: Float32Array,
  src: Float32Array,
  sr: number,
  at: number,
  amp: number,
): void {
  const l = level10(src, sr);
  if (l <= 1e-12 || amp === 0) return;
  const g = amp / l;
  const start = Math.round(at * sr);
  for (let i = 0; i < src.length; i++) {
    const j = start + i;
    if (j < 0 || j >= out.length) continue;
    out[j] = out[j]! + src[i]! * g;
  }
}

/** Adds `src` into `out` at `at` seconds with a plain gain. */
export function addAt(
  out: Float32Array,
  src: Float32Array,
  sr: number,
  at: number,
  gain = 1,
): void {
  const start = Math.round(at * sr);
  for (let i = 0; i < src.length; i++) {
    const j = start + i;
    if (j >= 0 && j < out.length) out[j] = out[j]! + src[i]! * gain;
  }
}

export interface EnvelopeOptions {
  /** Raised-cosine rise time, seconds. */
  attack: number;
  /** Time at full level after the attack, seconds. */
  hold?: number;
  /** Exponential 1/e decay time after the hold, seconds. */
  decay: number;
}

/** Envelope value at t seconds. */
export function envelopeAt(t: number, e: EnvelopeOptions): number {
  if (t < 0) return 0;
  if (t < e.attack) return 0.5 - 0.5 * Math.cos((Math.PI * t) / e.attack);
  const h = e.hold ?? 0;
  if (t < e.attack + h) return 1;
  return Math.exp(-(t - e.attack - h) / e.decay);
}

export interface NoiseEventOptions extends EnvelopeOptions {
  /** Applied after the envelope, in order. */
  filters: readonly FilterSpec[];
}

/**
 * Enveloped white noise, then filtered. Length is attack + hold + 7 decays
 * (-60 dB) plus a little room for the filters to ring out. Unscaled: mix it
 * with `layer`.
 */
export function noiseEvent(
  sr: number,
  rng: Rng,
  o: NoiseEventOptions,
): Float32Array {
  const body = o.attack + (o.hold ?? 0) + o.decay * 7;
  const n = samples(sr, body + 0.015);
  const x = new Float32Array(n);
  const end = samples(sr, body);
  for (let i = 0; i < end; i++) {
    const t = i / sr;
    // Final 15% of the body fades to zero so nothing is cut off.
    const u = i / end;
    const fade =
      u > 0.85 ? 0.5 + 0.5 * Math.cos(((u - 0.85) / 0.15) * Math.PI) : 1;
    x[i] = (rng.next() * 2 - 1) * envelopeAt(t, o) * fade;
  }
  return filter(x, sr, o.filters);
}

export interface GrainOptions {
  /** Seconds the grain cloud lasts. */
  dur: number;
  /** Grains per second at u = t / dur in [0, 1]. */
  rate: (u: number) => number;
  /** Grain level at u (before random scatter). */
  level: (u: number) => number;
  /** Grain length range, seconds. */
  length: readonly [number, number];
  /** Band-pass centre range, Hz (drawn log-uniformly). */
  centre: readonly [number, number];
  q: number;
}

/**
 * A cloud of tiny Hann-windowed, band-passed noise grains with a
 * time-varying density. Unscaled: mix it with `layer`.
 */
export function grains(sr: number, rng: Rng, o: GrainOptions): Float32Array {
  const out = new Float32Array(samples(sr, o.dur + o.length[1] + 0.01));
  const steps = samples(sr, o.dur);
  const dt = 1 / sr;
  for (let i = 0; i < steps; i++) {
    const u = i / steps;
    if (rng.next() >= o.rate(u) * dt) continue;
    const len = samples(
      sr,
      o.length[0] + rng.next() * (o.length[1] - o.length[0]),
    );
    const centre = o.centre[0] * (o.centre[1] / o.centre[0]) ** rng.next();
    const bp = biquad("bp", centre, o.q, sr);
    const amp = o.level(u) * (0.35 + 0.65 * rng.next());
    // Grain plus a short ring-out of its filter.
    const ring = Math.round(len * 0.6);
    for (let k = 0; k < len + ring; k++) {
      const w = k < len ? 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / len) : 0;
      const v = bp((rng.next() * 2 - 1) * w) * amp;
      const j = i + k;
      if (j < out.length) out[j] = out[j]! + v;
    }
  }
  return out;
}

export interface ClusterOptions {
  /** Number of partials. */
  count: number;
  /** Frequency range, Hz. */
  lo: number;
  hi: number;
  /** "log": uniform in log frequency; "lin": uniform in Hz (denser up high). */
  spacing: "log" | "lin";
  /** Gain ~ (f / 1 kHz)^tilt, times a random (Rayleigh) factor. */
  tilt: number;
  /** Base damping; each partial's d and c are scattered by `scatter`. */
  material: Material;
  /** 0..1: each partial's decay time varies by up to this fraction. */
  scatter: number;
  /** Contact time, seconds (short = bright). */
  contact: number;
  /** Seconds of output to render. */
  length: number;
  pitch?: number;
}

/** Draws the partials of a cluster (so re-strikes can reuse them). */
export function clusterModes(
  rng: Rng,
  o: Pick<ClusterOptions, "count" | "lo" | "hi" | "spacing" | "tilt">,
): Mode[] {
  const modes: Mode[] = [];
  for (let k = 0; k < o.count; k++) {
    const u = rng.next();
    const freq =
      o.spacing === "log"
        ? o.lo * (o.hi / o.lo) ** u
        : o.lo + (o.hi - o.lo) * u;
    const rayleigh = Math.sqrt(-2 * Math.log(1 - rng.next() * 0.999));
    modes.push({ freq, gain: rayleigh * (freq / 1000) ** o.tilt });
  }
  return modes;
}

/**
 * A struck bank of partials, each damped by its own scattered material
 * (so they do not all fade together like one bell). Unscaled.
 */
export function strikeModes(
  sr: number,
  rng: Rng,
  modes: readonly Mode[],
  o: Pick<
    ClusterOptions,
    "material" | "scatter" | "contact" | "length" | "pitch"
  > & {
    roughness?: number;
  },
): Float32Array {
  const out = new Float32Array(samples(sr, o.length));
  const pulse = contactPulse(sr, o.contact, rng, o.roughness ?? 0.3);
  for (const m of modes) {
    const s = 1 + o.scatter * (rng.next() * 2 - 1);
    resonate(
      pulse,
      out,
      sr,
      [m],
      { d: o.material.d * s, c: o.material.c / s },
      {
        pitch: o.pitch ?? 1,
      },
    );
  }
  // Fade the last 10% so a long-ringing partial is not cut off abruptly.
  const f = Math.round(out.length * 0.1);
  for (let i = 0; i < f; i++) {
    const k = out.length - 1 - i;
    out[k] = out[k]! * (0.5 - 0.5 * Math.cos((Math.PI * i) / f));
  }
  return out;
}

/** `clusterModes` + `strikeModes` in one call. */
export function cluster(sr: number, rng: Rng, o: ClusterOptions): Float32Array {
  return strikeModes(sr, rng, clusterModes(rng, o), o);
}

/**
 * Modes of a small piece of wood or a plank: `count` partials above `f0` at
 * random, non-harmonic ratios (roughly bar-like spacing, never the tidy
 * free-bar ratios that sound like a xylophone).
 */
export function pieceModes(rng: Rng, f0: number, count = 5): Mode[] {
  const modes: Mode[] = [{ freq: f0, gain: 1 }];
  let r = 1;
  for (let k = 1; k < count; k++) {
    r *= 1.45 + rng.next() * 0.9;
    modes.push({
      freq: f0 * r,
      gain: (0.75 + rng.next() * 0.5) / (k + 1) ** 0.7,
    });
  }
  return modes;
}

/** Same modes from a different strike point: gains reshuffled a little. */
export function restrike(
  rng: Rng,
  modes: readonly Mode[],
  spread = 0.5,
): Mode[] {
  return modes.map((m) => ({
    freq: m.freq,
    gain: m.gain * Math.max(0.05, 1 + spread * (rng.next() * 2 - 1)),
  }));
}

/** Low-pass the whole buffer (in place). */
export function darken(
  buf: Float32Array,
  sr: number,
  hz: number,
): Float32Array {
  return filter(buf, sr, [["lp", hz, 0.707]]);
}

/** Uniform in [lo, hi). */
export function between(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng.next();
}

/** Log-uniform in [lo, hi). */
export function logBetween(rng: Rng, lo: number, hi: number): number {
  return lo * (hi / lo) ** rng.next();
}
