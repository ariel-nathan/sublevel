/**
 * What makes each puzzle room a puzzle, and what makes it solvable, checked
 * across its parameter range (defaults and many random sets), plus the
 * module contract again for more random sets than rooms/contract.test.ts
 * runs.
 */
import { describe, expect, test } from "bun:test";
import type { ButtonDef, PropSpawn } from "../../../core/api";
import { PLAYER, PROP_SPECS } from "../../../core/props";
import { createRng } from "../../../core/rng";
import type { Vec3 } from "../../../math";
import { buildRoom, outsideFootprint, type RoomParts } from "../../assemble";
import {
  boxesOverlap,
  boxOf,
  BoxIndex,
  containsPoint,
  propBox,
  type Box,
} from "../../geometry";
import { isSkirting, SKIRTING_COLLIDER_TOP } from "../../index";
import {
  doorwayPoints,
  LIGHT_REACH,
  roomFrame,
  type AnyRoomModule,
  type Connector,
  type RoomPlan,
} from "../room";
import { contractProblems } from "../contract";
import { bodyBox, canPress, throwClear } from "../solution";
import { DECON_LOCK, deconLayout, type DeconLockParams } from "./decon-lock";
import { FAN_ROOM, fanLayout, type FanRoomParams } from "./fan-room";
import {
  FREIGHT_PASSAGE,
  freightLayout,
  TUNNEL_WIDTH,
  type FreightPassageParams,
} from "./freight-passage";
import { GENERATOR_HALL } from "./generator-hall";
import { GOODS_BAY } from "./goods-bay";
import { EXIT_LOCK, PENDING_MODULES, PUZZLE_MODULES } from "./index";
import {
  MAINTENANCE_LOFT,
  loftLayout,
  type MaintenanceLoftParams,
} from "./maintenance-loft";
import { PARTS_STORE } from "./parts-store";
import {
  PUMP_DOOR,
  PUMP_GALLERY,
  PUMP_SECONDS,
  pumpLayout,
  type PumpGalleryParams,
} from "./pump-gallery";
import { RECORDS_OFFICE } from "./records-office";
import { DOORWAY } from "./shell";

/** Random parameter sets per module (the contract tests run 4). */
const SETS = 16;
/** Random sets for the full contract here (16 with SUBLEVEL_FUZZ=1). */
const CONTRACT_SETS = process.env.SUBLEVEL_FUZZ === "1" ? 16 : 8;
const RUN = 5.6;
/**
 * A plate- or timer-released door: seconds from "let go" until it is shut
 * to less than a body's width (debounce 0.15 s, then ~1.0 m of slab travel
 * at up to 1.6 m/s after 0.2 s of acceleration).
 */
const SHUT = 0.15 + 0.2 + (1.05 - 0.16) / 1.6;

const AT: Connector = {
  position: { x: 2.3, y: 0, z: -4.1 },
  facing: { x: 0, y: 0, z: -1 },
  width: DOORWAY.width,
  height: DOORWAY.height,
  door: "prev.door",
};

function paramSets(m: AnyRoomModule): unknown[] {
  const out = [m.defaults];
  for (let s = 1; s <= SETS; s++) out.push(m.random(createRng(1000 + s)));
  return out;
}

interface Built {
  params: any;
  plan: RoomPlan;
  parts: RoomParts;
  solids: Box[];
  index: BoxIndex;
}

function builds(m: AnyRoomModule, mirror = false, at = AT): Built[] {
  return paramSets(m).map((params) => {
    const { plan, parts } = buildRoom(m, at, {
      params,
      mirror,
      prefix: "m.",
      seed: 3,
    });
    const solids = parts.brushes.map((b) => {
      const box = boxOf(b);
      return isSkirting(b) ? { ...box, y1: SKIRTING_COLLIDER_TOP } : box;
    });
    return { params, plan, parts, solids, index: new BoxIndex(solids) };
  });
}

/** 8-connected distances (metres) on a 0.1 m grid of standing positions. */
function distances(
  b: Built,
  from: Vec3,
  extra: Box[] = [],
  height: number = PLAYER.standHeight,
  feetY = 0,
): Cells {
  const region = b.plan.footprint.map(boxOf);
  const index = extra.length ? new BoxIndex([...b.solids, ...extra]) : b.index;
  const cell = 0.1;
  const x0 = Math.min(...region.map((r) => r.x0));
  const z0 = Math.min(...region.map((r) => r.z0));
  // Cells are aligned on `from`.
  const i0 = Math.floor((x0 - from.x) / cell) - 1;
  const k0 = Math.floor((z0 - from.z) / cell) - 1;
  const ni = Math.ceil((Math.max(...region.map((r) => r.x1)) - x0) / cell) + 3;
  const nk = Math.ceil((Math.max(...region.map((r) => r.z1)) - z0) / cell) + 3;
  const state = new Uint8Array(ni * nk); // 0 unknown, 1 free, 2 blocked
  const best = new Float64Array(ni * nk).fill(Infinity);
  const done = new Uint8Array(ni * nk);
  const px = (i: number) => from.x + (i + i0) * cell;
  const pz = (k: number) => from.z + (k + k0) * cell;
  const free = (i: number, k: number): boolean => {
    if (i < 0 || k < 0 || i >= ni || k >= nk) return false;
    const n = i * nk + k;
    if (state[n] === 0) {
      const x = px(i);
      const z = pz(k);
      const ok =
        region.some((r) => containsPoint(r, x, feetY + 0.5, z)) &&
        index.overlapping({
          ...bodyBox({ x, z, y: feetY }),
          y1: feetY + height,
        }).length === 0;
      state[n] = ok ? 1 : 2;
    }
    return state[n] === 1;
  };
  const out: Cells = [];
  // Dijkstra with buckets of 0.05 m of path length.
  const si = -i0;
  const sk = -k0;
  best[si * nk + sk] = 0;
  const buckets: number[][] = [[si * nk + sk]];
  const steps = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  for (let bi = 0; bi < buckets.length; bi++) {
    for (const n of buckets[bi] ?? []) {
      if (done[n]) continue;
      done[n] = 1;
      const i = Math.floor(n / nk);
      const k = n % nk;
      const d = best[n];
      out.push({ p: { x: px(i), y: feetY, z: pz(k) }, d });
      for (const [di, dk, c] of steps) {
        const m = (i + di) * nk + (k + dk);
        const nd = d + c * cell;
        if (!free(i + di, k + dk) || best[m] <= nd + 1e-9) continue;
        best[m] = nd;
        (buckets[Math.round(nd / 0.05)] ??= []).push(m);
      }
    }
  }
  return out;
}

type Cells = { p: Vec3; d: number }[];

/** Shortest distance to a cell in a doorway, within 0.15 m of its plane. */
const atDoorway = (cells: Cells, c: Connector) =>
  Math.min(
    ...cells
      .filter(({ p }) => {
        const along = -(
          (p.x - c.position.x) * c.facing.x +
          (p.z - c.position.z) * c.facing.z
        );
        const across = Math.abs(
          (p.x - c.position.x) * -c.facing.z +
            (p.z - c.position.z) * c.facing.x,
        );
        return along > 0 && along <= 0.15 + 1e-9 && across <= c.width / 2 - 0.3;
      })
      .map((x) => x.d),
  );

const near = (cells: Cells, at: Vec3, r: number) =>
  Math.min(
    ...cells
      .filter((c) => Math.hypot(c.p.x - at.x, c.p.z - at.z) <= r)
      .map((c) => c.d),
  );

const mass = (p: PropSpawn) => PROP_SPECS[p.kind].mass;
const startOf = (plan: RoomPlan) => doorwayPoints(plan.entry!.connector).after;
const centre = (b: Box): Vec3 => ({
  x: (b.x0 + b.x1) / 2,
  y: (b.y0 + b.y1) / 2,
  z: (b.z0 + b.z1) / 2,
});

describe("the module contract (rooms/contract.ts), for more random parameter sets", () => {
  for (const m of [...PUZZLE_MODULES, ...PENDING_MODULES, EXIT_LOCK]) {
    test(`${m.name}: defaults and ${CONTRACT_SETS} more random sets, mirrored and not`, () => {
      expect(
        contractProblems(m, {
          randomSets: CONTRACT_SETS,
          seedBase: 1001,
          orientations: "mirror",
        }).slice(0, 8),
      ).toEqual([]);
    });
  }
});

describe("records office (toggle button)", () => {
  test("the button is across the room from the door, round the counter, in sight of the entry", () => {
    for (const b of builds(RECORDS_OFFICE)) {
      const button = b.parts.buttons.find((x) => x.mode === undefined)!;
      const door = centre(boxOf(b.parts.doors[0].closed));
      expect(
        Math.hypot(button.position.x - door.x, button.position.z - door.z),
      ).toBeGreaterThan(4);
      // Walking from where it is pressed to the door goes round the counter.
      const stand = b.plan.solution.findLast(
        (s, i) => b.plan.solution[i + 1]?.do === "press",
      )!;
      if (stand.do !== "walk") throw new Error("no press spot");
      const walk = distances(b, stand.to);
      expect(
        near(walk, doorwayPoints(b.plan.exits[0].connector).before, 0.3),
      ).toBeGreaterThan(
        1.4 * Math.hypot(stand.to.x - door.x, stand.to.z - door.z),
      );
      // Seen from the entry at eye height: nothing in between.
      const s = startOf(b.plan);
      const eye = { x: s.x, y: PLAYER.eyeHeight, z: s.z };
      const d = {
        x: button.position.x - eye.x,
        y: button.position.y - eye.y,
        z: button.position.z - eye.z,
      };
      const blocked = b.parts.brushes.some((br) => {
        const box = boxOf(br);
        for (let t = 0.02; t < 0.98; t += 0.01) {
          if (
            containsPoint(
              box,
              eye.x + d.x * t,
              eye.y + d.y * t,
              eye.z + d.z * t,
            )
          )
            return true;
        }
        return false;
      });
      expect(blocked).toBe(false);
    }
  });
});

/** Plates: what is needed, what one prop gives, what is there in all. */
function plateBudget(b: Built) {
  const plate = b.parts.plates[0];
  const keys = b.plan.lock.keys.map((k) => b.parts.props[k.prop]);
  return {
    required: plate.requiredMass,
    heaviest: Math.max(...b.parts.props.map(mass)),
    keys: keys.reduce((n, p) => n + mass(p), 0),
    all: b.parts.props.reduce((n, p) => n + mass(p), 0),
    plate: boxOf(plate.box),
  };
}

/** Shortest walk from a plate (stepping off any side) through a door. */
function fromPlate(b: Built, plate: Box, to: Vec3, extra: Box[] = []): number {
  const c = centre(plate);
  const cells = distances(b, { x: c.x, y: 0, z: c.z }, extra);
  return near(cells, to, 0.35) - (plate.x1 - plate.x0) / 2;
}

describe("goods bay (weighted plate, gathering)", () => {
  test("no one prop is enough, the four crates are, the room holds 1.5x the need; the plate is too far to run from", () => {
    for (const b of builds(GOODS_BAY)) {
      const w = plateBudget(b);
      expect(w.heaviest).toBeLessThan(w.required);
      expect(w.keys).toBeGreaterThanOrEqual(w.required);
      expect(w.all).toBeGreaterThanOrEqual(1.5 * w.required);
      const before = doorwayPoints(b.plan.exits[0].connector).before;
      expect(fromPlate(b, w.plate, before)).toBeGreaterThan(RUN * SHUT * 1.3);
    }
  });
});

describe("parts store (weighted plate, fetching)", () => {
  test("the loose props in the room are not enough; the stores' crates are, with spare; the plate is too far to run from", () => {
    for (const b of builds(PARTS_STORE)) {
      const w = plateBudget(b);
      // The stores bay is the second extra footprint box.
      const store = boxOf(b.plan.footprint[2]);
      const inStore = (p: PropSpawn) =>
        containsPoint(store, p.position.x, 0.5, p.position.z);
      const loose = b.parts.props
        .filter((p) => !inStore(p))
        .reduce((n, p) => n + mass(p), 0);
      const stored = b.parts.props
        .filter(inStore)
        .reduce((n, p) => n + mass(p), 0);
      expect(loose).toBeLessThan(w.required);
      expect(w.heaviest).toBeLessThan(w.required);
      expect(stored).toBeGreaterThanOrEqual(w.required + 25);
      expect(
        b.plan.lock.keys.every((k) => inStore(b.parts.props[k.prop])),
      ).toBe(true);
      const before = doorwayPoints(b.plan.exits[0].connector).before;
      expect(fromPlate(b, w.plate, before)).toBeGreaterThan(RUN * SHUT * 1.3);
    }
  });
});

/** Floor cells a standing player reaches from the entry, as feet points. */
function floorCells(b: Built, step = 0.25): Vec3[] {
  const cells = distances(b, startOf(b.plan)).map((c) => c.p);
  return cells.filter(
    (p) =>
      Math.abs(((p.x / step) % 1) + 0) < 0.2 &&
      Math.abs((p.z / step) % 1) < 0.2,
  );
}

function impactChecks(b: Built, throwables: number) {
  const target = b.parts.buttons.find((x) => x.mode === "impact")!;
  const cells = distances(b, startOf(b.plan)).map((c) => c.p);
  // Out of use-key reach from everywhere one can stand.
  const reach = Math.min(
    ...cells.map((p) =>
      Math.hypot(
        p.x - target.position.x,
        p.y + PLAYER.eyeHeight - target.position.y,
        p.z - target.position.z,
      ),
    ),
  );
  expect(reach).toBeGreaterThan(PLAYER.reach);
  // A clear throw from at least 2 square metres of floor.
  const f = target.facing;
  const aim = {
    x: target.position.x + f.x * 0.3,
    y: target.position.y,
    z: target.position.z + f.z * 0.3,
  };
  const clear = (box: Box) => b.index.overlapping(box).length === 0;
  const coarse = cells.filter((_, i) => i % 9 === 0);
  const area =
    coarse.filter((p) => throwClear("crate_wood_small", p, aim, clear)).length *
    0.09;
  expect(area).toBeGreaterThan(2);
  expect(
    b.parts.props.filter((p) => mass(p) < 12).length,
  ).toBeGreaterThanOrEqual(throwables);
  return { target, aim, cells, clear };
}

/** Brush tops from 1.5 m up with room above them for a prop to stay. */
function highShelves(b: Built, ceiling: number): Box[] {
  return b.parts.brushes.map(boxOf).filter(
    (t) =>
      t.y1 > 1.5 &&
      t.y1 < ceiling - 0.5 &&
      Math.min(t.x1 - t.x0, t.z1 - t.z0) > 0.12 &&
      !b.index.overlapping({
        x0: (t.x0 + t.x1) / 2 - 0.05,
        x1: (t.x0 + t.x1) / 2 + 0.05,
        y0: t.y1 + 0.02,
        y1: t.y1 + 0.5,
        z0: (t.z0 + t.z1) / 2 - 0.05,
        z1: (t.z0 + t.z1) / 2 + 0.05,
      }).length,
  );
}

describe("generator hall (impact target across open floor)", () => {
  test("the target is out of reach, hittable from plenty of floor, with throwables and nowhere high for them to stay", () => {
    for (const b of builds(GENERATOR_HALL)) {
      impactChecks(b, 4);
      expect(
        highShelves(b, b.params.height).filter(
          (t) => t.y1 < b.params.height - 0.6,
        ),
      ).toEqual([]);
    }
  });
});

describe("fan room (impact target through a window)", () => {
  test("the target is out of reach and hittable only through the window; the bay is reachable crouching, not standing", () => {
    for (const b of builds(FAN_ROOM)) {
      const { aim, cells, clear } = impactChecks(b, 5);
      // Board the window up: no throw gets there any more.
      const lay = fanLayout(b.params as FanRoomParams);
      const w = lay.window;
      const board = boxOf(
        roomFrame(AT, false).box(lay.xp, w.y0, w.z0, lay.xb, w.y1, w.z1),
      );
      const boarded = (box: Box) =>
        clear(box) && !boxesOverlap(box, board, 1e-4);
      expect(
        cells
          .filter((_, i) => i % 9 === 0)
          .some((p) => throwClear("crate_wood_small", p, aim, boarded)),
      ).toBe(false);
      // The bay behind: crouching reaches it, standing does not.
      const bay = { x: aim.x - 0.4, y: 0, z: aim.z };
      const crouched = distances(b, startOf(b.plan), [], PLAYER.crouchHeight);
      expect(near(crouched, bay, 0.3)).toBeLessThan(Infinity);
      expect(near(distances(b, startOf(b.plan)), bay, 0.3)).toBe(Infinity);
    }
  });
});

describe("freight passage (heavy push)", () => {
  test("the crate plugs the only way on and cannot be squeezed past; pushed through, the way is free", () => {
    for (const b of builds(FREIGHT_PASSAGE)) {
      const p = b.params as FreightPassageParams;
      expect(
        TUNNEL_WIDTH - 2 * PROP_SPECS.crate_metal.halfExtents.z,
      ).toBeLessThan(2 * PLAYER.halfWidth);
      expect(PROP_SPECS.crate_metal.mass).toBeGreaterThan(PLAYER.maxCarryMass);
      const crate = b.parts.props[b.plan.lock.keys[0].prop];
      const before = doorwayPoints(b.plan.exits[0].connector).before;
      const blocked = distances(b, startOf(b.plan), [propBox(crate)]);
      expect(near(blocked, before, 0.3)).toBe(Infinity);
      const push = b.plan.solution.find((s) => s.do === "push")!;
      if (push.do !== "push") throw new Error("no push");
      const parked = propBox({
        ...crate,
        position: { ...push.to, y: crate.position.y },
      });
      const free = distances(b, startOf(b.plan), [parked]);
      expect(near(free, before, 0.3)).toBeLessThan(Infinity);
      expect(freightLayout(p).parked.x).toBeGreaterThan(
        freightLayout(p).xp1 + 0.9,
      );
    }
  });
});

describe("pump gallery (timed door, wedge)", () => {
  test("a sprint from the button cannot beat the door; the wedge spot is in the slab's path and leaves the doorway passable", () => {
    for (const b of builds(PUMP_GALLERY)) {
      const p = b.params as PumpGalleryParams;
      const lay = pumpLayout(p);
      const door = b.parts.doors.find((d) => d.id.endsWith("door_pump"))!;
      const slab = boxOf(door.closed);
      const press = b.plan.solution[0];
      if (press.do !== "walk") throw new Error("no press spot");
      const lane = {
        x: (slab.x0 + slab.x1) / 2,
        y: 0,
        z: (slab.z0 + slab.z1) / 2,
      };
      // From the press spot to the door, the door shut (it is the far side
      // we must reach): the shortest walk, less 8% for the grid.
      const walk = 0.96 * near(distances(b, press.to, [slab]), lane, 1.2);
      const shut = 0.2 + (PUMP_DOOR - 2 * PLAYER.halfWidth + 0.05 - 0.16) / 1.6;
      expect(walk / RUN).toBeGreaterThan(PUMP_SECONDS + shut + 0.3);
      expect(lay.routeLength / RUN).toBeGreaterThan(PUMP_SECONDS + shut + 0.3);
      // The wedge: in the slab's path, and a body's width plus 0.3 m free
      // beside it in the doorway.
      const carry = b.plan.solution.find((s) => s.do === "carry")!;
      if (carry.do !== "carry") throw new Error("no carry");
      const wedge = propBox({
        kind: "crate_wood_small",
        position: carry.to,
        yaw: 0,
      });
      expect(boxesOverlap(wedge, slab)).toBe(true);
      const span =
        slab.x1 - slab.x0 > slab.z1 - slab.z0
          ? [slab.x0, slab.x1, wedge.x0, wedge.x1]
          : [slab.z0, slab.z1, wedge.z0, wedge.z1];
      const freeWidth = Math.max(span[2] - span[0], span[1] - span[3]);
      expect(freeWidth).toBeGreaterThan(2 * PLAYER.halfWidth + 0.3);
    }
  });
});

describe("decon lock (relay: plate-held door, then a timed door)", () => {
  test("the plate is too far from the inner door to run; the exit's timer allows the run through an open inner door; heavy props only", () => {
    for (const b of builds(DECON_LOCK)) {
      const p = b.params as DeconLockParams;
      const lay = deconLayout(p);
      const w = plateBudget(b);
      expect(w.heaviest).toBeLessThan(w.required);
      expect(w.keys).toBeGreaterThanOrEqual(w.required);
      // Nothing light enough to be thrown through the inner door in time.
      expect(Math.min(...b.parts.props.map(mass))).toBeGreaterThanOrEqual(20);
      const inner = b.parts.doors.find((d) => d.id.endsWith("door_inner"))!;
      const innerAt = centre(boxOf(inner.closed));
      expect(fromPlate(b, w.plate, { ...innerAt, y: 0 })).toBeGreaterThan(
        RUN * SHUT * 1.3,
      );
      // The run: from the press spot to the exit doorway, inner door open.
      const timed = b.parts.buttons.find((x) => x.id.endsWith("button_exit"))!;
      const stand =
        b.plan.solution[b.plan.solution.findIndex((s) => s.do === "press") - 1];
      if (stand.do !== "walk") throw new Error("no press spot");
      expect(canPress(timed, stand.to)).toBe(true);
      const run =
        atDoorway(distances(b, stand.to), b.plan.exits[0].connector) + 0.8;
      expect(run).toBeLessThan(Infinity);
      expect(run / RUN + 1.1).toBeLessThan(timed.seconds!);
      expect(timed.seconds).toBe(lay.seconds);
      // A way out of the lock.
      expect(
        b.parts.buttons.some(
          (x) => x.target === inner.id && x.mode === "timed",
        ),
      ).toBe(true);
    }
  });
});

describe("maintenance loft (climb)", () => {
  test("the deck is out of jump reach, the crates make a staircase to it, the base is clear, the button only works from the deck", () => {
    for (const b of builds(MAINTENANCE_LOFT)) {
      const p = b.params as MaintenanceLoftParams;
      const lay = loftLayout(p);
      const h = 2 * PROP_SPECS.crate_wood.halfExtents.y;
      expect(p.deck).toBeGreaterThan(1.45);
      expect(h).toBeLessThanOrEqual(PLAYER.jumpHeight);
      expect(2 * h - h).toBeLessThanOrEqual(PLAYER.jumpHeight);
      expect(p.deck - 2 * h).toBeLessThanOrEqual(PLAYER.jumpHeight * 0.6);
      expect(
        b.parts.props.filter((x) => x.kind === "crate_wood").length,
      ).toBeGreaterThanOrEqual(4);
      // The staircase spots are clear of brushes above the floor and of
      // props at the start.
      for (const s of b.plan.solution.filter((x) => x.do === "carry")) {
        if (s.do !== "carry") continue;
        const box = propBox({ kind: "crate_wood", position: s.to, yaw: 0 });
        expect(b.index.overlapping({ ...box, y0: box.y0 + 0.01 }).length).toBe(
          0,
        );
        expect(
          b.parts.props.some((q) => boxesOverlap(propBox(q), box, 1e-3)),
        ).toBe(false);
      }
      const button = b.parts.buttons[1] ?? b.parts.buttons[0];
      const toggle = b.parts.buttons.find((x) => x.mode === undefined)!;
      void button;
      const floor = distances(b, startOf(b.plan)).map((c) => c.p);
      expect(floor.some((q) => canPress(toggle, q))).toBe(false);
      const press =
        b.plan.solution[b.plan.solution.findIndex((s) => s.do === "press") - 1];
      if (press.do !== "walk") throw new Error("no press spot");
      expect(canPress(toggle, press.to)).toBe(true);
      expect(lay.stack.x).toBeLessThan(lay.xl);
    }
  });
});

void floorCells;
void LIGHT_REACH;
void ({} as ButtonDef);
