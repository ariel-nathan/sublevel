/**
 * Records office (toggle button, the teaching room). A service counter runs
 * across the room from the left wall, leaving a gap by the right wall; the
 * front (customer side) has the exit door in the left wall, the back
 * (records side) has the door control on the far wall, on a striped plate
 * under a sign and a warm lamp, in plain view over the counter from the
 * entry. Walk round the counter's end, press it, come back out and leave.
 *
 *   top view (not mirrored), x into the room, z to the right
 *
 *   x0                    xc   xc+0.7               x1
 *   +======== left wall ==|=EXIT==|========================+
 *   |  cooler        exit door    [ counter ][ cabinets ]  |
 *   E entry                       [ counter ]       [BTN]  F
 *   |  desks, chairs              [ counter ]   rack       |
 *   |                              gap 1.4 m               |
 *   +======================================================+
 *
 * Parameters vary the size, where the counter stands, the button's place
 * on the far wall, how many desks and racks, and the lighting.
 *
 * Softlocks: none. The button toggles the door from any time; a door closed
 * on the player reopens; nothing needs a prop. Jumping the counter (a
 * crouch-jump) is a harmless short cut.
 */
import type { Rng } from "../../../core/rng";
import { BUTTON_DEPTH, type RoomModule, type RoomPlan } from "../room";
import { cabinet, COOL, desk, lamp, rack, signX, WARM } from "./dress";
import { buildShell, ENTRY_SIZE } from "./shell";
import { pick, q } from "./util";

export interface RecordsOfficeParams {
  /** Interior length, 9 to 12 m. */
  length: number;
  /** Interior extent left and right of the entry axis. */
  left: number;
  right: number;
  height: number;
  /** Where the counter stands, as a fraction of the length (0.45..0.6). */
  counter: number;
  /** The button's z on the far wall, as a fraction from left (0) to right (1) of the usable span. */
  button: number;
  desks: number;
  /** A flickering tube over the front. */
  flicker: boolean;
}

export const RECORDS_OFFICE_RANGES = {
  length: [9, 12],
  left: [3.2, 4.2],
  right: [3.4, 4.6],
  height: [3.0, 3.4],
  counter: [0.45, 0.6],
  button: [0, 1],
  desks: [1, 3],
} as const;

const R = RECORDS_OFFICE_RANGES;

function random(rng: Rng): RecordsOfficeParams {
  return {
    length: pick(rng, R.length),
    left: pick(rng, R.left),
    right: pick(rng, R.right),
    height: pick(rng, R.height),
    counter: pick(rng, R.counter, 0.01),
    button: pick(rng, R.button, 0.05),
    desks: rng.int(...R.desks),
    flicker: rng.next() < 0.5,
  };
}

/** Where things are, in design coordinates, for the build and the tests. */
export function officeLayout(p: RecordsOfficeParams) {
  const x0 = 0.3;
  const x1 = x0 + p.length;
  const z0 = -p.left;
  const z1 = p.right;
  const xc = q(x0 + p.counter * p.length);
  const gap = 1.4;
  const counterEnd = z1 - gap;
  const exitX = q(xc - 1.2);
  // The button on the far wall, between the left cabinets and the rack.
  const bz0 = z0 + 1.1;
  const bz1 = Math.min(z1 - 1.4, 0.8);
  const buttonZ = q(bz0 + (bz1 - bz0) * p.button);
  return { x0, x1, z0, z1, xc, gap, counterEnd, exitX, buttonZ };
}

function build(
  ctx: Parameters<RoomModule<RecordsOfficeParams>["build"]>[0],
  at: Parameters<RoomModule<RecordsOfficeParams>["build"]>[1],
  p: RecordsOfficeParams,
): RoomPlan {
  const lay = officeLayout(p);
  const { x0, x1, z0, z1, xc, counterEnd, exitX, buttonZ } = lay;
  const s = buildShell(ctx, at, {
    length: p.length,
    left: p.left,
    right: p.right,
    height: p.height,
    exit: { side: "left", at: exitX, door: true },
    floor: "lab_floor_tile",
    walls: "lab_wall",
    ceiling: "ceiling_panel",
    acoustics: "lab",
  });
  const { k, h } = s;
  const B = k.box;
  const rng = ctx.rng;

  // --- The counter: body, kick plate, worktop; monitors on it -------------
  B(xc, 0.1, z0, xc + 0.7, 1.0, counterEnd, "metal_panel");
  B(xc + 0.06, 0, z0, xc + 0.64, 0.1, counterEnd - 0.06, "rubber_dark");
  B(xc - 0.04, 1.0, z0, xc + 0.74, 1.05, counterEnd + 0.04, "plastic_white");
  // A modesty panel on the customer side, proud of the body.
  B(xc - 0.02, 0.25, z0 + 0.3, xc, 0.9, counterEnd - 0.3, "rubber_dark");
  const monitors: number[] = [];
  for (let z = z0 + 0.9; z < counterEnd - 0.5; z += 1.7) {
    monitors.push(k.propTurned("monitor", xc + 0.35, 1.05, z, Math.PI / 2));
  }

  // --- Records side: cabinets on the left wall, a rack on the right -------
  const cabX0 = xc + 1.3;
  for (let x = cabX0; x + 0.6 <= x1 - 0.1; x += 0.65) {
    const tall = rng.next() < 0.4;
    cabinet(
      k,
      x,
      z0,
      x + 0.6,
      z0 + 0.55,
      tall ? 1.9 : 1.3,
      "+z",
      "metal_panel",
      "plastic_white",
      [0.15, tall ? 1.75 : 1.15],
    );
  }
  const rackX0 = xc + 2.6;
  if (x1 - 0.1 - rackX0 > 1.2) {
    rack(k, rackX0, z1 - 0.5, x1 - 0.1, z1, [0.15, 0.75, 1.35, 1.95], 2.3, "x");
    // Box files on the boards.
    for (let x = rackX0 + 0.15; x + 0.35 < x1 - 0.2; x += 0.5) {
      for (const y of [0.19, 0.79, 1.39]) {
        if (rng.next() < 0.7) {
          B(
            x,
            y,
            z1 - 0.42,
            x + 0.3,
            y + 0.32,
            z1 - 0.08,
            rng.next() < 0.5 ? "crate_wood" : "plastic_white",
          );
        }
      }
    }
  }
  // A clerk's desk behind the counter, with a chair.
  desk(k, xc + 1.1, counterEnd - 1.6, xc + 1.9, counterEnd - 0.6);
  k.propTurned("chair", xc + 1.5, 0, counterEnd - 0.3, Math.PI);

  // --- The door control: striped plate, button, sign, warm lamp ----------
  B(x1 - 0.02, 0.85, buttonZ - 0.3, x1, 1.55, buttonZ + 0.3, "hazard_stripe");
  const button = k.button(
    ctx.id("button_exit"),
    s.exitDoor!.id,
    x1 - 0.02 - BUTTON_DEPTH,
    1.2,
    buttonZ,
    [-1, 0],
  );
  signX(k, x1, -1, buttonZ - 0.45, buttonZ + 0.45, 1.75, 2.35);
  lamp(k, x1 - 1.1, buttonZ, h, WARM, 5.5, 1.5);

  // --- Front: desks along the right wall, cooler, chairs, notice board ----
  for (let i = 0; i < p.desks; i++) {
    const dx = 1.7 + i * 1.5;
    if (dx + 1.2 > xc - 1.7) break;
    desk(k, dx, z1 - 0.85, dx + 1.2, z1 - 0.1);
    k.propTurned("chair", dx + 0.6, 0, z1 - 1.25, rng.range(-0.3, 0.3));
  }
  // Water cooler in the front left corner.
  B(x0 + 0.1, 0, z0 + 0.1, x0 + 0.45, 1.0, z0 + 0.45, "plastic_white");
  B(x0 + 0.13, 1.0, z0 + 0.13, x0 + 0.42, 1.35, z0 + 0.42, "monitor_screen");
  // Notice board on the entry wall, left of the doorway.
  signX(k, x0, 1, z0 + 0.7, -s.entryHalf - 0.45, 1.3, 2.1, "plastic_white");
  k.propTurned("crate_wood_small", x0 + 0.55, 0, z0 + 1.0, 0.2);

  // --- Lights -----------------------------------------------------------
  const frontX = q((x0 + xc) / 2);
  lamp(k, frontX, q(z0 / 2), h, COOL, 6.5, 1.1);
  if (p.flicker) {
    lamp(k, frontX, q(z1 / 2), h, COOL, 6, 1.0, {
      flicker: "fluorescent",
      bounds: s.F.box(0, -0.3, z0 - 0.3, x1 + 0.3, h + 0.3, z1 + 0.3),
    });
    k.emitter("hum_fluorescent", frontX, h - 0.3, q(z1 / 2), 0.35);
  } else {
    lamp(k, frontX, q(z1 / 2), h, COOL, 6, 1.0);
  }
  lamp(k, q(xc + 1.6), q(z0 + 1.2), h, COOL, 5, 0.7);

  const P = s.P;
  const gapZ = q(z1 - 0.85);
  const standX = x1 - 0.02 - BUTTON_DEPTH - 1.0;
  return {
    footprint: s.footprint,
    entry: s.entry,
    exits: [s.exitDoorway],
    lock: {
      kind: "toggle-button",
      doors: [s.exitDoor!.id],
      buttons: [button.id],
      plates: [],
      keys: [],
    },
    solution: [
      { do: "walk", to: P(xc - 1.2, 0) },
      { do: "walk", to: P(xc - 0.7, gapZ) },
      { do: "walk", to: P(xc + 1.2, gapZ) },
      { do: "walk", to: P(standX, gapZ) },
      { do: "walk", to: P(standX, buttonZ) },
      { do: "press", button: button.id },
      { do: "walk", to: P(standX, gapZ) },
      { do: "walk", to: P(xc + 1.2, gapZ) },
      { do: "walk", to: P(xc - 0.7, gapZ) },
      { do: "walk", to: s.before },
    ],
  };
}

export const RECORDS_OFFICE: RoomModule<RecordsOfficeParams> = {
  name: "records-office",
  role: "middle",
  teaches: "toggle-button",
  difficulty: 1,
  requires: {},
  position: "first",
  entrySize: ENTRY_SIZE,
  defaults: {
    length: 10,
    left: 3.6,
    right: 3.8,
    height: 3.2,
    counter: 0.5,
    button: 0.4,
    desks: 2,
    flicker: true,
  },
  random,
  build,
};
