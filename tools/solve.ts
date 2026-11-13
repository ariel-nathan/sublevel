/**
 * `bun tools/solve.ts [options]` (`bun run solve`): plays ANY level from its
 * declared solution (`LevelData.solution`) alone, knowing nothing else about
 * it, and checks that it ends finished. This is the proof that a level's
 * room modules declare a solution that works. How each step is carried out:
 * tools/solver.ts.
 *
 *   --seed N | --rooms a,b   which level (the page's query; default: hand-built)
 *   --seeds A..B             solve each seed in turn (inclusive)
 *   --count K [--from A]     solve K seeds starting at A (default 1)
 *   --parallel P             P headless sessions at once (default 1, max 8)
 *   --keep-going             after a failed step carry on with the next ones
 *   --frames                 save a frame after every step (out/solve/.../step-NN.png)
 *   --verbose                print every transcript line as it happens
 *   --out dir                output folder (default out/solve)
 *
 * Prints the transcript and PASS/FAIL for one level, or a table (seed,
 * level, steps, simulated time, result, failing step) for several. Exit code
 * 0 if every level passed, 1 otherwise. Deterministic.
 *
 * On a failed step, `<out>/<tag>/fail-step-N/` gets everything needed to
 * diagnose it without re-running: `eyes.png` (the frame from the player's
 * eyes), `plan.png` (top-down plan around the player and the step's target:
 * red disc player with facing, white ring the target, yellow squares props
 * nearby, the whole declared solution in blue), `events.txt` (the last 30
 * events), `step.txt` (step index, the step, the problem, state).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LevelData, SolutionStep } from "../src/core/api";
import { launchGame } from "./browser";
import { parseArgs } from "./cli";
import {
  levelQuery,
  levelSelector,
  levelTag,
  seedList,
  type LevelSelector,
} from "./level-args";
import { Pilot } from "./pilot";
import { renderPlan, type PlanMarker } from "./plan-draw";
import { writePng } from "./png";
import { describeStep, Solver } from "./solver";

export interface SolveOptions {
  sel: LevelSelector;
  verbose?: boolean;
  frames?: boolean;
  keepGoing?: boolean;
  /** JavaScript run in the page before solving (to test the failure report). */
  tamper?: string;
  /** Output root; the run's files go in `<out>/<tag>` (or `<out>` for the default level). */
  out?: string;
}

export interface SolveResult {
  tag: string;
  level: string;
  steps: number;
  /** Simulation steps used, and the same in seconds. */
  simSteps: number;
  simSeconds: number;
  ok: boolean;
  /** 1-based index of the first failed step, with what went wrong. */
  failStep?: number;
  failure?: string;
  /** Every failure when `keepGoing`. */
  failures: { step: number; text: string }[];
  /** Wall-clock seconds. */
  wall: number;
  transcript: string[];
}

/** Writes the artefacts of a failed step; returns the folder. */
async function saveFailure(
  pilot: Pilot,
  level: LevelData,
  runDir: string,
  index: number,
  step: SolutionStep,
  problem: string,
): Promise<string> {
  const dir = join(runDir, `fail-step-${index + 1}`);
  mkdirSync(dir, { recursive: true });
  const session = pilot.session;
  await session.captureFrame(join(dir, "eyes.png"));
  const state = await pilot.state();
  const feet = state.player.feet;
  // What the step was about: the point it aims at.
  let target: { x: number; z: number } | null = null;
  let targetY = 0;
  if (step.do === "walk" || step.do === "carry" || step.do === "push") {
    target = step.to;
    targetY = step.to.y ?? 0;
  } else if (step.do === "throw") {
    target = step.at;
    targetY = step.at.y;
  } else if (step.do === "press") {
    const b = level.buttons.find((x) => x.id === step.button);
    if (b) {
      target = b.position;
      targetY = b.position.y;
    }
  }
  const markers: PlanMarker[] = [
    {
      kind: "player",
      x: feet.x,
      z: feet.z,
      yawDeg: state.player.yawDeg,
      label: "player",
    },
  ];
  if (target)
    markers.push({ kind: "target", x: target.x, z: target.z, label: "target" });
  const near = (p: { x: number; z: number }): boolean =>
    Math.hypot(p.x - feet.x, p.z - feet.z) < 7 ||
    (target !== null && Math.hypot(p.x - target.x, p.z - target.z) < 7);
  const nearby = state.bodies.filter((b) => near(b.position));
  for (const b of nearby) {
    markers.push({
      kind: "prop",
      x: b.position.x,
      z: b.position.z,
      label: `${b.tag}#${b.id}`,
    });
  }
  const focus = target ?? feet;
  const r = 8;
  const crop = {
    x0: Math.min(feet.x, focus.x) - r,
    x1: Math.max(feet.x, focus.x) + r,
    z0: Math.min(feet.z, focus.z) - r,
    z1: Math.max(feet.z, focus.z) + r,
  };
  const plan = renderPlan(level, {
    crop,
    scale: 40,
    markers,
    title: `step ${index + 1}: ${describeStep(step)}`.slice(0, 80),
  });
  await writePng(join(dir, "plan.png"), plan.width, plan.height, plan.rgba);
  const events = await pilot.events();
  writeFileSync(
    join(dir, "events.txt"),
    events
      .filter((e) => e.type !== "footstep")
      .slice(-30)
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "step.txt"),
    [
      `step ${index + 1} of ${level.solution.length}: ${describeStep(step)}`,
      `step json: ${JSON.stringify(step)}`,
      `problem: ${problem}`,
      `simulation step: ${state.step}`,
      `player: feet (${feet.x.toFixed(2)}, ${feet.y.toFixed(2)}, ${feet.z.toFixed(2)}) yaw ${state.player.yawDeg} pitch ${state.player.pitchDeg} held ${state.player.heldBody}`,
      `target: ${target ? `(${target.x.toFixed(2)}, ${targetY.toFixed(2)}, ${target.z.toFixed(2)})` : "none"}`,
      "nearby bodies:",
      ...nearby.map(
        (b) =>
          `  #${b.id} ${b.tag} at (${b.position.x.toFixed(2)}, ${b.position.y.toFixed(2)}, ${b.position.z.toFixed(2)})`,
      ),
      "",
    ].join("\n"),
  );
  return dir;
}

/** Plays one level from its declared solution. */
export async function solveLevel(options: SolveOptions): Promise<SolveResult> {
  const started = Date.now();
  const tag = levelTag(options.sel);
  const outRoot = options.out ?? "out/solve";
  const runDir = tag === "annex" ? outRoot : join(outRoot, tag);
  const session = await launchGame({ query: levelQuery(options.sel) });
  // The pilot writes under "<outDir>/<run>"; split the run folder so that it
  // lands in runDir.
  const pilot = new Pilot(session, {
    outDir: runDir,
    run: ".",
    verbose: options.verbose,
  });
  const result: SolveResult = {
    tag,
    level: "?",
    steps: 0,
    simSteps: 0,
    simSeconds: 0,
    ok: false,
    failures: [],
    wall: 0,
    transcript: pilot.transcript,
  };
  try {
    if (options.tamper) await session.evaluate(options.tamper);
    const solver = await Solver.create(session, pilot);
    const { level } = solver;
    result.level = level.name;
    const steps = level.solution;
    result.steps = steps.length;
    if (steps.length === 0) {
      result.failures.push({ step: 0, text: "the level declares no solution" });
      result.failStep = 0;
      result.failure = "no solution declared";
      return result;
    }
    pilot.log(`level "${level.name}", ${steps.length} solution steps`);
    for (const [n, step] of steps.entries()) {
      pilot.log(`step ${n + 1}/${steps.length}: ${describeStep(step)}`);
      const problem = await solver.run(step);
      if (problem) {
        const dir = await saveFailure(pilot, level, runDir, n, step, problem);
        pilot.log(`FAILED: ${problem} (artefacts in ${dir})`);
        result.failures.push({
          step: n + 1,
          text: `${describeStep(step)}: ${problem}`,
        });
        result.failStep ??= n + 1;
        result.failure ??= `${describeStep(step)}: ${problem}`;
        if (!options.keepGoing) break;
      }
      if (options.frames) {
        await pilot.frame(`step-${String(n + 1).padStart(2, "0")}`);
      }
    }
    // The last walk ends in the exit box; give the game a moment to notice.
    let state = await pilot.state();
    for (
      let i = 0;
      i < 12 && !state.finished && result.failures.length === 0;
      i++
    ) {
      await session.evaluate("__harness.step(5)");
      state = await pilot.state();
    }
    result.simSteps = state.step;
    result.simSeconds = state.step / 60;
    if (result.failures.length === 0) {
      await pilot.frame("end");
      const errors = session.consoleLines.filter((l) =>
        /^(exception|error)/.test(l),
      );
      if (errors.length > 0) {
        result.failStep = steps.length;
        result.failure = `console errors: ${errors.join(" | ")}`;
        result.failures.push({ step: steps.length, text: result.failure });
      } else if (!state.finished) {
        const feet = state.player.feet;
        result.failStep = steps.length;
        result.failure = `all steps done but the level is not finished (feet at ${feet.x.toFixed(2)}, ${feet.z.toFixed(2)})`;
        result.failures.push({ step: steps.length, text: result.failure });
      }
    }
    result.ok = result.failures.length === 0;
    return result;
  } catch (error) {
    result.failure = `crashed: ${error instanceof Error ? error.message : String(error)}`;
    result.failures.push({ step: result.failStep ?? 0, text: result.failure });
    return result;
  } finally {
    result.wall = (Date.now() - started) / 1000;
    await session.close();
  }
}

/** Runs `jobs` with at most `parallel` at a time, results in job order. */
export async function runPool<T, R>(
  jobs: readonly T[],
  parallel: number,
  run: (job: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await run(jobs[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallel, jobs.length) }, worker),
  );
  return results;
}

export function formatTable(results: readonly SolveResult[]): string {
  const rows = [
    ["level", "name", "steps", "sim s", "wall s", "result", "failing step"],
    ...results.map((r) => [
      r.tag,
      r.level,
      String(r.steps),
      r.simSeconds.toFixed(1),
      r.wall.toFixed(1),
      r.ok ? "PASS" : "FAIL",
      r.ok ? "" : `${r.failStep ?? "?"}: ${r.failure ?? ""}`,
    ]),
  ];
  const widths = rows[0].map((_, c) =>
    Math.max(...rows.map((row) => row[c].length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, c) => cell.padEnd(widths[c]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

async function main(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2), [
    "verbose",
    "frames",
    "keep-going",
  ]);
  const base = levelSelector(args);
  const seeds = seedList(args);
  const sels: LevelSelector[] = seeds
    ? seeds.map((seed) => ({ ...base, seed }))
    : [base];
  const requested = Number(args.options.get("parallel") ?? 1);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("--parallel must be a positive integer");
  }
  const parallel = Math.min(requested, 8);
  if (parallel < requested)
    console.log(`note: --parallel capped at ${parallel}`);
  const options = {
    verbose: args.options.has("verbose") && sels.length === 1,
    frames: args.options.has("frames"),
    keepGoing: args.options.has("keep-going"),
    out: args.options.get("out"),
    tamper: args.options.get("tamper"),
  };
  const started = Date.now();
  const results = await runPool(sels, parallel, async (sel) => {
    const r = await solveLevel({ sel, ...options });
    if (sels.length > 1) {
      console.log(
        `${r.tag}: ${r.ok ? "PASS" : `FAIL step ${r.failStep}: ${r.failure}`} (${r.wall.toFixed(1)} s)`,
      );
    }
    return r;
  });
  if (sels.length === 1) {
    const r = results[0];
    console.log(r.transcript.join("\n"));
    console.log(
      r.ok
        ? `\nPASS: "${r.level}" finished from its declared solution: ${r.steps} steps, ${r.simSteps} simulation steps.`
        : `\nFAIL: ${r.failures.map((f) => `step ${f.step}: ${f.text}`).join("; ")}`,
    );
    console.error(`(took ${r.wall.toFixed(1)} s)`);
    return r.ok;
  }
  console.log(`\n${formatTable(results)}`);
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.log(`\n--- ${r.tag} transcript (last 25 lines) ---`);
    console.log(r.transcript.slice(-25).join("\n"));
  }
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} levels solved (${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  return failed.length === 0;
}

if (import.meta.main) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error("FAIL: solve crashed:", error);
      process.exit(1);
    },
  );
}
