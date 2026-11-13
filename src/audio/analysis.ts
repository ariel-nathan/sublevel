/**
 * Objective descriptors of a rendered sound, so that sounds can be judged by
 * numbers and pictures instead of by ear. Pure (used by tests and by the
 * preview script).
 */
import { biquad } from "./dsp";
import { hann, magnitudeSpectrum } from "./fft";

export const BANDS = [
  { name: "sub", lo: 0, hi: 80 },
  { name: "low", lo: 80, hi: 250 },
  { name: "lowMid", lo: 250, hi: 1000 },
  { name: "highMid", lo: 1000, hi: 4000 },
  { name: "high", lo: 4000, hi: 12000 },
  { name: "air", lo: 12000, hi: Infinity },
] as const;

export type BandName = (typeof BANDS)[number]["name"];

export function db(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-9));
}

export function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}

export function rmsOf(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  const a = Math.max(0, from);
  const b = Math.min(buf.length, to);
  for (let i = a; i < b; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
}

/**
 * Loudest short-term RMS over a sliding window (default 50 ms, 5 ms hop):
 * a simple stand-in for "momentary loudness" that does not depend on how
 * long the silent tail of a one-shot is.
 */
export function shortTermMaxRms(
  buf: Float32Array,
  sampleRate: number,
  window = 0.05,
): number {
  const w = Math.max(1, Math.round(window * sampleRate));
  if (buf.length <= w) return rmsOf(buf);
  const hop = Math.max(1, Math.round(0.005 * sampleRate));
  let best = 0;
  for (let i = 0; i + w <= buf.length; i += hop) {
    best = Math.max(best, rmsOf(buf, i, i + w));
  }
  return best;
}

/** RMS envelope: frames of `win` seconds every `hop` seconds. */
export function envelope(
  buf: Float32Array,
  sampleRate: number,
  hop = 0.001,
  win = 0.003,
): Float64Array {
  const h = Math.max(1, Math.round(hop * sampleRate));
  const w = Math.max(1, Math.round(win * sampleRate));
  const n = Math.max(1, Math.ceil(buf.length / h));
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const c = f * h;
    out[f] = rmsOf(buf, c - (w >> 1), c + (w >> 1) + 1);
  }
  return out;
}

/** Average power spectrum (Welch, Hann) of buf[from, to). */
export function powerSpectrum(
  buf: Float32Array,
  from: number,
  to: number,
  size = 2048,
): Float64Array {
  const window = hann(size);
  const power = new Float64Array(size / 2 + 1);
  const hop = size / 2;
  let count = 0;
  const end = Math.max(from + 1, to);
  for (let offset = from; offset < end; offset += hop) {
    const mag = magnitudeSpectrum(
      clip(buf, from, to),
      size,
      offset - from,
      window,
    );
    for (let k = 0; k < mag.length; k++)
      power[k] = power[k]! + mag[k]! * mag[k]!;
    count++;
    if (offset + size >= end) break;
  }
  for (let k = 0; k < power.length; k++)
    power[k] = power[k]! / Math.max(1, count);
  return power;
}

function clip(buf: Float32Array, from: number, to: number): Float32Array {
  return buf.subarray(Math.max(0, from), Math.min(buf.length, to));
}

export function centroidOf(power: Float64Array, sampleRate: number): number {
  const size = (power.length - 1) * 2;
  let num = 0;
  let den = 0;
  for (let k = 1; k < power.length; k++) {
    num += power[k]! * ((k * sampleRate) / size);
    den += power[k]!;
  }
  return den > 0 ? num / den : 0;
}

export function rolloffOf(
  power: Float64Array,
  sampleRate: number,
  fraction = 0.85,
): number {
  const size = (power.length - 1) * 2;
  let total = 0;
  for (let k = 1; k < power.length; k++) total += power[k]!;
  let acc = 0;
  for (let k = 1; k < power.length; k++) {
    acc += power[k]!;
    if (acc >= fraction * total) return (k * sampleRate) / size;
  }
  return sampleRate / 2;
}

/** Fraction of the energy in each band (sums to 1). */
export function bandSplit(
  power: Float64Array,
  sampleRate: number,
): Record<BandName, number> {
  const size = (power.length - 1) * 2;
  const out = {} as Record<BandName, number>;
  let total = 0;
  for (const b of BANDS) out[b.name] = 0;
  for (let k = 1; k < power.length; k++) {
    const f = (k * sampleRate) / size;
    const band = BANDS.find((b) => f >= b.lo && f < b.hi)!;
    out[band.name] += power[k]!;
    total += power[k]!;
  }
  for (const b of BANDS) out[b.name] = total > 0 ? out[b.name] / total : 0;
  return out;
}

/**
 * Spectral flatness (geometric / arithmetic mean of power) between lo and hi
 * Hz: near 1 for noise, near 0 for a few strong partials.
 */
export function flatnessOf(
  power: Float64Array,
  sampleRate: number,
  lo = 100,
  hi = 8000,
): number {
  const size = (power.length - 1) * 2;
  let logSum = 0;
  let sum = 0;
  let n = 0;
  for (let k = 1; k < power.length; k++) {
    const f = (k * sampleRate) / size;
    if (f < lo || f > hi) continue;
    logSum += Math.log(power[k]! + 1e-20);
    sum += power[k]!;
    n++;
  }
  if (n === 0 || sum <= 0) return 0;
  return Math.exp(logSum / n) / (sum / n);
}

export interface SpectralPeak {
  freq: number;
  db: number;
}

/**
 * Strongest local maxima of a power spectrum, at least `minSeparation` Hz
 * apart, strongest first. Frequencies are refined by parabolic interpolation.
 */
export function spectralPeaks(
  power: Float64Array,
  sampleRate: number,
  count = 6,
  minSeparation = 20,
  minFreq = 20,
): SpectralPeak[] {
  const size = (power.length - 1) * 2;
  const binHz = sampleRate / size;
  const candidates: SpectralPeak[] = [];
  for (let k = 2; k < power.length - 1; k++) {
    const p = power[k]!;
    if (p > power[k - 1]! && p >= power[k + 1]! && k * binHz >= minFreq) {
      const a = 10 * Math.log10(power[k - 1]! + 1e-20);
      const b = 10 * Math.log10(p + 1e-20);
      const c = 10 * Math.log10(power[k + 1]! + 1e-20);
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      candidates.push({
        freq: (k + shift) * binHz,
        db: b - 0.25 * (a - c) * shift,
      });
    }
  }
  candidates.sort((x, y) => y.db - x.db);
  const out: SpectralPeak[] = [];
  for (const c of candidates) {
    if (out.every((o) => Math.abs(o.freq - c.freq) >= minSeparation)) {
      out.push(c);
      if (out.length >= count) break;
    }
  }
  return out;
}

export interface Descriptors {
  duration: number;
  peakDb: number;
  rmsDb: number;
  /** Loudest 50 ms RMS (dBFS). */
  rms50Db: number;
  crestDb: number;
  /** 10%-90% rise time of the RMS envelope, ms. */
  attackMs: number;
  /** Time from the envelope peak until it stays 20 / 40 dB below it, ms. */
  decay20Ms: number;
  decay40Ms: number;
  /** Over the first 50 ms after onset. */
  centroidOnset: number;
  rolloffOnset: number;
  /** From 50 ms after onset to the end. */
  centroidTail: number;
  rolloffTail: number;
  centroid: number;
  flatness: number;
  bands: Record<BandName, number>;
}

export function describe(buf: Float32Array, sampleRate: number): Descriptors {
  const peak = peakOf(buf);
  const rms = rmsOf(buf);
  const env = envelope(buf, sampleRate);
  let peakFrame = 0;
  for (let f = 0; f < env.length; f++)
    if (env[f]! > env[peakFrame]!) peakFrame = f;
  const envPeak = env[peakFrame]!;
  let t10 = 0;
  let t90 = 0;
  for (let f = 0; f <= peakFrame; f++) {
    if (env[f]! >= 0.1 * envPeak) {
      t10 = f;
      break;
    }
  }
  for (let f = t10; f <= peakFrame; f++) {
    if (env[f]! >= 0.9 * envPeak) {
      t90 = f;
      break;
    }
  }
  const lastAbove = (ratio: number): number => {
    for (let f = env.length - 1; f >= peakFrame; f--) {
      if (env[f]! >= envPeak * ratio) return f - peakFrame;
    }
    return 0;
  };
  const onset = Math.round((t10 / 1000) * sampleRate);
  const split = Math.min(buf.length, onset + Math.round(0.05 * sampleRate));
  const onsetPower = powerSpectrum(buf, onset, split, 1024);
  const tailPower =
    split < buf.length - 64
      ? powerSpectrum(buf, split, buf.length, 2048)
      : onsetPower;
  const all = powerSpectrum(buf, 0, buf.length, 2048);
  return {
    duration: buf.length / sampleRate,
    peakDb: db(peak),
    rmsDb: db(rms),
    rms50Db: db(shortTermMaxRms(buf, sampleRate)),
    crestDb: db(peak) - db(rms),
    attackMs: t90 - t10,
    decay20Ms: lastAbove(0.1),
    decay40Ms: lastAbove(0.01),
    centroidOnset: centroidOf(onsetPower, sampleRate),
    rolloffOnset: rolloffOf(onsetPower, sampleRate),
    centroidTail: centroidOf(tailPower, sampleRate),
    rolloffTail: rolloffOf(tailPower, sampleRate),
    centroid: centroidOf(all, sampleRate),
    flatness: flatnessOf(all, sampleRate),
    bands: bandSplit(all, sampleRate),
  };
}

/**
 * Wrap-around discontinuity of a loop: the jump from the last sample to the
 * first, relative to the typical (median absolute) sample-to-sample step.
 * Values near or below ~3 are inaudible.
 */
export function seamDiscontinuity(buf: Float32Array): number {
  const n = buf.length;
  const steps = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) steps[i - 1] = Math.abs(buf[i]! - buf[i - 1]!);
  const sorted = Array.from(steps).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1]! || 1e-12;
  // Compare the wrap step with a prediction from the slope on either side.
  const predicted = buf[n - 1]! + (buf[n - 1]! - buf[n - 2]!);
  return Math.abs(buf[0]! - predicted) / median;
}

/**
 * Power spectrum of one or more whole short events (each zero-padded to
 * `size`, no window: one-shots already start and end at zero), summed. Taking
 * several takes together shows what stays the same from step to step, which
 * is what the ear hears as "the pitch" of a repeated sound.
 */
export function eventSpectrum(
  bufs: readonly Float32Array[],
  size = 8192,
): Float64Array {
  const ones = new Float64Array(size).fill(1);
  const power = new Float64Array(size / 2 + 1);
  for (const buf of bufs) {
    const mag = magnitudeSpectrum(buf.subarray(0, size), size, 0, ones);
    for (let k = 0; k < power.length; k++)
      power[k] = power[k]! + mag[k]! * mag[k]!;
  }
  return power;
}

export interface TonalPeak {
  /** How far the peak stands above its neighbourhood, dB. */
  db: number;
  freq: number;
}

/**
 * The most prominent narrow peak between `lo` and `hi` Hz: each bin's power
 * (lightly smoothed over 1/48 octave, to tame the scatter of a noise
 * spectrum) against the mean power from 1/3 octave below to 1/3 octave above,
 * ignoring 1/12 octave either side of the bin. A pitched partial reads well
 * above 10 dB; shaped noise reads a few dB.
 */
export function tonalPeak(
  power: Float64Array,
  sampleRate: number,
  lo = 120,
  hi = 8000,
): TonalPeak {
  const size = (power.length - 1) * 2;
  const binHz = sampleRate / size;
  const prefix = new Float64Array(power.length + 1);
  for (let k = 0; k < power.length; k++) prefix[k + 1] = prefix[k]! + power[k]!;
  const sum = (a: number, b: number) => {
    const i = Math.max(0, Math.min(power.length, a));
    const j = Math.max(i, Math.min(power.length, b));
    return { s: prefix[j]! - prefix[i]!, n: j - i };
  };
  let best: TonalPeak = { db: -Infinity, freq: 0 };
  const k0 = Math.max(1, Math.ceil(lo / binHz));
  const k1 = Math.min(power.length - 2, Math.floor(hi / binHz));
  for (let k = k0; k <= k1; k++) {
    const f = k * binHz;
    const smooth = Math.max(1, Math.round((f * (2 ** (1 / 96) - 1)) / binHz));
    const centre = sum(k - smooth, k + smooth + 1);
    const inner = Math.max(2, Math.round((f * (2 ** (1 / 12) - 1)) / binHz));
    const outerLo = Math.floor(f / 2 ** (1 / 3) / binHz);
    const outerHi = Math.ceil((f * 2 ** (1 / 3)) / binHz);
    const below = sum(outerLo, k - inner);
    const above = sum(k + inner + 1, outerHi + 1);
    const n = below.n + above.n;
    if (n === 0 || centre.n === 0) continue;
    const ref = (below.s + above.s) / n;
    const v =
      10 * Math.log10((centre.s / centre.n + 1e-30) / Math.max(ref, 1e-30));
    if (v > best.db) best = { db: v, freq: f };
  }
  return best;
}

/**
 * Loudest 50 ms RMS after an approximate K-weighting (the ITU BS.1770
 * pre-filter: +4 dB shelf above about 1.5 kHz, high-pass near 40 Hz), dB.
 * Closer to perceived loudness than plain RMS when comparing a dull sound
 * with a bright one.
 */
export function kLoudnessDb(buf: Float32Array, sampleRate: number): number {
  const x = buf.slice();
  const shelf = biquad("highshelf", 1500, 0.707, sampleRate, 4);
  const hp = biquad("hp", 38, 0.5, sampleRate);
  for (let i = 0; i < x.length; i++) x[i] = hp(shelf(x[i]!));
  return db(shortTermMaxRms(x, sampleRate));
}

export interface LoopEnvelopeStats {
  /** Loudest 50 ms frame relative to the median frame, dB. */
  spreadDb: number;
  /**
   * Largest of the 1, 2 and 3 cycles-per-loop components of the 50 ms RMS
   * envelope, relative to its mean: how strongly the level swells once (or
   * twice, three times) per loop, which is what exposes a loop's length.
   */
  loopModulation: number;
}

export function loopEnvelopeStats(
  buf: Float32Array,
  sampleRate: number,
): LoopEnvelopeStats {
  const env = envelope(buf, sampleRate, 0.05, 0.05);
  const n = env.length;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  const sorted = Array.from(env).sort((a, b) => a - b);
  const median = sorted[n >> 1]!;
  let worst = 0;
  for (let k = 1; k <= 3; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += env[i]! * Math.cos((2 * Math.PI * k * i) / n);
      im += env[i]! * Math.sin((2 * Math.PI * k * i) / n);
    }
    worst = Math.max(worst, (2 * Math.hypot(re, im)) / n / mean);
  }
  return { spreadDb: db(sorted[n - 1]! / median), loopModulation: worst };
}
