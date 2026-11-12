/**
 * `bun tools/lint-visual.ts [--only <substring>] [--out <dir>]`
 *
 * Automatic visual defect detection from the tour viewpoints, in both door
 * states:
 *
 * - Shimmer / z-fighting: each view is rendered in the flat "material" view,
 *   then again with the camera moved 1 mm and 3 mm along its right vector and
 *   along its forward vector. A pixel whose material colour changes is
 *   "unstable". Unstable pixels explained by ordinary silhouette edge crawl
 *   are discarded; clusters of what remains are reported.
 * - Holes: in the "coverage" view any pure magenta pixel is a place with no
 *   geometry; the level is sealed, so there should be none.
 *
 * Writes annotated images to out/lint/ and exits non-zero if anything is
 * flagged. If the renderer has no diagnostic views (older build), says so
 * and falls back to comparing normal frames with a tolerance (no hole check).
 */
import { join } from "node:path";
import { launchGame } from "./browser";
import { parseArgs } from "./cli";
import type { Image } from "./image";
import {
  annotate,
  clusterMask,
  countMask,
  looksLikeCoverage,
  looksLikeMaterial,
  magentaMask,
  removeSilhouetteCrawl,
  silhouetteMask,
  unstableMask,
  type Cluster,
} from "./lint-core";
import { Pilot } from "./pilot";
import { writePng } from "./png";
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

/** Smallest cluster (pixels) worth reporting. */
const MIN_CLUSTER = 4;
/** In fallback mode (lit frames) only larger clusters count. */
const FALLBACK_MIN_CLUSTER = 150;
/** Camera moves in millimetres. */
const JITTER_MM = [1, 3];
/** Fallback thresholds on lit frames (per-channel, 0..255). */
const FALLBACK_UNSTABLE_TOLERANCE = 48;
const FALLBACK_SILHOUETTE_TOLERANCE = 40;

interface Row {
  view: string;
  doors: DoorState;
  shimmerClusters: Cluster[];
  shimmerPixels: number;
  holeClusters: Cluster[];
  holePixels: number;
}

async function save(path: string, image: Image): Promise<void> {
  await writePng(path, image.width, image.height, image.rgba);
}

const box = (c: Cluster): string =>
  `[${c.minX},${c.minY}..${c.maxX},${c.maxY}] ${c.pixels}px`;

async function main(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2));
  const out = args.options.get("out") ?? "out/lint";
  const views = selectViews(VIEWS, args.options.get("only"));
  if (views.length === 0) {
    throw new Error(`no viewpoint matches "${args.options.get("only")}"`);
  }
  const session = await launchGame();
  try {
    const pilot = new Pilot(session, { run: "lint", outDir: "out" });
    const first = views[0];

    // Are the diagnostic views real in this build?
    await setPose(session, poseOf(first));
    await setDebugView(session, "coverage");
    const coverageProbe = await grabFrame(session);
    await setDebugView(session, "material");
    const materialProbe = await grabFrame(session);
    await setDebugView(session, "none");
    const diagnostic =
      looksLikeCoverage(coverageProbe) && looksLikeMaterial(materialProbe);
    if (!diagnostic) {
      console.log(
        "NOTICE: debug views not available in this build (the coverage and\n" +
          "material views render the normal image). Falling back to comparing\n" +
          "normal frames with a tolerance; the hole check is skipped. Results are\n" +
          "approximate: re-run after the renderer's debug views are merged.\n",
      );
    }

    const rows: Row[] = [];
    const runState = async (doors: DoorState): Promise<void> => {
      for (const view of views) {
        rows.push(await lintView(view, doors));
      }
    };

    const lintView = async (
      view: Viewpoint,
      doors: DoorState,
    ): Promise<Row> => {
      const flat = diagnostic ? "material" : "none";
      const frame = async (offset?: {
        x: number;
        y: number;
        z: number;
      }): Promise<Image> => {
        await setPose(session, poseOf(view, offset));
        await setDebugView(session, flat);
        return grabFrame(session);
      };
      const base = await frame();
      const jittered: Image[] = [];
      for (const mm of JITTER_MM) {
        const { right, forward } = jitterOffsets(view, mm);
        jittered.push(await frame(right));
        jittered.push(await frame(forward));
      }
      const tolerance = diagnostic ? 0 : FALLBACK_UNSTABLE_TOLERANCE;
      const unstable = unstableMask(base, jittered, tolerance);
      const silhouette = silhouetteMask(
        base,
        diagnostic ? 0 : FALLBACK_SILHOUETTE_TOLERANCE,
      );
      const remaining = removeSilhouetteCrawl(
        unstable,
        silhouette,
        base.width,
        base.height,
      );
      const shimmerClusters = clusterMask(remaining, base.width, base.height, {
        minSize: diagnostic ? MIN_CLUSTER : FALLBACK_MIN_CLUSTER,
        gap: 1,
      });
      const shimmerPixels = shimmerClusters.reduce((n, c) => n + c.pixels, 0);

      let holeClusters: Cluster[] = [];
      let holePixels = 0;
      let holes: Uint8Array = new Uint8Array(base.width * base.height);
      if (diagnostic) {
        await setPose(session, poseOf(view));
        await setDebugView(session, "coverage");
        const coverage = await grabFrame(session);
        holes = magentaMask(coverage);
        holePixels = countMask(holes);
        holeClusters = clusterMask(holes, base.width, base.height, { gap: 1 });
      }

      const tag = `${view.name}@${doors}`;
      if (shimmerClusters.length > 0 || holePixels > 0) {
        await setPose(session, poseOf(view));
        await setDebugView(session, "none");
        const normal = await grabFrame(session);
        if (shimmerClusters.length > 0) {
          const mask = new Uint8Array(remaining);
          await save(
            join(out, `${view.name}-${doors}-shimmer.png`),
            annotate(normal, mask, shimmerClusters),
          );
        }
        if (holePixels > 0) {
          await save(
            join(out, `${view.name}-${doors}-holes.png`),
            annotate(normal, holes, holeClusters, [0, 255, 255]),
          );
        }
      }
      await setDebugView(session, "none");
      void tag;
      return {
        view: view.name,
        doors,
        shimmerClusters,
        shimmerPixels,
        holeClusters,
        holePixels,
      };
    };

    await runState("closed");
    await openDoors(pilot);
    await runState("open");

    // Summary.
    const w = Math.max(...rows.map((r) => r.view.length), 4);
    console.log(`${"view".padEnd(w)}  doors   shimmer clusters  px   hole px`);
    for (const r of rows) {
      const flagged = r.shimmerClusters.length > 0 || r.holePixels > 0;
      console.log(
        `${r.view.padEnd(w)}  ${r.doors.padEnd(6)}  ${String(r.shimmerClusters.length).padStart(8)}  ${String(r.shimmerPixels).padStart(6)}  ${String(r.holePixels).padStart(6)}${flagged ? "   <-- FLAGGED" : ""}`,
      );
    }
    const flagged = rows.filter(
      (r) => r.shimmerClusters.length > 0 || r.holePixels > 0,
    );
    if (flagged.length > 0) {
      console.log(
        "\nDetails (bounding boxes in frame pixels, x,y from the top-left):",
      );
      for (const r of flagged) {
        if (r.shimmerClusters.length > 0) {
          console.log(
            `  ${r.view} (${r.doors}) shimmer: ${r.shimmerClusters.slice(0, 6).map(box).join("; ")}${r.shimmerClusters.length > 6 ? "; ..." : ""}`,
          );
        }
        if (r.holePixels > 0) {
          console.log(
            `  ${r.view} (${r.doors}) holes: ${r.holeClusters.slice(0, 6).map(box).join("; ")}`,
          );
        }
      }
    }
    console.log(
      `\n${flagged.length === 0 ? "PASS" : "FAIL"}: ${rows.length} view-states checked, ${flagged.length} flagged.` +
        `${diagnostic ? "" : " (fallback mode: approximate, no hole check)"}` +
        `${flagged.length > 0 ? ` Annotated images in ${out}/` : ""}`,
    );
    return flagged.length === 0;
  } finally {
    await session.close();
  }
}

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
