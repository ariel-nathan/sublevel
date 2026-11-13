import type { LevelData } from "../core/api";
import { defineLevel } from "./define";

/**
 * Development level: the opening room, then the named room modules in order,
 * then the finish, for trying modules in the real game (`?rooms=a,b`).
 *
 * Placeholder: returns the hand-built level.
 */
export function buildRoomsLevel(
  _rooms: readonly string[],
  _seed: number,
): LevelData {
  return defineLevel();
}
