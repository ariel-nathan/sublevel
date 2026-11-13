/**
 * `bun tools/solve.ts [--seed N] [--verbose]` (`bun run solve`): plays ANY
 * level from its declared solution (`LevelData.solution`) alone, knowing
 * nothing else about it, and checks that it ends finished. This is the
 * proof that a level's room modules declare a solution that works. How
 * each step is carried out: tools/solver.ts.
 *
 * Prints the transcript and PASS, or FAIL naming the step that failed with
 * a frame of it in out/solve/; exit code 0 or 1. Deterministic. `--seed` is
 * passed to the page, but the game does not build seeded levels yet.
 */
import { launchGame } from "./browser";
import { Pilot } from "./pilot";
import { describeStep, Solver } from "./solver";

const args = process.argv.slice(2);

async function main(): Promise<boolean> {
  const started = Date.now();
  const at = args.indexOf("--seed");
  const seed = at >= 0 ? args[at + 1] : undefined;
  if (seed !== undefined) {
    console.log(
      `note: --seed ${seed} is passed to the page, but the game does not build seeded levels yet; playing the level the page builds`,
    );
  }
  const session = await launchGame({
    query: seed === undefined ? "harness" : `harness&seed=${seed}`,
  });
  const pilot = new Pilot(session, {
    run: "solve",
    verbose: args.includes("--verbose"),
  });
  try {
    const solver = await Solver.create(session, pilot);
    const { level } = solver;
    const steps = level.solution;
    if (steps.length === 0) {
      console.log(`FAIL: "${level.name}" declares no solution`);
      return false;
    }
    pilot.log(`level "${level.name}", ${steps.length} solution steps`);
    for (const [n, step] of steps.entries()) {
      pilot.log(`step ${n + 1}/${steps.length}: ${describeStep(step)}`);
      const problem = await solver.run(step);
      if (problem) {
        const frame = await pilot.frame(`fail-step-${n + 1}`);
        console.log(pilot.transcript.join("\n"));
        console.log(
          `\nFAIL: step ${n + 1}/${steps.length} (${describeStep(step)}): ${problem}. Frame: ${frame}`,
        );
        return false;
      }
    }
    // The last walk ends in the exit box; give the game a moment to notice.
    let state = await pilot.state();
    for (let i = 0; i < 12 && !state.finished; i++) {
      await session.evaluate("__harness.step(5)");
      state = await pilot.state();
    }
    await pilot.frame("end");
    console.log(pilot.transcript.join("\n"));
    const errors = session.consoleLines.filter((l) =>
      /^(exception|error)/.test(l),
    );
    if (errors.length > 0) {
      console.log(`\nFAIL: console errors: ${errors.join(" | ")}`);
      return false;
    }
    const feet = state.player.feet;
    console.log(
      state.finished
        ? `\nPASS: "${level.name}" finished from its declared solution: ${steps.length} steps, ${state.step} simulation steps.`
        : `\nFAIL: all ${steps.length} steps done but the level is not finished (feet at ${feet.x.toFixed(2)}, ${feet.z.toFixed(2)}).`,
    );
    console.error(`(took ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return state.finished;
  } finally {
    await session.close();
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error("FAIL: solve crashed:", error);
    process.exit(1);
  },
);
