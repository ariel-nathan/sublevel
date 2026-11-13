import type { LevelData } from "../core/api";
import { createRng, hashString } from "../core/rng";
import type { Vec3 } from "../math";
import {
  assembleLevel,
  place,
  planRoom,
  type AssembledLevel,
  type Placement,
} from "./assemble";
import { KESTREL_ANNEX } from "./define";
import { boxesOverlap, boxOf, type Box } from "./geometry";
import { CORRIDOR, type CorridorParams } from "./rooms/corridor";
import { LAB } from "./rooms/lab";
import { EXIT_LOCK, PENDING_MODULES } from "./rooms/puzzles";
import { ROOM_MODULES } from "./rooms/registry";
import type { AnyRoomModule, Connector } from "./rooms/room";

/** Every module a development level can name: the registry and the pending. */
export const DEV_MODULES: readonly AnyRoomModule[] = [
  ...ROOM_MODULES,
  ...PENDING_MODULES,
];

/** A parsed room name: `name`, `name!default`, `name@mirror`, or both. */
export interface RoomRequest {
  module: AnyRoomModule;
  defaults: boolean;
  mirror: boolean;
}

export function parseRoomName(text: string): RoomRequest {
  let name = text.trim();
  let defaults = false;
  let mirror = false;
  for (;;) {
    if (name.endsWith("!default")) {
      defaults = true;
      name = name.slice(0, -"!default".length);
    } else if (name.endsWith("@mirror")) {
      mirror = true;
      name = name.slice(0, -"@mirror".length);
    } else break;
  }
  const module = DEV_MODULES.find((m) => m.name === name);
  if (!module) {
    throw new Error(
      `unknown room module "${name}" (known: ${DEV_MODULES.map((m) => m.name).join(", ")})`,
    );
  }
  if (module.role !== "middle") {
    throw new Error(`room module "${name}" is a ${module.role} module`);
  }
  return { module, defaults, mirror };
}

/** A per-placement seed from the level seed, the slot and a salt. */
const mix = (seed: number, slot: number, salt: string): number =>
  hashString(`${seed}:${slot}:${salt}`);

const WANT: Vec3 = { x: 1, y: 0, z: 0 };

/** Corridor shapes to try after an exit, best first. */
function corridorCandidates(exit: Connector): Partial<CorridorParams>[] {
  const f = exit.facing;
  const ahead = f.x * WANT.x + f.z * WANT.z;
  const right = -f.z * WANT.x + f.x * WANT.z;
  const lengths = [3, 4, 5, 6.5, 8, 10];
  const straight = lengths.map((length) => ({ length, bend: "none" as const }));
  const bend = (b: "left" | "right") =>
    lengths.flatMap((length) =>
      [0, 2, 4].map((leg) => ({ length, bend: b, leg })),
    );
  if (ahead > 0.5) return [...straight, ...bend("left"), ...bend("right")];
  const toward = right > 0 ? "right" : "left";
  const away = right > 0 ? "left" : "right";
  return [...bend(toward), ...straight, ...bend(away)];
}

/**
 * Development level: the opening room (the lab), then the named room
 * modules in order, each reached through a short connecting corridor, then
 * a corridor and the exit lock. Parameters are random from the seed, or the
 * module's defaults for a name ending in `!default`; `@mirror` mirrors it.
 * Corridors are chosen (first fit from a fixed list) so that the chain heads
 * along +X and no two footprints overlap; if none fits, the assembler's
 * overlap error is thrown. Deterministic.
 */
export function buildRoomsLevel(
  rooms: readonly string[],
  seed: number,
): LevelData {
  return assembleRoomsLevel(rooms, seed).data;
}

/** `buildRoomsLevel` with the placed rooms (for tests and tools). */
export function assembleRoomsLevel(
  rooms: readonly string[],
  seed: number,
): AssembledLevel {
  const requests = rooms.map(parseRoomName);
  const placements: Placement[] = [place(LAB, { name: "lab" })];
  const root = KESTREL_ANNEX.root;
  const labPlan = planRoom(LAB, { ...root, width: 0, height: 0 });
  const taken: Box[] = labPlan.footprint.map(boxOf);
  let exit = labPlan.exits[0].connector;

  const fits = (boxes: Box[]) =>
    !boxes.some((a) => taken.some((b) => boxesOverlap(a, b, 1e-6)));

  const chain = (
    module: AnyRoomModule,
    name: string,
    params: unknown,
    mirror: boolean,
    slot: number,
  ) => {
    const rng = createRng(mix(seed, slot, "corridor"));
    const look = {
      width: 2.2 + Math.round(rng.next() * 4) * 0.1,
      height: 2.9 + Math.round(rng.next() * 3) * 0.1,
      pipes: rng.next() < 0.6,
      light: (["steady", "fluorescent", "steady", "broken"] as const)[
        rng.int(0, 3)
      ],
    };
    const roomSeed = mix(seed, slot, "room");
    let first: { corridor: CorridorParams } | null = null;
    for (const shape of corridorCandidates(exit)) {
      const corridor: CorridorParams = {
        ...CORRIDOR.defaults,
        ...look,
        ...shape,
      };
      first ??= { corridor };
      const cplan = planRoom(CORRIDOR, exit, { params: corridor });
      const cboxes = cplan.footprint.map(boxOf);
      if (!fits(cboxes)) continue;
      const at = cplan.exits[0].connector;
      const plan = planRoom(module, at, { params, mirror, seed: roomSeed });
      const boxes = plan.footprint.map(boxOf);
      if (boxes.some((a) => cboxes.some((b) => boxesOverlap(a, b, 1e-6)))) {
        continue;
      }
      if (!fits(boxes)) continue;
      placements.push(place(CORRIDOR, { name: `c${slot}`, params: corridor }), {
        module,
        name,
        params,
        mirror,
        seed: roomSeed,
      });
      taken.push(...cboxes, ...boxes);
      if (plan.exits.length > 0) exit = plan.exits[0].connector;
      return;
    }
    // Nothing fits: place the first shape and let the assembler say why.
    placements.push(
      place(CORRIDOR, { name: `c${slot}`, params: first!.corridor }),
      { module, name, params, mirror, seed: roomSeed },
    );
    assembleLevel({ ...KESTREL_ANNEX, name: "rooms", seed, placements });
    throw new Error(`no room for "${name}" in the development level`);
  };

  requests.forEach((r, i) => {
    const params = r.defaults
      ? r.module.defaults
      : r.module.random(createRng(mix(seed, i + 1, "params")));
    chain(r.module, `r${i + 1}.${r.module.name}`, params, r.mirror, i + 1);
  });
  chain(EXIT_LOCK, "finish", {}, false, requests.length + 1);

  return assembleLevel({
    ...KESTREL_ANNEX,
    name: `rooms: ${rooms.join(", ")}`,
    seed,
    placements,
  });
}
