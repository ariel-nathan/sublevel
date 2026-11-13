/**
 * The room module contract (contract.ts), checked for every module in the
 * registry, in each of the four entry facings, mirrored and not, with its
 * default parameters and a few random ones. A new module added to the
 * registry is covered automatically.
 */
import { describe, expect, test } from "bun:test";
import { contractProblems } from "./contract";
import { ROOM_MODULES } from "./registry";

describe("the room module contract", () => {
  for (const module of ROOM_MODULES) {
    test(`"${module.name}" in every facing, mirrored too, defaults and 4 random parameter sets`, () => {
      expect(contractProblems(module).slice(0, 8)).toEqual([]);
    });
  }
});
