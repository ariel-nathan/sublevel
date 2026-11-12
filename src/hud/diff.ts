import type { HudState } from "../core/api";

/**
 * Returns only the fields of `next` that differ from `previous`. When there
 * is no previous state, every field is returned.
 */
export function diffHud(
  previous: HudState | null,
  next: HudState,
): Partial<HudState> {
  if (previous === null) {
    return { ...next };
  }
  const changed: Partial<HudState> = {};
  if (previous.playing !== next.playing) {
    changed.playing = next.playing;
  }
  if (previous.crosshair !== next.crosshair) {
    changed.crosshair = next.crosshair;
  }
  if (previous.prompt !== next.prompt) {
    changed.prompt = next.prompt;
  }
  if (previous.message !== next.message) {
    changed.message = next.message;
  }
  return changed;
}
