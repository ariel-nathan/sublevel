/**
 * Goods-in bay (weighted plate, gathering). A pressure plate near the entry,
 * ringed with hazard tiles under its own lamp, holds the exit door (far
 * wall, across the bay) open while `requiredMass` kilograms rest on it. The
 * mass needed (26 to 32 kg) is more than any one prop in the room weighs
 * (small crates 8 kg, monitors 9 kg, chairs 7 kg): the player gathers the
 * small crates scattered round the walls, one per quarter of the plate.
 *
 *   top view (not mirrored)
 *
 *   +=========== left wall: crate, shutter ===========+
 *   | crate                                     crate |
 *   E   [PLATE]                                       EXIT (far wall)
 *   |  crate  bench+monitors   racks          chair   |
 *   +=================================================+
 *
 * The plate is at least 7.5 m from the exit doorway, so a player who
 * stands on it (80 kg) and runs for the door does not get through before
 * it closes (it starts closing 0.15 s after the plate rises and is shut to
 * less than a body's width after about 0.8 s more).
 *
 * Softlocks: none. Every prop stays in the bay or can be carried back
 * through the entry, whose previous door the way-back button reopens; the
 * props in the room weigh 1.5x to 2.4x the requirement, so even with some
 * thrown out through the open exit (which needs the plate loaded, and
 * whatever is on the plate stays) enough remain. The door reopens whenever
 * the plate is loaded again.
 */
import type { Rng } from "../../../core/rng";
import { PROP_SPECS } from "../../../core/props";
import type { PropKind, SolutionStep } from "../../../core/api";
import type { Vec3 } from "../../../math";
import type { RoomModule, RoomPlan } from "../room";
import {
  beams,
  cabinet,
  desk,
  lamp,
  pipeAlongX,
  rack,
  signX,
  signZ,
  SODIUM,
  WARM,
} from "./dress";
import { buildShell, ENTRY_SIZE, tile } from "./shell";
import { pick, q } from "./util";

export interface GoodsBayParams {
  length: number;
  left: number;
  right: number;
  height: number;
  /** Kilograms the plate needs. */
  requiredMass: number;
  /** Where along the far wall the exit is (fraction of the usable span). */
  exit: number;
  /** Extra chairs about the room (decoys and spare weight). */
  chairs: number;
  /** A roller shutter on the left wall. */
  shutter: boolean;
}

export const GOODS_BAY_RANGES = {
  length: [11, 13],
  left: [4.0, 4.8],
  right: [4.0, 4.8],
  height: [3.6, 4.2],
  requiredMass: [26, 32],
  exit: [0, 1],
  chairs: [1, 2],
} as const;

const R = GOODS_BAY_RANGES;
/** Plate size and where it sits from the entry wall and the left wall. */
export const GOODS_PLATE = { size: 1.6, x: 3.0, z: 3.0 };

function random(rng: Rng): GoodsBayParams {
  return {
    length: pick(rng, R.length),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    requiredMass: rng.int(...R.requiredMass),
    exit: pick(rng, R.exit),
    chairs: rng.int(...R.chairs),
    shutter: rng.next() < 0.6,
  };
}

/** Where things are in design coordinates (for the build and the tests). */
export function goodsBayLayout(p: GoodsBayParams, entryHalf: number) {
  const x0 = 0.3;
  const x1 = x0 + p.length;
  const z0 = -p.left;
  const z1 = p.right;
  const pc = { x: x0 + GOODS_PLATE.x, z: z0 + GOODS_PLATE.z };
  const ph = GOODS_PLATE.size / 2;
  // Exit on the far wall, right of centre, with its door pocket to its left.
  const e0 = Math.max(0.6, z0 + 3.0);
  const e1 = z1 - 1.1;
  const exitZ = q(e0 + (e1 - e0) * p.exit);
  // The four intended crates, one per quarter of the plate: entry wall
  // left of the doorway, left wall past the plate, right wall near the
  // entry, far end of the right wall.
  const crates: { at: Vec3; quarter: [number, number] }[] = [
    {
      at: { x: x0 + 0.55, y: 0, z: q(Math.min(z0 + 1.0, -entryHalf - 0.9)) },
      quarter: [-1, -1],
    },
    { at: { x: q(x0 + 6.0), y: 0, z: z0 + 0.55 }, quarter: [1, -1] },
    { at: { x: x0 + 1.9, y: 0, z: z1 - 0.55 }, quarter: [-1, 1] },
    { at: { x: q(x1 - 3.0), y: 0, z: z1 - 0.55 }, quarter: [1, 1] },
  ];
  return { x0, x1, z0, z1, pc, ph, exitZ, crates };
}

function build(
  ctx: Parameters<RoomModule<GoodsBayParams>["build"]>[0],
  at: Parameters<RoomModule<GoodsBayParams>["build"]>[1],
  p: GoodsBayParams,
): RoomPlan {
  const lay = goodsBayLayout(p, at.width / 2);
  const { x0, x1, z0, z1, pc, ph, exitZ } = lay;
  const s = buildShell(ctx, at, {
    length: p.length,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: "far", at: exitZ, door: true },
    floor: "concrete_floor",
    walls: "concrete_wall",
    ceiling: "metal_panel",
    noFloor: true,
    acoustics: "hall",
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;

  // --- Floor with a flush ring of hazard tiles round the plate -------------
  const ring = 0.15;
  const r0 = {
    x0: pc.x - ph - ring,
    z0: pc.z - ph - ring,
    x1: pc.x + ph + ring,
    z1: pc.z + ph + ring,
  };
  const strips = [
    { x0: r0.x0, z0: r0.z0, x1: r0.x1, z1: pc.z - ph },
    { x0: r0.x0, z0: pc.z + ph, x1: r0.x1, z1: r0.z1 },
    { x0: r0.x0, z0: pc.z - ph, x1: pc.x - ph, z1: pc.z + ph },
    { x0: pc.x + ph, z0: pc.z - ph, x1: r0.x1, z1: pc.z + ph },
  ];
  tile(x0, z0, x1, z1, strips, (a, b, c, d) =>
    B(a, -0.3, b, c, 0, d, "concrete_floor"),
  );
  for (const st of strips)
    B(st.x0, -0.3, st.z0, st.x1, 0, st.z1, "hazard_stripe");

  // --- The plate and its lamp ---------------------------------------------
  const plateId = ctx.id("plate_exit");
  ctx.plate({
    id: plateId,
    box: F.box(pc.x - ph, 0, pc.z - ph, pc.x + ph, 0.04, pc.z + ph),
    requiredMass: p.requiredMass,
    target: s.exitDoor!.id,
  });
  lamp(k, pc.x, pc.z, h, WARM, 5, 1.7, { hx: 0.35, hz: 0.35 });
  // A "load here" sign on the left wall by the plate.
  signZ(k, z0, 1, pc.x - 0.5, pc.x + 0.5, 1.5, 2.3);

  // --- The exit: a lamp over it and a sign beside it ----------------------
  lamp(k, x1 - 1.0, exitZ, h, SODIUM, 6, 1.3);
  signX(k, x1, -1, s.exitLo - 0.95, s.exitLo - 0.35, 1.3, 2.0);

  // --- Dressing -------------------------------------------------------------
  // Roller shutter on the left wall past the plate: a ribbed panel in a
  // striped frame (it does not open).
  const sh0 = q(x0 + 7.0);
  const sh1 = Math.min(q(x0 + 10.0), x1 - 2.0);
  if (p.shutter && sh1 - sh0 > 2) {
    B(sh0, 0, z0, sh1, 3.0, z0 + 0.05, "metal_panel");
    for (let y = 0.25; y < 2.9; y += 0.35) {
      B(
        sh0 + 0.05,
        y,
        z0 + 0.05,
        sh1 - 0.05,
        y + 0.06,
        z0 + 0.08,
        "metal_panel",
      );
    }
    B(sh0 - 0.15, 0, z0, sh0, 3.15, z0 + 0.1, "hazard_stripe");
    B(sh1, 0, z0, sh1 + 0.15, 3.15, z0 + 0.1, "hazard_stripe");
    B(sh0, 3.0, z0, sh1, 3.15, z0 + 0.1, "hazard_stripe");
  } else {
    pipeAlongX(k, x0 + 4.5, x1 - 1.5, z0, 1, 1.0);
  }
  // A workbench with monitors on the right wall, between the near crate
  // and the racks.
  const bx0 = x0 + 3.2;
  const bx1 = x0 + 5.2;
  desk(k, bx0, z1 - 0.8, bx1, z1, 0.9, "metal_panel");
  B(bx0 + 0.2, 0.9, z1 - 0.3, bx0 + 0.6, 1.15, z1 - 0.05, "rubber_dark");
  k.propTurned("monitor", bx0 + 1.0, 0.9, z1 - 0.4, Math.PI);
  k.propTurned("monitor", bx0 + 1.6, 0.9, z1 - 0.4, Math.PI + 0.2);
  // Pallet racking on the right wall beyond the bench, with stock on it.
  const rx0 = bx1 + 0.8;
  const rx1 = Math.min(lay.crates[3].at.x - 0.6, x1 - 1.0);
  if (rx1 - rx0 > 1.4) {
    rack(k, rx0, z1 - 0.9, rx1, z1, [0.2, 1.4, 2.6], 3.0, "x");
    for (let x = rx0 + 0.15; x + 0.7 < rx1 - 0.1; x += 0.9) {
      for (const y of [0.24, 1.44]) {
        if (rng.next() < 0.75)
          B(
            x,
            y,
            z1 - 0.8,
            x + 0.7,
            y + 0.6,
            z1 - 0.1,
            rng.next() < 0.6 ? "crate_wood" : "crate_metal",
          );
      }
    }
  }
  // Cabinets in the far left corner.
  cabinet(k, x1 - 1.4, z0, x1 - 0.1, z0 + 0.6, 1.8, "+z");
  // Ceiling beams and a pipe run high on the right wall.
  const bxs: number[] = [];
  for (let x = x0 + 1.8; x < x1 - 0.8; x += 3.3) {
    if (Math.abs(x - pc.x) > 0.7 && Math.abs(x - (x1 - 1.0)) > 0.6)
      bxs.push(q(x));
  }
  beams(k, bxs, z0, z1, h, 0.3);
  pipeAlongX(k, x0, x1, z1, -1, h - 0.75, 0.2);

  // --- Props ------------------------------------------------------------------
  const crates = lay.crates.map((c) =>
    k.propTurned("crate_wood_small", c.at.x, 0, c.at.z, rng.range(-0.3, 0.3)),
  );
  // Chairs (decoys, and spare weight).
  const chairSpots = [
    { x: x1 - 0.6, z: q((z0 + exitZ) / 2) - 0.3 },
    { x: q(x0 + 9.0), z: z0 + 0.6 },
    { x: x0 + 0.6, z: z0 + 2.2 },
  ];
  for (const c of chairSpots.slice(0, p.chairs)) {
    k.propTurned("chair", c.x, 0, c.z, rng.range(0, Math.PI * 2));
  }

  // --- Lights ------------------------------------------------------------------
  lamp(k, q(x0 + 7.0), q(z0 + 1.6), h, SODIUM, 7.5, 1.0);
  lamp(k, q(x0 + 7.0), q(z1 - 2.0), h, SODIUM, 7, 0.8);
  k.emitter("hum_machine", x1 - 0.8, 1.0, z0 + 0.3, 0.3);

  // --- The solution: one crate per quarter of the plate, each approached
  // from outside its own corner so that the player never stands on it.
  const P = s.P;
  const rest = 0.04 + PROP_SPECS.crate_wood_small.halfExtents.y;
  const order = [0, 1, 3, 2];
  const solution: SolutionStep[] = [];
  for (const i of order) {
    const [qx, qz] = lay.crates[i].quarter;
    solution.push({ do: "walk", to: P(pc.x + qx * 1.35, pc.z + qz * 1.35) });
    solution.push({
      do: "carry",
      prop: crates[i],
      to: F.point(pc.x + qx * 0.4, rest, pc.z + qz * 0.4),
    });
  }
  solution.push({ do: "wait", for: "plate_down", seconds: 3 });
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
      keys: crates.map((prop, i) => ({
        prop,
        at: F.point(
          lay.crates[i].at.x,
          PROP_SPECS.crate_wood_small.halfExtents.y,
          lay.crates[i].at.z,
        ),
      })),
    },
    solution,
  };
}

/** Props in the room by kind (for the tests' mass budget). */
export const GOODS_BAY_KEY: PropKind = "crate_wood_small";

export const GOODS_BAY: RoomModule<GoodsBayParams> = {
  name: "goods-bay",
  role: "middle",
  teaches: "weighted-plate",
  difficulty: 1,
  requires: {},
  entrySize: ENTRY_SIZE,
  defaults: {
    length: 12,
    left: 4.4,
    right: 4.4,
    height: 3.9,
    requiredMass: 30,
    exit: 0.5,
    chairs: 2,
    shutter: true,
  },
  random,
  build,
};
