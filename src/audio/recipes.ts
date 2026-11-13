/**
 * One synthesis recipe per sound. Each returns a raw mono buffer; level,
 * DC removal, fades and the era treatment are applied afterwards in one place
 * (see `renderSound` and mix.ts), so recipes only shape timbre and time.
 *
 * Recipes take a `variant` index: variants are the same design struck or
 * stepped slightly differently (strike position, timing, mode jitter), the way
 * period games shipped several takes per surface.
 */
import type { SoundId } from "../core/api";
import type { Rng } from "../core/rng";
import { TAU, applyChain, biquad, samples } from "./dsp";
import { rollMetal, scrapeMetal, scrapePlastic, scrapeWood } from "./contact";
import { doorBlocked, objective, timerTick } from "./cues";
import { periodicNoisePair } from "./fft";
import {
  MATERIALS,
  PLASTIC_SHELL_MODES,
  STEEL_DRUM_MODES,
  WOOD_CRATE_MODES,
  buffer,
  strike,
  type Material,
  type Mode,
} from "./modal";

export interface RecipeContext {
  sr: number;
  rng: Rng;
  /** 0 for the canonical take. */
  variant: number;
}

export type Recipe = (c: RecipeContext) => Float32Array;

// --- Building blocks -----------------------------------------------------------

interface BurstOptions {
  dur: number;
  /** Seconds into the output. */
  at?: number;
  /** Linear attack, seconds. */
  attack?: number;
  /** Exponential 1/e decay, seconds. */
  decay?: number;
  /** Extra envelope over u in [0, 1]. */
  curve?: (u: number) => number;
  hp?: number;
  lp?: number;
  /** Band-pass centre (with `q`). */
  bp?: number;
  q?: number;
  amp: number;
}

/** Filtered noise burst with an envelope (unit RMS before the envelope). */
function burst(out: Float32Array, sr: number, rng: Rng, o: BurstOptions): void {
  const n = samples(sr, o.dur);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rng.next() * 2 - 1;
  const stages: ((v: number) => number)[] = [];
  if (o.hp) stages.push(biquad("hp", o.hp, 0.707, sr));
  if (o.lp) stages.push(biquad("lp", o.lp, 0.707, sr));
  if (o.bp) stages.push(biquad("bp", o.bp, o.q ?? 1, sr));
  applyChain(x, ...stages);
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i]! * x[i]!;
  const norm = e > 0 ? 1 / Math.sqrt(e / n) : 0;
  const start = Math.round((o.at ?? 0) * sr);
  const attack = o.attack ?? 0.0005;
  for (let i = 0; i < n; i++) {
    const j = start + i;
    if (j < 0 || j >= out.length) continue;
    const t = i / sr;
    let env = Math.min(1, t / attack);
    if (o.decay) env *= Math.exp(-t / o.decay);
    if (o.curve) env *= o.curve(i / n);
    out[j] = out[j]! + x[i]! * norm * env * o.amp;
  }
}

/**
 * Sparse random clicks (Poisson, `rate` per second) with decaying density,
 * band-limited: the grit of a sole on concrete or splinters of wood.
 */
function crackle(
  out: Float32Array,
  sr: number,
  rng: Rng,
  o: {
    at: number;
    dur: number;
    rate: number;
    decay: number;
    amp: number;
    hp: number;
    lp: number;
  },
): void {
  const n = samples(sr, o.dur);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const density = (o.rate / sr) * Math.exp(-t / o.decay);
    if (rng.next() < density)
      x[i] = (rng.next() * 2 - 1) * Math.exp(-t / o.decay);
  }
  applyChain(x, biquad("hp", o.hp, 0.707, sr), biquad("lp", o.lp, 0.707, sr));
  const start = Math.round(o.at * sr);
  for (let i = 0; i < n && start + i < out.length; i++) {
    out[start + i] = out[start + i]! + x[i]! * o.amp;
  }
}

/** Damped low sine with a slight downward pitch glide: the weight in a thump. */
function thump(
  out: Float32Array,
  sr: number,
  o: {
    at?: number;
    f0: number;
    f1: number;
    glide: number;
    decay: number;
    amp: number;
  },
): void {
  const start = Math.round((o.at ?? 0) * sr);
  const n = Math.min(out.length - start, Math.ceil(o.decay * 8 * sr));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = o.f1 + (o.f0 - o.f1) * Math.exp(-t / o.glide);
    phase += (TAU * f) / sr;
    const env = Math.min(1, t / 0.002) * Math.exp(-t / o.decay);
    out[start + i] = out[start + i]! + Math.sin(phase) * env * o.amp;
  }
}

/** Tone with harmonics and an attack/hold/release envelope. */
function tone(
  out: Float32Array,
  sr: number,
  o: {
    at: number;
    dur: number;
    freq: number | ((t: number) => number);
    harmonics: readonly number[];
    attack: number;
    release: number;
    amp: number;
    /** Optional amplitude modulation (t => factor). */
    am?: (t: number) => number;
  },
): void {
  const start = Math.round(o.at * sr);
  const n = samples(sr, o.dur);
  let phase = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / sr;
    const f = typeof o.freq === "number" ? o.freq : o.freq(t);
    phase += (TAU * f) / sr;
    let s = 0;
    o.harmonics.forEach((a, h) => {
      if (f * (h + 1) < sr * 0.45) s += a * Math.sin(phase * (h + 1));
    });
    const env = Math.min(1, t / o.attack, (o.dur - t) / o.release);
    out[start + i] =
      out[start + i]! + s * Math.max(0, env) * o.amp * (o.am ? o.am(t) : 1);
  }
}

/** Same modes with each gain and frequency jittered: a different strike point. */
function strikePoint(
  modes: readonly Mode[],
  rng: Rng,
  variant: number,
  spread = 0.35,
): Mode[] {
  if (variant === 0) return modes.slice();
  return modes.map((m) => ({
    freq: m.freq * (1 + (rng.next() - 0.5) * 0.02),
    gain: m.gain * (1 + (rng.next() * 2 - 1) * spread),
  }));
}

// --- Footsteps and body ------------------------------------------------------------

/** Generic shoe-sole modes (rubber heel on a rigid floor): a damped knock. */
const SOLE_MODES: readonly Mode[] = [
  { freq: 160, gain: 0.5 },
  { freq: 420, gain: 1 },
  { freq: 760, gain: 0.8 },
  { freq: 1250, gain: 0.55 },
  { freq: 2100, gain: 0.35 },
];
const SOLE: Material = { d: 6, c: 70 };

const footstepConcrete: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 0.2);
  const toe = 0.038 + rng.next() * 0.02;
  const modes = strikePoint(SOLE_MODES, rng, variant, 0.25);
  // Heel: firm knock, plus the dull weight of the foot.
  strike(b, sr, rng, {
    modes,
    material: SOLE,
    contact: 0.0011,
    gain: 1,
    roughness: 0.4,
  });
  thump(b, sr, { f0: 130, f1: 95, glide: 0.01, decay: 0.016, amp: 0.2 });
  // Grit between sole and concrete: sparse bright crackle.
  crackle(b, sr, rng, {
    at: 0.001,
    dur: 0.09,
    rate: 2600,
    decay: 0.03,
    amp: 1.3,
    hp: 1200,
    lp: 6500,
  });
  burst(b, sr, rng, {
    dur: 0.05,
    attack: 0.001,
    decay: 0.012,
    hp: 500,
    lp: 4000,
    amp: 0.45,
  });
  // Ball of the foot slapping down after the heel.
  strike(b, sr, rng, {
    modes,
    material: SOLE,
    contact: 0.0016,
    at: toe,
    gain: 0.45,
    pitch: 1.12,
  });
  burst(b, sr, rng, {
    at: toe,
    dur: 0.06,
    attack: 0.002,
    decay: 0.015,
    hp: 900,
    lp: 6000,
    amp: 0.12,
  });
  return b;
};

const TILE_MODES: readonly Mode[] = [
  { freq: 470, gain: 0.5 },
  { freq: 1830, gain: 0.8 },
  { freq: 2710, gain: 1 },
  { freq: 3580, gain: 0.8 },
  { freq: 4460, gain: 0.55 },
  { freq: 5900, gain: 0.35 },
];

const footstepTile: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 0.17);
  const toe = 0.034 + rng.next() * 0.016;
  const sole = strikePoint(SOLE_MODES, rng, variant, 0.25);
  const tile = strikePoint(TILE_MODES, rng, variant, 0.3);
  // Hard heel click: short contact excites the tile's own ring.
  strike(b, sr, rng, {
    modes: tile,
    material: MATERIALS.ceramic,
    contact: 0.0002,
    gain: 0.9,
  });
  strike(b, sr, rng, {
    modes: sole,
    material: SOLE,
    contact: 0.0009,
    gain: 0.45,
    pitch: 1.1,
  });
  burst(b, sr, rng, {
    dur: 0.02,
    attack: 0.0002,
    decay: 0.003,
    hp: 2500,
    lp: 10000,
    amp: 0.8,
  });
  // Toe click, a little weaker and brighter.
  strike(b, sr, rng, {
    modes: tile,
    material: MATERIALS.ceramic,
    contact: 0.0003,
    at: toe,
    gain: 0.2,
    pitch: 1.04,
  });
  strike(b, sr, rng, {
    modes: sole,
    material: SOLE,
    contact: 0.0012,
    at: toe,
    gain: 0.15,
    pitch: 1.2,
  });
  burst(b, sr, rng, {
    at: toe,
    dur: 0.02,
    attack: 0.0002,
    decay: 0.003,
    hp: 3000,
    lp: 10000,
    amp: 0.15,
  });
  // A trace of grit.
  crackle(b, sr, rng, {
    at: 0.002,
    dur: 0.05,
    rate: 700,
    decay: 0.02,
    amp: 0.5,
    hp: 3000,
    lp: 9000,
  });
  return b;
};

/** Steel bar grating: resonant, dense mid modes. */
export const GRATE_MODES: readonly Mode[] = [
  { freq: 318, gain: 0.55 },
  { freq: 547, gain: 0.8 },
  { freq: 781, gain: 1 },
  { freq: 1046, gain: 0.85 },
  { freq: 1384, gain: 0.7 },
  { freq: 1797, gain: 0.5 },
  { freq: 2311, gain: 0.45 },
  { freq: 2960, gain: 0.4 },
  { freq: 3720, gain: 0.3 },
  { freq: 4610, gain: 0.2 },
];

const footstepMetal: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 0.32);
  const grate = strikePoint(GRATE_MODES, rng, variant, 0.3);
  const sole = strikePoint(SOLE_MODES, rng, variant, 0.25);
  strike(b, sr, rng, {
    modes: grate,
    material: MATERIALS.grating,
    contact: 0.0003,
    gain: 0.5,
    roughness: 0.3,
  });
  strike(b, sr, rng, {
    modes: sole,
    material: SOLE,
    contact: 0.001,
    gain: 0.55,
  });
  burst(b, sr, rng, {
    dur: 0.03,
    attack: 0.0003,
    decay: 0.005,
    hp: 2000,
    lp: 9000,
    amp: 0.25,
  });
  // Hollow pit under the grate.
  thump(b, sr, { f0: 105, f1: 82, glide: 0.02, decay: 0.035, amp: 0.25 });
  // The grate rattles in its frame: a few small re-strikes, decaying.
  let t = 0.012 + rng.next() * 0.008;
  let g = 0.32;
  for (let k = 0; k < 4; k++) {
    strike(b, sr, rng, {
      modes: grate,
      material: MATERIALS.grating,
      contact: 0.0004,
      at: t,
      gain: g,
      pitch: 1 + (rng.next() - 0.5) * 0.02,
    });
    t += 0.011 + rng.next() * 0.016;
    g *= 0.55 + rng.next() * 0.2;
  }
  // Ball of the foot.
  const toe = 0.045 + rng.next() * 0.015;
  strike(b, sr, rng, {
    modes: grate,
    material: MATERIALS.grating,
    contact: 0.0005,
    at: toe,
    gain: 0.3,
  });
  strike(b, sr, rng, {
    modes: sole,
    material: SOLE,
    contact: 0.0014,
    at: toe,
    gain: 0.3,
    pitch: 1.12,
  });
  return b;
};

const land: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 0.3);
  const sole = strikePoint(SOLE_MODES, rng, variant, 0.25);
  const second = 0.012 + rng.next() * 0.012;
  // Two feet, almost together, with the body's weight behind them.
  strike(b, sr, rng, {
    modes: sole,
    material: SOLE,
    contact: 0.0016,
    gain: 1,
    pitch: 0.9,
  });
  strike(b, sr, rng, {
    modes: sole,
    material: SOLE,
    contact: 0.0018,
    at: second,
    gain: 0.8,
    pitch: 0.95,
  });
  thump(b, sr, { f0: 120, f1: 75, glide: 0.015, decay: 0.03, amp: 0.55 });
  thump(b, sr, {
    at: second,
    f0: 110,
    f1: 72,
    glide: 0.015,
    decay: 0.026,
    amp: 0.4,
  });
  crackle(b, sr, rng, {
    at: 0.001,
    dur: 0.12,
    rate: 3000,
    decay: 0.035,
    amp: 2.5,
    hp: 1500,
    lp: 8000,
  });
  // Gear and clothing settling.
  burst(b, sr, rng, {
    at: 0.01,
    dur: 0.16,
    attack: 0.01,
    decay: 0.05,
    hp: 700,
    lp: 4500,
    amp: 0.3,
  });
  return b;
};

const jump: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.16);
  // Push-off scuff and a short cloth swish.
  burst(b, sr, rng, {
    dur: 0.05,
    attack: 0.002,
    decay: 0.012,
    hp: 900,
    lp: 5000,
    amp: 0.6,
  });
  crackle(b, sr, rng, {
    at: 0.0,
    dur: 0.04,
    rate: 1500,
    decay: 0.015,
    amp: 0.6,
    hp: 2000,
    lp: 8000,
  });
  burst(b, sr, rng, {
    at: 0.015,
    dur: 0.14,
    attack: 0.03,
    curve: (u) => (1 - u) ** 2,
    bp: 1400,
    q: 0.7,
    amp: 0.35,
  });
  return b;
};

// --- Impacts ---------------------------------------------------------------------------

/**
 * Impacts are rendered as a medium hit (contact time between soft and hard)
 * so that the game's gain (0.25..1) and pitch (0.85..1.25) scaling covers
 * soft taps to hard slams from one buffer.
 */
const impactWood: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 0.42);
  const modes = strikePoint(WOOD_CRATE_MODES, rng, variant);
  strike(b, sr, rng, {
    modes,
    material: MATERIALS.wood,
    contact: 0.00035,
    gain: 1,
    roughness: 0.3,
  });
  // The other edge lands a moment later.
  const second = 0.016 + rng.next() * 0.014;
  strike(b, sr, rng, {
    modes,
    material: MATERIALS.wood,
    contact: 0.0005,
    at: second,
    gain: 0.4,
    pitch: 1.01,
  });
  // Weight on concrete and the snap of the contact.
  thump(b, sr, { f0: 110, f1: 78, glide: 0.012, decay: 0.03, amp: 0.45 });
  burst(b, sr, rng, {
    dur: 0.03,
    attack: 0.0002,
    decay: 0.005,
    hp: 900,
    lp: 7000,
    amp: 1.1,
  });
  burst(b, sr, rng, {
    at: second,
    dur: 0.02,
    attack: 0.0002,
    decay: 0.004,
    hp: 900,
    lp: 6000,
    amp: 0.45,
  });
  crackle(b, sr, rng, {
    at: 0.002,
    dur: 0.06,
    rate: 1500,
    decay: 0.02,
    amp: 2.5,
    hp: 1500,
    lp: 7000,
  });
  return b;
};

const impactMetal: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 1.2);
  const modes = strikePoint(STEEL_DRUM_MODES, rng, variant);
  strike(b, sr, rng, {
    modes,
    material: MATERIALS.steel,
    contact: 0.00015,
    gain: 1,
    roughness: 0.2,
  });
  // Micro-collisions while the shell bounces against the floor (within ~15 ms).
  for (let k = 0; k < 3; k++) {
    strike(b, sr, rng, {
      modes,
      material: MATERIALS.steel,
      contact: 0.0003,
      at: 0.003 + rng.next() * 0.012,
      gain: 0.12 + rng.next() * 0.1,
    });
  }
  thump(b, sr, { f0: 120, f1: 85, glide: 0.01, decay: 0.03, amp: 0.45 });
  burst(b, sr, rng, {
    dur: 0.02,
    attack: 0.0002,
    decay: 0.003,
    hp: 2500,
    lp: 10000,
    amp: 1.2,
  });
  return b;
};

const impactPlastic: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 0.2);
  const modes = strikePoint(PLASTIC_SHELL_MODES, rng, variant);
  strike(b, sr, rng, {
    modes,
    material: MATERIALS.plastic,
    contact: 0.00025,
    gain: 1,
    roughness: 0.3,
  });
  // Loose parts inside the housing rattle briefly.
  let t = 0.008 + rng.next() * 0.006;
  for (let k = 0; k < 3; k++) {
    strike(b, sr, rng, {
      modes,
      material: MATERIALS.plastic,
      contact: 0.0003,
      at: t,
      gain: 0.18 / (k + 1),
      pitch: 1.6 + rng.next() * 0.5,
    });
    t += 0.008 + rng.next() * 0.01;
  }
  burst(b, sr, rng, {
    dur: 0.015,
    attack: 0.0002,
    decay: 0.0025,
    hp: 1500,
    lp: 8000,
    amp: 0.9,
  });
  thump(b, sr, { f0: 150, f1: 120, glide: 0.008, decay: 0.012, amp: 0.15 });
  return b;
};

/** Free-free bar (a plank) mode ratios. */
const PLANK_RATIOS = [1, 2.76, 5.4, 8.93];

const crateBreak: Recipe = ({ sr, rng, variant }) => {
  const b = buffer(sr, 0.95);
  const modes = strikePoint(WOOD_CRATE_MODES, rng, variant);
  // Initial hard hit of the crate.
  strike(b, sr, rng, {
    modes,
    material: MATERIALS.wood,
    contact: 0.0006,
    gain: 1,
    roughness: 0.4,
  });
  thump(b, sr, { f0: 120, f1: 70, glide: 0.02, decay: 0.05, amp: 0.8 });
  // Fracture cracks: very short broadband bursts clustered in the first 60 ms.
  for (let k = 0; k < 7; k++) {
    const at = 0.002 + rng.next() ** 1.5 * 0.06;
    burst(b, sr, rng, {
      at,
      dur: 0.012,
      attack: 0.0001,
      decay: 0.002 + rng.next() * 0.002,
      hp: 1200,
      lp: 9500,
      amp: 0.9 * (1 - at * 8),
    });
  }
  // Splinter crackle.
  crackle(b, sr, rng, {
    at: 0.004,
    dur: 0.45,
    rate: 5000,
    decay: 0.12,
    amp: 3,
    hp: 1500,
    lp: 9000,
  });
  // Planks and pieces falling to the floor.
  for (let k = 0; k < 12; k++) {
    const at = 0.06 + rng.next() ** 1.2 * 0.62;
    const f0 = 180 + rng.next() * 260;
    const plank = PLANK_RATIOS.map((r, i) => ({
      freq: f0 * r,
      gain: [1, 0.6, 0.35, 0.2][i]!,
    }));
    strike(b, sr, rng, {
      modes: plank,
      material: MATERIALS.wood,
      contact: 0.0008,
      at,
      gain: 0.7 * Math.exp(-(at - 0.06) / 0.45) * (0.5 + rng.next() * 0.5),
    });
  }
  return b;
};

// --- Handling ---------------------------------------------------------------------------

const pickup: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.14);
  // Hand closes on the object: a soft muffled knock and a quick rustle.
  const knock: Mode[] = [
    { freq: 290, gain: 1 },
    { freq: 520, gain: 0.7 },
    { freq: 910, gain: 0.4 },
    { freq: 1500, gain: 0.25 },
  ];
  strike(b, sr, rng, {
    modes: knock,
    material: { d: 8, c: 40 },
    contact: 0.002,
    gain: 1,
  });
  burst(b, sr, rng, {
    dur: 0.08,
    attack: 0.004,
    decay: 0.02,
    hp: 800,
    lp: 5000,
    amp: 0.2,
  });
  crackle(b, sr, rng, {
    at: 0.004,
    dur: 0.05,
    rate: 800,
    decay: 0.02,
    amp: 0.4,
    hp: 2000,
    lp: 7000,
  });
  return b;
};

const throwSound: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.26);
  // Swing: a band of air sweeping up then down, with effort-weighted swell.
  const n = samples(sr, 0.24);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rng.next() * 2 - 1;
  const lp = biquad("lp", 6000, 0.707, sr);
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const fc = 350 + 1700 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 1.5;
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    const hi = x[i]! - low - 1.1 * band;
    band += f * hi;
    low += f * band;
    const env = Math.sin(Math.PI * u) ** 2 * (1 - 0.35 * u);
    b[i + Math.round(0.01 * sr)] = lp(band) * env;
  }
  burst(b, sr, rng, {
    at: 0,
    dur: 0.03,
    attack: 0.002,
    decay: 0.008,
    hp: 1000,
    lp: 5000,
    amp: 0.05,
  });
  return b;
};

// --- Interaction --------------------------------------------------------------------------

/** Small hard-plastic button cap bottoming out. */
const CAP_MODES: readonly Mode[] = [
  { freq: 1180, gain: 0.6 },
  { freq: 2240, gain: 1 },
  { freq: 3460, gain: 0.7 },
  { freq: 5120, gain: 0.4 },
];
/** Steel panel the button is mounted in. */
const PANEL_MODES: readonly Mode[] = [
  { freq: 205, gain: 0.8 },
  { freq: 330, gain: 1 },
  { freq: 512, gain: 0.7 },
  { freq: 790, gain: 0.5 },
];

function buttonMechanics(
  b: Float32Array,
  sr: number,
  rng: Rng,
  release: number,
): void {
  // Press: cap click, then the switch mechanism clunks into the panel.
  strike(b, sr, rng, {
    modes: CAP_MODES,
    material: { d: 20, c: 160 },
    contact: 0.0002,
    gain: 0.5,
  });
  strike(b, sr, rng, {
    modes: PANEL_MODES,
    material: { d: 30, c: 45 },
    contact: 0.0012,
    at: 0.007,
    gain: 0.55,
  });
  thump(b, sr, {
    at: 0.007,
    f0: 190,
    f1: 150,
    glide: 0.005,
    decay: 0.012,
    amp: 0.35,
  });
  // Release: lighter, higher click.
  strike(b, sr, rng, {
    modes: CAP_MODES,
    material: { d: 20, c: 200 },
    contact: 0.00015,
    at: release,
    gain: 0.3,
    pitch: 1.15,
  });
}

const buttonPress: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.3);
  buttonMechanics(b, sr, rng, 0.11);
  // Relay behind the panel pulls in: a dry metallic tick.
  strike(b, sr, rng, {
    modes: [
      { freq: 2900, gain: 1 },
      { freq: 4300, gain: 0.6 },
      { freq: 1700, gain: 0.4 },
    ],
    material: { d: 60, c: 90 },
    contact: 0.0001,
    at: 0.045,
    gain: 0.25,
  });
  // Acceptance: one short, soft, rounded tone (rising slightly).
  tone(b, sr, {
    at: 0.06,
    dur: 0.12,
    freq: (t) => 1046 * (1 + 0.04 * Math.min(1, t / 0.02)),
    harmonics: [1, 0.25, 0.1],
    attack: 0.004,
    release: 0.07,
    amp: 0.11,
  });
  return b;
};

const buttonDeny: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.42);
  buttonMechanics(b, sr, rng, 0.1);
  // Two low, rough buzzer pulses, the second lower: dissonant tritone pair
  // with 50 Hz amplitude roughness, through a small panel speaker's band.
  const pulse = new Float32Array(b.length);
  const square = [1, 0, 0.33, 0, 0.2, 0, 0.14, 0, 0.11];
  const rough = (t: number) => 0.7 + 0.3 * Math.sin(TAU * 50 * t);
  tone(pulse, sr, {
    at: 0.05,
    dur: 0.12,
    freq: 165,
    harmonics: square,
    attack: 0.004,
    release: 0.012,
    amp: 0.5,
    am: rough,
  });
  tone(pulse, sr, {
    at: 0.05,
    dur: 0.12,
    freq: 165 * Math.SQRT2,
    harmonics: square,
    attack: 0.004,
    release: 0.012,
    amp: 0.3,
    am: rough,
  });
  tone(pulse, sr, {
    at: 0.2,
    dur: 0.17,
    freq: 131,
    harmonics: square,
    attack: 0.004,
    release: 0.03,
    amp: 0.5,
    am: rough,
  });
  tone(pulse, sr, {
    at: 0.2,
    dur: 0.17,
    freq: 131 * Math.SQRT2,
    harmonics: square,
    attack: 0.004,
    release: 0.03,
    amp: 0.3,
    am: rough,
  });
  applyChain(
    pulse,
    biquad("hp", 280, 0.707, sr),
    biquad("lp", 2800, 0.707, sr),
    biquad("peak", 900, 1.2, sr, 5),
  );
  for (let i = 0; i < b.length; i++) b[i] = b[i]! + pulse[i]!;
  return b;
};

/** Steel door slab modes. */
const DOOR_MODES: readonly Mode[] = [
  { freq: 96, gain: 0.7 },
  { freq: 184, gain: 0.8 },
  { freq: 291, gain: 1 },
  { freq: 437, gain: 0.8 },
  { freq: 618, gain: 0.6 },
  { freq: 866, gain: 0.45 },
  { freq: 1190, gain: 0.3 },
  { freq: 1620, gain: 0.2 },
];

/** Door travel time in seconds: 1.45 m at up to 1.6 m/s (see props/doors.ts). */
export const DOOR_TRAVEL = 1.13;

/** Door speed profile in [0, 1] at time t: accelerate, cruise, decelerate. */
function doorSpeed(t: number): number {
  if (t <= 0 || t >= DOOR_TRAVEL) return 0;
  const accel = 0.2;
  const decel = 0.27;
  if (t < accel) return t / accel;
  if (t > DOOR_TRAVEL - decel) return (DOOR_TRAVEL - t) / decel;
  return 1;
}

/** Motor, gearing and slab rumble while the door moves. */
function doorMotion(
  b: Float32Array,
  sr: number,
  rng: Rng,
  opening: boolean,
  start: number,
): void {
  const n = Math.min(
    b.length - Math.round(start * sr),
    samples(sr, DOOR_TRAVEL),
  );
  const s0 = Math.round(start * sr);
  const rumbleLp = biquad("lp", 260, 0.8, sr);
  const rumbleHp = biquad("hp", 45, 0.707, sr);
  const hissBp = biquad("bp", 2400, 0.8, sr);
  let phase = 0;
  const base = opening ? 104 : 96;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = doorSpeed(t);
    const smooth = v * v * (3 - 2 * v);
    // Motor pitch follows speed; the gear whine sits 9x above the rotor.
    const f =
      base * (0.55 + 0.45 * smooth) * (1 + 0.006 * Math.sin(TAU * 7 * t));
    phase += (TAU * f) / sr;
    const motor =
      0.5 * Math.sin(phase) +
      0.35 * Math.sin(2 * phase) +
      0.22 * Math.sin(3 * phase + 0.4) +
      0.12 * Math.sin(4 * phase) +
      0.06 * Math.sin(9 * phase) +
      0.035 * Math.sin(18 * phase + 1);
    const noise = rng.next() * 2 - 1;
    const rumble = rumbleHp(rumbleLp(noise)) * 3.2;
    const hiss = hissBp(noise) * 0.25;
    b[s0 + i] =
      b[s0 + i]! + (motor * 0.42 + rumble * 0.5 + hiss) * Math.sqrt(v) * 0.9;
  }
  // Rollers crossing rail joints: a few soft ticks.
  for (let k = 0; k < 4; k++) {
    const t = 0.25 + k * 0.19 + rng.next() * 0.05;
    strike(b, sr, rng, {
      modes: DOOR_MODES,
      material: MATERIALS.plate,
      contact: 0.002,
      at: start + t,
      gain: 0.06 + rng.next() * 0.04,
      pitch: 1.6,
    });
  }
}

function door(opening: boolean): Recipe {
  return ({ sr, rng }) => {
    const b = buffer(sr, 1.6);
    const motionStart = 0.04;
    const end = motionStart + DOOR_TRAVEL;
    if (opening) {
      // Latch solenoid releases with a firm clunk, then the seal breaks with
      // a burst of air.
      strike(b, sr, rng, {
        modes: DOOR_MODES,
        material: MATERIALS.plate,
        contact: 0.0015,
        gain: 0.6,
      });
      thump(b, sr, { f0: 140, f1: 95, glide: 0.01, decay: 0.03, amp: 0.55 });
      burst(b, sr, rng, {
        at: 0.012,
        dur: 0.45,
        attack: 0.004,
        decay: 0.12,
        hp: 1800,
        lp: 9000,
        amp: 0.55,
      });
      burst(b, sr, rng, {
        at: 0.012,
        dur: 0.2,
        attack: 0.003,
        decay: 0.05,
        bp: 700,
        q: 0.8,
        amp: 0.25,
      });
      doorMotion(b, sr, rng, true, motionStart);
      // Soft stop on the open side (rubber bumper).
      strike(b, sr, rng, {
        modes: DOOR_MODES,
        material: { d: 30, c: 25 },
        contact: 0.004,
        at: end,
        gain: 0.35,
      });
      thump(b, sr, {
        at: end,
        f0: 100,
        f1: 80,
        glide: 0.01,
        decay: 0.04,
        amp: 0.4,
      });
    } else {
      // Small click as the drive engages.
      strike(b, sr, rng, {
        modes: CAP_MODES,
        material: { d: 20, c: 120 },
        contact: 0.0003,
        gain: 0.25,
        pitch: 0.7,
      });
      doorMotion(b, sr, rng, false, motionStart);
      // Heavy seal: slab hits the jamb, latch bolt shoots home, air is
      // squeezed out of the gasket.
      strike(b, sr, rng, {
        modes: DOOR_MODES,
        material: MATERIALS.plate,
        contact: 0.0014,
        at: end,
        gain: 1.2,
        roughness: 0.3,
      });
      thump(b, sr, {
        at: end,
        f0: 120,
        f1: 68,
        glide: 0.02,
        decay: 0.07,
        amp: 1.1,
      });
      burst(b, sr, rng, {
        at: end,
        dur: 0.04,
        attack: 0.0003,
        decay: 0.006,
        hp: 1500,
        lp: 8000,
        amp: 0.4,
      });
      strike(b, sr, rng, {
        modes: [
          { freq: 1480, gain: 1 },
          { freq: 2630, gain: 0.7 },
          { freq: 3950, gain: 0.4 },
        ],
        material: { d: 60, c: 60 },
        contact: 0.0002,
        at: end + 0.07,
        gain: 0.3,
      });
      burst(b, sr, rng, {
        at: end + 0.01,
        dur: 0.22,
        attack: 0.008,
        decay: 0.05,
        bp: 1100,
        q: 0.7,
        amp: 0.3,
      });
    }
    return b;
  };
}

const PLATE_MODES: readonly Mode[] = [
  { freq: 312, gain: 1 },
  { freq: 541, gain: 0.8 },
  { freq: 823, gain: 0.6 },
  { freq: 1188, gain: 0.45 },
  { freq: 1650, gain: 0.3 },
];

function plate(down: boolean): Recipe {
  return ({ sr, rng }) => {
    const b = buffer(sr, 0.3);
    if (down) {
      // The heavy plate sinks onto its stops; the switch closes just after.
      thump(b, sr, { f0: 120, f1: 78, glide: 0.012, decay: 0.04, amp: 1 });
      strike(b, sr, rng, {
        modes: PLATE_MODES,
        material: { d: 40, c: 25 },
        contact: 0.0018,
        gain: 0.55,
      });
      strike(b, sr, rng, {
        modes: CAP_MODES,
        material: { d: 20, c: 160 },
        contact: 0.0002,
        at: 0.035,
        gain: 0.18,
        pitch: 0.8,
      });
    } else {
      // Springs push it back up: lighter clank, higher, and the switch opens.
      thump(b, sr, { f0: 170, f1: 140, glide: 0.008, decay: 0.02, amp: 0.35 });
      strike(b, sr, rng, {
        modes: PLATE_MODES,
        material: { d: 40, c: 30 },
        contact: 0.0008,
        gain: 0.45,
        pitch: 1.45,
      });
      strike(b, sr, rng, {
        modes: CAP_MODES,
        material: { d: 20, c: 160 },
        contact: 0.00015,
        at: 0.02,
        gain: 0.2,
      });
      tone(b, sr, {
        at: 0.004,
        dur: 0.08,
        freq: (t) => 980 - 900 * t,
        harmonics: [1, 0.3],
        attack: 0.001,
        release: 0.06,
        amp: 0.04,
      });
    }
    return b;
  };
}

// --- Loops ---------------------------------------------------------------------------------

/**
 * Loop length in samples: 2^19 (11.9 s at 44.1 kHz, 10.9 s at 48 kHz), long
 * enough that the repeat is hard to notice, and a power of two so periodic
 * noise can be made with one inverse FFT. Lower rates use 2^18.
 */
export function loopLength(sr: number): number {
  return sr >= 32000 ? 1 << 19 : 1 << 18;
}

/**
 * Smooth random modulation, zero mean and about unit RMS, exactly periodic
 * over n samples: a sum of sinusoids with 4..`maxCycles` cycles per loop and
 * random phases and amplitudes. Excluding 1..3 cycles keeps the loop from
 * swelling once per repeat.
 */
function slowModulator(
  rng: Rng,
  n: number,
  maxCycles = 40,
  count = 9,
): Float32Array {
  const parts: { k: number; a: number; p: number }[] = [];
  let power = 0;
  for (let j = 0; j < count; j++) {
    const k = 4 + Math.floor(rng.next() * (maxCycles - 3));
    const a = (0.5 + rng.next()) / Math.sqrt(k);
    parts.push({ k, a, p: rng.next() * TAU });
    power += (a * a) / 2;
  }
  const norm = 1 / Math.sqrt(power);
  const step = 64;
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

/** Adds a sine at exactly `k` cycles per loop, times an optional envelope. */
function addPeriodicSine(
  out: Float32Array,
  k: number,
  amp: number,
  phase: number,
  env?: Float32Array,
  envDepth = 0,
): void {
  const n = out.length;
  const w = (TAU * k) / n;
  // Rotating phasor, re-anchored every 4096 samples to stay exact.
  for (let block = 0; block < n; block += 4096) {
    let c = Math.cos(w * block + phase);
    let s = Math.sin(w * block + phase);
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const end = Math.min(n, block + 4096);
    for (let i = block; i < end; i++) {
      const e = env ? 1 + envDepth * env[i]! : 1;
      out[i] = out[i]! + s * amp * e;
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw;
      c = c2;
    }
  }
}

/**
 * Adds periodic tones whose levels drift slowly and independently: tones are
 * dealt round-robin into `groups`, and each group gets its own slow random
 * modulator (cheaper than one modulator per tone, and still unsteady).
 */
function driftingTones(
  out: Float32Array,
  rng: Rng,
  tones: readonly { k: number; amp: number }[],
  groups: number,
  depth: number,
  maxCycles: number,
): void {
  const n = out.length;
  const sums = Array.from({ length: groups }, () => new Float32Array(n));
  tones.forEach((t, i) => {
    addPeriodicSine(sums[i % groups]!, t.k, t.amp, rng.next() * TAU);
  });
  for (const sum of sums) {
    const mod = slowModulator(rng, n, maxCycles, 7);
    for (let i = 0; i < n; i++)
      out[i] = out[i]! + sum[i]! * (1 + depth * mod[i]!);
  }
}

/** Cycles per loop nearest to `freq` Hz. */
function cyclesNear(freq: number, n: number, sr: number): number {
  return Math.max(1, Math.round((freq * n) / sr));
}

/** Smooth spectral band: 1 inside [lo, hi], rolling off at `slope` dB/octave outside. */
function band(f: number, lo: number, hi: number, slope = 12): number {
  if (f < lo) return 10 ** ((-slope * Math.log2(lo / f)) / 20);
  if (f > hi) return 10 ** ((-slope * Math.log2(f / hi)) / 20);
  return 1;
}

const humFluorescent: Recipe = ({ sr, rng }) => {
  const n = loopLength(sr);
  const b = new Float32Array(n);
  // Magnetic ballast: the core flexes at twice the mains frequency (120 Hz),
  // with even harmonics of mains strongest and weaker odd ones from
  // saturation. Each harmonic drifts slowly and independently.
  const k60 = cyclesNear(60, n, sr);
  const k120 = 2 * k60;
  const evens = [
    1, 0.5, 0.42, 0.26, 0.2, 0.13, 0.11, 0.07, 0.055, 0.04, 0.03, 0.022,
  ];
  const tones = evens.map((amp, h) => ({ k: k120 * (h + 1), amp }));
  for (const [mult, amp] of [
    [3, 0.1],
    [5, 0.06],
    [7, 0.04],
    [9, 0.025],
  ] as const) {
    tones.push({ k: k60 * mult, amp });
  }
  driftingTones(b, rng, tones, 4, 0.2, 30);
  // Ballast buzz: bright noise gated by the 120 Hz cycle (the arc and
  // laminations chattering), with an unsteady level.
  const [buzz, air] = periodicNoisePair(
    () => rng.next(),
    n,
    sr,
    (f) => band(f, 1800, 6500, 12),
    (f) => band(f, 300, 3000, 6) / Math.sqrt(Math.max(f, 30)),
  );
  const unsteady = slowModulator(rng, n, 60, 10);
  // Gate shape |sin|^6 over one 120 Hz half-cycle, tabulated.
  const table = new Float32Array(1024);
  for (let j = 0; j < 1024; j++) table[j] = Math.sin((Math.PI * j) / 1024) ** 6;
  for (let i = 0; i < n; i++) {
    const gate = table[Math.floor((((k120 * i) % n) / n) * 1024)]!;
    const level = Math.max(0, 1 + 0.45 * unsteady[i]!);
    b[i] = b[i]! + 0.13 * buzz[i]! * gate * level + 0.012 * air[i]!;
  }
  return b;
};

const humMachine: Recipe = ({ sr, rng }) => {
  const n = loopLength(sr);
  const b = new Float32Array(n);
  // Air handler: motor at ~29.6 Hz shaft rate with its harmonics, 120 Hz
  // electrical hum, and a 7-blade fan at 12.4 rev/s (blade-pass ~87 Hz).
  const tones: [number, number][] = [
    [29.6, 0.25],
    [59.2, 0.35],
    [86.8, 0.6],
    [120, 0.45],
    [173.6, 0.3],
    [240, 0.15],
    [260.4, 0.12],
    [347.2, 0.06],
  ];
  driftingTones(
    b,
    rng,
    tones.map(([f, amp]) => ({ k: cyclesNear(f, n, sr), amp })),
    3,
    0.2,
    40,
  );
  // Airflow: broadband rumble with a duct resonance hump, and a moving-air
  // band whose level pulses faintly at the blade rate.
  const [flow, rush] = periodicNoisePair(
    () => rng.next(),
    n,
    sr,
    (f) => band(f, 40, 160, 9) + 0.5 * band(f, 300, 520, 18),
    (f) => band(f, 500, 2200, 12),
  );
  const drift = slowModulator(rng, n, 50, 10);
  const kBlade = cyclesNear(86.8, n, sr);
  for (let i = 0; i < n; i++) {
    const pulse = 1 + 0.25 * Math.sin((TAU * kBlade * i) / n);
    b[i] =
      b[i]! +
      0.55 * flow[i]! * (1 + 0.12 * drift[i]!) +
      0.12 * rush[i]! * pulse;
  }
  return b;
};

const ambientDrone: Recipe = ({ sr, rng }) => {
  const n = loopLength(sr);
  const b = new Float32Array(n);
  // Room tone: distant ventilation as broadband noise falling at about
  // -5 dB/octave above 60 Hz, a little bloom where corridor modes would
  // be, and no discrete events (they would mark the loop length).
  const [body, hollow] = periodicNoisePair(
    () => rng.next(),
    n,
    sr,
    (f) =>
      band(f, 90, 250, 18) *
      (f > 250 ? 10 ** ((-4.5 * Math.log2(f / 250)) / 20) : 1) *
      band(f, 0, 3000, 12),
    (f) =>
      band(f, 170, 200, 18) +
      0.7 * band(f, 400, 450, 18) +
      0.4 * band(f, 900, 1000, 18),
  );
  const swayA = slowModulator(rng, n, 30, 9);
  const swayB = slowModulator(rng, n, 30, 9);
  for (let i = 0; i < n; i++) {
    b[i] =
      body[i]! * (1 + 0.08 * swayA[i]!) +
      0.3 * hollow[i]! * (1 + 0.2 * swayB[i]!);
  }
  // A trace of far-off mains hum.
  const k120 = cyclesNear(120, n, sr);
  addPeriodicSine(b, k120, 0.05, rng.next() * TAU);
  addPeriodicSine(b, k120 * 2, 0.025, rng.next() * TAU);
  return b;
};

export const RECIPES: Record<SoundId, Recipe> = {
  footstep_concrete: footstepConcrete,
  footstep_tile: footstepTile,
  footstep_metal: footstepMetal,
  land,
  jump,
  impact_wood: impactWood,
  impact_metal: impactMetal,
  impact_plastic: impactPlastic,
  crate_break: crateBreak,
  pickup,
  throw: throwSound,
  button_press: buttonPress,
  button_deny: buttonDeny,
  door_open: door(true),
  door_close: door(false),
  plate_down: plate(true),
  plate_up: plate(false),
  hum_fluorescent: humFluorescent,
  hum_machine: humMachine,
  ambient_drone: ambientDrone,
  timer_tick: timerTick,
  door_blocked: doorBlocked,
  objective,
  scrape_wood: scrapeWood,
  scrape_metal: scrapeMetal,
  scrape_plastic: scrapePlastic,
  roll_metal: rollMetal,
};

/** How many distinct takes each sound has (1 = no variants). */
export const VARIANTS: Readonly<Record<SoundId, number>> = {
  footstep_concrete: 4,
  footstep_tile: 4,
  footstep_metal: 4,
  land: 2,
  jump: 1,
  impact_wood: 3,
  impact_metal: 3,
  impact_plastic: 3,
  crate_break: 2,
  pickup: 1,
  throw: 1,
  button_press: 1,
  button_deny: 1,
  door_open: 1,
  door_close: 1,
  plate_down: 1,
  plate_up: 1,
  hum_fluorescent: 1,
  hum_machine: 1,
  ambient_drone: 1,
  timer_tick: 1,
  door_blocked: 1,
  objective: 1,
  scrape_wood: 1,
  scrape_metal: 1,
  scrape_plastic: 1,
  roll_metal: 1,
};
