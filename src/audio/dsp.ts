/**
 * Small DSP toolbox operating on plain Float32Arrays. Pure: no Web Audio, no
 * globals. Everything is parameterised in seconds/Hz so recipes are sample-rate
 * independent.
 */
import type { Rng } from "../core/rng";

export const TAU = Math.PI * 2;

/** Number of samples for a duration in seconds (at least 1). */
export function samples(sampleRate: number, seconds: number): number {
  return Math.max(1, Math.round(sampleRate * seconds));
}

/** White noise in [-1, 1). */
export function whiteNoise(rng: Rng, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

export type FilterMode = "lp" | "hp" | "bp";

/** Stateful sample filter: feed it a sample and the cutoff for that sample. */
export type SweepFilter = (x: number, cutoff: number) => number;

/**
 * Chamberlin state-variable filter, run 2x oversampled so it stays stable
 * and accurate up to roughly 0.2 * sampleRate. The cutoff can change every
 * sample (used for sweeps). `q` should be >= 0.8.
 */
export function makeFilter(
  mode: FilterMode,
  q: number,
  sampleRate: number,
): SweepFilter {
  let low = 0;
  let band = 0;
  const damp = 1 / Math.max(0.8, q);
  const fs = sampleRate * 2;
  const maxCutoff = fs * 0.1;
  return (x, cutoff) => {
    const f =
      2 * Math.sin((Math.PI * Math.min(Math.max(cutoff, 5), maxCutoff)) / fs);
    let high = 0;
    for (let k = 0; k < 2; k++) {
      low += f * band;
      high = x - low - damp * band;
      band += f * high;
    }
    return mode === "lp" ? low : mode === "hp" ? high : band;
  };
}

/** Filters a whole buffer with a fixed cutoff (fresh state), returning a new buffer. */
export function filtered(
  input: Float32Array,
  mode: FilterMode,
  cutoff: number,
  q: number,
  sampleRate: number,
): Float32Array {
  const f = makeFilter(mode, q, sampleRate);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = f(input[i]!, cutoff);
  return out;
}

/**
 * Runs a sample filter over the buffer as if it were periodic: two warm-up
 * passes carry the filter state around the loop, the third is returned, so the
 * end joins the start without a seam.
 */
export function filterCyclic(
  input: Float32Array,
  f: (x: number, i: number) => number,
): Float32Array {
  const out = new Float32Array(input.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < input.length; i++) out[i] = f(input[i]!, i);
  }
  return out;
}

export function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / Math.max(1, buf.length));
}

export function mean(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]!;
  return sum / Math.max(1, buf.length);
}

export function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}

/** Scales a buffer to unit RMS (no-op for silence). */
export function normalizeRms(buf: Float32Array): Float32Array {
  const r = rms(buf);
  if (r > 1e-9) for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! / r;
  return buf;
}

/** Adds `src * gain` into `dst` starting at `offsetSeconds`; clipped to dst length. */
export function mixInto(
  dst: Float32Array,
  src: Float32Array,
  sampleRate: number,
  offsetSeconds = 0,
  gain = 1,
): void {
  const start = Math.round(offsetSeconds * sampleRate);
  for (let i = 0; i < src.length; i++) {
    const j = start + i;
    if (j >= 0 && j < dst.length) dst[j] = dst[j]! + src[i]! * gain;
  }
}

/** Smooth bump over u in [0, 1]: 0 at both ends, 1 in the middle. */
export function bell(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  const s = Math.sin(Math.PI * u);
  return s * s;
}

export interface NoiseLayerOptions {
  dur: number;
  mode: FilterMode;
  /** Cutoff in Hz, or a function of normalised time u in [0, 1] for sweeps. */
  cutoff: number | ((u: number) => number);
  q?: number;
  /** Linear attack in seconds (default 0.5 ms). */
  attack?: number;
  /** Exponential decay time constant in seconds (default none). */
  decay?: number;
  /** Extra envelope as a function of u in [0, 1]. */
  curve?: (u: number) => number;
  amp: number;
}

/** Filtered noise with an envelope, normalised to unit RMS before `amp` is applied. */
export function noiseLayer(
  rng: Rng,
  sampleRate: number,
  o: NoiseLayerOptions,
): Float32Array {
  const n = samples(sampleRate, o.dur);
  const raw = whiteNoise(rng, n);
  const f = makeFilter(o.mode, o.q ?? 1, sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    out[i] = f(raw[i]!, typeof o.cutoff === "number" ? o.cutoff : o.cutoff(u));
  }
  normalizeRms(out);
  const attack = o.attack ?? 0.0005;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let env = Math.min(1, t / attack);
    if (o.decay) env *= Math.exp(-t / o.decay);
    if (o.curve) env *= o.curve(i / n);
    out[i] = out[i]! * env * o.amp;
  }
  return out;
}

export interface ThudOptions {
  dur: number;
  /** Starting and settling frequency in Hz. */
  f0: number;
  f1: number;
  /** Time constant of the pitch drop. */
  pitchTau: number;
  decay: number;
  amp: number;
}

/** Sine with a falling pitch and exponential decay: kick-like body of an impact. */
export function thud(sampleRate: number, o: ThudOptions): Float32Array {
  const n = samples(sampleRate, o.dur);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const freq = o.f1 + (o.f0 - o.f1) * Math.exp(-t / o.pitchTau);
    phase += (TAU * freq) / sampleRate;
    out[i] =
      Math.sin(phase) * Math.min(1, t / 0.001) * Math.exp(-t / o.decay) * o.amp;
  }
  return out;
}

export interface RingOptions {
  dur: number;
  freq: number;
  decay: number;
  amp: number;
  /** Starting phase in radians. */
  phase?: number;
}

/** Exponentially damped sine: one resonant partial. */
export function ring(sampleRate: number, o: RingOptions): Float32Array {
  const n = samples(sampleRate, o.dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] =
      Math.sin(TAU * o.freq * t + (o.phase ?? 0)) *
      Math.min(1, t / 0.0005) *
      Math.exp(-t / o.decay) *
      o.amp;
  }
  return out;
}

/** Very short high-passed noise tick. */
export function click(
  rng: Rng,
  sampleRate: number,
  amp: number,
  brightness = 3000,
): Float32Array {
  return noiseLayer(rng, sampleRate, {
    dur: 0.004,
    mode: "hp",
    cutoff: brightness,
    attack: 0.0001,
    decay: 0.0008,
    amp,
  });
}

/**
 * Finishes a one-shot: removes DC, applies short fades so there are no clicks,
 * and normalises the peak.
 */
export function finishOneShot(
  buf: Float32Array,
  sampleRate: number,
  peakLevel: number,
): Float32Array {
  const m = mean(buf);
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! - m;
  const fadeIn = Math.min(buf.length >> 2, Math.round(sampleRate * 0.001));
  const fadeOut = Math.min(buf.length >> 1, Math.round(sampleRate * 0.008));
  for (let i = 0; i < fadeIn; i++) buf[i] = buf[i]! * (i / fadeIn);
  for (let i = 0; i < fadeOut; i++) {
    const k = buf.length - 1 - i;
    const w = i / fadeOut;
    buf[k] = buf[k]! * (0.5 - 0.5 * Math.cos(Math.PI * w));
  }
  return scaleToPeak(buf, peakLevel);
}

/** Finishes a loop: removes DC (periodicity preserved) and normalises the peak. No fades. */
export function finishLoop(buf: Float32Array, peakLevel: number): Float32Array {
  const m = mean(buf);
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! - m;
  return scaleToPeak(buf, peakLevel);
}

export function scaleToPeak(
  buf: Float32Array,
  peakLevel: number,
): Float32Array {
  const p = peak(buf);
  if (p > 1e-9) {
    const k = peakLevel / p;
    for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * k;
  }
  return buf;
}
