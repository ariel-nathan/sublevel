/**
 * Building blocks for writing a room module in its design coordinates:
 * every helper takes design-space numbers and goes through the module's
 * `Frame` to the world, so the same code builds the room facing any way.
 */
import type {
  Aabb,
  AcousticZone,
  ButtonDef,
  DoorDef,
  LightDef,
  PropKind,
  SoundEmitterDef,
} from "../../core/api";
import type { MaterialId } from "../../core/materials";
import {
  BAND,
  BAND_DEPTH,
  DOOR_INSET,
  DOOR_OVERTRAVEL,
  type Frame,
  type RoomContext,
} from "./room";

/** A doorway cut into a wall, from the floor (y = 0) up to `top`. */
export interface Opening {
  a: number;
  b: number;
  top: number;
}

export type Rgb = [number, number, number];

export interface Kit {
  readonly frame: Frame;
  /** A brush between two design corners. */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    material: MaterialId,
  ): void;
  /**
   * A wall running along design X (thin in Z) from xa to xb, with doorways
   * cut out; a sill (`sill` material) fills the space below each opening.
   */
  wallAlongX(
    xa: number,
    xb: number,
    z0: number,
    z1: number,
    yBot: number,
    yTop: number,
    material: MaterialId,
    openings?: Opening[],
    sill?: MaterialId,
  ): void;
  /** A wall running along design Z (thin in X), with doorways cut out. */
  wallAlongZ(
    x0: number,
    x1: number,
    za: number,
    zb: number,
    yBot: number,
    yTop: number,
    material: MaterialId,
    openings?: Opening[],
    sill?: MaterialId,
  ): void;
  /**
   * Hazard bands round a doorway in a wall facing design +/-X: `face` is the
   * X of the wall surface, `dir` the way the bands stand out, lo..hi the
   * opening along Z. Either jamb can be left out.
   */
  frameX(
    face: number,
    dir: 1 | -1,
    lo: number,
    hi: number,
    height: number,
    jambs?: { lo: boolean; hi: boolean },
  ): void;
  /** The same in a wall facing design +/-Z (opening lo..hi along X). */
  frameZ(
    face: number,
    dir: 1 | -1,
    lo: number,
    hi: number,
    height: number,
    jambs?: { lo: boolean; hi: boolean },
  ): void;
  /** Recessed ceiling fixture: thin slab just below the ceiling. */
  fixture(
    cx: number,
    cz: number,
    ceilY: number,
    hx: number,
    hz: number,
    material?: MaterialId,
  ): void;
  /** A light; `bounds` is already in world space (use `frame.box`). */
  light(
    x: number,
    y: number,
    z: number,
    color: Rgb,
    radius: number,
    intensity: number,
    flicker?: LightDef["flicker"],
    bounds?: Aabb,
  ): void;
  /** A prop resting at `baseY`, with a design yaw. Returns its local index. */
  prop(
    kind: PropKind,
    x: number,
    baseY: number,
    z: number,
    yaw?: number,
  ): number;
  /** A prop with a yaw relative to the design facing. */
  propTurned(
    kind: PropKind,
    x: number,
    baseY: number,
    z: number,
    relativeYaw: number,
  ): number;
  emitter(
    sound: SoundEmitterDef["sound"],
    x: number,
    y: number,
    z: number,
    gain: number,
  ): void;
  /** A zone; `box` is already in world space. */
  zone(box: Aabb, room: AcousticZone["room"]): void;
  /**
   * A sliding door in a wall thin along `axis` (wall spans w0..w1 on that
   * axis), closing the opening lo..hi on the other horizontal axis. The slab
   * is inset DOOR_INSET from each wall face and slides towards -lo into the
   * wall, DOOR_OVERTRAVEL past the jamb. `id` is final (ctx.id).
   */
  door(
    id: string,
    axis: "x" | "z",
    w0: number,
    w1: number,
    lo: number,
    hi: number,
    height: number,
  ): DoorDef;
  /** A wall button; `facing` is a design direction out of the wall. */
  button(
    id: string,
    target: string,
    x: number,
    y: number,
    z: number,
    facing: [number, number],
    mode?: ButtonDef["mode"],
    seconds?: number,
  ): ButtonDef;
}

export function createKit(ctx: RoomContext, F: Frame): Kit {
  const box: Kit["box"] = (x0, y0, z0, x1, y1, z1, material) => {
    if (!(x0 < x1 && y0 < y1 && z0 < z1)) {
      throw new Error(`degenerate brush ${[x0, y0, z0, x1, y1, z1].join(",")}`);
    }
    const b = F.box(x0, y0, z0, x1, y1, z1);
    ctx.box(b.min, b.max, material);
  };
  const frameBands = (
    put: (
      u0: number,
      y0: number,
      v0: number,
      u1: number,
      y1: number,
      v1: number,
    ) => void,
    face: number,
    dir: 1 | -1,
    lo: number,
    hi: number,
    height: number,
    jambs: { lo: boolean; hi: boolean },
  ): void => {
    const u0 = dir > 0 ? face : face - BAND_DEPTH;
    const u1 = dir > 0 ? face + BAND_DEPTH : face;
    if (jambs.lo) put(u0, 0, lo - BAND, u1, height, lo);
    if (jambs.hi) put(u0, 0, hi, u1, height, hi + BAND);
    put(
      u0,
      height,
      jambs.lo ? lo - BAND : lo,
      u1,
      height + BAND,
      jambs.hi ? hi + BAND : hi,
    );
  };
  const both = { lo: true, hi: true };
  return {
    frame: F,
    box,
    wallAlongX(xa, xb, z0, z1, yBot, yTop, material, openings = [], sill) {
      let cur = xa;
      for (const o of [...openings].sort((p, q) => p.a - q.a)) {
        if (o.a > cur) box(cur, yBot, z0, o.a, yTop, z1, material);
        box(o.a, o.top, z0, o.b, yTop, z1, material);
        box(o.a, yBot, z0, o.b, 0, z1, sill ?? material);
        cur = o.b;
      }
      if (cur < xb) box(cur, yBot, z0, xb, yTop, z1, material);
    },
    wallAlongZ(x0, x1, za, zb, yBot, yTop, material, openings = [], sill) {
      let cur = za;
      for (const o of [...openings].sort((p, q) => p.a - q.a)) {
        if (o.a > cur) box(x0, yBot, cur, x1, yTop, o.a, material);
        box(x0, o.top, o.a, x1, yTop, o.b, material);
        box(x0, yBot, o.a, x1, 0, o.b, sill ?? material);
        cur = o.b;
      }
      if (cur < zb) box(x0, yBot, cur, x1, yTop, zb, material);
    },
    frameX(face, dir, lo, hi, height, jambs = both) {
      frameBands(
        (u0, y0, v0, u1, y1, v1) =>
          box(u0, y0, v0, u1, y1, v1, "hazard_stripe"),
        face,
        dir,
        lo,
        hi,
        height,
        jambs,
      );
    },
    frameZ(face, dir, lo, hi, height, jambs = both) {
      frameBands(
        (u0, y0, v0, u1, y1, v1) =>
          box(v0, y0, u0, v1, y1, u1, "hazard_stripe"),
        face,
        dir,
        lo,
        hi,
        height,
        jambs,
      );
    },
    fixture(cx, cz, ceilY, hx, hz, material = "light_panel") {
      box(cx - hx, ceilY - 0.06, cz - hz, cx + hx, ceilY, cz + hz, material);
    },
    light(x, y, z, color, radius, intensity, flicker = "none", bounds) {
      const def: LightDef = {
        position: F.point(x, y, z),
        color: { x: color[0], y: color[1], z: color[2] },
        radius,
        intensity,
        flicker,
      };
      if (bounds) def.bounds = bounds;
      ctx.light(def);
    },
    prop: (kind, x, baseY, z, yaw = 0) =>
      ctx.prop(kind, F.point(x, baseY, z), F.yaw(yaw)),
    propTurned: (kind, x, baseY, z, relativeYaw) =>
      ctx.prop(kind, F.point(x, baseY, z), F.turn(relativeYaw)),
    emitter(sound, x, y, z, gain) {
      ctx.emitter({ sound, position: F.point(x, y, z), gain });
    },
    zone(b, room) {
      ctx.zone({ box: b, room });
    },
    door(id, axis, w0, w1, lo, hi, height) {
      const travel = -(hi - lo + DOOR_OVERTRAVEL);
      const def: DoorDef =
        axis === "x"
          ? {
              id,
              closed: F.box(
                w0 + DOOR_INSET,
                0,
                lo,
                w1 - DOOR_INSET,
                height,
                hi,
              ),
              openOffset: F.dir(0, 0, travel),
              material: "door_steel",
            }
          : {
              id,
              closed: F.box(
                lo,
                0,
                w0 + DOOR_INSET,
                hi,
                height,
                w1 - DOOR_INSET,
              ),
              openOffset: F.dir(travel, 0, 0),
              material: "door_steel",
            };
      ctx.door(def);
      return def;
    },
    button(id, target, x, y, z, facing, mode, seconds) {
      const def: ButtonDef = {
        id,
        position: F.point(x, y, z),
        facing: F.dir(facing[0], 0, facing[1]),
        target,
      };
      if (mode !== undefined) def.mode = mode;
      if (seconds !== undefined) def.seconds = seconds;
      ctx.button(def);
      return def;
    },
  };
}
