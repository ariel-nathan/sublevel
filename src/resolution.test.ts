import { expect, test } from "bun:test";
import { internalResolution } from "./resolution";

test("keeps aspect ratio at the target height", () => {
  expect(internalResolution(1920, 1080, 240)).toEqual({
    width: 427,
    height: 240,
  });
});

test("never returns a zero width", () => {
  expect(internalResolution(0, 0, 240).width).toBeGreaterThanOrEqual(1);
});
