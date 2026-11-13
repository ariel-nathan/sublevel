/**
 * A plain connecting corridor: the reference example of a parametric
 * module. Straight, or with one 90 degree bend left or right; optional pipe
 * run and ceiling light; no lock. Walled at both ends (room.ts rule 2), so
 * it joins anything, itself included. The exit doorway has the entry's
 * size.
 *
 * Design coordinates are the entry's local frame (`LOCAL_DESIGN`): x along
 * the entry's facing from its plane, z to the right, y up. Bending left is
 * bending right with z flipped.
 *
 *   straight (top view)            bend right
 *   x=0                      x=L   x=0                 x=L
 *   +====+=================+====+  +====+==============+====+
 *   |  entry   leg 1      exit  |  |  entry  leg 1  corner   |
 *   +====+=================+====+  +====+=======+         +=+
 *                                               |  leg 2  |
 *                                               +==exit===+
 */
import type { MaterialId } from "../../core/materials";
import type { Rng } from "../../core/rng";
import {
  doorwayPoints,
  LOCAL_DESIGN,
  NO_LOCK,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type Connector,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "./room";
import { createKit } from "./kit";

export interface CorridorParams {
  /** Outer length along the entry's facing, 3 to 10 m. */
  length: number;
  /** Clear width, 1.8 to 3.0 m (at least the doorway's width + 0.6). */
  width: number;
  /** Ceiling height, 2.6 to 3.4 m (at least the doorway's height + 0.4). */
  height: number;
  bend: "none" | "left" | "right";
  /** With a bend: how far the second leg runs past the first, 0 to 4 m. */
  leg: number;
  /** A pipe run along the outer wall under the ceiling. */
  pipes: boolean;
  /** One ceiling light: over the middle, or over the corner of a bend. */
  light: "none" | "steady" | "fluorescent" | "broken";
}

export const CORRIDOR_RANGES = {
  length: [3, 10],
  width: [1.8, 3.0],
  height: [2.6, 3.4],
  leg: [0, 4],
} as const;

const round = (v: number): number => Math.round(v * 20) / 20;
const clampTo = (v: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, v));

function randomCorridor(rng: Rng): CorridorParams {
  const pick = <T>(items: readonly T[]): T =>
    items[rng.int(0, items.length - 1)];
  return {
    length: round(rng.range(...CORRIDOR_RANGES.length)),
    width: round(rng.range(...CORRIDOR_RANGES.width)),
    height: round(rng.range(...CORRIDOR_RANGES.height)),
    bend: pick(["none", "left", "right"] as const),
    leg: round(rng.range(...CORRIDOR_RANGES.leg)),
    pipes: rng.next() < 0.5,
    light: pick(["none", "steady", "fluorescent", "broken"] as const),
  };
}

/** The dimensions actually built for a doorway and parameters. */
export function corridorSize(
  at: Pick<Connector, "width" | "height">,
  params: CorridorParams,
): { length: number; width: number; height: number; leg: number } {
  const width = Math.max(
    clampTo(params.width, CORRIDOR_RANGES.width),
    at.width + 0.6,
  );
  const height = Math.max(
    clampTo(params.height, CORRIDOR_RANGES.height),
    at.height + 0.4,
  );
  const bent = params.bend !== "none";
  return {
    width,
    height,
    leg: bent ? clampTo(params.leg, CORRIDOR_RANGES.leg) : 0,
    length: Math.max(
      clampTo(params.length, CORRIDOR_RANGES.length),
      bent ? width + 2 * W + 0.5 : 0,
    ),
  };
}

function buildCorridor(
  ctx: RoomContext,
  at: Connector,
  params: CorridorParams,
): RoomPlan {
  const L = roomFrame(at, ctx.mirror, LOCAL_DESIGN);
  const k = createKit(ctx, L);
  const dw = at.width;
  const dh = at.height;
  const { length: len, width: w, height: h, leg } = corridorSize(at, params);
  const hs = w / 2;
  const bent = params.bend !== "none";
  // z as built: bending left flips z.
  const sz = params.bend === "left" ? -1 : 1;
  const B = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    material: MaterialId,
  ): void =>
    sz > 0
      ? k.box(x0, y0, z0, x1, y1, z1, material)
      : k.box(x0, y0, -z1, x1, y1, -z0, material);
  const box = (x0: number, z0: number, x1: number, z1: number) =>
    sz > 0
      ? L.box(x0, -W, z0, x1, h + W, z1)
      : L.box(x0, -W, -z1, x1, h + W, -z0);
  const door = [{ a: -dw / 2, b: dw / 2, top: dh }];

  // Leg 1: floor, ceiling, the outer (left) wall and the entry wall.
  B(W, -W, -hs, len - W, 0, hs, "concrete_floor");
  B(W, h, -hs, len - W, h + W, hs, "concrete_wall");
  B(0, -W, -hs - W, len, h + W, -hs, "concrete_wall");
  k.wallAlongZ(0, W, -hs, hs, -W, h + W, "concrete_wall", door, "metal_panel");
  k.frameX(W, 1, -dw / 2, dw / 2, dh);

  let exit: Connector;
  let exitFace: ReturnType<typeof L.box>;
  const footprint = [box(0, -hs - W, len, hs + W)];
  let turn: ReturnType<typeof L.point> | null = null;
  let lightX = len / 2;
  if (!bent) {
    B(0, -W, hs, len, h + W, hs + W, "concrete_wall");
    k.wallAlongZ(
      len - W,
      len,
      -hs,
      hs,
      -W,
      h + W,
      "concrete_wall",
      door,
      "metal_panel",
    );
    k.frameX(len - W, -1, -dw / 2, dw / 2, dh);
    exit = {
      position: L.point(len, 0, 0),
      facing: L.dir(1, 0, 0),
      width: dw,
      height: dh,
    };
    exitFace = L.box(len, -W, -hs - W, len, h + W, hs + W);
  } else {
    // The corner is the last w metres of leg 1; leg 2 runs off to the right
    // (z > hs) from there and ends in the exit wall at z = end..end + W.
    const c0 = len - W - w;
    const c1 = len - W;
    const ac = (c0 + c1) / 2;
    const end = hs + leg;
    const lo = ac - dw / 2;
    const hi = ac + dw / 2;
    B(0, -W, hs, c0 - W, h + W, hs + W, "concrete_wall");
    B(c0 - W, -W, hs, c0, h + W, end + W, "concrete_wall");
    B(c1, -W, -hs, len, h + W, end + W, "concrete_wall");
    if (leg > 0) {
      B(c0, -W, hs, c1, 0, end, "concrete_floor");
      B(c0, h, hs, c1, h + W, end, "concrete_wall");
    }
    B(c0, -W, end, lo, h + W, end + W, "concrete_wall");
    B(lo, dh, end, hi, h + W, end + W, "concrete_wall");
    B(lo, -W, end, hi, 0, end + W, "metal_panel");
    B(hi, -W, end, c1, h + W, end + W, "concrete_wall");
    if (sz > 0) k.frameZ(end, -1, lo, hi, dh);
    else k.frameZ(-end, 1, lo, hi, dh);
    exit = {
      position: L.point(ac, 0, sz * (end + W)),
      facing: L.dir(0, 0, sz),
      width: dw,
      height: dh,
    };
    const face = box(c0 - W, end + W, len, end + W);
    exitFace = face;
    if (leg > 0) footprint.push(box(c0 - W, hs + W, len, end + W));
    turn = L.point(ac, 0, 0);
    lightX = ac;
  }

  // Dressing: a pipe on brackets along the outer wall.
  if (params.pipes) {
    B(W, h - 0.4, -hs, len - W, h - 0.25, -hs + 0.15, "pipe");
    for (let x = W + 0.6; x < len - W - 0.3; x += 1.5) {
      B(x - 0.04, h - 0.55, -hs, x + 0.04, h - 0.4, -hs + 0.15, "metal_panel");
    }
  }
  const light = params.light;
  if (light !== "none") {
    const steady = light === "steady";
    k.fixture(lightX, 0, h, 0.3, 0.12);
    // A dynamic light has no shadows: confine it to the first leg.
    k.light(
      lightX,
      h - 0.4,
      0,
      steady ? [1.0, 0.85, 0.65] : [0.9, 0.95, 1.0],
      Math.max(5, Math.min(8, len)),
      1.1,
      steady ? "none" : light,
      steady ? undefined : L.box(0, -W, -hs - W, len, h + W, hs + W),
    );
    if (params.light === "fluorescent") {
      k.emitter("hum_fluorescent", lightX, h - 0.3, 0, 0.4);
    }
  }
  // Acoustics: the corridor's clear space, doorways included.
  if (!bent) {
    k.zone(L.box(0, 0, -hs, len, h, hs), "corridor");
  } else {
    const c0 = len - W - w;
    k.zone(L.box(0, 0, -hs, len - W, h, hs), "corridor");
    const end = hs + leg + W;
    k.zone(
      sz > 0
        ? L.box(c0, 0, hs, len - W, h, end)
        : L.box(c0, 0, -end, len - W, h, -hs),
      "corridor",
    );
  }

  const solution: RoomPlan["solution"] = [];
  if (turn) solution.push({ do: "walk", to: turn });
  solution.push({ do: "walk", to: doorwayPoints(exit).before });
  return {
    footprint,
    entry: {
      connector: at,
      end: {
        wall: true,
        extent: rectOnPlane(at, L.box(0, -W, -hs - W, 0, h + W, hs + W)),
      },
    },
    exits: [
      {
        connector: exit,
        end: { wall: true, extent: rectOnPlane(exit, exitFace) },
      },
    ],
    lock: NO_LOCK,
    solution,
  };
}

export const CORRIDOR: RoomModule<CorridorParams> = {
  name: "corridor",
  role: "middle",
  teaches: "none",
  difficulty: 0,
  requires: {},
  entrySize: { width: [1.0, 2.0], height: [2.0, 2.6] },
  defaults: {
    length: 5,
    width: 2.2,
    height: 2.8,
    bend: "none",
    leg: 1,
    pipes: true,
    light: "fluorescent",
  },
  random: randomCorridor,
  build: buildCorridor,
};
