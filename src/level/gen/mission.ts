/**
 * The mission: which puzzle rooms a run has and in what order, decided
 * before any geometry. Pure and seeded.
 *
 * Rules (each one is a function below, checked by `missionProblems`):
 *   1. Only modules with role "middle", a real lock (`teaches` not "none"),
 *      no requirements from earlier rooms (`requires` empty: every module
 *      chosen supplies its own keys), and exactly one exit.
 *   2. As many distinct mechanics as the pool offers (up to the room count).
 *   3. No mechanic more than `maxPerMechanic` times, unless there are too
 *      few mechanics to fill the rooms otherwise.
 *   4. The first room of each mechanic is one of its easiest modules
 *      (teach, then test); later rooms of it are no easier.
 *   5. Difficulty never drops from one room to the next (ramps up), where
 *      the chosen rooms allow it with rules 4 and 6.
 *   6. No module twice in a row (and, where possible, no mechanic twice in
 *      a row).
 *
 * To add a rule: add a check to `missionProblems` (so the tests see it),
 * then make `chooseMission` respect it, as a hard constraint in `order`
 * or as a preference in its ranking.
 */
import type { Rng } from "../../core/rng";
import type { AnyRoomModule, Mechanic } from "../rooms/room";

export interface MissionRoom {
  module: AnyRoomModule;
  mechanic: Mechanic;
  difficulty: number;
  /** True for the first (easiest) room of its mechanic. */
  teaches: boolean;
}

/** Rule 1: can this module be a puzzle room of a generated run? */
export function eligible(
  module: AnyRoomModule,
  exitsOf: (module: AnyRoomModule) => number,
): boolean {
  const r = module.requires;
  return (
    module.role === "middle" &&
    module.teaches !== "none" &&
    !((r.carryMass ?? 0) > 0) &&
    !((r.throwables ?? 0) > 0) &&
    exitsOf(module) === 1
  );
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** How many rooms each mechanic gets (rules 2 and 3). */
export function allocate(
  mechanics: readonly Mechanic[],
  rooms: number,
  maxPerMechanic: number,
): Map<Mechanic, number> {
  const counts = new Map<Mechanic, number>();
  if (mechanics.length === 0) return counts;
  const cap = Math.max(maxPerMechanic, Math.ceil(rooms / mechanics.length));
  let left = rooms;
  for (const m of mechanics) {
    if (left === 0) break;
    counts.set(m, 1);
    left--;
  }
  while (left > 0) {
    for (const m of mechanics) {
      if (left === 0) break;
      const c = counts.get(m)!;
      if (c < cap) {
        counts.set(m, c + 1);
        left--;
      }
    }
  }
  return counts;
}

/**
 * Chooses and orders `rooms` puzzle rooms from `pool` (already filtered by
 * `eligible`). Throws if the pool is empty.
 */
export function chooseMission(
  pool: readonly AnyRoomModule[],
  rooms: number,
  maxPerMechanic: number,
  rng: Rng,
): MissionRoom[] {
  if (pool.length === 0) {
    throw new Error("no eligible puzzle modules to build a run from");
  }
  const byName = [...pool].sort((a, b) => (a.name < b.name ? -1 : 1));
  const groups = new Map<Mechanic, AnyRoomModule[]>();
  for (const m of byName) {
    const list = groups.get(m.teaches) ?? [];
    list.push(m);
    groups.set(m.teaches, list);
  }
  const mechanics = shuffle([...groups.keys()].sort(), rng);
  const counts = allocate(mechanics, rooms, maxPerMechanic);

  // Pick the modules of each mechanic: an easiest one first, then the
  // others not yet used, easier first, then round again.
  const items: MissionRoom[] = [];
  for (const mechanic of mechanics) {
    const count = counts.get(mechanic) ?? 0;
    if (count === 0) continue;
    const list = shuffle([...groups.get(mechanic)!], rng).sort(
      (a, b) => a.difficulty - b.difficulty,
    );
    const first = list[0];
    const rest = list.slice(1);
    const picks = [first];
    for (let i = 0; picks.length < count; i++) {
      picks.push(rest.length > 0 ? rest[i % rest.length] : first);
    }
    picks.forEach((module, i) =>
      items.push({
        module,
        mechanic,
        difficulty: module.difficulty,
        teaches: i === 0,
      }),
    );
  }
  // Random tie-break keys, drawn once so the order search is deterministic.
  const keys = new Map(items.map((item) => [item, rng.next()]));
  return order(items, keys) ?? order(items, keys, false)!;
}

/**
 * Depth-first search for an order: hard rules 4 (teach first) and, if
 * `distinct`, 6 (no module twice in a row); preferring the lowest
 * difficulty, then a different mechanic from the previous room, then the
 * random key.
 */
function order(
  items: MissionRoom[],
  keys: Map<MissionRoom, number>,
  distinct = true,
): MissionRoom[] | null {
  const out: MissionRoom[] = [];
  const used = new Set<MissionRoom>();
  const taught = new Set<Mechanic>();
  const step = (): boolean => {
    if (out.length === items.length) return true;
    const prev = out[out.length - 1];
    const options = items
      .filter(
        (item) =>
          !used.has(item) &&
          (item.teaches || taught.has(item.mechanic)) &&
          !(distinct && prev && prev.module === item.module),
      )
      .sort(
        (a, b) =>
          a.difficulty - b.difficulty ||
          Number(prev?.mechanic === a.mechanic) -
            Number(prev?.mechanic === b.mechanic) ||
          keys.get(a)! - keys.get(b)!,
      );
    for (const item of options) {
      out.push(item);
      used.add(item);
      const fresh = item.teaches && !taught.has(item.mechanic);
      if (fresh) taught.add(item.mechanic);
      if (step()) return true;
      out.pop();
      used.delete(item);
      if (fresh) taught.delete(item.mechanic);
    }
    return false;
  };
  return step() ? out : null;
}

/** What is wrong with a mission, by the rules above (empty if nothing). */
export function missionProblems(
  mission: readonly MissionRoom[],
  pool: readonly AnyRoomModule[],
  rooms: number,
  maxPerMechanic: number,
): string[] {
  const problems: string[] = [];
  if (mission.length !== rooms) {
    problems.push(`${mission.length} rooms, not ${rooms}`);
  }
  const offered = new Set(pool.map((m) => m.teaches));
  const used = new Map<Mechanic, number>();
  for (const r of mission)
    used.set(r.mechanic, (used.get(r.mechanic) ?? 0) + 1);
  if (used.size < Math.min(offered.size, rooms)) {
    problems.push(`${used.size} mechanics of ${offered.size} offered`);
  }
  const cap = Math.max(maxPerMechanic, Math.ceil(rooms / offered.size));
  for (const [m, n] of used) {
    if (n > cap) problems.push(`${m} ${n} times`);
  }
  const easiest = new Map<Mechanic, number>();
  for (const m of pool) {
    easiest.set(m.teaches, Math.min(easiest.get(m.teaches) ?? 9, m.difficulty));
  }
  const seen = new Map<Mechanic, number>();
  mission.forEach((r, i) => {
    if (!pool.includes(r.module)) problems.push(`room ${i}: not in the pool`);
    const first = seen.get(r.mechanic);
    if (first === undefined) {
      if (r.difficulty !== easiest.get(r.mechanic)) {
        problems.push(
          `room ${i}: ${r.mechanic} first appears above its easiest`,
        );
      }
      seen.set(r.mechanic, r.difficulty);
    } else if (r.difficulty < first) {
      problems.push(`room ${i}: easier than the first ${r.mechanic} room`);
    }
    if (i > 0 && mission[i - 1].module === r.module) {
      const distinctPossible = new Set(mission.map((x) => x.module)).size > 1;
      if (distinctPossible)
        problems.push(`room ${i}: same module twice in a row`);
    }
  });
  return problems;
}

/** True if difficulty never drops along the mission (rule 5). */
export const ramps = (mission: readonly MissionRoom[]): boolean =>
  mission.every((r, i) => i === 0 || r.difficulty >= mission[i - 1].difficulty);
