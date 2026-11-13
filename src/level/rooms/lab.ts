/**
 * The lab of Kestrel Annex: where the player starts. A start module (no
 * entry); its one exit is door A in its east wall, opened by a toggle
 * button beside it.
 *
 * Design coordinates are the annex's world coordinates with the lab anchored
 * at the origin facing +X: the room is x -4..4, z -3..3, ceiling 3.0, and
 * door A is the opening z -0.7..0.7 in the east wall x 4..4.3.
 */
import type { DesignAnchor, RoomContext, RoomModule, RoomPlan } from "./room";
import {
  BUTTON_DEPTH,
  doorwayPoints,
  rectOnPlane,
  roomFrame,
  WALL,
  type Connector,
} from "./room";
import { createKit } from "./kit";

export const LAB_DESIGN: DesignAnchor = {
  position: { x: 0, y: 0, z: 0 },
  facing: { x: 1, y: 0, z: 0 },
};

/** Door A: width and height of the opening. */
const DOOR_A = { lo: -0.7, hi: 0.7, top: 2.2 };

function buildLab(ctx: RoomContext, at: Connector): RoomPlan {
  const F = roomFrame(at, ctx.mirror, LAB_DESIGN);
  const k = createKit(ctx, F);
  const { box } = k;

  // Shell: x -4..4, z -3..3, ceiling 3.0.
  box(-4, -WALL, -3, 4, 0, 3, "lab_floor_tile");
  box(-4, 3, -3, 4, 3 + WALL, 3, "ceiling_panel");
  k.wallAlongX(-4.3, 4.3, -3.3, -3, -WALL, 3.3, "lab_wall");
  k.wallAlongX(-4.3, 4.3, 3, 3.3, -WALL, 3.3, "lab_wall");
  k.wallAlongZ(-4.3, -4, -3, 3, -WALL, 3.3, "lab_wall");
  k.wallAlongZ(
    4,
    4.3,
    -3,
    3,
    -WALL,
    3.3,
    "lab_wall",
    [{ a: DOOR_A.lo, b: DOOR_A.hi, top: DOOR_A.top }],
    "metal_panel",
  );

  // Rubber baseboards.
  box(-4, 0, -3, 4, 0.1, -2.97, "rubber_dark");
  box(-4, 0, 2.97, 4, 0.1, 3, "rubber_dark");
  box(-4, 0, -2.97, -3.97, 0.1, 2.97, "rubber_dark");
  box(3.97, 0, -2.97, 4, 0.1, -0.9, "rubber_dark");
  box(3.97, 0, 0.9, 4, 0.1, 2.97, "rubber_dark");

  // Door A frame on the lab side (the corridor frames its own side) and the
  // lab's button for it.
  k.frameX(4, -1, DOOR_A.lo, DOOR_A.hi, DOOR_A.top);
  const button = k.button(
    ctx.id("button_a_lab"),
    ctx.id("door_a"),
    4 - BUTTON_DEPTH,
    1.2,
    1.2,
    [-1, 0],
  );

  // Lights: three recessed panels, steady cool white.
  for (const cx of [-2.4, 0, 2.4]) {
    k.fixture(cx, 0, 3, 0.6, 0.3);
    k.light(cx, 2.6, 0, [0.85, 0.92, 1.0], 7.5, 1.2);
  }
  // Ceiling beams.
  for (const x of [-1.2, 1.2])
    box(x - 0.1, 2.85, -2.8, x + 0.1, 3, 2.8, "metal_panel");
  box(-4, 2.85, -3, 4, 3, -2.8, "metal_panel");
  box(-4, 2.85, 2.8, 4, 3, 3, "metal_panel");

  // Benches along the north wall with a sign between them.
  const bench = (x0: number, x1: number, z0: number, z1: number): void => {
    box(x0, 0, z0, x1, 0.8, z1, "metal_panel");
    box(x0, 0.8, z0, x1, 0.85, z1 + 0.05, "plastic_white");
    box(x0, 0, z1, x1, 0.1, z1 + 0.03, "rubber_dark");
  };
  bench(-3.9, -0.6, -3, -2.3);
  bench(0.6, 3.9, -3, -2.3);
  box(-0.5, 1.4, -3, 0.5, 2.4, -2.96, "sign_warning");
  // Wall shelves and instruments on the benches.
  box(-3.9, 1.55, -3, -0.6, 1.59, -2.7, "metal_panel");
  box(0.6, 1.55, -3, 3.9, 1.59, -2.7, "metal_panel");
  box(-3.7, 1.59, -2.95, -3.3, 1.84, -2.75, "plastic_white");
  box(-1.5, 1.59, -2.95, -1.0, 1.79, -2.75, "metal_panel");
  box(1.0, 1.59, -2.95, 1.6, 1.89, -2.75, "plastic_white");
  box(2.8, 1.59, -2.95, 3.4, 1.74, -2.75, "metal_panel");
  box(-3.7, 0.85, -2.95, -3.3, 1.05, -2.6, "plastic_white");
  box(-1.6, 0.85, -2.9, -1.2, 1.2, -2.6, "metal_panel");
  box(0.8, 0.85, -2.9, 1.2, 1.1, -2.6, "plastic_white");
  box(2.8, 0.85, -2.9, 3.3, 1.0, -2.6, "metal_panel");
  // Desk on the west wall.
  box(-4, 0, -1, -3.4, 0.8, -0.4, "metal_panel");
  box(-4, 0, 0.72, -3.4, 0.8, 0.8, "metal_panel");
  box(-4, 0.8, -1, -3.3, 0.85, 0.8, "plastic_white");
  // Central table.
  box(-1, 0.8, -0.5, 1, 0.85, 0.5, "plastic_white");
  for (const sx of [-0.93, 0.85]) {
    for (const sz of [-0.43, 0.35]) {
      box(sx, 0, sz, sx + 0.08, 0.8, sz + 0.08, "metal_panel");
    }
  }
  // Equipment cabinets on the south wall, each with a screen on its front.
  for (const x0 of [0.4, 1.4]) {
    box(x0, 0, 2.3, x0 + 0.8, 2.0, 3, "metal_panel");
    box(x0 + 0.1, 1.0, 2.27, x0 + 0.6, 1.5, 2.3, "monitor_screen");
    box(x0 + 0.1, 0.4, 2.27, x0 + 0.7, 0.9, 2.3, "rubber_dark");
  }
  // A tall rack in the south-west corner area.
  box(-1.8, 0, 2.4, -1.0, 2.2, 3, "metal_panel");
  box(-1.7, 1.2, 2.37, -1.2, 1.7, 2.4, "monitor_screen");

  // Props.
  k.prop("monitor", -2.5, 0.85, -2.65, Math.PI);
  k.prop("monitor", 2.0, 0.85, -2.65, Math.PI);
  k.prop("monitor", 0, 0.85, 0, Math.PI);
  k.prop("chair", -2.9, 0, 0.2, Math.PI / 2);
  k.prop("chair", 2.2, 0, -1.8);
  k.prop("crate_wood_small", -3.4, 0, 2.4);
  k.prop("crate_wood_small", 3.3, 0, 2.5);

  // Door A (the lab's exit: the exit side owns the door).
  const door = k.door(
    ctx.id("door_a"),
    "x",
    4,
    4.3,
    DOOR_A.lo,
    DOOR_A.hi,
    DOOR_A.top,
  );
  k.zone(F.box(-4, 0, -3, 4.15, 3, 3), "lab");

  const exit: Connector = {
    position: F.point(4.3, 0, 0),
    facing: F.dir(1, 0, 0),
    width: DOOR_A.hi - DOOR_A.lo,
    height: DOOR_A.top,
    door: door.id,
  };
  const press = F.point(4 - BUTTON_DEPTH - 1.0, 0, 1.2);
  return {
    footprint: [F.box(-4.3, -WALL, -3.3, 4.3, 3.3, 3.3)],
    entry: null,
    exits: [
      {
        connector: exit,
        end: {
          wall: true,
          extent: rectOnPlane(exit, F.box(4.3, -WALL, -3.3, 4.3, 3.3, 3.3)),
        },
      },
    ],
    spawn: { position: F.point(-2, 0, 1.6), yaw: F.yaw(-Math.PI / 2) },
    lock: {
      kind: "toggle-button",
      doors: [door.id],
      buttons: [button.id],
      plates: [],
      keys: [],
    },
    solution: [
      { do: "walk", to: press },
      { do: "press", button: button.id },
      { do: "walk", to: doorwayPoints(exit).before },
    ],
  };
}

export const LAB: RoomModule = {
  name: "lab",
  role: "start",
  teaches: "toggle-button",
  difficulty: 0,
  requires: {},
  entrySize: { width: [0, 0], height: [0, 0] },
  defaults: {},
  random: () => ({}),
  build: (ctx, at) => buildLab(ctx, at),
};
