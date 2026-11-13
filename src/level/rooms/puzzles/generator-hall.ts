/**
 * Generator hall (impact target, across open floor). A tall machine hall:
 * diesel gensets along the walls with exhaust stacks to the roof, a fuel
 * tank, a control desk. The exit door in the far wall is latched open by an
 * impact target high on the same wall (3.9 to 4.5 m up, well out of reach
 * of the use key), on a striped plate under a red lamp with a warning sign.
 * Small crates, monitors and a chair lie about the open floor in front of
 * it: pick one up and throw it at the target.
 *
 *   top view (not mirrored)
 *
 *   +====== genset ==== stack =================================+
 *   | tank                            crate      crate         |
 *   E entry                                    (throw spot)  [T] EXIT
 *   |              desk+monitors    crate                       |
 *   +====== genset ==== stack =================================+
 *
 * Softlocks: none. The target latches the door open for good. Everything
 * thrown falls back to the floor or onto a genset (1.3 m, within reach):
 * there is nowhere higher for a prop to stay (stacks and pipes run to the
 * roof, the beams are flush with it). There are four to six throwables.
 */
import type { SolutionStep } from "../../../core/api";
import type { Rng } from "../../../core/rng";
import { IMPACT_BUTTON_DEPTH, type RoomModule, type RoomPlan } from "../room";
import { WALL as W } from "../room";
import {
  beams,
  desk,
  lamp,
  pipeAlongX,
  RED,
  signX,
  SODIUM,
  tank,
} from "./dress";
import { buildShell, ENTRY_SIZE } from "./shell";
import { pick, q } from "./util";

export interface GeneratorHallParams {
  length: number;
  left: number;
  right: number;
  height: number;
  /** Height of the target's centre. */
  targetY: number;
  /** Target's offset along the far wall from the exit door's axis. */
  targetOffset: number;
  /** Exit position along the far wall (fraction of the usable span). */
  exit: number;
  /** Small crates on the floor (2 to 4; plus two monitors and a chair). */
  crates: number;
  /** Gensets: on the left wall only, or both walls. */
  gensets: 1 | 2;
}

export const GENERATOR_HALL_RANGES = {
  length: [9, 12],
  left: [3.6, 4.6],
  right: [3.6, 4.6],
  height: [5.0, 5.6],
  targetY: [3.9, 4.5],
  targetOffset: [-1.4, 1.4],
  exit: [0, 1],
  crates: [2, 4],
} as const;

const R = GENERATOR_HALL_RANGES;
/** Distance of the throw spot from the far wall. */
export const THROW_BACK = 3.4;

function random(rng: Rng): GeneratorHallParams {
  return {
    length: pick(rng, R.length),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    targetY: pick(rng, R.targetY),
    targetOffset: pick(rng, R.targetOffset),
    exit: pick(rng, R.exit),
    crates: rng.int(...R.crates),
    gensets: rng.next() < 0.5 ? 1 : 2,
  };
}

export function generatorHallLayout(p: GeneratorHallParams) {
  const x0 = W;
  const x1 = x0 + p.length;
  const z0 = -p.left;
  const z1 = p.right;
  const e0 = z0 + 2.3;
  const e1 = z1 - 1.2;
  const exitZ = q(e0 + (e1 - e0) * p.exit);
  const targetZ = q(
    Math.min(z1 - 2.0, Math.max(z0 + 2.0, exitZ + p.targetOffset)),
  );
  const face = x1 - 0.02;
  const target = { x: face - IMPACT_BUTTON_DEPTH, y: p.targetY, z: targetZ };
  const throwSpot = { x: q(x1 - THROW_BACK), z: targetZ };
  return { x0, x1, z0, z1, exitZ, target, face, throwSpot };
}

function genset(
  k: Parameters<typeof tank>[0],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  side: 1 | -1,
  ceil: number,
): void {
  // Body on rubber feet, a control panel on the room side, an exhaust
  // stack from its top to the roof.
  const B = k.box;
  B(x0 + 0.1, 0, z0 + 0.1, x0 + 0.3, 0.12, z1 - 0.1, "rubber_dark");
  B(x1 - 0.3, 0, z0 + 0.1, x1 - 0.1, 0.12, z1 - 0.1, "rubber_dark");
  B(x0, 0.12, z0, x1, 1.3, z1, "metal_panel");
  B(x0 + 0.2, 1.3, z0 + 0.15, x0 + 0.9, 1.32, z1 - 0.15, "metal_grate");
  const front = side > 0 ? z1 : z0;
  const d = side > 0 ? 0.02 : -0.02;
  const fz0 = Math.min(front, front + d);
  const fz1 = Math.max(front, front + d);
  B(x1 - 0.9, 0.5, fz0, x1 - 0.3, 1.0, fz1, "monitor_screen");
  B(x0 + 0.4, 0.3, fz0, x1 - 1.1, 0.9, fz1, "hazard_stripe");
  const sx = x0 + 1.2;
  const sz = (z0 + z1) / 2 - 0.15;
  B(sx, 1.3, sz, sx + 0.3, ceil, sz + 0.3, "pipe");
  B(sx - 0.05, 1.3, sz - 0.05, sx + 0.35, 1.45, sz + 0.35, "rubber_dark");
}

function build(
  ctx: Parameters<RoomModule<GeneratorHallParams>["build"]>[0],
  at: Parameters<RoomModule<GeneratorHallParams>["build"]>[1],
  p: GeneratorHallParams,
): RoomPlan {
  const lay = generatorHallLayout(p);
  const { x0, x1, z0, z1, exitZ, target, face, throwSpot } = lay;
  const s = buildShell(ctx, at, {
    length: p.length,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: "far", at: exitZ, door: true },
    floor: "concrete_floor",
    walls: "concrete_wall",
    farWall: "metal_panel",
    ceiling: "metal_panel",
    acoustics: "hall",
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;

  // --- The target: striped plate, impact unit, sign, red lamp --------------
  const t = target;
  B(face, t.y - 0.35, t.z - 0.35, x1, t.y + 0.35, t.z + 0.35, "hazard_stripe");
  const button = k.button(
    ctx.id("target_exit"),
    s.exitDoor!.id,
    t.x,
    t.y,
    t.z,
    [-1, 0],
    "impact",
  );
  signX(k, x1, -1, t.z - 0.4, t.z + 0.4, t.y - 1.2, t.y - 0.55);
  lamp(k, x1 - 1.3, t.z, h, RED, 4.5, 1.6, {
    hx: 0.2,
    hz: 0.2,
    material: "button_red",
  });
  lamp(k, x1 - 2.6, q((t.z + exitZ) / 2), h, SODIUM, 7, 1.3);

  // --- Machines ----------------------------------------------------------------
  const gx0 = x0 + 2.0;
  const gx1 = Math.min(x0 + 4.6, x1 - THROW_BACK - 1.5);
  if (gx1 - gx0 > 1.8) {
    genset(k, gx0, z0 + 0.2, gx1, z0 + 1.4, 1, h);
    if (p.gensets === 2) genset(k, gx0, z1 - 1.4, gx1, z1 - 0.2, -1, h);
  }
  // Fuel tank in the entry corner on the left.
  tank(k, x0 + 0.3, z0 + 0.3, x0 + 1.3, z0 + 1.3, 1.25, "metal_panel");
  // Control desk on the right wall past the gensets, with monitors on it.
  const dx0 = gx1 + 0.8;
  const dx1 = Math.min(dx0 + 1.6, x1 - THROW_BACK - 0.6);
  const throwables: number[] = [];
  if (dx1 - dx0 > 1.0) {
    desk(k, dx0, z1 - 0.8, dx1, z1, 0.85, "metal_panel");
    throwables.push(
      k.propTurned("monitor", dx0 + 0.4, 0.85, z1 - 0.4, Math.PI),
    );
    if (dx1 - dx0 > 1.4) {
      throwables.push(
        k.propTurned("monitor", dx1 - 0.4, 0.85, z1 - 0.4, Math.PI + 0.3),
      );
    }
  } else {
    throwables.push(k.propTurned("monitor", x1 - 0.6, 0, z1 - 0.6, 0.5));
  }
  // Pipes along the side walls, tight under the roof; beams flush with it.
  pipeAlongX(k, x0, x1, z0, 1, h - 0.25, 0.2);
  pipeAlongX(k, x0, x1, z1, -1, h - 0.25, 0.2);
  const bxs: number[] = [];
  for (let x = x0 + 1.5; x < x1 - 0.5; x += 2.5) {
    if (Math.abs(x - (x1 - 1.3)) > 0.5 && Math.abs(x - (x1 - 2.6)) > 0.5) {
      bxs.push(q(x));
    }
  }
  beams(k, bxs, z0 + 0.25, z1 - 0.25, h, 0.3);
  lamp(k, q(x0 + 3.3), 0, h, SODIUM, 7.5, 1.1);
  k.emitter("hum_machine", gx0 + 1.0, 1.0, z0 + 0.8, 0.5);
  signX(k, x1, -1, s.exitLo - 0.95, s.exitLo - 0.35, 1.3, 2.0);

  // --- Throwables: small crates scattered in front of the target, a chair --
  // Ahead of the throw spot on the side away from the exit, behind it on
  // the side away from the entry axis: off the ways in and out.
  const tz = throwSpot.z;
  const away = tz - exitZ >= 0 ? 1 : -1;
  const out = tz >= 0 ? 1 : -1;
  const spots = [
    { x: throwSpot.x + 0.9, z: q(tz + away * 1.3) },
    { x: throwSpot.x - 1.0, z: q(tz + out * 1.4) },
    { x: throwSpot.x + 2.0, z: q(tz + away * 0.9) },
    { x: throwSpot.x - 2.2, z: q(tz + out * 1.1) },
    { x: throwSpot.x + 1.6, z: q(tz + away * 2.2) },
  ]
    .map((c) => ({
      x: Math.min(x1 - 0.6, Math.max(x0 + 0.6, c.x)),
      z: Math.min(z1 - 0.6, Math.max(z0 + 0.6, c.z)),
    }))
    .filter(
      (c) =>
        !(
          c.x > gx0 - 0.5 &&
          c.x < gx1 + 0.5 &&
          (c.z < z0 + 1.9 || c.z > z1 - 1.9)
        ),
    );
  const crates = spots
    .slice(0, p.crates)
    .map((c) =>
      k.propTurned("crate_wood_small", c.x, 0, c.z, rng.range(-0.4, 0.4)),
    );
  throwables.unshift(...crates);
  throwables.push(
    k.propTurned("chair", q(x0 + 1.5), 0, q(z1 - 1.2), rng.range(0, 6)),
  );

  const P = s.P;
  const aim = F.point(t.x - 0.3, t.y, t.z);
  const solution: SolutionStep[] = [
    { do: "walk", to: P(throwSpot.x, throwSpot.z) },
    { do: "throw", prop: crates[0], at: aim },
    { do: "walk", to: s.before },
  ];
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "impact-target",
      doors: [s.exitDoor!.id],
      buttons: [button.id],
      plates: [],
      keys: crates.map((prop, i) => ({
        prop,
        at: F.point(spots[i].x, 0.25, spots[i].z),
      })),
    },
    solution,
  };
}

export const GENERATOR_HALL: RoomModule<GeneratorHallParams> = {
  name: "generator-hall",
  role: "middle",
  teaches: "impact-target",
  difficulty: 2,
  requires: {},
  entrySize: ENTRY_SIZE,
  defaults: {
    length: 10.5,
    left: 4.0,
    right: 4.0,
    height: 5.2,
    targetY: 4.2,
    targetOffset: 1.2,
    exit: 0.4,
    crates: 3,
    gensets: 2,
  },
  random,
  build,
};
