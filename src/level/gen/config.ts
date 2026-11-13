import type { Color, Fog } from "../../core/api";
import { KESTREL_ANNEX } from "../define";
import { CORRIDOR, type CorridorParams } from "../rooms/corridor";
import { LAB } from "../rooms/lab";
import { EXIT_LOCK } from "../rooms/puzzles";
import { ROOM_MODULES } from "../rooms/registry";
import type { AnyRoomModule, RoomModule } from "../rooms/room";
import { ADAPTER } from "./modules";

/** Everything that tunes a generated run. `DEFAULT_CONFIG` is what the game uses. */
export interface GeneratorConfig {
  /** Puzzle rooms between the start and the finish. */
  rooms: number;
  /** The authored opening room (role "start") and the finish (role "finish"). */
  start: AnyRoomModule;
  finish: AnyRoomModule;
  /** The connecting corridor between rooms, and the doorway adapter. */
  corridor: RoomModule<CorridorParams>;
  adapter: AnyRoomModule;
  /**
   * The modules puzzle rooms are chosen from, read when a run is generated
   * (role "middle", a real lock, no outside requirements: see mission.ts).
   */
  pool: () => readonly AnyRoomModule[];
  /** A mechanic appears at most this often, unless variety runs out. */
  maxPerMechanic: number;
  /**
   * How many authored set pieces (modules with `setPiece`) a run has, at
   * least and at most: the seed chooses the number and which.
   */
  setPieces: readonly [number, number];
  /** Least gap between the footprints of modules that are not neighbours. */
  clearance: number;
  /** Corridor lengths and second-leg lengths the layout search tries. */
  corridorLengths: readonly number[];
  corridorLegs: readonly number[];
  /** Candidate placements tried per step before backing up. */
  branching: number;
  /** Modules planned in the whole search before giving up on it. */
  searchBudget: number;
  /** Weight of randomness against compactness when ranking candidates (0..1). */
  jitter: number;
  ambient: Color;
  fog: Fog;
}

export const DEFAULT_CONFIG: GeneratorConfig = {
  rooms: 8,
  start: LAB,
  finish: EXIT_LOCK,
  corridor: CORRIDOR,
  adapter: ADAPTER,
  pool: () => ROOM_MODULES,
  maxPerMechanic: 2,
  setPieces: [1, 2],
  clearance: 0.5,
  corridorLengths: [3, 4.5, 6, 8],
  corridorLegs: [0, 1.5, 3],
  branching: 4,
  searchBudget: 4000,
  jitter: 0.35,
  ambient: KESTREL_ANNEX.ambient,
  fog: KESTREL_ANNEX.fog,
};
