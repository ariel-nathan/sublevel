/**
 * The valve chamber of Kestrel Annex, beyond door T: its exit door is
 * latched open by an impact target 4.2 m up on the wall above it, out of
 * reach of the use key; a prop thrown at it opens the door for good.
 * Everything thrown at it falls back to the chamber floor, and the chamber
 * holds four throwables. Its entry end is open: the filtration hall's far
 * wall closes it.
 *
 * Design coordinates are the filtration hall's (its entry's local frame),
 * so the numbers match the hall's; the entry is door T at (11.6, 0, -2.1)
 * facing +X. The chamber is x 11.6..17.6, z -5..0.6, ceiling 5.0; the exit
 * door is z -2.9..-1.5 in the wall x 17.6..17.9.
 */
import type { Aabb } from "../../core/api";
import type { Vec3 } from "../../math";
import {
  BUTTON_DEPTH,
  doorwayPoints,
  IMPACT_BUTTON_DEPTH,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type Connector,
  type DesignAnchor,
  type Frame,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "./room";
import { TIMED_SECONDS } from "./filtration-hall";
import { createKit } from "./kit";

export const VALVE_CHAMBER_DESIGN: DesignAnchor = {
  position: { x: 11.6, y: 0, z: -2.1 },
  facing: { x: 1, y: 0, z: 0 },
};

/** Where the hall's door T was, in design space: the entry doorway. */
const DOOR_T = { s0: -3.1, s1: -1.1, h: 2.4 };
const CH = { a0: 11.6, a1: 17.6, s0: -5, s1: 0.6, h: 5 };
const EXIT_DOOR = { s0: -2.9, s1: -1.5, h: 2.4 };
const TARGET = { y: 4.2, s: -2.2 };
const TARGET_FACE = CH.a1 - 0.02;

export interface ValveChamberInfo {
  chamber: Aabb;
  exitDoor: string;
  /** The chamber-side timed button for the entry door. */
  innerButton: string;
  impactButton: string;
}

function chamberInfo(
  L: Frame,
  id: (local: string) => string,
): ValveChamberInfo {
  return {
    chamber: L.box(CH.a0, 0, CH.s0, CH.a1, CH.h, CH.s1),
    exitDoor: id("door_exit"),
    innerButton: id("button_t_chamber"),
    impactButton: id("button_exit_target"),
  };
}

export function describeValveChamber(
  at: Connector,
  mirror = false,
  id: (local: string) => string = (local) => local,
): ValveChamberInfo {
  return chamberInfo(roomFrame(at, mirror, VALVE_CHAMBER_DESIGN), id);
}

function buildValveChamber(ctx: RoomContext, at: Connector): RoomPlan {
  const L = roomFrame(at, ctx.mirror, VALVE_CHAMBER_DESIGN);
  const k = createKit(ctx, L);
  const B = k.box;

  B(CH.a0, -W, CH.s0, CH.a1, 0, CH.s1, "concrete_floor");
  B(CH.a0, CH.h, CH.s0, CH.a1, CH.h + W, CH.s1, "concrete_wall");
  k.wallAlongX(
    CH.a0,
    CH.a1 + W,
    CH.s0 - W,
    CH.s0,
    -W,
    CH.h + W,
    "concrete_wall",
  );
  k.wallAlongX(
    CH.a0,
    CH.a1 + W,
    CH.s1,
    CH.s1 + W,
    -W,
    CH.h + W,
    "concrete_wall",
  );
  k.wallAlongZ(
    CH.a1,
    CH.a1 + W,
    CH.s0,
    CH.s1,
    -W,
    CH.h + W,
    "concrete_wall",
    [{ a: EXIT_DOOR.s0, b: EXIT_DOOR.s1, top: EXIT_DOOR.h }],
    "metal_panel",
  );
  // The entry's frame on this side, on the face of the hall's far wall.
  k.frameX(CH.a0, 1, DOOR_T.s0, DOOR_T.s1, DOOR_T.h);
  k.frameX(CH.a1, -1, EXIT_DOOR.s0, EXIT_DOOR.s1, EXIT_DOOR.h);

  // The way back: a timed button for the entry door, beside it.
  if (at.door !== undefined) {
    k.button(
      ctx.id("button_t_chamber"),
      at.door,
      CH.a0 + BUTTON_DEPTH,
      1.2,
      -0.4,
      [1, 0],
      "timed",
      TIMED_SECONDS,
    );
  }

  // The impact target, 4.2 m up over the exit door on a striped plate,
  // with a warning sign under it and a bright lamp in front of it.
  B(
    TARGET_FACE,
    TARGET.y - 0.35,
    TARGET.s - 0.35,
    CH.a1,
    TARGET.y + 0.35,
    TARGET.s + 0.35,
    "hazard_stripe",
  );
  const target = k.button(
    ctx.id("button_exit_target"),
    ctx.id("door_exit"),
    TARGET_FACE - IMPACT_BUTTON_DEPTH,
    TARGET.y,
    TARGET.s,
    [-1, 0],
    "impact",
  );
  B(
    CH.a1 - 0.04,
    2.8,
    TARGET.s - 0.4,
    CH.a1,
    3.6,
    TARGET.s + 0.4,
    "sign_warning",
  );

  // Dressing: a valve manifold on the left wall, a console on the right,
  // pipe runs.
  B(13.2, 0, CH.s0, 14.4, 1.2, -4.4, "metal_panel");
  B(13.2, 1.2, CH.s0, 14.4, 1.25, -4.4, "rubber_dark");
  B(13.6, 0.5, -4.4, 14.0, 0.9, -4.36, "hazard_stripe");
  for (const a of [13.4, 14.0]) {
    B(a, 1.25, -4.85, a + 0.15, CH.h, -4.7, "pipe");
  }
  B(CH.a0, 2.6, CH.s0, CH.a1, 2.75, CH.s0 + 0.15, "pipe");
  B(CH.a0, 4.5, -0.2, CH.a1, 4.65, -0.05, "pipe");
  B(CH.a0, 4.5, 0.15, CH.a1, 4.65, 0.3, "pipe");
  B(13.0, 0, 0.05, 15.5, 0.9, CH.s1, "metal_panel");
  B(13.0, 0.9, 0, 15.5, 0.95, CH.s1, "plastic_white");
  B(13.5, 1.3, CH.s1 - 0.04, 15.0, 2.0, CH.s1, "monitor_screen");

  const chamberBounds = L.box(
    CH.a0 - 0.8,
    -W,
    CH.s0 - W,
    CH.a1 + W + 0.5,
    CH.h + W,
    CH.s1 + W,
  );
  k.fixture(16.0, TARGET.s, CH.h, 0.3, 0.15);
  k.light(16.0, 4.55, TARGET.s, [0.9, 0.95, 1.0], 5.5, 1.6);
  k.fixture(13.2, -0.6, CH.h, 0.3, 0.15);
  k.light(13.2, 4.5, -0.6, [1.0, 0.8, 0.55], 6.5, 1.1, "broken", chamberBounds);

  const throwables = [
    k.propTurned("crate_wood_small", 13.0, 0, -4.0, 0.2),
    k.propTurned("crate_wood_small", 12.3, 0, -3.2, 0),
    k.propTurned("chair", 15.8, 0, -0.4, -0.6),
    k.propTurned("monitor", 14.2, 0.95, 0.3, Math.PI / 2),
  ];

  k.emitter("hum_machine", 13.8, 1.0, -4.6, 0.4);

  const exitDoor = k.door(
    ctx.id("door_exit"),
    "x",
    CH.a1,
    CH.a1 + W,
    EXIT_DOOR.s0,
    EXIT_DOOR.s1,
    EXIT_DOOR.h,
  );
  k.zone(L.box(CH.a0 - 0.15, 0, CH.s0, CH.a1 + 0.15, CH.h, CH.s1), "small");

  const exit: Connector = {
    position: L.point(CH.a1 + W, 0, (EXIT_DOOR.s0 + EXIT_DOOR.s1) / 2),
    facing: L.dir(1, 0, 0),
    width: EXIT_DOOR.s1 - EXIT_DOOR.s0,
    height: EXIT_DOOR.h,
    door: exitDoor.id,
  };
  const P = (a: number, s: number): Vec3 => L.point(a, 0, s);
  // Aim the prop's centre a crate's half-width in front of the target, where
  // its leading face meets it.
  const aim = L.point(
    TARGET_FACE - IMPACT_BUTTON_DEPTH - 0.3,
    TARGET.y,
    TARGET.s,
  );
  const keyAt = [
    L.point(13.0, 0.25, -4.0),
    L.point(12.3, 0.25, -3.2),
    L.point(15.8, 0.45, -0.4),
    L.point(14.2, 1.15, 0.3),
  ];
  return {
    footprint: [L.box(CH.a0, -W, CH.s0 - W, CH.a1 + W, CH.h + W, CH.s1 + W)],
    entry: {
      connector: at,
      end: {
        wall: false,
        extent: rectOnPlane(
          at,
          L.box(CH.a0, -W, CH.s0 - W, CH.a0, CH.h + W, CH.s1 + W),
        ),
      },
    },
    exits: [
      {
        connector: exit,
        end: {
          wall: true,
          extent: rectOnPlane(
            exit,
            L.box(CH.a1 + W, -W, CH.s0 - W, CH.a1 + W, CH.h + W, CH.s1 + W),
          ),
        },
      },
    ],
    lock: {
      kind: "impact-target",
      doors: [exitDoor.id],
      buttons: [target.id],
      plates: [],
      keys: throwables.map((prop, i) => ({ prop, at: keyAt[i] })),
    },
    solution: [
      { do: "walk", to: P(TARGET_FACE - 3.3 - IMPACT_BUTTON_DEPTH, TARGET.s) },
      { do: "throw", prop: throwables[1], at: aim },
      { do: "walk", to: doorwayPoints(exit).before },
    ],
  };
}

export const VALVE_CHAMBER: RoomModule = {
  name: "valve-chamber",
  role: "middle",
  teaches: "impact-target",
  difficulty: 2,
  requires: {},
  setPiece: true,
  idea: "high-target",
  // The entry frame on this side is laid out for door T's opening.
  entrySize: { width: [2.0, 2.0], height: [2.4, 2.4] },
  defaults: {},
  random: () => ({}),
  build: (ctx, at) => buildValveChamber(ctx, at),
};
