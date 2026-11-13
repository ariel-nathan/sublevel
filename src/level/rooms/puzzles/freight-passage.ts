/**
 * Freight passage (heavy push). A freight lobby with dead lift doors,
 * pallets and a pallet truck; the only way on is a low cargo tunnel (1.2 m
 * wide, 1.9 to 2.05 m high) through a thick bulkhead into the dispatch
 * vestibule, where the exit is. The tunnel is plugged by a 60 kg metal
 * crate, too heavy to lift: walk into it and shove it through the tunnel
 * into the vestibule, where it is out of the way.
 *
 *   top view (not mirrored)
 *
 *   x0          xp0      xp1               x1
 *   +============|========|==================+
 *   | pallets    |bulkhead|  vestibule       |
 *   E entry   ===[crate]=>        (crate)    |
 *   | lift doors |        |            EXIT  |
 *   +============|========|=======|  |=======+
 *
 * The exit (no door) is in the vestibule's side wall on the side away from
 * the tunnel, so the crate never ends up in front of it.
 *
 * Softlocks: none. The crate cannot block anything for good: the tunnel is
 * the only passage narrower than crate plus player, and from either side
 * the crate can be pushed out of it again; every doorway is at least
 * 1.4 m wide. Nothing else is needed. (Alternative: a crouch-jump onto the
 * crate and a crawl over it, since 0.7 + 1.0 m fits under the tunnel's
 * roof.)
 */
import type { SolutionStep } from "../../../core/api";
import { PROP_SPECS } from "../../../core/props";
import type { Rng } from "../../../core/rng";
import { type RoomModule, type RoomPlan } from "../room";
import { WALL as W } from "../room";
import { COOL, lamp, signX, WARM } from "./dress";
import { buildShell, ENTRY_SIZE, tile } from "./shell";
import { pick, q } from "./util";

export interface FreightPassageParams {
  /** Length of the lobby (entry wall to bulkhead). */
  lobby: number;
  /** Bulkhead thickness: the tunnel's length. */
  tunnel: number;
  /** Tunnel height. */
  tunnelHeight: number;
  /** Vestibule depth. */
  vestibule: number;
  left: number;
  right: number;
  height: number;
  /** Tunnel's lateral position (fraction of the usable span). */
  tunnelAt: number;
}

export const FREIGHT_PASSAGE_RANGES = {
  lobby: [6, 8],
  tunnel: [1.6, 2.4],
  tunnelHeight: [1.9, 2.05],
  vestibule: [3.0, 3.6],
  left: [3.0, 3.8],
  right: [3.0, 3.8],
  height: [3.4, 4.0],
  tunnelAt: [0, 1],
} as const;

const R = FREIGHT_PASSAGE_RANGES;
export const TUNNEL_WIDTH = 1.2;

function random(rng: Rng): FreightPassageParams {
  return {
    lobby: pick(rng, R.lobby),
    tunnel: pick(rng, R.tunnel),
    tunnelHeight: pick(rng, R.tunnelHeight, 0.01),
    vestibule: pick(rng, R.vestibule),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    tunnelAt: pick(rng, R.tunnelAt),
  };
}

export function freightLayout(p: FreightPassageParams) {
  const x0 = W;
  const xp0 = x0 + p.lobby;
  const xp1 = q(xp0 + p.tunnel);
  const x1 = q(xp1 + p.vestibule);
  const z0 = -p.left;
  const z1 = p.right;
  const half = TUNNEL_WIDTH / 2;
  const t0 = z0 + 1.0 + half;
  const t1 = z1 - 1.0 - half;
  const tz = q(t0 + (t1 - t0) * p.tunnelAt);
  // The exit on the side wall away from the tunnel.
  const exitSide: "left" | "right" = tz > 0 ? "left" : "right";
  const exitX = q(xp1 + p.vestibule / 2);
  const crate = { x: q(xp0 + 0.45), z: tz };
  const parked = { x: q(xp1 + 1.3), z: tz };
  return { x0, x1, xp0, xp1, z0, z1, tz, half, exitSide, exitX, crate, parked };
}

function build(
  ctx: Parameters<RoomModule<FreightPassageParams>["build"]>[0],
  at: Parameters<RoomModule<FreightPassageParams>["build"]>[1],
  p: FreightPassageParams,
): RoomPlan {
  const lay = freightLayout(p);
  const { x0, x1, xp0, xp1, z0, z1, tz, half, exitSide, exitX } = lay;
  const s = buildShell(ctx, at, {
    length: x1 - x0,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: exitSide, at: exitX, door: false },
    floor: "concrete_floor",
    walls: "concrete_wall",
    ceiling: "metal_panel",
    noFloor: true,
    acoustics: "hall",
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;
  const th = p.tunnelHeight;

  // --- Floor: concrete, with a flush hazard band across the tunnel mouth
  // and a run of chevron tiles through the tunnel ------------------------
  const band = { x0: xp0 - 0.6, z0: tz - half, x1: xp0 - 0.3, z1: tz + half };
  const lane = { x0: xp0, z0: tz - 0.15, x1: xp1, z1: tz + 0.15 };
  tile(x0, z0, x1, z1, [band, lane], (a, b, c, d) =>
    B(a, -W, b, c, 0, d, "concrete_floor"),
  );
  B(band.x0, -W, band.z0, band.x1, 0, band.z1, "hazard_stripe");
  B(lane.x0, -W, lane.z0, lane.x1, 0, lane.z1, "hazard_stripe");

  // --- The bulkhead with the tunnel ---------------------------------------
  B(xp0, 0, z0, xp1, h, tz - half, "concrete_wall");
  B(xp0, 0, tz + half, xp1, h, z1, "concrete_wall");
  B(xp0, th, tz - half, xp1, h, tz + half, "concrete_wall");
  k.frameX(xp0, -1, tz - half, tz + half, th);
  k.frameX(xp1, 1, tz - half, tz + half, th);
  // A pipe along the tunnel roof, and a sign over the mouth.
  B(
    xp0 + 0.05,
    th - 0.12,
    tz + half - 0.2,
    xp1 - 0.05,
    th,
    tz + half - 0.08,
    "pipe",
  );
  signX(
    k,
    xp0,
    -1,
    tz - 0.45,
    tz + 0.45,
    th + 0.3,
    Math.min(th + 0.95, h - 0.2),
  );

  // --- Lobby dressing: dead freight lift, pallets, pallet truck ------------
  // Lift doors on the side wall opposite the tunnel's offset.
  const liftZ = tz > 0 ? z0 : z1;
  const ld = tz > 0 ? 1 : -1;
  const lx0 = x0 + 1.6;
  const lx1 = Math.min(lx0 + 2.4, xp0 - 1.0);
  if (lx1 - lx0 > 1.6) {
    const zz = (a: number, b: number): [number, number] =>
      ld > 0 ? [liftZ + a, liftZ + b] : [liftZ - b, liftZ - a];
    const [f0, f1] = zz(0, 0.12);
    B(lx0 - 0.2, 0, f0, lx0, 2.9, f1, "hazard_stripe");
    B(lx1, 0, f0, lx1 + 0.2, 2.9, f1, "hazard_stripe");
    B(lx0 - 0.2, 2.9, f0, lx1 + 0.2, 3.1, f1, "hazard_stripe");
    const [d0, d1] = zz(0, 0.06);
    const mid = (lx0 + lx1) / 2;
    B(lx0, 0, d0, mid - 0.01, 2.9, d1, "door_steel");
    B(mid + 0.01, 0, d0, lx1, 2.9, d1, "door_steel");
    const [c0, c1] = zz(0, 0.04);
    B(lx1 + 0.35, 1.1, c0, lx1 + 0.6, 1.5, c1, "monitor_screen");
  }
  // Pallets with stacked stock along the other wall.
  const pz = tz > 0 ? z1 : z0;
  const pd = tz > 0 ? -1 : 1;
  const pallet = (x: number, w: number) => {
    const zz = (a: number, b: number): [number, number] =>
      pd > 0 ? [pz + a, pz + b] : [pz - b, pz - a];
    const [a0, a1] = zz(0.1, 1.1);
    B(x, 0, a0, x + w, 0.14, a1, "crate_wood");
    const [b0, b1] = zz(0.15, 1.05);
    const tall = rng.next() < 0.5;
    B(
      x + 0.05,
      0.14,
      b0,
      x + w - 0.05,
      tall ? 1.5 : 0.9,
      b1,
      rng.next() < 0.5 ? "crate_wood" : "plastic_white",
    );
  };
  for (let x = x0 + 1.8; x + 1.1 < xp0 - 0.9; x += 1.5) pallet(x, 1.1);
  // A pallet truck parked by the entry.
  const tz0 = tz > 0 ? z1 - 0.9 : z0 + 0.3;
  B(x0 + 0.4, 0, tz0, x0 + 1.5, 0.1, tz0 + 0.6, "rubber_dark");
  B(x0 + 0.4, 0.1, tz0 + 0.05, x0 + 0.6, 1.0, tz0 + 0.55, "metal_panel");

  // --- The crate in the tunnel -------------------------------------------------
  const crate = k.prop("crate_metal", lay.crate.x, 0, lay.crate.z, 0);

  // --- Vestibule -----------------------------------------------------------
  const vz = exitSide === "left" ? z1 : z0;
  const vd = exitSide === "left" ? -1 : 1;
  B(
    xp1 + 0.6,
    1.0,
    Math.min(vz, vz + vd * 0.04),
    xp1 + 1.6,
    1.8,
    Math.max(vz, vz + vd * 0.04),
    "sign_warning",
  );
  const benchZ = exitSide === "left" ? [z1 - 0.6, z1] : [z0, z0 + 0.6];
  B(x1 - 0.6, 0, benchZ[0], x1, 0.45, benchZ[1], "metal_panel");

  // --- Lights ----------------------------------------------------------------
  lamp(k, q(x0 + p.lobby / 2), 0, h, WARM, 7.5, 1.2);
  lamp(k, q(xp0 - 1.0), tz, h, WARM, 4.5, 1.2, { hx: 0.25, hz: 0.25 });
  lamp(k, q((xp1 + x1) / 2), 0, h, COOL, 5.5, 1.3);
  k.emitter("hum_machine", x0 + 0.5, 1.0, tz0 + 0.3, 0.2);

  const P = s.P;
  const solution: SolutionStep[] = [
    { do: "walk", to: P(xp0 - 1.3, tz) },
    { do: "push", prop: crate, to: F.point(lay.parked.x, 0.35, lay.parked.z) },
    { do: "walk", to: P(xp1 + 0.5, exitSide === "left" ? z0 + 1.2 : z1 - 1.2) },
    { do: "walk", to: s.before },
  ];
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "push",
      doors: [],
      buttons: [],
      plates: [],
      keys: [
        {
          prop: crate,
          at: F.point(
            lay.crate.x,
            PROP_SPECS.crate_metal.halfExtents.y,
            lay.crate.z,
          ),
        },
      ],
    },
    solution,
  };
}

export const FREIGHT_PASSAGE: RoomModule<FreightPassageParams> = {
  name: "freight-passage",
  role: "middle",
  teaches: "push",
  difficulty: 1,
  requires: {},
  entrySize: ENTRY_SIZE,
  defaults: {
    lobby: 7,
    tunnel: 2.0,
    tunnelHeight: 1.95,
    vestibule: 3.2,
    left: 3.4,
    right: 3.4,
    height: 3.6,
    tunnelAt: 0.35,
  },
  random,
  build,
};
