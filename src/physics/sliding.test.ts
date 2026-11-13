import { describe, expect, test } from "bun:test";
import type { PhysicsWorld, SlidingContact } from "../core/api";
import { PLAYER, PROP_SPECS } from "../core/props";
import { createPhysicsWorld } from "./index";
import { World } from "./world";

const DT = 1 / 60;
const CRATE = PROP_SPECS.crate_wood;
const G = 9.81;

function floorWorld(): PhysicsWorld {
  const w = createPhysicsWorld();
  w.addStatic({ min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 0, z: 20 } });
  return w;
}

function entryFor(w: PhysicsWorld, id: number): SlidingContact | undefined {
  const all = w.slidingContacts();
  const mine = all.filter((s) => s.body === id);
  expect(mine.length).toBeLessThanOrEqual(1);
  return mine[0];
}

function expectFinite(s: SlidingContact): void {
  for (const v of [
    s.point.x,
    s.point.y,
    s.point.z,
    s.slipSpeed,
    s.rollSpeed,
    s.force,
  ]) {
    expect(Number.isFinite(v)).toBe(true);
  }
  expect(s.slipSpeed).toBeGreaterThanOrEqual(0);
  expect(s.rollSpeed).toBeGreaterThanOrEqual(0);
  expect(s.force).toBeGreaterThan(0);
}

describe("slidingContacts", () => {
  test("a crate sliding on the floor reports slip at its speed and its weight, then stops reporting", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
      linearVelocity: { x: 4, y: 0, z: 0 },
    });
    let reported = 0;
    let lastReport = -1;
    for (let f = 0; f < 180; f++) {
      w.step(DT);
      const s = entryFor(w, id);
      const v = w.getBody(id)!.linearVelocity;
      const speed = Math.hypot(v.x, v.z);
      if (f < 2) {
        // Contacts younger than two steps are impacts, not slides.
        expect(s).toBeUndefined();
        continue;
      }
      if (speed > 0.2) {
        expect(s).toBeDefined();
      }
      if (!s) {
        continue;
      }
      reported++;
      lastReport = f;
      expectFinite(s);
      expect(s.other).toEqual({ kind: "static", id: 0 });
      expect(Math.abs(s.slipSpeed - speed)).toBeLessThan(0.05 + 0.03 * speed);
      expect(s.rollSpeed).toBeLessThan(0.05 + 0.05 * speed);
      expect(s.force).toBeGreaterThan(CRATE.mass * G * 0.85);
      expect(s.force).toBeLessThan(CRATE.mass * G * 1.15);
      expect(s.point.y).toBeCloseTo(0, 1);
      expect(Math.abs(s.point.x - w.getBody(id)!.position.x)).toBeLessThan(0.1);
    }
    expect(reported).toBeGreaterThan(30);
    // Stopped within about 1.4 s (v / (mu g)) and silent afterwards.
    expect(lastReport).toBeLessThan(100);
    expect(w.slidingContacts()).toEqual([]);
  });

  test("a resting stack and a sleeping body report nothing", () => {
    const w = new World();
    w.allowSleep = false;
    w.addStatic({
      min: { x: -20, y: -1, z: -20 },
      max: { x: 20, y: 0, z: 20 },
    });
    for (let i = 0; i < 3; i++) {
      w.addBody({
        position: { x: 0, y: 0.4 + 0.8 * i, z: 0 },
        halfExtents: CRATE.halfExtents,
        mass: CRATE.mass,
      });
    }
    for (let f = 0; f < 240; f++) {
      w.step(DT);
      expect(w.slidingContacts()).toEqual([]);
    }

    const s = floorWorld();
    const id = s.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
      linearVelocity: { x: 2, y: 0, z: 0 },
    });
    for (let f = 0; f < 240; f++) {
      s.step(DT);
    }
    expect(s.getBody(id)!.asleep).toBe(true);
    expect(s.slidingContacts()).toEqual([]);
  });

  test("a free-falling body reports nothing", () => {
    const w = floorWorld();
    w.addBody({
      position: { x: 0, y: 5, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
      linearVelocity: { x: 3, y: 0, z: 0 },
      angularVelocity: { x: 1, y: 2, z: 0 },
    });
    for (let f = 0; f < 50; f++) {
      w.step(DT);
      expect(w.slidingContacts()).toEqual([]);
    }
  });

  test("a tumbling crate reports rolling", () => {
    const w = floorWorld();
    // Thrown low and spinning forward: it tips over its edges.
    const id = w.addBody({
      position: { x: 0, y: 0.42, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
      linearVelocity: { x: 3, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: -9 },
    });
    let maxRoll = 0;
    for (let f = 0; f < 120; f++) {
      w.step(DT);
      const s = entryFor(w, id);
      if (s) {
        expectFinite(s);
        maxRoll = Math.max(maxRoll, s.rollSpeed);
      }
    }
    expect(maxRoll).toBeGreaterThan(0.5);
  });

  test("a crate pushed by the character reports sliding while pushed", () => {
    const w = floorWorld();
    const crate = w.addBody({
      position: { x: 1, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const half = { x: PLAYER.halfWidth, y: 0.9, z: PLAYER.halfWidth };
    let pos = { x: 0, y: 0.9, z: 0 };
    for (let f = 0; f < 30; f++) {
      pos = w.moveCharacter(pos, half, { x: 0, y: -1, z: 0 }, DT).position;
      w.step(DT);
    }
    let sliding = 0;
    for (let f = 0; f < 120; f++) {
      pos = w.moveCharacter(pos, half, { x: 2, y: -1, z: 0 }, DT).position;
      w.step(DT);
      const s = entryFor(w, crate);
      if (f > 20) {
        expect(s).toBeDefined();
        expect(s!.other).toEqual({ kind: "static", id: 0 });
        expect(s!.slipSpeed).toBeGreaterThan(1);
        expect(s!.slipSpeed).toBeLessThan(3);
        sliding++;
      }
    }
    expect(sliding).toBe(99);
  });

  test("a carried (velocity-driven) prop dragged along the floor reports sliding", () => {
    const w = floorWorld();
    const spec = PROP_SPECS.crate_wood_small;
    const id = w.addBody({
      position: { x: 0, y: spec.halfExtents.y, z: 0 },
      halfExtents: spec.halfExtents,
      mass: spec.mass,
    });
    let count = 0;
    for (let f = 0; f < 90; f++) {
      const b = w.getBody(id)!;
      // Hold point slightly below the floor, moving along +x.
      w.setBodyVelocity(
        id,
        {
          x: 1.5,
          y: (0.2 - b.position.y) * 10 - w.gravity.y * DT,
          z: -b.position.z * 10,
        },
        { x: 0, y: 0, z: 0 },
      );
      w.moveCharacter(
        { x: b.position.x - 1.2, y: 0.9, z: 0 },
        { x: 0.3, y: 0.9, z: 0.3 },
        { x: 0, y: 0, z: 0 },
        DT,
        { ignoreBody: id },
      );
      w.step(DT);
      const s = entryFor(w, id);
      if (f > 10) {
        expect(s).toBeDefined();
        expect(s!.slipSpeed).toBeGreaterThan(1);
        count++;
      }
    }
    expect(count).toBe(79);
  });

  test("a crate sliding on top of another crate reports that crate, which reports nothing", () => {
    const w = floorWorld();
    const low = w.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: CRATE.mass,
    });
    const small = PROP_SPECS.crate_wood_small;
    const top = w.addBody({
      position: { x: -0.2, y: 0.8 + small.halfExtents.y, z: 0 },
      halfExtents: small.halfExtents,
      mass: small.mass,
      linearVelocity: { x: 2.5, y: 0, z: 0 },
    });
    let seen = 0;
    for (let f = 0; f < 20; f++) {
      w.step(DT);
      const s = entryFor(w, top);
      if (f >= 3 && w.getBody(top)!.linearVelocity.x > 0.3) {
        expect(s).toBeDefined();
        expect(s!.other).toEqual({ kind: "body", id: low });
        expect(s!.force).toBeGreaterThan(small.mass * G * 0.85);
        expect(s!.force).toBeLessThan(small.mass * G * 1.15);
        seen++;
      }
      expect(entryFor(w, low)).toBeUndefined();
    }
    expect(seen).toBeGreaterThan(5);
  });

  test("results are deterministic and the same within a step", () => {
    const runOnce = (): string => {
      const w = floorWorld();
      for (let i = 0; i < 6; i++) {
        w.addBody({
          position: { x: i * 1.2, y: 0.4 + (i % 2) * 0.5, z: 0 },
          halfExtents: CRATE.halfExtents,
          mass: CRATE.mass,
          linearVelocity: { x: 3 - i, y: 0, z: i * 0.3 },
          angularVelocity: { x: 0, y: i * 0.5, z: -i },
        });
      }
      const log: SlidingContact[][] = [];
      for (let f = 0; f < 180; f++) {
        w.step(DT);
        const a = w.slidingContacts();
        expect(w.slidingContacts()).toBe(a);
        for (const s of a) {
          expectFinite(s);
        }
        log.push(a);
      }
      return JSON.stringify(log);
    };
    const a = runOnce();
    expect(a).toBe(runOnce());
    expect(a.length).toBeGreaterThan(1000);
  });
});
