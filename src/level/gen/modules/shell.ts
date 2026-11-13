/**
 * A plain rectangular room shell for the generator's own modules, written in
 * the entry's local frame (`LOCAL_DESIGN`: x metres in from the entry plane,
 * z metres to the right looking in, y up from the threshold). Walled at both
 * ends (room.ts rule 2), so it joins anything of the right size.
 *
 *   top view, exit ahead                exit to the right
 *
 *   x=0  W                X1  X1+W       x=0  W            X1  X1+W
 *   +====+================+===+          +====+==============+===+  z=-left-W
 *   |    |                |   |          |    |              |   |
 *   entry                    exit        entry                   |
 *   |    |                |   |          |    |              |   |
 *   +====+================+===+          +====+=====exit=====+===+  z=right+W
 *
 * The entry doorway is centred on z = 0. The exit doorway is `offset` metres
 * right of the axis (ahead) or `offset` metres in from the entry plane
 * (right). Mirroring the module turns a right exit into a left one.
 */
import type { Aabb } from "../../../core/api";
import type { MaterialId } from "../../../core/materials";
import { createKit, type Kit } from "../../rooms/kit";
import {
  BAND,
  DOOR_OVERTRAVEL,
  LOCAL_DESIGN,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type Connector,
  type Doorway,
  type Frame,
  type RoomContext,
} from "../../rooms/room";

export interface ShellSpec {
  /** Clear depth, from the entry wall's inner face to the far wall's. */
  depth: number;
  /** Clear extent to the left and right of the entry axis. */
  left: number;
  right: number;
  /** Ceiling height. */
  height: number;
  exit: {
    side: "ahead" | "right";
    /** Ahead: metres right of the axis; right: metres in from the entry plane. */
    offset: number;
    width: number;
    height: number;
  };
  floor: MaterialId;
  wall: MaterialId;
  ceiling: MaterialId;
}

export interface Shell {
  kit: Kit;
  frame: Frame;
  /** Inner face of the entry wall (x) and of the far wall. */
  x0: number;
  x1: number;
  /** Inner faces of the side walls (z). */
  zl: number;
  zr: number;
  height: number;
  exit: Connector;
  footprint: Aabb[];
  entryDoorway: Doorway;
  exitDoorway: Doorway;
  /** The exit's door slab is added by `door`; returns its final id. */
  door(id: string): string;
  /** The room's interior, world space (floor to ceiling). */
  interior: Aabb;
}

/** Smallest legal exit offset range for a shell (door slides need wall). */
export function exitOffsetRange(
  spec: Pick<ShellSpec, "depth" | "left" | "right">,
  side: "ahead" | "right",
  width: number,
): [number, number] {
  const slide = width + DOOR_OVERTRAVEL + 0.05;
  if (side === "ahead") {
    // Opening lo..hi in z; the slab slides towards -z into the wall.
    const lo = -spec.left + slide + width / 2;
    const hi = spec.right - BAND - 0.05 - width / 2;
    return [lo, hi];
  }
  // Opening lo..hi in x; the slab slides towards -x into the side wall.
  const lo = Math.max(W + slide + width / 2, W + BAND + 0.05 + width / 2);
  const hi = W + spec.depth - BAND - 0.05 - width / 2;
  return [lo, hi];
}

export function buildShell(
  ctx: RoomContext,
  at: Connector,
  spec: ShellSpec,
): Shell {
  const L = roomFrame(at, ctx.mirror, LOCAL_DESIGN);
  const k = createKit(ctx, L);
  const dw = at.width;
  const dh = at.height;
  const h = spec.height;
  const x0 = W;
  const x1 = W + spec.depth;
  const zl = -spec.left;
  const zr = spec.right;
  const ex = spec.exit;
  const lo = ex.offset - ex.width / 2;
  const hi = ex.offset + ex.width / 2;
  // A zero-width exit is a blank wall (a finish module's far end).
  const blank = ex.width <= 0;
  const opening = blank ? [] : [{ a: lo, b: hi, top: ex.height }];
  const doorOpening = [{ a: -dw / 2, b: dw / 2, top: dh }];

  k.box(x0, -W, zl, x1, 0, zr, spec.floor);
  k.box(x0, h, zl, x1, h + W, zr, spec.ceiling);
  k.wallAlongZ(0, x0, zl, zr, -W, h + W, spec.wall, doorOpening, "metal_panel");
  k.frameX(x0, 1, -dw / 2, dw / 2, dh);
  k.wallAlongX(0, x1 + W, zl - W, zl, -W, h + W, spec.wall);
  if (ex.side === "ahead") {
    k.wallAlongZ(
      x1,
      x1 + W,
      zl,
      zr,
      -W,
      h + W,
      spec.wall,
      opening,
      "metal_panel",
    );
    k.wallAlongX(0, x1 + W, zr, zr + W, -W, h + W, spec.wall);
    if (!blank) k.frameX(x1, -1, lo, hi, ex.height);
  } else {
    k.wallAlongZ(x1, x1 + W, zl, zr, -W, h + W, spec.wall);
    k.wallAlongX(
      0,
      x1 + W,
      zr,
      zr + W,
      -W,
      h + W,
      spec.wall,
      opening,
      "metal_panel",
    );
    if (!blank) k.frameZ(zr, -1, lo, hi, ex.height);
  }

  const exitAt =
    ex.side === "ahead"
      ? { position: L.point(x1 + W, 0, ex.offset), facing: L.dir(1, 0, 0) }
      : { position: L.point(ex.offset, 0, zr + W), facing: L.dir(0, 0, 1) };
  const exit: Connector = {
    ...exitAt,
    width: ex.width,
    height: ex.height,
  };
  const exitFace =
    ex.side === "ahead"
      ? L.box(x1 + W, -W, zl - W, x1 + W, h + W, zr + W)
      : L.box(0, -W, zr + W, x1 + W, h + W, zr + W);
  const shell: Shell = {
    kit: k,
    frame: L,
    x0,
    x1,
    zl,
    zr,
    height: h,
    exit,
    footprint: [L.box(0, -W, zl - W, x1 + W, h + W, zr + W)],
    entryDoorway: {
      connector: at,
      end: {
        wall: true,
        extent: rectOnPlane(at, L.box(0, -W, zl - W, 0, h + W, zr + W)),
      },
    },
    exitDoorway: {
      connector: exit,
      end: { wall: true, extent: rectOnPlane(exit, exitFace) },
    },
    door(id) {
      const def =
        ex.side === "ahead"
          ? k.door(id, "x", x1, x1 + W, lo, hi, ex.height)
          : k.door(id, "z", zr, zr + W, lo, hi, ex.height);
      exit.door = def.id;
      return def.id;
    },
    interior: L.box(x0, 0, zl, x1, h, zr),
  };
  return shell;
}

/** A recessed ceiling fixture with a steady (baked) light under it. */
export function ceilingLight(
  s: Shell,
  x: number,
  z: number,
  color: [number, number, number],
  radius: number,
  intensity: number,
): void {
  s.kit.fixture(x, z, s.height, 0.4, 0.2);
  s.kit.light(x, s.height - 0.4, z, color, radius, intensity);
}

/** The shell's acoustic zone: its clear space, both doorways' reveals included. */
export function shellZone(
  s: Shell,
  room: "small" | "lab" | "corridor" | "hall",
): void {
  s.kit.zone(s.frame.box(0, 0, s.zl, s.x1 + W, s.height, s.zr), room);
}

/** Rounds to 5 cm, as module parameters are. */
export const r05 = (v: number): number => Math.round(v * 20) / 20;
