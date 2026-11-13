/**
 * Character viewer (demos/characters.html): a line-up of generated people in
 * the game's renderer, textures and lighting, for judging their look and
 * motion. Everything is also driven by query parameters and by
 * `window.__viewer` so a script can capture exact frames:
 *
 *   ?kind=scientist|guard|mixed &seed=1 &count=8 &clip=auto|idle|walk|...
 *   &rate=15 &stepped=1 &look=1 &talk=1 &walk=1 &orbit=1
 *   &view=lineup|threequarter|side|closeup &focus=0 &turn=deg
 *   &cam=x,y,z,yawDeg,pitchDeg &t=seconds (freezes time) &h=300 (internal height)
 *
 *   __viewer.configure({ clip: "walk" }); __viewer.setTime(0.4); __viewer.capture();
 */
import type { DrawItem, MeshHandle, PointLight, Renderer } from "../core/api";
import { MeshBuilder } from "../core/mesh";
import { mat4, quat, v3, type Vec3 } from "../math";
import { createRenderer } from "../render";
import { createTextureSet } from "../textures";
import {
  BONE,
  CharacterAnimator,
  characterDrawItems,
  CLIP_NAMES,
  CLIP_TABLE,
  generateCharacter,
  placementMatrix,
  TalkEnvelope,
  TURN_RATE,
  type Character,
  type CharacterKind,
  type ClipName,
  type Placement,
} from "./index";

const FIXED_DT = 1 / 60;
const FOV_Y = (74 * Math.PI) / 180;
const SPACING = 0.85;
const WALK_HALF = 3.2;

type Kind = CharacterKind | "mixed";
type View = "lineup" | "threequarter" | "side" | "closeup";

interface Settings {
  kind: Kind;
  seed: number;
  count: number;
  clip: ClipName | "auto";
  rate: number;
  stepped: boolean;
  look: boolean;
  talk: boolean;
  walk: boolean;
  orbit: boolean;
  view: View;
  focus: number;
  /** Extra turn of every character in degrees; null uses the view's. */
  turn: number | null;
  /** Pinned camera; null uses the orbit camera. */
  cam: { position: Vec3; yaw: number; pitch: number } | null;
}

const params = new URLSearchParams(location.search);
const num = (name: string, fallback: number): number => {
  const v = params.get(name);
  return v === null || v === "" || Number.isNaN(Number(v))
    ? fallback
    : Number(v);
};
const flag = (name: string, fallback: boolean): boolean => {
  const v = params.get(name);
  return v === null ? fallback : v !== "0" && v !== "false";
};

function parseCam(text: string | null): Settings["cam"] {
  const parts = text?.split(",").map(Number);
  if (!parts || parts.length < 3 || parts.some(Number.isNaN)) {
    return null;
  }
  return {
    position: v3.create(parts[0], parts[1], parts[2]),
    yaw: ((parts[3] ?? 0) * Math.PI) / 180,
    pitch: ((parts[4] ?? 0) * Math.PI) / 180,
  };
}

const clipParam = params.get("clip");
const settings: Settings = {
  kind: (["scientist", "guard", "mixed"].includes(params.get("kind") ?? "")
    ? params.get("kind")
    : "mixed") as Kind,
  seed: num("seed", 1),
  count: Math.max(1, Math.min(16, Math.round(num("count", 6)))),
  clip:
    clipParam && (CLIP_NAMES as readonly string[]).includes(clipParam)
      ? (clipParam as ClipName)
      : "auto",
  rate: num("rate", 15),
  stepped: flag("stepped", false),
  look: flag("look", false),
  talk: flag("talk", false),
  walk: flag("walk", false),
  orbit: flag("orbit", false),
  view: (["lineup", "threequarter", "side", "closeup"].includes(
    params.get("view") ?? "",
  )
    ? params.get("view")
    : "lineup") as View,
  focus: Math.max(0, Math.round(num("focus", 0))),
  turn: params.has("turn") ? num("turn", 0) : null,
  cam: parseCam(params.get("cam")),
};
let frozenAt: number | null = params.has("t") ? num("t", 0) : null;

const canvas = document.getElementById("view") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLDivElement;
const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

interface Actor {
  character: Character;
  meshes: MeshHandle[];
  animator: CharacterAnimator;
  talk: TalkEnvelope;
  placement: Placement;
  /** Walk-past state. */
  dir: number;
  turning: boolean;
  lane: number;
}

let renderer: Renderer;
let actors: Actor[] = [];
let sceneItems: DrawItem[] = [];
let simTime = 0;
let orbit = { yaw: 0, pitch: 0.08, dist: 3, target: v3.create(0, 0.95, 0) };

function kindOf(i: number): CharacterKind {
  if (settings.kind === "mixed") {
    return i % 2 === 0 ? "scientist" : "guard";
  }
  return settings.kind;
}

function viewTurn(): number {
  if (settings.turn !== null) {
    return (settings.turn * Math.PI) / 180;
  }
  return settings.view === "threequarter"
    ? (-35 * Math.PI) / 180
    : settings.view === "side"
      ? -Math.PI / 2
      : 0;
}

/** Facing the camera (+Z) plus the view's turn. */
function homeYaw(): number {
  return Math.PI + viewTurn();
}

function homeX(i: number): number {
  return (i - (actors.length - 1) / 2) * SPACING;
}

function startClip(actor: Actor): void {
  const a = actor.animator;
  if (settings.walk) {
    a.setAuto(false);
    a.play("walk", 0);
  } else if (settings.clip === "auto") {
    a.setAuto(true);
  } else {
    a.setAuto(false);
    a.play(settings.clip, 0);
  }
}

/** Rebuilds the characters (new meshes) for the current settings. */
function rebuild(): void {
  for (const actor of actors) {
    for (const mesh of actor.meshes) {
      renderer.destroyMesh(mesh);
    }
  }
  actors = [];
  for (let i = 0; i < settings.count; i++) {
    const seed = settings.seed * 1000 + i;
    const character = generateCharacter(seed, kindOf(i));
    actors.push({
      character,
      meshes: character.parts.map((part) => renderer.createMesh(part.mesh)),
      animator: new CharacterAnimator(character),
      talk: new TalkEnvelope(seed),
      placement: { position: v3.create(), yaw: 0 },
      dir: 1,
      turning: false,
      lane: 0,
    });
  }
  resetSim();
  resetCamera();
}

/** Puts everyone back at the start and restarts their clips at time 0. */
function resetSim(): void {
  simTime = 0;
  actors.forEach((actor, i) => {
    actor.animator = new CharacterAnimator(actor.character, {
      sampleRate: settings.rate,
      stepped: settings.stepped,
    });
    if (settings.walk) {
      const span = WALK_HALF * 2;
      actor.dir = i % 2 === 0 ? 1 : -1;
      actor.lane = -1.2 + (i % 4) * 0.8;
      const x = -WALK_HALF + ((i * 1.7) % span);
      actor.placement = {
        position: v3.create(x, 0, actor.lane),
        yaw: actor.dir > 0 ? -Math.PI / 2 : Math.PI / 2,
      };
      actor.turning = false;
    } else {
      actor.placement = { position: v3.create(homeX(i), 0, 0), yaw: homeYaw() };
    }
    startClip(actor);
  });
}

function stepSim(dt: number): void {
  simTime += dt;
  const eye = cameraPose().position;
  for (const actor of actors) {
    const a = actor.animator;
    a.sampleRate = settings.rate;
    a.stepped = settings.stepped;
    if (settings.walk) {
      const p = actor.placement;
      if (actor.turning) {
        const target = actor.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
        const diff = target - p.yaw;
        const step = Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt);
        p.yaw += step;
        if (Math.abs(target - p.yaw) < 1e-4) {
          p.yaw = target;
          actor.turning = false;
          a.play("walk");
        }
      } else {
        p.position.x += actor.dir * actor.character.walkSpeed * dt;
        if (
          Math.abs(p.position.x) > WALK_HALF &&
          Math.sign(p.position.x) === actor.dir
        ) {
          actor.dir = -actor.dir;
          actor.turning = true;
          a.play("turn_in_place");
        }
      }
    } else if (settings.clip !== "auto" && a.finished) {
      a.play(settings.clip as ClipName);
    }
    a.setLookTarget(settings.look ? eye : null);
    a.jaw = settings.talk ? actor.talk.at(simTime) : 0;
    a.update(dt, actor.placement);
  }
}

/** Runs the simulation from the start to exactly time t (fixed steps). */
function setTime(t: number): void {
  resetSim();
  const steps = Math.round(t / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    stepSim(FIXED_DT);
  }
}

function resetCamera(): void {
  const n = actors.length;
  if (settings.view === "closeup") {
    const i = Math.min(settings.focus, n - 1);
    const actor = actors[i];
    const head = actor.character.skeleton.bindPositions[BONE.head];
    orbit = {
      yaw: 0,
      pitch: 0.02,
      dist: 0.5,
      target: v3.create(homeX(i), head.y + 0.0, 0),
    };
    return;
  }
  if (n === 1 && !settings.walk) {
    // One person: frame the whole body tightly.
    orbit = { yaw: 0, pitch: 0.1, dist: 1.85, target: v3.create(0, 0.9, 0) };
    return;
  }
  const width = Math.max(1, n) * SPACING;
  const aspect = renderer.width / Math.max(1, renderer.height);
  const halfH = Math.atan(Math.tan(FOV_Y / 2) * aspect);
  const dist = Math.max(2.6, (width / 2 + 0.35) / Math.tan(halfH) + 0.4);
  orbit = {
    yaw: 0,
    pitch: 0.06,
    dist: settings.walk ? Math.max(dist, 6.5) : dist,
    target: v3.create(0, 0.92, settings.walk ? -0.2 : 0),
  };
}

function cameraPose(): { position: Vec3; yaw: number; pitch: number } {
  if (settings.cam) {
    return settings.cam;
  }
  const { yaw, pitch, dist, target } = orbit;
  return {
    position: v3.create(
      target.x + dist * Math.sin(yaw) * Math.cos(pitch),
      target.y + dist * Math.sin(pitch),
      target.z + dist * Math.cos(yaw) * Math.cos(pitch),
    ),
    yaw,
    pitch: -pitch,
  };
}

// --- Scene -------------------------------------------------------------------

function buildRoom(): DrawItem[] {
  const identity = mat4.identity();
  const floor = new MeshBuilder("lab_floor_tile");
  floor.addBox(v3.create(-9, -0.2, -4), v3.create(9, 0, 8), { tileSize: 1.2 });
  const wall = new MeshBuilder("lab_wall");
  wall.addBox(v3.create(-9, 0, -4.4), v3.create(9, 3.2, -4), { tileSize: 2 });
  const side = new MeshBuilder("concrete_wall");
  side.addBox(v3.create(-9.4, 0, -4.4), v3.create(-9, 3.2, 8), { tileSize: 2 });
  side.addBox(v3.create(9, 0, -4.4), v3.create(9.4, 3.2, 8), { tileSize: 2 });
  const ceiling = new MeshBuilder("ceiling_panel");
  ceiling.addBox(v3.create(-9, 3.2, -4), v3.create(9, 3.4, 8), {
    tileSize: 1.2,
  });
  return [floor, wall, side, ceiling].map((b) => ({
    mesh: renderer.createMesh(b.build()),
    transform: identity,
  }));
}

const LIGHTS: PointLight[] = [
  {
    position: v3.create(-1.8, 2.9, 1.2),
    color: v3.create(0.95, 0.97, 1.0),
    radius: 8,
    intensity: 1.0,
    baked: false,
  },
  {
    position: v3.create(2.2, 2.9, 0.6),
    color: v3.create(0.92, 0.95, 1.0),
    radius: 8,
    intensity: 0.9,
    baked: false,
  },
  {
    position: v3.create(4.5, 1.6, 3.0),
    color: v3.create(1.0, 0.72, 0.45),
    radius: 7,
    intensity: 0.7,
    baked: false,
  },
];
const AMBIENT = v3.create(0.07, 0.075, 0.09);
const FOG = { color: v3.create(0.07, 0.09, 0.11), near: 12, far: 40 };

function draw(): void {
  const cam = cameraPose();
  const items: DrawItem[] = [...sceneItems];
  for (const actor of actors) {
    items.push(
      ...characterDrawItems(
        actor.character,
        actor.meshes,
        actor.animator.pose(),
        placementMatrix(actor.placement),
      ),
    );
  }
  renderer.render({
    camera: {
      position: cam.position,
      orientation: quat.fromYawPitch(cam.yaw, cam.pitch),
      fovY: FOV_Y,
      near: 0.03,
      far: 60,
    },
    items,
    lights: LIGHTS,
    ambient: AMBIENT,
    fog: FOG,
    time: simTime,
  });
}

// --- Controls ------------------------------------------------------------------

function syncControls(): void {
  ($("kind") as HTMLSelectElement).value = settings.kind;
  ($("seed") as HTMLInputElement).value = String(settings.seed);
  ($("count") as HTMLInputElement).value = String(settings.count);
  ($("clip") as HTMLSelectElement).value = settings.clip;
  ($("rate") as HTMLInputElement).value = String(settings.rate);
  ($("stepped") as HTMLInputElement).checked = settings.stepped;
  ($("look") as HTMLInputElement).checked = settings.look;
  ($("talk") as HTMLInputElement).checked = settings.talk;
  ($("walk") as HTMLInputElement).checked = settings.walk;
  ($("orbit") as HTMLInputElement).checked = settings.orbit;
  ($("view") as HTMLSelectElement).value = settings.view;
  ($("focus") as HTMLInputElement).value = String(settings.focus);
}

function wireControls(): void {
  const clip = $("clip") as HTMLSelectElement;
  for (const name of ["auto", ...CLIP_NAMES]) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent =
      name === "auto"
        ? "auto (idle + fidgets)"
        : `${name} ${CLIP_TABLE[name as ClipName].duration}s${CLIP_TABLE[name as ClipName].loop ? "" : " once"}`;
    clip.appendChild(option);
  }
  syncControls();
  const on = (id: string, fn: (el: HTMLInputElement) => void): void => {
    $(id).addEventListener("change", () => fn($(id) as HTMLInputElement));
  };
  on("kind", (el) => configure({ kind: el.value as Kind }));
  on("seed", (el) => configure({ seed: Number(el.value) || 0 }));
  on("count", (el) => configure({ count: Number(el.value) || 1 }));
  on("clip", (el) => configure({ clip: el.value as Settings["clip"] }));
  on("rate", (el) => configure({ rate: Math.max(1, Number(el.value) || 15) }));
  on("stepped", (el) => configure({ stepped: el.checked }));
  on("look", (el) => configure({ look: el.checked }));
  on("talk", (el) => configure({ talk: el.checked }));
  on("walk", (el) => configure({ walk: el.checked }));
  on("orbit", (el) => configure({ orbit: el.checked }));
  on("view", (el) => configure({ view: el.value as View }));
  on("focus", (el) => configure({ focus: Math.max(0, Number(el.value) || 0) }));
  $("reroll").addEventListener("click", () =>
    configure({ seed: Math.floor(Math.random() * 100000) }),
  );
  $("toggle").addEventListener("click", () =>
    $("panel").classList.toggle("hidden"),
  );

  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = "grab";
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    settings.cam = null;
    orbit.yaw -= e.movementX * 0.008;
    orbit.pitch = Math.max(
      -0.6,
      Math.min(1.2, orbit.pitch + e.movementY * 0.006),
    );
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      settings.cam = null;
      orbit.dist = Math.max(
        0.3,
        Math.min(20, orbit.dist * Math.exp(e.deltaY * 0.001)),
      );
    },
    { passive: false },
  );
}

/** Changes settings; rebuilds the characters or restarts the clips as needed. */
function configure(change: Partial<Settings>): void {
  const before = { ...settings };
  Object.assign(settings, change);
  settings.count = Math.max(1, Math.min(16, Math.round(settings.count)));
  if (
    before.kind !== settings.kind ||
    before.seed !== settings.seed ||
    before.count !== settings.count
  ) {
    rebuild();
  } else if (
    before.clip !== settings.clip ||
    before.walk !== settings.walk ||
    before.view !== settings.view ||
    before.turn !== settings.turn ||
    before.rate !== settings.rate ||
    before.stepped !== settings.stepped
  ) {
    if (before.view !== settings.view || before.walk !== settings.walk) {
      resetCamera();
    }
    setTime(frozenAt ?? 0);
  } else if (before.focus !== settings.focus) {
    resetCamera();
  }
  syncControls();
  draw();
}

// --- Start ---------------------------------------------------------------------

async function start(): Promise<void> {
  renderer = await createRenderer({
    canvas,
    textures: createTextureSet(1998),
    internalHeight: num("h", 300),
  });
  renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", () => {
    renderer.resize(window.innerWidth, window.innerHeight);
  });
  sceneItems = buildRoom();
  wireControls();
  rebuild();
  if (frozenAt !== null) {
    setTime(frozenAt);
  }

  const viewer = {
    /** Freezes time at t seconds after the start (deterministic) and draws. */
    setTime(t: number): void {
      frozenAt = t;
      setTime(t);
      draw();
    },
    /** Lets time run again. */
    play(): void {
      frozenAt = null;
    },
    draw,
    configure(change: Partial<Settings> & { cam?: unknown }): void {
      const c = { ...change } as Partial<Settings>;
      if (typeof change.cam === "string") {
        c.cam = parseCam(change.cam);
      }
      configure(c);
    },
    /** Draws and returns the frame as a PNG data URL at internal resolution. */
    capture(): string {
      draw();
      return canvas.toDataURL("image/png");
    },
    state() {
      return {
        time: simTime,
        size: { width: renderer.width, height: renderer.height },
        settings,
        actors: actors.map((a) => ({
          kind: a.character.spec.kind,
          seed: a.character.spec.seed,
          height: a.character.spec.height,
          triangles: a.character.triangleCount,
          clip: a.animator.clipName,
          walkSpeed: a.character.walkSpeed,
        })),
      };
    },
  };
  (window as unknown as { __viewer: typeof viewer }).__viewer = viewer;

  let last = performance.now();
  let accumulator = 0;
  let frames = 0;
  let fpsTime = last;
  let fps = 0;
  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (frozenAt === null) {
      accumulator += dt;
      while (accumulator >= FIXED_DT) {
        stepSim(FIXED_DT);
        accumulator -= FIXED_DT;
      }
      if (settings.orbit && !settings.cam) {
        orbit.yaw += dt * 0.25;
      }
    }
    draw();
    frames++;
    if (now - fpsTime > 500) {
      fps = (frames * 1000) / (now - fpsTime);
      frames = 0;
      fpsTime = now;
      const tris = actors.map((a) => a.character.triangleCount);
      status.textContent =
        `t ${simTime.toFixed(1)}s  ${fps.toFixed(0)} fps  ${renderer.width}x${renderer.height}\n` +
        `tris ${Math.min(...tris)}-${Math.max(...tris)}  ` +
        `clip ${actors[0]?.animator.clipName ?? "-"}\n` +
        `walk ${actors[0]?.character.walkSpeed.toFixed(2) ?? "-"} m/s`;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  console.log("characters demo: running");
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `error: ${message}`;
  status.style.color = "#f99";
  console.error("characters demo:", message);
});
