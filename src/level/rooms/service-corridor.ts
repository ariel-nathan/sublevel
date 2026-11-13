/**
 * The service corridor of Kestrel Annex: from door A east, a bend, then
 * south over a see-through floor grate above a service pit, to the storage
 * room. No lock. Both ends are open (rule 2 in room.ts): the lab's wall
 * closes its entry and the storage room's wall its exit.
 *
 * Design coordinates are the annex's world coordinates; the entry is door A
 * at (4.3, 0, 0) facing +X. Layout: x 4.3..10.8, z -1.25..1.25, then
 * x 8.3..10.8, z 1.25..7.7; ceiling 2.8; the pit under the grate is
 * x 8.4..10.3, z 2.6..5.4, floor -1.1.
 */
import type { DesignAnchor, RoomContext, RoomModule, RoomPlan } from "./room";
import {
  BUTTON_DEPTH,
  doorwayPoints,
  GRATE_THICKNESS,
  NO_LOCK,
  rectOnPlane,
  roomFrame,
  WALL,
  type Connector,
} from "./room";
import { createKit } from "./kit";

export const SERVICE_CORRIDOR_DESIGN: DesignAnchor = {
  position: { x: 4.3, y: 0, z: 0 },
  facing: { x: 1, y: 0, z: 0 },
};

/** Interior of the service pit under the corridor grate (design space). */
export const PIT = { x0: 8.4, x1: 10.3, z0: 2.6, z1: 5.4, floor: -1.1 };

function buildServiceCorridor(ctx: RoomContext, at: Connector): RoomPlan {
  const F = roomFrame(at, ctx.mirror, SERVICE_CORRIDOR_DESIGN);
  const k = createKit(ctx, F);
  const { box } = k;
  const half = at.width / 2;

  // The entry doorway's frame on this side (on the face of the wall that
  // closes the open end), and a button for its door if it has one.
  k.frameX(4.3, 1, 0 - half, 0 + half, at.height);

  box(4.3, -WALL, -1.25, 8.3, 0, 1.25, "concrete_floor");
  box(8.3, -WALL, -1.25, 10.8, 0, 2.5, "concrete_floor");
  box(8.3, -WALL, 5.5, 10.8, 0, 7.7, "concrete_floor");
  // Floor grate over a service pit. The grate is a thin see-through slab
  // (GRATE_THICKNESS) flush with the floor, spanning the whole opening
  // between the walls and the floor either side of it, so its edges abut
  // solid brushes exactly. It rests on a steel angle along three sides, a
  // concrete ledge under the machine on the east side, and two cross beams.
  const gy = -GRATE_THICKNESS;
  box(PIT.x0 - 0.1, gy, PIT.z0 - 0.1, 10.8, 0, PIT.z1 + 0.1, "metal_grate");
  // Pit shell: walls below the corridor floor, 0.3-0.4 m thick, and a 0.2 m
  // floor. Interior x 8.4..10.3, z 2.6..5.4, floor at y = PIT.floor.
  const pf = PIT.floor;
  box(8.0, pf - 0.2, 2.3, 11.1, pf, 5.7, "concrete_floor");
  box(8.0, pf, 2.3, PIT.x0, -WALL, 5.7, "concrete_wall");
  box(PIT.x1, pf, 2.3, 11.1, -WALL, 5.7, "concrete_wall");
  box(PIT.x0, pf, 2.3, PIT.x1, -WALL, PIT.z0, "concrete_wall");
  box(PIT.x0, pf, PIT.z1, PIT.x1, -WALL, 5.7, "concrete_wall");
  // Bearing ledges under the grate: steel angle west, north and south, and
  // a concrete ledge east (the machine stands over it).
  box(8.3, -WALL, 2.5, PIT.x0, gy, 5.5, "metal_panel");
  box(PIT.x0, -WALL, 2.5, PIT.x1, gy, PIT.z0, "metal_panel");
  box(PIT.x0, -WALL, PIT.z1, PIT.x1, gy, 5.5, "metal_panel");
  box(PIT.x1, -WALL, 2.5, 10.8, gy, 5.5, "concrete_wall");
  // Cross beams under the grate.
  for (const z of [3.5, 4.5]) {
    box(PIT.x0, gy - 0.1, z - 0.04, PIT.x1, gy, z + 0.04, "metal_panel");
  }
  // Pipe runs along the pit at three heights: low on saddles in the middle,
  // mid-height on the west wall, high on the east wall.
  box(9.5, pf + 0.15, PIT.z0, 9.7, pf + 0.33, PIT.z1, "pipe");
  for (const z of [3.2, 4.8]) {
    box(9.48, pf, z - 0.05, 9.72, pf + 0.15, z + 0.05, "metal_panel");
  }
  box(PIT.x0, -0.75, PIT.z0, PIT.x0 + 0.15, -0.6, PIT.z1, "pipe");
  box(PIT.x1 - 0.15, -0.42, PIT.z0, PIT.x1, -0.28, PIT.z1, "pipe");
  // Junction box on the west wall, hazard band on the north wall and a dim
  // red pilot lamp on the south wall.
  box(PIT.x0, -0.5, 3.9, PIT.x0 + 0.12, -0.2, 4.3, "metal_panel");
  box(8.7, -0.55, PIT.z0, 10.0, -0.43, PIT.z0 + 0.03, "hazard_stripe");
  box(8.95, -0.88, PIT.z1 - 0.04, 9.15, -0.78, PIT.z1, "button_red");
  box(4.3, 2.8, -1.25, 10.8, 3.1, 1.25, "concrete_wall");
  box(8.3, 2.8, 1.25, 10.8, 3.1, 7.7, "concrete_wall");
  k.wallAlongX(4.3, 11.1, -1.55, -1.25, -WALL, 3.1, "concrete_wall");
  k.wallAlongZ(10.8, 11.1, -1.25, 7.7, -WALL, 3.1, "concrete_wall");
  k.wallAlongX(4.3, 8, 1.25, 1.55, -WALL, 3.1, "concrete_wall");
  k.wallAlongZ(8, 8.3, 1.25, 7.7, -WALL, 3.1, "concrete_wall");

  // Hazard bands near door A.
  box(4.4, 0.3, -1.25, 6.4, 0.6, -1.21, "hazard_stripe");
  box(4.4, 0.3, 1.21, 6.4, 0.6, 1.25, "hazard_stripe");
  // Pipes: along the north wall, round the bend and down the east wall.
  box(4.4, 2.4, -1.25, 10.8, 2.55, -1.1, "pipe");
  box(10.65, 2.4, -1.1, 10.8, 2.55, 7.7, "pipe");
  box(4.4, 2.65, 0.7, 10.8, 2.8, 0.85, "pipe");
  for (const x of [4.9, 6.4, 7.9, 9.4]) {
    box(x - 0.04, 2.25, -1.25, x + 0.04, 2.4, -1.1, "metal_panel");
  }
  for (const z of [2.0, 3.5, 5.0, 6.5]) {
    box(10.65, 2.25, z - 0.04, 10.8, 2.4, z + 0.04, "metal_panel");
  }
  // A second pipe down the west wall of the bend, a conduit on the south
  // wall and a few wall vents.
  box(8.3, 2.4, 1.25, 8.45, 2.55, 7.7, "pipe");
  for (const z of [2.0, 3.5, 5.0, 6.5]) {
    box(8.3, 2.25, z - 0.04, 8.45, 2.4, z + 0.04, "metal_panel");
  }
  box(4.5, 1.75, 1.13, 8.3, 1.85, 1.25, "pipe");
  for (const x of [5.2, 6.8]) {
    box(x - 0.04, 1.65, 1.13, x + 0.04, 1.75, 1.25, "metal_panel");
  }
  for (const x of [5.5, 7.0]) {
    box(x, 1.0, 1.21, x + 0.6, 1.4, 1.25, "rubber_dark");
  }
  box(8.3, 1.0, 3, 8.34, 1.4, 3.6, "rubber_dark");
  // Machine on the east wall with a feed pipe up to the run.
  box(10.3, 0, 3.2, 10.8, 1.6, 4.4, "metal_panel");
  box(10.3, 1.6, 3.2, 10.8, 1.65, 4.4, "rubber_dark");
  box(10.45, 1.65, 3.65, 10.6, 2.4, 3.8, "pipe");
  box(10.28, 0.9, 3.5, 10.3, 1.3, 4.1, "monitor_screen");
  // Fixtures: steady, flickering, and a dead one.
  k.fixture(5.9, 0, 2.8, 0.3, 0.1);
  k.fixture(9.55, 0, 2.8, 0.3, 0.1);
  k.fixture(9.55, 5, 2.8, 0.3, 0.1, "metal_panel");
  k.light(5.9, 2.4, 0, [1.0, 0.78, 0.5], 6.5, 1.1);
  // The two dynamic lights are confined to the corridor (they have no
  // shadows). The tube at the bend lights the bend and spills 0.8 m through
  // door A; its box stops at the pit's edge, so it can reach below the floor
  // without lighting the pit. The broken lamp hangs over the grate: its box
  // stops at the floor plane so nothing under the grate is lit by it.
  k.light(
    9.55,
    2.4,
    0,
    [0.9, 0.95, 1.0],
    6.5,
    1.3,
    "fluorescent",
    F.box(3.5, -WALL, -1.55, 11.1, 3.1, PIT.z0),
  );
  k.light(
    9.55,
    2.4,
    5,
    [1.0, 0.85, 0.6],
    5.5,
    1.0,
    "broken",
    F.box(8.0, -0.02, 0.95, 11.1, 3.1, 8.5),
  );
  // The pit's red pilot lamp: steady and dim, glowing up through the grate.
  k.light(9.05, -0.8, 5.15, [1.0, 0.3, 0.18], 2.6, 0.8);

  if (at.door !== undefined) {
    k.button(
      ctx.id("button_a_corridor"),
      at.door,
      4.3 + BUTTON_DEPTH,
      1.2,
      -1.08,
      [1, 0],
    );
  }
  k.emitter("hum_fluorescent", 9.55, 2.5, 0, 0.5);
  k.emitter("hum_machine", 10.1, 1.2, 3.8, 0.6);
  k.emitter("ambient_drone", 9.55, 1.5, 2, 0.4);
  k.zone(F.box(4.15, PIT.floor, -1.25, 10.8, 2.8, 1.25), "corridor");
  k.zone(F.box(8.3, PIT.floor, 1.25, 10.8, 2.8, 7.85), "corridor");

  const exit: Connector = {
    position: F.point(9.55, 0, 7.7),
    facing: F.dir(0, 0, 1),
    width: 2.5,
    height: 2.8,
  };
  const turn = F.point(9.55, 0, 0);
  return {
    footprint: [F.box(4.3, PIT.floor - 0.2, -1.55, 11.1, 3.1, 7.7)],
    entry: {
      connector: at,
      end: {
        wall: false,
        extent: rectOnPlane(at, F.box(4.3, -WALL, -1.55, 4.3, 3.1, 1.55)),
      },
    },
    exits: [
      {
        connector: exit,
        end: {
          wall: false,
          extent: rectOnPlane(exit, F.box(8.0, -WALL, 7.7, 11.1, 3.1, 7.7)),
        },
      },
    ],
    lock: NO_LOCK,
    solution: [
      { do: "walk", to: turn },
      { do: "walk", to: doorwayPoints(exit).before },
    ],
  };
}

export const SERVICE_CORRIDOR: RoomModule = {
  name: "service-corridor",
  role: "middle",
  teaches: "none",
  difficulty: 0,
  requires: {},
  // The entry frame and the button beside it must fit in the 2.5 m wide,
  // 2.8 m high corridor.
  entrySize: { width: [1.2, 1.5], height: [2.0, 2.6] },
  defaults: {},
  random: () => ({}),
  build: (ctx, at) => buildServiceCorridor(ctx, at),
};
