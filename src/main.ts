import type { DrawItem, LightDef, PointLight } from "./core/api";
import { createInput } from "./core/input";
import { runLoop } from "./core/loop";
import { buildLevel } from "./level";
import { clamp, mat4, quat, v3, type Vec3 } from "./math";
import { createRenderer } from "./render";
import { createTextureSet } from "./textures";

const SEED = 1998;
const INTERNAL_HEIGHT = 300;
const FOV_Y = (74 * Math.PI) / 180;

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

  // Temporary free-fly camera until the player module lands.
  const fixed = debugCamera();
  const spawn = level.data.playerSpawn;
  let position =
    fixed?.position ?? v3.add(spawn.position, v3.create(0, 1.65, 0));
  let yaw = fixed?.yaw ?? spawn.yaw;
  let pitch = fixed?.pitch ?? 0;
  const input = createInput(canvas);
  let time = 0;

  runLoop({
    update(dt) {
      time += dt;
      const look = input.consumeLook();
      yaw -= look.dx * 0.0022;
      pitch = clamp(pitch - look.dy * 0.0022, -1.5, 1.5);
      const orientation = quat.fromYawPitch(yaw, pitch);
      const forward = quat.rotate(orientation, v3.create(0, 0, -1));
      const right = quat.rotate(orientation, v3.create(1, 0, 0));
      const speed = input.isDown("ShiftLeft") ? 9 : 4;
      const axis = (positive: string, negative: string): number =>
        (input.isDown(positive) ? 1 : 0) - (input.isDown(negative) ? 1 : 0);
      position = v3.addScaled(
        position,
        forward,
        axis("KeyW", "KeyS") * speed * dt,
      );
      position = v3.addScaled(
        position,
        right,
        axis("KeyD", "KeyA") * speed * dt,
      );
      position.y += axis("Space", "ControlLeft") * speed * dt;
    },
    render() {
      const lights: PointLight[] = level.data.lights.map((light, index) => ({
        position: light.position,
        color: light.color,
        radius: light.radius,
        intensity: light.intensity * flicker(light, index, time),
        baked: light.flicker === "none",
      }));
      renderer.render({
        camera: {
          position,
          orientation: quat.fromYawPitch(yaw, pitch),
          fovY: FOV_Y,
          near: 0.05,
          far: 80,
        },
        items: levelItems,
        lights,
        ambient: level.data.ambient,
        fog: level.data.fog,
        time,
      });
    },
  });

  status.textContent = `${level.data.name}  ${renderer.width}x${renderer.height}  click to fly: WASD, mouse, Space/Ctrl`;
  console.log("sublevel: running", level.data.name);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `error: ${message}`;
  status.style.color = "#f99";
  console.error("sublevel:", message);
});
