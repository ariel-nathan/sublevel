import { expect, test } from "bun:test";
import { fingerprintLevel } from "./fingerprint";
import fixture from "./fingerprint.json";
import { buildLevel } from "./index";

// The hand-built level, assembled from room modules, must build exactly what
// the single hand-written definition built before the modules existed. To
// change the level on purpose, run `bun src/level/fingerprint.ts --write` and
// commit the new fixture together with the change.
test("the hand-built level matches its recorded fingerprint", () => {
  expect(fingerprintLevel(buildLevel())).toEqual(fixture);
});

test("the fingerprint ignores brush order but not geometry", () => {
  const level = buildLevel();
  const base = fingerprintLevel(level);
  const reversed = {
    ...level,
    data: { ...level.data, brushes: [...level.data.brushes].reverse() },
    colliders: [...level.colliders].reverse(),
  };
  expect(fingerprintLevel(reversed)).toEqual(base);
  const moved = structuredClone(level.data.brushes);
  moved[0].max.y += 0.001;
  expect(
    fingerprintLevel({ ...level, data: { ...level.data, brushes: moved } })
      .brushes,
  ).not.toBe(base.brushes);
});
