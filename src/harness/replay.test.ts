import { expect, test } from "bun:test";
import type { PlayerInput } from "../core/api";
import { decodeReplay, ReplayRecorder, replaySteps } from "./replay";

const idle: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  lookDx: 0,
  lookDy: 0,
  jump: false,
  crouch: false,
  usePressed: false,
  primaryPressed: false,
};

test("round-trips a sequence of inputs exactly", () => {
  const sequence: PlayerInput[] = [
    idle,
    idle,
    { ...idle, moveZ: 1 },
    { ...idle, moveZ: 1 },
    { ...idle, moveZ: 1, lookDx: 12.5, lookDy: -3 },
    { ...idle, moveZ: 1, jump: true },
    { ...idle, usePressed: true, crouch: true },
    { ...idle, primaryPressed: true },
    idle,
  ];
  const recorder = new ReplayRecorder();
  for (const input of sequence) {
    recorder.push(input);
  }
  const replay = recorder.toReplay(7);
  expect(replay.seed).toBe(7);
  expect(replaySteps(replay)).toBe(sequence.length);
  expect(decodeReplay(replay)).toEqual(sequence);
});

test("run-length encodes held input", () => {
  const recorder = new ReplayRecorder();
  for (let i = 0; i < 600; i++) {
    recorder.push({ ...idle, moveZ: 1 });
  }
  expect(recorder.steps).toBe(600);
  expect(recorder.toReplay(1).runs).toEqual([[600, 0, 1, 0, 0, 0]]);
});

test("survives a JSON round trip", () => {
  const recorder = new ReplayRecorder();
  recorder.push({ ...idle, lookDx: 0.1 + 0.2, moveX: -1 });
  const copy = JSON.parse(JSON.stringify(recorder.toReplay(3)));
  expect(decodeReplay(copy)).toEqual([
    { ...idle, lookDx: 0.1 + 0.2, moveX: -1 },
  ]);
});
