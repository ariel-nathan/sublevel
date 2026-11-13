/**
 * Parts store (weighted plate, fetching). The plate is in a weigh bay, an
 * alcove off the right wall by the entry, ringed with hazard tiles under
 * its own lamp. It holds the exit door (left wall, far end) open while 40
 * to 48 kg rest on it, and everything loose in the main room together (a
 * chair, a small crate, a monitor: 24 kg) is not enough. The weight is in
 * the stores, a racked bay off the far wall: three wooden crates (25 kg
 * each). Fetch two, carry them the length of the room into the weigh bay
 * and stack them on the plate.
 *
 *   top view (not mirrored)
 *
 *   +======= left wall: cabinets, bench ======= EXIT ===+
 *   |                                                   +--stores--+
 *   E entry                                             | c  c  c  |
 *   |                                                   +----------+
 *   +====| weigh bay |=================================+
 *        |  [PLATE]  |
 *        +-----------+
 *
 * The plate is well over 7.5 m from the exit doorway: a player who stands
 * on it (80 kg) and runs does not get through before the door shuts.
 *
 * Softlocks: none. Every crate stays on the floor of the store, the room
 * or the bays, where it can be picked up again (wooden crates do not
 * break); the props weigh 99 kg against at most 48 needed; props carried
 * out through the entry can be fetched back (the way-back button reopens
 * the previous door); whatever is on the plate keeps the door open, and
 * loading it again reopens it.
 */
import type { SolutionStep } from "../../../core/api";
import { PROP_SPECS } from "../../../core/props";
import type { Rng } from "../../../core/rng";
import type { RoomModule, RoomPlan } from "../room";
import { WALL as W } from "../room";
import {
  beams,
  cabinet,
  COOL,
  desk,
  lamp,
  pipeAlongX,
  rack,
  signX,
  signZ,
  WARM,
} from "./dress";
import { buildShell, ENTRY_SIZE, tile } from "./shell";
import { pick, q } from "./util";

export interface PartsStoreParams {
  length: number;
  left: number;
  right: number;
  height: number;
  requiredMass: number;
  /** Weigh bay width and depth. */
  bayWidth: number;
  bayDepth: number;
  /** Depth of the stores bay. */
  storeDepth: number;
  /** Exit position along the far part of the left wall (fraction). */
  exit: number;
  flicker: boolean;
}

export const PARTS_STORE_RANGES = {
  length: [10, 12],
  left: [3.4, 4.2],
  right: [3.6, 4.4],
  height: [3.6, 4.2],
  requiredMass: [40, 48],
  bayWidth: [2.2, 2.6],
  bayDepth: [2.0, 2.4],
  storeDepth: [3.0, 3.4],
  exit: [0, 1],
} as const;

const R = PARTS_STORE_RANGES;
export const STORE_PLATE = 1.2;
const BAY_HEIGHT = 2.8;
const STORE_WIDTH = 2.2;

function random(rng: Rng): PartsStoreParams {
  return {
    length: pick(rng, R.length),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    requiredMass: rng.int(...R.requiredMass),
    bayWidth: pick(rng, R.bayWidth),
    bayDepth: pick(rng, R.bayDepth),
    storeDepth: pick(rng, R.storeDepth),
    exit: pick(rng, R.exit),
    flicker: rng.next() < 0.5,
  };
}

export function partsStoreLayout(p: PartsStoreParams) {
  const x0 = W;
  const x1 = x0 + p.length;
  const z0 = -p.left;
  const z1 = p.right;
  // Weigh bay off the right wall.
  const ax0 = x0 + 1.6;
  const ax1 = q(ax0 + p.bayWidth);
  const bay0 = z1 + W;
  const bay1 = q(bay0 + p.bayDepth);
  const plate = { x: q((ax0 + ax1) / 2), z: q((bay0 + bay1) / 2 + 0.1) };
  // Stores bay off the far wall, on the line the crates are carried along.
  const zs = q(z1 - 1.8);
  const sx0 = x1 + W;
  const sx1 = q(sx0 + p.storeDepth);
  const crates = [0.7, 1.65, p.storeDepth - 0.5].map((d) => ({
    x: q(sx0 + d),
    z: zs,
  }));
  // Where crates are set down on the way: on the weigh bay's axis.
  const drop = { x: plate.x, z: zs };
  const e0 = x0 + p.length * 0.55;
  const e1 = x1 - 1.2;
  const exitX = q(e0 + (e1 - e0) * p.exit);
  return {
    x0,
    x1,
    z0,
    z1,
    ax0,
    ax1,
    bay0,
    bay1,
    plate,
    zs,
    sx0,
    sx1,
    crates,
    drop,
    exitX,
  };
}

function build(
  ctx: Parameters<RoomModule<PartsStoreParams>["build"]>[0],
  at: Parameters<RoomModule<PartsStoreParams>["build"]>[1],
  p: PartsStoreParams,
): RoomPlan {
  const lay = partsStoreLayout(p);
  const { x0, x1, z0, z1, ax0, ax1, bay0, bay1, plate, zs, sx0, sx1 } = lay;
  const { drop, exitX } = lay;
  const s0 = zs - STORE_WIDTH / 2;
  const s1 = zs + STORE_WIDTH / 2;
  const s = buildShell(ctx, at, {
    length: p.length,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: "left", at: exitX, door: true },
    floor: "concrete_floor",
    walls: "concrete_wall",
    farWall: "metal_panel",
    ceiling: "metal_panel",
    acoustics: "hall",
    holes: [
      { side: "right", a: ax0, b: ax1, top: BAY_HEIGHT },
      { side: "far", a: s0, b: s1, top: BAY_HEIGHT },
    ],
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;

  // --- The weigh bay ---------------------------------------------------------
  const ph = STORE_PLATE / 2;
  const ring = 0.15;
  const strips = [
    {
      x0: plate.x - ph - ring,
      z0: plate.z - ph - ring,
      x1: plate.x + ph + ring,
      z1: plate.z - ph,
    },
    {
      x0: plate.x - ph - ring,
      z0: plate.z + ph,
      x1: plate.x + ph + ring,
      z1: plate.z + ph + ring,
    },
    {
      x0: plate.x - ph - ring,
      z0: plate.z - ph,
      x1: plate.x - ph,
      z1: plate.z + ph,
    },
    {
      x0: plate.x + ph,
      z0: plate.z - ph,
      x1: plate.x + ph + ring,
      z1: plate.z + ph,
    },
  ];
  tile(ax0, bay0, ax1, bay1, strips, (a, b, c, d) =>
    B(a, -W, b, c, 0, d, "concrete_floor"),
  );
  for (const st of strips)
    B(st.x0, -W, st.z0, st.x1, 0, st.z1, "hazard_stripe");
  B(ax0, BAY_HEIGHT, bay0, ax1, BAY_HEIGHT + W, bay1, "metal_panel");
  k.wallAlongZ(ax0 - W, ax0, bay0, bay1 + W, -W, BAY_HEIGHT + W, "metal_panel");
  k.wallAlongZ(ax1, ax1 + W, bay0, bay1 + W, -W, BAY_HEIGHT + W, "metal_panel");
  k.wallAlongX(ax0, ax1, bay1, bay1 + W, -W, BAY_HEIGHT + W, "metal_panel");
  k.frameZ(z1, -1, ax0, ax1, BAY_HEIGHT);
  s.footprint.push(F.box(ax0 - W, -W, bay0, ax1 + W, BAY_HEIGHT + W, bay1 + W));
  k.zone(F.box(ax0, 0, z1, ax1, BAY_HEIGHT, bay1), "small");
  const plateId = ctx.id("plate_exit");
  ctx.plate({
    id: plateId,
    box: F.box(plate.x - ph, 0, plate.z - ph, plate.x + ph, 0.04, plate.z + ph),
    requiredMass: p.requiredMass,
    target: s.exitDoor!.id,
  });
  lamp(k, plate.x, plate.z, BAY_HEIGHT, WARM, 4.5, 1.7, { hx: 0.3, hz: 0.3 });
  signZ(k, bay1, -1, plate.x - 0.45, plate.x + 0.45, 1.3, 2.0);
  // A conduit from the bay's jamb along the right wall towards the stores.
  const cy = BAY_HEIGHT + 0.25;
  B(ax1 + 0.2, cy, z1 - 0.15, x1, cy + 0.12, z1 - 0.03, "pipe");

  // --- The stores: a racked bay off the far wall, crates on its floor -------
  const sh = BAY_HEIGHT;
  B(sx0, -W, s0, sx1, 0, s1, "concrete_floor");
  B(sx0, sh, s0, sx1, sh + W, s1, "metal_panel");
  k.wallAlongX(sx0, sx1 + W, s0 - W, s0, -W, sh + W, "metal_panel");
  k.wallAlongX(sx0, sx1 + W, s1, s1 + W, -W, sh + W, "metal_panel");
  k.wallAlongZ(sx1, sx1 + W, s0, s1, -W, sh + W, "metal_panel");
  k.frameX(x1, -1, s0, s1, sh);
  s.footprint.push(F.box(sx0, -W, s0 - W, sx1 + W, sh + W, s1 + W));
  k.zone(F.box(x1, 0, s0, sx1, sh, s1), "small");
  for (const [z0r, z1r] of [
    [s0, s0 + 0.42],
    [s1 - 0.42, s1],
  ]) {
    rack(k, sx0 + 0.15, z0r, sx1 - 0.1, z1r, [0.15, 0.95, 1.75], 2.4, "x");
    for (let x = sx0 + 0.3; x + 0.5 < sx1 - 0.2; x += 0.65) {
      for (const y of [0.19, 0.99, 1.79]) {
        if (rng.next() < 0.6) {
          B(
            x,
            y,
            z0r + 0.07,
            x + 0.5,
            y + 0.4,
            z1r - 0.07,
            rng.next() < 0.5 ? "crate_metal" : "plastic_white",
          );
        }
      }
    }
  }
  lamp(k, q((sx0 + sx1) / 2), zs, sh, COOL, 4, 1.3);
  signX(
    k,
    x1,
    -1,
    zs - 0.5,
    zs + 0.5,
    sh + 0.25,
    Math.min(sh + 0.75, h - 0.15),
  );
  const crates = lay.crates.map((c) =>
    k.propTurned("crate_wood", c.x, 0, c.z, rng.range(-0.1, 0.1)),
  );

  // --- The main room: loose odds and ends, not enough by themselves --------
  const cabEnd = exitX - 0.8 - 1.1;
  for (let x = x0 + 1.0; x + 0.6 <= cabEnd; x += 0.65) {
    cabinet(k, x, z0, x + 0.6, z0 + 0.5, rng.next() < 0.5 ? 1.2 : 1.9, "+z");
  }
  if (exitX + 2.2 < x1 - 0.1) {
    desk(
      k,
      exitX + 1.1,
      z0,
      Math.min(exitX + 2.6, x1 - 0.1),
      z0 + 0.75,
      0.9,
      "metal_panel",
    );
    k.propTurned("monitor", exitX + 1.5, 0.9, z0 + 0.35, Math.PI);
  } else {
    k.propTurned("monitor", x0 + 0.6, 0, z0 + 1.3, 0.4);
  }
  k.propTurned("chair", q((x0 + exitX) / 2), 0, z0 + 1.1, rng.range(0, 6));
  k.propTurned("crate_wood_small", x0 + 0.6, 0, z0 + 0.5, rng.range(-0.3, 0.3));

  // --- Dressing and light -----------------------------------------------------
  const midX = q(x0 + p.length * 0.55);
  const lampXs = [midX, x1 - 1.6, exitX];
  const bxs: number[] = [];
  for (let x = x0 + 2.0; x < x1 - 0.5; x += 2.6) {
    if (lampXs.every((lx) => Math.abs(lx - x) > 0.6)) bxs.push(q(x));
  }
  beams(k, bxs, z0, z1, h, 0.3);
  pipeAlongX(k, x0, x1, z0, 1, h - 0.7, 0.18);
  signZ(k, z0, 1, s.exitLo - 0.9, s.exitLo - 0.3, 1.3, 2.0);
  lamp(k, exitX, z0 + 1.2, h, WARM, 5, 1.0);
  lamp(k, x1 - 1.6, zs, h, COOL, 6, 1.0);
  if (p.flicker) {
    lamp(k, midX, 0, h, COOL, 6.5, 0.9, {
      flicker: "broken",
      bounds: F.box(0, -W, z0 - W, x1 + W, h + W, z1 + W),
    });
    k.emitter("hum_fluorescent", midX, h - 0.3, 0, 0.3);
  } else {
    lamp(k, midX, 0, h, COOL, 6.5, 0.9);
  }
  k.emitter("hum_machine", x1 - 0.5, 1.2, z0 + 0.5, 0.25);

  // --- Solution: for each of two crates, fetch it from the stores and set
  // it down on the weigh bay's axis; then carry it straight into the bay
  // and stack it on the plate ---------------------------------------------
  const P = s.P;
  const half = PROP_SPECS.crate_wood.halfExtents.y;
  const rest = 0.04 + half;
  const solution: SolutionStep[] = [];
  [0, 1].forEach((i) => {
    solution.push({ do: "walk", to: P(x1 - 1.4, zs) });
    solution.push({
      do: "carry",
      prop: crates[i],
      to: F.point(drop.x, half, drop.z),
    });
    solution.push({ do: "walk", to: P(drop.x + 1.2, z1 - 3.2) });
    solution.push({
      do: "carry",
      prop: crates[i],
      to: F.point(plate.x, rest + i * 2 * half, plate.z),
    });
    if (i === 1) solution.push({ do: "wait", for: "plate_down", seconds: 3 });
    solution.push({ do: "walk", to: P(plate.x, z1 - 0.9) });
  });
  solution.push({ do: "walk", to: s.before });
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "weighted-plate",
      doors: [s.exitDoor!.id],
      buttons: [],
      plates: [plateId],
      keys: crates.slice(0, 2).map((prop, i) => ({
        prop,
        at: F.point(lay.crates[i].x, half, lay.crates[i].z),
      })),
    },
    solution,
  };
}

export const PARTS_STORE: RoomModule<PartsStoreParams> = {
  name: "parts-store",
  role: "middle",
  teaches: "weighted-plate",
  difficulty: 2,
  requires: {},
  entrySize: ENTRY_SIZE,
  defaults: {
    length: 11,
    left: 3.8,
    right: 4.0,
    height: 3.9,
    requiredMass: 45,
    bayWidth: 2.4,
    bayDepth: 2.2,
    storeDepth: 3.2,
    exit: 0.5,
    flicker: true,
  },
  random,
  build,
};
