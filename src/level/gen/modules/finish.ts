/**
 * The finish of a generated run: a small, walled exit lock (unlike the
 * hand-built level's egress lock, whose open entry needs a neighbour wall
 * at least 3.6 x 3.3 m). Green light, warning signs on both side walls, a
 * status screen beside the sealed outer hatch on the far wall, and the exit
 * box filling the lock past its first metre.
 *
 *   top view
 *   +====+=================+====+
 *   |    |   [sign]        |    |
 *   entry      (exit box)   hatch
 *   |    |   [sign]        |    |
 *   +====+=================+====+
 */
import {
  type Connector,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "../../rooms/room";
import { buildShell, shellZone } from "./shell";

const DEPTH = 3.6;
const HALF = 1.6;
const HEIGHT = 3;

function build(ctx: RoomContext, at: Connector): RoomPlan {
  // A shell whose far wall is blank (zero-width exit, not reported).
  const s = buildShell(ctx, at, {
    depth: DEPTH,
    left: HALF,
    right: HALF,
    height: HEIGHT,
    exit: { side: "ahead", offset: 0, width: 0, height: 0 },
    floor: "lab_floor_tile",
    wall: "metal_panel",
    ceiling: "metal_panel",
  });
  const { kit: k, frame: L, x0, x1, zl, zr } = s;
  // The sealed outer hatch: a steel slab set into the far wall, framed.
  k.box(x1 - 0.04, 0, -0.7, x1, 2.4, 0.7, "door_steel");
  k.frameX(x1, -1, -0.7, 0.7, 2.4);
  k.box(x1 - 0.04, 1.0, 1.0, x1, 1.6, 1.45, "monitor_screen");
  k.box(x0 + 1.4, 1.0, zl, x0 + 2.4, 2.0, zl + 0.04, "sign_warning");
  k.box(x0 + 1.4, 1.0, zr - 0.04, x0 + 2.4, 2.0, zr, "sign_warning");
  k.fixture(x0 + 1.9, 0, HEIGHT, 0.3, 0.3, "button_green");
  k.light(x0 + 1.9, HEIGHT - 0.45, 0, [0.35, 1.0, 0.45], 4.5, 1.6);
  shellZone(s, "small");

  const exit = L.box(x0 + 1, 0, zl, x1, HEIGHT, zr);
  return {
    footprint: s.footprint,
    entry: s.entryDoorway,
    exits: [],
    exit,
    lock: {
      kind: "none",
      doors: [],
      buttons: [],
      plates: [],
      keys: [],
    },
    solution: [{ do: "walk", to: L.point((x0 + 1 + x1) / 2, 0, 0) }],
  };
}

export const EXIT_LOCK: RoomModule = {
  name: "exit-lock",
  role: "finish",
  teaches: "none",
  difficulty: 0,
  requires: {},
  entrySize: { width: [1.0, 2.4], height: [2.0, 2.6] },
  defaults: {},
  random: () => ({}),
  build: (ctx, at) => build(ctx, at),
};
