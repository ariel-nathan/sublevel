/**
 * The generator: determinism, the mission rules, placement, and the level
 * checks of checks.ts on a few seeds. A quick subset runs by default; set
 * SUBLEVEL_FUZZ=1 for 25 seeds of everything (and fuzz.test.ts's statistics
 * over 200).
 */
import { describe, expect, test } from "bun:test";
import { createRng } from "../../core/rng";
import { assembleLevel } from "../assemble";
import { fingerprintLevel } from "../fingerprint";
import { boxOf, containsPoint } from "../geometry";
import { buildLevelFrom } from "../index";
import { FILTRATION_HALL } from "../rooms/filtration-hall";
import { STORAGE } from "../rooms/storage";
import type { AnyRoomModule } from "../rooms/room";
import {
  allProblems,
  chainProblems,
  coplanarProblems,
  solutionProblems,
} from "./checks";
import { DEFAULT_CONFIG, type GeneratorConfig } from "./config";
import {
  assembleRun,
  eligibleModules,
  generateLevel,
  levelPlanOf,
  planRun,
} from "./index";
import { LayoutSearch } from "./layout";
import { allocate, chooseMission, missionProblems, ramps } from "./mission";
import { STANDIN_PLATE } from "./modules/standin-plate";
import { STANDIN_SWITCH } from "./modules/standin-switch";
import { STANDIN_TARGET } from "./modules/standin-target";
import { facilityName } from "./names";

const FUZZ = process.env.SUBLEVEL_FUZZ === "1";
const SEEDS = FUZZ
  ? Array.from({ length: 25 }, (_, i) => i + 1)
  : [1, 2, 3, 4, 5, 6];
const DEEP = FUZZ ? SEEDS : [7, 8];

describe("determinism", () => {
  test("the same seed gives the same level, a different seed another", () => {
    const a = generateLevel(42);
    expect(generateLevel(42)).toEqual(a);
    expect(a.seed).toBe(42);
    const b = generateLevel(43);
    expect(b).not.toEqual(a);
    expect(facilityName(42)).toBe(a.name);
  });

  test("the built level (meshes, colliders) is identical too", () => {
    const one = fingerprintLevel(buildLevelFrom(generateLevel(5)));
    const two = fingerprintLevel(buildLevelFrom(generateLevel(5)));
    expect(two).toEqual(one);
  });
});

describe("the mission", () => {
  const pool = eligibleModules();

  test("the pool: middle modules with a real lock and no outside requirements", () => {
    for (const m of pool) {
      expect(m.role).toBe("middle");
      expect(m.teaches).not.toBe("none");
    }
    const names = pool.map((m) => m.name);
    expect(names).toContain("standin-switch");
    expect(names).toContain("filtration-hall");
    expect(names).not.toContain("corridor");
    const needy: AnyRoomModule = {
      ...STANDIN_PLATE,
      name: "needy",
      requires: { carryMass: 25 },
    };
    const config = { ...DEFAULT_CONFIG, pool: () => [needy, STANDIN_SWITCH] };
    expect(eligibleModules(config).map((m) => m.name)).toEqual([
      "standin-switch",
    ]);
  });

  test("rules hold over many seeds, and difficulty ramps up", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const mission = chooseMission(pool, 8, 2, createRng(seed));
      expect([seed, missionProblems(mission, pool, 8, 2)]).toEqual([seed, []]);
      expect([seed, ramps(mission)]).toEqual([seed, true]);
      const mechanics = new Set(mission.map((r) => r.mechanic));
      expect(mechanics.size).toBe(new Set(pool.map((m) => m.teaches)).size);
    }
  });

  test("allocation: every mechanic once, then up to the cap; more once variety runs out", () => {
    const four = allocate(
      ["push", "climb", "timed-door", "impact-target"],
      8,
      2,
    );
    expect([...four.values()]).toEqual([2, 2, 2, 2]);
    const two = allocate(["push", "climb"], 8, 2);
    expect([...two.values()]).toEqual([4, 4]);
    const many = allocate(
      [
        "push",
        "climb",
        "timed-door",
        "impact-target",
        "weighted-plate",
        "toggle-button",
      ],
      3,
      2,
    );
    expect([...many.values()]).toEqual([1, 1, 1]);
  });

  test("teach then test: the first room of a mechanic is its easiest", () => {
    const hard: AnyRoomModule = {
      ...STANDIN_TARGET,
      name: "hard-target",
      difficulty: 3,
    };
    for (let seed = 1; seed <= 30; seed++) {
      const mission = chooseMission(
        [hard, STANDIN_TARGET, STANDIN_SWITCH],
        4,
        2,
        createRng(seed),
      );
      const targets = mission.filter((r) => r.mechanic === "impact-target");
      expect(targets[0].module.name).toBe("standin-target");
      for (let i = 1; i < mission.length; i++) {
        expect(mission[i].module).not.toBe(mission[i - 1].module);
      }
    }
  });

  test("the pool is read when a run is generated", () => {
    const config: GeneratorConfig = {
      ...DEFAULT_CONFIG,
      rooms: 2,
      pool: () => [STANDIN_SWITCH, STANDIN_PLATE],
    };
    const run = planRun(9, config);
    expect(run.mission.map((r) => r.module.name).sort()).toEqual([
      "standin-plate",
      "standin-switch",
    ]);
  });
});

describe("placement", () => {
  test("planned footprints are where the assembler builds them", () => {
    const { run, assembled } = assembleRun(4);
    run.pieces.forEach((piece, i) => {
      const real = assembled.rooms[i].plan.footprint.map(boxOf);
      expect(real.length).toBe(piece.footprint.length);
      real.forEach((b, k) => {
        const p = piece.footprint[k];
        for (const key of ["x0", "y0", "z0", "x1", "y1", "z1"] as const) {
          expect(Math.abs(b[key] - p[key])).toBeLessThan(1e-5);
        }
      });
    });
  });

  test("the straight continuation always fits", () => {
    const config = { ...DEFAULT_CONFIG, searchBudget: 0 };
    for (const seed of FUZZ ? SEEDS : [1, 2, 3]) {
      const { run, assembled } = assembleRun(seed, config);
      expect(run.fallback).toBe(true);
      expect([seed, chainProblems(run, assembled, config)]).toEqual([seed, []]);
    }
  });

  test("the search stays within its bound on adversarial input (twelve large halls, tiny budget)", () => {
    const config: GeneratorConfig = {
      ...DEFAULT_CONFIG,
      rooms: 12,
      pool: () => [FILTRATION_HALL, STORAGE],
      searchBudget: 150,
    };
    const started = performance.now();
    const run = planRun(3, config);
    expect(performance.now() - started).toBeLessThan(5000);
    // The search's budget, then the straight continuation's own bound.
    expect(run.evaluated).toBeLessThanOrEqual(150 + 40000);
    expect(run.fallback).toBe(true);
    const assembled = assembleLevel(levelPlanOf(run, config));
    expect(chainProblems(run, assembled, config)).toEqual([]);
    // A search with room to work finds a compact layout instead.
    const search = new LayoutSearch({ ...config, searchBudget: 4000 }, 3, []);
    expect(search.search()?.pieces.length).toBe(1);
  });
});

describe("generated runs", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: the chain, the mission and the solution on paper`, () => {
      const { run, assembled } = assembleRun(seed);
      expect(chainProblems(run, assembled, DEFAULT_CONFIG)).toEqual([]);
      expect(solutionProblems(assembled.data)).toEqual([]);
      const data = assembled.data;
      expect(data.seed).toBe(seed);
      expect(data.name).toBe(run.name);
      expect(data.playerSpawn).toEqual(assembled.rooms[0].plan.spawn!);
      expect(data.exit).toEqual(assembled.rooms.at(-1)!.plan.exit!);
      // Steady lights are confined to their own piece's footprint.
      for (const room of assembled.rooms) {
        for (const l of room.parts.lights) {
          expect(l.bounds).toBeDefined();
          const b = boxOf(l.bounds!);
          expect(
            containsPoint(b, l.position.x, l.position.y, l.position.z),
          ).toBe(true);
        }
      }
    });
  }

  for (const seed of DEEP) {
    test(`seed ${seed}: sealed, no z-fighting, props, lights, zones, walkable only through every door`, () => {
      const config = DEFAULT_CONFIG;
      const { run, assembled } = assembleRun(seed, config);
      const built = buildLevelFrom(assembled.data);
      const problems = allProblems(run, assembled, built, config);
      for (const [what, list] of Object.entries(problems)) {
        expect([what, list.slice(0, 5)]).toEqual([what, []]);
      }
      expect(built.colliders.length).toBe(assembled.data.brushes.length);
    });
  }

  test("the coplanar check does catch z-fighting (positive control)", () => {
    const data = generateLevel(2);
    expect(coplanarProblems(data)).toEqual([]);
    // A thin plate sunk into the lab floor, its top in the floor's plane.
    const p = data.playerSpawn.position;
    data.brushes.push({
      min: { x: p.x + 0.5, y: -0.05, z: p.z - 0.5 },
      max: { x: p.x + 1.5, y: 0, z: p.z + 0.5 },
      material: "metal_panel",
    });
    expect(coplanarProblems(data).length).toBeGreaterThan(0);
  });
});
