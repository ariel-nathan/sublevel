/**
 * `bun src/level/rooms/puzzles/prove.ts <room>[,<room>...] [--seeds 0,1,2,3]
 * [--verbose]`: development tool (never imported by the game). Plays the
 * development level `?rooms=<room>&seed=<n>` from its declared solution with
 * the solver bot (tools/solver.ts), once per seed, and reports PASS / FAIL
 * per run. Seed 0 means the modules' defaults (`<room>!default`).
 *
 * A `walk` whose target is higher than the feet (climbing onto props, which
 * the solution format has no step for yet) is done here as a walk holding
 * jump; nothing else differs from `bun run solve`.
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
  /**
   * Climbs onto something higher: face the point, one jump with a run at
   * it, keep running until landed (stopping short of the point), then
   * settle on the spot. Up to three tries.
   */
  const climb = async (to: {
    x: number;
    y: number;
    z: number;
  }): Promise<string | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = (await pilot.state()).player.feet;
      const yaw = (Math.atan2(-(to.x - f.x), -(to.z - f.z)) * 180) / Math.PI;
      await pilot.look(yaw, -20, true);
      await session.evaluate(`__harness.step(1, {"moveZ":1,"jump":true})`);
      for (let i = 0; i < 40; i++) {
        const s = await pilot.state();
        const d = Math.hypot(to.x - s.player.feet.x, to.z - s.player.feet.z);
        if (i > 4 && s.player.onGround) break;
        await session.evaluate(
          `__harness.step(2, {"moveZ":${d > 0.3 ? 1 : 0}})`,
        );
      }
      const now = (await pilot.state()).player.feet;
      if (now.y > to.y - 0.2) {
        await pilot.walkTo(to.x, to.z, { direct: true, tolerance: 0.15 });
        return null;
      }
      pilot.log(
        `climb ${attempt + 1} fell short (feet at y ${now.y.toFixed(2)})`,
      );
    }
    return "did not climb up";
  };
  try {
    const solver = await Solver.create(session, pilot);
    const steps = solver.level.solution;
    for (const [n, step] of steps.entries()) {
      pilot.log(`step ${n + 1}/${steps.length}: ${describeStep(step)}`);
      let problem: string | null;
      const feet = (await pilot.state()).player.feet;
      if (step.do === "walk" && step.to.y > feet.y + 0.25) {
        problem = await climb(step.to);
      } else if (step.do === "walk" && step.to.y < feet.y - 0.25) {
        // Stepping down off a ledge: walk off, land, then finish the walk.
        await pilot.walkTo(step.to.x, step.to.z, {
          direct: true,
          tolerance: 0.4,
        });
        await pilot.wait(45);
        problem = await solver.run(step);
      } else {
        problem = await solver.run(step);
      }
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
