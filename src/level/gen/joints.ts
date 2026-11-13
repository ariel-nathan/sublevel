/**
 * `bun src/level/gen/joints.ts [seed...] [--out dir]`: the visual lint at
 * the joints of generated runs, in the real game. For every doorway where
 * two modules meet, cameras are pinned on both sides (looking through it
 * square on, and at each jamb from an angle) with every door closed, then
 * with every door opened; each view is checked for holes (coverage view)
 * and z-fighting (material view at jittered poses, as tools/lint-visual.ts
 * does). Writes contact sheets of the normal views, and annotated frames
 * of anything flagged, to out/joints/<seed>/. Exit 1 if anything is
 * flagged. Development only.
 */
import { join } from "node:path";
import type { LevelData } from "../../core/api";
import { MATERIAL_IDS } from "../../core/materials";
import { launchGame, type GameSession } from "../../../tools/browser";
import { contactSheets, type Image } from "../../../tools/image";
import {
  annotate,
  clusterMask,
  countMask,
  findShimmer,
  magentaMask,
  type Colour3,
} from "../../../tools/lint-core";
import { writePng } from "../../../tools/png";
import {
  grabFrame,
  setDebugView,
  setPose,
  type Pose,
} from "../../../tools/views";
import { materialDebugColor } from "../../render/layout";
import { SEE_THROUGH_MATERIALS } from "../meshgen";
import type { Connector } from "../rooms/room";
import { assembleRun } from "./index";

const CUTOUTS: Colour3[] = [...SEE_THROUGH_MATERIALS].map((id) =>
  materialDebugColor(MATERIAL_IDS.indexOf(id)),
);

interface JointView {
  name: string;
  pose: Pose;
}

const deg = (r: number) => (r * 180) / Math.PI;

/** Views on both sides of a doorway: square on, and at each jamb. */
function viewsAt(label: string, c: Connector): JointView[] {
  const out: JointView[] = [];
  const r = { x: -c.facing.z, z: c.facing.x };
  for (const side of [-1, 1] as const) {
    // On side -1 (the exit side) look along the facing; on +1 look back.
    const look = { x: c.facing.x * -side, z: c.facing.z * -side };
    const yaw0 = deg(Math.atan2(-look.x, -look.z));
    const at = (back: number, across: number) => ({
      x: c.position.x + c.facing.x * side * back + r.x * across,
      y: 1.55,
      z: c.position.z + c.facing.z * side * back + r.z * across,
    });
    const where = side < 0 ? "before" : "after";
    out.push({
      name: `${label}-${where}`,
      pose: { position: at(1.6, 0), yawDeg: yaw0, pitchDeg: -5 },
    });
    for (const s of [-1, 1]) {
      out.push({
        name: `${label}-${where}-${s < 0 ? "l" : "r"}`,
        pose: {
          position: at(1.1, -s * 0.45),
          yawDeg: yaw0 - side * s * 32,
          pitchDeg: 8,
        },
      });
    }
  }
  return out;
}

/** In-page: opens every door (presses buttons, hits targets, loads plates). */
const OPEN_ALL = `(() => {
  const g = window.__game;
  const d = g.level.data;
  for (const b of d.buttons) {
    if (b.mode === "impact") continue;
    g.world.use({ collider: { kind: "static", id: 0 }, point: b.position, normal: b.facing, distance: 1 });
  }
  const bodies = g.physics.bodies();
  const used = new Set();
  const take = (tag) => {
    const b = bodies.find((x) => x.tag === tag && !used.has(x.id));
    if (b) used.add(b.id);
    return b;
  };
  for (const b of d.buttons) {
    if (b.mode !== "impact") continue;
    const p = take("crate_wood_small") ?? take("chair") ?? take("monitor");
    const f = b.facing;
    g.physics.setBodyPose(p.id, { x: b.position.x + f.x * 0.5, y: b.position.y, z: b.position.z + f.z * 0.5 });
    g.physics.setBodyVelocity(p.id, { x: -f.x * 8, y: 0, z: -f.z * 8 });
  }
  for (const pl of d.plates) {
    const p = take("crate_metal") ?? take("crate_wood");
    const c = { x: (pl.box.min.x + pl.box.max.x) / 2, z: (pl.box.min.z + pl.box.max.z) / 2 };
    g.physics.setBodyPose(p.id, { x: c.x, y: 1.2, z: c.z });
  }
  __harness.step(110);
})()`;

async function lint(
  session: GameSession,
  view: JointView,
): Promise<{ normal: Image; holes: number; shimmer: number; flagged?: Image }> {
  const shot = async (
    debug: "none" | "material" | "depth" | "normals" | "coverage",
    dx = 0,
    dz = 0,
  ): Promise<Image> => {
    const p = view.pose.position;
    await setPose(session, {
      ...view.pose,
      position: { x: p.x + dx, y: p.y, z: p.z + dz },
    });
    await setDebugView(session, debug);
    return grabFrame(session);
  };
  const yaw = (view.pose.yawDeg * Math.PI) / 180;
  const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const base = await shot("material");
  const jittered: Image[] = [];
  for (const [v, mm] of [
    [right, 1],
    [fwd, 1],
    [right, 3],
    [fwd, 3],
    [right, -2],
  ] as const) {
    jittered.push(await shot("material", (v.x * mm) / 1000, (v.z * mm) / 1000));
  }
  const depth = await shot("depth");
  const normals = await shot("normals");
  const s = findShimmer({ base, jittered, depth, normals, cutouts: CUTOUTS });
  const coverage = await shot("coverage");
  const holesMask = magentaMask(coverage);
  const holes = countMask(holesMask);
  const normal = await shot("none");
  const shimmer = s.clusters.reduce((n, c) => n + c.pixels, 0);
  let flagged: Image | undefined;
  if (holes > 0) {
    flagged = annotate(
      normal,
      holesMask,
      clusterMask(holesMask, normal.width, normal.height, { gap: 1 }),
      [0, 255, 255],
    );
  } else if (shimmer > 0) {
    flagged = annotate(normal, s.flagged, s.clusters);
  }
  return { normal, holes, shimmer, flagged };
}

async function lintSeed(seed: number, outRoot: string): Promise<number> {
  const out = join(outRoot, String(seed));
  const { assembled } = assembleRun(seed);
  const views: JointView[] = [];
  assembled.rooms.forEach((room, i) => {
    const next = assembled.rooms[i + 1];
    room.plan.exits.forEach((e) => {
      views.push(...viewsAt(`${room.name}~${next?.name ?? "x"}`, e.connector));
    });
  });
  // The default window, as tools/lint-visual.ts uses: at a smaller one the
  // frames are rendered at a lower internal resolution, where the edges of
  // small fixtures a few centimetres proud of a wall (a button's knob and
  // bezel, seen from 1 m) move by a pixel with the 1-3 mm jitter and are
  // flagged, since such relief is too shallow to show in the depth and
  // normals views that explain edge aliasing.
  const session = await launchGame({ query: `harness&seed=${seed}` });
  let flaggedCount = 0;
  try {
    const name = await session.evaluate<string>("__game.level.data.name");
    const data = assembled.data as LevelData;
    if (name !== data.name)
      throw new Error(`the page built "${name}", not "${data.name}"`);
    await session.evaluate("__harness.step(1)");
    for (const doors of ["closed", "open"] as const) {
      if (doors === "open") await session.evaluate(OPEN_ALL);
      const items: { image: Image; label: string }[] = [];
      for (const view of views) {
        const r = await lint(session, view);
        items.push({ image: r.normal, label: `${view.name} ${doors}` });
        if (r.flagged) {
          flaggedCount++;
          console.log(
            `seed ${seed} ${view.name} (${doors}): holes ${r.holes} px, z-fighting ${r.shimmer} px`,
          );
          await writePng(
            join(out, `${view.name}-${doors}-flagged.png`),
            r.flagged.width,
            r.flagged.height,
            r.flagged.rgba,
          );
        }
      }
      const sheets = contactSheets(items, { cols: 6, rows: 6 });
      for (const [n, sheet] of sheets.entries()) {
        await writePng(
          join(out, `${doors}-sheet-${n + 1}.png`),
          sheet.image.width,
          sheet.image.height,
          sheet.image.rgba,
        );
      }
    }
    const errors = session.consoleLines.filter((l) =>
      /^(exception|error)/.test(l),
    );
    if (errors.length > 0) {
      console.log(`seed ${seed}: console errors: ${errors.join(" | ")}`);
      flaggedCount++;
    }
  } finally {
    await session.close();
  }
  console.log(
    `seed ${seed}: ${views.length} views x 2 door states, ${flaggedCount} flagged (${out})`,
  );
  return flaggedCount;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outRoot = args.includes("--out")
    ? args[args.indexOf("--out") + 1]
    : "out/joints";
  const seeds = args
    .filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== "--out")
    .map(Number);
  let flagged = 0;
  for (const seed of seeds.length > 0 ? seeds : [1])
    flagged += await lintSeed(seed, outRoot);
  process.exit(flagged > 0 ? 1 : 0);
}
