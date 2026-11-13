/**
 * Continuous contact loops: a crate or case dragged over concrete
 * (`scrape_*`) and a drum rolling or tumbling slowly (`roll_metal`). The game
 * plays them while bodies slide or roll and glides their gain and pitch with
 * the contact (see contactVoices.ts), so each loop must sound right from a
 * whisper to full level and at playback rates of about 0.6 to 1.6.
 *
 * Design rules (from listening round 1, see DESIGN.md):
 * - Shaped noise only. Friction is a noise bed whose level flickers, plus
 *   irregular stick-slip micro-events (Poisson, rate drifting), each a short
 *   band-passed noise burst with its own random centre. No fixed resonance
 *   is narrow enough to read as a pitch; the steel case's screech is a
 *   narrow band whose centre wanders over most of an octave and that only
 *   swells now and then.
 * - Nothing periodic inside the loop: event times are random, drifts use
 *   4..60 cycles per loop and never 1..3 (no swell once per repeat). Played
 *   faster, the chatter gets denser and brighter but never becomes a buzz.
 * - Exactly seamless: every layer is built circularly. Events that run past
 *   the end wrap to the start, and every filter is primed with the end of
 *   the loop before it runs over the whole of it, so sample n-1 flows into
 *   sample 0 as any other pair of samples does.
 *
 * Pure and deterministic; renders lazily (see index.ts).
 */
import type { Rng } from "../core/rng";
import { TAU, biquad } from "./dsp";
import {
  between,
  cluster,
  logBetween,
  noiseEvent,
  type FilterSpec,
} from "./foley";
import type { Recipe } from "./recipes";

/**
 * Contact loop length: 2^18 samples (5.9 s at 44.1 kHz, 5.5 s at 48 kHz),
 * 2^17 at low rates. Long enough not to be recognised when a crate is
 * pushed for several seconds, short enough to render quickly.
 */
export function contactLoopLength(sr: number): number {
  return sr >= 32000 ? 1 << 18 : 1 << 17;
}

/** Samples of filter warm-up taken from the end of the loop (0.25 s). */
function warmup(sr: number, n: number): number {
  return Math.min(n - 1, Math.round(0.25 * sr));
}

/**
 * Runs `stages` over `buf` in place as if the buffer repeated forever: the
 * filters first run over the last `warm` samples (output discarded), so
 * their state at sample 0 is the state they would have after sample n-1.
 */
export function circularFilter(
  buf: Float32Array,
  sr: number,
  filters: readonly FilterSpec[],
): Float32Array {
  const stages = filters.map(([m, f, q, g]) => biquad(m, f, q, sr, g ?? 0));
  const n = buf.length;
  const warm = warmup(sr, n);
  for (let i = n - warm; i < n; i++) {
    let x = buf[i]!;
    for (const s of stages) x = s(x);
  }
  for (let i = 0; i < n; i++) {
    let x = buf[i]!;
    for (const s of stages) x = s(x);
    buf[i] = x;
  }
  return buf;
}

/** Adds `src` into the circular buffer `out` starting at sample `start`. */
export function stamp(
  out: Float32Array,
  src: Float32Array,
  start: number,
  gain = 1,
): void {
  const n = out.length;
  let j = ((start % n) + n) % n;
  for (let i = 0; i < src.length; i++) {
    out[j] = out[j]! + src[i]! * gain;
    if (++j === n) j = 0;
  }
}

/** White noise, n samples. */
function white(rng: Rng, n: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rng.next() * 2 - 1;
  return x;
}

/** Scales `buf` to unit RMS (in place). */
function unit(buf: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  const k = s > 0 ? 1 / Math.sqrt(s / buf.length) : 0;
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * k;
  return buf;
}

/**
 * Smooth random drift, zero mean and about unit RMS, exactly periodic over n
 * samples: sinusoids with `minCycles`..`maxCycles` whole cycles per loop
 * (never fewer than 4, so the level never swells once per repeat).
 */
export function drift(
  rng: Rng,
  n: number,
  minCycles: number,
  maxCycles: number,
  count = 9,
): Float32Array {
  const lo = Math.max(4, minCycles);
  const parts: { k: number; a: number; p: number }[] = [];
  let power = 0;
  for (let j = 0; j < count; j++) {
    const k = lo + Math.floor(rng.next() * (maxCycles - lo + 1));
    const a = (0.5 + rng.next()) / Math.sqrt(k);
    parts.push({ k, a, p: rng.next() * TAU });
    power += (a * a) / 2;
  }
  const norm = 1 / Math.sqrt(power);
  const step = 32;
  const coarse = new Float32Array(Math.ceil(n / step) + 1);
  for (let c = 0; c < coarse.length; c++) {
    let s = 0;
    for (const q of parts)
      s += q.a * Math.sin((TAU * q.k * c * step) / n + q.p);
    coarse[c] = s * norm;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / step);
    const f = (i - c * step) / step;
    out[i] = coarse[c]! + (coarse[c + 1]! - coarse[c]!) * f;
  }
  return out;
}

/**
 * Fast random flutter (unit RMS, zero mean): white noise low-passed at
 * `hz`, circularly. Multiplied into a noise bed it makes the bed grainy
 * and uneven at a rate no regular modulation would.
 */
function flutter(rng: Rng, n: number, sr: number, hz: number): Float32Array {
  return unit(
    circularFilter(white(rng, n), sr, [
      ["lp", hz, 0.6],
      ["lp", hz, 0.6],
    ]),
  );
}

/**
 * Event onset times (samples) of a Poisson process whose rate (events per
 * second) at u = i / n is `rate(u)`, by thinning at `maxRate`. Successive
 * events are at least `gap` seconds apart.
 */
export function poissonTimes(
  rng: Rng,
  n: number,
  sr: number,
  rate: (u: number) => number,
  maxRate: number,
  gap = 0,
): number[] {
  const out: number[] = [];
  let t = 0;
  const total = n / sr;
  let last = -Infinity;
  for (;;) {
    t += -Math.log(1 - rng.next() * 0.999999) / maxRate;
    if (t >= total) break;
    if (rng.next() * maxRate > rate(t / total)) continue;
    if (t - last < gap) continue;
    // Keep the wrap-around gap too.
    if (out.length && total - t + out[0]! / sr < gap) continue;
    out.push(Math.round(t * sr));
    last = t;
  }
  return out;
}

/** Value of a periodic buffer at u in [0, 1). */
function at(buf: Float32Array, u: number): number {
  return buf[Math.min(buf.length - 1, Math.floor(u * buf.length))]!;
}

/** Gaussian-ish factor exp(spread * N(0,1)): random event levels. */
function lognormal(rng: Rng, spread: number): number {
  const g = rng.next() + rng.next() + rng.next() - 1.5;
  return Math.exp(spread * g * 2);
}

interface ChatterOptions {
  /** Mean events per second and how much the rate drifts (0..1). */
  rate: number;
  rateDepth: number;
  /** Band-pass centre range (Hz, log-uniform) and Q range. */
  centre: readonly [number, number];
  q: readonly [number, number];
  attack: readonly [number, number];
  decay: readonly [number, number];
  /** Spread of the event levels (lognormal). */
  spread: number;
  /** Minimum time between events, s. */
  gap?: number;
  /** Extra filters per event. */
  filters?: readonly FilterSpec[];
}

/**
 * Stick-slip chatter: irregular short noise bursts, each band-passed at its
 * own random centre, placed circularly. Unit RMS.
 */
function chatter(
  rng: Rng,
  n: number,
  sr: number,
  o: ChatterOptions,
): Float32Array {
  const out = new Float32Array(n);
  const swing = drift(rng, n, 5, 45, 9);
  const times = poissonTimes(
    rng,
    n,
    sr,
    (u) => o.rate * Math.max(0.15, 1 + o.rateDepth * at(swing, u)),
    o.rate * (1 + 2.5 * o.rateDepth),
    o.gap ?? 0,
  );
  for (const start of times) {
    const ev = noiseEvent(sr, rng, {
      attack: between(rng, o.attack[0], o.attack[1]),
      decay: between(rng, o.decay[0], o.decay[1]),
      filters: [
        ["bp", logBetween(rng, o.centre[0], o.centre[1]), between(rng, ...o.q)],
        ...(o.filters ?? []),
      ],
    });
    stamp(out, ev, start, lognormal(rng, o.spread));
  }
  return unit(out);
}

/**
 * A grain cloud (tiny Hann-windowed band-passed noise grains) at a steady
 * random rate, circular. Unit RMS. Grit under a scrape.
 */
function grit(
  rng: Rng,
  n: number,
  sr: number,
  rate: number,
  centre: readonly [number, number],
  length: readonly [number, number],
): Float32Array {
  const out = new Float32Array(n);
  const times = poissonTimes(rng, n, sr, () => rate, rate);
  for (const start of times) {
    const len = Math.max(4, Math.round(between(rng, ...length) * sr));
    const bp = biquad("bp", logBetween(rng, ...centre), 1.4, sr);
    const g = new Float32Array(len + (len >> 1));
    const amp = 0.3 + 0.7 * rng.next();
    for (let k = 0; k < g.length; k++) {
      const w = k < len ? 0.5 - 0.5 * Math.cos((TAU * k) / len) : 0;
      g[k] = bp((rng.next() * 2 - 1) * w) * amp;
    }
    stamp(out, g, start);
  }
  return unit(out);
}

/**
 * Friction bed: white noise through `filters`, its level drifting slowly
 * (`slowDepth`) and flickering fast (`flickerDepth` at `flickerHz`). Unit RMS.
 */
function bed(
  rng: Rng,
  n: number,
  sr: number,
  filters: readonly FilterSpec[],
  slowDepth: number,
  flickerDepth: number,
  flickerHz: number,
): Float32Array {
  const x = circularFilter(white(rng, n), sr, filters);
  const slow = drift(rng, n, 6, 50, 9);
  const fast = flutter(rng, n, sr, flickerHz);
  for (let i = 0; i < n; i++) {
    const level =
      Math.max(0, 1 + slowDepth * slow[i]!) *
      Math.max(0, 1 + flickerDepth * fast[i]!);
    x[i] = x[i]! * level;
  }
  return unit(x);
}

/** Sum of unit-RMS layers with weights. */
function mix(n: number, layers: readonly [Float32Array, number][]) {
  const out = new Float32Array(n);
  for (const [buf, w] of layers)
    for (let i = 0; i < n; i++) out[i] = out[i]! + buf[i]! * w;
  return out;
}

/**
 * Narrow band-pass whose centre wanders (`centre(i)` Hz at sample i,
 * periodic), as a TPT state-variable filter updated every 16 samples, run
 * circularly. A steel edge squealing against concrete.
 */
function wanderingBand(
  input: Float32Array,
  sr: number,
  centre: (i: number) => number,
  q: number,
): Float32Array {
  const n = input.length;
  const out = new Float32Array(n);
  const k = 1 / q;
  let ic1 = 0;
  let ic2 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  const set = (i: number) => {
    const g = Math.tan((Math.PI * Math.min(centre(i), sr * 0.45)) / sr);
    a1 = 1 / (1 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  };
  const tick = (i: number): number => {
    if ((i & 15) === 0) set(i);
    const v3 = input[i]! - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return v1 * k;
  };
  const warm = warmup(sr, n);
  set(n - warm);
  for (let i = n - warm; i < n; i++) tick(i);
  for (let i = 0; i < n; i++) out[i] = tick(i);
  return out;
}

/**
 * A smooth gate made of `count` raised-cosine swells placed at random
 * (circularly), each `dur` seconds long: 0 between swells, up to 1 inside.
 */
function swells(
  rng: Rng,
  n: number,
  sr: number,
  count: number,
  dur: readonly [number, number],
): Float32Array {
  const out = new Float32Array(n);
  for (let s = 0; s < count; s++) {
    const len = Math.round(between(rng, ...dur) * sr);
    const peak = 0.5 + 0.5 * rng.next();
    const shape = new Float32Array(len);
    for (let i = 0; i < len; i++)
      shape[i] = peak * (0.5 - 0.5 * Math.cos((TAU * i) / len));
    stamp(out, shape, Math.floor(rng.next() * n));
  }
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i]!);
  return out;
}

/**
 * Removes any swell at 1, 2 or 3 cycles per loop from the level (what a
 * random scatter of events leaves behind, and what would expose the loop
 * length): measures the RMS envelope in 128 frames, then divides the buffer
 * by a smooth, exactly periodic gain curve made of those three components.
 * The curve moves over seconds, so it is inaudible. In place.
 */
export function deswell(buf: Float32Array, passes = 3): Float32Array {
  const n = buf.length;
  const frames = 128;
  const len = Math.floor(n / frames);
  for (let pass = 0; pass < passes; pass++) {
    const env = new Float64Array(frames);
    let mean = 0;
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let i = f * len; i < (f + 1) * len; i++) s += buf[i]! * buf[i]!;
      env[f] = Math.sqrt(s / len);
      mean += env[f]! / frames;
    }
    if (mean <= 0) return buf;
    const re = [0, 0, 0];
    const im = [0, 0, 0];
    for (let k = 1; k <= 3; k++) {
      for (let f = 0; f < frames; f++) {
        const th = (TAU * k * (f + 0.5)) / frames;
        re[k - 1] = re[k - 1]! + (2 / frames) * env[f]! * Math.cos(th);
        im[k - 1] = im[k - 1]! + (2 / frames) * env[f]! * Math.sin(th);
      }
    }
    // The curve is slow: evaluate it every 64 samples and interpolate.
    const step = 64;
    const coarse = new Float64Array(Math.ceil(n / step) + 1);
    for (let c = 0; c < coarse.length; c++) {
      let m = 0;
      for (let k = 1; k <= 3; k++) {
        const th = (TAU * k * c * step) / n;
        m += re[k - 1]! * Math.cos(th) + im[k - 1]! * Math.sin(th);
      }
      coarse[c] = 1 / Math.max(0.3, 1 + m / mean);
    }
    for (let i = 0; i < n; i++) {
      const c = Math.floor(i / step);
      const f = (i - c * step) / step;
      buf[i] = buf[i]! * (coarse[c]! + (coarse[c + 1]! - coarse[c]!) * f);
    }
  }
  return buf;
}

/**
 * Rotates a periodic buffer so that it starts at its quietest 10 ms: the
 * loop is unchanged as a cycle, but its first and last samples, where a
 * player starts it and where it wraps, fall in a lull rather than inside a
 * burst. Returns a new buffer.
 */
export function startInLull(buf: Float32Array, sr: number): Float32Array {
  const n = buf.length;
  const w = Math.max(1, Math.round(0.01 * sr));
  let s = 0;
  for (let i = 0; i < w; i++) s += buf[i]! * buf[i]!;
  let best = s;
  let at = 0;
  for (let i = 1; i < n; i++) {
    const out = buf[i - 1]!;
    const inc = buf[(i + w - 1) % n]!;
    s += inc * inc - out * out;
    if (s < best) {
      best = s;
      at = i;
    }
  }
  // Start in the middle of the quietest window.
  const start = (at + (w >> 1)) % n;
  const out = new Float32Array(n);
  out.set(buf.subarray(start), 0);
  out.set(buf.subarray(0, start), n - start);
  return out;
}

/** Common last steps of every contact loop. */
function finishLoop(buf: Float32Array, sr: number): Float32Array {
  return startInLull(deswell(buf), sr);
}

// --- Recipes -------------------------------------------------------------------

/**
 * Wooden crate dragged over concrete: dry, gritty, mid-band. A 300 Hz-3 kHz
 * friction bed that flickers at up to ~35 Hz, dense stick-slip chatter
 * (about 45 bursts a second, 0.35-1.6 kHz), some heavier catches of the
 * crate's edge low down (body), and fine grit on top.
 */
export const scrapeWood: Recipe = ({ sr, rng }) => {
  const n = contactLoopLength(sr);
  const friction = bed(
    rng,
    n,
    sr,
    [
      ["hp", 260, 0.707],
      ["bp", 950, 0.55],
      ["lp", 3200, 0.707],
    ],
    0.3,
    0.55,
    35,
  );
  const slips = chatter(rng, n, sr, {
    rate: 45,
    rateDepth: 0.6,
    centre: [350, 1600],
    q: [0.9, 1.5],
    attack: [0.0005, 0.0015],
    decay: [0.002, 0.006],
    spread: 0.35,
  });
  const catches = chatter(rng, n, sr, {
    rate: 7,
    rateDepth: 0.7,
    centre: [170, 420],
    q: [0.8, 1.2],
    attack: [0.002, 0.004],
    decay: [0.008, 0.018],
    spread: 0.3,
    gap: 0.04,
  });
  const sand = grit(rng, n, sr, 700, [1800, 5000], [0.0004, 0.0012]);
  const b = mix(n, [
    [friction, 1],
    [slips, 1.15],
    [catches, 0.7],
    [sand, 0.22],
  ]);
  return finishLoop(
    circularFilter(b, sr, [
      ["hp", 70, 0.707],
      ["lp", 6500, 0.707],
    ]),
    sr,
  );
};

/**
 * Steel case over concrete: harsher and brighter than wood. A 0.7-8 kHz
 * grinding bed that flickers fast (to ~110 Hz), quick bright chatter (about
 * 90 bursts a second, 1.1-5 kHz), a little low thrum from the case, and a
 * squeal: a narrow band (Q 14) whose centre wanders over about an octave
 * around 2 kHz and that swells in only a few times per loop, kept well
 * under the grind.
 */
export const scrapeMetal: Recipe = ({ sr, rng }) => {
  const n = contactLoopLength(sr);
  const grind = bed(
    rng,
    n,
    sr,
    [
      ["hp", 650, 0.707],
      ["bp", 2600, 0.5],
      ["lp", 8000, 0.707],
    ],
    0.3,
    0.75,
    110,
  );
  const slips = chatter(rng, n, sr, {
    rate: 90,
    rateDepth: 0.5,
    centre: [1100, 5000],
    q: [1.4, 2.6],
    attack: [0.0003, 0.0008],
    decay: [0.0012, 0.004],
    spread: 0.35,
  });
  const thrum = chatter(rng, n, sr, {
    rate: 10,
    rateDepth: 0.6,
    centre: [140, 380],
    q: [0.9, 1.4],
    attack: [0.002, 0.004],
    decay: [0.01, 0.02],
    spread: 0.3,
    gap: 0.03,
  });
  const wander = drift(rng, n, 8, 40, 7);
  const f0 = between(rng, 1800, 2200);
  const squealSrc = white(rng, n);
  const squealA = wanderingBand(
    squealSrc,
    sr,
    (i) => f0 * 2 ** (0.45 * wander[i]!),
    14,
  );
  const squealB = wanderingBand(
    squealSrc,
    sr,
    (i) => 1.47 * f0 * 2 ** (0.45 * wander[i]!),
    11,
  );
  const gate = swells(rng, n, sr, 5, [0.3, 0.9]);
  const squeal = new Float32Array(n);
  for (let i = 0; i < n; i++)
    squeal[i] = (squealA[i]! + 0.6 * squealB[i]!) * gate[i]!;
  unit(squeal);
  const b = mix(n, [
    [grind, 1],
    [slips, 0.95],
    [thrum, 0.45],
    [squeal, 0.3],
  ]);
  return finishLoop(
    circularFilter(b, sr, [
      ["hp", 100, 0.707],
      ["lp", 10000, 0.707],
    ]),
    sr,
  );
};

/**
 * Light plastic shell scuffing along: hollow and soft. A quiet 0.4-4.5 kHz
 * bed and sparse, softer scuffs (about 28 a second), coloured by two broad
 * shell resonances (650 Hz and 1.5 kHz, Q 2.5-3, +5/+6 dB), with brief dips
 * where the light object skips.
 */
export const scrapePlastic: Recipe = ({ sr, rng }) => {
  const n = contactLoopLength(sr);
  const scuffBed = bed(
    rng,
    n,
    sr,
    [
      ["hp", 380, 0.707],
      ["bp", 1300, 0.6],
      ["lp", 4500, 0.707],
    ],
    0.35,
    0.45,
    25,
  );
  const scuffs = chatter(rng, n, sr, {
    rate: 28,
    rateDepth: 0.75,
    centre: [550, 2600],
    q: [0.9, 1.4],
    attack: [0.001, 0.003],
    decay: [0.004, 0.012],
    spread: 0.35,
  });
  const b = mix(n, [
    [scuffBed, 1],
    [scuffs, 1.1],
  ]);
  // Skips: the level dips by up to ~10 dB for 40-120 ms now and then.
  const hops = swells(rng, n, sr, Math.round((n / sr) * 1.4), [0.04, 0.12]);
  for (let i = 0; i < n; i++) b[i] = b[i]! * (1 - 0.7 * hops[i]!);
  return finishLoop(
    circularFilter(b, sr, [
      ["peak", 650, 2.5, 6],
      ["peak", 1500, 3, 5],
      ["hp", 150, 0.707],
      ["lp", 5000, 0.707],
    ]),
    sr,
  );
};

/**
 * A steel drum rolling, or a heavy case tumbling slowly: a low rumble
 * (35-220 Hz) that undulates irregularly, a quiet rolling-contact band
 * around 600 Hz, and soft irregular knocks (about 2.5 a second, never
 * closer than 0.12 s): each a rounded low thud (5 ms raised-cosine attack)
 * with a faint, heavily damped crowd of metal partials drawn afresh per
 * knock, so no pitch repeats.
 */
export const rollMetal: Recipe = ({ sr, rng }) => {
  const n = contactLoopLength(sr);
  const rumble = bed(
    rng,
    n,
    sr,
    [
      ["hp", 35, 0.707],
      ["lp", 220, 0.707],
      ["lp", 300, 0.707],
    ],
    0.35,
    0.3,
    8,
  );
  const contact = bed(
    rng,
    n,
    sr,
    [
      ["hp", 250, 0.707],
      ["bp", 600, 0.7],
      ["lp", 1800, 0.707],
    ],
    0.4,
    0.5,
    20,
  );
  const knocks = new Float32Array(n);
  const swing = drift(rng, n, 5, 30, 7);
  const times = poissonTimes(
    rng,
    n,
    sr,
    (u) => 2.5 * Math.max(0.2, 1 + 0.6 * at(swing, u)),
    6.5,
    0.12,
  );
  for (const start of times) {
    const level = 0.35 + 0.65 * rng.next();
    const thud = noiseEvent(sr, rng, {
      attack: between(rng, 0.004, 0.008),
      decay: between(rng, 0.025, 0.045),
      filters: [
        ["bp", between(rng, 85, 160), 0.9],
        ["lp", 420, 0.707],
      ],
    });
    stamp(knocks, unit(thud), start, level);
    const ring = cluster(sr, rng, {
      count: 24,
      lo: 260,
      hi: 2200,
      spacing: "log",
      tilt: -0.6,
      material: { d: 40, c: 30 },
      scatter: 0.5,
      contact: 0.004,
      length: 0.18,
    });
    stamp(knocks, unit(ring), start + Math.round(0.002 * sr), level * 0.16);
  }
  unit(knocks);
  const b = mix(n, [
    [rumble, 1],
    [contact, 0.3],
    [knocks, 0.85],
  ]);
  return finishLoop(
    circularFilter(b, sr, [
      ["hp", 30, 0.707],
      ["lp", 3000, 0.707],
    ]),
    sr,
  );
};
