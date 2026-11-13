/**
 * Stand-in puzzle room (toggle button), for exercising the generator until
 * the real puzzle rooms land: the exit door is opened by a toggle button on
 * the left wall, past a waist-high barrier that is walked round at its
 * right-hand end.
 *
 *   top view (exit ahead)
 *   +=====================+
 *   |         |    [btn]  |
 *   entry     |           exit
 *   |         |           |
 *   |      (gap)          |
 *   +=====================+
 */
import type { Rng } from "../../../core/rng";
import {
  BUTTON_DEPTH,
  doorwayPoints,
  type Connector,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "../../rooms/room";
import { PRESS_STAND } from "../../rooms/solution";
import {
  buildShell,
  ceilingLight,
  exitOffsetRange,
  r05,
  shellZone,
} from "./shell";

export interface SwitchRoomParams {
  /** Clear depth 5..7 m, half-widths 2.4..3.2 m, ceiling 3.0..3.4 m. */
  depth: number;
  left: number;
  right: number;
  height: number;
  exit: "ahead" | "right";
  /** 0..1 along the legal range of exit offsets. */
  exitAt: number;
}

const RANGES = {
  depth: [5, 7],
  left: [2.4, 3.2],
  right: [2.4, 3.2],
  height: [3.0, 3.4],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, v));

/** Gap left at the right-hand end of the barrier. */
const GAP = 1.5;

function build(ctx: RoomContext, at: Connector, p: SwitchRoomParams): RoomPlan {
  const depth = clamp(p.depth, RANGES.depth);
  const left = clamp(p.left, RANGES.left);
  const right = clamp(p.right, RANGES.right);
  const height = clamp(p.height, RANGES.height);
  const [o0, o1] = exitOffsetRange({ depth, left, right }, p.exit, at.width);
  const offset = r05(o0 + (o1 - o0) * clamp(p.exitAt, [0, 1]));
  const s = buildShell(ctx, at, {
    depth,
    left,
    right,
    height,
    exit: { side: p.exit, offset, width: at.width, height: at.height },
    floor: "concrete_floor",
    wall: "concrete_wall",
    ceiling: "ceiling_panel",
  });
  const { kit: k, frame: L, x0, x1, zl, zr } = s;
  const door = s.door(ctx.id("door"));

  // The barrier: a steel rail wall across the room, open at its right end.
  const xm = r05(x0 + depth * 0.45);
  k.box(xm - 0.075, 0, zl, xm + 0.075, 1.0, zr - GAP, "metal_panel");
  k.box(xm - 0.09, 1.0, zl, xm + 0.09, 1.1, zr - GAP, "hazard_stripe");

  // The button on the left wall, beyond the barrier, under a sign.
  const bx = x1 - 1.2;
  const button = k.button(
    ctx.id("button"),
    door,
    bx,
    1.2,
    zl + BUTTON_DEPTH,
    [0, 1],
  );
  k.box(bx - 0.4, 1.6, zl, bx + 0.4, 2.2, zl + 0.04, "sign_warning");

  ceilingLight(s, x0 + depth * 0.3, 0, [0.95, 0.9, 0.8], 7, 1.2);
  ceilingLight(s, x1 - depth * 0.25, (zl + zr) / 2, [0.85, 0.92, 1.0], 7, 1.1);
  k.prop("crate_wood_small", x0 + 0.5, 0, zl + 0.45, 0.3);
  shellZone(s, "small");

  const P = (x: number, z: number) => L.point(x, 0, z);
  return {
    footprint: s.footprint,
    entry: s.entryDoorway,
    exits: [s.exitDoorway],
    lock: {
      kind: "toggle-button",
      doors: [door],
      buttons: [button.id],
      plates: [],
      keys: [],
    },
    solution: [
      { do: "walk", to: P(xm - 0.7, zr - GAP / 2) },
      { do: "walk", to: P(xm + 0.7, zr - GAP / 2) },
      { do: "walk", to: P(bx, zl + BUTTON_DEPTH + PRESS_STAND) },
      { do: "press", button: button.id },
      // A side exit may lie on the near side of the barrier: back past it.
      ...(p.exit === "right"
        ? [{ do: "walk" as const, to: P(xm + 0.7, zr - GAP / 2) }]
        : []),
      { do: "walk", to: doorwayPoints(s.exit).before },
    ],
  };
}

function random(rng: Rng): SwitchRoomParams {
  return {
    depth: r05(rng.range(...RANGES.depth)),
    left: r05(rng.range(...RANGES.left)),
    right: r05(rng.range(...RANGES.right)),
    height: r05(rng.range(...RANGES.height)),
    exit: rng.next() < 0.5 ? "ahead" : "right",
    exitAt: Math.round(rng.next() * 20) / 20,
  };
}

export const STANDIN_SWITCH: RoomModule<SwitchRoomParams> = {
  name: "standin-switch",
  role: "middle",
  teaches: "toggle-button",
  difficulty: 1,
  requires: {},
  entrySize: { width: [1.2, 2.0], height: [2.2, 2.6] },
  defaults: {
    depth: 6,
    left: 2.8,
    right: 2.8,
    height: 3.2,
    exit: "ahead",
    exitAt: 0.5,
  },
  random,
  build,
};
