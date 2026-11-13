/**
 * The room module contract (src/level/rooms/contract.ts) for the
 * generator's own modules, which are not in the shared registry.
 */
import { describe, expect, test } from "bun:test";
import { contractProblems } from "../../rooms/contract";
import { GEN_MODULES } from "./index";

describe("the room module contract, generator modules", () => {
  for (const module of GEN_MODULES) {
    test(`"${module.name}" in every facing, mirrored too, defaults and 8 random parameter sets`, () => {
      expect(contractProblems(module, { randomSets: 8 }).slice(0, 8)).toEqual(
        [],
      );
    });
  }
});
