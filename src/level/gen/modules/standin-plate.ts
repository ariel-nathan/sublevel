/**
 * Stand-in puzzle room (weighted plate), for exercising the generator until
 * the real puzzle rooms land: a pressure plate by the left wall holds the
 * exit door open while 20 kg rest on it. A wooden crate (25 kg) from the
 * stock in the near right corner does; the small crates (8 kg) do not.
 *
 *   top view (exit ahead)
 *   +=====================+
 *   |        [plate]      |
 *   entry                 exit
 *   |                     |
 *   | [c][c]  [s]         |
 *   +=====================+
 */
import type { Rng } from "../../../core/rng";
import {
  doorwayPoints,
  type Connector,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "../../rooms/room";
import {
  buildShell,
  ceilingLight,
  exitOffsetRange,
  r05,
  shellZone,
} from "./shell";

export interface PlateRoomParams {
  /** Clear depth 5.5..7.5 m, half-widths 2.6..3.4 m, ceiling 3.0..3.6 m. */
  depth: number;
  left: number;
  right: number;
  height: number;
  exit: "ahead" | "right";
  /** 0..1 along the legal range of exit offsets. */
  exitAt: number;
}

const RANGES = {
  depth: [5.5, 7.5],
  left: [2.6, 3.4],
  right: [2.6, 3.4],
  height: [3.0, 3.6],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, v));

export const PLATE_MASS = 20;
const PLATE = 1.2;

function build(ctx: RoomContext, at: Connector, p: PlateRoomParams): RoomPlan {
  const depth = clamp(p.depth, RANGES.depth);
  const left = clamp(p.left, RANGES.left);
  const right = clamp(p.right, RANGES.right);
  const height = clamp(p.height, RANGES.height);
  const [o0, o1] = exitOffsetRange({ depth, left, right }, p.exit, at.width);
  // Keep a side exit clear of the stock in the near corner.
  const lo = p.exit === "right" ? Math.max(o0, 3.4 + at.width / 2) : o0;
  const offset = r05(lo + (o1 - lo) * clamp(p.exitAt, [0, 1]));
  const s = buildShell(ctx, at, {
    depth,
    left,
    right,
    height,
    exit: { side: p.exit, offset, width: at.width, height: at.height },
    floor: "concrete_floor",
    wall: "metal_panel",
    ceiling: "concrete_wall",
  });
  const { kit: k, frame: L, x0, x1, zl, zr } = s;
  const door = s.door(ctx.id("door"));

  // The plate by the left wall, half way in, with a sign over it.
  const pc = { x: r05(x0 + depth * 0.55), z: zl + 1.1 };
  const plate = ctx.id("plate");
  ctx.plate({
    id: plate,
    box: L.box(
      pc.x - PLATE / 2,
      0,
      pc.z - PLATE / 2,
      pc.x + PLATE / 2,
      0.04,
      pc.z + PLATE / 2,
    ),
    requiredMass: PLATE_MASS,
    target: door,
  });
  k.box(pc.x - 0.5, 1.5, zl, pc.x + 0.5, 2.3, zl + 0.04, "sign_warning");
  k.box(pc.x - 0.9, 0, zl, pc.x + 0.9, 0.06, zl + 0.04, "hazard_stripe");

  // Stock in the near right corner: two wooden crates and a small one.
  const keyAt = { x: x0 + 2.0, z: zr - 0.7 };
  k.prop("crate_wood", x0 + 0.8, 0, zr - 0.7, 0.1);
  const key = k.prop("crate_wood", keyAt.x, 0, keyAt.z);
  k.prop("crate_wood_small", x0 + 0.7, 0, zr - 1.65, 0.4);
  // A pipe run along the right wall under the ceiling.
  k.box(x0, height - 0.45, zr - 0.15, x1, height - 0.3, zr, "pipe");

  ceilingLight(s, x0 + depth * 0.3, 0, [1.0, 0.88, 0.7], 7.5, 1.3);
  ceilingLight(s, x1 - depth * 0.3, (zl + zr) / 2, [1.0, 0.88, 0.7], 7.5, 1.2);
  shellZone(s, "hall");

  const P = (x: number, z: number) => L.point(x, 0, z);
  return {
    footprint: s.footprint,
    entry: s.entryDoorway,
    exits: [s.exitDoorway],
    lock: {
      kind: "weighted-plate",
      doors: [door],
      buttons: [],
      plates: [plate],
      keys: [{ prop: key, at: L.point(keyAt.x, 0.4, keyAt.z) }],
    },
    solution: [
      // Square in front of the plate, so that the crate is set down from
      // the side away from the left wall, well off the plate.
      { do: "walk", to: P(pc.x, pc.z + 2.4) },
      { do: "carry", prop: key, to: L.point(pc.x, 0.4, pc.z) },
      { do: "wait", for: "plate_down", seconds: 3 },
      { do: "walk", to: doorwayPoints(s.exit).before },
    ],
  };
}

function random(rng: Rng): PlateRoomParams {
  return {
    depth: r05(rng.range(...RANGES.depth)),
    left: r05(rng.range(...RANGES.left)),
    right: r05(rng.range(...RANGES.right)),
    height: r05(rng.range(...RANGES.height)),
    exit: rng.next() < 0.5 ? "ahead" : "right",
    exitAt: Math.round(rng.next() * 20) / 20,
  };
}

export const STANDIN_PLATE: RoomModule<PlateRoomParams> = {
  name: "standin-plate",
  role: "middle",
  teaches: "weighted-plate",
  difficulty: 1,
  requires: {},
  entrySize: { width: [1.2, 2.0], height: [2.2, 2.6] },
  defaults: {
    depth: 6.5,
    left: 3,
    right: 3,
    height: 3.2,
    exit: "ahead",
    exitAt: 0.6,
  },
  random,
  build,
};
