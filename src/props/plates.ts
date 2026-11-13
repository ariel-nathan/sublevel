import type { Aabb, BodyState, PressurePlateDef } from "../core/api";
import { v3, type Vec3 } from "../math";

/**
 * A plate is flush with the floor: it has no collider, props and the player
 * rest on the floor through it, and it is drawn as a thin inlay a few
 * millimetres proud. `PressurePlateDef.box` is read as a footprint (x and z
 * extents) standing on the floor surface `box.min.y`; its height (`max.y`)
 * is ignored.
 */
export function plateFloor(box: Aabb): number {
  return box.min.y;
}

/** The footprint is shrunk by this much so edge-sitters do not count. */
export const PLATE_INSET = 0.05;
/** Highest a body's underside may be above the floor at the plate and still count. */
export const PLATE_STACK_HEIGHT = 1.3;
/** Player feet must be this close to the plate (the floor) to weigh it down. */
export const PLATE_PLAYER_REACH = 0.08;
/** A state change must persist this long before it takes effect. */
export const PLATE_DEBOUNCE = 0.15;
/** How far a pressed plate is drawn sunk (it stays 4 mm proud), and how fast. */
export const PLATE_SINK = 0.002;
const PLATE_SINK_SPEED = 0.2;

/** Half the height of a body's bounding box (from its orientation). */
export function verticalHalfExtent(body: BodyState): number {
  const { x, y, z, w } = body.orientation;
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - w * x);
  const h = body.halfExtents;
  return Math.abs(r10) * h.x + Math.abs(r11) * h.y + Math.abs(r12) * h.z;
}

/** Total mass resting on (or stacked above) a plate, player included. */
export function plateLoad(
  box: Aabb,
  bodies: readonly BodyState[],
  playerBox: Aabb,
  playerMass: number,
): number {
  const x0 = box.min.x + PLATE_INSET;
  const x1 = box.max.x - PLATE_INSET;
  const z0 = box.min.z + PLATE_INSET;
  const z1 = box.max.z - PLATE_INSET;
  const top = plateFloor(box);
  let load = 0;
  for (const body of bodies) {
    const p = body.position;
    if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) {
      continue;
    }
    // A body resting on the floor has its centre above it.
    if (p.y < top) {
      continue;
    }
    const bottom = p.y - verticalHalfExtent(body);
    if (bottom <= top + PLATE_STACK_HEIGHT) {
      load += body.mass;
    }
  }
  if (
    playerBox.min.x < x1 &&
    playerBox.max.x > x0 &&
    playerBox.min.z < z1 &&
    playerBox.max.z > z0 &&
    playerBox.min.y <= top + PLATE_PLAYER_REACH &&
    playerBox.min.y >= top - 0.5
  ) {
    load += playerMass;
  }
  return load;
}

export class Plate {
  readonly def: PressurePlateDef;
  readonly center: Vec3;
  pressed = false;
  load = 0;
  /** Drawn depression in metres, now and at the previous step. */
  sink = 0;
  prevSink = 0;
  private pending = 0;

  constructor(def: PressurePlateDef) {
    this.def = def;
    this.center = v3.create(
      (def.box.min.x + def.box.max.x) / 2,
      plateFloor(def.box),
      (def.box.min.z + def.box.max.z) / 2,
    );
  }

  /**
   * Feeds in this step's load. Returns +1 when the plate just went down, -1
   * when it came up, 0 otherwise.
   */
  update(dt: number, load: number): number {
    this.load = load;
    this.prevSink = this.sink;
    const raw = load >= this.def.requiredMass;
    let change = 0;
    if (raw !== this.pressed) {
      this.pending += dt;
      if (this.pending >= PLATE_DEBOUNCE - 1e-6) {
        this.pressed = raw;
        this.pending = 0;
        change = raw ? 1 : -1;
      }
    } else {
      this.pending = 0;
    }
    const goal = this.pressed ? PLATE_SINK : 0;
    const step = PLATE_SINK_SPEED * dt;
    this.sink += Math.max(-step, Math.min(step, goal - this.sink));
    return change;
  }
}
