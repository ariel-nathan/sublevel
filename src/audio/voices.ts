/**
 * Pure helpers for the Web Audio wrapper: clamping, voice limiting with
 * priorities, the distance model and the room impulse response.
 */
import { createRng } from "../core/rng";

export const MAX_ONE_SHOT_VOICES = 24;
/** Identical one-shots closer together than this (seconds) are dropped. */
export const MIN_REPEAT_INTERVAL = 0.03;
export const MIN_GAIN = 0;
export const MAX_GAIN = 4;
export const MIN_PITCH = 0.25;
export const MAX_PITCH = 4;

export function clampGain(gain: number | undefined): number {
  if (gain === undefined || Number.isNaN(gain)) return 1;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
}

export function clampPitch(pitch: number | undefined): number {
  if (pitch === undefined || Number.isNaN(pitch)) return 1;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
}

export interface VoiceInfo {
  id: number;
  sound: string;
  /** Effective gain at the listener (after distance attenuation). */
  gain: number;
  priority: number;
  start: number;
  end: number;
}

export type VoiceDecision =
  | { play: false; reason: "rate" | "full" | "silent" }
  | { play: true; id: number; steal: number | null };

/**
 * Voice priorities: the player's own actions and interactions outrank
 * physics debris, so a collapsing pile can never cut a footstep or a door.
 * Loops are not voices and are never stolen.
 */
export const PRIORITY = { debris: 1, event: 2, player: 3 } as const;

export interface VoiceLimiter {
  /**
   * Decides whether a one-shot may start at `now` (seconds). Registers it when
   * allowed. A full limiter steals the weakest voice of equal or lower
   * priority (weakest = lowest gain, weighted by how much of it is left);
   * lower priorities are always taken first.
   */
  request(
    sound: string,
    gain: number,
    now: number,
    duration: number,
    priority?: number,
  ): VoiceDecision;
  /** Marks a voice as finished (e.g. from its `ended` event). */
  release(id: number): void;
  readonly active: number;
}

function strength(v: VoiceInfo, now: number): number {
  const remaining = Math.max(0, v.end - now) / Math.max(1e-3, v.end - v.start);
  return v.gain * (0.25 + remaining);
}

export function createVoiceLimiter(
  maxVoices = MAX_ONE_SHOT_VOICES,
  minInterval = MIN_REPEAT_INTERVAL,
): VoiceLimiter {
  const voices: VoiceInfo[] = [];
  const lastStart = new Map<string, number>();
  let nextId = 1;

  return {
    request(sound, gain, now, duration, priority = PRIORITY.event) {
      if (gain <= 0.001) return { play: false, reason: "silent" };
      for (let i = voices.length - 1; i >= 0; i--) {
        if (voices[i]!.end <= now) voices.splice(i, 1);
      }
      const last = lastStart.get(sound);
      if (last !== undefined && now - last < minInterval && now >= last) {
        return { play: false, reason: "rate" };
      }
      let steal: number | null = null;
      if (voices.length >= maxVoices) {
        let worst = -1;
        for (let i = 0; i < voices.length; i++) {
          const v = voices[i]!;
          if (v.priority > priority) continue;
          if (worst < 0) {
            worst = i;
            continue;
          }
          const w = voices[worst]!;
          if (
            v.priority < w.priority ||
            (v.priority === w.priority && strength(v, now) < strength(w, now))
          ) {
            worst = i;
          }
        }
        if (worst < 0) return { play: false, reason: "full" };
        const victim = voices[worst]!;
        if (
          victim.priority === priority &&
          gain * 1.25 < strength(victim, now)
        ) {
          return { play: false, reason: "full" };
        }
        steal = victim.id;
        voices.splice(worst, 1);
      }
      const id = nextId++;
      voices.push({
        id,
        sound,
        gain,
        priority,
        start: now,
        end: now + duration,
      });
      lastStart.set(sound, now);
      return { play: true, id, steal };
    },
    release(id) {
      const i = voices.findIndex((v) => v.id === id);
      if (i >= 0) voices.splice(i, 1);
    },
    get active() {
      return voices.length;
    },
  };
}

// --- Distance ---------------------------------------------------------------

export interface Attenuation {
  /** Full level inside this distance (m). */
  ref: number;
  /** Inverse-distance rolloff factor beyond `ref`. */
  rolloff: number;
  /** Silent at and beyond this distance (m). */
  max: number;
}

/**
 * Distance curves. Period engines faded sounds linearly to silence at a
 * fixed range set by the sound's attenuation class (looping ambience fading
 * fastest); modern engines use inverse distance. This multiplies the two:
 * natural 1/d falloff near the source and a guaranteed fade to nothing at
 * `max`, so a hum 10 m away is faint and one 16 m away is gone.
 */
export const ATTENUATION = {
  /** Impacts, doors, buttons: audible across a large room. */
  world: { ref: 1.5, rolloff: 1, max: 32 },
  /** Hums and machinery loops: local to their room. */
  ambience: { ref: 1, rolloff: 1, max: 16 },
} as const satisfies Record<string, Attenuation>;

export function distanceGain(distance: number, a: Attenuation): number {
  if (!(distance >= 0)) return 1;
  if (distance >= a.max) return 0;
  const beyond = Math.max(0, distance - a.ref);
  const inverse = a.ref / (a.ref + a.rolloff * beyond);
  const fade = 1 - beyond / (a.max - a.ref);
  return inverse * fade;
}

/**
 * Low-pass cutoff for a source at `distance`: full band near, falling
 * log-linearly to 2.5 kHz at `max` (air absorption, and a stand-in for the
 * occlusion of distant sources around corners).
 */
export function distanceCutoff(distance: number, a: Attenuation): number {
  const u = Math.min(1, Math.max(0, (distance - a.ref) / (a.max - a.ref)));
  return 20000 * Math.pow(2500 / 20000, u);
}

/**
 * Reverb send relative to the source level at `distance`: the reverberant
 * field falls off more slowly than the direct sound, so distant sources get
 * wetter, not just quieter.
 */
export function distanceSend(distance: number, a: Attenuation): number {
  return Math.sqrt(distanceGain(distance, a));
}

// --- Occlusion --------------------------------------------------------------

/**
 * What full occlusion (1) does to a sound: the direct sound is low-passed
 * down to `minCutoff` and turned down by `maxAttenuationDb`, while the
 * reverb send drops only `sendDropDb`, so a sound heard through walls or
 * from the next room is dull and mostly reverberant (its wet/dry ratio rises
 * by 9 dB).
 */
export const OCCLUSION = {
  maxCutoff: 20000,
  minCutoff: 800,
  /**
   * Cutoff falls log-linearly in occlusion^curve: below 1 the first bit of
   * occlusion already dulls clearly (0.25 -> 5.4 kHz, 0.5 -> 2.2 kHz).
   */
  curve: 0.75,
  maxAttenuationDb: 14,
  sendDropDb: 5,
  /** Glide time (s) for occlusion changes on loops by default. */
  smoothing: 0.12,
} as const;

export interface OcclusionParams {
  /** Low-pass cutoff of the direct sound, Hz. */
  cutoff: number;
  /** Gain of the direct sound. */
  gain: number;
  /** Factor on the reverb send. */
  send: number;
}

/** Clamps occlusion to 0..1 (NaN and undefined count as 0). */
export function clampOcclusion(o: number | undefined): number {
  if (o === undefined || !(o > 0)) return 0;
  return Math.min(1, o);
}

/**
 * Filter and levels for an occlusion of 0 (clear) to 1 (behind walls).
 * Monotonic: more occlusion is always duller and quieter, never brighter.
 */
export function occlusionParams(
  occlusion: number | undefined,
): OcclusionParams {
  const o = clampOcclusion(occlusion);
  const c = OCCLUSION;
  return {
    cutoff: c.maxCutoff * (c.minCutoff / c.maxCutoff) ** (o ** c.curve),
    gain: 10 ** ((-c.maxAttenuationDb * o) / 20),
    send: 10 ** ((-c.sendDropDb * o) / 20),
  };
}

/**
 * What a ray from the listener towards a source hit first, if anything
 * nearer than `maxDistance`: its distance, or null if nothing blocks it.
 * The game supplies it from `physics.raycast`, counting statics and
 * kinematics (walls, doors) but not dynamic bodies (props do not occlude).
 */
export type OcclusionRaycast = (
  origin: Vec3Like,
  direction: Vec3Like,
  maxDistance: number,
) => number | null;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Occlusion between `listener` and `source`, 0..1: casts four rays from the
 * listener (to the source, to points 0.6 m either side of it horizontally
 * and 0.6 m above it); a ray is blocked if it hits something more than
 * 0.25 m short of its target. The direct ray weighs half, the others a
 * sixth each, minus a small dead zone (see below). One wall in the way
 * gives 1; a sound around a door frame or a corner gives a partial value,
 * so it fades as the listener moves rather than switching. Pure (the
 * raycast is injected).
 */
export function measureOcclusion(
  listener: Vec3Like,
  source: Vec3Like,
  raycast: OcclusionRaycast,
): number {
  const dx = source.x - listener.x;
  const dz = source.z - listener.z;
  const flat = Math.hypot(dx, dz);
  // Horizontal unit vector at right angles to the line of sight.
  const sx = flat > 1e-6 ? -dz / flat : 1;
  const sz = flat > 1e-6 ? dx / flat : 0;
  const targets: Vec3Like[] = [
    source,
    { x: source.x + 0.6 * sx, y: source.y, z: source.z + 0.6 * sz },
    { x: source.x - 0.6 * sx, y: source.y, z: source.z - 0.6 * sz },
    { x: source.x, y: source.y + 0.6, z: source.z },
  ];
  let score = 0;
  targets.forEach((t, i) => {
    const v = { x: t.x - listener.x, y: t.y - listener.y, z: t.z - listener.z };
    const d = Math.hypot(v.x, v.y, v.z);
    if (d < 0.3) return;
    const dir = { x: v.x / d, y: v.y / d, z: v.z / d };
    const hit = raycast(listener, dir, d);
    // The direct ray counts half; the three offset rays share the rest.
    if (hit !== null && hit < d - 0.25) score += i === 0 ? 0.5 : 0.5 / 3;
  });
  // A dead zone, so one grazing offset ray (a crate against a wall in full
  // view) does not dull anything: one offset ray alone -> 0, the direct ray
  // alone (a pillar) -> 0.38, direct plus one offset -> 0.58, all -> 1.
  const o = Math.round(((score - 0.2) / 0.8) * 1e6) / 1e6;
  return Math.min(1, Math.max(0, o));
}

// --- Room -------------------------------------------------------------------

export interface RoomResponse {
  /** Decay time to -60 dB at low, mid and high frequencies (s). */
  rt60Low: number;
  rt60Mid: number;
  rt60High: number;
  /** Delay before the first reflection (s). */
  preDelay: number;
  /** Total length (s). */
  seconds: number;
}

/**
 * Hard concrete-and-tile rooms and corridors: about 0.85 s mid decay with
 * the highs dying in half that (period hallway/stone presets use a
 * high-frequency decay ratio of 0.6-0.8, dropping more for absorbent
 * surfaces), a 9 ms pre-delay.
 */
export const ROOM: RoomResponse = {
  rt60Low: 1.0,
  rt60Mid: 0.85,
  rt60High: 0.42,
  preDelay: 0.009,
  seconds: 1.1,
};

/**
 * Procedural impulse response: a handful of discrete early reflections
 * (8-45 ms after the pre-delay, alternating polarity, dulled), then a dense
 * diffuse tail made of noise split into three bands, each decaying at its own
 * rate. Dense noise has no periodic structure, so no metallic ringing. Two
 * decorrelated channels, each scaled to unit energy.
 */
export function makeImpulseResponse(
  sampleRate: number,
  room: RoomResponse = ROOM,
  seed = 7,
): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.round(sampleRate * room.seconds));
  const pre = Math.round(sampleRate * room.preDelay);
  const rng = createRng(seed);
  const channels: Float32Array[] = [];
  const k = (rt: number) => 6.91 / rt;
  const tapShape = [0.5, 0.3, 0.15, 0.05];
  for (let c = 0; c < 2; c++) {
    const out = new Float32Array(n);
    for (let r = 0; r < 9; r++) {
      const t = 0.008 * (1 + r * 0.45) + rng.next() * 0.004;
      const i = pre + Math.round(t * sampleRate);
      const amp =
        (r % 2 === 0 ? 1 : -1) *
        0.55 *
        Math.exp(-k(room.rt60Mid) * t) *
        (0.6 + 0.4 * rng.next());
      for (let j = 0; j < tapShape.length && i + j < n; j++) {
        out[i + j] = out[i + j]! + amp * tapShape[j]!;
      }
    }
    let lp1 = 0;
    let lp2 = 0;
    const a1 = 1 - Math.exp((-2 * Math.PI * 500) / sampleRate);
    const a2 = 1 - Math.exp((-2 * Math.PI * 3500) / sampleRate);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      const x = rng.next() * 2 - 1;
      lp1 += a1 * (x - lp1);
      lp2 += a2 * (x - lp2);
      const tail =
        lp1 * Math.exp(-k(room.rt60Low) * t) +
        (lp2 - lp1) * Math.exp(-k(room.rt60Mid) * t) +
        0.7 * (x - lp2) * Math.exp(-k(room.rt60High) * t);
      // The diffuse field builds up over the first ~25 ms.
      out[i] = out[i]! + tail * 0.35 * Math.min(1, t / 0.025);
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
