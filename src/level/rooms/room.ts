/**
 * Room modules: the pieces a level is assembled from. See README.md in
 * src/level for the walkthrough; this file is the contract.
 *
 * A module is a function that builds one room (or a short run of rooms)
 * onto a level from the doorway it is attached to, its entry `Connector`,
 * and reports what it built: its footprint, its exit doorways, its lock and
 * the steps that solve it. It works in a frame anchored on the entry
 * (`roomFrame`), so the same module can be attached to a doorway facing any
 * of the four horizontal directions, optionally mirrored left to right.
 *
 * The doorway rule (how two modules meet):
 *
 *   1. Two modules meet on a plane, the connector plane. Each footprint ends
 *      on it and everything a module emits lies on its own side, except that
 *      acoustic zones may reach ZONE_REACH and dynamic light bounds
 *      LIGHT_REACH across it (light shines a little way through a doorway).
 *   2. At each of its doorways a module either has its own wall (`end.wall`:
 *      a wall standing against the plane with the opening, exactly the
 *      connector's width and height from the floor, cut through it, and the
 *      sill under the opening filled), or none (an open end: its floor,
 *      walls and ceiling simply stop at the plane). An open end is closed by
 *      the neighbour's wall, which must cover the open end's whole outline.
 *      Two walled ends stand back to back; two open ends may not meet.
 *   3. A door slab belongs to the module you leave through the doorway (the
 *      exit side), recessed in that module's own wall, together with
 *      everything that opens it. The module on the entry side may add
 *      buttons for it on its own side: `Connector.door` gives the door's id.
 *   4. Each module dresses its own side: the hazard frame round the opening
 *      on the face it looks at (its own wall's, or the neighbour's through
 *      an open end).
 *
 *   top view, A's exit = B's entry; ==== wall, :: door slab, | plane
 *
 *     walled / walled          walled / open           open / walled
 *     A ====|==== B            A ====|  B              A     |==== B
 *         ::|                      ::|                       |
 *     A ====|==== B            A ====|  B              A     |==== B
 *
 * Modules use the builders in `RoomContext` and never read state outside
 * their arguments; given the same entry, parameters and rng they build the
 * same thing (planning without building is `planRoom` in assemble.ts).
 */
import type {
  Aabb,
  AcousticZone,
  ButtonDef,
  DoorDef,
  LightDef,
  PressurePlateDef,
  PropKind,
  SolutionStep,
  SoundEmitterDef,
} from "../../core/api";
import type { MaterialId } from "../../core/materials";
import type { Rng } from "../../core/rng";
import type { Vec3 } from "../../math";

// ---------------------------------------------------------------------------
// Shared dimensions
// ---------------------------------------------------------------------------

/** Wall, floor and ceiling thickness. */
export const WALL = 0.3;
/** Width of the hazard bands framing a doorway, and how far they stand out. */
export const BAND = 0.15;
export const BAND_DEPTH = 0.1;
/**
 * How far a door slab is inset from each face of its wall. The slab is
 * thinner than the wall and centred in it, so it reads as recessed in its
 * frame, and when open it is hidden entirely inside the wall.
 */
export const DOOR_INSET = 0.07;
/** How far past the far jamb an open slab ends up, inside the wall. */
export const DOOR_OVERTRAVEL = 0.05;
/**
 * Distance from the wall surface to a button's face (its `position`). Must
 * match the depth of the world objects' button model (src/props/meshes.ts).
 */
export const BUTTON_DEPTH = 0.06;
/** The same for an impact target (src/props/meshes.ts IMPACT_DEPTH). */
export const IMPACT_BUTTON_DEPTH = 0.07;
/** Thickness of a floor grate (top flush with the floor). */
export const GRATE_THICKNESS = 0.045;

/** How far an acoustic zone may reach across a connector plane. */
export const ZONE_REACH = 0.3;
/** How far a dynamic light's bounds may reach across a connector plane. */
export const LIGHT_REACH = 0.8;
/**
 * Solutions pass a doorway on its axis, from STEP_THROUGH before the plane
 * (the last point of the module being left) to STEP_THROUGH past it (the
 * first point of the next module): see `doorwayPoints`.
 */
export const STEP_THROUGH = 0.8;

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/** A doorway on the plane where two modules meet. */
export interface Connector {
  /** Centre of the doorway's threshold (floor level) on the plane. */
  position: Vec3;
  /**
   * Horizontal axis unit vector, pointing out of the module that has this
   * doorway as an exit and into the module built from it.
   */
  facing: Vec3;
  /** Clear width and height of the opening. */
  width: number;
  height: number;
  /** Id of the door that closes the doorway, if any (owned by the exit side). */
  door?: string;
}

/**
 * A rectangle on a connector plane, in the connector's own coordinates: `s`
 * metres to the right of the doorway's centre looking along its facing, `y`
 * metres up from the threshold.
 */
export interface Rect {
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}

/** How a module closes its end of a doorway (rule 2). */
export interface DoorwayEnd {
  /** True: its own wall stands against the plane. False: an open end. */
  wall: boolean;
  /**
   * With a wall: the extent of that wall's face on the plane (what it can
   * close for an open neighbour). Open: the outline of the module's end,
   * floor, walls and ceiling included, which the neighbour must cover.
   */
  extent: Rect;
}

export interface Doorway {
  connector: Connector;
  end: DoorwayEnd;
}

// ---------------------------------------------------------------------------
// Locks, solutions and what a module declares
// ---------------------------------------------------------------------------

/** The mechanic that bars the way to a module's exit (or that it teaches). */
export type Mechanic =
  | "none"
  | "toggle-button"
  | "timed-door"
  | "impact-target"
  | "weighted-plate"
  | "push"
  | "climb";

/** What blocks the way to the exit and what opens it, as data. */
export interface Lock {
  kind: Mechanic;
  /** Doors (final ids) that stay shut until the lock is solved. */
  doors: string[];
  /** Buttons and plates (final ids) involved in solving it. */
  buttons: string[];
  plates: string[];
  /** Props meant as the key: module-local index and where it starts. */
  keys: { prop: number; at: Vec3 }[];
}

export const NO_LOCK: Lock = {
  kind: "none",
  doors: [],
  buttons: [],
  plates: [],
  keys: [],
};

/**
 * What a module needs from the rooms before it (for the generator; nothing
 * checks these yet). A module that provides everything it needs leaves
 * them out.
 */
export interface Requirements {
  /** Kilograms of carryable props the player must bring in. */
  carryMass?: number;
  /** Number of throwable props the player must bring in. */
  throwables?: number;
}

/** Everything a module reports about itself once built (or planned). */
export interface RoomPlan {
  /**
   * World-space boxes whose union holds everything the module emits: walls,
   * floors, anything sunk below the floor (pits, channels) and ceilings.
   * Footprints of two modules may touch but never overlap.
   */
  footprint: Aabb[];
  /** The entry doorway: null for a start module. */
  entry: Doorway | null;
  /** Exit doorways, world space. Every exit must be attached to a module. */
  exits: Doorway[];
  /** Start modules: the player's spawn (feet position and yaw). */
  spawn?: { position: Vec3; yaw: number };
  /** Finish modules: standing inside this box completes the level. */
  exit?: Aabb;
  /** What bars the way to the exit (NO_LOCK if nothing does). */
  lock: Lock;
  /**
   * A known way through, in world space: starts with the player at the
   * spawn (start modules) or at `doorwayPoints(entry).after` (others), ends
   * at `doorwayPoints(exits[0]).before` with the exit's door open, or inside
   * `exit` for a finish module. Uses only what the module provides. Props
   * are module-local indices (the n-th prop it added, from 0); buttons are
   * final ids. Every `walk` is a straight line on the floor clear of brushes
   * and of props where they are at that moment.
   */
  solution: SolutionStep[];
}

/** Builders a module adds its parts with. All coordinates are world space. */
export interface RoomContext {
  /** Deterministic randomness for this placement. */
  readonly rng: Rng;
  /** Build the module mirrored (left and right swapped). */
  readonly mirror: boolean;
  /** The final, level-unique id for one of this module's local ids. */
  id(local: string): string;
  /** A static brush. */
  box(min: Vec3, max: Vec3, material: MaterialId): void;
  light(def: LightDef): void;
  /**
   * A prop whose bottom rests at `base.y`, centred on `base.x`, `base.z`.
   * Returns its module-local index.
   */
  prop(kind: PropKind, base: Vec3, yaw: number): number;
  door(def: DoorDef): void;
  button(def: ButtonDef): void;
  plate(def: PressurePlateDef): void;
  emitter(def: SoundEmitterDef): void;
  zone(zone: AcousticZone): void;
}

export type RoomRole = "start" | "middle" | "finish";

/**
 * A room module. `P` is its parameter object; a hand-built module has none
 * (`Record<string, never>`).
 */
export interface RoomModule<P = Record<string, never>> {
  /** Unique name, used in error messages and the registry. */
  name: string;
  /**
   * "start": no entry, declares `spawn`; anchored at the level's root.
   * "middle": one entry, one or more exits. "finish": no exits, declares
   * the level's `exit` box.
   */
  role: RoomRole;
  /** The mechanic this module is about (its lock, usually). */
  teaches: Mechanic;
  /** Rough difficulty, 0 (nothing to solve) to 3. */
  difficulty: number;
  requires: Requirements;
  /** Entry doorway sizes it can be built from, inclusive ranges in metres. */
  entrySize: { width: [number, number]; height: [number, number] };
  /** The parameters used when none are given. */
  defaults: P;
  /** A random choice of parameters within the module's stated ranges. */
  random(rng: Rng): P;
  build(ctx: RoomContext, at: Connector, params: P): RoomPlan;
}

/** A module of any parameter type, for lists of modules. */
export type AnyRoomModule = RoomModule<any>;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Where a module's design coordinates are anchored: the point and facing in
 * design space that land on the entry connector's position and facing. A
 * module written directly in the entry's local frame (x = metres along the
 * facing, z = metres to the right) uses `LOCAL_DESIGN`.
 */
export interface DesignAnchor {
  position: Vec3;
  facing: Vec3;
}

export const LOCAL_DESIGN: DesignAnchor = {
  position: { x: 0, y: 0, z: 0 },
  facing: { x: 1, y: 0, z: 0 },
};

/** Maps a module's design coordinates to world space. */
export interface Frame {
  point(x: number, y: number, z: number): Vec3;
  /** World box spanning two design corners. */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): Aabb;
  /** World direction of a design vector. */
  dir(x: number, y: number, z: number): Vec3;
  /** World yaw of a design yaw (radians, 0 looks along -Z). */
  yaw(designYaw: number): number;
  /** World yaw of a heading given relative to the design facing. */
  turn(relativeYaw: number): number;
}

/** Rounds to a micrometre so that walls meeting at a plane meet exactly. */
export const snap = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

function checkAxis(f: Vec3, what: string): void {
  if (
    Math.abs(f.y) > 1e-9 ||
    Math.abs(Math.abs(f.x) + Math.abs(f.z) - 1) > 1e-9 ||
    (f.x !== 0 && f.z !== 0)
  ) {
    throw new Error(`${what} must be a horizontal axis`);
  }
}

/** Yaw (radians, 0 looks along -Z) of a horizontal direction. */
export const yawOf = (f: Vec3): number => Math.atan2(-f.x, -f.z);

/**
 * The frame that puts `design` on the connector `at`, mirrored left to right
 * if asked. Rotations are by quarter turns, so boxes stay boxes; mirroring
 * swaps min and max on one axis, which `box` sorts out (brushes have no
 * winding), and a door's `openOffset` mirrors with the wall it slides into.
 */
export function roomFrame(
  at: Pick<Connector, "position" | "facing">,
  mirror = false,
  design: DesignAnchor = LOCAL_DESIGN,
): Frame {
  checkAxis(at.facing, "connector facing");
  checkAxis(design.facing, "design facing");
  const f = at.facing;
  const m = mirror ? -1 : 1;
  // Right of a facing (right-handed, Y up): facing -Z has +X to its right.
  const r = { x: -f.z * m, z: f.x * m };
  const df = design.facing;
  const dr = { x: -df.z, z: df.x };
  const o = at.position;
  const d = design.position;
  const identity =
    !mirror && f.x === df.x && f.z === df.z && o.x === d.x && o.z === d.z;
  /** Design vector to (along, right) components. */
  const split = (x: number, z: number): [number, number] => [
    df.x !== 0 ? df.x * x : df.z * z,
    dr.x !== 0 ? dr.x * x : dr.z * z,
  ];
  const point = (x: number, y: number, z: number): Vec3 => {
    const [a, s] = split(x - d.x, z - d.z);
    return {
      x: snap(o.x + f.x * a + r.x * s),
      y: snap(o.y + (y - d.y)),
      z: snap(o.z + f.z * a + r.z * s),
    };
  };
  const designYaw = yawOf(df);
  const worldYaw = yawOf(f);
  return {
    point,
    box(x0, y0, z0, x1, y1, z1) {
      const p = point(x0, y0, z0);
      const q = point(x1, y1, z1);
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
    dir(x, y, z) {
      const [a, s] = split(x, z);
      return {
        x: snap(f.x * a + r.x * s),
        y: snap(y),
        z: snap(f.z * a + r.z * s),
      };
    },
    yaw: (yaw) => (identity ? yaw : worldYaw + m * (yaw - designYaw)),
    turn: (yaw) => worldYaw + m * yaw,
  };
}

/**
 * The entry's local frame: `point(a, y, s)` is `a` metres along the facing
 * from the connector, `y` up and `s` to the right.
 */
export function localFrame(at: Pick<Connector, "position" | "facing">): Frame {
  return roomFrame(at);
}

/** World points just before and just past a doorway, on its axis. */
export function doorwayPoints(c: Connector): { before: Vec3; after: Vec3 } {
  const at = (k: number): Vec3 => ({
    x: snap(c.position.x + c.facing.x * k),
    y: c.position.y,
    z: snap(c.position.z + c.facing.z * k),
  });
  return { before: at(-STEP_THROUGH), after: at(STEP_THROUGH) };
}

/** The unit vector to the right of a connector, looking along its facing. */
export const rightOf = (c: Pick<Connector, "facing">): Vec3 => ({
  x: -c.facing.z,
  y: 0,
  z: c.facing.x,
});

/**
 * A world box lying on (or against) a connector's plane, as a rectangle in
 * the connector's coordinates.
 */
export function rectOnPlane(c: Connector, box: Aabb): Rect {
  const r = rightOf(c);
  const s0 =
    (box.min.x - c.position.x) * r.x + (box.min.z - c.position.z) * r.z;
  const s1 =
    (box.max.x - c.position.x) * r.x + (box.max.z - c.position.z) * r.z;
  return {
    s0: snap(Math.min(s0, s1)),
    s1: snap(Math.max(s0, s1)),
    y0: snap(box.min.y - c.position.y),
    y1: snap(box.max.y - c.position.y),
  };
}

/** True if rectangle `inner` lies within `outer` (to a micrometre). */
export function rectWithin(inner: Rect, outer: Rect): boolean {
  const e = 1e-6;
  return (
    inner.s0 >= outer.s0 - e &&
    inner.s1 <= outer.s1 + e &&
    inner.y0 >= outer.y0 - e &&
    inner.y1 <= outer.y1 + e
  );
}
