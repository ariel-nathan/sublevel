/**
 * The filtration hall: the second puzzle space of Kestrel Annex. Its exit,
 * door T, is a timed door.
 *
 * Design coordinates are the entry's local frame (`LOCAL_DESIGN`): `x` is
 * metres into the room from the entry plane, `z` metres to the right
 * looking in, `y` up from the threshold. Attached to door B of the storage
 * room (facing +X), x is world x - 13.8 and z is world z - 12.
 *
 *   hall     x 0.3..11.3, z -4..5,      ceiling 4.5
 *            a grate screen (z -1.1..-1.0) splits off a service lane along
 *            the left wall (z -4..-1.1), open at its near end (x 0.3..1.8);
 *            the screen has an open slot between 1.4 and 2.3 m: a crate
 *            passes, a player (1.0 m tall crouching) does not.
 *   door T   x 11.3..11.6, z -3.1..-1.1 (2.0 wide), at the far end of the
 *            lane; TIMED button on the far wall on the main floor side, z 1.
 *
 * The far wall (x 11.3..11.6) is the hall's: it is 5.3 m high and reaches
 * z -5.3 so that it closes the valve chamber's open end (room.ts rule 2).
 *
 * The lock: the timed button is 2.4 m from door T in a straight line, but
 * the screen makes the walk round through the lane about 19 m, slower than
 * the countdown. A small crate passed through the screen's slot and dropped
 * in the doorway wedges the door: a closing door that meets it reopens, for
 * as long as it is there.
 */
import type { Aabb } from "../../core/api";
import type { Vec3 } from "../../math";
import {
  BUTTON_DEPTH,
  doorwayPoints,
  GRATE_THICKNESS,
  LOCAL_DESIGN,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type Connector,
  type Frame,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "./room";
import { createKit } from "./kit";

/** Seconds the timed door stays open after a press. */
export const TIMED_SECONDS = 2.5;

const HALL = { a0: W, a1: 11.3, s0: -4, s1: 5, h: 4.5 };
/** The far wall: its back face, how far it reaches and how high. */
const FAR = { a1: 11.6, s0: -5.3, top: 5.3 };
const DOOR_T = { s0: -3.1, s1: -1.1, h: 2.4 };
const SCREEN = { s0: -1.1, s1: -1.0, a0: 1.8 };
const SLOT = { bottom: 1.4, top: 2.3 };
const PLATE_FACE = HALL.a1 - 0.02;

/** World-space facts about the hall, for tests and tools. */
export interface FiltrationHallInfo {
  timedDoor: string;
  timedButton: string;
  seconds: number;
  /** Interiors. */
  hall: Aabb;
  lane: Aabb;
  /** The grate screen between the main floor and the lane (posts included). */
  screen: Aabb;
  /** The open slot through the screen, between its two rails. */
  slot: { bottom: number; top: number };
  /** Feet position for pressing the timed button. */
  pressSpot: Vec3;
  /**
   * The quickest walk from `pressSpot` to the middle of the timed doorway:
   * round the near end of the screen, keeping the player's half-width clear
   * of the posts.
   */
  sprintRoute: Vec3[];
  /** Centre of the timed doorway at floor level. */
  timedDoorway: Vec3;
  /**
   * Where a small crate's centre must come to rest to wedge the timed door
   * (inside the doorway, straddling the slab's path, clear of the jamb).
   */
  wedgeSpot: Vec3;
}

function hallInfo(L: Frame, id: (local: string) => string): FiltrationHallInfo {
  const P = L.point;
  const pressSpot = P(PLATE_FACE - 1.2, 0, 1.0);
  const clear = 0.35;
  const door = (DOOR_T.s0 + DOOR_T.s1) / 2;
  return {
    timedDoor: id("door_t"),
    timedButton: id("button_t_hall"),
    seconds: TIMED_SECONDS,
    hall: L.box(HALL.a0, 0, HALL.s0, HALL.a1, HALL.h, HALL.s1),
    lane: L.box(HALL.a0, 0, HALL.s0, HALL.a1, HALL.h, SCREEN.s0),
    screen: L.box(SCREEN.a0, 0, SCREEN.s0, HALL.a1, HALL.h, SCREEN.s1),
    slot: SLOT,
    pressSpot,
    sprintRoute: [
      pressSpot,
      P(SCREEN.a0 - clear, 0, SCREEN.s1 + clear),
      P(SCREEN.a0 - clear, 0, SCREEN.s0 - clear),
      P(HALL.a1 - clear, 0, door),
      P((HALL.a1 + FAR.a1) / 2, 0, door),
    ],
    timedDoorway: P((HALL.a1 + FAR.a1) / 2, 0, door),
    wedgeSpot: P(HALL.a1 - 0.05, 0.25, DOOR_T.s1 - 0.5),
  };
}

/** The hall's facts without building it. */
export function describeFiltrationHall(
  at: Connector,
  mirror = false,
  id: (local: string) => string = (local) => local,
): FiltrationHallInfo {
  return hallInfo(roomFrame(at, mirror, LOCAL_DESIGN), id);
}

function buildFiltrationHall(ctx: RoomContext, at: Connector): RoomPlan {
  const L = roomFrame(at, ctx.mirror, LOCAL_DESIGN);
  const k = createKit(ctx, L);
  const B = k.box;
  const half = at.width / 2;

  // Floor, cut round the drain channel (see the dressing below).
  const CH_TR = { a0: 2.4, a1: 8.4, s0: 2.6, s1: 3.2 };
  B(HALL.a0, -W, HALL.s0, HALL.a1, 0, CH_TR.s0, "concrete_floor");
  B(HALL.a0, -W, CH_TR.s1, HALL.a1, 0, HALL.s1, "concrete_floor");
  B(HALL.a0, -W, CH_TR.s0, CH_TR.a0, 0, CH_TR.s1, "concrete_floor");
  B(CH_TR.a1, -W, CH_TR.s0, HALL.a1, 0, CH_TR.s1, "concrete_floor");
  B(HALL.a0, HALL.h, HALL.s0, HALL.a1, HALL.h + W, HALL.s1, "concrete_wall");
  // Near wall, back to back with the wall the entry is in, with the same
  // doorway through it.
  k.wallAlongZ(
    0,
    W,
    HALL.s0,
    HALL.s1,
    -W,
    HALL.h + W,
    "concrete_wall",
    [{ a: -half, b: half, top: at.height }],
    "metal_panel",
  );
  k.wallAlongX(
    0,
    HALL.a1,
    HALL.s0 - W,
    HALL.s0,
    -W,
    HALL.h + W,
    "concrete_wall",
  );
  k.wallAlongX(0, HALL.a1, HALL.s1, HALL.s1 + W, -W, HALL.h + W, "metal_panel");

  // Far wall, shared with the valve chamber, taller than the hall (the
  // chamber is 5 m high) and long enough to hide door T's slab when open.
  k.wallAlongZ(
    HALL.a1,
    FAR.a1,
    FAR.s0,
    HALL.s1 + W,
    -W,
    FAR.top,
    "concrete_wall",
    [{ a: DOOR_T.s0, b: DOOR_T.s1, top: DOOR_T.h }],
    "metal_panel",
  );

  k.frameX(W, 1, -half, half, at.height);
  // Door T, hall side: the screen's last post stands at its right jamb.
  k.frameX(HALL.a1, -1, DOOR_T.s0, DOOR_T.s1, DOOR_T.h, {
    lo: true,
    hi: false,
  });

  // --- The grate screen: lane on the left, main floor on the right --------
  const posts = [1.8, 3.7, 5.6, 7.5, 9.4, HALL.a1 - 0.1];
  for (const a of posts) {
    B(a, 0, SCREEN.s0, a + 0.1, HALL.h, SCREEN.s1, "metal_panel");
  }
  for (let i = 0; i + 1 < posts.length; i++) {
    const a0 = posts[i] + 0.1;
    const a1 = posts[i + 1];
    B(a0, 0, -1.07, a1, SLOT.bottom - 0.06, -1.03, "metal_grate");
    B(a0, SLOT.top + 0.1, -1.07, a1, HALL.h, -1.03, "metal_grate");
  }
  // Rails under and over the slot, slimmer than the posts and ending inside
  // the end posts, so that no rail face lies in a post face.
  const rail = {
    a0: SCREEN.a0 + 0.02,
    a1: HALL.a1 - 0.02,
    s0: -1.09,
    s1: -1.01,
  };
  B(
    rail.a0,
    SLOT.bottom - 0.06,
    rail.s0,
    rail.a1,
    SLOT.bottom,
    rail.s1,
    "metal_panel",
  );
  B(
    rail.a0,
    SLOT.top,
    rail.s0,
    rail.a1,
    SLOT.top + 0.1,
    rail.s1,
    "metal_panel",
  );

  // --- The timed button on the far wall, on a striped backing plate -------
  B(PLATE_FACE, 0.9, 0.7, HALL.a1, 1.5, 1.3, "hazard_stripe");
  const timed = k.button(
    ctx.id("button_t_hall"),
    ctx.id("door_t"),
    PLATE_FACE - BUTTON_DEPTH,
    1.2,
    1.0,
    [-1, 0],
    "timed",
    TIMED_SECONDS,
  );
  B(HALL.a1 - 0.04, 1.75, 0.55, HALL.a1, 2.65, 1.45, "sign_warning");

  // --- Dressing ------------------------------------------------------------
  // Racks on the near wall, right of the doorway.
  B(W, 0, 2.5, 0.9, 2.0, 2.55, "metal_panel");
  B(W, 0, 4.75, 0.9, 2.0, 4.8, "metal_panel");
  for (const y of [0.1, 0.7, 1.3, 1.9]) {
    B(W, y, 2.55, 0.9, y + 0.04, 4.75, "metal_panel");
  }
  B(0.4, 0.74, 2.9, 0.8, 1.14, 3.3, "crate_wood");
  B(0.35, 1.34, 3.9, 0.75, 1.74, 4.3, "crate_metal");
  B(0.4, 0.14, 3.5, 0.7, 0.44, 3.8, "plastic_white");
  // Two filter vessels against the right wall, floor to ceiling (nothing
  // thrown can come to rest up there), with rubber collars and a sign.
  const VESSEL = { s0: 3.4, a: [2.8, 5.8] };
  for (const a0 of VESSEL.a) {
    B(a0, 0, VESSEL.s0, a0 + 1.6, HALL.h, HALL.s1, "plastic_white");
    for (const y of [0.6, 3.0]) {
      B(
        a0 - 0.04,
        y,
        VESSEL.s0 - 0.04,
        a0 + 1.64,
        y + 0.15,
        HALL.s1,
        "rubber_dark",
      );
    }
    B(
      a0 + 0.2,
      1.75,
      VESSEL.s0 - 0.02,
      a0 + 1.4,
      1.85,
      VESSEL.s0,
      "hazard_stripe",
    );
  }
  B(3.1, 2.0, VESSEL.s0 - 0.04, 4.1, 2.8, VESSEL.s0, "sign_warning");
  B(4.4, 2.6, 4.1, 5.8, 2.75, 4.25, "pipe");
  B(7.4, 0.7, 3.9, 8.6, 0.85, 4.05, "pipe");
  // Pump skid in the far corner, with its motor and a riser to the ceiling.
  B(8.6, 0, VESSEL.s0, HALL.a1, 1.0, HALL.s1, "metal_panel");
  B(8.6, 1.0, VESSEL.s0, HALL.a1, 1.05, HALL.s1, "rubber_dark");
  B(9.0, 1.05, 3.7, 9.7, 1.6, 4.4, "metal_panel");
  B(10.1, 1.05, 4.0, 10.25, HALL.h, 4.15, "pipe");
  // A drain channel along the vessels under a floor grate (flush with the
  // floor, on 5 cm steel ledges), with a pipe in it. Below the floor slab
  // its walls and bottom are 0.2-0.3 m of concrete, like the corridor pit.
  const gy = -GRATE_THICKNESS;
  const TR = { a0: 2.4, a1: 8.4, s0: 2.6, s1: 3.2, bottom: -0.55 };
  const T = 0.25;
  B(TR.a0, gy, TR.s0, TR.a1, 0, TR.s1, "metal_grate");
  B(TR.a0, -W, TR.s0, TR.a1, gy, TR.s0 + 0.05, "metal_panel");
  B(TR.a0, -W, TR.s1 - 0.05, TR.a1, gy, TR.s1, "metal_panel");
  B(TR.a0, -W, TR.s0 + 0.05, TR.a0 + 0.05, gy, TR.s1 - 0.05, "metal_panel");
  B(TR.a1 - 0.05, -W, TR.s0 + 0.05, TR.a1, gy, TR.s1 - 0.05, "metal_panel");
  B(
    TR.a0 - T,
    TR.bottom,
    TR.s0 - T,
    TR.a1 + T,
    -W,
    TR.s0 + 0.05,
    "concrete_wall",
  );
  B(
    TR.a0 - T,
    TR.bottom,
    TR.s1 - 0.05,
    TR.a1 + T,
    -W,
    TR.s1 + T,
    "concrete_wall",
  );
  B(
    TR.a0 - T,
    TR.bottom,
    TR.s0 + 0.05,
    TR.a0 + 0.05,
    -W,
    TR.s1 - 0.05,
    "concrete_wall",
  );
  B(
    TR.a1 - 0.05,
    TR.bottom,
    TR.s0 + 0.05,
    TR.a1 + T,
    -W,
    TR.s1 - 0.05,
    "concrete_wall",
  );
  B(
    TR.a0 - T,
    TR.bottom - 0.2,
    TR.s0 - T,
    TR.a1 + T,
    TR.bottom,
    TR.s1 + T,
    "concrete_floor",
  );
  B(
    TR.a0 + 0.05,
    TR.bottom,
    2.84,
    TR.a1 - 0.05,
    TR.bottom + 0.12,
    2.96,
    "pipe",
  );
  // Ceiling beams and pipe runs high on the side walls.
  for (const a of [3.0, 6.0, 9.0]) {
    B(a - 0.15, 4.2, HALL.s0, a + 0.15, HALL.h, HALL.s1, "metal_panel");
  }
  B(HALL.a0, 3.8, HALL.s0, HALL.a1, 3.95, HALL.s0 + 0.15, "pipe");
  B(HALL.a0, 3.4, HALL.s1 - 0.15, HALL.a1, 3.55, HALL.s1, "pipe");
  for (const a of [1.5, 4.5, 7.5, 10.5]) {
    B(a - 0.04, 3.65, HALL.s0, a + 0.04, 3.8, HALL.s0 + 0.15, "metal_panel");
  }
  // The lane: hazard band near door T, vents, and a sign at its entrance.
  B(7.5, 0.3, HALL.s0, 11.0, 0.6, HALL.s0 + 0.04, "hazard_stripe");
  for (const a of [3.0, 6.0]) {
    B(a, 1.0, HALL.s0, a + 0.6, 1.4, HALL.s0 + 0.04, "rubber_dark");
  }
  B(W, 1.4, -3.2, W + 0.04, 2.4, -2.2, "sign_warning");
  // Lights: a warm pool on the button, a flickering tube over the lane by
  // door T, a dim cool panel over the middle; the near corners stay dark.
  const hallBounds = L.box(
    -W - 0.5,
    -W,
    HALL.s0 - W,
    FAR.a1 + 0.5,
    HALL.h + W,
    HALL.s1 + W,
  );
  k.fixture(9.7, 1.2, HALL.h, 0.3, 0.3);
  k.light(9.7, 3.9, 1.2, [1.0, 0.84, 0.62], 6.5, 1.5);
  k.fixture(10.0, -2.6, HALL.h, 0.3, 0.15);
  k.light(
    10.0,
    3.9,
    -2.6,
    [0.85, 0.95, 1.0],
    7,
    1.3,
    "fluorescent",
    hallBounds,
  );
  k.fixture(4.6, -0.2, HALL.h, 0.3, 0.15);
  k.light(4.6, 3.9, -0.2, [0.8, 0.88, 1.0], 7.5, 1.0);
  k.fixture(4.6, 2.4, HALL.h, 0.3, 0.15);
  k.light(4.6, 3.9, 2.4, [0.85, 0.9, 1.0], 6, 0.9);

  // Props: small crates and a chair by the button, crates and a barrel by
  // the vessels, a small crate at the lane's entrance.
  const wedge = k.propTurned("crate_wood_small", 9.7, 0, 0.2, 0);
  k.propTurned("crate_wood_small", 8.8, 0, 0.0, 0.4);
  k.propTurned("chair", 7.5, 0, -0.2, 2.2);
  k.propTurned("crate_wood", 1.6, 0, 4.4, 0);
  k.propTurned("crate_wood", 5.1, 0, 4.4, 0.15);
  k.propTurned("barrel", 8.0, 0, 4.5, 0);
  k.propTurned("crate_wood_small", 0.8, 0, -3.5, 0.3);

  k.emitter("hum_machine", 9.8, 1.2, 4.0, 0.55);
  k.emitter("hum_fluorescent", 10.0, 4.0, -2.6, 0.45);

  const doorT = k.door(
    ctx.id("door_t"),
    "x",
    HALL.a1,
    FAR.a1,
    DOOR_T.s0,
    DOOR_T.s1,
    DOOR_T.h,
  );
  k.zone(L.box(-0.15, 0, HALL.s0, HALL.a1 + 0.15, HALL.h, HALL.s1), "hall");

  const doorAxis = (DOOR_T.s0 + DOOR_T.s1) / 2;
  const exit: Connector = {
    position: L.point(FAR.a1, 0, doorAxis),
    facing: L.dir(1, 0, 0),
    width: DOOR_T.s1 - DOOR_T.s0,
    height: DOOR_T.h,
    door: doorT.id,
  };
  const P = (a: number, s: number): Vec3 => L.point(a, 0, s);
  return {
    footprint: [L.box(0, -0.75, FAR.s0, FAR.a1, FAR.top, HALL.s1 + W)],
    entry: {
      connector: at,
      end: {
        wall: true,
        extent: rectOnPlane(
          at,
          L.box(0, -W, HALL.s0 - W, 0, HALL.h + W, HALL.s1 + W),
        ),
      },
    },
    exits: [
      {
        connector: exit,
        end: {
          wall: true,
          extent: rectOnPlane(
            exit,
            L.box(FAR.a1, -W, FAR.s0, FAR.a1, FAR.top, HALL.s1 + W),
          ),
        },
      },
    ],
    lock: {
      kind: "timed-door",
      doors: [doorT.id],
      buttons: [timed.id],
      plates: [],
      keys: [{ prop: wedge, at: L.point(9.7, 0.25, 0.2) }],
    },
    solution: [
      { do: "walk", to: P(PLATE_FACE - BUTTON_DEPTH - 1.0, 1.0) },
      { do: "press", button: timed.id },
      // Through the slot into the doorway, from the main floor: the closing
      // door meets the crate and reopens.
      {
        do: "carry",
        prop: wedge,
        to: L.point(HALL.a1 - 0.2, 0.25, DOOR_T.s1 - 0.45),
      },
      // Round the near end of the screen and up the lane.
      { do: "walk", to: P(10.4, 0.75) },
      { do: "walk", to: P(SCREEN.a0 - 0.35, 0.75) },
      { do: "walk", to: P(SCREEN.a0 - 0.35, SCREEN.s0 - 0.35) },
      { do: "walk", to: doorwayPoints(exit).before },
    ],
  };
}

export const FILTRATION_HALL: RoomModule = {
  name: "filtration-hall",
  role: "middle",
  teaches: "timed-door",
  difficulty: 2,
  requires: {},
  entrySize: { width: [1.2, 2.0], height: [2.2, 2.6] },
  defaults: {},
  random: () => ({}),
  build: (ctx, at) => buildFiltrationHall(ctx, at),
};
