/**
 * `bun tools/push-check.ts`: proves the solver's `push` step on Kestrel
 * Annex's metal crate (60 kg, too heavy to carry). Plays the level's
 * declared solution up to the storage room's first carry, then pushes the
 * crate in three legs: west out from between the shelves and the pallet,
 * south up to the pressure plate, and onto the plate itself. All three must
 * end within PUSH_TOLERANCE, and the last must press the plate (a
 * `plate_down` event and door B opening): the plate is flush with the floor
 * (src/props/plates.ts), so a crate slides onto it without snagging.
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
    const plate = level.plates[0];
    const plateCentre = {
      x: (plate.box.min.x + plate.box.max.x) / 2,
      z: (plate.box.min.z + plate.box.max.z) / 2,
    };
    const steps: SolutionStep[] = [
      ...level.solution.slice(0, upTo + 1),
      { do: "walk", to: at(10.5, 10.4) },
      { do: "walk", to: at(12.2, 10.4) },
      { do: "push", prop: metal, to: { x: 8.5, y: 0.35, z: 9.4 } },
      { do: "walk", to: at(9.4, 8.5) },
      { do: "push", prop: metal, to: { x: 8.5, y: 0.35, z: 10.85 } },
      {
        do: "push",
        prop: metal,
        to: { x: plateCentre.x, y: 0.35, z: plateCentre.z },
      },
    ];
    let ok = true;
    const notes: string[] = [];
    let pushedAt = 0;
    for (const [n, step] of steps.entries()) {
      pilot.log(`step ${n + 1}/${steps.length}: ${describeStep(step)}`);
      if (n === steps.length - 1) pushedAt = (await pilot.state()).step;
      const problem = await solver.run(step);
      if (problem) {
        await pilot.frame(`fail-step-${n + 1}`);
        notes.push(`FAIL: step ${n + 1} (${describeStep(step)}): ${problem}`);
        ok = false;
        break;
      }
    }
    if (ok) {
      // Let the plate's debounce and the door act.
      await pilot.wait(40);
      const events = await pilot.events(pushedAt - 1);
      const down = events.find((e) => e.type === "plate_down");
      const open = events.find((e) => e.type === "door_open");
      const body = (await pilot.bodies("crate_metal")).find(
        (b) => b.id === solver.body(metal),
      );
      if (!down) {
        notes.push("FAIL: the crate is on the plate but no plate_down event");
        ok = false;
      } else {
        notes.push(`plate_down at step ${down.step}`);
      }
      if (!open) {
        notes.push("FAIL: door B did not open");
        ok = false;
      }
      if (body) {
        notes.push(
          `crate rests at (${body.position.x.toFixed(2)}, ${body.position.y.toFixed(2)}, ${body.position.z.toFixed(2)})`,
        );
      }
    }
    await pilot.frame("end");
    console.log(pilot.transcript.join("\n"));
    console.log("");
    for (const n of notes) console.log(n);
    console.log(
      ok
        ? "PASS: the metal crate was pushed out, up to and onto the plate, and pressed it."
        : "FAIL",
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
