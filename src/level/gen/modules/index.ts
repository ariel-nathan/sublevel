/**
 * The generator's own room modules, kept out of the shared registry
 * (src/level/rooms/registry.ts):
 *
 * - `EXIT_LOCK`, the finish of every generated run;
 * - `ADAPTER`, a short passage that changes the doorway size or widens its
 *   exit wall for a module with an open entry;
 * - three stand-in puzzle rooms (toggle button, weighted plate, impact
 *   target) that exercise selection, ordering and solvability until the
 *   real parametric puzzle rooms are registered. `STANDIN_MODULES` is what
 *   to delete (or keep) once they are.
 */
import type { AnyRoomModule } from "../../rooms/room";
import { ADAPTER } from "./adapter";
import { EXIT_LOCK } from "./finish";
import { STANDIN_PLATE } from "./standin-plate";
import { STANDIN_SWITCH } from "./standin-switch";
import { STANDIN_TARGET } from "./standin-target";

export { ADAPTER, EXIT_LOCK };

export const STANDIN_MODULES: readonly AnyRoomModule[] = [
  STANDIN_SWITCH,
  STANDIN_PLATE,
  STANDIN_TARGET,
];

/** Every module defined here, for the contract tests. */
export const GEN_MODULES: readonly AnyRoomModule[] = [
  EXIT_LOCK,
  ADAPTER,
  ...STANDIN_MODULES,
];
