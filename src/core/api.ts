/**
 * Contracts between modules. Each module lives in its own folder under src/
 * and exports exactly the factory named in its section below from its
 * index.ts. Modules import types from here and never from each other.
 */
import type { Mat4, Quat, Vec3 } from "../math";
import type { MaterialId, SurfaceKind } from "./materials";
import type { MeshData } from "./mesh";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Axis-aligned box in world space. */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Linear RGB colour, each channel nominally 0..1. */
export type Color = Vec3;

// ---------------------------------------------------------------------------
// Textures: src/textures/index.ts
//   export function createTextureSet(seed: number): TextureSet
// ---------------------------------------------------------------------------

/** A square, tiling, procedurally generated texture. */
export interface TextureImage {
  material: MaterialId;
  /** Power of two, 16 to 128. */
  size: number;
  /** RGBA8, sRGB-encoded, row-major from the top-left; length size*size*4. */
  pixels: Uint8Array;
}

/** One image for every MaterialId. */
export type TextureSet = ReadonlyMap<MaterialId, TextureImage>;

// ---------------------------------------------------------------------------
// Renderer: src/render/index.ts
//   export function createRenderer(options: RendererOptions): Promise<Renderer>
// ---------------------------------------------------------------------------

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  textures: TextureSet;
  /** Internal render height in pixels; width follows the window aspect. */
  internalHeight: number;
}

export interface MeshHandle {
  readonly id: number;
}

export interface Camera {
  position: Vec3;
  orientation: Quat;
  /** Vertical field of view in radians. */
  fovY: number;
  near: number;
  far: number;
}

export interface PointLight {
  position: Vec3;
  color: Color;
  /** Distance in metres at which the light reaches zero. */
  radius: number;
  /** Brightness multiplier; the game animates this for flicker. */
  intensity: number;
  /**
   * True if this light is already included in the baked vertex colours of
   * level meshes. Meshes with `colors` skip baked lights; meshes without
   * `colors` (props, doors) are lit by every light.
   */
  baked: boolean;
  /** Optional box the light is confined to; surfaces outside it are unlit. */
  bounds?: Aabb;
}

export interface Fog {
  color: Color;
  /** Distance where fog starts. */
  near: number;
  /** Distance where fog is total. */
  far: number;
}

export interface DrawItem {
  mesh: MeshHandle;
  /** Model matrix. */
  transform: Mat4;
  /** Optional colour multiplier. */
  tint?: Color;
}

export interface RenderFrame {
  camera: Camera;
  items: readonly DrawItem[];
  lights: readonly PointLight[];
  /** Light added everywhere. */
  ambient: Color;
  fog: Fog;
  /** Seconds since start, for animated effects. */
  time: number;
}

/**
 * Diagnostic views for the test harness.
 * - "none": the normal image.
 * - "coverage": geometry drawn flat white on a pure magenta (255, 0, 255)
 *   background, with no lighting, fog or dithering, so any magenta pixel is
 *   a place where nothing was drawn.
 * - "material": each material in its own flat colour, unlit and undithered.
 * - "depth": distance from the camera as a grey ramp (near white, far black).
 * - "normals": world-space normal encoded as colour (n * 0.5 + 0.5).
 * - "lighting": lighting only, on white surfaces.
 */
export type DebugView =
  "none" | "coverage" | "material" | "depth" | "normals" | "lighting";

export interface Renderer {
  /** Current internal resolution. */
  readonly width: number;
  readonly height: number;
  /** Call when the window size changes. */
  resize(windowWidth: number, windowHeight: number): void;
  createMesh(data: MeshData): MeshHandle;
  destroyMesh(handle: MeshHandle): void;
  render(frame: RenderFrame): void;
  /** Switches the diagnostic view used by following 
ender calls. */
  setDebugView(view: DebugView): void;
}

// ---------------------------------------------------------------------------
// Physics: src/physics/index.ts
//   export function createPhysicsWorld(options?: PhysicsOptions): PhysicsWorld
// ---------------------------------------------------------------------------

export interface PhysicsOptions {
  /** Default (0, -9.81, 0). */
  gravity?: Vec3;
}

export type ColliderKind = "static" | "kinematic" | "body";

/** Identifies any collider in the world. Ids are unique within their kind. */
export interface ColliderRef {
  kind: ColliderKind;
  id: number;
}

/** A dynamic rigid box. */
export interface BodyDesc {
  /** Centre of mass. */
  position: Vec3;
  orientation?: Quat;
  halfExtents: Vec3;
  /** Kilograms, greater than zero. */
  mass: number;
  /** Coulomb friction coefficient. Default 0.6. */
  friction?: number;
  /** Bounciness 0..1. Default 0.1. */
  restitution?: number;
  linearVelocity?: Vec3;
  angularVelocity?: Vec3;
  /** Free-form label for gameplay, e.g. the prop kind. */
  tag?: string;
}

/** Read-only snapshot of a dynamic body. */
export interface BodyState {
  readonly id: number;
  readonly position: Vec3;
  readonly orientation: Quat;
  readonly linearVelocity: Vec3;
  readonly angularVelocity: Vec3;
  readonly halfExtents: Vec3;
  readonly mass: number;
  readonly asleep: boolean;
  readonly tag: string;
}

export interface RayHit {
  collider: ColliderRef;
  point: Vec3;
  /** Unit surface normal at the hit, facing the ray origin. */
  normal: Vec3;
  distance: number;
}

/** A collision that began or strengthened during the last step. */
export interface ContactEvent {
  a: ColliderRef;
  b: ColliderRef;
  point: Vec3;
  normal: Vec3;
  /** Normal impulse in newton-seconds; use it to scale impact sounds. */
  impulse: number;
}

export interface CharacterMoveOptions {
  /** Ledges up to this height are climbed automatically. Default 0.3. */
  stepHeight?: number;
  /** A body to pass through, e.g. the one the player is carrying. */
  ignoreBody?: number;
  /** Mass used when the character pushes dynamic bodies. Default 80. */
  pushMass?: number;
}

export interface CharacterMoveResult {
  /** New centre of the character box. */
  position: Vec3;
  /** Velocity after sliding along whatever was hit. */
  velocity: Vec3;
  onGround: boolean;
  /** Unit normal of the ground; (0, 1, 0) when airborne. */
  groundNormal: Vec3;
  /** What the character is standing on, if anything. */
  standingOn: ColliderRef | null;
  hitCeiling: boolean;
  /**
   * Velocity of the surface under the character at the point of contact:
   * zero on static ground, the body's or kinematic box's velocity otherwise.
   * The caller adds it to its own movement to ride moving things.
   */
  groundVelocity: Vec3;
}

/** A dynamic body that is sliding or rolling against something this step. */
export interface SlidingContact {
  /** The moving dynamic body. */
  body: number;
  /** What it is moving against. */
  other: ColliderRef;
  /** World position of the contact. */
  point: Vec3;
  /** Speed at which the two surfaces slip past each other, m/s. */
  slipSpeed: number;
  /** Speed at which the body rolls over the surface without slipping, m/s. */
  rollSpeed: number;
  /** Force pressing the surfaces together, newtons. */
  force: number;
}

export interface KinematicMoveResult {
  /**
   * True if the box could not complete the move because it would crush a
   * dynamic body or the character against something immovable. The box is
   * left where it was (or advanced only as far as it could go freely).
   */
  blocked: boolean;
}

export interface PhysicsWorld {
  gravity: Vec3;

  /** Immovable world geometry. Returns its static id. */
  addStatic(box: Aabb): number;

  /**
   * A box moved by game code (doors, lifts). It pushes dynamic bodies and
   * blocks the character but is not affected by them.
   */
  addKinematic(box: Aabb): number;
  /**
   * Moves a kinematic box so that its minimum corner is at `min`. Reports
   * whether the move was blocked, so a door can stop or reverse.
   */
  moveKinematic(id: number, min: Vec3): KinematicMoveResult;
  removeKinematic(id: number): void;

  addBody(desc: BodyDesc): number;
  removeBody(id: number): void;
  getBody(id: number): BodyState | undefined;
  bodies(): readonly BodyState[];

  /** Overwrites velocities and wakes the body. */
  setBodyVelocity(id: number, linear: Vec3, angular?: Vec3): void;
  /** Teleports a body and wakes it. */
  setBodyPose(id: number, position: Vec3, orientation?: Quat): void;
  /** Applies an impulse (N s) at a world point, or at the centre if omitted. */
  applyImpulse(id: number, impulse: Vec3, worldPoint?: Vec3): void;

  /** Advances the simulation. Always called with the fixed timestep. */
  step(dt: number): void;
  /** Returns and clears the contact events gathered since the last call. */
  drainContacts(): ContactEvent[];
  /**
   * Bodies sliding or rolling during the last step, at most one entry per
   * body (its strongest contact), for continuous scrape and roll sounds.
   * Resting and sleeping bodies are not listed.
   */
  slidingContacts(): SlidingContact[];

  /** Nearest hit along a ray. `direction` must be a unit vector. */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options?: { ignoreBody?: number },
  ): RayHit | null;

  /** Every collider whose bounds overlap the box. */
  overlapBox(box: Aabb): ColliderRef[];

  /**
   * Moves an upright, axis-aligned character box by `velocity * dt`,
   * colliding and sliding against statics, kinematics and dynamic bodies
   * (which it pushes). Does not apply gravity: the caller owns the
   * character's velocity. Call once per fixed step, before `step`.
   */
  moveCharacter(
    center: Vec3,
    halfExtents: Vec3,
    velocity: Vec3,
    dt: number,
    options?: CharacterMoveOptions,
  ): CharacterMoveResult;
}

// ---------------------------------------------------------------------------
// Audio: src/audio/index.ts
//   export function createAudioSystem(): AudioSystem
//   export function renderSound(sound: SoundId, sampleRate: number): Float32Array
// ---------------------------------------------------------------------------

export const SOUND_IDS = [
  "footstep_concrete",
  "footstep_tile",
  "footstep_metal",
  "land",
  "jump",
  "impact_wood",
  "impact_metal",
  "impact_plastic",
  "crate_break",
  "pickup",
  "throw",
  "button_press",
  "button_deny",
  "door_open",
  "door_close",
  "plate_down",
  "plate_up",
  "hum_fluorescent",
  "hum_machine",
  "ambient_drone",
  "timer_tick",
  "door_blocked",
  "objective",
  "scrape_wood",
  "scrape_metal",
  "scrape_plastic",
  "roll_metal",
] as const;

export type SoundId = (typeof SOUND_IDS)[number];

/** Sounds meant to be looped; all others are one-shots. */
export const LOOPING_SOUNDS: readonly SoundId[] = [
  "hum_fluorescent",
  "hum_machine",
  "ambient_drone",
  "scrape_wood",
  "scrape_metal",
  "scrape_plastic",
  "roll_metal",
];

export interface PlayOptions {
  /** World position for 3D sounds; omit for a non-positional sound. */
  position?: Vec3;
  /** Volume multiplier. Default 1. */
  gain?: number;
  /** Playback rate multiplier. Default 1. */
  pitch?: number;
  /**
   * How much solid geometry lies between the sound and the listener, from
   * 0 (clear line of sight, the default) to 1 (fully behind walls): the
   * sound is made quieter and duller accordingly.
   */
  occlusion?: number;
}

export interface LoopHandle {
  readonly id: number;
}

/** Reverberation character of the space the listener is in. */
export type RoomAcoustics = "small" | "lab" | "corridor" | "hall";

export interface AudioSystem {
  /** Must be called from a user gesture before anything is audible. */
  resume(): Promise<void>;
  setListener(position: Vec3, forward: Vec3, up: Vec3): void;
  play(sound: SoundId, options?: PlayOptions): void;
  startLoop(sound: SoundId, options?: PlayOptions): LoopHandle;
  stopLoop(handle: LoopHandle): void;
  /**
   * Changes a running loop's gain, pitch, position or occlusion, gliding to
   * the new values over `fadeSeconds` (default 0.05). Gain 0 silences the
   * loop without stopping it. Used for sounds that follow the simulation,
   * such as a crate scraping along the floor.
   */
  setLoopParams(
    handle: LoopHandle,
    params: PlayOptions,
    fadeSeconds?: number,
  ): void;
  /** Sets the reverberation of the listener's surroundings, cross-fading. */
  setRoom(room: RoomAcoustics): void;
  setMasterGain(gain: number): void;
}

// ---------------------------------------------------------------------------
// Level: src/level/index.ts
//   export function buildLevel(options?: LevelOptions): BuiltLevel
// ---------------------------------------------------------------------------

export interface LevelOptions {
  /**
   * Seed for a generated run. The same seed always gives the same facility.
   * Omit it to get the hand-built level.
   */
  seed?: number;
  /**
   * Development aid: build the opening room, then these room modules by
   * name in order, then the finish. Takes precedence over a generated run.
   */
  rooms?: readonly string[];
}

/**
 * One step of a known way to complete the level, in order. A generated
 * level is solvable by construction, and these steps are how that is proved:
 * a test bot carries them out and must reach the exit.
 *
 * Props are identified by their index in `LevelData.props`, buttons by id.
 */
export type SolutionStep =
  /** Walk in a straight line to a point on the floor. */
  | { do: "walk"; to: Vec3 }
  /**
   * Jump or step up onto a higher surface (a prop or a ledge) so that the
   * feet end at `to`.
   */
  | { do: "climb"; to: Vec3 }
  /** Go to a wall button within reach and press it with the use key. */
  | { do: "press"; button: string }
  /**
   * Pick up a prop and set it down so that it rests at `to`. `from` is
   * where to stand when letting go (default: worked out from where the step
   * begins) and `holdY` the height to release it at.
   */
  | { do: "carry"; prop: number; to: Vec3; from?: Vec3; holdY?: number }
  /** Push a prop that is too heavy to carry until it rests near `to`. */
  | { do: "push"; prop: number; to: Vec3 }
  /**
   * Pick up a prop and throw it so that it hits the point `at`, standing
   * at `from` (default: where the step begins).
   */
  | { do: "throw"; prop: number; at: Vec3; from?: Vec3 }
  /**
   * Wait at most `seconds` for a world event of this type, counting any that
   * happened since the previous step began. Without `for`, simply wait.
   */
  | { do: "wait"; for?: WorldEvent["type"]; seconds: number };

export type LightFlicker = "none" | "fluorescent" | "broken";

export interface LightDef {
  position: Vec3;
  color: Color;
  radius: number;
  intensity: number;
  /** Steady lights are baked into level vertex colours; others are dynamic. */
  flicker: LightFlicker;
  /**
   * Optional box the light is confined to. Dynamic lights have no shadows,
   * so without this a light shines through walls and floors into
   * neighbouring spaces.
   */
  bounds?: Aabb;
}

export const PROP_KINDS = [
  "crate_wood",
  "crate_wood_small",
  "crate_weak",
  "crate_metal",
  "barrel",
  "chair",
  "monitor",
] as const;

export type PropKind = (typeof PROP_KINDS)[number];

export interface PropSpawn {
  kind: PropKind;
  /** Centre of the prop. */
  position: Vec3;
  /** Rotation about +Y in radians. */
  yaw: number;
}

/** A sliding door. Something else (a button or plate) opens it by id. */
export interface DoorDef {
  id: string;
  /** The door slab when closed. */
  closed: Aabb;
  /** How far the slab moves when fully open. */
  openOffset: Vec3;
  material: MaterialId;
}

/** A wall button the player presses with the use key. */
export interface ButtonDef {
  id: string;
  /** Centre of the button face. */
  position: Vec3;
  /** Unit vector pointing out of the wall. */
  facing: Vec3;
  /** Id of the door it toggles. */
  target: string;
  /**
   * How the button works. Default "toggle".
   * - "toggle": the use key opens the door, or closes it if open.
   * - "timed": the use key opens the door for `seconds`, then it closes.
   * - "impact": the use key does nothing; hitting the button with a thrown
   *   or pushed prop opens the door for good.
   */
  mode?: "toggle" | "timed" | "impact";
  /** For "timed" buttons: how long the door stays open. */
  seconds?: number;
}

/** A floor plate that holds a door open while enough mass rests on it. */
export interface PressurePlateDef {
  id: string;
  /** The plate slab. */
  box: Aabb;
  /** Kilograms needed to trigger it. */
  requiredMass: number;
  /** Id of the door it holds open. */
  target: string;
}

export interface SoundEmitterDef {
  sound: SoundId;
  position: Vec3;
  gain: number;
}

/** Static world geometry: an axis-aligned box. */
export interface Brush {
  min: Vec3;
  max: Vec3;
  material: MaterialId;
  /** Per-face overrides, keyed by BoxFace ("px", "ny", ...). */
  faces?: Partial<Record<"px" | "nx" | "py" | "ny" | "pz" | "nz", MaterialId>>;
}

export interface LevelData {
  name: string;
  brushes: Brush[];
  lights: LightDef[];
  /** Feet position and facing of the player at start. */
  playerSpawn: { position: Vec3; yaw: number };
  props: PropSpawn[];
  doors: DoorDef[];
  buttons: ButtonDef[];
  plates: PressurePlateDef[];
  emitters: SoundEmitterDef[];
  ambient: Color;
  fog: Fog;
  /** Standing inside this box completes the demo. */
  exit: Aabb;
  /** Reverberation by area; outside every zone the game uses "corridor". */
  zones: AcousticZone[];
  /** The seed this level was generated from, or null if hand-built. */
  seed: number | null;
  /** A known way to reach the exit, for automated play. May be empty. */
  solution: SolutionStep[];
}

export interface AcousticZone {
  box: Aabb;
  room: RoomAcoustics;
}

export interface BuiltLevel {
  data: LevelData;
  /** Level geometry, one mesh per material, with baked vertex colours. */
  meshes: MeshData[];
  /** One box per brush, for physics. */
  colliders: Aabb[];
}

// ---------------------------------------------------------------------------
// Player: src/player/index.ts
//   export function createPlayer(options: PlayerOptions): Player
// ---------------------------------------------------------------------------

/** Player intent for one fixed step, sampled from Input by the game. */
export interface PlayerInput {
  /** Strafe, -1 (left) to 1 (right). */
  moveX: number;
  /** Forward, -1 (back) to 1 (forward). */
  moveZ: number;
  /** Mouse movement in pixels since the previous step. */
  lookDx: number;
  lookDy: number;
  /** Held. */
  jump: boolean;
  /** Held. */
  crouch: boolean;
  /** Pressed this step: pick up, drop, or use what is looked at. */
  usePressed: boolean;
  /** Pressed this step: throw the held prop, or shove what is looked at. */
  primaryPressed: boolean;
}

export interface PlayerOptions {
  physics: PhysicsWorld;
  /** Feet position and facing at start. */
  spawn: { position: Vec3; yaw: number };
}

export type PlayerEvent =
  | { type: "footstep"; on: ColliderRef | null }
  | { type: "jump" }
  | { type: "land"; speed: number; on: ColliderRef | null }
  | { type: "pickup"; body: number }
  | { type: "drop"; body: number }
  | { type: "throw"; body: number }
  /** The use key was pressed with nothing to pick up; `hit` is what was aimed at. */
  | { type: "use"; hit: RayHit | null };

export interface Player {
  /** Position of the feet (bottom centre of the collision box). */
  readonly feet: Vec3;
  readonly velocity: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly onGround: boolean;
  readonly crouched: boolean;
  readonly standingOn: ColliderRef | null;
  /** Body currently carried, or null. */
  readonly heldBody: number | null;
  /** What the crosshair is on within reach, or null. */
  readonly aim: RayHit | null;
  /** Current collision box. */
  box(): Aabb;
  /** Advances one fixed step. Call before `physics.step`. */
  update(dt: number, input: PlayerInput): PlayerEvent[];
  /** Eye camera, interpolated between the last two steps by `alpha` (0..1). */
  camera(alpha: number): Camera;
  /** Lets go of the held body without throwing, e.g. because it was destroyed. */
  releaseHeld(): void;
}

// ---------------------------------------------------------------------------
// World objects (props, doors, buttons, plates): src/props/index.ts
//   export function createWorldObjects(options: WorldObjectsOptions): WorldObjects
// ---------------------------------------------------------------------------

export interface WorldObjectsOptions {
  level: LevelData;
  physics: PhysicsWorld;
  /** Used to register and free the meshes of props, doors, plates and buttons. */
  renderer: Pick<Renderer, "createMesh" | "destroyMesh">;
  /** Seed for debris and variation. */
  seed: number;
}

export type WorldEvent =
  | { type: "impact"; surface: SurfaceKind; position: Vec3; impulse: number }
  | { type: "break"; position: Vec3 }
  | { type: "button_press"; position: Vec3 }
  | { type: "button_deny"; position: Vec3 }
  | { type: "door_open"; position: Vec3 }
  | { type: "door_close"; position: Vec3 }
  | { type: "plate_down"; position: Vec3 }
  | { type: "plate_up"; position: Vec3 }
  /** A timed door is counting down; fires about once a second while open. */
  | { type: "timer_tick"; position: Vec3; remaining: number }
  /** A closing door met something it cannot push aside and reopened. */
  | { type: "door_blocked"; position: Vec3 }
  /** The exit door has been opened for the first time. */
  | { type: "objective" };

export interface WorldObjects {
  /**
   * Advances doors, plates, breakables and debris by one fixed step. Call
   * after `physics.step`, passing the contacts drained from it and the
   * player's box and mass (the player also weighs down plates).
   */
  update(
    dt: number,
    context: { contacts: ContactEvent[]; playerBox: Aabb; playerMass: number },
  ): WorldEvent[];
  /** Handles the use key on whatever was aimed at. True if something reacted. */
  use(hit: RayHit | null): WorldEvent[];
  /** A short label for what is aimed at ("Press button", "Pick up"), or null. */
  describe(hit: RayHit | null): string | null;
  /** True if the body exists and is light enough to be carried. */
  canCarry(body: number): boolean;
  /** Draw list for this frame, interpolated between the last two steps. */
  drawItems(alpha: number): DrawItem[];
}

// ---------------------------------------------------------------------------
// HUD: src/hud/index.ts
//   export function createHud(root: HTMLElement): Hud
// ---------------------------------------------------------------------------

export interface HudState {
  /** False while the pointer is not captured: show the click-to-play overlay. */
  playing: boolean;
  crosshair: "idle" | "interact" | "holding";
  /** Prompt shown under the crosshair, e.g. "E  Pick up". */
  prompt: string | null;
  /** Transient centre message, e.g. the objective; null to hide. */
  message: string | null;
}

export interface Hud {
  /** Cheap to call every frame; only touches the DOM when something changed. */
  update(state: HudState): void;
}
