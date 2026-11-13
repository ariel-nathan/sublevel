import { describe, expect, test } from "bun:test";
import type { PhysicsWorld } from "../core/api";
import type { Vec3 } from "../math";
import { PLAYER, PROP_SPECS } from "../core/props";
import { createPhysicsWorld } from "./index";

const DT = 1 / 60;
const CRATE = PROP_SPECS.crate_wood;
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

function speedOf(w: PhysicsWorld, id: number): number {
  const v = w.getBody(id)!.linearVelocity;
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * A door slab 0.1 m thick along x, 2 m wide in z, closing towards +x at
 * 1.6 m/s like the game's doors: the caller moves it once per step after
 * physics.step, and stops advancing while blocked.
 */
class Door {
  x: number;
  readonly id: number;
  blockedSteps: boolean[] = [];
  constructor(
    readonly w: PhysicsWorld,
    x: number,
    readonly speed = 1.6,
  ) {
    this.x = x;
    this.id = w.addKinematic({
      min: { x, y: 0, z: -1 },
      max: { x: x + 0.1, y: 2.5, z: 1 },
    });
  }
  /** Asks to move towards `goal`; returns whether the move was blocked. */
  step(goal: number): boolean {
    const d = goal - this.x;
    const move = Math.sign(d) * Math.min(Math.abs(d), this.speed * DT);
    const r = this.w.moveKinematic(this.id, { x: this.x + move, y: 0, z: -1 });
    this.blockedSteps.push(r.blocked);
    // Where the box actually is now (read back through a raycast).
    const hit = this.w.raycast(
      { x: this.x - 5, y: 2.4, z: 0 },
      { x: 1, y: 0, z: 0 },
      20,
    );
    if (
      hit &&
      hit.collider.kind === "kinematic" &&
      hit.collider.id === this.id
    ) {
      this.x = hit.point.x;
    }
    return r.blocked;
  }
}

describe("blocked kinematic moves", () => {
  test("a door pushing a free crate along the floor is never blocked", () => {
    const w = floorWorld();
    const crate = w.addBody({
      position: { x: 1, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const door = new Door(w, -0.5);
    for (let f = 0; f < 240; f++) {
      expect(door.step(5)).toBe(false);
      w.step(DT);
    }
    expect(w.getBody(crate)!.position.x).toBeGreaterThan(5.48);
    expect(door.x).toBeCloseTo(5, 6);
  });

  test("a crate pinned between a closing door and the frame blocks it: no overlap, no launch, steady", () => {
    const w = floorWorld();
    // Door frame (jamb) the door closes against.
    w.addStatic({
      min: { x: 2, y: 0, z: -1.5 },
      max: { x: 2.3, y: 3, z: 1.5 },
    });
    const crate = w.addBody({
      position: { x: 1.2, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const door = new Door(w, -0.6);
    let firstBlocked = -1;
    let maxSpeed = 0;
    for (let f = 0; f < 240; f++) {
      const blocked = door.step(1.9);
      w.step(DT);
      if (blocked && firstBlocked < 0) {
        firstBlocked = f;
      }
      maxSpeed = Math.max(maxSpeed, speedOf(w, crate));
      const b = w.getBody(crate)!;
      // Never overlapped by the door or pushed into the jamb by over 1 cm.
      expect(door.x + 0.1 - (b.position.x - 0.4)).toBeLessThan(0.01);
      expect(b.position.x + 0.4 - 2).toBeLessThan(0.01);
    }
    expect(firstBlocked).toBeGreaterThan(0);
    // Steady: blocked on every step from the first one on.
    expect(door.blockedSteps.slice(firstBlocked).every((b) => b)).toBe(true);
    // Stopped against the crate, which sits against the jamb.
    expect(door.x + 0.1).toBeGreaterThan(1.2 - 0.01);
    expect(door.x + 0.1).toBeLessThan(1.21);
    expect(maxSpeed).toBeLessThan(2);
    expect(Math.abs(w.getBody(crate)!.position.x - 1.6)).toBeLessThan(0.01);
  });

  test("a stack of two crates pinned against a wall blocks the door", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 2, y: 0, z: -3 }, max: { x: 2.3, y: 3, z: 3 } });
    const low = w.addBody({
      position: { x: 1.6, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const high = w.addBody({
      position: { x: 1.6, y: 1.2, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    for (let f = 0; f < 60; f++) {
      w.step(DT);
    }
    const door = new Door(w, 0.5);
    let blocked = 0;
    for (let f = 0; f < 120; f++) {
      if (door.step(1.9)) {
        blocked++;
      }
      w.step(DT);
      for (const id of [low, high]) {
        const b = w.getBody(id)!;
        expect(door.x + 0.1 - (b.position.x - 0.4)).toBeLessThan(0.01);
        expect(speedOf(w, id)).toBeLessThan(1);
      }
    }
    expect(blocked).toBeGreaterThan(90);
    expect(door.x + 0.1).toBeLessThan(1.21);
  });

  test("a chain of two crates side by side against a wall blocks; with room, it does not", () => {
    for (const wallX of [2.4, 5]) {
      const w = floorWorld();
      w.addStatic({
        min: { x: wallX, y: 0, z: -3 },
        max: { x: wallX + 0.3, y: 3, z: 3 },
      });
      for (const x of [1.2, 2.0]) {
        w.addBody({
          position: { x, y: 0.4, z: 0 },
          halfExtents: CRATE.halfExtents,
          mass: CRATE.mass,
        });
      }
      for (let f = 0; f < 30; f++) {
        w.step(DT);
      }
      const door = new Door(w, 0.6);
      let blocked = false;
      for (let f = 0; f < 30; f++) {
        blocked ||= door.step(1.4);
        w.step(DT);
      }
      expect(blocked).toBe(wallX < 3);
    }
  });

  test("a door moving away from what it touches is never blocked", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 2, y: 0, z: -3 }, max: { x: 2.3, y: 3, z: 3 } });
    w.addBody({
      position: { x: 1.6, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const door = new Door(w, 1.1);
    for (let f = 0; f < 60; f++) {
      expect(door.step(-2)).toBe(false);
      w.step(DT);
    }
    expect(door.x).toBeCloseTo(-0.5, 6);
  });

  test("a crate between the closing door and the character blocks it", () => {
    const w = floorWorld();
    const crate = w.addBody({
      position: { x: 1.2, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const door = new Door(w, -0.4);
    let pos: Vec3 = { x: 1.9, y: HALF.y, z: 0 };
    let blocked = 0;
    for (let f = 0; f < 120; f++) {
      if (door.step(3)) {
        blocked++;
      }
      pos = w.moveCharacter(pos, HALF, { x: 0, y: -1, z: 0 }, DT).position;
      w.step(DT);
      expect(speedOf(w, crate)).toBeLessThan(2);
      const b = w.getBody(crate)!;
      expect(door.x + 0.1 - (b.position.x - 0.4)).toBeLessThan(0.01);
    }
    expect(blocked).toBeGreaterThan(60);
    expect(pos.x - HALF.x).toBeGreaterThan(1.6 - 0.01);
  });

  test("a character standing in the doorway blocks the door and is not pushed into the jamb", () => {
    const w = floorWorld();
    w.addStatic({
      min: { x: 2, y: 0, z: -1.5 },
      max: { x: 2.3, y: 3, z: 1.5 },
    });
    const door = new Door(w, -0.5);
    let pos: Vec3 = { x: 1, y: HALF.y, z: 0 };
    let firstBlocked = -1;
    for (let f = 0; f < 180; f++) {
      if (door.step(1.9) && firstBlocked < 0) {
        firstBlocked = f;
      }
      pos = w.moveCharacter(pos, HALF, { x: 0, y: -1, z: 0 }, DT).position;
      w.step(DT);
      expect(pos.x + HALF.x).toBeLessThanOrEqual(2 + 1e-6);
      expect(door.x + 0.1).toBeLessThanOrEqual(pos.x - HALF.x + 0.01);
    }
    expect(firstBlocked).toBeGreaterThan(0);
    expect(door.blockedSteps.slice(firstBlocked).every((b) => b)).toBe(true);
    expect(pos.x + HALF.x).toBeGreaterThan(2 - 0.01);
  });

  test("a lift raising a crate is blocked only by a ceiling right above it", () => {
    for (const ceiling of [4, 1.3]) {
      const w = floorWorld();
      w.addStatic({
        min: { x: -3, y: ceiling, z: -3 },
        max: { x: 3, y: ceiling + 0.3, z: 3 },
      });
      const lift = w.addKinematic({
        min: { x: -1, y: 0, z: -1 },
        max: { x: 1, y: 0.2, z: 1 },
      });
      const crate = w.addBody({
        position: { x: 0, y: 0.6, z: 0 },
        halfExtents: CRATE.halfExtents,
        mass: CRATE.mass,
      });
      for (let f = 0; f < 30; f++) {
        w.step(DT);
      }
      let y = 0;
      let blocked = 0;
      for (let f = 0; f < 90; f++) {
        const r = w.moveKinematic(lift, {
          x: -1,
          y: Math.min(y + 1 / 60, 2),
          z: -1,
        });
        if (r.blocked) {
          blocked++;
        }
        // Read back where the lift is: its top, beside the crate.
        const hit = w.raycast(
          { x: 0.95, y: ceiling - 0.01, z: 0.95 },
          { x: 0, y: -1, z: 0 },
          5,
        );
        expect(hit?.collider).toEqual({ kind: "kinematic", id: lift });
        y = hit!.point.y - 0.2;
        w.step(DT);
        const b = w.getBody(crate)!;
        expect(b.position.y + 0.4).toBeLessThan(ceiling + 0.01);
        expect(speedOf(w, crate)).toBeLessThan(2);
      }
      if (ceiling > 3) {
        expect(blocked).toBe(0);
        expect(w.getBody(crate)!.position.y).toBeGreaterThan(1.8);
      } else {
        expect(blocked).toBeGreaterThan(30);
        // The lift stopped with the crate just under the ceiling.
        expect(w.getBody(crate)!.position.y).toBeGreaterThan(1.3 - 0.4 - 0.01);
      }
    }
  });
});
