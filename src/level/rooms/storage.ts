/**
 * The storage room of Kestrel Annex: a pressure plate holds door B open
 * while 45 kg rest on it. Two wooden crates stacked on it do (the declared
 * solution). The metal crate, too heavy to carry, has a clear push path to
 * the plate but cannot be pushed onto it: the plate is a 4 cm step that a
 * sliding crate does not climb (tools/push-check.ts shows it).
 *
 * Design coordinates are the annex's world coordinates; the entry is the
 * corridor's end at (9.55, 0, 7.7) facing +Z, and the room is x 5.5..13.5,
 * z 8..16, ceiling 4.0. Door B is the opening z 11.3..12.7 in the east wall
 * x 13.5..13.8.
 */
import type { SolutionStep } from "../../core/api";
import type { DesignAnchor, RoomContext, RoomModule, RoomPlan } from "./room";
import {
  doorwayPoints,
  rectOnPlane,
  roomFrame,
  WALL,
  type Connector,
} from "./room";
import { createKit } from "./kit";

export const STORAGE_DESIGN: DesignAnchor = {
  position: { x: 9.55, y: 0, z: 7.7 },
  facing: { x: 0, y: 0, z: 1 },
};

const DOOR_B = { lo: 11.3, hi: 12.7, top: 2.4 };
/** The plate, 1.2 m square, 4.4 m from door B. */
const PLATE = { x0: 7.9, x1: 9.1, z0: 11.4, z1: 12.6 };

function buildStorage(ctx: RoomContext, at: Connector): RoomPlan {
  const F = roomFrame(at, ctx.mirror, STORAGE_DESIGN);
  const k = createKit(ctx, F);
  const { box } = k;

  // The entry doorway's jambs on this side (the full-width opening of the
  // corridor has no lintel below the corridor's ceiling).
  box(8.1, 0, 8, 8.3, 2.8, 8.1, "hazard_stripe");
  box(10.8, 0, 8, 11, 2.8, 8.1, "hazard_stripe");

  box(5.5, -WALL, 8, 13.5, 0, 16, "concrete_floor");
  box(5.5, 4, 8, 13.5, 4.3, 16, "concrete_wall");
  k.wallAlongX(
    5.2,
    13.8,
    7.7,
    8,
    -WALL,
    4.3,
    "concrete_wall",
    [{ a: 8.3, b: 10.8, top: 2.8 }],
    "concrete_floor",
  );
  k.wallAlongX(5.2, 13.8, 16, 16.3, -WALL, 4.3, "metal_panel");
  k.wallAlongZ(5.2, 5.5, 8, 16, -WALL, 4.3, "metal_panel");
  k.wallAlongZ(
    13.5,
    13.8,
    8,
    16,
    -WALL,
    4.3,
    "concrete_wall",
    [{ a: DOOR_B.lo, b: DOOR_B.hi, top: DOOR_B.top }],
    "metal_panel",
  );
  // Ceiling beams and lamps.
  for (const z of [9.6, 13, 15.6])
    box(5.5, 3.7, z - 0.15, 13.5, 4, z + 0.15, "metal_panel");
  k.fixture(9, 11, 4, 0.6, 0.25);
  k.fixture(11, 14.5, 4, 0.6, 0.25);
  k.light(9, 3.55, 11, [1.0, 0.88, 0.7], 9, 1.5);
  k.light(11, 3.55, 14.5, [1.0, 0.88, 0.7], 9, 1.5);
  // Pipes on the west wall, hazard band on the north wall, sign on the south.
  box(5.5, 3.3, 8.2, 5.65, 3.45, 16, "pipe");
  box(5.5, 0, 12.1, 5.65, 3.3, 12.25, "pipe");
  box(5.5, 0, 12.4, 5.65, 3.3, 12.55, "pipe");
  box(11.2, 2.4, 8, 13.5, 2.55, 8.1, "hazard_stripe");
  box(9, 1.5, 15.96, 10, 2.5, 16, "sign_warning");
  // Wall pilasters on the east wall.
  box(13.2, 0, 14, 13.5, 4, 14.35, "metal_panel");
  box(13.2, 0, 10.2, 13.5, 4, 10.5, "metal_panel");
  // Shelving and pallets.
  const shelfAlongZ = (x0: number, x1: number, za: number, zb: number) => {
    box(x0, 0, za, x1, 2.0, za + 0.05, "metal_panel");
    box(x0, 0, zb - 0.05, x1, 2.0, zb, "metal_panel");
    for (const y of [0.1, 0.7, 1.3, 1.9]) {
      box(x0, y, za + 0.05, x1, y + 0.04, zb - 0.05, "metal_panel");
    }
  };
  const shelfAlongX = (xa: number, xb: number, z0: number, z1: number) => {
    box(xa, 0, z0, xa + 0.05, 2.0, z1, "metal_panel");
    box(xb - 0.05, 0, z0, xb, 2.0, z1, "metal_panel");
    for (const y of [0.1, 0.7, 1.3, 1.9]) {
      box(xa + 0.05, y, z0, xb - 0.05, y + 0.04, z1, "metal_panel");
    }
  };
  shelfAlongZ(5.5, 6.1, 8.5, 11);
  shelfAlongX(11.2, 13.4, 8, 8.6);
  box(5.6, 0.14, 8.6, 5.9, 0.44, 8.9, "crate_wood");
  box(5.7, 0.74, 9.6, 6.0, 1.04, 9.95, "crate_metal");
  box(5.6, 1.34, 10.2, 5.9, 1.64, 10.5, "crate_wood");
  box(11.4, 0.74, 8.1, 11.8, 1.14, 8.5, "crate_wood");
  box(12.6, 1.34, 8.1, 13.0, 1.74, 8.5, "crate_metal");
  box(12.5, 0, 8.7, 13.4, 0.12, 9.7, "crate_wood");

  // Mezzanine in the south-west corner, 1.4 m up. There are no raised floor
  // markings anywhere, so pushed crates slide freely.
  box(5.5, 0, 13.8, 8.5, 1.3, 16, "metal_panel");
  box(5.5, 1.3, 13.8, 8.5, 1.4, 16, "metal_grate");
  box(5.5, 0.3, 13.74, 8.5, 0.6, 13.8, "hazard_stripe");

  // Door B frame, storage side (the hall frames its own side).
  k.frameX(13.5, -1, DOOR_B.lo, DOOR_B.hi, DOOR_B.top);

  // Mezzanine cargo.
  k.prop("crate_wood", 6.0, 1.4, 15.0);
  k.prop("crate_weak", 6.9, 1.4, 15.0);
  k.prop("crate_wood", 7.8, 1.4, 15.0);
  // The heavy crate, 3.8 m from the plate with a clear diagonal push path.
  k.prop("crate_metal", 11.4, 0, 9.4);
  // Wooden crate on a pallet with a small crate on top.
  k.prop("crate_wood", 12.95, 0.12, 9.2);
  k.prop("crate_wood_small", 12.95, 0.92, 9.2);
  // Floor stock: a stack of two wooden crates by the south wall.
  k.prop("crate_weak", 9.7, 0, 15.5);
  const stackBottom = k.prop("crate_wood", 11.0, 0, 15.5);
  const stackTop = k.prop("crate_wood", 11.0, 0.8, 15.5);
  k.prop("barrel", 12.5, 0, 15.4);
  k.prop("barrel", 12.5, 0, 14.5);
  k.prop("barrel", 13.1, 0, 14.95);
  k.prop("crate_wood_small", 6.9, 0, 9.6);
  k.prop("crate_wood_small", 12.2, 0, 13.4);

  // Door B and the plate that holds it open.
  const door = k.door(
    ctx.id("door_b"),
    "x",
    13.5,
    13.8,
    DOOR_B.lo,
    DOOR_B.hi,
    DOOR_B.top,
  );
  const plate = ctx.id("plate_b");
  ctx.plate({
    id: plate,
    box: F.box(PLATE.x0, 0, PLATE.z0, PLATE.x1, 0.04, PLATE.z1),
    requiredMass: 45,
    target: door.id,
  });
  k.zone(F.box(5.5, 0, 7.85, 13.65, 4, 16), "hall");

  const exit: Connector = {
    position: F.point(13.8, 0, 12),
    facing: F.dir(1, 0, 0),
    width: DOOR_B.hi - DOOR_B.lo,
    height: DOOR_B.top,
    door: door.id,
  };
  const pc = { x: (PLATE.x0 + PLATE.x1) / 2, z: (PLATE.z0 + PLATE.z1) / 2 };
  const P = (x: number, z: number) => F.point(x, 0, z);
  const centre = (y: number) => F.point(pc.x, y, pc.z);
  // The top crate of the stack onto the plate, from the south; then the
  // other on top of it, from the east (the player stays off the plate: the
  // player weighs it down too).
  const solution: SolutionStep[] = [
    { do: "walk", to: P(10.2, 9.6) },
    { do: "walk", to: P(10.2, 13.0) },
    { do: "walk", to: P(8.9, 13.45) },
    { do: "carry", prop: stackTop, to: centre(0.4) },
    { do: "walk", to: P(10.4, 13.2) },
    { do: "walk", to: P(10.4, 12) },
    { do: "carry", prop: stackBottom, to: centre(1.2) },
    { do: "wait", for: "plate_down", seconds: 3 },
    { do: "walk", to: doorwayPoints(exit).before },
  ];
  return {
    footprint: [F.box(5.2, -WALL, 7.7, 13.8, 4.3, 16.3)],
    entry: {
      connector: at,
      end: {
        wall: true,
        extent: rectOnPlane(at, F.box(5.2, -WALL, 7.7, 13.8, 4.3, 7.7)),
      },
    },
    exits: [
      {
        connector: exit,
        end: {
          wall: true,
          extent: rectOnPlane(exit, F.box(13.8, -WALL, 7.7, 13.8, 4.3, 16.3)),
        },
      },
    ],
    lock: {
      kind: "weighted-plate",
      doors: [door.id],
      buttons: [],
      plates: [plate],
      keys: [
        { prop: stackTop, at: F.point(11.0, 1.2, 15.5) },
        { prop: stackBottom, at: F.point(11.0, 0.4, 15.5) },
      ],
    },
    solution,
  };
}

export const STORAGE: RoomModule = {
  name: "storage",
  role: "middle",
  teaches: "weighted-plate",
  difficulty: 1,
  requires: {},
  setPiece: true,
  idea: "crates-on-plate",
  // The entry opening is the corridor's whole cross-section, framed by the
  // jambs above; the room's dressing is laid out round exactly that.
  entrySize: { width: [2.5, 2.5], height: [2.8, 2.8] },
  defaults: {},
  random: () => ({}),
  build: (ctx, at) => buildStorage(ctx, at),
};
