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

type Pt = { x: number; z: number };

/** Distance in the plane from `p` to the segment `a`-`b`. */
export function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t =
    l2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/**
 * Moves a prop spot sideways off the walks of a solution (segments), until
 * it is at least `clear` from each, within `room` (design plane); the
 * spot unchanged if it already is. Steps of 5 cm, either way across the
 * nearest segment; null if no place within 2 m works.
 */
export function offTheWay(
  spot: Pt,
  walks: readonly (readonly [Pt, Pt])[],
  clear: number,
  room: { x0: number; z0: number; x1: number; z1: number },
): Pt | null {
  const fits = (p: Pt) =>
    p.x >= room.x0 &&
    p.x <= room.x1 &&
    p.z >= room.z0 &&
    p.z <= room.z1 &&
    walks.every(([a, b]) => segmentDistance(p, a, b) >= clear);
  if (fits(spot)) return spot;
  const [a, b] = walks.reduce((best, w) =>
    segmentDistance(spot, w[0], w[1]) < segmentDistance(spot, best[0], best[1])
      ? w
      : best,
  );
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const n = { x: -(b.z - a.z) / len, z: (b.x - a.x) / len };
  for (let d = 0.05; d <= 2; d += 0.05) {
    for (const s of [1, -1]) {
      const p = { x: q(spot.x + n.x * d * s), z: q(spot.z + n.z * d * s) };
      if (fits(p)) return p;
    }
  }
  return null;
}

/** One of the items, uniformly. */
export const oneOf = <T>(rng: Rng, items: readonly T[]): T =>
  items[rng.int(0, items.length - 1)];
