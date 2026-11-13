/**
 * What a self-contained room needs to build itself onto a level: the
 * builders it adds its parts with, and the doorway it attaches to.
 *
 * A room is a function `(ctx: RoomContext, at: Connector) => Info` that adds
 * every brush, light, prop, door, button, emitter and acoustic zone of its
 * own and reads no state outside its arguments. It works in a local frame
 * (`localFrame`) anchored on the connector, so the same room can be attached
 * to a doorway in any of the four horizontal directions.
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
import type { Vec3 } from "../../math";

/** The doorway a room is attached to, on the face of an existing wall. */
export interface Connector {
  /** Centre of the doorway's threshold, on the wall face the room starts at. */
  position: Vec3;
  /** Horizontal, axis-aligned unit vector pointing into the new room. */
  facing: Vec3;
  /** Width and height of the opening. */
  width: number;
  height: number;
}

/** Builders a room adds its parts with. All coordinates are world space. */
export interface RoomContext {
  /** A static brush. */
  box(min: Vec3, max: Vec3, material: MaterialId): void;
  light(def: LightDef): void;
  /** A prop whose bottom rests at `base.y`, centred on `base.x`, `base.z`. */
  prop(kind: PropKind, base: Vec3, yaw: number): void;
  door(def: DoorDef): void;
  button(def: ButtonDef): void;
  emitter(def: SoundEmitterDef): void;
  zone(zone: AcousticZone): void;
}

/**
 * Local coordinates of a room: `a` metres along the connector's facing (0 on
 * the wall face the room is built against), `y` up from the threshold, and
 * `s` metres to the right when looking along the facing.
 */
export interface LocalFrame {
  point(a: number, y: number, s: number): Vec3;
  /** World box spanning two local corners. */
  box(
    a0: number,
    y0: number,
    s0: number,
    a1: number,
    y1: number,
    s1: number,
  ): Aabb;
  /** World direction of a local vector. */
  dir(a: number, y: number, s: number): Vec3;
  /** Yaw (radians, 0 looks along -Z) of a local heading, 0 = along the facing. */
  yaw(localYaw: number): number;
}

/** Rounds to a micrometre so that walls meeting at a plane meet exactly. */
const snap = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

export function localFrame(at: Connector): LocalFrame {
  const f = at.facing;
  if (
    Math.abs(f.y) > 1e-9 ||
    Math.abs(Math.abs(f.x) + Math.abs(f.z) - 1) > 1e-9 ||
    (f.x !== 0 && f.z !== 0)
  ) {
    throw new Error("connector facing must be a horizontal axis");
  }
  // Right of the facing (right-handed, Y up): facing -Z has +X to its right.
  const r = { x: -f.z, z: f.x };
  const o = at.position;
  const point = (a: number, y: number, s: number): Vec3 => ({
    x: snap(o.x + f.x * a + r.x * s),
    y: snap(o.y + y),
    z: snap(o.z + f.z * a + r.z * s),
  });
  const facingYaw = Math.atan2(-f.x, -f.z);
  return {
    point,
    box(a0, y0, s0, a1, y1, s1) {
      const p = point(a0, y0, s0);
      const q = point(a1, y1, s1);
      return {
        min: {
          x: Math.min(p.x, q.x),
          y: Math.min(p.y, q.y),
          z: Math.min(p.z, q.z),
        },
        max: {
          x: Math.max(p.x, q.x),
          y: Math.max(p.y, q.y),
          z: Math.max(p.z, q.z),
        },
      };
    },
    dir: (a, y, s) => ({
      x: snap(f.x * a + r.x * s),
      y: snap(y),
      z: snap(f.z * a + r.z * s),
    }),
    yaw: (localYaw) => facingYaw + localYaw,
  };
}
