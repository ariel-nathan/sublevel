/**
 * The shell every puzzle room is built in: a rectangular room in the entry's
 * local frame (`LOCAL_DESIGN`: x metres in from the entry plane, z metres to
 * the right looking in, y up), walled at both doorways (room.ts rule 2), with
 * the standard exit doorway (1.6 x 2.4 m) in the far wall or a side wall,
 * optionally closed by a door, and a timed "way back" button beside the
 * entry for the previous module's door.
 *
 *   top view (not mirrored)            x0 = WALL, x1 = WALL + length
 *
 *        z0 - WALL +==================== left wall =====================+
 *                  |                                                    |
 *   entry plane -> E  interior x0..x1, z z0..z1, floor y 0, ceiling h   F far wall
 *        (x = 0)   |                                                    |
 *        z1 + WALL +==================== right wall ====================+
 *
 * The side walls run the whole outer length (x 0..x1 + WALL) and close the
 * corners; the entry and far walls run between them. The footprint is the
 * outer box, from `below` under the floor slab to the ceiling slab's top.
 */
import type { Aabb, ButtonDef, DoorDef } from "../../../core/api";
import type { MaterialId } from "../../../core/materials";
import type { Vec3 } from "../../../math";
import { createKit, type Kit, type Opening } from "../kit";
import {
  BAND,
  BUTTON_DEPTH,
  DOOR_OVERTRAVEL,
  doorwayPoints,
  LOCAL_DESIGN,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type Connector,
  type Doorway,
  type Frame,
  type RoomContext,
} from "../room";

/** The standard doorway every puzzle room leaves by. */
export const DOORWAY = { width: 1.6, height: 2.4 } as const;

/** Entry doorways every puzzle room can be built from. */
export const ENTRY_SIZE: {
  width: [number, number];
  height: [number, number];
} = { width: [1.4, 1.8], height: [2.2, 2.6] };

/** Seconds the way-back button holds the previous module's door open. */
export const RETURN_SECONDS = 6;

/** Distance a sliding door needs on its -lo side to hide in the wall. */
export const DOOR_POCKET = DOORWAY.width + DOOR_OVERTRAVEL + 0.05;

export type Side = "far" | "left" | "right";

export interface ShellSpec {
  /** Interior length along x (from x0 = WALL to x1 = WALL + length). */
  length: number;
  /** Interior extent to the left (z0 = -left) and right (z1 = right). */
  left: number;
  right: number;
  /** Ceiling height. */
  height: number;
  /**
   * The exit doorway: in which wall, centred where along it (z for the far
   * wall, x for a side wall), and whether a door (`ctx.id("door_exit")`)
   * closes it. A door slides into the wall towards lower z (far wall) or
   * lower x (side walls), so that side needs DOOR_POCKET of wall.
   */
  exit: { side: Side; at: number; door: boolean };
  floor: MaterialId;
  walls: MaterialId;
  ceiling: MaterialId;
  /** Material of the far wall (default `walls`). */
  farWall?: MaterialId;
  /** Leave the floor slab out (the module tiles its own). */
  noFloor?: boolean;
  /** Footprint depth under the floor slab's underside, for pits. */
  below?: number;
  /** Which side of the entry the way-back button goes (default right). */
  returnSide?: "left" | "right";
  /** Acoustics of the interior. */
  acoustics: "small" | "lab" | "corridor" | "hall";
  /**
   * Extra openings from the floor up through a side or far wall (into an
   * alcove the module builds and adds to the footprint): `a`..`b` along
   * the wall, `top` high, the sill under them filled.
   */
  holes?: { side: Side; a: number; b: number; top: number }[];
}

export interface Shell {
  k: Kit;
  F: Frame;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
  /** The entry doorway's half-width and height. */
  entryHalf: number;
  entryHeight: number;
  exit: Connector;
  exitDoor: DoorDef | null;
  /** The exit opening along its wall (z for far, x for sides). */
  exitLo: number;
  exitHi: number;
  footprint: Aabb[];
  entry: Doorway;
  exitDoorway: Doorway;
  /** The last point of the solution: just before the exit doorway. */
  before: Vec3;
  /** The way-back button (if the entry has a door), and where it is. */
  returnButton: ButtonDef | null;
  /** Design z of the way-back button on the entry wall. */
  returnZ: number;
  /** Design point helper at floor level. */
  P(x: number, z: number): Vec3;
}

/** Builds the shell; throws if the spec cannot hold its doorways. */
export function buildShell(
  ctx: RoomContext,
  at: Connector,
  spec: ShellSpec,
): Shell {
  const F = roomFrame(at, ctx.mirror, LOCAL_DESIGN);
  const k = createKit(ctx, F);
  const B = k.box;
  const x0 = W;
  const x1 = W + spec.length;
  const z0 = -spec.left;
  const z1 = spec.right;
  const h = spec.height;
  const below = spec.below ?? 0;
  const eh = at.width / 2;
  const dh = at.height;
  const { side, at: c } = spec.exit;
  const lo = c - DOORWAY.width / 2;
  const hi = c + DOORWAY.width / 2;
  const need = (ok: boolean, why: string) => {
    if (!ok) throw new Error(`puzzle shell: ${why}`);
  };
  need(
    -eh - BAND >= z0 + 0.1 && eh + BAND <= z1 - 0.1,
    "the entry does not fit",
  );
  need(h >= dh + 0.4 && h >= DOORWAY.height + 0.4, "the ceiling is too low");
  if (side === "far") {
    need(hi + BAND <= z1 - 0.05, "the far exit is too far right");
    need(
      lo - BAND >= z0 + 0.05 && (!spec.exit.door || lo - DOOR_POCKET >= z0 - W),
      "the far exit has no room for its door",
    );
  } else {
    need(hi + BAND <= x1 - 0.05, "the side exit is too far in");
    need(
      lo - BAND >= x0 + 0.05 && (!spec.exit.door || lo - DOOR_POCKET >= 0),
      "the side exit has no room for its door",
    );
  }
  const walls = spec.walls;
  const cut = (w: Side): Opening[] => [
    ...(side === w ? [{ a: lo, b: hi, top: DOORWAY.height }] : []),
    ...(spec.holes ?? [])
      .filter((o) => o.side === w)
      .map((o) => ({ a: o.a, b: o.b, top: o.top })),
  ];

  // Slabs.
  if (!spec.noFloor) B(x0, -W, z0, x1, 0, z1, spec.floor);
  B(x0, h, z0, x1, h + W, z1, spec.ceiling);
  // Entry wall with the entry doorway, framed on this side.
  k.wallAlongZ(
    0,
    W,
    z0,
    z1,
    -W - below,
    h + W,
    walls,
    [{ a: -eh, b: eh, top: dh }],
    "metal_panel",
  );
  k.frameX(W, 1, -eh, eh, dh);
  // Far wall and the side walls (the side walls close the corners).
  k.wallAlongZ(
    x1,
    x1 + W,
    z0,
    z1,
    -W - below,
    h + W,
    spec.farWall ?? walls,
    cut("far"),
    "metal_panel",
  );
  k.wallAlongX(
    0,
    x1 + W,
    z0 - W,
    z0,
    -W - below,
    h + W,
    walls,
    cut("left"),
    "metal_panel",
  );
  k.wallAlongX(
    0,
    x1 + W,
    z1,
    z1 + W,
    -W - below,
    h + W,
    walls,
    cut("right"),
    "metal_panel",
  );

  // The exit doorway: frame, door, connector, the wall's face on the plane.
  let exit: Connector;
  let face: Aabb;
  let exitDoor: DoorDef | null = null;
  const doorId = ctx.id("door_exit");
  const yb = -W - below;
  if (side === "far") {
    k.frameX(x1, -1, lo, hi, DOORWAY.height);
    if (spec.exit.door) {
      exitDoor = k.door(doorId, "x", x1, x1 + W, lo, hi, DOORWAY.height);
    }
    exit = {
      position: F.point(x1 + W, 0, c),
      facing: F.dir(1, 0, 0),
      width: DOORWAY.width,
      height: DOORWAY.height,
    };
    face = F.box(x1 + W, yb, z0 - W, x1 + W, h + W, z1 + W);
  } else if (side === "left") {
    k.frameZ(z0, 1, lo, hi, DOORWAY.height);
    if (spec.exit.door) {
      exitDoor = k.door(doorId, "z", z0 - W, z0, lo, hi, DOORWAY.height);
    }
    exit = {
      position: F.point(c, 0, z0 - W),
      facing: F.dir(0, 0, -1),
      width: DOORWAY.width,
      height: DOORWAY.height,
    };
    face = F.box(0, yb, z0 - W, x1 + W, h + W, z0 - W);
  } else {
    k.frameZ(z1, -1, lo, hi, DOORWAY.height);
    if (spec.exit.door) {
      exitDoor = k.door(doorId, "z", z1, z1 + W, lo, hi, DOORWAY.height);
    }
    exit = {
      position: F.point(c, 0, z1 + W),
      facing: F.dir(0, 0, 1),
      width: DOORWAY.width,
      height: DOORWAY.height,
    };
    face = F.box(0, yb, z1 + W, x1 + W, h + W, z1 + W);
  }
  if (exitDoor) exit.door = exitDoor.id;

  // The way back: a timed button for the previous module's door.
  const rs = spec.returnSide === "left" ? -1 : 1;
  const returnZ = rs * (eh + BAND + 0.45);
  let returnButton: ButtonDef | null = null;
  if (at.door !== undefined) {
    returnButton = k.button(
      ctx.id("button_back"),
      at.door,
      x0 + BUTTON_DEPTH,
      1.2,
      returnZ,
      [1, 0],
      "timed",
      RETURN_SECONDS,
    );
  }

  k.zone(F.box(x0, 0, z0, x1, h, z1), spec.acoustics);

  const footprint = [F.box(0, yb, z0 - W, x1 + W, h + W, z1 + W)];
  return {
    k,
    F,
    x0,
    x1,
    z0,
    z1,
    h,
    entryHalf: eh,
    entryHeight: dh,
    exit,
    exitDoor,
    exitLo: lo,
    exitHi: hi,
    footprint,
    entry: {
      connector: at,
      end: {
        wall: true,
        extent: rectOnPlane(at, F.box(0, yb, z0 - W, 0, h + W, z1 + W)),
      },
    },
    exitDoorway: {
      connector: exit,
      end: { wall: true, extent: rectOnPlane(exit, face) },
    },
    before: doorwayPoints(exit).before,
    returnButton,
    returnZ,
    P: (x, z) => F.point(x, 0, z),
  };
}

/**
 * Tiles the rectangle x0..x1, z0..z1 with boxes, leaving out `holes` (and
 * calling `inlay` for each hole's own fill, if given): a floor with flush
 * inlays, a slab with a pit cut out.
 */
export function tile(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  holes: { x0: number; z0: number; x1: number; z1: number }[],
  put: (x0: number, z0: number, x1: number, z1: number) => void,
): void {
  const xs = [...new Set([x0, x1, ...holes.flatMap((h) => [h.x0, h.x1])])]
    .filter((x) => x >= x0 && x <= x1)
    .sort((a, b) => a - b);
  const zs = [...new Set([z0, z1, ...holes.flatMap((h) => [h.z0, h.z1])])]
    .filter((z) => z >= z0 && z <= z1)
    .sort((a, b) => a - b);
  const inHole = (x: number, z: number) =>
    holes.some((h) => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1);
  // One box per run of free cells along x in each z band.
  for (let j = 0; j + 1 < zs.length; j++) {
    const zc = (zs[j] + zs[j + 1]) / 2;
    let start: number | null = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      const free = !inHole((xs[i] + xs[i + 1]) / 2, zc);
      if (free && start === null) start = xs[i];
      if (!free && start !== null) {
        put(start, zs[j], xs[i], zs[j + 1]);
        start = null;
      }
    }
    if (start !== null) put(start, zs[j], xs[xs.length - 1], zs[j + 1]);
  }
}
