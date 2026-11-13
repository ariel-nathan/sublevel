/**
 * Small DSP toolbox operating on plain Float32Arrays. Pure: no Web Audio, no
 * globals. Everything is parameterised in seconds/Hz so recipes are
 * sample-rate independent.
 */

export const TAU = Math.PI * 2;

/** Number of samples for a duration in seconds (at least 1). */
export function samples(sampleRate: number, seconds: number): number {
  return Math.max(1, Math.round(sampleRate * seconds));
}

export type BiquadMode = "lp" | "hp" | "bp" | "peak" | "lowshelf" | "highshelf";

/**
 * Fixed-coefficient biquad (RBJ cookbook), direct form I. `gainDb` is used by
 * the peak and shelf modes. Returns a per-sample processing function with its
 * own state.
 */
export function biquad(
  mode: BiquadMode,
  freq: number,
  q: number,
  sampleRate: number,
  gainDb = 0,
): (x: number) => number {
  const w = (TAU * Math.min(freq, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (mode) {
    case "lp":
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "hp":
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "bp":
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "peak":
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    case "lowshelf":
    case "highshelf": {
      const s = mode === "lowshelf" ? 1 : -1;
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - s * (A - 1) * cos + sq);
      b1 = 2 * s * A * (A - 1 - s * (A + 1) * cos);
      b2 = A * (A + 1 - s * (A - 1) * cos - sq);
      a0 = A + 1 + s * (A - 1) * cos + sq;
      a1 = -2 * s * (A - 1 + s * (A + 1) * cos);
      a2 = A + 1 + s * (A - 1) * cos - sq;
      break;
    }
  }
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** Runs `buf` through a chain of per-sample processors, in place. */
export function applyChain(
  buf: Float32Array,
  ...stages: ((x: number) => number)[]
): Float32Array {
  for (let i = 0; i < buf.length; i++) {
    let x = buf[i]!;
    for (const s of stages) x = s(x);
    buf[i] = x;
  }
  return buf;
}
