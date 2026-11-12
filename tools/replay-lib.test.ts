import { describe, expect, test } from "bun:test";
import { IDLE_INPUT } from "../src/game";
import {
  ReplayRecorder,
  decodeReplay,
  replaySteps,
} from "../src/harness/replay";
import { planCaptures, sliceReplay, validateReplay } from "./replay-lib";

function sample() {
  const recorder = new ReplayRecorder();
  for (let i = 0; i < 100; i++) {
    recorder.push({
      ...IDLE_INPUT,
      moveZ: i < 50 ? 1 : 0,
      lookDx: i === 70 ? 5 : 0,
    });
  }
  return recorder.toReplay(1998);
}

describe("sliceReplay", () => {
  test("keeps exactly the requested steps", () => {
    const replay = sample();
    const part = sliceReplay(replay, 40, 80);
    expect(replaySteps(part)).toBe(40);
    const inputs = decodeReplay(part);
    expect(inputs[0].moveZ).toBe(1); // step 40
    expect(inputs[10].moveZ).toBe(0); // step 50
    expect(inputs[30].lookDx).toBe(5); // step 70
    expect(part.seed).toBe(1998);
  });

  test("slices concatenate to the whole", () => {
    const replay = sample();
    const joined = [
      ...decodeReplay(sliceReplay(replay, 0, 33)),
      ...decodeReplay(sliceReplay(replay, 33, 100)),
    ];
    expect(joined).toEqual(decodeReplay(replay));
  });

  test("out of range slices are empty or clipped", () => {
    const replay = sample();
    expect(replaySteps(sliceReplay(replay, 100, 200))).toBe(0);
    expect(replaySteps(sliceReplay(replay, 90, 200))).toBe(10);
  });
});

describe("validateReplay", () => {
  test("accepts replays and rejects junk", () => {
    expect(validateReplay(sample()).version).toBe(1);
    expect(() => validateReplay({})).toThrow();
    expect(() =>
      validateReplay({ version: 1, seed: 1, runs: [[1, 2]] }),
    ).toThrow();
    expect(() => validateReplay(null)).toThrow();
  });
});

describe("planCaptures", () => {
  test("every N, including the last step", () => {
    const plan = planCaptures({ total: 100, every: 30 });
    expect(plan.frames).toEqual([30, 60, 90, 100]);
    expect(plan.samples).toEqual([30, 60, 90, 100]);
  });

  test("from and to bound the frames", () => {
    const plan = planCaptures({ total: 100, every: 10, from: 25, to: 55 });
    expect(plan.frames).toEqual([30, 40, 50, 55]);
  });

  test("at/window captures every step around the target", () => {
    const plan = planCaptures({ total: 100, every: 30, at: 50, window: 3 });
    expect(plan.frames).toEqual([47, 48, 49, 50, 51, 52, 53]);
    expect(plan.samples).toContain(30);
    expect(plan.samples).toContain(53);
  });

  test("at near the edges is clipped to the replay", () => {
    const plan = planCaptures({ total: 20, every: 30, at: 2, window: 5 });
    expect(plan.frames[0]).toBe(1);
    expect(plan.frames[plan.frames.length - 1]).toBe(7);
    const end = planCaptures({ total: 20, every: 30, at: 19, window: 5 });
    expect(end.frames[end.frames.length - 1]).toBe(20);
  });
});
