/**
 * Decontamination lock (relay: a plate-held door, then a timed door). The
 * suit-up hall ends in a partition with the lock's inner door; the lock's
 * outer door is the exit. The inner door is held open by a pressure plate
 * by the entry (40 to 50 kg); the exit door opens for a few seconds from a
 * timed button on the hall's left wall, far enough from the lock that only
 * a run straight through an already open inner door makes it. So: load the
 * plate with equipment crates (leave them there to hold the inner door),
 * then press the timed button and run through both doors.
 *
 *   top view (not mirrored)
 *
 *   x0                                xp  xp+0.3        x1
 *   +====== lockers === [TIMED] =======|=================+
 *   |                                  D1   lock         |
 *   E entry                            |   (showers)     D2 EXIT
 *   |  [PLATE]    crates    barrel     |                 |
 *   +==================================|=================+
 *
 * Standing on the plate opens the inner door, but it is at least 7.5 m
 * away: it shuts before the player gets there.
 *
 * Softlocks: none. The props are heavy (25 kg crates, a 35 kg barrel), so
 * none thrown off the plate can fly through the inner door before it
 * shuts: mass enough for the plate stays outside or on it. Inside the lock
 * a timed button reopens the inner door (long enough to carry a prop out),
 * and the next room's way-back button reopens the exit door.
 */
import type { SolutionStep } from "../../../core/api";
import { PROP_SPECS } from "../../../core/props";
import type { Rng } from "../../../core/rng";
import { BUTTON_DEPTH, type RoomModule, type RoomPlan } from "../room";
import { WALL as W } from "../room";
import { cabinet, COOL, desk, lamp, signX, signZ, WARM } from "./dress";
import { buildShell, DOOR_POCKET, DOORWAY, ENTRY_SIZE, tile } from "./shell";
import { pick, q } from "./util";

export interface DeconLockParams {
  /** Length of the hall (entry wall to partition). */
  hall: number;
  /** Depth of the lock. */
  lock: number;
  left: number;
  right: number;
  height: number;
  requiredMass: number;
  /** Inner door's and exit door's positions (fractions of their spans). */
  inner: number;
  outer: number;
}

export const DECON_LOCK_RANGES = {
  hall: [9, 11],
  lock: [2.6, 3.2],
  left: [3.8, 4.6],
  right: [3.6, 4.4],
  height: [3.4, 4.0],
  requiredMass: [40, 50],
  inner: [0, 1],
  outer: [0, 1],
} as const;

const R = DECON_LOCK_RANGES;
export const DECON_PLATE = 1.4;
/** Seconds the inner door stays open from the button inside the lock. */
export const INNER_SECONDS = 5;

function random(rng: Rng): DeconLockParams {
  return {
    hall: pick(rng, R.hall),
    lock: pick(rng, R.lock),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    requiredMass: rng.int(...R.requiredMass),
    inner: pick(rng, R.inner),
    outer: pick(rng, R.outer),
  };
}

export function deconLayout(p: DeconLockParams) {
  const x0 = W;
  const xp = x0 + p.hall;
  const lx0 = xp + W;
  const x1 = q(lx0 + p.lock);
  const z0 = -p.left;
  const z1 = p.right;
  const dw = DOORWAY.width;
  // Doors slide towards -z: each needs DOOR_POCKET of wall on that side.
  const d0 = z0 + DOOR_POCKET + dw / 2 + 0.05;
  const d1 = z1 - dw / 2 - 0.6;
  const innerZ = q(d0 + (d1 - d0) * p.inner * 0.5);
  const outerZ = q(d0 + (d1 - d0) * p.outer);
  const plate = { x: x0 + 2.2, z: q(z1 - 2.1) };
  // The timed button on the left wall, past the middle of the hall.
  const button = { x: q(x0 + p.hall * 0.5), z: z0 + BUTTON_DEPTH };
  const stand = { x: button.x, z: z0 + BUTTON_DEPTH + 1.0 };
  // The run from the button: to the inner door, through the lock, out.
  const run = [
    stand,
    { x: xp - 0.8, z: innerZ },
    { x: lx0 + 0.8, z: innerZ },
    { x: x1 - 0.5, z: outerZ },
    { x: x1 + W + 0.8, z: outerZ },
  ];
  let length = 0;
  for (let i = 1; i < run.length; i++) {
    length += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
  }
  // Time on the exit door's button: the run at 4 m/s (under a sprint's
  // 5.6), plus the door's opening and a margin.
  const seconds = Math.ceil((length / 4 + 1.5) * 2) / 2;
  return {
    x0,
    xp,
    lx0,
    x1,
    z0,
    z1,
    innerZ,
    outerZ,
    plate,
    button,
    stand,
    run,
    length,
    seconds,
  };
}

function build(
  ctx: Parameters<RoomModule<DeconLockParams>["build"]>[0],
  at: Parameters<RoomModule<DeconLockParams>["build"]>[1],
  p: DeconLockParams,
): RoomPlan {
  const lay = deconLayout(p);
  const { x0, xp, lx0, x1, z0, z1, innerZ, outerZ, plate, button } = lay;
  const s = buildShell(ctx, at, {
    length: x1 - x0,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: "far", at: outerZ, door: true },
    floor: "lab_floor_tile",
    walls: "lab_wall",
    farWall: "metal_panel",
    ceiling: "ceiling_panel",
    noFloor: true,
    acoustics: "lab",
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;
  const exitDoor = s.exitDoor!;
  const dw = DOORWAY.width;
  const i0 = innerZ - dw / 2;
  const i1 = innerZ + dw / 2;

  // --- Floors: hall tiles with a hazard ring round the plate; the lock's
  // floor metal with a flush drain grate --------------------------------------
  const ph = DECON_PLATE / 2;
  const rg = 0.15;
  const ring = [
    {
      x0: plate.x - ph - rg,
      z0: plate.z - ph - rg,
      x1: plate.x + ph + rg,
      z1: plate.z - ph,
    },
    {
      x0: plate.x - ph - rg,
      z0: plate.z + ph,
      x1: plate.x + ph + rg,
      z1: plate.z + ph + rg,
    },
    {
      x0: plate.x - ph - rg,
      z0: plate.z - ph,
      x1: plate.x - ph,
      z1: plate.z + ph,
    },
    {
      x0: plate.x + ph,
      z0: plate.z - ph,
      x1: plate.x + ph + rg,
      z1: plate.z + ph,
    },
  ];
  tile(x0, z0, xp + W, z1, ring, (a, b, c, d) =>
    B(a, -W, b, c, 0, d, "lab_floor_tile"),
  );
  for (const r of ring) B(r.x0, -W, r.z0, r.x1, 0, r.z1, "hazard_stripe");
  const drain = {
    x0: lx0 + 0.6,
    z0: q((z0 + z1) / 2) - 0.5,
    x1: x1 - 0.6,
    z1: q((z0 + z1) / 2) + 0.5,
  };
  tile(xp + W, z0, x1, z1, [drain], (a, b, c, d) =>
    B(a, -W, b, c, 0, d, "metal_panel"),
  );
  B(drain.x0, -0.045, drain.z0, drain.x1, 0, drain.z1, "metal_grate");
  B(drain.x0, -W, drain.z0, drain.x1, -0.2, drain.z1, "concrete_floor");

  // --- The partition with the inner door (D1) -------------------------------
  B(xp, 0, z0, lx0, h, i0, "metal_panel");
  B(xp, 0, i1, lx0, h, z1, "metal_panel");
  B(xp, 2.4, i0, lx0, h, i1, "metal_panel");
  k.frameX(xp, -1, i0, i1, 2.4);
  k.frameX(lx0, 1, i0, i1, 2.4);
  const inner = k.door(ctx.id("door_inner"), "x", xp, lx0, i0, i1, 2.4);
  signX(k, xp, -1, i1 + 0.35, i1 + 0.95, 1.4, 2.1);
  // The way out of the lock: a timed button beside the inner door.
  const innerButton = k.button(
    ctx.id("button_inner"),
    inner.id,
    lx0 + BUTTON_DEPTH,
    1.2,
    i1 + 0.5,
    [1, 0],
    "timed",
    INNER_SECONDS,
  );

  // --- The plate that holds the inner door ---------------------------------
  const plateId = ctx.id("plate_inner");
  ctx.plate({
    id: plateId,
    box: F.box(plate.x - ph, 0, plate.z - ph, plate.x + ph, 0.04, plate.z + ph),
    requiredMass: p.requiredMass,
    target: inner.id,
  });
  lamp(k, plate.x, plate.z, h, WARM, 5, 1.5, { hx: 0.35, hz: 0.35 });

  // --- The exit door's timed button on the left wall -----------------------
  B(button.x - 0.3, 0.85, z0, button.x + 0.3, 1.55, z0 + 0.02, "hazard_stripe");
  const timed = k.button(
    ctx.id("button_exit"),
    exitDoor.id,
    button.x,
    1.2,
    z0 + 0.02 + BUTTON_DEPTH,
    [0, 1],
    "timed",
    lay.seconds,
  );
  signZ(k, z0, 1, button.x - 0.4, button.x + 0.4, 1.75, 2.35);
  lamp(k, button.x, z0 + 1.2, h, WARM, 4.5, 1.3, { hx: 0.25, hz: 0.25 });

  // --- The lock: showers, signs, cool light ---------------------------------
  for (const fz of [q((z0 + z1) / 2) - 1.2, q((z0 + z1) / 2) + 1.2]) {
    const fx = q((lx0 + x1) / 2);
    B(fx - 0.04, h - 0.6, fz - 0.04, fx + 0.04, h, fz + 0.04, "pipe");
    B(
      fx - 0.15,
      h - 0.68,
      fz - 0.15,
      fx + 0.15,
      h - 0.6,
      fz + 0.15,
      "metal_panel",
    );
  }
  B(lx0, 2.55, z0, x1, 2.7, z0 + 0.04, "hazard_stripe");
  B(lx0, 2.55, z1 - 0.04, x1, 2.7, z1, "hazard_stripe");
  signX(k, x1, -1, s.exitLo - 0.95, s.exitLo - 0.35, 1.3, 2.0);
  lamp(k, q((lx0 + x1) / 2), q((z0 + z1) / 2), h, [0.6, 1.0, 0.75], 5, 1.3, {
    hz: 0.3,
  });

  // --- Hall dressing: lockers, a bench, a suit rack -------------------------
  for (let x = x0 + 1.4; x + 0.55 < button.x - 0.7; x += 0.6) {
    cabinet(
      k,
      x,
      z0,
      x + 0.55,
      z0 + 0.5,
      1.9,
      "+z",
      "metal_panel",
      "rubber_dark",
      [0.2, 1.8],
    );
  }
  desk(
    k,
    button.x + 1.0,
    z0,
    Math.min(button.x + 2.6, xp - 0.4),
    z0 + 0.6,
    0.45,
    "metal_panel",
  );
  // A suit rack along the right wall past the plate.
  const rx0 = plate.x + 1.6;
  const rx1 = Math.min(rx0 + 2.0, xp - 2.6);
  if (rx1 - rx0 > 0.8) {
    B(rx0 + 0.05, 1.85, z1 - 0.35, rx1 - 0.05, 1.9, z1 - 0.3, "pipe");
    B(rx0, 0, z1 - 0.35, rx0 + 0.05, 1.9, z1 - 0.3, "metal_panel");
    B(rx1 - 0.05, 0, z1 - 0.35, rx1, 1.9, z1 - 0.3, "metal_panel");
    for (let x = rx0 + 0.25; x + 0.3 < rx1; x += 0.45) {
      B(x, 0.7, z1 - 0.5, x + 0.3, 1.8, z1 - 0.15, "plastic_white");
    }
  }
  lamp(k, q(x0 + p.hall * 0.55), q((z0 + z1) / 2 + 0.8), h, COOL, 7, 1.0);

  // --- Equipment crates and a drum: the weight ---------------------------------
  const spots = [
    { x: q(x0 + p.hall * 0.45), z: q(z1 - 1.0) },
    { x: q(x0 + p.hall * 0.7), z: q(z1 - 1.0) },
    { x: q(x0 + p.hall * 0.3), z: z0 + 1.2 },
  ];
  const crates = spots.map((c) =>
    k.propTurned("crate_wood", c.x, 0, c.z, rng.range(-0.2, 0.2)),
  );
  k.propTurned("barrel", q(xp - 0.8), 0, q(z1 - 0.8), 0);

  // --- Solution ------------------------------------------------------------------
  const P = s.P;
  const half = PROP_SPECS.crate_wood.halfExtents.y;
  const rest = 0.04 + half;
  // Approach from the far side of the plate, so the player never stands on it.
  const from = P(plate.x + 2.0, plate.z - 0.2);
  const solution: SolutionStep[] = [
    { do: "walk", to: from },
    { do: "carry", prop: crates[0], to: F.point(plate.x, rest, plate.z) },
    { do: "walk", to: from },
    {
      do: "carry",
      prop: crates[1],
      to: F.point(plate.x, rest + 2 * half, plate.z),
    },
    { do: "wait", for: "plate_down", seconds: 3 },
    { do: "walk", to: P(lay.stand.x, lay.stand.z) },
    { do: "press", button: timed.id },
    ...lay.run
      .slice(1, 4)
      .map((r): SolutionStep => ({ do: "walk", to: P(r.x, r.z) })),
  ];
  // The last walk ends just before the exit doorway, as the contract wants.
  solution[solution.length - 1] = { do: "walk", to: s.before };
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "timed-door",
      doors: [inner.id, exitDoor.id],
      buttons: [timed.id, innerButton.id],
      plates: [plateId],
      keys: crates.slice(0, 2).map((prop, i) => ({
        prop,
        at: F.point(spots[i].x, half, spots[i].z),
      })),
    },
    solution,
  };
}

export const DECON_LOCK: RoomModule<DeconLockParams> = {
  name: "decon-lock",
  role: "middle",
  teaches: "timed-door",
  difficulty: 3,
  requires: {},
  // A plate-held door, then a timed door: both taught before.
  after: ["weighted-plate", "timed-door"],
  entrySize: ENTRY_SIZE,
  defaults: {
    hall: 10,
    lock: 2.8,
    left: 4.2,
    right: 4.0,
    height: 3.6,
    requiredMass: 45,
    inner: 0.3,
    outer: 0.6,
  },
  random,
  build,
};
