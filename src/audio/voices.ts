/** Pure helpers for the Web Audio wrapper: clamping, voice limiting, impulse response. */
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
  gain: number;
  start: number;
  end: number;
}

export type VoiceDecision =
  | { play: false; reason: "rate" | "full" | "silent" }
  | { play: true; id: number; steal: number | null };

export interface VoiceLimiter {
  /** Decides whether a one-shot may start at `now` (seconds). Registers it when allowed. */
  request(
    sound: string,
    gain: number,
    now: number,
    duration: number,
  ): VoiceDecision;
  /** Marks a voice as finished (e.g. from its `ended` event). */
  release(id: number): void;
  readonly active: number;
}

export function createVoiceLimiter(
  maxVoices = MAX_ONE_SHOT_VOICES,
  minInterval = MIN_REPEAT_INTERVAL,
): VoiceLimiter {
  const voices: VoiceInfo[] = [];
  const lastStart = new Map<string, number>();
  let nextId = 1;

  return {
    request(sound, gain, now, duration) {
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
        // Steal the quietest voice (remaining-time weighted), oldest on ties.
        let worst = -1;
        let worstScore = Infinity;
        for (let i = 0; i < voices.length; i++) {
          const v = voices[i]!;
          const remaining =
            Math.max(0, v.end - now) / Math.max(1e-3, v.end - v.start);
          const score = v.gain * (0.25 + remaining);
          if (score < worstScore) {
            worstScore = score;
            worst = i;
          }
        }
        const victim = voices[worst]!;
        if (gain * 1.25 < worstScore) return { play: false, reason: "full" };
        steal = victim.id;
        voices.splice(worst, 1);
      }
      const id = nextId++;
      voices.push({ id, sound, gain, start: now, end: now + duration });
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

/**
 * Procedural "concrete room" impulse response: a short pre-delay, then noise
 * with an exponential decay (about -60 dB at `seconds`) that gets darker over
 * time. Two decorrelated channels, scaled to roughly unit energy.
 */
export function makeImpulseResponse(
  sampleRate: number,
  seconds = 0.8,
  seed = 7,
): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const preDelay = Math.round(sampleRate * 0.006);
  const rng = createRng(seed);
  const channels: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const out = new Float32Array(n);
    let lp = 0;
    let energy = 0;
    for (let i = preDelay; i < n; i++) {
      const t = (i - preDelay) / sampleRate;
      const decay = Math.exp((-6.9 * t) / seconds);
      // One-pole lowpass whose cutoff falls from ~6 kHz to ~1.2 kHz.
      const cutoff = 6000 * Math.exp((-1.6 * t) / seconds);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      lp += a * (rng.next() * 2 - 1 - lp);
      const fadeIn = Math.min(1, (i - preDelay) / (sampleRate * 0.002));
      out[i] = lp * decay * fadeIn;
      energy += out[i]! * out[i]!;
    }
    const k = energy > 0 ? 1 / Math.sqrt(energy) : 1;
    for (let i = 0; i < n; i++) out[i] = out[i]! * k;
    channels.push(out);
  }
  return [channels[0]!, channels[1]!];
}
