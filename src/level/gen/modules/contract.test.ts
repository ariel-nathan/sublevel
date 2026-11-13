/**
 * The room module contract for the generator's own modules (finish,
 * adapter, stand-ins): a copy of src/level/rooms/contract.test.ts run over
 * GEN_MODULES, since that file runs over the shared registry only and
 * exports no helper. Keep the two in step (or export the checks from
 * there and call them here).
 */
import { describe, expect, test } from "bun:test";
import { PLAYER } from "../../../core/props";
import { createRng } from "../../../core/rng";
import type { Vec3 } from "../../../math";
import { buildRoom, outsideFootprint } from "../../assemble";
import { boxOf, BoxIndex, containsPoint, type Box } from "../../geometry";
import { isSkirting, SKIRTING_COLLIDER_TOP } from "../../index";
import { GEN_MODULES } from "./index";
import {
  doorwayPoints,
  ZONE_REACH,
  type AnyRoomModule,
  type Connector,
  type RoomPlan,
} from "../../rooms/room";
import { bodyBox, verifySolution } from "../../rooms/solution";

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
  module: AnyRoomModule;
  params: unknown;
  at: Connector;
  mirror: boolean;
}

function paramSets(module: AnyRoomModule): unknown[] {
  const sets = [module.defaults];
  for (let seed = 1; seed <= 4; seed++) {
    sets.push(module.random(createRng(seed)));
  }
  const seen = new Set<string>();
  return sets.filter((p) => {
    const key = JSON.stringify(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cases(module: AnyRoomModule): Case[] {
  const out: Case[] = [];
  let n = 0;
  for (const params of paramSets(module)) {
    for (const facing of FACINGS) {
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
        out.push({
          label: `${JSON.stringify(params)} facing (${facing.x}, ${facing.z})${mirror ? " mirrored" : ""} ${size.width}x${size.height}`,
          module,
          params,
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

const colliders = (plan: { brushes: { min: Vec3; max: Vec3 }[] }): Box[] =>
  plan.brushes.map((b) => {
    const box = boxOf(b);
    return isSkirting(b as never) ? { ...box, y1: SKIRTING_COLLIDER_TOP } : box;
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

for (const module of GEN_MODULES) {
  describe(`room module "${module.name}"`, () => {
    const all = cases(module);

    test("declares itself consistently", () => {
      expect(module.name.length).toBeGreaterThan(0);
      expect(module.difficulty).toBeGreaterThanOrEqual(0);
      expect(module.difficulty).toBeLessThanOrEqual(3);
      const [w0, w1] = module.entrySize.width;
      const [h0, h1] = module.entrySize.height;
      expect(w0).toBeLessThanOrEqual(w1);
      expect(h0).toBeLessThanOrEqual(h1);
      if (module.role !== "start") {
        expect(w0).toBeGreaterThanOrEqual(2 * PLAYER.halfWidth + 0.3);
        expect(h0).toBeGreaterThanOrEqual(PLAYER.standHeight + 0.2);
      }
    });

    test("builds in every facing, mirrored too, all inside its footprint, with its doorways on its boundary", () => {
      for (const c of all) {
        const { plan, parts } = buildRoom(module, c.at, {
          params: c.params,
          mirror: c.mirror,
          prefix: "m.",
        });
        expect([c.label, outsideFootprint(plan, parts)]).toEqual([c.label, []]);
        const region = plan.footprint.map(boxOf);
        const y = 1;
        const on = (conn: Connector, out: 1 | -1) => {
          const p = conn.position;
          const f = conn.facing;
          const d = 0.01 * out;
          return (
            !inRegion(region, p.x + f.x * d, y, p.z + f.z * d) &&
            inRegion(region, p.x - f.x * d, y, p.z - f.z * d)
          );
        };
        if (plan.entry) {
          expect([c.label, "entry", on(plan.entry.connector, -1)]).toEqual([
            c.label,
            "entry",
            true,
          ]);
        }
        plan.exits.forEach((e, i) => {
          expect([c.label, `exit ${i}`, on(e.connector, 1)]).toEqual([
            c.label,
            `exit ${i}`,
            true,
          ]);
          const f = e.connector.facing;
          expect(Math.abs(f.y)).toBe(0);
          expect(Math.abs(f.x) + Math.abs(f.z)).toBe(1);
        });
        // Roles.
        if (module.role === "start") expect(plan.spawn).toBeDefined();
        if (module.role === "finish") expect(plan.exit).toBeDefined();
        else expect(plan.exits.length).toBeGreaterThan(0);
      }
    });

    test("doorways are reachable from the start, and the exit only once the lock is open", () => {
      for (const c of all) {
        const { plan, parts } = buildRoom(module, c.at, {
          params: c.params,
          mirror: c.mirror,
          prefix: "m.",
        });
        const solids = colliders(parts);
        const region = plan.footprint.map(boxOf);
        const start = startOf(plan);
        const open = flood(start, solids, region);
        const reachesExit = (cells: Vec3[]) =>
          plan.exit
            ? cells.some((p) => containsPoint(boxOf(plan.exit!), p.x, 0, p.z))
            : plan.exits.every((e) => atDoorway(cells, e.connector, -1));
        expect([c.label, "exit open", reachesExit(open)]).toEqual([
          c.label,
          "exit open",
          true,
        ]);
        if (plan.entry) {
          expect([
            c.label,
            "entry",
            atDoorway(open, plan.entry.connector, 1),
          ]).toEqual([c.label, "entry", true]);
        }
        if (plan.lock.kind !== "none" && plan.lock.doors.length > 0) {
          const slabs = parts.doors
            .filter((d) => plan.lock.doors.includes(d.id))
            .map((d) => boxOf(d.closed));
          expect(slabs.length).toBe(plan.lock.doors.length);
          const locked = flood(start, [...solids, ...slabs], region);
          expect([c.label, "exit locked", reachesExit(locked)]).toEqual([
            c.label,
            "exit locked",
            false,
          ]);
        }
        // Zones cover the walkable floor, except within ZONE_REACH of a
        // doorway's plane, where the neighbour's zone may cover it instead.
        const zones = parts.zones.map((z) => boxOf(z.box));
        const doorways = [
          ...(plan.entry ? [plan.entry.connector] : []),
          ...plan.exits.map((e) => e.connector),
        ];
        const nearDoorway = (p: Vec3) =>
          doorways.some(
            (d) =>
              Math.abs(
                (p.x - d.position.x) * d.facing.x +
                  (p.z - d.position.z) * d.facing.z,
              ) <=
              ZONE_REACH + 1e-9,
          );
        const outside = open.filter(
          (p) =>
            !nearDoorway(p) &&
            !zones.some((z) => containsPoint(z, p.x, p.y + 0.9, p.z)),
        );
        expect([c.label, "unzoned", outside.slice(0, 3)]).toEqual([
          c.label,
          "unzoned",
          [],
        ]);
      }
    });

    test("its solution is walkable and uses only what it provides", () => {
      for (const c of all) {
        const { plan, parts } = buildRoom(module, c.at, {
          params: c.params,
          mirror: c.mirror,
          prefix: "m.",
        });
        const start = startOf(plan);
        const problems = verifySolution(plan.solution, start, {
          solids: colliders(parts),
          floors: parts.brushes.map(boxOf),
          props: parts.props,
          buttons: parts.buttons,
          plates: parts.plates.map((p) => boxOf(p.box)),
          within: plan.footprint.map(boxOf),
        });
        expect([c.label, problems]).toEqual([c.label, []]);
        // It ends where the next module's solution can take over.
        const walks = plan.solution.filter((s) => s.do === "walk");
        const last = walks[walks.length - 1];
        expect(last).toBeDefined();
        if (last?.do !== "walk") continue;
        if (plan.exit) {
          expect(containsPoint(boxOf(plan.exit), last.to.x, 0, last.to.z)).toBe(
            true,
          );
        } else {
          const before = doorwayPoints(plan.exits[0].connector).before;
          expect([c.label, last.to]).toEqual([c.label, before]);
        }
        // The lock's ids and keys exist.
        for (const id of plan.lock.doors) {
          expect(parts.doors.some((d) => d.id === id)).toBe(true);
        }
        for (const id of plan.lock.buttons) {
          expect(parts.buttons.some((b) => b.id === id)).toBe(true);
        }
        for (const id of plan.lock.plates) {
          expect(parts.plates.some((p) => p.id === id)).toBe(true);
        }
        for (const key of plan.lock.keys) {
          expect(parts.props[key.prop]).toBeDefined();
        }
      }
    });

    test("dynamic lights are bounded, with the light 0.3 m inside its box", () => {
      for (const c of all) {
        const { parts } = buildRoom(module, c.at, {
          params: c.params,
          mirror: c.mirror,
        });
        for (const l of parts.lights) {
          if (l.flicker === "none") continue;
          expect(l.bounds).toBeDefined();
          const b = boxOf(l.bounds!);
          const p = l.position;
          expect(
            Math.min(
              p.x - b.x0,
              b.x1 - p.x,
              p.y - b.y0,
              b.y1 - p.y,
              p.z - b.z0,
              b.z1 - p.z,
            ),
          ).toBeGreaterThanOrEqual(0.3);
        }
      }
    });

    test("ids are unique, also across two instances; building is deterministic", () => {
      const c = all[0];
      const ids = (prefix: string) => {
        const { parts } = buildRoom(module, c.at, {
          params: c.params,
          prefix,
        });
        return [
          ...parts.doors.map((d) => d.id),
          ...parts.buttons.map((b) => b.id),
          ...parts.plates.map((p) => p.id),
        ];
      };
      const a = ids("a.");
      const b = ids("b.");
      expect(new Set(a).size).toBe(a.length);
      expect(a.filter((id) => b.includes(id))).toEqual([]);
      for (const p of paramSets(module)) {
        const once = buildRoom(module, c.at, {
          params: p,
          seed: 7,
          mirror: true,
        });
        const again = buildRoom(module, c.at, {
          params: p,
          seed: 7,
          mirror: true,
        });
        expect(again).toEqual(once);
      }
    });
  });
}
