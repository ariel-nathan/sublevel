import type { DoorDef, PhysicsWorld } from "../core/api";
import { v3, type Vec3 } from "../math";

/** Cruise speed of a sliding door. */
export const DOOR_SPEED = 1.6;
const DOOR_ACCEL = 8;
const DOOR_DECEL = 6;
/** A blocked closing door stops for this long before it reopens (s). */
export const BLOCKED_PAUSE = 0.4;
/** After reopening, a door waits this long before trying to close again (s). */
export const BLOCKED_RETRY = 1.5;

/** What a door step announces. */
export type DoorTransition = "open" | "close" | "blocked";

const NONE: readonly DoorTransition[] = [];

/**
 * Where a door is in its life:
 * - normal: heading for whatever is wanted;
 * - pause: stopped against an obstruction, BLOCKED_PAUSE before reopening;
 * - reopen: going fully open whatever is wanted;
 * - cooldown: open again, waiting BLOCKED_RETRY before obeying "close".
 */
type Phase = "normal" | "pause" | "reopen" | "cooldown";

/** A sliding door: a kinematic box that travels along `openOffset`. */
export class Door {
  readonly def: DoorDef;
  readonly colliderId: number;
  /** Unit direction of travel and total travel distance. */
  readonly dir: Vec3;
  readonly length: number;
  /** Door centre when closed. */
  readonly closedCenter: Vec3;
  /** Plates that hold this door open; while one is pressed the door is open. */
  plateIds: string[] = [];
  /** Toggle-button intent, flipped by `use`. */
  manual = false;
  /** An impact button opened this door for good. */
  latched = false;
  /** Seconds left on a timed button's countdown (0: not counting). */
  countdown = 0;
  /** Remaining value at which the next `timer_tick` is due. */
  nextTick = 0;
  /** Announced target state (what the last door event said). */
  open = false;
  /** Distance travelled from closed, and at the previous step. */
  travel = 0;
  prevTravel = 0;
  private speed = 0;
  private phase: Phase = "normal";
  private phaseTime = 0;
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

  /**
   * Advances one step towards the wanted state, easing in and out, and
   * reports what changed. The travel only ever includes moves the physics
   * allowed: a blocked closing move is not applied.
   */
  step(dt: number, wanted: boolean): readonly DoorTransition[] {
    this.prevTravel = this.travel;
    let out: DoorTransition[] | null = null;
    const emit = (t: DoorTransition): void => {
      (out ??= []).push(t);
    };
    switch (this.phase) {
      case "pause":
        this.phaseTime -= dt;
        if (this.phaseTime > 1e-9) {
          return NONE;
        }
        this.phase = "reopen";
        this.open = true;
        this.speed = 0;
        emit("open");
        this.advance(dt);
        break;
      case "reopen":
        this.advance(dt);
        break;
      case "cooldown":
        this.phaseTime -= dt;
        if (wanted || this.phaseTime <= 1e-9) {
          this.phase = "normal";
        }
        break;
      case "normal":
        if (wanted !== this.open) {
          this.open = wanted;
          this.speed = 0;
          emit(wanted ? "open" : "close");
        }
        if (this.advance(dt)) {
          this.phase = "pause";
          this.phaseTime = BLOCKED_PAUSE;
          emit("blocked");
        }
        break;
    }
    if (this.phase === "reopen" && this.fullyOpen) {
      this.phase = "cooldown";
      this.phaseTime = BLOCKED_RETRY;
    }
    return out ?? NONE;
  }

  /** Moves towards the goal. True if a closing move was blocked. */
  private advance(dt: number): boolean {
    const goal = this.open ? this.length : 0;
    const remaining = goal - this.travel;
    const distance = Math.abs(remaining);
    if (distance < 1e-6) {
      this.speed = 0;
      return false;
    }
    const wanted = Math.min(DOOR_SPEED, Math.sqrt(2 * DOOR_DECEL * distance));
    const speed = Math.min(wanted, this.speed + DOOR_ACCEL * dt);
    const move = Math.min(speed * dt, distance);
    let next = this.travel + Math.sign(remaining) * move;
    if (Math.abs(goal - next) < 1e-6) {
      next = goal;
    }
    const result = this.physics.moveKinematic(
      this.colliderId,
      v3.addScaled(this.def.closed.min, this.dir, next),
    );
    if (!this.open && result.blocked) {
      this.speed = 0;
      return true;
    }
    this.speed = speed;
    this.travel = next;
    return false;
  }
}
