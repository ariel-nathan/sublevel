import type { Aabb, BuiltLevel } from "../core/api";
import { AirGrid } from "./airgrid";
import { LightBaker } from "./bake";
import { defineLevel } from "./define";
import { boxOf } from "./geometry";
import { generateMeshes } from "./meshgen";

/** Builds the level data, its baked meshes and one collider per brush. */
export function buildLevel(): BuiltLevel {
  const data = defineLevel();
  const boxes = data.brushes.map(boxOf);
  const spawn = data.playerSpawn.position;
  const air = new AirGrid(boxes, { x: spawn.x, y: spawn.y + 1, z: spawn.z });
  const baker = new LightBaker(boxes, data.lights, data.ambient);
  const meshes = generateMeshes(data.brushes, air, baker);
  const colliders: Aabb[] = data.brushes.map((b) => ({
    min: { ...b.min },
    max: { ...b.max },
  }));
  return { data, meshes, colliders };
}
