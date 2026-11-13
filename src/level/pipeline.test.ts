/**
 * The scaled-up pipeline (sparse run-based air flood, light baking through
 * light and blocker grids, face cutting through a brush grid) gives exactly
 * what the plain versions in reference.ts give, on the hand-built level, on
 * a generated run and on small scenes that leak.
 */
import { describe, expect, test } from "bun:test";
import type { LevelData } from "../core/api";
import { createRng } from "../core/rng";
import { AirGrid } from "./airgrid";
import { LightBaker } from "./bake";
import { defineLevel } from "./define";
import { generateLevel } from "./gen";
import { boxOf, type Box } from "./geometry";
import { doorVolume, levelAir } from "./index";
import { faceCells, isSeeThrough } from "./meshgen";
import {
  DenseAirGrid,
  ReferenceLightBaker,
  referenceFaceCells,
} from "./reference";

const LEVELS: [string, LevelData][] = [
  ["hand-built", defineLevel()],
  ["seed 3", generateLevel(3)],
];

function airInputs(data: LevelData) {
  const spawn = data.playerSpawn.position;
  return [
    data.brushes.filter((b) => !isSeeThrough(b)).map(boxOf),
    { x: spawn.x, y: spawn.y + 1, z: spawn.z },
    0.1,
    data.doors.map(doorVolume),
  ] as const;
}

function sameAir(fast: AirGrid, dense: DenseAirGrid, bounds: Box): void {
  expect(fast.leaks).toBe(dense.leaks);
  expect(fast.reachedCount).toBe(dense.reachedCount);
  const rng = createRng(11);
  const mismatches: string[] = [];
  for (let n = 0; n < 20000; n++) {
    const x = bounds.x0 + (bounds.x1 - bounds.x0) * rng.next();
    const y = bounds.y0 + (bounds.y1 - bounds.y0) * rng.next();
    const z = bounds.z0 + (bounds.z1 - bounds.z0) * rng.next();
    if (fast.reachable(x, y, z) !== dense.reachable(x, y, z)) {
      mismatches.push(`point ${x}, ${y}, ${z}`);
    }
    const s = 0.05 + 0.3 * rng.next();
    const box = { x0: x, y0: y, z0: z, x1: x + s, y1: y + s * 0.2, z1: z + s };
    if (fast.reachableIn(box) !== dense.reachableIn(box)) {
      mismatches.push(`box at ${x}, ${y}, ${z}`);
    }
  }
  expect(mismatches.slice(0, 5)).toEqual([]);
}

const extent = (boxes: readonly Box[], m: number): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)) - m,
  y0: Math.min(...boxes.map((b) => b.y0)) - m,
  z0: Math.min(...boxes.map((b) => b.z0)) - m,
  x1: Math.max(...boxes.map((b) => b.x1)) + m,
  y1: Math.max(...boxes.map((b) => b.y1)) + m,
  z1: Math.max(...boxes.map((b) => b.z1)) + m,
});

describe("reachable air: sparse run flood = dense voxel flood", () => {
  for (const [name, data] of LEVELS) {
    test(name, () => {
      const args = airInputs(data);
      sameAir(
        new AirGrid(...args),
        new DenseAirGrid(...args),
        extent(args[0], 1),
      );
    });
  }

  test("small scenes, sealed and leaking, seeds inside and outside", () => {
    // A 4 x 3 x 4 m room of 0.3 m walls, off the voxel grid, with a hole.
    const room = (hole: boolean): Box[] => {
      const o = 0.037;
      const b = (
        x0: number,
        y0: number,
        z0: number,
        x1: number,
        y1: number,
        z1: number,
      ) => ({ x0: x0 + o, y0, z0: z0 + o, x1: x1 + o, y1, z1: z1 + o });
      const walls = [
        b(0, -0.3, 0, 4, 0, 4),
        b(0, 3, 0, 4, 3.3, 4),
        b(-0.3, -0.3, -0.3, 0, 3.3, 4.3),
        b(4, -0.3, -0.3, 4.3, 3.3, 4.3),
        b(0, -0.3, -0.3, 4, 3.3, 0),
      ];
      if (hole) {
        walls.push(b(0, -0.3, 4, 1.5, 3.3, 4.3), b(2.2, -0.3, 4, 4, 3.3, 4.3));
        walls.push(
          b(1.5, 2.1, 4, 2.2, 3.3, 4.3),
          b(1.5, -0.3, 4, 2.2, 0.05, 4.3),
        );
      } else {
        walls.push(b(0, -0.3, 4, 4, 3.3, 4.3));
      }
      // A far-away pillar, so the grid has unstored columns between.
      walls.push(b(12, -0.3, 9, 12.4, 3.3, 9.4));
      return walls;
    };
    for (const hole of [false, true]) {
      const boxes = room(hole);
      for (const seed of [
        { x: 2, y: 1, z: 2 },
        { x: 8, y: 1, z: 6 },
      ]) {
        if (!hole && seed.x === 8) continue;
        const fast = new AirGrid(boxes, seed);
        const dense = new DenseAirGrid(boxes, seed);
        expect(fast.leaks).toBe(hole || seed.x === 8);
        sameAir(fast, dense, extent(boxes, 1));
      }
    }
  });
});

describe("light baking: grids = every light against every blocker", () => {
  for (const [name, data] of LEVELS) {
    test(name, () => {
      const boxes = data.brushes.map(boxOf);
      const see = data.brushes.map(isSeeThrough);
      const fast = new LightBaker(boxes, data.lights, data.ambient, see);
      const ref = new ReferenceLightBaker(
        boxes,
        data.lights,
        data.ambient,
        see,
      );
      const rng = createRng(5);
      const normals = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      const bad: string[] = [];
      // Points on brush faces, where the baker is asked.
      for (let n = 0; n < 6000; n++) {
        const b = boxes[rng.int(0, boxes.length - 1)];
        const f = rng.int(0, 5);
        const [nx, ny, nz] = normals[f];
        const p = [
          b.x0 + (b.x1 - b.x0) * rng.next(),
          b.y0 + (b.y1 - b.y0) * rng.next(),
          b.z0 + (b.z1 - b.z0) * rng.next(),
        ];
        if (nx) p[0] = nx > 0 ? b.x1 : b.x0;
        if (ny) p[1] = ny > 0 ? b.y1 : b.y0;
        if (nz) p[2] = nz > 0 ? b.z1 : b.z0;
        const a = fast.sample(p[0], p[1], p[2], nx, ny, nz);
        const r = ref.sample(p[0], p[1], p[2], nx, ny, nz);
        if (a[0] !== r[0] || a[1] !== r[1] || a[2] !== r[2]) {
          bad.push(`${p.join(", ")}: ${a} vs ${r}`);
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }
});

describe("face cutting: brush grid = every brush against every brush", () => {
  for (const [name, data] of LEVELS) {
    test(name, () => {
      const air = levelAir(data);
      const fast = faceCells(data.brushes, air);
      const ref = referenceFaceCells(data.brushes, air);
      expect(fast.length).toBe(ref.length);
      const bad: number[] = [];
      fast.forEach((f, i) => {
        const r = ref[i];
        const same =
          f.brush === r.brush &&
          f.plane === r.plane &&
          f.us.join() === r.us.join() &&
          f.vs.join() === r.vs.join() &&
          f.visible.join() === r.visible.join();
        if (!same) bad.push(i);
      });
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }
});
