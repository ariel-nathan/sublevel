/**
 * `bun tools/map.ts [--seed N] [--rooms a,b] [--out file.png] [--scale px/m]`:
 * a top-down plan PNG of a whole level (the hand-built one without options),
 * built in-process (no browser): brushes at floor level, zones tinted, doors
 * (cyan), buttons (yellow, impact orange), plates (magenta), props (orange),
 * lights (pale dots), spawn (green), exit box (green outline) and the
 * declared solution as a numbered polyline (walk steps blue; c/p/t suffixes
 * mark carry, push and throw).
 *
 * Output: out/map/<tag>.png (tag: annex, seed-N, rooms-a-b).
 */
import { buildLevel } from "../src/level";
import { parseArgs } from "./cli";
import {
  levelOptions,
  levelSelector,
  levelTag,
  seedList,
  type LevelSelector,
} from "./level-args";
import { renderPlan } from "./plan-draw";
import { writePng } from "./png";

export async function writeMap(
  sel: LevelSelector,
  path: string,
  scale?: number,
): Promise<string> {
  const level = buildLevel(levelOptions(sel)).data;
  const image = renderPlan(level, {
    scale,
    title:
      levelTag(sel) === "annex" ? level.name : `${level.name} ${levelTag(sel)}`,
  });
  await writePng(path, image.width, image.height, image.rgba);
  return path;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const scale = args.options.get("scale");
  const seeds = seedList(args);
  const sels: LevelSelector[] = seeds
    ? seeds.map((seed) => ({ ...levelSelector(args), seed }))
    : [levelSelector(args)];
  for (const sel of sels) {
    const path =
      sels.length === 1 && args.options.has("out")
        ? args.options.get("out")!
        : `out/map/${levelTag(sel)}.png`;
    console.log(
      `wrote ${await writeMap(sel, path, scale ? Number(scale) : undefined)}`,
    );
  }
}
