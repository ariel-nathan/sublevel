/**
 * The room module contract as a reusable check: `contractProblems(module)`
 * builds a module in each of the four entry facings (or one), mirrored and
 * not, with its default parameters and some random ones, and returns
 * everything it breaks (empty if nothing). Used by the contract tests of the
 * shared registry (contract.test.ts), of the generator's own modules
 * (gen/modules/contract.test.ts) and of the puzzle rooms, for more random
 * parameter sets (puzzles/puzzles.test.ts). Pure: no browser.
 *
 * What is checked, per case:
 *   - the module declares itself consistently (difficulty, entry sizes);
 *   - everything it emits lies inside its footprint, its doorways on the
 *     footprint's boundary, with the parts its role needs;
 *   - doorways are reachable from the start, the exit only once the lock is
 *     open; walkable floor is in an acoustic zone (bar ZONE_REACH round a
 *     doorway);
 *   - props: none in a brush or in another prop, each resting on a brush or
 *     a prop;
 *   - its solution plays on paper (`verifySolution`), ends where the next
 *     module takes over, and its lock's ids and keys exist;
 *   - dynamic lights are bounded with the light 0.3 m inside its box;
 *   - ids are unique, also across two instances; building is deterministic.
 */
import type { Brush } from "../../core/api";
import { PLAYER } from "../../core/props";
import { createRng } from "../../core/rng";
import type { Vec3 } from "../../math";
import { buildRoom, outsideFootprint, type RoomParts } from "../assemble";
import {
  boxesOverlap,
  boxOf,
  BoxIndex,
  containsPoint,
  propBox,
  type Box,
} from "../geometry";
import { isSkirting, SKIRTING_COLLIDER_TOP } from "../index";
import {
  doorwayPoints,
  ZONE_REACH,
  type AnyRoomModule,
  type Connector,
  type RoomPlan,
} from "./room";
import { bodyBox, verifySolution } from "./solution";

export interface ContractOptions {
  /** Random parameter sets besides the defaults (default 4). */
  randomSets?: number;
  /** Seed of the first random set; the others follow (default 1). */
  seedBase?: number;
  /** "all": the four entry facings, mirrored and not; "mirror": one facing, both mirrorings. */
  orientations?: "all" | "mirror";
}

const FACINGS: Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
/** An arbitrary, off-grid place to build at. */
const ORIGIN = { x: 3.7, y: 0, z: -12.35 };
const CELL = 0.1;

interface Case {
  label: string;
  params: unknown;
  seed: number;
  at: Connector;
  mirror: boolean;
}

/** The defaults and `count` random sets, without duplicates. */
export function paramSets(
  module: AnyRoomModule,
  count = 4,
  seedBase = 1,
): unknown[] {
  const sets = [module.defaults];
  for (let i = 0; i < count; i++) {
    sets.push(module.random(createRng(seedBase + i)));
  }
  const seen = new Set<string>();
  return sets.filter((p) => {
    const key = JSON.stringify(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cases(module: AnyRoomModule, options: ContractOptions): Case[] {
  const out: Case[] = [];
  let n = 0;
  const facings = options.orientations === "mirror" ? [FACINGS[3]] : FACINGS;
  for (const params of paramSets(
    module,
    options.randomSets ?? 4,
    options.seedBase ?? 1,
  )) {
    for (const facing of facings) {
      for (const mirror of [false, true]) {
        // Alternate between the smallest and largest doorway it takes.
        const big = n++ % 2 === 1;
        const start = module.role === "start";
        const size = start
          ? { width: 0, height: 0 }
          : {
              width: module.entrySize.width[big ? 1 : 0],
              height: module.entrySize.height[big ? 1 : 0],
            };
        // A different rng seed per case: turned props, dressing.
        const seed = (options.seedBase ?? 1) * 7919 + n;
        out.push({
          label: `${JSON.stringify(params)} facing (${facing.x}, ${facing.z})${mirror ? " mirrored" : ""} ${size.width}x${size.height} seed ${seed}`,
          params,
          seed,
          at: {
            position: ORIGIN,
            facing,
            ...size,
            door: start ? undefined : "outside.door",
          },
          mirror,
        });
      }
    }
  }
  return out;
}

/** Brush colliders as the player meets them (skirting raised). */
export const colliders = (brushes: readonly Brush[]): Box[] =>
  brushes.map((b) => {
    const box = boxOf(b);
    return isSkirting(b) ? { ...box, y1: SKIRTING_COLLIDER_TOP } : box;
  });

const inRegion = (region: Box[], x: number, y: number, z: number): boolean =>
  region.some((r) => containsPoint(r, x, y, z));

/** Cells (centres) a standing player can reach from `start` inside `region`. */
function flood(start: Vec3, solids: Box[], region: Box[]): Vec3[] {
  const index = new BoxIndex(solids);
  const free = (x: number, z: number): boolean =>
    inRegion(region, x, start.y + 1, z) &&
    index.overlapping(bodyBox({ x, y: start.y, z })).length === 0;
  const key = (i: number, k: number) => `${i},${k}`;
  const seen = new Set<string>([key(0, 0)]);
  const out: Vec3[] = [];
  const queue: [number, number][] = [[0, 0]];
  while (queue.length > 0) {
    const [i, k] = queue.pop()!;
    out.push({ x: start.x + i * CELL, y: start.y, z: start.z + k * CELL });
    for (const [di, dk] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di;
      const nk = k + dk;
      if (seen.has(key(ni, nk))) continue;
      if (!free(start.x + ni * CELL, start.z + nk * CELL)) continue;
      seen.add(key(ni, nk));
      queue.push([ni, nk]);
    }
  }
  return out;
}

/** Reached cells in the doorway, within 0.15 m of its plane on this side. */
function atDoorway(cells: Vec3[], c: Connector, inward: 1 | -1): boolean {
  return cells.some((p) => {
    const along =
      ((p.x - c.position.x) * c.facing.x + (p.z - c.position.z) * c.facing.z) *
      inward;
    const across = Math.abs(
      (p.x - c.position.x) * -c.facing.z + (p.z - c.position.z) * c.facing.x,
    );
    return along > 0 && along <= 0.15 + 1e-9 && across <= c.width / 2 - 0.3;
  });
}

function startOf(plan: RoomPlan): Vec3 {
  if (plan.spawn) return plan.spawn.position;
  return doorwayPoints(plan.entry!.connector).after;
}

/** Props in a brush or in each other, or resting on nothing. */
export function propPlacementProblems(parts: RoomParts): string[] {
  const out: string[] = [];
  const brushes = parts.brushes.map(boxOf);
  const index = new BoxIndex(brushes);
  const boxes = parts.props.map(propBox);
  boxes.forEach((pb, i) => {
    const kind = parts.props[i].kind;
    if (index.overlapping(pb).some((n) => boxesOverlap(pb, brushes[n], 1e-3)))
      out.push(`prop ${i} (${kind}) is in a brush`);
    boxes.forEach((o, j) => {
      if (j > i && boxesOverlap(pb, o, 1e-3))
        out.push(`props ${i} and ${j} overlap`);
    });
    const c = parts.props[i].position;
    const rests = (b: Box) =>
      Math.abs(pb.y0 - b.y1) <= 0.01 &&
      c.x >= b.x0 &&
      c.x <= b.x1 &&
      c.z >= b.z0 &&
      c.z <= b.z1;
    if (!brushes.some(rests) && !boxes.some((o, j) => j !== i && rests(o)))
      out.push(`prop ${i} (${kind}) rests on nothing`);
  });
  return out;
}

function consistency(module: AnyRoomModule): string[] {
  const out: string[] = [];
  if (module.name.length === 0) out.push("no name");
  if (!(module.difficulty >= 0 && module.difficulty <= 3))
    out.push(`difficulty ${module.difficulty} is not 0..3`);
  const [w0, w1] = module.entrySize.width;
  const [h0, h1] = module.entrySize.height;
  if (w0 > w1 || h0 > h1) out.push("entry size ranges are reversed");
  if (module.role !== "start") {
    if (w0 < 2 * PLAYER.halfWidth + 0.3) out.push("entry too narrow");
    if (h0 < PLAYER.standHeight + 0.2) out.push("entry too low");
  }
  return out;
}

/** One case's problems. */
function caseProblems(module: AnyRoomModule, c: Case): string[] {
  const out: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) out.push(what);
  };
  const { plan, parts } = buildRoom(module, c.at, {
    params: c.params,
    mirror: c.mirror,
    prefix: "m.",
    seed: c.seed,
  });
  // Inside the footprint, doorways on its boundary, roles.
  out.push(...outsideFootprint(plan, parts));
  const region = plan.footprint.map(boxOf);
  const on = (conn: Connector, dir: 1 | -1) => {
    const p = conn.position;
    const f = conn.facing;
    const d = 0.01 * dir;
    return (
      !inRegion(region, p.x + f.x * d, 1, p.z + f.z * d) &&
      inRegion(region, p.x - f.x * d, 1, p.z - f.z * d)
    );
  };
  if (plan.entry) need(on(plan.entry.connector, -1), "entry off the boundary");
  plan.exits.forEach((e, i) => {
    need(on(e.connector, 1), `exit ${i} off the boundary`);
    const f = e.connector.facing;
    need(
      f.y === 0 && Math.abs(f.x) + Math.abs(f.z) === 1,
      `exit ${i} does not face along an axis`,
    );
  });
  if (module.role === "start") need(plan.spawn !== undefined, "no spawn");
  if (module.role === "finish") need(plan.exit !== undefined, "no exit box");
  else need(plan.exits.length > 0, "no exits");

  // Reachability, the lock, zones.
  const solids = colliders(parts.brushes);
  const start = startOf(plan);
  const open = flood(start, solids, region);
  const reachesExit = (cells: Vec3[]) =>
    plan.exit
      ? cells.some((p) => containsPoint(boxOf(plan.exit!), p.x, 0, p.z))
      : plan.exits.every((e) => atDoorway(cells, e.connector, -1));
  need(reachesExit(open), "the exit is not reachable with the lock open");
  if (plan.entry) {
    need(
      atDoorway(open, plan.entry.connector, 1),
      "the entry doorway is not reachable",
    );
  }
  if (plan.lock.kind !== "none" && plan.lock.doors.length > 0) {
    const slabs = parts.doors
      .filter((d) => plan.lock.doors.includes(d.id))
      .map((d) => boxOf(d.closed));
    need(
      slabs.length === plan.lock.doors.length,
      "the lock names doors it does not have",
    );
    const locked = flood(start, [...solids, ...slabs], region);
    need(!reachesExit(locked), "the exit is reachable with the lock shut");
  }
  const zones = parts.zones.map((z) => boxOf(z.box));
  const doorways = [
    ...(plan.entry ? [plan.entry.connector] : []),
    ...plan.exits.map((e) => e.connector),
  ];
  const nearDoorway = (p: Vec3) =>
    doorways.some(
      (d) =>
        Math.abs(
          (p.x - d.position.x) * d.facing.x + (p.z - d.position.z) * d.facing.z,
        ) <=
        ZONE_REACH + 1e-9,
    );
  const unzoned = open.filter(
    (p) =>
      !nearDoorway(p) &&
      !zones.some((z) => containsPoint(z, p.x, p.y + 0.9, p.z)),
  );
  for (const p of unzoned.slice(0, 3))
    out.push(
      `walkable floor at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) is in no zone`,
    );

  // Props.
  out.push(...propPlacementProblems(parts));

  // The solution.
  out.push(
    ...verifySolution(plan.solution, start, {
      solids,
      floors: parts.brushes.map(boxOf),
      props: parts.props,
      buttons: parts.buttons,
      plates: parts.plates.map((p) => boxOf(p.box)),
      within: plan.footprint.map(boxOf),
    }),
  );
  const walks = plan.solution.filter((s) => s.do === "walk");
  const last = walks[walks.length - 1];
  if (last?.do !== "walk") out.push("the solution has no walk");
  else if (plan.exit) {
    need(
      containsPoint(boxOf(plan.exit), last.to.x, 0, last.to.z),
      "the solution does not end in the exit box",
    );
  } else {
    const before = doorwayPoints(plan.exits[0].connector).before;
    need(
      Math.hypot(last.to.x - before.x, last.to.z - before.z) < 1e-6 &&
        Math.abs(last.to.y - before.y) < 1e-6,
      "the solution does not end just before the exit doorway",
    );
  }
  for (const id of plan.lock.doors)
    need(
      parts.doors.some((d) => d.id === id),
      `lock door ${id} does not exist`,
    );
  for (const id of plan.lock.buttons)
    need(
      parts.buttons.some((b) => b.id === id),
      `lock button ${id} does not exist`,
    );
  for (const id of plan.lock.plates)
    need(
      parts.plates.some((p) => p.id === id),
      `lock plate ${id} does not exist`,
    );
  for (const key of plan.lock.keys)
    need(parts.props[key.prop] !== undefined, `key prop ${key.prop} missing`);

  // Dynamic lights.
  parts.lights.forEach((l, i) => {
    if (l.flicker === "none") return;
    if (!l.bounds) {
      out.push(`dynamic light ${i} has no bounds`);
      return;
    }
    const b = boxOf(l.bounds);
    const p = l.position;
    const spare = Math.min(
      p.x - b.x0,
      b.x1 - p.x,
      p.y - b.y0,
      b.y1 - p.y,
      p.z - b.z0,
      b.z1 - p.z,
    );
    need(
      spare >= 0.3,
      `dynamic light ${i} is ${spare.toFixed(2)} m inside its bounds`,
    );
  });
  return out;
}

/** Ids unique (also across two instances) and building deterministic. */
function idsAndDeterminism(module: AnyRoomModule, all: Case[]): string[] {
  const out: string[] = [];
  const c = all[0];
  const ids = (prefix: string) => {
    const { parts } = buildRoom(module, c.at, { params: c.params, prefix });
    return [
      ...parts.doors.map((d) => d.id),
      ...parts.buttons.map((b) => b.id),
      ...parts.plates.map((p) => p.id),
    ];
  };
  const a = ids("a.");
  const b = ids("b.");
  if (new Set(a).size !== a.length) out.push("ids are not unique");
  if (a.some((id) => b.includes(id)))
    out.push("ids are shared by two instances");
  for (const p of new Set(all.map((x) => x.params))) {
    const once = buildRoom(module, c.at, { params: p, seed: 7, mirror: true });
    const again = buildRoom(module, c.at, { params: p, seed: 7, mirror: true });
    if (JSON.stringify(once) !== JSON.stringify(again))
      out.push(`building is not deterministic for ${JSON.stringify(p)}`);
  }
  return out;
}

/**
 * Everything `module` breaks of the contract, as "case: problem" lines
 * (empty if nothing).
 */
export function contractProblems(
  module: AnyRoomModule,
  options: ContractOptions = {},
): string[] {
  const all = cases(module, options);
  const out = consistency(module).map((p) => `${module.name}: ${p}`);
  for (const c of all) {
    for (const p of caseProblems(module, c)) out.push(`${c.label}: ${p}`);
  }
  out.push(...idsAndDeterminism(module, all));
  return out;
}
