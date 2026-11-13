/**
 * Level-wide checks of a generated run, beyond what the assembler checks.
 * Each returns a list of problems (empty if none), so tests can print them
 * and tools can report them. Pure, no browser.
 */
import type { BuiltLevel, LevelData } from "../../core/api";
import { PLAYER } from "../../core/props";
import type { Vec3 } from "../../math";
import { AirGrid } from "../airgrid";
import { jointProblem, type AssembledLevel } from "../assemble";
import {
  boxRects,
  coplanarOverlaps,
  describeOverlap,
  levelRects,
  type FaceRect,
} from "../coplanar";
import {
  boxesOverlap,
  boxOf,
  BoxIndex,
  containsPoint,
  propBox,
  segmentHitsBox,
  type Box,
} from "../geometry";
import { isSkirting, levelAir, SKIRTING_COLLIDER_TOP } from "../index";
import { faceCells } from "../meshgen";
import { TriangleGrid } from "../raymesh";
import { ZONE_REACH, type Connector } from "../rooms/room";
import { verifySolution } from "../rooms/solution";
import type { GeneratorConfig } from "./config";
import type { RunPlan } from "./index";
import { eligibleModules } from "./index";
import { missionProblems } from "./mission";

const fmt = (v: number) => v.toFixed(2);
const fmtP = (p: { x: number; y?: number; z: number }) =>
  `(${fmt(p.x)}, ${p.y === undefined ? "" : `${fmt(p.y)}, `}${fmt(p.z)})`;

/** Solid boxes as the player meets them (skirting raised). */
export function colliderBoxes(data: LevelData): Box[] {
  return data.brushes.map((b) => {
    const box = boxOf(b);
    return isSkirting(b) ? { ...box, y1: SKIRTING_COLLIDER_TOP } : box;
  });
}

/** Every doorway between two placed modules (exit connectors). */
export function doorways(assembled: AssembledLevel): Connector[] {
  return assembled.rooms.flatMap((r) => r.plan.exits.map((e) => e.connector));
}

/**
 * The chain: length, mission rules, footprints (no overlap, `clearance`
 * between non-neighbours), every doorway joined.
 */
export function chainProblems(
  run: RunPlan,
  assembled: AssembledLevel,
  config: GeneratorConfig,
): string[] {
  const out: string[] = [];
  const pool = eligibleModules(config);
  out.push(
    ...missionProblems(run.mission, pool, config.rooms, config.maxPerMechanic),
  );
  // (Rule 5, the ramp, gives way to rule 6 when one module must repeat:
  // `ramps` is checked on the real pool by the tests, not here.)
  const rooms = assembled.rooms;
  const puzzles = run.pieces.filter((p) => p.kind === "room").length;
  if (puzzles !== config.rooms) out.push(`${puzzles} rooms placed`);
  if (rooms[0].module !== config.start)
    out.push("does not start with the start module");
  if (rooms[rooms.length - 1].module !== config.finish)
    out.push("does not end with the finish");
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      for (const a of rooms[i].plan.footprint.map(boxOf)) {
        for (const b of rooms[j].plan.footprint.map(boxOf)) {
          if (boxesOverlap(a, b, 1e-6)) {
            out.push(
              `footprints of ${rooms[i].name} and ${rooms[j].name} overlap`,
            );
          }
          const gap = config.clearance - 1e-3;
          const near =
            a.x0 < b.x1 + gap &&
            a.x1 > b.x0 - gap &&
            a.z0 < b.z1 + gap &&
            a.z1 > b.z0 - gap;
          if (j > i + 1 && near) {
            out.push(
              `${rooms[i].name} and ${rooms[j].name} are closer than ${config.clearance} m`,
            );
          }
        }
      }
    }
    if (i > 0) {
      const exit = rooms[i - 1].plan.exits[0];
      const entry = rooms[i].plan.entry;
      const problem = entry ? jointProblem(exit, entry) : "no entry";
      if (problem)
        out.push(`${rooms[i - 1].name} -> ${rooms[i].name}: ${problem}`);
    }
  }
  return out;
}

/** Sealed: no air leak with doors open or closed, rays from the spawn hit brushes. */
export function sealProblems(data: LevelData, rays = 1500): string[] {
  const out: string[] = [];
  const brushes = data.brushes.map(boxOf);
  const doors = data.doors.map((d) => boxOf(d.closed));
  const p = data.playerSpawn.position;
  const seed = { x: p.x, y: 1, z: p.z };
  if (new AirGrid(brushes, seed).leaks) out.push("air leaks with doors open");
  if (new AirGrid([...brushes, ...doors], seed).leaks)
    out.push("air leaks with doors closed");
  const index = new BoxIndex(brushes);
  void index;
  for (let i = 0; i < rays; i++) {
    const y = 1 - (2 * (i + 0.5)) / rays;
    const r = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    const d = [Math.cos(a) * r * 200, y * 200, Math.sin(a) * r * 200];
    const hit = brushes.some((b) =>
      segmentHitsBox(p.x, p.y + PLAYER.eyeHeight, p.z, d[0], d[1], d[2], 1, b),
    );
    if (!hit)
      out.push(`a ray from the spawn towards ${d.map(fmt).join(", ")} escapes`);
  }
  return out;
}

/**
 * Sealed as drawn: from points in reachable air (a lattice, and round every
 * doorway, where modules meet), rays first hit the front of an emitted
 * triangle.
 */
export function meshSealProblems(
  built: BuiltLevel,
  assembled: AssembledLevel,
  spacing = 1.3,
  rays = 24,
): string[] {
  const { data, meshes } = built;
  const air = levelAir(data);
  const grid = new TriangleGrid(meshes);
  const index = new BoxIndex(data.brushes.map(boxOf));
  const clear = (x: number, y: number, z: number): boolean =>
    air.reachable(x, y, z) &&
    index.overlapping({
      x0: x - 0.04,
      x1: x + 0.04,
      y0: y - 0.04,
      y1: y + 0.04,
      z0: z - 0.04,
      z1: z + 0.04,
    }).length === 0;
  const points: number[][] = [];
  const all = data.brushes.map(boxOf);
  const x0 = Math.min(...all.map((b) => b.x0));
  const x1 = Math.max(...all.map((b) => b.x1));
  const z0 = Math.min(...all.map((b) => b.z0));
  const z1 = Math.max(...all.map((b) => b.z1));
  for (let x = x0 + 0.213; x < x1; x += spacing) {
    for (let z = z0 + 0.177; z < z1; z += spacing) {
      for (const y of [0.15, 1.1, 2.3, 3.6])
        if (clear(x, y, z)) points.push([x, y, z]);
    }
  }
  for (const c of doorways(assembled)) {
    const r = { x: -c.facing.z, z: c.facing.x };
    for (const along of [-1.0, -0.45, -0.15, 0, 0.15, 0.45, 1.0]) {
      for (const across of [-0.4, 0, 0.4]) {
        for (const y of [0.1, 1.0, c.height - 0.1]) {
          const x = c.position.x + c.facing.x * along + r.x * across * c.width;
          const z = c.position.z + c.facing.z * along + r.z * across * c.width;
          if (clear(x, y, z)) points.push([x, y, z]);
        }
      }
    }
  }
  const out: string[] = [];
  points.forEach((o, n) => {
    const spin = n * 0.7548776662;
    for (let i = 0; i < rays; i++) {
      const y = 1 - (2 * (i + 0.5)) / rays;
      const r = Math.sqrt(1 - y * y);
      const a = i * Math.PI * (3 - Math.sqrt(5)) + spin;
      const d = [Math.cos(a) * r, y, Math.sin(a) * r];
      const hit = grid.cast(o, d, 120);
      if (!hit || !hit.front) {
        out.push(
          `from ${o.map(fmt).join(", ")} towards ${d.map(fmt).join(", ")}: ${hit ? `back of ${hit.material} at ${fmt(hit.t)} m` : "nothing"}`,
        );
      }
    }
  });
  if (points.length < 100) out.push(`only ${points.length} sample points`);
  return out;
}

/** Coplanar overlaps among the level's faces, split into plan tiles for speed. */
function tiledOverlaps(
  rects: readonly FaceRect[],
  against?: readonly FaceRect[],
): string[] {
  const TILE = 4;
  const tiles = new Map<string, { a: FaceRect[]; b: FaceRect[] }>();
  const put = (r: FaceRect, side: "a" | "b") => {
    // Tiles over the rect's two in-plane extents (axes (n+1)%3, (n+2)%3).
    for (let i = Math.floor(r.a0 / TILE); i <= Math.floor(r.a1 / TILE); i++) {
      for (let j = Math.floor(r.b0 / TILE); j <= Math.floor(r.b1 / TILE); j++) {
        const key = `${r.axis}|${i}|${j}`;
        let t = tiles.get(key);
        if (!t) {
          t = { a: [], b: [] };
          tiles.set(key, t);
        }
        t[side].push(r);
      }
    }
  };
  for (const r of rects) put(r, "a");
  for (const r of against ?? []) put(r, "b");
  const found = new Set<string>();
  for (const t of tiles.values()) {
    const list = against ? coplanarOverlaps(t.a, t.b) : coplanarOverlaps(t.a);
    for (const o of list)
      found.add(`${o.a} / ${o.b} @ ${o.axis}=${o.plane.toFixed(3)}`);
  }
  return [...found];
}

const TRAVEL = [0, 0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98, 1];

/**
 * No z-fighting: no two visible level faces share a plane, facing and area;
 * nor does a door slab (anywhere along its travel) or a plate with them.
 */
export function coplanarProblems(data: LevelData): string[] {
  const faces = faceCells(data.brushes, levelAir(data));
  const label = (n: number) => `brush #${n} ${data.brushes[n].material}`;
  const level = levelRects(faces, label);
  const out = tiledOverlaps(level);
  const fixtures: FaceRect[] = [];
  for (const d of data.doors) {
    for (const t of TRAVEL) {
      const o = d.openOffset;
      const min = {
        x: d.closed.min.x + o.x * t,
        y: d.closed.min.y + o.y * t,
        z: d.closed.min.z + o.z * t,
      };
      const max = {
        x: d.closed.max.x + o.x * t,
        y: d.closed.max.y + o.y * t,
        z: d.closed.max.z + o.z * t,
      };
      fixtures.push(...boxRects(`door ${d.id} at ${t}`, min, max));
    }
  }
  for (const p of data.plates)
    fixtures.push(...boxRects(`plate ${p.id}`, p.box.min, p.box.max));
  out.push(...tiledOverlaps(fixtures, level));
  return out;
}

/** Props rest on a brush or another prop and overlap nothing solid. */
export function propProblems(data: LevelData): string[] {
  const out: string[] = [];
  const brushes = data.brushes.map(boxOf);
  const index = new BoxIndex(brushes);
  const boxes = data.props.map(propBox);
  const doors = data.doors.map((d) => boxOf(d.closed));
  boxes.forEach((pb, i) => {
    const c = data.props[i].position;
    if (index.overlapping(pb).some((n) => boxesOverlap(pb, brushes[n], 1e-3))) {
      out.push(`prop ${i} (${data.props[i].kind}) at ${fmtP(c)} is in a brush`);
    }
    if (doors.some((d) => boxesOverlap(pb, d, 1e-3)))
      out.push(`prop ${i} is in a door`);
    if (boxes.some((o, j) => j !== i && boxesOverlap(pb, o, 1e-3)))
      out.push(`prop ${i} is in another prop`);
    const rests = (b: Box) =>
      Math.abs(pb.y0 - b.y1) <= 0.01 &&
      c.x >= b.x0 &&
      c.x <= b.x1 &&
      c.z >= b.z0 &&
      c.z <= b.z1;
    if (!brushes.some(rests) && !boxes.some((o, j) => j !== i && rests(o))) {
      out.push(
        `prop ${i} (${data.props[i].kind}) at ${fmtP(c)} rests on nothing`,
      );
    }
  });
  return out;
}

/** Lights in open air; dynamic lights bounded with 0.3 m to spare. */
export function lightProblems(data: LevelData): string[] {
  const out: string[] = [];
  const brushes = data.brushes.map(boxOf);
  data.lights.forEach((l, i) => {
    const p = l.position;
    const probe = {
      x0: p.x - 0.15,
      x1: p.x + 0.15,
      y0: p.y - 0.15,
      y1: p.y + 0.15,
      z0: p.z - 0.15,
      z1: p.z + 0.15,
    };
    if (brushes.some((b) => boxesOverlap(probe, b)))
      out.push(`light ${i} at ${fmtP(p)} is within 0.15 m of a brush`);
    if (l.flicker !== "none") {
      if (!l.bounds) {
        out.push(`dynamic light ${i} has no bounds`);
        return;
      }
      const b = boxOf(l.bounds);
      const spare = Math.min(
        p.x - b.x0,
        b.x1 - p.x,
        p.y - b.y0,
        b.y1 - p.y,
        p.z - b.z0,
        b.z1 - p.z,
      );
      if (spare < 0.3)
        out.push(`dynamic light ${i} is ${fmt(spare)} m inside its bounds`);
    }
  });
  return out;
}

const CELL = 0.25;

/**
 * Cells (keys) a player can walk to from the spawn, with `extra` solid
 * boxes (closed door slabs), ignoring props. Also returns the centres.
 */
export function walkFlood(
  data: LevelData,
  extra: Box[] = [],
): Map<number, Vec3> {
  const index = new BoxIndex([...colliderBoxes(data), ...extra]);
  const half = PLAYER.halfWidth;
  const free = (x: number, z: number) =>
    index.overlapping({
      x0: x - half,
      x1: x + half,
      y0: PLAYER.stepHeight + 0.01,
      y1: PLAYER.standHeight,
      z0: z - half,
      z1: z + half,
    }).length === 0;
  const key = (i: number, k: number) => (i + 4096) * 8192 + (k + 4096);
  const s = data.playerSpawn.position;
  const si = Math.round(s.x / CELL);
  const sk = Math.round(s.z / CELL);
  const seen = new Map<number, Vec3>([
    [key(si, sk), { x: si * CELL, y: 0, z: sk * CELL }],
  ]);
  const queue: [number, number][] = [[si, sk]];
  while (queue.length > 0) {
    const [i, k] = queue.pop()!;
    for (const [di, dk] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di;
      const nk = k + dk;
      const kk = key(ni, nk);
      if (seen.has(kk) || !free(ni * CELL, nk * CELL)) continue;
      seen.set(kk, { x: ni * CELL, y: 0, z: nk * CELL });
      queue.push([ni, nk]);
    }
  }
  return seen;
}

/**
 * The exit is walkable from the spawn with every door open, and with any
 * one door closed it is not (it lies past every door of the chain); every
 * walkable cell lies in an acoustic zone (bar ZONE_REACH round doorways).
 */
export function walkProblems(
  data: LevelData,
  assembled: AssembledLevel,
): string[] {
  const out: string[] = [];
  const exit = boxOf(data.exit);
  const reachesExit = (cells: Map<number, Vec3>) =>
    [...cells.values()].some((p) => containsPoint(exit, p.x, 0, p.z));
  const open = walkFlood(data);
  if (!reachesExit(open))
    out.push("the exit cannot be walked to with every door open");
  for (const d of data.doors) {
    if (reachesExit(walkFlood(data, [boxOf(d.closed)]))) {
      out.push(`the exit can be walked to with door ${d.id} closed`);
    }
  }
  const zones = data.zones.map((z) => boxOf(z.box));
  const planes = doorways(assembled);
  const unzoned = [...open.values()].filter(
    (p) =>
      !planes.some(
        (c) =>
          Math.abs(
            (p.x - c.position.x) * c.facing.x +
              (p.z - c.position.z) * c.facing.z,
          ) <=
          ZONE_REACH + 1e-9,
      ) && !zones.some((z) => containsPoint(z, p.x, 0.9, p.z)),
  );
  for (const p of unzoned.slice(0, 5))
    out.push(`walkable floor at ${fmtP(p)} is in no acoustic zone`);
  return out;
}

/** The joined solution plays on paper from the spawn to the exit. */
export function solutionProblems(data: LevelData): string[] {
  const brushes = data.brushes.map(boxOf);
  const out = verifySolution(data.solution, data.playerSpawn.position, {
    solids: colliderBoxes(data),
    floors: brushes,
    props: data.props,
    buttons: data.buttons,
    plates: data.plates.map((p) => boxOf(p.box)),
  });
  const last = [...data.solution].reverse().find((s) => s.do === "walk");
  if (
    !last ||
    last.do !== "walk" ||
    !containsPoint(boxOf(data.exit), last.to.x, 0.5, last.to.z)
  ) {
    out.push("the solution does not end in the exit box");
  }
  const ids = [
    ...data.doors.map((d) => d.id),
    ...data.buttons.map((b) => b.id),
    ...data.plates.map((p) => p.id),
  ];
  if (new Set(ids).size !== ids.length) out.push("ids are not unique");
  for (const s of data.solution) {
    if ("prop" in s && (s.prop < 0 || s.prop >= data.props.length))
      out.push(`step uses prop ${s.prop}`);
  }
  return out;
}

/** Every check above, by name. */
export function allProblems(
  run: RunPlan,
  assembled: AssembledLevel,
  built: BuiltLevel,
  config: GeneratorConfig,
): Record<string, string[]> {
  const data = assembled.data;
  return {
    chain: chainProblems(run, assembled, config),
    seal: sealProblems(data),
    mesh: meshSealProblems(built, assembled),
    coplanar: coplanarProblems(data),
    props: propProblems(data),
    lights: lightProblems(data),
    walk: walkProblems(data, assembled),
    solution: solutionProblems(data),
  };
}

export { describeOverlap };
