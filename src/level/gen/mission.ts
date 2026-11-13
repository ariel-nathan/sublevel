/**
 * The mission: which puzzle rooms a run has and in what order, decided
 * before any geometry. Pure and seeded.
 *
 * The pool (rule 0): modules with role "middle", a real lock (`teaches` not
 * "none"), no requirements from earlier rooms (`requires` empty: every
 * module supplies its own keys) and exactly one exit; a module whose `after`
 * names a mechanic no other module of the pool teaches is left out.
 *
 * Rules, by precedence (a later rule gives way when it conflicts with an
 * earlier one; `missionProblems` checks 1-5 and 7, `ramps` checks 6):
 *   1. No module twice in a run, unless the pool has fewer modules than the
 *      run has rooms (then none twice in a row). Authored set pieces
 *      (`setPiece`): as many as the seed chooses within `setPieces`, each
 *      at most once.
 *   2. Teach, then test: a mechanic's first room is one of its easiest
 *      modules in the pool; a module's `after` mechanics have all been
 *      taught by earlier rooms; a module with `position: "first"` is the
 *      run's first room whenever it is in the run.
 *   3. As many distinct mechanics as the pool offers (up to the room count),
 *      none more than `maxPerMechanic` times unless there are too few
 *      mechanics to fill the rooms.
 *   4. No two rooms in a row with the same mechanic or the same `idea`.
 *   5. A module with `position: "early"` is in the first half of the run.
 *   6. Difficulty never drops from one room to the next.
 *   7. Preferably no two modules with the same `idea` in one run (a set
 *      piece and the parametric room that re-takes its puzzle).
 * Within these the choice is random: which modules (when the pool has more
 * than the run needs), which set pieces, and the order among equals.
 *
 * How: the set pieces are drawn, then every set of `rooms` modules from the
 * pool (without the set pieces not drawn) that can satisfy 1-3 is listed;
 * the sets with the fewest shared ideas (7) are tried first, in a seeded
 * random order, each ordered by a depth-first search with 2, 4, 5 and 6 as
 * hard constraints (lowest difficulty first, random among equals). If no
 * set can be ordered so, the search runs again without 5 and 6, then
 * without 4 (pools too small for them).
 *
 * To add a rule: add a check to `missionProblems` (so the tests see it),
 * then make `chooseMission` respect it, as a set-level filter in
 * `validSet`, a hard constraint in `order`, or a preference in the sorting.
 */
import type { Rng } from "../../core/rng";
import type { AnyRoomModule, Mechanic } from "../rooms/room";

export interface MissionRoom {
  module: AnyRoomModule;
  mechanic: Mechanic;
  difficulty: number;
  /** True for the first room of its mechanic in the run. */
  teaches: boolean;
}

/** The parts of the generator's config the mission reads. */
export interface MissionRules {
  rooms: number;
  maxPerMechanic: number;
  /** Least and most authored set pieces per run. */
  setPieces: readonly [number, number];
}

/** Rule 0: can this module be a puzzle room of a generated run? */
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

/** Drops modules whose prerequisites no other module of the pool teaches. */
export function withPrerequisites(
  pool: readonly AnyRoomModule[],
): AnyRoomModule[] {
  return pool.filter((m) =>
    (m.after ?? []).every((need) =>
      pool.some((o) => o !== m && o.teaches === need),
    ),
  );
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** The easiest difficulty of each mechanic in the pool. */
function easiestOf(pool: readonly AnyRoomModule[]): Map<Mechanic, number> {
  const out = new Map<Mechanic, number>();
  for (const m of pool) {
    out.set(m.teaches, Math.min(out.get(m.teaches) ?? Infinity, m.difficulty));
  }
  return out;
}

const capOf = (rules: MissionRules, offered: number): number =>
  Math.max(rules.maxPerMechanic, Math.ceil(rules.rooms / Math.max(1, offered)));

/** How many modules of the pool a run can use at most, each once. */
function usable(pool: readonly AnyRoomModule[], rules: MissionRules): number {
  const sets = pool.filter((m) => m.setPiece).length;
  return pool.length - sets + Math.min(sets, rules.setPieces[1]);
}

/** Pairs of modules sharing an idea in a list. */
function sharedIdeas(list: readonly AnyRoomModule[]): number {
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].idea;
      if (a !== undefined && a === list[j].idea && list[i] !== list[j]) n++;
    }
  }
  return n;
}

/** Every k-subset of 0..n-1, as index lists in lexicographic order. */
function* subsets(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k > n) return;
  for (;;) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * How strict an order search is: "strict" all of rules 2, 4, 5, 6;
 * "no-ramp" without 5 and 6; "loose" without 4 either; "repeat" also
 * without "first" (a pool too small to keep it and rule 1 both).
 */
type Level = "strict" | "no-ramp" | "loose" | "repeat";

/**
 * Chooses and orders `rules.rooms` puzzle rooms from `pool` (already
 * filtered by `eligible`). Throws if the pool is empty.
 */
export function chooseMission(
  poolIn: readonly AnyRoomModule[],
  rules: MissionRules,
  rng: Rng,
): MissionRoom[] {
  const pool = withPrerequisites(
    [...poolIn].sort((a, b) => (a.name < b.name ? -1 : 1)),
  );
  if (pool.length === 0) {
    throw new Error("no eligible puzzle modules to build a run from");
  }
  const { rooms } = rules;
  const easiest = easiestOf(pool);

  // Set pieces: how many and which (rule 1).
  const pieces = shuffle(
    pool.filter((m) => m.setPiece),
    rng,
  );
  const [lo, hi] = rules.setPieces;
  const count = Math.min(pieces.length, rng.int(lo, Math.max(lo, hi)));
  const drawn = pieces.slice(0, count);
  const plain = pool.filter((m) => !m.setPiece);
  let candidates = [...plain, ...drawn];
  let forced = new Set(drawn);
  if (candidates.length < rooms) {
    // Too few: every set piece may come.
    candidates = [...pool];
    forced = new Set();
  }
  const keys = new Map(pool.map((m) => [m, rng.next()]));

  const sets: AnyRoomModule[][] = [];
  if (candidates.length >= rooms) {
    // Rule 3 over the candidates: the mechanics that can be taught.
    const teachable = new Set(
      candidates
        .filter((m) => m.difficulty === easiest.get(m.teaches))
        .map((m) => m.teaches),
    );
    const want = Math.min(teachable.size, rooms);
    const cap = capOf(rules, teachable.size);
    const validSet = (list: AnyRoomModule[]): boolean => {
      for (const f of forced) if (!list.includes(f)) return false;
      const per = new Map<Mechanic, number>();
      for (const m of list) per.set(m.teaches, (per.get(m.teaches) ?? 0) + 1);
      if (per.size < want) return false;
      for (const [mech, n] of per) {
        if (n > cap) return false;
        // Its first room must be one of its easiest (rule 2).
        if (
          !list.some(
            (m) => m.teaches === mech && m.difficulty === easiest.get(mech),
          )
        )
          return false;
      }
      return list.every((m) =>
        (m.after ?? []).every((need) =>
          list.some((o) => o !== m && o.teaches === need),
        ),
      );
    };
    let listed = 0;
    for (const idx of subsets(candidates.length, rooms)) {
      if (++listed > 20000) break;
      const list = idx.map((i) => candidates[i]);
      if (validSet(list)) sets.push(list);
    }
  }
  if (sets.length === 0) {
    // Repeats (the pool is too small), or no set satisfies rules 1-3: one
    // of each candidate, then the least used again, within the cap.
    const offered = new Set(candidates.map((m) => m.teaches)).size;
    const cap = capOf(rules, offered);
    const list = [...candidates].slice(0, rooms);
    const per = new Map<AnyRoomModule, number>(list.map((m) => [m, 1]));
    while (list.length < rooms) {
      const mech = (m: AnyRoomModule) =>
        list.filter((x) => x.teaches === m.teaches).length;
      const next = [...candidates].sort(
        (a, b) =>
          Number(mech(a) >= cap) - Number(mech(b) >= cap) ||
          per.get(a)! - per.get(b)! ||
          keys.get(a)! - keys.get(b)!,
      )[0];
      per.set(next, per.get(next)! + 1);
      list.push(next);
    }
    sets.push(list);
  }
  // Fewest shared ideas first (rule 7), random among equals.
  const ranked = shuffle(
    sets.map((list) => ({ list, twins: sharedIdeas(list) })),
    rng,
  ).sort((a, b) => a.twins - b.twins);

  for (const level of ["strict", "no-ramp", "loose", "repeat"] as Level[]) {
    let tries = 0;
    for (const { list } of ranked) {
      if (++tries > 400) break;
      const found = order(list, rules, easiest, keys, level);
      if (found) return found;
    }
  }
  // Teach-first alone always has an order: easiest of each mechanic first.
  return order(ranked[0].list, rules, easiest, keys, "loose", true)!;
}

/**
 * Depth-first search for an order of `list` under the rules of `level`
 * (see the header), lowest difficulty first, then the random key.
 */
function order(
  list: readonly AnyRoomModule[],
  rules: MissionRules,
  easiest: Map<Mechanic, number>,
  keys: Map<AnyRoomModule, number>,
  level: Level,
  bare = false,
): MissionRoom[] | null {
  const n = list.length;
  const half = Math.ceil(rules.rooms / 2);
  const strict = level === "strict";
  const neighbours = level === "strict" || level === "no-ramp";
  const hasFirst =
    level !== "repeat" && list.some((m) => m.position === "first");
  const out: AnyRoomModule[] = [];
  const used = new Array<boolean>(n).fill(false);
  const taught = new Map<Mechanic, number>();
  let budget = 20000;
  const sorted = list
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        a.m.difficulty - b.m.difficulty || keys.get(a.m)! - keys.get(b.m)!,
    );
  const fits = (m: AnyRoomModule): boolean => {
    const at = out.length;
    const prev = out[at - 1];
    if (!taught.has(m.teaches) && m.difficulty !== easiest.get(m.teaches))
      return false;
    if (bare) return true;
    if (!(m.after ?? []).every((need) => taught.has(need))) return false;
    if (at === 0 && hasFirst && m.position !== "first") return false;
    if (prev === m) return false;
    if (neighbours && prev) {
      if (prev.teaches === m.teaches) return false;
      if (m.idea !== undefined && prev.idea === m.idea) return false;
    }
    if (strict) {
      if (m.position === "early" && at >= half) return false;
      if (prev && m.difficulty < prev.difficulty) return false;
    }
    return true;
  };
  const step = (): boolean => {
    if (out.length === n) return true;
    if (--budget < 0) return false;
    const tried = new Set<AnyRoomModule>();
    for (const { m, i } of sorted) {
      if (used[i] || tried.has(m) || !fits(m)) continue;
      tried.add(m);
      used[i] = true;
      out.push(m);
      const fresh = !taught.has(m.teaches);
      if (fresh) taught.set(m.teaches, out.length - 1);
      if (step()) return true;
      if (fresh) taught.delete(m.teaches);
      out.pop();
      used[i] = false;
    }
    return false;
  };
  if (!step()) return null;
  const seen = new Set<Mechanic>();
  return out.map((module) => {
    const teaches = !seen.has(module.teaches);
    seen.add(module.teaches);
    return {
      module,
      mechanic: module.teaches,
      difficulty: module.difficulty,
      teaches,
    };
  });
}

/** What is wrong with a mission, by rules 1-5 and 7 above (empty if nothing). */
export function missionProblems(
  mission: readonly MissionRoom[],
  poolIn: readonly AnyRoomModule[],
  rules: MissionRules,
): string[] {
  const pool = withPrerequisites(poolIn);
  const problems: string[] = [];
  const { rooms } = rules;
  if (mission.length !== rooms) {
    problems.push(`${mission.length} rooms, not ${rooms}`);
  }
  const modules = mission.map((r) => r.module);
  const roomy = usable(pool, rules) >= rooms;
  const easiest = easiestOf(pool);
  // Rule 1.
  const counts = new Map<AnyRoomModule, number>();
  for (const m of modules) counts.set(m, (counts.get(m) ?? 0) + 1);
  for (const [m, n] of counts) {
    if (n > 1 && roomy) problems.push(`${m.name} ${n} times`);
  }
  const pieces = modules.filter((m) => m.setPiece).length;
  const available = pool.filter((m) => m.setPiece).length;
  if (roomy && pieces > rules.setPieces[1])
    problems.push(`${pieces} set pieces`);
  if (pieces < Math.min(rules.setPieces[0], available))
    problems.push(`${pieces} set pieces, fewer than ${rules.setPieces[0]}`);
  // Rule 3.
  const offered = new Set(pool.map((m) => m.teaches));
  const used = new Map<Mechanic, number>();
  for (const r of mission)
    used.set(r.mechanic, (used.get(r.mechanic) ?? 0) + 1);
  if (used.size < Math.min(offered.size, rooms)) {
    problems.push(`${used.size} mechanics of ${offered.size} offered`);
  }
  const cap = capOf(rules, offered.size);
  for (const [m, n] of used) {
    if (n > cap) problems.push(`${m} ${n} times`);
  }
  // Rules 2, 4, 5.
  const taught = new Set<Mechanic>();
  const half = Math.ceil(rooms / 2);
  const distinct = new Set(modules).size > 1;
  mission.forEach((r, i) => {
    const m = r.module;
    if (!pool.includes(m)) problems.push(`room ${i}: not in the pool`);
    if (r.mechanic !== m.teaches || r.difficulty !== m.difficulty)
      problems.push(`room ${i}: mechanic or difficulty misreported`);
    if (!taught.has(r.mechanic)) {
      if (r.difficulty !== easiest.get(r.mechanic)) {
        problems.push(
          `room ${i}: ${r.mechanic} first appears above its easiest`,
        );
      }
      if (!r.teaches) problems.push(`room ${i}: should be marked as teaching`);
    } else if (r.teaches) problems.push(`room ${i}: marked as teaching again`);
    for (const need of m.after ?? []) {
      if (!taught.has(need))
        problems.push(`room ${i}: ${m.name} comes before ${need} is taught`);
    }
    if (
      roomy &&
      m.position === "first" &&
      i > 0 &&
      mission[0].module.position !== "first"
    )
      problems.push(`room ${i}: ${m.name} should be the first room`);
    const prev = mission[i - 1]?.module;
    if (prev === m && distinct)
      problems.push(`room ${i}: same module twice in a row`);
    if (roomy && prev) {
      if (prev.teaches === m.teaches)
        problems.push(`room ${i}: ${m.teaches} twice in a row`);
      if (m.idea !== undefined && prev.idea === m.idea)
        problems.push(`room ${i}: idea "${m.idea}" twice in a row`);
    }
    if (roomy && m.position === "early" && i >= half)
      problems.push(`room ${i}: ${m.name} should be in the first half`);
    taught.add(r.mechanic);
  });
  return problems;
}

/** True if difficulty never drops along the mission (rule 6). */
export const ramps = (mission: readonly MissionRoom[]): boolean =>
  mission.every((r, i) => i === 0 || r.difficulty >= mission[i - 1].difficulty);

/** Pairs of rooms sharing an idea in a mission (rule 7, for statistics). */
export const sharedIdeasOf = (mission: readonly MissionRoom[]): number =>
  sharedIdeas(mission.map((r) => r.module));
