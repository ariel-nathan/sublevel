/**
 * Test interface, installed as `window.__harness` when the page is opened
 * with `?harness`. In this mode the game does not run by itself: the caller
 * advances the simulation step by step, so every run is repeatable.
 *
 * Everything here returns plain JSON-serialisable data so that it can be
 * called from outside the page (tools/ drives it over the DevTools protocol).
 */
import type { DebugView, PlayerInput } from "../core/api";
import { IDLE_INPUT, type CameraPose, type Game } from "../game";
import type { Vec3 } from "../math";
import { decodeReplay, type Replay } from "./replay";

export interface HarnessState {
  step: number;
  /** True once the player has reached the exit. */
  finished: boolean;
  player: {
    feet: Vec3;
    velocity: Vec3;
    yawDeg: number;
    pitchDeg: number;
    onGround: boolean;
    crouched: boolean;
    heldBody: number | null;
    aim: { kind: string; id: number; distance: number } | null;
  };
  hud: Game["hud"];
  bodies: { id: number; tag: string; position: Vec3; asleep: boolean }[];
}

export interface Harness {
  /** Internal render size. */
  size(): { width: number; height: number };
  /**
   * Runs `count` fixed steps with the given scripted input (missing fields
   * are idle), then draws a frame. Press-type fields apply to the first
   * step only; look deltas are spread evenly over the steps.
   */
  step(count: number, input?: Partial<PlayerInput>): void;
  /**
   * Runs `count` fixed steps taking input from real keyboard and mouse
   * events (dispatched by the driver), then draws a frame.
   */
  stepReal(count: number): void;
  /** Drops mouse movement received so far (used when the driver re-centres). */
  discardLook(): void;
  /** Runs a recorded session, or its first `limit` steps, then draws. */
  replay(replay: Replay, limit?: number): number;
  /** Views the world from a fixed pose; null returns to the player's eyes. */
  setCamera(
    pose: { position: Vec3; yawDeg: number; pitchDeg: number } | null,
  ): void;
  /** Switches the renderer's diagnostic view and redraws. */
  setDebugView(view: DebugView): void;
  /** Redraws without advancing the simulation. */
  draw(): void;
  /** The last drawn frame as a PNG data URL at internal resolution. */
  capture(): string;
  state(): HarnessState;
  /** Events since the given step (exclusive), oldest first. */
  events(sinceStep?: number): Game["log"][number][];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
const roundVec = (v: Vec3): Vec3 => ({
  x: round(v.x),
  y: round(v.y),
  z: round(v.z),
});
const degrees = (radians: number): number => round((radians * 180) / Math.PI);

export function installHarness(
  game: Game,
  canvas: HTMLCanvasElement,
  sampleRealInput: () => PlayerInput,
  discardLook: () => void,
): Harness {
  const draw = (): void => game.render(1, true);
  const harness: Harness = {
    size: () => ({ width: game.renderer.width, height: game.renderer.height }),
    step(count, input = {}) {
      for (let i = 0; i < count; i++) {
        game.step({
          ...IDLE_INPUT,
          ...input,
          lookDx: (input.lookDx ?? 0) / count,
          lookDy: (input.lookDy ?? 0) / count,
          usePressed: i === 0 && input.usePressed === true,
          primaryPressed: i === 0 && input.primaryPressed === true,
        });
      }
      draw();
    },
    stepReal(count) {
      for (let i = 0; i < count; i++) {
        game.step(sampleRealInput());
      }
      draw();
    },
    discardLook,
    replay(replay, limit) {
      const inputs = decodeReplay(replay);
      const count = Math.min(inputs.length, limit ?? inputs.length);
      for (let i = 0; i < count; i++) {
        game.step(inputs[i]);
      }
      draw();
      return count;
    },
    setCamera(pose) {
      const override: CameraPose | null = pose
        ? {
            position: pose.position,
            yaw: (pose.yawDeg * Math.PI) / 180,
            pitch: (pose.pitchDeg * Math.PI) / 180,
          }
        : null;
      game.cameraOverride = override;
      draw();
    },
    setDebugView(view) {
      game.renderer.setDebugView(view);
      draw();
    },
    draw,
    capture() {
      // Draw and read back in the same task: a WebGPU canvas only holds its
      // image until the browser presents the frame.
      draw();
      return canvas.toDataURL("image/png");
    },
    state() {
      const { player } = game;
      const aim = player.aim;
      return {
        step: game.stepCount,
        finished: game.finished,
        player: {
          feet: roundVec(player.feet),
          velocity: roundVec(player.velocity),
          yawDeg: degrees(player.yaw),
          pitchDeg: degrees(player.pitch),
          onGround: player.onGround,
          crouched: player.crouched,
          heldBody: player.heldBody,
          aim: aim
            ? {
                kind: aim.collider.kind,
                id: aim.collider.id,
                distance: round(aim.distance),
              }
            : null,
        },
        hud: game.hud,
        bodies: game.physics.bodies().map((body) => ({
          id: body.id,
          tag: body.tag,
          position: roundVec(body.position),
          asleep: body.asleep,
        })),
      };
    },
    events: (sinceStep = -1) =>
      game.log.filter((entry) => entry.step > sinceStep),
  };
  Object.assign(window, { __harness: harness, __game: game });
  return harness;
}
