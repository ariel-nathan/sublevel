/**
 * `bun src/level/gen/bench.ts [--runs N]`: build times of the hand-built
 * level and of generated runs (8 and 12 rooms, and a stress chain of eight
 * filtration halls), with a breakdown: plan (mission and layout), assemble,
 * air (reachable-air flood), faces (cutting and culling), bake (light
 * baking), mesh (the rest of tessellation), colliders. Medians of N runs
 * (default 3) after one warm-up. Development only.
 */
import type { LevelData } from "../../core/api";
import { defineLevel } from "../define";
import { buildLevelFrom, type BuildTimings } from "../index";
import { FILTRATION_HALL } from "../rooms/filtration-hall";
import { DEFAULT_CONFIG, type GeneratorConfig } from "./config";
import { assembleRun, planRun } from "./index";

interface Row {
  label: string;
  brushes: number;
  lights: number;
  steady: number;
  triangles: number;
  meshes: number;
  times: Record<string, number>;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function measure(
  label: string,
  make: (t: Record<string, number>) => LevelData,
  runs: number,
): Row {
  const samples: Record<string, number>[] = [];
  let last: Row | null = null;
  for (let r = 0; r <= runs; r++) {
    const t: Record<string, number> = {};
    const t0 = performance.now();
    const data = make(t);
    const timings: BuildTimings = {};
    const built = buildLevelFrom(data, timings);
    Object.assign(t, timings);
    t.total = performance.now() - t0;
    if (r > 0) samples.push(t);
    let triangles = 0;
    for (const m of built.meshes) triangles += m.indices.length / 3;
    last = {
      label,
      brushes: data.brushes.length,
      lights: data.lights.length,
      steady: data.lights.filter((l) => l.flicker === "none").length,
      triangles,
      meshes: built.meshes.length,
      times: {},
    };
  }
  const keys = Object.keys(samples[0]);
  for (const k of keys) last!.times[k] = median(samples.map((s) => s[k] ?? 0));
  return last!;
}

function generated(seed: number, config: GeneratorConfig) {
  return (t: Record<string, number>): LevelData => {
    let s = performance.now();
    planRun(seed, config);
    t.plan = performance.now() - s;
    s = performance.now();
    const { assembled } = assembleRun(seed, config);
    t.assemble = performance.now() - s - t.plan;
    return assembled.data;
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runs = args.includes("--runs")
    ? Number(args[args.indexOf("--runs") + 1])
    : 3;
  const rows: Row[] = [
    measure(
      "hand-built",
      (t) => {
        const s = performance.now();
        const d = defineLevel();
        t.assemble = performance.now() - s;
        return d;
      },
      runs,
    ),
  ];
  for (const seed of [1, 2, 3]) {
    rows.push(
      measure(`8 rooms, seed ${seed}`, generated(seed, DEFAULT_CONFIG), runs),
    );
  }
  for (const seed of [1, 2]) {
    rows.push(
      measure(
        `12 rooms, seed ${seed}`,
        generated(seed, { ...DEFAULT_CONFIG, rooms: 12 }),
        runs,
      ),
    );
  }
  rows.push(
    measure(
      "8 halls (stress)",
      generated(1, { ...DEFAULT_CONFIG, pool: () => [FILTRATION_HALL] }),
      runs,
    ),
  );
  const cols = [
    "plan",
    "assemble",
    "air",
    "faces",
    "bake",
    "mesh",
    "colliders",
    "total",
  ];
  console.log(
    `| level | brushes | lights (steady) | triangles | ${cols.join(" | ")} |`,
  );
  console.log(`|${" --- |".repeat(cols.length + 4)}`);
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.brushes} | ${r.lights} (${r.steady}) | ${r.triangles} | ${cols
        .map((c) => (r.times[c] === undefined ? "-" : r.times[c].toFixed(0)))
        .join(" | ")} |`,
    );
  }
}
