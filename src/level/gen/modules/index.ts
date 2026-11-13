/**
 * The generator's own room module, kept out of the shared registry
 * (src/level/rooms/registry.ts): `ADAPTER`, a short passage that changes
 * the doorway size or widens its exit wall for a module with an open entry.
 * (The finish of every run is the registry's exit lock,
 * rooms/puzzles/exit-lock.ts.)
 */
import type { AnyRoomModule } from "../../rooms/room";
import { ADAPTER } from "./adapter";

export { ADAPTER };

/** Every module defined here, for the contract tests. */
export const GEN_MODULES: readonly AnyRoomModule[] = [ADAPTER];
