/**
 * Stand-in puzzle room (impact target), for exercising the generator until
 * the real puzzle rooms land: a tall room whose exit door is latched open by
 * an impact target 4.2 m up over it, out of reach of the use key. Three
 * small crates by the left wall are the throwables.
 *
 *   side view                       top view
 *        [T]   4.2 m                +=================+
 *       [sign]                      | [s][s]   [s]    |
 *   entry   [door]                  entry       [T] exit
 *                                   +=================+
 */
import type { Rng } from "../../../core/rng";
import {
  doorwayPoints,
  IMPACT_BUTTON_DEPTH,
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

export interface TargetRoomParams {
  /** Clear depth 6..7.5 m, half-widths 2.4..3.2 m. */
  depth: number;
  left: number;
  right: number;
  /** 0..1 along the legal range of exit offsets. */
  exitAt: number;
}

const RANGES = {
  depth: [6, 7.5],
  left: [2.4, 3.2],
  right: [2.4, 3.2],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, v));

const HEIGHT = 5;
const TARGET_Y = 4.2;
/** Where the thrower stands: this far from the target's face. */
const THROW_DISTANCE = 3.3;

function build(ctx: RoomContext, at: Connector, p: TargetRoomParams): RoomPlan {
  const depth = clamp(p.depth, RANGES.depth);
  const left = clamp(p.left, RANGES.left);
  const right = clamp(p.right, RANGES.right);
  const [o0, o1] = exitOffsetRange({ depth, left, right }, "ahead", at.width);
  const offset = r05(o0 + (o1 - o0) * clamp(p.exitAt, [0, 1]));
  const s = buildShell(ctx, at, {
    depth,
    left,
    right,
    height: HEIGHT,
    exit: { side: "ahead", offset, width: at.width, height: at.height },
    floor: "concrete_floor",
    wall: "concrete_wall",
    ceiling: "concrete_wall",
  });
  const { kit: k, frame: L, x0, x1, zl, zr } = s;
  const door = s.door(ctx.id("door"));

  // The target on a striped plate over the door, a sign under it.
  const face = x1 - 0.02;
  k.box(
    face,
    TARGET_Y - 0.35,
    offset - 0.35,
    x1,
    TARGET_Y + 0.35,
    offset + 0.35,
    "hazard_stripe",
  );
  const target = k.button(
    ctx.id("target"),
    door,
    face - IMPACT_BUTTON_DEPTH,
    TARGET_Y,
    offset,
    [-1, 0],
    "impact",
  );
  k.box(x1 - 0.04, 2.8, offset - 0.4, x1, 3.6, offset + 0.4, "sign_warning");

  // Throwables along the left wall, a pipe run, a lamp before the target.
  const crates = [
    k.prop("crate_wood_small", x0 + 1.0, 0, zl + 0.5, 0.2),
    k.prop("crate_wood_small", x0 + 1.8, 0, zl + 0.6),
    k.prop("crate_wood_small", x0 + 2.8, 0, zl + 0.5, -0.3),
  ];
  k.box(x0, 2.6, zr - 0.15, x1, 2.75, zr, "pipe");
  k.box(x0, 3.4, zl, x1, 3.55, zl + 0.15, "pipe");
  ceilingLight(s, x1 - 1.6, offset, [0.9, 0.95, 1.0], 6, 1.6);
  ceilingLight(s, x0 + 1.6, (zl + zr) / 2, [1.0, 0.85, 0.65], 6.5, 1.1);
  k.emitter("hum_machine", x0 + 0.4, 1.0, zr - 0.4, 0.3);
  shellZone(s, "small");

  const stand = L.point(face - THROW_DISTANCE - IMPACT_BUTTON_DEPTH, 0, offset);
  const aim = L.point(face - IMPACT_BUTTON_DEPTH - 0.3, TARGET_Y, offset);
  return {
    footprint: s.footprint,
    entry: s.entryDoorway,
    exits: [s.exitDoorway],
    lock: {
      kind: "impact-target",
      doors: [door],
      buttons: [target.id],
      plates: [],
      keys: crates.map((prop, i) => ({
        prop,
        at: L.point(x0 + [1.0, 1.8, 2.8][i], 0.25, zl + [0.5, 0.6, 0.5][i]),
      })),
    },
    solution: [
      { do: "walk", to: stand },
      { do: "throw", prop: crates[1], at: aim },
      { do: "walk", to: doorwayPoints(s.exit).before },
    ],
  };
}

function random(rng: Rng): TargetRoomParams {
  return {
    depth: r05(rng.range(...RANGES.depth)),
    left: r05(rng.range(...RANGES.left)),
    right: r05(rng.range(...RANGES.right)),
    exitAt: Math.round(rng.next() * 20) / 20,
  };
}

export const STANDIN_TARGET: RoomModule<TargetRoomParams> = {
  name: "standin-target",
  role: "middle",
  teaches: "impact-target",
  difficulty: 2,
  requires: {},
  entrySize: { width: [1.2, 2.0], height: [2.2, 2.6] },
  defaults: { depth: 6.5, left: 2.8, right: 2.8, exitAt: 0.5 },
  random,
  build,
};
