import { describe, expect, test } from "bun:test";
import type {
  CharacterMoveOptions,
  CharacterMoveResult,
  PhysicsWorld,
} from "../core/api";
import { PLAYER, PROP_SPECS } from "../core/props";
import type { Vec3 } from "../math";
import { createPhysicsWorld } from "./index";

const DT = 1 / 60;
const HALF = {
  x: PLAYER.halfWidth,
  y: PLAYER.standHeight / 2,
  z: PLAYER.halfWidth,
};
const CRATE = PROP_SPECS.crate_wood;

function floorWorld(): PhysicsWorld {
  const w = createPhysicsWorld();
  w.addStatic({ min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 0, z: 20 } });
  return w;
}

/**
 * A minimal player: applies gravity, keeps the desired horizontal velocity,
 * calls moveCharacter then steps the world, like the game loop will.
 */
class Walker {
  pos: Vec3;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  last: CharacterMoveResult | null = null;
  constructor(
    readonly w: PhysicsWorld,
    feet: Vec3,
    readonly options: CharacterMoveOptions = {},
  ) {
    this.pos = { x: feet.x, y: feet.y + HALF.y, z: feet.z };
  }
  walk(
    dir: Vec3,
    frames: number,
    each?: (r: CharacterMoveResult) => void,
  ): CharacterMoveResult {
    for (let f = 0; f < frames; f++) {
      this.vel = { x: dir.x, y: this.vel.y - 9.81 * DT, z: dir.z };
      if (dir.y > 0 && this.last?.onGround) {
        this.vel.y = dir.y;
      }
      const r = this.w.moveCharacter(
        this.pos,
        HALF,
        this.vel,
        DT,
        this.options,
      );
      this.pos = r.position;
      this.vel = r.velocity;
      this.last = r;
      this.w.step(DT);
      each?.(r);
    }
    return this.last!;
  }
  get feetY(): number {
    return this.pos.y - HALF.y;
  }
}

describe("moveCharacter", () => {
  test("stands on the floor", () => {
    const w = floorWorld();
    const p = new Walker(w, { x: 0, y: 0.5, z: 0 });
    const r = p.walk({ x: 0, y: 0, z: 0 }, 60);
    expect(r.onGround).toBe(true);
    expect(r.standingOn).toEqual({ kind: "static", id: 0 });
    expect(r.groundNormal).toEqual({ x: 0, y: 1, z: 0 });
    expect(p.feetY).toBeGreaterThanOrEqual(0);
    expect(p.feetY).toBeLessThan(0.005);
    expect(r.velocity.y).toBe(0);
  });

  test("is airborne when falling and reports a default ground normal", () => {
    const w = floorWorld();
    const r = w.moveCharacter(
      { x: 0, y: 5, z: 0 },
      HALF,
      { x: 0, y: -1, z: 0 },
      DT,
    );
    expect(r.onGround).toBe(false);
    expect(r.standingOn).toBeNull();
    expect(r.groundNormal).toEqual({ x: 0, y: 1, z: 0 });
  });

  test("slides along a wall it walks into at an angle", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 1, y: 0, z: -10 }, max: { x: 1.2, y: 3, z: 10 } });
    const p = new Walker(w, { x: 0, y: 0, z: 0 });
    const r = p.walk({ x: 3, y: 0, z: 3 }, 60);
    expect(p.pos.x).toBeLessThanOrEqual(1 - HALF.x + 1e-9);
    expect(p.pos.x).toBeGreaterThan(1 - HALF.x - 0.01);
    // Kept moving along the wall at the tangential speed.
    expect(p.pos.z).toBeGreaterThan(2.8);
    expect(r.velocity.x).toBeCloseTo(0, 6);
    expect(r.velocity.z).toBeCloseTo(3, 6);
  });

  test("does not jitter when pushed into a corner", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 1, y: 0, z: -10 }, max: { x: 1.2, y: 3, z: 10 } });
    w.addStatic({ min: { x: -10, y: 0, z: 1 }, max: { x: 10, y: 3, z: 1.2 } });
    const p = new Walker(w, { x: 0, y: 0, z: 0 });
    p.walk({ x: 4, y: 0, z: 3 }, 60);
    const settled = { ...p.pos };
    let maxDev = 0;
    p.walk({ x: 4, y: 0, z: 3 }, 120, (r) => {
      maxDev = Math.max(
        maxDev,
        Math.hypot(
          r.position.x - settled.x,
          r.position.y - settled.y,
          r.position.z - settled.z,
        ),
      );
      expect(r.onGround).toBe(true);
    });
    expect(maxDev).toBeLessThan(1e-4);
    expect(settled.x).toBeCloseTo(1 - HALF.x, 2);
    expect(settled.z).toBeCloseTo(1 - HALF.z, 2);
  });

  test("steps up a 0.25 m ledge but not a 0.5 m one", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 1, y: 0, z: -5 }, max: { x: 4, y: 0.25, z: 0 } });
    w.addStatic({ min: { x: 1, y: 0, z: 1 }, max: { x: 4, y: 0.5, z: 5 } });
    const low = new Walker(w, { x: 0, y: 0, z: -2 });
    const r = low.walk({ x: 3, y: 0, z: 0 }, 60);
    expect(low.pos.x).toBeGreaterThan(2);
    expect(low.feetY).toBeCloseTo(0.25, 2);
    expect(r.onGround).toBe(true);

    const high = new Walker(w, { x: 0, y: 0, z: 3 });
    high.walk({ x: 3, y: 0, z: 0 }, 60);
    expect(high.pos.x).toBeLessThanOrEqual(1 - HALF.x + 1e-6);
    expect(high.feetY).toBeLessThan(0.01);
  });

  test("walks down steps without leaving the ground", () => {
    const w = createPhysicsWorld();
    for (let i = 0; i < 5; i++) {
      w.addStatic({
        min: { x: i, y: -1, z: -2 },
        max: { x: i + 1, y: 1 - i * 0.2, z: 2 },
      });
    }
    const p = new Walker(w, { x: 0.5, y: 1, z: 0 });
    let airborne = 0;
    p.walk({ x: 2, y: 0, z: 0 }, 125, (r) => {
      if (!r.onGround) {
        airborne++;
      }
    });
    // Fully over the last step (x 4..5).
    expect(p.pos.x - HALF.x).toBeGreaterThan(4);
    expect(airborne).toBe(0);
    expect(p.feetY).toBeCloseTo(0.2, 2);
  });

  test("hits a low ceiling when jumping", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: -2, y: 2.2, z: -2 }, max: { x: 2, y: 2.5, z: 2 } });
    const p = new Walker(w, { x: 0, y: 0, z: 0 });
    p.walk({ x: 0, y: 0, z: 0 }, 5);
    let hit = false;
    let maxHead = 0;
    p.walk({ x: 0, y: 5, z: 0 }, 1, (r) => {
      hit ||= r.hitCeiling;
    });
    p.walk({ x: 0, y: 0, z: 0 }, 30, (r) => {
      hit ||= r.hitCeiling;
      maxHead = Math.max(maxHead, r.position.y + HALF.y);
    });
    expect(hit).toBe(true);
    expect(maxHead).toBeLessThanOrEqual(2.2);
    p.walk({ x: 0, y: 0, z: 0 }, 60);
    expect(p.last?.onGround).toBe(true);
  });

  test("stands on a dynamic crate", () => {
    const w = floorWorld();
    const crate = w.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const p = new Walker(w, { x: 0, y: 1, z: 0 });
    const r = p.walk({ x: 0, y: 0, z: 0 }, 120);
    expect(r.onGround).toBe(true);
    expect(r.standingOn).toEqual({ kind: "body", id: crate });
    expect(p.feetY).toBeCloseTo(0.8, 2);
    const b = w.getBody(crate)!;
    expect(b.position.y).toBeCloseTo(0.4, 2);
    expect(Math.hypot(b.position.x, b.position.z)).toBeLessThan(0.005);
  });

  test("stands stably on a stack of crates and its weight presses on them", () => {
    const w = floorWorld();
    const ids = [0, 1, 2].map((i) =>
      w.addBody({
        position: { x: 0, y: 0.4 + 0.8 * i, z: 0 },
        halfExtents: CRATE.halfExtents,
        mass: CRATE.mass,
      }),
    );
    for (let f = 0; f < 60; f++) {
      w.step(DT);
    }
    const p = new Walker(w, { x: 0.1, y: 2.45, z: 0 });
    // Land first.
    p.walk({ x: 0, y: 0, z: 0 }, 30);
    let maxSpeed = 0;
    let feetMin = Infinity;
    let feetMax = -Infinity;
    p.walk({ x: 0, y: 0, z: 0 }, 300, (r) => {
      expect(r.standingOn).toEqual({ kind: "body", id: ids[2] });
      for (const id of ids) {
        const v = w.getBody(id)!.linearVelocity;
        maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      }
      feetMin = Math.min(feetMin, p.feetY);
      feetMax = Math.max(feetMax, p.feetY);
    });
    expect(maxSpeed).toBeLessThan(0.2);
    expect(feetMax - feetMin).toBeLessThan(0.02);
    for (let i = 0; i < 3; i++) {
      const b = w.getBody(ids[i])!;
      expect(Math.hypot(b.position.x, b.position.z)).toBeLessThan(0.01);
      expect(Math.abs(b.position.y - (0.4 + 0.8 * i))).toBeLessThan(0.006);
    }
  });

  test("its weight tips a crate overhanging a ledge when standing on the overhang", () => {
    const w = createPhysicsWorld();
    w.addStatic({ min: { x: -5, y: -1, z: -5 }, max: { x: 0, y: 0, z: 5 } }); // ledge edge at x = 0
    w.addStatic({ min: { x: -5, y: -6, z: -5 }, max: { x: 10, y: -5, z: 5 } }); // far below
    const crate = w.addBody({
      position: { x: -0.1, y: 0.4, z: 0 }, // 0.3 m hangs over the edge
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    for (let f = 0; f < 60; f++) {
      w.step(DT);
    }
    expect(w.getBody(crate)!.position.y).toBeCloseTo(0.4, 2);
    const p = new Walker(w, { x: 0.15, y: 0.81, z: 0 });
    p.walk({ x: 0, y: 0, z: 0 }, 120);
    expect(w.getBody(crate)!.position.y).toBeLessThan(0);
  });

  test("pushes a 25 kg crate, and a 60 kg crate more slowly", () => {
    const distance = (mass: number, half: Vec3): number => {
      const w = floorWorld();
      const crate = w.addBody({
        position: { x: 1, y: half.y, z: 0 },
        halfExtents: half,
        mass,
      });
      const p = new Walker(w, { x: 0, y: 0, z: 0 });
      p.walk({ x: 3, y: 0, z: 0 }, 120);
      // The player stays outside the crate.
      const b = w.getBody(crate)!;
      expect(p.pos.x + HALF.x).toBeLessThanOrEqual(
        b.position.x - half.x + 0.01,
      );
      return b.position.x - 1;
    };
    const light = distance(25, CRATE.halfExtents);
    const heavy = distance(60, PROP_SPECS.crate_metal.halfExtents);
    expect(light).toBeGreaterThan(3);
    expect(heavy).toBeGreaterThan(0.2);
    expect(heavy).toBeLessThan(light * 0.7);
  });

  test("passes through the ignored body", () => {
    const w = floorWorld();
    const crate = w.addBody({
      position: { x: 1, y: 1.0, z: 0 },
      halfExtents: { x: 0.25, y: 0.25, z: 0.25 },
      mass: 8,
    });
    const start = { x: 0, y: HALF.y, z: 0 };
    const through = w.moveCharacter(start, HALF, { x: 60, y: 0, z: 0 }, DT, {
      ignoreBody: crate,
    });
    expect(through.position.x).toBeCloseTo(1, 6);
    expect(w.getBody(crate)!.linearVelocity.x).toBe(0);
    const blocked = w.moveCharacter(start, HALF, { x: 60, y: 0, z: 0 }, DT);
    expect(blocked.position.x).toBeLessThan(1 - 0.25 - HALF.x + 1e-6);
    expect(blocked.position.x).toBeGreaterThan(1 - 0.25 - HALF.x - 0.01);
    expect(w.getBody(crate)!.linearVelocity.x).toBeGreaterThan(0);
  });

  test("is pushed out of a door that closes on it, never into a wall", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: -3, y: 0, z: -1 }, max: { x: -0.5, y: 3, z: 1 } });
    const door = w.addKinematic({
      min: { x: 2, y: 0, z: -1 },
      max: { x: 2.2, y: 3, z: 1 },
    });
    const p = new Walker(w, { x: 0.5, y: 0, z: 0 });
    for (let f = 0; f < 60; f++) {
      w.moveKinematic(door, { x: 2 - f * 0.03, y: 0, z: -1 });
      p.walk({ x: 0, y: 0, z: 0 }, 1);
      expect(p.pos.x - HALF.x).toBeGreaterThanOrEqual(-0.5 - 1e-6);
    }
  });

  test("bodies cannot shove through the character", () => {
    const w = floorWorld();
    const p = new Walker(w, { x: 0, y: 0, z: 0 });
    p.walk({ x: 0, y: 0, z: 0 }, 10);
    const crate = w.addBody({
      position: { x: 3, y: 0.9, z: 0 },
      halfExtents: PROP_SPECS.crate_wood_small.halfExtents,
      mass: 8,
      linearVelocity: { x: -12, y: 0, z: 0 },
    });
    let minX = Infinity;
    p.walk({ x: 0, y: 0, z: 0 }, 60, () => {
      minX = Math.min(minX, w.getBody(crate)!.position.x);
    });
    expect(minX - 0.25).toBeGreaterThan(HALF.x - 0.03);
  });

  test("carrying a body: it follows the hold point, ignores the carrier and stays out of walls", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 3, y: 0, z: -5 }, max: { x: 3.2, y: 3, z: 5 } });
    const box = w.addBody({
      position: { x: 1.2, y: 1.2, z: 0 },
      halfExtents: PROP_SPECS.crate_wood_small.halfExtents,
      mass: 8,
    });
    const p = new Walker(w, { x: 0, y: 0, z: 0 }, { ignoreBody: box });
    let maxSpeed = 0;
    let maxBoxX = -Infinity;
    for (let f = 0; f < 240; f++) {
      // Hold point 1.2 m ahead of the player, at chest height.
      const hold = { x: p.pos.x + 1.2, y: p.pos.y + 0.3, z: p.pos.z };
      const b = w.getBody(box)!;
      const v = {
        x: (hold.x - b.position.x) * 12,
        y: (hold.y - b.position.y) * 12,
        z: (hold.z - b.position.z) * 12,
      };
      const len = Math.hypot(v.x, v.y, v.z);
      const s = len > 10 ? 10 / len : 1;
      w.setBodyVelocity(
        box,
        { x: v.x * s, y: v.y * s, z: v.z * s },
        { x: 0, y: 0, z: 0 },
      );
      p.walk({ x: 2.5, y: 0, z: 0 }, 1);
      const nb = w.getBody(box)!;
      maxSpeed = Math.max(
        maxSpeed,
        Math.hypot(
          nb.angularVelocity.x,
          nb.angularVelocity.y,
          nb.angularVelocity.z,
        ),
      );
      maxBoxX = Math.max(maxBoxX, nb.position.x + 0.25);
    }
    // The player reached the wall even though the box was in front of it.
    expect(p.pos.x + HALF.x).toBeGreaterThan(2.9);
    expect(maxBoxX).toBeLessThan(3.02);
    expect(maxSpeed).toBeLessThan(2);
    const b = w.getBody(box)!;
    expect(Math.abs(b.position.y - (p.pos.y + 0.3))).toBeLessThan(0.15);
  });
});
