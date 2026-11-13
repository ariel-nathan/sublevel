/**
 * Every room module, for the generator to choose from and for the module
 * contract tests (rooms/contract.test.ts), which check each one in every
 * orientation. Add a new module here.
 */
import type { AnyRoomModule } from "./room";
import { CORRIDOR } from "./corridor";
import { EGRESS_LOCK } from "./egress-lock";
import { FILTRATION_HALL } from "./filtration-hall";
import { LAB } from "./lab";
import { SERVICE_CORRIDOR } from "./service-corridor";
import { STORAGE } from "./storage";
import { VALVE_CHAMBER } from "./valve-chamber";
import { EXIT_LOCK, PUZZLE_MODULES } from "./puzzles";

export const ROOM_MODULES: readonly AnyRoomModule[] = [
  LAB,
  SERVICE_CORRIDOR,
  STORAGE,
  FILTRATION_HALL,
  VALVE_CHAMBER,
  EGRESS_LOCK,
  CORRIDOR,
  ...PUZZLE_MODULES,
  EXIT_LOCK,
];
