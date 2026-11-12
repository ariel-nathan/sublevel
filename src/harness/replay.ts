import type { PlayerInput } from "../core/api";

/**
 * A recording of every player input since the game started. Because the
 * simulation is fixed-step and seeded, replaying it from a fresh start
 * reproduces the session exactly.
 */
export interface Replay {
  version: 1;
  seed: number;
  /** Run-length encoded: [count, moveX, moveZ, lookDx, lookDy, flags]. */
  runs: number[][];
}

const JUMP = 1;
const CROUCH = 2;
const USE = 4;
const PRIMARY = 8;

function flagsOf(input: PlayerInput): number {
  return (
    (input.jump ? JUMP : 0) |
    (input.crouch ? CROUCH : 0) |
    (input.usePressed ? USE : 0) |
    (input.primaryPressed ? PRIMARY : 0)
  );
}

/** Collects inputs step by step and encodes them compactly. */
export class ReplayRecorder {
  private runs: number[][] = [];
  private total = 0;

  get steps(): number {
    return this.total;
  }

  push(input: PlayerInput): void {
    this.total++;
    const flags = flagsOf(input);
    const last = this.runs[this.runs.length - 1];
    if (
      last &&
      last[1] === input.moveX &&
      last[2] === input.moveZ &&
      last[3] === input.lookDx &&
      last[4] === input.lookDy &&
      last[5] === flags
    ) {
      last[0]++;
      return;
    }
    this.runs.push([
      1,
      input.moveX,
      input.moveZ,
      input.lookDx,
      input.lookDy,
      flags,
    ]);
  }

  toReplay(seed: number): Replay {
    return { version: 1, seed, runs: this.runs.map((run) => [...run]) };
  }
}

/** Expands a replay back into one input per step. */
export function decodeReplay(replay: Replay): PlayerInput[] {
  const inputs: PlayerInput[] = [];
  for (const [count, moveX, moveZ, lookDx, lookDy, flags] of replay.runs) {
    for (let i = 0; i < count; i++) {
      inputs.push({
        moveX,
        moveZ,
        lookDx,
        lookDy,
        jump: (flags & JUMP) !== 0,
        crouch: (flags & CROUCH) !== 0,
        usePressed: (flags & USE) !== 0,
        primaryPressed: (flags & PRIMARY) !== 0,
      });
    }
  }
  return inputs;
}

export function replaySteps(replay: Replay): number {
  return replay.runs.reduce((sum, run) => sum + run[0], 0);
}
