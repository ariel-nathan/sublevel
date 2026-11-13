import type { LevelData } from "../../core/api";
import { defineLevel } from "../define";

/**
 * Builds the level for a generated run. The same seed always gives the same
 * facility.
 *
 * Placeholder: returns the hand-built level for every seed.
 */
export function generateLevel(_seed: number): LevelData {
  return defineLevel();
}
