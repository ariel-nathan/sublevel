/**
 * Generator statistics over 200 seeds (SUBLEVEL_FUZZ=1 only; about a
 * minute): every run generates, assembles, passes the chain and solution
 * checks and builds; prints the distribution of mechanics and modules, the
 * facility's size, fallbacks, and build-time percentiles; and how runs
 * differ (first rooms, mechanics and set pieces per run, distinct room
 * sequences and sets, mirroring).
 */
import { expect, test } from "bun:test";
import { boxOf } from "../geometry";
import { buildLevelFrom } from "../index";
import { chainProblems, solutionProblems } from "./checks";
import { DEFAULT_CONFIG } from "./config";
import { assembleRun } from "./index";
import { ramps } from "./mission";

const FUZZ = process.env.SUBLEVEL_FUZZ === "1";

test.skipIf(!FUZZ)(
  "200 seeds: no failures; statistics",
  () => {
    const failures: string[] = [];
    const mechanics = new Map<string, number>();
    const modules = new Map<string, number>();
    const sizes: { x: number; z: number }[] = [];
    const times: number[] = [];
    const brushes: number[] = [];
    const triangles: number[] = [];
    const lights: number[] = [];
    let fallbacks = 0;
    const firsts = new Map<string, number>();
    const perRun = new Map<number, number>();
    const pieceCounts = new Map<number, number>();
    const sequences = new Set<string>();
    const sets = new Set<string>();
    let unramped = 0;
    let mirrored = 0;
    for (let seed = 1; seed <= 200; seed++) {
      try {
        const started = performance.now();
        const { run, assembled } = assembleRun(seed);
        const built = buildLevelFrom(assembled.data);
        times.push(performance.now() - started);
        const problems = [
          ...chainProblems(run, assembled, DEFAULT_CONFIG),
          ...solutionProblems(assembled.data),
        ];
        if (problems.length > 0) failures.push(`seed ${seed}: ${problems[0]}`);
        if (run.fallback) fallbacks++;
        for (const r of run.mission) {
          mechanics.set(r.mechanic, (mechanics.get(r.mechanic) ?? 0) + 1);
          modules.set(r.module.name, (modules.get(r.module.name) ?? 0) + 1);
        }
        const names = run.mission.map((r) => r.module.name);
        const first = names[0];
        firsts.set(first, (firsts.get(first) ?? 0) + 1);
        const n = new Set(run.mission.map((r) => r.mechanic)).size;
        perRun.set(n, (perRun.get(n) ?? 0) + 1);
        sequences.add(names.join(">"));
        sets.add([...names].sort().join(","));
        const pieces = run.mission.filter((r) => r.module.setPiece).length;
        pieceCounts.set(pieces, (pieceCounts.get(pieces) ?? 0) + 1);
        if (!ramps(run.mission)) unramped++;
        mirrored += run.pieces.filter(
          (p) => p.kind === "room" && p.mirror,
        ).length;
        const all = assembled.rooms.flatMap((r) => r.plan.footprint.map(boxOf));
        sizes.push({
          x:
            Math.max(...all.map((b) => b.x1)) -
            Math.min(...all.map((b) => b.x0)),
          z:
            Math.max(...all.map((b) => b.z1)) -
            Math.min(...all.map((b) => b.z0)),
        });
        brushes.push(assembled.data.brushes.length);
        lights.push(assembled.data.lights.length);
        triangles.push(
          built.meshes.reduce((n, m) => n + m.indices.length / 3, 0),
        );
      } catch (error) {
        failures.push(`seed ${seed}: ${String(error)}`);
      }
    }
    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
    };
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const lines = [
      `seeds 200, failures ${failures.length}, straight fallbacks ${fallbacks}`,
      `mechanics: ${[...mechanics].map(([k, v]) => `${k} ${v}`).join(", ")}`,
      `modules: ${[...modules]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
      `first rooms: ${[...firsts].map(([k, v]) => `${k} ${v}`).join(", ")}`,
      `mechanics per run: ${[...perRun].map(([k, v]) => `${k}: ${v}`).join(", ")}; set pieces per run: ${[
        ...pieceCounts,
      ]
        .sort()
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}`,
      `distinct room sequences ${sequences.size}, distinct room sets ${sets.size}, runs not ramping ${unramped}, rooms mirrored ${mirrored} of ${200 * DEFAULT_CONFIG.rooms}`,
      `facility size: mean ${mean(sizes.map((s) => s.x)).toFixed(1)} x ${mean(sizes.map((s) => s.z)).toFixed(1)} m, largest side max ${Math.max(...sizes.map((s) => Math.max(s.x, s.z))).toFixed(1)} m`,
      `brushes mean ${mean(brushes).toFixed(0)} (max ${Math.max(...brushes)}), lights mean ${mean(lights).toFixed(1)} (max ${Math.max(...lights)}), triangles mean ${mean(triangles).toFixed(0)} (max ${Math.max(...triangles)})`,
      `generate + build ms: p50 ${pct(times, 50).toFixed(0)}, p90 ${pct(times, 90).toFixed(0)}, p99 ${pct(times, 99).toFixed(0)}, max ${Math.max(...times).toFixed(0)}`,
    ];
    console.log(lines.join("\n"));
    expect(failures).toEqual([]);
  },
  600_000,
);
