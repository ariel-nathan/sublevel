/**
 * A short straight passage that changes the doorway size, for joining two
 * modules whose doorways differ (a module that only takes a 2.5 x 2.8 m
 * entry after a 1.4 x 2.2 m exit), and whose exit wall can be widened to
 * close a module with an open entry end (room.ts rule 2: the neighbour's
 * wall must cover the open end's outline). No lock.
 *
 *   top view                        exit wall widened (`cover`)
 *   x=0                  x=L        x=0              x=L
 *   +====+===========+====+         +====+=======+====+====
 *   entry   passage    exit         entry  passage   exit   <- open end
 *   +====+===========+====+         +====+=======+====+====    butts here
 *
 * Design coordinates are the entry's local frame (`LOCAL_DESIGN`). The exit
 * is centred on the axis.
 */
import type { Rng } from "../../../core/rng";
import { createKit } from "../../rooms/kit";
import {
  doorwayPoints,
  LOCAL_DESIGN,
  NO_LOCK,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type Connector,
  type Rect,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "../../rooms/room";
import { r05 } from "./shell";

export interface AdapterParams {
  /** Outer length along the entry's facing, 2.0 to 3.0 m. */
  length: number;
  /** The exit doorway's clear width and height. */
  exitWidth: number;
  exitHeight: number;
  /**
   * A rectangle in the exit connector's coordinates (s to the right looking
   * out of the exit, y up) that the exit wall's outer face must cover, or
   * null: the wall is just the passage's end.
   */
  cover: Rect | null;
}

export const ADAPTER_SIZES = {
  width: [1.0, 2.6],
  height: [2.0, 2.9],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, v));

function build(ctx: RoomContext, at: Connector, p: AdapterParams): RoomPlan {
  const L = roomFrame(at, ctx.mirror, LOCAL_DESIGN);
  const k = createKit(ctx, L);
  const len = clamp(p.length, [2, 3]);
  const ew = clamp(p.exitWidth, ADAPTER_SIZES.width);
  const eh = clamp(p.exitHeight, ADAPTER_SIZES.height);
  const dw = at.width;
  const dh = at.height;
  const hs = Math.max(dw, ew) / 2 + 0.3;
  const h = Math.max(dh, eh) + 0.4;
  // The exit wall in design z (mirroring flips connector s to design -z).
  const m = ctx.mirror ? -1 : 1;
  let z0 = -hs - W;
  let z1 = hs + W;
  let y0 = -W;
  let y1 = h + W;
  if (p.cover) {
    const a = m * p.cover.s0;
    const b = m * p.cover.s1;
    z0 = Math.min(z0, Math.min(a, b));
    z1 = Math.max(z1, Math.max(a, b));
    y0 = Math.min(y0, p.cover.y0);
    y1 = Math.max(y1, p.cover.y1);
  }

  k.box(W, -W, -hs, len - W, 0, hs, "concrete_floor");
  k.box(W, h, -hs, len - W, h + W, hs, "metal_panel");
  k.box(0, -W, -hs - W, len - W, h + W, -hs, "metal_panel");
  k.box(0, -W, hs, len - W, h + W, hs + W, "metal_panel");
  k.wallAlongZ(
    0,
    W,
    -hs,
    hs,
    -W,
    h + W,
    "metal_panel",
    [{ a: -dw / 2, b: dw / 2, top: dh }],
    "metal_panel",
  );
  k.frameX(W, 1, -dw / 2, dw / 2, dh);
  // The exit wall, as large as it has to be; the sill fills down to y0.
  k.wallAlongZ(
    len - W,
    len,
    z0,
    z1,
    y0,
    y1,
    "concrete_wall",
    [{ a: -ew / 2, b: ew / 2, top: eh }],
    "metal_panel",
  );
  k.frameX(len - W, -1, -ew / 2, ew / 2, eh);
  // Hazard bands on the floor at the change of size, a steady lamp.
  k.box(W, 0, -hs, len - W, 0.01, -hs + 0.1, "hazard_stripe");
  k.box(W, 0, hs - 0.1, len - W, 0.01, hs, "hazard_stripe");
  k.fixture(len / 2, 0, h, 0.3, 0.12);
  k.light(len / 2, h - 0.4, 0, [1.0, 0.85, 0.65], 4.5, 1.0);
  k.zone(L.box(0, 0, -hs, len, h, hs), "corridor");

  const exit: Connector = {
    position: L.point(len, 0, 0),
    facing: L.dir(1, 0, 0),
    width: ew,
    height: eh,
  };
  const footprint = [L.box(0, -W, -hs - W, len - W, h + W, hs + W)];
  footprint.push(L.box(len - W, y0, z0, len, y1, z1));
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
        end: {
          wall: true,
          extent: rectOnPlane(exit, L.box(len, y0, z0, len, y1, z1)),
        },
      },
    ],
    lock: NO_LOCK,
    solution: [{ do: "walk", to: doorwayPoints(exit).before }],
  };
}

function random(rng: Rng): AdapterParams {
  return {
    length: r05(rng.range(2, 3)),
    exitWidth: r05(rng.range(...ADAPTER_SIZES.width)),
    exitHeight: r05(rng.range(...ADAPTER_SIZES.height)),
    cover:
      rng.next() < 0.5
        ? null
        : { s0: -3.2, s1: r05(rng.range(1, 3)), y0: -0.3, y1: 4.5 },
  };
}

export const ADAPTER: RoomModule<AdapterParams> = {
  name: "doorway-adapter",
  role: "middle",
  teaches: "none",
  difficulty: 0,
  requires: {},
  entrySize: {
    width: [...ADAPTER_SIZES.width],
    height: [...ADAPTER_SIZES.height],
  },
  defaults: { length: 2.4, exitWidth: 1.6, exitHeight: 2.4, cover: null },
  random,
  build,
};
