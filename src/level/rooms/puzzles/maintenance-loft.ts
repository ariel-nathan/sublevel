/**
 * Maintenance loft (climb). A workshop whose door control is up on the
 * loft along the far wall, 1.9 to 2.1 m up: out of reach of a jump (1.0 m)
 * and of a crouch-jump (about 1.4 m), and too far back to press from the
 * floor. The exit door is at floor level in the left wall. Wooden crates
 * (0.8 m) lie about the workshop: build a staircase against the loft's
 * striped front (a stack of two against it, one in front as the first
 * step), climb it, press the button, jump down and leave.
 *
 *   top view (not mirrored)
 *
 *   x0                               xl            x1
 *   +============= EXIT ============|==============+
 *   |  bench   crate                |  loft        |
 *   E entry         crate     [clear base]  rail  [BTN]
 *   |  cabinets      crate          |              |
 *   +===============================|==============+
 *
 * PENDING: the solution format has no step for climbing onto props (a
 * `walk` is on brush floor only), so this module is not registered for the
 * generator; development levels can name it (`?rooms=maintenance-loft`).
 * Its declared solution expresses each climb as a `walk` whose target is
 * higher than the feet (prove.ts plays that as a walk holding jump).
 *
 * Softlocks: none. Four crates, three needed, all on the floor where they
 * cannot be lost (the loft is open, and anything on it can be pushed or
 * carried back down; nothing up high but the loft); the button toggles,
 * so the door can always be reopened from the loft.
 */
import type { SolutionStep } from "../../../core/api";
import { PROP_SPECS } from "../../../core/props";
import type { Rng } from "../../../core/rng";
import { BUTTON_DEPTH, type RoomModule, type RoomPlan } from "../room";
import { WALL as W } from "../room";
import { cabinet, COOL, desk, lamp, signX, WARM } from "./dress";
import { buildShell, ENTRY_SIZE, tile } from "./shell";
import { pick, q } from "./util";

export interface MaintenanceLoftParams {
  /** Floor length in front of the loft. */
  floor: number;
  /** Loft depth and deck height. */
  loft: number;
  deck: number;
  left: number;
  right: number;
  height: number;
  /** Where the climb spot is across the loft (fraction). */
  climb: number;
}

export const MAINTENANCE_LOFT_RANGES = {
  floor: [7, 8.5],
  loft: [2.0, 2.4],
  deck: [1.9, 2.1],
  left: [3.4, 4.0],
  right: [3.4, 4.0],
  height: [4.4, 5.0],
  climb: [0, 1],
} as const;

const R = MAINTENANCE_LOFT_RANGES;

function random(rng: Rng): MaintenanceLoftParams {
  return {
    floor: pick(rng, R.floor),
    loft: pick(rng, R.loft),
    deck: pick(rng, R.deck),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    climb: pick(rng, R.climb),
  };
}

export function loftLayout(p: MaintenanceLoftParams) {
  const x0 = W;
  const xl = x0 + p.floor;
  const x1 = q(xl + p.loft);
  const z0 = -p.left;
  const z1 = p.right;
  const c0 = z0 + 1.2;
  const c1 = z1 - 1.2;
  const cz = q(c0 + (c1 - c0) * p.climb);
  const half = PROP_SPECS.crate_wood.halfExtents.x;
  // The staircase: a stack of two against the loft, one step in front.
  const stack = { x: q(xl - half - 0.04), z: cz };
  const step = { x: q(stack.x - 2 * half - 0.2), z: cz };
  const button = {
    x: x1 - BUTTON_DEPTH,
    y: p.deck + 1.2,
    z: q(cz > 0 ? cz - 1.0 : cz + 1.0),
  };
  const exitX = q(Math.min(xl - 2.4, x0 + 3.2));
  return { x0, xl, x1, z0, z1, cz, stack, step, button, exitX };
}

function build(
  ctx: Parameters<RoomModule<MaintenanceLoftParams>["build"]>[0],
  at: Parameters<RoomModule<MaintenanceLoftParams>["build"]>[1],
  p: MaintenanceLoftParams,
): RoomPlan {
  const lay = loftLayout(p);
  const { x0, xl, x1, z0, z1, cz, stack, step, button, exitX } = lay;
  const H = p.deck;
  const s = buildShell(ctx, at, {
    length: x1 - x0,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: "left", at: exitX, door: true },
    floor: "concrete_floor",
    walls: "concrete_wall",
    ceiling: "metal_panel",
    noFloor: true,
    acoustics: "hall",
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;

  // --- Floor with a flush striped "keep clear" base at the climb spot ------
  const base = { x0: step.x - 0.6, z0: cz - 1.0, x1: xl, z1: cz + 1.0 };
  tile(x0, z0, xl, z1, [base], (a, b, c, d) =>
    B(a, -W, b, c, 0, d, "concrete_floor"),
  );
  B(base.x0, -W, base.z0, base.x1, 0, base.z1, "hazard_stripe");

  // --- The loft: a solid block with a grated deck, a striped front, rails --
  B(xl, -W, z0, x1, H - 0.05, z1, "metal_panel");
  B(xl, H - 0.05, z0, x1, H, z1, "metal_grate");
  B(xl - 0.03, H - 0.35, z0, xl, H - 0.1, z1, "hazard_stripe");
  // Railing on the deck's edge, open over the climb spot.
  const gap0 = cz - 1.3;
  const gap1 = cz + 1.3;
  for (const [a, b] of [
    [z0, gap0 - 0.15],
    [gap1 + 0.15, z1],
  ]) {
    if (b - a < 0.3) continue;
    for (
      let z = a;
      z <= b - 0.06;
      z += Math.max(0.6, (b - a - 0.06) / Math.ceil((b - a) / 1.4))
    ) {
      B(xl + 0.05, H, z, xl + 0.11, H + 1.0, z + 0.06, "metal_panel");
    }
    B(xl + 0.04, H + 1.0, a, xl + 0.12, H + 1.06, b, "pipe");
  }
  B(xl + 0.03, H, gap0 - 0.1, xl + 0.13, H + 1.15, gap0, "hazard_stripe");
  B(xl + 0.03, H, gap1, xl + 0.13, H + 1.15, gap1 + 0.1, "hazard_stripe");
  // The door control on the far wall above the deck, under a sign and a lamp.
  B(
    x1 - 0.02,
    button.y - 0.35,
    button.z - 0.3,
    x1,
    button.y + 0.35,
    button.z + 0.3,
    "hazard_stripe",
  );
  const toggle = k.button(
    ctx.id("button_exit"),
    s.exitDoor!.id,
    button.x - 0.02,
    button.y,
    button.z,
    [-1, 0],
  );
  signX(
    k,
    x1,
    -1,
    button.z - 0.4,
    button.z + 0.4,
    button.y + 0.5,
    Math.min(button.y + 1.1, h - 0.2),
  );
  B(x1 - 0.5, H, button.z + 0.7, x1, H + 1.0, button.z + 1.3, "metal_panel");
  B(
    x1 - 0.52,
    H + 0.4,
    button.z + 0.8,
    x1 - 0.5,
    H + 0.8,
    button.z + 1.2,
    "monitor_screen",
  );
  lamp(k, q(x1 - 1.0), button.z, h, WARM, 5.5, 1.5);

  // --- Workshop floor dressing --------------------------------------------
  desk(k, x0 + 0.1, z1 - 0.8, x0 + 2.2, z1 - 0.05, 0.9, "metal_panel");
  B(x0 + 0.4, 0.9, z1 - 0.6, x0 + 0.9, 1.2, z1 - 0.2, "rubber_dark");
  for (let x = x0 + 1.2; x + 0.6 < exitX - 0.95 - 0.1; x += 0.65) {
    cabinet(k, x, z0, x + 0.6, z0 + 0.5, rng.next() < 0.5 ? 1.4 : 1.9, "+z");
  }
  // A machine tool on the right, clear of the base.
  const mx0 = q(x0 + 3.0);
  if (mx0 + 1.6 < base.x0 - 0.6) {
    B(mx0, 0, z1 - 1.1, mx0 + 1.6, 1.0, z1 - 0.2, "metal_panel");
    B(mx0 + 0.2, 1.0, z1 - 0.9, mx0 + 0.6, 1.5, z1 - 0.5, "rubber_dark");
  }
  signX(k, x0, 1, z0 + 0.6, -s.entryHalf - 0.45, 1.4, 2.0);
  lamp(k, q(x0 + p.floor * 0.4), 0, h, COOL, 7.5, 1.1);
  lamp(k, q(xl - 1.0), cz, h, WARM, 5, 1.2);
  k.emitter("hum_machine", x0 + 3.5, 1.0, z1 - 0.5, 0.3);

  // --- Crates: four on the floor, three make the staircase -----------------
  const half = PROP_SPECS.crate_wood.halfExtents.y;
  const spots = [
    { x: q(x0 + p.floor * 0.45), z: q(cz > 0 ? cz - 1.8 : cz + 1.8) },
    { x: q(x0 + p.floor * 0.3), z: q(cz > 0 ? z0 + 1.6 : z1 - 1.8) },
    { x: q(x0 + p.floor * 0.6), z: q(cz > 0 ? z0 + 1.5 : z1 - 1.6) },
    { x: q(x0 + 1.2), z: q(cz > 0 ? z1 - 1.9 : z0 + 1.6) },
  ];
  const crates = spots.map((c) =>
    k.propTurned("crate_wood", c.x, 0, c.z, rng.range(-0.15, 0.15)),
  );

  // --- Solution ------------------------------------------------------------------
  const P = s.P;
  const from = P(q(step.x - 1.6), cz);
  const down = q(cz > 0 ? cz - 0.85 : cz + 0.85);
  const solution: SolutionStep[] = [
    { do: "walk", to: from },
    { do: "carry", prop: crates[0], to: F.point(stack.x, half, stack.z) },
    { do: "walk", to: from },
    { do: "carry", prop: crates[1], to: F.point(stack.x, 3 * half, stack.z) },
    { do: "walk", to: from },
    { do: "carry", prop: crates[2], to: F.point(step.x, half, step.z) },
    { do: "walk", to: from },
    // The climbs (feet heights rise: see the header).
    { do: "walk", to: F.point(step.x, 2 * half, step.z) },
    { do: "walk", to: F.point(stack.x, 4 * half, stack.z) },
    { do: "walk", to: F.point(xl + 0.8, H, cz) },
    { do: "walk", to: F.point(button.x - 1.0, H, button.z) },
    { do: "press", button: toggle.id },
    // Down off the loft's edge beside the staircase (the gap in the rail
    // leaves 0.85 m either side of it), and out.
    { do: "walk", to: F.point(xl + 0.5, H, down) },
    { do: "walk", to: P(xl - 1.0, down) },
    { do: "walk", to: P(step.x - 0.9, down) },
    { do: "walk", to: s.before },
  ];
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "climb",
      doors: [s.exitDoor!.id],
      buttons: [toggle.id],
      plates: [],
      keys: crates.slice(0, 3).map((prop, i) => ({
        prop,
        at: F.point(spots[i].x, half, spots[i].z),
      })),
    },
    solution,
  };
}

export const MAINTENANCE_LOFT: RoomModule<MaintenanceLoftParams> = {
  name: "maintenance-loft",
  role: "middle",
  teaches: "climb",
  difficulty: 2,
  requires: {},
  entrySize: ENTRY_SIZE,
  defaults: {
    floor: 7.5,
    loft: 2.2,
    deck: 2.0,
    left: 3.6,
    right: 3.6,
    height: 4.6,
    climb: 0.5,
  },
  random,
  build,
};
