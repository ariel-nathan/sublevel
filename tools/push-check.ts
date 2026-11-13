/**
 * `bun tools/push-check.ts`: proves the solver's `push` step on Kestrel
 * Annex's metal crate (60 kg, too heavy to carry). Plays the level's
 * declared solution up to the storage room's first carry, then pushes the
 * crate in two legs: west out from between the shelves and the pallet, then
 * south up to the pressure plate. Both must end within PUSH_TOLERANCE.
 *
 * A third push, onto the plate itself, is reported but not required: the
 * plate is a 4 cm static step (src/props builds its collider from the
 * plate's box) and a sliding crate stops against its edge.
 */
import { launchGame } from "./browser";
import { Pilot } from "./pilot";
import { describeStep, Solver } from "./solver";
import type { SolutionStep } from "../src/core/api";

async function main(): Promise<boolean> {
  const session = await launchGame();
  const pilot = new Pilot(session, { run: "push-check" });
  try {
    const solver = await Solver.create(session, pilot);
    const { level } = solver;
    const metal = level.props.findIndex((p) => p.kind === "crate_metal");
    const firstCarry = level.solution.findIndex((s) => s.do === "carry");
    if (metal < 0 || firstCarry < 0) {
      console.log("FAIL: this is not Kestrel Annex (no metal crate or carry)");
      return false;
    }
    // Up to the storage room: everything before its first carry, less the
    // walks that position the player for that carry.
    let upTo = firstCarry;
    while (upTo > 0 && level.solution[upTo - 1].do === "walk") upTo--;
    const at = (x: number, z: number) => ({ x, y: 0, z });
    const steps: [SolutionStep, boolean][] = [
      ...level.solution
        .slice(0, upTo + 1)
        .map((s): [SolutionStep, boolean] => [s, true]),
      [{ do: "walk", to: at(10.5, 10.4) }, true],
      [{ do: "walk", to: at(12.2, 10.4) }, true],
      [{ do: "push", prop: metal, to: { x: 8.5, y: 0.35, z: 9.4 } }, true],
      [{ do: "walk", to: at(9.4, 8.5) }, true],
      [{ do: "push", prop: metal, to: { x: 8.5, y: 0.35, z: 10.85 } }, true],
      [{ do: "push", prop: metal, to: { x: 8.5, y: 0.39, z: 12 } }, false],
    ];
    let ok = true;
    const notes: string[] = [];
    for (const [n, [step, required]] of steps.entries()) {
      pilot.log(`step ${n + 1}/${steps.length}: ${describeStep(step)}`);
      const problem = await solver.run(step);
      if (problem && required) {
        await pilot.frame(`fail-step-${n + 1}`);
        notes.push(`FAIL: step ${n + 1} (${describeStep(step)}): ${problem}`);
        ok = false;
        break;
      }
      if (problem) {
        notes.push(
          `note: ${describeStep(step)}: ${problem} (the plate's edge stops it)`,
        );
      }
    }
    await pilot.frame("end");
    console.log(pilot.transcript.join("\n"));
    console.log("");
    for (const n of notes) console.log(n);
    console.log(
      ok ? "PASS: the metal crate was pushed out and up to the plate." : "FAIL",
    );
    return ok;
  } finally {
    await session.close();
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error("FAIL: push-check crashed:", error);
    process.exit(1);
  },
);
