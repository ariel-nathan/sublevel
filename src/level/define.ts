import type {
  AcousticZone,
  Brush,
  ButtonDef,
  DoorDef,
  LevelData,
  LightDef,
  PressurePlateDef,
  PropKind,
  PropSpawn,
  SoundEmitterDef,
} from "../core/api";
import type { MaterialId } from "../core/materials";
import { PROP_SPECS } from "../core/props";
import { buildFiltrationHall } from "./rooms/filtration-hall";
import type { Connector } from "./rooms/room";

/**
 * "Kestrel Annex": a lab, a service corridor with one bend, a storage room
 * with a pressure-plate puzzle that holds door B open, then the filtration
 * hall (timed door), the valve chamber (impact target) and the egress lock
 * with the exit (src/level/rooms/filtration-hall.ts).
 *
 * Layout (top-down, +X right, +Z down the page, metres):
 *
 *   lab          x -4..4,     z -3..3,    ceiling 3.0   (spawn here)
 *   door A       x 4..4.3,    z -0.7..0.7 (button on the lab wall)
 *   corridor     x 4.3..10.8, z -1.25..1.25, then x 8.3..10.8, z 1.25..7.7
 *   storage      x 5.5..13.5, z 8..16,    ceiling 4.0
 *   door B       x 13.5..13.8, z 11.3..12.7 (held open by the plate)
 *   hall         x 14.1..25.1, z 8..16,   ceiling 4.5; service lane z 8..10.9
 *   door T       x 25.1..25.4, z 8.9..10.9 (timed button at x 25.1, z 13)
 *   chamber      x 25.4..31.4, z 7..12.6, ceiling 5.0
 *   exit door    x 31.4..31.7, z 9.1..10.5 (impact target 4.2 m up over it)
 *   egress lock  x 31.7..34.7, z 8.3..11.3, ceiling 3.0 (exit x >= 32.7)
 */

const WALL = 0.3;

/** Width of the hazard bands that frame doorways. */
const BAND = 0.15;

/**
 * Distance from the wall surface to a button's face (its `position`). Must
 * match the depth of the world objects' button model (src/props/meshes.ts).
 */
export const BUTTON_DEPTH = 0.06;

/** The same for an impact target (src/props/meshes.ts IMPACT_DEPTH). */
export const IMPACT_BUTTON_DEPTH = 0.07;

/** Door B's doorway, seen from the storage room's far side: the new hall. */
export const HALL_CONNECTOR: Connector = {
  position: { x: 13.8, y: 0, z: 12 },
  facing: { x: 1, y: 0, z: 0 },
  width: 1.4,
  height: 2.4,
};

/**
 * How far a door slab is inset from each face of its wall. The slab is
 * thinner than the wall and centred in it, so it reads as recessed in its
 * frame, and when open it is hidden entirely inside the wall.
 */
export const DOOR_INSET = 0.07;

/** How far past the far jamb an open slab ends up, inside the wall. */
export const DOOR_OVERTRAVEL = 0.05;

/** Thickness of the corridor's floor grate (top flush with the floor). */
export const GRATE_THICKNESS = 0.045;

/** Interior of the service pit under the corridor grate. */
export const PIT = { x0: 8.4, x1: 10.3, z0: 2.6, z1: 5.4, floor: -1.1 };

interface Opening {
  a: number;
  b: number;
  top: number;
}

type Faces = Brush["faces"];

const v = (x: number, y: number, z: number) => ({ x, y, z });

export function defineLevel(): LevelData {
  const brushes: Brush[] = [];
  const props: PropSpawn[] = [];
  const lights: LightDef[] = [];

  /** Adds a brush from its min and max corners. */
  const box = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    material: MaterialId,
    faces?: Faces,
  ): void => {
    if (!(x0 < x1 && y0 < y1 && z0 < z1)) {
      throw new Error(`degenerate brush ${[x0, y0, z0, x1, y1, z1].join(",")}`);
    }
    const brush: Brush = { min: v(x0, y0, z0), max: v(x1, y1, z1), material };
    if (faces) brush.faces = faces;
    brushes.push(brush);
  };

  /**
   * A wall running along X (thin in Z), with doorways cut out. Openings start
   * at the floor (y = 0); a sill fills the space below them.
   */
  const wallAlongX = (
    xa: number,
    xb: number,
    z0: number,
    z1: number,
    yBot: number,
    yTop: number,
    material: MaterialId,
    openings: Opening[] = [],
    sill: MaterialId = material,
  ): void => {
    let cur = xa;
    for (const o of [...openings].sort((p, q) => p.a - q.a)) {
      if (o.a > cur) box(cur, yBot, z0, o.a, yTop, z1, material);
      box(o.a, o.top, z0, o.b, yTop, z1, material);
      box(o.a, yBot, z0, o.b, 0, z1, sill);
      cur = o.b;
    }
    if (cur < xb) box(cur, yBot, z0, xb, yTop, z1, material);
  };

  /** A wall running along Z (thin in X), with doorways cut out. */
  const wallAlongZ = (
    x0: number,
    x1: number,
    za: number,
    zb: number,
    yBot: number,
    yTop: number,
    material: MaterialId,
    openings: Opening[] = [],
    sill: MaterialId = material,
  ): void => {
    let cur = za;
    for (const o of [...openings].sort((p, q) => p.a - q.a)) {
      if (o.a > cur) box(x0, yBot, cur, x1, yTop, o.a, material);
      box(x0, o.top, o.a, x1, yTop, o.b, material);
      box(x0, yBot, o.a, x1, 0, o.b, sill);
      cur = o.b;
    }
    if (cur < zb) box(x0, yBot, cur, x1, yTop, zb, material);
  };

  /**
   * Hazard-striped frame around a doorway in a wall facing +/-X. `face` is the
   * X of the wall surface, `dir` the way the frame sticks out (+1 or -1).
   */
  const frameX = (
    face: number,
    dir: 1 | -1,
    zc: number,
    halfW: number,
    height: number,
  ): void => {
    const xa = dir > 0 ? face : face - 0.1;
    const xb = dir > 0 ? face + 0.1 : face;
    box(xa, 0, zc - halfW - BAND, xb, height, zc - halfW, "hazard_stripe");
    box(xa, 0, zc + halfW, xb, height, zc + halfW + BAND, "hazard_stripe");
    box(
      xa,
      height,
      zc - halfW - BAND,
      xb,
      height + BAND,
      zc + halfW + BAND,
      "hazard_stripe",
    );
  };

  /**
   * Wall button on a wall facing +/-X. The world objects own all of its
   * geometry (bezel, lit knob and collider); the level only says where the
   * button face is: BUTTON_DEPTH in front of the wall surface.
   */
  const buttonX = (
    face: number,
    dir: 1 | -1,
    y: number,
    z: number,
  ): { x: number; y: number; z: number } => ({
    x: face + dir * BUTTON_DEPTH,
    y,
    z,
  });

  /** Recessed ceiling fixture: thin emissive slab just below the ceiling. */
  const fixture = (
    cx: number,
    cz: number,
    ceilY: number,
    hx: number,
    hz: number,
    material: MaterialId = "light_panel",
  ): void => {
    box(cx - hx, ceilY - 0.06, cz - hz, cx + hx, ceilY, cz + hz, material);
  };

  const light = (
    x: number,
    y: number,
    z: number,
    color: [number, number, number],
    radius: number,
    intensity: number,
    flicker: LightDef["flicker"] = "none",
    bounds?: LightDef["bounds"],
  ): void => {
    const def: LightDef = {
      position: v(x, y, z),
      color: v(color[0], color[1], color[2]),
      radius,
      intensity,
      flicker,
    };
    if (bounds) def.bounds = bounds;
    lights.push(def);
  };

  /** Prop resting with its bottom at `baseY`. */
  const prop = (
    kind: PropKind,
    x: number,
    baseY: number,
    z: number,
    yaw = 0,
  ): void => {
    props.push({
      kind,
      position: v(x, baseY + PROP_SPECS[kind].halfExtents.y, z),
      yaw,
    });
  };

  /** Bench or desk: cabinet body, plastic top overhanging towards `front`. */
  const bench = (
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    front: "+z" | "-z",
  ): void => {
    box(x0, 0, z0, x1, 0.8, z1, "metal_panel");
    if (front === "+z") {
      box(x0, 0.8, z0, x1, 0.85, z1 + 0.05, "plastic_white");
      box(x0, 0, z1, x1, 0.1, z1 + 0.03, "rubber_dark");
    } else {
      box(x0, 0.8, z0 - 0.05, x1, 0.85, z1, "plastic_white");
      box(x0, 0, z0 - 0.03, x1, 0.1, z0, "rubber_dark");
    }
  };

  /** Open steel shelving along Z against a wall at x0..x1. */
  const shelfAlongZ = (
    x0: number,
    x1: number,
    za: number,
    zb: number,
  ): void => {
    box(x0, 0, za, x1, 2.0, za + 0.05, "metal_panel");
    box(x0, 0, zb - 0.05, x1, 2.0, zb, "metal_panel");
    for (const y of [0.1, 0.7, 1.3, 1.9]) {
      box(x0, y, za + 0.05, x1, y + 0.04, zb - 0.05, "metal_panel");
    }
  };

  /** Open steel shelving along X against a wall at z0..z1. */
  const shelfAlongX = (
    xa: number,
    xb: number,
    z0: number,
    z1: number,
  ): void => {
    box(xa, 0, z0, xa + 0.05, 2.0, z1, "metal_panel");
    box(xb - 0.05, 0, z0, xb, 2.0, z1, "metal_panel");
    for (const y of [0.1, 0.7, 1.3, 1.9]) {
      box(xa + 0.05, y, z0, xb - 0.05, y + 0.04, z1, "metal_panel");
    }
  };

  // -------------------------------------------------------------------------
  // Lab: x -4..4, z -3..3, ceiling 3.0
  // -------------------------------------------------------------------------
  box(-4, -WALL, -3, 4, 0, 3, "lab_floor_tile");
  box(-4, 3, -3, 4, 3 + WALL, 3, "ceiling_panel");
  wallAlongX(-4.3, 4.3, -3.3, -3, -WALL, 3.3, "lab_wall");
  wallAlongX(-4.3, 4.3, 3, 3.3, -WALL, 3.3, "lab_wall");
  wallAlongZ(-4.3, -4, -3, 3, -WALL, 3.3, "lab_wall");
  wallAlongZ(
    4,
    4.3,
    -3,
    3,
    -WALL,
    3.3,
    "lab_wall",
    [{ a: -0.7, b: 0.7, top: 2.2 }],
    "metal_panel",
  );

  // Rubber baseboards.
  box(-4, 0, -3, 4, 0.1, -2.97, "rubber_dark");
  box(-4, 0, 2.97, 4, 0.1, 3, "rubber_dark");
  box(-4, 0, -2.97, -3.97, 0.1, 2.97, "rubber_dark");
  box(3.97, 0, -2.97, 4, 0.1, -0.9, "rubber_dark");
  box(3.97, 0, 0.9, 4, 0.1, 2.97, "rubber_dark");

  // Door A frame on both sides and its two buttons.
  frameX(4, -1, 0, 0.7, 2.2);
  frameX(4.3, 1, 0, 0.7, 2.2);
  const labButton = buttonX(4, -1, 1.2, 1.2);
  const corridorButton = buttonX(4.3, 1, 1.2, -1.08);

  // Lights: three recessed panels, steady cool white.
  for (const cx of [-2.4, 0, 2.4]) {
    fixture(cx, 0, 3, 0.6, 0.3);
    light(cx, 2.6, 0, [0.85, 0.92, 1.0], 7.5, 1.2);
  }
  // Ceiling beams.
  for (const x of [-1.2, 1.2])
    box(x - 0.1, 2.85, -2.8, x + 0.1, 3, 2.8, "metal_panel");
  box(-4, 2.85, -3, 4, 3, -2.8, "metal_panel");
  box(-4, 2.85, 2.8, 4, 3, 3, "metal_panel");

  // Benches along the north wall with a sign between them.
  bench(-3.9, -0.6, -3, -2.3, "+z");
  bench(0.6, 3.9, -3, -2.3, "+z");
  box(-0.5, 1.4, -3, 0.5, 2.4, -2.96, "sign_warning");
  // Wall shelves and instruments on the benches.
  box(-3.9, 1.55, -3, -0.6, 1.59, -2.7, "metal_panel");
  box(0.6, 1.55, -3, 3.9, 1.59, -2.7, "metal_panel");
  box(-3.7, 1.59, -2.95, -3.3, 1.84, -2.75, "plastic_white");
  box(-1.5, 1.59, -2.95, -1.0, 1.79, -2.75, "metal_panel");
  box(1.0, 1.59, -2.95, 1.6, 1.89, -2.75, "plastic_white");
  box(2.8, 1.59, -2.95, 3.4, 1.74, -2.75, "metal_panel");
  box(-3.7, 0.85, -2.95, -3.3, 1.05, -2.6, "plastic_white");
  box(-1.6, 0.85, -2.9, -1.2, 1.2, -2.6, "metal_panel");
  box(0.8, 0.85, -2.9, 1.2, 1.1, -2.6, "plastic_white");
  box(2.8, 0.85, -2.9, 3.3, 1.0, -2.6, "metal_panel");
  // Desk on the west wall.
  box(-4, 0, -1, -3.4, 0.8, -0.4, "metal_panel");
  box(-4, 0, 0.72, -3.4, 0.8, 0.8, "metal_panel");
  box(-4, 0.8, -1, -3.3, 0.85, 0.8, "plastic_white");
  // Central table.
  box(-1, 0.8, -0.5, 1, 0.85, 0.5, "plastic_white");
  for (const sx of [-0.93, 0.85]) {
    for (const sz of [-0.43, 0.35]) {
      box(sx, 0, sz, sx + 0.08, 0.8, sz + 0.08, "metal_panel");
    }
  }
  // Equipment cabinets on the south wall, each with a screen on its front.
  for (const x0 of [0.4, 1.4]) {
    box(x0, 0, 2.3, x0 + 0.8, 2.0, 3, "metal_panel");
    box(x0 + 0.1, 1.0, 2.27, x0 + 0.6, 1.5, 2.3, "monitor_screen");
    box(x0 + 0.1, 0.4, 2.27, x0 + 0.7, 0.9, 2.3, "rubber_dark");
  }
  // A tall rack in the south-west corner area.
  box(-1.8, 0, 2.4, -1.0, 2.2, 3, "metal_panel");
  box(-1.7, 1.2, 2.37, -1.2, 1.7, 2.4, "monitor_screen");

  // Props.
  prop("monitor", -2.5, 0.85, -2.65, Math.PI);
  prop("monitor", 2.0, 0.85, -2.65, Math.PI);
  prop("monitor", 0, 0.85, 0, Math.PI);
  prop("chair", -2.9, 0, 0.2, Math.PI / 2);
  prop("chair", 2.2, 0, -1.8);
  prop("crate_wood_small", -3.4, 0, 2.4);
  prop("crate_wood_small", 3.3, 0, 2.5);

  // -------------------------------------------------------------------------
  // Service corridor
  // -------------------------------------------------------------------------
  box(4.3, -WALL, -1.25, 8.3, 0, 1.25, "concrete_floor");
  box(8.3, -WALL, -1.25, 10.8, 0, 2.5, "concrete_floor");
  box(8.3, -WALL, 5.5, 10.8, 0, 7.7, "concrete_floor");
  // Floor grate over a service pit. The grate is a thin see-through slab
  // (GRATE_THICKNESS) flush with the floor, spanning the whole opening
  // between the walls and the floor either side of it, so its edges abut
  // solid brushes exactly. It rests on a steel angle along three sides, a
  // concrete ledge under the machine on the east side, and two cross beams.
  const gy = -GRATE_THICKNESS;
  box(PIT.x0 - 0.1, gy, PIT.z0 - 0.1, 10.8, 0, PIT.z1 + 0.1, "metal_grate");
  // Pit shell: walls below the corridor floor, 0.3-0.4 m thick, and a 0.2 m
  // floor. Interior x 8.4..10.3, z 2.6..5.4, floor at y = PIT.floor.
  const pf = PIT.floor;
  box(8.0, pf - 0.2, 2.3, 11.1, pf, 5.7, "concrete_floor");
  box(8.0, pf, 2.3, PIT.x0, -WALL, 5.7, "concrete_wall");
  box(PIT.x1, pf, 2.3, 11.1, -WALL, 5.7, "concrete_wall");
  box(PIT.x0, pf, 2.3, PIT.x1, -WALL, PIT.z0, "concrete_wall");
  box(PIT.x0, pf, PIT.z1, PIT.x1, -WALL, 5.7, "concrete_wall");
  // Bearing ledges under the grate: steel angle west, north and south, and
  // a concrete ledge east (the machine stands over it).
  box(8.3, -WALL, 2.5, PIT.x0, gy, 5.5, "metal_panel");
  box(PIT.x0, -WALL, 2.5, PIT.x1, gy, PIT.z0, "metal_panel");
  box(PIT.x0, -WALL, PIT.z1, PIT.x1, gy, 5.5, "metal_panel");
  box(PIT.x1, -WALL, 2.5, 10.8, gy, 5.5, "concrete_wall");
  // Cross beams under the grate.
  for (const z of [3.5, 4.5]) {
    box(PIT.x0, gy - 0.1, z - 0.04, PIT.x1, gy, z + 0.04, "metal_panel");
  }
  // Pipe runs along the pit at three heights: low on saddles in the middle,
  // mid-height on the west wall, high on the east wall.
  box(9.5, pf + 0.15, PIT.z0, 9.7, pf + 0.33, PIT.z1, "pipe");
  for (const z of [3.2, 4.8]) {
    box(9.48, pf, z - 0.05, 9.72, pf + 0.15, z + 0.05, "metal_panel");
  }
  box(PIT.x0, -0.75, PIT.z0, PIT.x0 + 0.15, -0.6, PIT.z1, "pipe");
  box(PIT.x1 - 0.15, -0.42, PIT.z0, PIT.x1, -0.28, PIT.z1, "pipe");
  // Junction box on the west wall, hazard band on the north wall and a dim
  // red pilot lamp on the south wall.
  box(PIT.x0, -0.5, 3.9, PIT.x0 + 0.12, -0.2, 4.3, "metal_panel");
  box(8.7, -0.55, PIT.z0, 10.0, -0.43, PIT.z0 + 0.03, "hazard_stripe");
  box(8.95, -0.88, PIT.z1 - 0.04, 9.15, -0.78, PIT.z1, "button_red");
  // (Its light is added last: flicker phases follow the light index.)
  box(4.3, 2.8, -1.25, 10.8, 3.1, 1.25, "concrete_wall");
  box(8.3, 2.8, 1.25, 10.8, 3.1, 7.7, "concrete_wall");
  wallAlongX(4.3, 11.1, -1.55, -1.25, -WALL, 3.1, "concrete_wall");
  wallAlongZ(10.8, 11.1, -1.25, 7.7, -WALL, 3.1, "concrete_wall");
  wallAlongX(4.3, 8, 1.25, 1.55, -WALL, 3.1, "concrete_wall");
  wallAlongZ(8, 8.3, 1.25, 7.7, -WALL, 3.1, "concrete_wall");

  // Hazard bands near door A.
  box(4.4, 0.3, -1.25, 6.4, 0.6, -1.21, "hazard_stripe");
  box(4.4, 0.3, 1.21, 6.4, 0.6, 1.25, "hazard_stripe");
  // Pipes: along the north wall, round the bend and down the east wall.
  box(4.4, 2.4, -1.25, 10.8, 2.55, -1.1, "pipe");
  box(10.65, 2.4, -1.1, 10.8, 2.55, 7.7, "pipe");
  box(4.4, 2.65, 0.7, 10.8, 2.8, 0.85, "pipe");
  for (const x of [4.9, 6.4, 7.9, 9.4]) {
    box(x - 0.04, 2.25, -1.25, x + 0.04, 2.4, -1.1, "metal_panel");
  }
  for (const z of [2.0, 3.5, 5.0, 6.5]) {
    box(10.65, 2.25, z - 0.04, 10.8, 2.4, z + 0.04, "metal_panel");
  }
  // A second pipe down the west wall of the bend, a conduit on the south
  // wall and a few wall vents.
  box(8.3, 2.4, 1.25, 8.45, 2.55, 7.7, "pipe");
  for (const z of [2.0, 3.5, 5.0, 6.5]) {
    box(8.3, 2.25, z - 0.04, 8.45, 2.4, z + 0.04, "metal_panel");
  }
  box(4.5, 1.75, 1.13, 8.3, 1.85, 1.25, "pipe");
  for (const x of [5.2, 6.8]) {
    box(x - 0.04, 1.65, 1.13, x + 0.04, 1.75, 1.25, "metal_panel");
  }
  for (const x of [5.5, 7.0]) {
    box(x, 1.0, 1.21, x + 0.6, 1.4, 1.25, "rubber_dark");
  }
  box(8.3, 1.0, 3, 8.34, 1.4, 3.6, "rubber_dark");
  // Machine on the east wall with a feed pipe up to the run.
  box(10.3, 0, 3.2, 10.8, 1.6, 4.4, "metal_panel");
  box(10.3, 1.6, 3.2, 10.8, 1.65, 4.4, "rubber_dark");
  box(10.45, 1.65, 3.65, 10.6, 2.4, 3.8, "pipe");
  box(10.28, 0.9, 3.5, 10.3, 1.3, 4.1, "monitor_screen");
  // Fixtures: steady, flickering, and a dead one.
  fixture(5.9, 0, 2.8, 0.3, 0.1);
  fixture(9.55, 0, 2.8, 0.3, 0.1);
  fixture(9.55, 5, 2.8, 0.3, 0.1, "metal_panel");
  light(5.9, 2.4, 0, [1.0, 0.78, 0.5], 6.5, 1.1);
  // The two dynamic lights are confined to the corridor (they have no
  // shadows). The tube at the bend lights the bend and spills 0.5 m through
  // door A; its box stops at the pit's edge, so it can reach below the floor
  // without lighting the pit. The broken lamp hangs over the grate: its box
  // stops at the floor plane so nothing under the grate is lit by it.
  light(9.55, 2.4, 0, [0.9, 0.95, 1.0], 6.5, 1.3, "fluorescent", {
    min: v(3.5, -WALL, -1.55),
    max: v(11.1, 3.1, PIT.z0),
  });
  light(9.55, 2.4, 5, [1.0, 0.85, 0.6], 5.5, 1.0, "broken", {
    min: v(8.0, -0.02, 0.95),
    max: v(11.1, 3.1, 8.5),
  });

  // Storage doorway frame on the corridor end.
  box(8.1, 0, 8, 8.3, 2.8, 8.1, "hazard_stripe");
  box(10.8, 0, 8, 11, 2.8, 8.1, "hazard_stripe");

  // -------------------------------------------------------------------------
  // Storage room: x 5.5..13.5, z 8..16, ceiling 4.0
  // -------------------------------------------------------------------------
  box(5.5, -WALL, 8, 13.5, 0, 16, "concrete_floor");
  box(5.5, 4, 8, 13.5, 4.3, 16, "concrete_wall");
  wallAlongX(
    5.2,
    13.8,
    7.7,
    8,
    -WALL,
    4.3,
    "concrete_wall",
    [{ a: 8.3, b: 10.8, top: 2.8 }],
    "concrete_floor",
  );
  wallAlongX(5.2, 13.8, 16, 16.3, -WALL, 4.3, "metal_panel");
  wallAlongZ(5.2, 5.5, 8, 16, -WALL, 4.3, "metal_panel");
  wallAlongZ(
    13.5,
    13.8,
    8,
    16,
    -WALL,
    4.3,
    "concrete_wall",
    [{ a: 11.3, b: 12.7, top: 2.4 }],
    "metal_panel",
  );
  // Ceiling beams and lamps.
  for (const z of [9.6, 13, 15.6])
    box(5.5, 3.7, z - 0.15, 13.5, 4, z + 0.15, "metal_panel");
  fixture(9, 11, 4, 0.6, 0.25);
  fixture(11, 14.5, 4, 0.6, 0.25);
  light(9, 3.55, 11, [1.0, 0.88, 0.7], 9, 1.5);
  light(11, 3.55, 14.5, [1.0, 0.88, 0.7], 9, 1.5);
  // Pipes on the west wall, hazard band on the north wall, sign on the south.
  box(5.5, 3.3, 8.2, 5.65, 3.45, 16, "pipe");
  box(5.5, 0, 12.1, 5.65, 3.3, 12.25, "pipe");
  box(5.5, 0, 12.4, 5.65, 3.3, 12.55, "pipe");
  box(11.2, 2.4, 8, 13.5, 2.55, 8.1, "hazard_stripe");
  box(9, 1.5, 15.96, 10, 2.5, 16, "sign_warning");
  // Wall pilasters on the east wall.
  box(13.2, 0, 14, 13.5, 4, 14.35, "metal_panel");
  box(13.2, 0, 10.2, 13.5, 4, 10.5, "metal_panel");
  // Shelving and pallets.
  shelfAlongZ(5.5, 6.1, 8.5, 11);
  shelfAlongX(11.2, 13.4, 8, 8.6);
  box(5.6, 0.14, 8.6, 5.9, 0.44, 8.9, "crate_wood");
  box(5.7, 0.74, 9.6, 6.0, 1.04, 9.95, "crate_metal");
  box(5.6, 1.34, 10.2, 5.9, 1.64, 10.5, "crate_wood");
  box(11.4, 0.74, 8.1, 11.8, 1.14, 8.5, "crate_wood");
  box(12.6, 1.34, 8.1, 13.0, 1.74, 8.5, "crate_metal");
  box(12.5, 0, 8.7, 13.4, 0.12, 9.7, "crate_wood");

  // Mezzanine in the south-west corner, 1.4 m up. There are no raised floor
  // markings anywhere, so pushed crates slide freely.
  box(5.5, 0, 13.8, 8.5, 1.3, 16, "metal_panel");
  box(5.5, 1.3, 13.8, 8.5, 1.4, 16, "metal_grate");
  box(5.5, 0.3, 13.74, 8.5, 0.6, 13.8, "hazard_stripe");

  // Door B frame, storage side (the hall frames its own side).
  frameX(13.5, -1, 12, 0.7, 2.4);

  // The corridor pit's red pilot lamp: steady and dim, glowing up through
  // the grate. Last in the list so that the other lights keep their index.
  light(9.05, -0.8, 5.15, [1.0, 0.3, 0.18], 2.6, 0.8);

  // -------------------------------------------------------------------------
  // Storage props
  // -------------------------------------------------------------------------
  // Mezzanine cargo.
  prop("crate_wood", 6.0, 1.4, 15.0);
  prop("crate_weak", 6.9, 1.4, 15.0);
  prop("crate_wood", 7.8, 1.4, 15.0);
  // The heavy crate, 3.8 m from the plate with a clear diagonal push path.
  prop("crate_metal", 11.4, 0, 9.4);
  // Wooden crate on a pallet with a small crate on top.
  prop("crate_wood", 12.95, 0.12, 9.2);
  prop("crate_wood_small", 12.95, 0.92, 9.2);
  // Floor stock.
  prop("crate_weak", 9.7, 0, 15.5);
  prop("crate_wood", 11.0, 0, 15.5);
  prop("crate_wood", 11.0, 0.8, 15.5);
  prop("barrel", 12.5, 0, 15.4);
  prop("barrel", 12.5, 0, 14.5);
  prop("barrel", 13.1, 0, 14.95);
  prop("crate_wood_small", 6.9, 0, 9.6);
  prop("crate_wood_small", 12.2, 0, 13.4);

  // -------------------------------------------------------------------------
  // Doors, plate, buttons, sounds
  // -------------------------------------------------------------------------
  // Slabs are recessed in their walls and slide along -Z right into them,
  // stopping DOOR_OVERTRAVEL past the jamb so no face of an open slab lies in
  // the jamb plane.
  const slab = (
    id: string,
    wallX0: number,
    wallX1: number,
    z0: number,
    z1: number,
    height: number,
  ): DoorDef => ({
    id,
    closed: {
      min: v(wallX0 + DOOR_INSET, 0, z0),
      max: v(wallX1 - DOOR_INSET, height, z1),
    },
    openOffset: v(0, 0, -(z1 - z0 + DOOR_OVERTRAVEL)),
    material: "door_steel",
  });
  const doors: DoorDef[] = [
    slab("door_a", 4, 4.3, -0.7, 0.7, 2.2),
    slab("door_b", 13.5, 13.8, 11.3, 12.7, 2.4),
  ];
  const buttons: ButtonDef[] = [
    {
      id: "button_a_lab",
      position: v(labButton.x, labButton.y, labButton.z),
      facing: v(-1, 0, 0),
      target: "door_a",
    },
    {
      id: "button_a_corridor",
      position: v(corridorButton.x, corridorButton.y, corridorButton.z),
      facing: v(1, 0, 0),
      target: "door_a",
    },
  ];
  const plates: PressurePlateDef[] = [
    {
      id: "plate_b",
      box: { min: v(7.9, 0, 11.4), max: v(9.1, 0.04, 12.6) },
      requiredMass: 45,
      target: "door_b",
    },
  ];
  const emitters: SoundEmitterDef[] = [
    { sound: "hum_fluorescent", position: v(9.55, 2.5, 0), gain: 0.5 },
    { sound: "hum_machine", position: v(10.1, 1.2, 3.8), gain: 0.6 },
    { sound: "ambient_drone", position: v(9.55, 1.5, 2), gain: 0.4 },
  ];

  // Acoustic zones of the first three rooms; they overlap a little in the
  // doorways (the game switches with hysteresis).
  const zones: AcousticZone[] = [
    { box: { min: v(-4, 0, -3), max: v(4.15, 3, 3) }, room: "lab" },
    {
      box: { min: v(4.15, PIT.floor, -1.25), max: v(10.8, 2.8, 1.25) },
      room: "corridor",
    },
    {
      box: { min: v(8.3, PIT.floor, 1.25), max: v(10.8, 2.8, 7.85) },
      room: "corridor",
    },
    { box: { min: v(5.5, 0, 7.85), max: v(13.65, 4, 16) }, room: "hall" },
  ];

  // -------------------------------------------------------------------------
  // Beyond door B: the filtration hall, valve chamber and egress lock.
  // -------------------------------------------------------------------------
  const hall = buildFiltrationHall(
    {
      box: (min, max, material) =>
        box(min.x, min.y, min.z, max.x, max.y, max.z, material),
      light: (def) => lights.push(def),
      prop: (kind, base, yaw) => prop(kind, base.x, base.y, base.z, yaw),
      door: (def) => doors.push(def),
      button: (def) => buttons.push(def),
      emitter: (def) => emitters.push(def),
      zone: (z) => zones.push(z),
    },
    HALL_CONNECTOR,
  );

  return {
    name: "Kestrel Annex",
    brushes,
    lights,
    playerSpawn: { position: v(-2, 0, 1.6), yaw: -Math.PI / 2 },
    props,
    doors,
    buttons,
    plates,
    emitters,
    ambient: v(0.07, 0.075, 0.09),
    fog: { color: v(0.07, 0.09, 0.11), near: 12, far: 40 },
    exit: hall.exit,
    zones,
  };
}
