import { expect, test } from "bun:test";
import { createStepper } from "./loop";

test("accumulates partial frames into whole steps", () => {
  const step = createStepper(0.01);
  expect(step(0.004).steps).toBe(0);
  expect(step(0.004).steps).toBe(0);
  const third = step(0.004);
  expect(third.steps).toBe(1);
  expect(third.alpha).toBeCloseTo(0.2);
});

test("runs several steps for a slow frame", () => {
  const step = createStepper(0.01);
  expect(step(0.035).steps).toBe(3);
});

test("clamps a stalled frame and drops the backlog", () => {
  const step = createStepper(0.01, 5);
  const stalled = step(2);
  expect(stalled.steps).toBe(5);
  expect(stalled.alpha).toBe(0);
  expect(step(0.01).steps).toBe(1);
});
