import { describe, expect, test } from "bun:test";
import type { HudState } from "../core/api";
import { diffHud } from "./diff";

const BASE: HudState = {
  playing: true,
  crosshair: "idle",
  prompt: null,
  message: null,
};

describe("diffHud", () => {
  test("first call returns every field", () => {
    expect(diffHud(null, BASE)).toEqual({ ...BASE });
  });

  test("identical state returns an empty object", () => {
    expect(diffHud(BASE, { ...BASE })).toEqual({});
  });

  test("playing change returns only playing", () => {
    expect(diffHud(BASE, { ...BASE, playing: false })).toEqual({
      playing: false,
    });
  });

  test("crosshair change returns only crosshair", () => {
    expect(diffHud(BASE, { ...BASE, crosshair: "interact" })).toEqual({
      crosshair: "interact",
    });
  });

  test("prompt change returns only prompt", () => {
    expect(diffHud(BASE, { ...BASE, prompt: "E  Pick up" })).toEqual({
      prompt: "E  Pick up",
    });
  });

  test("prompt cleared to null is reported", () => {
    const shown = { ...BASE, prompt: "E  Pick up" };
    expect(diffHud(shown, BASE)).toEqual({ prompt: null });
  });

  test("message change returns only message", () => {
    expect(diffHud(BASE, { ...BASE, message: "Exit unlocked" })).toEqual({
      message: "Exit unlocked",
    });
  });

  test("several changes are all returned, unchanged fields omitted", () => {
    const next: HudState = {
      ...BASE,
      crosshair: "holding",
      message: "Hi",
    };
    expect(diffHud(BASE, next)).toEqual({
      crosshair: "holding",
      message: "Hi",
    });
  });
});
