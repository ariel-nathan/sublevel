/**
 * The library of parametric puzzle rooms (see README.md in src/level).
 * `PUZZLE_MODULES` are registered (rooms/registry.ts) and proven by the
 * contract tests and the solver bot; `PENDING_MODULES` are complete rooms
 * whose declared solution needs a step the solution format cannot express
 * yet (climbing onto props): development levels can name them, the
 * generator must not use them.
 */
import type { AnyRoomModule } from "../room";
import { EXIT_LOCK } from "./exit-lock";
import { DECON_LOCK } from "./decon-lock";
import { FAN_ROOM } from "./fan-room";
import { FREIGHT_PASSAGE } from "./freight-passage";
import { GENERATOR_HALL } from "./generator-hall";
import { GOODS_BAY } from "./goods-bay";
import { MAINTENANCE_LOFT } from "./maintenance-loft";
import { PARTS_STORE } from "./parts-store";
import { PUMP_GALLERY } from "./pump-gallery";
import { RECORDS_OFFICE } from "./records-office";

export { EXIT_LOCK };

export const PUZZLE_MODULES: readonly AnyRoomModule[] = [
  RECORDS_OFFICE,
  GOODS_BAY,
  PARTS_STORE,
  GENERATOR_HALL,
  FREIGHT_PASSAGE,
  DECON_LOCK,
  PUMP_GALLERY,
  FAN_ROOM,
];

export const PENDING_MODULES: readonly AnyRoomModule[] = [MAINTENANCE_LOFT];
