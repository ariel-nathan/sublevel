/**
 * Seeded runs: a seed becomes a facility. See README.md in this folder.
 *
 *   planRun(seed)       the mission and the placed pieces, no geometry
 *   assembleRun(seed)   the assembled level (LevelData and placed rooms)
 *   generateLevel(seed) its LevelData, what the game builds
 *
 * The same seed (and config) always gives the same facility.
 */
import type { LevelData } from "../../core/api";
import { createRng, hashString } from "../../core/rng";
import {
  assembleLevel,
  place,
  type AssembledLevel,
  type LevelPlan,
} from "../assemble";
import { boxOf, containsPoint } from "../geometry";
import type { AnyRoomModule } from "../rooms/room";
import { DEFAULT_CONFIG, type GeneratorConfig } from "./config";
import { layout, ROOT, type Piece, type Target } from "./layout";
import { chooseMission, eligible, type MissionRoom } from "./mission";
import { facilityName } from "./names";
import { PlanCache } from "./plans";

export { DEFAULT_CONFIG, type GeneratorConfig } from "./config";
export type { Piece } from "./layout";
export type { MissionRoom } from "./mission";

export interface RunPlan {
  seed: number;
  /** The facility's name. */
  name: string;
  mission: MissionRoom[];
  /** Every piece in chain order: start, links, rooms, finish. */
  pieces: Piece[];
  /** True if the layout search gave up and the straight continuation was used. */
  fallback: boolean;
  /** Candidate placements the search evaluated. */
  evaluated: number;
}

/** The pool's modules that can be puzzle rooms (mission.ts rule 1). */
export function eligibleModules(
  config: GeneratorConfig = DEFAULT_CONFIG,
): AnyRoomModule[] {
  const cache = new PlanCache();
  const exitsOf = (m: AnyRoomModule): number => {
    const [w0, w1] = m.entrySize.width;
    const [h0, h1] = m.entrySize.height;
    return cache.canonical(
      m,
      m.defaults,
      false,
      { width: (w0 + w1) / 2, height: (h0 + h1) / 2 },
      0,
    ).exits.length;
  };
  const seen = new Set<string>();
  return config.pool().filter((m) => {
    if (seen.has(m.name)) return false;
    seen.add(m.name);
    return eligible(m, exitsOf);
  });
}

/** The mission and layout for a seed, without building any geometry. */
export function planRun(
  seed: number,
  config: GeneratorConfig = DEFAULT_CONFIG,
): RunPlan {
  const rng = createRng(hashString(`run/${seed}`));
  const mission = chooseMission(
    eligibleModules(config),
    config.rooms,
    config.maxPerMechanic,
    rng,
  );
  const targets: Target[] = mission.map((room, i) => {
    const name = `r${i + 1}-${room.module.name}`;
    return {
      module: room.module,
      params: room.module.random(createRng(hashString(`${seed}/${name}/p`))),
      name,
      seed: hashString(`${seed}/${name}`),
    };
  });
  targets.push({
    module: config.finish,
    params: config.finish.defaults,
    name: "exit",
    seed: 0,
  });
  const result = layout(config, seed, targets);
  return {
    seed,
    name: facilityName(seed),
    mission,
    pieces: result.pieces,
    fallback: result.fallback,
    evaluated: result.evaluated,
  };
}

/** The level plan (placements) of a run plan, for the assembler. */
export function levelPlanOf(
  run: RunPlan,
  config: GeneratorConfig = DEFAULT_CONFIG,
): LevelPlan {
  return {
    name: run.name,
    root: ROOT,
    placements: run.pieces.map((p) =>
      place(p.module, {
        name: p.name,
        params: p.params,
        mirror: p.mirror,
        seed: p.seed,
      }),
    ),
    ambient: config.ambient,
    fog: config.fog,
    seed: run.seed,
  };
}

/**
 * Steady lights are baked into the level's vertex colours, but the renderer
 * still uses them to light props and other moving things, without shadows.
 * Confining each to the footprint box of its piece keeps it from lighting
 * a neighbouring room's props through a wall, and makes the renderer's
 * choice of 32 lights favour the rooms around the camera.
 */
function boundSteadyLights(assembled: AssembledLevel): void {
  for (const room of assembled.rooms) {
    const boxes = room.plan.footprint;
    for (const light of room.parts.lights) {
      if (light.flicker !== "none" || light.bounds) continue;
      const p = light.position;
      const home = boxes.find((b) => containsPoint(boxOf(b), p.x, p.y, p.z));
      if (home) light.bounds = { min: { ...home.min }, max: { ...home.max } };
    }
  }
}

/** The assembled level of a seed, with its run plan. */
export function assembleRun(
  seed: number,
  config: GeneratorConfig = DEFAULT_CONFIG,
): { run: RunPlan; assembled: AssembledLevel } {
  const run = planRun(seed, config);
  const assembled = assembleLevel(levelPlanOf(run, config));
  boundSteadyLights(assembled);
  return { run, assembled };
}

/**
 * Builds the level for a generated run. The same seed always gives the same
 * facility.
 */
export function generateLevel(
  seed: number,
  config: GeneratorConfig = DEFAULT_CONFIG,
): LevelData {
  return assembleRun(seed, config).assembled.data;
}
