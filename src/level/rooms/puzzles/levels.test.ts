/**
 * Level-wide checks of the puzzle rooms in assembled development levels
 * (`buildRoomsLevel`): for each module, with its defaults and two random
 * parameter sets, the level is sealed (voxel flood, rays from the spawn,
 * rays from the air in the room against the emitted mesh), no two visible
 * faces z-fight (level faces, door slabs along their travel, plates raised
 * and sunk, button units), props rest on something and overlap nothing,
 * lights hang in open air, and the joined solution is walkable on paper.
 * Also: development levels are deterministic, and a chain of eight rooms
 * assembles without overlapping.
 */
import { describe, expect, test } from "bun:test";
import type { ButtonDef, LevelData } from "../../../core/api";
import { PLAYER } from "../../../core/props";
import { v3 } from "../../../math";
import { AirGrid } from "../../airgrid";
import {
  boxRects,
  coplanarOverlaps,
  describeOverlap,
  levelRects,
  type FaceRect,
} from "../../coplanar";
import { assembleRoomsLevel, buildRoomsLevel } from "../../dev";
import {
  boxesOverlap,
  boxOf,
  BoxIndex,
  propBox,
  segmentHitsBox,
  type Box,
} from "../../geometry";
import {
  buildLevelFrom,
  isSkirting,
  levelAir,
  SKIRTING_COLLIDER_TOP,
} from "../../index";
import { faceCells } from "../../meshgen";
import { TriangleGrid } from "../../raymesh";
import { verifySolution } from "../solution";
import { PENDING_MODULES, PUZZLE_MODULES } from "./index";

const MODULES = [...PUZZLE_MODULES, ...PENDING_MODULES];
const PENDING = new Set(PENDING_MODULES.map((m) => m.name));
/** Seed 0: the module's defaults. */
const SEEDS = [0, 1, 2];

function level(name: string, seed: number) {
  return assembleRoomsLevel(
    [seed === 0 ? `${name}!default` : name],
    seed === 0 ? 1 : seed,
  );
}

// Fixture shapes as the world objects draw them (src/props/fixtures.ts,
// meshes.ts): duplicated here because modules do not import each other.
const PLATE_SINK = 0.025;
function buttonBoxes(def: ButtonDef): { box: Box; skip: string }[] {
  const f = v3.normalize(def.facing);
  const axis = f.x !== 0 ? "x" : "z";
  const back = `${(f.x || f.z) > 0 ? "n" : "p"}${axis}`;
  const along = (from: number, to: number, half: number): Box => {
    const a = v3.addScaled(def.position, f, from);
    const b = v3.addScaled(def.position, f, to);
    const hx = axis === "x" ? 0 : half;
    const hz = axis === "z" ? 0 : half;
    return {
      x0: Math.min(a.x, b.x) - hx,
      x1: Math.max(a.x, b.x) + hx,
      y0: def.position.y - half,
      y1: def.position.y + half,
      z0: Math.min(a.z, b.z) - hz,
      z1: Math.max(a.z, b.z) + hz,
    };
  };
  const parts =
    def.mode === "impact"
      ? [
          along(-0.08, -0.04, 0.17),
          along(-0.04, -0.025, 0.12),
          along(-0.025, 0, 0.085),
        ]
      : [along(-0.07, -0.02, 0.11), along(-0.02, 0, 0.065)];
  return parts.map((box) => ({ box, skip: back }));
}
const rectsOf = (owner: string, b: Box, skip: string[] = []): FaceRect[] =>
  boxRects(
    owner,
    { x: b.x0, y: b.y0, z: b.z0 },
    { x: b.x1, y: b.y1, z: b.z1 },
    skip,
  );

function checkGeometry(data: LevelData): string[] {
  const problems: string[] = [];
  const brushes = data.brushes.map(boxOf);
  const doors = data.doors.map((d) => boxOf(d.closed));
  const spawn = data.playerSpawn.position;
  const seed = { x: spawn.x, y: 1, z: spawn.z };
  if (new AirGrid(brushes, seed).leaks)
    problems.push("air leaks out (doors open)");
  const index = new BoxIndex(brushes);
  // Rays from the spawn hit geometry.
  const eye = { x: spawn.x, y: spawn.y + PLAYER.eyeHeight, z: spawn.z };
  const n = 400;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    const d = [Math.cos(a) * r * 200, y * 200, Math.sin(a) * r * 200];
    if (
      !brushes.some((b) =>
        segmentHitsBox(eye.x, eye.y, eye.z, d[0], d[1], d[2], 1, b),
      )
    ) {
      problems.push(
        `a ray from the spawn escapes towards ${d.map((v) => (v / 200).toFixed(2))}`,
      );
      break;
    }
  }
  // Visible faces: no z-fighting among level faces, nor against or between
  // the fixtures in any state.
  const label = (k: number) => `brush #${k} ${data.brushes[k].material}`;
  const level = levelRects(faceCells(data.brushes, levelAir(data)), label);
  for (const o of coplanarOverlaps(level)) problems.push(describeOverlap(o));
  const buttons = data.buttons.flatMap((b) =>
    buttonBoxes(b)
      .map((p, i) => rectsOf(`${b.id} part ${i}`, p.box, [p.skip]))
      .flat(),
  );
  const againstLevel: FaceRect[] = [...buttons];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    for (const pressed of [false, true]) {
      const slabs = data.doors.flatMap((d) =>
        rectsOf(
          `${d.id} slab ${t}`,
          boxOf({
            min: v3.addScaled(d.closed.min, d.openOffset, t),
            max: v3.addScaled(d.closed.max, d.openOffset, t),
          }),
        ),
      );
      const plates = data.plates.flatMap((p) => {
        const b = boxOf(p.box);
        const s = pressed ? PLATE_SINK : 0;
        return rectsOf(
          `${p.id} ${pressed}`,
          { ...b, y0: b.y0 - s, y1: b.y1 - s },
          ["ny"],
        );
      });
      if (!pressed) againstLevel.push(...slabs);
      if (t === 0) againstLevel.push(...plates);
      for (const o of coplanarOverlaps([...slabs, ...plates, ...buttons])) {
        problems.push(describeOverlap(o));
      }
    }
  }
  for (const o of coplanarOverlaps(againstLevel, level))
    problems.push(describeOverlap(o));
  // Props rest on something and overlap nothing.
  const props = data.props.map(propBox);
  const plates = data.plates.map((p) => boxOf(p.box));
  props.forEach((pb, i) => {
    const c = data.props[i].position;
    const hits = index.overlapping({
      x0: pb.x0 + 1e-3,
      x1: pb.x1 - 1e-3,
      y0: pb.y0 + 1e-3,
      y1: pb.y1 - 1e-3,
      z0: pb.z0 + 1e-3,
      z1: pb.z1 - 1e-3,
    });
    if (hits.length > 0)
      problems.push(`prop #${i} ${data.props[i].kind} overlaps a brush`);
    if ([...doors, ...plates].some((b) => boxesOverlap(pb, b, 1e-3))) {
      problems.push(
        `prop #${i} ${data.props[i].kind} overlaps a door or plate`,
      );
    }
    props.forEach((o, j) => {
      if (j > i && boxesOverlap(pb, o, 1e-3))
        problems.push(`props #${i} and #${j} overlap`);
    });
    const on = (b: Box) =>
      Math.abs(pb.y0 - b.y1) <= 0.01 &&
      c.x >= b.x0 &&
      c.x <= b.x1 &&
      c.z >= b.z0 &&
      c.z <= b.z1;
    if (!brushes.some(on) && !props.some((o, j) => j !== i && on(o))) {
      problems.push(`prop #${i} ${data.props[i].kind} rests on nothing`);
    }
  });
  // Lights in open air.
  for (const [i, l] of data.lights.entries()) {
    const p = l.position;
    for (const k of index.overlapping({
      x0: p.x - 0.15,
      x1: p.x + 0.15,
      y0: p.y - 0.15,
      y1: p.y + 0.15,
      z0: p.z - 0.15,
      z1: p.z + 0.15,
    })) {
      const b = brushes[k];
      const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
      const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
      const dz = Math.max(b.z0 - p.z, 0, p.z - b.z1);
      if (Math.hypot(dx, dy, dz) < 0.15)
        problems.push(`light #${i} is within 0.15 m of a brush`);
    }
  }
  return problems;
}

/** Rays from air in the room's footprint first hit a front face of the mesh. */
function sealedFromInside(data: LevelData, room: Box[]): string[] {
  const built = buildLevelFrom(data);
  const grid = new TriangleGrid(built.meshes);
  const air = levelAir(data);
  const index = new BoxIndex(data.brushes.map(boxOf));
  const points: number[][] = [];
  for (const r of room) {
    for (let x = r.x0 + 0.21; x < r.x1; x += 0.9) {
      for (let z = r.z0 + 0.23; z < r.z1; z += 0.9) {
        for (const y of [0.15, 1.1, 2.3, 3.6]) {
          const probe = {
            x0: x - 0.04,
            x1: x + 0.04,
            y0: y - 0.04,
            y1: y + 0.04,
            z0: z - 0.04,
            z1: z + 0.04,
          };
          if (
            y < r.y1 &&
            air.reachable(x, y, z) &&
            index.overlapping(probe).length === 0
          ) {
            points.push([x, y, z]);
          }
        }
      }
    }
  }
  const failures: string[] = [];
  const rays = 24;
  points.forEach((o, n) => {
    for (let i = 0; i < rays; i++) {
      const y = 1 - (2 * (i + 0.5)) / rays;
      const r = Math.sqrt(1 - y * y);
      const a = i * Math.PI * (3 - Math.sqrt(5)) + n * 0.7548776662;
      const hit = grid.cast(o, [Math.cos(a) * r, y, Math.sin(a) * r], 60);
      if (!hit || !hit.front) {
        failures.push(
          `from (${o.map((v) => v.toFixed(2))}): ${hit ? `back of ${hit.material}` : "nothing"}`,
        );
      }
    }
  });
  if (points.length < 20) failures.push(`only ${points.length} sample points`);
  return failures;
}

for (const module of MODULES) {
  describe(`puzzle room "${module.name}" in a development level`, () => {
    for (const seed of SEEDS) {
      const { data, rooms } = level(module.name, seed);
      const placed = rooms.find((r) => r.name.startsWith("r1."))!;
      const what = seed === 0 ? "defaults" : `seed ${seed}`;
      test(`${what}: sealed, no z-fighting, props supported, lights in open air`, () => {
        expect(checkGeometry(data)).toEqual([]);
      });
      if (seed === 0) {
        test(`${what}: sealed from the inside (rays against the emitted mesh)`, () => {
          expect(
            sealedFromInside(data, placed.plan.footprint.map(boxOf)).slice(
              0,
              10,
            ),
          ).toEqual([]);
        });
      }
      if (!PENDING.has(module.name)) {
        test(`${what}: the joined solution is walkable from the spawn to the exit`, () => {
          const problems = verifySolution(
            data.solution,
            data.playerSpawn.position,
            {
              solids: data.brushes.map((b) => {
                const box = boxOf(b);
                return isSkirting(b)
                  ? { ...box, y1: SKIRTING_COLLIDER_TOP }
                  : box;
              }),
              floors: data.brushes.map(boxOf),
              props: data.props,
              buttons: data.buttons,
              plates: data.plates.map((p) => boxOf(p.box)),
            },
          );
          expect(problems).toEqual([]);
        });
      }
    }
  });
}

describe("development levels", () => {
  test("are deterministic, and accept @mirror and !default", () => {
    const a = buildRoomsLevel(["goods-bay@mirror", "fan-room!default"], 5);
    const b = buildRoomsLevel(["goods-bay@mirror", "fan-room!default"], 5);
    expect(b).toEqual(a);
    expect(buildRoomsLevel(["fan-room"], 6)).not.toEqual(
      buildRoomsLevel(["fan-room"], 7),
    );
    expect(() => buildRoomsLevel(["no-such-room"], 1)).toThrow(
      /unknown room module/,
    );
  });

  test("the authored set pieces join through a doorway adapter, sealed and solvable", () => {
    for (const name of ["storage", "filtration-hall", "valve-chamber@mirror"]) {
      const data = buildRoomsLevel([name], 1);
      expect([name, checkGeometry(data)]).toEqual([name, []]);
      const problems = verifySolution(
        data.solution,
        data.playerSpawn.position,
        {
          solids: data.brushes.map((b) => {
            const box = boxOf(b);
            return isSkirting(b) ? { ...box, y1: SKIRTING_COLLIDER_TOP } : box;
          }),
          floors: data.brushes.map(boxOf),
          props: data.props,
          buttons: data.buttons,
          plates: data.plates.map((p) => boxOf(p.box)),
        },
      );
      expect([name, problems]).toEqual([name, []]);
    }
  });

  test("a chain of eight puzzle rooms assembles, sealed, for several seeds", () => {
    const names = PUZZLE_MODULES.map((m) => m.name);
    for (const seed of [1, 2, 3, 4]) {
      const rng = (k: number) => names[(seed * 7 + k * 3) % names.length];
      const chain = Array.from(
        { length: 8 },
        (_, k) => `${rng(k)}${k % 3 === 1 ? "@mirror" : ""}`,
      );
      const data = buildRoomsLevel(chain, seed);
      const brushes = data.brushes.map(boxOf);
      const p = data.playerSpawn.position;
      expect(new AirGrid(brushes, { x: p.x, y: 1, z: p.z }).leaks).toBe(false);
      expect(data.solution.length).toBeGreaterThan(40);
    }
  });
});
