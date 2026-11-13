import { describe, expect, test } from "bun:test";
import type { PhysicsWorld } from "../core/api";
import { PLAYER, PROP_SPECS } from "../core/props";
import type { Vec3 } from "../math";
import { createPhysicsWorld } from "./index";

const DT = 1 / 60;
const HALF = {
  x: PLAYER.halfWidth,
  y: PLAYER.standHeight / 2,
  z: PLAYER.halfWidth,
};

function floorWorld(): PhysicsWorld {
  const w = createPhysicsWorld();
  w.addStatic({ min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 0, z: 20 } });
  return w;
}

describe("groundVelocity", () => {
  test("is zero on static ground and in the air", () => {
    const w = floorWorld();
    const r = w.moveCharacter(
      { x: 0, y: HALF.y, z: 0 },
      HALF,
      { x: 2, y: 0, z: 0 },
      DT,
    );
    expect(r.onGround).toBe(true);
    expect(r.groundVelocity).toEqual({ x: 0, y: 0, z: 0 });
    const air = w.moveCharacter(
      { x: 0, y: 5, z: 0 },
      HALF,
      { x: 2, y: 0, z: 0 },
      DT,
    );
    expect(air.groundVelocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("is a kinematic platform's velocity from its motion", () => {
    const w = floorWorld();
    const plat = w.addKinematic({
      min: { x: -1, y: 0, z: -1 },
      max: { x: 1, y: 0.2, z: 1 },
    });
    let pos: Vec3 = { x: 0, y: 0.2 + HALF.y, z: 0 };
    let x = -1;
    let y = 0;
    for (let f = 0; f < 30; f++) {
      x += 1.5 * DT;
      y += 0.5 * DT;
      w.moveKinematic(plat, { x, y, z: -1 });
      const r = w.moveCharacter(pos, HALF, { x: 0, y: 0, z: 0 }, DT);
      pos = r.position;
      w.step(DT);
      expect(r.onGround).toBe(true);
      expect(r.standingOn).toEqual({ kind: "kinematic", id: plat });
      expect(r.groundVelocity.x).toBeCloseTo(1.5, 6);
      expect(r.groundVelocity.y).toBeCloseTo(0.5, 6);
      expect(r.groundVelocity.z).toBeCloseTo(0, 6);
    }
  });

  test("is a body's velocity at the contact point, rotation included", () => {
    const w = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const spec = PROP_SPECS.crate_metal;
    const crate = w.addBody({
      position: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 1, y: spec.halfExtents.y, z: 1 },
      mass: spec.mass,
      linearVelocity: { x: 1, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 2, z: 0 },
    });
    // Feet on the top face, 0.5 m off the spin axis along +x.
    const r = w.moveCharacter(
      { x: 0.5, y: spec.halfExtents.y + HALF.y + 0.001, z: 0 },
      HALF,
      { x: 0, y: -0.01, z: 0 },
      DT,
    );
    expect(r.standingOn).toEqual({ kind: "body", id: crate });
    // v + w x r = (1,0,0) + (0,2,0) x (0.5, 0.35, 0) = (1, 0, -1).
    expect(r.groundVelocity.x).toBeCloseTo(1, 6);
    expect(r.groundVelocity.y).toBeCloseTo(0, 6);
    expect(r.groundVelocity.z).toBeCloseTo(-1, 6);
  });
});
