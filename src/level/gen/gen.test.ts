/**
 * The generator: determinism, the mission rules, placement, and the level
 * checks of checks.ts on a few seeds. A quick subset runs by default; set
 * SUBLEVEL_FUZZ=1 for 25 seeds of everything (and fuzz.test.ts's statistics
 * over 200).
 */
import { describe, expect, test } from "bun:test";
import { createRng, hashString } from "../../core/rng";
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
import {
  chooseMission,
  missionProblems,
  ramps,
  sharedIdeasOf,
} from "./mission";
import { facilityName } from "./names";
import { FREIGHT_PASSAGE } from "../rooms/puzzles/freight-passage";
import { GENERATOR_HALL } from "../rooms/puzzles/generator-hall";
import { GOODS_BAY } from "../rooms/puzzles/goods-bay";
import { PUMP_GALLERY } from "../rooms/puzzles/pump-gallery";
import { RECORDS_OFFICE } from "../rooms/puzzles/records-office";

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
  const rules = DEFAULT_CONFIG;
  const names = (mission: { module: AnyRoomModule }[]) =>
    mission.map((r) => r.module.name);
  const missionOf = (seed: number) =>
    chooseMission(pool, rules, createRng(hashString(`run/${seed}`)));

  test("the pool: the registry's middle modules with a real lock and no outside requirements", () => {
    for (const m of pool) {
      expect(m.role).toBe("middle");
      expect(m.teaches).not.toBe("none");
    }
    expect(names(pool.map((module) => ({ module }))).sort()).toEqual([
      "decon-lock",
      "fan-room",
      "filtration-hall",
      "freight-passage",
      "generator-hall",
      "goods-bay",
      "maintenance-loft",
      "parts-store",
      "pump-gallery",
      "records-office",
      "storage",
      "valve-chamber",
    ]);
    const needy: AnyRoomModule = {
      ...GOODS_BAY,
      name: "needy",
      requires: { carryMass: 25 },
    };
    const config = { ...DEFAULT_CONFIG, pool: () => [needy, RECORDS_OFFICE] };
    expect(eligibleModules(config).map((m) => m.name)).toEqual([
      "records-office",
    ]);
  });

  test("rules hold over 200 seeds: authors' order, set pieces, every mechanic, the ramp", () => {
    const mechanics = new Set(pool.map((m) => m.teaches));
    for (let seed = 1; seed <= 200; seed++) {
      const mission = missionOf(seed);
      const list = names(mission);
      const at = (name: string) => list.indexOf(name);
      expect([seed, missionProblems(mission, pool, rules)]).toEqual([seed, []]);
      expect([seed, ramps(mission)]).toEqual([seed, true]);
      expect(new Set(mission.map((r) => r.mechanic)).size).toBe(mechanics.size);
      // The authors' advice (src/level/README.md).
      expect([seed, list[0]]).toEqual([seed, "records-office"]);
      expect(at("freight-passage")).toBeLessThan(4);
      for (const [a, b] of [
        ["goods-bay", "parts-store"],
        ["generator-hall", "fan-room"],
        ["pump-gallery", "decon-lock"],
        ["filtration-hall", "decon-lock"],
      ]) {
        if (at(a) >= 0 && at(b) >= 0) expect(at(a)).toBeLessThan(at(b));
      }
      const decon = at("decon-lock");
      if (decon >= 0) {
        const before = mission.slice(0, decon).map((r) => r.mechanic);
        expect(before).toContain("weighted-plate");
        expect(before).toContain("timed-door");
      }
      // One or two set pieces, each once; never the set piece and its
      // parametric re-take together.
      const pieces = mission.filter((r) => r.module.setPiece);
      expect(pieces.length).toBeGreaterThanOrEqual(1);
      expect(pieces.length).toBeLessThanOrEqual(2);
      expect(new Set(list).size).toBe(list.length);
      expect([seed, sharedIdeasOf(mission)]).toEqual([seed, 0]);
    }
  });

  test("runs differ: first rooms are the gentlest teacher, but sets, orders and set pieces vary", () => {
    const sequences = new Set<string>();
    const sets = new Set<string>();
    const pieces = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const list = names(missionOf(seed));
      sequences.add(list.join(">"));
      sets.add([...list].sort().join(","));
      for (const n of list) {
        if (pool.find((m) => m.name === n)?.setPiece) pieces.add(n);
      }
    }
    expect(sequences.size).toBeGreaterThan(100);
    expect(sets.size).toBeGreaterThan(10);
    expect([...pieces].sort()).toEqual([
      "filtration-hall",
      "storage",
      "valve-chamber",
    ]);
  });

  test("teach then test: the first room of a mechanic is its easiest", () => {
    const hard: AnyRoomModule = {
      ...GENERATOR_HALL,
      name: "hard-target",
      difficulty: 3,
      idea: undefined,
    };
    for (let seed = 1; seed <= 30; seed++) {
      const mission = chooseMission(
        [hard, GENERATOR_HALL, RECORDS_OFFICE],
        { ...rules, rooms: 3 },
        createRng(seed),
      );
      expect(names(mission)).toEqual([
        "records-office",
        "generator-hall",
        "hard-target",
      ]);
    }
  });

  test("prerequisites: a module comes after the mechanics it names, or not at all", () => {
    const combo: AnyRoomModule = {
      ...PUMP_GALLERY,
      name: "combo",
      difficulty: 1,
      idea: undefined,
      after: ["push"],
    };
    const small = { ...rules, rooms: 3 };
    for (let seed = 1; seed <= 30; seed++) {
      const list = names(
        chooseMission(
          [combo, FREIGHT_PASSAGE, GOODS_BAY],
          small,
          createRng(seed),
        ),
      );
      expect(list.indexOf("freight-passage")).toBeLessThan(
        list.indexOf("combo"),
      );
    }
    // Nothing in the pool teaches "push": the module is left out.
    const list = names(
      chooseMission([combo, GOODS_BAY, RECORDS_OFFICE], small, createRng(1)),
    );
    expect(list).not.toContain("combo");
  });

  test("a pool too small for the run: modules repeat, never twice in a row", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const mission = chooseMission(
        [GOODS_BAY, RECORDS_OFFICE],
        { ...rules, rooms: 5 },
        createRng(seed),
      );
      expect(mission.length).toBe(5);
      expect(
        missionProblems(mission, [GOODS_BAY, RECORDS_OFFICE], {
          ...rules,
          rooms: 5,
        }),
      ).toEqual([]);
    }
  });

  test("the pool is read when a run is generated", () => {
    const config: GeneratorConfig = {
      ...DEFAULT_CONFIG,
      rooms: 2,
      pool: () => [RECORDS_OFFICE, GOODS_BAY],
    };
    const run = planRun(9, config);
    expect(run.mission.map((r) => r.module.name)).toEqual([
      "records-office",
      "goods-bay",
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
