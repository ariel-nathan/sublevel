/**
 * Room acoustics: four procedurally generated reverberation characters the
 * game switches between by area (`AudioSystem.setRoom`), and the pure
 * helpers around them. The Web Audio wrapper (index.ts) cross-fades between
 * convolvers loaded with these impulse responses.
 *
 * Numbers follow the reverb research in DESIGN.md: the period's EAX/I3DL2
 * presets put a plain room at 0.4 s, a hallway at 1.5 s and stone rooms and
 * corridors at 2.3-2.7 s, with high frequencies decaying at 0.6-0.8 of the
 * mid time, first reflections at 7-13 ms and late reverb at 11-20 ms. These
 * are shorter than the presets because the game's spaces are small and the
 * dry sound must stay dominant (the old single room was 0.85 s).
 */
import type { AcousticZone, RoomAcoustics } from "../core/api";
import { createRng, hashString } from "../core/rng";
import type { Vec3 } from "../math";

export const ROOMS: readonly RoomAcoustics[] = [
  "small",
  "lab",
  "corridor",
  "hall",
];

export interface RoomPreset {
  /** Decay to -60 dB in the low, mid and high bands, seconds. */
  rt60Low: number;
  rt60Mid: number;
  rt60High: number;
  /** Band crossovers (one-pole), Hz. */
  crossLow: number;
  crossHigh: number;
  /** Delay before anything arrives, s. */
  preDelay: number;
  /** Length of the response, s. */
  seconds: number;
  /** Discrete early reflections: how many, over which window after the pre-delay (s), how loud, how dull (Hz). */
  early: { count: number; from: number; to: number; level: number; lp: number };
  /** Flutter echo between two parallel walls: period (s), count, level, 1/e decay (s). */
  flutter?: { period: number; count: number; level: number; decay: number };
  /** Time for the diffuse tail to build up, s. */
  buildUp: number;
  /** Relative level of the low, mid and high tail bands (spectral tilt). */
  bands: { low: number; mid: number; high: number };
  /** Level of the reverb return for this room (the dry sound is 1). */
  wet: number;
}

/**
 * The four rooms:
 * - small: an alcove or cupboard. Tight, bright and short (0.28 s), first
 *   reflections within 2-14 ms, little level.
 * - lab: a medium room with hard walls and furniture. Short (0.55 s),
 *   slightly bright.
 * - corridor: longer (1.1 s), darker (highs die in 0.5 s), with a flutter
 *   echo every 13.5 ms (two concrete walls about 2.3 m apart) that dies
 *   within a quarter second.
 * - hall: a large storage room. Longest (1.8 s mid, 2.3 s low), late onset
 *   (20 ms), slow diffuse build-up, low-mid heavy and dark.
 */
export const ROOM_PRESETS: Readonly<Record<RoomAcoustics, RoomPreset>> = {
  small: {
    rt60Low: 0.32,
    rt60Mid: 0.28,
    rt60High: 0.22,
    crossLow: 400,
    crossHigh: 3500,
    preDelay: 0.002,
    seconds: 0.45,
    early: { count: 8, from: 0.002, to: 0.014, level: 0.7, lp: 9000 },
    buildUp: 0.006,
    bands: { low: 0.8, mid: 1, high: 1.1 },
    wet: 0.5,
  },
  lab: {
    rt60Low: 0.62,
    rt60Mid: 0.55,
    rt60High: 0.4,
    crossLow: 400,
    crossHigh: 3500,
    preDelay: 0.005,
    seconds: 0.85,
    early: { count: 9, from: 0.004, to: 0.032, level: 0.55, lp: 7000 },
    buildUp: 0.015,
    bands: { low: 0.9, mid: 1, high: 0.95 },
    wet: 0.7,
  },
  corridor: {
    rt60Low: 1.3,
    rt60Mid: 1.1,
    rt60High: 0.5,
    crossLow: 400,
    crossHigh: 3000,
    preDelay: 0.008,
    seconds: 1.6,
    early: { count: 9, from: 0.008, to: 0.05, level: 0.5, lp: 5000 },
    flutter: { period: 0.0135, count: 22, level: 0.6, decay: 0.1 },
    buildUp: 0.05,
    bands: { low: 1, mid: 0.9, high: 0.55 },
    wet: 0.9,
  },
  hall: {
    rt60Low: 2.3,
    rt60Mid: 1.8,
    rt60High: 0.8,
    crossLow: 450,
    crossHigh: 2500,
    preDelay: 0.02,
    seconds: 2.6,
    early: { count: 12, from: 0.015, to: 0.09, level: 0.35, lp: 2500 },
    buildUp: 0.07,
    bands: { low: 2.4, mid: 1.2, high: 0.35 },
    wet: 1,
  },
};

/** Cross-fade time between rooms, seconds. */
export const ROOM_FADE = 0.4;

/** The room the game assumes outside every acoustic zone. */
export const DEFAULT_ROOM: RoomAcoustics = "corridor";

/**
 * A stereo room impulse response: silence for the pre-delay, discrete early
 * reflections (each a short Hann-shaped tap, dulled by its `lp`), an
 * optional flutter echo, then a dense diffuse tail of noise split into three
 * bands that each decay at their own rate and build up over `buildUp`.
 * Dense noise has no periodic structure, so the tail never rings. The two
 * channels are decorrelated; each is scaled to unit energy. Deterministic.
 */
export function roomImpulse(
  sampleRate: number,
  room: RoomPreset,
  seed = 11,
): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.round(sampleRate * room.seconds));
  const pre = Math.round(sampleRate * room.preDelay);
  const rng = createRng(seed);
  const k = (rt: number) => 6.91 / rt;
  const channels: Float32Array[] = [];
  const addTap = (out: Float32Array, t: number, amp: number, lp: number) => {
    const len = Math.max(1, Math.round(sampleRate / lp));
    const start = pre + Math.round(t * sampleRate);
    for (let j = 0; j < len && start + j < n; j++) {
      const w = Math.sin((Math.PI * (j + 0.5)) / len);
      out[start + j] = out[start + j]! + amp * w;
    }
  };
  for (let c = 0; c < 2; c++) {
    const out = new Float32Array(n);
    const e = room.early;
    for (let r = 0; r < e.count; r++) {
      const t = e.from + (e.to - e.from) * ((r + rng.next()) / e.count);
      const amp =
        (rng.next() < 0.5 ? -1 : 1) *
        e.level *
        Math.exp(-k(room.rt60Mid) * t) *
        (0.6 + 0.4 * rng.next());
      addTap(out, t, amp, e.lp);
    }
    if (room.flutter) {
      const f = room.flutter;
      for (let r = 1; r <= f.count; r++) {
        const t = f.period * r * (1 + (rng.next() - 0.5) * 0.03);
        // Each round trip loses highs to the concrete: wider taps later.
        addTap(out, t, f.level * Math.exp(-t / f.decay), 4000 / (1 + 0.15 * r));
      }
    }
    let lp1 = 0;
    let lp2 = 0;
    const a1 = 1 - Math.exp((-2 * Math.PI * room.crossLow) / sampleRate);
    const a2 = 1 - Math.exp((-2 * Math.PI * room.crossHigh) / sampleRate);
    const b = room.bands;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      const x = rng.next() * 2 - 1;
      lp1 += a1 * (x - lp1);
      lp2 += a2 * (x - lp2);
      const tail =
        b.low * lp1 * Math.exp(-k(room.rt60Low) * t) +
        b.mid * (lp2 - lp1) * Math.exp(-k(room.rt60Mid) * t) +
        b.high * 0.7 * (x - lp2) * Math.exp(-k(room.rt60High) * t);
      const build = Math.min(1, t / room.buildUp);
      out[i] = out[i]! + tail * 0.35 * build * build * (3 - 2 * build);
    }
    // Fade the last 5% so the tail ends without a step.
    const fade = Math.round(n * 0.05);
    for (let i = 0; i < fade; i++)
      out[n - 1 - i] = out[n - 1 - i]! * (i / fade);
    let energy = 0;
    for (let i = 0; i < n; i++) energy += out[i]! * out[i]!;
    const norm = energy > 0 ? 1 / Math.sqrt(energy) : 1;
    for (let i = 0; i < n; i++) out[i] = out[i]! * norm;
    channels.push(out);
  }
  return [channels[0]!, channels[1]!];
}

const cache = new Map<string, [Float32Array, Float32Array]>();

/** `roomImpulse` for a named room, generated once per sample rate. */
export function roomImpulseFor(
  room: RoomAcoustics,
  sampleRate: number,
): [Float32Array, Float32Array] {
  const key = `${room}@${sampleRate}`;
  let ir = cache.get(key);
  if (!ir) {
    ir = roomImpulse(
      sampleRate,
      ROOM_PRESETS[room],
      hashString(`room:${room}`),
    );
    cache.set(key, ir);
  }
  return ir;
}

/**
 * Decay time to -60 dB estimated from an impulse response by Schroeder
 * backward integration: the time the integrated energy takes to fall from
 * -5 to -25 dB, times 3 (T20). Seconds.
 */
export function decayTime(ir: Float32Array, sampleRate: number): number {
  const n = ir.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += ir[i]! * ir[i]!;
    edc[i] = acc;
  }
  const total = edc[0]!;
  if (total <= 0) return 0;
  let t5 = -1;
  let t25 = -1;
  for (let i = 0; i < n; i++) {
    const d = 10 * Math.log10(edc[i]! / total + 1e-30);
    if (t5 < 0 && d <= -5) t5 = i;
    if (d <= -25) {
      t25 = i;
      break;
    }
  }
  if (t5 < 0 || t25 < 0) return (n / sampleRate) * 1.5;
  return (3 * (t25 - t5)) / sampleRate;
}

function inside(p: Vec3, z: AcousticZone, margin: number): boolean {
  return (
    p.x >= z.box.min.x - margin &&
    p.x <= z.box.max.x + margin &&
    p.y >= z.box.min.y - margin &&
    p.y <= z.box.max.y + margin &&
    p.z >= z.box.min.z - margin &&
    p.z <= z.box.max.z + margin
  );
}

/**
 * The room acoustics at `position` (the listener): the first zone that
 * contains it, or `DEFAULT_ROOM` outside every zone. If `current` is given
 * and a zone of that room still contains the position within `margin`
 * metres, the room is kept, so standing in a doorway between two zones does
 * not flip the reverb back and forth.
 */
export function roomAt(
  zones: readonly AcousticZone[],
  position: Vec3,
  current?: RoomAcoustics,
  margin = 0.4,
): RoomAcoustics {
  if (current !== undefined) {
    // Still (nearly) inside a zone of the current room: keep it.
    if (zones.some((z) => z.room === current && inside(position, z, margin)))
      return current;
    // In the default room, a zone has to be entered by `margin` first.
    if (
      current === DEFAULT_ROOM &&
      zones.every((z) => !inside(position, z, -margin))
    )
      return current;
  }
  for (const z of zones) if (inside(position, z, 0)) return z.room;
  return DEFAULT_ROOM;
}
