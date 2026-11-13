/**
 * Exit lock: a plain finish module with a walled entry (it joins any
 * doorway in `ENTRY_SIZE`), used to end development levels and generated
 * runs. A small tiled room, a green lamp over the exit box, warning signs,
 * a status screen and a way-back button for the previous module's door.
 *
 * Design coordinates: the entry's local frame. The room is x 0.3..3.6,
 * z -1.6..1.6, ceiling 3.0; the exit box is the far two metres.
 *
 * Softlocks: none possible; nothing to solve, and the way-back button
 * reopens the previous door.
 */
import {
  BUTTON_DEPTH,
  NO_LOCK,
  rectOnPlane,
  roomFrame,
  WALL as W,
  type RoomModule,
} from "../room";
import { LOCAL_DESIGN } from "../room";
import { createKit } from "../kit";
import { ENTRY_SIZE, RETURN_SECONDS } from "./shell";

const ROOM = { x1: 3.6, s: 1.6, h: 3.0 };

export const EXIT_LOCK: RoomModule = {
  name: "exit-lock",
  role: "finish",
  teaches: "none",
  difficulty: 0,
  requires: {},
  entrySize: ENTRY_SIZE,
  defaults: {},
  random: () => ({}),
  build(ctx, at) {
    const F = roomFrame(at, ctx.mirror, LOCAL_DESIGN);
    const k = createKit(ctx, F);
    const B = k.box;
    const { x1, s, h } = ROOM;
    const eh = at.width / 2;
    B(W, -W, -s, x1, 0, s, "lab_floor_tile");
    B(W, h, -s, x1, h + W, s, "metal_panel");
    k.wallAlongZ(
      0,
      W,
      -s,
      s,
      -W,
      h + W,
      "metal_panel",
      [{ a: -eh, b: eh, top: at.height }],
      "metal_panel",
    );
    k.frameX(W, 1, -eh, eh, at.height);
    k.wallAlongZ(x1, x1 + W, -s, s, -W, h + W, "metal_panel");
    k.wallAlongX(0, x1 + W, -s - W, -s, -W, h + W, "metal_panel");
    k.wallAlongX(0, x1 + W, s, s + W, -W, h + W, "metal_panel");
    // Status screen on the far wall, signs on the side walls, a hazard band
    // across the floor where the exit box begins.
    B(x1 - 0.04, 1.1, -0.5, x1, 1.9, 0.5, "monitor_screen");
    B(x1 - 0.03, 2.05, -0.7, x1, 2.25, 0.7, "hazard_stripe");
    B(2.0, 1.1, -s, 2.9, 1.9, -s + 0.03, "sign_warning");
    B(2.0, 1.1, s - 0.03, 2.9, 1.9, s, "sign_warning");
    B(1.5, 0, -s, 1.6, 0.01, s, "hazard_stripe");
    k.fixture(2.4, 0, h, 0.35, 0.35, "button_green");
    k.light(2.4, h - 0.45, 0, [0.35, 1.0, 0.45], 4.5, 1.6);
    if (at.door !== undefined) {
      k.button(
        ctx.id("button_back"),
        at.door,
        W + BUTTON_DEPTH,
        1.2,
        eh + 0.45,
        [1, 0],
        "timed",
        RETURN_SECONDS,
      );
    }
    k.zone(F.box(W, 0, -s, x1, h, s), "small");
    const exitBox = F.box(1.6, 0, -s, x1, h, s);
    return {
      footprint: [F.box(0, -W, -s - W, x1 + W, h + W, s + W)],
      entry: {
        connector: at,
        end: {
          wall: true,
          extent: rectOnPlane(at, F.box(0, -W, -s - W, 0, h + W, s + W)),
        },
      },
      exits: [],
      exit: exitBox,
      lock: NO_LOCK,
      solution: [{ do: "walk", to: F.point(2.7, 0, 0) }],
    };
  },
};
