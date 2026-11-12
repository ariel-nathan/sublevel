/** Deterministic pseudo-random generator (mulberry32). Same seed, same sequence. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [low, high). */
  range(low: number, high: number): number;
  /** Uniform integer in [low, high], both inclusive. */
  int(low: number, high: number): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (low, high) => low + (high - low) * next(),
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
  };
}

/** Stable 32-bit hash of a string, for deriving per-item seeds. */
export function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
