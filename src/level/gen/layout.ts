/**
 * Placement: lays a mission out in the plane as a chain of pieces, start,
 * then for each room a link (a connecting corridor, and a doorway adapter
 * where the sizes differ or the room's entry is open) and the room, then a
 * link and the finish.
 *
 * Each step chooses the corridor's bend (none, left, right), length and
 * second leg, and the room's mirroring. Every candidate is planned (moved
 * from a cached canonical plan, see plans.ts) and must fit: no footprint
 * overlaps the piece it is attached to, and every other footprint stays
 * `clearance` metres away. Fitting candidates are ranked by how compact the
 * facility stays (area of its bounding box), with some seeded randomness,
 * and tried depth first, backing up on a dead end. The search is bounded by
 * `searchBudget` candidates; past it, the run is laid out again greedily as
 * a straight continuation: each corridor turns the chain back to the
 * start's heading and is as short as fits, which always fits for modules
 * whose exit does not face back the way they were entered.
 */
import type { Vec3 } from "../../math";
import { hashString, createRng, type Rng } from "../../core/rng";
import type { Box } from "../geometry";
import type { CorridorParams } from "../rooms/corridor";
import type { AnyRoomModule, Connector, DoorwayEnd, Rect } from "../rooms/room";
import type { AdapterParams } from "./modules/adapter";
import type { GeneratorConfig } from "./config";
import { PlanCache, placePlan } from "./plans";

export type PieceKind = "start" | "corridor" | "adapter" | "room" | "finish";

/** One placed piece of the chain, as planned. */
export interface Piece {
  /** Placement name (also the id prefix): "lab", "c3", "a3", "r3-...". */
  name: string;
  kind: PieceKind;
  module: AnyRoomModule;
  params: unknown;
  mirror: boolean;
  /** Seed of the module's rng. */
  seed: number;
  /** Mission index for rooms (0-based), the step for links. */
  step: number;
  /** World footprint as planned. */
  footprint: Box[];
  /** The entry doorway (null for the start) and the exit (null for the finish). */
  entry: Connector | null;
  exit: Connector | null;
}

/** A room or the finish to lay out, with its parameters. */
export interface Target {
  module: AnyRoomModule;
  params: unknown;
  name: string;
  seed: number;
}

export interface Layout {
  pieces: Piece[];
  /** True if the search gave up and the straight continuation was used. */
  fallback: boolean;
  /** Candidates evaluated by the search. */
  evaluated: number;
}

/** The start module is anchored here (as Kestrel Annex is). */
export const ROOT = {
  position: { x: 0, y: 0, z: 0 } as Vec3,
  facing: { x: 1, y: 0, z: 0 } as Vec3,
};

const EPS = 1e-4;

interface Option {
  bend: CorridorParams["bend"];
  length: number;
  leg: number;
  mirror: boolean;
}

const accepts = (
  m: AnyRoomModule,
  s: { width: number; height: number },
): boolean =>
  s.width >= m.entrySize.width[0] - 1e-9 &&
  s.width <= m.entrySize.width[1] + 1e-9 &&
  s.height >= m.entrySize.height[0] - 1e-9 &&
  s.height <= m.entrySize.height[1] + 1e-9;

const clampTo = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, v));

/** The doorway a module takes nearest to `s`. */
const fitSize = (m: AnyRoomModule, s: { width: number; height: number }) => ({
  width: clampTo(s.width, m.entrySize.width),
  height: clampTo(s.height, m.entrySize.height),
});

const overlap3 = (a: Box, b: Box, eps: number): boolean =>
  a.x0 < b.x1 - eps &&
  a.x1 > b.x0 + eps &&
  a.y0 < b.y1 - eps &&
  a.y1 > b.y0 + eps &&
  a.z0 < b.z1 - eps &&
  a.z1 > b.z0 + eps;

/** True if two boxes are closer than `gap` in plan (x, z). */
const closeXZ = (a: Box, b: Box, gap: number): boolean =>
  a.x0 < b.x1 + gap - EPS &&
  a.x1 > b.x0 - gap + EPS &&
  a.z0 < b.z1 + gap - EPS &&
  a.z1 > b.z0 - gap + EPS;

/**
 * Why a footprint cannot join the chain after `placed` (attached to the
 * last piece), or null if it fits.
 */
export function misfit(
  footprint: readonly Box[],
  placed: readonly { footprint: readonly Box[]; name: string }[],
  clearance: number,
): string | null {
  const last = placed.length - 1;
  for (let j = 0; j <= last; j++) {
    const other = placed[j];
    for (const a of footprint) {
      for (const b of other.footprint) {
        if (j === last ? overlap3(a, b, EPS) : closeXZ(a, b, clearance)) {
          return j === last
            ? `overlaps "${other.name}"`
            : `within ${clearance} m of "${other.name}"`;
        }
      }
    }
  }
  return null;
}

class Abort extends Error {}

export class LayoutSearch {
  readonly cache = new PlanCache();
  private evaluated = 0;
  private readonly corridorBase: CorridorParams[] = [];

  constructor(
    private readonly config: GeneratorConfig,
    private readonly seed: number,
    private readonly targets: readonly Target[],
  ) {
    // Corridor looks (width, height, pipes, light) per step, drawn once.
    targets.forEach((_, step) => {
      this.corridorBase.push(config.corridor.random(this.stepRng(step, "c")));
    });
  }

  private stepRng(step: number, what: string): Rng {
    return createRng(hashString(`${this.seed}/${what}${step}`));
  }

  private plan(
    module: AnyRoomModule,
    params: unknown,
    mirror: boolean,
    seed: number,
    at: Connector,
  ) {
    const canon = this.cache.canonical(
      module,
      params,
      mirror,
      { width: at.width, height: at.height },
      seed,
    );
    return placePlan(canon, at);
  }

  /** The start piece at the root. */
  start(): Piece {
    const m = this.config.start;
    const canon = this.cache.canonical(
      m,
      m.defaults,
      false,
      { width: 0, height: 0 },
      0,
    );
    const placed = placePlan(canon, ROOT);
    return {
      name: "lab",
      kind: "start",
      module: m,
      params: m.defaults,
      mirror: false,
      seed: 0,
      step: -1,
      footprint: placed.footprint,
      entry: null,
      exit: placed.exits[0].connector,
    };
  }

  /**
   * The pieces of one step (link and target) for an option, after `chain`,
   * or null if any does not fit.
   */
  stepPieces(chain: readonly Piece[], step: number, o: Option): Piece[] | null {
    this.evaluated++;
    const { config } = this;
    const target = this.targets[step];
    const out: Piece[] = [];
    let at = chain[chain.length - 1].exit!;
    const fits = (fp: Box[]) =>
      misfit(fp, [...chain, ...out], config.clearance) === null;
    const add = (
      kind: PieceKind,
      name: string,
      module: AnyRoomModule,
      params: unknown,
      mirror: boolean,
      seed: number,
    ): boolean => {
      const placed = this.plan(module, params, mirror, seed, at);
      if (!fits(placed.footprint)) return false;
      const exit = placed.exits[0]?.connector ?? null;
      out.push({
        name,
        kind,
        module,
        params,
        mirror,
        seed,
        step,
        footprint: placed.footprint,
        entry: at,
        exit,
      });
      if (exit) at = exit;
      return true;
    };
    const adapter = (
      name: string,
      size: { width: number; height: number },
      cover: Rect | null,
    ): boolean => {
      const params: AdapterParams = {
        length: 2.4,
        exitWidth: size.width,
        exitHeight: size.height,
        cover,
      };
      return add("adapter", name, config.adapter, params, false, 0);
    };
    const n = step + 1;
    const corridor = config.corridor;
    // Into the corridor: an adapter first if it cannot take the doorway.
    if (!accepts(corridor, at)) {
      const size = fitSize(corridor, fitSize(target.module, at));
      if (!adapter(`a${n}in`, size, null)) return null;
    }
    const params: CorridorParams = {
      ...this.corridorBase[step],
      bend: o.bend,
      length: o.length,
      leg: o.leg,
    };
    if (!add("corridor", `c${n}`, corridor, params, false, 0)) return null;
    // Into the target: an adapter if the size differs or its entry is open.
    const size = accepts(target.module, at)
      ? { width: at.width, height: at.height }
      : fitSize(target.module, at);
    const canon = this.cache.canonical(
      target.module,
      target.params,
      o.mirror,
      size,
      target.seed,
    );
    const end: DoorwayEnd | null = canon.entry?.end ?? null;
    const open = end !== null && !end.wall;
    if (open || size.width !== at.width || size.height !== at.height) {
      if (!adapter(`a${n}`, size, open ? end.extent : null)) return null;
    }
    const kind: PieceKind = target.module.role === "finish" ? "finish" : "room";
    if (
      !add(
        kind,
        target.name,
        target.module,
        target.params,
        o.mirror,
        target.seed,
      )
    ) {
      return null;
    }
    return out;
  }

  private options(step: number): Option[] {
    const { corridorLengths, corridorLegs } = this.config;
    const out: Option[] = [];
    for (const mirror of [false, true]) {
      for (const length of corridorLengths) {
        out.push({ bend: "none", length, leg: 0, mirror });
        for (const bend of ["left", "right"] as const) {
          for (const leg of corridorLegs)
            out.push({ bend, length, leg, mirror });
        }
      }
    }
    void step;
    return out;
  }

  /** Bounding-box area (x, z) of every footprint: the compactness score. */
  private static area(pieces: readonly Piece[]): number {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const p of pieces) {
      for (const b of p.footprint) {
        x0 = Math.min(x0, b.x0);
        z0 = Math.min(z0, b.z0);
        x1 = Math.max(x1, b.x1);
        z1 = Math.max(z1, b.z1);
      }
    }
    return (x1 - x0) * (z1 - z0);
  }

  /** Depth-first, compact-first search; null if the budget runs out. */
  search(): Layout | null {
    const chain: Piece[] = [this.start()];
    const steps = this.targets.length;
    const go = (step: number): boolean => {
      if (step === steps) return true;
      const rng = this.stepRng(step, "s");
      const ranked: { pieces: Piece[]; score: number }[] = [];
      for (const o of this.options(step)) {
        if (this.evaluated >= this.config.searchBudget) throw new Abort();
        const jitter = 1 + this.config.jitter * rng.next();
        const pieces = this.stepPieces(chain, step, o);
        if (!pieces) continue;
        ranked.push({
          pieces,
          score: LayoutSearch.area([...chain, ...pieces]) * jitter,
        });
      }
      ranked.sort((a, b) => a.score - b.score);
      for (const { pieces } of ranked.slice(0, this.config.branching)) {
        chain.push(...pieces);
        if (go(step + 1)) return true;
        chain.length -= pieces.length;
      }
      return false;
    };
    try {
      if (!go(0)) return null;
    } catch (error) {
      if (error instanceof Abort) return null;
      throw error;
    }
    return { pieces: chain, fallback: false, evaluated: this.evaluated };
  }

  /**
   * The straight continuation: each step turns the chain back to the
   * start's heading H and puts the next room wholly ahead (along H) of
   * everything placed so far, with the shortest corridor that does so.
   * Steps are tried in that order of preference with back-tracking, so a
   * room that cannot be put ahead still finds a place.
   */
  straight(): Layout {
    const chain: Piece[] = [this.start()];
    const H = ROOT.facing;
    const along = (b: Box, end: 0 | 1) =>
      end === 0
        ? Math.min(b.x0 * H.x + b.z0 * H.z, b.x1 * H.x + b.z1 * H.z)
        : Math.max(b.x0 * H.x + b.z0 * H.z, b.x1 * H.x + b.z1 * H.z);
    const front = (pieces: readonly Piece[]) =>
      Math.max(...pieces.flatMap((p) => p.footprint.map((b) => along(b, 1))));
    const budget = this.evaluated + 40000;
    const go = (step: number): boolean => {
      if (step === this.targets.length) return true;
      const f = chain[chain.length - 1].exit!.facing;
      // Right of f is (-f.z, f.x): a right bend faces it next.
      const right = { x: -f.z, z: f.x };
      const bends: CorridorParams["bend"][] =
        f.x === H.x && f.z === H.z
          ? ["none", "left", "right"]
          : right.x === H.x && right.z === H.z
            ? ["right", "none", "left"]
            : -right.x === H.x && -right.z === H.z
              ? ["left", "none", "right"]
              : ["left", "right", "none"];
      const ahead = front(chain) + this.config.clearance;
      const fitting: { pieces: Piece[]; rank: number }[] = [];
      let order = 0;
      for (const length of [3, 4.5, 6, 8, 10]) {
        for (const leg of [0, 1.5, 3, 4]) {
          for (const bend of bends) {
            if (bend === "none" && leg > 0) continue;
            for (const mirror of [false, true]) {
              if (this.evaluated >= budget) return false;
              const pieces = this.stepPieces(chain, step, {
                bend,
                length,
                leg,
                mirror,
              });
              order++;
              if (!pieces) continue;
              const target = pieces[pieces.length - 1];
              const clear =
                Math.min(...target.footprint.map((b) => along(b, 0))) >= ahead;
              const faces = target.exit
                ? target.exit.facing.x !== -H.x || target.exit.facing.z !== -H.z
                : true;
              fitting.push({
                pieces,
                rank: (clear ? 0 : 2e6) + (faces ? 0 : 1e6) + order,
              });
            }
          }
        }
      }
      fitting.sort((a, b) => a.rank - b.rank);
      for (const { pieces } of fitting.slice(0, 3)) {
        chain.push(...pieces);
        if (go(step + 1)) return true;
        chain.length -= pieces.length;
      }
      return false;
    };
    if (!go(0)) {
      throw new Error(
        `layout: no straight continuation fits (seed ${this.seed})`,
      );
    }
    return { pieces: chain, fallback: true, evaluated: this.evaluated };
  }
}

/** Lays out the targets (rooms, then the finish) after the start. */
export function layout(
  config: GeneratorConfig,
  seed: number,
  targets: readonly Target[],
): Layout {
  const search = new LayoutSearch(config, seed, targets);
  return search.search() ?? search.straight();
}
