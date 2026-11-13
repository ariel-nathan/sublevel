/**
 * `bun src/level/rooms/puzzles/prove.ts <room>[,<room>...] [--seeds 0,1,2,3]
 * [--verbose]`: development tool (never imported by the game). Plays the
 * development level `?rooms=<room>&seed=<n>` from its declared solution with
 * the solver bot (tools/solver.ts), once per seed, and reports PASS / FAIL
 * per run. Seed 0 means the modules' defaults (`<room>!default`). The same
 * as `bun tools/solve.ts --rooms <room> --seed n`, several seeds at once.
 */
import { launchGame } from "../../../../tools/browser";
import { Pilot } from "../../../../tools/pilot";
import { describeStep, Solver } from "../../../../tools/solver";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const rooms = (args[0] ?? "").split(",").filter(Boolean);
const seeds = (flag("--seeds") ?? "0,1,2,3").split(",").map(Number);
const verbose = args.includes("--verbose");

async function prove(seed: number): Promise<boolean> {
  const names = rooms.map((r) => (seed === 0 ? `${r}!default` : r));
  const query = `harness&rooms=${names.join(",")}&seed=${seed === 0 ? 1 : seed}`;
  const started = Date.now();
  const session = await launchGame({ query });
  const label = `${rooms.join("+")}-${seed}`;
  const pilot = new Pilot(session, { run: `prove/${label}`, verbose });
  try {
    const solver = await Solver.create(session, pilot);
    const steps = solver.level.solution;
    for (const [n, step] of steps.entries()) {
      pilot.log(`step ${n + 1}/${steps.length}: ${describeStep(step)}`);
      const problem = await solver.run(step);
      if (problem) {
        const frame = await pilot.frame(`fail-step-${n + 1}`);
        if (verbose) console.log(pilot.transcript.join("\n"));
        console.log(
          `FAIL ${label}: step ${n + 1}/${steps.length} (${describeStep(step)}): ${problem}. Frame: ${frame}`,
        );
        return false;
      }
    }
    let state = await pilot.state();
    for (let i = 0; i < 12 && !state.finished; i++) {
      await session.evaluate("__harness.step(5)");
      state = await pilot.state();
    }
    const errors = session.consoleLines.filter((l) =>
      /^(exception|error)/.test(l),
    );
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (errors.length > 0) {
      console.log(`FAIL ${label}: console errors: ${errors.join(" | ")}`);
      return false;
    }
    console.log(
      state.finished
        ? `PASS ${label}: ${steps.length} steps, ${state.step} simulation steps (${secs} s)`
        : `FAIL ${label}: all steps done but not finished`,
    );
    return state.finished;
  } finally {
    await session.close();
  }
}

const results = await Promise.all(
  seeds.map((s) =>
    prove(s).catch((e) => {
      console.log(`FAIL ${rooms.join("+")}-${s}: crashed: ${e}`);
      return false;
    }),
  ),
);
process.exit(results.every(Boolean) ? 0 : 1);
