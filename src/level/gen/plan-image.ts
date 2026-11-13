/**
 * `bun src/level/gen/plan-image.ts [seed...] [--rooms N] [--straight]`:
 * top-down plan of generated runs, without a browser, to
 * out/gen/plan-<seed>.png. Development only (imports tools/).
 *
 * Brushes grey by top height, footprints outlined by kind (start white,
 * corridors blue, adapters cyan, rooms orange, finish green), doorways as
 * green ticks, the declared solution as a magenta path, each piece labelled
 * with its placement name.
 */
import type { Vec3 } from "../../math";
import {
  createImage,
  drawLabel,
  fillRect,
  type Image,
  type Rgb,
} from "../../../tools/image";
import { writePng } from "../../../tools/png";
import { boxOf, type Box } from "../geometry";
import { DEFAULT_CONFIG, type GeneratorConfig } from "./config";
import { assembleRun } from "./index";
import type { PieceKind } from "./layout";

const PPM = 16;

const KIND: Record<PieceKind, Rgb> = {
  start: [255, 255, 255],
  corridor: [90, 140, 255],
  adapter: [60, 220, 220],
  room: [255, 160, 40],
  finish: [80, 230, 90],
};

export async function drawRun(
  seed: number,
  path: string,
  config: GeneratorConfig = DEFAULT_CONFIG,
): Promise<void> {
  const { run, assembled } = assembleRun(seed, config);
  const { data, rooms } = assembled;
  const all = rooms.flatMap((r) => r.plan.footprint.map(boxOf));
  const x0 = Math.min(...all.map((b) => b.x0)) - 2;
  const z0 = Math.min(...all.map((b) => b.z0)) - 2;
  const x1 = Math.max(...all.map((b) => b.x1)) + 2;
  const z1 = Math.max(...all.map((b) => b.z1)) + 2;
  const img: Image = createImage(
    Math.ceil((x1 - x0) * PPM),
    Math.ceil((z1 - z0) * PPM) + 24,
    [18, 18, 24],
  );
  const px = (x: number) => Math.round((x - x0) * PPM);
  const pz = (z: number) => Math.round((z - z0) * PPM) + 24;
  const fill = (b: Box, c: Rgb) =>
    fillRect(
      img,
      px(b.x0),
      pz(b.z0),
      px(b.x1) - px(b.x0),
      pz(b.z1) - pz(b.z0),
      c,
    );
  const outline = (b: Box, c: Rgb) => {
    fillRect(img, px(b.x0), pz(b.z0), px(b.x1) - px(b.x0) + 1, 1, c);
    fillRect(img, px(b.x0), pz(b.z1), px(b.x1) - px(b.x0) + 1, 1, c);
    fillRect(img, px(b.x0), pz(b.z0), 1, pz(b.z1) - pz(b.z0) + 1, c);
    fillRect(img, px(b.x1), pz(b.z0), 1, pz(b.z1) - pz(b.z0) + 1, c);
  };
  const sorted = [...data.brushes].sort((a, b) => a.max.y - b.max.y);
  for (const b of sorted) {
    const g = Math.max(40, Math.min(200, 60 + b.max.y * 35));
    fill(boxOf(b), [g, g, g]);
  }
  for (const d of data.doors) fill(boxOf(d.closed), [0, 200, 255]);
  for (const p of data.plates) fill(boxOf(p.box), [255, 0, 255]);
  const line = (a: Vec3, b: Vec3, c: Rgb) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * PPM) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      fillRect(
        img,
        px(a.x + (b.x - a.x) * t),
        pz(a.z + (b.z - a.z) * t),
        2,
        2,
        c,
      );
    }
  };
  let at = data.playerSpawn.position;
  for (const s of data.solution) {
    if (s.do === "walk") {
      line(at, s.to, [255, 60, 200]);
      at = s.to;
    }
  }
  run.pieces.forEach((piece, i) => {
    const room = rooms[i];
    for (const b of room.plan.footprint) outline(boxOf(b), KIND[piece.kind]);
    for (const e of room.plan.exits) {
      const c = e.connector;
      const r = { x: -c.facing.z, z: c.facing.x };
      const h = c.width / 2;
      line(
        { x: c.position.x - r.x * h, y: 0, z: c.position.z - r.z * h },
        { x: c.position.x + r.x * h, y: 0, z: c.position.z + r.z * h },
        [0, 255, 0],
      );
    }
  });
  run.pieces.forEach((piece, i) => {
    if (piece.kind === "corridor" || piece.kind === "adapter") return;
    const b = boxOf(rooms[i].plan.footprint[0]);
    drawLabel(img, piece.name, px(b.x0) + 3, pz(b.z0) + 3, 1);
  });
  drawLabel(
    img,
    `seed ${seed}: ${run.name}${run.fallback ? " (straight)" : ""}`,
    2,
    2,
    2,
  );
  await writePng(path, img.width, img.height, img.rgba);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rooms = args.includes("--rooms")
    ? Number(args[args.indexOf("--rooms") + 1])
    : DEFAULT_CONFIG.rooms;
  const config: GeneratorConfig = {
    ...DEFAULT_CONFIG,
    rooms,
    searchBudget: args.includes("--straight") ? 0 : DEFAULT_CONFIG.searchBudget,
  };
  const seeds = args
    .filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== "--rooms")
    .map(Number);
  for (const seed of seeds.length > 0 ? seeds : [1]) {
    const path = `out/gen/plan-${seed}${args.includes("--straight") ? "-straight" : ""}.png`;
    await drawRun(seed, path, config);
    console.log(`wrote ${path}`);
  }
}
