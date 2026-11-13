/**
 * `bun tools/lint-visual.ts [--only <substring>] [--out <dir>] [--self-test]`
 * `bun tools/lint-visual.ts --seed N | --rooms a,b | --auto [...]`
 *
 * Without --seed/--rooms/--auto the fixed viewpoints of the hand-built level
 * (views.ts) are used; with any of them the viewpoints are derived from the
 * level (auto-views.ts) and every door is opened by openAllDoors (doors.ts)
 * for the "open" state. Output then goes to out/lint/<tag>/.
 *
 * Automatic visual defect detection from the tour viewpoints, in both door
 * states. Exit code 0 when nothing is flagged, 1 otherwise, 2 on a tool error.
 *
 * - Holes: in the "coverage" view any pure magenta pixel is a place with no
 *   geometry; the level is sealed, so there should be none.
 * - Z-fighting: each view is rendered in the flat "material" view at the base
 *   pose and at five poses moved by a few millimetres; pixels whose material
 *   changes are "unstable". Edge aliasing explains most of them, so the
 *   "depth" and "normals" views of the base pose are used to discard
 *   everything within a couple of pixels of a depth edge, a normal edge, a
 *   stable material boundary or a cut-out surface, and what is left must be a
 *   solid area (at least 3 pixels thick) to count. See findShimmer in
 *   lint-core.ts.
 * - `--self-test` (positive control): injects a quad exactly coplanar with a
 *   wall but in another material into the running game, requires the check to
 *   flag it on a view facing that wall, then removes it.
 *
 * Annotated images go to out/lint/ for flagged view-states only.
 */
import { join } from "node:path";
import type { LevelData } from "../src/core/api";
import { autoViews } from "./auto-views";
import { launchGame, type GameSession } from "./browser";
import { openAllDoors } from "./doors";
import { isSelected, levelQuery, levelSelector, levelTag } from "./level-args";
import { parseArgs } from "./cli";
import type { Image } from "./image";
import {
  annotate,
  clusterMask,
  countMask,
  findShimmer,
  looksLikeCoverage,
  looksLikeMaterial,
  magentaMask,
  type Cluster,
  type Colour3,
} from "./lint-core";
import { Pilot } from "./pilot";
import { writePng } from "./png";
import { MATERIAL_IDS } from "../src/core/materials";
import { materialDebugColor } from "../src/render/layout";
import { SEE_THROUGH_MATERIALS } from "../src/level/meshgen";
import {
  VIEWS,
  grabFrame,
  jitterOffsets,
  openDoors,
  poseOf,
  selectViews,
  setDebugView,
  setPose,
  type DoorState,
  type Viewpoint,
} from "./views";
import { injectCoplanarQuad, removeInjected } from "./lint-selftest";

/** Camera moves (mm along the right / forward vector; negative = left / back). */
const JITTERS: readonly { axis: "right" | "forward"; mm: number }[] = [
  { axis: "right", mm: 1 },
  { axis: "forward", mm: 1 },
  { axis: "right", mm: 3 },
  { axis: "forward", mm: 3 },
  { axis: "right", mm: -2 },
];

/** Debug colours of the alpha cut-out materials (pure edge aliasing). */
const CUTOUT_COLOURS: Colour3[] = [...SEE_THROUGH_MATERIALS].map((id) =>
  materialDebugColor(MATERIAL_IDS.indexOf(id)),
);

export interface ViewResult {
  view: string;
  doors: DoorState;
  shimmerClusters: Cluster[];
  shimmerPixels: number;
  /** Pixels that changed in any jittered frame, before any rule. */
  unstablePixels: number;
  /** Unstable pixels that were explained as edge aliasing. */
  explainedPixels: number;
  holeClusters: Cluster[];
  holePixels: number;
  /** Annotation inputs (only kept for flagged views). */
  flagged: Uint8Array;
  holes: Uint8Array;
}

async function save(path: string, image: Image): Promise<void> {
  await writePng(path, image.width, image.height, image.rgba);
}

const box = (c: Cluster): string =>
  `[${c.minX},${c.minY}..${c.maxX},${c.maxY}] ${c.pixels}px`;

/** Renders and analyses one viewpoint in the game's current state. */
async function lintView(
  session: GameSession,
  view: Viewpoint,
  doors: DoorState,
): Promise<ViewResult> {
  const shot = async (
    debugView: "material" | "depth" | "normals" | "coverage",
    offset?: { x: number; y: number; z: number },
  ): Promise<Image> => {
    await setPose(session, poseOf(view, offset));
    await setDebugView(session, debugView);
    return grabFrame(session);
  };
  const base = await shot("material");
  const jittered: Image[] = [];
  for (const { axis, mm } of JITTERS) {
    jittered.push(await shot("material", jitterOffsets(view, mm)[axis]));
  }
  const depth = await shot("depth");
  const normals = await shot("normals");
  const shimmer = findShimmer({
    base,
    jittered,
    depth,
    normals,
    cutouts: CUTOUT_COLOURS,
  });
  const coverage = await shot("coverage");
  const holes = magentaMask(coverage);
  const holePixels = countMask(holes);
  await setDebugView(session, "none");
  const unstablePixels = countMask(shimmer.unstable);
  return {
    view: view.name,
    doors,
    unstablePixels,
    explainedPixels: unstablePixels - countMask(shimmer.flagged),
    shimmerClusters: shimmer.clusters,
    shimmerPixels: shimmer.clusters.reduce((n, c) => n + c.pixels, 0),
    holeClusters: clusterMask(holes, base.width, base.height, { gap: 1 }),
    holePixels,
    flagged: shimmer.flagged,
    holes,
  };
}

async function writeAnnotations(
  session: GameSession,
  view: Viewpoint,
  result: ViewResult,
  out: string,
): Promise<void> {
  await setPose(session, poseOf(view));
  await setDebugView(session, "none");
  const normal = await grabFrame(session);
  if (result.shimmerClusters.length > 0) {
    await save(
      join(out, `${view.name}-${result.doors}-shimmer.png`),
      annotate(normal, result.flagged, result.shimmerClusters),
    );
  }
  if (result.holePixels > 0) {
    await save(
      join(out, `${view.name}-${result.doors}-holes.png`),
      annotate(normal, result.holes, result.holeClusters, [0, 255, 255]),
    );
  }
}

const isFlagged = (r: ViewResult): boolean =>
  r.shimmerClusters.length > 0 || r.holePixels > 0;

/**
 * Positive control. Returns a human-readable line and whether the injected
 * z-fighting was found (and the clean view was clean).
 */
async function selfTest(
  session: GameSession,
  out: string,
): Promise<{ ok: boolean; line: string }> {
  const view = VIEWS.find((v) => v.name === "lab-spawn") ?? VIEWS[0];
  const before = await lintView(session, view, "closed");
  // A quad that is exactly coplanar always wins the depth test (later draw),
  // and one more than a depth quantum behind loses it; in between, the
  // winner flips with the camera's sub-millimetre position. Try offsets
  // across that range; an offset is "fighting" if the raw material view
  // visibly flips over a large area, and the lint must flag every one.
  const OFFSETS_MM = [0.01, 0.02, 0.035, 0.05, 0.08];
  const lines: string[] = [];
  let fighting = 0;
  let caught = 0;
  let wall = "";
  for (const mm of OFFSETS_MM) {
    const injected = await injectCoplanarQuad(session, view, mm / 1000);
    wall = `${injected.material} quad on ${injected.wall} (${injected.plane})`;
    try {
      const after = await lintView(session, view, "closed");
      const extra = after.unstablePixels - before.unstablePixels;
      const isFighting = extra >= 500;
      const isCaught = after.shimmerPixels >= 500;
      if (isFighting) {
        fighting++;
        caught += isCaught ? 1 : 0;
        if (isCaught) {
          await writeAnnotations(
            session,
            view,
            { ...after, holePixels: 0 },
            join(out, `selftest-${mm}mm`),
          );
        }
      }
      lines.push(
        `${mm} mm behind: +${extra} unstable px, flagged ${after.shimmerPixels}px` +
          `${isFighting ? (isCaught ? " (fighting, caught)" : " (fighting, MISSED)") : " (not fighting)"}`,
      );
    } finally {
      await removeInjected(session);
    }
  }
  const ok = before.shimmerPixels === 0 && fighting > 0 && caught === fighting;
  return {
    ok,
    line:
      `self-test on ${view.name}: ${wall}\n  ` +
      lines.join("\n  ") +
      `\n  -> ${caught}/${fighting} fighting variants detected, clean view flagged ${before.shimmerPixels}px: ${ok ? "DETECTED" : "NOT DETECTED"}`,
  };
}

/** Throws unless the renderer's coverage and material debug views are real. */
export async function probeDebugViews(
  session: GameSession,
  view: Viewpoint,
): Promise<void> {
  await setPose(session, poseOf(view));
  await setDebugView(session, "coverage");
  const coverageProbe = await grabFrame(session);
  await setDebugView(session, "material");
  const materialProbe = await grabFrame(session);
  await setDebugView(session, "none");
  if (!looksLikeCoverage(coverageProbe) || !looksLikeMaterial(materialProbe)) {
    throw new Error(
      "the renderer's coverage/material debug views are not available in this build",
    );
  }
}

export interface LintRun {
  rows: ViewResult[];
  flagged: ViewResult[];
  holeStates: number;
  shimmerStates: number;
}

/**
 * Lints every view with doors closed, then `openDoors` is called and every
 * view is linted again. Annotated images of flagged view-states go to `out`.
 */
export async function lintViews(
  session: GameSession,
  views: readonly Viewpoint[],
  out: string,
  openDoorsFn: () => Promise<void>,
): Promise<LintRun> {
  const rows: ViewResult[] = [];
  const runState = async (doors: DoorState): Promise<void> => {
    for (const view of views) {
      const result = await lintView(session, view, doors);
      if (isFlagged(result)) {
        await writeAnnotations(session, view, result, out);
      }
      rows.push(result);
    }
  };
  await runState("closed");
  await openDoorsFn();
  await runState("open");
  const flagged = rows.filter(isFlagged);
  return {
    rows,
    flagged,
    holeStates: rows.filter((r) => r.holePixels > 0).length,
    shimmerStates: rows.filter((r) => r.shimmerClusters.length > 0).length,
  };
}

/** Table of one line per view, then the clusters of anything flagged. */
export function printLint(views: readonly Viewpoint[], run: LintRun): void {
  const { rows, flagged } = run;
  const w = Math.max(...views.map((v) => v.name.length), 4);
  const cell = (r: ViewResult | undefined): string => {
    if (!r) {
      return "-";
    }
    return isFlagged(r)
      ? `FLAG shimmer ${r.shimmerPixels}px holes ${r.holePixels}px`
      : `ok (${r.explainedPixels} edge px)`;
  };
  console.log(`${"view".padEnd(w)}  ${"closed".padEnd(26)}  open`);
  for (const view of views) {
    const closed = rows.find(
      (r) => r.view === view.name && r.doors === "closed",
    );
    const open = rows.find((r) => r.view === view.name && r.doors === "open");
    console.log(
      `${view.name.padEnd(w)}  ${cell(closed).padEnd(26)}  ${cell(open)}`,
    );
  }
  for (const r of flagged) {
    if (r.shimmerClusters.length > 0) {
      console.log(
        `  ${r.view} (${r.doors}) shimmer: ${r.shimmerClusters.slice(0, 6).map(box).join("; ")}`,
      );
    }
    if (r.holePixels > 0) {
      console.log(
        `  ${r.view} (${r.doors}) holes: ${r.holeClusters.slice(0, 6).map(box).join("; ")}`,
      );
    }
  }
}

async function main(): Promise<boolean> {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2), ["self-test", "auto"]);
  const sel = levelSelector(args);
  const auto = args.options.has("auto") || isSelected(sel);
  const out =
    args.options.get("out") ??
    (isSelected(sel) ? `out/lint/${levelTag(sel)}` : "out/lint");
  const session = await launchGame({ query: levelQuery(sel) });
  try {
    const pilot = new Pilot(session, { run: "lint", outDir: "out" });
    let all: readonly Viewpoint[] = VIEWS;
    if (auto) {
      const level = await session.evaluate<LevelData>("__game.level.data");
      all = autoViews(level);
      console.log(`automatic viewpoints: ${all.length} for "${level.name}"`);
    }
    const views = selectViews(all, args.options.get("only"));
    if (views.length === 0) {
      throw new Error(`no viewpoint matches "${args.options.get("only")}"`);
    }

    // The debug views must be real in this build.
    await probeDebugViews(session, views[0]);

    let selfTestResult: { ok: boolean; line: string } | null = null;
    if (args.options.has("self-test")) {
      selfTestResult = await selfTest(session, out);
    }

    const run = await lintViews(session, views, out, async () => {
      if (auto) {
        const report = await openAllDoors(session);
        if (report.failed.length > 0) {
          console.log(
            `warning: doors not opened: ${report.failed.map((f) => f.door).join(", ")}`,
          );
        }
      } else {
        await openDoors(pilot);
      }
    });
    printLint(views, run);
    if (selfTestResult) {
      console.log(`\n${selfTestResult.line}`);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const passed = run.flagged.length === 0 && (selfTestResult?.ok ?? true);
    console.log(
      `\n${passed ? "PASS" : "FAIL"}: ${run.rows.length} view-states checked: ` +
        `${run.holeStates} with holes, ${run.shimmerStates} with shimmer` +
        `${selfTestResult ? `, self-test ${selfTestResult.ok ? "ok" : "FAILED"}` : ""} ` +
        `(${seconds} s)` +
        `${run.flagged.length > 0 ? `. Annotated images in ${out}/` : ""}`,
    );
    return passed;
  } finally {
    await session.close();
  }
}

if (import.meta.main) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error(
        "lint-visual failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(2);
    },
  );
}
