/** Shared helpers for the player tests: small worlds and a step loop. */
import type {
  Player,
  PlayerEvent,
  PlayerInput,
  PhysicsWorld,
} from "../core/api";
import { PLAYER, PROP_SPECS } from "../core/props";
import type { Vec3 } from "../math";
import { createPhysicsWorld } from "../physics";
import { createPlayer } from "./index";

export const DT = 1 / 60;

export function idle(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    moveX: 0,
    moveZ: 0,
    lookDx: 0,
    lookDy: 0,
    jump: false,
    crouch: false,
    usePressed: false,
    primaryPressed: false,
    ...overrides,
  };
}

/** A 40 x 40 m floor with its top at y = 0. */
export function floorWorld(): PhysicsWorld {
  const w = createPhysicsWorld();
  w.addStatic({ min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 0, z: 20 } });
  return w;
}

export interface Sim {
  world: PhysicsWorld;
  player: Player;
  events: PlayerEvent[];
  /** Runs `frames` steps; `input` may be a function of the frame index. */
  run(
    frames: number,
    input?: PlayerInput | ((frame: number) => PlayerInput),
    each?: (frame: number, events: PlayerEvent[]) => void,
  ): PlayerEvent[];
}

export function sim(
  world: PhysicsWorld,
  feet: Vec3 = { x: 0, y: 0, z: 0 },
  yaw = 0,
): Sim {
  const player = createPlayer({
    physics: world,
    spawn: { position: feet, yaw },
  });
  const all: PlayerEvent[] = [];
  return {
    world,
    player,
    events: all,
    run(frames, input = idle(), each) {
      const out: PlayerEvent[] = [];
      for (let f = 0; f < frames; f++) {
        const i = typeof input === "function" ? input(f) : input;
        const ev = player.update(DT, i);
        world.step(DT);
        world.drainContacts();
        out.push(...ev);
        all.push(...ev);
        each?.(f, ev);
      }
      return out;
    },
  };
}

/** Adds a prop of the given kind with its bottom resting at `y`. */
export function addProp(
  world: PhysicsWorld,
  kind: keyof typeof PROP_SPECS,
  x: number,
  z: number,
  y = 0,
): number {
  const spec = PROP_SPECS[kind];
  return world.addBody({
    position: { x, y: y + spec.halfExtents.y, z },
    halfExtents: spec.halfExtents,
    mass: spec.mass,
    tag: kind,
  });
}

export function horizontalSpeed(v: Vec3): number {
  return Math.hypot(v.x, v.z);
}

export { PLAYER };
