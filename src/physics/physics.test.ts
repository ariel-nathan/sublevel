import { describe, expect, test } from "bun:test";
import type { PhysicsWorld } from "../core/api";
import { PROP_SPECS } from "../core/props";
import { quat } from "../math";
import { createPhysicsWorld } from "./index";
import { World } from "./world";

const DT = 1 / 60;
const CRATE = PROP_SPECS.crate_wood;
const METAL = PROP_SPECS.crate_metal;

function floorWorld(): PhysicsWorld {
  const w = createPhysicsWorld();
  w.addStatic({ min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 0, z: 20 } });
  return w;
}

function run(
  w: PhysicsWorld,
  seconds: number,
  each?: (frame: number) => void,
): void {
  const frames = Math.round(seconds / DT);
  for (let f = 0; f < frames; f++) {
    w.step(DT);
    each?.(f);
  }
}

function body(w: PhysicsWorld, id: number) {
  const b = w.getBody(id);
  if (!b) {
    throw new Error(`no body ${id}`);
  }
  return b;
}

function speed(w: PhysicsWorld, id: number): number {
  const v = body(w, id).linearVelocity;
  return Math.hypot(v.x, v.y, v.z);
}

/** Cosine between the body's local Y axis and world up. */
function uprightness(w: PhysicsWorld, id: number): number {
  return quat.rotate(body(w, id).orientation, { x: 0, y: 1, z: 0 }).y;
}

describe("resting contact", () => {
  test("a dropped box comes to rest at the right height and sleeps", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 0, y: 2, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    run(w, 3);
    const b = body(w, id);
    expect(b.position.y).toBeCloseTo(0.4, 2);
    expect(Math.abs(b.position.y - 0.4)).toBeLessThan(0.002);
    expect(Math.hypot(b.position.x, b.position.z)).toBeLessThan(0.005);
    expect(b.asleep).toBe(true);
  });

  test("a stack of five crates settles on its ideal pose, stays still and sleeps", () => {
    const w = floorWorld();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      // Small gaps so each crate drops a little onto the one below.
      ids.push(
        w.addBody({
          position: { x: 0, y: 0.4 + 0.8 * i + 0.01 * i, z: 0 },
          halfExtents: CRATE.halfExtents,
          mass: CRATE.mass,
        }),
      );
    }
    let maxSpeedAfterSettle = 0;
    run(w, 6, (f) => {
      if (f * DT > 1.5) {
        for (const id of ids) {
          maxSpeedAfterSettle = Math.max(maxSpeedAfterSettle, speed(w, id));
        }
      }
    });
    for (let i = 0; i < 5; i++) {
      const b = body(w, ids[i]);
      expect(Math.hypot(b.position.x, b.position.z)).toBeLessThan(0.01);
      expect(Math.abs(b.position.y - (0.4 + 0.8 * i))).toBeLessThan(0.005);
      expect(uprightness(w, ids[i])).toBeGreaterThan(0.9999);
      expect(b.asleep).toBe(true);
    }
    expect(maxSpeedAfterSettle).toBeLessThan(0.02);
  });

  test("a stack kept awake does not jitter, drift or sink over 20 seconds", () => {
    const w = new World();
    w.allowSleep = false;
    w.addStatic({
      min: { x: -20, y: -1, z: -20 },
      max: { x: 20, y: 0, z: 20 },
    });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        w.addBody({
          position: { x: 0.02 * (i % 2), y: 0.4 + 0.8 * i + 0.005, z: 0 },
          orientation: quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, 0.05 * i),
          halfExtents: CRATE.halfExtents,
          mass: CRATE.mass,
        }),
      );
    }
    run(w, 2);
    const before = ids.map((id) => body(w, id).position);
    let maxSpeed = 0;
    run(w, 18, () => {
      for (const id of ids) {
        maxSpeed = Math.max(maxSpeed, speed(w, id));
      }
    });
    for (let i = 0; i < 5; i++) {
      const p = body(w, ids[i]).position;
      expect(
        Math.hypot(p.x - before[i].x, p.y - before[i].y, p.z - before[i].z),
      ).toBeLessThan(0.003);
    }
    expect(maxSpeed).toBeLessThan(0.02);
  });

  test("a 60 kg box on a 25 kg box is stable", () => {
    const w = floorWorld();
    const low = w.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    const high = w.addBody({
      position: { x: 0.1, y: 0.8 + 0.35 + 0.02, z: -0.05 },
      orientation: quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, 0.4),
      halfExtents: METAL.halfExtents,
      mass: METAL.mass,
    });
    run(w, 5);
    const a = body(w, low);
    const b = body(w, high);
    expect(Math.abs(a.position.y - 0.4)).toBeLessThan(0.003);
    expect(Math.abs(b.position.y - 1.15)).toBeLessThan(0.004);
    expect(Math.hypot(b.position.x - 0.1, b.position.z + 0.05)).toBeLessThan(
      0.01,
    );
    expect(uprightness(w, high)).toBeGreaterThan(0.9999);
    expect(a.asleep && b.asleep).toBe(true);
  });

  test("a heavy box on a pile of light boxes settles", () => {
    const w = floorWorld();
    const ids = [
      w.addBody({
        position: { x: -0.41, y: 0.4, z: 0 },
        halfExtents: CRATE.halfExtents,
        mass: 25,
      }),
      w.addBody({
        position: { x: 0.41, y: 0.4, z: 0 },
        halfExtents: CRATE.halfExtents,
        mass: 25,
      }),
      w.addBody({
        position: { x: 0, y: 1.16, z: 0 },
        halfExtents: METAL.halfExtents,
        mass: 60,
      }),
    ];
    run(w, 5);
    for (const id of ids) {
      expect(body(w, id).asleep).toBe(true);
    }
    expect(Math.abs(body(w, ids[2]).position.y - 1.15)).toBeLessThan(0.005);
  });
});

describe("waking", () => {
  test("a box on a removed kinematic platform falls", () => {
    const w = floorWorld();
    const plat = w.addKinematic({
      min: { x: -1, y: 1, z: -1 },
      max: { x: 1, y: 1.2, z: 1 },
    });
    const id = w.addBody({
      position: { x: 0, y: 1.6, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    run(w, 3);
    expect(body(w, id).asleep).toBe(true);
    expect(body(w, id).position.y).toBeCloseTo(1.6, 2);
    w.removeKinematic(plat);
    run(w, 2);
    expect(body(w, id).position.y).toBeCloseTo(0.4, 2);
  });

  test("a box on a sliding kinematic platform falls when it slides away", () => {
    const w = floorWorld();
    const plat = w.addKinematic({
      min: { x: -0.5, y: 1, z: -0.5 },
      max: { x: 0.5, y: 1.2, z: 0.5 },
    });
    const id = w.addBody({
      position: { x: 0, y: 1.6, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    w.addStatic({
      min: { x: -0.6, y: 1.25, z: -1 },
      max: { x: -0.45, y: 3, z: 1 },
    }); // wall it slides out from under
    run(w, 3);
    expect(body(w, id).asleep).toBe(true);
    // Platform slides in +x quickly; the wall keeps the crate from riding along far.
    for (let f = 0; f < 60; f++) {
      w.moveKinematic(plat, { x: -0.5 + f * 0.05, y: 1, z: -0.5 });
      w.step(DT);
    }
    run(w, 2);
    expect(body(w, id).position.y).toBeLessThan(0.45);
  });

  test("removing the lower box wakes the upper one, which falls", () => {
    const w = floorWorld();
    const support = w.addStatic({
      min: { x: -1, y: 0, z: -1 },
      max: { x: 1, y: 0.2, z: 1 },
    });
    expect(support).toBe(1);
    const low = w.addBody({
      position: { x: 0, y: 0.6, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    const high = w.addBody({
      position: { x: 0, y: 1.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    run(w, 3);
    expect(body(w, high).asleep).toBe(true);
    w.removeBody(low);
    expect(body(w, high).asleep).toBe(false);
    run(w, 2);
    expect(body(w, high).position.y).toBeCloseTo(0.6, 2);
    expect(body(w, high).asleep).toBe(true);
  });

  test("a body thrown at a sleeping pile wakes it and knocks it over", () => {
    const w = floorWorld();
    const ids = [0, 1, 2].map((i) =>
      w.addBody({
        position: { x: 0, y: 0.4 + 0.8 * i, z: 0 },
        halfExtents: CRATE.halfExtents,
        mass: 25,
      }),
    );
    run(w, 2);
    expect(ids.every((id) => body(w, id).asleep)).toBe(true);
    w.addBody({
      position: { x: -3, y: 2, z: 0 },
      halfExtents: PROP_SPECS.crate_wood_small.halfExtents,
      mass: 8,
      linearVelocity: { x: 15, y: 0, z: 0 },
    });
    run(w, 3);
    expect(body(w, ids[2]).position.x).toBeGreaterThan(0.2);
  });

  test("setBodyPose and applyImpulse wake a sleeping body", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    run(w, 2);
    expect(body(w, id).asleep).toBe(true);
    w.applyImpulse(id, { x: 50, y: 0, z: 0 });
    expect(body(w, id).asleep).toBe(false);
    expect(body(w, id).linearVelocity.x).toBeCloseTo(2, 5);
    run(w, 3);
    expect(body(w, id).position.x).toBeGreaterThan(0.1);
    expect(body(w, id).asleep).toBe(true);
    w.setBodyPose(id, { x: 0, y: 3, z: 0 });
    expect(body(w, id).asleep).toBe(false);
    run(w, 2);
    expect(body(w, id).position.y).toBeCloseTo(0.4, 2);
  });

  test("an off-centre impulse makes a body spin", () => {
    const w = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const id = w.addBody({
      position: { x: 0, y: 0, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    w.applyImpulse(id, { x: 0, y: 0, z: -10 }, { x: 0.4, y: 0, z: 0 });
    const b = body(w, id);
    // Torque r x J = (0.4,0,0) x (0,0,-10) = (0, 4, 0); I = m/3*(0.32) = 2.667.
    expect(b.angularVelocity.y).toBeCloseTo(4 / ((25 / 3) * 0.32), 5);
    expect(b.linearVelocity.z).toBeCloseTo(-0.4, 5);
  });
});

describe("fast bodies", () => {
  test("a crate thrown at 20 m/s does not tunnel through a 0.2 m wall", () => {
    for (const offset of [0, 0.05, 0.11, 0.17, 0.23, 0.29]) {
      const w = floorWorld();
      w.addStatic({ min: { x: 5, y: 0, z: -3 }, max: { x: 5.2, y: 3, z: 3 } });
      const half = PROP_SPECS.crate_wood_small.halfExtents;
      const id = w.addBody({
        position: { x: offset, y: 1.5, z: 0 },
        halfExtents: half,
        mass: 8,
        linearVelocity: { x: 20, y: 1, z: 0 },
        angularVelocity: { x: 3, y: 5, z: 7 },
      });
      let maxX = -Infinity;
      run(w, 2, () => {
        maxX = Math.max(maxX, body(w, id).position.x);
      });
      expect(maxX).toBeLessThan(5);
      expect(body(w, id).position.x).toBeLessThan(5);
    }
  });

  test("a crate thrown straight down at 40 m/s stops on a thin floor", () => {
    const w = createPhysicsWorld();
    w.addStatic({ min: { x: -5, y: -0.2, z: -5 }, max: { x: 5, y: 0, z: 5 } });
    const id = w.addBody({
      position: { x: 0, y: 3, z: 0 },
      halfExtents: PROP_SPECS.crate_wood_small.halfExtents,
      mass: 8,
      linearVelocity: { x: 0, y: -40, z: 0 },
    });
    let minY = Infinity;
    run(w, 3, () => {
      minY = Math.min(minY, body(w, id).position.y);
    });
    expect(minY).toBeGreaterThan(0.2);
    expect(body(w, id).position.y).toBeCloseTo(0.25, 2);
  });

  test("two fast crates thrown at each other collide instead of passing", () => {
    const w = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const half = PROP_SPECS.crate_wood_small.halfExtents;
    const a = w.addBody({
      position: { x: -2, y: 1, z: 0 },
      halfExtents: half,
      mass: 8,
      linearVelocity: { x: 25, y: 0, z: 0 },
    });
    const b = w.addBody({
      position: { x: 2, y: 1, z: 0 },
      halfExtents: half,
      mass: 8,
      linearVelocity: { x: -25, y: 0, z: 0 },
    });
    run(w, 1);
    expect(body(w, a).position.x).toBeLessThan(body(w, b).position.x);
  });
});

describe("tumbling and friction", () => {
  test("a sliding crate stops within a plausible distance", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
      linearVelocity: { x: 5, y: 0, z: 0 },
    });
    run(w, 3);
    // Coulomb friction mu = 0.6: v^2 / (2 mu g) = 2.12 m.
    const x = body(w, id).position.x;
    expect(x).toBeGreaterThan(1.8);
    expect(x).toBeLessThan(2.4);
    expect(uprightness(w, id)).toBeGreaterThan(0.999);
    expect(speed(w, id)).toBeLessThan(0.01);
  });

  test("a crate slides smoothly across seams between floor brushes", () => {
    const w = createPhysicsWorld();
    for (let i = -5; i < 5; i++) {
      w.addStatic({
        min: { x: i, y: -1, z: -5 },
        max: { x: i + 1, y: 0, z: 5 },
      });
    }
    const id = w.addBody({
      position: { x: -4, y: 0.25, z: 0 },
      halfExtents: PROP_SPECS.crate_wood_small.halfExtents,
      mass: 8,
      friction: 0.2,
      linearVelocity: { x: 5, y: 0, z: 0 },
    });
    let prev = 5;
    let maxDrop = 0;
    let minDrop = Infinity;
    let maxRise = 0;
    run(w, 1.2, () => {
      const b = body(w, id);
      const v = b.linearVelocity.x;
      maxDrop = Math.max(maxDrop, prev - v);
      minDrop = Math.min(minDrop, prev - v);
      maxRise = Math.max(maxRise, b.position.y - 0.25);
      prev = v;
    });
    expect(body(w, id).position.x).toBeGreaterThan(-1);
    // Mixed friction sqrt(0.2 * 0.6) removes mu * g * dt = 0.057 m/s per
    // frame; a snag on a seam would show up as a larger drop.
    const expected = Math.sqrt(0.2 * 0.6) * 9.81 * DT;
    expect(maxDrop).toBeLessThan(expected * 1.05);
    expect(minDrop).toBeGreaterThan(expected * 0.95);
    expect(maxRise).toBeLessThan(0.002);
  });

  test("a thrown spinning crate lands, tumbles and comes to rest flat", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 0, y: 1.5, z: 0 },
      orientation: quat.normalize({ x: 0.3, y: 0.2, z: 0.1, w: 1 }),
      halfExtents: CRATE.halfExtents,
      mass: 25,
      linearVelocity: { x: 6, y: 2, z: 1 },
      angularVelocity: { x: 4, y: -2, z: 8 },
    });
    run(w, 6);
    const b = body(w, id);
    expect(b.asleep).toBe(true);
    expect(b.position.y).toBeCloseTo(0.4, 2);
    // Resting on a face: some local axis is vertical.
    const axes = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    ].map((a) => Math.abs(quat.rotate(b.orientation, a).y));
    expect(Math.max(...axes)).toBeGreaterThan(0.999);
    expect(Math.hypot(b.position.x, b.position.z)).toBeGreaterThan(1);
  });

  test("a box resting on a tilted box does not slide when friction holds it", () => {
    const w = floorWorld();
    // A long plank leaning on a static block makes a ~14 degree slope.
    w.addStatic({
      min: { x: 1.5, y: 0, z: -1 },
      max: { x: 2.5, y: 0.5, z: 1 },
    });
    const angle = Math.atan2(0.5, 2);
    const plank = w.addBody({
      position: { x: 0.75, y: 0.3, z: 0 },
      orientation: quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, angle),
      halfExtents: { x: 1.2, y: 0.05, z: 0.5 },
      mass: 20,
    });
    run(w, 2);
    const p = body(w, plank);
    const up = quat.rotate(p.orientation, { x: 0, y: 1, z: 0 });
    const top = {
      x: p.position.x + up.x * 0.3,
      y: p.position.y + up.y * 0.3,
      z: 0,
    };
    const box = w.addBody({
      position: top,
      orientation: p.orientation,
      halfExtents: { x: 0.25, y: 0.25, z: 0.25 },
      mass: 8,
    });
    run(w, 3);
    const b = body(w, box);
    expect(Math.hypot(b.position.x - top.x, b.position.y - top.y)).toBeLessThan(
      0.03,
    );
    expect(b.asleep).toBe(true);
  });
});

describe("kinematics", () => {
  test("a moving kinematic box pushes a body and wakes it", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 1, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    const k = w.addKinematic({
      min: { x: -1, y: 0, z: -1 },
      max: { x: 0, y: 2, z: 1 },
    });
    run(w, 2);
    expect(body(w, id).asleep).toBe(true);
    let maxSpeed = 0;
    for (let f = 0; f < 120; f++) {
      w.moveKinematic(k, { x: -1 + (f + 1) * (1.5 / 60), y: 0, z: -1 });
      w.step(DT);
      maxSpeed = Math.max(maxSpeed, speed(w, id));
      const b = body(w, id);
      // Never buried in the pusher.
      expect(b.position.x - 0.4).toBeGreaterThan(
        -1 + (f + 1) * (1.5 / 60) + 1 - 0.03,
      );
    }
    // The pusher ends at x = 3, so the crate's centre is just past 3.4.
    expect(body(w, id).position.x).toBeGreaterThan(3.38);
    expect(maxSpeed).toBeLessThan(3);
  });

  test("a door closing on a crate against a wall neither launches nor buries it", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 1, y: 0, z: -2 }, max: { x: 1.5, y: 3, z: 2 } });
    const id = w.addBody({
      position: { x: 0.55, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    const door = w.addKinematic({
      min: { x: -1.5, y: 0, z: -1 },
      max: { x: -1.4, y: 2.5, z: 1 },
    });
    let maxSpeed = 0;
    let maxX = -Infinity;
    for (let f = 0; f < 240; f++) {
      const x = Math.min(0.9, -1.5 + (f + 1) * 0.02);
      w.moveKinematic(door, { x, y: 0, z: -1 });
      w.step(DT);
      maxSpeed = Math.max(maxSpeed, speed(w, id));
      maxX = Math.max(maxX, body(w, id).position.x);
    }
    expect(maxSpeed).toBeLessThan(4);
    // The crate stays out of the wall (its face at most 2 cm inside).
    expect(maxX + 0.4).toBeLessThan(1.02);
    const b = body(w, id);
    expect(Number.isFinite(b.position.x)).toBe(true);
    expect(Math.abs(b.position.z)).toBeLessThan(1);
  });

  test("a kinematic lift carries a crate up", () => {
    const w = floorWorld();
    const lift = w.addKinematic({
      min: { x: -1, y: 0, z: -1 },
      max: { x: 1, y: 0.2, z: 1 },
    });
    const id = w.addBody({
      position: { x: 0, y: 0.6, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    run(w, 1);
    for (let f = 0; f < 120; f++) {
      w.moveKinematic(lift, { x: -1, y: (f + 1) * (1 / 60), z: -1 });
      w.step(DT);
    }
    run(w, 1);
    expect(body(w, id).position.y).toBeCloseTo(2.6, 2);
  });
});

describe("held body pattern", () => {
  test("a velocity-driven body pressed into a wall stays outside it and calm", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: 2, y: 0, z: -3 }, max: { x: 2.2, y: 3, z: 3 } });
    const id = w.addBody({
      position: { x: 0, y: 1.2, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    const target = { x: 3, y: 1.2, z: 0 }; // inside/behind the wall
    let maxX = -Infinity;
    let maxAngular = 0;
    for (let f = 0; f < 300; f++) {
      const b = body(w, id);
      const k = 10;
      const v = {
        x: Math.max(-10, Math.min(10, (target.x - b.position.x) * k)),
        y: (target.y - b.position.y) * k,
        z: (target.z - b.position.z) * k,
      };
      w.setBodyVelocity(id, v, { x: 0, y: 0, z: 0 });
      // The carrying player stands behind it and ignores it.
      w.moveCharacter(
        { x: -1, y: 0.9, z: 0 },
        { x: 0.3, y: 0.9, z: 0.3 },
        { x: 0, y: -0.2, z: 0 },
        DT,
        { ignoreBody: id },
      );
      w.step(DT);
      maxX = Math.max(maxX, body(w, id).position.x);
      const a = body(w, id).angularVelocity;
      maxAngular = Math.max(maxAngular, Math.hypot(a.x, a.y, a.z));
    }
    expect(maxX + 0.4).toBeLessThan(2.02);
    expect(maxAngular).toBeLessThan(1);
    const final = body(w, id);
    expect(final.position.x).toBeGreaterThan(1.5);
    expect(Math.abs(final.position.y - 1.2)).toBeLessThan(0.1);
  });

  test("a velocity-driven body shoves another body without exploding", () => {
    const w = floorWorld();
    const other = w.addBody({
      position: { x: 1.5, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    const held = w.addBody({
      position: { x: 0, y: 0.6, z: 0 },
      halfExtents: PROP_SPECS.crate_wood_small.halfExtents,
      mass: 8,
    });
    let maxSpeed = 0;
    for (let f = 0; f < 180; f++) {
      const b = body(w, held);
      w.setBodyVelocity(
        held,
        {
          x: Math.min(4, (2.5 - b.position.x) * 10),
          y: (0.6 - b.position.y) * 10,
          z: -b.position.z * 10,
        },
        { x: 0, y: 0, z: 0 },
      );
      w.step(DT);
      maxSpeed = Math.max(maxSpeed, speed(w, other));
    }
    expect(body(w, other).position.x).toBeGreaterThan(1.8);
    expect(maxSpeed).toBeLessThan(6);
  });
});

describe("queries", () => {
  test("raycast hits statics, kinematics and rotated bodies", () => {
    const w = createPhysicsWorld();
    w.addStatic({ min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 0, z: 5 } });
    const k = w.addKinematic({
      min: { x: 3, y: 0, z: -1 },
      max: { x: 3.5, y: 2, z: 1 },
    });
    const b = w.addBody({
      position: { x: 0, y: 1, z: -3 },
      orientation: quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4),
      halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
      mass: 10,
    });

    const down = w.raycast({ x: 1, y: 2, z: 1 }, { x: 0, y: -1, z: 0 }, 10);
    expect(down?.collider).toEqual({ kind: "static", id: 0 });
    expect(down?.distance).toBeCloseTo(2, 6);
    expect(down?.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(down?.point.y).toBeCloseTo(0, 6);

    const side = w.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
    expect(side?.collider).toEqual({ kind: "kinematic", id: k });
    expect(side?.distance).toBeCloseTo(3, 6);
    expect(side?.normal.x).toBeCloseTo(-1, 6);

    // The 45-degree box presents an edge to a ray along -Z: hit at
    // z = -3 + 0.5*sqrt(2).
    const edge = w.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 10);
    expect(edge?.collider).toEqual({ kind: "body", id: b });
    expect(edge?.distance).toBeCloseTo(3 - 0.5 * Math.SQRT2, 6);
    // Off-centre ray hits a face whose normal is diagonal.
    const face = w.raycast({ x: 0.3, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 10);
    expect(face?.normal.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(face?.normal.z).toBeCloseTo(Math.SQRT1_2, 5);
    expect(face?.point.z).toBeCloseTo(-3 + 0.5 * Math.SQRT2 - 0.3, 5);

    const ignored = w.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 10, {
      ignoreBody: b,
    });
    expect(ignored).toBeNull();
    expect(
      w.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 2),
    ).toBeNull();
    // Rays starting inside a box ignore it.
    const inside = w.raycast({ x: 0, y: -0.5, z: 0 }, { x: 0, y: 1, z: 0 }, 10);
    expect(inside).toBeNull();
  });

  test("overlapBox reports every kind of collider", () => {
    const w = createPhysicsWorld();
    w.addStatic({ min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 0, z: 5 } });
    w.addStatic({ min: { x: 10, y: -1, z: -5 }, max: { x: 15, y: 0, z: 5 } });
    const k = w.addKinematic({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    });
    const b = w.addBody({
      position: { x: -1, y: 0.5, z: 0 },
      halfExtents: { x: 0.25, y: 0.25, z: 0.25 },
      mass: 5,
    });
    const refs = w.overlapBox({
      min: { x: -2, y: -0.5, z: -1 },
      max: { x: 0.5, y: 1, z: 1 },
    });
    expect(refs).toEqual([
      { kind: "static", id: 0 },
      { kind: "kinematic", id: k },
      { kind: "body", id: b },
    ]);
  });

  test("bodies() snapshots are fresh objects", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 0, y: 1, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
      tag: "crate_wood",
    });
    const a = w.bodies()[0];
    a.position.y = 99;
    expect(body(w, id).position.y).toBe(1);
    expect(a.tag).toBe("crate_wood");
    expect(a.mass).toBe(25);
    expect(body(w, id).halfExtents).toEqual(CRATE.halfExtents);
  });
});

describe("contact events", () => {
  function dropImpacts(height: number): {
    count: number;
    impulse: number;
    restingEvents: number;
  } {
    const w = floorWorld();
    w.addBody({
      position: { x: 0, y: 0.4 + height, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
      restitution: 0,
    });
    let count = 0;
    let impulse = 0;
    run(w, 1.5, () => {
      for (const e of w.drainContacts()) {
        count++;
        impulse = Math.max(impulse, e.impulse);
        expect(e.a).toEqual({ kind: "body", id: 0 });
        expect(e.b).toEqual({ kind: "static", id: 0 });
        expect(e.normal.y).toBeCloseTo(-1, 5);
        expect(e.point.y).toBeCloseTo(0, 1);
      }
    });
    let restingEvents = 0;
    run(w, 2, () => {
      restingEvents += w.drainContacts().length;
    });
    return { count, impulse, restingEvents };
  }

  test("fire once per impact with an impulse that grows with speed, and not while resting", () => {
    const low = dropImpacts(0.5);
    const high = dropImpacts(2);
    expect(low.count).toBe(1);
    expect(high.count).toBe(1);
    // Momentum at impact: m * sqrt(2 g h).
    expect(low.impulse).toBeGreaterThan(25 * Math.sqrt(2 * 9.81 * 0.5) * 0.9);
    expect(high.impulse).toBeGreaterThan(low.impulse * 1.6);
    expect(low.restingEvents).toBe(0);
    expect(high.restingEvents).toBe(0);
  });

  test("a body pushed sideways while resting does not spam events", () => {
    const w = floorWorld();
    const id = w.addBody({
      position: { x: 0, y: 0.4, z: 0 },
      halfExtents: CRATE.halfExtents,
      mass: 25,
    });
    run(w, 1);
    w.drainContacts();
    let events = 0;
    for (let f = 0; f < 120; f++) {
      w.setBodyVelocity(id, { x: 1, y: body(w, id).linearVelocity.y, z: 0 });
      w.step(DT);
      events += w.drainContacts().length;
    }
    expect(events).toBe(0);
  });
});

describe("determinism and performance", () => {
  function scene(): PhysicsWorld {
    const w = floorWorld();
    for (let i = 0; i < 12; i++) {
      w.addBody({
        position: {
          x: (i % 4) * 0.3,
          y: 0.5 + i * 0.9,
          z: Math.floor(i / 4) * 0.2,
        },
        orientation: quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, i * 0.3),
        halfExtents: CRATE.halfExtents,
        mass: 25,
        angularVelocity: { x: 0.1 * i, y: 0, z: 0 },
      });
    }
    return w;
  }

  test("two identical runs give identical results", () => {
    const a = scene();
    const b = scene();
    run(a, 4);
    run(b, 4);
    expect(a.bodies()).toEqual(b.bodies());
  });

  test("60 bodies among 300 statics step quickly", () => {
    const w = createPhysicsWorld();
    // 20 x 15 floor tiles of 2 m.
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 15; j++) {
        w.addStatic({
          min: { x: i * 2, y: -0.5, z: j * 2 },
          max: { x: i * 2 + 2, y: 0, z: j * 2 + 2 },
        });
      }
    }
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) {
      const col = i % 20;
      const row = Math.floor(i / 20);
      // Piles of three in places, single crates elsewhere.
      ids.push(
        w.addBody({
          position: {
            x: 2 + col * 1.8,
            y: 0.4 + row * 0.81,
            z: 5 + (row > 0 ? 0 : (col % 3) * 0.1),
          },
          halfExtents: CRATE.halfExtents,
          mass: 25,
        }),
      );
    }
    run(w, 4);
    expect(w.bodies().filter((b) => b.asleep).length).toBe(60);
    let t0 = performance.now();
    run(w, 2);
    const asleepMs = (performance.now() - t0) / 120;
    // Wake 20 by throwing them.
    for (let i = 0; i < 20; i++) {
      w.setBodyVelocity(
        ids[i + 40],
        { x: 0, y: 4, z: 2 },
        { x: 1, y: 2, z: 0 },
      );
    }
    t0 = performance.now();
    run(w, 1);
    const awakeMs = (performance.now() - t0) / 60;
    console.log(
      `step: ${asleepMs.toFixed(3)} ms asleep, ${awakeMs.toFixed(3)} ms with 20+ awake`,
    );
    expect(asleepMs).toBeLessThan(2);
    expect(awakeMs).toBeLessThan(8);
  });

  test("a heap of 60 mixed props in a pen settles, stays in and sleeps", () => {
    const w = floorWorld();
    w.addStatic({
      min: { x: -2.2, y: 0, z: -2.2 },
      max: { x: -2, y: 6, z: 2.2 },
    });
    w.addStatic({
      min: { x: 2, y: 0, z: -2.2 },
      max: { x: 2.2, y: 6, z: 2.2 },
    });
    w.addStatic({
      min: { x: -2.2, y: 0, z: -2.2 },
      max: { x: 2.2, y: 6, z: -2 },
    });
    w.addStatic({
      min: { x: -2.2, y: 0, z: 2 },
      max: { x: 2.2, y: 6, z: 2.2 },
    });
    const specs = Object.values(PROP_SPECS);
    const axis = { x: 0.6, y: 0.64, z: 0.48 };
    for (let i = 0; i < 60; i++) {
      const spec = specs[i % specs.length];
      w.addBody({
        position: {
          x: ((i % 4) - 1.5) * 0.95,
          y: 1 + Math.floor(i / 16) + (i % 3) * 0.05,
          z: ((Math.floor(i / 4) % 4) - 1.5) * 0.95,
        },
        orientation: quat.fromAxisAngle(axis, i * 0.7),
        halfExtents: spec.halfExtents,
        mass: spec.mass,
      });
    }
    const t0 = performance.now();
    run(w, 6);
    const avgMs = (performance.now() - t0) / 360;
    console.log(`heap of 60: ${avgMs.toFixed(3)} ms per step over 6 s`);
    const all = w.bodies();
    expect(all.every((b) => b.asleep)).toBe(true);
    expect(
      all.every(
        (b) =>
          Math.abs(b.position.x) < 2 &&
          Math.abs(b.position.z) < 2 &&
          b.position.y > 0.15,
      ),
    ).toBe(true);
    expect(avgMs).toBeLessThan(4);
  });
});
