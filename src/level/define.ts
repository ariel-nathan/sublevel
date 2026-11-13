import type { LevelData } from "../core/api";
import { assembleLevel, type AssembledLevel, type LevelPlan } from "./assemble";
import { EGRESS_LOCK } from "./rooms/egress-lock";
import { FILTRATION_HALL } from "./rooms/filtration-hall";
import { LAB } from "./rooms/lab";
import { SERVICE_CORRIDOR } from "./rooms/service-corridor";
import { STORAGE } from "./rooms/storage";
import { VALVE_CHAMBER } from "./rooms/valve-chamber";

/**
 * "Kestrel Annex", the hand-built level, as a chain of six room modules:
 * the lab (door A, two toggle buttons), the service corridor with the grate
 * over a pit, the storage room (a pressure plate holds door B), the
 * filtration hall (timed door T), the valve chamber (an impact target opens
 * the exit door) and the egress lock with the exit box.
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
 *
 * Ids keep their hand-written names (no instance prefix): they are unique.
 */
export const KESTREL_ANNEX: LevelPlan = {
  name: "Kestrel Annex",
  root: { position: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 } },
  placements: [
    { module: LAB, name: "lab", prefix: "" },
    { module: SERVICE_CORRIDOR, name: "corridor", prefix: "" },
    { module: STORAGE, name: "storage", prefix: "" },
    { module: FILTRATION_HALL, name: "hall", prefix: "" },
    { module: VALVE_CHAMBER, name: "chamber", prefix: "" },
    { module: EGRESS_LOCK, name: "lock", prefix: "" },
  ],
  ambient: { x: 0.07, y: 0.075, z: 0.09 },
  fog: { color: { x: 0.07, y: 0.09, z: 0.11 }, near: 12, far: 40 },
  seed: null,
};

export function assembleKestrelAnnex(): AssembledLevel {
  return assembleLevel(KESTREL_ANNEX);
}

export function defineLevel(): LevelData {
  return assembleKestrelAnnex().data;
}
