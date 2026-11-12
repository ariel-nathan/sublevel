import { createAudioSystem } from "./audio";
import type {
  ColliderRef,
  DrawItem,
  LightDef,
  PlayerEvent,
  PlayerInput,
  PointLight,
  SoundId,
} from "./core/api";
import { createInput } from "./core/input";
import { runLoop } from "./core/loop";
import { MATERIALS, type SurfaceKind } from "./core/materials";
import { createHud } from "./hud";
import { buildLevel } from "./level";
import { mat4, quat, v3, type Vec3 } from "./math";
import { createPhysicsWorld } from "./physics";
import { createPlayer } from "./player";
import { createRenderer } from "./render";
import { createTextureSet } from "./textures";

const SEED = 1998;
const INTERNAL_HEIGHT = 300;

const status = document.getElementById("status") as HTMLDivElement;

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

/** Optional fixed camera for screenshots: ?cam=x,y,z,yawDeg,pitchDeg */
function debugCamera(): {
  position: Vec3;
  yaw: number;
  pitch: number;
} | null {
  const raw = new URLSearchParams(location.search).get("cam");
  const parts = raw?.split(",").map(Number);
  if (!parts || parts.length < 3 || parts.some(Number.isNaN)) {
    return null;
  }
  return {
    position: v3.create(parts[0], parts[1], parts[2]),
    yaw: ((parts[3] ?? 0) * Math.PI) / 180,
    pitch: ((parts[4] ?? 0) * Math.PI) / 180,
  };
}

const FOOTSTEPS: Readonly<Record<SurfaceKind, SoundId>> = {
  concrete: "footstep_concrete",
  tile: "footstep_tile",
  metal: "footstep_metal",
  wood: "footstep_concrete",
  plastic: "footstep_tile",
  rubber: "footstep_concrete",
};

const IDLE_INPUT: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  lookDx: 0,
  lookDy: 0,
  jump: false,
  crouch: false,
  usePressed: false,
  primaryPressed: false,
};

async function start(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
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
  const input = createInput(canvas, () => {
    void audio.resume();
  });

  const fixedCamera = debugCamera();
  /** Scripted input for automated checks: window.__sublevel.input = {...} */
  const debug: { input: Partial<PlayerInput> | null } = { input: null };
  Object.assign(window, { __sublevel: { debug, player, physics, level } });

  const samplePlayerInput = (): PlayerInput => {
    if (debug.input) {
      const scripted = { ...IDLE_INPUT, ...debug.input };
      // Edge-triggered fields fire once.
      debug.input.usePressed = false;
      debug.input.primaryPressed = false;
      debug.input.lookDx = 0;
      debug.input.lookDy = 0;
      return scripted;
    }
    const look = input.consumeLook();
    const use = input.consumePressed("KeyE");
    const primary = input.consumePressed("Mouse0");
    if (!input.locked) {
      return IDLE_INPUT;
    }
    const axis = (positive: string, negative: string): number =>
      (input.isDown(positive) ? 1 : 0) - (input.isDown(negative) ? 1 : 0);
    return {
      moveX: axis("KeyD", "KeyA"),
      moveZ: axis("KeyW", "KeyS"),
      lookDx: look.dx,
      lookDy: look.dy,
      jump: input.isDown("Space"),
      // Ctrl+W closes the tab in most browsers, so C and Shift crouch too.
      crouch:
        input.isDown("ControlLeft") ||
        input.isDown("KeyC") ||
        input.isDown("ShiftLeft"),
      usePressed: use,
      primaryPressed: primary,
    };
  };

  const onPlayerEvent = (event: PlayerEvent): void => {
    switch (event.type) {
      case "footstep":
        audio.play(FOOTSTEPS[surfaceOf(event.on)], {
          gain: 0.5,
          pitch: 0.92 + Math.random() * 0.16,
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
      case "drop":
      case "use":
        break;
    }
  };

  let time = 0;
  runLoop({
    update(dt) {
      time += dt;
      for (const event of player.update(dt, samplePlayerInput())) {
        onPlayerEvent(event);
      }
      physics.step(dt);
      physics.drainContacts();
    },
    render(alpha) {
      const camera = player.camera(alpha);
      if (fixedCamera) {
        camera.position = fixedCamera.position;
        camera.orientation = quat.fromYawPitch(
          fixedCamera.yaw,
          fixedCamera.pitch,
        );
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
        items: levelItems,
        lights,
        ambient: level.data.ambient,
        fog: level.data.fog,
        time,
      });
      hud.update({
        playing: input.locked || debug.input !== null,
        crosshair: player.heldBody !== null ? "holding" : "idle",
        prompt: null,
        message: null,
      });
    },
  });

  status.textContent = "";
  console.log("sublevel: running", level.data.name);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `error: ${message}`;
  status.style.color = "#f99";
  console.error("sublevel:", message);
});
