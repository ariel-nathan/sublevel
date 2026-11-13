import { describe, expect, test } from "bun:test";
import type { PhysicsWorld } from "../core/api";
import {
  addProp,
  DT,
  floorWorld,
  horizontalSpeed,
  idle,
  PLAYER,
  sim,
} from "./harness.test-util";
import * as T from "./tuning";

const PLAYER_MASS = 80;

/** A 20 x 20 m platform, 0.2 m thick, with its top at y = 0.2. */
function platformWorld(): { w: PhysicsWorld; plat: number } {
  const w = floorWorld();
  const plat = w.addKinematic({
    min: { x: -10, y: 0, z: -10 },
    max: { x: 10, y: 0.2, z: 10 },
  });
  return { w, plat };
}

describe("riding moving ground", () => {
  test("a platform moving at 1.5 m/s carries the player exactly, without camera jitter", () => {
    const { w, plat } = platformWorld();
    const s = sim(w, { x: 0, y: 0.2, z: 0 });
    s.run(20);
    expect(s.player.standingOn).toEqual({ kind: "kinematic", id: plat });
    const x0 = s.player.feet.x;
    let px = 0;
    let lastCam = s.player.camera(1).position;
    const camDx: number[] = [];
    const camDy: number[] = [];
    s.run(120, idle(), () => {
      px += 1.5 * DT;
      w.moveKinematic(plat, { x: -10 + px, y: 0, z: -10 });
      const cam = s.player.camera(1).position;
      camDx.push(cam.x - lastCam.x);
      camDy.push(cam.y - lastCam.y);
      lastCam = cam;
      expect(s.player.onGround).toBe(true);
    });
    // Carried with the platform (within 5 cm over 2 s).
    expect(Math.abs(s.player.feet.x - x0 - px)).toBeLessThan(0.05);
    expect(Math.abs(s.player.feet.z)).toBeLessThan(1e-6);
    expect(s.player.feet.y).toBeCloseTo(0.2, 2);
    // Steady motion of the eye: same advance every step after the first two.
    for (let i = 2; i < camDx.length; i++) {
      expect(Math.abs(camDx[i] - 1.5 * DT)).toBeLessThan(1e-4);
      expect(Math.abs(camDy[i])).toBeLessThan(1e-4);
    }
    // The player's velocity reads as its velocity in the world.
    expect(s.player.velocity.x).toBeCloseTo(1.5, 3);
    // Standing still on it makes no footsteps.
    expect(s.events.filter((e) => e.type === "footstep")).toHaveLength(0);
  });

  test("walking on a moving platform is relative to it", () => {
    const { w, plat } = platformWorld();
    const s = sim(w, { x: 0, y: 0.2, z: 5 });
    s.run(20);
    let px = 0;
    const move = () => {
      px += 1.5 * DT;
      w.moveKinematic(plat, { x: -10 + px, y: 0, z: -10 });
    };
    s.run(30, idle(), move);
    const start = s.player.feet;
    const startPx = px;
    // Yaw 0 walks along -Z, across the platform's motion.
    s.run(60, idle({ moveZ: 1 }), move);
    const v = s.player.velocity;
    expect(v.x).toBeCloseTo(1.5, 2);
    expect(v.z).toBeCloseTo(-T.RUN_SPEED, 2);
    expect(Math.abs(s.player.feet.x - start.x - (px - startPx))).toBeLessThan(
      0.05,
    );
    expect(start.z - s.player.feet.z).toBeGreaterThan(T.RUN_SPEED * 0.9);
    // Footsteps follow the distance walked on the platform, not the ride.
    const steps = s.events.filter((e) => e.type === "footstep").length;
    expect(steps).toBeLessThanOrEqual(
      Math.ceil(T.RUN_SPEED / T.FOOTSTEP_STRIDE) + 1,
    );
  });

  test("a lift going up and down keeps the player grounded, even when it reverses", () => {
    const w = floorWorld();
    const lift = w.addKinematic({
      min: { x: -2, y: 0, z: -2 },
      max: { x: 2, y: 0.2, z: 2 },
    });
    const s = sim(w, { x: 0, y: 0.2, z: 0 });
    s.run(20);
    let y = 0;
    let t = 0;
    let maxCamError = 0;
    let maxFeetError = 0;
    // Up 1.5 m at 1 m/s, down again, and so on: several reversals.
    s.run(300, idle(), (_f, ev) => {
      // Where the lift was during this step.
      maxFeetError = Math.max(
        maxFeetError,
        Math.abs(s.player.feet.y - (0.2 + y)),
      );
      t += DT;
      const phase = t % 3;
      y = phase < 1.5 ? phase : 3 - phase;
      w.moveKinematic(lift, { x: -2, y, z: -2 });
      expect(s.player.onGround).toBe(true);
      expect(ev.filter((e) => e.type === "land" || e.type === "jump")).toEqual(
        [],
      );
      const cam = s.player.camera(1).position.y;
      maxCamError = Math.max(
        maxCamError,
        Math.abs(cam - s.player.feet.y - PLAYER.eyeHeight),
      );
    });
    // The feet stay on the lift.
    expect(maxFeetError).toBeLessThan(0.005);
    // The eye stays at eye height above the feet: no smoothing lag or bounce.
    expect(maxCamError).toBeLessThan(0.005);
    expect(Math.abs(s.player.velocity.y)).toBeLessThan(1e-9);
  });

  test("jumping off a moving platform keeps its horizontal velocity", () => {
    const { w, plat } = platformWorld();
    const s = sim(w, { x: 0, y: 0.2, z: 0 });
    s.run(20);
    let px = 0;
    const move = () => {
      px += 1.5 * DT;
      w.moveKinematic(plat, { x: -10 + px, y: 0, z: -10 });
    };
    s.run(30, idle(), move);
    const relBefore = s.player.feet.x - px;
    s.run(1, idle({ jump: true }), move);
    expect(s.player.onGround).toBe(false);
    let airborne = 0;
    s.run(60, idle(), () => {
      move();
      if (!s.player.onGround) {
        airborne++;
        expect(s.player.velocity.x).toBeCloseTo(1.5, 6);
      }
    });
    expect(airborne).toBeGreaterThan(10);
    expect(s.player.onGround).toBe(true);
    // Landed where it took off, relative to the platform.
    expect(Math.abs(s.player.feet.x - px - relBefore)).toBeLessThan(0.06);
  });

  test("walking off a moving platform keeps its momentum", () => {
    const w = floorWorld();
    const plat = w.addKinematic({
      min: { x: -1, y: 0.5, z: -1 },
      max: { x: 1, y: 0.7, z: 1 },
    });
    const s = sim(w, { x: 0, y: 0.7, z: 0 });
    s.run(20);
    let px = 0;
    const move = () => {
      px += 1.5 * DT;
      w.moveKinematic(plat, { x: -1 + px, y: 0.5, z: -1 });
    };
    s.run(20, idle(), move);
    // Walk off its -Z edge (yaw 0 walks along -Z).
    let airborne = 0;
    s.run(40, idle({ moveZ: 1 }), () => {
      move();
      if (!s.player.onGround) {
        airborne++;
        expect(s.player.velocity.x).toBeCloseTo(1.5, 6);
      }
    });
    expect(airborne).toBeGreaterThan(3);
  });

  test("standing on a heavy sliding crate carries the player", () => {
    const w = floorWorld();
    const crate = addProp(w, "crate_metal", 0, 0);
    const s = sim(w, { x: 0, y: 0.7, z: 0 });
    s.run(30);
    expect(s.player.standingOn).toEqual({ kind: "body", id: crate });
    w.setBodyVelocity(crate, { x: 3, y: 0, z: 0 });
    const c0 = w.getBody(crate)!.position.x;
    const p0 = s.player.feet.x;
    let maxGap = 0;
    s.run(90, idle(), () => {
      const c = w.getBody(crate)!.position.x - c0;
      maxGap = Math.max(maxGap, Math.abs(s.player.feet.x - p0 - c));
      expect(s.player.standingOn).toEqual({ kind: "body", id: crate });
    });
    expect(w.getBody(crate)!.position.x - c0).toBeGreaterThan(0.3);
    expect(maxGap).toBeLessThan(0.05);
  });

  test("standing still on a resting crate changes nothing", () => {
    const w = floorWorld();
    const crate = addProp(w, "crate_wood", 0.1, -0.1);
    const s = sim(w, { x: 0, y: 0.8, z: 0 });
    s.run(30);
    const feet = s.player.feet;
    s.run(300);
    expect(Math.abs(s.player.feet.x - feet.x)).toBeLessThan(1e-3);
    expect(Math.abs(s.player.feet.z - feet.z)).toBeLessThan(1e-3);
    expect(horizontalSpeed(s.player.velocity)).toBe(0);
    const b = w.getBody(crate)!;
    expect(Math.hypot(b.position.x - 0.1, b.position.z + 0.1)).toBeLessThan(
      0.005,
    );
  });

  test("surfing a sliding crate gains no energy, idle or walking on it", () => {
    for (const moveZ of [0, 1]) {
      const w = floorWorld();
      const crate = addProp(w, "crate_wood", 0, 0);
      // Yaw -pi/2 faces +X: walking forward goes with the crate's motion.
      const s = sim(w, { x: 0, y: 0.8, z: 0 }, -Math.PI / 2);
      s.run(30);
      w.setBodyVelocity(crate, { x: 3, y: 0, z: 0 });
      // One step to pick up the ride; from then on nothing may gain energy.
      s.run(1);
      const energy = () => {
        const b = w.getBody(crate)!;
        const v = b.linearVelocity;
        const pv = s.player.velocity;
        return (
          0.5 * b.mass * (v.x * v.x + v.y * v.y + v.z * v.z) +
          0.5 * PLAYER_MASS * (pv.x * pv.x + pv.z * pv.z)
        );
      };
      const e0 = energy();
      let prevCrateSpeed = 3;
      let maxCrateSpeed = 0;
      s.run(120, idle({ moveZ: moveZ * 0.3 }), () => {
        const v = w.getBody(crate)!.linearVelocity;
        const sp = Math.hypot(v.x, v.z);
        maxCrateSpeed = Math.max(maxCrateSpeed, sp);
        expect(sp).toBeLessThan(prevCrateSpeed + 0.01);
        prevCrateSpeed = sp;
        if (s.player.onGround) {
          // Never faster than the crate plus its own walking speed.
          expect(horizontalSpeed(s.player.velocity)).toBeLessThan(
            sp + T.RUN_SPEED * 0.3 + 0.05,
          );
        }
        if (moveZ === 0) {
          // The player only rides; total kinetic energy never grows.
          expect(energy()).toBeLessThan(e0 * 1.01);
        }
      });
      expect(maxCrateSpeed).toBeLessThan(3.01);
      expect(prevCrateSpeed).toBeLessThan(0.05);
    }
  });

  test("light props are not ridden", () => {
    const w = floorWorld();
    const crate = addProp(w, "crate_wood_small", 0, 0);
    const s = sim(w, { x: 0, y: 0.5, z: 0 });
    s.run(30);
    expect(s.player.standingOn).toEqual({ kind: "body", id: crate });
    w.setBodyVelocity(crate, { x: 2, y: 0, z: 0 });
    s.run(1);
    expect(s.player.velocity.x).toBe(0);
  });
});
