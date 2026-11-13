/**
 * `bun run tour`: renders a table of named viewpoints (every room, both door
 * states) and writes one PNG per view plus labelled contact sheets.
 *
 *   bun run tour [--only <substring>] [--view <debugView>] [--out <dir>]
 *   bun run tour --seed N | --rooms a,b [--auto] [...]
 *
 * Without --seed/--rooms the fixed table VIEWS (views.ts, hand-built level) is
 * used. With either (or --auto) the viewpoints are derived from the level
 * (auto-views.ts) and the sheets are per room (sheet-z03.png ...), then
 * sheet-doors.png and sheet-targets.png; output goes to out/tour/<tag>/.
 *   bun run tour --diff <dirA> <dirB> [--out <dir>]
 *
 * --diff compares two earlier tour outputs view by view and writes diff
 * sheets (A | B | amplified difference) plus a changed-pixel table.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DebugView, LevelData } from "../src/core/api";
import { autoViews } from "./auto-views";
import { openAllDoors } from "./doors";
import {
  isSelected,
  levelQuery,
  levelSelector,
  levelTag,
  type LevelSelector,
} from "./level-args";
import { launchGame, type GameSession } from "./browser";
import { parseArgs } from "./cli";
import {
  contactSheets,
  diffImages,
  drawLabel,
  hstack,
  vstack,
  type Image,
} from "./image";
import { Pilot } from "./pilot";
import { readPng, writePng } from "./png";
import {
  VIEWS,
  grabFrame,
  openDoors,
  poseOf,
  selectViews,
  setDebugView,
  setPose,
  type Viewpoint,
} from "./views";

const DEBUG_VIEWS: DebugView[] = [
  "none",
  "coverage",
  "material",
  "depth",
  "normals",
  "lighting",
];

async function savePng(path: string, image: Image): Promise<void> {
  await writePng(path, image.width, image.height, image.rgba);
}

/** Which contact-sheet group an automatic viewpoint belongs to. */
export function groupOf(name: string): string {
  const room = /^(z\d+)-/.exec(name);
  if (room) return room[1];
  return name.startsWith("door-") ? "doors" : "targets";
}

async function tour(
  only: string | undefined,
  debugView: DebugView,
  out: string,
  sel: LevelSelector,
  auto: boolean,
): Promise<void> {
  const session = await launchGame({ query: levelQuery(sel) });
  try {
    const result = await runTour(session, only, debugView, out, auto);
    if (result.errors.length > 0) {
      console.log(`\nconsole errors:\n${result.errors.join("\n")}`);
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

export interface TourResult {
  frames: number;
  sheets: string[];
  /** Doors that could not be opened (automatic tours). */
  notOpened: string[];
  /** Console errors from the page. */
  errors: string[];
}

/** Renders the tour on an existing session (see the file header). */
export async function runTour(
  session: GameSession,
  only: string | undefined,
  debugView: DebugView,
  out: string,
  auto: boolean,
  quiet = false,
): Promise<TourResult> {
  const notOpened: string[] = [];
  const sheetPaths: string[] = [];
  const log = (text: string): void => {
    if (!quiet) console.log(text);
  };
  {
    const pilot = new Pilot(session, { run: "tour", outDir: "out" });
    let all: readonly Viewpoint[] = VIEWS;
    if (auto) {
      const level = await session.evaluate<LevelData>("__game.level.data");
      all = autoViews(level);
      log(`automatic viewpoints: ${all.length} for "${level.name}"`);
    }
    const views = selectViews(all, only);
    if (views.length === 0) {
      throw new Error(`no viewpoint matches "${only}"`);
    }
    const items: { image: Image; label: string }[] = [];
    const lines: string[] = [];
    const capture = async (name: string, index: number): Promise<void> => {
      const view = views.find((v) => v.name === name)!;
      await setPose(session, poseOf(view));
      await setDebugView(session, debugView);
      const image = await grabFrame(session);
      await savePng(join(out, `${name}.png`), image);
      const label = `${String(index + 1).padStart(2, "0")} ${name}`;
      items[index] = { image, label };
      lines[index] =
        `${String(index + 1).padStart(2, "0")}  ${name.padEnd(26)} ` +
        `${view.doors.padEnd(6)} pos ${view.pos.join(",")} yaw ${view.yaw} pitch ${view.pitch}`;
    };
    for (const [index, view] of views.entries()) {
      if (view.doors === "closed") {
        await capture(view.name, index);
      }
    }
    if (views.some((v) => v.doors === "open")) {
      if (auto) {
        const report = await openAllDoors(session);
        notOpened.push(...report.failed.map((f) => f.door));
        log(
          `doors open: ${report.open.length}/${report.open.length + report.failed.length}` +
            (report.failed.length > 0
              ? `; NOT opened: ${report.failed.map((f) => f.door).join(", ")}`
              : ""),
        );
      } else {
        await openDoors(pilot);
      }
      for (const [index, view] of views.entries()) {
        if (view.doors === "open") {
          await capture(view.name, index);
        }
      }
    }
    // Sheets: the hand-built tour keeps one running series; automatic tours
    // get one set of sheets per room, then the doors, then buttons/plates/exit.
    const groups = new Map<string, number[]>();
    for (const [index, view] of views.entries()) {
      const key = auto ? groupOf(view.name) : "";
      groups.set(key, [...(groups.get(key) ?? []), index]);
    }
    log(`view: ${debugView}   frames: ${views.length}   out: ${out}`);
    log("");
    for (const [key, indices] of groups) {
      const sheets = contactSheets(
        indices.map((i) => items[i]),
        { cols: 3, rows: 4 },
      );
      for (const [i, sheet] of sheets.entries()) {
        const suffix = key === "" ? "" : `-${key}`;
        const more = key === "" || sheets.length > 1 ? `-${i + 1}` : "";
        const path = join(out, `sheet${suffix}${more}.png`);
        await savePng(path, sheet.image);
        sheetPaths.push(path);
        log(
          `${path} (${sheet.image.width}x${sheet.image.height}), left to right, top to bottom:`,
        );
        for (const index of sheet.items) {
          log(`  ${lines[indices[index]]}`);
        }
      }
    }
    const errors = session.consoleLines.filter((line) =>
      /^(exception|error)/.test(line),
    );
    return {
      frames: views.length,
      sheets: sheetPaths,
      notOpened,
      errors,
    };
  }
}

function listViews(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".png") && !/^(sheet|diff)-/.test(f))
    .map((f) => f.slice(0, -4))
    .sort();
}

async function diffTours(
  dirA: string,
  dirB: string,
  out: string,
): Promise<void> {
  const namesA = new Set(listViews(dirA));
  const namesB = new Set(listViews(dirB));
  const order = VIEWS.map((v) => v.name).filter(
    (n) => namesA.has(n) && namesB.has(n),
  );
  const rest = [...namesA].filter((n) => namesB.has(n) && !order.includes(n));
  const names = [...order, ...rest];
  const rows: { name: string; percent: number; strip: Image | null }[] = [];
  for (const name of names) {
    const a = await readPng(join(dirA, `${name}.png`));
    const b = await readPng(join(dirB, `${name}.png`));
    if (a.width !== b.width || a.height !== b.height) {
      console.log(
        `${name}: size differs (${a.width}x${a.height} vs ${b.width}x${b.height}), skipped`,
      );
      continue;
    }
    const diff = diffImages(a, b);
    let strip: Image | null = null;
    if (diff.changedPixels > 0) {
      strip = hstack([a, b, diff.image], 2);
      drawLabel(
        strip,
        `${name}  ${diff.changedPercent.toFixed(2)}%  A | B | DIFF x8`,
        4,
        4,
        2,
      );
    }
    rows.push({ name, percent: diff.changedPercent, strip });
  }
  console.log(`A: ${dirA}\nB: ${dirB}\n`);
  console.log("changed%  view");
  for (const row of [...rows].sort((p, q) => q.percent - p.percent)) {
    console.log(`${row.percent.toFixed(3).padStart(8)}  ${row.name}`);
  }
  for (const name of namesA) {
    if (!namesB.has(name)) {
      console.log(`    only in A: ${name}`);
    }
  }
  for (const name of namesB) {
    if (!namesA.has(name)) {
      console.log(`    only in B: ${name}`);
    }
  }
  const changed = rows
    .filter((r) => r.strip)
    .sort((p, q) => q.percent - p.percent);
  const perSheet = 4;
  for (let i = 0; i * perSheet < changed.length; i++) {
    const strips = changed
      .slice(i * perSheet, (i + 1) * perSheet)
      .map((r) => r.strip!);
    const path = join(out, `diff-sheet-${i + 1}.png`);
    await savePng(path, vstack(strips, 2));
    console.log(`wrote ${path}`);
  }
  if (changed.length === 0) {
    console.log("no differences");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["diff", "auto"]);
  if (args.options.has("diff")) {
    const [a, b] = args.positional;
    if (!a || !b) {
      throw new Error("usage: bun run tour --diff <dirA> <dirB> [--out <dir>]");
    }
    await diffTours(a, b, args.options.get("out") ?? "out/tour-diff");
    return;
  }
  const debugView = (args.options.get("view") ?? "none") as DebugView;
  if (!DEBUG_VIEWS.includes(debugView)) {
    throw new Error(`--view must be one of ${DEBUG_VIEWS.join(", ")}`);
  }
  const sel = levelSelector(args);
  const auto = args.options.has("auto") || isSelected(sel);
  await tour(
    args.options.get("only"),
    debugView,
    args.options.get("out") ??
      (isSelected(sel) ? `out/tour/${levelTag(sel)}` : "out/tour"),
    sel,
    auto,
  );
}

if (import.meta.main)
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (error) => {
      console.error(
        "tour failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    },
  );
