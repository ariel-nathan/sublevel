import { describe, expect, test } from "bun:test";
import { plateStack, type BodyLite } from "./doors";

const plate = {
  min: { x: 7.9, y: 0, z: 11.4 },
  max: { x: 9.1, y: 0.04, z: 12.6 },
};
const body = (
  id: number,
  mass: number,
  half: number,
  tag = "crate_wood",
): BodyLite => ({
  id,
  tag,
  mass,
  halfExtents: { x: half, y: half, z: half },
  position: { x: 0, y: half, z: 0 },
});

describe("plateStack", () => {
  test("uses the lightest single body that is heavy enough, resting on the floor", () => {
    const poses = plateStack(plate, 45, [
      body(1, 25, 0.4),
      body(2, 60, 0.35, "crate_metal"),
      body(3, 80, 0.5),
    ])!;
    expect(poses).toHaveLength(1);
    expect(poses[0].id).toBe(2);
    expect(poses[0].position.x).toBeCloseTo(8.5);
    expect(poses[0].position.z).toBeCloseTo(12);
    expect(poses[0].position.y).toBeCloseTo(0.005 + 0.35);
  });

  test("stacks the heaviest bodies when none is enough alone", () => {
    const poses = plateStack(plate, 45, [
      body(1, 25, 0.4),
      body(2, 25, 0.4),
      body(3, 8, 0.25),
    ])!;
    expect(poses.map((p) => p.id)).toEqual([1, 2]);
    // The second rests on the first, with a small gap.
    expect(poses[1].position.y - poses[0].position.y).toBeCloseTo(0.8 + 0.005);
  });

  test("skips bodies already used, and gives up when all together are too light", () => {
    expect(
      plateStack(plate, 45, [body(1, 25, 0.4), body(2, 25, 0.4)], new Set([2])),
    ).toBeNull();
    expect(plateStack(plate, 500, [body(1, 25, 0.4)])).toBeNull();
  });
});
