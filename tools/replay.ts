/**
 * Reproduces a replay saved with F8 in normal play.
 *
 *   bun tools/replay.ts <replay.json> [--every N] [--from step] [--to step]
 *                       [--view debugView] [--out dir]
 *   bun tools/replay.ts <replay.json> --at <step> [--window 20]
 *
 * Runs the replay in a headless game, saves the player's view every N steps
 * (default 30) to out/replay/, builds filmstrip sheets labelled with step
 * numbers, and prints the event log and the player's position over time.
 * With --at, saves every frame from step-window to step+window instead.
 * --from skips frames before that step (the replay still runs from the
 * start; the simulation is only reproducible from a fresh game).
 */
import { join } from "node:path";
import type { DebugView } from "../src/core/api";
import { launchGame } from "./browser";
import { numberOption, parseArgs } from "./cli";
import { contactSheets, type Image } from "./image";
import type { PilotEvent, PilotState } from "./pilot";
import { writePng } from "./png";
import {
  planCaptures,
  replaySteps,
  sliceReplay,
  validateReplay,
} from "./replay-lib";
import { grabFrame, setDebugView } from "./views";

const DEBUG_VIEWS: DebugView[] = [
  "none",
  "coverage",
  "material",
  "depth",
  "normals",
  "lighting",
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = args.positional[0];
  if (!file) {
    throw new Error(
      "usage: bun tools/replay.ts <replay.json> [--every N] [--from step] [--to step] [--at step --window N] [--view debugView] [--out dir]",
    );
  }
  const replay = validateReplay(JSON.parse(await Bun.file(file).text()));
  const total = replaySteps(replay);
  const out = args.options.get("out") ?? "out/replay";
  const debugView = (args.options.get("view") ?? "none") as DebugView;
  if (!DEBUG_VIEWS.includes(debugView)) {
    throw new Error(`--view must be one of ${DEBUG_VIEWS.join(", ")}`);
  }
  const at = args.options.has("at") ? numberOption(args, "at", 0) : undefined;
  const to = Math.min(total, numberOption(args, "to", total));
  const plan = planCaptures({
    total,
    every: numberOption(args, "every", 30),
    from: numberOption(args, "from", 0),
    to,
    at,
    window: numberOption(args, "window", 20),
  });
  const runTo = at !== undefined ? Math.max(...plan.frames, 0) : to;

  console.log(
    `replay ${file}: ${total} steps (seed ${replay.seed}); running to step ${runTo}; ${plan.frames.length} frames`,
  );
  const session = await launchGame();
  try {
    if (debugView !== "none") {
      await setDebugView(session, debugView);
    }
    const stops = [...new Set([...plan.samples, ...plan.frames, runTo])]
      .filter((s) => s >= 1 && s <= runTo)
      .sort((a, b) => a - b);
    const frames = new Set(plan.frames);
    const items: { image: Image; label: string }[] = [];
    const track: { step: number; state: PilotState }[] = [];
    let done = 0;
    for (const stop of stops) {
      const chunk = sliceReplay(replay, done, stop);
      await session.evaluate(
        `__harness.replay(${JSON.stringify(chunk)}, ${stop - done})`,
      );
      done = stop;
      const state = await session.evaluate<PilotState>("__harness.state()");
      track.push({ step: stop, state });
      if (frames.has(stop)) {
        const image = await grabFrame(session);
        const name = `${String(stop).padStart(6, "0")}.png`;
        await writePng(join(out, name), image.width, image.height, image.rgba);
        items.push({ image, label: `STEP ${stop}` });
      }
    }

    const sheets = contactSheets(items, { cols: 3, rows: 4 });
    for (const [i, sheet] of sheets.entries()) {
      const path = join(out, `sheet-${i + 1}.png`);
      await writePng(
        path,
        sheet.image.width,
        sheet.image.height,
        sheet.image.rgba,
      );
      const first = items[sheet.items[0]].label;
      const last = items[sheet.items[sheet.items.length - 1]].label;
      console.log(`wrote ${path}  (${first} .. ${last}, 3 per row)`);
    }

    console.log(
      "\nstep   position (x, y, z)        yaw    pitch  ground crouch held aim",
    );
    for (const { step, state } of track) {
      const p = state.player;
      console.log(
        `${String(step).padStart(5)}  (${p.feet.x.toFixed(2)}, ${p.feet.y.toFixed(2)}, ${p.feet.z.toFixed(2)})`.padEnd(
          34,
        ) +
          `${p.yawDeg.toFixed(1).padStart(6)} ${p.pitchDeg.toFixed(1).padStart(7)}  ${p.onGround ? "yes   " : "no    "} ${p.crouched ? "yes   " : "no    "} ${p.heldBody ?? "-"}  ${p.aim ? `${p.aim.kind}#${p.aim.id}@${p.aim.distance}` : "-"}`,
      );
    }

    const events = await session.evaluate<PilotEvent[]>("__harness.events()");
    const shown = events.filter((e) => e.type !== "footstep");
    const footsteps = events.length - shown.length;
    console.log(`\nevents (${shown.length}, plus ${footsteps} footsteps):`);
    for (const e of shown) {
      const { step, type, ...rest } = e;
      const detail =
        Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
      console.log(`  step ${String(step).padStart(5)}  ${type}${detail}`);
    }
    const last = track[track.length - 1];
    if (last) {
      console.log(`\nHUD at the end: ${JSON.stringify(last.state.hud)}`);
    }
    const errors = session.consoleLines.filter((line) =>
      /^(exception|error)/.test(line),
    );
    if (errors.length > 0) {
      console.log(`\nconsole errors:\n${errors.join("\n")}`);
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(
      "replay failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  },
);
