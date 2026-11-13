/**
 * The egress lock of Kestrel Annex: a small room past the valve chamber's
 * exit door with the level's exit box. A finish module; its entry end is
 * open (the chamber's wall closes it).
 *
 * Design coordinates are the filtration hall's, like the valve chamber's;
 * the entry is the exit door at (17.9, 0, -2.2) facing +X and the lock is
 * x 17.9..20.9, z -3.7..-0.7, ceiling 3.0.
 */
import type { Aabb } from "../../core/api";
import {
  NO_LOCK,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type Connector,
  type DesignAnchor,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "./room";
import { createKit } from "./kit";

export const EGRESS_LOCK_DESIGN: DesignAnchor = {
  position: { x: 17.9, y: 0, z: -2.2 },
  facing: { x: 1, y: 0, z: 0 },
};

const LOCK = { a0: 17.9, a1: 20.9, s0: -3.7, s1: -0.7, h: 3 };
const ENTRY = { s0: -2.9, s1: -1.5, h: 2.4 };

/** The lock's interior, world space. */
export function describeEgressLock(at: Connector, mirror = false): Aabb {
  return roomFrame(at, mirror, EGRESS_LOCK_DESIGN).box(
    LOCK.a0,
    0,
    LOCK.s0,
    LOCK.a1,
    LOCK.h,
    LOCK.s1,
  );
}

function buildEgressLock(ctx: RoomContext, at: Connector): RoomPlan {
  const L = roomFrame(at, ctx.mirror, EGRESS_LOCK_DESIGN);
  const k = createKit(ctx, L);
  const B = k.box;

  B(LOCK.a0, -W, LOCK.s0, LOCK.a1, 0, LOCK.s1, "lab_floor_tile");
  B(LOCK.a0, LOCK.h, LOCK.s0, LOCK.a1, LOCK.h + W, LOCK.s1, "metal_panel");
  k.wallAlongX(
    LOCK.a0,
    LOCK.a1 + W,
    LOCK.s0 - W,
    LOCK.s0,
    -W,
    LOCK.h + W,
    "metal_panel",
  );
  k.wallAlongX(
    LOCK.a0,
    LOCK.a1 + W,
    LOCK.s1,
    LOCK.s1 + W,
    -W,
    LOCK.h + W,
    "metal_panel",
  );
  k.wallAlongZ(
    LOCK.a1,
    LOCK.a1 + W,
    LOCK.s0,
    LOCK.s1,
    -W,
    LOCK.h + W,
    "metal_panel",
  );
  k.frameX(LOCK.a0, 1, ENTRY.s0, ENTRY.s1, ENTRY.h);
  B(LOCK.a1 - 0.04, 1, -2.7, LOCK.a1, 2, -1.7, "monitor_screen");
  B(19.2, 1, LOCK.s0, 20.2, 2, LOCK.s0 + 0.04, "sign_warning");
  B(19.2, 1, LOCK.s1 - 0.04, 20.2, 2, LOCK.s1, "sign_warning");
  k.fixture(19.1, -2.2, LOCK.h, 0.3, 0.3, "button_green");
  k.light(19.1, 2.55, -2.2, [0.35, 1.0, 0.45], 4.5, 1.6);

  k.zone(L.box(LOCK.a0 - 0.15, 0, LOCK.s0, LOCK.a1, LOCK.h, LOCK.s1), "small");
  const exit = L.box(LOCK.a0 + 1, 0, LOCK.s0, LOCK.a1, LOCK.h, LOCK.s1);
  return {
    footprint: [
      L.box(LOCK.a0, -W, LOCK.s0 - W, LOCK.a1 + W, LOCK.h + W, LOCK.s1 + W),
    ],
    entry: {
      connector: at,
      end: {
        wall: false,
        extent: rectOnPlane(
          at,
          L.box(LOCK.a0, -W, LOCK.s0 - W, LOCK.a0, LOCK.h + W, LOCK.s1 + W),
        ),
      },
    },
    exits: [],
    exit,
    lock: NO_LOCK,
    solution: [
      {
        do: "walk",
        to: L.point((LOCK.a0 + 1 + LOCK.a1) / 2, 0, (LOCK.s0 + LOCK.s1) / 2),
      },
    ],
  };
}

export const EGRESS_LOCK: RoomModule = {
  name: "egress-lock",
  role: "finish",
  teaches: "none",
  difficulty: 0,
  requires: {},
  entrySize: { width: [1.4, 1.4], height: [2.4, 2.4] },
  defaults: {},
  random: () => ({}),
  build: (ctx, at) => buildEgressLock(ctx, at),
};
