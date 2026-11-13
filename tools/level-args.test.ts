import { describe, expect, test } from "bun:test";
import { parseArgs } from "./cli";
import {
  levelQuery,
  levelSelector,
  levelTag,
  parseRange,
  seedList,
} from "./level-args";

const parse = (...a: string[]) => parseArgs(a, ["auto"]);

describe("level selection", () => {
  test("query string carries seed and rooms", () => {
    expect(levelQuery(levelSelector(parse()))).toBe("harness");
    expect(levelQuery(levelSelector(parse("--seed", "7")))).toBe(
      "harness&seed=7",
    );
    expect(levelQuery(levelSelector(parse("--rooms", "a,b")))).toBe(
      "harness&rooms=a,b",
    );
    expect(
      levelQuery(levelSelector(parse("--rooms", "a,b", "--seed", "3"))),
    ).toBe("harness&seed=3&rooms=a,b");
  });

  test("tags", () => {
    expect(levelTag(levelSelector(parse()))).toBe("annex");
    expect(levelTag(levelSelector(parse("--seed", "12")))).toBe("seed-12");
    expect(levelTag(levelSelector(parse("--rooms", "x,y")))).toBe("rooms-x-y");
  });

  test("ranges and seed lists", () => {
    expect(parseRange("3..6")).toEqual([3, 4, 5, 6]);
    expect(parseRange("9")).toEqual([9]);
    expect(() => parseRange("6..3")).toThrow();
    expect(seedList(parse("--seeds", "1..3"))).toEqual([1, 2, 3]);
    expect(seedList(parse("--count", "2", "--from", "10"))).toEqual([10, 11]);
    expect(seedList(parse("--count", "2"))).toEqual([1, 2]);
    expect(seedList(parse())).toBeNull();
  });

  test("bad numbers are errors", () => {
    expect(() => levelSelector(parse("--seed", "x"))).toThrow();
    expect(() => seedList(parse("--count", "0"))).toThrow();
  });
});
