import { describe, expect, test } from "bun:test";
import { PROP_SPECS } from "../src/core/props";
import { createPhysicsWorld } from "../src/physics";
import { throwSpeed } from "../src/player/tuning";
import {
  holdPoint,
  planThrow,
  viewBasis,
  type Look,
  type Point3,
} from "./pilot-math";

/**
 * Throws a prop of this kind as the player does (velocity along the view
 * plus 1 m/s up) in the real physics, and returns where it is when it has
 * flown as far as `target` horizontally.
 */
function fly(
  kind: keyof typeof PROP_SPECS,
  release: Point3,
  look: Look,
  target: Point3,
): Point3 {
  const spec = PROP_SPECS[kind];
  const w = createPhysicsWorld();
  const speed = throwSpeed(spec.mass);
  const { forward } = viewBasis(look);
  const id = w.addBody({
    position: release,
    halfExtents: spec.halfExtents,
    mass: spec.mass,
    linearVelocity: {
      x: forward.x * speed,
      y: forward.y * speed + 1,
      z: forward.z * speed,
    },
  });
  const dist = (p: Point3): number =>
    Math.hypot(p.x - release.x, p.z - release.z);
  const goal = dist(target);
  let prev = w.getBody(id)!.position;
  for (let i = 0; i < 400; i++) {
    w.step(1 / 60);
    const p = w.getBody(id)!.position;
    if (dist(p) >= goal) {
      const k = (goal - dist(prev)) / (dist(p) - dist(prev));
      return {
        x: prev.x + (p.x - prev.x) * k,
        y: prev.y + (p.y - prev.y) * k,
        z: prev.z + (p.z - prev.z) * k,
      };
    }
    prev = p;
  }
  throw new Error("never arrived");
}

describe("planThrow against the real physics", () => {
  const eye = { x: 28, y: 1.65, z: 9.8 };
  const cases: [keyof typeof PROP_SPECS, Point3][] = [
    ["crate_wood_small", { x: 31, y: 4.2, z: 9.8 }],
    ["crate_wood_small", { x: 33, y: 1.0, z: 8 }],
    ["crate_wood", { x: 24, y: 2.5, z: 12 }],
    ["barrel", { x: 24, y: 0.6, z: 9.8 }],
    ["chair", { x: 28, y: 3, z: 14 }],
  ];
  for (const [kind, target] of cases) {
    test(`${kind} thrown at (${target.x}, ${target.y}, ${target.z}) arrives within 3 cm`, () => {
      const h = PROP_SPECS[kind].halfExtents;
      const d = Math.max(1.15, Math.hypot(h.x, h.y, h.z) + 0.55);
      const plan = planThrow(eye, target, throwSpeed(PROP_SPECS[kind].mass), d);
      expect(plan).not.toBeNull();
      // The release point is where the hold puts the prop for that look.
      const held = holdPoint(eye, plan!.look, d);
      expect(held.y).toBeCloseTo(plan!.release.y, 9);
      const at = fly(kind, plan!.release, plan!.look, target);
      expect(Math.abs(at.y - target.y)).toBeLessThan(0.03);
      expect(Math.hypot(at.x - target.x, at.z - target.z)).toBeLessThan(0.03);
    });
  }

  test("out of range is null", () => {
    expect(
      planThrow(eye, { x: 80, y: 20, z: 9.8 }, throwSpeed(25), 1.15),
    ).toBeNull();
  });

  test("aiming higher with lift raises the arrival height", () => {
    const target = { x: 31, y: 4.2, z: 9.8 };
    const plan = planThrow(eye, target, throwSpeed(8), 1.15, 0.2)!;
    const at = fly("crate_wood_small", plan.release, plan.look, target);
    expect(at.y).toBeGreaterThan(4.35);
    expect(at.y).toBeLessThan(4.45);
  });
});
