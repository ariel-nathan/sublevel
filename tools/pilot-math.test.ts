import { describe, expect, test } from "bun:test";
import {
  LOOK_SENSITIVITY,
  batchSteps,
  lookDelta,
  lookError,
  lookToward,
  routeBetween,
  standPoint,
  throwPitch,
  viewBasis,
  wrapDeg,
  zoneOf,
} from "./pilot-math";

describe("angles", () => {
  test("wrapDeg", () => {
    expect(wrapDeg(190)).toBeCloseTo(-170);
    expect(wrapDeg(-190)).toBeCloseTo(170);
    expect(wrapDeg(360)).toBeCloseTo(0);
    expect(wrapDeg(180)).toBeCloseTo(180);
    expect(wrapDeg(-180)).toBeCloseTo(180);
    expect(wrapDeg(725)).toBeCloseTo(5);
  });

  test("lookToward matches the game's yaw convention", () => {
    const eye = { x: 0, y: 1.65, z: 0 };
    // Yaw 0 looks along -Z; positive yaw turns left (towards -X).
    expect(lookToward(eye, { x: 0, y: 1.65, z: -5 }).yawDeg).toBeCloseTo(0);
    expect(lookToward(eye, { x: -5, y: 1.65, z: 0 }).yawDeg).toBeCloseTo(90);
    expect(lookToward(eye, { x: 5, y: 1.65, z: 0 }).yawDeg).toBeCloseTo(-90);
    expect(
      Math.abs(lookToward(eye, { x: 0, y: 1.65, z: 5 }).yawDeg),
    ).toBeCloseTo(180);
    expect(lookToward(eye, { x: 0, y: 6.65, z: -5 }).pitchDeg).toBeCloseTo(45);
    expect(lookToward(eye, { x: 0, y: -3.35, z: -5 }).pitchDeg).toBeCloseTo(
      -45,
    );
  });

  test("lookDelta turns the short way and uses the right signs", () => {
    // Turning left (yaw up) needs negative dx.
    const left = lookDelta(
      { yawDeg: 0, pitchDeg: 0 },
      { yawDeg: 10, pitchDeg: 0 },
    );
    expect(left.dx).toBeCloseTo(-(10 * Math.PI) / 180 / LOOK_SENSITIVITY);
    expect(left.dy).toBeCloseTo(0);
    // Looking up (pitch up) needs negative dy.
    const up = lookDelta(
      { yawDeg: 0, pitchDeg: 0 },
      { yawDeg: 0, pitchDeg: 20 },
    );
    expect(up.dy).toBeLessThan(0);
    // From 170 to -170 is a 20 degree turn left through 180.
    const wrap = lookDelta(
      { yawDeg: 170, pitchDeg: 0 },
      { yawDeg: -170, pitchDeg: 0 },
    );
    expect(wrap.dx).toBeLessThan(0);
    expect(Math.abs(wrap.dx)).toBeCloseTo(
      (20 * Math.PI) / 180 / LOOK_SENSITIVITY,
    );
  });

  test("applying a look delta reaches the target", () => {
    const current = { yawDeg: -37, pitchDeg: 12 };
    const target = { yawDeg: 143, pitchDeg: -60 };
    const { dx, dy } = lookDelta(current, target);
    const after = {
      yawDeg: wrapDeg(current.yawDeg - (dx * LOOK_SENSITIVITY * 180) / Math.PI),
      pitchDeg: current.pitchDeg - (dy * LOOK_SENSITIVITY * 180) / Math.PI,
    };
    expect(lookError(after, target)).toBeLessThan(1e-9);
  });

  test("pitch targets are clamped to the player's limit", () => {
    const { dy } = lookDelta(
      { yawDeg: 0, pitchDeg: 0 },
      { yawDeg: 0, pitchDeg: 120 },
    );
    expect((-dy * LOOK_SENSITIVITY * 180) / Math.PI).toBeCloseTo(89);
  });

  test("viewBasis", () => {
    const north = viewBasis({ yawDeg: 0, pitchDeg: 0 });
    expect(north.forward.z).toBeCloseTo(-1);
    expect(north.right.x).toBeCloseTo(1);
    const west = viewBasis({ yawDeg: 90, pitchDeg: 0 });
    expect(west.forward.x).toBeCloseTo(-1);
    expect(west.right.z).toBeCloseTo(-1);
    const up = viewBasis({ yawDeg: 0, pitchDeg: 90 });
    expect(up.forward.y).toBeCloseTo(1);
  });
});

describe("walking helpers", () => {
  test("batchSteps shrinks near the target and is at least 1", () => {
    expect(batchSteps(10, 0.3)).toBe(6);
    expect(batchSteps(0.2, 0.3)).toBe(1);
    expect(batchSteps(0.5, 0.3)).toBeLessThan(6);
  });

  test("standPoint is on the near side at the given distance", () => {
    const p = standPoint({ x: 10, z: 10 }, { x: 0, z: 10 }, 1.5);
    expect(p.x).toBeCloseTo(8.5);
    expect(p.z).toBeCloseTo(10);
  });
});

describe("throwPitch", () => {
  const flight = (deg: number, distance: number, speed: number, up: number) => {
    const a = (deg * Math.PI) / 180;
    const vx = speed * Math.cos(a);
    const vy = speed * Math.sin(a) + up;
    const t = distance / vx;
    return vy * t - (9.81 * t * t) / 2;
  };

  test("the arc passes through the target", () => {
    for (const [d, h] of [
      [3, 2.5],
      [4, 0],
      [6, -1],
      [2, 0.5],
    ]) {
      const p = throwPitch(d, h, 11, 1);
      expect(p).not.toBeNull();
      expect(flight(p!, d, 11, 1)).toBeCloseTo(h, 4);
    }
  });

  test("the flatter arc is chosen, and out-of-range targets give null", () => {
    const p = throwPitch(4, 1, 11, 1)!;
    expect(p).toBeLessThan(45);
    expect(throwPitch(30, 0, 5, 0)).toBeNull();
    expect(throwPitch(2, 20, 11, 1)).toBeNull();
  });
});

describe("routes", () => {
  test("zones follow the rooms", () => {
    expect(zoneOf({ x: -2, z: 1.6 })).toBe(0);
    expect(zoneOf({ x: 4.15, z: 0 })).toBe(1);
    expect(zoneOf({ x: 6, z: 0 })).toBe(2);
    expect(zoneOf({ x: 9.5, z: 0 })).toBe(3);
    expect(zoneOf({ x: 9.5, z: 4 })).toBe(4);
    expect(zoneOf({ x: 9.5, z: 12 })).toBe(5);
    expect(zoneOf({ x: 13, z: 12 })).toBe(5);
    expect(zoneOf({ x: 15, z: 12 })).toBe(6);
    expect(zoneOf({ x: 20, z: 9.5 })).toBe(7);
    expect(zoneOf({ x: 28, z: 10 })).toBe(8);
    expect(zoneOf({ x: 33, z: 10 })).toBe(9);
  });

  test("into the lane goes round the end of the screen, and back the same way", () => {
    const route = routeBetween({ x: 23.8, z: 13 }, { x: 28, z: 10 });
    expect(route.map((w) => w.name)).toEqual([
      "screen_end",
      "lane",
      "door_t_approach",
      "chamber",
    ]);
    const back = routeBetween({ x: 28, z: 10 }, { x: 23.8, z: 13 });
    expect(back.map((w) => w.name)).toEqual([
      "chamber",
      "door_t_approach",
      "lane",
      "screen_end",
    ]);
    const storage = routeBetween({ x: 9, z: 12 }, { x: 33, z: 10 });
    expect(storage.map((w) => w.name)).toEqual([
      "door_b_approach",
      "hall",
      "screen_end",
      "lane",
      "door_t_approach",
      "chamber",
      "exit_door_approach",
      "lock",
    ]);
  });

  test("lab to storage goes through the door, corridor and bend", () => {
    const route = routeBetween({ x: -2, z: 1.6 }, { x: 9, z: 12 });
    expect(route.map((w) => w.name)).toEqual([
      "door_a",
      "corridor",
      "bend",
      "corridor_south",
      "storage_door",
    ]);
  });

  test("the way back is reversed and same-zone routes are empty", () => {
    const back = routeBetween({ x: 9, z: 12 }, { x: -2, z: 1.6 });
    expect(back.map((w) => w.name)).toEqual([
      "storage_door",
      "corridor_south",
      "bend",
      "corridor",
      "door_a",
    ]);
    expect(routeBetween({ x: 1, z: 1 }, { x: -3, z: 2 })).toEqual([]);
  });
});
