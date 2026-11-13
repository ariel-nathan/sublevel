/**
 * Small radix-2 FFT and the spectral helpers built on it (Hann window, STFT,
 * periodic noise synthesis). Pure: used by the loop recipes at startup and by
 * the analysis/preview tooling.
 */

const twiddleCache = new Map<
  number,
  { cos: Float64Array; sin: Float64Array }
>();

function twiddles(n: number): { cos: Float64Array; sin: Float64Array } {
  let t = twiddleCache.get(n);
  if (!t) {
    const half = n >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Smallest power of two >= n. */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place complex FFT of length n (a power of two). `inverse` computes the
 * unnormalised inverse transform (divide by n yourself).
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (!isPowerOfTwo(n) || im.length !== n) {
    throw new Error(`fft: length ${n} is not a power of two`);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  const { cos, sin } = twiddles(n);
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sign * sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]!;
        const xi = im[b]!;
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/** Periodic Hann window of length n. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++)
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Magnitude spectrum (bins 0..size/2) of `input` starting at `offset`,
 * Hann-windowed over `size` samples (zero-padded past the end). Magnitudes are
 * scaled so that a full-scale sine reads about 1.
 */
export function magnitudeSpectrum(
  input: Float32Array,
  size: number,
  offset = 0,
  window: Float64Array = hann(size),
): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const j = offset + i;
    re[i] = j >= 0 && j < input.length ? input[j]! * window[i]! : 0;
  }
  fft(re, im);
  const out = new Float64Array(size / 2 + 1);
  const scale = 4 / size; // Hann coherent gain 0.5, one-sided spectrum x2.
  for (let k = 0; k <= size / 2; k++)
    out[k] = Math.hypot(re[k]!, im[k]!) * scale;
  return out;
}

export interface Spectrogram {
  /** Frames, each with `size / 2 + 1` magnitudes in dB (full-scale sine = 0 dB). */
  frames: Float64Array[];
  size: number;
  hop: number;
  sampleRate: number;
}

/** Short-time Fourier transform with a Hann window; magnitudes in dB. */
export function stft(
  input: Float32Array,
  sampleRate: number,
  size = 1024,
  hop = 256,
): Spectrogram {
  const window = hann(size);
  const frames: Float64Array[] = [];
  for (
    let offset = -size / 2;
    offset < input.length - size / 2;
    offset += hop
  ) {
    const mag = magnitudeSpectrum(input, size, offset, window);
    for (let k = 0; k < mag.length; k++) {
      mag[k] = 20 * Math.log10(mag[k]! + 1e-9);
    }
    frames.push(mag);
  }
  return { frames, size, hop, sampleRate };
}

/**
 * Two independent, exactly periodic noise signals of length n (a power of
 * two) whose amplitude spectra follow `shapeA` / `shapeB` (functions of
 * frequency in Hz, returning linear amplitude). Random phases come from `rng`.
 * One complex inverse FFT yields both (real and imaginary parts). Each result
 * is scaled to unit RMS.
 */
export function periodicNoisePair(
  next: () => number,
  n: number,
  sampleRate: number,
  shapeA: (freq: number) => number,
  shapeB: (freq: number) => number,
): [Float32Array, Float32Array] {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // Shapes are smooth: evaluate them every 16 bins and interpolate.
  const grid = 16;
  const coarseA = new Float64Array(n / 2 / grid + 2);
  const coarseB = new Float64Array(n / 2 / grid + 2);
  for (let c = 0; c < coarseA.length; c++) {
    const f = Math.max(1e-3, (c * grid * sampleRate) / n);
    coarseA[c] = shapeA(f);
    coarseB[c] = shapeB(f);
  }
  // Each bin gets an approximately Gaussian complex amplitude (sum of two
  // uniforms per component), as white noise would: random phase and a
  // Rayleigh-like magnitude, with no trigonometry per bin.
  // X = A + iB with A and B Hermitian => x = a + ib with a, b real.
  for (let k = 1; k < n / 2; k++) {
    const c = Math.floor(k / grid);
    const u = (k - c * grid) / grid;
    const ma = coarseA[c]! + (coarseA[c + 1]! - coarseA[c]!) * u;
    const mb = coarseB[c]! + (coarseB[c + 1]! - coarseB[c]!) * u;
    const ar = ma * (next() + next() - 1);
    const ai = ma * (next() + next() - 1);
    const br = mb * (next() + next() - 1);
    const bi = mb * (next() + next() - 1);
    // Bin k: A + iB.
    re[k] = ar - bi;
    im[k] = ai + br;
    // Bin n-k: conj(A) + i conj(B).
    re[n - k] = ar + bi;
    im[n - k] = -ai + br;
  }
  fft(re, im, true);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < n; i++) {
    ea += re[i]! * re[i]!;
    eb += im[i]! * im[i]!;
  }
  const ka = ea > 0 ? 1 / Math.sqrt(ea / n) : 0;
  const kb = eb > 0 ? 1 / Math.sqrt(eb / n) : 0;
  for (let i = 0; i < n; i++) {
    a[i] = re[i]! * ka;
    b[i] = im[i]! * kb;
  }
  return [a, b];
}
