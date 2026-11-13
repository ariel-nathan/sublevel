/**
 * The filtration hall, the valve chamber beyond it and the egress lock: the
 * second puzzle space of the annex and the way out. A self-contained room
 * (see `room.ts`): everything is placed in the connector's local frame.
 *
 * Local frame: `a` metres into the room from the connector's wall face, `s`
 * metres to the right (looking in), `y` up from the threshold. Attached to
 * door B of the storage room (facing +X), `a` is world x - 13.8 and `s` is
 * world z - 12.
 *
 *   hall     a 0.3..11.3, s -4..5,      ceiling 4.5
 *            a grate screen (s -1.1..-1.0) splits off a service lane along
 *            the left wall (s -4..-1.1), open at its near end (a 0.3..1.8);
 *            the screen has an open slot between 1.4 and 2.3 m: a crate
 *            passes, a player (1.0 m tall crouching) does not.
 *   door T   a 11.3..11.6, s -3.1..-1.1 (2.0 wide), at the far end of the
 *            lane; TIMED button on the far wall on the main floor side, s 1.
 *   chamber  a 11.6..17.6, s -5..0.6,   ceiling 5.0
 *   exit door a 17.6..17.9, s -2.9..-1.5, latched open by an IMPACT target
 *            4.2 m up on the wall above it.
 *   lock     a 17.9..20.9, s -3.7..-0.7, ceiling 3.0 (the exit box).
 *
 * Puzzle A: the timed button is 2.4 m from door T in a straight line, but
 * the screen makes the walk round through the lane about 19 m, slower than
 * the countdown. A small crate passed through the screen's slot and dropped
 * in the doorway (or thrown in) wedges the door: a closing door that meets
 * it reopens, for as long as it is there.
 *
 * Puzzle B: the exit door's target is out of reach of the use key; a prop
 * thrown at it latches the door open. Everything thrown at it falls back to
 * the chamber floor, and the chamber holds four throwables.
 */
import type {
  Aabb,
  AcousticZone,
  ButtonDef,
  DoorDef,
  LightDef,
  SoundEmitterDef,
} from "../../core/api";
import type { MaterialId } from "../../core/materials";
import type { Vec3 } from "../../math";
import { localFrame, type Connector, type RoomContext } from "./room";

/** Wall, floor and ceiling thickness. */
const W = 0.3;
/** Width of the hazard bands framing a doorway, and how far they stand out. */
const BAND = 0.15;
const BAND_DEPTH = 0.1;
/** Inset of a door slab from each face of its wall (see define.ts). */
const DOOR_INSET = 0.07;
const DOOR_OVERTRAVEL = 0.05;
/** Face of a wall button / impact target in front of its wall surface. */
const BUTTON_DEPTH = 0.06;
const IMPACT_DEPTH = 0.07;
/** Thickness of a floor grate (top flush with the floor), as in define.ts. */
const GRATE_THICKNESS = 0.045;

/** Seconds the timed door stays open after a press. */
export const TIMED_SECONDS = 2.5;

/** World-space facts about the built room, for tests and tools. */
export interface FiltrationHallInfo {
  /** Standing inside this box completes the demo. */
  exit: Aabb;
  timedDoor: string;
  exitDoor: string;
  timedButton: string;
  innerButton: string;
  impactButton: string;
  seconds: number;
  /** Interiors. */
  hall: Aabb;
  lane: Aabb;
  chamber: Aabb;
  lock: Aabb;
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

export function buildFiltrationHall(
  ctx: RoomContext,
  at: Connector,
): FiltrationHallInfo {
  const L = localFrame(at);
  const P = (a: number, y: number, s: number): Vec3 => L.point(a, y, s);

  /** A brush between two local corners. */
  const B = (
    a0: number,
    y0: number,
    s0: number,
    a1: number,
    y1: number,
    s1: number,
    material: MaterialId,
  ): void => {
    if (!(a0 < a1 && y0 < y1 && s0 < s1)) {
      throw new Error(`degenerate brush ${[a0, y0, s0, a1, y1, s1].join(",")}`);
    }
    const box = L.box(a0, y0, s0, a1, y1, s1);
    ctx.box(box.min, box.max, material);
  };

  interface Opening {
    lo: number;
    hi: number;
    top: number;
  }

  /** A wall thin in `s`, running along `a`, with doorways along `a`. */
  const wallAlongA = (
    a0: number,
    a1: number,
    s0: number,
    s1: number,
    yBot: number,
    yTop: number,
    material: MaterialId,
    openings: Opening[] = [],
    sill: MaterialId = material,
  ): void => {
    let cur = a0;
    for (const o of [...openings].sort((p, q) => p.lo - q.lo)) {
      if (o.lo > cur) B(cur, yBot, s0, o.lo, yTop, s1, material);
      B(o.lo, o.top, s0, o.hi, yTop, s1, material);
      B(o.lo, yBot, s0, o.hi, 0, s1, sill);
      cur = o.hi;
    }
    if (cur < a1) B(cur, yBot, s0, a1, yTop, s1, material);
  };

  /** A wall thin in `a`, running along `s`, with doorways along `s`. */
  const wallAlongS = (
    a0: number,
    a1: number,
    s0: number,
    s1: number,
    yBot: number,
    yTop: number,
    material: MaterialId,
    openings: Opening[] = [],
    sill: MaterialId = material,
  ): void => {
    let cur = s0;
    for (const o of [...openings].sort((p, q) => p.lo - q.lo)) {
      if (o.lo > cur) B(a0, yBot, cur, a1, yTop, o.lo, material);
      B(a0, o.top, o.lo, a1, yTop, o.hi, material);
      B(a0, yBot, o.lo, a1, 0, o.hi, sill);
      cur = o.hi;
    }
    if (cur < s1) B(a0, yBot, cur, a1, yTop, s1, material);
  };

  /**
   * Hazard bands round a doorway in a wall facing along +/-a. `face` is the
   * wall surface, `dir` the way the bands stand out. Jambs can be left out.
   */
  const frame = (
    face: number,
    dir: 1 | -1,
    lo: number,
    hi: number,
    height: number,
    jambs: { lo: boolean; hi: boolean } = { lo: true, hi: true },
  ): void => {
    const a0 = dir > 0 ? face : face - BAND_DEPTH;
    const a1 = dir > 0 ? face + BAND_DEPTH : face;
    if (jambs.lo) B(a0, 0, lo - BAND, a1, height, lo, "hazard_stripe");
    if (jambs.hi) B(a0, 0, hi, a1, height, hi + BAND, "hazard_stripe");
    B(
      a0,
      height,
      jambs.lo ? lo - BAND : lo,
      a1,
      height + BAND,
      jambs.hi ? hi + BAND : hi,
      "hazard_stripe",
    );
  };

  /** Recessed ceiling fixture centred on (a, s). */
  const fixture = (
    a: number,
    s: number,
    ceiling: number,
    ha: number,
    hs: number,
    material: MaterialId = "light_panel",
  ): void =>
    B(a - ha, ceiling - 0.06, s - hs, a + ha, ceiling, s + hs, material);

  const light = (
    a: number,
    y: number,
    s: number,
    color: [number, number, number],
    radius: number,
    intensity: number,
    flicker: LightDef["flicker"] = "none",
    bounds?: Aabb,
  ): void => {
    const def: LightDef = {
      position: P(a, y, s),
      color: { x: color[0], y: color[1], z: color[2] },
      radius,
      intensity,
      flicker,
    };
    if (bounds) def.bounds = bounds;
    ctx.light(def);
  };

  const prop = (
    kind: Parameters<RoomContext["prop"]>[0],
    a: number,
    baseY: number,
    s: number,
    localYaw = 0,
  ): void => ctx.prop(kind, P(a, baseY, s), L.yaw(localYaw));

  const emitter = (
    sound: SoundEmitterDef["sound"],
    a: number,
    y: number,
    s: number,
    gain: number,
  ): void => ctx.emitter({ sound, position: P(a, y, s), gain });

  const zone = (box: Aabb, room: AcousticZone["room"]): void =>
    ctx.zone({ box, room });

  /**
   * A sliding door in a wall thin in `a` (a0..a1), closing the opening
   * s0..s1; it slides towards -s into the wall.
   */
  const door = (
    id: string,
    a0: number,
    a1: number,
    s0: number,
    s1: number,
    height: number,
  ): DoorDef => {
    const def: DoorDef = {
      id,
      closed: L.box(a0 + DOOR_INSET, 0, s0, a1 - DOOR_INSET, height, s1),
      openOffset: L.dir(0, 0, -(s1 - s0 + DOOR_OVERTRAVEL)),
      material: "door_steel",
    };
    ctx.door(def);
    return def;
  };

  const button = (
    id: string,
    target: string,
    a: number,
    y: number,
    s: number,
    facingA: 1 | -1,
    mode: ButtonDef["mode"],
    seconds?: number,
  ): void => {
    const def: ButtonDef = {
      id,
      position: P(a, y, s),
      facing: L.dir(facingA, 0, 0),
      target,
      mode,
    };
    if (seconds !== undefined) def.seconds = seconds;
    ctx.button(def);
  };

  // =========================================================================
  // Filtration hall: a 0.3..11.3, s -4..4, ceiling 4.5
  // =========================================================================
  const HALL = { a0: W, a1: 11.3, s0: -4, s1: 5, h: 4.5 };
  const half = at.width / 2;
  // Floor, cut round the drain channel (see the dressing below).
  const CH_TR = { a0: 2.4, a1: 8.4, s0: 2.6, s1: 3.2 };
  B(HALL.a0, -W, HALL.s0, HALL.a1, 0, CH_TR.s0, "concrete_floor");
  B(HALL.a0, -W, CH_TR.s1, HALL.a1, 0, HALL.s1, "concrete_floor");
  B(HALL.a0, -W, CH_TR.s0, CH_TR.a0, 0, CH_TR.s1, "concrete_floor");
  B(CH_TR.a1, -W, CH_TR.s0, HALL.a1, 0, CH_TR.s1, "concrete_floor");
  B(HALL.a0, HALL.h, HALL.s0, HALL.a1, HALL.h + W, HALL.s1, "concrete_wall");
  // Near wall, back to back with the wall the connector is in, with the
  // same doorway through it.
  wallAlongS(
    0,
    W,
    HALL.s0,
    HALL.s1,
    -W,
    HALL.h + W,
    "concrete_wall",
    [{ lo: -half, hi: half, top: at.height }],
    "metal_panel",
  );
  wallAlongA(0, HALL.a1, HALL.s0 - W, HALL.s0, -W, HALL.h + W, "concrete_wall");
  wallAlongA(0, HALL.a1, HALL.s1, HALL.s1 + W, -W, HALL.h + W, "metal_panel");

  // Far wall, shared with the valve chamber, taller than the hall (the
  // chamber is 5 m high) and long enough to hide door T's slab when open.
  const DOOR_T = { s0: -3.1, s1: -1.1, h: 2.4 };
  const CH = { a0: 11.6, a1: 17.6, s0: -5, s1: 0.6, h: 5 };
  wallAlongS(
    HALL.a1,
    CH.a0,
    CH.s0 - W,
    HALL.s1 + W,
    -W,
    CH.h + W,
    "concrete_wall",
    [{ lo: DOOR_T.s0, hi: DOOR_T.s1, top: DOOR_T.h }],
    "metal_panel",
  );

  frame(W, 1, -half, half, at.height);
  // Door T, hall side: the screen's last post stands at its right jamb.
  frame(HALL.a1, -1, DOOR_T.s0, DOOR_T.s1, DOOR_T.h, { lo: true, hi: false });

  // --- The grate screen: lane on the left, main floor on the right --------
  const SCREEN = { s0: -1.1, s1: -1.0, a0: 1.8 };
  const SLOT = { bottom: 1.4, top: 2.3 };
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
  const PLATE_FACE = HALL.a1 - 0.02;
  B(PLATE_FACE, 0.9, 0.7, HALL.a1, 1.5, 1.3, "hazard_stripe");
  button(
    "button_t_hall",
    "door_t",
    PLATE_FACE - BUTTON_DEPTH,
    1.2,
    1.0,
    -1,
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
  ); // Ceiling beams and pipe runs high on the side walls.
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
    CH.a0 + 0.5,
    HALL.h + W,
    HALL.s1 + W,
  );
  fixture(9.7, 1.2, HALL.h, 0.3, 0.3);
  light(9.7, 3.9, 1.2, [1.0, 0.84, 0.62], 6.5, 1.5);
  fixture(10.0, -2.6, HALL.h, 0.3, 0.15);
  light(10.0, 3.9, -2.6, [0.85, 0.95, 1.0], 7, 1.3, "fluorescent", hallBounds);
  fixture(4.6, -0.2, HALL.h, 0.3, 0.15);
  light(4.6, 3.9, -0.2, [0.8, 0.88, 1.0], 7.5, 1.0);
  fixture(4.6, 2.4, HALL.h, 0.3, 0.15);
  light(4.6, 3.9, 2.4, [0.85, 0.9, 1.0], 6, 0.9);

  // Props: small crates and a chair by the button, crates and a barrel by
  // the vessels, a small crate at the lane's entrance.
  prop("crate_wood_small", 9.7, 0, 0.2);
  prop("crate_wood_small", 8.8, 0, 0.0, 0.4);
  prop("chair", 7.5, 0, -0.2, 2.2);
  prop("crate_wood", 1.6, 0, 4.4);
  prop("crate_wood", 5.1, 0, 4.4, 0.15);
  prop("barrel", 8.0, 0, 4.5);
  prop("crate_wood_small", 0.8, 0, -3.5, 0.3);

  emitter("hum_machine", 9.8, 1.2, 4.0, 0.55);
  emitter("hum_fluorescent", 10.0, 4.0, -2.6, 0.45);

  // =========================================================================
  // Valve chamber: a 11.6..17.6, s -5..0.6, ceiling 5.0
  // =========================================================================
  const EXIT_DOOR = { s0: -2.9, s1: -1.5, h: 2.4 };
  const LOCK = { a0: 17.9, a1: 20.9, s0: -3.7, s1: -0.7, h: 3 };
  B(CH.a0, -W, CH.s0, CH.a1, 0, CH.s1, "concrete_floor");
  B(CH.a0, CH.h, CH.s0, CH.a1, CH.h + W, CH.s1, "concrete_wall");
  wallAlongA(CH.a0, CH.a1 + W, CH.s0 - W, CH.s0, -W, CH.h + W, "concrete_wall");
  wallAlongA(CH.a0, CH.a1 + W, CH.s1, CH.s1 + W, -W, CH.h + W, "concrete_wall");
  wallAlongS(
    CH.a1,
    CH.a1 + W,
    CH.s0,
    CH.s1,
    -W,
    CH.h + W,
    "concrete_wall",
    [{ lo: EXIT_DOOR.s0, hi: EXIT_DOOR.s1, top: EXIT_DOOR.h }],
    "metal_panel",
  );
  frame(CH.a0, 1, DOOR_T.s0, DOOR_T.s1, DOOR_T.h);
  frame(CH.a1, -1, EXIT_DOOR.s0, EXIT_DOOR.s1, EXIT_DOOR.h);

  // The way back: a timed button beside door T, chamber side.
  button(
    "button_t_chamber",
    "door_t",
    CH.a0 + BUTTON_DEPTH,
    1.2,
    -0.4,
    1,
    "timed",
    TIMED_SECONDS,
  );

  // The impact target, 4.2 m up over the exit door on a striped plate,
  // with a warning sign under it and a bright lamp in front of it.
  const TARGET = { y: 4.2, s: -2.2 };
  const TARGET_FACE = CH.a1 - 0.02;
  B(
    TARGET_FACE,
    TARGET.y - 0.35,
    TARGET.s - 0.35,
    CH.a1,
    TARGET.y + 0.35,
    TARGET.s + 0.35,
    "hazard_stripe",
  );
  button(
    "button_exit_target",
    "door_exit",
    TARGET_FACE - IMPACT_DEPTH,
    TARGET.y,
    TARGET.s,
    -1,
    "impact",
  );
  B(
    CH.a1 - 0.04,
    2.8,
    TARGET.s - 0.4,
    CH.a1,
    3.6,
    TARGET.s + 0.4,
    "sign_warning",
  );

  // Dressing: a valve manifold on the left wall, a console on the right,
  // pipe runs.
  B(13.2, 0, CH.s0, 14.4, 1.2, -4.4, "metal_panel");
  B(13.2, 1.2, CH.s0, 14.4, 1.25, -4.4, "rubber_dark");
  B(13.6, 0.5, -4.4, 14.0, 0.9, -4.36, "hazard_stripe");
  for (const a of [13.4, 14.0]) {
    B(a, 1.25, -4.85, a + 0.15, CH.h, -4.7, "pipe");
  }
  B(CH.a0, 2.6, CH.s0, CH.a1, 2.75, CH.s0 + 0.15, "pipe");
  B(CH.a0, 4.5, -0.2, CH.a1, 4.65, -0.05, "pipe");
  B(CH.a0, 4.5, 0.15, CH.a1, 4.65, 0.3, "pipe");
  B(13.0, 0, 0.05, 15.5, 0.9, CH.s1, "metal_panel");
  B(13.0, 0.9, 0, 15.5, 0.95, CH.s1, "plastic_white");
  B(13.5, 1.3, CH.s1 - 0.04, 15.0, 2.0, CH.s1, "monitor_screen");

  const chamberBounds = L.box(
    HALL.a1 - 0.5,
    -W,
    CH.s0 - W,
    CH.a1 + W + 0.5,
    CH.h + W,
    CH.s1 + W,
  );
  fixture(16.0, TARGET.s, CH.h, 0.3, 0.15);
  light(16.0, 4.55, TARGET.s, [0.9, 0.95, 1.0], 5.5, 1.6);
  fixture(13.2, -0.6, CH.h, 0.3, 0.15);
  light(13.2, 4.5, -0.6, [1.0, 0.8, 0.55], 6.5, 1.1, "broken", chamberBounds);

  prop("crate_wood_small", 13.0, 0, -4.0, 0.2);
  prop("crate_wood_small", 12.3, 0, -3.2);
  prop("chair", 15.8, 0, -0.4, -0.6);
  prop("monitor", 14.2, 0.95, 0.3, Math.PI / 2);

  emitter("hum_machine", 13.8, 1.0, -4.6, 0.4);

  // =========================================================================
  // Egress lock: a 17.9..20.9, s -3.7..-0.7, ceiling 3.0
  // =========================================================================
  B(LOCK.a0, -W, LOCK.s0, LOCK.a1, 0, LOCK.s1, "lab_floor_tile");
  B(LOCK.a0, LOCK.h, LOCK.s0, LOCK.a1, LOCK.h + W, LOCK.s1, "metal_panel");
  wallAlongA(
    LOCK.a0,
    LOCK.a1 + W,
    LOCK.s0 - W,
    LOCK.s0,
    -W,
    LOCK.h + W,
    "metal_panel",
  );
  wallAlongA(
    LOCK.a0,
    LOCK.a1 + W,
    LOCK.s1,
    LOCK.s1 + W,
    -W,
    LOCK.h + W,
    "metal_panel",
  );
  wallAlongS(
    LOCK.a1,
    LOCK.a1 + W,
    LOCK.s0,
    LOCK.s1,
    -W,
    LOCK.h + W,
    "metal_panel",
  );
  frame(LOCK.a0, 1, EXIT_DOOR.s0, EXIT_DOOR.s1, EXIT_DOOR.h);
  B(LOCK.a1 - 0.04, 1, -2.7, LOCK.a1, 2, -1.7, "monitor_screen");
  B(19.2, 1, LOCK.s0, 20.2, 2, LOCK.s0 + 0.04, "sign_warning");
  B(19.2, 1, LOCK.s1 - 0.04, 20.2, 2, LOCK.s1, "sign_warning");
  fixture(19.1, -2.2, LOCK.h, 0.3, 0.3, "button_green");
  light(19.1, 2.55, -2.2, [0.35, 1.0, 0.45], 4.5, 1.6);

  // =========================================================================
  // Doors and acoustics
  // =========================================================================
  const timedDoor = door(
    "door_t",
    HALL.a1,
    CH.a0,
    DOOR_T.s0,
    DOOR_T.s1,
    DOOR_T.h,
  );
  const exitDoor = door(
    "door_exit",
    CH.a1,
    LOCK.a0,
    EXIT_DOOR.s0,
    EXIT_DOOR.s1,
    EXIT_DOOR.h,
  );
  zone(L.box(-0.15, 0, HALL.s0, HALL.a1 + 0.15, HALL.h, HALL.s1), "hall");
  zone(L.box(HALL.a1 + 0.15, 0, CH.s0, CH.a1 + 0.15, CH.h, CH.s1), "small");
  zone(L.box(CH.a1 + 0.15, 0, LOCK.s0, LOCK.a1, LOCK.h, LOCK.s1), "small");

  const pressSpot = P(PLATE_FACE - 1.2, 0, 1.0);
  const clear = 0.35;
  return {
    exit: L.box(LOCK.a0 + 1, 0, LOCK.s0, LOCK.a1, LOCK.h, LOCK.s1),
    timedDoor: timedDoor.id,
    exitDoor: exitDoor.id,
    timedButton: "button_t_hall",
    innerButton: "button_t_chamber",
    impactButton: "button_exit_target",
    seconds: TIMED_SECONDS,
    hall: L.box(HALL.a0, 0, HALL.s0, HALL.a1, HALL.h, HALL.s1),
    lane: L.box(HALL.a0, 0, HALL.s0, HALL.a1, HALL.h, SCREEN.s0),
    chamber: L.box(CH.a0, 0, CH.s0, CH.a1, CH.h, CH.s1),
    lock: L.box(LOCK.a0, 0, LOCK.s0, LOCK.a1, LOCK.h, LOCK.s1),
    screen: L.box(SCREEN.a0, 0, SCREEN.s0, HALL.a1, HALL.h, SCREEN.s1),
    slot: SLOT,
    pressSpot,
    sprintRoute: [
      pressSpot,
      P(SCREEN.a0 - clear, 0, SCREEN.s1 + clear),
      P(SCREEN.a0 - clear, 0, SCREEN.s0 - clear),
      P(HALL.a1 - clear, 0, (DOOR_T.s0 + DOOR_T.s1) / 2),
      P((HALL.a1 + CH.a0) / 2, 0, (DOOR_T.s0 + DOOR_T.s1) / 2),
    ],
    timedDoorway: P((HALL.a1 + CH.a0) / 2, 0, (DOOR_T.s0 + DOOR_T.s1) / 2),
    wedgeSpot: P(HALL.a1 - 0.05, 0.25, DOOR_T.s1 - 0.5),
  };
}

/** The room's facts without building it (a context that discards parts). */
export function describeFiltrationHall(at: Connector): FiltrationHallInfo {
  const ignore = (): void => {};
  return buildFiltrationHall(
    {
      box: ignore,
      light: ignore,
      prop: ignore,
      door: ignore,
      button: ignore,
      emitter: ignore,
      zone: ignore,
    },
    at,
  );
}
