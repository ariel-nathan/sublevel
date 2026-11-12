import { describe, expect, test } from "bun:test";
import { v3 } from "../math";
import { SOUND_IDS } from "../core/api";
import { MATERIAL_IDS } from "../core/materials";
import { PLAYER, PROP_SPECS } from "../core/props";
import { AirGrid } from "./airgrid";
import { coplanarOverlaps, describeOverlap, levelRects } from "./coplanar";
import { BUTTON_DEPTH, DOOR_INSET } from "./define";
import {
  boxesOverlap,
  boxOf,
  BoxIndex,
  containsPoint,
  propBox,
  regionCovered,
  segmentHitsBox,
  type Box,
} from "./geometry";
import {
  buildLevel,
  isSkirting,
  levelAir,
  SKIRTING_COLLIDER_TOP,
} from "./index";
import { faceCells } from "./meshgen";
import { TriangleGrid } from "./raymesh";

const start = performance.now();
const level = buildLevel();
const buildMs = performance.now() - start;
const { data, meshes, colliders } = level;

const brushes = data.brushes.map(boxOf);
const propBoxes = data.props.map(propBox);
const doorBoxes = data.doors.map((d) => boxOf(d.closed));
const brushIndex = new BoxIndex(brushes);

function shifted(b: Box, o: { x: number; y: number; z: number }): Box {
  return {
    x0: b.x0 + o.x,
    x1: b.x1 + o.x,
    y0: b.y0 + o.y,
    y1: b.y1 + o.y,
    z0: b.z0 + o.z,
    z1: b.z1 + o.z,
  };
}

describe("level structure", () => {
  test("brush count is in range and brushes are valid", () => {
    expect(data.brushes.length).toBeGreaterThanOrEqual(150);
    expect(data.brushes.length).toBeLessThanOrEqual(400);
    for (const b of data.brushes) {
      expect(b.min.x).toBeLessThan(b.max.x);
      expect(b.min.y).toBeLessThan(b.max.y);
      expect(b.min.z).toBeLessThan(b.max.z);
      expect(MATERIAL_IDS).toContain(b.material);
    }
  });

  test("one collider per brush; skirting colliders are raised past the step height", () => {
    expect(colliders.length).toBe(data.brushes.length);
    let skirting = 0;
    colliders.forEach((c, i) => {
      const b = data.brushes[i];
      expect(c.min).toEqual(b.min);
      if (isSkirting(b)) {
        skirting++;
        expect(c.max).toEqual({ ...b.max, y: SKIRTING_COLLIDER_TOP });
        expect(SKIRTING_COLLIDER_TOP - b.min.y).toBeGreaterThan(
          PLAYER.stepHeight,
        );
      } else {
        expect(c.max).toEqual(b.max);
      }
    });
    // The lab baseboards and the bench kick plates.
    expect(skirting).toBe(7);
  });

  test("lighting setup", () => {
    expect(data.lights.some((l) => l.flicker === "fluorescent")).toBe(true);
    expect(data.lights.some((l) => l.flicker === "broken")).toBe(true);
    expect(
      data.lights.filter((l) => l.flicker === "none").length,
    ).toBeGreaterThan(5);
    expect(data.ambient.x).toBeGreaterThanOrEqual(0.05);
    expect(data.ambient.x).toBeLessThanOrEqual(0.11);
    expect(data.fog.near).toBeCloseTo(12);
    expect(data.fog.far).toBeCloseTo(40);
  });

  test("sound emitters", () => {
    for (const e of data.emitters) expect(SOUND_IDS).toContain(e.sound);
    expect(
      data.emitters.filter((e) => e.sound === "ambient_drone").length,
    ).toBe(1);
    expect(data.emitters.some((e) => e.sound === "hum_machine")).toBe(true);
    const hum = data.emitters.find((e) => e.sound === "hum_fluorescent");
    const flicker = data.lights.find((l) => l.flicker === "fluorescent");
    expect(hum).toBeDefined();
    expect(flicker).toBeDefined();
    expect(v3.distance(hum!.position, flicker!.position)).toBeLessThan(0.5);
  });

  test("lights hang in open air, at least 0.15 m from every brush", () => {
    for (const l of data.lights) {
      const p = l.position;
      for (const b of brushes) {
        const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
        const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
        const dz = Math.max(b.z0 - p.z, 0, p.z - b.z1);
        expect(Math.hypot(dx, dy, dz)).toBeGreaterThanOrEqual(0.15);
      }
    }
  });
});

describe("doors, buttons and plates", () => {
  test("targets refer to existing doors", () => {
    const ids = new Set(data.doors.map((d) => d.id));
    expect(ids.size).toBe(data.doors.length);
    for (const b of data.buttons) expect(ids.has(b.target)).toBe(true);
    for (const p of data.plates) expect(ids.has(p.target)).toBe(true);
    expect(data.buttons.some((b) => b.target === "door_a")).toBe(true);
    expect(data.plates.some((p) => p.target === "door_b")).toBe(true);
  });

  test("door slabs fill their doorway, recessed in the wall, and slide clear into it", () => {
    for (const door of data.doors) {
      const closed = boxOf(door.closed);
      // The doorway is empty of brushes...
      for (const b of brushes)
        expect(boxesOverlap(closed, b, 1e-4)).toBe(false);
      // ...the slab is thinner than its wall, centred, inset from each face
      // (so its faces never lie in a wall plane)...
      const thin = closed.x1 - closed.x0 < closed.z1 - closed.z0 ? 0 : 2;
      const lo = thin === 0 ? closed.x0 : closed.z0;
      const hi = thin === 0 ? closed.x1 : closed.z1;
      const mid = [
        (closed.x0 + closed.x1) / 2,
        closed.y1 + 0.01,
        (closed.z0 + closed.z1) / 2,
      ];
      const lintel = brushes.find((b) =>
        containsPoint(b, mid[0], mid[1], mid[2]),
      )!;
      expect(lintel).toBeDefined();
      const wall0 = thin === 0 ? lintel.x0 : lintel.z0;
      const wall1 = thin === 0 ? lintel.x1 : lintel.z1;
      expect(lo - wall0).toBeCloseTo(DOOR_INSET, 6);
      expect(wall1 - hi).toBeCloseTo(DOOR_INSET, 6);
      // ...and bounded on the sides and top by brushes (it fits exactly).
      const cx = (closed.x0 + closed.x1) / 2;
      const cy = (closed.y0 + closed.y1) / 2;
      const cz = (closed.z0 + closed.z1) / 2;
      const probes = [
        [closed.x0 - 0.001, cy, cz],
        [closed.x1 + 0.001, cy, cz],
        [cx, cy, closed.z0 - 0.001],
        [cx, cy, closed.z1 + 0.001],
        [cx, closed.y1 + 0.001, cz],
        [cx, closed.y0 - 0.001, cz],
      ];
      // A door in an X-facing wall is bounded in z and y only (and vice versa).
      const alongZ = closed.x1 - closed.x0 < closed.z1 - closed.z0;
      const needed = alongZ
        ? probes.slice(2)
        : [probes[0], probes[1], ...probes.slice(4)];
      for (const [x, y, z] of needed) {
        expect(brushes.some((b) => containsPoint(b, x, y, z))).toBe(true);
      }
      // Opening: it leaves the doorway and lands wholly inside solid wall,
      // past the jamb, so that nothing of it can be seen.
      const open = shifted(closed, door.openOffset);
      expect(boxesOverlap(open, closed, 1e-4)).toBe(false);
      expect(regionCovered(brushIndex, brushes, open)).toBe(true);
      const gap = Math.min(
        Math.abs(open.z1 - closed.z0),
        Math.abs(open.x1 - closed.x0),
        Math.abs(open.z0 - closed.z1),
        Math.abs(open.x0 - closed.x1),
      );
      expect(gap).toBeGreaterThanOrEqual(0.02);
      // Doorway size.
      const width = alongZ ? closed.z1 - closed.z0 : closed.x1 - closed.x0;
      expect(width).toBeGreaterThanOrEqual(1.2);
      expect(closed.y1 - closed.y0).toBeGreaterThanOrEqual(2.2);
    }
  });

  test("buttons are on a wall at about 1.2 m, facing out of it", () => {
    for (const b of data.buttons) {
      expect(b.position.y).toBeGreaterThan(1.0);
      expect(b.position.y).toBeLessThan(1.4);
      expect(v3.length(b.facing)).toBeCloseTo(1);
      // The wall surface is exactly BUTTON_DEPTH behind the button face, and
      // nothing of the level occupies the space of the button unit (the world
      // objects own all of its geometry).
      const behind = v3.addScaled(b.position, b.facing, -BUTTON_DEPTH - 0.001);
      expect(
        brushes.some((x) => containsPoint(x, behind.x, behind.y, behind.z)),
      ).toBe(true);
      const f = b.facing;
      const unit: Box = {
        x0: b.position.x - (f.x !== 0 ? 0 : 0.15),
        x1: b.position.x + (f.x !== 0 ? 0 : 0.15),
        y0: b.position.y - 0.15,
        y1: b.position.y + 0.15,
        z0: b.position.z - (f.z !== 0 ? 0 : 0.15),
        z1: b.position.z + (f.z !== 0 ? 0 : 0.15),
      };
      const wallward = v3.addScaled(b.position, f, -BUTTON_DEPTH + 0.0005);
      const span: Box = {
        x0: Math.min(unit.x0, wallward.x),
        x1: Math.max(unit.x1, wallward.x),
        y0: unit.y0,
        y1: unit.y1,
        z0: Math.min(unit.z0, wallward.z),
        z1: Math.max(unit.z1, wallward.z),
      };
      for (const x of brushes) expect(boxesOverlap(span, x, 1e-6)).toBe(false);
      // Open air in front.
      const front = v3.addScaled(b.position, b.facing, 0.3);
      expect(
        brushes.some((x) => containsPoint(x, front.x, front.y, front.z)),
      ).toBe(false);
    }
  });

  test("plate puzzle geometry", () => {
    const plate = data.plates[0];
    const pb = boxOf(plate.box);
    expect(plate.requiredMass).toBe(45);
    expect(pb.x1 - pb.x0).toBeCloseTo(1.2);
    expect(pb.z1 - pb.z0).toBeCloseTo(1.2);
    expect(pb.y1 - pb.y0).toBeCloseTo(0.04);
    for (const b of brushes) expect(boxesOverlap(pb, b, 1e-4)).toBe(false);
    const doorB = data.doors.find((d) => d.id === "door_b")!;
    const pc = { x: (pb.x0 + pb.x1) / 2, z: (pb.z0 + pb.z1) / 2 };
    const dc = {
      x: (doorB.closed.min.x + doorB.closed.max.x) / 2,
      z: (doorB.closed.min.z + doorB.closed.max.z) / 2,
    };
    const gap = Math.hypot(pc.x - dc.x, pc.z - dc.z);
    expect(gap).toBeGreaterThanOrEqual(4);
    expect(gap).toBeLessThanOrEqual(6);
    // Exactly one metal crate, 3 to 5 m from the plate, plus wooden crates.
    const metal = data.props.filter((p) => p.kind === "crate_metal");
    expect(metal.length).toBe(1);
    const mc = metal[0].position;
    const dist = Math.hypot(mc.x - pc.x, mc.z - pc.z);
    expect(dist).toBeGreaterThanOrEqual(3);
    expect(dist).toBeLessThanOrEqual(5);
    expect(PROP_SPECS.crate_metal.mass).toBeGreaterThan(PLAYER.maxCarryMass);
    expect(PROP_SPECS.crate_metal.mass).toBeGreaterThanOrEqual(
      plate.requiredMass,
    );
    const woods = data.props.filter((p) => p.kind === "crate_wood");
    expect(woods.length * PROP_SPECS.crate_wood.mass).toBeGreaterThanOrEqual(
      plate.requiredMass,
    );
  });

  test("the metal crate has a clear straight push path to the plate", () => {
    const plate = boxOf(data.plates[0].box);
    const pcx = (plate.x0 + plate.x1) / 2;
    const pcz = (plate.z0 + plate.z1) / 2;
    const idx = data.props.findIndex((p) => p.kind === "crate_metal");
    const from = data.props[idx].position;
    const h = PROP_SPECS.crate_metal.halfExtents;
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (pcx - from.x) * t;
      const z = from.z + (pcz - from.z) * t;
      const swept: Box = {
        x0: x - h.x,
        x1: x + h.x,
        y0: 0.005,
        y1: 2 * h.y,
        z0: z - h.z,
        z1: z + h.z,
      };
      for (const b of brushes) expect(boxesOverlap(swept, b, 1e-4)).toBe(false);
      propBoxes.forEach((pb, j) => {
        if (j !== idx) expect(boxesOverlap(swept, pb, 1e-4)).toBe(false);
      });
    }
  });

  test("the mezzanine is too high to jump onto and carries crates", () => {
    const tops = brushes.filter(
      (b) =>
        Math.abs(b.y1 - 1.4) < 1e-6 &&
        (b.x1 - b.x0) * (b.z1 - b.z0) > 4 &&
        b.x0 > 5 &&
        b.z0 > 13,
    );
    expect(tops.length).toBeGreaterThan(0);
    expect(1.4).toBeGreaterThan(PLAYER.jumpHeight);
    const top = tops[0];
    const onTop = data.props.filter((p) => {
      const b = propBox(p);
      return Math.abs(b.y0 - 1.4) < 0.01 && b.x0 >= top.x0 && b.x1 <= top.x1;
    });
    expect(onTop.map((p) => p.kind).sort()).toEqual([
      "crate_weak",
      "crate_wood",
      "crate_wood",
    ]);
    // Reachable by stacking: a crate plus a jump clears it.
    expect(
      2 * PROP_SPECS.crate_wood.halfExtents.y + PLAYER.jumpHeight,
    ).toBeGreaterThan(1.4);
  });
});

describe("props", () => {
  test("prop inventory", () => {
    const count = (k: string) => data.props.filter((p) => p.kind === k).length;
    expect(count("monitor")).toBeGreaterThanOrEqual(2);
    expect(count("chair")).toBe(2);
    expect(count("barrel")).toBeGreaterThanOrEqual(2);
    expect(count("crate_weak")).toBeGreaterThanOrEqual(2);
    expect(count("crate_wood_small")).toBeGreaterThanOrEqual(3);
  });

  test("no prop overlaps a brush, a door, a plate or another prop", () => {
    const plate = data.plates.map((p) => boxOf(p.box));
    propBoxes.forEach((pb, i) => {
      for (const b of brushes) expect(boxesOverlap(pb, b, 1e-3)).toBe(false);
      for (const d of doorBoxes) expect(boxesOverlap(pb, d, 1e-3)).toBe(false);
      data.doors.forEach((d, k) => {
        expect(
          boxesOverlap(pb, shifted(doorBoxes[k], d.openOffset), 1e-3),
        ).toBe(false);
      });
      for (const p of plate) expect(boxesOverlap(pb, p, 1e-3)).toBe(false);
      for (let j = i + 1; j < propBoxes.length; j++) {
        expect(boxesOverlap(pb, propBoxes[j], 1e-3)).toBe(false);
      }
    });
  });

  test("every prop rests on a brush top or another prop", () => {
    propBoxes.forEach((pb, i) => {
      const cx = data.props[i].position.x;
      const cz = data.props[i].position.z;
      const onBrush = brushes.some(
        (b) =>
          Math.abs(pb.y0 - b.y1) <= 0.01 &&
          cx >= b.x0 &&
          cx <= b.x1 &&
          cz >= b.z0 &&
          cz <= b.z1,
      );
      const onProp = propBoxes.some(
        (o, j) =>
          j !== i &&
          Math.abs(pb.y0 - o.y1) <= 0.01 &&
          cx >= o.x0 &&
          cx <= o.x1 &&
          cz >= o.z0 &&
          cz <= o.z1,
      );
      expect(onBrush || onProp).toBe(true);
    });
  });
});

describe("spawn and sealing", () => {
  test("spawn stands on the lab floor with full clearance", () => {
    const p = data.playerSpawn.position;
    expect(p.x).toBeGreaterThan(-4);
    expect(p.x).toBeLessThan(4);
    expect(p.z).toBeGreaterThan(-3);
    expect(p.z).toBeLessThan(3);
    const floor = brushes.find(
      (b) =>
        Math.abs(b.y1 - p.y) < 1e-6 &&
        p.x >= b.x0 &&
        p.x <= b.x1 &&
        p.z >= b.z0 &&
        p.z <= b.z1,
    );
    expect(floor).toBeDefined();
    expect(
      data.brushes.find(
        (b) =>
          b.min.x <= p.x &&
          b.max.x >= p.x &&
          b.min.z <= p.z &&
          b.max.z >= p.z &&
          b.max.y === p.y &&
          b.material === "lab_floor_tile",
      ),
    ).toBeDefined();
    const body: Box = {
      x0: p.x - PLAYER.halfWidth,
      x1: p.x + PLAYER.halfWidth,
      y0: p.y,
      y1: p.y + PLAYER.standHeight,
      z0: p.z - PLAYER.halfWidth,
      z1: p.z + PLAYER.halfWidth,
    };
    for (const b of brushes) expect(boxesOverlap(body, b, 1e-4)).toBe(false);
    for (const b of propBoxes) expect(boxesOverlap(body, b, 1e-4)).toBe(false);
  });

  test("the level is sealed: rays from the spawn always hit geometry", () => {
    const p = data.playerSpawn.position;
    const ox = p.x;
    const oy = p.y + PLAYER.eyeHeight;
    const oz = p.z;
    const solids = [...brushes, ...doorBoxes];
    const n = 3000;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const a = i * Math.PI * (3 - Math.sqrt(5));
      const dx = Math.cos(a) * r;
      const dz = Math.sin(a) * r;
      const hit = solids.some((b) =>
        segmentHitsBox(ox, oy, oz, dx * 60, y * 60, dz * 60, 1, b),
      );
      expect(hit).toBe(true);
    }
  });

  test("no air path leads out of the world (voxel flood fill, closed doors solid)", () => {
    const p = data.playerSpawn.position;
    const seed = { x: p.x, y: p.y + 1, z: p.z };
    const closed = new AirGrid([...brushes, ...doorBoxes], seed);
    expect(closed.leaks).toBe(false);
    const open = new AirGrid(brushes, seed);
    expect(open.leaks).toBe(false);
    // Door B closed cuts the alcove off; open it and the air grows.
    expect(open.reachedCount).toBeGreaterThan(closed.reachedCount);
    expect(open.reachable(14.8, 1.5, 12)).toBe(true);
    expect(closed.reachable(14.8, 1.5, 12)).toBe(false);
  });

  test("walls, floors and ceilings are at least 0.2 m thick", () => {
    const shell = [
      "lab_wall",
      "concrete_wall",
      "lab_floor_tile",
      "concrete_floor",
      "ceiling_panel",
    ];
    for (const b of data.brushes) {
      if (!shell.includes(b.material)) continue;
      const thin = Math.min(
        b.max.x - b.min.x,
        b.max.y - b.min.y,
        b.max.z - b.min.z,
      );
      expect(thin).toBeGreaterThanOrEqual(0.2 - 1e-9);
    }
  });
});

describe("walkability", () => {
  const cell = 0.25;
  function flood(half: number, height: number): Set<string> {
    const free = (ix: number, iz: number): boolean => {
      const x = ix * cell;
      const z = iz * cell;
      const body: Box = {
        x0: x - half,
        x1: x + half,
        y0: PLAYER.stepHeight + 0.01,
        y1: height,
        z0: z - half,
        z1: z + half,
      };
      return !brushes.some((b) => boxesOverlap(body, b, 1e-6));
    };
    const spawn = data.playerSpawn.position;
    const sx = Math.round(spawn.x / cell);
    const sz = Math.round(spawn.z / cell);
    const seen = new Set<string>([`${sx},${sz}`]);
    const queue: [number, number][] = [[sx, sz]];
    while (queue.length > 0) {
      const [ix, iz] = queue.pop()!;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = ix + dx;
        const nz = iz + dz;
        const key = `${nx},${nz}`;
        if (nx < -30 || nx > 80 || nz < -30 || nz > 80 || seen.has(key))
          continue;
        if (!free(nx, nz)) continue;
        seen.add(key);
        queue.push([nx, nz]);
      }
    }
    return seen;
  }
  const reaches = (set: Set<string>, x: number, z: number) =>
    set.has(`${Math.round(x / cell)},${Math.round(z / cell)}`);

  const checkpoints: [string, number, number][] = [
    ["lab centre", 0, -1.5],
    ["lab by door button", 3, 1.2],
    ["door A", 4.15, 0],
    ["corridor start", 5.5, 0],
    ["corridor bend", 9.5, 0],
    ["corridor end", 9.5, 7],
    ["storage entry", 9.5, 9],
    ["pressure plate", 8.5, 12],
    ["storage far corner", 12.5, 13],
    ["door B", 13.65, 12],
    ["exit alcove", 14.75, 12],
  ];

  test("player-sized walk from the spawn reaches every room", () => {
    const set = flood(PLAYER.halfWidth, PLAYER.standHeight);
    for (const [name, x, z] of checkpoints) {
      expect([name, reaches(set, x, z)]).toEqual([name, true]);
    }
  });

  test("passages are at least 1.2 m wide and 2.2 m tall", () => {
    const set = flood(0.6, 2.2);
    for (const [name, x, z] of checkpoints) {
      expect([name, reaches(set, x, z)]).toEqual([name, true]);
    }
  });

  test("furniture leaves 1.0 m walkways between rooms and to the plate", () => {
    const set = flood(0.5, PLAYER.standHeight);
    for (const [name, x, z] of checkpoints) {
      expect([name, reaches(set, x, z)]).toEqual([name, true]);
    }
  });

  test("the mezzanine cannot be walked onto", () => {
    const set = flood(PLAYER.halfWidth, PLAYER.standHeight);
    expect(reaches(set, 7, 15)).toBe(false);
  });
});

describe("meshes", () => {
  test("one valid mesh per material, with colours", () => {
    const seen = new Set<string>();
    for (const m of meshes) {
      expect(MATERIAL_IDS).toContain(m.material);
      expect(seen.has(m.material)).toBe(false);
      seen.add(m.material);
      const n = m.positions.length / 3;
      expect(n).toBeGreaterThan(0);
      expect(m.normals.length).toBe(n * 3);
      expect(m.uvs.length).toBe(n * 2);
      expect(m.colors).toBeDefined();
      expect(m.colors!.length).toBe(n * 3);
      expect(m.indices.length % 3).toBe(0);
      for (const i of m.indices) expect(i).toBeLessThan(n);
      for (let i = 0; i < n; i++) {
        expect(
          Math.hypot(
            m.normals[i * 3],
            m.normals[i * 3 + 1],
            m.normals[i * 3 + 2],
          ),
        ).toBeCloseTo(1, 5);
      }
      for (const a of [m.positions, m.normals, m.uvs, m.colors!]) {
        for (const x of a) expect(Number.isFinite(x)).toBe(true);
      }
      for (const c of m.colors!) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(2);
      }
    }
  });

  test("triangles wind counter-clockwise around their normals", () => {
    for (const m of meshes) {
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const p = (i: number) =>
          v3.create(
            m.positions[i * 3],
            m.positions[i * 3 + 1],
            m.positions[i * 3 + 2],
          );
        const face = v3.normalize(
          v3.cross(v3.sub(p(b), p(a)), v3.sub(p(c), p(a))),
        );
        const n = v3.create(
          m.normals[a * 3],
          m.normals[a * 3 + 1],
          m.normals[a * 3 + 2],
        );
        expect(v3.dot(face, n)).toBeGreaterThan(0.99);
      }
    }
  });

  test("tessellation, UVs and colours are world-aligned and consistent", () => {
    const byKey = new Map<string, string>();
    for (const m of meshes) {
      for (let i = 0; i < m.positions.length / 3; i++) {
        const x = m.positions[i * 3];
        const y = m.positions[i * 3 + 1];
        const z = m.positions[i * 3 + 2];
        const key = [
          m.material,
          x,
          y,
          z,
          m.normals[i * 3],
          m.normals[i * 3 + 1],
          m.normals[i * 3 + 2],
        ]
          .map((q) => (typeof q === "number" ? q.toFixed(5) : q))
          .join("|");
        const value = [
          ...m.uvs.subarray(i * 2, i * 2 + 2),
          ...m.colors!.subarray(i * 3, i * 3 + 3),
        ]
          .map((q) => q.toFixed(5))
          .join("|");
        const prev = byKey.get(key);
        if (prev !== undefined) expect(prev).toBe(value);
        byKey.set(key, value);
      }
    }
    // Floors: u follows x and v follows z, in units of the tile size.
    const floor = meshes.find((m) => m.material === "concrete_floor")!;
    for (let i = 0; i < floor.positions.length / 3; i++) {
      if (floor.normals[i * 3 + 1] < 0.9) continue;
      expect(floor.uvs[i * 2] * 2).toBeCloseTo(floor.positions[i * 3], 4);
      expect(floor.uvs[i * 2 + 1] * 2).toBeCloseTo(
        floor.positions[i * 3 + 2],
        4,
      );
    }
  });

  test("hidden faces are culled and the triangle count is reasonable", () => {
    // Nothing is drawn on the outside of the lab's west wall (x < -4).
    for (const m of meshes) {
      for (let i = 0; i < m.positions.length / 3; i++) {
        expect(m.positions[i * 3]).toBeGreaterThanOrEqual(-4 - 1e-4);
      }
    }
    let tris = 0;
    for (const m of meshes) tris += m.indices.length / 3;
    expect(tris).toBeLessThan(60000);
    console.log(
      `level: ${data.brushes.length} brushes, ${tris} triangles, build ${buildMs.toFixed(0)} ms`,
    );
  });

  test("emissive faces are full bright, lit faces pick up light", () => {
    const panel = meshes.find((m) => m.material === "light_panel")!;
    for (const c of panel.colors!) expect(c).toBe(1);
    const floor = meshes.find((m) => m.material === "lab_floor_tile")!;
    let max = 0;
    for (const c of floor.colors!) max = Math.max(max, c);
    expect(max).toBeGreaterThan(0.3);
  });

  test("buildLevel is deterministic and fast", () => {
    expect(buildMs).toBeLessThan(5000);
    const again = buildLevel();
    expect(again.data).toEqual(data);
    expect(again.meshes.length).toBe(meshes.length);
    again.meshes.forEach((m, i) => {
      expect(m.material).toBe(meshes[i].material);
      expect(
        Buffer.from(m.positions.buffer).equals(
          Buffer.from(meshes[i].positions.buffer),
        ),
      ).toBe(true);
      expect(
        Buffer.from(m.colors!.buffer).equals(
          Buffer.from(meshes[i].colors!.buffer),
        ),
      ).toBe(true);
      expect(
        Buffer.from(m.indices.buffer).equals(
          Buffer.from(meshes[i].indices.buffer),
        ),
      ).toBe(true);
    });
  });
});

describe("visible geometry", () => {
  const air = levelAir(data);
  const faces = faceCells(data.brushes, air);

  test("no two level faces share a plane, a facing and an area (z-fighting)", () => {
    const label = (n: number) => `brush #${n} ${data.brushes[n].material}`;
    const overlaps = coplanarOverlaps(levelRects(faces, label));
    expect(overlaps.map(describeOverlap)).toEqual([]);
  });

  test("an open door slab is hidden inside solid wall all the way along", () => {
    for (const door of data.doors) {
      const closed = boxOf(door.closed);
      // Every position from just past the jamb to fully open is in the wall.
      const length = v3.length(door.openOffset);
      const dir = v3.scale(door.openOffset, 1 / length);
      const size = v3.sub(door.closed.max, door.closed.min);
      const width = Math.abs(v3.dot(size, dir));
      for (let t = width; t <= length + 1e-9; t += 0.05) {
        const at = shifted(closed, v3.scale(dir, Math.min(t, length)));
        const inWall = regionCovered(brushIndex, brushes, at);
        expect([door.id, t, inWall]).toEqual([door.id, t, true]);
      }
    }
  });

  test("door volumes keep the jambs, lintel and sill around a recessed slab", () => {
    for (const door of data.doors) {
      const c = boxOf(door.closed);
      const alongZ = c.x1 - c.x0 < c.z1 - c.z0;
      // A point in each reveal, between the slab and the wall face.
      const reveal = alongZ
        ? [c.x0 - 0.03, c.x1 + 0.03]
        : [c.z0 - 0.03, c.z1 + 0.03];
      for (const r of reveal) {
        const y = (c.y0 + c.y1) / 2;
        const p = alongZ
          ? [r, y, (c.z0 + c.z1) / 2]
          : [(c.x0 + c.x1) / 2, y, r];
        expect(air.reachable(p[0], p[1], p[2])).toBe(true);
      }
    }
  });

  test("sealed from the inside: rays from reachable air first hit a front face of the emitted mesh", () => {
    const grid = new TriangleGrid(meshes);
    // Sample points: a lattice over the level at floor, crouch, eye and
    // jump height (and above the mezzanine), kept where the point is in air
    // connected to the spawn and clear of every brush; plus points in each
    // doorway (doors open) and its reveals, and in the alcove.
    const points: number[][] = [];
    const clear = (x: number, y: number, z: number): boolean => {
      const probe: Box = {
        x0: x - 0.04,
        x1: x + 0.04,
        y0: y - 0.04,
        y1: y + 0.04,
        z0: z - 0.04,
        z1: z + 0.04,
      };
      return (
        air.reachable(x, y, z) && brushIndex.overlapping(probe).length === 0
      );
    };
    for (let x = -3.987; x < 16; x += 0.45) {
      for (let z = -2.991; z < 16.3; z += 0.45) {
        for (const y of [0.12, 0.9, 1.6, 2.1, 2.9, 3.6]) {
          if (clear(x, y, z)) points.push([x, y, z]);
        }
      }
    }
    for (const door of data.doors) {
      const c = boxOf(door.closed);
      const alongZ = c.x1 - c.x0 < c.z1 - c.z0;
      const across = alongZ
        ? [c.x0 - 0.035, (c.x0 + c.x1) / 2, c.x1 + 0.035]
        : [c.z0 - 0.035, (c.z0 + c.z1) / 2, c.z1 + 0.035];
      for (const y of [0.15, 1.1, 2.0]) {
        for (const s of [0.1, 0.5, 0.9]) {
          for (const a of across) {
            const along = alongZ
              ? c.z0 + (c.z1 - c.z0) * s
              : c.x0 + (c.x1 - c.x0) * s;
            points.push(alongZ ? [a, y, along] : [along, y, a]);
          }
        }
      }
    }
    for (const [x, z] of [
      [14.2, 11.4],
      [15.4, 12.6],
      [14.8, 12],
    ]) {
      for (const y of [0.2, 1.5, 2.7]) points.push([x, y, z]);
    }
    expect(points.length).toBeGreaterThan(1500);

    const rays = 64;
    const failures: string[] = [];
    let cast = 0;
    const fmt = (p: readonly number[]) =>
      `(${p.map((q) => q.toFixed(2)).join(", ")})`;
    points.forEach((o, n) => {
      const spin = n * 0.7548776662;
      for (let i = 0; i < rays; i++) {
        const y = 1 - (2 * (i + 0.5)) / rays;
        const r = Math.sqrt(1 - y * y);
        const a = i * Math.PI * (3 - Math.sqrt(5)) + spin;
        const d = [Math.cos(a) * r, y, Math.sin(a) * r];
        const hit = grid.cast(o, d, 60);
        cast++;
        if (!hit || !hit.front) {
          const what = hit
            ? `back of ${hit.material} at ${hit.t.toFixed(2)} m`
            : "nothing";
          failures.push(`from ${fmt(o)} towards ${fmt(d)}: ${what}`);
        }
      }
    });
    expect(cast).toBeGreaterThan(90000);
    expect(failures.slice(0, 20)).toEqual([]);
    expect(failures.length).toBe(0);
  });
});
