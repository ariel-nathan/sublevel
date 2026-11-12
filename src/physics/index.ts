/**
 * Rigid body physics for oriented boxes against axis-aligned world boxes,
 * plus a character controller. See src/core/api.ts for the contract.
 */
import type { PhysicsOptions, PhysicsWorld } from "../core/api";
import { World } from "./world";

export function createPhysicsWorld(options?: PhysicsOptions): PhysicsWorld {
  return new World(options);
}
