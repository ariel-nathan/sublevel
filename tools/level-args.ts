/**
 * Which level a tool should look at. `--seed N` plays a generated run,
 * `--rooms a,b` builds named room modules (both go to the page's query
 * string, and are given to `buildLevel` when a tool builds the level itself);
 * with neither the hand-built level is used.
 */
import type { LevelOptions } from "../src/core/api";
import type { ParsedArgs } from "./cli";

export interface LevelSelector {
  seed?: number;
  rooms?: string[];
}

export function levelSelector(args: ParsedArgs): LevelSelector {
  const sel: LevelSelector = {};
  const seed = args.options.get("seed");
  if (seed !== undefined) {
    const n = Number(seed);
    if (!Number.isFinite(n))
      throw new Error(`--seed must be a number, got "${seed}"`);
    sel.seed = Math.floor(n);
  }
  const rooms = args.options.get("rooms");
  if (rooms !== undefined) {
    sel.rooms = rooms.split(",").filter(Boolean);
    if (sel.rooms.length === 0)
      throw new Error("--rooms needs at least one module name");
  }
  return sel;
}

/** Query string (without "?") for the page: always `harness`. */
export function levelQuery(sel: LevelSelector): string {
  const parts = ["harness"];
  if (sel.seed !== undefined) parts.push(`seed=${sel.seed}`);
  if (sel.rooms) parts.push(`rooms=${sel.rooms.join(",")}`);
  return parts.join("&");
}

export function levelOptions(sel: LevelSelector): LevelOptions {
  return { seed: sel.seed, rooms: sel.rooms };
}

/** True if the user picked a particular level (so the fixed views do not apply). */
export function isSelected(sel: LevelSelector): boolean {
  return sel.seed !== undefined || sel.rooms !== undefined;
}

/** Short name for output folders and tables: "seed-7", "rooms-a-b" or "annex". */
export function levelTag(sel: LevelSelector): string {
  if (sel.rooms)
    return `rooms-${sel.rooms.join("-")}${sel.seed !== undefined ? `-s${sel.seed}` : ""}`;
  if (sel.seed !== undefined) return `seed-${sel.seed}`;
  return "annex";
}

/** `A..B` (inclusive) or a single number, as a list. */
export function parseRange(text: string): number[] {
  const m = /^(-?\d+)\.\.(-?\d+)$/.exec(text);
  if (!m) {
    const n = Number(text);
    if (!Number.isInteger(n))
      throw new Error(`expected N or A..B, got "${text}"`);
    return [n];
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (b < a || b - a > 10000) throw new Error(`bad range "${text}"`);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/**
 * The seeds a tool should run: `--seeds A..B`, or `--count K [--from A]`,
 * or the single `--seed N`, or none (the default level).
 */
export function seedList(args: ParsedArgs): number[] | null {
  const range = args.options.get("seeds");
  if (range !== undefined) return parseRange(range);
  const count = args.options.get("count");
  if (count !== undefined) {
    const from = Number(args.options.get("from") ?? 1);
    const k = Number(count);
    if (!Number.isInteger(k) || k < 1 || !Number.isInteger(from)) {
      throw new Error("--count needs a positive integer and --from an integer");
    }
    return Array.from({ length: k }, (_, i) => from + i);
  }
  return null;
}
