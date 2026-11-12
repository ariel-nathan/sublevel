import type { Vec3 } from "../math";
import type { PropKind } from "./api";

export interface PropSpec {
  /** Half-size of the physics box; also the visual bounds. */
  halfExtents: Vec3;
  /** Kilograms. */
  mass: number;
}

/**
 * Size and mass of every prop kind. Shared so that the level can place props
 * without overlaps and the props module can build matching bodies and meshes.
 */
export const PROP_SPECS: Readonly<Record<PropKind, PropSpec>> = {
  crate_wood: { halfExtents: { x: 0.4, y: 0.4, z: 0.4 }, mass: 25 },
  crate_wood_small: { halfExtents: { x: 0.25, y: 0.25, z: 0.25 }, mass: 8 },
  crate_weak: { halfExtents: { x: 0.4, y: 0.4, z: 0.4 }, mass: 15 },
  crate_metal: { halfExtents: { x: 0.35, y: 0.35, z: 0.35 }, mass: 60 },
  barrel: { halfExtents: { x: 0.3, y: 0.45, z: 0.3 }, mass: 35 },
  chair: { halfExtents: { x: 0.25, y: 0.45, z: 0.25 }, mass: 7 },
  monitor: { halfExtents: { x: 0.22, y: 0.2, z: 0.2 }, mass: 9 },
};

/** Player dimensions and limits that level design depends on. */
export const PLAYER = {
  /** Half-width of the collision box on X and Z. */
  halfWidth: 0.3,
  standHeight: 1.8,
  crouchHeight: 1.0,
  /** Eye height above the feet when standing. */
  eyeHeight: 1.65,
  /** Highest ledge reachable with a standing jump. */
  jumpHeight: 1.0,
  /** Ledges up to this height are walked up without jumping. */
  stepHeight: 0.3,
  /** Heaviest prop that can be picked up; heavier ones can only be pushed. */
  maxCarryMass: 40,
  /** Reach of the use key and of picking things up. */
  reach: 2.2,
} as const;
