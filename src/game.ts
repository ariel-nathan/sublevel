import { createAudioSystem } from "./audio";
import type {
  BuiltLevel,
  Camera,
  ColliderRef,
  DrawItem,
  HudState,
  LightDef,
  PhysicsWorld,
  Player,
  PlayerEvent,
  PlayerInput,
  PointLight,
  Renderer,
  SoundId,
  WorldEvent,
  WorldObjects,
} from "./core/api";
import { FIXED_DT } from "./core/loop";
import { MATERIALS, type SurfaceKind } from "./core/materials";
import { createHud } from "./hud";
import { buildLevel } from "./level";
import { mat4, quat, v3, type Vec3 } from "./math";
import { createPhysicsWorld } from "./physics";
import { createPlayer } from "./player";
import { createWorldObjects } from "./props";
import { createRenderer } from "./render";
import { createTextureSet } from "./textures";

export const SEED = 1998;
const INTERNAL_HEIGHT = 300;
/** The player's weight on pressure plates, in kilograms. */
const PLAYER_MASS = 80;
/** Most recent log entries kept for the test harness. */
const LOG_LIMIT = 2000;

export const IDLE_INPUT: Readonly<PlayerInput> = {
  moveX: 0,
  moveZ: 0,
  lookDx: 0,
  lookDy: 0,
  jump: false,
  crouch: false,
  usePressed: false,
  primaryPressed: false,
};

const FOOTSTEPS: Readonly<Record<SurfaceKind, SoundId>> = {
  concrete: "footstep_concrete",
  tile: "footstep_tile",
  metal: "footstep_metal",
  wood: "footstep_concrete",
  plastic: "footstep_tile",
  rubber: "footstep_concrete",
};

const IMPACTS: Readonly<Record<SurfaceKind, SoundId>> = {
  concrete: "impact_wood",
  tile: "impact_plastic",
  metal: "impact_metal",
  wood: "impact_wood",
  plastic: "impact_plastic",
  rubber: "impact_plastic",
};

/** Brightness multiplier for a light at a given time. */
function flicker(light: LightDef, index: number, time: number): number {
  if (light.flicker === "none") {
    return 1;
  }
  const t = time + index * 3.7;
  if (light.flicker === "fluorescent") {
    // Mostly steady with a fast shimmer and an occasional dip.
    const shimmer = 0.94 + 0.06 * Math.sin(t * 97);
    const dip = Math.sin(t * 2.3) * Math.sin(t * 5.1) > 0.82 ? 0.45 : 1;
    return shimmer * dip;
  }
  // Broken: mostly off, stuttering on in bursts.
  const burst = Math.sin(t * 1.7) + Math.sin(t * 4.3) * 0.6;
  return burst > 0.9 ? (Math.sin(t * 61) > 0 ? 1 : 0.15) : 0.04;
}

/** A game event with the simulation step it happened on. */
export type GameLogEntry = { step: number } & (PlayerEvent | WorldEvent);

export interface CameraPose {
  position: Vec3;
  yaw: number;
  pitch: number;
}

export interface Game {
  readonly level: BuiltLevel;
  readonly physics: PhysicsWorld;
  readonly player: Player;
  readonly world: WorldObjects;
  readonly renderer: Renderer;
  /** Fixed steps simulated so far. */
  readonly stepCount: number;
  /** Player and world events, most recent last. */
  readonly log: readonly GameLogEntry[];
  /** What the HUD showed on the last rendered frame. */
  readonly hud: Readonly<HudState>;
  /** When set, rendering uses this view in place of the player's eyes. */
  cameraOverride: CameraPose | null;
  /** Call from a user gesture so that audio can start. */
  resumeAudio(): void;
  /** Advances the simulation by one fixed step. */
  step(input: PlayerInput): void;
  /** Draws a frame. `playing` is false while the start overlay should show. */
  render(alpha: number, playing: boolean): void;
}

export async function createGame(canvas: HTMLCanvasElement): Promise<Game> {
  const textures = createTextureSet(SEED);
  const renderer = await createRenderer({
    canvas,
    textures,
    internalHeight: INTERNAL_HEIGHT,
  });
  renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", () => {
    renderer.resize(window.innerWidth, window.innerHeight);
  });

  const level = buildLevel();
  const identity = mat4.identity();
  const levelItems: DrawItem[] = level.meshes.map((mesh) => ({
    mesh: renderer.createMesh(mesh),
    transform: identity,
  }));

  const physics = createPhysicsWorld();
  /** Surface kind of each static collider, for footsteps. */
  const staticSurfaces = new Map<number, SurfaceKind>();
  level.colliders.forEach((box, index) => {
    const brush = level.data.brushes[index];
    const top = brush?.faces?.py ?? brush?.material ?? "concrete_floor";
    staticSurfaces.set(physics.addStatic(box), MATERIALS[top].surface);
  });
  const surfaceOf = (ref: ColliderRef | null): SurfaceKind => {
    if (ref?.kind === "static") {
      return staticSurfaces.get(ref.id) ?? "concrete";
    }
    if (ref?.kind === "body") {
      const tag = physics.getBody(ref.id)?.tag ?? "";
      return tag.includes("metal") || tag === "barrel" ? "metal" : "wood";
    }
    return "metal";
  };

  const world = createWorldObjects({
    level: level.data,
    physics,
    renderer,
    seed: SEED,
  });
  const player = createPlayer({ physics, spawn: level.data.playerSpawn });
  const hud = createHud(document.body);
  const audio = createAudioSystem();
  for (const emitter of level.data.emitters) {
    audio.startLoop(emitter.sound, {
      position:
        emitter.sound === "ambient_drone" ? undefined : emitter.position,
      gain: emitter.gain,
    });
  }

  let stepCount = 0;
  let message: string | null = "Find the way out";
  let messageTime = 5;
  const log: GameLogEntry[] = [];
  let hudState: HudState = {
    playing: false,
    crosshair: "idle",
    prompt: null,
    message: null,
  };
  // Sound variation must not disturb the simulation, so it has its own
  // deterministic sequence, separate from anything gameplay uses.
  let variation = 0;
  const vary = (): number => {
    variation = (variation * 1103515245 + 12345) >>> 0;
    return variation / 4294967296;
  };
  const record = (event: PlayerEvent | WorldEvent): void => {
    log.push({ step: stepCount, ...event });
    if (log.length > LOG_LIMIT) {
      log.splice(0, log.length - LOG_LIMIT);
    }
  };

  const onWorldEvent = (event: WorldEvent): void => {
    record(event);
    switch (event.type) {
      case "impact": {
        const strength = Math.min(1, event.impulse / 60);
        audio.play(IMPACTS[event.surface], {
          position: event.position,
          gain: 0.25 + 0.75 * strength,
          pitch: 1.15 - 0.3 * strength + vary() * 0.1,
        });
        break;
      }
      case "break":
        audio.play("crate_break", { position: event.position });
        break;
      case "objective":
        message = "Exit unlocked";
        messageTime = 4;
        break;
      default:
        audio.play(event.type, { position: event.position });
    }
  };

  const onPlayerEvent = (event: PlayerEvent): void => {
    record(event);
    switch (event.type) {
      case "footstep":
        audio.play(FOOTSTEPS[surfaceOf(event.on)], {
          gain: 0.5,
          pitch: 0.92 + vary() * 0.16,
        });
        break;
      case "jump":
        audio.play("jump");
        break;
      case "land":
        audio.play("land", { gain: Math.min(1, event.speed / 8) });
        break;
      case "pickup":
        audio.play("pickup");
        break;
      case "throw":
        audio.play("throw");
        break;
      case "use":
        for (const used of world.use(event.hit)) {
          onWorldEvent(used);
        }
        break;
      case "drop":
        break;
    }
  };

  const game: Game = {
    level,
    physics,
    player,
    world,
    renderer,
    get stepCount() {
      return stepCount;
    },
    log,
    get hud() {
      return hudState;
    },
    cameraOverride: null,
    resumeAudio() {
      void audio.resume();
    },
    step(input) {
      stepCount++;
      for (const event of player.update(FIXED_DT, input)) {
        onPlayerEvent(event);
      }
      physics.step(FIXED_DT);
      const worldEvents = world.update(FIXED_DT, {
        contacts: physics.drainContacts(),
        playerBox: player.box(),
        playerMass: PLAYER_MASS,
      });
      for (const event of worldEvents) {
        onWorldEvent(event);
      }
      if (player.heldBody !== null && !physics.getBody(player.heldBody)) {
        player.releaseHeld();
      }
      if (messageTime > 0) {
        messageTime -= FIXED_DT;
      }
    },
    render(alpha, playing) {
      const time = (stepCount + alpha) * FIXED_DT;
      const camera: Camera = player.camera(alpha);
      const override = game.cameraOverride;
      if (override) {
        camera.position = override.position;
        camera.orientation = quat.fromYawPitch(override.yaw, override.pitch);
      }
      audio.setListener(
        camera.position,
        quat.rotate(camera.orientation, v3.create(0, 0, -1)),
        quat.rotate(camera.orientation, v3.create(0, 1, 0)),
      );
      const lights: PointLight[] = level.data.lights.map((light, index) => ({
        position: light.position,
        color: light.color,
        radius: light.radius,
        intensity: light.intensity * flicker(light, index, time),
        baked: light.flicker === "none",
      }));
      renderer.render({
        camera,
        items: levelItems.concat(world.drawItems(alpha)),
        lights,
        ambient: level.data.ambient,
        fog: level.data.fog,
        time,
      });
      const prompt = world.describe(player.aim);
      const holding = player.heldBody !== null;
      hudState = {
        playing,
        crosshair: holding ? "holding" : prompt ? "interact" : "idle",
        prompt: holding
          ? "E  Drop     Click  Throw"
          : prompt === "Too heavy"
            ? "Too heavy to lift"
            : prompt
              ? `E  ${prompt}`
              : null,
        message: messageTime > 0 ? message : null,
      };
      hud.update(hudState);
    },
  };
  return game;
}
