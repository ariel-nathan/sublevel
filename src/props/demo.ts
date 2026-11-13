/**
 * Standalone world objects demo (demos/props.html). Builds the real level,
 * physics and renderer and flies a scripted camera past the props, door A, the
 * pressure plate and a weak crate that gets thrown at a wall. A last scene in
 * the storage room has a timed button (with a spell of forced "blocked" door
 * moves, as the physics reports them when something is in the way) and an
 * impact button that a thrown crate triggers.
 * Query parameters: ?cam=x,y,z,yawDeg,pitchDeg pins the camera, ?t=<seconds>
 * fast-forwards the simulation to that time and freezes it.
 */
import type {
  Aabb,
  ButtonDef,
  DoorDef,
  DrawItem,
  KinematicMoveResult,
  PhysicsWorld,
  PointLight,
  RayHit,
  WorldEvent,
} from "../core/api";
import { MeshBuilder } from "../core/mesh";
import { buildLevel } from "../level";
import { createPhysicsWorld } from "../physics";
import { mat4, quat, v3, type Vec3 } from "../math";
import { createRenderer } from "../render";
import { createTextureSet } from "../textures";
import { createWorldObjects } from "./index";

const FIXED_DT = 1 / 60;
const SEED = 1998;
const FOV_Y = (74 * Math.PI) / 180;

const overlay = document.getElementById("overlay") as HTMLDivElement;
const canvas = document.getElementById("view") as HTMLCanvasElement;
const params = new URLSearchParams(location.search);

function pinnedCamera(): { position: Vec3; yaw: number; pitch: number } | null {
  const parts = params.get("cam")?.split(",").map(Number);
  if (!parts || parts.length < 3 || parts.some(Number.isNaN)) {
    return null;
  }
  return {
    position: v3.create(parts[0], parts[1], parts[2]),
    yaw: ((parts[3] ?? 0) * Math.PI) / 180,
    pitch: ((parts[4] ?? 0) * Math.PI) / 180,
  };
}

interface Key {
  t: number;
  eye: Vec3;
  target: Vec3;
}

const k = (
  t: number,
  e: [number, number, number],
  g: [number, number, number],
): Key => ({
  t,
  eye: v3.create(...e),
  target: v3.create(...g),
});

/** The camera visits the lab, door A, the storage room, the plate and the extra scene. */
const PATH: Key[] = [
  k(0, [-3.4, 1.7, 2.2], [-2.5, 0.9, -2.6]),
  k(6, [0.5, 1.7, 1.8], [1.5, 0.8, -2.4]),
  k(10, [1.2, 1.6, 0.4], [4.1, 1.2, 0.2]),
  k(16, [2.8, 1.6, 0.6], [6, 1.2, 0]),
  k(22, [7.5, 1.6, 0], [9.5, 1.4, 4]),
  k(28, [9.5, 1.7, 7.4], [9.5, 0.6, 11.5]),
  k(34, [7.2, 1.7, 9.2], [8.5, 0.2, 12]),
  k(42, [10.6, 1.8, 11.2], [13.7, 1.2, 12]),
  k(50, [9.8, 1.7, 12.5], [9.7, 0.6, 15.6]),
  k(58, [8.5, 1.7, 12.5], [11, 0.8, 15]),
  k(64, [8.4, 1.7, 13.4], [8.3, 1.2, 10.2]),
  k(76, [8.9, 1.7, 13.0], [9.8, 1.2, 10.4]),
  k(90, [8.9, 1.7, 13.0], [9.8, 1.2, 10.4]),
  k(100, [8.4, 1.7, 13.0], [8.3, 1.3, 10.2]),
  k(110, [8.4, 1.7, 13.0], [8.3, 1.3, 10.2]),
  k(118, [-3.4, 1.7, 2.2], [-2.5, 0.9, -2.6]),
];
const PATH_LENGTH = PATH[PATH.length - 1].t;

function cameraAt(time: number): {
  position: Vec3;
  yaw: number;
  pitch: number;
} {
  const t = time % PATH_LENGTH;
  let i = 0;
  while (i < PATH.length - 2 && PATH[i + 1].t <= t) {
    i++;
  }
  const a = PATH[i];
  const b = PATH[i + 1];
  const f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  const s = f * f * (3 - 2 * f);
  const eye = v3.lerp(a.eye, b.eye, s);
  const target = v3.lerp(a.target, b.target, s);
  const dir = v3.sub(target, eye);
  return {
    position: eye,
    yaw: Math.atan2(-dir.x, -dir.z),
    pitch: Math.atan2(dir.y, Math.hypot(dir.x, dir.z)),
  };
}

async function start(): Promise<void> {
  const renderer = await createRenderer({
    canvas,
    textures: createTextureSet(SEED),
    internalHeight: 300,
  });
  renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", () =>
    renderer.resize(window.innerWidth, window.innerHeight),
  );

  const built = buildLevel();
  const realPhysics = createPhysicsWorld();
  for (const collider of built.colliders) {
    realPhysics.addStatic(collider);
  }

  // Extra scene in the storage room: a free-standing panel carrying a timed
  // button and an impact button, each with its own free-standing door.
  const panel: Aabb = {
    min: v3.create(7, 0, 10),
    max: v3.create(9.6, 2.4, 10.2),
  };
  realPhysics.addStatic(panel);
  const slab = (id: string, x: number, z: number): DoorDef => ({
    id,
    closed: {
      min: v3.create(x, 0, z),
      max: v3.create(x + 0.2, 2.2, z + 1.1),
    },
    openOffset: v3.create(0, 0, 1.2),
    material: "door_steel",
  });
  const extraButtons: ButtonDef[] = [
    {
      id: "button_timed",
      position: v3.create(7.6, 1.3, 10.26),
      facing: v3.create(0, 0, 1),
      target: "door_timed",
      mode: "timed",
      seconds: 6,
    },
    {
      id: "button_impact",
      position: v3.create(8.8, 1.2, 10.27),
      facing: v3.create(0, 0, 1),
      target: "door_impact",
      mode: "impact",
    },
  ];
  const TIMED_DOOR_X = 9.8;
  const level = {
    ...built.data,
    doors: [
      ...built.data.doors,
      slab("door_timed", TIMED_DOOR_X, 9.8),
      slab("door_impact", 6.3, 9.9),
    ],
    buttons: [...built.data.buttons, ...extraButtons],
    props: [
      ...built.data.props,
      {
        kind: "crate_wood_small" as const,
        position: v3.create(8.5, 0.25, 13.3),
        yaw: 0,
      },
    ],
  };
  // The physics the objects see: the timed door's moves are refused while
  // `forceBlocked` is set, as if something were in the way.
  let forceBlocked = false;
  const physics: PhysicsWorld = new Proxy(realPhysics, {
    get(target, prop) {
      if (prop === "moveKinematic") {
        return (id: number, min: Vec3): KinematicMoveResult =>
          forceBlocked && Math.abs(min.x - TIMED_DOOR_X) < 1e-6
            ? { blocked: true }
            : target.moveKinematic(id, min);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const identity = mat4.identity();
  const panelMesh = new MeshBuilder("metal_panel");
  panelMesh.addBox(panel.min, panel.max, { tileSize: 0.8 });
  const levelItems: DrawItem[] = [...built.meshes, panelMesh.build()].map(
    (mesh) => ({
      mesh: renderer.createMesh(mesh),
      transform: identity,
    }),
  );
  const world = createWorldObjects({ level, physics, renderer, seed: SEED });

  const lights: PointLight[] = level.lights.map((light) => ({
    position: light.position,
    color: light.color,
    radius: light.radius,
    intensity: light.intensity,
    baked: light.flicker === "none",
  }));

  const bodyOf = (tag: string, index = 0): number => {
    const matches = physics.bodies().filter((b) => b.tag === tag);
    return matches[index].id;
  };
  const metalCrate = bodyOf("crate_metal");
  const plate = level.plates[0];
  const plateCentre = v3.scale(v3.add(plate.box.min, plate.box.max), 0.5);
  const metalHome = physics.getBody(metalCrate)?.position ?? v3.create();
  const buttonHit = (index: number): RayHit => ({
    collider: { kind: "static", id: 0 },
    point: level.buttons[index].position,
    normal: level.buttons[index].facing,
    distance: 1,
  });
  // The weak crate on the storage floor is the one thrown at the south wall.
  const floorWeak = physics
    .bodies()
    .filter((b) => b.tag === "crate_weak")
    .sort((p, q) => p.position.y - q.position.y)[0].id;

  const thrownCrate = physics
    .bodies()
    .filter((b) => b.tag === "crate_wood_small")
    .sort(
      (p, q) =>
        v3.distance(p.position, v3.create(8.5, 0.25, 13.3)) -
        v3.distance(q.position, v3.create(8.5, 0.25, 13.3)),
    )[0].id;

  const recent: string[] = [];
  const log = (time: number, event: WorldEvent): void => {
    const where =
      "position" in event
        ? ` (${event.position.x.toFixed(1)}, ${event.position.y.toFixed(1)}, ${event.position.z.toFixed(1)})`
        : "";
    const extra =
      event.type === "impact"
        ? ` ${event.surface} ${event.impulse.toFixed(0)}`
        : event.type === "timer_tick"
          ? ` ${event.remaining.toFixed(1)}s left`
          : "";
    recent.push(
      `${time.toFixed(1).padStart(5)}s ${event.type}${extra}${where}`,
    );
    if (recent.length > 9) {
      recent.shift();
    }
  };

  let step = 0;
  const farBox: Aabb = {
    min: v3.create(100, 100, 100),
    max: v3.create(101, 101.8, 101),
  };
  const fired = new Set<string>();
  /** Scripted happenings, by simulation time. */
  const script = (time: number): WorldEvent[] => {
    const out: WorldEvent[] = [];
    // Door A button, every 6 seconds starting at 10 s.
    const pressSlot = Math.floor((time - 10) / 6);
    if (time >= 10 && !fired.has(`press${pressSlot}`)) {
      fired.add(`press${pressSlot}`);
      out.push(...world.use(buttonHit(0)));
    }
    // The heavy crate goes onto the plate for 12 s out of every 36 s.
    const cycle = Math.floor((time - 30) / 36);
    if (time >= 30 && !fired.has(`on${cycle}`)) {
      fired.add(`on${cycle}`);
      physics.setBodyPose(
        metalCrate,
        v3.create(plateCentre.x, plate.box.max.y + 0.36, plateCentre.z),
      );
    }
    if (time >= 42 && !fired.has(`off${Math.floor((time - 42) / 36)}`)) {
      fired.add(`off${Math.floor((time - 42) / 36)}`);
      physics.setBodyPose(metalCrate, metalHome);
    }
    // A weak crate is thrown at the south wall.
    if (time >= 51 && !fired.has("throw")) {
      fired.add("throw");
      physics.setBodyVelocity(floorWeak, v3.create(0.3, 0, 9));
    }
    // Extra scene. The timed button is pressed at 66 s and again at 80 s; from
    // 85 s to 92 s its door is "blocked" when it tries to close (the countdown
    // of the second press ends at 86 s), so it reopens and retries until the
    // obstruction goes. At 99 s a small crate is thrown at the impact button.
    for (const at of [66, 80]) {
      if (time >= at && !fired.has(`timed${at}`)) {
        fired.add(`timed${at}`);
        out.push(...world.use(buttonHit(2)));
      }
    }
    forceBlocked = time >= 85 && time < 92;
    if (time >= 99 && !fired.has("crate")) {
      fired.add("crate");
      physics.setBodyPose(thrownCrate, v3.create(8.8, 1.2, 12.8));
      physics.setBodyVelocity(thrownCrate, v3.create(0, 1, -9));
    }
    return out;
  };

  const advance = (): void => {
    const time = step * FIXED_DT;
    const scripted = script(time);
    physics.step(FIXED_DT);
    const contacts = physics.drainContacts();
    const events = [
      ...scripted,
      ...world.update(FIXED_DT, {
        contacts,
        playerBox: farBox,
        playerMass: 80,
      }),
    ];
    step++;
    for (const event of events) {
      log(time, event);
    }
  };

  const frozenAt = params.has("t") ? Number(params.get("t")) : null;
  if (frozenAt !== null) {
    const target = Math.round(frozenAt / FIXED_DT);
    while (step < target) {
      advance();
    }
  }
  const pinned = pinnedCamera();
  (window as unknown as Record<string, unknown>).demo = {
    world,
    physics,
    level,
  };

  let last = performance.now();
  let accumulator = 0;
  let shown = 0;
  const frame = (now: number): void => {
    if (frozenAt === null) {
      accumulator += Math.min(0.1, (now - last) / 1000);
      while (accumulator >= FIXED_DT) {
        advance();
        accumulator -= FIXED_DT;
      }
    }
    last = now;
    const time = step * FIXED_DT;
    const alpha = frozenAt === null ? accumulator / FIXED_DT : 1;
    const cam = pinned ?? cameraAt(time);
    const items = [...levelItems, ...world.drawItems(alpha)];
    renderer.render({
      camera: {
        position: cam.position,
        orientation: quat.fromYawPitch(cam.yaw, cam.pitch),
        fovY: FOV_Y,
        near: 0.05,
        far: 80,
      },
      items,
      lights,
      ambient: level.ambient,
      fog: level.fog,
      time,
    });
    if (now - shown > 200) {
      shown = now;
      overlay.textContent =
        `t ${time.toFixed(1)}s  items ${items.length}  bodies ${physics.bodies().length}\n` +
        recent.join("\n");
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  console.log("props demo: running");
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  overlay.textContent = `error: ${message}`;
  overlay.style.color = "#f99";
  console.error("props demo:", message);
});
