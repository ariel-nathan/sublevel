/**
 * `bun tools/check-seed.ts --seed N` (also `--seeds A..B`, `--count K --from A`,
 * `--rooms a,b`): everything that can be checked about a generated level
 * without a human, with a compact summary and a non-zero exit code on any
 * failure.
 *
 * For each seed, in one go (the three browser sessions run concurrently):
 *   solve     plays the declared solution (solve.ts)
 *   lint      visual lint on the automatic viewpoints, doors closed and open:
 *             must find 0 holes and 0 shimmer (lint-visual.ts)
 *   coverage  generic coverage sweep over the open floor of every zone, doors
 *             closed and open: must count 0 magenta pixels (coverage-sweep.ts)
 *   tour      contact sheets per room, doors, targets (tour.ts)
 *   map       top-down plan of the whole level (map.ts)
 * Doors are opened without playing the level (doors.ts); a door that cannot
 * be opened is a warning, not a failure.
 *
 * Output: out/check/<tag>/{map.png, tour/sheet-*.png, lint/, coverage/,
 * solve/fail-step-N/} (git-ignored). Options: --parallel P (seeds at once,
 * default 1, max 4), --step M (coverage grid, default 2), --out dir,
 * --no-lint, --no-coverage, --no-tour, --no-solve.
 */
import type { LevelData } from "../src/core/api";
import { autoViews } from "./auto-views";
import { launchGame } from "./browser";
import { parseArgs } from "./cli";
import { openAllDoors } from "./doors";
import { describeSweep, runSweep, sweepShots } from "./coverage-sweep";
import {
  levelQuery,
  levelSelector,
  levelTag,
  seedList,
  type LevelSelector,
} from "./level-args";
import { lintViews, probeDebugViews } from "./lint-visual";
import { writeMap } from "./map";
import { runTour } from "./tour";
import { runPool, solveLevel } from "./solve";
import { join } from "node:path";

interface Options {
  out: string;
  step: number;
  lint: boolean;
  coverage: boolean;
  tour: boolean;
  solve: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  /** One short phrase for the summary. */
  text: string;
  seconds: number;
}

export interface SeedResult {
  tag: string;
  level: string;
  checks: Check[];
  warnings: string[];
  seconds: number;
}

const timed = async (
  name: string,
  fn: () => Promise<{ ok: boolean; text: string }>,
): Promise<Check> => {
  const t = Date.now();
  try {
    const r = await fn();
    return { name, ...r, seconds: (Date.now() - t) / 1000 };
  } catch (error) {
    return {
      name,
      ok: false,
      text: `crashed: ${error instanceof Error ? error.message : String(error)}`,
      seconds: (Date.now() - t) / 1000,
    };
  }
};

export async function checkSeed(
  sel: LevelSelector,
  opts: Options,
): Promise<SeedResult> {
  const started = Date.now();
  const tag = levelTag(sel);
  const dir = join(opts.out, tag);
  const warnings: string[] = [];
  const checks: Check[] = [];
  let level = "?";

  const solveJob = async (): Promise<void> => {
    if (!opts.solve) return;
    checks.push(
      await timed("solve", async () => {
        const r = await solveLevel({ sel, out: join(dir, "solve") });
        level = r.level;
        return {
          ok: r.ok,
          text: r.ok
            ? `${r.steps} steps, ${r.simSeconds.toFixed(0)} s simulated`
            : `step ${r.failStep}: ${r.failure} (see ${join(dir, "solve")})`,
        };
      }),
    );
  };

  const tourJob = async (): Promise<void> => {
    if (!opts.tour) return;
    checks.push(
      await timed("tour", async () => {
        const session = await launchGame({ query: levelQuery(sel) });
        try {
          const r = await runTour(
            session,
            undefined,
            "none",
            join(dir, "tour"),
            true,
            true,
          );
          warnings.push(
            ...r.notOpened.map((d) => `door ${d} not opened (tour)`),
          );
          return {
            ok: r.errors.length === 0,
            text:
              r.errors.length > 0
                ? `console errors: ${r.errors.join(" | ")}`
                : `${r.frames} views, ${r.sheets.length} sheets`,
          };
        } finally {
          await session.close();
        }
      }),
    );
  };

  const lintJob = async (): Promise<void> => {
    if (!opts.lint && !opts.coverage) return;
    const session = await launchGame({ query: levelQuery(sel) });
    try {
      const data = await session.evaluate<LevelData>("__game.level.data");
      const views = autoViews(data);
      const shots = sweepShots(data, opts.step);
      let closed: Awaited<ReturnType<typeof runSweep>> | null = null;
      if (opts.coverage) {
        checks.push(
          await timed("coverage", async () => {
            closed = await runSweep(
              session,
              shots,
              "closed",
              join(dir, "coverage"),
            );
            return { ok: true, text: "" };
          }),
        );
      }
      if (opts.lint) {
        checks.push(
          await timed("lint", async () => {
            await probeDebugViews(session, views[0]);
            const run = await lintViews(
              session,
              views,
              join(dir, "lint"),
              async () => {
                const report = await openAllDoors(session, data);
                warnings.push(
                  ...report.failed.map(
                    (f) => `door ${f.door} not opened (lint)`,
                  ),
                );
              },
            );
            const flaggedNames = run.flagged
              .slice(0, 4)
              .map((r) => `${r.view}/${r.doors}`)
              .join(", ");
            return {
              ok: run.flagged.length === 0,
              text:
                `${views.length} views x 2 states: ${run.holeStates} holes, ${run.shimmerStates} shimmer` +
                (run.flagged.length > 0
                  ? ` (${flaggedNames}; see ${join(dir, "lint")})`
                  : ""),
            };
          }),
        );
      } else if (opts.coverage) {
        const report = await openAllDoors(session, data);
        warnings.push(
          ...report.failed.map((f) => `door ${f.door} not opened (coverage)`),
        );
      }
      if (opts.coverage) {
        const c = checks.find((x) => x.name === "coverage")!;
        const t = Date.now();
        const open = await runSweep(
          session,
          shots,
          "open",
          join(dir, "coverage"),
        );
        const results = [closed!, open];
        c.seconds += (Date.now() - t) / 1000;
        c.ok = results.every((r) => r.holes.length === 0);
        c.text = describeSweep(results);
      }
    } finally {
      await session.close();
    }
  };

  // The map needs no browser.
  try {
    await writeMap(sel, join(dir, "map.png"));
  } catch (error) {
    warnings.push(
      `map failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await Promise.all([solveJob(), tourJob(), lintJob()]);
  checks.sort((a, b) => a.name.localeCompare(b.name));
  return {
    tag,
    level,
    checks,
    warnings,
    seconds: (Date.now() - started) / 1000,
  };
}

export function formatSeed(r: SeedResult): string {
  const lines = [
    `${r.tag}  "${r.level}"  ${r.checks.every((c) => c.ok) ? "PASS" : "FAIL"}  ${r.seconds.toFixed(0)} s`,
  ];
  for (const c of r.checks) {
    lines.push(
      `  ${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(9)} ${c.text} (${c.seconds.toFixed(0)} s)`,
    );
  }
  for (const w of r.warnings) lines.push(`  warn ${w}`);
  return lines.join("\n");
}

async function main(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2), [
    "no-lint",
    "no-coverage",
    "no-tour",
    "no-solve",
  ]);
  const base = levelSelector(args);
  const seeds = seedList(args);
  const sels: LevelSelector[] = seeds
    ? seeds.map((seed) => ({ ...base, seed }))
    : [base];
  const opts: Options = {
    out: args.options.get("out") ?? "out/check",
    step: Number(args.options.get("step") ?? 2),
    lint: !args.options.has("no-lint"),
    coverage: !args.options.has("no-coverage"),
    tour: !args.options.has("no-tour"),
    solve: !args.options.has("no-solve"),
  };
  const parallel = Math.min(
    Math.max(1, Math.floor(Number(args.options.get("parallel") ?? 1))),
    4,
  );
  const started = Date.now();
  const results = await runPool(sels, parallel, async (sel) => {
    const r = await checkSeed(sel, opts);
    console.log(formatSeed(r));
    return r;
  });
  const failed = results.filter((r) => r.checks.some((c) => !c.ok));
  if (results.length > 1) {
    console.log("\nseed        result  time");
    for (const r of results) {
      console.log(
        `${r.tag.padEnd(11)} ${r.checks.every((c) => c.ok) ? "PASS  " : "FAIL  "} ${r.seconds.toFixed(0)} s`,
      );
    }
  }
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} seeds clean (${((Date.now() - started) / 1000).toFixed(0)} s)`,
  );
  return failed.length === 0;
}

if (import.meta.main) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error("check-seed crashed:", error);
      process.exit(2);
    },
  );
}
