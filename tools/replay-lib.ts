/** Pure helpers for tools/replay.ts: slicing replays and planning captures. */
import {
  ReplayRecorder,
  decodeReplay,
  replaySteps,
  type Replay,
} from "../src/harness/replay";

/** The part of a replay covering steps [from, to) (0-based). */
export function sliceReplay(replay: Replay, from: number, to: number): Replay {
  const inputs = decodeReplay(replay);
  const recorder = new ReplayRecorder();
  for (const input of inputs.slice(Math.max(0, from), Math.max(from, to))) {
    recorder.push(input);
  }
  return recorder.toReplay(replay.seed);
}

/** Throws if the value is not a version 1 replay. */
export function validateReplay(value: unknown): Replay {
  const replay = value as Partial<Replay> | null;
  if (
    !replay ||
    replay.version !== 1 ||
    !Array.isArray(replay.runs) ||
    typeof replay.seed !== "number"
  ) {
    throw new Error(
      "not a sublevel replay (expected {version: 1, seed, runs})",
    );
  }
  for (const run of replay.runs) {
    if (!Array.isArray(run) || run.length !== 6 || !(run[0] >= 1)) {
      throw new Error("malformed replay run");
    }
  }
  return replay as Replay;
}

export interface CapturePlan {
  /** Step counts (steps simulated so far) at which to save a frame. */
  frames: number[];
  /** Step counts at which to sample position (superset of `frames`). */
  samples: number[];
}

/**
 * Which step counts to stop at. `total` is the replay length. Frames are
 * taken every `every` steps in [from, to], plus the last step; with `at`
 * set, every step in [at - window, at + window] instead. Position samples
 * are taken every `sampleEvery` steps and at every frame.
 */
export function planCaptures(options: {
  total: number;
  every: number;
  from?: number;
  to?: number;
  at?: number;
  window?: number;
  sampleEvery?: number;
}): CapturePlan {
  const total = options.total;
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(total, options.to ?? total);
  const frames = new Set<number>();
  if (options.at !== undefined) {
    const window = options.window ?? 20;
    for (
      let s = Math.max(1, options.at - window);
      s <= Math.min(total, options.at + window);
      s++
    ) {
      frames.add(s);
    }
  } else {
    const every = Math.max(1, Math.floor(options.every));
    const first = Math.ceil(Math.max(from, 1) / every) * every;
    for (let s = first; s <= to; s += every) {
      frames.add(s);
    }
    if (to >= 1) {
      frames.add(to);
    }
  }
  const samples = new Set(frames);
  const sampleEvery = Math.max(1, options.sampleEvery ?? 30);
  for (let s = sampleEvery; s <= to; s += sampleEvery) {
    samples.add(s);
  }
  samples.add(to);
  const sorted = (set: Set<number>): number[] =>
    [...set].filter((s) => s >= 1 && s <= total).sort((a, b) => a - b);
  return { frames: sorted(frames), samples: sorted(samples) };
}

export { replaySteps };
