import { describe, expect, test } from "bun:test";
import { LOOPING_SOUNDS, SOUND_IDS, type SoundId } from "../core/api";
import { renderSound } from "./index";
import {
  createVoiceLimiter,
  clampGain,
  clampPitch,
  makeImpulseResponse,
} from "./voices";

const RATES = [44100, 48000];
const LOOPS = new Set<SoundId>(LOOPING_SOUNDS);

/** Expected duration range in seconds. */
const DURATION: Record<SoundId, [number, number]> = {
  footstep_concrete: [0.12, 0.2],
  footstep_tile: [0.12, 0.2],
  footstep_metal: [0.12, 0.25],
  land: [0.2, 0.3],
  jump: [0.1, 0.15],
  impact_wood: [0.2, 0.3],
  impact_metal: [0.3, 0.5],
  impact_plastic: [0.12, 0.2],
  crate_break: [0.5, 0.7],
  pickup: [0.08, 0.12],
  throw: [0.15, 0.25],
  button_press: [0.12, 0.18],
  button_deny: [0.2, 0.3],
  door_open: [0.8, 1.0],
  door_close: [0.8, 1.0],
  plate_down: [0.15, 0.25],
  plate_up: [0.15, 0.25],
  hum_fluorescent: [2, 4],
  hum_machine: [2, 4],
  ambient_drone: [2, 4],
};

function stats(buf: Float32Array) {
  let peak = 0;
  let sum = 0;
  let sq = 0;
  for (const v of buf) {
    peak = Math.max(peak, Math.abs(v));
    sum += v;
    sq += v * v;
  }
  return { peak, mean: sum / buf.length, rms: Math.sqrt(sq / buf.length) };
}

/** Energy of the first difference relative to total energy: a cheap brightness measure. */
function brightness(buf: Float32Array): number {
  let d = 0;
  let e = 0;
  for (let i = 1; i < buf.length; i++) {
    const x = buf[i]! - buf[i - 1]!;
    d += x * x;
    e += buf[i]! * buf[i]!;
  }
  return d / e;
}

function goertzel(buf: Float32Array, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i]! + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / buf.length;
}

describe("renderSound", () => {
  for (const sr of RATES) {
    for (const id of SOUND_IDS) {
      test(`${id} @ ${sr} is well formed`, () => {
        const buf = renderSound(id, sr);
        expect(buf.length).toBeGreaterThan(0);
        for (const v of buf) expect(Number.isFinite(v)).toBe(true);
        const { peak, mean, rms } = stats(buf);
        expect(peak).toBeLessThanOrEqual(1);
        expect(peak).toBeGreaterThan(0.15);
        expect(rms).toBeGreaterThan(0.01);
        expect(Math.abs(mean)).toBeLessThan(0.01 * Math.max(peak, 0.1));
        const seconds = buf.length / sr;
        expect(seconds).toBeGreaterThanOrEqual(DURATION[id][0]);
        expect(seconds).toBeLessThanOrEqual(DURATION[id][1]);
        if (!LOOPS.has(id)) {
          for (let i = 0; i < 3; i++) {
            expect(Math.abs(buf[i]!)).toBeLessThan(0.02);
            expect(Math.abs(buf[buf.length - 1 - i]!)).toBeLessThan(0.02);
          }
        }
        // Deterministic.
        expect(renderSound(id, sr)).toEqual(buf);
      });
    }
  }

  for (const sr of RATES) {
    for (const id of LOOPING_SOUNDS) {
      test(`${id} @ ${sr} loops seamlessly`, () => {
        const buf = renderSound(id, sr);
        const n = buf.length;
        let maxStep = 0;
        let maxSlopeChange = 0;
        for (let i = 1; i < n; i++)
          maxStep = Math.max(maxStep, Math.abs(buf[i]! - buf[i - 1]!));
        for (let i = 2; i < n; i++) {
          const a = buf[i]! - buf[i - 1]!;
          const b = buf[i - 1]! - buf[i - 2]!;
          maxSlopeChange = Math.max(maxSlopeChange, Math.abs(a - b));
        }
        const wrapStep = Math.abs(buf[0]! - buf[n - 1]!);
        expect(wrapStep).toBeLessThanOrEqual(maxStep);
        const wrapSlope = Math.abs(buf[1]! - buf[0]! - (buf[0]! - buf[n - 1]!));
        const wrapSlope2 = Math.abs(
          buf[0]! - buf[n - 1]! - (buf[n - 1]! - buf[n - 2]!),
        );
        expect(wrapSlope).toBeLessThanOrEqual(maxSlopeChange);
        expect(wrapSlope2).toBeLessThanOrEqual(maxSlopeChange);
      });
    }
  }

  test("spectral sanity", () => {
    const metal = brightness(renderSound("impact_metal", 44100));
    const concrete = brightness(renderSound("footstep_concrete", 44100));
    expect(metal).toBeGreaterThan(concrete * 3);
    expect(brightness(renderSound("footstep_tile", 44100))).toBeGreaterThan(
      concrete,
    );
  });

  test("fluorescent hum is strongest near mains frequency", () => {
    const sr = 44100;
    const buf = renderSound("hum_fluorescent", sr);
    const candidates = [30, 50, 60, 80, 100, 120, 180, 240, 300, 360, 480, 600];
    let best = 0;
    let bestMag = -1;
    for (const f of candidates) {
      const m = goertzel(buf, f, sr);
      if (m > bestMag) {
        bestMag = m;
        best = f;
      }
    }
    expect([100, 120]).toContain(best);
  });

  test("plate_down is lower pitched than plate_up", () => {
    expect(brightness(renderSound("plate_down", 44100))).toBeLessThan(
      brightness(renderSound("plate_up", 44100)),
    );
  });

  test("renders everything quickly", () => {
    const t0 = performance.now();
    for (const id of SOUND_IDS) renderSound(id, 48000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("clamping", () => {
  test("gain and pitch", () => {
    expect(clampGain(undefined)).toBe(1);
    expect(clampGain(-3)).toBe(0);
    expect(clampGain(100)).toBe(4);
    expect(clampGain(Number.NaN)).toBe(1);
    expect(clampPitch(undefined)).toBe(1);
    expect(clampPitch(0)).toBe(0.25);
    expect(clampPitch(50)).toBe(4);
    expect(clampPitch(1.1)).toBe(1.1);
  });
});

describe("voice limiter", () => {
  test("rate-limits identical sounds only", () => {
    const l = createVoiceLimiter(24, 0.03);
    expect(l.request("a", 1, 0, 0.5).play).toBe(true);
    expect(l.request("a", 1, 0.01, 0.5).play).toBe(false);
    expect(l.request("b", 1, 0.01, 0.5).play).toBe(true);
    expect(l.request("a", 1, 0.04, 0.5).play).toBe(true);
  });

  test("drops silent requests", () => {
    const l = createVoiceLimiter();
    expect(l.request("a", 0, 0, 1).play).toBe(false);
  });

  test("caps polyphony, stealing the quietest for a louder sound", () => {
    const l = createVoiceLimiter(4, 0);
    const ids: number[] = [];
    const gains = [1, 0.2, 0.8, 0.9];
    gains.forEach((g, i) => {
      const d = l.request(`s${i}`, g, 0, 1);
      expect(d.play).toBe(true);
      if (d.play) ids.push(d.id);
    });
    expect(l.active).toBe(4);
    const quiet = l.request("x", 0.05, 0.1, 1);
    expect(quiet).toEqual({ play: false, reason: "full" });
    const loud = l.request("y", 1, 0.1, 1);
    expect(loud.play).toBe(true);
    if (loud.play) expect(loud.steal).toBe(ids[1]!);
    expect(l.active).toBe(4);
  });

  test("expired and released voices free slots", () => {
    const l = createVoiceLimiter(2, 0);
    const a = l.request("a", 1, 0, 0.1);
    l.request("b", 1, 0, 5);
    expect(l.request("c", 0.1, 0.05, 1).play).toBe(false);
    expect(l.request("c", 0.1, 0.2, 1).play).toBe(true);
    if (a.play) l.release(a.id);
    expect(l.active).toBe(2);
  });
});

describe("impulse response", () => {
  test("shape", () => {
    const sr = 44100;
    const [left, right] = makeImpulseResponse(sr, 0.8);
    expect(left.length).toBe(Math.round(sr * 0.8));
    expect(left).not.toEqual(right);
    const energy = (b: Float32Array, from: number, to: number) => {
      let e = 0;
      for (let i = from; i < to; i++) e += b[i]! * b[i]!;
      return e;
    };
    for (const ch of [left, right]) {
      for (const v of ch) expect(Number.isFinite(v)).toBe(true);
      expect(ch[0]).toBe(0);
      const q = ch.length >> 2;
      expect(energy(ch, 0, q)).toBeGreaterThan(energy(ch, q, 2 * q));
      expect(energy(ch, q, 2 * q)).toBeGreaterThan(energy(ch, 3 * q, 4 * q));
      expect(energy(ch, 0, ch.length)).toBeCloseTo(1, 3);
    }
    expect(makeImpulseResponse(sr, 0.8)[0]).toEqual(left);
  });
});
