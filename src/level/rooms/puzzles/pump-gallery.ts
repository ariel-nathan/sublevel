/**
 * Pump gallery (timed door, wedge). A long pump hall split lengthwise by a
 * row of pump tanks (floor to ceiling, grilles between them): the main floor
 * on the right, a service lane on the left. The lane ends in a cross wall
 * with the pump-house door (1.8 m wide), behind which a short vestibule has
 * the exit. The door's timed button is on the main floor side, on the wall
 * just past the tanks: from there the door is a step away through an
 * inspection hatch in the grille (1.15 to 2.0 m up: a crate passes, a
 * player does not), but the walk round the end of the tank row and back up
 * the lane is far longer than the door stays open. Press, push a small
 * crate through the hatch into the doorway: the closing door meets it and
 * reopens, for as long as it is there.
 *
 *   top view (not mirrored)
 *
 *   x0     xg                                   xq  xq+0.3        x1
 *   +======|======================================|================+
 *   |      |  service lane (pipes)                D   vestibule  EXIT
 *   E      |=[tank]=[tank]=[tank]=[tank]=[tank]=|hatch|===========|
 *   |          main floor        pumps         crate [BTN]         |
 *   +==============================================================+
 *
 * Softlocks: none. The lane always leads back to the main floor; nothing
 * thrown through the hatch is lost (it lands in the lane, which is open at
 * its near end); tank tops are flush with the roof. The vestibule has a
 * timed button for the door. Without a wedge the door simply closes again.
 */
import type { SolutionStep } from "../../../core/api";
import { PROP_SPECS } from "../../../core/props";
import type { Rng } from "../../../core/rng";
import { BUTTON_DEPTH, type RoomModule, type RoomPlan } from "../room";
import { WALL as W } from "../room";
import { COOL, lamp, signX, signZ, WARM } from "./dress";
import { buildShell, ENTRY_SIZE } from "./shell";
import { pick, q } from "./util";

export interface PumpGalleryParams {
  length: number;
  /** Lane width (left of the tank row). */
  lane: number;
  /** Main floor width (right of the tank row). */
  main: number;
  height: number;
  /** Depth of the vestibule past the cross wall. */
  vestibule: number;
  flicker: boolean;
}

export const PUMP_GALLERY_RANGES = {
  length: [14, 15.5],
  lane: [3.4, 3.7],
  main: [3.4, 4.2],
  height: [4.0, 4.6],
  vestibule: [2.2, 2.6],
} as const;

const R = PUMP_GALLERY_RANGES;
/** Width of the timed door. */
export const PUMP_DOOR = 1.8;
/** Seconds the door stays open after a press. */
export const PUMP_SECONDS = 2.5;
const TANK_DEPTH = 0.9;
const HATCH = { y0: 1.15, y1: 2.0 };

function random(rng: Rng): PumpGalleryParams {
  return {
    length: pick(rng, R.length),
    lane: pick(rng, R.lane),
    main: pick(rng, R.main),
    height: pick(rng, R.height),
    vestibule: pick(rng, R.vestibule),
    flicker: rng.next() < 0.6,
  };
}

/** Where things are, in design coordinates, for the build and the tests. */
export function pumpLayout(p: PumpGalleryParams) {
  const x0 = W;
  const x1 = x0 + p.length;
  // The lane on the left: the entry axis (z = 0) runs along the main floor.
  const z0 = q(-p.lane - TANK_DEPTH - 1.0);
  const zb = z0 + p.lane;
  const zm = zb + TANK_DEPTH;
  const z1 = zm + p.main;
  const xg = x0 + 1.8;
  const xq = q(x1 - p.vestibule - W);
  const lo = zb - PUMP_DOOR;
  // The thin screen with the hatch, then the vestibule's solid side wall.
  const s0 = xq - 0.8;
  const s1 = xq + 1.5;
  const button = { x: q(xq + 2.1), z: zb + W + 0.02 + BUTTON_DEPTH };
  const stand = { x: button.x, z: button.z + 1.0 };
  const wedge = {
    x: xq + 0.15,
    y: PROP_SPECS.crate_wood_small.halfExtents.y,
    z: zb - 0.3,
  };
  const exitZ = q((z0 + zb) / 2);
  // A human's quickest way from the button to the door: back along the
  // tanks, round their end, up the lane, keeping 0.35 m off corners.
  const route = [
    stand,
    { x: xg - 0.35, z: zm + 0.35 },
    { x: xg - 0.35, z: zb - 0.35 },
    { x: xq, z: lo + 0.9 },
  ];
  let routeLength = 0;
  for (let i = 1; i < route.length; i++) {
    routeLength += Math.hypot(
      route[i].x - route[i - 1].x,
      route[i].z - route[i - 1].z,
    );
  }
  return {
    x0,
    x1,
    z0,
    z1,
    zb,
    zm,
    xg,
    xq,
    lo,
    s0,
    s1,
    button,
    stand,
    wedge,
    exitZ,
    route,
    routeLength,
  };
}

function build(
  ctx: Parameters<RoomModule<PumpGalleryParams>["build"]>[0],
  at: Parameters<RoomModule<PumpGalleryParams>["build"]>[1],
  p: PumpGalleryParams,
): RoomPlan {
  const lay = pumpLayout(p);
  const { x0, x1, z0, z1, zb, zm, xg, xq, lo, s0, s1, button, wedge, exitZ } =
    lay;
  const s = buildShell(ctx, at, {
    length: p.length,
    left: -z0,
    right: z1,
    height: p.height,
    exit: { side: "far", at: exitZ, door: false },
    floor: "concrete_floor",
    walls: "concrete_wall",
    farWall: "metal_panel",
    ceiling: "metal_panel",
    acoustics: "hall",
    returnSide: "right",
  });
  const { k, h, F } = s;
  const B = k.box;
  const rng = ctx.rng;

  // --- The tank row: tanks floor to roof, grilles in the gaps --------------
  const tanks: [number, number][] = [];
  for (let x = xg; x + 1.0 <= s0 - 0.35; x += 1.55) {
    tanks.push([x, Math.min(x + 1.25, s0 - 0.35)]);
  }
  const last = tanks.length > 0 ? tanks[tanks.length - 1][1] : xg;
  tanks.forEach(([a, b], i) => {
    B(a, 0, zb, b, h, zm, i % 2 ? "metal_panel" : "plastic_white");
    for (const y of [0.4, 2.2]) {
      B(
        a - 0.015,
        y,
        zb - 0.015,
        b + 0.015,
        y + 0.12,
        zm + 0.015,
        "hazard_stripe",
      );
    }
    B(a + 0.3, 1.2, zm + 0.015, b - 0.3, 1.6, zm + 0.035, "monitor_screen");
  });
  for (let i = 0; i + 1 < tanks.length; i++) {
    B(
      tanks[i][1] + 0.03,
      0,
      zb + 0.03,
      tanks[i + 1][0] - 0.03,
      h,
      zb + 0.07,
      "metal_grate",
    );
  }
  // From the last tank to the screen: a grille wall.
  if (s0 - last > 0.06) {
    B(last + 0.03, 0, zb + 0.03, s0, h, zb + 0.07, "metal_grate");
  }
  // The screen with the hatch: posts, grille under and over the hatch,
  // rails at its sill and lintel.
  B(s0, 0, zb, s0 + 0.1, h, zb + 0.1, "metal_panel");
  B(s1 - 0.1, 0, zb, s1, h, zb + 0.1, "metal_panel");
  B(
    s0 + 0.1,
    0,
    zb + 0.03,
    s1 - 0.1,
    HATCH.y0 - 0.06,
    zb + 0.07,
    "metal_grate",
  );
  B(
    s0 + 0.1,
    HATCH.y1 + 0.08,
    zb + 0.03,
    s1 - 0.1,
    h,
    zb + 0.07,
    "metal_grate",
  );
  B(
    s0 + 0.12,
    HATCH.y0 - 0.06,
    zb + 0.01,
    s1 - 0.12,
    HATCH.y0,
    zb + 0.09,
    "hazard_stripe",
  );
  B(
    s0 + 0.12,
    HATCH.y1,
    zb + 0.01,
    s1 - 0.12,
    HATCH.y1 + 0.08,
    zb + 0.09,
    "metal_panel",
  );
  // The vestibule's side wall, solid, from the screen to the far wall.
  B(s1, 0, zb, x1, h, zb + W, "concrete_wall");

  // --- The cross wall with the timed door ----------------------------------
  B(xq, 0, z0, xq + W, h, lo, "concrete_wall");
  B(xq, 2.4, lo, xq + W, h, zb, "concrete_wall");
  k.frameX(xq, -1, lo, zb, 2.4, { lo: true, hi: false });
  k.frameX(xq + W, 1, lo, zb, 2.4, { lo: true, hi: false });
  const door = k.door(ctx.id("door_pump"), "x", xq, xq + W, lo, zb, 2.4);
  const back = k.button(
    ctx.id("button_pump_back"),
    door.id,
    xq + W + BUTTON_DEPTH,
    1.2,
    lo - 0.6,
    [1, 0],
    "timed",
    5,
  );

  // --- The timed button, on the main floor side ------------------------------
  B(
    button.x - 0.3,
    0.85,
    zb + W,
    button.x + 0.3,
    1.55,
    zb + W + 0.02,
    "hazard_stripe",
  );
  const timed = k.button(
    ctx.id("button_pump"),
    door.id,
    button.x,
    1.2,
    zb + W + 0.02 + BUTTON_DEPTH,
    [0, 1],
    "timed",
    PUMP_SECONDS,
  );
  signZ(k, zb + W, 1, button.x - 0.45, button.x + 0.45, 1.75, 2.35);
  lamp(k, button.x - 0.4, button.z + 1.2, h, WARM, 5.5, 1.5, {
    hx: 0.25,
    hz: 0.25,
  });

  // --- The lane: pipework along the left wall, a flickering tube -------------
  for (const [y, d] of [
    [0.5, 0.35],
    [1.3, 0.25],
  ]) {
    B(xg - 0.6, y, z0, xq, y + d, z0 + d + 0.05, "pipe");
  }
  for (let x = xg; x < xq - 0.3; x += 2.0) {
    B(x, 0, z0, x + 0.12, 1.7, z0 + 0.5, "metal_panel");
  }
  const laneBounds = F.box(0, -W, z0 - W, xq + W, h + W, zb);
  if (p.flicker) {
    lamp(k, q((xg + xq) / 2), q(z0 + 1.6), h, COOL, 7, 1.1, {
      flicker: "fluorescent",
      bounds: laneBounds,
    });
    k.emitter("hum_fluorescent", q((xg + xq) / 2), h - 0.3, q(z0 + 1.6), 0.4);
  } else {
    lamp(k, q((xg + xq) / 2), q(z0 + 1.6), h, COOL, 7, 0.9);
  }
  lamp(k, q(xq - 1.5), q(lo + 0.6), h, COOL, 5, 1.0);
  B(xq - 0.03, 1.4, z0 + 0.5, xq, 2.2, z0 + 1.3, "sign_warning");

  // --- Main floor: pumps along the right wall, a console --------------------
  for (let x = x0 + 2.4; x + 1.4 < xq - 0.5; x += 2.6) {
    B(x, 0, z1 - 0.9, x + 1.4, 0.15, z1 - 0.1, "rubber_dark");
    B(x + 0.1, 0.15, z1 - 0.8, x + 1.3, 1.0, z1 - 0.2, "metal_panel");
    B(x + 0.4, 1.0, z1 - 0.65, x + 0.9, 1.5, z1 - 0.35, "pipe");
    B(x + 0.5, 1.5, z1 - 0.6, x + 0.8, h, z1 - 0.4, "pipe");
  }
  lamp(k, q(x0 + p.length * 0.35), q((zm + z1) / 2), h, COOL, 7.5, 1.0);
  lamp(k, q(x0 + p.length * 0.7), q((zm + z1) / 2), h, COOL, 7, 0.9);
  k.emitter("hum_machine", x0 + 3.0, 1.0, z1 - 0.5, 0.45);

  // --- Vestibule ------------------------------------------------------------
  lamp(k, q((xq + W + x1) / 2), exitZ, h, [0.55, 1.0, 0.65], 4.5, 1.3, {
    hx: 0.25,
    hz: 0.25,
  });
  signX(
    k,
    x1,
    -1,
    s.exitHi + 0.2,
    Math.min(s.exitHi + 0.8, zb - 0.1),
    1.3,
    2.0,
  );

  // --- Props: the wedge and spares, by the button ---------------------------
  const crate = k.propTurned(
    "crate_wood_small",
    q(xq + 0.9),
    0,
    q(zb + 0.7),
    0,
  );
  k.propTurned(
    "crate_wood_small",
    q(xq + 0.5),
    0,
    q(z1 - 0.6),
    rng.range(-0.3, 0.3),
  );
  k.propTurned("chair", q(x1 - 0.5), 0, q(z1 - 0.6), rng.range(0, 6));

  const P = s.P;
  const through = lo + 0.6;
  const solution: SolutionStep[] = [
    { do: "walk", to: P(lay.stand.x, lay.stand.z) },
    { do: "press", button: timed.id },
    { do: "carry", prop: crate, to: F.point(wedge.x, wedge.y, wedge.z) },
    { do: "walk", to: P(xq + 0.96, zm + 0.6) },
    { do: "walk", to: P(xg - 0.6, zm + 0.6) },
    { do: "walk", to: P(xg - 0.6, through) },
    { do: "walk", to: P(xq - 0.8, through) },
    { do: "walk", to: P(xq + W + 0.8, through) },
    { do: "walk", to: s.before },
  ];
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "timed-door",
      doors: [door.id],
      buttons: [timed.id, back.id],
      plates: [],
      keys: [{ prop: crate, at: F.point(q(xq + 0.9), 0.25, q(zb + 0.7)) }],
    },
    solution,
  };
}

export const PUMP_GALLERY: RoomModule<PumpGalleryParams> = {
  name: "pump-gallery",
  role: "middle",
  teaches: "timed-door",
  difficulty: 2,
  requires: {},
  idea: "timed-door-wedge",
  entrySize: ENTRY_SIZE,
  defaults: {
    length: 14.5,
    lane: 3.5,
    main: 3.8,
    height: 4.2,
    vestibule: 2.4,
    flicker: true,
  },
  random,
  build,
};
