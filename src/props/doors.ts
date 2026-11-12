import type { DoorDef, PhysicsWorld } from "../core/api";
import { v3, type Vec3 } from "../math";

/** Cruise speed of a sliding door. */
export const DOOR_SPEED = 1.6;
const DOOR_ACCEL = 8;
const DOOR_DECEL = 6;

/** A sliding door: a kinematic box that travels along `openOffset`. */
export class Door {
  readonly def: DoorDef;
  readonly colliderId: number;
  /** Unit direction of travel and total travel distance. */
  readonly dir: Vec3;
  readonly length: number;
  /** Door centre when closed. */
  readonly closedCenter: Vec3;
  /** Plates that hold this door open; if any, buttons are ignored. */
  plateIds: string[] = [];
  /** Button-controlled intent, toggled by `use`. */
  manual = false;
  /** Announced target state (what the last door event said). */
  open = false;
  /** Distance travelled from closed, and at the previous step. */
  travel = 0;
  prevTravel = 0;
  private speed = 0;
  private readonly physics: PhysicsWorld;

  constructor(def: DoorDef, physics: PhysicsWorld) {
    this.def = def;
    this.physics = physics;
    this.length = v3.length(def.openOffset);
    this.dir =
      this.length > 0 ? v3.scale(def.openOffset, 1 / this.length) : v3.create();
    this.closedCenter = v3.scale(v3.add(def.closed.min, def.closed.max), 0.5);
    this.colliderId = physics.addKinematic({
      min: v3.clone(def.closed.min),
      max: v3.clone(def.closed.max),
    });
  }

  get fullyOpen(): boolean {
    return this.travel >= this.length - 1e-4;
  }

  /** Door centre at a given travel distance. */
  centerAt(travel: number): Vec3 {
    return v3.addScaled(this.closedCenter, this.dir, travel);
  }

  /** Moves towards the open or closed end, easing in and out. */
  step(dt: number): void {
    this.prevTravel = this.travel;
    const goal = this.open ? this.length : 0;
    const remaining = goal - this.travel;
    const distance = Math.abs(remaining);
    if (distance < 1e-6) {
      this.speed = 0;
      return;
    }
    const wanted = Math.min(DOOR_SPEED, Math.sqrt(2 * DOOR_DECEL * distance));
    this.speed = Math.min(wanted, this.speed + DOOR_ACCEL * dt);
    const move = Math.min(this.speed * dt, distance);
    this.travel += Math.sign(remaining) * move;
    if (Math.abs(goal - this.travel) < 1e-6) {
      this.travel = goal;
    }
    this.physics.moveKinematic(
      this.colliderId,
      v3.addScaled(this.def.closed.min, this.dir, this.travel),
    );
  }

  /** The target changed: a closing door starts from rest. */
  retarget(open: boolean): void {
    if (open !== this.open) {
      this.open = open;
      this.speed = 0;
    }
  }
}
