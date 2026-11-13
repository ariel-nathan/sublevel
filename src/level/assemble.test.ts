import { describe, expect, test } from "bun:test";
import { PLAYER } from "../core/props";
import { createRng } from "../core/rng";
import { AirGrid } from "./airgrid";
import {
  assembleLevel,
  jointProblem,
  place,
  type LevelPlan,
  type Placement,
} from "./assemble";
import { coplanarOverlaps, describeOverlap, levelRects } from "./coplanar";
import { KESTREL_ANNEX } from "./define";
import { boxOf, boxesOverlap, propBox, segmentHitsBox } from "./geometry";
import { buildLevelFrom, levelAir } from "./index";
import { faceCells } from "./meshgen";
import {
  CORRIDOR,
  CORRIDOR_RANGES,
  type CorridorParams,
} from "./rooms/corridor";
import { EGRESS_LOCK } from "./rooms/egress-lock";
import { FILTRATION_HALL } from "./rooms/filtration-hall";
import { LAB } from "./rooms/lab";
import type { RoomModule } from "./rooms/room";
import { STORAGE } from "./rooms/storage";
import { verifySolution } from "./rooms/solution";
import { isSkirting, SKIRTING_COLLIDER_TOP } from "./index";

const BASE = {
  name: "test",
  root: { position: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 } },
  ambient: KESTREL_ANNEX.ambient,
  fog: KESTREL_ANNEX.fog,
  seed: 1,
};

const corridor = (
  name: string,
  params: Partial<CorridorParams>,
  extra: Partial<Placement> = {},
): Placement =>
  place(CORRIDOR, {
    name,
    params: { ...CORRIDOR.defaults, ...params },
    ...extra,
  });

/**
 * The lab, three corridors (straight, bending left, bending right and
 * mirrored), a wide and tall one whose exit wall can close the egress
 * lock's open end, and the lock.
 */
const CHAIN: LevelPlan = {
  ...BASE,
  placements: [
    place(LAB, { name: "lab" }),
    corridor("c1", { length: 4, light: "steady" }),
    corridor("c2", { length: 5, bend: "left", leg: 2, light: "broken" }),
    corridor(
      "c3",
      { length: 6, bend: "right", leg: 0, pipes: false },
      { mirror: true },
    ),
    corridor("c4", { length: 3, width: 3.0, height: 3.0, light: "none" }),
    place(EGRESS_LOCK, { name: "lock" }),
  ],
};

describe("assembling a chain of modules", () => {
  const { data, rooms } = assembleLevel(CHAIN);
  const built = buildLevelFrom(data);
  const brushes = data.brushes.map(boxOf);
  const doorBoxes = data.doors.map((d) => boxOf(d.closed));

  test("places every module, joins the solutions and remaps nothing it should not", () => {
    expect(rooms.map((r) => r.name)).toEqual([
      "lab",
      "c1",
      "c2",
      "c3",
      "c4",
      "lock",
    ]);
    expect(data.playerSpawn).toEqual(rooms[0].plan.spawn!);
    expect(data.exit).toEqual(rooms[5].plan.exit!);
    // Prefixed ids.
    expect(data.doors.map((d) => d.id)).toEqual(["lab.door_a"]);
    expect(data.buttons.map((b) => b.target)).toEqual(["lab.door_a"]);
    // One crossing walk per entered module.
    const walks = data.solution.filter((s) => s.do === "walk").length;
    const own = rooms.reduce(
      (n, r) => n + r.plan.solution.filter((s) => s.do === "walk").length,
      0,
    );
    expect(walks).toBe(own + rooms.length - 1);
  });

  test("the level is sealed: no air leaks out, doors open or closed", () => {
    const seed = {
      x: data.playerSpawn.position.x,
      y: 1,
      z: data.playerSpawn.position.z,
    };
    expect(new AirGrid(brushes, seed).leaks).toBe(false);
    expect(new AirGrid([...brushes, ...doorBoxes], seed).leaks).toBe(false);
    // And rays from the spawn hit geometry everywhere.
    const p = data.playerSpawn.position;
    const n = 1500;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const a = i * Math.PI * (3 - Math.sqrt(5));
      const hit = brushes.some((b) =>
        segmentHitsBox(
          p.x,
          p.y + PLAYER.eyeHeight,
          p.z,
          Math.cos(a) * r * 80,
          y * 80,
          Math.sin(a) * r * 80,
          1,
          b,
        ),
      );
      expect(hit).toBe(true);
    }
  });

  test("no two visible faces are coplanar and overlapping", () => {
    const faces = faceCells(data.brushes, levelAir(data));
    const label = (k: number) => `brush #${k} ${data.brushes[k].material}`;
    expect(
      coplanarOverlaps(levelRects(faces, label)).map(describeOverlap),
    ).toEqual([]);
  });

  test("props rest on something and overlap nothing", () => {
    const boxes = data.props.map(propBox);
    boxes.forEach((pb, i) => {
      for (const b of brushes) expect(boxesOverlap(pb, b, 1e-3)).toBe(false);
      const c = data.props[i].position;
      const supported =
        brushes.some(
          (b) =>
            Math.abs(pb.y0 - b.y1) <= 0.01 &&
            c.x >= b.x0 &&
            c.x <= b.x1 &&
            c.z >= b.z0 &&
            c.z <= b.z1,
        ) ||
        boxes.some(
          (o, j) =>
            j !== i &&
            Math.abs(pb.y0 - o.y1) <= 0.01 &&
            c.x >= o.x0 &&
            c.x <= o.x1 &&
            c.z >= o.z0 &&
            c.z <= o.z1,
        );
      expect(supported).toBe(true);
    });
    expect(built.meshes.length).toBeGreaterThan(5);
  });

  test("the joined solution is walkable from the spawn to the exit", () => {
    const solids = data.brushes.map((b) => {
      const box = boxOf(b);
      return isSkirting(b) ? { ...box, y1: SKIRTING_COLLIDER_TOP } : box;
    });
    const problems = verifySolution(data.solution, data.playerSpawn.position, {
      solids,
      floors: brushes,
      props: data.props,
      buttons: data.buttons,
      plates: data.plates.map((p) => boxOf(p.box)),
    });
    expect(problems).toEqual([]);
  });
});

describe("the assembler's checks", () => {
  const plan = (placements: Placement[]): LevelPlan => ({
    ...BASE,
    placements,
  });

  test("footprints may not overlap", () => {
    // Four right turns come back round onto the lab.
    const turn = (name: string, length: number) =>
      corridor(name, { length, bend: "right", leg: 0 });
    expect(() =>
      assembleLevel(
        plan([
          place(LAB, { name: "lab" }),
          corridor("a", { length: 3 }),
          turn("b", 4),
          turn("c", 4),
          turn("d", 8),
          place(EGRESS_LOCK, { name: "lock" }),
        ]),
      ),
    ).toThrow(/placement 4 "d" \(corridor\): footprint overlap with "lab"/);
  });

  test("a doorway the module cannot take is a size mismatch", () => {
    expect(() =>
      assembleLevel(
        plan([
          place(LAB, { name: "lab" }),
          place(STORAGE, { name: "storage" }),
        ]),
      ),
    ).toThrow(/connector size mismatch: the doorway from "lab" is 1.4 x 2.2 m/);
  });

  test("an open end must be covered by the neighbour's wall", () => {
    // The default corridor's exit wall is narrower than the lock's end.
    expect(() =>
      assembleLevel(
        plan([
          place(LAB, { name: "lab" }),
          corridor("c", {}),
          place(EGRESS_LOCK, { name: "lock" }),
        ]),
      ),
    ).toThrow(/the entry's open end is not covered by the exit's wall/);
  });

  test("two open ends cannot meet, and a door needs a wall", () => {
    const c = {
      position: { x: 0, y: 0, z: 0 },
      facing: { x: 1, y: 0, z: 0 },
      width: 1.4,
      height: 2.2,
    };
    const open = { wall: false, extent: { s0: -1, s1: 1, y0: 0, y1: 3 } };
    const wall = { wall: true, extent: { s0: -2, s1: 2, y0: -1, y1: 4 } };
    expect(
      jointProblem({ connector: c, end: open }, { connector: c, end: open }),
    ).toMatch(/two open ends/);
    expect(
      jointProblem(
        { connector: { ...c, door: "d" }, end: open },
        { connector: { ...c, door: "d" }, end: wall },
      ),
    ).toMatch(/no wall of its own/);
    expect(
      jointProblem({ connector: c, end: wall }, { connector: c, end: open }),
    ).toBeNull();
  });

  test("ids must be unique", () => {
    expect(() =>
      assembleLevel(
        plan([
          place(LAB, { name: "lab" }),
          corridor("c", { width: 2.6 }),
          place(FILTRATION_HALL, { name: "hall1", prefix: "" }),
          place(FILTRATION_HALL, { name: "hall2", prefix: "" }),
        ]),
      ),
    ).toThrow(/placement 3 "hall2" .*duplicate id "door_t"/);
  });

  test("a module may not build outside its footprint", () => {
    const leaky: RoomModule = {
      ...CORRIDOR,
      name: "leaky",
      defaults: {},
      random: () => ({}),
      build: (ctx, at) => {
        const plan = CORRIDOR.build(ctx, at, CORRIDOR.defaults);
        ctx.box({ x: 50, y: 0, z: 50 }, { x: 51, y: 1, z: 51 }, "metal_panel");
        return plan;
      },
    };
    expect(() =>
      assembleLevel(
        plan([place(LAB, { name: "lab" }), place(leaky, { name: "x" })]),
      ),
    ).toThrow(/"x" \(leaky\): emits outside its footprint: brush/);
  });

  test("every exit must lead somewhere, and the chain must start and finish", () => {
    expect(() =>
      assembleLevel(plan([place(LAB, { name: "lab" }), corridor("c", {})])),
    ).toThrow(/no finish module/);
    expect(() => assembleLevel(plan([corridor("c", {})]))).toThrow(
      /the first placement must be a start module/,
    );
  });
});

describe("the reference corridor across its parameter range", () => {
  test("random corridors chained in random orientations assemble and seal", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const rng = createRng(seed);
      const placements: Placement[] = [place(LAB, { name: "lab" })];
      for (let i = 0; i < 3; i++) {
        placements.push(
          place(CORRIDOR, {
            name: `c${i}`,
            params: CORRIDOR.random(rng),
            mirror: rng.next() < 0.5,
          }),
        );
      }
      placements.push(
        corridor("wide", { length: 3, width: 3, height: 3, light: "none" }),
        place(EGRESS_LOCK, { name: "lock" }),
      );
      let assembled;
      try {
        assembled = assembleLevel({ ...BASE, placements });
      } catch (error) {
        // Some random chains run back into themselves: that is the
        // generator's to avoid, and the assembler's to report.
        expect(String(error)).toMatch(/footprint overlap/);
        continue;
      }
      const brushes = assembled.data.brushes.map(boxOf);
      const p = assembled.data.playerSpawn.position;
      expect(new AirGrid(brushes, { x: p.x, y: 1, z: p.z }).leaks).toBe(false);
    }
  });

  test("lengths, widths and heights stay in their ranges", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = CORRIDOR.random(createRng(seed));
      expect(p.length).toBeGreaterThanOrEqual(CORRIDOR_RANGES.length[0]);
      expect(p.length).toBeLessThanOrEqual(CORRIDOR_RANGES.length[1]);
      expect(p.width).toBeGreaterThanOrEqual(CORRIDOR_RANGES.width[0]);
      expect(p.width).toBeLessThanOrEqual(CORRIDOR_RANGES.width[1]);
      expect(p.height).toBeGreaterThanOrEqual(CORRIDOR_RANGES.height[0]);
      expect(p.height).toBeLessThanOrEqual(CORRIDOR_RANGES.height[1]);
      expect(p.leg).toBeGreaterThanOrEqual(CORRIDOR_RANGES.leg[0]);
      expect(p.leg).toBeLessThanOrEqual(CORRIDOR_RANGES.leg[1]);
    }
  });
});
