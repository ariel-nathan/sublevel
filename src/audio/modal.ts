/**
 * Modal synthesis of struck objects (van den Doel & Pai): an impact is a
 * short contact-force pulse driving a bank of damped resonators, one per
 * vibration mode. Each mode's 1/e decay time follows the material damping
 * model used by Klatzky, Pai & Krotkov: tau = 1 / (f / d + c), where `d` is
 * the shape-invariant material decay parameter (large for metal, small for
 * wood and plastic) and `c` a frequency-independent loss (contact with the
 * floor, radiation). See DESIGN.md.
 */
import type { Rng } from "../core/rng";
import { TAU, samples } from "./dsp";

export interface Mode {
  /** Hz. */
  freq: number;
  /** Relative amplitude of the mode for a unit impulse. */
  gain: number;
}

export interface Material {
  /** Decay parameter d: a mode at f Hz decays by 1/e in d / f seconds. */
  d: number;
  /** Frequency-independent damping, 1/s. */
  c: number;
}

/** 1/e decay time in seconds of a mode at `freq` Hz. */
export function modeTau(freq: number, m: Material): number {
  return 1 / (freq / m.d + m.c);
}

/**
 * Material constants. `d` values sit in the ranges Klatzky et al. found
 * listeners assign to each category (rubber < wood < glass < steel on a
 * 3..300 scale); `c` is tuned per object for how it rests on the floor.
 */
export const MATERIALS = {
  /** Plywood/plank crate. */
  wood: { d: 20, c: 14 },
  /** Thin steel drum or case resting on concrete. */
  steel: { d: 220, c: 3.2 },
  /** Moulded plastic shell (chair, monitor housing). */
  plastic: { d: 7, c: 28 },
  /** Steel bar grating bolted into a frame. */
  grating: { d: 90, c: 9 },
  /** Ceramic floor tile bedded in mortar. */
  ceramic: { d: 40, c: 110 },
  /** Steel door slab / plate under load. */
  plate: { d: 60, c: 10 },
} as const satisfies Record<string, Material>;

/** Wood crate, 0.8 m, 25 kg: panel and box modes. */
export const WOOD_CRATE_MODES: readonly Mode[] = [
  { freq: 112, gain: 0.7 },
  { freq: 178, gain: 0.8 },
  { freq: 253, gain: 1 },
  { freq: 341, gain: 0.85 },
  { freq: 462, gain: 0.8 },
  { freq: 618, gain: 0.75 },
  { freq: 835, gain: 0.7 },
  { freq: 1120, gain: 0.65 },
  { freq: 1480, gain: 0.55 },
  { freq: 1960, gain: 0.45 },
  { freq: 2590, gain: 0.3 },
];

/**
 * Hollow steel drum / case: dense, inharmonic shell modes, several of them
 * near-degenerate pairs a few Hz apart that beat (the shimmer of a struck
 * cylinder).
 */
export const STEEL_DRUM_MODES: readonly Mode[] = [
  { freq: 148, gain: 0.45 },
  { freq: 231, gain: 0.5 },
  { freq: 347, gain: 0.8 },
  { freq: 352.5, gain: 0.5 },
  { freq: 489, gain: 1 },
  { freq: 496, gain: 0.55 },
  { freq: 664, gain: 0.85 },
  { freq: 881, gain: 0.8 },
  { freq: 889, gain: 0.5 },
  { freq: 1123, gain: 0.75 },
  { freq: 1391, gain: 0.7 },
  { freq: 1702, gain: 0.65 },
  { freq: 2050, gain: 0.6 },
  { freq: 2448, gain: 0.5 },
  { freq: 2890, gain: 0.45 },
  { freq: 3412, gain: 0.4 },
  { freq: 4020, gain: 0.32 },
  { freq: 4710, gain: 0.25 },
  { freq: 5530, gain: 0.18 },
];

/** Moulded plastic shell. */
export const PLASTIC_SHELL_MODES: readonly Mode[] = [
  { freq: 214, gain: 0.5 },
  { freq: 387, gain: 1 },
  { freq: 592, gain: 0.9 },
  { freq: 873, gain: 0.85 },
  { freq: 1245, gain: 0.8 },
  { freq: 1760, gain: 0.7 },
  { freq: 2480, gain: 0.55 },
  { freq: 3390, gain: 0.35 },
];

/** Adds the response of a damped two-pole resonator bank to `out`. */
export function resonate(
  excitation: Float32Array,
  out: Float32Array,
  sampleRate: number,
  modes: readonly Mode[],
  material: Material,
  options: { offset?: number; gain?: number; pitch?: number } = {},
): void {
  const start = Math.round((options.offset ?? 0) * sampleRate);
  const scale = options.gain ?? 1;
  const pitch = options.pitch ?? 1;
  for (const mode of modes) {
    const f = mode.freq * pitch;
    if (f >= sampleRate * 0.45) continue;
    const tau = modeTau(f, material);
    const r = Math.exp(-1 / (tau * sampleRate));
    const w = (TAU * f) / sampleRate;
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    const g = mode.gain * scale * Math.sin(w);
    // Run until the mode has decayed by 80 dB.
    const ring = Math.ceil(tau * 9.2 * sampleRate);
    const end = Math.min(out.length, start + excitation.length + ring);
    let y1 = 0;
    let y2 = 0;
    for (let i = start; i < end; i++) {
      const j = i - start;
      const x = j < excitation.length ? excitation[j]! : 0;
      const y = a1 * y1 + a2 * y2 + g * x;
      y2 = y1;
      y1 = y;
      out[i] = out[i]! + y;
    }
  }
}

/**
 * Contact-force pulse: (1 - cos(2 pi t / T)) / 2 over the contact time T
 * (van den Doel et al.), normalised to unit area so that changing hardness
 * changes brightness, not the low-frequency level. Short T = hard contact =
 * bright. Optional roughness adds micro-collision noise inside the pulse.
 */
export function contactPulse(
  sampleRate: number,
  contactTime: number,
  rng?: Rng,
  roughness = 0,
): Float32Array {
  const n = Math.max(2, Math.round(contactTime * sampleRate));
  const out = new Float32Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const v = 0.5 - 0.5 * Math.cos((TAU * (i + 0.5)) / n);
    const jitter =
      rng && roughness > 0 ? 1 + roughness * (rng.next() * 2 - 1) : 1;
    out[i] = v * jitter;
    area += out[i]!;
  }
  for (let i = 0; i < n; i++) out[i] = out[i]! / area;
  return out;
}

export interface StrikeOptions {
  modes: readonly Mode[];
  material: Material;
  /** Contact time in seconds (hardness). */
  contact: number;
  /** Seconds into the output. */
  at?: number;
  gain?: number;
  pitch?: number;
  roughness?: number;
}

/** One strike of a modal object, mixed into `out`. */
export function strike(
  out: Float32Array,
  sampleRate: number,
  rng: Rng,
  o: StrikeOptions,
): void {
  const pulse = contactPulse(sampleRate, o.contact, rng, o.roughness ?? 0);
  resonate(pulse, out, sampleRate, o.modes, o.material, {
    offset: o.at ?? 0,
    gain: o.gain ?? 1,
    pitch: o.pitch ?? 1,
  });
}

/** Buffer of `seconds` length, for recipes. */
export function buffer(sampleRate: number, seconds: number): Float32Array {
  return new Float32Array(samples(sampleRate, seconds));
}
