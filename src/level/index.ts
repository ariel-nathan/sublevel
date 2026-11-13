import type { Aabb, Brush, BuiltLevel, DoorDef, LevelData } from "../core/api";
import { AirGrid } from "./airgrid";
import { LightBaker } from "./bake";
import { defineLevel } from "./define";
import { boxOf, type Box } from "./geometry";
import { generateMeshes, isSeeThrough } from "./meshgen";

/** How far a door volume reaches either side of the slab, across its wall. */
export const DOOR_VOLUME_REACH = 0.25;

/**
 * Door volume: the doorway a slab closes, through the full thickness of its
 * wall and a little beyond. It is air for visibility (the slab is not a brush
 * and moves), so the jambs, lintel and sill around a recessed slab are kept.
 */
export function doorVolume(door: DoorDef): Box {
  const b = boxOf(door.closed);
  const alongZ = b.x1 - b.x0 < b.z1 - b.z0;
  return alongZ
    ? { ...b, x0: b.x0 - DOOR_VOLUME_REACH, x1: b.x1 + DOOR_VOLUME_REACH }
    : { ...b, z0: b.z0 - DOOR_VOLUME_REACH, z1: b.z1 + DOOR_VOLUME_REACH };
}

/**
 * Air visible from the spawn: every door open (door volumes as air), and
 * see-through brushes as air, so that the space beneath a floor grate counts
 * as visible even though no one can stand in it.
 */
export function levelAir(data: LevelData): AirGrid {
  const spawn = data.playerSpawn.position;
  return new AirGrid(
    data.brushes.filter((b) => !isSeeThrough(b)).map(boxOf),
    { x: spawn.x, y: spawn.y + 1, z: spawn.z },
    0.1,
    data.doors.map(doorVolume),
  );
}

/** Builds the level data, its baked meshes and one collider per brush. */
export function buildLevel(): BuiltLevel {
  const data = defineLevel();
  const boxes = data.brushes.map(boxOf);
  const air = levelAir(data);
  const baker = new LightBaker(
    boxes,
    data.lights,
    data.ambient,
    data.brushes.map(isSeeThrough),
  );
  const meshes = generateMeshes(data.brushes, air, baker);
  const colliders: Aabb[] = data.brushes.map((b) => ({
    min: { ...b.min },
    max: { ...b.max, y: isSkirting(b) ? SKIRTING_COLLIDER_TOP : b.max.y },
  }));
  return { data, meshes, colliders };
}

/** Height that skirting colliders are raised to (above any step height). */
export const SKIRTING_COLLIDER_TOP = 0.8;

/**
 * Skirting trim: a low, thin strip standing on the floor (baseboards, bench
 * kick plates). Its collider is raised so the player is not lifted onto it as
 * if it were a step; it only pushes them a few centimetres off the wall.
 */
export function isSkirting(b: Brush): boolean {
  const thin = Math.min(b.max.x - b.min.x, b.max.z - b.min.z);
  return b.min.y === 0 && b.max.y <= 0.12 && thin <= 0.05;
}
