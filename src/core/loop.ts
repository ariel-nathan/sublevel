/** Fixed simulation rate. Physics and gameplay always step by this amount. */
export const FIXED_DT = 1 / 60;

export interface StepResult {
  /** How many fixed steps to run this frame. */
  steps: number;
  /** Fraction of a step left over, 0..1, for interpolating rendering. */
  alpha: number;
}

/**
 * Converts variable frame times into whole fixed steps. Long frames are
 * clamped to `maxSteps` so a stall never causes a burst of catch-up work.
 */
export function createStepper(
  fixedDt: number = FIXED_DT,
  maxSteps = 5,
): (frameSeconds: number) => StepResult {
  let accumulator = 0;
  return (frameSeconds) => {
    accumulator += Math.max(0, frameSeconds);
    let steps = Math.floor(accumulator / fixedDt + 1e-9);
    if (steps > maxSteps) {
      steps = maxSteps;
      accumulator = 0;
    } else {
      accumulator = Math.max(0, accumulator - steps * fixedDt);
    }
    return { steps, alpha: accumulator / fixedDt };
  };
}

export interface LoopHandlers {
  /** Called zero or more times per frame with the fixed timestep. */
  update(dt: number): void;
  /** Called once per frame. `frameSeconds` is real time since the last frame. */
  render(alpha: number, frameSeconds: number): void;
}

/** Starts the browser frame loop. Returns a function that stops it. */
export function runLoop(handlers: LoopHandlers): () => void {
  const step = createStepper();
  let last = performance.now();
  let running = true;
  const frame = (now: number): void => {
    if (!running) {
      return;
    }
    const frameSeconds = (now - last) / 1000;
    last = now;
    const { steps, alpha } = step(frameSeconds);
    for (let i = 0; i < steps; i++) {
      handlers.update(FIXED_DT);
    }
    handlers.render(alpha, frameSeconds);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return () => {
    running = false;
  };
}
