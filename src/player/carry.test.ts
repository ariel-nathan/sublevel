import { describe, expect, test } from "bun:test";
import type { PlayerEvent } from "../core/api";
import { PROP_SPECS } from "../core/props";
import { quat, v3, type Vec3 } from "../math";
import {
  addProp,
  floorWorld,
  horizontalSpeed,
  idle,
  PLAYER,
  sim,
} from "./harness.test-util";
import * as T from "./tuning";

/** Pixels of mouse-down movement that pitch the view by `angle` radians. */
const pitchPixels = (angle: number) => -angle / T.LOOK_SENSITIVITY;

function eyeForward(s: ReturnType<typeof sim>): { eye: Vec3; fwd: Vec3 } {
  const cam = s.player.camera(1);
  return {
    eye: cam.position,
    fwd: quat.rotate(cam.orientation, { x: 0, y: 0, z: -1 }),
  };
}

/** A player at the origin facing a 25 kg crate 1.3 m ahead, looking down at it. */
function crateScene(kind: keyof typeof PROP_SPECS = "crate_wood") {
  const w = floorWorld();
  const crate = addProp(w, kind, 0, -1.3);
  const s = sim(w);
  s.run(30, (f) => idle({ lookDy: f === 0 ? pitchPixels(-0.7) : 0 }));
  return { w, s, crate };
}

describe("picking up", () => {
  test("picks up a 25 kg crate in reach and aims at it", () => {
    const { s, crate } = crateScene();
    expect(s.player.aim?.collider).toEqual({ kind: "body", id: crate });
    const ev = s.run(1, idle({ usePressed: true }));
    expect(ev).toEqual([{ type: "pickup", body: crate }]);
    expect(s.player.heldBody).toBe(crate);
    // While holding, the aim ignores the held body.
    s.run(30);
    expect(
      s.player.aim?.collider.id === crate &&
        s.player.aim?.collider.kind === "body",
    ).toBe(false);
  });

  test("cannot pick up a 60 kg crate: use is emitted with the hit", () => {
    const { s, crate } = crateScene("crate_metal");
    const ev = s.run(1, idle({ usePressed: true }));
    expect(ev).toHaveLength(1);
    const e = ev[0];
    expect(e.type).toBe("use");
    if (e.type !== "use") throw new Error();
    expect(e.hit?.collider).toEqual({ kind: "body", id: crate });
    expect(s.player.heldBody).toBeNull();
  });

  test("use with nothing in reach emits use with a null hit", () => {
    const s = sim(floorWorld());
    s.run(5);
    expect(s.run(1, idle({ usePressed: true }))).toEqual([
      { type: "use", hit: null },
    ]);
    expect(s.player.aim).toBeNull();
  });

  test("use on a wall emits use with the wall hit", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: -3, y: 0, z: -2 }, max: { x: 3, y: 3, z: -1.5 } });
    const s = sim(w);
    s.run(5);
    const ev = s.run(1, idle({ usePressed: true }));
    expect(ev).toHaveLength(1);
    if (ev[0].type !== "use") throw new Error();
    expect(ev[0].hit?.collider).toEqual({ kind: "static", id: 1 });
    expect(ev[0].hit?.distance).toBeCloseTo(1.5, 2);
  });
});

describe("carrying", () => {
  test("carries a crate while walking and turning, then drops it", () => {
    const { w, s, crate } = crateScene();
    s.run(1, idle({ usePressed: true }));
    s.run(40);
    const start = s.player.feet;
    let maxError = 0;
    let maxSpin = 0;
    let maxSpeed = 0;
    // Walk forward and turn left at ~1.3 rad/s for 3 s.
    s.run(180, idle({ moveZ: 1, lookDx: -10 }), (f) => {
      const b = w.getBody(crate)!;
      const { eye, fwd } = eyeForward(s);
      const toBody = v3.sub(b.position, eye);
      const ahead = v3.dot(toBody, fwd);
      const off = v3.length(v3.sub(toBody, v3.scale(fwd, ahead)));
      if (f > 30) {
        maxError = Math.max(maxError, off, Math.abs(ahead - 1.25));
      }
      maxSpin = Math.max(maxSpin, v3.length(b.angularVelocity));
      maxSpeed = Math.max(maxSpeed, v3.length(b.linearVelocity));
    });
    expect(s.player.heldBody).toBe(crate);
    expect(maxError).toBeLessThan(0.35);
    expect(maxSpin).toBeLessThan(T.HOLD_MAX_ANGULAR);
    expect(maxSpeed).toBeLessThan(T.RUN_SPEED + T.HOLD_MAX_SPEED);
    // The player was not pushed around: it ran at full speed on a curve
    // (turning on the ground keeps a little sideways speed, as in the genre).
    expect(horizontalSpeed(s.player.velocity)).toBeGreaterThan(
      T.RUN_SPEED - 0.1,
    );
    expect(horizontalSpeed(s.player.velocity)).toBeLessThan(T.RUN_SPEED + 0.3);
    expect(v3.distance(start, s.player.feet)).toBeGreaterThan(8);
    expect(s.player.feet.y).toBeLessThan(0.01);
    // Drop: keeps its own velocity, falls to the floor.
    const ev = s.run(1, idle({ usePressed: true }));
    expect(ev).toEqual([{ type: "drop", body: crate }]);
    expect(s.player.heldBody).toBeNull();
    s.run(120);
    expect(w.getBody(crate)!.position.y).toBeCloseTo(
      PROP_SPECS.crate_wood.halfExtents.y,
      1,
    );
  });

  test("the held prop keeps its orientation relative to the view yaw", () => {
    const { w, s, crate } = crateScene();
    s.run(1, idle({ usePressed: true }));
    s.run(30);
    const q0 = w.getBody(crate)!.orientation;
    // Turn 90 degrees to the left over 1 s, then let it settle.
    const pixels = Math.PI / 2 / T.LOOK_SENSITIVITY / 60;
    s.run(60, idle({ lookDx: -pixels }));
    s.run(60);
    const q1 = w.getBody(crate)!.orientation;
    const expected = quat.multiply(
      quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2),
      q0,
    );
    const dot = Math.abs(
      q1.x * expected.x +
        q1.y * expected.y +
        q1.z * expected.z +
        q1.w * expected.w,
    );
    expect(dot).toBeGreaterThan(0.99);
  });

  test("a held body pressed into a wall stays out of it and the hold shortens", () => {
    const w = floorWorld();
    // Wall face at z = -1.0, crate in front of the player.
    w.addStatic({
      min: { x: -3, y: 0, z: -1.5 },
      max: { x: 3, y: 3, z: -1.0 },
    });
    const crate = addProp(w, "crate_wood_small", 1.5, 0);
    const s = sim(w, { x: 0, y: 0, z: 0 });
    // Look at the crate on the right (+X), slightly down.
    s.run(30, (f) =>
      idle({
        lookDx: f === 0 ? Math.PI / 2 / T.LOOK_SENSITIVITY : 0,
        lookDy: f === 0 ? pitchPixels(-0.7) : 0,
      }),
    );
    expect(s.run(1, idle({ usePressed: true }))).toEqual([
      { type: "pickup", body: crate },
    ]);
    // Turn back to face the wall and keep pushing toward it.
    s.run(30, (f) =>
      idle({ lookDx: f === 0 ? -(Math.PI / 2) / T.LOOK_SENSITIVITY : 0 }),
    );
    let maxPenetration = 0;
    s.run(120, idle({ moveZ: 1 }), () => {
      const b = w.getBody(crate)!;
      maxPenetration = Math.max(
        maxPenetration,
        -1.0 - (b.position.z - b.halfExtents.z),
      );
    });
    const b = w.getBody(crate)!;
    expect(s.player.heldBody).toBe(crate);
    expect(maxPenetration).toBeLessThan(0.03);
    // Pulled in: nearer to the eye than the free hold distance.
    const { eye } = eyeForward(s);
    expect(v3.distance(b.position, eye)).toBeLessThan(T.HOLD_DISTANCE - 0.2);
  });

  test("auto-drops silently when the body is removed", () => {
    const { w, s, crate } = crateScene();
    s.run(1, idle({ usePressed: true }));
    s.run(10);
    w.removeBody(crate);
    const ev = s.run(5);
    expect(ev).toEqual([]);
    expect(s.player.heldBody).toBeNull();
  });

  test("auto-drops when stuck far from the hold point", () => {
    const w = floorWorld();
    const crate = addProp(w, "crate_wood", 0, -1.3);
    const s = sim(w);
    s.run(30, (f) => idle({ lookDy: f === 0 ? pitchPixels(-0.7) : 0 }));
    s.run(1, idle({ usePressed: true }));
    s.run(20);
    expect(w.getBody(crate)!.position.z).toBeLessThan(-0.85);
    // A wall appears between the player and the crate; walk away backwards.
    w.addStatic({
      min: { x: -3, y: 0, z: -0.55 },
      max: { x: 3, y: 3, z: -0.45 },
    });
    let dropped: PlayerEvent | undefined;
    s.run(90, idle({ moveZ: -1 }), (_f, ev) => {
      dropped ??= ev.find((e) => e.type === "drop");
    });
    expect(s.player.heldBody).toBeNull();
    expect(dropped).toEqual({ type: "drop", body: crate });
  });

  test("cannot pick up the crate it stands on", () => {
    const w = floorWorld();
    const crate = addProp(w, "crate_wood", 0, 0);
    const s = sim(w, { x: 0, y: 0.81, z: 0 });
    s.run(30, (f) => idle({ lookDy: f === 0 ? 100000 : 0 }));
    expect(s.player.standingOn).toEqual({ kind: "body", id: crate });
    const ev = s.run(1, idle({ usePressed: true }));
    expect(ev[0]?.type).toBe("use");
    expect(s.player.heldBody).toBeNull();
  });

  test("a held prop cannot be stood on to gain height", () => {
    const { s } = crateScene("crate_wood_small");
    s.run(1, idle({ usePressed: true }));
    // Look straight down so the prop is held low, then keep jumping on it.
    s.run(10, (f) => idle({ lookDy: f === 0 ? 100000 : 0 }));
    let maxFeet = 0;
    s.run(
      240,
      (f) => idle({ jump: true, moveZ: f % 60 < 30 ? 0.3 : -0.3 }),
      () => {
        maxFeet = Math.max(maxFeet, s.player.feet.y);
        expect(s.player.standingOn?.kind).not.toBe("body");
      },
    );
    expect(maxFeet).toBeLessThan(PLAYER.jumpHeight + 0.05);
  });

  test("releaseHeld lets go without an event", () => {
    const { s, crate } = crateScene();
    s.run(1, idle({ usePressed: true }));
    expect(s.player.heldBody).toBe(crate);
    s.player.releaseHeld();
    expect(s.player.heldBody).toBeNull();
    expect(s.run(30)).toEqual([]);
  });
});

describe("throwing and shoving", () => {
  function throwSpeedOf(kind: keyof typeof PROP_SPECS): {
    speed: number;
    along: number;
  } {
    const { w, s, crate } = crateScene(kind);
    s.run(1, idle({ usePressed: true }));
    expect(s.player.heldBody).toBe(crate);
    // Level the view and let the hold settle.
    s.run(60, (f) => idle({ lookDy: f === 0 ? pitchPixels(0.7) : 0 }));
    const ev = s.run(1, idle({ primaryPressed: true }));
    expect(ev).toEqual([{ type: "throw", body: crate }]);
    expect(s.player.heldBody).toBeNull();
    const v = w.getBody(crate)!.linearVelocity;
    return { speed: v3.length(v), along: -v.z };
  }

  test("throw speed scales down with mass, along the view", () => {
    const light = throwSpeedOf("crate_wood_small");
    const medium = throwSpeedOf("crate_wood");
    expect(light.along).toBeGreaterThan(9.5);
    expect(light.along).toBeLessThan(12);
    expect(medium.along).toBeLessThan(light.along - 1.5);
    expect(medium.along).toBeGreaterThan(5);
    expect(T.throwSpeed(PLAYER.maxCarryMass)).toBeCloseTo(5, 6);
    expect(T.throwSpeed(PROP_SPECS.crate_wood_small.mass)).toBeCloseTo(11, 6);
  });

  test("a thrown crate flies forward and lands far away", () => {
    const { w, s, crate } = crateScene("crate_wood_small");
    s.run(1, idle({ usePressed: true }));
    s.run(30, (f) => idle({ lookDy: f === 0 ? pitchPixels(0.85) : 0 }));
    s.run(1, idle({ primaryPressed: true }));
    s.run(120);
    expect(w.getBody(crate)!.position.z).toBeLessThan(-6);
  });

  test("shove knocks a resting 25 kg crate", () => {
    const w = floorWorld();
    const crate = addProp(w, "crate_wood", 0, -2);
    const s = sim(w);
    // Aim at the upper part of the crate's front face.
    s.run(30, (f) => idle({ lookDy: f === 0 ? pitchPixels(-0.5) : 0 }));
    expect(s.player.aim?.collider).toEqual({ kind: "body", id: crate });
    const before = w.getBody(crate)!;
    const ev = s.run(1, idle({ primaryPressed: true }));
    expect(ev).toEqual([]);
    const kicked = w.getBody(crate)!;
    expect(v3.length(kicked.linearVelocity)).toBeGreaterThan(1.5);
    s.run(90);
    const after = w.getBody(crate)!;
    expect(before.position.z - after.position.z).toBeGreaterThan(0.3);
    expect(Math.abs(after.position.x)).toBeLessThan(0.05);
    expect(s.player.heldBody).toBeNull();
  });

  test("shove looking down on a crate still moves it", () => {
    const { w, s, crate } = crateScene();
    const before = w.getBody(crate)!.position;
    s.run(1, idle({ primaryPressed: true }));
    s.run(60);
    expect(before.z - w.getBody(crate)!.position.z).toBeGreaterThan(0.1);
  });

  test("shove with nothing aimed at does nothing", () => {
    const s = sim(floorWorld());
    s.run(5);
    expect(s.run(1, idle({ primaryPressed: true }))).toEqual([]);
  });
});
