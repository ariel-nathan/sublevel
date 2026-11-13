/**
 * The player's hands and eyes: deterministic, high-level actions on top of a
 * `GameSession`, built only from `__harness.step(...)` with scripted input.
 * Every action appends a line to `transcript` so a text-only reader can follow
 * what happened.
 *
 *   const session = await launchGame();
 *   const pilot = new Pilot(session, { run: "mytest" });
 *   await pilot.walkTo(3.5, 1.2);
 *   await pilot.pressButtonAt(3.91, 1.2, 1.2);
 *   await pilot.frame("after-button");
 *   console.log(pilot.transcript.join("\n"));
 */
import { join } from "node:path";
import { PLAYER, PROP_SPECS } from "../src/core/props";
import type { GameSession } from "./browser";
import {
  LOOK_SENSITIVITY,
  RUN_STEP,
  batchSteps,
  clamp,
  forwardInput,
  horizontalDistance,
  lookDelta,
  lookError,
  lookToward,
  routeBetween,
  standPoint,
  throwPitch,
  type Look,
  type Point2,
  type Point3,
} from "./pilot-math";

// Carry geometry from src/player/tuning.ts (kept local: tools do not import
// tuning because it is player-module internals).
const HOLD_DISTANCE = 1.15;
const HOLD_CLEARANCE = 0.55;
const HOLD_LOWER = 0.15;
const STAND_EYE_HEIGHT = 1.65;
// Throwing, also from src/player/tuning.ts.
const THROW_SPEED_LIGHT = 11;
const THROW_SPEED_HEAVY = 5;
const THROW_LIGHT_MASS = 8;
const THROW_UP = 1.0;

/** Throw speed for a prop of this mass (src/player/tuning.ts throwSpeed). */
function throwSpeed(mass: number): number {
  const t =
    (mass - THROW_LIGHT_MASS) / (PLAYER.maxCarryMass - THROW_LIGHT_MASS);
  const k = clamp(t, 0, 1);
  return THROW_SPEED_LIGHT + (THROW_SPEED_HEAVY - THROW_SPEED_LIGHT) * k;
}

export interface BodyInfo {
  id: number;
  tag: string;
  position: Point3;
  asleep: boolean;
}

export interface PilotState {
  step: number;
  /** True once the player has reached the exit. */
  finished: boolean;
  player: {
    feet: Point3;
    velocity: Point3;
    yawDeg: number;
    pitchDeg: number;
    onGround: boolean;
    crouched: boolean;
    heldBody: number | null;
    aim: { kind: string; id: number; distance: number } | null;
  };
  hud: { crosshair: string; prompt: string | null; message: string | null };
  bodies: BodyInfo[];
}

export interface PilotEvent {
  step: number;
  type: string;
  [key: string]: unknown;
}

export interface PilotOptions {
  /** Output folder name under `outDir`. */
  run?: string;
  /** Default "out". */
  outDir?: string;
  /** Print each transcript line as it happens. */
  verbose?: boolean;
}

export interface WalkOptions {
  /** Horizontal distance at which to stop. Default 0.3. */
  tolerance?: number;
  /** Give up after this many steps. Default 600. */
  timeoutSteps?: number;
  /** Hold jump while walking. */
  jump?: boolean;
  /** Hold crouch while walking. */
  crouch?: boolean;
  /** Skip the automatic detour through the level's corridor spine. */
  direct?: boolean;
}

export interface WalkResult {
  arrived: boolean;
  x: number;
  z: number;
  distance: number;
  steps: number;
}

const f = (n: number, digits = 2): string => n.toFixed(digits);
const fmt = (p: Point3): string => `(${f(p.x)}, ${f(p.y)}, ${f(p.z)})`;

export class Pilot {
  readonly transcript: string[] = [];
  readonly run: string;
  readonly outDir: string;
  private consumed = 0;
  private readonly verbose: boolean;

  constructor(
    readonly session: GameSession,
    options: PilotOptions = {},
  ) {
    this.run = options.run ?? "run";
    this.outDir = join(options.outDir ?? "out", this.run);
    this.verbose = options.verbose ?? false;
  }

  // --- Reading ---------------------------------------------------------------

  state(): Promise<PilotState> {
    return this.session.evaluate<PilotState>("__harness.state()");
  }

  /** Events since the given step (exclusive); all of them if omitted. */
  events(sinceStep?: number): Promise<PilotEvent[]> {
    return this.session.evaluate<PilotEvent[]>(
      `__harness.events(${sinceStep ?? -1})`,
    );
  }

  /** The camera position, including view bob. */
  eye(): Promise<Point3> {
    return this.session.evaluate<Point3>("__game.player.camera(1).position");
  }

  async bodies(tag?: string): Promise<BodyInfo[]> {
    const { bodies } = await this.state();
    return tag ? bodies.filter((body) => body.tag === tag) : bodies;
  }

  // --- Transcript ------------------------------------------------------------

  /** Records one line: action, player position afterwards, new events. */
  private async note(action: string, extra = ""): Promise<void> {
    const state = await this.state();
    const all = await this.events();
    if (all.length < this.consumed) {
      this.consumed = 0;
    }
    const fresh = all.slice(this.consumed);
    this.consumed = all.length;
    const footsteps = fresh.filter((e) => e.type === "footstep").length;
    const interesting = fresh
      .filter((e) => e.type !== "footstep")
      .map((e) => `${e.type}@${e.step}`);
    const parts = [
      `[${String(state.step).padStart(5, "0")}]`,
      action,
      `-> ${fmt(state.player.feet)}`,
      `yaw ${f(state.player.yawDeg, 1)} pitch ${f(state.player.pitchDeg, 1)}`,
    ];
    if (state.player.heldBody !== null) {
      parts.push(`holding #${state.player.heldBody}`);
    }
    if (extra) {
      parts.push(extra);
    }
    if (interesting.length > 0) {
      parts.push(`events: ${interesting.join(" ")}`);
    }
    if (footsteps > 0) {
      parts.push(`(${footsteps} footsteps)`);
    }
    const line = parts.join(" | ");
    this.transcript.push(line);
    if (this.verbose) {
      console.log(line);
    }
  }

  /** Adds a free-form line to the transcript. */
  log(text: string): void {
    this.transcript.push(`        # ${text}`);
    if (this.verbose) {
      console.log(`        # ${text}`);
    }
  }

  // --- Stepping --------------------------------------------------------------

  private raw(count: number, input: object = {}): Promise<void> {
    return this.session.evaluate(
      `__harness.step(${count}, ${JSON.stringify(input)})`,
    );
  }

  /** Runs idle steps. */
  async wait(steps: number): Promise<void> {
    await this.raw(steps);
    await this.note(`wait(${steps})`);
  }

  /**
   * Runs idle steps, `every` at a time, until an event matching `match`
   * happens (from now on), for at most `max` steps. Returns the event, or
   * null if it did not happen.
   */
  async waitForEvent(
    what: string,
    match: (e: PilotEvent) => boolean,
    max = 600,
    every = 5,
  ): Promise<PilotEvent | null> {
    const since = (await this.state()).step;
    let found: PilotEvent | null = null;
    for (let n = 0; n <= max && !found; n += every) {
      found = (await this.events(since)).find(match) ?? null;
      if (!found) {
        await this.raw(every);
      }
    }
    await this.note(
      `waitForEvent(${what})`,
      found ? `${found.type}@${found.step}` : "TIMED OUT",
    );
    return found;
  }

  // --- Looking ---------------------------------------------------------------

  /**
   * Turns the view to an absolute yaw and pitch (degrees). Iterates until
   * within 0.2 degrees. Costs a few simulation steps.
   */
  async look(yawDeg: number, pitchDeg: number, quiet = false): Promise<Look> {
    const target = { yawDeg, pitchDeg };
    let current = await this.currentLook();
    for (let i = 0; i < 6 && lookError(current, target) > 0.05; i++) {
      const { dx, dy } = lookDelta(current, target);
      await this.raw(1, { lookDx: dx, lookDy: dy });
      current = await this.currentLook();
    }
    if (!quiet) {
      await this.note(
        `look(${f(yawDeg, 1)}, ${f(pitchDeg, 1)})`,
        lookError(current, target) > 0.2
          ? `WARNING off by ${f(lookError(current, target), 2)} deg`
          : "",
      );
    }
    return current;
  }

  /** Turns the view toward a world point. */
  async lookAt(x: number, y: number, z: number, quiet = false): Promise<Look> {
    const target = lookToward(await this.eye(), { x, y, z });
    const reached = await this.look(target.yawDeg, target.pitchDeg, true);
    if (!quiet) {
      await this.note(`lookAt(${f(x)}, ${f(y)}, ${f(z)})`);
    }
    return reached;
  }

  private async currentLook(): Promise<Look> {
    const { player } = await this.state();
    return { yawDeg: player.yawDeg, pitchDeg: player.pitchDeg };
  }

  // --- Moving ----------------------------------------------------------------

  /**
   * Faces the target and holds forward until within `tolerance`, re-aiming
   * every few steps. Between rooms it follows the corridor spine through
   * door A. Returns whether it arrived and where it ended.
   */
  async walkTo(
    x: number,
    z: number,
    options: WalkOptions = {},
  ): Promise<WalkResult> {
    const start = (await this.state()).player.feet;
    const stepsBefore = (await this.state()).step;
    const via = options.direct ? [] : routeBetween(start, { x, z });
    let result: WalkResult = {
      arrived: true,
      x: start.x,
      z: start.z,
      distance: 0,
      steps: 0,
    };
    for (const [i, point] of [...via, { x, z }].entries()) {
      const last = i === via.length;
      result = await this.walkLeg(point.x, point.z, {
        ...options,
        tolerance: last ? (options.tolerance ?? 0.3) : 0.5,
      });
      if (!result.arrived) {
        break;
      }
    }
    const used = (await this.state()).step - stepsBefore;
    await this.note(
      `walkTo(${f(x)}, ${f(z)})`,
      `${result.arrived ? "arrived" : "DID NOT ARRIVE"} dist ${f(result.distance)} in ${used} steps`,
    );
    return { ...result, steps: used };
  }

  private async walkLeg(
    x: number,
    z: number,
    options: WalkOptions,
  ): Promise<WalkResult> {
    const tolerance = options.tolerance ?? 0.3;
    const timeout = options.timeoutSteps ?? 600;
    const startStep = (await this.state()).step;
    let stalled = 0;
    let bestDistance = Infinity;
    for (;;) {
      const state = await this.state();
      const feet = state.player.feet;
      const distance = horizontalDistance(feet, { x, z });
      const used = state.step - startStep;
      if (distance <= tolerance) {
        await this.raw(8); // let the run-out velocity die
        return this.legResult(x, z, tolerance, used);
      }
      if (used >= timeout || stalled >= 5) {
        return this.legResult(x, z, tolerance, used);
      }
      if (distance < bestDistance - 0.02) {
        bestDistance = distance;
        stalled = 0;
      } else {
        stalled++;
      }
      const eye = await this.eye();
      const wanted = lookToward(eye, { x, y: eye.y, z });
      const here = {
        yawDeg: state.player.yawDeg,
        pitchDeg: state.player.pitchDeg,
      };
      const turn = lookDelta(here, {
        yawDeg: wanted.yawDeg,
        pitchDeg: here.pitchDeg,
      });
      const yawOff = Math.abs((turn.dx * LOOK_SENSITIVITY * 180) / Math.PI);
      if (yawOff > 3) {
        await this.raw(1, { lookDx: turn.dx });
        continue;
      }
      await this.raw(batchSteps(distance, tolerance), {
        moveZ: forwardInput(distance),
        lookDx: turn.dx,
        jump: options.jump === true,
        crouch: options.crouch === true,
      });
    }
  }

  private async legResult(
    x: number,
    z: number,
    tolerance: number,
    steps: number,
  ): Promise<WalkResult> {
    const feet = (await this.state()).player.feet;
    const distance = horizontalDistance(feet, { x, z });
    return {
      arrived: distance <= tolerance + RUN_STEP,
      x: feet.x,
      z: feet.z,
      distance,
      steps,
    };
  }

  /** Presses the jump key for one step, then waits to land (up to 120 steps). */
  async jump(settle = true): Promise<void> {
    await this.raw(1, { jump: true });
    if (settle) {
      for (let i = 0; i < 24; i++) {
        await this.raw(5);
        if ((await this.state()).player.onGround) {
          break;
        }
      }
    }
    await this.note("jump()");
  }

  /** Holds crouch for `steps` steps (then stays crouched if you keep calling). */
  async crouch(steps: number): Promise<void> {
    await this.raw(steps, { crouch: true });
    await this.note(`crouch(${steps})`);
  }

  // --- Interacting -----------------------------------------------------------

  /** Presses the use key for one step. */
  async use(): Promise<void> {
    await this.raw(1, { usePressed: true });
    await this.raw(2);
    await this.note("use()");
  }

  /** Presses the primary key (throw / shove) for one step. */
  async primary(): Promise<void> {
    await this.raw(1, { primaryPressed: true });
    await this.note("primary()");
  }

  /**
   * Walks within reach of the body, looks at its centre and presses use.
   * Returns true if the body is now held.
   */
  async pickUp(bodyId: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.state();
      const body = state.bodies.find((b) => b.id === bodyId);
      if (!body) {
        this.log(`pickUp(#${bodyId}): no such body`);
        return false;
      }
      const feet = state.player.feet;
      if (horizontalDistance(feet, body.position) > 1.7) {
        const spot = standPoint(body.position, feet, 1.3);
        await this.walkTo(spot.x, spot.z, { tolerance: 0.25 });
      }
      await this.lookAt(
        body.position.x,
        body.position.y,
        body.position.z,
        true,
      );
      await this.raw(1, { usePressed: true });
      await this.raw(3);
      const held = (await this.state()).player.heldBody;
      if (held === bodyId) {
        await this.note(`pickUp(#${bodyId} ${body.tag})`, "held");
        return true;
      }
    }
    await this.note(`pickUp(#${bodyId})`, "FAILED to pick up");
    return false;
  }

  /**
   * Carries the held body over a point and lets go so that it comes to rest
   * with its centre at height `y` above (x, z). The carried body hovers
   * about 1.2 m ahead of the eye (see src/player/tuning.ts), so the pilot
   * stands that far from the point, tilts the view so the body hangs a
   * quarter metre above its resting height, waits for it to settle, then
   * presses use. `from` says which side to stand on (a point in that
   * direction; default: where the pilot is now), which matters when the pilot
   * must not stand on a plate or push other props. Returns true if dropped.
   */
  async dropAt(
    x: number,
    y: number,
    z: number,
    from?: Point2,
  ): Promise<boolean> {
    const start = await this.state();
    const held = start.player.heldBody;
    if (held === null) {
      this.log("dropAt: nothing held");
      return false;
    }
    const tag = start.bodies.find((b) => b.id === held)?.tag ?? "";
    const spec = PROP_SPECS[tag as keyof typeof PROP_SPECS];
    const radius = spec
      ? Math.hypot(spec.halfExtents.x, spec.halfExtents.y, spec.halfExtents.z)
      : 0.5;
    const distance = Math.max(HOLD_DISTANCE, radius + HOLD_CLEARANCE);
    const eyeY = STAND_EYE_HEIGHT;
    const sinPitch = (y + 0.25 + HOLD_LOWER - eyeY) / distance;
    const pitchDeg = clamp(
      (Math.asin(clamp(sinPitch, -1, 1)) * 180) / Math.PI,
      -60,
      20,
    );
    const flat = distance * Math.cos((pitchDeg * Math.PI) / 180);
    const side = from ?? start.player.feet;
    const spot = standPoint({ x, z }, side, flat);
    // Carry height follows the view pitch: set it before walking so the body
    // does not sweep through other props on the way.
    await this.look(start.player.yawDeg, pitchDeg, true);
    await this.walkTo(spot.x, spot.z, { tolerance: 0.15 });
    const eye = await this.eye();
    const yaw = lookToward(eye, { x, y: eye.y, z }).yawDeg;
    await this.look(yaw, pitchDeg, true);
    await this.raw(20); // let the carried body settle into its hold point
    const body = (await this.bodies()).find((b) => b.id === held);
    await this.raw(1, { usePressed: true });
    await this.raw(30); // let it fall and rest
    const after = (await this.state()).player.heldBody;
    await this.note(
      `dropAt(${f(x)}, ${f(y)}, ${f(z)})`,
      `released at ${body ? fmt(body.position) : "?"}${after === null ? "" : " STILL HELD"}`,
    );
    return after === null;
  }

  /**
   * Walks within reach of a wall button, looks at it, presses use and checks
   * for a `button_press` event. `from` says which side of the wall to stand
   * on (default: wherever the pilot is now).
   */
  async pressButtonAt(
    x: number,
    y: number,
    z: number,
    from?: Point2,
  ): Promise<boolean> {
    const start = (await this.state()).player.feet;
    const side = from ?? start;
    const spot = standPoint({ x, z }, side, 1.2);
    await this.walkTo(spot.x, spot.z, { tolerance: 0.3 });
    await this.lookAt(x, y, z, true);
    const before = (await this.state()).step;
    await this.raw(1, { usePressed: true });
    await this.raw(3);
    const events = await this.events(before - 1);
    const pressed = events.some((e) => e.type === "button_press");
    await this.note(
      `pressButtonAt(${f(x)}, ${f(y)}, ${f(z)})`,
      pressed ? "pressed" : "NO button_press event",
    );
    return pressed;
  }

  /**
   * Turns the view so that the held body's hold point is at (x, y, z) as
   * nearly as the hold distance allows: faces (x, z) and tilts so the body
   * hangs at height `y`. Waits `settle` steps for the body to get there.
   */
  async holdOver(x: number, y: number, z: number, settle = 15): Promise<void> {
    const state = await this.state();
    const held = state.player.heldBody;
    if (held === null) {
      this.log("holdOver: nothing held");
      return;
    }
    const distance = this.holdDistance(state, held);
    const eye = await this.eye();
    const sinPitch = (y + HOLD_LOWER - eye.y) / distance;
    const pitchDeg = (Math.asin(clamp(sinPitch, -1, 1)) * 180) / Math.PI;
    const yaw = lookToward(eye, { x, y: eye.y, z }).yawDeg;
    await this.look(yaw, pitchDeg, true);
    await this.raw(settle);
    const body = (await this.bodies()).find((b) => b.id === held);
    await this.note(
      `holdOver(${f(x)}, ${f(y)}, ${f(z)})`,
      `body at ${body ? fmt(body.position) : "?"}`,
    );
  }

  /** Lets go of the held body (use key) and waits for it to land. */
  async release(wait = 30): Promise<boolean> {
    const held = (await this.state()).player.heldBody;
    await this.raw(1, { usePressed: true });
    await this.raw(wait);
    const body = (await this.bodies()).find((b) => b.id === held);
    const after = (await this.state()).player.heldBody;
    await this.note(
      "release()",
      `body at ${body ? fmt(body.position) : "?"}${after === null ? "" : " STILL HELD"}`,
    );
    return after === null;
  }

  /**
   * Throws the held body so that its arc passes through (x, y, z): faces
   * the point, then solves the pitch for a ballistic arc from where the
   * body actually hangs (throw speed and lift from src/player/tuning.ts),
   * re-aiming a few times as the hold point moves with the pitch.
   */
  async throwAt(x: number, y: number, z: number): Promise<boolean> {
    const state = await this.state();
    const held = state.player.heldBody;
    if (held === null) {
      this.log("throwAt: nothing held");
      return false;
    }
    const tag = state.bodies.find((b) => b.id === held)?.tag ?? "";
    const spec = PROP_SPECS[tag as keyof typeof PROP_SPECS];
    const speed = throwSpeed(spec ? spec.mass : PLAYER.maxCarryMass);
    let pitch = 20;
    for (let i = 0; i < 4; i++) {
      const eye = await this.eye();
      const yaw = lookToward(eye, { x, y: eye.y, z }).yawDeg;
      const body = (await this.bodies()).find((b) => b.id === held);
      if (!body) {
        break;
      }
      const solved = throwPitch(
        horizontalDistance(body.position, { x, z }),
        y - body.position.y,
        speed,
        THROW_UP,
      );
      if (solved === null) {
        this.log(`throwAt: (${f(x)}, ${f(y)}, ${f(z)}) is out of range`);
        return false;
      }
      pitch = solved;
      await this.look(yaw, pitch, true);
      await this.raw(12);
    }
    await this.raw(1, { primaryPressed: true });
    await this.note(
      `throwAt(${f(x)}, ${f(y)}, ${f(z)})`,
      `pitch ${f(pitch, 1)} speed ${f(speed, 1)}`,
    );
    return true;
  }

  // --- Generic actions for the solver (tools/solve.ts) ----------------------

  /**
   * Looks at a button within reach from where the pilot stands, presses use
   * and checks for a `button_press` event. Does not walk.
   */
  async pressHere(x: number, y: number, z: number): Promise<boolean> {
    await this.lookAt(x, y, z, true);
    const before = (await this.state()).step;
    await this.raw(1, { usePressed: true });
    await this.raw(3);
    const pressed = (await this.events(before - 1)).some(
      (e) => e.type === "button_press",
    );
    await this.note(
      `pressHere(${f(x)}, ${f(y)}, ${f(z)})`,
      pressed ? "pressed" : "NO button_press event",
    );
    return pressed;
  }

  /**
   * Sets the held body down so that it comes to rest at (x, y, z): tilts the
   * view so the body hangs at `holdY` before walking (so it is carried at
   * that height), walks straight to `stand`, faces the point, lets the body
   * settle and lets go. Returns where the body came to rest, or null if
   * nothing was held or it could not be let go.
   */
  async setDown(
    x: number,
    y: number,
    z: number,
    stand: Point2,
    pitchDeg: number,
  ): Promise<Point3 | null> {
    const start = await this.state();
    const held = start.player.heldBody;
    if (held === null) {
      this.log("setDown: nothing held");
      return null;
    }
    const toward = lookToward(start.player.feet, {
      x: stand.x,
      y: 0,
      z: stand.z,
    });
    await this.look(toward.yawDeg, pitchDeg, true);
    await this.raw(10);
    const walk = await this.walkTo(stand.x, stand.z, {
      direct: true,
      tolerance: 0.1,
    });
    if (!walk.arrived) {
      return null;
    }
    const eye = await this.eye();
    await this.look(lookToward(eye, { x, y: eye.y, z }).yawDeg, pitchDeg, true);
    await this.raw(20);
    await this.raw(1, { usePressed: true });
    await this.raw(45);
    const body = (await this.bodies()).find((b) => b.id === held);
    const after = (await this.state()).player.heldBody;
    await this.note(
      `setDown(${f(x)}, ${f(y)}, ${f(z)})`,
      `rests at ${body ? fmt(body.position) : "?"}${after === null ? "" : " STILL HELD"}`,
    );
    return after === null && body ? body.position : null;
  }

  /**
   * Pushes a body that is too heavy to carry until its centre is within
   * `tolerance` of (x, z): stands behind it on the far side from the target
   * (`approach(position)` says where), faces the target and walks into it,
   * a short stretch at a time, re-approaching whenever it drifts off line.
   * Returns the body's final position.
   */
  async pushTo(
    bodyId: number,
    x: number,
    z: number,
    approach: (at: Point2) => Point2,
    tolerance: number,
    maxRounds = 12,
  ): Promise<Point3 | null> {
    const bodyAt = async (): Promise<Point3 | null> =>
      (await this.bodies()).find((b) => b.id === bodyId)?.position ?? null;
    for (let round = 0; round < maxRounds; round++) {
      const p = await bodyAt();
      if (!p) return null;
      const left = horizontalDistance(p, { x, z });
      if (left <= tolerance) {
        await this.note(
          `pushTo(#${bodyId}, ${f(x)}, ${f(z)})`,
          `rests at ${fmt(p)}`,
        );
        return p;
      }
      // Behind the body, coming round its side if it is in the way.
      const behind = approach(p);
      const feet = (await this.state()).player.feet;
      const ux = (x - p.x) / left;
      const uz = (z - p.z) / left;
      const ahead = (feet.x - p.x) * ux + (feet.z - p.z) * uz;
      if (ahead > -0.3) {
        // The pilot is beside or in front of it: go round the side it is on.
        const side = (feet.x - p.x) * -uz + (feet.z - p.z) * ux >= 0 ? 1 : -1;
        const out = 1.0;
        await this.walkTo(
          p.x - uz * side * out + ux * Math.max(ahead, 0),
          p.z + ux * side * out + uz * Math.max(ahead, 0),
          { direct: true, tolerance: 0.2 },
        );
        await this.walkTo(
          behind.x - uz * side * out,
          behind.z + ux * side * out,
          { direct: true, tolerance: 0.2 },
        );
      }
      const reached = await this.walkTo(behind.x, behind.z, {
        direct: true,
        tolerance: 0.12,
      });
      if (!reached.arrived) {
        this.log(`pushTo: could not get behind #${bodyId}`);
      }
      // Walk into it towards the target for up to 1.2 m, re-aiming at the
      // target through the body's current centre.
      const startStep = (await this.state()).step;
      for (let i = 0; i < 40; i++) {
        const q = await bodyAt();
        if (!q) return null;
        const rest = horizontalDistance(q, { x, z });
        if (rest <= tolerance * 0.6) break;
        const me = (await this.state()).player.feet;
        // Off line: the pilot no longer stands behind the body.
        const vx = (x - q.x) / rest;
        const vz = (z - q.z) / rest;
        const lateral = Math.abs((me.x - q.x) * -vz + (me.z - q.z) * vx);
        if (lateral > 0.3) break;
        const eye = await this.eye();
        const aim = lookToward(eye, {
          x: q.x + vx * 2,
          y: eye.y,
          z: q.z + vz * 2,
        });
        const turn = lookDelta(
          { yawDeg: (await this.state()).player.yawDeg, pitchDeg: 0 },
          { yawDeg: aim.yawDeg, pitchDeg: 0 },
        );
        await this.raw(4, {
          moveZ: clamp(rest / 0.8, 0.35, 1),
          lookDx: turn.dx,
        });
        if ((await this.state()).step - startStep > 240) break;
      }
      await this.raw(30);
    }
    const end = await bodyAt();
    await this.note(
      `pushTo(#${bodyId}, ${f(x)}, ${f(z)})`,
      `GAVE UP at ${end ? fmt(end) : "?"}`,
    );
    return end;
  }

  private holdDistance(state: PilotState, held: number): number {
    const tag = state.bodies.find((b) => b.id === held)?.tag ?? "";
    const spec = PROP_SPECS[tag as keyof typeof PROP_SPECS];
    const radius = spec
      ? Math.hypot(spec.halfExtents.x, spec.halfExtents.y, spec.halfExtents.z)
      : 0.5;
    return Math.max(HOLD_DISTANCE, radius + HOLD_CLEARANCE);
  }

  // --- Seeing ----------------------------------------------------------------

  /** Saves the exact rendered frame as `<outDir>/<name>.png`. */
  async frame(name: string): Promise<string> {
    const path = join(this.outDir, `${name}.png`);
    await this.session.captureFrame(path);
    this.log(`frame ${path}`);
    return path;
  }

  /** Saves a screenshot of the whole page, HUD included. */
  async page(name: string): Promise<string> {
    const path = join(this.outDir, `${name}-page.png`);
    await this.session.screenshot(path);
    this.log(`page ${path}`);
    return path;
  }
}
