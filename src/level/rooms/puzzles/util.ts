import type { Rng } from "../../../core/rng";

/** Rounds to a multiple of `step` (default 5 cm), free of float noise. */
export const q = (v: number, step = 0.05): number =>
  Math.round(Math.round(v / step) * step * 1e6) / 1e6;

/** A random value in [lo, hi] rounded to `step`. */
export const pick = (
  rng: Rng,
  [lo, hi]: readonly [number, number],
  step = 0.05,
): number => Math.min(hi, Math.max(lo, q(rng.range(lo, hi), step)));

export const clamp = (v: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, v));

/** One of the items, uniformly. */
export const oneOf = <T>(rng: Rng, items: readonly T[]): T =>
  items[rng.int(0, items.length - 1)];
