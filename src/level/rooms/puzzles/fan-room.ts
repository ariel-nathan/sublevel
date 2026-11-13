/**
 * Fan room (impact target, through an opening). The ventilation plant room
 * is closed off by a bulkhead; behind it, in the fan bay, the impact target
 * that latches the exit door open is on the back wall, seen only through
 * an inspection window in the bulkhead (1.2 m wide, 0.9 m tall, its sill
 * 1.75 to 1.95 m up). Throw something through the window at the target.
 * A crawl hatch at floor level (1.1 m high: crouch) leads into the bay, so
 * anything thrown through the window that misses can be fetched back.
 *
 *   top view (not mirrored)
 *
 *   x0                            xp  xp+0.3        x1
 *   +=========== EXIT =============|=================+
 *   | crate         (throw spot)  hatch   fan bay    |
 *   E entry       chair      ---- window ---->  [T]  |
 *   | ducts  crate  monitor        |    fan housing  |
 *   +==============================|=================+
 *
 * Softlocks: none. The target latches the door for good. A prop that goes
 * through the window lands on the bay's floor, which the crawl hatch
 * reaches (crouch through it, carry or throw the prop back, or throw it at
 * the target from inside the bay: a harmless alternative). Nothing in the
 * main room or the bay is a high shelf: ducts and pipes run tight under
 * the roof. There are five or six throwables.
 */
import type { SolutionStep } from "../../../core/api";
import type { Rng } from "../../../core/rng";
import { IMPACT_BUTTON_DEPTH, type RoomModule, type RoomPlan } from "../room";
import { WALL as W } from "../room";
import { COOL, lamp, RED, signX, signZ, SODIUM, tank } from "./dress";
import { buildShell, ENTRY_SIZE } from "./shell";
import { pick, q } from "./util";

export interface FanRoomParams {
  /** Length of the plant room (entry wall to bulkhead). */
  room: number;
  /** Depth of the fan bay. */
  bay: number;
  left: number;
  right: number;
  height: number;
  /** Window sill height. */
  sill: number;
  /** Window position across the room (fraction). */
  window: number;
  /** Small crates (3 or 4; plus a monitor and a chair). */
  crates: number;
}

export const FAN_ROOM_RANGES = {
  room: [7.5, 9],
  bay: [1.7, 2.1],
  left: [3.4, 4.0],
  right: [3.4, 4.0],
  height: [4.2, 4.8],
  sill: [1.6, 1.8],
  window: [0, 1],
  crates: [3, 4],
} as const;

const R = FAN_ROOM_RANGES;
export const FAN_WINDOW = { width: 1.4, height: 1.3 };
export const FAN_HATCH = { width: 1.0, height: 1.1 };
/** Throw distance from the bulkhead. */
export const FAN_THROW_BACK = 3.2;

function random(rng: Rng): FanRoomParams {
  return {
    room: pick(rng, R.room),
    bay: pick(rng, R.bay),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    sill: pick(rng, R.sill),
    window: pick(rng, R.window),
    crates: rng.int(...R.crates),
  };
}

export function fanLayout(p: FanRoomParams) {
  const x0 = W;
  const xp = x0 + p.room;
  const xb = xp + W;
  const x1 = q(xb + p.bay);
  const z0 = -p.left;
  const z1 = p.right;
  // The window in the right part, the hatch near the left wall.
  const w0 = 0.0;
  const w1 = z1 - 2.0;
  const wz = q(w0 + (w1 - w0) * p.window);
  const window = {
    z0: wz - FAN_WINDOW.width / 2,
    z1: wz + FAN_WINDOW.width / 2,
    y0: p.sill,
    y1: p.sill + FAN_WINDOW.height,
  };
  const hatch = {
    z0: z0 + 0.6,
    z1: z0 + 0.6 + FAN_HATCH.width,
    y1: FAN_HATCH.height,
  };
  const face = x1 - 0.02;
  // The arc still rises at the window: aim a little above its middle.
  const target = { x: face - IMPACT_BUTTON_DEPTH, y: q(p.sill + 0.75), z: wz };
  const throwSpot = { x: q(xp - FAN_THROW_BACK), z: wz };
  const exitX = q(Math.max(2.6, xp - 2.2));
  return {
    x0,
    xp,
    xb,
    x1,
    z0,
    z1,
    wz,
    window,
    hatch,
    face,
    target,
    throwSpot,
    exitX,
  };
}

function build(
  ctx: Parameters<RoomModule<FanRoomParams>["build"]>[0],
  at: Parameters<RoomModule<FanRoomParams>["build"]>[1],
  p: FanRoomParams,
): RoomPlan {
  const lay = fanLayout(p);
  const {
    x0,
    xp,
    xb,
    x1,
    z0,
    z1,
    wz,
    window: win,
    hatch,
    face,
    target,
    throwSpot,
    exitX,
  } = lay;
  const s = buildShell(ctx, at, {
    length: x1 - x0,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: "left", at: exitX, door: true },
    floor: "concrete_floor",
    walls: "concrete_wall",
    farWall: "metal_panel",
    ceiling: "metal_panel",
    acoustics: "hall",
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;

  // --- The bulkhead: window and crawl hatch -----------------------------
  B(xp, 0, z0, xb, h, hatch.z0, "metal_panel");
  B(xp, hatch.y1, hatch.z0, xb, h, hatch.z1, "metal_panel");
  B(xp, 0, hatch.z1, xb, h, win.z0, "metal_panel");
  B(xp, 0, win.z0, xb, win.y0, win.z1, "metal_panel");
  B(xp, win.y1, win.z0, xb, h, win.z1, "metal_panel");
  B(xp, 0, win.z1, xb, h, z1, "metal_panel");
  // Striped frames round the window and the hatch, on the room side.
  k.box(
    xp - 0.08,
    win.y0 - 0.12,
    win.z0 - 0.12,
    xp,
    win.y0,
    win.z1 + 0.12,
    "hazard_stripe",
  );
  k.box(
    xp - 0.08,
    win.y1,
    win.z0 - 0.12,
    xp,
    win.y1 + 0.12,
    win.z1 + 0.12,
    "hazard_stripe",
  );
  k.box(xp - 0.08, win.y0, win.z0 - 0.12, xp, win.y1, win.z0, "hazard_stripe");
  k.box(xp - 0.08, win.y0, win.z1, xp, win.y1, win.z1 + 0.12, "hazard_stripe");
  k.frameX(xp, -1, hatch.z0, hatch.z1, hatch.y1);
  signX(
    k,
    xp,
    -1,
    wz - 0.4,
    wz + 0.4,
    win.y1 + 0.3,
    Math.min(win.y1 + 0.9, h - 0.2),
  );
  signX(k, xp, -1, hatch.z1 + 0.2, hatch.z1 + 0.7, 0.3, 0.8);

  // --- The fan bay: target, fan housing, lamp -------------------------------
  B(
    face,
    target.y - 0.35,
    target.z - 0.35,
    x1,
    target.y + 0.35,
    target.z + 0.35,
    "hazard_stripe",
  );
  const button = k.button(
    ctx.id("target_exit"),
    s.exitDoor!.id,
    target.x,
    target.y,
    target.z,
    [-1, 0],
    "impact",
  );
  // The fan: a housing on the back wall away from the window, its grille,
  // a duct from it to the roof.
  const fz0 = Math.max(hatch.z1 + 0.6, z0 + 2.0);
  const fz1 = win.z0 - 0.5;
  if (fz1 - fz0 > 1.0) {
    B(x1 - 0.7, 0, fz0, x1, 1.6, fz1, "metal_panel");
    B(x1 - 0.72, 0.3, fz0 + 0.15, x1 - 0.7, 1.4, fz1 - 0.15, "metal_grate");
    B(x1 - 0.6, 1.6, fz0 + 0.2, x1 - 0.1, h, fz1 - 0.2, "pipe");
  }
  k.zone(F.box(xb, 0, z0, x1, h, z1), "small");
  lamp(k, q((xb + x1) / 2), wz, h, COOL, 4, 1.2, { hx: 0.2, hz: 0.3 });
  lamp(k, q(xp - 0.7), wz, h, RED, 3.5, 1.0, {
    hx: 0.15,
    hz: 0.15,
    material: "button_red",
  });

  // --- The plant room ------------------------------------------------------
  // Air handling units along the right wall (low: anything on them is in
  // reach), ducts tight under the roof.
  for (let x = x0 + 1.6; x + 1.5 < throwSpot.x - 1.5; x += 2.0) {
    tank(k, x, z1 - 1.2, x + 1.5, z1 - 0.15, 1.3, "metal_panel");
  }
  B(x0, h - 0.5, z1 - 0.9, xp, h - 0.02, z1 - 0.3, "metal_panel");
  B(x0, h - 0.4, z0 + 0.2, xp, h - 0.05, z0 + 0.55, "pipe");
  signZ(k, z0, 1, s.exitHi + 0.3, s.exitHi + 0.9, 1.3, 2.0);
  lamp(k, q(x0 + p.room * 0.35), 0, h, SODIUM, 7, 1.1);
  lamp(k, q(throwSpot.x + 0.6), q(wz - 1.2), h, SODIUM, 6, 1.0);
  k.emitter("hum_machine", x1 - 0.5, 1.0, q((fz0 + fz1) / 2), 0.5);

  // --- Throwables -----------------------------------------------------------
  const spots = [
    { x: throwSpot.x - 0.9, z: wz - 1.1 },
    { x: throwSpot.x + 1.0, z: wz + 1.0 },
    { x: x0 + 1.2, z: z0 + 1.6 },
    { x: throwSpot.x - 1.6, z: z0 + 1.4 },
  ].map((c) => ({
    x: q(Math.min(xp - 0.6, Math.max(x0 + 0.6, c.x))),
    z: q(Math.min(z1 - 1.5, Math.max(z0 + 0.8, c.z))),
  }));
  const crates = spots
    .slice(0, p.crates)
    .map((c) =>
      k.propTurned("crate_wood_small", c.x, 0, c.z, rng.range(-0.4, 0.4)),
    );
  k.propTurned("monitor", q(x0 + 2.4), 0, q(z0 + 2.8), rng.range(0, 6));
  k.propTurned("chair", x0 + 0.7, 0, z0 + 0.7, rng.range(0, 6));

  const P = s.P;
  const aim = F.point(target.x - 0.3, target.y, target.z);
  const solution: SolutionStep[] = [
    { do: "walk", to: P(throwSpot.x, throwSpot.z) },
    { do: "throw", prop: crates[0], at: aim },
    { do: "walk", to: s.before },
  ];
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "impact-target",
      doors: [s.exitDoor!.id],
      buttons: [button.id],
      plates: [],
      keys: crates.map((prop, i) => ({
        prop,
        at: F.point(spots[i].x, 0.25, spots[i].z),
      })),
    },
    solution,
  };
}

export const FAN_ROOM: RoomModule<FanRoomParams> = {
  name: "fan-room",
  role: "middle",
  teaches: "impact-target",
  difficulty: 3,
  requires: {},
  entrySize: ENTRY_SIZE,
  defaults: {
    room: 8,
    bay: 1.9,
    left: 3.6,
    right: 3.6,
    height: 4.4,
    sill: 1.7,
    window: 0.4,
    crates: 4,
  },
  random,
  build,
};
