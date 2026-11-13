/**
 * `bun tools/room-plan.ts [name] [--mirror] [--facing +x|-x|+z|-z] [--seed N]`:
 * draws a top-down plan of one room module from the registry (default: all
 * of them), or of a whole level ("annex": Kestrel Annex), to
 * out/room-plan/<name>.png, without a browser. Use it to look at a module
 * while writing it.
 *
 * Brushes are grey by top height (dark floor, light walls), props orange,
 * buttons yellow, doors cyan, plates magenta; the footprint is outlined in
 * red, doorways are green ticks on the plane, and the declared solution is
 * the blue path (props it moves: blue lines from where they start).
 */
import type { LevelData, SolutionStep } from "../src/core/api";
import type { Vec3 } from "../src/math";
import { buildRoom } from "../src/level/assemble";
import { assembleKestrelAnnex } from "../src/level/define";
import { boxOf, propBox, type Box } from "../src/level/geometry";
import { ROOM_MODULES } from "../src/level/rooms/registry";
import { doorwayPoints, type AnyRoomModule } from "../src/level/rooms/room";
import { createRng } from "../src/core/rng";
import { writePng } from "./png";

const PPM = 30;
type Rgb = [number, number, number];

interface Sheet {
  brushes: LevelData["brushes"];
  props: LevelData["props"];
  buttons: LevelData["buttons"];
  doors: LevelData["doors"];
  plates: LevelData["plates"];
  footprint: Box[];
  doorways: { position: Vec3; facing: Vec3; width: number }[];
  start: Vec3;
  solution: SolutionStep[];
}

function draw(sheet: Sheet, path: string): Promise<void> {
  const all = [...sheet.brushes.map(boxOf), ...sheet.footprint];
  const x0 = Math.min(...all.map((b) => b.x0)) - 1;
  const z0 = Math.min(...all.map((b) => b.z0)) - 1;
  const x1 = Math.max(...all.map((b) => b.x1)) + 1;
  const z1 = Math.max(...all.map((b) => b.z1)) + 1;
  const w = Math.ceil((x1 - x0) * PPM);
  const h = Math.ceil((z1 - z0) * PPM);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([20, 20, 28, 255], i * 4);
  const px = (x: number) => Math.round((x - x0) * PPM);
  const pz = (z: number) => Math.round((z - z0) * PPM);
  const put = (x: number, y: number, c: Rgb) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    rgba.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  };
  const fill = (b: Box, c: Rgb) => {
    for (let y = pz(b.z0); y < pz(b.z1); y++) {
      for (let x = px(b.x0); x < px(b.x1); x++) put(x, y, c);
    }
  };
  const outline = (b: Box, c: Rgb) => {
    for (let x = px(b.x0); x <= px(b.x1); x++) {
      put(x, pz(b.z0), c);
      put(x, pz(b.z1), c);
    }
    for (let y = pz(b.z0); y <= pz(b.z1); y++) {
      put(px(b.x0), y, c);
      put(px(b.x1), y, c);
    }
  };
  const line = (
    a: { x: number; z: number },
    b: { x: number; z: number },
    c: Rgb,
  ) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * PPM));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      put(px(a.x + (b.x - a.x) * t), pz(a.z + (b.z - a.z) * t), c);
    }
  };
  // Brushes, lowest top first so walls draw over floors.
  const sorted = sheet.brushes.map(boxOf).sort((a, b) => a.y1 - b.y1);
  for (const b of sorted) {
    if (b.y0 > 2.2) continue; // ceilings and what hangs from them
    const g = Math.round(60 + Math.max(0, Math.min(1, b.y1 / 2.2)) * 140);
    fill(b, [g, g, g]);
  }
  for (const p of sheet.plates) fill(boxOf(p.box), [200, 60, 200]);
  for (const d of sheet.doors) fill(boxOf(d.closed), [60, 200, 220]);
  for (const p of sheet.props) fill(propBox(p), [230, 140, 40]);
  for (const b of sheet.buttons) {
    fill(
      {
        x0: b.position.x - 0.1,
        x1: b.position.x + 0.1,
        y0: 0,
        y1: 0,
        z0: b.position.z - 0.1,
        z1: b.position.z + 0.1,
      },
      [250, 230, 40],
    );
  }
  for (const f of sheet.footprint) outline(f, [230, 50, 50]);
  for (const d of sheet.doorways) {
    const r = { x: -d.facing.z, z: d.facing.x };
    const a = {
      x: d.position.x - (r.x * d.width) / 2,
      z: d.position.z - (r.z * d.width) / 2,
    };
    const b = {
      x: d.position.x + (r.x * d.width) / 2,
      z: d.position.z + (r.z * d.width) / 2,
    };
    line(a, b, [60, 230, 60]);
    line(
      d.position,
      {
        x: d.position.x + d.facing.x * 0.5,
        z: d.position.z + d.facing.z * 0.5,
      },
      [60, 230, 60],
    );
  }
  let at = sheet.start;
  const props = sheet.props.map((p) => ({ ...p.position }));
  for (const s of sheet.solution) {
    if (s.do === "walk" || s.do === "climb") {
      line(at, s.to, [80, 140, 255]);
      at = s.to;
    } else if (s.do === "carry" || s.do === "push") {
      line(props[s.prop], s.to, [120, 200, 255]);
      props[s.prop] = s.to;
    } else if (s.do === "throw") {
      line(at, s.at, [120, 200, 255]);
    }
  }
  return writePng(path, w, h, rgba);
}

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--") && !/^[-+]?[\dxz]/.test(a));
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const facing = (() => {
  const f = valueOf("--facing") ?? "+x";
  const s = f.startsWith("-") ? -1 : 1;
  return f.endsWith("z") ? { x: 0, y: 0, z: s } : { x: s, y: 0, z: 0 };
})();
const seed = Number(valueOf("--seed") ?? 0);

if (name === "annex") {
  const { data, rooms } = assembleKestrelAnnex();
  await draw(
    {
      ...data,
      footprint: rooms.flatMap((r) => r.plan.footprint.map(boxOf)),
      doorways: rooms.flatMap((r) => r.plan.exits.map((e) => e.connector)),
      start: data.playerSpawn.position,
    },
    "out/room-plan/annex.png",
  );
  console.log("wrote out/room-plan/annex.png");
} else {
  const modules = ROOM_MODULES.filter((m) => !name || m.name === name);
  if (modules.length === 0) {
    console.error(
      `no module "${name}"; known: ${ROOM_MODULES.map((m) => m.name).join(", ")}, annex`,
    );
    process.exit(1);
  }
  for (const module of modules as AnyRoomModule[]) {
    const at = {
      position: { x: 0, y: 0, z: 0 },
      facing,
      width: module.entrySize.width[0],
      height: module.entrySize.height[0],
      door: "outside.door",
    };
    const params = seed ? module.random(createRng(seed)) : module.defaults;
    const { plan, parts } = buildRoom(module, at, {
      params,
      seed,
      mirror: args.includes("--mirror"),
      prefix: `${module.name}.`,
    });
    const path = `out/room-plan/${module.name}.png`;
    await draw(
      {
        ...parts,
        footprint: plan.footprint.map(boxOf),
        doorways: [
          ...(plan.entry ? [plan.entry.connector] : []),
          ...plan.exits.map((e) => e.connector),
        ],
        start: plan.spawn?.position ?? doorwayPoints(at).after,
        solution: plan.solution,
      },
      path,
    );
    console.log(`wrote ${path} (${JSON.stringify(params)})`);
  }
}
