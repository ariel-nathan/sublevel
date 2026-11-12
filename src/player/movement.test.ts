import { describe, expect, test } from "bun:test";
import type { PlayerEvent } from "../core/api";
import { quat, v3 } from "../math";
import {
  DT,
  floorWorld,
  horizontalSpeed,
  idle,
  PLAYER,
  sim,
} from "./harness.test-util";
import * as T from "./tuning";

describe("ground movement", () => {
  test("settles on the floor at spawn", () => {
    const s = sim(floorWorld());
    s.run(10);
    expect(s.player.onGround).toBe(true);
    expect(s.player.feet.y).toBeGreaterThanOrEqual(0);
    expect(s.player.feet.y).toBeLessThan(0.01);
    expect(s.player.standingOn).toEqual({ kind: "static", id: 0 });
  });

  test("reaches run speed within 0.25 s and stops within 0.3 s", () => {
    const s = sim(floorWorld());
    s.run(5);
    s.run(15, idle({ moveZ: 1 }));
    expect(horizontalSpeed(s.player.velocity)).toBeGreaterThan(
      T.RUN_SPEED * 0.97,
    );
    s.run(30, idle({ moveZ: 1 }));
    expect(horizontalSpeed(s.player.velocity)).toBeCloseTo(T.RUN_SPEED, 3);
    // Yaw 0 runs along -Z.
    expect(s.player.velocity.z).toBeLessThan(-5);
    s.run(18);
    expect(horizontalSpeed(s.player.velocity)).toBe(0);
  });

  test("diagonal speed equals straight speed", () => {
    const s = sim(floorWorld());
    s.run(5);
    s.run(60, idle({ moveX: 1, moveZ: 1 }));
    expect(horizontalSpeed(s.player.velocity)).toBeCloseTo(T.RUN_SPEED, 3);
    expect(s.player.velocity.x).toBeCloseTo(-s.player.velocity.z, 3);
  });

  test("crouched movement is slower", () => {
    const s = sim(floorWorld());
    s.run(5);
    s.run(60, idle({ moveZ: 1, crouch: true }));
    expect(horizontalSpeed(s.player.velocity)).toBeCloseTo(T.CROUCH_SPEED, 3);
  });

  test("walks up a 0.25 m step and is blocked by a 0.5 m one", () => {
    const w = floorWorld();
    w.addStatic({
      min: { x: -1, y: 0, z: -12 },
      max: { x: 1, y: 0.25, z: -2 },
    });
    w.addStatic({ min: { x: 4, y: 0, z: -4 }, max: { x: 6, y: 0.5, z: -2 } });
    const low = sim(w, { x: 0, y: 0, z: 0 });
    low.run(60, idle({ moveZ: 1 }));
    expect(low.player.feet.z).toBeLessThan(-2.5);
    expect(low.player.feet.y).toBeCloseTo(0.25, 2);
    const high = sim(w, { x: 5, y: 0, z: 0 });
    high.run(60, idle({ moveZ: 1 }));
    expect(high.player.feet.z).toBeGreaterThan(-2);
    expect(high.player.feet.y).toBeLessThan(0.01);
  });

  test("the camera eye glides up a step instead of popping", () => {
    const w = floorWorld();
    w.addStatic({
      min: { x: -1, y: 0, z: -12 },
      max: { x: 1, y: 0.25, z: -2 },
    });
    const s = sim(w);
    let maxJump = 0;
    let last = s.player.camera(1).position.y;
    s.run(60, idle({ moveZ: 1 }), () => {
      const y = s.player.camera(1).position.y;
      maxJump = Math.max(maxJump, Math.abs(y - last));
      last = y;
    });
    expect(s.player.feet.y).toBeCloseTo(0.25, 2);
    expect(maxJump).toBeLessThan(0.1);
    expect(last).toBeCloseTo(0.25 + PLAYER.eyeHeight, 1);
  });
});

/** Runs toward -Z, jumps when `jumpAtZ` is passed, returns final feet. */
function ledgeAttempt(ledgeHeight: number, crouchJump: boolean) {
  const w = floorWorld();
  // Ledge face at z = -3.
  w.addStatic({
    min: { x: -3, y: 0, z: -8 },
    max: { x: 3, y: ledgeHeight, z: -3 },
  });
  const s = sim(w, { x: 0, y: 0, z: 2 });
  s.run(5);
  let jumped = false;
  s.run(120, () => {
    const p = s.player;
    const jump = !jumped && p.feet.z < -1.35 && p.onGround;
    if (jump) {
      jumped = true;
    }
    return idle({ moveZ: 1, jump, crouch: crouchJump && jumped });
  });
  return s.player;
}

describe("jumping", () => {
  test("jump apex is PLAYER.jumpHeight", () => {
    const s = sim(floorWorld());
    s.run(5);
    let apex = 0;
    const events: PlayerEvent[] = [];
    s.run(
      60,
      (f) => idle({ jump: f === 0 }),
      (_f, ev) => {
        apex = Math.max(apex, s.player.feet.y);
        events.push(...ev);
      },
    );
    expect(apex).toBeGreaterThan(PLAYER.jumpHeight - 0.05);
    expect(apex).toBeLessThan(PLAYER.jumpHeight + 0.05);
    expect(events.filter((e) => e.type === "jump")).toHaveLength(1);
    expect(s.player.onGround).toBe(true);
  });

  test("gets onto a 0.95 m ledge with a jump", () => {
    const p = ledgeAttempt(0.95, false);
    expect(p.feet.y).toBeCloseTo(0.95, 2);
    expect(p.feet.z).toBeLessThan(-3.2);
  });

  test("does not get onto a 1.25 m ledge with a plain jump", () => {
    const p = ledgeAttempt(1.25, false);
    expect(p.feet.y).toBeLessThan(0.01);
  });

  test("gets onto a 1.25 m ledge with a crouch-jump", () => {
    const p = ledgeAttempt(1.25, true);
    expect(p.feet.y).toBeCloseTo(1.25, 2);
    expect(p.feet.z).toBeLessThan(-3.2);
  });

  test("does not get onto a 1.6 m ledge even with a crouch-jump", () => {
    const p = ledgeAttempt(1.6, true);
    expect(p.feet.y).toBeLessThan(0.01);
  });

  test("hitting a ceiling kills upward speed", () => {
    const w = floorWorld();
    w.addStatic({ min: { x: -2, y: 2.2, z: -2 }, max: { x: 2, y: 2.5, z: 2 } });
    const s = sim(w);
    s.run(5);
    let maxHead = 0;
    s.run(
      40,
      (f) => idle({ jump: f === 0 }),
      () => {
        maxHead = Math.max(maxHead, s.player.box().max.y);
      },
    );
    expect(maxHead).toBeLessThanOrEqual(2.2);
    expect(s.player.onGround).toBe(true);
  });
});

describe("air control", () => {
  test("air-strafing curves the velocity without losing speed", () => {
    const s = sim(floorWorld());
    s.run(5);
    s.run(40, idle({ moveZ: 1 }));
    // Jump, then hold strafe-right while turning right.
    s.run(1, idle({ moveZ: 1, jump: true }));
    const v0 = s.player.velocity;
    const speed0 = horizontalSpeed(v0);
    let minSpeed = Infinity;
    s.run(20, idle({ moveX: 1, lookDx: 20 }), () => {
      if (!s.player.onGround) {
        minSpeed = Math.min(minSpeed, horizontalSpeed(s.player.velocity));
      }
    });
    const v1 = s.player.velocity;
    const turned = Math.acos(
      (v0.x * v1.x + v0.z * v1.z) / (speed0 * horizontalSpeed(v1)),
    );
    expect(turned).toBeGreaterThan(0.4);
    // Turned right: from -Z towards +X.
    expect(v1.x).toBeGreaterThan(1);
    expect(minSpeed).toBeGreaterThanOrEqual(speed0 - 1e-6);
  });

  test("without input, air movement keeps its momentum", () => {
    const s = sim(floorWorld());
    s.run(5);
    s.run(40, idle({ moveZ: 1 }));
    s.run(1, idle({ jump: true }));
    const before = horizontalSpeed(s.player.velocity);
    s.run(20, idle({ lookDx: 30 }));
    expect(horizontalSpeed(s.player.velocity)).toBeCloseTo(before, 6);
  });

  test("bunny-hopping with strafe and turn exceeds run speed", () => {
    const s = sim(floorWorld(), { x: 0, y: 0, z: 15 });
    s.run(5);
    s.run(40, idle({ moveZ: 1 }));
    let hops = 0;
    let peak = 0;
    // Alternate strafe direction every 0.5 s, turning with it.
    s.run(
      240,
      (f) => {
        const dir = Math.floor(f / 30) % 2 === 0 ? 1 : -1;
        return idle({ moveX: dir, lookDx: 12 * dir, jump: true });
      },
      (_f, ev) => {
        hops += ev.filter((e) => e.type === "jump").length;
        peak = Math.max(peak, horizontalSpeed(s.player.velocity));
      },
    );
    expect(hops).toBeGreaterThan(5);
    expect(peak).toBeGreaterThan(T.RUN_SPEED * 1.25);
  });
});

describe("crouching", () => {
  test("crouch lowers the box, keeps the feet, and passes under a 1.2 m beam", () => {
    const w = floorWorld();
    w.addStatic({
      min: { x: -3, y: 1.2, z: -3 },
      max: { x: 3, y: 1.5, z: -2 },
    });
    const s = sim(w);
    s.run(5);
    s.run(1, idle({ crouch: true }));
    const box = s.player.box();
    expect(s.player.crouched).toBe(true);
    expect(box.max.y - box.min.y).toBeCloseTo(PLAYER.crouchHeight, 6);
    expect(box.min.y).toBeLessThan(0.01);
    // Standing it cannot pass.
    const blocked = sim(w);
    blocked.run(60, idle({ moveZ: 1 }));
    expect(blocked.player.feet.z).toBeGreaterThan(-2);
    // Crouched it walks under and stops beneath the beam.
    s.run(200, () =>
      idle({ moveZ: s.player.feet.z > -2.5 ? 1 : 0, crouch: true }),
    );
    expect(s.player.feet.z).toBeLessThan(-2.3);
    expect(s.player.feet.z).toBeGreaterThan(-2.7);
    // Releasing crouch under the beam is refused.
    s.run(30, idle());
    expect(s.player.crouched).toBe(true);
    expect(s.player.box().max.y).toBeLessThanOrEqual(1.2);
    // Walk out, then it stands up.
    s.run(60, idle({ moveZ: 1 }));
    expect(s.player.crouched).toBe(false);
    expect(s.player.box().max.y - s.player.box().min.y).toBeCloseTo(
      PLAYER.standHeight,
      6,
    );
  });

  test("the eye height changes smoothly", () => {
    const s = sim(floorWorld());
    s.run(30);
    const ys: number[] = [];
    s.run(30, idle({ crouch: true }), () =>
      ys.push(s.player.camera(1).position.y),
    );
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-9);
      expect(ys[i - 1] - ys[i]).toBeLessThan(0.4);
    }
    // Mostly there after ~0.12 s, fully there after 0.5 s.
    expect(ys[7]).toBeLessThan(T.CROUCH_EYE_HEIGHT + 0.08);
    expect(ys[29]).toBeCloseTo(T.CROUCH_EYE_HEIGHT, 2);
  });

  test("standing is refused when a crate is overhead", () => {
    const w = floorWorld();
    // A crate resting on a shelf just above crouch height.
    w.addStatic({
      min: { x: -2, y: 1.1, z: -2 },
      max: { x: -0.5, y: 1.2, z: 2 },
    });
    w.addStatic({
      min: { x: 0.5, y: 1.1, z: -2 },
      max: { x: 2, y: 1.2, z: 2 },
    });
    w.addBody({
      position: { x: 0, y: 1.5, z: 0 },
      halfExtents: { x: 0.6, y: 0.3, z: 0.4 },
      mass: 25,
    });
    const s = sim(w, { x: 0, y: 0, z: 3 });
    s.run(5);
    s.run(80, () => idle({ moveZ: s.player.feet.z > 0 ? 1 : 0, crouch: true }));
    expect(Math.abs(s.player.feet.z)).toBeLessThan(0.3);
    s.run(30, idle());
    expect(s.player.crouched).toBe(true);
  });
});

describe("look and camera", () => {
  test("mouse right turns right, mouse up looks up, pitch clamps", () => {
    const s = sim(floorWorld());
    s.run(1, idle({ lookDx: 100, lookDy: -100 }));
    expect(s.player.yaw).toBeCloseTo(-100 * T.LOOK_SENSITIVITY, 9);
    expect(s.player.pitch).toBeCloseTo(100 * T.LOOK_SENSITIVITY, 9);
    s.run(1, idle({ lookDy: -100000 }));
    expect(s.player.pitch).toBeCloseTo(T.MAX_PITCH, 9);
    s.run(1, idle({ lookDy: 100000 }));
    expect(s.player.pitch).toBeCloseTo(-T.MAX_PITCH, 9);
  });

  test("camera forward matches yaw and pitch; yaw 0 looks along -Z", () => {
    const s = sim(floorWorld());
    s.run(5);
    const fwd0 = quat.rotate(
      s.player.camera(1).orientation,
      v3.create(0, 0, -1),
    );
    expect(fwd0.x).toBeCloseTo(0, 6);
    expect(fwd0.y).toBeCloseTo(0, 6);
    expect(fwd0.z).toBeCloseTo(-1, 6);
    s.run(1, idle({ lookDx: -300, lookDy: -200 }));
    const { yaw, pitch } = s.player;
    const cam = s.player.camera(0.5);
    const fwd = quat.rotate(cam.orientation, v3.create(0, 0, -1));
    expect(fwd.x).toBeCloseTo(-Math.sin(yaw) * Math.cos(pitch), 6);
    expect(fwd.y).toBeCloseTo(Math.sin(pitch), 6);
    expect(fwd.z).toBeCloseTo(-Math.cos(yaw) * Math.cos(pitch), 6);
    // Mouse left turned the view to the left (towards -X).
    expect(fwd.x).toBeLessThan(0);
    expect(cam.fovY).toBeCloseTo((74 * Math.PI) / 180, 6);
    expect(cam.near).toBe(0.05);
    expect(cam.far).toBe(80);
  });

  test("camera(alpha) interpolates the eye between the last two steps", () => {
    const s = sim(floorWorld());
    s.run(5);
    s.run(30, idle({ moveZ: 1 }));
    const a = s.player.camera(0).position;
    const b = s.player.camera(1).position;
    const m = s.player.camera(0.5).position;
    expect(b.z - a.z).toBeCloseTo(-T.RUN_SPEED * DT, 3);
    expect(m.z).toBeCloseTo((a.z + b.z) / 2, 9);
    expect(b.z).toBeCloseTo(s.player.feet.z, 9);
  });

  test("view bob stays within a couple of centimetres", () => {
    const s = sim(floorWorld());
    s.run(5);
    let lo = Infinity;
    let hi = -Infinity;
    s.run(180, idle({ moveZ: 1 }), (f) => {
      if (f > 30) {
        const y = s.player.camera(1).position.y;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    });
    expect(hi - lo).toBeGreaterThan(0.005);
    expect(hi - lo).toBeLessThanOrEqual(T.VIEW_BOB + 1e-6);
  });
});

describe("events", () => {
  test("footsteps every ~2.2 m when walking, none when standing", () => {
    const s = sim(floorWorld(), { x: 0, y: 0, z: 15 });
    s.run(30);
    const still = s.run(120);
    expect(still.filter((e) => e.type === "footstep")).toHaveLength(0);
    const start = s.player.feet.z;
    const walk = s.run(300, idle({ moveZ: 1 }));
    const dist = start - s.player.feet.z;
    const steps = walk.filter((e) => e.type === "footstep");
    expect(steps.length).toBeGreaterThanOrEqual(
      Math.floor(dist / T.FOOTSTEP_STRIDE),
    );
    expect(steps.length).toBeLessThanOrEqual(
      Math.ceil(dist / T.FOOTSTEP_STRIDE) + 1,
    );
    for (const e of steps) {
      expect(e).toEqual({ type: "footstep", on: { kind: "static", id: 0 } });
    }
  });

  test("crouched strides are shorter", () => {
    const s = sim(floorWorld(), { x: 0, y: 0, z: 15 });
    s.run(30, idle({ crouch: true }));
    const start = s.player.feet.z;
    const walk = s.run(600, idle({ moveZ: 1, crouch: true }));
    const dist = start - s.player.feet.z;
    const n = walk.filter((e) => e.type === "footstep").length;
    expect(n).toBeGreaterThanOrEqual(Math.floor(dist / T.CROUCH_STRIDE));
  });

  test("land events for real falls, with the impact speed", () => {
    const w = floorWorld();
    const s = sim(w, { x: 0, y: 3, z: 0 });
    const ev = s.run(90);
    const lands = ev.filter((e) => e.type === "land");
    expect(lands).toHaveLength(1);
    const land = lands[0];
    if (land.type !== "land") throw new Error();
    // Falling 3 m at 20 m/s^2 lands at about 11 m/s.
    expect(land.speed).toBeGreaterThan(10);
    expect(land.speed).toBeLessThan(11.5);
    expect(land.on).toEqual({ kind: "static", id: 0 });
    // A small hop does not make a landing sound.
    const small = sim(floorWorld(), { x: 0, y: 0.1, z: 0 });
    expect(small.run(60).filter((e) => e.type === "land")).toHaveLength(0);
  });

  test("a hard landing dips the view and recovers", () => {
    const s = sim(floorWorld(), { x: 0, y: 3, z: 0 });
    let landed = -1;
    let minY = Infinity;
    s.run(120, idle(), (f, ev) => {
      if (ev.some((e) => e.type === "land")) {
        landed = f;
      }
      if (landed >= 0) {
        minY = Math.min(minY, s.player.camera(1).position.y);
      }
    });
    expect(landed).toBeGreaterThan(0);
    expect(minY).toBeLessThan(PLAYER.eyeHeight - 0.02);
    expect(minY).toBeGreaterThan(PLAYER.eyeHeight - 0.15);
    expect(s.player.camera(1).position.y).toBeCloseTo(PLAYER.eyeHeight, 2);
  });
});

describe("determinism", () => {
  test("the same inputs give the same result", () => {
    const script = (f: number) =>
      idle({
        moveX: Math.sin(f * 0.05),
        moveZ: 1,
        lookDx: Math.cos(f * 0.03) * 8,
        lookDy: Math.sin(f * 0.07) * 3,
        jump: f % 50 < 20,
        crouch: f % 120 > 100,
      });
    const runOnce = () => {
      const w = floorWorld();
      w.addStatic({
        min: { x: -2, y: 0, z: -6 },
        max: { x: 2, y: 0.25, z: -4 },
      });
      const s = sim(w);
      s.run(400, script);
      return JSON.stringify([
        s.player.feet,
        s.player.velocity,
        s.player.yaw,
        s.events,
      ]);
    };
    expect(runOnce()).toBe(runOnce());
  });
});
