import type {
  Aabb,
  ButtonDef,
  ContactEvent,
  DoorDef,
  DrawItem,
  MeshHandle,
  PhysicsWorld,
  PressurePlateDef,
  PropKind,
  RayHit,
  WorldEvent,
  WorldObjects,
  WorldObjectsOptions,
} from "../core/api";
import { MATERIALS } from "../core/materials";
import type { MeshData } from "../core/mesh";
import { PLAYER, PROP_SPECS } from "../core/props";
import { createRng, type Rng } from "../core/rng";
import { mat4, quat, v3, type Mat4, type Quat, type Vec3 } from "../math";
import {
  BREAK_IMPULSE,
  DEBRIS_FADE,
  DEBRIS_LIFETIME,
  spawnDebris,
} from "./breakables";
import { Door } from "./doors";
import {
  buildButtonMeshes,
  buildDoorMesh,
  buildPlankMesh,
  buildPlateMeshes,
  buildPropMeshes,
  PLANK_PRESETS,
  PROP_SURFACE_MATERIAL,
} from "./meshes";
import { Plate, plateLoad } from "./plates";
import { composeInto, rotationBetween } from "./pose";

/** Contacts weaker than this make no impact event (N·s). */
export const IMPACT_MIN_IMPULSE = 4;
/** At most this many impact events per step; the strongest are kept. */
export const MAX_IMPACTS_PER_STEP = 4;
/** Bodies below this height are gone for good. */
export const KILL_HEIGHT = -20;
/** How close a hit must be to a button's face to count as aiming at it. */
export const BUTTON_REACH = 0.3;

/** Updates at the start during which contacts are ignored (resting-contact noise). */
const SETTLE_UPDATES = 3;

const UP = v3.create(0, 1, 0);

interface PropPhysics {
  friction: number;
  restitution: number;
}

const PROP_PHYSICS: Readonly<Record<PropKind, PropPhysics>> = {
  crate_wood: { friction: 0.6, restitution: 0.1 },
  crate_wood_small: { friction: 0.6, restitution: 0.1 },
  crate_weak: { friction: 0.6, restitution: 0.1 },
  crate_metal: { friction: 0.5, restitution: 0.05 },
  barrel: { friction: 0.45, restitution: 0.15 },
  chair: { friction: 0.5, restitution: 0.2 },
  monitor: { friction: 0.5, restitution: 0.2 },
};

/** A physics body with a mesh: a prop or a piece of debris. */
interface Tracked {
  id: number;
  kind: PropKind | "debris";
  items: DrawItem[];
  matrix: Mat4;
  prevPos: Vec3;
  pos: Vec3;
  prevRot: Quat;
  rot: Quat;
  prevScale: number;
  scale: number;
  age: number;
  dead: boolean;
}

interface ButtonUnit {
  def: ButtonDef;
  door: Door | undefined;
  bezel: DrawItem;
  red: DrawItem;
  green: DrawItem;
}

interface PlateUnit {
  plate: Plate;
  matrix: Mat4;
  items: DrawItem[];
  base: Vec3;
}

interface DoorUnit {
  door: Door;
  item: DrawItem;
}

class WorldObjectsImpl implements WorldObjects {
  private readonly physics: PhysicsWorld;
  private readonly renderer: WorldObjectsOptions["renderer"];
  private readonly rng: Rng;

  private tracked: Tracked[] = [];
  private readonly byId = new Map<number, Tracked>();
  private readonly kindHandles = new Map<PropKind, MeshHandle[]>();
  private readonly kindLive = new Map<PropKind, number>();
  private plankHandles: MeshHandle[] | null = null;
  private debrisLive = 0;

  private readonly doors: DoorUnit[] = [];
  private readonly doorById = new Map<string, Door>();
  private readonly plates: PlateUnit[] = [];
  private readonly buttons: ButtonUnit[] = [];
  private objectiveDone = false;
  private updates = 0;

  private readonly out: DrawItem[] = [];

  constructor(options: WorldObjectsOptions) {
    this.physics = options.physics;
    this.renderer = options.renderer;
    this.rng = createRng(options.seed);
    const level = options.level;

    this.spawnProps(level.props);
    this.buildDoors(level.doors);
    this.buildPlates(level.plates);
    this.buildButtons(level.buttons);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private register(meshes: readonly MeshData[]): MeshHandle[] {
    return meshes.map((mesh) => this.renderer.createMesh(mesh));
  }

  private spawnProps(
    spawns: readonly { kind: PropKind; position: Vec3; yaw: number }[],
  ): void {
    for (const spawn of spawns) {
      const spec = PROP_SPECS[spawn.kind];
      const feel = PROP_PHYSICS[spawn.kind];
      const orientation = quat.fromAxisAngle(UP, spawn.yaw);
      const id = this.physics.addBody({
        position: v3.clone(spawn.position),
        orientation,
        halfExtents: v3.clone(spec.halfExtents),
        mass: spec.mass,
        friction: feel.friction,
        restitution: feel.restitution,
        tag: spawn.kind,
      });
      let handles = this.kindHandles.get(spawn.kind);
      if (!handles) {
        handles = this.register(buildPropMeshes(spawn.kind));
        this.kindHandles.set(spawn.kind, handles);
      }
      this.kindLive.set(spawn.kind, (this.kindLive.get(spawn.kind) ?? 0) + 1);
      this.track(id, spawn.kind, handles, spawn.position, orientation, 1);
    }
  }

  private track(
    id: number,
    kind: PropKind | "debris",
    handles: readonly MeshHandle[],
    position: Vec3,
    orientation: Quat,
    scale: number,
  ): Tracked {
    const matrix = mat4.identity();
    const t: Tracked = {
      id,
      kind,
      items: handles.map((mesh) => ({ mesh, transform: matrix })),
      matrix,
      prevPos: v3.clone(position),
      pos: v3.clone(position),
      prevRot: quat.clone(orientation),
      rot: quat.clone(orientation),
      prevScale: scale,
      scale,
      age: 0,
      dead: false,
    };
    this.tracked.push(t);
    this.byId.set(id, t);
    return t;
  }

  private buildDoors(defs: readonly DoorDef[]): void {
    for (const def of defs) {
      const door = new Door(def, this.physics);
      const [handle] = this.register([buildDoorMesh(def)]);
      this.doors.push({
        door,
        item: { mesh: handle, transform: mat4.identity() },
      });
      this.doorById.set(def.id, door);
    }
  }

  private buildPlates(defs: readonly PressurePlateDef[]): void {
    for (const def of defs) {
      const colliderId = this.physics.addStatic({
        min: v3.clone(def.box.min),
        max: v3.clone(def.box.max),
      });
      const plate = new Plate(def, colliderId);
      const matrix = mat4.identity();
      const handles = this.register(
        buildPlateMeshes(v3.sub(def.box.max, def.box.min)),
      );
      this.plates.push({
        plate,
        matrix,
        items: handles.map((mesh) => ({ mesh, transform: matrix })),
        base: plate.center,
      });
      this.doorById.get(def.target)?.plateIds.push(def.id);
    }
  }

  private buildButtons(defs: readonly ButtonDef[]): void {
    if (defs.length === 0) {
      return;
    }
    const meshes = buildButtonMeshes();
    const [bezel, red, green] = this.register([
      meshes.bezel,
      meshes.red,
      meshes.green,
    ]);
    for (const def of defs) {
      const facing = v3.normalize(def.facing);
      const matrix = composeInto(
        mat4.identity(),
        def.position.x,
        def.position.y,
        def.position.z,
        rotationBetween({ x: 0, y: 0, z: 1 }, facing),
        1,
      );
      this.buttons.push({
        def,
        door: this.doorById.get(def.target),
        bezel: { mesh: bezel, transform: matrix },
        red: { mesh: red, transform: matrix },
        green: { mesh: green, transform: matrix },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(
    dt: number,
    context: { contacts: ContactEvent[]; playerBox: Aabb; playerMass: number },
  ): WorldEvent[] {
    const events: WorldEvent[] = [];
    this.syncBodies(dt);
    // Props start in contact with what they rest on; the first steps report
    // that settling as impacts, so contacts are ignored until it is over.
    if (this.updates++ >= SETTLE_UPDATES) {
      this.processContacts(context.contacts, events);
    }
    this.updatePlates(dt, context.playerBox, context.playerMass, events);
    this.updateDoors(dt, events);
    this.compact();
    return events;
  }

  /** Copies body poses, ages debris and removes what fell out of the world. */
  private syncBodies(dt: number): void {
    for (const t of this.tracked) {
      if (t.dead) {
        continue;
      }
      const state = this.physics.getBody(t.id);
      if (!state) {
        this.kill(t, false);
        continue;
      }
      if (state.position.y < KILL_HEIGHT) {
        this.kill(t, true);
        continue;
      }
      t.prevPos.x = t.pos.x;
      t.prevPos.y = t.pos.y;
      t.prevPos.z = t.pos.z;
      t.prevRot.x = t.rot.x;
      t.prevRot.y = t.rot.y;
      t.prevRot.z = t.rot.z;
      t.prevRot.w = t.rot.w;
      t.pos.x = state.position.x;
      t.pos.y = state.position.y;
      t.pos.z = state.position.z;
      t.rot.x = state.orientation.x;
      t.rot.y = state.orientation.y;
      t.rot.z = state.orientation.z;
      t.rot.w = state.orientation.w;
      if (t.kind === "debris") {
        t.age += dt;
        t.prevScale = t.scale;
        t.scale = Math.max(
          0,
          Math.min(1, (DEBRIS_LIFETIME - t.age) / DEBRIS_FADE),
        );
        if (t.age >= DEBRIS_LIFETIME) {
          this.kill(t, true);
        }
      }
    }
  }

  private kill(t: Tracked, removeBody: boolean): void {
    if (t.dead) {
      return;
    }
    t.dead = true;
    this.byId.delete(t.id);
    if (removeBody) {
      this.physics.removeBody(t.id);
    }
    if (t.kind === "debris") {
      this.debrisLive--;
    } else {
      this.kindLive.set(t.kind, (this.kindLive.get(t.kind) ?? 1) - 1);
    }
  }

  /** Drops dead entries and frees meshes nothing can draw any more. */
  private compact(): void {
    if (this.tracked.some((t) => t.dead)) {
      this.tracked = this.tracked.filter((t) => !t.dead);
    }
    for (const [kind, handles] of this.kindHandles) {
      if ((this.kindLive.get(kind) ?? 0) <= 0) {
        for (const handle of handles) {
          this.renderer.destroyMesh(handle);
        }
        this.kindHandles.delete(kind);
      }
    }
    if (
      this.plankHandles &&
      this.debrisLive <= 0 &&
      (this.kindLive.get("crate_weak") ?? 0) <= 0
    ) {
      for (const handle of this.plankHandles) {
        this.renderer.destroyMesh(handle);
      }
      this.plankHandles = null;
    }
  }

  private processContacts(
    contacts: ContactEvent[],
    events: WorldEvent[],
  ): void {
    const impacts: { impulse: number; event: WorldEvent }[] = [];
    const breaking = new Set<Tracked>();
    for (const contact of contacts) {
      if (contact.impulse < IMPACT_MIN_IMPULSE) {
        continue;
      }
      const a =
        contact.a.kind === "body" ? this.byId.get(contact.a.id) : undefined;
      const b =
        contact.b.kind === "body" ? this.byId.get(contact.b.id) : undefined;
      if (!a && !b) {
        continue;
      }
      let broke = false;
      if (contact.impulse > BREAK_IMPULSE) {
        for (const t of [a, b]) {
          if (t && t.kind === "crate_weak") {
            breaking.add(t);
            broke = true;
          }
        }
      }
      if (broke) {
        continue;
      }
      const source =
        a && a.kind !== "debris" ? a : b && b.kind !== "debris" ? b : (a ?? b);
      if (!source) {
        continue;
      }
      const material =
        source.kind === "debris"
          ? "crate_wood_weak"
          : PROP_SURFACE_MATERIAL[source.kind];
      impacts.push({
        impulse: contact.impulse,
        event: {
          type: "impact",
          surface: MATERIALS[material].surface,
          position: v3.clone(contact.point),
          impulse: contact.impulse,
        },
      });
    }
    impacts.sort((p, q) => q.impulse - p.impulse);
    for (const impact of impacts.slice(0, MAX_IMPACTS_PER_STEP)) {
      events.push(impact.event);
    }
    for (const t of breaking) {
      this.breakCrate(t, events);
    }
  }

  private breakCrate(t: Tracked, events: WorldEvent[]): void {
    const state = this.physics.getBody(t.id);
    if (!state || t.dead) {
      return;
    }
    this.kill(t, true);
    events.push({ type: "break", position: v3.clone(state.position) });
    if (!this.plankHandles) {
      this.plankHandles = this.register(PLANK_PRESETS.map(buildPlankMesh));
    }
    for (const piece of spawnDebris(this.physics, this.rng, state)) {
      this.debrisLive++;
      this.track(
        piece.bodyId,
        "debris",
        [this.plankHandles[piece.preset]],
        piece.position,
        piece.orientation,
        1,
      );
    }
  }

  private updatePlates(
    dt: number,
    playerBox: Aabb,
    playerMass: number,
    events: WorldEvent[],
  ): void {
    if (this.plates.length === 0) {
      return;
    }
    const bodies = this.physics.bodies();
    for (const unit of this.plates) {
      const { plate } = unit;
      const load = plateLoad(plate.def.box, bodies, playerBox, playerMass);
      const change = plate.update(dt, load);
      if (change !== 0) {
        events.push({
          type: change > 0 ? "plate_down" : "plate_up",
          position: v3.create(
            plate.center.x,
            plate.def.box.max.y,
            plate.center.z,
          ),
        });
      }
    }
  }

  private updateDoors(dt: number, events: WorldEvent[]): void {
    for (const { door } of this.doors) {
      let wanted = door.manual;
      if (door.plateIds.length > 0) {
        wanted = this.plates.some(
          (u) => door.plateIds.includes(u.plate.def.id) && u.plate.pressed,
        );
      }
      if (wanted !== door.open) {
        door.retarget(wanted);
        events.push({
          type: wanted ? "door_open" : "door_close",
          position: door.centerAt(door.travel),
        });
      }
      door.step(dt);
      if (door.plateIds.length > 0 && !this.objectiveDone && door.fullyOpen) {
        this.objectiveDone = true;
        events.push({ type: "objective" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  private buttonAt(hit: RayHit | null): ButtonUnit | null {
    if (!hit) {
      return null;
    }
    let best: ButtonUnit | null = null;
    let bestDistance = BUTTON_REACH;
    for (const unit of this.buttons) {
      const distance = v3.distance(hit.point, unit.def.position);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = unit;
      }
    }
    return best;
  }

  use(hit: RayHit | null): WorldEvent[] {
    const unit = this.buttonAt(hit);
    if (!unit || !unit.door) {
      return [];
    }
    const position = v3.clone(unit.def.position);
    if (unit.door.plateIds.length > 0) {
      return [{ type: "button_deny", position }];
    }
    unit.door.manual = !unit.door.manual;
    return [{ type: "button_press", position }];
  }

  describe(hit: RayHit | null): string | null {
    if (!hit) {
      return null;
    }
    if (this.buttonAt(hit)) {
      return "Press button";
    }
    if (hit.collider.kind === "body") {
      const body = this.physics.getBody(hit.collider.id);
      if (body) {
        return body.mass <= PLAYER.maxCarryMass ? "Pick up" : "Too heavy";
      }
    }
    return null;
  }

  canCarry(body: number): boolean {
    const state = this.physics.getBody(body);
    return state !== undefined && state.mass <= PLAYER.maxCarryMass;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  drawItems(alpha: number): DrawItem[] {
    const out = this.out;
    out.length = 0;
    const a = Math.max(0, Math.min(1, alpha));

    for (const t of this.tracked) {
      const x = t.prevPos.x + (t.pos.x - t.prevPos.x) * a;
      const y = t.prevPos.y + (t.pos.y - t.prevPos.y) * a;
      const z = t.prevPos.z + (t.pos.z - t.prevPos.z) * a;
      const rot =
        a <= 0 ? t.prevRot : a >= 1 ? t.rot : quat.slerp(t.prevRot, t.rot, a);
      const scale = t.prevScale + (t.scale - t.prevScale) * a;
      composeInto(t.matrix, x, y, z, rot, scale);
      for (const item of t.items) {
        out.push(item);
      }
    }

    for (const { door, item } of this.doors) {
      const travel = door.prevTravel + (door.travel - door.prevTravel) * a;
      const c = door.centerAt(travel);
      composeInto(item.transform, c.x, c.y, c.z, IDENTITY, 1);
      out.push(item);
    }

    for (const unit of this.plates) {
      const sink =
        unit.plate.prevSink + (unit.plate.sink - unit.plate.prevSink) * a;
      composeInto(
        unit.matrix,
        unit.base.x,
        unit.base.y - sink,
        unit.base.z,
        IDENTITY,
        1,
      );
      for (const item of unit.items) {
        out.push(item);
      }
    }

    for (const unit of this.buttons) {
      out.push(unit.bezel);
      out.push(unit.door?.open ? unit.green : unit.red);
    }
    return out;
  }
}

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function createWorldObjects(options: WorldObjectsOptions): WorldObjects {
  return new WorldObjectsImpl(options);
}
