import { describe, expect, test } from "bun:test";
import { v3 } from "../math";
import { SOUND_IDS } from "../core/api";
import { MATERIAL_IDS, MATERIALS } from "../core/materials";
import { PLAYER, PROP_SPECS } from "../core/props";
import { AirGrid } from "./airgrid";
import { LightBaker, SEE_THROUGH_OPACITY } from "./bake";
import { coplanarOverlaps, describeOverlap, levelRects } from "./coplanar";
import { assembleKestrelAnnex } from "./define";
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
import {
  faceCells,
  forEachVisibleCell,
  isSeeThrough,
  SEE_THROUGH_MATERIALS,
} from "./meshgen";
import { TriangleGrid } from "./raymesh";
import { describeEgressLock } from "./rooms/egress-lock";
import { describeFiltrationHall } from "./rooms/filtration-hall";
import {
  BUTTON_DEPTH,
  DOOR_INSET,
  GRATE_THICKNESS,
  IMPACT_BUTTON_DEPTH,
} from "./rooms/room";
import { PIT } from "./rooms/service-corridor";
import { describeValveChamber } from "./rooms/valve-chamber";

const start = performance.now();
const level = buildLevel();
const buildMs = performance.now() - start;
const { data, meshes, colliders } = level;

const brushes = data.brushes.map(boxOf);
const propBoxes = data.props.map(propBox);
const doorBoxes = data.doors.map((d) => boxOf(d.closed));
const brushIndex = new BoxIndex(brushes);
// Facts of the second puzzle space, from the modules placed in the annex.
const ROOMS = assembleKestrelAnnex().rooms;
const placedAt = (name: string) => ROOMS.find((r) => r.name === name)!.at;
const HALL = {
  ...describeFiltrationHall(placedAt("hall")),
  ...describeValveChamber(placedAt("chamber")),
  lock: describeEgressLock(placedAt("lock")),
};

/** Run speed of the player (src/player/tuning.ts RUN_SPEED). */
const RUN_SPEED = 5.6;
/** Sliding door kinematics (src/props/doors.ts): cruise speed and acceleration. */
const DOOR_SPEED = 1.6;
const DOOR_ACCEL = 8;

/** Cell size of the walkability flood fill. */
const CELL = 0.25;

/**
 * Cells (keys "ix,iz") a standing box of the given half-width and height can
 * walk to from the spawn, ignoring props, with `extra` boxes as obstacles
 * (for example closed door slabs).
 */
function walkFlood(
  half: number,
  height: number,
  extra: Box[] = [],
): Set<string> {
  const index = new BoxIndex([...brushes, ...extra]);
  const free = (ix: number, iz: number): boolean => {
    const x = ix * CELL;
    const z = iz * CELL;
    return (
      index.overlapping({
        x0: x - half,
        x1: x + half,
        y0: PLAYER.stepHeight + 0.01,
        y1: height,
        z0: z - half,
        z1: z + half,
      }).length === 0
    );
  };
  const spawn = data.playerSpawn.position;
  const sx = Math.round(spawn.x / CELL);
  const sz = Math.round(spawn.z / CELL);
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
      if (nx < -30 || nx > 160 || nz < -40 || nz > 80 || seen.has(key))
        continue;
      if (!free(nx, nz)) continue;
      seen.add(key);
      queue.push([nx, nz]);
    }
  }
  return seen;
}

const cellsOf = (set: Set<string>): [number, number][] =>
  [...set].map((k) => {
    const [i, j] = k.split(",").map(Number);
    return [i * CELL, j * CELL];
  });

const reaches = (set: Set<string>, x: number, z: number): boolean =>
  set.has(`${Math.round(x / CELL)},${Math.round(z / CELL)}`);

/** Player-sized walk with every door open (doors are not brushes). */
const WALK = walkFlood(PLAYER.halfWidth, PLAYER.standHeight);

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

  test("buttons are on a wall at about 1.2 m (targets high up), facing out of it", () => {
    for (const b of data.buttons) {
      const impact = b.mode === "impact";
      if (impact) {
        expect(b.position.y).toBeGreaterThan(3.5);
      } else {
        expect(b.position.y).toBeGreaterThan(1.0);
        expect(b.position.y).toBeLessThan(1.4);
      }
      expect(v3.length(b.facing)).toBeCloseTo(1);
      // The wall surface is exactly the unit's depth behind the button face,
      // and nothing of the level occupies the space of the button unit (the
      // world objects own all of its geometry).
      const depth = impact ? IMPACT_BUTTON_DEPTH : BUTTON_DEPTH;
      const halfSize = impact ? 0.17 : 0.15;
      const behind = v3.addScaled(b.position, b.facing, -depth - 0.001);
      expect(
        brushes.some((x) => containsPoint(x, behind.x, behind.y, behind.z)),
      ).toBe(true);
      const f = b.facing;
      const unit: Box = {
        x0: b.position.x - (f.x !== 0 ? 0 : halfSize),
        x1: b.position.x + (f.x !== 0 ? 0 : halfSize),
        y0: b.position.y - halfSize,
        y1: b.position.y + halfSize,
        z0: b.position.z - (f.z !== 0 ? 0 : halfSize),
        z1: b.position.z + (f.z !== 0 ? 0 : halfSize),
      };
      const wallward = v3.addScaled(b.position, f, -depth + 0.0005);
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
    expect(count("chair")).toBeGreaterThanOrEqual(2);
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
    // Door B closed cuts the hall off; open it and the air grows.
    expect(open.reachedCount).toBeGreaterThan(closed.reachedCount);
    expect(open.reachable(14.8, 1.5, 12)).toBe(true);
    expect(closed.reachable(14.8, 1.5, 12)).toBe(false);
    const e = data.exit;
    const ex = (e.min.x + e.max.x) / 2;
    const ez = (e.min.z + e.max.z) / 2;
    expect(open.reachable(ex, 1.5, ez)).toBe(true);
    expect(closed.reachable(ex, 1.5, ez)).toBe(false);
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
  const flood = walkFlood;
  const checkpoints: [string, number, number][] = [
    ["lab centre", 0, -1.5],
    ["lab by door button", 3, 1.2],
    ["door A", 4.15, 0],
    ["corridor start", 5.5, 0],
    ["corridor bend", 9.5, 0],
    ["corridor grate", 9.5, 4],
    ["corridor end", 9.5, 7],
    ["storage entry", 9.5, 9],
    ["pressure plate", 8.5, 12],
    ["storage far corner", 12.5, 13],
    ["door B", 13.65, 12],
    ["hall entry", 14.75, 12],
    ["hall lane entrance", 14.85, 10.4],
    ["hall lane by door T", 24.6, 9.9],
    ["hall timed button", 23.8, 13],
    ["hall by the vessels", 19.5, 12.8],
    ["door T", 25.25, 9.9],
    ["chamber", 28.5, 9.8],
    ["chamber under the target", 30.9, 9.8],
    ["exit door", 31.65, 9.8],
    ["egress lock", 33.7, 9.8],
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
    for (let x = -3.987; x < 35; x += 0.45) {
      for (let z = -2.991; z < 16.3; z += 0.45) {
        for (const y of [0.12, 0.9, 1.6, 2.1, 2.9, 3.6, 4.35]) {
          if (clear(x, y, z)) points.push([x, y, z]);
        }
      }
    }
    // Through the screen's slot, and right against the screen.
    for (let x = 15.95; x < 25; x += 0.6) {
      for (const z of [10.85, 11.05]) {
        for (const y of [1.6, 1.9, 2.15]) {
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
      [32.0, 8.6],
      [34.4, 11.0],
      [32.9, 9.8],
    ]) {
      for (const y of [0.2, 1.5, 2.7]) points.push([x, y, z]);
    }
    expect(points.length).toBeGreaterThan(3000);

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

describe("corridor grate and pit", () => {
  const GRATE = data.brushes.findIndex(
    (b) => b.material === "metal_grate" && b.max.x <= 11 && b.max.z <= 8,
  );
  const slab = brushes[GRATE];
  const air = levelAir(data);
  const faces = faceCells(data.brushes, air);
  const opaqueBoxes = brushes.filter((_, i) => !isSeeThrough(data.brushes[i]));
  const opaqueIndex = new BoxIndex(opaqueBoxes);
  const grid = new TriangleGrid(meshes);
  const fmt = (p: readonly number[]) =>
    `(${p.map((q) => q.toFixed(2)).join(", ")})`;
  const clear = (x: number, y: number, z: number): boolean =>
    air.reachable(x, y, z) &&
    brushIndex.overlapping({
      x0: x - 0.04,
      x1: x + 0.04,
      y0: y - 0.04,
      y1: y + 0.04,
      z0: z - 0.04,
      z1: z + 0.04,
    }).length === 0;

  test("the grate is a thin see-through slab flush with the floor over the pit", () => {
    expect(GRATE).toBeGreaterThanOrEqual(0);
    expect(SEE_THROUGH_MATERIALS.has("metal_grate")).toBe(true);
    expect(isSeeThrough(data.brushes[GRATE])).toBe(true);
    expect(slab.y1).toBe(0);
    expect(slab.y1 - slab.y0).toBeCloseTo(GRATE_THICKNESS, 9);
    expect(GRATE_THICKNESS).toBeGreaterThanOrEqual(0.04);
    expect(GRATE_THICKNESS).toBeLessThanOrEqual(0.05);
    // It covers the whole pit opening.
    expect(slab.x0).toBeLessThanOrEqual(PIT.x0);
    expect(slab.x1).toBeGreaterThanOrEqual(PIT.x1);
    expect(slab.z0).toBeLessThanOrEqual(PIT.z0);
    expect(slab.z1).toBeGreaterThanOrEqual(PIT.z1);
    // The pit is 0.9 to 1.2 m deep and open under the grate.
    expect(-PIT.floor).toBeGreaterThanOrEqual(0.9);
    expect(-PIT.floor).toBeLessThanOrEqual(1.2);
    const cx = (PIT.x0 + PIT.x1) / 2;
    const cz = (PIT.z0 + PIT.z1) / 2;
    expect(brushIndex.insideStrict(cx, PIT.floor + 0.05, 4.0)).toBe(false);
    // The pit and the grate itself are visible air, and the pit is sealed:
    // the visible air never reaches the outside, doors open or closed.
    expect(air.reachable(cx, -0.6, cz)).toBe(true);
    expect(air.reachable(cx, -0.02, cz)).toBe(true);
    expect(air.leaks).toBe(false);
    const spawn = data.playerSpawn.position;
    const closed = new AirGrid(
      [...opaqueBoxes, ...doorBoxes],
      { x: spawn.x, y: spawn.y + 1, z: spawn.z },
      0.1,
    );
    expect(closed.leaks).toBe(false);
  });

  test("no gap wider than 1 cm around the slab, and it rests on supports", () => {
    const band = 0.01;
    const sides: Box[] = [
      { ...slab, x0: slab.x0 - band, x1: slab.x0 },
      { ...slab, x0: slab.x1, x1: slab.x1 + band },
      { ...slab, z0: slab.z0 - band, z1: slab.z0 },
      { ...slab, z0: slab.z1, z1: slab.z1 + band },
    ];
    for (const s of sides) {
      expect([
        fmt([s.x0, s.y0, s.z0]),
        regionCovered(opaqueIndex, opaqueBoxes, s),
      ]).toEqual([fmt([s.x0, s.y0, s.z0]), true]);
    }
    // A ledge directly under every edge (5 cm wide, 1 cm deep).
    const under: Box[] = [
      { ...slab, y0: slab.y0 - band, y1: slab.y0, x1: slab.x0 + 0.05 },
      { ...slab, y0: slab.y0 - band, y1: slab.y0, x0: slab.x1 - 0.05 },
      { ...slab, y0: slab.y0 - band, y1: slab.y0, z1: slab.z0 + 0.05 },
      { ...slab, y0: slab.y0 - band, y1: slab.y0, z0: slab.z1 - 0.05 },
    ];
    for (const s of under) {
      expect(regionCovered(opaqueIndex, opaqueBoxes, s)).toBe(true);
    }
    // No brush overlaps the slab.
    brushes.forEach((b, i) => {
      if (i !== GRATE) expect(boxesOverlap(b, slab, 1e-6)).toBe(false);
    });
  });

  test("the slab is drawn on top and underneath; what is under it is drawn", () => {
    const area = (brush: number, face: string): number => {
      let sum = 0;
      for (const f of faces) {
        if (f.brush !== brush || f.basis.face !== face) continue;
        forEachVisibleCell(f, (c) => {
          const a = (f.n + 1) % 3;
          const b = (f.n + 2) % 3;
          sum += Math.abs((c[2][a] - c[0][a]) * (c[2][b] - c[0][b]));
        });
      }
      return sum;
    };
    // Top: the whole slab except under the machine standing on it.
    const full = (slab.x1 - slab.x0) * (slab.z1 - slab.z0);
    expect(area(GRATE, "py")).toBeGreaterThan(full - 0.7);
    // Underside: over the open pit (between the beams).
    expect(area(GRATE, "ny")).toBeGreaterThan(
      (PIT.x1 - PIT.x0) * (PIT.z1 - PIT.z0) - 0.4,
    );
    // The ledges and beams the slab rests on show their tops.
    data.brushes.forEach((b, i) => {
      if (Math.abs(b.max.y - slab.y0) > 1e-9 || i === GRATE) return;
      if (!boxesOverlap({ ...brushes[i], y1: 0 }, slab)) return;
      expect([i, area(i, "py") > 0]).toEqual([i, true]);
    });
  });

  test("standing on and around the grate, every ray through it into the pit ends on a front face", () => {
    const eyes: number[][] = [];
    for (const x of [8.45, 8.9, 9.4, 9.9, 10.25, 10.6]) {
      for (const z of [1.6, 2.2, 2.7, 3.3, 4.0, 4.7, 5.3, 5.9, 6.6]) {
        for (const y of [0.55, 0.85, 1.65]) {
          if (clear(x, y, z)) eyes.push([x, y, z]);
        }
      }
    }
    expect(eyes.length).toBeGreaterThan(100);
    const failures: string[] = [];
    let intoPit = 0;
    for (const o of eyes) {
      for (let x = slab.x0 + 0.03; x < slab.x1; x += 0.17) {
        for (let z = slab.z0 + 0.03; z < slab.z1; z += 0.17) {
          const d = [x - o[0], -o[1], z - o[2]];
          const len = Math.hypot(d[0], d[1], d[2]);
          const dir = d.map((q) => q / len);
          // Seen through the gaps: grate faces are passed through.
          const hit = grid.cast(o, dir, 60, SEE_THROUGH_MATERIALS);
          if (!hit || !hit.front) {
            const what = hit ? `back of ${hit.material}` : "nothing";
            failures.push(`from ${fmt(o)} towards ${fmt(dir)}: ${what}`);
          } else if (hit.t > len) intoPit++;
          // Seen on the bars: the grate itself (or what stands on it).
          const bar = grid.cast(o, dir, 60);
          if (!bar || !bar.front) failures.push(`bar from ${fmt(o)}`);
        }
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
    expect(intoPit).toBeGreaterThan(10000);
  });

  test("sealed from inside the pit and through the grate", () => {
    const points: number[][] = [];
    for (let x = PIT.x0 + 0.07; x < PIT.x1; x += 0.27) {
      for (let z = PIT.z0 + 0.07; z < PIT.z1; z += 0.27) {
        for (const y of [-1.0, -0.65, -0.3, -0.1]) {
          if (clear(x, y, z)) points.push([x, y, z]);
        }
      }
    }
    // And the corridor around the grate, where rays pass through it.
    for (let x = 8.4; x < 10.8; x += 0.3) {
      for (let z = -1.1; z < 7.6; z += 0.3) {
        for (const y of [0.3, 1.2, 2.2]) {
          if (clear(x, y, z)) points.push([x, y, z]);
        }
      }
    }
    expect(points.length).toBeGreaterThan(400);
    const failures: string[] = [];
    const rays = 96;
    points.forEach((o, n) => {
      const spin = n * 0.7548776662;
      for (let i = 0; i < rays; i++) {
        const y = 1 - (2 * (i + 0.5)) / rays;
        const r = Math.sqrt(1 - y * y);
        const a = i * Math.PI * (3 - Math.sqrt(5)) + spin;
        const d = [Math.cos(a) * r, y, Math.sin(a) * r];
        for (const through of [undefined, SEE_THROUGH_MATERIALS]) {
          const hit = grid.cast(o, d, 60, through);
          if (!hit || !hit.front) {
            const what = hit ? `back of ${hit.material}` : "nothing";
            failures.push(
              `from ${fmt(o)} towards ${fmt(d)}${through ? " (through grates)" : ""}: ${what}`,
            );
          }
        }
      }
    });
    expect(failures.slice(0, 20)).toEqual([]);
    expect(failures.length).toBe(0);
  });

  test("footsteps on the grate resolve to the slab, a metal surface", () => {
    for (const [x, z] of [
      [9.3, 4.0],
      [8.35, 2.55],
      [9.3, 3.5],
      [10.0, 4.5],
      [10.75, 5.45],
    ]) {
      // The collider the player stands on: the highest top at or below the
      // feet among those under the point.
      let best = -1;
      colliders.forEach((c, i) => {
        if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) return;
        if (c.max.y > 1e-6) return;
        if (best < 0 || c.max.y > colliders[best].max.y) best = i;
      });
      expect([x, z, best]).toEqual([x, z, GRATE]);
      const b = data.brushes[best];
      expect(b.faces?.py ?? b.material).toBe("metal_grate");
      expect(MATERIALS[b.material].surface).toBe("metal");
      // No other collider top within 3 cm below the grate top.
      colliders.forEach((c, i) => {
        if (i === GRATE) return;
        if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) return;
        if (c.max.y > 1e-6) return;
        expect(c.max.y).toBeLessThan(-0.03);
      });
    }
  });

  test("the pit is lit: dimly through the grate, red near its lamp", () => {
    const pitFloor = meshes
      .filter((m) => m.material === "concrete_floor")
      .flatMap((m) => {
        const out: number[][] = [];
        for (let i = 0; i < m.positions.length / 3; i++) {
          if (Math.abs(m.positions[i * 3 + 1] - PIT.floor) > 1e-6) continue;
          out.push([
            m.positions[i * 3],
            m.positions[i * 3 + 2],
            ...m.colors!.subarray(i * 3, i * 3 + 3),
          ]);
        }
        return out;
      });
    expect(pitFloor.length).toBeGreaterThan(20);
    // Near the lamp the floor is red, far from it no brighter than dim.
    const near = pitFloor.filter(
      (p) => Math.hypot(p[0] - 9.05, p[1] - 5.15) < 0.6,
    );
    expect(near.length).toBeGreaterThan(0);
    for (const p of near) {
      expect(p[2]).toBeGreaterThan(p[3] * 1.5);
      expect(p[2]).toBeLessThan(0.9);
    }
    for (const p of pitFloor)
      expect(Math.max(p[2], p[3], p[4])).toBeLessThan(0.9);
  });
});

describe("light baking through see-through brushes", () => {
  test("a see-through slab passes 1 - SEE_THROUGH_OPACITY of a light", () => {
    const light = {
      position: { x: 0, y: 2, z: 0 },
      color: { x: 1, y: 1, z: 1 },
      radius: 10,
      intensity: 1,
      flicker: "none" as const,
    };
    const ambient = { x: 0, y: 0, z: 0 };
    const slabBox: Box = { x0: -5, x1: 5, y0: -0.05, y1: 0, z0: -5, z1: 5 };
    const open = new LightBaker([], [light], ambient).sample(0, -1, 0, 0, 1, 0);
    const grate = new LightBaker([slabBox], [light], ambient, [true]).sample(
      0,
      -1,
      0,
      0,
      1,
      0,
    );
    const solid = new LightBaker([slabBox], [light], ambient).sample(
      0,
      -1,
      0,
      0,
      1,
      0,
    );
    expect(open[0]).toBeGreaterThan(0.3);
    expect(grate[0]).toBeCloseTo(open[0] * (1 - SEE_THROUGH_OPACITY), 6);
    expect(solid[0]).toBe(0);
    // A point just under the slab (its shadow ray starts inside it) too.
    const under = new LightBaker([slabBox], [light], ambient, [true]).sample(
      0,
      -0.06,
      0,
      0,
      1,
      0,
    );
    const underOpen = new LightBaker([], [light], ambient).sample(
      0,
      -0.06,
      0,
      0,
      1,
      0,
    );
    expect(under[0]).toBeCloseTo(underOpen[0] * (1 - SEE_THROUGH_OPACITY), 6);
  });
});

describe("acoustic zones and light bounds", () => {
  test("every walkable floor cell lies in an acoustic zone", () => {
    const zones = data.zones.map((z) => boxOf(z.box));
    expect(zones.length).toBeGreaterThanOrEqual(7);
    const outside = cellsOf(WALK).filter(
      ([x, z]) => !zones.some((b) => containsPoint(b, x, 0.9, z)),
    );
    expect(outside.slice(0, 10)).toEqual([]);
  });

  test("zones have the right characters", () => {
    const at = (x: number, y: number, z: number) =>
      data.zones
        .filter((zone) => containsPoint(boxOf(zone.box), x, y, z))
        .map((zone) => zone.room);
    expect(at(0, 1.5, 0)).toEqual(["lab"]);
    expect(at(6, 1.5, 0)).toEqual(["corridor"]);
    expect(at(9.5, 1.5, 5)).toEqual(["corridor"]);
    expect(at(9, 1.5, 12)).toEqual(["hall"]);
    expect(at(20, 1.5, 12)).toEqual(["hall"]);
    expect(at(28, 1.5, 10)).toEqual(["small"]);
    expect(at(33.5, 1.5, 10)).toEqual(["small"]);
  });

  test("every dynamic light has bounds, and sits inside them with 0.3 m to spare", () => {
    const dynamic = data.lights.filter((l) => l.flicker !== "none");
    expect(dynamic.length).toBeGreaterThanOrEqual(4);
    for (const l of dynamic) {
      expect(l.bounds).toBeDefined();
      const b = boxOf(l.bounds!);
      const p = l.position;
      const margin = Math.min(
        p.x - b.x0,
        b.x1 - p.x,
        p.y - b.y0,
        b.y1 - p.y,
        p.z - b.z0,
        b.z1 - p.z,
      );
      expect(margin).toBeGreaterThanOrEqual(0.3);
    }
  });

  test("no corridor light's bounds reach under the floor over the pit", () => {
    const corridor = data.lights.filter(
      (l) => l.bounds && l.position.x < 11.1 && l.position.z < 8,
    );
    expect(corridor.length).toBe(2);
    for (const l of corridor) {
      const b = boxOf(l.bounds!);
      const overPit =
        b.x0 < PIT.x1 && b.x1 > PIT.x0 && b.z0 < PIT.z1 && b.z1 > PIT.z0;
      if (overPit) expect(b.y0).toBeGreaterThanOrEqual(-0.05);
    }
  });

  test("a light's bounds end inside the walls of its room (no light in a neighbour room)", () => {
    // Points in the middle of each room: a bounded light reaches only its own.
    const rooms: [string, number, number, number][] = [
      ["lab", 0, 1.5, 0],
      ["storage", 9, 2, 12],
      ["hall", 19, 2, 12.5],
      ["chamber", 28.5, 2, 9.8],
      ["lock", 33.5, 1.5, 9.8],
    ];
    for (const l of data.lights) {
      if (!l.bounds) continue;
      const b = boxOf(l.bounds);
      const inside = rooms.filter(([, x, y, z]) => containsPoint(b, x, y, z));
      expect(inside.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("second puzzle space", () => {
  const buttonById = (id: string) => data.buttons.find((b) => b.id === id)!;
  const doorById = (id: string) => data.doors.find((d) => d.id === id)!;
  const timed = buttonById(HALL.timedButton);
  const inner = buttonById(HALL.innerButton);
  const target = buttonById(HALL.impactButton);
  const doorT = doorById(HALL.timedDoor);
  const exitDoor = doorById(HALL.exitDoor);
  const doorBox = (id: string) => boxOf(doorById(id).closed);

  test("button modes and targets", () => {
    expect(timed.mode).toBe("timed");
    expect(timed.seconds).toBe(HALL.seconds);
    expect(timed.target).toBe(doorT.id);
    expect(inner.mode).toBe("timed");
    expect(inner.target).toBe(doorT.id);
    expect(target.mode).toBe("impact");
    expect(target.target).toBe(exitDoor.id);
    // No other button works door T or the exit door.
    for (const b of data.buttons) {
      if (b.target === doorT.id) expect([timed.id, inner.id]).toContain(b.id);
      if (b.target === exitDoor.id) expect(b.id).toBe(target.id);
    }
    // The timed doorway is wide enough to pass a crate left in it.
    const t = boxOf(doorT.closed);
    expect(t.z1 - t.z0).toBeGreaterThanOrEqual(1.8);
  });

  test("timed door: close as the crow flies, but a sprint round the screen arrives as the gap closes", () => {
    const d = HALL.timedDoorway;
    const straight = Math.hypot(timed.position.x - d.x, timed.position.z - d.z);
    expect(straight).toBeLessThan(3.5);
    // The sprint route is walkable: a player box swept along every leg
    // touches no brush.
    const route = HALL.sprintRoute;
    let length = 0;
    for (let i = 0; i + 1 < route.length; i++) {
      const p = route[i];
      const q = route[i + 1];
      const leg = Math.hypot(q.x - p.x, q.z - p.z);
      length += leg;
      for (let t = 0; t <= 1; t += 0.02) {
        const x = p.x + (q.x - p.x) * t;
        const z = p.z + (q.z - p.z) * t;
        const body: Box = {
          x0: x - PLAYER.halfWidth,
          x1: x + PLAYER.halfWidth,
          y0: PLAYER.stepHeight + 0.01,
          y1: PLAYER.standHeight,
          z0: z - PLAYER.halfWidth,
          z1: z + PLAYER.halfWidth,
        };
        expect(brushIndex.overlapping(body)).toEqual([]);
      }
    }
    // The press spot is within reach of the button.
    const eye = v3.create(
      HALL.pressSpot.x,
      HALL.pressSpot.y + PLAYER.eyeHeight,
      HALL.pressSpot.z,
    );
    expect(v3.distance(eye, timed.position)).toBeLessThan(PLAYER.reach - 0.5);
    // How long the closing slab takes to narrow the doorway below the
    // player's width (it starts DOOR_OVERTRAVEL inside the wall).
    const t = boxOf(doorT.closed);
    const width = t.z1 - t.z0;
    const travel = width + 0.05 - 2 * PLAYER.halfWidth;
    const accelTime = DOOR_SPEED / DOOR_ACCEL;
    const accelDist = (DOOR_SPEED * accelTime) / 2;
    const closing = accelTime + (travel - accelDist) / DOOR_SPEED;
    const sprint = length / RUN_SPEED;
    // A sprint is slower than the countdown...
    expect(sprint).toBeGreaterThan(HALL.seconds + 0.5);
    // ...and only a perfect line squeezes through the closing gap: the
    // ideal run arrives within a quarter second of the deadline.
    expect(Math.abs(sprint - (HALL.seconds + closing))).toBeLessThan(0.25);
    console.log(
      `timed door: straight ${straight.toFixed(2)} m, route ${length.toFixed(2)} m, sprint ${sprint.toFixed(2)} s, countdown ${HALL.seconds} s + closing ${closing.toFixed(2)} s`,
    );
  });

  test("the screen: no way through but round its end; the timed button is out of reach from the lane", () => {
    const screen = boxOf(HALL.screen);
    const lane = boxOf(HALL.lane);
    // Block the lane's entrance: the lane becomes unreachable.
    const gate: Box = {
      x0: lane.x0,
      x1: screen.x0,
      y0: 0,
      y1: 3,
      z0: screen.z0,
      z1: screen.z1,
    };
    const shut = walkFlood(PLAYER.halfWidth, PLAYER.standHeight, [gate]);
    expect(reaches(shut, 23.8, 13)).toBe(true);
    expect(reaches(shut, 24.6, 9.9)).toBe(false);
    expect(reaches(WALK, 24.6, 9.9)).toBe(true);
    // The slot passes any crate (so every hall prop can wedge the door)
    // but not a crouching player, and the screen reaches the ceiling
    // (nothing to climb over).
    const slot = HALL.slot.top - HALL.slot.bottom;
    expect(slot).toBeGreaterThan(
      2 * PROP_SPECS.crate_wood.halfExtents.y + 0.05,
    );
    expect(slot).toBeGreaterThan(
      2 * PROP_SPECS.crate_wood_small.halfExtents.y + 0.3,
    );
    expect(slot).toBeLessThan(PLAYER.crouchHeight - 0.05);
    // Standing on the lower rail, a player does not fit under the upper one.
    expect(HALL.slot.top - HALL.slot.bottom).toBeLessThan(PLAYER.crouchHeight);
    expect(screen.y1).toBeCloseTo(boxOf(HALL.hall).y1, 6);
    // From anywhere in the lane the timed button is beyond reach, even
    // with a jump.
    let nearest = Infinity;
    for (const [x, z] of cellsOf(WALK)) {
      if (!containsPoint(lane, x, 1, z)) continue;
      for (const y of [
        PLAYER.eyeHeight,
        PLAYER.eyeHeight + PLAYER.jumpHeight,
      ]) {
        nearest = Math.min(
          nearest,
          v3.distance(v3.create(x, y, z), timed.position),
        );
      }
    }
    expect(nearest).toBeGreaterThan(PLAYER.reach + 0.1);
  });

  test("a small crate at the wedge spot is in the slab's path and leaves the doorway passable", () => {
    const w = HALL.wedgeSpot;
    const h = PROP_SPECS.crate_wood_small.halfExtents;
    const crate: Box = {
      x0: w.x - h.x,
      x1: w.x + h.x,
      y0: w.y - h.y,
      y1: w.y + h.y,
      z0: w.z - h.z,
      z1: w.z + h.z,
    };
    expect(crate.y0).toBeCloseTo(0, 6);
    expect(brushIndex.overlapping(crate)).toEqual([]);
    const slab = boxOf(doorT.closed);
    expect(boxesOverlap(crate, slab, 0.05)).toBe(true);
    // Pushed against the far jamb by the closing slab, it leaves the rest
    // of the doorway free for the player.
    const free = slab.z1 - slab.z0 - 2 * h.z;
    expect(free).toBeGreaterThan(2 * PLAYER.halfWidth + 0.6);
    // The same holds for a big crate.
    expect(
      slab.z1 - slab.z0 - 2 * PROP_SPECS.crate_wood.halfExtents.z,
    ).toBeGreaterThan(2 * PLAYER.halfWidth + 0.3);
  });

  test("the impact target is out of reach of the use key from anywhere one can stand", () => {
    let nearest = Infinity;
    for (const [x, z] of cellsOf(WALK)) {
      nearest = Math.min(
        nearest,
        v3.distance(v3.create(x, PLAYER.eyeHeight, z), target.position),
      );
    }
    expect(nearest).toBeGreaterThan(PLAYER.reach + 0.1);
  });

  test("the impact target can be hit by a throw from many places in the chamber", () => {
    // Light props leave the hand at 11 m/s along the view plus 1 m/s up
    // (src/player/tuning.ts), from about the eye; props fall at 9.81 m/s2.
    const speed = 11;
    const up = 1;
    const g = 9.81;
    const chamber = boxOf(HALL.chamber);
    const f = target.facing;
    const p = target.position;
    let good = 0;
    for (const [x, z] of cellsOf(WALK)) {
      if (!containsPoint(chamber, x, 1, z)) continue;
      const o = v3.create(x, PLAYER.eyeHeight, z);
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const flat = Math.hypot(dx, dz);
      const dh = p.y - o.y;
      // Lowest pitch whose arc passes the target's height at its distance.
      let hit = false;
      for (let deg = -10; deg <= 70 && !hit; deg += 0.5) {
        const a = (deg * Math.PI) / 180;
        const vx = speed * Math.cos(a);
        const vy = speed * Math.sin(a) + up;
        const t = flat / vx;
        const y = vy * t - (g * t * t) / 2;
        if (Math.abs(y - dh) > 0.1) continue;
        // Approaching the face (not already falling past it from above at
        // a grazing angle), and the arc is clear of brushes.
        const vyAt = vy - g * t;
        const into = (vx * (dx * -f.x + dz * -f.z)) / flat;
        if (into < 4 || vyAt < -6) continue;
        let clear = true;
        for (let k = 1; k < 40 && clear; k++) {
          const s = (t * k) / 40;
          const px = o.x + (dx / flat) * vx * s;
          const pz = o.z + (dz / flat) * vx * s;
          const py = o.y + vy * s - (g * s * s) / 2;
          const r = 0.2;
          clear =
            brushIndex.overlapping({
              x0: px - r,
              x1: px + r,
              y0: py - r,
              y1: py + r,
              z0: pz - r,
              z1: pz + r,
            }).length === 0;
        }
        hit = clear;
      }
      if (hit) good++;
    }
    expect(good).toBeGreaterThan(20);
  });

  test("throwables in the chamber, and nowhere up high for them to stay", () => {
    const chamber = boxOf(HALL.chamber);
    const throwables = data.props.filter(
      (p) =>
        containsPoint(chamber, p.position.x, p.position.y, p.position.z) &&
        PROP_SPECS[p.kind].mass <= PLAYER.maxCarryMass &&
        PROP_SPECS[p.kind].mass * 4 >= 25,
    );
    expect(throwables.length).toBeGreaterThanOrEqual(3);
    expect(
      throwables.filter((p) => p.kind === "crate_wood_small").length,
    ).toBeGreaterThanOrEqual(2);
    // No ledge in the chamber above jump-and-reach height wide enough for a
    // small crate to come to rest on.
    for (const b of brushes) {
      if (!boxesOverlap(b, chamber)) continue;
      if (b.y1 <= 1.3 || b.y1 >= chamber.y1 - 1e-6) continue;
      const wide = Math.min(
        Math.min(b.x1, chamber.x1) - Math.max(b.x0, chamber.x0),
        Math.min(b.z1, chamber.z1) - Math.max(b.z0, chamber.z0),
      );
      expect([b, wide < 0.3]).toEqual([b, true]);
    }
  });

  test("the exit box: in the lock, generous, reachable only through every door", () => {
    const e = boxOf(data.exit);
    expect(e.x1 - e.x0).toBeGreaterThanOrEqual(1.5);
    expect(e.z1 - e.z0).toBeGreaterThanOrEqual(1.5);
    expect(e.y0).toBeLessThanOrEqual(0);
    expect(e.y1).toBeGreaterThanOrEqual(2.5);
    const lock = boxOf(HALL.lock);
    expect(e.x0).toBeGreaterThanOrEqual(lock.x0 + 0.9);
    // Clear floor space (wall signs and the lamp may stand in its edges).
    const body: Box = {
      x0: e.x0 + 0.05,
      x1: e.x1 - 0.05,
      y0: 0.01,
      y1: PLAYER.standHeight,
      z0: e.z0 + 0.05,
      z1: e.z1 - 0.05,
    };
    expect(brushIndex.overlapping(body)).toEqual([]);
    const reachesExit = (set: Set<string>) =>
      cellsOf(set).some(([x, z]) => containsPoint(e, x, 0, z));
    expect(reachesExit(WALK)).toBe(true);
    const slabs = data.doors.map((d) => boxOf(d.closed));
    expect(
      reachesExit(walkFlood(PLAYER.halfWidth, PLAYER.standHeight, slabs)),
    ).toBe(false);
    for (const door of data.doors) {
      const one = walkFlood(PLAYER.halfWidth, PLAYER.standHeight, [
        doorBox(door.id),
      ]);
      expect([door.id, reachesExit(one)]).toEqual([door.id, false]);
    }
  });
});
